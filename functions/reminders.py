"""YD Job Hub -- calendar reminders: the phone pop-up before something on the
calendar, the way Google Calendar does it.

Cloud Scheduler calls this every five minutes. Each run looks at the entries
and cards dated near now, works out when each of their occurrences starts --
repeats and all, with the same rules as the calendar screen -- and sends a
phone notification for every reminder that came due since the last run.

What a run reads, it reads ONCE and every kind of reminder below shares it:
the calendars and boards (one stream each), each calendar's entries that can
land in the next week and a day (digest.events_near: dated then, repeating,
or running over several days), each board's cards due then, and everybody's
settings in one go. Each kind used to read them all again for itself --
130-odd reads every five minutes, most of the day's free allowance (review,
12 Oct 2026). A reminder is set at most MAX_LEAD_MIN ahead, so nothing
outside that window can come due.

Each reminder is sent once. The first run to send one records it in
reminderLog/{calendar}_{event}_{day}, created only if it does not exist yet,
so two runs that overlap (or a retry) cannot buzz anyone twice.

Who gets it: whoever set the reminder, and the crew on the entry -- but only
people who can see that calendar. A reminder must never put an entry's title
on the phone of someone the calendar was not shared with.

The same five-minute run also stops any shift nobody clocked out of once it
reaches the owner's limit (autoclock.py), before the reminders.
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


def _near(since, now):
    """The days a reminder this run can be for: one starting between the day
    before `since` and a week and a day from now (a reminder is set at most
    MAX_LEAD_MIN ahead; the automatic ones an hour)."""
    return (since.date() - datetime.timedelta(days=1),
            now.date() + datetime.timedelta(days=MAX_LEAD_MIN // (24 * 60) + 1))


def _read_calendars(db, first, last):
    """[(id, calendar, reference, {entry id: entry} or None)] -- None when a
    calendar's entries could not be read (that calendar is left out of the
    run; the rest still remind)."""
    out = []
    for c in db.collection("calendars").stream():
        try:
            evs = dg.events_near(c.reference, first, last)
        except Exception as err:          # noqa: BLE001
            print("reminders: entries not read for", c.id, err)
            evs = None
        out.append((c.id, c.to_dict() or {}, c.reference, evs))
    return out


def _read_boards(db, first, last):
    """[(id, board, reference, [(card id, card)] or None)]: each board's cards
    due between first and last."""
    out = []
    for b in db.collection("boards").stream():
        try:
            cards = [(s.id, s.to_dict() or {}) for s in b.reference.collection("cards")
                     .where("due", ">=", first.isoformat()).where("due", "<=", last.isoformat()).stream()]
        except Exception as err:          # noqa: BLE001
            print("reminders: cards not read for", b.id, err)
            cards = None
        out.append((b.id, b.to_dict() or {}, b.reference, cards))
    return out


def run():
    db = dg._db()
    now = dg._now()
    since = now - datetime.timedelta(minutes=WINDOW_MIN)
    people = dg._people()
    # Shifts nobody clocked out of, stopped by the clock (autoclock.py) --
    # first, so nothing below can hold it up, and nothing it does can stop
    # the reminders going.
    clocked = {}
    try:
        import autoclock
        clocked = autoclock.run(db, people, now)
    except Exception as err:              # noqa: BLE001
        print("reminders: automatic clock-out failed:", err)
    try:
        prefs = dg.prefs_all(people)
    except Exception as err:              # noqa: BLE001 -- the set reminders still go
        print("reminders: settings not read:", err)
        prefs = {}
    first, last = _near(since, now)
    cals = _read_calendars(db, first, last)
    boards = _read_boards(db, first, last)
    sent = _set_reminders(db, people, cals, since, now)
    sent.extend(_urgent_cards(db, people, now, boards))
    sent.extend(_card_reminders(db, people, since, now, boards))
    sent.extend(_usual(db, people, since, now, cals, boards, prefs))
    sent.extend(_activity(db, people, now, cals, boards, prefs))
    sent.extend(crew_notes(db, people, now))
    sent.extend(clocked.get("told") or [])
    if clocked.get("stopped"):
        sent.append({"clockStopped": clocked["stopped"]})
    return sent


def _set_reminders(db, people, cals, since, now):
    """Calendar entries with a reminder set on them (hasReminder)."""
    sent = []
    for cal_id, cal, _, evs in cals:
        for eid, ev in (evs or {}).items():
            if ev.get("hasReminder") is not True:
                continue
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
                print("reminders: skipped", cal_id, eid, "-", err)
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
                key = "%s_%s_%s" % (cal_id, eid, day.isoformat())
                try:
                    db.collection("reminderLog").document(key).create(
                        {"calendar": cal_id, "event": eid, "day": day.isoformat(), "at": now.isoformat()})
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
    return sent


def crew_notes(db, people=None, now=None):
    """Notes from the crew (crewnotes.js) the owner has not been told about:
    a buzz each, once -- reminderLog note_<id> settles a race between the
    phone's own "tell him now" (/notes/ping) and this five-minute run."""
    people = people if people is not None else dg._people()
    now = now or dg._now()
    owners = [uid for uid, u in people.items() if u.get("role") == "owner"]
    out = []
    try:
        waiting = list(db.collection("crewNotes").where("notifiedAt", "==", None).stream())
    except Exception as err:          # noqa: BLE001
        print("reminders: crew notes not read:", err)
        return out
    for s in waiting:
        n = s.to_dict() or {}
        try:
            db.collection("reminderLog").document("note_" + s.id).create({"at": now.isoformat()})
        except AlreadyExists:
            continue
        who = (dg._name(people.get(n.get("uid"))) if people.get(n.get("uid")) else str(n.get("by") or "Someone")).split()[0]
        head = "📝 %s%s" % (who, (" · " + str(n.get("jobName"))[:50]) if n.get("jobName") else "")
        for uid in owners:
            try:
                out.append({"uid": uid, "note": s.id, "phones": dg.send_push(
                    uid, {"push": {"title": head, "body": str(n.get("text") or "")[:180]}},
                    tag="yd-note-" + s.id, ttl=24 * 3600, opens="notes")})
            except Exception as err:      # noqa: BLE001
                print("reminders: note push failed:", uid, err)
        try:
            s.reference.update({"notifiedAt": now.isoformat()})
        except Exception as err:          # noqa: BLE001
            print("reminders: note not stamped:", s.id, err)
    return out


def _sees_board(user, board, card=None):
    """Whether this person may read this board -- or, given a card, that card
    -- the security rules' test. A card tagged 👷 Crew is read by any crew
    member or admin from a board that is not private (firestore.rules
    cards: 'crew' in labels && openBoard()), whoever the board is shared with."""
    if user.get("role") == "owner" or user["uid"] in (board.get("visibleTo") or []):
        return True
    open_board = board.get("ownerOnly") is not True
    if card is not None and open_board and user.get("role") in ("crew", "admin") \
            and "crew" in (card.get("labels") or []):
        return True
    # A private board (ownerOnly) is the owner's, whatever an admin's access.
    return user.get("role") == "admin" and open_board \
        and (user.get("access") or {}).get("boards", "none") in ("see", "change")


def _card_reminders(db, people, since, now, boards):
    """A card with a due date and a reminder (boards.js: Jonah, 9 Oct 2026)
    buzzes the phone of whoever set it and the people on the card, the way a
    calendar entry does -- once per due date and time (a card moved to
    another day reminds again), never once it is done."""
    out = []
    try:
        for board_id, board, _, cards in boards:
            for card_id, k in cards or []:
                if k.get("hasReminder") is not True:
                    continue
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
                key = "card_%s_%s_%s_%s" % (board_id, card_id, day.isoformat(),
                                            str(k.get("dueTime") or "allday").replace(":", ""))
                try:
                    db.collection("reminderLog").document(key).create({"board": board_id, "card": card_id,
                                                                       "at": now.isoformat()})
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
                    if not u or not _sees_board(u, board, k):
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
DAY_LIST_MAX = 6                  # named in the 7 am buzz; the rest are "+N more"


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


def _usual(db, people, since, now, cals, boards, prefs):
    out = []
    auto = {uid: u for uid, u in people.items() if (prefs.get(uid) or {}).get("autoRemind")}
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
    # running over several days that are still going (read once by run();
    # the days outside first..last give no occurrences here).
    try:
        for cal_id, cal, _, evs in cals:
            sees = [u for u in auto.values() if _can_see(u, cal)]
            if not sees:
                continue
            for eid, ev in (evs or {}).items():
                if ev.get("noReminder"):
                    continue
                try:
                    days = dg._occurrences(ev, first, last)
                except (TypeError, ValueError) as err:
                    print("reminders: skipped", cal_id, eid, "-", err)
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
                              "ev_%s_%s_%s" % (cal_id, eid, day.isoformat()),
                              "yd-remind-%s_%s_%s" % (cal_id, eid, day.isoformat()))
                    elif morning and day == today:
                        for uid in who:
                            day_list[uid].append((kind, title))
    except Exception as err:          # noqa: BLE001
        print("reminders: usual calendar reminders not read:", err)

    # Cards with a due date that are theirs (read once by run(), a week and
    # more ahead; only those due first..last can buzz here).
    try:
        for board_id, board, _, cards in boards:
            for card_id, k in cards or []:
                due_on = k.get("due")
                if not isinstance(due_on, str) or not first.isoformat() <= due_on <= last.isoformat():
                    continue
                if k.get("doneAt") or k.get("noReminder"):
                    continue
                # A card tagged 👷 Crew is read by the crew from any board
                # that is not private (the security rules), so it reminds
                # them too (_sees_board with the card).
                sees = [u for u in auto.values() if _sees_board(u, board, k)]
                try:
                    day = datetime.date.fromisoformat(due_on)
                except ValueError:
                    continue
                kind = _type_of(k, board_id=board_id)
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
                          "card_%s_%s_%s_%s" % (board_id, card_id, day.isoformat(), t.replace(":", "")),
                          "yd-card_%s_%s" % (board_id, card_id))
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


# ------------------------------------------------------- what the crew did
#
# Jonah (12 Oct 2026): "i want to get notifications on my phone whenever the
# guys adds a card or something to a calendar or makes a change to an
# existing card on a baord or calendar." Each run looks at the cards and
# calendar entries changed since the last one (updatedAt), and tells the
# owner -- one buzz per run, however many -- about those changed by anybody
# but him: added, finished / ticked off, or changed. A card names who changed
# it (updatedBy, a name); an entry carries their uid (calendar.js write). A
# deletion leaves nothing to find, so it is not told.
#
# Phone clocks are not the server's: each look reaches ACTIVITY_OVERLAP_MIN
# back past the last, and reminderLog act_... keeps anything from being told
# twice.

ACTIVITY_OVERLAP_MIN = 10
ACTIVITY_NAMED = 4          # changes named in one buzz; the rest are "+N more"


def _when(iso):
    """A stored ISO time (the app's ...Z, or the server's +00:00) as a datetime."""
    try:
        t = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=dg.TZ)


def _iso_z(t):
    """The app's way of writing a time (JavaScript toISOString), to compare
    stored times as text in a query."""
    return t.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _activity(db, people, now, cals, boards, prefs):
    out = []
    owners = [uid for uid, u in people.items()
              if u.get("role") == "owner" and (prefs.get(uid) or {}).get("crewActivity")]
    if not owners:
        return out
    owner_uids = {uid for uid, u in people.items() if u.get("role") == "owner"}
    by_name = {}
    for uid, u in people.items():
        for n in (u.get("name"), u.get("email")):
            if str(n or "").strip():
                by_name[str(n).strip().lower()] = uid
    cursor = db.collection("reminderLog").document("activity_cursor")
    try:
        snap = cursor.get()
        last = _when((snap.to_dict() or {}).get("at")) if snap.exists else None
    except Exception as err:          # noqa: BLE001
        print("reminders: activity cursor not read:", err)
        return out
    since = (last or now - datetime.timedelta(minutes=WINDOW_MIN)) - datetime.timedelta(minutes=ACTIVITY_OVERLAP_MIN)
    news = []       # (log key, uid, verb, title, where, tab)

    def fresh(t):
        return t is not None and t >= since

    def same_moment(a, b):
        """This change is the one that made it (or finished it), not a later one."""
        a, b = _when(a), _when(b)
        return a is not None and b is not None and abs((a - b).total_seconds()) < 60

    try:
        for board_id, board, ref, _ in boards:
            for s in ref.collection("cards").where("updatedAt", ">", _iso_z(since)).stream():
                k = s.to_dict() or {}
                by = str(k.get("updatedBy") or "").strip().lower()
                who = by_name.get(by)
                if not who or who in owner_uids:
                    continue
                verb = ("added" if same_moment(k.get("createdAt"), k.get("updatedAt"))
                        and str(k.get("createdBy") or "").strip().lower() == by
                        else "finished" if same_moment(k.get("doneAt"), k.get("updatedAt")) else "changed")
                news.append(("act_card_%s_%s_%s" % (board_id, s.id, k.get("updatedAt")), who, verb,
                             str(k.get("title") or "a card"), board.get("name") or "a board", "boards"))
        for cal_id, cal, ref, _ in cals:
            for s in ref.collection("events").where("updatedAt", ">", _iso_z(since)).stream():
                ev = s.to_dict() or {}
                who = ev.get("updatedBy")
                if not who or who in owner_uids or who not in people:
                    continue
                ticked = any(isinstance(m, dict) and m.get("by") == who and same_moment(m.get("at"), ev.get("updatedAt"))
                             for m in (ev.get("done") or {}).values())
                verb = ("added" if same_moment(ev.get("createdAt"), ev.get("updatedAt")) and ev.get("createdBy") == who
                        else "ticked off" if ticked else "changed")
                news.append(("act_ev_%s_%s_%s" % (cal_id, s.id, ev.get("updatedAt")), who, verb,
                             str(ev.get("title") or ev.get("jobName") or "an entry"), cal.get("name") or "a calendar",
                             "calendar"))
    except Exception as err:          # noqa: BLE001
        print("reminders: crew changes not read:", err)
        return out

    told = []
    for key, who, verb, title, where, tab in news:
        try:
            db.collection("reminderLog").document(key).create({"at": now.isoformat()})
        except AlreadyExists:
            continue
        told.append((who, verb, title, where, tab))
    try:
        cursor.set({"at": now.isoformat()})
    except Exception as err:          # noqa: BLE001
        print("reminders: activity cursor not saved:", err)
    if not told:
        return out

    def first(uid):
        return (dg._name(people.get(uid)) or "Someone").split()[0]
    if len(told) == 1:
        who, verb, title, where, tab = told[0]
        head = "👷 %s %s %s" % (first(who), verb, "a card" if tab == "boards" else "an entry")
        body = "“%s” · %s" % (title[:80], where)
    else:
        head = "👷 %d changes from the crew" % len(told)
        body = " · ".join("%s %s “%s” (%s)" % (first(w), v, t[:40], wh) for w, v, t, wh, _ in told[:ACTIVITY_NAMED]) + \
            (" +%d more" % (len(told) - ACTIVITY_NAMED) if len(told) > ACTIVITY_NAMED else "")
    tabs = {x[4] for x in told}
    opens = next(iter(tabs)) if len(tabs) == 1 else "calendar"
    for uid in owners:
        try:
            out.append({"uid": uid, "activity": len(told), "phones": dg.send_push(
                uid, {"push": {"title": head, "body": body}}, tag="yd-activity-" + now.strftime("%H%M"),
                ttl=6 * 3600, opens=opens)})
        except Exception as err:      # noqa: BLE001
            print("reminders: activity push failed:", uid, err)
    return out


URGENT_TOLD = "urgent_told"     # reminderLog/urgent_told {cards: {"urgent_<board>_<card>": when}}


def _urgent_cards(db, people, now, boards):
    """A card marked 🔴 Urgent (boards.js) pings the owner's phone, once
    (WISHLIST #1: "a new Urgent card pings Jonah's phone"). Not one he made
    himself, and not one already done.

    The urgent cards already dealt with are listed in one record, read once
    a run: trying to write a log entry for every open urgent card every five
    minutes was a write a card a run for nothing (review, 12 Oct 2026). The
    per-card log entry still settles two runs at once."""
    out = []
    owners = {uid: u for uid, u in people.items() if u.get("role") == "owner"}
    if not owners:
        return out
    names = {str(u.get("name") or "").strip().lower() for u in owners.values()} - {""}
    try:
        told_ref = db.collection("reminderLog").document(URGENT_TOLD)
        snap = told_ref.get()
        told = ((snap.to_dict() or {}).get("cards") or {}) if snap.exists else {}
        for board_id, board, ref, _ in boards:
            for s in ref.collection("cards").where("urgency", "==", "urgent").stream():
                k = s.to_dict() or {}
                key = "urgent_%s_%s" % (board_id, s.id)
                if k.get("doneAt") or key in told:
                    continue
                try:
                    db.collection("reminderLog").document(key).create({"board": board_id, "card": s.id,
                                                                       "at": now.isoformat()})
                    fresh = True
                except AlreadyExists:
                    fresh = False           # told before this list was kept, or by an overlapping run
                told[key] = now.isoformat()
                told_ref.set({"cards": {key: told[key]}}, merge=True)
                if not fresh:
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
