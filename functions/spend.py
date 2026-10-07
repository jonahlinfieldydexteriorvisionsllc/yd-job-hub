"""What Claude costs, in money, and a ceiling on it per day and per month.

Every call to Claude is written into claudeUsage/{day} as cents -- worked out
here from the call's token counts at Anthropic's list prices -- beside the
token counts the app always kept. The token counts alone hid most of the
bill: an estimate message re-sends the Supplies catalogue and the takeoff
rules every time, and those count as cache tokens, not input tokens, so a
day that looked like a few hundred thousand tokens cost several dollars.

Two ceilings, set on the app's Pricing rules screen (the defaults below
until they are): settings/claude.monthlyCapCents -- what Jonah is willing to
spend in a month (7 Oct: not $90 a month) -- and settings/claude.dailyCapCents,
so one busy day cannot use up the month. Reaching either stops every Claude
feature -- the board cards, the receipts reader and anything pressed in the
app alike -- until the next day (or month), midnight UTC. The month's total
is kept in claudeUsageMonths/{YYYY-MM} (server only) so the check is one read.
"""

import datetime

from firebase_admin import firestore

# List price per million tokens: input, output, cache read. A cache write
# costs 1.25x input (5-minute entry) or 2x (1-hour entry).
PRICES = {
    "claude-fable-5-1": (10.0, 50.0, 0.25),
    "claude-opus-5-5": (4.0, 20.0, 0.20),
    "claude-sonnet-5-5": (2.0, 10.0, 0.20),
    "claude-haiku-4-5-20251001": (1.0, 5.0, 0.10),
}
WEB_SEARCH_CENTS = 1.0          # $10 per 1,000 searches
DEFAULT_CAP_CENTS = 200         # $2 a day until Jonah sets his own
DEFAULT_MONTH_CAP_CENTS = 2000  # $20 a month until Jonah sets his own


def _get(obj, key):
    if obj is None:
        return 0
    v = obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)
    return v or 0


def cents(model, usage):
    """One call's cost in cents (a fraction is kept: many calls are under one)."""
    if usage is None:
        return 0.0
    # A model not in the table is priced as the dearest one, never as free.
    inp, out, read = PRICES.get(model) or PRICES["claude-fable-5-1"]
    written = _get(usage, "cache_creation_input_tokens")
    by_ttl = _get(usage, "cache_creation")
    hour = _get(by_ttl, "ephemeral_1h_input_tokens") if by_ttl else 0
    five = written - hour
    dollars = (_get(usage, "input_tokens") * inp + _get(usage, "output_tokens") * out +
               _get(usage, "cache_read_input_tokens") * read +
               five * inp * 1.25 + hour * inp * 2) / 1e6
    searches = _get(_get(usage, "server_tool_use"), "web_search_requests")
    return dollars * 100 + searches * WEB_SEARCH_CENTS


def today():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")


def this_month():
    return today()[:7]


def add(db, day, task, amount_cents, usage=None, count=True):
    """Adds a call's cost (and its tokens) to the day's record."""
    patch = {"costCents": firestore.Increment(round(amount_cents, 3)),
             "byTaskCents": {task: firestore.Increment(round(amount_cents, 3))}}
    if count:
        patch["byTask"] = {task: firestore.Increment(1)}
    if usage is not None:
        patch["inputTokens"] = firestore.Increment(_get(usage, "input_tokens"))
        patch["outputTokens"] = firestore.Increment(_get(usage, "output_tokens"))
        patch["cacheWriteTokens"] = firestore.Increment(_get(usage, "cache_creation_input_tokens"))
        patch["cacheReadTokens"] = firestore.Increment(_get(usage, "cache_read_input_tokens"))
    try:
        db.collection("claudeUsage").document(day).set(patch, merge=True)
        db.collection("claudeUsageMonths").document(day[:7]).set(
            {"costCents": firestore.Increment(round(amount_cents, 3))}, merge=True)
    except Exception as e:                          # noqa: BLE001 -- never fail a good answer over bookkeeping
        print("spend: could not record:", e)


def record(db, day, task, model, usage):
    """add() for one call, priced from its usage."""
    add(db, day, task, cents(model, usage), usage)


def caps(db):
    """(daily, monthly) ceilings in cents."""
    try:
        snap = db.collection("settings").document("claude").get()
        got = (snap.to_dict() or {}) if snap.exists else {}
    except Exception as e:                          # noqa: BLE001
        print("spend: could not read the limits:", e)
        got = {}
    pick = lambda k, d: float(got[k]) if isinstance(got.get(k), (int, float)) and got[k] >= 0 else d
    return pick("dailyCapCents", DEFAULT_CAP_CENTS), pick("monthlyCapCents", DEFAULT_MONTH_CAP_CENTS)


def _cost(db, col, doc_id):
    snap = db.collection(col).document(doc_id).get()
    v = ((snap.to_dict() or {}) if snap.exists else {}).get("costCents")
    return float(v) if isinstance(v, (int, float)) else 0.0


def spent_today(db, day=None):
    return _cost(db, "claudeUsage", day or today())


def spent_month(db, month=None):
    return _cost(db, "claudeUsageMonths", month or this_month())


def over_cap(db):
    """None while there is room, else the words to say why not."""
    day_cap, month_cap = caps(db)
    if spent_month(db) >= month_cap:
        return ("This month's Claude spending limit ($%.2f) is used up — Claude is off until the 1st. "
                "The limit is on Pricing rules → Claude." % (month_cap / 100))
    if spent_today(db) >= day_cap:
        return ("Today's Claude spending limit ($%.2f) is used up — Claude is off until midnight UTC. "
                "The limit is on Pricing rules → Claude." % (day_cap / 100))
    return None


def usage_sum(items):
    """Several calls' usage as one, for a feature that makes a few calls."""
    keys = ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
    return {k: sum(_get(u, k) for u in items) for k in keys}
