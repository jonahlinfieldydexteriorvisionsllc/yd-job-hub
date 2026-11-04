"""Season outreach: personal emails to past customers, in his Drafts.

Jonah (26 Oct 2026, routine 4 of 14; his answers 3 Nov): each Monday in an
outreach window Claude writes a personal email for the next people due, and
it lands in Gmail Drafts with "Draft ready" on the call list. "yes drafts
only" -- nothing here sends anything. "i want you to view any edits i make
to the drafts at the end of each month so you can learn from your mistakes."
Snow renewals are left out for now: "it will depend per client if i intend
to raise their price ... not worrying about sending snow renewals before snow
season has even started." So the only window is spring, and a customer who
has only ever bought snow work is passed over.

WHO, each Monday in the window, up to perWeek: first the Call list (their
time to call has come), then past customers worked for in the last two
years, newest first. Never someone with an email address missing, marked not
interested, reached since the window opened, in the middle of a bid or a job,
or already drafted this window, nor anyone he has written to in the last
RECENT_DAYS. Someone with no time to call gets the window as their time, so
they show on the Call list with their draft.

LEARNING, on the 1st of each month: every draft still open is looked for in
his Sent mail. Sent word for word, or nearly, it is only counted. Changed,
the two go to Claude together and the lessons join settings/voice.lessons,
which he reads and changes under All settings -> How you write, and which
every email Claude writes as him follows (voice.block). A draft not sent in
30 days is counted as not sent.

settings/seasonMail: {on, perWeek, windows, learned}. All optional: absent
means on, PER_WEEK, WINDOWS. customers/{id}.seasonDraft: {key, at, link, to,
subject, body, open, outcome, sentAt}.
"""

import datetime
import difflib
import json
import re
import time

import cards
import digest as dg
import inboxdesk
import outreach
import quickbooks as qb
import receipts
import spend
import voice

MODEL = "claude-sonnet-5-5"
SETTINGS = ("settings", "seasonMail")
WINDOWS = [{"name": "spring", "from": "02-01", "to": "04-30"}]
PER_WEEK = 25
PAST_DAYS = 2 * 365          # "past customer": worked for within this long
RECENT_DAYS = 30             # he wrote to them this lately: leave it to him
BID_DAYS = 120               # a bid this fresh is still being talked about
UNSENT_DAYS = 30             # a draft this old and not sent is counted as not sent
HISTORY_INVOICES = 12
SAME_RATIO = 0.985           # sent this close to the draft: not edited
SAME_EMAIL = 0.35            # less like the draft than this: some other email
MAX_PAIRS = 15               # edited drafts read in one month
MAX_LESSON_LINES = 40

NOT_WORK = re.compile(r"terms|warranty|lien|notice|\bfee\b|discount|deposit|down payment|tax|change order", re.I)
SNOW_WORK = re.compile(r"snow|salt|plow|\bice\b", re.I)
# Things no email says, whatever comes back (the same list as the follow-ups).
NEVER_SAID = re.compile(r"licensed|subcontract|pressure.?wash|\$\s?\d|\bsmall (business|company|crew)\b|family.?(run|owned)", re.I)

SYSTEM = """You write one short, personal email from Jonah at YD Exterior Visions, a landscaping and hardscaping \
company near Madison, Wisconsin, to a past customer, for the season named in the message. It goes in his Gmail Drafts; \
he reads it, changes it if he wants and sends it himself. It should read like he typed it.

Open with "Hi <their first name>,". 40 to 90 words. Say in plain words what we did for them, then one thing worth doing \
this season that fits what they have, then end on one simple question. Pick one thing. Never list everything we sell.

What to suggest, by what they had done:
- mulch or rock beds: a fresh top-up or a bed cleanup
- new plants, trees or garden beds: a spring look at how they came through the winter
- patios, walks, walls or edging: a look at how it came through the winter, or adding to it
- lawn care: getting the season started
- cleanups: a spring cleanup
- nothing known: a spring cleanup, or ask what they have in mind for the yard

Never give a price, a discount, a deadline or a date we'd have to keep. Never invent anything about their property: use \
only the facts in the message. Never mention snow. Never say licensed, subcontractors, small, family-run or owner, and \
never mention pressure washing. No sign-off and no name at the end: his Gmail signature is added for you. The subject is \
short and plain, like a note to someone he knows, never a sales line."""

SCHEMA = {
    "type": "object",
    "properties": {"subject": {"type": "string"}, "body": {"type": "string"}},
    "required": ["subject", "body"],
    "additionalProperties": False,
}

LESSONS_SYSTEM = """Jonah owns a landscaping company. Each pair below is an email Claude drafted in his name and the \
email he really sent after changing it. Work out what he keeps changing. Give up to 8 short, plain instructions for \
writing the next ones, each about how he wants emails written: words he swaps, length, tone, what he takes out, what he \
adds. Only what shows up in these emails, and leave out anything true of one customer only. No customer names, addresses \
or prices in the lessons. If the changes show nothing general, give none."""

LESSONS_SCHEMA = {
    "type": "object",
    "properties": {"lessons": {"type": "array", "items": {"type": "string"}}},
    "required": ["lessons"],
    "additionalProperties": False,
}


def conf(db):
    snap = db.collection(SETTINGS[0]).document(SETTINGS[1]).get()
    d = (snap.to_dict() or {}) if snap.exists else {}
    per = d.get("perWeek")
    return {"on": d.get("on") is not False,
            "perWeek": per if isinstance(per, int) and 0 < per <= 60 else PER_WEEK,
            "windows": d.get("windows") if isinstance(d.get("windows"), list) and d.get("windows") else WINDOWS}


def window_now(cfg, today):
    """The outreach window today is in: {name, key, from, to} with whole
    dates, or None. A key like 2027-spring: one draft a person a window."""
    md = today.strftime("%m-%d")
    for w in cfg["windows"]:
        if str(w.get("from")) <= md <= str(w.get("to")):
            return {"name": str(w.get("name") or "season"), "key": "%d-%s" % (today.year, w.get("name") or "season"),
                    "from": "%d-%s" % (today.year, w["from"]), "to": "%d-%s" % (today.year, w["to"])}
    return None


def _busy_customers(db, today):
    """Customers in the middle of something: a job booked or going, or a bid
    still being talked about. A season email would talk over it."""
    busy = set()
    for s in db.collection("jobs").stream():
        j = s.to_dict() or {}
        cid = str(j.get("customerId") or "")
        if not cid or j.get("removeWhy") or j.get("deletedAt"):
            continue
        status = str(j.get("status") or "").lower().replace(" ", "")
        if status in ("booked", "inprogress"):
            busy.add(cid)
        elif status in ("", "quoting") and j.get("bidStage") != "lost":
            day = str(j.get("quoteDate") or "")[:10]
            if day and day >= (today - datetime.timedelta(days=BID_DAYS)).isoformat():
                busy.add(cid)
    return busy


def _good_email(c):
    to = str(c.get("email") or "").split(",")[0].strip()
    return to if cards.EMAIL_RE.match(to) else ""


def who(db, today, w, room):
    """Who is next: up to `room` (customer id, record, email), the call list
    first, then past customers newest first."""
    docs = {}
    for s in db.collection("customers").stream():
        c = s.to_dict() or {}
        if not c.get("mergedInto"):
            docs[s.id] = c
    busy = _busy_customers(db, today)
    since = (today - datetime.timedelta(days=PAST_DAYS)).isoformat()

    def open_to_us(cid, c):
        if outreach._shown_as_other(cid, docs) or c.get("notInterested") or cid in busy:
            return False
        if (c.get("seasonDraft") or {}).get("key") == w["key"]:
            return False
        return bool(_good_email(c)) and str(c.get("reachedAt") or "")[:10] < w["from"]

    due, past = [], []
    for cid, c in docs.items():
        if not open_to_us(cid, c):
            continue
        state, _ = outreach.call_state(c, today)
        if state == "on":
            due.append((cid, c))
        elif state is None and str(c.get("lastWorkAt") or "")[:10] >= since:
            past.append((cid, c))
    past.sort(key=lambda x: str(x[1].get("lastWorkAt") or ""), reverse=True)
    return [(cid, c, _good_email(c)) for cid, c in (due + past)[:room * 3]]


def history(c):
    """What they have had done: ([(year, what)], only snow?), from their
    QuickBooks invoices, the newest first. One small question per person."""
    qid = str(c.get("qbCustomerId") or "")
    if not re.fullmatch(r"\d+", qid):
        return [], False
    rows = qb._query("Invoice", "CustomerRef = '%s' ORDERBY TxnDate DESC MAXRESULTS %d" % (qid, HISTORY_INVOICES))
    seen, out = set(), []
    for inv in rows:
        year = str(inv.get("TxnDate") or "")[:4]
        for ln in inv.get("Line") or []:
            ref = ((ln.get("SalesItemLineDetail") or {}).get("ItemRef") or {}).get("name") or ""
            what = str(ref).split(":")[-1].strip()
            if not what or NOT_WORK.search(what) or what.lower() in seen:
                continue
            seen.add(what.lower())
            out.append((year, what))
    return out[:8], bool(out) and all(SNOW_WORK.search(w) for _, w in out)


def _facts(c, past, w):
    first = str(c.get("firstName") or "").strip() or str(c.get("name") or "").split(" ")[0]
    lines = ["Season: " + w["name"], "Their first name: " + first]
    if c.get("city"):
        lines.append("Town: " + str(c["city"]))
    if past:
        lines.append("What we have done for them, newest first:")
        lines += ["- %s (%s)" % (what, year) for year, what in past]
    if c.get("tags"):
        lines.append("Tagged as interested in: " + ", ".join(str(t) for t in c["tags"][:5]))
    return "\n".join(lines)


def write_one(client, c, past, w):
    """Claude writes it: ({subject, body} or {error}, usage)."""
    resp = client.beta.messages.create(
        model=MODEL, max_tokens=1500, system=SYSTEM + voice.block(also="This is a short personal note to a past customer."),
        messages=[{"role": "user", "content": _facts(c, past, w)}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    )
    if resp.stop_reason == "refusal":
        return {"error": "refused"}, resp.usage
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        got = json.loads(text)
    except ValueError:
        return {"error": "unreadable"}, resp.usage
    subject, body = str(got.get("subject") or "").strip(), str(got.get("body") or "").strip()
    if not subject or not body:
        return {"error": "empty"}, resp.usage
    if NEVER_SAID.search(subject + " " + body):
        return {"error": "said something it never says"}, resp.usage
    return {"subject": subject, "body": body}, resp.usage


def _wrote_lately(to, today):
    since = today - datetime.timedelta(days=RECENT_DAYS)
    return bool(receipts._list_ids("in:sent to:%s after:%s" % (to, since.strftime("%Y/%m/%d"))))


def drafts(client, db, today, deadline=None):
    """This Monday's emails. Returns how many went to Drafts, or None when
    today is not a day for it."""
    cfg = conf(db)
    w = window_now(cfg, today) if cfg["on"] and today.weekday() == 0 else None
    if not w:
        return None
    try:
        db.collection("reminderLog").document("seasonmail_" + today.isoformat()).create({"at": dg._now().isoformat()})
    except Exception:       # noqa: BLE001 -- this morning's run already has it
        return None
    made = 0
    day = spend.today()
    for cid, c, to in who(db, today, w, cfg["perWeek"]):
        if made >= cfg["perWeek"] or (deadline and time.monotonic() > deadline) or spend.over_cap(db):
            break
        try:
            past, only_snow = history(c)
            if only_snow or _wrote_lately(to, today):
                continue
            got, usage = write_one(client, c, past, w)
            spend.record(db, day, "seasonmail", MODEL, usage)
            if got.get("error"):
                print("seasonmail: not written for %s: %s" % (cid, got["error"]))
                continue
            saved = cards.draft_email(to, got["subject"], got["body"])
            if saved.get("error"):
                print("seasonmail: draft not saved for %s" % cid)
                break           # Gmail itself: the rest would fail the same way
        except Exception as e:  # noqa: BLE001 -- one customer never stops the rest
            print("seasonmail: %s skipped: %s" % (cid, e))
            continue
        patch = {"seasonDraft": {"key": w["key"], "at": dg._now().isoformat(), "link": saved.get("link") or "", "to": to,
                                 "subject": got["subject"], "body": got["body"], "open": True,
                                 "outcome": None, "sentAt": None}}
        # On the Call list, where the draft shows, with no time of their own.
        state, _ = outreach.call_state(c, today)
        if state is None:
            patch.update({"when": {"from": today.isoformat(), "to": w["to"], "label": w["name"].title() + " " + str(today.year),
                                   "how": "season"}, "contactWhen": w["name"].title() + " " + str(today.year),
                          "whenSetAt": dg._now().isoformat()})
        db.collection("customers").document(cid).set(patch, merge=True)
        made += 1
    if made:
        _tell(db, "✉️ %d %s email%s in your Drafts" % (made, w["name"], "" if made == 1 else "s"),
              "Read them, change what you want and send them. They show on the Call list with Draft ready.", "contacts")
    return made


def _tell(db, title, body, opens):
    for s in db.collection("users").where("role", "==", "owner").stream():
        try:
            dg.send_push(s.id, {"push": {"title": title, "body": body}}, tag="yd-seasonmail", ttl=24 * 3600, opens=opens)
        except Exception as e:      # noqa: BLE001
            print("seasonmail: push failed:", e)


# ---------------------------------------------------------------- learning

def _typed(text):
    """An email's own words: his signature and anything quoted cut off."""
    words = str(text or "")
    cut = inboxdesk.SIGNATURE.search(words)
    if cut:
        words = words[:cut.start()]
    return re.sub(r"(?s)\n?On .{5,120} wrote:.*$", "", words).strip()


def ratio(a, b):
    return difflib.SequenceMatcher(None, " ".join(a.split()).lower(), " ".join(b.split()).lower()).ratio()


def find_sent(d):
    """The email he sent from this draft: (its own words, when) or None."""
    day = str(d.get("at") or "")[:10].replace("-", "/")
    best, best_at, score = None, None, 0.0
    for mid in receipts._list_ids("in:sent to:%s after:%s" % (d.get("to"), day))[:10]:
        m = receipts._fetch(mid)
        words = _typed(m.get("text"))
        r = ratio(str(d.get("body") or ""), words)
        if r > score:
            best, best_at, score = words, m.get("internalDate"), r
    return (best, best_at) if best is not None and score >= SAME_EMAIL else None


def merge_lessons(have, new):
    """His lessons, one a line, the new ones after: none twice, the newest
    kept when there are too many."""
    lines = [l.strip() for l in str(have or "").splitlines() if l.strip()]
    seen = {l.lower() for l in lines}
    for l in new or []:
        l = "- " + str(l).strip().lstrip("-• ").strip()
        if len(l) > 3 and l.lower() not in seen:
            seen.add(l.lower())
            lines.append(l)
    return "\n".join(lines[-MAX_LESSON_LINES:])


def _lessons(client, pairs):
    text = "\n\n".join("DRAFT:\n%s\n\nWHAT HE SENT:\n%s" % p for p in pairs)
    resp = client.beta.messages.create(
        model=MODEL, max_tokens=1500, system=LESSONS_SYSTEM,
        messages=[{"role": "user", "content": text}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": LESSONS_SCHEMA}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    )
    body = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        return list(json.loads(body).get("lessons") or []), resp.usage
    except ValueError:
        return [], resp.usage


def learn(client, db, today):
    """The month's drafts read against what he sent. Returns the counts, or
    None when this month's look is done."""
    try:
        db.collection("reminderLog").document("seasonlearn_" + today.strftime("%Y-%m")).create({"at": dg._now().isoformat()})
    except Exception:       # noqa: BLE001
        return None
    counts, pairs = {"same": 0, "edited": 0, "unsent": 0, "waiting": 0}, []
    for s in db.collection("customers").where("seasonDraft.open", "==", True).stream():
        c = s.to_dict() or {}
        d = c.get("seasonDraft") or {}
        try:
            found = find_sent(d)
        except Exception as e:      # noqa: BLE001 -- next month, then
            print("seasonmail: %s not looked up: %s" % (s.id, e))
            counts["waiting"] += 1
            continue
        patch = {}
        if found:
            words, when = found
            edited = ratio(str(d.get("body") or ""), words) < SAME_RATIO
            counts["edited" if edited else "same"] += 1
            if edited:
                pairs.append((str(d.get("body") or ""), words))
            sent = datetime.datetime.fromtimestamp(int(when or 0) / 1000, datetime.timezone.utc).isoformat()
            patch = {"seasonDraft": {"open": False, "outcome": "edited" if edited else "same", "sentAt": sent}}
            if str(c.get("reachedAt") or "") < sent:
                patch["reachedAt"] = sent
        elif str(d.get("at") or "")[:10] < (today - datetime.timedelta(days=UNSENT_DAYS)).isoformat():
            counts["unsent"] += 1
            patch = {"seasonDraft": {"open": False, "outcome": "unsent"}}
        else:
            counts["waiting"] += 1
        if patch:
            s.reference.set(patch, merge=True)
    added = 0
    if pairs and not spend.over_cap(db):
        new, usage = _lessons(client, pairs[:MAX_PAIRS])
        spend.record(db, spend.today(), "seasonmail", MODEL, usage)
        ref = db.collection("settings").document("voice")
        before = str(((ref.get().to_dict() or {}) if ref.get().exists else {}).get("lessons") or "")
        after = merge_lessons(before, new)
        added = len(after.splitlines()) - len([l for l in before.splitlines() if l.strip()])
        if after != before:
            ref.set({"lessons": after, "lessonsAt": dg._now().isoformat()}, merge=True)
    db.collection(SETTINGS[0]).document(SETTINGS[1]).set(
        {"learned": dict(counts, at=dg._now().isoformat(), lessons=added)}, merge=True)
    if counts["edited"] or counts["same"]:
        _tell(db, "📝 Claude read the season emails you sent",
              "%d sent as written, %d changed%s. See All settings, How you write." % (
                  counts["same"], counts["edited"], ", %d new lesson%s" % (added, "" if added == 1 else "s") if added else ""), "home")
    return counts


def run(client, deadline=None):
    """The morning run. Does nothing most days."""
    db = dg._db()
    today = dg._now().date()
    if today.day == 1:
        try:
            learn(client, db, today)
        except Exception as e:      # noqa: BLE001 -- the Monday drafts don't wait on it
            print("seasonmail: month's look failed:", e)
    return drafts(client, db, today, deadline)
