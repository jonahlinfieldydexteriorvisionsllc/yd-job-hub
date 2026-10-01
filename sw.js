// YD Job Hub service worker.
//
// Goal: the app opens and works with no signal. Job data itself is not this
// file's problem -- localStorage holds it today, and Firestore's own offline
// persistence will hold it after Phase 1. All this does is make sure the app
// shell (HTML, CSS, JS, icons, fonts) is on the phone before the signal drops.
//
// Bump CACHE whenever a shell file changes, or phones keep serving the old one.

const CACHE = 'ydjobhub-v59';

// Same-origin files the app cannot start without.
const SHELL = [
  './',
  './index.html',
  './privacy.html',
  './terms.html',
  './disconnected.html',
  './styles.css',
  './app.js',
  './config.js',
  './firebase-init.js',
  './sync.js',
  './claude.js',
  './snow.js',
  './storm.js',
  './billing.js',
  './weather.js',
  './prospects.js',
  './timeclock.js',
  './problems.js',
  './quickbooks.js',
  './equipment.js',
  './boards.js',
  './calendar.js',
  './worklog.js',
  './supplies.js',
  './notify.js',
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
];

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
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' })
        .then(res => {
          // Each page is kept under its own address. Storing every page as
          // index.html meant that opening the privacy page once made the app
          // open AS the privacy page the next time there was no signal.
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true })
          .then(r => r || caches.match('./index.html'))
          .then(r => r || caches.match('./')))
    );
    return;
  }

  // The app's own code and styles: fresh from the network whenever there is
  // signal, the saved copy only when there is not (or the network is too slow
  // to wait for). Serving these cache-first meant a phone opened the NEW page
  // with the OLD code behind it -- a mismatch that left Calendar and Boards
  // saying "sign in" to someone who was signed in.
  if (url.origin === self.location.origin && /\.(js|css|json)$/.test(url.pathname)) {
    event.respondWith(new Promise(resolve => {
      let settled = false;
      const fallback = () => caches.match(req).then(r => {
        if (!settled) { settled = true; resolve(r || Response.error()); }
      });
      const timer = setTimeout(fallback, 4000);      // one bar of signal: do not hang
      fetch(req, { cache: 'no-cache' }).then(res => {
        clearTimeout(timer);
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        if (!settled) { settled = true; resolve(res); }
      }).catch(() => { clearTimeout(timer); fallback(); });
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
    tag: 'yd-summary',          // a newer summary replaces an older one rather than stacking
    renotify: true,
  }));
});

// Tapping it opens Job Hub -- the window already open if there is one.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if ('focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});

// Lets the page tell a waiting worker to take over immediately, so an update
// does not sit around until every tab is closed.
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
