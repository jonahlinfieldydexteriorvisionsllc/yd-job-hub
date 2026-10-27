"""Estimates that learn from finished jobs (Jonah's yes, 26 Oct 2026: "estimates
that learn from finished jobs").

When Claude builds or talks about a bid (estimates.py draft), it is shown the
few finished jobs most like it -- the work and materials they were bid with,
their price, how many crew-days they really took on the clock, and what the
crew said went wrong -- and, for each kind of work on this bid that at least
MIN_JOBS finished jobs had, what those were bid at against what they really
took. So it stops forgetting what Jonah always includes on a job like this,
and the crew-days it suggests (only when he asks -- his call, estimates.SYSTEM)
follow what jobs really take.

All of it is plain code (Jonah's rule: code over Claude): which jobs are
finished, their hours, the averages, and which jobs are most alike. Claude only
reads the result, in the message -- not the cached rules, since it changes
with the bid -- and Jonah's own rules text stays the final word.

FINISHED: the job's one stage (stages.stage_of) is finished, invoiced or paid;
not on its way off the books (removeWhy, deletedAt -- duplicates, snow
contracts moved to the Snow tab), not a snow bid, not the job being bid.

HOW LONG IT REALLY TOOK -- the same sums as Estimate vs actual (jobcosts.js
actualSide): the clock's approved shifts on the job (kind 'job', status ok or
approved) at their paid hours -- clock-in to clock-out, a pause included: the
crew are paid through it and the job had them that long -- plus the labour
hours typed on the job, divided by Hours in a crew-day (pricing/rules
.crewDayHours: the whole crew's paid hours in one crew-day -- People in a crew
x Hours each, saved together by the Pricing rules screen). Nothing is assumed
when that is not set: the hours are given, no
crew-days. A figure set by hand on Estimate vs actual (costByHand.act.crewDays)
wins.

WHAT IT WAS BID AT, in crew-days, the same way (estimateSide): a figure by hand
(costByHand.est.crewDays), else the last version sent to QuickBooks with its
cost kept (sent[].cost.crewDays), else the estimate's lines' crew-days added up
(not a line done by someone else -- it takes none of his crew's days).

MOST ALIKE: shared services count most, then shared kinds of work (the same
word groups as services.js GUESS), then shared words in the work and the
materials -- the rarer a word among his finished jobs, the more it counts.

NEVER SENT TO CLAUDE: a customer's name, address, email or phone. Each job is
"Job A" with its town; its own name and address are taken out of every word of
it that is sent (scopes, titles, the crew's notes), and so is anything that
reads as a street address, an email or a phone number.

Read once per server instance and kept CACHE_SECONDS: a few hundred quick
reads, nothing stored anywhere new -- no second copy of prices and hours to
keep private, and no document that outgrows Firestore as the years of jobs
pile up.
"""

import math
import re
import time
from datetime import datetime

import digest as dg
import stages

CACHE_SECONDS = 1800
MIN_JOBS = 3                # a kind of work is averaged once this many finished jobs had it
SHOW_MAX = 5                # similar jobs shown at most
KINDS_MAX = 5               # kinds-of-work lines at most
TEXT_BUDGET = 5200          # the jobs' part of the message, in characters (about 1,300 tokens)
MIN_SCORE = 1.5             # less alike than this is no example
SCOPE_CHARS = 200
WORK_MAX = 4
MATS_MAX = 10
ISSUES_MAX = 4

_cache = {"at": 0.0, "records": None}

# Only what a record is made from is read (a job carries its whole estimate
# conversation, its photos list, its orders...).
JOB_FIELDS = ["jobStatus", "bidStage", "workStage", "qbInvoiceRef", "qbEstimate", "qbInvoiced", "removeWhy",
              "deletedAt", "serviceTypes", "estimate.work", "estimate.materials", "estimate.sent", "estimate.snow",
              "estimate.snowBid", "costByHand", "labor", "jobPrice", "completedAt", "city", "customerName",
              "firstName", "lastName", "business", "address", "email", "phone"]
SHIFT_FIELDS = ["kind", "targetId", "status", "paidHours", "startedMs", "endedMs", "startedAt", "endedAt"]

# The kinds of work (services.js GROUPS / GUESS -- keep the same): first match
# wins, in this order. Snow and "Other" are never a kind of work here.
GROUP_NAMES = {"hardscape": "Hardscaping", "landscape": "Landscaping & planting", "lawn": "Lawn care",
               "drainage": "Drainage", "seasonal": "Seasonal & cleanup", "trees": "Trees"}
GUESS = [
    ("snow", re.compile(r"snow|\bice\b|salt|plow")),
    ("trees", re.compile(r"\btrees?\b|stump")),
    ("drainage", re.compile(r"drain|grading|gutter|downspout|french")),
    ("seasonal", re.compile(r"clean ?-?up|\bleaf|leaves|haul")),
    ("hardscape", re.compile(r"patio|walkway|wall|paver|stone|fire ?pit|hardscap|cedar|pergola|structure|\bsteps?\b|concrete")),
    ("landscape", re.compile(r"shrub|plant|mulch|landscap|garden|\bbeds?\b")),
    ("lawn", re.compile(r"mow|trim|edging|blowing|fertili|weed|aerat|seed|lawn|\bsod\b|turf|restoration|maintenance")),
]
SNOW_WORDS = re.compile(r"snow|\bice\b|salt|plow", re.I)

# Words that say nothing about what a job is.
STOP = set("""
a an and are as at be been by for from has have in into is it its of on or our over so than that the their them then
there these they this those to under up was we were will with your you yd all any each per plus also about approx
approximately existing new old area areas job jobs work install installed installing installation remove removed removal
include includes including included provide provided supply supplied customer client site property yard front back side
left right around along between both one two three four five six seven eight nine ten feet foot inch inches ton tons
yard yards sq ft lf cu yd lb lbs bag bags each pallet roll rolls piece pieces day days crew labor labour material materials
""".split())

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
PHONE = re.compile(r"\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b")
# A house (or rural fire) number and a street written as one: "1234 N Main
# St", "W123 County Rd". The street's name is capitalised, so "6 in of 3/4
# road gravel" is not an address; a job's own address is taken out whatever
# its capitals (_scrubber).
STREET = re.compile(r"\b[NSEW]?\d{1,6}\s+(?:[NSEW]\.?\s+)?"
                    r"(?:(?!(?:Ton|Tons|Yd|Yds|Yard|Yards|Ft|Feet|Lb|Lbs|Bag|Bags|Sq|Cu|In|Inch|Each)\b)[A-Z][\w'.-]*\s+){1,3}"
                    r"(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Cir|Circle|Blvd|Boulevard|Way|Pl|Place|"
                    r"Pkwy|Parkway|Trl|Trail|Ter|Terrace|Hwy|Highway)\b\.?")
# A QuickBooks line's "(qty x rate)" after its name (quickbooks.py _hub_estimate).
QTY_RATE = re.compile(r"\s*\([^)]*×[^)]*\)\s*$")


# ------------------------------------------------------------- small helpers

def _num(v):
    try:
        n = float(v)
        return n if n == n and abs(n) != float("inf") else None
    except (TypeError, ValueError):
        return None


def _money(v):
    """'$1,234.50' / 1234.5 / '1234' -> 1234.5, or None."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return _num(v)
    return _num(re.sub(r"[$,\s]", "", str(v or "")))


def _clip(s, n):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    if len(s) <= n:
        return s
    cut = s[:n].rsplit(" ", 1)[0]
    return (cut or s[:n]).rstrip(",;:-") + "…"


def _days(v):
    """2.5 -> '2.5', 3.0 -> '3'."""
    return ("%.1f" % v).rstrip("0").rstrip(".") if v is not None else "?"


def _qty(v):
    n = _num(v)
    if n is None:
        return ""
    return ("%.2f" % n).rstrip("0").rstrip(".")


def _key(name):
    return re.sub(r"[^a-z0-9]+", "", str(name or "").lower())


def _words(text):
    """The words that say what a job is: lower case, no numbers or filler,
    a plural as its singular."""
    out = set()
    for w in re.findall(r"[a-z]+", str(text or "").lower()):
        if len(w) < 3 or w in STOP:
            continue
        if len(w) > 4 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        if w not in STOP:
            out.add(w)
    return out


def _groups(texts, every=False):
    """The kinds of work names and headings sound like (services.js
    guessGroup: the first that fits). `every`: each kind a longer piece of
    writing -- his site notes -- mentions."""
    out = set()
    for t in texts:
        n = str(t or "").lower()
        for g, rx in GUESS:
            if rx.search(n):
                if g in GROUP_NAMES:
                    out.add(g)
                if not every:
                    break
    return out


def _entry_hours(e):
    """A labour row typed on the job (app.js entryHours)."""
    if not isinstance(e, dict):
        return 0.0
    if e.get("minutes") not in (None, ""):
        t = (_num(e.get("hours")) or 0) + (_num(e.get("minutes")) or 0) / 60
        return t if t > 0 else 0.0
    if e.get("hours") not in (None, ""):
        h = _num(e.get("hours"))
        return h if h is not None and h >= 0 else 0.0
    a, b = _clock(e.get("start")), _clock(e.get("end"))
    return (b - a) / 60 if a is not None and b is not None and b > a else 0.0


def _clock(t):
    m = re.match(r"^\s*(\d{1,2}):(\d{2})\s*([ap])?\.?\s*m?\.?\s*$", str(t or ""), re.I)
    if not m:
        return None
    h, mins = int(m.group(1)), int(m.group(2))
    if m.group(3):
        h = (0 if h == 12 else h) + (12 if m.group(3).lower() == "p" else 0)
    return h * 60 + mins if h < 24 and mins < 60 else None


def _ms(e, ms_key, at_key):
    v = e.get(ms_key)
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    s = e.get(at_key)
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def _hand(job, side):
    e = ((job.get("costByHand") or {}).get(side) or {}).get("crewDays")
    v = _num(e.get("v")) if isinstance(e, dict) else None
    return v if v is not None and v >= 0 else None


# --------------------------------------------------------- what is finished

def is_finished(job):
    if stages.stage_of(job) not in ("finished", "invoiced", "paid"):
        return False
    if job.get("removeWhy") or job.get("deletedAt"):
        return False
    est = job.get("estimate") or {}
    if isinstance(est.get("snow"), dict) or est.get("snowBid") is True:
        return False
    services = [str(s) for s in job.get("serviceTypes") or [] if str(s).strip()]
    work = [w for w in est.get("work") or [] if isinstance(w, dict)]
    # Snow work only (a contract kept as a job): not a job to learn a bid from.
    if services and all(SNOW_WORDS.search(s) for s in services) and not any(
            not SNOW_WORDS.search(str(w.get("title") or "")) for w in work):
        return False
    return True


def _bid_days(job):
    """Crew-days it was bid at (jobcosts.js estimateSide), or None."""
    hand = _hand(job, "est")
    if hand is not None:
        return hand
    est = job.get("estimate") or {}
    sent = [v for v in est.get("sent") or [] if isinstance(v, dict) and isinstance(v.get("cost"), dict)
            and _num(v["cost"].get("priceCents")) is not None]
    if sent:
        d = _num(sent[-1]["cost"].get("crewDays"))
        if d and d > 0:
            return d
    total = sum(_num(w.get("crewDays")) or 0 for w in est.get("work") or []
                if isinstance(w, dict) and not w.get("sub") and (_num(w.get("crewDays")) or 0) > 0)
    return total if total > 0 else None


def _names(job):
    """(whole names, single names) a job's customer goes by: the name on the
    job, the business, first and last; and each name on its own."""
    first, last = str(job.get("firstName") or "").strip(), str(job.get("lastName") or "").strip()
    whole = [str(n or "").strip() for n in (job.get("customerName"), job.get("business"),
                                             (first + " " + last).strip(), (last + " " + first).strip())]
    singles = [first, last]
    # A person's name typed as the customer name (no business): its words too.
    name = str(job.get("customerName") or "")
    if not str(job.get("business") or "").strip() and 2 <= len(name.split()) <= 3:
        singles += re.split(r"[\s,&/]+", name)
    singles = [n.strip(".'") for n in singles]
    return ([n for n in whole if len(n) >= 4],
            [n[0].upper() + n[1:] for n in singles if len(n) >= 3 and n[0].isalpha()])


def _either(names, flags=0):
    """One pattern for any of the names, each a whole word (or words)."""
    names = sorted({n for n in names if n}, key=len, reverse=True)
    if not names:
        return None
    return re.compile(r"(?<![\w@])(?:%s)(?![\w@])" % "|".join(re.escape(n) for n in names), flags)


def _others(whole, last):
    """Every customer's whole names and last names as two patterns, made once
    for all the records (a pattern per record with every name in it took
    seconds once there were a few hundred jobs)."""
    return (_either(whole, re.I), _either(last))


def _scrubber(job, corpus="", others=(None, None)):
    """Takes customers out of a piece of a job's text: this job's customer --
    name, business, address, email, phone -- and every other customer's
    whole name and last name (others: _others of every job on the books), and
    anything that reads like a street address, an email or a phone number.
    A name on its own goes only where it is written with its capital, and not
    at all when this job's own words use it as an ordinary word (a customer
    named Stone, a patio of stone; a Holly and the holly shrubs): the whole
    name still goes everywhere."""
    whole, singles = _names(job)
    ordinary = set(re.findall(r"\b[a-z]+\b", EMAIL.sub(" ", str(corpus or ""))))
    alone = [n for n in singles if n.lower() not in ordinary]
    addr = str(job.get("address") or "").strip()
    places = [a for a in (addr, addr.split(",")[0].strip()) if len(a) >= 6]
    contact = [str(v).strip() for v in (job.get("email"), job.get("phone")) if str(v or "").strip()]
    rx_place, rx_contact = _either(places, re.I), _either(contact, re.I)
    rx_whole, rx_alone = _either(whole, re.I), _either(alone)
    rx_others, rx_others_last = others

    def name_unless_ordinary(m):
        return m.group(0) if m.group(0).lower() in ordinary else "the customer"

    def scrub(text):
        t = str(text or "")
        if rx_place:
            t = rx_place.sub("[address]", t)
        if rx_contact:
            t = rx_contact.sub("[contact]", t)
        t = EMAIL.sub("[email]", t)
        t = PHONE.sub("[phone]", t)
        for rx in (rx_whole, rx_others):
            if rx:
                t = rx.sub("the customer", t)
        t = STREET.sub("[address]", t)
        if rx_alone:
            t = rx_alone.sub("the customer", t)
        if rx_others_last:
            t = rx_others_last.sub(name_unless_ordinary, t)
        return t
    return scrub


# ----------------------------------------------------------- the records

def _read(db):
    """Every finished job as a record (no customer in it but its job id, for
    the app): what was bid, its price, the hours on it, the crew's issues."""
    jobs, whole, last = {}, set(), set()
    for s in db.collection("jobs").select(JOB_FIELDS).stream():
        j = s.to_dict() or {}
        # Every customer's name, finished or not: a scope or a crew note can
        # name a neighbour who is one.
        w, _ = _names(j)
        whole.update(w)
        ln = str(j.get("lastName") or "").strip()
        if len(ln) >= 4 and ln[0].isalpha():
            last.add(ln[0].upper() + ln[1:])
        if is_finished(j):
            jobs[s.id] = j
    if not jobs:
        return []
    others = _others(whole, last)
    hours, days = {}, {}
    q = db.collection("timeEntries").where("kind", "==", "job").select(SHIFT_FIELDS)
    for s in q.stream():
        e = s.to_dict() or {}
        jid = e.get("targetId")
        if jid not in jobs or e.get("kind") != "job" or e.get("status") not in ("ok", "approved"):
            continue
        start, end = _ms(e, "startedMs", "startedAt"), _ms(e, "endedMs", "endedAt")
        if not start or end is None:
            continue                                    # still running: not a finished job's hours
        paid = _num(e.get("paidHours"))
        h = paid if paid is not None else max(0.0, end - start) / 3600000
        hours[jid] = hours.get(jid, 0.0) + h
        days.setdefault(jid, set()).add(datetime.fromtimestamp(start / 1000, dg.TZ).date())
    issues = {}
    try:
        for s in db.collection("crewNotes").where("kind", "==", "issue").stream():
            n = s.to_dict() or {}
            if n.get("jobId") in jobs and isinstance(n.get("issue"), dict) and not n.get("deletedAt"):
                issues.setdefault(n["jobId"], []).append(n)
    except Exception as e:                          # noqa: BLE001
        print("pastjobs: crew issues not read:", e)
    out = []
    for jid, j in jobs.items():
        out.append(_record(jid, j, hours.get(jid, 0.0), len(days.get(jid, ())), issues.get(jid, []), others))
    return out


def _record(jid, j, clock_hours, clock_days, issues, others=(None, None)):
    est = j.get("estimate") or {}
    corpus = " ".join([str(w.get("title") or "") + " " + str(w.get("scope") or "")
                       for w in est.get("work") or [] if isinstance(w, dict)] +
                      [str(m.get("name") or "") for m in est.get("materials") or [] if isinstance(m, dict)])
    scrub = _scrubber(j, corpus, others)
    services = []
    for s in j.get("serviceTypes") or []:
        s = str(s or "").strip()
        if s and not SNOW_WORDS.search(s) and _key(s) not in {_key(x) for x in services}:
            services.append(s[:60])
    work = []
    for w in est.get("work") or []:
        if not isinstance(w, dict):
            continue
        title = QTY_RATE.sub("", str(w.get("title") or "")).strip()
        scope = str(w.get("scope") or "").strip()
        # A scope often starts with its own heading again.
        if title and scope.lower().startswith(title.lower()):
            scope = scope[len(title):].lstrip(" :-—\n")
        work.append({"title": _clip(scrub(title), 70), "scope": _clip(scrub(scope), SCOPE_CHARS),
                     "kind": str(w.get("kind") or "crew"), "days": _num(w.get("crewDays")),
                     "sub": bool(w.get("sub"))})
    mats = []
    for m in est.get("materials") or []:
        if not isinstance(m, dict) or not str(m.get("name") or "").strip():
            continue
        mats.append({"name": _clip(scrub(m.get("name")), 60), "qty": _qty(m.get("qty")),
                     "unit": _clip(m.get("unit"), 16), "plant": bool(m.get("plant"))})
    typed = sum(_entry_hours(e) for e in j.get("labor") or [])
    said = []
    for n in sorted(issues, key=lambda n: str(n.get("at") or "")):
        i = n["issue"]
        said.append({"type": str(i.get("type") or "other"), "material": _clip(scrub(i.get("material")), 60),
                     "equipment": _clip(scrub(i.get("equipment")), 40), "work": _clip(scrub(i.get("work")), 60),
                     "amount": _clip(scrub(i.get("amount")), 60), "note": _clip(scrub(i.get("note")), 120)})
    done = str(j.get("completedAt") or "")
    price = _money(j.get("jobPrice"))
    text = " ".join(services + [w["title"] for w in work] + [w["scope"] for w in work] + [m["name"] for m in mats])
    return {
        "id": jid, "town": _clip(j.get("city"), 40), "done": done[:10],
        "price": price if price and price > 0 else None,
        "services": services, "work": work, "mats": mats, "issues": said,
        "bid": _bid_days(j), "handTook": _hand(j, "act"),
        "hours": round(clock_hours + typed, 2), "typedHours": round(typed, 2), "clockDays": clock_days,
        "groups": sorted(_groups(services + [w["title"] for w in work])),
        "words": sorted(_words(text)),
    }


def records(db):
    """The finished jobs, read at most every CACHE_SECONDS on this server."""
    now = time.time()
    if _cache["records"] is not None and now - _cache["at"] < CACHE_SECONDS:
        return _cache["records"]
    recs = _read(db)
    _cache.update(at=now, records=recs)
    return recs


def took_days(rec, day_hours):
    """Crew-days it really took, or None (no hours, or no Hours in a crew-day)."""
    if rec.get("handTook") is not None:
        return rec["handTook"]
    if rec.get("hours") and day_hours:
        return rec["hours"] / day_hours
    return None


# ----------------------------------------------------- the bid being built

def bid_facts(d):
    """What the bid says it is: its services, its kinds of work and its words
    (site notes, services, the lines so far, his latest message)."""
    cur = d.get("current") or {}
    services = [str(s).strip() for s in d.get("services") or [] if str(s).strip()]
    titles = [str(w.get("title") or "") for w in cur.get("work") or [] if isinstance(w, dict)]
    mats = [str(m.get("name") or "") for m in cur.get("materials") or [] if isinstance(m, dict)]
    asked = [str(m.get("text") or "") for m in (d.get("chat") or []) if isinstance(m, dict) and m.get("role") == "user"][-1:]
    notes = str(d.get("siteNotes") or "")[:12000]
    said = _groups([notes] + asked, every=True)
    kinds = _groups(services + titles) or said
    return {"services": {_key(s) for s in services if not SNOW_WORDS.search(s)},
            "kinds": kinds, "groups": kinds | said,
            "words": _words(" ".join(services + titles + mats + [notes] + asked))}


def similar(recs, bid, exclude=None):
    """The finished jobs most like the bid, best first: [(score, record)]."""
    pool = [r for r in recs if r["id"] != exclude]
    if not pool or not (bid["services"] or bid["groups"] or bid["words"]):
        return []
    df = {}
    for r in pool:
        for w in r["words"]:
            df[w] = df.get(w, 0) + 1
    n = len(pool)
    scored = []
    for r in pool:
        svc = len(bid["services"] & {_key(s) for s in r["services"]})
        grp = len(bid["groups"] & set(r["groups"]))
        words = sum(math.log((n + 1.0) / (df[w] + 1.0)) for w in bid["words"] & set(r["words"]))
        score = 3.0 * svc + 1.5 * grp + min(words, 6.0)
        if score < MIN_SCORE:
            continue
        # Of two as alike, the one that says how long it really took.
        if r.get("hours") or r.get("handTook") is not None:
            score += 0.5
        scored.append((score, r))
    # Most alike first; of equals, the newer.
    scored.sort(key=lambda x: x[1]["done"] or "", reverse=True)
    scored.sort(key=lambda x: -round(x[0], 6))
    return scored


def kind_stats(recs, bid, day_hours, exclude=None):
    """For each kind of work on the bid (its services, then its kinds of
    work): the finished jobs that had it AND say both what they were bid at
    and what they took, when there are at least MIN_JOBS of them."""
    if not day_hours:
        return []
    pool = [r for r in recs if r["id"] != exclude and r.get("bid") and took_days(r, day_hours)]
    out, seen_sets = [], set()
    wanted = []
    names = {}
    for r in pool:
        for s in r["services"]:
            names.setdefault(_key(s), s)
    for k in sorted(bid["services"]):
        if k in names:
            wanted.append(("svc", k, names[k]))
    for g in sorted(bid["kinds"]):
        wanted.append(("grp", g, GROUP_NAMES[g]))
    for how, k, name in wanted:
        had = [r for r in pool if (k in {_key(s) for s in r["services"]} if how == "svc" else k in r["groups"])]
        if len(had) < MIN_JOBS:
            continue
        ids = tuple(sorted(r["id"] for r in had))
        if ids in seen_sets:
            continue                                    # the same jobs as a line already given
        seen_sets.add(ids)
        bid_sum = sum(r["bid"] for r in had)
        took_sum = sum(took_days(r, day_hours) for r in had)
        out.append({"name": name, "n": len(had), "bid": round(bid_sum / len(had), 2),
                    "took": round(took_sum / len(had), 2)})
        if len(out) >= KINDS_MAX:
            break
    return out


# ------------------------------------------------------------ the message

TYPE_WORDS = {"over": "too much %s", "short": "ran short on %s", "equipment": "needed %s we didn't have",
              "time": "took longer%s", "site": "site problem", "other": "something else"}


def _issue_text(i):
    t = i["type"]
    if t in ("over", "short"):
        s = TYPE_WORDS[t] % (i["material"] or "material")
    elif t == "equipment":
        s = TYPE_WORDS[t] % (i["equipment"] or "equipment")
    elif t == "time":
        s = TYPE_WORDS[t] % ((" on " + i["work"]) if i["work"] else "")
    else:
        s = TYPE_WORDS.get(t, "something else")
    said = "; ".join(x for x in (i["amount"], i["note"]) if x)
    return s + (' ("%s")' % said if said else "")


def _pct(took, bid):
    if not bid:
        return ""
    p = round((took / bid - 1) * 100)
    return " (%s%d%%)" % ("+" if p > 0 else "", p) if p else " (right on)"


def _job_text(letter, r, day_hours):
    head = "Job %s -- %s" % (letter, ", ".join(x for x in (
        r["town"], ("finished " + _month(r["done"])) if r["done"] else "",
        ("price $%s" % format(int(round(r["price"])), ",")) if r["price"] else "") if x))
    rows = [head + "."]
    if r["services"]:
        rows.append("  Services: %s." % ", ".join(r["services"][:6]))
    work = []
    for w in r["work"][:WORK_MAX]:
        bits = []
        if w["sub"]:
            bits.append("done by someone else")
        elif w["days"]:
            bits.append("%s crew-days" % _days(w["days"]))
        work.append("%s%s%s" % (w["title"] or "Work", (" (%s)" % ", ".join(bits)) if bits else "",
                                (": " + w["scope"]) if w["scope"] else ""))
    if work:
        more = len(r["work"]) - WORK_MAX
        rows.append("  Work bid: " + " | ".join(work) + (" | and %d more" % more if more > 0 else ""))
    if r["mats"]:
        mats = ["%s %s %s" % (m["name"], m["qty"], m["unit"]) if m["qty"] else m["name"] for m in r["mats"][:MATS_MAX]]
        more = len(r["mats"]) - MATS_MAX
        rows.append("  Materials bid: " + "; ".join(re.sub(r"\s+", " ", x).strip() for x in mats) +
                    ("; and %d more" % more if more > 0 else ""))
    took = took_days(r, day_hours)
    if r.get("handTook") is not None:
        rows.append("  Really took: %s crew-days (set by Jonah)%s." % (
            _days(took), (" -- bid %s%s" % (_days(r["bid"]), _pct(took, r["bid"]))) if r["bid"] else ""))
    elif r["hours"]:
        where = "%d paid crew hours" % round(r["hours"])
        if r["clockDays"] and not r["typedHours"]:
            where += ", %d day%s on site" % (r["clockDays"], "" if r["clockDays"] == 1 else "s")
        if took is not None:
            rows.append("  Really took: %s crew-days (%s)%s." % (
                _days(took), where, (" -- bid %s%s" % (_days(r["bid"]), _pct(took, r["bid"]))) if r["bid"] else ""))
        else:
            rows.append("  Really took: %s%s." % (where, (" -- bid %s crew-days" % _days(r["bid"])) if r["bid"] else ""))
    else:
        rows.append("  Really took: no hours on record%s." % ((" (bid %s crew-days)" % _days(r["bid"])) if r["bid"] else ""))
    if r["issues"]:
        rows.append("  The crew said: " + "; ".join(_issue_text(i) for i in r["issues"][:ISSUES_MAX]) + ".")
    return "\n".join(rows)


def _month(day):
    try:
        return datetime.strptime(day[:7], "%Y-%m").strftime("%b %Y")
    except ValueError:
        return ""


def for_estimate(db, d):
    """(text for the message, what the app shows) -- ("", None) when there is
    nothing to show or it is switched off. Reads pricing/rules each time, so
    the switch and Hours in a crew-day apply at once."""
    snap = db.collection("pricing").document("rules").get()
    rules = (snap.to_dict() or {}) if snap.exists else {}
    if rules.get("learnFromJobs") is False:
        return "", None
    day_hours = _num(rules.get("crewDayHours"))
    day_hours = day_hours if day_hours and day_hours > 0 else None
    recs = records(db)
    exclude = str(d.get("jobId") or "") or None
    bid = bid_facts(d)
    picked = similar(recs, bid, exclude)
    kinds = kind_stats(recs, bid, day_hours, exclude)
    if not picked and not kinds:
        return "", None
    finished = len([r for r in recs if r["id"] != exclude])
    blocks, shown = [], []
    used = 0
    for score, r in picked[:SHOW_MAX]:
        t = _job_text("ABCDEFGH"[len(shown)], r, day_hours)
        if shown and used + len(t) > TEXT_BUDGET:
            break
        blocks.append(t)
        used += len(t)
        shown.append(r)
    head = ("JONAH'S FINISHED JOBS -- what jobs like this one really took, worked out by the app from his own records "
            "and the crew's clock (%s of his %d finished jobs on record). They are examples, not rules: his takeoff and "
            "estimate rules above always win. Use them (1) to check this estimate is not missing work or materials he "
            "usually includes on a job like this, and (2) when crew-days come up -- asking him for them, or when he "
            "asks you to suggest them -- to say what similar jobs really took. %sTheir prices only show each job's "
            "size: never suggest or set a price from them -- the app does every sum. Few jobs is a small sample: "
            "whenever you use these figures, say how many jobs they come from." % (
                ("the %d most like it" % len(shown)) if shown else "none close enough to show",
                finished,
                ("A crew-day is %s paid crew hours (his Pricing rules). " % _qty(day_hours)) if day_hours else
                "(Hours in a crew-day is not set in his Pricing rules, so the clock's hours are not turned into "
                "crew-days.) "))
    parts = [head] + blocks
    if kinds:
        parts.append("KINDS OF WORK on this bid that at least %d finished jobs had (whole jobs that included it, "
                     "what they were bid at against the clock):\n" % MIN_JOBS +
                     "\n".join("- %s (%d jobs): bid %s crew-days on average, really took %s%s." % (
                         k["name"], k["n"], _days(k["bid"]), _days(k["took"]), _pct(k["took"], k["bid"]))
                         for k in kinds))
    info = {"finished": finished, "dayHours": day_hours, "kinds": kinds,
            "jobs": [{"id": r["id"], "bid": r["bid"], "took": round(took_days(r, day_hours), 2)
                      if took_days(r, day_hours) is not None else None,
                      "hours": round(r["hours"]) if r["hours"] else None} for r in shown]}
    return "\n\n".join(parts), info
