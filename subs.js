// Subcontracted work -- mowing (or anything else) YD sells and someone else
// does. Jonah (5 Oct 2026): "I sub out mowing services ... we need somewhere
// in the hub that tracks that." His answers (6 Oct): build it for any
// subcontractor; their bills go into QuickBooks as bills against those
// clients once QuickBooks is connected (that part is not built yet).
//
// On the All Jobs tab, for the owner. Kept in settings/subcontractors, which
// only the owner reads or writes -- what YD pays a subcontractor and charges
// the client, side by side, is nobody else's business, and a settings
// document needs no new security rules:
//   subs: { subId: { name, match, phone, email, notes, createdAt,
//                    props: { propId: { jobId, client, address, every,
//                                       theirCents, theirPer, ourCents,
//                                       ourPer, from, to, off } } } }
//   paid: { receiptId: 'YYYY-MM-DD' }     bills marked paid here
// every: weekly | biweekly | monthly. *Per: visit | month. from/to: the
// season as MM-DD. A key written null is a deleted one (writes merge).
//
// Their bills are receipts the email reader already files (receipts.js): a
// receipt whose store has a subcontractor's "match" words in it is theirs.
// The owner's device takes those out of "Receipts to sort" by itself (set
// aside as "Subcontractor bill") and they are listed here: owed, paid, due.

(function () {
  'use strict';

  const EVERY = { weekly: 'Every week', biweekly: 'Every 2 weeks', monthly: 'Once a month' };
  const PER = { visit: 'a visit', month: 'a month' };
  const SEASON = { from: '04-15', to: '10-31' };    // mowing, by default
  const DUE_SOON_DAYS = 5;

  let data = { subs: {}, paid: {} };
  let fresh = false;          // from the server, not just this device's copy
  let unsub = null;
  let open = {};              // subId -> its details are open
  let form = null;            // { kind: 'sub'|'prop', subId, propId }

  const el = id => document.getElementById(id);
  const owner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const two = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const sid = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const money = c => (typeof c === 'number' && isFinite(c) ? fmtMoney(c / 100) : '—');
  const cents = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return isNaN(n) ? null : Math.round(n * 100); };
  const live = o => Object.keys(o || {}).filter(k => o[k]).map(k => Object.assign({ id: k }, o[k]));
  const subsList = () => live(data.subs).sort((a, b) => String(a.name || '').localeCompare(b.name || ''));
  const propsOf = s => live(s.props).sort((a, b) => String(a.client || '').localeCompare(b.client || ''));

  function save(patch, what) {
    if (!window.YDDb || !owner()) return;
    Promise.resolve(window.YDDb.put('settings', 'subcontractors', patch)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[subs] ' + what + ' not yet on the server:', (e && e.code) || e);
    });
  }
  // Applied here the way the database merges, so the screen shows it at once.
  function applyLocal(patch) {
    const merge = (into, from) => {
      Object.keys(from).forEach(k => {
        const v = from[k];
        if (v && typeof v === 'object' && !Array.isArray(v) && into[k] && typeof into[k] === 'object') merge(into[k], v);
        else into[k] = v;
      });
    };
    merge(data, JSON.parse(JSON.stringify(patch)));
  }
  function put(patch, what) { applyLocal(patch); save(patch, what); render(); }

  // ------------------------------------------------------------- the money

  const dayNum = mmdd => { const m = /^(\d{2})-(\d{2})$/.exec(mmdd || ''); return m ? +m[1] * 100 + +m[2] : null; };
  // The days of a month that fall in a property's season.
  function seasonDays(p, y, m) {
    const from = dayNum(p.from || SEASON.from), to = dayNum(p.to || SEASON.to);
    const last = new Date(y, m + 1, 0).getDate();
    let n = 0;
    for (let d = 1; d <= last; d++) {
      const k = (m + 1) * 100 + d;
      if (from == null || to == null || (from <= to ? k >= from && k <= to : k >= from || k <= to)) n++;
    }
    return { n: n, of: last };
  }
  // What a property comes to in a month: about how many visits, what the
  // subcontractor charges for them and what YD charges the client. A monthly
  // price is shared by the days of the month in season, so a half month at
  // the start of the season counts half.
  function monthOf(p, y, m) {
    const s = seasonDays(p, y, m);
    if (!s.n || p.off) return { visits: 0, their: 0, ours: 0 };
    const visits = p.every === 'monthly' ? 1 : s.n / (p.every === 'biweekly' ? 14 : 7);
    const part = s.n / s.of;
    const cost = (c, per) => (typeof c === 'number' ? Math.round(per === 'month' ? c * part : c * visits) : 0);
    return { visits: visits, their: cost(p.theirCents, p.theirPer), ours: cost(p.ourCents, p.ourPer) };
  }
  function totals(s, y, m) {
    return propsOf(s).reduce((t, p) => {
      const x = monthOf(p, y, m);
      t.visits += x.visits; t.their += x.their; t.ours += x.ours;
      return t;
    }, { visits: 0, their: 0, ours: 0 });
  }
  function seasonTotals(s, y) {
    const t = { their: 0, ours: 0 };
    for (let m = 0; m < 12; m++) { const x = totals(s, y, m); t.their += x.their; t.ours += x.ours; }
    return t;
  }
  const marginText = t => {
    const m = t.ours - t.their;
    return money(m) + (t.ours > 0 ? ' (' + Math.round(m / t.ours * 100) + '%)' : '');
  };

  // ------------------------------------------------------------- the bills

  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // The words that name a company, without "LLC", "Inc", "Co" and the like --
  // the same company's bills come as "X Yard Care LLC" one month and "X Yard
  // Care" the next.
  const FILLER = ['llc', 'inc', 'ltd', 'corp', 'co', 'company', 'the', 'and', 'of'];
  const words = s => norm(s).split(' ').filter(w => w.length > 1 && FILLER.indexOf(w) === -1);
  const matchOf = name => words(name).join(' ');
  function receiptsAll() { return window.YDReceipts && YDReceipts.all ? YDReceipts.all() : {}; }
  // Whose bill a receipt is: the subcontractor whose "match" words are all in
  // the store's name.
  function subFor(r) {
    const have = words(r.vendor);
    if (!have.length) return null;
    return subsList().find(s => {
      const want = words(s.match || s.name);
      return want.length && want.every(w => have.indexOf(w) !== -1);
    }) || null;
  }
  function billsOf(s) {
    const all = receiptsAll();
    return Object.keys(all).map(id => Object.assign({ id: id }, all[id]))
      .filter(r => subFor(r) && subFor(r).id === s.id)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }
  const isPayment = r => r.docType === 'receipt' || r.docType === 'person_payment';
  const isPaid = r => !!(r.paid || (data.paid || {})[r.id]);
  function owed(s) {
    const t = ymd(new Date());
    const list = billsOf(s).filter(r => !isPayment(r) && !isPaid(r));
    const soon = ymd(new Date(Date.now() + DUE_SOON_DAYS * 864e5));
    return {
      cents: list.reduce((n, r) => n + (r.totalCents || 0), 0),
      count: list.length,
      late: list.filter(r => r.dueDate && r.dueDate < t),
      soon: list.filter(r => r.dueDate && r.dueDate >= t && r.dueDate <= soon),
    };
  }

  // Their bills leave "Receipts to sort" by themselves -- only on the
  // owner's device, and only once both lists have come from the server.
  function fileBills() {
    if (!owner() || !fresh || !window.YDReceipts || !YDReceipts.loaded || !YDReceipts.loaded() || !window.YDDb) return;
    const all = receiptsAll();
    Object.keys(all).forEach(id => {
      const r = all[id];
      if (r.status !== 'new' || (r.splits || []).length) return;
      const s = subFor(r);
      // A one-word match ("Lawn") could catch a supplier's receipts too, so
      // those are taken off the list only when the reader also called them a
      // subcontractor's bill.
      if (!s || (r.kind !== 'subcontractor' && words(s.match || s.name).length < 2)) return;
      const patch = { status: 'skipped', skipWhy: 'subcontractor', skippedBy: 'Job Hub', updatedAt: new Date().toISOString() };
      Object.assign(r, patch);
      Promise.resolve(window.YDDb.put('receipts', id, patch))
        .catch(e => console.warn('[subs] bill not yet filed:', (e && e.code) || e));
    });
  }

  // Stores the email reader called subcontractors that are not set up here.
  function suggestions() {
    const seen = {};
    Object.values(receiptsAll()).forEach(r => {
      if (r.kind !== 'subcontractor' || !r.vendor || subFor(r)) return;
      const k = matchOf(r.vendor);
      if (k && !seen[k]) seen[k] = r.vendor;
    });
    return Object.values(seen).slice(0, 5);
  }

  // ---------------------------------------------------------------- drawing

  function render() {
    const sec = el('subsSection'), wrap = el('subsWrap');
    if (!sec || !wrap) return;
    sec.hidden = !owner();
    if (!owner()) return;
    if (form && document.activeElement && wrap.contains(document.activeElement) &&
        /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;     // not under someone typing
    const now = new Date(), y = now.getFullYear(), m = now.getMonth();
    const list = subsList();
    const sugg = suggestions();
    wrap.innerHTML =
      (list.length ? '' : '<p class="empty-msg" style="margin-top:0">Work you sell and someone else does — the mowing, say. ' +
        'Add the company, then each property they look after: what they charge you and what you charge the client. ' +
        'Their bills come off Receipts to sort and are kept here.</p>') +
      (sugg.length ? '<div class="sub-sugg">Bills found from ' + sugg.map(v =>
        '<button class="link-btn" onclick="subAddNamed(this.dataset.v)" data-v="' + esc(v) + '">' + esc(v) + '</button>').join(', ') +
        ' — add as a subcontractor?</div>' : '') +
      list.map(s => subHtml(s, y, m)).join('') +
      (form && form.kind === 'sub' && !form.subId ? subFormHtml({}) :
        '<button class="btn btn-sm btn-accent" onclick="subEdit(\'\')">+ Add a subcontractor</button>');
  }

  function subHtml(s, y, m) {
    const t = totals(s, y, m), st = seasonTotals(s, y), o = owed(s);
    const props = propsOf(s), bills = billsOf(s);
    const monthName = new Date(y, m, 1).toLocaleDateString('en-US', { month: 'long' });
    return '<div class="sub-card">' +
      '<div class="sub-head"><b>' + esc(s.name || 'Subcontractor') + '</b>' +
        (s.phone ? ' <a class="link-btn" href="tel:' + esc(s.phone) + '">' + esc(s.phone) + '</a>' : '') +
        (s.email ? ' <a class="link-btn" href="mailto:' + esc(s.email) + '">Email</a>' : '') +
        '<button class="link-btn" onclick="subEdit(\'' + sid(s.id) + '\')">Edit</button></div>' +
      (form && form.kind === 'sub' && form.subId === s.id ? subFormHtml(s) : '') +
      '<div class="sub-figs">' +
        fig(monthName, props.length ? money(t.their) + ' to them · ' + money(t.ours) + ' from clients' : 'no properties yet') +
        fig('Margin this month', props.length ? marginText(t) : '—') +
        fig('This season', props.length ? marginText(st) : '—') +
        fig('Owed to them', o.count ? money(o.cents) + ' · ' + o.count + ' bill' + (o.count === 1 ? '' : 's') : 'nothing') +
      '</div>' +
      (o.late.length ? '<div class="sub-warn late">⚠️ Past due: ' + o.late.map(r => money(r.totalCents) + ' (due ' + fmtDateMD(r.dueDate) + ')').join(', ') + '</div>'
        : o.soon.length ? '<div class="sub-warn">Due soon: ' + o.soon.map(r => money(r.totalCents) + ' by ' + fmtDateMD(r.dueDate)).join(', ') + '</div>' : '') +
      '<details class="sub-more"' + (open[s.id] ? ' open' : '') + ' ontoggle="subToggle(\'' + sid(s.id) + '\', this.open)">' +
        '<summary>Properties (' + props.length + ') and bills (' + bills.length + ')</summary>' +
        propsHtml(s, props, y, m) +
        billsHtml(bills) +
      '</details>' +
    '</div>';
  }
  const fig = (label, value) => '<div class="sub-fig"><span class="sub-fig-l">' + esc(label) + '</span><span class="sub-fig-v">' + value + '</span></div>';

  function propsHtml(s, props, y, m) {
    const rows = props.map(p => {
      const x = monthOf(p, y, m);
      return (form && form.kind === 'prop' && form.propId === p.id ? '<tr><td colspan="6">' + propFormHtml(s, p) + '</td></tr>' :
        '<tr' + (p.off ? ' class="sub-off"' : '') + '><td><b>' + esc(p.client || 'Client') + '</b>' + (p.address ? '<div class="muted">' + esc(p.address) + '</div>' : '') + '</td>' +
        '<td>' + esc(EVERY[p.every] || '') + '<div class="muted">' + esc((p.from || SEASON.from) + ' to ' + (p.to || SEASON.to)) + '</div></td>' +
        '<td>' + money(p.theirCents) + ' ' + esc(PER[p.theirPer] || '') + '</td>' +
        '<td>' + money(p.ourCents) + ' ' + esc(PER[p.ourPer] || '') + '</td>' +
        '<td>' + (x.their || x.ours ? marginText(x) : '—') + '</td>' +
        '<td><button class="link-btn" onclick="subProp(\'' + sid(s.id) + '\', \'' + sid(p.id) + '\')">Edit</button></td></tr>');
    }).join('');
    return '<div class="table-wrap"><table class="sub-table"><thead><tr><th>Client</th><th>How often</th><th>They charge</th>' +
        '<th>You charge</th><th>Margin this month</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="6" class="muted">No properties yet.</td></tr>') + '</tbody></table></div>' +
      (form && form.kind === 'prop' && form.subId === s.id && !form.propId ? propFormHtml(s, {}) :
        '<button class="btn btn-sm" onclick="subProp(\'' + sid(s.id) + '\', \'\')">+ Add a property</button>');
  }

  function billsHtml(bills) {
    if (!bills.length) return '<p class="muted" style="margin:12px 0 0">No bills from them in Receipts yet.</p>';
    const t = ymd(new Date());
    return '<div class="sub-bills"><div class="sub-bills-h">Their bills</div>' + bills.slice(0, 24).map(r => {
      const pay = isPayment(r), paid = isPaid(r);
      const state = pay ? '<span class="rc-tag">Payment</span>'
        : paid ? '<span class="rc-tag">Paid</span>'
        : r.dueDate && r.dueDate < t ? '<span class="rc-tag rc-owed">Past due</span>'
        : '<span class="rc-tag rc-owed">Owed' + (r.dueDate ? ' · due ' + fmtDateMD(r.dueDate) : '') + '</span>';
      return '<div class="sub-bill"><span>' + fmtDateMD(r.date) + ' · ' + esc(r.summary || r.orderNo || r.vendor || '') + '</span>' +
        '<span><b>' + money(r.totalCents) + '</b> ' + state +
        (!pay ? ' <button class="link-btn" onclick="subPaid(\'' + sid(r.id) + '\', ' + (paid ? 'false' : 'true') + ')">' + (paid ? 'Not paid' : 'Mark paid') + '</button>' : '') +
        (r.link ? ' <a class="link-btn" href="' + esc(r.link) + '" target="_blank" rel="noopener">Email</a>' : '') + '</span></div>';
    }).join('') + '</div>';
  }

  function subFormHtml(s) {
    return '<div class="add-area sub-form">' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Company</span><input id="sbName" value="' + esc(s.name || '') + '"></div>' +
        '<div class="field"><span class="label">Words in their bills’ store name</span><input id="sbMatch" value="' + esc(s.match || '') + '" placeholder="Usually just their name"></div>' +
        '<div class="field"><span class="label">Phone</span><input id="sbPhone" inputmode="tel" value="' + esc(s.phone || '') + '"></div>' +
        '<div class="field"><span class="label">Email</span><input id="sbEmail" inputmode="email" value="' + esc(s.email || '') + '"></div>' +
      '</div>' +
      '<div class="field"><span class="label">Notes</span><input id="sbNotes" value="' + esc(s.notes || '') + '" placeholder="Terms, late fee, who to call"></div>' +
      '<div class="field-actions"><button class="btn btn-filled btn-sm" onclick="subSave(\'' + sid(s.id || '') + '\')">Save</button>' +
        '<button class="btn btn-sm" onclick="subCancel()">Cancel</button>' +
        (s.id ? '<button class="btn btn-sm btn-danger" onclick="subRemove(\'' + sid(s.id) + '\')">Remove</button>' : '') + '</div>' +
    '</div>';
  }

  function propFormHtml(s, p) {
    const jobs = (typeof loadAllJobs === 'function' ? loadAllJobs() : [])
      .filter(j => j && j._id).sort((a, b) => String(a.customerName || '').localeCompare(b.customerName || ''));
    const opt = (map, v) => Object.keys(map).map(k => '<option value="' + k + '"' + (k === v ? ' selected' : '') + '>' + map[k] + '</option>').join('');
    return '<div class="add-area sub-form">' +
      '<div class="field"><span class="label">Client’s job</span><select id="spJob" class="searchable" onchange="subJobPicked()">' +
        '<option value="">— not linked to a job —</option>' +
        jobs.map(j => '<option value="' + sid(j._id) + '"' + (j._id === p.jobId ? ' selected' : '') + '>' + esc(j.customerName || 'Untitled job') +
          (j.address ? ' — ' + esc(j.address) : '') + '</option>').join('') + '</select></div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Client</span><input id="spClient" value="' + esc(p.client || '') + '"></div>' +
        '<div class="field"><span class="label">Address</span><input id="spAddr" value="' + esc(p.address || '') + '"></div>' +
        '<div class="field"><span class="label">How often</span><select id="spEvery">' + opt(EVERY, p.every || 'weekly') + '</select></div>' +
        '<div class="field"><span class="label">Season (month-day)</span><div class="sub-season">' +
          '<input id="spFrom" value="' + esc(p.from || SEASON.from) + '" placeholder="04-15"> to ' +
          '<input id="spTo" value="' + esc(p.to || SEASON.to) + '" placeholder="10-31"></div></div>' +
        '<div class="field"><span class="label">They charge you</span><div class="sub-price">$<input id="spTheir" inputmode="decimal" value="' +
          (typeof p.theirCents === 'number' ? (p.theirCents / 100).toFixed(2) : '') + '"><select id="spTheirPer">' + opt(PER, p.theirPer || 'visit') + '</select></div></div>' +
        '<div class="field"><span class="label">You charge the client</span><div class="sub-price">$<input id="spOurs" inputmode="decimal" value="' +
          (typeof p.ourCents === 'number' ? (p.ourCents / 100).toFixed(2) : '') + '"><select id="spOurPer">' + opt(PER, p.ourPer || 'visit') + '</select></div></div>' +
      '</div>' +
      '<label class="chk"><input type="checkbox" id="spOff"' + (p.off ? ' checked' : '') + '> Not this season (kept for the record)</label>' +
      '<div class="field-actions"><button class="btn btn-filled btn-sm" onclick="subPropSave(\'' + sid(s.id) + '\', \'' + sid(p.id || '') + '\')">Save</button>' +
        '<button class="btn btn-sm" onclick="subCancel()">Cancel</button>' +
        (p.id ? '<button class="btn btn-sm btn-danger" onclick="subPropRemove(\'' + sid(s.id) + '\', \'' + sid(p.id) + '\')">Remove</button>' : '') + '</div>' +
    '</div>';
  }

  // ---------------------------------------------------------------- actions

  const v = id => ((el(id) || {}).value || '').trim();
  window.subToggle = function (id, isOpen) { open[id] = isOpen; };
  window.subEdit = function (id) { form = { kind: 'sub', subId: id || '' }; render(); };
  window.subAddNamed = function (name) {
    form = { kind: 'sub', subId: '' }; render();
    const n = el('sbName');
    if (n) { n.value = name || ''; el('sbMatch').value = matchOf(name); }
  };
  window.subCancel = function () { form = null; render(); };
  window.subSave = function (id) {
    const name = v('sbName');
    if (!name) { showToast('Give the company a name'); return; }
    const subId = id || newId('sb');
    const rec = { name: name, match: v('sbMatch') || matchOf(name), phone: v('sbPhone'), email: v('sbEmail'), notes: v('sbNotes'),
                  updatedAt: new Date().toISOString() };
    if (!id) { rec.createdAt = rec.updatedAt; rec.props = {}; }
    form = null;
    open[subId] = true;
    put({ subs: { [subId]: rec } }, 'saving ' + name);
    fileBills();
    showToast('Saved — ' + name);
  };
  window.subRemove = function (id) {
    const s = (data.subs || {})[id];
    if (!s || !confirm('Remove ' + (s.name || 'this subcontractor') + ' and its properties? Their bills stay in Receipts.')) return;
    form = null;
    put({ subs: { [id]: null } }, 'removing');
  };
  window.subProp = function (subId, propId) { form = { kind: 'prop', subId: subId, propId: propId || '' }; open[subId] = true; render(); };
  window.subJobPicked = function () {
    const id = v('spJob');
    const j = id && (loadAllJobs() || []).find(x => x._id === id);
    if (!j) return;
    if (!v('spClient')) el('spClient').value = j.customerName || '';
    if (!v('spAddr')) el('spAddr').value = [j.address, j.city].filter(Boolean).join(', ');
  };
  window.subPropSave = function (subId, propId) {
    const s = (data.subs || {})[subId];
    if (!s) return;
    const client = v('spClient');
    if (!client) { showToast('Who is the client?'); return; }
    const from = v('spFrom') || SEASON.from, to = v('spTo') || SEASON.to;
    if (dayNum(from) == null || dayNum(to) == null) { showToast('Season dates as month-day, like 04-15'); return; }
    const pid = propId || newId('sp');
    const rec = {
      jobId: v('spJob') || null, client: client, address: v('spAddr'), every: v('spEvery') || 'weekly',
      theirCents: cents(v('spTheir')), theirPer: v('spTheirPer') || 'visit',
      ourCents: cents(v('spOurs')), ourPer: v('spOurPer') || 'visit',
      from: from, to: to, off: !!(el('spOff') && el('spOff').checked), updatedAt: new Date().toISOString(),
    };
    form = null;
    put({ subs: { [subId]: { props: { [pid]: rec } } } }, 'saving a property');
    showToast('Saved — ' + client);
  };
  window.subPropRemove = function (subId, propId) {
    const p = (((data.subs || {})[subId] || {}).props || {})[propId];
    if (!p || !confirm('Remove ' + (p.client || 'this property') + '?')) return;
    form = null;
    put({ subs: { [subId]: { props: { [propId]: null } } } }, 'removing a property');
  };
  window.subPaid = function (receiptId, paid) {
    put({ paid: { [receiptId]: paid ? ymd(new Date()) : null } }, 'marking a bill');
  };

  // ---------------------------------------------------------------- loading

  function stop() { if (unsub) { try { unsub(); } catch (e) {} } unsub = null; data = { subs: {}, paid: {} }; fresh = false; form = null; }
  function start() {
    stop();
    if (!owner() || !window.YDDb) { render(); return; }
    unsub = window.YDDb.watch('settings', (changes, meta) => {
      changes.forEach(c => {
        if (c.id !== 'subcontractors') return;
        const d = c.type === 'removed' ? {} : (c.data || {});
        data = { subs: d.subs || {}, paid: d.paid || {} };
      });
      if (meta && meta.fromCache === false) fresh = true;
      fileBills();
      const p = el('panel-dashboard');
      if (p && p.classList.contains('active')) render();
    }, () => {});
  }
  document.addEventListener('yd-receipts', () => {
    fileBills();
    const p = el('panel-dashboard');
    if (p && p.classList.contains('active')) render();
  });

  window.YDSubs = { render: render, data: () => data, subFor: r => subFor(r) };

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k !== authKey) { authKey = k; if (k) start(); else stop(); }
    render();
  });
})();
