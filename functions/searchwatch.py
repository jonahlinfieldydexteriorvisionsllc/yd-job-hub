"""The website watched every day: is each page healthy, and is it on Google?

Jonah, 5 Nov 2026: "get our stuff indexed as soon as possible and also after
indexing you need to be on top of issues that get found."

Once a day after 7 am, on the five-minute reminders run, plain code:

  1. Every page in the sitemap is read the way a crawler reads it: it must
     answer 200, not say noindex, name itself as canonical, have a title, and
     hold structured data that parses. A fault here is checked again before
     it counts, so one slow answer is not an alarm.
  2. Google is asked about every page (Search Console's URL Inspection API,
     read only): on Google, waiting, or a real problem. Needs this service's
     domain-wide delegation to list the webmasters.readonly scope. Until it
     does, part 1 still runs and the record says what is missing.
  3. Google's own alert emails (sc-noreply@google.com) are read too, because
     security and manual-action notices never reach the API.

Whatever is wrong becomes ONE card per kind of problem on the wishes board's
Company Website column, so the night run works it like any other website
wish, and it is on the owner's morning summary. A page fault on the live site
also buzzes his phone once. A problem that goes away closes its own card.

GOOGLE'S OLD NEWS: Search Console keeps showing what it last read, and until
it reads a page again that is the Squarespace site. Anything Google says from
a crawl before the switch (SWITCH) is not treated as a problem with this site:
that page only waits. That is what kept a phantom "review snippets" error, on
data no live page holds, from turning into work.
"""

import datetime
import hashlib
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor

import requests

import digest as dg

SITE = "https://ydexteriorvisions.com"
PROPERTY = "sc-domain:ydexteriorvisions.com"
SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
INSPECT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
SITEMAPS = "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aydexteriorvisions.com/sitemaps"
STATE = ("settings", "searchWatch")
BOARD = "wishes"
FROM_HOUR = 7
BUDGET_SECONDS = 150            # the five-minute run has other work: what isn't read today is read tomorrow
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; YD-Job-Hub-site-check)"}
TIMEOUT = 25
READERS = 6                     # pages read at once
SWITCH = datetime.datetime(2026, 11, 5, 22, 10, tzinfo=datetime.timezone.utc)     # Cloudflare took the domain
STUCK_DAYS = 30                 # Google has not read a page this long after the switch
LEFT_OUT_DAYS = 14              # Google read it and left it out this long: not just its queue any more
RETELL_DAYS = 14                # a closed card's problem still there this long after it was told: a new card
SHRINK = 0.8                    # a sitemap under this share of yesterday's pages has lost pages
HISTORY_DAYS = 60
MAIL_KEPT = 100
MAIL_QUERY = "from:sc-noreply@google.com newer_than:3d"
ALERT = re.compile(r"issue|problem|detected|error|manual action|security|hack|malware|not indexed|prevent|failed|fix", re.I)
URGENT = re.compile(r"manual action|security|hack|malware", re.I)
# "We're validating your ... issue fixes" only says Google began a check it was
# asked for, and "issues fixed" is its good news. "Some fixes failed" stays an alert.
NOT_ALERT = re.compile(r"passed|successful|started|validating your|issues? fixed|search performance|"
                       r"congratulations|reached|good news", re.I)
OK_FETCH = ("", "SUCCESSFUL", "PAGE_FETCH_STATE_UNSPECIFIED")
BLOCKED = ("BLOCKED_BY_META_TAG", "BLOCKED_BY_HTTP_HEADER", "BLOCKED_BY_ROBOTS_TXT")

# One card per kind of problem. live: found on the site itself, so it buzzes
# (quiet: but not this one) and a card closed while it is still broken comes
# straight back.
KINDS = {
    "down": {"live": True, "title": "A website page isn't loading",
             "fix": "Find out why it stopped loading and bring it back, or redirect its address if it moved."},
    "moved": {"live": True, "quiet": True, "title": "The sitemap lists a page that redirects",
              "fix": "List the page's real address in the sitemap, or stop the redirect."},
    "noindex": {"live": True, "title": "A website page tells Google to stay out",
                "fix": "Take the noindex off. Only pages.dev copies should carry it."},
    "canonical": {"live": True, "title": "A website page points Google at a different address",
                  "fix": "Make the page's canonical tag its own address."},
    "title": {"live": True, "title": "A website page has no title",
              "fix": "Give the page a title."},
    "data": {"live": True, "title": "A website page has broken structured data",
             "fix": "Fix the page's JSON-LD so it parses."},
    "sitemap": {"live": True, "title": "The website's sitemap has a problem",
                "fix": "Rebuild or fix the sitemap, and check whether pages went missing from it."},
    "fetch": {"title": "Google can't read a website page",
              "fix": "Look at what Google got (URL Inspection in Search Console) and fix the page or the server."},
    "blocked": {"title": "Google says a website page is blocked",
                "fix": "Find what blocks it: robots.txt, a noindex, or a Cloudflare rule."},
    "duplicate": {"title": "Google picked a different page as the main one",
                  "fix": "Make the page distinct enough, or point it at the page Google chose."},
    "rich": {"title": "Google found an error in a website page's data",
             "fix": "Fix the structured data on the page, then press Validate fix in Search Console."},
    "left_out": {"title": "Google read a website page and left it out",
                 "fix": "Make the page more useful: real job detail, more of its own words, links to it from "
                        "related pages. Never pad it out. For a Yard Talk post, put the suggestion on this card "
                        "and leave the post as it is."},
    "stuck": {"title": "Google still hasn't read some website pages",
              "fix": "Request indexing for the 10 most important pages, then link the rest from pages already "
                     "on Google."},
    "google_sitemap": {"title": "Google found errors in the sitemap",
                       "fix": "Read the errors on the Sitemaps page in Search Console and fix the sitemap."},
}


def _utc():
    return datetime.datetime.now(datetime.timezone.utc)


def _iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _when(text):
    try:
        t = datetime.datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return t if t.tzinfo else t.replace(tzinfo=datetime.timezone.utc)


def _path(url):
    return re.sub(r"^https?://[^/]+", "", url or "").rstrip("/") or "/"


# ---------------------------------------------------------------- the live site

def sitemap_urls():
    """Every address in the sitemap. An error goes to the caller: no list, no
    verdict on any page."""
    r = requests.get(SITE + "/sitemap-index.xml", headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    urls = []
    for loc in re.findall(r"<loc>(.*?)</loc>", r.text):
        m = requests.get(loc.strip(), headers=HEADERS, timeout=TIMEOUT)
        m.raise_for_status()
        urls += [u.strip() for u in re.findall(r"<loc>(.*?)</loc>", m.text)]
    return list(dict.fromkeys(urls))


def page_faults(url, status, headers, html):
    """What is wrong with one page as read: a list of (kind, words)."""
    if 300 <= status < 400:
        return [("moved", "redirects to %s" % _path((headers or {}).get("Location")))]
    if status != 200:
        return [("down", "answers %s" % status)]
    faults = []
    robots = str((headers or {}).get("X-Robots-Tag") or "")
    meta = " ".join(re.findall(r"<meta[^>]+name=[\"']robots[\"'][^>]*>", html, re.I))
    if "noindex" in (robots + meta).lower():
        faults.append(("noindex", "says noindex"))
    for tag in re.findall(r"<link\b[^>]*>", html, re.I):
        canon = re.search(r"href=[\"']([^\"']+)", tag, re.I)
        if re.search(r"rel=[\"']canonical[\"']", tag, re.I) and canon and _path(canon.group(1)) != _path(url):
            faults.append(("canonical", "names %s as its canonical" % _path(canon.group(1))))
    if not re.search(r"<title[^>]*>\s*[^<\s]", html, re.I):
        faults.append(("title", "has no title"))
    for block in re.findall(r"<script[^>]*application/ld\+json[^>]*>(.*?)</script>", html, re.S | re.I):
        try:
            json.loads(block)
        except ValueError:
            faults.append(("data", "has JSON-LD that won't parse"))
            break
    return faults


def _read_page(url):
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=False)
    except requests.RequestException as e:
        return [("down", "didn't answer (%s)" % type(e).__name__)]
    return page_faults(url, r.status_code, r.headers, r.text)


def read_site(urls, deadline):
    """{url: faults} for the pages with faults, and how many were read. A page
    that fails is read once more: one slow answer is not a problem."""
    def one(url):
        return url, _read_page(url) if time.monotonic() < deadline else None
    bad, read = {}, 0
    with ThreadPoolExecutor(READERS) as ex:
        results = list(ex.map(one, urls))
    for url, faults in results:
        if faults is None:
            continue
        read += 1
        if faults:
            bad[url] = faults
    for url in list(bad):
        if time.monotonic() >= deadline:
            # Out of time to check it twice: not read today, not an alarm.
            del bad[url]
            read -= 1
            continue
        time.sleep(3)
        again = _read_page(url)
        if again:
            bad[url] = again
        else:
            del bad[url]
    return bad, read


# ---------------------------------------------------------------- Google's view

def judge(result, was, now):
    """One page's answer from URL Inspection, worked into the record kept for
    it. `was` is yesterday's record: left_out keeps counting from its first
    day. state: on, waiting, problem. kind says which problem, if any."""
    ix = (result or {}).get("indexStatusResult") or {}
    cover = str(ix.get("coverageState") or "")
    crawled = _when(ix.get("lastCrawlTime"))
    fresh = bool(crawled and crawled >= SWITCH)
    rec = {"state": "waiting", "cover": cover[:120], "crawled": _iso(crawled) if crawled else None,
           "kind": None, "why": "", "since": None, "looked": _iso(now)}
    on = ix.get("verdict") == "PASS"
    if on:
        rec["state"] = "on"
    if fresh:
        fetched = str(ix.get("pageFetchState") or "")
        canon_user, canon_google = ix.get("userCanonical"), ix.get("googleCanonical")
        rich = (result or {}).get("richResultsResult") or {}
        if ix.get("robotsTxtState") == "DISALLOWED" or ix.get("indexingState") in BLOCKED or \
                fetched == "BLOCKED_ROBOTS_TXT":
            rec.update(state="problem", kind="blocked", why=str(ix.get("indexingState") or "robots.txt"))
        elif fetched not in OK_FETCH or "soft 404" in cover.lower():
            rec.update(state="problem", kind="fetch", why=fetched or cover)
        elif canon_user and canon_google and _path(canon_user) != _path(canon_google):
            rec.update(state="problem", kind="duplicate", why="Google chose %s" % _path(canon_google))
        elif rich.get("verdict") == "FAIL":
            said = [i.get("issueMessage") or "" for d in rich.get("detectedItems") or []
                    for it in d.get("items") or [] for i in it.get("issues") or []
                    if i.get("severity") == "ERROR"]
            rec.update(kind="rich", why="; ".join(s for s in said if s)[:200])
            if not on:
                rec["state"] = "problem"
        elif not on and cover.lower().startswith("crawled"):
            since = (was or {}).get("since") or _iso(now)
            rec["since"] = since
            days = (now - (_when(since) or now)).days
            if days >= LEFT_OUT_DAYS:
                rec.update(state="problem", kind="left_out", why="read and left out for %d days" % days)
    elif not on and (now - SWITCH).days >= STUCK_DAYS:
        rec.update(state="problem", kind="stuck", why=cover or "never read")
    return rec


class Stop(Exception):
    """Google refused access or the day's quota is gone: stop asking today."""


def _inspect(url, token):
    r = requests.post(INSPECT, headers={"Authorization": "Bearer " + token},
                      json={"inspectionUrl": url, "siteUrl": PROPERTY, "languageCode": "en-US"}, timeout=TIMEOUT)
    if r.status_code in (401, 403, 429):
        raise Stop("Search Console said %d: %s" % (r.status_code, r.text[:200]))
    if r.status_code >= 300:
        raise ValueError("Search Console said %d about %s" % (r.status_code, url))
    return r.json().get("inspectionResult") or {}


def _token():
    return dg._gmail_access_token(SCOPE)


def read_google(urls, was, now, deadline):
    """Each page's record from Google, those looked at longest ago first, so a
    day cut short by the budget doesn't leave the same pages out every day.
    Returns (records, sitemaps with errors or None, error words, pages read).
    Any page not reached keeps yesterday's record. One page Google won't
    answer about is passed over and goes to the back of tomorrow's line, so it
    can't hold up the rest."""
    pages = {u: was[u] for u in urls if u in was}
    try:
        token = _token()
    except Exception as e:      # noqa: BLE001 -- the scope isn't on the delegation list yet
        return pages, None, "no access: %s" % str(e)[:160], 0
    order = sorted(urls, key=lambda u: (was.get(u) or {}).get("looked") or "")
    failed = []
    read = 0

    def one(url):
        if failed or time.monotonic() >= deadline:
            return url, None
        try:
            return url, _inspect(url, token)
        except Stop as e:
            failed.append(str(e)[:200])
            return url, None
        except Exception as e:  # noqa: BLE001 -- this page only
            print("searchwatch: not inspected:", url, e)
            return url, False
    with ThreadPoolExecutor(READERS) as ex:
        for url, result in ex.map(one, order):
            if result is False:
                pages[url] = dict(pages.get(url) or {"state": "waiting", "kind": None, "cover": "", "crawled": None,
                                                     "why": "", "since": None}, looked=_iso(now))
            elif result is not None:
                pages[url] = judge(result, was.get(url), now)
                read += 1
    errors = None
    try:
        r = requests.get(SITEMAPS, headers={"Authorization": "Bearer " + token}, timeout=TIMEOUT)
        if r.status_code < 300:
            # The old sitemap.xml only forwards now: what Google says of it is old news.
            errors = [s.get("path") for s in r.json().get("sitemap") or []
                      if int(s.get("errors") or 0) > 0 and not str(s.get("path")).endswith("/sitemap.xml")]
    except requests.RequestException as e:
        print("searchwatch: sitemaps not read:", e)
    return pages, errors, failed[0] if failed else "", read


# ---------------------------------------------------------------- what is wrong today

def problems_today(bad, pages, sitemap_error, google_sitemaps):
    """{kind: {url or sitemap: words}} from today's reads."""
    found = {}

    def add(kind, where, words):
        found.setdefault(kind, {})[where] = words
    for url, faults in bad.items():
        for kind, words in faults:
            add(kind, _path(url), words)
    if sitemap_error:
        add("sitemap", "/sitemap-index.xml", sitemap_error)
    for url, rec in pages.items():
        if rec.get("kind"):
            add(rec["kind"], _path(url), rec.get("why") or rec.get("cover") or "")
    for path in google_sitemaps or []:
        add("google_sitemap", _path(path), "has errors")
    return found


def _lines(places):
    keys = sorted(places)
    lines = ["- %s: %s" % (k, places[k]) for k in keys[:40]]
    if len(keys) > 40:
        lines.append("- and %d more" % (len(keys) - 40))
    return "\n".join(lines)


def _card_words(kind, places):
    k = KINDS[kind]
    n = len(places)
    title = "🔎 %s%s" % (k["title"], " (%d pages)" % n if n > 1 else "")
    notes = "Found by Job Hub's daily website check.\n\n%s\n\nWhat to do: %s\n\nA push to yd-website main is " \
            "live in about 7 minutes, so check the live address afterwards. Google can take days to read a page " \
            "again. This card closes itself once the problem is gone." % (_lines(places), k["fix"])
    return title, notes


def _boards(db):
    snap = db.collection("boards").document(BOARD).get()
    return (snap.to_dict() or {}) if snap.exists else None


def _column(board):
    cols = board.get("columns") or []
    for c in cols:
        if "website" in str(c.get("name") or "").lower():
            return c.get("id")
    return cols[0].get("id") if cols else ""


def _done_column(board):
    """The board's done column, else one named for it: the wish board was made
    before doneColumn was, and a card that can't close would never end."""
    import tidy
    done = tidy._done_col(board)
    if done:
        return done
    for c in board.get("columns") or []:
        if str(c.get("name") or "").strip().lower() in ("built", "done"):
            return c.get("id")
    return None


def _cards(db):
    return db.collection("boards").document(BOARD).collection("cards")


def settle(db, was, found, looked, now):
    """Yesterday's issues against today's: new cards, cards brought up to date,
    cards closed. looked(kind) says whether today's reads can speak for that
    kind: one that couldn't be looked at stands as it was. Returns the issues
    kept, and the kinds new today."""
    import receipts
    board = _boards(db)
    if board is None:
        print("searchwatch: no wishes board")
        return was, []
    done = _done_column(board)
    stamp = receipts._app_time()
    kept, fresh = {}, []
    for kind, old in was.items():
        if kind in found:
            continue
        if not looked(kind):
            kept[kind] = old
            continue
        if old.get("card"):
            try:
                ref = _cards(db).document(old["card"])
                snap = ref.get()
                k = (snap.to_dict() or {}) if snap.exists else None
                if k is not None and not k.get("doneAt"):
                    if not done:
                        kept[kind] = old        # nowhere to close it to: stands, rather than a second card later
                        continue
                    ref.update({"column": done, "doneAt": stamp, "updatedAt": stamp,
                                "updatedBy": "Job Hub (site check)",
                                "notes": (k.get("notes") or "") + "\n\nGone by itself on %s." % now.strftime("%d %b")})
            except Exception as e:      # noqa: BLE001
                print("searchwatch: card not closed:", old.get("card"), e)
                kept[kind] = old
    for kind, places in found.items():
        old = was.get(kind) or {}
        rec = {"first": old.get("first") or _iso(now), "last": _iso(now), "pages": sorted(places)[:80],
               "card": old.get("card"), "told": old.get("told"), "cardDone": False}
        title, notes = _card_words(kind, places)
        ref = _cards(db).document(rec["card"]) if rec["card"] else None
        snap = ref.get() if ref else None
        k = (snap.to_dict() or {}) if snap and snap.exists else None
        told = _when(rec["told"])
        if k is not None and not k.get("doneAt"):
            if rec["pages"] != sorted(old.get("pages") or []):
                ref.update({"title": title, "notes": notes, "updatedAt": stamp, "updatedBy": "Job Hub (site check)"})
        # A card closed after the fix went in: Google takes days to read a page
        # again, so its own problems get that long before a new card. The live
        # site answers today: still broken is still broken.
        elif not rec["card"] or not told or KINDS[kind].get("live") or (now - told).days >= RETELL_DAYS:
            cid = "gw%s%s" % (re.sub(r"[^a-z]", "", kind), now.strftime("%Y%m%d"))
            card = receipts._new_card(board, title, notes, column=_column(board),
                                      createdBy="Job Hub (site check)", updatedBy="Job Hub (site check)")
            _cards(db).document(cid).set(card)
            rec.update(card=cid, told=_iso(now))
            fresh.append(kind)
        else:
            rec["cardDone"] = True
        kept[kind] = rec
    return kept, fresh


def read_alert_mail(db, seen, now):
    """Google's own alerts, one open card per subject, since Google repeats
    them. Security and manual-action notices come only by email, so those are
    handed back to buzz. Mail from before the switch is about the old site."""
    import receipts
    board = _boards(db)
    if board is None:
        return seen, []
    try:
        ids = receipts._list_ids(MAIL_QUERY)
    except Exception as e:      # noqa: BLE001
        print("searchwatch: alert mail not read:", e)
        return seen, []
    urgent = []
    for mid in [i for i in ids if i not in seen]:
        try:
            m = receipts._fetch(mid)
        except Exception as e:  # noqa: BLE001
            print("searchwatch: alert not read:", mid, e)
            continue
        subject = m.get("subject") or ""
        seen = seen + [mid]
        if int(m.get("internalDate") or 0) < SWITCH.timestamp() * 1000:
            continue
        if not ALERT.search(subject) or NOT_ALERT.search(subject):
            continue
        ref = _cards(db).document("gm" + hashlib.sha1(subject.lower().encode("utf-8")).hexdigest()[:16])
        snap = ref.get()
        k = (snap.to_dict() or {}) if snap.exists else None
        if k is not None and not k.get("doneAt"):
            continue
        ref.set(receipts._new_card(
            board, "🔎 Google says: %s" % subject,
            "Email from Search Console, %s.\n\n%s\n\nGoogle often reports on what it last read, so first check the "
            "crawl date in URL Inspection. Before 5 Nov 2026 means the old Squarespace site: nothing to do, close "
            "this card and say so. Otherwise fix it. A push to yd-website main is live in about 7 minutes."
            % (now.strftime("%d %b"), re.sub(r"\s+", " ", m.get("text") or "")[:1500]),
            column=_column(board), createdBy="Job Hub (site check)", updatedBy="Job Hub (site check)"))
        if URGENT.search(subject):
            urgent.append(subject)
    return seen[-MAIL_KEPT:], urgent


# ---------------------------------------------------------------- the day's run

def _counts(urls, pages):
    states = [(pages.get(u) or {}).get("state") or "waiting" for u in urls]
    return {"pages": len(urls), "on": states.count("on"), "waiting": states.count("waiting"),
            "problems": states.count("problem")}


def check(db, now=None, budget=BUDGET_SECONDS):
    """The whole check, today's record written. Returns it, with `fresh`, the
    kinds of problem new today, and `urgent`, Google's alerts that can't wait."""
    now = now or _utc()
    deadline = time.monotonic() + budget
    ref = db.collection(STATE[0]).document(STATE[1])
    snap = ref.get()
    c = (snap.to_dict() or {}) if snap.exists else {}
    was_pages = {p.get("url"): p for p in c.get("pages") or [] if p.get("url")}
    known = [p for p in was_pages]
    issues = c.get("issues") or {}
    # The most pages the sitemap has listed: yesterday's shorter list would
    # hide a loss after one day. Someone closing the card accepts the new size.
    shrunk = (issues.get("sitemap") or {}).get("card")
    closed = shrunk and (_cards(db).document(shrunk).get().to_dict() or {}).get("doneAt")
    most = 0 if closed else int(c.get("most") or 0)
    sitemap_error, urls = "", []
    try:
        urls = sitemap_urls()
        if most and len(urls) < most * SHRINK:
            sitemap_error = "lists %d pages, was %d" % (len(urls), most)
        most = max(most, len(urls))
    except Exception as e:      # noqa: BLE001
        sitemap_error = "can't be read (%s)" % type(e).__name__
    # No sitemap to go by: yesterday's list of pages is still worth reading.
    urls = urls or known
    bad, read = read_site(urls, deadline - 60) if urls else ({}, 0)
    pages, google_sitemaps, google_error, google_read = (
        read_google(urls, was_pages, now, deadline) if urls else ({}, None, "", 0))
    found = problems_today(bad, pages, sitemap_error, google_sitemaps)

    def looked(kind):
        if kind == "sitemap":
            return True
        if KINDS.get(kind, {}).get("live"):
            return bool(urls) and read == len(urls)
        return google_sitemaps is not None if kind == "google_sitemap" else google_read > 0
    issues, fresh = settle(db, issues, found, looked, now)
    counts = _counts(urls, pages)
    day = now.strftime("%Y-%m-%d")
    history = [h for h in c.get("history") or [] if h.get("day") != day]
    history = (history + [dict(counts, day=day)])[-HISTORY_DAYS:]
    try:
        mail, urgent = read_alert_mail(db, c.get("mail") or [], now)
    except Exception as e:      # noqa: BLE001 -- the day's reads still get kept
        print("searchwatch: alert mail failed:", e)
        mail, urgent = c.get("mail") or [], []
    record = {"at": _iso(now), "site": {"read": read, "bad": len(bad)},
              "google": {"read": google_read, "error": google_error},
              "counts": counts, "history": history, "issues": issues, "most": most,
              "pages": [dict(pages[u], url=u) for u in urls if u in pages], "mail": mail}
    ref.set(record)
    return dict(record, fresh=fresh, urgent=urgent)


def _tell(people, title, body):
    sent = []
    for uid, u in people.items():
        if u.get("role") == "owner":
            try:
                sent.append({"uid": uid, "siteCheck": title, "phones": dg.send_push(
                    uid, {"push": {"title": title[:110], "body": body[:160]}}, tag="yd-site-check", ttl=20 * 3600,
                    opens="boards")})
            except Exception as e:  # noqa: BLE001
                print("searchwatch: push failed:", uid, e)
    return sent


def run(db, people, now=None):
    """Once a day after 7 am. A day that fails stays claimed: asking again
    every five minutes would spend Google's daily quota for nothing, and
    tomorrow's run reads everything anyway."""
    from google.api_core.exceptions import AlreadyExists
    now = now or dg._now()
    if now.hour < FROM_HOUR:
        return []
    claim = db.collection("reminderLog").document("searchwatch_" + now.strftime("%Y-%m-%d"))
    try:
        claim.create({"at": now.isoformat()})
    except AlreadyExists:
        return []
    r = check(db)
    sent = []
    live = [k for k in r["fresh"] if KINDS[k].get("live") and not KINDS[k].get("quiet")]
    if live:
        pages = (r["issues"].get(live[0]) or {}).get("pages") or []
        where = pages[0] if pages else ""
        more = len(pages) - 1 + sum(len((r["issues"].get(k) or {}).get("pages") or []) for k in live[1:])
        sent += _tell(people, "🔎 " + KINDS[live[0]]["title"],
                      "%s%s. It's on the wish board." % (where, " and %d more" % more if more > 0 else ""))
    for subject in r["urgent"]:
        sent += _tell(people, "🔎 Google alert about the website", subject + ". It's on the wish board.")
    return sent or [{"siteCheck": r["counts"]}]


def add_to_summary(slot, owner, sections, push_bits, db=None):
    """The owner's morning: where the site stands on Google, when that moved or
    something is open. Never stops the summary going."""
    if not owner or slot != "morning":
        return
    try:
        db = db or dg._db()
        snap = db.collection(STATE[0]).document(STATE[1]).get()
        c = (snap.to_dict() or {}) if snap.exists else {}
    except Exception as e:      # noqa: BLE001
        print("digest: site check not read:", e)
        return
    at = _when(c.get("at"))
    if not at or (_utc() - at).days >= 3:
        return
    counts = c.get("counts") or {}
    history = c.get("history") or []
    lines = []
    google = c.get("google") or {}
    if google.get("error") and not google.get("read") and not counts.get("on"):
        lines.append({"text": "⚠️ Job Hub can't see Google's indexing yet, so only the website itself is being "
                              "checked."})
    elif google.get("read") or counts.get("on"):
        before = history[-2].get("on") if len(history) > 1 else None
        moved = None if before is None else (counts.get("on") or 0) - before
        if moved or before is None:
            lines.append({"text": "%d of %d pages on Google%s" % (
                counts.get("on") or 0, counts.get("pages") or 0,
                " (%+d since yesterday)" % moved if moved else "")})
    for kind, rec in (c.get("issues") or {}).items():
        k = KINDS.get(kind)
        if k:
            n = len(rec.get("pages") or [])
            lines.append({"text": "🔧 %s%s: %s" % (k["title"], " (%d pages)" % n if n > 1 else "",
                                                  "fixed, waiting for Google to read it again" if rec.get("cardDone")
                                                  else "on the wish board")})
    if lines:
        sections.append(("Website on Google", lines))
