"""Plant-care emails to clients.

Jonah (1 Oct 2026): "claude auto drafts care info based directly on which
plants a client had installed and emails it to them as the company." His
answers (6 Oct): show him each email first -- so it goes to his Gmail Drafts,
never sent from here -- and later it can send by itself; from a company alias
once he has made one.

When a job with plants on its estimate is finished, the app asks for one.
Claude writes the care guide for exactly those plants, for southern Wisconsin
and the time of year they went in. The job is read here from Firestore, not
taken from the app: the app only says WHICH job, so the email cannot be steered
by whatever a browser sends, and the address it goes to is the one on the job.

Artificial turf (Jonah, 21 Oct 2026: "turf jobs once completed automatically
draft a care email to the client"): the same email, for a job with turf -- one
email covering the plants, the turf, or both. Turf is found the app's way
(plantcare.js readsLikeTurf): a labour line's heading or a material that reads
like artificial turf, the Artificial Turf service, or his own Yes on the job.
"""

import json
import re

from google.api_core.exceptions import AlreadyExists

import cards
import digest as dg

# Writing a short email: the mid-priced model writes it as well (Jonah, 7 Oct:
# no Claude feature should cost more than it needs to).
MODEL = "claude-sonnet-5-5"

SYSTEM = (
    "You write the plant-care email YD Exterior Visions LLC sends a customer after planting at "
    "their property -- a landscaping company near Madison, Wisconsin (USDA zone 5a, clay and "
    "silt-loam soils common, hot humid summers, hard winters, deer and rabbits about). It goes "
    "out from the company, signed by Jonah Linfield, the owner.\n\n"
    "Write a warm, practical care guide for EXACTLY the plants listed -- nothing else:\n"
    "- A short thank-you to open (one or two sentences, first name if there is one).\n"
    "- Watering: the first weeks, the rest of the first season, and the second year, in plain "
    "amounts (e.g. 'a slow soak with a hose at the base for 10 minutes, twice a week'). Say how "
    "to tell when to water (finger test) and that over-watering clay kills more plants than "
    "drought. Mention the watering bag or ring if trees are on the list.\n"
    "- Mulch, fertiliser and pruning: what to do and when, for these plants, in this climate. "
    "Keep fertiliser light the first year.\n"
    "- Winter and the time of year: the date is given -- write for what comes next (planted in "
    "fall: watering until the ground freezes, winter protection, rabbit/deer guards where they "
    "matter; planted in spring: summer heat).\n"
    "- What to watch for, and that they should get in touch if a plant looks wrong.\n"
    "- Group plants that are cared for the same way; give a short section for any that need "
    "something different. Use plain headings and short bullet lines -- this is read on a "
    "phone.\n\n"
    "Rules: never invent anything about the job (dates, prices, what was done) beyond what is "
    "given. Never mention prices or costs. Only mention a plant warranty if the warranty text "
    "given says so, and then in its own words. Sign off with 'Jonah' on one line and 'YD "
    "Exterior Visions' on the next; add no phone number, website or address. The subject is "
    "short, e.g. 'Caring for your new plants'."
)

# Added to the instructions when the job has artificial turf.
TURF_SYSTEM = (
    "\n\nThis job ALSO (or only) had ARTIFICIAL TURF installed -- write its care too, under its own "
    "heading (and if there are no plants, the whole email is about the turf; then ignore the plant "
    "instructions above and call it a turf-care email):\n"
    "- The first few weeks: let the infill settle; brush it if the fibres look flat.\n"
    "- Regular care: rinse with a hose now and then (dust, pollen, pets); blow or rake off leaves "
    "and debris with a leaf blower or a plastic leaf rake -- never a metal rake; brush the fibres "
    "against the grain with a stiff (not wire) brush every few weeks, more where it is walked on.\n"
    "- Pets, if it could matter: pick up solids, hose the spot; an enzyme turf cleaner for odour.\n"
    "- Keep off it: grills, fire pits, smokers and hot ash; cigarettes; fireworks; sharp tools; "
    "car or trailer traffic. Reflected sun from a low-E window can melt fibres -- tell them to get "
    "in touch if they ever see a shiny or melted patch.\n"
    "- Winter here: let snow melt off by itself; if it must be cleared, a plastic shovel or a "
    "broom, leaving a little snow on top -- no metal blades, no salt or ice melt on it.\n"
    "- Spills: blot, rinse; a mild soap for sticky ones.\n"
    "- When to get in touch: seams lifting, edges coming up, low spots, or puddles that stay.\n"
    "Name the turf products only as given. The subject then reads e.g. 'Caring for your new turf' "
    "(or 'Caring for your new plants and turf')."
)

SCHEMA = {
    "type": "object",
    "properties": {"subject": {"type": "string"}, "body": {"type": "string"}},
    "required": ["subject", "body"],
    "additionalProperties": False,
}


def plants_of(j):
    """[(name, qty, tree)] from the job's estimate -- the plants it was priced
    with, which are the plants that went in."""
    out = []
    for m in ((j.get("estimate") or {}).get("materials") or []):
        if not isinstance(m, dict) or not m.get("plant"):
            continue
        name = str(m.get("name") or "").strip()
        if not name:
            continue
        try:
            qty = float(m.get("qty") or 0)
        except (TypeError, ValueError):
            qty = 0
        out.append((name[:120], qty, m.get("tree") or ""))
    return out


def supply_plants(j, get_item=None):
    """[(name, qty, '')] for plants on the estimate picked from Supplies (an
    item of the Plants kind) or set as that kind, rather than added with
    "+ Plant" -- the app counts those as plants too (plantcare.js), so the
    email covers them. `get_item(id)` reads a Supplies item (tests pass a
    fake); one read per such line."""
    if get_item is None:
        def get_item(sid):
            snap = dg._db().collection("supplies").document(sid).get()
            return snap.to_dict() if snap.exists else None
    out = []
    for m in ((j.get("estimate") or {}).get("materials") or []):
        if not isinstance(m, dict) or m.get("plant"):
            continue
        it = None
        sid = str(m.get("supplyId") or "").strip()
        if sid and "/" not in sid:
            try:
                it = get_item(sid) or None
            except Exception as e:      # noqa: BLE001 -- the "+ Plant" lines still go
                print("care: supply not read:", sid, e)
        # The item's kind, else the line's own -- as the app prices it.
        kind = str((it or {}).get("category") or m.get("category") or "")
        if kind.strip().lower() not in ("plant", "plants"):
            continue
        name = str(m.get("name") or (it or {}).get("name") or "").strip()
        if not name:
            continue
        try:
            qty = float(m.get("qty") or 0)
        except (TypeError, ValueError):
            qty = 0
        out.append((name[:120], qty, ""))
    return out


# The app's own words for artificial turf (plantcare.js TURF_WORDS /
# NOT_TURF): "Turfstone" pavers, "Turf Builder" and turf-type fescue are not.
TURF_WORDS = re.compile(r"\b(artificial|synthetic|fake)\s+(turf|grass|lawn)\b|\bputting\s+greens?\b|\bturf\b", re.I)
NOT_TURF = re.compile(r"\bturf[\s-]*(builder|type)\b|\bfescue\b|\bseed|\bfertili[sz]|\bsod\b|\bweed", re.I)


def reads_like_turf(text):
    t = str(text or "")
    return bool(t.strip()) and bool(TURF_WORDS.search(t)) and not NOT_TURF.search(t)


def turf_of(j):
    """[(text, qty, unit)] of the turf that went in: the estimate's labour
    lines whose heading reads like turf (with the start of their scope) and
    its turf materials. A job set to turf by hand, or with only the service,
    gets one plain line so the email can still be written."""
    est = j.get("estimate") or {}
    out = []
    for w in est.get("work") or []:
        if isinstance(w, dict) and reads_like_turf(w.get("title")):
            scope = " ".join(str(w.get("scope") or "").split())[:400]
            out.append((str(w.get("title")).strip()[:120] + (": " + scope if scope else ""), 0, ""))
    for m in est.get("materials") or []:
        if isinstance(m, dict) and reads_like_turf(m.get("name")):
            try:
                qty = float(m.get("qty") or 0)
            except (TypeError, ValueError):
                qty = 0
            out.append((str(m.get("name")).strip()[:120], qty, str(m.get("unit") or "")[:20]))
    if out:
        return out
    services = [x for x in (j.get("serviceTypes") or []) if reads_like_turf(x)]
    if j.get("turf") == "yes" or j.get("hasTurf") is True or services:
        return [("Artificial turf", 0, "")]
    return []


def is_owed(j):
    """A finished job with plants whose care email is still owed (the app's
    plantcare.js says the same): marked Complete since care emails were
    tracked (`completedAt`), not drafted by Claude (`careEmail`), not settled
    by hand (`careDone`: sent it himself, or not needed). Whether it has plants
    is the app's own answer, saved on the job (`hasPlants`, his Yes / No
    included); a job saved before that existed falls back to its estimate's
    plants."""
    if (j.get("jobStatus") or "") != "complete" or not j.get("completedAt"):
        return False
    done = j.get("careDone")
    if j.get("careEmail") or (isinstance(done, dict) and done.get("how")):
        return False
    # Artificial turf owes the same email: the app's saved answer, else the
    # job's own words.
    turf = j.get("hasTurf")
    if turf is True or (not isinstance(turf, bool) and j.get("turf") != "no" and turf_of(j)):
        return True
    has = j.get("hasPlants")
    if isinstance(has, bool):
        return has
    if j.get("plants") in ("yes", "no"):
        return j.get("plants") == "yes"
    return bool(plants_of(j))


def owed(jobs):
    """[(name, job #, finished ISO)] for the owner's summary, oldest first."""
    out = []
    for j in (jobs or {}).values():
        if isinstance(j, dict) and is_owed(j):
            out.append((str(j.get("customerName") or "A job").strip() or "A job",
                        str(j.get("estimateNumber") or "").strip(), str(j.get("completedAt"))))
    return sorted(out, key=lambda x: x[2])


SUMMARY_MAX = 6     # jobs named in the summary; the rest are counted


def summary_lines(owed_list, day_of):
    """The summary's lines for owed care emails. `day_of(iso)` gives "Oct 12"."""
    lines = [{"text": "🌱 %s%s — finished %s" % (n, (" #" + num) if num else "", day_of(at))}
             for n, num, at in owed_list[:SUMMARY_MAX]]
    if len(owed_list) > SUMMARY_MAX:
        lines.append({"text": "…and %d more" % (len(owed_list) - SUMMARY_MAX)})
    lines.append({"text": "Open the job to have Claude write it, or mark it sent or not needed."})
    return lines


def _warranty():
    try:
        rules = dg._db().collection("pricing").document("rules").get().to_dict() or {}
    except Exception:       # noqa: BLE001
        return ""
    return str(((rules.get("payments") or {}).get("warranty")) or "").strip()[:1500]


def _prompt(j, plants, turf=()):
    first = str(j.get("firstName") or "").strip()
    lines = [
        "Today is %s." % dg._long_day(dg._now().date()),
        "Customer: %s%s" % ((j.get("customerName") or "").strip() or "(no name)",
                            (" (first name %s)" % first) if first else ""),
        "Town: %s" % ((j.get("city") or "").strip() or "(not given)"),
        "Plants installed:" if plants else "Plants installed: none -- this email is about the artificial turf only.",
    ]
    for name, qty, tree in plants:
        q = ("%g x " % qty) if qty else ""
        kind = {"single": " (single-trunk tree)", "multi": " (multi-trunk tree or evergreen)"}.get(tree, "")
        lines.append("- %s%s%s" % (q, name, kind))
    if turf:
        lines.append("Artificial turf installed:")
        for text, qty, unit in turf:
            lines.append("- %s%s" % (text, (" (%g %s)" % (qty, unit)).replace(" )", ")") if qty else ""))
    w = _warranty()
    lines.append("\nThe company's warranty text (mention a warranty only if this covers what was installed):\n%s" % (w or "(none)"))
    return "\n".join(lines)


def draft(client, job_id, auto=False):
    """Write the care email into the owner's Gmail Drafts. Returns (result,
    usage): result is {draftId, link, to, subject}, {error}, or {skipped}
    for an automatic one already written; usage is None when Claude was never
    asked.

    `auto` is the app asking by itself because the job was just marked
    Complete. That happens once per job however many devices see it: a job
    with a care email already is skipped, and a claim in reminderLog stops
    two devices (or Complete, In progress, Complete in quick succession)
    drafting it twice at the same moment. "Write it again" by hand is never
    stopped."""
    snap = dg._db().collection("jobs").document(job_id).get()
    if not snap.exists:
        return {"error": "That job was not found"}, None
    j = snap.to_dict() or {}
    # A job set to "No plants" / "No turf" by hand gets nothing on that side.
    plants = [] if j.get("plants") == "no" else plants_of(j) + supply_plants(j)
    turf = [] if j.get("turf") == "no" else turf_of(j)
    if not plants and not turf:
        return {"error": "There are no plants or artificial turf on this job's estimate"}, None
    to = (j.get("email") or "").strip()
    if not cards.EMAIL_RE.match(to):
        return {"error": "This job has no email address. Add one to the job first."}, None
    claim = None
    if auto:
        if j.get("careEmail"):
            return {"skipped": True}, None
        claim = dg._db().collection("reminderLog").document("care_" + job_id)
        try:
            claim.create({"job": job_id, "at": dg._now().isoformat()})
        except AlreadyExists:
            return {"skipped": True}, None
    try:
        result = _write(client, job_id, j, plants, to, turf)
    except Exception:
        # Not written after all: the claim goes, so the next try is not
        # mistaken for a duplicate.
        if claim is not None:
            claim.delete()
        raise
    if claim is not None and result[0].get("error"):
        claim.delete()
    return result


def _write(client, job_id, j, plants, to, turf=()):
    resp = client.beta.messages.create(
        model=MODEL, max_tokens=8000, system=SYSTEM + (TURF_SYSTEM if turf else ""),
        messages=[{"role": "user", "content": _prompt(j, plants, turf)}],
        thinking={"type": "adaptive"},
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    )
    if resp.stop_reason == "refusal":
        return {"error": "Claude declined to write this one"}, resp.usage
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        got = json.loads(text)
    except ValueError:
        return {"error": "Claude's answer could not be read. Try again."}, resp.usage
    subject, body = (got.get("subject") or "").strip(), (got.get("body") or "").strip()
    if not subject or not body:
        return {"error": "Claude's answer was empty. Try again."}, resp.usage

    saved = cards.draft_email(to, subject, body)
    if saved.get("error"):
        return {"error": saved["error"].split(". Put the full")[0] + "."}, resp.usage
    note = {"at": dg._now().isoformat(), "draftId": saved.get("draftId"), "subject": saved.get("subject"),
            "plants": len(plants), "turf": len(turf)}
    import quickbooks
    dg._db().collection("jobs").document(job_id).set({"careEmail": note, "lastModified": quickbooks._stamp()}, merge=True)
    print("care: drafted for job", job_id)
    return {"draftId": saved.get("draftId"), "link": saved.get("link"), "to": to,
            "subject": saved.get("subject")}, resp.usage
