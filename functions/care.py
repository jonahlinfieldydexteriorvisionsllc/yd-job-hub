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
"""

import json

from google.api_core.exceptions import AlreadyExists

import cards
import digest as dg

MODEL = "claude-opus-5-5"

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


def _warranty():
    try:
        rules = dg._db().collection("pricing").document("rules").get().to_dict() or {}
    except Exception:       # noqa: BLE001
        return ""
    return str(((rules.get("payments") or {}).get("warranty")) or "").strip()[:1500]


def _prompt(j, plants):
    first = str(j.get("firstName") or "").strip()
    lines = [
        "Today is %s." % dg._long_day(dg._now().date()),
        "Customer: %s%s" % ((j.get("customerName") or "").strip() or "(no name)",
                            (" (first name %s)" % first) if first else ""),
        "Town: %s" % ((j.get("city") or "").strip() or "(not given)"),
        "Plants installed:",
    ]
    for name, qty, tree in plants:
        q = ("%g x " % qty) if qty else ""
        kind = {"single": " (single-trunk tree)", "multi": " (multi-trunk tree or evergreen)"}.get(tree, "")
        lines.append("- %s%s%s" % (q, name, kind))
    w = _warranty()
    lines.append("\nThe company's warranty text (mention a plant warranty only if this covers plants):\n%s" % (w or "(none)"))
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
    plants = plants_of(j)
    if not plants:
        return {"error": "There are no plants on this job's estimate"}, None
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
        result = _write(client, job_id, j, plants, to)
    except Exception:
        # Not written after all: the claim goes, so the next try is not
        # mistaken for a duplicate.
        if claim is not None:
            claim.delete()
        raise
    if claim is not None and result[0].get("error"):
        claim.delete()
    return result


def _write(client, job_id, j, plants, to):
    resp =client.beta.messages.create(
        model=MODEL, max_tokens=8000, system=SYSTEM,
        messages=[{"role": "user", "content": _prompt(j, plants)}],
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
            "plants": len(plants)}
    import quickbooks
    dg._db().collection("jobs").document(job_id).set({"careEmail": note, "lastModified": quickbooks._stamp()}, merge=True)
    print("care: drafted for job", job_id)
    return {"draftId": saved.get("draftId"), "link": saved.get("link"), "to": to,
            "subject": saved.get("subject")}, resp.usage
