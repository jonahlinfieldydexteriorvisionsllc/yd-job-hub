// Estimates: built on the Job tab, priced by Jonah's rules, sent to the
// customer through QuickBooks.
//
// How Jonah works: he writes his notes from the site visit (what he saw and
// measured, what they want), Claude reads them and lays out the estimate --
// the labour, and a takeoff of every material in the quantities the job needs
// -- and he keeps talking to it ("make it 18x20", "add a fire pit", "Belgian
// edging, we'll pick it up"). The crew-days are his call. Every dollar is
// worked out by pricing.js from Supplies' costs and his pricing rules; Claude
// never does sums and never sets a price.
//
// What the customer gets (Jonah, 6 Oct 2026): one line per piece of labour
// -- the heading, the address, and the scope of work -- and ONE materials line
// listing every material and how much, with one price for all of it. No unit
// prices, no tax line. QuickBooks numbers it, emails it and records the answer;
// invoicing and payment then happen in QuickBooks.
//
// THE ESTIMATE lives on the job as `estimate`:
//   { v: 2, notes, chat, questions, flags,
//     work:      [{id, title, scope, kind: crew|flat|amount, crewDays, profit,
//                  priceId, qty, unit, rateCents, amountCents, qbItem}],
//     materials: [{id, supplyId, name, qty, unit, plant, tree, costCents,
//                  category, delivery: auto|pickup|rides}],
//     spoilCuYd, fuel: {miles, jobDays, bobcatDays, gasCents, dieselCents},
//     deliveryTown, off: {delivery, fuel, dumpsters, planting, markers}, memo }
// saved with the form like the materials list. What QuickBooks has is
// `qbEstimate`, written by the server and patched in here, carried through
// form saves (BOARD_FIELDS). When the estimate has lines, the job price
// follows its total.
//
// THE PRICE BOOK (priceBook/{id}) is for flat-rate services -- gutters by the
// foot, a snow visit, a maintenance package: name, unit, priceCents. A labour
// line can be one of those instead of crew-days.

(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const safeId = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const cents = c => fmtMoney((Number(c) || 0) / 100);
  const sees = () => typeof ydCan === 'function' && ydCan('jobs', 'see');
  const changes = () => typeof ydCan === 'function' && ydCan('jobs', 'change');
  const sends = () => typeof ydCan === 'function' && ydCan('billing', 'change');
  const P = () => window.YDPricing;
  const num = v => (P() ? P().num(v) : (isFinite(parseFloat(v)) ? parseFloat(v) : null));
  const dollarsIn = c => (num(c) === null ? '' : (num(c) / 100).toFixed(2));
  const toCents = v => { const n = num(v); return n === null ? null : Math.round(n * 100); };

  let est = blank();
  let book = {};              // price book, id -> entry
  let unsub = null;
  // building: the id of the job Claude is working on (one at a time), or null.
  let building = null, saving = false, checking = false, tripping = false;
  const queued = [];          // jobs waiting for Claude to start their estimate
  let loads = 0;              // how many times the form has been loaded with a job (or emptied)
  let notesTyped = false;     // the site notes were written or changed since the job was opened
  const checkedAt = {};       // job id -> when its QuickBooks status was last asked for
  const trippedFor = {};      // job id -> the address the miles were last looked up for
  let draftMsg = '';          // what is typed in the chat box, not sent yet
  let undo = null;            // the estimate before Claude's last change
  let qbItems = null;         // QuickBooks product names, fetched when first wanted

  const CHAT_KEEP = 60;
  // Each version put in QuickBooks, as it went: when, the total, each line's
  // amount, whether it was emailed -- so a customer ringing about "the
  // estimate you sent" can be answered from the job.
  const SENT_KEEP = 10;
  function blank() {
    return { v: 2, notes: '', chat: [], questions: [], flags: [], work: [], materials: [],
             spoilCuYd: null, fuel: {}, deliveryTown: '', off: {}, memo: '', sent: [], site: null };
  }
  const clone = o => JSON.parse(JSON.stringify(o));

  // ------------------------------------------------------------- the money

  function catalog() {
    const c = window.YDSupplies && window.YDSupplies.catalog ? window.YDSupplies.catalog() : null;
    return c || { items: {}, prices: {}, vendors: {}, pricesReady: false };
  }
  // city: the job's town for the delivery rate -- the form's, unless a job
  // that is not open is being priced.
  function ctx(city) {
    const c = catalog();
    return { rules: P().rules(), items: c.items, prices: c.prices, fuel: P().fuelPrices(),
             city: city != null ? String(city).trim() : (el('city') && el('city').value || '').trim() };
  }
  let last = null;            // the last worked-out price, for the totals and QuickBooks
  function priced() {
    // The map point belongs to the address it was found for; a changed
    // address leaves it behind (the next miles lookup finds the new one).
    if (est.site && est.site.at !== siteKey()) est.site = null;
    last = P() ? P().price(est, ctx()) : null;
    return last;
  }
  const busyHere = () => !!building && building === currentJobId;

  const hasLines = () => est.work.length > 0 || est.materials.length > 0;

  // ------------------------------------------------------- the job's record

  window.YDEstimate = {
    get() {
      const o = clone(est);
      o.chat = o.chat.slice(-CHAT_KEEP);
      return o;
    },
    load(e) {
      loads++;
      notesTyped = false;
      est = blank();
      if (e && typeof e === 'object') est = fromSaved(e);
      draftMsg = ''; undo = null;
      render();
      autoCheck();
    },
    hasLines: () => hasLines(),
    hasMaterials: () => est.materials.length > 0,
    // Notes brought in from elsewhere (a contact's meeting notes, prospects.js);
    // `auto` lets Claude start the estimate from them as if they had been typed.
    setNotes(text, auto) {
      est.notes = String(text || '');
      notesTyped = true;
      render();
      if (typeof markDirty === 'function') markDirty();
      if (auto) window.estNotesDone();
    },
    totalDollars: () => { const r = priced(); return r ? r.totalCents / 100 : 0; },
    book: () => book,
    orderLines: orderLines,
    jobCompleted: (id, data) => jobCompleted(id, data),
  };

  // What to buy for an estimate: every material it prices -- the takeoff and
  // what the rules add (dumpsters, the planting package, markers) -- in the
  // quantity to order and the unit it is sold in, with who sells it and what
  // one costs us. For the open job by default, or a saved estimate (a job
  // booked from the Bids board without being opened). Deliveries and fuel are
  // not things to order.
  function orderLines(saved, city) {
    if (!P()) return [];
    const e = saved === undefined ? est : fromSaved(saved || {});
    const r = P().price(e, ctx(saved === undefined ? undefined : city || ''));
    const items = catalog().items;
    // One line per thing to buy: the same supply on two lines of the
    // estimate (base gravel for the patio and for the walk, or a planting-
    // package item also in the takeoff) is one order of both.
    const out = [], byKey = {};
    r.takeoff.concat(r.added).filter(l => l.orderQty > 0).forEach(l => {
      const it = l.supplyId ? items[l.supplyId] : null;
      const line = { supplyId: l.supplyId || null, vendorId: (it && it.vendorId) || null,
                     name: (it && it.name) || l.name || '', orderQty: l.orderQty, per: l.per || '',
                     costEachCents: num(l.costCents), specialOrder: !!l.specialOrder, plant: l.category === 'plant' };
      const k = line.supplyId ? 's:' + line.supplyId : 'n:' + line.name.toLowerCase().trim();
      if (byKey[k]) byKey[k].orderQty = Math.round((byKey[k].orderQty + line.orderQty) * 1000) / 1000;
      else { byKey[k] = line; out.push(line); }
    });
    return out;
  }

  // An estimate saved by the first version (price-book lines and one message)
  // comes in as flat labour lines, so nothing typed is lost.
  function fromSaved(e) {
    const o = blank();
    o.notes = String(e.notes || '');
    o.chat = (Array.isArray(e.chat) ? e.chat : []).filter(m => m && m.text)
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: String(m.text), at: m.at || null, changed: !!m.changed }));
    o.questions = Array.isArray(e.questions) ? e.questions.map(String) : [];
    o.flags = Array.isArray(e.flags) ? e.flags.map(String) : [];
    o.memo = String(e.memo || '');
    o.sent = Array.isArray(e.sent) ? e.sent.slice(-SENT_KEEP) : [];
    if (e.v === 2) {
      o.work = (Array.isArray(e.work) ? e.work : []).map(w => Object.assign({ id: newId('ew'), kind: 'crew' }, w));
      o.materials = (Array.isArray(e.materials) ? e.materials : []).map(m => Object.assign({ id: newId('em') }, m));
      o.spoilCuYd = num(e.spoilCuYd);
      o.fuel = Object.assign({}, e.fuel || {});
      o.deliveryTown = String(e.deliveryTown || '');
      o.off = Object.assign({}, e.off || {});
      // Where the job is on the map (from the miles lookup), for a town MDS
      // prices by zone; `at` is the address it was found for.
      o.site = e.site && typeof e.site.lat === 'number' && typeof e.site.lng === 'number'
        ? { lat: e.site.lat, lng: e.site.lng, at: String(e.site.at || '') } : null;
    } else {
      if (!o.notes && e.ask) o.notes = String(e.ask);
      let heading = '';
      (Array.isArray(e.lines) ? e.lines : []).forEach(l => {
        if (l.kind === 'section') { heading = String(l.description || ''); return; }
        o.work.push({ id: newId('ew'), kind: 'flat', title: heading || l.name || 'Work', scope: String(l.description || ''),
          priceId: l.priceId || null, qty: num(l.qty), unit: l.unit || '', rateCents: num(l.rateCents) });
      });
      if (o.work.length && o.memo) { o.work[0].scope = o.memo + (o.work[0].scope ? '\n\n' + o.work[0].scope : ''); o.memo = ''; }
    }
    return o;
  }

  function changed(redraw) {
    if (typeof syncJobPriceFromProposals === 'function') syncJobPriceFromProposals();
    if (typeof updateJobPriceSourceTag === 'function') updateJobPriceSourceTag();
    if (typeof markDirty === 'function') markDirty();
    if (redraw) render(); else renderTotals();
    // The first lines in (or the last out) show or hide the old proposal box.
    if (redraw && typeof renderProposal === 'function') renderProposal();
  }

  const qb = () => (typeof boardFields !== 'undefined' && boardFields.qbEstimate) || null;
  // The job's invoice, made from the estimate (quickbooks.py invoice_from_estimate).
  // An invoice made in the other QuickBooks company (the test one, before the
  // switch to the real books) is not this estimate's: ignored everywhere.
  const qbInv = () => {
    const inv = (typeof boardFields !== 'undefined' && boardFields.qbInvoiceRef) || null;
    const q = qb();
    return inv && inv.env && q && q.env && inv.env !== q.env ? null : inv;
  };
  let invoicing = false;

  // ---------------------------------------------------------------- drawing

  function render() {
    const wrap = el('estimateWrap');
    const sec = el('estimateSection');
    if (!wrap || !sec) return;
    sec.hidden = !sees();
    if (!sees()) return;
    if (!P()) { wrap.innerHTML = '<p class="empty-msg">Loading…</p>'; return; }
    const ro = !changes();
    const r = priced();
    const rules = P().rules();
    const notReady = num(rules.crewDayCents) === null || num(rules.taxPct) === null;

    wrap.innerHTML =
      (notReady ? '<div class="est-warnbox">Your pricing rules aren’t set up yet, so nothing can be priced. ' +
        (window.YDAuth && window.YDAuth.isOwner ? '<button class="btn btn-sm" onclick="openPricingRules()">Open Pricing rules</button>' : 'Ask Jonah to set them.') + '</div>' : '') +

      '<div class="field"><span class="label">Notes from the site visit — what you saw and measured, what they want. Claude builds the estimate from these.' +
        (ro ? '' : ' <button class="link-btn est-today" onclick="estNoteToday()">+ today’s date</button>') + '</span>' +
        '<textarea id="estNotes" rows="5" ' + (ro ? 'readonly ' : '') + 'oninput="estNotesInput(this.value)" onblur="estNotesDone()" ' +
        'placeholder="16x20 patio off the back door, Tahoe in Cascade, 2 steps down. 40 ft of Belgian edging along the beds (we pick it up). Tear out the old deck, ~12x14. Clay soil.">' +
        esc(est.notes) + '</textarea></div>' +
      (!ro && !hasLines() && !est.chat.length
        ? '<div class="field-actions"><button class="btn btn-filled" onclick="estDraftFromNotes()"' + (building ? ' disabled' : '') + '>' +
            (busyHere() ? 'Claude is working…' : building ? 'Claude is busy with another estimate…'
              : queued.indexOf(currentJobId) !== -1 ? 'Waiting its turn…' : '✨ Build the estimate from my notes') + '</button>' +
            (autoOn() && !building ? '<span class="hint">Or just finish writing — when you leave the notes, Claude starts it by itself.</span>' : '') +
          '</div>' : '') +

      chatHtml(ro) +

      ((est.questions || []).length ? '<div class="est-questions"><b>Claude needs to know:</b><ul>' +
        est.questions.map(q => '<li>' + esc(q) + '</li>').join('') + '</ul>' +
        '<div class="hint">Answer in the chat, or fix the lines by hand.</div></div>' : '') +
      ((est.flags || []).length ? '<div class="est-flags"><b>Flags:</b><ul>' +
        est.flags.map(q => '<li>' + esc(q) + '</li>').join('') + '</ul></div>' : '') +

      '<h4 class="est-h">Labour <span class="muted">— each line is a line on the estimate, with its scope of work</span></h4>' +
      '<div class="est-work">' + (est.work.length ? est.work.map((w, i) => workHtml(w, i, ro)).join('')
        : '<div class="empty-msg">No labour yet.</div>') + '</div>' +
      (ro ? '' : '<div class="field-actions"><button class="btn btn-sm" onclick="estAddWork()">+ Labour line</button></div>') +

      '<h4 class="est-h">Materials <span class="muted">— the takeoff; the customer sees the list and one total</span></h4>' +
      '<div class="est-mats">' + (est.materials.length ? est.materials.map((m, i) => matHtml(m, i, ro, r)).join('')
        : '<div class="empty-msg">No materials yet.</div>') + '</div>' +
      (ro ? '' : '<div class="field-actions">' +
        '<button class="btn btn-sm" onclick="estAddMat(false)">+ Material</button>' +
        '<button class="btn btn-sm" onclick="estAddMat(true)">+ Plant</button>' +
        '<label class="est-inline">Spoil to haul away <input inputmode="decimal" value="' + esc(est.spoilCuYd == null ? '' : est.spoilCuYd) + '" ' +
          'oninput="estSet(\'spoilCuYd\', this.value)"> cu yd</label>' +
      '</div>') +

      '<h4 class="est-h">Added by your rules</h4>' +
      '<div class="est-auto" id="estAuto"></div>' +

      '<div class="est-totals" id="estTotals"></div>' +
      (hasLines() ? '<div class="field-actions"><button class="btn btn-sm" onclick="estToggleCustomer()">' +
        (showCustomer ? 'Hide what the customer sees' : '👁 What the customer sees') + '</button></div>' : '') +
      '<div id="estCustomer"></div>' +

      '<div class="field mt"><span class="label">Message on the estimate (payment terms and warranty) — blank uses the one in Pricing rules</span>' +
        '<textarea id="estMemo" rows="3" ' + (ro ? 'readonly ' : '') + 'oninput="estMemoInput(this.value)" placeholder="' +
        esc(defaultMemo(r ? r.totalCents : 0)) + '">' + esc(est.memo) + '</textarea></div>' +
      '<div class="field-actions"><button class="btn btn-sm" onclick="openPriceBook()">💲 Price book (' + Object.keys(book).length + ')</button>' +
        (window.YDAuth && window.YDAuth.isOwner ? '<button class="btn btn-sm" onclick="openPricingRules()">⚙ Pricing rules</button>' : '') + '</div>' +
      '<div class="est-qb" id="estQb"></div>';

    wrap.querySelectorAll('select.searchable').forEach(s => { if (typeof makeSearchable === 'function') makeSearchable(s); });
    const log = el('estChat'); if (log) log.scrollTop = log.scrollHeight;
    renderTotals();
    autoTrip();
  }

  function chatHtml(ro) {
    if (!est.chat.length && !busyHere()) return '';
    const lastI = est.chat.length - 1;
    return '<div class="est-chat" id="estChat">' +
        est.chat.map((m, i) => '<div class="est-msg ' + (m.role === 'assistant' ? 'claude' : 'me') + '">' +
          '<div class="est-who">' + (m.role === 'assistant' ? '✨ Claude' : 'You') + '</div>' +
          '<div class="est-text">' + esc(m.text) + '</div>' +
          (m.role === 'assistant' && m.changed ? '<div class="est-did">Updated the estimate' +
            (i === lastI && undo && undo.jobId === currentJobId && !ro ? ' · <button class="link-btn" onclick="estUndo()">Undo</button>' : '') +
            '</div>' : '') +
        '</div>').join('') +
        (busyHere() ? '<div class="est-msg claude"><div class="est-who">✨ Claude</div><div class="est-text muted">Working on it — a first build can take a minute or two. ' +
          'You can open another job meanwhile; it lands on this one.</div></div>'
          : queued.indexOf(currentJobId) !== -1 ? '<div class="est-msg claude"><div class="est-who">✨ Claude</div><div class="est-text muted">' +
            'Waiting its turn — finishing another estimate first.</div></div>' : '') +
      '</div>' +
      (ro ? '' : '<div class="est-send">' +
        '<textarea id="estMsg" rows="2" placeholder="Talk to Claude about this estimate — “make it 18x20”, “add a fire pit”, “4 crew-days”" ' +
          'oninput="estMsgInput(this.value)" onkeydown="estMsgKey(event)">' + esc(draftMsg) + '</textarea>' +
        '<button class="btn btn-filled" onclick="estSend()"' + (building ? ' disabled' : '') + '>' + (busyHere() ? '…' : 'Send') + '</button>' +
      '</div>' +
      '<div class="field-actions"><button class="link-btn" onclick="estNewChat()">Start the conversation over</button></div>');
  }

  function moves(kind, id, i, n, ro) {
    if (ro) return '';
    return '<span class="est-moves">' +
      '<button class="bd-edit-btn" onclick="estMove(\'' + kind + '\', \'' + id + '\', -1)"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move up">↑</button>' +
      '<button class="bd-edit-btn" onclick="estMove(\'' + kind + '\', \'' + id + '\', 1)"' + (i === n - 1 ? ' disabled' : '') + ' aria-label="Move down">↓</button>' +
      '<button class="bd-edit-btn del" onclick="estRemove(\'' + kind + '\', \'' + id + '\')" aria-label="Remove">✕</button></span>';
  }

  function workHtml(w, i, ro) {
    const id = safeId(w.id), dis = ro ? ' disabled' : '';
    const kind = w.kind || 'crew';
    const tiers = P().PROFIT_TIERS;
    const rules = P().rules();
    const on = (f, v, ph, cls, mode) => '<input class="' + (cls || '') + '"' + (mode ? ' inputmode="' + mode + '"' : '') +
      ' value="' + esc(v == null ? '' : v) + '" placeholder="' + esc(ph || '') + '"' + dis +
      ' oninput="estWork(\'' + id + '\', \'' + f + '\', this.value)">';
    let nums = '';
    if (kind === 'crew') {
      nums = '<label><span>Crew-days</span>' + on('crewDays', w.crewDays, 'your call', '', 'decimal') + '</label>' +
        '<label><span>Profit</span><select' + dis + ' onchange="estWork(\'' + id + '\', \'profit\', this.value)">' +
          tiers.map(([t, name]) => '<option value="' + t + '"' + ((w.profit || rules.defaultProfit || 'aim') === t ? ' selected' : '') + '>' + name + '</option>').join('') +
        '</select></label>';
    } else if (kind === 'flat') {
      const names = Object.keys(book).map(pid => [pid, book[pid]]).sort((a, b) => String(a[1].name || '').localeCompare(String(b[1].name || '')));
      nums = '<label class="est-grow"><span>From the price book</span><select class="searchable"' + dis + ' onchange="estPickPrice(\'' + id + '\', this.value)">' +
          '<option value="">—</option>' + names.map(([pid, e]) => '<option value="' + esc(pid) + '"' + (pid === w.priceId ? ' selected' : '') + '>' +
            esc(e.name) + (Number.isInteger(e.priceCents) ? ' — ' + cents(e.priceCents) + '/' + esc(e.unit || 'each') : '') + '</option>').join('') +
        '</select></label>' +
        '<label><span>Qty' + (w.unit ? ' (' + esc(w.unit) + ')' : '') + '</span>' + on('qty', w.qty, '', '', 'decimal') + '</label>' +
        '<label><span>Rate</span>' + on('rate', dollarsIn(w.rateCents), '0.00', '', 'decimal') + '</label>';
    } else {
      nums = '<label><span>Amount ($)</span>' + on('amount', dollarsIn(w.amountCents), '0.00', '', 'decimal') + '</label>';
    }
    return '<div class="est-wrow">' +
      '<div class="est-wtop">' + on('title', w.title, 'Heading, e.g. Paver patio & steps', 'est-title') +
        '<select' + dis + ' onchange="estWork(\'' + id + '\', \'kind\', this.value)">' +
          [['crew', 'Crew-days'], ['flat', 'Price book'], ['amount', 'Fixed amount']].map(([k, n]) =>
            '<option value="' + k + '"' + (k === kind ? ' selected' : '') + '>' + n + '</option>').join('') +
        '</select>' + moves('work', id, i, est.work.length, ro) + '</div>' +
      '<div class="est-nums">' + nums + '<div class="est-amt" id="estWA_' + id + '"></div></div>' +
      '<textarea rows="4" class="est-scope" placeholder="Scope of work the customer reads for this line"' + (ro ? ' readonly' : '') +
        ' oninput="estWork(\'' + id + '\', \'scope\', this.value)">' + esc(w.scope || '') + '</textarea>' +
      '<div class="est-qbitem"><span>QuickBooks product</span><input list="estQbItems" value="' + esc(w.qbItem || '') + '" placeholder="Labor"' + dis +
        ' onfocus="estLoadQbItems()" oninput="estWork(\'' + id + '\', \'qbItem\', this.value)"></div>' +
      '<div class="est-probs" id="estWP_' + id + '"></div>' +
    '</div>';
  }

  function supplyOptions(selected) {
    const c = catalog();
    const names = P().CATEGORY_NAME;
    const skip = P().NOT_FOR_ESTIMATES || [];
    const list = Object.values(c.items).filter(it => it.id === selected || skip.indexOf(it.category) === -1).sort((a, b) =>
      String(names[a.category] || 'zz').localeCompare(String(names[b.category] || 'zz')) || String(a.name).localeCompare(String(b.name)));
    return '<option value="">— not in Supplies —</option>' + list.map(it => {
      const v = c.vendors[it.vendorId];
      const unit = num(it.coverage) > 0 ? it.takeoffUnit : ((c.prices[it.id] || {}).per || it.unit || '');
      return '<option value="' + esc(it.id) + '"' + (it.id === selected ? ' selected' : '') + '>' + esc(it.name) +
        (unit ? ' (' + esc(unit) + ')' : '') + (v ? ' — ' + esc(v.name) : '') + '</option>';
    }).join('');
  }

  function matHtml(m, i, ro, r) {
    const id = safeId(m.id), dis = ro ? ' disabled' : '';
    const c = catalog();
    const it = m.supplyId ? c.items[m.supplyId] : null;
    const on = (f, v, ph, cls, mode) => '<input class="' + (cls || '') + '"' + (mode ? ' inputmode="' + mode + '"' : '') +
      ' value="' + esc(v == null ? '' : v) + '" placeholder="' + esc(ph || '') + '"' + dis +
      ' oninput="estMat(\'' + id + '\', \'' + f + '\', this.value)">';
    const line = r ? r.takeoff.find(l => l.id === m.id) : null;
    const unit = line ? line.takeoffUnit : (m.unit || '');
    const vRule = it && it.vendorId ? (P().rules().vendors || {})[it.vendorId] || {} : {};
    let head;
    if (m.plant) {
      head = '<span class="est-plant">🌱</span>' + on('name', m.name, 'Plant, size — e.g. Autumn Blaze maple, 2" cal', 'est-title') +
        '<label><span>How many</span>' + on('qty', m.qty, '', '', 'decimal') + '</label>' +
        '<label><span>Cost each</span>' + on('cost', dollarsIn(m.costCents), '0.00', '', 'decimal') + '</label>' +
        '<label><span>Tree?</span><select' + dis + ' onchange="estMat(\'' + id + '\', \'tree\', this.value)">' +
          [['', 'No'], ['single', 'Single-trunk'], ['multi', 'Multi-trunk / evergreen']].map(([k, n]) =>
            '<option value="' + k + '"' + ((m.tree || '') === k ? ' selected' : '') + '>' + n + '</option>').join('') +
        '</select></label>';
    } else {
      head = '<select class="searchable est-supply"' + dis + ' onchange="estPickSupply(\'' + id + '\', this.value)">' + supplyOptions(m.supplyId) + '</select>' +
        on('name', m.name, 'What the customer reads, e.g. Screened topsoil', 'est-title') +
        '<label><span>Qty' + (unit ? ' (' + esc(unit) + ')' : '') + '</span>' + on('qty', m.qty, '', '', 'decimal') + '</label>' +
        (it ? '' : '<label><span>Unit</span>' + on('unit', m.unit, 'each', '') + '</label>' +
          '<label><span>Cost each</span>' + on('cost', dollarsIn(m.costCents), '0.00', '', 'decimal') + '</label>' +
          '<label><span>Kind</span><select' + dis + ' onchange="estMat(\'' + id + '\', \'category\', this.value)">' +
            P().CATEGORIES.filter(([k]) => k !== 'plant').map(([k, n]) => '<option value="' + k + '"' + ((m.category || 'other') === k ? ' selected' : '') + '>' + esc(n) + '</option>').join('') +
          '</select></label>') +
        // Only a truck of bulk material or a pallet is a delivery of its own.
        (vRule.cityDelivery && it && (it.pallet || P().isBulk(line ? line.per : it.unit))
          ? '<label><span>Delivery</span><select' + dis + ' onchange="estMat(\'' + id + '\', \'delivery\', this.value)">' +
          [['auto', 'Delivered'], ['pickup', 'We pick it up'], ['rides', 'Rides on another load']].map(([k, n]) =>
            '<option value="' + k + '"' + ((m.delivery || 'auto') === k ? ' selected' : '') + '>' + n + '</option>').join('') +
          '</select></label>' : '');
    }
    return '<div class="est-mrow">' +
      '<div class="est-mtop">' + head + '<div class="est-amt" id="estMA_' + id + '"></div>' + moves('mat', id, i, est.materials.length, ro) + '</div>' +
      '<div class="est-order" id="estMO_' + id + '"></div>' +
      '<div class="est-source" id="estMS_' + id + '">' + sourceHtml(m.id) + '</div>' +
    '</div>';
  }

  // Everything that depends on the numbers, redrawn without touching what is
  // being typed in.
  function renderTotals() {
    const t = el('estTotals');
    if (!t || !P()) return;
    const r = priced();
    r.work.forEach(w => {
      const a = el('estWA_' + safeId(w.id)); if (a) a.textContent = w.cents ? cents(w.cents) : '';
      const p = el('estWP_' + safeId(w.id)); if (p) p.textContent = w.problems.join(' · ');
    });
    r.takeoff.forEach(l => {
      const a = el('estMA_' + safeId(l.id)); if (a) a.textContent = l.clientCents ? cents(l.clientCents) : '';
      const o = el('estMO_' + safeId(l.id));
      if (o) {
        o.className = 'est-order' + (l.problems.length ? ' bad' : '');
        o.innerHTML = l.problems.length ? '⚠ ' + esc(l.problems.join(' · ')) +
            (canSource() && unpriced(l) && !(found[foundKey(l.id)] || {}).busy
              ? ' <button class="link-btn" onclick="estSource(\'' + safeId(l.id) + '\')">🔎 Source it</button>' : '')
          : l.orderQty ? esc('Order ' + P().qtyText(l.orderQty, l.per) +
            (l.wastePct ? ' (+' + fmtQ(l.wastePct) + '% waste)' : '') + (l.specialOrder ? ' · special order' : '')) : '';
      }
    });
    const toSource = canSource() ? r.takeoff.filter(l => unpriced(l) && !(found[foundKey(l.id)] || {}).busy) : [];
    renderAuto(r);
    renderCustomer(r);
    const pays = r.payments;
    t.innerHTML = (r.work.length || r.takeoff.length)
      ? '<div><span>Materials</span><b>' + cents(r.materialsCents) + '</b></div>' +
        '<div><span>Labour & installation</span><b>' + cents(r.laborCents) + '</b></div>' +
        '<div class="est-grand"><span>Project total</span><b>' + cents(r.totalCents) + '</b></div>' +
        (pays.length ? '<div class="muted">' + pays.map(p => esc(p.label) + ' ' + cents(p.cents)).join(' · ') + '</div>' : '') +
        (r.crewDays ? '<div class="muted">' + fmtQ(r.crewDays) + ' crew-day' + (r.crewDays === 1 ? '' : 's') + ' — only you see this</div>' : '') +
        (r.problems.length ? '<div class="est-problems"><b>Not priced yet:</b><ul>' + r.problems.map(p => '<li>' + esc(p) + '</li>').join('') + '</ul>' +
          (toSource.length > 1 ? '<button class="btn btn-sm" onclick="estSource(\'all\')">🔎 Source all ' + toSource.length + ' unpriced materials</button>' : '') +
          '</div>' : '') +
        (r.specialOrder.length ? '<div class="warn">Special order (non-returnable — lock their selections first): ' + r.specialOrder.map(esc).join(', ') + '</div>' : '')
      : '';
    renderQb();
  }
  const fmtQ = q => String(Math.round(q * 100) / 100);

  // The estimate as the customer will read it in QuickBooks -- the same lines
  // estToQB sends and quickbooks.py lays out: each piece of labour with its
  // heading (the site address on the first) and scope, one materials line
  // listing everything with one price, the total and the message. No unit
  // prices anywhere, as on the real thing.
  let showCustomer = false;
  window.estToggleCustomer = function () { showCustomer = !showCustomer; render(); };
  function siteLine() {
    const f = id => (el(id) && el(id).value || '').trim();
    return [f('address'), [f('city'), f('state')].filter(Boolean).join(', ') + (f('zip') ? ' ' + f('zip') : '')]
      .filter(s => s.trim()).join(', ');
  }
  function renderCustomer(r) {
    const box = el('estCustomer');
    if (!box) return;
    if (!showCustomer || !r) { box.innerHTML = ''; return; }
    const site = siteLine();
    const work = est.work.map((w, i) => ({ title: w.title || '', scope: w.scope || '', cents: r.work[i].cents }))
      .filter(w => w.cents > 0 || w.scope.trim());
    const rows = work.map((w, i) => '<div class="cv-line"><div class="cv-text">' +
        (w.title ? '<b>' + esc(w.title.toUpperCase()) + '</b>' : '') +
        (i === 0 && site ? '<div>' + esc(site) + '</div>' : '') +
        (w.scope.trim() ? '<div class="cv-scope">' + esc(w.scope.trim()) + '</div>' : '') +
      '</div><div class="cv-amt">' + cents(w.cents) + '</div></div>');
    if (r.materialsCents > 0) {
      const head = work.length === 1 && work[0].title ? 'Materials: ' + work[0].title : 'Materials';
      rows.push('<div class="cv-line"><div class="cv-text"><b>' + esc(head) + '</b>' +
        '<div class="cv-scope">' + P().materialsList(r).map(esc).join('<br>') + '</div></div>' +
        '<div class="cv-amt">' + cents(r.materialsCents) + '</div></div>');
    }
    const memo = String(est.memo || '').trim() || defaultMemo(r.totalCents);
    box.innerHTML = '<div class="cv">' +
      '<div class="cv-head"><b>' + esc((el('customerName') && el('customerName').value) || 'Customer') + '</b>' +
        (qb() && qb().docNumber ? ' · Estimate #' + esc(qb().docNumber) : '') + '</div>' +
      rows.join('') +
      '<div class="cv-total"><span>Total</span><b>' + cents(r.totalCents) + '</b></div>' +
      (memo ? '<div class="cv-memo">' + esc(memo) + '</div>' : '') +
      '<div class="hint">Laid out the way QuickBooks shows it; their page adds your logo, the date and the Accept button.</div>' +
    '</div>';
  }

  function renderAuto(r) {
    const box = el('estAuto');
    if (!box) return;
    const ro = !changes(), off = est.off || {};
    const sw = (k, label) => '<label class="est-switch"><input type="checkbox"' + (off[k] ? '' : ' checked') + (ro ? ' disabled' : '') +
      ' onchange="estOff(\'' + k + '\', !this.checked)"> ' + label + '</label>';
    const rows = [];
    // Delivery
    const d = r.delivery;
    const rates = (P().rules().delivery || {}).rates || {};
    const towns = Object.keys(rates).filter(k => num(rates[k]) !== null).sort();
    // A zone picked from the address (Madison) is shown, and can be changed.
    const needTown = d.problems.some(p => /town|rate|zone/.test(p)) || est.deliveryTown || d.deliveryZone;
    rows.push('<div class="est-arow">' + sw('delivery', 'Delivery') + '<span class="est-adesc">' +
      (off.delivery ? 'off' : d.lines.length ? d.lines.map(l => esc(l.name) + ' — ' + l.loads + ' load' + (l.loads === 1 ? '' : 's') + (l.pallet ? ' + pallet' : '')).join('; ')
        : 'nothing delivered') +
      (d.deliveryZone && !off.delivery && d.lines.length ? ' · <b>' + esc(d.deliveryZone) + '</b> (from the address)' : '') + '</span>' +
      (needTown && !off.delivery ? '<select' + (ro ? ' disabled' : '') + ' onchange="estSet(\'deliveryTown\', this.value)"><option value="">' +
        (d.deliveryZone ? 'Zone: from the address' : 'Town: from the job') + '</option>' +
        towns.map(t => '<option' + (t === est.deliveryTown ? ' selected' : '') + '>' + esc(t) + '</option>').join('') + '</select>' : '') +
      '<b>' + (d.clientCents ? cents(d.clientCents) : '') + '</b></div>');
    // Fuel
    const f = r.fuel, fu = est.fuel || {};
    const fp = P().fuelPrices() || {};
    rows.push('<div class="est-arow">' + sw('fuel', 'Fuel') + '<span class="est-adesc">' + (off.fuel ? 'off' :
        '<label>Miles each way <input inputmode="decimal" value="' + esc(fu.miles == null ? '' : fu.miles) + '"' + (ro ? ' disabled' : '') + ' oninput="estFuel(\'miles\', this.value)"></label>' +
        '<button class="btn btn-sm" onclick="estFindMiles(true)"' + (tripping ? ' disabled' : '') + '>' + (tripping ? 'Looking…' : 'Find miles') + '</button>' +
        '<label>Days <input inputmode="decimal" placeholder="' + esc(f.days == null ? '' : f.days) + '" value="' + esc(fu.jobDays == null ? '' : fu.jobDays) + '"' + (ro ? ' disabled' : '') + ' oninput="estFuel(\'jobDays\', this.value)"></label>' +
        '<label>Loader days <input inputmode="decimal" placeholder="' + esc(f.bobcatDays == null ? '' : f.bobcatDays) + '" value="' + esc(fu.bobcatDays == null ? '' : fu.bobcatDays) + '"' + (ro ? ' disabled' : '') + ' oninput="estFuel(\'bobcatDays\', this.value)"></label>' +
        '<label>Gas $/gal <input inputmode="decimal" placeholder="' + esc(num(fp.gasCents) !== null ? (fp.gasCents / 100).toFixed(2) : '') + '" value="' + esc(fu.gasCents == null ? '' : (fu.gasCents / 100).toFixed(2)) + '"' + (ro ? ' disabled' : '') + ' oninput="estFuel(\'gasCents\', this.value)"></label>' +
        '<label>Diesel <input inputmode="decimal" placeholder="' + esc(num(fp.dieselCents) !== null ? (fp.dieselCents / 100).toFixed(2) : '') + '" value="' + esc(fu.dieselCents == null ? '' : (fu.dieselCents / 100).toFixed(2)) + '"' + (ro ? ' disabled' : '') + ' oninput="estFuel(\'dieselCents\', this.value)"></label>' +
        (fp.asOf ? '<small class="muted">prices week of ' + esc(fp.asOf) + '</small>' : '')) +
      '</span><b>' + (f.clientCents ? cents(f.clientCents) : '') + '</b></div>');
    // Dumpsters, planting package, markers: lines the rules added.
    [['dumpsters', 'Dumpsters'], ['planting', 'Planting package'], ['markers', 'Layout markers']].forEach(([k, label]) => {
      const ls = r.added.filter(l => l.auto === k);
      const sum = ls.reduce((s, l) => s + l.clientCents, 0);
      const probs = [].concat.apply([], ls.map(l => l.problems));
      if (!ls.length && !off[k]) return;
      rows.push('<div class="est-arow">' + sw(k, label) + '<span class="est-adesc">' + (off[k] ? 'off' :
        ls.map(l => esc(l.name) + ' — ' + esc(P().qtyText(l.orderQty, l.per))).join('; ') +
        (probs.length ? ' <span class="bad">⚠ ' + esc(probs.join(' · ')) + '</span>' : '')) + '</span><b>' + (sum ? cents(sum) : '') + '</b></div>');
    });
    box.innerHTML = rows.join('');
  }

  function renderQb() {
    const box = el('estQb');
    if (!box) return;
    const q = qb(), inv = qbInv();
    const can = sends() && changes();
    const r = last;
    const ready = r && r.totalCents > 0;
    const when = s => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
    const status = q ? ({ Pending: 'Waiting on the customer', Accepted: '✅ Accepted', Closed: 'Made into an invoice',
      Rejected: 'Turned down' }[q.status] || q.status || '') : '';
    box.innerHTML =
      (q && q.id ? '<div class="est-qb-line"><b>QuickBooks estimate' + (q.docNumber ? ' #' + esc(q.docNumber) : '') + '</b>' +
        (q.total != null ? ' · ' + fmtMoney(Number(q.total) || 0) : '') +
        (status ? ' · ' + esc(status) : '') +
        (q.sentAt ? ' · emailed ' + esc(when(q.sentAt)) + (q.sentTo ? ' to ' + esc(q.sentTo) : '') : ' · not emailed yet') +
        (q.acceptedBy ? ' · accepted by ' + esc(q.acceptedBy) : '') +
        (q.env === 'sandbox' ? ' <span class="est-sandbox">TEST COMPANY</span>' : '') + '</div>' : '') +
      // Once invoiced the estimate is closed in QuickBooks and can't change.
      (can && q && q.id && (q.status === 'Closed' || (inv && inv.id))
        ? (q.link && /^https:\/\/[a-z.]*qbo\.intuit\.com\//.test(q.link)
          ? '<div class="field-actions"><a class="btn btn-sm" href="' + esc(q.link) + '" target="_blank" rel="noopener">Open the estimate</a></div>' : '')
      : can ? '<div class="field-actions">' +
        '<button class="btn btn-sm btn-filled" onclick="estToQB(true)"' + (saving || !ready ? ' disabled' : '') + '>' +
          (saving ? 'Working…' : q && q.id ? (q.sentAt ? '✉️ Update & re-send' : '✉️ Email it from QuickBooks') : '✉️ Send through QuickBooks') + '</button>' +
        '<button class="btn btn-sm" onclick="estToQB(false)"' + (saving || !ready ? ' disabled' : '') + '>' +
          (q && q.id ? 'Update in QuickBooks only' : 'Put in QuickBooks, don’t email yet') + '</button>' +
        (q && q.link && /^https:\/\/[a-z.]*qbo\.intuit\.com\//.test(q.link)
          ? '<a class="btn btn-sm" href="' + esc(q.link) + '" target="_blank" rel="noopener">Open in QuickBooks</a>' : '') +
        (q && q.id && !(inv && inv.id) ? '<button class="btn btn-sm" onclick="estCheck(false)"' + (checking ? ' disabled' : '') + '>' +
          (checking ? 'Checking…' : 'Check for an answer') + '</button>' : '') +
      '</div>' : (q ? '' : '<div class="hint">Sending estimates needs Billing access.</div>')) +
      sentHtml(when) +
      invoiceHtml(q, inv, can, when) +
      careHtml(when);
  }

  // ------------------------------------------------------ plant-care email
  //
  // Jonah (1 Oct 2026): Claude drafts care info for exactly the plants a
  // client had installed. When a job with plants on its estimate is marked
  // Complete, the server (care.py) writes it into his Gmail Drafts -- he
  // reads it and sends it (his answer: show me first). "Write it now" does
  // the same by hand. Switched off in Pricing rules → Claude.
  const plantsIn = e => ((e && e.materials) || []).filter(m => m && m.plant && String(m.name || '').trim());
  const careBusy = {};        // job id -> being written
  function careOn() { return !!(P() && P().rules().autoCare !== false); }
  function careHtml(when) {
    const plants = plantsIn(est);
    if (!plants.length || !changes()) return '';
    const c = (typeof boardFields !== 'undefined' && boardFields.careEmail) || null;
    return '<div class="est-care">🌱 ' + (c
        ? 'Plant-care email drafted ' + esc(when(c.at)) + ' — in your Gmail Drafts to read and send.'
        : plants.length + ' plant' + (plants.length === 1 ? '' : 's') + ' on this job. ' +
          (careOn() ? 'When it’s marked Complete, ' : 'Press the button and ') + 'Claude drafts a care email for them into your Gmail Drafts.') +
      ' <button class="btn btn-sm" onclick="estCareEmail()"' + (careBusy[currentJobId] ? ' disabled' : '') + '>' +
        (careBusy[currentJobId] ? 'Writing…' : c ? 'Write it again' : 'Write it now') + '</button></div>';
  }
  async function writeCare(jobId, byItself) {
    if (careBusy[jobId] || !window.YDClaude) return;
    careBusy[jobId] = true; renderQb();
    try {
      const r = await window.YDClaude.post('/care/draft', { jobId: jobId, auto: !!byItself });
      // Drafted already (another device got there first): nothing to say.
      if (r.skipped) return;
      const note ={ at: new Date().toISOString(), draftId: r.draftId || null, subject: r.subject || '' };
      if (window.YDSync) window.YDSync.patchJob(jobId, { careEmail: note });
      showToast('🌱 Plant-care email' + (r.to ? ' to ' + r.to : '') + ' is in your Gmail Drafts — read it and send');
    } catch (e) {
      showToast((byItself ? 'The plant-care email wasn’t written: ' : 'Plant-care email: ') + (e.message || e));
    } finally {
      delete careBusy[jobId]; renderQb();
    }
  }
  window.estCareEmail = function () {
    if (!changes()) return;
    if (!(el('email').value || '').trim()) { showToast('Add the customer’s email on the job first'); return; }
    if (!currentJobId && typeof autosave === 'function') autosave();
    if (currentJobId) writeCare(currentJobId, false);
  };
  // A job marked Complete (sync.js patchJob, or the form's status): its care
  // email, once, when it has plants and an email address.
  function jobCompleted(jobId, data) {
    if (!careOn() || !changes() || !data || data.careEmail) return;
    if (!plantsIn(data.estimate).length || !/@/.test(String(data.email || ''))) return;
    if (!window.YDClaude || !window.YDClaude.available() || !navigator.onLine) return;
    // The server reads the finished job from the database, so the job goes up
    // first and the email is asked for once the server has it. (Called from
    // the middle of patchJob -- the turn after it is when the copy on this
    // device is complete.)
    Promise.resolve()
      .then(() => (window.YDSync && window.YDSync.sendNow ? window.YDSync.sendNow(jobId) : false))
      .then(sent => {
        if (sent) writeCare(jobId, true);
        else showToast('🌱 The plant-care email waits for a signal — press “Write it now” on the job later');
      });
  }

  function sentHtml(when) {
    const list = (est.sent || []).slice().reverse();
    if (!list.length) return '';
    const time = s => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); };
    return '<details class="est-sent"><summary>Versions put in QuickBooks (' + list.length + ')</summary>' +
      list.map(v => '<div class="est-sent-row"><b>' + esc(when(v.at)) + ' ' + esc(time(v.at)) + '</b> — ' + cents(v.totalCents) +
        (v.emailed ? ' · emailed' : ' · saved, not emailed') + (v.docNumber ? ' · #' + esc(v.docNumber) : '') +
        '<div class="muted">' + (v.work || []).map(w => esc(w.title || 'Labour') + ' ' + cents(w.cents)).join(' · ') +
          (v.materialsCents ? ' · Materials ' + cents(v.materialsCents) : '') + '</div></div>').join('') +
    '</details>';
  }

  // The invoice, once the customer says yes: one for the whole job, made from
  // the estimate in QuickBooks; the deposit is paid against it (Jonah's way,
  // 7 Oct 2026). Its balance is checked every hour by the server.
  function invoiceHtml(q, inv, can, when) {
    if (!q || !q.id) return '';
    const owed = inv && inv.balance != null ? Number(inv.balance) : null;
    const line = inv && inv.id
      ? '<div class="est-qb-line"><b>QuickBooks invoice' + (inv.docNumber ? ' #' + esc(inv.docNumber) : '') + '</b>' +
        (inv.total != null ? ' · ' + fmtMoney(Number(inv.total) || 0) : '') +
        (owed === null ? '' : owed > 0 ? ' · ' + fmtMoney(owed) + ' still owed' : ' · ✅ paid in full') +
        (inv.sentAt ? ' · emailed ' + esc(when(inv.sentAt)) : ' · not emailed yet') + '</div>'
      : '';
    if (!can) return line;
    if (inv && inv.id) {
      return line + '<div class="field-actions">' +
        (!inv.sentAt ? '<button class="btn btn-sm btn-filled" onclick="estInvoice(true)"' + (invoicing ? ' disabled' : '') + '>✉️ Email the invoice</button>' : '') +
        (inv.link && /^https:\/\/[a-z.]*qbo\.intuit\.com\//.test(inv.link)
          ? '<a class="btn btn-sm" href="' + esc(inv.link) + '" target="_blank" rel="noopener">Open the invoice</a>' : '') +
        (owed === null || owed > 0 ? '<button class="btn btn-sm" onclick="estInvoiceCheck(false)"' + (checking ? ' disabled' : '') + '>' +
          (checking ? 'Checking…' : 'Check for a payment') + '</button>' : '') +
      '</div>';
    }
    if (['Pending', 'Accepted'].indexOf(q.status || 'Pending') === -1) return line;
    const yes = q.status === 'Accepted';
    return '<div class="est-invoice">' +
      '<div class="hint">' + (yes ? 'They said yes. Make' : 'When they say yes, make') +
        ' one invoice for the whole job from this estimate — the deposit is paid against it.</div>' +
      '<div class="field-actions">' +
        '<button class="btn btn-sm' + (yes ? ' btn-filled' : '') + '" onclick="estInvoice(true)"' + (invoicing ? ' disabled' : '') + '>' +
          (invoicing ? 'Working…' : '🧾 Make the invoice & email it') + '</button>' +
        '<button class="btn btn-sm" onclick="estInvoice(false)"' + (invoicing ? ' disabled' : '') + '>Make it, don’t email yet</button>' +
      '</div></div>';
  }

  // What the invoice says about paying: the schedule for its total, then the
  // payment terms from Pricing rules.
  function invoiceMemo(totalCents) {
    const rules = P() ? P().rules() : {};
    const p = rules.payments || {};
    const above = num(p.splitAboveCents);
    const terms = String((above !== null && totalCents > above ? p.threeText : p.twoText) || '').trim();
    const pays = P() ? P().payments(totalCents, rules) : [];
    return [pays.map(x => x.label + ': ' + cents(x.cents)).join('\n'), terms].filter(Boolean).join('\n\n');
  }

  window.estInvoice = async function (email) {
    const q = qb(), inv = qbInv() || {};
    if (!q || !q.id || invoicing || !sends() || !changes()) return;
    const total = Math.round((Number(q.total) || 0) * 100);
    const to = (el('email').value || '').trim();
    const what = inv.id ? 'invoice #' + (inv.docNumber || '') : 'the invoice for the whole job (' + cents(total) + ') from estimate #' + (q.docNumber || '');
    if (email && !to && !inv.id) { showToast('Add the customer’s email on the job first'); return; }
    if (!confirm((email ? 'Email ' + what + ' to ' + (to || 'the customer') + ' from QuickBooks?' : 'Make ' + what + ' in QuickBooks?') +
      (inv.id ? '' : '\n\nIt closes the estimate in QuickBooks.'))) return;
    if (typeof autosave === 'function') autosave();
    const jobId = currentJobId;
    if (!jobId) return;
    invoicing = true; renderQb();
    try {
      const out = await askQb('/qb/estimate-invoice', { jobId: jobId, estimateId: q.id, env: q.env || null,
        invoiceId: inv.id || null, email: !!email, memo: invoiceMemo(total) });
      afterInvoice(jobId, out);
      showToast((email ? 'Emailed from QuickBooks' : 'Made in QuickBooks') + (out.docNumber ? ' — invoice #' + out.docNumber : ''));
      // A yes from the customer: a bid still waiting to be booked is offered it.
      if (currentJobId === jobId && typeof isBidStatus === 'function' && isBidStatus(jobStatus) &&
          confirm('They said yes — book it as a job now?') && typeof makeItAJob === 'function') makeItAJob(jobId);
    } catch (e) {
      showToast('QuickBooks: ' + (e.message || e));
    } finally {
      invoicing = false; renderQb();
    }
  };

  // The invoice onto the job, and its number into the form's invoice box.
  function afterInvoice(jobId, r) {
    const open = currentJobId === jobId;
    const saved = open ? null : savedJob(jobId);
    // What was known is kept only for the SAME invoice: an old test-company
    // invoice's "emailed to" must not show on the real one made after it.
    let was = (open ? qbInv() : saved && saved.qbInvoiceRef) || {};
    if (r.id && (was.id !== r.id || (was.env && r.env && was.env !== r.env))) was = {};
    const merged = Object.assign({}, was, r);
    Object.keys(merged).forEach(k => { if (merged[k] === undefined) merged[k] = null; });
    const patch = { qbInvoiceRef: merged };
    // Invoiced from the estimate: QuickBooks has closed it (the server notes
    // the same), so the hourly check does not report it back as news.
    const est0 = open ? qb() : saved && saved.qbEstimate;
    if (r.estimateId && est0 && est0.id === r.estimateId && est0.status !== 'Closed') {
      patch.qbEstimate = Object.assign({}, est0, { status: 'Closed' });
    }
    if (window.YDSync) window.YDSync.patchJob(jobId, patch);
    if (currentJobId === jobId && r.docNumber &&
        (el('qbInvoice').value.trim() !== String(r.docNumber) || !el('qbInvoiced').checked)) {
      el('qbInvoice').value = r.docNumber;
      el('qbInvoiced').checked = true;
      if (typeof updateCtxBar === 'function') updateCtxBar();
      if (typeof markDirty === 'function') markDirty();
    }
    renderQb();
  }

  window.estInvoiceCheck = async function (quiet) {
    const inv = qbInv(), jobId = currentJobId;
    if (!inv || !inv.id || checking || !sends()) return;
    checking = true; if (!quiet) renderQb();
    try {
      const r = await askQb('/qb/invoice-status', { invoiceId: inv.id, env: inv.env || null });
      if (currentJobId !== jobId) return;
      if (r.missing) { if (!quiet) showToast(r.error || 'That invoice is no longer in QuickBooks'); return; }
      afterInvoice(jobId, r);
      if (!quiet) showToast(Number(r.balance) > 0 ? fmtMoney(Number(r.balance)) + ' still owed' : 'Paid in full');
    } catch (e) {
      if (!quiet) showToast('QuickBooks: ' + (e.message || e));
    } finally {
      checking = false; renderQb();
    }
  };

  // The message on the estimate: what was typed for this one, or the rules'
  // payment terms for its size, then the warranty.
  function defaultMemo(totalCents) {
    const p = (P() && P().rules().payments) || {};
    const above = num(p.splitAboveCents);
    const terms = above !== null && totalCents > above ? p.threeText : p.twoText;
    return [terms, p.warranty].map(s => String(s || '').trim()).filter(Boolean).join('\n\n');
  }

  // --------------------------------------------------------------- editing

  const find = (list, id) => list.find(x => safeId(x.id) === id);

  window.estNotesInput = function (v) { est.notes = v; notesTyped = true; if (typeof markDirty === 'function') markDirty(); };
  // A later meeting's notes start on a line of their own, dated, so the notes
  // read as a record of each visit -- and Claude can tell the latest word.
  window.estNoteToday = function () {
    const n = el('estNotes');
    if (!n || n.readOnly) return;
    const day = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    n.value = (n.value.trim() ? n.value.replace(/\s+$/, '') + '\n\n' : '') + day + ': ';
    window.estNotesInput(n.value);
    n.focus();
    try { n.setSelectionRange(n.value.length, n.value.length); } catch (e) {}
  };
  window.estMemoInput = function (v) { est.memo = v; if (typeof markDirty === 'function') markDirty(); };

  window.estSet = function (field, v) {
    if (!changes()) return;
    if (field === 'spoilCuYd') est.spoilCuYd = num(v);
    else if (field === 'deliveryTown') est.deliveryTown = String(v || '');
    changed(field === 'deliveryTown');
  };
  window.estOff = function (k, isOff) {
    if (!changes()) return;
    est.off = Object.assign({}, est.off, { [k]: !!isOff });
    changed(true);
  };
  window.estFuel = function (field, v) {
    if (!changes()) return;
    est.fuel = Object.assign({}, est.fuel);
    est.fuel[field] = /Cents$/.test(field) ? toCents(v) : num(v);
    changed(false);
  };

  window.estWork = function (id, field, v) {
    const w = find(est.work, id);
    if (!w || !changes()) return;
    if (field === 'crewDays' || field === 'qty') w[field] = num(v);
    else if (field === 'rate') w.rateCents = toCents(v);
    else if (field === 'amount') w.amountCents = toCents(v);
    else if (field === 'profit') w.profit = v;
    else if (field === 'kind') { w.kind = v; changed(true); return; }
    else w[field] = String(v);
    changed(false);
  };
  window.estPickPrice = function (id, pid) {
    const w = find(est.work, id);
    if (!w || !changes()) return;
    const p = pid ? book[pid] : null;
    w.priceId = p ? pid : null;
    if (p) {
      w.unit = p.unit || 'each';
      if (Number.isInteger(p.priceCents)) w.rateCents = p.priceCents;
      if (!String(w.title || '').trim()) w.title = p.name || '';
      if (!String(w.scope || '').trim()) w.scope = p.description || '';
      if (w.qty == null) w.qty = 1;
    }
    changed(true);
  };

  window.estMat = function (id, field, v) {
    const m = find(est.materials, id);
    if (!m || !changes()) return;
    if (field === 'qty') m.qty = num(v);
    else if (field === 'cost') m.costCents = toCents(v);
    else if (field === 'tree') m.tree = v || null;
    else if (field === 'delivery' || field === 'category') { m[field] = v; changed(true); return; }
    else m[field] = String(v);
    changed(false);
  };
  // Picking from Supplies takes its name for what the customer reads, unless
  // something is written there already.
  window.estPickSupply = function (id, sid) {
    const m = find(est.materials, id);
    if (!m || !changes()) return;
    const it = sid ? catalog().items[sid] : null;
    m.supplyId = it ? sid : null;
    if (it && !String(m.name || '').trim()) m.name = it.name || '';
    changed(true);
  };

  // ---------------------------------------------------- sourcing a material
  //
  // A material with no price ("🔎 Source it"): first whatever in Supplies
  // already has a price and a name like it (plain matching, no Claude); then,
  // asked for, Claude searches the web for local suppliers and their prices
  // (/estimate/source, sourcing.py). "Use" on a web price files the product
  // and its price under the supplier in Supplies -- so the next bid finds it
  // there -- and links the line to it. What was found is kept for this
  // visit only, per job and line.

  const found = {};                 // jobId|lineId -> {busy, local[], options[], note, error, web}
  const foundKey = id => (currentJobId || 'new') + '|' + safeId(id);
  const canSource = () => changes() && ydCan('supplies', 'change') && !!(window.YDClaude && window.YDClaude.post);
  const unpriced = l => l.problems.some(p => p === 'no price in Supplies' || p === 'no cost');
  const STOP_WORDS = ['the', 'a', 'and', 'of', 'for', 'with', 'in', 'x', 'per', 'or', 'to'];
  const nameWords = s => String(s || '').toLowerCase().replace(/[”″"]/g, ' in ').replace(/[^a-z0-9.]+/g, ' ').split(' ')
    .map(w => w.replace(/\.$/, '')).filter(w => w && STOP_WORDS.indexOf(w) === -1)
    .map(w => w.length > 3 && /[a-z]s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);
  // One unit, however it is written: "sq. ft" = "sf", "Tons" = "ton".
  function unitKey(u) {
    const s = String(u || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
    const table = [[/^(each|ea|pc|pcs|piece|pieces|unit|units)$/, 'each'], [/^(sq ?ft|sf|square f(ee|oo)t)$/, 'sqft'],
      [/^(lf|lin ?ft|linear f(ee|oo)t|ft|feet|foot)$/, 'lf'], [/^(tons?|t)$/, 'ton'],
      [/^(yards?|yds?|cu ?yds?|cubic yards?)$/, 'yd'], [/^(cu ?ft|cubic f(ee|oo)t)$/, 'cuft'], [/^(gal|gallons?)$/, 'gal']];
    const hit = table.find(([re]) => re.test(s));
    return hit ? hit[1] : s.replace(/s$/, '');
  }
  // Supplies items with a price whose name has most of the material's words.
  function localMatches(l, m) {
    const want = nameWords((m && m.name) || l.name);
    if (!want.length) return [];
    const c = catalog(), skip = P().NOT_FOR_ESTIMATES || [];
    return Object.values(c.items)
      .filter(it => it.id !== l.supplyId && skip.indexOf(it.category) === -1 && c.prices[it.id] && num(c.prices[it.id].cents) > 0)
      .map(it => {
        const have = nameWords(it.name + ' ' + (it.also || ''));
        const hit = want.filter(w => have.indexOf(w) !== -1).length;
        return { it: it, hit: hit, score: hit / want.length };
      })
      .filter(x => x.hit >= Math.min(2, want.length) && x.score >= 0.6)
      .sort((a, b) => b.score - a.score || String(a.it.name).length - String(b.it.name).length)
      .slice(0, 3).map(x => x.it.id);
  }
  const lineOf = id => (last || priced()).takeoff.find(l => safeId(l.id) === id) || null;

  function sourceHtml(lineId) {
    const f = found[foundKey(lineId)];
    if (!f) return '';
    const id = safeId(lineId), ro = !canSource();
    const c = catalog(), l = lineOf(id);
    const m = find(est.materials, id);
    let h = '';
    if (f.local && f.local.length) {
      h += '<div class="est-src-head">Already in your Supplies:</div>' + f.local.map(sid => {
        const it = c.items[sid], pr = c.prices[sid] || {}, v = it ? c.vendors[it.vendorId] : null;
        if (!it) return '';
        return '<div class="est-src-opt"><span><b>' + esc(it.name) + '</b>' + (v ? ' — ' + esc(v.name) : '') + ' · ' +
          cents(pr.cents) + (pr.per || it.unit ? ' / ' + esc(pr.per || it.unit) : '') + '</span>' +
          (ro ? '' : '<button class="btn btn-sm" onclick="estUseLocal(\'' + id + '\', \'' + safeId(sid) + '\')">Use</button>') + '</div>';
      }).join('');
      if (!f.web && !f.busy && !ro) h += '<button class="link-btn" onclick="estSourceWeb([\'' + id + '\'])">Not these — look on the web</button>';
    }
    if (f.busy) h += '<div class="muted">🔎 Looking up suppliers and prices on the web — a minute or two…</div>';
    if (f.error) h += '<div class="warn">' + esc(f.error) + (ro ? '' : ' <button class="link-btn" onclick="estSourceWeb([\'' + id + '\'])">Try again</button>') + '</div>';
    if (f.web && !f.busy && !f.error) {
      const opts = f.options || [];
      const qty = l ? num(l.qty) : null, unit = l ? l.takeoffUnit : '';
      h += opts.length ? '<div class="est-src-head">Found on the web' + (f.at ? ' ' + esc(f.at) : '') + ':</div>' : '';
      h += opts.map((o, k) => {
        const same = unitKey(o.per) === unitKey(unit);
        // What this job would need of it, when the units allow the sum.
        const n = qty > 0 ? (o.coversQty > 0 && !same ? Math.ceil(qty / o.coversQty) : same ? Math.ceil(qty) : null) : null;
        return '<div class="est-src-opt"><span><b>' + esc(o.supplier) + '</b> — ' + esc(o.product) +
          (o.price > 0 ? ' · <b>$' + o.price.toFixed(2) + '</b>' + (o.per ? ' / ' + esc(o.per) : '') : ' · call for price') +
          (o.coversQty > 0 && !same ? ' (covers ' + fmtQ(o.coversQty) + ' ' + esc(o.coversUnit) + ')' : '') +
          (n && o.price > 0 ? ' · ≈ ' + cents(Math.round(n * o.price * 100)) + ' for this job' : '') +
          (o.where ? ' · ' + esc(o.where) : '') + (o.inStock === 'yes' ? ' · in stock' : o.inStock === 'no' ? ' · not in stock' : '') +
          (o.note ? '<br><span class="muted">' + esc(o.note) + '</span>' : '') +
          (o.url ? ' <a href="' + esc(o.url) + '" target="_blank" rel="noopener noreferrer">page ↗</a>' : '') +
          (o.url && !o.confirmed ? ' <span class="warn">(link not checked — open it before you trust the price)</span>' : '') +
          '</span>' +
          (!ro && o.price > 0 ? '<button class="btn btn-sm" onclick="estUseFound(\'' + id + '\', ' + k + ')">Use</button>' : '') + '</div>';
      }).join('');
      if (f.note) h += '<div class="muted">' + esc(f.note) + '</div>';
      if (!opts.length && !f.note) h += '<div class="muted">Nothing found on the web for this one.</div>';
    }
    if (!f.busy && !ro && m) h += '<button class="link-btn" onclick="estSourceClose(\'' + id + '\')">Close</button>';
    return h;
  }
  function redrawSource(lineId) {
    const box = el('estMS_' + safeId(lineId));
    if (box) box.innerHTML = sourceHtml(lineId);
  }

  // One line ('<id>') or every unpriced one ('all').
  window.estSource = function (which) {
    if (!canSource()) return;
    const r = priced();
    const lines = r.takeoff.filter(l => unpriced(l) && (which === 'all' || safeId(l.id) === which) && !(found[foundKey(l.id)] || {}).busy);
    if (!lines.length) return;
    const toWeb = [];
    lines.forEach(l => {
      const m = find(est.materials, safeId(l.id));
      const local = m && !m.plant ? localMatches(l, m) : [];
      found[foundKey(l.id)] = { local: local };
      if (!local.length) toWeb.push(safeId(l.id));
      else redrawSource(l.id);
    });
    if (toWeb.length) estSourceWeb(toWeb);
    else renderTotals();
  };

  window.estSourceWeb = async function (ids) {
    if (!canSource() || !ids || !ids.length) return;
    const jobId = currentJobId || 'new';
    const r = priced();
    const items = [];
    ids.forEach(id => {
      const l = r.takeoff.find(x => safeId(x.id) === id), m = find(est.materials, id);
      if (!l || !m) return;
      const it = l.supplyId ? catalog().items[l.supplyId] : null;
      const k = foundKey(l.id);
      found[k] = Object.assign({}, found[k], { busy: true, error: null, web: false });
      items.push({ id: id, name: m.name || l.name || (it && it.name) || '', qty: num(l.qty) || 0,
                   unit: l.takeoffUnit || m.unit || '', category: m.plant ? 'plant' : l.category !== 'other' ? l.category || '' : '',
                   notes: [it ? 'Listed in Supplies as ' + it.name : '', m.plant && m.tree ? (m.tree === 'single' ? 'single-trunk tree' : 'multi-trunk or evergreen tree') : '']
                     .filter(Boolean).join('; ') });
    });
    if (!items.length) return;
    renderTotals(); items.forEach(x => redrawSource(x.id));
    const vendors = Object.values(catalog().vendors).map(v => v.name).filter(Boolean);
    let res = null, err = null;
    try {
      res = await window.YDClaude.post('/estimate/source', { items: items, town: (el('city').value || '').trim(), vendors: vendors });
      if (res.error) err = res.error;
    } catch (e) { err = e.message || String(e); }
    const at = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    items.forEach(x => {
      const k = jobId + '|' + x.id;
      const got = res && !err ? (res.results || []).find(y => y.id === x.id) : null;
      found[k] = Object.assign({}, found[k], err ? { busy: false, error: 'Prices: ' + err, web: false }
        : { busy: false, error: null, web: true, at: at, options: (got && got.options) || [], note: (got && got.note) || '' });
    });
    if ((currentJobId || 'new') !== jobId) { showToast('Prices found for another job — open it to see them'); return; }
    renderTotals(); items.forEach(x => redrawSource(x.id));
  };

  window.estSourceClose = function (id) {
    delete found[foundKey(id)];
    redrawSource(id); renderTotals();
  };

  window.estUseLocal = function (id, sid) {
    if (!canSource() || !catalog().items[sid]) return;
    delete found[foundKey(id)];
    redrawSource(id);
    estPickSupply(id, sid);
  };

  window.estUseFound = function (id, k) {
    if (!canSource()) return;
    const f = found[foundKey(id)], o = f && f.options && f.options[k];
    const m = find(est.materials, id), l = lineOf(id);
    if (!o || !m || !(o.price > 0)) return;
    const priceCents = Math.round(o.price * 100);
    // A plant is priced on its line, not in Supplies.
    if (m.plant) {
      m.costCents = priceCents;
      delete found[foundKey(id)];
      redrawSource(id); changed(true);
      showToast('Cost each set from ' + o.supplier);
      return;
    }
    // Sold in another unit than the takeoff measures in, with no coverage
    // given: ask, or the estimate would order 3 bags for 3 tons.
    const unit = (l && l.takeoffUnit) || m.unit || '';
    let coverage = o.coversQty > 0 ? o.coversQty : null, takeoffUnit = coverage ? o.coversUnit || unit : '';
    if (unit && unitKey(o.per) === unitKey(unit)) { coverage = null; takeoffUnit = ''; }
    else if (unit && o.per && !coverage) {
      const a = window.prompt('How much does one ' + o.per + ' cover, in ' + unit + '?', '');
      if (a === null) return;
      const n = num(String(a).replace(/[^0-9.]/g, ''));
      if (!(n > 0)) { showToast('That should be a number above 0'); return; }
      coverage = n; takeoffUnit = unit;
    }
    // The line's own (unpriced) item takes the price only when it is sold the
    // same way; otherwise the product goes in as an item of its own.
    const c = catalog(), linked = m.supplyId ? c.items[m.supplyId] : null;
    const into = linked && unitKey(o.per) === unitKey((c.prices[linked.id] || {}).per || linked.unit) ? linked.id : null;
    const note = ('Found on the web ' + new Date().toISOString().slice(0, 10) + (o.where ? ' (' + o.where + ')' : '') + ': ' +
                  (o.url || 'no link') + (o.note ? ' — ' + o.note : '')).slice(0, 300);
    const sid = window.YDSupplies && window.YDSupplies.addSourced ? window.YDSupplies.addSourced({
      vendor: o.supplier, name: o.product, sku: o.sku, cents: priceCents, into: into,
      per: into ? (c.prices[into] || {}).per || linked.unit || o.per : o.per,
      category: o.category || (l && l.category !== 'other' ? l.category : ''), coverage: coverage, takeoffUnit: takeoffUnit,
      note: note }) : null;
    if (!sid) { showToast('Could not add it to Supplies'); return; }
    delete found[foundKey(id)];
    redrawSource(id);
    estPickSupply(id, sid);
    showToast('Added to Supplies under ' + o.supplier + ' and priced');
  };

  window.estAddWork = function () {
    if (!changes()) return;
    est.work.push({ id: newId('ew'), kind: 'crew', title: '', scope: '', crewDays: null, profit: null, qbItem: '' });
    changed(true);
  };
  window.estAddMat = function (plant) {
    if (!changes()) return;
    est.materials.push(plant ? { id: newId('em'), plant: true, name: '', qty: null, costCents: null, tree: null }
      : { id: newId('em'), supplyId: null, name: '', qty: null, delivery: 'auto' });
    changed(true);
  };
  window.estRemove = function (kind, id) {
    if (!changes()) return;
    if (kind === 'work') est.work = est.work.filter(x => safeId(x.id) !== id);
    else est.materials = est.materials.filter(x => safeId(x.id) !== id);
    changed(true);
  };
  window.estMove = function (kind, id, dir) {
    const list = kind === 'work' ? est.work : est.materials;
    const i = list.findIndex(x => safeId(x.id) === id), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const t = list[i]; list[i] = list[j]; list[j] = t;
    changed(true);
  };

  // ------------------------------------------------ talking to Claude
  //
  // Each message goes with the whole conversation, the site-visit notes and
  // the estimate as it is on screen (hand changes included), with what it
  // comes to. Claude answers in words and, when asked for a change, with the
  // whole estimate as it should now be. Lines keep their ids, so whatever
  // Claude does not set -- crew-days it was not told, a cost typed in, how a
  // material is delivered -- stays as it was. One Undo, because the last step
  // of a conversation is the one most often wrong.

  window.estMsgInput = function (v) { draftMsg = v; };
  window.estMsgKey = function (e) {
    // Enter sends on a keyboard; on a phone Enter is a new line and Send is the button.
    if (e.key === 'Enter' && !e.shiftKey && !(window.matchMedia && matchMedia('(pointer: coarse)').matches)) {
      e.preventDefault(); window.estSend();
    }
  };
  const BUILD_ASK = 'Build the estimate from my site-visit notes.';
  window.estDraftFromNotes = function () {
    if (!String(est.notes || '').trim()) { showToast('Write your notes from the site visit first'); const n = el('estNotes'); if (n) n.focus(); return; }
    draftMsg = BUILD_ASK;
    window.estSend();
  };

  // Claude starts the estimate by itself. Jonah (6 Oct 2026): the site-visit
  // notes are the start of a bid, and the draft should be waiting for him
  // without being asked. So leaving the notes box -- notes written, nothing
  // built yet -- starts it: only when the notes say enough to work from, once
  // per job, and not at all if it is switched off in Pricing rules.
  const AUTO_MIN_WORDS = 8;
  const autoAsked = {};       // job id -> already started by itself (this session)
  function autoOn() { return !!(P() && P().rules().autoDraft !== false); }
  window.estNotesDone = function () {
    // Only notes written (or changed) on this visit: tapping in and out of an
    // old bid's notes is not asking for an estimate.
    if (!notesTyped || !autoOn() || !changes() || hasLines() || est.chat.length) return;
    // Bids only: a booked job's price is already agreed, and lines landing on
    // it would set its price from the estimate.
    if (typeof isBidStatus === 'function' && typeof jobStatus !== 'undefined' && !isBidStatus(jobStatus)) return;
    if (String(est.notes || '').trim().split(/\s+/).length < AUTO_MIN_WORDS) return;
    if (!window.YDClaude || !window.YDClaude.available() || !navigator.onLine) return;
    if (!(el('customerName').value || '').trim()) { showToast('Add the customer’s name and Claude will start the estimate'); return; }
    // A moment's grace: going straight back into the notes is not leaving them.
    // And if another job is opened in that moment, this one is left alone.
    // (A new job gets its id from the autosave in between, so it is the form
    // being loaded with another job that is watched for, not the id.)
    const seq = loads;
    setTimeout(() => {
      const a = document.activeElement;
      if (loads !== seq) return;
      if ((a && a.id === 'estNotes') || hasLines() || est.chat.length || !changes()) return;
      if (!currentJobId && typeof autosave === 'function') autosave();
      if (!currentJobId || autoAsked[currentJobId] || building === currentJobId) return;
      autoAsked[currentJobId] = true;
      draftMsg = BUILD_ASK;
      window.estSend();
    }, 1200);
  };

  // The job as Claude needs to see it: from the form for the job that is open,
  // from its saved copy for one that is not (an answer that comes back after
  // Jonah has moved on, or a job that waited its turn).
  function savedJob(jobId) {
    try { return JSON.parse(readJobBlob(jobId) || 'null'); } catch (e) { return null; }
  }
  function jobFacts(jobId) {
    const d = jobId === currentJobId ? null : savedJob(jobId);
    if (jobId !== currentJobId && !d) return null;
    const v = f => String(d ? d[f] || '' : (el(f) && el(f).value) || '').trim();
    const services = d ? (Array.isArray(d.serviceTypes) ? d.serviceTypes.slice() : [])
      : (typeof serviceTypes !== 'undefined' ? serviceTypes.slice() : []);
    return { customer: v('customerName'), city: v('city'), notes: v('notes'), services: services,
             location: [v('address'), [v('city'), v('state')].filter(Boolean).join(', ')].filter(Boolean).join(', '),
             estimate: d ? fromSaved(d.estimate || {}) : est, data: d };
  }

  function currentForClaude(e, city) {
    const r = P() ? P().price(e, ctx(city)) : null;
    return {
      work: e.work.map(w => ({ id: w.id, title: w.title || '', scope: w.scope || '', kind: w.kind || 'crew',
        crewDays: num(w.crewDays), priceId: w.priceId || null, qty: num(w.qty),
        amountDollars: num(w.amountCents) === null ? null : w.amountCents / 100 })),
      materials: e.materials.map(m => ({ id: m.id, supplyId: m.supplyId || null, name: m.name || '', qty: num(m.qty),
        unit: m.unit || '', plant: !!m.plant, tree: m.tree || null,
        costEachDollars: num(m.costCents) === null ? null : m.costCents / 100, delivery: m.delivery || 'auto' })),
      spoilCuYd: num(e.spoilCuYd),
      totals: r ? { materials: r.materialsCents / 100, labour: r.laborCents / 100, total: r.totalCents / 100,
                    crewDays: r.crewDays, notPriced: r.problems.slice(0, 20) } : null,
    };
  }

  // Claude's estimate onto ours (e), line by line by id.
  function mergeWork(got, e) {
    return (got || []).map(g => {
      const was = g.id ? e.work.find(w => w.id === g.id) : null;
      const w = was ? clone(was) : { id: newId('ew'), kind: 'crew', profit: null, qbItem: '' };
      w.title = String(g.title || '');
      w.scope = String(g.scope || '');
      w.kind = ['crew', 'flat', 'amount'].indexOf(g.kind) !== -1 ? g.kind : w.kind || 'crew';
      if (w.kind === 'crew' && num(g.crewDays) > 0) w.crewDays = num(g.crewDays);
      if (w.kind === 'flat') {
        const p = g.priceId && book[g.priceId] ? book[g.priceId] : null;
        if (p) {
          if (w.priceId !== g.priceId || num(w.rateCents) === null) w.rateCents = Number.isInteger(p.priceCents) ? p.priceCents : null;
          w.priceId = g.priceId; w.unit = p.unit || 'each';
        }
        if (num(g.qty) !== null) w.qty = num(g.qty);
      }
      if (w.kind === 'amount' && num(g.amountDollars) > 0) w.amountCents = Math.round(num(g.amountDollars) * 100);
      return w;
    });
  }
  function mergeMaterials(got, e) {
    const items = catalog().items;
    return (got || []).map(g => {
      const was = g.id ? e.materials.find(m => m.id === g.id) : null;
      const m = was ? clone(was) : { id: newId('em'), delivery: 'auto' };
      m.plant = !!g.plant;
      m.supplyId = !m.plant && g.supplyId && items[g.supplyId] ? g.supplyId : null;
      m.name = String(g.name || (m.supplyId ? items[m.supplyId].name : '') || '');
      m.qty = num(g.qty);
      if (!m.supplyId) m.unit = String(g.unit || m.unit || '');
      if (m.plant) m.tree = g.tree === 'single' || g.tree === 'multi' ? g.tree : null;
      if (num(g.costEachDollars) > 0) m.costCents = Math.round(num(g.costEachDollars) * 100);
      if (['pickup', 'rides'].indexOf(g.delivery) !== -1) m.delivery = g.delivery;
      return m;
    });
  }

  window.estSend = function () {
    if (!changes() || busyHere()) return;
    if (!window.YDClaude || !window.YDClaude.available()) { showToast('Sign in to use Claude'); return; }
    const text = String(draftMsg || '').trim();
    if (!text) { const b = el('estMsg'); if (b) b.focus(); return; }
    const customer = (el('customerName').value || '').trim();
    if (!customer) { showToast('Add a customer name first'); return; }
    // Saved first so the job has an id that means only itself (see claude.js).
    if (!currentJobId && typeof autosave === 'function') autosave();
    const forJob = currentJobId;
    if (!forJob) { showToast('Save the job first'); return; }
    if (queued.indexOf(forJob) !== -1) return;
    est.chat.push({ role: 'user', text: text, at: new Date().toISOString(), changed: false });
    draftMsg = '';
    // Saved now rather than in a second: the answer may come back after
    // another job is opened, and is then put on this one's saved copy.
    changed(true);
    if (typeof autosave === 'function') autosave();
    if (building) {
      queued.push(forJob); render();
      showToast('Claude is finishing another estimate — this one is next');
      return;
    }
    ask(forJob);
  };

  async function ask(jobId) {
    const job = jobFacts(jobId);
    const e0 = job && job.estimate;
    const asked = e0 && e0.chat[e0.chat.length - 1];
    if (!job || !asked || asked.role !== 'user') { askNext(); return; }
    building = jobId;
    if (jobId === currentJobId) render();
    try {
      const r = await window.YDClaude.post('/estimate/draft', {
        jobId: jobId,
        customer: job.customer,
        location: job.location,
        services: job.services,
        jobNotes: job.notes,
        siteNotes: String(e0.notes || '').trim(),
        chat: e0.chat.slice(-30).map(m => ({ role: m.role, text: m.text })),
        current: currentForClaude(e0, job.city),
      });
      land(jobId, r);
    } catch (e) {
      failed(jobId, asked, e);
    } finally {
      building = null;
      render();
      askNext();
    }
  }
  function askNext() {
    const next = queued.shift();
    if (next) ask(next);
  }

  // Claude's answer onto an estimate: the lines merged by id, its questions
  // and flags, its reply in the conversation. Returns whether it changed lines.
  function apply(e, r) {
    const did = !!(r.updated !== false && ((r.work || []).length || (r.materials || []).length));
    if (did) {
      e.work = mergeWork(r.work, e);
      e.materials = mergeMaterials(r.materials, e);
      if (num(r.spoilCuYd) !== null) e.spoilCuYd = num(r.spoilCuYd) || null;
    }
    e.questions = (r.questions || []).map(String);
    e.flags = (r.flags || []).map(String);
    e.chat.push({ role: 'assistant', text: String(r.reply || (did ? 'Updated the estimate.' : 'No change.')),
                  at: new Date().toISOString(), changed: did });
    return did;
  }

  function land(jobId, r) {
    if (jobId === currentJobId) {
      const before = { jobId: jobId, work: clone(est.work), materials: clone(est.materials), spoilCuYd: est.spoilCuYd,
                       questions: est.questions.slice(), flags: est.flags.slice() };
      // Undo only ever undoes the change it is shown beside.
      undo = apply(est, r) ? before : null;
      changed(true);
      // Kept straight away: a minute of Claude's work should not hang on the
      // autosave's second if Jonah opens another job right then.
      if (typeof autosave === 'function') autosave();
      return;
    }
    // Jonah has moved on to another job: the answer goes on this one's saved
    // copy, and its price follows, the same as if it had been open.
    const d = savedJob(jobId);
    if (!d) return;
    const e = fromSaved(d.estimate || {});
    apply(e, r);
    e.chat = e.chat.slice(-CHAT_KEEP);
    // Through JSON, as the form's save does: Firestore refuses a write with
    // an undefined anywhere in it.
    const patch = { estimate: clone(e) };
    const total = P() ? P().price(e, ctx(d.city || '')).totalCents : 0;
    if (!d.manualJobPrice && total > 0) {
      const extra = (d.additionalCosts || []).reduce((s, x) => s + (parseFloat(x.materialCost) || 0) + (parseFloat(x.laborCost) || 0), 0);
      patch.baseJobPrice = total / 100;
      patch.jobPrice = (total / 100 + extra).toFixed(2);
    }
    if (window.YDSync && window.YDSync.patchJob(jobId, patch)) {
      showToast('✨ Claude finished the estimate for ' + (d.customerName || 'a bid') + ' — it’s on the job to check');
    }
  }

  // The question goes back to where it was asked from, to send again.
  function failed(jobId, asked, err) {
    const why = (err && err.message) || String(err);
    if (jobId === currentJobId) {
      const lastM = est.chat[est.chat.length - 1];
      if (lastM && lastM.role === 'user' && lastM.at === asked.at) {
        est.chat.pop();
        if (lastM.text !== BUILD_ASK) draftMsg = lastM.text;
      }
      changed(true);
      showToast('Claude: ' + why);
      return;
    }
    const d = savedJob(jobId);
    if (d && d.estimate && Array.isArray(d.estimate.chat)) {
      const e = fromSaved(d.estimate);
      const lastM = e.chat[e.chat.length - 1];
      if (lastM && lastM.role === 'user' && lastM.at === asked.at) e.chat.pop();
      if (window.YDSync) window.YDSync.patchJob(jobId, { estimate: clone(e) });
    }
    showToast('Claude could not finish the estimate for ' + ((d && d.customerName) || 'a bid') + ': ' + why);
  }

  window.estUndo = function () {
    if (!undo || undo.jobId !== currentJobId || !changes()) return;
    est.work = undo.work; est.materials = undo.materials; est.spoilCuYd = undo.spoilCuYd;
    est.questions = undo.questions || []; est.flags = undo.flags || [];
    const lastMsg = est.chat[est.chat.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') lastMsg.changed = false;
    est.chat.push({ role: 'user', text: '(Undid that change.)', at: new Date().toISOString(), changed: false });
    undo = null;
    changed(true);
    showToast('Put back as it was');
  };

  window.estNewChat = function () {
    if (!confirm('Start the conversation over? The estimate stays as it is.')) return;
    est.chat = []; est.questions = []; est.flags = []; undo = null;
    changed(true);
  };

  // ------------------------------------------------------------ miles & fuel
  //
  // The server works out road miles from the shop to the job (and, while it
  // is at it, keeps the week's gas and diesel prices fresh). Asked once per
  // address, by itself, when an estimate has lines and no miles.

  function siteKey() {
    return ['address', 'city', 'zip'].map(f => (el(f) && el(f).value || '').trim().toLowerCase()).join('|');
  }
  // A town MDS delivers to by zone (Madison) needs the job's map point too.
  function zonedTown() {
    const r = P() && P().rules(), rates = (r && r.delivery && r.delivery.rates) || {};
    const base = P() ? P().placeKey((el('city') && el('city').value) || '') : '';
    return !!base && !est.deliveryTown && Object.keys(rates).some(k => P().placeKey(k).indexOf(base + ' ') === 0);
  }
  function autoTrip() {
    const needSite = zonedTown() && !est.site;
    if (!hasLines() || (num((est.fuel || {}).miles) !== null && !needSite) || ((est.off || {}).fuel && !needSite)) return;
    if (!currentJobId || !(el('address') && el('address').value.trim()) || !navigator.onLine) return;
    if (trippedFor[currentJobId] === siteKey()) return;
    // Asked again when the time comes: two redraws in a row would otherwise
    // both ask for the same miles.
    setTimeout(() => {
      if (trippedFor[currentJobId] !== siteKey() && (num((est.fuel || {}).miles) === null || (zonedTown() && !est.site))) window.estFindMiles(false);
    }, 800);
  }
  window.estFindMiles = async function (asked) {
    if (tripping || !changes() || !window.YDClaude) return;
    const addr = (el('address').value || '').trim();
    if (!addr) { if (asked) showToast('Add the job’s address first'); return; }
    // The job's map point is kept under its id, so it needs one.
    if (!currentJobId && typeof autosave === 'function') autosave();
    const jobId = currentJobId, key = siteKey();
    trippedFor[jobId] = key;
    tripping = true; renderTotals();
    try {
      const r = await window.YDClaude.post('/estimate/trip', {
        jobId: jobId, address: addr, city: (el('city').value || '').trim(), state: (el('state').value || '').trim(),
        zip: (el('zip').value || '').trim(),
      });
      if (currentJobId !== jobId) return;
      if (Array.isArray(r.point) && typeof r.point[0] === 'number' && typeof r.point[1] === 'number') {
        est.site = { lat: r.point[0], lng: r.point[1], at: key };
      }
      if (num(r.miles) !== null) {
        // Miles typed by hand stay; only an empty box is filled.
        if (asked || num((est.fuel || {}).miles) === null) est.fuel = Object.assign({}, est.fuel, { miles: Math.round(num(r.miles) * 10) / 10 });
        changed(true);
        // A rural address the map does not know is measured to the town.
        if (asked || r.approx) showToast(est.fuel.miles + ' miles each way' + (r.approx ? ' — to the middle of town; check it' : ''));
      } else if (asked) showToast(r.error || 'Could not find that address');
    } catch (e) {
      if (asked) showToast('Miles: ' + (e.message || e));
    } finally {
      tripping = false; renderTotals();
    }
  };

  // ------------------------------------------------------- QuickBooks

  async function askQb(path, body) {
    if (window.YDClaude && window.YDClaude.post) return window.YDClaude.post(path, body);
    throw new Error('The server is not set up');
  }

  window.estLoadQbItems = async function () {
    if (qbItems || !sends()) return;
    qbItems = [];
    try {
      const r = await askQb('/qb/items', {});
      qbItems = (r.items || []).filter(i => i.name && i.type !== 'Category').map(i => i.name).sort();
      let dl = el('estQbItems');
      if (!dl) { dl = document.createElement('datalist'); dl.id = 'estQbItems'; document.body.appendChild(dl); }
      dl.innerHTML = qbItems.map(n => '<option value="' + esc(n) + '">').join('');
    } catch (e) { qbItems = null; }
  };

  window.estToQB = async function (email) {
    if (saving || !sends() || !changes()) return;
    const r = priced();
    if (!r || !(r.totalCents > 0)) return;
    if (r.problems.length && !confirm('Some of this isn’t priced yet:\n\n• ' + r.problems.slice(0, 8).join('\n• ') +
      '\n\nSend it anyway?')) return;
    const f = id => (el(id).value || '').trim();
    if (!f('customerName')) { showToast('Add a customer name first'); return; }
    const to = f('email');
    const q = qb() || {};
    if (email) {
      if (!to) { showToast('Add the customer’s email on the job first'); return; }
      if (!confirm((q.sentAt ? 'Email the updated estimate' : 'Email this estimate') + ' to ' + to +
        ' from QuickBooks?\n\nTotal ' + cents(r.totalCents))) return;
    }
    // The job is saved first so it has an id, and so what is on screen is
    // what is kept with the job.
    if (typeof autosave === 'function') autosave();
    const jobId = currentJobId;
    if (!jobId) { showToast('Save the job first'); return; }
    const site = siteLine();
    saving = true; renderQb();
    try {
      const work = est.work.map((w, i) => ({ title: w.title || '', scope: w.scope || '', cents: r.work[i].cents, qbItem: w.qbItem || '' }))
        .filter(w => w.cents > 0 || w.scope.trim());
      const out = await askQb('/qb/estimate', {
        jobId: jobId, email: !!email,
        estimateId: q.id || null, customerId: q.customerId || null, env: q.env || null,
        customer: { name: f('customerName'), email: to, phone: f('phone'), address: f('address'),
                    city: f('city'), state: f('state'), zip: f('zip') },
        site: site,
        work: work,
        materials: { list: P().materialsList(r), cents: r.materialsCents },
        memo: String(est.memo || '').trim() || defaultMemo(r.totalCents),
        totalCents: r.totalCents,
      });
      // This version, as it went (see SENT_KEEP).
      const version = { at: new Date().toISOString(), emailed: !!email, docNumber: out.docNumber || null,
        totalCents: r.totalCents, materialsCents: r.materialsCents,
        work: work.map(w => ({ title: w.title, cents: w.cents })), materials: P().materialsList(r) };
      if (currentJobId === jobId) {
        est.sent = (est.sent || []).concat([version]).slice(-SENT_KEEP);
        if (typeof markDirty === 'function') markDirty();
      } else {
        // Another job was opened while QuickBooks answered: onto the saved copy.
        const d = savedJob(jobId);
        if (d && window.YDSync) {
          const e = fromSaved(d.estimate || {});
          e.sent = (e.sent || []).concat([version]).slice(-SENT_KEEP);
          e.chat = e.chat.slice(-CHAT_KEEP);
          window.YDSync.patchJob(jobId, { estimate: clone(e) });
        }
      }
      afterQb(jobId, out, email);
      showToast(email ? 'Emailed from QuickBooks' + (out.docNumber ? ' — estimate #' + out.docNumber : '')
        : 'Saved in QuickBooks' + (out.docNumber ? ' as estimate #' + out.docNumber : ''));
    } catch (e) {
      showToast('QuickBooks: ' + (e.message || e));
    } finally {
      saving = false; renderQb();
    }
  };

  // What QuickBooks said, onto the job. A bid that was just emailed moves to
  // Sent (which starts the Follow up clock); QuickBooks' number becomes the
  // job's estimate number.
  function afterQb(jobId, r, emailed) {
    const was = (currentJobId === jobId ? qb() : null) || {};
    const merged = Object.assign({}, was, r);
    Object.keys(merged).forEach(k => { if (merged[k] === undefined) merged[k] = null; });
    const patch = { qbEstimate: merged };
    const stage = currentJobId === jobId ? boardFields.bidStage : null;
    if (emailed && (typeof jobStatus === 'undefined' || jobStatus === 'quoting') &&
        ['won', 'lost', 'sent', 'followUp'].indexOf(stage) === -1) {
      patch.bidStage = 'sent'; patch.bidStageAt = new Date().toISOString();
    }
    if (window.YDSync) window.YDSync.patchJob(jobId, patch);
    if (currentJobId === jobId && r.docNumber && el('estimateNumber').value.trim() !== String(r.docNumber)) {
      el('estimateNumber').value = r.docNumber;
      if (typeof updateJobHeadBadge === 'function') updateJobHeadBadge();
      if (typeof markDirty === 'function') markDirty();
    }
    renderQb();
  }

  window.estCheck = async function (quiet) {
    const q = qb();
    const jobId = currentJobId;
    if (!q || !q.id || checking || !sends()) return;
    checking = true; if (!quiet) renderQb();
    checkedAt[jobId] = Date.now();
    try {
      const r = await askQb('/qb/estimate-status', { estimateId: q.id, jobId: jobId, env: q.env || null });
      if (currentJobId !== jobId) return;
      if (r.missing) { if (!quiet) showToast(r.error || 'That estimate is no longer in QuickBooks'); return; }
      const before = q.status;
      afterQb(jobId, r, false);
      if (r.status === 'Accepted' && before !== 'Accepted' && boardFields.bidStage !== 'won' &&
          confirm('The customer accepted estimate #' + (r.docNumber || '') + ' in QuickBooks.\n\nMark the bid Won and the job Booked?')) {
        const at = new Date().toISOString();
        window.YDSync.patchJob(jobId, { bidStage: 'won', bidStageAt: at, jobStatus: 'booked', workStage: 'scheduled', workStageAt: at });
      } else if (!quiet) {
        showToast('QuickBooks says: ' + ({ Pending: 'no answer yet', Accepted: 'accepted', Closed: 'made into an invoice',
          Rejected: 'turned down' }[r.status] || r.status));
      }
    } catch (e) {
      if (!quiet) showToast('QuickBooks: ' + (e.message || e));
    } finally {
      checking = false; renderQb();
    }
  };

  // Opening a job whose estimate is out asks QuickBooks for an answer, at
  // most every half hour per job -- so an acceptance shows up without a press.
  function autoCheck() {
    const q = qb();
    if (!q || !q.id || q.status !== 'Pending' || !sends() || !navigator.onLine) return;
    if (Date.now() - (checkedAt[currentJobId] || 0) < 30 * 60000) return;
    setTimeout(() => window.estCheck(true), 1500);
  }

  // ------------------------------------------------------------ price book
  //
  // Flat-rate services: what a labour line can be instead of crew-days.

  function bookList() {
    return Object.keys(book).map(id => Object.assign({ id }, book[id]))
      .sort((a, b) => String(a.category || '').localeCompare(String(b.category || '')) ||
        String(a.name || '').localeCompare(String(b.name || '')));
  }
  function writeBook(id, data) {
    data.updatedAt = new Date().toISOString();
    book[id] = Object.assign({}, book[id] || {}, data);
    Promise.resolve(window.YDDb.put('priceBook', id, data)).catch(e => {
      console.warn('[estimate] price not saved:', (e && e.code) || e);
      showToast('A price could not be saved');
    });
  }

  window.openPriceBook = function () {
    const m = el('pbModal');
    if (!m) return;
    m.classList.add('active');
    renderBook();
  };
  window.closePriceBook = function () { const m = el('pbModal'); if (m) m.classList.remove('active'); render(); };

  function renderBook(filter) {
    const body = el('pbBody');
    if (!body) return;
    const ro = !changes();
    const f = String(filter != null ? filter : (el('pbFilter') ? el('pbFilter').value : '')).toLowerCase().trim();
    const list = bookList().filter(p => !f || [p.name, p.category, p.description, p.notes].join(' ').toLowerCase().indexOf(f) !== -1);
    let lastCat = null;
    body.innerHTML =
      '<p class="hint">Flat-rate services — gutters by the foot, a snow visit, a maintenance package. A labour line on an estimate can be one of these instead of crew-days. ' +
        'Materials are priced from Supplies and your pricing rules, not from here. “Notes for Claude” are rules Claude reads; customers never see them.</p>' +
      (ro ? '' : '<div class="field-actions">' +
        '<button class="btn btn-sm btn-filled" onclick="pbAdd()">+ Add a price</button>' +
        (sends() ? '<button class="btn btn-sm" onclick="pbFromQb()">Bring in from QuickBooks</button>' : '') +
        '<button class="btn btn-sm" onclick="pbPasteOpen()">Paste a sheet</button>' +
      '</div>') +
      '<div id="pbPaste" hidden class="field mt"><span class="label">Paste from Excel or Sheets — columns: Name, Unit, Price, Category, Description, Notes for Claude (only Name and Price are needed)</span>' +
        '<textarea id="pbPasteText" rows="6"></textarea>' +
        '<div class="field-actions"><button class="btn btn-sm btn-filled" onclick="pbPasteSave()">Add these</button>' +
        '<button class="btn btn-sm" onclick="pbPasteOpen(false)">Cancel</button></div></div>' +
      '<input id="pbFilter" class="mt" placeholder="Search the price book" value="' + esc(f) + '" oninput="pbFilterInput(this.value)">' +
      (list.length ? '<div class="pb-list">' + list.map(p => {
        const id = safeId(p.id);
        const head = (p.category || '') !== lastCat ? '<div class="pb-cat">' + esc(p.category || 'No category') + '</div>' : '';
        lastCat = p.category || '';
        const dis = ro ? ' disabled' : '';
        const on = (field, v, ph, cls) => '<input class="' + (cls || '') + '" value="' + esc(v == null ? '' : v) + '" placeholder="' + ph + '"' + dis +
          ' onchange="pbField(\'' + id + '\', \'' + field + '\', this.value)">';
        return head + '<div class="pb-row">' +
          '<div class="pb-top">' + on('name', p.name, 'Name, e.g. Gutter cleaning — 1st story', 'pb-name') +
            on('price', Number.isInteger(p.priceCents) ? (p.priceCents / 100).toFixed(2) : '', 'Price', 'pb-price') +
            '<span class="pb-per">per</span>' + on('unit', p.unit, 'LF', 'pb-unit') +
            on('category', p.category, 'Category', 'pb-catin') +
            (ro ? '' : '<button class="bd-edit-btn del" onclick="pbRemove(\'' + id + '\')" aria-label="Remove">✕</button>') + '</div>' +
          '<div class="pb-more">' + on('description', p.description, 'What the customer reads on the estimate', 'pb-desc') +
            on('notes', p.notes, 'Notes for Claude (your pricing rule)', 'pb-notes') +
            (p.qbItemName ? '<span class="pb-qb" title="QuickBooks product">QB: ' + esc(p.qbItemName) + '</span>' : '') + '</div>' +
        '</div>';
      }).join('') + '</div>'
        : '<div class="empty-msg">' + (f ? 'Nothing matches.' : 'No flat-rate services yet. Add them, paste your sheet, or bring them in from QuickBooks.') + '</div>');
  }
  window.pbFilterInput = function (v) {
    renderBook(v);
    const i = el('pbFilter'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); }
  };

  window.pbField = function (id, field, v) {
    if (!changes() || !book[id]) return;
    if (field === 'price') {
      const c = window.YDSupplies.parseCents(v);
      if (typeof c === 'number' && isNaN(c)) { showToast('That price isn’t a number'); renderBook(); return; }
      writeBook(id, { priceCents: c == null ? null : c });
    } else if (field === 'name') {
      if (!String(v).trim()) { showToast('A price needs a name'); renderBook(); return; }
      writeBook(id, { name: String(v).trim(), qbItemId: null, qbItemName: null });
    } else {
      writeBook(id, { [field]: String(v).trim() });
    }
    renderBook();
  };
  window.pbAdd = function () {
    const name = prompt('What is it? (e.g. Gutter cleaning — 1st story)');
    if (!name || !name.trim()) return;
    const id = newId('pb');
    writeBook(id, { name: name.trim(), unit: 'each', priceCents: null, category: '', description: '', notes: '',
                    qbItemId: null, qbItemName: null, active: true, createdAt: new Date().toISOString() });
    renderBook();
  };
  window.pbRemove = function (id) {
    const p = book[id];
    if (!p || !confirm('Take “' + (p.name || '') + '” out of the price book? Estimates already made keep their lines.')) return;
    delete book[id];
    Promise.resolve(window.YDDb.remove('priceBook', id)).catch(e => console.warn('[estimate] not removed:', (e && e.code) || e));
    renderBook();
  };

  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function byName(name) {
    const n = norm(name);
    return Object.keys(book).find(id => norm(book[id].name) === n) || null;
  }

  window.pbFromQb = async function () {
    if (!sends() || !changes()) return;
    showToast('Asking QuickBooks for its products…');
    try {
      const r = await askQb('/qb/items', {});
      let added = 0;
      (r.items || []).forEach(it => {
        if (!it.name || it.type === 'Category') return;
        const price = typeof it.price === 'number' && it.price > 0 ? Math.round(it.price * 100) : null;
        // Only products with a set price are flat-rate services.
        if (price === null || byName(it.name)) return;
        writeBook(newId('pb'), { name: it.name, unit: 'each', priceCents: price, category: '', description: it.description || '',
                                 notes: '', qbItemId: null, qbItemName: it.name, active: true, createdAt: new Date().toISOString() });
        added++;
      });
      renderBook();
      showToast(added + ' added from QuickBooks' + (added ? ' — set the unit on each' : ''));
    } catch (e) {
      showToast('QuickBooks: ' + (e.message || e));
    }
  };

  window.pbPasteOpen = function (show) {
    const b = el('pbPaste'); if (!b) return;
    b.hidden = show === false;
    if (!b.hidden) el('pbPasteText').focus();
  };
  const COLS = {
    name: ['name', 'item', 'service', 'product', 'description of work'],
    unit: ['unit', 'per', 'uom', 'units'],
    price: ['price', 'rate', 'cost', 'unit price', 'amount', 'charge'],
    category: ['category', 'type', 'group', 'section'],
    description: ['description', 'customer description', 'what customer reads'],
    notes: ['notes', 'notes for claude', 'rule', 'rules', 'pricing rule'],
  };
  window.pbPasteSave = function () {
    if (!changes()) return;
    const rows = window.YDSupplies.parseTable(el('pbPasteText').value);
    if (rows.length < 2) { showToast('Paste the column names and at least one row'); return; }
    const keys = rows[0].map(h => { const t = norm(h); return Object.keys(COLS).find(k => COLS[k].indexOf(t) !== -1) || null; });
    if (keys.indexOf('name') === -1 || keys.indexOf('price') === -1) {
      showToast('The first row needs a Name column and a Price column'); return;
    }
    let added = 0, updated = 0, bad = 0;
    rows.slice(1).forEach(r => {
      const v = {}; keys.forEach((k, i) => { if (k && r[i] != null) v[k] = String(r[i]).trim(); });
      if (!v.name) return;
      const c = window.YDSupplies.parseCents(v.price);
      if (typeof c === 'number' && isNaN(c)) { bad++; return; }
      const data = { name: v.name, priceCents: c == null ? null : c };
      ['unit', 'category', 'description', 'notes'].forEach(k => { if (v[k]) data[k] = v[k]; });
      const have = byName(v.name);
      if (have) { writeBook(have, data); updated++; }
      else {
        writeBook(newId('pb'), Object.assign({ unit: 'each', category: '', description: '', notes: '', qbItemId: null,
          qbItemName: null, active: true, createdAt: new Date().toISOString() }, data));
        added++;
      }
    });
    el('pbPasteText').value = '';
    pbPasteOpen(false);
    renderBook();
    showToast(added + ' added, ' + updated + ' updated' + (bad ? ', ' + bad + ' skipped (price not a number)' : ''));
  };

  // ------------------------------------------------------------- start/stop

  function stop() {
    if (unsub) { try { unsub(); } catch (e) {} }
    unsub = null; book = {};
  }
  function start() {
    stop();
    if (!sees() || !window.YDDb) return;
    unsub = window.YDDb.watch('priceBook', list => {
      list.forEach(c => { if (c.type === 'removed') delete book[c.id]; else book[c.id] = c.data; });
      const m = el('pbModal');
      if (m && m.classList.contains('active')) {
        // Not redrawn under someone typing in it.
        const a = document.activeElement;
        if (!(a && m.contains(a) && /INPUT|TEXTAREA/.test(a.tagName))) renderBook();
      } else repaint();
    }, () => {});
  }

  // Supplies, the pricing rules and the price book arrive after the job is
  // on screen; the estimate is re-priced as they do. Redrawn whole only when
  // nobody is typing in it, otherwise just the numbers.
  function repaint() {
    const w = el('estimateWrap');
    const a = document.activeElement;
    if (w && a && w.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) renderTotals();
    else render();
    if (typeof syncJobPriceFromProposals === 'function') syncJobPriceFromProposals();
  }
  document.addEventListener('yd-supplies', repaint);
  document.addEventListener('yd-pricing', repaint);

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const k = on ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k !== authKey) { authKey = k; if (on) start(); else stop(); }
    render();
  });
})();
