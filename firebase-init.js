// Firebase wiring and the sign-in gate.
//
// This is the ONLY module file in the app. Everything else (app.js) is a classic
// script, because every handler in index.html is an inline onclick calling a
// global function -- module scope would hide those and silently break every
// button on the page. So all the ESM imports are quarantined here, and anything
// app.js needs is hung on window at the bottom.
//
// IMPORTANT: none of the checks in this file are security. Anyone can edit them
// from the browser console. firestore.rules is the real enforcement; this code
// only decides what to draw.

import { initializeApp }
  from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup,
  onAuthStateChanged, signOut, setPersistence,
  browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  doc, getDoc, getDocFromServer, setDoc, updateDoc, deleteField, serverTimestamp, collection, onSnapshot, deleteDoc,
  getDocs, getDocsFromServer, writeBatch, query, where,
  terminate, clearIndexedDbPersistence, waitForPendingWrites, runTransaction,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const ROLE_CACHE = 'ydjobhub_cachedRole';
const ACCESS_CACHE = 'ydjobhub_cachedAccess';
// Whose role and access those two are. Without it, a role remembered for one
// account could be handed to another signing in on the same device.
const ROLE_UID = 'ydjobhub_cachedRoleUid';

// What an admin may do, area by area, as the owner set it on their user
// record: users/{uid}.access = { jobs: 'see', hours: 'change', ... }. Anything
// missing or misspelt is 'none'. The owner can do everything; crew nothing
// beyond their own work. firestore.rules enforces exactly the same table.
const LEVELS = { none: 0, see: 1, change: 2 };
function cleanAccess(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach(k => { if (LEVELS[raw[k]]) out[k] = raw[k]; });
  }
  return out;
}
function canFor(role, access) {
  return (area, level) => {
    if (role === 'owner') return true;
    if (role !== 'admin') return false;
    return (LEVELS[access[area]] || 0) >= (LEVELS[level || 'see'] || 1);
  };
}

// ---------------------------------------------------------- writes on the way
// Every write the app makes, from the moment it is asked for until the
// SERVER says it has it. With no signal they wait here (Firestore keeps
// them on the phone and sends them later), so this is how many changes are
// waiting -- app.js shows "No signal ... 3 waiting" / "Sending 3 changes...".
// Kept by start time, so "still sending after 4 seconds" means the oldest
// one, not a steady trickle of quick ones.
const inFlight = new Map();          // ticket -> when it was asked for
let nextTicket = 0;
function tellPending() {
  let oldest = 0;
  inFlight.forEach(t => { if (!oldest || t < oldest) oldest = t; });
  document.dispatchEvent(new CustomEvent('yd-pending', { detail: { n: inFlight.size, oldest: oldest } }));
}
// Counts `p` (a write's promise) until it settles either way, and hands the
// SAME promise back, so every caller's .then/.catch behaves exactly as before.
function track(p) {
  const ticket = ++nextTicket;
  inFlight.set(ticket, Date.now());
  tellPending();
  const done = () => { inFlight.delete(ticket); tellPending(); };
  p.then(done, done);
  return p;
}

// ---------------------------------------------------------------- gate UI
const gate = {
  el: () => document.getElementById('authGate'),
  show(state, opts = {}) {
    const g = this.el();
    if (!g) return;
    g.hidden = false;
    g.dataset.state = state;
    const set = (id, text) => {
      const n = document.getElementById(id);
      if (n && text != null) n.textContent = text;
    };
    set('gateTitle', opts.title);
    set('gateMsg', opts.msg);
    const btn = document.getElementById('gateSignIn');
    if (btn) btn.hidden = !opts.signIn;
    const out = document.getElementById('gateSignOut');
    if (out) out.hidden = !opts.signOut;
    const again = document.getElementById('gateRetry');
    if (again) again.hidden = !opts.retry;
    const spin = document.getElementById('gateSpinner');
    if (spin) spin.hidden = !opts.spinner;
    // "Check again", for somebody waiting to be let in. Made here the first
    // time it is wanted, beside Sign out; what it does is gate.onCheck.
    let chk = document.getElementById('gateCheck');
    if (!chk && opts.check && out && out.parentNode) {
      chk = document.createElement('button');
      chk.type = 'button';
      chk.id = 'gateCheck';
      chk.className = 'btn btn-filled auth-btn';
      chk.textContent = 'Check again';
      chk.addEventListener('click', () => { if (gate.onCheck) gate.onCheck(); });
      out.parentNode.insertBefore(chk, out);
    }
    if (chk) chk.hidden = !opts.check;
  },
  onCheck: null,
  hide() {
    const g = this.el();
    if (g) g.hidden = true;
  },
};

// If anything below throws, the app must not be left behind a dead overlay.
// Falling back to local-only is safe: it only ever shows localStorage data from
// this one device, which is exactly how the app behaved before any of this.
function localOnly(reason) {
  console.warn('[auth] running local-only:', reason);
  gate.hide();
  document.body.classList.add('local-only');
  const banner = document.getElementById('localOnlyBanner');
  if (banner) {
    banner.hidden = false;
    const t = document.getElementById('localOnlyText');
    if (t) t.textContent = reason;
  }
  window.YDAuth = { ready: true, mode: 'local', user: null, role: null };
  document.dispatchEvent(new CustomEvent('yd-auth', { detail: window.YDAuth }));
}

const cfg = window.YD_CONFIG;
if (!cfg || !cfg.firebase || cfg.firebase.apiKey === 'YOUR_API_KEY') {
  localOnly('No Firebase config found — this device is saving locally only.');
} else {
  start().catch(err => localOnly('Could not reach Firebase: ' + err.message));
}

async function start() {
  gate.show('loading', { title: 'YD Job Hub', msg: 'Starting…', spinner: true });

  const app = initializeApp(cfg.firebase);
  const auth = getAuth(app);

  // Offline-first: the first Job Hub tab or window keeps the cache on disk.
  //
  // Deliberately the SINGLE-tab manager. With the multi-tab one, only one tab
  // (the "primary") talks to the server and every other tab's reads go through
  // it, under ITS sign-in. When that tab is stale -- left open in another
  // window, still running yesterday's code -- every new tab is refused, and
  // a freshly signed-in owner got "Cannot check access" (seen 1 Oct 2026: the
  // same read straight to Firestore with the same token succeeded). Now each
  // tab talks to the server as itself. A second tab cannot share the disk
  // cache, so Firestore quietly gives it a memory cache instead -- it works
  // normally online, it just does not keep data across restarts. Phones run
  // one copy of the app, so the crew keep full offline storage.
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
  });

  await setPersistence(auth, browserLocalPersistence);

  // Sign-in method. A popup is tried first everywhere, including an installed
  // app on the home screen. Redirect is the fallback, not the default: on iOS
  // a redirect can carry the user out of the installed app into Safari and
  // never come back, because iOS keeps those two storage areas separate --
  // which looks to the user like sign-in simply not working.
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;

  // Redirect sign-in was removed, so there is never a redirect result to
  // collect; asking for one still cost a network round trip on every launch.

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  // A browser embedded inside another app -- the one that opens when a link is
  // tapped in Messages, Gmail, Facebook or Instagram.
  //
  // These are where sign-in goes wrong. They block the popup, and the redirect
  // that used to be tried instead cannot work either: the app is served from
  // github.io while Google hands the sign-in back through firebaseapp.com, and
  // an embedded browser walls off storage between the two. Firebase then shows
  // its own page reading "missing initial state", which is where this check
  // came from. Nothing in the code can fix that from inside such a browser, so
  // the only honest thing is to say so and give them the address to open.
  function inAppBrowser() {
    const ua = navigator.userAgent || '';
    if (/FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Twitter|LinkedInApp|Snapchat|Pinterest|GSA\//i.test(ua)) return true;
    const iOS = /iPhone|iPad|iPod/.test(ua);
    // On iOS every browser is Safari underneath, so the giveaway for an
    // embedded one is the absence of Safari's own marker -- except in an
    // installed home-screen app, where it is legitimately absent.
    if (iOS && !standalone && !/Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)) return true;
    return false;
  }

  // Kept reachable so a sign-in problem on somebody else's phone can be
  // diagnosed by asking them to read one line back, rather than guessing.
  window.YDSignInDiag = () => ({
    inAppBrowser: inAppBrowser(),
    standalone: standalone,
    ua: navigator.userAgent,
    origin: location.origin,
    authDomain: (window.YD_CONFIG && window.YD_CONFIG.firebase && window.YD_CONFIG.firebase.authDomain) || '',
  });

  function openInBrowserMessage() {
    showSignIn('Open this page in Safari or Chrome to sign in — signing in does ' +
      'not work inside another app’s browser.\n\n' + location.href);
  }

  async function doSignIn() {
    if (inAppBrowser()) { openInBrowserMessage(); return; }

    gate.show('loading', { title: 'YD Job Hub', msg: 'Opening Google…', spinner: true });
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      if (e.code === 'auth/popup-closed-by-user') { showSignIn(); return; }

      // Deliberately NOT falling back to signInWithRedirect. The redirect comes
      // back through firebaseapp.com, which cannot reach the state it stored on
      // this origin, and the person lands on a Firebase error page saying
      // "missing initial state" with no way forward. A blocked popup is nearly
      // always an embedded browser, and the way out of that is to open the page
      // properly -- so say that instead of bouncing them somewhere broken.
      if (['auth/popup-blocked', 'auth/cancelled-popup-request',
           'auth/operation-not-supported-in-this-environment'].includes(e.code)) {
        openInBrowserMessage();
        return;
      }
      if (e.code === 'auth/unauthorized-domain') {
        showSignIn('This address is not allowed to sign in yet. It needs adding ' +
          'to the Firebase authorised domains.');
        return;
      }
      showSignIn('Sign-in failed: ' + (e.code || e.message));
    }
  }

  function showSignIn(msg) {
    gate.show('signin', {
      title: 'YD Job Hub',
      msg: msg || 'Sign in with your Google account to continue.',
      signIn: true,
    });
  }

  // An admin's areas, read alongside the role.
  let myAccess = {};

  // Work out what this account is allowed to do, creating the record if this is
  // a first sign-in. Returns 'owner' | 'admin' | 'crew' | 'pending' | 'inactive'.
  async function resolveRole(user) {
    const ref = doc(db, 'users', user.uid);
    let snap;

    // Ask Firestore only once the auth token is actually attached. Without
    // this, a second tab restoring an existing session can fire its first read
    // before the token lands, and the rules correctly refuse it -- which looks
    // exactly like being locked out. Belt and braces: retry once on a denial,
    // since the token can still be in flight.
    try { await user.getIdToken(); } catch (e) {
      console.warn('[auth] could not get token', e.code || e.message);
    }

    const readOnce = () => getDoc(ref);

    try {
      try {
        snap = await readOnce();
      } catch (e1) {
        if (e1.code !== 'permission-denied') throw e1;
        console.warn('[auth] first read denied, retrying once after token settles');
        await new Promise(r => setTimeout(r, 1200));
        await user.getIdToken(true);          // force refresh
        snap = await readOnce();
      }
    } catch (e) {
      // Almost always "offline with nothing cached". Trust the last known role
      // so the app still opens in a truck; the rules still gate the real data.
      // Only if it is this account's own: a device from before the uid was
      // kept has none, and is trusted as it always was.
      const cached = localStorage.getItem(ROLE_CACHE);
      const whose = localStorage.getItem(ROLE_UID);
      if (cached && (!whose || whose === user.uid)) {
        console.warn('[auth] offline, using cached role', cached);
        try { myAccess = cleanAccess(JSON.parse(localStorage.getItem(ACCESS_CACHE) || '{}')); } catch (err) { myAccess = {}; }
        return cached;
      }
      throw e;
    }

    if (snap.exists()) return roleOf(snap.data());

    // No record yet. The owner email mints itself; everyone else files a request.
    const isOwner = (user.email || '').toLowerCase() === String(cfg.ownerEmail).toLowerCase();
    const record = isOwner
      ? { email: user.email, name: user.displayName || '', role: 'owner',
          active: true, createdAt: serverTimestamp() }
      : { email: user.email, name: user.displayName || '', role: 'pending',
          active: false, createdAt: serverTimestamp() };

    await setDoc(ref, record);
    return isOwner ? 'owner' : 'pending';
  }

  // The role a user record grants, and (for an admin) their areas. Someone
  // refused stays out even if their record somehow says active -- the gate
  // used to let any role through that was not literally 'pending'.
  function roleOf(d) {
    myAccess = d.role === 'admin' ? cleanAccess(d.access) : {};
    // The rules need active == true; anything else (false, or missing) is out.
    if (d.active !== true) return d.role === 'pending' ? 'pending' : 'inactive';
    if (['owner', 'admin', 'crew'].indexOf(d.role) === -1) return d.role === 'pending' ? 'pending' : 'inactive';
    return d.role;
  }

  // The role this device last confirmed for THIS account, when it is one that
  // lets someone in. Anything else -- another account, a request still
  // waiting, someone switched off, a device from before the uid was kept --
  // waits for the server as before.
  function cachedRoleFor(user) {
    try {
      if (localStorage.getItem(ROLE_UID) !== user.uid) return null;
      const role = localStorage.getItem(ROLE_CACHE);
      if (['owner', 'admin', 'crew'].indexOf(role) === -1) return null;
      myAccess = role === 'admin' ? cleanAccess(JSON.parse(localStorage.getItem(ACCESS_CACHE) || '{}')) : {};
      return role;
    } catch (e) { return null; }
  }

  // A full localStorage must not stop sign-in -- this used to throw inside
  // the auth listener and leave the gate stuck on "Checking access".
  // The uid goes last, after being cleared first, so there is never a moment
  // when one account's uid sits beside another account's role.
  function rememberRole(user, role) {
    try {
      localStorage.removeItem(ROLE_UID);
      localStorage.setItem(ROLE_CACHE, role);
      localStorage.setItem(ACCESS_CACHE, JSON.stringify(myAccess));
      localStorage.setItem(ROLE_UID, user.uid);
    } catch (e) {}
  }

  // Someone who may not use the app. At sign-in a request still waiting is
  // told so; once the app is open, either is told their access went.
  // Either way the screen now opens the app by itself the moment Jonah lets
  // them in (their own record is watched -- they may read it), and "Check
  // again" asks the server there and then. Before, a new crew member sat at
  // "Waiting for approval" until they thought to close the app and reopen it.
  // `note` replaces the usual words (the answer to Check again).
  let shutRole = null, shutLive = false;
  function shutOut(user, role, live, note) {
    shutRole = role;
    shutLive = !!live;
    gate.onCheck = () => checkMe(user);
    if (role === 'pending' && !live) {
      gate.show('pending', {
        title: 'Waiting for approval',
        msg: note || `Signed in as ${user.email}. Jonah needs to approve this account before `
           + 'you can use the app. It opens by itself once he has.',
        signOut: true,
        check: true,
      });
      return;
    }
    gate.show('denied', {
      title: 'Access removed',
      msg: note || `The account ${user.email} no longer has access.`,
      signOut: true,
      check: true,
    });
  }

  const ALLOWED = ['owner', 'admin', 'crew'];
  let inFor = null;      // the account the app has been opened for (letIn)

  // Shut out at sign-in: the app was never opened, so nothing is watching
  // their record yet. Watch it until they are let in.
  function waitForApproval(user) {
    if (unwatchMe) { try { unwatchMe(); } catch (e) {} unwatchMe = null; }
    unwatchMe = onSnapshot(doc(db, 'users', user.uid), snap => {
      if (snap.metadata.fromCache || auth.currentUser !== user || !snap.exists()) return;
      heardOutside(user, roleOf(snap.data()));
    }, () => { /* offline or refused: Check again still asks */ });
  }
  // A role heard while still outside: in they come, or the words change
  // (a request turned down reads "Access removed").
  function heardOutside(user, role) {
    if (ALLOWED.indexOf(role) !== -1) {
      if (unwatchMe) { try { unwatchMe(); } catch (e) {} unwatchMe = null; }
      rememberRole(user, role);
      console.info('[auth] let in as', role);
      letIn(user, role, false);
      return;
    }
    const sig = role + JSON.stringify(myAccess);
    if (sig === shown) return;
    shown = sig;
    rememberRole(user, role);
    shutOut(user, role, false);
  }

  // "Check again": the server's own copy of their record, now.
  async function checkMe(user) {
    const btn = document.getElementById('gateCheck');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    try {
      const snap = await getDocFromServer(doc(db, 'users', user.uid));
      if (auth.currentUser !== user) return;
      const role = snap.exists() ? roleOf(snap.data()) : 'pending';
      if (inFor === user) applyRole(user, role, true); else heardOutside(user, role);
      if (ALLOWED.indexOf(role) === -1) {
        shutOut(user, role, inFor === user, role === 'pending' && inFor !== user
          ? `Signed in as ${user.email}. Not approved yet — this opens by itself the moment Jonah approves it.`
          : `The account ${user.email} still has no access. Ask Jonah to switch it back on.`);
      }
    } catch (e) {
      console.warn('[auth] check again failed', e.code || e.message);
      if (auth.currentUser === user && shutRole) {
        shutOut(user, shutRole, shutLive, 'Could not reach the server to check — look for signal and try again.');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Check again'; }
    }
  }

  onAuthStateChanged(auth, async user => {
    if (!user) {
      if (unwatchMe) { try { unwatchMe(); } catch (e) {} unwatchMe = null; }
      inFor = null;
      localStorage.removeItem(ROLE_UID);
      localStorage.removeItem(ROLE_CACHE);
      localStorage.removeItem(ACCESS_CACHE);
      // Say it before they tap, not after. Inside another app's browser the
      // sign-in cannot succeed, and offering the button first only produces a
      // failure they have to interpret.
      if (inAppBrowser()) openInBrowserMessage(); else showSignIn();
      window.YDAuth = { ready: true, mode: 'cloud', user: null, role: null, signIn: doSignIn };
      document.dispatchEvent(new CustomEvent('yd-auth', { detail: window.YDAuth }));
      return;
    }

    // Opened at once on what this device last confirmed for this same
    // account. Waiting for the server first cost up to ~10 seconds on every
    // launch with one bar of signal. The server is still asked, behind it
    // (watchMyRecord): a change of role or access redraws the screens, and
    // someone switched off is shut out. This only decides what to DRAW --
    // firestore.rules decides what the server hands over, whatever this says.
    // A first sign-in on this device still waits for the server.
    let role = cachedRoleFor(user);
    const fromDevice = !!role;
    if (!fromDevice) {
      gate.show('loading', { title: 'YD Job Hub', msg: 'Checking access…', spinner: true });
      try {
        role = await resolveRole(user);
      } catch (e) {
        console.error('[auth] could not resolve role', e);
        gate.show('error', {
          title: 'Cannot check access',
          msg: 'You are signed in, but your permissions could not be loaded. '
             + 'Check your connection and try again.',
          retry: true,
          signOut: true,
        });
        return;
      }
      rememberRole(user, role);
      if (role === 'pending' || role === 'inactive') {
        shown = role + JSON.stringify(myAccess);
        shutOut(user, role, false);
        waitForApproval(user);
        return;
      }
    }

    letIn(user, role, fromDevice);
  });

  // owner, admin or crew -- let them in. Straight after sign-in, or later
  // from the "Waiting for approval" screen once Jonah has let them in.
  function letIn(user, role, fromDevice) {
    inFor = user;
    gate.hide();

    // A deliberately small database interface for app.js, which is a classic
    // script and cannot import any of this itself. Keeping Firestore specifics
    // behind these four functions means the sync code stays readable and the
    // SDK version can change without touching the app.
    // Passes a snapshot on when documents changed, or when it first comes
    // from the server rather than the local cache. Without the second case,
    // a server answer identical to the cache never arrived at all -- so
    // anything waiting to hear "the server has spoken" (creating the starter
    // boards, the Maintenance board) waited forever. Metadata-only snapshots
    // that change nothing else are dropped, so screens do not redraw for them.
    function relay(onChange) {
      let wasCache = null;
      return snap => {
        // `pending`: the copy still carries this device's own write, not yet
        // on the server (sync.js waits for the server's own copy of a job it
        // sent only some parts of).
        const changes = snap.docChanges().map(c => ({ type: c.type, id: c.doc.id, data: c.doc.data(), pending: c.doc.metadata.hasPendingWrites }));
        const fromCache = snap.metadata.fromCache;
        if (!changes.length && fromCache === wasCache) return;
        wasCache = fromCache;
        onChange(changes, { size: snap.size, fromCache: fromCache });
      };
    }

    window.YDDb = {
      // Jobs are watched with the general watch('jobs') below (sync.js).
      async putJob(id, data) {
        await track(setDoc(doc(db, 'jobs', id), data));
      },

      // Only some parts of a job, each part whole (sync.js sends what this
      // device changed, not its whole copy over what others wrote). `gone`:
      // parts taken off. A job no longer on the server answers not-found.
      async updateJob(id, fields, gone) {
        const data = Object.assign({}, fields);
        (gone || []).forEach(k => { data[k] = deleteField(); });
        await track(updateDoc(doc(db, 'jobs', id), data));
      },

      async removeJob(id) {
        await track(deleteDoc(doc(db, 'jobs', id)));
      },

      // Used once, by the migration. Batched so 21 jobs is one round trip
      // rather than 21, and so it either all lands or none of it does.
      async putManyJobs(entries) {
        const CHUNK = 400;               // Firestore caps a batch at 500 writes
        for (let i = 0; i < entries.length; i += CHUNK) {
          const batch = writeBatch(db);
          entries.slice(i, i + CHUNK).forEach(([id, data]) => {
            batch.set(doc(db, 'jobs', id), data);
          });
          await track(batch.commit());
        }
      },

      // From the SERVER, deliberately. getDocs answers from the local cache
      // when there is no signal, so "connected" was being reported while
      // offline -- and an empty cache read as "the cloud has no jobs", which
      // is the one answer that lets this device push its copies over it.
      async countJobs() {
        const snap = await getDocsFromServer(collection(db, 'jobs'));
        return snap.size;
      },

      // ---- general collection access -------------------------------------
      // The job methods above came first and are kept as they are. Everything
      // from Snow onwards uses these instead, so a new record type needs no
      // new database code -- only rules, which are the part that must be
      // thought about.
      //
      // `path` may be nested: 'snowAccounts/example-account/private' addresses the
      // owner-only half of an account. That nesting is what enforces crew
      // seeing the route but not the money.

      watch(path, onChange, onError) {
        const parts = path.split('/');
        return onSnapshot(collection(db, ...parts), { includeMetadataChanges: true },
          relay(onChange),
          err => { console.error('[db] watch failed on', path, err); if (onError) onError(err); });
      },

      // Watch only the documents where `field` equals `value`.
      //
      // This is not an optimisation, it is the only way a restricted account
      // can read at all. Firestore checks a query against the rules as a
      // whole: if the rules say a crew member may read a time entry only when
      // it is theirs, then asking for the entire collection is refused outright
      // -- not filtered down, refused -- because the query could have returned
      // something they are not allowed. Asking a question whose answer is
      // provably all-theirs is what makes it legal.
      // Like watch(): also told when the server first answers, even with
      // nothing new -- an admin's boards and calendars wait for both of their
      // questions to have been answered by the server, and without this an
      // answer identical to the cache never arrived (review, 13 Oct).
      watchWhere(path, field, value, onChange, onError) {
        const parts = path.split('/');
        const q = query(collection(db, ...parts), where(field, '==', value));
        return onSnapshot(q, { includeMetadataChanges: true },
          relay(onChange),
          err => { console.error('[db] filtered watch failed on', path, err); if (onError) onError(err); });
      },

      // Watch only the documents whose array `field` contains `value`. Same
      // reason as watchWhere: a crew member may read a board or a calendar
      // only when their uid is in its visibleTo list, so the question has to
      // be "the ones listing me", never "all of them".
      watchContains(path, field, value, onChange, onError) {
        const parts = path.split('/');
        const q = query(collection(db, ...parts), where(field, 'array-contains', value));
        return onSnapshot(q, { includeMetadataChanges: true },
          relay(onChange),
          err => { console.error('[db] shared-with watch failed on', path, err); if (onError) onError(err); });
      },

      // Watch only the documents whose `field` is at or after `from` (an ISO
      // date string or a number). For collections that only ever grow, like
      // receipts: a device keeps the recent ones live and asks for older ones
      // (listWhere) only when somebody looks back that far.
      watchFrom(path, field, from, onChange, onError) {
        const parts = path.split('/');
        const q = query(collection(db, ...parts), where(field, '>=', from));
        return onSnapshot(q, { includeMetadataChanges: true },
          relay(onChange),
          err => { console.error('[db] recent-only watch failed on', path, err); if (onError) onError(err); });
      },

      // One look (no watching) at the documents matching field <op> value,
      // as { id: data }. From the cache when there is no signal.
      async listWhere(path, field, op, value) {
        const parts = path.split('/');
        const snap = await getDocs(query(collection(db, ...parts), where(field, op, value)));
        const out = {};
        snap.forEach(d => { out[d.id] = d.data(); });
        return out;
      },

      // The same, for every condition in [[field, op, value], ...] at once --
      // for a question the rules can only allow with two of them: an admin's
      // change history is "my area AND these months" (changelog.js).
      async listMatching(path, conds) {
        const parts = path.split('/');
        const snap = await getDocs(query(collection(db, ...parts), ...conds.map(([f, op, v]) => where(f, op, v))));
        const out = {};
        snap.forEach(d => { out[d.id] = d.data(); });
        return out;
      },

      async list(path) {
        const snap = await getDocs(collection(db, ...path.split('/')));
        const out = {};
        snap.forEach(d => { out[d.id] = d.data(); });
        return out;
      },

      async get(path, id) {
        const snap = await getDoc(doc(db, ...path.split('/'), id));
        return snap.exists() ? snap.data() : null;
      },

      // The SERVER's copy, never the cache -- and it fails with no signal
      // rather than answering from an old copy. For the few decisions that
      // must not be made on stale data, like handing out invoice numbers:
      // a cached record missing numbers another device already assigned
      // would assign them twice.
      async getFresh(path, id) {
        const snap = await getDocFromServer(doc(db, ...path.split('/'), id));
        return snap.exists() ? snap.data() : null;
      },

      // Read some documents and write them back as ONE step on the server:
      // no other device can slip a write in between, and if one did, the step
      // is run again on the new data. For handing out numbers -- two devices
      // reading the same "next invoice number" at the same moment gave out the
      // same numbers (review B11, 6 Oct 2026). `docs` is [[path, id], ...];
      // `change(datas)` gets each one's data (null when missing) and returns a
      // fields-to-merge object (or null) for each; it may run more than once,
      // so it must only work things out, not do them. Needs a signal: a
      // transaction is never queued offline, so this one IS awaited by its
      // caller, which says so when there is none.
      async transact(docs, change) {
        const refs = docs.map(([p, id]) => doc(db, ...p.split('/'), id));
        return track(runTransaction(db, async t => {
          const snaps = [];
          for (const r of refs) snaps.push(await t.get(r));
          const patches = change(snaps.map(s => (s.exists() ? s.data() : null))) || [];
          patches.forEach((p, i) => { if (p) t.set(refs[i], p, { merge: true }); });
          return patches;
        }));
      },

      async put(path, id, data) {
        await track(setDoc(doc(db, ...path.split('/'), id), data, { merge: true }));
      },

      async remove(path, id) {
        await track(deleteDoc(doc(db, ...path.split('/'), id)));
      },

      // Several writes as one unit. Used by imports, where half-landed data is
      // worse than none: an account whose pricing arrived but whose address
      // did not would quietly bill wrong.
      // Several deletes as one unit -- a board and all its cards, say. Chaining
      // them (cards, then the board once the server confirms) never deleted
      // the board at all with no signal, because "confirmed" never came.
      // Over 500 in one batch Firestore refuses the lot (a board with that
      // many cards could never be deleted), so they go in chunks like putMany
      // -- each chunk one unit, all of them committed at once.
      removeMany(entries) {
        const CHUNK = 400;
        const commits = [];
        for (let i = 0; i < entries.length; i += CHUNK) {
          const batch = writeBatch(db);
          entries.slice(i, i + CHUNK).forEach(([path, id]) => batch.delete(doc(db, ...path.split('/'), id)));
          commits.push(batch.commit());
        }
        return track(Promise.all(commits));
      },

      // Every chunk is committed at once rather than one after another. A
      // commit only settles when the SERVER answers, so waiting for chunk one
      // before starting chunk two meant that with no signal the second half
      // of a big price list was never even saved on the device.
      putMany(entries) {
        const CHUNK = 400;
        const commits = [];
        for (let i = 0; i < entries.length; i += CHUNK) {
          const batch = writeBatch(db);
          entries.slice(i, i + CHUNK).forEach(([path, id, data]) => {
            batch.set(doc(db, ...path.split('/'), id), data, { merge: true });
          });
          commits.push(batch.commit());
        }
        return track(Promise.all(commits));
      },

      // How many changes are on their way to the server right now (see
      // track() at the top). The 'yd-pending' event says when it changes.
      pending() { return inFlight.size; },
    };

    // Files (job photos) in Cloud Storage. The Storage SDK is fetched the
    // first time a photo is shown or sent, not at every launch -- most
    // visits never touch a photo, and the crew's phones load on one bar.
    // storage.rules is the real gate, the same way firestore.rules is.
    let storageMod = null;
    // A fetch that failed (the first photo taken with no signal) is not kept:
    // the next try fetches again.
    const storageOf = () => storageMod || (storageMod =
      import('https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js')
        .then(m => ({ m: m, s: m.getStorage(app) }), e => { storageMod = null; throw e; }));
    window.YDStore = {
      // Resolves with the file's download address once the whole file is
      // up. onProgress(0..1) as it goes.
      async upload(path, blob, contentType, onProgress) {
        const { m, s } = await storageOf();
        const r = m.ref(s, path);
        await new Promise((resolve, reject) => {
          const task = m.uploadBytesResumable(r, blob, { contentType: contentType || blob.type || 'image/jpeg' });
          task.on('state_changed',
            snap => { if (onProgress && snap.totalBytes) onProgress(snap.bytesTransferred / snap.totalBytes); },
            reject, resolve);
        });
        return m.getDownloadURL(r);
      },
      async url(path) {
        const { m, s } = await storageOf();
        return m.getDownloadURL(m.ref(s, path));
      },
      async remove(path) {
        const { m, s } = await storageOf();
        try { await m.deleteObject(m.ref(s, path)); }
        catch (e) { if (!e || e.code !== 'storage/object-not-found') throw e; }
      },
    };

    // Changes made in an earlier visit and never sent (the app was closed
    // with no signal) are still waiting in Firestore's own queue: counted
    // too, as one, until they have gone.
    track(waitForPendingWrites(db));

    publish(user, role);
    console.info('[auth] signed in as', user.email, 'role', role, fromDevice ? '(from this device; checking)' : '');
    watchMyRecord(user, fromDevice);
  }

  // Tell the rest of the app who is signed in and what they may do.
  // `key` changes whenever any of that does, so a screen can tell "the same
  // person with different access" from "nothing changed" and re-subscribe.
  function publish(user, role) {
    const access = Object.assign({}, myAccess);
    shown = role + JSON.stringify(access);
    window.YDAuth = {
      ready: true, mode: 'cloud', user, role, db, auth,
      signIn: doSignIn,
      signOut: () => signOut(auth),
      isOwner: role === 'owner',
      isAdmin: role === 'admin',
      access: access,
      can: canFor(role, access),
      key: user.uid + ':' + role + ':' + JSON.stringify(access),
    };
    document.dispatchEvent(new CustomEvent('yd-auth', { detail: window.YDAuth }));
  }

  // The owner can change someone's access while they have the app open.
  // Their own record is watched, so the screens they may see follow at once
  // -- and someone switched off is shown the door rather than left looking
  // at screens the rules now refuse.
  //
  // When the app opened on this device's own copy of the role (`checking`),
  // the server's first answer is the check that copy was waiting for: told
  // the way a sign-in would tell it ("Waiting for approval" for a request),
  // and a record that has gone from the server is made again exactly as at a
  // first sign-in -- the owner's email mints itself, anyone else files a
  // request and is shut out. Watched with metadata changes so that first
  // answer arrives even when it matches the copy.
  let unwatchMe = null;
  let shown = '';      // the role + access the screens are drawn for now
  function watchMyRecord(user, checking) {
    if (unwatchMe) { try { unwatchMe(); } catch (e) {} unwatchMe = null; }
    unwatchMe = onSnapshot(doc(db, 'users', user.uid), { includeMetadataChanges: true }, snap => {
      if (snap.metadata.fromCache || auth.currentUser !== user) return;
      // The record itself, for a screen that shows something from it (the
      // clock: whether they settle their own shifts) -- read once at sign-in,
      // a change the owner made stayed unseen until they signed in again.
      document.dispatchEvent(new CustomEvent('yd-my-record', { detail: snap.exists() ? snap.data() : null }));
      const first = checking;
      checking = false;
      if (snap.exists()) { applyRole(user, roleOf(snap.data()), !first); return; }
      if (first) {
        resolveRole(user).then(r => { if (auth.currentUser === user) applyRole(user, r, false); },
          () => { /* no answer: the rules still decide */ });
      }
    }, () => { /* offline or refused: the rules still decide */ });
  }

  // A role heard from the server after the app is open. Nothing happens
  // unless it differs from what the screens were drawn for.
  function applyRole(user, role, live) {
    const sig = role + JSON.stringify(myAccess);
    if (sig === shown) return;
    shown = sig;
    rememberRole(user, role);
    if (role === 'pending' || role === 'inactive') { shutOut(user, role, live); return; }
    console.info('[auth] access changed to', role, myAccess);
    // Let back in after being shut out: the gate comes down again.
    gate.hide();
    publish(user, role);
  }

  // Signing out, done properly. Resolves true once signed out, false if the
  // person chose to stay signed in.
  //
  // 1. Changes not yet on the server would be destroyed with the cache, so
  //    give them a few seconds to land, and ask before throwing them away.
  // 2. Other parts of the app tidy up while still signed in (this phone's
  //    notification subscription, say) -- each gets two seconds at most, so
  //    a dead connection cannot trap anyone in the app.
  // 3. Then the Firestore cache on this device is wiped. Without that, the
  //    jobs, prices and phone numbers the last person could see stayed on a
  //    shared phone after they signed out.
  const pause = ms => new Promise(r => setTimeout(() => r(false), ms));
  async function signOutFully() {
    // 0. Anything held back for a moment (a clock-out waiting out its Undo,
    //    timeclock.js) is written first, so the wait below covers it too.
    for (const flush of (window.YDSignOutFlush || [])) {
      try { flush(); } catch (e) { console.warn('[auth] sign-out flush failed', e); }
    }
    const landed = await Promise.race([waitForPendingWrites(db).then(() => true, () => false), pause(4000)]);
    // The app's own window when it has loaded (app.js), else the browser's.
    const sure = (text, title) => typeof window.ydConfirm === 'function'
      ? window.ydConfirm(text, { title: title, ok: 'Sign out anyway', cancel: 'Stay signed in', danger: true })
      : Promise.resolve(confirm(title + '\n\n' + text));
    if (!landed && !(await sure('Some changes on this device have not reached the cloud yet (no signal?). ' +
        'Signing out now will lose them.', 'Sign out anyway?'))) return false;
    for (const hook of (window.YDSignOutHooks || [])) {
      try { await Promise.race([Promise.resolve().then(hook), pause(2000)]); }
      catch (e) { console.warn('[auth] sign-out tidy-up failed', e); }
    }
    await signOut(auth);
    try {
      await terminate(db);
      await clearIndexedDbPersistence(db);
    } catch (e) { console.warn('[auth] could not clear the offline cache', e); }
    await Promise.race([dropSavedData(), pause(3000)]);
    return true;
  }
  // 4. What the service worker saved from other sites goes too: job and
  //    receipt photos (Firebase Storage) and address look-ups were kept in
  //    the app's saved copies, and a shared phone held them after sign-out.
  //    The app itself (this site's files) and the static files it needs to
  //    start with no signal -- the Firebase SDK, the fonts, the spreadsheet
  //    reader -- stay, or the next person could not open it in a truck.
  const KEEP_HOSTS = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];
  async function dropSavedData() {
    if (!('caches' in window)) return;
    try {
      for (const name of await caches.keys()) {
        const c = await caches.open(name);
        for (const req of await c.keys()) {
          let u = null;
          try { u = new URL(req.url); } catch (e) { continue; }
          if (u.origin === location.origin || KEEP_HOSTS.indexOf(u.hostname) !== -1) continue;
          await c.delete(req);
        }
      }
    } catch (e) { console.warn('[auth] could not clear saved files', e); }
  }

  // Wire the gate's buttons.
  const inBtn = document.getElementById('gateSignIn');
  if (inBtn) inBtn.addEventListener('click', doSignIn);
  const outBtn = document.getElementById('gateSignOut');
  if (outBtn) outBtn.addEventListener('click', async () => {
    if (await signOutFully()) location.reload();
  });

  window.YDSignOut = signOutFully;
}
