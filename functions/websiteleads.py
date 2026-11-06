"""New leads from the website's contact form: what a lead from the inbox gets
(leads.py) -- a Lead in Customers, a card on My to-dos, a buzz on Jonah's
phone and a reply waiting in Gmail Drafts, never sent -- the moment the form
is sent, not within the hour.

Why (Jonah, 3 Nov 2026: "were gonna do the switch this Friday"): leads came
in as Squarespace's "Form Submission" emails, and those stop when the site
leaves Squarespace. The form (yd-website, src/components/ContactForm.astro)
posts here instead: POST /site/lead (main.py _site).

This is the one POST on this server anyone can make, with no sign-in and no
scheduler's proof, so everything in it is a stranger's data:
  - An answer a browser can read goes only to the real domain and the
    Cloudflare Pages test addresses (origin_ok). A script can lie about where
    it is from, so the limits below are what really hold.
  - The hidden `website` box filled in: most likely a bot, told "ok". No lead,
    no card, no buzz, and a whole form still goes to his inbox marked as maybe
    spam (just_email), because a phone's autofill can fill that box too.
  - Every box is cut to its length (BOXES) and stripped of < and >, and the
    whole post is limited (BODY_MAX). The words are only ever stored, and
    shown to Claude as data (leads._read, the same rules as a stranger's email).
  - SENDER_PER_DAY posts from one address and FORMS_PER_DAY from everyone
    (leadLimits/{day}, which keeps a scrambled address, never the real one).
    Past a limit, or when the lead can't be saved, the form goes to his inbox
    and the visitor is told it went (just_email, QUIET_PER_DAY of them). Only
    if that fails too is it refused, and the form gives the phone number.
    Jonah, 5 Nov 2026: a form from his house was refused and thrown away after
    the day's tests used up the address, "I'm gonna miss out on clients".
  - The same form twice in a day (a double tap): one lead, one buzz.
TODO (when Jonah's Cloudflare account exists): Cloudflare's spam check,
Turnstile. Its site key goes in the form, its secret in this service's
variables (never in this public repo), and _site checks the token first.

Plain code does all of it but the reply. The order matters. The lead, the
card and the buzz come first; then the browser gets its answer; only then
does Claude read the form and write the reply (reply), which takes seconds
a person shouldn't sit through. If that part fails he still has the lead,
the card and the buzz, and "Draft a reply" on the lead does the same thing
(inboxdesk.draft).

Someone already in Job Hub is not added twice, but is never dropped either:
their form still makes a card and a buzz. The email version could stay quiet,
because the email was in his inbox; a form's words are nowhere else.
settings/leads.on is about reading his email, so it does not stop the form;
settings/leads.never does, for a sender he has blocked.
"""
import hashlib
import ipaddress
import re

from firebase_admin import firestore
from google.api_core.exceptions import AlreadyExists

import digest as dg
import leads

SUBJECT = "Your request to YD Exterior Visions"
REPLY_TIMEOUT = 60          # seconds Claude has for the reply; the lead is made either way

BODY_MAX = 32 * 1024        # a full form in any alphabet is well under this
# One address is often many people: a house on one Wi-Fi, an office, a phone
# carrier. It was 6, and one afternoon's tests used it up for a whole house.
SENDER_PER_DAY = 20
FORMS_PER_DAY = 60
# (Each form that gets through costs one Claude reply, so this also caps the bill.)
QUIET_PER_DAY = 25          # forms a day that go to his inbox only, so a robot can't fill it
ONLY_HERE = "This one is only in this email, so Job Hub has no lead or card for it. "
PAST_LIMIT = ONLY_HERE + "Too many forms came from that internet address today, or the server was busy."
NOT_SAVED = ONLY_HERE + "Job Hub couldn't save it just now."
MAYBE_SPAM = ONLY_HERE + "A box people can't see was filled in, which usually means a spam robot, " \
    "though a phone's autofill can do it too."

# Real domain, plus <project>.pages.dev and <id>.<project>.pages.dev for each
# preview. Cloudflare adds a suffix to the project's name when it is taken.
ORIGIN = re.compile(r"^https://((www\.)?ydexteriorvisions\.com|"
                    r"([a-z0-9-]+\.)?(yd-website|ydexteriorvisions|yd-exterior-visions)[a-z0-9-]*\.pages\.dev)$")

BOXES = {"fname": 60, "lname": 60, "phone": 30, "email": 120, "address": 200, "timing": 60, "contactBy": 20,
         "heard": 60, "message": 3000}
SERVICES_MAX = 12
SERVICE_MAX = 60
# Control characters and the two that could make text into a tag: the words
# are shown in Job Hub, and nothing there should have to be right about them.
UNSAFE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f<>]")


def origin_ok(origin):
    return bool(ORIGIN.match(origin or ""))


def cors(origin):
    headers = {"Vary": "Origin"}
    if origin_ok(origin):
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Headers"] = "Content-Type"
        headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        headers["Access-Control-Max-Age"] = "3600"
    return headers


def is_bot(body):
    return isinstance(body, dict) and bool(str(body.get("website") or "").strip())


def _box(v, n, lines=False):
    text = UNSAFE.sub(" ", v.replace("\r\n", "\n").replace("\r", "\n")) if isinstance(v, str) else ""
    return text.strip()[:n] if lines else re.sub(r"\s+", " ", text).strip()[:n]


def clean(body):
    """The post as the boxes of the form, trimmed: the form dict, or None when
    it isn't one -- no name, or no working phone number or email. (The form
    checks these first, the same way, so a person never gets this far.)"""
    if not isinstance(body, dict):
        return None
    f = {k: _box(body.get(k), n, k == "message") for k, n in BOXES.items()}
    picked = body.get("services") if isinstance(body.get("services"), list) else []
    f["services"] = [s for s in (_box(x, SERVICE_MAX) for x in picked[:SERVICES_MAX]) if s]
    f["email"] = f["email"].lower() if leads.ADDRESS.fullmatch(f["email"] or "-") else ""
    if not (f["fname"] or f["lname"]) or not (f["email"] or leads._digits(f["phone"])):
        return None
    return f


def sender(request):
    """Who is posting: the last public address in X-Forwarded-For. Cloud Run
    adds the real one at the end; what comes before it, a sender can make up
    (seen on the live server, 3 Nov 2026). On IPv6 a home has a whole /64 to
    hop around in, so that block counts as one sender."""
    for ip in reversed(request.headers.get("X-Forwarded-For", "").split(",")):
        try:
            addr = ipaddress.ip_address(ip.strip())
        except ValueError:
            continue
        if addr.is_global:
            return str(ipaddress.ip_network((addr, 64), strict=False)) if addr.version == 6 else str(addr)
    return request.remote_addr or "?"


def room(db, ip):
    """(room for this post?, news for his phone). The news is one line the
    first time the day's limit refuses someone: past that, real customers
    are being sent to the phone number too, and he should know why."""
    day = dg._now().date().isoformat()
    ref = db.collection("leadLimits").document(day)
    key = hashlib.sha256((day + ip).encode()).hexdigest()[:16]

    # Read and counted in one transaction: this route is open to the world,
    # and 200 posts at once would all read a count of 0 otherwise.
    @firestore.transactional
    def take(tx):
        d = ref.get(transaction=tx).to_dict() or {}
        if int((d.get("by") or {}).get(key) or 0) >= SENDER_PER_DAY:
            return False, []
        if int(d.get("all") or 0) >= FORMS_PER_DAY:
            print("website form: the day's limit is reached")
            if d.get("told"):
                return False, []
            tx.set(ref, {"told": True}, merge=True)
            return False, [{"kind": "followup", "jobId": "site-limit", "title": "⚠️ Website form stopped for today",
                            "body": "%d forms today, far more than real customers send, so it may be spam. "
                                    "Until midnight the form asks people to call." % FORMS_PER_DAY}]
        tx.set(ref, {"all": firestore.Increment(1), "by": {key: firestore.Increment(1)}}, merge=True)
        return True, []

    try:
        return take(db.transaction())
    except Exception as e:      # noqa: BLE001 -- too many at once: the form says to call
        print("website form: limit not checked:", e)
        return False, []


def form_text(f):
    """The form as plain lines: what Claude reads (as data), for a reply."""
    rows = (("Name", " ".join(x for x in (f.get("fname"), f.get("lname")) if x)), ("Phone", f.get("phone")),
            ("Email", f.get("email")), ("Project address", f.get("address")),
            ("What they need", ", ".join(f.get("services") or [])), ("When they hope to get it done", f.get("timing")),
            ("Best way to reach them", f.get("contactBy")), ("How they heard about us", f.get("heard")),
            ("About the project, in their words", f.get("message")))
    return "\n".join("%s: %s" % (k, v) for k, v in rows if v)


def _what(f):
    return ", ".join(f["services"])[:100] or re.sub(r"\s+", " ", f["message"])[:100] or "a request"


def take(db, f):
    """The form made into a Lead (or, for someone already here, a card), the
    card and the news for his phone. Returns what reply() needs, or None when
    there is nothing more to do. Raises when the lead could not be saved:
    the visitor is then told to call, so nothing is lost silently."""
    try:
        conf = db.collection("settings").document("leads").get().to_dict() or {}
    except Exception as err:        # noqa: BLE001 -- the lead matters more than the setting
        print("website form: settings not read --", err)
        conf = {}
    email, phone = f["email"], leads._digits(f["phone"])
    never = leads._never(conf)
    if email and (email in never or leads._domain(email) in never):
        return None
    # Not readable: a lead twice is better than a lead lost.
    seen = leads._known(db) or {"emails": set(), "phones": set()}
    known = email in seen["emails"] or (bool(phone) and phone in seen["phones"])
    # One id per form (and day): a second tap finds it made.
    same = "|".join((dg._now().date().isoformat(), email, phone, f["address"].lower(), f["message"], ",".join(f["services"])))
    lead_id = "ld" + hashlib.sha1(same.encode()).hexdigest()[:14]
    stamp = leads._stamp()
    name = " ".join(x for x in (f["fname"], f["lname"]) if x)
    what = _what(f)
    wrote = re.sub(r"\s+", " ", f["message"])
    drafting = bool(email) and conf.get("autoDraft") is True
    r = {"summary": what, "tags": f["services"], "timing": f["timing"], "phone": f["phone"], "email": email,
         "draftable": bool(email) and not known,
         "extra": [x for x in ("Already in Job Hub, so no new lead was made." if known else "",
                               "Best way to reach them: " + f["contactBy"] if f["contactBy"] else "",
                               "Heard about us: " + f["heard"] if f["heard"] else "",
                               "Their words: " + wrote if wrote else "") if x]}
    rec = {"name": name, "address": f["address"], "fromEmail": {}}
    if not known:
        rec = {"id": lead_id, "name": name, "firstName": f["fname"], "lastName": f["lname"], "business": "", "email": email,
               "phone": f["phone"], "mobile": "", "street": "", "city": "", "state": "", "zip": "", "address": f["address"],
               "tags": f["services"], "source": "website", "addedAt": stamp, "heard": f["heard"], "contactBy": f["contactBy"],
               "website": f, "note": "Website form, %s %d. %s" % (dg._now().strftime("%b"), dg._now().day,
                                                                  form_text(f).replace("\n", ". ")),
               "fromEmail": {"messageId": None, "threadId": None, "subject": "Website form", "from": email, "form": True,
                             "website": True, "summary": what, "timing": f["timing"], "at": stamp, "draft": None, "link": None}}
        try:
            db.collection("customers").document(lead_id).create(rec)
        except AlreadyExists:
            return None
    if leads._lead_card(db, lead_id, rec, r, {}, "website") is False and known:
        return None                 # the same form again: its card is there
    if known:
        news = {"title": "📬 Website form — " + name, "body": what + " — already in Job Hub. It's on My to-dos."}
    else:
        news = {"title": "📬 New lead — " + name, "body": what + " — website form, on Customers → Leads. " + (
            "Your reply will be in Gmail Drafts." if drafting else
            "Tap Draft a reply on it for one." if email else "No email: call or text them.")}
    news.update(kind="followup", jobId="lead-" + lead_id)
    return {"leadId": lead_id, "known": known, "form": f, "rec": rec, "r": r, "drafting": drafting, "news": [news]}


def tell_by_email(done):
    """The whole form in his inbox as well as on his phone. Jonah, 5 Nov 2026:
    "the test form should be hitting my email too": Squarespace emailed him
    each one, and this keeps that when the site leaves it. Sent from his own
    address to itself, so leads.py and inboxdesk.py pass over it (both search
    -from:me) and it can't come back in as a second lead. Reply on it goes to
    the customer. After the browser has its answer, so it never raises: the
    lead, the card and the buzz are already done."""
    import cards
    f, name = done["form"], done["rec"]["name"]
    where = "Already in Job Hub, so no new lead was made. It's on My to-dos." if done["known"] else \
        "It's on Customers → Leads and on My to-dos."
    how = "Reply to this email and it goes to them." if f["email"] else "No email given: call or text them."
    body = "New request from the website.\n\n%s\n\n%s %s" % (form_text(f), where, how)
    try:
        sent = cards.send_mail(dg.OWNER_EMAIL, "Website form: %s - %s" % (name, _what(f)), body,
                               reply_to=f["email"] or None)
        if sent.get("error"):
            print("website form: email not sent for", done["leadId"], "--", sent["error"])
    except Exception as err:        # noqa: BLE001 -- it may have gone, and the lead is safe either way
        print("website form: email may not have gone for", done["leadId"], "--", err)


def _quiet_room(db):
    """Room for one more form to go to his inbox only? Counted apart from the
    day's forms, so a robot past its limit can't use up room for real people.
    False when it can't be counted: the visitor is then told to call."""
    ref = db.collection("leadLimits").document(dg._now().date().isoformat())

    @firestore.transactional
    def take_one(tx):
        d = ref.get(transaction=tx).to_dict() or {}
        if int(d.get("quiet") or 0) >= QUIET_PER_DAY:
            return False
        tx.set(ref, {"quiet": firestore.Increment(1)}, merge=True)
        return True

    try:
        return take_one(db.transaction())
    except Exception as e:      # noqa: BLE001
        print("website form: inbox-only limit not checked:", e)
        return False


def just_email(db, f, why, flag=""):
    """A form that can't go in the usual way, sent to his inbox and nothing
    else. True only when Gmail took it: that is what lets the visitor be told
    it went, so anything less than a clear yes is False and they get the phone
    number. Done before the browser hears anything, and it never raises."""
    import cards
    if "fname" in f:
        name = " ".join(x for x in (f.get("fname"), f.get("lname")) if x)
        subject = "Website form%s: %s - %s" % (flag, name, _what(f))
        head, lines, to = "New request from the website.", form_text(f), f.get("email") or None
        how = "Reply to this email and it goes to them." if to else "No email given: call or text them."
    else:
        subject = "YD Gives Back nomination%s: %s" % (flag, f.get("name"))
        head, lines, to = "A YD Gives Back nomination from the website.", \
            "Name: %s\nPhone: %s" % (f.get("name"), f.get("phone")), None
        how = "Call or text them."
    if not _quiet_room(db):
        print("website form: the day's inbox-only limit is reached")
        return False
    try:
        sent = cards.send_mail(dg.OWNER_EMAIL, subject, "%s\n\n%s\n\n%s %s" % (head, lines, why, how), reply_to=to)
    except Exception as err:    # noqa: BLE001 -- it may have gone, but only a clear yes tells the visitor it did
        print("website form: inbox-only email may not have gone --", err)
        return False
    if sent.get("error"):
        print("website form: inbox-only email not sent --", sent["error"])
        return False
    return True


def reply(claude, done, spent=None):
    """Claude reads the form as it reads a website form's email (his service
    names, the address in its boxes, is this really someone asking for work)
    and writes the reply, saved in his Drafts and linked on the lead and the
    card. After the browser has its answer, so it never raises. `claude`:
    gives the client (main._claude), which can fail too."""
    import cards
    import spend
    db = dg._db()
    f, rec, r, lead_id = done["form"], done["rec"], done["r"], done["leadId"]
    try:
        why = spend.over_cap(db)
        if why:
            print("website form: no reply drafted --", why)
            return
        services = leads._services(db)
        m = {"from": "%s <%s>" % (rec["name"], f["email"]), "subject": "Website contact form",
             "date": dg._now().isoformat(), "text": form_text(f)}
        got, usage = leads._read(claude().with_options(timeout=REPLY_TIMEOUT, max_retries=1), m, services, True)
        if spent:
            spent(usage)
        ref = None if done["known"] else db.collection("customers").document(lead_id)
        if not got.get("is_lead"):
            # Kept: a lead wrongly dropped costs more than one to delete.
            if ref:
                ref.update({"note": rec["note"] + " Claude's read: may not be someone asking for work (%s)." %
                            _box(got.get("why"), 120)})
            return
        c = leads._clean(got, f["email"], services)
        patch = {k: c[k] for k in ("tags", "street", "city", "state", "zip") if c[k]}
        if c["summary"]:
            patch["fromEmail.summary"] = c["summary"]
        # Snow with no plow: his fixed words, as for an email (leads.NO_PLOW_BODY)
        # -- but in Drafts, never sent by itself, whatever settings/followUp says.
        # Nobody has proved the address typed into a form is theirs, so a send
        # here would let anyone aim his email at a stranger.
        plow = leads._no_plow(db, got, m, f["fname"])
        words = plow["body"] if plow else str(got.get("reply") or "").strip()
        saved = cards.draft_email(f["email"], SUBJECT, words) if words else {"error": "no reply written"}
        if saved.get("draftId"):
            draft = {"draftId": saved["draftId"], "link": saved.get("link"), "at": leads._stamp()}
            patch["fromEmail.draft"] = draft
            db.collection("boards").document("todo").collection("cards").document("lc" + lead_id[2:]).update({
                "notes": leads._card_notes(rec, r, draft, "website"), "updatedAt": leads._stamp()})
        else:
            print("website form: reply not drafted for", lead_id, "--", saved.get("error"))
        if ref and patch:
            ref.update(patch)
    except Exception as err:        # noqa: BLE001 -- "Draft a reply" on the lead does the same
        print("website form: reply failed for", lead_id, "--", err)


# A YD Gives Back nomination (Jonah, 5 Nov 2026: "the nominate someone page needs
# to go to a different contact form then the one for work to be done all we need
# is a name and a phone number for that one"). Nobody here is asking for work, so
# no lead and no reply written by Claude: a card on My to-dos, a buzz and the
# email. POST /site/nominate, from the same box of limits as the form above.
def clean_nomination(body):
    """{name, phone}, or None without a name and a whole phone number."""
    if not isinstance(body, dict):
        return None
    name, phone = _box(body.get("name"), 120), _box(body.get("phone"), 30)
    return {"name": name, "phone": phone} if name and len(re.sub(r"\D", "", phone)) >= 10 else None


def take_nomination(db, f):
    """Its card, and the news for his phone; None for the same form twice in a
    day. Raises when the card can't be saved: the visitor is told to call."""
    day = dg._now().date().isoformat()
    cid = "nm" + hashlib.sha1("|".join((day, f["name"].lower(), re.sub(r"\D", "", f["phone"]))).encode()).hexdigest()[:14]
    board = db.collection("boards").document("todo").get()
    cols = [c for c in ((board.to_dict() or {}).get("columns") or []) if c.get("id")]
    col = next((c["id"] for c in cols if str(c.get("name") or "").strip().lower() == "today"), cols[0]["id"])
    now = leads._stamp()
    try:
        db.collection("boards").document("todo").collection("cards").document(cid).create({
            "title": ("🌱 YD Gives Back nomination — " + f["name"])[:200],
            "notes": "From the website. Name: %s\nPhone: %s" % (f["name"], f["phone"]),
            "checklist": [], "column": col, "order": int(dg._now().timestamp() * 1000), "due": day, "dueTime": None,
            "remindMins": None, "hasReminder": False, "remindUids": [], "noReminder": False, "type": "phone",
            "urgency": "normal", "labels": [], "color": None, "assignees": [], "jobId": None, "jobName": None,
            "jobNum": None, "noClaude": True, "doneAt": None, "createdAt": now, "createdBy": "Job Hub",
            "updatedAt": now, "updatedBy": "Job Hub"})
    except AlreadyExists:
        return None
    return [{"title": "🌱 YD Gives Back nomination — " + f["name"], "body": f["phone"] + " — it's on My to-dos.",
             "kind": "followup", "jobId": "nomination-" + cid}]


def tell_nomination(f):
    """The same in his inbox. After the browser has its answer, so it never raises."""
    import cards
    body = "A YD Gives Back nomination from the website.\n\nName: %s\nPhone: %s\n\nIt's on My to-dos." % (f["name"], f["phone"])
    try:
        sent = cards.send_mail(dg.OWNER_EMAIL, "YD Gives Back nomination: " + f["name"], body)
        if sent.get("error"):
            print("nomination: email not sent --", sent["error"])
    except Exception as err:        # noqa: BLE001 -- the card is safe either way
        print("nomination: email may not have gone --", err)
