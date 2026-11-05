// Monthly bills: every recurring bill, business and home, and each month
// whether it is paid. Jonah (2 Nov 2026, on the expenses overhaul): "make
// somewhere in jobhub that shows all my monthly expenses and tracks them once
// paid."
//
// Money → To pay (money.js; and Home's Waiting on you when one is due within
// DUE_SOON_DAYS or late). Owner only: settings/monthlyBills
//   bills: { id: { name, match (words in the store's name on its receipts),
//            cents, day (of the month), every 'month'|'year', month (1-12,
//            a yearly one), area 'business'|'home', how, note, off, order,
//            place (where its receipts file themselves, PLACES; '' = he sorts them) } }
//   paid:  { 'YYYY-MM': { id: { at, by, cents, receiptId, how 'hand'|'receipt' } } }
// Jonah, 4 Nov 2026: "i dont wanna mark my bills paid manually ... just pull
// the receipts from my email to match them." So a bill ticks itself when a
// receipt from that store comes in around its due day (fromReceipts). A bill
// that takes its own money, on a card or by autopay, and sends no email at all
// has nothing to match and nothing for him to do: it counts as gone through on
// its day and never asks (pays itself). What he pays himself still reminds him.
// A tap stays for the odd one. Nothing here moves money or touches QuickBooks.
//
// Jonah, 5 Nov 2026: his bookkeeper's payment sat waiting for a tap, because
// a payment email says who was paid and nothing else. A bill already names its
// store, so it says where that store's receipts go, and the email reader files
// them there by itself (functions/receipts.py _bill_place, the same match rule).
// A stopped bill still counts, its last receipts are still to come, so stopped
// bills stay on the screen in a fold, to change.
(function () {
  'use strict';

  const DOC = 'monthlyBills';
  const DUE_SOON_DAYS = 3;
  const NEAR = 0.15;                // a receipt within 15% of the bill's amount is its payment
  const WINDOW_DAYS = 12;           // how far from its due day a payment can land: the 31st for a bill due the 2nd
  const LOW_SHARE = 0.5;            // the only bill from a store can vary (electric), but not down to a different charge
  const TRAIL_DAYS = 120;           // a store with a receipt this recent sends them: silence from it means something
  const LATE_GRACE_DAYS = 5;        // its receipt can take this long to land before Home says so
  // Places that need no other pick. The same ids as receipts.py BILL_PLACES, in
  // receipts.js PLACE_LIST's words.
  const PLACES = [['llc', '🏢 LLC overhead'], ['office', '🗂 Office overhead'], ['shop', '🏠 Shop overhead'],
    ['property', '🌳 Property overhead'], ['equipment', '🚜 Equipment'], ['upkeep', '🔧 Equipment maintenance'],
    ['marketing', '📣 Marketing']];
  const placeName = id => (PLACES.find(p => p[0] === id) || [])[1] || '';
  // Bought for a job, or owed on a loan: never overhead (receipts.py NOT_BY_BILL).
  const NOT_BY_BILL = ['materials', 'plants', 'rental', 'loan_payment'];
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
    return Promise.resolve(window.YDDb.getFresh('settings', DOC))
      .catch(async e => {
        // No signal: the last copy on this phone, or the "needs signal" words.
        const kept = await window.YDDb.get('settings', DOC);
        if (!kept) throw e;
        return kept;
      })
      .then(d => {
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
  // A tick he took off a bill a receipt had ticked is kept as {off: true}:
  // that receipt does not tick it again.
  const markOf = (ym, id) => (((data && data.paid) || {})[ym] || {})[id] || null;
  const paidOf = (ym, id) => { const p = markOf(ym, id); return p && !p.off ? p : null; };
  // Receipts that are no payment: a bill still to pay, set aside, not a receipt.
  const NOT_PAID = ['topay', 'aside', 'notreceipt'];
  const stageOf = r => { try { const s = window.YDStages && YDStages.receipt ? YDStages.receipt(r) : null; return (s && (s.id || s.stage || s.key)) || r.status || ''; } catch (e) { return r.status || ''; } };
  const todayYmd = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const daysTo = day => Math.round((new Date(day + 'T12:00:00') - new Date(todayYmd() + 'T12:00:00')) / 864e5);

  const storeWords = b => words(b.match || b.name);
  const fromStore = (r, want) => want.length > 0 && want.every(w => words(r.vendor).indexOf(w) !== -1);
  const gap = (a, b) => Math.abs(Math.round((new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / 864e5));
  const allBills = () => { const keep = area; area = ''; const out = Object.values((data && data.bills) || {}).filter(b => !b.off); area = keep; return out; };
  // Where a bill says this store's receipts go ('' = none does, or two bills
  // of the store disagree). The chip a receipt starts on (receipts.js).
  function placeFor(r) {
    if (!data || !r || r.docType === 'person_payment' || NOT_BY_BILL.indexOf(r.kind) !== -1) return '';
    const found = {};
    Object.values(data.bills || {}).forEach(b => {
      if (b && placeName(b.place) && b.area !== 'home' && fromStore(r, storeWords(b))) found[b.place] = true;
    });
    const list = Object.keys(found);
    return list.length === 1 ? list[0] : '';
  }
  // Takes its own money: nothing for him to do but know it went.
  const paysItself = b => /auto|card/i.test(String(b.how || ''));
  // Whether the store has sent a receipt lately. Most of his cards and bank
  // payments send none to this mailbox at all.
  function hasTrail(b) {
    if (!window.YDReceipts || !YDReceipts.all) return false;
    const want = storeWords(b), day = todayYmd();
    return Object.values(YDReceipts.all() || {}).some(r => r && /^\d{4}-\d{2}-\d{2}/.test(r.date || '') &&
      gap(String(r.date).slice(0, 10), day) <= TRAIL_DAYS && fromStore(r, want));
  }
  // Gone through on its day with nothing to say so: past due, takes its own
  // money, and the store sends no receipts to wait for.
  const wentThrough = (b, ym) => !paidOf(ym, b.id) && paysItself(b) && daysTo(b.due) < 0 && !hasTrail(b);

  // Receipts that pay a bill: the store's name has the bill's words, the
  // date is near its due day (the 31st pays a bill due the 2nd, in the month
  // before), and the amount is near the bill's, the nearest first. The only
  // bill from a store may run high or low, as an electric bill does, but not
  // to half: two bills from one store are told apart by the amount. Each
  // receipt pays one bill.
  function fromReceipts(ym) {
    if (!window.YDReceipts || !YDReceipts.all || !(YDReceipts.loaded && YDReceipts.loaded())) return {};
    const out = {};
    const all = Object.entries(YDReceipts.all() || {});
    const keep = area;
    area = '';                      // every bill, whatever the screen shows
    const list = billsIn(ym);
    area = keep;
    const used = {};
    Object.values((data && data.paid && data.paid[ym]) || {}).forEach(p => { if (p && p.receiptId) used[p.receiptId] = true; });
    const others = allBills();
    list.forEach(b => {
      const want = storeWords(b);
      const mark = markOf(ym, b.id);
      if (!want.length || (mark && !mark.off)) return;
      const alone = others.filter(x => storeWords(x).join(' ') === want.join(' ')).length === 1;
      const size = r => Math.abs(Number(r.totalCents) || 0);
      const fits = c => !b.cents || Math.abs(c - b.cents) <= b.cents * NEAR || (alone && c >= b.cents * LOW_SHARE);
      const hit = all.filter(([id, r]) => r && /^\d{4}-\d{2}-\d{2}/.test(r.date || '') && !used[id] &&
          gap(String(r.date).slice(0, 10), b.due) <= WINDOW_DAYS && NOT_PAID.indexOf(stageOf(r)) === -1 &&
          !(mark && mark.off && mark.receiptId === id) && fromStore(r, want) && fits(size(r)))
        .sort((x, y) => Math.abs(size(x[1]) - (b.cents || 0)) - Math.abs(size(y[1]) - (b.cents || 0)))[0];
      if (hit) {
        used[hit[0]] = true;
        out[b.id] = { at: new Date().toISOString(), by: 'Job Hub', cents: size(hit[1]), receiptId: hit[0], how: 'receipt' };
      }
    });
    return out;
  }
  // This month, and last month's: what is paid on the 28th can be filed days
  // after the 1st.
  function tickFromReceipts() {
    if (!owner() || !data) return;
    const now = new Date();
    let any = false;
    [ymOf(now), ymOf(new Date(now.getFullYear(), now.getMonth() - 1, 1))].forEach(ym => {
      const found = fromReceipts(ym);
      if (!Object.keys(found).length) return;
      any = true;
      data.paid = Object.assign({}, data.paid, { [ym]: Object.assign({}, (data.paid || {})[ym], found) });
      save({ paid: { [ym]: found } }, 'ticking bills paid');
    });
    if (any) document.dispatchEvent(new CustomEvent('yd-bills'));
  }

  // For Home: what wants him. A bill he pays himself from DUE_SOON_DAYS before
  // its day. One that takes its own money only if its store sends receipts and
  // none has come a few days past the day: something may be wrong.
  function due() {
    if (!owner() || !data) return [];
    const ym = ymOf(new Date()), keep = area;
    area = '';
    const list = billsIn(ym).filter(b => !paidOf(ym, b.id) &&
      (paysItself(b) ? daysTo(b.due) < -LATE_GRACE_DAYS && hasTrail(b) : daysTo(b.due) <= DUE_SOON_DAYS));
    area = keep;
    return list;
  }

  // ------------------------------------------------------------ the screen

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
    const paid = list.filter(b => paidOf(month, b.id) || wentThrough(b, month));
    const paidCents = paid.reduce((t, b) => t + ((paidOf(month, b.id) || {}).cents || b.cents || 0), 0);
    const chip = (v, label) => '<button type="button" class="btn btn-sm' + (area === v ? ' btn-filled' : '') + '" onclick="billsArea(\'' + v + '\')">' + label + '</button>';
    const rows = list.map(b => {
      const p = paidOf(month, b.id), id = safe(b.id), d = daysTo(b.due);
      const self = paysItself(b);
      // A bill that pays itself is never a job for him: the tap stays for the
      // odd one, as a link.
      const tap = self ? '<button type="button" class="link-btn" onclick="billsPaid(\'' + id + '\', true)">Mark it paid</button>'
        : '<button type="button" class="btn btn-sm btn-filled" onclick="billsPaid(\'' + id + '\', true)">✓ Paid</button>';
      const state = p
        ? '<span class="inv-chip">✓ Paid ' + esc(paidDay(p.at)) + (p.how === 'receipt' ? ' · its receipt' : '') + '</span> ' +
          '<button type="button" class="link-btn" onclick="billsPaid(\'' + id + '\', false)">Undo</button>'
        : wentThrough(b, month) ? '<span class="inv-chip">✓ Went through ' + esc(dayWords(b.due)) + ' · pays itself</span> ' + tap
        : self ? '<span class="inv-chip">' + (d < 0 ? 'No receipt yet — was due ' : 'Pays itself ') + esc(dayWords(b.due)) + '</span> ' + tap
        : '<span class="inv-chip' + (month === now && d < 0 ? ' due' : '') + '">' + (month === now && d < 0 ? 'Late — was due ' : 'Due ') +
          esc(dayWords(b.due)) + '</span> ' + tap;
      return '<div class="ji-row' + (p ? ' handled' : '') + '"><div class="ji-top"><b>' + esc(b.name) + '</b>' +
        '<span class="muted">' + (b.cents ? money(b.cents) : 'amount?') + (b.every === 'year' ? ' · yearly' : '') +
          (b.how ? ' · ' + esc(b.how) : '') + ' · ' + (b.area === 'home' ? '🏠 Home' : '🛠 Business') + goesTo(b) + '</span></div>' +
        (b.note ? '<div class="ji-note">' + esc(b.note) + '</div>' : '') +
        '<div class="ji-acts">' + state + ' <button type="button" class="link-btn" onclick="billsEdit(\'' + id + '\')">Change</button></div>' +
        (editing === b.id ? formHtml(Object.assign({ id: b.id }, draft)) : '') + '</div>';
    }).join('');
    const stopped = Object.entries((data && data.bills) || {}).map(([id, b]) => Object.assign({ id }, b))
      .filter(b => b.off && (!area || (b.area || 'business') === area))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const stoppedRows = stopped.map(b => '<div class="ji-row"><div class="ji-top"><b>' + esc(b.name) + '</b>' +
        '<span class="muted">' + (b.cents ? money(b.cents) : 'amount?') + ' · ' + (b.area === 'home' ? '🏠 Home' : '🛠 Business') + goesTo(b) + '</span></div>' +
        (b.note ? '<div class="ji-note">' + esc(b.note) + '</div>' : '') +
        '<div class="ji-acts"><button type="button" class="link-btn" onclick="billsEdit(\'' + safe(b.id) + '\')">Change</button></div>' +
        (editing === b.id ? formHtml(Object.assign({ id: b.id }, draft)) : '') + '</div>').join('');
    body.innerHTML =
      '<div class="field-actions"><button type="button" class="btn btn-sm" onclick="billsMonth(-1)">◀</button> <b>' + esc(monthWords(month)) + '</b> ' +
        '<button type="button" class="btn btn-sm" onclick="billsMonth(1)">▶</button></div>' +
      '<div class="field-actions">' + chip('', 'All') + chip('business', '🛠 Business') + chip('home', '🏠 Home') + '</div>' +
      '<p><b>' + money(paidCents) + '</b> of ' + money(total) + ' gone · ' + (list.length - paid.length) + ' of ' + list.length + ' still to come</p>' +
      (rows || '<p class="empty-msg">No bills here yet.</p>') +
      (editing === 'new' ? formHtml(Object.assign({ id: 'new' }, draft))
        : '<div class="field-actions"><button type="button" class="btn btn-sm" onclick="billsEdit(\'new\')">+ Add a bill</button></div>') +
      (stopped.length ? '<details class="bills-stopped"' + (stopped.some(b => b.id === editing) ? ' open' : '') + '><summary>Stopped bills (' + stopped.length + ')</summary>' +
        stoppedRows + '</details>' : '') +
      '<p class="muted">A bill ticks itself when a receipt from that store comes in around its due day. One on a card or autopay ' +
        'that sends no email counts as gone through on its day and never asks. How it is paid says which. ' +
        'A bill that says where its receipts go files them there by itself, stopped bills too.</p>';
  }
  function goesTo(b) { return placeName(b.place) ? ' · receipts go to ' + esc(placeName(b.place).replace(/^\S+ /, '')) : ''; }
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
      f('match', 'Store name on its receipts (ticks the bill and files them)', b.match, 'text', 'as it reads on a receipt') +
      // Home bills stay off the books: these places are business costs.
      (b.area === 'home' ? '' : '<div class="field"><span class="label">Its receipts go to</span><div class="field-actions bills-places">' +
        pick('place', '', 'I sort them') + PLACES.map(p => pick('place', p[0], p[1])).join('') + '</div></div>') +
      f('note', 'Note', b.note, 'text', '') +
      '<div class="field-actions"><button type="button" class="btn btn-sm btn-filled" onclick="billsSave(\'' + safe(b.id) + '\')">Save</button> ' +
        '<button type="button" class="link-btn" onclick="billsEdit(null)">Cancel</button>' +
        (b.id === 'new' ? '' : b.off ? ' <button type="button" class="link-btn" onclick="billsBack(\'' + safe(b.id) + '\')">Put it back on the list</button>'
          : ' <button type="button" class="link-btn" onclick="billsOff(\'' + safe(b.id) + '\')">Stopped — take it off</button>') + '</div></div>';
  }

  let draft = {};
  window.openMonthlyBills = function () {
    if (owner()) window.YDMoney.show('pay');
  };
  // Money's To pay coming on screen. Read fresh each time, as it was when this
  // opened as a window; not drawn over a bill being typed in.
  function show() {
    const body = el('billsBody');
    if (!owner() || !body) return;
    if (!data) body.innerHTML = '<p class="muted">Loading…</p>';
    else if (!editing) draw();
    read().then(() => { tickFromReceipts(); if (!editing) draw(); }).catch(() => {
      if (!data) body.innerHTML = '<p>Needs signal to open.</p>';
    });
  }
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
      note: v('note').slice(0, 200), off: !!draft.off, place: draft.area !== 'home' && placeName(draft.place) ? draft.place : '' };
    // With no store name it would go by the bill's own name, which is rarely
    // what a receipt says.
    if (rec.place && !rec.match) { showToast('Type the store name as it reads on its receipts'); return; }
    const key = id === 'new' ? 'mb' + Date.now().toString(36) : id;
    data.bills = Object.assign({}, data.bills, { [key]: Object.assign({}, data.bills[key], rec) });
    save({ bills: { [key]: rec } }, 'saving the bill');
    editing = null;
    draw();
    if (rec.place && window.YDReceipts && YDReceipts.fileWaiting) {
      // Saying where they go files the ones already waiting, not just the next.
      const filed = YDReceipts.fileWaiting();
      const any = Object.values((YDReceipts.all && YDReceipts.all()) || {}).some(r => r && fromStore(r, storeWords(rec)));
      showToast(filed ? filed + ' waiting receipt' + (filed === 1 ? '' : 's') + ' filed on ' + placeName(rec.place).replace(/^\S+ /, '')
        : any ? 'Saved. Its next receipts file themselves' : 'Saved, but no receipt reads that store name yet', 5000);
    }
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
  window.billsBack = id => {
    if (!data.bills[id]) return;
    data.bills[id] = Object.assign({}, data.bills[id], { off: false });
    save({ bills: { [id]: { off: false } } }, 'putting the bill back');
    editing = null;
    draw();
  };
  window.billsPaid = (id, on) => {
    const b = data.bills[id];
    if (!b) return;
    const was = markOf(month, id);
    // Taken off one a receipt ticked: kept off, so that receipt leaves it be.
    const rec = on ? { at: new Date().toISOString(), by: 'Jonah', cents: b.cents || 0, receiptId: null, how: 'hand' }
      : was && was.how === 'receipt' && was.receiptId ? { off: true, receiptId: was.receiptId, at: new Date().toISOString() } : null;
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
  // A bill ticked by a receipt coming in, while it is on screen.
  document.addEventListener('yd-bills', () => {
    if (data && !editing && window.YDMoney && YDMoney.showing('pay')) draw();
  });

  window.YDMonthlyBills = { due: due, open: () => window.openMonthlyBills(), show: show, fromReceipts: fromReceipts, placeFor: placeFor };
})();
