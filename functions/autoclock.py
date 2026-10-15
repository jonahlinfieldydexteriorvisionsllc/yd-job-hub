"""YD Job Hub -- the clock stops a shift nobody clocked out of.

Jonah (14 Oct 2026): "automatically clock people out once they hit 16 hours
without clocking out."

It is done here, on the server, by the five-minute reminders run
(reminders.run), and not on the phone: the shift that needs stopping is
nearly always on a phone that is off, flat, or in a truck with no signal.

A shift still running (status 'running') AUTO_OUT hours after it started is
ended AT that moment -- start + the limit, never "now", so a run that comes
late or a server that was down for an hour adds nothing to anybody's pay --
and goes to the office exactly the way a shift over eight hours does: status
'pending', with its end, its pauses closed, and these marks of its own:

    endedFor 'auto', autoEnded True, autoEndedMs (the end it was given),
    autoEndedAt (when the server did it), autoLimitHours, autoTold

The app shows it as stopped by the clock while its end is still autoEndedMs
(timeclock.js autoStopped). The person's own clock-out, made on a phone with
no signal BEFORE the limit and sent once the signal came back, is earlier and
replaces that end (firestore.rules lets only an earlier end through, never a
later one and never back to running); the office can change the times too.

The person and the owner are told by phone, once: autoTold is set False with
the stop and True once told, and reminderLog/autoout_<shift> settles two runs
at once (and a run that stopped a shift but died before telling: the next
run finds it by autoTold and tells it then).

How many hours: settings/public.clock.autoOutHours (the owner's, Your Crew),
16 when it is not set or not a sensible number.

STORMS (Jonah, 14 Oct 2026: "I want no limit for storms. But auto clock out
when last property is completed."): a shift on a storm never stops by the
hour. It stops when the storm's work is done -- every property departed or
skipped -- at the last departure (or, for a storm closed or abandoned before
that, when it was closed). Same marks, with autoReason 'storm'; the status is
what clocking out then would give (over eight hours: the office checks it).
Only the person is told. The phones on the storm do the same the moment they
see the last departure (timeclock.js YDClock.stormDone); this catches the
phones that are off.
"""

import datetime

from google.api_core.exceptions import AlreadyExists
from firebase_admin import firestore

import digest as dg

DEFAULT_HOURS = 16
MIN_HOURS, MAX_HOURS = 8, 24
HOUR_MS = 3600 * 1000
LONG_SHIFT_MS = 8 * HOUR_MS        # past this the office checks a shift (timeclock.js needsReview)
OVERHEAD = {"snow": "Snow", "labor": "Labor", "receipts": "Receipts"}


def limit_hours(db):
    """The owner's number of hours, or 16."""
    try:
        snap = db.collection("settings").document("public").get()
        clock = ((snap.to_dict() or {}).get("clock") or {}) if snap.exists else {}
        h = clock.get("autoOutHours") if isinstance(clock, dict) else None
    except Exception as err:          # noqa: BLE001 -- the usual 16 rather than no stop at all
        print("autoclock: setting not read:", err)
        h = None
    if isinstance(h, bool) or not isinstance(h, (int, float)) or not MIN_HOURS <= h <= MAX_HOURS:
        return DEFAULT_HOURS
    return h


def iso_ms(ms):
    """Milliseconds as the app writes a time (JavaScript toISOString):
    2026-10-14T03:02:00.000Z. The app compares and sorts these as text."""
    ms = int(ms)
    t = datetime.datetime.fromtimestamp(ms // 1000, datetime.timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (ms % 1000)


def _ms(iso):
    try:
        t = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=datetime.timezone.utc)
    return int(t.timestamp() * 1000)


def start_ms(e):
    """When a shift started, as the app works it out (startMsOf)."""
    s = e.get("startedMs")
    if isinstance(s, (int, float)) and not isinstance(s, bool) and s > 0:
        return int(s)
    return _ms(e.get("startedAt")) if e.get("startedAt") else None


def stop_patch(e, hours, now_ms, storm_end=None):
    """What stopping this shift writes, or None when it is not one to stop:
    no longer running (clocked out meanwhile, or already stopped), no start
    to go by, or not yet past the limit. A storm shift has no limit: it stops
    only at `storm_end`, the moment its storm's work was done."""
    if e.get("status") != "running" or e.get("endedAt") or e.get("endedMs") is not None:
        return None
    start = start_ms(e)
    if not start:
        return None
    storm = e.get("kind") == "storm"
    if storm:
        # Clocked in after the last property (cleanup, the drive back): left
        # running, for the storm's closing -- or their own clock-out -- to end.
        if storm_end is None or storm_end <= start:
            return None
        end = int(storm_end)
    else:
        end = start + int(round(hours * HOUR_MS))
    if now_ms < end:
        return None
    # An open pause ends with the shift (as clocking out does), at the stop
    # -- or where it began, for one started after it, so it counts nothing.
    pauses = []
    for p in e.get("pauses") or []:
        if not isinstance(p, dict):
            continue
        p = dict(p)
        if not p.get("endedAt"):
            began = _ms(p.get("startedAt")) or end
            p["endedAt"] = iso_ms(max(end, began))
        pauses.append(p)
    if storm:
        # The storm is done: the status clocking out then would have given.
        status = "pending" if (e.get("source") == "manual" or end - start > LONG_SHIFT_MS) else "ok"
    else:
        # Over the limit, so the office checks it -- the same as clocking
        # out a long shift (timeclock.js needsReview).
        status = "pending"
    return {
        "endedAt": iso_ms(end), "endedMs": end,
        "status": status,
        "pauses": pauses,
        "endedFor": "auto",
        "autoEnded": True, "autoEndedMs": end, "autoEndedAt": iso_ms(now_ms),
        "autoLimitHours": None if storm else hours, "autoReason": "storm" if storm else "hours",
        "autoTold": False,
    }


def _stop(db, ref, hours, now_ms, storm_end=None):
    """Stops one shift in a transaction: read again, and written only if it
    is still running. A clock-out landing from the phone at the same moment
    wins, and is never overwritten."""

    @firestore.transactional
    def take(tx):
        snap = ref.get(transaction=tx)
        if not snap.exists:
            return None
        patch = stop_patch(snap.to_dict() or {}, hours, now_ms, storm_end)
        if patch:
            tx.update(ref, patch)
        return patch

    return take(db.transaction())


def storm_done_ms(storm, stops):
    """When a storm's work was done, in ms, or None while it is still going:
    every property departed or skipped (at least one departed) -> the last
    departure; closed or abandoned before that -> when it was closed (or the
    last departure, if there was one)."""
    last = None
    for st in stops:
        t = _ms(st.get("departedAt")) if st.get("departedAt") else None
        if t and (last is None or t > last):
            last = t
    if stops and last and all(st.get("departedAt") or st.get("skipped") for st in stops):
        return last
    if (storm or {}).get("status") in ("closed", "abandoned"):
        return last or (_ms(storm.get("closedAt")) if storm.get("closedAt") else None)
    return None


def _storm_ends(db, running):
    """{storm id: when its work was done} for the storms someone is still
    clocked in to, read once each."""
    out = {}
    ids = set()
    for s in running:
        e = s.to_dict() or {}
        if e.get("kind") == "storm" and e.get("targetId"):
            ids.add(str(e.get("targetId")))
    for sid in ids:
        if "/" in sid:
            continue
        try:
            ref = db.collection("storms").document(sid)
            snap = ref.get()
            storm = (snap.to_dict() or {}) if snap.exists else {"status": "abandoned"}
            stops = [x.to_dict() or {} for x in ref.collection("stops").stream()]
            out[sid] = storm_done_ms(storm, stops)
        except Exception as err:      # noqa: BLE001 -- that storm waits for the next run
            print("autoclock: storm not read:", sid, err)
    return out


def _when(ms):
    t = datetime.datetime.fromtimestamp(int(ms) / 1000, dg.TZ)
    return dg._fmt_time(t.strftime("%H:%M")) + " " + t.strftime("%a")


def _place(e):
    return str(e.get("targetName") or OVERHEAD.get(e.get("kind")) or "work")[:60]


def tell(db, people, now):
    """Every stopped shift nobody has been told about: the person, and the
    owner, by phone. Once each (reminderLog/autoout_<shift>)."""
    out = []
    try:
        waiting = list(db.collection("timeEntries").where("autoTold", "==", False).stream())
    except Exception as err:          # noqa: BLE001
        print("autoclock: stopped shifts not read:", err)
        return out
    owners = [uid for uid, u in people.items() if u.get("role") == "owner"]
    for s in waiting:
        e = s.to_dict() or {}
        # Their own clock-out got here first after all (an earlier end, from
        # a phone that had no signal): nothing to tell.
        if e.get("endedMs") != e.get("autoEndedMs"):
            fresh = False
        else:
            try:
                db.collection("reminderLog").document("autoout_" + s.id).create(
                    {"entry": s.id, "uid": e.get("uid"), "at": now.isoformat()})
                fresh = True
            except AlreadyExists:
                fresh = False             # an overlapping run told it
        if fresh:
            start, end = start_ms(e), e.get("autoEndedMs") or e.get("endedMs")
            hours = e.get("autoLimitHours") or DEFAULT_HOURS
            hrs = ("%g" % hours) + " hours"
            place = _place(e)
            if start and end:
                worker = people.get(e.get("uid"))
                name = ((dg._name(worker) if worker else str(e.get("workerName") or "")).split() or ["Someone"])[0]
                notes = []
                if e.get("autoReason") == "storm":
                    if worker:
                        notes.append((e.get("uid"), {"push": {
                            "title": "❄️ Storm done — you're clocked out",
                            "body": "The last property was finished at %s, so your storm shift ended then (in at %s). "
                                    "Still working? Clock in again." % (_when(end), _when(start))}}))
                elif worker:
                    notes.append((e.get("uid"), {"push": {
                        "title": "⏱ You were clocked out automatically",
                        "body": "%s, in at %s: nobody clocked out for %s, so the clock stopped it at %s. "
                                "Stopped earlier? Ask for a change on My hours." % (place, _when(start), hrs, _when(end))}}))
                for uid in ([] if e.get("autoReason") == "storm" else owners):
                    if uid == e.get("uid"):
                        continue          # the owner's own shift: told once, above
                    notes.append((uid, {"push": {
                        "title": "⏱ %s was clocked out automatically" % name,
                        "body": "%s, in at %s: no clock-out after %s, so it stopped at %s. "
                                "It's waiting for you on the Clock tab." % (place, _when(start), hrs, _when(end))}}))
                for uid, note in notes:
                    try:
                        out.append({"uid": uid, "entry": s.id, "phones": dg.send_push(
                            uid, note, tag="yd-autoout-" + s.id, ttl=24 * 3600, opens="clock")})
                    except Exception as err:      # noqa: BLE001
                        print("autoclock: push failed:", uid, s.id, err)
        try:
            s.reference.update({"autoTold": True})
        except Exception as err:      # noqa: BLE001
            print("autoclock: not marked told:", s.id, err)
    return out


def run(db=None, people=None, now=None):
    """Stop every shift past the limit, then tell. Returns what it did."""
    db = db or dg._db()
    now = now or dg._now()
    people = people if people is not None else dg._people()
    hours = limit_hours(db)
    now_ms = int(now.timestamp() * 1000)
    stopped = []
    try:
        # Only the shifts on the clock right now -- a handful at most -- on
        # one field, so no index has to be made for it.
        running = list(db.collection("timeEntries").where("status", "==", "running").stream())
    except Exception as err:          # noqa: BLE001
        print("autoclock: running shifts not read:", err)
        running = []
    storm_ends = _storm_ends(db, running)
    for s in running:
        e = s.to_dict() or {}
        storm_end = storm_ends.get(str(e.get("targetId") or "")) if e.get("kind") == "storm" else None
        # Looked at without a transaction first: nearly every running shift
        # is nowhere near the limit, and only one that is gets the careful write.
        if not stop_patch(e, hours, now_ms, storm_end):
            continue
        try:
            if _stop(db, s.reference, hours, now_ms, storm_end):
                stopped.append(s.id)
                print("autoclock: stopped", s.id, "storm done" if storm_end else "at %s hours" % hours)
        except Exception as err:      # noqa: BLE001 -- the next one, and the next run, still go
            print("autoclock: not stopped:", s.id, err)
    return {"hours": hours, "stopped": stopped, "told": tell(db, people, now)}
