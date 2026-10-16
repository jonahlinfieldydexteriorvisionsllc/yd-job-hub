"""A job's ONE stage, as the app works it out (app.js jobStage) -- change both
together.

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
