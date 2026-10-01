// When something goes wrong on somebody else's phone.
//
// The problem this solves: a crew member at 4am says "it didn't work" and
// there is no way to find out what that meant. The console on their phone is
// unreachable, they will not remember the wording, and by morning the app has
// been reloaded and whatever happened is gone.
//
// So the app writes it down. Two sources:
//
//   automatic  -- an uncaught error or a failed promise, caught as it happens
//   by hand    -- a "Something went wrong" button, because most real failures
//                 are not errors at all. "The job wasn't in the list" throws
//                 nothing, and that is exactly the report worth having.
//
// Three things shape the implementation.
//
// It records to the phone FIRST and sends later. The failures worth catching
// are often the ones where the network or sign-in is broken, and a reporter
// that needs a working connection to report a broken connection is no use.
//
// It is capped and de-duplicated. One error inside a redraw loop would
// otherwise write thousands of rows, turn a bug into a bill, and bury the one
// report that mattered.
//
// It never records what was typed. Stack traces and screen names are about the
// code; field contents are client names, addresses and prices, and those have
// no business being copied into a diagnostics pile.

(function () {
  'use strict';

  const QUEUE_KEY = 'ydjobhub_problemQueue';
  const MAX_PER_SESSION = 12;     // a loop must not become a bill
  const MAX_QUEUED = 40;          // cap what the phone holds too
  const BREADCRUMBS = 8;

  let sentThisSession = 0;
  let seen = {};                  // message -> count, for de-duplication
  let trail = [];                 // what happened just before
  let problems = {};              // owner's view
  let unsub = null;
  let version = 'unknown';

  const el = id => document.getElementById(id);
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const me = () => (window.YDAuth && window.YDAuth.user) || null;

  // ------------------------------------------------------------ breadcrumbs
  //
  // The app already narrates itself: nearly every action ends in a toast. That
  // makes showToast a free record of what somebody just did, which turns "it
  // crashed" into "it crashed right after clocking out of the Baxter job".

  function crumb(text) {
    trail.push({ at: Date.now(), what: String(text).slice(0, 80) });
    if (trail.length > BREADCRUMBS) trail.shift();
  }

  function wrapToast() {
    const real = window.showToast;
    if (typeof real !== 'function' || real.__wrapped) return;
    const wrapped = function (msg) { crumb(msg); return real.apply(this, arguments); };
    wrapped.__wrapped = true;
    window.showToast = wrapped;
  }

  // ---------------------------------------------------------------- capture

  function currentScreen() {
    const p = document.querySelector('.tab-panel.active');
    return p ? p.id.replace('panel-', '') : '';
  }

  function record(kind, message, detail) {
    const msg = String(message || '').slice(0, 300);
    if (!msg) return;

    // The same fault firing over and over is one problem, not two hundred.
    const key = kind + '|' + msg;
    seen[key] = (seen[key] || 0) + 1;
    if (seen[key] > 1 || sentThisSession >= MAX_PER_SESSION) return;
    sentThisSession++;

    const u = me();
    const rec = {
      kind: kind,                        // 'error' | 'promise' | 'reported'
      message: msg,
      detail: String(detail || '').slice(0, 1200),
      screen: currentScreen(),
      trail: trail.slice(),
      at: new Date().toISOString(),
      atMs: Date.now(),
      uid: u ? u.uid : '',
      who: u ? (u.displayName || u.email || '') : 'not signed in',
      role: (window.YDAuth && window.YDAuth.role) || '',
      version: version,
      online: navigator.onLine,
      device: (navigator.userAgent || '').slice(0, 200),
      standalone: window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true,
      status: 'new',
    };

    queueIt(rec);
    flush();
  }

  // ------------------------------------------------------- hold, then send

  function readQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
    catch (e) { return []; }
  }
  function writeQueue(list) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(list.slice(-MAX_QUEUED))); }
    catch (e) { /* storage full or blocked; the report is not worth an error */ }
  }
  function queueIt(rec) {
    const q = readQueue();
    q.push(rec);
    writeQueue(q);
  }

  // Sends whatever is waiting. Anything that fails stays on the phone and goes
  // next time -- which is the whole point of writing it down first.
  //
  // The rules only accept a report filed under the uid of whoever is signed in
  // NOW. A fault from before sign-in was written down with no uid at all (and
  // one from a phone somebody else used since, under theirs), so it was
  // refused, put back, refused again on every flush, and never arrived --
  // which lost exactly the sign-in failures this exists to catch. The sender
  // is stamped at sending time; `who` still says who it happened to.
  function flush() {
    const u = me();
    if (!window.YDDb || !u) return;
    const q = readQueue();
    if (!q.length) return;
    writeQueue([]);
    q.forEach(rec => {
      const out = Object.assign({}, rec, {
        uid: u.uid,
        sentBy: u.displayName || u.email || '',
      });
      const id = 'p' + (rec.atMs || Date.now()).toString(36) + Math.floor(Math.random() * 1000);
      Promise.resolve(window.YDDb.put('problems', id, out)).catch(e => {
        // Refused by the rules means it will be refused every time; keeping it
        // would only loop. Anything else is the connection, so it waits.
        if (e && e.code === 'permission-denied') {
          console.warn('[problems] refused, dropped:', rec.message);
          return;
        }
        console.warn('[problems] not sent yet:', (e && e.code) || e);
        queueIt(rec);
      });
    });
  }

  // ------------------------------------------------------------- the hooks

  window.addEventListener('error', e => {
    // A failed <script> or <img> fires this too, with no Error object.
    if (!e.error && e.target && e.target !== window) {
      record('error', 'Failed to load ' + (e.target.src || e.target.href || 'a file'), '');
      return;
    }
    record('error', e.message,
      (e.filename || '') + ':' + (e.lineno || '') + '\n' +
      ((e.error && e.error.stack) || ''));
  }, true);

  window.addEventListener('unhandledrejection', e => {
    const r = e.reason;
    record('promise', (r && (r.code || r.message)) || String(r), (r && r.stack) || '');
  });

  // ------------------------------------------------- reporting it by hand

  window.reportProblem = function () {
    const what = prompt('What went wrong?\n\nSay what you were trying to do. ' +
      'This goes to the office with the details of what the app was doing.');
    if (what === null) return;
    if (!what.trim()) return;
    // Reported by a person, so it bypasses the de-duplication: if they say it
    // twice, they meant it twice.
    seen = {};
    record('reported', what.trim().slice(0, 300), '');
    showToast('Sent — thanks. Jonah will see it.');
  };

  // ------------------------------------------------------------ owner view

  window.openProblems = function () {
    const m = el('problemsModal');
    if (m) m.classList.add('active');
    renderProblems();
  };
  window.closeProblems = function () {
    const m = el('problemsModal');
    if (m) m.classList.remove('active');
  };

  function renderProblems() {
    const wrap = el('problemsBody');
    if (!wrap) return;
    const list = Object.values(problems)
      .sort((a, b) => (b.atMs || 0) - (a.atMs || 0));
    const open = list.filter(p => p.status !== 'done');

    const badge = el('problemsCount');
    if (badge) {
      badge.textContent = open.length ? String(open.length) : '';
      badge.hidden = !open.length;
    }

    if (!list.length) {
      wrap.innerHTML = '<p class="empty-msg">Nothing has gone wrong. ' +
        'Errors on anybody’s phone land here, along with anything the crew report.</p>';
      return;
    }

    // Reports are written from any phone, so the id is trimmed to the
    // characters our own ids use before it goes into a button.
    const pid = p => String(p.id || '').replace(/[^A-Za-z0-9_-]/g, '');
    wrap.innerHTML = list.map(p =>
      '<div class="prob' + (p.status === 'done' ? ' done' : '') + '">' +
        '<div class="prob-top">' +
          '<span class="prob-kind ' + esc(p.kind) + '">' +
            (p.kind === 'reported' ? 'reported' : 'error') + '</span>' +
          '<span class="prob-who">' + esc(p.who || 'unknown') + '</span>' +
          '<span class="prob-when">' + when(p.atMs) + '</span>' +
        '</div>' +
        '<div class="prob-msg">' + esc(p.message) + '</div>' +
        '<div class="prob-meta">' +
          (p.screen ? 'on the ' + esc(p.screen) + ' screen' : '') +
          (p.online === false ? ' · no signal' : '') +
          (p.version && p.version !== 'unknown' ? ' · ' + esc(p.version) : '') +
          (p.sentBy && p.sentBy !== p.who ? ' · sent later by ' + esc(p.sentBy) : '') +
        '</div>' +
        (Array.isArray(p.trail) && p.trail.length
          ? '<div class="prob-trail">Just before: ' +
            p.trail.map(t => esc(t && t.what)).join(' → ') + '</div>'
          : '') +
        (p.detail ? '<pre class="prob-detail">' + esc(p.detail) + '</pre>' : '') +
        '<div class="prob-act">' +
          (p.status === 'done'
            ? '<button class="btn btn-sm" onclick="reopenProblem(\'' + pid(p) + '\')">Not fixed</button>'
            : '<button class="btn btn-sm btn-filled" onclick="closeProblem(\'' + pid(p) + '\')">Sorted</button>') +
          '<button class="remove-btn" onclick="deleteProblem(\'' + pid(p) + '\')" title="Delete">&times;</button>' +
        '</div>' +
      '</div>').join('');
  }

  function when(ms) {
    if (!ms) return '';
    const mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  window.closeProblem = function (id) { setStatus(id, 'done'); };
  window.reopenProblem = function (id) { setStatus(id, 'new'); };

  function setStatus(id, status) {
    if (!problems[id] || !isOwner()) return;
    problems[id].status = status;
    renderProblems();
    Promise.resolve(window.YDDb.put('problems', id, { status: status }))
      .catch(e => console.warn('[problems] status not saved:', e.code || e.message));
  }

  window.deleteProblem = function (id) {
    if (!problems[id] || !isOwner()) return;
    if (!confirm('Delete this report?')) return;
    delete problems[id];
    renderProblems();
    Promise.resolve(window.YDDb.remove('problems', id))
      .catch(e => console.warn('[problems] not deleted:', e.code || e.message));
  };

  // ---------------------------------------------------------------- loading

  // The version comes from the service worker's cache name rather than a
  // constant, so there is only one place to bump when the app changes.
  function findVersion() {
    if (!window.caches || !caches.keys) return;
    caches.keys().then(keys => {
      const k = keys.find(n => /^ydjobhub-v/.test(n));
      if (k) version = k.replace('ydjobhub-', '');
    }).catch(() => {});
  }

  // Dropped at sign-out, not left running. A listener outlives the account it
  // was opened for only to be refused and die, and while `unsub` still held it
  // the next sign-in thought a watch was running and never opened one -- the
  // owner's Problems list sat frozen until the app was reloaded.
  function stopWatching() {
    if (unsub) { try { unsub(); } catch (e) {} }
    unsub = null;
    problems = {};
    renderProblems();
  }

  function start(owner) {
    flush();
    if (!owner) { stopWatching(); return; }
    if (unsub || !window.YDDb) return;
    unsub = window.YDDb.watch('problems', changes => {
      changes.forEach(c => {
        if (c.type === 'removed') delete problems[c.id];
        else problems[c.id] = Object.assign({ id: c.id }, c.data);
      });
      renderProblems();
    }, () => renderProblems());
  }

  window.YDProblems = { record: record, all: () => problems, render: renderProblems };

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const owner = a.isOwner === true;
    const entry = el('menuProblems');
    if (entry) entry.hidden = !owner;
    const report = el('menuReport');
    if (report) report.hidden = !(a.mode === 'cloud' && a.user);
    if (a.mode === 'cloud' && a.user) start(owner);
    else stopWatching();
  });

  function boot() { wrapToast(); findVersion(); flush(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
