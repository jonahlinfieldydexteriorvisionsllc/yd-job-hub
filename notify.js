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

  // autoRemind: everything on the calendar and every card of theirs buzzes
  // the phone without a reminder set on each (remind.js; Jonah, 12 Oct
  // 2026) -- everyone's on until they turn it off ("make it so crew members
  // can get notifications"). functions/digest.py DEFAULT_PREFS says the same.
  const DEFAULTS = {
    owner: { email: true, push: true, morning: true, midday: true, evening: true, autoRemind: true, crewActivity: true },
    crew: { email: false, push: true, morning: true, midday: true, evening: true, autoRemind: true, crewActivity: false },
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
  // The midday summary is the owner's and the admins' (digest.py _gets_midday).
  const middayFor = () => isOwner() || !!(window.YDAuth && (window.YDAuth.isAdmin || window.YDAuth.role === 'admin'));
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

  // Gives up on a promise that may never settle, with a reason to show.
  function within(promise, ms, why) {
    return Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error(why)), ms))]);
  }

  async function currentSub() {
    const reg = await navigator.serviceWorker.getRegistration();
    return (reg && await reg.pushManager.getSubscription()) || null;
  }

  // A browser's push subscription belongs to the phone, not to whoever is
  // signed in. On a shared phone it was reported as "on" to the next person
  // while every summary still went to the one who switched it on -- so it only
  // counts as on when the record of it says it is this person's. A record that
  // cannot be read (somebody else's, or none yet) counts as not theirs.
  async function mineOnThisDevice(sub) {
    const u = me();
    if (!u || !window.YDDb) return false;
    try {
      const rec = await window.YDDb.get('pushSubs', await subId(sub));
      return !!(rec && rec.uid === u.uid);
    } catch (e) { return false; }
  }

  async function deviceState() {
    if (!pushSupported()) return isIOS() && !standalone() ? 'needs-home-screen' : 'unsupported';
    if (Notification.permission === 'denied') return 'blocked';
    const sub = await currentSub();
    return sub && await mineOnThisDevice(sub) ? 'on' : 'off';
  }

  window.ntfTurnOn = async function () {
    const btn = el('ntfDeviceBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Turning on…'; }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { showToast('Notifications were not allowed on this device'); return; }
      // `ready` never settles when no service worker is registered (the local
      // dev server deliberately has none), which left this button stuck on
      // "Turning on…" for good.
      const reg = await within(navigator.serviceWorker.ready, 8000,
        'the app is not fully installed on this device yet — reload Job Hub and try again');
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
    // Storm watch: the owner and admins hear it unless they switch it off,
    // the crew only once they switch it on (functions/stormwatch.py who_hears).
    base.stormWatch = isOwner() || !!(window.YDAuth && (window.YDAuth.isAdmin || window.YDAuth.role === 'admin'));
    try {
      const saved = await window.YDDb.get('digestPrefs', me().uid);
      prefs = Object.assign(base, saved || {});
    } catch (e) { prefs = base; }
  }

  window.ntfSet = function (key, on) {
    if (!prefs) return;
    prefs[key] = !!on;
    if (key === 'autoRemind' && window.YDRemind) YDRemind.setAuto(on);
    Promise.resolve(window.YDDb.put('digestPrefs', me().uid, { [key]: !!on, updatedAt: new Date().toISOString() }))
      .catch(e => console.warn('[notify] preference not yet saved', e.code || e.message));
  };

  // ------------------------------------------------------------------ screen

  // The window's title matches the menu item that opens it (the menu said
  // "Notification settings", the window "Notifications & summaries").
  function titled(m, words) { const h = m.querySelector('.modal-head h2'); if (h) h.textContent = words; }

  window.openNotifications = async function () {
    const m = el('ntfModal');
    if (!m || !me() || !window.YDDb) return;
    titled(m, '🔔 Notification settings');
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
    // Crew (and admins) get the short version: the owner's words explain
    // things only he sees -- the crew's activity, the test buttons.
    const owner = isOwner();
    const deviceHtml = {
      on: '<p class="ntf-ok">✓ Notifications are on for this device.</p>' +
          '<button class="btn btn-sm" onclick="ntfTurnOff()">Turn off on this device</button>',
      off: '<p>Get a short notification on this device with each update. Tap it to open Job Hub.</p>' +
           '<button class="btn btn-filled" id="ntfDeviceBtn" onclick="ntfTurnOn()">Turn on notifications here</button>',
      // A computer has no Settings → Notifications → Job Hub: there it is the
      // browser's own permission for the site (office test, 16 Oct 2026).
      blocked: '<p class="ntf-warn">Notifications are blocked for Job Hub on this device. ' +
               (window.matchMedia && window.matchMedia('(pointer: coarse)').matches
                 ? 'Allow them in the device’s settings (Settings → Notifications → Job Hub), then come back here.'
                 : 'Allow them in the browser: the icon at the left of the address bar → Notifications → Allow, then come back here.') + '</p>',
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
      '<div class="ntf-block"><div class="ntf-head">Reminders</div>' +
        toggle('autoRemind', 'Remind me of everything', owner
          ? 'every calendar entry I can see and every card that is mine — no need to set a reminder on each one'
          : 'everything on my day and every card that is mine') +
        '<div class="hint">' + (owner
          ? 'Bid appointments 1 hour and 30 minutes before. Anything else at a set time, 30 minutes before. ' +
            'Things for any time that day, one list at 7 am — headed by any task from the days before that was never ' +
            'ticked off. A crew task reminds the people on it — or, with nobody on ' +
            'it, every crew member. One thing’s own ' +
            'Remind box changes its reminder or switches it off.'
          : 'Anything at a set time: 30 minutes before. Things for any time that day: one list at 7 am. ' +
            'A crew task with nobody named on it reminds the whole crew.') + '</div>' +
        // Jonah (12 Oct 2026): told "whenever the guys adds a card or something
        // to a calendar or makes a change" (functions/reminders.py _activity).
        (isOwner() ? toggle('crewActivity', 'When the crew add or change something',
          'a card or calendar entry added, changed, finished or ticked off by anyone but you — one buzz every few minutes at most') : '') +
        // Storm watch (functions/stormwatch.py), November to April.
        toggle('stormWatch', '❄️ When plowable snow is coming',
          'November to April: when the forecast reaches the plow depth of any snow account, or freezing rain is ' +
          'coming — once per snowfall, and at night only when it starts by morning') +
      '</div>' +
      '<div class="ntf-block"><div class="ntf-head">Which updates</div>' +
        // Jonah (15 Oct 2026): "turn off midday summary for crew: leave on for
        // admins." A crew member is not offered it (functions/digest.py
        // never sends it to them, whatever their setting says).
        SLOT_INFO.filter(([k]) => k !== 'midday' || middayFor()).map(([k, label, hint]) => toggle(k, label, hint)).join('') +
        (middayFor() ? '' : '<div class="hint">Midday summary: owners and admins only.</div>') +
        '<div class="hint">' + (isOwner()
          ? 'Yours has the weather, everything on today’s calendar (personal events included), bids to chase, ' +
            'and at the end of the day who worked where and for how long, and every task — yours and the crew’s — ' +
            'not ticked off.'
          : window.YDAuth && window.YDAuth.isAdmin
          ? 'Yours has the weather, where you are working, storm news and your own hours — plus the calendars, ' +
            'bids and crew hours you have been given access to. At the end of the day, your tasks not ticked off.'
          : 'The weather, where you are working, storm news and your hours — and at the end of the day, ' +
            'any task of yours not ticked off.') + '</div>' +
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
        '<iframe class="ntf-frame" sandbox="' + FRAME_SANDBOX + '" title="Summary preview"></iframe>';
      box.querySelector('iframe').srcdoc = framed(mine.html);
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

  // -------------------------------------------------------------- summaries
  //
  // Jonah (9 Oct 2026): "id prefer to view them in the app rather than my
  // email." The server keeps each summary it sends for two weeks
  // (summaries/{uid}_{day}_{slot}, digest.py _keep; each person reads only
  // their own) and the phone notification opens this. Shown in a sandboxed
  // frame: the email's own page, exactly as it would have arrived.
  // The summary's "Open Job Hub" opens in a tab of its own: in a fully
  // sandboxed frame it went nowhere at all. The frame still runs no scripts
  // and cannot reach into Job Hub; the tab the link opens is an ordinary one
  // (escape-sandbox), or Job Hub could not run in it.
  const FRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';
  const framed = html => '<base target="_blank">' + String(html || '');
  const SLOT_ICON = { morning: '☀️', midday: '🕛', evening: '🌙' };
  const SLOT_WORD = { morning: 'Morning', midday: 'Midday', evening: 'End of day' };
  let summaries = {}, sumUnsub = null, sumShown = null;

  window.openSummaries = function () {
    const m = el('sumModal'), u = me();
    if (!m || !u || !window.YDDb) return;
    titled(m, '📰 Past summaries');
    m.classList.add('active');
    summaries = {}; sumShown = null;
    el('sumBody').innerHTML = '<p class="empty-msg">Loading…</p>';
    if (sumUnsub) sumUnsub();
    sumUnsub = window.YDDb.watchWhere('summaries', 'uid', u.uid, changes => {
      changes.forEach(c => { if (c.type === 'removed') delete summaries[c.id]; else summaries[c.id] = Object.assign({ id: c.id }, c.data); });
      renderSummaries();
    }, () => { el('sumBody').innerHTML = '<p class="ntf-warn">Summaries could not be loaded yet.</p>'; });
  };
  window.closeSummaries = function () {
    const m = el('sumModal'); if (m) m.classList.remove('active');
    if (sumUnsub) { sumUnsub(); sumUnsub = null; }
  };
  window.showSummary = function (id) { sumShown = id; renderSummaries(); };

  function sumLabel(s) {
    const d = new Date(String(s.day || '') + 'T12:00:00');
    return (SLOT_ICON[s.slot] || '📰') + ' ' + (isNaN(d) ? '' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })) +
      ' · ' + (SLOT_WORD[s.slot] || s.slot || '');
  }
  function renderSummaries() {
    const body = el('sumBody');
    if (!body) return;
    const list = Object.values(summaries).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    if (!list.length) {
      body.innerHTML = '<p class="empty-msg">No summaries here yet. The next one lands at 5:00 am (morning) or 5:30 pm (end of day).</p>' +
        '<div class="field-actions"><button class="btn btn-sm" onclick="closeSummaries(); openNotifications()">Change what you get</button></div>';
      return;
    }
    const shown = list.find(s => s.id === sumShown) || list[0];
    body.innerHTML = '<div class="sum-pick">' + list.map(s => '<button class="sum-chip' + (s.id === shown.id ? ' on' : '') +
        '" onclick="showSummary(\'' + String(s.id).replace(/[^A-Za-z0-9_-]/g, '') + '\')">' + esc(sumLabel(s)) + '</button>').join('') + '</div>' +
      '<iframe class="ntf-frame sum-frame" sandbox="' + FRAME_SANDBOX + '" title="' + esc(shown.subject || 'Summary') + '"></iframe>' +
      '<div class="field-actions"><button class="btn btn-sm" onclick="closeSummaries(); openNotifications()">Change what you get</button></div>';
    body.querySelector('iframe').srcdoc = framed(shown.html);
  }

  // --------------------------------------------------------------- wiring

  // Signing out switches this phone's notifications off. They belong to the
  // person, not the phone: left on, whoever signs in next on a shared phone
  // would go on receiving the last person's summaries -- and the owner's has
  // his personal calendar in it. Run just before sign-out, while still signed
  // in, so the record can still be deleted under this person's name.
  async function forgetThisDevice() {
    try {
      if (!pushSupported()) return;
      // Both waits together stay inside the two seconds sign-out allows.
      const sub = await within(currentSub(), 600, 'no answer');
      if (!sub) return;
      const id = await subId(sub);
      // Not awaited: with no signal it goes when the signal returns. Pushes to
      // a subscription that no longer exists are simply refused anyway.
      if (window.YDDb) Promise.resolve(window.YDDb.remove('pushSubs', id)).catch(() => {});
      await within(sub.unsubscribe(), 1200, 'no answer');
    } catch (e) {
      console.warn('[notify] could not switch this device off at sign-out', e && e.message);
    }
  }
  (window.YDSignOutHooks = window.YDSignOutHooks || []).push(forgetThisDevice);

  // My day (calendar.js) asks whether this phone will get the reminders.
  window.YDNotify = { deviceState: deviceState };

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const item = el('menuNotify');
    if (item) item.hidden = !on;
    const sum = el('menuSummaries');
    if (sum) sum.hidden = !on;
    prefs = null;
    if (!on) window.closeSummaries();
    // A notification opens the app at #calendar (or another tab, or
    // #summary): go there once signed in, then clear it so a reload does not
    // keep jumping back.
    if (on && location.hash && typeof switchTab === 'function') {
      const want = location.hash.slice(1);
      if (want === 'summary') window.openSummaries();
      else if (want === 'notes' && window.openCrewNotes) window.openCrewNotes();
      // The end of the day (eod.js): the list itself, or the owner's reports.
      else if (want === 'eod' && window.openEndOfDay) window.openEndOfDay();
      else if (want === 'eodreports' && window.openEodReports) window.openEodReports();
      else if (typeof TABS !== 'undefined' && TABS.indexOf(want) !== -1) {
        const btn = el(tabButtonId(want));
        if (btn && !btn.hidden) switchTab(want);
      }
      history.replaceState(null, '', location.pathname + location.search);
    }
  });
})();
