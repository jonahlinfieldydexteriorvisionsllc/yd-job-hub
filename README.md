# YD Job Hub

Job tracking for **YD Exterior Visions LLC** — landscaping, hardscaping and snow
removal in the Madison, WI area.

A single-folder web app with no build step. Open `index.html` and it runs.
Installed on a phone it works with no signal, and syncs when the signal returns.

## What it does today

| Tab | |
|---|---|
| **Job** | Client details, service types, estimate and QuickBooks numbers, job price, WI sales tax, proposal import, materials-to-order checklist |
| **Tracking** | Hours per worker, every material purchase, change-order costs, payments received with running balance, and live profit figures |
| **All Jobs** | Every job in one sortable table with totals |
| **Materials** | Spend across all jobs, grouped into categories, filtered by period |

Signing in is Google-only and role-based: the owner sees everything, crew see
only their own hours, the snow route, and whatever calendars they are given.

## Files

```
index.html        markup only
styles.css        the whole palette lives in :root
app.js            the app -- a CLASSIC script, deliberately not a module
sync.js           two-way mirror between localStorage and Firestore
firebase-init.js  the only ES module: Firebase, sign-in, the access gate
config.js         Firebase web config (public by design -- see below)
firestore.rules   the actual access enforcement
sw.js             offline app shell
```

### Two things worth knowing before editing

**`app.js` must stay a classic script.** Every handler in `index.html` is an
inline `onclick` calling a global function. Making it a module would scope those
away and silently break every button on the page. All ESM imports are
quarantined in `firebase-init.js`, which hangs what the app needs on `window`.

**Bump `CACHE` in `sw.js` whenever a file changes**, or browsers keep serving
the old copy.

## Security

`config.js` is committed deliberately. The Firebase web config is public by
design — it ships in the JavaScript of every Firebase web app and anyone can
read it from a deployed site. Access is enforced by `firestore.rules` and the
authorized-domains list, not by hiding it.

Firestore grants access per *document*, never per field, so anything crew must
not see (pricing, client phone numbers) lives in a separate `private`
subcollection rather than as hidden fields.

Customer data is never committed. `.gitignore` excludes job backups and the
build plan, both of which name real clients.

## Setup

1. Copy `config.example.js` to `config.js` and fill in your Firebase config.
2. Paste `firestore.rules` into Firebase console → Firestore → Rules → Publish.
3. Add your site's hostname to Firebase → Authentication → Settings →
   Authorized domains.
4. Sign in with the address in `ownerEmail`; it bootstraps itself as owner.
