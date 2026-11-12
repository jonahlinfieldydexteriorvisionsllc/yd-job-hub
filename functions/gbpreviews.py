"""Replies to Google reviews (Jonah, 11 Nov 2026: "setup auto replying to GBP
reveiws").

Every hour (main's /cards/run, 7 am to 7 pm) the Business Profile's reviews are
read through the same Google sign-in the profile posts use (social._gtoken,
business.manage). A review with no reply from the business gets a reply
written for it and is kept as gbpReviews/{reviewId} with status 'new': the
top of the Media tab lists them (reviews.js) with the reply in a box he can
change, and Post reply puts it on Google (/reviews/reply -> post()).

How the reply is written:
  * a star rating with no words: plain code (REPLY_* below) -- nothing to read;
  * a review with words: Claude reads it and writes a short reply naming what
    they said, in his voice (voice.block), inside the day's spending limit.
    When Claude can't be asked, plain code writes it and says so.

Posting by itself (settings/reviewReplies.mode 'auto') is a switch HE turns
on, on the tab: then a reply to a review of autoFrom stars or more (4 unless
he changes it) that came in after he switched it on goes up at the next
hourly look. Lower ratings never go up by themselves: those are his to
answer. Off (the start) = every reply waits for his Post.

A review already answered on Google (by him, in the Google app) is kept as
status 'answered' and never touched. Reviews that were already there before
the first look are listed quietly, without a buzz.
"""
import datetime
import hashlib
import re

import requests
from google.api_core.exceptions import AlreadyExists

import digest as dg

MODEL = "claude-sonnet-5-5"
COL = "gbpReviews"
SETTINGS = "reviewReplies"
STARS = {"ONE": 1, "TWO": 2, "THREE": 3, "FOUR": 4, "FIVE": 5}
PAGES = 6                 # 50 reviews a page: far more than the profile has
DRAFTS_PER_RUN = 10       # Claude-written replies in one look; the rest next hour
AUTO_FROM = 4             # stars from which a reply may go up by itself (when on)
REPLY_MAX = 1500          # what the tab's box takes (Google takes 4096)
COMMENT_MAX = 4000
PHONE = "(608) 576-4220"

# Words a reply never says (his public-copy rules: insured not licensed, no
# pressure washing, never prices). A reply that says one is held for him.
NEVER = re.compile(r"\$\s*\d|\blicens|pressure[- ]?wash|\bsubcontract|\bsmall (crew|business|company)\b|\bowner[- ]operated\b", re.I)

# The plain-code replies, picked by the review's id so the same review always
# gets the same words and two reviews side by side read differently.
REPLY_GOOD = [
    "Thank you{name}! We really appreciate you taking the time to leave us {stars} stars.",
    "Thanks so much{name}! It was a pleasure working with you, and we appreciate the {stars} stars.",
    "Thank you for the {stars}-star review{name}! We're glad we could help.",
]
REPLY_LOW = ("Thank you for the feedback{name}. We're sorry we fell short, and we'd like to hear what we could "
             "have done better. Please give us a call at " + PHONE + ".")

SYSTEM = (
    "You write the reply YD Exterior Visions posts publicly under a customer's Google review. YD is a landscaping, "
    "hardscaping and snow removal company in the Madison, Wisconsin area. The reply shows under the business's name, "
    "so write as the company (we), never sign it and never name the owner.\n"
    "Rules:\n"
    "- Thank them by first name when one is given, and name one specific thing they said (the work, the crew, how "
    "it turned out). Never make up details they didn't say.\n"
    "- 4 or 5 stars: warm and short, at most 50 words. One reply, no bullet points, no emojis, no hashtags.\n"
    "- 1 to 3 stars: never argue or explain who was right, never repeat details of a dispute, never promise a "
    "refund or a fix. Say we're sorry it wasn't what they hoped for and ask them to call us at " + PHONE + " so we "
    "can make it right. At most 70 words.\n"
    "- Never mention prices, discounts, being licensed, being small or family-run, subcontractors, pressure "
    "washing, or anything not in their review. No sales pitch, no website link.\n"
    "- Reply with the reply only: no quotation marks, no greeting line on its own, no sign-off."
)


def _db():
    return dg._db()


def _now():
    return dg._now()


def _iso(t):
    return t.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _parse(s):
    try:
        return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def settings(db):
    try:
        snap = db.collection("settings").document(SETTINGS).get()
        return (snap.to_dict() or {}) if snap.exists else {}
    except Exception as err:      # noqa: BLE001
        print("reviews: settings not read --", err)
        return {}


def _set(db, patch):
    db.collection("settings").document(SETTINGS).set(patch, merge=True)


def doc_id(review_id):
    """Google's review ids are long and may hold characters a document id
    shouldn't; the id kept is the safe part plus a short hash of the whole."""
    rid = str(review_id or "")
    safe = re.sub(r"[^A-Za-z0-9_-]", "", rid)[:60]
    return "gr" + safe + hashlib.sha1(rid.encode()).hexdigest()[:8]


def first_name(reviewer):
    r = reviewer or {}
    if r.get("isAnonymous"):
        return ""
    words = re.findall(r"[A-Za-zÀ-ÿ'’-]+", str(r.get("displayName") or ""))
    if not words or words[0].lower() in ("a", "google"):
        return ""
    w = words[0]
    return w[:1].upper() + w[1:] if len(w) > 1 else ""


def plain_reply(rid, stars, first):
    name = (", " + first) if first else ""
    if stars <= 3:
        return REPLY_LOW.format(name=(" " + first) if first else "")
    pick = int(hashlib.sha1(str(rid).encode()).hexdigest(), 16) % len(REPLY_GOOD)
    return REPLY_GOOD[pick].format(name=name, stars=stars)


def problem(text):
    """Why a reply mustn't go up as it is, or ''."""
    t = str(text or "").strip()
    if not t:
        return "the reply is empty"
    if len(t) > REPLY_MAX:
        return "the reply is longer than %d characters" % REPLY_MAX
    m = NEVER.search(t)
    if m:
        return "the reply says “%s”" % m.group(0)
    return ""


def claude_reply(client, record, spent=None):
    """Claude's reply to a review with words, or None when it couldn't be had."""
    import voice
    stars, first, comment = record["stars"], record.get("first") or "", record.get("comment") or ""
    user = ("Stars: %d of 5\nTheir first name: %s\nTheir review:\n%s" % (stars, first or "(not given)", comment[:COMMENT_MAX]))
    try:
        msg = client.messages.create(
            model=MODEL, max_tokens=400,
            system=SYSTEM + voice.block(also="Here it decides how the reply sounds; the rules above still win."),
            messages=[{"role": "user", "content": user}], timeout=60)
    except Exception as err:      # noqa: BLE001 -- plain code writes it instead
        print("reviews: Claude not reached --", err)
        return None
    if spent:
        try:
            spent(msg.usage)
        except Exception as err:  # noqa: BLE001
            print("reviews: spend not recorded --", err)
    text = "".join(getattr(b, "text", "") for b in (msg.content or [])).strip().strip('"“”').strip()
    return text[:REPLY_MAX] or None


# ------------------------------------------------------------ Google


def _where(db):
    import social
    g = social.settings(db).get("google") or {}
    if not (g.get("ok") and g.get("account") and g.get("location")):
        raise social.NotConnected("Google Business Profile isn't hooked up yet")
    return g["account"] + "/" + g["location"]


def _headers():
    import social
    return {"Authorization": "Bearer " + social._gtoken()}


def read_reviews(db):
    """Every review on the profile, newest first, and the profile's totals."""
    import social
    where, h = _where(db), _headers()
    out, token, totals = [], None, {}
    for _ in range(PAGES):
        params = {"pageSize": 50, "orderBy": "updateTime desc"}
        if token:
            params["pageToken"] = token
        try:
            r = requests.get(social.GBP_V4 + where + "/reviews", headers=h, params=params, timeout=30)
        except requests.RequestException as e:
            raise social.Retry("Google could not be reached (%s)" % e)
        if r.status_code >= 300:
            raise social._g_error(r)
        got = r.json() or {}
        if not totals:
            totals = {"average": got.get("averageRating"), "total": got.get("totalReviewCount")}
        out.extend(got.get("reviews") or [])
        token = got.get("nextPageToken")
        if not token:
            break
    return out, totals


def _record_of(rv):
    stars = STARS.get(str(rv.get("starRating") or ""), 0)
    return {
        "name": str(rv.get("name") or ""),
        "reviewId": str(rv.get("reviewId") or ""),
        "reviewer": str((rv.get("reviewer") or {}).get("displayName") or "A Google user")[:80],
        "first": first_name(rv.get("reviewer")),
        "stars": stars,
        "comment": str(rv.get("comment") or "")[:COMMENT_MAX],
        "createTime": str(rv.get("createTime") or ""),
        "updateTime": str(rv.get("updateTime") or ""),
    }


def check(db=None, client=None, spent=None, now=None, deadline=None):
    """The hourly look. Returns {seen, new, drafted, posted, told, error}."""
    import time
    db = db or _db()
    now = now or _now()
    cfg = settings(db)
    out = {"seen": 0, "new": 0, "drafted": 0, "posted": 0, "told": 0}
    try:
        reviews, totals = read_reviews(db)
    except Exception as e:        # noqa: BLE001 -- said on the tab, tried next hour
        _set(db, {"checkedAt": _iso(now), "error": str(e)[:300]})
        out["error"] = str(e)[:300]
        return out
    first_look = not cfg.get("firstCheckAt")
    patch = {"checkedAt": _iso(now), "error": None, "average": totals.get("average"), "total": totals.get("total")}
    if first_look:
        patch["firstCheckAt"] = _iso(now)
    _set(db, patch)
    out["seen"] = len(reviews)
    try:
        kept = {s.id: (s.to_dict() or {}) for s in db.collection(COL).stream()}
    except Exception as err:      # noqa: BLE001
        print("reviews: kept ones not read --", err)
        out["error"] = "kept reviews not read"
        return out
    drafts = 0
    fresh = []                    # new reviews this look (for the buzz)
    for rv in reviews:
        rec = _record_of(rv)
        if not rec["reviewId"] or not rec["stars"]:
            continue
        did = doc_id(rec["reviewId"])
        have = kept.get(did)
        on_google = (rv.get("reviewReply") or {}).get("comment")
        ref = db.collection(COL).document(did)
        if on_google:
            # Answered on Google: by Job Hub (already 'replied'), or by him in
            # Google's own app -- kept so it is never offered again.
            if not have:
                ref.set(dict(rec, status="answered", replyOnGoogle=str(on_google)[:REPLY_MAX], foundAt=_iso(now),
                             notifiedAt=_iso(now), updatedAt=_iso(now)))
            elif have.get("status") in ("new", "skipped"):
                ref.set({"status": "answered", "replyOnGoogle": str(on_google)[:REPLY_MAX], "updatedAt": _iso(now)},
                        merge=True)
            continue
        if have:
            # The customer changed their review (new stars or words) while it
            # still has no reply: the reply is written again, unless he has
            # already changed the one that was there.
            if have.get("status") == "new" and rec["updateTime"] != have.get("updateTime") \
                    and not have.get("replyByHand"):
                ref.set(dict(rec, reply=None, updatedAt=_iso(now)), merge=True)
                have = dict(have, **rec, reply=None)
            elif have.get("status") == "replied":
                # Job Hub posted a reply but Google shows none (the customer
                # rewrote the review, which clears it): offered again.
                ref.set(dict(rec, status="new", reply=None, updatedAt=_iso(now)), merge=True)
                have = dict(have, **rec, status="new", reply=None)
            if have.get("status") != "new" or have.get("reply"):
                continue
        else:
            # Reviews already there on the first look are listed quietly.
            made = _parse(rec["createTime"])
            quiet = first_look or (made and made < now - datetime.timedelta(days=14))
            have = dict(rec, status="new", reply=None, foundAt=_iso(now),
                        notifiedAt=_iso(now) if quiet else None, updatedAt=_iso(now))
            ref.set(have)
            out["new"] += 1
            if not quiet:
                fresh.append(did)
        # Write the reply.
        if deadline and time.monotonic() > deadline:
            continue
        text, by = None, "code"
        if rec["comment"].strip() and client is not None and drafts < DRAFTS_PER_RUN:
            text = claude_reply(client, rec, spent)
            drafts += 1
            if text and problem(text):
                print("reviews: Claude's reply held back --", problem(text))
                text = None
            by = "claude" if text else "code"
        if not text:
            if rec["comment"].strip() and client is not None and drafts >= DRAFTS_PER_RUN:
                continue          # next hour, by Claude
            text = plain_reply(rec["reviewId"], rec["stars"], rec["first"])
        ref.set({"reply": text, "draftBy": by, "updatedAt": _iso(now)}, merge=True)
        out["drafted"] += 1
        kept[did] = dict(have, reply=text, draftBy=by)
    out["posted"] = _auto(db, cfg, kept, now)
    out["told"] = _tell(db, now)
    return out


def _auto(db, cfg, kept, now):
    """When he switched posting by itself on: replies to reviews of autoFrom
    stars or more that came in after he did."""
    if cfg.get("mode") != "auto":
        return 0
    since = _parse(cfg.get("autoSince"))
    if not since:
        return 0
    try:
        least = int(cfg.get("autoFrom") or AUTO_FROM)
    except (TypeError, ValueError):
        least = AUTO_FROM
    least = max(4, min(5, least))     # never below 4: a low rating is his to answer
    posted = 0
    for did, r in kept.items():
        made = _parse(r.get("createTime"))
        if r.get("status") != "new" or not r.get("reply") or (r.get("stars") or 0) < least \
                or not made or made < since or problem(r.get("reply")):
            continue
        res = post(db, did, r.get("reply"), by="Job Hub (by itself)", auto=True)
        if res.get("ok"):
            posted += 1
    return posted


def post(db, did, text, by, auto=False):
    """Puts the reply on Google, reads it back, and marks the review replied."""
    import social
    db = db or _db()
    did = re.sub(r"[^A-Za-z0-9_-]", "", str(did or ""))
    snap = db.collection(COL).document(did).get() if did else None
    if not snap or not snap.exists:
        return {"error": "That review isn't in Job Hub"}
    r = snap.to_dict() or {}
    text = str(text if text is not None else r.get("reply") or "").strip()
    why = problem(text)
    if why:
        return {"error": "Not posted: " + why}
    if r.get("status") in ("replied", "answered"):
        return {"error": "That review already has a reply on Google"}
    name = str(r.get("name") or "")
    if not re.match(r"^accounts/\d+/locations/\d+/reviews/[A-Za-z0-9_-]+$", name):
        return {"error": "That review's Google address is missing"}
    try:
        h = _headers()
        res = requests.put(social.GBP_V4 + name + "/reply", headers=h, json={"comment": text}, timeout=45)
        if res.status_code >= 300:
            raise social._g_error(res)
        # Read back: what Google now shows under the review.
        back = requests.get(social.GBP_V4 + name, headers=h, timeout=30)
        shown = ((back.json() or {}).get("reviewReply") or {}).get("comment") if back.status_code < 300 else None
    except Exception as e:        # noqa: BLE001
        return {"error": str(e)[:300]}
    now = _iso(_now())
    db.collection(COL).document(did).set({
        "status": "replied", "reply": text, "replyOnGoogle": (shown or text)[:REPLY_MAX], "repliedAt": now,
        "repliedBy": by, "auto": bool(auto), "updatedAt": now, "doneAt": now}, merge=True)
    return {"ok": True, "readBack": bool(shown and shown.strip() == text)}


def _tell(db, now):
    """One buzz for the reviews that came in since the last look (7 am to
    9 pm, the hourly run's own hours anyway), opening the list."""
    if not (7 <= now.astimezone(dg.TZ).hour < 21):
        return 0
    try:
        waiting = list(db.collection(COL).where("notifiedAt", "==", None).stream())
    except Exception as err:      # noqa: BLE001
        print("reviews: waiting ones not read --", err)
        return 0
    tell = []
    for s in waiting:
        try:
            db.collection("reminderLog").document("review_" + s.id).create({"at": _iso(now)})
            tell.append(s.to_dict() or {})
        except AlreadyExists:
            pass
        except Exception as err:  # noqa: BLE001
            print("reviews: claim not made --", s.id, err)
            continue
        s.reference.set({"notifiedAt": _iso(now)}, merge=True)
    if not tell:
        return 0
    if len(tell) == 1:
        r = tell[0]
        title = "⭐ New %d-star Google review from %s" % (r.get("stars") or 0, r.get("first") or "a customer")
        if r.get("status") == "replied":
            body = "A reply went up by itself."
        else:
            body = (str(r.get("comment") or "")[:110] + " — " if r.get("comment") else "") + "your reply is written, tap to post it"
    else:
        title = "⭐ %d new Google reviews" % len(tell)
        body = "Replies are written for each — tap to see them"
    people = dg._people()
    sent = 0
    for uid, u in people.items():
        if u.get("role") != "owner":
            continue
        try:
            dg.send_push(uid, {"push": {"title": title, "body": body[:170]}}, tag="yd-reviews",
                         ttl=24 * 3600, opens="reviews")
            sent += 1
        except Exception as err:  # noqa: BLE001
            print("reviews: push failed --", uid, err)
    return len(tell) if sent else 0
