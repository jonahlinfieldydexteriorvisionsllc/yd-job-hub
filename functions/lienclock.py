"""Collections and the lien clock on unpaid invoices.

Jonah's routine 5 of 14 (wish card, 26 Oct 2026): "a 'days since last work'
clock on every unpaid invoice with Wisconsin's two dates: about 5 months
after the last work (last practical day to serve the written notice of
intent to file a lien, served at least 30 days before filing) and 6 months
(last day to file). At 45, 90 and 120 days it drafts the next-stage chase or
a call script. Around 4 months it puts 'decide about a lien, talk to your
lawyer' on his list. A repair or warranty visit does not restart the clock."

Once a day after 7 am, on the five-minute reminders run (reminders.py),
plain code:
  - the last day of work on each unpaid invoice's job: the newest day
    anyone was clocked on that job, not counting days after the job was
    marked finished (a warranty or repair visit); the finish date when no
    one clocked on it. Written on the invoice as lienClock {lastWork,
    noticeBy, fileBy, at} for the app (invoices.js) to show. An invoice with
    no job here (a storm, a one-off) has no lien clock -- snow removal is no
    improvement to the land.
  - Wis. Stat. 779.06: a lien claim is filed within 6 months of the last
    labour or materials, after a written notice of intent served at least
    30 days before. The dates shown are for his lawyer to check; Job Hub
    never drafts or sends the notice itself.
  - The last day of work can be set by hand on the invoice (lienLastWork,
    invoices.js): a day clocked after the real work ended -- trim, a repair
    -- would put the lien dates too late, which is the one mistake that
    costs him the lien. The hand-set day always wins.
  - 45 and 90 days past due (counted from the job's finish when that came
    after the due date -- the rest is due once it is done): a firmer note to
    the customer saved in his Gmail Drafts (never sent); 120 days: time to
    call, and to decide about a lien. One push for
    the day, naming them. Each stage once per invoice; an invoice first seen
    late gets only the stage it has reached, not every one before it.
  - Not while the deposit is paid and the job not finished (the rest is not
    due), nor while he has put the invoice off ("Not yet — a week").
"""

import calendar
import datetime

import digest as dg

STAGES = (45, 90, 120)          # days past due
LIEN_DECIDE = 120               # days after the last work: decide about a lien (invoices.js LIEN_DECIDE)
FROM_HOUR = 7
NOTICE_DAYS = 30            # the notice of intent: at least this many days before filing
FILE_MONTHS = 6
NOTICE_WARN = 14            # days before the last day to serve the notice: told once


def _iso(d):
    return d.strftime("%Y-%m-%d")


def _day(s):
    try:
        return datetime.date.fromisoformat(str(s)[:10])
    except (TypeError, ValueError):
        return None


def _fin(job):
    """The Chicago day the job was finished. completedAt is the phone's UTC
    time: one marked complete after 7 pm here is the next day in UTC, which
    would put every lien date a day late -- the unsafe way."""
    return _day(dg._local_day(job.get("completedAt")))


def add_months(d, n):
    """The same day n months on (the 31st into a shorter month: its last day)."""
    m = d.month - 1 + n
    y, m = d.year + m // 12, m % 12 + 1
    return datetime.date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def lien_dates(last):
    file_by = add_months(last, FILE_MONTHS)
    return file_by - datetime.timedelta(days=NOTICE_DAYS), file_by


def _local_day(ms):
    return datetime.datetime.fromtimestamp(ms / 1000.0, dg.TZ).date()


def last_work(db, job_id, job):
    """The last day of work on the job (see above), or None."""
    done = str(job.get("jobStatus") or "").lower() in ("complete", "completed", "done")
    fin = _fin(job) if done else None
    days = []
    for s in db.collection("timeEntries").where("targetId", "==", job_id).stream():
        e = s.to_dict() or {}
        if e.get("kind") != "job" or e.get("status") == "rejected":
            continue
        try:
            d = _local_day(float(e.get("startedMs")))
        except (TypeError, ValueError):
            continue
        if fin and d > fin:
            continue            # after it was finished: a warranty or repair visit
        days.append(d)
    if days:
        return max(days)
    return fin


# ---------------------------------------------------------------- the notes

def note_words(stage, inv, job):
    """(subject, body) of the firmer note at 45 or 90 days."""
    import followup
    j = job or {"customerName": inv.get("customerName") or ""}
    name = followup._first_name(j, None) or "there"
    work = followup._work_words(job) if job else "work"
    doc = str(inv.get("docNumber") or "").strip()
    num = ("invoice #" + doc) if doc else "your invoice"
    owed = "${:,.2f}".format(float(inv.get("balance") or 0))
    if stage == 45:
        subject = "%s — %s still open" % (num[:1].upper() + num[1:], owed)
        body = ("Hi %s,\n\n"
                "I'm following up on %s for your %s. %s is still open.\n\n"
                "You can pay with the link in the invoice email from QuickBooks, or by check made out to "
                "YD Exterior Visions LLC.\n\n"
                "If something about the work isn't right, reply and tell me. I'd rather fix it than have it sit.\n\n"
                "Thanks,\nJonah\nYD Exterior Visions") % (name, num, work, owed)
    else:
        by = dg._now().date() + datetime.timedelta(days=10)
        subject = "Second notice: %s — %s" % (num, owed)
        body = ("Hi %s,\n\n"
                "%s for your %s is now well past due, with %s still open.\n\n"
                "Please pay it by %s, with the link in the invoice email or by check made out to "
                "YD Exterior Visions LLC. If that's hard right now, reply and we'll set up payments.\n\n"
                "Thanks,\nJonah\nYD Exterior Visions") % (
                    name, num[:1].upper() + num[1:], work, owed, by.strftime("%B ") + str(by.day))
    return subject, body


# ---------------------------------------------------------------- running

def _claim(db, key, now):
    from google.api_core.exceptions import AlreadyExists
    try:
        db.collection("reminderLog").document(key).create({"at": now.isoformat()})
        return True
    except AlreadyExists:
        return False


def run(db, people, now=None):
    now = now or dg._now()
    if now.hour < FROM_HOUR:
        return []
    today = now.date()
    if not _claim(db, "lienclock_" + _iso(today), now):
        return []
    jobs = dg._jobs()
    rules = dg.invoice_rules()
    lines, drafted = [], []
    for s in db.collection("invoices").where("open", "==", True).stream():
        try:
            _one(db, s, jobs, rules, today, now, lines, drafted)
        except Exception as e:      # noqa: BLE001 -- one invoice must not stop the rest
            print("lienclock: invoice", s.id, "skipped:", e)
    sent = []
    if lines:
        n = len(lines)
        note = {"push": {"title": "\U0001F4B5 Unpaid invoices: %d to see to" % n if n > 1 else "\U0001F4B5 An unpaid invoice to see to",
                         "body": " · ".join(lines)[:180]}}
        for uid, u in people.items():
            if u.get("role") != "owner":
                continue
            try:
                sent.append({"uid": uid, "lienClock": lines, "drafted": drafted,
                             "phones": dg.send_push(uid, note, tag="yd-lienclock", ttl=20 * 3600, opens="dashboard")})
            except Exception as e:      # noqa: BLE001
                print("lienclock: push failed:", uid, e)
    return sent


def _one(db, s, jobs, rules, today, now, lines, drafted):
    """One open invoice (run): its lien clock, and the step it has reached."""
    inv = s.to_dict() or {}
    if not float(inv.get("balance") or 0) > 0:
        return
    job_id = inv.get("jobId")
    job = jobs.get(job_id) if job_id else None
    st = dg.invoice_state(inv, job, rules, today)
    if st.get("kind") == "paid":
        return
    hand = _day(inv.get("lienLastWork"))
    # The clocked day is kept apart from the one in use: with a day set by
    # hand, the app's "Use the last clocked day" showed the hand day, and
    # going back to it showed the hand day as clocked until the next run.
    clocked = last_work(db, job_id, job) if job else None
    last = hand or clocked
    was = inv.get("lienClock") or {}
    if last:
        notice_by, file_by = lien_dates(last)
        clock = {"lastWork": _iso(last), "noticeBy": _iso(notice_by), "fileBy": _iso(file_by), "byHand": bool(hand),
                 "clocked": _iso(clocked) if clocked else None}
        if any(was.get(k) != v for k, v in clock.items()):
            s.reference.set({"lienClock": dict(clock, at=now.isoformat())}, merge=True)
    elif was:
        # No day any more (a hand day taken off, no clocked day): no dates
        # left standing that are not true.
        s.reference.set({"lienClock": None}, merge=True)
    if st.get("kind") == "waiting":
        return            # the deposit is in and the job not done: the rest is not due yet
    snooze = _day(inv.get("snoozeUntil"))
    if snooze and snooze > today:
        return
    due = _day(inv.get("dueDate") or inv.get("txnDate"))
    fin = _fin(job) if job else None
    start = max([d for d in (due, fin) if d] or [today])
    age = (today - start).days
    who = "%s%s %s" % (inv.get("customerName") or "A customer",
                       (" #" + str(inv["docNumber"])) if inv.get("docNumber") else "",
                       "${:,.2f}".format(float(inv.get("balance") or 0)))
    reached = [x for x in STAGES if age >= x]
    if reached:
        stage = reached[-1]
        # The stage reached, once; the ones before it are passed, not sent late.
        fresh = _claim(db, "lien%d_%s" % (stage, s.id), now)
        for x in reached[:-1]:
            _claim(db, "lien%d_%s" % (x, s.id), now)
        if fresh and stage in (45, 90) and st.get("kind") == "unsent":
            # A "following up on the invoice" note for one that was never
            # emailed would say the wrong thing: the bill goes first.
            lines.append("%s — %d days past due and never emailed: send the invoice from QuickBooks" % (who, age))
        elif fresh and stage in (45, 90):
            to = str(inv.get("email") or "").strip()
            if to:
                import cards
                subject, body = note_words(stage, inv, job)
                try:
                    got = cards.draft_email(to, subject, body)
                except Exception as e:      # noqa: BLE001 -- Gmail slow or down
                    got = {"ok": False, "error": str(e)[:80]}
                if got.get("ok"):
                    drafted.append(s.id)
                    lines.append("%s — %d days past due: a %s note is in your Gmail Drafts" % (
                        who, age, "firmer" if stage == 45 else "second"))
                else:
                    # Not drafted: the step is let go, so tomorrow drafts it again.
                    db.collection("reminderLog").document("lien%d_%s" % (stage, s.id)).delete()
                    lines.append("%s — %d days past due: the note could not be drafted (%s)" % (who, age, got.get("error")))
            else:
                lines.append("%s — %d days past due: no email on the invoice, give them a call" % (who, age))
        elif fresh:
            # The lien is about the last work, not the bill: decided at
            # LIEN_DECIDE days after it (Home and the list say so too).
            lien = bool(last) and (today - last).days >= LIEN_DECIDE and not inv.get("lienDecided")
            lines.append("%s — %d days past due: time to call%s" % (
                who, age, ", and to decide about a lien (talk to your lawyer)" if lien else ""))
    # The last day to serve a lien notice coming up, not decided yet.
    if clock and not inv.get("lienDecided"):
        left = (_day(clock["noticeBy"]) - today).days
        if 0 <= left <= NOTICE_WARN and _claim(db, "liennotice_%s_%s" % (s.id, clock["noticeBy"]), now):
            lines.append("%s — the last day to serve a lien notice is %s (talk to your lawyer)" % (
                who, _day(clock["noticeBy"]).strftime("%a %b ") + str(_day(clock["noticeBy"]).day)))
