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

  window.YDClaude = {
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

      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ task, data: data || {} }),
        });
      } catch (e) {
        throw new Error('No connection — this needs signal.');
      }

      let payload = {};
      try { payload = await res.json(); } catch (e) {}

      if (!res.ok) {
        throw new Error(payload.error || ('Claude request failed (' + res.status + ')'));
      }
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
    if (notes.value.trim() &&
        !confirm('This will replace what is currently in Job Notes.\n\nCarry on?')) {
      return;
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
      if (notes.value.trim() !== asked &&
          !confirm('Job Notes were changed while the draft was being written.\n\n' +
                   'Replace them with the draft anyway?')) {
        return;
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
