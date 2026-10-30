"""Storm watch: a push when plowable snow is coming.

Jonah's routine 3 of 14 (wish card, 26 Oct 2026): "every 3 hours in snow
season it reads the forecast for the snow towns. When expected snow passes
the smallest trigger depth among the active accounts (or freezing rain is
forecast) it pushes ... and puts a "Start storm" card on Home and a short
pre-storm list."

Plain code, no Claude: it rides on the five-minute reminders run
(reminders.py), checks the forecast at most every CHECK_EVERY, and writes
what it found to settings/stormWatch, which Home reads (home.js
stormWatchHtml) for everyone who works here.

The forecast is read AT EACH ACCOUNT (its map point, rounded so neighbours
share one), from Open-Meteo in one call -- coordinates only, never an
address. An account is "in play" when the snow expected at its point in the
next LOOK_AHEAD_H hours reaches its own trigger depth (snow.js "Plow at"
inches, 1 when not set). The Weather Service's winter warnings for the two
counties ride along in the words.

One push per snowfall: a forecast that moves the start by a few hours is
the same snowfall (it overlaps the one told), and is told again only when
it grows by GROWS_BY inches or more accounts come into play. Between 10 pm
and 5 am it stays quiet unless the snow starts within IMMINENT_H hours --
then waking him is the point.
"""

import datetime
import time

import requests
from google.cloud import firestore

import digest as dg

STATE = ("settings", "stormWatch")
SEASON_MONTHS = (11, 12, 1, 2, 3, 4)       # November to April
CHECK_EVERY = datetime.timedelta(hours=3)
RETRY_AFTER = datetime.timedelta(minutes=30)   # a forecast that did not come back
LOOK_AHEAD_H = 48
SNOWY_HOUR_IN = 0.02        # an hour with less than this is not "snowing"
QUIET = (22, 5)             # 10 pm to 5 am, Chicago
IMMINENT_H = 8              # ... unless it starts within this many hours
GROWS_BY = 2.0              # inches more than last told: told again
MORE_ACCOUNTS = 3           # this many more accounts in play: told again
ICE_CODES = {56, 57, 66, 67}    # freezing drizzle / freezing rain (WMO)
WINTER_ALERTS = ("Blizzard", "Winter Storm", "Winter Weather", "Ice Storm", "Freezing Rain", "Freezing Drizzle",
                 "Snow Squall", "Heavy Snow", "Lake Effect Snow")
POINT_PLACES = 2            # map points rounded to 0.01 degree (~1 km): neighbours share one forecast


def in_season(now):
    return now.month in SEASON_MONTHS


def _iso(t):
    return t.isoformat() if t else None


def _parse(s):
    try:
        t = datetime.datetime.fromisoformat(str(s))
    except (TypeError, ValueError):
        return None
    return t if t.tzinfo else t.replace(tzinfo=dg.TZ)


def _claim(db, now, force):
    """True when this run is the one to check (none within CHECK_EVERY, or
    RETRY_AFTER after one whose forecast failed), and marks it taken in the
    same transaction -- two reminders runs overlapping never both push."""
    ref = db.collection(STATE[0]).document(STATE[1])

    @firestore.transactional
    def take(tx):
        snap = ref.get(transaction=tx)
        d = (snap.to_dict() or {}) if snap.exists else {}
        last = _parse(d.get("checkedAt"))
        wait = RETRY_AFTER if d.get("failed") else CHECK_EVERY
        # Two minutes' slack: the five-minute run should not slip a whole
        # run late every time.
        if not force and last and now - last < wait - datetime.timedelta(minutes=2):
            return None
        tx.set(ref, {"checkedAt": now.isoformat()}, merge=True)
        return d

    return take(db.transaction())


def _accounts(db):
    """Active snow accounts with a map point: {id: {trigger, lat, lng, name}}."""
    out = {}
    for s in db.collection("snowAccounts").stream():
        a = s.to_dict() or {}
        if a.get("active") is False:
            continue
        try:
            lat, lng = float(a.get("lat")), float(a.get("lng"))
        except (TypeError, ValueError):
            continue
        try:
            trigger = float(a.get("minTriggerInches") or 1)
        except (TypeError, ValueError):
            trigger = 1.0
        out[s.id] = {"trigger": max(0.5, trigger), "lat": lat, "lng": lng, "name": a.get("name") or ""}
    return out


def _point_of(a):
    return (round(a["lat"], POINT_PLACES), round(a["lng"], POINT_PLACES))


def forecast(points, now):
    """For each (lat, lng), the next LOOK_AHEAD_H hours: [{at, snow (inches),
    pop, code}], or None for a place that did not come back. One call."""
    if not points:
        return []
    try:
        r = requests.get("https://api.open-meteo.com/v1/forecast", timeout=25, params={
            "latitude": ",".join("%.4f" % p[0] for p in points),
            "longitude": ",".join("%.4f" % p[1] for p in points),
            "timezone": "America/Chicago", "forecast_days": 3,
            "hourly": "snowfall,precipitation_probability,weather_code",
        })
        j = r.json()
    except Exception as e:      # noqa: BLE001
        print("stormwatch: forecast failed:", e)
        return [None] * len(points)
    if isinstance(j, dict):
        if j.get("error"):
            print("stormwatch: forecast refused:", j.get("reason"))
            return [None] * len(points)
        j = [j]                 # one place comes back as an object, not a list
    start = now.replace(minute=0, second=0, microsecond=0)
    horizon = start + datetime.timedelta(hours=LOOK_AHEAD_H)
    out = []
    for loc in j:
        h = (loc or {}).get("hourly") or {}
        hours = []
        for t, sn, pop, code in zip(h.get("time") or [], h.get("snowfall") or [],
                                    h.get("precipitation_probability") or [], h.get("weather_code") or []):
            at = _parse(t)
            if at is None or at < start or at >= horizon:
                continue
            # Open-Meteo gives snowfall in cm; inches here, as everywhere.
            hours.append({"at": at, "snow": (sn or 0) / 2.54, "pop": pop or 0, "code": code})
        out.append(hours)
    while len(out) < len(points):
        out.append(None)
    return out


def _event(hours):
    """The snow and the ice at one place: total inches, first and last snowy
    hour, the chance, and when freezing rain is forecast."""
    snowy = [x for x in hours if x["snow"] >= SNOWY_HOUR_IN]
    ice = [x for x in hours if x["code"] in ICE_CODES]
    ev = {"inches": round(sum(x["snow"] for x in hours), 1), "start": None, "end": None, "pop": 0,
          "iceStart": ice[0]["at"] if ice else None, "iceEnd": ice[-1]["at"] + datetime.timedelta(hours=1) if ice else None}
    if snowy:
        ev["start"] = snowy[0]["at"]
        ev["end"] = snowy[-1]["at"] + datetime.timedelta(hours=1)
        ev["pop"] = max(x["pop"] for x in hours if ev["start"] <= x["at"] < ev["end"])
    return ev


def _winter_alerts():
    out = []
    for county, events in (dg.county_alerts() or {}).items():
        for e in events:
            if any(w in e for w in WINTER_ALERTS):
                out.append({"event": e, "county": county})
    return out


def _machines(db):
    """Machines with a problem to fix before they go out (Out of service,
    Before next use) -- the pre-storm list."""
    out = []
    for s in db.collection("equipment").stream():
        g = s.to_dict() or {}
        worst = None
        for i in g.get("issues") or []:
            # Fixed (stages.issue_status: doneAt wins). A part at the shop
            # is not fixed yet: the machine still cannot go out.
            if i.get("doneAt"):
                continue
            if i.get("urgency") in ("down", "before"):
                if worst is None or (i.get("urgency") == "down" and worst.get("urgency") != "down"):
                    worst = i
        if worst:
            out.append({"id": s.id, "name": g.get("name") or "Machine", "what": str(worst.get("what") or "")[:80],
                        "urgency": worst.get("urgency")})
    out.sort(key=lambda m: (m["urgency"] != "down", m["name"].lower()))
    return out


def outlook(accounts, hours_by_point, alerts, now):
    """What is coming, worked out from the forecast at each account. Plain
    data (no reads), so the tests can hand it anything."""
    total = len(accounts)
    in_play, starts, ends, inches, pops = [], [], [], [], []
    ice = None
    for aid, a in accounts.items():
        hours = hours_by_point.get(_point_of(a))
        if not hours:
            continue
        ev = _event(hours)
        if ev["iceStart"] and (ice is None or ev["iceStart"] < ice["start"]):
            ice = {"start": ev["iceStart"], "end": ev["iceEnd"]}
        if ev["start"] and ev["inches"] >= a["trigger"]:
            in_play.append(aid)
            starts.append(ev["start"])
            ends.append(ev["end"])
            inches.append(ev["inches"])
            pops.append(ev["pop"])
    triggers = [a["trigger"] for a in accounts.values()]
    o = {
        "at": now.isoformat(),
        "accounts": total, "inPlay": len(in_play), "inPlayIds": sorted(in_play),
        "smallestTrigger": min(triggers) if triggers else None,
        "inchesLo": min(inches) if inches else None, "inchesHi": max(inches) if inches else None,
        "start": _iso(min(starts)) if starts else None, "end": _iso(max(ends)) if ends else None,
        "pop": max(pops) if pops else None,
        "ice": bool(ice), "iceStart": _iso(ice["start"]) if ice else None, "iceEnd": _iso(ice["end"]) if ice else None,
        "alerts": alerts or [],
    }
    o["coming"] = bool(o["inPlay"] or o["ice"])
    return o


# ---------------------------------------------------------------- words

def _hour_words(t):
    h = t.hour % 12 or 12
    return "%d %s" % (h, "am" if t.hour < 12 else "pm")


def _day_words(t, now):
    d = (t.date() - now.date()).days
    if d == 0:
        return "tonight" if t.hour >= 18 else "today"
    if d == 1:
        return "tomorrow night" if t.hour >= 18 else "tomorrow"
    return t.strftime("%a")


def when_words(start, end, now):
    """"tomorrow 2 am to 8 am", "Thu 10 pm to Fri 6 am"."""
    if not start:
        return ""
    a = "%s %s" % (_day_words(start, now), _hour_words(start))
    if not end:
        return a
    # The last snowy hour ends at midnight or after: that is the next day's.
    if end.date() == start.date():
        return a + " to " + _hour_words(end)
    return a + " to %s %s" % (_day_words(end, now), _hour_words(end))


def _num(x):
    x = round(x * 2) / 2            # to the half inch
    return ("%d" % x) if x == int(x) else ("%.1f" % x)


def inches_words(lo, hi):
    if lo is None:
        return ""
    a, b = _num(lo), _num(hi)
    return ("about %s in" % a) if a == b else ("%s to %s in" % (a, b))


def words(o, machines, now):
    """The push: {title, body}."""
    start, end = _parse(o.get("start")), _parse(o.get("end"))
    bits = []
    if o["inPlay"]:
        title = "❄️ Plowable snow likely" + (" + 🧊 freezing rain" if o["ice"] else "")
        bits.append(when_words(start, end, now))
        bits.append(inches_words(o["inchesLo"], o["inchesHi"]))
        bits.append("%d of %d accounts in play" % (o["inPlay"], o["accounts"]))
        if o.get("pop"):
            bits.append("%d%% chance" % o["pop"])
    else:
        title = "🧊 Freezing rain likely — salt run"
        bits.append(when_words(_parse(o.get("iceStart")), _parse(o.get("iceEnd")), now))
    for al in o.get("alerts") or []:
        bits.append("%s (%s)" % (al["event"], al["county"]))
    if machines:
        names = ", ".join(m["name"] for m in machines[:3]) + (" +%d" % (len(machines) - 3) if len(machines) > 3 else "")
        bits.append("fix first: " + names)
    body = " · ".join(b for b in bits if b)
    return {"title": title, "body": body[:1].upper() + body[1:]}


# ---------------------------------------------------------------- telling

def _same_snowfall(o, told):
    """The snowfall already told about (overlapping it, or the freezing rain
    one when there is no snow) -- and not grown since."""
    if not told:
        return False
    s, e = _parse(o.get("start") or o.get("iceStart")), _parse(o.get("end") or o.get("iceEnd"))
    ts, te = _parse(told.get("start")), _parse(told.get("end"))
    if not (s and e and ts and te):
        return False
    overlaps = s <= te + datetime.timedelta(hours=3) and ts <= e + datetime.timedelta(hours=3)
    if not overlaps:
        return False
    grew = ((o.get("inchesHi") or 0) >= (told.get("inchesHi") or 0) + GROWS_BY
            or (o.get("inPlay") or 0) >= (told.get("inPlay") or 0) + MORE_ACCOUNTS
            or (o.get("ice") and not told.get("ice") and not o.get("inPlay")))
    return not grew


def quiet_now(o, now):
    """Night, and the snow (or ice) does not start within IMMINENT_H hours."""
    if not (now.hour >= QUIET[0] or now.hour < QUIET[1]):
        return False
    s = _parse(o.get("start") or o.get("iceStart"))
    return not (s and s - now <= datetime.timedelta(hours=IMMINENT_H))


def who_hears(people, prefs):
    """The owner and the admins unless they switched it off; a crew member
    only when they switched it on (notify.js 'When plowable snow is
    coming'). A stored True/False wins; None is the role's default."""
    out = []
    for uid, u in people.items():
        p = prefs.get(uid) or {}
        if p.get("push") is False:
            continue
        on = p.get("stormWatch")
        if on is None:
            on = u.get("role") in ("owner", "admin")
        if on:
            out.append(uid)
    return out


def _storm_open(db):
    for _ in db.collection("storms").where("status", "==", "open").limit(1).stream():
        return True
    return False


def run(db, people, prefs, now=None, force=False):
    """Called from the reminders run. Returns the pushes sent (for the log)."""
    now = now or dg._now()
    if not force and not in_season(now):
        return []
    was = _claim(db, now, force)
    if was is None:
        return []
    ref = db.collection(STATE[0]).document(STATE[1])
    accounts = _accounts(db)
    points = sorted({_point_of(a) for a in accounts.values()})
    got = forecast(points, now)
    if points and all(g is None for g in got):
        ref.set({"failed": True}, merge=True)
        return []
    hours_by_point = {p: g for p, g in zip(points, got) if g is not None}
    try:
        alerts = _winter_alerts()
    except Exception as e:      # noqa: BLE001 -- the forecast still counts without them
        print("stormwatch: alerts not read:", e)
        alerts = []
    o = outlook(accounts, hours_by_point, alerts, now)
    try:
        machines = _machines(db) if o["coming"] else []
    except Exception as e:      # noqa: BLE001
        print("stormwatch: machines not read:", e)
        machines = []
    o["machines"] = machines
    patch = {"failed": False, "outlook": o}
    sent = []
    told = was.get("told") or {}
    if o["coming"] and not _storm_open(db) and not _same_snowfall(o, told) and not quiet_now(o, now):
        note = {"push": words(o, machines, now)}
        for uid in who_hears(people, prefs):
            try:
                sent.append({"uid": uid, "stormWatch": True,
                             "phones": dg.send_push(uid, note, tag="yd-stormwatch", ttl=12 * 3600, opens="home")})
            except Exception as e:      # noqa: BLE001
                print("stormwatch: push failed for", uid, e)
        patch["told"] = {"at": now.isoformat(), "start": o.get("start") or o.get("iceStart"),
                         "end": o.get("end") or o.get("iceEnd"), "inchesHi": o.get("inchesHi"),
                         "inPlay": o.get("inPlay"), "ice": o.get("ice"), "words": note["push"]}
    patch["ranMs"] = int(time.time() * 1000)
    ref.set(patch, merge=True)
    return sent
