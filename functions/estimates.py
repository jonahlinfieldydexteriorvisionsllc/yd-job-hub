"""Claude lays out an estimate from Jonah's site-visit notes: the labour and the
takeoff. Code prices it.

Jonah writes what he saw and measured and what the customer wants; Claude
turns that into estimate lines, and he keeps talking to it ("make the patio
18x20", "add a fire pit", "we'll pick up the edgers"). The split between
Claude and plain code is deliberate:

  * Claude does the reading and judgement -- which labour lines the job
    needs and the scope of work the customer reads for each; which materials
    from Supplies, and how much of each (a 16x20 patio is 320 sq ft of
    pavers; 6 in of base under it is about 8.3 tons of gravel); what is
    missing or doubtful.
  * Code does the money (pricing.js in the app): waste, rounding, supplier
    costs, tax, markups, deliveries, fuel, dumpsters, the planting package,
    labour from crew-days. Claude never sees a cost and never sets a price, so
    an estimate cannot go out at a price Jonah's rules did not make.

Crew-days are Jonah's call: Claude leaves them blank unless he gave them or
asked for a suggestion. Jonah's own takeoff knowledge -- base depths, the
conversions he uses, install standards, how a scope is written, the clauses
every estimate carries -- is in pricing/claude (his words, edited in the app,
never in this public repository) and goes to Claude with every message,
together with the Supplies catalogue; both are cached between messages.

It is a conversation: each call carries the whole conversation so far and the
estimate as it stands on screen (he may have changed lines by hand), and
Claude answers in words and, when he asked for a change, with the whole
estimate as it should now be. Lines carry ids, so the app keeps whatever
Claude does not set. Nothing is kept on the server; the conversation is saved
with the job.
"""

import json

import digest as dg

# Jonah's choice (6 Oct): the most capable model for estimates -- they need the
# most judgement of anything in the app, and he is used to working with it.
MODEL = "claude-fable-5-1"

SYSTEM = (
    "You lay out estimates for YD Exterior Visions LLC, a landscaping, hardscaping and snow "
    "removal company near Madison, Wisconsin, owned by Jonah Linfield. You work inside Job Hub, "
    "the company's app, with Jonah: he gives you his notes from the site visit and talks to you "
    "about the estimate.\n\n"
    "How the work is split -- this matters more than anything else here:\n"
    "- You do the takeoff and the words. The app does every dollar. You never see costs and never "
    "set a price.\n"
    "- Materials: pick each one from the SUPPLIES CATALOGUE by its id and give the NET quantity the "
    "job needs, in the takeoff unit shown for that item, worked out from the measurements (show "
    "nothing of the arithmetic to the customer). Do NOT add waste or over-order -- the app adds "
    "each item's waste and rounds up to what can be bought. Do NOT add delivery, fuel, dumpsters, "
    "the planting package (soil, fertiliser, watering bags/rings) or layout markers: the app adds "
    "those by rule. For dumpsters, give spoilCuYd: the cubic yards of soil and debris to haul away "
    "(excavation, sod, demolition). A material not in the catalogue goes in with an empty "
    "supplyId and a clear name, and a flag saying it needs adding to Supplies.\n"
    "- Plants are materials with plant=true, a name with size (e.g. 'Autumn Blaze maple, 2 in "
    "caliper'), the count, tree='single' for a single-trunk tree, 'multi' for multi-trunk or "
    "evergreen trees, 'none' otherwise, and costEachDollars only if Jonah gave the nursery cost.\n"
    "- Labour: one line per piece of work the customer should see separately -- often just one. "
    "kind 'crew' is priced from crew-days, which are Jonah's call: give crewDays only if he said "
    "them, or if he asked you to suggest them (then say in a flag that it is your guess). "
    "Otherwise crewDays is 0 and you ask. kind 'flat' is a flat-rate service from the PRICE BOOK "
    "(by its id, with the quantity in its unit); kind 'amount' is a figure Jonah gave.\n"
    "- The scope on each labour line is what the customer reads: a short heading-style title, "
    "then the scope of work in short plain paragraphs, no prices, no crew-days, no markup, no "
    "tier numbers. Follow Jonah's rules below for how a scope is built and what every estimate "
    "says.\n"
    "- Never invent measurements or work Jonah did not mention. When something needed is "
    "missing or doubtful (a dimension, a colour, pickup or delivery, access for the loader), put "
    "it in questions -- short, only what blocks a right estimate. Put anything Jonah should "
    "know but need not answer (a guess you made, a special-order item, an over-4-ft wall) in "
    "flags. Never substitute a product he named; flag it.\n"
    "- Delivery: 'pickup' when Jonah says the crew picks it up, 'rides' when it comes on another "
    "material's load, otherwise 'auto'.\n\n"
    "You are talking with Jonah. `reply` is your answer to his latest message: short and plain, "
    "like a colleague -- what you changed, or the answer to what he asked. When he asks for a "
    "change, or there is no estimate yet, set updated to true and give the WHOLE estimate as it "
    "should now be (every line), keeping the id of every line you keep and leaving lines he did "
    "not mention exactly as they are, including ones he changed by hand. A new line has an empty "
    "id. When he only asks a question, set updated to false and give the lines unchanged."
)

SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "updated": {"type": "boolean"},
        "work": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "title": {"type": "string"},
                "scope": {"type": "string"},
                "kind": {"type": "string", "enum": ["crew", "flat", "amount"]},
                "crewDays": {"type": "number"},
                "priceId": {"type": "string"},
                "qty": {"type": "number"},
                "amountDollars": {"type": "number"},
            },
            "required": ["id", "title", "scope", "kind", "crewDays", "priceId", "qty", "amountDollars"],
            "additionalProperties": False,
        }},
        "materials": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "supplyId": {"type": "string"},
                "name": {"type": "string"},
                "qty": {"type": "number"},
                "unit": {"type": "string"},
                "plant": {"type": "boolean"},
                "tree": {"type": "string", "enum": ["none", "single", "multi"]},
                "costEachDollars": {"type": "number"},
                "delivery": {"type": "string", "enum": ["auto", "pickup", "rides"]},
            },
            "required": ["id", "supplyId", "name", "qty", "unit", "plant", "tree", "costEachDollars", "delivery"],
            "additionalProperties": False,
        }},
        "spoilCuYd": {"type": "number"},
        "questions": {"type": "array", "items": {"type": "string"}},
        "flags": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["reply", "updated", "work", "materials", "spoilCuYd", "questions", "flags"],
    "additionalProperties": False,
}

# Names of the kinds of material (pricing.js CATEGORIES), for the catalogue.
CATEGORY_NAMES = {
    "soil": "Soil (bulk)", "fill": "Fill dirt", "mulch": "Mulch", "stone": "Stone, gravel & sand",
    "pavers": "Pavers", "wall": "Wall block & caps", "natural": "Natural stone, flagstone & boulders",
    "edging": "Edging", "hardscape": "Fabric, restraint, geogrid & other hardscape",
    "adhesive": "Adhesives & sealers", "drainage": "Drainage & concrete", "seed": "Seed & erosion control",
    "bagged": "Bagged goods", "planting": "Planting package", "plant": "Plants", "dumpster": "Dumpsters",
    "hardware": "Hardware", "rental": "Rentals", "other": "Other",
}


# ------------------------------------------------------------- what it reads

def catalogue():
    """Supplies as Claude sees them: what, from whom, in what unit -- no costs.
    Returns (text, ids)."""
    db = dg._db()
    vendors = {s.id: (s.to_dict() or {}).get("name", "") for s in db.collection("vendors").stream()}
    per = {}
    for s in db.collection("supplyPrices").stream():
        per[s.id] = str((s.to_dict() or {}).get("per") or "")
    rows, ids = [], set()
    items = [(s.id, s.to_dict() or {}) for s in db.collection("supplies").stream()]
    items.sort(key=lambda kv: (CATEGORY_NAMES.get(kv[1].get("category"), "~"), str(kv[1].get("name", ""))))
    group = None
    for sid, it in items:
        if not it.get("name"):
            continue
        ids.add(sid)
        cat = CATEGORY_NAMES.get(it.get("category"), "Not sorted yet")
        if cat != group:
            rows.append("\n%s:" % cat)
            group = cat
        try:
            coverage = float(it.get("coverage") or 0)
        except (TypeError, ValueError):
            coverage = 0
        unit = (it.get("takeoffUnit") or "") if coverage > 0 else (per.get(sid) or it.get("unit") or "")
        row = "- id %s | %s | takeoff in %s" % (sid, it["name"], unit or "each")
        if coverage > 0:
            row += " (bought by the %s, one covers %g %s)" % (per.get(sid) or it.get("unit") or "unit", coverage, it.get("takeoffUnit") or "")
        if vendors.get(it.get("vendorId")):
            row += " | from %s" % vendors[it["vendorId"]]
        if it.get("also"):
            row += " | also called %s" % str(it["also"])[:120]
        if it.get("specialOrder"):
            row += " | SPECIAL ORDER"
        if it.get("notes"):
            row += " | %s" % str(it["notes"])[:200]
        rows.append(row)
    return ("\n".join(rows).strip() or "(Supplies is empty)"), ids


def price_book():
    out = {}
    for s in dg._db().collection("priceBook").stream():
        p = s.to_dict() or {}
        if p.get("active") is False or not p.get("name"):
            continue
        out[s.id] = p
    return out


def _book_text(book):
    rows = []
    for pid, p in sorted(book.items(), key=lambda kv: (str(kv[1].get("category") or ""), kv[1].get("name", ""))):
        row = "- id %s | %s | per %s" % (pid, p.get("name"), p.get("unit") or "each")
        if p.get("description"):
            row += " | says: %s" % str(p["description"])[:300]
        if p.get("notes"):
            row += " | Jonah's rule: %s" % str(p["notes"])[:500]
        rows.append(row)
    return "\n".join(rows) or "(no flat-rate services)"


def rules_text():
    snap = dg._db().collection("pricing").document("claude").get()
    text = str(((snap.to_dict() or {}) if snap.exists else {}).get("text") or "").strip()
    return text or "(Jonah has not written his takeoff rules into Job Hub yet -- use sound landscaping practice and ask.)"


def _num(v):
    try:
        n = float(v)
        return n if n == n and abs(n) != float("inf") else None
    except (TypeError, ValueError):
        return None


def _current_text(cur):
    """The estimate as it stands on screen, for Claude to change."""
    cur = cur or {}
    rows = ["LABOUR:"]
    for w in cur.get("work") or []:
        kind = w.get("kind") or "crew"
        bits = ["id %s" % (w.get("id") or "?"), "kind %s" % kind, "title: %s" % str(w.get("title") or "")[:200]]
        if kind == "crew":
            bits.append("crewDays %s" % (w.get("crewDays") if _num(w.get("crewDays")) else "not set"))
        elif kind == "flat":
            bits.append("priceId %s qty %s" % (w.get("priceId") or "(none)", w.get("qty")))
        else:
            bits.append("amount $%s" % w.get("amountDollars"))
        rows.append("- " + " | ".join(bits) + "\n  scope: " + str(w.get("scope") or "")[:3000].replace("\n", "\n  "))
    if len(rows) == 1:
        rows.append("(none yet)")
    rows.append("MATERIALS:")
    n = len(rows)
    for m in cur.get("materials") or []:
        bits = ["id %s" % (m.get("id") or "?"), "supplyId %s" % (m.get("supplyId") or "(not in Supplies)"),
                str(m.get("name") or "")[:200], "qty %s %s" % (m.get("qty"), str(m.get("unit") or "")[:20])]
        if m.get("plant"):
            bits.append("plant, tree=%s" % (m.get("tree") or "none"))
            if _num(m.get("costEachDollars")):
                bits.append("cost each $%s" % m.get("costEachDollars"))
        if m.get("delivery") and m.get("delivery") != "auto":
            bits.append("delivery %s" % m["delivery"])
        rows.append("- " + " | ".join(bits))
    if len(rows) == n:
        rows.append("(none yet)")
    rows.append("Spoil to haul away: %s cu yd" % (cur.get("spoilCuYd") if _num(cur.get("spoilCuYd")) else "not set"))
    t = cur.get("totals") or {}
    if t:
        rows.append("What the app prices it at now (for talking about it -- never change prices yourself): "
                    "materials $%s, labour $%s, total $%s, crew-days %s." % (
                        t.get("materials"), t.get("labour"), t.get("total"), t.get("crewDays")))
        if t.get("notPriced"):
            rows.append("Not priced yet: " + "; ".join(str(x) for x in t["notPriced"][:20]))
    return "\n".join(rows)


def _chat_text(chat):
    out = []
    for m in (chat or [])[-30:]:
        who = "Jonah" if m.get("role") == "user" else "You"
        out.append("%s: %s" % (who, str(m.get("text") or "")[:2000]))
    return "\n\n".join(out)


def _prompt(d):
    chat = [m for m in (d.get("chat") or []) if isinstance(m, dict) and str(m.get("text") or "").strip()]
    return "\n".join([
        "Today is %s." % dg._long_day(dg._now().date()),
        "Customer: %s" % (str(d.get("customer") or "").strip() or "(no name)"),
        "Where: %s" % (str(d.get("location") or "").strip() or "(not given)"),
        "Services: %s" % (", ".join(str(s) for s in d.get("services") or []) or "(not given)"),
        "",
        "JONAH'S NOTES FROM THE SITE VISIT:",
        str(d.get("siteNotes") or "").strip()[:12000] or "(none written)",
        "",
        "Other notes on the job (context):",
        str(d.get("jobNotes") or "").strip()[:3000] or "(none)",
        "",
        "THE ESTIMATE AS IT STANDS:",
        _current_text(d.get("current")),
        "",
        "THE CONVERSATION SO FAR:",
        _chat_text(chat[:-1]) or "(this is the first message)",
        "",
        "JONAH'S LATEST MESSAGE:",
        str(chat[-1].get("text") or "")[:6000] if chat else "(none)",
    ])


# ----------------------------------------------------------------- the call

def draft(client, d):
    """Returns (result, usage). result: {reply, updated, work, materials,
    spoilCuYd, questions, flags} with every id checked; or {error}."""
    if not (d.get("chat") or []):
        return {"error": "Write a message first"}, None
    cat_text, supply_ids = catalogue()
    book = price_book()
    current = d.get("current") or {}
    work_ids = {str(w.get("id")) for w in current.get("work") or [] if w.get("id")}
    mat_ids = {str(m.get("id")) for m in current.get("materials") or [] if m.get("id")}

    # Everything that stays the same from one message to the next comes
    # first and is cached; the job and the conversation come after it.
    system = [
        {"type": "text", "text": SYSTEM},
        {"type": "text", "text": "JONAH'S TAKEOFF AND ESTIMATE RULES (his words):\n\n" + rules_text()},
        {"type": "text", "text": "SUPPLIES CATALOGUE (pick materials by id):\n" + cat_text +
                                 "\n\nPRICE BOOK (flat-rate services, for labour lines of kind 'flat'):\n" + _book_text(book),
         "cache_control": {"type": "ephemeral"}},
    ]
    first = len(d.get("chat") or []) <= 1
    with client.beta.messages.stream(
        model=MODEL, max_tokens=64000, system=system,
        messages=[{"role": "user", "content": _prompt(d)}],
        thinking={"type": "adaptive"},
        # The first build is the careful one; a follow-up ("make it 18x20")
        # should come back while he is still looking at the screen.
        output_config={"effort": "high" if first else "medium",
                       "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    ) as stream:
        resp = stream.get_final_message()
    if resp.stop_reason == "refusal":
        return {"error": "Claude declined to do this one"}, resp.usage
    if resp.stop_reason == "max_tokens":
        return {"error": "That estimate came out too long. Try it in parts."}, resp.usage
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        got = json.loads(text)
    except ValueError:
        return {"error": "Claude's answer could not be read. Try again."}, resp.usage

    work = []
    for w in got.get("work") or []:
        kind = w.get("kind") if w.get("kind") in ("crew", "flat", "amount") else "crew"
        pid = str(w.get("priceId") or "")
        work.append({
            "id": str(w.get("id") or "") if str(w.get("id") or "") in work_ids else "",
            "title": str(w.get("title") or "").strip()[:200],
            "scope": str(w.get("scope") or "").strip()[:6000],
            "kind": "flat" if kind == "flat" and pid in book else ("crew" if kind == "flat" else kind),
            "crewDays": max(0.0, round(_num(w.get("crewDays")) or 0, 2)),
            "priceId": pid if pid in book else "",
            "qty": max(0.0, round(_num(w.get("qty")) or 0, 2)),
            "amountDollars": max(0.0, round(_num(w.get("amountDollars")) or 0, 2)),
        })
    materials = []
    for m in got.get("materials") or []:
        sid = str(m.get("supplyId") or "")
        materials.append({
            "id": str(m.get("id") or "") if str(m.get("id") or "") in mat_ids else "",
            "supplyId": sid if sid in supply_ids and not m.get("plant") else "",
            "name": str(m.get("name") or "").strip()[:200],
            "qty": max(0.0, round(_num(m.get("qty")) or 0, 3)),
            "unit": str(m.get("unit") or "").strip()[:20],
            "plant": bool(m.get("plant")),
            "tree": m.get("tree") if m.get("tree") in ("single", "multi") else "none",
            "costEachDollars": max(0.0, round(_num(m.get("costEachDollars")) or 0, 2)),
            "delivery": m.get("delivery") if m.get("delivery") in ("pickup", "rides") else "auto",
        })
    return {"reply": str(got.get("reply") or "").strip(), "updated": bool(got.get("updated", True)),
            "work": work, "materials": materials,
            "spoilCuYd": max(0.0, round(_num(got.get("spoilCuYd")) or 0, 1)),
            "questions": [str(q) for q in got.get("questions") or [] if str(q).strip()],
            "flags": [str(q) for q in got.get("flags") or [] if str(q).strip()],
            "catalogueSize": len(supply_ids)}, resp.usage
