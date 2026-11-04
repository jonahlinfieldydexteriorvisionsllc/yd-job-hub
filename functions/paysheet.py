"""The pay sheet's push: on a pay day, by 6 pm, to the owner only.

Jonah (3 Nov 2026): "i usally pay every other friday through cashapp and bank
payments. i am the only one who gets the sheet i need it by 6:00pm on
friday." The sheet itself is worked out in the app when it is opened
(paysheet.js), from the same sums as Hours & Wages. This says it is ready and
whether shifts are still waiting for his OK, on the five-minute reminders run.

settings/paySheet.first is a pay day; every EVERY_DAYS from it is one (FIRST and
EVERY_DAYS are paysheet.js's too). One push a pay day (reminderLog paysheet_<day>).
"""
import datetime

from google.api_core.exceptions import AlreadyExists

import digest as dg

FIRST = "2026-11-06"
EVERY_DAYS = 14
AT = (17, 30)           # after the crew are off, ahead of his 6 pm


def is_pay_day(conf, day):
    try:
        first = datetime.date.fromisoformat(str((conf or {}).get("first") or FIRST))
    except ValueError:
        first = datetime.date.fromisoformat(FIRST)
    return (day - first).days % EVERY_DAYS == 0


def _bounds_ms(day):
    end = datetime.datetime(day.year, day.month, day.day, tzinfo=dg.TZ) + datetime.timedelta(days=1)
    start = end - datetime.timedelta(days=EVERY_DAYS)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def words_for(day, entries):
    """The push's line: what stands between him and paying."""
    a, b = _bounds_ms(day)
    inside = [e for e in entries if isinstance(e.get("startedMs"), (int, float)) and a <= e["startedMs"] < b]
    waiting = sum(1 for e in inside if e.get("status") == "pending")
    running = sum(1 for e in inside if e.get("status") == "running")
    bits = []
    if waiting:
        bits.append("%d shift%s waiting for your OK" % (waiting, "" if waiting == 1 else "s"))
    if running:
        bits.append("%d still on the clock" % running)
    return " · ".join(bits) if bits else "Every shift in the period is approved."


def run(db, people, now=None):
    """Once on a pay day, from AT on. Returns who was told."""
    now = (now or dg._now()).astimezone(dg.TZ)
    if (now.hour, now.minute) < AT:
        return []
    day = now.date()
    conf = db.collection("settings").document("paySheet").get().to_dict() or {}
    if conf.get("on") is False or not is_pay_day(conf, day):
        return []
    claim = db.collection("reminderLog").document("paysheet_" + day.isoformat())
    try:
        claim.create({"at": now.isoformat()})
    except AlreadyExists:
        return []
    try:
        a, b = _bounds_ms(day)
        entries = [s.to_dict() or {} for s in db.collection("timeEntries").where("startedMs", ">=", a).where("startedMs", "<", b).stream()]
        body = words_for(day, entries)
        told = []
        for uid, u in (people or {}).items():
            if u.get("role") == "owner":
                dg.send_push(uid, {"push": {"title": "\U0001F4C4 Your pay sheet is ready", "body": body}},
                             tag="yd-paysheet", ttl=24 * 3600, opens="paysheet")
                told.append(uid)
        return told
    except Exception:           # no phone reached, or the shifts not read: the next run tries again
        claim.delete()
        raise
