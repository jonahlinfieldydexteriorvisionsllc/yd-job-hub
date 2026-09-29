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
        headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        headers["Access-Control-Max-Age"] = "3600"
    return headers


def _caller(req):
    """Return the uid of a signed-in owner, or raise PermissionError."""
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
    # Deliberately owner-only for now. When crew get a Claude-powered feature,
    # widen this per task rather than globally.
    if user.get("role") != "owner" or user.get("active") is not True:
        raise PermissionError("owner access required")
    return uid


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


# ---------------------------------------------------------------- entry point


@functions_framework.http
def claude(request):
    origin = request.headers.get("Origin", "")
    headers = _cors(origin)

    if request.method == "OPTIONS":
        return ("", 204, headers)
    if request.method != "POST":
        return (json.dumps({"error": "POST only"}), 405, headers)
    if origin and origin not in ALLOWED_ORIGINS:
        return (json.dumps({"error": "origin not allowed"}), 403, headers)

    try:
        uid = _caller(request)
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
