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
import hashlib
import json
import os
import re
import secrets
import time
import urllib.parse
import uuid
from html import escape as html_escape

import requests
from firebase_admin import firestore

# ---------------------------------------------------------------- config

# Intuit publishes its OAuth endpoints in a discovery document and asks apps
# to read them from there, so that a moved endpoint does not silently break the
# connection. The addresses below are only the fallback for when the document
# itself cannot be fetched -- a connection should not fail because of that.
DISCOVERY_URL = {
    "sandbox": "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration",
    "production": "https://developer.api.intuit.com/.well-known/openid_configuration",
}
FALLBACK_ENDPOINTS = {
    "authorization_endpoint": "https://appcenter.intuit.com/connect/oauth2",
    "token_endpoint": "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    "revocation_endpoint": "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
}
DISCOVERY_HOURS = 24        # re-read once a day; endpoints rarely move
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

# Failures that are Intuit's and usually pass: throttling and their own server
# trouble. These are tried again after a growing pause; anything else is a real
# answer and goes straight back to the owner.
RETRY_STATUSES = (429, 500, 502, 503, 504)
RETRY_WAITS = (1, 3, 8)     # seconds before each further try; three, then give up
MAX_RETRY_AFTER = 30        # never sit longer than this on Intuit's say-so


class ReconnectNeeded(PermissionError):
    """QuickBooks will not accept this connection any more; it must be remade.

    A PermissionError so the web layer turns it into {"reconnect": true}, which
    is what makes the app show the Connect button instead of a vague failure.
    """


def _env(name, default=""):
    return os.environ.get(name, default)


def _api_base():
    return API_BASE.get(_env("QB_ENV", "sandbox"), API_BASE["sandbox"])


_discovered = {"at": None, "env": None, "endpoints": None}


def _endpoint(name):
    """One OAuth endpoint, from Intuit's discovery document, cached for a day."""
    env = _env("QB_ENV", "sandbox")
    now = _now()
    fresh = (
        _discovered["endpoints"]
        and _discovered["env"] == env
        and now - _discovered["at"] < datetime.timedelta(hours=DISCOVERY_HOURS)
    )
    if not fresh:
        try:
            resp = requests.get(DISCOVERY_URL.get(env, DISCOVERY_URL["sandbox"]), timeout=10)
            doc = resp.json() if resp.status_code == 200 else {}
            found = {k: doc[k] for k in FALLBACK_ENDPOINTS if doc.get(k)}
            if len(found) == len(FALLBACK_ENDPOINTS):
                _discovered.update(at=now, env=env, endpoints=found)
            else:
                print("quickbooks discovery document incomplete (%d), using fallback" % resp.status_code)
        except Exception as e:              # noqa: BLE001 -- fallback below
            print("quickbooks discovery document unavailable, using fallback:", e)
    if _discovered["endpoints"] and _discovered["env"] == env:
        return _discovered["endpoints"][name]
    return FALLBACK_ENDPOINTS[name]


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


def _tid(resp):
    """Intuit's own id for a request -- the first thing their support asks for."""
    return resp.headers.get("intuit_tid", "") or "none"


def _retry_wait(resp, default):
    """Intuit's Retry-After when it gives one, within reason; ours otherwise."""
    try:
        return min(int(resp.headers.get("Retry-After", "")), MAX_RETRY_AFTER)
    except ValueError:
        return default


def _send(method, url, **kwargs):
    """One request to Intuit, tried again when the failure is theirs and passing.

    Only throttling, Intuit server errors and a dropped connection are retried.
    A request that changes something (an invoice) must carry a requestid, which
    makes Intuit answer a repeat with the original result rather than doing the
    work twice -- otherwise a retry after a timeout could raise a second invoice.
    """
    for wait in RETRY_WAITS + (None,):
        try:
            resp = requests.request(method, url, **kwargs)
        except (requests.ConnectionError, requests.Timeout) as e:
            if wait is None:
                raise RuntimeError("Could not reach QuickBooks: %s" % e)
            print("quickbooks %s unreachable (%s), retrying in %ds" % (method, e.__class__.__name__, wait))
            time.sleep(wait)
            continue
        if resp.status_code in RETRY_STATUSES and wait is not None:
            pause = _retry_wait(resp, wait)
            print("quickbooks %s -> %d intuit_tid=%s, retrying in %ds"
                  % (method, resp.status_code, _tid(resp), pause))
            time.sleep(pause)
            continue
        return resp


def _token_error(resp):
    """The OAuth error code, e.g. invalid_grant, or the raw text if there is none."""
    try:
        return resp.json().get("error", "") or resp.text[:300]
    except ValueError:
        return resp.text[:300]


def _fault_message(resp):
    """The human sentence out of an accounting API fault, not the whole envelope."""
    try:
        err = resp.json()["Fault"]["Error"][0]
        return err.get("Detail") or err.get("Message") or resp.text[:400]
    except (ValueError, KeyError, IndexError, TypeError):
        return resp.text[:400]


def _exchange(grant_type, **extra):
    """Swap a code or a refresh token for a fresh pair. Never logs either."""
    cid, secret = _client()
    body = {"grant_type": grant_type}
    body.update(extra)
    resp = _send(
        "POST",
        _endpoint("token_endpoint"),
        auth=(cid, secret),
        data=body,
        headers={"Accept": "application/json"},
        timeout=30,
    )
    if resp.status_code != 200:
        # Intuit puts the reason in the body; the body cannot contain our secret
        # because we sent that as a header, so it is safe to surface.
        reason = _token_error(resp)
        print("quickbooks token %s failed (%d) intuit_tid=%s: %s"
              % (grant_type, resp.status_code, _tid(resp), reason))
        if reason == "invalid_grant":
            # The refresh token has expired or the owner revoked access in
            # QuickBooks. Nothing on this side can mend that; only connecting
            # again can, so say exactly that.
            raise ReconnectNeeded(
                "QuickBooks needs connecting again -- its permission has expired "
                "or been withdrawn (Intuit ref %s)" % _tid(resp)
            )
        raise RuntimeError("QuickBooks refused the token request: %s (Intuit ref %s)"
                           % (reason, _tid(resp)))
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

    # The hundred-day clock, kept away from the edge.
    #
    # Refreshing rotates the refresh token and starts its hundred days again,
    # so any refresh keeps the connection alive. The app asks for status every
    # time the owner signs in, which means ordinary use maintains it by itself
    # -- but only while the access token has actually expired, and two visits
    # in one hour would not trigger one. So when the refresh token is within a
    # month of running out, refresh regardless. Job Hub is used all year for
    # landscaping, so this alone keeps a winter-only QuickBooks connection from
    # quietly dying over the summer.
    if not force_refresh:
        try:
            refresh_expires = datetime.datetime.fromisoformat(tokens["refreshExpiresAt"])
            if refresh_expires - datetime.timedelta(days=30) < _now():
                force_refresh = True
        except (KeyError, ValueError):
            pass

    if not force_refresh:
        try:
            expires = datetime.datetime.fromisoformat(tokens["accessExpiresAt"])
            # Two minutes of headroom: a token that expires mid-request is an
            # error that looks like a bug rather than an expiry.
            if expires - datetime.timedelta(minutes=2) > _now():
                return tokens["accessToken"], tokens
        except (KeyError, ValueError):
            pass

    try:
        payload = _exchange("refresh_token", refresh_token=tokens["refreshToken"])
    except ReconnectNeeded:
        # Two requests can arrive together and both decide to refresh. The first
        # rotates the refresh token, so the second is holding a used one and is
        # refused. If the stored token has moved on since we read it, that is
        # what happened -- use the new pair rather than declaring the connection
        # dead.
        latest = _load_tokens() or {}
        if latest.get("refreshToken") and latest["refreshToken"] != tokens["refreshToken"]:
            return latest["accessToken"], latest
        raise
    fresh = _store_from_response(payload, tokens.get("realmId"))
    return fresh["accessToken"], fresh


def _call(method, path, params=None, body=None, request_id=None, empty_body=False):
    """One accounting API call against the connected company.

    It fetches its own token rather than being handed one, so that a 401 can be
    answered properly: an access token can be revoked or invalidated before its
    hour is up, and the right response is to refresh once and try again. Only a
    second refusal means the connection itself needs remaking.

    empty_body is for the "send" calls (email an estimate), which Intuit wants
    as an empty octet-stream POST rather than JSON.
    """
    for second_try in (False, True):
        token, tokens = _access_token(force_refresh=second_try)
        realm = tokens.get("realmId")
        if not realm:
            raise RuntimeError("QuickBooks is connected but no company was recorded")
        url = "%s/v3/company/%s/%s" % (_api_base(), realm, path.lstrip("/"))
        query = dict(params or {})
        query["minorversion"] = MINOR_VERSION
        if request_id:
            query["requestid"] = request_id
        payload = {"data": b""} if empty_body else {"json": body}
        resp = _send(
            method,
            url,
            params=query,
            headers={
                "Authorization": "Bearer %s" % token,
                "Accept": "application/json",
                "Content-Type": "application/octet-stream" if empty_body else "application/json",
            },
            timeout=40,
            **payload,
        )
        if resp.status_code == 401 and not second_try:
            print("quickbooks %s %s -> 401 intuit_tid=%s, refreshing and trying once more"
                  % (method, path, _tid(resp)))
            continue
        if resp.status_code in (401, 403):
            print("quickbooks %s %s -> %d intuit_tid=%s" % (method, path, resp.status_code, _tid(resp)))
            raise ReconnectNeeded("QuickBooks rejected the connection (Intuit ref %s)" % _tid(resp))
        if resp.status_code >= 400:
            reason = _fault_message(resp)
            print("quickbooks %s %s -> %d intuit_tid=%s: %s"
                  % (method, path, resp.status_code, _tid(resp), reason))
            err = RuntimeError("QuickBooks said no: %s (Intuit ref %s)" % (reason, _tid(resp)))
            err.status = resp.status_code       # 400: what was sent was refused
            raise err
        return resp.json() if resp.content else {}


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
    return {"url": "%s?%s" % (_endpoint("authorization_endpoint"), query)}


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
        # The same return loaded a second time -- a reload, the back button, or
        # a browser that fetched the page twice. The first load used the state
        # up and connected; this one used to say "not recognised", and on
        # 6 Oct that read as a failed connection when QuickBooks was connected.
        held = _load_tokens() or {}
        try:
            just = _now() - datetime.datetime.fromisoformat(held.get("connectedAt") or "") \
                < datetime.timedelta(minutes=STATE_MINUTES)
        except (TypeError, ValueError):
            just = False
        if just and held.get("realmId") == realm_id and held.get("refreshToken"):
            return _closing_page("QuickBooks is connected.", ok=True)
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
    """A plain page that sends them back to the app.

    The message is escaped because part of it can come from the address bar:
    the `error` Intuit sends back is just a query parameter, so a link to
    /qb/callback?error=<script>... ran that script on this service's page.
    """
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
    ) % (colour, html_escape(str(message)), html_escape(_app_url(), quote=True))
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
        info = _call("GET", "companyinfo/%s" % tokens.get("realmId", ""))
        out["company"] = (info.get("CompanyInfo") or {}).get("CompanyName", "")
    except ReconnectNeeded as e:
        # Tokens on file but QuickBooks will not honour them: show it as not
        # connected, with the reason, so the Connect button is right there.
        return {"connected": False, "reconnect": True, "env": out["env"], "error": str(e)}
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
                _endpoint("revocation_endpoint"),
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
    out, start = [], 1
    while True:
        query = (
            "select Id, DisplayName, PrimaryEmailAddr from Customer "
            "where Active = true startposition %d maxresults 100" % start
        )
        data = _call("GET", "query", params={"query": query})
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
    """Products and services, so invoice lines can point at the right one --
    and, with their prices, so the estimate price book can be started from
    them."""
    out, start = [], 1
    while True:
        query = ("select Id, Name, Type, UnitPrice, Description from Item "
                 "where Active = true startposition %d maxresults 200" % start)
        data = _call("GET", "query", params={"query": query})
        rows = (data.get("QueryResponse") or {}).get("Item") or []
        out += [{"id": i.get("Id"), "name": i.get("Name", ""), "type": i.get("Type", ""),
                 "price": i.get("UnitPrice"), "description": i.get("Description", "")}
                for i in rows]
        if len(rows) < 200:
            break
        start += 200
    return {"items": out}


# ---------------------------------------------------------------- estimates
#
# An estimate is built in Job Hub (estimate.js, priced by pricing.js) and
# QuickBooks is what the customer gets: it numbers the estimate, emails it, and
# records whether they accepted. Invoicing and payment then happen in
# QuickBooks from that estimate.
#
# What the customer reads (Jonah, 6 Oct 2026): one line per piece of labour --
# the heading, the job's address, the scope of work -- and ONE line of
# materials listing everything with its quantity and one price for all of it.
# No unit prices and no tax line: tax is recovered inside the materials, so
# every line is marked non-taxable.
#
# The app sends the estimate as it is on screen -- the form may not have
# reached the database yet -- and this side finds or makes the customer and
# the products, so nothing has to be set up in QuickBooks first. What comes
# back (estimate id, number, customer) is written onto the job here AND by the
# app, so a dropped connection on the way back cannot lose it and send a
# second estimate next time.
#
# Ids are only good in the company they came from. While Job Hub is on the
# test (sandbox) company every id it keeps is a test-company id, and the same
# number in the real company is somebody else's customer or estimate. So an id
# is used only when the record says it came from the company connected now,
# and an estimate is changed only if it says it was made for this very job.

QB_APP = {"sandbox": "https://app.sandbox.qbo.intuit.com", "production": "https://qbo.intuit.com"}
LABOR_ITEM = "Labor"            # a labour line with no product chosen
MATERIALS_ITEM = "Material Fee"  # the one materials line
MEMO_MAX = 1000                 # Intuit's limit on the message to the customer
LINE_MAX = 4000                 # and on one line's description


def _quote(s):
    """A value inside a QuickBooks query: backslash and apostrophe escaped."""
    return str(s).replace("\\", "\\\\").replace("'", "\\'")


def _query(entity, where):
    data = _call("GET", "query", params={"query": "select * from %s where %s" % (entity, where)})
    return (data.get("QueryResponse") or {}).get(entity) or []


def _query_one(entity, where):
    rows = _query(entity, where)
    return rows[0] if rows else None


# ---------------------------------------------------------------- numbers
#
# The number on an estimate or invoice. QuickBooks hands out the next one
# itself -- unless "Custom transaction numbers" is switched on in its
# settings, when anything made through the connection comes out with NO
# number at all (Intuit: "If no value is supplied, the resulting DocNumber
# is null"). Jonah (7 Oct 2026): "its important that the estimate number is
# saved as the proper number. i am past 1600 in quickbooks." So the setting
# is read, and when it is on, the form gets the number after the highest
# already used for that kind -- what QuickBooks itself offers next.

_CUSTOM_NUMBERS = {}      # realm -> (when read, on?)


def _custom_numbers():
    realm = (_load_tokens() or {}).get("realmId") or ""
    hit = _CUSTOM_NUMBERS.get(realm)
    if hit and time.time() - hit[0] < 600:
        return hit[1]
    try:
        prefs = _call("GET", "preferences").get("Preferences") or {}
        on = bool((prefs.get("SalesFormsPrefs") or {}).get("CustomTxnNumbers"))
    except ReconnectNeeded:
        raise
    except Exception as err:          # noqa: BLE001
        # Not known: numbered here, which is right either way (a number
        # given is kept), and asked again next time.
        print("quickbooks: settings not read (%s); numbering it here" % err)
        return True
    _CUSTOM_NUMBERS[realm] = (time.time(), on)
    return on


def _next_number(entity):
    """One past the highest plain number among that kind's recent forms, or
    None when there is none to go on (QuickBooks then decides)."""
    data = _call("GET", "query", params={
        "query": "select DocNumber from %s orderby MetaData.CreateTime desc maxresults 200" % entity})
    rows = (data.get("QueryResponse") or {}).get(entity) or []
    nums = [int(r["DocNumber"]) for r in rows if str(r.get("DocNumber") or "").isdigit()]
    return str(max(nums) + 1) if nums else None


def _reserve_number(entity, seen):
    """The number to give, taken in one Firestore step: one past the higher of
    what QuickBooks shows (`seen`, or None when it could not be asked) and the
    last number handed out here. Two saves at the same moment (two devices,
    or a retry overlapping the first) never get the same number. Kept per
    QuickBooks company in integrations/quickbooksNumbers (server only)."""
    realm = (_load_tokens() or {}).get("realmId") or "none"
    ref = _db().collection("integrations").document("quickbooksNumbers")
    field = "%s_%s" % (realm, entity)

    @firestore.transactional
    def take(tx):
        snap = ref.get(transaction=tx)
        last = ((snap.to_dict() or {}) if snap.exists else {}).get(field)
        last = int(last) if isinstance(last, int) or str(last or "").isdigit() else None
        candidates = [n for n in (int(seen) - 1 if seen else None, last) if n is not None]
        if not candidates:
            return None
        n = max(candidates) + 1
        tx.set(ref, {field: n}, merge=True)
        return str(n)

    return take(_db().transaction())


def _numbered(entity, form):
    """The form, with its number when QuickBooks would leave it without one."""
    if not form.get("DocNumber") and _custom_numbers():
        failed = False
        try:
            seen = _next_number(entity)
        except ReconnectNeeded:
            raise
        except Exception as err:          # noqa: BLE001
            # QuickBooks would not say its latest number: carry on from the
            # last one handed out here, if there is one.
            print("quickbooks: latest %s number not read (%s)" % (entity, err))
            seen, failed = None, True
        n = _reserve_number(entity, seen)
        if n:
            form["DocNumber"] = n
        elif failed:
            # Nothing to go on: better no form than one with no number.
            raise RuntimeError("QuickBooks didn't say what %s number comes next — try again" % entity.lower())
        # else: no numbered forms yet anywhere -- QuickBooks decides, as before.
    return form


def _qb_name(s, limit=100):
    # QuickBooks names may not contain a colon (it means "sub-item of") or tab.
    return " ".join(str(s or "").replace(":", "-").replace("\t", " ").split())[:limit]


def _same_company(body):
    """True when the ids in the request came from the company connected now."""
    return (str(body.get("env") or "") or _env("QB_ENV", "sandbox")) == _env("QB_ENV", "sandbox")


def _job_note(job_id):
    return "Job Hub job %s" % job_id


def _customer_for(c, known_id=""):
    """The QuickBooks customer for this job: the one used last time, one with
    exactly this name, or a new one made from the job's details."""
    if known_id:
        found = _query_one("Customer", "Id = '%s'" % _quote(known_id))
        if found and found.get("Active", True):
            return found["Id"]
    name = _qb_name(c.get("name"), 500)
    if not name:
        raise RuntimeError("The job has no customer name")
    found = _query_one("Customer", "DisplayName = '%s'" % _quote(name))
    if found:
        return found["Id"]
    parts = name.split()
    new = {"DisplayName": name}
    if len(parts) >= 2:
        new["GivenName"], new["FamilyName"] = _qb_name(parts[0], 25), _qb_name(" ".join(parts[1:]), 25)
    if c.get("email"):
        new["PrimaryEmailAddr"] = {"Address": str(c["email"]).strip()[:100]}
    if c.get("phone"):
        new["PrimaryPhone"] = {"FreeFormNumber": str(c["phone"]).strip()[:30]}
    addr = _address(c)
    if addr:
        new["BillAddr"] = addr
    made = _call("POST", "customer", body=new, request_id=hashlib.sha1(("cust|" + name).encode()).hexdigest())
    return (made.get("Customer") or {})["Id"]


def _address(c):
    addr = {k: str(c.get(f) or "").strip()[:500] for k, f in
            (("Line1", "address"), ("City", "city"), ("CountrySubDivisionCode", "state"), ("PostalCode", "zip"))}
    return {k: v for k, v in addr.items() if v} or None


_income = {"id": None}


def _income_account():
    """Where new service products book their income: an income account named
    for services if there is one, otherwise the first income account."""
    if _income["id"]:
        return _income["id"]
    data = _call("GET", "query", params={"query":
                 "select Id, Name from Account where AccountType = 'Income' and Active = true"})
    rows = (data.get("QueryResponse") or {}).get("Account") or []
    if not rows:
        raise RuntimeError("QuickBooks has no income account to put new products in")
    pick = next((a for a in rows if "service" in a.get("Name", "").lower()), rows[0])
    _income["id"] = pick["Id"]
    return pick["Id"]


_items = {}


def _item_named(name):
    """The QuickBooks product called this, made as a service if it is missing.
    A category of the same name is not a product (Jonah's company has a
    "Labor" category with a "Labor" service inside it), so it is passed over."""
    name = _qb_name(name)
    if name in _items:
        return _items[name]
    hit = next((i for i in _query("Item", "Name = '%s'" % _quote(name))
                if i.get("Type") != "Category" and i.get("Active", True)), None)
    if not hit:
        new = {"Name": name, "Type": "Service", "IncomeAccountRef": {"value": _income_account()}}
        hit = _call("POST", "item", body=new, request_id=hashlib.sha1(("item|" + name).encode()).hexdigest()).get("Item") or {}
    _items[name] = hit["Id"]
    return hit["Id"]


def _line(item_id, cents, description):
    amount = round(int(cents) / 100, 2)
    text = description if len(description) <= LINE_MAX else description[:LINE_MAX - 1] + "…"
    return {"DetailType": "SalesItemLineDetail", "Amount": amount, "Description": text,
            "SalesItemLineDetail": {"ItemRef": {"value": item_id}, "Qty": 1, "UnitPrice": amount,
                                    "TaxCodeRef": {"value": "NON"}}}


def _estimate_lines(body):
    """Labour lines -- heading, the address on the first, the scope -- then
    the one materials line."""
    out, site = [], str(body.get("site") or "").strip()
    work = [w for w in body.get("work") or [] if int(w.get("cents") or 0) > 0 or str(w.get("scope") or "").strip()]
    for i, w in enumerate(work):
        head = [str(w.get("title") or "").strip().upper()]
        if i == 0 and site:
            head.append(site)
        text = "\n".join(h for h in head if h)
        scope = str(w.get("scope") or "").strip()
        if scope:
            text += ("\n\n" if text else "") + scope
        out.append(_line(_item_named(str(w.get("qbItem") or "").strip() or LABOR_ITEM), int(w.get("cents") or 0), text))
    m = body.get("materials") or {}
    if int(m.get("cents") or 0) > 0:
        listed = [str(x).strip() for x in m.get("list") or [] if str(x).strip()]
        head = "Materials: " + str(work[0].get("title") or "").strip() if len(work) == 1 and work[0].get("title") else "Materials"
        out.append(_line(_item_named(MATERIALS_ITEM), int(m["cents"]), head + ("\n\n" + "\n".join(listed) if listed else "")))
    if not out:
        raise RuntimeError("The estimate has nothing on it yet")
    return out


def _ours(e, job_id):
    """Whether a QuickBooks estimate is the one made for this job."""
    return str((e or {}).get("PrivateNote") or "").strip() == _job_note(job_id)


def _belongs(e, job_id, job=None):
    """This job's estimate: made for it here (_ours), or made in QuickBooks
    itself and brought in as this job (import_accepted marks the job's record
    `linked`). The estimate is never written to for that -- the job names it."""
    if not e:
        return False
    if _ours(e, job_id):
        return True
    if job is None:
        snap = _db().collection("jobs").document(job_id).get()
        job = (snap.to_dict() or {}) if snap.exists else {}
    q = (job or {}).get("qbEstimate") or {}
    return bool(q.get("linked") and str(q.get("id")) == str(e.get("Id")) and q.get("env") == _env("QB_ENV", "sandbox"))


def save_estimate(body):
    """Create or update the job's estimate in QuickBooks; email it when asked.

    body: jobId, customer {name, email, phone, address, city, state, zip},
    site (the address line), work [{title, scope, cents, qbItem}],
    materials {list, cents}, memo, estimateId / customerId / env (from last
    time), email (true to send).
    """
    job_id = str(body.get("jobId") or "").strip()
    if not job_id or "/" in job_id:
        raise RuntimeError("Save the job first")
    c = body.get("customer") or {}
    same = _same_company(body)
    customer_id = _customer_for(c, str(body.get("customerId") or "") if same else "")
    lines = _estimate_lines(body)

    memo = str(body.get("memo") or "").strip()
    if len(memo) > MEMO_MAX:
        # Too long for the message box: it goes in as the estimate's last
        # line instead, where the full text fits.
        lines.append({"DetailType": "DescriptionOnly", "Description": memo[:LINE_MAX], "DescriptionLineDetail": {}})
        memo = ""
    est = {"CustomerRef": {"value": customer_id}, "Line": lines, "PrivateNote": _job_note(job_id)}
    if memo:
        est["CustomerMemo"] = {"value": memo}
    email = str(c.get("email") or "").strip()
    if email:
        est["BillEmail"] = {"Address": email[:100]}
    site = _address(c)
    if site:
        est["ShipAddr"] = site

    existing = None
    if body.get("estimateId") and same:
        existing = _query_one("Estimate", "Id = '%s'" % _quote(body["estimateId"]))
        if existing and not _belongs(existing, job_id):
            print("quickbooks: estimate %s is not job %s's; making a new one" % (body["estimateId"], job_id))
            existing = None
    if existing and existing.get("TxnStatus") in ("Closed", "Converted"):
        raise RuntimeError("That estimate is already %s in QuickBooks; it can't be changed"
                           % existing["TxnStatus"].lower())
    if existing:
        # A full update replaces the whole estimate: its number goes back in
        # with it, or it could come back without one.
        est.update({"Id": existing["Id"], "SyncToken": existing["SyncToken"], "sparse": False,
                    "TxnDate": existing.get("TxnDate")})
        if existing.get("DocNumber"):
            est["DocNumber"] = existing["DocNumber"]
        saved = _call("POST", "estimate", body=est)
    else:
        # The request id is worked out before the number is given, so a
        # retry is still recognised if another estimate was made meanwhile.
        key = hashlib.sha1(("est|" + job_id + json.dumps(est, sort_keys=True)).encode()).hexdigest()
        saved = _call("POST", "estimate", body=_numbered("Estimate", est), request_id=key)
    e = saved.get("Estimate") or {}

    sent_to = ""
    if body.get("email"):
        if not email:
            raise RuntimeError("Saved in QuickBooks, but the job has no email to send it to")
        sent = _call("POST", "estimate/%s/send" % e["Id"], params={"sendTo": email}, empty_body=True)
        e = sent.get("Estimate") or e
        sent_to = email

    out = _estimate_record(e, customer_id)
    if sent_to:
        out.update(sentAt=_now().isoformat(), sentTo=sent_to)
    _db().collection("jobs").document(job_id).set({"qbEstimate": out, "lastModified": _stamp()}, merge=True)
    return out


def _estimate_record(e, customer_id=None):
    env = _env("QB_ENV", "sandbox")
    return {
        "id": e.get("Id"), "docNumber": e.get("DocNumber"),
        "customerId": customer_id or (e.get("CustomerRef") or {}).get("value"),
        "total": e.get("TotalAmt"), "status": e.get("TxnStatus") or "Pending",
        "emailStatus": e.get("EmailStatus"), "env": env,
        "link": "%s/app/estimate?txnId=%s" % (QB_APP.get(env, QB_APP["sandbox"]), e.get("Id")),
        "syncedAt": _now().isoformat(),
    }


def estimate_status(body):
    """Where the estimate stands in QuickBooks now: Pending, Accepted,
    Closed (made into an invoice), Rejected."""
    est_id = str(body.get("estimateId") or "").strip()
    if not est_id:
        raise RuntimeError("Which estimate?")
    if not _same_company(body):
        return {"missing": True, "error": "That estimate is in the QuickBooks test company, not the one connected now"}
    e = _query_one("Estimate", "Id = '%s'" % _quote(est_id))
    if not e:
        return {"missing": True}
    job_id = str(body.get("jobId") or "").strip()
    if job_id and not _belongs(e, job_id):
        return {"missing": True, "error": "That QuickBooks estimate belongs to another job"}
    out = _estimate_record(e)
    out["acceptedBy"] = e.get("AcceptedBy")
    out["acceptedDate"] = e.get("AcceptedDate")
    return out


def _stamp():
    """Now as JavaScript's toISOString() writes it. The app compares a job's
    lastModified as text and skips a copy whose stamp it already has -- so a
    change made here must carry a new stamp, in the same shape, or no device
    ever takes it (and the next save from one puts the old values back)."""
    t = datetime.datetime.now(datetime.timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (t.microsecond // 1000)


def _invoice_record(inv):
    env = _env("QB_ENV", "sandbox")
    return {
        "id": inv.get("Id"), "docNumber": inv.get("DocNumber"),
        "total": inv.get("TotalAmt"), "balance": inv.get("Balance"), "dueDate": inv.get("DueDate"),
        "emailStatus": inv.get("EmailStatus"), "env": env,
        "link": "%s/app/invoice?txnId=%s" % (QB_APP.get(env, QB_APP["sandbox"]), inv.get("Id")),
        "syncedAt": _now().isoformat(),
    }


def _invoice_lines(e, link_lines=False):
    """The estimate's lines as they are, for its invoice; with link_lines,
    each one names the estimate line it came from."""
    out = []
    for ln in e.get("Line") or []:
        kind = ln.get("DetailType")
        if kind == "SalesItemLineDetail":
            d = ln.get("SalesItemLineDetail") or {}
            detail = {k: d[k] for k in ("ItemRef", "Qty", "UnitPrice", "TaxCodeRef", "ServiceDate") if d.get(k) is not None}
            line = {"DetailType": kind, "Amount": ln.get("Amount"), "Description": ln.get("Description") or "",
                    "SalesItemLineDetail": detail}
            if link_lines and ln.get("Id"):
                line["LinkedTxn"] = [{"TxnId": e["Id"], "TxnType": "Estimate", "TxnLineId": ln["Id"]}]
            out.append(line)
        elif kind == "DescriptionOnly":
            out.append({"DetailType": kind, "Description": ln.get("Description") or "", "DescriptionLineDetail": {}})
    return out


def invoice_from_estimate(body):
    """The job's invoice, made from its estimate the way Jonah does it in
    QuickBooks: one invoice for the whole job with every line of the estimate,
    linked to it (which closes the estimate); the customer pays the deposit
    against it and the rest at the end. Emailed when asked. Asking again finds
    the invoice already made -- from here or in QuickBooks -- and never makes
    a second.

    body: jobId, estimateId, env, memo (the payment terms), email (true to
    send), invoiceId (from last time).
    """
    job_id = str(body.get("jobId") or "").strip()
    est_id = str(body.get("estimateId") or "").strip()
    if not job_id or "/" in job_id or not est_id:
        raise RuntimeError("Put the estimate in QuickBooks first")
    if not _same_company(body):
        raise RuntimeError("That estimate is in the QuickBooks test company, not the one connected now")
    e = _query_one("Estimate", "Id = '%s'" % _quote(est_id))
    if not e or not _belongs(e, job_id):
        raise RuntimeError("That estimate isn't in QuickBooks any more")

    inv = None
    known = str(body.get("invoiceId") or "").strip()
    if known:
        inv = _query_one("Invoice", "Id = '%s'" % _quote(known))
        # Only an invoice made for this job (or linked to this estimate): an
        # id from the test company names some other customer's invoice in the
        # real one.
        if inv and not (str(inv.get("PrivateNote") or "").startswith(_job_note(job_id)) or
                        any(t.get("TxnType") == "Estimate" and t.get("TxnId") == e["Id"] for t in inv.get("LinkedTxn") or [])):
            print("quickbooks: invoice %s is not job %s's; ignoring it" % (known, job_id))
            inv = None
    if not inv:
        # Made into an invoice in QuickBooks itself: the estimate names it.
        for t in e.get("LinkedTxn") or []:
            if t.get("TxnType") == "Invoice" and t.get("TxnId"):
                inv = _query_one("Invoice", "Id = '%s'" % _quote(t["TxnId"]))
                if inv:
                    break
    if not inv:
        if e.get("TxnStatus") == "Rejected":
            raise RuntimeError("The customer turned this estimate down in QuickBooks")
        if not any(ln["DetailType"] == "SalesItemLineDetail" for ln in _invoice_lines(e)):
            raise RuntimeError("The estimate has nothing on it to invoice")
        base = {"CustomerRef": e["CustomerRef"], "PrivateNote": _job_note(job_id)}
        if e.get("BillEmail"):
            base["BillEmail"] = e["BillEmail"]
        if e.get("ShipAddr"):
            # The address itself, not the estimate's own address record (Id).
            base["ShipAddr"] = {k: v for k, v in e["ShipAddr"].items() if k != "Id"}
        memo = str(body.get("memo") or "").strip()
        if memo:
            base["CustomerMemo"] = {"value": memo[:MEMO_MAX]}
        # Numbered once, so every way below carries the same number.
        _numbered("Invoice", base)
        # Linked to the estimate, which is what closes it in QuickBooks: on
        # the invoice as a whole first; if QuickBooks will not take that, line
        # by line; failing both, unlinked with the estimate named -- an
        # invoice made matters more than the link. One estimate, one invoice:
        # each way has its own request id, so pressing again is answered with
        # the invoice already made.
        ways = [
            ("whole", dict(base, Line=_invoice_lines(e), LinkedTxn=[{"TxnId": e["Id"], "TxnType": "Estimate"}])),
            ("lines", dict(base, Line=_invoice_lines(e, link_lines=True))),
            ("none", dict(base, Line=_invoice_lines(e),
                          PrivateNote=_job_note(job_id) + " · from estimate #%s" % (e.get("DocNumber") or e["Id"]))),
        ]
        first_error = None
        for way, new in ways:
            try:
                rid = hashlib.sha1(("inv|est|" + e["Id"] + ("" if way == "whole" else "|" + way)).encode()).hexdigest()
                inv = _call("POST", "invoice", body=new, request_id=rid).get("Invoice") or {}
                if way != "whole":
                    print("quickbooks: invoice for estimate %s made with link '%s' after: %s" % (e["Id"], way, first_error))
                break
            except ReconnectNeeded:
                raise
            except RuntimeError as err:
                first_error = first_error or err
                inv = None
                # Only a refusal of what was sent (400) is worth another way.
                # A server error may have saved the invoice after all, and a
                # second try under another request id would make a second one.
                if getattr(err, "status", None) != 400:
                    break
        if not inv:
            raise first_error

    sent_to = ""
    if body.get("email"):
        to = str(((inv.get("BillEmail") or e.get("BillEmail") or {}).get("Address")) or "").strip()
        if not to:
            raise RuntimeError("Made in QuickBooks, but the customer has no email to send it to")
        sent = _call("POST", "invoice/%s/send" % inv["Id"], params={"sendTo": to}, empty_body=True)
        inv = sent.get("Invoice") or inv
        sent_to = to

    out = _invoice_record(inv)
    out["estimateId"] = e["Id"]
    if sent_to:
        out.update(sentAt=_now().isoformat(), sentTo=sent_to)
    # Invoiced: the estimate is closed in QuickBooks; the job says so too, so
    # the hourly check does not report it back as news.
    # The invoice record is written whole, not merged: merged, a test-company
    # invoice's "emailed to" stayed on the real one made after it, which then
    # showed as sent (review, 7 Oct). The same invoice again keeps what was
    # known about it.
    ref = _db().collection("jobs").document(job_id)
    snap = ref.get()
    cur = ((snap.to_dict() or {}).get("qbInvoiceRef") if snap.exists else None) or {}
    if cur.get("id") == out.get("id") and cur.get("env") == out.get("env"):
        out = dict(cur, **out)
    ref.set({"qbInvoiceRef": out, "qbEstimate": {"status": "Closed"}, "lastModified": _stamp()},
            merge=["qbInvoiceRef", "qbEstimate.status", "lastModified"])
    return out


def invoice_status(body):
    """What the job's invoice has had paid against it."""
    inv_id = str(body.get("invoiceId") or "").strip()
    if not inv_id:
        raise RuntimeError("Which invoice?")
    if not _same_company(body):
        return {"missing": True, "error": "That invoice is in the QuickBooks test company, not the one connected now"}
    inv = _query_one("Invoice", "Id = '%s'" % _quote(inv_id))
    if not inv:
        return {"missing": True}
    return _invoice_record(inv)


def sweep():
    """Once an hour (the card run): every estimate out with a customer and
    every invoice not yet paid off is asked about in QuickBooks, so a "yes" or
    a payment shows on the job without Jonah opening it. Returns what changed,
    for his phone."""
    tokens = _load_tokens()
    if not tokens or not tokens.get("refreshToken"):
        return []
    env = _env("QB_ENV", "sandbox")
    db = _db()
    news = []
    jobs = {snap.id: (snap.to_dict() or {}) for snap in db.collection("jobs").stream()}
    for job_id, j in jobs.items():
        name = str(j.get("customerName") or "a customer")
        q = j.get("qbEstimate") or {}
        if q.get("id") and q.get("env") == env and (q.get("status") or "Pending") == "Pending":
            try:
                e = _query_one("Estimate", "Id = '%s'" % _quote(q["id"]))
            except Exception as err:                    # noqa: BLE001
                print("quickbooks sweep: estimate %s: %s" % (q["id"], err))
                e = None
            if e and _belongs(e, job_id, j) and (e.get("TxnStatus") or "Pending") != "Pending":
                rec = _estimate_record(e)
                rec.update(acceptedBy=e.get("AcceptedBy"), acceptedDate=e.get("AcceptedDate"))
                if q.get("linked"):
                    rec["linked"] = True
                db.collection("jobs").document(job_id).set({"qbEstimate": rec, "lastModified": _stamp()}, merge=True)
                news.append({"jobId": job_id, "kind": "estimate", "status": rec["status"], "name": name,
                             "docNumber": rec.get("docNumber"), "total": rec.get("total")})
        r = j.get("qbInvoiceRef") or {}
        if r.get("id") and r.get("env") == env and float(r.get("balance") or 0) > 0:
            try:
                inv = _query_one("Invoice", "Id = '%s'" % _quote(r["id"]))
            except Exception as err:                    # noqa: BLE001
                print("quickbooks sweep: invoice %s: %s" % (r["id"], err))
                inv = None
            if inv and float(inv.get("Balance") or 0) != float(r.get("balance") or 0):
                paid = round(float(r.get("balance") or 0) - float(inv.get("Balance") or 0), 2)
                rec = _invoice_record(inv)
                db.collection("jobs").document(job_id).set({"qbInvoiceRef": rec, "lastModified": _stamp()}, merge=True)
                # A balance that went UP (the invoice was changed) is no payment.
                if paid > 0:
                    news.append({"jobId": job_id, "kind": "payment", "name": name, "paid": paid,
                                 "balance": inv.get("Balance"), "docNumber": inv.get("DocNumber")})
    try:
        news += import_accepted(jobs)
    except ReconnectNeeded:
        raise
    except Exception as err:                            # noqa: BLE001
        print("quickbooks sweep: accepted estimates not brought in:", err)
    return news


# ------------------------------------------------- accepted estimates in
#
# Jonah (9 Oct 2026): "pull accepted estimates from quickbooks and add them
# as jobs". An estimate made in QuickBooks itself that the customer accepts
# becomes a job here -- booked, on the Jobs board, the crew's clock -- with
# the customer, address, number, price and the estimate's lines as its notes.
# One already a job here (the same estimate number typed on it) is linked to
# that job instead of made twice. Estimates made in Job Hub are left to the
# sweep above, and the owner's device books those (sync.js bookIfAccepted).
#
# Only from the real company: the test company is full of made-up
# customers, and they must never land in the job list. The first look goes
# back IMPORT_LOOKBACK_DAYS; after that, whatever changed since the last
# look. An estimate brought in once is remembered, so a job deleted here is
# not brought back.
IMPORT_LOOKBACK_DAYS = 30
NOTES_MAX = 4000


def _qb_time(t):
    return t.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + "+00:00"


def _parse_time(s):
    """QuickBooks' times carry the company's offset (-05:00); compared as
    times, not as text."""
    try:
        t = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=datetime.timezone.utc)
    except (TypeError, ValueError):
        return None


def _money_text(v):
    try:
        return "${:,.2f}".format(float(v))
    except (TypeError, ValueError):
        return ""


def _estimate_notes(e):
    """The estimate's lines, as the new job's notes."""
    out = ["From QuickBooks estimate #%s, accepted%s%s." % (
        e.get("DocNumber") or e.get("Id"),
        (" " + str(e["AcceptedDate"])[:10]) if e.get("AcceptedDate") else "",
        (" by " + str(e["AcceptedBy"])) if e.get("AcceptedBy") else "")]
    for ln in e.get("Line") or []:
        kind = ln.get("DetailType")
        if kind == "SalesItemLineDetail":
            item = ((ln.get("SalesItemLineDetail") or {}).get("ItemRef") or {}).get("name") or ""
            desc = " ".join(str(ln.get("Description") or "").split())
            text = ": ".join(s for s in (item, desc) if s)
            out.append("• " + (text or "Line") + (" — " + _money_text(ln.get("Amount")) if ln.get("Amount") is not None else ""))
        elif kind == "DescriptionOnly" and ln.get("Description"):
            out.append(" ".join(str(ln["Description"]).split()))
    memo = ((e.get("CustomerMemo") or {}).get("value") or "").strip()
    if memo:
        out.append("\n" + memo)
    return "\n".join(out)[:NOTES_MAX]


def _job_from_estimate(e, cust, stamp):
    cust = cust or {}
    addr = e.get("ShipAddr") or cust.get("ShipAddr") or e.get("BillAddr") or cust.get("BillAddr") or {}
    name = (cust.get("DisplayName") or (e.get("CustomerRef") or {}).get("name") or "").strip()
    total = float(e.get("TotalAmt") or 0)
    rec = _estimate_record(e, (e.get("CustomerRef") or {}).get("value"))
    rec.update(acceptedBy=e.get("AcceptedBy"), acceptedDate=e.get("AcceptedDate"), linked=True)
    return {
        "customerName": name or "Customer from QuickBooks",
        "firstName": str(cust.get("GivenName") or ""), "lastName": str(cust.get("FamilyName") or ""),
        "business": str(cust.get("CompanyName") or ""),
        "address": str(addr.get("Line1") or ""), "city": str(addr.get("City") or ""),
        "state": str(addr.get("CountrySubDivisionCode") or ""), "zip": str(addr.get("PostalCode") or ""),
        "phone": str(((cust.get("PrimaryPhone") or cust.get("Mobile") or {}).get("FreeFormNumber")) or ""),
        "email": str(((e.get("BillEmail") or cust.get("PrimaryEmailAddr") or {}).get("Address")) or ""),
        # The accepted total is the job's price, kept as typed (the form's
        # own estimate is empty, so nothing would set it).
        "jobPrice": "%.2f" % total, "manualJobPrice": True, "baseJobPrice": total,
        "estimateNumber": str(e.get("DocNumber") or ""), "quoteDate": str(e.get("TxnDate") or ""),
        "notes": _estimate_notes(e), "referral": "", "qbInvoice": "", "qbInvoiced": False, "taxable": False,
        "serviceTypes": [], "labor": [], "materials": [], "orderItems": [], "proposals": [],
        "payments": [], "additionalCosts": [],
        "jobStatus": "booked", "workStage": "scheduled", "workStageAt": stamp,
        "bidStage": "won", "bidStageAt": stamp,
        "qbEstimate": rec, "fromQuickBooks": {"estimateId": e.get("Id"), "at": stamp},
        "lastModified": stamp,
    }


def _number(s):
    return str(s or "").strip().lstrip("#").strip()


def import_accepted(jobs):
    """Accepted estimates made in QuickBooks -> jobs. `jobs` is every job,
    as the sweep read them. Returns news for the owner's phone."""
    env = _env("QB_ENV", "sandbox")
    if env != "production":
        return []
    realm = (_load_tokens() or {}).get("realmId") or "none"
    db = _db()
    ref = db.collection("integrations").document("quickbooksImport")
    snap = ref.get()
    state = (((snap.to_dict() or {}) if snap.exists else {}).get(realm)) or {}
    since = state.get("since") or _qb_time(_now() - datetime.timedelta(days=IMPORT_LOOKBACK_DAYS))
    seen = dict(state.get("seen") or {})          # estimate id -> job id

    rows = _query("Estimate", "MetaData.LastUpdatedTime > '%s' orderby MetaData.LastUpdatedTime maxresults 200"
                  % _quote(since))
    by_est = {str((j.get("qbEstimate") or {}).get("id")): jid for jid, j in jobs.items()
              if (j.get("qbEstimate") or {}).get("id") and (j.get("qbEstimate") or {}).get("env") == env}
    by_num = {}
    for jid, j in jobs.items():
        n = _number(j.get("estimateNumber"))
        if n:
            by_num.setdefault(n, jid)
    news = []
    newest = _parse_time(since)
    for e in rows:
        t = _parse_time((e.get("MetaData") or {}).get("LastUpdatedTime"))
        if t and (not newest or t > newest):
            newest = t
        eid = str(e.get("Id") or "")
        if not eid or eid in seen or (e.get("TxnStatus") or "") != "Accepted":
            continue
        note = str(e.get("PrivateNote") or "").strip()
        if note.startswith(_job_note("")):           # made in Job Hub: the sweep has it
            seen[eid] = note[len(_job_note("")):].strip()
            continue
        if eid in by_est:
            seen[eid] = by_est[eid]
            continue
        stamp = _stamp()
        rec = _estimate_record(e)
        rec.update(acceptedBy=e.get("AcceptedBy"), acceptedDate=e.get("AcceptedDate"), linked=True)
        num = _number(e.get("DocNumber"))
        if num and num in by_num:
            # Already a job here, typed in by hand with this number: linked,
            # and booked by the owner's device if it is still a bid.
            jid = by_num[num]
            if not ((jobs[jid].get("qbEstimate") or {}).get("id")):
                db.collection("jobs").document(jid).set({"qbEstimate": rec, "lastModified": stamp}, merge=True)
                news.append({"jobId": jid, "kind": "linked", "name": str(jobs[jid].get("customerName") or "a customer"),
                             "docNumber": e.get("DocNumber"), "total": e.get("TotalAmt")})
            seen[eid] = jid
            continue
        cust = None
        cid = (e.get("CustomerRef") or {}).get("value")
        if cid:
            try:
                cust = _query_one("Customer", "Id = '%s'" % _quote(cid))
            except ReconnectNeeded:
                raise
            except Exception as err:                    # noqa: BLE001
                print("quickbooks import: customer %s not read: %s" % (cid, err))
        job = _job_from_estimate(e, cust, stamp)
        # One id per estimate: two sweeps at once make one job, not two.
        jid = "qb" + re.sub(r"[^A-Za-z0-9]", "", eid)
        try:
            db.collection("jobs").document(jid).create(job)
        except Exception as err:                        # noqa: BLE001
            print("quickbooks import: job %s not made (%s)" % (jid, err))
            seen[eid] = jid
            continue
        # On the crew's clock too (sync.js boardEntry).
        db.collection("jobBoard").document(jid).set({
            "name": job["customerName"], "status": "booked",
            "address": ", ".join(s for s in (job["address"], job["city"], job["state"]) if s),
            "updatedAt": stamp})
        seen[eid] = jid
        by_num.setdefault(num, jid)
        news.append({"jobId": jid, "kind": "imported", "name": job["customerName"],
                     "docNumber": e.get("DocNumber"), "total": e.get("TotalAmt")})
    ref.set({realm: {"since": _qb_time(newest) if newest else since, "seen": seen, "at": _now().isoformat()}}, merge=True)
    return news


def create_invoice(body):
    """Create one invoice and hand back the number QuickBooks gave it.

    QuickBooks keeps its own sequence and assigns the number; the app records
    what came back rather than predicting it. The one exception is when
    QuickBooks is set to custom numbers and would leave the invoice with none:
    then it gets the next one after the highest (_numbered).

    The requestid makes a repeat of the same invoice harmless: Intuit answers it
    with the invoice it already made instead of making another. It is built from
    the app's requestKey (storm + account) AND the invoice itself, so retrying
    the identical invoice is deduplicated, while an invoice that was corrected
    after a refusal is treated as new rather than handed the old refusal back.
    """
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

    key = str(body.get("requestKey") or "").strip()
    if key:
        fingerprint = key + "|" + json.dumps(invoice, sort_keys=True)
        request_id = hashlib.sha1(fingerprint.encode("utf-8")).hexdigest()   # 40 chars; Intuit allows 50
    else:
        request_id = uuid.uuid4().hex          # still protects this request's own retries

    # The request id is worked out first (above), so a retry is recognised
    # whatever number this one is given.
    created = _call("POST", "invoice", body=_numbered("Invoice", invoice), request_id=request_id)
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
