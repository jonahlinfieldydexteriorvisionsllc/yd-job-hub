// Monthly bills: every recurring bill, business and home, and each month
// whether it is paid. Jonah (2 Nov 2026, on the expenses overhaul): "make
// somewhere in jobhub that shows all my monthly expenses and tracks them once
// paid."
//
// ⋯ → All settings → 📅 Monthly bills (and Home's Waiting on you when one is
// due within DUE_SOON_DAYS or late). Owner only: settings/monthlyBills
//   bills: { id: { name, match (words in the store's name on its receipts),
//            cents, day (of the month), every 'month'|'year', month (1-12,
//            a yearly one), area 'business'|'home', how, note, off, order } }
//   paid:  { 'YYYY-MM': { id: { at, by, cents, receiptId, how 'hand'|'receipt' } } }
// Paid by hand with a tap, or by itself when a receipt from that store comes
// in that month for about the bill's amount (Receipts, receipts.js) -- most
// loans and the mortgage pay from the bank and send no receipt, so the tap is
// the usual way. Nothing here moves money or touches QuickBooks.
(function () {
  'use strict';

  const DOC = 'monthlyBills';
  const DUE_SOON_DAYS = 3;
  const NEAR = 0.15;                // a receipt within 15% of the bill's amount is its payment
  const el = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safe = v => String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '');
  const owner = () => !!(window.YDAuth && YDAuth.isOwner && YDAuth.mode === 'cloud' && YDAuth.user);
  const money = c => '$' + (Math.round(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pad = n => String(n).padStart(2, '0');
  const ymOf = d => d.getFullYear() + '-' + pad(d.getMonth() + 1);
  const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').split(/\s+/).filter(Boolean);

  let data = null;                  // settings/monthlyBills as last read
  let month = ymOf(new Date());     // the month on screen
  let area = '';                    // '' every bill, else business | home
  let editing = null;               // a bill id being changed, 'new', or null

  function read() {
    return Promise.resolve(window.YDDb.getFresh('settings', DOC)).then(d => {
      data = Object.assign({ bills: {}, paid: {} }, d || {});
      return data;
    });
  }
  function save(patch, what) {
    Promise.resolve(window.YDDb.put('settings', DOC, Object.assign(patch, { updatedAt: new Date().toISOString() })))
      .catch(e => { console.warn('[bills] not saved:', (e && e.code) || e); showToast('Not saved yet (' + what + ') — it goes when there is signal'); });
  }

  // The bills that fall in `ym`, each with its due day there.
  function billsIn(ym) {
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return Object.entries((data && data.bills) || {}).map(([id, b]) => Object.assign({ id }, b))
      .filter(b => !b.off && (b.every !== 'year' || Number(b.month) === m) && (!area || (b.area || 'business') === area))
      .map(b => Object.assign(b, { due: ym + '-' + pad(Math.min(Math.max(1, Number(b.day) || 1), last)) }))
      .sort((a, b) => a.due.localeCompare(b.due) || String(a.name).localeCompare(String(b.name)));
  }
  const paidOf = (ym, id) => (((data && data.paid) || {})[ym] || {})[id] || null;
  const todayYmd = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const daysTo = day => Math.round((new Date(day + 'T12:00:00') - new Date(todayYmd() + 'T12:00:00')) / 864e5);

  // Receipts that pay a bill this month: the store's name has the bill's
  // words, its date is in the month, its amount near the bill's.
  function fromReceipts(ym) {
    if (!window.YDReceipts || !YDReceipts.all || !(YDReceipts.loaded && YDReceipts.loaded())) return {};
    const out = {};
    const all = Object.entries(YDReceipts.all() || {});
    billsIn(ym).forEach(b => {
      const want = words(b.match || b.name);
      if (!want.length || paidOf(ym, b.id)) return;
      const hit = all.find(([, r]) => r && String(r.date || '').slice(0, 7) === ym && r.status !== 'notreceipt' &&
        want.every(w => words(r.vendor).indexOf(w) !== -1) &&
        (!b.cents || Math.abs(Math.abs(Number(r.totalCents) || 0) - b.cents) <= b.cents * NEAR));
      if (hit) out[b.id] = { at: new Date().toISOString(), by: 'Job Hub', cents: Math.abs(Number(hit[1].totalCents) || 0),
                              receiptId: hit[0], how: 'receipt' };
    });
    return out;
  }
  function tickFromReceipts() {
    if (!owner() || !data) return;
    const ym = ymOf(new Date());
    const found = fromReceipts(ym);
    if (!Object.keys(found).length) return;
    data.paid = Object.assign({}, data.paid, { [ym]: Object.assign({}, (data.paid || {})[ym], found) });
    save({ paid: { [ym]: found } }, 'ticking bills paid');
  }

  // For Home: the bills due within DUE_SOON_DAYS or late, this month, not paid.
  function due() {
    if (!owner() || !data) return [];
    const ym = ymOf(new Date()), keep = area;
    area = '';
    const list = billsIn(ym).filter(b => !paidOf(ym, b.id) && daysTo(b.due) <= DUE_SOON_DAYS);
    area = keep;
    return list;
  }

  // ------------------------------------------------------------ the screen

  function modal() {
    let m = el('billsModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal-overlay';
      m.id = 'billsModal';
      m.onclick = ev => { if (ev.target === m) m.classList.remove('active'); };
      m.innerHTML = '<div class="modal" style="max-width:620px"><div class="modal-head"><h2>📅 Monthly bills</h2>' +
        '<button class="modal-close">&times;</button></div><div class="modal-body" id="billsBody"></div></div>';
      m.querySelector('.modal-close').onclick = () => m.classList.remove('active');
      document.body.appendChild(m);
    }
    m.classList.add('active');
    return el('billsBody');
  }
  function monthWords(ym) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  const dayWords = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  // The day it was ticked, here (not the UTC day of the stamp).
  const paidDay = at => { const t = new Date(at); return isNaN(t) ? '' : t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };

  function draw() {
    const body = el('billsBody');
    if (!body || !data) return;
    const list = billsIn(month), now = ymOf(new Date());
    const total = list.reduce((t, b) => t + (b.cents || 0), 0);
    const paid = list.filter(b => paidOf(month, b.id));
    const paidCents = paid.reduce((t, b) => t + ((paidOf(month, b.id) || {}).cents || b.cents || 0), 0);
    const chip = (v, label) => '<button type="button" class="btn btn-sm' + (area === v ? ' btn-filled' : '') + '" onclick="billsArea(\'' + v + '\')">' + label + '</button>';
    const rows = list.map(b => {
      const p = paidOf(month, b.id), id = safe(b.id), d = daysTo(b.due);
      const state = p
        ? '<span class="inv-chip">✓ Paid ' + esc(paidDay(p.at)) + (p.how === 'receipt' ? ' · its receipt' : '') + '</span> ' +
          '<button type="button" class="link-btn" onclick="billsPaid(\'' + id + '\', false)">Undo</button>'
        : '<span class="inv-chip' + (month === now && d < 0 ? ' due' : '') + '">' + (month === now && d < 0 ? 'Late — was due ' : 'Due ') +
          esc(dayWords(b.due)) + '</span> <button type="button" class="btn btn-sm btn-filled" onclick="billsPaid(\'' + id + '\', true)">✓ Paid</button>';
      return '<div class="ji-row' + (p ? ' handled' : '') + '"><div class="ji-top"><b>' + esc(b.name) + '</b>' +
        '<span class="muted">' + (b.cents ? money(b.cents) : 'amount?') + (b.every === 'year' ? ' · yearly' : '') +
          (b.how ? ' · ' + esc(b.how) : '') + ' · ' + (b.area === 'home' ? '🏠 Home' : '🛠 Business') + '</span></div>' +
        (b.note ? '<div class="ji-note">' + esc(b.note) + '</div>' : '') +
        '<div class="ji-acts">' + state + ' <button type="button" class="link-btn" onclick="billsEdit(\'' + id + '\')">Change</button></div>' +
        (editing === b.id ? formHtml(Object.assign({ id: b.id }, draft)) : '') + '</div>';
    }).join('');
    body.innerHTML =
      '<div class="field-actions"><button type="button" class="btn btn-sm" onclick="billsMonth(-1)">◀</button> <b>' + esc(monthWords(month)) + '</b> ' +
        '<button type="button" class="btn btn-sm" onclick="billsMonth(1)">▶</button></div>' +
      '<div class="field-actions">' + chip('', 'All') + chip('business', '🛠 Business') + chip('home', '🏠 Home') + '</div>' +
      '<p><b>' + money(paidCents) + '</b> of ' + money(total) + ' paid · ' + (list.length - paid.length) + ' of ' + list.length + ' still to pay</p>' +
      (rows || '<p class="empty-msg">No bills here yet.</p>') +
      (editing === 'new' ? formHtml(Object.assign({ id: 'new' }, draft))
        : '<div class="field-actions"><button type="button" class="btn btn-sm" onclick="billsEdit(\'new\')">+ Add a bill</button></div>') +
      '<p class="muted">A bill ticks itself paid when a receipt from that store comes in that month for about its amount (Receipts). ' +
        'Loans and the mortgage that pay from the bank send none — tap ✓ Paid.</p>';
  }
  function formHtml(b) {
    const f = (id, label, v, type, ph) => '<label class="field"><span class="label">' + label + '</span><input id="bf_' + id + '" type="' + (type || 'text') +
      '" value="' + esc(v == null ? '' : v) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '></label>';
    const pick = (name, v, label) => '<button type="button" class="btn btn-sm' + ((b[name] || '') === v ? ' btn-filled' : '') +
      '" onclick="billsPick(\'' + name + '\', \'' + v + '\')">' + label + '</button>';
    return '<div class="bills-form" style="margin-top:8px">' +
      f('name', 'What it is', b.name, 'text', 'e.g. Truck loan') +
      f('amount', 'Amount', b.cents ? (b.cents / 100).toFixed(2) : '', 'number') +
      f('day', 'Day of the month it is due', b.day || '', 'number') +
      '<div class="field-actions">' + pick('area', 'business', '🛠 Business') + pick('area', 'home', '🏠 Home') + ' · ' +
        pick('every', 'month', 'Every month') + pick('every', 'year', 'Once a year') + '</div>' +
      (b.every === 'year' ? f('month', 'Which month (1–12)', b.month || '', 'number') : '') +
      f('how', 'How it is paid', b.how, 'text', 'e.g. autopay from checking') +
      f('match', 'Store name on its receipts (to tick it by itself)', b.match, 'text', 'optional') +
      f('note', 'Note', b.note, 'text', '') +
      '<div class="field-actions"><button type="button" class="btn btn-sm btn-filled" onclick="billsSave(\'' + safe(b.id) + '\')">Save</button> ' +
        '<button type="button" class="link-btn" onclick="billsEdit(null)">Cancel</button>' +
        (b.id !== 'new' ? ' <button type="button" class="link-btn" onclick="billsOff(\'' + safe(b.id) + '\')">Stopped — take it off</button>' : '') + '</div></div>';
  }

  let draft = {};
  window.openMonthlyBills = function () {
    if (!owner()) return;
    modal().innerHTML = '<p class="muted">Loading…</p>';
    read().then(() => { tickFromReceipts(); draw(); }).catch(() => { el('billsBody').innerHTML = '<p>Needs signal to open.</p>'; });
  };
  window.billsMonth = n => {
    const [y, m] = month.split('-').map(Number);
    month = ymOf(new Date(y, m - 1 + n, 1));
    editing = null;
    draw();
  };
  window.billsArea = v => { area = v; draw(); };
  window.billsEdit = id => {
    editing = id;
    draft = id && id !== 'new' ? Object.assign({}, data.bills[id]) : { area: area || 'business', every: 'month' };
    draw();
  };
  window.billsPick = (name, v) => {
    // What is typed so far stays: the form is drawn again from the draft.
    ['name', 'day', 'month', 'how', 'match', 'note'].forEach(k => { const i = el('bf_' + k); if (i) draft[k] = i.value; });
    const a = el('bf_amount');
    if (a) draft.cents = Math.round(parseFloat(a.value.replace(/[$,]/g, '')) * 100) || 0;
    draft[name] = v;
    draw();
  };
  window.billsSave = id => {
    const v = k => { const i = el('bf_' + k); return i ? i.value.trim() : ''; };
    const name = v('name');
    if (!name) { showToast('What is the bill?'); return; }
    const cents = Math.round(parseFloat(v('amount').replace(/[$,]/g, '')) * 100) || 0;
    const rec = { name: name.slice(0, 80), cents: cents, day: Math.min(31, Math.max(1, parseInt(v('day'), 10) || 1)),
      every: draft.every === 'year' ? 'year' : 'month', month: draft.every === 'year' ? (parseInt(v('month'), 10) || 1) : null,
      area: draft.area === 'home' ? 'home' : 'business', how: v('how').slice(0, 80), match: v('match').slice(0, 60),
      note: v('note').slice(0, 200), off: false };
    const key = id === 'new' ? 'mb' + Date.now().toString(36) : id;
    data.bills = Object.assign({}, data.bills, { [key]: Object.assign({}, data.bills[key], rec) });
    save({ bills: { [key]: rec } }, 'saving the bill');
    editing = null;
    draw();
  };
  window.billsOff = id => {
    if (!data.bills[id]) return;
    data.bills[id] = Object.assign({}, data.bills[id], { off: true });
    save({ bills: { [id]: { off: true } } }, 'taking the bill off');
    editing = null;
    draw();
    showUndo(data.bills[id].name + ' taken off', () => {
      data.bills[id].off = false;
      save({ bills: { [id]: { off: false } } }, 'putting the bill back');
      draw();
    });
  };
  window.billsPaid = (id, on) => {
    const b = data.bills[id];
    if (!b) return;
    const rec = on ? { at: new Date().toISOString(), by: 'Jonah', cents: b.cents || 0, receiptId: null, how: 'hand' } : null;
    const cur = Object.assign({}, (data.paid || {})[month]);
    if (rec) cur[id] = rec; else delete cur[id];
    data.paid = Object.assign({}, data.paid, { [month]: cur });
    // A tick taken off is written as null: put() merges, a key left out stays.
    save({ paid: { [month]: { [id]: rec } } }, on ? 'ticking it paid' : 'taking the tick off');
    draw();
    document.dispatchEvent(new CustomEvent('yd-bills'));
  };

  document.addEventListener('yd-auth', () => {
    if (owner()) read().then(() => { tickFromReceipts(); document.dispatchEvent(new CustomEvent('yd-bills')); }).catch(() => {});
  });
  document.addEventListener('yd-receipts', () => { if (data) tickFromReceipts(); });

  window.YDMonthlyBills = { due: due, open: () => window.openMonthlyBills() };
})();
