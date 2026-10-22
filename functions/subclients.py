"""YD Job Hub -- a subcontractor's clients in QuickBooks: what each was billed
and paid, and what was paid to the subcontractor.

Jonah (22 Oct 2026): "pull the rest of [a client's] payments from qb and my
receipts from paying [his mowing subcontractor]". The Subcontractors section
(subs.js) had their bills and the clients' OPEN invoices only -- a paid
invoice leaves the Invoices list a month after it is paid -- so a property's
season could not say what the client had paid, or what the work made.

Every property tied to a customer (settings/subcontractors props.customerId,
or the customer of the job it is tied to) is looked up BY ITS QUICKBOOKS
CUSTOMER ID, never by name: all of those customers' invoices and payments
since the start of last year, in one question each. And whoever the
subcontractor is in QuickBooks -- found once by name among the vendors and
customers (his bank feed books their withdrawals to a customer of theirs),
or set by hand on the subcontractor (qbPayees) -- has the money paid to them
read from QuickBooks' transaction list: expenses, checks and bill payments.

Kept in settings/subClients, the owner's alone like settings/subcontractors
(firestore.rules: settings are the owner's unless named otherwise), written
whole on every hourly sweep, so an invoice changed or deleted in QuickBooks
is right here within the hour:
  customers: {qbCustomerId: {name, invoices: [...], payments: [...]}}
  payees:    {subId: {for: the name they were found by, list: [{type, id, name, by}]}}
  paidOut:   {subId: [{id, type, date, cents, account, memo, payee}]}
  from, readAt
Which invoice lines are the subcontractor's work, and which bill a payment
paid, the app works out (subs.js), with a by-hand say on each. Nothing is
ever written to QuickBooks.
"""

import datetime
import re

import digest as dg
import quickbooks as qb
import subvisits as sv

IN_BATCH = 30               # customer ids per "CustomerRef in (...)" question
PAGE = 1000                 # QuickBooks' most rows per answer
DESC_MAX = 200              # of a line's description: what the app reads for the work and the address
PAYEE_TYPES = ("Vendor", "Customer")
# Money out, in the transaction list's words. A bill is what is owed, not
# money paid (its payment is the money), and an estimate or invoice to them
# is work YD sold them.
PAID_OUT = re.compile(r"^(expense|check|cash expense|credit card expense|bill payment)", re.I)


def _db():
    return qb._db()


def _cents(v):
    try:
        return int(round(float(v or 0) * 100))
    except (TypeError, ValueError):
        return 0


def _all(entity, where):
    """Every row a question answers, in pages."""
    out, start = [], 1
    while True:
        rows = qb._query(entity, "%s startposition %d maxresults %d" % (where, start, PAGE))
        out += rows
        if len(rows) < PAGE:
            return out
        start += PAGE


def _in(ids):
    return ", ".join("'%s'" % qb._quote(i) for i in ids)


# ------------------------------------------------------------ the clients


def _customer_ids(db, subs):
    """QuickBooks customer id -> True, for every property tied to a customer
    of the list (or to a job of one)."""
    cust, job_ids = set(), set()
    for s in (subs or {}).values():
        for p in ((s or {}).get("props") or {}).values():
            if not p:
                continue
            if p.get("customerId"):
                cust.add(str(p["customerId"]))
            elif p.get("jobId"):
                job_ids.add(str(p["jobId"]))
    if job_ids:
        refs = [db.collection("jobs").document(j) for j in sorted(job_ids)]
        for snap in db.get_all(refs):
            cid = (snap.to_dict() or {}).get("customerId") if snap.exists else None
            if cid:
                cust.add(str(cid))
    out = set()
    if cust:
        refs = [db.collection("customers").document(c) for c in sorted(cust)]
        for snap in db.get_all(refs):
            qid = (snap.to_dict() or {}).get("qbCustomerId") if snap.exists else None
            if qid:
                out.add(str(qid))
    return out


def _line(ln):
    d = ln.get("SalesItemLineDetail") or {}
    return {"item": str((d.get("ItemRef") or {}).get("name") or ""),
            "desc": str(ln.get("Description") or "")[:DESC_MAX],
            "cents": _cents(ln.get("Amount")), "date": str(d.get("ServiceDate") or "")}


def _invoice(inv, env):
    lines = [_line(ln) for ln in inv.get("Line") or [] if ln.get("DetailType") == "SalesItemLineDetail"]
    return {
        "id": str(inv.get("Id")), "doc": str(inv.get("DocNumber") or ""),
        "date": str(inv.get("TxnDate") or ""), "due": str(inv.get("DueDate") or ""),
        "total": _cents(inv.get("TotalAmt")), "balance": _cents(inv.get("Balance")),
        "tax": _cents((inv.get("TxnTaxDetail") or {}).get("TotalTax")),
        "lines": lines,
        "link": "%s/app/invoice?txnId=%s" % (qb.QB_APP.get(env, qb.QB_APP["sandbox"]), inv.get("Id")),
    }


def _payment(p, methods):
    # The invoices it paid, and how much on each (a payment can pay several).
    on = []
    for ln in p.get("Line") or []:
        for t in ln.get("LinkedTxn") or []:
            if t.get("TxnType") == "Invoice" and t.get("TxnId"):
                on.append({"inv": str(t["TxnId"]), "cents": _cents(ln.get("Amount"))})
    return {"id": str(p.get("Id")), "date": str(p.get("TxnDate") or ""), "cents": _cents(p.get("TotalAmt")),
            "method": methods.get(str((p.get("PaymentMethodRef") or {}).get("value") or ""), ""), "on": on}


def _clients(ids, start, env):
    """{qbCustomerId: {name, invoices, payments}} for these customers."""
    out = {i: {"name": "", "invoices": [], "payments": []} for i in ids}
    ids = sorted(ids)
    invs, pays = [], []
    for n in range(0, len(ids), IN_BATCH):
        part = _in(ids[n:n + IN_BATCH])
        invs += _all("Invoice", "CustomerRef in (%s) and TxnDate >= '%s'" % (part, start))
        pays += _all("Payment", "CustomerRef in (%s) and TxnDate >= '%s'" % (part, start))
    methods = {}
    if pays:
        try:
            methods = {str(m.get("Id")): str(m.get("Name") or "") for m in qb._query("PaymentMethod", "Active = true")}
        except qb.ReconnectNeeded:
            raise
        except Exception as err:                    # noqa: BLE001 -- the payments without their method
            print("sub clients: payment methods not read:", err)
    for inv in invs:
        ref = inv.get("CustomerRef") or {}
        c = out.get(str(ref.get("value") or ""))
        if c is None:
            continue
        c["name"] = c["name"] or str(ref.get("name") or "")
        c["invoices"].append(_invoice(inv, env))
    for p in pays:
        ref = p.get("CustomerRef") or {}
        c = out.get(str(ref.get("value") or ""))
        if c is None:
            continue
        c["name"] = c["name"] or str(ref.get("name") or "")
        c["payments"].append(_payment(p, methods))
    for c in out.values():
        c["invoices"].sort(key=lambda x: (x["date"], x["id"]))
        c["payments"].sort(key=lambda x: (x["date"], x["id"]))
    return out


# ------------------------------------------------------- paid to the sub


def _find_payees(sub):
    """Whoever this subcontractor is in QuickBooks, by name -- among the
    vendors AND the customers: the bank feed books an ACH withdrawal to
    whichever name it was given. Asked by the first letters of their first
    name word (QuickBooks' LIKE has no "run together"), then held to the same
    test their emails are (subvisits.names_match)."""
    words = sv._words(sub.get("match") or sub.get("name"))
    if not words:
        return []
    stem = qb._quote(words[0][:5])
    out = []
    for kind in PAYEE_TYPES:
        for row in _all(kind, "DisplayName like '%%%s%%'" % stem):
            name = str(row.get("DisplayName") or "")
            if sv.names_match(sub, name) or sv.names_match(sub, row.get("CompanyName") or ""):
                out.append({"type": kind, "id": str(row.get("Id")), "name": name, "by": "name"})
    return out


def _payees(sub, had):
    """By hand on the subcontractor (qbPayees [{type, id, name}]; an empty
    list is "none of them") wins; else the ones found before for the same
    name; else found by name now."""
    if isinstance(sub.get("qbPayees"), list):
        return [{"type": x["type"], "id": str(x["id"]), "name": str(x.get("name") or ""), "by": "hand"}
                for x in sub["qbPayees"] if x and x.get("type") in PAYEE_TYPES and x.get("id")]
    name = sub.get("match") or sub.get("name") or ""
    if had and had.get("for") == name:
        return had.get("list") or []
    return _find_payees(sub)


def _rows(rows):
    """Every data row of a report, sections opened."""
    for r in rows or []:
        if r.get("ColData"):
            yield r
        inner = (r.get("Rows") or {}).get("Row")
        if inner:
            yield from _rows(inner)


def _paid_to(payee, start, end):
    """[{id, type, date, cents, account, memo}] -- money paid to one payee."""
    kind = "vendor" if payee["type"] == "Vendor" else "customer"
    data = qb._call("GET", "reports/TransactionList", params={
        "start_date": start, "end_date": end, kind: payee["id"],
        "columns": "tx_date,txn_type,doc_num,memo,account_name,subt_nat_amount"})
    keys = [next((m.get("Value") for m in c.get("MetaData") or [] if m.get("Name") == "ColKey"), "")
            for c in ((data.get("Columns") or {}).get("Column") or [])]
    out = []
    for r in _rows((data.get("Rows") or {}).get("Row")):
        cells = r.get("ColData") or []
        row = {k: (cells[i] if i < len(cells) else {}) for i, k in enumerate(keys)}
        kind_text = str((row.get("txn_type") or {}).get("value") or "")
        if not PAID_OUT.match(kind_text):
            continue
        cents = _cents((row.get("subt_nat_amount") or {}).get("value"))
        if not cents:
            continue
        out.append({"id": str((row.get("txn_type") or {}).get("id") or ""), "type": kind_text,
                    "date": str((row.get("tx_date") or {}).get("value") or ""),
                    # Money out shows as less than nothing; a refund back the other way.
                    "cents": -cents,
                    "account": str((row.get("account_name") or {}).get("value") or "")[:80],
                    "memo": str((row.get("memo") or {}).get("value") or "")[:DESC_MAX]})
    return out


# ------------------------------------------------------------------- run


def sync(db=None):
    """settings/subClients brought up to date. Returns how many clients were
    read (0 with nothing tied, or not the real company)."""
    if qb._env("QB_ENV", "sandbox") != "production":
        return 0                                    # the test company's customers are made up
    db = db or _db()
    cfg = db.collection("settings").document("subcontractors").get()
    subs = ((cfg.to_dict() or {}).get("subs") or {}) if cfg.exists else {}
    if not subs:
        return 0
    ref = db.collection("settings").document("subClients")
    snap = ref.get()
    have = (snap.to_dict() or {}) if snap.exists else {}
    now = dg._now()
    start = datetime.date(now.year - 1, 1, 1).isoformat()
    end = now.date().isoformat()
    env = qb._env("QB_ENV", "sandbox")
    ids = _customer_ids(db, subs)
    customers = _clients(ids, start, env) if ids else {}
    payees, paid_out, had = {}, {}, have.get("payees") or {}
    for sid, sub in subs.items():
        if not sub:
            continue
        found = _payees(sub, had.get(sid))
        payees[sid] = {"for": sub.get("match") or sub.get("name") or "", "list": found}
        seen, rows = set(), []
        for p in found:
            for row in _paid_to(p, start, end):
                k = (row["type"], row["id"])
                if k in seen:
                    continue                        # under both of their names
                seen.add(k)
                row["payee"] = p["name"]
                rows.append(row)
        paid_out[sid] = sorted(rows, key=lambda x: (x["date"], x["id"]))
    # Whole, not merged: what QuickBooks no longer has goes from here too.
    ref.set({"customers": customers, "payees": payees, "paidOut": paid_out, "from": start, "readAt": now.isoformat()})
    return len(customers)
