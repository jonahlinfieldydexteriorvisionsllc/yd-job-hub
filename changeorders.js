// The Change orders board (🧾, under 🛠 Work).
//
// Jonah (3 Nov 2026): "change order board where i enter the change orders
// basic info with service and price for material and labor then you enter them
// onto their respective jobs", "each card gets a get it signed button", "make
// sure materials can be added from our material list", and "make sure change
// orders can be saved as not signed yet and marked for jonahs review before
// asking for signature so they could enter just the measurements and info then
// i could finish the pricing it would show up on their end and then they can
// get a signature".
//
//   For Jonah to price -> To sign -> Signed -> Added
//
//   - Anyone on the board (the crew, Jonah) adds a card: the job, the service,
//     what is changing with its measurements, and the materials, picked from
//     Supplies or typed. It saves as not signed yet, and he gets a push.
//   - Jonah finishes the pricing: a customer figure per material, started
//     from what an estimate would charge (pricing.js), taxed or not by its
//     kind, and labor, which is never taxed. He can change any of it. Saving
//     puts it on To sign, and whoever made it gets a push.
//   - The crew see the price then, because the customer must. They cannot
//     change it (firestore.rules): they never see a cost or a Supplies price,
//     and the card holds only what the customer pays.
//   - "Get it signed" opens the usual signing window (signatures.js) locked
//     to the card, and works with no signal as signing does.
//   - Jonah alone can "Add it without a signature".
//   - Then the five-minute run puts it on the job's QuickBooks invoice, not
//     emailed, and the card moves to Added saying where (changeorders.py,
//     quickbooks.add_card_order). What stops that stays on the card in words.
//
// A card's column follows what has happened to it, so cards here do not drag:
// the board draws them from cardHtml below and opens them here. Stored like any
// card, in boards/changeorders/cards, plus:
//   byUid, service, what, materials [{id, name, supplyId, qty, unit}],
//   jobId, jobName, jobNum, jobAddress, jobCustomer
//   price { items [{id, cents, taxable}], materialCents, laborCents,
//           taxableCents, taxCents, ratePct, totalCents, at, by, byName, round }
//   signDoc, signedAt, signedName, signedBy, noSignature {at, by, name}
//   qb, qbTry {at, error}, said -- the server's

(function () {
  'use strict';

  const BOARD = 'changeorders';
  const CARDS = 'boards/' + BOARD + '/cards';
  const TO_PRICE = 'co_price', TO_SIGN = 'co_sign', SIGNED = 'co_signed', ADDED = 'co_added';
  const COLUMNS = [{ id: TO_PRICE, name: 'For Jonah to price' }, { id: TO_SIGN, name: 'To sign' },
                   { id: SIGNED, name: 'Signed' }, { id: ADDED, name: 'Added' }];
  const PICKS_MAX = 8;      // tap buttons shown under a search box
  const SEED_RETRIES = [3000, 15000, 60000];

  const el = id => document.getElementById(id);
  const safe = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const nowIso = () => new Date().toISOString();
  const me = () => (window.YDAuth && YDAuth.user) || null;
  const isOwner = () => !!(window.YDAuth && YDAuth.isOwner);
  const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const money = c => fmtMoney((c || 0) / 100);
  const dollars = c => (typeof c === 'number' && isFinite(c) ? (c / 100).toFixed(2) : '');
  // A typed figure in cents, null when it says none. A minus is a credit.
  const toCents = v => {
    const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? Math.round(n * 100) : null;
  };
  function myName() {
    const who = window.YDRemind && YDRemind.me ? YDRemind.me() : null;
    const u = me() || {};
    return String((who && who.name) || u.displayName || String(u.email || '').split('@')[0] || 'Someone').slice(0, 80);
  }
  const board = () => (window.YDBoards && YDBoards.boards()[BOARD]) || null;
  const cards = () => (window.YDBoards && YDBoards.cards()[BOARD]) || {};
  const card = id => cards()[id] || null;
  const mayAdd = () => !!(window.YDBoards && YDBoards.editsBoard(BOARD));

  // Never awaited: a write settles only when the server answers, and a truck
  // has no signal. Firestore sends it when it can; the card on screen already
  // shows it.
  function put(id, data) {
    if (!window.YDDb) { showToast('Not saved — still connecting'); return; }
    Promise.resolve(window.YDDb.put(CARDS, id, data)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[changeorders] card not yet on the server:', (e && e.code) || e);
    });
  }

  // Where a card has got to, from what has happened to it.
  function stageOf(k) {
    if (k.column === ADDED || (k.qb && k.qb.ok)) return 'added';
    if (!k.price) return 'price';
    return k.signDoc ? 'signed' : 'sign';
  }
  const STAGE_COLUMN = { price: TO_PRICE, sign: TO_SIGN, signed: SIGNED, added: ADDED };
  function stageName(k) {
    const id = STAGE_COLUMN[stageOf(k)];
    const c = ((board() || {}).columns || COLUMNS).find(x => x.id === id) || COLUMNS.find(x => x.id === id);
    return c ? c.name : '';
  }
  const qtyWords = (qty, unit) => {
    if (!(Number(qty) > 0)) return '';
    return window.YDPricing && YDPricing.qtyText ? YDPricing.qtyText(Number(qty), unit) : (qty + ' ' + (unit || '')).trim();
  };
  // "Road gravel: 3 tons", as an estimate's materials line says it.
  const matWords = m => [String(m.name || '').trim(), qtyWords(m.qty, m.unit)].filter(Boolean).join(': ');
  const titleOf = d => [d.jobName, d.service].filter(Boolean).join(' — ').slice(0, 200) || 'Change order';

  // ------------------------------------------------------------ the board

  // What is happening to it, in words, or '' when its column says it all.
  function sayHtml(k) {
    const stage = stageOf(k);
    const say = (cls, text) => '<div class="co-said' + cls + '">' + esc(text) + '</div>';
    if (stage === 'added') return k.said ? say(' ok', '✓ ' + k.said) : '';
    if (k.qbTry && k.qbTry.error) return say(' bad', '⚠ Not on QuickBooks yet: ' + k.qbTry.error);
    // Why it came back to be signed: done with once it is signed again.
    if (k.said && !k.signDoc) return say(' bad', k.said);
    if (k.noSignature) return say('', 'Going on QuickBooks with no signature, within five minutes');
    if (stage === 'signed') return say('', 'Signed by ' + (k.signedName || 'the customer') + '. Going on QuickBooks, not emailed.');
    return '';
  }

  // "Get it signed" is on every card; not priced yet, it says who it waits for.
  function signBtn(k, cls) {
    const stage = stageOf(k);
    if (stage === 'signed' || stage === 'added' || k.noSignature) return '';
    const off = stage === 'price';
    return '<button type="button" class="' + cls + '"' + (off ? ' disabled title="Jonah prices it first"' : '') +
      ' onclick="event.stopPropagation(); coSign(\'' + safe(k.id) + '\')">✍️ Get it signed</button>';
  }

  function cardHtml(k, done) {
    const stage = stageOf(k);
    const words = String(k.what || '').split('\n')[0].slice(0, 90);
    const sign = signBtn(k, 'bd-card-act' + (stage === 'sign' ? ' strong' : ''));
    return '<div class="bd-card co-card' + (done ? ' done' : '') + '" data-board="' + BOARD + '" data-card="' + esc(k.id) + '" ' +
        'onclick="openCardDetail(\'' + BOARD + '\', \'' + safe(k.id) + '\')">' +
      '<div class="bd-card-title">🧾 ' + esc(k.jobName || 'A job') +
        (k.jobNum ? ' <span class="job-num">#' + esc(k.jobNum) + '</span>' : '') + '</div>' +
      (k.service ? '<div class="bd-card-line">' + esc(k.service) + '</div>' : '') +
      (words ? '<div class="bd-card-line muted">' + esc(words) + '</div>' : '') +
      (k.price ? '<div class="bd-card-line co-card-sum">' + money(k.price.totalCents) + '</div>'
        : '<div class="bd-card-line muted">' + (isOwner() ? 'Not priced yet' : 'Waiting on Jonah’s price') + '</div>') +
      sayHtml(k) +
      (stage === 'price' && isOwner()
        ? '<div class="bd-card-line"><button type="button" class="bd-card-act strong" onclick="event.stopPropagation(); coOpen(\'' + safe(k.id) + '\')">💲 Price it</button></div>' : '') +
      (sign ? '<div class="bd-card-line">' + sign + '</div>' : '') +
    '</div>';
  }

  // Made once on the owner's device, shared with the crew and made theirs to
  // add to, the way the Maintenance board is (equipment.js): everyone working
  // once, so someone he takes off stays off. Deleted, it stays gone.
  let seedAsked = false;
  async function keepBoard() {
    if (!isOwner() || !window.YDBoards || !YDBoards.ready() || !window.YDDb) return;
    let b = board();
    if (!b) {
      if (seedAsked) return;
      seedAsked = true;
      let flags = null;
      try { flags = await YDDb.get('settings', 'seeds'); } catch (e) { seedAsked = false; return; }
      if ((flags && flags.changeOrders) || board()) return;
      const rec = { name: '🧾 Change orders', color: '#8a5fb8', order: 3, group: 'work', ownerOnly: false,
                    visibleTo: [], editors: [], columns: COLUMNS, doneColumn: ADDED, labels: [],
                    createdAt: nowIso(), updatedAt: nowIso() };
      Promise.resolve(YDDb.put('boards', BOARD, rec)).catch(e => console.warn('[changeorders] board not yet made:', (e && e.code) || e));
      Promise.resolve(YDDb.put('settings', 'seeds', { changeOrders: true })).catch(() => {});
      return;                  // back here when it arrives (yd-boards-changed)
    }
    const ppl = YDBoards.people ? YDBoards.people() : {};
    if (!Object.keys(ppl).length) return;
    const crew = Object.keys(ppl).filter(uid => ppl[uid].active && ['crew', 'admin'].indexOf(ppl[uid].role) !== -1);
    const once = (now, was) => {
      const list = Array.isArray(now) ? now : [];
      const seen = Array.isArray(was) ? was : list.slice();
      const add = crew.filter(uid => list.indexOf(uid) === -1 && seen.indexOf(uid) === -1);
      const remember = Array.from(new Set(seen.concat(add, list)));
      return { list: list.concat(add), remember: remember, changed: !!add.length || !Array.isArray(was) || remember.length !== seen.length };
    };
    const vis = once(b.visibleTo, b.autoShared), eds = once(b.editors, b.autoEditors);
    if (!vis.changed && !eds.changed) return;
    b.visibleTo = vis.list; b.autoShared = vis.remember; b.editors = eds.list; b.autoEditors = eds.remember;
    Promise.resolve(YDDb.put('boards', BOARD, { visibleTo: vis.list, autoShared: vis.remember, editors: eds.list, autoEditors: eds.remember }))
      .catch(e => console.warn('[changeorders] sharing not yet saved:', (e && e.code) || e));
  }

  // --------------------------------------------------------- the jobs to pick

  // Whoever sees jobs picks from them, a bid already in QuickBooks too (a
  // Pending estimate takes a change order); the crew from the jobs they clock
  // into (jobBoard). Open jobs first.
  function jobChoices() {
    const out = [];
    if (ydCan('jobs', 'see') && typeof loadAllJobs === 'function') {
      loadAllJobs().forEach(j => {
        if (!j || !j._id || j.removeWhy || j.deletedAt) return;
        const st = typeof normStatus === 'function' ? normStatus(j.jobStatus, j) : String(j.jobStatus || 'quoting');
        if (st === 'quoting' && !(j.qbEstimate && j.qbEstimate.id)) return;
        out.push({ id: j._id, name: String(j.customerName || '').trim() || 'Untitled job',
                   what: typeof jobWhat === 'function' ? jobWhat(j) : '', where: [j.address, j.city].filter(Boolean).join(', '),
                   done: st === 'complete', last: j.lastModified || '' });
      });
    } else if (window.YDClock && YDClock.board) {
      const b = YDClock.board() || {};
      Object.keys(b).forEach(id => out.push({ id: id, name: b[id].name || 'Job', what: b[id].what || '',
        where: b[id].address || '', done: b[id].status === 'complete', last: b[id].updatedAt || '' }));
    }
    return out.sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || String(b.last).localeCompare(String(a.last)));
  }
  // What the signed paper says about a job.
  function infoFor(id) {
    let got = null;
    mounts.forEach((info, c) => { if (!got && info && c.getAttribute('data-job') === safe(id)) got = info; });
    if (got) return got;
    if (ydCan('jobs', 'see') && typeof loadAllJobs === 'function') {
      const j = loadAllJobs().find(x => x && x._id === id);
      if (j) {
        const name = String(j.customerName || '').trim() || 'Customer';
        return { name: name, customer: [j.firstName, j.lastName].filter(Boolean).join(' ') || name,
                 address: [j.address, j.city, [j.state, j.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
                 number: String(j.estimateNumber || '').trim() };
      }
    }
    const b = window.YDClock && YDClock.board ? (YDClock.board() || {})[id] : null;
    return b ? { name: b.name || 'Customer', customer: b.name || '', address: b.address || '', number: '' } : null;
  }

  // ----------------------------------------------------------- the window

  let edit = null;   // the card in the editor: its boxes, prices {matId: {text, taxable, byHand, taxHand}}, laborText
  let viewing = '';  // the card shown as it stands (drawView)

  function modal(title) {
    let m = el('coModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal-overlay';
      m.id = 'coModal';
      m.innerHTML = '<div class="modal"><div class="modal-head"><h2></h2>' +
        '<button class="modal-close" aria-label="Close" onclick="coClose()">&times;</button></div><div class="modal-body" id="coBody"></div></div>';
      document.body.appendChild(m);
    }
    // In front of whatever opened it (the crew's job page, made later). Not
    // when it is open already: a question may be up in front of it.
    if (!m.classList.contains('active')) document.body.appendChild(m);
    m.querySelector('h2').textContent = title;
    m.classList.add('active');
    return el('coBody');
  }
  window.coClose = function () {
    const m = el('coModal');
    if (m) m.classList.remove('active');
    edit = null; viewing = '';
  };

  function startEdit(k, jobId) {
    const info = k.jobId || jobId ? infoFor(k.jobId || jobId) : null;
    const prices = {};
    ((k.price && k.price.items) || []).forEach(p => {
      prices[p.id] = { text: dollars(p.cents), taxable: !!p.taxable, byHand: true, taxHand: true };
    });
    edit = { id: k.id || '', isNew: !k.id,
             jobId: k.jobId || jobId || '', jobName: k.jobName || (info && info.name) || '',
             // The office knows these better than the crew's list of jobs did.
             jobNum: (info && info.number) || k.jobNum || '', jobAddress: (info && info.address) || k.jobAddress || '',
             jobCustomer: (info && info.customer) || k.jobCustomer || '',
             service: k.service || '', what: k.what || '',
             materials: (k.materials || []).map(m => Object.assign({}, m)), prices: prices,
             laborText: k.price ? dollars(k.price.laborCents) : '' };
    if (isOwner()) edit.materials.forEach(m => suggest(m));
  }

  // A new card, with the job picked when it comes from a job's own page.
  function add(jobId) {
    if (!mayAdd()) { showToast('This one is not shared with you yet'); return; }
    startEdit({}, jobId);
    if (window.YDSupplies && YDSupplies.ensure) YDSupplies.ensure();
    drawEditor('New change order');
  }
  window.coAdd = id => add(id);

  // Priced, a card stands as it is for everyone but Jonah (firestore.rules);
  // added, for him too: it is on the invoice now, and changed there.
  function open(id) {
    const k = card(id);
    if (!k) { showToast('That change order is not on the board any more'); return; }
    if (stageOf(k) === 'added' || (k.price && !isOwner())) { edit = null; drawView(k); return; }
    startEdit(k);
    if (window.YDSupplies && YDSupplies.ensure) YDSupplies.ensure();
    drawEditor(k.jobName || 'Change order');
  }
  window.coOpen = open;
  window.openChangeOrders = function () {
    if (typeof switchTab === 'function') switchTab('boards');
    if (typeof showBoard === 'function') showBoard(BOARD);
  };

  function moneyHtml(p) {
    return '<div class="co-money">' +
      [['Material', p.materialCents], ['Labor', p.laborCents], ['Tax', p.taxCents]].map(([n, v]) =>
        '<div><span>' + n + '</span><span>' + money(v) + '</span></div>').join('') +
      '<div class="total"><span>Total</span><span>' + money(p.totalCents) + '</span></div></div>';
  }

  function drawView(k) {
    viewing = k.id;
    const line = (label, html) => '<div class="field"><span class="label">' + label + '</span><div class="sg-locked">' + html + '</div></div>';
    modal(k.jobName || 'Change order').innerHTML =
      '<p class="sg-for"><b>' + esc(stageName(k)) + '</b>' + (k.createdBy ? ' · put in by ' + esc(k.createdBy) : '') + '</p>' +
      (k.service ? line('Service', esc(k.service)) : '') +
      line('What is changing', esc(k.what || '').replace(/\n/g, '<br>')) +
      ((k.materials || []).length ? line('Materials', k.materials.map(m => esc(matWords(m))).join('<br>')) : '') +
      (k.price ? moneyHtml(k.price) : '') +
      sayHtml(k) +
      (k.signedName ? '<p class="hint">Signed by ' + esc(k.signedName) + (k.signedAt ? ' · ' + esc(new Date(k.signedAt).toLocaleString('en-US',
        { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) : '') + '</p>' : '') +
      '<div class="co-acts">' + signBtn(k, 'btn btn-filled') + '</div>';
  }

  const pickRows = (rows, more) => rows.join('') + (more > 0 ? '<p class="hint">' + more + ' more — type a few letters</p>' : '');
  function jobPickHtml() {
    if (edit.jobId) {
      return '<div class="co-chosen"><span><b>' + esc(edit.jobName || 'A job') + '</b>' +
          (edit.jobAddress ? '<small>' + esc(edit.jobAddress) + '</small>' : '') + '</span>' +
        '<button type="button" class="link-btn" onclick="coJobClear()">Change</button></div>';
    }
    return '<input id="coJobFind" type="search" autocomplete="off" placeholder="Type the customer’s name" oninput="coJobFind(this.value)">' +
      '<div class="co-picks" id="coJobList"></div>';
  }
  window.coJobFind = function (text) {
    const list = el('coJobList');
    if (!list) return;
    const words = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
    const all = jobChoices().filter(j => {
      const hay = (j.name + ' ' + j.what + ' ' + j.where).toLowerCase();
      return words.every(w => hay.indexOf(w) !== -1);
    });
    list.innerHTML = pickRows(all.slice(0, PICKS_MAX).map(j => '<button type="button" class="co-pick" onclick="coJobPick(\'' + safe(j.id) + '\')">' +
        esc(j.name) + (j.what ? ' · ' + esc(j.what) : '') + (j.done ? ' (finished)' : '') + (j.where ? '<small>' + esc(j.where) + '</small>' : '') + '</button>'),
      all.length - PICKS_MAX) || '<p class="hint">No job like that.</p>';
  };
  window.coJobPick = function (id) {
    const info = infoFor(id);
    if (!edit || !info) return;
    Object.assign(edit, { jobId: id, jobName: info.name, jobNum: info.number || '', jobAddress: info.address || '', jobCustomer: info.customer || '' });
    drawJob();
  };
  window.coJobClear = function () {
    if (!edit) return;
    Object.assign(edit, { jobId: '', jobName: '', jobNum: '', jobAddress: '', jobCustomer: '' });
    drawJob();
  };
  function drawJob() {
    const w = el('coJob');
    if (!w) return;
    w.innerHTML = jobPickHtml();
    if (!edit.jobId) window.coJobFind('');
  }

  window.coServiceFind = function (text) {
    if (!edit) return;
    edit.service = String(text || '').slice(0, 100);
    const list = el('coServiceList');
    const q = edit.service.trim().toLowerCase();
    const names = window.YDServices ? YDServices.names() : [];
    const hits = q ? names.filter(n => n.toLowerCase().indexOf(q) !== -1 && n.toLowerCase() !== q) : [];
    if (list) list.innerHTML = hits.slice(0, PICKS_MAX).map(n => '<button type="button" class="co-pick" data-n="' + esc(n) +
      '" onclick="coServicePick(this.dataset.n)">' + esc(n) + '</button>').join('');
    // Taxed "as the job is" goes by the service.
    edit.materials.forEach(m => suggest(m));
    drawTotals();
  };
  window.coServicePick = function (name) {
    const box = el('coService');
    if (box) box.value = name;
    window.coServiceFind(name);
    const list = el('coServiceList');
    if (list) list.innerHTML = '';
  };
  window.coWhat = function (text) { if (edit) edit.what = String(text || '').slice(0, 4000); };
  window.coLabor = function (text) { if (edit) { edit.laborText = text; drawTotals(); } };

  // --------------------------------------------- materials, from Supplies

  // The item's own unit: what a takeoff is measured in when it says, else
  // what it is sold by. Crew phones have items, never prices.
  const unitOf = it => String((Number(it.coverage) > 0 && it.takeoffUnit) || it.unit || '').trim();
  function supplyHits(text) {
    const words = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length || !window.YDSupplies) return [];
    const c = YDSupplies.catalog(), skip = (window.YDPricing && YDPricing.NOT_FOR_ESTIMATES) || [];
    const hay = it => [it.name, it.also, it.sku, (c.vendors[it.vendorId] || {}).name].filter(Boolean).join(' ').toLowerCase();
    const first = String(words[0]);
    return Object.values(c.items).filter(it => it && it.name && skip.indexOf(it.category) === -1 && words.every(w => hay(it).indexOf(w) !== -1))
      .sort((a, b) => (String(a.name).toLowerCase().indexOf(first) === 0 ? 0 : 1) - (String(b.name).toLowerCase().indexOf(first) === 0 ? 0 : 1) ||
        String(a.name).localeCompare(String(b.name)));
  }
  window.coMatFind = function (text) {
    const list = el('coMatList');
    if (!list) return;
    const typed = String(text || '').trim();
    if (!typed) { list.innerHTML = ''; return; }
    const c = YDSupplies.catalog(), hits = supplyHits(typed);
    list.innerHTML = pickRows(hits.slice(0, PICKS_MAX).map(it => '<button type="button" class="co-pick" onclick="coMatPick(\'' + safe(it.id) + '\')">' +
        esc(it.name) + '<small>' + esc([(c.vendors[it.vendorId] || {}).name, unitOf(it)].filter(Boolean).join(' · ')) + '</small></button>'),
      hits.length - PICKS_MAX) +
      '<button type="button" class="co-pick typed" data-n="' + esc(typed) + '" onclick="coMatTyped(this.dataset.n)">+ Add “' + esc(typed) + '”, not on the list</button>';
  };
  function addMaterial(m) {
    edit.materials.push(m);
    suggest(m);
    const box = el('coMatFind');
    if (box) box.value = '';
    window.coMatFind('');
    drawMats();
    const q = el('coQty_' + m.id);
    if (q) q.focus();
  }
  window.coMatPick = function (sid) {
    const it = window.YDSupplies && YDSupplies.catalog().items[sid];
    if (!edit || !it) return;
    addMaterial({ id: newId('cm'), name: String(it.name).slice(0, 200), supplyId: sid, qty: null, unit: unitOf(it) });
  };
  window.coMatTyped = function (name) {
    if (!edit) return;
    addMaterial({ id: newId('cm'), name: String(name || '').trim().slice(0, 200), supplyId: null, qty: null, unit: '' });
  };
  window.coMatOff = function (id) {
    if (!edit) return;
    edit.materials = edit.materials.filter(m => m.id !== id);
    delete edit.prices[id];
    drawMats();
    drawTotals();
  };
  window.coMatSet = function (id, field, value) {
    const m = edit && edit.materials.find(x => x.id === id);
    if (!m) return;
    if (field === 'qty') {
      const n = parseFloat(String(value).replace(/,/g, ''));
      m.qty = isFinite(n) && n > 0 ? n : null;
    } else m.unit = String(value || '').slice(0, 30);
    if (suggest(m)) {
      const box = el('coPrice_' + id);
      if (box && document.activeElement !== box) box.value = edit.prices[id].text;
      const tick = el('coTax_' + id);
      if (tick) tick.checked = !!edit.prices[id].taxable;
    }
    drawTotals();
  };
  window.coPriceSet = function (id, text) {
    if (!edit) return;
    const p = edit.prices[id] = edit.prices[id] || { text: '', taxable: false };
    p.text = text; p.byHand = true;
    drawTotals();
  };
  window.coTaxSet = function (id, on) {
    if (!edit) return;
    const p = edit.prices[id] = edit.prices[id] || { text: '', taxable: false };
    p.taxable = !!on; p.taxHand = true;
    drawTotals();
  };

  // On the owner's device only: the figure an estimate would charge, as a
  // start, until he types his own. True when something changed.
  function suggest(m) {
    if (!isOwner() || !edit || !window.YDPricing || !YDPricing.materialPrice) return false;
    let got = null;
    try {
      got = YDPricing.materialPrice({ id: m.id, supplyId: m.supplyId || null, name: m.name, qty: m.qty, unit: m.unit }, edit.service);
    } catch (e) { console.warn('[changeorders] no figure for', m.name, e); }
    if (!got) return false;
    const p = edit.prices[m.id] = edit.prices[m.id] || { text: '', taxable: false };
    const was = p.text + '|' + p.taxable;
    if (!p.byHand) { p.text = got.cents === null ? '' : dollars(got.cents); p.usual = got.cents; }
    if (!p.taxHand) p.taxable = !!got.taxable;
    return was !== p.text + '|' + p.taxable;
  }

  function matRowHtml(m) {
    const owner = isOwner(), p = edit.prices[m.id] || {};
    const id = safe(m.id);
    return '<div class="co-mat">' +
      '<div class="co-mat-top"><span>' + esc(m.name) + '</span>' +
        '<button type="button" class="co-x" aria-label="Take it off" onclick="coMatOff(\'' + id + '\')">&times;</button></div>' +
      '<div class="co-mat-row">' +
        '<input id="coQty_' + id + '" inputmode="decimal" autocomplete="off" placeholder="How much" value="' + esc(m.qty == null ? '' : m.qty) + '" oninput="coMatSet(\'' + id + '\', \'qty\', this.value)">' +
        (m.supplyId ? '<span class="co-mat-unit">' + esc(m.unit || 'each') + '</span>'
          : '<input autocomplete="off" placeholder="tons, yards, each…" value="' + esc(m.unit || '') + '" oninput="coMatSet(\'' + id + '\', \'unit\', this.value)">') +
      '</div>' +
      (owner ? '<div class="co-mat-price"><label class="co-money-in"><span>$</span><input id="coPrice_' + id + '" inputmode="decimal" autocomplete="off" placeholder="Customer pays" value="' + esc(p.text || '') + '" oninput="coPriceSet(\'' + id + '\', this.value)"></label>' +
          '<label class="chk"><input type="checkbox" id="coTax_' + id + '"' + (p.taxable ? ' checked' : '') + ' onchange="coTaxSet(\'' + id + '\', this.checked)"> Taxed</label></div>' : '') +
    '</div>';
  }
  function drawMats() {
    const w = el('coMats');
    if (w) w.innerHTML = edit.materials.map(matRowHtml).join('');
  }

  // ---------------------------------------------------------------- the sums

  const taxRate = () => {
    const r = window.YDPricing ? YDPricing.rules() : null;
    const n = r ? parseFloat(r.customerTaxPct) : NaN;
    return isFinite(n) ? n : null;
  };
  function totals() {
    let material = 0, taxable = 0, unpriced = 0;
    const items = [];
    edit.materials.forEach(m => {
      const p = edit.prices[m.id] || {}, c = toCents(p.text);
      if (c === null) { unpriced++; return; }
      material += c;
      if (p.taxable) taxable += c;
      items.push({ id: m.id, cents: c, taxable: !!p.taxable });
    });
    const labor = toCents(edit.laborText) || 0, rate = taxRate();
    // Materials only, the proper ones. Never labor.
    const tax = taxable && rate !== null ? Math.round(taxable * rate / 100) : 0;
    return { items: items, unpriced: unpriced, rate: rate, materialCents: material, laborCents: labor, taxableCents: taxable, taxCents: tax,
             totalCents: material + labor + tax };
  }
  function drawTotals() {
    const w = el('coTotals');
    if (!w || !isOwner() || !edit) return;
    const t = totals();
    w.innerHTML = moneyHtml(t) +
      (t.rate === null && t.taxableCents ? '<p class="hint bad">The sales tax % for customers isn’t set (⋯ → Pricing rules).</p>' : '') +
      (t.unpriced ? '<p class="hint">' + t.unpriced + ' material' + (t.unpriced === 1 ? '' : 's') + ' still to price.</p>' : '') +
      (t.taxableCents && t.rate !== null ? '<p class="hint">Tax is ' + t.rate + '% on ' + money(t.taxableCents) + ' of materials. Labor is never taxed.</p>' : '');
  }

  function drawEditor(title) {
    const k = edit.isNew ? null : card(edit.id), owner = isOwner();
    const field = (label, html) => '<div class="field"><span class="label">' + label + '</span>' + html + '</div>';
    modal(title).innerHTML =
      (k ? '<p class="sg-for"><b>' + esc(stageName(k)) + '</b>' + (k.createdBy ? ' · put in by ' + esc(k.createdBy) : '') + '</p>' + sayHtml(k) : '') +
      field('Job', '<div id="coJob"></div>') +
      field('Service', '<input id="coService" autocomplete="off" placeholder="Type a few letters" value="' + esc(edit.service) + '" oninput="coServiceFind(this.value)">' +
        '<div class="co-picks" id="coServiceList"></div>') +
      field('What is changing', '<textarea id="coWhat" rows="4" placeholder="Measurements and what the customer asked for" oninput="coWhat(this.value)">' + esc(edit.what) + '</textarea>') +
      field('Materials', '<div class="co-mats" id="coMats"></div>' +
        '<input id="coMatFind" type="search" autocomplete="off" placeholder="Find a material" style="margin-top:8px" oninput="coMatFind(this.value)">' +
        '<div class="co-picks" id="coMatList"></div>') +
      (owner ? field('Labor', '<label class="co-money-in"><span>$</span><input id="coLabor" inputmode="decimal" autocomplete="off" placeholder="0.00" value="' + esc(edit.laborText) + '" oninput="coLabor(this.value)"></label>') +
        '<div id="coTotals"></div>' : '') +
      '<div class="co-acts" id="coActs">' + actionsHtml(k) + '</div>';
    drawJob();
    drawMats();
    drawTotals();
  }

  function actionsHtml(k) {
    const owner = isOwner(), stage = k ? stageOf(k) : 'price';
    const id = k ? safe(k.id) : '';
    return (owner ? '<button type="button" class="btn btn-filled" onclick="coSavePrice()">' + (k && k.price ? 'Save the price' : '💲 Save the price — on to To sign') + '</button>' : '') +
      (stage === 'price' ? '<button type="button" class="btn' + (owner ? '' : ' btn-filled') + '" onclick="coSaveWords()">Save — not signed yet</button>' : '') +
      (k ? signBtn(k, 'btn') : '') +
      (k && k.qbTry && k.qbTry.error && owner ? '<button type="button" class="btn" onclick="coTryAgain(\'' + id + '\')">Try QuickBooks again</button>' +
        '<button type="button" class="btn" onclick="coByHand(\'' + id + '\')">I put it in QuickBooks myself</button>' : '') +
      (k && owner && k.price && stage === 'sign' && !k.noSignature ? '<button type="button" class="btn" onclick="coNoSign(\'' + id + '\')">Add it without a signature</button>' : '') +
      // Signed on a phone that was lost or never got signal: the PDF may never
      // come, and the card would sit here for good.
      (k && owner && stage === 'signed' && !k.noSignature ? '<button type="button" class="btn" onclick="coNoSign(\'' + id + '\')">Add it without the signed PDF</button>' : '') +
      (k && owner && k.noSignature && stage === 'sign' ? '<button type="button" class="btn" onclick="coGetSigned(\'' + id + '\')">Get a signature instead</button>' : '') +
      (k && (owner || stage === 'price') ? '<button type="button" class="btn" onclick="coDelete(\'' + id + '\')">🗑 Delete it</button>' : '');
  }

  // ---------------------------------------------------------------- saving

  function wordsOf() {
    return { jobId: edit.jobId, jobName: edit.jobName, jobNum: edit.jobNum || '', jobAddress: edit.jobAddress || '', jobCustomer: edit.jobCustomer || '',
             service: edit.service.trim(), what: edit.what.trim(),
             materials: edit.materials.map(m => ({ id: m.id, name: m.name, supplyId: m.supplyId || null, qty: m.qty == null ? null : m.qty, unit: m.unit || '' })),
             updatedAt: nowIso(), updatedBy: myName() };
  }
  function ready() {
    if (!edit.jobId) { showToast('Tap the job first'); return false; }
    if (!edit.what.trim()) { showToast('Say what is changing'); return false; }
    return true;
  }
  window.coSaveWords = function () {
    if (!edit || !ready()) return;
    const data = wordsOf(), id = edit.id || newId('co');
    data.title = titleOf(data);
    if (edit.isNew) {
      Object.assign(data, { column: TO_PRICE, order: -Date.now(), createdAt: nowIso(), createdBy: myName(), byUid: (me() || {}).uid || '' });
    }
    put(id, data);
    const made = edit.isNew;
    window.coClose();
    showToast(made ? 'Saved, not signed yet — it is with Jonah to price' : 'Saved');
  };

  window.coSavePrice = async function () {
    if (!edit || !isOwner() || !ready()) return;
    const t = totals();
    if (t.unpriced) { showToast('Give every material a price'); return; }
    if (t.taxableCents && t.rate === null) { showToast('Set the sales tax % in Pricing rules first'); return; }
    if (toCents(edit.laborText) === null && !edit.materials.length) { showToast('Put in the price'); return; }
    const k = edit.isNew ? null : card(edit.id);
    const signed = !!(k && k.signDoc);
    // What was signed is the words and the split as well as the total: the
    // same total with the tax or the materials moved is a different paper.
    const parts = p => JSON.stringify([(p.items || []).map(i => [i.id, i.cents, !!i.taxable]), p.materialCents, p.laborCents, p.taxableCents, p.taxCents]);
    const changed = !!(k && k.price) && (k.price.totalCents !== t.totalCents || parts(k.price) !== parts(t) || (k.what || '').trim() !== edit.what.trim());
    if (signed && changed && !(await ydConfirm(k.price.totalCents !== t.totalCents
      ? 'It was signed for ' + money(k.price.totalCents) + '. A new price of ' + money(t.totalCents) + ' means getting it signed again.'
      : 'The total is the same, but the paper signed said something else. Changing it means getting it signed again.',
      { title: 'Change what was signed?', ok: 'Change it' }))) return;
    if (!edit) return;
    const data = wordsOf(), id = edit.id || newId('co');
    data.title = titleOf(data);
    data.price = { items: t.items, materialCents: t.materialCents, laborCents: t.laborCents, taxableCents: t.taxableCents, taxCents: t.taxCents,
                   ratePct: t.rate, totalCents: t.totalCents, at: nowIso(), by: (me() || {}).uid || '', byName: myName(),
                   round: ((k && k.price && k.price.round) || 0) + (signed && changed ? 1 : 0) };
    data.said = null; data.qbTry = null;
    if (edit.isNew) Object.assign(data, { order: -Date.now(), createdAt: nowIso(), createdBy: myName(), byUid: (me() || {}).uid || '' });
    if (!k || !k.signDoc || changed) {
      Object.assign(data, { column: TO_SIGN, signDoc: null, signedAt: null, signedName: null, signedBy: null });
    }
    put(id, data);
    window.coClose();
    showToast('Priced: ' + money(t.totalCents) + ' — on To sign');
  };

  window.coDelete = async function (id) {
    const k = card(id);
    if (!k) return;
    if (!(await ydConfirm('This cannot be undone.', { title: 'Delete this change order?', ok: 'Delete', danger: true }))) return;
    Promise.resolve(window.YDDb.remove(CARDS, id))
      .catch(e => showToast(e && e.code === 'permission-denied' ? 'Not allowed to delete that' : 'Not deleted yet — will retry'));
    window.coClose();
    showToast('Deleted');
  };

  // ---------------------------------------------------------- signature, or not

  window.coSign = function (id) {
    const k = card(id);
    if (!k) return;
    if (!k.price) { showToast('Jonah prices it first'); return; }
    if (stageOf(k) !== 'sign' || !window.YDSignatures) return;
    window.coClose();
    const p = k.price;
    YDSignatures.signCard({
      cardId: id, jobId: k.jobId,
      info: { name: k.jobName || 'Customer', customer: k.jobCustomer || k.jobName || '', address: k.jobAddress || '', number: k.jobNum || '', work: [] },
      service: k.service || '', what: k.what || '', materials: (k.materials || []).map(matWords),
      parts: { materialCents: p.materialCents || 0, laborCents: p.laborCents || 0, taxCents: p.taxCents || 0, totalCents: p.totalCents || 0 },
      onSaved: (paper, rec) => put(id, { column: SIGNED, signDoc: paper, signedAt: rec.signedAt, signedName: rec.signedName,
                                         signedBy: (me() || {}).uid || '', updatedAt: nowIso(), updatedBy: myName() }),
    });
  };
  window.coNoSign = async function (id) {
    const k = card(id);
    if (!k || !isOwner() || !k.price) return;
    const signed = !!k.signDoc;
    if (!(await ydConfirm(signed ? 'Use this when the signed PDF never reached Job Hub, say the phone was lost. It goes on the job’s QuickBooks invoice, and is not emailed.'
      : 'It goes on the job’s QuickBooks invoice with no signature, and is not emailed. Send the invoice when you are ready.',
      { title: signed ? 'Add it without the signed PDF?' : 'Add it without a signature?', ok: 'Add it' }))) return;
    put(id, { noSignature: { at: nowIso(), by: (me() || {}).uid || '', name: myName() }, qbTry: null, said: null, updatedAt: nowIso(), updatedBy: myName() });
    window.coClose();
    showToast('It goes on QuickBooks within five minutes');
  };
  window.coGetSigned = function (id) {
    if (!card(id) || !isOwner()) return;
    put(id, { noSignature: null, qbTry: null, updatedAt: nowIso(), updatedBy: myName() });
    window.coClose();
  };
  window.coTryAgain = function (id) {
    if (!card(id) || !isOwner()) return;
    put(id, { qbTry: null });
    window.coClose();
    showToast('It tries again within five minutes');
  };

  // Done by hand in QuickBooks: nothing is sent, and the card is finished.
  window.coByHand = async function (id) {
    if (!card(id) || !isOwner()) return;
    if (!(await ydConfirm('The card moves to Added and nothing is sent to QuickBooks from here.',
      { title: 'It is in QuickBooks already?', ok: 'Yes, it is in' }))) return;
    put(id, { column: ADDED, doneAt: nowIso(), qb: { ok: true, at: nowIso(), byHand: true }, qbTry: null, said: 'Put in QuickBooks by hand',
              updatedAt: nowIso(), updatedBy: myName() });
    window.coClose();
  };

  // ------------------------------------------------------- the list on a job

  const mounts = new Map();     // container -> what the paper says about the job, or null
  const forJob = id => Object.values(cards()).filter(k => k.jobId === id)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  function rowHtml(k) {
    const words = [k.service, String(k.what || '').split('\n')[0]].filter(Boolean).join(' · ').slice(0, 120);
    return '<button type="button" class="co-row" onclick="coOpen(\'' + safe(k.id) + '\')">' +
      '<b>' + esc(words || 'Change order') + '</b>' +
      '<span class="co-row-total">' + (k.price ? money(k.price.totalCents) : '') + '</span>' +
      '<span>' + (k.qb && k.qb.docNumber ? esc(k.qb.entity === 'Estimate' ? 'Estimate' : 'Invoice') + ' #' + esc(k.qb.docNumber) : '') + '</span>' +
      '<span class="co-row-stage">' + esc(stageName(k)) + '</span></button>';
  }
  function draw(c) {
    const id = c.getAttribute('data-job');
    const onJobTab = c.id === 'jobCoBody';
    if (!id) { c.innerHTML = onJobTab ? '<p class="muted">Save the job first, then add a change order.</p>' : ''; return; }
    const list = forJob(id);
    if (!mayAdd() && !list.length) { c.innerHTML = ''; return; }
    c.innerHTML = (onJobTab ? '' : '<div class="cj-h">🧾 Change orders</div>') +
      (mayAdd() ? '<button type="button" class="btn sg-start" onclick="coAdd(\'' + safe(id) + '\')">🧾 Change order</button>' : '') +
      (list.length ? '<div class="co-list">' + list.map(rowHtml).join('') + '</div>'
        : onJobTab ? '<p class="muted">None yet.</p>' : '');
  }
  function drawAll() { mounts.forEach((info, c) => { if (!c.isConnected) mounts.delete(c); else draw(c); }); }
  // Show job `id`'s change orders in `container`; `info` is what the signed
  // paper says about the job (the crew's job page has no job form to read).
  function mount(container, id, info) {
    if (!container) return;
    mounts.forEach((v, c) => { if (!c.isConnected) mounts.delete(c); });
    mounts.set(container, info || null);
    container.setAttribute('data-job', safe(id || ''));
    draw(container);
  }
  // The Job tab: a section after the signatures (app.js jobOnScreen).
  function jobShown(id) {
    if (!ydCan('jobs', 'see')) return;
    let sec = el('jobCoSection');
    if (!sec) {
      const after = el('jobSigsSection') || el('jobPhotosSection') || el('estimateSection');
      if (!after) return;
      sec = document.createElement('div');
      sec.className = 'section';
      sec.id = 'jobCoSection';
      sec.innerHTML = '<div class="section-head"><span class="section-title">Change orders</span></div>' +
        '<div class="section-body" id="jobCoBody"></div>';
      after.insertAdjacentElement('afterend', sec);
    }
    mount(el('jobCoBody'), id || '', null);
  }

  document.addEventListener('yd-cards-changed', () => {
    drawAll();
    keepBoard();
    // A crew member's window on a card Jonah has just priced: it stands now,
    // and shows as it stands.
    if (edit && !edit.isNew && !isOwner() && (card(edit.id) || {}).price) { open(edit.id); showToast('Jonah has priced it'); return; }
    // Nothing is typed in a card shown as it stands: it follows.
    if (viewing && card(viewing)) drawView(card(viewing));
  });
  document.addEventListener('yd-boards-ready', () => { keepBoard(); SEED_RETRIES.forEach(ms => setTimeout(keepBoard, ms)); });
  document.addEventListener('yd-boards-changed', keepBoard);
  let who = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user ? a.user.uid + ':' + (a.key || a.role) : null;
    if (k === who) return;
    who = k;
    seedAsked = false;
    window.coClose();
    mounts.clear();
  });

  window.YDChangeOrders = { cardHtml: cardHtml, add: add, open: open, mount: mount, jobShown: jobShown, forJob: forJob, stageOf: stageOf };
})();
