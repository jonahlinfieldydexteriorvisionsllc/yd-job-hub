"""How Jonah writes -- his own guide, for every email Claude writes as him.

Jonah (30 Oct 2026, wish card): "read all my personally sent emails to find
my voice so you can improve writing as me." A chat read his own sent mail --
the emails he typed himself (his Gmail signature on them), never the ones
Job Hub, Claude or QuickBooks sent -- and wrote a short guide: do's and
don'ts and a few example lines, with no customer's name, address or price.
He read it and OK'd it. It lives in settings/voice.guide (owner-only, like
every settings record; he changes it under ⋯ → All settings → How you
write), never in this code, which is public.

Every prompt that writes an email as him adds block(): the follow-ups
(followup.py), replies from the inbox (inboxdesk.py), a lead's first reply
(leads.py), emails a card asks for (cards.py), the plant-care email
(care.py) and the progress update (joblog.py). What each prompt asks for --
the facts, prices, dates, promises, the sign-off -- stays that prompt's own;
the guide decides only how the email sounds. No guide saved, or it emptied:
the prompts write as they did before.
"""

import time

import digest as dg

GUIDE_MAX = 6000          # characters of the guide a prompt carries
FRESH_SECONDS = 600       # read again after ten minutes (one server, many emails an hour)

_cache = {"at": 0.0, "guide": ""}


def guide(db=None):
    """His guide as saved, or "" -- read at most every FRESH_SECONDS. A read
    that fails keeps the last one known (and is tried again in a minute)."""
    now = time.time()
    if now - _cache["at"] < FRESH_SECONDS:
        return _cache["guide"]
    try:
        snap = (db or dg._db()).collection("settings").document("voice").get()
        d = (snap.to_dict() or {}) if snap.exists else {}
        _cache.update(at=now, guide=str(d.get("guide") or "").strip()[:GUIDE_MAX])
    except Exception as err:      # noqa: BLE001 -- an email without the guide beats no email
        print("voice: guide not read --", err)
        _cache["at"] = now - FRESH_SECONDS + 60
    return _cache["guide"]


def block(db=None, also=""):
    """The guide as the end of a system prompt ("" when there is none).
    `also`: one sentence on what it is for in that prompt."""
    g = guide(db)
    if not g:
        return ""
    return ("\n\nHOW JONAH WRITES -- his own guide, made from the emails he typed himself and OK'd by him. "
            "Follow it for how the email sounds: the greeting, the length, the words he uses and the ones he "
            "never does, how he says things. Everything above still decides what the email says -- the facts, "
            "prices, dates and promises -- and how it is signed; where the two differ, what is above wins. The "
            "example lines in it show his way of saying things: never copy one into the email." +
            (" " + also.strip() if also.strip() else "") + "\n\n" + g)
