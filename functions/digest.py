"""YD Job Hub -- the daily summaries.

Three a day, so nobody has to keep opening the app to find out what is going
on: early morning (the day ahead), midday (the rest of the day and the weather
turning), and end of day (what got done, and tomorrow). Each goes to every
person who has them switched on, by email, by phone notification, or both.

THE OWNER AND THE CREW GET DIFFERENT SUMMARIES, built separately rather than
one summary with parts hidden. The owner's carries bids, prices' worth of
context and personal events; a crew member's carries only the weather, their
own assignments and storm news. Building them apart means a crew summary can
never contain something it should not, whatever is later added to the
owner's.

NOTHING HERE IS STORED. Every summary is worked out fresh from the same
records the app reads -- calendars, storms, jobs, time entries -- so it cannot
disagree with what the app shows. Repeating and multi-day events are expanded
with the same rules as calendar.js.

DATES ARE CENTRAL TIME. "Today" is Madison's today, worked out from the
time zone, not from UTC -- the server runs in UTC, and a 5 am summary built
on UTC dates would describe the wrong day.

Sending:
  email   Gmail, sent AS the owner from his own Workspace account, through
          domain-wide delegation on this service's own identity. No password,
          key or token is stored anywhere for it.
  phone   Web Push, signed with a VAPID key that lives in Secret Manager.
"""

import base64
import datetime
import json
import os
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from html import escape
from zoneinfo import ZoneInfo

import requests
from firebase_admin import firestore

TZ = ZoneInfo("America/Chicago")
OWNER_EMAIL = "jonahlinfield@ydexteriorvisions.com"   # also the account mail is sent from
HOME = {"lat": 43.0731, "lng": -89.4012, "name": "Madison"}
UA = "YD Job Hub (jonahlinfield@ydexteriorvisions.com)"   # weather.gov asks for one

SLOTS = {
    "morning": {"label": "Morning", "icon": "☀️"},
    "midday": {"label": "Midday", "icon": "🕛"},
    "evening": {"label": "End of day", "icon": "🌙"},
}

# Bids sitting this long without moving are worth a call.
CHASE_AFTER_DAYS = {"toSend": 2, "sent": 5, "followUp": 0}
BID_STAGE_NAME = {"siteVisit": "Site visit", "toSend": "Bid to send", "sent": "Sent — waiting",
                  "followUp": "Follow up"}


def _db():
    return firestore.client()


def _app_url():
    return os.environ.get("QB_APP_URL", "https://jonahlinfieldydexteriorvisionsllc.github.io/yd-job-hub/")


# ---------------------------------------------------------------- dates


def _now():
    return datetime.datetime.now(TZ)


def _day(d):
    return d.strftime("%Y-%m-%d")


def _parse_day(s):
    return datetime.date.fromisoformat(s)


def _add_months(day, n):
    y, m = day.year, day.month - 1 + n
    y += m // 12
    m = m % 12 + 1
    import calendar as _cal
    last = _cal.monthrange(y, m)[1]
    return datetime.date(y, m, min(day.day, last))


def _dates_of(ev, start, end):
    """The days an event lands on between start and end (dates, inclusive).
    Same rules as datesOf() in calendar.js: multi-day events land on each of
    their days, repeating ones on each repeat; monthly and yearly repeats are
    counted from the original date so the 31st does not drift to the 28th."""
    if not ev.get("date"):
        return []
    first = _parse_day(ev["date"])
    span = 0
    if ev.get("endDate") and ev["endDate"] > ev["date"]:
        span = (_parse_day(ev["endDate"]) - first).days
    rep = ev.get("repeat") or "none"
    until = _parse_day(ev["repeatUntil"]) if ev.get("repeatUntil") else end
    starts = []
    if rep == "none":
        starts.append(first)
    else:
        step = {"weekly": 7, "biweekly": 14}.get(rep, 0)
        months = {"monthly": 1, "yearly": 12}.get(rep, 0)
        k, d = 0, first
        if step and d < start:
            jumps = (start - d).days // step - 1
            if jumps > 0:
                k = jumps
                d = first + datetime.timedelta(days=k * step)
        guard = 0
        while d <= end and d <= until and guard < 1000:
            starts.append(d)
            k += 1
            guard += 1
            if step:
                d = first + datetime.timedelta(days=k * step)
            elif months:
                d = _add_months(first, k * months)
            else:
                break
    out = []
    for s in starts:
        for i in range(span + 1):
            day = s + datetime.timedelta(days=i)
            if start <= day <= end:
                out.append(day)
    return out


def _fmt_time(t):
    """'07:30' -> '7:30am'."""
    if not t:
        return ""
    try:
        h, m = [int(x) for x in t.split(":")[:2]]
    except ValueError:
        return t
    ap = "pm" if h >= 12 else "am"
    h12 = h % 12 or 12
    return "%d%s%s" % (h12, (":%02d" % m) if m else "", ap)


def _fmt_dur(minutes):
    h, m = divmod(int(round(minutes)), 60)
    return ("%dh %02dm" % (h, m)) if h else ("%dm" % m)


def _long_day(d):
    return d.strftime("%A, %B ") + str(d.day)


# ---------------------------------------------------------------- weather

WMO = {
    0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Cloudy", 45: "Fog", 48: "Freezing fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Rain showers",
    81: "Rain showers", 82: "Heavy rain showers", 85: "Snow showers", 86: "Heavy snow showers",
    95: "Thunderstorms", 96: "Thunderstorms with hail", 99: "Thunderstorms with hail",
}


def weather():
    """Today and tomorrow, the next 48 hours of snow, and any active alerts.
    Open-Meteo for the numbers (one call, no key), weather.gov for official
    alerts. Returns None for a part that could not be fetched rather than
    inventing a forecast -- a summary that says "weather unavailable" is
    honest; one with a guessed high is not."""
    out = {"days": None, "snow48": None, "snowHours": [], "alerts": [], "now": None}
    try:
        r = requests.get("https://api.open-meteo.com/v1/forecast", timeout=15, params={
            "latitude": HOME["lat"], "longitude": HOME["lng"], "timezone": "America/Chicago",
            "temperature_unit": "fahrenheit", "wind_speed_unit": "mph", "precipitation_unit": "inch",
            "forecast_days": 3,
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,"
                     "precipitation_sum,snowfall_sum,wind_speed_10m_max,wind_gusts_10m_max",
            "hourly": "snowfall,temperature_2m",
            "current": "temperature_2m,weather_code,wind_speed_10m",
        })
        j = r.json()
        d = j["daily"]
        out["days"] = [{
            "date": d["time"][i], "code": d["weather_code"][i],
            "hi": d["temperature_2m_max"][i], "lo": d["temperature_2m_min"][i],
            "pop": d["precipitation_probability_max"][i], "precip": d["precipitation_sum"][i],
            # Open-Meteo gives snowfall in cm even when precipitation is in
            # inches; convert so "2 inches" means 2 inches.
            "snow": round((d["snowfall_sum"][i] or 0) / 2.54, 1),
            "wind": d["wind_speed_10m_max"][i], "gust": d["wind_gusts_10m_max"][i],
        } for i in range(len(d["time"]))]
        # A day with no high or low is dropped, as if it had not arrived, and
        # reads "forecast unavailable". Kept, the summary's round(None) failed
        # for every person at once.
        out["days"] = [x for x in out["days"] if x["hi"] is not None and x["lo"] is not None]
        c = j.get("current") or {}
        out["now"] = {"temp": c.get("temperature_2m"), "code": c.get("weather_code"), "wind": c.get("wind_speed_10m")}
        # Snow over the next 48 hours, and when it falls.
        now = _now().replace(minute=0, second=0, microsecond=0)
        horizon = now + datetime.timedelta(hours=48)
        h = j["hourly"]
        total = 0.0
        for t, sn in zip(h["time"], h["snowfall"]):
            ts = datetime.datetime.fromisoformat(t).replace(tzinfo=TZ)
            if now <= ts <= horizon and sn:
                total += sn / 2.54
                out["snowHours"].append(ts)
        out["snow48"] = round(total, 1)
    except Exception as e:      # noqa: BLE001
        print("digest: open-meteo failed:", e)
    try:
        r = requests.get("https://api.weather.gov/alerts/active", timeout=15,
                         params={"point": "%.4f,%.4f" % (HOME["lat"], HOME["lng"])},
                         headers={"User-Agent": UA, "Accept": "application/geo+json"})
        for f in (r.json().get("features") or [])[:4]:
            p = f.get("properties") or {}
            if p.get("event"):
                out["alerts"].append(p.get("headline") or p["event"])
    except Exception as e:      # noqa: BLE001
        print("digest: weather.gov alerts failed:", e)
    return out


def _day_words(w):
    if not w:
        return "Forecast unavailable"
    bits = ["%s, high %d° / low %d°" % (WMO.get(w["code"], "—"), round(w["hi"]), round(w["lo"]))]
    if w["pop"]:
        bits.append("%d%% chance of rain or snow" % w["pop"])
    if w["snow"] and w["snow"] >= 0.1:
        bits.append("%.1f\" of snow" % w["snow"])
    if w["gust"] and w["gust"] >= 25:
        bits.append("gusts to %d mph" % round(w["gust"]))
    elif w["wind"]:
        bits.append("wind up to %d mph" % round(w["wind"]))
    return ", ".join(bits)


def _snow_words(wx):
    if wx.get("snow48") is None:
        return None
    if wx["snow48"] < 0.1:
        return "No snow in the next 48 hours."
    hrs = wx["snowHours"]
    when = ""
    if hrs:
        a, b = hrs[0], hrs[-1]
        when = " — starting around %s %s" % (a.strftime("%a"), _fmt_time(a.strftime("%H:%M")))
        if b.date() != a.date() or b.hour != a.hour:
            when += ", through %s %s" % (b.strftime("%a"), _fmt_time(b.strftime("%H:%M")))
    return "❄️ About %.1f\" of snow expected in the next 48 hours%s." % (wx["snow48"], when)


# ---------------------------------------------------------------- records


def _people():
    out = {}
    for s in _db().collection("users").stream():
        u = s.to_dict() or {}
        if u.get("active") is True and u.get("role") in ("owner", "admin", "crew"):
            u["uid"] = s.id
            out[s.id] = u
    return out


def _name(u):
    return (u or {}).get("name") or (u or {}).get("email") or "Someone"


def _calendar_items(start, end):
    """Every event occurrence between two dates, with its calendar."""
    db = _db()
    items = []
    for c in db.collection("calendars").stream():
        cal = c.to_dict() or {}
        cal["id"] = c.id
        for e in db.collection("calendars").document(c.id).collection("events").stream():
            ev = e.to_dict() or {}
            # One event with a date that will not parse is left out and
            # logged. Unguarded, it stopped the whole run: nobody got a summary.
            try:
                days = _dates_of(ev, start, end)
            except (TypeError, ValueError) as err:
                print("digest: skipped event", c.id, e.id, "-", err)
                continue
            for day in days:
                items.append({"day": day, "cal": cal, "ev": ev})
    items.sort(key=lambda x: (x["day"], 1 if (x["ev"].get("time") and not x["ev"].get("allDay")) else 0,
                              str(x["ev"].get("time") or "")))
    return items


def _storms():
    open_ = []
    for s in _db().collection("storms").where("status", "==", "open").stream():
        d = s.to_dict() or {}
        d["id"] = s.id
        open_.append(d)
    return open_


def _bids():
    """Bids that need chasing: quoting jobs whose stage has sat long enough."""
    now = datetime.datetime.now(datetime.timezone.utc)
    out = []
    for s in _db().collection("jobs").stream():
        j = s.to_dict() or {}
        if (j.get("jobStatus") or "quoting") != "quoting":
            continue
        # A lost bid stays 'quoting' (boards.js keeps it there in case the
        # customer rings back), so without this it fell through to "Bid to
        # send" below and was chased in every summary for ever. The Bids board
        # files it under Lost; this agrees with it.
        if j.get("bidStage") == "lost":
            continue
        stage = j.get("bidStage") if j.get("bidStage") in BID_STAGE_NAME else "toSend"
        if stage == "siteVisit":
            continue
        since = j.get("bidStageAt") or j.get("lastModified")
        try:
            days = (now - datetime.datetime.fromisoformat(since.replace("Z", "+00:00"))).days
        except Exception:       # noqa: BLE001
            days = 0
        if days < CHASE_AFTER_DAYS.get(stage, 3):
            continue
        try:
            price = float(str(j.get("jobPrice") or "0").replace("$", "").replace(",", "") or 0)
        except ValueError:
            price = 0
        out.append({"name": (j.get("customerName") or "Untitled").strip(), "stage": stage, "days": days,
                    "price": price})
    out.sort(key=lambda b: (-b["days"]))
    return out


def _shifts():
    """Yesterday's and today's shifts, and any still running however old:
    who worked where and for how long (paid minutes).

    Each is filed under the day it STARTED, as the work log files it. That is
    why yesterday's are fetched: a storm shift begins after the evening
    summary has gone out -- most snow work does -- and is filed under that
    day, so asked for "today" only it appeared in no summary at all. The
    morning summary reports yesterday's once they are finished. Running ones
    are fetched whatever their age, because a shift still open from two days
    ago is a forgotten clock-out, which is exactly what the owner should see."""
    now = _now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    yday_start = today_start - datetime.timedelta(days=1)
    today_ms = int(today_start.timestamp() * 1000)
    yday_ms = int(yday_start.timestamp() * 1000)
    now_ms = int(now.timestamp() * 1000)
    entries = {}
    for q in (_db().collection("timeEntries").where("startedMs", ">=", yday_ms),
              _db().collection("timeEntries").where("status", "==", "running")):
        for s in q.stream():
            entries[s.id] = s.to_dict() or {}
    out = []
    for e in entries.values():
        started = e.get("startedMs")
        if e.get("status") == "rejected" or not isinstance(started, (int, float)):
            continue
        end = e.get("endedMs") or now_ms
        mins = max(0, (end - started) / 60000)
        out.append({"uid": e.get("uid"), "who": e.get("workerName") or "", "where": e.get("targetName") or
                    {"snow": "Snow", "labor": "Labor", "receipts": "Receipts"}.get(e.get("kind"), "Other"),
                    "mins": mins, "running": not e.get("endedMs"), "status": e.get("status"),
                    "day": "today" if started >= today_ms else "yesterday" if started >= yday_ms else "earlier"})
    return out


# ---------------------------------------------------------------- building

def _event_line(it, people, show_cal=True):
    ev = it["ev"]
    when = "All day" if (ev.get("allDay") or not ev.get("time")) else (
        _fmt_time(ev.get("time")) + (("–" + _fmt_time(ev.get("endTime"))) if ev.get("endTime") else ""))
    title = ev.get("title") or ev.get("jobName") or "Untitled"
    bits = [title]
    if ev.get("address"):
        bits.append(ev["address"])
    crew = [_name(people.get(c.get("uid"))) if people.get(c.get("uid")) else c.get("name", "")
            for c in (ev.get("crew") or [])]
    if crew:
        bits.append("crew: " + ", ".join(crew))
    return {"when": when, "text": " · ".join(bits), "cal": it["cal"].get("name", "") if show_cal else "",
            "color": it["cal"].get("color", "#6b7a8f"), "personal": it["cal"].get("kind") == "personal"}


def _hours_lines(shifts, who_of):
    """One line per person: their total, then where it went, biggest first."""
    by = {}
    for s in shifts:
        where = by.setdefault(who_of(s), {})
        where[s["where"]] = where.get(s["where"], 0) + s["mins"]
    lines = []
    for who in sorted(by):
        total = sum(by[who].values())
        lines.append({"text": "%s — %s: %s" % (who, _fmt_dur(total), ", ".join(
            "%s %s" % (w, _fmt_dur(m)) for w, m in sorted(by[who].items(), key=lambda x: -x[1])))})
    return lines


def build(slot, user, people, wx, cache):
    """One person's summary as {subject, sections, push} -- or None when there
    is genuinely nothing to say (a crew member with no assignments, no storm
    and calm weather does not need three notifications a day)."""
    owner = user.get("role") == "owner"
    uid = user["uid"]
    # An admin's summary is crew's plus the areas the owner gave them -- the
    # same access table the app and the rules use. Never the owner's own
    # (ownerOnly) calendars, whatever they were given.
    access = (user.get("access") or {}) if user.get("role") == "admin" else {}

    def sees(area):
        return owner or access.get(area) in ("see", "change")
    now = _now()
    today = now.date()
    tomorrow = today + datetime.timedelta(days=1)
    sections = []
    push_bits = []

    # ---- weather: always, and always the real thing.
    days = wx.get("days") or []
    wtoday = next((d for d in days if d["date"] == _day(today)), None)
    wtom = next((d for d in days if d["date"] == _day(tomorrow)), None)
    wlines = []
    if slot == "evening":
        if wtom:
            wlines.append("Tomorrow: " + _day_words(wtom) + ".")
        if wtoday:
            wlines.append("Tonight's low: %d°." % round(wtoday["lo"]))
    else:
        if slot == "midday" and wx.get("now") and wx["now"].get("temp") is not None:
            wlines.append("Now: %d°, %s." % (round(wx["now"]["temp"]), WMO.get(wx["now"].get("code"), "")))
        if wtoday:
            wlines.append("Today: " + _day_words(wtoday) + ".")
        if slot == "midday" and wtom:
            wlines.append("Tomorrow: " + _day_words(wtom) + ".")
    snow = _snow_words(wx)
    if snow:
        wlines.append(snow)
    for a in wx.get("alerts") or []:
        wlines.append("⚠️ " + a)
    if not wlines:
        wlines.append("The forecast could not be reached this time.")
    sections.append(("Weather", [{"text": l} for l in wlines]))
    if wtoday and slot != "evening":
        push_bits.append("%d°/%d°" % (round(wtoday["hi"]), round(wtoday["lo"])))
    elif wtom:
        push_bits.append("tomorrow %d°/%d°" % (round(wtom["hi"]), round(wtom["lo"])))
    if wx.get("snow48") and wx["snow48"] >= 0.5:
        push_bits.append('%.1f" snow coming' % wx["snow48"])

    # ---- storms
    storms = cache["storms"]
    if storms:
        sections.append(("Snow", [{"text": "A storm is open: %s (%s stops)." % (s.get("label") or s["id"],
                                                                             s.get("stopCount", "?"))}
                                  for s in storms]))
        push_bits.append("storm open")

    # ---- calendar
    def mine(it):
        if owner:
            return True
        # An admin given Calendars: every calendar the owner has not kept
        # private -- exactly what the app shows them.
        if sees("calendars") and it["cal"].get("ownerOnly") is False:
            return True
        # Crew: only calendars shared with them, and on the Work schedule
        # only the days they are actually on.
        if uid not in (it["cal"].get("visibleTo") or []):
            return False
        crew = it["ev"].get("crew") or []
        return not crew or any(c.get("uid") == uid for c in crew)

    items = [it for it in cache["items"] if mine(it)]
    def day_items(d):
        return [it for it in items if it["day"] == d]

    if slot == "morning":
        t = day_items(today)
        if t or owner:
            sections.append(("Today — " + _long_day(today),
                             [_event_line(it, people) for it in t] or [{"text": "Nothing on the calendar."}]))
        if t:
            push_bits.append("%d on today" % len(t))
            personal = [it for it in t if it["cal"].get("kind") == "personal"]
            if owner and personal:
                push_bits.append("personal: " + (personal[0]["ev"].get("title") or "event"))
        tm = day_items(tomorrow)
        if tm:
            sections.append(("Tomorrow", [_event_line(it, people) for it in tm[:6]] +
                             ([{"text": "…and %d more" % (len(tm) - 6)}] if len(tm) > 6 else [])))
    elif slot == "midday":
        hhmm = now.strftime("%H:%M")
        rest = [it for it in day_items(today)
                if not it["ev"].get("time") or it["ev"].get("allDay") or (it["ev"].get("endTime") or it["ev"]["time"]) >= hhmm]
        if rest:
            sections.append(("Rest of today", [_event_line(it, people) for it in rest]))
            push_bits.append("%d still on today" % len(rest))
    else:
        tm = day_items(tomorrow)
        if tm or owner:
            sections.append(("Tomorrow — " + _long_day(tomorrow),
                             [_event_line(it, people) for it in tm] or [{"text": "Nothing on the calendar."}]))
        if tm:
            push_bits.append("%d on tomorrow" % len(tm))

    # ---- hours
    # Each shift is filed under the day it started (see _shifts). The evening
    # reports today's so far; the morning reports yesterday's in full, which
    # is where a night's storm work lands once it is finished. Anything still
    # running is named whatever day it began.
    shifts = cache["shifts"]
    running = [s for s in shifts if s["running"]]

    def who_of(s):
        return str(_name(people.get(s["uid"])) if people.get(s["uid"]) else s["who"])

    hours_day = {"evening": "today", "morning": "yesterday"}.get(slot)
    if sees("hours"):
        if slot == "midday":
            if running:
                sections.append(("On the clock now", [{"text": "%s — %s (%s so far)" % (
                    who_of(s), s["where"], _fmt_dur(s["mins"]))} for s in running]))
        else:
            lines = _hours_lines([s for s in shifts if s["day"] == hours_day], who_of)
            if running:
                # Each name once: an old forgotten shift and tonight's would
                # otherwise list the same person twice.
                lines.append({"text": "Still clocked in: " + ", ".join(dict.fromkeys(who_of(s) for s in running))})
            if lines:
                sections.append(("Today's hours" if slot == "evening" else "Yesterday's hours", lines))
    elif hours_day:
        mine_s = [s for s in shifts if s["uid"] == uid and s["day"] == hours_day]
        if mine_s:
            sections.append(("Your hours today" if slot == "evening" else "Your hours yesterday",
                             [{"text": "%s — %s" % (s["where"], _fmt_dur(s["mins"])) +
                               (" (still clocked in)" if s["running"] else "")} for s in mine_s]))

    # ---- bids (the owner, and an admin given Jobs)
    if sees("jobs") and (slot in ("morning", "evening") or (slot == "midday" and cache["bids"])):
        bids = cache["bids"]
        if bids:
            sections.append(("Bids to chase", [{"text": "%s — %s, %d day%s%s" % (
                b["name"], BID_STAGE_NAME[b["stage"]], b["days"], "" if b["days"] == 1 else "s",
                (" · $%s" % format(int(round(b["price"])), ",")) if b["price"] else "")} for b in bids[:8]] +
                ([{"text": "…and %d more on the Bids board" % (len(bids) - 8)}] if len(bids) > 8 else [])))
            if slot != "midday":
                push_bits.append("%d bid%s to chase" % (len(bids), "" if len(bids) == 1 else "s"))

    # A crew member with nothing but weather does not need a midday ping.
    if not owner and slot == "midday" and len(sections) == 1 and not (wx.get("snow48") or 0) >= 0.5 \
            and not wx.get("alerts"):
        return None

    meta = SLOTS[slot]
    subject = "%s %s — %s" % (meta["icon"], meta["label"], now.strftime("%a %b ") + str(now.day))
    return {"subject": subject, "sections": sections,
            "push": {"title": "%s %s" % (meta["icon"], meta["label"]),
                     "body": " · ".join(push_bits) or "Your %s update" % meta["label"].lower()}}


# ---------------------------------------------------------------- rendering


def to_text(d):
    out = [d["subject"], ""]
    for title, lines in d["sections"]:
        out.append(title.upper())
        for l in lines:
            out.append("  " + ((l["when"] + "  ") if l.get("when") else "") + l["text"] +
                       ((" [" + l["cal"] + "]") if l.get("cal") else ""))
        out.append("")
    out.append("Open Job Hub: " + _app_url())
    return "\n".join(out)


def to_html(d):
    rows = []
    for title, lines in d["sections"]:
        rows.append('<h3 style="font:700 13px Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;'
                    'color:#66418f;margin:22px 0 8px">%s</h3>' % escape(title))
        for l in lines:
            dot = ('<span style="display:inline-block;width:9px;height:9px;border-radius:50%%;background:%s;'
                   'margin-right:7px"></span>' % escape(l["color"])) if l.get("color") else ""
            when = ('<b style="display:inline-block;min-width:78px;color:#2b2433">%s</b>' % escape(l["when"])) \
                if l.get("when") else ""
            cal = (' <span style="color:#7b7188;font-size:12px">· %s</span>' % escape(l["cal"])) if l.get("cal") else ""
            rows.append('<div style="font:14px/1.5 Arial,sans-serif;color:#2b2433;padding:5px 0;'
                        'border-bottom:1px solid #eee">%s%s%s%s</div>' % (dot, when, escape(l["text"]), cal))
    return ('<div style="max-width:560px;margin:0 auto;padding:18px">'
            '<div style="font:800 22px Georgia,serif;color:#66418f">YD Job Hub</div>'
            '<div style="font:700 15px Arial,sans-serif;color:#c9922f;margin-top:2px">%s</div>%s'
            '<p style="margin-top:26px"><a href="%s" style="background:#66418f;color:#fff;text-decoration:none;'
            'padding:11px 18px;border-radius:7px;font:700 13px Arial,sans-serif">Open Job Hub</a></p>'
            '<p style="font:11px Arial,sans-serif;color:#9a90a6">Change what you get from the ⋯ menu → '
            'Notifications &amp; summaries.</p></div>') % (escape(d["subject"]), "".join(rows), _app_url())


# ---------------------------------------------------------------- sending


def _service_account_email():
    r = requests.get("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email",
                     headers={"Metadata-Flavor": "Google"}, timeout=5)
    return r.text.strip()


_gmail_token = {"token": None, "exp": 0}


def _gmail_access_token():
    """An access token to send mail AS the owner, from this service's own
    identity via domain-wide delegation. The JWT is signed by Google's IAM
    service (signJwt) -- no private key exists anywhere to leak."""
    import time
    if _gmail_token["token"] and _gmail_token["exp"] > time.time() + 60:
        return _gmail_token["token"]
    import google.auth
    from google.auth import iam
    from google.auth.transport.requests import Request
    from google.oauth2 import service_account
    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    sa = _service_account_email()
    signer = iam.Signer(Request(), creds, sa)
    dwd = service_account.Credentials(signer, sa, "https://oauth2.googleapis.com/token",
                                      scopes=["https://www.googleapis.com/auth/gmail.send"],
                                      subject=OWNER_EMAIL)
    dwd.refresh(Request())
    _gmail_token["token"] = dwd.token
    _gmail_token["exp"] = dwd.expiry.timestamp() if dwd.expiry else time.time() + 3000
    return dwd.token


def send_email(to, d):
    msg = MIMEMultipart("alternative")
    msg["To"] = to
    msg["From"] = "YD Job Hub <%s>" % OWNER_EMAIL
    msg["Subject"] = d["subject"]
    msg.attach(MIMEText(to_text(d), "plain", "utf-8"))
    msg.attach(MIMEText(to_html(d), "html", "utf-8"))
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    r = requests.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
                      headers={"Authorization": "Bearer " + _gmail_access_token()},
                      json={"raw": raw}, timeout=30)
    if r.status_code >= 300:
        raise RuntimeError("Gmail said %d: %s" % (r.status_code, r.text[:300]))


def send_push(uid, d):
    """To every phone this person has switched notifications on for. A phone
    that has since said no (404/410) is forgotten."""
    from pywebpush import WebPushException, webpush
    key = os.environ.get("VAPID_PRIVATE")
    if not key:
        raise RuntimeError("phone notifications are not configured (no VAPID key)")
    db = _db()
    sent = 0
    payload = json.dumps({"title": d["push"]["title"], "body": d["push"]["body"][:180],
                          "url": _app_url() + "#calendar"})
    for s in db.collection("pushSubs").where("uid", "==", uid).stream():
        sub = (s.to_dict() or {}).get("sub")
        if not sub:
            continue
        try:
            webpush(subscription_info=sub, data=payload, vapid_private_key=key,
                    vapid_claims={"sub": "mailto:" + OWNER_EMAIL}, ttl=6 * 3600)
            sent += 1
        except WebPushException as e:
            code = getattr(e.response, "status_code", None)
            if code in (404, 410):
                s.reference.delete()
            else:
                print("digest: push failed for", uid, code, e)
    return sent


# ---------------------------------------------------------------- running

DEFAULT_PREFS = {
    "owner": {"email": True, "push": True, "morning": True, "midday": True, "evening": True},
    "crew": {"email": False, "push": True, "morning": True, "midday": True, "evening": True},
}


def _prefs(user):
    snap = _db().collection("digestPrefs").document(user["uid"]).get()
    p = dict(DEFAULT_PREFS["owner" if user.get("role") == "owner" else "crew"])
    if snap.exists:
        p.update({k: v for k, v in (snap.to_dict() or {}).items() if k in p})
    return p


def _cache():
    today = _now().date()
    return {
        "items": _calendar_items(today, today + datetime.timedelta(days=1)),
        "storms": _storms(),
        "bids": _bids(),
        "shifts": _shifts(),
    }


def run(slot, only_uid=None, dry=False):
    """Build and send `slot` for everyone with it switched on (or just one
    person). Returns what happened, per person, without the content."""
    if slot not in SLOTS:
        raise ValueError("unknown slot")
    people = _people()
    wx = weather()
    cache = _cache()
    report = []
    for uid, u in people.items():
        if only_uid and uid != only_uid:
            continue
        # Each person on their own. One odd record or setting used to raise
        # straight out of this loop, and everybody after that person got no
        # summary at all; now only that person's fails, and it is reported.
        try:
            p = _prefs(u)
            if not only_uid and not p.get(slot):
                continue
            d = build(slot, u, people, wx, cache)
            if not d:
                report.append({"uid": uid, "skipped": "nothing to say"})
                continue
            if dry:
                report.append({"uid": uid, "subject": d["subject"], "text": to_text(d), "html": to_html(d),
                               "push": d["push"]})
                continue
        except Exception as e:          # noqa: BLE001
            print("digest: could not build the summary for", uid, e)
            if only_uid:
                raise               # a preview shows the owner the real reason
            report.append({"uid": uid, "error": "could not build: %s" % e})
            continue
        r = {"uid": uid}
        if p.get("email") and u.get("email"):
            try:
                send_email(u["email"], d)
                r["email"] = "sent"
            except Exception as e:      # noqa: BLE001
                r["email"] = "failed: %s" % e
                print("digest: email failed for", uid, e)
        if p.get("push"):
            try:
                r["push"] = send_push(uid, d)
            except Exception as e:      # noqa: BLE001
                r["push"] = "failed: %s" % e
                print("digest: push failed for", uid, e)
        report.append(r)
    return report
