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
    sent.extend(_usual(db, people, since, now))
    return sent


def _sees_board(user, board):
    """Whether this person may read this board -- the security rules' test."""
    if user.get("role") == "owner" or user["uid"] in (board.get("visibleTo") or []):
        return True
    # A private board (ownerOnly) is the owner's, whatever an admin's access.
    return user.get("role") == "admin" and board.get("ownerOnly") is not True \
        and (user.get("access") or {}).get("boards", "none") in ("see", "change")


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


# ----------------------------------------------------------- the usual ones
#
# Jonah (12 Oct 2026): "i want all of my things on the calendar to auto send
# notifications to my phone", and "every card thats mine", without setting a
# reminder on each -- and to say what each thing is, "because some stuff on
# the calendar just needs to be done that day but not at a specific time".
# remind.js has the same rules for the screens:
#   - at a set time: 30 minutes before; a bid appointment an hour AND half
#     an hour before ("bids should ping 1 hour and 30 min before");
#   - for any time that day (all day, or a card with no time): ONE list at
#     7 am of everything that day, not a buzz apiece -- the calendar's "any
#     time today" checklist, on the phone;
#   - to whoever it is theirs (_is_mine; "my cards are cards i dont select
#     anyone else on or ones i select myself on"): the people on it; with
#     nobody on it, a crew task ("things not for jonah to handle") goes to
#     every crew member (ticked on Your Crew) and anything else to whoever
#     made it -- the owner when that is nobody we know;
#   - "No reminder" on a thing: nobody. Its own set reminder takes the place
#     of the usual one for whoever that one goes to. Ticked off: nothing.
# To each person with autoRemind on (digestPrefs: on unless they switched it
# off -- "make it so crew members can get notifications"), for every calendar
# entry and card of theirs they can see, and the owner for every machine due.
# Each once, logged in reminderLog as auto_<uid>_...

TIMED_LEADS = (30,)
TYPE_LEADS = {"bid": (60, 30)}
TYPES = {"bid": "📋", "appt": "🕑", "doctor": "🩺", "pickup": "🚚", "delivery": "🚛",
         "todo": "✅", "crew": "👷", "personal": "🏠"}
CREW_TYPES = {"crew"}
BY_CALENDAR = {"visits": "bid", "schedule": "crew", "personal": "personal", "crew": "crew"}
REPEATS = ["weekly", "biweekly", "monthly", "yearly"]
DAY_LIST_MAX = 6                   # named in the 7 am buzz; the rest are "+N more"


def _type_of(item, cal_kind=None, board_id=None):
    """What a thing is -- picked, or by where it is (remind.js typeOf)."""
    if item.get("type") in TYPES:
        return item["type"]
    if cal_kind in BY_CALENDAR:
        return BY_CALENDAR[cal_kind]
    if board_id == "pickups":
        return "pickup"
    if board_id == "crew" or "crew" in (item.get("labels") or []):
        return "crew"
    return ""


def _is_crew_member(u):
    """Ticked as crew on Your Crew (remind.js isCrewMember): a crew account
    unless unticked, an admin only when ticked, the owner never."""
    if u.get("role") == "owner":
        return False
    return u.get("crewMember") is True or (u.get("role") == "crew" and u.get("crewMember") is not False)


def _is_mine(on, kind, maker, u):
    """remind.js isMine: theirs when they are on it; with nobody on it, a
    crew task is every crew member's and anything else whoever made it's --
    the owner's when that is nobody we know."""
    if u["uid"] in on:
        return True
    if on:
        return False
    if kind in CREW_TYPES:
        return _is_crew_member(u)
    if maker:
        return maker == u["uid"]
    return u.get("role") == "owner"


def _lead_words(m):
    return "In 1 hour" if m == 60 else "In %d hours" % (m // 60) if m % 60 == 0 else "In %d minutes" % m


def _usual(db, people, since, now):
    out = []
    auto = {}
    for uid, u in people.items():
        try:
            if dg._prefs(u).get("autoRemind"):
                auto[uid] = u
        except Exception as err:      # noqa: BLE001
            print("reminders: prefs not read for", uid, err)
    if not auto:
        return out
    today = now.date()
    seven = datetime.datetime(today.year, today.month, today.day, ALL_DAY_HOUR, 0, tzinfo=dg.TZ)
    morning = since < seven <= now          # this run sends the day's list
    longest = max(max(v) for v in list(TYPE_LEADS.values()) + [TIMED_LEADS])
    # A card keeps the NAME of whoever made it; this turns that into them.
    by_name = {}
    for uid, u in people.items():
        for n in (u.get("name"), u.get("email")):
            if str(n or "").strip():
                by_name[str(n).strip().lower()] = uid
    first = since.date() - datetime.timedelta(days=1)
    last = (now + datetime.timedelta(minutes=longest)).date() + datetime.timedelta(days=1)
    day_list = {uid: [] for uid in auto}

    def buzz(uid, key, title, body, tag):
        try:
            db.collection("reminderLog").document(key).create({"uid": uid, "at": now.isoformat()})
        except AlreadyExists:
            return
        try:
            out.append({"uid": uid, "usual": key, "phones": dg.send_push(
                uid, {"push": {"title": title[:90], "body": body}}, tag=tag, ttl=2 * 3600)})
        except Exception as err:      # noqa: BLE001
            print("reminders: usual push failed:", uid, key, err)

    def timed(uids, kind, title, start, body, key, tag):
        for lead in TYPE_LEADS.get(kind, TIMED_LEADS):
            due = start - datetime.timedelta(minutes=lead)
            if since < due <= now:
                for uid in uids:
                    buzz(uid, "auto_%s_%s_%d" % (uid, key, lead), (TYPES.get(kind) or "🔔") + " " + title,
                         _lead_words(lead) + " · " + body, tag)

    # Calendar entries: the ones starting about now, the repeats, and any
    # running over several days that are still going.
    try:
        for c in db.collection("calendars").stream():
            cal = c.to_dict() or {}
            sees = [u for u in auto.values() if _can_see(u, cal)]
            if not sees:
                continue
            ref = c.reference.collection("events")
            evs = {}
            for q in (ref.where("date", ">=", first.isoformat()).where("date", "<=", last.isoformat()),
                      ref.where("repeat", "in", REPEATS),
                      ref.where("endDate", ">=", today.isoformat())):
                for s in q.stream():
                    evs[s.id] = s.to_dict() or {}
            for eid, ev in evs.items():
                if ev.get("noReminder"):
                    continue
                try:
                    days = dg._occurrences(ev, first, last)
                except (TypeError, ValueError) as err:
                    print("reminders: skipped", c.id, eid, "-", err)
                    continue
                done = ev.get("done") or {}
                for day, one in days:
                    if done.get(day.isoformat()):
                        continue
                    kind = _type_of(one, cal_kind=cal.get("kind"))
                    on = {cr.get("uid") for cr in (one.get("crew") or []) if isinstance(cr, dict)}
                    who = [u["uid"] for u in sees if _is_mine(on, kind, ev.get("createdBy") or "", u)]
                    title = str(one.get("title") or one.get("jobName") or "Calendar")
                    if one.get("time") and not one.get("allDay"):
                        if day.isoformat() != str(one.get("date")):
                            continue            # a timed entry over days reminds on its first
                        mine = (set(ev.get("remindUids") or []) | on) if ev.get("hasReminder") else set()
                        timed([u for u in who if u not in mine], kind, title, _start_of(one, day),
                              _words(one, cal, _start_of(one, day)),
                              "ev_%s_%s_%s" % (c.id, eid, day.isoformat()), "yd-remind-%s_%s_%s" % (c.id, eid, day.isoformat()))
                    elif morning and day == today:
                        for uid in who:
                            day_list[uid].append((kind, title))
    except Exception as err:          # noqa: BLE001
        print("reminders: usual calendar reminders not read:", err)

    # Cards with a due date that are theirs.
    try:
        for b in db.collection("boards").stream():
            board = b.to_dict() or {}
            sees_board = [u for u in auto.values() if _sees_board(u, board)]
            # A card tagged 👷 Crew is read by the crew from any board that is
            # not private (the security rules), so it reminds them too.
            crew_reads = board.get("ownerOnly") is not True
            if not sees_board and not crew_reads:
                continue
            for s in b.reference.collection("cards").where("due", ">=", first.isoformat()) \
                    .where("due", "<=", last.isoformat()).stream():
                k = s.to_dict() or {}
                if k.get("doneAt") or k.get("noReminder"):
                    continue
                sees = sees_board if not (crew_reads and "crew" in (k.get("labels") or [])) else [
                    u for u in auto.values() if u in sees_board or u.get("role") in ("crew", "admin")]
                try:
                    day = datetime.date.fromisoformat(str(k.get("due")))
                except ValueError:
                    continue
                kind = _type_of(k, board_id=b.id)
                on = {a.get("uid") for a in (k.get("assignees") or []) if isinstance(a, dict)}
                maker = by_name.get(str(k.get("createdBy") or "").strip().lower(), "")
                who = [u for u in sees if _is_mine(on, kind, maker, u)]
                title = str(k.get("title") or "A card")
                t = str(k.get("dueTime") or "")
                if len(t) == 5 and t[2] == ":":
                    mine = (set(k.get("remindUids") or []) | on) if k.get("hasReminder") else set()
                    start = _start_of({"time": t}, day)
                    on_day = ("today" if day == today else "tomorrow" if day == today + datetime.timedelta(days=1)
                              else start.strftime("%a %b ") + str(day.day))
                    timed([u["uid"] for u in who if u["uid"] not in mine], kind, title, start,
                          " · ".join(x for x in (dg._fmt_time(t) + " " + on_day, board.get("name") or "") if x),
                          "card_%s_%s_%s_%s" % (b.id, s.id, day.isoformat(), t.replace(":", "")),
                          "yd-card_%s_%s" % (b.id, s.id))
                elif morning and day == today:
                    for u in who:
                        # A machine's own card: the machine is on the list already.
                        if k.get("auto") and k.get("equipmentId") and u.get("role") == "owner":
                            continue
                        day_list[u["uid"]].append((kind, title))
    except Exception as err:          # noqa: BLE001
        print("reminders: usual card reminders not read:", err)

    if not morning:
        return out
    # Machines due a service today: the owner's to see to.
    try:
        eq = [u for u in auto.values() if u.get("role") == "owner"]
        if eq:
            for s in db.collection("equipment").where("dueDate", "==", today.isoformat()).stream():
                g = s.to_dict() or {}
                for u in eq:
                    day_list[u["uid"]].append(("", "🚜 " + str(g.get("name") or "A machine") + " service due"))
    except Exception as err:          # noqa: BLE001
        print("reminders: equipment due not read:", err)

    # The day's list, one buzz each.
    for uid, items in day_list.items():
        if not items:
            continue
        order = list(TYPES)
        items.sort(key=lambda x: (x[0] in CREW_TYPES, order.index(x[0]) if x[0] in order else len(order), x[1].lower()))
        names = [((TYPES.get(kind) + " ") if TYPES.get(kind) else "") + title for kind, title in items[:DAY_LIST_MAX]]
        more = len(items) - DAY_LIST_MAX
        buzz(uid, "auto_%s_day_%s" % (uid, today.isoformat()),
             "✅ Today, any time: %d thing%s" % (len(items), "" if len(items) == 1 else "s"),
             " · ".join(names) + (" +%d more" % more if more > 0 else ""), "yd-day-" + today.isoformat())
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
