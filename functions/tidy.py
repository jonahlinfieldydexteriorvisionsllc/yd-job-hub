"""Finished board cards are deleted a week after they were marked done.

Jonah (13 Oct 2026): "All tasks marked done should automatically delete 7
days after being marked done." Run once a day, with the morning summary
(main.py /digest/run, slot "morning"), so it happens whether or not anyone
opens the app.

The same cards are spared as by the app's "Delete all done" (boards.js
clearable):
  - one that still wants somebody: a recurring task not yet confirmed, a
    machine marked serviced but not logged, Claude's work waiting for its OK;
  - a machine's service card (Maintenance, eq-...): it is the machine's NEXT
    service, reset when one is logged -- not a finished job;
  - a recurring card whose period is not over yet: recurring.js would make
    it again, not done.
A Pickups card is noted as cleared on its board, so a "still waiting"
reminder email for an order already picked up does not bring it back
(receipts.pickup_card).
"""

import datetime
import re

import digest as dg

KEEP_DAYS = 7
CLEARED_DAYS = 60          # how long a cleared pickup is remembered
PICKUPS = "pickups"
MAINTENANCE = "maintenance"


def _done_col(board):
    """The column that means done: the one called Done, else the last
    (boards.js doneColOf)."""
    cols = board.get("columns") or []
    for c in cols:
        if re.match(r"^\s*done\s*$", str(c.get("name") or ""), re.I):
            return c.get("id")
    return cols[-1].get("id") if cols else None


def _still_wanted(k):
    claude = k.get("claude") or {}
    return bool((k.get("recurring") and not k.get("confirmedAt")) or k.get("markedDoneBy")
                or (claude.get("status") == "waiting_ok" and not claude.get("approvedAt")))


def _when(iso):
    try:
        t = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=dg.TZ)


def clearable(board_id, card_id, k, today):
    if _still_wanted(k):
        return False
    if board_id == MAINTENANCE and card_id.startswith("eq-"):
        return False
    if k.get("recurring") and str(k.get("due") or "") >= today:
        return False
    return True


def run(now=None):
    """Deletes every finished card done more than KEEP_DAYS ago. Returns
    {boardId: how many}."""
    db = dg._db()
    now = now or dg._now()
    today = dg._day(now)
    cutoff = now - datetime.timedelta(days=KEEP_DAYS)
    out = {}
    for snap in db.collection("boards").stream():
        board = snap.to_dict() or {}
        done = _done_col(board)
        if not done:
            continue
        gone = []
        for c in snap.reference.collection("cards").where("column", "==", done).stream():
            k = c.to_dict() or {}
            t = _when(k.get("doneAt")) if k.get("doneAt") else None
            if t and t < cutoff and clearable(snap.id, c.id, k, today):
                gone.append(c)
        if not gone:
            continue
        for n in range(0, len(gone), 400):
            batch = db.batch()
            for c in gone[n:n + 400]:
                batch.delete(c.reference)
            batch.commit()
        if snap.id == PICKUPS:
            keep_from = dg._day(now - datetime.timedelta(days=CLEARED_DAYS))
            cleared = [s for s in (board.get("cleared") or []) if str(s).split("|")[-1] >= keep_from]
            cleared += ["%s|%s" % (c.id, today) for c in gone]
            snap.reference.set({"cleared": cleared}, merge=True)
        out[snap.id] = len(gone)
    if out:
        print("tidy: finished cards deleted:", out)
    return out
