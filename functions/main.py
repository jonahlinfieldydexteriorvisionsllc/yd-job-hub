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
import json
import os

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

MODEL = "claude-opus-5-5"
DAILY_CALL_LIMIT = 200          # a working day of heavy use is nowhere near this
ALLOWED_ORIGINS = {
    "https://jonahlinfieldydexteriorvisionsllc.github.io",
    "https://jobhub.ydexteriorvisions.com",
    "http://localhost:8123",
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


def _parse_prompt(d):
    return (
        "Pull the job details out of the message below. Return JSON with the "
        "keys customerName, address, city, state, zip, phone, email, "
        "serviceTypes (array), notes. Use an empty string for anything the "
        "message does not say -- never invent a value.\n\n"
        f"---\n{d.get('text', '')}\n---"
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
    "parse_proposal": {
        "system": (
            "You extract structured job details from messy text -- a customer "
            "email, a phone note, a pasted proposal. Return only JSON, no "
            "commentary. Accuracy matters far more than completeness: an empty "
            "field is correct, a guessed one is a wrong job record."
        ),
        "build": _parse_prompt,
        "max_tokens": 1500,
        "effort": "low",
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


def _check_and_count_usage(uid):
    """Daily call ceiling. Refuses rather than quietly spending."""
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


def _record_spend(day, task, usage):
    """Write what each call cost in tokens, so spend is visible, not inferred."""
    try:
        _db.collection("claudeUsage").document(day).set(
            {
                "inputTokens": firestore.Increment(usage.input_tokens),
                "outputTokens": firestore.Increment(usage.output_tokens),
                "byTask": {task: firestore.Increment(1)},
            },
            merge=True,
        )
    except Exception as e:                      # never fail a good answer over bookkeeping
        print("could not record usage:", e)


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
        if not expected or given != expected:
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
                       "/qb/estimate", "/qb/estimate-status", "/qb/estimate-invoice", "/qb/invoice-status")
    try:
        uid = _caller(request, "billing", "change") if billing else _caller(request)
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
        elif path == "/qb/estimate":
            result = qb.save_estimate(body)
        elif path == "/qb/estimate-status":
            result = qb.estimate_status(body)
        elif path == "/qb/estimate-invoice":
            result = qb.invoice_from_estimate(body)
        elif path == "/qb/invoice-status":
            result = qb.invoice_status(body)
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
        try:
            return (json.dumps({"slot": slot, "report": digest.run(slot)}), 200, json_headers)
        except Exception as e:                          # noqa: BLE001
            print("digest run failed:", e)
            return (json.dumps({"error": str(e)}), 500, json_headers)

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
    try:
        report = cards.run(_claude(), only)
    except Exception as e:                          # noqa: BLE001
        print("cards run failed:", e)
        return (json.dumps({"error": str(e)}), 500, json_headers)
    # The hourly run also asks QuickBooks about estimates out with customers
    # and invoices not yet paid off (quickbooks.sweep): a "yes" or a payment
    # reaches the job, and Jonah's phone, without him looking.
    if only is None:
        try:
            _tell_owner(qb_sweep_news())
        except Exception as e:                      # noqa: BLE001
            print("quickbooks sweep failed:", e)
    return (json.dumps({"report": report}), 200, json_headers)


def qb_sweep_news():
    import quickbooks
    return quickbooks.sweep()


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
                body += ". Open the job to book it and make the invoice."
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
    else:
        return (json.dumps({"error": "unknown endpoint"}), 404, json_headers)
    try:
        return (json.dumps({"report": receipts.run(_claude(), manual)}), 200, json_headers)
    except Exception as e:                          # noqa: BLE001
        print("receipts run failed:", e)
        return (json.dumps({"error": str(e)}), 500, json_headers)


# ---------------------------------------------------------------- follow-ups
#
# "Write the email" on a bid waiting for an answer (followup.py). The app says
# which job; the job, and the address the draft goes to, are read here. It
# writes into nothing but the owner's Drafts, so it is for whoever may change
# jobs -- the same as the scope of work -- and counts against the daily cap.


def _followup(request, path, headers):
    import followup
    json_headers = dict(headers, **{"Content-Type": "application/json"})
    if request.method == "OPTIONS":
        return ("", 204, headers)
    if path != "/followup/draft":
        return (json.dumps({"error": "unknown endpoint"}), 404, json_headers)
    if origin_blocked(request):
        return (json.dumps({"error": "origin not allowed"}), 403, json_headers)
    try:
        uid = _caller(request, "jobs", "change")
    except PermissionError as e:
        return (json.dumps({"error": str(e)}), 401, json_headers)
    job_id = str((request.get_json(silent=True) or {}).get("jobId") or "")
    if not job_id or "/" in job_id:
        return (json.dumps({"error": "which job?"}), 400, json_headers)
    try:
        day = _check_and_count_usage(uid)
    except RuntimeError as e:
        return (json.dumps({"error": str(e)}), 429, json_headers)
    try:
        result, usage = followup.draft(_claude(), job_id)
    except anthropic.RateLimitError:
        return (json.dumps({"error": "Claude is busy — try again shortly"}), 429, json_headers)
    except Exception as e:                          # noqa: BLE001
        print("followup draft failed:", e)
        return (json.dumps({"error": "The email could not be written. Try again."}), 502, json_headers)
    if usage is not None:
        _record_spend(day, "followup", usage)
    return (json.dumps(result), 400 if result.get("error") else 200, json_headers)


# ---------------------------------------------------------------- estimates
#
# The estimate on the Job tab (estimates.py): the site-visit notes and the
# conversation in, labour and takeoff lines out (the app prices them). Writes
# nothing -- the lines go back to the form to be checked -- so it is for
# whoever may change jobs, under the cap. /estimate/trip (trip.py) gives the
# road miles to the job and the week's fuel prices.


def _estimate(request, path, headers):
    import estimates
    json_headers = dict(headers, **{"Content-Type": "application/json"})
    if request.method == "OPTIONS":
        return ("", 204, headers)
    if path not in ("/estimate/draft", "/estimate/trip"):
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
    try:
        result, usage = estimates.draft(_claude(), request.get_json(silent=True) or {})
    except anthropic.RateLimitError:
        return (json.dumps({"error": "Claude is busy — try again shortly"}), 429, json_headers)
    except Exception as e:                          # noqa: BLE001
        print("estimate draft failed:", e)
        return (json.dumps({"error": "The estimate could not be built. Try again."}), 502, json_headers)
    if usage is not None:
        _record_spend(day, "estimate", usage)
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
    if path.startswith("/qb"):
        return _quickbooks(request, path, headers)
    if path.startswith("/digest"):
        return _digest(request, path, headers)
    if path.startswith("/cards"):
        return _cards(request, path, headers)
    if path.startswith("/receipts"):
        return _receipts(request, path, headers)
    if path.startswith("/followup"):
        return _followup(request, path, headers)
    if path.startswith("/estimate"):
        return _estimate(request, path, headers)
    if path.startswith("/geo"):
        return _geo(request, path, headers)

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
