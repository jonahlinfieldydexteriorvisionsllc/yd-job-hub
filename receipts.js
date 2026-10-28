// Receipts -- a tab of its own: the ones to sort, then every one so far.
//
// The server reads the owner's email every half hour (functions/receipts.py)
// and writes each purchase it finds to receipts/{id}: the store, the date,
// every line, the tax and the total, and a job it thinks the purchase is for
// when the delivery address or a name on the order says so. This screen is
// where each one is sorted: to a job, a vehicle, shop overhead, office
// overhead, property overhead, LLC overhead, equipment, equipment
// maintenance, a subcontractor, a loan payment, personal --
// or set aside, with a note saying why (PLACE_LIST below). Tags on the whole
// receipt (a rebate to claim, a warranty...) come on top of that (RECEIPT_TAGS).
// What is no receipt at all is kept apart: a bill not paid yet waits under
// Invoices to pay until it is, and anything can be marked 🚫 Not a receipt,
// which teaches the email reader to pass mail like it over (rcNotReceipt).
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
  const PULL_PAGE = 20;       // the year's pulled receipts shown at a time (pulledHtml)
  let pullShown = 0;          // how many of them are shown; 0 = folded

  const KIND = {
    materials: 'Materials', plants: 'Plants', dump_and_disposal: 'Dump & disposal',
    equipment_and_repairs: 'Equipment & repairs', fuel: 'Fuel', tools: 'Tools', rental: 'Rental',
    subcontractor: 'Subcontractor', vehicle: 'Vehicle', office_and_software: 'Office & software',
    insurance: 'Insurance', utilities_and_phone: 'Utilities & phone', loan_payment: 'Loan payment', travel: 'Travel', other: 'Other',
  };
  // Why a receipt was set aside, in the words of the old pick list. Only read
  // back now: since 13 Oct `skipWhy` is the note typed when it was set aside
  // (Jonah: "when something is selected to be set aside have an area to add
  // a note for why"). 'overhead' (before 9 Oct) and 'subcontractor' (before
  // 13 Oct) were really places -- read back as the shop and Subcontractors
  // (stages.js RECEIPT_LEGACY_PLACE, legacyPlace below) -- and 'personal' is
  // a place too. The words live in stages.js, which reads a receipt's one
  // status from them.
  const WHY = window.YDStages.RECEIPT_WHY;
  // Offered under the note box; anything else can be typed.
  const WHY_IDEAS = ['Already entered', 'Not a purchase', 'Duplicate of another receipt', 'Returned / refunded'];

  // Where a receipt goes (Jonah, 9 Oct 2026: "sort receipts ... by vehicle/
  // job/shop overhead/office overhead/personal"). Each split says where its
  // lines went (`to`); one with no `to` went to a job, as all did before.
  // The first choice comes from what Claude already said the purchase was
  // (`kind`, read with the receipt -- no extra call): fuel to a vehicle,
  // repairs and upkeep to equipment maintenance, office things to the
  // office, tools to the shop, the rest a job.
  //
  // A subcontractor's bill is a place of its own (Jonah, 13 Oct 2026: "sub
  // bills should have its own category"): a split `to: 'sub'` naming them
  // (`subId` when they are set up under Subcontractors, subs.js). "Set
  // aside" is the last choice: not a place -- nothing set aside counts
  // anywhere ("anything set aside clearly doesnt have a category and doesnt
  // matter") -- but chosen the same way, with a note for why.
  //
  // Jonah, 21 Oct 2026: "add tag for receipts for personal and one for
  // property overhead. personal receipts dont get deleted". Property
  // overhead is a cost of the business like the shop and the office.
  // Personal is a place a receipt is KEPT in (it used to be deleted), but it
  // is off the books: never in the month totals, never sent to QuickBooks
  // (stages.js RECEIPT_OFF_BOOKS, which says which places those are).
  //
  // Jonah, 22 Oct 2026: "add loan payments as a tag for receipts". A loan
  // payment (a truck or a machine) is the business's money, counted under
  // its own name ("Loan payments" in a month's totals), filed by the
  // lender's name -- but never sent to QuickBooks as an expense, since most
  // of it pays back what was borrowed, which is not a cost (stages.js
  // RECEIPT_NOT_TO_QB). One the email reader reads as a loan payment comes
  // with this place already picked.
  //
  // Jonah, 27 Oct 2026: "add receipt tag for travel" -- a hotel, a flight,
  // parking or meals on a business trip. A business cost like the others,
  // counted under its own name and sent to QuickBooks as usual.
  //
  // Jonah, 28 Oct 2026: "I need a tag thats LLC Overhead" (what the company
  // itself costs), "equipment this is where receipts for equipment
  // purchases go" (renewing a trailer's plates too) "and a separate one for
  // maintenance on equipment. like air filters". Business costs like the
  // shop and the office. Upkeep the reader reads as equipment & repairs
  // (oil, filters -- receipts.py kind_of) starts on Equipment maintenance.
  //
  // Every place is one row here -- its chip on a card, its name, its filter
  // under All receipts and its name in a month's totals -- so another place
  // is one more row, and every list below follows.
  const PLACE_LIST = [
    { id: 'job', chip: '📋 Job', name: 'Job', view: '📋 Jobs', total: 'Jobs' },
    { id: 'vehicle', chip: '🚚 Vehicle', name: 'Vehicle', view: '🚚 Vehicles', total: 'Vehicles' },
    { id: 'shop', chip: '🏠 Shop overhead', name: 'Shop overhead', view: '🏠 Shop', total: 'Shop' },
    { id: 'office', chip: '🗂 Office overhead', name: 'Office overhead', view: '🗂 Office', total: 'Office' },
    { id: 'property', chip: '🌳 Property overhead', name: 'Property overhead', view: '🌳 Property', total: 'Property' },
    { id: 'llc', chip: '🏢 LLC overhead', name: 'LLC overhead', view: '🏢 LLC', total: 'LLC overhead' },
    { id: 'equipment', chip: '🚜 Equipment', name: 'Equipment', view: '🚜 Equipment', total: 'Equipment' },
    { id: 'upkeep', chip: '🔧 Equipment maintenance', name: 'Equipment maintenance', view: '🔧 Maintenance', total: 'Equipment maintenance' },
    { id: 'travel', chip: '✈️ Travel', name: 'Travel', view: '✈️ Travel', total: 'Travel' },
    { id: 'sub', chip: '🤝 Subcontractor', name: 'Subcontractor', view: '🤝 Subcontractors', total: 'Subcontractors' },
    { id: 'loan', chip: '🏦 Loan payment', name: 'Loan payment', view: '🏦 Loans', total: 'Loan payments' },
    { id: 'personal', chip: '👤 Personal', name: 'Personal', view: '👤 Personal', total: 'Personal' },
  ];
  // (A phone that picked up this file before the new stages.js, on one bar
  // of signal, still knows Personal is off the books.)
  const offBooks = id => (window.YDStages.RECEIPT_OFF_BOOKS || ['personal']).indexOf(id) !== -1;
  const DEST = PLACE_LIST.map(p => [p.id, p.chip]).concat([['aside', '🗄 Set aside']]);
  const DEST_NAME = PLACE_LIST.reduce((o, p) => (o[p.id] = p.name, o), { aside: 'Set aside' });
  const DEST_OF_KIND = { fuel: 'vehicle', vehicle: 'vehicle', equipment_and_repairs: 'upkeep',
    office_and_software: 'office', utilities_and_phone: 'office', insurance: 'office', tools: 'shop',
    loan_payment: 'loan', travel: 'travel' };
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
    // Claude read it as clearly a household's (a photo still to sort --
    // the email reader files those itself, functions/receipts.py).
    if (r.whose === 'personal') return 'personal';
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
  // The jobs a receipt can be put on, open ones first. Left out: lost bids,
  // jobs marked to be taken off (a second copy of a job) and ones in Recently
  // deleted -- a long list of dead entries is what he scrolled past on every
  // card (`dead`: a card's picker leaves them out, but still shows the one
  // that card's receipt points at -- the job Claude suggested, the one picked).
  // Jobs finished more than two months ago come after the recently finished.
  function jobsList() {
    const order = { inprogress: 0, booked: 1, quoting: 2, complete: 3 };
    const oldBefore = Date.now() - 60 * 864e5;
    return (typeof loadAllJobs === 'function' ? loadAllJobs() : [])
      .filter(j => j && j._id)
      .map(j => {
        const status = normStatus(j.jobStatus, j), done = status === 'complete' ? new Date(j.completedAt || '').getTime() : NaN;
        return { id: j._id, name: (j.customerName || '').trim() || 'Untitled job', est: String(j.estimateNumber || '').trim(),
          status: status, rank: order[status] + (done < oldBefore ? 1 : 0),
          dead: !!(j.deletedAt || j.removeWhy || (status === 'quoting' && j.bidStage === 'lost')) };
      })
      .sort((a, b) => (a.rank - b.rank) || a.name.localeCompare(b.name));
  }
  function jobLabel(j) {
    return j.name + (j.est ? ' #' + j.est : '') + (j.status === 'complete' ? ' (complete)' : '');
  }

  // ------------------------------------------------------------ writing

  // A receipt's ONE status (Jonah, 15 Oct 2026): To sort -> Filed (a job, a
  // vehicle, the shop, the office, a subcontractor) -- or Set aside, with the
  // reason. stages.js reads it (YDStages.receipt); the stored words stay
  // 'new' / 'done' / 'skipped', which the server's queries and the rules ask
  // for. A change of status now also says who made it and when
  // (statusChange) -- only when it IS a change: a few more lines put on a job
  // from a receipt still to sort leave it as it was.
  const stageOf = r => window.YDStages.receipt(r);
  const toSortNow = r => !!r && stageOf(r).id === 'tosort';
  // A bill not paid yet (Invoices to pay), and one marked Not a receipt:
  // their own stored words (stages.js), neither of them a cost.
  const TO_PAY = window.YDStages.RECEIPT_TO_PAY || 'topay';
  const NOT_RECEIPT = window.YDStages.RECEIPT_NOT || 'notreceipt';
  const toPayNow = r => !!r && stageOf(r).id === 'topay';
  const notReceiptNow = r => !!r && stageOf(r).id === 'notreceipt';
  // To sort and from the new mail -- not from the year's pull (pulledHtml).
  const newToSort = r => toSortNow(r) && !r.pulled;
  function moved(r, patch, who) {
    if (patch.status && (r && r.status) !== patch.status) patch.statusChange = window.YDStages.stamp(patch.status, who);
    return patch;
  }
  // Put by itself (a photo sent in for a job): said so, rather than as the
  // person whose device happened to do it.
  const BY_ITSELF = { uid: '', name: 'Job Hub' };

  // Not awaited: a write only settles when the server answers, and a truck
  // with no signal would sit frozen. Firestore holds it until then.
  //
  // Who moved its status goes in a write of its own, after the sorting: the
  // rules that allow it may reach the server a minute after this code does
  // (or be rolled back), and a refused stamp must never take the sorting
  // down with it -- a receipt whose lines went onto a job but which stayed
  // "to sort" would be added twice. Lost, the stamp is only a date missing.
  function write(rid, data) {
    const stamp = data.statusChange;
    delete data.statusChange;
    data.updatedAt = new Date().toISOString();
    data.updatedBy = (me() || {}).uid || '';
    Promise.resolve(window.YDDb.put('receipts', rid, data)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[receipts] not yet on the server:', (e && e.code) || e);
    });
    if (stamp) {
      Promise.resolve(window.YDDb.put('receipts', rid, { statusChange: stamp }))
        .catch(e => console.warn('[receipts] who moved it not saved:', (e && e.code) || e));
    }
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

  // Ticks "ordered" on the Materials to Order items this split's lines are,
  // noting the order and what was paid for each (Jonah, 26 Oct 2026: "mark
  // which items are on the receipt as purchased and update the price of the
  // items to exactly what was spent"): the same Supplies item when both say
  // which, else the same words (app.js sameMaterial: plain word matching, no
  // Claude). Each receipt line ticks one item -- a second line of the same
  // thing (two loads of topsoil) adds to what that item cost. `lines`:
  // [{name, sid, cents}]. Undo takes back only the ticks it made.
  function tickOrdered(list, lines, info) {
    const paid = {};
    lines.forEach(l => {
      const fits = it => l.sid && it.supplyId ? it.supplyId === l.sid : sameMaterial(it.name, l.name);
      // A line marked not bought (app.js orderNotBought) was bought after
      // all -- but another line of the same thing still to order comes first.
      const ks = list.map((it, k) => k).filter(k => !list[k].ordered && fits(list[k]))
        .sort((a, b) => (list[a].notBought ? 1 : 0) - (list[b].notBought ? 1 : 0) || a - b);
      if (!ks.length) return;
      const k = ks.find(x => !(x in paid));
      const at = k === undefined ? ks[0] : k;
      paid[at] = (paid[at] || 0) + (Number(l.cents) || 0);
    });
    return list.map((it, k) => k in paid
      ? Object.assign({}, it, { ordered: true, orderNo: info.orderNo, orderedFrom: info.vendor,
        orderReceiptId: info.rid, orderSplitId: info.sid, paidCents: paid[k], notBought: null })
      : it);
  }
  function untickOrdered(list, sid) {
    return list.map(it => it.orderSplitId === sid
      ? Object.assign({}, it, { ordered: false, orderNo: null, orderedFrom: null, orderReceiptId: null, orderSplitId: null,
        paidCents: null })
      : it);
  }
  // Which Supplies item a receipt line is (its supplier's item number, or its
  // name), or ''.
  function supplyOf(r, l) {
    const S = window.YDSupplies;
    const it = S && S.findSupply ? S.findSupply(r.vendor, l.itemNo, l.name) : null;
    return (it && it.id) || '';
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

  // A vehicle, the shop, the office, the property, a subcontractor or
  // Personal: kept on the receipt, nothing changes on a job. The vehicle's
  // own page lists what was sorted to it (equipment.js receiptsHtml).
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
    } else if (to === 'loan') {
      // By the lender's name, so the truck's loan and the machine's are told
      // apart in the list.
      target = { name: (r.vendor || '').trim() || DEST_NAME.loan };
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
    const patch = moved(r, Object.assign({ splits, status }, auto ? { auto } : {}), auto ? BY_ITSELF : null);
    receipts[rid] = Object.assign({}, r, patch);
    delete ticked[rid];
    write(rid, Object.assign({}, patch));
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
    if (to !== 'job') { assignElsewhere(rid, r, to); return; }
    const jobId = chosen[rid] != null ? chosen[rid] : ((r.suggest && r.suggest.jobId) || '');
    if (!jobId) { showToast('Pick the job first'); return; }
    const done = addToJob(rid, r, jobId, null);
    // After the toast has had its moment: any price that is not the price
    // list's, to Supplies → Prices to check.
    if (done) setTimeout(() => checkPrices(rid, r, done, (receipts[rid] && lastJobName(receipts[rid])) || ''), 400);
  };
  const lastJobName = r => { const s = (r.splits || []).filter(x => x && x.to === 'job').slice(-1)[0]; return s ? s.jobName || '' : ''; };

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
      const out = tickOrdered(list, idxs.map(i => ({ name: lines[i].name, sid: supplyOf(r, lines[i]), cents: lines[i].cents })),
        { orderNo: r.orderNo || '', vendor: r.vendor || '', rid, sid });
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
    const patch = moved(r, Object.assign({ splits, status }, auto ? { auto } : {}), auto ? BY_ITSELF : null);
    // Shown at once rather than when the server echoes it back.
    receipts[rid] = Object.assign({}, r, patch);
    delete ticked[rid]; delete chosen[rid];
    write(rid, Object.assign({}, patch));
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
  const autoReady = r => !!(r && toSortNow(r) && !(r.splits || []).length && r.auto && r.auto.state === 'ready');
  function autoSoon() {
    if (!sorts() || !loaded || !window.YDDb || !window.YDDb.transact) return;
    Object.keys(receipts).forEach(id => { if (autoReady(receipts[id]) && !autoBusy[id] && !leaving[id]) autoSort(id); });
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
    if (!f || !toSortNow(r)) return '';
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
  const needsYou = r => !!(r && toSortNow(r) && r.auto && (r.auto.state === 'needs' ||
    (r.auto.state === 'adding' && Date.now() - new Date(r.auto.at || 0).getTime() > STUCK_MS)));

  // ------------------------------------------------- the price list follows
  //
  // A line on a receipt that is one of our supplies (its supplier's item
  // number, or its name) and cost something different from the price list
  // goes to Prices to check (checkPrices, below) -- Jonah (6 Oct 2026): never
  // changed without him. What the estimates are priced from then stays what
  // he actually pays.
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
  // A price on a receipt that is not the price list's goes to Supplies →
  // Prices to check, for a look before estimates use it (Jonah, 26 Oct 2026:
  // "when numbers dont line up they should be submitted for review so i can
  // ensure there wasnt a mistake made"). It was a question there and then,
  // which a year of old receipts would have asked a hundred times. It waits
  // on the item's own price (supplyPrices `check`, supplies.js); a newer
  // receipt's check is never replaced by an older one's.
  function checkPrices(rid, r, idxs, where) {
    const ch = priceChanges(r, idxs);
    if (!ch.length) return;
    const prices = window.YDSupplies.catalog().prices;
    let n = 0, failed = 0;
    ch.forEach(c => {
      const was = (prices[c.id] || {}).check;
      if (was && was.date && r.date && r.date < was.date) return;
      n++;
      Promise.resolve(window.YDDb.put('supplyPrices', c.id, { check: {
        cents: c.to, per: c.per || '', year: c.year, from: c.from, unsure: !!c.unsure, receiptId: rid,
        vendor: r.vendor || '', orderNo: r.orderNo || '', date: r.date || '', where: where || '', link: r.link || '',
        at: new Date().toISOString(), by: (me() || {}).uid || '',
      } })).catch(e => {
        if (!failed++) showToast(e && e.code === 'permission-denied' ? 'Price check not saved — not allowed' : 'Price check not on the server yet');
      });
    });
    if (n) showToast('💲 ' + n + ' price' + (n === 1 ? '' : 's') + ' on this receipt differ from the price list — Supplies → Prices to check', 5000);
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
    const patch = moved(r, { splits, status });
    receipts[rid] = Object.assign({}, r, patch);
    write(rid, Object.assign({}, patch));
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
  // What went anywhere but a job -- a vehicle, the shop, the office, the
  // property, a subcontractor, Personal -- is kept on the receipt and
  // nowhere else (a vehicle's page, Subcontractors and the month totals
  // read it from here); so is a receipt set aside as overhead, as a
  // subcontractor's bill or as personal, before those were places.
  const HELD_HERE = PLACE_LIST.map(p => p.id).filter(id => id !== 'job');
  const legacyPlace = r => stageOf(r).legacy || '';
  function heldNames(r) {
    const legacy = legacyPlace(r);
    return (r.splits || []).filter(s => HELD_HERE.indexOf(destOf(s)) !== -1)
      .map(s => s.name || DEST_NAME[destOf(s)])
      .concat(legacy ? [legacy === 'sub' ? 'a subcontractor' : DEST_NAME[legacy]] : [])
      .filter((n, i, a) => a.indexOf(n) === i);
  }
  const heldHere = r => heldNames(r).length > 0;
  // Set aside: skipped, and not one of the old reasons that were really a
  // place (stages.js). It counts nowhere.
  const isAside = r => stageOf(r).id === 'aside';
  // What "Delete all set aside" may take: set aside, and holding nothing the
  // books need (a subcontractor's bill is never set aside now; an old one is
  // a place, above) -- nor anything personal, which is kept.
  const deletableAside = r => isAside(r) && !heldHere(r);

  // 🗑 Delete sits on every receipt (Jonah, 21 Oct 2026: "there should be a
  // delete button not just a set aside button"; it used to hide behind ⋯).
  // One tap, then a few seconds of Undo (app.js showUndo: "a quicker, kinder
  // answer to a slip than 'Are you sure?'"). Only the app's server can make
  // a receipt, so one deleted can never be put back by the app: nothing is
  // deleted until the Undo has run out -- until then it is only off the
  // screen (`leaving`). Closing the app in that time lets it go; signing out
  // keeps it. A receipt holding what went somewhere other than a job asks
  // first as well: that part lives nowhere else.
  const UNDO_MS = 8000;
  const leaving = {};         // receipt id -> true while its Undo is on screen
  let leavingBatch = null;    // { ids, timer } of the delete whose Undo is showing
  function flushLeaving() {
    const b = leavingBatch;
    if (!b) return;
    leavingBatch = null;
    clearTimeout(b.timer);
    const ids = b.ids.filter(id => leaving[id]);
    ids.forEach(id => { delete leaving[id]; });
    if (ids.length) drop(ids);
  }
  function forgetLeaving() {
    if (leavingBatch) clearTimeout(leavingBatch.timer);
    leavingBatch = null;
    Object.keys(leaving).forEach(id => { delete leaving[id]; });
  }
  function dropSoon(ids, say) {
    // A second delete replaces the first one's bar, and its Undo with it.
    flushLeaving();
    if (!ids.length) return;
    const b = { ids: ids.slice(), timer: null };
    ids.forEach(id => { leaving[id] = true; delete ticked[id]; delete chosen[id]; delete splitting[id]; });
    b.timer = setTimeout(() => { if (leavingBatch === b) flushLeaving(); }, UNDO_MS);
    leavingBatch = b;
    const back = () => {
      if (leavingBatch !== b) return;
      leavingBatch = null;
      clearTimeout(b.timer);
      b.ids.forEach(id => { delete leaving[id]; });
      redraw(true);
    };
    if (typeof showUndo === 'function') showUndo(say, back, UNDO_MS); else showToast(say);
    redraw(true);
  }
  window.addEventListener('pagehide', flushLeaving);

  window.rcDelete = async function (rid) {
    const r = receipts[rid];
    if (!r || !owner() || leaving[rid]) return;
    if (heldHere(r) && !(await ydConfirm('What went to ' + heldNames(r).join(', ') +
        ' is kept on this receipt and nowhere else, so it comes out of those totals. The email stays in Gmail.',
        { title: 'Delete this ' + (r.vendor || '') + ' receipt from the hub?', ok: 'Delete', danger: true }))) return;
    if (!receipts[rid] || leaving[rid]) return;
    const onJobs = (r.splits || []).some(s => destOf(s) === 'job');
    dropSoon([rid], '🗑 ' + (r.vendor || 'Receipt') + ' ' + money(r.totalCents) + ' deleted' +
      (onJobs ? ' — its lines stay on the jobs' : ''));
  };
  window.rcDeleteAside = async function () {
    const ids = allReceipts().filter(deletableAside).map(r => r.id);
    if (!ids.length || !owner()) return;
    if (!(await ydConfirm('Their emails stay in Gmail.', { title: 'Delete all ' + ids.length + ' set-aside receipts from the hub?', ok: 'Delete them', danger: true }))) return;
    const still = ids.filter(id => receipts[id] && !leaving[id]);
    dropSoon(still, '🗑 ' + still.length + ' set-aside receipt' + (still.length === 1 ? '' : 's') + ' deleted');
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
    const patch = moved(r, { status: 'skipped', skipWhy: why, skippedBy: (me() || {}).uid || '' });
    receipts[rid] = Object.assign({}, r, patch);
    delete asideWhy[rid]; delete dest[rid]; delete ticked[rid]; delete splitting[rid];
    write(rid, Object.assign({}, patch));
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
    if (notReceiptNow(r)) { notBack(rid, true); return; }
    const status = freeLines(r).length ? 'new' : 'done';
    const patch = moved(r, { status, skipWhy: '', skippedBy: '' });
    receipts[rid] = Object.assign({}, r, patch);
    write(rid, Object.assign({}, patch));
    redraw(true);
  };

  // ------------------------------------------------- not a receipt
  //
  // Jonah, 26 Oct 2026: "you keep pulling things that arent receipts. I want
  // you to learn from the recceipts I mark as not receipts. so add a 'not
  // receipt' tag." 🚫 Not a receipt on any receipt with nothing put anywhere
  // yet (lines already on a job come off first, ⋯ → Undo): it leaves To
  // sort and every total, is never sent to QuickBooks, and waits under All
  // receipts → 🚫 Not receipts, where Put back undoes it.
  //
  // And it teaches the email reader, in plain code: each of its emails --
  // the sender (the store's domain, or the whole address for gmail and the
  // like) and the subject's shape (every word with a digit in it one "#") --
  // goes in settings/receiptLearn, and mail like it is passed over unread
  // from then on (functions/receipts.py _learned). The latest are also shown
  // to the call that sorts the mail, so Claude learns from them too. Undone
  // (Put back), the receipt's id comes off its patterns, and a pattern with
  // no receipt left counts no more: one wrong mark is undone by undoing it.
  //
  // Never too wide: a pattern that other receipts here also have (a store's
  // "Order confirmation" marked because it was a $0 order) is only shown to
  // Claude as an example, never skipped by code -- so a real receipt like
  // it is never passed over unread.
  const LEARN_DOC = 'receiptLearn';
  // Keep these three the same as receipts.py FREE_MAIL, sender_key and
  // subject_shape. The server works the sender and shape out again from the
  // From and Subject kept here; these are for the check above and the key.
  const FREE_MAIL = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com',
    'me.com', 'live.com', 'msn.com', 'comcast.net', 'att.net', 'charter.net'];
  function senderKey(from) {
    const m = /<([^>]+)>/.exec(String(from || ''));
    const addr = (m ? m[1] : String(from || '')).trim().toLowerCase();
    if (addr.indexOf('@') === -1) return '';
    const domain = addr.split('@').pop();
    if (FREE_MAIL.indexOf(domain) !== -1) return addr.replace(/\//g, '_').slice(0, 200);
    return domain.split('.').slice(-2).join('.').replace(/\//g, '_');
  }
  function subjectShape(subject) {
    let s = String(subject || '').replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '').toLowerCase();
    s = s.split(/\s+/).filter(Boolean).map(w => /[0-9]/.test(w) ? '#' : w).join(' ');
    s = s.replace(/[^a-z#]+/g, ' ').split(/\s+/).filter(Boolean).join(' ').replace(/#(\s+#)+/g, '#');
    return s.trim().slice(0, 120);
  }
  // A short stable key for a pattern (a map key in settings/receiptLearn).
  function patternKey(sender, shape) {
    const text = sender + '|' + shape;
    const fnv = seed => {
      let h = seed >>> 0;
      for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      return h.toString(36);
    };
    return 'lp' + fnv(2166136261) + fnv(374761393);
  }
  // A receipt's emails as patterns: one per sender + subject shape. `skip`
  // false when another receipt still counted here has one the same.
  function patternsOf(rid, r) {
    const seen = {};
    const out = [];
    (Array.isArray(r.mail) ? r.mail : []).forEach(m => {
      if (!m || !m.from) return;
      const sender = senderKey(m.from), shape = subjectShape(m.subject);
      if (!sender || !/[a-z]/.test(shape)) return;
      const key = patternKey(sender, shape);
      if (seen[key]) return;
      seen[key] = true;
      out.push({ key, sender, shape, from: String(m.from).slice(0, 200), subject: String(m.subject || '').slice(0, 300), skip: true });
    });
    if (!out.length) return out;
    allReceipts().forEach(o => {
      if (o.id === rid || notReceiptNow(o) || isAside(o)) return;
      (Array.isArray(o.mail) ? o.mail : []).forEach(m => {
        if (!m || !m.from) return;
        const sender = senderKey(m.from), shape = subjectShape(m.subject);
        out.forEach(p => { if (p.sender === sender && p.shape === shape) p.skip = false; });
      });
    });
    return out;
  }
  // The patterns, with this receipt's id on (on) or off (null) each. Merged:
  // other receipts' marks on the same pattern are kept.
  function learn(rid, pats, on) {
    if (!pats.length) return;
    const at = new Date().toISOString(), by = (me() || {}).uid || '';
    const patterns = {};
    pats.forEach(p => {
      patterns[p.key] = on
        ? { from: p.from, subject: p.subject, sender: p.sender, shape: p.shape, skip: p.skip, at, by, ids: { [rid]: true } }
        : { ids: { [rid]: null } };
    });
    Promise.resolve(window.YDDb.put('settings', LEARN_DOC, { patterns, updatedAt: at })).catch(e =>
      console.warn('[receipts] what was marked not a receipt not yet on the server:', (e && e.code) || e));
  }
  // Nothing on it may be anywhere yet: lines on a job come back off first.
  const markable = r => !!r && !(r.splits || []).length && !notReceiptNow(r);
  window.rcNotReceipt = function (rid) {
    const r = receipts[rid];
    if (!r || leaving[rid]) return;
    if (!sorts()) { showToast('You can look at jobs but not change them'); return; }
    if ((r.splits || []).length) { showToast('Take its lines back off first (⋯ → Undo), then mark it not a receipt'); return; }
    if (notReceiptNow(r)) return;
    const pats = patternsOf(rid, r);
    const skip = pats.some(p => p.skip);
    const was = r.status === TO_PAY || r.status === 'skipped' ? r.status : 'new';
    const patch = moved(r, { status: NOT_RECEIPT, notReceipt: { at: new Date().toISOString(), by: (me() || {}).uid || '',
      was, keys: pats.map(p => p.key), skip } });
    receipts[rid] = Object.assign({}, r, patch);
    delete ticked[rid]; delete chosen[rid]; delete splitting[rid]; delete dest[rid];
    write(rid, Object.assign({}, patch));
    learn(rid, pats, true);
    const say = '🚫 ' + (r.vendor || 'It') + ' — not a receipt. ' + (skip ? 'Mail like it is passed over from now on.'
      : pats.length ? 'Claude is shown it as an example (other receipts look like it).' : 'Under All receipts → 🚫 Not receipts.');
    if (typeof showUndo === 'function') showUndo(say, () => notBack(rid, false), UNDO_MS); else showToast(say);
    redraw(true);
  };
  // Put back to what it was before it was marked, and taken off what the
  // reader learned. `say`: tell so (Put back); Undo needs no words.
  function notBack(rid, say) {
    const r = receipts[rid];
    if (!r || !notReceiptNow(r)) return;
    const n = r.notReceipt || {};
    const status = n.was === TO_PAY || n.was === 'skipped' ? n.was : 'new';
    const patch = moved(r, { status, notReceipt: null });
    receipts[rid] = Object.assign({}, r, patch);
    write(rid, Object.assign({}, patch));
    learn(rid, (n.keys || []).map(key => ({ key })), false);
    if (say) showToast('Put back — ' + (status === TO_PAY ? 'under Invoices to pay' : status === 'skipped' ? 'set aside, as it was' : 'in Receipts to sort') +
      '. Mail like it is read again.');
    redraw(true);
  }

  // ------------------------------------------------- invoices to pay
  //
  // A bill not paid yet is not a receipt (Jonah, 26 Oct 2026: "that should go
  // into something that says 'invoices to pay'"). The email reader keeps one
  // as status topay (functions/receipts.py unpaid_bill): listed at the top of
  // this tab with when it is due, counted nowhere, never sent to QuickBooks.
  // Its payment email (the same store and amount) makes it a receipt to sort
  // by itself; ✓ Paid does the same by hand -- with Undo -- for a bill paid
  // with no email to say so. Either way it then goes to its job like any
  // other receipt. 💸 Not paid yet, on a receipt in To sort, is the way back
  // the other way: a bill the reader took for a receipt.
  const todayYMD = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  function toPayPatch(r, status) {
    return moved(r, status === TO_PAY ? { status: TO_PAY, paidOn: null } : { status: 'new', paidOn: todayYMD() });
  }
  function setPay(ids, status) {
    const back = [];
    ids.forEach(rid => {
      const r = receipts[rid];
      if (!r || (r.splits || []).length) return;
      back.push([rid, r.status, r.paidOn == null ? null : r.paidOn]);
      const patch = toPayPatch(r, status);
      receipts[rid] = Object.assign({}, r, patch);
      write(rid, Object.assign({}, patch));
    });
    redraw(true);
    return back;
  }
  // Undo: each one as it was, while nothing on it has been sorted since.
  function undoPay(back) {
    back.forEach(([rid, status, paidOn]) => {
      const r = receipts[rid];
      if (!r || (r.splits || []).length) return;
      const patch = moved(r, { status, paidOn });
      receipts[rid] = Object.assign({}, r, patch);
      write(rid, Object.assign({}, patch));
    });
    redraw(true);
  }
  window.rcPaid = function (rid) {
    const r = receipts[rid];
    if (!r || !toPayNow(r)) return;
    if (!sorts()) { showToast('You can look at jobs but not change them'); return; }
    const back = setPay([rid], 'new');
    const say = '✓ ' + (r.vendor || 'Bill') + ' ' + money(r.totalCents) + ' paid — in Receipts to sort now';
    if (typeof showUndo === 'function') showUndo(say, () => undoPay(back), UNDO_MS); else showToast(say);
  };
  // Several at once: the year's pull (old bills, most of them paid long
  // ago), or every bill from one store -- a supplier billed on account, paid
  // by the month.
  async function paidMany(ids, title, why) {
    if (!sorts()) { showToast('You can look at jobs but not change them'); return; }
    if (!ids.length || !(await ydConfirm(why, { title: title, ok: 'They’re paid' }))) return;
    const back = setPay(ids.filter(id => toPayNow(receipts[id])), 'new');
    const say = '✓ ' + back.length + ' bill' + (back.length === 1 ? '' : 's') + ' paid — in Receipts to sort now';
    if (typeof showUndo === 'function') showUndo(say, () => undoPay(back), UNDO_MS); else showToast(say);
  }
  window.rcPaidAll = function () {
    const ids = allReceipts().filter(r => toPayNow(r) && r.pulled).map(r => r.id);
    paidMany(ids, 'Mark all ' + ids.length + ' paid?', 'Each goes to 📥 Earlier this year in Receipts to sort, to put on its job.');
  };
  // The store, as its first real word (receipts.py vendor_key): "The Home
  // Depot" and "Home Depot Pro" are one.
  const storeKey = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter(w => w && ['the', 'a', 'an'].indexOf(w) === -1)[0] || '';
  window.rcPaidStore = function (key) {
    const list = allReceipts().filter(r => toPayNow(r) && !r.pulled && storeKey(r.vendor) === key);
    paidMany(list.map(r => r.id), 'Mark all ' + list.length + ' from ' + ((list[0] || {}).vendor || 'this store') + ' paid?',
      'Each goes to Receipts to sort, to put on its job.');
  };
  window.rcNotPaid = function (rid) {
    const r = receipts[rid];
    if (!r || !toSortNow(r)) return;
    if (!sorts()) { showToast('You can look at jobs but not change them'); return; }
    if ((r.splits || []).length) { showToast('Take its lines back off first (⋯ → Undo)'); return; }
    const back = setPay([rid], TO_PAY);
    const say = '💸 ' + (r.vendor || 'Bill') + ' — under Invoices to pay until it is paid';
    if (typeof showUndo === 'function') showUndo(say, () => undoPay(back), UNDO_MS); else showToast(say);
  };

  // A bill's row: who, how much, when it is due, and what to do with it.
  function payRowHtml(r) {
    const rid = safeId(r.id);
    const st = stageOf(r);
    const due = st.due ? (st.late ? 'Was due ' : 'Due ') + fmtDateMD(st.due) : 'No due date';
    const dueChip = '<span class="stc stc-' + (st.due ? st.tone : 'info') + '">' + esc(due) + '</span>';
    return '<div class="rc-row rc-pay-row" id="rcPay_' + rid + '"><span class="rc-row-main"><b>' + esc(r.vendor || 'Bill') + '</b> ' +
        '<span class="muted">' + (r.orderNo ? '#' + esc(r.orderNo) + ' · ' : '') + fmtDateMD(r.date) + '</span> ' +
        esc(r.summary || '') + (r.whose === 'personal' ? ' <span class="rc-tag">👤 Personal</span>' : '') +
        (tagsOf(r).length ? ' ' + tagChipsHtml(r) : '') + '</span>' +
        dueChip + '<span class="rc-row-amt">' + money(r.totalCents) + '</span>' +
        (r.link ? '<a class="btn btn-sm" href="' + esc(r.link) + '" target="_blank" rel="noopener">Email</a>' : '') +
        (sorts() ? '<button class="btn btn-sm btn-filled" onclick="rcPaid(\'' + rid + '\')">✓ Paid</button>' +
          '<button class="btn btn-sm" onclick="rcNotReceipt(\'' + rid + '\')">🚫 Not a receipt</button>' : '') +
        deleteBtn(rid, true) +
      '</div>';
  }
  // Late first, then by when each is due; the year's pull folded away.
  function payHtml(list) {
    const rank = r => { const st = stageOf(r); return st.late ? 0 : st.due ? 1 : 2; };
    const order = (a, b) => (rank(a) - rank(b)) || String(stageOf(a).due || '').localeCompare(String(stageOf(b).due || '')) ||
      String(a.date || '').localeCompare(String(b.date || ''));
    const now = list.filter(r => !r.pulled).sort(order), old = list.filter(r => r.pulled).sort(order);
    // A store with several bills waiting: all of them paid in one tap.
    const stores = {};
    now.forEach(r => { const k = storeKey(r.vendor); if (k) (stores[k] = stores[k] || []).push(r); });
    const many = Object.keys(stores).filter(k => stores[k].length > 1);
    return now.map(payRowHtml).join('') +
      (many.length && sorts() ? '<div class="rc-pay-stores">' + many.map(k =>
        '<button type="button" class="btn btn-sm" data-store="' + esc(k) + '" onclick="rcPaidStore(this.dataset.store)">✓ All ' +
          stores[k].length + ' from ' + esc(stores[k][0].vendor || k) + ' paid</button>').join('') + '</div>' : '') +
      (now.length ? '<div class="rc-hint">Not receipts until they are paid — counted nowhere, never sent to QuickBooks. ' +
        'Paid: it goes to Receipts to sort by itself when its payment email comes, or tap ✓ Paid.</div>' : '') +
      (old.length ? '<details class="rc-pay-old"' + (now.length ? '' : ' open') + '><summary>📥 ' + old.length +
        ' from earlier this year (the email pull) — most were paid long ago</summary>' +
        (sorts() ? '<button class="btn btn-sm" onclick="rcPaidAll()">✓ All ' + old.length + ' paid — put them in To sort</button>' : '') +
        old.map(payRowHtml).join('') + '</details>' : '');
  }

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
          // Clearly a household's: kept, and filed under Personal by itself.
          + (rep.personal ? ' · ' + rep.personal + ' personal, filed under 👤 Personal' : '')
          // Bills not paid yet, kept apart; mail for nothing, or like what
          // was marked not a receipt, passed over.
          + (rep.toPay ? ' · ' + rep.toPay + ' bill' + (rep.toPay === 1 ? '' : 's') + ' not paid yet, under 💸 Invoices to pay' : '')
          + ((rep.zero || 0) + (rep.learned || 0) ? ' · ' + ((rep.zero || 0) + (rep.learned || 0)) + ' passed over ($0, or like ones marked not a receipt)' : '')
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

  // ------------------------------------------------------------ tags
  //
  // Where a receipt's money went is per line (its splits): one receipt can
  // already be in several places -- some lines on a job, the rest to the
  // shop -- and each line counts once. A TAG is something else (Jonah, 22
  // Oct 2026: "allow multiple tags for receipts"): a label on the whole
  // receipt that moves no money and counts nowhere -- a Menards rebate still
  // to claim, a warranty to keep, something to take back, a question for
  // the accountant, or one of his own. As many as he likes on one receipt,
  // and each a filter under All receipts. Stored on the receipt as `tags`: a
  // starter tag by its id, his own by the words typed, spelt as first typed
  // (the way Supplies keeps its "Used for" tags). A Menards rebate receipt's
  // purchase gets 🎟 Rebate by itself when its email is read (receipts.py
  // _tag_rebate); taken off here, it stays off.
  const RECEIPT_TAGS = [
    { id: 'rebate', icon: '🎟', name: 'Rebate', also: ['rebates', 'menards rebate', 'mail in rebate', 'mail-in rebate'] },
    { id: 'warranty', icon: '🛡', name: 'Warranty', also: ['warranties', 'guarantee'] },
    { id: 'return', icon: '↩', name: 'To return', also: ['return', 'returns', 'take back'] },
    { id: 'accountant', icon: '🧮', name: 'For the accountant', also: ['accountant', 'taxes', 'cpa', 'tax question'] },
  ];
  const TAG_BY_ID = {};
  RECEIPT_TAGS.forEach(t => { TAG_BY_ID[t.id] = t; });
  const TAGS_MAX = 20;        // firestore.rules takes no more on one receipt
  const cleanTag = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 40);
  const tagKey = s => cleanTag(s).toLowerCase();
  function tagsOf(r) {
    return (Array.isArray(r && r.tags) ? r.tags : []).map(cleanTag).filter((t, i, a) => t && a.indexOf(t) === i);
  }
  // His own tags on the receipts loaded, by key, spelt as first seen.
  function ownTags() {
    const out = {};
    Object.values(receipts).forEach(r => tagsOf(r).forEach(t => {
      if (!TAG_BY_ID[t] && !out[tagKey(t)]) out[tagKey(t)] = t;
    }));
    return out;
  }
  // Words typed -> the tag they are: a starter one by its name or a word for
  // it ("rebates"), one of his already in use however it is capitalised, or a
  // new one as typed.
  function tagFor(text) {
    const t = cleanTag(text), k = tagKey(t);
    if (!k) return '';
    const hit = RECEIPT_TAGS.find(x => x.id === k || tagKey(x.name) === k || x.also.indexOf(k) !== -1);
    if (hit) return hit.id;
    return ownTags()[k] || t;
  }
  const tagInfo = t => TAG_BY_ID[t] || { id: t, icon: '🔖', name: t };
  const tagLabel = t => tagInfo(t).icon + ' ' + tagInfo(t).name;
  // What a search finds a receipt by (All receipts, and the app's search).
  const tagNames = r => tagsOf(r).map(t => tagInfo(t).name).join(' ');
  // Every tag to pick from: the starter ones, then his own A to Z.
  const allTags = () => RECEIPT_TAGS.map(t => t.id).concat(Object.values(ownTags()).sort((a, b) => a.localeCompare(b)));

  let tagging = '';           // the receipt whose tags are open ('c' card / 'h' row + its id), kept through a redraw
  const tagTyped = {};        // receipt id -> a tag of his own being typed
  // The chips, where the receipt is shown.
  function tagChipsHtml(r) {
    return tagsOf(r).map(t => '<span class="rc-rtag">' + esc(tagLabel(t)) + '</span>').join('');
  }
  // The button that opens the tags -- for whoever sorts receipts. A row in
  // All receipts has room for the label only.
  function tagBtn(where, rid) {
    if (!sorts()) return '';
    const open = tagging === where + rid;
    return '<button type="button" class="btn btn-sm' + (open ? ' btn-filled' : '') + '" aria-expanded="' + open + '"' +
      (where === 'h' ? ' title="Tags" aria-label="Tags"' : '') +
      ' onclick="rcTags(\'' + where + rid + '\')">' + (where === 'h' ? '🏷' : '🏷 Tags') + '</button>';
  }
  // Open: every tag as a button to tap on or off (on a phone they wrap, all
  // in sight), and a box for one of his own.
  function tagEditHtml(where, rid, r) {
    if (tagging !== where + rid || !sorts()) return '';
    const on = tagsOf(r);
    const list = allTags();
    on.forEach(t => { if (list.indexOf(t) === -1) list.push(t); });
    return '<div class="rc-tagedit">' +
      '<div class="rc-tagpick">' + list.map(t => {
        const isOn = on.indexOf(t) !== -1;
        return '<button type="button" class="rc-dest-chip' + (isOn ? ' on' : '') + '" aria-pressed="' + isOn + '"' +
          ' data-tag="' + esc(t) + '" onclick="rcTagToggle(\'' + rid + '\', this.dataset.tag)">' + esc(tagLabel(t)) + '</button>';
      }).join('') + '</div>' +
      '<div class="rc-assign">' +
        '<input class="rc-why" id="rcTagNew_' + where + rid + '" maxlength="40" autocomplete="off" placeholder="A tag of your own…"' +
          ' value="' + esc(tagTyped[rid] || '') + '" oninput="rcTagTyped(\'' + rid + '\', this.value)"' +
          ' onkeydown="if(event.key===\'Enter\'){event.preventDefault();rcTagAdd(\'' + where + '\',\'' + rid + '\')}">' +
        '<button type="button" class="btn btn-sm" onclick="rcTagAdd(\'' + where + '\',\'' + rid + '\')">Add</button>' +
        '<button type="button" class="btn btn-sm btn-filled" onclick="rcTags(\'\')">Done</button>' +
      '</div>' +
      '<div class="rc-hint">Tap to put a tag on or take it off — as many as you like. Tags move no money; ' +
        'each one is a filter under All receipts.</div>' +
    '</div>';
  }
  window.rcTags = function (key) {
    tagging = key && key !== tagging ? key : '';
    redraw(true);
  };
  window.rcTagTyped = function (rid, text) { tagTyped[rid] = text; };
  function setTags(rid, r, next) {
    if (next.length > TAGS_MAX) { showToast('That’s ' + TAGS_MAX + ' tags on one receipt — take one off first'); return false; }
    const tags = next.length ? next : null;
    receipts[rid] = Object.assign({}, r, { tags });
    write(rid, { tags });
    redraw(true);
    return true;
  }
  window.rcTagToggle = function (rid, t) {
    const r = receipts[rid];
    if (!r || !sorts() || !t) return;
    const have = tagsOf(r);
    setTags(rid, r, have.indexOf(t) !== -1 ? have.filter(x => x !== t) : have.concat([t]));
  };
  window.rcTagAdd = function (where, rid) {
    const r = receipts[rid];
    if (!r || !sorts()) return;
    const t = tagFor(tagTyped[rid] || '');
    const box = () => el('rcTagNew_' + where + rid);
    if (!t) { if (box()) box().focus(); return; }
    const have = tagsOf(r);
    delete tagTyped[rid];
    if (have.indexOf(t) === -1 && !setTags(rid, r, have.concat([t]))) { tagTyped[rid] = t; return; }
    if (have.indexOf(t) !== -1) { showToast(tagLabel(t) + ' is on it already'); redraw(true); }
    // Ready for the next one.
    if (box()) box().focus();
  };

  // ------------------------------------------------- a note on it
  //
  // Jonah, 28 Oct 2026: "i want to be able to add a note on a receipt for
  // you to view". receipts/{id}.note {text, at, by, name}: shown with the
  // receipt to whoever sees it, read by Claude when the receipt is read
  // again (functions/receipts.py NOTE_HEAD) and by the Claude chats that
  // work on his books. One note a receipt; changed or taken off any time.
  let noting = '';            // the receipt whose note box is open ('c' card / 'h' row + its id)
  const noteTyped = {};       // receipt id -> what is being typed, kept through a redraw
  const noteOf = r => String((r && r.note && r.note.text) || '').trim();
  function noteHtml(r, where) {
    const t = noteOf(r);
    if (!t || noting === where + safeId(r.id)) return '';
    const n = r.note || {};
    const by = [String(n.name || '').split(/[ @]/)[0], n.at ? fmtDateMD(String(n.at).slice(0, 10)) : ''].filter(Boolean).join(', ');
    return '<div class="rc-mynote">📝 ' + esc(t) + (by ? ' <span class="muted">— ' + esc(by) + '</span>' : '') + '</div>';
  }
  function noteBtn(where, rid, r) {
    if (!sorts()) return '';
    const open = noting === where + rid, has = !!noteOf(r);
    const words = has ? 'Note' : 'Add a note';
    return '<button type="button" class="btn btn-sm' + (open ? ' btn-filled' : '') + '" aria-expanded="' + open + '"' +
      (where === 'h' ? ' title="' + words + '" aria-label="' + words + '"' : '') +
      ' onclick="rcNote(\'' + where + rid + '\')">' + (where === 'h' ? '📝' : '📝 ' + words) + '</button>';
  }
  function noteEditHtml(where, rid, r) {
    if (noting !== where + rid || !sorts()) return '';
    const text = noteTyped[rid] != null ? noteTyped[rid] : noteOf(r);
    return '<div class="rc-tagedit rc-noteedit">' +
      '<textarea class="rc-note-box" id="rcNote_' + where + rid + '" rows="3" maxlength="2000"' +
        ' placeholder="Anything about this receipt — what it is, what was read wrong, where it goes…"' +
        ' oninput="rcNoteTyped(\'' + rid + '\', this.value)">' + esc(text) + '</textarea>' +
      '<div class="rc-assign">' +
        '<button type="button" class="btn btn-sm btn-filled" onclick="rcNoteSave(\'' + where + '\',\'' + rid + '\')">Save the note</button>' +
        (noteOf(r) ? '<button type="button" class="btn btn-sm" onclick="rcNoteSave(\'' + where + '\',\'' + rid + '\', true)">Take it off</button>' : '') +
        '<button type="button" class="btn btn-sm" onclick="rcNote(\'\')">Cancel</button>' +
      '</div>' +
      '<div class="rc-hint">Claude reads it: when the receipt is read again (⋯ → 📖 Read it again), and when it works on your books.</div>' +
    '</div>';
  }
  window.rcNote = function (key) {
    const was = noting;
    noting = key && key !== noting ? key : '';
    if (was && was !== noting) delete noteTyped[was.slice(1)];
    redraw(true);
    if (noting) {
      const box = el('rcNote_' + noting);
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }
  };
  window.rcNoteTyped = function (rid, text) { noteTyped[rid] = text; };
  window.rcNoteSave = function (where, rid, off) {
    const r = receipts[rid];
    if (!r || !sorts()) return;
    const box = el('rcNote_' + where + rid);
    const text = off ? '' : String(noteTyped[rid] != null ? noteTyped[rid] : (box ? box.value : '')).trim().slice(0, 2000);
    const u = me() || {};
    const note = text ? { text, at: new Date().toISOString(), by: u.uid || '', name: u.displayName || u.email || '' } : null;
    if (!text && !noteOf(r)) { rcNote(''); return; }
    receipts[rid] = Object.assign({}, r, { note });
    delete noteTyped[rid];
    noting = '';
    write(rid, { note });
    showToast(text ? '📝 Note saved' : 'Note taken off');
    redraw(true);
  };

  // ------------------------------------------------- what was done with it
  //
  // Where a receipt went shows as a small chip ("✓ Added to the Smith job");
  // taking it back sits behind ⋯ -- or a tap on the chip, which opens the
  // same menu. A green bar with its own Undo on every sorted receipt doubled
  // the height of All receipts. Undo is there for as long as it ever was; it
  // is only out of the way. Delete was behind ⋯ too (a 🗑 on every row was
  // one slip of the thumb from gone), and Jonah could not find it: it is a
  // button of its own again, and a slip now has its Undo (dropSoon).
  //
  // `where` tells a card in To sort ('c') from a row in All receipts ('h'):
  // the same receipt can be in both.
  let menuOpen = '';          // the ⋯ menu that is open, kept through a redraw
  function menuItems(rid, r, where) {
    const items = [];
    if (sorts()) {
      (r.splits || []).forEach(s => items.push('<button type="button" ' +
        'onclick="rcMenuClose(); rcUndo(\'' + rid + '\',\'' + safeId(s.id) + '\')">↩ Undo — take it off ' +
        esc(splitPlace(s)) + '</button>'));
      // Read wrong (Jonah, 26 Oct 2026: a tailgate handle set read as "two
      // handles"): read its email once more by today's rules. Only while
      // nothing on it is sorted -- functions/receipts.py read_again.
      if (!(r.splits || []).length && (r.mail || []).length && stageOf(r).id === 'tosort') {
        items.push('<button type="button" onclick="rcMenuClose(); rcReadAgain(\'' + rid + '\')">📖 Read it again</button>');
      }
      // A bill the reader took for a receipt (its own button when it says
      // Owed, cardHtml): to Invoices to pay until it is paid.
      if (!(r.splits || []).length && stageOf(r).id === 'tosort' && !owedOf(r)) {
        items.push('<button type="button" onclick="rcMenuClose(); rcNotPaid(\'' + rid + '\')">💸 Not paid yet — to Invoices to pay</button>');
      }
      // In All receipts (a card in To sort has the button itself).
      if (where === 'h' && markable(r)) {
        items.push('<button type="button" onclick="rcMenuClose(); rcNotReceipt(\'' + rid + '\')">🚫 Not a receipt</button>');
      }
    }
    return items;
  }
  let readingAgain = '';      // the receipt being read again, one at a time
  window.rcReadAgain = async function (rid) {
    if (!sorts() || !window.YDClaude || readingAgain) return;
    readingAgain = rid;
    showToast('Reading the email again…', 30000);
    try {
      const out = await window.YDClaude.post('/receipts/read-again', { id: rid });
      showToast('📖 Read again' + (out && out.summary ? ': ' + String(out.summary).slice(0, 120) : ''), 6000);
    } catch (e) {
      showToast(String((e && e.message) || e).slice(0, 160), 7000);
    } finally {
      readingAgain = '';
    }
  };
  // The owner's alone (rules). `small`: a row in All receipts, where it is
  // the bin and nothing more.
  function deleteBtn(rid, small) {
    return owner() ? '<button type="button" class="btn btn-sm rc-del"' +
      (small ? ' title="Delete this receipt" aria-label="Delete this receipt"' : '') +
      ' onclick="rcDelete(\'' + rid + '\')">' + (small ? '🗑' : '🗑 Delete') + '</button>' : '';
  }
  function menuHtml(where, rid, r) {
    const items = menuItems(rid, r, where);
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
    const opens = menuItems(rid, r, where).length > 0;
    return '<span class="rc-chips">' + list.map(s => {
      const n = (s.lines || []).length, amt = money((s.cents || 0) + (s.taxCents || 0));
      const title = (n ? n + ' line' + (n === 1 ? '' : 's') + (s.taxCents ? ' + tax' : '') + ', ' : '') + amt +
        (opens ? ' — tap for Undo' : '');
      // Put there by itself, from a photo sent in for it (autoSort). In All
      // receipts the row's status chip carries the tick (✓ Filed); a card
      // still to sort ticks each part already filed.
      // A subcontractor's bill also says whose property it was for (subs.js).
      const forWho = destOf(s) === 'sub' && window.YDSubs && YDSubs.clientOf ? YDSubs.clientOf(r.id ? r : Object.assign({ id: rid }, r)) : '';
      const inner = (where === 'c' ? '✓ ' : '') + splitWhere(s) + (forWho ? ' <span class="rc-chip-auto">' + esc(forWho) + '</span>' : '') +
        (s.auto ? ' <span class="rc-chip-auto">by itself</span>' : '') + (list.length > 1 ? ' <span class="rc-chip-amt">' + amt + '</span>' : '');
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
    const owed = owedOf(r);
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
        (r.orderNo ? '<span class="rc-tag">#' + esc(r.orderNo) + '</span>' : '') + joinedHtml(r) +
        '<span class="rc-tag">' + fmtDateMD(r.date) + '</span>' +
        (owed ? '<span class="rc-tag rc-owed">Owed</span>' : '') + tagChipsHtml(r) +
        '<span class="rc-total">' + money(r.totalCents) + '</span>' +
      '</div>' +
      '<div class="rc-sum">' + summary +
        '<span class="muted">' + (summary ? '· ' : '') + esc(KIND[r.kind] || 'Other') + '</span></div>' +
      noteHtml(r, 'c') +
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
        tagBtn('c', rid) + noteBtn('c', rid, r) + notBtns(rid, r, owed) + deleteBtn(rid) + menuHtml('c', rid, r) +
      '</div>' +
      tagEditHtml('c', rid, r) + noteEditHtml('c', rid, r) +
      qbHtml(r, rid) +
    '</div>';
  }

  // The invoice of an order, joined to the order's receipt by the email
  // reader rather than made a second one (functions/receipts.py
  // _same_order): its number, and what it came to when that differs (a card
  // fee added on the invoice).
  function joinedHtml(r, plain) {
    return (r.joined || []).filter(j => j && j.no).map(j => {
      const more = j.totalCents && j.totalCents !== r.totalCents ? ' ' + money(j.totalCents) : '';
      const title = 'Same purchase: ' + (j.docType === 'receipt' ? 'receipt' : 'invoice') + ' #' + j.no + more +
        ' — joined to this one so it is counted once';
      return plain ? ' + #' + esc(j.no) + more
        : '<span class="rc-tag" title="' + esc(title) + '">+ #' + esc(j.no) + more + '</span>';
    }).join('');
  }

  // An invoice still owed, read before bills had a place of their own (or
  // one the reader took for a receipt) -- not once Paid was tapped on it.
  const owedOf = r => !!r && r.paid === false && r.docType === 'invoice' && !r.paidOn;
  // 🚫 Not a receipt on every card with nothing put anywhere yet, and 💸 Not
  // paid yet beside it on one that says Owed.
  function notBtns(rid, r, owed) {
    if (!sorts() || !markable(r)) return '';
    return (owed ? '<button type="button" class="btn btn-sm" onclick="rcNotPaid(\'' + rid + '\')">💸 Not paid yet</button>' : '') +
      '<button type="button" class="btn btn-sm" onclick="rcNotReceipt(\'' + rid + '\')">🚫 Not a receipt</button>';
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
          jobs.filter(j => !j.dead || j.id === pick || (r.suggest && r.suggest.jobId === j.id)).map(j => '<option value="' + safeId(j.id) + '"' + (j.id === pick ? ' selected' : '') + '>' +
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
      return '<div class="rc-assign">' + btn('Mark ' + (n || ((r.splits || []).length ? 'the rest ' : '')) + 'personal') + '</div>' +
        '<div class="rc-hint">Kept under All receipts → 👤 Personal. Never counted as a business cost or sent to QuickBooks.</div>';
    }
    if (to === 'loan') {
      return '<div class="rc-assign">' + btn('Add ' + n + 'to loan payments') + '</div>' +
        '<div class="rc-hint">Counted under All receipts → 🏦 Loans, by the lender’s name. Never sent to QuickBooks as an ' +
        'expense: most of a loan payment pays back what was borrowed, which isn’t a cost.</div>';
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
  // Kept from QuickBooks: filed only where it must not go as an expense
  // (Personal, a loan payment: stages.js noQb), or read as a loan payment
  // and not sorted yet -- the server holds those back too (receipts.py
  // _not_for_qb; keep the two the same).
  function notForQb(r) {
    const st = stageOf(r);
    // A bill still to pay, or not a receipt at all: never.
    if (st.noQb || st.offBooks || st.id === 'topay' || st.id === 'notreceipt') return true;
    return r.kind === 'loan_payment' && st.id === 'tosort' && !(r.splits || []).length;
  }
  function qbHtml(r, rid, compact) {
    const f = r.qbForward || null;
    // Filed as Personal or a loan payment and never sent: it is not meant
    // to go, so it is not "not in QuickBooks yet" either -- only its photo
    // is offered.
    if (!(f && f.ok) && notForQb(r)) {
      return r.photoPath && !compact ? '<div class="rc-qb"><button class="btn btn-sm" onclick="rcViewPhoto(\'' + rid + '\')">🖼 Photo</button></div>' : '';
    }
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
  // from email (not a photo), not sent yet, not set aside, not filed only
  // as Personal or a loan payment (notForQb), with an email from after
  // reading started and inside the 14 days.
  const FWD_DAYS = 14;
  let fwdBusy = false;
  function emailsToSend() {
    const start = Date.parse((state && state.since) || '');
    if (isNaN(start)) return [];
    const floor = Math.max(start, Date.now() - FWD_DAYS * 864e5);
    return allReceipts().filter(r => !r.photoPath && r.source !== 'photo' && !isAside(r) && !notForQb(r) &&
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
    const st = stageOf(r);
    const aside = st.id === 'aside', legacy = st.legacy || '';
    const legacyName = legacy === 'sub' ? ((subMatch(r) || {}).name || 'Subcontractor') : WHY[r.skipWhy];
    // Its one status, first: To sort (part filed, when some lines are),
    // Filed -- with when and by whom -- or Set aside. An old receipt set
    // aside "as overhead" before the shop was a place says the shop here.
    const where = window.YDStages.chip(st, {
      detail: legacy ? (DEST.find(d => d[0] === legacy) || ['', ''])[1].split(' ')[0] + ' ' + (legacyName || DEST_NAME[legacy])
        : st.id === 'tosort' && st.part ? 'part filed' : '' });
    const why = aside ? asideText(r) : '';
    const notOne = st.id === 'notreceipt';
    // Where it went sits in the row as a chip or two, not a bar under it.
    return '<div class="rc-row"><span class="rc-row-main"><b>' + esc(r.vendor || 'Receipt') + '</b> ' +
        '<span class="muted">' + fmtDateMD(r.date) + (r.orderNo ? ' · #' + esc(r.orderNo) : '') + joinedHtml(r, true) + '</span> ' +
        esc(r.summary || '') + (tagsOf(r).length ? ' ' + tagChipsHtml(r) : '') + '</span>' +
        where + chipsHtml('h', rid, r) + qbHtml(r, rid, true) +
        '<span class="rc-row-amt">' + money(r.totalCents) + '</span>' +
        (r.link ? '<a class="btn btn-sm" href="' + esc(r.link) + '" target="_blank" rel="noopener">Email</a>' : '') +
        (aside && sorts() ? '<button class="btn btn-sm" onclick="rcAsideWhy(\'' + rid + '\')" title="Change the note">✎ Why</button>' : '') +
        ((r.status === 'skipped' || notOne) && sorts() ? '<button class="btn btn-sm" onclick="rcPutBack(\'' + rid + '\')">Put back</button>' : '') +
        tagBtn('h', rid) + noteBtn('h', rid, r) + menuHtml('h', rid, r) + deleteBtn(rid, true) +
      '</div>' +
      noteHtml(r, 'h') +
      (aside ? '<div class="rc-aside-why">' + (why ? 'Why: ' + esc(why) : '<span class="muted">No note for why</span>') + '</div>' : '') +
      // What the mark taught the email reader (rcNotReceipt).
      (notOne ? '<div class="rc-aside-why">' + (r.notReceipt && r.notReceipt.skip ? 'Mail like it is passed over unread.'
        : r.notReceipt && (r.notReceipt.keys || []).length ? 'Shown to Claude as an example — other receipts look like it, so none is passed over by itself.'
        : 'No email to learn from.') + ' Put back undoes it.</div>' : '') +
      tagEditHtml('h', rid, r) + noteEditHtml('h', rid, r);
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
  // Every receipt on the screen: not one deleted a moment ago, while its
  // Undo is showing.
  function allReceipts() {
    return Object.keys(receipts).filter(id => !leaving[id]).map(id => Object.assign({ id }, receipts[id]));
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
    const sec = el('rcSection'), hist = el('rcHistorySection'), tab = el('tabReceipts'), pay = el('rcPaySection');
    if (!sec) return;
    const on = !!(window.YDAuth && window.YDAuth.mode === 'cloud' && window.YDAuth.user) && sees();
    sec.hidden = hist.hidden = !on;
    if (tab) tab.hidden = !on;
    if (!on) { badges(0); if (pay) pay.hidden = true; return; }

    const all = allReceipts();
    // Bills to pay, above the receipts -- only when there are any.
    const bills = all.filter(toPayNow);
    if (pay) {
      pay.hidden = !loaded || !bills.length;
      const late = bills.filter(r => !r.pulled && stageOf(r).late).length, fresh = bills.filter(r => !r.pulled).length;
      el('rcPayBadge').textContent = fresh ? fresh + (late ? ' · ' + late + ' late' : '') : '';
      el('rcPayList').innerHTML = bills.length ? payHtml(bills) : '';
    }
    // The ones waiting on a person first: a photo that could not go on its
    // job by itself says why at the top of the list.
    const open = all.filter(newToSort).sort((a, b) => (needsYou(b) - needsYou(a)) || byNewest(a, b));
    const old = all.filter(r => toSortNow(r) && r.pulled).sort(byNewest);
    const jobs = jobsList();
    badges(open.length);

    el('rcBadge').textContent = open.length ? open.length + ' to sort' : '';
    el('rcBar').innerHTML =
      (sorts() ? '<button class="btn btn-sm" onclick="rcCheckNow()"' + (checking ? ' disabled' : '') + '>' +
        (checking ? 'Checking email…' : '📧 Check email now') + '</button>' : '') + stateHtml() + qbAddressHtml();
    el('rcList').innerHTML = !loaded ? '<p class="empty-msg">Loading receipts…</p>'
      : (open.length ? open.map(r => cardHtml(r, jobs)).join('')
        : '<p class="empty-msg">Nothing ' + (old.length ? 'new ' : '') + 'to sort. Receipts that arrive by email show up here by themselves.</p>') +
        pulledHtml(old, jobs) +
        '<datalist id="rcWhyIdeas">' + WHY_IDEAS.map(w => '<option value="' + esc(w) + '">').join('') + '</datalist>';
    renderHistory();
  }

  // The year's pull (Jonah, 26 Oct 2026: "pull all receipts from email for
  // this year"; functions/receipts.py marks what it saves `pulled`): bought
  // before Job Hub read his email, so kept under the new mail, folded, a
  // page at a time -- a year of old receipts must not bury this week's, nor
  // the count on the tab.
  function pulledHtml(old, jobs) {
    const p = (state && state.pull) || null;
    const going = !!(p && p.cursor && !p.doneAt);
    if (!old.length && !going) return '';
    const upto = going ? new Date(p.cursor * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    const n = Math.min(old.length, pullShown);
    return '<div class="rc-pull"><div class="rc-pull-head"><b>📥 Earlier this year</b> — ' +
        (old.length ? old.length + ' to sort' : 'none to sort yet') +
        (going ? ' <span class="muted">· still reading your email: up to ' + esc(upto) + ' so far</span>' : '') + '</div>' +
      '<p class="hint">Bought before Job Hub started reading your email (5 Oct). Put each on its job as usual: its lines go on ' +
        'the job, Materials to Order is ticked with what was paid, and any price that differs from Supplies goes to ' +
        'Supplies → Prices to check. None of these goes to QuickBooks — they are in it already.</p>' +
      old.slice(0, n).map(r => cardHtml(r, jobs)).join('') +
      (n < old.length ? '<button class="btn btn-sm" onclick="rcPullMore()">' +
        (n ? 'Show ' + Math.min(PULL_PAGE, old.length - n) + ' more' : 'Show them, ' + PULL_PAGE + ' at a time') + '</button>' : '') +
      (n ? ' <button class="link-btn" onclick="rcPullFold()">Fold them away</button>' : '') + '</div>';
  }
  window.rcPullMore = function () { pullShown += PULL_PAGE; redraw(true); };
  window.rcPullFold = function () { pullShown = 0; redraw(true); };

  // ------------------------------------------------------------ All receipts

  // Set aside is only ever found here, under its own filter (Jonah, 13 Oct
  // 2026: set-aside receipts "shouldnt exist" in the rest of the screen):
  // All leaves out what was set aside and put nowhere. Personal has its own
  // filter too, and All -- what the business spent -- leaves out a receipt
  // that went only there.
  const VIEWS = PLACE_LIST.reduce((o, p) => (o[p.id] = p.view, o), { all: 'All' });
  VIEWS.skipped = '🗄 Set aside';
  // Marked Not a receipt: only ever here, under its own filter, to put back.
  VIEWS.notreceipt = '🚫 Not receipts';
  let view = 'all';
  // The places the books count (month totals), and what each is called there.
  const PLACES = PLACE_LIST.map(p => p.id).filter(id => !offBooks(id));
  const OFF_BOOKS = PLACE_LIST.map(p => p.id).filter(offBooks);
  const PLACE_NAME = PLACE_LIST.reduce((o, p) => (o[p.id] = p.total, o), {});
  // What a receipt put to one place, tax share included. A receipt set aside
  // as overhead (before 9 Oct), as a subcontractor's bill (before 13 Oct) or
  // as personal (before 21 Oct) counts its unsorted rest as the shop's, the
  // subcontractor's or Personal's.
  function amountTo(r, to) {
    const splits = r.splits || [];
    let c = splits.filter(s => destOf(s) === to).reduce((t, s) => t + (s.cents || 0) + (s.taxCents || 0), 0);
    if (legacyPlace(r) === to) {
      c += Math.max(0, (r.totalCents || 0) - splits.reduce((t, s) => t + (s.cents || 0) + (s.taxCents || 0), 0));
    }
    return c;
  }
  const placed = r => PLACES.reduce((t, p) => t + amountTo(r, p), 0);
  // What a filed receipt cost the business: all of it, but for what went
  // to Personal; set aside, only what was put somewhere first.
  const business = r => isAside(r) ? placed(r)
    : Math.max(0, (r.totalCents || 0) - OFF_BOOKS.reduce((t, p) => t + amountTo(r, p), 0));
  const inAll = r => isAside(r) ? placed(r) > 0 : !notReceiptNow(r) && !stageOf(r).offBooks;
  // A place's own filter: every receipt with something there, whatever it
  // came to (a $0 line still went there).
  const goesTo = (r, p) => stageOf(r).places.indexOf(p) !== -1;
  // A tag's filter ('tag:' + the tag): every receipt carrying it, wherever
  // it went -- one still to sort too, set aside or Personal.
  const viewTag = () => view.indexOf('tag:') === 0 ? view.slice(4) : '';
  const inView = r => viewTag() ? tagsOf(r).indexOf(viewTag()) !== -1
    : view === 'all' ? inAll(r) : view === 'skipped' ? isAside(r) : view === 'notreceipt' ? notReceiptNow(r) : goesTo(r, view);
  window.rcView = function (v) { if (VIEWS[v]) { view = v; renderHistory(); } };
  window.rcViewTag = function (t) { const tag = cleanTag(t); if (tag) { view = 'tag:' + tag; renderHistory(); } };
  // Typing in the search box redraws only the list under it, so the box keeps
  // its focus and what was typed.
  window.rcSearchNow = function () { renderHistory(); };

  function matches(r, words) {
    if (!words.length) return true;
    const hay = [r.vendor, r.orderNo, r.summary, r.date,
      (r.lines || []).map(l => l.name + ' ' + (l.itemNo || '')).join(' '),
      (r.splits || []).map(x => (x.jobName || x.name || '') + ' ' + (x.est || '') + ' ' + DEST_NAME[destOf(x)]).join(' '),
      tagNames(r), isAside(r) ? 'set aside ' + asideText(r) : '', notReceiptNow(r) ? 'not a receipt' : ''].join(' ').toLowerCase();
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
    // Bills still to pay have their own list above (payHtml).
    const every = allReceipts().filter(r => !toSortNow(r) && !toPayNow(r));
    // A tag's filter looks at the ones still to sort as well.
    const shown = (viewTag() ? allReceipts() : every).filter(r => inView(r) && matches(r, words)).sort(byNewest);
    const aside = every.filter(deletableAside);
    // Counted as sorted: what the business put somewhere -- not what was set
    // aside, nor what went only to Personal.
    const counted = every.filter(inAll).length;
    el('rcHistBadge').textContent = counted ? String(counted) : '';
    // The tags on any receipt here, each a filter of its own on a line under
    // the places (the one being looked at stays, even with none left).
    const inUse = Object.create(null);
    allReceipts().forEach(r => tagsOf(r).forEach(t => { inUse[t] = (inUse[t] || 0) + 1; }));
    if (viewTag() && !inUse[viewTag()]) inUse[viewTag()] = 0;
    const tagOrder = allTags().filter(t => t in inUse).concat(Object.keys(inUse).filter(t => allTags().indexOf(t) === -1));
    el('rcHistBar').innerHTML = Object.keys(VIEWS).map(v =>
      '<button class="btn btn-sm' + (view === v ? ' btn-filled' : '') + '" onclick="rcView(\'' + v + '\')">' +
      VIEWS[v] + '</button>').join('') +
      (view === 'skipped' && aside.length && owner()
        ? '<button class="btn btn-sm rc-del" onclick="rcDeleteAside()">🗑 Delete all ' + aside.length + ' set aside</button>' : '') +
      (tagOrder.length ? '<div class="rc-tagbar"><span class="muted">Tags:</span>' + tagOrder.map(t =>
        '<button class="btn btn-sm' + (viewTag() === t ? ' btn-filled' : '') + '" data-tag="' + esc(t) + '"' +
        ' onclick="rcViewTag(this.dataset.tag)">' + esc(tagLabel(t)) + ' <span class="rc-tagn">' + inUse[t] + '</span></button>').join('') +
        '</div>' : '');

    if (!shown.length) {
      wrap.innerHTML = '<p class="empty-msg">' + (words.length ? 'Nothing matches.' : 'Nothing here yet.') + '</p>' + olderHtml;
      return;
    }
    // By month, newest first, each with what it came to -- and, under All,
    // what of it went where (for the books: jobs, vehicles, shop, office,
    // property, subcontractors). What was set aside counts in none of them,
    // nor in All's month total; nor does what went to Personal, whose own
    // filter adds up only that.
    const months = [];
    shown.slice(0, 300).forEach(r => {
      const key = String(r.date || '').slice(0, 7);
      let m = months[months.length - 1];
      if (!m || m.key !== key) { m = { key, rows: [], cents: 0, by: {} }; months.push(m); }
      m.rows.push(r);
      // A tag is on the whole receipt: its whole total.
      m.cents += view === 'skipped' || view === 'notreceipt' || viewTag() ? (r.totalCents || 0)
        : view === 'all' ? business(r) : amountTo(r, view);
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
  // it until they move on. The same for a tag or a note being typed on a row
  // of All receipts.
  function choosing() {
    const a = document.activeElement, sec = el('rcSection'), hist = el('rcHistory');
    if (!a || a === document.body) return false;
    return !!((sec && sec.contains(a)) || (hist && hist.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')));
  }
  function redraw(force) {
    const p = el('panel-receipts');
    if (!p || !p.classList.contains('active')) {
      // Off screen, only the counts on the tab and on More need to be right.
      deferred = true;
      badges(allReceipts().filter(newToSort).length);
      return;
    }
    if (!force && choosing()) {
      deferred = true;
      return;
    }
    deferred = false;
    render();
  }
  document.addEventListener('focusout', () => {
    if (deferred) setTimeout(() => { if (!choosing()) redraw(); }, 0);
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
    forgetLeaving();
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
    all: () => {
      if (!Object.keys(leaving).length) return receipts;
      const out = {};
      Object.keys(receipts).forEach(id => { if (!leaving[id]) out[id] = receipts[id]; });
      return out;
    },
    // A photo that could not go where it was sent by itself (home.js).
    needsYou: needsYou,
    // Bills not paid yet (Invoices to pay), for Home.
    toPay: () => allReceipts().filter(toPayNow),
    // A receipt's tags by name, for the app's search (search.js).
    tagNames: tagNames,
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
    if (!list.length && sees()) list = jobsList().filter(j => j.status !== 'quoting' && !j.dead)
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
    if (r.what === 'to pay') return what + ' — matched a bill not paid yet (Receipts → Invoices to pay)';
    if (r.what === 'not a receipt') return what + ' — matched one marked not a receipt';
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
