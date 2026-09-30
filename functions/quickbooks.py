"""YD Job Hub -- the QuickBooks piece.

Why this is on a server rather than in the app: connecting to QuickBooks needs
a client secret, and anything in the app is readable by anyone who opens it --
the code is in a public repository. So the secret lives here, the tokens live
here, and the app asks this service. No QuickBooks credential ever reaches a
phone or a browser.

THE POINT OF ALL THIS. The owner was copying invoices out of Job Hub and into
QuickBooks by hand after every storm, then keeping the invoice numbers in step
between the two. Connecting them properly removes both jobs at once:

  * invoices are created in QuickBooks directly, so there is no file to export
    and no import to run;

  * the invoice number is never guessed. QuickBooks assigns it from its own
    sequence and hands it back, and that number is written onto the storm. The
    two can no longer drift, because only one of them is counting.

Three things shape the implementation.

TOKENS ARE THE WHOLE GAME. An access token lasts an hour; the refresh token
lasts a hundred days AND ROTATES every time it is used, so the new one must be
stored or the connection is dead. They live in a Firestore collection no client
can read -- not covered by any rule, so the default deny applies, while this
service reaches it through the Admin SDK which bypasses rules entirely.

THE HUNDRED DAYS ARE A TRAP FOR THIS BUSINESS IN PARTICULAR. Snow runs November
to April. Left alone from April to November the refresh token expires over the
summer and the connection is quietly dead by the first storm -- discovered at
4am in a plough truck. So there is a keepalive endpoint for a scheduled job to
call weekly, which refreshes the token for no reason other than keeping it warm.

NOTHING HERE TRUSTS THE CALLER. Every endpoint the app uses demands a Firebase
sign-in token belonging to an active owner, exactly as the Claude endpoint does.
The OAuth callback, which cannot carry a header, is tied back to the person who
started it through a one-use state value stored before they were sent to Intuit.
"""

import datetime
import json
import os
import secrets
import urllib.parse

import requests
from firebase_admin import firestore

# ---------------------------------------------------------------- config

AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2"
TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke"
SCOPE = "com.intuit.quickbooks.accounting"

# The accounting API's shape changes between minor versions; pinning one means
# a change at Intuit's end cannot silently alter what an invoice looks like.
MINOR_VERSION = "75"

# Sandbox until the production keys exist. Everything is identical apart from
# this host, so the same code proves itself against a practice company first.
API_BASE = {
    "sandbox": "https://sandbox-quickbooks.api.intuit.com",
    "production": "https://quickbooks.api.intuit.com",
}

STATE_MINUTES = 15          # how long a half-finished connection stays valid
TOKEN_DOC = ("integrations", "quickbooks")
STATE_COLLECTION = "integrationState"


def _env(name, default=""):
    return os.environ.get(name, default)


def _api_base():
    return API_BASE.get(_env("QB_ENV", "sandbox"), API_BASE["sandbox"])


def _redirect_uri():
    return _env("QB_REDIRECT_URI")


def _app_url():
    return _env("QB_APP_URL", "https://jonahlinfieldydexteriorvisionsllc.github.io/yd-job-hub/")


def _client():
    """Client id and secret, or a clear complaint about which is missing."""
    cid = _env("QB_CLIENT_ID")
    secret = _env("QB_CLIENT_SECRET")
    missing = [n for n, v in (("QB_CLIENT_ID", cid), ("QB_CLIENT_SECRET", secret)) if not v]
    if missing:
        raise RuntimeError("QuickBooks is not configured yet (missing %s)" % ", ".join(missing))
    return cid, secret


# ---------------------------------------------------------------- storage


def _db():
    return firestore.client()


def _tokens_ref():
    return _db().collection(TOKEN_DOC[0]).document(TOKEN_DOC[1])


def _load_tokens():
    snap = _tokens_ref().get()
    return snap.to_dict() if snap.exists else None


def _save_tokens(data):
    _tokens_ref().set(data, merge=True)


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


# ---------------------------------------------------------------- the dance


def _exchange(grant_type, **extra):
    """Swap a code or a refresh token for a fresh pair. Never logs either."""
    cid, secret = _client()
    body = {"grant_type": grant_type}
    body.update(extra)
    resp = requests.post(
        TOKEN_URL,
        auth=(cid, secret),
        data=body,
        headers={"Accept": "application/json"},
        timeout=30,
    )
    if resp.status_code != 200:
        # Intuit puts the reason in the body; the body cannot contain our secret
        # because we sent that as a header, so it is safe to surface.
        raise RuntimeError("QuickBooks refused the token request: %s" % resp.text[:300])
    return resp.json()


def _store_from_response(payload, realm_id=None):
    now = _now()
    data = {
        "accessToken": payload["access_token"],
        "refreshToken": payload["refresh_token"],
        # Recorded as absolute times so a cold container knows where it stands
        # without having to guess how long it was asleep.
        "accessExpiresAt": (now + datetime.timedelta(seconds=int(payload.get("expires_in", 3600)))).isoformat(),
        "refreshExpiresAt": (now + datetime.timedelta(seconds=int(payload.get("x_refresh_token_expires_in", 8726400)))).isoformat(),
        "refreshedAt": now.isoformat(),
        "env": _env("QB_ENV", "sandbox"),
    }
    if realm_id:
        data["realmId"] = realm_id
    _save_tokens(data)
    return data


def _access_token(force_refresh=False):
    """A usable access token, refreshed if it is stale or about to be.

    The refresh token that comes back is a NEW one -- Intuit rotates it on every
    use -- so it has to be stored or the next refresh fails and the connection
    is dead with no obvious cause.
    """
    tokens = _load_tokens()
    if not tokens or not tokens.get("refreshToken"):
        raise RuntimeError("QuickBooks is not connected")

    if not force_refresh:
        try:
            expires = datetime.datetime.fromisoformat(tokens["accessExpiresAt"])
            # Two minutes of headroom: a token that expires mid-request is an
            # error that looks like a bug rather than an expiry.
            if expires - datetime.timedelta(minutes=2) > _now():
                return tokens["accessToken"], tokens
        except (KeyError, ValueError):
            pass

    payload = _exchange("refresh_token", refresh_token=tokens["refreshToken"])
    fresh = _store_from_response(payload, tokens.get("realmId"))
    return fresh["accessToken"], fresh


def _call(method, path, token, realm_id, params=None, body=None):
    url = "%s/v3/company/%s/%s" % (_api_base(), realm_id, path.lstrip("/"))
    params = dict(params or {})
    params["minorversion"] = MINOR_VERSION
    resp = requests.request(
        method,
        url,
        params=params,
        json=body,
        headers={
            "Authorization": "Bearer %s" % token,
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        timeout=40,
    )
    if resp.status_code in (401, 403):
        raise PermissionError("QuickBooks rejected the connection")
    if resp.status_code >= 400:
        raise RuntimeError("QuickBooks said no (%d): %s" % (resp.status_code, resp.text[:400]))
    return resp.json() if resp.content else {}


def _company():
    """Token plus realm, refreshing once if QuickBooks rejects the first try."""
    token, tokens = _access_token()
    realm = tokens.get("realmId")
    if not realm:
        raise RuntimeError("QuickBooks is connected but no company was recorded")
    return token, realm, tokens


# ---------------------------------------------------------------- endpoints


def connect_url(uid):
    """Where to send the owner to authorise, with a one-use state tying it back."""
    cid, _ = _client()
    if not _redirect_uri():
        raise RuntimeError("QuickBooks is not configured yet (missing QB_REDIRECT_URI)")

    state = secrets.token_urlsafe(24)
    _db().collection(STATE_COLLECTION).document(state).set(
        {"uid": uid, "createdAt": _now().isoformat()}
    )
    query = urllib.parse.urlencode(
        {
            "client_id": cid,
            "response_type": "code",
            "scope": SCOPE,
            "redirect_uri": _redirect_uri(),
            "state": state,
        }
    )
    return {"url": "%s?%s" % (AUTHORIZE_URL, query)}


def callback(request):
    """Intuit sends the owner back here. Returns (html, status)."""
    args = request.args
    error = args.get("error")
    if error:
        return _closing_page("QuickBooks was not connected: %s" % error, ok=False)

    code = args.get("code")
    state = args.get("state")
    realm_id = args.get("realmId")
    if not (code and state and realm_id):
        return _closing_page("That link was incomplete. Start again from Job Hub.", ok=False)

    ref = _db().collection(STATE_COLLECTION).document(state)
    snap = ref.get()
    if not snap.exists:
        return _closing_page("That connection attempt was not recognised.", ok=False)
    started = snap.to_dict()
    ref.delete()                            # one use only

    try:
        began = datetime.datetime.fromisoformat(started["createdAt"])
        if _now() - began > datetime.timedelta(minutes=STATE_MINUTES):
            return _closing_page("That took too long. Start again from Job Hub.", ok=False)
    except (KeyError, ValueError):
        return _closing_page("That connection attempt was not recognised.", ok=False)

    try:
        payload = _exchange(
            "authorization_code", code=code, redirect_uri=_redirect_uri()
        )
        _store_from_response(payload, realm_id)
        _save_tokens({"connectedBy": started.get("uid", ""), "connectedAt": _now().isoformat()})
    except Exception as e:                  # noqa: BLE001 -- shown, not swallowed
        print("quickbooks callback failed:", e)
        return _closing_page("QuickBooks could not be connected. %s" % e, ok=False)

    return _closing_page("QuickBooks is connected.", ok=True)


def _closing_page(message, ok):
    """A plain page that sends them back to the app."""
    colour = "#2f8f5b" if ok else "#c8492b"
    html = (
        "<!doctype html><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width, initial-scale=1'>"
        "<title>QuickBooks</title>"
        "<style>body{font-family:system-ui,sans-serif;background:#f1edf6;color:#2b2433;"
        "display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;"
        "padding:24px}div{background:#fff;border-radius:14px;padding:32px 28px;max-width:400px;"
        "text-align:center;box-shadow:0 14px 44px rgba(43,36,51,.14)}"
        "h1{font-size:20px;margin:0 0 10px;color:%s}p{font-size:14px;color:#7b7188;margin:0 0 20px}"
        "a{display:inline-block;background:#66418f;color:#fff;text-decoration:none;padding:13px 20px;"
        "border-radius:8px;font-size:13px;font-weight:700;letter-spacing:.6px}</style>"
        "<div><h1>%s</h1><p>You can close this and go back to Job Hub.</p>"
        "<a href='%s'>Back to Job Hub</a></div>"
    ) % (colour, message, _app_url())
    return html, (200 if ok else 400)


def status():
    """What the app shows on its QuickBooks screen."""
    tokens = _load_tokens()
    if not tokens or not tokens.get("refreshToken"):
        return {"connected": False, "env": _env("QB_ENV", "sandbox")}

    out = {
        "connected": True,
        "env": tokens.get("env", _env("QB_ENV", "sandbox")),
        "realmId": tokens.get("realmId", ""),
        "connectedAt": tokens.get("connectedAt", ""),
        "refreshedAt": tokens.get("refreshedAt", ""),
        "refreshExpiresAt": tokens.get("refreshExpiresAt", ""),
    }
    try:
        token, realm, _ = _company()
        info = _call("GET", "companyinfo/%s" % realm, token, realm)
        out["company"] = (info.get("CompanyInfo") or {}).get("CompanyName", "")
    except Exception as e:                  # noqa: BLE001
        # Connected on paper but not actually working is worth saying plainly.
        out["warning"] = str(e)
    return out


def disconnect():
    tokens = _load_tokens()
    if tokens and tokens.get("refreshToken"):
        try:
            cid, secret = _client()
            requests.post(
                REVOKE_URL,
                auth=(cid, secret),
                json={"token": tokens["refreshToken"]},
                headers={"Accept": "application/json"},
                timeout=30,
            )
        except Exception as e:              # noqa: BLE001
            print("revoke failed (clearing locally anyway):", e)
    _tokens_ref().delete()
    return {"connected": False}


def customers():
    """Every active customer, so snow accounts can be matched to them."""
    token, realm, _ = _company()
    out, start = [], 1
    while True:
        query = (
            "select Id, DisplayName, PrimaryEmailAddr from Customer "
            "where Active = true startposition %d maxresults 100" % start
        )
        data = _call("GET", "query", token, realm, params={"query": query})
        rows = (data.get("QueryResponse") or {}).get("Customer") or []
        for c in rows:
            out.append(
                {
                    "id": c.get("Id"),
                    "name": c.get("DisplayName", ""),
                    "email": (c.get("PrimaryEmailAddr") or {}).get("Address", ""),
                }
            )
        if len(rows) < 100:
            break
        start += 100
    return {"customers": out}


def items():
    """Products and services, so invoice lines can point at the right one."""
    token, realm, _ = _company()
    query = "select Id, Name, Type from Item where Active = true maxresults 200"
    data = _call("GET", "query", token, realm, params={"query": query})
    rows = (data.get("QueryResponse") or {}).get("Item") or []
    return {
        "items": [
            {"id": i.get("Id"), "name": i.get("Name", ""), "type": i.get("Type", "")}
            for i in rows
        ]
    }


def create_invoice(body):
    """Create one invoice and hand back the number QuickBooks gave it.

    DocNumber is deliberately NOT sent. QuickBooks keeps its own sequence, and
    letting it assign the number is what makes the two systems incapable of
    disagreeing -- the app records what came back rather than predicting it.
    """
    token, realm, _ = _company()

    customer_id = str(body.get("customerId") or "").strip()
    lines = body.get("lines") or []
    if not customer_id:
        raise RuntimeError("No QuickBooks customer was chosen for this account")
    if not lines:
        raise RuntimeError("That invoice has no lines")

    qb_lines = []
    for ln in lines:
        amount = round(float(ln.get("amount", 0)), 2)
        detail = {"Qty": float(ln.get("qty", 1)), "UnitPrice": round(float(ln.get("rate", amount)), 2)}
        item_id = str(ln.get("itemId") or "").strip()
        if item_id:
            detail["ItemRef"] = {"value": item_id}
        qb_lines.append(
            {
                "DetailType": "SalesItemLineDetail",
                "Amount": amount,
                "Description": str(ln.get("description", ""))[:4000],
                "SalesItemLineDetail": detail,
            }
        )

    invoice = {
        "CustomerRef": {"value": customer_id},
        "Line": qb_lines,
    }
    if body.get("txnDate"):
        invoice["TxnDate"] = body["txnDate"]            # YYYY-MM-DD
    if body.get("dueDate"):
        invoice["DueDate"] = body["dueDate"]
    if body.get("memo"):
        invoice["CustomerMemo"] = {"value": str(body["memo"])[:1000]}
    if body.get("privateNote"):
        invoice["PrivateNote"] = str(body["privateNote"])[:4000]

    created = _call("POST", "invoice", token, realm, body=invoice)
    inv = created.get("Invoice") or {}
    return {
        "id": inv.get("Id"),
        "docNumber": inv.get("DocNumber"),
        "total": inv.get("TotalAmt"),
        "txnDate": inv.get("TxnDate"),
    }


def keepalive():
    """Refresh for no reason but to stop the hundred days running out.

    Snow is a winter business. Without this the refresh token quietly dies over
    the summer and the connection is found to be broken during the first storm,
    which is the worst possible moment to discover it.
    """
    tokens = _load_tokens()
    if not tokens or not tokens.get("refreshToken"):
        return {"connected": False, "refreshed": False}
    _access_token(force_refresh=True)
    fresh = _load_tokens()
    return {
        "connected": True,
        "refreshed": True,
        "refreshExpiresAt": fresh.get("refreshExpiresAt", ""),
    }


def sweep_stale_states():
    """Abandoned half-connections are rubbish; do not keep them forever."""
    cutoff = (_now() - datetime.timedelta(minutes=STATE_MINUTES)).isoformat()
    removed = 0
    for doc in _db().collection(STATE_COLLECTION).stream():
        if (doc.to_dict() or {}).get("createdAt", "") < cutoff:
            doc.reference.delete()
            removed += 1
    return removed
