"""YD Job Hub -- calendar reminders: the phone pop-up before something on the
calendar, the way Google Calendar does it.

Cloud Scheduler calls this every five minutes. Each run looks only at entries
that have a reminder (hasReminder == true, one small query per calendar),
works out when each of their occurrences starts -- repeats and all, with the
same rules as the calendar screen -- and sends a phone notification for every
reminder that came due since the last run.

Each reminder is sent once. The first run to send one records it in
reminderLog/{calendar}_{event}_{day}, created only if it does not exist yet,
so two runs that overlap (or a retry) cannot buzz anyone twice.

Who gets it: whoever set the reminder, and the crew on the entry -- but only
people who can see that calendar. A reminder must never put an entry's title
on the phone of someone the calendar was not shared with.
"""

import datetime

from google.api_core.exceptions import AlreadyExists

import digest as dg

# The scheduler fires every five minutes; a reminder is due if it fell in the
# last six, so a run that starts a little late misses nothing. The log stops
# the overlap from sending anything twice.
WINDOW_MIN = 6
ALL_DAY_HOUR = 7            # all-day entries remind counting back from 7 am
MAX_LEAD_MIN = 7 * 24 * 60


def _start_of(ev, day):
    """When an occurrence on `day` starts, Central time."""
    hh, mm = ALL_DAY_HOUR, 0
    if not ev.get("allDay") and ev.get("time"):
        try:
            hh, mm = [int(x) for x in str(ev["time"]).split(":")[:2]]
        except ValueError:
            pass
    return datetime.datetime(day.year, day.month, day.day, hh, mm, tzinfo=dg.TZ)


def _can_see(user, cal):
    """Whether this person may read this calendar -- the same test as the
    security rules."""
    if user.get("role") == "owner":
        return True
    if user["uid"] in (cal.get("visibleTo") or []):
        return True
    if user.get("role") == "admin" and cal.get("ownerOnly") is False:
        level = (user.get("access") or {}).get("calendars", "none")
        return level in ("see", "change")
    return False


def _words(ev, cal, start):
    when = "All day" if (ev.get("allDay") or not ev.get("time")) else dg._fmt_time(ev.get("time"))
    today = dg._now().date()
    day = ("today" if start.date() == today else
           "tomorrow" if start.date() == today + datetime.timedelta(days=1) else
           start.strftime("%a %b ") + str(start.day))
    bits = [when + " " + day]
    if ev.get("address"):
        bits.append(ev["address"])
    if cal.get("name"):
        bits.append(cal["name"])
    return " · ".join(bits)


def run():
    db = dg._db()
    now = dg._now()
    since = now - datetime.timedelta(minutes=WINDOW_MIN)
    people = dg._people()
    sent = []
    for c in db.collection("calendars").stream():
        cal = c.to_dict() or {}
        for e in c.reference.collection("events").where("hasReminder", "==", True).stream():
            ev = e.to_dict() or {}
            mins = ev.get("remindMins")
            if not isinstance(mins, (int, float)) or mins < 0 or mins > MAX_LEAD_MIN:
                continue
            # Each repeat's first day only: a three-day job reminds once, not
            # on every day it spans.
            starts_only = dict(ev)
            starts_only.pop("endDate", None)
            first = (since + datetime.timedelta(minutes=mins)).date() - datetime.timedelta(days=1)
            last = (now + datetime.timedelta(minutes=mins)).date() + datetime.timedelta(days=1)
            try:
                days = dg._occurrences(starts_only, first, last)
            except (TypeError, ValueError) as err:
                print("reminders: skipped", c.id, e.id, "-", err)
                continue
            # A single date changed on its own (calendar.js) reminds at its own
            # time; a cancelled one not at all.
            for day, one in days:
                if day.isoformat() != str(one.get("date")):
                    continue
                start = _start_of(one, day)
                due = start - datetime.timedelta(minutes=mins)
                if not (since < due <= now):
                    continue
                key = "%s_%s_%s" % (c.id, e.id, day.isoformat())
                try:
                    db.collection("reminderLog").document(key).create(
                        {"calendar": c.id, "event": e.id, "day": day.isoformat(), "at": now.isoformat()})
                except AlreadyExists:
                    continue        # an earlier or overlapping run sent it
                uids = set(ev.get("remindUids") or [])
                uids.update(cr.get("uid") for cr in (one.get("crew") or []) if cr.get("uid"))
                title = one.get("title") or one.get("jobName") or "Calendar"
                note = {"push": {"title": "🔔 " + title, "body": _words(one, cal, start)}}
                for uid in uids:
                    u = people.get(uid)
                    if not u or not _can_see(u, cal):
                        continue
                    try:
                        n = dg.send_push(uid, note, tag="yd-remind-" + key, ttl=2 * 3600)
                        sent.append({"uid": uid, "event": key, "phones": n})
                    except Exception as err:      # noqa: BLE001
                        print("reminders: push failed for", uid, key, err)
    sent.extend(_urgent_cards(db, people, now))
    sent.extend(_card_reminders(db, people, since, now))
    return sent


def _sees_board(user, board):
    """Whether this person may read this board -- the security rules' test."""
    if user.get("role") == "owner" or user["uid"] in (board.get("visibleTo") or []):
        return True
    return user.get("role") == "admin" and (user.get("access") or {}).get("boards", "none") in ("see", "change")


def _card_reminders(db, people, since, now):
    """A card with a due date and a reminder (boards.js: Jonah, 9 Oct 2026)
    buzzes the phone of whoever set it and the people on the card, the way a
    calendar entry does -- once per due date and time (a card moved to
    another day reminds again), never once it is done."""
    out = []
    try:
        for b in db.collection("boards").stream():
            board = b.to_dict() or {}
            for s in b.reference.collection("cards").where("hasReminder", "==", True).stream():
                k = s.to_dict() or {}
                mins = k.get("remindMins")
                if k.get("doneAt") or not k.get("due") or not isinstance(mins, (int, float)) \
                        or mins < 0 or mins > MAX_LEAD_MIN:
                    continue
                try:
                    day = datetime.date.fromisoformat(str(k["due"]))
                except ValueError:
                    continue
                ev = {"time": k.get("dueTime"), "allDay": not k.get("dueTime")}
                start = _start_of(ev, day)
                due = start - datetime.timedelta(minutes=mins)
                if not (since < due <= now):
                    continue
                key = "card_%s_%s_%s_%s" % (b.id, s.id, day.isoformat(), str(k.get("dueTime") or "allday").replace(":", ""))
                try:
                    db.collection("reminderLog").document(key).create({"board": b.id, "card": s.id, "at": now.isoformat()})
                except AlreadyExists:
                    continue
                uids = set(k.get("remindUids") or [])
                uids.update(a.get("uid") for a in (k.get("assignees") or []) if a.get("uid"))
                when = dg._fmt_time(k["dueTime"]) if k.get("dueTime") else "Due"
                today = dg._now().date()
                on = ("today" if day == today else "tomorrow" if day == today + datetime.timedelta(days=1)
                      else start.strftime("%a %b ") + str(day.day))
                note = {"push": {"title": "🔔 " + str(k.get("title") or "A card")[:80],
                                 "body": " · ".join(x for x in (when + " " + on, board.get("name") or "") if x)}}
                for uid in uids:
                    u = people.get(uid)
                    if not u or not _sees_board(u, board):
                        continue
                    try:
                        out.append({"uid": uid, "card": key, "phones": dg.send_push(uid, note, tag="yd-" + key, ttl=2 * 3600)})
                    except Exception as err:      # noqa: BLE001
                        print("reminders: card push failed:", uid, key, err)
    except Exception as err:          # noqa: BLE001
        print("reminders: card reminders not read:", err)
    return out


def _urgent_cards(db, people, now):
    """A card marked 🔴 Urgent (boards.js) pings the owner's phone, once
    (WISHLIST #1: "a new Urgent card pings Jonah's phone"). Not one he made
    himself, and not one already done."""
    out = []
    owners = {uid: u for uid, u in people.items() if u.get("role") == "owner"}
    if not owners:
        return out
    names = {str(u.get("name") or "").strip().lower() for u in owners.values()} - {""}
    try:
        for b in db.collection("boards").stream():
            board = b.to_dict() or {}
            for s in b.reference.collection("cards").where("urgency", "==", "urgent").stream():
                k = s.to_dict() or {}
                if k.get("doneAt"):
                    continue
                key = "urgent_%s_%s" % (b.id, s.id)
                try:
                    db.collection("reminderLog").document(key).create({"board": b.id, "card": s.id, "at": now.isoformat()})
                except AlreadyExists:
                    continue
                if str(k.get("createdBy") or "").strip().lower() in names:
                    continue
                note = {"push": {"title": "🔴 Urgent: " + str(k.get("title") or "a card")[:80],
                                 "body": (board.get("name") or "Boards") +
                                         ((" — from " + str(k.get("createdBy"))) if k.get("createdBy") else "")}}
                for uid in owners:
                    try:
                        out.append({"uid": uid, "card": key, "phones": dg.send_push(uid, note, tag="yd-" + key)})
                    except Exception as err:      # noqa: BLE001
                        print("reminders: urgent push failed:", err)
    except Exception as err:          # noqa: BLE001
        print("reminders: urgent cards not read:", err)
    return out
