"""Follow-up emails for bids that have gone quiet.

The Bids board lists the bids waiting on an answer; "Write the email" on one
comes here. Claude writes a short follow-up from the job itself and it is
saved in the owner's Gmail Drafts -- never sent. He reads it and sends it.
The follow-up plan's own emails (auto, below) are sent by themselves.

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
from firebase_admin import firestore

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
        lines.append("Follow-ups already written: %d, the last %s days ago, subject \"%s\"." % (
            len(earlier), _days_since(earlier[-1].get("at")), earlier[-1].get("subject") or ""))
    lines.append("\nJonah's notes on the job (context only):\n%s" % ((j.get("notes") or "").strip()[:3000] or "(none)"))
    return "\n".join(lines)


def _step_words(step):
    """What the plan's email step asks of this email (the plan below)."""
    if not step:
        return ""
    if step.get("last"):
        return ("\n\nThis is the LAST follow-up (number %d). Say kindly that you will close out the "
                "file for now unless they would like to go ahead or talk it over, and that the door "
                "stays open. Short." % step.get("n", 4))
    if step.get("short"):
        return ("\n\nThis is a quick check-in in place of a text message: two or three short "
                "sentences, no more -- did they get a chance to look at the estimate, and any "
                "questions. Sign off as usual.")
    if (step.get("n") or 1) > 1:
        return ("\n\nThis is follow-up number %d: shorter and lighter than the first; offer to go "
                "over it or adjust the scope." % step["n"])
    return "\n\nThis is the first follow-up email; Jonah may also have tried calling."


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


def draft(client, job_id, step=None):
    """Write and save one follow-up. Returns (result, usage) -- result is
    {draftId, link, to, subject} or {error}; usage is the tokens spent, or None
    when Claude was never asked. `step`: the plan's email step it is written
    for, if any (the plan's own are sent by auto, below)."""
    snap = dg._db().collection("jobs").document(job_id).get()
    if not snap.exists:
        return {"error": "That job was not found"}, None
    j = snap.to_dict() or {}
    why = _not_waiting(j)
    if why:
        return {"error": why}, None
    to = (j.get("email") or "").strip()
    if not cards.EMAIL_RE.match(to):
        return {"error": "This job has no email address. Add one to the job first."}, None
    got, usage = _write(client, j, to, step)
    if got.get("error"):
        return got, usage
    saved = cards.draft_email(to, got["subject"], got["body"], got["reply"])
    if saved.get("error"):
        return {"error": saved["error"].split(". Put the full")[0] + "."}, usage
    print("followup: drafted for job", job_id, "in the estimate thread" if got["reply"] else "as a new email")
    return {"draftId": saved.get("draftId"), "link": saved.get("link"), "to": to,
            "subject": saved.get("subject"), "inThread": bool(got["reply"])}, usage


def _not_waiting(j):
    """Why this job gets no follow-up, or '' -- it is not a bid waiting on an
    answer."""
    if j.get("deletedAt"):
        return "That bid is in Recently deleted"
    if (j.get("jobStatus") or "quoting") != "quoting" or j.get("bidStage") in ("won", "lost"):
        return "That job is not a bid waiting on an answer any more"
    # The customer already answered in QuickBooks: no "just following up"
    # email to someone who said no -- or yes (the chase rule, digest.py).
    q = j.get("qbEstimate") or {}
    if dg.qb_turned_down(q):
        return "The customer turned this estimate down in QuickBooks — mark the bid lost instead"
    if dg.qb_accepted(q):
        return "The customer accepted this estimate in QuickBooks — book it instead"
    return ""


def _write(client, j, to, step):
    """Claude writes the follow-up: ({subject, body, reply} or {error}, usage).
    `reply` is the estimate's email thread when it is found (else None)."""
    resp = client.beta.messages.create(
        model=MODEL, max_tokens=4000, system=SYSTEM,
        messages=[{"role": "user", "content": _prompt(j) + _step_words(step)}],
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
    return {"subject": subject, "body": body, "reply": reply}, resp.usage


# ---------------------------------------------------------------- the follow-up plan
#
# Jonah (23 Oct 2026): "build automatic follow up system for jobs" -- for bids
# with no answer AND for finished jobs; "a system for following up that
# includes calling and texting. Like a tried and true best process"; a
# "mark it lost" card at the end; the thank-you only "when the final invoice
# is paid".
#
# THE PLAN for a bid sent with no answer, by days since it went out -- the
# usual contractor cadence: a phone call first (the warmest, and most quotes
# are won by whoever calls back), an email the same day, then lighter
# touches spread out, then one clear last note, then a decision:
#   day 2   call (voicemail if no answer)   email 1
#   day 5   a quick check-in email (was a text: Jonah, 26 Oct 2026)
#   day 7   email 3, shorter
#   day 10  call
#   day 14  last email -- "I'll close out the file unless..."
#   day 15  a "mark it lost?" card on My to-dos (never marked lost by itself)
# The emails SEND THEMSELVES from his Gmail in the estimate's thread (Jonah,
# 26 Oct 2026: "i want the follow up automated apart from making a call"),
# in the morning (SEND_HOURS) -- but never once the customer has written to
# him since the bid went out (chaseHeard), and a step is counted done
# without sending when he has emailed them himself since the last one.
# The calls are his: the app lists them with a tap to call, and he ticks
# them done (boards.js). A step is passed over once the next call (or the
# next email) is due, so a bid found late is not sent three emails at once;
# once the last step is due, only it is open. The same table is in boards.js
# (CHASE_STEPS) -- change both. text1 keeps the id it had as a text, so one
# already texted counts as done.
STEPS = [
    {"id": "call1", "day": 2, "kind": "call"},
    {"id": "email1", "day": 2, "kind": "email", "n": 1},
    {"id": "text1", "day": 5, "kind": "email", "n": 2, "short": True},
    {"id": "email2", "day": 7, "kind": "email", "n": 3},
    {"id": "call2", "day": 10, "kind": "call"},
    {"id": "email3", "day": 14, "kind": "email", "n": 4, "last": True},
    {"id": "lost", "day": 15, "kind": "decide"},
]
# Sent by the hourly run at most this many at a time (Claude is asked for
# each; the rest wait for the next hour).
AUTO_MAX = 4
# The hours (Chicago) a follow-up email goes out in: the morning.
SEND_HOURS = range(8, 12)
# How far back a customer's unanswered email holds the plan's emails.
WROTE_DAYS = 45
# Bids sent before the plan existed start it from here, rather than all at
# their last step on the first morning.
PLAN_FROM = datetime.datetime(2026, 10, 22, 5, 0, tzinfo=datetime.timezone.utc)
# A thank-you is drafted only for jobs paid off from this day on -- not for
# every job paid this season.
THANKS_FROM = "2026-10-24"


def _when(iso):
    try:
        t = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=datetime.timezone.utc)
    except (TypeError, ValueError):
        return None


def chase_start(j):
    """When the bid went out: what the app set (chase.start), else QuickBooks'
    emailed time, else two days before it was moved to Follow up by itself,
    else when it was put in Sent -- never before PLAN_FROM. boards.js
    chaseStart is the same."""
    got = [_when((j.get("chase") or {}).get("start"))]
    if not got[0]:
        q = j.get("qbEstimate") or {}
        got = [_when(q.get("sentAt") or q.get("emailedAt"))]
        auto_at = _when(j.get("autoFollowUpAt"))
        if auto_at:
            got.append(auto_at - datetime.timedelta(days=2))
        if j.get("bidStage") == "sent":
            got.append(_when(j.get("bidStageAt")))
    got = [t for t in got if t]
    if not got:
        return None
    return max(min(got), PLAN_FROM)


def _chicago_days(start):
    """Whole calendar days in Chicago since `start` (day 0 the day it went)."""
    tz = dg.TZ
    return (dg._now().astimezone(tz).date() - start.astimezone(tz).date()).days


def chasing(j):
    """Whether this bid is on the plan: a bid in Sent or Follow up, not
    answered in QuickBooks, not stopped by hand ("They answered")."""
    if j.get("deletedAt") or j.get("removeWhy"):
        return False
    if (j.get("jobStatus") or "quoting") != "quoting" or j.get("bidStage") not in ("sent", "followUp"):
        return False
    q = j.get("qbEstimate") or {}
    if dg.qb_turned_down(q) or dg.qb_accepted(q):
        return False
    return not (j.get("chase") or {}).get("stoppedAt")


def done_steps(j):
    """Step ids done: ticked in the app (chase.done), or sent, drafted or
    counted done here (chaseDrafts), or its card made (chaseLostCard)."""
    out = set(((j.get("chase") or {}).get("done") or {}).keys())
    out |= set((j.get("chaseDrafts") or {}).keys())
    out |= {f.get("step") for f in (j.get("followUps") or []) if isinstance(f, dict) and f.get("step")}
    if j.get("chaseLostCard"):
        out.add("lost")
    return out


def open_steps(j):
    """The steps waiting now, in order (see the plan above)."""
    start = chase_start(j)
    if not start or not chasing(j):
        return []
    days = _chicago_days(start)
    due = [s for s in STEPS if s["day"] <= days]
    if not due:
        return []
    done = done_steps(j)
    if any(s["kind"] == "decide" for s in due):
        return [s for s in due if s["kind"] == "decide" and s["id"] not in done]
    # Calls and texts are one lane (the phone), emails another: in each, a
    # step not done is passed over once the next one is due.
    lane = lambda s: "email" if s["kind"] == "email" else "phone"
    latest = {}
    for s in due:
        latest[lane(s)] = s["id"]
    return [s for s in due if latest[lane(s)] == s["id"] and s["id"] not in done]


THANKS_SYSTEM = (
    "You write a short thank-you email for Jonah Linfield, owner of YD Exterior Visions LLC, a "
    "landscaping, hardscaping and snow removal company near Madison, Wisconsin. The customer's "
    "job is finished and paid in full. Thank them, in Jonah's plain, friendly voice -- a working "
    "contractor, not a salesman. First name if there is one. Mention the work in a few words. "
    "Then ask, once and lightly, whether they would leave a Google review -- it helps a small "
    "local business. Three to six short sentences.\n\n"
    "Rules: never invent a fact, date or promise the job does not give. Jonah's job notes are "
    "context only: never quote costs or measurements. If a review link is given, put it on its "
    "own line exactly as given; if none is given, put the line [Your Google review link] where it "
    "goes, for Jonah to paste. Sign off with 'Jonah' on one line and 'YD Exterior Visions' on the "
    "next. The subject is short and warm (e.g. 'Thank you from YD Exterior Visions')."
)


def _thanks_prompt(j, link):
    return "\n".join([
        "Customer: %s" % ((j.get("customerName") or "").strip() or "(no name)"),
        "Services: %s" % (", ".join(j.get("serviceTypes") or []) or "(not given)"),
        "What the crew did: %s" % ((j.get("crewWhat") or "").strip() or "(not given)"),
        "Google review link: %s" % (link or "(none given)"),
        "\nJonah's notes on the job (context only):\n%s" % ((j.get("notes") or "").strip()[:2000] or "(none)"),
    ])


def thanks(client, job_id, j, link):
    """The thank-you and review ask for a job paid off, into Gmail Drafts.
    Returns (result, usage) like draft()."""
    to = (j.get("email") or "").strip()
    if not cards.EMAIL_RE.match(to):
        return {"error": "no email on the job"}, None
    resp = client.beta.messages.create(
        model=MODEL, max_tokens=3000, system=THANKS_SYSTEM,
        messages=[{"role": "user", "content": _thanks_prompt(j, link)}],
        thinking={"type": "adaptive"},
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    )
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        got = json.loads(text) if resp.stop_reason != "refusal" else {}
    except ValueError:
        got = {}
    subject, body = (got.get("subject") or "").strip(), (got.get("body") or "").strip()
    if not subject or not body:
        return {"error": "Claude's answer was empty"}, resp.usage
    saved = cards.draft_email(to, subject, body)
    if saved.get("error"):
        return {"error": saved["error"]}, resp.usage
    return {"draftId": saved.get("draftId"), "link": saved.get("link"), "to": to,
            "subject": saved.get("subject")}, resp.usage


def _lost_card(db, job_id, j):
    """The "mark it lost?" card on My to-dos (receipts.py makes cards the
    same way). Its id comes from the job, so it is only ever made once."""
    import receipts
    board_id, board = receipts._board(db, "todo")
    if not board_id:
        return None
    cid = "fu" + re.sub(r"[^a-z0-9]", "", job_id.lower())[:24]
    name = (j.get("customerName") or "").strip() or "a bid"
    num = str(j.get("estimateNumber") or "").strip()
    card = receipts._new_card(
        board, "No answer from %s after the follow-ups — mark it lost?" % name,
        "Two calls and four emails since the bid went out, and no answer. "
        "Mark the bid lost on the Bids board, or move it back to Sent if you want to keep after it.",
        jobId=job_id, jobName=name, jobNum=num or None, noClaude=True,
        createdBy="Job Hub (follow-ups)", updatedBy="Job Hub (follow-ups)")
    db.collection("boards").document(board_id).collection("cards").document(cid).set(card)
    return cid


def _stamp():
    """Now as the app writes lastModified (JavaScript's toISOString)."""
    t = datetime.datetime.now(datetime.timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (t.microsecond // 1000)


def _iso(t):
    """A datetime as the app writes times (JavaScript's toISOString)."""
    t = t.astimezone(datetime.timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (t.microsecond // 1000)


def heard(j):
    """What the customer wrote him since the bid went out (chaseHeard, found by
    auto), unless he has chosen to keep emailing since (chase.resumeAt,
    boards.js chaseResume). boards.js chaseHeardOf is the same."""
    h = j.get("chaseHeard") or {}
    at = _when(h.get("at"))
    resumed = _when((j.get("chase") or {}).get("resumeAt"))
    return h if at and not (resumed and resumed > at) else None


def _found(q, after, skip=()):
    """The newest message in his mailbox matching Gmail search `q` that came
    after `after`, as {id, at, subject}, or None. Ids in `skip` don't count."""
    for m in (_gmail("/messages", {"q": "%s after:%d" % (q, int(after.timestamp())), "maxResults": 10})
              .get("messages") or []):
        if m.get("id") in skip:
            continue
        full = _gmail("/messages/" + m["id"], {"format": "metadata", "metadataHeaders": ["Subject"]})
        at = datetime.datetime.fromtimestamp(int(full.get("internalDate") or 0) / 1000, datetime.timezone.utc)
        if at > after:          # Gmail's after: is to the second; this is exact
            return {"id": m["id"], "at": at, "subject": _header(full, "Subject")}
    return None


def _contact(db, ref, j, known):
    """The email the plan writes to: the job's, else its QuickBooks
    customer's (customers/{id}, customers.py) -- which is then written onto
    the job, with the customer's phone when the job has none, so the call
    button has it too. 26 Oct 2026: 5 of 9 bids on the plan had no email on
    the job and were quietly never written to. '' when there is none.
    `known`: customers already read this run."""
    email, phone = (j.get("email") or "").strip(), (j.get("phone") or "").strip()
    if cards.EMAIL_RE.match(email) and phone:
        return email
    # The customer the job is tied to, then its estimate's QuickBooks
    # customer: a job tied by hand to a lead with no email (a bid on the
    # plan, 26 Oct 2026) still has its QuickBooks one.
    q_cid = str((j.get("qbEstimate") or {}).get("customerId") or "").strip()
    patch = {}
    for cid in dict.fromkeys(x for x in (str(j.get("customerId") or "").strip(), q_cid) if x):
        if cid not in known:
            try:
                snap = db.collection("customers").document(cid).get()
                known[cid] = (snap.to_dict() or {}) if snap.exists else {}
            except Exception as err:    # noqa: BLE001
                print("followup: customer", cid, "not read:", err)
                known[cid] = {}
        c = known[cid]
        if not cards.EMAIL_RE.match(email) and cards.EMAIL_RE.match((c.get("email") or "").strip()):
            patch["email"] = email = c["email"].strip()
        if not phone and (c.get("phone") or "").strip():
            patch["phone"] = phone = c["phone"].strip()
    if patch:
        patch["lastModified"] = _stamp()
        ref.update(patch)
        j.update(patch)
        print("followup: filled", ", ".join(k for k in patch if k != "lastModified"), "on", ref.id)
    return email if cards.EMAIL_RE.match(email) else ""


def _send_step(client, ref, jid, j, s, to, spent):
    """One email step of the plan, now that it is due: held because the
    customer has written to him since the bid went out (chaseHeard, he is
    told once), counted done without sending because he has emailed them
    himself since the last step, or written and sent in the estimate's
    thread. Returns (news for his phone or None, whether Claude was asked).
    Any doubt about his mailbox and nothing is sent."""
    name = (j.get("customerName") or "").strip() or "A customer"
    marks = [d for d in (j.get("chaseDrafts") or {}).values() if isinstance(d, dict)]
    resumed = _when((j.get("chase") or {}).get("resumeAt"))
    since = max(t for t in (chase_start(j), resumed) if t)
    # A send that may have gone out with no record of it (the record's write
    # failed): counted as sent, never sent twice.
    pending = j.get("chaseSending") or {}
    if pending.get("step") == s["id"]:
        ref.update({"chaseDrafts." + s["id"]: {"at": pending.get("at") or _stamp(), "sent": True, "unconfirmed": True},
                    "chaseSending": firestore.DELETE_FIELD, "lastModified": _stamp()})
        return None, False
    try:
        # Their newest email: since the bid went out, or in the weeks before
        # it with no answer from him after it -- a customer waiting on his
        # reply never gets "did you get a chance to look?" (26 Oct 2026: two
        # customers had written before the plan began and were unanswered or
        # upset). Nothing from before he said "Keep emailing them" counts.
        wrote = _found("from:%s -in:sent -in:drafts -in:chats" % to,
                       resumed or min(since, dg._now() - datetime.timedelta(days=WROTE_DAYS)))
        unanswered = bool(wrote) and wrote["at"] <= since and not _found("in:sent to:%s" % to, wrote["at"])
        last = max([since + datetime.timedelta(hours=20)] + [t for t in (_when(d.get("at")) for d in marks) if t])
        mine = _found("in:sent to:%s" % to, last, {d.get("messageId") for d in marks if d.get("messageId")})
    except Exception as err:        # noqa: BLE001
        print("followup: mailbox not read for", jid, "-- nothing sent:", err)
        return None, False
    was = j.get("chaseHeard") or {}
    if wrote and (wrote["at"] > since or unanswered):
        if was.get("messageId") == wrote["id"]:
            return None, False          # held for this email already, and he was told
        ref.update({"chaseHeard": {"at": _iso(wrote["at"]), "subject": (wrote["subject"] or "")[:200],
                                   "messageId": wrote["id"], "unanswered": unanswered, "foundAt": _stamp()},
                    "lastModified": _stamp()})
        if unanswered:
            return {"kind": "followup", "jobId": jid, "title": "✋ %s is waiting on your answer" % name,
                    "body": "Their email of %s has no reply from you, so the automatic follow-ups for this bid are held."
                            % wrote["at"].astimezone(dg.TZ).strftime("%b %d").replace(" 0", " ")}, False
        return {"kind": "followup", "jobId": jid, "title": "✋ %s wrote back" % name,
                "body": "The automatic follow-up emails for this bid are stopped — read what they said and move the bid along."}, False
    if was.get("unanswered"):
        # He has answered the email that held it: the plan carries on.
        ref.update({"chaseHeard": firestore.DELETE_FIELD, "lastModified": _stamp()})
    if mine:
        ref.update({"chaseDrafts." + s["id"]: {"at": _stamp(), "byHand": True, "emailedAt": _iso(mine["at"])},
                    "lastModified": _stamp()})
        return None, False
    ref.update({"chaseSending": {"step": s["id"], "at": _stamp()}})
    got, usage = _write(client, j, to, s)
    if spent and usage is not None:
        spent(usage)
    sent = cards.send_mail(to, got["subject"], got["body"], got["reply"]) if not got.get("error") else got
    if sent.get("error"):
        print("followup: not sent for", jid, sent["error"])
        ref.update({"chaseSending": firestore.DELETE_FIELD})
        return None, True
    at = _stamp()
    rec = {"at": at, "sent": True, "messageId": sent.get("messageId"), "threadId": sent.get("threadId"),
           "subject": sent.get("subject") or "", "inThread": bool(got["reply"]),
           "link": "https://mail.google.com/mail/u/%s/#all/%s" % (dg.OWNER_EMAIL, sent.get("threadId") or "")}
    ref.update({"chaseDrafts." + s["id"]: rec, "chaseSending": firestore.DELETE_FIELD,
                "followUps": firestore.ArrayUnion([dict(rec, by="Job Hub (follow-ups)", step=s["id"])]),
                "lastModified": at})
    print("followup: sent", s["id"], "for job", jid, "in the estimate thread" if got["reply"] else "as a new email")
    return {"kind": "followup", "jobId": jid, "title": "✉️ Follow-up sent",
            "body": "%s — follow-up %d went out from your Gmail%s." % (
                name, s.get("n") or 1, " in the estimate's thread" if got["reply"] else "")}, True


def auto(client, deadline=None, spent=None):
    """The hourly part (main.py /cards/run): every bid's email step that is
    due sent (in the morning, SEND_HOURS), the "mark it lost?" card made, and
    a thank-you drafted for a job paid off. `spent(usage)` records what each
    Claude call cost. Returns news for the owner's phone (main._tell_owner,
    kind "followup"). settings/followUp {auto: false} switches it off;
    {reviewLink} goes in the thank-you."""
    import time
    db = dg._db()
    news = []
    try:
        conf = db.collection("settings").document("followUp").get().to_dict() or {}
    except Exception:           # noqa: BLE001
        conf = {}
    if conf.get("auto") is False:
        return news
    link = (conf.get("reviewLink") or "").strip()
    morning = dg._now().astimezone(dg.TZ).hour in SEND_HOURS
    drafted, known, mailed = 0, {}, set()
    for snap in db.collection("jobs").stream():
        if deadline and time.monotonic() > deadline:
            break
        j = snap.to_dict() or {}
        jid = snap.id
        ref = db.collection("jobs").document(jid)
        name = (j.get("customerName") or "").strip()
        if (j.get("jobStatus") or "quoting") == "quoting":
            steps = open_steps(j)
            to = _contact(db, ref, j, known) if steps else ""
            for s in steps:
                if s["kind"] == "decide":
                    cid = _lost_card(db, jid, j)
                    if cid:
                        ref.update({"chaseLostCard": {"cardId": cid, "at": _stamp()}, "lastModified": _stamp()})
                        news.append({"kind": "followup", "jobId": jid, "title": "❓ No answer after the follow-ups",
                                     "body": "%s — mark the bid lost? A card is on My to-dos." % (name or "A bid")})
                # One email to a person a run: the same customer's two bids
                # (or a second step) wait for the next hour, when this one's
                # email counts as emailed since.
                # Held because they wrote back: until he says carry on. Held
                # because their email had no answer: looked at again, so his
                # reply lets the plan carry on by itself.
                elif (s["kind"] == "email" and morning and to and to.lower() not in mailed
                      and drafted < AUTO_MAX and (not heard(j) or heard(j).get("unanswered"))):
                    item, asked = _send_step(client, ref, jid, j, s, to, spent)
                    drafted += 1 if asked else 0
                    mailed.add(to.lower())
                    if item:
                        news.append(item)
            continue
        # Finished and paid off since THANKS_FROM: the thank-you.
        if j.get("workStage") != "paid" or j.get("thanksEmail") or drafted >= AUTO_MAX:
            continue
        if str(j.get("workStageAt") or "")[:10] < THANKS_FROM or not cards.EMAIL_RE.match((j.get("email") or "").strip()):
            continue
        result, usage = thanks(client, jid, j, link)
        drafted += 1
        if spent and usage is not None:
            spent(usage)
        if result.get("error"):
            print("followup: thank-you not drafted for", jid, result["error"])
            continue
        at = _stamp()
        ref.update({"thanksEmail": {"at": at, "draftId": result.get("draftId"), "link": result.get("link"),
                                    "subject": result.get("subject") or ""}, "lastModified": at})
        news.append({"kind": "followup", "jobId": jid, "title": "🙏 Thank-you drafted",
                     "body": "%s paid in full — a thank-you with the review ask is in Gmail Drafts." % (name or "A customer")})
    return news
