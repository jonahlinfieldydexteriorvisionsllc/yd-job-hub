"""Facebook, Instagram, Google Business Profile and Nextdoor posts, on a schedule.

Jonah (30 Oct 2026): "lets setup automatic facebook, nextdoors, and google
profile posting. i want a set schedule for all this where posts go up at the
right times on the right days."

The schedule is a short list of slots (settings/social.slots; DEFAULT_SLOTS
until he changes them): a place, a day of the week, a time, every week or
every other week, all year or only in the growing or the winter months. The
defaults (30 Oct 2026, from what each place says works for a local service
business):
  - Facebook Tue 9:30 am and Thu 1:00 pm all year, Sat 9:00 am Apr-Oct:
    weekday mid-morning and early afternoon are the steadiest windows;
    Saturday morning is when homeowners plan their yard in season.
  - Google Tue 8:30 am weekly: a post stays on the profile, so the point is a
    fresh one every week, up before the week's searches; the week's new After
    photos go into the profile's photos with it (older jobs' After photos
    fill the spare spots, so past jobs reach the profile too).
  - Nextdoor Thu 6:00 pm every other week: Nextdoor's own advice is Thursday
    or Friday, 5-7 pm, and a new post about every two weeks.
  - Instagram Wed noon and Sat 10:00 am (Jonah, 4 Nov 2026: "we'll be adding
    instagram to this list"): days Facebook doesn't already have the same job.

What goes in a slot, in this order:
  1. a new Yard Talk post live on the site (Jonah, 4 Nov 2026: yes, put it on
     the schedule by itself): Facebook, Instagram and Nextdoor, once each. It
     takes the next planned post's place; that job goes back in line;
  2. a job finished in the last RECENT_DAYS days with After photos, not yet
     posted there (oldest first, so they go in the order finished);
  3. an older finished job with After photos, never posted there (newest
     first) -- the season's work, shown off through the winter;
  4. one of the month's seasonal posts (socialIdeas/{YYYY-MM}), written once
     a month by Claude, with a photo of a past job when one fits.
Never the same job twice in one place. A job ticked "Don't post" (noPost) is
never used.

Instagram has no words of its own: it takes Facebook's, so it costs no Claude
call, and it only ever takes a post with a photo (the place is photos).

The words for a job are Claude's (posts.words -> socialWords/{jobId}),
written once per job -- when it is marked Complete, or here the first time
it is picked. Everything else is plain code: which slot, which job, the
photos, the checks, the posting.

plan() runs after the morning and evening summaries (main.py /digest/run)
and on "Plan them now": it fills the next HORIZON_DAYS days. publish_due()
runs every five minutes (reminders.py): a post whose time has come goes up.
The evening run tells his phone what goes up tomorrow, so he can stop or
change one first (Jonah wants it automatic; this is the look before it goes).

A post is HELD for his OK instead of going up by itself when:
  - "Posts go up by themselves" is off (settings/social.auto false), or
  - the words name the customer, give their street, a price, a phone number,
    or say something YD never says in public: "licensed" (insured, not
    licensed), subcontractors, the owner speaking, "small"/"family-run"
    (business voice, growing), pressure washing (not a service YD sells).
    Claude is told all of this; code checks it.

Facebook: a Page token from his own Meta app (Standard Access needs no App
Review for a Page its own admin manages). He puts the app's id and secret in
once (/social/fb/app, kept in integrations/facebook, which no app can read)
and connects; a Page token made from a long-lived user token does not
expire. Google: domain-wide delegation as the owner's Workspace account
(digest._gmail_access_token) with the business.manage scope -- no stored
key -- once Google has approved the project for the Business Profile API.
Instagram: the business account linked to the Facebook Page, reached with the
Page's token (the same hookup: Instagram API with Facebook Login). Nextdoor:
its Publish API is not for a business promoting itself, so a Nextdoor post is
"ready" at its time, his phone is told, and a card on Home opens Nextdoor with
the words already in (socialposts.js).

Post records: socialPosts/{place}_{YYYYMMDD}_{HHMM} (one per slot time) or
socialPosts/sph... (one he wrote himself):
  place, at (ISO, Chicago), day, slotId, kind job|idea|own, jobId, jobName,
  town, ideaId, topic, words, signOff, text (what goes up), photos
  [{id, url, thumb}], status, heldWhy, tries, error, postedAt, postId, link,
  galleryAdded, createdAt, updatedAt, by.
status: queued -> posting -> posted | failed (| queued again to retry);
held -> (his OK) queued; nextdoor queued -> ready -> posted (his tick);
notConnected (the place is not hooked up -- nothing to push about);
missed (its time passed by more than LATE); skipped (his).
"""

import datetime
import email.utils
import io
import json
import os
import re
import secrets
import time
import urllib.parse
import uuid
import xml.etree.ElementTree as ET
from html import unescape

import requests
from google.api_core.exceptions import AlreadyExists
from google.cloud import firestore

import digest as dg

MODEL = "claude-sonnet-5-5"

PLACES = ("facebook", "instagram", "google", "nextdoor")
NAMES = {"facebook": "Facebook", "instagram": "Instagram", "google": "Google", "nextdoor": "Nextdoor"}
# The places Claude writes for. Instagram takes Facebook's words (_words_for).
WRITTEN = ("facebook", "google", "nextdoor")
SEASONS = ("all", "growing", "winter")
GROWING_MONTHS = (4, 5, 6, 7, 8, 9, 10)

# day: 0 Sunday .. 6 Saturday (as JavaScript's getDay, so socialposts.js and
# this agree without converting).
DEFAULT_SLOTS = [
    {"id": "fb1", "place": "facebook", "day": 2, "time": "09:30", "every": 1, "season": "all"},
    {"id": "fb2", "place": "facebook", "day": 4, "time": "13:00", "every": 1, "season": "all"},
    {"id": "fb3", "place": "facebook", "day": 6, "time": "09:00", "every": 1, "season": "growing"},
    {"id": "ig1", "place": "instagram", "day": 3, "time": "12:00", "every": 1, "season": "all"},
    {"id": "ig2", "place": "instagram", "day": 6, "time": "10:00", "every": 1, "season": "all"},
    {"id": "gb1", "place": "google", "day": 2, "time": "08:30", "every": 1, "season": "all"},
    {"id": "nd1", "place": "nextdoor", "day": 4, "time": "18:00", "every": 2, "season": "all"},
]
# "Every other week" counts weeks from this Monday: the same weeks every
# time, whatever day the plan runs.
WEEK_ANCHOR = datetime.date(2026, 11, 2)

HORIZON_DAYS = 8
RECENT_DAYS = 45
LATE = datetime.timedelta(hours=3)        # a post this late is missed, not put up
MAX_TRIES = 3
STUCK = datetime.timedelta(minutes=30)    # 'posting' this long: the run died mid-post
MAYBE_UP = ("%s took too long to answer, so it may have gone up -- look at the page "
            "before you tap Try again, or it could go up twice")
WRITES_PER_RUN = 6                        # Claude writes for this many jobs a run at most
PLAN_BUDGET_S = 150                       # ... and is not asked again after this many seconds
IDEAS_PER_MONTH = 10
PHOTOS = {"facebook": 4, "instagram": 4, "google": 1, "nextdoor": 4}
GALLERY_A_WEEK = 5                        # After photos added to the Google profile each week
LIMITS = {"facebook": 5000, "instagram": 2200, "google": 1500, "nextdoor": 3400}

SETTINGS = ("settings", "social")
FB_DOC = ("integrations", "facebook")
STATE_COLLECTION = "integrationState"     # shared with quickbooks.py (its sweep tidies both)
STATE_MINUTES = 15

GRAPH = "https://graph.facebook.com/v26.0"
FB_DIALOG = "https://www.facebook.com/v26.0/dialog/oauth"
# business_management: a Page owned by a business portfolio (his is) hands its
# key to an app only with it -- without it Facebook lists no Page at all.
# instagram_*: posting to the Instagram account linked to the Page. ads_*: Meta
# asks for them too when someone's role on that Page comes through a business
# portfolio, which his does; Job Hub never touches an ad.
FB_SCOPES = ("pages_show_list,pages_read_engagement,pages_manage_posts,business_management,"
             "instagram_basic,instagram_content_publish,ads_management,ads_read")

# Instagram takes only a JPEG, between 4:5 upright and 1.91:1 wide.
IG_TALLEST, IG_WIDEST = 0.8, 1.91
IG_WAIT_TRIES = 20                        # every 3 seconds, for the photos to be ready
IG_ACCOUNT = re.compile(r"ydexterior|exteriorvisions|yarddudes", re.I)
IG_NOT_LINKED = ("No Instagram business account is linked to the Facebook Page yet. In the Instagram app, make the "
                 "account a Business account and link it to the YD Exterior Visions Page, then check again.")

SITE = "https://ydexteriorvisions.com"
YARD_TALK_FEED = SITE + "/yard-talk/rss.xml"
YARD_TALK_FROM = "2026-11-04"             # earlier posts were never announced, and stay that way
YARD_TALK_DAYS = 21                       # one older than this is old news
YARD_TALK_PLACES = ("facebook", "instagram", "nextdoor")
YARD_TALK_TAGS = "#YardTalk #MadisonWI #DaneCounty #Landscaping"
YARD_TALK_LINK = re.compile(r"^https://(?:www\.)?ydexteriorvisions\.com/yard-talk/([A-Za-z0-9_-]+)/?$")
OG_IMAGE = re.compile(r"""<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)""", re.I)

GBP_SCOPE = "https://www.googleapis.com/auth/business.manage"
GBP_ACCOUNTS = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts"
GBP_INFO = "https://mybusinessbusinessinformation.googleapis.com/v1/"
GBP_V4 = "https://mybusiness.googleapis.com/v4/"

LATER = object()      # plan(): a job's words not written yet, and this run may not ask Claude


def _db():
    return dg._db()


def _now():
    return dg._now()


def _iso(t):
    return t.isoformat() if t else None


# Why a post waits when "Posts go up by themselves" is off (plan, publish_due).
HELD_NO_AUTO = "Waiting for your OK (posts going up by themselves is switched off)"


def _parse(s):
    """A stored time, in Chicago time: a post moved or written in the app is
    saved in UTC ("...Z"), and its hour and day are read as he sees them."""
    try:
        t = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return t.astimezone(dg.TZ) if t.tzinfo else t.replace(tzinfo=dg.TZ)


def _stamp():
    import quickbooks
    return quickbooks._stamp()


def settings(db=None):
    snap = (db or _db()).collection(SETTINGS[0]).document(SETTINGS[1]).get()
    return (snap.to_dict() or {}) if snap.exists else {}


def _set(db, patch):
    db.collection(SETTINGS[0]).document(SETTINGS[1]).set(patch, merge=True)


def _claim(db, key, now):
    """True the first time `key` is claimed (reminderLog), so two runs that
    overlap never both do it."""
    try:
        db.collection("reminderLog").document(key).create({"at": now.isoformat()})
        return True
    except AlreadyExists:
        return False


def _owners(people):
    return [uid for uid, u in (people or {}).items() if u.get("role") == "owner"]


def _push(db, people, title, body, tag, opens="posts"):
    out = []
    for uid in _owners(people if people is not None else dg._people()):
        try:
            out.append({"uid": uid, "phones": dg.send_push(uid, {"push": {"title": title, "body": body}},
                                                            tag=tag, ttl=20 * 3600, opens=opens)})
        except Exception as e:          # noqa: BLE001
            print("social: push failed:", uid, e)
    return out


# ---------------------------------------------------------------- the schedule


def _hm(s):
    m = re.match(r"^([01]\d|2[0-3]):([0-5]\d)$", str(s or ""))
    return (int(m.group(1)), int(m.group(2))) if m else None


def slots(cfg):
    """His slots, checked; the defaults while he has never changed them (an
    empty list is his: no slots)."""
    raw = cfg.get("slots")
    raw = DEFAULT_SLOTS if not isinstance(raw, list) else raw
    out = []
    for s in raw:
        if not isinstance(s, dict) or s.get("place") not in PLACES or _hm(s.get("time")) is None:
            continue
        try:
            day = int(s.get("day"))
        except (TypeError, ValueError):
            continue
        if not 0 <= day <= 6:
            continue
        out.append({"id": str(s.get("id") or "s%d%s" % (day, s.get("time"))), "place": s["place"], "day": day,
                    "time": s["time"], "every": 2 if s.get("every") == 2 else 1,
                    "season": s.get("season") if s.get("season") in SEASONS else "all"})
    return out


def _place_on(cfg, place):
    return ((cfg.get("places") or {}).get(place) or {}).get("on") is not False


def in_season(season, day):
    if season == "growing":
        return day.month in GROWING_MONTHS
    if season == "winter":
        return day.month not in GROWING_MONTHS
    return True


def right_week(every, day):
    if every != 2:
        return True
    monday = day - datetime.timedelta(days=day.weekday())
    return ((monday - WEEK_ANCHOR).days // 7) % 2 == 0


def occurrences(cfg, start, end):
    """[(slot, at)] for every slot time from `start` to `end` (Chicago,
    aware), soonest first. Places switched off are left out."""
    out = []
    want = [s for s in slots(cfg) if _place_on(cfg, s["place"])]
    d = start.astimezone(dg.TZ).date()
    last = end.astimezone(dg.TZ).date()
    while d <= last:
        js_day = (d.weekday() + 1) % 7
        for s in want:
            if s["day"] != js_day or not in_season(s["season"], d) or not right_week(s["every"], d):
                continue
            hh, mm = _hm(s["time"])
            at = datetime.datetime(d.year, d.month, d.day, hh, mm, tzinfo=dg.TZ)
            if start <= at <= end:
                out.append((s, at))
        d += datetime.timedelta(days=1)
    return sorted(out, key=lambda x: (x[1], x[0]["place"]))


def post_id(place, at):
    return "%s_%s" % (place, at.astimezone(dg.TZ).strftime("%Y%m%d_%H%M"))


# ---------------------------------------------------------------- what to post


def _finished(j):
    if j.get("noPost") or j.get("removeWhy") or j.get("deletedAt"):
        return None
    done = str(j.get("completedAt") or "")[:10]
    return done if re.match(r"^\d{4}-\d{2}-\d{2}$", done) else None


def after_photos(db):
    """{jobId: [{id, url, thumb, at}]} -- every job's After photos, newest first."""
    out = {}
    for s in db.collection("jobPhotos").where("stage", "==", "after").stream():
        p = s.to_dict() or {}
        url = str(p.get("url") or "")
        if p.get("deleteAsked") or not url.startswith("https://") or not p.get("jobId"):
            continue
        out.setdefault(p["jobId"], []).append({"id": s.id, "url": url, "thumb": str(p.get("thumbUrl") or url),
                                               "at": str(p.get("at") or "")})
    for v in out.values():
        v.sort(key=lambda x: x["at"], reverse=True)
    return out


def _jobs(db, photos):
    """[(jobId, job, finished day)] -- finished, postable, with After photos."""
    out = []
    for s in db.collection("jobs").where("completedAt", ">=", "2000").stream():
        j = s.to_dict() or {}
        day = _finished(j)
        if day and photos.get(s.id):
            out.append((s.id, j, day))
    return out


NEVER_UP = ("notConnected", "missed", "failed")


def _used(db, now=None):
    """{place: {jobIds}}, {place: {ideaIds}} and every post by id -- from
    every post planned (a skipped one counts: he did not want it). One whose
    time passed without it going up (not hooked up, missed, failed) gives
    its job back, so hooking a place up later loses nothing."""
    now = now or _now()
    jobs = {p: set() for p in PLACES}
    ideas = {p: set() for p in PLACES}
    posts = {}
    for s in db.collection("socialPosts").stream():
        d = s.to_dict() or {}
        posts[s.id] = d
        place = d.get("place")
        if place not in jobs:
            continue
        if d.get("status") in NEVER_UP and (_parse(d.get("at")) or now) <= now:
            continue
        if d.get("jobId"):
            jobs[place].add(d["jobId"])
        if d.get("ideaId"):
            ideas[place].add(d["ideaId"])
    return jobs, ideas, posts


def _candidates(place, jobs, used, today):
    """The jobs that may go in `place`, in the order they should."""
    recent, older = [], []
    cut = (today - datetime.timedelta(days=RECENT_DAYS)).isoformat()
    for jid, j, day in jobs:
        if jid in used[place]:
            continue
        (recent if day >= cut else older).append((jid, j, day))
    recent.sort(key=lambda x: x[2])
    older.sort(key=lambda x: x[2], reverse=True)
    return recent + older


def _town(j):
    return str(j.get("city") or "").strip()[:60]


# ---------------------------------------------------------------- checks

MONEY = re.compile(r"[$＄]\s*\.?\d[\d,]*(\.\d+)?|\b\d[\d,]*(\.\d+)?\s?(k|grand|dollars?|bucks|usd)\b", re.I)
PHONE = re.compile(r"\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b")
NEVER_SAID = [
    (re.compile(r"\blicen[cs]ed\b", re.I), "says licensed (YD is insured, not licensed)"),
    (re.compile(r"\bsub-?contract", re.I), "talks about subcontractors"),
    (re.compile(r"\b(pressure|power)[- ]?wash", re.I), "talks about pressure washing (not a service YD sells)"),
    (re.compile(r"\bowner[- ]operated\b|\bthe owner\b|\bjonah\b", re.I), "speaks as the owner, not the company"),
    (re.compile(r"\bsmall (crew|team|company|business|outfit|operation)\b|\bfamily[- ](owned|run)\b|\bone[- ]man\b",
                re.I), "makes YD sound small"),
]
STREET_WORDS = r"(st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|way|blvd|cir|circle|pl|place|trl|trail|pkwy|hwy)"
COMMON = {"the", "and", "home", "house", "yard", "lawn", "garden", "patio", "wall", "stone", "properties", "property",
          "landscaping", "llc", "inc", "company", "group", "level", "top", "park", "lake", "hill", "hills", "view",
          "green", "brown", "white", "black", "young", "king", "wood", "woods", "rose", "stone"}


def problems(words, j=None):
    """Why these words may not go up by themselves ('' when they may)."""
    text = str(words or "")
    why = []
    if MONEY.search(text):
        why.append("gives a price")
    if PHONE.search(text):
        why.append("has a phone number in the words")
    for pat, what in NEVER_SAID:
        if pat.search(text):
            why.append(what)
    if j:
        low = " " + re.sub(r"[^a-z0-9]+", " ", text.lower()) + " "
        name = re.sub(r"[^a-z0-9]+", " ", str(j.get("customerName") or "").lower()).strip()
        business = str(j.get("business") or "").strip()
        parts = [w for w in name.split() if len(w) >= 4 and w not in COMMON]
        if name and (" " + name + " ") in low:
            why.append("names the customer")
        elif not business and parts and (" " + parts[-1] + " ") in low:
            why.append("names the customer")
        m = re.match(r"^\s*(\d+)\s+([A-Za-z]+)", str(j.get("address") or ""))
        if m:
            num, street = m.group(1), m.group(2).lower()
            if re.search(r"\b%s\s+%s\b" % (num, re.escape(street)), text, re.I) or \
                    (len(street) >= 4 and street not in COMMON and
                     re.search(r"\b%s\s+%s\b" % (re.escape(street), STREET_WORDS), text, re.I)):
                why.append("gives the customer's street")
    return "; ".join(dict.fromkeys(why))


def _clean(place, words):
    """A place's words tidied: no hashtags on Google or Nextdoor."""
    t = str(words or "").strip()
    if place in ("google", "nextdoor"):
        t = re.sub(r"(^|\s)#\w+", " ", t)
        t = re.sub(r"[ \t]{2,}", " ", t).strip()
    return t


def _words_for(place, got):
    """A place's words out of a job's words or a seasonal post. Instagram has
    none of its own: Facebook's fit it, hashtags and all, with no Claude call."""
    got = got or {}
    return _clean(place, got.get(place) or (got.get("facebook") if place == "instagram" else ""))


def _with_sign_off(place, words, cfg):
    sign = str(((cfg.get("signOff") or {}).get(place)) or "").strip()
    text = words + ("\n\n" + sign if sign and place != "google" else "")
    return text[:LIMITS[place]], sign


# ---------------------------------------------------------------- seasonal posts

IDEA_SYSTEM = (
    "You write social media posts for YD Exterior Visions LLC, a landscaping and hardscaping company serving Dane "
    "and Green County, Wisconsin (the Madison area): paver patios, retaining walls, walkways, fire pits, plantings "
    "and garden beds, mulch and rock, sod and seed, artificial turf, drainage, lawn care and snow removal. Job Hub "
    "posts them on a schedule on Facebook, Instagram, the Google Business Profile and Nextdoor in the weeks when there is no "
    "freshly finished job to show.\n\n"
    "Write the given number of posts for the given month, each on its own topic that fits that month in southern "
    "Wisconsin (what homeowners are thinking about then: fall clean-up and winter prep in autumn, snow removal "
    "and planning next year's project in winter, booking spring work early in late winter, spring clean-up and "
    "planting in spring, enjoying and caring for the yard in summer). Mix useful seasonal tips with what YD does; "
    "most should help a homeowner, not sell. For each post give:\n"
    "- topic: a few words, for Jonah's list.\n"
    "- facebook: friendly, 1-3 short paragraphs, one or two emojis at most, then 3-6 hashtags on their own line "
    "(e.g. #MadisonWI #Landscaping).\n"
    "- google: a Google Business Profile update, 60-140 words, plain and specific, words people search for, no "
    "hashtags, no emojis.\n"
    "- nextdoor: a neighbourly note, 50-110 words, no hashtags, no hard selling.\n"
    "- photo: the number of the listed photo of a past job that fits this post, or 0 when none fits. Only pick a "
    "photo that shows what the post is about.\n\n"
    "Rules, all of them: write as the company ('we'), never as one person; never name anyone. Never give a price, "
    "phone number, address or website (the app adds them). Never say licensed, never mention pressure washing or "
    "subcontractors, never "
    "call the company small, family-run or a one-man shop -- it is a growing company. Never invent facts: no years "
    "in business, numbers of projects, awards, reviews, guarantees or offers. 'Free estimates' is fine. Plain "
    "English, no jargon."
)

IDEA_SCHEMA = {
    "type": "object",
    "properties": {"ideas": {"type": "array", "items": {
        "type": "object",
        "properties": {"topic": {"type": "string"}, "facebook": {"type": "string"}, "google": {"type": "string"},
                       "nextdoor": {"type": "string"}, "photo": {"type": "integer"}},
        "required": ["topic", "facebook", "google", "nextdoor", "photo"],
        "additionalProperties": False,
    }}},
    "required": ["ideas"],
    "additionalProperties": False,
}


def _write_ideas(client, db, month, jobs, photos):
    """The month's seasonal posts (socialIdeas/{YYYY-MM}). Returns (ideas, usage)."""
    listed = []
    for jid, j, _ in sorted(jobs, key=lambda x: x[2], reverse=True)[:30]:
        est = j.get("estimate") or {}
        work = ", ".join(str((w or {}).get("title") or "")[:60] for w in (est.get("work") or [])[:4] if w) or \
            ", ".join(str(s) for s in (j.get("serviceTypes") or [])[:4])
        listed.append({"n": len(listed) + 1, "work": MONEY.sub("", work)[:200], "town": _town(j),
                       "photo": photos[jid][0]})
    first = datetime.date(int(month[:4]), int(month[5:7]), 1)
    ask = {"month": first.strftime("%B %Y"), "posts": IDEAS_PER_MONTH,
           "photos": [{"n": x["n"], "work": x["work"], "town": x["town"]} for x in listed]}
    resp = client.beta.messages.create(
        model=MODEL, max_tokens=12000, system=IDEA_SYSTEM,
        messages=[{"role": "user", "content": json.dumps(ask, ensure_ascii=False)}],
        thinking={"type": "adaptive"},
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": IDEA_SCHEMA}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    )
    if resp.stop_reason == "refusal":
        return [], resp.usage
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        got = json.loads(text).get("ideas") or []
    except ValueError:
        return [], resp.usage
    ideas = []
    for i, x in enumerate(got[:IDEAS_PER_MONTH]):
        if not isinstance(x, dict):
            continue
        pick = next((p for p in listed if p["n"] == x.get("photo")), None)
        idea = {"id": "%s-%d" % (month, i + 1), "topic": str(x.get("topic") or "")[:80],
                "photo": {"id": pick["photo"]["id"], "url": pick["photo"]["url"], "thumb": pick["photo"]["thumb"]}
                if pick else None}
        for place in WRITTEN:
            idea[place] = _clean(place, x.get(place))[:LIMITS[place]]
        if all(idea[p] for p in WRITTEN):
            ideas.append(idea)
    if ideas:
        db.collection("socialIdeas").document(month).set({"ideas": ideas, "at": _now().isoformat(), "by": "Claude"})
    return ideas, resp.usage


# ---------------------------------------------------------------- Yard Talk


def _talk_photo(link, iid):
    """The post's share photo, from its page. False when the page isn't live;
    None when it has no photo."""
    try:
        r = requests.get(link, timeout=15, headers={"User-Agent": "YD Job Hub"})
    except requests.RequestException as e:
        print("social: yard talk page not read:", link, e)
        return False
    if r.status_code != 200:
        return False
    m = OG_IMAGE.search(r.text)
    url = unescape(m.group(1)).strip() if m else ""
    url = SITE + url if url.startswith("/") else url
    return {"id": iid, "url": url, "thumb": url} if url.startswith("https://") else None


def _talk_words(title, excerpt, link):
    """Plain code, no Claude call: the post's own title and short text, which
    were written for this. Instagram can't link from a caption, so it names
    the site; a link Nextdoor or Facebook shows opens the post."""
    lead = excerpt[:400].rsplit(" ", 1)[0] + "..." if len(excerpt) > 400 else excerpt
    head = "New on Yard Talk: %s" % title

    def lines(*parts):
        return "\n\n".join(x for x in parts if x)       # a post with no short text leaves no gap

    return {"facebook": lines(head, lead, "Read it here: " + link, YARD_TALK_TAGS),
            "instagram": lines(head, lead, "The whole post is on our website: ydexteriorvisions.com/yard-talk",
                               YARD_TALK_TAGS),
            "nextdoor": lines("We just put up a new post on our Yard Talk blog: " + title, lead, link)}


def yard_talk(cfg, used_ideas, now):
    """Yard Talk posts live on the site and still to be announced, oldest
    first, shaped as seasonal posts (ideaId yt-<address>), so the schedule, the
    checks and the Posts screen treat them the same way. The site's own feed
    says what is live: a post waiting on his OK isn't in it, and nothing is
    announced before it can be read. settings/social.yardTalk false = off."""
    if cfg.get("yardTalk") is False:
        return []
    try:
        r = requests.get(YARD_TALK_FEED, timeout=15, headers={"User-Agent": "YD Job Hub"})
        if r.status_code >= 300:
            return []
        items = list(ET.fromstring(r.content).iter("item"))
    except (requests.RequestException, ET.ParseError) as e:
        print("social: yard talk feed not read:", e)
        return []
    cut = max(YARD_TALK_FROM, (now - datetime.timedelta(days=YARD_TALK_DAYS)).date().isoformat())
    places = [p for p in YARD_TALK_PLACES if _place_on(cfg, p)]
    out = []
    for item in items:
        title = str(item.findtext("title") or "").strip()
        excerpt = str(item.findtext("description") or "").strip()
        link = str(item.findtext("link") or "").strip()
        m = YARD_TALK_LINK.match(link)
        try:
            when = email.utils.parsedate_to_datetime(str(item.findtext("pubDate") or "")).astimezone(dg.TZ)
        except (TypeError, ValueError):
            continue
        if not (title and m) or when > now or when.date().isoformat() < cut:
            continue
        iid = "yt-" + m.group(1)[:100]
        if all(iid in used_ideas[p] for p in places):
            continue
        photo = _talk_photo(link, iid)
        if photo is False:
            continue
        out.append((when, dict(_talk_words(title, excerpt, link), id=iid, topic=("Yard Talk: " + title)[:80],
                               photo=photo)))
    return [x for _, x in sorted(out, key=lambda y: y[0])]


def _talk_for(place, talk, used_ideas):
    """The Yard Talk post this place should have next. Instagram needs a photo."""
    return next((x for x in talk if x.get(place) and x["id"] not in used_ideas[place] and
                 (place != "instagram" or x.get("photo"))), None)


def _make_room(db, talk, times, existing, used_jobs, used_ideas, now):
    """The week ahead is planned days early, so a new Yard Talk post would wait
    a week behind it. It takes the next time instead: the post planned there
    comes off and its job goes back in line. One he changed or OK'd is his and
    stays, and nothing about to go up (the next hour) is touched."""
    soon = now + datetime.timedelta(hours=1)
    for place in YARD_TALK_PLACES:
        if not _talk_for(place, talk, used_ideas):
            continue
        for slot, at in times:
            if slot["place"] != place or at <= soon:
                continue
            pid = post_id(place, at)
            d = existing.get(pid)
            if d is None:
                break                   # an empty time: the post takes it
            if d.get("edited") or d.get("okAt") or d.get("kind") not in ("job", "idea") or \
                    str(d.get("ideaId") or "").startswith("yt-") or _parse(d.get("at")) != at or \
                    d.get("status") not in ("queued", "notConnected"):
                continue
            db.collection("socialPosts").document(pid).delete()
            del existing[pid]
            used_jobs[place].discard(d.get("jobId"))
            used_ideas[place].discard(d.get("ideaId"))
            break


# ---------------------------------------------------------------- planning


def plan(client, db=None, now=None, writes=WRITES_PER_RUN, budget_s=PLAN_BUDGET_S):
    """Fill every empty slot in the next HORIZON_DAYS days. Returns
    {planned, wrote, waiting}. Claude is asked only for words not yet
    written (a job's, or the month's seasonal posts), at most `writes` times
    and not after `budget_s` seconds (it rides on the summary run); a slot
    whose words are not written yet waits for the next run."""
    import posts
    import spend
    t0 = time.monotonic()
    db = db or _db()
    now = now or _now()
    cfg = settings(db)
    if not cfg.get("on"):
        return {"off": True}
    paused = str(cfg.get("pausedUntil") or "")
    start = max(now, _parse(cfg.get("from")) or now)
    end = now + datetime.timedelta(days=HORIZON_DAYS)
    times = [(s, at) for s, at in occurrences(cfg, start, end) if not (paused and at.date().isoformat() <= paused)]
    if not times:
        return {"planned": 0, "wrote": 0}
    photos = after_photos(db)
    jobs = _jobs(db, photos)
    used_jobs, used_ideas, existing = _used(db, now)
    hooked = _hooked(db, cfg)
    talk = yard_talk(cfg, used_ideas, now)
    _make_room(db, talk, times, existing, used_jobs, used_ideas, now)
    words_cache = {}
    ideas_by_month = {}
    planned, wrote, waiting = [], 0, 0
    stamp = _stamp()

    def words_of(jid, j):
        """The job's words; LATER when they are not written yet and this run
        may not ask Claude (the slot waits for the next run rather than
        taking a job further down the list); None when it cannot have any."""
        nonlocal wrote
        if jid in words_cache:
            return words_cache[jid]
        snap = db.collection("socialWords").document(jid).get()
        got = (snap.to_dict() or {}) if snap.exists else {}
        if got.get("facebook"):
            words_cache[jid] = got
            return got
        if got.get("error") and not (got.get("noWork") and posts.has_work(j)):
            words_cache[jid] = None
            return None
        if not may_ask():
            return LATER
        wrote += 1
        try:
            res, usage = posts.words(client, db, jid, j)
        except Exception as e:          # noqa: BLE001 -- Claude down: no more asking this run
            print("social: words not written for", jid, e)
            wrote = writes
            return LATER
        if usage is not None:
            spend.record(db, spend.today(), "social", posts.MODEL, usage)
        words_cache[jid] = res if isinstance(res, dict) and res.get("facebook") else None
        return words_cache[jid]

    def may_ask():
        return wrote < writes and time.monotonic() - t0 < budget_s and not spend.over_cap(db)

    def ideas_of(month):
        """The month's seasonal posts; [] (not kept) when they are not
        written yet and may not be this run."""
        nonlocal wrote
        if month in ideas_by_month:
            return ideas_by_month[month]
        snap = db.collection("socialIdeas").document(month).get()
        got = ((snap.to_dict() or {}).get("ideas") or []) if snap.exists else []
        if not got:
            if not may_ask():
                return []
            wrote += 1
            try:
                got, usage = _write_ideas(client, db, month, jobs, photos)
            except Exception as e:      # noqa: BLE001
                print("social: the month's posts not written:", month, e)
                wrote = writes
                return []
            if usage is not None:
                spend.record(db, spend.today(), "social", MODEL, usage)
        ideas_by_month[month] = got
        return got

    auto = cfg.get("auto") is not False
    for slot, at in times:
        place = slot["place"]
        pid = post_id(place, at)
        if pid in existing:
            continue
        rec, later = None, False
        news = _talk_for(place, talk, used_ideas)
        if news:
            words = _clean(place, news[place])
            rec = {"kind": "idea", "ideaId": news["id"], "topic": news["topic"], "words": words,
                   "photos": [news["photo"]] if news.get("photo") else [], "why": problems(words)}
            used_ideas[place].add(news["id"])
        for jid, j, day in () if rec else _candidates(place, jobs, used_jobs, now.date()):
            w = words_of(jid, j)
            if w is LATER:
                later = True
                break
            words = _words_for(place, w)
            if not words:
                continue
            rec = {"kind": "job", "jobId": jid, "jobName": str(j.get("customerName") or "")[:80],
                   "jobNum": str(j.get("estimateNumber") or "")[:20] or None, "town": _town(j),
                   "finished": day, "words": words,
                   "photos": [{k: p[k] for k in ("id", "url", "thumb")} for p in photos[jid][:PHOTOS[place]]],
                   "why": problems(words, j)}
            used_jobs[place].add(jid)
            break
        if rec is None and not later:
            for idea in ideas_of(at.strftime("%Y-%m")):
                words = _words_for(place, idea)
                # Instagram is photos: a post with none can't go there.
                if idea.get("id") in used_ideas[place] or not words or (place == "instagram" and not idea.get("photo")):
                    continue
                rec = {"kind": "idea", "ideaId": idea["id"], "topic": idea.get("topic") or "", "words": words,
                       "photos": [idea["photo"]] if idea.get("photo") else [], "why": problems(words)}
                used_ideas[place].add(idea["id"])
                break
        if rec is None:
            waiting += 1
            continue
        words = rec.pop("words")
        why = rec.pop("why")
        text, sign = _with_sign_off(place, words, cfg)
        held = why or ("" if auto else HELD_NO_AUTO)
        # A place not hooked up yet: the post is kept for him to copy, and
        # goes back in line by itself once the place is hooked up.
        off = "" if held or hooked[place] else "%s isn't hooked up yet" % NAMES[place]
        doc = dict(rec, place=place, at=at.isoformat(), day=at.date().isoformat(), slotId=slot["id"],
                   words=words, signOff=sign if place != "google" else "", text=text,
                   status="held" if held else "notConnected" if off else "queued", heldWhy=held or None, tries=0,
                   error=off or None, createdAt=stamp, updatedAt=stamp, by="Job Hub")
        doc.setdefault("jobId", None)
        doc.setdefault("ideaId", None)
        try:
            db.collection("socialPosts").document(pid).create(doc)
        except AlreadyExists:
            continue
        existing[pid] = doc
        planned.append(pid)
    _set(db, {"plannedAt": now.isoformat(), "planWaiting": waiting})
    print("social: planned", len(planned), "wrote", wrote, "waiting", waiting)
    return {"planned": len(planned), "wrote": wrote, "waiting": waiting, "ids": planned}


def _hooked(db, cfg):
    """Which places a post can go up in now. Nextdoor always: he posts it
    from Job Hub."""
    fb = _fb_doc(db)
    return {"facebook": bool(fb.get("pageToken")), "instagram": bool(fb.get("pageToken") and fb.get("igId")),
            "google": bool((cfg.get("google") or {}).get("ok")), "nextdoor": True}


def tell_tomorrow(db=None, people=None, now=None):
    """The evening heads-up: what goes up tomorrow, so he can change or stop
    one first. Once a day. Not a post in a place not hooked up yet: it can't
    go up anyway."""
    db = db or _db()
    now = now or _now()
    cfg = settings(db)
    if not cfg.get("on"):
        return []
    hooked = _hooked(db, cfg)
    tomorrow = (now + datetime.timedelta(days=1)).date().isoformat()
    rows = []
    for s in db.collection("socialPosts").where("day", "==", tomorrow).stream():
        d = s.to_dict() or {}
        if d.get("status") in ("queued", "held") and hooked.get(d.get("place")):
            rows.append(d)
    if not rows or not _claim(db, "social_tomorrow_" + tomorrow, now):
        return []
    rows.sort(key=lambda d: d.get("at") or "")
    held = [d for d in rows if d.get("status") == "held"]
    bits = []
    for d in rows:
        t = _parse(d.get("at"))
        when = (t.strftime("%I:%M %p").lstrip("0").lower() if t else "")
        what = ("%s in %s" % (_short_work(d), d["town"]) if d.get("town") else _short_work(d))
        bits.append("%s %s — %s" % (NAMES.get(d.get("place"), ""), when, what))
    title = "\U0001F4E3 Tomorrow's posts" + (" — %d waiting for your OK" % len(held) if held else "")
    return _push(db, people, title, "; ".join(bits) + ". Tap to check or change them.", "yd-social-tomorrow")


def _short_work(d):
    if d.get("kind") == "idea":
        return d.get("topic") or "a seasonal post"
    if d.get("kind") == "own":
        return "your post"
    return "a finished job"


# ---------------------------------------------------------------- posting


class NotConnected(Exception):
    pass


class Retry(Exception):
    pass


def publish_due(db=None, people=None, now=None):
    """Every post whose time has come goes up (the five-minute run)."""
    db = db or _db()
    now = now or _now()
    cfg = settings(db)
    if not cfg.get("on"):
        return []
    paused = str(cfg.get("pausedUntil") or "")
    auto = cfg.get("auto") is not False
    if auto:
        # Switched back on: the posts held only because it was off go back in
        # line (one he held himself, or one with words to check, stays held).
        for s in db.collection("socialPosts").where("status", "==", "held").stream():
            if (s.to_dict() or {}).get("heldWhy") == HELD_NO_AUTO:
                s.reference.set({"status": "queued", "heldWhy": None, "updatedAt": _stamp()}, merge=True)
    sent = []
    # A run that died part way through a post (Cloud Run stopped, a crash)
    # left it 'Going up…' for good. Taken again blind it could go up twice,
    # so it turns 'Didn't go up' with words to look first, and he is told.
    for s in db.collection("socialPosts").where("status", "==", "posting").stream():
        d = s.to_dict() or {}
        began = _parse(d.get("postingAt"))
        if began and now - began > STUCK:
            s.reference.set({"status": "failed", "error": MAYBE_UP % NAMES.get(d.get("place"), "It"),
                             "updatedAt": _stamp()}, merge=True)
            sent.extend(_failed(db, people, d, "Job Hub lost track while putting it up", False) or [])
    for s in db.collection("socialPosts").where("status", "==", "queued").stream():
        d = s.to_dict() or {}
        # "Each waits for my OK": a post already in line when he switched it
        # off waits for his OK too (plan() holds the ones it makes after).
        if not auto and not d.get("okAt"):
            s.reference.set({"status": "held", "heldWhy": HELD_NO_AUTO, "updatedAt": _stamp()}, merge=True)
            continue
        at = _parse(d.get("at"))
        if not at or at > now:
            continue
        if paused and at.date().isoformat() <= paused:
            continue
        if now - at > LATE:
            s.reference.set({"status": "missed", "updatedAt": _stamp()}, merge=True)
            continue
        sent.extend(publish(db, s.id, people=people, now=now) or [])
    return sent


def _take(db, pid, now, statuses=("queued",)):
    """Claim the post for this run (queued -> posting), in a transaction: two
    runs that overlap never put it up twice. A post left 'posting' for over
    15 minutes (a run that died) is taken again."""
    ref = db.collection("socialPosts").document(pid)

    @firestore.transactional
    def take(tx):
        snap = ref.get(transaction=tx)
        if not snap.exists:
            return None
        d = snap.to_dict() or {}
        stale = d.get("status") == "posting" and \
            (now - (_parse(d.get("postingAt")) or now)) > datetime.timedelta(minutes=15)
        if d.get("status") not in statuses and not stale:
            return None
        tx.update(ref, {"status": "posting", "postingAt": now.isoformat()})
        return d

    return take(db.transaction())


def publish(db, pid, people=None, now=None, by_hand=False):
    """Put one post up now. Returns what was told."""
    now = now or _now()
    d = _take(db, pid, now, ("queued", "held", "failed", "notConnected", "missed") if by_hand else ("queued",))
    if d is None:
        return []
    ref = db.collection("socialPosts").document(pid)
    place = d.get("place")
    try:
        if place == "facebook":
            done = fb_post(db, d)
        elif place == "instagram":
            done = ig_post(db, d)
        elif place == "google":
            done = google_post(db, d, now)
        elif place == "nextdoor":
            # Nextdoor keeps its Publish API from a business promoting itself:
            # the post is ready for him on Home, one tap from Nextdoor.
            ref.set({"status": "ready", "readyAt": now.isoformat(), "updatedAt": _stamp()}, merge=True)
            if by_hand:
                return []
            return _push(db, people, "\U0001F4E3 Nextdoor post ready",
                         "It's on Home: one tap opens Nextdoor with the words already in.",
                         "yd-social-nextdoor", opens="nextdoor")
        else:
            raise RuntimeError("no such place")
    except NotConnected as e:
        ref.set({"status": "notConnected", "error": str(e), "updatedAt": _stamp()}, merge=True)
        # A queued post is only for a place that was hooked up: refused now
        # (a token run out, a permission taken away), so he is told -- once a
        # day per place -- rather than its posts quietly stopping.
        # A place never hooked up ("... isn't hooked up yet": a held post he
        # OK'd goes in line whatever the place) is no news -- the post just
        # waits as Not hooked up, as planned ones do.
        if by_hand or str(e).endswith("hooked up yet") or \
                not _claim(db, "social_nc_%s_%s" % (place, now.astimezone(dg.TZ).date().isoformat()), now):
            return []
        return _push(db, people, "⚠️ %s needs hooking up again" % NAMES.get(place, "A place"),
                     str(e)[:140] + " — its posts wait until then. Tap to see.", "yd-social-failed")
    except Retry as e:
        tries = int(d.get("tries") or 0) + 1
        ref.set({"status": "queued" if tries < MAX_TRIES else "failed", "tries": tries, "error": str(e),
                 "updatedAt": _stamp()}, merge=True)
        if tries < MAX_TRIES:
            return []
        return _failed(db, people, d, str(e), by_hand)
    except Exception as e:              # noqa: BLE001 -- told, not lost
        print("social: post failed", pid, e)
        ref.set({"status": "failed", "tries": int(d.get("tries") or 0) + 1, "error": str(e)[:400],
                 "updatedAt": _stamp()}, merge=True)
        return _failed(db, people, d, str(e), by_hand)
    ref.set(dict(done, status="posted", postedAt=now.isoformat(), error=None, updatedAt=_stamp()), merge=True)
    print("social: posted", pid, done.get("link"))
    return [{"posted": pid, "link": done.get("link")}]


def _failed(db, people, d, why, by_hand):
    if by_hand:
        return []
    return _push(db, people, "⚠️ %s post didn't go up" % NAMES.get(d.get("place"), "A"),
                 str(why)[:150] + " — tap to see it.", "yd-social-failed")


# ---------------------------------------------------------------- Facebook


def _fb_doc(db):
    snap = db.collection(FB_DOC[0]).document(FB_DOC[1]).get()
    return (snap.to_dict() or {}) if snap.exists else {}


def _fb_error(r, who="Facebook"):
    """Graph's answer -> NotConnected (token or permission), Retry (their
    trouble or a limit), else an error with its words."""
    try:
        err = (r.json() or {}).get("error") or {}
    except ValueError:
        err = {}
    code = err.get("code")
    msg = str(err.get("message") or r.text[:200])
    if code in (190, 102) or (code in (10, 200, 3) and "permission" in msg.lower()) or r.status_code == 401:
        return NotConnected("%s needs hooking up again (%s)" % (who, msg[:160]))
    if r.status_code >= 500 or code in (1, 2, 4, 17, 32, 341, 368, 613):
        return Retry("%s said: %s" % (who, msg[:200]))
    return RuntimeError("%s said: %s" % (who, msg[:300]))


def fb_post(db, d):
    fb = _fb_doc(db)
    page, token = fb.get("pageId"), fb.get("pageToken")
    if not (page and token):
        raise NotConnected("Facebook isn't hooked up yet")
    name = next((p.get("name") for p in (fb.get("pages") or []) if p.get("id") == page), "")
    if not _business_page(name):
        raise NotConnected("Facebook is hooked to %s, not the business Page — hook up again and tick %s"
                           % (name or "another Page", BUSINESS_PAGE_NAME))
    text = str(d.get("text") or "")[:LIMITS["facebook"]]
    photos = [p for p in (d.get("photos") or []) if str((p or {}).get("url") or "").startswith("https://")][:4]
    try:
        if not photos:
            r = requests.post("%s/%s/feed" % (GRAPH, page), data={"message": text, "access_token": token}, timeout=60)
        elif len(photos) == 1:
            r = requests.post("%s/%s/photos" % (GRAPH, page),
                              data={"url": photos[0]["url"], "message": text, "access_token": token}, timeout=120)
        else:
            ids = []
            for p in photos:
                u = requests.post("%s/%s/photos" % (GRAPH, page),
                                  data={"url": p["url"], "published": "false", "access_token": token}, timeout=120)
                if u.status_code >= 300 or not (u.json() or {}).get("id"):
                    raise _fb_error(u)
                ids.append(u.json()["id"])
            data = {"message": text, "access_token": token}
            for i, fid in enumerate(ids):
                data["attached_media[%d]" % i] = json.dumps({"media_fbid": fid})
            r = requests.post("%s/%s/feed" % (GRAPH, page), data=data, timeout=60)
    except requests.ReadTimeout:
        # Sent, but no answer came: Facebook may have put it up. Retried
        # blind it could go up twice, so the Page is looked at first.
        found = _fb_find(page, token, text)
        if found:
            return {"postId": found, "link": "https://www.facebook.com/" + found}
        raise RuntimeError(MAYBE_UP % "Facebook")
    except requests.RequestException as e:
        raise Retry("Facebook could not be reached (%s)" % e)
    if r.status_code >= 300:
        raise _fb_error(r)
    got = r.json() or {}
    post = got.get("post_id") or got.get("id") or ""
    return {"postId": post, "link": "https://www.facebook.com/" + post if post else None}


def _fb_find(page, token, text):
    """The id of a post on the Page in the last half hour with these very
    words, else None (also when the Page can't be read)."""
    try:
        r = requests.get("%s/%s/posts" % (GRAPH, page), timeout=30,
                         params={"fields": "id,message,created_time", "limit": 10, "access_token": token})
        if r.status_code >= 300:
            return None
        since = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=30)
        for p in (r.json() or {}).get("data") or []:
            made = _parse(str(p.get("created_time") or "").replace("+0000", "+00:00"))
            if (p.get("message") or "").strip() == text.strip() and made and made >= since:
                return p.get("id")
    except (requests.RequestException, ValueError):
        return None
    return None


# ---------------------------------------------------------------- Instagram


def _ig_image(p):
    """A public address Instagram will take for this photo. Instagram fetches
    it itself and refuses anything but a JPEG between 4:5 upright and 1.91:1
    wide, and a phone's upright photo (3:4) is a little too tall. Those are cut
    to fit, keeping the middle, and kept in Storage (socialCrops/) with a key
    in the address, as the job photos' own addresses have."""
    from PIL import Image, ImageOps
    url = p["url"]
    try:
        r = requests.get(url, timeout=60)
    except requests.RequestException as e:
        raise Retry("The photo could not be read (%s)" % e)
    if r.status_code >= 300:
        raise RuntimeError("The photo could not be read (it answered %s)" % r.status_code)
    im = Image.open(io.BytesIO(r.content))
    fmt = im.format
    im = ImageOps.exif_transpose(im)
    w, h = im.size
    shape = w / h
    if fmt == "JPEG" and IG_TALLEST <= shape <= IG_WIDEST:
        return url
    box = (0, 0, w, h)
    if shape < IG_TALLEST:
        keep = round(w / IG_TALLEST)
        box = (0, (h - keep) // 2, w, (h - keep) // 2 + keep)
    elif shape > IG_WIDEST:
        keep = round(h * IG_WIDEST)
        box = ((w - keep) // 2, 0, (w - keep) // 2 + keep, h)
    out = io.BytesIO()
    im.crop(box).convert("RGB").save(out, "JPEG", quality=90)
    return _keep_crop(p.get("id"), out.getvalue())


def _keep_crop(pid, raw):
    import receipts
    path = "socialCrops/%s.jpg" % re.sub(r"[^A-Za-z0-9_-]", "", str(pid or "photo"))
    key = str(uuid.uuid4())
    blob = receipts._bucket().blob(path)
    blob.metadata = {"firebaseStorageDownloadTokens": key}
    blob.upload_from_string(raw, content_type="image/jpeg")
    return "https://firebasestorage.googleapis.com/v0/b/%s/o/%s?alt=media&token=%s" % (
        receipts.STORAGE_BUCKET, urllib.parse.quote(path, safe=""), key)


def _ig_box(ig, token, params):
    """One Instagram 'container'. Nothing is up yet, so a failure here is safe
    to try again."""
    try:
        r = requests.post("%s/%s/media" % (GRAPH, ig), data=dict(params, access_token=token), timeout=120)
    except requests.RequestException as e:
        raise Retry("Instagram could not be reached (%s)" % e)
    if r.status_code >= 300 or not (r.json() or {}).get("id"):
        raise _fb_error(r, "Instagram")
    return r.json()["id"]


def _ig_wait(box, token):
    """Instagram fetches the photo in its own time: it must say FINISHED before
    the post can go up."""
    for _ in range(IG_WAIT_TRIES):
        try:
            r = requests.get("%s/%s" % (GRAPH, box), params={"fields": "status_code,status", "access_token": token},
                             timeout=30)
        except requests.RequestException as e:
            raise Retry("Instagram could not be reached (%s)" % e)
        if r.status_code >= 300:
            raise _fb_error(r, "Instagram")
        got = r.json() or {}
        if got.get("status_code") in ("FINISHED", "PUBLISHED"):
            return
        if got.get("status_code") in ("ERROR", "EXPIRED"):
            raise RuntimeError("Instagram wouldn't take the photo: %s" % str(got.get("status") or "")[:200])
        time.sleep(3)
    raise Retry("Instagram is still working on the photos")


def ig_post(db, d):
    fb = _fb_doc(db)
    ig, token = fb.get("igId"), fb.get("pageToken")
    if not (ig and token):
        raise NotConnected("Instagram isn't hooked up yet")
    photos = [p for p in (d.get("photos") or []) if str((p or {}).get("url") or "").startswith("https://")]
    if not photos:
        raise RuntimeError("Instagram needs a photo on the post")
    caption = str(d.get("text") or "")[:LIMITS["instagram"]]
    urls = [_ig_image(p) for p in photos[:PHOTOS["instagram"]]]
    if len(urls) == 1:
        box = _ig_box(ig, token, {"image_url": urls[0], "caption": caption})
    else:
        kids = [_ig_box(ig, token, {"image_url": u, "is_carousel_item": "true"}) for u in urls]
        for k in kids:
            _ig_wait(k, token)
        box = _ig_box(ig, token, {"media_type": "CAROUSEL", "children": ",".join(kids), "caption": caption})
    _ig_wait(box, token)
    try:
        r = requests.post("%s/%s/media_publish" % (GRAPH, ig), data={"creation_id": box, "access_token": token},
                          timeout=120)
    except requests.ReadTimeout:
        # As for Facebook: no answer is not "not up". Look before anything
        # could put it up a second time.
        found = _ig_look(ig, token, caption)
        if found:
            return {"postId": found.get("id"), "link": found.get("permalink")}
        raise RuntimeError(MAYBE_UP % "Instagram")
    except requests.RequestException as e:
        raise Retry("Instagram could not be reached (%s)" % e)
    if r.status_code >= 300:
        raise _fb_error(r, "Instagram")
    post = (r.json() or {}).get("id") or ""
    return {"postId": post, "link": _ig_link(post, token)}


def _ig_link(post, token):
    try:
        r = requests.get("%s/%s" % (GRAPH, post), params={"fields": "permalink", "access_token": token}, timeout=30)
        return (r.json() or {}).get("permalink") if r.status_code < 300 else None
    except (requests.RequestException, ValueError):
        return None                     # it is up; only the link is missing


def _ig_look(ig, token, caption):
    """The account's post from the last half hour with this very caption, else
    None (also when the account can't be read)."""
    try:
        r = requests.get("%s/%s/media" % (GRAPH, ig), timeout=30, params={
            "fields": "id,caption,timestamp,permalink", "limit": 10, "access_token": token})
        if r.status_code >= 300:
            return None
        since = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=30)
        for p in (r.json() or {}).get("data") or []:
            made = _parse(str(p.get("timestamp") or "").replace("+0000", "+00:00"))
            if (p.get("caption") or "").strip() == caption.strip() and made and made >= since:
                return p
    except (requests.RequestException, ValueError):
        return None
    return None


def ig_find(db=None):
    """Find the business Instagram account linked to the Page and keep it
    (integrations/facebook.igId; settings/social.instagram for the app).
    Returns what was found or why not."""
    db = db or _db()
    fb = _fb_doc(db)
    page, token = fb.get("pageId"), fb.get("pageToken")
    try:
        if not (page and token):
            raise NotConnected("Hook up Facebook first: Instagram comes through the Facebook Page")
        r = requests.get("%s/%s" % (GRAPH, page), timeout=30, params={
            "fields": "instagram_business_account{id,username}", "access_token": token})
        if r.status_code >= 300:
            raise _fb_error(r, "Instagram")
        got = (r.json() or {}).get("instagram_business_account") or {}
        if not got.get("id"):
            raise NotConnected(IG_NOT_LINKED)
        if not IG_ACCOUNT.search(str(got.get("username") or "")):
            raise NotConnected("The Page is linked to @%s, not the business's Instagram: posts only go out as the "
                               "business" % (got.get("username") or "another account"))
    except requests.RequestException as e:
        return {"error": "Facebook could not be reached (%s)" % e}
    except Retry as e:
        return {"error": str(e)}
    except (NotConnected, RuntimeError) as e:
        db.collection(FB_DOC[0]).document(FB_DOC[1]).set({"igId": firestore.DELETE_FIELD}, merge=True)
        _set(db, {"instagram": {"ok": False, "id": None, "username": None, "error": str(e)[:300],
                                "checkedAt": _now().isoformat()}})
        return {"error": str(e)}
    db.collection(FB_DOC[0]).document(FB_DOC[1]).set({"igId": got["id"]}, merge=True)
    _set(db, {"instagram": {"ok": True, "id": got["id"], "username": got.get("username") or "", "error": None,
                            "checkedAt": _now().isoformat()}})
    _refresh_not_connected(db, "instagram")
    return {"ok": True, "username": got.get("username") or ""}


BUSINESS_PAGE_NAME = "YD Exterior Visions"


def _business_page(name):
    """A Page Job Hub may post to: the business's own, by its name."""
    return bool(re.search(r"\b(yd|yard dudes|exterior visions)\b", str(name or ""), re.I))


def _redirect():
    base = os.environ.get("QB_REDIRECT_URI", "").split("/qb/")[0]
    return base + "/social/fb/callback" if base else ""


def fb_set_app(app_id, app_secret, uid):
    """His Meta app's id and secret, checked with Facebook before they are
    kept (integrations/facebook: no app or person can read it)."""
    app_id, app_secret = str(app_id or "").strip(), str(app_secret or "").strip()
    if not re.match(r"^\d{6,25}$", app_id):
        return {"error": "The App ID is the long number at the top of your app's page"}
    if not re.match(r"^[0-9a-f]{20,64}$", app_secret, re.I):
        return {"error": "The App secret is 32 letters and numbers (App settings › Basic › Show)"}
    r = requests.get("%s/oauth/access_token" % GRAPH, params={"client_id": app_id, "client_secret": app_secret,
                                                             "grant_type": "client_credentials"}, timeout=30)
    if r.status_code >= 300 or not (r.json() or {}).get("access_token"):
        return {"error": "Facebook didn't accept that App ID and secret together — check both and try again"}
    db = _db()
    db.collection(FB_DOC[0]).document(FB_DOC[1]).set({"appId": app_id, "appSecret": app_secret,
                                                       "appSetAt": _now().isoformat(), "appSetBy": uid}, merge=True)
    _set(db, {"facebook": {"appId": app_id, "appSet": True, "error": None}})
    return {"ok": True, "redirect": _redirect()}


def fb_connect_url(uid):
    fb = _fb_doc(_db())
    if not (fb.get("appId") and fb.get("appSecret")):
        return {"error": "Put in your Facebook app's ID and secret first"}
    if not _redirect():
        return {"error": "This server doesn't know its own address (QB_REDIRECT_URI)"}
    state = secrets.token_urlsafe(24)
    _db().collection(STATE_COLLECTION).document(state).set({"uid": uid, "kind": "facebook",
                                                             "createdAt": datetime.datetime.now(
                                                                 datetime.timezone.utc).isoformat()})
    q = urllib.parse.urlencode({"client_id": fb["appId"], "redirect_uri": _redirect(), "state": state,
                                "scope": FB_SCOPES, "response_type": "code"})
    return {"url": FB_DIALOG + "?" + q}


def fb_callback(request):
    """Facebook sends him back here. Returns (html, status)."""
    args = request.args
    if args.get("error"):
        return _page("Facebook was not hooked up: %s" % (args.get("error_description") or args.get("error")), False)
    code, state = args.get("code"), args.get("state")
    if not (code and state):
        return _page("That link was incomplete. Start again from Job Hub.", False)
    db = _db()
    ref = db.collection(STATE_COLLECTION).document(state)
    snap = ref.get()
    started = (snap.to_dict() or {}) if snap.exists else {}
    if not snap.exists or started.get("kind") != "facebook":
        fb = _fb_doc(db)
        if fb.get("pageToken") and (_now() - (_parse(fb.get("connectedAt")) or _now() - datetime.timedelta(days=1))) \
                < datetime.timedelta(minutes=STATE_MINUTES):
            return _page("Facebook is hooked up.", True)      # the same return loaded twice
        return _page("That attempt was not recognised. Start again from Job Hub.", False)
    ref.delete()
    began = _parse(started.get("createdAt"))
    if not began or datetime.datetime.now(datetime.timezone.utc) - began > datetime.timedelta(minutes=STATE_MINUTES):
        return _page("That took too long. Start again from Job Hub.", False)
    fb = _fb_doc(db)
    try:
        r = requests.get("%s/oauth/access_token" % GRAPH, timeout=30, params={
            "client_id": fb["appId"], "client_secret": fb["appSecret"], "redirect_uri": _redirect(), "code": code})
        short = (r.json() or {}).get("access_token")
        if not short:
            raise RuntimeError(str(((r.json() or {}).get("error") or {}).get("message") or "no token"))
        r = requests.get("%s/oauth/access_token" % GRAPH, timeout=30, params={
            "grant_type": "fb_exchange_token", "client_id": fb["appId"], "client_secret": fb["appSecret"],
            "fb_exchange_token": short})
        long_user = (r.json() or {}).get("access_token")
        if not long_user:
            raise RuntimeError("the long-lived token was refused")
        pages, seen = _granted_pages(fb, long_user)
        if not pages:
            raise RuntimeError("no Facebook Page came through to Job Hub (%s)" % seen)
        # Posts go out as the business, never as anyone's own Page (Jonah, 2 Nov:
        # his first hookup shared only a personal Page and that Page was taken).
        shared = [p.get("name") or "" for p in pages]
        pages = [p for p in pages if _business_page(p.get("name"))]
        if not pages:
            raise RuntimeError("Facebook shared only %s, not the business Page. Hook up again and tick %s"
                               % (", ".join(shared), BUSINESS_PAGE_NAME))
        able = [p for p in pages if "CREATE_CONTENT" in (p.get("tasks") or [])] or pages
        page = able[0]
        db.collection(FB_DOC[0]).document(FB_DOC[1]).set({
            "userToken": long_user, "connectedAt": _now().isoformat(), "connectedBy": started.get("uid", ""),
            "pages": [{"id": p["id"], "name": p.get("name") or "", "token": p["access_token"],
                       "link": p.get("link") or ""} for p in pages],
            "pageId": page["id"], "pageToken": page["access_token"]}, merge=True)
        _set(db, {"facebook": {"pageId": page["id"], "pageName": page.get("name") or "",
                               "pageLink": page.get("link") or "", "connectedAt": _now().isoformat(),
                               "pages": [{"id": p["id"], "name": p.get("name") or ""} for p in pages],
                               "error": None}})
        _refresh_not_connected(db, "facebook")
        ig = ig_find(db)                # Instagram comes with the same hookup
    except Exception as e:              # noqa: BLE001 -- shown, not swallowed
        print("social: facebook callback failed:", e)
        _set(db, {"facebook": {"error": "Facebook could not be hooked up: %s" % e}})
        return _page("Facebook could not be hooked up: %s" % e, False)
    return _page("Facebook is hooked up — posts go to %s. %s" % (
        page.get("name") or "your Page",
        "Instagram too: @%s." % ig.get("username") if ig.get("ok") else "Instagram isn't yet: %s" % ig.get("error")), True)


PAGE_FIELDS = "id,name,access_token,tasks,link"


def _granted_pages(fb, user):
    """The Pages he shared, each with its own key. /me/accounts first; a Page
    picked in Facebook's chooser that it leaves out (business-owned Pages can
    be) is asked for by its id, from the token's granted targets. Also says
    what Facebook gave, so a failed hookup can tell why."""
    pages, listed, url = {}, [], "%s/me/accounts" % GRAPH
    params = {"fields": PAGE_FIELDS, "access_token": user, "limit": 100}
    while url and len(listed) < 200:
        got = requests.get(url, params=params, timeout=30).json() or {}
        listed.extend(got.get("data") or [])
        url, params = (got.get("paging") or {}).get("next"), None
    for p in listed:
        if p.get("id") and p.get("access_token"):
            pages[p["id"]] = p
    scopes, targets = [], []
    try:
        got = requests.get("%s/debug_token" % GRAPH, timeout=30, params={
            "input_token": user, "access_token": "%s|%s" % (fb["appId"], fb["appSecret"])}).json() or {}
        data = got.get("data") or {}
        scopes = data.get("scopes") or []
        for g in data.get("granular_scopes") or []:
            if str(g.get("scope") or "").startswith("pages_"):
                targets.extend(t for t in (g.get("target_ids") or []) if t not in targets)
    except (requests.RequestException, ValueError) as e:
        print("social: facebook debug_token failed:", e)
    refused = []
    for pid in targets:
        if pid in pages:
            continue
        got = requests.get("%s/%s" % (GRAPH, pid), params={"fields": PAGE_FIELDS, "access_token": user},
                           timeout=30).json() or {}
        if got.get("id") and got.get("access_token"):
            pages[got["id"]] = got
        else:
            why = str((got.get("error") or {}).get("message") or "no key") if isinstance(got.get("error"), dict) \
                else "no key"
            refused.append("%s: %s" % (got.get("name") or pid, why[:160]))
            print("social: facebook page %s gave no key: %s" % (pid, str(got)[:300]))
    seen = "listed: %s; picked: %s; allowed: %s%s" % (
        ", ".join("%s%s" % (p.get("name") or p.get("id"), "" if p.get("access_token") else " (no key)")
                  for p in listed) or "none",
        ", ".join(targets) or "none", ", ".join(scopes) or "none",
        "; Facebook said " + " / ".join(refused) if refused else "")
    return list(pages.values()), seen


def fb_pick_page(page_id):
    db = _db()
    fb = _fb_doc(db)
    page = next((p for p in (fb.get("pages") or []) if p.get("id") == page_id), None)
    if not page:
        return {"error": "That Page wasn't shared with Job Hub"}
    if not _business_page(page.get("name")):
        return {"error": "Posts go out as the business — pick %s" % BUSINESS_PAGE_NAME}
    db.collection(FB_DOC[0]).document(FB_DOC[1]).set({"pageId": page["id"], "pageToken": page["token"]}, merge=True)
    _set(db, {"facebook": {"pageId": page["id"], "pageName": page.get("name") or "",
                           "pageLink": page.get("link") or ""}})
    ig_find(db)
    return {"ok": True}


def fb_disconnect():
    """Unhook: the tokens go, the app id and secret stay (hooking up again
    is then one tap). The permissions are given back to Facebook too, so the
    next hookup asks afresh which Pages to share."""
    db = _db()
    user = _fb_doc(db).get("userToken")
    if user:
        try:
            requests.delete("%s/me/permissions" % GRAPH, params={"access_token": user}, timeout=30)
        except requests.RequestException as e:
            print("social: facebook permissions not given back:", e)
    db.collection(FB_DOC[0]).document(FB_DOC[1]).set({"userToken": firestore.DELETE_FIELD,
                                                       "pageToken": firestore.DELETE_FIELD,
                                                       "pages": firestore.DELETE_FIELD,
                                                       "pageId": firestore.DELETE_FIELD,
                                                       "igId": firestore.DELETE_FIELD}, merge=True)
    _set(db, {"facebook": {"pageId": None, "pageName": None, "pageLink": None, "pages": [], "connectedAt": None},
              "instagram": {"ok": False, "id": None, "username": None, "error": None}})
    return {"ok": True}


def _refresh_not_connected(db, place):
    """Hooked up now: the posts still to come that were marked not hooked up
    go back in line."""
    now = _now()
    auto = settings(db).get("auto") is not False
    for s in db.collection("socialPosts").where("status", "==", "notConnected").stream():
        d = s.to_dict() or {}
        at = _parse(d.get("at"))
        if d.get("place") == place and at and at > now:
            # Back in line -- or waiting for his OK while posts going up by
            # themselves is switched off.
            line = "queued" if auto or d.get("okAt") else "held"
            s.reference.set({"status": line, "heldWhy": None if line == "queued" else HELD_NO_AUTO,
                             "error": None, "updatedAt": _stamp()}, merge=True)


def _page(message, ok):
    """The page he lands on after Facebook (as quickbooks._closing_page)."""
    import quickbooks as qb
    html, status = qb._closing_page(message, ok)
    return html.replace("<title>QuickBooks</title>", "<title>Facebook</title>"), status


# ---------------------------------------------------------------- Google


def _gtoken():
    try:
        return dg._gmail_access_token(GBP_SCOPE)
    except Exception as e:              # noqa: BLE001 -- told in words he can act on
        if "unauthorized_client" in str(e) or "access_denied" in str(e):
            raise NotConnected("Google: Job Hub isn't allowed into the Business Profile yet "
                               "(the Admin console step)")
        raise Retry("Google sign-in failed (%s)" % str(e)[:150])


def _g_error(r):
    try:
        err = (r.json() or {}).get("error") or {}
    except ValueError:
        err = {}
    msg = str(err.get("message") or r.text[:200])
    status = str(err.get("status") or "")
    if r.status_code == 429 or ("quota" in msg.lower() and "0" in msg):
        return NotConnected("Google hasn't switched on Job Hub's Business Profile access yet (%s)" % msg[:140])
    if r.status_code == 403 and ("SERVICE_DISABLED" in r.text or "has not been used" in msg or "disabled" in msg):
        return NotConnected("The Business Profile APIs aren't switched on in Google Cloud yet")
    if r.status_code in (401, 403) or status in ("PERMISSION_DENIED", "UNAUTHENTICATED"):
        return NotConnected("Google said no: %s" % msg[:200])
    if r.status_code >= 500:
        return Retry("Google said: %s" % msg[:200])
    return RuntimeError("Google said: %s" % msg[:300])


def google_find():
    """Find the Business Profile the owner's account manages, and keep it
    (settings/social.google). Returns what was found or why not."""
    db = _db()
    try:
        tok = _gtoken()
        h = {"Authorization": "Bearer " + tok}
        r = requests.get(GBP_ACCOUNTS, headers=h, timeout=30)
        if r.status_code >= 300:
            raise _g_error(r)
        found = []
        for a in (r.json() or {}).get("accounts") or []:
            r2 = requests.get(GBP_INFO + a["name"] + "/locations", headers=h, timeout=30,
                              params={"readMask": "name,title,websiteUri", "pageSize": 100})
            if r2.status_code >= 300:
                raise _g_error(r2)
            for loc in (r2.json() or {}).get("locations") or []:
                found.append({"account": a["name"], "location": loc["name"], "title": loc.get("title") or ""})
        if not found:
            raise NotConnected("The Google account %s doesn't manage a Business Profile — add it as an owner or "
                               "manager of the profile" % dg.OWNER_EMAIL)
        pick = next((f for f in found if re.search(r"\b(yd|exterior)\b", f["title"], re.I)), found[0])
        _set(db, {"google": dict(pick, all=found, checkedAt=_now().isoformat(), error=None, ok=True)})
        _refresh_not_connected(db, "google")
        return dict(pick, ok=True)
    except (NotConnected, Retry, RuntimeError) as e:
        _set(db, {"google": {"ok": False, "error": str(e)[:300], "checkedAt": _now().isoformat()}})
        return {"error": str(e)}


def google_post(db, d, now):
    g = settings(db).get("google") or {}
    if not (g.get("ok") and g.get("account") and g.get("location")):
        raise NotConnected("Google Business Profile isn't hooked up yet")
    where = g["account"] + "/" + g["location"]          # accounts/1/locations/2 -- what v4 wants
    h = {"Authorization": "Bearer " + _gtoken()}
    body = {"languageCode": "en-US", "summary": str(d.get("text") or "")[:LIMITS["google"]],
            "topicType": "STANDARD", "callToAction": {"actionType": "CALL"}}
    photo = next((p for p in (d.get("photos") or []) if str((p or {}).get("url") or "").startswith("https://")), None)
    if photo:
        body["media"] = [{"mediaFormat": "PHOTO", "sourceUrl": photo["url"]}]
    try:
        r = requests.post(GBP_V4 + where + "/localPosts", headers=h, json=body, timeout=60)
    except requests.ReadTimeout:
        # As for Facebook: no answer is not "not up" -- the profile is looked
        # at before anything could put it up a second time.
        found = _g_find(h, where, body["summary"])
        if found:
            return {"postId": found.get("name"), "link": found.get("searchUrl"),
                    "galleryAdded": _gallery(db, h, where, now)}
        raise RuntimeError(MAYBE_UP % "Google")
    except requests.RequestException as e:
        raise Retry("Google could not be reached (%s)" % e)
    if r.status_code >= 300:
        raise _g_error(r)
    got = r.json() or {}
    added = _gallery(db, h, where, now)
    return {"postId": got.get("name"), "link": got.get("searchUrl"), "galleryAdded": added}


def _g_find(h, where, summary):
    """The profile's post from the last half hour with these very words,
    else None (also when the profile can't be read)."""
    try:
        r = requests.get(GBP_V4 + where + "/localPosts", headers=h, params={"pageSize": 10}, timeout=30)
        if r.status_code >= 300:
            return None
        since = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=30)
        for p in (r.json() or {}).get("localPosts") or []:
            made = _parse(str(p.get("createTime") or "").replace("Z", "+00:00"))
            if (p.get("summary") or "").strip() == summary.strip() and made and made >= since:
                return p
    except (requests.RequestException, ValueError):
        return None
    return None


def _gallery(db, h, where, now):
    """The week's new After photos into the profile's photos (Jonah, 27 Oct:
    "Add after photos weekly"), up to GALLERY_A_WEEK, each once. A week with
    fewer new ones fills the spare spots from finished jobs' older After
    photos (Jonah, 2 Nov: the past jobs' photos, dated by the camera, were
    never "new"), so the whole back catalogue reaches the profile in time."""
    done = settings(db).get("gPhotos") or {}
    added, refused = [], []
    for p in _gallery_picks(db, done, now):
        try:
            r = requests.post(GBP_V4 + where + "/media", headers=h, timeout=60, json={
                "mediaFormat": "PHOTO", "locationAssociation": {"category": "AT_WORK"}, "sourceUrl": p["url"]})
        except requests.RequestException as e:
            print("social: gallery photo not added:", p["id"], e)
            continue
        if r.status_code == 400:
            # Google won't take this photo (too small, can't fetch it): it is
            # never tried again, or it would take a spot every week.
            print("social: gallery photo refused:", p["id"], r.text[:200])
            refused.append(p["id"])
            continue
        if r.status_code >= 300:
            # Google itself said no (key, limits, down): the rest wait a week.
            print("social: gallery photos stopped:", p["id"], r.status_code, r.text[:200])
            break
        added.append(p["id"])
    if added or refused:
        day = now.date().isoformat()
        _set(db, {"gPhotos": dict({pid: day for pid in added}, **{pid: "refused " + day for pid in refused})})
    return added


def _gallery_picks(db, done, now):
    """The photos this week's post puts on the profile: After photos from the
    last 8 days first (newest first), then older ones from finished jobs. The
    older ones go a job at a time -- the job with the fewest on the profile
    so far, newest finished first -- so each week shows different jobs
    instead of one job's whole set."""
    since = now - datetime.timedelta(days=8)
    fresh, older = [], []
    for jid, lst in after_photos(db).items():
        left = [p for p in lst if p["id"] not in done]
        if not left:
            continue
        snap = db.collection("jobs").document(jid).get()
        if not snap.exists:
            continue
        j = snap.to_dict() or {}
        if j.get("noPost") or j.get("removeWhy") or j.get("deletedAt"):
            continue
        new = [p for p in left if (_parse(p["at"]) or since) > since]
        fresh.extend(new)
        day = _finished(j)
        if day:
            shown = len(lst) - len(left)
            older.extend(((shown + n, day, jid), p) for n, p in enumerate(q for q in left if q not in new))
    picks = sorted(fresh, key=lambda x: x["at"], reverse=True)[:GALLERY_A_WEEK]
    # Turn (fewest shown first), then the newest finished job, then its newest photo.
    older.sort(key=lambda x: (x[0][0], _neg_day(x[0][1]), x[0][2]))
    picks += [p for _, p in older[:GALLERY_A_WEEK - len(picks)]]
    return picks


def _neg_day(day):
    """'2026-10-21' -> a key that sorts the newest day first."""
    return -int(day.replace("-", ""))


# ---------------------------------------------------------------- the app


def rewrite(client, pid, note=None):
    """"Write it again" on a job's post: Claude writes the job's words anew
    (socialWords), and every post of that job not up yet and not changed by
    hand takes them -- checked again, as when planned. `note`: his note for
    Claude on this job's posts (None = keep the one he left before)."""
    import posts
    import spend
    db = _db()
    snap = db.collection("socialPosts").document(pid).get()
    d = (snap.to_dict() or {}) if snap.exists else {}
    jid = d.get("jobId")
    if d.get("kind") != "job" or not jid:
        return {"error": "Only a job's post can be written again — change the words by hand"}
    js = db.collection("jobs").document(jid).get()
    if not js.exists:
        return {"error": "That job is gone"}
    if spend.over_cap(db):
        return {"error": "Over today's Claude limit — try tomorrow, or change the words by hand"}
    j = js.to_dict() or {}
    res, usage = posts.words(client, db, jid, j, note)
    if usage is not None:
        spend.record(db, spend.today(), "social", posts.MODEL, usage)
    if not (isinstance(res, dict) and res.get("facebook")):
        return {"error": (res or {}).get("error") or "Claude's words didn't come back"}
    cfg = settings(db)
    auto = cfg.get("auto") is not False
    changed = 0
    for s in db.collection("socialPosts").where("jobId", "==", jid).stream():
        p = s.to_dict() or {}
        place = p.get("place")
        if note is not None and (p.get("jobNote") or "") != note.strip()[:posts.NOTE_MAX]:
            # Shown in each of the job's posts' note box (socialposts.js).
            s.reference.set({"jobNote": note.strip()[:posts.NOTE_MAX] or None}, merge=True)
        if place not in PLACES or p.get("edited") or p.get("status") not in ("queued", "held", "notConnected", "failed",
                                                                                 "missed"):
            continue
        words = _words_for(place, res)
        if not words:
            continue
        text, sign = _with_sign_off(place, words, cfg)
        why = problems(words, j)
        patch = {"words": words, "text": text, "signOff": sign if place != "google" else "", "updatedAt": _stamp()}
        if why:
            patch.update(status="held", heldWhy=why)
        elif p.get("status") == "held" and p.get("heldWhy") != "You held it":
            patch.update(status="queued" if auto else "held", heldWhy=None if auto else p.get("heldWhy"))
        s.reference.set(patch, merge=True)
        changed += 1
    return {"ok": True, "posts": changed}


def status():
    """What the app shows about the hookups."""
    db = _db()
    cfg = settings(db)
    fb = _fb_doc(db)
    return {"facebook": {"appSet": bool(fb.get("appId") and fb.get("appSecret")), "appId": fb.get("appId"),
                         "connected": bool(fb.get("pageToken")), "pageId": fb.get("pageId"),
                         "redirect": _redirect()},
            "instagram": cfg.get("instagram") or {}, "google": cfg.get("google") or {}, "on": bool(cfg.get("on"))}
