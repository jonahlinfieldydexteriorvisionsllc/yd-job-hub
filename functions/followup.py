"""Follow-up emails for bids that have gone quiet.

The Bids board lists the bids waiting on an answer; "Write the email" on one
comes here. Claude writes a short follow-up from the job itself and it is
saved in the owner's Gmail Drafts -- never sent. He reads it and sends it.
The follow-up plan's own emails (auto, below) are sent by themselves, and so
is the thank-you once a job is paid off (the end of this file).

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
from google.api_core.exceptions import AlreadyExists

import cards
import digest as dg
import stages

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
    if _invoiced(j):
        return "This estimate is already an invoice in QuickBooks — book it instead"
    return ""


_LOOK = object()


def _write(client, j, to, step, reply=_LOOK):
    """Claude writes the follow-up: ({subject, body, reply} or {error}, usage).
    `reply` is the estimate's email thread when it is found (else None) --
    looked up here unless the caller has already (auto, which sends nothing
    when the lookup fails)."""
    import voice
    resp = client.beta.messages.create(
        model=MODEL, max_tokens=4000, system=SYSTEM + voice.block(),
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
    if reply is _LOOK:
        try:
            reply = estimate_thread(j, to)
        except Exception as err:    # noqa: BLE001 -- a new draft still beats none
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
# The last email kept open this many days from its own day when it has not
# gone (a morning missed, his mailbox unreadable, the day's Claude limit):
# the "mark it lost?" question waits for it meanwhile, so he is never asked
# about a bid whose last email never went. boards.js the same.
LAST_WAIT_DAYS = 4
# Mornings an email step may fail (Claude could not write it, Gmail refused
# it) before the plan stops trying it and tells him: a step that keeps
# failing took a Claude call every hour and one of the run's AUTO_MAX.
FAIL_DAYS = 2
# A follow-up Claude wrote longer than this many words is not sent by itself
# (his are three to six short sentences): it waits in his Drafts.
MAX_WORDS = 150


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
    if dg.qb_turned_down(q) or dg.qb_accepted(q) or _invoiced(j):
        return False
    return not (j.get("chase") or {}).get("stoppedAt")


def _invoiced(j):
    """He made the estimate into an invoice in QuickBooks (his way to take
    the deposit) without marking it accepted: the customer is going ahead,
    and is never asked "did you get a chance to look?" (boards.js the same)."""
    q = j.get("qbEstimate") or {}
    return q.get("status") in ("Closed", "Converted") or bool(stages.qb_invoice_of(j))


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
        last = next(s for s in STEPS if s.get("last"))
        if last["id"] not in done and days < last["day"] + LAST_WAIT_DAYS:
            return [last]
        return [s for s in due if s["kind"] == "decide" and s["id"] not in done]
    # Calls and texts are one lane (the phone), emails another: in each, a
    # step not done is passed over once the next one is due.
    lane = lambda s: "email" if s["kind"] == "email" else "phone"
    latest = {}
    for s in due:
        latest[lane(s)] = s["id"]
    return [s for s in due if latest[lane(s)] == s["id"] and s["id"] not in done]


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
    # What was really done, not what the plan meant to do: a step passed
    # over (or one that never went) is not counted.
    done = done_steps(j)
    n = lambda kind: sum(1 for s in STEPS if s["kind"] == kind and s["id"] in done)
    said = lambda k, one: "%d %s%s" % (k, one, "" if k == 1 else "s")
    card = receipts._new_card(
        board, "No answer from %s after the follow-ups — mark it lost?" % name,
        "%s and %s since the bid went out, and no answer. "
        "Mark the bid lost on the Bids board, or move it back to Sent if you want to keep after it."
        % (said(n("email"), "email"), said(n("call"), "call")),
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


# Asking for a review in his own words. His Gmail signature (on every email he
# types: "Happy with our work? Leave us a Google Review") carries the same
# words, so the signature and the earlier emails quoted under a reply are cut
# off before looking -- else any email he sent them (a time to come by, the
# invoice is on its way) counted as the thank-you, and none went.
REVIEW_WORDS = re.compile(r"\b(a review|google review|review us)\b", re.I)
HIS_SIGNATURE = re.compile(r"(?m)^\s*\*?Jonah Linfield, Owner|Happy with our work\?|^On .{6,80} wrote:\s*$")


def _asked_for_review(to, since):
    """The newest email he sent `to` after `since` that asks for a review in
    its own words, as {id, at}, or None."""
    import receipts
    q = 'in:sent to:%s {"a review" "google review" "review us"} after:%d' % (to, int(since.timestamp()))
    for m in (_gmail("/messages", {"q": q, "maxResults": 10}).get("messages") or []):
        got = receipts._fetch(m["id"])
        at = datetime.datetime.fromtimestamp((got.get("internalDate") or 0) / 1000, datetime.timezone.utc)
        if at <= since:
            continue
        words = "\n".join(x for x in (got.get("text") or "").splitlines() if not x.lstrip().startswith(">"))
        cut = HIS_SIGNATURE.search(words)
        if REVIEW_WORDS.search(words[:cut.start()] if cut else words):
            return {"id": m["id"], "at": at}
    return None


ADDRESS = re.compile(r"[^@\s,;<>()\"']+@[^@\s,;<>()\"']+\.[a-z]{2,}", re.I)


def _address_in(text):
    """The first email address in some text ('' when there is none)."""
    m = ADDRESS.search(str(text or ""))
    return m.group(0) if m else ""


def _contact(db, ref, j, known):
    """The email the plan writes to: the job's, else its QuickBooks
    customer's (customers/{id}, customers.py) -- which is then written onto
    the job, with the customer's phone when the job has none, so the call
    button has it too. 26 Oct 2026: 5 of 9 bids on the plan had no email on
    the job and were quietly never written to. '' when there is none.
    `known`: customers already read this run. An email box holding more than
    the address ("Pat Lee <pat@...>", two addresses) gives its first address
    and is never written over with the customer record's."""
    typed, phone = (j.get("email") or "").strip(), (j.get("phone") or "").strip()
    email = typed if cards.EMAIL_RE.match(typed) else _address_in(typed)
    if email and phone:
        return email
    # The customer the job is tied to, then its estimate's QuickBooks
    # customer: a job tied by hand to a lead with no email (a bid on the
    # plan, 26 Oct 2026) still has its QuickBooks one.
    q_cid = str((j.get("qbEstimate") or {}).get("customerId") or "").strip()
    # A job tied by itself on its name alone (customers.js customerFill) may
    # be someone else of that name: their email and phone are not taken from
    # that record -- only from one he picked, matched by email or phone, or
    # its estimate's QuickBooks customer.
    fill = j.get("customerFill") or {}
    tied = str(j.get("customerId") or "").strip()
    if tied and j.get("customerBy") == "auto" and fill.get("how") == "name" and \
            str(fill.get("customerId") or "") == tied and tied != q_cid:
        tied = ""
    patch = {}
    for cid in dict.fromkeys(x for x in (tied, q_cid) if x):
        if cid not in known:
            try:
                snap = db.collection("customers").document(cid).get()
                known[cid] = (snap.to_dict() or {}) if snap.exists else {}
            except Exception as err:    # noqa: BLE001
                print("followup: customer", cid, "not read:", err)
                known[cid] = {}
        c = known[cid]
        if not email and cards.EMAIL_RE.match((c.get("email") or "").strip()):
            patch["email"] = email = c["email"].strip()
        if not phone and (c.get("phone") or "").strip():
            patch["phone"] = phone = c["phone"].strip()
    if patch:
        patch["lastModified"] = _stamp()
        ref.update(patch)
        j.update(patch)
        print("followup: filled", ", ".join(k for k in patch if k != "lastModified"), "on", ref.id)
    return email if cards.EMAIL_RE.match(email) else ""


def _claim_of(db, jid, step):
    """The claim on one email step (reminderLog/fu_<job>_<step>), made just
    before Gmail is asked. create() lets only one run have it -- two runs at
    once (a scheduler retry, Run now) used to both pass a read-then-write
    check and both send -- and no copy of the job on a phone can save over
    it, as it could when the claim was a field on the job (chaseSending)."""
    return db.collection("reminderLog").document("fu_%s_%s" % (jid, step))


def _tries_of(db, jid, step):
    """The mornings one email step failed on (FAIL_DAYS)."""
    return db.collection("reminderLog").document("futry_%s_%s" % (jid, step))


def _failed(tries):
    """This morning counted as one this step failed on."""
    try:
        tries.set({"days": firestore.ArrayUnion([dg._now().astimezone(dg.TZ).date().isoformat()]),
                   "at": _stamp()}, merge=True)
    except Exception as err:        # noqa: BLE001 -- only the count is lost
        print("followup: failure not counted:", err)


def _let_go(claim, jid):
    """A claim given back: the email certainly did not go."""
    try:
        claim.delete()
    except Exception as err:        # noqa: BLE001 -- the next run settles it as maybe-sent
        print("followup: claim for", jid, "not given back:", err)


def _settle(ref, claim, jid, s, to, d, name):
    """A step claimed before whose email the job has no record of: the run
    that claimed it died, or Gmail gave no clear answer. Still fresh: another
    run is sending it this moment. A draft that died half way is let go
    (another draft harms nobody). A send: his Sent mail says whether it
    went, and either way it is counted sent -- never sent twice -- with him
    told when it can't be found. Returns (news or None, False)."""
    at = _when(d.get("at"))
    if at and dg._now() - at < CLAIM_FRESH:
        return None, False
    if d.get("mode") == "draft" and not d.get("done"):
        _let_go(claim, jid)
        return None, False
    stamp = _stamp()
    if d.get("done"):
        # Its record on the job was lost (an old copy of the job saved over
        # it): put back from the claim, nothing to tell.
        keep = ("at", "sent", "drafted", "held", "messageId", "threadId", "subject", "inThread", "link", "draftId")
        ref.update({"chaseDrafts." + s["id"]: {k: d[k] for k in keep if k in d},
                    "chaseSending": firestore.DELETE_FIELD, "lastModified": stamp})
        return None, False
    try:
        found = _found("in:sent to:%s" % to, (at or dg._now()) - datetime.timedelta(minutes=2))
    except Exception as err:        # noqa: BLE001 -- decided next run; nothing is sent meanwhile
        print("followup: sent mail not read for", jid, "-", err)
        return None, False
    rec = {"at": d.get("at") or stamp, "sent": True}
    if found:
        rec.update(messageId=found["id"], emailedAt=_iso(found["at"]))
    else:
        rec["unconfirmed"] = True
    ref.update({"chaseDrafts." + s["id"]: rec, "chaseSending": firestore.DELETE_FIELD, "lastModified": stamp})
    try:
        claim.set(dict(rec, done=True, settledAt=stamp), merge=True)
    except Exception as err:        # noqa: BLE001 -- the job's record already counts it
        print("followup: claim for", jid, "not marked settled:", err)
    n = s.get("n") or 1
    if found:
        return {"kind": "followup", "jobId": jid, "title": "✉️ Follow-up sent",
                "body": "%s — follow-up %d went out from your Gmail." % (name, n)}, False
    return {"kind": "followup", "jobId": jid, "title": "⚠️ A follow-up may not have gone",
            "body": "%s — follow-up %d: Gmail gave no clear answer, and it isn't in your Sent mail. It's counted "
                    "as sent so they're never emailed twice — send one yourself if you want." % (name, n)}, False


def _cents(text):
    try:
        return int(round(float(str(text).replace(",", "").replace("$", "").strip()) * 100))
    except (TypeError, ValueError):
        return None


def unready(subject, body, j):
    """Why an email Claude wrote must not go out by itself, or ''. Plain
    checks (code over Claude) on what a customer would read: a gap left to
    fill in, a Subject line in the body, a dollar figure the bid doesn't
    give, a word he never uses, or longer than his follow-ups are. One that
    fails waits in his Drafts for a look instead."""
    text = "%s\n%s" % (subject, body)
    if re.search(r"[\[\]{}]", text) or re.search(r"\((?:no name|not given|none)\)", text, re.I):
        return "it has a gap left to fill in"
    if re.search(r"(?im)^\s*subject\s*:", body):
        return "it has a Subject line in it"
    # YD is insured, not licensed (Jonah, 27 Oct 2026): never in writing.
    if re.search(r"\blicensed\b", text, re.I):
        return "it says the company is licensed"
    price = _cents(j.get("jobPrice"))
    for m in re.finditer(r"\$\s?(\d[\d,]*(?:\.\d{1,2})?)", text):
        got = _cents(m.group(1))
        if price is None or got is None or abs(got - price) >= 100:
            return "it names a dollar figure (%s) the bid doesn't give" % m.group(0).strip()
    if len(body.split()) > MAX_WORDS:
        return "it is longer than your follow-ups are"
    return ""


def _ours(sender, staff):
    """A message from him, from someone who works here, from a test address,
    or QuickBooks' own email of the estimate (sent for him; his copy is in
    his inbox)."""
    addr = _address_in(sender).lower()
    return not addr or addr in staff or bool(NOT_A_CUSTOMER.search(addr)) or addr.endswith("intuit.com")


BOUNCE = re.compile(r"(?i)mailer-daemon|postmaster@")


def _thread_news(thread_ids, since, staff):
    """Messages in these email threads after `since` that are not his -- the
    customer answering from another address (a spouse's, work), someone else
    of theirs, or Gmail saying an email bounced -- oldest first, as {id, at,
    subject, from}. The from: search alone saw only the job's own address."""
    out = []
    for tid in thread_ids:
        full = _gmail("/threads/" + tid, {"format": "metadata", "metadataHeaders": ["Subject", "From"]})
        for m in full.get("messages") or []:
            labels = m.get("labelIds") or []
            if "SENT" in labels or "DRAFT" in labels or "CHAT" in labels or _ours(_header(m, "From"), staff):
                continue
            at = datetime.datetime.fromtimestamp(int(m.get("internalDate") or 0) / 1000, datetime.timezone.utc)
            if at > since:
                out.append({"id": m["id"], "at": at, "subject": _header(m, "Subject"), "from": _header(m, "From")})
    return sorted(out, key=lambda x: x["at"])


def _mark_after(d):
    """From when an email to them counts as his own since this mark: a send
    counted on Gmail's word alone (no message id to tell it by) is given ten
    minutes, so that very email is never taken for one he typed."""
    at = _when(d.get("at"))
    if at and d.get("unconfirmed") and not d.get("messageId"):
        return at + datetime.timedelta(minutes=10)
    return at


def _hold_draft(ref, claim, tries, jid, s, to, got, why, name):
    """An email Claude wrote that must not go out by itself (unready): put in
    his Drafts, in the same thread, with the step counted done -- he reads it
    and sends it. News for his phone, or None when Gmail would not take the
    draft (the step is tried again)."""
    saved = cards.draft_email(to, got["subject"], got["body"], got["reply"])
    if saved.get("error"):
        print("followup: held one not drafted for", jid, "-", saved["error"])
        _let_go(claim, jid)
        _failed(tries)
        return None
    at = _stamp()
    rec = {"at": at, "drafted": True, "held": why, "draftId": saved.get("draftId"), "link": saved.get("link"),
           "subject": saved.get("subject") or got["subject"], "inThread": bool(got["reply"])}
    rec = {k: v for k, v in rec.items() if v is not None}
    # On the bid's list of follow-ups too, so its "Open draft" button is there.
    ref.update({"chaseDrafts." + s["id"]: rec, "chaseSending": firestore.DELETE_FIELD,
                "followUps": firestore.ArrayUnion([dict(rec, by="Job Hub (follow-ups)", step=s["id"])]),
                "lastModified": at})
    try:
        claim.set(dict(rec, done=True), merge=True)
    except Exception as err:        # noqa: BLE001 -- the job's record already counts it
        print("followup: claim for", jid, "not marked done:", err)
    print("followup: held", s["id"], "for job", jid, "in Drafts --", why)
    return {"kind": "followup", "jobId": jid, "title": "📝 A follow-up is in your Drafts",
            "body": "%s — follow-up %d wasn't sent by itself: %s. Read it in your Gmail Drafts and send it."
                    % (name, s.get("n") or 1, why)}


def _send_step(client, db, ref, jid, j, s, to, spent, staff):
    """One email step of the plan, now that it is due: held because the
    customer has written to him since the bid went out (chaseHeard, he is
    told once), counted done without sending because he has emailed them
    himself since the last step, or written and sent in the estimate's
    thread -- or put in his Drafts when what Claude wrote doesn't pass
    (unready). Returns (news for his phone or None, whether Claude was
    asked). Any doubt about his mailbox and nothing is sent."""
    name = (j.get("customerName") or "").strip() or "A customer"
    marks = [d for d in (j.get("chaseDrafts") or {}).values() if isinstance(d, dict)]
    resumed = _when((j.get("chase") or {}).get("resumeAt"))
    since = max(t for t in (chase_start(j), resumed) if t)
    claim, tries = _claim_of(db, jid, s["id"]), _tries_of(db, jid, s["id"])
    try:
        snap = claim.get()
        d = (snap.to_dict() or {}) if snap.exists else {}
        snap = tries.get()
        t = (snap.to_dict() or {}) if snap.exists else {}
    except Exception as err:        # noqa: BLE001
        print("followup: claim not read for", jid, "-- nothing sent:", err)
        return None, False
    # A send claimed before with no record of it on the job (an older run's
    # claim was kept on the job itself): never sent twice.
    pending = j.get("chaseSending") or {}
    if not d and pending.get("step") == s["id"]:
        d = {"at": pending.get("at")}
    if d:
        return _settle(ref, claim, jid, s, to, d, name)
    if len(t.get("days") or []) >= FAIL_DAYS:
        if t.get("told"):
            return None, False
        tries.set({"told": _stamp()}, merge=True)
        return {"kind": "followup", "jobId": jid, "title": "⚠️ A follow-up didn't go",
                "body": "%s — follow-up %d couldn't be written or sent on %d mornings, so it's stopped. Write it "
                        "from the bid (Write the email) or tick it done." % (name, s.get("n") or 1, FAIL_DAYS)}, False
    try:
        # Their newest email: since the bid went out, or in the weeks before
        # it with no answer from him after it -- a customer waiting on his
        # reply never gets "did you get a chance to look?" (26 Oct 2026: two
        # customers had written before the plan began and were unanswered or
        # upset). Nothing from before he said "Keep emailing them" counts.
        # Spam and trash too: a reply Gmail filed away is still a reply.
        wrote = _found("from:%s in:anywhere -in:sent -in:drafts -in:chats" % to,
                       resumed or min(since, dg._now() - datetime.timedelta(days=WROTE_DAYS)))
        unanswered = bool(wrote) and wrote["at"] <= since and not _found("in:sent to:%s" % to, wrote["at"])
        # Anyone else answering in the estimate's thread, or the plan's own
        # (a spouse's address, work), or the email bouncing.
        thread = estimate_thread(j, to)
        tids = [x for x in dict.fromkeys([(thread or {}).get("threadId")] + [m.get("threadId") for m in marks]) if x]
        late = _thread_news(tids, since, staff)
        if late and not (wrote and wrote["at"] > since):
            wrote, unanswered = late[-1], False
        last = max([since + datetime.timedelta(hours=20)] + [x for x in (_mark_after(m) for m in marks) if x])
        mine = _found("in:sent to:%s" % to, last, {m.get("messageId") for m in marks if m.get("messageId")})
    except Exception as err:        # noqa: BLE001
        print("followup: mailbox not read for", jid, "-- nothing sent:", err)
        return None, False
    was = j.get("chaseHeard") or {}
    if wrote and (wrote["at"] > since or unanswered):
        if was.get("messageId") == wrote["id"]:
            return None, False          # held for this email already, and he was told
        bounced = bool(BOUNCE.search(wrote.get("from") or ""))
        heard_rec = {"at": _iso(wrote["at"]), "subject": (wrote["subject"] or "")[:200],
                     "messageId": wrote["id"], "unanswered": unanswered, "foundAt": _stamp()}
        if wrote.get("from"):
            heard_rec["from"] = wrote["from"][:200]
        if bounced:
            heard_rec["bounced"] = True
        ref.update({"chaseHeard": heard_rec, "lastModified": _stamp()})
        if bounced:
            return {"kind": "followup", "jobId": jid, "title": "✋ An email to %s bounced" % name,
                    "body": "Gmail couldn't deliver to the address on the bid, so the automatic follow-ups for it are "
                            "stopped — check the email address."}, False
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
    try:
        got, usage = _write(client, j, to, s, thread)
    except Exception as err:        # noqa: BLE001 -- Claude busy or slow: nothing went, the next hour tries again
        print("followup: not written for", jid, "-", err)
        _failed(tries)
        return None, True
    if spent and usage is not None:
        try:
            spent(usage)
        except Exception as err:    # noqa: BLE001 -- the cost not noted is no reason to hold the email
            print("followup: cost not recorded for", jid, "-", err)
    if got.get("error"):
        print("followup: not written for", jid, got["error"])
        _failed(tries)
        return None, True
    # Claude took a while: the bid as it is now. Answered, stopped, lost or
    # this step done by another run meanwhile -- nothing goes.
    now_j = ref.get().to_dict() or {}
    if not chasing(now_j) or s["id"] in done_steps(now_j):
        return None, True
    why = unready(got["subject"], got["body"], now_j)
    # Claimed only now, just before Gmail is asked: an error from here on may
    # mean it went (the claim then counts it sent, never twice).
    try:
        claim.create({"at": _iso(dg._now()), "job": jid, "step": s["id"], "to": to, "mode": "draft" if why else "send"})
    except AlreadyExists:
        return None, True           # another run has it
    if why:
        return _hold_draft(ref, claim, tries, jid, s, to, got, why, name), True
    sent = cards.send_mail(to, got["subject"], got["body"], got["reply"])
    if sent.get("error"):
        print("followup: not sent for", jid, sent["error"])
        _let_go(claim, jid)
        _failed(tries)
        return None, True
    at = _stamp()
    rec = {"at": at, "sent": True, "messageId": sent.get("messageId"), "threadId": sent.get("threadId"),
           "subject": sent.get("subject") or "", "inThread": bool(got["reply"]),
           "link": "https://mail.google.com/mail/u/%s/#all/%s" % (dg.OWNER_EMAIL, sent.get("threadId") or "")}
    ref.update({"chaseDrafts." + s["id"]: rec, "chaseSending": firestore.DELETE_FIELD,
                "followUps": firestore.ArrayUnion([dict(rec, by="Job Hub (follow-ups)", step=s["id"])]),
                "lastModified": at})
    try:
        claim.set(dict(rec, done=True), merge=True)
    except Exception as err:        # noqa: BLE001 -- the job's record already counts it
        print("followup: claim for", jid, "not marked done:", err)
    print("followup: sent", s["id"], "for job", jid, "in the estimate thread" if got["reply"] else "as a new email")
    return {"kind": "followup", "jobId": jid, "title": "✉️ Follow-up sent",
            "body": "%s — follow-up %d went out from your Gmail%s." % (
                name, s.get("n") or 1, " in the estimate's thread" if got["reply"] else "")}, True


def auto(client, deadline=None, spent=None, claude=True):
    """The hourly part (main.py /cards/run): every bid's email step that is
    due sent (in the morning, SEND_HOURS), the "mark it lost?" card made, and
    the next-steps email for a yes (after-a-yes section below) and the
    thank-you sent for a job paid off (thank-you section below).
    `spent(usage)` records what each Claude call cost; `claude` False (the
    day's Claude spending limit reached) leaves the bids' emails, which
    Claude writes, for later -- the thank-you is plain code and still goes.
    Returns news for the owner's phone (main._tell_owner, kind "followup").
    settings/followUp {auto: false} switches it all off."""
    import time
    db = dg._db()
    news = []
    try:
        conf = db.collection("settings").document("followUp").get().to_dict() or {}
        read = True
    except Exception:           # noqa: BLE001
        conf, read = {}, False
    if conf.get("auto") is False:
        return news
    morning = dg._now().astimezone(dg.TZ).hour in SEND_HOURS
    drafted, known, mailed = 0, {}, set()
    # His settings unread, no thank-you this run: "no review link" would
    # be a guess.
    thanks = _ThanksRun(db, conf, morning, known, mailed) if read else None
    welcome = _WelcomeRun(db, conf, morning, known, mailed) if read else None
    # The people who work here, for the bids' emails too (his own address, a
    # crew member's, a test bid's never get a follow-up): read once, the
    # first time a bid's email is due. Unreadable -> every address counts as
    # staff, and no bid email goes this run.
    staff_box = []

    def staff_for_bids():
        if not staff_box:
            staff_box.append(_staff_emails(db))
        return staff_box[0] if staff_box[0] is not None else _EVERYONE

    def bid(ref, jid, j):
        """One bid's due steps: the "mark it lost?" card, or its email."""
        nonlocal drafted
        name = (j.get("customerName") or "").strip()
        steps = open_steps(j)
        to = _contact(db, ref, j, known) if steps else ""
        for s in steps:
            if s["kind"] == "decide":
                # They wrote back (the plan held for it): not "no answer".
                if heard(j):
                    continue
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
            elif (s["kind"] == "email" and claude and morning and to and to.lower() not in mailed
                  and drafted < AUTO_MAX and (not heard(j) or heard(j).get("unanswered"))
                  and not _not_customer(to, j, staff_for_bids())):
                try:
                    item, asked = _send_step(client, db, ref, jid, j, s, to, spent, staff_for_bids())
                except Exception as err:    # noqa: BLE001 -- one bid must not stop the rest
                    print("followup: step failed for", jid, "-", err)
                    item, asked = None, True
                drafted += 1 if asked else 0
                mailed.add(to.lower())
                if item:
                    news.append(item)

    try:
        for snap in db.collection("jobs").stream():
            if deadline and time.monotonic() > deadline:
                break
            j = snap.to_dict() or {}
            jid = snap.id
            ref = db.collection("jobs").document(jid)
            # Each job on its own, so one that fails (gone meanwhile, an odd
            # field) stops nobody else's emails -- it did, every hour.
            if (j.get("jobStatus") or "quoting") == "quoting":
                try:
                    bid(ref, jid, j)
                except Exception as err:    # noqa: BLE001
                    print("followup: bid", jid, "skipped:", err)
                continue
            # Just said yes: the next steps. Finished and paid off: the thank-you.
            for run in (welcome, thanks):
                try:
                    item = run.job(ref, jid, j) if run else None
                except Exception as err:    # noqa: BLE001
                    print("followup: job", jid, "skipped:", err)
                    item = None
                if item:
                    news.append(item)
    except Exception as err:        # noqa: BLE001 -- the jobs stopped coming: what was done is still told
        print("followup: jobs not all read:", err)
    return news + (thanks.end() if thanks else [])


# ---------------------------------------------------------------- the thank-you
#
# Jonah (26 Oct 2026): "routine so when a final payment is recieved for an
# invoice in quickbooks email is sent thanking for choosing us and requesting
# a review" -- SENT by itself, as he chose for the follow-ups the same day (it
# was drafted into Gmail Drafts from 24 Oct). A job is thanked once it is:
#   - finished and paid off in QuickBooks: its invoice owes nothing and the
#     sweep has moved it to Paid (workStage 'paid', workStageAt when). A job
#     dragged to Paid by hand, with no QuickBooks invoice, is not "a final
#     payment received" -- "Send it now" on the job is for that;
#   - paid on or after the day this went live (settings/followUp.thanksFrom,
#     written by the first run that finds a job paid off -- the jobs paid
#     before are never emailed in a batch), and no more than
#     THANKS_WITHIN_DAYS ago (an email added months later sends nothing out
#     of the blue);
#   - not ticked "Don't send a thank-you" on the job (noThanks);
#   - and his Google review link is saved (settings/followUp.reviewLink).
#     With none nothing goes: the job says "held" and he is told once to add
#     it; the morning after he does, they go.
# To the job's email, else its QuickBooks customer's (_contact, as the
# follow-ups) -- never his own, the crew's or a test address -- in the
# morning (SEND_HOURS), one email to a person a run and THANKS_MAX a run,
# from his Gmail, so an answer comes straight to him. Not when he has asked
# them for a review himself since the job was finished (that counts as done);
# if his mailbox can't be read, nothing goes. Plain code writes it -- the same
# few warm lines each time, no Claude to pay for -- in his words once he
# changes them (settings/followUp thanksSubject / thanksBody, {name} {work}
# {link}). settings/followUp.thanksSend false puts it in his Gmail Drafts
# instead, for him to send.
#
# Never twice: before Gmail is asked, reminderLog/thanks_<job> is CREATED (it
# fails when it is there already) -- two runs, or the morning run and "Send
# it now" at the same moment, cannot both get past it, and a device saving
# an old copy of the job over its record cannot bring the email back. Only a
# send Gmail certainly did not take (refused, or no permission) gives the
# claim back. The job's thanksEmail is what the app shows: {at, to, subject,
# sentAt, messageId, threadId, link} sent; {draftId, link} drafted; {byHand,
# emailedAt} he asked them himself; {unconfirmed} a send whose answer never
# came back; {held: noLink | noEmail | notCustomer} waiting, and why.
THANKS_MAX = 4
THANKS_WITHIN_DAYS = 30
# A claim younger than this with nothing recorded is a send happening now
# (the other of the run and the button), not one that died half way.
CLAIM_FRESH = datetime.timedelta(minutes=10)
THANKS_SUBJECT = "Thank you from YD Exterior Visions"
THANKS_BODY = (
    "Hi {name},\n\n"
    "Thank you for choosing YD Exterior Visions for your {work}. It was a pleasure working with you, "
    "and I hope you enjoy it for years to come.\n\n"
    "If you have a minute, a Google review would mean a lot to us:\n"
    "{link}\n\n"
    "And if anything ever comes up, just reply to this email.\n\n"
    "Thanks again,\n"
    "Jonah\n"
    "YD Exterior Visions"
)
# Never thanked: the company's own addresses, made-up ones, and a test job.
NOT_A_CUSTOMER = re.compile(r"(?i)ydexteriorvisions|@example\.(com|org|net)$|\.(test|invalid|example|localhost)$")
TEST_JOB = re.compile(r"(?i)\btest\b")
# A customer name that is a business, not a person: "Hi there".
COMPANY = re.compile(r"(?i)\b(llc|inc|corp|co|company|properties|property|management|mgmt|apartments?|condos?|"
                     r"hoa|association|church|school|group|partners|holdings|services|realty|homes|builders|"
                     r"construction|city|village|town|county|club|center|centre)\b|\d")
# A household's name, not a person's: "The Johnson Family", "Smith Residence",
# "Mr and Mrs Smith" -- the email says "Hi there," rather than "Hi The,".
NOT_A_FIRST = re.compile(r"(?i)^(the|mr|mrs|ms|miss|dr)\b\.?|\b(family|residence|household|estate|trust|farms?)\b")
# The work said in at most this many letters, and the little words a cut
# never ends on.
WORK_MAX = 48
CONNECTORS = {"and", "&", "with", "of", "the", "for", "to", "a", "an", "in", "on", "at", "plus"}
# Lines of an estimate that are not the work: no "thank you for your discount".
NOT_WORK = re.compile(r"(?i)discount|terms|warranty|notice|deposit|\bfee\b|change order")


def thanks_done(rec):
    """Whether a thank-you has gone, been drafted, or been sent by hand.
    thanks.js done() is the same."""
    rec = rec or {}
    return bool(rec.get("sentAt") or rec.get("draftId") or rec.get("byHand") or rec.get("unconfirmed"))


def paid_at(j):
    """When a finished job was paid off in QuickBooks (workStageAt, set by the
    sweep when it moved it to Paid), or None: not paid there."""
    if j.get("deletedAt") or j.get("removeWhy") or j.get("workStage") != "paid":
        return None
    if stages.stage_of(j) != "paid" or not stages.qb_invoice_of(j):
        return None
    return _when(j.get("workStageAt"))


def written_off(db, j):
    """Why a job whose invoice shows nothing owed was not paid by the
    customer, or '': the invoice voided (its total $0), or zeroed with a
    credit memo -- a write-off, as one was on 16 Oct 2026 -- so its payments
    come to less than its total. Payments as the sweep kept them
    (invoices/{id}.payments: a credit memo's $0 "payment" is never one). An
    invoice paid before the sweep ever saw it open has no such record and is
    taken at QuickBooks' word."""
    inv = stages.qb_invoice_of(j) or {}
    try:
        total = float(inv.get("total") or 0)
    except (TypeError, ValueError):
        total = 0.0
    if total <= 0.004:
        return "its total is $0 (voided?)"
    snap = db.collection("invoices").document(str(inv.get("id"))).get()
    rec = (snap.to_dict() or {}) if snap.exists else {}
    if not rec:
        return ""
    paid = 0.0
    for p in rec.get("payments") or []:
        try:
            paid += float((p or {}).get("amount") or 0)
        except (TypeError, ValueError):
            pass
    if paid < total - 0.01:
        return "its payments come to ${:,.2f} of ${:,.2f} (written off?)".format(paid, total)
    return ""


def _first_name(j, cust):
    """Who the email says hi to: the first name on the job or its customer,
    else the first word of a person's name, else '' (a business: "there")."""
    # "mary" typed in small letters is still "Mary".
    cap = lambda s: s[:1].upper() + s[1:] if s.islower() else s
    first = str(j.get("firstName") or "").strip() or str((cust or {}).get("firstName") or "").strip()
    if first:
        return cap(first[:40])
    name = re.sub(r"\s+", " ", str(j.get("customerName") or "")).strip()
    # A business by its customer record too (QuickBooks' company name): a
    # company with no company word in its name ("Lakeside Paving") was "Hi
    # Lakeside,".
    business = str(j.get("business") or "").strip() or str((cust or {}).get("business") or "").strip()
    if not name or business or COMPANY.search(name) or NOT_A_FIRST.search(name):
        return ""
    two = re.match(r"^([A-Za-z][A-Za-z'-]+) (?:&|and) ([A-Za-z][A-Za-z'-]+) [A-Za-z'-]+$", name)
    if two:
        return "%s & %s" % (cap(two.group(1)), cap(two.group(2)))
    words = name.split(" ")
    return cap(words[0]) if len(words) <= 4 and re.fullmatch(r"[A-Za-z][A-Za-z'-]+", words[0]) else ""


def _work_words(j):
    """The work in a few words, as the app names a job (app.js jobWhat): what
    was typed for the crew, else the estimate's first line or two of work,
    else its services -- with Title Case put in a sentence's case."""
    what = str(j.get("crewWhat") or "").strip()
    if not what:
        titles = [re.sub(r"\s*\([^)]*×[^)]*\)\s*$", "", str(w.get("title") or "")).strip()
                  for w in ((j.get("estimate") or {}).get("work") or []) if isinstance(w, dict)]
        pick = [t for t in titles if t and not NOT_WORK.search(t)] or \
            [str(s).strip() for s in (j.get("serviceTypes") or []) if str(s).strip()]
        if pick:
            what = pick[0]
            if len(pick) > 1 and pick[1].lower() != pick[0].lower() and len(what + " & " + pick[1]) <= 40:
                what += " & " + pick[1]
    # Cut short at a word, never in the middle of one or of "... walls and";
    # Title Case and ALL CAPS put in a sentence's case ("HOME GRAVEL TOP-UP"
    # read as shouting in a thank-you).
    words = what.split()
    while words and len(" ".join(words)) > WORK_MAX:
        words.pop()
    while words and (words[-1].lower().strip(",;:-") in CONNECTORS or not words[-1].strip(",;:-&")):
        words.pop()
    words = [w.lower() if re.fullmatch(r"[A-Z][a-z']+|[A-Z][A-Z'-]+", w) else w for w in words]
    return " ".join(words).rstrip(",;:-") or "project"


def thanks_words(j, link, conf, cust=None):
    """(subject, body) of the thank-you for job `j`: his words when he has
    written his own (settings/followUp), else THANKS_SUBJECT / THANKS_BODY.
    {name}, {work} and {link} are filled in; a body without {link} gets the
    link at the end, as the email is there to ask for the review."""
    subject = str(conf.get("thanksSubject") or "").strip() or THANKS_SUBJECT
    body = str(conf.get("thanksBody") or "").strip() or THANKS_BODY
    if "{link}" not in body:
        body += "\n\n{link}"
    fill = {"{name}": _first_name(j, cust) or "there", "{work}": _work_words(j), "{link}": link}
    for k, v in fill.items():
        subject, body = subject.replace(k, v if k != "{link}" else ""), body.replace(k, v)
    return re.sub(r"\s+", " ", subject).strip()[:200] or THANKS_SUBJECT, body


def _staff_emails(db):
    """Every address of the people who work here (users/*), and his own --
    never sent a thank-you. None when they cannot be read: then nothing goes."""
    out = {dg.OWNER_EMAIL.lower()}
    try:
        for s in db.collection("users").stream():
            e = str((s.to_dict() or {}).get("email") or "").strip().lower()
            if e:
                out.add(e)
    except Exception as err:        # noqa: BLE001
        print("followup: the people here not read -- no thank-yous this run:", err)
        return None
    return out


class _Everyone:
    """Stands in for the staff list when it could not be read: every address
    is in it, so nothing is sent."""
    def __contains__(self, _):
        return True


_EVERYONE = _Everyone()


def _not_customer(to, j, staff):
    return to.lower() in staff or bool(NOT_A_CUSTOMER.search(to)) or \
        bool(TEST_JOB.search(str(j.get("customerName") or "")))


def _hold(ref, j, why):
    """The thank-you waits, and why, on the job (the app says so on the job
    and on Home). Written only when the reason is new, so he is told once:
    True then."""
    was = j.get("thanksEmail") or {}
    if was.get("held") == why:
        return False
    at = _stamp()
    rec = {"held": why, "at": at}
    ref.update({"thanksEmail": rec, "lastModified": at})
    j["thanksEmail"] = rec
    return True


def _from_log(ref, j, log):
    """A thank-you claimed before (reminderLog) that the job does not show --
    its record was lost (an old copy of the job saved over it, or the write
    after sending failed) or one is being sent this moment: the job is told
    what the log knows, and nothing is sent again. A draft that died half way
    is let go (another draft harms nobody)."""
    got = log.get()
    d = (got.to_dict() or {}) if got.exists else {}
    if thanks_done(j.get("thanksEmail")) or not d:
        return
    claimed = _when(d.get("at"))
    if not d.get("sentAt") and not d.get("draftId"):
        if claimed and dg._now() - claimed < CLAIM_FRESH:
            return
        if d.get("mode") == "draft":
            log.delete()
            return
    at = _stamp()
    rec = {k: d[k] for k in ("to", "subject", "sentAt", "messageId", "threadId", "link", "draftId", "sentBy") if d.get(k)}
    rec["at"] = at
    if not rec.get("sentAt") and not rec.get("draftId"):
        rec.update(sentAt=d.get("at") or at, unconfirmed=True)
    ref.update({"thanksEmail": rec, "lastModified": at})
    j["thanksEmail"] = rec


def send_thanks(db, ref, jid, j, to, link, conf, cust=None, by=None):
    """Claim, then send (or draft) one job's thank-you. Returns (record,
    None), or (None, why): "already" when it was claimed before."""
    subject, body = thanks_words(j, link, conf, cust)
    mode = "draft" if conf.get("thanksSend") is False else "send"
    log = db.collection("reminderLog").document("thanks_" + jid)
    try:
        # The same clock _from_log reads it by.
        log.create({"job": jid, "at": _iso(dg._now()), "to": to, "mode": mode, "by": by or "auto"})
    except AlreadyExists:
        _from_log(ref, j, log)
        return None, "already"
    try:
        got = cards.draft_email(to, subject, body) if mode == "draft" else cards.send_mail(to, subject, body)
    except Exception as err:        # noqa: BLE001 -- Gmail may have it: the claim stays
        print("followup: thank-you for", jid, "-- no answer from Gmail:", err)
        return None, "Gmail did not answer — look in your Sent mail before trying again"
    if got.get("error"):
        log.delete()                # certainly not sent: it may be tried again
        print("followup: thank-you for", jid, "not", mode, "--", got["error"])
        return None, got["error"]
    at = _stamp()
    rec = {"at": at, "to": to, "subject": got.get("subject") or subject}
    if mode == "draft":
        rec.update(draftId=got.get("draftId"), link=got.get("link"))
    else:
        rec.update(sentAt=at, messageId=got.get("messageId"), threadId=got.get("threadId"),
                   link="https://mail.google.com/mail/u/%s/#all/%s" % (dg.OWNER_EMAIL, got.get("threadId") or ""))
    if by:
        rec["sentBy"] = by
    rec = {k: v for k, v in rec.items() if v is not None}
    ref.update({"thanksEmail": rec, "lastModified": at})
    j["thanksEmail"] = rec
    try:
        log.update(dict(rec, done=True))
    except Exception as err:        # noqa: BLE001 -- the claim alone still stops a second one
        print("followup: thank-you log for", jid, "not updated:", err)
    print("followup: thank-you", "drafted" if mode == "draft" else "sent", "for job", jid)
    return rec, None


class _ThanksRun:
    """The thank-yous of one hourly run (auto, above): each job looked at with
    job(); end() says what he should be told once."""

    def __init__(self, db, conf, morning, known, mailed):
        self.db, self.conf, self.morning, self.known, self.mailed = db, conf, morning, known, mailed
        self.link = str(conf.get("reviewLink") or "").strip()
        self.start = str(conf.get("thanksFrom") or "")[:10]
        self.today = dg._now().astimezone(dg.TZ).date()
        self.staff = False          # not read yet
        self.done = 0
        self.want_link = []

    def _start(self):
        """The first day thank-yous go by themselves: the day the first run
        found a job paid off, kept in settings/followUp.thanksFrom."""
        if not self.start:
            self.start = self.today.isoformat()
            self.db.collection("settings").document("followUp").set({"thanksFrom": self.start}, merge=True)
            print("followup: thank-yous go by themselves for jobs paid from", self.start)
        return self.start

    def job(self, ref, jid, j):
        """One job: sent, drafted, held, or nothing. News for his phone, or None."""
        paid = paid_at(j)
        if not paid or j.get("noThanks") or thanks_done(j.get("thanksEmail")):
            return None
        day = paid.astimezone(dg.TZ).date()
        if (self.today - day).days > THANKS_WITHIN_DAYS or day.isoformat() < self._start():
            return None
        name = (j.get("customerName") or "").strip() or "A customer"
        if not self.link:
            self.want_link.append(jid)
            _hold(ref, j, "noLink")
            return None
        to = _contact(self.db, ref, j, self.known)
        if not to:
            if _hold(ref, j, "noEmail"):
                return {"kind": "followup", "jobId": jid, "title": "🙏 No email for a thank-you",
                        "body": "%s paid in full, but there's no email on the job or its QuickBooks customer — "
                                "add one and the thank-you goes the next morning." % name}
            return None
        if self.staff is False:
            self.staff = _staff_emails(self.db)
        if self.staff is None:
            return None
        if _not_customer(to, j, self.staff):
            if _hold(ref, j, "notCustomer"):
                return {"kind": "followup", "jobId": jid, "title": "🙏 No thank-you sent",
                        "body": "%s paid in full — the email on it (%s) is yours, the crew's or a test address." % (name, to)}
            return None
        if not self.morning or to.lower() in self.mailed or self.done >= THANKS_MAX:
            return None
        # The job as it is now: the bids' emails before it in this run take
        # minutes, and a "Don't send" ticked or a payment taken off meanwhile
        # must count.
        j = ref.get().to_dict() or {}
        if not paid_at(j) or j.get("noThanks") or thanks_done(j.get("thanksEmail")):
            return None
        why = written_off(self.db, j)
        if why:
            if _hold(ref, j, "writtenOff"):
                return {"kind": "followup", "jobId": jid, "title": "🙏 No thank-you sent",
                        "body": "%s — the invoice shows nothing owed, but %s, so no thank-you went. If they did pay, "
                                "send it from the job." % (name, why)}
            return None
        # He asked them for a review himself since the job was finished: that
        # is the thank-you. His mailbox unreadable: nothing goes.
        since = min([t for t in (_when(j.get("completedAt")), paid - datetime.timedelta(days=14)) if t])
        try:
            mine = _asked_for_review(to, since)
        except Exception as err:    # noqa: BLE001
            print("followup: mailbox not read for", jid, "-- no thank-you sent:", err)
            return None
        self.mailed.add(to.lower())
        if mine:
            at = _stamp()
            rec = {"byHand": True, "emailedAt": _iso(mine["at"]), "to": to, "at": at}
            ref.update({"thanksEmail": rec, "lastModified": at})
            return None
        cust = self.known.get(str(j.get("customerId") or "")) or \
            self.known.get(str((j.get("qbEstimate") or {}).get("customerId") or ""))
        rec, why = send_thanks(self.db, ref, jid, j, to, self.link, self.conf, cust)
        if not rec:
            return None
        self.done += 1
        if rec.get("draftId"):
            return {"kind": "followup", "jobId": jid, "title": "🙏 Thank-you drafted",
                    "body": "%s paid in full — a thank-you with your review link is in your Gmail Drafts." % name}
        return {"kind": "followup", "jobId": jid, "title": "🙏 Thank-you sent",
                "body": "%s paid in full — a thank-you with your review link went to %s." % (name, to)}

    def end(self):
        """Told once: thank-yous are waiting on the review link. Once there is
        a link the mark goes, so a link taken off later is told again."""
        ref = self.db.collection("settings").document("followUp")
        told = self.conf.get("linkToldAt")
        if self.want_link and not told:
            ref.set({"linkToldAt": _stamp()}, merge=True)
            n = len(self.want_link)
            return [{"kind": "followup", "jobId": "thanks-link", "title": "🔗 Add your Google review link",
                     "body": "%d job%s paid off — the thank-you%s wait%s for your review link. Add it (Bids board, or "
                             "⋯ → All settings → Follow-ups & thank-yous) and %s the next morning." % (
                                 n, "" if n == 1 else "s", "" if n == 1 else "s", "s" if n == 1 else "",
                                 "it goes" if n == 1 else "they go")}]
        if self.link and told:
            ref.set({"linkToldAt": firestore.DELETE_FIELD}, merge=True)
        return []


def thanks_now(job_id, uid):
    """"Send it now" on a finished job (the owner, or whoever may change
    billing; main.py /followup/thanks): the thank-you goes at once -- any
    hour, whenever it was paid, paid in QuickBooks or not -- but never twice,
    never with "Don't send a thank-you" ticked, and only with the review link
    saved. Drafted instead when he has chosen that. {ok, sent | drafted, to,
    at} or {error}."""
    db = dg._db()
    ref = db.collection("jobs").document(job_id)
    snap = ref.get()
    if not snap.exists:
        return {"error": "That job was not found"}
    j = snap.to_dict() or {}
    if j.get("deletedAt") or j.get("removeWhy") or stages.status_of(j) != "complete":
        return {"error": "Only a finished job gets a thank-you"}
    if j.get("noThanks"):
        return {"error": "This job is ticked “Don’t send a thank-you” — untick it first"}
    if thanks_done(j.get("thanksEmail")):
        return {"error": "This job’s thank-you has gone already"}
    try:
        conf = db.collection("settings").document("followUp").get().to_dict() or {}
    except Exception:           # noqa: BLE001
        return {"error": "Your settings could not be read — try again"}
    link = str(conf.get("reviewLink") or "").strip()
    if not link:
        return {"error": "Add your Google review link first", "needLink": True}
    known = {}
    to = _contact(db, ref, j, known)
    if not to:
        return {"error": "There's no email on the job or its QuickBooks customer — add one first"}
    staff = _staff_emails(db)
    if staff is None:
        return {"error": "Could not check the address — try again"}
    if _not_customer(to, j, staff):
        return {"error": "%s is your own, the crew’s or a test address" % to}
    cust = known.get(str(j.get("customerId") or "")) or known.get(str((j.get("qbEstimate") or {}).get("customerId") or ""))
    rec, why = send_thanks(db, ref, job_id, j, to, link, conf, cust, by=uid)
    if why == "already":
        return {"error": "This job’s thank-you has gone already", "record": j.get("thanksEmail")}
    if why:
        return {"error": why}
    return {"ok": True, "sent": bool(rec.get("sentAt")), "drafted": bool(rec.get("draftId")),
            "to": to, "at": rec["at"], "record": rec}


# ---------------------------------------------------------------- after a yes
#
# Jonah (27 Oct 2026): "have generic email that gets sent after an estimate is
# accepted thanking them and giving next steps down payment etc." Plain code,
# the same few lines each time in his words once he changes them
# (settings/followUp welcomeSubject / welcomeBody, {name} {work}). Like the
# thank-you, in the morning (SEND_HOURS), one email to a person a run and
# WELCOME_MAX a run, never twice (reminderLog/welcome_<job> is CREATED first),
# never to his own, the crew's or a test address. A job gets it once it is:
#   - accepted (acceptedSeenAt: the sweep or the import saw the yes in
#     QuickBooks) on or after the day this started (settings/followUp
#     .welcomeFrom, written by the first run that finds one -- older yeses are
#     never emailed in a batch), and no more than WELCOME_WITHIN_DAYS ago;
#   - not a snow account (those are removeWhy 'snow'), not finished yet, not
#     ticked "Don't send the next-steps email" (noWelcome);
#   - and he has not emailed them about the deposit or next steps himself since.
# settings/followUp.welcome: 'draft' (the start: his Gmail Drafts, until he
# has read one and chosen) | 'send' | 'off'. The job's welcomeEmail is what
# the app shows (thanks.js): {at, to, subject, sentAt | draftId, link},
# {byHand, emailedAt}, {unconfirmed}, or {held: noEmail | notCustomer}.
WELCOME_MAX = 4
WELCOME_WITHIN_DAYS = 14
WELCOME_SUBJECT = "Next steps for your {work} — YD Exterior Visions"
# The usual words are put together for each job: a fall cleanup was told
# "we order your materials" and "before we dig" (31 Oct). The materials words
# go only to a job with materials, the utility lines only to one whose work
# digs (DIGS). His own words (welcomeBody) go as he wrote them. WELCOME_BODY
# is every part -- what thanks.js W_BODY shows him to change.
WELCOME_HEAD = (
    "Hi {name},\n\n"
    "Thank you for accepting our estimate for your {work} — we're glad to be working with you.\n\n"
    "Here's what happens next:"
)
WELCOME_STEPS = (                   # (for which jobs, the words)
    ("all", "Deposit: you'll get the deposit invoice from QuickBooks by email. You can pay it online with the "
            "button in that email (a bank transfer costs you nothing), or by check made out to YD Exterior Visions LLC."),
    ("materials", "Scheduling: once the deposit is in, we order your materials and put you on the schedule, "
                  "and we'll be in touch with a start date."),
    ("no materials", "Scheduling: once the deposit is in, we put you on the schedule, "
                     "and we'll be in touch with a start date."),
    ("digs", "Before we dig: we have the public utility lines marked, so you may see paint or flags in the yard a few "
             "days before we start. If you have private lines (an invisible dog fence, irrigation, lighting, a line to a "
             "shed), please let us know where they run."),
    ("all", "Questions or changes: just reply to this email."),
)
WELCOME_FOOT = (
    "Thanks again for choosing us,\n"
    "Jonah\n"
    "YD Exterior Visions"
)
# Work that digs: digging.js DIGS (the Diggers ticket to-do) -- keep the same.
DIGS = re.compile(r"\b(walls?|retaining|pavers?|patios?|drain\w*|trench\w*|light\w*|trees?|plant\w*|shrubs?|excavat\w*|"
                  r"footings?|posts?|fenc\w*|grad(?:e|ing)|fire ?pits?|walkways?|paths?|steps|edging|boulders?|sod|"
                  r"irrigat\w*|french|dig\w*|stump|turf|grading|garden|beds?|window ?wells?)\b", re.I)


def _welcome_body(materials, digs):
    """The usual words for a job with (or without) materials and digging."""
    want = {"all", "materials" if materials else "no materials"} | ({"digs"} if digs else set())
    steps = [w for who, w in WELCOME_STEPS if who in want]
    return "\n\n".join([WELCOME_HEAD] + ["%d. %s" % (i + 1, w) for i, w in enumerate(steps)] + [WELCOME_FOOT])


WELCOME_BODY = _welcome_body(True, True)


def _digs(j):
    """digging.js digs(): its services, its work lines' titles, what the crew are told."""
    est = j.get("estimate") or {}
    words = list(j.get("serviceTypes") or []) + [str((w or {}).get("title") or "") for w in (est.get("work") or [])]
    words.append(str(j.get("crewWhat") or ""))
    return bool(DIGS.search(" · ".join(str(w) for w in words)))


def _has_materials(j):
    """Materials to order: a named line on its estimate or its order list (not one he didn't buy)."""
    est = j.get("estimate") or {}
    lines = list(est.get("materials") or []) + list(j.get("orderItems") or [])
    return any(isinstance(m, dict) and str(m.get("name") or "").strip() and not m.get("notBought") for m in lines)


def welcome_mode(conf):
    """'draft' (until he chooses), 'send' or 'off'. thanks.js welcomeMode is the same."""
    m = str((conf or {}).get("welcome") or "")
    return m if m in ("send", "off") else "draft"


def accepted_at(j):
    """When the yes was seen in QuickBooks (acceptedSeenAt), or None: not
    accepted, or a job this email is not for."""
    if j.get("deletedAt") or j.get("removeWhy") or j.get("noWelcome"):
        return None
    if stages.status_of(j) not in ("booked", "inprogress"):
        return None
    return _when(j.get("acceptedSeenAt"))


def welcome_words(j, conf, cust=None):
    """(subject, body) for job `j`: his words when he has written his own,
    else WELCOME_SUBJECT / the usual words for this job, with {name} and {work} filled in."""
    subject = str(conf.get("welcomeSubject") or "").strip() or WELCOME_SUBJECT
    body = str(conf.get("welcomeBody") or "").strip() or _welcome_body(_has_materials(j), _digs(j))
    fill = {"{name}": _first_name(j, cust) or "there", "{work}": _work_words(j)}
    for k, v in fill.items():
        subject, body = subject.replace(k, v), body.replace(k, v)
    return re.sub(r"\s+", " ", subject).strip()[:200] or "Next steps — YD Exterior Visions", body


def _welcome_hold(ref, j, why):
    """Held, and why, on the job -- written only when the reason is new, so
    he is told once: True then."""
    if (j.get("welcomeEmail") or {}).get("held") == why:
        return False
    at = _stamp()
    rec = {"held": why, "at": at}
    ref.update({"welcomeEmail": rec, "lastModified": at})
    j["welcomeEmail"] = rec
    return True


def send_welcome(db, ref, jid, j, to, conf, cust=None, by=None):
    """Claim, then send (or draft) one job's next-steps email. (record, None),
    or (None, why): "already" when it was claimed before."""
    subject, body = welcome_words(j, conf, cust)
    mode = "send" if welcome_mode(conf) == "send" else "draft"
    log = db.collection("reminderLog").document("welcome_" + jid)
    try:
        log.create({"job": jid, "at": _iso(dg._now()), "to": to, "mode": mode, "by": by or "auto"})
    except AlreadyExists:
        got = log.get()
        d = (got.to_dict() or {}) if got.exists else {}
        # Its record lost from the job (an old copy saved over it): put back
        # what the log knows, so the app shows it and nothing goes again.
        if d.get("done") and not thanks_done(j.get("welcomeEmail")):
            rec = {k: d[k] for k in ("to", "subject", "sentAt", "messageId", "threadId", "link", "draftId") if d.get(k)}
            rec["at"] = _stamp()
            ref.update({"welcomeEmail": rec, "lastModified": rec["at"]})
        elif not d.get("done") and not thanks_done(j.get("welcomeEmail")):
            # A claim with no end: the run died between the claim and Gmail's
            # answer. Left so, the job came back every morning and took its
            # customer's turn for the day. A draft is simply made again; a
            # send may have gone, so it is marked "look in your Sent mail"
            # (as the thank-yous are, _from_log) and never sent twice.
            claimed = _when(d.get("at"))
            if claimed and dg._now() - claimed < CLAIM_FRESH:
                return None, "already"
            if d.get("mode") == "draft":
                log.delete()
            else:
                at = _stamp()
                rec = {"at": at, "to": d.get("to") or to, "subject": subject, "sentAt": d.get("at") or at,
                       "unconfirmed": True}
                ref.update({"welcomeEmail": rec, "lastModified": at})
                j["welcomeEmail"] = rec
        return None, "already"
    try:
        got = cards.draft_email(to, subject, body) if mode == "draft" else cards.send_mail(to, subject, body)
    except Exception as err:        # noqa: BLE001 -- Gmail may have it: the claim stays
        print("followup: next-steps email for", jid, "-- no answer from Gmail:", err)
        at = _stamp()
        rec = {"at": at, "to": to, "subject": subject, "sentAt": at, "unconfirmed": True}
        ref.update({"welcomeEmail": rec, "lastModified": at})
        return None, "Gmail did not answer — look in your Sent mail"
    if got.get("error"):
        log.delete()                # certainly not sent: it may be tried again
        print("followup: next-steps email for", jid, "not", mode, "--", got["error"])
        return None, got["error"]
    at = _stamp()
    rec = {"at": at, "to": to, "subject": got.get("subject") or subject}
    if mode == "draft":
        rec.update(draftId=got.get("draftId"), link=got.get("link"))
    else:
        rec.update(sentAt=at, messageId=got.get("messageId"), threadId=got.get("threadId"),
                   link="https://mail.google.com/mail/u/%s/#all/%s" % (dg.OWNER_EMAIL, got.get("threadId") or ""))
    if by:
        rec["sentBy"] = by
    rec = {k: v for k, v in rec.items() if v is not None}
    ref.update({"welcomeEmail": rec, "lastModified": at})
    j["welcomeEmail"] = rec
    try:
        log.update(dict(rec, done=True))
    except Exception as err:        # noqa: BLE001 -- the claim alone still stops a second one
        print("followup: next-steps log for", jid, "not updated:", err)
    print("followup: next-steps email", "drafted" if mode == "draft" else "sent", "for job", jid)
    return rec, None


class _WelcomeRun:
    """The next-steps emails of one hourly run (auto): each job looked at
    with job(). Shares the run's customers read (known) and the addresses
    emailed this run (mailed) with the thank-yous."""

    def __init__(self, db, conf, morning, known, mailed):
        self.db, self.conf, self.morning, self.known, self.mailed = db, conf, morning, known, mailed
        self.mode = welcome_mode(conf)
        self.start = str(conf.get("welcomeFrom") or "")[:10]
        self.today = dg._now().astimezone(dg.TZ).date()
        self.staff = False          # not read yet
        self.done = 0

    def _start(self):
        if not self.start:
            self.start = self.today.isoformat()
            self.db.collection("settings").document("followUp").set({"welcomeFrom": self.start}, merge=True)
            print("followup: next-steps emails go for estimates accepted from", self.start)
        return self.start

    def job(self, ref, jid, j):
        """One job: sent, drafted, held, or nothing. News for his phone, or None."""
        if self.mode == "off" or thanks_done(j.get("welcomeEmail")):
            return None
        yes = accepted_at(j)
        if not yes:
            return None
        day = yes.astimezone(dg.TZ).date()
        if (self.today - day).days > WELCOME_WITHIN_DAYS or day.isoformat() < self._start():
            return None
        name = (j.get("customerName") or "").strip() or "A customer"
        to = _contact(self.db, ref, j, self.known)
        if not to:
            if _welcome_hold(ref, j, "noEmail"):
                return {"kind": "followup", "jobId": jid, "title": "👋 No email for the next-steps email",
                        "body": "%s said yes, but there's no email on the job or its QuickBooks customer." % name}
            return None
        if self.staff is False:
            self.staff = _staff_emails(self.db)
        if self.staff is None:
            return None
        if _not_customer(to, j, self.staff):
            _welcome_hold(ref, j, "notCustomer")
            return None
        if not self.morning or to.lower() in self.mailed or self.done >= WELCOME_MAX:
            return None
        # He wrote them about the deposit or what comes next himself since
        # the yes: that is the email. His mailbox unreadable: nothing goes.
        try:
            mine = _found('in:sent to:%s {deposit "next steps" schedule}' % to, yes - datetime.timedelta(hours=12))
        except Exception as err:    # noqa: BLE001
            print("followup: mailbox not read for", jid, "-- no next-steps email:", err)
            return None
        self.mailed.add(to.lower())
        if mine:
            at = _stamp()
            rec = {"byHand": True, "emailedAt": _iso(mine["at"]), "to": to, "at": at}
            ref.update({"welcomeEmail": rec, "lastModified": at})
            return None
        cust = self.known.get(str(j.get("customerId") or "")) or \
            self.known.get(str((j.get("qbEstimate") or {}).get("customerId") or ""))
        rec, why = send_welcome(self.db, ref, jid, j, to, self.conf, cust)
        if not rec:
            return None
        self.done += 1
        if rec.get("draftId"):
            return {"kind": "followup", "jobId": jid, "title": "👋 Next-steps email drafted",
                    "body": "%s said yes — the thank-you with the next steps is in your Gmail Drafts." % name}
        return {"kind": "followup", "jobId": jid, "title": "👋 Next-steps email sent",
                "body": "%s said yes — the next steps went to %s." % (name, to)}
