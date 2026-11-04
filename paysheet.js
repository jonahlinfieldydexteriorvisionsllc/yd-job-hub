// The pay sheet: one window with what each person is owed for the pay period.
//
// Jonah (the "Friday payroll sheet" card; 3 Nov 2026): "i usally pay every
// other friday through cashapp and bank payments. i am the only one
// who gets the sheet i need it by 6:00pm on friday."
//
// settings/paySheet (owner only, as settings are):
//   first   a pay day, 'YYYY-MM-DD'; every EVERY days from it is one. Until
//           he sets it, FIRST. The server has the same (functions/paysheet.py).
//   paid    {payDay: {uid: {cents, how, at}}}: pay marked here, by Cash App,
//           cash or the bank. (The bank's emails stopped on 1 Oct 2026, so
//           most of it comes this way for now.)
//
// A period is the EVERY days ending on the pay day. Hours, wages and what is
// waiting come from Hours & Wages' own sum (YDClock.totalsFor), so the sheet
// and that screen can't disagree. Paid is any bank payments Job Hub has read
// (paychecks.js) dated around the pay day, plus the ones marked here. Each
// person's line is worked out when the window opens: a shift approved after
// that is counted the next time, and nothing is stored but the hand-typed pay.

(function () {
  'use strict';

  const FIRST = '2026-11-06';     // paysheet.py FIRST
  const EVERY = 14;               // paysheet.py EVERY_DAYS
  // Bank payments counted toward a pay day: a few days either side of it,
  // never reaching the next one's.
  const PAID_BEFORE = 3, PAID_AFTER = 10;
  // Home says so from this hour on a pay day.
  const HOME_FROM_HOUR = 12;

  const el = id => document.getElementById(id);
  const safeId = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const owner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const dollars = c => fmtMoney((Number(c) || 0) / 100);
  const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const dayNo = ymd => Math.round(Date.parse(ymd + 'T12:00:00Z') / 86400000);
  function addDays(ymd, n) {
    const d = new Date(ymd + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return localYMD(d);
  }
  const startOf = ymd => new Date(ymd + 'T00:00:00').getTime();
  const longDay = ymd => new Date(ymd + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  let cfg = null;       // settings/paySheet, once read
  let shown = '';       // the pay day on the screen

  const first = () => (cfg && isDay(cfg.first) ? cfg.first : FIRST);
  // The pay day on or after `day`.
  function payDayFrom(day) {
    const off = ((dayNo(day) - dayNo(first())) % EVERY + EVERY) % EVERY;
    return addDays(day, off ? EVERY - off : 0);
  }
  const typedPaid = pay => Object.entries(((cfg && cfg.paid) || {})[pay] || {}).filter(([, v]) => v && v.cents > 0);

  function load() {
    if (!owner() || !window.YDDb) return;
    Promise.resolve(YDDb.get('settings', 'paySheet')).then(d => {
      cfg = d || {};
      document.dispatchEvent(new CustomEvent('yd-paysheet'));
      if (isOpen()) draw();
    }).catch(() => {});
  }
  function save(patch) {
    Promise.resolve(YDDb.put('settings', 'paySheet', Object.assign({}, patch, { updatedAt: new Date().toISOString() })))
      .catch(e => showToast(e && e.code === 'permission-denied' ? 'Not saved — not allowed' : 'Saved here — it goes up when there is signal'));
  }

  // ------------------------------------------------------------ the sum

  function sheetFor(pay) {
    const start = addDays(pay, 1 - EVERY);
    const t = YDClock.totalsFor(startOf(start), startOf(addDays(pay, 1)));
    const rows = {};
    const row = (uid, name) => rows[uid] = rows[uid] || { uid, name: name || 'Someone', ms: 0, cents: 0, bank: 0, typed: 0, how: '' };
    t.list.forEach(w => Object.assign(row(w.uid, w.name), { ms: w.paid, cents: w.cost, waiting: w.waiting }));
    const lo = addDays(pay, -PAID_BEFORE), hi = addDays(pay, PAID_AFTER);
    const people = (YDClock.people && YDClock.people()) || {};
    const checks = window.YDPaychecks && YDPaychecks.all ? YDPaychecks.all() : [];
    checks.filter(p => p.uid && p.date >= lo && p.date <= hi).forEach(p => {
      row(p.uid, (people[p.uid] || {}).name || p.payee).bank += p.cents || 0;
    });
    typedPaid(pay).forEach(([uid, v]) => {
      const r = row(uid, (people[uid] || {}).name);
      r.typed = v.cents; r.how = v.how || 'By hand';
    });
    const list = Object.values(rows).sort((a, b) => b.cents - a.cents);
    list.forEach(r => { r.paid = r.bank + r.typed; r.owed = r.cents - r.paid; });
    const running = Object.values(YDClock.shifts() || {}).filter(e => e && e.status === 'running' &&
      YDClock.startMsOf(e) >= startOf(start) && YDClock.startMsOf(e) < startOf(addDays(pay, 1)));
    return { pay, start, list, pending: t.pending, running, owed: list.reduce((s, r) => s + Math.max(0, r.owed), 0) };
  }

  const hoursOf = ms => (Math.round(ms / 36000) / 100).toFixed(2);

  // ------------------------------------------------------------ the window

  const isOpen = () => { const m = el('paySheetModal'); return !!(m && m.classList.contains('active')); };
  function modalBody() {
    let m = el('paySheetModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal-overlay';
      m.id = 'paySheetModal';
      m.innerHTML = '<div class="modal"><div class="modal-head"><h2>📄 Pay sheet</h2>' +
        '<button type="button" class="modal-close" aria-label="Close">&times;</button></div><div class="modal-body"></div></div>';
      m.onclick = ev => { if (ev.target === m) m.classList.remove('active'); };
      m.querySelector('.modal-close').onclick = () => m.classList.remove('active');
      document.body.appendChild(m);
    }
    m.classList.add('active');
    return m.querySelector('.modal-body');
  }

  function draw() {
    const m = el('paySheetModal');
    if (!m || !window.YDClock) return;
    const body = m.querySelector('.modal-body');
    const s = sheetFor(shown);
    const today = localYMD(new Date());
    const waiting = s.pending.length
      ? '<div class="ps-warn">⚠️ <b>' + s.pending.length + ' shift' + (s.pending.length === 1 ? '' : 's') + ' still waiting for your OK.</b> ' +
        'Not counted below until you approve ' + (s.pending.length === 1 ? 'it' : 'them') + '. ' +
        '<button class="link-btn" onclick="paySheetApprovals()">Go to them</button></div>' : '';
    const onClock = s.running.length
      ? '<div class="ps-note">🕒 ' + s.running.length + ' still on the clock: counted once they clock out.</div>' : '';
    const rows = s.list.length ? s.list.map(r => {
      const rate = r.ms > 0 ? ' · ' + dollars(Math.round(r.cents / (r.ms / 3600000))) + '/h' : '';
      return '<div class="ps-row"><div class="ps-top"><b>' + esc(r.name) + '</b><span class="ps-owed' + (r.owed > 0 ? '' : ' none') + '">' +
          (r.owed > 0 ? dollars(r.owed) + ' owed' : r.owed < 0 ? dollars(-r.owed) + ' over' : 'Paid up') + '</span></div>' +
        '<div class="ps-sub">' + hoursOf(r.ms) + ' h' + esc(rate) + ' · wages ' + dollars(r.cents) +
          (r.bank ? ' · bank ' + dollars(r.bank) : '') + (r.typed ? ' · ' + esc(r.how) + ' ' + dollars(r.typed) : '') + '</div>' +
        '<div class="ps-acts">' + (r.typed
          ? '<button class="link-btn" onclick="paySheetUnpaid(\'' + safeId(r.uid) + '\')">Take off the ' + esc(r.how) + ' payment</button>'
          : '<button class="btn btn-sm" onclick="paySheetPaid(\'' + safeId(r.uid) + '\')">✓ Mark paid</button>') + '</div></div>';
    }).join('') : '<p class="empty-msg">No hours in this pay period.</p>';
    body.innerHTML =
      '<div class="ps-head"><b>' + esc(longDay(s.start)) + ' – ' + esc(longDay(s.pay)) + '</b>' +
        '<span class="muted">' + (s.pay === today ? 'Pay day today' : s.pay > today ? 'Pay day ' + esc(longDay(s.pay)) : 'Paid ' + esc(longDay(s.pay))) + '</span></div>' +
      waiting + onClock + rows +
      (s.list.length ? '<div class="ps-total"><span>Still owed</span><b>' + dollars(s.owed) + '</b></div>' : '') +
      '<div class="field-actions">' +
        '<button class="btn btn-sm" onclick="paySheetGo(-1)">‹ Period before</button>' +
        '<button class="btn btn-sm" onclick="paySheetGo(1)">Next period ›</button>' +
        (s.list.length ? '<button class="btn btn-sm" onclick="paySheetCopy()">📋 Copy</button>' : '') +
      '</div>' +
      '<p class="hint">Is pay day a week off? <button class="link-btn" onclick="paySheetMove()">Move every pay day by a week</button></p>';
  }

  window.openPaySheet = function () {
    if (!owner() || !window.YDClock) return;
    shown = payDayFrom(localYMD(new Date()));
    modalBody();
    draw();
    load();
  };
  window.paySheetGo = function (n) {
    shown = addDays(shown, n * EVERY);
    draw();
  };
  window.paySheetApprovals = function () {
    const m = el('paySheetModal');
    if (m) m.classList.remove('active');
    switchTab('clock');
  };
  window.paySheetMove = function () {
    const next = addDays(first(), 7);
    cfg = Object.assign({}, cfg, { first: next });
    save({ first: next });
    shown = payDayFrom(localYMD(new Date()));
    draw();
    document.dispatchEvent(new CustomEvent('yd-paysheet'));
    showToast('Next pay day: ' + longDay(shown));
  };
  window.paySheetPaid = async function (uid) {
    const pay = shown, r = sheetFor(pay).list.find(x => safeId(x.uid) === uid);
    if (!r) return;
    const got = await ydForm('What ' + r.name + ' was paid for this period.', [
      { id: 'amount', label: 'Amount', value: r.owed > 0 ? (r.owed / 100).toFixed(2) : '' },
      { id: 'how', label: 'How (Cash App, bank, cash)', value: 'Cash App' },
    ], { title: 'Mark paid', ok: 'Save' });
    if (!got) return;
    const cents = Math.round(parseFloat(String(got.amount || '').replace(/[$,\s]/g, '')) * 100);
    if (!(cents > 0)) { showToast('Put in the amount'); return; }
    const rec = { cents, how: String(got.how || '').trim().slice(0, 30) || 'Cash App', at: new Date().toISOString() };
    cfg = cfg || {};
    cfg.paid = cfg.paid || {};
    cfg.paid[pay] = Object.assign({}, cfg.paid[pay], { [r.uid]: rec });
    save({ paid: { [pay]: { [r.uid]: rec } } });
    draw();
  };
  window.paySheetUnpaid = function (uid) {
    const row = Object.keys(((cfg && cfg.paid) || {})[shown] || {}).find(u => safeId(u) === uid);
    if (!row) return;
    cfg.paid[shown][row] = null;
    save({ paid: { [shown]: { [row]: null } } });
    draw();
  };
  window.paySheetCopy = function () {
    const s = sheetFor(shown);
    const text = ['Pay sheet ' + longDay(s.start) + ' - ' + longDay(s.pay)].concat(s.list.map(r =>
      r.name + ': ' + hoursOf(r.ms) + ' h, wages ' + dollars(r.cents) + ', paid ' + dollars(r.paid) + ', owed ' + dollars(Math.max(0, r.owed))),
      ['Still owed ' + dollars(s.owed)]).join('\n');
    Promise.resolve(navigator.clipboard && navigator.clipboard.writeText(text)).then(() => showToast('Copied'), () => showToast('Could not copy'));
  };

  // ------------------------------------------------------------ for Home

  document.addEventListener('yd-auth', () => {
    cfg = null;
    const b = el('paySheetBtn');
    if (b) b.hidden = !owner();
    load();
  });
  document.addEventListener('yd-clock-changed', () => { if (isOpen()) draw(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

  window.YDPaySheet = {
    // Today, from noon, when today is a pay day.
    dueToday: () => {
      if (!owner() || !cfg) return false;
      const t = localYMD(new Date());
      return payDayFrom(t) === t && new Date().getHours() >= HOME_FROM_HOUR;
    },
  };
})();
