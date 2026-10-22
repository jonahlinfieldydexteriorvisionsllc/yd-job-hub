"""Claude lays out an estimate from Jonah's site-visit notes: the labour and the
takeoff. Code prices it.

Jonah writes what he saw and measured and what the customer wants; Claude
turns that into estimate lines, and he keeps talking to it ("make the patio
18x20", "add a fire pit", "we'll pick up the edgers"). The split between
Claude and plain code is deliberate:

  * Claude does the reading and judgement -- which labour lines the job
    needs, the scope of work the customer reads for each and the same work
    told to the crew in a few lines (`crew`, Jonah's yes of 21 Oct 2026:
    the crew get what to do, not why it is good); which materials
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

import base64
import io
import json
import re
import time

import digest as dg

# Jonah's choice (6 Oct): the most capable model for estimates -- they need the
# most judgement of anything in the app, and he is used to working with it.
# settings/claude.estimateModel = "opus" switches to the one at 40% of the
# price (set on the Pricing rules screen).
MODEL = "claude-fable-5-1"
MODELS = {"fable": "claude-fable-5-1", "opus": "claude-opus-5-5"}

SYSTEM = (
    "You lay out estimates for YD Exterior Visions LLC, a landscaping, hardscaping and snow "
    "removal company near Madison, Wisconsin, owned by Jonah Linfield. You work inside Job Hub, "
    "the company's app, with Jonah: he gives you his notes from the site visit and talks to you "
    "about the estimate.\n\n"
    "How the work is split -- this matters more than anything else here:\n"
    "- You do the takeoff and the words. The app does every dollar. You never see supplier costs "
    "and never set or work out a price -- every sum is the app's.\n"
    "- A material's name is what the customer reads on the estimate's materials list: the product "
    "itself (the catalogue item's name when it has one), never a supplier, a 'Paving -' style "
    "prefix, or where it goes and how many of it are for what -- that belongs in the scope.\n"
    "- Materials: pick each one from the SUPPLIES CATALOGUE by its id and give the NET quantity the "
    "job needs, in the takeoff unit shown for that item, worked out from the measurements (show "
    "nothing of the arithmetic to the customer). Do NOT add waste or over-order -- the app adds "
    "each item's waste and rounds up to what can be bought. Do NOT add delivery, fuel, dumpsters, "
    "the planting package (soil, fertiliser, watering bags/rings) or layout markers: the app adds "
    "those by rule. For dumpsters, give spoilCuYd: the cubic yards of soil, rock and debris to haul "
    "away (excavation, sod, demolition, old stone) -- and, apart from it, brushCuYd: the cubic yards "
    "of brush ONLY (branches, shrubs, roots, yard waste with no soil or rock in it), which goes in a "
    "bigger box of its own. Each is the whole job's figure; 0 when there is none. Never count the "
    "dumpsters yourself. A material not in the catalogue goes in with an empty "
    "supplyId and a clear name, and a flag saying it needs adding to Supplies.\n"
    "- Plants are materials with plant=true, a name with size (e.g. 'Autumn Blaze maple, 2 in "
    "caliper'), the count, tree='single' for a single-trunk tree, 'multi' for multi-trunk or "
    "evergreen trees, 'none' otherwise, and costEachDollars only if Jonah gave the nursery cost.\n"
    "- Labour: one line per piece of work the customer should see separately -- often just one. "
    "Read SERVICES first: it is how Jonah prices each kind of work, in his own words. A service "
    "priced BY THE UNIT (turf by the sq ft, say) goes on a line of kind 'flat' with its id and the "
    "quantity in its unit -- never as crew-days, whatever the job's size -- and in factors the ids "
    "of its adjustments the site notes call for (a steep slope, tight access, old lawn to strip...), "
    "and only those. A FIXED-price service is kind 'flat' with qty 1. Work priced by crew-days is "
    "kind 'crew': follow that service's notes, if it has any. crewDays are Jonah's call: give them "
    "only if he said them, or if he asked you to suggest them (then say in a flag that it is your "
    "guess); otherwise 0 and ask once in questions -- don't repeat it in every reply. On a 'flat', "
    "'amount' or 'allin' line, crewDays is how long the work takes (for his profit check and fuel) "
    "-- the same rule.\n"
    "- Two ways Jonah gives a dollar figure for a line, and they are different:\n"
    "  * kind 'amount' (amountDollars): a figure for the LABOUR only ('assume lighting install at "
    "$2,100'). The materials on the estimate are charged on top of it, as usual.\n"
    "  * kind 'allin' (allInDollars): a figure that INCLUDES the materials ('the paving should total "
    "$5,616 including install and materials', 'labour plus materials for the patio = $5,616'). "
    "Keep that work's materials on the estimate as usual, and set allInOf on each of them to that "
    "line's id (or, for a line you are adding in this answer, its exact title). The app works out "
    "what those materials come to, subtracts it from allInDollars, and makes the rest the line's "
    "labour -- so the line plus its materials come to his figure exactly. Never do that "
    "subtraction yourself, never take materials off to make a figure 'include' them, never ask him "
    "to do the sum, and never say you can't. Materials he says are NOT in that figure stay on the "
    "estimate with allInOf ''. Labour for other work he wants shown on the same line but not inside "
    "the figure (a wall's labour on the patio's line) goes in addDollars when he gave its amount; "
    "if he didn't, ask him for it once. allInDollars and addDollars are 0 on every other kind.\n"
    "  The estimate below shows what the app prices each line and material at; use those figures "
    "when he asks what something comes to, and never change one yourself.\n"
    "- The scope on each labour line is what the customer reads: a short heading-style title, "
    "then the scope of work in short plain paragraphs, no prices, no crew-days, no markup, no "
    "tier numbers, and no rented equipment (a mini-excavator or jumping jack is a takeoff line the "
    "app prices in but never shows the customer -- don't name it in a scope). Follow Jonah's rules "
    "below for how a scope is built and what every estimate says.\n"
    "- `crew` on each labour line is the same work told to the crew, for the job's page they read on "
    "site: 2 to 4 short lines -- what to do on THIS job, with the sizes, depths, quantities and "
    "particulars that matter there (where it goes, what to protect, access, what gets picked up). "
    "No selling words or why it is good for the customer, no prices, no crew-days. How the company "
    "does each kind of work is written for the crew separately, so don't explain the standard "
    "method -- only what is particular to this job. A line whose crew notes are marked as Jonah's "
    "own: give them back word for word unless his latest message asks to change what the crew are "
    "told.\n"
    "- Never invent measurements or work Jonah did not mention. When something needed is "
    "missing or doubtful (a dimension, a colour, pickup or delivery, access for the loader), put "
    "it in questions -- short, only what blocks a right estimate. Put anything Jonah should "
    "know but need not answer (a guess you made, a special-order item, an over-4-ft wall) in "
    "flags. Never substitute a product he named; flag it.\n"
    "- Delivery: 'pickup' when Jonah says the crew picks it up, 'rides' when it comes on another "
    "material's load, otherwise 'auto'.\n\n"
    "QuickBooks: you only build the estimate -- you never put it in QuickBooks or send it, "
    "and never say you have. Jonah does that himself with the buttons under the estimate "
    "('Put in QuickBooks, don't email yet' creates or updates it there under this customer, "
    "with its proper number; 'Send through QuickBooks' does the same and emails it), so he can "
    "add tags in QuickBooks first. When he asks you to put it in or send it, tell him which "
    "button to tap. Never say Job Hub is not connected to QuickBooks or that he must type the "
    "estimate in himself.\n"
    "Costs: a material line with 'cost each' set is priced by the app even though it is not in "
    "Supplies. Only what is listed under 'Not priced yet' is unpriced -- never say anything else "
    "is.\n\n"
    "You are talking with Jonah. `reply` is your answer to his latest message: short and plain, "
    "like a colleague -- what you changed, or the answer to what he asked. When he asks for a "
    "change, or there is no estimate yet, set updated to true and give the lines as the message "
    "says (HOW TO GIVE THE LINES, at its end): keep the id of every line you keep, leave lines he "
    "did not mention exactly as they are (including ones he changed by hand), and give a new line "
    "an empty id. When he only asks a question, set updated to false and give EMPTY work, "
    "materials and removed lists -- the app keeps the estimate as it is (re-writing it costs "
    "money and time)."
)

# How the lines come back, said in the message (not the cached system text,
# so the cache holds for both). "Only what changed" is asked for only when
# the app says it can merge that (patchOk) and there is an estimate to change:
# an older copy of the app, still cached on a phone, would read a partial
# list as the whole estimate and drop the rest.
WHOLE = ("HOW TO GIVE THE LINES: the WHOLE estimate as it should now be -- every labour line and every "
         "material, the ones you did not change included. `removed` is empty.")
PATCH = ("HOW TO GIVE THE LINES: ONLY what changes. In work and materials give just the lines you add "
         "(empty id) or change (their id, every field as the line should now be); a line you do not "
         "give stays exactly as it is. Put the id of every line to take off in `removed`. spoilCuYd and "
         "brushCuYd are the whole job's figures as they should now be.")

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
                "kind": {"type": "string", "enum": ["crew", "flat", "amount", "allin"]},
                "crewDays": {"type": "number"},
                "priceId": {"type": "string"},
                "qty": {"type": "number"},
                "factors": {"type": "array", "items": {"type": "string"}},
                "amountDollars": {"type": "number"},
                "allInDollars": {"type": "number"},
                "addDollars": {"type": "number"},
                "crew": {"type": "string"},
            },
            "required": ["id", "title", "scope", "kind", "crewDays", "priceId", "qty", "factors", "amountDollars",
                         "allInDollars", "addDollars", "crew"],
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
                "allInOf": {"type": "string"},
            },
            "required": ["id", "supplyId", "name", "qty", "unit", "plant", "tree", "costEachDollars", "delivery",
                         "allInOf"],
            "additionalProperties": False,
        }},
        "spoilCuYd": {"type": "number"},
        "brushCuYd": {"type": "number"},
        "questions": {"type": "array", "items": {"type": "string"}},
        "flags": {"type": "array", "items": {"type": "string"}},
        "removed": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["reply", "updated", "work", "materials", "spoilCuYd", "brushCuYd", "questions", "flags", "removed"],
    "additionalProperties": False,
}

# Names of the kinds of material (pricing.js CATEGORIES), for the catalogue.
CATEGORY_NAMES = {
    "soil": "Soil (bulk)", "fill": "Fill dirt", "mulch": "Mulch", "stone": "Stone, gravel & sand",
    "decorative": "Decorative rock", "pavers": "Pavers", "wall": "Wall block & caps",
    "natural": "Natural stone, flagstone & boulders", "firepit": "Firepits", "fireplace": "Fireplaces",
    "kitchen": "Outdoor kitchens",
    "edging": "Edging", "hardscape": "Fabric, restraint, geogrid & other hardscape",
    "adhesive": "Adhesives & sealers", "drainage": "Drainage & concrete", "seed": "Seed & erosion control",
    "bagged": "Bagged goods", "planting": "Planting package", "plant": "Plants", "dumpster": "Dumpsters",
    "hardware": "Hardware", "rental": "Rentals", "other": "Other",
}
# Bought to work with, not to install (pricing.js NOT_FOR_ESTIMATES): never
# sent -- the whole tools section of the supplier's book was a third of a
# long list Claude read on every first message.
NOT_FOR_ESTIMATES = {"tools"}
NOTE_CHARS = 80                 # what an item's notes may add to its line
# Said once by the "special order" flag; the book's own wording of it in the
# notes is dropped rather than read again on every line.
SPECIAL_WORDING = re.compile(r"\(?\*\*[^;.)]*\)?|\bspecial[- ]order\b[^;.]*[;.]?\s*", re.I)


def _short_notes(it):
    text = str(it.get("notes") or "")
    if it.get("specialOrder"):
        text = SPECIAL_WORDING.sub("", text)
    text = re.sub(r"\s*;\s*;+", ";", text).strip(" ;.")
    return text[:NOTE_CHARS]


# Which kinds of material a job can need, from the words in its notes and the
# conversation. The whole of Supplies is ~800 items (~32k tokens) -- most of
# it the supplier's wall block and paver lines -- and was sent with every
# message: the biggest part of the Claude bill (7 Oct). A regrade-and-bed job
# needs none of the block. The small kinds always go; the big ones only when
# a word calls for them; a kind already on the estimate always goes; and
# notes too short to tell go with everything.
ALWAYS_KINDS = {"stone", "edging", "hardscape", "soil", "fill", "mulch", "seed", "bagged", "drainage",
                "hardware", "rental", "planting", "dumpster", "plant"}
# The only kinds ever left out -- the big ones. Anything else, including an
# item with no kind or one not on the list (a price found on the web, an
# older hand-added item), always goes.
TRIMMED_KINDS = {"wall", "pavers", "natural", "other", "adhesive", "decorative", "firepit", "fireplace", "kitchen"}
KIND_WORDS = [
    (r"patio|paver|walk ?way|walks?\b|path|driveway|landing|stoop|pool deck|steps?\b|stairs?|apron|courtyard|terrace",
     {"pavers", "adhesive"}),
    (r"wall|retaining|block|seat ?wall|seating|pillar|column|caps?\b|raised bed|planter|steps?\b|stairs?",
     {"wall", "adhesive"}),
    # Jonah (12 Oct 2026): fire pits, fireplaces and the outdoor kitchen are
    # read only when a job names them.
    (r"fire ?pit|fire ?ring|fire ?table|fire ?bowl|fire ?feature|smokeless",
     {"firepit", "wall", "pavers", "adhesive"}),
    (r"fire ?place|chimney|hearth|wood ?box",
     {"fireplace", "wall", "pavers", "adhesive"}),
    (r"outdoor kitchen|kitchen|grill|\bbar\b|pizza|\boven\b|counter ?top|rotisserie",
     {"kitchen", "wall", "pavers", "adhesive"}),
    # ...and decorative rock only when the job has some (the gravel and sand
    # under a patio always go).
    (r"decorative|river rock|river stone|landscape rock|rock (bed|mulch|border|garden|edge)|stone mulch|"
     r"dry creek|pea gravel|lava rock|volcanic|marble|quartz|trap rock|decomposed granite|wash(ed)? stone|"
     r"rubies|granite chunks|white (limestone|rock)|\brocks?\b",
     {"decorative"}),
    (r"flag ?stone|boulder|outcrop|stepp(er|ing)|natural stone|ledge ?rock|lannon|slab|dry creek|rock garden|"
     r"wall stone|stone steps|irregular",
     {"natural", "adhesive"}),
    (r"seal(er|ing)?|poly(meric)? sand|joint sand|adhesive|glue", {"adhesive"}),
]


def kinds_for(words, on_estimate):
    """The catalogue kinds this job's words call for (None = everything)."""
    text = str(words or "").lower()
    if len(text.split()) < 6:
        return None                     # too little said to choose: everything
    out = set(ALWAYS_KINDS)
    for pattern, kinds in KIND_WORDS:
        if re.search(pattern, text):
            out |= kinds
    return out | set(on_estimate)


# ------------------------------------------------------------- what it reads
#
# Supplies is ~800 items and their ~800 price records: read whole for every
# message, that was ~1,900 reads and a second or two before Claude was even
# asked (review, 12 Oct 2026). So the catalogue's fields are kept in memory
# for CATALOGUE_SECONDS -- a conversation's messages come minutes apart --
# and the items on the estimate itself are always read fresh and laid over
# it, so one Jonah has just added ("Source it" -> Use) is never missing. Of
# a price record only its unit ("per") is read or kept: no cost is ever
# held here, and this is only ever sent to Claude.

# Five minutes: long enough for a back-and-forth, short enough that a price
# list loaded just before building an estimate is soon seen.
CATALOGUE_SECONDS = 300
SUPPLY_FIELDS = ["name", "category", "coverage", "takeoffUnit", "unit", "specialOrder", "also", "notes",
                 "vendorId", "packLb", "partUse"]
_held = {"at": None, "items": None, "per": None}


def _supplies(db, fresh=()):
    """({id: item}, {id: unit sold in}) for every Supplies item, the ones in
    `fresh` read now."""
    now = time.monotonic()
    if _held["items"] is None or now - _held["at"] > CATALOGUE_SECONDS:
        per = {s.id: str((s.to_dict() or {}).get("per") or "")
               for s in db.collection("supplyPrices").select(["per"]).stream()}
        items = {s.id: s.to_dict() or {} for s in db.collection("supplies").select(SUPPLY_FIELDS).stream()}
        _held.update(at=now, items=items, per=per)
    items, per = dict(_held["items"]), dict(_held["per"])
    fresh = [str(i) for i in fresh if i and "/" not in str(i)][:200]
    if fresh:
        for s in db.get_all([db.collection("supplies").document(i) for i in fresh], field_paths=SUPPLY_FIELDS):
            if s.exists:
                items[s.id] = s.to_dict() or {}
            else:
                items.pop(s.id, None)          # deleted since it was kept
        for s in db.get_all([db.collection("supplyPrices").document(i) for i in fresh], field_paths=["per"]):
            if s.exists:
                per[s.id] = str((s.to_dict() or {}).get("per") or "")
    return items, per


# Grass seed is bought in its biggest bag and charged by the pound of it used
# (Jonah, 15 Oct 2026; and 22 Oct: "grass seed in jobs is always madison
# park priced from the largest bag size unless otherwise specified"). Claude
# had picked the 5 lb bag; now it sees each such product once, in that bag.
# The same rule as the app's (supplymatch.js pack / famOf / biggestBag).
_LB = re.compile(r"(\d+(?:\.\d+)?)\s*(?:lbs?|#|pounds?)(?![a-z])", re.I)


def _bag_lb(it, per):
    """How many pounds one bag of an item holds; None for an item sold by the
    pound itself or of no known weight."""
    if re.fullmatch(r"\s*(lbs?|pounds?|#)\s*", str(per or it.get("unit") or ""), re.I):
        return None
    own = _num(it.get("packLb"))
    if own and own > 0:
        return own
    m = _LB.search(str(it.get("name") or ""))
    return float(m.group(1)) if m and float(m.group(1)) > 0 else None


def _part_bag(it, per):
    """The bag's weight when the item is bought by the bag and used a bit at a
    time: its own tick, else seed of a known bag weight."""
    lb = _bag_lb(it, per)
    if not lb:
        return None
    part = it.get("partUse") if isinstance(it.get("partUse"), bool) else str(it.get("category") or "").lower() == "seed"
    return lb if part else None


def _family(it):
    """One product in its several bag sizes: the supplier and the name's words
    without the weight."""
    words = re.findall(r"[a-z0-9]+", _LB.sub(" ", str(it.get("name") or "").lower()))
    return "%s|%s" % (it.get("vendorId") or "", " ".join(words))


def _smaller_bags(items, per):
    """The ids of every bag that is not its product's biggest."""
    big, bags = {}, []
    for sid, it in items:
        lb = _part_bag(it, per.get(sid))
        if lb:
            fam = _family(it)
            bags.append((sid, fam))
            if fam not in big or lb > big[fam][1]:
                big[fam] = (sid, lb)
    return {sid for sid, fam in bags if big[fam][0] != sid}


def catalogue(kinds=None, keep_ids=(), supplies=None, usual_seed=""):
    """Supplies as Claude sees them: what, in what unit -- no costs, no
    tools, one short line each; only the kinds given (all when None), plus
    any item in keep_ids; a bag of seed only in its product's biggest bag.
    usual_seed: Jonah's usual grass seed, marked. `supplies` is _supplies()'s
    answer when the caller has it. Returns (text, ids)."""
    items_by_id, per = supplies if supplies is not None else _supplies(dg._db(), keep_ids)
    rows, ids = [], set()
    items = list(items_by_id.items())
    items = [kv for kv in items if kv[1].get("name") and kv[1].get("category") not in NOT_FOR_ESTIMATES]
    keep_ids = set(keep_ids)
    if kinds is not None:
        items = [kv for kv in items if kv[1].get("category") not in TRIMMED_KINDS
                 or kv[1].get("category") in kinds or kv[0] in keep_ids]
    smaller = _smaller_bags(items, per)
    items = [kv for kv in items if kv[0] not in smaller or kv[0] in keep_ids]
    # A kind Jonah added himself is stored as its own name (pricing.js kindFor).
    def kind_name(c, missing):
        return CATEGORY_NAMES.get(c) or (str(c).strip() if c else "") or missing
    items.sort(key=lambda kv: (kind_name(kv[1].get("category"), "~"), str(kv[1].get("name", ""))))
    group = None
    for sid, it in items:
        ids.add(sid)
        cat = kind_name(it.get("category"), "Not sorted yet")
        if cat != group:
            rows.append("\n%s (id | name | takeoff unit | notes):" % cat)
            group = cat
        try:
            coverage = float(it.get("coverage") or 0)
        except (TypeError, ValueError):
            coverage = 0
        unit = (it.get("takeoffUnit") or "") if coverage > 0 else (per.get(sid) or it.get("unit") or "")
        row = "%s | %s | %s" % (sid, it["name"], unit or "each")
        if coverage > 0:
            row += " (1 %s = %g)" % (per.get(sid) or it.get("unit") or "unit", coverage)
        extra = []
        if sid == usual_seed:
            extra.append("Jonah's usual grass seed")
        if it.get("specialOrder"):
            extra.append("special order")
        if it.get("also"):
            extra.append("aka " + str(it["also"])[:50])
        notes = _short_notes(it)
        if notes:
            extra.append(notes)
        if extra:
            row += " | " + "; ".join(extra)
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


METHOD_WORDS = {"unit": "BY THE UNIT", "crew": "BY CREW-DAYS", "fixed": "FIXED PRICE"}


def _book_text(book):
    """Jonah's services (the app's "Services & how they're priced"): how each
    is priced, his notes on pricing it, and what adjusts it. Prices are left
    out -- the app does every sum."""
    rows = []
    for pid, p in sorted(book.items(), key=lambda kv: (str(kv[1].get("category") or ""), kv[1].get("name", ""))):
        method = p.get("method") if p.get("method") in METHOD_WORDS else "unit"
        row = "- %s | %s" % (p.get("name"), METHOD_WORDS[method])
        if method != "crew":
            row += " | id %s%s" % (pid, (" | per %s" % (p.get("unit") or "each")) if method == "unit" else "")
        if p.get("notes"):
            row += "\n  How Jonah prices it: %s" % str(p["notes"])[:1500].replace("\n", "\n  ")
        factors = [f for f in (p.get("factors") or []) if isinstance(f, dict) and f.get("id") and f.get("name")]
        if factors and method != "crew":
            row += "\n  Adjustments (give the ids that apply in factors): " + "; ".join(
                "%s = %s" % (f["id"], str(f["name"])[:80]) for f in factors[:20])
        if p.get("description"):
            row += "\n  Customer wording: %s" % str(p["description"])[:300]
        rows.append(row)
    return "\n".join(rows) or "(no services written up yet)"


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
            if w.get("factors"):
                bits.append("factors %s" % ", ".join(str(f) for f in (w.get("factors") or [])[:20]))
            if _num(w.get("crewDays")):
                bits.append("crewDays %s" % w.get("crewDays"))
        elif kind == "allin":
            bits.append("all-in $%s (labour + the materials marked allInOf this line)" % w.get("allInDollars"))
            if _num(w.get("addDollars")):
                bits.append("+ $%s labour not in the all-in" % w.get("addDollars"))
            split = w.get("allInSplit") or {}
            if split:
                bits.append("the app's split: its %s materials come to $%s, so its labour is $%s" % (
                    split.get("count"), split.get("materials"), split.get("labour")))
            if _num(w.get("crewDays")):
                bits.append("crewDays %s" % w.get("crewDays"))
        else:
            bits.append("amount $%s (labour only)" % w.get("amountDollars"))
            if _num(w.get("crewDays")):
                bits.append("crewDays %s" % w.get("crewDays"))
        if _num(w.get("priced")):
            bits.append("the line comes to $%s" % w.get("priced"))
        crew = str(w.get("crew") or "").strip()[:1500]
        rows.append("- " + " | ".join(bits) + "\n  scope: " + str(w.get("scope") or "")[:3000].replace("\n", "\n  ") +
                    ("\n  crew%s: %s" % (" (Jonah's own)" if w.get("crewMine") else "", crew.replace("\n", "\n  "))
                     if crew else ""))
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
            bits.append("cost each $%s (entered by hand -- priced)" % m.get("costEachDollars"))
        if m.get("delivery") and m.get("delivery") != "auto":
            bits.append("delivery %s" % m["delivery"])
        if m.get("allInOf"):
            bits.append("allInOf %s" % m["allInOf"])
        if m.get("handPicked") is True:
            bits.append("item picked by Jonah on the line -- keep it")
        if _num(m.get("customerDollars")):
            bits.append("$%s to the customer" % m.get("customerDollars"))
        rows.append("- " + " | ".join(bits))
    if len(rows) == n:
        rows.append("(none yet)")
    rows.append("Soil, rock and debris to haul away (spoilCuYd): %s cu yd" % (cur.get("spoilCuYd") if _num(cur.get("spoilCuYd")) else "not set"))
    rows.append("Brush only to haul away (brushCuYd): %s cu yd" % (cur.get("brushCuYd") if _num(cur.get("brushCuYd")) else "none"))
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
        "",
        PATCH if _patching(d) else WHOLE,
    ])


def _patching(d):
    cur = d.get("current") or {}
    return d.get("patchOk") is True and bool((cur.get("work") or []) or (cur.get("materials") or []))


# ----------------------------------------------------------------- photos
#
# Jonah (21 Oct 2026): Claude here should see the bid's photos -- "send the
# before/site-visit photos when it builds the estimate and when I ask about
# them, shrunk to keep the cost down". The app asks (photos: true) on the
# first build and when his message is about the photos; the server reads the
# job's Before photos itself from Storage (jobphotos.js), so a phone on one
# bar never sends them a second time. Claude is paid for by the pixel: each
# is shrunk to PHOTO_PX on its long side, about a third of what the 1600 px
# copy the job keeps would cost.
PHOTO_BUCKET = "yd-job-hub.firebasestorage.app"
PHOTO_MAX = 8              # the newest Before photos sent with one message
PHOTO_NAMED_MAX = 12       # photos he names by number ("look at photo 7"), at most
PHOTO_PX = 1024


def _shrink(raw):
    """A JPEG at most PHOTO_PX on its long side; the photo as it is when it
    cannot be read (Claude then shrinks it itself, at the higher price)."""
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(raw)).convert("RGB")
        im.thumbnail((PHOTO_PX, PHOTO_PX))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=80, optimize=True)
        return buf.getvalue()
    except Exception as e:                          # noqa: BLE001
        print("estimates: photo sent unshrunk:", e)
        return raw


def _numbered(recs):
    """Each photo's number on its job (jobphotos.js numbered): its own `num`,
    unless an earlier photo has it; the rest after the highest, in the order
    taken. recs carry their record id as `_id`."""
    used, out, rest = set(), {}, []
    for p in sorted(recs, key=lambda p: (str(p.get("at") or ""), str(p.get("_id") or ""))):
        n = p.get("num")
        if isinstance(n, (int, float)) and not isinstance(n, bool) and n == int(n) and n >= 1 and int(n) not in used:
            used.add(int(n))
            out[p["_id"]] = int(n)
        else:
            rest.append(p)
    nxt = max(used) if used else 0
    for p in rest:
        nxt += 1
        out[p["_id"]] = nxt
    return out


def _photos(db, job_id, newest=True, nums=()):
    """The job's photos to show Claude, as [(number, stage, caption, base64
    JPEG)] in number order: the ones he named by number (any stage), and --
    `newest` -- the newest PHOTO_MAX Before photos. Not ones someone asked to
    have deleted. Also: how many Before photos the job has, and the numbers he
    named that it has no photo for."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", str(job_id or "")):
        return [], 0, []
    recs = []
    for s in db.collection("jobPhotos").where("jobId", "==", job_id).stream():
        p = s.to_dict() or {}
        p["_id"] = s.id
        recs.append(p)
    number = _numbered(recs)
    usable = [p for p in recs if p.get("path") and not p.get("deleteAsked")]
    before = sorted([p for p in usable if p.get("stage") == "before"], key=lambda p: number[p["_id"]])
    want = {number[p["_id"]]: p for p in usable if number[p["_id"]] in set(nums)}
    missing = sorted(n for n in set(nums) if n not in want)
    picked = dict(list(sorted(want.items()))[:PHOTO_NAMED_MAX])
    if newest:
        for p in before[-PHOTO_MAX:]:
            picked.setdefault(number[p["_id"]], p)
    if not picked:
        return [], len(before), missing
    from firebase_admin import storage
    bucket = storage.bucket(PHOTO_BUCKET)
    out = []
    for n in sorted(picked):
        p = picked[n]
        try:
            raw = bucket.blob(p["path"]).download_as_bytes()
        except Exception as e:                      # noqa: BLE001
            print("estimates: photo not read:", p.get("path"), e)
            continue
        out.append((n, str(p.get("stage") or ""), str(p.get("caption") or "").strip()[:200],
                    base64.b64encode(_shrink(raw)).decode("ascii")))
    return out, len(before), missing


def _photo_blocks(photos, total, newest=True, missing=()):
    """The photos as the first part of the message: what they are, then each
    under its number on the job (Jonah calls them by it), with its caption."""
    if not photos and not missing:
        return []
    shown = sum(1 for p in photos if p[1] == "before")
    more = " -- the newest %d of its %d Before photos" % (shown, total) if newest and total > shown else ""
    text = ("PHOTOS OF THE JOB (%d%s), taken by Jonah or the crew, each under its number on the job -- Jonah refers "
            "to them by it (\"photo 7\"). Use them with his notes to understand the site -- what is there now, "
            "access for the loader, slopes, what has to come out, the state of what is being replaced. Never take a "
            "measurement from a photo that his notes do not give: ask for it instead. Say what you saw in them only "
            "where it matters to the estimate." % (len(photos), more))
    if missing:
        text += " There is no photo %s on this job." % ", ".join(str(n) for n in missing)
    blocks = [{"type": "text", "text": text}]
    for n, stage, caption, data in photos:
        label = "Photo %d%s%s" % (n, " (%s)" % stage.capitalize() if stage else "", ": " + caption if caption else "")
        blocks.append({"type": "text", "text": label})
        blocks.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}})
    return blocks


def _photo_nums(v):
    """The photo numbers the app read in his message (estimate.js photoNumsIn)."""
    out = []
    for x in (v if isinstance(v, list) else [])[:40]:
        if isinstance(x, (int, float)) and not isinstance(x, bool) and x == int(x) and 1 <= x <= 9999:
            out.append(int(x))
    return sorted(set(out))


# ----------------------------------------------------------------- the call

def _model(db):
    try:
        snap = db.collection("settings").document("claude").get()
        pick = ((snap.to_dict() or {}) if snap.exists else {}).get("estimateModel")
    except Exception as e:                          # noqa: BLE001
        print("estimates: could not read the model setting:", e)
        pick = None
    return MODELS.get(pick, MODEL)


def draft(client, d):
    """Returns (result, usage). result: {reply, updated, work, materials,
    spoilCuYd, questions, flags} with every id checked; or {error}. A snow
    bid (d.snow) is talked about by draft_snow instead."""
    if not (d.get("chat") or []):
        return {"error": "Write a message first"}, None
    if isinstance(d.get("snow"), dict):
        return draft_snow(client, d)
    current = d.get("current") or {}
    on_estimate = [str(m.get("supplyId")) for m in current.get("materials") or [] if m.get("supplyId")]
    db = dg._db()
    # Supplies (kept a few minutes), with the items on this estimate read
    # fresh: their kinds always go in the catalogue.
    supplies = _supplies(db, on_estimate)
    kinds_on = {(supplies[0][i].get("category") or "other") for i in on_estimate[:200] if i in supplies[0]}
    words = " ".join([str(d.get("siteNotes") or ""), str(d.get("jobNotes") or ""),
                      " ".join(str(x) for x in d.get("services") or []),
                      " ".join(str(m.get("text") or "") for m in (d.get("chat") or [])[-30:]
                               if m.get("role") == "user")])
    kinds = kinds_for(words, kinds_on)
    # His usual grass seed (the app's Pricing rules, in its biggest bag).
    usual = str(d.get("usualSeed") or "")
    usual = usual if usual in supplies[0] and supplies[0][usual].get("category") not in NOT_FOR_ESTIMATES else ""
    cat_text, supply_ids = catalogue(kinds, on_estimate + ([usual] if usual else []), supplies, usual)
    if kinds is not None:
        cat_text += ("\n\n(Only the kinds of material this job's notes call for are listed. If it "
                     "needs something not here, add it with an empty supplyId and a clear name.)")
    if usual:
        cat_text += ("\n\nGRASS SEED: whenever the job needs grass seed and Jonah has not named another seed for "
                     "it, use %s (%s), his usual. A seed sold in bags is listed in its biggest bag only: it is "
                     "bought that way and the app charges the job for the part used." % (
                         usual, supplies[0][usual].get("name")))
    book = price_book()
    model = _model(db)
    work_ids = {str(w.get("id")) for w in current.get("work") or [] if w.get("id")}
    mat_ids = {str(m.get("id")) for m in current.get("materials") or [] if m.get("id")}

    # Everything that stays the same from one message to the next comes
    # first and is cached; the job and the conversation come after it.
    system = [
        {"type": "text", "text": SYSTEM},
        {"type": "text", "text": "JONAH'S TAKEOFF AND ESTIMATE RULES (his words):\n\n" + rules_text()},
        {"type": "text", "text": "SUPPLIES CATALOGUE (pick materials by id):\n" + cat_text +
                                 "\n\nSERVICES (how Jonah prices each kind of work -- read before pricing any labour):\n" + _book_text(book),
         # An hour, not five minutes: Jonah reads, edits and comes back to a
         # bid, and every miss re-buys the whole catalogue and rules.
         "cache_control": {"type": "ephemeral", "ttl": "1h"}},
    ]
    first = len(d.get("chat") or []) <= 1
    # The photos, when the app asks for them: the newest site-visit ones (the
    # first build, or a message about the photos) and any he names by number
    # -- never cached: they come after the rules.
    newest, nums = d.get("photos") is True, _photo_nums(d.get("photoNums"))
    photos, photos_total, missing = _photos(db, d.get("jobId"), newest, nums) if newest or nums else ([], 0, [])
    with client.beta.messages.stream(
        model=model, max_tokens=64000, system=system,
        messages=[{"role": "user", "content": _photo_blocks(photos, photos_total, newest, missing) +
                   [{"type": "text", "text": _prompt(d)}]}],
        thinking={"type": "adaptive"},
        # The first build is the careful one; a follow-up ("make it 18x20")
        # should come back while he is still looking at the screen.
        output_config={"effort": "high" if first else "medium",
                       "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    ) as stream:
        resp = stream.get_final_message()
    if resp.stop_reason == "refusal":
        return {"error": "Claude declined to do this one", "model": model}, resp.usage
    if resp.stop_reason == "max_tokens":
        return {"error": "That estimate came out too long. Try it in parts.", "model": model}, resp.usage
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        got = json.loads(text)
    except ValueError:
        return {"error": "Claude's answer could not be read. Try again.", "model": model}, resp.usage

    work = []
    for w in got.get("work") or []:
        kind = w.get("kind") if w.get("kind") in ("crew", "flat", "amount", "allin") else "crew"
        pid = str(w.get("priceId") or "")
        # A 'flat' line only for a service that has a price (by the unit or
        # fixed); its adjustments only from that service's own list.
        svc = book.get(pid) if pid in book and (book[pid].get("method") or "unit") != "crew" else None
        own = {str(f.get("id")) for f in ((svc or {}).get("factors") or []) if isinstance(f, dict) and f.get("id")}
        work.append({
            "id": str(w.get("id") or "") if str(w.get("id") or "") in work_ids else "",
            "title": str(w.get("title") or "").strip()[:200],
            "scope": str(w.get("scope") or "").strip()[:6000],
            "kind": "flat" if kind == "flat" and svc else ("crew" if kind == "flat" else kind),
            "crewDays": max(0.0, round(_num(w.get("crewDays")) or 0, 2)),
            "priceId": pid if svc else "",
            "qty": max(0.0, round(_num(w.get("qty")) or 0, 2)),
            "factors": [str(f) for f in (w.get("factors") or []) if str(f) in own][:20] if svc else [],
            "amountDollars": max(0.0, round(_num(w.get("amountDollars")) or 0, 2)),
            "allInDollars": max(0.0, round(_num(w.get("allInDollars")) or 0, 2)) if kind == "allin" else 0.0,
            "addDollars": max(0.0, round(_num(w.get("addDollars")) or 0, 2)) if kind == "allin" else 0.0,
            # The crew's version of the line (estimate.js puts it in the
            # line's notes for the crew while those are not his own).
            "crew": str(w.get("crew") or "").strip()[:1500],
        })
    # An all-in line a material's price is in: an id on the estimate, or the
    # title of a line given in this answer (the app joins it to its new id).
    allin_refs = {i for i in work_ids} | {w["title"].lower() for w in work if w["kind"] == "allin" and w["title"]}
    materials = []
    for m in got.get("materials") or []:
        sid = str(m.get("supplyId") or "")
        ref = str(m.get("allInOf") or "").strip()[:200]
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
            "allInOf": ref if ref in allin_refs or ref.lower() in allin_refs else "",
        })
    patching = _patching(d)
    removed = [str(i) for i in got.get("removed") or [] if str(i) in work_ids or str(i) in mat_ids] if patching else []
    return {"reply": str(got.get("reply") or "").strip(), "updated": bool(got.get("updated", True)),
            "mode": "patch" if patching else "whole", "removed": removed,
            "work": work, "materials": materials,
            "spoilCuYd": max(0.0, round(_num(got.get("spoilCuYd")) or 0, 1)),
            "brushCuYd": max(0.0, round(_num(got.get("brushCuYd")) or 0, 1)),
            "questions": [str(q) for q in got.get("questions") or [] if str(q).strip()],
            "flags": [str(q) for q in got.get("flags") or [] if str(q).strip()],
            "photos": len(photos), "photosTotal": photos_total, "photoNums": [p[0] for p in photos],
            "catalogueSize": len(supply_ids), "model": model}, resp.usage


# ----------------------------------------------------------------- snow bids
#
# Jonah (16 Oct 2026): "the built in estimate builder clearly doesnt
# understand quoting snow and is asking the miles to job and back how much
# salt will be used for the whole season when it should know i bid snow at
# the moment per push." A snow bid (estimate.js) is a price sheet, not a
# takeoff: a price per push by depth, salt per application, extras per visit,
# maybe an hourly rate for long storms -- every figure his, typed in its box.
# The app picks what gets cleared from his notes itself (plain words, no
# Claude). Only when he talks to Claude about one does it come here: no
# catalogue, no takeoff rules, no services list -- none of it is wanted --
# and a smaller model, since all it may change is words.
SNOW_MODEL = "claude-sonnet-5-5"
# What gets cleared (estimate.js SNOW_AREAS): the ids Claude may give.
SNOW_AREAS = {
    "driveway": "driveway", "walkways": "walkways", "mailbox": "mailbox", "steps": "steps",
    "sidewalk": "public sidewalk", "patio": "patio", "deck": "deck", "lot": "parking lot",
    "entrances": "entrances", "dumpster": "dumpster area",
}

SNOW_SYSTEM = (
    "You help Jonah Linfield of YD Exterior Visions LLC, a landscaping and snow removal company near Madison, "
    "Wisconsin, with a SNOW REMOVAL bid, inside Job Hub, the company's app.\n\n"
    "Snow is bid PER PUSH -- a price for each visit, each snowfall -- never as a project. A snow bid is: what gets "
    "cleared (driveway, walkways, mailbox, steps...); a price per push by depth (1-3 in, 3-6 in, sometimes 6-9 in and "
    "9 in+), or the 1-3 in price plus so much for each inch over a depth; salt or ice melt per application "
    "(sometimes paw-friendly); extras per visit (a back deck, steps); sometimes a labour rate per man-hour for long "
    "storms; residential or commercial. There is NO takeoff, NO materials, NO trip miles or fuel, NO crew-days, NO "
    "dumpsters, NO season totals of salt or visits, NO deposit or payment plan -- never ask about any of them and "
    "never bring them up.\n\n"
    "Every price is Jonah's own: he types each one in its box. You never set, suggest, estimate or change a price "
    "or say what one should be -- if he asks you to change one, tell him which box to type it in. What you can "
    "change: which areas get cleared (`areas`, ids from the list given, and `areasOther` for anything else in a "
    "few plain words), extras by NAME only (`extras`: the price box stays his to fill), and the notes for the crew "
    "(`crewNotes`: what the crew should know on site -- never shown to the customer, never a price). Never invent "
    "an area or an extra Jonah did not mention.\n\n"
    "QuickBooks: you only build the bid -- you never put it in QuickBooks or send it, and never say you have. "
    "Jonah does that himself with the buttons under it, 'Put in QuickBooks, don't email yet' and 'Send through "
    "QuickBooks', so he can add tags in QuickBooks first; when he asks, tell him which button to tap.\n\n"
    "`reply` answers his latest message: short and plain, like a colleague. When he asks for a change set updated "
    "to true and give areas, areasOther, extras and crewNotes as they should now be (all of them, changed or not); "
    "when he only asks something, updated is false and they are left as they are. `questions`: only what blocks a "
    "right bid. `flags`: anything he should know but need not answer."
)

SNOW_SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "updated": {"type": "boolean"},
        "areas": {"type": "array", "items": {"type": "string", "enum": sorted(SNOW_AREAS)}},
        "areasOther": {"type": "string"},
        "extras": {"type": "array", "items": {"type": "string"}},
        "crewNotes": {"type": "string"},
        "questions": {"type": "array", "items": {"type": "string"}},
        "flags": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["reply", "updated", "areas", "areasOther", "extras", "crewNotes", "questions", "flags"],
    "additionalProperties": False,
}
# A figure written into the crew's notes: blanked, as the crew's page does.
SNOW_MONEY = re.compile(r"\$\s*[\d,]+(?:\.\d+)?")


def _money_said(v):
    n = _num(v)
    return ("$%.2f" % n) if n is not None and n > 0 else "(empty)"


def _snow_text(s):
    """The snow bid as it stands on screen, for Claude to talk about."""
    s = s or {}
    rows = ["Customer is: %s" % ("a business (commercial)" if s.get("type") == "commercial" else "a home (residential)")]
    areas = [SNOW_AREAS[a] + " [" + a + "]" for a in (s.get("areas") or []) if a in SNOW_AREAS]
    rows.append("What gets cleared: %s" % (", ".join(areas) or "(nothing picked yet)"))
    if str(s.get("areasOther") or "").strip():
        rows.append("Also cleared (in his words): %s" % str(s["areasOther"]).strip()[:300])
    p = s.get("prices") or {}
    pi = s.get("perInch") or {}
    if s.get("mode") == "perInch":
        rows.append("Priced as: the 1-3 in price %s, plus %s for each inch over 3 in" % (
            _money_said(p.get("1-3")), _money_said(pi.get("dollars"))))
    else:
        rows.append("Price per push: 1-3 in %s; 3-6 in %s; 6-9 in %s; 9 in+ %s" % tuple(
            _money_said(p.get(k)) for k in ("1-3", "4-6", "6+", "9+")))
        if _num(pi.get("dollars")):
            rows.append("Each inch over %s in: %s" % (pi.get("over") or 6, _money_said(pi.get("dollars"))))
    salt = s.get("salt") or {}
    rows.append("Salt per application: %s%s" % (_money_said(salt.get("dollars")),
                                                " (paw-friendly ice melt)" if salt.get("paw") else ""))
    for x in (s.get("extras") or [])[:20]:
        rows.append("Extra per visit: %s %s" % (str((x or {}).get("name") or "")[:80], _money_said((x or {}).get("dollars"))))
    if _num(s.get("laborDollars")):
        rows.append("Labour for long storms: %s per man-hour" % _money_said(s.get("laborDollars")))
    rows.append("Notes for the crew: %s" % (str(s.get("crewNotes") or "").strip()[:1500] or "(none)"))
    rows.append("(The prices are Jonah's -- for talking about only; never change them.)")
    return "\n".join(rows)


def _snow_prompt(d):
    chat = [m for m in (d.get("chat") or []) if isinstance(m, dict) and str(m.get("text") or "").strip()]
    return "\n".join([
        "Today is %s." % dg._long_day(dg._now().date()),
        "Customer: %s" % (str(d.get("customer") or "").strip() or "(no name)"),
        "Where: %s" % (str(d.get("location") or "").strip() or "(not given)"),
        "Services: %s" % (", ".join(str(s) for s in d.get("services") or []) or "(not given)"),
        "",
        "JONAH'S NOTES FROM THE SITE VISIT:",
        str(d.get("siteNotes") or "").strip()[:6000] or "(none written)",
        "",
        "Other notes on the job (context):",
        str(d.get("jobNotes") or "").strip()[:2000] or "(none)",
        "",
        "THE SNOW BID AS IT STANDS:",
        _snow_text(d.get("snow")),
        "",
        "Area ids you may use: " + ", ".join("%s = %s" % kv for kv in sorted(SNOW_AREAS.items())),
        "",
        "THE CONVERSATION SO FAR:",
        _chat_text(chat[:-1]) or "(this is the first message)",
        "",
        "JONAH'S LATEST MESSAGE:",
        str(chat[-1].get("text") or "")[:4000] if chat else "(none)",
    ])


def draft_snow(client, d):
    """Talking about a snow bid. Returns (result, usage): {mode 'snow', reply,
    updated, areas, areasOther, extras, crewNotes, questions, flags}."""
    with client.beta.messages.stream(
        model=SNOW_MODEL, max_tokens=8000,
        system=[{"type": "text", "text": SNOW_SYSTEM}],
        messages=[{"role": "user", "content": _snow_prompt(d)}],
        thinking={"type": "adaptive"},
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SNOW_SCHEMA}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    ) as stream:
        resp = stream.get_final_message()
    if resp.stop_reason == "refusal":
        return {"error": "Claude declined to do this one", "model": SNOW_MODEL}, resp.usage
    if resp.stop_reason == "max_tokens":
        return {"error": "That answer came out too long. Try again.", "model": SNOW_MODEL}, resp.usage
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        got = json.loads(text)
    except ValueError:
        return {"error": "Claude's answer could not be read. Try again.", "model": SNOW_MODEL}, resp.usage
    seen, extras = set(), []
    for x in got.get("extras") or []:
        name = " ".join(str(x or "").split())[:60]
        if name and name.lower() not in seen:
            seen.add(name.lower())
            extras.append(name)
    return {"mode": "snow", "reply": str(got.get("reply") or "").strip(), "updated": bool(got.get("updated")),
            "areas": [a for a in got.get("areas") or [] if a in SNOW_AREAS],
            "areasOther": " ".join(str(got.get("areasOther") or "").split())[:300],
            "extras": extras[:12],
            # Never a figure for the crew's eyes, whatever was written.
            "crewNotes": SNOW_MONEY.sub("$—", str(got.get("crewNotes") or "").strip())[:2000],
            "questions": [str(q) for q in got.get("questions") or [] if str(q).strip()],
            "flags": [str(q) for q in got.get("flags") or [] if str(q).strip()],
            "model": SNOW_MODEL}, resp.usage
