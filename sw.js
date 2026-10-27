// YD Job Hub service worker.
//
// Goal: the app opens and works with no signal. Job data itself is not this
// file's problem -- localStorage holds it today, and Firestore's own offline
// persistence will hold it after Phase 1. All this does is make sure the app
// shell (HTML, CSS, JS, icons, fonts) is on the phone before the signal drops.
//
// Bump CACHE whenever a shell file changes, or phones keep serving the old one.

const CACHE = 'ydjobhub-v333';

// Same-origin files the app cannot start without.
const SHELL = [
  './',
  './index.html',
  './privacy.html',
  './terms.html',
  './disconnected.html',
  './styles.css',
  './app.js',
  './stages.js',
  './changelog.js',
  './customers.js',
  './services.js',
  './addr.js',
  './config.js',
  './firebase-init.js',
  './sync.js',
  './jobline.js',
  './claude.js',
  './snow.js',
  './storm.js',
  './snowroute.js',
  './billing.js',
  './weather.js',
  './prospects.js',
  './timeclock.js',
  './problems.js',
  './quickbooks.js',
  './equipment.js',
  './remind.js',
  './recurring.js',
  './boards.js',
  './calendar.js',
  './worklog.js',
  './supplies.js',
  './supplymatch.js',
  './pricing.js',
  './estimate.js',
  './plantcare.js',
  './receipts.js',
  './subs.js',
  './invoices.js',
  './jobcosts.js',
  './paychecks.js',
  './notify.js',
  './crewnotes.js',
  './eod.js',
  './crewjobs.js',
  './workdone.js',
  './production.js',
  './markout.js',
  './jobphotos.js',
  './signatures.js',
  './jobissues.js',
  './forecast.js',
  './search.js',
  './home.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

// Never intercept these. Firebase and Firestore run their own offline layer and
// their own retry logic; a cache in front of them causes stale reads and writes
// that look like they succeeded but never left the phone.
// These are live API calls, not files. Caching them causes stale reads and
// writes that look successful but never left the phone.
//
// Note what is deliberately NOT here: www.gstatic.com (the Firebase SDK itself)
// and fonts.googleapis.com / fonts.gstatic.com. Those are static files and DO
// want caching -- a blanket 'googleapis.com' entry would have left the app
// unable to load Firebase or its fonts with no signal.
const BYPASS = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'firebaseremoteconfig.googleapis.com',
  'accounts.google.com',
  'apis.google.com',
  'firebaseio.com',
  'firebaseapp.com',
  // Forecasts. Cache-first meant the snowfall on screen was always the one
  // fetched LAST time -- possibly yesterday's -- labelled as just now.
  // weather.js keeps its own copy for when there is no signal.
  'api.weather.gov',
  'api.open-meteo.com',
  // The Cloud Run server: live answers only (QuickBooks, Claude).
  'run.app',
  // Job, receipt and calendar photos and files (Firebase Storage). Kept here
  // they stayed on a shared phone after the person who could see them signed
  // out; the browser's own cache still holds them for a while.
  'firebasestorage.googleapis.com',
  'storage.googleapis.com',
  // Address look-ups and road routes for the snow route (snow.js,
  // snowroute.js): live answers with customers' addresses in the address,
  // and snowroute.js keeps its own copy for a day.
  'nominatim.openstreetmap.org',
  'router.project-osrm.org',
];

// When the page itself last came from the saved copy because the network was
// too slow. For a few seconds after, the page's own code is served from the
// saved copies as well: an old page with new code behind it (or the reverse)
// is the mismatch that once left screens half-working.
let pageFromCacheAt = 0;
const MATCH_PAGE_MS = 15000;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll is all-or-nothing, so one bad path would leave the app with no
      // cache at all. Add individually and let stragglers fail on their own.
      //
      // cache:'reload' is load-bearing: without it these fetches go through the
      // browser's own HTTP cache, so a new worker can happily precache the OLD
      // copy of a file and serve it forever. Bumping CACHE alone does not save
      // you from that -- the bytes have to come from the network.
      .then(cache => Promise.all(
        SHELL.map(url =>
          cache.add(new Request(url, { cache: 'reload' })).catch(err => {
            console.warn('[sw] could not precache', url, err.message);
          })
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (BYPASS.some(host => url.hostname.endsWith(host))) return;

  // Navigations: always revalidate against the server so a deployed update is
  // picked up, but fall back to the cached shell so the app still opens in a
  // truck with no bars. Fetching by URL with cache:'no-cache' forces the
  // revalidation -- a plain fetch() would be answered from the HTTP cache.
  //
  // Raced against the same 4 seconds as the code below. With one bar of
  // signal the fetch neither answers nor fails, and waiting for it was a
  // white screen for 30-60 seconds before the saved page was even tried.
  // A fetch that loses the race still finishes in the background and saves
  // the new page for next time.
  if (req.mode === 'navigate') {
    let saving = null;
    const network = fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' })
      .then(res => {
        // Each page is kept under its own address. Storing every page as
        // index.html meant that opening the privacy page once made the app
        // open AS the privacy page the next time there was no signal.
        if (res && res.ok) {
          const copy = res.clone();
          saving = caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    const savedPage = () => caches.match(req, { ignoreSearch: true })
      .then(r => r || caches.match('./index.html'))
      .then(r => r || caches.match('./'))
      .catch(() => null);
    // Kept alive until a late page is saved, not just until one is shown.
    event.waitUntil(network.then(() => saving, () => {}));
    event.respondWith(new Promise(resolve => {
      let settled = false, networkFailed = false;
      const settle = r => { if (!settled) { settled = true; resolve(r); } };
      // No saved page (a first visit): the network is the only hope, so keep
      // waiting for it unless it has actually failed.
      const fromCache = () => savedPage().then(r => {
        if (r && !settled) { pageFromCacheAt = Date.now(); settle(r); }
        else if (networkFailed) settle(Response.error());
      });
      const timer = setTimeout(fromCache, 4000);
      network.then(res => {
        clearTimeout(timer);
        // A fresh page wants fresh code, whatever an earlier one had.
        if (!settled) pageFromCacheAt = 0;
        settle(res);
      }).catch(() => { clearTimeout(timer); networkFailed = true; fromCache(); });
    }));
    return;
  }

  // The app's own code and styles: fresh from the network whenever there is
  // signal, the saved copy only when there is not (or the network is too slow
  // to wait for). Serving these cache-first meant a phone opened the NEW page
  // with the OLD code behind it -- a mismatch that left Calendar and Boards
  // saying "sign in" to someone who was signed in.
  if (url.origin === self.location.origin && /\.(js|css|json)$/.test(url.pathname)) {
    // Just after a page served from the saved copy: its code comes from the
    // saved copies too, so the page and its code are from the same visit.
    // The fresh files are still fetched, and saved for next launch.
    if (Date.now() - pageFromCacheAt < MATCH_PAGE_MS) {
      let saving = null;
      const fresh = fetch(req, { cache: 'no-cache' }).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          saving = caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
      event.waitUntil(fresh.then(() => saving, () => {}));
      event.respondWith(caches.match(req).catch(() => null).then(saved => saved || fresh));
      return;
    }
    event.respondWith(new Promise(resolve => {
      let settled = false, networkFailed = false;
      const settle = r => { if (!settled) { settled = true; resolve(r); } };
      // The saved copy, if there is one. If there is not -- a first visit, or
      // a file that failed to precache -- a slow network is still the only
      // hope, so keep waiting for it: giving up at the 4-second mark used to
      // fail the script outright when it would have arrived a moment later.
      // Only once the network has actually failed is there nothing to wait for.
      const fromCache = () => caches.match(req).catch(() => null).then(r => {
        if (r) settle(r);
        else if (networkFailed) settle(Response.error());
      });
      const timer = setTimeout(fromCache, 4000);     // one bar of signal: do not hang
      fetch(req, { cache: 'no-cache' }).then(res => {
        clearTimeout(timer);
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        settle(res);
      }).catch(() => { clearTimeout(timer); networkFailed = true; fromCache(); });
    }));
    return;
  }

  // Everything else (icons, web fonts, the Firebase SDK): serve from cache at
  // once, and refresh the copy in the background for next launch.
  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req)
        .then(res => {
          // Opaque cross-origin responses are fine to cache for fonts; they
          // just cannot be inspected. Only skip genuine errors.
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => null);

      return cached || network.then(res => res || Response.error());
    })
  );
});

// A summary arriving from the server: show it. The payload is a title, a
// one-line body and where tapping it should take you.
self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'YD Job Hub', {
    body: d.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: d.url || './' },
    // A newer summary replaces an older one rather than stacking. Calendar
    // reminders carry their own tag, one per entry, so a reminder never
    // replaces the summary (or another reminder) still waiting to be read.
    tag: typeof d.tag === 'string' && d.tag ? d.tag : 'yd-summary',
    renotify: true,
  }));
});

// Tapping it opens Job Hub -- the window already open if there is one.
//
// An open window is brought forward and TOLD where to go (app.js listens),
// not navigated there. Navigating reloaded it, which threw away whatever was
// on screen -- a half-typed job included -- with no "leave page?" question.
// Only the app itself can act on the message: the privacy and terms pages
// share the address, so an open one of those gets a fresh app window instead.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  const home = new URL(self.registration.scope).pathname;
  const isApp = c => {
    const path = new URL(c.url).pathname;
    return 'focus' in c && (path === home || path === home + 'index.html');
  };
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(isApp);
    if (open) {
      open.postMessage({ type: 'yd-notification-open', url: url });
      return open.focus();
    }
    return self.clients.openWindow(url);
  }));
});

// Lets the page tell a waiting worker to take over immediately, so an update
// does not sit around until every tab is closed.
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
