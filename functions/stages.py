"""A job's ONE stage, as the app works it out (app.js jobStage) -- change both
together. Below it, the same for receipts, equipment problems, crew change
requests and storms (stages.js).

Jonah, 15 Oct 2026: "One status per record, moving forward through fixed
stages, instead of piles of yes/no boxes." A job used to say where it was in
four places that could disagree (its status, the Jobs board column, an
"Invoiced in QuickBooks" tick, and QuickBooks itself). Now:

    bid -> booked -> inprogress -> finished -> invoiced -> paid    (or lost, for a bid)

- bid / lost / booked / inprogress / finished come from jobStatus (and
  bidStage 'lost' on a bid).
- invoiced / paid: when QuickBooks holds the job's invoice (qbInvoiceRef, from
  the same QuickBooks company as its estimate) QuickBooks decides -- anything
  owed is invoiced, nothing owed is paid. With no QuickBooks invoice they were
  set by hand: workStage 'invoiced' / 'paid' (the Jobs board column), or the
  old qbInvoiced tick on jobs from before.
- Only a finished job is invoiced or paid: the invoice is often made when the
  estimate is accepted, to collect the deposit, long before the work is done.

Nothing is rewritten: old jobs are read from the fields they already have.
"""

STAGES = ("bid", "booked", "inprogress", "finished", "invoiced", "paid")
STAGE_NAMES = {"bid": "Bid", "lost": "Lost", "booked": "Booked", "inprogress": "In progress",
               "finished": "Finished", "invoiced": "Invoiced", "paid": "Paid"}
# A finished job's stage -> its Jobs board column (boards.js).
COLUMN_OF = {"finished": "toInvoice", "invoiced": "invoiced", "paid": "paid"}


def status_of(j):
    """A job's status as the app reads it (app.js normStatus): the old
    'active' is Booked or In progress by where the job sat on the Jobs board,
    anything unknown is a bid."""
    j = j or {}
    s = j.get("jobStatus") or "quoting"
    if s == "active":
        return "inprogress" if j.get("workStage") in ("inProgress", "punchList") else "booked"
    return s if s in ("quoting", "booked", "inprogress", "complete") else "quoting"


def qb_invoice_of(j):
    """The job's QuickBooks invoice record, or None. One from the other
    QuickBooks company (the test one, before the switch to the real books) is
    not this job's."""
    j = j or {}
    r = j.get("qbInvoiceRef") or {}
    if not r.get("id"):
        return None
    q = j.get("qbEstimate") or {}
    if r.get("env") and q.get("env") and r.get("env") != q.get("env"):
        return None
    return r


def qb_owed(inv):
    """What QuickBooks says is still owed, or None when it has not said."""
    b = (inv or {}).get("balance")
    if b is None or b == "":
        return None
    try:
        return float(b)
    except (TypeError, ValueError):
        return None


def stage_of(j):
    """'bid' | 'lost' | 'booked' | 'inprogress' | 'finished' | 'invoiced' | 'paid'."""
    j = j or {}
    st = status_of(j)
    if st == "quoting":
        return "lost" if j.get("bidStage") == "lost" else "bid"
    if st != "complete":
        return st
    inv = qb_invoice_of(j)
    if inv:
        owed = qb_owed(inv)
        return "paid" if owed is not None and owed <= 0.004 else "invoiced"
    ws = j.get("workStage")
    if ws == "paid":
        return "paid"
    if ws == "invoiced" or j.get("qbInvoiced"):
        return "invoiced"
    return "finished"


def board_column(j):
    """A finished job's Jobs board column (toInvoice / invoiced / paid), or
    None for a job that is not finished."""
    return COLUMN_OF.get(stage_of(j))


# ---------------------------------------------------------------------------
# The other records' one status -- receipts, equipment problems, crew change
# requests, storms. The app works each out the same way (stages.js) -- change
# both together. Old records are read as they are; nothing is rewritten.
#
#   receipt:  tosort -> filed  (or aside, with the reason)
#   problem:  open -> ordered -> atshop -> fixed  (and back to open)
#   request:  waiting -> approved | turneddown  (or withdrawn)
#   storm:    open -> closed | abandoned
# ---------------------------------------------------------------------------

# A receipt's stored status is 'new' / 'done' / 'skipped'. Three old set-aside
# reasons were really places (before 9, 13 and 21 Oct): read as filed.
RECEIPT_LEGACY_PLACE = {"overhead": "shop", "subcontractor": "sub", "personal": "personal"}
# Places that are not a cost of the business (Jonah, 21 Oct 2026: "personal
# receipts dont get deleted"): a receipt filed only there is kept, but never
# counted or sent on to QuickBooks.
RECEIPT_OFF_BOOKS = ("personal",)
# Places QuickBooks must never get as an expense: everything off the books,
# and a loan payment (Jonah, 22 Oct 2026) -- counted in Job Hub under its own
# name, but mostly paying back what was borrowed, which is not a cost.
# QuickBooks has it from the bank. Keep the same as stages.js.
RECEIPT_NOT_TO_QB = ("personal", "loan")


def receipt_status(r):
    """'tosort' | 'filed' | 'aside'. 'new' (or no status at all) is still to
    sort, even with some lines already filed; 'done' is filed; 'skipped' is
    set aside -- unless its reason was one of the old places."""
    r = r or {}
    s = r.get("status")
    if s == "done":
        return "filed"
    if s == "skipped":
        return "filed" if r.get("skipWhy") in RECEIPT_LEGACY_PLACE else "aside"
    return "tosort"


def _filed_places(r):
    """Where a filed receipt went (its splits, and an old set-aside reason
    that was really a place); [] for one still to sort or set aside."""
    r = r or {}
    if receipt_status(r) != "filed":
        return []
    places = [(s.get("to") or "job") for s in (r.get("splits") or []) if isinstance(s, dict)]
    if r.get("status") == "skipped":
        places.append(RECEIPT_LEGACY_PLACE.get(r.get("skipWhy")))
    return places


def receipt_off_books(r):
    """True for a filed receipt whose every place is off the books (only
    Personal, so far): kept in Job Hub, never counted or sent to QuickBooks."""
    places = _filed_places(r)
    return bool(places) and all(p in RECEIPT_OFF_BOOKS for p in places)


def receipt_not_to_qb(r):
    """True for a filed receipt whose every place QuickBooks must not get as
    an expense (Personal, a loan payment): never sent on to QuickBooks."""
    places = _filed_places(r)
    return bool(places) and all(p in RECEIPT_NOT_TO_QB for p in places)


def issue_status(i):
    """A problem on a machine: 'open' | 'ordered' | 'atshop' | 'fixed'.
    doneAt (fixed) and partAtShop (the part at the shop) win over `status`:
    every device, old code or new, keeps those two in step; `status` adds
    only what had no field of its own -- the part ordered."""
    i = i or {}
    if i.get("doneAt"):
        return "fixed"
    if i.get("partAtShop"):
        return "atshop"
    return "ordered" if i.get("status") == "ordered" else "open"


def request_status(r):
    """A crew change request: 'waiting' | 'approved' | 'turneddown' |
    'withdrawn' (stored 'pending' / 'approved' / 'rejected' / 'withdrawn')."""
    s = (r or {}).get("status")
    return {"approved": "approved", "rejected": "turneddown", "withdrawn": "withdrawn"}.get(s, "waiting")


def storm_status(s):
    """'open' | 'closed' | 'abandoned'. Only a storm whose stored status is
    'open' is open -- the crew can work no other (firestore.rules); anything
    unknown is neither worked nor billed, so it reads as abandoned."""
    st = (s or {}).get("status")
    return st if st in ("open", "closed") else "abandoned"
