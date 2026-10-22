"""YD Job Hub -- the Claude server piece.

Why this exists at all: Claude's API needs a secret key, and anything in the app
itself is readable by anyone who opens it. So the key lives here, on Google's
servers, and the app asks this function instead of asking Claude directly. The
key never reaches a phone or a browser.

Three rules this file is built around:

1. NAMED TASKS ONLY. The app cannot send a free-form prompt. It sends a task
   name and some data; the wording lives here. That keeps a compromised or
   curious client from running up the bill with arbitrary requests, and it means
   adding a Claude-powered feature later is a new entry in TASKS -- not new
   plumbing, not a new deployment pattern, not new security review.

2. PROVE WHO IS ASKING. Every call must carry a Firebase sign-in token, and the
   caller's record in Firestore must say owner. Without this, the URL is a free
   Claude account for anyone who finds it.

3. SPEND IS CAPPED AND LOGGED. A daily call ceiling, bounded output length, and
   every call's token usage written to Firestore so the cost is visible instead
   of arriving as a surprise on a statement.
"""

import datetime
import hmac
import json
import os
import time

import anthropic
import firebase_admin
import functions_framework
from firebase_admin import auth as fb_auth
from firebase_admin import firestore

# ---------------------------------------------------------------- setup

firebase_admin.initialize_app()
_db = firestore.client()

# Built on first use, not at import. Reading the key at import means a missing or
# not-yet-set key stops the container from starting at all, which surfaces as an
# opaque deployment failure rather than "the key isn't set". This way the service
# deploys and starts fine, and says plainly what is wrong if the key is absent.
_claude_client = None


def _claude():
    global _claude_client
    if _claude_client is None:
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY is not set on this service. Add it under "
                "Cloud Run -> yd-claude -> Edit & deploy new revision -> "
                "Variables & Secrets."
            )
        _claude_client = anthropic.Anthropic(api_key=key)
    return _claude_client

# Writing a scope of work is plain writing: the mid-priced model does it well
# (Jonah, 7 Oct: nothing in the app should spend more than it needs to).
MODEL = "claude-sonnet-5-5"
# The board cards are worked twice a day, not every hour (Jonah, 7 Oct): at
# these Chicago hours, unless settings/claude.cardHours says otherwise. The
# scheduler still calls every hour -- the QuickBooks check rides on it.
# And only while settings/claude.cardRuns is true: switched off 9 Oct (Jonah:
# not enough on the boards yet, more useful next year). The switch is on
# Pricing rules -> Claude; "Ask Claude now" on a card works either way.
CARD_HOURS = (7, 19)
# The hourly /cards/run request: no new step (QuickBooks look, cards) is
# started after this many seconds. Cloud Run and the scheduler give it 900.
RUN_BUDGET = 600
DAILY_CALL_LIMIT = 200          # a working day of heavy use is nowhere near this
# The live app only. A local copy (localhost) never needs to call the real
# server: its signed-in screens are tested against a fake database.
ALLOWED_ORIGINS = {
    "https://jonahlinfieldydexteriorvisionsllc.github.io",
    "https://jobhub.ydexteriorvisions.com",
}

# ---------------------------------------------------------------- the tasks
#
# Adding a feature means adding an entry here. `build` turns the app's data into
# the user turn; everything else is wording that stays server-side.

def _scope_prompt(d):
    return (
        "Write the scope of work for this landscaping estimate.\n\n"
        f"Customer: {d.get('customer', '(not given)')}\n"
        f"Location: {d.get('location', '(not given)')}\n"
        f"Services: {', '.join(d.get('services', [])) or '(not given)'}\n"
        f"Measurements and site notes: {d.get('notes', '(none)')}\n"
        f"Price: {d.get('price', '(not set)')}\n"
    )


TASKS = {
    "estimate_scope": {
        "system": (
            "You write scopes of work for YD Exterior Visions, a landscaping and "
            "hardscaping company near Madison, Wisconsin. Write the way a working "
            "contractor writes for a homeowner: plain, specific, and confident. "
            "Say what will be done, in what order, and what the customer will end "
            "up with.\n\n"
            "Rules that matter:\n"
            "- Never invent a measurement, material, quantity or price. If a "
            "detail is missing, write around it rather than guessing.\n"
            "- No marketing language, no adjectives doing the work of facts, no "
            "'we pride ourselves'.\n"
            "- Short paragraphs or bullets. This gets read on a phone.\n"
            "- Do not restate the price; it appears elsewhere on the estimate."
        ),
        "build": _scope_prompt,
        "max_tokens": 2000,
        "effort": "medium",
    },
}

# ---------------------------------------------------------------- helpers


def _cors(origin):
    headers = {"Vary": "Origin"}
    if origin in ALLOWED_ORIGINS:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
        headers["Access-Control-Max-Age"] = "3600"
    return headers


LEVELS = {"none": 0, "see": 1, "change": 2}


def _caller(req, area=None, level="change"):
    """Return the uid of the signed-in caller, or raise PermissionError.

    The owner may do everything here. An admin may only when an `area` is
    named and the owner gave them at least `level` in it (users/{uid}.access,
    the same table firestore.rules enforces). Nothing else gets through.
    """
    header = req.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise PermissionError("not signed in")
    try:
        token = fb_auth.verify_id_token(header[7:])
    except Exception:
        raise PermissionError("sign-in could not be verified")

    uid = token["uid"]
    snap = _db.collection("users").document(uid).get()
    if not snap.exists:
        raise PermissionError("no access")
    user = snap.to_dict()
    if user.get("active") is not True:
        raise PermissionError("no access")
    if user.get("role") == "owner":
        return uid
    if area and user.get("role") == "admin":
        have = (user.get("access") or {}).get(area, "none")
        if LEVELS.get(have, 0) >= LEVELS.get(level, 2):
            return uid
    raise PermissionError("owner access required")


def _member(req):
    """(uid, user record) for anyone signed in and active -- owner, admin or
    crew. For the few things every crew member may do (a receipt photo)."""
    header = req.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise PermissionError("not signed in")
    try:
        token = fb_auth.verify_id_token(header[7:])
    except Exception:
        raise PermissionError("sign-in could not be verified")
    snap = _db.collection("users").document(token["uid"]).get()
    user = snap.to_dict() if snap.exists else None
    if not user or user.get("active") is not True or user.get("role") not in ("owner", "admin", "crew"):
        raise PermissionError("no access")
    return token["uid"], user


CREW_PHOTOS_PER_DAY = 15


def _crew_photo_allowance(uid):
    """A crew member's receipt photos come out of the same daily Claude
    allowance as Jonah's estimates; each has a smaller one of their own, so a
    stuck camera button cannot use the day up."""
    day = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    ref = _db.collection("claudeUsage").document(day)
    snap = ref.get()
    used = (((snap.to_dict() or {}).get("photosBy") or {}).get(uid, 0)) if snap.exists else 0
    if used >= CREW_PHOTOS_PER_DAY:
        raise RuntimeError("That's %d receipt photos today — the rest can wait for tomorrow" % CREW_PHOTOS_PER_DAY)
    ref.set({"photosBy": {uid: firestore.Increment(1)}}, merge=True)


def _check_and_count_usage(uid, cap_checked=False):
    """Daily call ceiling and spending ceiling. Refuses rather than quietly
    spending. cap_checked: the caller has just asked spend.over_cap itself
    (a ~30-read question), so it is not asked twice."""
    import spend
    why = None if cap_checked else spend.over_cap(_db)
    if why:
        raise RuntimeError(why)
    day = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    ref = _db.collection("claudeUsage").document(day)
    snap = ref.get()
    used = (snap.to_dict() or {}).get("calls", 0) if snap.exists else 0
    if used >= DAILY_CALL_LIMIT:
        raise RuntimeError(
            "Daily limit reached (%d calls). This resets at midnight UTC."
            % DAILY_CALL_LIMIT
        )
    ref.set({"calls": firestore.Increment(1), "lastUid": uid}, merge=True)
    return day


def _record_spend(day, task, usage, model=MODEL):
    """Write what each call cost -- in cents, cache tokens included -- so
    spend is visible, not inferred (spend.py)."""
    import spend
    spend.record(_db, day, task, model, usage)


# ---------------------------------------------------------------- quickbooks
#
# The routing and the guards live here; what each one actually does is in
# quickbooks.py. Two of these are deliberately not owner-authenticated, and the
# reasons matter:
#
#   /qb/callback  is where Intuit sends the owner's browser back. A redirect
#                 cannot carry an Authorization header, so it is tied to the
#                 person who started it by a one-use state value instead.
#
#   /qb/keepalive is called by a scheduler, not a person. It is protected by a
#                 shared secret in a header, and it can only refresh a token --
#                 it cannot read a customer, raise an invoice, or disconnect.


def _quickbooks(request, path, headers):
    # Imported here rather than at the top so a problem in the QuickBooks half
    # -- a missing dependency, a bad deploy -- cannot stop the container
    # starting and take the Claude features down with it.
    import quickbooks as qb

    json_headers = {**headers, "Content-Type": "application/json"}

    if request.method == "OPTIONS":
        return ("", 204, headers)

    # The browser lands here from Intuit, so it answers with a page, not JSON.
    if path == "/qb/callback":
        try:
            html, status = qb.callback(request)
        except Exception as e:                          # noqa: BLE001
            print("quickbooks callback error:", e)
            html, status = ("<p>Something went wrong connecting QuickBooks.</p>", 500)
        return (html, status, {"Content-Type": "text/html; charset=utf-8"})

    if path == "/qb/keepalive":
        expected = os.environ.get("QB_KEEPALIVE_SECRET", "")
        given = request.headers.get("X-Keepalive-Secret", "")
        # A missing secret refuses rather than waves everything through: an
        # endpoint that stops being protected when a variable goes missing is
        # worse than one that stops working.
        # Compared in constant time, so the answer's timing gives nothing of
        # the secret away.
        if not expected or not hmac.compare_digest(given.encode(), expected.encode()):
            return (json.dumps({"error": "not allowed"}), 403, json_headers)
        try:
            return (json.dumps(qb.keepalive()), 200, json_headers)
        except Exception as e:                          # noqa: BLE001
            print("keepalive failed:", e)
            return (json.dumps({"error": str(e)}), 500, json_headers)

    # Everything else is from the app. Connecting and disconnecting are the
    # owner's alone; using the connection to send storms is Billing, which the
    # owner can give an admin.
    if origin_blocked(request):
        return (json.dumps({"error": "origin not allowed"}), 403, json_headers)
    billing = path in ("/qb/status", "/qb/customers", "/qb/items", "/qb/invoice",
                       "/qb/estimate", "/qb/estimate-status", "/qb/estimate-invoice", "/qb/invoice-status",
                       "/qb/invoice-remind", "/qb/invoices-now", "/qb/payments-now", "/qb/change-order")
    # A customer's contact details, from the Customers tab: whoever may change Contacts.
    contacts = path in ("/qb/customer-save", "/qb/customers-now")
    try:
        uid = _caller(request, "billing", "change") if billing else             _caller(request, "contacts", "change") if contacts else _caller(request)
    except PermissionError as e:
        return (json.dumps({"error": str(e)}), 401, json_headers)

    body = request.get_json(silent=True) or {}
    try:
        if path == "/qb/connect-url":
            result = qb.connect_url(uid)
        elif path == "/qb/status":
            result = qb.status()
        elif path == "/qb/disconnect":
            result = qb.disconnect()
        elif path == "/qb/customers":
            result = qb.customers()
        elif path == "/qb/items":
            result = qb.items()
        elif path == "/qb/invoice":
            result = qb.create_invoice(body)
        elif path in ("/qb/estimate", "/qb/estimate-invoice") and qb._env("QB_ENV", "sandbox") != "production" \
                and not body.get("testOk"):
            # Intuit's TEST company is connected (Jonah, 13 Oct 2026: a real
            # bid went into it). Nothing goes there unless he typed TEST --
            # an older copy of the app on a phone cannot send one by mistake.
            return (json.dumps({"error": "QuickBooks is connected to Intuit's TEST company, not your real QuickBooks. "
                                         "Switch to your real company before sending bids.", "testCompany": True}),
                    412, json_headers)
        elif path == "/qb/estimate":
            result = qb.save_estimate(body)
        elif path == "/qb/estimate-status":
            result = qb.estimate_status(body)
        elif path == "/qb/estimate-invoice":
            result = qb.invoice_from_estimate(body)
        elif path == "/qb/invoice-status":
            result = qb.invoice_status(body)
        elif path == "/qb/invoice-remind":
            # A reminder emailed from QuickBooks (invoices.js Send reminder).
            who = (_db.collection("users").document(uid).get().to_dict() or {}).get("name") or ""
            result = qb.invoice_remind(body, who)
        elif path == "/qb/payments-now":
            # A payment just logged on a job (app.js): to QuickBooks now, not
            # at the next hourly look -- and QuickBooks' payments back onto it.
            jid = str(body.get("jobId") or "").strip()
            snap = _db.collection("jobs").document(jid).get() if jid else None
            if not snap or not snap.exists:
                raise RuntimeError("No such job")
            with qb._holding_tokens():
                jobs = qb.live_jobs({s.id: (s.to_dict() or {}) for s in _db.collection("jobs").select(qb.SWEEP_FIELDS).stream()})
                qb.sync_invoices(jobs)
                result = {"ok": True, "changed": qb.sync_payments({jid: snap.to_dict() or {}}, only=jid)}
        elif path == "/qb/change-order":
            # A signed change order's price onto the job's invoice (signatures.js, his tap).
            result = qb.add_change_order(body)
        elif path == "/qb/invoices-now":
            # The Invoices list brought up to date now, not at the next hourly look.
            jobs = qb.live_jobs({s.id: (s.to_dict() or {}) for s in _db.collection("jobs").select(qb.SWEEP_FIELDS).stream()})
            with qb._holding_tokens():
                news = qb.sync_invoices(jobs)
                # And jobs tied to a QuickBooks estimate or invoice filled from it now,
                # each line in QuickBooks' words.
                filled = qb.fill_imported(jobs)
                qb.keep_qb_words(jobs)
            _tell_owner(news)
            result = {"ok": True, "filled": filled}
        elif path == "/qb/customer-save":
            # A customer's details changed in Job Hub (customers.js): into
            # QuickBooks now. {id, fields, was, force}
            import customers
            with qb._holding_tokens():
                result = customers.save(body.get("id"), body.get("fields") or {}, body.get("was") or {},
                                        force=body.get("force") is True)
        elif path == "/qb/customers-now":
            # The customer list brought up to date now, not at the next
            # hourly look -- only once the owner has switched it on.
            import customers
            with qb._holding_tokens():
                result = {"ok": True, "result": customers.sync()}
        else:
            return (json.dumps({"error": "unknown endpoint"}), 404, json_headers)
    except PermissionError as e:
        # QuickBooks itself refused -- the connection needs remaking.
        return (json.dumps({"error": str(e), "reconnect": True}), 409, json_headers)
    except Exception as e:                              # noqa: BLE001
        print("quickbooks %s failed: %s" % (path, e))
        return (json.dumps({"error": str(e)}), 502, json_headers)

    return (json.dumps(result), 200, json_headers)


def origin_blocked(request):
    origin = request.headers.get("Origin", "")
    return bool(origin) and origin not in ALLOWED_ORIGINS


# ---------------------------------------------------------------- summaries
#
#   /digest/run      called by Cloud Scheduler three times a day. Proven to be
#                    the scheduler by a Google-signed identity token for this
#                    service's own account -- no shared secret to keep.
#   /digest/preview  the owner, from the app: see a summary now, or have one
#                    sent to themselves to check it arrives.


def _from_scheduler(request):
    from google.auth.transport.requests import Request
    from google.oauth2 import id_token
    import digest
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return False
    try:
        claims = id_token.verify_oauth2_token(header[7:], Request(), audience="https://" + request.host)
    except Exception as e:                              # noqa: BLE001
        print("digest: scheduler token refused:", e)
        return False
    return claims.get("email") == digest._service_account_email() and claims.get("email_verified")


def _digest(request, path, headers):
    import digest
    json_headers = dict(headers, **{"Content-Type": "application/json"})
    if request.method == "OPTIONS":
        return ("", 204, headers)
    body = request.get_json(silent=True) or {}
    slot = body.get("slot") or request.args.get("slot") or "morning"

    # The PUBLIC half of the notification key, which a phone needs in order to
    # sign up. Worked out from the private key in Secret Manager rather than
    # copied anywhere by hand, so the two can never disagree.
    if path == "/digest/pushkey":
        import base64
        from cryptography.hazmat.primitives.serialization import (Encoding, PublicFormat,
                                                                  load_der_private_key)
        key = os.environ.get("VAPID_PRIVATE", "").strip()
        if not key:
            return (json.dumps({"error": "phone notifications are not set up yet"}), 503, json_headers)
        der = base64.urlsafe_b64decode(key + "=" * (-len(key) % 4))
        pub = load_der_private_key(der, None).public_key().public_bytes(
            Encoding.X962, PublicFormat.UncompressedPoint)
        return (json.dumps({"key": base64.urlsafe_b64encode(pub).rstrip(b"=").decode()}), 200, json_headers)

    # Calendar reminders, every five minutes, from Cloud Scheduler only.
    if path == "/digest/reminders":
        if not _from_scheduler(request):
            return (json.dumps({"error": "not allowed"}), 403, json_headers)
        try:
            import reminders
            return (json.dumps({"sent": reminders.run()}), 200, json_headers)
        except Exception as e:                          # noqa: BLE001
            print("reminders run failed:", e)
            return (json.dumps({"error": str(e)}), 500, json_headers)

    if path == "/digest/run":
        if not _from_scheduler(request):
            return (json.dumps({"error": "not allowed"}), 403, json_headers)
        # The summary FIRST, on time (it used to wait behind the clean-up
        # below, photo by photo).
        try:
            report, failed = digest.run(slot), None
        except Exception as e:                          # noqa: BLE001
            print("digest run failed:", e)
            report, failed = None, str(e)
        # Then, once a day after the morning summary: finished cards done
        # more than a week ago are deleted (tidy.py), and jobs in Recently
        # deleted over 30 days, with their photos. Whatever happens there,
        # the summary has gone.
        tidied = None
        if slot == "morning":
            try:
                import tidy
                tidied = tidy.run()
            except Exception as e:                      # noqa: BLE001
                print("tidy run failed:", e)
            try:
                import tidy
                tidy.purge_jobs()
            except Exception as e:                      # noqa: BLE001
                print("tidy: deleted jobs not cleared:", e)
        if failed is not None:
            return (json.dumps({"error": failed}), 500, json_headers)
        return (json.dumps({"slot": slot, "report": report, "tidied": tidied}), 200, json_headers)

    if path == "/digest/preview":
        if origin_blocked(request):
            return (json.dumps({"error": "origin not allowed"}), 403, json_headers)
        try:
            uid = _caller(request)
        except PermissionError as e:
            return (json.dumps({"error": str(e)}), 401, json_headers)
        try:
            report = digest.run(slot, only_uid=uid, dry=not body.get("send"))
            return (json.dumps({"slot": slot, "report": report}), 200, json_headers)
        except Exception as e:                          # noqa: BLE001
            print("digest preview failed:", e)
            return (json.dumps({"error": str(e)}), 500, json_headers)

    return (json.dumps({"error": "unknown endpoint"}), 404, json_headers)


# ---------------------------------------------------------------- board cards
#
# Claude working the cards it can do by itself (cards.py). The hourly run comes
# from Cloud Scheduler only; "Ask Claude now" on one card comes from the owner.


def _cards(request, path, headers):
    import cards
    json_headers = dict(headers, **{"Content-Type": "application/json"})
    if request.method == "OPTIONS":
        return ("", 204, headers)
    if path == "/cards/run":
        if not _from_scheduler(request):
            return (json.dumps({"error": "not allowed"}), 403, json_headers)
        only = None
        # Only the morning and evening calls work cards, and only while card
        # runs are switched on; the others just do the QuickBooks check below.
        if not _card_hour():
            only = "skip"
    elif path == "/cards/now":
        if origin_blocked(request):
            return (json.dumps({"error": "origin not allowed"}), 403, json_headers)
        try:
            _caller(request)            # the owner only: it spends Claude credit
        except PermissionError as e:
            return (json.dumps({"error": str(e)}), 401, json_headers)
        body = request.get_json(silent=True) or {}
        board_id, card_id = str(body.get("boardId") or ""), str(body.get("cardId") or "")
        if not board_id or not card_id:
            return (json.dumps({"error": "which card?"}), 400, json_headers)
        only = (board_id, card_id)
    else:
        return (json.dumps({"error": "unknown endpoint"}), 404, json_headers)
    # The hourly run asks QuickBooks about estimates out with customers and
    # invoices not yet paid off (quickbooks.sweep): a "yes" or a payment
    # reaches the job, and Jonah's phone, without him looking. That comes
    # FIRST -- it is the part that matters every hour; Claude's cards (slow:
    # a web search each) only get the time left. The request has RUN_BUDGET
    # seconds in all: past it nothing new is started, so it ends well inside
    # Cloud Run's limit instead of being cut off half way.
    deadline = time.monotonic() + RUN_BUDGET
    if only is None or only == "skip":
        try:
            _tell_owner(qb_sweep_news(deadline))
        except Exception as e:                      # noqa: BLE001
            print("quickbooks sweep failed:", e)
    failed, report = None, [{"skipped": "not a card run (switched off, or not one of the card hours)"}]
    try:
        if only is None and time.monotonic() > deadline:
            report = [{"skipped": "out of time after the QuickBooks look -- the next card run takes them"}]
        elif only != "skip":
            report = cards.run(_claude(), only)
    except Exception as e:                          # noqa: BLE001
        print("cards run failed:", e)
        failed = str(e)
    if failed is not None:
        return (json.dumps({"error": failed}), 500, json_headers)
    return (json.dumps({"report": report}), 200, json_headers)


def _card_hour():
    """Whether this scheduler call is one of the day's card runs."""
    from zoneinfo import ZoneInfo
    try:
        snap = _db.collection("settings").document("claude").get()
        conf = (snap.to_dict() or {}) if snap.exists else {}
    except Exception as e:                          # noqa: BLE001
        print("cards: could not read the card settings:", e)
        return False
    # Off unless switched on: spending Claude credit is the thing to ask for.
    if conf.get("cardRuns") is not True:
        return False
    hours = CARD_HOURS
    got = conf.get("cardHours")
    if isinstance(got, list) and got and all(isinstance(h, int) and 0 <= h <= 23 for h in got):
        hours = tuple(got)
    return datetime.datetime.now(ZoneInfo("America/Chicago")).hour in hours


def qb_sweep_news(deadline=None):
    import quickbooks
    return quickbooks.sweep(deadline)


def _money(v):
    try:
        return "${:,.2f}".format(float(v))
    except (TypeError, ValueError):
        return ""


def _tell_owner(news):
    """One phone notification per thing that happened in QuickBooks."""
    if not news:
        return
    import digest
    owners = [s.id for s in digest._db().collection("users").where("role", "==", "owner").stream()]
    for n in news:
        num = (" #" + str(n["docNumber"])) if n.get("docNumber") else ""
        if n["kind"] == "estimate":
            title = {"Accepted": "✅ Estimate accepted", "Rejected": "Estimate turned down",
                     "Closed": "Estimate made into an invoice"}.get(n["status"], "Estimate " + str(n["status"]).lower())
            body = "%s — estimate%s %s" % (n["name"], num, _money(n.get("total")))
            if n["status"] == "Accepted":
                # Booked by the owner's device (sync.js bookIfAccepted).
                body += ". It's booked as a job — make the invoice from the job."
            elif n.get("accepted"):
                # Accepted and invoiced in QuickBooks between two looks.
                title = "✅ Estimate accepted — and invoiced in QuickBooks"
                body += ". It's booked as a job."
        elif n["kind"] == "notBrought":
            # quickbooks.import_accepted could not make or link its job.
            title = "📥 Estimate accepted in QuickBooks"
            why = ("%d jobs here have that number, so it wasn't linked to one" % n.get("count", 2)
                   if n.get("why") == "several" else "its job couldn't be made here")
            body = "%s accepted estimate%s %s — %s. Book it by hand." % (n["name"], num, _money(n.get("total")), why)
        elif n["kind"] == "copy":
            # quickbooks.import_accepted: a copy of an estimate already a job here.
            title = "📥 Estimate accepted again in QuickBooks"
            body = "%s accepted estimate%s %s — the same as #%s, already their job here, so no second job was made." % (
                n["name"], num, _money(n.get("total")), n.get("sameAs") or "?")
        elif n["kind"] == "imported":
            # An estimate made in QuickBooks itself (quickbooks.import_accepted).
            title = "📥 New job from QuickBooks"
            body = "%s accepted estimate%s %s. It's on the Jobs board." % (n["name"], num, _money(n.get("total")))
        elif n["kind"] in ("snowAdded", "snowLinked"):
            # A snow contract accepted in QuickBooks (quickbooks.snow_account).
            title = "❄ Snow contract accepted"
            body = ("%s accepted estimate%s — added to the Snow route." if n["kind"] == "snowAdded"
                    else "%s accepted estimate%s — joined to their Snow account (your prices kept).") % (n["name"], num)
        elif n["kind"] == "linked":
            title = "✅ Estimate accepted"
            body = "%s accepted estimate%s %s in QuickBooks — linked to their job here." % (n["name"], num, _money(n.get("total")))
        else:
            title = "💵 Payment received"
            body = "%s paid %s on invoice%s — %s still owed" % (n["name"], _money(n.get("paid")), num, _money(n.get("balance")))
        for uid in owners:
            try:
                digest.send_push(uid, {"push": {"title": title, "body": body}}, tag="qb-" + str(n["jobId"]))
            except Exception as e:                  # noqa: BLE001
                print("quickbooks sweep: push failed:", e)


# ---------------------------------------------------------------- receipts
#
# Receipts read out of the owner's email (receipts.py). The half-hourly look
# comes from Cloud Scheduler only; "Check email now" comes from the owner, or
# an admin who may change jobs (sorting receipts writes into jobs).


def _receipts(request, path, headers):
    import receipts
    json_headers = dict(headers, **{"Content-Type": "application/json"})
    if request.method == "OPTIONS":
        return ("", 204, headers)
    if path == "/receipts/run":
        if not _from_scheduler(request):
            return (json.dumps({"error": "not allowed"}), 403, json_headers)
        manual = False
    elif path == "/receipts/now":
        if origin_blocked(request):
            return (json.dumps({"error": "origin not allowed"}), 403, json_headers)
        try:
            _caller(request, "jobs", "change")
        except PermissionError as e:
            return (json.dumps({"error": str(e)}), 401, json_headers)
        manual = True
    elif path == "/receipts/photo":
        # A paper receipt photographed in the app. Anyone on the crew may send
        # one (Jonah, 6 Oct 2026); it lands in Receipts, and the reply tells
        # them what was read -- they never see the list itself. The job (or
        # vehicle) it is sent for is checked in receipts.from_photo
        # (_sent_for): it must exist, else the receipt waits for Jonah.
        if origin_blocked(request):
            return (json.dumps({"error": "origin not allowed"}), 403, json_headers)
        try:
            uid, user = _member(request)
            # The spending limit first: a photo refused for it must not use up
            # one of the crew member's photos for the day.
            import spend
            why = spend.over_cap(_db)
            if why:
                raise RuntimeError(why)
            if user.get("role") == "crew":
                _crew_photo_allowance(uid)
            day = _check_and_count_usage(uid, cap_checked=True)
        except PermissionError as e:
            return (json.dumps({"error": str(e)}), 401, json_headers)
        except RuntimeError as e:
            return (json.dumps({"error": str(e)}), 429, json_headers)
        try:
            result, usage = receipts.from_photo(_claude(), request.get_json(silent=True) or {}, uid,
                                                user.get("name") or user.get("email") or "someone")
        except anthropic.RateLimitError:
            return (json.dumps({"error": "Claude is busy — try again shortly"}), 429, json_headers)
        except Exception as e:                      # noqa: BLE001
            print("receipt photo failed:", e)
            return (json.dumps({"error": "The receipt could not be read. Try again."}), 502, json_headers)
        if usage is not None:
            _record_spend(day, "receiptphoto", usage, receipts.MODEL)
        return (json.dumps(result), 400 if result.get("error") else 200, json_headers)
    elif path == "/receipts/qb-send":
        # A receipt photo sent to QuickBooks again (receipts.forward_to_qb) --
        # one whose send failed, or sent before the address was set.
        if origin_blocked(request):
            return (json.dumps({"error": "origin not allowed"}), 403, json_headers)
        try:
            _caller(request, "jobs", "change")
        except PermissionError as e:
            return (json.dumps({"error": str(e)}), 401, json_headers)
        rid = str((request.get_json(silent=True) or {}).get("id") or "").strip()
        if not rid or not _db.collection("receipts").document(rid).get().exists:
            return (json.dumps({"error": "Which receipt?"}), 400, json_headers)
        r = _db.collection("receipts").document(rid).get().to_dict() or {}
        # A photo goes as its picture; a receipt from email as that email.
        if r.get("photoPath") or r.get("source") == "photo":
            out = receipts.forward_to_qb(_db, rid)
        else:
            out = receipts.forward_one(_db, rid)
        return (json.dumps(out), 200 if out.get("ok") else 502, json_headers)
    elif path == "/receipts/qb-forward-recent":
        # "Send the ones from the last 14 days now" (Receipts tab): the email
        # receipts not yet sent to QuickBooks. The owner's alone -- it sends
        # mail from his account. One at a time with the read (same lock), so
        # the two never send the same email.
        if origin_blocked(request):
            return (json.dumps({"error": "origin not allowed"}), 403, json_headers)
        try:
            _caller(request)
        except PermissionError as e:
            return (json.dumps({"error": str(e)}), 401, json_headers)
        if not receipts._claim(_db):
            return (json.dumps({"busy": True}), 200, json_headers)
        try:
            out = receipts.forward_emails(_db, days=receipts.FORWARD_DAYS)
        except Exception as e:                      # noqa: BLE001
            print("receipts forward failed:", e)
            return (json.dumps({"error": str(e)[:200]}), 500, json_headers)
        finally:
            _db.collection("settings").document("receipts").set({"runningSince": None}, merge=True)
        return (json.dumps(out), 200, json_headers)
    else:
        return (json.dumps({"error": "unknown endpoint"}), 404, json_headers)
    try:
        report = receipts.run(_claude(), manual)
    except Exception as e:                          # noqa: BLE001
        print("receipts run failed:", e)
        return (json.dumps({"error": str(e)}), 500, json_headers)
    # Each subcontractor's invoices, for their visit counts (subvisits.py):
    # plain code, no Claude, on the same half-hourly run.
    try:
        import subvisits
        report["subVisits"] = subvisits.scan(_db)
    except Exception as e:                          # noqa: BLE001
        print("subcontractor visits not read:", e)
    return (json.dumps({"report": report}), 200, json_headers)


# ------------------------------------------------------- notes from the crew
#
# A crew member's phone, just after saving a note (crewnotes.js): "tell him
# now". Anyone on the crew may ask; it only sends the notes not yet told,
# which the five-minute reminders run would send anyway.


def _notes(request, path, headers):
    json_headers = dict(headers, **{"Content-Type": "application/json"})
    if request.method == "OPTIONS":
        return ("", 204, headers)
    if path != "/notes/ping":
        return (json.dumps({"error": "unknown endpoint"}), 404, json_headers)
    if origin_blocked(request):
        return (json.dumps({"error": "origin not allowed"}), 403, json_headers)
    try:
        _member(request)
    except PermissionError as e:
        return (json.dumps({"error": str(e)}), 401, json_headers)
    import reminders
    import endofday
    try:
        # An end-of-day report (eod.js) asks the same way: whatever is waiting
        # to be told, of either, goes now.
        sent = len(reminders.crew_notes(_db))
        try:
            sent += len(endofday.tell_owner(_db))
        except Exception as e:                      # noqa: BLE001 -- the notes were still told
            print("end-of-day ping failed:", e)
        return (json.dumps({"sent": sent}), 200, json_headers)
    except Exception as e:                          # noqa: BLE001
        print("notes ping failed:", e)
        return (json.dumps({"error": "not sent yet — it goes within five minutes"}), 502, json_headers)


# ------------------------------------------------------------ signed papers
#
# "Email a copy" of a signed change order or sign-off (signatures.js): whoever
# may change jobs, on their tap -- never by itself.


def _docs(request, path, headers):
    json_headers = dict(headers, **{"Content-Type": "application/json"})
    if request.method == "OPTIONS":
        return ("", 204, headers)
    if path != "/docs/email":
        return (json.dumps({"error": "unknown endpoint"}), 404, json_headers)
    if origin_blocked(request):
        return (json.dumps({"error": "origin not allowed"}), 403, json_headers)
    try:
        uid = _caller(request, "jobs", "change")
    except PermissionError as e:
        return (json.dumps({"error": str(e)}), 401, json_headers)
    import jobdocs
    body = request.get_json(silent=True) or {}
    try:
        who = (_db.collection("users").document(uid).get().to_dict() or {}).get("name") or ""
        return (json.dumps(jobdocs.email_copy(_db, str(body.get("docId") or ""), who)), 200, json_headers)
    except RuntimeError as e:
        return (json.dumps({"error": str(e)}), 400, json_headers)
    except Exception as e:                          # noqa: BLE001
        print("docs email failed:", e)
        return (json.dumps({"error": "Not sent — try again in a minute"}), 502, json_headers)


# ---------------------------------------------------------- subcontractors
#
# "Check their email now" on the Subcontractors section: the owner's alone,
# like the section. {full: true} reads the whole year again.


def _subs(request, path, headers):
    json_headers = dict(headers, **{"Content-Type": "application/json"})
    if request.method == "OPTIONS":
        return ("", 204, headers)
    if path != "/subs/scan":
        return (json.dumps({"error": "unknown endpoint"}), 404, json_headers)
    if origin_blocked(request):
        return (json.dumps({"error": "origin not allowed"}), 403, json_headers)
    try:
        _caller(request)
    except PermissionError as e:
        return (json.dumps({"error": str(e)}), 401, json_headers)
    import receipts
    import subvisits
    body = request.get_json(silent=True) or {}
    try:
        return (json.dumps({"report": subvisits.scan(_db, full=bool(body.get("full")))}), 200, json_headers)
    except receipts.NeedsPermission:
        return (json.dumps({"error": "Reading email is not switched on"}), 403, json_headers)
    except Exception as e:                          # noqa: BLE001
        print("subs scan failed:", e)
        return (json.dumps({"error": "Their email could not be read just now"}), 502, json_headers)


# ---------------------------------------------------------------- follow-ups
#
# "Write the email" on a bid waiting for an answer (followup.py). The app says
# which job; the job, and the address the draft goes to, are read here. It
# writes into nothing but the owner's Drafts, so it is for whoever may change
# jobs -- the same as the scope of work -- and counts against the daily cap.


def _followup(request, path, headers):
    # The same guard writes the plant-care email (care.py): a draft in the
    # owner's Gmail from one job, for whoever may change jobs, counted.
    import care
    import followup
    json_headers = dict(headers, **{"Content-Type": "application/json"})
    if request.method == "OPTIONS":
        return ("", 204, headers)
    if path not in ("/followup/draft", "/care/draft"):
        return (json.dumps({"error": "unknown endpoint"}), 404, json_headers)
    if origin_blocked(request):
        return (json.dumps({"error": "origin not allowed"}), 403, json_headers)
    try:
        uid = _caller(request, "jobs", "change")
    except PermissionError as e:
        return (json.dumps({"error": str(e)}), 401, json_headers)
    body = request.get_json(silent=True) or {}
    job_id = str(body.get("jobId") or "")
    if not job_id or "/" in job_id:
        return (json.dumps({"error": "which job?"}), 400, json_headers)
    try:
        day = _check_and_count_usage(uid)
    except RuntimeError as e:
        return (json.dumps({"error": str(e)}), 429, json_headers)
    task = "care" if path == "/care/draft" else "followup"
    try:
        if task == "care":
            result, usage = care.draft(_claude(), job_id, auto=body.get("auto") is True)
        else:
            result, usage = followup.draft(_claude(), job_id)
    except anthropic.RateLimitError:
        return (json.dumps({"error": "Claude is busy — try again shortly"}), 429, json_headers)
    except Exception as e:                          # noqa: BLE001
        print("%s draft failed: %s" % (task, e))
        return (json.dumps({"error": "The email could not be written. Try again."}), 502, json_headers)
    if usage is not None:
        _record_spend(day, task, usage, care.MODEL if task == "care" else followup.MODEL)
    return (json.dumps(result), 400 if result.get("error") else 200, json_headers)


# ---------------------------------------------------------------- estimates
#
# The estimate on the Job tab (estimates.py): the site-visit notes and the
# conversation in, labour and takeoff lines out (the app prices them). Writes
# nothing -- the lines go back to the form to be checked -- so it is for
# whoever may change jobs, under the cap. /estimate/trip (trip.py) gives the
# road miles to the job and the week's fuel prices; /estimate/source
# (sourcing.py) finds a price on the web for a material Supplies lacks.


def _estimate(request, path, headers):
    import estimates
    json_headers = dict(headers, **{"Content-Type": "application/json"})
    if request.method == "OPTIONS":
        return ("", 204, headers)
    if path not in ("/estimate/draft", "/estimate/trip", "/estimate/source", "/estimate/crew"):
        return (json.dumps({"error": "unknown endpoint"}), 404, json_headers)
    if origin_blocked(request):
        return (json.dumps({"error": "origin not allowed"}), 403, json_headers)
    try:
        uid = _caller(request, "jobs", "change")
    except PermissionError as e:
        return (json.dumps({"error": str(e)}), 401, json_headers)
    # Miles to the job and the week's fuel prices: lookups, not Claude, so not
    # counted against the day's Claude allowance.
    if path == "/estimate/trip":
        import trip
        try:
            return (json.dumps(trip.trip(request.get_json(silent=True) or {})), 200, json_headers)
        except Exception as e:                      # noqa: BLE001
            print("estimate trip failed:", e)
            return (json.dumps({"error": "The miles could not be worked out just now"}), 502, json_headers)
    try:
        day = _check_and_count_usage(uid)
    except RuntimeError as e:
        return (json.dumps({"error": str(e)}), 429, json_headers)
    # Where to buy a material Supplies has no price for (sourcing.py): Claude
    # searches the web; the app saves the option the owner picks.
    if path == "/estimate/source":
        import sourcing
        import spend
        # Counted whatever happens: a search that fails on its third call
        # has still paid for the first two (and their web searches).
        meter = {"cents": 0.0}
        try:
            result, _ = sourcing.find(_claude(), request.get_json(silent=True) or {}, meter)
        except anthropic.RateLimitError:
            return (json.dumps({"error": "Claude is busy — try again shortly"}), 429, json_headers)
        except Exception as e:                      # noqa: BLE001
            print("estimate source failed:", e)
            return (json.dumps({"error": "The prices could not be looked up. Try again."}), 502, json_headers)
        finally:
            if meter["cents"]:
                spend.add(_db, day, "source", meter["cents"], meter)
        return (json.dumps(result), 400 if result.get("error") else 200, json_headers)
    # The crew's notes for a booked job's lines that have none (estimates.py
    # crew_notes) -- by itself for a job made in QuickBooks, or on a tap: a
    # few bullets per line, written into the job by the app.
    if path == "/estimate/crew":
        try:
            result, usage = estimates.crew_notes(_claude(), request.get_json(silent=True) or {})
        except anthropic.RateLimitError:
            return (json.dumps({"error": "Claude is busy — try again shortly"}), 429, json_headers)
        except Exception as e:                      # noqa: BLE001
            print("estimate crew notes failed:", e)
            return (json.dumps({"error": "The crew notes could not be written. Try again."}), 502, json_headers)
        model = result.pop("model", estimates.CREW_MODEL)
        if usage is not None:
            _record_spend(day, "crewnotes", usage, model)
        return (json.dumps(result), 400 if result.get("error") else 200, json_headers)
    try:
        result, usage = estimates.draft(_claude(), request.get_json(silent=True) or {})
    except anthropic.RateLimitError:
        return (json.dumps({"error": "Claude is busy — try again shortly"}), 429, json_headers)
    except Exception as e:                          # noqa: BLE001
        print("estimate draft failed:", e)
        return (json.dumps({"error": "The estimate could not be built. Try again."}), 502, json_headers)
    model = result.pop("model", estimates.MODEL)
    if usage is not None:
        _record_spend(day, "estimate", usage, model)
    return (json.dumps(result), 400 if result.get("error") else 200, json_headers)


# ---------------------------------------------------------------- addresses
#
# The app finds an address on the map through here (geo.py): the US Census
# geocoder knows Wisconsin's rural fire numbers that OpenStreetMap misses,
# but it cannot be called from a browser. For whoever may change snow
# accounts or jobs -- the two places an address is typed.


def _geo(request, path, headers):
    import geo
    json_headers = dict(headers, **{"Content-Type": "application/json"})
    if request.method == "OPTIONS":
        return ("", 204, headers)
    if path != "/geo/find":
        return (json.dumps({"error": "unknown endpoint"}), 404, json_headers)
    if origin_blocked(request):
        return (json.dumps({"error": "origin not allowed"}), 403, json_headers)
    try:
        try:
            _caller(request, "snow", "change")
        except PermissionError:
            _caller(request, "jobs", "change")
    except PermissionError as e:
        return (json.dumps({"error": str(e)}), 401, json_headers)
    d = request.get_json(silent=True) or {}
    try:
        hit = geo.find(d.get("street"), d.get("city"), d.get("state") or "WI", d.get("zip"))
    except Exception as e:                          # noqa: BLE001
        print("geo find failed:", e)
        return (json.dumps({"error": "The map could not be reached just now"}), 502, json_headers)
    return (json.dumps({"found": bool(hit), "geo": hit}), 200, json_headers)


# ---------------------------------------------------------------- supplies
#
# A supplier's price sheet as a PDF or a photo, read into rows for the price
# list (sheets.py). Writes nothing -- the rows go back to the check-then-save
# screen. For whoever may change Supplies, under the day's Claude cap.


def _supplies(request, path, headers):
    import sheets
    json_headers = dict(headers, **{"Content-Type": "application/json"})
    if request.method == "OPTIONS":
        return ("", 204, headers)
    if path != "/supplies/read-sheet":
        return (json.dumps({"error": "unknown endpoint"}), 404, json_headers)
    if origin_blocked(request):
        return (json.dumps({"error": "origin not allowed"}), 403, json_headers)
    try:
        uid = _caller(request, "supplies", "change")
    except PermissionError as e:
        return (json.dumps({"error": str(e)}), 401, json_headers)
    try:
        day = _check_and_count_usage(uid)
    except RuntimeError as e:
        return (json.dumps({"error": str(e)}), 429, json_headers)
    try:
        result, usage = sheets.read(_claude(), request.get_json(silent=True) or {})
    except anthropic.RateLimitError:
        return (json.dumps({"error": "Claude is busy — try again shortly"}), 429, json_headers)
    except Exception as e:                          # noqa: BLE001
        print("price sheet read failed:", e)
        return (json.dumps({"error": "The sheet could not be read. Try again."}), 502, json_headers)
    if usage is not None:
        _record_spend(day, "pricesheet", usage, sheets.MODEL)
    return (json.dumps(result), 400 if result.get("error") else 200, json_headers)


# ---------------------------------------------------------------- version

# Which code is running, so whether a deploy went live can be checked from
# outside -- the Cloud console needs Jonah's sign-in (7 Oct 2026: "how about
# instead of asking me to do it you just check"). A fingerprint of this
# folder's own .py files, which can be worked out from the repo for any
# commit, plus Cloud Run's revision name. Nothing in it is private.
_FINGERPRINT = None


def _code_fingerprint():
    global _FINGERPRINT
    if _FINGERPRINT is None:
        import hashlib
        here = os.path.dirname(os.path.abspath(__file__))
        h = hashlib.sha1()
        for name in sorted(n for n in os.listdir(here) if n.endswith(".py")):
            with open(os.path.join(here, name), "rb") as f:
                h.update(name.encode() + b"\0" + f.read().replace(b"\r\n", b"\n") + b"\0")
        _FINGERPRINT = h.hexdigest()[:12]
    return _FINGERPRINT


# ---------------------------------------------------------------- entry point


@functions_framework.http
def claude(request):
    origin = request.headers.get("Origin", "")
    headers = _cors(origin)

    # One Cloud Run service, two jobs. The entry point keeps its original name
    # so the existing deployment configuration still points at it; what it does
    # is decided by the path. Anything under /qb/ is QuickBooks, everything else
    # is the Claude behaviour this service started as.
    path = (request.path or "/").rstrip("/")
    if path == "/version":
        return (json.dumps({"revision": os.environ.get("K_REVISION", ""), "code": _code_fingerprint()}), 200,
                dict(headers, **{"Content-Type": "application/json"}))
    if path.startswith("/qb"):
        return _quickbooks(request, path, headers)
    if path.startswith("/digest"):
        return _digest(request, path, headers)
    if path.startswith("/cards"):
        return _cards(request, path, headers)
    if path.startswith("/receipts"):
        return _receipts(request, path, headers)
    if path.startswith("/subs"):
        return _subs(request, path, headers)
    if path.startswith("/notes"):
        return _notes(request, path, headers)
    if path.startswith("/followup") or path.startswith("/care"):
        return _followup(request, path, headers)
    if path.startswith("/estimate"):
        return _estimate(request, path, headers)
    if path.startswith("/geo"):
        return _geo(request, path, headers)
    if path.startswith("/supplies"):
        return _supplies(request, path, headers)
    if path.startswith("/docs"):
        return _docs(request, path, headers)

    if request.method == "OPTIONS":
        return ("", 204, headers)
    if request.method != "POST":
        return (json.dumps({"error": "POST only"}), 405, headers)
    if origin and origin not in ALLOWED_ORIGINS:
        return (json.dumps({"error": "origin not allowed"}), 403, headers)

    # Every Claude task so far writes into a job (the scope of work), so it
    # is for whoever may change jobs.
    try:
        uid = _caller(request, "jobs", "change")
    except PermissionError as e:
        return (json.dumps({"error": str(e)}), 401, headers)

    body = request.get_json(silent=True) or {}
    task_name = body.get("task")
    spec = TASKS.get(task_name)
    if not spec:
        return (
            json.dumps({"error": "unknown task", "known": sorted(TASKS)}),
            400,
            headers,
        )

    try:
        day = _check_and_count_usage(uid)
    except RuntimeError as e:
        return (json.dumps({"error": str(e)}), 429, headers)

    try:
        _claude()
    except RuntimeError as e:
        print("configuration problem:", e)
        return (json.dumps({"error": str(e)}), 500, headers)

    try:
        response = _claude().beta.messages.create(
            model=MODEL,
            max_tokens=spec["max_tokens"],
            system=spec["system"],
            messages=[{"role": "user", "content": spec["build"](body.get("data", {}))}],
            thinking={"type": "adaptive"},
            output_config={"effort": spec["effort"]},
            # Routes around a safety-classifier refusal automatically rather than
            # handing the user a dead end. Irrelevant for patio descriptions, but
            # it costs nothing to have on.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.RateLimitError:
        return (json.dumps({"error": "Claude is busy — try again shortly"}), 429, headers)
    except anthropic.APIStatusError as e:
        print("claude api error:", e.status_code, e.message)
        return (json.dumps({"error": "Claude could not be reached"}), 502, headers)
    except anthropic.APIConnectionError:
        return (json.dumps({"error": "Could not reach Claude"}), 502, headers)

    if response.stop_reason == "refusal":
        return (
            json.dumps({"error": "Claude declined this request"}),
            422,
            headers,
        )

    text = "".join(b.text for b in response.content if b.type == "text")
    _record_spend(day, task_name, response.usage)

    return (
        json.dumps(
            {
                "task": task_name,
                "text": text,
                "usage": {
                    "input": response.usage.input_tokens,
                    "output": response.usage.output_tokens,
                },
            }
        ),
        200,
        {**headers, "Content-Type": "application/json"},
    )
