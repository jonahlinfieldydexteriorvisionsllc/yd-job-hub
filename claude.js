// Talking to Claude, from the app's side.
//
// The app never holds the API key and never calls Claude directly. It calls the
// yd-claude service, which holds the key and does the talking. All this file
// does is attach proof of who you are and pass along a task name.
//
// Adding a Claude-powered feature later means: add the task server-side in
// functions/main.py, then call YDClaude.ask('yourTask', {...}) from here.
// No new plumbing, no new security work.

(function () {
  'use strict';

  function endpoint() {
    return (window.YD_CONFIG && window.YD_CONFIG.claudeEndpoint) || '';
  }

  // How long to wait for an answer before saying so. A request sent into a
  // dead spot used to hang for good: "Drafting…" on the button, forever, and
  // no way to know whether to try again. Most answers take seconds; the
  // ones where Claude reads, writes or searches -- or QuickBooks makes an
  // estimate and emails it -- can take minutes, and cutting those short
  // would only make the person send them twice.
  const SHORT_MS = 45000;
  const LONG_MS = 300000;
  const LONG_PATHS = ['/estimate/draft', '/estimate/source', '/supplies/read-sheet', '/cards/now',
    '/receipts/photo', '/receipts/now', '/receipts/read-again', '/receipts/notes-now', '/care/draft', '/posts/draft', '/followup/draft', '/subs/scan',
    '/qb/estimate', '/qb/estimate-invoice', '/qb/invoice', '/social/plan-now', '/social/post-now', '/social/google/check'];
  const waitFor = path => (LONG_PATHS.indexOf(path) !== -1 ? LONG_MS : SHORT_MS);

  // How many asks are still waiting for their answer. The page never reloads
  // itself for an update while one is (app.js safeToReload): Jonah's message
  // to Claude about an estimate (21 Oct 2026) went unanswered because the
  // app reloaded for a new version while Claude was still working on it.
  let inFlight = 0;

  // fetch + read the answer, given up after `ms`. Resolves { res, payload };
  // rejects with words a person can act on.
  async function send(url, init, ms) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const timer = ctl ? setTimeout(() => { timedOut = true; ctl.abort(); }, ms) : null;
    inFlight++;
    try {
      let res;
      try {
        res = await fetch(url, ctl ? Object.assign({}, init, { signal: ctl.signal }) : init);
      } catch (e) {
        throw new Error(timedOut ? noAnswer(ms) : 'No connection — this needs signal.');
      }
      let payload = {};
      try { payload = await res.json(); } catch (e) {
        if (timedOut) throw new Error(noAnswer(ms));
      }
      return { res: res, payload: payload };
    } finally {
      inFlight--;
      if (timer) clearTimeout(timer);
    }
  }
  const noAnswer = ms => 'No answer from the server after ' + Math.round(ms / 1000) +
    ' seconds — check the signal and try again.';

  window.YDClaude = {
    busy: () => inFlight > 0,

    available() {
      // Drafting a scope writes into a job: the owner, or an admin who may
      // change jobs. The server checks the same.
      return !!(endpoint() && window.YDAuth && window.YDAuth.user && ydCan('jobs', 'change'));
    },

    async ask(task, data) {
      const url = endpoint();
      if (!url) throw new Error('Claude is not set up for this app yet.');
      const auth = window.YDAuth;
      if (!auth || !auth.user) throw new Error('Sign in first.');

      // A fresh sign-in token proves to the service who is asking. Without it
      // the service refuses -- which is what stops anyone who finds the URL
      // from spending your Claude credit.
      let token;
      try {
        token = await auth.user.getIdToken();
      } catch (e) {
        throw new Error('Could not confirm your sign-in. Try again.');
      }

      // The scope of work is Claude writing: the long wait.
      const { res, payload } = await send(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ task, data: data || {} }),
      }, LONG_MS);

      if (!res.ok) {
        throw new Error(payload.error || ('Claude request failed (' + res.status + ')'));
      }
      return payload;
    },

    // Another route on the same service (e.g. '/cards/now'), with the same
    // proof of who is asking.
    async post(path, body) {
      const base = endpoint().replace(/\/+$/, '');
      if (!base) throw new Error('Claude is not set up for this app yet.');
      const auth = window.YDAuth;
      if (!auth || !auth.user) throw new Error('Sign in first.');
      let token;
      try {
        token = await auth.user.getIdToken();
      } catch (e) {
        throw new Error('Could not confirm your sign-in — check the signal and try again.');
      }
      const { res, payload } = await send(base + path, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }, waitFor(path));
      // A button newer than the server it calls (the app goes live the moment
      // it is pushed; the server only when it is deployed).
      // (An unknown route under a known prefix says "unknown endpoint"; a
      // prefix the old server has never heard of falls to its scope-of-work
      // handler, which says "unknown task".)
      if ((res.status === 404 && /unknown endpoint/.test(payload.error || '')) ||
          (res.status === 400 && /unknown task/.test(payload.error || ''))) {
        throw new Error('Not switched on yet — the server is waiting for its update');
      }
      if (!res.ok) throw new Error(payload.error || ('Request failed (' + res.status + ')'));
      return payload;
    },
  };

  // ---------------------------------------------------------------- one feature
  // Draft the scope of work for the job currently open, into Job Notes.

  window.draftScopeWithClaude = async function () {
    const btn = document.getElementById('draftScopeBtn');
    const notes = document.getElementById('notes');
    if (!btn || !notes) return;

    if (!window.YDClaude.available()) {
      showToast('Sign in to use Claude');
      return;
    }

    const customer = (document.getElementById('customerName').value || '').trim();
    if (!customer) {
      showToast('Add a customer name first');
      return;
    }

    // Never silently destroy something already written.
    if (notes.value.trim()) {
      const before = currentJobId;
      if (!(await ydConfirm('The draft replaces what is in Job Notes now.', { title: 'Replace the Job Notes?', ok: 'Draft it' }))) return;
      if (currentJobId !== before || btn.disabled) return;
    }

    const original = btn.textContent;
    // A job not yet saved has no id, and the autosave gives it one a moment
    // later -- usually while Claude is still answering, so the check below
    // saw "a different job" and threw the draft away. And with no id, opening
    // a blank new job meanwhile looked like the same job, so the draft landed
    // in that one. Saved first, the job has an id that means only itself.
    // (A customer name is required above, so this never saves an empty job.)
    if (!currentJobId && typeof autosave === 'function') autosave();

    // Which job this draft is for. The answer takes a few seconds, and if a
    // different job was opened meanwhile the draft would have landed in its
    // notes and been autosaved there.
    const forJob = currentJobId;
    // What the notes said when the draft was asked for. Replacing them was
    // agreed to above; anything typed while waiting was not.
    const asked = notes.value.trim();
    btn.disabled = true;
    btn.textContent = 'Drafting…';

    try {
      const city = [document.getElementById('city').value,
                    document.getElementById('state').value]
                   .filter(Boolean).join(', ');
      const result = await window.YDClaude.ask('estimate_scope', {
        customer: customer,
        location: [document.getElementById('address').value, city]
                    .filter(Boolean).join(', '),
        services: serviceTypes.slice(),
        notes: asked,
        price: document.getElementById('jobPrice').value,
      });

      if (currentJobId !== forJob) {
        showToast('A different job is open now — the draft was not put in it');
        return;
      }
      // An empty answer must not wipe what was there.
      const text = String((result && result.text) || '').trim();
      if (!text) {
        showToast('Claude sent back nothing — Job Notes were left as they were');
        return;
      }
      if (notes.value.trim() !== asked) {
        if (!(await ydConfirm('Job Notes were changed while the draft was being written.',
            { title: 'Replace them with the draft anyway?', ok: 'Replace them', cancel: 'Keep mine', danger: true }))) return;
        if (currentJobId !== forJob) { showToast('A different job is open now — the draft was not put in it'); return; }
      }
      notes.value = text;
      markDirty();
      showToast('Scope drafted — read it before sending');
    } catch (err) {
      showToast(err.message || 'Could not draft the scope');
      console.error('[claude]', err);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  };

  // Only show the button when Claude is actually usable.
  document.addEventListener('yd-auth', () => {
    const btn = document.getElementById('draftScopeBtn');
    if (btn) btn.hidden = !window.YDClaude.available();
  });
})();
