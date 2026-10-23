"""Follow-up emails for bids that have gone quiet.

The Bids board lists the bids waiting on an answer; "Write the email" on one
comes here. Claude writes a short follow-up from the job itself and it is
saved in the owner's Gmail Drafts -- never sent. He reads it and sends it.

The job is read here from Firestore, not taken from the app: the app only says
WHICH job. That way the email cannot be steered by whatever a browser sends,
and the address it goes to is the one on the job.

Which bids count is the same rule the summaries chase (digest.CHASE_AFTER_DAYS);
the app draws the list, this only writes one email at a time -- and refuses a
bid the customer has already answered in QuickBooks.
"""

import datetime
import json
import re

import requests

import cards
import digest as dg

# Reading the owner's mail, to find the email a bid went out in (the same
# permission the receipts reader has: receipts.GMAIL_READ).
GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly"
GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"

# Writing a short email: the mid-priced model writes it as well (Jonah, 7 Oct:
# no Claude feature should cost more than it needs to).
MODEL = "claude-sonnet-5-5"

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


def _gmail(path, params=None):
    token = dg._gmail_access_token(GMAIL_READ)
    r = requests.get(GMAIL_API + path, headers={"Authorization": "Bearer " + token}, params=params, timeout=30)
    if r.status_code >= 300:
        raise RuntimeError("gmail %s -> %d" % (path, r.status_code))
    return r.json()


def _header(m, name):
    for h in ((m.get("payload") or {}).get("headers") or []):
        if str(h.get("name") or "").lower() == name.lower():
            return str(h.get("value") or "")
    return ""


def estimate_thread(j, to):
    """The email thread the bid went out in, in the owner's Gmail, as
    cards.draft_email's `reply` ({threadId, subject, inReplyTo, references}),
    or None. Jonah (22 Oct 2026): "follow up emails should always be sent in
    the same thread as the estimate". QuickBooks emails an estimate with him
    copied (BillEmailBcc), so his copy is in his mailbox: the newest thread to
    the customer whose subject names the estimate's number. Its first subject
    is the thread's; the answer goes after its last message (not a draft)."""
    num = str((j.get("qbEstimate") or {}).get("docNumber") or j.get("estimateNumber") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9-]{1,20}", num):
        return None
    says = re.compile(r"(?<![A-Za-z0-9])" + re.escape(num) + r"(?![A-Za-z0-9])")
    found = []
    for t in (_gmail("/threads", {"q": 'to:%s subject:"%s" -in:draft newer_than:2y' % (to, num),
                                  "maxResults": 10}).get("threads") or []):
        full = _gmail("/threads/" + t["id"], {"format": "metadata",
                                              "metadataHeaders": ["Subject", "Message-ID", "To"]})
        sent = [m for m in full.get("messages") or [] if "DRAFT" not in (m.get("labelIds") or [])]
        if not sent:
            continue
        subject = _header(sent[0], "Subject")
        if not says.search(subject) or to.lower() not in _header(sent[0], "To").lower():
            continue
        ids = [i for i in (_header(m, "Message-ID") for m in sent) if i]
        if ids:
            found.append((int(sent[-1].get("internalDate") or 0), {
                "threadId": t["id"], "subject": subject, "inReplyTo": ids[-1],
                # The whole chain, as mail does it -- bounded, the newest kept.
                "references": " ".join(ids[-20:])}))
    return max(found, key=lambda x: x[0])[1] if found else None


def draft(client, job_id):
    """Write and save one follow-up. Returns (result, usage) -- result is
    {draftId, link, to, subject} or {error}; usage is the tokens spent, or None
    when Claude was never asked."""
    snap = dg._db().collection("jobs").document(job_id).get()
    if not snap.exists:
        return {"error": "That job was not found"}, None
    j = snap.to_dict() or {}
    if j.get("deletedAt"):
        return {"error": "That bid is in Recently deleted"}, None
    if (j.get("jobStatus") or "quoting") != "quoting" or j.get("bidStage") in ("won", "lost"):
        return {"error": "That job is not a bid waiting on an answer any more"}, None
    # The customer already answered in QuickBooks: no "just following up"
    # email to someone who said no -- or yes (the chase rule, digest.py).
    q = j.get("qbEstimate") or {}
    if dg.qb_turned_down(q):
        return {"error": "The customer turned this estimate down in QuickBooks — mark the bid lost instead"}, None
    if dg.qb_accepted(q):
        return {"error": "The customer accepted this estimate in QuickBooks — book it instead"}, None
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

    # In the estimate's own thread when it can be found: the customer sees
    # it under the bid, not as a stranger's new email. Its subject is then
    # the estimate's ("Re: ..."); Gmail keeps a draft in a thread only so.
    try:
        reply = estimate_thread(j, to)
    except Exception as err:        # noqa: BLE001 -- a new email still beats none
        print("followup: estimate thread not looked up:", err)
        reply = None
    if reply:
        subject = reply["subject"] if re.match(r"(?i)re:", reply["subject"]) else "Re: " + reply["subject"]
    saved = cards.draft_email(to, subject, body, reply)
    if saved.get("error"):
        return {"error": saved["error"].split(". Put the full")[0] + "."}, resp.usage
    print("followup: drafted for job", job_id, "in the estimate thread" if reply else "as a new email")
    return {"draftId": saved.get("draftId"), "link": saved.get("link"), "to": to,
            "subject": saved.get("subject"), "inThread": bool(reply)}, resp.usage
