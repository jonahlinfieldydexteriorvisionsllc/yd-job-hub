"""Next season's outreach, in the owner's morning summary.

Jonah (14 Oct 2026): "set up date to start reaching out to clients for jobs
for next season." He sets the day on the Contacts tab (settings/outreach
.startDate, YYYY-MM-DD). From that morning, everyone still open on his
contact list whose time to call has come -- or who has none, or one nobody
can read -- and who has not been reached since, is due. The morning summary
says so on the day itself, with the first names on the list, and after that
gives the count each morning while any are left.

This reads the list exactly as prospects.js does (whenKey, isDue there):
the two must agree, or the summary would count people the app does not
show. Dates are Central time, like the rest of the summaries.

Once the customer list from QuickBooks is switched on (settings/customers
.importOn, and the first customers read in -- customers.js applyOn), the
Contacts screen gives way to it and so does this: the count is the
Customers tab's Call list. Each customer's time to call is a window
(customers/{id}.when {from, to}, set with the season / month / "in about
1-3 months" buttons, or read out of the words in contactWhen); they are due
from the window's first day until "Reached out" is tapped. call_state here
is customers.js callState, line for line -- change both.
"""

import datetime
import re
from zoneinfo import ZoneInfo

from firebase_admin import firestore

TZ = ZoneInfo("America/Chicago")
CLOSED = ("won", "no")
NAMES_ON_THE_DAY = 8

_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
_SEASONS = {"spring": 3, "summer": 6, "fall": 9, "autumn": 9, "winter": 12}
# Whole words only, as prospects.js: "maybe" is not May.
_MONTH_WORD = re.compile(r"\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|"
                         r"sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b", re.A)
_SEASON_WORD = re.compile(r"\b(spring|summer|fall|autumn|winter)\b", re.A)
_YEAR = re.compile(r"\b(?:19|20)\d{2}\b", re.A)
_ISO = re.compile(r"\b(?:19|20)\d{2}[-/](\d{1,2})\b", re.A)
_SLASH = re.compile(r"\b(\d{1,2})[-/](?:\d{1,2}[-/])?(?:19|20)\d{2}\b", re.A)


def when_key(text):
    """(year, month) read out of a contact's free-text time to call, month 13
    for a year alone -- or None when there is no year in it (prospects.js
    whenKey)."""
    s = str(text or "").lower()
    if not s.strip():
        return None
    y = _YEAR.search(s)
    if not y:
        return None
    month = 0
    iso, slash = _ISO.search(s), _SLASH.search(s)
    if iso:
        month = int(iso.group(1))
    elif slash:
        month = int(slash.group(1))
    else:
        name, season = _MONTH_WORD.search(s), _SEASON_WORD.search(s)
        if name:
            month = _MONTHS.index(name.group(1)[:3]) + 1
        elif season:
            month = _SEASONS[season.group(1)]
    return int(y.group(0)), (month if 0 < month < 13 else 13)


def _when_day(text):
    """The first day of the month their time to call names (a year alone is
    that January), or None."""
    k = when_key(text)
    if not k:
        return None
    return datetime.date(k[0], 1 if k[1] > 12 else k[1], 1)


def _instant(iso):
    try:
        t = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=datetime.timezone.utc)


def _reached_since(p, start):
    at = str(p.get("reachedAt") or "")
    t = _instant(at) if at else None
    if not t:
        return False
    if t < datetime.datetime(start.year, start.month, start.day, tzinfo=TZ):
        return False
    # A time to call written after the call is a new one (prospects.js).
    return not (p.get("whenSetAt") and str(p.get("whenSetAt")) > at)


def is_due(p, start, today):
    if p.get("status") in CLOSED or today < start:
        return False
    w = _when_day(p.get("contactWhen"))
    return today >= (w if w and w > start else start) and not _reached_since(p, start)


def start_date(db=None):
    """The day outreach starts, or None when it is not set."""
    db = db or firestore.client()
    snap = db.collection("settings").document("outreach").get()
    d = (snap.to_dict() or {}) if snap.exists else {}
    try:
        return datetime.date.fromisoformat(str(d.get("startDate") or ""))
    except ValueError:
        return None


def due(today, db=None):
    """(start, [contacts due]) -- start None when no date is set, and then
    nobody is due. Sorted like the app's list: soonest time to call first."""
    db = db or firestore.client()
    start = start_date(db)
    if not start or today < start:
        return start, []
    people = []
    for s in db.collection("prospects").stream():
        p = s.to_dict() or {}
        if is_due(p, start, today):
            people.append(p)
    people.sort(key=lambda p: (when_key(p.get("contactWhen")) or (9999, 99), str(p.get("name") or "").lower()))
    return start, people


# ---------------------------------------------------------------- the Customers tab's call list
#
# customers.js windowFromText / windowOf / reachedFor / callState, in Python.

_SEASON_SPAN = {"spring": (3, 5), "summer": (6, 8), "fall": (9, 11), "autumn": (9, 11), "winter": (12, 2)}
_YEAR_ANY = re.compile(r"\b((?:19|20)\d{2})\b", re.A)
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _last_day(y, m):
    nxt = datetime.date(y + (m == 12), m % 12 + 1, 1)
    return (nxt - datetime.timedelta(days=1)).isoformat()


# Said with no date in it (customers.js REL_RE / IN_RE): this / next week,
# this / next month, this / next year, "in 3 weeks", "in a couple of
# months" -- the week (Sunday to Saturday) or the month it falls in. "Next"
# before a month or a season is the next one that has not begun.
_REL = re.compile(r"\b(this|next) (week|month|year)\b", re.A)
_IN = re.compile(r"\bin (\d{1,2}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|"
                 r"(?:a )?couple(?: of)?|(?:a )?few) (weeks?|months?)\b", re.A)
_COUNT_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"]
_NEXT_BEFORE = re.compile(r"\bnext $", re.A)


def _count_of(w):
    if re.match(r"^\d+$", w, re.A):
        return int(w)
    if "couple" in w:
        return 2
    if "few" in w:
        return 3
    if w in ("a", "an"):
        return 1
    return _COUNT_WORDS.index(w) + 1 if w in _COUNT_WORDS else 0


def _next_before(t, at):
    return _NEXT_BEFORE.search(t[:at]) is not None


def _week_of(d):
    """The week (Sunday to Saturday) a day is in."""
    a = d - datetime.timedelta(days=(d.weekday() + 1) % 7)
    return {"from": a.isoformat(), "to": (a + datetime.timedelta(days=6)).isoformat()}


def _month_of(y, m):
    """The month m of year y, m 1-12 or past 12 (into the years after)."""
    y, m = y + (m - 1) // 12, (m - 1) % 12 + 1
    return {"from": "%04d-%02d-01" % (y, m), "to": _last_day(y, m)}


def window_from_text(text, today):
    """{from, to} (YYYY-MM-DD) read out of the words of a time to call, or
    None: a month (the next time it comes round, this one if we are in it;
    "next October" the next one still to begin), a season (this one if we
    are in it or before it, else next year's; winter is Dec-Feb; "next
    spring" the next one still to begin), a year alone, or this / next
    week, month or year, or "in N weeks / months"."""
    t = " ".join(str(text or "").lower().split())
    if not t:
        return None
    ym = _YEAR_ANY.search(t)
    iso, slash = _ISO.search(t), _SLASH.search(t)
    m = int(iso.group(1)) if iso else int(slash.group(1)) if slash else 0
    if m < 1 or m > 12:
        m = 0
    name, season = _MONTH_WORD.search(t), _SEASON_WORD.search(t)
    y = int(ym.group(1)) if ym else 0
    named = not m and name is not None
    if named:
        m = _MONTHS.index(name.group(1)[:3]) + 1
    if m:
        if not y:
            if named and _next_before(t, name.start()):
                y = today.year if m > today.month else today.year + 1
            else:
                y = today.year if m >= today.month else today.year + 1
        return {"from": "%04d-%02d-01" % (y, m), "to": _last_day(y, m)}
    if season:
        a, b = _SEASON_SPAN[season.group(1)]
        if not y:
            if _next_before(t, season.start()):
                y = today.year if today.month < a else today.year + 1
            elif a <= b:
                y = today.year if today.month <= b else today.year + 1
            else:
                y = today.year - 1 if today.month <= b else today.year
        return {"from": "%04d-%02d-01" % (y, a), "to": _last_day(y + 1, b) if a > b else _last_day(y, b)}
    if y:
        return {"from": "%04d-01-01" % y, "to": "%04d-12-31" % y}
    rel, in_n = _REL.search(t), _IN.search(t)
    if rel:
        k = 1 if rel.group(1) == "next" else 0
        if rel.group(2) == "week":
            return _week_of(today + datetime.timedelta(days=7 * k))
        if rel.group(2) == "month":
            return _month_of(today.year, today.month + k)
        return {"from": "%04d-01-01" % (today.year + k), "to": "%04d-12-31" % (today.year + k)}
    if in_n:
        n = _count_of(in_n.group(1))
        if 1 <= n <= 60:
            if in_n.group(2).startswith("week"):
                return _week_of(today + datetime.timedelta(days=7 * n))
            return _month_of(today.year, today.month + n)
    return None


def window_of(c, today):
    w = c.get("when") or {}
    if isinstance(w, dict) and _DAY.match(str(w.get("from") or "")) and _DAY.match(str(w.get("to") or w.get("from"))):
        return {"from": w["from"], "to": w.get("to") or w["from"]}
    return window_from_text(c.get("contactWhen"), today)


def _reached_for(c, w):
    at = str(c.get("reachedAt") or "").strip()
    if not at or not _instant(at):
        return False
    if at[:10] < w["from"]:
        return False
    return not (c.get("whenSetAt") and str(c.get("whenSetAt")).strip() > at)


def call_state(c, today):
    """'on' (to call now), 'soon' (the window has not opened), 'done'
    (reached since it opened), or None (no time to call, or not interested)."""
    if c.get("notInterested"):
        return None, None
    w = window_of(c, today)
    if not w:
        return None, None
    if w["from"] > today.isoformat():
        return "soon", w
    if _reached_for(c, w):
        return "done", w
    return "on", w


def customers_on(db=None):
    db = db or firestore.client()
    snap = db.collection("settings").document("customers").get()
    return bool(snap.exists and (snap.to_dict() or {}).get("importOn") is True)


def call_list(today, db=None):
    """(the customer list is in use -- switched on and read in from
    QuickBooks --, [(customer, window)] due today, soonest window first)."""
    db = db or firestore.client()
    any_qb, due_now = False, []
    for s in db.collection("customers").stream():
        c = s.to_dict() or {}
        if c.get("mergedInto"):
            continue
        if c.get("qbCustomerId"):
            any_qb = True
        st, w = call_state(c, today)
        if st == "on":
            due_now.append((c, w))
    due_now.sort(key=lambda x: (x[1]["from"], str(x[0].get("name") or "").lower()))
    return any_qb, due_now


def _call_list_section(today, sections, push_bits, db):
    """The Customers tab's call list in the morning summary. False when the
    list is not in use (the Contacts list's outreach is told instead)."""
    if not customers_on(db):
        return False
    in_use, people = call_list(today, db)
    if not in_use:
        return False
    if not people:
        return True
    n = len(people)
    lines = [{"text": "📞 %d %s to call — their time to call has come. The Call list on the Customers tab." % (
        n, "customer" if n == 1 else "customers")}]
    new = [c for c, w in people if w["from"] == today.isoformat()]
    if new:
        lines.append({"text": "Starting today:"})
        for c in new[:NAMES_ON_THE_DAY]:
            svc = ", ".join(str(x) for x in (c.get("tags") or [])[:3])
            lines.append({"text": "%s%s" % (str(c.get("name") or "(no name)"), (" — " + svc) if svc else "")})
        if len(new) > NAMES_ON_THE_DAY:
            lines.append({"text": "…and %d more" % (len(new) - NAMES_ON_THE_DAY)})
        push_bits.append("%d new to call" % len(new))
    sections.append(("Call list", lines))
    return True


def add_to_summary(slot, owner, today, sections, push_bits, db=None):
    """The hook in digest.build: the owner's morning only. Never stops the
    summary going -- a fault here is printed and the rest goes out."""
    if not owner or slot != "morning":
        return
    try:
        db = db or firestore.client()
        if _call_list_section(today, sections, push_bits, db):
            return
        start, people = due(today, db)
    except Exception as e:      # noqa: BLE001
        print("digest: outreach not read:", e)
        return
    if not start or today < start:
        return
    n = len(people)
    many = "%d %s" % (n, "person" if n == 1 else "people")
    if today == start:
        lines = [{"text": ("📞 Today's the day to start reaching out for next season — %s to contact. "
                           "They're at the top of the Contacts tab." % many) if n else
                  "📞 Next season's outreach starts today — nobody on the contact list is due yet."}]
        for p in people[:NAMES_ON_THE_DAY]:
            svc = ", ".join(str(x) for x in (p.get("services") or [])[:3])
            lines.append({"text": "%s%s" % (str(p.get("name") or "(no name)"), (" — " + svc) if svc else "")})
        if n > NAMES_ON_THE_DAY:
            lines.append({"text": "…and %d more" % (n - NAMES_ON_THE_DAY)})
        sections.append(("Next season outreach", lines))
        push_bits.append("start reaching out: %d to contact" % n if n else "outreach starts today")
    elif n:
        sections.append(("Next season outreach", [{"text": "📞 %s still to reach out to for next season — "
                                                           "top of the Contacts tab" % many}]))
