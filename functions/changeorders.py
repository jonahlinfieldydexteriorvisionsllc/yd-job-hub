"""YD Job Hub -- the Change orders board, the server's part (changeorders.js).

Jonah (3 Nov 2026): "change order board where i enter the change orders basic
info with service and price for material and labor then you enter them onto
their respective jobs", each card getting a signature or marked to go on
without one, and "marked for jonahs review before asking for signature so they
could enter just the measurements and info then i could finish the pricing".

On the five-minute reminders run, plain code all the way, this
  - tells whoever needs to hear: a card the crew put in (Jonah), a card priced
    (the person who made it), a card signed (Jonah). One push each, through a
    claim in reminderLog, the way the crew's notes are told;
  - puts a card signed with its PDF up, or marked "add it without a signature",
    on the job's QuickBooks invoice (quickbooks.add_card_order). Never emailed.
    What stops it stays on the card in words, and it is tried again no more
    than once an hour, the pace of the sweep.

The board is read a column at a time: only the cards still open, so Added
cards, which stay as the job's record, cost nothing here.
"""

import datetime

from google.api_core.exceptions import AlreadyExists

import digest as dg

BOARD = "changeorders"
TO_PRICE, TO_SIGN, SIGNED = "co_price", "co_sign", "co_signed"
OPEN_COLUMNS = [TO_PRICE, TO_SIGN, SIGNED]
TRY_AGAIN_AFTER = datetime.timedelta(minutes=60)
OPENS = "changeorders"          # app.js NOTIFICATION_WINDOWS


def _when(iso):
    try:
        t = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=dg.TZ)


def _first(people, uid, fallback):
    u = people.get(uid)
    return (dg._name(u) if u else str(fallback or "Someone")).split()[0]


def _buzz(db, key, uids, title, body, cid, now):
    """One push, once: claimed in reminderLog first, and the claim given back
    when nobody could be reached, so the next run tries again."""
    claim = db.collection("reminderLog").document(key)
    try:
        claim.create({"at": now.isoformat()})
    except AlreadyExists:
        return []
    out, failed = [], 0
    for uid in uids:
        try:
            out.append({"uid": uid, "changeOrder": cid, "phones": dg.send_push(
                uid, {"push": {"title": title, "body": body[:180]}}, tag="yd-co-" + cid, ttl=24 * 3600, opens=OPENS)})
        except Exception as err:      # noqa: BLE001 -- the rest are still told
            failed += 1
            print("change orders: push failed:", uid, err)
    if uids and failed == len(uids):
        try:
            claim.delete()
        except Exception as err:      # noqa: BLE001 -- then it is simply not tried again
            print("change orders: claim not given back:", err)
    return out


def _tell(db, people, owners, cid, k, now):
    """Who needs to hear about this card, as it stands now."""
    job = str(k.get("jobName") or "a job")[:60]
    maker = str(k.get("byUid") or "")
    price = k.get("price")
    said = " · ".join(x for x in (str(k.get("service") or "").strip(), str(k.get("what") or "").strip()) if x)
    out = []
    if maker and maker not in owners and not price:
        who = _first(people, maker, k.get("createdBy"))
        out += _buzz(db, "co_new_" + cid, owners, "🧾 %s put in a change order for %s" % (who, job), said or "Open it to price it", cid, now)
    # Priced for someone else to get signed. A price changed after a signature
    # is a new round: they need to hear again (changeorders.js).
    if price and maker and maker != price.get("by") and not k.get("signDoc") and not k.get("noSignature"):
        out += _buzz(db, "co_priced_%s_%s" % (cid, int(price.get("round") or 0)), [maker],
                     "🧾 %s change order is priced — get it signed" % job, said, cid, now)
    if k.get("signDoc"):
        name = str(k.get("signedName") or "The customer").strip()
        told = [uid for uid in owners if uid != k.get("signedBy")]
        out += _buzz(db, "co_signed_%s_%s" % (cid, k["signDoc"]), told, "🧾 %s signed the %s change order" % (name, job),
                     said, cid, now)
    return out


def _due(db, k, now):
    """Whether a card goes on QuickBooks on this run: priced, signed with the
    PDF up (its phone may not have had signal yet) or to go on without, and
    not tried in the last hour."""
    if (k.get("qb") or {}).get("ok") or not k.get("price") or not (k.get("signDoc") or k.get("noSignature")):
        return False
    t = _when((k.get("qbTry") or {}).get("at"))
    if t is not None and now - t < TRY_AGAIN_AFTER:
        return False
    if k.get("noSignature"):
        return True
    snap = db.collection("jobDocs").document(str(k["signDoc"])).get()
    doc = (snap.to_dict() or {}) if snap.exists else None
    return bool(doc and not doc.get("pending") and doc.get("path"))


def _add(qb, snap, now):
    """One card onto QuickBooks. A refusal is put on the card in its own words."""
    try:
        got = qb.add_card_order(snap.id)
    except qb.SignAgain as err:
        # Signed for another price: back to To sign, saying so.
        snap.reference.set({"column": TO_SIGN, "signDoc": None, "signedAt": None, "signedName": None, "signedBy": None,
                            "said": str(err)[:300], "updatedAt": now.isoformat(), "updatedBy": "Job Hub"}, merge=True)
        return []
    except qb.CardBusy:
        return []                     # its claim is taken up when it is old: nothing to say
    except Exception as err:          # noqa: BLE001 -- one card's trouble never stops the rest
        print("change orders: %s not added: %s" % (snap.id, err))
        snap.reference.set({"qbTry": {"at": now.isoformat(), "error": str(err)[:300]}}, merge=True)
        return []
    return [{"changeOrderAdded": snap.id, "on": got.get("docNumber")}]


def run(db, people, now):
    cards = db.collection("boards").document(BOARD).collection("cards")
    try:
        waiting = list(cards.where("column", "in", OPEN_COLUMNS).stream())
    except Exception as err:          # noqa: BLE001
        print("change orders: cards not read:", err)
        return []
    owners = [uid for uid, u in people.items() if u.get("role") == "owner"]
    out, due = [], []
    for s in waiting:
        k = s.to_dict() or {}
        try:
            out += _tell(db, people, owners, s.id, k, now)
            if _due(db, k, now):
                due.append(s)
        except Exception as err:      # noqa: BLE001 -- one card's trouble never stops the rest
            print("change orders: %s not looked at: %s" % (s.id, err))
    if due:
        import quickbooks as qb
        with qb._holding_tokens():
            for s in due:
                out += _add(qb, s, now)
    return out
