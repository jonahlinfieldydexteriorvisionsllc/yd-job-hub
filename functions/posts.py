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
    "company near Madison, Wisconsin, about one job they just finished. The owner, Jonah, posts "
    "them himself.\n\n"
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
    "Rules, all of them: never name the customer, never give a street or house number -- the "
    "town only. Never mention any price, cost or budget. Never invent anything not given: no "
    "materials, sizes, plants, timelines, awards or claims beyond the facts. Use the facts' own "
    "measurements and materials when they are given. No phone number, website or address in any "
    "post (Jonah adds his own). Plain English, no jargon; write as the company ('we')."
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


def _clean(text, limit):
    """A customer's words with any money taken out (a scope might say what was agreed)."""
    return MONEY.sub("", str(text or "")).strip()[:limit]


def _facts(j):
    """What Claude is told about the job: what was done, where (the town),
    with what -- never who, the street, or a price."""
    est = j.get("estimate") or {}
    work = []
    for w in (est.get("work") or [])[:20]:
        if not w:
            continue
        title, scope = _clean(w.get("title"), 200), _clean(w.get("scope"), 1500)
        if title or scope:
            work.append({"title": title, "scope": scope})
    mats = []
    for m in (est.get("materials") or [])[:40]:
        name = _clean((m or {}).get("name"), 120)
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
        if j.get("postsDraft"):
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


def _write(client, db, job_id, j, facts):
    resp = client.beta.messages.create(
        model=MODEL, max_tokens=6000, system=SYSTEM,
        messages=[{"role": "user", "content": "The job:\n" + json.dumps(facts, ensure_ascii=False)}],
        thinking={"type": "adaptive"},
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    )
    if resp.stop_reason == "refusal":
        return {"error": "Claude declined to write these"}, resp.usage
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        got = json.loads(text)
    except ValueError:
        return {"error": "Claude's answer could not be read. Try again."}, resp.usage
    posts = {k: str(got.get(k) or "").strip() for k in SCHEMA["required"]}
    if not all(posts[k] for k, _ in PLACES):
        return {"error": "Claude's answer was empty. Try again."}, resp.usage

    name = str(j.get("customerName") or "").strip() or "Untitled job"
    num = str(j.get("estimateNumber") or "").strip()
    photos = _after_photos(db, job_id)
    parts = ["Copy each into its place and tick it off as it goes up. Nothing is posted by Job Hub.",
             "Photos: " + ("the after photos —\n" + "\n".join(photos) if photos
                           else "none marked After on the job yet (📷 on the job's page).")]
    for key, label in PLACES:
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
        "checklist": [{"id": "pst" + k, "text": label, "done": False, "doneBy": None} for k, label in PLACES],
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
    return {"cardId": card_id, "photos": len(photos)}, resp.usage
