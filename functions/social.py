"""Facebook, Google Business Profile and Nextdoor posts, on a schedule.

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
    photos go into the profile's photos with it.
  - Nextdoor Thu 6:00 pm every other week: Nextdoor's own advice is Thursday
    or Friday, 5-7 pm, and a new post about every two weeks.

What goes in a slot, in this order:
  1. a job finished in the last RECENT_DAYS days with After photos, not yet
     posted there (oldest first, so they go in the order finished);
  2. an older finished job with After photos, never posted there (newest
     first) -- the season's work, shown off through the winter;
  3. one of the month's seasonal posts (socialIdeas/{YYYY-MM}), written once
     a month by Claude, with a photo of a past job when one fits.
Never the same job twice in one place. A job ticked "Don't post" (noPost) is
never used.

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
    (business voice, growing). Claude is told all of this; code checks it.

Facebook: a Page token from his own Meta app (Standard Access needs no App
Review for a Page its own admin manages). He puts the app's id and secret in
once (/social/fb/app, kept in integrations/facebook, which no app can read)
and connects; a Page token made from a long-lived user token does not
expire. Google: domain-wide delegation as the owner's Workspace account
(digest._gmail_access_token) with the business.manage scope -- no stored
key -- once Google has approved the project for the Business Profile API.
Nextdoor: posting by itself needs Nextdoor's OK for its Publish API; until
then a Nextdoor post is "ready" at its time and his phone is told, and Job
Hub opens Nextdoor with the words already in (socialposts.js).

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
import json
import os
import re
import secrets
import urllib.parse

import requests
from google.api_core.exceptions import AlreadyExists
from google.cloud import firestore

import digest as dg

MODEL = "claude-sonnet-5-5"

PLACES = ("facebook", "google", "nextdoor")
NAMES = {"facebook": "Facebook", "google": "Google", "nextdoor": "Nextdoor"}
SEASONS = ("all", "growing", "winter")
GROWING_MONTHS = (4, 5, 6, 7, 8, 9, 10)

# day: 0 Sunday .. 6 Saturday (as JavaScript's getDay, so socialposts.js and
# this agree without converting).
DEFAULT_SLOTS = [
    {"id": "fb1", "place": "facebook", "day": 2, "time": "09:30", "every": 1, "season": "all"},
    {"id": "fb2", "place": "facebook", "day": 4, "time": "13:00", "every": 1, "season": "all"},
    {"id": "fb3", "place": "facebook", "day": 6, "time": "09:00", "every": 1, "season": "growing"},
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
WRITES_PER_RUN = 6                        # Claude writes for this many jobs a run at most
PLAN_BUDGET_S = 150                       # ... and is not asked again after this many seconds
IDEAS_PER_MONTH = 10
PHOTOS = {"facebook": 4, "google": 1, "nextdoor": 4}
GALLERY_A_WEEK = 5                        # After photos added to the Google profile each week
LIMITS = {"facebook": 5000, "google": 1500, "nextdoor": 3400}

SETTINGS = ("settings", "social")
FB_DOC = ("integrations", "facebook")
STATE_COLLECTION = "integrationState"     # shared with quickbooks.py (its sweep tidies both)
STATE_MINUTES = 15

GRAPH = "https://graph.facebook.com/v26.0"
FB_DIALOG = "https://www.facebook.com/v26.0/dialog/oauth"
FB_SCOPES = "pages_show_list,pages_read_engagement,pages_manage_posts"

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


def _parse(s):
    try:
        t = datetime.datetime.fromisoformat(str(s))
    except (TypeError, ValueError):
        return None
    return t if t.tzinfo else t.replace(tzinfo=dg.TZ)


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


def _push(db, people, title, body, tag):
    out = []
    for uid in _owners(people if people is not None else dg._people()):
        try:
            out.append({"uid": uid, "phones": dg.send_push(uid, {"push": {"title": title, "body": body}},
                                                            tag=tag, ttl=20 * 3600, opens="posts")})
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


def _used(db):
    """{place: {jobIds}}, {place: {ideaIds}} and every post by id -- from
    every post ever planned (a skipped one counts: he did not want it)."""
    jobs = {p: set() for p in PLACES}
    ideas = {p: set() for p in PLACES}
    posts = {}
    for s in db.collection("socialPosts").stream():
        d = s.to_dict() or {}
        posts[s.id] = d
        place = d.get("place")
        if place not in jobs:
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


def _with_sign_off(place, words, cfg):
    sign = str(((cfg.get("signOff") or {}).get(place)) or "").strip()
    text = words + ("\n\n" + sign if sign and place != "google" else "")
    return text[:LIMITS[place]], sign


# ---------------------------------------------------------------- seasonal posts

IDEA_SYSTEM = (
    "You write social media posts for YD Exterior Visions LLC, a landscaping and hardscaping company serving Dane "
    "and Green County, Wisconsin (the Madison area): paver patios, retaining walls, walkways, fire pits, plantings "
    "and garden beds, mulch and rock, sod and seed, artificial turf, drainage, lawn care and snow removal. Job Hub "
    "posts them on a schedule on Facebook, the Google Business Profile and Nextdoor in the weeks when there is no "
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
    "phone number, address or website (the app adds them). Never say licensed, never mention subcontractors, never "
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
        for place in PLACES:
            idea[place] = _clean(place, x.get(place))[:LIMITS[place]]
        if all(idea[p] for p in PLACES):
            ideas.append(idea)
    if ideas:
        db.collection("socialIdeas").document(month).set({"ideas": ideas, "at": _now().isoformat(), "by": "Claude"})
    return ideas, resp.usage


# ---------------------------------------------------------------- planning


def plan(client, db=None, now=None, writes=WRITES_PER_RUN, budget_s=PLAN_BUDGET_S):
    """Fill every empty slot in the next HORIZON_DAYS days. Returns
    {planned, wrote, waiting}. Claude is asked only for words not yet
    written (a job's, or the month's seasonal posts), at most `writes` times
    and not after `budget_s` seconds (it rides on the summary run); a slot
    whose words are not written yet waits for the next run."""
    import time
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
    used_jobs, used_ideas, existing = _used(db)
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
        if got.get("error"):
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
        for jid, j, day in _candidates(place, jobs, used_jobs, now.date()):
            w = words_of(jid, j)
            if w is LATER:
                later = True
                break
            words = _clean(place, (w or {}).get(place))
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
                if idea.get("id") in used_ideas[place] or not idea.get(place):
                    continue
                words = _clean(place, idea[place])
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
        held = why or ("" if auto else "Waiting for your OK (posts going up by themselves is switched off)")
        doc = dict(rec, place=place, at=at.isoformat(), day=at.date().isoformat(), slotId=slot["id"],
                   words=words, signOff=sign if place != "google" else "", text=text,
                   status="held" if held else "queued", heldWhy=held or None, tries=0, error=None,
                   createdAt=stamp, updatedAt=stamp, by="Job Hub")
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


def tell_tomorrow(db=None, people=None, now=None):
    """The evening heads-up: what goes up tomorrow, so he can change or stop
    one first. Once a day."""
    db = db or _db()
    now = now or _now()
    cfg = settings(db)
    if not cfg.get("on"):
        return []
    tomorrow = (now + datetime.timedelta(days=1)).date().isoformat()
    rows = []
    for s in db.collection("socialPosts").where("day", "==", tomorrow).stream():
        d = s.to_dict() or {}
        if d.get("status") in ("queued", "held", "notConnected"):
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
    sent = []
    for s in db.collection("socialPosts").where("status", "==", "queued").stream():
        d = s.to_dict() or {}
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
        elif place == "google":
            done = google_post(db, d, now)
        elif place == "nextdoor":
            # Nextdoor's Publish API needs Nextdoor's OK: until then the post
            # is ready for him, words and photos, one tap from Nextdoor.
            ref.set({"status": "ready", "readyAt": now.isoformat(), "updatedAt": _stamp()}, merge=True)
            if by_hand:
                return []
            return _push(db, people, "\U0001F4E3 Nextdoor post ready",
                         "Tap to open Nextdoor with the words already in, then add the photos and post it.",
                         "yd-social-nextdoor")
        else:
            raise RuntimeError("no such place")
    except NotConnected as e:
        ref.set({"status": "notConnected", "error": str(e), "updatedAt": _stamp()}, merge=True)
        return []
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


def _fb_error(r):
    """Graph's answer -> NotConnected (token or permission), Retry (their
    trouble or a limit), else an error with its words."""
    try:
        err = (r.json() or {}).get("error") or {}
    except ValueError:
        err = {}
    code = err.get("code")
    msg = str(err.get("message") or r.text[:200])
    if code in (190, 102) or (code in (10, 200, 3) and "permission" in msg.lower()) or r.status_code == 401:
        return NotConnected("Facebook needs hooking up again (%s)" % msg[:160])
    if r.status_code >= 500 or code in (1, 2, 4, 17, 32, 341, 368, 613):
        return Retry("Facebook said: %s" % msg[:200])
    return RuntimeError("Facebook said: %s" % msg[:300])


def fb_post(db, d):
    fb = _fb_doc(db)
    page, token = fb.get("pageId"), fb.get("pageToken")
    if not (page and token):
        raise NotConnected("Facebook isn't hooked up yet")
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
    except requests.RequestException as e:
        raise Retry("Facebook could not be reached (%s)" % e)
    if r.status_code >= 300:
        raise _fb_error(r)
    got = r.json() or {}
    post = got.get("post_id") or got.get("id") or ""
    return {"postId": post, "link": "https://www.facebook.com/" + post if post else None}


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
        pages, url = [], "%s/me/accounts" % GRAPH
        params = {"fields": "id,name,access_token,tasks,link", "access_token": long_user, "limit": 100}
        while url and len(pages) < 200:
            r = requests.get(url, params=params, timeout=30)
            got = r.json() or {}
            pages.extend(p for p in (got.get("data") or []) if p.get("id") and p.get("access_token"))
            url, params = (got.get("paging") or {}).get("next"), None
        if not pages:
            raise RuntimeError("no Facebook Page was shared with Job Hub — tick your business Page when Facebook asks")
        able = [p for p in pages if "CREATE_CONTENT" in (p.get("tasks") or [])] or pages
        page = next((p for p in able if re.search(r"\b(yd|yard|exterior)\b", p.get("name") or "", re.I)), able[0])
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
    except Exception as e:              # noqa: BLE001 -- shown, not swallowed
        print("social: facebook callback failed:", e)
        return _page("Facebook could not be hooked up: %s" % e, False)
    return _page("Facebook is hooked up — posts go to %s." % (page.get("name") or "your Page"), True)


def fb_pick_page(page_id):
    db = _db()
    fb = _fb_doc(db)
    page = next((p for p in (fb.get("pages") or []) if p.get("id") == page_id), None)
    if not page:
        return {"error": "That Page wasn't shared with Job Hub"}
    db.collection(FB_DOC[0]).document(FB_DOC[1]).set({"pageId": page["id"], "pageToken": page["token"]}, merge=True)
    _set(db, {"facebook": {"pageId": page["id"], "pageName": page.get("name") or "",
                           "pageLink": page.get("link") or ""}})
    return {"ok": True}


def fb_disconnect():
    """Unhook: the tokens go, the app id and secret stay (hooking up again
    is then one tap)."""
    db = _db()
    db.collection(FB_DOC[0]).document(FB_DOC[1]).set({"userToken": firestore.DELETE_FIELD,
                                                       "pageToken": firestore.DELETE_FIELD,
                                                       "pages": firestore.DELETE_FIELD,
                                                       "pageId": firestore.DELETE_FIELD}, merge=True)
    _set(db, {"facebook": {"pageId": None, "pageName": None, "pageLink": None, "pages": [], "connectedAt": None}})
    return {"ok": True}


def _refresh_not_connected(db, place):
    """Hooked up now: the posts still to come that were marked not hooked up
    go back in line."""
    now = _now()
    for s in db.collection("socialPosts").where("status", "==", "notConnected").stream():
        d = s.to_dict() or {}
        at = _parse(d.get("at"))
        if d.get("place") == place and at and at > now:
            s.reference.set({"status": "queued", "error": None, "updatedAt": _stamp()}, merge=True)


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
    except requests.RequestException as e:
        raise Retry("Google could not be reached (%s)" % e)
    if r.status_code >= 300:
        raise _g_error(r)
    got = r.json() or {}
    added = _gallery(db, h, where, now)
    return {"postId": got.get("name"), "link": got.get("searchUrl"), "galleryAdded": added}


def _gallery(db, h, where, now):
    """The week's new After photos into the profile's photos (Jonah, 27 Oct:
    "Add after photos weekly"), up to GALLERY_A_WEEK, each once."""
    cfg = settings(db)
    done = cfg.get("gPhotos") or {}
    since = now - datetime.timedelta(days=8)
    fresh = []
    for jid, lst in after_photos(db).items():
        new = [p for p in lst if p["id"] not in done and (_parse(p["at"]) or since) > since]
        if not new:
            continue
        snap = db.collection("jobs").document(jid).get()
        j = (snap.to_dict() or {}) if snap.exists else {}
        if not (j.get("noPost") or j.get("removeWhy")):
            fresh.extend(new)
    added = []
    for p in sorted(fresh, key=lambda x: x["at"], reverse=True)[:GALLERY_A_WEEK]:
        try:
            r = requests.post(GBP_V4 + where + "/media", headers=h, timeout=60, json={
                "mediaFormat": "PHOTO", "locationAssociation": {"category": "AT_WORK"}, "sourceUrl": p["url"]})
        except requests.RequestException as e:
            print("social: gallery photo not added:", p["id"], e)
            continue
        if r.status_code >= 300:
            print("social: gallery photo refused:", p["id"], r.status_code, r.text[:200])
            continue
        added.append(p["id"])
    if added:
        _set(db, {"gPhotos": {pid: now.date().isoformat() for pid in added}})
    return added


# ---------------------------------------------------------------- the app


def rewrite(client, pid):
    """"Write it again" on a job's post: Claude writes the job's words anew
    (socialWords), and every post of that job not up yet and not changed by
    hand takes them -- checked again, as when planned."""
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
    res, usage = posts.words(client, db, jid, j)
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
        if place not in PLACES or p.get("edited") or p.get("status") not in ("queued", "held", "notConnected", "failed",
                                                                                 "missed"):
            continue
        words = _clean(place, res.get(place))
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
            "google": cfg.get("google") or {}, "on": bool(cfg.get("on"))}
