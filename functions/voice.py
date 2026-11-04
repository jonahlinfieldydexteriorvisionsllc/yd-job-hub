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
the prompts write as they did before. SNOW_QUOTE below is the one thing here
about what an email says.
"""

import time

import digest as dg

GUIDE_MAX = 6000          # characters of the guide a prompt carries
FRESH_SECONDS = 600       # read again after ten minutes (one server, many emails an hour)

_cache = {"at": 0.0, "guide": "", "lessons": ""}

# Jonah (4 Nov 2026): "we dont meet with the client in person to bid snow unless
# they request it so emails should say we will swing by and provide a quote."
# Salt: ask if they want it and which kind, unless their request already says.
# Areas: ask what else they want cleared beyond what the service covers.
# This is what the email SAYS, not how it sounds, so it is not in the guide: it
# holds with no guide saved, and every prompt that answers someone asking for
# a price adds it ahead of block() -- a lead's first reply (leads.py, website
# forms too), replies from the inbox and "Draft a reply" on a lead
# (inboxdesk.py), and emails a card asks for (cards.py).
SNOW_QUOTE = (
    "\n\nSNOW REMOVAL QUOTES -- when someone is asking for snow removal or a quote for it (not a customer we "
    "already plow writing about their service), these rules replace anything above about coming out, meeting, "
    "or asking what days and times work:\n"
    "- Jonah doesn't meet clients in person to bid snow. Say we'll swing by and provide a quote. Don't offer a "
    "meeting and don't ask what days or times work. Only if they asked to meet in person, offer that and ask "
    "when works for them.\n"
    "- If their street address isn't in what they wrote, ask for it: we need it to swing by.\n"
    "- Ask if they want salt and, if so, whether they prefer animal friendly or generic rock salt. Leave this "
    "question out when what they wrote already says whether they want salt, or names a kind.\n"
    "- Say what our service covers: the driveway, public walkways, the walkway to the front door, the front "
    "stoop and access to the mailbox. Ask if they have any additional areas they'd like cleared.")


def guide(db=None):
    """His guide as saved, or "" -- read at most every FRESH_SECONDS. A read
    that fails keeps the last one known (and is tried again in a minute)."""
    now = time.time()
    if now - _cache["at"] < FRESH_SECONDS:
        return _cache["guide"]
    try:
        snap = (db or dg._db()).collection("settings").document("voice").get()
        d = (snap.to_dict() or {}) if snap.exists else {}
        _cache.update(at=now, guide=str(d.get("guide") or "").strip()[:GUIDE_MAX],
                      lessons=str(d.get("lessons") or "").strip()[:GUIDE_MAX])
    except Exception as err:      # noqa: BLE001 -- an email without the guide beats no email
        print("voice: guide not read --", err)
        _cache["at"] = now - FRESH_SECONDS + 60
    return _cache["guide"]


def block(db=None, also=""):
    """The guide as the end of a system prompt ("" when there is none).
    `also`: one sentence on what it is for in that prompt."""
    g = guide(db)
    # What he changed in drafts (seasonmail.py), which he can read and change
    # beside the guide. It goes with the guide, or alone when there is none.
    learned = _cache["lessons"]
    if learned:
        learned = ("\n\nWHAT JONAH CHANGED IN CLAUDE'S DRAFTS -- follow these too:\n" + learned)
    if not g:
        return learned
    return ("\n\nHOW JONAH WRITES -- his own guide, made from the emails he typed himself and OK'd by him. "
            "Follow it for how the email sounds: the greeting, the length, the words he uses and the ones he "
            "never does, how he says things. Everything above still decides what the email says -- the facts, "
            "prices, dates and promises -- and how it is signed; where the two differ, what is above wins. The "
            "example lines in it show his way of saying things: never copy one into the email." +
            (" " + also.strip() if also.strip() else "") + "\n\n" + g + learned)
