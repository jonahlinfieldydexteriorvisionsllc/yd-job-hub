"""Lessons from past jobs, brought back on the next job like it.

Jonah (30 Oct 2026, wish card): "make it so notes can be added to jobs like if
we overorderd on material or issues that arised so claude and the crew and me
can learn and do better on future jobs."

A LESSON is a job issue (jobissues.js): crewNotes/{cn...} with kind 'issue'
and its `issue` record -- noted by the crew lead on the job's page, by Jonah
or an admin on the Job tab, or by Claude when the job is finished (below).
issue.nextTime is what to do differently next time; type 'lesson' is
something to remember that was neither too much nor too little (what worked,
what to watch for). One Jonah took off has deletedAt and is never used.

They come back in three places:

  1. CLAUDE BUILDING A BID (estimates.py, through pastjobs.for_estimate): the
     lessons from the jobs most like it, with the job each came from ("Job B"
     when that job is one of the examples shown). Plain code picks them.
  2. THE CREW'S PAGE of a booked or under-way job: "Last time on a job like
     this" -- jobLessons/{jobId} {items, at}, worked out here once an hour on
     the five-minute run (crew_pages), written only when it changed. The crew
     cannot read jobs or other people's notes, so the list is made here, with
     no customer's name or address and no dollar figure in it.
  3. CLAUDE'S OWN, on a finished job (after_finish, the evening run): the
     job's daily logs, notes and the crew's issues read once, and up to three
     lessons written from them -- only when there is something to read.

WHICH LESSONS FIT A JOB -- plain code, the same for a bid and a crew page:
  - too much / ran short on a material: only when the new job has that
    material -- the same Supplies item, the same kind of material, or its
    name in the job's words (a mulch lesson is nothing to a patio);
  - anything else: when the job it came from is like the new one -- shared
    services, kinds of work and the rarer words of the work, as pastjobs
    scores the finished jobs. Took longer on a piece of work counts more
    when the new job has that kind of work.
  The newest first of the equally fitting.
"""

import datetime
import json
import math
import re

import digest as dg
import pastjobs as pj
import stages

from google.api_core.exceptions import AlreadyExists

CACHE_SECONDS = 1800
BID_MAX = 10                # lessons given to Claude with a bid
BID_CHARS = 2600            # their part of the message (about 650 tokens)
CREW_MAX = 5                # lessons on a crew page
MIN_FIT = 3.0               # less fitting than this is not shown (a shared service is 3)
CREW_EVERY = datetime.timedelta(hours=1)
STATE = ("settings", "jobLessons")
PAGES = "jobLessons"
CLAUDE_UID = "claude"       # the uid on Claude's own lessons (crewNotes)

# The job fields a lesson's job is read with: what it is (to match it) and
# who it is for (to take that out).
JOB_FIELDS = pj.JOB_FIELDS + ["estimate.notes"]

TYPE_HEAD = {"over": "Too much %s", "short": "Ran short on %s", "equipment": "Needed %s we didn't have",
             "time": "Took longer%s", "site": "Site problem", "other": "Note", "lesson": "To remember"}
ICONS = {"over": "📦", "short": "📉", "equipment": "🚜", "time": "⏰", "site": "🚧", "other": "❓", "lesson": "💡"}
TYPES = tuple(TYPE_HEAD)

# A dollar figure written into a note never reaches a crew phone
# (crewjobs.js noMoney -- the same patterns).
MONEY = [re.compile(r"[$＄]\s*\.?\d[\d,]*(\.\d+)?"), re.compile(r"\busd\s*\d[\d,]*(\.\d+)?", re.I),
         re.compile(r"\b\d[\d,]*(\.\d+)?\s?(k|grand|dollars?|bucks|usd)\b", re.I)]

_cats = {"at": 0.0, "map": None}


def no_money(s):
    s = str(s or "")
    for rx in MONEY:
        s = rx.sub("$—", s)
    return s


def _text(v, n):
    return pj._clip(v, n) if v not in (None, "") else ""


# ------------------------------------------------------------- reading

def issues(db):
    """Every lesson not taken off: [(id, note)]."""
    out = []
    for s in db.collection("crewNotes").where("kind", "==", "issue").stream():
        n = s.to_dict() or {}
        if n.get("deletedAt") or not isinstance(n.get("issue"), dict) or not n.get("jobId"):
            continue
        out.append((s.id, n))
    return out


def jobs(db, ids):
    """{id: job} for the ids, with only JOB_FIELDS."""
    ids = [i for i in dict.fromkeys(ids) if i and "/" not in str(i)]
    out = {}
    for k in range(0, len(ids), 100):
        refs = [db.collection("jobs").document(i) for i in ids[k:k + 100]]
        for s in db.get_all(refs, field_paths=JOB_FIELDS):
            if s.exists:
                out[s.id] = s.to_dict() or {}
    return out


def categories(db):
    """{supplyId: kind of material} -- Supplies' categories, kept a while."""
    import time
    now = time.time()
    if _cats["map"] is not None and now - _cats["at"] < CACHE_SECONDS:
        return _cats["map"]
    got = {}
    try:
        for s in db.collection("supplies").select(["category"]).stream():
            c = (s.to_dict() or {}).get("category")
            if c:
                got[s.id] = str(c)
    except Exception as e:                          # noqa: BLE001 -- names still match without them
        print("lessons: supplies not read:", e)
    _cats.update(at=now, map=got)
    return got


def _people(db):
    try:
        return dg._people()
    except Exception as e:                          # noqa: BLE001
        print("lessons: people not read:", e)
        return {}


# ------------------------------------------------- what a job is about

def _mat_facts(mats, cats):
    ids, kinds, words = set(), set(), set()
    for m in mats or []:
        if not isinstance(m, dict) or not str(m.get("name") or "").strip():
            continue
        sid = str(m.get("supplyId") or "")
        if sid:
            ids.add(sid)
            if cats.get(sid):
                kinds.add(pj._key(cats[sid]))
        if m.get("category"):
            kinds.add(pj._key(m.get("category")))
        if m.get("plant"):
            kinds.add("plant")
        words |= pj._words(m.get("name"))
    return ids, kinds, words


def job_profile(j, cats):
    """What a job is about, to match lessons by: its services, kinds of work,
    words, and its materials (Supplies items, kinds, words)."""
    est = j.get("estimate") or {}
    services = [str(s).strip() for s in j.get("serviceTypes") or [] if str(s).strip()]
    titles = [str(w.get("title") or "") for w in est.get("work") or [] if isinstance(w, dict)]
    scopes = [str(w.get("scope") or "")[:600] for w in est.get("work") or [] if isinstance(w, dict)]
    mats = [m for m in est.get("materials") or [] if isinstance(m, dict)]
    ids, kinds, mwords = _mat_facts(mats, cats)
    notes = str(est.get("notes") or "")[:6000]
    # As a bid's (pastjobs.bid_facts): the kinds its work is, and any its
    # site notes mention.
    return {"services": {pj._key(s) for s in services if not pj.SNOW_WORDS.search(s)},
            "groups": pj._groups(services + titles) | pj._groups([notes], every=True),
            "words": pj._words(" ".join(services + titles + scopes + [m.get("name") or "" for m in mats] + [notes])),
            "supplyIds": ids, "kinds": kinds, "matWords": mwords}


def bid_profile(d, cats):
    """The same for a bid being built (pastjobs.bid_facts, and the materials
    on it so far)."""
    b = pj.bid_facts(d)
    ids, kinds, mwords = _mat_facts((d.get("current") or {}).get("materials"), cats)
    return {"services": b["services"], "groups": b["groups"], "words": b["words"],
            "supplyIds": ids, "kinds": kinds, "matWords": mwords}


def _idf(recs):
    df = {}
    for r in recs:
        for w in r.get("words") or []:
            df[w] = df.get(w, 0) + 1
    return df, len(recs)


def _alike(a, b, df, n):
    """How alike two jobs are: pastjobs.similar's score."""
    svc = len(a["services"] & b["services"])
    grp = len(a["groups"] & b["groups"])
    words = sum(math.log((n + 1.0) / (df.get(w, 0) + 1.0)) for w in a["words"] & b["words"])
    return 3.0 * svc + 1.5 * grp + min(words, 6.0)


def fit(note, source, target, df, n):
    """How well a lesson fits the target job, or None when it does not."""
    i = note.get("issue") or {}
    t = i.get("type")
    alike = _alike(source, target, df, n) if source else 0.0
    if t in ("over", "short"):
        sid, kind = str(i.get("supplyId") or ""), pj._key(i.get("materialKind"))
        named = pj._words(i.get("material"))
        if sid and sid in target["supplyIds"]:
            m = 4.0
        elif kind and kind in target["kinds"]:
            m = 3.0
        elif named and named & (target["matWords"] | target["words"]):
            m = 2.0
        else:
            return None                             # a material this job does not have
        return m + 0.5 * min(alike, 6.0)
    score = alike
    if t == "time" and i.get("work") and pj._groups([i.get("work")]) & target["groups"]:
        score += 2.0
    return score if score >= MIN_FIT else None


def pick(notes, profiles, target, df, n, exclude=None, limit=BID_MAX):
    """The lessons that fit the target, best first: [(score, id, note)]."""
    out = []
    for nid, note in notes:
        if note.get("jobId") == exclude:
            continue
        s = fit(note, profiles.get(note.get("jobId")), target, df, n)
        if s is not None:
            out.append((s, nid, note))
    out.sort(key=lambda x: str(x[2].get("at") or ""), reverse=True)
    out.sort(key=lambda x: -round(x[0], 6))
    return out[:limit]


# ------------------------------------------------------------ in words

def head_of(i):
    t = i.get("type") if i.get("type") in TYPE_HEAD else "other"
    if t in ("over", "short"):
        return TYPE_HEAD[t] % (i.get("material") or "material")
    if t == "equipment":
        return TYPE_HEAD[t] % (i.get("equipment") or "equipment")
    if t == "time":
        return TYPE_HEAD[t] % ((" on " + i["work"]) if i.get("work") else "")
    return TYPE_HEAD[t]


def _planned(i):
    q = pj._qty(i.get("planned"))
    return ("%s %s planned" % (q, i.get("unit") or "")).strip() if q else ""


def lesson_line(i, scrub=lambda s: s):
    """One lesson in a line: what happened, how much, the note, next time."""
    head = scrub(head_of(i))
    planned = _planned(i)
    bits = [head + (" (%s)" % planned if planned else "")]
    if i.get("amount"):
        bits.append(" -- " + _text(scrub(i["amount"]), 100))
    if i.get("note"):
        bits.append(": " + _text(scrub(i["note"]), 260))
    line = "".join(bits).rstrip(".") + "."
    if i.get("nextTime"):
        line += " Next time: " + _text(scrub(i["nextTime"]), 200).rstrip(".") + "."
    return line


def who_of(note, people):
    if note.get("uid") == CLAUDE_UID:
        return "claude"
    u = people.get(note.get("uid")) or {}
    return "owner" if u.get("role") == "owner" else "crew"


WHO_WORDS = {"claude": "Claude, from the job's daily logs", "owner": "noted by Jonah", "crew": "noted by the crew"}


def _job_words(j):
    """A job in a few words, no customer: its first services, town and month."""
    svc = [s for s in (j.get("serviceTypes") or []) if str(s).strip() and not pj.SNOW_WORDS.search(str(s))][:2]
    if not svc:
        svc = [pj.QTY_RATE.sub("", str(w.get("title") or "")).strip()
               for w in ((j.get("estimate") or {}).get("work") or [])[:2] if isinstance(w, dict) and w.get("title")]
    return svc, _text(j.get("city"), 40)


def _month_of(note, j):
    done = str(j.get("completedAt") or "") if stages.stage_of(j) in ("finished", "invoiced", "paid") else ""
    return pj._month(done or str(note.get("at") or ""))


# ------------------------------------------------- 1. a bid being built

def for_bid(db, d, recs, letters=None):
    """(text for the message, what the app shows) -- the lessons that fit
    the bid, or ("", []) when none do."""
    notes = issues(db)
    exclude = str(d.get("jobId") or "") or None
    notes = [(i, n) for i, n in notes if n.get("jobId") != exclude]
    if not notes:
        return "", []
    cats = categories(db)
    src = jobs(db, [n["jobId"] for _, n in notes])
    target = bid_profile(d, cats)
    df, n = _idf(recs)
    profiles = {jid: job_profile(j, cats) for jid, j in src.items()}
    picked = pick(notes, profiles, target, df, n, exclude=exclude, limit=BID_MAX)
    if not picked:
        return "", []
    others = pj.name_patterns(db)
    people = _people(db)
    letters = letters or {}
    rows, info, used = [], [], 0
    for _, nid, note in picked:
        j = src.get(note["jobId"]) or {}
        scrub = pj._scrubber(j, "", others)
        svc, town = _job_words(j)
        where = letters.get(note["jobId"])
        where = ("Job " + where) if where else ", ".join(x for x in [" + ".join(scrub(s) for s in svc), town] if x) or "a job"
        when = _month_of(note, j)
        row = "- %s%s; %s: %s" % (where, (", " + when) if when else "", WHO_WORDS[who_of(note, people)],
                                  lesson_line(note["issue"], scrub))
        if rows and used + len(row) > BID_CHARS:
            break
        rows.append(row)
        used += len(row)
        # The app names the job itself (on his own screen); the words are
        # the ones Claude saw.
        info.append({"id": nid, "jobId": note["jobId"], "who": who_of(note, people),
                     "text": lesson_line(note["issue"], scrub)[:300]})
    head = ("LESSONS FROM JONAH'S PAST JOBS LIKE THIS ONE -- noted on the job by his crew, by him, or by Claude from "
            "the job's daily logs, and picked by the app for this bid (a material lesson only when this bid has that "
            "material). Where one clearly applies, follow it -- less of a material that keeps being left over, more "
            "of one that keeps running short, a machine that was missed, more time where that work keeps running "
            "long -- and add a flag saying which lesson you followed and what you changed, so he can check it. A "
            "lesson is one job's experience, not a rule: his Pricing rules text always wins, and never change a "
            "price because of one.")
    return head + "\n" + "\n".join(rows), info


# ------------------------------------------------- 2. the crew's pages

def _claim(db, now, force=False):
    from google.cloud import firestore
    ref = db.collection(STATE[0]).document(STATE[1])

    @firestore.transactional
    def take(tx):
        snap = ref.get(transaction=tx)
        d = (snap.to_dict() or {}) if snap.exists else {}
        try:
            last = datetime.datetime.fromisoformat(str(d.get("checkedAt")))
        except (TypeError, ValueError):
            last = None
        if not force and last and now - last < CREW_EVERY - datetime.timedelta(minutes=2):
            return False
        tx.set(ref, {"checkedAt": now.isoformat()}, merge=True)
        return True

    return take(db.transaction())


def crew_item(nid, note, j, others, people):
    """One lesson as the crew page shows it: no customer, no dollars."""
    scrub = pj._scrubber(j, "", others)
    clean = lambda s: no_money(scrub(s)) if s not in (None, "") else ""
    i = note.get("issue") or {}
    t = i.get("type") if i.get("type") in TYPE_HEAD else "other"
    svc, town = _job_words(j)
    who = who_of(note, people)
    by = "Claude" if who == "claude" else (str(note.get("by") or "").split() or ["Someone"])[0]
    return {"id": nid, "type": t, "icon": ICONS[t],
            "head": _text(clean(head_of(i)), 160), "planned": _planned(i),
            "amount": _text(clean(i.get("amount")), 120), "note": _text(clean(i.get("note")), 400),
            "nextTime": _text(clean(i.get("nextTime")), 240),
            "job": _text(" + ".join(clean(s) for s in svc), 80), "town": town,
            "when": _month_of(note, j), "by": _text(by, 30)}


def crew_pages(db, now=None, force=False):
    """Each booked or under-way job the crew can see (jobCrew) gets the
    lessons from other jobs that fit it, at jobLessons/{jobId}. Once an
    hour; a page is written only when its list changed, and taken away when
    the job is no longer the crew's or nothing fits."""
    now = now or dg._now()
    if not _claim(db, now, force):
        return []
    crew_ids = [s.id for s in db.collection("jobCrew").select([]).stream()]
    have = {s.id: (s.to_dict() or {}) for s in db.collection(PAGES).stream()}
    notes = issues(db) if crew_ids else []
    written = removed = 0
    keep = set()
    if notes:
        cats = categories(db)
        src = jobs(db, crew_ids + [n["jobId"] for _, n in notes])
        df, n = _idf(pj.records(db))
        others = pj.name_patterns(db)
        people = _people(db)
        profiles = {jid: job_profile(j, cats) for jid, j in src.items()}
        for jid in crew_ids:
            j = src.get(jid)
            if not j:
                continue
            picked = pick(notes, profiles, profiles[jid], df, n, exclude=jid, limit=CREW_MAX)
            items = [crew_item(nid, note, src.get(note["jobId"]) or {}, others, people) for _, nid, note in picked]
            if not items:
                continue
            keep.add(jid)
            if json.dumps(have.get(jid, {}).get("items"), sort_keys=True) == json.dumps(items, sort_keys=True):
                continue
            db.collection(PAGES).document(jid).set({"items": items, "at": now.isoformat()})
            written += 1
    for jid in have:
        if jid not in keep:
            db.collection(PAGES).document(jid).delete()
            removed += 1
    if written or removed:
        print("lessons: %d crew pages written, %d taken away" % (written, removed))
    return []


# ------------------------------------------- 3. Claude's, on a finished job

MODEL = "claude-sonnet-5-5"     # short reading and writing: the mid-priced model
LOOKBACK_DAYS = 21              # a job finished this long ago is still read
EVENING_MAX = 3                 # jobs read in one evening
LESSONS_MAX = 3

SYSTEM = (
    "You help YD Exterior Visions LLC, a landscaping and hardscaping company near Madison, Wisconsin, learn from "
    "its finished jobs. You are given one finished job: its work and materials as bid, how long it was bid at "
    "and really took, its daily logs (short points written from the crew's notes), the notes said or typed on "
    "it, and what the crew and the owner already noted as issues or lessons. Write the lessons that would make "
    "the NEXT job like it go better -- at most three, only from what the facts say, never invented. Good lessons: "
    "a material left over or run short (how much), a machine or trailer that was needed, work that took longer "
    "and why, something found on site worth checking for at the bid, something that worked well and should be "
    "done again. Leave out anything already noted (it is listed), one-off bad luck, and anything without a "
    "lesson in it. No lesson is a fine answer: return an empty list. Each lesson: type over | short | equipment "
    "| time | site | lesson; material / equipment / work: the thing it is about, in a few words (empty when "
    "none); amount: how much in the crew's words, e.g. 'about 2 yd left over' (empty when unknown); note: one "
    "short sentence of what happened; nextTime: one short sentence, what to do differently next time. Plain "
    "foreman's words. Never a customer's name, address or a price."
)

SCHEMA = {
    "type": "object",
    "properties": {"lessons": {"type": "array", "items": {
        "type": "object",
        "properties": {"type": {"type": "string", "enum": ["over", "short", "equipment", "time", "site", "lesson"]},
                       "material": {"type": "string"}, "equipment": {"type": "string"}, "work": {"type": "string"},
                       "amount": {"type": "string"}, "note": {"type": "string"}, "nextTime": {"type": "string"}},
        "required": ["type", "material", "equipment", "work", "amount", "note", "nextTime"],
        "additionalProperties": False}}},
    "required": ["lessons"], "additionalProperties": False,
}


def _finished_lately(db, now):
    since = (now - datetime.timedelta(days=LOOKBACK_DAYS)).astimezone(datetime.timezone.utc).strftime("%Y-%m-%d")
    out = []
    for s in db.collection("jobs").where("completedAt", ">=", since).select(JOB_FIELDS).stream():
        j = s.to_dict() or {}
        if pj.is_finished(j):
            out.append((s.id, j))
    out.sort(key=lambda x: str(x[1].get("completedAt") or ""))
    return out


def to_read(db, job_id):
    """What there is to read about a finished job: its daily logs, the notes
    on it, and the crew's notes and issues -- each [{...}], oldest first."""
    logs = []
    for s in db.collection("jobLogs").where("jobId", "==", job_id).stream():
        g = s.to_dict() or {}
        if str(g.get("text") or "").strip():
            logs.append({"day": str(g.get("day") or ""), "text": str(g["text"]).strip()[:2500], "how": g.get("how")})
    said = []
    for s in db.collection("jobNotes").where("jobId", "==", job_id).stream():
        n = s.to_dict() or {}
        if str(n.get("text") or "").strip():
            said.append({"at": str(n.get("at") or ""), "text": str(n["text"]).strip()[:1500]})
    noted, told = [], []
    for s in db.collection("crewNotes").where("jobId", "==", job_id).stream():
        n = s.to_dict() or {}
        if n.get("deletedAt"):
            continue
        if n.get("kind") == "issue" and isinstance(n.get("issue"), dict):
            noted.append(n)
        elif str(n.get("text") or "").strip():
            told.append({"at": str(n.get("at") or ""), "text": str(n["text"]).strip()[:1500]})
    logs.sort(key=lambda x: x["day"])
    said.sort(key=lambda x: x["at"])
    told.sort(key=lambda x: x["at"])
    noted.sort(key=lambda n: str(n.get("at") or ""))
    return {"logs": logs, "said": said, "told": told, "noted": noted}


def worth_reading(r):
    """Claude only when there are words to read: a log written from notes,
    a note, or a note to Jonah. Hours and ticks alone are already in the
    finished-jobs figures (pastjobs)."""
    return bool(r["said"] or r["told"] or any(g.get("how") == "claude" for g in r["logs"]))


def _prompt(j, r, rec, day_hours):
    est = j.get("estimate") or {}
    out = []
    services = [str(s) for s in j.get("serviceTypes") or [] if str(s).strip()]
    if services:
        out.append("Services: " + ", ".join(services[:8]))
    work = [str(w.get("title") or "").strip() for w in est.get("work") or [] if isinstance(w, dict) and w.get("title")]
    if work:
        out.append("Work bid: " + "; ".join(work[:12]))
    mats = ["%s %s %s" % (m.get("name"), pj._qty(m.get("qty")), m.get("unit") or "")
            for m in est.get("materials") or [] if isinstance(m, dict) and m.get("name")]
    if mats:
        out.append("Materials bid (the takeoff, before waste): " + "; ".join(re.sub(r"\s+", " ", x).strip() for x in mats[:25]))
    if rec:
        took = pj.took_days(rec, day_hours)
        if took is not None and rec.get("bid"):
            out.append("Crew-days: bid %s, really took %s%s." % (pj._days(rec["bid"]), pj._days(took), pj._pct(took, rec["bid"])))
        elif rec.get("hours"):
            out.append("Paid crew hours on the clock: %d." % round(rec["hours"]))
    for g in r["logs"]:
        out.append("Daily log %s:\n%s" % (g["day"], g["text"]))
    for x in r["said"]:
        out.append("Note on the job (%s): %s" % (x["at"][:10], x["text"]))
    for x in r["told"]:
        out.append("Note to the owner (%s): %s" % (x["at"][:10], x["text"]))
    if r["noted"]:
        out.append("ALREADY NOTED (do not repeat): " + " | ".join(lesson_line(n["issue"]) for n in r["noted"]))
    return "\n".join(out)


def _ask(client, prompt):
    resp = client.beta.messages.create(
        model=MODEL, max_tokens=2000, system=SYSTEM,
        messages=[{"role": "user", "content": prompt}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    )
    if resp.stop_reason == "refusal":
        return None, resp.usage
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        return json.loads(text), resp.usage
    except ValueError:
        return None, resp.usage


def _match_mat(j, cats, name):
    """The job's own material a lesson names (its Supplies item, kind, unit
    and the quantity planned), or None."""
    k = pj._key(name)
    if not k:
        return None
    for m in (j.get("estimate") or {}).get("materials") or []:
        if not isinstance(m, dict):
            continue
        mk = pj._key(m.get("name"))
        if mk and (mk == k or k in mk or mk in k):
            return m
    return None


def issue_of(got, j, cats):
    """Claude's lesson as an issue record (jobissues.js keeps the same
    fields), or None when it says nothing."""
    t = got.get("type") if got.get("type") in TYPE_HEAD and got.get("type") != "other" else "lesson"
    clip = lambda k, n: _text(got.get(k), n) or None
    material = clip("material", 200) if t in ("over", "short") else None
    m = _match_mat(j, cats, material) if material else None
    sid = str(m.get("supplyId") or "") if m else ""
    work_id = None
    work = clip("work", 200) if t == "time" else None
    if work:
        for i, w in enumerate((j.get("estimate") or {}).get("work") or []):
            if isinstance(w, dict) and pj._key(w.get("title")) and pj._key(w.get("title")) == pj._key(work):
                work_id = re.sub(r"[^A-Za-z0-9_-]", "", str(w.get("id") or "")) or "w%d" % i
                break
    rec = {"type": t, "material": material, "supplyId": sid or None,
           "materialKind": ("plant" if m and m.get("plant") else (cats.get(sid) or (m or {}).get("category") or None)) if m else None,
           "unit": _text((m or {}).get("unit"), 30) or None,
           "planned": pj._num((m or {}).get("qty")),
           "equipment": clip("equipment", 80) if t == "equipment" else None,
           "workId": work_id, "work": work,
           "amount": clip("amount", 120), "note": clip("note", 1000), "nextTime": clip("nextTime", 400)}
    if not (rec["note"] or rec["nextTime"] or rec["material"] or rec["equipment"] or rec["work"]):
        return None
    return rec


def text_of(i):
    """The lesson in words, as jobissues.js writes `text` (the notes list)."""
    about = i.get("material") or i.get("equipment") or i.get("work") or ""
    names = {"over": "Too much material", "short": "Ran short on material", "equipment": "Needed equipment we didn't have",
             "time": "Took longer than planned", "site": "Site problem", "other": "Something else",
             "lesson": "Something to remember next time"}
    s = names.get(i.get("type"), "Something else") + (": " + about if about else "") + \
        (" -- " + i["amount"] if i.get("amount") else "") + ("\n" + i["note"] if i.get("note") else "")
    return (s + ("\nNext time: " + i["nextTime"] if i.get("nextTime") else ""))[:2000]


def after_finish(client, db=None, now=None):
    """The evening run: each job finished in the last LOOKBACK_DAYS that has
    words to read and has not been read yet gets Claude's lessons (none is a
    fine answer). reminderLog lessons_<jobId> marks it read, once."""
    db = db or dg._db()
    now = now or dg._now()
    import spend
    if client is None:
        return {"read": 0}
    snap = db.collection("pricing").document("rules").get()
    rules = (snap.to_dict() or {}) if snap.exists else {}
    if rules.get("learnFromJobs") is False:
        return {"read": 0}
    day_hours = pj._num(rules.get("crewDayHours"))
    day_hours = day_hours if day_hours and day_hours > 0 else None
    cats = categories(db)
    recs = None
    read, wrote = 0, 0
    for jid, j in _finished_lately(db, now):
        if read >= EVENING_MAX:
            break
        if db.collection("reminderLog").document("lessons_" + jid).get().exists:
            continue
        r = to_read(db, jid)
        if not worth_reading(r):
            continue                                # looked at again tomorrow, while it is recent
        if spend.over_cap(db):
            break
        try:
            db.collection("reminderLog").document("lessons_" + jid).create({"at": now.isoformat()})
        except AlreadyExists:
            continue
        if recs is None:
            recs = {x["id"]: x for x in pj.records(db)}
        got, usage = _ask(client, _prompt(j, r, recs.get(jid), day_hours))
        spend.record(db, now.astimezone(datetime.timezone.utc).strftime("%Y-%m-%d"), "lessons", MODEL, usage)
        read += 1
        at = now.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        n = 0
        for x in ((got or {}).get("lessons") or [])[:LESSONS_MAX]:
            i = issue_of(x if isinstance(x, dict) else {}, j, cats)
            if not i:
                continue
            nid = "cn%sc%d" % (_b36(int(now.timestamp() * 1000)), n)
            # Handled and told already: Claude's lesson is no to-do for Jonah
            # and never buzzes his phone -- it waits on the job for the next
            # one like it, where he can change or remove it.
            db.collection("crewNotes").document(nid).set({
                "uid": CLAUDE_UID, "by": "Claude", "kind": "issue", "issue": i, "text": text_of(i),
                "jobId": jid, "jobName": _text(j.get("customerName"), 120) or None,
                "at": at, "readAt": at, "notifiedAt": at})
            n += 1
        wrote += n
        db.collection("reminderLog").document("lessons_" + jid).set({"lessons": n}, merge=True)
    if read:
        print("lessons: read %d finished jobs, %d lessons" % (read, wrote))
    return {"read": read, "lessons": wrote}


def _b36(n):
    s = ""
    while n:
        n, r = divmod(n, 36)
        s = "0123456789abcdefghijklmnopqrstuvwxyz"[r] + s
    return s or "0"
