"""YD Job Hub -- the end-of-day list on the server (the app's side is eod.js).

Jonah (22 Oct 2026): "we need to make an end of day recurring task list for
[the crew lead] that includes uploading all images taken during that day, writing a
brief summary of what got done, whats left, anything important, and listing
any questsions or things he needs from me. i want to be able to add more
things to this."

The list is settings/endOfDay (eod.js says what is in it); a report is
endOfDay/{uid}_{day}. Here:

- tell_owner: a report sent (or sent again with changes) buzzes the owner's
  phone once -- from the five-minute reminders run, and at once when the
  phone that sent it asks (/notes/ping). reminderLog eod_<id>_<sends> settles
  a race between the two. The owner's own report is never told to him.
- remind: at the list's reminder time, anyone on it who worked today and has
  not sent theirs gets one buzz (reminderLog eodremind_<uid>_<day>).
- for_summary / add_to_summary: the owner's evening summary has each report
  in today, or says whose is not in yet; the morning's has yesterday's that
  came in after the evening summary went, or never came.

A day "worked" is one with a shift that began that day (Central time) and
was not turned down -- not a storm, unless the list says a storm counts. The
same rule as eod.js shiftsOn.
"""

import datetime

from google.api_core.exceptions import AlreadyExists

import digest as dg

# What the list is until the owner first changes it (eod.js DEFAULT_ITEMS --
# keep the two the same).
DEFAULT_ITEMS = [
    {"id": "photos", "kind": "photos", "label": "Upload today’s photos",
     "hint": "Add the day’s photos to each job you worked, then tick it.", "need": False},
    {"id": "done", "kind": "text", "label": "What got done today", "hint": "", "need": True},
    {"id": "left", "kind": "text", "label": "What’s left", "hint": "", "need": False},
    {"id": "important", "kind": "text", "label": "Anything important", "hint": "", "need": False},
    {"id": "questions", "kind": "text", "label": "Questions — or anything you need from Jonah", "hint": "", "need": False},
]
DEFAULTS = {"at": "15:00", "remind": True, "remindAt": "17:00", "storms": False}
# A reminder is not sent this late, however the time is set: a buzz at 10 pm
# about the day's paperwork helps nobody.
LAST_REMIND_HOUR = 21
ANSWER_MAX = 400            # words of one answer in a summary
SUMMARY_PEOPLE_MAX = 10


def _hhmm(s, fallback):
    try:
        h, m = [int(x) for x in str(s).split(":")[:2]]
        if 0 <= h < 24 and 0 <= m < 60:
            return "%02d:%02d" % (h, m)
    except (TypeError, ValueError):
        pass
    return fallback


def settings(db):
    """settings/endOfDay with the starting values filled in."""
    try:
        snap = db.collection("settings").document("endOfDay").get()
        d = (snap.to_dict() or {}) if snap.exists else {}
    except Exception as err:            # noqa: BLE001 -- no list read: nobody is reminded
        print("endofday: list not read:", err)
        d = {}
    items = d.get("items") if isinstance(d.get("items"), list) else DEFAULT_ITEMS
    return {
        "items": [x for x in items if isinstance(x, dict)],
        "who": [u for u in (d.get("who") or []) if isinstance(u, str) and u],
        "at": _hhmm(d.get("at"), DEFAULTS["at"]),
        "remind": d.get("remind") if isinstance(d.get("remind"), bool) else DEFAULTS["remind"],
        "remindAt": _hhmm(d.get("remindAt"), DEFAULTS["remindAt"]),
        "storms": d.get("storms") is True,
    }


def _bounds_ms(day):
    start = datetime.datetime(day.year, day.month, day.day, tzinfo=dg.TZ)
    end = start + datetime.timedelta(days=1)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def worked_on(db, day, storms=False):
    """{uid: [shift, ...]}: the shifts that began on `day` and count as a day
    worked (eod.js shiftsOn)."""
    a, b = _bounds_ms(day)
    out = {}
    for s in db.collection("timeEntries").where("startedMs", ">=", a).where("startedMs", "<", b).stream():
        e = s.to_dict() or {}
        if not e.get("uid") or e.get("status") == "rejected" or (e.get("kind") == "storm" and not storms):
            continue
        out.setdefault(e["uid"], []).append(e)
    return out


def reports_on(db, day):
    """{uid: report} sent for `day`."""
    out = {}
    for s in db.collection("endOfDay").where("day", "==", day.isoformat()).stream():
        r = s.to_dict() or {}
        if r.get("uid") and r.get("sentAt"):
            r["id"] = s.id
            out[r["uid"]] = r
    return out


def _first(people, uid, fallback=""):
    u = people.get(uid)
    return (dg._name(u) if u else str(fallback or "Someone")).split()[0]


def _photos(r):
    try:
        return int((r.get("photos") or {}).get("count") or 0)
    except (TypeError, ValueError):
        return 0


def _first_words(r):
    """The first thing they wrote, in the order the list asks."""
    a = r.get("answers") or {}
    for it in r.get("items") or DEFAULT_ITEMS:
        v = a.get(it.get("id"))
        if it.get("kind") == "text" and isinstance(v, str) and v.strip():
            return " ".join(v.split())
    return ""


# ---------------------------------------------------------------- telling

def tell_owner(db, people=None, now=None):
    """Reports sent and not told yet: the owner's phone buzzes once for each
    (and again when one is sent again with changes)."""
    people = people if people is not None else dg._people()
    now = now or dg._now()
    owners = [uid for uid, u in people.items() if u.get("role") == "owner"]
    out = []
    try:
        waiting = list(db.collection("endOfDay").where("notifiedAt", "==", None).stream())
    except Exception as err:            # noqa: BLE001
        print("endofday: reports not read:", err)
        return out
    for s in waiting:
        r = s.to_dict() or {}
        if not r.get("sentAt"):
            continue
        # His own report is not news to him.
        if (people.get(r.get("uid")) or {}).get("role") != "owner":
            try:
                db.collection("reminderLog").document("eod_%s_%s" % (s.id, int(r.get("sentCount") or 1))).create(
                    {"at": now.isoformat()})
            except AlreadyExists:
                continue
            who = _first(people, r.get("uid"), r.get("by"))
            again = int(r.get("sentCount") or 1) > 1
            try:
                day = datetime.date.fromisoformat(str(r.get("day")))
                when = "" if day == now.date() else " (%s)" % dg._long_day(day)
            except ValueError:
                when = ""
            title = "📋 %s’s end of day%s %s" % (who, when, "— changes" if again else "is in")
            n = _photos(r)
            bits = [_first_words(r)[:120]] if _first_words(r) else []
            bits.append("%d photo%s" % (n, "" if n == 1 else "s"))
            for uid in owners:
                try:
                    out.append({"uid": uid, "eod": s.id, "phones": dg.send_push(
                        uid, {"push": {"title": title, "body": " · ".join(bits)[:180]}},
                        tag="yd-eod-" + s.id, ttl=24 * 3600, opens="eodreports")})
                except Exception as err:    # noqa: BLE001
                    print("endofday: push failed:", uid, err)
        try:
            s.reference.update({"notifiedAt": now.isoformat()})
        except Exception as err:        # noqa: BLE001
            print("endofday: report not stamped:", s.id, err)
    return out


def remind(db, people=None, now=None, cfg=None):
    """From the list's reminder time: whoever is on it, worked today and has
    not sent theirs gets one buzz that opens the list."""
    people = people if people is not None else dg._people()
    now = now or dg._now()
    cfg = cfg or settings(db)
    if not cfg["remind"] or not cfg["who"] or now.hour >= LAST_REMIND_HOUR:
        return []
    h, m = [int(x) for x in cfg["remindAt"].split(":")]
    if now.hour * 60 + now.minute < h * 60 + m:
        return []
    who = [uid for uid in cfg["who"] if uid in people]
    if not who:
        return []
    today = now.date()
    worked = worked_on(db, today, cfg["storms"])
    sent = reports_on(db, today)
    out = []
    for uid in who:
        if uid not in worked or uid in sent:
            continue
        try:
            db.collection("reminderLog").document("eodremind_%s_%s" % (uid, today.isoformat())).create(
                {"at": now.isoformat()})
        except AlreadyExists:
            continue
        try:
            out.append({"uid": uid, "eodRemind": today.isoformat(), "phones": dg.send_push(
                uid, {"push": {"title": "📋 End of day", "body": "Before you go: today’s photos, what got done, "
                                                                "what’s left — and anything you need from Jonah."}},
                tag="yd-eod-remind", ttl=4 * 3600, opens="eod")})
        except Exception as err:        # noqa: BLE001
            print("endofday: reminder failed:", uid, err)
    return out


def run(db, people, now):
    """The five-minute reminders run's part."""
    out = tell_owner(db, people, now)
    try:
        out.extend(remind(db, people, now))
    except Exception as err:            # noqa: BLE001 -- the reports were still told
        print("endofday: reminders failed:", err)
    return out


# --------------------------------------------------------------- summaries

def for_summary(slot, today, people):
    """What the summaries say of the end of day, worked out once for everyone:
    {day, rows: [{uid, name, report or None}], late: report sent after the
    evening summary went}. Evening: today; morning: yesterday. None when the
    list has nobody on it, or for the midday summary."""
    if slot not in ("evening", "morning"):
        return None
    db = dg._db()
    cfg = settings(db)
    who = [uid for uid in cfg["who"] if uid in people][:SUMMARY_PEOPLE_MAX]
    if not who:
        return None
    day = today if slot == "evening" else today - datetime.timedelta(days=1)
    worked = worked_on(db, day, cfg["storms"])
    sent = reports_on(db, day)
    # The morning tells only what the evening could not: when the owner's
    # evening summary of that day went (summaries/ keeps it).
    evening_at = None
    if slot == "morning":
        for uid, u in people.items():
            if u.get("role") != "owner":
                continue
            try:
                k = db.collection("summaries").document(dg._kept_id(uid, "evening", day)).get()
                if k.exists:
                    evening_at = (k.to_dict() or {}).get("at")
            except Exception as err:    # noqa: BLE001
                print("endofday: evening summary not read:", err)
            break
    rows = []
    for uid in who:
        r = sent.get(uid)
        if not r and uid not in worked:
            continue
        # Late: after the evening summary went -- or there was none to carry it.
        # (The phone writes its time in UTC, the server in Central: compared
        # as moments, never as text.)
        sent_at, went = _dt(r.get("sentAt")) if r else None, _dt(evening_at)
        rows.append({"uid": uid, "name": dg._name(people.get(uid)), "report": r,
                     "late": bool(r and (not went or not sent_at or sent_at > went))})
    return {"slot": slot, "day": day.isoformat(), "rows": rows, "eveningAt": evening_at} if rows else None


def _dt(iso):
    """An ISO time, from the phone (UTC, "Z") or the server (with its offset),
    as a moment in Central time; None if it is not one."""
    try:
        t = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return t.astimezone(dg.TZ) if t.tzinfo else None


def _time_of(iso):
    t = _dt(iso)
    return dg._fmt_time(t.strftime("%H:%M")) if t else ""


def report_lines(r, name):
    """One report, as summary lines: who, when, the jobs and photos, then
    each thing on the list as it was sent."""
    jobs = [str(j.get("name") or "") for j in (r.get("jobs") or []) if isinstance(j, dict) and j.get("name")]
    n = _photos(r)
    head = "📋 %s — sent %s%s · %d photo%s" % (name, _time_of(r.get("sentAt")),
                                             (" · " + ", ".join(jobs[:4]) + (" +%d" % (len(jobs) - 4) if len(jobs) > 4 else ""))
                                             if jobs else "", n, "" if n == 1 else "s")
    lines = [{"text": head}]
    a = r.get("answers") or {}
    for it in r.get("items") or DEFAULT_ITEMS:
        v = a.get(it.get("id"))
        label = str(it.get("label") or "")
        if it.get("kind") == "photos":
            lines.append({"text": "   📷 " + ("Photos all up" if v is True else "Photos not ticked as all up")})
        elif it.get("kind") == "check":
            lines.append({"text": "   %s %s" % ("✓" if v is True else "✗", label)})
        else:
            words = " ".join(v.split()) if isinstance(v, str) else ""
            if len(words) > ANSWER_MAX:
                words = words[:ANSWER_MAX].rstrip() + "…"
            lines.append({"text": "   %s: %s" % (label, words or "—")})
    return lines


def add_to_summary(data, owner, uid, sections, push_bits):
    """The owner's summary: the reports, and whose is missing. Someone on the
    list: whether theirs went (evening only)."""
    if not data:
        return
    evening = data["slot"] == "evening"
    if owner:
        lines, missing, came = [], [], 0
        for row in data["rows"]:
            r = row["report"]
            first = str(row["name"]).split()[0]
            if r and (evening or row["late"]):
                lines.extend(report_lines(r, row["name"]))
                came += 1
            elif not r:
                missing.append(first)
                lines.append({"text": "📋 %s’s end of day %s" % (
                    first, "isn’t in yet" if evening else "was never sent")})
        if not lines:
            return
        title = "End of day" if evening else "Yesterday’s end of day"
        sections.append((title, lines))
        if came:
            push_bits.append("%d end of day%s in" % (came, "" if came == 1 else "s"))
        if missing:
            push_bits.append("%s’s end of day not in" % ", ".join(missing))
        return
    if evening:
        mine = next((row for row in data["rows"] if row["uid"] == uid), None)
        if mine and not mine["report"]:
            sections.append(("End of day", [{"text": "📋 Yours isn’t in yet — open Job Hub and send it before you forget."}]))
            push_bits.append("end of day not sent")
