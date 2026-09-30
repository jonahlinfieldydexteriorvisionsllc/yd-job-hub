// YD Job Hub service worker.
//
// Goal: the app opens and works with no signal. Job data itself is not this
// file's problem -- localStorage holds it today, and Firestore's own offline
// persistence will hold it after Phase 1. All this does is make sure the app
// shell (HTML, CSS, JS, icons, fonts) is on the phone before the signal drops.
//
// Bump CACHE whenever a shell file changes, or phones keep serving the old one.

const CACHE = 'ydjobhub-v39';

// Same-origin files the app cannot start without.
const SHELL = [
  './',
  './index.html',
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
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Everything else (same-origin assets, web fonts): serve from cache at once,
  // and refresh the copy in the background for next launch.
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

// Lets the page tell a waiting worker to take over immediately, so an update
// does not sit around until every tab is closed.
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
