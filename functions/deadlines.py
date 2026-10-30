"""Tax & filing dates: the owner's phone told 14 days before, 3 days before,
on the day and the day after, until the date is ticked off in Job Hub.

Jonah's routine 10 of 14 (wish card, 26 Oct 2026). The dates are worked out
from the SAME rules as deadlines.js (keep the two in step: keys and dates
must agree, or a date ticked off in the app keeps buzzing) and his settings
in settings/deadlines. Once a day after 7 am, on the five-minute reminders
run (reminders.py), plain code.

The sales tax return carries its number: the sales tax charged in the period,
read from QuickBooks (invoices and sales receipts less credit memos, by
their dates) and kept in settings/deadlines.numbers for the app to show.
QuickBooks' own Sales tax page stays the one to file from.
"""

import calendar
import datetime

import digest as dg

STATE = ("settings", "deadlines")
LEADS = (14, 3, 0, -1)          # days before the date (-1: the day after, still not ticked)
FROM_HOUR = 7
# The clock began here (30 Oct 2026), as deadlines.js FROM: a date before it is never told as late.
FROM = datetime.date(2026, 10, 30)
NUMBER_DAYS = 45                # the sales tax figure kept up to date this close to its date
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December"]
SHORT = [m[:3] for m in MONTHS]


def _nec(y):
    return "$2,000" if y >= 2026 else "$600"


# ---------------------------------------------------------------- dates (as deadlines.js)

def _last_day(y, m):
    return calendar.monthrange(y, m)[1]


def _nth(y, m, wd, n):
    """The nth (1-based; -1 the last) weekday of a month. wd: Monday 0 (Python)."""
    if n < 0:
        d = _last_day(y, m)
        while datetime.date(y, m, d).weekday() != wd:
            d -= 1
        return datetime.date(y, m, d)
    d = 1
    while datetime.date(y, m, d).weekday() != wd:
        d += 1
    return datetime.date(y, m, d + 7 * (n - 1))


def holidays(y):
    out = set()
    for m, d in ((1, 1), (6, 19), (7, 4), (11, 11), (12, 25)):
        day = datetime.date(y, m, d)
        if day.weekday() == 5:
            day -= datetime.timedelta(days=1)
        elif day.weekday() == 6:
            day += datetime.timedelta(days=1)
        out.add(day)
    out |= {_nth(y, 1, 0, 3), _nth(y, 2, 0, 3), _nth(y, 5, 0, -1), _nth(y, 9, 0, 1), _nth(y, 10, 0, 2),
            _nth(y, 11, 3, 4)}
    return out


def workday(day):
    """A date on a weekend or federal holiday moves to the next working day."""
    h = holidays(day.year) | holidays(day.year + 1)
    while day.weekday() >= 5 or day in h:
        day += datetime.timedelta(days=1)
    return day


def _iso(d):
    return d.strftime("%Y-%m-%d")


def built_in(y, c):
    out = []
    st = c.get("salesTax")
    if st == "monthly":
        for m in range(1, 13):
            ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
            out.append({"rule": "salesTax", "key": "salesTax_%d-%02d" % (y, m), "label": "%s %d" % (MONTHS[m - 1], y),
                        "from": datetime.date(y, m, 1), "to": datetime.date(y, m, _last_day(y, m)),
                        "due": workday(datetime.date(ny, nm, _last_day(ny, nm)))})
    elif st == "quarterly":
        for q in range(1, 5):
            em = q * 3
            ny, nm = (y + 1, 1) if q == 4 else (y, em + 1)
            out.append({"rule": "salesTax", "key": "salesTax_%d-Q%d" % (y, q),
                        "label": "%s–%s %d" % (SHORT[em - 3], SHORT[em - 1], y),
                        "from": datetime.date(y, em - 2, 1), "to": datetime.date(y, em, _last_day(y, em)),
                        "due": workday(datetime.date(ny, nm, _last_day(ny, nm)))})
    elif st == "annual":
        out.append({"rule": "salesTax", "key": "salesTax_%d" % y, "label": str(y), "from": datetime.date(y, 1, 1),
                    "to": datetime.date(y, 12, 31), "due": workday(datetime.date(y + 1, 1, 31))})
    for x in out:
        x["name"] = "Wisconsin sales tax return — " + x["label"]
    for i, (d, months) in enumerate(((datetime.date(y, 4, 15), "Jan–Mar"), (datetime.date(y, 6, 15), "Apr–May"),
                                     (datetime.date(y, 9, 15), "Jun–Aug"), (datetime.date(y + 1, 1, 15), "Sep–Dec"))):
        out.append({"rule": "estTax", "key": "estTax_%d-%d" % (y, i + 1), "due": workday(d), "label": "%s %d" % (months, y),
                    "name": "Estimated tax %d of 4 for %d — federal and Wisconsin" % (i + 1, y)})
    out.append({"rule": "returns", "key": "returns_%d" % (y - 1), "due": workday(datetime.date(y, 4, 15)), "label": str(y - 1),
                "name": "Income tax returns for %d — federal and Wisconsin" % (y - 1)})
    out.append({"rule": "nec", "key": "nec_%d" % (y - 1), "due": workday(datetime.date(y, 1, 31)), "label": str(y - 1),
                "name": "1099-NECs for %d — everyone paid %s+ (to them and the IRS)" % (y - 1, _nec(y - 1))})
    md = str(c.get("llcReport") or "")
    try:
        m, d = int(md[:2]), int(md[3:5])
    except ValueError:
        m, d = 6, 30
    m = min(12, max(1, m))
    d = min(_last_day(y, m), max(1, d))
    out.append({"rule": "llcReport", "key": "llcReport_%d" % y, "due": workday(datetime.date(y, m, d)), "label": str(y),
                "name": "Wisconsin LLC annual report (DFI, $25 online)"})
    off = c.get("off") or {}
    return [x for x in out if not off.get(x["rule"])]


def own(y, c):
    out = []
    for it in c.get("items") or []:
        try:
            start = datetime.date.fromisoformat(str(it.get("date")))
        except (TypeError, ValueError):
            continue
        if not it.get("id"):
            continue
        if it.get("every") == "year":
            due = datetime.date(y, start.month, min(start.day, _last_day(y, start.month)))
        else:
            due = start if start.year == y else None
        if due and due >= start:
            out.append({"rule": "own", "id": it["id"], "key": "own_%s_%s" % (it["id"], _iso(due)), "due": due,
                        "name": it.get("name") or "A date of yours", "note": it.get("note") or "", "label": ""})
    return out


def between(first, last, c):
    out = []
    for y in range(first.year - 1, last.year + 2):
        for x in built_in(y, c) + own(y, c):
            if first <= x["due"] <= last:
                x["done"] = bool((c.get("done") or {}).get(x["key"]))
                out.append(x)
    out.sort(key=lambda x: (x["due"], x["name"]))
    return out


# ---------------------------------------------------------------- the sales tax figure

def tax_charged(first, last):
    """Sales tax on QuickBooks invoices and sales receipts dated in the
    period, less credit memos: (cents, invoices with tax on them)."""
    import quickbooks as qb
    cents, docs = 0, 0
    for entity, sign in (("Invoice", 1), ("SalesReceipt", 1), ("CreditMemo", -1)):
        start = 1
        while True:
            rows = qb._query(entity, "TxnDate >= '%s' AND TxnDate <= '%s' STARTPOSITION %d MAXRESULTS 1000"
                             % (_iso(first), _iso(last), start))
            for r in rows:
                t = float(((r.get("TxnTaxDetail") or {}).get("TotalTax")) or 0)
                cents += sign * int(round(t * 100))
                if sign > 0 and t:
                    docs += 1
            if len(rows) < 1000:
                break
            start += 1000
    return cents, docs


def _money(cents):
    return "${:,.2f}".format(cents / 100.0)


def needs(x, c, today):
    if x["rule"] == "salesTax":
        n = (c.get("numbers") or {}).get(x["key"]) or {}
        if isinstance(n.get("cents"), (int, float)):
            return "Sales tax charged %sin %s: %s on %d invoice%s" % (
                "so far " if today <= x["to"] else "", x["label"], _money(n["cents"]), n.get("docs") or 0,
                "" if n.get("docs") == 1 else "s")
        return "The sales tax charged in %s — QuickBooks › Taxes" % x["label"]
    if x["rule"] == "nec":
        return "Each person's W-9 and what they were paid in " + x["label"]
    if x["rule"] == "llcReport":
        return "apps.dfi.wi.gov"
    return x.get("note") or ""


# ---------------------------------------------------------------- running

def _when(day, today):
    n = (day - today).days
    words = day.strftime("%a %b ") + str(day.day)
    if n == 0:
        return "today"
    if n == 1:
        return "tomorrow, " + words
    if n < 0:
        return "%s — not ticked off yet" % words
    return "in %d days, %s" % (n, words)


def run(db, people, now=None):
    """Once a day after 7 am: keep the sales tax figures fresh, then tell the
    owner of every date 14 / 3 / 0 days away (or a day past) not ticked off."""
    from google.api_core.exceptions import AlreadyExists
    now = now or dg._now()
    if now.hour < FROM_HOUR:
        return []
    today = now.date()
    try:
        db.collection("reminderLog").document("deadlines_" + _iso(today)).create({"at": now.isoformat()})
    except AlreadyExists:
        return []
    ref = db.collection(STATE[0]).document(STATE[1])
    snap = ref.get()
    c = (snap.to_dict() or {}) if snap.exists else {}
    near = between(max(today - datetime.timedelta(days=2), FROM), today + datetime.timedelta(days=NUMBER_DAYS), c)
    numbers = {}
    for x in near:
        if x["rule"] == "salesTax" and not x["done"] and x["from"] <= today:
            try:
                cents, docs = tax_charged(x["from"], min(x["to"], today))
                numbers[x["key"]] = {"cents": cents, "docs": docs, "at": now.isoformat()}
            except Exception as e:      # noqa: BLE001 -- the reminder still goes, without its figure
                print("deadlines: sales tax not read from QuickBooks:", e)
    if numbers:
        ref.set({"numbers": numbers}, merge=True)
        c["numbers"] = dict(c.get("numbers") or {}, **numbers)
    sent = []
    owners = [uid for uid, u in people.items() if u.get("role") == "owner"]
    for x in near:
        lead = (x["due"] - today).days
        if x["done"] or lead not in LEADS:
            continue
        head = {14: "\U0001F4C5 In 2 weeks", 3: "\U0001F4C5 Due in 3 days", 0: "\U0001F4C5 Due today",
                -1: "\U0001F4C5 Past due"}[lead]
        bits = [_when(x["due"], today), needs(x, c, today)]
        note = {"push": {"title": (head + ": " + x["name"])[:110], "body": " · ".join(b for b in bits if b)}}
        for uid in owners:
            try:
                sent.append({"uid": uid, "deadline": x["key"], "lead": lead,
                             "phones": dg.send_push(uid, note, tag="yd-deadline-" + x["key"], ttl=20 * 3600,
                                                    opens="deadlines")})
            except Exception as e:      # noqa: BLE001
                print("deadlines: push failed:", uid, x["key"], e)
    return sent
