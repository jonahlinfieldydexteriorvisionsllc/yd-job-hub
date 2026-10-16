// Receipts -- a tab of its own: the ones to sort, then every one so far.
//
// The server reads the owner's email every half hour (functions/receipts.py)
// and writes each purchase it finds to receipts/{id}: the store, the date,
// every line, the tax and the total, and a job it thinks the purchase is for
// when the delivery address or a name on the order says so. This screen is
// where each one is sorted: to a job, a vehicle, shop overhead, office
// overhead, personal, a subcontractor -- or set aside, with a note saying
// why (DEST below).
//
// "Add to job" puts the ticked lines into that job's materials (Tracking),
// one materials line per receipt line, plus that job's share of the sales
// tax, so the job carries what was actually paid. The lines go in through
// YDSync.patchJob -- the same road a board move takes -- so this device's
// copy, the cloud and the crew's job list all follow, and a job open in the
// form keeps what is being typed into it. Every line carries the receipt's id
// and the split's id, which is what makes Undo exact.
//
// An order is nearly always for one job, so that is the whole screen: pick
// the job, Add to job, and every line goes on. For the odd order that covers
// two, "Split across jobs" brings up a tick box per line: add some lines to
// one job, the rest to another. Tax is shared out by value, and the last
// split takes whatever cent is left so the jobs add up to the receipt exactly.

(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const safeId = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const endpoint = () => ((window.YD_CONFIG || {}).claudeEndpoint || '').replace(/\/+$/, '');
  const money = c => fmtMoney((Number(c) || 0) / 100);
  const me = () => (window.YDAuth && window.YDAuth.user) || null;

  let receipts = {};          // id -> record: everything below, put together (settle)
  // Not the whole collection, which only ever grows (review, 12 Oct 2026):
  // live, every receipt still to sort and every one dated from the 1st of
  // January last year -- this year's books and last year's, and the year
  // back that Subcontractors and the Equipment pages read. Older ones are
  // asked for once, when someone searches All receipts or asks for them.
  let toSort = {};            // id -> record, status 'new' (live)
  let recent = {};            // id -> record, dated from `since` (live)
  let older = {};             // id -> record, dated before `since` (read once, loadOlder)
  let since = '';             // 'YYYY-01-01', last year's
  let olderState = '';        // '' not read, 'loading', 'done', 'failed'
  let toSortHeard = false, recentHeard = false;
  let state = null;           // settings/receipts: when email was last read
  let unsubs = [];
  let loaded = false;
  let checking = false;
  let deferred = false;       // a redraw held back while something is being chosen
  const ticked = {};          // receipt id -> Set of line indexes, once changed by hand
  const chosen = {};          // receipt id -> job id picked
  const splitting = {};       // receipt id -> true once "Split across jobs" is pressed

  const KIND = {
    materials: 'Materials', plants: 'Plants', dump_and_disposal: 'Dump & disposal',
    equipment_and_repairs: 'Equipment & repairs', fuel: 'Fuel', tools: 'Tools', rental: 'Rental',
    subcontractor: 'Subcontractor', vehicle: 'Vehicle', office_and_software: 'Office & software',
    insurance: 'Insurance', utilities_and_phone: 'Utilities & phone', other: 'Other',
  };
  // Why a receipt was set aside, in the words of the old pick list. Only read
  // back now: since 13 Oct `skipWhy` is the note typed when it was set aside
  // (Jonah: "when something is selected to be set aside have an area to add
  // a note for why"). 'overhead' (before 9 Oct) and 'subcontractor' (before
  // 13 Oct) were really places -- read back as the shop and Subcontractors
  // (LEGACY_PLACE) -- and 'personal' is a place too.
  const WHY = { overhead: 'Shop overhead', personal: 'Personal', notPurchase: 'Not a purchase',
    alreadyEntered: 'Already entered', subcontractor: 'Subcontractor bill' };
  const LEGACY_PLACE = { overhead: 'shop', subcontractor: 'sub' };
  // Offered under the note box; anything else can be typed.
  const WHY_IDEAS = ['Already entered', 'Not a purchase', 'Duplicate of another receipt', 'Returned / refunded'];

  // Where a receipt goes (Jonah, 9 Oct 2026: "sort receipts ... by vehicle/
  // job/shop overhead/office overhead/personal"). Each split says where its
  // lines went (`to`); one with no `to` went to a job, as all did before.
  // The first choice comes from what Claude already said the purchase was
  // (`kind`, read with the receipt -- no extra call): fuel and repairs to a
  // vehicle, office things to the office, tools to the shop, the rest a job.
  //
  // A subcontractor's bill is a place of its own (Jonah, 13 Oct 2026: "sub
  // bills should have its own category"): a split `to: 'sub'` naming them
  // (`subId` when they are set up under Subcontractors, subs.js). "Set
  // aside" is the last choice: not a place -- nothing set aside counts
  // anywhere ("anything set aside clearly doesnt have a category and doesnt
  // matter") -- but chosen the same way, with a note for why.
  const DEST = [['job', '📋 Job'], ['vehicle', '🚚 Vehicle'], ['shop', '🏠 Shop overhead'],
                ['office', '🗂 Office overhead'], ['sub', '🤝 Subcontractor'], ['personal', '👤 Personal'],
                ['aside', '🗄 Set aside']];
  const DEST_NAME = { job: 'Job', vehicle: 'Vehicle', shop: 'Shop overhead', office: 'Office overhead',
    sub: 'Subcontractor', personal: 'Personal', aside: 'Set aside' };
  const DEST_OF_KIND = { fuel: 'vehicle', vehicle: 'vehicle', equipment_and_repairs: 'vehicle',
    office_and_software: 'office', utilities_and_phone: 'office', insurance: 'office', tools: 'shop' };
  const destOf = s => s.to || 'job';
  const dest = {};            // receipt id -> where it is going, once picked
  const chosenGear = {};      // receipt id -> vehicle picked
  const chosenSub = {};       // receipt id -> subcontractor picked ('' = by the store's name)
  const asideWhy = {};        // receipt id -> the note typed so far for setting it aside
  // The subcontractor whose bill this looks like (subs.js: their "match"
  // words in the store's name). Only the owner has the list.
  const subMatch = r => (window.YDSubs && YDSubs.subFor ? YDSubs.subFor(r) : null);
  const subsKnown = () => (window.YDSubs && YDSubs.list ? YDSubs.list() : []);
  function defaultDest(r) {
    if (r.kind === 'subcontractor') return 'sub';
    if (r.suggest && r.suggest.jobId) return 'job';
    // A subcontractor that also sells materials keeps those for the jobs.
    if ((!r.kind || r.kind === 'other') && subMatch(r)) return 'sub';
    return DEST_OF_KIND[r.kind] || 'job';
  }
  // The vehicles and machines on the Equipment tab, vehicles first.
  function gearList() {
    if (!window.YDEquipment || !ydCan('equipment', 'see')) return [];
    const cm = YDEquipment.countsMiles || (() => false);
    return Object.values(YDEquipment.all() || {}).filter(g => g && g.id)
      .sort((a, b) => (cm(b) - cm(a)) || String(a.name || '').localeCompare(String(b.name || '')));
  }

  const sees = () => typeof ydCan === 'function' && ydCan('jobs', 'see');
  const sorts = () => typeof ydCan === 'function' && ydCan('jobs', 'change');

  // ------------------------------------------------------------ the record

  // Which lines already sit on a job, and on which.
  function splitOf(r) {
    const at = {};
    (r.splits || []).forEach(s => (s.lines || []).forEach(i => { at[i] = s; }));
    return at;
  }
  function freeLines(r) {
    const at = splitOf(r);
    return (r.lines || []).map((_, i) => i).filter(i => !at[i]);
  }
  // Split up, either because it was asked for or because part of it is
  // already on a job.
  function isSplit(rid, r) {
    return !!splitting[rid] || (r.splits || []).length > 0;
  }
  function tickedLines(rid, r) {
    const free = freeLines(r);
    return ticked[rid] && isSplit(rid, r) ? free.filter(i => ticked[rid].has(i)) : free;
  }
  // "Personal" for part of the receipt -- some of it sorted already, or split
  // up with only some lines ticked -- rather than the whole of it.
  function partlyPersonal(rid, r) {
    return (r.splits || []).length > 0 || (isSplit(rid, r) && tickedLines(rid, r).length < freeLines(r).length);
  }

  function jobsList() {
    const order = { inprogress: 0, booked: 1, quoting: 2, complete: 3 };
    return (typeof loadAllJobs === 'function' ? loadAllJobs() : [])
      .filter(j => j && j._id)
      .map(j => ({ id: j._id, name: (j.customerName || '').trim() || 'Untitled job',
        est: String(j.estimateNumber || '').trim(), status: normStatus(j.jobStatus, j) }))
      .sort((a, b) => (order[a.status] - order[b.status]) || a.name.localeCompare(b.name));
  }
  function jobLabel(j) {
    return j.name + (j.est ? ' #' + j.est : '') + (j.status === 'complete' ? ' (complete)' : '');
  }

  // ------------------------------------------------------------ writing

  // Not awaited: a write only settles when the server answers, and a truck
  // with no signal would sit frozen. Firestore holds it until then.
  function write(rid, data) {
    data.updatedAt = new Date().toISOString();
    data.updatedBy = (me() || {}).uid || '';
    Promise.resolve(window.YDDb.put('receipts', rid, data)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[receipts] not yet on the server:', (e && e.code) || e);
    });
  }

  // Change one job's materials (and its Materials to Order list) by a
  // function, wherever that job is: through patchJob for the stored copy,
  // and -- when it is open in the form with unsaved typing -- in the form too,
  // so its next save keeps the change.
  function changeJob(jobId, matFn, orderFn) {
    let job;
    try { job = JSON.parse(readJobBlob(jobId) || 'null'); } catch (e) { job = null; }
    if (!job) { showToast('That job is not on this device yet'); return null; }
    const openWithEdits = jobId === currentJobId && dirty;
    const patch = { materials: matFn(job.materials || []) };
    if (orderFn) patch.orderItems = orderFn(job.orderItems || []);
    if (!window.YDSync || !YDSync.patchJob(jobId, patch)) {
      showToast('Could not change that job');
      return null;
    }
    if (openWithEdits) {
      materials = matFn(materials); renderMaterials();
      if (orderFn) { orderItems = orderFn(orderItems); renderOrderList(); }
    }
    return Object.assign(job, patch);
  }

  // Ticks "ordered" on the Materials to Order items this split's lines are
  // (app.js sameMaterial: plain word matching, no Claude), noting the order;
  // Undo takes back only the ticks it made.
  function tickOrdered(list, lineNames, info) {
    return list.map(it => (!it.ordered && lineNames.some(n => sameMaterial(it.name, n)))
      ? Object.assign({}, it, { ordered: true, orderNo: info.orderNo, orderedFrom: info.vendor,
        orderReceiptId: info.rid, orderSplitId: info.sid })
      : it);
  }
  function untickOrdered(list, sid) {
    return list.map(it => it.orderSplitId === sid
      ? Object.assign({}, it, { ordered: false, orderNo: null, orderedFrom: null, orderReceiptId: null, orderSplitId: null })
      : it);
  }

  // ------------------------------------------------------------ actions

  window.rcTick = function (rid, i, on) {
    const r = receipts[rid];
    if (!r) return;
    if (!ticked[rid]) ticked[rid] = new Set(freeLines(r));
    if (on) ticked[rid].add(i); else ticked[rid].delete(i);
    redraw();
  };

  window.rcPickJob = function (rid, jobId) {
    chosen[rid] = jobId;
  };

  window.rcSplit = function (rid, on) {
    if (on) splitting[rid] = true; else { delete splitting[rid]; delete ticked[rid]; }
    redraw(true);
  };
  window.rcDest = function (rid, to) {
    if (!DEST_NAME[to]) return;
    dest[rid] = to;
    redraw(true);
    // Set aside asks for its note at once.
    if (to === 'aside') { const box = el('rcWhy_' + rid); if (box) box.focus(); }
  };
  window.rcPickGear = function (rid, id) { chosenGear[rid] = id; };
  window.rcPickSub = function (rid, id) { chosenSub[rid] = id; };
  // Kept as it is typed, so a redraw (a receipt arriving) never loses it.
  window.rcWhyTyped = function (rid, text) { asideWhy[rid] = text; };

  // The ticked lines (all of them, when not split up) and their share of
  // the sales tax: by value, the last share taking whatever cent is left so
  // the shares add up to the receipt exactly.
  function portion(rid, r) {
    // A receipt with no lines at all (the email gave no total either) goes
    // whole: the old "Something else…" list was the only way to move one.
    if (!(r.lines || []).length && !(r.splits || []).length) {
      return { free: [], idxs: [], lines: [], part: Math.max(0, (r.totalCents || 0) - (r.taxCents || 0)),
        tax: r.taxCents || 0, last: true };
    }
    const free = freeLines(r);
    const idxs = tickedLines(rid, r);
    if (!idxs.length) { showToast('Tick at least one line'); return null; }
    const lines = r.lines || [];
    const all = lines.reduce((s, l) => s + (l.cents || 0), 0);
    const part = idxs.reduce((s, i) => s + (lines[i].cents || 0), 0);
    const last = idxs.length === free.length;
    const taxSoFar = (r.splits || []).reduce((s, x) => s + (x.taxCents || 0), 0);
    const tax = last ? (r.taxCents || 0) - taxSoFar
      : (all ? Math.round((r.taxCents || 0) * part / all) : 0);
    return { free, idxs, lines, part, tax, last };
  }

  // A vehicle, the shop or the office: kept on the receipt, nothing changes
  // on a job. The vehicle's own page lists what was sorted to it
  // (equipment.js receiptsHtml).
  // `given`: where a photo was sent in for (autoSort), instead of what is
  // picked on the card; `auto`: what to note on the receipt then.
  function assignElsewhere(rid, r, to, given, auto) {
    let target = given || null;
    if (target) {
      // Already said.
    } else if (to === 'vehicle') {
      const id = chosenGear[rid];
      const g = id && gearList().find(x => x.id === id);
      if (!g) { showToast('Pick the vehicle first'); return false; }
      target = { equipmentId: g.id, name: g.name || 'Vehicle' };
    } else if (to === 'sub') {
      // One set up under Subcontractors (subs.js reads its bills by subId),
      // else by the store's name -- an admin has no list, and subs.js still
      // finds theirs by name.
      const id = chosenSub[rid] != null ? chosenSub[rid] : ((subMatch(r) || {}).id || '');
      const s = id && subsKnown().find(x => x.id === id);
      target = s ? { subId: s.id, name: s.name || r.vendor || 'Subcontractor' }
        : { name: (r.vendor || '').trim() || 'Subcontractor' };
    } else {
      target = { name: DEST_NAME[to] };
    }
    const p = portion(rid, r);
    if (!p) return false;
    const splits = (r.splits || []).concat([Object.assign({
      id: 'sp' + Date.now().toString(36) + uid(), to: to, lines: p.idxs, cents: p.part, taxCents: p.tax,
      at: new Date().toISOString(), by: (me() || {}).uid || '',
    }, auto ? { auto: true } : {}, target)]);
    const status = p.last ? 'done' : (r.status === 'skipped' ? 'skipped' : 'new');
    receipts[rid] = Object.assign({}, r, { splits, status }, auto ? { auto } : {});
    delete ticked[rid];
    write(rid, Object.assign({ splits, status }, auto ? { auto } : {}));
    showToast((auto ? '🧾 ' + (r.vendor || 'Receipt') + ' ' : '') + money(p.part + p.tax) + ' → ' + target.name +
      (auto ? ' (sent in for it)' : ''));
    redraw(true);
    return true;
  }

  window.rcAssign = function (rid) {
    if (!sorts()) { showToast('You can look at jobs but not change them'); return; }
    const r = receipts[rid];
    if (!r) return;
    const to = dest[rid] || defaultDest(r);
    if (to === 'aside') { setAside(rid, r); return; }
    if (to === 'personal') { window.rcSkip(rid, 'personal'); return; }
    if (to !== 'job') { assignElsewhere(rid, r, to); return; }
    const jobId = chosen[rid] != null ? chosen[rid] : ((r.suggest && r.suggest.jobId) || '');
    if (!jobId) { showToast('Pick the job first'); return; }
    const done = addToJob(rid, r, jobId, null);
    // After the toast has had its moment: a question about the price list.
    if (done) setTimeout(() => offerPrices(r, done), 400);
  };

  // The lines (the ticked ones, else all that are left) and their tax onto
  // a job's materials. The button above and a photo sent in for the job
  // (autoSort, `auto` = what to note on the receipt) both come here, so a
  // line added by itself is exactly the line the button would have added.
  // Returns the lines' indexes, or null when nothing was added.
  function addToJob(rid, r, jobId, auto) {
    const p = portion(rid, r);
    if (!p) return null;
    const { idxs, lines, part, tax, last } = p;

    const sid = 'sp' + Date.now().toString(36) + uid();
    const from = (r.vendor || 'Receipt') + (r.orderNo ? ' #' + r.orderNo : '');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : localYMD();
    // Every detail the receipt has goes with the line: the order, the
    // supplier's item number, the unit price, and the email it came from.
    const more = { vendor: r.vendor || '', orderNo: r.orderNo || '', link: r.link || '',
      receiptId: rid, splitId: sid };
    const add = idxs.map(i => {
      const l = lines[i];
      return Object.assign({ id: uid(), item: l.name || 'Item', date, location: from,
        price: ((l.cents || 0) / 100).toFixed(2), qty: l.qty ? String(l.qty) : '', unit: l.unit || '',
        itemNo: l.itemNo || '', unitPrice: l.unitCents ? (l.unitCents / 100).toFixed(2) : '' }, more);
    });
    if (!idxs.length && part) add.push(Object.assign({ id: uid(), item: r.summary || r.vendor || 'Purchase', date,
      location: from, price: (part / 100).toFixed(2), qty: '', unit: '', itemNo: '', unitPrice: '' }, more));
    if (tax) add.push(Object.assign({ id: uid(), item: 'Sales tax', date, location: from,
      price: (tax / 100).toFixed(2), qty: '', unit: '', itemNo: '', unitPrice: '' }, more));

    let ticks = 0;
    const job = changeJob(jobId, list => list.concat(add), list => {
      const out = tickOrdered(list, idxs.map(i => lines[i].name), { orderNo: r.orderNo || '', vendor: r.vendor || '', rid, sid });
      ticks = out.filter((it, i) => it !== list[i]).length;
      return out;
    });
    if (!job) return null;
    const splits = (r.splits || []).concat([Object.assign({
      id: sid, to: 'job', jobId, jobName: (job.customerName || '').trim() || 'Untitled job',
      est: String(job.estimateNumber || '').trim(), lines: idxs, cents: part, taxCents: tax,
      at: new Date().toISOString(), by: (me() || {}).uid || '',
    }, auto ? { auto: true } : {})]);
    const status = last ? 'done' : (r.status === 'skipped' ? 'skipped' : 'new');
    // Shown at once rather than when the server echoes it back.
    receipts[rid] = Object.assign({}, r, { splits, status }, auto ? { auto } : {});
    delete ticked[rid]; delete chosen[rid];
    write(rid, Object.assign({ splits, status }, auto ? { auto } : {}));
    showToast((auto ? '🧾 ' + (r.vendor || 'Receipt') + ': ' : '') +
      add.length + ' line' + (add.length === 1 ? '' : 's') + ' (' + money(part + tax) + ') added to ' +
      splits[splits.length - 1].jobName + (auto ? ' — sent in for it' : '') +
      (ticks ? ' · ' + ticks + ' ticked on Materials to Order' : ''), auto ? 5000 : undefined);
    redraw(true);
    return idxs;
  }

  // ------------------------------------------- a photo sent in for a job
  //
  // A receipt photo sent from a job (or by someone clocked into one) whose
  // read the server found clean -- every line with a quantity and a price,
  // the lines and tax making the total, nothing like it already in -- comes
  // with auto.state 'ready' (functions/receipts.py). The first device that
  // sorts receipts and sees it puts it on the job through addToJob above,
  // the same as pressing Add to job: Tracking gets every line and the tax,
  // and ⋯ → Undo takes it back off. Anything the server was unsure of is
  // 'needs', with why, and waits in To sort for a person.
  //
  // Two of Jonah's devices may see it at once: it is claimed first, in one
  // step on the server (YDDb.transact), so only one of them adds it. A
  // transaction needs signal; with none, it waits for the next look.
  const autoBusy = {};         // receipt id -> true while this device is on it (or has done it)
  const autoReady = r => !!(r && r.status === 'new' && !(r.splits || []).length && r.auto && r.auto.state === 'ready');
  function autoSoon() {
    if (!sorts() || !loaded || !window.YDDb || !window.YDDb.transact) return;
    Object.keys(receipts).forEach(id => { if (autoReady(receipts[id]) && !autoBusy[id]) autoSort(id); });
  }
  async function autoSort(rid) {
    const r = receipts[rid];
    const f = (r && r.sentFor) || {};
    // The job reaches this device on its own; until then, the next look.
    if (f.to === 'job' && !readJobBlob(f.jobId)) return;
    if (navigator.onLine === false) return;
    autoBusy[rid] = true;
    const uidNow = (me() || {}).uid || '', at = new Date().toISOString();
    let claimed = false;
    try {
      await window.YDDb.transact([['receipts', rid]], ([d]) => {
        claimed = autoReady(d);
        return [claimed ? { auto: Object.assign({}, d.auto, { state: 'adding', by: uidNow, at }) } : null];
      });
    } catch (e) {
      // No signal after all: looked at again later. Refused outright: not
      // asked again and again this visit -- a person sorts it.
      if (!(e && e.code === 'permission-denied')) delete autoBusy[rid];
      return;
    }
    if (!claimed) return;
    const fresh = Object.assign({}, receipts[rid] || r, { splits: [], status: 'new' });
    // Every line, whatever was ticked on this screen meanwhile.
    delete ticked[rid]; delete splitting[rid];
    const done = { state: 'done', why: '', by: uidNow, at: new Date().toISOString() };
    let ok;
    if (f.to === 'job') ok = !!addToJob(rid, fresh, f.jobId, done);
    else if (f.to === 'vehicle' || f.to === 'shop' || f.to === 'office') {
      ok = assignElsewhere(rid, fresh, f.to, f.to === 'vehicle'
        ? { equipmentId: f.equipmentId || '', name: f.name || 'Vehicle' } : { name: f.name || DEST_NAME[f.to] }, done);
    }
    if (!ok) {
      const auto = { state: 'needs', why: 'it could not be put on ' + (f.jobName || f.name || 'it') + ' by itself', by: uidNow, at };
      receipts[rid] = Object.assign({}, receipts[rid] || r, { auto });
      write(rid, { auto });
      redraw(true);
    }
  }
  // What the card says about a photo sent in for somewhere: where, by whom,
  // and -- when it is waiting for a person -- why.
  const STUCK_MS = 10 * 60 * 1000;
  function sentForHtml(r) {
    const f = r.sentFor, a = r.auto || {};
    if (!f || r.status !== 'new') return '';
    const where = f.to === 'job' ? (f.jobName ? '<b>' + esc(f.jobName) + '</b>' : 'a job')
      : '<b>' + esc(f.name || DEST_NAME[f.to] || '') + '</b>';
    const who = f.byName ? esc(f.byName) + ' sent it in for ' : 'Sent in for ';
    // Claimed by a device that then went quiet (closed mid-way): a person's.
    const stuck = a.state === 'adding' && Date.now() - new Date(a.at || 0).getTime() > STUCK_MS;
    if (a.state === 'ready' || (a.state === 'adding' && !stuck)) {
      return '<div class="rc-suggest">' + who + where + ' — adding it by itself…</div>';
    }
    if (a.state === 'needs' || stuck || (f.to && !a.state)) {
      return '<div class="rc-needs"><b>Needs you:</b> ' + esc(stuck ? 'it was being added on another device that stopped — check it' : (a.why || 'check it')) +
        '<div class="rc-needs-for">' + who + where + '</div></div>';
    }
    return '';
  }
  const needsYou = r => !!(r && r.status === 'new' && r.auto && (r.auto.state === 'needs' ||
    (r.auto.state === 'adding' && Date.now() - new Date(r.auto.at || 0).getTime() > STUCK_MS)));

  // ------------------------------------------------- the price list follows
  //
  // A line on a receipt that is one of our supplies (its supplier's item
  // number, or its name) and cost something different from the price list
  // offers to update the list -- Jonah (6 Oct 2026): ask each time. What the
  // estimates are priced from then stays what he actually pays.
  const wordsOf = s => ' ' + String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ')
    .map(w => /(x|ch|sh|ss)es$/.test(w) ? w.slice(0, -2) : /[^s]s$/.test(w) ? w.slice(0, -1) : w).join(' ') + ' ';
  const EACH = [' ', ' each ', ' ea ', ' unit ', ' piece ', ' pc '];
  function priceChanges(r, idxs) {
    const S = window.YDSupplies;
    if (!S || !S.findSupply || !ydCan('supplies', 'change')) return [];
    const cat = S.catalog();
    const year = /^\d{4}/.test(r.date || '') ? parseInt(r.date, 10) : new Date().getFullYear();
    const out = [], seen = {};
    idxs.forEach(i => {
      const l = (r.lines || [])[i] || {};
      const it = S.findSupply(r.vendor, l.itemNo, l.name);
      if (!it || seen[it.id]) return;
      const pr = cat.prices[it.id] || {};
      const qty = parseFloat(l.qty);
      const each = l.unitCents > 0 ? l.unitCents : (qty > 0 && l.cents > 0 ? Math.round(l.cents / qty) : null);
      if (!(each > 0) || each === pr.cents) return;
      // A unit on the receipt that isn't what the price is per (a pallet of
      // something priced by the sq ft) would put a nonsense price in.
      const per = String(pr.per || it.unit || '');
      const got = wordsOf(l.unit), want = wordsOf(per);
      const same = got === want || (EACH.indexOf(got) !== -1 && EACH.indexOf(want) !== -1);
      if (l.unit && !same) return;
      seen[it.id] = true;
      out.push({ id: it.id, name: it.name, from: typeof pr.cents === 'number' ? pr.cents : null, to: each,
                 per: per, year: year, unsure: !l.unit && EACH.indexOf(want) === -1 });
    });
    return out;
  }
  async function offerPrices(r, idxs) {
    const ch = priceChanges(r, idxs);
    if (!ch.length) return;
    const lines = ch.map(c => '• ' + c.name + ': ' + (c.from === null ? 'no price' : money(c.from)) + ' → ' + money(c.to) +
      (c.per ? ' a ' + c.per : '') + (c.unsure ? ' (the receipt doesn’t say per what — check)' : ''));
    if (!(await ydConfirm(lines.join('\n') + '\n\nEstimates are priced from these.',
        { title: 'Update the price list from this ' + (r.vendor || '') + ' receipt?', ok: 'Update the prices', cancel: 'Leave them' }))) return;
    let failed = 0;
    ch.forEach(c => window.YDSupplies.setPrice(c.id, c.to, c.year, 'Receipt').catch(e => {
      if (!failed++) showToast(e && e.code === 'permission-denied' ? 'Price list not changed — not allowed' : 'Price list change not on the server yet');
    }));
    showToast(ch.length + ' price' + (ch.length === 1 ? '' : 's') + ' updated');
  }

  window.rcUndo = async function (rid, sid) {
    if (!sorts()) { showToast('You can look at jobs but not change them'); return; }
    let r = receipts[rid];
    let s = r && (r.splits || []).find(x => x.id === sid);
    if (!s) return;
    const onJob = destOf(s) === 'job';
    if (!(await ydConfirm('', { title: 'Take these lines back off ' + (onJob ? s.jobName : s.name || DEST_NAME[destOf(s)]) + '?', ok: 'Take them off' }))) return;
    // The receipt as it is now -- it may have changed while the question was open.
    r = receipts[rid];
    s = r && (r.splits || []).find(x => x.id === sid);
    if (!s) return;
    // A job deleted since has nothing left to take back; nothing else was
    // ever written anywhere but the receipt.
    if (onJob && readJobBlob(s.jobId)) {
      if (!changeJob(s.jobId, list => list.filter(m => !(m.receiptId === rid && m.splitId === sid)),
        list => untickOrdered(list, sid))) return;
    }
    const splits = (r.splits || []).filter(x => x.id !== sid);
    const status = r.status === 'skipped' ? 'skipped' : 'new';
    receipts[rid] = Object.assign({}, r, { splits, status });
    write(rid, { splits, status });
    redraw(true);
  };

  // Deleting a receipt only removes it from the hub: the email stays in Gmail,
  // and the server remembers it has read that email, so it never comes back.
  // Lines already put on a job stay on the job. The owner's alone (rules).
  const owner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  function drop(ids) {
    ids.forEach(id => {
      delete receipts[id]; delete toSort[id]; delete recent[id]; delete older[id];
      delete ticked[id]; delete chosen[id]; delete splitting[id];
    });
    Promise.resolve(window.YDDb.removeMany(ids.map(id => ['receipts', id])))
      .catch(e => console.warn('[receipts] not deleted:', (e && e.code) || e));
    redraw(true);
  }
  // What went to a vehicle, the shop, the office or a subcontractor is kept
  // on the receipt and nowhere else (a vehicle's page, Subcontractors and the
  // month totals read it from here); so is a receipt set aside as overhead,
  // or as a subcontractor's bill, before those places existed.
  const BOOKS = ['vehicle', 'shop', 'office', 'sub'];
  const legacyPlace = r => (r.status === 'skipped' && LEGACY_PLACE[r.skipWhy]) || '';
  function heldNames(r) {
    const legacy = legacyPlace(r);
    return (r.splits || []).filter(s => BOOKS.indexOf(destOf(s)) !== -1)
      .map(s => s.name || DEST_NAME[destOf(s)])
      .concat(legacy === 'shop' ? ['shop overhead'] : legacy === 'sub' ? ['a subcontractor'] : [])
      .filter((n, i, a) => a.indexOf(n) === i);
  }
  const heldHere = r => heldNames(r).length > 0;
  // Set aside: skipped, and not one of the old reasons that were really a
  // place. It counts nowhere.
  const isAside = r => r.status === 'skipped' && !legacyPlace(r);
  // What "Delete all set aside" may take: set aside, and holding nothing the
  // books need (a subcontractor's bill is never set aside now; an old one is
  // a place, above).
  const deletableAside = r => isAside(r) && !heldHere(r);
  window.rcDelete = async function (rid) {
    const r = receipts[rid];
    if (!r || !owner()) return;
    const books = heldHere(r)
      ? '\n\nIt holds what went to ' + heldNames(r).join(', ') +
        ' — that is kept nowhere else, so it comes out of those totals.'
      : '';
    if (!(await ydConfirm('The email stays in Gmail.' +
      ((r.splits || []).some(s => destOf(s) === 'job') ? ' Lines already added to jobs stay on the jobs.' : '') + books,
      { title: 'Delete this ' + (r.vendor || '') + ' receipt from the hub?', ok: 'Delete', danger: true }))) return;
    if (!receipts[rid]) return;
    drop([rid]);
    showToast('Deleted');
  };
  window.rcDeleteAside = async function () {
    const ids = Object.keys(receipts).filter(id => deletableAside(receipts[id]));
    if (!ids.length || !owner()) return;
    if (!(await ydConfirm('Their emails stay in Gmail.', { title: 'Delete all ' + ids.length + ' set-aside receipts from the hub?', ok: 'Delete them', danger: true }))) return;
    drop(ids);
    showToast(ids.length + ' deleted');
  };

  window.rcSkip = async function (rid, why) {
    if (!why || !receipts[rid]) return;
    if (!sorts()) { showToast('You can look at jobs but not change them'); redraw(true); return; }
    // Personal purchases have no business in the hub at all (Jonah, 5 Oct).
    // Part of a receipt already sorted elsewhere keeps the receipt, though --
    // a vehicle's or the shop's share lives nowhere else -- so the rest is
    // noted as personal and the receipt is done. So does a receipt split up
    // with only some of its lines ticked: those lines are personal, and the
    // rest still waits to be sorted (it used to delete the whole receipt).
    if (why === 'personal') {
      const r = receipts[rid];
      if (partlyPersonal(rid, r)) {
        const p = portion(rid, r);
        if (!p) return;
        const splits = (r.splits || []).concat([{ id: 'sp' + Date.now().toString(36) + uid(), to: 'personal', name: 'Personal',
          lines: p.idxs, cents: p.part, taxCents: p.tax, at: new Date().toISOString(), by: (me() || {}).uid || '' }]);
        const status = p.last ? 'done' : r.status;
        receipts[rid] = Object.assign({}, r, { splits, status });
        delete ticked[rid];
        write(rid, { splits, status });
        showToast('Marked personal');
        redraw(true);
        return;
      }
      if (owner()) {
        if (!(await ydConfirm('Personal purchases are not kept in the hub.', { title: 'Delete this ' + (r.vendor || '') + ' receipt?', ok: 'Delete', danger: true }))) return;
        drop([rid]); showToast('Personal — deleted from the hub'); return;
      }
    }
    receipts[rid] = Object.assign({}, receipts[rid], { status: 'skipped', skipWhy: why });
    write(rid, { status: 'skipped', skipWhy: why, skippedBy: (me() || {}).uid || '' });
    showToast('Set aside — All receipts → Set aside has it if that was wrong');
    redraw(true);
  };

  // The note, as typed: never one of the old reasons' own words, which are
  // read back as places ("overhead" would count as the shop).
  function cleanWhy(text) {
    let why = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 300);
    if (WHY[why]) why = why.charAt(0).toUpperCase() + why.slice(1);
    return why;
  }
  // "Set aside" picked on a receipt: the whole of what is left of it, with
  // the note for why. Asked for, not required.
  async function setAside(rid, r) {
    const box = el('rcWhy_' + rid);
    const why = cleanWhy(asideWhy[rid] != null ? asideWhy[rid] : (box ? box.value : ''));
    if (!why && !(await ydConfirm('A few words now save wondering later.', { title: 'Set it aside without a note for why?', ok: 'Set it aside', cancel: 'Add a note' }))) {
      const b = el('rcWhy_' + rid); if (b) b.focus(); return;
    }
    if (!receipts[rid]) return;
    r = receipts[rid];
    receipts[rid] = Object.assign({}, r, { status: 'skipped', skipWhy: why });
    delete asideWhy[rid]; delete dest[rid]; delete ticked[rid]; delete splitting[rid];
    write(rid, { status: 'skipped', skipWhy: why, skippedBy: (me() || {}).uid || '' });
    showToast('Set aside — All receipts → Set aside has it');
    redraw(true);
  }
  // Changing the note on one already set aside.
  window.rcAsideWhy = async function (rid) {
    let r = receipts[rid];
    if (!r || !isAside(r)) return;
    if (!sorts()) { showToast('You can look at jobs but not change them'); return; }
    const was = r.skippedBy === 'claude' ? '' : (WHY[r.skipWhy] || r.skipWhy || '');
    const got = await ydPrompt('', was, { title: 'Why is it set aside?', ok: 'Save' });
    if (got === null) return;
    r = receipts[rid];
    if (!r) return;
    const why = cleanWhy(got);
    // One Claude set aside as personal says so instead of a note; once a
    // person writes why, the note is what shows.
    const patch = r.skippedBy === 'claude' ? { skipWhy: why, skippedBy: (me() || {}).uid || '' } : { skipWhy: why };
    receipts[rid] = Object.assign({}, r, patch);
    write(rid, patch);
    renderHistory();
  };

  window.rcPutBack = function (rid) {
    const r = receipts[rid];
    if (!r) return;
    if (!sorts()) { showToast('You can look at jobs but not change them'); return; }
    const status = freeLines(r).length ? 'new' : 'done';
    receipts[rid] = Object.assign({}, r, { status, skipWhy: '' });
    write(rid, { status, skipWhy: '', skippedBy: '' });
    redraw(true);
  };

  async function ask(path) {
    const user = me();
    if (!user) throw new Error('Not signed in');
    if (!endpoint()) throw new Error('The server address is not configured');
    const token = await user.getIdToken();
    const res = await fetch(endpoint() + path, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('failed (' + res.status + ')'));
    return data;
  }

  window.rcCheckNow = async function () {
    if (checking) return;
    if (!sorts()) { showToast('You can look at jobs but not change them'); return; }
    checking = true; redraw(true);
    try {
      const rep = (await ask('/receipts/now')).report || {};
      if (rep.busy) showToast('Already checking — new receipts will appear here');
      else if (rep.needsPermission) showToast('Reading email is not switched on yet');
      else {
        const found = (rep.new || 0) + (rep.added || 0);
        showToast((found ? found + ' receipt' + (found === 1 ? '' : 's') + ' found'
          + (rep.waiting ? ' — ' + rep.waiting + ' more on the next check' : '')
          : 'No new receipts' + (rep.waiting ? ' yet — ' + rep.waiting + ' waiting for the next check' : ''))
          + (rep.byCode ? ' · ' + rep.byCode + ' sorted by the app, no Claude' : ''));
      }
    } catch (e) {
      showToast('Could not check email: ' + e.message);
    }
    checking = false;
    await loadState();
    redraw(true);
  };

  // ------------------------------------------------------------ drawing

  function lineHtml(rid, r, i, at, isTicked, split) {
    const l = r.lines[i];
    const s = at[i];
    const qty = l.qty ? ' <span class="muted">' + esc(String(l.qty)) + (l.unit ? ' ' + esc(l.unit) : '') + '</span>' : '';
    if (!split) {
      return '<div class="rc-line rc-plain"><span class="rc-lname">' + esc(l.name) + qty + '</span>' +
        '<span class="rc-lamt">' + money(l.cents) + '</span></div>';
    }
    return '<label class="rc-line' + (s ? ' rc-on-job' : '') + '">' +
      '<input type="checkbox"' + (s ? ' checked disabled' : (isTicked ? ' checked' : '')) +
        (s ? '' : ' onchange="rcTick(\'' + rid + '\',' + i + ',this.checked)"') + '>' +
      '<span class="rc-lname">' + esc(l.name) + qty +
        // Where the line went: a job by its name, a vehicle, the shop, the
        // office or personal by theirs (a job's name was shown for every one).
        (s ? ' <span class="rc-ljob">→ ' + (destOf(s) === 'job' ? jobNameHtml(s.jobName, s.est) : splitWhere(s)) + '</span>' : '') + '</span>' +
      '<span class="rc-lamt">' + money(l.cents) + '</span></label>';
  }

  function splitWhere(s) {
    const to = destOf(s);
    if (to === 'job') return 'Added to <b>' + jobNameHtml(s.jobName, s.est) + '</b>';
    return (DEST.find(d => d[0] === to) || ['', ''])[1].split(' ')[0] + ' <b>' + esc(s.name || DEST_NAME[to] || '') + '</b>';
  }
  const splitPlace = s => destOf(s) === 'job' ? (s.jobName || 'the job') : (s.name || DEST_NAME[destOf(s)] || '');

  // ------------------------------------------------- what was done with it
  //
  // Where a receipt went shows as a small chip ("✓ Added to the Smith job");
  // taking it back, and deleting the receipt, sit behind ⋯ -- or a tap on
  // the chip, which opens the same menu. A green bar with its own Undo on
  // every sorted receipt doubled the height of All receipts, and a 🗑 on
  // every row was one slip of the thumb from gone. Undo is there for as long
  // as it ever was; it is only out of the way.
  //
  // `where` tells a card in To sort ('c') from a row in All receipts ('h'):
  // the same receipt can be in both.
  let menuOpen = '';          // the ⋯ menu that is open, kept through a redraw
  function menuItems(rid, r) {
    const items = [];
    if (sorts()) {
      (r.splits || []).forEach(s => items.push('<button type="button" ' +
        'onclick="rcMenuClose(); rcUndo(\'' + rid + '\',\'' + safeId(s.id) + '\')">↩ Undo — take it off ' +
        esc(splitPlace(s)) + '</button>'));
    }
    if (owner()) {
      items.push('<button type="button" class="rc-menu-del" onclick="rcMenuClose(); rcDelete(\'' + rid + '\')">' +
        '🗑 Delete this receipt</button>');
    }
    return items;
  }
  function menuHtml(where, rid, r) {
    const items = menuItems(rid, r);
    if (!items.length) return '';
    const key = where + rid;
    return '<details class="rc-menu" data-menu="' + key + '"' + (menuOpen === key ? ' open' : '') +
        ' ontoggle="rcMenuToggled(this)">' +
      '<summary class="rc-menu-btn" title="More" aria-label="More for this receipt">⋯</summary>' +
      '<div class="rc-menu-list">' + items.join('') + '</div></details>';
  }
  function chipsHtml(where, rid, r) {
    const list = r.splits || [];
    if (!list.length) return '';
    const opens = menuItems(rid, r).length > 0;
    return '<span class="rc-chips">' + list.map(s => {
      const n = (s.lines || []).length, amt = money((s.cents || 0) + (s.taxCents || 0));
      const title = (n ? n + ' line' + (n === 1 ? '' : 's') + (s.taxCents ? ' + tax' : '') + ', ' : '') + amt +
        (opens ? ' — tap for Undo' : '');
      // Put there by itself, from a photo sent in for it (autoSort).
      const inner = '✓ ' + splitWhere(s) + (s.auto ? ' <span class="rc-chip-auto">by itself</span>' : '') + (list.length > 1 ? ' <span class="rc-chip-amt">' + amt + '</span>' : '');
      return opens
        ? '<button type="button" class="rc-chip" title="' + esc(title) + '" onclick="rcMenuOpen(\'' + where + rid + '\')">' + inner + '</button>'
        : '<span class="rc-chip" title="' + esc(title) + '">' + inner + '</span>';
    }).join('') + '</span>';
  }
  // One menu open at a time; remembered so a receipt arriving (a redraw)
  // does not snap it shut under the finger.
  window.rcMenuToggled = function (box) {
    const key = box.getAttribute('data-menu') || '';
    if (box.open) {
      menuOpen = key;
      document.querySelectorAll('details.rc-menu[open]').forEach(d => { if (d !== box) d.open = false; });
    } else if (menuOpen === key) menuOpen = '';
  };
  window.rcMenuOpen = function (key) {
    const box = document.querySelector('details.rc-menu[data-menu="' + safeId(key) + '"]');
    if (box) { box.open = true; const first = box.querySelector('.rc-menu-list button'); if (first) first.focus(); }
  };
  window.rcMenuClose = function () {
    menuOpen = '';
    document.querySelectorAll('details.rc-menu[open]').forEach(d => { d.open = false; });
  };
  // A tap anywhere else, or Escape, closes it -- the way any menu does.
  document.addEventListener('click', e => {
    if (!menuOpen) return;
    const t = e.target;
    if (t && t.closest && (t.closest('details.rc-menu') || t.closest('.rc-chip'))) return;
    window.rcMenuClose();
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !menuOpen) return;
    const box = document.querySelector('details.rc-menu[open]');
    window.rcMenuClose();
    // Back on the ⋯ it was opened from, for a keyboard.
    const btn = box && box.querySelector('summary');
    if (btn) btn.focus();
  });

  function cardHtml(r, jobs) {
    const rid = safeId(r.id);
    const at = splitOf(r);
    const free = freeLines(r);
    const tickedSet = new Set(tickedLines(rid, r));
    const pick = chosen[rid] != null ? chosen[rid] : ((r.suggest && r.suggest.jobId) || '');
    const sug = r.suggest && jobs.find(j => j.id === r.suggest.jobId);
    const owed = r.paid === false && r.docType === 'invoice';
    const split = isSplit(rid, r);
    const to = dest[rid] || defaultDest(r);
    // Lines still to place -- or a receipt with no lines at all, which goes whole.
    const sortable = free.length > 0 || (!(r.lines || []).length && !(r.splits || []).length);
    // An email with no itemised lines gets its one line named after the
    // summary (functions/receipts.py lines_from), so the summary above it
    // said the same sentence twice: shown once, as the line.
    const plain = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
    const lines = r.lines || [];
    const summary = r.summary && !(lines.length === 1 && plain(lines[0].name) === plain(r.summary)) ? esc(r.summary) + ' ' : '';
    // "the order names <the customer>" beside the customer's own name read
    // the name twice over.
    const why = /^the order names /i.test(String((r.suggest || {}).why || '')) ? 'named on the order' : String((r.suggest || {}).why || '');
    return '<div class="rc-card" id="rc_' + rid + '">' +
      '<div class="rc-top">' +
        '<span class="rc-vendor">' + esc(r.vendor || 'Receipt') + '</span>' +
        (r.orderNo ? '<span class="rc-tag">#' + esc(r.orderNo) + '</span>' : '') +
        '<span class="rc-tag">' + fmtDateMD(r.date) + '</span>' +
        (owed ? '<span class="rc-tag rc-owed">Owed</span>' : '') +
        '<span class="rc-total">' + money(r.totalCents) + '</span>' +
      '</div>' +
      '<div class="rc-sum">' + summary +
        '<span class="muted">' + (summary ? '· ' : '') + esc(KIND[r.kind] || 'Other') + '</span></div>' +
      sentForHtml(r) +
      (r.whose === 'unsure' && !r.sentFor ? '<div class="rc-note">Claude was not sure this one is for the business.</div>' : '') +
      (sug && free.length && to === 'job' && !r.sentFor ? '<div class="rc-suggest">Looks like <b>' + jobNameHtml(sug.name, sug.est) + '</b>' +
        (why ? ' — ' + esc(why) : '') + '</div>' : '') +
      (split && free.length ? '<div class="rc-hint">Tick the lines for one place, add them, then do the rest.' +
        ((r.splits || []).length ? '' : ' <button class="rc-link" onclick="rcSplit(\'' + rid + '\', false)">All one place after all</button>') +
        '</div>' : '') +
      '<div class="rc-lines">' +
        (r.lines || []).map((_, i) => lineHtml(rid, r, i, at, tickedSet.has(i), split)).join('') +
        (r.taxCents ? '<div class="rc-line rc-taxrow' + (split ? '' : ' rc-plain') + '">' + (split ? '<span></span>' : '') +
          '<span class="rc-lname">Sales tax' +
          (split && free.length ? ' <span class="muted">(shared by value)</span>' : '') +
          '</span><span class="rc-lamt">' + money(r.taxCents) + '</span></div>' : '') +
      '</div>' +
      (!split && free.length > 1 && sorts() ?
        '<button class="rc-link" onclick="rcSplit(\'' + rid + '\', true)">Split it up (some lines one place, some another)</button>' : '') +
      ((r.splits || []).length ? '<div class="rc-chipline">' + chipsHtml('c', rid, r) + '</div>' : '') +
      (sortable && sorts() ? destHtml(rid, r, to) + assignHtml(rid, r, to, jobs, pick, tickedSet, free) : '') +
      '<div class="rc-foot">' +
        (r.link ? '<a class="btn btn-sm" href="' + esc(r.link) + '" target="_blank" rel="noopener">Open the email</a>' : '') +
        menuHtml('c', rid, r) +
      '</div>' +
      qbHtml(r, rid) +
    '</div>';
  }

  // Where it is going: one chip each, the first already picked from what
  // Claude said the purchase was.
  function destHtml(rid, r, to) {
    return '<div class="rc-dest">' + DEST.map(([k, label]) =>
      '<button class="rc-dest-chip' + (k === to ? ' on' : '') + '" onclick="rcDest(\'' + rid + '\', \'' + k + '\')">' +
      label + '</button>').join('') + '</div>';
  }
  // And what goes with that choice: the job, the vehicle, or just the button.
  function assignHtml(rid, r, to, jobs, pick, tickedSet, free) {
    const n = tickedSet.size === free.length ? '' : tickedSet.size + ' ';
    const btn = words => '<button class="btn btn-sm btn-filled" onclick="rcAssign(\'' + rid + '\')">' + words + '</button>';
    if (to === 'job') {
      return '<div class="rc-assign">' +
        '<select class="searchable" id="rcJob_' + rid + '" onchange="rcPickJob(\'' + rid + '\', this.value)">' +
          '<option value="">Which job?</option>' +
          jobs.map(j => '<option value="' + safeId(j.id) + '"' + (j.id === pick ? ' selected' : '') + '>' +
            esc(jobLabel(j)) + '</option>').join('') +
        '</select>' + btn('Add ' + n + 'to job') + '</div>';
    }
    if (to === 'vehicle') {
      const gear = gearList();
      if (!gear.length) return '<div class="rc-note">No vehicles on the Equipment tab yet' +
        (ydCan('equipment', 'see') ? ' — add them there first.' : ' that you can see.') + '</div>';
      const cur = chosenGear[rid] || '';
      return '<div class="rc-assign">' +
        '<select onchange="rcPickGear(\'' + rid + '\', this.value)">' +
          '<option value="">Which vehicle or machine?</option>' +
          gear.map(g => '<option value="' + safeId(g.id) + '"' + (g.id === cur ? ' selected' : '') + '>' +
            esc(g.name || 'Machine') + '</option>').join('') +
        '</select>' + btn('Add ' + n + 'to vehicle') + '</div>';
    }
    if (to === 'personal') {
      return '<div class="rc-assign">' + btn(partlyPersonal(rid, r) ? 'Mark ' + (n || 'the rest ') + 'personal'
        : (owner() ? 'Personal — delete it' : 'Personal — set it aside')) + '</div>';
    }
    if (to === 'sub') {
      // The owner picks which of his subcontractors (the one whose name the
      // store has, to start with); anyone else files it by the store's name.
      const subs = subsKnown();
      const cur = chosenSub[rid] != null ? chosenSub[rid] : ((subMatch(r) || {}).id || '');
      return '<div class="rc-assign">' +
        (subs.length ? '<select class="rc-sub-pick" onchange="rcPickSub(\'' + rid + '\', this.value)">' +
          subs.map(s => '<option value="' + safeId(s.id) + '"' + (s.id === cur ? ' selected' : '') + '>' +
            esc(s.name || 'Subcontractor') + '</option>').join('') +
          '<option value=""' + (cur ? '' : ' selected') + '>' + esc((r.vendor || '').trim() || 'This store') +
            ' (not set up under Subcontractors)</option>' +
        '</select>' : '') +
        btn('Add ' + n + 'to subcontractor') + '</div>';
    }
    if (to === 'aside') {
      // The whole of what is left: being set aside is the receipt's, not a line's.
      const rest = (r.splits || []).length || (isSplit(rid, r) && tickedSet.size < free.length);
      return '<div class="rc-assign rc-aside">' +
        '<input class="rc-why" id="rcWhy_' + rid + '" list="rcWhyIdeas" maxlength="300" autocomplete="off"' +
          ' placeholder="Why is it set aside?" value="' + esc(asideWhy[rid] || '') + '"' +
          ' oninput="rcWhyTyped(\'' + rid + '\', this.value)"' +
          ' onkeydown="if(event.key===\'Enter\'){event.preventDefault();rcAssign(\'' + rid + '\')}">' +
        btn(rest ? 'Set the rest aside' : 'Set it aside') + '</div>' +
        '<div class="rc-hint">Set aside counts nowhere. All receipts → Set aside keeps it, with this note.</div>';
    }
    return '<div class="rc-assign">' + btn('Add ' + n + 'to ' + DEST_NAME[to].toLowerCase()) + '</div>';
  }
  // A set-aside receipt's note, as it reads.
  const asideText = r => r.skippedBy === 'claude' ? 'Personal (Claude)' : (WHY[r.skipWhy] || r.skipWhy || '');

  // One line in All receipts: what it was, when, what it came to, and where
  // it went -- the jobs it was put on, or why it was set aside.
  // A receipt photo goes on to QuickBooks by itself (functions/receipts.py
  // forward_to_qb; Jonah, 15 Oct 2026): said here, with the photo, and Send
  // to QuickBooks when it did not go. compact: the one-line row.
  // A receipt from email says so only once it has been sent, or tried
  // (settings/receipts.forwardEmails; receipts.py forward_email).
  function qbHtml(r, rid, compact) {
    const f = r.qbForward || null;
    if (!r.photoPath && r.source !== 'photo') return f && f.via === 'email' ? qbEmailHtml(r, rid, f, compact) : '';
    if (compact) return f && f.ok ? '<span class="rc-tag rc-qb-ok" title="Sent to QuickBooks">📤 QB</span>' : '';
    return '<div class="rc-qb">' +
      (r.photoPath ? '<button class="btn btn-sm" onclick="rcViewPhoto(\'' + rid + '\')">🖼 Photo</button>' : '') +
      (f && f.ok ? '<span class="rc-tag rc-qb-ok">📤 Sent to QuickBooks ' + fmtDateMD(String(f.at || '').slice(0, 10)) + '</span>'
        : '<span class="rc-tag rc-owed">Not in QuickBooks yet' + (f && f.error ? ' — ' + esc(f.error) : '') + '</span>' +
          (sorts() && r.photoPath ? '<button class="btn btn-sm" onclick="rcToQb(\'' + rid + '\')">📤 Send to QuickBooks</button>' : '')) +
    '</div>';
  }
  function qbEmailHtml(r, rid, f, compact) {
    if (compact) return f.ok ? '<span class="rc-tag rc-qb-ok" title="Its email was sent to QuickBooks">📤 QB</span>' : '';
    return '<div class="rc-qb">' +
      (f.ok ? '<span class="rc-tag rc-qb-ok">📤 Email sent to QuickBooks ' + fmtDateMD(String(f.at || '').slice(0, 10)) + '</span>'
        : '<span class="rc-tag rc-owed">Not in QuickBooks yet' + (f.error ? ' — ' + esc(f.error) : '') + '</span>' +
          (sorts() ? '<button class="btn btn-sm" onclick="rcToQb(\'' + rid + '\')">📤 Send to QuickBooks</button>' : '')) +
    '</div>';
  }
  // (Was rcPhoto, which the camera button below also defined -- the later
  // one won, and 🖼 Photo opened the camera instead of the picture.)
  window.rcViewPhoto = async function (rid) {
    const r = receipts[rid];
    if (!r || !r.photoPath || !window.YDStore) return;
    try { window.open(await window.YDStore.url(r.photoPath), '_blank', 'noopener'); }
    catch (e) { showToast('The photo could not be opened — try again with signal'); }
  };
  window.rcToQb = async function (rid) {
    if (!sorts() || !window.YDClaude) return;
    showToast('Sending it to QuickBooks…');
    try {
      await window.YDClaude.post('/receipts/qb-send', { id: rid });
      showToast('📤 Sent to QuickBooks');
    } catch (e) {
      showToast('Not sent: ' + String((e && e.message) || e).slice(0, 120), 6000);
    }
  };
  // Where the photos go: QuickBooks' receipt address (Settings → receipts in
  // QuickBooks, or the Intuit Assist "+expenses" address). Owner only.
  function qbAddressHtml() {
    if (!(window.YDAuth && window.YDAuth.isOwner)) return '';
    const to = state && state.qbForwardTo;
    const fwdOn = !!(state && state.forwardEmails === true);
    const waiting = to ? emailsToSend().length : 0;
    return '<div class="rc-qbaddr">📤 Receipt photos go to QuickBooks' +
      (to ? ' at <b>' + esc(to) + '</b>' : ' — <b>no address set</b>, so they stay here') +
      ' <button class="link-btn" onclick="rcQbAddress()">' + (to ? 'Change' : 'Set it') + '</button></div>' +
      (to ? '<div class="rc-qbaddr"><label><input type="checkbox"' + (fwdOn ? ' checked' : '') +
        ' onchange="rcFwdEmails(this.checked)"> Forward email receipts to QuickBooks</label> ' +
        '<span class="muted">' + (fwdOn ? '— each business receipt goes once, at the weekly read' : '— off: you forward them yourself') +
        '</span>' + (waiting ? ' · ' + waiting + ' from the last ' + FWD_DAYS + ' days not sent yet ' +
          '<button class="btn btn-sm" onclick="rcFwdRecent()"' + (fwdBusy ? ' disabled' : '') + '>' +
          (fwdBusy ? 'Sending…' : '📤 Send the ones from the last ' + FWD_DAYS + ' days now') + '</button>' : '') +
        '</div>' : '') +
      (state && state.labelsNeedPermission ? '<div class="rc-note">🏷 Gmail labels ("receipts", "Rebate Receipts MNRDS") ' +
        'need one permission: Admin console → Security → API controls → Domain-wide delegation → the Job Hub row → add ' +
        '<b>https://www.googleapis.com/auth/gmail.modify</b>. Receipts are still read meanwhile; the ones already ' +
        'read are labelled once it is added.</div>' : '');
  }
  // Email receipts the server would send with "Send the ones from the last
  // 14 days now" -- the same test as receipts.py forward_emails(days=14):
  // from email (not a photo), not sent yet, not set aside, with an email
  // from after reading started and inside the 14 days.
  const FWD_DAYS = 14;
  let fwdBusy = false;
  function emailsToSend() {
    const start = Date.parse((state && state.since) || '');
    if (isNaN(start)) return [];
    const floor = Math.max(start, Date.now() - FWD_DAYS * 864e5);
    return allReceipts().filter(r => !r.photoPath && r.source !== 'photo' && r.status !== 'skipped' &&
      !(r.qbForward && r.qbForward.ok) && (r.mail || []).some(m => m && m.id && (m.at || 0) >= floor));
  }
  window.rcFwdEmails = function (on) {
    if (!(window.YDAuth && window.YDAuth.isOwner)) return;
    state = Object.assign({}, state || {}, { forwardEmails: !!on });
    Promise.resolve(window.YDDb.put('settings', 'receipts', { forwardEmails: !!on }))
      .catch(e => console.warn('[receipts] switch not yet on the server:', e && (e.code || e.message)));
    showToast(on ? 'Email receipts will go to QuickBooks at the weekly read' : 'Email receipts stay with you — not forwarded');
    redraw(true);
  };
  window.rcFwdRecent = async function () {
    if (!(window.YDAuth && window.YDAuth.isOwner) || fwdBusy || !window.YDClaude) return;
    const n = emailsToSend().length;
    if (!n || !(await ydConfirm('Each goes once.', { title: 'Send ' + n + ' receipt email' + (n === 1 ? '' : 's') + ' to QuickBooks now?', ok: 'Send them' }))) return;
    if (fwdBusy) return;
    fwdBusy = true; redraw(true);
    try {
      const out = await window.YDClaude.post('/receipts/qb-forward-recent', {});
      if (out.busy) showToast('Email is being read right now — try again in a few minutes');
      else if (out.noAddress) showToast('Set the QuickBooks address first');
      else showToast('📤 ' + (out.forwarded || 0) + ' sent to QuickBooks' +
        (out.forwardFailed ? ' · ' + out.forwardFailed + ' could not go (see each receipt)' : '') +
        (out.forwardLeft ? ' · ' + out.forwardLeft + ' more next time' : ''), 6000);
    } catch (e) {
      showToast('Not sent: ' + String((e && e.message) || e).slice(0, 120), 6000);
    }
    fwdBusy = false; redraw(true);
  };
  window.rcQbAddress = async function () {
    if (!(window.YDAuth && window.YDAuth.isOwner)) return;
    const was = (state && state.qbForwardTo) || '';
    const isAddress = v => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v);
    const typed = await ydPrompt('Leave it blank and photo receipts are not sent to QuickBooks.', was, {
      title: 'QuickBooks receipts address', type: 'email', ok: 'Save',
      check: v => !v.trim() || isAddress(v.trim()) ? '' : 'That is not an email address' });
    if (typed === null) return;
    const to = typed.trim();
    if (to && !isAddress(to)) return;
    state = Object.assign({}, state || {}, { qbForwardTo: to || null });
    Promise.resolve(window.YDDb.put('settings', 'receipts', { qbForwardTo: to || null }))
      .catch(e => console.warn('[receipts] address not yet on the server:', e && (e.code || e.message)));
    redraw();
  };

  function rowHtml(r) {
    const rid = safeId(r.id);
    const aside = isAside(r), legacy = legacyPlace(r);
    const legacyName = legacy === 'sub' ? ((subMatch(r) || {}).name || 'Subcontractor') : WHY[r.skipWhy];
    const where = aside ? '<span class="rc-tag rc-aside-tag">Set aside</span>'
      : legacy ? '<span class="rc-tag">' + (DEST.find(d => d[0] === legacy) || ['', ''])[1].split(' ')[0] + ' ' +
          esc(legacyName || DEST_NAME[legacy]) + '</span>'
      : r.status === 'new' ? '<span class="rc-tag rc-owed">To sort</span>' : '';
    const why = aside ? asideText(r) : '';
    // Where it went sits in the row as a chip or two, not a bar under it.
    return '<div class="rc-row"><span class="rc-row-main"><b>' + esc(r.vendor || 'Receipt') + '</b> ' +
        '<span class="muted">' + fmtDateMD(r.date) + (r.orderNo ? ' · #' + esc(r.orderNo) : '') + '</span> ' +
        esc(r.summary || '') + '</span>' + chipsHtml('h', rid, r) + where + qbHtml(r, rid, true) +
        '<span class="rc-row-amt">' + money(r.totalCents) + '</span>' +
        (r.link ? '<a class="btn btn-sm" href="' + esc(r.link) + '" target="_blank" rel="noopener">Email</a>' : '') +
        (aside && sorts() ? '<button class="btn btn-sm" onclick="rcAsideWhy(\'' + rid + '\')" title="Change the note">✎ Why</button>' : '') +
        (r.status === 'skipped' && sorts() ? '<button class="btn btn-sm" onclick="rcPutBack(\'' + rid + '\')">Put back</button>' : '') +
        menuHtml('h', rid, r) +
      '</div>' +
      (aside ? '<div class="rc-aside-why">' + (why ? 'Why: ' + esc(why) : '<span class="muted">No note for why</span>') + '</div>' : '');
  }

  function stateHtml() {
    if (!state) return '';
    if (state.needsPermission) {
      return '<div class="rc-note">Reading email is not switched on yet. In the Google Admin console, the ' +
        'Job Hub service needs <b>gmail.readonly</b> added beside gmail.send and gmail.compose.</div>';
    }
    // Claude reads the receipts once a week (functions/receipts.py
    // READ_EVERY_DAYS; Jonah, 9 Oct 2026); orders ready for pickup are read
    // as they come in.
    const t = new Date(state.lastReadAt || state.lastRunAt || '');
    if (isNaN(t)) return '';
    const fmt = d => d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const every = typeof state.readEveryDays === 'number' ? state.readEveryDays : 7;
    const next = new Date(t.getTime() + every * 864e5);
    return '<span class="muted">' + (state.lastReadAt ? 'Receipts last read ' + esc(fmt(t)) +
      ' · next read about ' + esc(fmt(next)) + ' (pickup notices are read as they come in)'
      : 'Email last checked ' + esc(fmt(t))) + '</span>';
  }

  const byNewest = (a, b) => String(b.date || '').localeCompare(String(a.date || '')) ||
    String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  function allReceipts() {
    return Object.keys(receipts).map(id => Object.assign({ id }, receipts[id]));
  }

  // The count on the tab, and a dot on More for a phone, where Receipts sits
  // behind More.
  function badges(open) {
    const c = el('rcTabCount');
    if (c) c.textContent = open ? String(open) : '';
    const more = el('tabMore');
    if (more) more.toggleAttribute('data-dot', open > 0);
    // What More says under "Receipts" when it is opened.
    if (typeof TAB_HINT === 'object') {
      TAB_HINT.receipts = open ? '🟡 ' + open + ' to sort' : 'Purchases from your email — put each on its job';
    }
  }

  function render() {
    const sec = el('rcSection'), hist = el('rcHistorySection'), tab = el('tabReceipts');
    if (!sec) return;
    const on = !!(window.YDAuth && window.YDAuth.mode === 'cloud' && window.YDAuth.user) && sees();
    sec.hidden = hist.hidden = !on;
    if (tab) tab.hidden = !on;
    if (!on) { badges(0); return; }

    const all = allReceipts();
    // The ones waiting on a person first: a photo that could not go on its
    // job by itself says why at the top of the list.
    const open = all.filter(r => r.status === 'new').sort((a, b) => (needsYou(b) - needsYou(a)) || byNewest(a, b));
    const jobs = jobsList();
    badges(open.length);

    el('rcBadge').textContent = open.length ? open.length + ' to sort' : '';
    el('rcBar').innerHTML =
      (sorts() ? '<button class="btn btn-sm" onclick="rcCheckNow()"' + (checking ? ' disabled' : '') + '>' +
        (checking ? 'Checking email…' : '📧 Check email now') + '</button>' : '') + stateHtml() + qbAddressHtml();
    el('rcList').innerHTML = !loaded ? '<p class="empty-msg">Loading receipts…</p>'
      : open.length ? open.map(r => cardHtml(r, jobs)).join('') +
        '<datalist id="rcWhyIdeas">' + WHY_IDEAS.map(w => '<option value="' + esc(w) + '">').join('') + '</datalist>'
      : '<p class="empty-msg">Nothing to sort. Receipts that arrive by email show up here by themselves.</p>';
    renderHistory();
  }

  // ------------------------------------------------------------ All receipts

  // Set aside is only ever found here, under its own filter (Jonah, 13 Oct
  // 2026: set-aside receipts "shouldnt exist" in the rest of the screen):
  // All leaves out what was set aside and put nowhere.
  const VIEWS = { all: 'All', job: '📋 Jobs', vehicle: '🚚 Vehicles', shop: '🏠 Shop', office: '🗂 Office',
    sub: '🤝 Subcontractors', skipped: '🗄 Set aside' };
  let view = 'all';
  // The places the books count (month totals), and what each is called there.
  const PLACES = ['job', 'vehicle', 'shop', 'office', 'sub'];
  const PLACE_NAME = { job: 'Jobs', vehicle: 'Vehicles', shop: 'Shop', office: 'Office', sub: 'Subcontractors' };
  // What a receipt put to one place, tax share included. A receipt set aside
  // as overhead (before 9 Oct), or as a subcontractor's bill (before 13 Oct),
  // counts its unsorted rest as the shop's or the subcontractor's.
  function amountTo(r, to) {
    const splits = r.splits || [];
    let c = splits.filter(s => destOf(s) === to).reduce((t, s) => t + (s.cents || 0) + (s.taxCents || 0), 0);
    if (legacyPlace(r) === to) {
      c += Math.max(0, (r.totalCents || 0) - splits.reduce((t, s) => t + (s.cents || 0) + (s.taxCents || 0), 0));
    }
    return c;
  }
  const placed = r => PLACES.reduce((t, p) => t + amountTo(r, p), 0);
  const inView = r => view === 'all' ? (!isAside(r) || placed(r) > 0)
    : view === 'skipped' ? isAside(r) : amountTo(r, view) > 0;
  window.rcView = function (v) { if (VIEWS[v]) { view = v; renderHistory(); } };
  // Typing in the search box redraws only the list under it, so the box keeps
  // its focus and what was typed.
  window.rcSearchNow = function () { renderHistory(); };

  function matches(r, words) {
    if (!words.length) return true;
    const hay = [r.vendor, r.orderNo, r.summary, r.date,
      (r.lines || []).map(l => l.name + ' ' + (l.itemNo || '')).join(' '),
      (r.splits || []).map(x => (x.jobName || x.name || '') + ' ' + (x.est || '') + ' ' + DEST_NAME[destOf(x)]).join(' '),
      isAside(r) ? 'set aside ' + asideText(r) : ''].join(' ').toLowerCase();
    return words.every(w => hay.indexOf(w) !== -1);
  }

  function renderHistory() {
    const wrap = el('rcHistory');
    if (!wrap) return;
    const words = String((el('rcSearch') || {}).value || '').toLowerCase().split(/\s+/).filter(Boolean);
    // A search looks through the older ones too -- once; after a failure only
    // "Try again" asks again (or every redraw would ask, for ever).
    if (words.length && olderState === '') loadOlder();
    const label = key => {
      const d = new Date(key + '-01T12:00:00');
      return isNaN(d) ? 'No date' : d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    };
    const before = since ? label(since.slice(0, 7)) : '';
    const olderHtml = !since || olderState === 'done' ? ''
      : '<p class="hint">' + (olderState === 'loading' ? 'Looking for receipts from before ' + esc(before) + '…'
        : (olderState === 'failed' ? 'Receipts from before ' + esc(before) + ' could not be read just now. '
          : 'Receipts from before ' + esc(before) + ' are not loaded. ') +
          '<button class="link-btn" onclick="rcOlder()">' + (olderState === 'failed' ? 'Try again' : 'Show them') + '</button>') + '</p>';
    const every = allReceipts().filter(r => r.status !== 'new');
    const shown = every.filter(r => inView(r) && matches(r, words)).sort(byNewest);
    const aside = every.filter(deletableAside);
    // Counted as sorted: what was put somewhere, not what was set aside.
    const counted = every.filter(r => !isAside(r) || placed(r) > 0).length;
    el('rcHistBadge').textContent = counted ? String(counted) : '';
    el('rcHistBar').innerHTML = Object.keys(VIEWS).map(v =>
      '<button class="btn btn-sm' + (view === v ? ' btn-filled' : '') + '" onclick="rcView(\'' + v + '\')">' +
      VIEWS[v] + '</button>').join('') +
      (view === 'skipped' && aside.length && owner()
        ? '<button class="btn btn-sm rc-del" onclick="rcDeleteAside()">🗑 Delete all ' + aside.length + ' set aside</button>' : '');

    if (!shown.length) {
      wrap.innerHTML = '<p class="empty-msg">' + (words.length ? 'Nothing matches.' : 'Nothing here yet.') + '</p>' + olderHtml;
      return;
    }
    // By month, newest first, each with what it came to -- and, under All,
    // what of it went where (for the books: jobs, vehicles, shop, office,
    // subcontractors). What was set aside counts in none of them, nor in
    // All's month total.
    const months = [];
    shown.slice(0, 300).forEach(r => {
      const key = String(r.date || '').slice(0, 7);
      let m = months[months.length - 1];
      if (!m || m.key !== key) { m = { key, rows: [], cents: 0, by: {} }; months.push(m); }
      m.rows.push(r);
      m.cents += view === 'skipped' ? (r.totalCents || 0)
        : view === 'all' ? (isAside(r) ? placed(r) : (r.totalCents || 0)) : amountTo(r, view);
      PLACES.forEach(p => { m.by[p] = (m.by[p] || 0) + amountTo(r, p); });
    });
    const split = m => view !== 'all' ? '' : PLACES.filter(p => m.by[p]).map(p =>
      PLACE_NAME[p] + ' ' + money(m.by[p])).join(' · ');
    wrap.innerHTML = months.map(m =>
      '<div class="rc-month"><span>' + esc(label(m.key)) + '</span><span>' + m.rows.length + ' · ' +
        money(m.cents) + '</span></div>' +
      (split(m) ? '<div class="rc-month-split">' + esc(split(m)) + '</div>' : '') +
      m.rows.map(rowHtml).join('')).join('') +
      (shown.length > 300 ? '<p class="empty-msg">Showing the newest 300 — search to find older ones.</p>' : '') + olderHtml;
  }

  // A snapshot arriving while a job is being chosen would rebuild the list
  // under the person's finger and lose what they typed into the picker. Hold
  // it until they move on.
  function redraw(force) {
    const p = el('panel-receipts');
    if (!p || !p.classList.contains('active')) {
      // Off screen, only the counts on the tab and on More need to be right.
      deferred = true;
      badges(Object.values(receipts).filter(r => r.status === 'new').length);
      return;
    }
    const sec = el('rcSection');
    if (!force && sec && sec.contains(document.activeElement) && document.activeElement !== document.body) {
      deferred = true;
      return;
    }
    deferred = false;
    render();
  }
  document.addEventListener('focusout', () => {
    if (deferred) setTimeout(() => {
      const sec = el('rcSection');
      if (!sec || !sec.contains(document.activeElement)) redraw();
    }, 0);
  });
  // The job list comes from jobs, which arrive and change on their own.
  document.addEventListener('yd-jobs-changed', () => { redraw(); autoSoon(); });
  window.addEventListener('online', () => autoSoon());

  // ------------------------------------------------------------ data

  async function loadState() {
    // Kept with the owner's settings; an admin simply does not see it.
    try { state = await window.YDDb.get('settings', 'receipts'); } catch (e) { state = null; }
  }

  // One receipt as known from wherever it was heard of, the live lists first.
  function settle(id) {
    const d = recent[id] || toSort[id] || older[id];
    if (d) receipts[id] = d; else delete receipts[id];
  }
  function take(src, changes) {
    changes.forEach(c => {
      if (c.type === 'removed') {
        delete src[c.id];
        // Sorted, and recent: the recent list's own change (no longer 'new')
        // is on its way. Settling now would put back its stale 'new' copy and
        // flash the receipt back into To sort.
        if (src === toSort && recent[c.id] && recent[c.id].status === 'new') return;
        if (src === recent) delete older[c.id];
        // Sorted (or deleted) and dated before `since`: no live list has it
        // any more. Kept as this device last had it -- its own change is
        // already on it -- and read again to be sure.
        if (src === toSort && !recent[c.id]) {
          const mine = receipts[c.id];
          if (mine && mine.status !== 'new') older[c.id] = mine; else delete older[c.id];
          readAgain(c.id);
        }
      } else {
        src[c.id] = c.data;
        if (older[c.id]) older[c.id] = c.data;
      }
      settle(c.id);
    });
  }
  function readAgain(id) {
    const at = since;
    Promise.resolve(window.YDDb.get('receipts', id)).then(d => {
      if (at !== since || toSort[id] || recent[id]) return;
      if (d) older[id] = d; else delete older[id];
      settle(id);
      redraw();
    }).catch(() => {});
  }
  // The receipts dated before `since`, read once (not watched: nothing new
  // arrives that far back).
  function loadOlder() {
    if (!since || olderState === 'loading' || olderState === 'done' || !window.YDDb || !window.YDDb.listWhere) return;
    olderState = 'loading';
    const at = since;
    window.YDDb.listWhere('receipts', 'date', '<', at).then(got => {
      if (at !== since) return;               // signed out (or in again) meanwhile
      Object.keys(got).forEach(id => { older[id] = got[id]; settle(id); });
      olderState = 'done';
      renderHistory();
    }).catch(e => {
      if (at !== since) return;
      olderState = 'failed';
      console.warn('[receipts] older ones not read:', (e && e.code) || e);
      renderHistory();
    });
  }
  window.rcOlder = function () { if (olderState !== 'loading') { olderState = ''; loadOlder(); renderHistory(); } };

  function stop() {
    unsubs.forEach(u => { try { u(); } catch (e) {} });
    unsubs = []; receipts = {}; state = null; loaded = false;
    toSort = {}; recent = {}; older = {}; since = ''; olderState = '';
    toSortHeard = false; recentHeard = false;
  }
  function start() {
    stop();
    since = (new Date().getFullYear() - 1) + '-01-01';
    // Loaded: the to-sort list has answered, and the recent one from the
    // server. (A filtered watch is told nothing when the server only confirms
    // what the cache had, so for that one any answer counts.)
    const heard = n => {
      loaded = toSortHeard && recentHeard;
      if (n || loaded) redraw();
      // Subcontractors (subs.js) file their own bills out of this list.
      document.dispatchEvent(new CustomEvent('yd-receipts'));
      // Photos sent in for a job, read cleanly: onto it (autoSort).
      if (loaded) autoSoon();
    };
    unsubs.push(window.YDDb.watchWhere('receipts', 'status', 'new', changes => {
      toSortHeard = true;
      take(toSort, changes);
      heard(changes.length);
    }, () => { toSortHeard = true; heard(1); }));
    const onRecent = (changes, meta) => {
      if (meta && meta.fromCache === false) recentHeard = true;
      take(recent, changes);
      heard(changes.length);
    };
    // An older firebase-init.js (a phone that picked up this file first, on
    // one bar) has no watchFrom: then every receipt is "recent", as before.
    unsubs.push(window.YDDb.watchFrom
      ? window.YDDb.watchFrom('receipts', 'date', since, onRecent, () => { recentHeard = true; heard(1); })
      : window.YDDb.watch('receipts', onRecent, () => { recentHeard = true; heard(1); }));
    if (window.YDAuth && window.YDAuth.isOwner) loadState().then(() => redraw());
  }

  // Opening Receipts also re-reads when email was last checked: the half-
  // hourly run may have changed it (switched on, say) since the app opened.
  window.YDReceipts = {
    all: () => receipts,
    // A photo that could not go where it was sent by itself (home.js).
    needsYou: needsYou,
    loaded: () => loaded,
    render: () => {
      redraw(true);
      if (window.YDAuth && window.YDAuth.isOwner && window.YDDb) loadState().then(() => redraw(true));
    },
  };

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user && sees();
    const k = on ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k !== authKey) {
      authKey = k;
      if (on && window.YDDb) start(); else stop();
    }
    // Anyone signed in may photograph a receipt (the server checks again).
    const member = a.mode === 'cloud' && !!a.user;
    document.querySelectorAll('.rc-photo-btn').forEach(b => { b.hidden = !member; });
    render();
  });

  // ------------------------------------------------------ a paper receipt
  //
  // 📷 Add a receipt: the camera, then the server reads the photo the way an
  // emailed receipt is read (receipts.py from_photo) and it lands in Receipts.
  //
  // Every photo says where it is for (Jonah, 15 Oct 2026: "receipts uploaded
  // when someone is clocked into a job auto go to that job. If theyre
  // clocked out or into anything that isnt a clients job they have to input
  // which specific job its for"):
  //   - from a job's own page (the Job or Tracking tab, the crew job page):
  //     that job, nothing to ask;
  //   - clocked into a client's job: that job, said on the bar for a few
  //     seconds with Change before it goes;
  //   - otherwise (clocked out, or on Labor, Snow, Receipts, a storm): a
  //     window asks first -- which job, or not for a job (a vehicle or fuel,
  //     the shop, the office) -- and the camera opens on the answer.
  // A clean read for a job then goes on the job by itself (autoSort above).
  const HOLD_MS = 6000;
  let nextFor = null;          // where the photo about to be taken is for
  function clockedJob() {
    const u = me();
    const all = window.YDClock && YDClock.entries ? YDClock.entries() : {};
    const e = u && Object.values(all).find(x => x && x.uid === u.uid && x.status === 'running' && x.kind === 'job');
    if (!e || !e.targetId) return null;
    const b = boardJobs().find(j => j.id === e.targetId);
    return { forTo: 'job', jobId: e.targetId, how: 'clock',
             forName: (b && b.name) || (YDClock.label ? YDClock.label(e) : '') || 'the job' };
  }
  // The jobs anyone may file a receipt to: the crew's job list (jobBoard),
  // which the office has too; bids are not on it.
  function boardJobs() {
    const b = (window.YDClock && YDClock.board && YDClock.board()) || {};
    let list = Object.keys(b).filter(id => b[id]).map(id => ({ id, name: String(b[id].name || 'Job'),
      est: String(b[id].est || b[id].estimateNumber || ''), what: String(b[id].what || ''), status: b[id].status || '' }));
    // The office before the board has come down: its own jobs.
    if (!list.length && sees()) list = jobsList().filter(j => j.status !== 'quoting')
      .map(j => ({ id: j.id, name: j.name, est: j.est, what: '', status: j.status }));
    const order = { inprogress: 0, booked: 1, scheduled: 1, complete: 3 };
    const rank = j => (order[j.status] != null ? order[j.status] : 2);
    return list.sort((a, c) => (rank(a) - rank(c)) || a.name.localeCompare(c.name));
  }
  function openCamera() {
    let inp = el('rcPhotoInput');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*'; inp.id = 'rcPhotoInput'; inp.hidden = true;
      inp.setAttribute('capture', 'environment');
      inp.onchange = () => sendPhoto(inp.files && inp.files[0]);
      document.body.appendChild(inp);
    }
    inp.value = '';
    inp.click();
  }
  // The button everywhere but a job's own page.
  window.rcPhoto = function () {
    if (!me()) { showToast('Sign in to send a receipt'); return; }
    const c = clockedJob();
    if (c) { nextFor = Object.assign({ hold: true }, c); openCamera(); return; }
    openFor(null);
  };
  // A job's own page: that job. Not one only typed in and never saved --
  // the server would not find it.
  window.rcPhotoForJob = function (jobId, name) {
    if (!me()) { showToast('Sign in to send a receipt'); return; }
    jobId = String(jobId || '');
    if (!jobId) { showToast('Open a job first'); return; }
    const b = boardJobs().find(j => j.id === jobId);
    if (!b && typeof readJobBlob === 'function' && !readJobBlob(jobId)) {
      showToast('Save the job first, then add its receipts'); return;
    }
    nextFor = { forTo: 'job', jobId, how: 'page', forName: name || (b && b.name) || 'this job' };
    openCamera();
  };
  // The Job / Tracking tab's button: the job open in the form.
  window.rcPhotoThisJob = function () {
    const id = typeof currentJobId !== 'undefined' ? currentJobId : '';
    const box = el('customerName');
    window.rcPhotoForJob(id, (box && box.value.trim()) || '');
  };

  // ------------------------------------------- which job is it for?
  //
  // Big buttons, every one in sight (Jonah: buttons, not lists that scroll
  // sideways); a search box when there are many. `changing`: a photo already
  // taken and held on the bar -- the answer goes to it, no camera.
  let changing = null;         // queue id whose place is being changed
  let pickVehicles = false;
  let pickSearch = '';
  let publicGear = null;       // settings/public.equipmentList, for those who do not see Equipment
  let gearLoading = false;
  function forModal() {
    let m = el('rcForModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal-overlay';
      m.id = 'rcForModal';
      m.onclick = ev => { if (ev.target === m) window.rcForClose(); };
      m.innerHTML = '<div class="modal" style="max-width:560px"><div class="modal-head"><h2>🧾 What is this receipt for?</h2>' +
        '<button class="modal-close" onclick="rcForClose()">&times;</button></div><div class="modal-body" id="rcForBody"></div></div>';
      document.body.appendChild(m);
    }
    return m;
  }
  function openFor(queueId) {
    changing = queueId || null;
    pickVehicles = false; pickSearch = '';
    forModal().classList.add('active');
    drawFor();
    if (!publicGear && !gearLoading && !gearList().length && window.YDDb) {
      gearLoading = true;
      Promise.resolve(window.YDDb.get('settings', 'public'))
        .then(p => { publicGear = (p && p.equipmentList) || {}; })
        .catch(() => { publicGear = null; })
        .then(() => { gearLoading = false; if (pickVehicles) drawFor(); });
    }
  }
  window.rcForClose = function () {
    const m = el('rcForModal'); if (m) m.classList.remove('active');
    // A held photo whose window was closed without an answer keeps the
    // place it had, and goes.
    if (changing && rq[changing]) { rq[changing].holdUntil = 0; rqKeep(rq[changing]); sendQueued(); }
    changing = null;
  };
  function vehicles() {
    const own = gearList();
    if (own.length) return own.map(g => ({ id: g.id, name: g.name || 'Vehicle' }));
    const src = publicGear || {};
    return Object.keys(src).filter(id => src[id]).map(id => ({ id, name: String(src[id].name || 'Vehicle') }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  function drawFor() {
    const body = el('rcForBody');
    if (!body) return;
    const tap = (args, label, cls) => '<button type="button" class="rc-for-btn' + (cls ? ' ' + cls : '') +
      '" onclick="rcForPick(' + args + ')">' + label + '</button>';
    if (pickVehicles) {
      const list = vehicles();
      body.innerHTML = '<p class="rc-for-lead">Which vehicle or machine?</p>' +
        (list.length ? '<div class="rc-for-grid">' + list.map(v => tap('\'vehicle\',\'' + safeId(v.id) + '\'', esc(v.name))).join('') + '</div>'
          : '<p class="muted">' + (gearLoading ? 'Loading the vehicles…' : 'No vehicles listed yet.') + '</p>') +
        '<div class="rc-for-grid">' + tap('\'vehicle\',\'\'', 'Not sure which') + '</div>' +
        '<button type="button" class="link-btn" onclick="rcForBack()">← Back</button>';
      return;
    }
    const all = boardJobs();
    const words = pickSearch.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = j => words.every(w => (j.name + ' ' + j.est + ' ' + j.what).toLowerCase().indexOf(w) !== -1);
    const open = all.filter(j => j.status !== 'complete' && hit(j)), done = all.filter(j => j.status === 'complete' && hit(j));
    const cur = changing && rq[changing] && rq[changing].forTo === 'job' ? rq[changing].jobId : '';
    const jobBtn = j => tap('\'job\',\'' + safeId(j.id) + '\'', esc(j.name) + (j.est ? ' <span class="job-num">#' + esc(j.est) + '</span>' : '') +
      (j.what ? '<span class="rc-for-sub">' + esc(j.what) + '</span>' : ''), j.id === cur ? 'on' : '');
    body.innerHTML =
      '<p class="rc-for-lead">' + (changing ? 'Where does this receipt go?' : 'Pick where it goes, then take the photo.') + '</p>' +
      (all.length > 8 ? '<input type="search" id="rcForFind" class="rc-for-find" placeholder="Find a job…" autocomplete="off" value="' +
        esc(pickSearch) + '" oninput="rcForFind(this.value)">' : '') +
      '<div class="rc-for-h">A job</div>' +
      (open.length ? '<div class="rc-for-grid">' + open.map(jobBtn).join('') + '</div>'
        : '<p class="muted">' + (all.length ? 'No open job matches.' : 'No jobs on the list yet.') + '</p>') +
      (done.length ? '<details class="rc-for-done"' + (words.length ? ' open' : '') + '><summary>Finished jobs (' + done.length + ')</summary>' +
        '<div class="rc-for-grid">' + done.map(jobBtn).join('') + '</div></details>' : '') +
      '<div class="rc-for-h">Not for a job</div>' +
      '<div class="rc-for-grid">' +
        tap('\'vehicles\',\'\'', '🚚 A vehicle or fuel') + tap('\'shop\',\'\'', '🏠 The shop') + tap('\'office\',\'\'', '🗂 The office') +
      '</div>';
  }
  window.rcForFind = function (text) {
    pickSearch = String(text || '');
    drawFor();
    const f = el('rcForFind');
    if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
  };
  window.rcForBack = function () { pickVehicles = false; drawFor(); };
  window.rcForPick = function (to, id) {
    if (to === 'vehicles') { pickVehicles = true; drawFor(); return; }
    let f;
    if (to === 'job') {
      const j = boardJobs().find(x => x.id === id);
      if (!j) return;
      f = { forTo: 'job', jobId: j.id, how: 'picked', forName: j.name };
    } else if (to === 'vehicle') {
      const v = vehicles().find(x => x.id === id);
      f = { forTo: 'vehicle', equipmentId: v ? v.id : '', how: 'picked', forName: v ? v.name : 'a vehicle' };
    } else if (to === 'shop' || to === 'office') {
      f = { forTo: to, how: 'picked', forName: to === 'shop' ? 'the shop' : 'the office' };
    } else return;
    const m = el('rcForModal'); if (m) m.classList.remove('active');
    if (changing && rq[changing]) {
      const it = rq[changing];
      changing = null;
      Object.assign(it, { forTo: '', jobId: '', equipmentId: '' }, f, { holdUntil: 0 });
      rqKeep(it);
      showToast('🧾 Receipt for ' + f.forName);
      sendQueued();
      return;
    }
    changing = null;
    nextFor = f;
    // Still the same tap: a phone opens the camera only from one.
    openCamera();
  };
  // The bar's Change, for the photo held there.
  window.rcChangeFor = function (id) {
    const it = rq[id];
    if (!it || it.state === 'sending') return;
    it.holdUntil = Date.now() + 10 * 60 * 1000;    // held while the window is open
    openFor(id);
  };

  // ------------------------------------- a photo kept until it has gone
  //
  // A receipt is photographed at the counter or in the truck, often with
  // no signal -- and the photo used to be sent straight away or not at all
  // ("Receipt: No connection"), which lost it. Now it is shrunk and kept on
  // the phone first (IndexedDB, the way job photos are kept: jobphotos.js),
  // then sent; with no signal it waits and goes by itself when the signal
  // comes back, the app comes back on screen, or the person signs in again
  // -- even if the app was closed in between. While any is waiting a small
  // bar says so, instead of a message that is gone in two seconds.
  //
  // Sent at most once at a time, and only by whoever took it (the server
  // files it under the person signed in). A read the server turns down for
  // a reason of its own (not a receipt, say) is not tried again and again:
  // it waits for "Try again" or "Throw away".
  const RQ_DB = 'ydjobhub_receipts', RQ_STORE = 'queue';
  // forTo/jobId/equipmentId/how/forName: where it is for (above);
  // holdUntil: not sent before then -- the few seconds its Change is offered.
  const rq = {};               // id -> { id, by, mediaType, data, forTo, jobId, ..., at, state, error, tries, holdUntil }
  let rqDb = null, rqBusy = false;
  function rqIdb() {
    if (!rqDb) rqDb = new Promise((res, rej) => {
      if (!window.indexedDB) { rej(new Error('no IndexedDB')); return; }
      const r = indexedDB.open(RQ_DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(RQ_STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return rqDb;
  }
  function rqTx(mode, fn) {
    return rqIdb().then(db => new Promise((res, rej) => {
      const t = db.transaction(RQ_STORE, mode);
      const out = fn(t.objectStore(RQ_STORE));
      t.oncomplete = () => res(out && out.result);
      t.onerror = () => rej(t.error);
    }));
  }
  // Only what is kept is kept: the state words are this visit's.
  const rqKeep = it => rqTx('readwrite', s => s.put({ id: it.id, by: it.by, mediaType: it.mediaType, data: it.data,
    jobId: it.jobId || '', forTo: it.forTo || '', equipmentId: it.equipmentId || '', how: it.how || '', forName: it.forName || '',
    holdUntil: it.holdUntil || 0, at: it.at, tries: it.tries || 0, failed: it.state === 'failed' ? it.error || 'Not read' : '' }))
    .catch(e => console.warn('[receipts] photo kept in memory only:', e));
  const rqDrop = id => rqTx('readwrite', s => s.delete(id)).catch(() => {});
  const rqLoad = () => rqTx('readonly', s => s.getAll()).catch(() => []);
  const myUid = () => ((me() || {}).uid || '');
  const mineWaiting = () => Object.values(rq).filter(it => it.by === myUid());

  async function sendPhoto(f) {
    if (!f) return;
    if (!window.YDSupplies || !window.YDSupplies.shrinkPhoto) { showToast('Not ready yet — try again in a moment'); return; }
    if (!me()) { showToast('Sign in to send a receipt'); return; }
    // Where it is for was settled before the camera opened.
    const where = nextFor || {};
    nextFor = null;
    let photo;
    try { photo = await window.YDSupplies.shrinkPhoto(f); }
    catch (e) { showToast('Receipt: ' + (e.message || e)); return; }
    const it = { id: 'rq' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), by: myUid(),
                 mediaType: photo.mediaType, data: photo.data, forTo: where.forTo || '', jobId: where.jobId || '',
                 equipmentId: where.equipmentId || '', how: where.how || '', forName: where.forName || '',
                 holdUntil: where.hold ? Date.now() + HOLD_MS : 0, at: new Date().toISOString(),
                 state: 'waiting', error: '', tries: 0 };
    rq[it.id] = it;
    await rqKeep(it);
    drawSendBar();
    sendQueued();
  }
  // A held photo goes when its moment is up.
  let holdTimer = null;
  function wakeForHeld() {
    clearTimeout(holdTimer);
    const next = mineWaiting().filter(x => x.holdUntil > Date.now()).map(x => x.holdUntil).sort((a, b) => a - b)[0];
    if (next) holdTimer = setTimeout(() => sendQueued(), next - Date.now() + 50);
  }
  const held = it => (it.holdUntil || 0) > Date.now();

  // Each of this person's waiting photos, one after another. `again`: the
  // ones the server turned down are tried too (the person asked).
  let rqAgain = false;         // asked again while a run was going: one more run after it
  async function sendQueued(again) {
    if (rqBusy || !me()) { if (rqBusy) rqAgain = rqAgain || 'more'; drawSendBar(); return; }
    rqBusy = true;
    const tried = new Set();
    try {
      // One at a time, each once a run -- including one photographed while
      // the one before it was still on its way.
      for (;;) {
        const it = mineWaiting().find(x => !tried.has(x.id) && !held(x) && (x.state !== 'failed' || again));
        if (!it) break;
        tried.add(it.id);
        if (navigator.onLine === false || !window.YDClaude) { it.state = 'waiting'; continue; }
        it.state = 'sending'; it.error = '';
        drawSendBar();
        try {
          const r = await window.YDClaude.post('/receipts/photo', { mediaType: it.mediaType, data: it.data,
            jobId: it.jobId || '', forTo: it.forTo || '', equipmentId: it.equipmentId || '', how: it.how || '' });
          delete rq[it.id];
          rqDrop(it.id);
          showToast(photoSaid(r, it), 6000);
        } catch (e) {
          const msg = String((e && e.message) || e || '');
          it.tries = (it.tries || 0) + 1;
          // No signal (or the sign-in could not be checked without it):
          // waits, and goes by itself. Anything else the server said is
          // kept to show, and waits for a tap.
          // "Could not confirm your sign-in" is claude.js saying the sign-in
          // could not be checked -- on one bar of signal, where the phone
          // still says it is online. It used to wait for a tap instead.
          const offline = navigator.onLine === false || /no connection|network|failed to fetch|load failed|could not confirm your sign-in/i.test(msg) ||
            (e && /network/.test(String(e.code || '')));
          it.state = offline ? 'waiting' : 'failed';
          it.error = offline ? '' : msg.slice(0, 200);
          rqKeep(it);
        }
      }
    } finally {
      rqBusy = false;
      drawSendBar();
      wakeForHeld();
    }
    // Asked for again while this run was going (signal came back, say):
    // only for a photo this run did not get to try.
    if (rqAgain) {
      rqAgain = false;
      if (mineWaiting().some(x => !tried.has(x.id) && x.state === 'waiting')) sendQueued();
    }
  }

  // What the server did with it, for the person who sent it: on its job by
  // itself, or waiting for Jonah, and why.
  function photoSaid(r, it) {
    const what = '🧾 ' + (r.vendor || 'Receipt') + ' ' + money(r.totalCents);
    if (r.what === 'added to') return what + ' — matched a receipt already there';
    const where = r.name || it.forName || '';
    if (r.auto === 'ready') return what + ' — going on ' + (where || 'its job') + (sees() ? '' : ' (Jonah sees it)');
    if (r.why) return what + ' — ' + (sees() ? 'in Receipts to sort: ' : 'sent to Jonah to check: ') + r.why;
    return what + ' — ' + (sees() ? 'in Receipts to sort' : 'sent to the office');
  }

  // The bar: how many are waiting and why, with Try again / Throw away when
  // one needs a tap. Hidden when nothing is waiting. A photo held for its
  // few seconds says where it is going, with Change.
  function drawSendBar() {
    let bar = el('rcSendBar');
    const list = mineWaiting();
    if (!list.length) { if (bar) bar.hidden = true; return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'rcSendBar';
      bar.className = 'rc-sendbar';
      bar.setAttribute('role', 'status');
      document.body.appendChild(bar);
    }
    const sending = list.some(it => it.state === 'sending');
    const failed = list.filter(it => it.state === 'failed');
    const n = list.length;
    // The newest one not yet gone may still change where it is for.
    const last = list.filter(it => it.state !== 'sending').sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    const hold = last && held(last) && !failed.length;
    const changeBtn = last && !failed.length && last.forTo !== undefined
      ? '<button class="btn btn-sm" onclick="rcChangeFor(\'' + safeId(last.id) + '\')">Change</button>' : '';
    if (hold) {
      const h = '<span class="rc-sendbar-t">🧾 Receipt for <b>' + esc(last.forName || 'the job') + '</b> — sending in a moment</span>' + changeBtn;
      if (bar.innerHTML !== h) bar.innerHTML = h;
      bar.classList.remove('failed');
      bar.hidden = false;
      return;
    }
    const words = sending ? '🧾 Sending ' + (n === 1 ? 'the receipt' : n + ' receipts') + '…'
      : failed.length ? '🧾 ' + (failed.length === 1 ? 'A receipt was' : failed.length + ' receipts were') + ' not read: ' + failed[0].error
      : '🧾 ' + (n === 1 ? '1 receipt' : n + ' receipts') + ' waiting for signal — ' + (n === 1 ? 'it sends' : 'they send') + ' by itself';
    const html = '<span class="rc-sendbar-t">' + esc(words) + '</span>' +
      (sending ? '' : '<button class="btn btn-sm" onclick="rcSendAgain()">Try again</button>') +
      // Waiting for signal: where it goes can still be changed.
      (!sending && !failed.length ? changeBtn : '') +
      (failed.length && !sending ? '<button class="btn btn-sm" onclick="rcThrowAway()">Throw away</button>' : '');
    if (bar.innerHTML !== html) bar.innerHTML = html;
    bar.classList.toggle('failed', !!failed.length && !sending);
    bar.hidden = false;
  }
  window.rcSendAgain = function () { sendQueued(true); };
  // Only the ones the server turned down: a photo still waiting for signal
  // is never thrown away by this.
  window.rcThrowAway = async function () {
    const failed = mineWaiting().filter(it => it.state === 'failed');
    if (!failed.length || !(await ydConfirm(failed.length === 1 ? 'It was not read.' : 'They were not read.',
        { title: failed.length === 1 ? 'Throw this receipt photo away?' : 'Throw these ' + failed.length + ' receipt photos away?', ok: 'Throw away', danger: true }))) return;
    failed.forEach(it => { delete rq[it.id]; rqDrop(it.id); });
    drawSendBar();
  };

  // Whatever this phone kept from before (the app closed with one waiting).
  let rqLoadedFor = null;
  async function loadReceiptQueue() {
    const uid = myUid();
    if (!uid || rqLoadedFor === uid) { sendQueued(); return; }
    rqLoadedFor = uid;
    const items = await rqLoad();
    (items || []).forEach(x => {
      if (!x || !x.id || rq[x.id]) return;
      rq[x.id] = Object.assign({}, x, { state: x.failed ? 'failed' : 'waiting', error: x.failed || '' });
    });
    drawSendBar();
    sendQueued();
  }
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    if (a.mode === 'cloud' && a.user) loadReceiptQueue();
    // Someone else signed in on this phone: their photos stay kept, unseen,
    // until they sign in again.
    else { rqLoadedFor = null; drawSendBar(); }
  });
  window.addEventListener('online', () => sendQueued());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sendQueued(); });
})();
