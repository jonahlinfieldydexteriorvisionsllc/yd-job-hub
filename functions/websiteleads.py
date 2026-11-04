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
  - The hidden `website` box filled in: a bot. Told "ok"; nothing is kept.
  - Every box is cut to its length (BOXES) and stripped of < and >, and the
    whole post is limited (BODY_MAX). The words are only ever stored, and
    shown to Claude as data (leads._read, the same rules as a stranger's email).
  - SENDER_PER_DAY posts from one address and FORMS_PER_DAY from everyone
    (leadLimits/{day}, which keeps a scrambled address, never the real one).
    The limit reached: refused, and the form gives the phone number.
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
SENDER_PER_DAY = 6
FORMS_PER_DAY = 60
# (Each form that gets through costs one Claude reply, so this also caps the bill.)

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
    adds the real one at the end; what comes before it, a sender can make up."""
    for ip in reversed(request.headers.get("X-Forwarded-For", "").split(",")):
        try:
            if ipaddress.ip_address(ip.strip()).is_global:
                return ip.strip()
        except ValueError:
            continue
    return request.remote_addr or "?"


def room(db, ip):
    """(room for this post?, news for his phone). The news is one line the
    first time the day's limit refuses someone: past that, real customers
    are being sent to the phone number too, and he should know why."""
    day = dg._now().date().isoformat()
    ref = db.collection("leadLimits").document(day)
    d = ref.get().to_dict() or {}
    key = hashlib.sha256((day + ip).encode()).hexdigest()[:16]
    if int((d.get("by") or {}).get(key) or 0) >= SENDER_PER_DAY:
        return False, []
    if int(d.get("all") or 0) >= FORMS_PER_DAY:
        print("website form: the day's limit is reached")
        if d.get("told"):
            return False, []
        ref.set({"told": True}, merge=True)
        return False, [{"kind": "followup", "jobId": "site-limit", "title": "⚠️ Website form stopped for today",
                        "body": "%d forms today, far more than real customers send, so it may be spam. "
                                "Until midnight the form asks people to call." % FORMS_PER_DAY}]
    ref.set({"all": firestore.Increment(1), "by": {key: firestore.Increment(1)}}, merge=True)
    return True, []


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
