"""Follow-up emails for bids that have gone quiet.

The Bids board lists the bids waiting on an answer; "Write the email" on one
comes here. Claude writes a short follow-up from the job itself and it is
saved in the owner's Gmail Drafts -- never sent. He reads it and sends it.

The job is read here from Firestore, not taken from the app: the app only says
WHICH job. That way the email cannot be steered by whatever a browser sends,
and the address it goes to is the one on the job.

Which bids count is the same rule the summaries chase (digest.CHASE_AFTER_DAYS);
the app draws the list, this only writes one email at a time.
"""

import datetime
import json

import cards
import digest as dg

MODEL = "claude-opus-5-5"

SYSTEM = (
    "You write follow-up emails for Jonah Linfield, owner of YD Exterior Visions LLC, a "
    "landscaping, hardscaping and snow removal company near Madison, Wisconsin. A customer "
    "was sent a bid and has not answered. Write the short email Jonah would send himself.\n\n"
    "How Jonah writes: friendly, plain, brief -- a working contractor, not a salesman. First "
    "name if there is one. Three to six short sentences. Mention what the bid was for in a few "
    "words so they know which one. Make it easy to answer: offer to go over it, change "
    "anything, or pencil in a start date. No pressure, no fake urgency, no discounts, no "
    "'just checking in' cliches, no exclamation marks in a row.\n\n"
    "Rules that matter:\n"
    "- Never invent a fact: no dates, prices, materials or promises the job does not give.\n"
    "- The job notes are Jonah's own working notes. Use them only to understand the work; "
    "never quote costs, margins, measurements or anything about other customers.\n"
    "- Only mention the price if it helps and it is given; say it the way it is written.\n"
    "- If this is not the first follow-up, keep it shorter and lighter, and do not repeat "
    "the earlier wording.\n"
    "- Sign off with 'Jonah' on one line and 'YD Exterior Visions' on the next. Add no "
    "phone number, website or address.\n"
    "- The subject is short and names the work (e.g. 'Your patio estimate')."
)

SCHEMA = {
    "type": "object",
    "properties": {
        "subject": {"type": "string"},
        "body": {"type": "string"},
    },
    "required": ["subject", "body"],
    "additionalProperties": False,
}


def _days_since(iso):
    try:
        then = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        return (datetime.datetime.now(datetime.timezone.utc) - then).days
    except Exception:       # noqa: BLE001
        return None


def _prompt(j):
    stage = j.get("bidStage") or "sent"
    lines = [
        "Today is %s." % dg._long_day(dg._now().date()),
        "Customer: %s" % ((j.get("customerName") or "").strip() or "(no name)"),
        "Where: %s" % (", ".join(x for x in [j.get("address"), j.get("city")] if x) or "(not given)"),
        "Services bid: %s" % (", ".join(j.get("serviceTypes") or []) or "(not given)"),
        "Bid price: %s" % ((j.get("jobPrice") or "").strip() or "(not given)"),
        "Bid stage: %s" % dg.BID_STAGE_NAME.get(stage, stage),
    ]
    days = _days_since(j.get("bidStageAt") or j.get("lastModified"))
    if days is not None:
        lines.append("Days in that stage: %d" % days)
    if j.get("quoteDate"):
        lines.append("Quote date: %s" % j.get("quoteDate"))
    earlier = [f for f in (j.get("followUps") or []) if isinstance(f, dict)]
    if earlier:
        lines.append("Follow-ups already drafted: %d, the last %s days ago, subject \"%s\"." % (
            len(earlier), _days_since(earlier[-1].get("at")), earlier[-1].get("subject") or ""))
    lines.append("\nJonah's notes on the job (context only):\n%s" % ((j.get("notes") or "").strip()[:3000] or "(none)"))
    return "\n".join(lines)


def draft(client, job_id):
    """Write and save one follow-up. Returns (result, usage) -- result is
    {draftId, link, to, subject} or {error}; usage is the tokens spent, or None
    when Claude was never asked."""
    snap = dg._db().collection("jobs").document(job_id).get()
    if not snap.exists:
        return {"error": "That job was not found"}, None
    j = snap.to_dict() or {}
    if (j.get("jobStatus") or "quoting") != "quoting" or j.get("bidStage") in ("won", "lost"):
        return {"error": "That job is not a bid waiting on an answer any more"}, None
    to = (j.get("email") or "").strip()
    if not cards.EMAIL_RE.match(to):
        return {"error": "This job has no email address. Add one to the job first."}, None

    resp = client.beta.messages.create(
        model=MODEL, max_tokens=4000, system=SYSTEM,
        messages=[{"role": "user", "content": _prompt(j)}],
        thinking={"type": "adaptive"},
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    )
    if resp.stop_reason == "refusal":
        return {"error": "Claude declined to write this one"}, resp.usage
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        got = json.loads(text)
    except ValueError:
        return {"error": "Claude's answer could not be read. Try again."}, resp.usage
    subject, body = (got.get("subject") or "").strip(), (got.get("body") or "").strip()
    if not subject or not body:
        return {"error": "Claude's answer was empty. Try again."}, resp.usage

    saved = cards.draft_email(to, subject, body)
    if saved.get("error"):
        return {"error": saved["error"].split(". Put the full")[0] + "."}, resp.usage
    print("followup: drafted for job", job_id)
    return {"draftId": saved.get("draftId"), "link": saved.get("link"), "to": to,
            "subject": saved.get("subject")}, resp.usage
