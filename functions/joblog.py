"""The daily log of a job, and an update to its customer.

Jonah (23 Oct 2026, AI idea #4, "go" 26 Oct): "Voice notes and photos turned
into daily logs and client updates is a great idea." Talking costs nothing:
the phone's own keyboard microphone turns speech into text, so a note on a
job (jobNotes, joblog.js) is typed or said. At the end of the day this puts
together, per job worked that day:

  - who was on it and for how long (the clock, paid time less pauses),
  - what was ticked done (workDone),
  - the photos taken (how many of each stage, and their captions),
  - the notes said or typed on the job (jobNotes), and the crew's notes and
    job issues about it (crewNotes),

and keeps it on the job as jobLogs/{jobId}_{day}. All of that is plain code
(code over Claude). Claude is asked only when there is something to READ --
notes or photo captions, which come in as one run-on sentence from the
microphone -- and then writes the day as a few short points. A day of only
hours and ticks is written by code alone, for nothing.

The update to the customer (a few lines: what got done, what is next) is
written only when someone taps "Draft an update" on that day (Jonah, 28 Oct:
"draft only when i tap"), and goes to his Gmail Drafts. Nothing is ever sent
from here.
"""

import datetime
import json

import cards
import digest as dg

# Short writing from notes: the mid-priced model (Jonah, 7 Oct: nothing
# should spend more than it needs to).
MODEL = "claude-sonnet-5-5"
EVENING_MAX = 10          # jobs written in one evening run
NOTES_MAX = 40            # notes read for one day
NOTE_CHARS = 1500

LOG_SYSTEM = (
    "You keep the daily job log for YD Exterior Visions LLC, a landscaping and hardscaping company near "
    "Madison, Wisconsin. You are given one job's day: who worked and how long, what was ticked done, the "
    "photos' captions and the notes the crew and the owner said or typed (often dictated, run-on, with "
    "mistakes). Write the day as 3 to 7 short bullet points, one per line starting with '• ': what was done, "
    "anything that went wrong or was found on site, materials short or left over, what is left or next. "
    "Plain words, like a foreman's notebook. Only what the facts say -- never invent work, amounts or plans. "
    "No prices. Leave out the hours (they are shown beside the log)."
)

UPDATE_SYSTEM = (
    "You write a short progress update from YD Exterior Visions LLC (landscaping, near Madison, Wisconsin) "
    "to the homeowner whose job was worked on that day. It goes out from the owner's email, so it is first "
    "draft for him to read before he sends it. Three to five short lines: a friendly hello (first name if "
    "given), what got done that day in the customer's words (not the crew's shorthand), and what comes next "
    "if the facts say so. Never prices, hours, crew names, or anything that went wrong on our side "
    "(material ordering, equipment, mistakes); a site problem the customer should know about (something "
    "found in the ground, a change to talk about) is said plainly and calmly with 'we'll talk it through "
    "with you'. Never promise a date unless the notes give one. Sign off 'Jonah' on one line and "
    "'YD Exterior Visions' on the next, nothing else. Subject short, e.g. 'Today's progress on your patio'."
)

LOG_SCHEMA = {"type": "object", "properties": {"log": {"type": "string"}},
              "required": ["log"], "additionalProperties": False}
UPDATE_SCHEMA = {"type": "object", "properties": {"subject": {"type": "string"}, "body": {"type": "string"}},
                 "required": ["subject", "body"], "additionalProperties": False}

STAGES = (("before", "before"), ("during", "during the work"), ("after", "after"))


# ---------------------------------------------------------------- the day

def today():
    return dg._day(dg._now())


def _bounds(day):
    """The Chicago day as (start ms, end ms, start ISO UTC, end ISO UTC) -- the
    clock keeps milliseconds, photos and notes keep ISO times in UTC."""
    d = dg._parse_day(day)
    start = datetime.datetime(d.year, d.month, d.day, tzinfo=dg.TZ)
    end = start + datetime.timedelta(days=1)
    iso = lambda t: t.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000), iso(start), iso(end)


def _ms(v):
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return datetime.datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp() * 1000
    except (TypeError, ValueError):
        return None


def _within(iso, lo, hi):
    """An ISO time (UTC, 'Z' or offset) inside [lo, hi) given as UTC ISO
    without zone. Compared as times, not text: some are written with an
    offset."""
    t = _ms(iso)
    return t is not None and _ms(lo + "+00:00") <= t < _ms(hi + "+00:00")


def _worked_ms(e, lo, hi, now_ms):
    """Paid time of a shift inside the day, less its pauses inside the day."""
    start = e.get("startedMs")
    if not isinstance(start, (int, float)):
        return 0
    end = e.get("endedMs") or now_ms
    a, b = max(start, lo), min(end, hi)
    if b <= a:
        return 0
    paused = 0
    for p in e.get("pauses") or []:
        ps = _ms((p or {}).get("startedAt"))
        if ps is None:
            continue
        pe = _ms(p.get("endedAt")) if p.get("endedAt") else min(end, now_ms)
        paused += max(0, min(pe, b) - max(ps, a))
    return max(0, b - a - paused)


def facts(db, job_id, day, people=None):
    """Everything known about the job's day, in plain fields. Never prices."""
    lo, hi, lo_iso, hi_iso = _bounds(day)
    now_ms = dg._now().timestamp() * 1000
    people = people if people is not None else dg._people()
    name_of = lambda uid, fallback="": dg._name(people.get(uid)) if uid in people else (fallback or "Someone")

    mins = {}
    for s in db.collection("timeEntries").where("targetId", "==", job_id).stream():
        e = s.to_dict() or {}
        if e.get("kind") != "job" or e.get("status") == "rejected":
            continue
        ms = _worked_ms(e, lo, hi, now_ms)
        if ms > 0:
            who = name_of(e.get("uid"), e.get("workerName"))
            mins[who] = mins.get(who, 0) + ms / 60000
    hours = [{"name": n, "minutes": round(m)} for n, m in sorted(mins.items(), key=lambda x: -x[1]) if round(m) > 0]

    done = []
    snap = db.collection("workDone").document(job_id).get()
    for line in ((snap.to_dict() or {}).get("lines") or {}).values() if snap.exists else []:
        if isinstance(line, dict) and line.get("done") is True and _within(line.get("at"), lo_iso, hi_iso):
            done.append({"title": str(line.get("title") or "A piece of the work")[:200], "by": str(line.get("by") or "")[:80]})

    photos = {k: 0 for k, _ in STAGES}
    captions = []
    for s in db.collection("jobPhotos").where("jobId", "==", job_id).stream():
        p = s.to_dict() or {}
        if p.get("deleteAsked") or not _within(p.get("at"), lo_iso, hi_iso):
            continue
        if p.get("stage") in photos:
            photos[p["stage"]] += 1
        cap = " ".join(str(p.get("caption") or "").split())
        if cap:
            captions.append({"stage": p.get("stage") or "", "text": cap[:300], "num": p.get("num")})

    notes = []
    for s in db.collection("jobNotes").where("jobId", "==", job_id).stream():
        n = s.to_dict() or {}
        if n.get("day") == day and str(n.get("text") or "").strip():
            notes.append({"by": name_of(n.get("uid"), n.get("by")), "at": n.get("at") or "",
                          "text": str(n.get("text")).strip()[:NOTE_CHARS], "kind": "note"})
    for s in db.collection("crewNotes").where("jobId", "==", job_id).stream():
        n = s.to_dict() or {}
        if _within(n.get("at"), lo_iso, hi_iso) and str(n.get("text") or "").strip():
            notes.append({"by": name_of(n.get("uid"), n.get("by")), "at": n.get("at") or "",
                          "text": str(n.get("text")).strip()[:NOTE_CHARS],
                          "kind": "issue" if n.get("kind") == "issue" else "toJonah"})
    notes.sort(key=lambda n: str(n["at"]))
    return {"hours": hours, "done": done, "photos": photos, "captions": captions[:30], "notes": notes[:NOTES_MAX]}


def has_any(f):
    return bool(f["hours"] or f["done"] or sum(f["photos"].values()) or f["notes"])


def _needs_reading(f):
    return bool(f["notes"] or f["captions"])


def code_text(f):
    """The day in plain code: always there, the log itself when there is
    nothing to read."""
    lines = []
    for d in f["done"]:
        lines.append("• Done: %s" % d["title"])
    n = sum(f["photos"].values())
    if n:
        lines.append("• Photos: " + ", ".join("%d %s" % (f["photos"][k], w) for k, w in STAGES if f["photos"][k]))
    for c in f["captions"]:
        lines.append("• Photo%s: %s" % (" %s" % c["num"] if c.get("num") else "", c["text"]))
    for x in f["notes"]:
        lines.append("• %s%s: %s" % ("⚠️ " if x["kind"] == "issue" else "", x["by"], x["text"]))
    return "\n".join(lines)


def hours_text(f):
    return ", ".join("%s %s" % (h["name"], dg._fmt_dur(h["minutes"])) for h in f["hours"])


def _facts_prompt(j, day, f):
    out = ["Job: %s" % (str(j.get("customerName") or "").strip() or "(no name)"),
           "Day: %s" % dg._long_day(dg._parse_day(day))]
    work = [str(w.get("title") or "").strip() for w in ((j.get("estimate") or {}).get("work") or [])
            if isinstance(w, dict) and str(w.get("title") or "").strip()]
    if work:
        out.append("The job's work: " + "; ".join(work[:15]))
    if f["hours"]:
        out.append("On the job: " + hours_text(f))
    if f["done"]:
        out.append("Ticked done today: " + "; ".join(d["title"] for d in f["done"]))
    n = sum(f["photos"].values())
    if n:
        out.append("Photos taken: " + ", ".join("%d %s" % (f["photos"][k], w) for k, w in STAGES if f["photos"][k]))
    for c in f["captions"]:
        out.append("Photo caption (%s): %s" % (c["stage"] or "photo", c["text"]))
    for x in f["notes"]:
        label = {"issue": "Job issue noted by", "toJonah": "Note to the owner from"}.get(x["kind"], "Note from")
        out.append("%s %s: %s" % (label, x["by"], x["text"]))
    return "\n".join(out)


def _ask(client, system, schema, prompt, max_tokens=2000):
    resp = client.beta.messages.create(
        model=MODEL, max_tokens=max_tokens, system=system,
        messages=[{"role": "user", "content": prompt}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    )
    if resp.stop_reason == "refusal":
        return None, resp.usage
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        return json.loads(text), resp.usage
    except ValueError:
        return None, resp.usage


def _spend(db, usage):
    if usage is None:
        return
    import spend
    spend.record(db, datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"), "joblog", MODEL, usage)


def write(client, db, job_id, day, people=None, by=None):
    """Write (or write again) the job's log for the day. Returns the record,
    or {error}/{empty}. Claude only when there are notes or captions, and
    only while under the spending limit -- else the code text stands."""
    snap = db.collection("jobs").document(job_id).get()
    if not snap.exists:
        return {"error": "That job was not found"}
    j = snap.to_dict() or {}
    f = facts(db, job_id, day, people)
    if not has_any(f):
        return {"empty": True}
    text, how = code_text(f), "code"
    if _needs_reading(f) and client is not None:
        import spend
        if not spend.over_cap(db):
            got, usage = _ask(client, LOG_SYSTEM, LOG_SCHEMA, _facts_prompt(j, day, f))
            _spend(db, usage)
            said = str((got or {}).get("log") or "").strip()
            if said:
                text, how = said[:4000], "claude"
    rec = {"jobId": job_id, "jobName": str(j.get("customerName") or "").strip()[:120] or "A job", "day": day,
           "facts": f, "codeText": code_text(f), "text": text, "how": how, "hours": hours_text(f),
           "at": dg._now().isoformat(), "by": by or "evening"}
    # The fields written are replaced whole; a drafted update stays.
    db.collection("jobLogs").document("%s_%s" % (job_id, day)).set(rec, merge=list(rec.keys()))
    return rec


def worked_today(db, day):
    """The jobs with anything on them today: shifts, photos, notes, ticks."""
    lo, hi, lo_iso, hi_iso = _bounds(day)
    ids = set()
    for s in db.collection("timeEntries").where("startedMs", ">=", lo - 86400000).stream():
        e = s.to_dict() or {}
        start = e.get("startedMs")
        if e.get("kind") == "job" and e.get("targetId") and isinstance(start, (int, float))                 and (e.get("endedMs") or hi) > lo and start < hi:
            ids.add(str(e["targetId"]))
    for s in db.collection("jobPhotos").where("at", ">=", lo_iso).stream():
        p = s.to_dict() or {}
        if p.get("jobId") and _within(p.get("at"), lo_iso, hi_iso):
            ids.add(str(p["jobId"]))
    for s in db.collection("jobNotes").where("day", "==", day).stream():
        n = s.to_dict() or {}
        if n.get("jobId"):
            ids.add(str(n["jobId"]))
    for s in db.collection("workDone").where("updatedAt", ">=", lo_iso).stream():
        ids.add(s.id)
    return sorted(i for i in ids if i and "/" not in i)


def evening(client):
    """The evening summary run: every job worked today gets its log."""
    db = dg._db()
    day = today()
    people = dg._people()
    done = []
    for job_id in worked_today(db, day)[:EVENING_MAX]:
        try:
            r = write(client, db, job_id, day, people)
            if r.get("day"):
                done.append(job_id)
        except Exception as e:                      # noqa: BLE001 -- one job never stops the rest
            print("joblog: %s not written: %s" % (job_id, e))
    print("joblog: %d logs for %s" % (len(done), day))
    return {"day": day, "written": len(done)}


# ---------------------------------------------------------------- the update

def draft_update(client, db, job_id, day, uid):
    """A few lines to the customer about that day, into Gmail Drafts.
    Returns (result, usage)."""
    snap = db.collection("jobs").document(job_id).get()
    if not snap.exists:
        return {"error": "That job was not found"}, None
    j = snap.to_dict() or {}
    to = (j.get("email") or "").strip()
    if not cards.EMAIL_RE.match(to):
        return {"error": "This job has no email address. Add one to the job first."}, None
    ref = db.collection("jobLogs").document("%s_%s" % (job_id, day))
    got_log = ref.get()
    log = got_log.to_dict() if got_log.exists else None
    if not log:
        log = write(client, db, job_id, day, by=uid)
        if not log.get("day"):
            return {"error": "Nothing was noted on this job that day."}, None
    first = str(j.get("firstName") or "").strip()
    prompt = ("Customer: %s%s\n" % (str(j.get("customerName") or "").strip() or "(no name)",
                                    (" (first name %s)" % first) if first else "") +
              _facts_prompt(j, day, log.get("facts") or {"hours": [], "done": [], "photos": {}, "captions": [], "notes": []}) +
              "\n\nThe day's log:\n" + str(log.get("text") or ""))
    got, usage = _ask(client, UPDATE_SYSTEM, UPDATE_SCHEMA, prompt)
    subject, body = str((got or {}).get("subject") or "").strip(), str((got or {}).get("body") or "").strip()
    if not subject or not body:
        return {"error": "Claude's answer could not be read. Try again."}, usage
    saved = cards.draft_email(to, subject, body)
    if saved.get("error"):
        return {"error": saved["error"].split(". Put the full")[0] + "."}, usage
    note = {"at": dg._now().isoformat(), "by": uid, "draftId": saved.get("draftId"), "subject": saved.get("subject"),
            "to": to, "link": saved.get("link")}
    ref.set({"update": note}, merge=True)
    return {"draftId": saved.get("draftId"), "link": saved.get("link"), "to": to, "subject": saved.get("subject")}, usage
