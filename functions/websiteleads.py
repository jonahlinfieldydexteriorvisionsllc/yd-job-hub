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
  - A sales pitch typed into the form by a person (pitch): no lead, no card,
    no buzz, no reply written; the whole form goes to his inbox marked spam
    with the reasons, from the same room as the hidden box's. Jonah, 9 Nov
    2026: "ive already gotten two spam leads" (one selling Google rankings, one
    a lookup tool); the hidden box only stops robots.
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
QUIET_PER_DAY = 25          # real forms a day that go to his inbox only
SPAM_PER_DAY = 10           # the same for forms the hidden box caught, counted apart so robots can't use up the room above
UNCOUNTED_MAX = 10          # what one server sends to his inbox while those two can't be counted
ONLY_HERE = "This one is only in this email, so Job Hub has no lead or card for it. Add them on Customers if they're real. "
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


# ---------------------------------------------------------------- sales pitches
#
# People selling something to the business type their pitch into the form
# like a customer, picking a service so it goes through. Every one in his form
# history (2024 to 9 Nov 2026: Google rankings, websites, leads, financing for
# his customers, buying the business, a "partnership" sign-up, a cleaning
# company, a lookup tool) talks about HIS business, not their yard, and most
# have words no customer writes. Plain code, so it costs nothing and is the
# same every time (code over Claude).
#
# Each group counts once however often it matches. A form is a pitch only with
# at least one STRONG sign (a seller's words, weighted 3 or 4) AND SPAM_AT
# points in all, so a real customer whose message happens to have a link, a "hope this
# finds you well" or a work email never gets there on those alone. A form
# caught by mistake isn't lost: it is in his inbox with every box and the
# reasons. Things that aren't pitches (a prank, an overpayment scam, a vague
# "interested in your services") still come in as leads.
SPAM_AT = 4
_rx = re.compile
# Weight 4: words only a seller writes, enough by themselves.
# Weight 3: a seller's words a customer could just about write, so never enough alone.
# Careful with 4: "seo" is also a surname and "demo" is a contractor's word for
# tearing out, so neither is a 4 by itself.
STRONG = (
    (4, "it offers to stop emailing you",
     _rx(r"\bunsubscribe|\breply\W{0,3}stop\b|take you off (my|our|the) (mailing |email )?list|rather not hear from (me|us)"
         r"|remove you from (my|our|this) (mailing |email )?list|\bto opt[- ]?out\b|don'?t want to hear from (me|us)")),
    (4, "it sells Google rankings or reviews",
     _rx(r"\bseo (services|agency|company|expert|specialist|packages?|campaigns?|audit|strategy|optimi[sz]ation)\b"
         r"|\b(local|technical|on-page) seo\b|\bseo (and|&) (ads|marketing|web)|search engine optimi[sz]|\bmap pack|local search (results|rankings?)"
         r"|google (business )?(profile|listing) (optimi[sz]|management|rankings?)"
         r"|help(s|ing)? (you |your business |contractors |businesses |landscapers |companies |local businesses )?rank\b"
         r"|rank (you|your (business|site|website|company))\b|get (you|your business) (ranked|ranking|to rank|on the first page)"
         r"|listing (on google )?is (unclaimed|incomplete|not verified|unverified)|claim your (free )?(google )?listing"
         r"|(review|reputation) management|(manage|managing|get (you )?more) (your )?(online )?(5|five)[- ]star reviews")),
    (3, "it talks about where you show up on Google",
     _rx(r"google maps (results?|rankings?|pack)|(top (3|three)|first page|page one) (on|of|in) (google|the maps?|search results)"
         r"|(not|isn'?t|aren'?t) (currently )?showing up (in|on) (google|the top|search results|the maps?)")),
    (4, "it sells leads",
     _rx(r"\b(generate|get you|bring you|send you|exclusive|qualified|high[- ]quality) leads\b|\blead (generation|gen)\b"
         r"|\bpay[- ]per[- ]lead\b|\$\s?\d+ (per|a|each) lead\b|\b(jobs|leads|customers) sent (straight )?to you")),
    (3, "it offers more leads", _rx(r"\b(more|new|quality|steady|consistent) leads\b")),
    (3, "it sells websites or marketing",
     _rx(r"\b(we|i) (build|design|redesign|develop|create) websites|\b(we|i) (can )?(build|design|make|create) (you )?a (new |better |modern )?website"
         r"|website (redesign|audit|development|traffic|optimi[sz]ation)|free (website |seo )?audit"
         r"|(digital|social media|online|internet) marketing|marketing (agency|services|campaign|strategy|firm)"
         r"|social media (management|manager for your)|(improve|boost|grow|strengthen|build) your online presence"
         r"|(improve|redesign|upgrade|refresh) your (website|site)\b")),
    (4, "it sells backlinks or guest posts", _rx(r"\bbacklinks?\b|guest posts?\b|domain authority|\bhigh da\b")),
    (4, "it sells payment processing or financing for your customers",
     _rx(r"get(ting)? your customers approved|approve more (of )?your customers|credit (declines?|turndowns?)"
         r"|(second|2nd) chance (credit|financing)|merchant cash advance|merchant (services|processing)"
         r"|(lower|lowest|low|better) (credit card |card )?processing (fees|rates)|processing rates|switch and save"
         r"|no collateral|funding up to \$")),
    (3, "it offers you loans or funding",
     _rx(r"\bcash advance|working capital (for|loan|to grow)|business (loans?|funding|line of credit)\b"
         r"|funding (for|options for) your business|\b(we|i) offer (equipment |business )?financing")),
    (4, "it asks about buying your business",
     _rx(r"(buyers|investors|clients?|groups?|firms?) (interested in|looking (to|for)) (buy|purchas|acquir)\w*"
         r"|(acquire|acquiring|purchase|purchasing|buy|buying) (your|a|an) ((landscaping|lawn( care)?|snow( removal)?|hardscaping|small|local|established) )?"
         r"(business|company)\b(?!'s| (truck|car|van|vehicle|card|phone|account))"
         r"|interested in selling\s*(your (business|company)|\?)|would you consider selling(\s*(your|the) (business|company)|\?)"
         r"|sell(ing)? your (business|company)\b(?!'s)")),
    (4, "it wants you in a directory", _rx(r"get listed (on|in) our|our (local )?(contractor|business|home ?pro) directory"
                                           r"|sign up for your (free )?listing")),
    (3, "it offers a partnership or a program to sign up for",
     _rx(r"partner program|partnerships? (outreach|team|opportunit)|(potential|mutually beneficial) (partnership|arrangement)"
         r"|collaboration opportunit|feature you on our (platform|site|blog|channel|page)"
         r"|vendor (network|program|platform)|join (our|the) (network|platform|directory|program)"
         r"|sign up (here|below|on your own|for (free|our))|referral (partner|program|network)"
         r"|connect (landscapers|contractors|pros) with")),
    (4, "it sells a tool",
     _rx(r"built (my|this|our) (tool|app|software|platform)|\bfree trial\b"
         r"|(made|recorded) (you )?a (quick |short |personali[sz]ed |custom )?video (for you|about your (business|website|company)"
         r"|showing (how )?(your|you) (business|could|can|are))")),
    (3, "it sells software or a demo",
     _rx(r"\bmy tool\b(?! ?shed)|\bour (software|platform|saas|app)\b|how it works\W{0,3} demo"
         r"|(book|watch) a (quick |free |short |live )?demo\b|(quick|free|short|live) (product )?demo\b(?! (day|of|the))"
         r"|video (showing|of) (exactly )?how (i|we|your business)\b|\bai (chat ?bots?|receptionists?|assistants?|phone agents?)\b"
         r"|\b(scheduling|crm|estimating|invoicing|routing|payroll|hr) software\b")),
    (3, "it offers to come by and sell you a service",
     _rx(r"\b(i'?ll|i will|we'?ll|we will|i'?m going to) be (in|around|near) your (area|neighborhood|building|office)"
         r"|(stop|come) by your (office|business|shop|building)"
         r"|(no[- ]obligation|free) (cleaning|janitorial|window cleaning|office cleaning|carpet cleaning|solar|insurance) "
         r"(estimate|quote|assessment|inspection)")),
    (3, "it offers the business something companies buy",
     _rx(r"\bvirtual assistants?\b|offshore (staff|team|talent|workers)|\bbookkeeping\b|\btax prep(aration)?\b"
         r"|payroll services|truck wraps?|logo (shirts|apparel|uniforms)|janitorial services|commercial (window|janitorial) (cleaning|and)"
         r"|insurance agent|workers'? comp(ensation)? (quote|rates|at lower)|subcontract(ing)? (work|opportunities)"
         r"|extra crews on (big|your) jobs|(wholesale|contractor) (pricing|prices) (on|for|to) (mulch|stone|soil|pavers|plants|companies|contractors)"
         r"|wholesale (mulch|stone|soil|pavers|plants)")),
)
WEAK = (
    (2, "it's a pasted sales email (it has a Subject line)", _rx(r"(^|\n)\s*subject\s*:")),
    (2, "it talks about your business, not their yard",
     _rx(r"\b(businesses|companies) like yours|contractors like (you|yours)|\b(similar|local|other) (businesses|companies|contractors)\b"
         r"|in your (industry|niche|market)\b|\byour (customers|clients|competitors|competition|rankings?|leads|marketing|brand"
         r"|online presence|sales|revenue|cash ?flow|profits?|bottom line|website traffic)\b"
         r"|(lawn care|landscaping|landscape|hardscaping|snow removal|home service) (businesses|companies|contractors|pros) "
         r"(in|near|around)|\bfor (contractors|landscapers|landscaping companies|lawn care companies)\b"
         r"|speciali[sz](e|es|ing) in (small )?(contractors|landscapers)|struggling to find (enough )?(work|customers|jobs)")),
    (2, "it reads like a sales follow-up",
     _rx(r"\bmy (previous|last|earlier|other) (message|email|note)|follow(ing)?[- ]up (on|in case)"
         r"|(landed|went|ended up) in (your )?spam|quick question for|while researching"
         r"|noticed (that )?(you('re| are) (not|currently)|your (business|company|website|site|listing|google))")),
    (1, "it opens like a cold email",
     _rx(r"\bi (came across|found|stumbled (up)?on) (your|yd)\b|hope (this|my (message|email|note)) finds you"
         r"|hope (your (day|week)|you're|you are) (is going|doing|going)")),
    (1, "it asks for a call or a meeting",
     _rx(r"(hop|jump) on a (quick |short )?(call|zoom)|set up a (quick |short )?(call|meeting|zoom)"
         r"|\b(10|15|20|30)[- ]min(ute)?s? (call|chat|meeting)|calendly|good time (to|for a) (chat|call|talk)")),
    (1, "it quotes a price a month", _rx(r"\$\s?\d[\d,]*(\.\d\d)?\s*(/|per|a|each)\s*(month|mo)\b")),
    (1, "it names your business", _rx(r"yd exterior visions|yard dudes")),
)
# Links a customer sends: photos, a listing, a picture of what they like.
LINK = _rx(r"https?://[^\s<>()]+|\bwww\.[^\s<>()]+|\b[a-z0-9-]+\.(com|net|io|co|org|ly|biz|info)/[^\s<>()]*")
THEIR_LINK = _rx(r"photos\.app\.goo\.gl|photos\.google|drive\.google|maps\.app\.goo\.gl|goo\.gl/maps|google\.com/maps"
               r"|icloud\.com|dropbox|zillow|redfin|realtor\.com|imgur|pinterest|pin\.it|instagram|facebook|nextdoor"
               r"|homedepot|menards|lowes")
# Words in sellers' addresses. Not solutions, ventures, growth, consulting or capital:
# those turned up in real-looking requests from property managers and small firms.
SALES_EMAIL = _rx(r"seo|marketing|leads|digital|agency|outreach|website|webdesign|funding|branding")
SALES_TITLE = _rx(r"\b(founder|co-?founder|business development|account executive|partnerships? (outreach|manager)"
                r"|sales (manager|director|representative)|marketing (manager|director|specialist|consultant|coordinator)"
                r"|growth (specialist|manager)|outreach (specialist|manager|coordinator))\b")
_STATES = ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK "
           "OR PA RI SC SD TN TX UT VT VA WA WV WY DC").split()
_STATE_NAMES = ("alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho"
                "|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota"
                "|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york"
                "|north carolina|north dakota|ohio|oklahoma|pennsylvania|rhode island|south carolina"
                "|south dakota|tennessee|texas|utah|vermont|virginia|west virginia|wyoming")
# Only as the last thing on the address line. Oregon and Washington are left
# out of the names: Oregon, WI is in his area and Washington is a street.
ELSEWHERE = _rx(r",\s*(%s)\.?(\s+\d{5}(-\d{4})?)?(\s*,?\s*(usa|us|united states))?\s*$" % "|".join(_STATES)
              + r"|,\s*(%s)(\s+\d{5}(-\d{4})?)?(\s*,?\s*(usa|us|united states))?\s*$" % _STATE_NAMES, re.I)


def _plain(text):
    return (text or "").lower().replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')


def pitch(f):
    """The reasons a form reads like someone selling something to the business,
    or [] when it doesn't (that is, when it isn't sure: see the note above)."""
    text = _plain(f.get("message"))
    if not text.strip():
        return []
    strong = [(n, why) for n, why, rule in STRONG if rule.search(text)]
    signs = strong + [(n, why) for n, why, rule in WEAK if rule.search(text)]
    links = {x.rstrip(".,!?;:").lower() for x in (m.group(0) for m in LINK.finditer(text)) if not THEIR_LINK.search(x)}
    if links:
        signs.append((2, "it has web links") if len(links) > 1 else (1, "it has a web link"))
    if SALES_EMAIL.search(f.get("email") or ""):
        signs.append((2, "their email address is a sales or marketing one"))
    if SALES_TITLE.search(text):
        signs.append((2, "it's signed with a sales job title"))
    if ELSEWHERE.search((f.get("address") or "").strip()) and not re.search(r"\b(wi|wisconsin)\b", _plain(f.get("address"))):
        signs.append((2, "the project address is outside Wisconsin"))
    if not strong or sum(n for n, _w in signs) < SPAM_AT:
        return []
    return [w for _n, w in sorted(signs, key=lambda s: -s[0])]


def pitch_why(reasons):
    return ONLY_HERE + "It reads like someone selling something to you, not asking for work: %s." % "; ".join(reasons)


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


_uncounted = [0]


def _quiet_room(db, robot=False):
    """Room for one more form to go to his inbox only? Real forms and the ones
    the hidden box caught are counted apart from the day's forms and from each
    other, so robots can't use up the room real people need. If it can't be
    counted (Firestore down) a real form goes anyway: his inbox matters more
    than the count, and UNCOUNTED_MAX keeps a flood from getting through."""
    field, most = ("spam", SPAM_PER_DAY) if robot else ("quiet", QUIET_PER_DAY)
    ref = db.collection("leadLimits").document(dg._now().date().isoformat())

    @firestore.transactional
    def take_one(tx):
        d = ref.get(transaction=tx).to_dict() or {}
        if int(d.get(field) or 0) >= most:
            return False
        tx.set(ref, {field: firestore.Increment(1)}, merge=True)
        return True

    try:
        return take_one(db.transaction())
    except Exception as e:      # noqa: BLE001
        print("website form: inbox-only limit not checked:", e)
        if robot:
            return False
        _uncounted[0] += 1
        return _uncounted[0] <= UNCOUNTED_MAX


def inbox_news(f):
    """The buzz for a form that reached only his inbox: nothing in Job Hub
    shows it, and mail he sends himself doesn't always ring his phone."""
    name = f.get("name") or " ".join(x for x in (f.get("fname"), f.get("lname")) if x)
    return [{"kind": "followup", "jobId": "site-inbox", "title": "📬 Website form — " + name,
             "body": "It's in your email only, not in Job Hub. Have a look."}]


def just_email(db, f, why, flag="", robot=False):
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
        head, lines, to = "A YD Gives Back nomination from the website.", nomination_text(f), f.get("email") or None
        how = "Call or text them."
    if not _quiet_room(db, robot):
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
#
# Its own page since 7 Nov 2026 (his words: "fill out the first and last name
# check box for if its a residential or commercial and add a box for email
# too"): first + last, kind, email. A post with only `name` (the old form, or a
# page still open from before) is taken the same as before. The keys are NOT
# fname/lname: just_email tells the work form from this one by `fname`.
NOMINATION_KINDS = {"residential": "Residential", "commercial": "Commercial"}


def clean_nomination(body):
    """{name, first, last, kind, email, phone}, or None without a name and a
    whole phone number. kind and email may be empty."""
    if not isinstance(body, dict):
        return None
    first, last = _box(body.get("first"), 60), _box(body.get("last"), 60)
    name = " ".join(x for x in (first, last) if x) or _box(body.get("name"), 120)
    phone = _box(body.get("phone"), 30)
    email = _box(body.get("email"), 120).lower()
    email = email if leads.ADDRESS.fullmatch(email or "-") else ""
    kind = str(body.get("kind") or "").strip().lower()
    kind = kind if kind in NOMINATION_KINDS else ""
    if not name or len(re.sub(r"\D", "", phone)) < 10:
        return None
    return {"name": name, "first": first, "last": last, "kind": kind, "email": email, "phone": phone}


def nomination_text(f):
    """The lines of a nomination, as the card and both emails show them."""
    lines = ["Name: " + f.get("name", "")]
    if f.get("kind"):
        lines.append("Home or business: " + NOMINATION_KINDS.get(f["kind"], f["kind"]))
    lines.append("Phone: " + f.get("phone", ""))
    if f.get("email"):
        lines.append("Email: " + f["email"])
    return "\n".join(lines)


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
            "notes": "From the website.\n" + nomination_text(f),
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
    body = "A YD Gives Back nomination from the website.\n\n%s\n\nIt's on My to-dos." % nomination_text(f)
    try:
        sent = cards.send_mail(dg.OWNER_EMAIL, "YD Gives Back nomination: " + f["name"], body,
                               reply_to=f.get("email") or None)
        if sent.get("error"):
            print("nomination: email not sent --", sent["error"])
    except Exception as err:        # noqa: BLE001 -- the card is safe either way
        print("nomination: email may not have gone --", err)
