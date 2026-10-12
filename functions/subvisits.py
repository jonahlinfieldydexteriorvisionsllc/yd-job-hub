"""YD Job Hub -- a subcontractor's visits, counted from their invoice emails.

Jonah (12 Oct 2026): "i want the sub section for vances mowing to track the
number of mows that have happened for each client by pulling receipts from
my email." His mowing subcontractor bills through Jobber, one email per
visit for a weekly property, with who, what and where all in the subject:

    Invoice from <Company> - Weekly Lawn Maintenance - <street address>
    Invoice from <Company> - Monthly Lawn Maintenance
    Invoice from <Company> - One-Time Mow

Plain code reads them (no Claude: "code over Claude"). Every "Invoice from
<a subcontractor>" email since the start of the year becomes one visit
{date, service, address, cents, subject}. A reminder about the same invoice
-- same subject, same amount, same due date -- is the same visit, not a
second one.

Which client a visit was for, and how many mows it was, the app works out
from the properties (subs.js), and Jonah can set either by hand there. What
he sets lives in settings/subcontractors, so nothing here ever overwrites it.

Kept in settings/subVisits {visits: {key: visit}, scannedAt} -- the
owner's alone, like the subcontractors themselves (firestore.rules: settings
are the owner's unless named otherwise).
"""

import datetime
import hashlib
import re

import digest as dg
import receipts as rc

OVERLAP_DAYS = 3            # each look reaches back past the last one
MAX_PER_SUB = 400           # invoices looked at per subcontractor per run

AMOUNT = re.compile(r"\$\s?([\d,]+\.\d{2})")
DUE = re.compile(r"\bdue(?: on)?\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})", re.I)
MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun",
                                      "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
PREFIX = re.compile(r"^\s*((re|fwd?|fw)\s*:\s*)+", re.I)
FILLER = {"llc", "inc", "ltd", "corp", "co", "company", "the", "and", "of"}


def _words(s):
    """A company's name words, without "LLC" and the like (subs.js words)."""
    return [w for w in re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).split()
            if len(w) > 1 and w not in FILLER]


def names_match(sub, company):
    """Whether an invoice's company is this subcontractor: every word of
    theirs is in it -- or, run together, the same letters ("Green Acre" is
    "GreenAcre Lawn Care")."""
    want, have = _words(sub.get("match") or sub.get("name")), _words(company)
    if not want:
        return False
    return all(w in have for w in want) or "".join(want) in "".join(have)


def _query_name(sub):
    """The name to search mail for, both ways it may be written."""
    w = _words(sub.get("match") or sub.get("name"))
    return '(%s OR "%s")' % ("".join(w), " ".join(w)) if len(w) > 1 else (w[0] if w else "")


def _due(snippet):
    m = DUE.search(snippet or "")
    if not m or m.group(1).lower()[:3] not in MONTHS:
        return ""
    try:
        return datetime.date(int(m.group(3)), MONTHS[m.group(1).lower()[:3]], int(m.group(2))).isoformat()
    except ValueError:
        return ""


def parse(subject, snippet, internal_ms, sub):
    """One visit from one invoice email, or None when it is not this
    subcontractor's invoice."""
    s = PREFIX.sub("", subject or "").strip()
    m = re.match(r"^invoice(?:\s+#?\S+)?\s+from\s+(.+)$", s, re.I)
    if not m:
        return None
    rest = m.group(1)
    parts = [p.strip() for p in re.split(r"\s+[-–—]\s+", rest) if p.strip()]
    if not parts:
        return None
    if not names_match(sub, parts[0]):
        return None
    service = parts[1] if len(parts) > 1 else "Visit"
    address = " - ".join(parts[2:]) if len(parts) > 2 else ""
    amount = AMOUNT.search(snippet or "")
    cents = int(round(float(amount.group(1).replace(",", "")) * 100)) if amount else None
    sent = datetime.datetime.fromtimestamp(int(internal_ms) / 1000, dg.TZ).date().isoformat()
    due = _due(snippet)
    # The invoice goes out the day the work is done; a reminder later on
    # still carries the first due date, so it lands on the same key.
    key = "v" + hashlib.sha1(("%s|%s|%s" % (s.lower(), cents, due or sent)).encode()).hexdigest()[:16]
    return {"key": key, "date": due or sent, "sent": sent, "service": service[:80], "address": address[:120],
            "cents": cents, "subject": s[:200]}


def _since(have, full, now):
    start = datetime.date(now.year, 1, 1)
    if full:
        return start
    try:
        last = datetime.datetime.fromisoformat(str(have.get("scannedAt") or "")).date()
    except ValueError:
        return start
    return max(start, last - datetime.timedelta(days=OVERLAP_DAYS))


def scan(db, full=False):
    """Look for every subcontractor's invoices since the last look (since the
    start of the year the first time, or when `full`). Returns a report."""
    now = dg._now()
    cfg = db.collection("settings").document("subcontractors").get()
    subs = ((cfg.to_dict() or {}).get("subs") or {}) if cfg.exists else {}
    ref = db.collection("settings").document("subVisits")
    snap = ref.get()
    have = (snap.to_dict() or {}) if snap.exists else {}
    visits = have.get("visits") or {}
    seen = set()
    for v in visits.values():
        seen.update((v or {}).get("msgIds") or [])
    since = _since(have, full, now)
    found, report = {}, {"subs": 0, "looked": 0, "new": 0}
    for sid, sub in subs.items():
        if not sub or not (sub.get("name") or sub.get("match")):
            continue
        report["subs"] += 1
        name = _query_name(sub)
        if not name:
            continue
        query = '%s subject:invoice after:%s -in:sent -in:drafts -in:chats' % (name, since.strftime("%Y/%m/%d"))
        for mid in rc._list_ids(query)[:MAX_PER_SUB]:
            if mid in seen:
                continue
            msg = rc._gmail("/messages/" + mid, {"format": "metadata", "metadataHeaders": ["Subject"]})
            report["looked"] += 1
            subject = rc._header(msg, "Subject")
            v = parse(subject, msg.get("snippet") or "", msg.get("internalDate") or 0, sub)
            if not v:
                continue
            v["sub"] = sid
            key = v.pop("key")
            old = visits.get(key) or found.get(key)
            if old:
                # The same invoice again (a reminder): only the email is new.
                ids = list((old.get("msgIds") or [])) + [mid]
                found[key] = dict(old, msgIds=ids[-6:])
                continue
            v["msgIds"] = [mid]
            v["foundAt"] = now.isoformat()
            found[key] = v
            report["new"] += 1
    ref.set({"visits": found, "scannedAt": now.isoformat()}, merge=True)
    return report
