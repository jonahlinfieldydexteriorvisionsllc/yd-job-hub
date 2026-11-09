"""Addresses no map can find, and the pins placed for them by hand.

Jonah (9 Nov 2026): "addresses being too new needs to give me a notification
to place a pin or something or notification to have you do it". A snow
account with no map point is not on the route at all, and a job's estimate
works its miles out to the middle of town. geo.py asks the Census, then Dane
County's own address points, then OpenStreetMap; what none of them knows (a
street newer than even the county's list, or an address outside Dane County)
comes here:

- run(): on the five-minute reminders run. A snow account with no point is
  looked up again once a day (a county or map update may know it by now) and
  filled in by itself when found. One that still isn't, and an open job whose
  address came back "not found", gets a card on his My to-dos and a push:
  "Place the pin" opens a map in the app; "Have Claude do it" sends the card
  to the wish board's Overnight column, where the night run looks it up on
  Google Maps and places it through the same door (/geo/pin). Told once per
  address: ticking the card off without a pin is his "leave it", and a
  changed address is a new question. A card closes itself once the record
  has its point, or no longer needs one -- never because a lookup couldn't
  be made. A card the night run hasn't placed by 7 the morning after comes
  back to his to-dos with a push, so a handed-off pin can't sit unseen.
  Pushes wait for 7 am to 9 pm.
- place(): a pin from the app or the night run: checked to be in Wisconsin
  and near the address's ZIP or town (a stray tap, or "I'm here now" from the
  wrong place, is asked about), written on the snow account or kept as the
  job's map point (digest.pin_job), and its card closed at once.
- read_link(): the spot in a Google Maps link pasted in, short links too.

Plain code, no Claude.
"""

import datetime
import hashlib
import re

import requests

import digest as dg

BOARD = "todo"
CLAUDE_BOARD = "wishes"
KINDS = ("snow", "job")
OPEN_STAGES = ("bid", "booked", "inprogress")
TRY_AGAIN_HOURS = 24
LOOKUPS_PER_RUN = 3                 # a slow map service must not hold up the run's later steps
PUSH_HOURS = (7, 21)                # Chicago time: a push made overnight waits for 7 am
# The night run (desktop routine nightly-wishes): midnight Chicago on these
# weekdays (Mon = 0), done by morning.
NIGHT_RUN_DAYS = (1, 2, 3, 4, 5)
NIGHT_RUN_DONE_HOURS = 7
# Anywhere in Wisconsin: a pin outside it is a slip of the finger or a paste
# of the wrong link, never a customer.
WI = (42.4, 47.4, -92.95, -86.2)


def card_id(kind, rid):
    return "pn" + kind[0] + hashlib.sha1(("%s:%s" % (kind, rid)).encode()).hexdigest()[:14]


def _stamp():
    return dg._now().isoformat()


def _local(t):
    return t.astimezone(dg.TZ)


def _board(db, bid):
    snap = db.collection("boards").document(bid).get()
    return (snap.to_dict() or {}) if snap.exists else None


def _first_column(board, wanted):
    cols = [c for c in (board.get("columns") or []) if c.get("id")]
    for c in cols:
        if str(c.get("name") or "").strip().lower() == wanted:
            return c["id"]
    return cols[0]["id"] if cols else None


def _done_column(board):
    import tidy
    return tidy._done_col(board)


def _one_line(street, city, zip_):
    tail = " ".join(x for x in ("WI", zip_) if x)
    return ", ".join(x for x in (street, city, tail) if x)


def _parse(s):
    try:
        t = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=datetime.timezone.utc)
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------ what needs one

def _snow_waiting(db, now, found, unread):
    """Snow accounts with no map point. Each is looked up again once a day
    (at most LOOKUPS_PER_RUN a run); one found is filled in (`found` lists it)
    and needs no card. One that couldn't be looked up this run goes in
    `unread`: neither carded nor closed until it is."""
    import geo
    out = {}
    left = LOOKUPS_PER_RUN
    for s in db.collection("snowAccounts").stream():
        a = s.to_dict() or {}
        street = str(a.get("street") or "").strip()
        if a.get("active") is False or a.get("lat") is not None or not (street or a.get("address")):
            continue
        cid = card_id("snow", s.id)
        city, zip_ = str(a.get("city") or a.get("town") or "").strip(), str(a.get("zip") or "").strip()
        address = str(a.get("address") or "").strip() or _one_line(street, city, zip_)
        key = address.lower()
        tried = db.collection("reminderLog").document("pintry_" + cid)
        t = tried.get().to_dict() or {}
        last = _parse(t.get("at")) if t.get("key") == key else None
        if street and (not last or now - last > datetime.timedelta(hours=TRY_AGAIN_HOURS)):
            if left <= 0:
                unread.add(cid)
                continue
            left -= 1
            try:
                hit = geo.find(street, city, a.get("state") or "WI", zip_)
            except Exception as e:      # noqa: BLE001 -- couldn't check: the next run tries again
                print("pins: %s not looked up: %s" % (s.id, e))
                unread.add(cid)
                continue
            tried.set({"key": key, "at": now.isoformat()})
            if hit:
                s.reference.update({"lat": hit["lat"], "lng": hit["lng"], "town": city or hit.get("town"),
                                    "geocodedAs": hit.get("matched") or address})
                found.append({"snow": s.id, "source": hit.get("source")})
                continue
        out[cid] = {"kind": "snow", "id": s.id, "name": str(a.get("name") or "A snow account"),
                    "address": address, "street": street, "city": city, "zip": zip_, "key": key}
    return out


def _job_waiting(db):
    """Open jobs whose address the maps said they don't know (jobGeo, kept by
    digest._job_geo for the estimate's miles and the day's job sites)."""
    import stages
    out = {}
    for g in db.collection("jobGeo").where("found", "==", False).stream():
        gd = g.to_dict() or {}
        snap = db.collection("jobs").document(g.id).get()
        if not snap.exists:
            continue
        j = snap.to_dict() or {}
        if j.get("removeWhy") or j.get("deletedAt") or stages.stage_of(j) not in OPEN_STAGES:
            continue
        key = dg.job_geo_key(j)
        if not key or gd.get("key") != key:
            continue                    # an older lookup: the address is looked up again when next used
        street, city, zip_ = (str(j.get(k) or "").strip() for k in ("address", "city", "zip"))
        out[card_id("job", g.id)] = {"kind": "job", "id": g.id, "name": str(j.get("customerName") or "A job").strip(),
                                     "address": _one_line(street, city, zip_), "street": street, "city": city,
                                     "zip": zip_, "key": key}
    return out


def _placed(db, pin):
    """Whether the record a closed-over card was about has its point now."""
    try:
        if pin.get("kind") == "snow":
            snap = db.collection("snowAccounts").document(str(pin.get("id") or "-")).get()
            return snap.exists and (snap.to_dict() or {}).get("lat") is not None
        snap = db.collection("jobGeo").document(str(pin.get("id") or "-")).get()
        return snap.exists and bool((snap.to_dict() or {}).get("found"))
    except Exception:                   # noqa: BLE001
        return False


# ------------------------------------------------------------------ the cards

def _notes(w):
    why = ("so this account isn't on the snow route yet" if w["kind"] == "snow"
           else "so the estimate's miles are worked out to the middle of town")
    return ("%s\n\nThe maps don't know this address yet (a brand-new street, or a typo), %s. Place the pin, "
            "or have Claude do it. This card closes by itself once the pin is in." % (w["address"], why))


def _open_pin_cards(db):
    """{card id: (board id, card)} for every open pin card on either board."""
    out = {}
    for bid in (BOARD, CLAUDE_BOARD):
        for c in db.collection("boards").document(bid).collection("cards").where("pinFor.kind", "in", list(KINDS)).stream():
            k = c.to_dict() or {}
            if not k.get("doneAt"):
                out[c.id] = (bid, k)
    return out


def close(db, cid, words):
    """Closes a pin card wherever it is (his to-dos or sent to Claude)."""
    stamp = _stamp()
    for bid in (BOARD, CLAUDE_BOARD):
        ref = db.collection("boards").document(bid).collection("cards").document(cid)
        snap = ref.get()
        k = (snap.to_dict() or {}) if snap.exists else None
        if k is None or k.get("doneAt"):
            continue
        done = _done_column(_board(db, bid) or {})
        if not done:
            continue
        ref.update({"column": done, "doneAt": stamp, "updatedAt": stamp, "updatedBy": "Job Hub",
                    "notes": (k.get("notes") or "") + "\n\n" + words})


def _make_card(db, board, cid, w):
    stamp = _stamp()
    col = _first_column(board, "today")
    db.collection("boards").document(BOARD).collection("cards").document(cid).set({
        "title": ("📍 Place the pin: " + w["name"])[:200], "notes": _notes(w),
        "checklist": [], "column": col, "order": int(dg._now().timestamp() * 1000),
        "due": _local(dg._now()).date().isoformat(), "dueTime": None, "remindMins": None, "hasReminder": False,
        "remindUids": [], "noReminder": False, "type": "todo", "urgency": "high", "labels": [], "color": None,
        "assignees": [], "jobId": w["id"] if w["kind"] == "job" else None, "jobName": w["name"], "jobNum": None,
        "noClaude": True, "doneAt": None, "createdAt": stamp, "createdBy": "Job Hub", "updatedAt": stamp,
        "updatedBy": "Job Hub",
        "pinFor": {k: w[k] for k in ("kind", "id", "name", "address", "street", "city", "zip", "key")}})


def _next_night_run_done(sent):
    """7 am the morning after the first night run following `sent`."""
    t = _local(sent)
    day = (t + datetime.timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    while day.weekday() not in NIGHT_RUN_DAYS:
        day += datetime.timedelta(days=1)
    return day + datetime.timedelta(hours=NIGHT_RUN_DONE_HOURS)


def _hand_back(db, board, now, cid, k):
    """A card the night run left: back on his to-dos, Today, with why."""
    stamp = now.isoformat()
    rec = dict(k)
    rec.pop("sentToClaudeAt", None)
    rec.update({"column": _first_column(board, "today"), "order": int(now.timestamp() * 1000), "doneAt": None,
                "noClaude": True, "updatedAt": stamp, "updatedBy": "Job Hub",
                "notes": (k.get("notes") or "") + "\n\nClaude didn't place it overnight (Google Maps may not know "
                         "it yet either, or the night run didn't run). Back to you."})
    db.collection("boards").document(BOARD).collection("cards").document(cid).set(rec)
    db.collection("boards").document(CLAUDE_BOARD).collection("cards").document(cid).delete()


# ------------------------------------------------------------ pushes

def _news(db, kind, cid, pin):
    """A push to send: now when it's daytime, else at 7 am (_send_news)."""
    db.collection("reminderLog").document("pinnews_%s_%s" % (kind, cid)).set({
        "pinTold": False, "pinKind": kind, "card": cid, "name": str(pin.get("name") or ""),
        "address": str(pin.get("address") or ""), "at": _stamp()})


def _send_news(db, people, now, still_open):
    h = _local(now).hour
    if not (PUSH_HOURS[0] <= h < PUSH_HOURS[1]):
        return []
    groups = {}
    for s in db.collection("reminderLog").where("pinTold", "==", False).stream():
        n = s.to_dict() or {}
        s.reference.update({"pinTold": True, "toldAt": now.isoformat()})
        # A new address already placed overnight needs no push.
        if n.get("pinKind") in ("new", "back") and n.get("card") not in still_open:
            continue
        groups.setdefault(n.get("pinKind"), []).append(n)
    sent = []
    for kind, items in groups.items():
        names = ", ".join(i["name"] for i in items)[:120]
        if kind == "new":
            title = "📍 An address isn't on the map" if len(items) == 1 else "📍 %d addresses aren't on the map" % len(items)
            body = ("%s, %s: place the pin, or have Claude do it." % (items[0]["name"], items[0]["address"]) if len(items) == 1
                    else names + ": place their pins, or have Claude do it.")
        elif kind == "claude":
            title, body = "📍 Claude placed the pin", names + (" is" if len(items) == 1 else " are") + " on the map now."
        else:
            title, body = "📍 Claude couldn't place the pin", names + ": back on your to-dos to place yourself."
        for uid, u in (people or {}).items():
            if u.get("role") != "owner":
                continue
            try:
                sent.append({"uid": uid, "pins": kind, "phones": dg.send_push(
                    uid, {"push": {"title": title[:110], "body": body[:160]}}, tag="yd-pins-" + kind, ttl=20 * 3600,
                    opens="pins")})
            except Exception as e:      # noqa: BLE001
                print("pins: push failed:", uid, e)
    return sent


def run(db, people, now=None):
    now = now or dg._now()
    found, unread = [], set()
    waiting = {}
    try:
        waiting.update(_snow_waiting(db, now, found, unread))
        waiting.update(_job_waiting(db))
    except Exception as e:              # noqa: BLE001
        print("pins: records not read:", e)
        return []                       # a short list must not close cards it simply didn't read
    board = _board(db, BOARD)
    open_cards = _open_pin_cards(db)
    for cid, (bid, k) in list(open_cards.items()):
        if cid in unread:
            continue                    # couldn't be looked up this run: left as it is
        w = waiting.get(cid)
        if w and w["key"] == ((k.get("pinFor") or {}).get("key")):
            # Sent to Claude and not placed by the morning after the night
            # run: back to him.
            sent = _parse(k.get("sentToClaudeAt") or k.get("createdAt"))
            if bid == CLAUDE_BOARD and board and sent and now > _next_night_run_done(sent):
                _hand_back(db, board, now, cid, k)
                open_cards[cid] = (BOARD, k)
                _news(db, "back", cid, w)
            continue
        if w:
            words = "the address changed"
        elif _placed(db, k.get("pinFor") or {}):
            words = "it's on the map now"
        else:
            words = "it no longer needs a pin"
        close(db, cid, "Closed by itself on %s: %s." % (_local(now).strftime("%d %b"), words))
        open_cards.pop(cid, None)
    if board:
        for cid, w in waiting.items():
            log = db.collection("reminderLog").document("pin_" + cid)
            snap = log.get()
            if snap.exists and (snap.to_dict() or {}).get("key") == w["key"]:
                continue                # told already: an open card, or one he ticked off to leave it
            _make_card(db, board, cid, w)
            log.set({"key": w["key"], "at": now.isoformat()})
            open_cards[cid] = (BOARD, {})
            _news(db, "new", cid, w)
    return found + _send_news(db, people, now, set(open_cards))


# ------------------------------------------------------------ a pin placed

def _name_of(db, uid):
    snap = db.collection("users").document(uid).get()
    return dg._name(snap.to_dict() if snap.exists else None)


def _too_far(lat, lng, city, zip_):
    """Miles from the middle of the address's ZIP or town, when that's over
    geo.FAR_MILES; None when near, or when the middle can't be found."""
    import geo
    try:
        mid = geo._middle(city, "WI", geo._five(zip_))
    except Exception as e:              # noqa: BLE001 -- can't check: not asked about
        print("pins: middle not found:", e)
        return None
    if not mid:
        return None
    far = geo._miles(lat, lng, mid[0], mid[1])
    return round(far) if far > geo.FAR_MILES else None


def place(db, uid, d):
    """{kind, id, lat, lng, sure?, by?} from the app or the night run ->
    {ok} or {error[, far]}."""
    kind = str(d.get("kind") or "")
    rid = re.sub(r"[^A-Za-z0-9_-]", "", str(d.get("id") or ""))[:120]
    try:
        lat, lng = float(d.get("lat")), float(d.get("lng"))
    except (TypeError, ValueError):
        return {"error": "No spot on the map was given"}
    if kind not in KINDS or not rid:
        return {"error": "Nothing to put the pin on"}
    if not (WI[0] <= lat <= WI[1] and WI[2] <= lng <= WI[3]):
        return {"error": "That spot isn't in Wisconsin. Check the pin."}
    lat, lng = round(lat, 6), round(lng, 6)
    claude = str(d.get("by") or "").lower() == "claude"
    who = "Claude, from Google Maps" if claude else _name_of(db, uid)
    day = _local(dg._now()).strftime("%d %b %Y")
    if kind == "snow":
        ref = db.collection("snowAccounts").document(rid)
        snap = ref.get()
        if not snap.exists:
            return {"error": "That snow account is gone"}
        rec = snap.to_dict() or {}
        city, zip_ = rec.get("city") or rec.get("town") or "", rec.get("zip") or ""
    else:
        snap = db.collection("jobs").document(rid).get()
        if not snap.exists:
            return {"error": "That job is gone"}
        rec = snap.to_dict() or {}
        city, zip_ = rec.get("city") or "", rec.get("zip") or ""
    if not d.get("sure"):
        far = _too_far(lat, lng, city, zip_)
        if far:
            return {"error": "That pin is %d miles from %s. Check it, or save it anyway." % (far, zip_ or city or "the address"),
                    "far": far}
    if kind == "snow":
        ref.update({"lat": lat, "lng": lng, "town": rec.get("city") or rec.get("town") or None,
                    "geocodedAs": "%s (pin placed by hand by %s, %s)" % (rec.get("address") or rec.get("street") or "", who, day),
                    "pinByHand": {"by": who, "uid": uid, "at": _stamp()}})
    else:
        try:
            dg.pin_job(rid, rec, lat, lng, who, db)
        except ValueError as e:
            return {"error": str(e)}
    cid = card_id(kind, rid)
    close(db, cid, "Pin placed by %s on %s." % (who, day))
    if claude:
        _news(db, "claude", cid, {"name": rec.get("name") or rec.get("customerName") or "", "address": rec.get("address") or ""})
    return {"ok": True, "lat": lat, "lng": lng}


# ---------------------------------------------------- a Google Maps link

COORDS = [
    re.compile(r"!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)"),          # a place page: the pin itself
    re.compile(r"[?&](?:q|query|ll|center|destination)=(-?\d{1,2}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)", re.I),
    re.compile(r"@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)"),               # where the map was looking
    re.compile(r"^\s*\(?(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)\)?\s*$"),
]
SHORT = re.compile(r"^https?://(maps\.app\.goo\.gl|goo\.gl/maps|g\.co/kgs)/", re.I)


def coords_in(text):
    """(lat, lng) from a Google Maps address or two numbers, or None."""
    t = str(text or "").strip()
    for rx in COORDS:
        m = rx.search(t)
        if m:
            return float(m.group(1)), float(m.group(2))
    return None


def read_link(text):
    """{lat, lng} or {error}. A short link (shared from the phone's Google
    Maps) is followed to where it goes, without opening the page."""
    t = str(text or "").strip()[:2000]
    got = coords_in(t)
    url = t
    hops = 0
    while not got and SHORT.match(url) and hops < 4:
        hops += 1
        try:
            r = requests.get(url, allow_redirects=False, timeout=10, headers={"User-Agent": dg.UA})
        except Exception as e:          # noqa: BLE001
            print("pins: link not followed:", e)
            return {"error": "That link couldn't be opened just now"}
        url = r.headers.get("Location") or ""
        got = coords_in(url)
    if not got:
        return {"error": "No spot found in that. Copy the link from Google Maps after dropping a pin, or type the two numbers."}
    lat, lng = got
    if not (WI[0] <= lat <= WI[1] and WI[2] <= lng <= WI[3]):
        return {"error": "That spot isn't in Wisconsin. Check the link."}
    return {"lat": lat, "lng": lng}
