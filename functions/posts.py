"""Social posts about a finished job.

Jonah (21 Oct 2026): "make google profile post, facebook, nextdoor,
pinterest, and yelp posts from [a finished] job. Build something that auto
build posts when a job is marked complete."

When a job is marked Complete the app asks for them (once per job; "Write
them again" by hand any time). Claude writes one post for each place, each in
that place's own way, from what the job was -- the town, the work as the
customer was told it, the materials -- and never the customer's name, their
street, or a price: these go out in public. They land on the owner's My
to-dos as one card (boards/todo/cards/ps<jobId>): every post to copy, a tick
for each place as it goes up, and the job's after photos linked. Nothing is
posted from here; he posts them himself.

As in care.py the app only says WHICH job; the job is read here.
"""

import json
import re

from google.api_core.exceptions import AlreadyExists

import digest as dg

# Short writing: the mid-priced model writes it as well (Jonah, 7 Oct: no
# Claude feature should cost more than it needs to).
MODEL = "claude-sonnet-5-5"

PLACES = [("google", "Google Business Profile"), ("facebook", "Facebook"), ("nextdoor", "Nextdoor"),
          ("pinterest", "Pinterest"), ("yelp", "Yelp")]

SYSTEM = (
    "You write social media posts for YD Exterior Visions LLC, a landscaping and hardscaping "
    "company near Madison, Wisconsin, about one job they finished. Job Hub puts the Google, "
    "Facebook and Nextdoor ones up on a schedule; the Pinterest and Yelp ones are posted by hand.\n\n"
    "Write one post for each place, each the way that place reads:\n"
    "- google: a Google Business Profile update. 80-150 words, plain and specific: what was "
    "done, in which town, what it was built with, and why it works for that yard. Use the words "
    "people search for (e.g. 'paver patio', 'retaining wall', 'landscape installation', the town "
    "name). No hashtags, no emojis. End with an invitation to ask for an estimate.\n"
    "- facebook: friendly, 2-4 short paragraphs, one or two emojis at most, then 3-6 hashtags "
    "on their own line (e.g. #MadisonLandscaping #PaverPatio and the town).\n"
    "- nextdoor: a neighbourly note to people nearby, 60-120 words, no hashtags, no hard "
    "selling -- 'we just finished a ... in <town>', what it involved, happy to answer questions.\n"
    "- pinterest: pinterestTitle (under 100 characters, the kind of project and style, the kind "
    "of thing someone searches for) and pinterest (a description, 2-3 sentences rich in search "
    "words: materials, style, the kind of project, southern Wisconsin).\n"
    "- yelp: a short business update, 50-100 words, factual and warm.\n\n"
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
    "post (the app adds the company's own). Never say licensed, never mention subcontractors, never "
    "call the company small, family-run or a one-man shop -- it is a growing company -- and never "
    "speak as one person or the owner. Plain English, no jargon; write as the company ('we')."
)

SCHEMA = {
    "type": "object",
    "properties": {
        "google": {"type": "string"}, "facebook": {"type": "string"}, "nextdoor": {"type": "string"},
        "pinterestTitle": {"type": "string"}, "pinterest": {"type": "string"}, "yelp": {"type": "string"},
    },
    "required": ["google", "facebook", "nextdoor", "pinterestTitle", "pinterest", "yelp"],
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
    return {
        "town": str(j.get("city") or "").strip()[:60],
        "services": [str(s)[:60] for s in (j.get("serviceTypes") or [])[:10]],
        "work": work,
        "materials": mats,
        "finished": str(j.get("completedAt") or j.get("workStageAt") or "")[:10],
    }


def _after_photos(db, job_id, most=8):
    """The job's after photos, newest first: links for the card."""
    out = []
    try:
        for s in db.collection("jobPhotos").where("jobId", "==", job_id).stream():
            p = s.to_dict() or {}
            if p.get("stage") == "after" and not p.get("deleteAsked") and p.get("url"):
                out.append((str(p.get("at") or ""), str(p["url"])))
    except Exception as err:                        # noqa: BLE001 -- the posts without them
        print("posts: photos not read:", err)
    return [u for _, u in sorted(out, reverse=True)[:most]]


def draft(client, job_id, auto=False):
    """Write the posts onto the owner's My to-dos. Returns (result, usage):
    result is {cardId}, {error}, or {skipped} for an automatic one already
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


def _ask(client, facts):
    """Claude's posts for one job: (posts, error, usage)."""
    resp = client.beta.messages.create(
        model=MODEL, max_tokens=6000, system=SYSTEM,
        messages=[{"role": "user", "content": "The job:\n" + json.dumps(facts, ensure_ascii=False)}],
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
    if not all(posts[k] for k, _ in PLACES):
        return None, "Claude's answer was empty. Try again.", resp.usage
    return posts, None, resp.usage


def _keep_words(db, job_id, posts):
    """Kept for the posting schedule (social.py): socialWords/{jobId}."""
    db.collection("socialWords").document(job_id).set(dict(posts, at=dg._now().isoformat(), error=None))


def words(client, db, job_id, j):
    """A finished job's posts, written and kept for the posting schedule
    (social.py plan) when it was never written for. Returns (words or
    {error}, usage). A job with nothing to write about, or one Claude will
    not write about, is kept as such so it is not asked about again."""
    facts = _facts(j)
    if not facts["work"] and not facts["services"]:
        db.collection("socialWords").document(job_id).set({"error": "no work on its estimate",
                                                            "at": dg._now().isoformat()})
        return {"error": "no work on its estimate"}, None
    posts, error, usage = _ask(client, facts)
    if error:
        if error.startswith("Claude declined"):
            db.collection("socialWords").document(job_id).set({"error": error, "at": dg._now().isoformat()})
        return {"error": error}, usage
    _keep_words(db, job_id, posts)
    return posts, usage


def _social(db):
    snap = db.collection("settings").document("social").get()
    return (snap.to_dict() or {}) if snap.exists else {}


def _scheduled(db):
    """The places the posting schedule puts up by itself (social.py), when
    it is on: those leave the "Posts ready" card."""
    cfg = _social(db)
    if not cfg.get("on"):
        return set()
    return {p for p in ("google", "facebook", "nextdoor")
            if ((cfg.get("places") or {}).get(p) or {}).get("on") is not False}


def _write(client, db, job_id, j, facts):
    posts, error, usage = _ask(client, facts)
    if error:
        return {"error": error}, usage
    _keep_words(db, job_id, posts)
    scheduled = _scheduled(db)
    places = [(k, label) for k, label in PLACES if k not in scheduled]

    name = str(j.get("customerName") or "").strip() or "Untitled job"
    num = str(j.get("estimateNumber") or "").strip()
    photos = _after_photos(db, job_id)
    parts = ["Copy each into its place and tick it off as it goes up." + (
                 " " + ", ".join(label for k, label in PLACES if k in scheduled) +
                 " go up by themselves on the posting schedule (⋯ › 📣 Posts)." if scheduled
                 else " Nothing is posted by Job Hub."),
             "Photos: " + ("the after photos —\n" + "\n".join(photos) if photos
                           else "none marked After on the job yet (📷 on the job's page).")]
    for key, label in places:
        body = posts[key]
        if key == "pinterest":
            body = "Title: " + posts["pinterestTitle"] + "\n" + body
        parts.append("=== " + label + " ===\n" + body)
    import quickbooks
    stamp = quickbooks._stamp()
    board = db.collection("boards").document("todo").get()
    cols = ((board.to_dict() or {}).get("columns") or []) if board.exists else []
    col = next((c.get("id") for c in cols if isinstance(c, dict) and c.get("id")), "admin0")
    card_id = "ps" + re.sub(r"[^A-Za-z0-9_-]", "", job_id)
    db.collection("boards").document("todo").collection("cards").document(card_id).set({
        "title": ("📣 Posts ready — " + name + (" #" + num if num else ""))[:200],
        "notes": "\n\n".join(parts)[:9000],
        "checklist": [{"id": "pst" + k, "text": label, "done": False, "doneBy": None} for k, label in places],
        "column": col, "order": int(dg._now().timestamp() * 1000), "due": None, "dueTime": None,
        "remindMins": None, "hasReminder": False, "remindUids": [], "noReminder": False,
        "type": None, "urgency": "normal", "labels": [], "color": None, "assignees": [],
        "jobId": job_id, "jobName": name, "jobNum": num or None,
        # His to do, not one for Claude's card runs (cards.py).
        "noClaude": True, "posts": job_id,
        "doneAt": None, "createdAt": stamp, "createdBy": "Job Hub", "updatedAt": stamp, "updatedBy": "Job Hub",
    })
    db.collection("jobs").document(job_id).set({"postsDraft": {"at": dg._now().isoformat(), "cardId": card_id},
                                                "lastModified": stamp}, merge=True)
    print("posts: written for job", job_id)
    return {"cardId": card_id, "photos": len(photos)}, usage


# ------------------------------------------------------------ the week's posts
#
# Jonah (26 Oct 2026): "build steps 1-2 in Job Hub first (the weekly 'ready
# to post' card with up to 3 After photos per job, caption and hashtags)".
# Friday evening (main.py, after the evening summary): the jobs finished in
# the seven days to today and not ticked "Don't post" on the job (noPost),
# each with up to WEEK_PHOTOS After photos -- one card on his My to-dos
# (pw<date>) with every job's words for Pinterest and Yelp, the work and the
# town and 8-12 hashtags, and its photos to save and upload. Once a week (a
# claim in reminderLog, as draft above); nothing is posted from here.
# Next, once two weeks of these read well: a Saturday routine on his
# computer that fills in the Yelp and Pinterest pages (his yes on the card).
WEEK_PHOTOS = 3
WEEK_DAYS = 7

WEEK_SYSTEM = (
    "You write the words to go with photos of finished jobs that YD Exterior Visions LLC, a landscaping "
    "and hardscaping company near Madison, Wisconsin, posts on Pinterest and Yelp. The owner, Jonah, "
    "posts them himself.\n\n"
    "For each job give:\n"
    "- caption: 1-2 sentences, under 220 characters, that someone searching would find: the kind of "
    "project, what it was built with, and the town with WI (e.g. 'Paver patio with a seating wall in "
    "Verona, WI, built with Reno pavers on a compacted base.'). Plain and specific, no emojis.\n"
    "- hashtags: 8 to 12, each starting with #, no spaces inside: a few for the work (#PaverPatio), "
    "one or two for the town or area (#VeronaWI #MadisonLandscaping), one for Wisconsin.\n\n"
    "Rules, all of them: never name the customer, never give a street or house number -- the town "
    "only. Never mention any price. Never invent anything not given: no materials, sizes or claims "
    "beyond the facts. Give every job you are given, by its jobId."
)

WEEK_SCHEMA = {
    "type": "object",
    "properties": {"jobs": {"type": "array", "items": {
        "type": "object",
        "properties": {"jobId": {"type": "string"}, "caption": {"type": "string"},
                       "hashtags": {"type": "array", "items": {"type": "string"}}},
        "required": ["jobId", "caption", "hashtags"],
        "additionalProperties": False,
    }}},
    "required": ["jobs"],
    "additionalProperties": False,
}


def _week_photos(db, job_id):
    """Up to WEEK_PHOTOS After photos, newest first: {url, thumb}."""
    out = []
    try:
        for s in db.collection("jobPhotos").where("jobId", "==", job_id).stream():
            p = s.to_dict() or {}
            if p.get("stage") == "after" and not p.get("deleteAsked") and str(p.get("url") or "").startswith("https://"):
                out.append((str(p.get("at") or ""), {"url": str(p["url"]),
                                                      "thumb": str(p.get("thumbUrl") or p["url"])}))
    except Exception as err:                        # noqa: BLE001 -- the job is left off
        print("posts: week photos not read for", job_id, err)
    return [x for _, x in sorted(out, key=lambda t: t[0], reverse=True)[:WEEK_PHOTOS]]


def _tag(t):
    t = re.sub(r"[^A-Za-z0-9]", "", str(t or ""))
    return "#" + t if t else ""


# The same After photos go on the Google Business Profile every week -- Jonah,
# 27 Oct 2026: "routine for adding photos to the google business profile. Add
# after photos weekly." Fresh photos are part of how Google ranks a local
# business, and they are his to upload (Job Hub has no way into the profile),
# so the week's card carries the step and a tick for it (boards.js shows the
# same words above the photos).
GOOGLE_PHOTOS = ("Google Business Profile: add the same After photos there too -- search \"YD Exterior Visions\" "
                 "on Google while signed in, then Add photos (or the Google Business Profile app -> Add photo). "
                 "A few fresh job photos every week helps you show up in local searches.")
GOOGLE_PHOTOS_TICK = "📍 After photos added to the Google Business Profile"


def weekly(client, today=None):
    """The week's "ready to post" card (above). Returns (result, usage):
    result {cardId, jobs} / {skipped} / {none} / {error}; usage is None
    when Claude was never asked."""
    import datetime
    import spend
    db = dg._db()
    today = today or dg._now().date()
    start = today - datetime.timedelta(days=WEEK_DAYS - 1)
    claim = db.collection("reminderLog").document("postweek_" + today.isoformat())
    if claim.get().exists:
        return {"skipped": True}, None
    picked = []
    for s in db.collection("jobs").where("completedAt", ">=", start.isoformat()).stream():
        j = s.to_dict() or {}
        done = dg._local_day(j.get("completedAt"))      # the Chicago day (completedAt is UTC)
        if not (start.isoformat() <= done <= today.isoformat()) or j.get("noPost") or j.get("removeWhy"):
            continue
        photos = _week_photos(db, s.id)
        facts = _facts(j)
        if photos and (facts["work"] or facts["services"]):
            picked.append((s.id, j, facts, photos))
    if not picked:
        return {"none": True}, None
    if spend.over_cap(db):
        return {"error": "over the day's Claude limit"}, None
    try:
        claim.create({"at": dg._now().isoformat(), "jobs": [p[0] for p in picked]})
    except AlreadyExists:
        return {"skipped": True}, None
    try:
        resp = client.beta.messages.create(
            model=MODEL, max_tokens=6000, system=WEEK_SYSTEM,
            messages=[{"role": "user", "content": "The jobs:\n" + json.dumps(
                [dict(f, jobId=jid) for jid, _, f, _ in picked], ensure_ascii=False)}],
            thinking={"type": "adaptive"},
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": WEEK_SCHEMA}},
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        )
        text = next((b.text for b in resp.content if b.type == "text"), "")
        got = {str(x.get("jobId")): x for x in (json.loads(text).get("jobs") or []) if isinstance(x, dict)}
    except Exception:
        claim.delete()
        raise
    jobs, lines = [], []
    for jid, j, f, photos in picked:
        x = got.get(jid) or {}
        caption = MONEY.sub("", str(x.get("caption") or "")).strip()[:300]
        tags = [t for t in dict.fromkeys(_tag(t) for t in (x.get("hashtags") or [])) if t][:12]
        if not caption:
            continue
        title = (str(j.get("customerName") or "").strip() or "A job") + (" — " + f["town"] if f["town"] else "")
        jobs.append({"jobId": jid, "title": title[:120], "caption": caption, "hashtags": tags, "photos": photos})
        lines.append("=== " + title + " ===\n" + caption + "\n" + " ".join(tags))
    if not jobs:
        claim.delete()
        return {"error": "Claude's answer was empty"}, resp.usage
    import quickbooks
    stamp = quickbooks._stamp()
    board = db.collection("boards").document("todo").get()
    cols = ((board.to_dict() or {}).get("columns") or []) if board.exists else []
    col = next((c.get("id") for c in cols if isinstance(c, dict) and c.get("id")), "admin0")
    card_id = "pw" + today.strftime("%Y%m%d")
    week = start.strftime("%b ") + str(start.day)
    # The posting schedule puts the week's After photos on the Google
    # profile by itself once Google is hooked up (social.py _gallery): then
    # the step is not his.
    gauto = "google" in _scheduled(db) and bool(((_social(db).get("google") or {}).get("ok")))
    db.collection("boards").document("todo").collection("cards").document(card_id).set({
        "title": ("📸 " + str(len(jobs)) + " job" + ("" if len(jobs) == 1 else "s") + " ready to post — week of " + week)[:200],
        "notes": ("Pinterest and Yelp: save each job's photos (tap one to open it full size), upload them and "
                  "paste its words. Tick each job off as it goes up. Nothing is posted by Job Hub.\n\n"
                  + ("" if gauto else GOOGLE_PHOTOS + "\n\n")
                  + "\n\n".join(lines))[:9000],
        "checklist": [{"id": "pwj" + re.sub(r"[^A-Za-z0-9]", "", x["jobId"])[:20], "text": x["title"], "done": False,
                       "doneBy": None} for x in jobs]
        + ([] if gauto else [{"id": "pwgoogle", "text": GOOGLE_PHOTOS_TICK, "done": False, "doneBy": None}]),
        "postWeek": {"from": start.isoformat(), "to": today.isoformat(), "jobs": jobs, "googleAuto": gauto},
        "column": col, "order": int(dg._now().timestamp() * 1000), "due": None, "dueTime": None,
        "remindMins": None, "hasReminder": False, "remindUids": [], "noReminder": False,
        "type": None, "urgency": "normal", "labels": [], "color": None, "assignees": [],
        "jobId": None, "jobName": None, "jobNum": None,
        # His to do, not one for Claude's card runs (cards.py).
        "noClaude": True,
        "doneAt": None, "createdAt": stamp, "createdBy": "Job Hub", "updatedAt": stamp, "updatedBy": "Job Hub",
    })
    print("posts: the week's card", card_id, "with", len(jobs), "jobs")
    return {"cardId": card_id, "jobs": len(jobs)}, resp.usage
