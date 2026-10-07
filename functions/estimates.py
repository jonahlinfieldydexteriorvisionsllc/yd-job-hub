"""Claude builds an estimate from the owner's notes and his price book.

Jonah describes the work the way he would to a person ("16x20 paver patio,
two steps, 40 ft of steel edging, haul away the old deck"); Claude turns that
into estimate lines. The split between Claude and plain code is deliberate:

  * Claude does the reading and judgement -- which price-book entries the work
    needs, the quantities (a 16x20 patio is 320 sq ft), sections, the wording
    the customer reads, and what is missing.
  * Code does the money. Every rate on a price-book line is copied from the
    price book here, never taken from Claude's answer, so an estimate cannot go
    out at a price Jonah did not set. Totals are worked out by the app.

Anything the price book does not cover comes back as a line with no price and
a question, rather than a guess.

It is a conversation because that is how Jonah works with Claude: "make the
patio 18x20", "add a fire pit", "why is the base so much?". Each call carries
the whole conversation so far and the estimate as it stands on screen (he may
have changed lines by hand), and Claude answers in words and, when he asked
for a change, with the whole estimate as it should now be. Nothing is kept on
the server; the conversation is saved with the job.
"""

import json

import digest as dg

# Jonah's choice (6 Oct): the most capable model for estimates -- they need the
# most judgement of anything in the app, and he is used to working with it.
# About 25 cents a message; the rest of the app stays on Opus 5.5.
MODEL = "claude-fable-5-1"

SYSTEM = (
    "You build estimates for YD Exterior Visions LLC, a landscaping, hardscaping and snow "
    "removal company near Madison, Wisconsin, owned by Jonah Linfield. Jonah gives you his "
    "notes on a job and his price book; you lay out the estimate lines.\n\n"
    "Rules that matter:\n"
    "- Price only from the price book. For each line of work, pick the price-book entry by its "
    "id and give the quantity in that entry's unit. Work quantities out from his measurements "
    "(a 16x20 patio is 320 sq ft; 3 in of mulch over 600 sq ft is about 5.6 cu yd). Follow the "
    "entry's notes -- they are Jonah's pricing rules (minimums, what is included, waste).\n"
    "- Never invent a price. Work the price book does not cover goes in as a line with an "
    "empty priceId and rate 0 -- unless Jonah's notes give the price, then use it -- and add a "
    "question saying what needs pricing.\n"
    "- Never invent work Jonah did not mention. If something obviously needed is missing "
    "(e.g. base prep for a patio and the price book prices it separately), add it only if his "
    "notes or the entry's notes call for it; otherwise ask.\n"
    "- Group the lines into sections by area or kind of work when there is more than one "
    "(a section line has a title and nothing else). One section needs no heading.\n"
    "- Descriptions are what the customer reads: short, plain, specific (materials, size, "
    "colour when given). No prices in descriptions.\n"
    "- The message is the scope of work for the customer: what will be done and what they end "
    "up with, short paragraphs, no prices, no marketing language. Mention exclusions only if "
    "the notes give them.\n"
    "- Questions are for Jonah, short, only what actually blocks a right price.\n\n"
    "You are talking with Jonah. `reply` is your answer to his latest message: short and "
    "plain, like a colleague -- say what you changed, or answer what he asked. When he asks "
    "for a change, or there is no estimate yet, set updated to true and give the WHOLE "
    "estimate as it should now be (every line, not just the changed ones), keeping lines he "
    "did not mention exactly as they are -- including ones he edited by hand. When he only "
    "asks a question, set updated to false and give the lines unchanged."
)

SCHEMA = {
    "type": "object",
    "properties": {
        "lines": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": ["section", "item"]},
                "title": {"type": "string"},
                "priceId": {"type": "string"},
                "description": {"type": "string"},
                "qty": {"type": "number"},
                "unit": {"type": "string"},
                "rate": {"type": "number"},
            },
            "required": ["type", "title", "priceId", "description", "qty", "unit", "rate"],
            "additionalProperties": False,
        }},
        "message": {"type": "string"},
        "questions": {"type": "array", "items": {"type": "string"}},
        "reply": {"type": "string"},
        "updated": {"type": "boolean"},
    },
    "required": ["reply", "updated", "lines", "message", "questions"],
    "additionalProperties": False,
}


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
        cents = p.get("priceCents")
        price = ("$%.2f" % (cents / 100)) if isinstance(cents, int) else "(no price)"
        row = "- id %s | %s | %s per %s" % (pid, p.get("name"), price, p.get("unit") or "each")
        if p.get("category"):
            row += " | %s" % p["category"]
        if p.get("description"):
            row += " | says: %s" % str(p["description"])[:300]
        if p.get("notes"):
            row += " | Jonah's rule: %s" % str(p["notes"])[:500]
        rows.append(row)
    return "\n".join(rows) or "(the price book is empty)"


def _current_text(cur, book):
    """The estimate as it stands on screen, for Claude to change."""
    rows = []
    for ln in (cur or {}).get("lines") or []:
        if ln.get("kind") == "section":
            rows.append("SECTION: %s" % str(ln.get("description") or "")[:200])
            continue
        try:
            rate = "$%.2f" % (int(ln.get("rateCents") or 0) / 100)
        except (TypeError, ValueError):
            rate = "$0.00"
        pid = str(ln.get("priceId") or "")
        rows.append("- priceId %s | %s | qty %s %s | rate %s" % (
            pid if pid in book else "(none)", str(ln.get("description") or ln.get("name") or "")[:300],
            ln.get("qty"), str(ln.get("unit") or "")[:20], rate))
    memo = str((cur or {}).get("memo") or "").strip()
    return ("\n".join(rows) or "(no lines yet)") + "\n\nMessage on the estimate now:\n" + (memo[:3000] or "(none)")


def _chat_text(chat):
    out = []
    for m in (chat or [])[-30:]:
        who = "Jonah" if m.get("role") == "user" else "You"
        out.append("%s: %s" % (who, str(m.get("text") or "")[:2000]))
    return "\n\n".join(out)


def _prompt(d, book):
    chat = [m for m in (d.get("chat") or []) if isinstance(m, dict) and str(m.get("text") or "").strip()]
    if chat:
        return "\n".join([
            "Today is %s." % dg._long_day(dg._now().date()),
            "Customer: %s" % (str(d.get("customer") or "").strip() or "(no name)"),
            "Where: %s" % (str(d.get("location") or "").strip() or "(not given)"),
            "Services: %s" % (", ".join(d.get("services") or []) or "(not given)"),
            "His other notes on the job (context):",
            str(d.get("notes") or "").strip()[:3000] or "(none)",
            "",
            "PRICE BOOK:",
            _book_text(book),
            "",
            "THE ESTIMATE AS IT STANDS (rates shown are what is on it now):",
            _current_text(d.get("current"), book),
            "",
            "THE CONVERSATION SO FAR:",
            _chat_text(chat[:-1]) or "(this is the first message)",
            "",
            "JONAH'S LATEST MESSAGE:",
            str(chat[-1].get("text") or "")[:6000],
        ])
    return "\n".join([
        "Today is %s." % dg._long_day(dg._now().date()),
        "Customer: %s" % (str(d.get("customer") or "").strip() or "(no name)"),
        "Where: %s" % (str(d.get("location") or "").strip() or "(not given)"),
        "Services: %s" % (", ".join(d.get("services") or []) or "(not given)"),
        "",
        "WHAT JONAH WANTS PRICED:",
        str(d.get("ask") or "").strip()[:6000] or "(nothing written)",
        "",
        "His other notes on the job (context):",
        str(d.get("notes") or "").strip()[:3000] or "(none)",
        "",
        "PRICE BOOK:",
        _book_text(book),
    ])


def draft(client, d):
    """Returns (result, usage). result: {lines, message, questions} with every
    price-book line priced from the book; or {error}."""
    if not str(d.get("ask") or "").strip() and not (d.get("chat") or []):
        return {"error": "Write what to price first"}, None
    book = price_book()
    resp = client.beta.messages.create(
        model=MODEL, max_tokens=16000, system=SYSTEM,
        messages=[{"role": "user", "content": _prompt(d, book)}],
        thinking={"type": "adaptive"},
        # The first build is the careful one; a follow-up ("make it 18x20")
        # should come back while he is still looking at the screen.
        output_config={"effort": "high" if len(d.get("chat") or []) <= 1 else "medium",
                       "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    )
    if resp.stop_reason == "refusal":
        return {"error": "Claude declined to price this one"}, resp.usage
    if resp.stop_reason == "max_tokens":
        return {"error": "That estimate came out too long. Try it in parts."}, resp.usage
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        got = json.loads(text)
    except ValueError:
        return {"error": "Claude's answer could not be read. Try again."}, resp.usage

    lines, questions = [], [str(q) for q in got.get("questions") or [] if str(q).strip()]
    for ln in got.get("lines") or []:
        if ln.get("type") == "section":
            title = str(ln.get("title") or ln.get("description") or "").strip()
            if title:
                lines.append({"kind": "section", "description": title[:200]})
            continue
        try:
            qty = max(0.0, round(float(ln.get("qty") or 0), 2))
        except (TypeError, ValueError):
            qty = 0.0
        p = book.get(str(ln.get("priceId") or ""))
        if p:
            lines.append({"kind": "item", "priceId": str(ln["priceId"]), "name": p.get("name", ""),
                          "description": str(ln.get("description") or p.get("description") or p.get("name") or "")[:1000],
                          "qty": qty, "unit": p.get("unit") or "each",
                          "rateCents": p.get("priceCents") if isinstance(p.get("priceCents"), int) else 0})
        else:
            try:
                cents = max(0, int(round(float(ln.get("rate") or 0) * 100)))
            except (TypeError, ValueError):
                cents = 0
            lines.append({"kind": "item", "priceId": None, "name": "",
                          "description": str(ln.get("description") or ln.get("title") or "")[:1000],
                          "qty": qty, "unit": str(ln.get("unit") or "")[:20],
                          "rateCents": cents, "needsPrice": cents == 0})
    return {"lines": lines, "message": str(got.get("message") or "").strip(),
            "questions": questions, "reply": str(got.get("reply") or "").strip(),
            "updated": bool(got.get("updated", True)), "bookSize": len(book)}, resp.usage
