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


def add_to_summary(slot, owner, today, sections, push_bits, db=None):
    """The hook in digest.build: the owner's morning only. Never stops the
    summary going -- a fault here is printed and the rest goes out."""
    if not owner or slot != "morning":
        return
    try:
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
