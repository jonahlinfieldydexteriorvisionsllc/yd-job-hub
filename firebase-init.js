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
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut, setPersistence,
  browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, serverTimestamp, collection, onSnapshot, deleteDoc,
  getDocs, writeBatch, disableNetwork, enableNetwork, query, where,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const ROLE_CACHE = 'ydjobhub_cachedRole';

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
    const spin = document.getElementById('gateSpinner');
    if (spin) spin.hidden = !opts.spinner;
  },
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

  // Offline-first. persistentMultipleTabManager keeps desktop tabs from
  // fighting over the same local cache.
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });

  await setPersistence(auth, browserLocalPersistence);

  // Sign-in method. A popup is tried first everywhere, including an installed
  // app on the home screen. Redirect is the fallback, not the default: on iOS
  // a redirect can carry the user out of the installed app into Safari and
  // never come back, because iOS keeps those two storage areas separate --
  // which looks to the user like sign-in simply not working.
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;

  try { await getRedirectResult(auth); } catch (e) {
    console.warn('[auth] redirect result:', e.code || e.message);
  }

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  async function doSignIn() {
    gate.show('loading', { title: 'YD Job Hub', msg: 'Opening Google…', spinner: true });
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      // A popup that is blocked or unsupported is worth one retry as a redirect.
      if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment',
           'auth/cancelled-popup-request'].includes(e.code)) {
        try { await signInWithRedirect(auth, provider); return; } catch (e2) { e = e2; }
      }
      if (e.code === 'auth/popup-closed-by-user') { showSignIn(); return; }
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

  // Work out what this account is allowed to do, creating the record if this is
  // a first sign-in. Returns 'owner' | 'crew' | 'pending' | 'inactive'.
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
      const cached = localStorage.getItem(ROLE_CACHE);
      if (cached) { console.warn('[auth] offline, using cached role', cached); return cached; }
      throw e;
    }

    if (snap.exists()) {
      const d = snap.data();
      if (d.active === false) return d.role === 'pending' ? 'pending' : 'inactive';
      return d.role || 'pending';
    }

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

  onAuthStateChanged(auth, async user => {
    if (!user) {
      localStorage.removeItem(ROLE_CACHE);
      showSignIn();
      window.YDAuth = { ready: true, mode: 'cloud', user: null, role: null, signIn: doSignIn };
      document.dispatchEvent(new CustomEvent('yd-auth', { detail: window.YDAuth }));
      return;
    }

    gate.show('loading', { title: 'YD Job Hub', msg: 'Checking access…', spinner: true });

    let role;
    try {
      role = await resolveRole(user);
    } catch (e) {
      console.error('[auth] could not resolve role', e);
      gate.show('error', {
        title: 'Cannot check access',
        msg: 'You are signed in, but your permissions could not be loaded. '
           + 'Check your connection and try again.',
        signOut: true,
      });
      return;
    }

    localStorage.setItem(ROLE_CACHE, role);

    if (role === 'pending') {
      gate.show('pending', {
        title: 'Waiting for approval',
        msg: `Signed in as ${user.email}. Jonah needs to approve this account before `
           + 'you can use the app.',
        signOut: true,
      });
      return;
    }

    if (role === 'inactive') {
      gate.show('denied', {
        title: 'Access removed',
        msg: `The account ${user.email} no longer has access.`,
        signOut: true,
      });
      return;
    }

    // owner or crew -- let them in
    gate.hide();

    // A deliberately small database interface for app.js, which is a classic
    // script and cannot import any of this itself. Keeping Firestore specifics
    // behind these four functions means the sync code stays readable and the
    // SDK version can change without touching the app.
    window.YDDb = {
      // Live subscription to every job. Fires immediately with what is cached
      // locally, then again whenever anything changes anywhere.
      watchJobs(onChange, onError) {
        return onSnapshot(collection(db, 'jobs'),
          { includeMetadataChanges: false },
          snap => {
            const changes = snap.docChanges().map(c => ({
              type: c.type,                 // 'added' | 'modified' | 'removed'
              id: c.doc.id,
              data: c.doc.data(),
            }));
            onChange(changes, {
              size: snap.size,
              fromCache: snap.metadata.fromCache,
              hasPendingWrites: snap.metadata.hasPendingWrites,
            });
          },
          err => { console.error('[sync] jobs listener failed', err); if (onError) onError(err); });
      },

      async putJob(id, data) {
        await setDoc(doc(db, 'jobs', id), data);
      },

      async removeJob(id) {
        await deleteDoc(doc(db, 'jobs', id));
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
          await batch.commit();
        }
      },

      async countJobs() {
        const snap = await getDocs(collection(db, 'jobs'));
        return snap.size;
      },

      // Cut and restore the connection on purpose. The app's central promise is
      // that a storm can be worked with no signal, and the only honest way to
      // check that is to actually take the signal away rather than assume the
      // offline layer does what the documentation says.
      goOffline: () => disableNetwork(db),
      goOnline: () => enableNetwork(db),

      // ---- general collection access -------------------------------------
      // The job methods above came first and are kept as they are. Everything
      // from Snow onwards uses these instead, so a new record type needs no
      // new database code -- only rules, which are the part that must be
      // thought about.
      //
      // `path` may be nested: 'snowAccounts/angel-b/private' addresses the
      // owner-only half of an account. That nesting is what enforces crew
      // seeing the route but not the money.

      watch(path, onChange, onError) {
        const parts = path.split('/');
        return onSnapshot(collection(db, ...parts),
          snap => onChange(
            snap.docChanges().map(c => ({ type: c.type, id: c.doc.id, data: c.doc.data() })),
            { size: snap.size, fromCache: snap.metadata.fromCache }
          ),
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
      watchWhere(path, field, value, onChange, onError) {
        const parts = path.split('/');
        const q = query(collection(db, ...parts), where(field, '==', value));
        return onSnapshot(q,
          snap => onChange(
            snap.docChanges().map(c => ({ type: c.type, id: c.doc.id, data: c.doc.data() })),
            { size: snap.size, fromCache: snap.metadata.fromCache }
          ),
          err => { console.error('[db] filtered watch failed on', path, err); if (onError) onError(err); });
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

      async put(path, id, data) {
        await setDoc(doc(db, ...path.split('/'), id), data, { merge: true });
      },

      async remove(path, id) {
        await deleteDoc(doc(db, ...path.split('/'), id));
      },

      // Several writes as one unit. Used by imports, where half-landed data is
      // worse than none: an account whose pricing arrived but whose address
      // did not would quietly bill wrong.
      async putMany(entries) {
        const CHUNK = 400;
        for (let i = 0; i < entries.length; i += CHUNK) {
          const batch = writeBatch(db);
          entries.slice(i, i + CHUNK).forEach(([path, id, data]) => {
            batch.set(doc(db, ...path.split('/'), id), data, { merge: true });
          });
          await batch.commit();
        }
      },
    };

    window.YDAuth = {
      ready: true, mode: 'cloud', user, role, db, auth,
      signIn: doSignIn,
      signOut: () => signOut(auth),
      isOwner: role === 'owner',
    };
    document.dispatchEvent(new CustomEvent('yd-auth', { detail: window.YDAuth }));
    console.info('[auth] signed in as', user.email, 'role', role);
  });

  // Wire the gate's buttons.
  const inBtn = document.getElementById('gateSignIn');
  if (inBtn) inBtn.addEventListener('click', doSignIn);
  const outBtn = document.getElementById('gateSignOut');
  if (outBtn) outBtn.addEventListener('click', () => signOut(auth));

  window.YDSignOut = () => signOut(auth);
}
