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

import contextlib
import datetime
import hashlib
import json
import os
import re
import secrets
import threading
import time
import urllib.parse
import uuid
from html import escape as html_escape

import requests
from firebase_admin import firestore
from google.api_core.exceptions import AlreadyExists

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


# The tokens, held for one run that asks QuickBooks several things in a row
# (the hourly sweep) instead of read from Firestore before every question.
# Per thread: another request on the same instance reads its own.
_held = threading.local()


@contextlib.contextmanager
def _holding_tokens():
    _held.on, _held.tokens = True, None
    try:
        yield
    finally:
        _held.on, _held.tokens = False, None


def _load_tokens(fresh=False):
    holding = getattr(_held, "on", False)
    if holding and not fresh and _held.tokens is not None:
        return dict(_held.tokens) if _held.tokens else None
    snap = _tokens_ref().get()
    data = snap.to_dict() if snap.exists else None
    if holding:
        _held.tokens = dict(data) if data else {}
    return data


def _save_tokens(data):
    _tokens_ref().set(data, merge=True)
    # A refresh in the middle of a run: what is held is the new pair.
    if getattr(_held, "on", False) and _held.tokens is not None:
        _held.tokens.update(data)


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
    # Tokens from the other Intuit environment (the test company, kept after the
    # switch to the real one) can never work with this environment's keys: say
    # "connect again" plainly rather than send them and get a puzzling refusal.
    if tokens.get("env") and tokens["env"] != _env("QB_ENV", "sandbox"):
        raise ReconnectNeeded(
            "QuickBooks is still connected to Intuit's %s company -- connect your %s company"
            % (("test", "real") if tokens["env"] == "sandbox" else ("real", "test"))
        )

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
        latest = _load_tokens(fresh=True) or {}
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
        # The env is where a new connection would go (the server's), not the
        # one the dead tokens came from.
        return {"connected": False, "reconnect": True, "env": _env("QB_ENV", "sandbox"), "error": str(e)}
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
MATERIALS_ITEM = "Material Fee"  # the materials line
TAXED_MATERIALS_ITEM = "Planting & Lawn Materials"   # materials Wisconsin taxes (made taxable)
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
    """Where new service products book their income: the account called
    Sales (where Jonah's own products book theirs), else one named for
    services, else the first income account -- which in his company is
    "Billable Expense Income" (13 Oct 2026: the first product made here
    landed there)."""
    if _income["id"]:
        return _income["id"]
    data = _call("GET", "query", params={"query":
                 "select Id, Name from Account where AccountType = 'Income' and Active = true"})
    rows = (data.get("QueryResponse") or {}).get("Account") or []
    if not rows:
        raise RuntimeError("QuickBooks has no income account to put new products in")
    name = lambda a: a.get("Name", "").strip().lower()
    pick = next((a for a in rows if name(a) == "sales"), None) or \
        next((a for a in rows if "service" in name(a)), None) or \
        next((a for a in rows if "billable" not in name(a)), rows[0])
    _income["id"] = pick["Id"]
    return pick["Id"]


_items = {}


def _item_named(name, taxable=False):
    """The QuickBooks product called this, made as a service if it is missing
    (marked taxable when it is for taxed lines). A category of the same name
    is not a product (Jonah's company has a "Labor" category with a "Labor"
    service inside it), so it is passed over."""
    name = _qb_name(name)
    if name in _items:
        return _items[name]
    hit = next((i for i in _query("Item", "Name = '%s'" % _quote(name))
                if i.get("Type") != "Category" and i.get("Active", True)), None)
    if not hit:
        new = {"Name": name, "Type": "Service", "IncomeAccountRef": {"value": _income_account()}, "Taxable": bool(taxable)}
        hit = _call("POST", "item", body=new, request_id=hashlib.sha1(("item|" + name).encode()).hexdigest()).get("Item") or {}
    _items[name] = hit["Id"]
    return hit["Id"]


def _line(item_id, cents, description, taxable=False):
    """One line. Taxable lines (landscaping and lawn care, which Wisconsin
    taxes) carry TAX: QuickBooks' automated sales tax works out the rate from
    the estimate's ship-to address."""
    amount = round(int(cents) / 100, 2)
    text = description if len(description) <= LINE_MAX else description[:LINE_MAX - 1] + "…"
    return {"DetailType": "SalesItemLineDetail", "Amount": amount, "Description": text,
            "SalesItemLineDetail": {"ItemRef": {"value": item_id}, "Qty": 1, "UnitPrice": amount,
                                    "TaxCodeRef": {"value": "TAX" if taxable else "NON"}}}


def _estimate_lines(body):
    """Labour lines -- heading, the address on the first, the scope -- then
    the materials: one line, or two when some are taxed and some not
    (materialParts; a client from before sends only `materials`)."""
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
        out.append(_line(_item_named(str(w.get("qbItem") or "").strip() or LABOR_ITEM), int(w.get("cents") or 0), text,
                         taxable=w.get("taxable") is True))
    parts = body.get("materialParts")
    if not isinstance(parts, list):
        m = body.get("materials") or {}
        one = "Materials: " + str(work[0].get("title") or "").strip() if len(work) == 1 and work[0].get("title") else "Materials"
        parts = [{"head": one, "list": m.get("list"), "cents": m.get("cents"), "taxable": False}]
    for m in parts:
        if int((m or {}).get("cents") or 0) <= 0:
            continue
        listed = [str(x).strip() for x in m.get("list") or [] if str(x).strip()]
        head = str(m.get("head") or "Materials").strip()
        # Taxed materials go on a product of their own, made taxable: the
        # usual materials product is set up in QuickBooks as tax-exempt, and
        # its automated sales tax could leave a taxed line at $0 tax.
        taxed = m.get("taxable") is True
        item = _item_named(TAXED_MATERIALS_ITEM, taxable=True) if taxed else _item_named(MATERIALS_ITEM)
        out.append(_line(item, int(m["cents"]), head + ("\n\n" + "\n".join(listed) if listed else ""), taxable=taxed))
    if not out:
        raise RuntimeError("The estimate has nothing on it yet")
    return out


END_LINES_MAX = 10               # products on the end of one estimate


def _end_lines(body):
    """The $0 lines every estimate ends with, in order: the warranty, then the
    terms and conditions -- one QuickBooks product each, written in
    QuickBooks (a product's description holds 4000 characters, as a line
    does). Each line carries its product's own description, read now, so a
    change made there is on the next estimate. Customers e-sign the estimate
    itself, so a product that is missing or has no text stops the estimate
    rather than go out without it."""
    out = []
    names = [n for n in (_qb_name(x) for x in body.get("endItems") or []) if n]
    for name in names[:END_LINES_MAX]:
        hit = next((i for i in _query("Item", "Name = '%s'" % _quote(name))
                    if i.get("Type") != "Category" and i.get("Active", True)), None)
        if not hit:
            raise RuntimeError('QuickBooks has no product called "%s". Add it there with its text, '
                               "or take it off the list in Pricing rules." % name)
        text = str(hit.get("Description") or "").strip()
        if not text:
            raise RuntimeError('The QuickBooks product "%s" has no description -- its text is what goes '
                               "on the estimate." % name)
        out.append(_line(hit["Id"], 0, text))
    return out


LIEN_NOTICE_PDF = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lien_waiver_notice.pdf")
LIEN_NOTICE_NAME = "Notice of Right to Receive Lien Waivers.pdf"


def _upload(entity, entity_id, filename, data, include_on_send=True):
    """A file attached to a transaction (an Attachable), sent along when
    QuickBooks emails it. Multipart, so not through _call; a 401 is answered
    the same way (refresh once, then ask for a reconnect)."""
    meta = {"AttachableRef": [{"EntityRef": {"type": entity, "value": str(entity_id)}, "IncludeOnSend": bool(include_on_send)}],
            "FileName": filename, "ContentType": "application/pdf"}
    for second_try in (False, True):
        token, tokens = _access_token(force_refresh=second_try)
        url = "%s/v3/company/%s/upload" % (_api_base(), tokens.get("realmId"))
        files = {
            "file_metadata_01": (None, json.dumps(meta), "application/json"),
            "file_content_01": (filename, data, "application/pdf"),
        }
        resp = _send("POST", url, params={"minorversion": MINOR_VERSION}, files=files,
                     headers={"Authorization": "Bearer %s" % token, "Accept": "application/json"}, timeout=60)
        if resp.status_code == 401 and not second_try:
            continue
        if resp.status_code in (401, 403):
            raise ReconnectNeeded("QuickBooks rejected the connection (Intuit ref %s)" % _tid(resp))
        if resp.status_code >= 400:
            raise RuntimeError("QuickBooks would not take the attachment: %s (Intuit ref %s)" % (_fault_message(resp), _tid(resp)))
        got = (resp.json().get("AttachableResponse") or [{}])[0]
        if got.get("Fault"):
            raise RuntimeError("QuickBooks would not take the attachment: %s" % json.dumps(got["Fault"])[:300])
        return (got.get("Attachable") or {}).get("Id")


def _attach_lien_notice(job_id, est_id):
    """Wisconsin's "Notice of Consumer's Right to Receive Lien Waivers" (ATCP
    110.025) must reach a home customer as a separate page before they sign:
    attached to the estimate once, and emailed with it. The job notes which
    estimate has it, so an update doesn't attach it again."""
    snap = _db().collection("jobs").document(job_id).get()
    q = ((snap.to_dict() or {}) if snap.exists else {}).get("qbEstimate") or {}
    if str(q.get("lienNoticeFor") or "") == str(est_id) and q.get("env") == _env("QB_ENV", "sandbox"):
        return q.get("lienNoticeId")
    with open(LIEN_NOTICE_PDF, "rb") as f:
        return _upload("Estimate", est_id, LIEN_NOTICE_NAME, f.read())


def _ours(e, job_id):
    """Whether a QuickBooks estimate is the one made for this job."""
    return str((e or {}).get("PrivateNote") or "").strip() == _job_note(job_id)


def _accepted(e):
    """The customer said yes: Accepted -- or made into an invoice after that,
    when QuickBooks says Closed (Converted in some companies) and keeps the
    AcceptedDate. An estimate accepted and invoiced between two hourly looks
    is never seen as Accepted at all. digest.qb_accepted and the app's
    sync.js read a job's record the same way."""
    status = (e or {}).get("TxnStatus") or ""
    return status == "Accepted" or (status in ("Closed", "Converted") and bool((e or {}).get("AcceptedDate")))


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
    materials {list, cents}, memo, endItems (QuickBooks product names: the
    warranty and the terms, last), estimateId / customerId / env (from last
    time), email (true to send).
    """
    job_id = str(body.get("jobId") or "").strip()
    if not job_id or "/" in job_id:
        raise RuntimeError("Save the job first")
    c = body.get("customer") or {}
    same = _same_company(body)

    # The estimate already made for this job, looked for before anything is
    # made in QuickBooks (a customer, a product) for a save that is refused.
    existing = None
    if body.get("estimateId") and same:
        existing = _query_one("Estimate", "Id = '%s'" % _quote(body["estimateId"]))
        if existing and not _ours(existing, job_id):
            if _belongs(existing, job_id):
                # Made in QuickBooks itself and brought in as this job
                # (import_accepted). What the customer agreed to is there;
                # Job Hub rewriting its lines -- or emailing it again --
                # would change an accepted estimate behind his back.
                raise RuntimeError("This estimate was made in QuickBooks — change it there.")
            print("quickbooks: estimate %s is not job %s's; making a new one" % (body["estimateId"], job_id))
            existing = None
    if existing and existing.get("TxnStatus") in ("Closed", "Converted"):
        raise RuntimeError("That estimate is already %s in QuickBooks; it can't be changed"
                           % existing["TxnStatus"].lower())

    # A missing warranty or terms product is found before a customer is
    # made for nothing.
    ends = _end_lines(body)
    customer_id = _customer_for(c, str(body.get("customerId") or "") if same else "")
    lines = _estimate_lines(body)

    memo = str(body.get("memo") or "").strip()
    if len(memo) > MEMO_MAX:
        # Too long for the message box: it goes in as a line instead, where
        # the full text fits -- before the warranty and terms, which end it.
        lines.append({"DetailType": "DescriptionOnly", "Description": memo[:LINE_MAX], "DescriptionLineDetail": {}})
        memo = ""
    lines += ends
    est = {"CustomerRef": {"value": customer_id}, "Line": lines, "PrivateNote": _job_note(job_id)}
    if memo:
        est["CustomerMemo"] = {"value": memo}
    email = str(c.get("email") or "").strip()
    if email:
        est["BillEmail"] = {"Address": email[:100]}
    site = _address(c)
    if site:
        est["ShipAddr"] = site

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

    # A home's estimate carries the lien-waiver notice, attached before it
    # can be emailed; if QuickBooks won't take it, the estimate is saved but
    # not sent.
    notice = None
    if body.get("lienNotice"):
        try:
            notice = _attach_lien_notice(job_id, e["Id"])
        except ReconnectNeeded:
            raise
        except Exception as err:            # noqa: BLE001 -- said plainly below
            print("quickbooks: lien notice not attached to estimate %s: %s" % (e.get("Id"), err))
            if body.get("email"):
                _keep_record(job_id, e, customer_id)
                raise RuntimeError("Saved in QuickBooks, but not emailed: the lien-waiver notice couldn't be "
                                   "attached (%s). Try again." % err)

    sent_to = ""
    if body.get("email"):
        if not email:
            raise RuntimeError("Saved in QuickBooks, but the job has no email to send it to")
        sent = _call("POST", "estimate/%s/send" % e["Id"], params={"sendTo": email}, empty_body=True)
        e = sent.get("Estimate") or e
        sent_to = email

    # The job tied to that customer, and a lead it was tied to made the
    # customer (customers.py) -- never in the way of the estimate itself.
    try:
        import customers
        customers.estimate_made(job_id, customer_id)
    except ReconnectNeeded:
        raise
    except Exception as err:                # noqa: BLE001
        print("quickbooks: job %s not tied to customer %s: %s" % (job_id, customer_id, err))

    out = _estimate_record(e, customer_id)
    if sent_to:
        out.update(sentAt=_now().isoformat(), sentTo=sent_to)
    if notice:
        out.update(lienNoticeFor=e["Id"], lienNoticeId=notice)
    _db().collection("jobs").document(job_id).set({"qbEstimate": out, "lastModified": _stamp()}, merge=True)
    return out


def _keep_record(job_id, e, customer_id):
    """What QuickBooks now has, onto the job, when the save went through but
    a later step did not -- so the next try updates this estimate."""
    _db().collection("jobs").document(job_id).set(
        {"qbEstimate": _estimate_record(e, customer_id), "lastModified": _stamp()}, merge=True)


def _estimate_record(e, customer_id=None):
    """What the job keeps of its QuickBooks estimate. acceptedDate tells an
    estimate accepted and then invoiced (Closed) from one closed unaccepted
    (_accepted); txnDate is the estimate's own date, which the hourly sweep
    stops asking about after SWEEP_MAX_AGE_DAYS."""
    env = _env("QB_ENV", "sandbox")
    return {
        "id": e.get("Id"), "docNumber": e.get("DocNumber"),
        "customerId": customer_id or (e.get("CustomerRef") or {}).get("value"),
        "total": e.get("TotalAmt"), "status": e.get("TxnStatus") or "Pending",
        "acceptedBy": e.get("AcceptedBy"), "acceptedDate": e.get("AcceptedDate"),
        "txnDate": e.get("TxnDate"),
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
    # acceptedDate rides on the record: Closed with it means accepted, then
    # invoiced (_accepted).
    return _estimate_record(e)


def _stamp():
    """Now as JavaScript's toISOString() writes it. The app compares a job's
    lastModified as text and skips a copy whose stamp it already has -- so a
    change made here must carry a new stamp, in the same shape, or no device
    ever takes it (and the next save from one puts the old values back)."""
    t = datetime.datetime.now(datetime.timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (t.microsecond // 1000)


# A finished job's place on the Jobs board follows its invoice (Jonah's
# board: Ready to invoice -> Invoiced -> Paid). The app's sync.js
# finishedStage is the same rule; both only ever move a job forward, and only
# a job marked Complete -- the deposit invoice is usually made the day the
# estimate is accepted, long before the work is done, and a job still being
# worked keeps its own column (Punch list, say).
END_STAGES = {"toInvoice": 0, "invoiced": 1, "paid": 2}


def _job_status(j):
    s = (j or {}).get("jobStatus") or "quoting"
    if s == "active":
        return "inprogress" if (j or {}).get("workStage") in ("inProgress", "punchList") else "booked"
    return s


def _stage_patch(j, inv_rec, stamp):
    """{workStage, workStageAt} to move a finished job on to where its
    invoice (inv_rec: _invoice_record) says it is, or {} to leave it."""
    if _job_status(j) != "complete" or not (inv_rec or {}).get("id"):
        return {}
    bal = inv_rec.get("balance")
    try:
        paid = bal is not None and bal != "" and float(bal) <= 0
    except (TypeError, ValueError):
        paid = False
    want = "paid" if paid else "invoiced"
    had = (j or {}).get("workStage")
    if had in END_STAGES and END_STAGES[had] >= END_STAGES[want]:
        return {}
    return {"workStage": want, "workStageAt": stamp}


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
    job = (snap.to_dict() or {}) if snap.exists else {}
    cur = job.get("qbInvoiceRef") or {}
    if cur.get("id") == out.get("id") and cur.get("env") == out.get("env"):
        out = dict(cur, **out)
    # A finished job moves to Invoiced (or Paid) on the Jobs board in the
    # same write (_stage_patch) -- it used to sit in Ready to invoice.
    stamp = _stamp()
    stage = _stage_patch(job, out, stamp)
    ref.set(dict({"qbInvoiceRef": out, "qbEstimate": {"status": "Closed"}, "lastModified": stamp}, **stage),
            merge=["qbInvoiceRef", "qbEstimate.status", "lastModified"] + sorted(stage))
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


# What the sweep reads of each job -- not the whole record (estimate chats,
# materials, notes), which every job carries and the sweep never looks at.
SWEEP_FIELDS = ["customerName", "qbEstimate", "qbInvoiceRef", "jobStatus", "bidStage", "estimateNumber", "payments",
                "acceptedSeenAt", "workStage", "qbFilled", "jobPrice", "removeWhy", "fromQuickBooks", "snowChecked"]
# An estimate with no answer this long after it was made (or last emailed)
# is not asked about every hour for ever; opening the job still checks it
# (estimate.js). A year, because a bid sent in November is often said yes to
# in April -- and in batches of IN_BATCH an old one costs next to nothing.
SWEEP_MAX_AGE_DAYS = 365
IN_BATCH = 30               # ids per "where Id in (...)" question to QuickBooks


def _amount(v):
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _by_ids(entity, ids):
    """{Id: record} for many estimates or invoices, IN_BATCH to a question,
    rather than one question each."""
    ids = sorted({str(i) for i in ids if str(i or "").strip()})
    out = {}
    for n in range(0, len(ids), IN_BATCH):
        part = ids[n:n + IN_BATCH]
        try:
            rows = _query(entity, "Id in (%s)" % ", ".join("'%s'" % _quote(i) for i in part))
        except ReconnectNeeded:
            raise
        except Exception as err:                        # noqa: BLE001 -- the rest are still asked
            print("quickbooks sweep: %s %s: %s" % (entity.lower(), ",".join(part), err))
            continue
        for r in rows:
            out[str(r.get("Id"))] = r
    return out


def _too_old(q, now):
    """Whether a job's estimate record is past SWEEP_MAX_AGE_DAYS: counted
    from the later of the estimate's own date and when it was last emailed
    (a re-sent estimate is a live one), else from when it was last looked at
    (records from before txnDate was kept)."""
    times = [t for t in (_parse_time(q.get(k)) if q.get(k) else None for k in ("txnDate", "sentAt")) if t]
    if not times and q.get("syncedAt"):
        t = _parse_time(q.get("syncedAt"))
        times = [t] if t else []
    return bool(times) and now - max(times) > datetime.timedelta(days=SWEEP_MAX_AGE_DAYS)


def sweep():
    """Once an hour (the card run): every estimate out with a customer and
    every invoice not yet paid off is asked about in QuickBooks, so a "yes" or
    a payment shows on the job without Jonah opening it. Returns what changed,
    for his phone.

    Asked in batches, the tokens read once (_holding_tokens), and only the
    fields it needs read of each job. An estimate with no answer after
    SWEEP_MAX_AGE_DAYS is left alone."""
    with _holding_tokens():
        return _sweep()


def _sweep():
    tokens = _load_tokens()
    if not tokens or not tokens.get("refreshToken"):
        return []
    # Half-finished connections (Connect pressed, never come back) cleared.
    try:
        sweep_stale_states()
    except Exception as err:                            # noqa: BLE001
        print("quickbooks sweep: old connection attempts not cleared:", err)
    env = _env("QB_ENV", "sandbox")
    db = _db()
    now = _now()
    news = []
    jobs = {snap.id: (snap.to_dict() or {}) for snap in db.collection("jobs").select(SWEEP_FIELDS).stream()}
    pending, unpaid = {}, {}             # QuickBooks id -> [job ids]
    for job_id, j in jobs.items():
        q = j.get("qbEstimate") or {}
        # A lost bid is still asked about: a customer who said no in the fall
        # can say yes from the QuickBooks email in spring. acceptedSeenAt
        # (sync.js) keeps a bid marked lost AFTER a yes from being re-booked.
        if q.get("id") and q.get("env") == env and (q.get("status") or "Pending") == "Pending" \
                and not _too_old(q, now):
            pending.setdefault(str(q["id"]), []).append(job_id)
        r = j.get("qbInvoiceRef") or {}
        if r.get("id") and r.get("env") == env and _amount(r.get("balance")) > 0:
            unpaid.setdefault(str(r["id"]), []).append(job_id)

    estimates = _by_ids("Estimate", pending) if pending else {}
    for est_id, job_ids in pending.items():
        e = estimates.get(est_id)
        for job_id in job_ids:
            j = jobs[job_id]
            if not (e and _belongs(e, job_id, j) and (e.get("TxnStatus") or "Pending") != "Pending"):
                continue
            rec = _estimate_record(e)
            if (j.get("qbEstimate") or {}).get("linked"):
                rec["linked"] = True
            stamp = _stamp()
            patch = {"qbEstimate": rec, "lastModified": stamp}
            # The moment the yes was seen (sync.js bookIfAccepted: a bid moved
            # by hand after it is left where it was put). Every job here was
            # still waiting at the last look, so this IS that moment -- an
            # older acceptedSeenAt belongs to an earlier yes, before the
            # estimate was changed and sent again.
            if _accepted(e):
                patch["acceptedSeenAt"] = stamp
            db.collection("jobs").document(job_id).set(patch, merge=True)
            news.append({"jobId": job_id, "kind": "estimate", "status": rec["status"], "accepted": _accepted(e),
                         "name": str(j.get("customerName") or "a customer"),
                         "docNumber": rec.get("docNumber"), "total": rec.get("total")})

    invoices = _by_ids("Invoice", unpaid) if unpaid else {}
    for inv_id, job_ids in unpaid.items():
        inv = invoices.get(inv_id)
        for job_id in job_ids:
            r = jobs[job_id].get("qbInvoiceRef") or {}
            if not inv or _amount(inv.get("Balance")) == _amount(r.get("balance")):
                continue
            paid = round(_amount(r.get("balance")) - _amount(inv.get("Balance")), 2)
            rec = _invoice_record(inv)
            # Paid off: a finished job moves to Paid on the Jobs board (and
            # one still in Ready to invoice to Invoiced) -- _stage_patch.
            stamp = _stamp()
            patch = dict({"qbInvoiceRef": rec, "lastModified": stamp}, **_stage_patch(jobs[job_id], rec, stamp))
            db.collection("jobs").document(job_id).set(patch, merge=True)
            # A balance that went UP (the invoice was changed) is no payment.
            if paid > 0:
                news.append({"jobId": job_id, "kind": "payment", "name": str(jobs[job_id].get("customerName") or "a customer"),
                             "paid": paid, "balance": inv.get("Balance"), "docNumber": inv.get("DocNumber")})
    try:
        news += sync_invoices(jobs)
    except ReconnectNeeded:
        raise
    except Exception as err:                            # noqa: BLE001
        print("quickbooks sweep: invoices list not brought up to date:", err)
    try:
        sync_payments(jobs)
    except ReconnectNeeded:
        raise
    except Exception as err:                            # noqa: BLE001
        print("quickbooks sweep: payments not brought in step:", err)
    try:
        news += import_accepted(jobs)
    except ReconnectNeeded:
        raise
    except Exception as err:                            # noqa: BLE001
        print("quickbooks sweep: accepted estimates not brought in:", err)
    try:
        moved = snow_from_jobs(jobs)
        if moved:
            print("quickbooks sweep: %d snow contract(s) put on the Snow route" % moved)
    except ReconnectNeeded:
        raise
    except Exception as err:                            # noqa: BLE001
        print("quickbooks sweep: snow contracts not moved:", err)
    try:
        joined = link_hand_jobs(jobs)
        if joined:
            print("quickbooks sweep: %d job(s) typed in by hand joined to their QuickBooks estimate" % joined)
    except ReconnectNeeded:
        raise
    except Exception as err:                            # noqa: BLE001
        print("quickbooks sweep: hand-typed jobs not looked for:", err)
    try:
        filled = fill_imported(jobs)
        if filled:
            print("quickbooks sweep: %d job(s) filled from their QuickBooks estimate" % filled)
    except ReconnectNeeded:
        raise
    except Exception as err:                            # noqa: BLE001
        print("quickbooks sweep: jobs not filled from QuickBooks:", err)
    try:
        invoiced = copy_invoices(jobs)
        if invoiced:
            print("quickbooks sweep: %d job(s) given the invoice made from an earlier copy" % invoiced)
    except ReconnectNeeded:
        raise
    except Exception as err:                            # noqa: BLE001
        print("quickbooks sweep: copies' invoices not looked for:", err)
    # The customer list (customers.py): who changed in QuickBooks since the
    # last look, and Job Hub's edits that have not reached it yet. Off until
    # the owner switches the first read on (settings/customers.importOn).
    try:
        import customers
        got = customers.sync()
        if got:
            print("quickbooks sweep: customers %s" % got)
    except ReconnectNeeded:
        raise
    except Exception as err:                            # noqa: BLE001
        print("quickbooks sweep: customers not brought in step:", err)
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
# look (a minute's overlap: two estimates changed in the same second must not
# fall either side of the line). Only estimates accepted since that first
# look's start (acceptedFrom): an old one accepted before Job Hub took them
# in, edited or invoiced since, is not new work. An estimate brought in once
# is remembered, so a job deleted here is not brought back; one whose job
# could not be made is tried again, IMPORT_MAX_TRIES times.
IMPORT_LOOKBACK_DAYS = 30
IMPORT_OVERLAP = datetime.timedelta(minutes=1)
IMPORT_MAX_TRIES = 3
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


def _lines_as_notes(e):
    """What the first imports wrote into the job's notes: the estimate's
    lines as text. Kept only to recognise those notes untouched (fill_imported),
    now that the lines go into the job's estimate itself."""
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


# ----------------------------------------- a QuickBooks estimate, read in full
#
# Jonah (15 Oct 2026): a job brought in from QuickBooks must carry everything
# the estimate says -- "all notes line items and materials full list with
# pricing" -- not just its price. So the estimate becomes the job's own
# estimate (estimate.js, version 2), the way one built in Job Hub is:
#  - each product line a line of work at the amount it was sold for, its
#    description the scope;
#  - the Material Fee line (his materials go on one line, listed in its
#    description, "Screened topsoil: 2.5 cubic yards") taken apart into the
#    materials, one line each, by name, quantity and unit. Joined to his
#    Supplies on his device (estimate.js linkFromQb), which has the
#    catalogue, and from there to Materials to Order;
#  - the figures the customer said yes to kept as they are (fromQb):
#    pricing.js adds no delivery, fuel or rule lines on top and takes the
#    materials as the one amount QuickBooks had.
# The terms lines every estimate ends with (Pricing rules -> the end of every
# QuickBooks estimate) are the same on every job, so they are left out.

MATERIAL_ITEM = re.compile(r"\bmaterials?\b", re.I)
MATERIAL_BOILER = re.compile(r"^cost of materials? used in (a|the) project or service\.?$", re.I)
_QTY = r"(\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)"
_ABOUT = r"(?:approx(?:imately|\.)?\s*|about\s+|~\s*)?"
_UNIT = r"([A-Za-z][A-Za-z./' ]*?)?"
# After a "Name:" -- "3 tons", "20pcs.", "x1", "approx. 6 tons", "".
_AMOUNT_ONLY = re.compile(r"^" + _ABOUT + r"x?\s*" + _QTY + r"\s*" + _UNIT + r"\.?$", re.I)
# No colon, the amount at the end -- "Compacted Aggregate Base (6\") approx. 6 tons",
# "... End Boulder approx. 2 tons + 1".
_AMOUNT_AT_END = re.compile(r"^(.+?)\s+" + _ABOUT + r"x?" + _QTY + r"\s*" + _UNIT + r"\.?(?:\s*\+.*)?$", re.I)
END_ALWAYS = ("terms of service",)
WORK_ID = re.compile(r"[^A-Za-z0-9]")


def _cents(v):
    return int(round(_amount(v) * 100))


def _qty_unit(qty, unit):
    try:
        q = float(str(qty).replace(",", ""))
    except (TypeError, ValueError):
        return None, ""
    u = " ".join(str(unit or "").split()).strip(" .").lower()[:24]
    return (int(q) if q == int(q) else q), u


def _material(line):
    """One line of a Material Fee's list -> (name, qty, unit), qty None when
    it gives none ("Screened topsoil:"); None when the line is not a
    material at all ("Material Delivery Included")."""
    s = line.strip().lstrip("-•*·–— ").strip()
    if not s or MATERIAL_BOILER.match(s):
        return None
    if ":" in s:
        name, rest = (p.strip() for p in s.split(":", 1))
        if name and not rest:
            return name, None, ""
        m = _AMOUNT_ONLY.match(rest)
        if name and m:
            q, u = _qty_unit(m.group(1), m.group(2))
            return name, q, u
    m = _AMOUNT_AT_END.match(s)
    if m and m.group(1).strip(" ,:-"):
        q, u = _qty_unit(m.group(2), m.group(3))
        return m.group(1).strip(" ,:-"), q, u
    return None


def _flat_lines(lines):
    """The estimate's lines, a bundle's lines in its place."""
    for ln in lines or []:
        if ln.get("DetailType") == "GroupLineDetail":
            yield from _flat_lines((ln.get("GroupLineDetail") or {}).get("Line"))
        else:
            yield ln


def _end_names():
    """The products every estimate ends with (warranty, terms), lower case."""
    try:
        r = _db().collection("pricing").document("rules").get().to_dict() or {}
    except Exception as err:                            # noqa: BLE001 -- the lines then come in with the rest
        print("quickbooks import: pricing rules not read:", err)
        r = {}
    end = r.get("estimateEnd") or {}
    names = [str(n) for n in list(end.get("items") or []) + list(end.get("businessItems") or [])]
    return {" ".join(n.lower().split()) for n in names if n.strip()} | set(END_ALWAYS)


LATE_FEE = re.compile(r"\blate\s*fee", re.I)


def _hub_estimate(e, end_names, stamp):
    """A QuickBooks estimate as the job's estimate (estimate.js v2), and the
    words that belong in the job's notes rather than on a line."""
    work, mats, words = [], [], []
    materials_cents = 0
    for n, ln in enumerate(_flat_lines(e.get("Line")), 1):
        kind = ln.get("DetailType")
        desc = str(ln.get("Description") or "").strip()
        if kind == "SalesItemLineDetail":
            d = ln.get("SalesItemLineDetail") or {}
            item = str((d.get("ItemRef") or {}).get("name") or "").strip()
            short = item.split(":")[-1].strip()
            if " ".join(short.lower().split()) in end_names or " ".join(item.lower().split()) in end_names:
                continue
            # QuickBooks' automatic late fees are charges on the bill, not work.
            if LATE_FEE.search(item):
                continue
            if MATERIAL_ITEM.search(short):
                materials_cents += _cents(ln.get("Amount"))
                for row in desc.splitlines():
                    got = _material(row)
                    if got is None:
                        s = row.strip().lstrip("-•*·–— ").strip()
                        if s and not MATERIAL_BOILER.match(s):
                            words.append(s)
                        continue
                    name, q, u = got
                    mats.append({"id": "emqb%s%d" % (WORK_ID.sub("", str(e.get("Id"))), len(mats) + 1),
                                 "name": name[:200], "qty": q, "unit": u, "wastePct": 0, "qbText": row.strip()[:300]})
                continue
            qty, rate = d.get("Qty"), d.get("UnitPrice")
            title = short or "Work"
            try:
                if qty is not None and float(qty) != 1:
                    title += " (%s × %s)" % (("%g" % float(qty)), _money_text(rate))
            except (TypeError, ValueError):
                pass
            code = str((d.get("TaxCodeRef") or {}).get("value") or "")
            work.append({"id": "ewqb%s%s" % (WORK_ID.sub("", str(ln.get("Id") or n)), WORK_ID.sub("", str(e.get("Id")))),
                         "kind": "amount", "title": title[:200], "scope": desc[:6000], "amountCents": _cents(ln.get("Amount")),
                         "qbItem": item[:100], "taxable": code not in ("", "NON")})
        elif kind == "DiscountLineDetail":
            dd = ln.get("DiscountLineDetail") or {}
            title = "Discount" + ((" %g%%" % float(dd["DiscountPercent"])) if dd.get("PercentBased") and dd.get("DiscountPercent") else "")
            work.append({"id": "ewqbd%d%s" % (n, WORK_ID.sub("", str(e.get("Id")))), "kind": "amount", "title": title,
                         "scope": desc[:2000], "amountCents": -abs(_cents(ln.get("Amount"))), "taxable": False})
        elif kind == "DescriptionOnly" and desc:
            words.append(desc)
    tax = _cents((e.get("TxnTaxDetail") or {}).get("TotalTax"))
    est = {
        "v": 2, "notes": "", "chat": [], "questions": [], "flags": [], "work": work, "materials": mats,
        "spoilCuYd": None, "fuel": {}, "deliveryTown": "", "off": {}, "sent": [], "site": None, "payments": None,
        "memo": ((e.get("CustomerMemo") or {}).get("value") or "").strip()[:4000],
        "fromQb": {"estimateId": str(e.get("Id")), "docNumber": str(e.get("DocNumber") or ""),
                   "materialsCents": materials_cents, "taxCents": tax, "totalCents": _cents(e.get("TotalAmt")),
                   "acceptedDate": str(e.get("AcceptedDate") or ""), "at": stamp},
    }
    return est, words


WHAT_MAX = 40
PRICED_AS = re.compile(r"\s*\([^)]*×[^)]*\)\s*$")


def _what(est):
    """What the job is in a few words, beside the name on the crew's clock
    (app.js jobWhat, the same rule): the first line or two of work."""
    titles = [PRICED_AS.sub("", str(w.get("title") or "")).strip() for w in (est or {}).get("work") or []]
    titles = [t for t in titles if t]
    if not titles:
        return ""
    out = titles[0]
    if len(titles) > 1 and titles[1] != titles[0] and len(out + " & " + titles[1]) <= WHAT_MAX:
        out += " & " + titles[1]
    return out if len(out) <= WHAT_MAX else out[:WHAT_MAX - 1].strip() + "…"


def _hub_notes(e, words):
    """The job's notes for an estimate brought in: where it came from, and any
    words in it that are not a line of work or a material."""
    head = "From QuickBooks estimate #%s, accepted%s%s." % (
        e.get("DocNumber") or e.get("Id"),
        (" " + str(e["AcceptedDate"])[:10]) if e.get("AcceptedDate") else "",
        (" by " + str(e["AcceptedBy"])) if e.get("AcceptedBy") else "")
    return "\n".join([head] + words)[:NOTES_MAX]


STATE_ZIP = re.compile(r"^(.*?)[,\s]+([A-Z]{2})\.?\s+(\d{5})(?:-\d{4})?$")


def _addr_parts(addr, name=""):
    """An address as street, city, state, ZIP. QuickBooks keeps some as typed
    on the form -- the customer's name on the first line, then the street,
    then "Madison, WI  53714" -- with no city field (two jobs came in with the
    customer's name for an address, Oct 2026)."""
    addr = addr or {}
    street, city = "", str(addr.get("City") or "").strip()
    state, zipc = str(addr.get("CountrySubDivisionCode") or "").strip(), str(addr.get("PostalCode") or "").strip()
    lines = [" ".join(str(addr.get("Line%d" % i) or "").split()) for i in range(1, 6)]
    lines = [s for s in lines if s]
    who = " ".join(str(name or "").lower().split())
    for s in lines:
        m = STATE_ZIP.match(s)
        if m and not city:
            before = m.group(1).strip(" ,")
            # All on one line: "123 Main St, Madison, WI 53703".
            if "," in before and not street:
                street, before = (p.strip() for p in before.rsplit(",", 1))
            city, state, zipc = before, m.group(2), m.group(3)
        elif s.lower() == who or (not any(ch.isdigit() for ch in s) and not street and len(lines) > 1 and s is lines[0]):
            continue                    # the customer's name (or a company name) above the street
        elif not street:
            street = s
    return {"address": street, "city": city, "state": state, "zip": zipc}


def _best_addr(e, cust, name):
    """The job's address: where the work is (ShipAddr) before the billing
    one, the estimate's before the customer's -- the first with a street."""
    cust = cust or {}
    for a in (e.get("ShipAddr"), cust.get("ShipAddr"), e.get("BillAddr"), cust.get("BillAddr")):
        parts = _addr_parts(a, name)
        if parts["address"]:
            return parts
    return {"address": "", "city": "", "state": "", "zip": ""}


def _job_from_estimate(e, cust, stamp, end_names):
    cust = cust or {}
    name = (cust.get("DisplayName") or (e.get("CustomerRef") or {}).get("name") or "").strip()
    est, words = _hub_estimate(e, end_names, stamp)
    # The price before tax, as a job built in Job Hub has it (its estimate's
    # total) -- the same figure, from the same lines.
    price = (_cents(e.get("TotalAmt")) - est["fromQb"]["taxCents"]) / 100
    rec = _estimate_record(e, (e.get("CustomerRef") or {}).get("value"))
    rec["linked"] = True
    return dict(_best_addr(e, cust, name), **{
        "customerName": name or "Customer from QuickBooks",
        "firstName": str(cust.get("GivenName") or ""), "lastName": str(cust.get("FamilyName") or ""),
        "business": str(cust.get("CompanyName") or ""),
        "phone": str(((cust.get("PrimaryPhone") or cust.get("Mobile") or {}).get("FreeFormNumber")) or ""),
        "email": str(((e.get("BillEmail") or cust.get("PrimaryEmailAddr") or {}).get("Address")) or ""),
        "jobPrice": "%.2f" % price, "manualJobPrice": False, "baseJobPrice": price,
        "estimateNumber": str(e.get("DocNumber") or ""), "quoteDate": str(e.get("TxnDate") or ""),
        "notes": _hub_notes(e, words), "referral": "", "qbInvoice": "", "qbInvoiced": False, "taxable": False,
        "serviceTypes": [], "labor": [], "materials": [], "orderItems": [], "proposals": [],
        "payments": [], "additionalCosts": [], "estimate": est,
        "jobStatus": "booked", "workStage": "scheduled", "workStageAt": stamp,
        "bidStage": "won", "bidStageAt": stamp,
        "qbEstimate": rec, "fromQuickBooks": {"estimateId": e.get("Id"), "at": stamp},
        # Tied to the customer by QuickBooks' own id, not by the spelling of a name.
        "customerId": str((e.get("CustomerRef") or {}).get("value") or "") or None, "customerBy": "auto",
        "qbFilled": {"estimateId": str(e.get("Id")), "at": stamp}, "snowChecked": True,
        "acceptedSeenAt": stamp, "lastModified": stamp,
    })


def _number(s):
    return str(s or "").strip().lstrip("#").strip()


def _job_numbered(hits, jobs):
    """The one job here an estimate number names: the only one carrying it,
    or else the only bid among them (an old finished job can share a number
    typed years ago). None when that still leaves several, or none."""
    if len(hits) == 1:
        return hits[0]
    bids = [jid for jid in hits if (jobs[jid].get("jobStatus") or "quoting") == "quoting"]
    return bids[0] if len(bids) == 1 else None


def _lines_sig(e):
    """An estimate's lines as they read -- product, amount, words -- so two
    estimates can be told apart from a copy of one. Subtotals left out."""
    out = []
    for ln in e.get("Line") or []:
        if ln.get("DetailType") == "SubTotalLineDetail":
            continue
        item = ((ln.get("SalesItemLineDetail") or {}).get("ItemRef") or {}).get("value")
        out.append((ln.get("DetailType"), str(item or ""), round(_amount(ln.get("Amount")), 2),
                    " ".join(str(ln.get("Description") or "").split())))
    return out


def _copy_of(e, held):
    """The job (as [job id, estimate id, total, estimate, its number]) already
    holding an estimate for this customer with the same total and the same
    lines, or None. Only open jobs are in `held`: the same snow contract
    accepted again next season, after last year's job is finished, is new
    work. The other estimate is read from QuickBooks only when the totals
    match, which is rare."""
    total = round(_amount(e.get("TotalAmt")), 2)
    sig = None
    for row in held:
        if row[1] == str(e.get("Id")) or round(_amount(row[2]), 2) != total:
            continue
        other = row[3]
        if other is None:
            try:
                other = _query_one("Estimate", "Id = '%s'" % _quote(row[1]))
            except ReconnectNeeded:
                raise
            except Exception as err:                    # noqa: BLE001
                print("quickbooks import: estimate %s not read: %s" % (row[1], err))
                continue
            if not other:
                continue
            row[3] = other
        if sig is None:
            sig = _lines_sig(e)
        if sig and _lines_sig(other) == sig:
            return row[:4] + [other.get("DocNumber")]
    return None


# ----------------------------------------------- snow contracts in
#
# Jonah (15 Oct 2026): "the imports should be input into the snow route
# automatically when pulled". A snow estimate -- every line a snow removal,
# salt or labour product -- is a season's contract, not a job: it becomes a
# Snow account (snow.js: the crew-readable record + private/rates), which the
# route takes up by itself (storm.js buildRoute puts an account missing from
# the hand-set order after the last one). One he already has -- the same
# name, or the same house number and street -- is joined to the estimate and
# left priced as he set it (he folds salt and add-ons into each visit's
# price). He tags snow estimates "snow" in QuickBooks, but Intuit's API
# gives no tags (Oct 2026), so the products on it say what it is.
SNOW_ITEM = re.compile(r"snow", re.I)
SALT_ITEM = re.compile(r"\bsalt", re.I)
LABOR_ITEM = re.compile(r"\blabou?r\b", re.I)
SNOW_TIER = re.compile(r"(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(?:in(?:ch(?:es)?)?\b|\"|”)?\s*(?:→|->|:|=)?\s*\$\s*([\d,]+(?:\.\d+)?)", re.I)
SNOW_PER_INCH = re.compile(r"(?:each|every|per)\s+(?:additional\s+)?inch[^$\n]*?(?:beyond|past|over|above)\s*(\d+(?:\.\d+)?)[^$\n]*?\$\s*([\d,]+(?:\.\d+)?)", re.I)
SNOW_HOURLY = re.compile(r"\$\s*([\d,]+(?:\.\d+)?)\s*/\s*(?:man[- ]?)?h(?:ou)?r", re.I)
SNOW_BOILER = re.compile(r"^(priced per|\(for storms|\(during extended|\*price per|price is subject|estimated total)", re.I)


def _snow_lines(e, end_names):
    """A snow estimate's product lines (the terms left out) as (short name,
    full name, line) -- or None when any line is not snow work."""
    out = []
    for ln in _flat_lines(e.get("Line")):
        if ln.get("DetailType") != "SalesItemLineDetail":
            continue
        item = str(((ln.get("SalesItemLineDetail") or {}).get("ItemRef") or {}).get("name") or "").strip()
        short = item.split(":")[-1].strip()
        if _norm_name(short) in end_names or _norm_name(item) in end_names:
            continue
        out.append((short, item, ln))
    plows = [x for x in out if SNOW_ITEM.search(x[1]) and not SALT_ITEM.search(x[0])]
    if not plows or not all(SNOW_ITEM.search(i) or SALT_ITEM.search(i) or LABOR_ITEM.search(i) for _, i, _ in out):
        return None
    return out


def _dollars_cents(s):
    try:
        return int(round(float(str(s).replace(",", "")) * 100))
    except ValueError:
        return None


def _snow_terms(lines):
    """The account's price per visit (snow.js pricing: tiers 1-3 / 4-6 / 6+ /
    9+, or 1-3 plus so much an inch above), its hourly labour, the extras
    priced on their own (salt per application, a deck per visit), and the
    words the crew may read -- none of them with a price in."""
    tiers, per_inch, labor, extras, words, salt = {}, None, None, [], [], False
    main = next((x for x in lines if SNOW_ITEM.search(x[1]) and not SALT_ITEM.search(x[0]) and SNOW_TIER.search(str(x[2].get("Description") or ""))), None) \
        or next(x for x in lines if SNOW_ITEM.search(x[1]) and not SALT_ITEM.search(x[0]))
    for short, item, ln in lines:
        desc = str(ln.get("Description") or "")
        cents = _cents(ln.get("Amount"))
        if LABOR_ITEM.search(item) and not SNOW_ITEM.search(item):
            m = SNOW_HOURLY.search(desc)
            labor = _dollars_cents(m.group(1)) if m else labor
            continue
        if SALT_ITEM.search(short):
            salt = True
            extras.append({"name": "Salt" + (" — paw-friendly" if re.search(r"paw", desc, re.I) else ""),
                           "cents": cents, "per": "application"})
            continue
        if ln is not main[2]:
            extras.append({"name": short, "cents": cents, "per": "visit",
                           "note": " ".join(s.strip() for s in desc.splitlines() if s.strip() and "$" not in s and not SNOW_BOILER.match(s.strip()))[:200]})
            continue
        for lo, hi, dollars in SNOW_TIER.findall(desc):
            top = float(hi)
            label = "1-3" if top <= 3 else "4-6" if top <= 6 else "6+" if top <= 9 else "9+"
            tiers.setdefault(label, _dollars_cents(dollars))
        m = SNOW_PER_INCH.search(desc)
        if m:
            per_inch = {"cents": _dollars_cents(m.group(2)) or 0, "aboveInches": float(m.group(1))}
        if "1-3" not in tiers:
            tiers["1-3"] = cents
        words += [s.strip() for s in desc.splitlines() if s.strip() and "$" not in s and not SNOW_BOILER.match(s.strip())]
    # A tier with no price of its own takes the one below (snow.js resolveTier).
    below = {"1-3": None, "4-6": "1-3", "6+": "4-6", "9+": "6+"}
    priced = {k: ({"mode": "flat", "cents": tiers[k]} if tiers.get(k) is not None else {"mode": "inherit", "from": below[k], "cents": None})
              for k in below}
    pricing = {"mode": "tieredPlusPerInch" if per_inch else "tiered", "tiers": priced, "perInch": per_inch,
               "salt": {"included": False, "portionCents": 0, "perBagCents": None}}
    if extras:
        words.append("Also: " + ", ".join(x["name"] for x in extras))
    return pricing, labor, extras, " · ".join(words)[:400], salt


def _street_key(s):
    """House number and street name, for telling one address from another
    however it was typed ("12 Oak Rd" / "12 oak road, Middleton")."""
    words = re.sub(r"[^a-z0-9 ]+", " ", str(s or "").lower().split(",")[0]).split()
    return " ".join(words[:2]) if words and any(ch.isdigit() for ch in words[0]) else ""


def _snow_season(now):
    y = now.year if now.month >= 7 else now.year - 1
    return "%d-%s" % (y, str(y + 1)[2:])


def snow_account(e, cust, end_names, stamp):
    """A snow estimate -> its Snow account: the one he has for this customer,
    joined to the estimate, or a new one priced from it. Returns
    (account id, made) or None when the estimate is not snow work."""
    lines = _snow_lines(e, end_names)
    if not lines:
        return None
    db = _db()
    cust = cust or {}
    name = (cust.get("DisplayName") or (e.get("CustomerRef") or {}).get("name") or "").strip() or "Snow customer"
    parts = _best_addr(e, cust, name)
    accounts = {s.id: (s.to_dict() or {}) for s in db.collection("snowAccounts").stream()}
    key = _street_key(parts["address"])
    have = next((aid for aid, a in accounts.items() if _norm_name(a.get("name")) == _norm_name(name)), None) or \
        next((aid for aid, a in accounts.items() if key and _street_key(a.get("street") or a.get("address")) == key), None)
    ref = {"estimateId": str(e.get("Id")), "docNumber": str(e.get("DocNumber") or ""), "at": stamp}
    if have:
        db.collection("snowAccounts").document(have).collection("private").document("rates").set({"fromQb": ref}, merge=True)
        return have, False
    pricing, labor, extras, notes, salt = _snow_terms(lines)
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "account"
    aid, n = base, 2
    while aid in accounts:
        aid, n = "%s-%d" % (base, n), n + 1
    geo_hit = None
    try:
        import geo
        geo_hit = geo.find(parts["address"], parts["city"], parts["state"] or "WI", parts["zip"])
    except Exception as err:                            # noqa: BLE001 -- the owner's device looks it up again (snow.js locateMissing)
        print("quickbooks snow: %s not found on the map: %s" % (aid, err))
    one_line = ", ".join(s for s in (parts["address"], parts["city"], " ".join(s for s in (parts["state"], parts["zip"]) if s)) if s)
    item_names = " ".join(i for _, i, _ in lines)
    pub = {
        "name": name, "firstName": str(cust.get("GivenName") or ""), "lastName": str(cust.get("FamilyName") or ""),
        "business": str(cust.get("CompanyName") or ""),
        "address": one_line, "street": parts["address"], "city": parts["city"], "state": parts["state"], "zip": parts["zip"],
        "town": (geo_hit or {}).get("town") or parts["city"],
        "lat": (geo_hit or {}).get("lat"), "lng": (geo_hit or {}).get("lng"), "geocodedAs": (geo_hit or {}).get("matched"),
        "type": "commercial" if re.search(r"commercial", item_names, re.I) else "residential",
        "active": True, "season": _snow_season(_now()), "minTriggerInches": 1, "serviceWindow": "standard",
        "areaNotes": notes, "vacationHolds": [], "driveSqFt": None, "walkSqFt": None, "saltApplies": salt,
        "fromQuickBooks": {"estimateId": str(e.get("Id")), "docNumber": str(e.get("DocNumber") or "")},
    }
    priv = {
        "phone": str(((cust.get("PrimaryPhone") or cust.get("Mobile") or {}).get("FreeFormNumber")) or ""),
        "email": str(((e.get("BillEmail") or cust.get("PrimaryEmailAddr") or {}).get("Address")) or ""),
        "laborRateCents": labor, "pricing": pricing, "extras": extras, "fromQb": ref,
    }
    batch = db.batch()
    batch.set(db.collection("snowAccounts").document(aid), pub)
    batch.set(db.collection("snowAccounts").document(aid).collection("private").document("rates"), priv)
    batch.commit()
    return aid, True


SNOW_JOBS_MAX = 10


def snow_from_jobs(jobs):
    """Snow contracts brought in as jobs before they went to the Snow route:
    each joined to (or made into) its Snow account, and the job marked to be
    taken off (removeWhy 'snow') -- the owner deletes it from My Jobs."""
    env = _env("QB_ENV", "sandbox")
    if env != "production":
        return 0
    want = {jid: str(j["qbEstimate"]["id"]) for jid, j in jobs.items()
            if j.get("fromQuickBooks") and not j.get("removeWhy") and (j.get("qbEstimate") or {}).get("id")
            and (j.get("qbEstimate") or {}).get("env") == env and not j.get("snowChecked")}
    want = dict(list(want.items())[:SNOW_JOBS_MAX])
    if not want:
        return 0
    estimates = _by_ids("Estimate", set(want.values()))
    end_names = _end_names()
    db = _db()
    done = 0
    for jid, eid in want.items():
        e = estimates.get(eid)
        if not e:
            continue
        stamp = _stamp()
        cust = None
        cid = (e.get("CustomerRef") or {}).get("value")
        if cid:
            try:
                cust = _query_one("Customer", "Id = '%s'" % _quote(cid))
            except ReconnectNeeded:
                raise
            except Exception as err:                    # noqa: BLE001
                print("quickbooks snow: customer %s not read: %s" % (cid, err))
        got = snow_account(e, cust, end_names, stamp)
        patch = {"snowChecked": True, "lastModified": stamp}
        if got:
            patch.update({"removeWhy": "snow", "replacedBy": "snow:" + got[0],
                          "removeNote": "Snow contract — on the Snow route" + ("" if got[1] else " (you already had it there)")})
            done += 1
        db.collection("jobs").document(jid).set(patch, merge=True)
    return done


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
    lookback = _now() - datetime.timedelta(days=IMPORT_LOOKBACK_DAYS)
    since = state.get("since") or _qb_time(lookback)
    accepted_from = str(state.get("acceptedFrom") or lookback.date().isoformat())
    seen = dict(state.get("seen") or {})          # estimate id -> job id ("" = not brought in)
    tries = dict(state.get("tries") or {})        # estimate id -> failed tries at making its job

    asked_from = (_parse_time(since) or lookback) - IMPORT_OVERLAP
    rows = _query("Estimate", "MetaData.LastUpdatedTime > '%s' orderby MetaData.LastUpdatedTime maxresults 200"
                  % _quote(_qb_time(asked_from)))
    by_est = {str((j.get("qbEstimate") or {}).get("id")): jid for jid, j in jobs.items()
              if (j.get("qbEstimate") or {}).get("id") and (j.get("qbEstimate") or {}).get("env") == env}
    by_num = {}                                   # estimate number -> [job ids]
    by_cust = {}                                  # QuickBooks customer id -> [[job id, estimate id, total, estimate]]
    for jid, j in jobs.items():
        n = _number(j.get("estimateNumber"))
        if n:
            by_num.setdefault(n, []).append(jid)
        q = j.get("qbEstimate") or {}
        if q.get("id") and q.get("customerId") and q.get("env") == env and j.get("jobStatus") != "complete":
            by_cust.setdefault(str(q["customerId"]), []).append([jid, str(q["id"]), q.get("total"), None])
    news = []
    newest = _parse_time(since)
    hold = None             # the first estimate whose job could not be made: looked at again next time
    end_names = None        # the terms products, read once if anything is brought in
    for e in rows:
        t = _parse_time((e.get("MetaData") or {}).get("LastUpdatedTime"))
        if t and (not newest or t > newest):
            newest = t
        eid = str(e.get("Id") or "")
        if not eid or eid in seen or not _accepted(e):
            continue
        note = str(e.get("PrivateNote") or "").strip()
        if note.startswith(_job_note("")):           # made in Job Hub: the sweep has it
            seen[eid] = note[len(_job_note("")):].strip()
            continue
        if eid in by_est:
            seen[eid] = by_est[eid]
            continue
        if str(e.get("AcceptedDate") or "")[:10] and str(e["AcceptedDate"])[:10] < accepted_from:
            continue                                # accepted before Job Hub was looking
        stamp = _stamp()
        rec = _estimate_record(e)
        rec["linked"] = True
        # A snow contract goes on the Snow route, not the job list.
        if end_names is None:
            end_names = _end_names()
        if _snow_lines(e, end_names):
            cust = None
            cid = (e.get("CustomerRef") or {}).get("value")
            if cid:
                try:
                    cust = _query_one("Customer", "Id = '%s'" % _quote(cid))
                except ReconnectNeeded:
                    raise
                except Exception as err:                # noqa: BLE001
                    print("quickbooks import: customer %s not read: %s" % (cid, err))
            got = snow_account(e, cust, end_names, stamp)
            if got:
                seen[eid] = "snow:" + got[0]
                news.append({"jobId": "snow" + eid, "kind": "snowAdded" if got[1] else "snowLinked",
                             "name": str((e.get("CustomerRef") or {}).get("name") or "A customer"),
                             "docNumber": e.get("DocNumber"), "total": e.get("TotalAmt")})
                continue
        num = _number(e.get("DocNumber"))
        hits = (by_num.get(num) or []) if num else []
        if hits:
            jid = _job_numbered(hits, jobs)
            if jid is None:
                # Several jobs here carry the number and nothing says which:
                # neither linked to a guess nor made a second time -- told.
                seen[eid] = ""
                news.append({"jobId": "est" + eid, "kind": "notBrought", "why": "several", "count": len(hits),
                             "name": str((e.get("CustomerRef") or {}).get("name") or "A customer"),
                             "docNumber": e.get("DocNumber"), "total": e.get("TotalAmt")})
                continue
            # Already a job here, typed in by hand with this number: linked,
            # and booked by the owner's device if it is still a bid.
            if not ((jobs[jid].get("qbEstimate") or {}).get("id")):
                patch = {"qbEstimate": rec, "lastModified": stamp}
                if not jobs[jid].get("acceptedSeenAt"):
                    patch["acceptedSeenAt"] = stamp
                db.collection("jobs").document(jid).set(patch, merge=True)
                news.append({"jobId": jid, "kind": "linked", "name": str(jobs[jid].get("customerName") or "a customer"),
                             "docNumber": e.get("DocNumber"), "total": e.get("TotalAmt")})
            seen[eid] = jid
            continue
        # Already a job here for this customer, typed in by hand with no
        # number and not joined to any estimate (Oct 2026: three customers
        # got a second job this way): that one, when it is the only such job
        # and its price is this estimate's, or none yet.
        who = _norm_name((e.get("CustomerRef") or {}).get("name"))
        total = _amount(e.get("TotalAmt"))
        same = [jid for jid, j in jobs.items() if who and _norm_name(j.get("customerName")) == who
                and not (j.get("qbEstimate") or {}).get("id") and str(j.get("jobStatus") or "") != "complete" and not j.get("removeWhy")
                and (_job_price(j) is None or abs(_job_price(j) - total) < 0.005)]
        if len(same) == 1:
            jid = same[0]
            patch = {"qbEstimate": rec, "lastModified": stamp}
            if not jobs[jid].get("acceptedSeenAt"):
                patch["acceptedSeenAt"] = stamp
            if not str(jobs[jid].get("estimateNumber") or "").strip() and e.get("DocNumber"):
                patch["estimateNumber"] = str(e["DocNumber"])
            db.collection("jobs").document(jid).set(patch, merge=True)
            jobs[jid]["qbEstimate"] = rec
            news.append({"jobId": jid, "kind": "linked", "name": str(jobs[jid].get("customerName") or "a customer"),
                         "docNumber": e.get("DocNumber"), "total": e.get("TotalAmt")})
            seen[eid] = jid
            continue
        cid = (e.get("CustomerRef") or {}).get("value")
        # The same estimate made again under a new number (copied and
        # re-sent, then accepted again: two jobs were made from one, Oct
        # 2026) is the same job, not a second one.
        twin = _copy_of(e, by_cust.get(str(cid)) or []) if cid else None
        if twin:
            seen[eid] = twin[0]
            # Sent again only to be e-signed (Jonah, 15 Oct 2026: "i sent him
            # a second estimate in quickbooks so i could get an e-signature"):
            # the copy said yes to last is the job's estimate from now on --
            # its number on the job, its status the one checked.
            held = jobs.get(twin[0]) or {}
            if _accepted(e) and (held.get("qbEstimate") or {}).get("linked"):
                patch = {"qbEstimate": rec, "estimateNumber": str(e.get("DocNumber") or ""), "lastModified": stamp}
                if held.get("qbFilled"):
                    patch["qbFilled"] = {"estimateId": eid, "at": stamp}
                    patch["estimate"] = {"fromQb": {"estimateId": eid, "docNumber": str(e.get("DocNumber") or ""),
                                                    "acceptedDate": str(e.get("AcceptedDate") or "")}}
                db.collection("jobs").document(twin[0]).set(patch, merge=True)
                held["qbEstimate"] = rec
            news.append({"jobId": twin[0], "kind": "copy", "name": str((e.get("CustomerRef") or {}).get("name") or "A customer"),
                         "docNumber": e.get("DocNumber"), "total": e.get("TotalAmt"), "sameAs": twin[4]})
            continue
        cust = None
        if cid:
            try:
                cust = _query_one("Customer", "Id = '%s'" % _quote(cid))
            except ReconnectNeeded:
                raise
            except Exception as err:                    # noqa: BLE001
                print("quickbooks import: customer %s not read: %s" % (cid, err))
        if end_names is None:
            end_names = _end_names()
        job = _job_from_estimate(e, cust, stamp, end_names)
        # One id per estimate: two sweeps at once make one job, not two.
        jid = "qb" + re.sub(r"[^A-Za-z0-9]", "", eid)
        try:
            db.collection("jobs").document(jid).create(job)
        except AlreadyExists:
            # A sweep at the same moment made it.
            seen[eid] = jid
            continue
        except Exception as err:                        # noqa: BLE001
            # Not made: tried again next hour (the look starts no later
            # than this estimate), and the owner told after the last try.
            n = int(tries.get(eid) or 0) + 1
            print("quickbooks import: job %s not made, try %d (%s)" % (jid, n, err))
            if n < IMPORT_MAX_TRIES:
                tries[eid] = n
                if t and (hold is None or t < hold):
                    hold = t
            else:
                seen[eid] = ""
                news.append({"jobId": jid, "kind": "notBrought", "why": "failed", "name": job["customerName"],
                             "docNumber": e.get("DocNumber"), "total": e.get("TotalAmt")})
            continue
        # On the crew's clock too (sync.js boardEntry).
        db.collection("jobBoard").document(jid).set({
            "name": job["customerName"], "status": "booked", "what": _what(job["estimate"]),
            "address": ", ".join(s for s in (job["address"], job["city"], job["state"]) if s),
            "updatedAt": stamp})
        seen[eid] = jid
        if num:
            by_num.setdefault(num, []).append(jid)
        if cid:
            by_cust.setdefault(str(cid), []).append([jid, eid, e.get("TotalAmt"), e])
        news.append({"jobId": jid, "kind": "imported", "name": job["customerName"],
                     "docNumber": e.get("DocNumber"), "total": e.get("TotalAmt")})
    end = newest if hold is None or (newest and newest < hold) else hold
    ref.set({realm: {"since": _qb_time(end) if end else since, "seen": seen, "tries": tries,
                     "acceptedFrom": accepted_from, "at": _now().isoformat()}}, merge=True)
    return news


LOOK_AGAIN = datetime.timedelta(days=1)   # a job typed in by hand is looked for in QuickBooks once a day
HAND_MAX = 10                             # and so many in one sweep


def _norm_name(s):
    return " ".join(str(s or "").lower().split())


def _job_price(j):
    try:
        return round(float(str(j.get("jobPrice") or "").replace(",", "").replace("$", "").strip()), 2)
    except ValueError:
        return None


def _sold(e):
    """The customer said yes to it, however QuickBooks shows that: accepted,
    or made into an invoice (Converted -- an estimate Jonah invoiced himself
    is never marked accepted, Oct 2026)."""
    status = (e or {}).get("TxnStatus") or ""
    return _accepted(e) or status == "Converted" or (status == "Closed" and any(
        (t or {}).get("TxnType") == "Invoice" for t in (e or {}).get("LinkedTxn") or []))


def link_hand_jobs(jobs):
    """Jobs typed in by hand -- booked or under way -- with no QuickBooks
    estimate joined to them (Jonah, 15 Oct 2026: one such job had only its
    price; it was typed in before the import, and its estimate was
    invoiced in QuickBooks without ever being marked accepted, so nothing
    brought it in). Each is looked for once a day: the customer of exactly
    the same name, and of their estimates not already on a job, the one the
    job names by number -- or else the one they said yes to for exactly the
    job's price. Anything less certain is left alone. Joined as an import
    is (linked), with its invoice; fill_imported then reads it in full."""
    env = _env("QB_ENV", "sandbox")
    if env != "production":
        return 0
    now = _now()
    realm = (_load_tokens() or {}).get("realmId") or "none"
    db = _db()
    ref = db.collection("integrations").document("quickbooksImport")
    snap = ref.get()
    state = (((snap.to_dict() or {}) if snap.exists else {}).get(realm)) or {}
    looked = {k: v for k, v in (state.get("looked") or {}).items()
              if k in jobs and (_parse_time(v) or now) > now - datetime.timedelta(days=30)}
    used = {str((j.get("qbEstimate") or {}).get("id")) for j in jobs.values()
            if (j.get("qbEstimate") or {}).get("id") and (j.get("qbEstimate") or {}).get("env") == env}
    want = []
    for jid, j in jobs.items():
        if (j.get("qbEstimate") or {}).get("id") or j.get("removeWhy") \
                or str(j.get("jobStatus") or "") not in ("booked", "inprogress", "active"):
            continue
        t = _parse_time(looked.get(jid))
        if (t and now - t < LOOK_AGAIN) or not _norm_name(j.get("customerName")):
            continue
        want.append(jid)
        if len(want) >= HAND_MAX:
            break
    done = 0
    for jid in want:
        j = jobs[jid]
        looked[jid] = now.isoformat()
        cust = _query_one("Customer", "DisplayName = '%s'" % _quote(" ".join(str(j["customerName"]).split())))
        if not cust or _norm_name(cust.get("DisplayName")) != _norm_name(j.get("customerName")):
            continue
        theirs = _query("Estimate", "CustomerRef = '%s'" % _quote(cust["Id"]))
        # Not one already on a job -- nor a copy of one that is (the same
        # estimate sent again to be e-signed): that work has its job.
        held = [_lines_sig(x) + [round(_amount(x.get("TotalAmt")), 2)] for x in theirs if str(x.get("Id")) in used]
        pool = [x for x in theirs if str(x.get("Id")) not in used
                and _lines_sig(x) + [round(_amount(x.get("TotalAmt")), 2)] not in held]
        nums = set(re.findall(r"\d{3,7}", str(j.get("estimateNumber") or "")))
        pick = [e for e in pool if _number(e.get("DocNumber")) in nums]
        if len(pick) != 1:
            price = _job_price(j)
            pick = [e for e in pool if _sold(e) and price is not None and abs(_amount(e.get("TotalAmt")) - price) < 0.005]
        if len(pick) != 1:
            continue
        e = pick[0]
        stamp = _stamp()
        rec = _estimate_record(e, cust["Id"])
        rec["linked"] = True
        patch = {"qbEstimate": rec, "lastModified": stamp}
        if not str(j.get("estimateNumber") or "").strip() and e.get("DocNumber"):
            patch["estimateNumber"] = str(e["DocNumber"])
        # Its invoice too, so what is still owed shows on the job.
        inv_id = next((str(t.get("TxnId")) for t in e.get("LinkedTxn") or [] if (t or {}).get("TxnType") == "Invoice"), None)
        if inv_id and not (j.get("qbInvoiceRef") or {}).get("id"):
            try:
                inv = _query_one("Invoice", "Id = '%s'" % _quote(inv_id))
                if inv:
                    patch["qbInvoiceRef"] = _invoice_record(inv)
            except ReconnectNeeded:
                raise
            except Exception as err:                    # noqa: BLE001 -- the estimate is joined all the same
                print("quickbooks link: invoice %s not read: %s" % (inv_id, err))
        db.collection("jobs").document(jid).set(patch, merge=True)
        j["qbEstimate"] = rec           # so fill_imported reads it in this same sweep
        used.add(str(e.get("Id")))
        done += 1
    ref.set({realm: {"looked": looked}}, merge=True)
    return done


def copy_invoices(jobs):
    """A job whose estimate was sent a second time only to be e-signed: the
    first copy is often the one the deposit invoice was made from (Oct 2026),
    so the job takes that invoice -- what is still owed shows on it, and the
    hourly look follows its payments. Looked for once a day per job with no
    invoice; only a single copy with the same lines and total counts."""
    env = _env("QB_ENV", "sandbox")
    if env != "production":
        return 0
    now = _now()
    realm = (_load_tokens() or {}).get("realmId") or "none"
    db = _db()
    ref = db.collection("integrations").document("quickbooksImport")
    snap = ref.get()
    state = (((snap.to_dict() or {}) if snap.exists else {}).get(realm)) or {}
    looked = {k: v for k, v in (state.get("invLooked") or {}).items() if k in jobs}
    want = []
    for jid, j in jobs.items():
        q = j.get("qbEstimate") or {}
        if not (q.get("linked") and q.get("id") and q.get("env") == env) or (j.get("qbInvoiceRef") or {}).get("id") \
                or j.get("removeWhy") or str(j.get("jobStatus") or "") == "quoting":
            continue
        t = _parse_time(looked.get(jid))
        if t and now - t < LOOK_AGAIN:
            continue
        want.append(jid)
        if len(want) >= HAND_MAX:
            break
    done = 0
    for jid in want:
        looked[jid] = now.isoformat()
        q = jobs[jid]["qbEstimate"]
        mine = _query_one("Estimate", "Id = '%s'" % _quote(q["id"]))
        cid = (mine or {}).get("CustomerRef", {}).get("value")
        if not mine or not cid:
            continue
        sig = _lines_sig(mine) + [round(_amount(mine.get("TotalAmt")), 2)]
        copies = [x for x in _query("Estimate", "CustomerRef = '%s'" % _quote(cid))
                  if str(x.get("Id")) != str(q["id"]) and _lines_sig(x) + [round(_amount(x.get("TotalAmt")), 2)] == sig
                  and any((t or {}).get("TxnType") == "Invoice" for t in x.get("LinkedTxn") or [])]
        if len(copies) != 1:
            continue
        inv_id = next(str(t.get("TxnId")) for t in copies[0]["LinkedTxn"] if (t or {}).get("TxnType") == "Invoice")
        inv = _query_one("Invoice", "Id = '%s'" % _quote(inv_id))
        if not inv:
            continue
        stamp = _stamp()
        db.collection("jobs").document(jid).set({"qbInvoiceRef": _invoice_record(inv), "lastModified": stamp}, merge=True)
        done += 1
    ref.set({realm: {"invLooked": looked}}, merge=True)
    return done


FILL_MAX = 25               # jobs filled in one sweep


def _fill_from_invoices(db, want_inv, docs, end_names):
    """fill_imported's part for jobs tied to an invoice (see there): the
    estimate built from the invoice's lines when the job's own estimate is
    empty -- work he built in Job Hub is never replaced -- and the job marked
    looked at either way (qbFilled.invoiceId), so it is read once."""
    invoices = _by_ids("Invoice", set(want_inv.values()))
    done = 0
    for jid, iid in want_inv.items():
        j, inv = docs.get(jid), invoices.get(iid)
        if j is None or inv is None:
            continue                    # gone, or QuickBooks did not answer: next hour
        stamp = _stamp()
        patch = {"qbFilled": dict(j.get("qbFilled") or {}, invoiceId=iid, at=stamp), "lastModified": stamp}
        have = j.get("estimate") or {}
        if not (have.get("work") or have.get("materials")):
            est, words = _hub_estimate(inv, end_names, stamp)
            for k in ("notes", "chat", "questions", "flags", "sent", "site", "payments", "customerType"):
                if have.get(k):
                    est[k] = have[k]
            # Where it came from: the invoice, not an estimate.
            est["fromQb"] = {"invoiceId": iid, "docNumber": str(inv.get("DocNumber") or ""), "kind": "invoice",
                             "materialsCents": est["fromQb"]["materialsCents"], "taxCents": est["fromQb"]["taxCents"],
                             "totalCents": _cents(inv.get("TotalAmt")), "at": stamp}
            patch["estimate"] = est
            # Words in the invoice that are no line of work or material go
            # under the notes he already has (never over them).
            if words:
                head = "From QuickBooks invoice #%s:" % (inv.get("DocNumber") or iid)
                old = str(j.get("notes") or "").strip()
                if head not in old:
                    patch["notes"] = ((old + "\n\n") if old else "") + "\n".join([head] + words)
                    patch["notes"] = patch["notes"][:NOTES_MAX]
            if not str(j.get("crewWhat") or "").strip():
                board = db.collection("jobBoard").document(jid)
                if board.get().exists:
                    board.set({"what": _what(est), "updatedAt": stamp}, merge=True)
        db.collection("jobs").document(jid).set(patch, merge=True)
        done += 1
    return done


def fill_imported(jobs):
    """Jobs joined to an estimate made in QuickBooks before the import read
    estimates in full -- brought in with their lines only as notes, or typed
    in by hand and linked by number -- get the estimate itself (_hub_estimate),
    once. A job whose estimate already has lines keeps it: that is his work
    in Job Hub. Notes still exactly as the first import wrote them become the
    short ones; an address that was only the customer's name (a free-form
    QuickBooks address) is read again. qbFilled marks it done."""
    env = _env("QB_ENV", "sandbox")
    if env != "production":
        return 0
    want, want_inv = {}, {}
    for jid, j in jobs.items():
        q = j.get("qbEstimate") or {}
        if q.get("linked") and q.get("id") and q.get("env") == env and not j.get("removeWhy") and \
                str((j.get("qbFilled") or {}).get("estimateId") or "") != str(q["id"]):
            want[jid] = str(q["id"])
        # A job tied to its QuickBooks INVOICE but no estimate -- typed in by
        # hand, its two estimates made into one invoice there -- is filled
        # from the invoice: every
        # line of work with its description, and the materials (Jonah, 15 Oct
        # 2026: "nothing from the descriptions of his services is in there").
        r = j.get("qbInvoiceRef") or {}
        if not q.get("linked") and r.get("id") and r.get("env") == env and not j.get("removeWhy") and \
                str((j.get("qbFilled") or {}).get("invoiceId") or "") != str(r["id"]):
            want_inv[jid] = str(r["id"])
        if len(want) + len(want_inv) >= FILL_MAX:
            break
    if not want and not want_inv:
        return 0
    db = _db()
    refs = [db.collection("jobs").document(jid) for jid in list(want) + list(want_inv)]
    docs = {s.id: (s.to_dict() or {}) for s in db.get_all(refs) if s.exists}
    estimates = _by_ids("Estimate", set(want.values())) if want else {}
    end_names = _end_names()
    done = _fill_from_invoices(db, want_inv, docs, end_names) if want_inv else 0
    for jid, eid in want.items():
        j = docs.get(jid)
        e = estimates.get(eid)
        if j is None or e is None:
            continue                    # gone, or QuickBooks did not answer: next hour
        stamp = _stamp()
        patch = {"qbFilled": {"estimateId": eid, "at": stamp}, "lastModified": stamp}
        have = j.get("estimate") or {}
        if not (have.get("work") or have.get("materials")):
            est, words = _hub_estimate(e, end_names, stamp)
            # Anything already on the job's estimate (notes from the site
            # visit, a conversation) stays.
            for k in ("notes", "chat", "questions", "flags", "sent", "site", "payments", "customerType"):
                if have.get(k):
                    est[k] = have[k]
            patch["estimate"] = est
            if str(j.get("notes") or "") == _lines_as_notes(e):
                patch["notes"] = _hub_notes(e, words)
            # The price the import set, before tax, now follows the estimate
            # as on any job (the same figure); one he typed stays his.
            if j.get("fromQuickBooks") and str(j.get("jobPrice") or "") == "%.2f" % _amount(e.get("TotalAmt")):
                price = (_cents(e.get("TotalAmt")) - est["fromQb"]["taxCents"]) / 100
                patch.update({"jobPrice": "%.2f" % price, "manualJobPrice": False, "baseJobPrice": price})
        name = str(j.get("customerName") or "")
        street = " ".join(str(j.get("address") or "").split())
        if j.get("fromQuickBooks") and (not street or street.lower() == " ".join(name.lower().split())):
            cust = None
            cid = (e.get("CustomerRef") or {}).get("value")
            if cid:
                try:
                    cust = _query_one("Customer", "Id = '%s'" % _quote(cid))
                except ReconnectNeeded:
                    raise
                except Exception as err:                # noqa: BLE001 -- the estimate's own address is tried
                    print("quickbooks fill: customer %s not read: %s" % (cid, err))
            parts = _best_addr(e, cust, name)
            if parts["address"]:
                patch.update(parts)
        # The crew's clock list: the address read again, and what the job is.
        board_patch = {}
        if patch.get("address"):
            board_patch["address"] = ", ".join(s for s in (patch["address"], patch.get("city"), patch.get("state")) if s)
        if patch.get("estimate") and not str(j.get("crewWhat") or "").strip():
            board_patch["what"] = _what(patch["estimate"])
        if board_patch:
            board = db.collection("jobBoard").document(jid)
            if board.get().exists:
                board.set(dict(board_patch, updatedAt=stamp), merge=True)
        db.collection("jobs").document(jid).set(patch, merge=True)
        done += 1
    return done


# ------------------------------------------------ invoices and reminders
#
# Jonah (15 Oct 2026): "track invoices & when they were sent and when to send
# reminder invoices". Every unpaid invoice in QuickBooks -- made from a job
# here, a storm, or by hand there -- is kept in invoices/{QuickBooks id}: who,
# how much is still owed, its date and due date, every time it was emailed
# (QuickBooks keeps only the last, DeliveryInfo; each one seen is added), and
# whether the customer has opened it. When a reminder is due is the app's to
# work out from settings/invoiceReminders (invoices.js, digest.py), and a
# reminder is the invoice emailed again from QuickBooks (/qb/invoice-remind),
# with its pay link, as QuickBooks' own reminders are. An invoice paid off
# stays a month (paidAt), then goes.
INVOICES_KEEP_PAID = datetime.timedelta(days=30)
EMAILS_KEEP = 20


def _open_invoices():
    """Every invoice with money still owed, in pages."""
    out, start = [], 1
    while True:
        rows = _query("Invoice", "Balance > '0' startposition %d maxresults 200" % start)
        out += rows
        if len(rows) < 200:
            return out
        start += 200


def _when(s):
    try:
        t = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=datetime.timezone.utc)


def _add_email(emails, sent):
    """`emails` with one more send -- unless it is one already there (the
    same send, timed by QuickBooks and by Job Hub a moment apart)."""
    t = _when(sent)
    if not sent or t is None:
        return emails
    for e in emails:
        u = _when(e)
        if u is not None and abs((u - t).total_seconds()) < 900:
            return emails
    return sorted(emails + [sent], key=lambda e: _when(e) or t)[-EMAILS_KEEP:]


def _inv_doc(inv, have, job_id, job_by=None):
    """What invoices/{id} keeps of a QuickBooks invoice. `have`: what it kept
    before -- the times it was emailed are added to, never lost. A job picked
    by hand (invoices.js) is kept whatever the sweep would have said."""
    env = _env("QB_ENV", "sandbox")
    emails = _add_email(list(have.get("emails") or []),
                        ((inv.get("DeliveryInfo") or {}).get("DeliveryTime")) or "")
    bal, total = _amount(inv.get("Balance")), _amount(inv.get("TotalAmt"))
    rec = {
        "id": str(inv.get("Id")), "docNumber": str(inv.get("DocNumber") or ""),
        "customerId": str((inv.get("CustomerRef") or {}).get("value") or ""),
        "customerName": str((inv.get("CustomerRef") or {}).get("name") or "A customer"),
        "email": str(((inv.get("BillEmail") or {}).get("Address")) or ""),
        "total": total, "balance": bal, "open": bal > 0,
        "txnDate": str(inv.get("TxnDate") or ""), "dueDate": str(inv.get("DueDate") or ""),
        "emailStatus": str(inv.get("EmailStatus") or ""), "viewed": str(inv.get("EInvoiceStatus") or "") == "Viewed",
        "emails": emails, "env": env,
        "link": "%s/app/invoice?txnId=%s" % (QB_APP.get(env, QB_APP["sandbox"]), inv.get("Id")),
    }
    if have.get("jobBy") == "hand":
        rec["jobId"], rec["jobBy"] = have.get("jobId") or None, "hand"
    else:
        rec["jobId"], rec["jobBy"] = (job_id, job_by) if job_id else (None, None)
    if bal <= 0 and have.get("open", True):
        rec["paidAt"] = _now().isoformat()
    return rec


def _inv_changed(rec, have):
    keys = ("docNumber", "customerName", "email", "total", "balance", "open", "txnDate", "dueDate",
            "emailStatus", "viewed", "emails", "jobId", "jobBy", "payments")
    return any(rec.get(k) != have.get(k) for k in keys)


def _payment_ids(inv):
    return sorted(str(t.get("TxnId")) for t in inv.get("LinkedTxn") or []
                  if t.get("TxnType") == "Payment" and t.get("TxnId"))


def _payments_on(inv_id, pays, names=None):
    """[{id, date, amount, method}] -- each QuickBooks payment's part paid on
    this invoice, oldest first. When the deposit came in is what tells the
    bill for the rest from the first one (invoices.js stateOf)."""
    out = []
    for pid, p in pays.items():
        amt = sum(_amount(ln.get("Amount")) for ln in p.get("Line") or []
                  if any(str(t.get("TxnId")) == str(inv_id) and t.get("TxnType") == "Invoice"
                         for t in ln.get("LinkedTxn") or []))
        if amt > 0:
            out.append({"id": pid, "date": str(p.get("TxnDate") or ""), "amount": round(amt, 2),
                        "method": (names or {}).get(str((p.get("PaymentMethodRef") or {}).get("value") or ""), "")})
    return sorted(out, key=lambda x: (x["date"], x["id"]))


def _name_jobs(jobs, env):
    """Customer name -> the one job of that name, for an invoice no job holds
    (made by hand in QuickBooks, for a job typed in by hand here) -- booked,
    under way or finished (the bill for the rest is on a finished one). Two
    jobs of one name, as a customer back for more work has: neither -- a
    wrong guess is worse than none, and the job can be picked by hand. A job
    marked to take off (removeWhy) or already holding an invoice is never a
    candidate."""
    seen = {}
    for jid, j in jobs.items():
        ref = j.get("qbInvoiceRef") or {}
        if j.get("removeWhy") or (ref.get("id") and ref.get("env") == env):
            continue
        if str(j.get("jobStatus") or "") not in ("booked", "inprogress", "active", "complete"):
            continue
        key = _norm_name(j.get("customerName"))
        if key:
            seen.setdefault(key, []).append(jid)
    return {k: v[0] for k, v in seen.items() if len(v) == 1}


def sync_invoices(jobs):
    """The invoices list brought up to date with QuickBooks. Returns news of
    payments on invoices no job here holds (a job's own invoice is told by the
    sweep above, so a payment is never told twice)."""
    env = _env("QB_ENV", "sandbox")
    if env != "production":
        return []
    db = _db()
    col = db.collection("invoices")
    have = {s.id: (s.to_dict() or {}) for s in col.where("open", "==", True).stream()}
    # The job holding the invoice (its qbInvoiceRef) -- never one marked to
    # take off, which may hold a copy of the same invoice (a duplicate job).
    by_inv = {str((j.get("qbInvoiceRef") or {}).get("id")): jid for jid, j in jobs.items()
              if (j.get("qbInvoiceRef") or {}).get("id") and (j.get("qbInvoiceRef") or {}).get("env") == env
              and not j.get("removeWhy")}
    by_name = _name_jobs(jobs, env)
    news = []
    now_open = {str(i.get("Id")): i for i in _open_invoices()}
    # Open here, gone from the open list there: paid off (or deleted).
    gone = [i for i in have if i not in now_open]
    closed = _by_ids("Invoice", gone) if gone else {}
    olds = {}
    for inv_id in list(now_open) + gone:
        old = have.get(inv_id)
        if old is None:
            snap = col.document(inv_id).get()
            old = (snap.to_dict() or {}) if snap.exists else {}
        olds[inv_id] = old
    # The payments on each, asked for only when the list of them changed.
    want = {}
    for inv_id, inv in list(now_open.items()) + list(closed.items()):
        ids = _payment_ids(inv)
        if ids != sorted(str(p.get("id")) for p in olds[inv_id].get("payments") or []):
            want[inv_id] = ids
    pays = _by_ids("Payment", [i for ids in want.values() for i in ids]) if want else {}
    names = {}
    if pays:
        try:
            names = {str(m.get("Id")): str(m.get("Name") or "") for m in _query("PaymentMethod", "Active = true")}
        except ReconnectNeeded:
            raise
        except Exception as err:                        # noqa: BLE001 -- the payments without their method
            print("quickbooks invoices: payment methods not read:", err)
    batch, n = db.batch(), 0
    for inv_id in list(now_open) + gone:
        old = olds[inv_id]
        inv = now_open.get(inv_id) or closed.get(inv_id)
        if inv is None:                                 # deleted in QuickBooks
            batch.set(col.document(inv_id), {"open": False, "deletedAt": _now().isoformat()}, merge=True)
            n += 1
            continue
        if by_inv.get(inv_id):
            link = (by_inv[inv_id], "job")
        else:
            nj = by_name.get(_norm_name((inv.get("CustomerRef") or {}).get("name")))
            link = (nj, "name") if nj else (None, None)
        rec = _inv_doc(inv, old, *link)
        if inv_id in want:
            got = {i: pays[i] for i in want[inv_id] if i in pays}
            # A payment QuickBooks didn't answer for: keep what was known.
            rec["payments"] = (_payments_on(inv_id, got, names) if len(got) == len(want[inv_id])
                               else list(old.get("payments") or []))
        else:
            rec["payments"] = list(old.get("payments") or [])
        if not _inv_changed(rec, old):
            continue
        paid = round(_amount(old.get("balance")) - rec["balance"], 2) if old else 0
        if paid > 0 and not rec.get("jobId"):
            news.append({"jobId": "inv" + inv_id, "kind": "payment", "name": rec["customerName"], "paid": paid,
                         "balance": rec["balance"], "docNumber": rec["docNumber"]})
        rec["syncedAt"] = _now().isoformat()
        batch.set(col.document(inv_id), rec, merge=True)
        n += 1
        if n >= 400:
            batch.commit()
            batch, n = db.batch(), 0
    if n:
        batch.commit()
    # Paid a month ago: off the list.
    cutoff = (_now() - INVOICES_KEEP_PAID).isoformat()
    for s in col.where("open", "==", False).stream():
        if str((s.to_dict() or {}).get("paidAt") or (s.to_dict() or {}).get("deletedAt") or "") < cutoff:
            s.reference.delete()
    return news


def invoice_remind(body, who=""):
    """A reminder: the invoice emailed again from QuickBooks, with its pay
    link, to the address on it. Noted on invoices/{id}."""
    inv_id = str(body.get("id") or "").strip()
    if not inv_id:
        raise RuntimeError("Which invoice?")
    inv = _query_one("Invoice", "Id = '%s'" % _quote(inv_id))
    if not inv:
        raise RuntimeError("QuickBooks has no such invoice")
    if _amount(inv.get("Balance")) <= 0:
        raise RuntimeError("That invoice is paid")
    to = str(((inv.get("BillEmail") or {}).get("Address")) or "").strip()
    if not to:
        raise RuntimeError("The invoice has no email address in QuickBooks — add one there first")
    sent = _call("POST", "invoice/%s/send" % inv_id, params={"sendTo": to}, empty_body=True).get("Invoice") or inv
    ref = _db().collection("invoices").document(inv_id)
    snap = ref.get()
    old = (snap.to_dict() or {}) if snap.exists else {}
    rec = _inv_doc(sent, old, old.get("jobId"), old.get("jobBy"))
    rec["payments"] = list(old.get("payments") or [])
    stamp = _now().isoformat()
    # The send itself is an email, timed by QuickBooks when it says (then
    # this is the same one, and not added twice).
    rec["emails"] = _add_email(rec["emails"], stamp)
    rec["reminders"] = list(old.get("reminders") or []) + [{"at": stamp, "by": who, "to": to}]
    rec["syncedAt"] = stamp
    ref.set(rec, merge=True)
    return rec


# ------------------------------------------------ payments, both ways
#
# Jonah (15 Oct 2026): "can we set it up where logged payments in the job hub
# auto get logged in quickbooks or vice versa?" -- both ways, automatic. One
# payment is one record in each place, tied by its QuickBooks payment id
# (qbPaymentId on the job's payments list):
#   - a payment in QuickBooks (a card through QuickBooks Payments, a check he
#     entered there) is added to the job's payments here;
#   - a payment logged here on a job with a QuickBooks invoice goes on that
#     invoice, into Undeposited Funds -- so the bank feed MATCHES the deposit
#     to it instead of booking the check a second time as a sale (what had
#     happened to two checks by 15 Oct);
#   - before anything is made, a payment of the same amount within
#     MATCH_DAYS on the other side is taken to be the same one and tied to
#     it, never copied;
#   - one deleted in QuickBooks leaves the job's list too.
# Payments logged here before PAYMENTS_FROM were already entered in
# QuickBooks by hand: they are tied to theirs, never sent.
PAYMENTS_FROM = "2026-10-15T19:00:00.000Z"
MATCH_DAYS = 14
_METHOD_WORDS = [            # what is typed in a payment's notes -> QuickBooks' payment method
    (r"\bzelle\b", "Zelle"), (r"cash\s*app", "Cashapp"), (r"\bach\b|bank transfer|direct deposit", "ACH"),
    (r"\bcredit\b|\bcard\b|\bvisa\b|mastercard|\bamex\b|discover", "Credit Card"),
    (r"\bcheck\b|\bchk\b|\bcheque\b|#\s*\d", "Check"), (r"\bcash\b", "Cash"),
]


def _hub_amount(p):
    try:
        return round(float(str(p.get("amount") or 0).replace(",", "").replace("$", "").strip() or 0), 2)
    except ValueError:
        return 0.0


def _days_apart(a, b):
    try:
        return abs((datetime.date.fromisoformat(str(a)[:10]) - datetime.date.fromisoformat(str(b)[:10])).days)
    except ValueError:
        return 9999


def _method_of(p):
    """The payment method a payment logged here names: picked (method) or
    written in its notes ("check #1042", "Zelle")."""
    if p.get("method"):
        return str(p["method"])
    text = str(p.get("notes") or "").lower()
    for pat, name in _METHOD_WORDS:
        if re.search(pat, text):
            return name
    return ""


def _payment_setup():
    """{undeposited: account id, methods: {lower name: id}, names: {id: name}}."""
    accts = _query("Account", "AccountType = 'Other Current Asset'")
    und = next((str(a.get("Id")) for a in accts if a.get("AccountSubType") == "UndepositedFunds"), None)
    methods = _query("PaymentMethod", "Active = true")
    return {"undeposited": und,
            "methods": {str(m.get("Name") or "").lower(): str(m.get("Id")) for m in methods},
            "names": {str(m.get("Id")): str(m.get("Name") or "") for m in methods}}


def sync_payments(jobs, only=None):
    """Each job's payments here and its invoice's payments in QuickBooks
    brought into one list (see above). `only`: one job id (the app asking
    right after a payment was logged). Returns how many jobs changed."""
    env = _env("QB_ENV", "sandbox")
    if env != "production":
        return 0
    db = _db()
    by_job = {}
    for s in db.collection("invoices").stream():
        inv = dict(s.to_dict() or {}, id=s.id)
        if inv.get("jobId") and not inv.get("deletedAt"):
            by_job.setdefault(inv["jobId"], []).append(inv)
    setup = None
    today = _now().astimezone(datetime.timezone(datetime.timedelta(hours=-5))).date().isoformat()
    changed_jobs = 0
    for jid, j in jobs.items():
        if (only and jid != only) or j.get("removeWhy"):
            continue
        mine = by_job.get(jid) or []
        pays = [dict(p) for p in j.get("payments") or [] if isinstance(p, dict)]
        wants_push = [p for p in pays if not p.get("qbPaymentId") and not p.get("fromQb")
                      and str(p.get("createdAt") or "") >= PAYMENTS_FROM and _hub_amount(p) > 0]
        if not mine and not wants_push:
            continue
        before = json.dumps(pays, sort_keys=True)
        qb_pays = sorted((dict(p, invoiceId=inv["id"]) for inv in mine for p in inv.get("payments") or []),
                         key=lambda x: (x.get("date") or "", x.get("id") or ""))
        linked = {str(p["qbPaymentId"]) for p in pays if p.get("qbPaymentId")}
        # QuickBooks -> here: tied to the same payment logged here, else added.
        for qp in qb_pays:
            if str(qp["id"]) in linked:
                continue
            # Within a dollar: the same payment typed with or without its cents.
            same = next((p for p in pays if not p.get("qbPaymentId") and abs(_hub_amount(p) - qp["amount"]) < 1
                         and _days_apart(p.get("date"), qp.get("date")) <= MATCH_DAYS), None)
            if same:
                same["qbPaymentId"] = str(qp["id"])
                same.pop("qbError", None)
            else:
                # Its label as he would write it: the one that paid it off is
                # the final payment, the first of several the deposit.
                inv = next(i for i in mine if i["id"] == qp["invoiceId"])
                earlier = any(str(p.get("date") or "") < str(qp.get("date") or "") for p in pays if _hub_amount(p) > 0)
                label = ("Final" if qp is qb_pays[-1] and _amount(inv.get("balance")) <= 0
                         else "Payment" if earlier else "Deposit")
                pays.append({"id": "qb" + str(qp["id"]), "date": qp.get("date") or "", "amount": "%.2f" % qp["amount"],
                             "label": label, "notes": qp.get("method") or "", "qbPaymentId": str(qp["id"]), "fromQb": True})
            linked.add(str(qp["id"]))
        # Gone from QuickBooks (deleted there): gone from here -- asked of
        # QuickBooks itself first, never guessed from a list that may be short.
        ours = {str(p["id"]) for p in qb_pays}
        missing = [str(p["qbPaymentId"]) for p in pays if p.get("qbPaymentId") and str(p["qbPaymentId"]) not in ours]
        if missing and mine:
            try:
                still = {str(r.get("Id")) for r in _query("Payment", "Id in (%s)" % ", ".join("'%s'" % _quote(i) for i in missing))}
                pays = [p for p in pays if not (p.get("qbPaymentId") and str(p["qbPaymentId"]) in missing
                                                and str(p["qbPaymentId"]) not in still)]
            except ReconnectNeeded:
                raise
            except Exception as err:                    # noqa: BLE001 -- kept until QuickBooks answers
                print("quickbooks payments: could not check %s: %s" % (missing, err))
        # Here -> QuickBooks.
        open_inv = next((i for i in mine if i.get("open") and _amount(i.get("balance")) > 0), None)
        left = _amount(open_inv.get("balance")) if open_inv else 0.0
        for p in pays:
            if p.get("qbPaymentId") or p.get("fromQb") or str(p.get("createdAt") or "") < PAYMENTS_FROM:
                continue
            amt = _hub_amount(p)
            if amt <= 0:
                continue
            if not open_inv:
                p["qbError"] = "No QuickBooks invoice with money owing on this job yet"
                continue
            if amt > left + 0.005:
                p["qbError"] = "More than the invoice's balance ($%.2f) — not sent" % left
                continue
            if setup is None:
                setup = _payment_setup()
            method = _method_of(p)
            body = {
                "CustomerRef": {"value": open_inv.get("customerId")},
                "TotalAmt": amt,
                "TxnDate": min(str(p.get("date") or today)[:10], today),
                "PrivateNote": ("Logged in Job Hub: %s %s" % (p.get("label") or "", p.get("notes") or "")).strip()[:4000],
                "Line": [{"Amount": amt, "LinkedTxn": [{"TxnId": open_inv["id"], "TxnType": "Invoice"}]}],
            }
            if setup.get("undeposited"):
                body["DepositToAccountRef"] = {"value": setup["undeposited"]}
            if method and setup["methods"].get(method.lower()):
                body["PaymentMethodRef"] = {"value": setup["methods"][method.lower()]}
            try:
                made = _call("POST", "payment", body=body, request_id="pay|%s|%s" % (jid, p.get("id"))).get("Payment") or {}
            except ReconnectNeeded:
                raise
            except Exception as err:                    # noqa: BLE001 -- told on the payment, tried again next hour
                p["qbError"] = "QuickBooks said no: %s" % str(err)[:200]
                continue
            p["qbPaymentId"] = str(made.get("Id"))
            p["qbSyncedAt"] = _now().isoformat()
            p.pop("qbError", None)
            left = round(left - amt, 2)
        if json.dumps(pays, sort_keys=True) != before:
            db.collection("jobs").document(jid).set({"payments": pays, "lastModified": _stamp()}, merge=True)
            changed_jobs += 1
    return changed_jobs


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
