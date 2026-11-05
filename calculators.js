// Material calculators (Jonah, 4 Nov 2026: "add in material calculators so guys
// can quickly calculate material needed like for example gravel with
// assumptions of settling and compaction and then a button with: add to job").
//
// Length, width and depth, tapped in on site, come out as what to order, by the
// rules in his build notes (pricing/claude): sq ft × depth ÷ 27 = cu yd, × 1.4
// = tons for stone, with 20% on top that covers compaction and settling, rounded
// UP to the quarter ton because no yard fills less and rounding down leaves the
// job short. Soil and mulch by the yard with the 10% their kinds carry. Both
// figures are on the screen in a box to change, so a soft site or a deep lift is
// a tap away (manual override always).
//
// Add to job: whoever may change jobs puts it on the job's Materials to Order;
// the crew, who cannot, send it to Jonah as a note on that job, which is the
// same thing a crew member would do by phone.
(function () {
  'use strict';

  // cover: the % on top for compaction, settling and waste.
  const KINDS = [
    { id: 'gravel', name: 'Road gravel', item: 'Road gravel', how: 'ton', cover: 20, depth: 6 },
    { id: 'clean', name: 'Clean stone', item: 'Clean stone', how: 'ton', cover: 20, depth: 4 },
    { id: 'sand', name: 'Torpedo sand', item: 'Torpedo sand', how: 'ton', cover: 20, depth: 1 },
    { id: 'screen', name: 'Limestone screenings', item: 'Limestone screenings', how: 'ton', cover: 20, depth: 1 },
    { id: 'soil', name: 'Topsoil', item: 'Topsoil — screened', how: 'yard', cover: 10, depth: 4 },
    { id: 'mulch', name: 'Mulch', item: '', how: 'yard', cover: 10, depth: 3 },
  ];
  const TONS_PER_YARD = 1.4, STEP = 0.25;
  const DEPTHS = [1, 2, 3, 4, 6, 8, 12];
  const el = id => document.getElementById(id);
  const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return isFinite(n) && n > 0 ? n : 0; };
  let at = null;       // what is on the screen: { kind, depth, cover, jobId, jobName }

  // What to order, from the sizes: { sqFt, cuYd, amount, unit, words }, or null
  // while a size is missing. `amount` is what goes on the order.
  function work(k, lengthFt, widthFt, depthIn, cover) {
    const sqFt = lengthFt * widthFt;
    if (!(sqFt > 0) || !(depthIn > 0)) return null;
    const cuYd = sqFt * (depthIn / 12) / 27;
    const withCover = cuYd * (1 + (cover || 0) / 100);
    const raw = k.how === 'ton' ? withCover * TONS_PER_YARD : withCover;
    const amount = Math.ceil(raw / STEP - 1e-9) * STEP;
    return { sqFt: sqFt, cuYd: cuYd, amount: amount, unit: k.how === 'ton' ? 'ton' : 'yard',
             words: Math.round(sqFt) + ' sq ft at ' + depthIn + ' in = ' + cuYd.toFixed(2) + ' cu yd' +
               (cover ? ', + ' + cover + '% for compaction and settling' : '') +
               (k.how === 'ton' ? ', × ' + TONS_PER_YARD + ' tons a yard' : '') };
  }
  const amountWords = r => r.amount + ' ' + r.unit + (r.amount === 1 ? '' : 's');

  function modal() {
    let m = el('calcModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal-overlay';
      m.id = 'calcModal';
      m.onclick = ev => { if (ev.target === m) m.classList.remove('active'); };
      m.innerHTML = '<div class="modal" style="max-width:520px"><div class="modal-head"><h2>🧮 Material calculator</h2>' +
        '<button class="modal-close">&times;</button></div><div class="modal-body" id="calcBody"></div></div>';
      m.querySelector('.modal-close').onclick = () => m.classList.remove('active');
      document.body.appendChild(m);
    }
    m.classList.add('active');
    return el('calcBody');
  }
  const kindOf = id => KINDS.find(k => k.id === id) || KINDS[0];
  function draw() {
    const body = el('calcBody');
    if (!body || !at) return;
    const k = kindOf(at.kind);
    const chip = (on, label, call) => '<button type="button" class="btn btn-sm calc-chip' + (on ? ' btn-filled' : '') + '" onclick="' + call + '">' + label + '</button>';
    body.innerHTML =
      '<div class="calc-chips">' + KINDS.map(x => chip(x.id === k.id, x.name, "calcKind('" + x.id + "')")).join('') + '</div>' +
      '<div class="grid g2"><label class="field"><span class="label">Length (ft)</span>' +
          '<input id="calcL" inputmode="decimal" value="' + (at.l || '') + '" oninput="calcType()"></label>' +
        '<label class="field"><span class="label">Width (ft)</span>' +
          '<input id="calcW" inputmode="decimal" value="' + (at.w || '') + '" oninput="calcType()"></label></div>' +
      '<div class="field"><span class="label">Depth (inches)</span><div class="calc-chips">' +
        DEPTHS.map(d => chip(d === at.depth, d + ' in', 'calcDepth(' + d + ')')).join('') + '</div></div>' +
      '<label class="field"><span class="label">Extra for compaction and settling (%)</span>' +
        '<input id="calcC" inputmode="decimal" value="' + at.cover + '" oninput="calcType()"></label>' +
      '<div class="calc-out" id="calcOut"></div>' +
      (at.jobId ? '<div class="field-actions"><button type="button" class="btn btn-filled" id="calcAdd" onclick="calcAdd()"></button></div>'
        : '<p class="hint">Open this from a job to add it to that job.</p>');
    show();
  }
  function now() {
    const k = kindOf(at.kind);
    return { k: k, r: work(k, num((el('calcL') || {}).value), num((el('calcW') || {}).value), at.depth, num((el('calcC') || {}).value)) };
  }
  function show() {
    const { r } = now(), out = el('calcOut'), add = el('calcAdd');
    if (out) out.innerHTML = r ? '<b>' + esc(amountWords(r)) + '</b><small>' + esc(r.words) + '</small>' : '<small>Put in the length and width.</small>';
    if (add) {
      add.disabled = !r;
      add.textContent = canChange() ? 'Add to ' + (at.jobName || 'the job') : 'Send it to Jonah for ' + (at.jobName || 'this job');
    }
  }
  const canChange = () => typeof ydCan === 'function' && ydCan('jobs', 'change');

  // On the job's order list, or for the crew a note on the job. Its line is the
  // Supplies item when there is one by that name, so its supplier and price come.
  function supplyFor(k) {
    const cat = window.YDSupplies && YDSupplies.catalog ? YDSupplies.catalog() : null;
    return cat && k.item ? Object.values(cat.items || {}).find(s => s && s.name === k.item) || null : null;
  }
  window.calcAdd = function () {
    const { k, r } = now();
    if (!r || !at.jobId) return;
    const sup = supplyFor(k), name = (sup && sup.name) || k.name, jobId = at.jobId;
    if (!canChange()) {
      const said = window.YDCrewNotes && YDCrewNotes.sendAbout &&
        YDCrewNotes.sendAbout('Need ' + amountWords(r) + ' of ' + name + ' (' + r.words + ').', jobId, at.jobName);
      showToast(said ? 'Sent to Jonah' : 'That did not go — try again');
      if (said) el('calcModal').classList.remove('active');
      return;
    }
    const line = { id: typeof uid === 'function' ? uid() : 'c' + Date.now().toString(36), proposalId: null, name: name, quantity: amountWords(r), qty: r.amount,
      per: r.unit, supplyId: sup ? sup.id : null, vendorId: sup ? sup.vendorId || null : null, ordered: false, fromCalc: r.words };
    let ok = false;
    if (typeof currentJobId !== 'undefined' && currentJobId === jobId) {
      orderItems.push(line);
      if (typeof renderOrderList === 'function') renderOrderList();
      if (typeof markDirty === 'function') markDirty();
      ok = true;
    } else {
      let d = null;
      try { d = JSON.parse(readJobBlob(jobId) || 'null'); } catch (e) { /* not here */ }
      ok = !!(d && window.YDSync && YDSync.patchJob(jobId, { orderItems: (d.orderItems || []).concat([line]) }));
    }
    showToast(ok ? amountWords(r) + ' of ' + name + ' added to ' + (at.jobName || 'the job') : 'That job is not on this device yet');
    if (ok) el('calcModal').classList.remove('active');
  };
  window.calcKind = function (id) {
    const k = kindOf(id);
    at.l = (el('calcL') || {}).value || ''; at.w = (el('calcW') || {}).value || '';
    at.kind = k.id; at.depth = k.depth; at.cover = k.cover;
    draw();
  };
  window.calcDepth = function (d) {
    at.l = (el('calcL') || {}).value || ''; at.w = (el('calcW') || {}).value || ''; at.cover = num((el('calcC') || {}).value);
    at.depth = d;
    draw();
  };
  window.calcType = show;
  window.YDCalc = {
    open: (jobId, jobName) => {
      const k = KINDS[0];
      at = { kind: k.id, depth: k.depth, cover: k.cover, jobId: jobId || '', jobName: jobName || '', l: '', w: '' };
      modal();
      draw();
    },
    // The open job on the Job tab.
    openHere: () => window.YDCalc.open(typeof currentJobId !== 'undefined' ? currentJobId : '',
      ((el('customerName') || {}).value || '').trim()),
    work: work, KINDS: KINDS,
  };
})();
