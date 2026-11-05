"""The words for a finished job's social posts.

Jonah (21 Oct 2026): "Build something that auto build posts when a job is
marked complete."

When a job is marked Complete the app asks for them (once per job; "Write
them again" by hand any time). Claude writes one post for each place Claude
writes for on the posting schedule (social.py), each in that place's own way,
from what the job was -- the town, the work as the customer was told it, the
materials -- and never the customer's name, their street, or a price: these go
out in public. They are kept on socialWords/{jobId} for the schedule, which
also asks here the first time it picks a job with none.

Nothing lands on his My to-dos. Jonah (4 Nov 2026), on the "Posts ready" cards
that used to: "i just want this stuff automated." Those cards were words to
copy onto Pinterest and Yelp by hand, the two places not on the schedule: Yelp
gives a program no way to post, and Pinterest makes an app pass a review first.

As in care.py the app only says WHICH job; the job is read here.
"""

import datetime
import json
import re

from google.api_core.exceptions import AlreadyExists

import digest as dg

# Short writing: the mid-priced model writes it as well (Jonah, 7 Oct: no
# Claude feature should cost more than it needs to).
MODEL = "claude-sonnet-5-5"

SYSTEM = (
    "You write social media posts for YD Exterior Visions LLC, a landscaping and hardscaping "
    "company near Madison, Wisconsin, about one job they finished. Job Hub puts them up on a schedule.\n\n"
    "Write one post for each place, each the way that place reads:\n"
    "- google: a Google Business Profile update. 80-150 words, plain and specific: what was "
    "done, in which town, what it was built with, and why it works for that yard. Use the words "
    "people search for (e.g. 'paver patio', 'retaining wall', 'landscape installation', the town "
    "name). No hashtags, no emojis. End with an invitation to ask for an estimate.\n"
    "- facebook: friendly, 2-4 short paragraphs, one or two emojis at most, then 3-6 hashtags "
    "on their own line (e.g. #MadisonLandscaping #PaverPatio and the town).\n"
    "- nextdoor: a neighbourly note to people nearby, 60-120 words, no hashtags, no hard "
    "selling -- 'we finished a ... in <town>', what it involved, happy to answer questions.\n\n"
    "What to say: lead with what the finished yard is and how it looks and works -- the main build and "
    "its main materials (the paver, the stone, the wall block, the plants). Leave out side chores "
    "(levelling an AC pad, hauling, clean-up) and supply-list items (fabric, pins, base gravel, "
    "leveling sand, adhesive) unless they are the point. Give a size only when it shows the scale "
    "of the work (a 400 sq ft patio, a 60 ft wall), never a small one (16 ft of edging, 2 yards of "
    "mulch). No trade jargon (say 'locked in place', not 'a locking product').\n\n"
    "Rules, all of them: never name the customer, never give a street or house number -- the "
    "town only. Never mention any price, cost or budget. Never invent anything not given: no "
    "materials, sizes, plants, timelines, awards or claims beyond the facts. A measurement or "
    "material you do give is the facts' own, word for word. No phone number, website or address in any "
    "post (the app adds the company's own). Never say licensed, never mention pressure washing "
    "(even when the facts do: it is not a service we sell) or subcontractors, never "
    "call the company small, family-run or a one-man shop -- it is a growing company -- and never "
    "speak as one person or the owner. Plain English, no jargon; write as the company ('we').\n\n"
    "When it was done: the facts give today's date, the day it was finished, `recent` and `when`. "
    "When recent is true, 'just finished' or 'recently' is fine. When it is false, never say 'just', "
    "'recently', 'this week' or 'today' -- say when it was done in the words `when` gives (e.g. 'this "
    "past spring', 'in the summer of 2025'), or write about the yard without saying when."
)

RECENT_DAYS = 45            # = social.RECENT_DAYS: "just finished" is true up to this many days
SEASONS = {3: "spring", 4: "spring", 5: "spring", 6: "summer", 7: "summer", 8: "summer",
           9: "fall", 10: "fall", 11: "fall"}


def _when(finished, today):
    """(recent, words) for a job finished on `finished` (YYYY-MM-DD) seen on
    `today`: a post written for an April job in November said "we just
    finished" (2 Nov 2026), so the age is worked out here and said plainly.
    Winter months are named, since a winter runs over two years."""
    try:
        f = datetime.date.fromisoformat(str(finished)[:10])
    except (TypeError, ValueError):
        return True, ""
    if (today - f).days <= RECENT_DAYS:
        return True, ""
    season = SEASONS.get(f.month)
    if not season:
        return False, "in " + f.strftime("%B %Y")
    if f.year == today.year:
        return False, ("earlier this " if SEASONS.get(today.month) == season else "this past ") + season
    return False, "in the %s of %d" % (season, f.year)

SCHEMA = {
    "type": "object",
    "properties": {
        "google": {"type": "string"}, "facebook": {"type": "string"}, "nextdoor": {"type": "string"},
    },
    "required": ["google", "facebook", "nextdoor"],
    "additionalProperties": False,
}

MONEY = re.compile(r"[$＄]\s*\.?\d[\d,]*(\.\d+)?|\b\d[\d,]*(\.\d+)?\s?(k|grand|dollars?|bucks|usd)\b", re.I)


PHONE = re.compile(r"\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}\b")
EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
# A street address anywhere in the words: a QuickBooks line made by Job Hub
# starts "HEADING, address, scope" ("123 N Main St", "100 & 102 Example Ave").
STREET = re.compile(r"\b\d{1,6}(?:\s*(?:&|and|-)\s*\d{1,6})?\s+(?:[NSEW]\.?\s+)?(?:[A-Z][\w'.-]*\s+){1,4}"
                    r"(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Way|Blvd|Boulevard|Cir|Circle|Pl|Place|"
                    r"Trl|Trail|Pkwy|Parkway|Hwy|Highway|Ter|Terrace|Pass|Run|Ridge|Xing|Crossing)\b\.?")


def _clean(text, limit, j=None):
    """A customer's words with any money taken out (a scope might say what was
    agreed) -- and who and where: the street, phone numbers, emails, and the
    customer's name (the whole name, and the first name; a last name alone
    can be a work word, like Black or Stone, and social.problems() still
    holds a post that says it)."""
    s = STREET.sub("", MONEY.sub("", str(text or "")))
    s = EMAIL.sub("", PHONE.sub("", s))
    if j:
        street = str(j.get("address") or "").split(",")[0].strip()
        if len(street) >= 5:
            s = re.sub(re.escape(street), "", s, flags=re.I)
        name = " ".join(str(j.get("customerName") or "").split())
        if len(name) >= 3:
            s = re.sub(r"\b%s\b" % re.escape(name), "the customer", s, flags=re.I)
            first = name.split()[0]
            if len(first) >= 3 and len(name.split()) > 1:
                s = re.sub(r"\b%s\b" % re.escape(first), "the customer", s)
    return re.sub(r"[ \t]{2,}", " ", s).strip(" ,;-")[:limit]


def _facts(j):
    """What Claude is told about the job: what was done, where (the town),
    with what -- never who, the street, or a price."""
    est = j.get("estimate") or {}
    work = []
    for w in (est.get("work") or [])[:20]:
        if not w:
            continue
        title, scope = _clean(w.get("title"), 200, j), _clean(w.get("scope"), 1500, j)
        if title or scope:
            work.append({"title": title, "scope": scope})
    mats = []
    for m in (est.get("materials") or [])[:40]:
        name = _clean((m or {}).get("name"), 120, j)
        if name:
            mats.append(name)
    finished = str(j.get("completedAt") or j.get("workStageAt") or "")[:10]
    today = dg._now().date()
    recent, when = _when(finished, today)
    return {
        "town": str(j.get("city") or "").strip()[:60],
        "services": [str(s)[:60] for s in (j.get("serviceTypes") or [])[:10]],
        "work": work,
        "materials": mats,
        "finished": finished,
        "today": today.isoformat(),
        "recent": recent,
        "when": when,
    }


def has_work(j):
    """Whether there is anything on the job to write a post about."""
    f = _facts(j)
    return bool(f["work"] or f["services"])


def draft(client, job_id, auto=False):
    """Write the job's posts for the posting schedule. Returns (result, usage):
    result is {written}, {error}, or {skipped} for an automatic one already
    written; usage is None when Claude was never asked.

    `auto` is the app asking by itself because the job was just marked
    Complete: once per job however many devices see it (a claim in
    reminderLog, as care.py). "Write them again" by hand is never stopped."""
    db = dg._db()
    snap = db.collection("jobs").document(job_id).get()
    if not snap.exists:
        return {"error": "That job was not found"}, None
    j = snap.to_dict() or {}
    facts = _facts(j)
    if not facts["work"] and not facts["services"]:
        return {"error": "This job has no work on its estimate to write about"}, None
    claim = None
    if auto:
        # Ticked "Don't post" on the job: nothing written by itself (by hand,
        # "Write the posts" still writes them).
        if j.get("postsDraft") or j.get("noPost"):
            return {"skipped": True}, None
        claim = db.collection("reminderLog").document("posts_" + job_id)
        try:
            claim.create({"job": job_id, "at": dg._now().isoformat()})
        except AlreadyExists:
            return {"skipped": True}, None
    try:
        result = _write(client, db, job_id, j, facts)
    except Exception:
        if claim is not None:
            claim.delete()
        raise
    if claim is not None and result[0].get("error"):
        claim.delete()
    return result


def _ask(client, facts, note=None):
    """Claude's posts for one job: (posts, error, usage)."""
    said = ("\n\nJonah's note for these posts -- follow it, as long as every rule above still holds:\n" + note) if note else ""
    resp = client.beta.messages.create(
        model=MODEL, max_tokens=6000, system=SYSTEM,
        messages=[{"role": "user", "content": "The job:\n" + json.dumps(facts, ensure_ascii=False) + said}],
        thinking={"type": "adaptive"},
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    )
    if resp.stop_reason == "refusal":
        return None, "Claude declined to write these", resp.usage
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        got = json.loads(text)
    except ValueError:
        return None, "Claude's answer could not be read. Try again.", resp.usage
    posts = {k: str(got.get(k) or "").strip() for k in SCHEMA["required"]}
    if not all(posts.values()):
        return None, "Claude's answer was empty. Try again.", resp.usage
    return posts, None, resp.usage


def _keep_words(db, job_id, posts, note=None):
    """Kept for the posting schedule (social.py): socialWords/{jobId}, with
    his note for Claude when there is one (kept for the next writing too)."""
    db.collection("socialWords").document(job_id).set(dict(posts, at=dg._now().isoformat(), error=None,
                                                           note=note or None))


NOTE_MAX = 1000


def _note_of(db, job_id, note):
    """His note for this job's posts: the one just typed (Posts → a post →
    "Note for Claude", Jonah 2 Nov 2026: "add notes for calude to view on
    media posts that are going up"), else the one he left before. '' wipes
    it."""
    if note is not None:
        return str(note).strip()[:NOTE_MAX]
    snap = db.collection("socialWords").document(job_id).get()
    return str(((snap.to_dict() or {}) if snap.exists else {}).get("note") or "")[:NOTE_MAX]


def words(client, db, job_id, j, note=None):
    """A finished job's posts, written and kept for the posting schedule
    (social.py plan) when it was never written for. Returns (words or
    {error}, usage). A job with nothing to write about, or one Claude will
    not write about, is kept as such so it is not asked about again."""
    facts = _facts(j)
    if not facts["work"] and not facts["services"]:
        # noWork: kept so it costs nothing each run, but asked again once the
        # job has work on it (a QuickBooks estimate filled in after the job
        # was finished) -- social.py plan looks at has_work().
        db.collection("socialWords").document(job_id).set({"error": "no work on its estimate", "noWork": True,
                                                            "at": dg._now().isoformat(),
                                                            "note": _note_of(db, job_id, note) or None})
        return {"error": "no work on its estimate"}, None
    note = _note_of(db, job_id, note)
    posts, error, usage = _ask(client, facts, note)
    if error:
        if error.startswith("Claude declined"):
            db.collection("socialWords").document(job_id).set({"error": error, "at": dg._now().isoformat(),
                                                                "note": note or None})
        return {"error": error}, usage
    _keep_words(db, job_id, posts, note)
    return posts, usage


def _write(client, db, job_id, j, facts):
    note = _note_of(db, job_id, None)
    posts, error, usage = _ask(client, facts, note)
    if error:
        return {"error": error}, usage
    _keep_words(db, job_id, posts, note)
    import quickbooks
    db.collection("jobs").document(job_id).set({"postsDraft": {"at": dg._now().isoformat()},
                                                "lastModified": quickbooks._stamp()}, merge=True)
    print("posts: written for job", job_id)
    return {"written": True}, usage
