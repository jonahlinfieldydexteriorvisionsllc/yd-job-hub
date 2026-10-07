"""A supplier's price sheet sent as a PDF or a photo, read into rows for the
Supplies price list (Supplies -> a supplier -> Price list).

Claude reads it -- this is real reading, not something code can do. Nothing is
saved here: the rows go back to the app's check-then-save screen, which shows
every new item and every price that moves before anything is kept, exactly as
for a spreadsheet.

Built for what arrives in the course of business -- a quote, a page or two of
a price sheet, a phone photo of one. A whole catalogue is too long to read in
one go; it is refused with a note to split it.
"""

import base64
import json
import re

MODEL = "claude-opus-5-5"
MAX_BYTES = 20 * 1024 * 1024
MAX_PAGES = 12
IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}

# The same category ids as pricing.js (never rename one -- they are stored).
CATEGORIES = ["soil", "fill", "mulch", "stone", "pavers", "wall", "natural", "edging", "hardscape",
              "adhesive", "drainage", "seed", "bagged", "planting", "plant", "dumpster", "hardware",
              "rental", "tools", "other"]

SYSTEM = """You read a landscape and hardscape supplier's price sheet, quote or price list for YD
Exterior Visions, a landscaping company, and copy every priced product into rows. The rows are
checked by the owner before anything is saved, but they go into the cost list every estimate is
priced from, so accuracy matters more than anything:

- Copy numbers exactly as printed. Never guess, round or work out a price. A row whose price you
  cannot read is left out and named in `unreadable`.
- When the sheet shows more than one price for a product (retail and contractor/trade/net, list
  and discounted, price breaks by quantity), `price` is the price the contractor pays for a normal
  order -- trade/contractor/net -- and the others go in `priceNotes`.
- `per` is what the price is per, in plain words: ton, yard, sq ft, face sq ft, LF, each, bag,
  pallet, roll, box, gallon... When a per-sq-ft (or per-LF) price and a per-pallet price are both
  given, use the per-sq-ft / per-LF one and put the other in `priceNotes`.
- `item` is a clear product name a landscaper would recognise: line + product + size/thickness
  (+ colour only when that colour has its own price). When a product is one the company already
  buys from this supplier (the list given with the sheet), use that exact name.
- `itemNo` is the supplier's item / SKU number if printed, else "". `comesIn` is the package
  ("50 lb bag", "pallet (94 sq ft)") if printed, else "".
- `notes` holds useful product facts for the crew (colours, sizes, coverage, pieces per pallet)
  -- never prices. `priceNotes` holds everything else about price (minimums, other units,
  surcharges, "price by layer").
- `category` is one of the given ids when it is clear, else "".
- Section headings, freight tables, terms and blank rows are not products. Delivery and freight
  charges are left out (the company prices delivery its own way).
`notes` at the end: anything the owner should know about the sheet itself (its date, who it is
for, prices that look like they need checking)."""

ROW = {
    "type": "object", "additionalProperties": False,
    "required": ["item", "itemNo", "comesIn", "price", "per", "category", "notes", "priceNotes"],
    "properties": {
        "item": {"type": "string"}, "itemNo": {"type": "string"}, "comesIn": {"type": "string"},
        "price": {"type": "number"}, "per": {"type": "string"},
        "category": {"type": "string", "enum": CATEGORIES + [""]},
        "notes": {"type": "string"}, "priceNotes": {"type": "string"},
    },
}
SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["rows", "unreadable", "notes"],
    "properties": {
        "rows": {"type": "array", "items": ROW},
        "unreadable": {"type": "array", "items": {"type": "string"}},
        "notes": {"type": "string"},
    },
}


def _pages(raw):
    """Roughly how many pages a PDF has (0 when it cannot tell)."""
    return len(re.findall(rb"/Type\s*/Page(?![a-zA-Z])", raw))


def read(client, body):
    """Returns ({rows, unreadable, notes} or {error}, usage or None)."""
    mime = str(body.get("mediaType") or "").lower()
    if mime == "image/jpg":
        mime = "image/jpeg"
    if mime != "application/pdf" and mime not in IMAGE_TYPES:
        return {"error": "That kind of file can't be read — send a PDF or a photo (JPEG or PNG)"}, None
    data = re.sub(r"\s+", "", str(body.get("data") or ""))
    try:
        raw = base64.b64decode(data, validate=True)
    except Exception:                                   # noqa: BLE001
        return {"error": "The file didn't arrive whole — try again"}, None
    if not raw:
        return {"error": "The file is empty"}, None
    if len(raw) > MAX_BYTES:
        return {"error": "That file is too big to read here (over 20 MB)"}, None
    if mime == "application/pdf" and _pages(raw) > MAX_PAGES:
        return {"error": "That's a long document (%d pages). Send the pages with the prices you need — up to %d at a "
                         "time — or hand the whole book to Claude in a chat." % (_pages(raw), MAX_PAGES)}, None

    vendor = str(body.get("vendor") or "").strip()[:100]
    known = [str(n).strip()[:120] for n in (body.get("known") or []) if str(n).strip()][:400]
    kind = "document" if mime == "application/pdf" else "image"
    content = [
        {"type": kind, "source": {"type": "base64", "media_type": mime, "data": data}},
        {"type": "text", "text": "Supplier: %s\nCategory ids: %s\n\nItems we already buy from them:\n%s\n\n"
                                 "Read every priced product on this sheet." % (
                                     vendor or "(not given)", ", ".join(CATEGORIES),
                                     "\n".join(known) if known else "(none yet)")},
    ]
    # Streamed: a page of prices can be a long answer, and a long answer that
    # is not streamed can time out on its way back.
    with client.beta.messages.stream(
        model=MODEL, max_tokens=48000, system=SYSTEM,
        messages=[{"role": "user", "content": content}],
        thinking={"type": "adaptive"},
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    ) as stream:
        resp = stream.get_final_message()
    if resp.stop_reason == "refusal":
        return {"error": "Claude wouldn't read that file"}, resp.usage
    if resp.stop_reason == "max_tokens":
        return {"error": "Too many prices on it to read in one go — send fewer pages at a time"}, resp.usage
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        out = json.loads(text)
    except ValueError:
        return {"error": "The sheet couldn't be read — try a clearer copy"}, resp.usage
    rows = [r for r in out.get("rows") or [] if str(r.get("item") or "").strip() and
            isinstance(r.get("price"), (int, float)) and r["price"] >= 0]
    return {"rows": rows, "unreadable": [str(u) for u in out.get("unreadable") or []][:50],
            "notes": str(out.get("notes") or "")}, resp.usage
