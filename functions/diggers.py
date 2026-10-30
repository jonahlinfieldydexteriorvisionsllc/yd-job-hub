"""Diggers Hotline tickets, read from email and kept with their jobs.

Jonah's routine 9 of 14 (wish card, 26 Oct 2026): "When a booked job has
digging work ... a to-do 'File Diggers ticket' dated 5 working days before
the first dig day ... Once the ticket number is typed on the job it shows
'good until' and reminds the day before it lapses." He files the tickets
himself (his account); Diggers Hotline emails each one -- "Diggers Hotline
Ticket <no>": ticket number, Start Date (clear to dig from), who it is
working for and the work address -- and later a "Positive Response" with
each utility's status. So nothing is typed: this reads them.

Every 30 minutes on the five-minute reminders run (reminders.py), plain code:
  - new emails from Diggers Hotline (Gmail, read only) -> digTickets/{no}:
    {no, start, called, duration, type, previous, workFor, address, place,
    jobId, jobBy 'address'|'name'|'hand', msgId, at} and, from a Positive
    Response, response {at, done, waiting, waitingNames[], allDone}. A
    ticket goes on the job with the same house number and street, else the
    one booked job of the same name; else it waits for him to pick
    (digging.js). A job picked by hand is never changed here.
  - the owner told once when every utility has answered (clear to dig), or
    when the start time came with some still not marked.
Once a day after 7 am: the ticket's clock. Wisconsin's rule as the card has
it: work begins within 10 days of the start date and is not interrupted for
more than 10 days, else a new ticket. Written as clock {lastWork, lapseOn,
lapsed, at}; the owner told the day before it lapses.
"""

import datetime
import re

import digest as dg

STATE = ("settings", "digTickets")
SCAN_EVERY = datetime.timedelta(minutes=30)
FIRST_LOOK_DAYS = 60
LOOK_DAYS = 21
SEEN_MAX = 400
FROM_HOUR = 7
GRACE_DAYS = 10            # begin within, and no break longer than
TELL_WITHIN_MS = 2 * 86400 * 1000   # a Positive Response older than this is not pushed
ADDR_WORD_SKIP = {"n", "s", "e", "w", "north", "south", "east", "west", "st", "rd", "ave", "dr", "ln", "ct", "way",
                  "blvd", "cir", "pl", "trl", "hwy", "road", "street", "avenue", "drive", "lane", "court", "circle"}
DONE = ("Marked - Complete", "No Conflict - Complete", "System Cleared - Complete")
WAITING = ("Ongoing - Working with Excavator", "Not Marked - Delay", "Not Marked - Response Pending", "No Response",
           "Not Participating")


def _flat(text):
    """One line: table bars and runs of space gone, so a label is followed
    by its value however the email laid its table out."""
    return re.sub(r"\s+", " ", str(text or "").replace("|", " ")).strip()


def _date(m, d, y, hh=None, mm=None, ap=None):
    y = int(y)
    if y < 100:
        y += 2000
    if hh is None:
        return "%04d-%02d-%02d" % (y, int(m), int(d))
    h = int(hh) % 12 + (12 if str(ap).upper() == "PM" else 0)
    return "%04d-%02d-%02dT%02d:%02d" % (y, int(m), int(d), h, int(mm))


def parse_ticket(text):
    """The locate request confirmation -> its fields, or None."""
    t = _flat(text)
    no = re.search(r"Ticket #\s*:\s*(\d{6,})", t)
    st = re.search(r"Start Date\s*:\s*(\d{1,2})/(\d{1,2})/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)", t, re.I)
    if not no or not st:
        return None
    out = {"no": no.group(1), "start": _date(*st.groups())}
    m = re.search(r"Call Date\s*:\s*(\d{1,2})/(\d{1,2})/(\d{2,4})", t)
    if m:
        out["called"] = _date(*m.groups())
    m = re.search(r"Previous Ticket\s*:\s*(\d{6,})", t)
    out["previous"] = m.group(1) if m else None
    m = re.search(r"Ticket Type\s*:\s*([A-Za-z][A-Za-z -]*?)\s+(?=Start Date)", t)
    out["type"] = m.group(1).strip() if m else ""
    m = re.search(r"Working For\s*:\s*(.+?)\s+(?=Email\s*:|Field Rep\s*:|Work Information)", t)
    out["workFor"] = m.group(1).strip()[:120] if m else ""
    work = t.split("Work Information", 1)[1] if "Work Information" in t else t
    m = re.search(r"Duration\s*:\s*(\d+)\s*day", work, re.I)
    out["duration"] = int(m.group(1)) if m else None
    m = re.search(r"Place\s*:\s*(.+?)\s+(?=Duration\s*:|Address\s*:)", work)
    out["place"] = m.group(1).strip().title()[:60] if m else ""
    num = re.search(r"Address\s*:\s*([0-9A-Za-z]+)\s+(?=Street\s*:)", work)
    street = re.search(r"Street\s*:\s*(.+?)\s+(?=Intersection|On the |Type of Work|Explosives|$)", work)
    out["address"] = " ".join(x for x in ((num.group(1) if num else ""), (street.group(1).strip() if street else "")) if x)[:120]
    m = re.search(r"Type of Work\s*:\s*(.+?)\s+(?=Explosives|Overhead|Marking Instructions|$)", work)
    out["work"] = m.group(1).strip().title()[:60] if m else ""
    return out


def parse_response(text):
    """The Positive Response -> {no, done, waiting, waitingNames, allDone}, or None."""
    t = _flat(text)
    no = re.search(r"Ticket Number\s*:\s*(\d{6,})", t)
    if not no:
        return None
    # The space at the end: a row is closed by the space after it, so in an
    # email with no "Status Explanations" part the LAST utility was dropped
    # -- a trailing one still waiting could read as all clear to dig.
    body = t.split("Status Explanations", 1)[0] + " "
    statuses = "|".join(re.escape(s) for s in DONE + WAITING)
    rows = re.findall(r"(" + statuses + r")\s+([A-Z0-9]{3,6})\s+(.+?)\s+(?=\(\d{3}\)|" + statuses + r"|$)", body)
    done, waiting, names, seen = 0, 0, [], set()
    for status, code, rest in rows:
        key = (code, rest)
        if key in seen:
            continue
        seen.add(key)
        if status in DONE:
            done += 1
        else:
            waiting += 1
            name = re.sub(r"\s+" + re.escape(code) + r"\b", "", rest).strip()
            if name not in names:
                names.append(name[:60] + " (" + status.split(" - ")[0].lower() + ")")
    if not rows:
        return None
    return {"no": no.group(1), "done": done, "waiting": waiting, "waitingNames": names[:8], "allDone": waiting == 0}


# ---------------------------------------------------------------- matching

def _addr_key(s):
    """(house number, first street word): '123 maple ridge rd' -> ('123', 'maple')."""
    words = re.findall(r"[a-z0-9]+", str(s or "").lower())
    if not words or not re.match(r"^[0-9]+[a-z]?$", words[0]):
        return None
    rest = [w for w in words[1:] if w not in ADDR_WORD_SKIP]
    return (words[0], rest[0]) if rest else None


LIVE = ("booked", "inprogress", "in progress", "complete", "completed", "quoting")


def match_job(tk, jobs):
    """(jobId, how) for the ticket, or (None, None)."""
    key = _addr_key(tk.get("address"))
    if key:
        hits = [jid for jid, j in jobs.items() if not j.get("deletedAt") and not j.get("removeWhy")
                and _addr_key(j.get("address")) == key]
        booked = [jid for jid in hits if str(jobs[jid].get("jobStatus") or "").lower() in ("booked", "inprogress", "in progress")]
        if len(booked) == 1:
            return booked[0], "address"
        if len(hits) == 1:
            return hits[0], "address"
    name = str(tk.get("workFor") or "").strip().lower()
    if name:
        hits = [jid for jid, j in jobs.items() if not j.get("deletedAt") and not j.get("removeWhy")
                and str(j.get("jobStatus") or "").lower() in ("booked", "inprogress", "in progress")
                and str(j.get("customerName") or "").strip().lower() == name]
        if len(hits) == 1:
            return hits[0], "name"
    return None, None


# ---------------------------------------------------------------- the scan

def _claim(db, now):
    from google.cloud import firestore
    ref = db.collection(STATE[0]).document(STATE[1])

    @firestore.transactional
    def take(tx):
        snap = ref.get(transaction=tx)
        d = (snap.to_dict() or {}) if snap.exists else {}
        try:
            last = datetime.datetime.fromisoformat(str(d.get("scannedAt")))
        except (TypeError, ValueError):
            last = None
        if last and now - last < SCAN_EVERY - datetime.timedelta(minutes=2):
            return None
        tx.set(ref, {"scannedAt": now.isoformat()}, merge=True)
        return d

    return take(db.transaction())


def _when(iso):
    try:
        t = datetime.datetime.fromisoformat(iso)
    except (TypeError, ValueError):
        return iso or ""
    h = t.hour % 12 or 12
    return "%s %d %s" % (t.strftime("%a %b ") + str(t.day), h, "am" if t.hour < 12 else "pm")


def _told_kind(resp):
    """What the owner was told about a ticket's answers: 'clear', 'waiting'
    or ''. (Before toldKind, `told` alone was kept: with every utility
    answered then, it was the clear.)"""
    resp = resp or {}
    if resp.get("toldKind"):
        return resp["toldKind"]
    if resp.get("told"):
        return "clear" if resp.get("allDone") else "waiting"
    return ""


def _started(iso, now):
    """The ticket's start time (clear to dig from) has come."""
    try:
        t = datetime.datetime.fromisoformat(str(iso))
    except (TypeError, ValueError):
        return False
    if not t.tzinfo:
        t = t.replace(tzinfo=dg.TZ)
    return now >= t


def _tell_not_marked(people, who, resp):
    return _tell_owner(people, "⚠️ Not all marked: %s" % who,
                       "Diggers ticket %s — still waiting on %s. Call them, or file a No-Show Relocate." % (
                           resp.get("no") or "", ", ".join(resp.get("waitingNames") or []) or "some utilities"))


def _tell_owner(people, title, body):
    out = []
    for uid, u in people.items():
        if u.get("role") != "owner":
            continue
        try:
            out.append({"uid": uid, "diggers": title,
                        "phones": dg.send_push(uid, {"push": {"title": title[:110], "body": body[:180]}},
                                               tag="yd-diggers", ttl=12 * 3600, opens="home")})
        except Exception as e:      # noqa: BLE001
            print("diggers: push failed:", uid, e)
    return out


def scan(db, people, now=None):
    """Read new Diggers Hotline emails (every SCAN_EVERY)."""
    import receipts
    now = now or dg._now()
    was = _claim(db, now)
    if was is None:
        return []
    seen = list(was.get("seen") or [])
    days = LOOK_DAYS if was.get("seen") is not None else FIRST_LOOK_DAYS
    try:
        ids = receipts._list_ids("from:diggershotline.com newer_than:%dd" % days)
    except Exception as e:      # noqa: BLE001
        print("diggers: gmail not read:", e)
        return []
    fresh = [mid for mid in ids if mid not in seen]
    if not fresh:
        if was.get("seen") is None:
            db.collection(STATE[0]).document(STATE[1]).set({"seen": []}, merge=True)
        return []
    jobs = dg._jobs()
    sent = []
    # Oldest first: a ticket's confirmation before its Positive Response.
    msgs = []
    for mid in fresh:
        try:
            msgs.append(receipts._fetch(mid))
        except Exception as e:      # noqa: BLE001
            print("diggers: message not read:", mid, e)
    msgs.sort(key=lambda m: m.get("internalDate") or 0)
    for m in msgs:
        seen.append(m["id"])
        subject = m.get("subject") or ""
        text = m.get("text") or ""
        if "positive response" in subject.lower():
            r = parse_response(text)
            if not r:
                continue
            ref = db.collection("digTickets").document(r["no"])
            snap = ref.get()
            tk = (snap.to_dict() or {}) if snap.exists else {}
            before = tk.get("response") or {}
            ref.set({"no": r["no"], "response": dict(r, at=now.isoformat())}, merge=True)
            # Only news is told: the first look reads two months back. Clear to
            # dig once every utility has answered; "not all marked" only once
            # the start time has come (an answer still coming before then is
            # normal -- daily() tells it on the morning it starts).
            recent = now.timestamp() * 1000 - float(m.get("internalDate") or 0) < TELL_WITHIN_MS
            told = _told_kind(before)
            if tk.get("jobId") and recent:
                job = jobs.get(tk["jobId"]) or {}
                who = job.get("customerName") or tk.get("workFor") or "a job"
                if r["allDone"] and told != "clear":
                    sent += _tell_owner(people, "✅ Clear to dig: %s" % who,
                                        "Diggers ticket %s — every utility has answered. Clear from %s." % (
                                            r["no"], _when(tk.get("start"))))
                    ref.set({"response": {"told": now.isoformat(), "toldKind": "clear"}}, merge=True)
                elif not r["allDone"] and not told and _started(tk.get("start"), now):
                    sent += _tell_not_marked(people, who, r)
                    ref.set({"response": {"told": now.isoformat(), "toldKind": "waiting"}}, merge=True)
            continue
        tk = parse_ticket(text)
        if not tk:
            continue
        ref = db.collection("digTickets").document(tk["no"])
        snap = ref.get()
        cur = (snap.to_dict() or {}) if snap.exists else {}
        patch = dict(tk, msgId=m["id"], at=now.isoformat())
        if cur.get("jobBy") != "hand":
            jid, how = match_job(tk, jobs)
            patch["jobId"], patch["jobBy"] = jid, how
        ref.set(patch, merge=True)
    db.collection(STATE[0]).document(STATE[1]).set({"seen": seen[-SEEN_MAX:]}, merge=True)
    return sent


# ---------------------------------------------------------------- the clock

def _day(s):
    try:
        return datetime.date.fromisoformat(str(s)[:10])
    except (TypeError, ValueError):
        return None


def daily(db, people, now=None):
    """Once a day after 7 am: each recent ticket's lapse day, and the owner
    told the day before."""
    from google.api_core.exceptions import AlreadyExists
    now = now or dg._now()
    if now.hour < FROM_HOUR:
        return []
    today = now.date()
    try:
        db.collection("reminderLog").document("diggers_" + today.isoformat()).create({"at": now.isoformat()})
    except AlreadyExists:
        return []
    jobs = dg._jobs()
    sent, told = [], set()
    for s in db.collection("digTickets").stream():
        tk = s.to_dict() or {}
        start = _day(tk.get("start"))
        job = jobs.get(tk.get("jobId")) if tk.get("jobId") else None
        if not start or not job or (today - start).days > 120:
            continue
        if str(job.get("jobStatus") or "").lower() in ("complete", "completed"):
            continue
        # The start time has come with a utility still not marked (scan tells
        # the clear the moment it comes; this is the other half).
        resp = tk.get("response") or {}
        if resp and not resp.get("allDone") and not _told_kind(resp) and _started(tk.get("start"), now) \
                and (today - start).days <= 3:
            who = job.get("customerName") or tk.get("workFor") or "a job"
            sent += _tell_not_marked(people, who, dict(resp, no=tk.get("no") or s.id))
            s.reference.set({"response": {"told": now.isoformat(), "toldKind": "waiting"}}, merge=True)
        days = []
        for e in db.collection("timeEntries").where("targetId", "==", tk["jobId"]).stream():
            x = e.to_dict() or {}
            if x.get("kind") != "job" or x.get("status") == "rejected":
                continue
            try:
                d = datetime.datetime.fromtimestamp(float(x.get("startedMs")) / 1000.0, dg.TZ).date()
            except (TypeError, ValueError):
                continue
            if d >= start:
                days.append(d)
        last = max(days) if days else None
        lapse = (last or start) + datetime.timedelta(days=GRACE_DAYS)
        clock = {"lastWork": last.isoformat() if last else None, "lapseOn": lapse.isoformat(), "lapsed": today > lapse}
        was = tk.get("clock") or {}
        if any(was.get(k) != v for k, v in clock.items()):
            s.reference.set({"clock": dict(clock, at=now.isoformat())}, merge=True)
        # A newer ticket for the same job takes over.
        newer = [t for t in db.collection("digTickets").where("jobId", "==", tk["jobId"]).stream()
                 if (_day((t.to_dict() or {}).get("start")) or start) > start]
        if newer:
            continue
        if (lapse - today).days == 1 and tk["jobId"] not in told:
            told.add(tk["jobId"])     # two tickets for one job: one push
            who = job.get("customerName") or tk.get("workFor") or "a job"
            body = ("No work since %s — " % last.strftime("%a %b %d") if last else "Work has not started — ") + \
                "Diggers ticket %s lapses after tomorrow. Start, or file a new one." % tk["no"]
            sent += _tell_owner(people, "\U0001F6A7 Diggers ticket lapsing: %s" % who, body)
    return sent
