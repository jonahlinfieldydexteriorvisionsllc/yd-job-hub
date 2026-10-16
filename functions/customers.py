"""YD Job Hub -- the customer list, kept in step with QuickBooks.

Jonah (15 Oct 2026): one customer list tied to QuickBooks that is also the
call list. Everyone he has worked for has a QuickBooks profile he made; the
Customers tab shows all of them (old ones under "Past customers", still
callable), plus the people who are not customers yet ("Lead") -- their
profile is made when they get their first bid.

WHO OWNS WHAT on customers/{id}:

  * Contact details -- the name, phones, email, address -- belong to
    QuickBooks and to Job Hub both. A change made in QuickBooks is read here
    within the hour (the hourly sweep asks for customers changed since the
    last look); a change made in Job Hub goes to QuickBooks at once
    (/qb/customer-save), or at the next sweep when there was no signal.
  * Tags, notes, the time to call and whether they were reached live only in
    Job Hub: QuickBooks' API can neither read nor write its own tags, and has
    nowhere for the rest. Nothing here ever writes those.
  * Money is never kept on a customer: what they owe is worked out from the
    invoices, which only Billing may read. Contacts can be given to an admin
    who has no business seeing it.

A customer's id is their QuickBooks Id. A lead typed in by hand has an id of
its own ("ld..."); when their first estimate makes their QuickBooks profile
(quickbooks.save_estimate), what Job Hub knows of them is carried onto
customers/{QuickBooks id} and the lead is marked mergedInto it.

The first read brings in every customer (active and inactive -- inactive ones
are past customers) and is OFF until the owner switches it on
(settings/customers.importOn): it writes some five hundred records, which is
his call to make. Only the real company: the test company's made-up
customers must never land in his list.

SNOW QUOTES (Jonah, 15 Oct 2026: a call list of who was quoted for snow
this season or last and did not take it, instead of a spreadsheet). The
same once-a-day reading of the estimates that finds who has been worked for
lately also picks out the snow ones -- no extra question to QuickBooks -- and
each customer quoted for snow gets `snow` {quotes, accounts, at}: every snow
estimate of this season and last (id, number, date, QuickBooks' status,
whether it was taken, the season) and the Snow accounts in Job Hub that are
theirs. No money: a customer is read by whoever sees Contacts. A snow quote
is an estimate with one of the Snow Removal products on it -- Intuit's API
cannot read the "snow" tag Jonah puts on them.

No Claude here: this is matching and copying, plain code (Jonah, 5 Oct 2026).
QuickBooks reads stay tiny -- one question an hour, a few a day for who has
been worked for lately -- against Intuit's 500,000 a month.

Nothing that names a customer is ever printed to the logs -- only ids and
counts.
"""

import datetime

from firebase_admin import firestore

import quickbooks as qb

COLL = "customers"
STATE_DOC = ("integrations", "quickbooksCustomers")    # server only: where the reading got to, per company
PAGE = 1000                                           # QuickBooks' most rows to one question
BATCH = 400                                           # Firestore writes to one batch (limit 500)
OVERLAP = datetime.timedelta(minutes=2)               # two changes in the same second fall the same side
WORK_EVERY = datetime.timedelta(hours=20)             # who has been worked for: once a day
WORK_LOOKBACK_DAYS = 2 * 365 + 31                     # a little past "Past" (two years, customers.js)
WORK_ENTITIES = ("Invoice", "Estimate", "SalesReceipt")
PUSH_MAX = 20                                         # Job Hub edits sent to QuickBooks in one sweep

# The products that make an estimate a snow quote: the three under "Snow
# Removal" in his QuickBooks (Oct 2026). Matched on the product's own name --
# the part after the last ":" of "Seasonal Services:Snow Removal:...". Salt
# and the add-ons sit in the same group but are not a quote for snow on their
# own.
SNOW_PRODUCTS = ("residential snow removal", "snow removal", "snow removal - seasonal service")
SNOW_SEASONS = 2                                      # this season and the one before

# The contact details both sides may change. `address` (one line) is always
# worked out from the parts, never sent.
EDIT_KEYS = ("name", "firstName", "lastName", "business", "phone", "mobile", "email",
             "street", "city", "state", "zip")
ADDR_KEYS = ("street", "city", "state", "zip")
# What only QuickBooks (through this file) writes.
QB_KEYS = EDIT_KEYS + ("address", "ship", "qbCustomerId", "qbActive", "qbSyncToken", "qbUpdatedAt",
                       "qbCreatedAt", "qbParentId", "qbFullName")


def _s(v):
    return " ".join(str(v or "").split())


def _line(p):
    tail = " ".join(x for x in (_s(p.get("state")).upper(), _s(p.get("zip"))) if x)
    return ", ".join(x for x in (_s(p.get("street")), _s(p.get("city")), tail) if x)


def _addr(a, name):
    """A QuickBooks address in parts (street, city, state, zip, address), or
    None when it has no street and no town."""
    p = qb._addr_parts(a, name)
    out = {"street": p["address"], "city": p["city"], "state": p["state"].upper(), "zip": p["zip"]}
    if not (out["street"] or out["city"]):
        return None
    out["address"] = _line(out)
    return out


def from_qb(c):
    """What customers/{id} keeps of a QuickBooks Customer."""
    name = _s(c.get("DisplayName"))
    bill = _addr(c.get("BillAddr"), name) or {"street": "", "city": "", "state": "", "zip": "", "address": ""}
    ship = _addr(c.get("ShipAddr"), name)
    # The work address only when it is somewhere else than the bill.
    if ship and ship["address"].lower() == bill["address"].lower():
        ship = None
    meta = c.get("MetaData") or {}
    return {
        "qbCustomerId": str(c.get("Id")),
        "name": name,
        "firstName": _s(c.get("GivenName")), "lastName": _s(c.get("FamilyName")),
        "business": _s(c.get("CompanyName")),
        "phone": _s((c.get("PrimaryPhone") or {}).get("FreeFormNumber")),
        "mobile": _s((c.get("Mobile") or {}).get("FreeFormNumber")),
        "email": _s((c.get("PrimaryEmailAddr") or {}).get("Address")),
        "street": bill["street"], "city": bill["city"], "state": bill["state"], "zip": bill["zip"],
        "address": bill["address"],
        "ship": ship,
        "qbActive": c.get("Active", True) is not False,
        "qbSyncToken": str(c.get("SyncToken") or ""),
        "qbUpdatedAt": str(meta.get("LastUpdatedTime") or ""),
        "qbCreatedAt": str(meta.get("CreateTime") or ""),
        # A sub-customer ("Parent:Child" in QuickBooks) -- shown with its parent.
        "qbParentId": str((c.get("ParentRef") or {}).get("value") or "") or None,
        "qbFullName": _s(c.get("FullyQualifiedName")) or name,
    }


def _same(a, b):
    if isinstance(a, dict) or isinstance(b, dict):
        return (a or None) == (b or None)
    return _s(a) == _s(b) if not isinstance(a, bool) and not isinstance(b, bool) else a == b


def _patch(have, rec, now):
    """What to write onto a customer from QuickBooks' `rec`, given what the
    record holds now (`have`, None when new) -- or None when nothing changed.

    A Job Hub edit not yet in QuickBooks (qbPending) keeps its fields: they
    are not overwritten by QuickBooks' older values. If QuickBooks changed
    the customer since that edit was made (its SyncToken moved), and to
    something else than the edit, both are kept (qbConflict) for Jonah to
    pick between on the customer's page."""
    have = have or {}
    pending = have.get("qbPending") or {}
    held = set(pending.get("fields") or []) if pending else set()
    if held & set(ADDR_KEYS):
        held.add("address")
    out = {}
    for k in QB_KEYS:
        if k in held:
            continue
        if k not in have or not _same(have.get(k), rec.get(k)):
            out[k] = rec.get(k)
    if pending and str(pending.get("base") or "") != rec["qbSyncToken"] and not have.get("qbConflict"):
        theirs = {k: rec.get(k) for k in pending.get("fields") or [] if k in EDIT_KEYS}
        mine = {k: have.get(k) for k in theirs}
        was = pending.get("was") or {}
        if all(_same(theirs[k], mine[k]) for k in theirs):
            # QuickBooks already says what Job Hub does: nothing left to send.
            out.update(qbPending=None, qbSyncToken=rec["qbSyncToken"], qbUpdatedAt=rec["qbUpdatedAt"])
        elif any(k in was and not _same(theirs[k], was[k]) and not _same(theirs[k], mine[k]) for k in theirs):
            # The same field changed on both sides: Jonah picks.
            out["qbConflict"] = {"at": now, "theirs": theirs, "mine": mine}
        # else QuickBooks changed something else: the edit is still sent
        # (push_pending), over the newer copy.
    if not out:
        return None
    if not have:
        out.update(source="quickbooks", createdAt=now)
    out["updatedAt"] = now
    return out


def _settings():
    snap = qb._db().collection("settings").document("customers").get()
    return (snap.to_dict() or {}) if snap.exists else {}


def _state_ref():
    return qb._db().collection(STATE_DOC[0]).document(STATE_DOC[1])


def _all_pages(entity, where):
    out, start = [], 1
    while True:
        rows = qb._query(entity, "%s startposition %d maxresults %d" % (where, start, PAGE))
        out += rows
        if len(rows) < PAGE:
            return out
        start += PAGE


def _write(db, writes):
    """[(doc id, data)] in batches, merged."""
    coll = db.collection(COLL)
    for i in range(0, len(writes), BATCH):
        b = db.batch()
        for doc_id, data in writes[i:i + BATCH]:
            b.set(coll.document(doc_id), data, merge=True)
        b.commit()


def sync(force=False):
    """The hourly look (quickbooks._sweep, inside its held tokens). Returns
    {read, written, work, pushed} or None when switched off / not the real
    company."""
    if qb._env("QB_ENV", "sandbox") != "production":
        return None
    if _settings().get("importOn") is not True and not force:
        return None
    realm = (qb._load_tokens() or {}).get("realmId") or "none"
    db = qb._db()
    ref = _state_ref()
    snap = ref.get()
    state = (((snap.to_dict() or {}) if snap.exists else {}).get(realm)) or {}
    now = qb._stamp()
    started = qb._now()

    # Inactive customers are asked for too: they are past customers, still
    # callable. A plain query only returns active ones.
    if not state.get("fullAt"):
        rows = _all_pages("Customer", "Active IN (true, false) orderby Id")
        haves = {s.id: (s.to_dict() or {}) for s in db.collection(COLL).stream()}
    else:
        since = (qb._parse_time(state.get("cursor")) or started) - OVERLAP
        rows = _all_pages("Customer", "Active IN (true, false) and MetaData.LastUpdatedTime > '%s' "
                          "orderby MetaData.LastUpdatedTime" % qb._quote(qb._qb_time(since)))
        refs = [db.collection(COLL).document(str(r.get("Id"))) for r in rows if r.get("Id")]
        haves = {s.id: (s.to_dict() or {}) for s in db.get_all(refs) if s.exists} if refs else {}

    work = dict(state.get("work") or {})
    writes, cursor = [], state.get("cursor") or ""
    for c in rows:
        if not c.get("Id"):
            continue
        rec = from_qb(c)
        cid = rec["qbCustomerId"]
        have = haves.get(cid)
        p = _patch(have, rec, now)
        if p is not None and not have and work.get(cid):
            p["lastWorkAt"] = work[cid]
        if p is not None:
            writes.append((cid, p))
        t = rec["qbUpdatedAt"]
        if t and (not cursor or (qb._parse_time(t) or started) > (qb._parse_time(cursor) or started)):
            cursor = t
    _write(db, writes)
    state = dict(state, cursor=cursor or qb._qb_time(started))
    if not state.get("fullAt"):
        state["fullAt"] = now
    out = {"read": len(rows), "written": len(writes), "work": 0, "snow": 0, "pushed": 0}

    # Who has been worked for in the last two years (the "Past" line,
    # customers.js): the newest invoice, estimate or sales receipt of each.
    # The same reading picks out the snow quotes (the Snow quotes list).
    last = qb._parse_time(state.get("workAt"))
    if force or not last or started - last > WORK_EVERY:
        try:
            got, quotes = look_back()
            changed = {cid: d for cid, d in got.items() if work.get(cid) != d}
            if changed:
                refs = [db.collection(COLL).document(cid) for cid in changed]
                there = {s.id for s in db.get_all(refs) if s.exists}
                _write(db, [(cid, {"lastWorkAt": d, "updatedAt": now}) for cid, d in changed.items() if cid in there])
                out["work"] = len(there)
                # Kept only for the ones written: one made later still gets its date.
                work.update({cid: d for cid, d in changed.items() if cid in there})
            out["snow"] = _write_snow(db, quotes, state, now)
            state.update(work=work, workAt=now)
        except qb.ReconnectNeeded:
            raise
        except Exception as err:                    # noqa: BLE001
            print("customers: who was worked for lately not read:", str(err)[:300])
    ref.set({realm: state}, merge=True)

    # Job Hub edits made with no signal (or refused for a moment): sent now.
    try:
        out["pushed"] = push_pending()
    except qb.ReconnectNeeded:
        raise
    except Exception as err:                        # noqa: BLE001
        print("customers: edits not sent to QuickBooks:", str(err)[:300])
    return out


def look_back(today=None):
    """One reading of the last two years' invoices, estimates and sales
    receipts: (QuickBooks customer id -> the date, YYYY-MM-DD, of their
    newest one; customer id -> their snow quotes of this season and last,
    newest first)."""
    today = today or _today()
    cutoff = (qb._now() - datetime.timedelta(days=WORK_LOOKBACK_DAYS)).date().isoformat()
    snow_from = "%d-07-01" % (season_of(today) - (SNOW_SEASONS - 1))
    cutoff = min(cutoff, snow_from)
    best, snow = {}, {}
    for entity in WORK_ENTITIES:
        for t in _all_pages(entity, "TxnDate >= '%s' orderby Id" % cutoff):
            cid = str((t.get("CustomerRef") or {}).get("value") or "")
            d = str(t.get("TxnDate") or "")[:10]
            if cid and d and d > best.get(cid, ""):
                best[cid] = d
            if entity == "Estimate" and cid and d >= snow_from:
                q = snow_quote(t)
                if q:
                    snow.setdefault(cid, []).append(q)
    for qs in snow.values():
        qs.sort(key=lambda q: (q["date"], q["id"]), reverse=True)
    return best, snow


def last_work():
    """QuickBooks customer id -> the date (YYYY-MM-DD) of their newest
    invoice, estimate or sales receipt in the last two years."""
    return look_back()[0]


# ---------------------------------------------------------------- snow quotes
#
# A snow season runs over the winter and is named by the year it starts in,
# from July on -- the same as the Snow tab (snow.js seasonNow: "2026-27") and
# the snow import (quickbooks._snow_season). A quote written in October 2025
# is for the 2025-26 winter; one in January 2026 too.

TZ_NAME = "America/Chicago"


def _today():
    from zoneinfo import ZoneInfo
    return datetime.datetime.now(ZoneInfo(TZ_NAME)).date()


def season_of(day):
    """The start year of the snow season a day (a date, or "YYYY-MM-DD")
    belongs to."""
    if isinstance(day, str):
        day = datetime.date.fromisoformat(day[:10])
    return day.year if day.month >= 7 else day.year - 1


def _product(name):
    """A product's own name (the part after the last ":"), compared lower case
    with its dashes and spaces evened out."""
    short = str(name or "").split(":")[-1]
    return " ".join(short.replace("–", "-").replace("—", "-").lower().split())


def is_snow_quote(e):
    """Whether an estimate is a quote for snow: one of the Snow Removal
    products is on it."""
    for ln in qb._flat_lines((e or {}).get("Line")):
        if ln.get("DetailType") != "SalesItemLineDetail":
            continue
        ref = (ln.get("SalesItemLineDetail") or {}).get("ItemRef") or {}
        if _product(ref.get("name")) in SNOW_PRODUCTS:
            return True
    return False


def snow_quote(e):
    """What a customer keeps of a snow estimate -- or None when it is not one.
    `sold`: the customer said yes, however QuickBooks shows it (accepted, or
    made into an invoice -- quickbooks._sold). No money on it (a customer is
    read by whoever sees Contacts)."""
    if not is_snow_quote(e):
        return None
    d = str(e.get("TxnDate") or "")[:10]
    try:
        season = season_of(d)
    except ValueError:
        return None
    return {"id": str(e.get("Id") or ""), "num": str(e.get("DocNumber") or ""), "date": d,
            "status": str(e.get("TxnStatus") or "Pending"), "sold": bool(qb._sold(e)), "season": season}


def _snow_accounts(db, quotes, docs):
    """Customer id -> the ids of the Snow accounts in Job Hub that are theirs
    (switched-off accounts never count): tied to them by id (customerId --
    "To sort", or the import that made it); or, for an account tied to nobody
    yet, made from or joined to one of their snow estimates, or of the same
    name or house number and street (the way the snow import joins an
    account it finds -- quickbooks.snow_account)."""
    coll = db.collection("snowAccounts")
    accts = {s.id: (s.to_dict() or {}) for s in coll.stream()}
    accts = {aid: a for aid, a in accts.items() if a.get("active") is not False}
    untied = [aid for aid, a in accts.items() if not a.get("customerId")]
    # The estimate an account was joined to is kept with its prices.
    joined = {}
    if untied:
        refs = [coll.document(aid).collection("private").document("rates") for aid in untied]
        for s in db.get_all(refs):
            if s.exists:
                eid = ((s.to_dict() or {}).get("fromQb") or {}).get("estimateId")
                if eid:
                    joined[s.reference.path.split("/")[1]] = str(eid)
    # A lead an account was tied to may have become a QuickBooks customer.
    leads = sorted({str(a["customerId"]) for a in accts.values() if str(a.get("customerId") or "").startswith("ld")})
    merged = {}
    if leads:
        for s in db.get_all([db.collection(COLL).document(x) for x in leads]):
            if s.exists and (s.to_dict() or {}).get("mergedInto"):
                merged[s.id] = str(s.to_dict()["mergedInto"])
    tied, by_est = {}, {}
    for aid, a in accts.items():
        if a.get("customerId"):
            cid = str(a["customerId"])
            tied.setdefault(merged.get(cid, cid), []).append(aid)
            continue
        for eid in ((a.get("fromQuickBooks") or {}).get("estimateId"), joined.get(aid)):
            if eid:
                by_est[str(eid)] = aid
    out = {}
    for cid, qs in quotes.items():
        mine = list(tied.get(cid) or [])
        mine += [by_est[q["id"]] for q in qs if q["id"] in by_est]
        c = docs.get(cid) or {}
        name = qb._norm_name(c.get("name"))
        keys = {k for k in (qb._street_key(c.get("street") or c.get("address")),
                            qb._street_key(((c.get("ship") or {}).get("street")) or ((c.get("ship") or {}).get("address"))))
                if k}
        for aid in untied:
            a = accts[aid]
            if (name and qb._norm_name(a.get("name")) == name) or \
                    (keys and qb._street_key(a.get("street") or a.get("address")) in keys):
                mine.append(aid)
        out[cid] = sorted(set(mine))
    return out


def _write_snow(db, quotes, state, now):
    """Each customer's snow quotes and accounts onto their record -- only
    where something changed -- and taken off one who has none any more (the
    seasons moved on). Returns how many were written."""
    had = set(state.get("snowIds") or [])
    ids = sorted(set(quotes) | had)
    if not ids:
        state["snowIds"] = []
        return 0
    docs = {s.id: (s.to_dict() or {}) for s in db.get_all([db.collection(COLL).document(cid) for cid in ids]) if s.exists}
    accounts = _snow_accounts(db, {cid: qs for cid, qs in quotes.items() if cid in docs}, docs)
    writes = []
    for cid in ids:
        if cid not in docs:
            continue                              # not read from QuickBooks yet: the next look has it
        cur = docs[cid].get("snow") or None
        if cid not in quotes:
            if cur:
                writes.append((cid, {"snow": None, "updatedAt": now}))
            continue
        new = {"quotes": quotes[cid], "accounts": accounts.get(cid) or []}
        if not cur or {"quotes": cur.get("quotes"), "accounts": cur.get("accounts")} != new:
            writes.append((cid, {"snow": dict(new, at=now), "updatedAt": now}))
    _write(db, writes)
    state["snowIds"] = sorted(cid for cid in quotes if cid in docs)
    return len(writes)


# ---------------------------------------------------------------- Job Hub -> QuickBooks


def _to_qb(c, fields):
    """The sparse update for QuickBooks: only the fields changed."""
    body = {}
    put = lambda k: k in fields
    if put("name"):
        body["DisplayName"] = qb._qb_name(fields["name"], 500)
    if put("firstName"):
        body["GivenName"] = qb._qb_name(fields["firstName"], 100)
    if put("lastName"):
        body["FamilyName"] = qb._qb_name(fields["lastName"], 100)
    if put("business"):
        body["CompanyName"] = qb._qb_name(fields["business"], 100)
    if put("phone"):
        body["PrimaryPhone"] = {"FreeFormNumber": _s(fields["phone"])[:30]}
    if put("mobile"):
        body["Mobile"] = {"FreeFormNumber": _s(fields["mobile"])[:30]}
    if put("email"):
        body["PrimaryEmailAddr"] = {"Address": _s(fields["email"])[:100]}
    if any(put(k) for k in ADDR_KEYS):
        # The whole address goes back in its proper boxes. Lines QuickBooks had
        # beyond the street (a name above it, "Town, ST ZIP" below) are
        # emptied, or the old town would still be printed under the new one.
        was = dict(c.get("BillAddr") or {})
        cur = from_qb(c)
        parts = {k: _s(fields[k] if k in fields else cur.get(k)) for k in ADDR_KEYS}
        addr = {"Line1": parts["street"][:500], "City": parts["city"][:255],
                "CountrySubDivisionCode": parts["state"].upper()[:255], "PostalCode": parts["zip"][:30]}
        for i in range(2, 6):
            if was.get("Line%d" % i):
                addr["Line%d" % i] = ""
        if was.get("Id"):
            addr["Id"] = was["Id"]
        if was.get("Country"):
            addr["Country"] = was["Country"]
        body["BillAddr"] = addr
    return body


def save(cust_id, fields, was=None, force=False):
    """A Job Hub change to a customer's contact details, into QuickBooks.

    fields: {key: new value} for the keys changed (EDIT_KEYS only); was: the
    values they had when the change was started. If QuickBooks has changed
    one of the same fields meanwhile, to something else, nothing is sent:
    both are kept on the customer (qbConflict) and Jonah picks -- `force`
    then sends his. Returns {"ok": True} or {"conflict": {...}}."""
    if qb._env("QB_ENV", "sandbox") != "production":
        raise RuntimeError("QuickBooks is connected to Intuit's TEST company — customers are only kept in step "
                           "with your real QuickBooks.")
    cust_id = str(cust_id or "").strip()
    if not cust_id.isdigit():
        raise RuntimeError("This one has no QuickBooks profile yet — it is made with their first estimate.")
    fields = {k: _s(v) for k, v in (fields or {}).items() if k in EDIT_KEYS}
    was = {k: _s(v) for k, v in (was or {}).items() if k in EDIT_KEYS}
    if "name" in fields and not fields["name"]:
        raise RuntimeError("QuickBooks needs a name for every customer.")
    db = qb._db()
    doc = db.collection(COLL).document(cust_id)
    now = qb._stamp()
    c = qb._query_one("Customer", "Id = '%s' and Active IN (true, false)" % qb._quote(cust_id))
    if not c:
        raise RuntimeError("QuickBooks has no customer with that id any more.")
    theirs = from_qb(c)
    if not force:
        # A field QuickBooks changed since this edit began (it no longer says
        # what Job Hub showed) to something other than the edit: a conflict.
        clash = [k for k in fields if k in was and not _same(theirs.get(k), was[k])
                 and not _same(theirs.get(k), fields[k])]
        if clash:
            conflict = {"at": now, "theirs": {k: theirs.get(k) for k in fields}, "mine": dict(fields)}
            doc.set({"qbConflict": conflict, "updatedAt": now}, merge=True)
            return {"conflict": conflict}
    if all(_same(theirs.get(k), v) for k, v in fields.items()):
        saved = c                                    # QuickBooks already has it
    else:
        body = dict(_to_qb(c, fields), Id=c["Id"], SyncToken=c["SyncToken"], sparse=True)
        try:
            saved = (qb._call("POST", "customer", body=body) or {}).get("Customer") or c
        except qb.ReconnectNeeded:
            raise
        except Exception as err:                    # noqa: BLE001
            msg = str(err)
            if "Duplicate Name" in msg or "6240" in msg:
                msg = "QuickBooks already has another customer called that — pick a different name."
            doc.set({"qbError": {"at": now, "message": msg[:500]}, "updatedAt": now}, merge=True)
            raise RuntimeError(msg)
    rec = from_qb(saved)
    doc.set(dict({k: rec.get(k) for k in QB_KEYS}, qbPending=None, qbConflict=None, qbError=None,
                 updatedAt=now), merge=True)
    return {"ok": True, "qbSyncToken": rec["qbSyncToken"]}


def push_pending():
    """Edits made in Job Hub that have not reached QuickBooks (no signal at
    the time, or the send failed): sent, oldest first. A conflict waits for
    Jonah; it is not sent again by itself."""
    db = qb._db()
    snaps = list(db.collection(COLL).where("qbPending.at", ">", "").limit(PUSH_MAX * 2).stream())
    done = 0
    for s in sorted(snaps, key=lambda x: str(((x.to_dict() or {}).get("qbPending") or {}).get("at") or "")):
        if done >= PUSH_MAX:
            break
        d = s.to_dict() or {}
        p = d.get("qbPending") or {}
        if d.get("qbConflict") or not s.id.isdigit():
            continue
        keys = [k for k in (p.get("fields") or []) if k in EDIT_KEYS]
        if not keys:
            s.reference.set({"qbPending": None}, merge=True)
            continue
        try:
            save(s.id, {k: d.get(k) for k in keys}, p.get("was") or {})
            done += 1
        except qb.ReconnectNeeded:
            raise
        except Exception as err:                    # noqa: BLE001
            print("customers: %s not sent to QuickBooks: %s" % (s.id, str(err)[:300]))
    return done


# ---------------------------------------------------------------- a lead's first estimate

# What a lead knows that QuickBooks does not: carried onto their customer.
HUB_KEYS = ("tags", "contactWhen", "when", "whenSetAt", "note", "meetings", "reachedAt", "declined",
            "notInterested", "fromProspect", "addedAt")


def _union(a, b):
    out = list(a or [])
    for x in b or []:
        if x not in out:
            out.append(x)
    return out


def estimate_made(job_id, qb_customer_id):
    """An estimate was just saved in QuickBooks for this job, to this
    QuickBooks customer (quickbooks.save_estimate). The job is tied to that
    customer if it was tied to nobody, and a lead it was tied to becomes
    the customer: their tags, notes and time to call carried across, the
    lead marked mergedInto it (kept, not deleted). Real company only."""
    if qb._env("QB_ENV", "sandbox") != "production" or not qb_customer_id:
        return
    db = qb._db()
    qid = str(qb_customer_id)
    jsnap = db.collection("jobs").document(job_id).get()
    job = (jsnap.to_dict() or {}) if jsnap.exists else {}
    was = str(job.get("customerId") or "")
    now = qb._stamp()
    if was == qid:
        return
    if was and not was.startswith("ld"):
        # Tied by hand to another QuickBooks customer: his pick stands.
        return
    lead = None
    if was:
        ls = db.collection(COLL).document(was).get()
        lead = (ls.to_dict() or {}) if ls.exists else None
    if lead and not lead.get("mergedInto"):
        cs = db.collection(COLL).document(qid).get()
        cust = (cs.to_dict() or {}) if cs.exists else {}
        carry = {}
        for k in HUB_KEYS:
            v = lead.get(k)
            if v in (None, "", []):
                continue
            if k in ("tags", "declined", "meetings"):
                carry[k] = _union(cust.get(k), v)
            elif k == "note":
                carry[k] = "\n".join(x for x in (_s(cust.get("note")), str(v).strip()) if x)
            elif not cust.get(k):
                carry[k] = v
        if not cust:
            # Not read from QuickBooks yet (the next hourly look fills it):
            # enough to show in the list until then.
            carry.update({k: lead.get(k) or "" for k in EDIT_KEYS + ("address",)})
            carry.update(qbCustomerId=qid, source="lead", createdAt=now)
        carry.update(fromLead=was, updatedAt=now)
        db.collection(COLL).document(qid).set(carry, merge=True)
        db.collection(COLL).document(was).set({"mergedInto": qid, "mergedAt": now, "updatedAt": now}, merge=True)
        # Every other job tied to the lead follows.
        for s in db.collection("jobs").where("customerId", "==", was).stream():
            if s.id != job_id:
                s.reference.set({"customerId": qid, "lastModified": qb._stamp()}, merge=True)
    db.collection("jobs").document(job_id).set(
        {"customerId": qid, "customerBy": job.get("customerBy") or "auto", "lastModified": qb._stamp()}, merge=True)
