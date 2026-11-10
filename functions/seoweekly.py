"""The website's weekly report: what people searched to find it, where it
shows on Google, who came and what they did, and what to change next.

Jonah, 9 Nov 2026: "i want you tracking analytics for the website and using
them for us to continually increase the website. I want weekly reports on
keywords and stuff so we can constantly be improving SEO."

Every Monday after 7 am (the five-minute reminders run), plain code, no
Claude call:

  1. Search Console (read only, the same delegation as the daily site check):
     the searches the site showed for, clicks, views, place on Google, this
     week against last week, by search, by page, by kind of work and by town.
     A week is the latest seven days Google has finished counting (it runs
     two or three days behind), so the numbers never change after the report.
  2. Google Analytics, when its two switches are on (Analytics Data API in
     the Google Cloud project, the analytics.readonly scope on the
     delegation): visitors, where they came from, the pages they landed on,
     and the form sent and phone number tapped on each page (events the
     website sends since 9 Nov: generate_lead, click_to_call, click_email).
     Until then the report says so and everything else still comes.
  3. Job Hub's own count of the week's leads, and for each website form the
     page the visitor landed on and what brought them (siteForms, written by
     websiteleads.take).
  4. Up to IDEAS_MAX things to change, each worked out from the numbers:
     a search we're close to page 1 for, a page shown on page 1 but rarely
     clicked, a search slipping down. Each has "Have Claude do it" in Job Hub,
     which puts it on the wish board's Company Website column for the night
     run (idea_card). An idea he sent is not offered again for SENT_DAYS.

Kept in seoReports/{last day of the week} (the owner reads it in Media →
Website), emailed to him, and one push. settings/seoWeekly holds the list of
weeks, what was sent to Claude and the last error.

SMALL NUMBERS: a site this size gets a handful of clicks a week, so changes
are said as "3 → 5", never as a percentage, and an idea needs enough views
behind it (ALMOST_MIN, UNCLICKED_MIN) to be more than one person's search.
"""

import datetime
import hashlib
import re
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from html import escape

import requests

import digest as dg

SITE = "https://ydexteriorvisions.com"
SC_URL = "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aydexteriorvisions.com/searchAnalytics/query"
SC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
GA_SCOPE = "https://www.googleapis.com/auth/analytics.readonly"
GA_PROPERTY = "547983990"           # the site's Analytics property (tag G-1BRVC9EYS6); settings/seoWeekly.gaProperty wins
GA_URL = "https://analyticsdata.googleapis.com/v1beta/properties/%s:runReport"
GA_EVENTS = {"generate_lead": "forms sent", "click_to_call": "phone taps", "click_email": "email taps"}
STATE = ("settings", "seoWeekly")
REPORTS = "seoReports"
WEEKDAY = 0                          # Monday
FROM_HOUR = 7
TIMEOUT = 30
TRIES = 6                            # a Monday that keeps failing stops asking after this many tries
TRY_AGAIN_MIN = 60
WEEKS_KEPT = 104
QUERIES_SHOWN = 25
PAGES_SHOWN = 15
IDEAS_MAX = 5
ALMOST_MIN = 10                      # views in 4 weeks before a search is worth a change
UNCLICKED_MIN = 30
SLIP_MIN = 10                        # views each week before a slip counts
SLIP_BY = 3                          # places
SENT_DAYS = 56
# Share of views that click, about, at each place on page 1: under half of it
# is a page whose title and description don't answer the search.
EXPECTED_CTR = {1: .25, 2: .15, 3: .10, 4: .07, 5: .05}
EXPECTED_CTR_REST = .03

# Searches for the business itself: counted apart, never an idea.
BRAND = re.compile(r"\byd\b|\by\.?\s?d\.?\s+exterior|exterior visions?|yard dudes|ydexterior", re.I)
SERVICES = [
    ("Patios & walkways", r"patio|paver|flagstone|walkway|pathway|\bpaths?\b|hardscap"),
    ("Retaining walls", r"retaining|\bwalls?\b"),
    ("Landscaping", r"landscap|garden|\bbeds?\b|planting|shrubs?|\bplants?\b"),
    ("Edging", r"edging|\bedges?\b|border"),
    ("Mulch & rock", r"mulch|\brocks?\b"),
    ("Drainage", r"drain|downspout|grading|swale|standing water|wet yard|water in (my |the )?yard"),
    ("Artificial turf", r"turf|artificial grass|synthetic grass|fake grass|dog run|putting green"),
    ("Snow removal", r"snow|\bplow|de-?icing|\bsalting\b"),
    ("Lawn care", r"lawn|\bmow|aerat|overseed|fertili[sz]"),
    ("Cleanups", r"clean ?ups?|\bleaf\b|leaves"),
    ("Lighting", r"lighting|\blights?\b"),
    ("Gutters", r"gutter"),
    ("Fire pits", r"fire ?pits?"),
]
TOWNS = [
    ("Madison", r"madison"), ("Verona", r"verona"), ("Fitchburg", r"fitchburg"), ("Middleton", r"middleton"),
    ("Sun Prairie", r"sun prairie"), ("Waunakee", r"waunakee"), ("Oregon", r"\boregon\b"),
    ("McFarland", r"mc ?farland"), ("Monona", r"monona"), ("Mount Horeb", r"(mount|mt\.?) horeb"),
    ("Monticello", r"monticello"), ("Cottage Grove", r"cottage grove"), ("DeForest", r"de ?forest"),
    ("Stoughton", r"stoughton"), ("Cross Plains", r"cross plains"), ("New Glarus", r"new glarus"),
    ("Belleville", r"belleville"), ("Dane County", r"dane county"), ("“near me”", r"near me"),
]
SERVICES = [(n, re.compile(p, re.I)) for n, p in SERVICES]
TOWNS = [(n, re.compile(p, re.I)) for n, p in TOWNS]


class NoAccess(RuntimeError):
    """Google refused the read: a switch isn't on, not a fault of the day."""


def _day(d):
    return d.strftime("%Y-%m-%d")


def _date(s):
    return datetime.date.fromisoformat(s)


def _path(url):
    url = str(url or "")
    if url.startswith(SITE):
        url = url[len(SITE):]
    return url or "/"


def _short_day(s):
    d = _date(s)
    return "%s %d" % (d.strftime("%b"), d.day)


def week_words(start, end):
    a, b = _date(start), _date(end)
    if a.month == b.month:
        return "%s %d–%d" % (a.strftime("%b"), a.day, b.day)
    return "%s – %s" % (_short_day(start), _short_day(end))


# ---------------------------------------------------------------- Search Console

def _sc(token, start, end, dims, limit=1000):
    body = {"startDate": start, "endDate": end, "dimensions": dims, "rowLimit": limit, "type": "web"}
    r = requests.post(SC_URL, headers={"Authorization": "Bearer " + token}, json=body, timeout=TIMEOUT)
    if r.status_code in (401, 403):
        raise NoAccess("Search Console said %d: %s" % (r.status_code, r.text[:200]))
    if r.status_code >= 300:
        raise RuntimeError("Search Console said %d: %s" % (r.status_code, r.text[:200]))
    return r.json().get("rows") or []


def _row(r):
    return {"clicks": int(r.get("clicks") or 0), "impressions": int(r.get("impressions") or 0),
            "position": round(float(r.get("position") or 0), 1)}


def _totals(rows):
    if not rows:
        return {"clicks": 0, "impressions": 0, "position": None}
    t = _row(rows[0])
    if not t["impressions"]:
        t["position"] = None
    return t


def weeks(latest):
    """This week = the seven days ending on the latest finished day; last week
    the seven before; `earlier` the 28 days before this week (what makes a
    search new); `month` the 28 days ending with this week (ideas)."""
    end = _date(latest)
    return {"start": _day(end - datetime.timedelta(days=6)), "end": _day(end),
            "lastStart": _day(end - datetime.timedelta(days=13)), "lastEnd": _day(end - datetime.timedelta(days=7)),
            "earlierStart": _day(end - datetime.timedelta(days=34)),
            "monthStart": _day(end - datetime.timedelta(days=27))}


def latest_day(token, today):
    rows = _sc(token, _day(today - datetime.timedelta(days=12)), _day(today), ["date"], 50)
    days = sorted(r["keys"][0] for r in rows if r.get("keys"))
    return days[-1] if days else _day(today - datetime.timedelta(days=3))


def read_search(token, w):
    """Everything the report needs from Search Console, as plain lists."""
    def by(dims, start, end, limit=1000):
        return _sc(token, start, end, dims, limit)
    return {
        "total": _totals(by([], w["start"], w["end"])),
        "totalLast": _totals(by([], w["lastStart"], w["lastEnd"])),
        "queries": by(["query"], w["start"], w["end"]),
        "queriesLast": by(["query"], w["lastStart"], w["lastEnd"]),
        "queriesEarlier": by(["query"], w["earlierStart"], w["lastEnd"], 5000),
        "pages": by(["page"], w["start"], w["end"]),
        "pagesLast": by(["page"], w["lastStart"], w["lastEnd"]),
        "month": by(["query", "page"], w["monthStart"], w["end"], 5000),
    }


def _keyed(rows, i=0):
    return {r["keys"][i]: _row(r) for r in rows if r.get("keys")}


def _weighted(rows):
    """Clicks and views added up, the place weighted by views."""
    clicks = sum(r["clicks"] for r in rows)
    views = sum(r["impressions"] for r in rows)
    pos = round(sum(r["position"] * r["impressions"] for r in rows) / views, 1) if views else None
    return {"clicks": clicks, "impressions": views, "position": pos}


def groups(this, last, table):
    """{name: totals} for each kind of work or town that any search names."""
    out = []
    for name, rx in table:
        now = [r for q, r in this.items() if rx.search(q)]
        was = [r for q, r in last.items() if rx.search(q)]
        if not now and not was:
            continue
        t, l = _weighted(now), _weighted(was)
        out.append({"name": name, "clicks": t["clicks"], "impressions": t["impressions"], "position": t["position"],
                    "lastClicks": l["clicks"], "lastImpressions": l["impressions"], "lastPosition": l["position"],
                    "searches": len(now)})
    out.sort(key=lambda g: (-g["impressions"], -g["clicks"], g["name"]))
    return out


def _expected(pos):
    return EXPECTED_CTR.get(int(round(pos)), EXPECTED_CTR_REST)


def _idea_id(kind, *parts):
    return kind[:2] + hashlib.sha1("|".join([kind] + [str(p) for p in parts]).encode()).hexdigest()[:12]


def ideas(month_rows, this, last, sent, today, most=IDEAS_MAX):
    """What to change, best first: [{id, kind, title, why, page, queries, ...}].
    Plain rules on the numbers. A search for the business itself is never one.
    An idea sent to Claude in the last SENT_DAYS is left out."""
    pairs = [{"q": r["keys"][0], "page": _path(r["keys"][1]), **_row(r)}
             for r in month_rows if len(r.get("keys") or []) == 2 and not BRAND.search(r["keys"][0])]
    best = {}       # the page that shows most for each search
    for p in pairs:
        if p["q"] not in best or p["impressions"] > best[p["q"]]["impressions"]:
            best[p["q"]] = p
    found = []
    # Close to page 1 (or near the top of it): the classic easiest win.
    for q, p in best.items():
        if p["impressions"] >= ALMOST_MIN and 4.5 <= p["position"] <= 20:
            page2 = p["position"] > 10.5
            found.append({
                "id": _idea_id("almost", q, p["page"]), "kind": "almost",
                "title": ("Get “%s” onto page 1" if page2 else "Move “%s” up page 1") % q,
                "why": "Searched %d times in the last 4 weeks. We show about #%d%s, on %s. Work those words into "
                       "that page's title, top heading and a section that answers the search, and link to the page "
                       "from related pages." % (p["impressions"], round(p["position"]), " (page 2)" if page2 else "",
                                                p["page"]),
                "page": p["page"], "queries": [q], "impressions": p["impressions"], "clicks": p["clicks"],
                "position": p["position"], "score": p["impressions"] * (21 - p["position"]) / 10.0})
    # On page 1 but rarely clicked: the title and description, page by page.
    pages = {}
    for p in pairs:
        if p["position"] <= 10.5:
            pages.setdefault(p["page"], []).append(p)
    for page, rows in pages.items():
        views = sum(r["impressions"] for r in rows)
        clicks = sum(r["clicks"] for r in rows)
        want = sum(_expected(r["position"]) * r["impressions"] for r in rows)
        if views >= UNCLICKED_MIN and clicks < want / 2.0:
            top = [r["q"] for r in sorted(rows, key=lambda r: -r["impressions"])[:3]]
            found.append({
                "id": _idea_id("unclicked", page), "kind": "unclicked",
                "title": "More clicks from %s" % page,
                "why": "On page 1 of Google %d times in the last 4 weeks, for searches like %s, and clicked %d "
                       "time%s (a page there usually gets about %d). Rewrite its title and description so they answer "
                       "those searches in plain words." % (
                           views, ", ".join("“%s”" % q for q in top), clicks, "" if clicks == 1 else "s", round(want)),
                "page": page, "queries": top, "impressions": views, "clicks": clicks, "position": None,
                "score": (want - clicks) * 10.0})
    # Slipping down this week.
    for q, r in this.items():
        was = last.get(q)
        if BRAND.search(q) or not was or r["impressions"] < SLIP_MIN or was["impressions"] < SLIP_MIN:
            continue
        if r["position"] - was["position"] >= SLIP_BY:
            page = (best.get(q) or {}).get("page") or ""
            found.append({
                "id": _idea_id("slipping", q, today), "kind": "slipping",
                "title": "“%s” slipped from #%d to #%d" % (q, round(was["position"]), round(r["position"])),
                "why": "Searched %d times this week%s. Check what changed on the page, whether another business's "
                       "page passed it, and give the page something better to say about it." % (
                           r["impressions"], ", on " + page if page else ""),
                "page": page, "queries": [q], "impressions": r["impressions"], "clicks": r["clicks"],
                "position": r["position"], "score": r["impressions"] * (r["position"] - was["position"]) / 5.0})
    cutoff = today - datetime.timedelta(days=SENT_DAYS)
    keep = []
    for i in sorted(found, key=lambda i: -i["score"]):
        s = (sent or {}).get(i["id"]) or {}
        try:
            recent = s.get("at") and datetime.date.fromisoformat(str(s["at"])[:10]) >= cutoff
        except ValueError:
            recent = False
        if recent:
            continue
        # One idea per page a week: two changes to one page are one card's work.
        if i["page"] and any(k["page"] == i["page"] for k in keep):
            continue
        i.pop("score", None)
        keep.append(i)
        if len(keep) >= most:
            break
    return keep


def live_page(path):
    """The page an address lands on today. Google's four weeks still hold the
    Squarespace addresses (an old Yard Talk post's /yard-talk/xk406...), which
    redirect to their new pages: an idea must name the page to change. None
    when the address no longer leads to a page."""
    try:
        r = requests.head(SITE + path, allow_redirects=True, timeout=15,
                          headers={"User-Agent": "Mozilla/5.0 (compatible; YD-Job-Hub-site-check)"})
    except requests.RequestException as e:
        print("seoweekly: page not checked:", path, e)
        return path
    if r.status_code >= 400:
        return None
    return _path(r.url) if str(r.url).startswith(SITE) else path


def pages_today(found):
    """Each idea's page as it is today; an idea whose page is gone is dropped,
    and two that now land on one page keep the first (one idea a page)."""
    keep = []
    for i in found:
        if not i.get("page"):
            keep.append(i)
            continue
        now = live_page(i["page"])
        if now is None or any(k.get("page") == now for k in keep):
            continue
        if now != i["page"]:
            i["why"] = i["why"].replace(i["page"], now)
            i["title"] = i["title"].replace(i["page"], now)
            i["page"] = now
        keep.append(i)
    return keep


def search_part(raw, today, sent):
    """Search Console's rows made into the report's parts."""
    this, last, earlier = _keyed(raw["queries"]), _keyed(raw["queriesLast"]), _keyed(raw["queriesEarlier"])
    rows = []
    for q, r in this.items():
        l = last.get(q) or {}
        rows.append({"q": q, **r, "lastClicks": l.get("clicks", 0), "lastImpressions": l.get("impressions", 0),
                     "lastPosition": l.get("position"), "new": q not in earlier, "ours": bool(BRAND.search(q))})
    rows.sort(key=lambda r: (-r["clicks"], -r["impressions"], r["q"]))
    pages_now, pages_was = _keyed(raw["pages"]), _keyed(raw["pagesLast"])
    pages = []
    for url, r in pages_now.items():
        l = pages_was.get(url) or {}
        pages.append({"page": _path(url), **r, "lastClicks": l.get("clicks", 0),
                      "lastImpressions": l.get("impressions", 0), "lastPosition": l.get("position")})
    pages.sort(key=lambda r: (-r["clicks"], -r["impressions"], r["page"]))
    ours = _weighted([r for q, r in this.items() if BRAND.search(q)])
    ours_last = _weighted([r for q, r in last.items() if BRAND.search(q)])
    return {
        "total": raw["total"], "totalLast": raw["totalLast"],
        "ours": {"clicks": ours["clicks"], "impressions": ours["impressions"],
                 "lastClicks": ours_last["clicks"], "lastImpressions": ours_last["impressions"]},
        "searchCount": len(this), "searchCountLast": len(last),
        "queries": rows[:QUERIES_SHOWN],
        "newQueries": [r for r in sorted(rows, key=lambda r: -r["impressions"]) if r["new"] and not r["ours"]][:10],
        "pages": pages[:PAGES_SHOWN],
        "services": groups(this, last, SERVICES),
        "towns": groups(this, last, TOWNS),
        # Twice as many looked at: an idea whose page is gone drops out.
        "ideas": pages_today(ideas(raw["month"], this, last, sent, today, IDEAS_MAX * 2))[:IDEAS_MAX],
    }


# ---------------------------------------------------------------- Google Analytics

def _ga(token, prop, body):
    r = requests.post(GA_URL % prop, headers={"Authorization": "Bearer " + token}, json=body, timeout=TIMEOUT)
    if r.status_code in (401, 403):
        raise NoAccess("Google Analytics said %d: %s" % (r.status_code, r.text[:200]))
    if r.status_code >= 300:
        raise RuntimeError("Google Analytics said %d: %s" % (r.status_code, r.text[:200]))
    out = []
    for row in r.json().get("rows") or []:
        out.append({"d": [x.get("value") for x in row.get("dimensionValues") or []],
                    "m": [_num(x.get("value")) for x in row.get("metricValues") or []]})
    return out


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0
    return int(f) if f == int(f) else round(f, 2)


def read_analytics(token, prop, w):
    rng = [{"startDate": w["start"], "endDate": w["end"]}]
    both = rng + [{"startDate": w["lastStart"], "endDate": w["lastEnd"], "name": "last"}]
    totals = _ga(token, prop, {"dateRanges": [dict(rng[0], name="this"), both[1]],
                               "metrics": [{"name": "activeUsers"}, {"name": "sessions"}, {"name": "screenPageViews"}]})
    t = {"this": [0, 0, 0], "last": [0, 0, 0]}
    for row in totals:
        # Two date ranges: Google adds the range's name as the first dimension.
        which = row["d"][0] if row["d"] else "this"
        if which in t:
            t[which] = (row["m"] + [0, 0, 0])[:3]
    channels = _ga(token, prop, {"dateRanges": rng, "dimensions": [{"name": "sessionDefaultChannelGroup"}],
                                 "metrics": [{"name": "sessions"}],
                                 "orderBys": [{"metric": {"metricName": "sessions"}, "desc": True}], "limit": 10})
    landing = _ga(token, prop, {"dateRanges": rng, "dimensions": [{"name": "landingPage"}],
                                "metrics": [{"name": "sessions"}],
                                "orderBys": [{"metric": {"metricName": "sessions"}, "desc": True}], "limit": 10})
    events = _ga(token, prop, {"dateRanges": rng, "dimensions": [{"name": "eventName"}, {"name": "pagePath"}],
                               "metrics": [{"name": "eventCount"}],
                               "dimensionFilter": {"filter": {"fieldName": "eventName", "inListFilter": {
                                   "values": list(GA_EVENTS)}}}, "limit": 100})
    acts = {k: {"count": 0, "pages": {}} for k in GA_EVENTS}
    for row in events:
        name, page = (row["d"] + ["", ""])[:2]
        if name in acts:
            n = row["m"][0] if row["m"] else 0
            acts[name]["count"] += n
            acts[name]["pages"][page or "/"] = acts[name]["pages"].get(page or "/", 0) + n
    return {
        "visitors": t["this"][0], "visits": t["this"][1], "views": t["this"][2],
        "lastVisitors": t["last"][0], "lastVisits": t["last"][1], "lastViews": t["last"][2],
        "channels": [{"name": r["d"][0] if r["d"] else "", "visits": r["m"][0] if r["m"] else 0} for r in channels],
        "landing": [{"page": (r["d"][0] if r["d"] else "") or "/", "visits": r["m"][0] if r["m"] else 0}
                    for r in landing if (r["d"] or [""])[0] != "(not set)"],
        "actions": [{"event": k, "words": GA_EVENTS[k], "count": v["count"],
                     "pages": sorted(({"page": p, "count": n} for p, n in v["pages"].items()),
                                     key=lambda x: -x["count"])[:5]} for k, v in acts.items()],
    }


# ---------------------------------------------------------------- Job Hub's own count

def _chicago_day(iso):
    try:
        t = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return ""
    if t.tzinfo is None:
        t = t.replace(tzinfo=datetime.timezone.utc)
    return t.astimezone(dg.TZ).strftime("%Y-%m-%d")


def read_leads(db, w):
    """The week's new leads by where they came from, and each website form's
    landing page and what brought the visitor (siteForms, from 9 Nov)."""
    counts = {}
    for source in ("website", "google"):
        n = 0
        for d in db.collection("customers").where("source", "==", source).stream():
            day = _chicago_day((d.to_dict() or {}).get("addedAt"))
            if w["start"] <= day <= w["end"]:
                n += 1
        counts[source] = n
    forms = []
    for d in db.collection("siteForms").where("day", ">=", w["start"]).stream():
        f = d.to_dict() or {}
        if str(f.get("day") or "") <= w["end"]:
            forms.append({"day": f.get("day"), "landing": f.get("landing") or "", "source": f.get("source") or "",
                          "campaign": f.get("campaign") or "", "known": bool(f.get("known"))})
    forms.sort(key=lambda f: f["day"] or "")
    return {"website": counts["website"], "google": counts["google"], "forms": forms}


# ---------------------------------------------------------------- the whole report

def build(db, now=None):
    """This week's report, worked out and saved. Raises when Search Console
    can't be read at all (nothing to report on); Analytics or the lead count
    failing leaves that part saying why."""
    now = now or dg._now()
    today = now.date()
    ref = db.collection(STATE[0]).document(STATE[1])
    state = ref.get().to_dict() or {}
    token = dg._gmail_access_token(SC_SCOPE)
    latest = latest_day(token, today)
    w = weeks(latest)
    rep = {"at": now.isoformat(), "week": {"start": w["start"], "end": w["end"]},
           "last": {"start": w["lastStart"], "end": w["lastEnd"]}, "words": week_words(w["start"], w["end"])}
    rep.update(search_part(read_search(token, w), today, state.get("sent") or {}))
    prop = str(state.get("gaProperty") or GA_PROPERTY)
    try:
        rep["analytics"] = read_analytics(dg._gmail_access_token(GA_SCOPE), prop, w)
    except NoAccess as e:
        rep["analytics"] = {"off": True, "error": str(e)[:300]}
    except Exception as e:      # noqa: BLE001 -- not hooked up yet, or Google down: the rest still comes
        off = "unauthorized_client" in str(e) or "access_denied" in str(e)
        rep["analytics"] = {"off": off, "error": str(e)[:300]}
    try:
        rep["leads"] = read_leads(db, w)
    except Exception as e:      # noqa: BLE001
        print("seoweekly: leads not counted:", e)
        rep["leads"] = {"error": str(e)[:200]}
    try:
        watch = db.collection("settings").document("searchWatch").get().to_dict() or {}
        rep["index"] = watch.get("counts") or {}
    except Exception as e:      # noqa: BLE001
        print("seoweekly: index counts not read:", e)
        rep["index"] = {}
    db.collection(REPORTS).document(w["end"]).set(rep)
    have = [x for x in state.get("weeks") or [] if x != w["end"]]
    ref.set({"weeks": ([w["end"]] + have)[:WEEKS_KEPT], "last": w["end"], "at": now.isoformat(), "error": None},
            merge=True)
    return rep


def _change(now, was):
    if was is None:
        return ""
    if now == was:
        return "same as last week"
    return "%s last week" % was


def headline(rep):
    t, l = rep.get("total") or {}, rep.get("totalLast") or {}
    leads = rep.get("leads") or {}
    bits = ["%d click%s from Google (%s)" % (t.get("clicks", 0), "" if t.get("clicks") == 1 else "s",
                                            _change(t.get("clicks", 0), l.get("clicks"))),
            "%d views" % t.get("impressions", 0)]
    if "website" in leads:
        bits.append("%d website lead%s" % (leads["website"], "" if leads["website"] == 1 else "s"))
    return ", ".join(bits)


# ---------------------------------------------------------------- the email

_TD = "padding:5px 8px;border-bottom:1px solid #eee;vertical-align:top;font-size:13px"
_TH = "padding:5px 8px;text-align:left;font-size:11px;color:#7b7188;text-transform:uppercase;letter-spacing:.4px"


def _arrow(now, was, lower_better=False):
    if was is None or now is None or now == was:
        return ""
    up = now > was
    good = (not up) if lower_better else up
    return ' <span style="color:%s">%s</span>' % ("#2f8f5b" if good else "#b3412e", "▲" if up else "▼")


def _pos(p):
    return "—" if p is None else "#%d" % round(p)


def _table(head, rows):
    return ('<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%%;margin:4px 0 14px">'
            '<tr style="background:#f4f1f8">%s</tr>%s</table>') % (
        "".join('<th style="%s">%s</th>' % (_TH, h) for h in head),
        "".join("<tr>%s</tr>" % "".join('<td style="%s">%s</td>' % (_TD, c) for c in r) for r in rows))


def to_html(rep):
    t, l = rep.get("total") or {}, rep.get("totalLast") or {}
    out = ['<div style="font-family:Arial,Helvetica,sans-serif;color:#2b2233;max-width:720px">',
           '<h2 style="color:#66418f;margin:0 0 4px">Website report</h2>',
           '<div style="color:#7b7188;margin-bottom:12px">Google search, %s (last week %s)</div>' % (
               escape(rep.get("words") or ""), escape(week_words(rep["last"]["start"], rep["last"]["end"])))]
    out.append(_table(["", "This week", "Last week"], [
        ["Clicks from Google", "<b>%d</b>%s" % (t.get("clicks", 0), _arrow(t.get("clicks"), l.get("clicks"))),
         str(l.get("clicks", 0))],
        ["Times shown on Google", "%d%s" % (t.get("impressions", 0), _arrow(t.get("impressions"), l.get("impressions"))),
         str(l.get("impressions", 0))],
        ["Average place", _pos(t.get("position")) + _arrow(t.get("position"), l.get("position"), True),
         _pos(l.get("position"))],
        ["Searches we showed for", str(rep.get("searchCount", 0)), str(rep.get("searchCountLast", 0))],
    ]))
    ideas_ = rep.get("ideas") or []
    if ideas_:
        out.append('<h3 style="color:#66418f;margin:14px 0 6px">What to change next</h3><ol style="padding-left:20px">')
        for i in ideas_:
            out.append('<li style="margin-bottom:8px"><b>%s</b><br><span style="color:#5a5163">%s</span></li>' % (
                escape(i["title"]), escape(i["why"])))
        out.append('</ol><div style="color:#7b7188;font-size:12px">Open Job Hub → Media → Website and press Have '
                   'Claude do it on any of these.</div>')
    leads = rep.get("leads") or {}
    if "website" in leads:
        out.append('<h3 style="color:#66418f;margin:16px 0 6px">Leads this week</h3>')
        lines = ["%d from the website form" % leads["website"], "%d from Google Ads requests" % leads["google"]]
        out.append("<div>%s</div>" % "<br>".join(escape(x) for x in lines))
        if leads.get("forms"):
            out.append(_table(["Day", "Landed on", "Came from"], [
                [escape(_short_day(f["day"])) if f.get("day") else "", escape(f["landing"] or "—"),
                 escape(f["source"] or "—")] for f in leads["forms"]]))
    q = rep.get("queries") or []
    if q:
        out.append('<h3 style="color:#66418f;margin:16px 0 6px">Searches that found us</h3>')
        out.append(_table(["Search", "Clicks", "Shown", "Place"], [
            [escape(r["q"]) + (' <span style="color:#2f8f5b;font-size:11px">NEW</span>' if r.get("new") else "") +
             (' <span style="color:#7b7188;font-size:11px">our name</span>' if r.get("ours") else ""),
             "%d%s" % (r["clicks"], _arrow(r["clicks"], r.get("lastClicks"))),
             "%d%s" % (r["impressions"], _arrow(r["impressions"], r.get("lastImpressions"))),
             _pos(r["position"]) + _arrow(r["position"], r.get("lastPosition"), True)] for r in q[:15]]))
    for title, key in (("Kinds of work people searched", "services"), ("Towns people searched", "towns")):
        g = rep.get(key) or []
        if g:
            out.append('<h3 style="color:#66418f;margin:16px 0 6px">%s</h3>' % title)
            out.append(_table(["", "Clicks", "Shown", "Place"], [
                [escape(x["name"]), "%d%s" % (x["clicks"], _arrow(x["clicks"], x["lastClicks"])),
                 "%d%s" % (x["impressions"], _arrow(x["impressions"], x["lastImpressions"])),
                 _pos(x["position"])] for x in g[:12]]))
    p = rep.get("pages") or []
    if p:
        out.append('<h3 style="color:#66418f;margin:16px 0 6px">Pages Google sent people to</h3>')
        out.append(_table(["Page", "Clicks", "Shown", "Place"], [
            [escape(r["page"]), "%d%s" % (r["clicks"], _arrow(r["clicks"], r.get("lastClicks"))),
             str(r["impressions"]), _pos(r["position"])] for r in p[:10]]))
    a = rep.get("analytics") or {}
    out.append('<h3 style="color:#66418f;margin:16px 0 6px">Visitors (Google Analytics)</h3>')
    if a.get("error"):
        out.append('<div style="color:#7b7188">%s</div>' % escape(
            "Not hooked up yet: it's on your to-do list." if a.get("off") else "Couldn't be read this week."))
    else:
        out.append(_table(["", "This week", "Last week"], [
            ["People", "%d%s" % (a["visitors"], _arrow(a["visitors"], a["lastVisitors"])), str(a["lastVisitors"])],
            ["Visits", str(a["visits"]), str(a["lastVisits"])],
            ["Pages viewed", str(a["views"]), str(a["lastViews"])],
        ] + [[escape(x["words"].capitalize()), str(x["count"]), ""] for x in a.get("actions") or []]))
        if a.get("channels"):
            out.append("<div>Came from: %s</div>" % escape(", ".join(
                "%s %d" % (c["name"], c["visits"]) for c in a["channels"])))
    ix = rep.get("index") or {}
    if ix.get("pages"):
        out.append('<div style="margin-top:14px;color:#5a5163">%d of %d pages are on Google.</div>' % (
            ix.get("on", 0), ix.get("pages", 0)))
    out.append('<div style="margin-top:16px"><a href="%s#website" style="color:#66418f">Open it in Job Hub</a></div>'
               '</div>' % dg._app_url())
    return "".join(out)


def to_text(rep):
    t = rep.get("total") or {}
    lines = ["Website report — Google search, %s" % rep.get("words"), "", headline(rep) + ".",
             "Average place %s." % _pos(t.get("position")), ""]
    for n, i in enumerate(rep.get("ideas") or [], 1):
        lines += ["%d. %s" % (n, i["title"]), "   " + i["why"]]
    lines += ["", "Searches that found us:"]
    for r in (rep.get("queries") or [])[:15]:
        lines.append("  %s: %d clicks, shown %d, %s" % (r["q"], r["clicks"], r["impressions"], _pos(r["position"])))
    lines += ["", "Open it in Job Hub: %s#website" % dg._app_url()]
    return "\n".join(lines)


def send_email(rep):
    msg = MIMEMultipart("alternative")
    msg["To"] = dg.OWNER_EMAIL
    msg["From"] = "YD Job Hub <%s>" % dg.OWNER_EMAIL
    msg["Subject"] = "📈 Website report, %s: %s" % (rep.get("words"), headline(rep))
    msg.attach(MIMEText(to_text(rep), "plain", "utf-8"))
    msg.attach(MIMEText(to_html(rep), "html", "utf-8"))
    import base64
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    r = requests.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
                      headers={"Authorization": "Bearer " + dg._gmail_access_token()}, json={"raw": raw},
                      timeout=TIMEOUT)
    if r.status_code >= 300:
        raise RuntimeError("Gmail said %d: %s" % (r.status_code, r.text[:300]))


def tell(people, rep):
    n = len(rep.get("ideas") or [])
    body = headline(rep) + "." + (" %d thing%s to change." % (n, "" if n == 1 else "s") if n else "")
    sent = []
    for uid, u in people.items():
        if u.get("role") == "owner":
            try:
                sent.append({"uid": uid, "seoWeekly": rep["week"]["end"], "phones": dg.send_push(
                    uid, {"push": {"title": "📈 Website report, " + rep.get("words", ""), "body": body}},
                    tag="yd-seo-weekly", ttl=48 * 3600, opens="website")})
            except Exception as e:  # noqa: BLE001
                print("seoweekly: push failed:", uid, e)
    return sent


def run(db, people, now=None):
    """Mondays after 7 am. A Monday that fails (Google down) tries again an
    hour later, up to TRIES times; a week already sent is never sent twice."""
    now = now or dg._now()
    if now.weekday() != WEEKDAY or now.hour < FROM_HOUR:
        return []
    from google.cloud import firestore as fs
    claim = db.collection("reminderLog").document("seoweekly_" + now.strftime("%Y-%m-%d"))

    @fs.transactional
    def take(tx):
        snap = claim.get(transaction=tx)
        c = (snap.to_dict() or {}) if snap.exists else {}
        if c.get("done") or int(c.get("tries") or 0) >= TRIES:
            return False
        last = c.get("tryAt")
        if last:
            try:
                if now - datetime.datetime.fromisoformat(last) < datetime.timedelta(minutes=TRY_AGAIN_MIN):
                    return False
            except ValueError:
                pass
        tx.set(claim, {"tryAt": now.isoformat(), "tries": int(c.get("tries") or 0) + 1}, merge=True)
        return True
    if not take(db.transaction()):
        return []
    try:
        rep = build(db, now)
    except Exception as e:      # noqa: BLE001 -- told on the screen; tried again in an hour
        print("seoweekly: report failed:", e)
        claim.set({"error": str(e)[:300]}, merge=True)
        db.collection(STATE[0]).document(STATE[1]).set({"error": str(e)[:300], "errorAt": now.isoformat()},
                                                        merge=True)
        return []
    emailed = True
    try:
        send_email(rep)
    except Exception as e:      # noqa: BLE001 -- it's in Job Hub either way
        emailed = False
        print("seoweekly: email failed:", e)
    claim.set({"done": True, "week": rep["week"]["end"], "emailed": emailed}, merge=True)
    return tell(people, rep) or [{"seoWeekly": rep["week"]["end"]}]


# ---------------------------------------------------------------- Have Claude do it

def idea_card(db, week, idea_id, by):
    """The idea put on the wish board's Company Website column for the night
    run, once. Returns {card} or {error}."""
    rep = db.collection(REPORTS).document(str(week)).get().to_dict() or {}
    idea = next((i for i in rep.get("ideas") or [] if i.get("id") == idea_id), None)
    if not idea:
        return {"error": "That idea isn't in that week's report."}
    ref = db.collection(STATE[0]).document(STATE[1])
    sent = (ref.get().to_dict() or {}).get("sent") or {}
    cid = "sw" + idea_id
    cards = db.collection("boards").document("wishes").collection("cards")
    if (sent.get(idea_id) or {}).get("card") and cards.document(cid).get().exists:
        return {"card": cid, "already": True}
    import receipts
    import searchwatch
    board = db.collection("boards").document("wishes").get().to_dict() or {}
    day = dg._now().strftime("%a %d %b")
    notes = "\n".join([
        idea["why"],
        "",
        "Page: %s%s" % (SITE, idea.get("page") or ""),
        "Searches: " + ", ".join(idea.get("queries") or []),
        "Numbers (Google, 4 weeks to %s): shown %d, clicked %d%s." % (
            _short_day(rep["week"]["end"]), idea.get("impressions") or 0, idea.get("clicks") or 0,
            ", about #%d" % round(idea["position"]) if idea.get("position") else ""),
        "",
        "From the weekly website report for %s. Jonah pressed Have Claude do it on %s." % (rep.get("words"), day),
        "Make the change in yd-website in the site's own voice: never pad a page out, nothing we can't back up "
        "(no \"licensed\", no stock photos as our work). Check it at phone, tablet and laptop sizes, and write "
        "on this card what changed and the preview link. The next weekly reports show whether it moved.",
    ])
    card = receipts._new_card(board, "🔎 " + idea["title"], notes, column=searchwatch._column(board),
                              createdBy="Job Hub (website report)", updatedBy="Job Hub (website report)")
    cards.document(cid).set(card)
    ref.set({"sent": {idea_id: {"at": dg._now().isoformat(), "card": cid, "week": str(week), "by": by}}}, merge=True)
    return {"card": cid}
