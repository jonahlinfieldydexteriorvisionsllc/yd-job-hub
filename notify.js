// Notifications and the daily summaries.
//
// The summaries themselves are built and sent by the server (functions/
// digest.py) on a schedule -- 5:00 am, midday and end of day. This file is the
// person's side of it: which ones they want, by email and/or as a phone
// notification, and switching notifications on for this particular device.
//
// Each person sets their own. The owner's choices and a crew member's are
// separate records (digestPrefs/{uid}); the server builds each person a
// different summary anyway.
//
// A phone notification needs the device's own permission, which a browser
// will only ask for in answer to a tap -- hence the button. On an iPhone it
// only works once Job Hub has been added to the home screen.

(function () {
  'use strict';

  const DEFAULTS = {
    owner: { email: true, push: true, morning: true, midday: true, evening: true },
    crew: { email: false, push: true, morning: true, midday: true, evening: true },
  };
  const SLOT_INFO = [
    ['morning', 'Morning', '5:00 am — the day ahead and the weather'],
    ['midday', 'Midday', '12:00 pm — the rest of the day'],
    ['evening', 'End of day', '5:30 pm — hours worked and tomorrow'],
  ];

  let prefs = null;
  const el = id => document.getElementById(id);
  const me = () => (window.YDAuth && window.YDAuth.user) || null;
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const endpoint = () => ((window.YD_CONFIG || {}).claudeEndpoint || '').replace(/\/+$/, '');

  async function server(path, body) {
    const u = me();
    const headers = { 'Content-Type': 'application/json' };
    if (u && body !== undefined) headers.Authorization = 'Bearer ' + await u.getIdToken();
    const res = await fetch(endpoint() + path, { method: body === undefined ? 'GET' : 'POST', headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
    return data;
  }

  // ------------------------------------------------------------ this device

  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  function b64ToBytes(b64) {
    const pad = '='.repeat((4 - b64.length % 4) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }
  async function subId(sub) {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub.endpoint));
    return 'ps' + Array.from(new Uint8Array(h)).slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function deviceState() {
    if (!pushSupported()) return isIOS() && !standalone() ? 'needs-home-screen' : 'unsupported';
    if (Notification.permission === 'denied') return 'blocked';
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    return sub ? 'on' : 'off';
  }

  window.ntfTurnOn = async function () {
    const btn = el('ntfDeviceBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Turning on…'; }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { showToast('Notifications were not allowed on this device'); return; }
      const reg = await navigator.serviceWorker.ready;
      const { key } = await server('/digest/pushkey');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      const id = await subId(sub);
      await Promise.race([
        window.YDDb.put('pushSubs', id, { uid: me().uid, sub: JSON.parse(JSON.stringify(sub)),
          device: navigator.userAgent.slice(0, 120), createdAt: new Date().toISOString() }),
        new Promise(r => setTimeout(r, 4000)),     // never hang on a write with no signal
      ]);
      showToast('Notifications are on for this device');
    } catch (e) {
      console.warn('[notify] could not turn on', e);
      showToast('Could not turn notifications on — ' + (e.message || 'unknown problem'));
    } finally {
      render();
    }
  };

  window.ntfTurnOff = async function () {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) {
        const id = await subId(sub);
        await sub.unsubscribe();
        Promise.resolve(window.YDDb.remove('pushSubs', id)).catch(() => {});
      }
      showToast('Notifications are off for this device');
    } catch (e) { showToast('Could not turn notifications off'); }
    render();
  };

  // ----------------------------------------------------------- preferences

  async function loadPrefs() {
    const base = Object.assign({}, DEFAULTS[isOwner() ? 'owner' : 'crew']);
    try {
      const saved = await window.YDDb.get('digestPrefs', me().uid);
      prefs = Object.assign(base, saved || {});
    } catch (e) { prefs = base; }
  }

  window.ntfSet = function (key, on) {
    if (!prefs) return;
    prefs[key] = !!on;
    Promise.resolve(window.YDDb.put('digestPrefs', me().uid, { [key]: !!on, updatedAt: new Date().toISOString() }))
      .catch(e => console.warn('[notify] preference not yet saved', e.code || e.message));
  };

  // ------------------------------------------------------------------ screen

  window.openNotifications = async function () {
    const m = el('ntfModal');
    if (!m || !me() || !window.YDDb) return;
    m.classList.add('active');
    el('ntfBody').innerHTML = '<p class="empty-msg">Loading…</p>';
    await loadPrefs();
    render();
  };
  window.closeNotifications = function () { const m = el('ntfModal'); if (m) m.classList.remove('active'); };

  async function render() {
    const body = el('ntfBody');
    if (!body || !prefs) return;
    const state = await deviceState();
    const u = me();
    const deviceHtml = {
      on: '<p class="ntf-ok">✓ Notifications are on for this device.</p>' +
          '<button class="btn btn-sm" onclick="ntfTurnOff()">Turn off on this device</button>',
      off: '<p>Get a short notification on this device with each update. Tap it to open Job Hub.</p>' +
           '<button class="btn btn-filled" id="ntfDeviceBtn" onclick="ntfTurnOn()">Turn on notifications here</button>',
      blocked: '<p class="ntf-warn">Notifications are blocked for Job Hub on this device. Allow them in the ' +
               'phone’s settings (Settings → Notifications → Job Hub), then come back here.</p>',
      'needs-home-screen': '<p class="ntf-warn">On an iPhone, notifications only work from the home-screen app. ' +
               'In Safari tap Share → Add to Home Screen, open Job Hub from there, and turn them on.</p>',
      unsupported: '<p class="ntf-warn">This browser cannot show notifications. The email summaries still work.</p>',
    }[state];

    body.innerHTML =
      '<div class="ntf-block"><div class="ntf-head">This device</div>' + deviceHtml + '</div>' +
      '<div class="ntf-block"><div class="ntf-head">Send me</div>' +
        toggle('email', 'Email', 'to ' + esc(u.email || 'your address')) +
        toggle('push', 'Phone notifications', 'on every device you have turned them on for') +
      '</div>' +
      '<div class="ntf-block"><div class="ntf-head">Which updates</div>' +
        SLOT_INFO.map(([k, label, hint]) => toggle(k, label, hint)).join('') +
        '<div class="hint">' + (isOwner()
          ? 'Yours has the weather, everything on today’s calendar (personal events included), bids to chase, ' +
            'and at the end of the day who worked where and for how long.'
          : 'Yours has the weather, where you are working, storm news, and your own hours.') + '</div>' +
      '</div>' +
      (isOwner() ? '<div class="ntf-block"><div class="ntf-head">Try it</div>' +
        '<div class="field-actions">' +
          SLOT_INFO.map(([k, label]) => '<button class="btn btn-sm" onclick="ntfPreview(\'' + k + '\')">See ' + label + '</button>').join('') +
          '<button class="btn btn-sm btn-filled" onclick="ntfTest()">Email + notify me a test now</button>' +
        '</div><div id="ntfPreview"></div></div>' : '');
  }

  function toggle(key, label, hint) {
    return '<label class="ntf-toggle"><input type="checkbox"' + (prefs[key] ? ' checked' : '') +
      ' onchange="ntfSet(\'' + key + '\', this.checked)"><span><b>' + esc(label) + '</b><small>' + hint + '</small></span></label>';
  }

  window.ntfPreview = async function (slot) {
    const box = el('ntfPreview');
    if (!box) return;
    box.innerHTML = '<p class="empty-msg">Building it…</p>';
    try {
      const r = await server('/digest/preview', { slot: slot });
      const mine = (r.report || [])[0];
      if (!mine || !mine.html) { box.innerHTML = '<p class="empty-msg">Nothing to send for that one right now.</p>'; return; }
      // Shown in a sandboxed frame: it is the email exactly as it would arrive.
      box.innerHTML = '<div class="ntf-push-preview"><b>' + esc(mine.push.title) + '</b><br>' + esc(mine.push.body) + '</div>' +
        '<iframe class="ntf-frame" sandbox="" title="Summary preview"></iframe>';
      box.querySelector('iframe').srcdoc = mine.html;
    } catch (e) {
      box.innerHTML = '<p class="ntf-warn">' + esc(e.message) + '</p>';
    }
  };

  window.ntfTest = async function () {
    try {
      const r = await server('/digest/preview', { slot: 'morning', send: true });
      const mine = (r.report || [])[0] || {};
      showToast('Email: ' + (mine.email || 'off') + ' · phone: ' +
        (typeof mine.push === 'number' ? mine.push + ' device(s)' : (mine.push || 'off')));
    } catch (e) { showToast(e.message); }
  };

  // --------------------------------------------------------------- wiring

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const item = el('menuNotify');
    if (item) item.hidden = !on;
    prefs = null;
    // A notification opens the app at #calendar (or another tab): go there once
    // signed in, then clear it so a reload does not keep jumping back.
    if (on && location.hash && typeof switchTab === 'function') {
      const want = location.hash.slice(1);
      if (typeof TABS !== 'undefined' && TABS.indexOf(want) !== -1) {
        const btn = el(tabButtonId(want));
        if (btn && !btn.hidden) switchTab(want);
      }
      history.replaceState(null, '', location.pathname + location.search);
    }
  });
})();
