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

Every summary is worked out fresh from the same records the app reads --
calendars, storms, jobs, time entries -- so it cannot disagree with what the
app shows. Repeating and multi-day events are expanded with the same rules as
calendar.js. What was sent is kept for KEEP_DAYS in summaries/{uid}_{day}_{slot}
(readable only by that person), so it can be read in the app rather than in
email (Jonah, 9 Oct 2026); the phone notification opens it there.

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

import stages

TZ = ZoneInfo("America/Chicago")
OWNER_EMAIL = "jonahlinfield@ydexteriorvisions.com"   # also the account mail is sent from
HOME = {"lat": 43.0731, "lng": -89.4012, "name": "Madison"}
UA = "YD Job Hub (jonahlinfield@ydexteriorvisions.com)"   # weather.gov asks for one

SLOTS = {
    "morning": {"label": "Morning", "icon": "☀️"},
    "midday": {"label": "Midday", "icon": "🕛"},
    "evening": {"label": "End of day", "icon": "🌙"},
}

# THE CHASE RULE -- the same on the Bids board and Home (boards.js
# CHASE_AFTER_DAYS / WRITE_AFTER_DAYS / toChase), so the summary never names
# a bid the board does not, or the other way round:
#   - to chase: in "Sent — waiting" this many days or more, or moved to
#     Follow up (at once);
#   - to write: in "Bid to send" WRITE_AFTER_DAYS or more -- the bid itself
#     is late, there is nothing to chase yet;
#   - never: a bid accepted or turned down in QuickBooks (qb_accepted,
#     qb_turned_down) -- one is being booked, the other is asked "mark lost?".
# (They used to disagree: the summary chased "Bid to send" after 2 days as
# if it had been sent, the board did not list it at all.)
CHASE_AFTER_DAYS = {"sent": 5, "followUp": 0}
WRITE_AFTER_DAYS = 2
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


def _starts_of(ev, start, end):
    """The days each repeat of an event starts on, up to `end` (the jump
    ahead for long-running weekly repeats uses `start`). Same rules as
    startsOf() in calendar.js: monthly and yearly repeats are counted from the
    original date so the 31st does not drift to the 28th."""
    if not ev.get("date"):
        return []
    first = _parse_day(ev["date"])
    rep = ev.get("repeat") or "none"
    if rep == "none":
        return [first] if first <= end else []
    until = _parse_day(ev["repeatUntil"]) if ev.get("repeatUntil") else end
    starts = []
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
    return starts


def _span(ev):
    if ev.get("endDate") and ev.get("date") and ev["endDate"] > ev["date"]:
        return (_parse_day(ev["endDate"]) - _parse_day(ev["date"])).days
    return 0


def _expand(ev, start, end):
    """[(day, the day its repeat started)] for every day the event covers
    between start and end: multi-day events land on each of their days."""
    span = _span(ev)
    out = []
    for s in _starts_of(ev, start - datetime.timedelta(days=span), end):
        for i in range(span + 1):
            day = s + datetime.timedelta(days=i)
            if start <= day <= end:
                out.append((day, s))
    return out


def _dates_of(ev, start, end):
    """The days an event lands on between start and end (dates, inclusive)."""
    return [d for d, _ in _expand(ev, start, end)]


def _occurrences(ev, start, end):
    """[(day, the event as it is on that date)] between start and end.

    A repeating entry can have single dates changed or cancelled on their own
    (the calendar's "This date only"), kept on the entry as
    exceptions = {'YYYY-MM-DD' (the date the repeat fell on): 'cancelled' |
    {date, time, endTime, title, ...}}, null meaning none. calendar.js
    occurrencesOf() reads them the same way, so the summaries and reminders
    agree with the screen. Each date comes with its own `date`, so the first
    day of an occurrence is the one whose day equals it."""
    repeating = (ev.get("repeat") or "none") != "none"
    ex = (ev.get("exceptions") or {}) if repeating else {}
    span = _span(ev)
    copies = {}

    def at(s):
        if s not in copies:
            copies[s] = ev if s.isoformat() == ev.get("date") else dict(
                ev, date=s.isoformat(),
                endDate=(s + datetime.timedelta(days=span)).isoformat() if span else None)
        return copies[s]

    out = [(d, at(s)) for d, s in _expand(ev, start, end) if not ex.get(s.isoformat())]
    for k, x in ex.items():
        if not isinstance(x, dict):
            continue                    # cancelled, or cleared
        try:
            kd = _parse_day(k)
        except (TypeError, ValueError):
            continue
        if kd not in _starts_of(ev, kd, kd):
            continue                    # no longer a date the repeat falls on
        one = dict(ev)
        one.update(x)
        one["repeat"], one["exceptions"] = "none", None
        one["date"] = x.get("date") or k
        out.extend((d, one) for d in _dates_of(one, start, end))
    out.sort(key=lambda t: t[0])
    return out


REPEATS = ("weekly", "biweekly", "monthly", "yearly")     # the repeats _starts_of steps through


def events_near(cal_ref, first, last):
    """{entry id: entry} for one calendar's entries that can land between
    first and last (dates): dated in that window, repeating (from whenever),
    or running over several days into it. Three small queries rather than
    every entry the calendar ever had -- calendars only grow, and the
    reminders read them every five minutes (review, 12 Oct 2026).
    _occurrences still decides which days each one lands on."""
    ref = cal_ref.collection("events")
    out = {}
    for q in (ref.where("date", ">=", first.isoformat()).where("date", "<=", last.isoformat()),
              ref.where("repeat", "in", list(REPEATS)),
              ref.where("endDate", ">=", first.isoformat())):
        for s in q.stream():
            out[s.id] = s.to_dict() or {}
    # In id order, as reading the whole calendar gave them: entries at the
    # same time keep the order they always had.
    return dict(sorted(out.items()))


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


# ---------------------------------------------------------------- every town, every job site
#
# Jonah's ask: the weather for each city in Dane and Green County, and at the
# exact spot of each job being worked that day. Every city in both counties,
# and the bigger villages, in the order they are read down the email.
AREAS = [
    ("Dane", "Madison", 43.0731, -89.4012), ("Dane", "Middleton", 43.0972, -89.5043),
    ("Dane", "Fitchburg", 42.9608, -89.4698), ("Dane", "Verona", 42.9908, -89.5332),
    ("Dane", "Monona", 43.0622, -89.3340), ("Dane", "Sun Prairie", 43.1836, -89.2137),
    ("Dane", "Stoughton", 42.9167, -89.2179), ("Dane", "Waunakee", 43.1919, -89.4557),
    ("Dane", "DeForest", 43.2478, -89.3437), ("Dane", "McFarland", 43.0125, -89.2898),
    ("Dane", "Oregon", 42.9261, -89.3843), ("Dane", "Cottage Grove", 43.0761, -89.1993),
    ("Dane", "Mount Horeb", 43.0086, -89.7385),
    ("Green", "Monroe", 42.6011, -89.6385), ("Green", "Brodhead", 42.6183, -89.3762),
    ("Green", "New Glarus", 42.8144, -89.6354),
]
ZONES = {"Dane": "WIZ063", "Green": "WIZ068"}

WMO_ICON = {
    0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️", 45: "🌫️", 48: "🌫️", 51: "🌦️", 53: "🌦️", 55: "🌧️", 56: "🌧️", 57: "🌧️",
    61: "🌦️", 63: "🌧️", 65: "🌧️", 66: "🧊", 67: "🧊", 71: "🌨️", 73: "🌨️", 75: "❄️", 77: "🌨️",
    80: "🌦️", 81: "🌧️", 82: "⛈️", 85: "🌨️", 86: "❄️", 95: "⛈️", 96: "⛈️", 99: "⛈️",
}
WORK_HOURS = (7, 17)        # "during work hours" on a job site: 7 am to 5 pm


def forecast_points(points, days=3):
    """Daily forecasts -- and the work-hours rain -- for many places in ONE
    Open-Meteo call. `points` is a list of (lat, lng); the answer is a list in
    the same order of {date: {...}}, or None for a place that did not come
    back. Coordinates only: no address is ever sent to a weather service."""
    if not points:
        return []
    try:
        r = requests.get("https://api.open-meteo.com/v1/forecast", timeout=25, params={
            "latitude": ",".join("%.4f" % p[0] for p in points),
            "longitude": ",".join("%.4f" % p[1] for p in points),
            "timezone": "America/Chicago", "forecast_days": days,
            "temperature_unit": "fahrenheit", "wind_speed_unit": "mph", "precipitation_unit": "inch",
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,"
                     "precipitation_sum,snowfall_sum,wind_speed_10m_max,wind_gusts_10m_max",
            "hourly": "precipitation_probability,precipitation",
        })
        j = r.json()
    except Exception as e:      # noqa: BLE001
        print("digest: area forecast failed:", e)
        return [None] * len(points)
    if isinstance(j, dict):
        if j.get("error"):
            print("digest: area forecast refused:", j.get("reason"))
            return [None] * len(points)
        j = [j]                 # one place comes back as an object, not a list
    out = []
    for loc in j:
        d, h = loc.get("daily") or {}, loc.get("hourly") or {}
        days_out = {}
        for i, t in enumerate(d.get("time") or []):
            hi, lo = d["temperature_2m_max"][i], d["temperature_2m_min"][i]
            if hi is None or lo is None:
                continue
            days_out[t] = {
                "code": d["weather_code"][i], "hi": hi, "lo": lo,
                "pop": d["precipitation_probability_max"][i] or 0, "precip": d["precipitation_sum"][i] or 0,
                "snow": round((d["snowfall_sum"][i] or 0) / 2.54, 1),     # cm -> inches
                "wind": d["wind_speed_10m_max"][i] or 0, "gust": d["wind_gusts_10m_max"][i] or 0,
                "workPop": 0, "workRain": 0.0,
            }
        for t, pop, mm in zip(h.get("time") or [], h.get("precipitation_probability") or [],
                              h.get("precipitation") or []):
            day, hour = t[:10], int(t[11:13])
            if day in days_out and WORK_HOURS[0] <= hour < WORK_HOURS[1]:
                days_out[day]["workPop"] = max(days_out[day]["workPop"], pop or 0)
                days_out[day]["workRain"] += mm or 0
        out.append(days_out)
    while len(out) < len(points):
        out.append(None)
    return out


def county_alerts():
    """Active Weather Service warnings, watches and advisories, per county."""
    out = {}
    for county, zone in ZONES.items():
        try:
            r = requests.get("https://api.weather.gov/alerts/active/zone/" + zone, timeout=15,
                             headers={"User-Agent": UA, "Accept": "application/geo+json"})
            events = []
            for f in r.json().get("features") or []:
                ev = (f.get("properties") or {}).get("event")
                if ev and ev not in events:
                    events.append(ev)
            out[county] = events
        except Exception as e:      # noqa: BLE001
            print("digest: alerts failed for", county, e)
            out[county] = []
    return out


# A job's address becomes a map point once, kept in jobGeo/{jobId} (server
# only), and looked up again only when the address changes (geo.py does the
# looking up). The key carries a version so a better lookup gets one more try
# at addresses the old one could not find.
GEO_VERSION = "2"


def _job_point(job_id, j):
    g = _job_geo(job_id, j)
    return (g["lat"], g["lng"]) if g else None


def _job_geo(job_id, j):
    """{lat, lng, zip} for a job's address, or None. `zip` is the one the
    Census has for the street (None when only OpenStreetMap found it): the
    estimate checks the ZIP typed on the job against it before sending."""
    street = (j.get("address") or "").strip()
    city = (j.get("city") or "").strip()
    zip_ = (j.get("zip") or "").strip()
    if not street:
        return None
    key = "|".join([GEO_VERSION, street.lower(), city.lower(), zip_])
    ref = _db().collection("jobGeo").document(job_id)
    snap = ref.get()
    if snap.exists:
        g = snap.to_dict() or {}
        # A point found before the ZIP was kept is looked up once more.
        if g.get("key") == key and (not g.get("found") or "zip" in g):
            return {"lat": g["lat"], "lng": g["lng"], "zip": g.get("zip")} if g.get("found") else None
    # The Census first, OpenStreetMap after (geo.py): OpenStreetMap alone
    # missed rural fire-number addresses.
    import geo
    try:
        hit = geo.find(street, city, "WI", zip_)
    except Exception as e:              # noqa: BLE001
        print("digest: job address lookup failed:", job_id, e)
        return None                     # no answer is not "not found": try again next time
    zip_found = str(hit.get("zip") or "")[:5] if hit and hit.get("source") == "census" else ""
    ref.set({"key": key, "found": bool(hit), "lat": hit["lat"] if hit else None,
             "lng": hit["lng"] if hit else None, "zip": zip_found or None, "at": _now().isoformat()})
    return {"lat": hit["lat"], "lng": hit["lng"], "zip": zip_found or None} if hit else None


def job_sites(day, items, jobs):
    """The jobs being worked on `day`: an entry on the calendar that day linked
    to the job, or a job in progress. Each with who is on it (None = anyone
    who may see jobs) and its map point."""
    sites = {}
    for it in items:
        ev = it["ev"]
        jid = ev.get("jobId")
        if it["day"] != day or not jid or jid not in jobs:
            continue
        s = sites.setdefault(jid, {"jobId": jid, "uids": set(), "scheduled": True})
        for c in ev.get("crew") or []:
            if c.get("uid"):
                s["uids"].add(c["uid"])
    for jid, j in jobs.items():
        # In progress by its status, as the app reads it -- not a workStage
        # left behind on a job since marked Complete in the form, whose site
        # weather then came in every summary.
        if jid not in sites and status_of(j) == "inprogress":
            sites[jid] = {"jobId": jid, "uids": set(), "scheduled": False}
    out = []
    for jid, s in sites.items():
        j = jobs[jid]
        pt = _job_point(jid, j)
        out.append(dict(s, name=(j.get("customerName") or "Job").strip(),
                        noAddress=not (j.get("address") or "").strip(),
                        num=str(j.get("estimateNumber") or "").strip(),
                        where=", ".join(x for x in [(j.get("address") or "").strip(), (j.get("city") or "").strip()] if x),
                        point=pt))
    out.sort(key=lambda s: s["name"].lower())
    return out


def _wx_bits(w):
    """One place's day in short words, for the plain-text email and pushes."""
    if not w:
        return "forecast unavailable"
    bits = ["%s %s %d°/%d°" % (WMO_ICON.get(w["code"], ""), WMO.get(w["code"], ""), round(w["hi"]), round(w["lo"]))]
    if w["snow"] >= 0.1:
        bits.append('%.1f" snow' % w["snow"])
    elif w["pop"] >= 10:
        bits.append("%d%% rain" % w["pop"] + ((" (%.2f in)" % w["precip"]) if w["precip"] >= 0.01 else ""))
    bits.append("wind %d" % round(w["wind"]) + ((", gusts %d" % round(w["gust"])) if w["gust"] >= w["wind"] + 5 else "") + " mph")
    return " · ".join(bits)


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
        # Only the entries that can land in these days (events_near), not
        # every entry ever made.
        for eid, ev in events_near(c.reference, start, end).items():
            # One event with a date that will not parse is left out and
            # logged. Unguarded, it stopped the whole run: nobody got a summary.
            try:
                days = _occurrences(ev, start, end)
            except (TypeError, ValueError) as err:
                print("digest: skipped event", c.id, eid, "-", err)
                continue
            for day, one in days:
                items.append({"day": day, "cal": cal, "ev": one})
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


def _jobs():
    """Every job, less those in Recently deleted (app.js deleteJob): not in
    any summary, chase list or job-site weather while they wait there."""
    return {s.id: d for s in _db().collection("jobs").stream()
            for d in [s.to_dict() or {}] if not d.get("deletedAt")}


def _recurring_overdue(today):
    """Recurring crew tasks (recurring.js) not confirmed by their due day --
    Jonah: tell me if they have not been done. [(title, due YYYY-MM-DD,
    done)]: `done` is a card already moved to Done, only waiting for his OK --
    not the same news as a task nobody did."""
    out = []
    try:
        # On Crew tasks since 7 Oct; anything still on Maintenance from before.
        for board in ("crew", "maintenance"):
            for s in _db().collection("boards").document(board).collection("cards").stream():
                k = s.to_dict() or {}
                if k.get("recurring") and not k.get("confirmedAt") and str(k.get("due") or "") < _day(today):
                    out.append((str(k.get("title") or "A recurring task"), str(k.get("due")), bool(k.get("doneAt"))))
    except Exception as e:      # noqa: BLE001
        print("digest: recurring tasks not read:", e)
    return sorted(out, key=lambda x: x[1])


RECORD_MAX = 30     # lines in each of "Done today" / "Added today"


def _day_record(today, people):
    """The day on the boards, the calendars and the machines. Jonah (12 Oct
    2026): an end-of-day summary that lists "each card that was marked done,
    each calendar item that was marked completed, and every card, calendar
    card, and vehicle maintenance that was input into the app". Each list is
    [(what, where, who)]. The app writes times as ISO ...Z; a day is
    Central time."""
    db = _db()
    # The day's first moment AS TEXT, for the database's range questions:
    # the app writes UTC ("...T05:00:00.000Z" is Chicago's midnight), but a
    # time written in Chicago's own offset ("...T00:30:00-05:00", the
    # server's older stamps) sorts before that and was missed. Asking from
    # the bare date catches both; on_day() below then keeps only today's.
    start_z = _day(today)

    def when(iso):
        try:
            t = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        except ValueError:
            return None
        return (t if t.tzinfo else t.replace(tzinfo=TZ)).astimezone(TZ)

    def on_day(iso):
        t = when(iso)
        return bool(t) and t.date() == today

    def name_of(uid):
        return _name(people.get(uid)) if uid and people.get(uid) else ""

    out = {"cardsDone": [], "eventsDone": [], "cardsAdded": [], "eventsAdded": [], "machines": []}
    try:
        for b in db.collection("boards").stream():
            board = b.to_dict() or {}
            where = board.get("name") or "a board"
            cards = b.reference.collection("cards")
            for s in cards.where("doneAt", ">=", start_z).stream():
                k = s.to_dict() or {}
                if on_day(k.get("doneAt")):
                    out["cardsDone"].append((str(k.get("title") or "A card"), where, str(k.get("updatedBy") or "")))
            # Not the ones the app makes by itself: each week's recurring
            # task card, a machine's service card.
            for s in cards.where("createdAt", ">=", start_z).stream():
                k = s.to_dict() or {}
                if on_day(k.get("createdAt")) and not s.id.startswith("rc-") and not k.get("auto"):
                    out["cardsAdded"].append((str(k.get("title") or "A card"), where, str(k.get("createdBy") or "")))
    except Exception as e:      # noqa: BLE001
        print("digest: the day's cards not read:", e)
    try:
        for c in db.collection("calendars").stream():
            cal = c.to_dict() or {}
            where = cal.get("name") or "a calendar"
            evs = c.reference.collection("events")
            # Ticking a date off stamps the entry (calendar.js write), so
            # whatever was ticked today was changed today.
            for s in evs.where("updatedAt", ">=", start_z).stream():
                ev = s.to_dict() or {}
                for d, m in (ev.get("done") or {}).items():
                    if isinstance(m, dict) and on_day(m.get("at")):
                        out["eventsDone"].append((str(ev.get("title") or ev.get("jobName") or "An entry") +
                                                  ("" if d == _day(today) else " (%s)" % d), where, name_of(m.get("by"))))
            for s in evs.where("createdAt", ">=", start_z).stream():
                ev = s.to_dict() or {}
                if on_day(ev.get("createdAt")):
                    out["eventsAdded"].append((str(ev.get("title") or ev.get("jobName") or "An entry"),
                                               where + (" · " + str(ev.get("date")) if ev.get("date") else ""),
                                               name_of(ev.get("createdBy"))))
    except Exception as e:      # noqa: BLE001
        print("digest: the day's calendar entries not read:", e)
    try:
        for s in db.collection("equipment").stream():
            g = s.to_dict() or {}
            name = str(g.get("name") or "A machine")
            for e in g.get("service") or []:
                # A service's id is "sv" + the moment it was typed in
                # (equipment.js), which is "input today" -- its own date may
                # be an older service written up late.
                made = None
                try:
                    made = datetime.datetime.fromtimestamp(int(str(e.get("id") or "")[2:], 36) / 1000, TZ)
                except ValueError:
                    pass
                if (made.date() == today) if made else e.get("at") == _day(today):
                    out["machines"].append((("🛠️ " if e.get("kind") == "repair" else "🔧 ") + name + " — " +
                                            str(e.get("what") or "service"), str(e.get("by") or "")))
            for i in g.get("issues") or []:
                if on_day(i.get("at")):
                    out["machines"].append(("⚠️ " + name + " — " + str(i.get("what") or "a problem"), str(i.get("by") or "")))
    except Exception as e:      # noqa: BLE001
        print("digest: the day's equipment not read:", e)
    return out


def _open_tasks(people):
    """Everybody's tasks not ticked off -- today's (that have come round) and
    the fortnight's before -- for the end of the day (reminders.open_tasks:
    the rule is kept beside the 7 am list's, which carries the same ones)."""
    import reminders        # not at the top: reminders imports this module
    now = _now()
    try:
        return reminders.open_tasks(_db(), people, reminders.carry_from(now.date()), now.date(), now)
    except Exception as e:      # noqa: BLE001 -- a summary without them beats none
        print("digest: tasks not done not read:", e)
        return {}


def _task_lines(tasks, today, owner):
    """A summary's lines for tasks not done: what, where, who is on it (the
    owner's crew tasks say whose) -- and, for one from before, its day."""
    import reminders        # not at the top: reminders imports this module
    out = []
    for t in tasks:
        # Its tag's icon as its calendar has it (a tag the owner made too).
        icon = t.get("icon") or reminders.TYPES.get(t["kind"]) or ""
        who = ", ".join(n for n in t.get("on") or [] if n)
        text = (icon + " " if icon else "") + t["title"]
        if who:
            text += " · " + who
        elif owner and not t["theirs"]:
            text += " · the crew"
        when = (_fmt_time(t["time"]) if t["time"] else "") if t["day"] == today else \
            t["day"].strftime("%a %b ") + str(t["day"].day)
        out.append({"when": when, "text": text, "cal": t["where"]})
    return out


def qb_accepted(q):
    """A job's QuickBooks estimate record says the customer said yes:
    Accepted, or made into an invoice (Closed / Converted) after being
    accepted -- QuickBooks keeps AcceptedDate then. quickbooks.py and the
    app's sync.js read it the same way."""
    q = q or {}
    return q.get("status") == "Accepted" or (q.get("status") in ("Closed", "Converted") and bool(q.get("acceptedDate")))


def qb_turned_down(q):
    """The customer turned the estimate down in QuickBooks (Rejected). Not
    lost by itself -- the board asks "mark lost?" -- but never chased, and no
    follow-up email is written for it (followup.py). sync.js qbTurnedDown."""
    return (q or {}).get("status") == "Rejected"


# A job's status (app.js normStatus) and its one stage (app.js jobStage)
# live in stages.py, so the summaries, QuickBooks and the app give one answer.
status_of = stages.status_of


def _office(jobs):
    """Estimate work waiting on Jonah: drafts Claude built that he hasn't
    checked and sent, estimates a customer accepted that aren't booked yet,
    and money still owed on invoices made from estimates."""
    drafts, accepted, owed, to_order, to_bill = [], [], [], [], []
    for j in jobs.values():
        name = str(j.get("customerName") or "A bid")
        # Finished, not invoiced yet (its one stage, stages.stage_of): no
        # QuickBooks invoice and not marked Invoiced or Paid by hand. One on
        # its way off the books (a duplicate, in Recently deleted) is not.
        if stages.stage_of(j) == "finished" and not j.get("removeWhy") and not j.get("deletedAt"):
            to_bill.append(str(j.get("customerName") or "A job"))
        e = j.get("estimate") or {}
        q = j.get("qbEstimate") or {}
        bid = (j.get("jobStatus") or "quoting") == "quoting" and j.get("bidStage") not in ("lost", "won")
        if bid and (e.get("work") or e.get("materials")) and not q.get("id"):
            drafts.append(name)
        if bid and qb_accepted(q):
            accepted.append(name)
        inv = j.get("qbInvoiceRef") or {}
        try:
            bal = float(inv.get("balance") or 0)
        except (TypeError, ValueError):
            bal = 0
        if inv.get("id") and bal > 0:
            owed.append((name, bal, inv.get("docNumber")))
        # Booked or under way with materials still to order (Materials to Order).
        if (j.get("jobStatus") or "quoting") in ("booked", "inprogress"):
            left = [o for o in (j.get("orderItems") or []) if isinstance(o, dict) and not o.get("ordered")]
            if left:
                to_order.append((name, len(left)))
    return {"drafts": sorted(drafts), "accepted": sorted(accepted), "owed": sorted(owed, key=lambda x: -x[1]),
            "toOrder": sorted(to_order), "toBill": sorted(to_bill)}


# When an invoice wants a reminder (Jonah, 15 Oct 2026: "track invoices &
# when they were sent and when to send reminder invoices"). THE REMINDER
# RULE -- the same in invoices.js stateOf, so the list and the summary agree:
#   - a deposit paid on a job not finished yet: the rest is due when the job
#     is done -- no reminder until then;
#   - never emailed from QuickBooks: send it;
#   - else the first reminder `firstAfterDays` after the due date (or the
#     day the job was finished, if later), then every `everyDays` after the
#     last one sent, up to `max` -- then it is time to call.
# Every email of the invoice after the first counts as a reminder (QuickBooks'
# own sends too), and so does one noted by hand (a call, a text).
INVOICE_RULES = {"firstAfterDays": 3, "everyDays": 7, "max": 4}


def invoice_rules():
    try:
        got = _db().collection("settings").document("invoiceReminders").get().to_dict() or {}
    except Exception as e:      # noqa: BLE001
        print("digest: reminder settings not read:", e)
        got = {}
    out = dict(INVOICE_RULES)
    for k in out:
        if isinstance(got.get(k), (int, float)) and got[k] >= 0:
            out[k] = int(got[k])
    return out


def _local_day(s):
    """The Chicago day of an ISO time ("2026-10-13T13:06:57-07:00" -> its day
    here); a bare date stays as it is."""
    s = str(s or "")
    if len(s) <= 10:
        return s
    try:
        t = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return s[:10]
    return (t if t.tzinfo else t.replace(tzinfo=TZ)).astimezone(TZ).date().isoformat()


def invoice_state(inv, job, rules, today):
    """{kind: paid|waiting|unsent|call|due|later, next, count, late, deposit,
    rest} for one invoice (invoices/{id}); `today` a date. The same rule as
    invoices.js stateOf -- change both together.

    Jonah often makes the invoice before the work starts, to collect the
    deposit (QuickBooks won't take a deposit on an estimate once it has been
    accepted). So on a job here that isn't finished, an invoice with nothing
    paid is asking for the deposit (`deposit`), and one with the deposit paid
    is waiting for the job to be done. Once it is done, the bill for the rest
    is the first email after the deposit came in; emails before that were
    the deposit's and are not reminders for the rest (`rest`)."""
    if not inv.get("open") or not (float(inv.get("balance") or 0) > 0):
        return {"kind": "paid"}
    emails = sorted(_local_day(x) for x in inv.get("emails") or [] if x)
    hand = sorted(_local_day((h or {}).get("at")) for h in inv.get("handReminders") or [] if (h or {}).get("at"))
    done = bool(job) and status_of(job) == "complete"
    total, bal = float(inv.get("total") or 0), float(inv.get("balance") or 0)
    part = bal < total - 0.005
    if job and not done and part:
        return {"kind": "waiting"}
    deposit = bool(job) and not done
    due_day = _local_day(inv.get("dueDate") or inv.get("txnDate"))
    late = (today - datetime.date.fromisoformat(due_day)).days if due_day else 0
    since = ""
    if done and part and job.get("completedAt"):
        fin = _local_day(job.get("completedAt"))
        before = [p.get("date") for p in inv.get("payments") or [] if p.get("date") and p["date"] <= fin]
        since = before[-1] if before else ""
    if since:
        emails = [d for d in emails if d > since]
        hand = [d for d in hand if d > since]
    base = {"late": late, "deposit": deposit, "rest": bool(since)}
    # QuickBooks says it was emailed but not when (before Job Hub watched):
    # sent, with no reminders yet.
    if not emails and not hand and (since or inv.get("emailStatus") != "EmailSent"):
        return dict(base, kind="unsent")
    # Put off by hand ("Not yet"): nothing until that day.
    if _local_day(inv.get("snoozeUntil")) > today.isoformat():
        return dict(base, kind="later", next=_local_day(inv.get("snoozeUntil")))
    if since:
        start = (emails or hand)[0]
    else:
        start = due_day or today.isoformat()
        if done and _local_day(job.get("completedAt")) > start:
            start = _local_day(job.get("completedAt"))
    count = max(0, len(emails) - 1) + len(hand)
    if count >= rules["max"]:
        return dict(base, kind="call", count=count)
    at = datetime.date.fromisoformat(start if count == 0 else max(emails[-1:] + hand[-1:]))
    nxt = at + datetime.timedelta(days=rules["firstAfterDays"] if count == 0 else rules["everyDays"])
    return dict(base, kind="due" if today >= nxt else "later", next=nxt.isoformat(), count=count)


def _invoice_reminders(jobs, today):
    """The open invoices that want something done today: a reminder due, one
    never emailed, or one past its reminders (call them)."""
    out = []
    try:
        rules = invoice_rules()
        for s in _db().collection("invoices").where("open", "==", True).stream():
            inv = s.to_dict() or {}
            st = invoice_state(inv, jobs.get(inv.get("jobId")) if inv.get("jobId") else None, rules, today)
            if st["kind"] in ("due", "unsent", "call"):
                out.append({"name": inv.get("customerName") or "A customer", "doc": inv.get("docNumber") or "",
                            "balance": float(inv.get("balance") or 0), "kind": st["kind"], "late": st.get("late") or 0,
                            "count": st.get("count") or 0, "deposit": bool(st.get("deposit")), "rest": bool(st.get("rest"))})
    except Exception as e:      # noqa: BLE001 -- a summary without them beats none
        print("digest: invoice reminders not worked out:", e)
    return sorted(out, key=lambda x: -x["late"])


def _care_owed(jobs):
    """Finished jobs with plants still owing their care email (care.py) --
    Jonah, 14 Oct 2026. A summary without this beats no summary."""
    try:
        import care     # here, not at the top: care.py imports this module
        return care.owed(jobs)
    except Exception as e:      # noqa: BLE001
        print("digest: plant-care emails owed not worked out:", e)
        return []


def _care_section(owed, sections, push_bits):
    """The owner's "Plant-care emails owed" lines, and a word in the push."""
    import care

    def day_of(iso):
        try:
            t = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        except ValueError:
            return "recently"
        t = (t if t.tzinfo else t.replace(tzinfo=TZ)).astimezone(TZ)
        return t.strftime("%b ") + str(t.day)
    sections.append(("Care emails owed (plants / turf)", care.summary_lines(owed, day_of)))
    push_bits.append("%d care email%s owed" % (len(owed), "" if len(owed) == 1 else "s"))


def _bids(jobs=None):
    """Bids that need Jonah, by the chase rule above (CHASE_AFTER_DAYS):
    each {name, stage, days, price, kind} -- kind "chase" (sent, no answer)
    or "write" (still to write and send). Oldest first."""
    now = datetime.datetime.now(datetime.timezone.utc)
    out = []
    for j in (jobs if jobs is not None else _jobs()).values():
        if status_of(j) != "quoting":
            continue
        # A lost bid stays 'quoting' (boards.js keeps it there in case the
        # customer rings back), so without this it fell through to "Bid to
        # send" below and was chased in every summary for ever. The Bids board
        # files it under Lost; this agrees with it.
        if j.get("bidStage") == "lost":
            continue
        q = j.get("qbEstimate") or {}
        if qb_accepted(q) or qb_turned_down(q):
            continue
        stage = j.get("bidStage") if j.get("bidStage") in BID_STAGE_NAME else "toSend"
        if stage == "siteVisit":
            continue
        since = j.get("bidStageAt") or j.get("lastModified")
        try:
            days = (now - datetime.datetime.fromisoformat(since.replace("Z", "+00:00"))).days
        except Exception:       # noqa: BLE001
            days = 0
        if stage == "toSend":
            if days < WRITE_AFTER_DAYS:
                continue
            kind = "write"
        elif days < CHASE_AFTER_DAYS.get(stage, 5):
            continue
        else:
            kind = "chase"
        try:
            price = float(str(j.get("jobPrice") or "0").replace("$", "").replace(",", "") or 0)
        except ValueError:
            price = 0
        out.append({"name": (j.get("customerName") or "Untitled").strip(), "stage": stage, "days": days,
                    "price": price, "kind": kind})
    out.sort(key=lambda b: (-b["days"]))
    return out


# The words for the clock's kinds that are not a job (timeclock.js
# OVERHEAD_LABEL -- change both). The stored kinds keep their first names
# ('labor', 'receipts'), and those shifts stored the old words as their name,
# so theirs is always read from here (Jonah, 15 Oct 2026: "Labor" and
# "Receipts" confused the crew).
SHIFT_KINDS = {"snow": "Snow", "labor": "Shop / yard work", "receipts": "Pickups + errands",
               "repair": "Equipment repair"}


def shift_place(e):
    kind = e.get("kind")
    if kind in ("labor", "receipts"):
        return SHIFT_KINDS[kind]
    return str(e.get("targetName") or SHIFT_KINDS.get(kind) or "Other")


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
        out.append({"uid": e.get("uid"), "who": e.get("workerName") or "", "where": shift_place(e),
                    "mins": mins, "running": not e.get("endedMs"), "status": e.get("status"),
                    "day": "today" if started >= today_ms else "yesterday" if started >= yday_ms else "earlier"})
    return out


# ---------------------------------------------------------------- building

def _job_day(it):
    """A day on a job -- who is working where: everything on the Job
    schedule, or an entry picked as a job's day before it existed
    (reminders._is_job_day, calendar.js isJobDay)."""
    import reminders        # not at the top: reminders imports this module
    ev, cal = it["ev"], it["cal"]
    return reminders._is_job_day(reminders._type_of(ev, cal=cal), cal.get("kind"),
                                 reminders._known_on(cal, ev.get("type")))


def _tag_icon(it):
    """The icon of an entry's tag, as its calendar has it ('' none)."""
    import reminders        # not at the top: reminders imports this module
    try:
        if _job_day(it):
            return reminders.TYPES["jobday"]
        return (reminders._tag_of(reminders._type_of(it["ev"], cal=it["cal"]), it["cal"]) or {}).get("icon") or ""
    except Exception:       # noqa: BLE001 -- a line without its icon beats no summary
        return ""


def _event_line(it, people, show_cal=True):
    ev = it["ev"]
    when = "All day" if (ev.get("allDay") or not ev.get("time")) else (
        _fmt_time(ev.get("time")) + (("–" + _fmt_time(ev.get("endTime"))) if ev.get("endTime") else ""))
    title = ev.get("title") or ev.get("jobName") or "Untitled"
    # Its tag's icon in front (16 Oct 2026: each calendar's own tags).
    icon = _tag_icon(it)
    bits = [(icon + " " if icon else "") + title]
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
    # The headline uses the same forecast as the Madison row of the table
    # below, so the two never disagree by a degree.
    mad = next((a["w"] for a in cache.get("areas") or [] if a["name"] == HOME["name"] and a.get("w")), None)
    if mad and cache.get("wxday") == today and wtoday:
        wtoday = dict(wtoday, **{k: mad[k] for k in ("code", "hi", "lo", "pop", "snow", "wind", "gust")})
    if mad and cache.get("wxday") == tomorrow and wtom:
        wtom = dict(wtom, **{k: mad[k] for k in ("code", "hi", "lo", "pop", "snow", "wind", "gust")})
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
        # A day on the Job schedule: theirs when they are on it, or nobody is
        # (the whole crew is there) -- calendar.js eventIsMine.
        if it["cal"].get("kind") == "jobs":
            return not crew or any(c.get("uid") == uid for c in crew)
        # A calendar shared with them only to look at (calendar.js lookOnly
        # -- Jonah's My work) is not their day: only what they are on.
        if it["cal"].get("lookOnly") is True and uid not in (it["cal"].get("editors") or []):
            return any(c.get("uid") == uid for c in crew)
        return not crew or any(c.get("uid") == uid for c in crew)

    items = [it for it in cache["items"] if mine(it)]
    def day_items(d):
        return [it for it in items if it["day"] == d]
    # Jonah (16 Oct 2026): "the job calendar will be solely for where the
    # crew is working each day" -- a day's job days get a section of their
    # own, above the rest of the day.
    where_title = "Where the crew is working" if owner or sees("calendars") else "Where you’re working"

    def job_section(title, lst):
        if lst:
            sections.append((title, [_event_line(it, people) for it in lst]))

    if slot == "morning":
        t = day_items(today)
        tj, tr = [it for it in t if _job_day(it)], [it for it in t if not _job_day(it)]
        job_section(where_title + " today", tj)
        if tr or owner:
            sections.append(("Today — " + _long_day(today),
                             [_event_line(it, people) for it in tr] or
                             [{"text": "Nothing else on the calendar." if tj else "Nothing on the calendar."}]))
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
        tj, tr = [it for it in tm if _job_day(it)], [it for it in tm if not _job_day(it)]
        job_section(where_title + " tomorrow", tj)
        if tr or owner:
            sections.append(("Tomorrow — " + _long_day(tomorrow),
                             [_event_line(it, people) for it in tr] or
                             [{"text": "Nothing else on the calendar." if tj else "Nothing on the calendar."}]))
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

    # ---- the day on the boards, calendars and machines (the owner's end of
    # the day; _day_record)
    rec = cache.get("record")
    if owner and slot == "evening" and rec:
        def by(who):
            w = str(who or "").strip()
            return "" if not w or w.lower() == "job hub (email)" else " · " + w

        def capped(lines):
            return lines[:RECORD_MAX] + ([{"text": "…and %d more" % (len(lines) - RECORD_MAX)}] if len(lines) > RECORD_MAX else [])
        done = [{"text": "📌 %s — %s%s" % (t, w, by(b))} for t, w, b in rec["cardsDone"]] + \
            [{"text": "📅 %s — %s%s" % (t, w, by(b))} for t, w, b in rec["eventsDone"]]
        sections.append(("Done today", capped(done) or [{"text": "Nothing marked done today."}]))
        added = [{"text": "📌 Card: %s — %s%s" % (t, w, by(b))} for t, w, b in rec["cardsAdded"]] + \
            [{"text": "📅 Calendar: %s — %s%s" % (t, w, by(b))} for t, w, b in rec["eventsAdded"]] + \
            [{"text": "%s%s" % (t, by(b))} for t, b in rec["machines"]]
        sections.append(("Added today", capped(added) or [{"text": "Nothing new put in today."}]))
        if done:
            push_bits.append("%d done today" % len(done))

    # ---- the end of the day (endofday.py; Jonah, 22 Oct 2026): the owner's
    # gets each report in -- or whose is not -- and anyone on the list,
    # whether theirs went.
    if cache.get("eod"):
        import endofday
        endofday.add_to_summary(cache["eod"], owner, uid, sections, push_bits)

    # ---- tasks not ticked off. Jonah (14 Oct 2026): "make tasks on the
    # calendar have to be marked done or they get included in the end day
    # summary. This goes for all tasks. Appointments are different." Each
    # person's own (reminders.open_tasks); the owner's has the crew's too.
    # Then the ones still left from the fortnight before. A recurring task
    # gone past its day is in "Recurring tasks not done" for whoever gets
    # that, so it is not said twice.
    if slot == "evening":
        def cut(lines):
            return lines[:RECORD_MAX] + ([{"text": "…and %d more" % (len(lines) - RECORD_MAX)}]
                                         if len(lines) > RECORD_MAX else [])
        gets_recurring = owner or access.get("boards") == "change"
        tasks = [t for t in (cache.get("open") or {}).get(uid) or []
                 if not (gets_recurring and t["recurring"] and t["day"] < today)]
        now_left = [t for t in tasks if t["day"] == today]
        before = [t for t in tasks if t["day"] < today]
        if now_left:
            sections.append(("Not done today", cut(_task_lines(now_left, today, owner))))
        if before:
            sections.append(("Still not done from before", cut(_task_lines(before, today, owner))))
        if tasks:
            push_bits.append("%d not done" % len(tasks))

    # ---- bids (the owner, and an admin given Jobs)
    if sees("jobs") and (slot in ("morning", "evening") or (slot == "midday" and cache["bids"])):
        bids = cache["bids"]
        # Two lists, as the board has them (the chase rule, CHASE_AFTER_DAYS):
        # sent and waiting on an answer, and still to write. Older caches
        # (no kind) were all chases.
        for kind, title, word in (("chase", "Bids to chase", "to chase"), ("write", "Bids to write", "to write")):
            some = [b for b in bids if b.get("kind", "chase") == kind]
            if not some:
                continue
            sections.append((title, [{"text": "%s — %s, %d day%s%s" % (
                b["name"], BID_STAGE_NAME[b["stage"]], b["days"], "" if b["days"] == 1 else "s",
                (" · $%s" % format(int(round(b["price"])), ",")) if b["price"] else "")} for b in some[:8]] +
                ([{"text": "…and %d more on the Bids board" % (len(some) - 8)}] if len(some) > 8 else [])))
            if slot != "midday":
                push_bits.append("%d bid%s %s" % (len(some), "" if len(some) == 1 else "s", word))

    # ---- recurring crew tasks not confirmed by their day (the owner, and an
    # admin who runs the boards)
    late = cache.get("recurring") or []
    if (owner or access.get("boards") == "change") and slot in ("morning", "evening") and late:
        undone = [x for x in late if not x[2]]
        sections.append(("Recurring tasks not done", [{"text": (
            "✔ %s — done, waiting for your OK on the Crew tasks board" % t if done else
            "🔁 %s — was due %s" % (t, _long_day(datetime.date.fromisoformat(d))))} for t, d, done in late[:8]]))
        if undone:
            push_bits.append("%d recurring task%s not done" % (len(undone), "" if len(undone) == 1 else "s"))

    # ---- estimates: drafts to check, yeses to book, money still owed
    office = cache.get("office") or {}
    if sees("jobs") and slot in ("morning", "evening") and any(office.get(k) for k in ("drafts", "accepted", "owed", "toOrder", "toBill")):
        lines = []
        for n in office.get("accepted") or []:
            lines.append({"text": "✅ %s accepted the estimate — book it and make the invoice" % n})
        if office.get("drafts"):
            d = office["drafts"]
            lines.append({"text": "✨ %d estimate%s drafted, waiting for you to check and send: %s" % (
                len(d), "" if len(d) == 1 else "s", ", ".join(d[:6]) + (" +%d more" % (len(d) - 6) if len(d) > 6 else ""))})
        # One the Invoices section below says to chase is told there, not twice.
        chase = {str(x["doc"]) for x in cache.get("invoices") or [] if x.get("doc")}
        for n, bal, num in [o for o in office.get("owed") or [] if not (o[2] and str(o[2]) in chase)][:6]:
            lines.append({"text": "💵 %s owes $%s%s" % (n, format(round(bal, 2), ",.2f"), (" on invoice #%s" % num) if num else "")})
        if office.get("toBill"):
            t = office["toBill"]
            lines.append({"text": "🧾 Finished, not invoiced yet: %s" % ", ".join(t[:6]) + (
                " +%d more" % (len(t) - 6) if len(t) > 6 else "")})
        if office.get("toOrder"):
            t = office["toOrder"]
            lines.append({"text": "🛒 Materials still to order: %s" % ", ".join(
                "%s (%d)" % (n, c) for n, c in t[:6]) + (" +%d more" % (len(t) - 6) if len(t) > 6 else "")})
        sections.append(("Estimates & invoices", lines))
        if office.get("accepted"):
            push_bits.append("%d estimate%s accepted" % (len(office["accepted"]), "" if len(office["accepted"]) == 1 else "s"))
        if office.get("drafts"):
            push_bits.append("%d draft%s to check" % (len(office["drafts"]), "" if len(office["drafts"]) == 1 else "s"))

    # ---- invoices wanting a reminder (invoice_state; the Invoices list on All Jobs)
    remind = cache.get("invoices") or []
    if (owner or access.get("billing") in ("see", "change")) and slot in ("morning", "evening") and remind:
        lines = []
        for x in remind[:10]:
            what = ("job done — email the bill for the rest" if x["kind"] == "unsent" and x.get("rest")
                    else "not emailed yet — send it" if x["kind"] == "unsent"
                    else "%d reminders sent — time to call" % x["count"] if x["kind"] == "call"
                    else "deposit not paid — reminder due" if x.get("deposit")
                    else "reminder due")
            lines.append({"text": "💵 %s%s — $%s%s — %s" % (
                x["name"], (" #" + x["doc"]) if x["doc"] else "", format(round(x["balance"], 2), ",.2f"),
                (", %d day%s late" % (x["late"], "" if x["late"] == 1 else "s")) if x["late"] > 0 else "", what)})
        sections.append(("Invoices", lines + [{"text": "Send them from All Jobs → Invoices."}]))
        due = [x for x in remind if x["kind"] != "call"]
        if due:
            push_bits.append("%d invoice reminder%s due" % (len(due), "" if len(due) == 1 else "s"))

    # ---- plant-care emails still owed on finished jobs (the owner's alone)
    if owner and slot in ("morning", "evening") and cache.get("careOwed"):
        _care_section(cache["careOwed"], sections, push_bits)

    # ---- receipts waiting to be put on a job (whoever may change jobs sorts them)
    waiting = cache.get("receipts") or 0
    if (owner or access.get("jobs") == "change") and waiting:
        sections.append(("Receipts", [{"text": "🧾 %d receipt%s to sort — open the Receipts tab" % (
            waiting, "" if waiting == 1 else "s")}]))
        push_bits.append("%d receipt%s to sort" % (waiting, "" if waiting == 1 else "s"))

    # ---- next season's outreach (the owner's morning; outreach.py)
    import outreach
    outreach.add_to_summary(slot, owner, today, sections, push_bits)

    # ---- the weather tables: every town, and each job site being worked.
    # Crew see the sites they are on; whoever may see jobs sees them all.
    sites = [x for x in cache.get("sites") or [] if sees("jobs") or uid in x["uids"]]
    wet = [x for x in sites if x.get("w") and x["w"]["workPop"] >= 50]
    if wet:
        push_bits.append("rain likely at " + ", ".join(x["name"] for x in wet[:2]) +
                         (" +%d" % (len(wet) - 2) if len(wet) > 2 else ""))
    else:
        rainy = [a["name"] for a in cache.get("areas") or [] if a.get("w") and a["w"]["pop"] >= 60]
        if rainy:
            push_bits.append("rain likely: " + ", ".join(rainy[:3]) + (" +%d" % (len(rainy) - 3) if len(rainy) > 3 else ""))

    # A crew member with nothing but weather does not need a midday ping.
    if not owner and slot == "midday" and len(sections) == 1 and not (wx.get("snow48") or 0) >= 0.5 \
            and not wx.get("alerts"):
        return None

    meta = SLOTS[slot]
    subject = "%s %s — %s" % (meta["icon"], meta["label"], now.strftime("%a %b ") + str(now.day))
    return {"subject": subject, "sections": sections,
            "areas": cache.get("areas") or [], "alerts": cache.get("alerts") or {},
            "sites": sites, "wxday": cache.get("wxday"),
            "push": {"title": "%s %s" % (meta["icon"], meta["label"]),
                     "body": " · ".join(push_bits) or "Your %s update" % meta["label"].lower()}}


# ---------------------------------------------------------------- rendering


def _site_label(x):
    return x["name"] + ((" #" + x["num"]) if x.get("num") else "") + ((" — " + x["where"]) if x.get("where") else "")


def to_text(d):
    out = [d["subject"], ""]
    for i, (title, lines) in enumerate(d["sections"]):
        out.append(title.upper())
        for l in lines:
            out.append("  " + ((l["when"] + "  ") if l.get("when") else "") + l["text"] +
                       ((" [" + l["cal"] + "]") if l.get("cal") else ""))
        out.append("")
        if i == 0:
            out.extend(_tables_text(d))
    out.append("Open Job Hub: " + _app_url())
    return "\n".join(out)


def _tables_text(d):
    out = []
    if d.get("sites"):
        out.append("JOB SITES — " + _long_day(d["wxday"]).upper())
        for x in d["sites"]:
            w = x.get("w")
            work = (" · work hours: %d%% rain" % w["workPop"]) if w and w["workPop"] else ""
            out.append("  " + _site_label(x) + ": " + (_wx_bits(w) + work if w else
                       "no address on the job yet" if x.get("noAddress") else
                       ("address not found on the map" if not x.get("point") else "forecast unavailable")))
        out.append("")
    if d.get("areas"):
        out.append("AROUND DANE & GREEN COUNTY — " + _long_day(d["wxday"]).upper())
        county = None
        for a in d["areas"]:
            if a["county"] != county:
                county = a["county"]
                warn = (d.get("alerts") or {}).get(county) or []
                out.append("  %s County%s" % (county, (" — ⚠️ " + ", ".join(warn)) if warn else ""))
            out.append("    %s: %s" % (a["name"], _wx_bits(a["w"])))
        out.append("")
    return out


# Inline styles and tables only: Gmail throws away <style> blocks.
_TD = "padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top"


def _wx_cells(w):
    if not w:
        return '<td colspan="4" style="%s;color:#9a90a6">Forecast unavailable</td>' % _TD
    if w["snow"] >= 0.1:
        wet = '<b style="color:#2a7fa8">❄️ %.1f&quot;</b>' % w["snow"]
    elif w["pop"] >= 10:
        wet = "💧 %d%%" % w["pop"] + ((' <span style="color:#7b7188">%.2f&quot;</span>' % w["precip"])
                                      if w["precip"] >= 0.01 else "")
    else:
        wet = '<span style="color:#9a90a6">—</span>'
    wind = "%d" % round(w["wind"]) + ((' <span style="color:#7b7188">gusts %d</span>' % round(w["gust"]))
                                      if w["gust"] >= w["wind"] + 5 else "")
    return ('<td style="%s;white-space:nowrap">%s %s</td>'
            '<td style="%s;white-space:nowrap"><b>%d°</b> <span style="color:#7b7188">%d°</span></td>'
            '<td style="%s;white-space:nowrap">%s</td>'
            '<td style="%s;white-space:nowrap">%s</td>') % (
        _TD, WMO_ICON.get(w["code"], ""), escape(WMO.get(w["code"], "")), _TD, round(w["hi"]), round(w["lo"]),
        _TD, wet, _TD, wind)


def _row_bg(w):
    if not w:
        return ""
    if w["snow"] >= 0.1:
        return "background:#e6f4fa;"
    if w["pop"] >= 50:
        return "background:#eef4fc;"
    return ""


def _tables_html(d):
    head = ('<tr style="background:#f4f1f8;color:#7b7188;font-size:11px;text-transform:uppercase;letter-spacing:.5px">'
            '<th align="left" style="padding:6px 8px">%s</th><th align="left" style="padding:6px 8px">Sky</th>'
            '<th align="left" style="padding:6px 8px">High / low</th>'
            '<th align="left" style="padding:6px 8px">Rain / snow</th>'
            '<th align="left" style="padding:6px 8px">Wind mph</th></tr>')
    table = ('<table role="presentation" cellspacing="0" cellpadding="0" '
             'style="width:100%%;border-collapse:collapse;font:13px/1.4 Arial,sans-serif;color:#2b2433;'
             'margin:4px 0 6px">%s</table>')
    h3 = ('<h3 style="font:700 13px Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;'
          'color:#66418f;margin:22px 0 8px">%s</h3>')
    out = []
    if d.get("sites"):
        rows = [head % "Job site"]
        for x in d["sites"]:
            w = x.get("w")
            label = '<b>%s</b>%s<br><span style="color:#7b7188;font-size:12px">%s</span>' % (
                escape(x["name"]),
                (' <span style="color:#7b7188">#%s</span>' % escape(x["num"])) if x.get("num") else "",
                escape(x.get("where") or ""))
            if w and w["workPop"]:
                label += ('<br><span style="color:#2f7fc8;font-size:12px;font-weight:700">'
                          '%d%% chance of rain 7 am–5 pm%s</span>' % (
                              w["workPop"],
                              (" · about %.2f&quot;" % w["workRain"]) if w["workRain"] >= 0.01 else ""))
            if not x.get("point"):
                cells = '<td colspan="4" style="%s;color:#9a90a6">%s</td>' % (
                    _TD, "No address on the job yet — add one for its weather" if x.get("noAddress")
                    else "Address not found on the map")
            else:
                cells = _wx_cells(w)
            rows.append('<tr style="%s"><td style="%s">%s</td>%s</tr>' % (_row_bg(w), _TD, label, cells))
        out.append(h3 % escape("Job sites — " + _long_day(d["wxday"])))
        out.append(table % "".join(rows))
    if d.get("areas"):
        rows = [head % "Town"]
        county = None
        for a in d["areas"]:
            if a["county"] != county:
                county = a["county"]
                warn = (d.get("alerts") or {}).get(county) or []
                rows.append('<tr><td colspan="5" style="padding:10px 8px 4px;font-weight:700;color:#66418f">'
                            '%s County%s</td></tr>' % (
                                escape(county),
                                (' <span style="color:#c8492b">⚠️ %s</span>' % escape(", ".join(warn))) if warn else ""))
            rows.append('<tr style="%s"><td style="%s"><b>%s</b></td>%s</tr>' % (
                _row_bg(a["w"]), _TD, escape(a["name"]), _wx_cells(a["w"])))
        out.append(h3 % escape("Around Dane & Green County — " + _long_day(d["wxday"])))
        out.append(table % "".join(rows))
    return "".join(out)


def to_html(d):
    rows = []
    for i, (title, lines) in enumerate(d["sections"]):
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
        # The tables come straight after the weather headline.
        if i == 0:
            rows.append(_tables_html(d))
    return ('<div style="max-width:640px;margin:0 auto;padding:18px">'
            '<div style="font:800 22px Georgia,serif;color:#66418f">YD Job Hub</div>'
            '<div style="font:700 15px Arial,sans-serif;color:#c9922f;margin-top:2px">%s</div>%s'
            '<p style="margin-top:26px"><a href="%s" style="background:#66418f;color:#fff;text-decoration:none;'
            'padding:11px 18px;border-radius:7px;font:700 13px Arial,sans-serif">Open Job Hub</a></p>'
            '<p style="font:11px Arial,sans-serif;color:#9a90a6">Change what you get from the ⋯ menu → '
            'Notifications &amp; summaries.</p></div>') % (escape(d["subject"]), "".join(rows), _app_url())


# ---------------------------------------------------------------- sending


_sa_email = {"value": None}


def _service_account_email():
    """This service's own account, asked of the metadata server once per
    instance: it never changes while the instance runs, and every scheduler
    call (every five minutes) checks its caller against it."""
    if _sa_email["value"]:
        return _sa_email["value"]
    r = requests.get("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email",
                     headers={"Metadata-Flavor": "Google"}, timeout=5)
    email = r.text.strip()
    if r.status_code == 200 and "@" in email:      # an error page is not kept
        _sa_email["value"] = email
    return email


GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send"
_gmail_tokens = {}      # scope -> {"token", "exp"}


def _gmail_access_token(scope=GMAIL_SEND):
    """An access token to act in the owner's Gmail -- send (the summaries) or
    compose (Claude's drafts) -- from this service's own identity via
    domain-wide delegation. The JWT is signed by Google's IAM service
    (signJwt): no private key exists anywhere to leak. Each scope must be
    listed for this service in the Workspace Admin console."""
    import time
    held = _gmail_tokens.get(scope)
    if held and held["exp"] > time.time() + 60:
        return held["token"]
    import google.auth
    from google.auth import iam
    from google.auth.transport.requests import Request
    from google.oauth2 import service_account
    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    sa = _service_account_email()
    signer = iam.Signer(Request(), creds, sa)
    dwd = service_account.Credentials(signer, sa, "https://oauth2.googleapis.com/token",
                                      scopes=[scope], subject=OWNER_EMAIL)
    dwd.refresh(Request())
    _gmail_tokens[scope] = {"token": dwd.token,
                            "exp": dwd.expiry.timestamp() if dwd.expiry else time.time() + 3000}
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


def send_push(uid, d, tag=None, ttl=6 * 3600, opens="calendar"):
    """To every phone this person has switched notifications on for. A phone
    that has since said no (404/410) is forgotten. `tag` keeps one kind of
    notification from replacing another on the phone (a reminder must not
    wipe out the morning summary). `opens` is where a tap takes them."""
    from pywebpush import WebPushException, webpush
    key = os.environ.get("VAPID_PRIVATE")
    if not key:
        raise RuntimeError("phone notifications are not configured (no VAPID key)")
    db = _db()
    sent = 0
    body = {"title": d["push"]["title"], "body": d["push"]["body"][:180], "url": _app_url() + "#" + opens}
    if tag:
        body["tag"] = tag
    payload = json.dumps(body)
    for s in db.collection("pushSubs").where("uid", "==", uid).stream():
        sub = (s.to_dict() or {}).get("sub")
        if not sub:
            continue
        try:
            # A push service that hangs must not hold up the five-minute
            # reminders run (or everyone's summary) behind it.
            webpush(subscription_info=sub, data=payload, vapid_private_key=key,
                    vapid_claims={"sub": "mailto:" + OWNER_EMAIL}, ttl=ttl, timeout=10)
            sent += 1
        except WebPushException as e:
            code = getattr(e.response, "status_code", None)
            if code in (404, 410):
                s.reference.delete()
            else:
                print("digest: push failed for", uid, code, e)
        except requests.RequestException as e:
            # Timed out or unreachable: this phone misses it; their others don't.
            print("digest: push not delivered for", uid, e)
    return sent


# ---------------------------------------------------------------- running

# autoRemind: everything on the calendar and every card of theirs buzzes the
# phone without a reminder set on each (reminders.py _usual; Jonah, 12 Oct
# 2026) -- everyone's on until they switch it off. crewActivity: the owner's
# phone told what anybody else added or changed (reminders.py _activity).
# notify.js too.
DEFAULT_PREFS = {
    "owner": {"email": True, "push": True, "morning": True, "midday": True, "evening": True, "autoRemind": True,
              "crewActivity": True},
    "crew": {"email": False, "push": True, "morning": True, "midday": True, "evening": True, "autoRemind": True,
             "crewActivity": False},
}


KEEP_DAYS = 14


def _kept_id(uid, slot, today):
    """summaries/{this}: one person's summary of one slot on one day."""
    return "%s_%s_%s" % (uid, _day(today), slot)


def _keep(uid, slot, d):
    """The summary as sent, for the app's Summaries screen (notify.js). The
    email's own page, so the app shows exactly what the email would. A
    person's older than KEEP_DAYS are cleared as the new one goes in."""
    db = _db()
    today = _now().date()
    db.collection("summaries").document(_kept_id(uid, slot, today)).set({
        "uid": uid, "slot": slot, "day": _day(today), "at": _now().isoformat(),
        "subject": d.get("subject") or "", "push": d.get("push") or {}, "html": to_html(d)})
    cutoff = _day(today - datetime.timedelta(days=KEEP_DAYS))
    # Only each one's day is needed to judge it, not the whole page it holds.
    for s in db.collection("summaries").where("uid", "==", uid).select(["day"]).stream():
        if str((s.to_dict() or {}).get("day") or "") < cutoff:
            s.reference.delete()


def _gets_midday(user):
    """Jonah (15 Oct 2026): "turn off midday summary for crew: leave on for
    admins." The owner and admins have it as their settings say; a crew
    member never (notify.js does not offer it to them)."""
    return user.get("role") in ("owner", "admin")


def _prefs_of(user, snap):
    p = dict(DEFAULT_PREFS["owner" if user.get("role") == "owner" else "crew"])
    if snap is not None and snap.exists:
        p.update({k: v for k, v in (snap.to_dict() or {}).items() if k in p})
    if not _gets_midday(user):
        p["midday"] = False
    return p


def _prefs(user):
    return _prefs_of(user, _db().collection("digestPrefs").document(user["uid"]).get())


def prefs_all(people):
    """{uid: what _prefs gives} for everybody, in one read of all their
    settings (the reminders run needs them every five minutes)."""
    if not people:
        return {}
    db = _db()
    snaps = {s.id: s for s in db.get_all([db.collection("digestPrefs").document(uid) for uid in people])}
    return {uid: _prefs_of(u, snaps.get(uid)) for uid, u in people.items()}


def _receipts_to_sort():
    """How many purchases read out of email are waiting to be put on a job --
    counted by Firestore, not by reading every one. Stored 'new' is To sort
    (stages.receipt_status); the server writes it on every receipt it makes."""
    q = _db().collection("receipts").where("status", "==", "new")
    try:
        return int(q.count().get()[0][0].value)
    except Exception as e:      # noqa: BLE001 -- a summary without the count beats none
        print("digest: could not count receipts:", e)
        return 0


def _cache(slot="morning", people=None):
    today = _now().date()
    jobs = _jobs()
    cache = {
        "items": _calendar_items(today, today + datetime.timedelta(days=1)),
        "storms": _storms(),
        "bids": _bids(jobs),
        "office": _office(jobs),
        "invoices": _invoice_reminders(jobs, today),
        "careOwed": _care_owed(jobs),
        "recurring": _recurring_overdue(today),
        "shifts": _shifts(),
        "receipts": _receipts_to_sort(),
    }
    if slot == "evening":
        people = people if people is not None else _people()
        cache["record"] = _day_record(today, people)
        cache["open"] = _open_tasks(people)
    # The end-of-day reports (endofday.py): the evening's for today, the
    # morning's for yesterday.
    try:
        import endofday
        cache["eod"] = endofday.for_summary(slot, today, people if people is not None else _people())
    except Exception as e:      # noqa: BLE001 -- a summary without them beats none
        print("digest: end of day not read:", e)
        cache["eod"] = None
    # The day the weather tables are for: tomorrow in the evening summary,
    # today otherwise. Every town and every job site in one forecast call.
    day = today + datetime.timedelta(days=1) if slot == "evening" else today
    key = _day(day)
    try:
        sites = job_sites(day, cache["items"], jobs)
    except Exception as e:      # noqa: BLE001
        print("digest: job sites failed:", e)
        sites = []
    with_point = [x for x in sites if x.get("point")]
    fc = forecast_points([(a[2], a[3]) for a in AREAS] + [x["point"] for x in with_point])
    cache["wxday"] = day
    cache["areas"] = [{"county": a[0], "name": a[1], "w": (fc[i] or {}).get(key) if fc[i] else None}
                      for i, a in enumerate(AREAS)]
    for i, x in enumerate(with_point):
        got = fc[len(AREAS) + i]
        x["w"] = got.get(key) if got else None
    cache["sites"] = sites
    cache["alerts"] = county_alerts()
    return cache


def run(slot, only_uid=None, dry=False):
    """Build and send `slot` for everyone with it switched on (or just one
    person). Returns what happened, per person, without the content."""
    if slot not in SLOTS:
        raise ValueError("unknown slot")
    people = _people()
    # Already sent today (kept in summaries/, _keep): Cloud Scheduler calls
    # again when a run is slow to answer, and that second call sent everybody
    # the same summary twice. A test send from the app is never held back.
    sent = set()
    if not only_uid and not dry:
        try:
            db, today = _db(), _now().date()
            ids = {_kept_id(uid, slot, today): uid for uid in people}
            if ids:
                sent = {ids[s.id] for s in db.get_all([db.collection("summaries").document(i) for i in ids])
                        if s.exists and s.id in ids}
        except Exception as e:          # noqa: BLE001 -- not knowing, everyone gets theirs
            print("digest: could not check which summaries went already:", e)
            sent = set()
    wx = weather()
    cache = _cache(slot, people)
    report = []
    for uid, u in people.items():
        if only_uid and uid != only_uid:
            continue
        if uid in sent:
            report.append({"uid": uid, "skipped": "already sent"})
            continue
        # Each person on their own. One odd record or setting used to raise
        # straight out of this loop, and everybody after that person got no
        # summary at all; now only that person's fails, and it is reported.
        try:
            p = _prefs(u)
            if not only_uid and not p.get(slot):
                continue
            # Not even as a test send: a crew member has no midday summary.
            if slot == "midday" and not _gets_midday(u):
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
        # A test send from the app (/digest/preview, one person) is not the
        # summary of record: kept, it replaced the real one on the Summaries
        # screen.
        if not only_uid:
            try:
                _keep(uid, slot, d)
                r["kept"] = True
            except Exception as e:          # noqa: BLE001 -- the email and push still go
                print("digest: summary not kept for", uid, e)
        if p.get("email") and u.get("email"):
            try:
                send_email(u["email"], d)
                r["email"] = "sent"
            except Exception as e:      # noqa: BLE001
                r["email"] = "failed: %s" % e
                print("digest: email failed for", uid, e)
        if p.get("push"):
            try:
                # A tap opens the summary itself in the app.
                r["push"] = send_push(uid, d, opens="summary")
            except Exception as e:      # noqa: BLE001
                r["push"] = "failed: %s" % e
                print("digest: push failed for", uid, e)
        report.append(r)
    return report
