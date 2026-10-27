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
//     work:      [{id, title, scope, kind: crew|flat|amount|allin, crewDays, profit,
//                  priceId, qty, unit, rateCents, amountCents, qbItem,
//                  allInCents, addCents (allin: his price WITH the materials
//                  marked as in it, and labour added outside it),
//                  crewNote (the crew's page only)}],
//     materials: [{id, supplyId, name, qty, unit, plant, tree, costCents,
//                  category, delivery: auto (his rules: pricing.js wayOf) |
//                  delivered|pickup|rides (set by hand on the line),
//                  forWork (a work id, 'none', or unset = worked out),
//                  allInOf (the allin work line whose price covers it),
//                  handPicked (its Supplies item picked by him on the line:
//                  Claude's answers keep it)}],
//     spoilCuYd (soil, rock, debris), brushCuYd (brush only), fuel: {miles, jobDays, bobcatDays, gasCents, dieselCents},
//     deliveryTown, off: {delivery, fuel, dumpsters, planting, markers}, memo,
//     ways: 'rules' (priced by his delivered-or-picked-up rules from the
//     start; one sent before them has none and keeps its trucks) }
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
  let qbAsking = false;       // the checks before a send are waiting on QuickBooks
  const queued = [];          // jobs waiting for Claude to start their estimate
  let loads = 0;              // how many times the form has been loaded with a job (or emptied)
  let notesTyped = false;     // the site notes were written or changed since the job was opened
  const checkedAt = {};       // job id -> when its QuickBooks status was last asked for
  const trippedFor = {};      // job id -> the address the miles were last looked up for
  let draftMsg = '';          // what is typed in the chat box, not sent yet
  let undo = null;            // the estimate before Claude's last change
  let qbItems = null;         // QuickBooks product names, fetched when first wanted
  let stale = false;          // Supplies or the rules changed while the Job tab was hidden (repaint)
  // How much of the estimate is out (15 Oct 2026: it ran to four and a half
  // screens): a bid with nothing built yet is its notes and the Build button
  // until "or add lines by hand"; an estimate the customer has said yes to
  // folds to one line and what is left to do (the invoice) until "Show /
  // edit" opens it. Kept in memory only -- every job opens the same way.
  let byHand = false;         // "or add lines by hand" pressed on the job open (load() resets it)
  const unfolded = {};        // job id -> its accepted estimate opened out

  // The conversation kept with the job (Jonah can scroll back through it),
  // and the part of it Claude is sent with each message (ask).
  const CHAT_KEEP = 60;
  const CHAT_SEND = 30;
  // A message about the photos ("look at the pics of the back yard"): the
  // site-visit photos go with it (ask).
  const PHOTO_WORDS = /\b(photos?|pics?|pictures?|images?|snaps?|snapshots?)\b/i;
  // The photos he names by their number on the job (jobphotos.js): "photo 7",
  // "photos 3 and 5", "pics 2-4", "picture #12". Only after a photo word, so
  // "make it 18x20" or "estimate #1673" are never photos.
  function photoNumsIn(text) {
    const out = new Set();
    const re = /\b(?:photos?|pics?|pictures?|images?|snaps?)\s*((?:#?\s*\d+\s*(?:,|&|and|-|–|to|through|thru)?\s*)+)/gi;
    let m;
    while ((m = re.exec(String(text || '')))) {
      m[1].replace(/(\d+)\s*(?:-|–|to|through|thru)\s*#?\s*(\d+)/gi, (all, a, b) => {
        for (let i = +a; i <= Math.min(+b, +a + 30); i++) out.add(i);
        return ' ';
      }).replace(/\d+/g, n => { out.add(+n); return ' '; });
    }
    return [...out].filter(n => n >= 1 && n <= 9999).sort((a, b) => a - b).slice(0, 40);
  }
  // Each version put in QuickBooks, as it went: when, the total, each line's
  // amount, whether it was emailed -- so a customer ringing about "the
  // estimate you sent" can be answered from the job.
  const SENT_KEEP = 10;
  function blank() {
    // payments: this estimate's own schedule ([{label, how: pct|amount|rest,
    // value}]), or null for the usual (pricing.js payments).
    // snow: a snow bid's price sheet (cleanSnow); snowBid, when set by hand,
    // says whether it is one (left out = from the services, snowOf).
    return { v: 2, notes: '', chat: [], questions: [], flags: [], work: [], materials: [],
             spoilCuYd: null, brushCuYd: null, fuel: {}, deliveryTown: '', off: {}, memo: '', sent: [], site: null, payments: null,
             snow: null, ways: 'rules' };
  }
  function cleanPlan(list) {
    if (!Array.isArray(list) || !list.length) return null;
    return list.slice(0, 8).map((s, i, a) => ({
      label: String((s && s.label) || '').slice(0, 60),
      how: i === a.length - 1 ? 'rest' : (s && s.how === 'amount' ? 'amount' : 'pct'),
      value: i === a.length - 1 ? null : num(s && s.value),
    }));
  }
  const clone = o => JSON.parse(JSON.stringify(o));

  // ------------------------------------------------------------- the money

  function catalog() {
    const c = window.YDSupplies && window.YDSupplies.catalog ? window.YDSupplies.catalog() : null;
    return c || { items: {}, prices: {}, vendors: {}, pricesReady: false };
  }
  // city: the job's town for the delivery rate -- the form's, unless a job
  // that is not open is being priced. e/jobId: for an estimate accepted in
  // QuickBooks, whose lines carry no crew-days, the job's own days -- what
  // its fuel is counted over (pricing.js fuel).
  function ctx(city, e, jobId) {
    const c = catalog();
    return { rules: P().rules(), items: c.items, prices: c.prices, vendors: c.vendors || {}, fuel: P().fuelPrices(), book: book,
             city: city != null ? String(city).trim() : (el('city') && el('city').value || '').trim(),
             jobDays: e && jobId && P().asAccepted(e) ? jobDaysOf(jobId) : null };
  }
  // A job's days: each day someone was clocked in on it, and each day still
  // ahead on the Job schedule -- a drive from the shop and back for each
  // (Jonah, 21 Oct 2026). null when there are none yet.
  function jobDaysOf(jobId) {
    const days = new Set();
    try {
      if (window.YDClock && YDClock.jobShifts) YDClock.jobShifts(jobId).forEach(s => { if (s.day) days.add(s.day); });
      if (window.YDCalendar && YDCalendar.forJob) (YDCalendar.forJob(jobId, 180) || []).forEach(o => { if (o.jobDay && o.day) days.add(o.day); });
    } catch (err) { /* the clock or the calendar not started yet: counted on the next pricing */ }
    return days.size || null;
  }
  let last = null;            // the last worked-out price, for the totals and QuickBooks
  let priceRuns = 0;          // how many times it has been worked out (changed() compares)
  let reuseLast = false;      // changed(false) is drawing the totals from the price it has just worked out
  function priced() {
    if (reuseLast && last) return last;
    // The map point belongs to the address it was found for; a changed
    // address leaves it behind (the next miles lookup finds the new one).
    if (est.site && est.site.at !== siteKey()) est.site = null;
    priceRuns++;
    last = P() ? P().price(est, ctx(undefined, est, currentJobId)) : null;
    return last;
  }
  const busyHere = () => !!building && building === currentJobId;

  // An order list's lines (app.js), shaped as pricing.js prices lines, with
  // their ways worked out the one way everywhere (pricing.js waysFor). A
  // line's way set by hand: on the order line, else on the estimate's line
  // for the same material (by item, else by name).
  function orderShaped(lines, e, c) {
    const key = s => String(s || '').toLowerCase().trim();
    const mats = e.materials || [];
    const shaped = (lines || []).map((l, i) => {
      const m = l.supplyId ? mats.find(x => x.supplyId === l.supplyId) : mats.find(x => !x.supplyId && key(x.name) === key(l.name));
      // A joined line is counted in what its item is sold by; one not
      // joined, in its own unit ("4 tons" is still bulk).
      const it = l.supplyId ? c.items[l.supplyId] : null;
      return { id: 'ord' + i, supplyId: l.supplyId || null, name: (it && it.name) || l.name || '', orderQty: num(l.qty) || 0,
               per: l.supplyId ? '' : l.per || '',
               hand: ['delivered', 'pickup'].indexOf(l.hand) !== -1 ? l.hand : handWay(m) };
    });
    return P().waysFor(shaped, e, c);
  }

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
      draftMsg = ''; undo = null; toSup = null; byHand = false;
      render();
      autoCheck();
    },
    // A snow bid has no takeoff (any lines from before it was one are kept,
    // not used): nothing for the job's price or Materials to Order.
    hasLines: () => !snowNow() && hasLines(),
    hasMaterials: () => !snowNow() && est.materials.length > 0,
    // Whether a job's saved estimate is a snow bid, and its 1–3" price per
    // push -- shown where a bid's price is (boards, My Jobs, All Jobs), and
    // never added into a total: a snow bid has no whole-job price.
    isSnowJob: d => !!d && snowOf((d.estimate && typeof d.estimate === 'object') ? d.estimate : {}, d.serviceTypes, d.jobStatus, d.qbEstimate),
    perPushCents: d => perPushOf(d),
    // Notes brought in from elsewhere (a contact's meeting notes, prospects.js);
    // `auto` lets Claude start the estimate from them as if they had been typed.
    setNotes(text, auto) {
      est.notes = String(text || '');
      notesTyped = true;
      render();
      if (typeof markDirty === 'function') markDirty();
      if (auto) window.estNotesDone();
    },
    totalDollars: () => { if (snowNow()) return 0; const r = priced(); return r ? r.totalCents / 100 : 0; },
    book: () => book,
    // Nothing to order for a snow bid. A saved one (a job not open) is known
    // by its hand-set switch: one that is snow by its services alone has no
    // lines to order from anyway.
    orderLines: (saved, city) => {
      if (saved === undefined ? snowNow() : !!(saved && saved.snowBid === true)) return [];
      return orderLines(saved, city);
    },
    // What bringing a job's order costs us (app.js, both order lists): the
    // same pricing.js deliveries() its estimate is priced with, on what is
    // still to order -- so a list typed by hand is counted too. lines:
    // [{supplyId, qty (in what it is sold by)}]. saved: the job's estimate
    // when it is not the open one (its town, map point, a material marked
    // picked up, delivery switched off). null before pricing.js is there.
    // lines may carry `hand`: the way set by hand on the order line, which
    // wins over the estimate's.
    orderDelivery: (lines, saved, city) => {
      if (!P() || !P().deliveries) return null;
      const e = saved === undefined ? est : fromSaved(saved || {});
      const c = ctx(saved === undefined ? undefined : city || '');
      const shaped = orderShaped(lines, e, c).filter(l => l.supplyId && c.items[l.supplyId] && l.orderQty > 0);
      return P().deliveries(shaped, e, c);
    },
    // Delivered or picked up, for each line of a job's order list -- the
    // way set by hand on the order line, else on the estimate's line for
    // that material, else his rules (pricing.js wayOf): [{supplyId, name,
    // qty, hand}] -> [{way, wayBy, wayWhy, vendorName}] in the same order.
    orderWays: (lines, saved, city) => {
      if (!P() || !P().waysFor) return [];
      const e = saved === undefined ? est : fromSaved(saved || {});
      const c = ctx(saved === undefined ? undefined : city || '');
      return orderShaped(lines, e, c).map(l => ({ way: l.way, wayBy: l.wayBy, wayWhy: l.wayWhy, vendorName: l.vendorName || '' }));
    },
    jobCompleted: (id, data) => jobCompleted(id, data),
    // Any job's saved estimate priced the way this screen prices it, for a
    // job that is not open (Estimate vs actual, jobcosts.js): the same
    // pricing.js price() with the same Supplies, rules and price book --
    // never a second copy of the sums. null before pricing.js is there.
    // jobId: the job it is on (its days, for one accepted in QuickBooks).
    priceSaved: (saved, city, jobId) => {
      if (!P()) return null;
      const e = fromSaved(saved || {});
      return P().price(e, ctx(city == null ? '' : city, e, jobId));
    },
    // The same, split by piece of work (profit by service, jobcosts.js):
    // { lines: [{ title, service, priceCents, costCents, profitCents, crewDays, complete, ... }], rest } or null.
    splitSaved: (saved, city, jobId) => {
      if (!P()) return null;
      const e = fromSaved(saved || {});
      return serviceSplit(e, P().price(e, ctx(city == null ? '' : city, e, jobId)));
    },
    // The plant-care line under QuickBooks, after the job's plants or its
    // care email were settled on the Job tab (plantcare.js).
    redrawCare: () => renderQb(),
    // A job brought in from QuickBooks: its materials joined to Supplies
    // (app.js fillFromQb).
    linkFromQb: saved => linkFromQb(saved),
    linkDue: e => linkDue(e),
    // The server filled the open job from QuickBooks while it had unsaved
    // typing (sync.js): the lines taken in, what was typed kept -- or the
    // next save put the empty estimate back over them (Oct 2026). Only into
    // an estimate with no lines: one with lines is his.
    takeQb(saved) {
      if (!saved || !saved.fromQb || hasLines() || !((saved.work || []).length || (saved.materials || []).length)) return false;
      const got = fromSaved(saved);
      est.work = got.work; est.materials = got.materials; est.fromQb = got.fromQb;
      if (!est.memo) est.memo = got.memo;
      render();
      return true;
    },
  };

  // What the estimate cost us, as it stood when it went to QuickBooks: kept
  // with each version sent, so Estimate vs actual (jobcosts.js) compares the
  // job with what was BID. Pricing it again later would not do -- a receipt
  // updates Supplies to what was really paid (receipts.js offerPrices), which
  // would quietly move the estimate onto the actual and hide the difference.
  // byKind: the landed cost of each kind of material, so dumpsters and
  // rentals can be told from the rest.
  function costSnapshot(r) {
    const p = r.profit || {}, byKind = {};
    r.takeoff.concat(r.added).forEach(l => {
      if (l.costTotalCents > 0) byKind[l.category || 'other'] = (byKind[l.category || 'other'] || 0) + l.costTotalCents;
    });
    const n = v => (typeof v === 'number' && isFinite(v) ? v : 0);
    return { priceCents: n(r.totalCents), crewDays: n(r.crewDays), crewDayCents: num(P().rules().crewDayCents),
             materialCostCents: n(p.materialCostCents), deliveryCostCents: n(p.deliveryCostCents),
             fuelCostCents: n(p.fuelCostCents), laborCostCents: n(p.laborCostCents), subCostCents: n(p.subCostCents),
             costCents: n(p.costCents), byKind: byKind, complete: !!p.complete };
  }

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
    // A line of work written in with the materials is not a thing to buy
    // (workNotOrdered) -- unless he said it is a material after all.
    const work = {};
    (e.materials || []).forEach(m => { if (workNotOrdered(m)) work[m.id] = true; });
    r.takeoff.filter(l => !work[l.id]).concat(r.added).filter(l => l.orderQty > 0).forEach(l => {
      const it = l.supplyId ? items[l.supplyId] : null;
      const line = { supplyId: l.supplyId || null, vendorId: (it && it.vendorId) || null,
                     name: (it && it.name) || l.name || '', orderQty: l.orderQty, per: l.per || '',
                     costEachCents: num(l.costCents), specialOrder: !!l.specialOrder, plant: l.category === 'plant',
                     // A bag charged by the part used: how much of it the job uses.
                     usedLb: l.partUse && l.usedLb ? l.usedLb : null };
      const k = line.supplyId ? 's:' + line.supplyId : 'n:' + line.name.toLowerCase().trim();
      if (byKey[k]) {
        // Two lines of the same bag: bought together, so the bags are worked
        // out from what both use, not rounded up once each.
        const b = byKey[k];
        if (b.usedLb !== null && line.usedLb !== null && l.packLb) {
          b.usedLb = Math.round((b.usedLb + line.usedLb) * 100) / 100;
          b.orderQty = Math.ceil(b.usedLb / l.packLb - 1e-9);
        } else {
          b.orderQty = Math.round((b.orderQty + line.orderQty) * 1000) / 1000;
          b.usedLb = null;
        }
      } else { byKey[k] = line; out.push(line); }
    });
    return out;
  }
  // A material whose name says it is work -- "Bed excavation to 5" depth",
  // "Small pine tree removal" (supplymatch.js readsAsWork) -- and that is
  // not joined to a Supplies item (an item is a thing to buy, whatever its
  // name). The rule is only words, so he can say it is a material after all
  // (orderIt, on the line).
  const readsAsWork = m => !!(m && !m.plant && !m.supplyId && window.YDMatch && YDMatch.readsAsWork &&
    YDMatch.readsAsWork(m.name));
  const workNotOrdered = m => readsAsWork(m) && m.orderIt !== true;

  // An estimate saved by the first version (price-book lines and one message)
  // comes in as flat labour lines, so nothing typed is lost.
  function fromSaved(e) {
    const o = blank();
    o.notes = String(e.notes || '');
    o.chat = (Array.isArray(e.chat) ? e.chat : []).filter(m => m && m.text).map(m => {
      const c = { role: m.role === 'assistant' ? 'assistant' : 'user', text: String(m.text), at: m.at || null, changed: !!m.changed };
      if (num(m.photos) > 0) c.photos = num(m.photos);       // site photos it looked at (apply)
      if (Array.isArray(m.photoNums) && m.photoNums.length) c.photoNums = m.photoNums.filter(Number.isInteger).slice(0, 40);
      return c;
    });
    o.questions = Array.isArray(e.questions) ? e.questions.map(String) : [];
    o.flags = Array.isArray(e.flags) ? e.flags.map(String) : [];
    o.memo = String(e.memo || '');
    o.sent = Array.isArray(e.sent) ? e.sent.slice(-SENT_KEEP) : [];
    // Delivered or picked up by his rules (Jonah, 22 Oct 2026) -- except a
    // bid already sent before there were rules: the customer has its price,
    // so it keeps the deliveries it was priced with (pricing.js settleWays).
    // Not sent yet, it takes the rules, and says so once it is saved -- so
    // sending it later never moves its price.
    o.ways = e.ways === 'rules' || !o.sent.length ? 'rules' : null;
    o.payments = cleanPlan(e.payments);
    // A home or a business, when set by hand (whoFor); left out = from the
    // job's Business name.
    if (e.customerType === 'home' || e.customerType === 'business') o.customerType = e.customerType;
    // A snow bid: switched by hand either way, and its price sheet.
    if (e.snowBid === true || e.snowBid === false) o.snowBid = e.snowBid;
    o.snow = cleanSnow(e.snow);
    if (e.v === 2) {
      o.work = (Array.isArray(e.work) ? e.work : []).map(w => Object.assign({ id: newId('ew'), kind: 'crew' }, w));
      o.materials = (Array.isArray(e.materials) ? e.materials : []).map(m => Object.assign({ id: newId('em') }, m));
      o.spoilCuYd = num(e.spoilCuYd);
      o.brushCuYd = num(e.brushCuYd);
      o.fuel = Object.assign({}, e.fuel || {});
      o.deliveryTown = String(e.deliveryTown || '');
      o.off = Object.assign({}, e.off || {});
      // Made in QuickBooks and accepted there (quickbooks.py _hub_estimate):
      // the figures the customer said yes to, kept (pricing.js asAccepted).
      if (e.fromQb && typeof e.fromQb === 'object') o.fromQb = clone(e.fromQb);
      // The lines already sent to Claude for the crew's notes (crewWrite).
      if (Array.isArray(e.crewAsked)) o.crewAsked = e.crewAsked.slice(-80);
      // Where the job is on the map (from the miles lookup), for a town MDS
      // prices by zone; `at` is the address it was found for.
      // `zip` is the ZIP the map has for the address (checked before sending),
      // `zipOk` a typed ZIP he chose to keep anyway.
      o.site = e.site && typeof e.site.lat === 'number' && typeof e.site.lng === 'number'
        ? { lat: e.site.lat, lng: e.site.lng, at: String(e.site.at || ''),
            zip: e.site.zip ? String(e.site.zip) : null, zipOk: e.site.zipOk ? String(e.site.zipOk) : null } : null;
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
    const ran = priceRuns;
    if (typeof syncJobPriceFromProposals === 'function') syncJobPriceFromProposals();
    if (typeof updateJobPriceSourceTag === 'function') updateJobPriceSourceTag();
    if (typeof markDirty === 'function') markDirty();
    if (redraw) render();
    else {
      // Keeping the job's price in step has just priced the estimate (unless
      // the price is typed by hand), and nothing has changed since: the totals
      // use that, instead of pricing it a second time at every key typed in
      // a quantity or cost box.
      reuseLast = priceRuns !== ran;
      try { renderTotals(); } finally { reuseLast = false; }
    }
    // The first lines in (or the last out) show or hide the old proposal box.
    if (redraw && typeof renderProposal === 'function') renderProposal();
  }
  // Words only -- a heading, a scope, a name: nothing to re-price. Kept, and
  // the totals (whose "not priced yet" list names the lines, and the
  // customer's view when it is open) catch up once the typing pauses rather
  // than at every key.
  let wordsTimer = null;
  function wordsChanged() {
    if (typeof markDirty === 'function') markDirty();
    clearTimeout(wordsTimer);
    wordsTimer = setTimeout(renderTotals, 500);
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
    stale = false;
    kindsNow = null;
    sec.hidden = !sees();
    if (!sees()) return;
    if (!P()) { wrap.innerHTML = '<p class="empty-msg">Loading…</p>'; return; }
    const ro = !changes();
    // A snow bid is a price sheet, not a takeoff: drawn on its own.
    drawnSnow = snowNow();
    wrap.classList.toggle('snb-on', drawnSnow);
    if (drawnSnow) { renderSnow(wrap, ro); return; }
    const r = priced();
    const rules = P().rules();
    const notReady = num(rules.crewDayCents) === null || num(rules.taxPct) === null;

    // Said yes to: one line, and what is left to do with it (renderQb).
    const fold = folded();
    wrap.dataset.folded = fold ? '1' : '';
    if (fold) {
      wrap.innerHTML = '<div class="est-qb est-folded" id="estQb"></div>' + workWordsHtml();
      renderQb();
      // One accepted in QuickBooks still looks up its map point (its MDS zone).
      autoTrip();
      return;
    }

    const head =
      snowToggleHtml(ro) +
      (notReady ? '<div class="est-warnbox">Your pricing rules aren’t set up yet, so nothing can be priced. ' +
        (window.YDAuth && window.YDAuth.isOwner ? '<button class="btn btn-sm" onclick="openPricingRules()">Open Pricing rules</button>' : 'Ask Jonah to set them.') + '</div>' : '') +

      '<div class="field est-jump-to" id="estJNotes"><span class="label">Notes from the site visit — what you saw and measured, what they want. Claude builds the estimate from these.' +
        (ro ? '' : ' <button class="link-btn est-today" onclick="estNoteToday()">+ today’s date</button>') + '</span>' +
        '<textarea id="estNotes" rows="5" ' + (ro ? 'readonly ' : '') + 'oninput="estNotesInput(this.value)" onblur="estNotesDone()" ' +
        'placeholder="16x20 patio off the back door, Tahoe in Cascade, 2 steps down. 40 ft of Belgian edging along the beds (we pick it up). Tear out the old deck, ~12x14. Clay soil.">' +
        esc(est.notes) + '</textarea>' + snapHtml(ro) + '</div>' +
      (!ro && !hasLines() && !est.chat.length
        ? '<div class="field-actions"><button class="btn btn-filled" onclick="estDraftFromNotes()"' + (building ? ' disabled' : '') + '>' +
            (busyHere() ? 'Claude is working…' : building ? 'Claude is busy with another estimate…'
              : queued.indexOf(currentJobId) !== -1 ? 'Waiting its turn…' : '✨ Build the estimate from my notes') + '</button>' +
            (autoOn() && !building ? '<span class="hint">Or just finish writing — when you leave the notes, Claude starts it by itself.</span>' : '') +
          '</div>' : '') +

      chatHtml(ro);

    // A new bid: the notes and the Build button, and the rest when asked for.
    if (emptyBid()) {
      wrap.innerHTML = head + (ro ? '<p class="empty-msg">No estimate lines yet.</p>'
        : '<div class="est-byhand"><button class="link-btn" onclick="estByHand()">or add lines by hand</button>' +
          ' <span class="muted">— labor, materials, what your rules add, fuel</span></div>');
      drawn(wrap);
      return;
    }

    wrap.innerHTML =
      jumpHtml() +
      (settled() ? '<div class="est-refold"><button class="link-btn ro-ok" onclick="estUnfold(false)">▴ Fold the estimate back to one line</button></div>' : '') +
      fromQbHtml(r, ro) +
      workDonePanelHtml() +
      head +

      ((est.questions || []).length ? '<div class="est-questions"><b>Claude needs to know:</b><ul>' +
        est.questions.map(q => '<li>' + esc(q) + '</li>').join('') + '</ul>' +
        '<div class="hint">Answer in the chat, or fix the lines by hand.</div></div>' : '') +
      ((est.flags || []).length ? '<div class="est-flags"><b>Flags:</b><ul>' +
        est.flags.map(q => '<li>' + esc(q) + '</li>').join('') + '</ul></div>' : '') +

      '<h4 class="est-h est-jump-to" id="estJLabor">Labor <span class="muted">— each line is a line on the estimate, with its scope of work</span></h4>' +
      '<div class="est-work">' + (est.work.length ? est.work.map((w, i) => workHtml(w, i, ro)).join('')
        : '<div class="empty-msg">No labor yet.</div>') + '</div>' +
      (ro ? '' : '<div class="field-actions"><button class="btn btn-sm" onclick="estAddWork()">+ Labor line</button></div>') +

      '<h4 class="est-h est-jump-to" id="estJMats">Materials <span class="muted">' + (r && r.asAccepted
        ? '— as listed on the QuickBooks estimate, ' + cents(r.materialsCents) + ' for all of them; each at what it costs you'
        : '— the takeoff; the customer sees the list and one total') + '</span></h4>' +
      '<div class="est-mats">' + (est.materials.length ? est.materials.map((m, i) => matHtml(m, i, ro, r)).join('')
        : '<div class="empty-msg">No materials yet.</div>') + '</div>' +
      (ro ? '' : '<div class="field-actions">' +
        '<button class="btn btn-sm" onclick="estAddMat(false)">+ Material</button>' +
        '<button class="btn btn-sm" onclick="estAddMat(true)">+ Plant</button>' +
        (canAddSupplies() && typedLines().length && !toSup
          ? '<button class="btn btn-sm" onclick="estToSupplies()">➕ Add typed-in items to Supplies (' + typedLines().length + ')</button>' : '') +
        '<label class="est-inline">Soil, rock & debris to haul away <input inputmode="decimal" value="' + esc(est.spoilCuYd == null ? '' : est.spoilCuYd) + '" ' +
          'oninput="estSet(\'spoilCuYd\', this.value)"> cu yd</label>' +
        // Brush has a bigger dumpster of its own (pricing.js ruleLines).
        '<label class="est-inline">Brush only <input inputmode="decimal" value="' + esc(est.brushCuYd == null ? '' : est.brushCuYd) + '" ' +
          'oninput="estSet(\'brushCuYd\', this.value)"> cu yd</label>' +
      '</div>') +
      '<div id="estToSup">' + toSupHtml() + '</div>' +

      '<h4 class="est-h">Added by your rules</h4>' +
      '<div class="est-auto" id="estAuto"></div>' +

      '<div class="est-totals est-jump-to" id="estTotals"></div>' +
      (hasLines() ? '<div class="field-actions"><button class="btn btn-sm ro-ok" onclick="estToggleCustomer()">' +
        (showCustomer ? 'Hide what the customer sees' : '👁 What the customer sees') + '</button></div>' : '') +
      '<div id="estCustomer"></div>' +

      '<div class="field mt"><span class="label">Message on the estimate (the payments and payment terms) — blank uses the one in Pricing rules. ' +
        'The warranty and the terms & conditions go on as the estimate’s last lines.</span>' +
        '<textarea id="estMemo" rows="3" ' + (ro ? 'readonly ' : '') + 'oninput="estMemoInput(this.value)" placeholder="' +
        esc(defaultMemo(r ? r.totalCents : 0)) + '">' + esc(est.memo) + '</textarea></div>' +
      '<div class="field-actions"><button class="btn btn-sm" onclick="openPriceBook()">🧰 Services &amp; how they’re priced (' + Object.keys(book).length + ')</button>' +
        (window.YDAuth && window.YDAuth.isOwner ? '<button class="btn btn-sm" onclick="openPricingRules()">⚙ Pricing rules</button>' : '') + '</div>' +
      '<div class="est-qb est-jump-to" id="estQb"></div>';

    wrap.querySelectorAll('select.searchable').forEach(s => { if (typeof makeSearchable === 'function') makeSearchable(s); });
    const log = el('estChat'); if (log) log.scrollTop = log.scrollHeight;
    renderTotals();
    drawn(wrap);
    autoTrip();
  }

  // ------------------------------------------------- on a phone (15 Oct 2026)
  //
  // On a phone the estimate is one long page, and a box that scrolls inside
  // it -- the site notes, the chat, a scope of work -- catches the thumb that
  // meant to scroll the page. There they grow with what is in them instead
  // (up to most of the screen, styles.css), the chat shows its last few
  // messages with the rest a tap away, and a bar of links along the top
  // goes straight to each part.
  const phone = () => !!(window.matchMedia && window.matchMedia('(max-width:720px)').matches);
  const GROWS = '#estNotes, #estMemo, .est-scope, .est-crewnote textarea';
  function grow(t) {
    if (!t) return;
    // A wider screen keeps the boxes as drawn (or as dragged to size by
    // hand): only a height set here is taken off again.
    if (!phone()) { if (t.dataset.grown) { t.style.height = ''; delete t.dataset.grown; } return; }
    // Not on screen (the Job tab hidden): measured when it is shown.
    if (!t.offsetParent) return;
    // Shrunk to measure, then grown: the page must not jump while it is.
    const y = window.scrollY;
    t.style.height = 'auto';
    t.style.height = (t.scrollHeight + t.offsetHeight - t.clientHeight) + 'px';
    t.dataset.grown = '1';
    if (window.scrollY !== y) window.scrollTo(window.scrollX, y);
  }
  function growAll() {
    const w = el('estimateWrap');
    if (w) w.querySelectorAll(GROWS).forEach(grow);
  }
  document.addEventListener('input', e => {
    const t = e.target, w = el('estimateWrap');
    if (t && t.matches && t.matches(GROWS) && w && w.contains(t)) grow(t);
  });
  let growTimer = null;
  window.addEventListener('resize', () => { clearTimeout(growTimer); growTimer = setTimeout(() => { growAll(); placeJump(); }, 150); });
  // After every drawing of the estimate.
  function drawn(wrap) {
    growAll();
    placeJump(wrap);
  }

  // The links: shown on a phone only (styles.css), held under the Editing
  // bar as the page scrolls -- its height measured, as it changes with the
  // job's name and the width.
  const JUMPS = [['estJNotes', 'Notes'], ['estJLabor', 'Labor'], ['estJMats', 'Materials'], ['estTotals', 'Totals'], ['estQb', 'QuickBooks']];
  function jumpHtml() {
    return '<nav class="est-jump" aria-label="Parts of the estimate">' +
      JUMPS.map(([id, name]) => '<button type="button" class="ro-ok" onclick="estJump(\'' + id + '\')">' + name + '</button>').join('') + '</nav>';
  }
  function placeJump(wrap) {
    wrap = wrap || el('estimateWrap');
    const bar = el('ctxBar');
    if (!wrap || !phone()) return;
    wrap.style.setProperty('--est-under', (bar && bar.offsetParent ? bar.offsetHeight : 0) + 'px');
  }
  window.estJump = function (id) {
    const t = el(id);
    if (!t) return;
    placeJump();
    t.scrollIntoView({ block: 'start' });
  };

  // The customer said yes (Accepted, or already made into an invoice): there
  // is nothing left to build, only the invoice to make and be paid.
  function settled() {
    const q = qb(), inv = qbInv();
    return !!(q && q.id && (['Accepted', 'Closed', 'Converted'].indexOf(q.status) !== -1 || (inv && inv.id)));
  }
  const folded = () => settled() && !unfolded[currentJobId || ''];
  // Nothing built, nothing said to Claude, nothing in QuickBooks.
  function emptyBid() {
    const q = qb();
    return !byHand && !hasLines() && !est.chat.length && !busyHere() && !(q && q.id);
  }
  window.estByHand = function () { byHand = true; render(); };
  window.estUnfold = function (open) {
    const k = currentJobId || '';
    if (open) unfolded[k] = true; else delete unfolded[k];
    render();
    const s = el('estimateSection');
    if (!open && s && s.getBoundingClientRect().top < 0) s.scrollIntoView({ block: 'start' });
  };
  // The folded estimate's line: its number, the answer, the total, and the
  // way back in.
  function foldedHtml(q, status) {
    // A snow bid's QuickBooks total is only its lines added up: what it is
    // is its price per push.
    const push = snowNow() ? perPushNow() : null;
    const total = push ? cents(push) + ' per push'
      : q.total != null ? fmtMoney(Number(q.total) || 0) : last && last.grandCents > 0 ? cents(last.grandCents) : '';
    const link = q.link && /^https:\/\/[a-z.]*qbo\.intuit\.com\//.test(q.link)
      ? '<a class="btn btn-sm" href="' + esc(q.link) + '" target="_blank" rel="noopener">Open in QuickBooks</a>' : '';
    return '<div class="est-fold-line"><span class="est-fold-what"><b>Estimate' + (q.docNumber ? ' #' + esc(q.docNumber) : '') + '</b>' +
        (status ? ' · ' + esc(status) : '') + (total ? ' · <b>' + total + '</b>' : '') +
        (q.acceptedBy ? ' <span class="muted">by ' + esc(q.acceptedBy) + '</span>' : '') +
        (q.env === 'sandbox' ? ' <span class="est-sandbox">TEST COMPANY</span>' : '') + '</span>' +
      '<span class="est-fold-act">' + link +
        '<button class="btn btn-sm ro-ok" onclick="estUnfold(true)" aria-expanded="false">' + (changes() ? 'Show / edit ▾' : 'Show ▾') + '</button></span></div>';
  }

  // What the work is, line by line, under the estimate the customer said
  // yes to. Jonah, 16 Oct 2026: "when i say service descriptions i mean
  // whats actually written on the qwuickbooks estimate" -- the folded
  // estimate showed only its number and total. Then (21 Oct) the crew get
  // "what to do" first and the customer's words one tap away, and his admin
  // "should see the same version": so this is the crew's page for the work
  // (crewjobs.js), drawn from the same parts -- what to do, then "What the
  // customer was told" (QuickBooks' own words, for a job made there) folded
  // under each line. Jonah also sees, under a line, a how-we-do-it still to
  // write (only he writes them).
  // (With the invoice's change orders, which the crew's page lists after the work.)
  const jobLike = () => ({ estimate: est, serviceTypes: typeof serviceTypes !== 'undefined' && Array.isArray(serviceTypes) ? serviceTypes : [],
                           qbInvoiceRef: qbInv() });
  function workWordsHtml() {
    const C = window.YDCrewJobs;
    if (!C || !C.workParts || !est.work.some(w => String(w.scope || '').trim() || String(w.title || '').trim())) return '';
    const parts = C.workParts(jobLike());
    const q = est.fromQb;
    const from = q ? 'QuickBooks ' + (q.kind === 'invoice' ? 'invoice' : 'estimate') + (q.docNumber ? ' #' + esc(q.docNumber) : '') : 'the estimate';
    const mine = window.YDAuth && window.YDAuth.isOwner;
    // Each piece of work ticked off by the crew (workdone.js): who and when,
    // and the office may tick or untick one too (wdWanted).
    const ticks = wdWanted() ? { job: currentJobId } : null;
    return '<div class="est-words">' +
      C.workPageHtml(parts, { key: 'job:' + (currentJobId || ''), extra: mine ? howTodoHtml : null, ticks: ticks,
        // Under each material, what the crew lead said about it (jobissues.js).
        matExtra: window.YDJobIssues ? (m => YDJobIssues.matHtml(currentJobId, m)) : null,
        title: '🛠 The work <span class="est-words-from">— as the crew read it; what the customer was told (' + from + ') under each line</span>',
        sec: (title, body) => body ? '<div class="est-words-sec"><div class="cj-h">' + title + '</div>' + body + '</div>' : '' }) +
      crewBtnHtml() +
    '</div>';
  }
  // The work ticked off by the crew (workdone.js) at the top of an open
  // estimate on a job past bidding: each piece, who ticked it and when, and
  // a tick or untick by hand. (The folded estimate has the same under each
  // line of the work -- workWordsHtml.)
  // A job booked or under way has its ticks; a finished one only if any
  // were made (an old job's lines were never ticked -- a row of buttons
  // there would only be noise). Not a bid: nothing is being done yet.
  // (An older job's ticks are read once -- want -- and it is drawn again.)
  function wdWanted() {
    const W = window.YDWorkDone;
    if (!W || !currentJobId || typeof jobStatus === 'undefined' || typeof normStatus !== 'function') return false;
    const st = normStatus(jobStatus);
    if (st === 'quoting') return false;
    W.want(currentJobId);
    return st === 'booked' || st === 'inprogress' || W.has(currentJobId);
  }
  document.addEventListener('yd-workdone', () => {
    if (!el('estimateWrap') || !P() || snowNow() || !jobShown()) return;
    const want = wdWanted() && !!window.YDCrewJobs && YDCrewJobs.lines(jobLike()).length > 0;
    if (!!el('estimateWrap').querySelector('[data-wd]') === want) return;
    if (!typingHere()) render(); else stale = true;
  });
  function workDonePanelHtml() {
    const W = window.YDWorkDone, C = window.YDCrewJobs;
    if (!C || !C.lines || !wdWanted()) return '';
    const lines = C.lines(jobLike());
    if (!lines.length) return '';
    W.page(currentJobId, lines);
    return '<div class="est-wd"><div class="cj-h">✅ Work done — ticked off by the crew</div>' + W.sumHtml(currentJobId, lines) +
      lines.map(w => '<div class="est-wd-line"><b>' + esc(w.title || 'Work') + '</b>' + W.lineHtml(currentJobId, w) + '</div>').join('') + '</div>';
  }
  // Claude writing the crew's notes for this job (crewWrite), or the way to
  // ask it to: the lines with none, and its own again -- never his.
  function crewBtnHtml() {
    if (!changes()) return '';
    if (crewHere) return '<p class="hint est-crew-busy">✨ Claude is writing the crew’s notes…</p>';
    const some = est.work.some(w => w && (String(w.title || '').trim() || String(w.scope || '').trim()) && (crewEmpty(w) || w.crewNoteBy === 'claude'));
    return some ? '<div class="est-crew-again"><button type="button" class="btn btn-sm" onclick="estCrewNotes()">✨ Write the crew’s notes</button>' +
      '<span class="hint">Claude writes the lines with none (and its own again) — never over yours.</span></div>' : '';
  }
  // Under a piece of work, for Jonah: its kind of work's how-we-do-it, when
  // it is not written yet -- the crew see nothing for it until it is.
  function howTodoHtml(part) {
    const S = window.YDServices;
    const w = est.work.find(x => safeId(x.id) === part.id);
    if (!w || !S || !S.ready || !S.ready()) return '';
    const how = S.howToFor(w, jobLike());
    if (!how || how.text) return '';
    return '<div class="est-howline est-how-todo">👷 How we do it — ' + esc(how.name) + ': <span class="est-how-no">not written yet</span>' +
      ' <button class="link-btn ro-ok" data-s="' + esc(how.id) + '" onclick="openServiceHowTo(this.dataset.s)">✎ Write it</button></div>';
  }
  // The services list changed (a how-we-do-it written, a service renamed):
  // the lines that show them are drawn again.
  document.addEventListener('yd-services', () => {
    if (!el('estimateWrap') || !P() || snowNow()) return;
    if (jobShown() && !typingHere()) render(); else stale = true;
  });
  // A line brought in from QuickBooks (quickbooks.py _hub_estimate gives it
  // an id ewqb…): its words are QuickBooks', put back every hour by the
  // server (keep_qb_words), so they are shown, not edited, here.
  const fromQbLine = w => !!(est.fromQb && /^ewqb/.test(String(w.id || '')));

  // An estimate made in QuickBooks (quickbooks.py brought it in with the
  // job): where it came from, that its figures are the customer's, and the
  // way to price it by his own rules instead -- or back.
  function fromQbHtml(r, ro) {
    const q = est.fromQb;
    if (!q) return '';
    const what = q.kind === 'invoice' ? 'invoice' : 'estimate';
    const said = (q.docNumber ? 'QuickBooks ' + what + ' #' + esc(q.docNumber) : 'a QuickBooks ' + what) +
      (q.acceptedDate ? ', accepted ' + esc(fmtDay(q.acceptedDate)) : '');
    if (q.reprice) {
      return '<div class="est-fromqb">From ' + said + '. Priced by your rules here, not as the customer accepted it' +
        (num(q.totalCents) !== null ? ' (' + cents(q.totalCents) + ')' : '') + '.' +
        (ro ? '' : ' <button class="link-btn" onclick="estReprice(false)">Back to QuickBooks’ figures</button>') + '</div>';
    }
    return '<div class="est-fromqb">From ' + said + ' — the prices are the ones the customer said yes to: ' +
      'the materials as one figure, nothing added on top. Each material below shows what it costs you.' +
      (ro ? '' : ' <button class="link-btn" onclick="estReprice(true)">Price it by my rules instead</button>') + '</div>';
  }
  function fmtDay(d) {
    const t = new Date(String(d).slice(0, 10) + 'T12:00:00');
    return isNaN(t) ? String(d) : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  window.estReprice = async function (on) {
    if (!changes() || !est.fromQb) return;
    const was = est;
    if (on && !(await ydConfirm('Its total will no longer be the ' +
        (num(est.fromQb.totalCents) !== null ? cents(est.fromQb.totalCents) + ' ' : '') + 'the customer accepted in QuickBooks.',
        { title: 'Price this estimate by your rules?', ok: 'Price it by my rules' }))) return;
    if (est !== was || !est.fromQb) return;      // another job opened meanwhile
    est.fromQb = Object.assign({}, est.fromQb, { reprice: !!on });
    changed(true);
  };

  // A QuickBooks estimate's materials come in by name, as written there
  // ("Screened topsoil: 2.5 cubic yards"). Each is joined to the one
  // Supplies item it names -- every word of it in the item's name, and the
  // quantity in a unit the item is sold or measured in -- so it has a cost,
  // a supplier and a place on Materials to Order. When two items fit as
  // well (three sizes of grass seed), or the unit is one the item is not
  // sold by, it is left for him (🔎 Source it shows the near ones). Once per
  // version of the matching (LINK_V): when supplymatch.js learns to read more
  // (26 Oct 2026: makers' names, colours after a dash), the jobs already in
  // are joined again -- only the materials still not joined and with no cost
  // he typed; nothing he joined is touched. Returns the estimate as saved
  // with the links, or null when there is nothing to do.
  // The one Supplies item it is, by supplymatch.js: an item he picked for
  // these words before, or the only one with all of them in a unit that
  // fits. Anything less certain is left for him, with the likely ones
  // offered under the line (matchHtml).
  function qbMatch(m, c) {
    if (!window.YDMatch) return null;
    const got = YDMatch.match(m, c, P().NOT_FOR_ESTIMATES || []);
    return got.sure;
  }
  const LINK_V = 2;
  const linkDue = e => !!(e && e.fromQb && (!e.fromQb.linkedAt || (num(e.fromQb.linkedV) || 1) < LINK_V));
  function linkFromQb(saved) {
    if (!P() || !linkDue(saved)) return null;
    const c = catalog();
    const out = clone(saved);
    let n = 0;
    out.materials = (out.materials || []).map(m => {
      if (m.supplyId || m.plant || num(m.costCents) > 0) return m;
      const hit = qbMatch(m, c);
      if (!hit || hit.unitOff) return m;
      n++;
      return Object.assign({}, m, { supplyId: hit.id, qty: hit.qty, unit: hit.unit || m.unit });
    });
    out.fromQb = Object.assign({}, out.fromQb, { linkedAt: new Date().toISOString(), linkedV: LINK_V,
                                                 linked: (num(saved.fromQb.linked) || 0) + n });
    return out;
  }

  // The photos an answer looked at, by their numbers on the job: "photo 7",
  // "photos 3, 5 and 7", or for many "8 photos (12–19)".
  function photosSeenText(m) {
    const ns = Array.isArray(m.photoNums) ? m.photoNums : [];
    if (!ns.length) return m.photos + ' site photo' + (m.photos === 1 ? '' : 's');
    if (ns.length === 1) return 'photo ' + ns[0];
    if (ns.length <= 6) return 'photos ' + ns.slice(0, -1).join(', ') + ' and ' + ns[ns.length - 1];
    return ns.length + ' photos (' + ns[0] + '–' + ns[ns.length - 1] + ')';
  }

  // On a phone the chat is part of the page, not a box of its own: its last
  // few messages, and the earlier ones behind a tap (styles.css hides them
  // there; a wider screen keeps the whole conversation in its scrolling box).
  const CHAT_PHONE = 4;
  const UNANSWERED_MS = 6 * 60 * 1000;
  const chatAll = {};         // job id -> its earlier messages shown on a phone
  window.estAskAgain = function () {
    if (!changes() || !currentJobId || busyHere() || queued.indexOf(currentJobId) !== -1) return;
    const lastM = est.chat[est.chat.length - 1];
    if (!lastM || lastM.role !== 'user') return;
    if (building) { queued.push(currentJobId); render(); return; }
    ask(currentJobId);
  };
  window.estChatAll = function () {
    chatAll[currentJobId || ''] = true;
    const c = el('estChat');
    if (c) c.classList.add('est-chat-all');
  };
  // open: drawn even with nothing said yet (a snow bid's "Talk to Claude").
  function chatHtml(ro, open) {
    if (!est.chat.length && !busyHere() && !open) return '';
    const snow = snowNow();
    const lastI = est.chat.length - 1;
    const older = Math.max(0, est.chat.length - CHAT_PHONE);
    // His message with no answer and nothing working on it -- longer ago
    // than any answer takes (claude.js waits five minutes), so not one still
    // coming to another device: asked again with a tap, not retyped.
    const lastM = est.chat[lastI];
    const unanswered = !ro && lastM && lastM.role === 'user' && !busyHere() && queued.indexOf(currentJobId) === -1 &&
      (!lastM.at || Date.now() - Date.parse(lastM.at) > UNANSWERED_MS);
    return '<div class="est-chat' + (chatAll[currentJobId || ''] ? ' est-chat-all' : '') + '" id="estChat">' +
        (older ? '<button type="button" class="link-btn est-chat-older ro-ok" onclick="estChatAll()">Show the ' + older +
          ' earlier message' + (older === 1 ? '' : 's') + '</button>' : '') +
        est.chat.map((m, i) => '<div class="est-msg ' + (m.role === 'assistant' ? 'claude' : 'me') + (i < older ? ' est-msg-old' : '') + '">' +
          '<div class="est-who">' + (m.role === 'assistant' ? '✨ Claude' : 'You') + '</div>' +
          '<div class="est-text">' + esc(m.text) + '</div>' +
          (m.role === 'assistant' && m.photos ? '<div class="est-did">📷 Looked at ' + photosSeenText(m) + '</div>' : '') +
          (m.role === 'assistant' && m.changed ? '<div class="est-did">Updated the estimate' +
            (i === lastI && undo && undo.jobId === currentJobId && !ro ? ' · <button class="link-btn" onclick="estUndo()">Undo</button>' : '') +
            '</div>' : '') +
        '</div>').join('') +
        (busyHere() ? '<div class="est-msg claude"><div class="est-who">✨ Claude</div><div class="est-text muted">' +
          (snow ? 'Working on it…' : 'Working on it — a first build can take a minute or two. ' +
          'You can open another job meanwhile; it lands on this one.') + '</div></div>'
          : queued.indexOf(currentJobId) !== -1 ? '<div class="est-msg claude"><div class="est-who">✨ Claude</div><div class="est-text muted">' +
            'Waiting its turn — finishing another estimate first.</div></div>'
          : unanswered ? '<div class="est-msg claude"><div class="est-who">✨ Claude</div><div class="est-text muted">' +
            'No answer came back to this one. <button class="link-btn" onclick="estAskAgain()">Ask again</button></div></div>' : '') +
      '</div>' +
      (ro ? '' : '<div class="est-send">' +
        '<textarea id="estMsg" rows="2" placeholder="' + (snow
          ? 'Talk to Claude about this bid — “they want the back steps too”, “add the deck as an extra”'
          : 'Talk to Claude about this estimate — “make it 18x20”, “add a fire pit”, “look at photo 7 — is that slope too steep?”') + '" ' +
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

  // How a labour line is priced (pricing.js workLine). Jonah, 13 Oct 2026: not
  // everything is a goal profit per day -- turf is by the sq ft, adjusted.
  // All in (21 Oct 2026): his price for the work WITH its materials -- the
  // line is what is left once the materials marked as in it are charged.
  const WORK_KINDS = [['crew', 'By crew-days'], ['flat', 'By the unit (a service)'], ['amount', 'Fixed price (labor only)'],
                      ['allin', 'All in — with its materials']];
  const perDay = c => fmtMoney(Math.round(c / 100)).replace(/\.00$/, '') + '/day';

  function workHtml(w, i, ro) {
    const id = safeId(w.id), dis = ro ? ' disabled' : '';
    const kind = w.kind || 'crew';
    const on = (f, v, ph, cls, mode) => '<input class="' + (cls || '') + '"' + (mode ? ' inputmode="' + mode + '"' : '') +
      ' value="' + esc(v == null ? '' : v) + '" placeholder="' + esc(ph || '') + '"' + dis +
      ' oninput="estWork(\'' + id + '\', \'' + f + '\', this.value)">';
    // Done by someone else (pricing.js workLine's `sub`): who, and what they
    // charge him, where his crew's days would be -- the line takes none.
    // What they charge is his cost, so not for a look-only viewer (as the
    // planned profit is not).
    const daysBox = w.sub
      ? '<label class="est-grow"><span>Who does it</span><input list="estSubNames" value="' + esc(w.sub.by || '') + '"' +
          ' placeholder="Sub or installer"' + dis + ' onfocus="estLoadSubNames()" oninput="estWork(\'' + id + '\', \'subBy\', this.value)"></label>' +
        (ro ? '' : '<label><span>They charge you ($)</span>' + on('subCents', dollarsIn(w.sub.cents), '0.00', 'est-money', 'decimal') + '</label>')
      : '<label><span>Crew-days</span>' + on('crewDays', w.crewDays, 'e.g. 1.5', '', 'decimal') + '</label>';
    let nums = '', extra = '';
    if (kind === 'crew' && w.sub) {
      // Crew-days price his own crew; the line asks for another way
      // (its problem says so) and shows what the sub charges meanwhile.
      nums = daysBox;
    } else if (kind === 'crew') {
      // His own amounts (Pricing rules), the usual marked; a line with an
      // amount of its own shows it too; "Other" asks for one.
      const choices = P().profitChoices ? P().profitChoices() : [];
      const usual = P().defaultProfitCents ? P().defaultProfitCents() : null;
      const mine = P().profitOf ? P().profitOf(w) : null;
      const opts = choices.indexOf(mine) === -1 && mine !== null ? choices.concat([mine]).sort((a, b) => a - b) : choices;
      nums = '<label><span>Crew-days</span>' + on('crewDays', w.crewDays, 'e.g. 1.5', '', 'decimal') + '</label>' +
        '<label><span>Profit per crew-day</span><select' + dis + ' onchange="estWork(\'' + id + '\', \'profit\', this.value)">' +
          (opts.length ? opts.map(c => '<option value="' + c + '"' + (c === mine ? ' selected' : '') + '>' + perDay(c) +
            (c === usual ? ' (usual)' : '') + '</option>').join('') : '<option value="">— set them in Pricing rules —</option>') +
          '<option value="__other">Other amount…</option>' +
        '</select></label>';
    } else if (kind === 'flat') {
      // Services priced by crew-days are notes for Claude, not a price.
      const names = Object.keys(book).map(pid => [pid, book[pid]]).filter(([pid, e]) => (e.method || 'unit') !== 'crew' || pid === w.priceId)
        .sort((a, b) => String(a[1].name || '').localeCompare(String(b[1].name || '')));
      const svc = w.priceId ? book[w.priceId] : null;
      nums = '<label class="est-grow"><span>Service</span><select class="searchable"' + dis + ' onchange="estPickPrice(\'' + id + '\', this.value)">' +
          '<option value="">—</option>' + names.map(([pid, e]) => '<option value="' + esc(pid) + '"' + (pid === w.priceId ? ' selected' : '') + '>' +
            esc(e.name) + (Number.isInteger(e.priceCents) ? ' — ' + cents(e.priceCents) + '/' + esc(e.unit || 'each') : '') + '</option>').join('') +
        '</select></label>' +
        '<label><span>Qty' + (w.unit ? ' (' + esc(w.unit) + ')' : '') + '</span>' + on('qty', w.qty, '', '', 'decimal') + '</label>' +
        '<label><span>Price per ' + esc(w.unit || 'unit') + '</span>' + on('rate', dollarsIn(w.rateCents), '0.00', 'est-money', 'decimal') + '</label>' +
        daysBox;
      extra = adjustHtml(w, svc, ro);
    } else if (kind === 'allin') {
      nums = '<label><span>All-in price ($)</span>' + on('allIn', dollarsIn(w.allInCents), 'labor + its materials', 'est-money', 'decimal') + '</label>' +
        '<label><span>+ Labor not in it ($)</span>' + on('add', dollarsIn(w.addCents), 'optional', 'est-money', 'decimal') + '</label>' +
        daysBox;
      // How the figure splits, filled by renderTotals.
      extra = '<div class="est-allin" id="estWI_' + id + '"></div>';
    } else {
      nums = '<label><span>Amount ($)</span>' + on('amount', dollarsIn(w.amountCents), '0.00', 'est-money', 'decimal') + '</label>' +
        daysBox;
    }
    // The QuickBooks product is rarely changed: under More, named on the
    // button when it has one so it is never hidden without a word.
    const qbName = String(w.qbItem || '').trim();
    return '<div class="est-wrow">' +
      '<div class="est-wtop">' + on('title', w.title, 'Heading, e.g. Paver patio & steps', 'est-title') +
        '<select' + dis + ' onchange="estWork(\'' + id + '\', \'kind\', this.value)">' +
          WORK_KINDS.map(([k, n]) => '<option value="' + k + '"' + (k === kind ? ' selected' : '') + '>' + n + '</option>').join('') +
        '</select>' + moves('work', id, i, est.work.length, ro) + '</div>' +
      '<div class="est-nums">' + nums + '<div class="est-amt" id="estWA_' + id + '"></div></div>' +
      extra +
      '<div class="est-wprofit" id="estWF_' + id + '"></div>' +
      (fromQbLine(w)
        ? '<div class="est-scope-qb"><span class="muted">As written on the QuickBooks ' + (est.fromQb.kind === 'invoice' ? 'invoice' : 'estimate') +
            ' — change it there; anything more for the crew goes in “Notes for the crew”.</span>' +
            '<div class="est-words-text">' + (String(w.scope || '').trim() ? esc(String(w.scope).trim()) : '<span class="muted">No description on this line in QuickBooks.</span>') + '</div></div>'
        : '<textarea rows="3" class="est-scope" placeholder="Scope of work the customer reads for this line"' + (ro ? ' readonly' : '') +
            ' oninput="estWork(\'' + id + '\', \'scope\', this.value)">' + esc(w.scope || '') + '</textarea>') +
      crewNoteHtml(w, id, ro) +
      howLineHtml(w) +
      '<div class="est-meta">' + crewNoteAddHtml(w, id, ro) +
        taxPickHtml('work', id, w.taxable, ro) +
        // One line for the customer: this work with its own materials
        // (customerLines). Not an all-in line, whose split is its own.
        (kind === 'allin' ? '' : '<label class="est-withmats" title="The materials the crew’s page lists under this line go into its price on the customer’s copy and QuickBooks, instead of the Materials line">' +
          '<input type="checkbox"' + (w.withMats ? ' checked' : '') + dis + ' onchange="estWork(\'' + id + '\', \'withMats\', this.checked)"> ' +
          'Its materials in this price</label>') +
        '<label class="est-withmats" title="A subcontractor or outside installer does this line: what they charge you is its cost instead of your crew’s days. The customer’s price stays the same.">' +
          '<input type="checkbox"' + (w.sub ? ' checked' : '') + dis + ' onchange="estWork(\'' + id + '\', \'subOn\', this.checked)"> ' +
          '🤝 Done by a sub / installer</label>' +
        moreBtnHtml(id, [qbName ? 'QuickBooks: ' + qbName : '',
          w.service === 'none' ? 'No how-we-do-it' : w.service ? 'Service picked' : ''].filter(Boolean).join(' · ')) + '</div>' +
      moreBoxHtml(id, '<div class="est-qbitem"><span>QuickBooks product</span><input list="estQbItems" value="' + esc(w.qbItem || '') + '" placeholder="Labor"' + dis +
        ' onfocus="estLoadQbItems()" oninput="estWork(\'' + id + '\', \'qbItem\', this.value)"></div>' +
        servicePickHtml(w, id, ro)) +
      '<div class="est-probs" id="estWP_' + id + '"></div>' +
    '</div>';
  }

  // A line's "More ▾": what is seldom changed, folded under the line. Open
  // or shut without drawing the estimate again (nothing in it prices).
  const moreOpen = {};        // line id -> its More is open
  function moreBtnHtml(id, says) {
    return '<button type="button" class="est-more-btn ro-ok" id="estMBt_' + id + '" aria-expanded="' + (moreOpen[id] ? 'true' : 'false') + '"' +
      ' onclick="estMore(\'' + id + '\')">' + (moreOpen[id] ? 'Less ▴' : 'More ▾') +
      (says ? ' <span class="est-more-says">· ' + esc(says) + '</span>' : '') + '</button>';
  }
  function moreBoxHtml(id, inside) {
    return '<div class="est-more-box" id="estMB_' + id + '"' + (moreOpen[id] ? '' : ' hidden') + '>' + inside + '</div>';
  }
  window.estMore = function (id) {
    id = safeId(id);
    moreOpen[id] = !moreOpen[id];
    const box = el('estMB_' + id), btn = el('estMBt_' + id);
    if (box) box.hidden = !moreOpen[id];
    if (btn) {
      btn.setAttribute('aria-expanded', moreOpen[id] ? 'true' : 'false');
      const says = btn.querySelector('.est-more-says');
      btn.textContent = (moreOpen[id] ? 'Less ▴' : 'More ▾') + (says ? ' ' : '');
      if (says) btn.appendChild(says);
    }
  };

  // Notes for the crew on a labour line (Jonah, 14 Oct 2026: the crew should
  // see "all the info that would be important to know to do the work"):
  // what the customer's scope does not say -- the base goes 8 in under the
  // driveway end, mind the sprinkler heads along the walk. Never on the
  // estimate or in QuickBooks; shown under this line on the crew's page for
  // the job (crewjobs.js), with any $ amount blanked. Folded away until used.
  const crewNoteOpen = {};
  const crewNoteShut = (w, id) => !String(w.crewNote || '').trim() && !crewNoteOpen[id];
  // The way to start one, on the line's bottom row beside its sales tax.
  function crewNoteAddHtml(w, id, ro) {
    return ro || !crewNoteShut(w, id) ? '' : '<span class="est-crewnote-add"><button class="link-btn" onclick="estCrewNote(\'' + id + '\')">' +
      '👷 + Notes for the crew</button></span>';
  }
  // Claude writes them from his site notes when it builds the estimate
  // (crewNoteBy 'claude', estimates.py `crew`) and may write them again
  // while they are still its own; once Jonah types in the box they are his
  // (crewNoteBy 'hand') and Claude changes them only when he asks it to.
  function crewNoteHtml(w, id, ro) {
    if (crewNoteShut(w, id)) return '';
    return '<div class="est-crewnote"><span>👷 Notes for the crew — not on the estimate; the crew see them on the job’s page' +
        (w.crewNoteBy === 'claude' && String(w.crewNote || '').trim() ? '. <b>Written by Claude</b> from your notes — change anything and they’re yours' : '') + '</span>' +
      '<textarea rows="2" id="estCN_' + id + '"' + (ro ? ' readonly' : '') +
        ' placeholder="What we’re doing on this job, a point a line — • Installing 120 ft of edging around 3 garden beds"' +
        ' oninput="estWork(\'' + id + '\', \'crewNote\', this.value)">' + esc(w.crewNote || '') + '</textarea></div>';
  }
  window.estCrewNote = function (id) {
    crewNoteOpen[safeId(id)] = true;
    render();
    const box = el('estCN_' + safeId(id));
    if (box) box.focus();
  };

  // How we do this kind of work (services.js howTo): the crew read it under
  // the line. Which service it comes from -- one whose whole name is in the
  // heading, or picked by hand under More (w.service: a service's id, or
  // 'none'; the line's tools follow the same pick) -- and whether it is
  // written yet. Nothing when no service goes with the line.
  function howLineHtml(w) {
    const S = window.YDServices;
    if (!S || !S.ready || !S.ready() || !S.howToFor) return '';
    const how = S.howToFor(w, jobLike());
    if (!how) return '';
    const mine = window.YDAuth && window.YDAuth.isOwner;
    return '<div class="est-howline">👷 How we do it — ' + esc(how.name) + (how.byHand ? ' <span class="muted">(picked)</span>' : '') + ': ' +
      (how.text ? '<span class="est-how-ok">✓ written — the crew read it under this line</span>'
        : '<span class="est-how-no">not written yet</span>' +
          (mine ? ' <button class="link-btn ro-ok" data-s="' + esc(how.id) + '" onclick="openServiceHowTo(this.dataset.s)">✎ Write it</button>' : '')) +
    '</div>';
  }
  // Under More: the service the line is, by hand -- for when the heading
  // says nothing a service is called ("Garden Bed Installation") or says the
  // wrong one. "Worked out" goes back to the heading.
  function servicePickHtml(w, id, ro) {
    const S = window.YDServices;
    if (!S || !S.ready || !S.ready() || !S.pickList) return '';
    const auto = S.howToFor(Object.assign({}, w, { service: '' }), jobLike());
    const groups = S.pickList();
    const picked = w.service || '';
    const listed = groups.some(g => g.services.some(v => v.id === picked));
    const opt = (v, label, on) => '<option value="' + esc(v) + '"' + (on ? ' selected' : '') + '>' + esc(label) + '</option>';
    // A pick that is hidden from the pickers now: still shown as it is. (One
    // merged away is gone from the list, and the heading decides again.)
    const all = (S.list && S.list() && S.list().services) || {};
    const gone = picked && picked !== 'none' && !listed && all[picked] ? all[picked] : null;
    return '<div class="est-qbitem est-svcpick"><span>Service — what the crew read under “How we do it” (and its tools)</span>' +
      '<select' + (ro ? ' disabled' : '') + ' onchange="estWork(\'' + id + '\', \'service\', this.value)">' +
        opt('', 'Worked out from the heading: ' + (auto ? auto.name : 'none'), !picked || (picked !== 'none' && !listed && !gone)) +
        (gone ? opt(picked, gone.name + ' (hidden)', true) : '') +
        groups.map(g => '<optgroup label="' + esc(g.name) + '">' +
          g.services.map(v => opt(v.id, v.name + (v.written ? ' ✓' : ''), picked === v.id)).join('') + '</optgroup>').join('') +
        opt('none', 'None — no how-we-do-it for this line', picked === 'none') +
      '</select></div>';
  }

  // Which piece of work a material is for, so the crew's page lists it
  // under that line (crewjobs.js workFor). Left on Auto it is worked out from
  // the words, and the choice it would make is shown; picked by hand, it
  // stays. Only asked when there is more than one line to choose from.
  function forWorkHtml(m, id, dis) {
    if (est.work.length < 2 || !window.YDCrewJobs || !YDCrewJobs.workFor) return '';
    const title = w => String(w.title || '').trim() || 'Labor line ' + (est.work.indexOf(w) + 1);
    const guess = YDCrewJobs.workFor(Object.assign({}, m, { forWork: '' }), est.work, catalog().items);
    const guessed = est.work.find(w => w.id === guess);
    const cur = m.forWork === 'none' || est.work.some(w => w.id === m.forWork) ? m.forWork : '';
    return '<label class="est-for"><span>👷 For the crew, this is for</span><select' + dis +
        ' onchange="estMat(\'' + id + '\', \'forWork\', this.value)">' +
      '<option value="">Auto — ' + esc(guessed ? title(guessed) : 'the whole job') + '</option>' +
      est.work.map(w => '<option value="' + esc(safeId(w.id)) + '"' + (cur && cur === w.id ? ' selected' : '') + '>' + esc(title(w)) + '</option>').join('') +
      '<option value="none"' + (cur === 'none' ? ' selected' : '') + '>The whole job</option>' +
    '</select></label>';
  }

  // Whether an all-in labour line's price already covers this material
  // (pricing.js workLine 'allin'). Asked only when there is such a line;
  // said on the line itself when it is in one, so it is never hidden.
  const allInLines = () => est.work.filter(w => w.kind === 'allin');
  const lineTitle = w => String(w.title || '').trim() || 'Labor line ' + (est.work.indexOf(w) + 1);
  function allInHtml(m, id, dis) {
    const lines = allInLines();
    if (!lines.length) return '';
    return '<label class="est-for"><span>💵 Its price is in</span><select' + dis +
        ' onchange="estMat(\'' + id + '\', \'allInOf\', this.value)">' +
      '<option value="">Charged on its own</option>' +
      lines.map(w => '<option value="' + esc(safeId(w.id)) + '"' + (m.allInOf === w.id ? ' selected' : '') + '>' +
        esc(lineTitle(w)) + '’s all-in price</option>').join('') +
    '</select></label>';
  }
  function allInChip(m) {
    const w = m.allInOf ? allInLines().find(x => x.id === m.allInOf) : null;
    return w ? '<span class="est-chip est-chip-allin" title="Its price is part of this line’s all-in figure">In ' + esc(lineTitle(w)) + '’s all-in</span>' : '';
  }

  // What a material's More button says when its line was picked by hand.
  function forWorkSays(m) {
    if (est.work.length < 2) return '';
    if (m.forWork === 'none') return 'for the whole job';
    const w = est.work.find(x => x.id === m.forWork);
    return w ? 'for ' + (String(w.title || '').trim() || 'Labor line ' + (est.work.indexOf(w) + 1)) : '';
  }

  // Delivered or picked up (pricing.js wayOf; Jonah, 22 Oct 2026): worked
  // out from his rules, it is a chip saying which and why, and a tap brings
  // out the choice. Set by hand -- the odd time a material goes the other way
  // -- the choice stays out, with the way back to his rules. Picked up, it
  // carries no delivery charge. Drawn by renderTotals, as the whole job
  // settles it (a small thing rides on a supplier's truck).
  const wayOpen = {};         // line id -> its choice brought out
  const WAY_WORDS = { delivered: '🚚 Delivered', pickup: '🏪 We pick it up', rides: '🚚 On another load' };
  const handWay = m => (m && ['delivered', 'pickup', 'rides'].indexOf(m.delivery) !== -1 ? m.delivery : null);
  function wayPickHtml(l, m, ro) {
    if (!l || !l.way) return '';
    const id = safeId(l.id), hand = handWay(m), dis = ro ? ' disabled' : '';
    if (!hand && !wayOpen[id]) {
      return '<button type="button" class="est-chip est-chip-way"' + dis + ' onclick="estWayOpen(\'' + id + '\')"' +
        ' title="Worked out from your rules — tap to set it by hand">' + WAY_WORDS[l.way] +
        ' <span class="muted">· ' + esc(l.wayWhy) + '</span>' + (ro ? '' : ' ▾') + '</button>';
    }
    // "On another load" only where a load is the question: a bulk load or
    // a pallet from a supplier who delivers by town (or picked so before).
    const choices = [['delivered', '🚚 Delivered'], ['pickup', '🏪 We pick it up']].concat(
      hand === 'rides' || (l.cityDelivery && (l.pallet || P().isBulk(l.per))) ? [['rides', 'On another load']] : []);
    return '<span class="est-way-pick">' + choices.map(([k, n]) => {
      const on = (hand || l.way) === k;
      return '<button type="button" class="est-way-btn' + (on ? ' on' : '') + '" aria-pressed="' + on + '"' + dis +
        ' onclick="estWay(\'' + id + '\', \'' + k + '\')">' + n + '</button>';
    }).join('') +
      (hand ? ' <span class="muted">set by hand</span>' + (ro ? '' : ' <button type="button" class="link-btn" onclick="estWay(\'' + id + '\', \'auto\')">↺ back to my rules (' +
          esc(String(rulesWay(m, l).way === 'pickup' ? 'picked up' : 'delivered')) + ')</button>')
        : ' <span class="muted">' + esc(l.wayWhy) + '</span>') + '</span>';
  }
  // What his rules alone would say for a line set by hand (the ↺ button).
  function rulesWay(m, l) {
    const c = catalog(), it = m.supplyId ? c.items[m.supplyId] : null;
    const v = it && it.vendorId ? (c.vendors || {})[it.vendorId] : null;
    return P().wayOf({ name: l.name, also: it ? [it.name, it.also].filter(Boolean).join(' ') : '', category: l.category, per: l.per,
      pallet: l.pallet, cityDelivery: l.cityDelivery, buyWays: v && v.buyWays, vendorName: v && v.name, itemWay: it && it.getWay });
  }
  window.estWayOpen = function (id) {
    id = safeId(id);
    if (!changes() || !find(est.materials, id)) return;
    wayOpen[id] = true;
    renderTotals();
  };
  window.estWay = function (id, v) {
    id = safeId(id);
    const m = find(est.materials, id);
    if (!m || !changes() || ['auto', 'delivered', 'pickup', 'rides'].indexOf(v) === -1) return;
    m.delivery = v;
    if (v === 'auto') delete wayOpen[id];
    // A truck more or less moves the price.
    changed(false);
  };

  // Sales tax on a line (pricing.js salesTax): worked out from what the line
  // is, or set by hand -- the line shows which, and why when a building job's
  // little bit of planting goes untaxed. Worked out, it is a small chip
  // saying which; a tap on it brings out the choice. Set by hand, the choice
  // stays out, so a line taxed against the rule is seen at a glance.
  const taxOpen = {};         // line id -> its sales tax choice brought out
  function taxPickHtml(kind, id, v, ro) {
    const cur = v === true ? '1' : v === false ? '0' : '';
    const note = '<span class="muted" id="' + (kind === 'work' ? 'estWT_' : 'estMT_') + id + '"></span>';
    if (!cur && !taxOpen[id]) {
      return '<span class="est-tax" id="estTX_' + id + '"><button type="button" class="est-chip"' + (ro ? ' disabled' : '') +
        ' onclick="estTaxOpen(\'' + kind + '\', \'' + id + '\')" title="Sales tax, worked out from what the line is — tap to set it by hand">' +
        '<span class="est-chip-k">Tax</span> ' + note + (ro ? '' : ' ▾') + '</button></span>';
    }
    return '<span class="est-tax" id="estTX_' + id + '"><span>Sales tax</span><select' + (ro ? ' disabled' : '') +
      ' onchange="estTax(\'' + kind + '\', \'' + id + '\', this.value)">' +
      [['', 'Auto'], ['1', 'Taxed'], ['0', 'Not taxed']].map(([k, n]) => '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>' + n + '</option>').join('') +
      '</select>' + note + '</span>';
  }
  window.estTaxOpen = function (kind, id) {
    id = safeId(id);
    const x = find(kind === 'work' ? est.work : est.materials, id), box = el('estTX_' + id);
    if (!x || !box || !changes()) return;
    taxOpen[id] = true;
    box.outerHTML = taxPickHtml(kind, id, x.taxable, false);
    renderTotals();
    const sel = el('estTX_' + id) && el('estTX_' + id).querySelector('select');
    if (sel) sel.focus();
  };
  function taxNote(line, r, hand) {
    if (!line) return '';
    if (line.taxable && r.tax.underTen) return 'not taxed: planting under 10% of a building job';
    return (hand ? '' : 'auto: ') + (line.taxed ? 'taxed' : 'not taxed');
  }
  window.estTax = function (kind, id, v) {
    const x = find(kind === 'work' ? est.work : est.materials, id);
    if (!x || !changes()) return;
    if (v === '1') x.taxable = true; else if (v === '0') x.taxable = false; else delete x.taxable;
    changed(false);
  };

  // A service's adjustments (Services): each ticked one is copied onto the
  // line with its amount, so a later change to the service never moves a
  // price already given. One ticked before the service changed stays shown.
  function adjText(a, unit) {
    const n = num(a.amount) || 0, sign = n < 0 ? '−' : '+';
    if (a.how === 'pct') return sign + Math.abs(n) + '%';
    return sign + cents(Math.abs(n)) + (a.how === 'unit' ? '/' + (unit || 'unit') : '');
  }
  function adjustHtml(w, svc, ro) {
    const ticked = Array.isArray(w.adjust) ? w.adjust : [];
    const list = ((svc && svc.factors) || []).filter(f => f && f.id).slice();
    ticked.forEach(a => { if (!list.some(f => f.id === a.id)) list.push(a); });
    const id = safeId(w.id), dis = ro ? ' disabled' : '';
    const min = num(w.minimumCents);
    if (!list.length && min === null && !(svc && svc.notes)) return '';
    return '<div class="est-adjust">' +
      (list.length ? '<span class="label">Adjust for this job</span>' : '') +
      list.map(f => {
        const t = ticked.find(a => a.id === f.id);
        return '<label class="chk"><input type="checkbox"' + (t ? ' checked' : '') + dis +
          ' onchange="estAdjust(\'' + id + '\', \'' + safeId(f.id) + '\', this.checked)"> ' + esc(f.name || 'Adjustment') +
          ' <span class="muted">' + esc(adjText(t || f, w.unit)) + '</span></label>';
      }).join('') +
      (min !== null ? '<div class="hint">Minimum charge for this service: ' + cents(min) + '</div>' : '') +
      (svc && svc.notes ? '<details class="est-svcnotes"><summary>How you price ' + esc(svc.name || 'this') + '</summary>' +
        '<div>' + esc(svc.notes) + '</div></details>' : '') +
    '</div>';
  }
  window.estAdjust = function (id, fid, onOff) {
    const w = find(est.work, id);
    if (!w || !changes()) return;
    const svc = w.priceId ? book[w.priceId] : null;
    const list = Array.isArray(w.adjust) ? w.adjust.slice() : [];
    const at = list.findIndex(a => safeId(a.id) === fid);
    if (onOff && at === -1) {
      const f = ((svc && svc.factors) || []).find(x => x && safeId(x.id) === fid);
      if (f) list.push({ id: f.id, name: String(f.name || ''), how: f.how || 'pct', amount: num(f.amount) || 0 });
    } else if (!onOff && at !== -1) list.splice(at, 1);
    w.adjust = list;
    changed(false);
  };

  // Every kind of material, his own included (pricing.js). Worked out once
  // per drawing: his own kinds are found by going through every supply.
  let kindsNow = null;
  const kinds = () => kindsNow || (kindsNow = P().allKinds ? P().allKinds() : P().CATEGORIES);

  // The Supplies picker on a material line. Supplies holds ~900 things, and
  // a 25-line bid drawing the whole list on every line was 22,000 options
  // and 25 sorts per redraw. So the list is sorted and drawn once, kept until
  // Supplies or the kinds change (onCatalog), and each line's dropdown holds
  // only its own choice until someone goes to use it (fillPicker).
  // Not "not in Supplies": a line nobody has joined yet may well be there
  // (15 Oct 2026 -- he read it as Supplies not having the item).
  const NO_SUPPLY = '<option value="">— pick from Supplies —</option>';
  const byText = new Intl.Collator(undefined, { numeric: true }).compare;   // #8 stone before #57, as in Supplies
  let supplyList = null;      // { html: every option, has: Set of their ids }
  function supplyOption(it, c, selected) {
    const v = c.vendors[it.vendorId];
    const unit = num(it.coverage) > 0 ? it.takeoffUnit : ((c.prices[it.id] || {}).per || it.unit || '');
    return '<option value="' + esc(it.id) + '"' + (selected ? ' selected' : '') + '>' + esc(it.name) +
      (unit ? ' (' + esc(unit) + ')' : '') + (v ? ' — ' + esc(v.name) : '') + '</option>';
  }
  function allSupplyOptions() {
    if (supplyList) return supplyList;
    const c = catalog();
    // By kind (his own kinds by their names), then by name. Tools are never
    // on an estimate (NOT_FOR_ESTIMATES).
    const kind = cat => String((cat ? (P().kindName ? P().kindName(cat) : P().CATEGORY_NAME[cat]) : '') || 'zz');
    const skip = P().NOT_FOR_ESTIMATES || [];
    const list = Object.values(c.items).filter(it => skip.indexOf(it.category) === -1)
      .map(it => ({ it: it, k: kind(it.category), n: String(it.name) }))
      .sort((a, b) => byText(a.k, b.k) || byText(a.n, b.n));
    supplyList = { html: NO_SUPPLY + list.map(x => supplyOption(x.it, c, false)).join(''),
                   has: new Set(list.map(x => x.it.id)) };
    return supplyList;
  }
  // What a line's dropdown holds until it is used: its own choice only.
  function supplyOptions(selected) {
    const c = catalog(), it = selected ? c.items[selected] : null;
    return NO_SUPPLY + (it ? supplyOption(it, c, true) : '');
  }
  // The whole list, the moment the dropdown is going to be used -- before
  // the search box in front of it (app.js makeSearchable) opens its list,
  // which is why this listens on the way down (capture), not the way back.
  function fillPicker(sel) {
    if (!sel || sel.dataset.full || sel.disabled) return;
    const chosen = sel.value;
    const L = allSupplyOptions();
    // A line already on something no longer offered (an item since made a
    // tool) keeps it as its choice.
    const c = catalog(), it = chosen && !L.has.has(chosen) ? c.items[chosen] : null;
    sel.innerHTML = it ? NO_SUPPLY + supplyOption(it, c, false) + L.html.slice(NO_SUPPLY.length) : L.html;
    sel.value = chosen;
    sel.dataset.full = '1';
  }
  function pickerOf(t) {
    if (!t || t.nodeType !== 1) return null;
    if (t.matches('select.est-supply')) return t;
    const wrap = t.closest('.ssel');
    return wrap && el('estimateWrap') && el('estimateWrap').contains(wrap) ? wrap.querySelector('select.est-supply') : null;
  }
  ['focus', 'pointerdown'].forEach(type => document.addEventListener(type, e => fillPicker(pickerOf(e.target)), true));

  function matHtml(m, i, ro, r) {
    const id = safeId(m.id), dis = ro ? ' disabled' : '';
    const c = catalog();
    const it = m.supplyId ? c.items[m.supplyId] : null;
    const on = (f, v, ph, cls, mode) => '<input class="' + (cls || '') + '"' + (mode ? ' inputmode="' + mode + '"' : '') +
      ' value="' + esc(v == null ? '' : v) + '" placeholder="' + esc(ph || '') + '"' + dis +
      ' oninput="estMat(\'' + id + '\', \'' + f + '\', this.value)">';
    const line = r ? r.takeoff.find(l => l.id === m.id) : null;
    const unit = line ? line.takeoffUnit : (m.unit || '');
    // Every line starts the same way -- what it is, its name, how many --
    // and ends with its amount and ↑ ↓ ✕ at the right. What only some lines
    // have (a typed-in item's unit, cost and kind; a plant's cost and tree;
    // how a bulk item comes) sits between, wrapping under the name when the
    // row is full, so the arrows never drop onto a row of their own
    // (15 Oct 2026: a typed-in line's did).
    let head, extra;
    if (m.plant) {
      head = '<span class="est-plant">🌱</span>' + on('name', m.name, 'Plant, size — e.g. Autumn Blaze maple, 2" cal', 'est-title') +
        '<label><span>How many</span>' + on('qty', m.qty, '', '', 'decimal') + '</label>';
      extra = '<label><span>Cost each</span>' + on('cost', dollarsIn(m.costCents), '0.00', 'est-money', 'decimal') + '</label>' +
        '<label><span>Tree?</span><select' + dis + ' onchange="estMat(\'' + id + '\', \'tree\', this.value)">' +
          [['', 'No'], ['single', 'Single-trunk'], ['multi', 'Multi-trunk / evergreen']].map(([k, n]) =>
            '<option value="' + k + '"' + ((m.tree || '') === k ? ' selected' : '') + '>' + n + '</option>').join('') +
        '</select></label>';
    } else {
      head = '<select class="searchable est-supply"' + dis + ' onchange="estPickSupply(\'' + id + '\', this.value)">' + supplyOptions(m.supplyId) + '</select>' +
        on('name', m.name, 'What the customer reads, e.g. Screened topsoil', 'est-title') +
        '<label><span>Qty' + (unit ? ' (' + esc(unit) + ')' : '') + '</span>' + on('qty', m.qty, '', '', 'decimal') + '</label>';
      extra = (it ? '' : '<label><span>Unit</span>' + on('unit', m.unit, 'each', '') + '</label>' +
          '<label><span>Cost each</span>' + on('cost', dollarsIn(m.costCents), '0.00', 'est-money', 'decimal') + '</label>' +
          // A quote with the sales tax already in it: your tax on purchases
          // is not added again (pricing.js).
          '<label class="est-taxin"><input type="checkbox"' + (m.taxIn ? ' checked' : '') + dis +
            ' onchange="estMat(\'' + id + '\', \'taxIn\', this.checked)"> Cost includes tax</label>' +
          '<label><span>Kind</span><select' + dis + ' onchange="estMat(\'' + id + '\', \'category\', this.value)">' +
            kinds().filter(([k]) => k !== 'plant').map(([k, n]) => '<option value="' + esc(k) + '"' + ((m.category || 'other') === k ? ' selected' : '') + '>' + esc(n) + '</option>').join('') +
          '</select></label>');
    }
    // Under the line, on one row: what is ordered, its sales tax, and More
    // (which line of labor it is for, on the crew's page).
    const forWork = forWorkHtml(m, id, dis) + allInHtml(m, id, dis);
    return '<div class="est-mrow">' +
      '<div class="est-mtop"><div class="est-mfields">' + head + (extra ? '<span class="est-mxs">' + extra + '</span>' : '') + '</div>' +
        '<div class="est-mend"><div class="est-amt" id="estMA_' + id + '"></div>' + moves('mat', id, i, est.materials.length, ro) + '</div></div>' +
      '<div class="est-meta"><div class="est-order" id="estMO_' + id + '"></div>' +
        '<span class="est-way" id="estWY_' + id + '"></span>' +
        taxPickHtml('mat', id, m.taxable, ro) + allInChip(m) +
        (forWork ? moreBtnHtml(id, forWorkSays(m)) : '') + '</div>' +
      (forWork ? moreBoxHtml(id, forWork) : '') +
      (readsAsWork(m) ? workNoteHtml(m, id, ro) : ro ? '' : matchHtml(m, id) + seedPickHtml(m, id)) +
      (m.supplyId && num(m.qty) === null && m.qbText
        ? '<div class="est-match"><span class="muted">QuickBooks: ' + esc(m.qbText) + ' — put in how many</span></div>' : '') +
      '<div class="est-source" id="estMS_' + id + '">' + sourceHtml(m.id) + '</div>' +
      // What the crew lead said about it on this job -- too much, ran short
      // (jobissues.js). A bid has none: nothing has been worked yet.
      (window.YDJobIssues ? YDJobIssues.matHtml(currentJobId, m) : '') +
    '</div>';
  }
  // A line that reads as work (readsAsWork) says so in place of "Which
  // Supplies item is this?", and why it is not on Materials to Order -- with
  // his say either way.
  function workNoteHtml(m, id, ro) {
    if (m.orderIt === true) {
      return '<div class="est-match"><span class="muted">You said this is a material, so it goes on Materials to Order.</span>' +
        (ro ? '' : ' <button type="button" class="link-btn" onclick="estOrderIt(\'' + id + '\', false)">No — it’s work, leave it off</button>') + '</div>';
    }
    return '<div class="est-match"><span class="est-match-q">🛠 This reads as work, not a material</span> ' +
      '<span class="muted">— it is not put on Materials to Order.</span>' +
      (m.qbText ? ' <span class="muted">QuickBooks: ' + esc(m.qbText) + '</span>' : '') +
      (ro ? '' : ' <button type="button" class="link-btn" onclick="estOrderIt(\'' + id + '\', true)">It’s a material — order it</button>') + '</div>';
  }
  window.estOrderIt = function (id, on) {
    const m = find(est.materials, id);
    if (!m || !changes()) return;
    if (on) m.orderIt = true; else delete m.orderIt;
    changed(true);
    // Its line on a Materials to Order already made comes or goes (app.js).
    if (typeof ydOrderWorkSaid === 'function') ydOrderWorkSaid(m.name, !!on);
  };
  // A material not joined to Supplies yet: the items it most likely is, as
  // buttons (supplymatch.js) -- his earlier pick for these words first. Only
  // when nothing is close does it say so (then 🔎 Source it / add to
  // Supplies are the way).
  function matchHtml(m, id) {
    if (m.plant || m.supplyId || !String(m.name || '').trim() || !window.YDMatch) return '';
    const c = catalog();
    const got = YDMatch.match(m, c, P().NOT_FOR_ESTIMATES || []);
    const ids = got.sure ? [got.sure.id].concat(got.options.filter(x => x !== got.sure.id)) : got.options;
    const said = m.qbText ? '<span class="muted">QuickBooks: ' + esc(m.qbText) + '</span>' : '';
    if (!ids.length) {
      return '<div class="est-match">' + said + (said ? '<br>' : '') +
        '<span class="muted">Nothing in Supplies is close — 🔎 Source it, or add it to Supplies.</span></div>';
    }
    return '<div class="est-match"><span class="est-match-q">Which Supplies item is this?</span>' + (said ? ' ' + said : '') +
      '<div class="est-match-opts">' + ids.slice(0, 4).map((sid, k) => {
        const it = c.items[sid], pr = c.prices[sid] || {};
        if (!it) return '';
        const v = c.vendors[it.vendorId];
        const mine = got.sure && got.sure.by === 'yours' && k === 0;
        const usual = got.sure && got.sure.by === 'usual' && k === 0;
        return '<button type="button" class="btn btn-sm' + (k === 0 && got.sure ? ' btn-filled' : '') + '" onclick="estUseMatch(\'' + id + '\', \'' + safeId(sid) + '\')">' +
          (mine || usual ? '✓ ' : '') + esc(it.name) +
          (num(pr.cents) > 0 ? ' · ' + cents(pr.cents) + (pr.per ? '/' + esc(pr.per) : '') + perLbHtml(it, pr) : '') +
          (v ? ' <small>' + esc(v.name) + '</small>' : '') + (mine ? ' <small>(your pick before)</small>' : '') +
          (usual ? ' <small>(your usual seed)</small>' : '') + '</button>';
      }).join('') + '</div></div>';
  }
  // A bag charged by the pound used: its price a pound, to compare mixes.
  function perLbHtml(it, pr) {
    const pk = window.YDMatch && YDMatch.pack ? YDMatch.pack(it, pr) : null;
    return pk && pk.part && pk.lb && num(pr.cents) > 0 ? ' (' + cents(Math.round(pr.cents / pk.lb)) + '/lb)' : '';
  }
  // Picked: joined to the item, the quantity put in its unit where the units
  // meet (else left for him to fill), and remembered for these words.
  window.estUseMatch = function (id, sid) {
    const m = find(est.materials, id);
    const c = catalog();
    const it = c.items[sid];
    if (!m || !it || !changes()) return;
    const f = window.YDMatch ? YDMatch.fitQty(m, it, c.prices[sid]) : null;
    if (window.YDMatch) YDMatch.remember(m.name, sid);
    const was = m.supplyId || null;
    m.supplyId = sid;
    m.handPicked = true;
    if (f) { m.qty = f.qty; m.unit = f.unit || m.unit; }
    else { m.qty = null; m.unit = ''; }
    changed(true);
    // Its line on Materials to Order follows (app.js).
    if (typeof ydOrderJoined === 'function') ydOrderJoined(m.name, sid, was);
    if (!f) showToast('Joined to ' + it.name + ' — put in how many' + (m.qbText ? ' (QuickBooks: ' + m.qbText + ')' : ''), 6000);
  };

  // A grass seed line: the other seeds in Supplies as buttons, each in its
  // biggest bag with its price a pound, his usual one marked. A tap is his
  // pick for this job, which Claude's answers keep (handPicked); the next
  // job is his usual seed again.
  function seedPickHtml(m, id) {
    const M = window.YDMatch;
    if (m.plant || !m.supplyId || !M || !M.isGrassSeed) return '';
    const c = catalog(), it = c.items[m.supplyId];
    if (!it || !M.isGrassSeed(it)) return '';
    const seesPrices = Object.keys(c.prices).length > 0;
    const usual = M.usualSeed(c);
    const ids = [];
    Object.keys(c.items).forEach(k => {
      if (!M.isGrassSeed(c.items[k]) || (seesPrices && !(num((c.prices[k] || {}).cents) > 0))) return;
      const b = M.biggestBag(k, c);
      if (b !== m.supplyId && ids.indexOf(b) === -1) ids.push(b);
    });
    if (!ids.length) return '';
    ids.sort((a, b) => (b === usual) - (a === usual) || String(c.items[a].name).localeCompare(String(c.items[b].name)));
    return '<div class="est-match"><span class="muted">🌱 Another seed for this job:</span><div class="est-match-opts">' +
      ids.map(sid => {
        const o = c.items[sid], pr = c.prices[sid], v = c.vendors[o.vendorId];
        const each = seedPriceText(o, pr);
        return '<button type="button" class="btn btn-sm" title="' + esc(o.name) + '" onclick="estPickSeed(\'' + id + '\', \'' + safeId(sid) + '\')">' +
          esc(seedShort(o.name)) + (each ? ' · ' + each : '') +
          (v || sid === usual ? ' <small>' + [v ? esc(v.name) : '', sid === usual ? 'your usual' : ''].filter(Boolean).join(' · ') + '</small>' : '') +
          '</button>';
      }).join('') + '</div></div>';
  }
  // A seed by its own name, so two fit across a phone: "Madison Parks" of
  // "Madison Parks grass seed 50 lb" (every button is the biggest bag).
  function seedShort(name) {
    const s = String(name || '').replace(/\([^)]*\)/g, ' ').replace(/\b\d+(\.\d+)?\s*(lbs?|#|pounds?)(?![a-z])/gi, ' ')
      .replace(/\b(grass\s+)?seed(\s+(mix|blend))?\b/gi, ' ').replace(/\s+/g, ' ').trim();
    return s || String(name || '');
  }
  // Seeds compared by the pound: a bag's price over its weight, or the price
  // of one sold by the pound.
  function seedPriceText(it, pr) {
    if (!pr || !(num(pr.cents) > 0)) return '';
    const pk = YDMatch.pack(it, pr);
    return pk.lb ? cents(Math.round(pr.cents / pk.lb)) + '/lb' : cents(pr.cents) + (pr.per ? '/' + esc(pr.per) : '');
  }
  window.estPickSeed = function (id, sid) {
    const m = find(est.materials, id);
    const c = catalog(), it = c.items[sid], M = window.YDMatch;
    if (!m || !it || !M || !changes()) return;
    const was = m.supplyId || null, from = was ? c.items[was] : null;
    // The amount carried over in the new seed's measure (seedAsBought); else asked for.
    const f = from ? M.fitQty({ qty: m.qty, unit: m.unit || measuredIn(from, c.prices[was]) }, it, c.prices[sid]) : null;
    if (!String(m.name || '').trim() || (from && m.name === from.name)) m.name = it.name || '';
    m.supplyId = sid;
    m.handPicked = true;
    if (f) { m.qty = f.qty; m.unit = M.unitKey(f.unit) === 'lb' ? 'lb' : ''; }
    else { m.qty = null; m.unit = ''; }
    changed(true);
    if (typeof ydOrderJoined === 'function') ydOrderJoined(m.name, sid, was);
    if (!f) showToast('Now ' + it.name + ' — put in how many ' + (measuredIn(it, c.prices[sid]) || 'of it'), 6000);
  };

  // A bag bought whole and charged by the part used (grass seed): what the
  // job uses and the price a pound -- "uses 3.3 lb · $4.14/lb from the 50 lb
  // bag".
  function partUseText(l) {
    if (!l.partUse || !l.usedQty) return '';
    const used = l.usedLb ? fmtQ(l.usedLb) + ' lb' : P().qtyText(l.usedQty, l.per);
    return ' — charged for the ' + used + ' used' +
      (l.perLbCents > 0 && l.packLb ? ' · ' + cents(Math.round(l.perLbCents)) + '/lb from the ' + fmtQ(l.packLb) + ' lb bag' : '');
  }

  // How an all-in figure splits (pricing.js workLine): what the materials in
  // it come to, and the labour left -- the labour is what the line charges.
  function allInSplitHtml(a) {
    if (!a) return '';
    if (!a.count) {
      return '<span class="muted">No materials are in its all-in price yet, so all of it is labor. ' +
        'Pick “Its price is in …” under a material’s More ▾ (or ask Claude).</span>';
    }
    const mats = a.materialsCents + a.deliveryCents;
    return 'The ' + a.count + ' material' + (a.count === 1 ? '' : 's') + ' in it come to <b>' + cents(mats) + '</b>' +
      (a.deliveryCents ? ' (' + cents(a.deliveryCents) + ' of it delivery)' : '') +
      (a.labourCents === null || a.cents === null ? ''
        : ' → labor <b>' + cents(a.labourCents) + '</b> of the ' + cents(a.cents) +
          (a.addCents ? ', + ' + cents(a.addCents) + ' not in it' : '')) + '.';
  }
  // The same split in words, put under Claude's answer in the conversation
  // when it changed the estimate -- the sum it never does itself.
  function allInSays(r, e) {
    return r.work.map((w, i) => {
      const a = w.allIn;
      if (!a || a.labourCents === null || a.cents === null) return '';
      const t = String((e.work[i] || {}).title || '').trim() || 'The all-in line';
      return t + ': ' + cents(a.cents) + ' all-in − ' + cents(a.materialsCents + a.deliveryCents) + ' for its ' + a.count +
        ' material' + (a.count === 1 ? '' : 's') + ' = ' + cents(a.labourCents) + ' labor' +
        (a.addCents ? ', + ' + cents(a.addCents) + ' not in the all-in = ' + cents(w.cents) + ' on the line' : '') + '.';
    }).filter(Boolean).join('\n');
  }

  // Everything that depends on the numbers, redrawn without touching what is
  // being typed in.
  function renderTotals() {
    const t = el('estTotals');
    if (!t || !P()) return;
    const r = priced();
    const usual = P().defaultProfitCents ? P().defaultProfitCents() : null;
    r.work.forEach((w, i) => {
      const a = el('estWA_' + safeId(w.id)); if (a) a.textContent = w.cents ? cents(w.cents) : '';
      const p = el('estWP_' + safeId(w.id)); if (p) p.textContent = w.problems.join(' · ');
      const tx = el('estWT_' + safeId(w.id));
      if (tx) tx.textContent = taxNote(w, r, typeof (est.work[i] || {}).taxable === 'boolean');
      const ai = el('estWI_' + safeId(w.id));
      if (ai) ai.innerHTML = allInSplitHtml(w.allIn);
      // What a line priced by the unit (or a fixed price) makes per crew-day
      // once the crew is paid, against his usual -- only he sees it.
      const f = el('estWF_' + safeId(w.id));
      if (!f) return;
      // His numbers stay out of sight until he asks for them ("Show my
      // numbers"): bids are built on the iPad in front of the customer.
      if (!numbersShown) { f.innerHTML = ''; return; }
      const kind = (est.work[i] || {}).kind || 'crew';
      // Done by someone else: what is left of the line once they are paid.
      if (w.sub) {
        f.innerHTML = !w.cents ? '' : w.sub.cents === null
          ? '<span class="muted">Put in what ' + esc(w.sub.by || 'they') + ' charge' + (w.sub.by ? 's' : '') + ' you to see what it makes.</span>'
          : 'Makes <b>' + cents(w.cents - w.sub.cents) + '</b> over what ' + esc(w.sub.by || 'they') + ' charge' + (w.sub.by ? 's' : '') + ' you' +
            (w.cents > 0 ? ' <span class="muted">(' + Math.round((w.cents - w.sub.cents) / w.cents * 100) + '%)</span>' : '');
        return;
      }
      if (kind === 'crew' || !w.cents) { f.innerHTML = ''; return; }
      if (w.profitPerDayCents === null) {
        f.innerHTML = '<span class="muted">Put in its crew-days to see what it makes per day.</span>';
        return;
      }
      const vs = usual === null ? '' : w.profitPerDayCents >= usual
        ? ' <span class="est-good">— ' + perDay(w.profitPerDayCents - usual) + ' more than your usual</span>'
        : ' <span class="est-low">— ' + perDay(usual - w.profitPerDayCents) + ' under your usual</span>';
      f.innerHTML = 'Makes <b>' + perDay(w.profitPerDayCents) + '</b> after the crew' + vs;
    });
    r.takeoff.forEach(l => {
      // Accepted in QuickBooks, a material's own line shows what it costs
      // him -- the customer's figure is the one for all of them.
      const a = el('estMA_' + safeId(l.id));
      if (a) a.textContent = r.asAccepted ? (l.costTotalCents ? 'cost ' + cents(l.costTotalCents) : '')
        : l.clientCents ? cents(l.clientCents) : '';
      const tx = el('estMT_' + safeId(l.id));
      if (tx) tx.textContent = taxNote(l, r, typeof (find(est.materials, safeId(l.id)) || {}).taxable === 'boolean');
      const wy = el('estWY_' + safeId(l.id));
      if (wy) wy.innerHTML = wayPickHtml(l, find(est.materials, safeId(l.id)), !changes());
      const o = el('estMO_' + safeId(l.id));
      if (o) {
        o.className = 'est-order' + (l.problems.length ? ' bad' : '');
        o.innerHTML = l.problems.length ? '⚠ ' + esc(l.problems.join(' · ')) +
            (canSource() && unpriced(l) && !(found[foundKey(l.id)] || {}).busy
              ? ' <button class="link-btn" onclick="estSource(\'' + safeId(l.id) + '\')">🔎 Source it</button>' : '')
          : l.orderQty ? esc((l.rentalPlan ? 'Rent ' + P().qtyText(l.orderQty, l.per) + ' — charged as ' + l.rentalPlan
                                             : 'Order ' + P().qtyText(l.orderQty, l.per)) +
            (l.wastePct ? ' (+' + fmtQ(l.wastePct) + '% waste)' : '') + partUseText(l) + (l.specialOrder ? ' · special order' : '') +
            // A rental is priced in, never named to the customer (pricing.js NOT_LISTED).
            (l.category === 'rental' ? ' · not shown to the customer — on the crew’s page with where to pick it up' : '')) : '';
      }
    });
    const toSource = canSource() ? r.takeoff.filter(l => unpriced(l) && !(found[foundKey(l.id)] || {}).busy) : [];
    renderAuto(r);
    renderCustomer(r);
    const pays = r.payments;
    t.innerHTML = (r.work.length || r.takeoff.length)
      ? '<div><span>Materials</span><b>' + cents(r.materialsCents) + '</b></div>' +
        '<div><span>Labor & installation</span><b>' + cents(r.laborCents) + '</b></div>' +
        taxRowsHtml(r) +
        '<div class="est-grand"><span>Project total</span><b>' + cents(r.grandCents) + '</b></div>' +
        paymentsHtml(r) +
        profitHtml(r) +
        (r.problems.length ? '<div class="est-problems"><b>Not priced yet:</b><ul>' + r.problems.map(p => '<li>' + esc(p) + '</li>').join('') + '</ul>' +
          (toSource.length > 1 ? '<button class="btn btn-sm" onclick="estSource(\'all\')">🔎 Source all ' + toSource.length + ' unpriced materials</button>' : '') +
          '</div>' : '') +
        ((r.noCost || []).length ? '<div class="est-problems"><b>Costs not known yet</b> <span class="muted">— the price stays as ' +
            'accepted; this is only for what the job makes and what to order. A material: pick its item, or 🔎 Source it:</span><ul>' +
            r.noCost.map(p => '<li>' + esc(p) + '</li>').join('') + '</ul>' +
          (toSource.length > 1 ? '<button class="btn btn-sm" onclick="estSource(\'all\')">🔎 Source all ' + toSource.length + '</button>' : '') +
          '</div>' : '') +
        (r.specialOrder.length ? '<div class="warn">Special order (non-returnable — lock their selections first): ' + r.specialOrder.map(esc).join(', ') + '</div>' : '')
      : '';
    renderQb();
  }
  const fmtQ = q => String(Math.round(q * 100) / 100);

  // The sales tax under the subtotal: on what, at what rate -- or why a job
  // with some planting has none (a building job, planting under 10%).
  function taxRowsHtml(r) {
    const t = r.tax || {};
    if (t.fromQb) return t.cents > 0 ? '<div><span>Subtotal</span><b>' + cents(r.totalCents) + '</b></div>' +
      '<div><span>Sales tax (as QuickBooks worked it out)</span><b>' + cents(t.cents) + '</b></div>' : '';
    if (t.underTen) return '<div class="est-taxnote">No sales tax: the planting and lawn work is under 10% of a building job ' +
      '(Wisconsin taxes none of it then — you pay the tax on its materials when you buy them).</div>';
    if (!(t.taxableCents > 0)) return '';
    return '<div><span>Subtotal</span><b>' + cents(r.totalCents) + '</b></div>' +
      '<div><span>Sales tax' + (t.ratePct !== null ? ' ' + fmtQ(t.ratePct) + '%' : '') + ' on ' + cents(t.taxableCents) +
        ' of planting & lawn work</span><b>' + (t.ratePct !== null ? cents(t.cents) : '—') + '</b></div>' +
      '<div class="est-taxnote">QuickBooks works out the exact tax from the job’s address.</div>';
  }

  // The payments the customer is asked for (pricing.js payments): the usual,
  // or this estimate's own -- each a % of the job or a dollar amount typed
  // in, the last always the rest. The deposit never goes under his minimum
  // or the materials; when it was raised the line says so.
  let editingPays = false;
  function planNow(r) {
    return est.payments || cleanPlan(P().usualPlan ? P().usualPlan(r ? r.grandCents : 0) : []);
  }
  function paymentsHtml(r) {
    const pays = r.payments || [];
    if (!pays.length) return '';
    const ro = !changes();
    const raised = pays[0].raised;
    const note = raised ? '<div class="est-pay-note">Deposit raised to ' + (raised === 'materials'
      ? 'cover all the materials (' + cents(r.materialsCents + r.tax.materialsTaxCents) + ')' : 'your ' + pays[0].minPct + '% smallest deposit') + '.</div>' : '';
    if (!editingPays || ro) {
      return '<div class="est-pays">' + pays.map(p => '<span>' + esc(p.label) + ' <b>' + cents(p.cents) + '</b></span>').join(' · ') +
        (est.payments ? ' <span class="muted">(set for this estimate)</span>' : '') +
        (ro ? '' : ' <button class="link-btn" onclick="estPays(\'edit\')">✎ Change the payments</button>') + '</div>' + note;
    }
    const plan = planNow(r);
    return '<div class="est-pay-edit">' + plan.map((s, i) => {
      const lastOne = i === plan.length - 1;
      const shown = s.how === 'amount' ? (num(s.value) === null ? '' : (s.value / 100).toFixed(2)) : (num(s.value) === null ? '' : String(s.value));
      return '<div class="est-pay-row">' +
        '<input class="est-pay-label" value="' + esc(s.label) + '" placeholder="' + (i === 0 ? 'Deposit' : lastOne ? 'Final' : 'Payment') + '"' +
          ' onchange="estPaySet(' + i + ', \'label\', this.value)">' +
        (lastOne ? '<span class="muted">the rest</span>'
          : '<select onchange="estPaySet(' + i + ', \'how\', this.value)"><option value="pct"' + (s.how !== 'amount' ? ' selected' : '') + '>% of the job</option>' +
              '<option value="amount"' + (s.how === 'amount' ? ' selected' : '') + '>$ amount</option></select>' +
            '<input class="est-pay-val" inputmode="decimal" value="' + esc(shown) + '" placeholder="' + (s.how === 'amount' ? '0.00' : '50') + '"' +
              ' onchange="estPaySet(' + i + ', \'value\', this.value)">') +
        '<b>' + (pays[i] ? cents(pays[i].cents) : '') + '</b>' +
        (!lastOne && i > 0 ? '<button class="bd-edit-btn del" onclick="estPaySet(' + i + ', \'remove\')" aria-label="Remove">✕</button>' : '') +
      '</div>';
    }).join('') + note +
      '<div class="field-actions">' +
        '<button class="btn btn-sm" onclick="estPays(\'add\')">+ Add a payment</button>' +
        '<button class="btn btn-sm" onclick="estPays(\'usual\')">Back to the usual</button>' +
        '<button class="btn btn-sm btn-filled" onclick="estPays(\'done\')">Done</button>' +
      '</div>' +
      '<div class="hint">The deposit can’t go under your smallest deposit or the materials (Pricing rules). ' +
        'The payments go on the estimate’s message unless you’ve written your own message.</div>' +
    '</div>';
  }
  window.estPays = function (what) {
    if (!changes()) return;
    const r = last || priced();
    if (what === 'edit') { editingPays = true; renderTotals(); return; }
    if (what === 'done') { editingPays = false; renderTotals(); return; }
    if (what === 'usual') { est.payments = null; editingPays = false; changed(false); return; }
    if (what === 'add') {
      const plan = planNow(r).slice();
      plan.splice(Math.max(1, plan.length - 1), 0, { label: 'Payment', how: 'pct', value: 25 });
      est.payments = cleanPlan(plan);
      changed(false);
    }
  };
  window.estPaySet = function (i, field, v) {
    if (!changes()) return;
    const plan = planNow(last || priced()).map(s => Object.assign({}, s));
    const s = plan[i];
    if (!s) return;
    if (field === 'remove') { if (i > 0 && i < plan.length - 1) plan.splice(i, 1); }
    else if (field === 'label') s.label = String(v || '').trim();
    else if (field === 'how') { s.how = v === 'amount' ? 'amount' : 'pct'; s.value = null; }
    else if (field === 'value') {
      const n = String(v || '').replace(/[$,%\s]/g, '');
      const f = n === '' ? null : parseFloat(n);
      if (f !== null && !isFinite(f)) { showToast('That should be a number'); renderTotals(); return; }
      s.value = f === null ? null : s.how === 'amount' ? Math.round(f * 100) : Math.round(f * 100) / 100;
    }
    est.payments = cleanPlan(plan);
    changed(false);
  };

  // The whole job's profit once everything is paid for -- materials at cost,
  // delivery and fuel at cost, the crew at the crew-day rate -- and per
  // crew-day. Only he sees it (the customer view and QuickBooks never do).
  // Jonah (13 Oct 2026): "when building a bid [show] my actual cost for
  // material & my total profit along with the profit margin & profit per day
  // & estimated total labor costs."
  //
  // Folded away until asked for (15 Oct 2026: bids are built on the iPad in
  // front of the customer), and remembered on this device. A two-column
  // table, so it fits a phone (laid out as one long row, it ran 1,100 px
  // wide and mostly off the screen).
  const NUMBERS_KEY = 'ydjobhub_estNumbers';
  let numbersShown = (() => { try { return localStorage.getItem(NUMBERS_KEY) === '1'; } catch (e) { return false; } })();
  window.estNumbers = function () {
    numbersShown = !numbersShown;
    try { if (numbersShown) localStorage.setItem(NUMBERS_KEY, '1'); else localStorage.removeItem(NUMBERS_KEY); } catch (e) { /* private window */ }
    renderTotals();
  };
  function profitHtml(r) {
    const p = r.profit;
    if (!p || !(r.totalCents > 0)) return '';
    // Planned profit stays with whoever may change jobs: a look-only admin
    // (a crew lead given Jobs "see") gets the estimate, not the margins --
    // as before the look-only buttons were made to work (16 Oct 2026).
    if (!(typeof ydCan === 'function' && ydCan('jobs', 'change'))) return '';
    if (!numbersShown) {
      return '<div class="est-planned-show"><button class="link-btn ro-ok" onclick="estNumbers()">📊 Show my numbers</button></div>';
    }
    const why = !p.complete ? '<p class="est-planned-why">Not final — ' +
      (r.problems.length ? 'some lines aren’t priced yet'
        : r.work.some(w => w.sub && w.sub.cents === null) ? 'a line done by someone else has no charge yet'
        : r.work.some(w => !w.sub && !w.crewDays) ? 'a labor line has no crew-days' : 'the crew-day rate isn’t set') + '.</p>' : '';
    const row = (label, value, cls) => '<tr' + (cls ? ' class="' + cls + '"' : '') + '><th scope="row">' + label + '</th><td>' + value + '</td></tr>';
    const days = p.crewDays > 0 ? fmtQ(p.crewDays) + ' crew-day' + (p.crewDays === 1 ? '' : 's') : 'no crew-days yet';
    // Lines done by someone else: who, and what they charge (a line with
    // no charge yet is counted as nothing until it has one).
    const subs = (p.subs || []).filter(s => s.cents !== null || s.by);
    const subNames = subs.map(s => esc(s.by || s.title || 'someone') + (s.cents === null ? ' (not put in)' : '')).join(', ');
    return '<div class="est-planned">' +
      '<div class="est-planned-h"><span>Planned profit <span class="muted">— only you see this</span></span>' +
        '<button class="link-btn ro-ok" onclick="estNumbers()">Hide</button></div>' +
      '<table class="est-plan"><tbody>' +
        row('Material cost <small>what you pay, tax in</small>', cents(p.materialCostCents)) +
        (p.deliveryCostCents ? row('Delivery cost', cents(p.deliveryCostCents)) : '') +
        (p.fuelCostCents ? row('Fuel cost', cents(p.fuelCostCents)) : '') +
        row('Labor cost <small>' + days + ' at your crew-day rate</small>', cents(p.laborCostCents)) +
        (subs.length ? row('Subs &amp; installers <small>' + subNames + '</small>', cents(p.subCostCents || 0)) : '') +
        row('Total cost', cents(p.costCents), 'est-plan-sub') +
        row('Profit', cents(p.cents), 'est-plan-big') +
        row('Profit margin', p.marginPct === null ? '—' : (Math.round(p.marginPct * 10) / 10) + '%') +
        row('Profit per crew-day' + (subs.length ? ' <small>your own crew’s days</small>' : ''),
          p.perDayCents === null ? (subs.length && !r.work.some(w => !w.sub) ? '— all done by others' : '— put in crew-days') : perDay(p.perDayCents)) +
      '</tbody></table>' + why + serviceRowsHtml(est, r) +
    '</div>';
  }
  // Each piece of work: its labour and materials, what it costs and what it
  // makes (pricing.js byLine). Shown once there are two or more: with one,
  // the table above is that line.
  function serviceSplit(e, r) {
    if (!P() || !P().byLine || !r) return null;
    const items = catalog().items;
    const workFor = window.YDCrewJobs && YDCrewJobs.workFor ? YDCrewJobs.workFor : null;
    const split = P().byLine(e, r, workFor ? (m, lines) => workFor(m, lines, items) : null);
    split.lines.forEach(l => {
      const s = window.YDServices && YDServices.serviceFor ? YDServices.serviceFor(l.w) : null;
      l.service = s ? s.name : '';
    });
    return split;
  }
  function serviceRowsHtml(e, r) {
    const split = serviceSplit(e, r);
    if (!split) return '';
    const lines = split.lines.filter(l => l.priceCents > 0 || l.costCents > 0);
    if (lines.length < 2) return '';
    const pctTxt = m => m === null ? '' : ' · ' + Math.round(m) + '%';
    const one = l => {
      const name = l.title || l.service || 'A piece of work';
      const svc = l.service && l.service.toLowerCase() !== name.toLowerCase() ? ' <span class="muted">(' + esc(l.service) + ')</span>' : '';
      const cls = l.profitCents < 0 ? 'est-svc-bad' : 'est-svc-good';
      return '<div class="est-svc">' +
        '<div class="est-svc-h"><span><b>' + esc(name) + '</b>' + svc + (l.complete ? '' : ' <span class="muted" title="Not final: a line or material isn’t priced, or no crew-days">?</span>') + '</span>' +
          '<span class="' + cls + '">' + cents(l.profitCents) + pctTxt(l.marginPct) + '</span></div>' +
        '<div class="est-svc-sub">Labor ' + cents(l.laborCents) + ' + materials ' + cents(l.materialsCents) +
          ' = ' + cents(l.priceCents) + ' · cost ' + cents(l.costCents) +
          (l.sub ? ' · done by ' + esc(l.sub.by || 'someone else') + (l.sub.cents === null ? ' (their charge not put in)' : ' for ' + cents(l.sub.cents))
            : l.perDayCents !== null ? ' · ' + perDay(l.perDayCents) : ' · no crew-days') + '</div></div>';
    };
    const rest = split.rest;
    const restHtml = Math.abs(rest.priceCents) > 100 || Math.abs(rest.costCents) > 100
      ? '<div class="est-svc est-svc-rest"><div class="est-svc-h"><span>Not under a piece of work</span><span>' + cents(rest.profitCents) + '</span></div>' +
        '<div class="est-svc-sub">' + cents(rest.priceCents) + ' · cost ' + cents(rest.costCents) +
          (rest.materials.length ? ' — ' + esc(rest.materials.slice(0, 6).join(', ')) + (rest.materials.length > 6 ? '…' : '') +
            '. Pick “For the crew, this is for” on a material to count it under a line.' : '') + '</div></div>'
      : '';
    return '<div class="est-svcs"><div class="est-svcs-h">By piece of work</div>' + lines.map(one).join('') + restHtml +
      '<p class="est-planned-why">Materials go with the line the crew’s page lists them under; fuel by crew-days. All Jobs → Estimate vs actual adds these up by service.</p></div>';
  }

  // The estimate as the customer will read it in QuickBooks -- the same lines
  // estToQB sends and quickbooks.py lays out: each piece of labour with its
  // heading (the site address on the first) and scope, one materials line
  // listing everything with one price, the total and the message. No unit
  // prices anywhere, as on the real thing.
  let showCustomer = false;
  window.estToggleCustomer = function () { showCustomer = !showCustomer; render(); };
  function siteLine() {
    const f = id => (el(id) && el(id).value || '').trim();
    return [tidyCase(f('address')), [tidyCase(f('city')), stateWord(f('state'))].filter(Boolean).join(', ') + (f('zip') ? ' ' + f('zip') : '')]
      .filter(s => s.trim()).join(', ');
  }
  // An address typed all in small letters ("123 main st") reads properly
  // on the estimate ("123 Main St"). Anything with a capital in it is left
  // exactly as typed.
  function tidyCase(s) {
    s = String(s || '').trim();
    if (!s || s !== s.toLowerCase()) return s;
    return s.replace(/(^|[\s,\-\/(])([a-z])/g, (m, before, letter) => before + letter.toUpperCase());
  }
  const stateWord = s => /^[a-z]{2}$/i.test(String(s || '').trim()) ? String(s).trim().toUpperCase() : tidyCase(s);
  // A scope often starts with its line's own title, which the estimate
  // already shows as the line's heading -- once is enough.
  function scopeBody(w) {
    const scope = String(w.scope || '').trim();
    const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const first = scope.split('\n')[0];
    return words(w.title) && words(first) === words(w.title) ? scope.slice(first.length).trim() : scope;
  }
  // The materials as the customer reads them: one line, or two when some
  // are taxed and some are not (planting materials on a patio job) -- each
  // with what is on it. The same split goes to QuickBooks.
  // rest: the materials still on the Materials line once some went into a
  // work line's price (customerLines) -- {takeoff, added, cents, taxedCents}.
  function materialParts(r, work, rest) {
    const src = rest || r;
    const total = rest ? rest.cents : r.materialsCents;
    if (!(total > 0)) return [];
    const taxedCents = rest ? rest.taxedCents : (r.tax ? r.tax.materialsCents : 0);
    const one = work.length === 1 && work[0].title ? 'Materials: ' + work[0].title : 'Materials';
    if (!(taxedCents > 0)) return [{ head: one, list: P().materialsList(src), cents: total, taxed: false }];
    if (taxedCents >= total) return [{ head: one, list: P().materialsList(src), cents: total, taxed: true }];
    return [{ head: 'Materials', list: P().materialsList(src, false), cents: total - taxedCents, taxed: false },
            { head: 'Planting & lawn materials', list: P().materialsList(src, true), cents: taxedCents, taxed: true }];
  }

  // The estimate as the customer reads it -- here and in QuickBooks, from
  // the one place. A work line ticked "Its materials in this price"
  // (w.withMats; Jonah, 22 Oct 2026: "material and install for the steel
  // edging should be one line item separated from the granite one") is
  // priced with its own materials -- the ones the crew's page lists under it
  // (crewjobs.js workFor: picked on the material, else by the words) -- and
  // their share of any delivery; they leave the Materials line and are named
  // under the line's description instead. A material taxed differently from
  // the line stays on the Materials line, so the tax still comes out right.
  function customerLines(r) {
    const items = catalog().items;
    const lines = est.work.filter(w => w && (w.title || w.scope || w.crewNote));
    const workFor = window.YDCrewJobs && YDCrewJobs.workFor ? YDCrewJobs.workFor : (m => m.forWork || '');
    const taxedOf = {}, moved = {};
    est.work.forEach((w, i) => { taxedOf[w.id] = !!(r.work[i] && r.work[i].taxed); });
    const wants = {};
    est.work.forEach(w => { if (w.withMats && w.kind !== 'allin') wants[w.id] = true; });
    est.materials.forEach(m => {
      const l = r.takeoff.find(x => x.id === m.id);
      if (!l || !(l.clientCents > 0)) return;
      const wid = workFor(m, lines, items);
      if (wid && wants[wid] && !!l.taxed === taxedOf[wid]) moved[l.id] = wid;
    });
    // Their share of a truck that also brings other material, by quantity.
    const delOf = {};
    let movedCents = 0, movedTaxed = 0;
    ((r.delivery && r.delivery.lines) || []).forEach(d => {
      const parts = d.parts || [], all = parts.reduce((s, p) => s + p.qty, 0);
      if (!(all > 0)) return;
      parts.forEach(p => {
        const wid = moved[p.id];
        if (!wid) return;
        const c = Math.round(d.clientCents * p.qty / all);
        delOf[wid] = (delOf[wid] || 0) + c;
        movedCents += c;
        if (taxedOf[wid]) movedTaxed += c;
      });
    });
    const named = l => l.name + ': ' + (l.partUse && l.usedLb ? P().qtyText(l.usedLb, 'lb') : P().qtyText(l.orderQty, l.per));
    const work = est.work.map((w, i) => {
      const mine = r.takeoff.filter(l => moved[l.id] === w.id);
      const matsCents = mine.reduce((s, l) => s + l.clientCents, 0);
      movedCents += matsCents;
      if (taxedOf[w.id]) movedTaxed += matsCents;
      return { id: w.id, title: w.title || '', scope: scopeBody(w), cents: r.work[i].cents + matsCents + (delOf[w.id] || 0),
               qbItem: w.qbItem || '', taxable: taxedOf[w.id],
               includes: mine.filter(l => l.listed && l.orderQty > 0).map(named) };
    }).filter(w => w.cents > 0 || w.scope.trim());
    if (!Object.keys(moved).length) return { work: work, parts: materialParts(r, work) };
    const rest = { takeoff: r.takeoff.filter(l => !moved[l.id]), added: r.added, cents: r.materialsCents - movedCents,
                   taxedCents: Math.max(0, (r.tax ? r.tax.materialsCents : 0) - movedTaxed) };
    return { work: work, parts: materialParts(r, work, rest) };
  }
  // A line's description with the materials in its price named after it.
  const withIncludes = w => w.scope.trim() + (w.includes && w.includes.length
    ? (w.scope.trim() ? '\n\n' : '') + 'Materials included: ' + w.includes.join('; ') : '');
  function renderCustomer(r) {
    const box = el('estCustomer');
    if (!box) return;
    if (!showCustomer || !r) { box.innerHTML = ''; return; }
    const site = siteLine();
    const cl = customerLines(r), work = cl.work;
    const rows = work.map((w, i) => '<div class="cv-line"><div class="cv-text">' +
        (w.title ? '<b>' + esc(w.title.toUpperCase()) + '</b>' : '') +
        (i === 0 && site ? '<div>' + esc(site) + '</div>' : '') +
        (withIncludes(w) ? '<div class="cv-scope">' + esc(withIncludes(w)) + '</div>' : '') +
      '</div><div class="cv-amt">' + cents(w.cents) + '</div></div>');
    cl.parts.forEach(m => {
      rows.push('<div class="cv-line"><div class="cv-text"><b>' + esc(m.head) + '</b>' +
        '<div class="cv-scope">' + m.list.map(esc).join('<br>') + '</div></div>' +
        '<div class="cv-amt">' + cents(m.cents) + '</div></div>');
    });
    // The warranty and the terms end every estimate: QuickBooks products
    // (Pricing rules), shown with their text once QuickBooks has answered.
    const ends = P().endItems(whoFor());
    if (ends.length && sends()) P().loadQbProducts();
    ends.forEach(n => {
      const p = P().qbProduct(n);
      const text = p ? p.text.trim() : p === null ? 'Not in QuickBooks yet — add this product (with its text) before sending.' : '';
      rows.push('<div class="cv-line cv-end"><div class="cv-text"><b>' + esc(n) + '</b>' +
        (text ? '<div class="cv-scope' + (p ? '' : ' warn-text') + '">' + esc(text) + '</div>' : '') +
        '</div><div class="cv-amt">' + cents(0) + '</div></div>');
    });
    const memo = String(est.memo || '').trim() || defaultMemo(r.totalCents);
    box.innerHTML = '<div class="cv">' +
      '<div class="cv-head"><b>' + esc((el('customerName') && el('customerName').value) || 'Customer') + '</b>' +
        (qb() && qb().docNumber ? ' · Estimate #' + esc(qb().docNumber) : '') + '</div>' +
      rows.join('') +
      (r.tax && r.tax.cents > 0 ? '<div class="cv-sub"><span>Subtotal</span><span>' + cents(r.totalCents) + '</span></div>' +
        '<div class="cv-sub"><span>Sales tax</span><span>' + cents(r.tax.cents) + '</span></div>' : '') +
      '<div class="cv-total"><span>Total</span><b>' + cents(r.grandCents) + '</b></div>' +
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
    // Delivery. Accepted in QuickBooks: nothing goes on the price, but what
    // MDS charges to bring it is what the job costs -- shown at cost.
    const d = r.delivery;
    const rates = (P().rules().delivery || {}).rates || {};
    const towns = Object.keys(rates).filter(k => num(rates[k]) !== null).sort();
    // A zone picked from the address (Madison) is shown, and can be changed.
    const needTown = d.problems.some(p => /town|rate|zone/.test(p)) || est.deliveryTown || d.deliveryZone;
    const delCost = d.lines.reduce((s, l) => s + (l.costCents || 0), 0);
    const delAmt = r.asAccepted ? (delCost ? 'cost ' + cents(delCost) : '') : (d.clientCents ? cents(d.clientCents) : '');
    rows.push('<div class="est-arow" data-auto="delivery">' + sw('delivery', 'Delivery') + '<span class="est-adesc">' +
      (off.delivery ? 'off' : d.lines.length ? d.lines.map(l => esc(l.name) + ' — ' + l.loads + ' load' + (l.loads === 1 ? '' : 's') + (l.pallet ? ' + pallet' : '')).join('; ')
        : 'nothing delivered') +
      (d.deliveryZone && !off.delivery && d.lines.length ? ' · <b>' + esc(d.deliveryZone) + '</b> (from the address)' : '') +
      (r.asAccepted && !off.delivery && d.problems.length ? ' <span class="bad">⚠ ' + esc(d.problems.join(' · ')) + '</span>' : '') + '</span>' +
      (needTown && !off.delivery ? '<select' + (ro ? ' disabled' : '') + ' onchange="estSet(\'deliveryTown\', this.value)"><option value="">' +
        (d.deliveryZone ? 'Zone: from the address' : 'Town: from the job') + '</option>' +
        towns.map(t => '<option' + (t === est.deliveryTown ? ' selected' : '') + '>' + esc(t) + '</option>').join('') + '</select>' : '') +
      '<b>' + delAmt + '</b></div>');
    // Fuel: a drive from the shop and back each day of the job, both trucks.
    // The miles look themselves up from the job's address (autoTrip) -- no
    // button to press (Jonah, 21 Oct 2026); a number typed in the box stays
    // his. Accepted in QuickBooks: at cost, over the job's own days.
    const f = r.fuel, fu = est.fuel || {};
    const fp = P().fuelPrices() || {};
    const hasAddr = !!(el('address') && el('address').value.trim());
    const missed = !tripping && tripMissed[currentJobId] && tripMissed[currentJobId] === siteKey();
    const milesNote = tripping ? 'Looking up the miles…'
      : missed ? 'Couldn’t find this address on the map — type the miles. <button type="button" class="link-btn" onclick="estFindMiles(true)">Try again</button>'
      : !hasAddr ? 'Add the job’s address and the miles fill in by themselves.'
      : num(fu.miles) === null ? ''
      : (fu.milesAt ? 'by road from your shop · ' : '') + 'there and back each day';
    const fuelAmt = r.asAccepted ? (f.costCents ? 'cost ' + cents(f.costCents) : '') : (f.clientCents ? cents(f.clientCents) : '');
    rows.push('<div class="est-arow" data-auto="fuel">' + sw('fuel', 'Fuel') + '<span class="est-adesc">' + (off.fuel ? 'off' :
        '<label>Miles each way <input inputmode="decimal" value="' + esc(fu.miles == null ? '' : fu.miles) + '"' + (ro ? ' disabled' : '') + ' oninput="estFuel(\'miles\', this.value)"></label>' +
        '<small class="est-miles-note">' + milesNote + '</small>' +
        '<label>' + (r.asAccepted ? 'Days (clocked + on the Job schedule)' : 'Days') + ' <input inputmode="decimal" placeholder="' + esc(f.days == null ? '' : f.days) + '" value="' + esc(fu.jobDays == null ? '' : fu.jobDays) + '"' + (ro ? ' disabled' : '') + ' oninput="estFuel(\'jobDays\', this.value)"></label>' +
        '<label>Loader days <input inputmode="decimal" placeholder="' + esc(f.bobcatDays == null ? '' : f.bobcatDays) + '" value="' + esc(fu.bobcatDays == null ? '' : fu.bobcatDays) + '"' + (ro ? ' disabled' : '') + ' oninput="estFuel(\'bobcatDays\', this.value)"></label>' +
        '<label>Gas $/gal <input inputmode="decimal" placeholder="' + esc(num(fp.gasCents) !== null ? (fp.gasCents / 100).toFixed(2) : '') + '" value="' + esc(fu.gasCents == null ? '' : (fu.gasCents / 100).toFixed(2)) + '"' + (ro ? ' disabled' : '') + ' oninput="estFuel(\'gasCents\', this.value)"></label>' +
        '<label>Diesel <input inputmode="decimal" placeholder="' + esc(num(fp.dieselCents) !== null ? (fp.dieselCents / 100).toFixed(2) : '') + '" value="' + esc(fu.dieselCents == null ? '' : (fu.dieselCents / 100).toFixed(2)) + '"' + (ro ? ' disabled' : '') + ' oninput="estFuel(\'dieselCents\', this.value)"></label>' +
        (fp.asOf ? '<small class="muted">prices week of ' + esc(fp.asOf) + '</small>' : '') +
        (r.asAccepted && f.problems.length ? ' <span class="bad">⚠ ' + esc(f.problems.join(' · ')) + '</span>' : '')) +
      '</span><b>' + fuelAmt + '</b></div>');
    // Dumpsters, planting package, markers: lines the rules added (none on
    // one accepted in QuickBooks: its list is the whole list).
    if (!r.asAccepted) [['dumpsters', 'Dumpsters'], ['planting', 'Planting package'], ['markers', 'Layout markers']].forEach(([k, label]) => {
      const ls = r.added.filter(l => l.auto === k);
      const sum = ls.reduce((s, l) => s + l.clientCents, 0);
      const probs = [].concat.apply([], ls.map(l => l.problems));
      if (!ls.length && !off[k]) return;
      rows.push('<div class="est-arow" data-auto="' + k + '">' + sw(k, label) + '<span class="est-adesc">' + (off[k] ? 'off' :
        ls.map(l => esc(l.name) + ' — ' + esc(P().qtyText(l.orderQty, l.per))).join('; ') +
        (probs.length ? ' <span class="bad">⚠ ' + esc(probs.join(' · ')) + '</span>' : '')) + '</span><b>' + (sum ? cents(sum) : '') + '</b></div>');
    });
    const html = (r.asAccepted ? '<p class="hint">The customer accepted QuickBooks’ figures, so nothing goes on top of the price. ' +
      'What delivery and fuel cost you is counted in what the job makes:</p>' : '') + rows.join('');
    // Someone typing in one of the boxes here (miles, days, gas...): the
    // boxes stay as they are. Rebuilt, they took the focus -- and the iPad's
    // keyboard -- away at every key, and turned the 4 just typed for gas
    // into "4.00". Only the amounts, and the rows not being typed in, are
    // brought up to date; the whole lot is drawn again next time.
    const a = document.activeElement;
    if (a && a !== box && box.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      tmp.querySelectorAll('[data-auto]').forEach(row => {
        const live = box.querySelector('[data-auto="' + row.getAttribute('data-auto') + '"]');
        if (!live) return;
        if (!live.contains(a)) { live.innerHTML = row.innerHTML; return; }
        const amt = live.querySelector(':scope > b'), now = row.querySelector(':scope > b');
        if (amt && now) amt.textContent = now.textContent;
        const note = live.querySelector('.est-miles-note'), nn = row.querySelector('.est-miles-note');
        if (note && nn) note.innerHTML = nn.innerHTML;
      });
      return;
    }
    box.innerHTML = html;
  }

  // The QuickBooks id of the customer the open job is tied to (customers.js),
  // or '' -- a lead, nobody, or the list not switched on.
  function hubCustomer() {
    const id = typeof boardFields !== 'undefined' && boardFields ? boardFields.customerId : '';
    return id && window.YDCustomers && YDCustomers.on() ? YDCustomers.qbIdFor(id) : '';
  }

  // A home or a business: which list of warranty and terms products ends the
  // estimate (Pricing rules -- some notices are for homes only). From the
  // job's Business name unless set on this estimate.
  function whoFor() {
    if (est.customerType === 'home' || est.customerType === 'business') return est.customerType;
    return el('business') && el('business').value.trim() ? 'business' : 'home';
  }
  function whoHtml() {
    const auto = !est.customerType, now = whoFor();
    return '<div class="est-who"><span>Customer is</span><select onchange="estWho(this.value)">' +
      [['', 'Auto — ' + (now === 'business' ? 'a business' : 'a home')], ['home', 'A home'], ['business', 'A business']]
        .map(([k, n]) => '<option value="' + k + '"' + ((auto ? '' : est.customerType) === k ? ' selected' : '') + '>' + n + '</option>').join('') +
      '</select><span class="muted">' + P().endItems(now).length + ' warranty & terms lines go on the end</span></div>';
  }
  window.estWho = function (v) {
    if (!changes()) return;
    if (v === 'home' || v === 'business') est.customerType = v; else delete est.customerType;
    changed(false);
  };
  function renderQb() {
    const box = el('estQb');
    if (!box) return;
    const q = qb(), inv = qbInv();
    const can = sends() && changes();
    // A snow bid: its lines added up (what QuickBooks will total), ready
    // once nothing it needs is missing; never an invoice for the whole.
    const snow = snowNow();
    const r = snow ? snowSum() : last;
    const ready = snow ? !snowProblems().length : r && r.totalCents > 0;
    const when = s => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
    const status = q ? ({ Pending: 'Waiting on the customer', Accepted: '✅ Accepted', Closed: 'Made into an invoice',
      Converted: 'Made into an invoice', Rejected: 'Turned down' }[q.status] || q.status || '') : '';
    // Folded, or no longer to be (an answer or an invoice since it was
    // drawn): the whole estimate is drawn again the right way.
    const wrap = el('estimateWrap');
    const drawnFolded = !!(wrap && wrap.dataset.folded === '1');
    if (wrap && drawnFolded !== folded()) { render(); return; }
    if (drawnFolded) {
      box.innerHTML = foldedHtml(q, status) + (snow ? snowWonHtml(q, can) : invoiceHtml(q, inv, can, when) + careHtml(when) + postsHtml(when));
      return;
    }
    if (can) askCompany();
    const testCo = qbCompany && qbCompany.env && qbCompany.env !== 'production';
    // Said yes to (or on the Snow route already), a snow bid is not sent
    // again: its prices are the account's now.
    const closed = !!(q && q.id && (q.status === 'Closed' || q.status === 'Converted' || (inv && inv.id) ||
      (snow && (isAccepted(q) || snowWon()))));
    const push = snow ? perPushNow() : null;
    // One button stands out -- the next thing to do: the invoice once the
    // customer has said yes, else sending the estimate. The rest are plain.
    const yes = !!(q && q.id && q.status === 'Accepted' && !(inv && inv.id));
    box.innerHTML =
      (testCo ? '<div class="est-testco">⚠️ QuickBooks is connected to Intuit’s <b>TEST company</b>' +
        (qbCompany.name ? ' (“' + esc(qbCompany.name) + '”)' : '') + ', not your real QuickBooks. Bids sent from here go nowhere real — ' +
        'switch to your real company first.</div>' : '') +
      deletedHtml(q, when) +
      (q && q.id ? '<div class="est-qb-line"><b>QuickBooks estimate' + (q.docNumber ? ' #' + esc(q.docNumber) : '') + '</b>' +
        (push ? ' · ' + cents(push) + ' per push' : q.total != null ? ' · ' + fmtMoney(Number(q.total) || 0) : '') +
        (status ? ' · ' + esc(status) : '') +
        (q.sentAt ? ' · emailed ' + esc(when(q.sentAt)) + (q.sentTo ? ' to ' + esc(q.sentTo) : '') : ' · not emailed yet') +
        (q.acceptedBy ? ' · accepted by ' + esc(q.acceptedBy) : '') +
        (q.env === 'sandbox' ? ' <span class="est-sandbox">TEST COMPANY</span>' : '') + '</div>' +
        qbDiffHtml(q, r, closed) : '') +
      // Once invoiced the estimate is closed in QuickBooks and can't change.
      (can && closed
        ? (q.link && /^https:\/\/[a-z.]*qbo\.intuit\.com\//.test(q.link)
          ? '<div class="field-actions est-qb-acts"><a class="btn btn-sm" href="' + esc(q.link) + '" target="_blank" rel="noopener">Open the estimate</a></div>' : '')
      : can ? (snow ? '' : whoHtml()) + '<div class="field-actions est-qb-acts">' +
        '<button class="btn btn-sm' + (yes ? '' : ' btn-filled') + '" onclick="estToQB(true)"' + (saving || qbAsking || !ready ? ' disabled' : '') + '>' +
          (saving || qbAsking ? 'Working…' : q && q.id ? (q.sentAt ? '✉️ Update & re-send' : '✉️ Email it from QuickBooks') : '✉️ Send through QuickBooks') + '</button>' +
        '<button class="btn btn-sm" onclick="estToQB(false)"' + (saving || qbAsking || !ready ? ' disabled' : '') + '>' +
          (q && q.id ? 'Update in QuickBooks only' : 'Put in QuickBooks, don’t email yet') + '</button>' +
        (q && q.link && /^https:\/\/[a-z.]*qbo\.intuit\.com\//.test(q.link)
          ? '<a class="btn btn-sm" href="' + esc(q.link) + '" target="_blank" rel="noopener">Open in QuickBooks</a>' : '') +
        (q && q.id && !(inv && inv.id) ? '<button class="btn btn-sm" onclick="estCheck(false)"' + (checking ? ' disabled' : '') + '>' +
          (checking ? 'Checking…' : 'Check for an answer') + '</button>' : '') +
      '</div>' : (q ? '' : '<div class="hint">Sending estimates needs Billing access.</div>')) +
      sentHtml(when) +
      (snow ? snowWonHtml(q, can) : invoiceHtml(q, inv, can, when) + careHtml(when) + postsHtml(when));
  }

  // The estimate was deleted in QuickBooks (quickbooks.py _deleted_record:
  // the job keeps what it was under `deleted`, with no id). The buttons
  // below are the first-time ones again, and make a new estimate.
  function deletedHtml(q, when) {
    const d = q && !q.id && q.deleted;
    if (!d) return '';
    const total = d.total != null ? ' (' + fmtMoney(Number(d.total) || 0) + ')' : '';
    return '<div class="est-qb-diff" role="note">⚠ QuickBooks estimate' + (d.docNumber ? ' #' + esc(d.docNumber) : '') + total +
      ' was deleted in QuickBooks' + (d.at ? ' — seen ' + esc(when(d.at)) : '') + '. ' +
      (sends() ? 'Put it in again below; QuickBooks gives it a new number.' : '') + '</div>';
  }

  // QuickBooks' total against Job Hub's, said on the row while it differs by
  // more than a dollar (it was only a toast after sending, gone in seconds).
  // Either the estimate changed here since it went, or QuickBooks has its
  // own figure: its sales tax worked out from the address, or a change made
  // there by hand.
  function qbDiffHtml(q, r, closed) {
    if (!q || q.total == null || !r || !(r.grandCents > 0)) return '';
    const there = Math.round(Number(q.total) * 100);
    if (!isFinite(there) || Math.abs(there - r.grandCents) <= 100) return '';
    const lastSent = (est.sent || []).slice(-1)[0];
    const changedHere = !!(lastSent && lastSent.totalCents > 0 && Math.abs(lastSent.totalCents - r.grandCents) > 100);
    return '<div class="est-qb-diff" role="note">⚠ QuickBooks’ total is <b>' + cents(there) + '</b> — Job Hub’s is <b>' + cents(r.grandCents) + '</b>. ' +
      (changedHere && !closed ? 'The estimate has changed here since it last went to QuickBooks — update it (below) to send the new total.'
        // A snow bid has no tax and no payments: only a change made there.
        : snowNow() ? 'It was changed in QuickBooks.'
        : 'QuickBooks works out the sales tax from the job’s address, or it was changed in QuickBooks. ' +
          'The payments are each a share of the total, so they still add up.') + '</div>';
  }

  // ------------------------------------------------------ plant-care email
  //
  // Jonah (1 Oct 2026): Claude drafts care info for exactly the plants a
  // client had installed. When a job with plants on its estimate is marked
  // Complete, the server (care.py) writes it into his Gmail Drafts -- he
  // reads it and sends it (his answer: show me first). "Write it now" does
  // the same by hand. Switched off in Pricing rules → Claude.
  const plantsIn = e => ((e && e.materials) || []).filter(m => m && m.plant && String(m.name || '').trim());
  // The plants on an estimate Claude can write about: its "+ Plant" lines,
  // and Plants items picked from Supplies (plantcare.js; care.py reads both).
  const carePlants = e => (window.YDPlants ? window.YDPlants.found({ estimate: e }).estPlants : plantsIn(e).length);
  const careBusy = {};        // job id -> being written
  function careOn() { return !!(P() && P().rules().autoCare !== false); }
  // Artificial turf on this estimate (plantcare.js), or the job set to
  // "Yes — artificial turf" on the Job tab, and not set to "No turf".
  function careTurf() {
    const pick = el('turf') ? el('turf').value : '';
    if (pick === 'no') return false;
    return pick === 'yes' || !!(window.YDPlants && YDPlants.turfFound && YDPlants.turfFound({ estimate: est }).estTurf > 0);
  }
  function careHtml(when) {
    const plants = carePlants(est), turf = careTurf();
    if ((!plants && !turf) || !changes()) return '';
    const c = (typeof boardFields !== 'undefined' && boardFields.careEmail) || null;
    // Settled by hand, or the job set to "No plants" on the Job tab (plantcare.js).
    const done = (typeof boardFields !== 'undefined' && boardFields.careDone) || null;
    const setNo = el('plants') && el('plants').value === 'no' && !turf;
    const count = (plants ? plants + ' plant' + (plants === 1 ? '' : 's') : '') + (plants && turf ? ' and ' : '') +
      (turf ? (plants ? 'artificial turf' : 'Artificial turf') : '') + ' on this job. ';
    const word = plants && turf ? 'Care' : turf ? 'Turf-care' : 'Plant-care';
    return '<div class="est-care">' + (turf && !plants ? '🟩 ' : '🌱 ') + (c
        ? word + ' email drafted ' + esc(when(c.at)) + ' — in your Gmail Drafts to read and send.'
        : done && done.how === 'self' ? count + 'You sent the care email yourself.'
        : done && done.how === 'notNeeded' ? count + 'Marked: no care email needed.'
        : setNo ? count + 'The job is set to “No plants”, so no care email is asked for when it’s finished.'
        : typeof jobStatus !== 'undefined' && jobStatus === 'complete' && typeof boardFields !== 'undefined' && boardFields.completedAt
          ? count + 'The job is finished and its care email is owed — press the button and Claude drafts it into your Gmail Drafts.'
        : count + (careOn() ? 'When it’s marked Complete, ' : 'Press the button and ') + 'Claude drafts a care email for them into your Gmail Drafts.') +
      ' <button class="btn btn-sm" onclick="estCareEmail()"' + (careBusy[currentJobId] ? ' disabled' : '') + '>' +
        (careBusy[currentJobId] ? 'Writing…' : c ? 'Write it again' : 'Write it now') + '</button></div>';
  }
  // Social posts about a finished job (posts.py; Jonah, 21 Oct 2026: "Build
  // something that auto build posts when a job is marked complete"): Claude
  // writes one for each place onto his My to-dos, once when the job is
  // finished (jobCompleted), and again whenever he presses the button.
  const postsBusy = {};       // job id -> being written
  function postsHtml(when) {
    if (!changes() || snowNow()) return '';
    const p = (typeof boardFields !== 'undefined' && boardFields.postsDraft) || null;
    const st = typeof jobStatus !== 'undefined' ? jobStatus : '';
    const done = st === 'complete';
    // Jonah, 26 Oct 2026: a "Don't post" tick on the job -- no posts written
    // by themselves when it is finished, and never in the week's "ready to
    // post" card (posts.py weekly). Tickable before it is finished too.
    const no = !!(typeof boardFields !== 'undefined' && boardFields.noPost);
    const tick = '<label class="chk est-nopost"><input type="checkbox"' + (no ? ' checked' : '') +
      ' onchange="estNoPost(this.checked)"> 🚫 Don’t post this job — no social posts, not in the week’s photos</label>';
    if (!p && !done) return st === 'booked' || st === 'inprogress' ? '<div class="est-care">' + tick + '</div>' : '';
    if (no) return '<div class="est-care">' + tick + '</div>';
    return '<div class="est-care">' + tick + '</div><div class="est-care">📣 ' + (p
        ? 'Social posts written ' + esc(when(p.at)) + ' — on your My to-dos (Google, Facebook, Nextdoor, Pinterest, Yelp).'
        : 'Social posts for this job: press the button and Claude writes one each for Google, Facebook, Nextdoor, Pinterest and Yelp onto your My to-dos.') +
      ' <button class="btn btn-sm" onclick="estPosts()"' + (postsBusy[currentJobId] ? ' disabled' : '') + '>' +
        (postsBusy[currentJobId] ? 'Writing…' : p ? 'Write them again' : 'Write the posts') + '</button></div>';
  }
  async function writePosts(jobId, byItself) {
    if (postsBusy[jobId] || !window.YDClaude) return;
    postsBusy[jobId] = true; renderQb();
    try {
      const r = await window.YDClaude.post('/posts/draft', { jobId: jobId, auto: !!byItself });
      if (r.skipped) return;
      if (window.YDSync) window.YDSync.patchJob(jobId, { postsDraft: { at: new Date().toISOString(), cardId: r.cardId || null } });
      showToast('📣 The social posts are on your My to-dos — copy each into its place');
    } catch (e) {
      showToast((byItself ? 'The social posts weren’t written: ' : 'Social posts: ') + (e.message || e));
    } finally {
      delete postsBusy[jobId]; renderQb();
    }
  }
  window.estNoPost = function (on) {
    if (!changes() || !currentJobId) return;
    if (typeof boardFields !== 'undefined') boardFields.noPost = !!on;
    if (window.YDSync && window.YDSync.patchJob) window.YDSync.patchJob(currentJobId, { noPost: !!on });
    showToast(on ? '🚫 This job won’t be posted' : 'This job can be posted again');
    renderQb();
  };
  window.estPosts = function () {
    if (!changes()) return;
    // The server reads the job from the database: what was just typed goes up first.
    if ((!currentJobId || (typeof dirty !== 'undefined' && dirty)) && typeof autosave === 'function') autosave();
    const id = currentJobId;
    if (!id || postsBusy[id]) return;
    Promise.resolve(window.YDSync && window.YDSync.sendNow ? window.YDSync.sendNow(id) : true)
      .then(sent => {
        if (sent) writePosts(id, false);
        else showToast('📣 The social posts wait for a signal — press “Write the posts” again later');
      });
  };
  // A job marked Complete: its posts, once, written by Claude with no one
  // asking -- a snow contract or a job with no work on it has none.
  function postsCompleted(jobId, data) {
    if (data.postsDraft || data.noPost) return;
    const e = data.estimate || {};
    if (snowOf(e, data.serviceTypes, data.jobStatus, data.qbEstimate)) return;
    if (!(e.work || []).some(w => w && (String(w.title || '').trim() || String(w.scope || '').trim()))) return;
    if (!window.YDClaude || !window.YDClaude.available() || !navigator.onLine) {
      setTimeout(() => showToast('📣 The social posts for ' + (String(data.customerName || '').trim() || 'this job') +
        ' wait for a signal — press “Write the posts” on the job later', 7000), 0);
      return;
    }
    Promise.resolve()
      .then(() => (window.YDSync && window.YDSync.sendNow ? window.YDSync.sendNow(jobId) : false))
      .then(sent => { if (sent) writePosts(jobId, true); });
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
      showToast('🌱 Care email' + (r.to ? ' to ' + r.to : '') + ' is in your Gmail Drafts — read it and send');
    } catch (e) {
      showToast((byItself ? 'The care email wasn’t written: ' : 'Care email: ') + (e.message || e));
    } finally {
      delete careBusy[jobId]; renderQb();
    }
  }
  window.estCareEmail = function () {
    if (!changes()) return;
    if (!(el('email').value || '').trim()) { showToast('Add the customer’s email on the job first'); return; }
    // The server reads the job from the database, so what was just typed --
    // their email, as the owed-email banner asks for -- goes up first (as for
    // the one asked for on Complete, jobCompleted below).
    if ((!currentJobId || (typeof dirty !== 'undefined' && dirty)) && typeof autosave === 'function') autosave();
    const id = currentJobId;
    if (!id || careBusy[id]) return;
    Promise.resolve(window.YDSync && window.YDSync.sendNow ? window.YDSync.sendNow(id) : true)
      .then(sent => {
        if (sent) writeCare(id, false);
        else showToast('🌱 The care email waits for a signal — press “Write it now” again later');
      });
  };
  // A job marked Complete (sync.js patchJob, or the form's status): its care
  // email, once, when it has plants and an email address.
  //
  // A job with plants owes one from now on (plantcare.js) -- on the Job tab,
  // the board and the summaries until it is written or settled by hand. When
  // Claude can't write it straight away, he is told so here; the toast waits
  // a moment, or the board's own "moved to ..." would cover it.
  function jobCompleted(jobId, data) {
    if (!changes() || !data) return;
    postsCompleted(jobId, data);
    if (data.careEmail || data.careDone) return;
    // Plants or artificial turf (plantcare.js): one care email for both.
    const hasPlants = window.YDPlants ? window.YDPlants.has(data) : plantsIn(data.estimate).length > 0;
    const hasTurf = !!(window.YDPlants && window.YDPlants.turfHas && window.YDPlants.turfHas(data));
    if (!hasPlants && !hasTurf) return;
    const what = hasPlants && hasTurf ? 'has plants and turf' : hasTurf ? 'has artificial turf' : 'has plants';
    const why = !carePlants(data.estimate) && !hasTurf ? 'no plants on its estimate for Claude to write from — send it yourself'
      : !careOn() ? 'Claude drafts it when you press “Write it now” on the job'
      : !/@/.test(String(data.email || '')) ? 'add their email to the job, then press “Write it now”'
      : !window.YDClaude || !window.YDClaude.available() || !navigator.onLine ? 'it waits for a signal — press “Write it now” on the job later'
      : '';
    if (why) {
      const name = String(data.customerName || '').trim() || 'This job';
      setTimeout(() => showToast('🌱 ' + name + ' is finished and ' + what + ' — the care email is owed (' + why + ')', 7000), 0);
      return;
    }
    // The server reads the finished job from the database, so the job goes up
    // first and the email is asked for once the server has it. (Called from
    // the middle of patchJob -- the turn after it is when the copy on this
    // device is complete.)
    Promise.resolve()
      .then(() => (window.YDSync && window.YDSync.sendNow ? window.YDSync.sendNow(jobId) : false))
      .then(sent => {
        if (sent) writeCare(jobId, true);
        else showToast('🌱 The care email waits for a signal — press “Write it now” on the job later');
      });
  }

  function sentHtml(when) {
    const list = (est.sent || []).slice().reverse();
    if (!list.length) return '';
    const time = s => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); };
    return '<details class="est-sent"><summary>Versions put in QuickBooks (' + list.length + ')</summary>' +
      list.map(v => '<div class="est-sent-row"><b>' + esc(when(v.at)) + ' ' + esc(time(v.at)) + '</b> — ' + cents(v.totalCents) +
        (v.emailed ? ' · emailed' : ' · saved, not emailed') + (v.docNumber ? ' · #' + esc(v.docNumber) : '') +
        '<div class="muted">' + (v.work || []).map(w => esc(w.title || 'Labor') + ' ' + cents(w.cents)).join(' · ') +
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
      return line + '<div class="field-actions est-qb-acts">' +
        (!inv.sentAt ? '<button class="btn btn-sm btn-filled" onclick="estInvoice(true)"' + (invoicing ? ' disabled' : '') + '>✉️ Email the invoice</button>' : '') +
        (inv.link && /^https:\/\/[a-z.]*qbo\.intuit\.com\//.test(inv.link)
          ? '<a class="btn btn-sm" href="' + esc(inv.link) + '" target="_blank" rel="noopener">Open the invoice</a>' : '') +
        (owed === null || owed > 0 ? '<button class="btn btn-sm" onclick="estInvoiceCheck(false)"' + (checking ? ' disabled' : '') + '>' +
          (checking ? 'Checking…' : 'Check for a payment') + '</button>' : '') +
      '</div>';
    }
    // Only once they have said yes: while the estimate is still waiting on
    // the customer there is no invoice to make (15 Oct 2026 -- the buttons
    // sat there from the day it was sent). A yes on the phone, with
    // QuickBooks still waiting, keeps a quiet way to make it.
    if (q.status !== 'Accepted') {
      return line + ((q.status || 'Pending') === 'Pending' ? '<div class="est-invoice-quiet"><button class="link-btn" onclick="estInvoice(false)"' +
        (invoicing ? ' disabled' : '') + '>' + (invoicing ? 'Working…' : 'Said yes another way? Make the invoice') + '</button></div>' : '');
    }
    return '<div class="est-invoice">' +
      '<div class="hint">They said yes. Make one invoice for the whole job from this estimate — the deposit is paid against it.</div>' +
      '<div class="field-actions est-qb-acts">' +
        '<button class="btn btn-sm btn-filled" onclick="estInvoice(true)"' + (invoicing ? ' disabled' : '') + '>' +
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
    // This estimate's own payments, with its deposit floor (the materials).
    const r = last || priced();
    const pays = P() ? P().payments(totalCents, rules, { plan: est.payments,
      materialsCents: r ? r.materialsCents + ((r.tax && r.tax.materialsTaxCents) || 0) : 0 }) : [];
    return [payWords(pays), terms].filter(Boolean).join('\n\n');
  }

  window.estInvoice = async function (email) {
    const q = qb(), inv = qbInv() || {};
    // A snow bid is billed storm by storm from the Snow account, never one
    // invoice for the whole.
    if (!q || !q.id || invoicing || !sends() || !changes() || snowNow()) return;
    const total = Math.round((Number(q.total) || 0) * 100);
    const to = (el('email').value || '').trim();
    const what = inv.id ? 'invoice #' + (inv.docNumber || '') : 'the invoice for the whole job (' + cents(total) + ') from estimate #' + (q.docNumber || '');
    if (email && !to && !inv.id) { showToast('Add the customer’s email on the job first'); return; }
    const askedFor = currentJobId;
    if (!(await ydConfirm(inv.id ? '' : 'It closes the estimate in QuickBooks.',
      { title: email ? 'Email ' + what + ' to ' + (to || 'the customer') + ' from QuickBooks?' : 'Make ' + what + ' in QuickBooks?',
        ok: email ? 'Email it' : 'Make it' }))) return;
    if (currentJobId !== askedFor || invoicing) return;
    if (!(await realCompanyOrTest('This invoice'))) { showToast('Not made — QuickBooks is on the test company'); return; }
    if (typeof autosave === 'function') autosave();
    const jobId = currentJobId;
    if (!jobId) return;
    invoicing = true; renderQb();
    try {
      const out = await askQb('/qb/estimate-invoice', { jobId: jobId, estimateId: q.id, env: q.env || null,
        invoiceId: inv.id || null, email: !!email, memo: invoiceMemo(total),
        testOk: !!(qbCompany && qbCompany.env !== 'production') });
      afterInvoice(jobId, out);
      showToast((email ? 'Emailed from QuickBooks' : 'Made in QuickBooks') + (out.docNumber ? ' — invoice #' + out.docNumber : ''));
      // A yes from the customer: a bid still waiting to be booked is offered it.
      if (currentJobId === jobId && typeof isBidStatus === 'function' && isBidStatus(jobStatus) && typeof makeItAJob === 'function' &&
          await ydConfirm('', { title: 'They said yes — book it as a job now?', ok: 'Book it', cancel: 'Not now' }) &&
          currentJobId === jobId && isBidStatus(jobStatus)) makeItAJob(jobId);
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
    // The number goes in the box on the Job tab; that the job is Invoiced is
    // its stage, worked out from qbInvoiceRef (app.js jobStage) -- the old
    // "Invoiced in QuickBooks" tick is retired.
    if (currentJobId === jobId && r.docNumber && el('qbInvoice').value.trim() !== String(r.docNumber)) {
      el('qbInvoice').value = r.docNumber;
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

  // The payments as the customer reads them. QuickBooks keeps this message as
  // plain text and never re-works it, so it holds nothing that a change to
  // the total can make wrong: each payment is its share of the total, or an
  // amount he typed himself, and the last is "the remaining balance" -- so the
  // payments always add up to whatever the total is. (14 Oct 2026: #1677's
  // price was raised by hand in QuickBooks and went out with a deposit and a
  // final payment that added up to the old total.)
  function pctWords(p) {
    return (Math.round(p * 10) % 10 ? (Math.round(p * 10) / 10).toFixed(1) : String(Math.round(p))) + '%';
  }
  function payWords(pays) {
    return (pays || []).map(x => {
      const name = x.name || String(x.label || '').replace(/\s*\(\d+%\)$/, '');
      if (x.how === 'all') return name + ': the full total';
      if (x.how === 'rest') return name + ': the remaining balance';
      if (!(x.cents > 0)) return '';      // nothing left for it after a raised deposit
      if (x.how === 'amount') return name + ': ' + cents(x.cents);
      if (typeof x.pct === 'number') return name + ': ' + pctWords(x.pct) + ' of the total';
      return '';
    }).filter(Boolean).join('\n');
  }

  // The message when he has not written one: the payments asked for and his
  // payment terms. The warranty is a QuickBooks product at the end of the
  // estimate (P().endItems(whoFor())); until that list has anything on it,
  // the old warranty sentence stays here.
  function defaultMemo(totalCents) {
    const p = (P() && P().rules().payments) || {};
    const above = num(p.splitAboveCents);
    const terms = above !== null && totalCents > above ? p.threeText : p.twoText;
    const r = last;
    const pays = r && r.totalCents === totalCents ? r.payments || [] : [];
    const warranty = P() && P().endItems(whoFor()).length ? '' : p.warranty;
    return [payWords(pays), terms, warranty]
      .map(s => String(s || '').trim()).filter(Boolean).join('\n\n');
  }

  // ------------------------------------------------------------- snow bids
  //
  // Jonah, 16 Oct 2026: "the built in estimate builder clearly doesnt
  // understand quoting snow and is asking the miles to job and back how much
  // salt will be used for the whole season when it should know i bid snow at
  // the moment per push." A snow bid is a price sheet, not a takeoff: what
  // gets cleared, a price per push by depth (or the 1–3" price and so much an
  // inch over 3"), salt per application, extras per visit, an hourly rate for
  // long storms. No miles, fuel, materials, dumpsters, crew-days, season salt
  // or payment plan. Every figure is his: the boxes start empty, with his own
  // Snow accounts' prices offered beside them to tap. It goes to QuickBooks
  // in the words and products of the snow estimates he writes by hand
  // (snowLines; the words in Pricing rules → Snow bids), and a yes puts the
  // customer on the Snow route (quickbooks.py snow_bids) -- never on the job
  // list. A bid is a snow bid when its services are all snow work (one with
  // a takeoff already built stays as it is), or once sent as one -- or when
  // switched by hand, which always wins.
  //
  // est.snow (cleanSnow): { mode: tiers|perInch, tiers {'1-3','4-6','6+','9+'}
  //   (cents; '4-6' is the 3–6" price), deeper (6–9"/9"+ boxes out),
  //   perInchCents, saltCents, paw, extras [{id, name, cents}], laborCents,
  //   stormNote (this bid's words under the prices; '' = his usual), areas [ids], areasOther, areasSet (picked by hand), type
  //   (residential|commercial, null = from the Business name), crewNotes }.
  // The area ids are estimates.py SNOW_AREAS too (Claude may give them).
  const SNOW_AREAS = [['driveway', 'Driveway'], ['walkways', 'Walkways'], ['mailbox', 'Mailbox'], ['steps', 'Steps'],
    ['sidewalk', 'Public sidewalk'], ['patio', 'Patio'], ['deck', 'Deck'], ['lot', 'Parking lot'],
    ['entrances', 'Entrances'], ['dumpster', 'Dumpster area']];
  const SNOW_AREA_IDS = SNOW_AREAS.map(a => a[0]);
  // What his notes say, for each: "drive/walkways", "the walks", "mailbox".
  const SNOW_AREA_WORDS = {
    driveway: /\bdrive ?ways?\b|\bdrive\b/i, walkways: /\bwalk ?ways?\b|\bwalks?\b|\bpaths?\b/i,
    mailbox: /\bmail ?box(es)?\b/i, steps: /\bsteps?\b|\bstairs?\b|\bstoops?\b/i, sidewalk: /\bside ?walks?\b/i,
    patio: /\bpatios?\b/i, deck: /\bdecks?\b/i, lot: /\bparking\b/i, entrances: /\bentrances?\b|\bentry\b|\bdoorways?\b/i,
    dumpster: /\bdumpsters?\b/i,
  };
  const PAW_WORDS = /\bpaws?\b|\bpets?\b|\bdogs?\b/i;
  // [key, on screen, on the estimate (as he writes it), its deepest inch].
  const SNOW_TIERS = [['1-3', '1–3"', '1-3in', 3], ['4-6', '3–6"', '3-6in', 6], ['6+', '6–9"', '6-9in', 9], ['9+', '9"+', '9in+', null]];
  // A service that is snow work (services.js files these under Snow & ice).
  const SNOW_SERVICE = /snow|\bice\b|salt|plow/i;
  let drawnSnow = false;      // the estimate on screen was drawn as a snow bid
  const snowChatOpen = {};    // job id -> "Talk to Claude" opened on its snow bid

  const svcNow = () => (typeof serviceTypes !== 'undefined' && Array.isArray(serviceTypes) ? serviceTypes : []);
  const statusNow = () => (typeof jobStatus !== 'undefined' ? jobStatus : null);
  function snowAuto(services, status) {
    const list = (Array.isArray(services) ? services : []).map(s => String(s || '').trim()).filter(Boolean);
    if (!list.length) return false;
    if (status != null && typeof isBidStatus === 'function' && !isBidStatus(status)) return false;
    return list.every(n => SNOW_SERVICE.test(n) ||
      ((window.YDServices && YDServices.about && YDServices.about(n)) || {}).group === 'snow');
  }
  // e: an estimate as saved; q: the job's QuickBooks record.
  function snowOf(e, services, status, q) {
    e = e || {};
    if (e.snowBid === true || e.snowBid === false) return e.snowBid;
    if (q && q.snowBid) return true;
    if ((e.work || []).length || (e.materials || []).length || e.fromQb) return false;
    return snowAuto(services, status);
  }
  const snowNow = () => snowOf(est, svcNow(), statusNow(), qb());
  function perPushOf(d) {
    if (!d) return null;
    const e = d.estimate && typeof d.estimate === 'object' ? d.estimate : {};
    if (!snowOf(e, d.serviceTypes, d.jobStatus, d.qbEstimate)) return null;
    const c = num(((e.snow || {}).tiers || {})['1-3']);
    return c > 0 ? c : null;
  }
  const perPushNow = () => perPushOf({ estimate: est, serviceTypes: svcNow(), jobStatus: statusNow(), qbEstimate: qb() });

  function cleanSnow(s) {
    if (!s || typeof s !== 'object') return null;
    const c = v => { const n = num(v); return n !== null && n > 0 ? Math.round(n) : null; };
    const t = s.tiers || {};
    return {
      mode: s.mode === 'perInch' ? 'perInch' : 'tiers',
      tiers: { '1-3': c(t['1-3']), '4-6': c(t['4-6']), '6+': c(t['6+']), '9+': c(t['9+']) },
      deeper: !!s.deeper,
      perInchCents: c(s.perInchCents),
      saltCents: c(s.saltCents),
      paw: s.paw === true ? true : s.paw === false ? false : null,
      extras: (Array.isArray(s.extras) ? s.extras : []).filter(x => x && typeof x === 'object').slice(0, 12)
        .map(x => ({ id: safeId(x.id) || newId('sx'), name: String(x.name || '').slice(0, 60), cents: c(x.cents) })),
      laborCents: c(s.laborCents),
      // This bid's own words under the prices; '' = his usual (Pricing rules).
      stormNote: String(s.stormNote || '').slice(0, 600),
      areas: SNOW_AREA_IDS.filter(id => (Array.isArray(s.areas) ? s.areas : []).indexOf(id) !== -1),
      areasOther: String(s.areasOther || '').slice(0, 300),
      areasSet: !!s.areasSet,
      type: s.type === 'commercial' || s.type === 'residential' ? s.type : null,
      crewNotes: String(s.crewNotes || '').slice(0, 2000),
    };
  }
  function snowObj() {
    if (!est.snow) est.snow = cleanSnow({});
    return est.snow;
  }
  // A home or a business: set by hand, else the job's Business name says.
  function snowType(s, biz) {
    if (s && s.type) return s.type;
    const b = biz != null ? biz : (el('business') && el('business').value) || '';
    return String(b).trim() ? 'commercial' : 'residential';
  }
  // The depth the per-inch price starts over: 3" with the 1–3" price alone,
  // else past the deepest price given (none past an open-ended 9"+).
  function snowOver(s) {
    if (s.mode === 'perInch') return 3;
    return s.tiers['9+'] ? null : s.tiers['6+'] ? 9 : 6;
  }
  const money2 = c => '$' + ((Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // "driveway, walkways, and mailbox" -- as he writes it.
  function areasText(s) {
    const list = SNOW_AREAS.filter(([id]) => s.areas.indexOf(id) !== -1).map(([, label]) => label.toLowerCase());
    String(s.areasOther || '').split(/[,;]+/).map(x => x.trim()).filter(Boolean).forEach(x => list.push(x));
    if (list.length < 3) return list.join(' and ');
    return list.slice(0, -1).join(', ') + ', and ' + list[list.length - 1];
  }
  // His words (Pricing rules → Snow bids; pricing.js holds the defaults).
  const snowWordsCfg = () => (P() && P().snowBid ? P().snowBid() : { items: {} });
  // The sentence under the prices: his usual one for a home or a business,
  // unless this bid says its own (an assisted living kept open all storm is
  // not "once for every 4-6 inches"). Kept starting "(For storms" so the
  // reading-back on acceptance (quickbooks.py SNOW_BOILER) leaves it out of
  // the crew's words.
  function snowUsualStorm(s) {
    const w = snowWordsCfg();
    return (snowType(s) === 'commercial' ? w.stormNoteBusiness : w.stormNote) || '';
  }
  const snowStormNote = s => String(s.stormNote || '').trim() || snowUsualStorm(s);

  // The estimate's lines, as QuickBooks will show them -- the one place the
  // words are made: the customer view and what is sent both use this. The
  // per-inch sentence is fixed (its figure is read back when the customer
  // says yes, quickbooks.py _snow_terms); the rest are his to word.
  function snowLines(s, site) {
    const w = snowWordsCfg(), items = w.items || {};
    const biz = snowType(s) === 'commercial';
    const plowItem = biz ? items.commercial : items.residential;
    const tiers = s.mode === 'perInch' ? SNOW_TIERS.slice(0, 1) : SNOW_TIERS;
    const tierLines = tiers.filter(t => s.tiers[t[0]] > 0).map(t => t[2] + ' → ' + money2(s.tiers[t[0]]));
    const over = snowOver(s);
    const per = over && s.perInchCents > 0
      ? (over === 3 ? 'Each additional inch beyond 3in: +' + money2(s.perInchCents)
        : 'For clearings of quantities over ' + over + 'in each additional inch is billed at an additional ' + money2(s.perInchCents))
      : '';
    // Nothing picked yet (it cannot be sent so): a gap the eye catches.
    const intro = String(w.intro || '').replace(/\{areas\}/g, areasText(s) || '…').replace(/\s+/g, ' ').trim();
    const head = [intro, site].filter(Boolean).join('\n');
    const prices = [w.pricedNote].concat(tierLines, [snowStormNote(s)]).filter(Boolean).join('\n');
    const out = [{ kind: 'plow', qbItem: plowItem || '', title: '1–3" per push', cents: s.tiers['1-3'] || 0,
                   text: [head, prices, per].filter(Boolean).join('\n\n') }];
    if (s.saltCents > 0) {
      out.push({ kind: 'salt', qbItem: items.salt || '', title: 'Salt per application', cents: s.saltCents,
                 text: (s.paw ? w.saltPaw : w.saltPlain) + '\n\n*price per application*' });
    }
    s.extras.forEach(x => {
      const name = String(x.name || '').trim();
      if (name && x.cents > 0) out.push({ kind: 'extra', qbItem: plowItem || '', title: name, cents: x.cents, text: name + '\n\n*price per visit*' });
    });
    if (s.laborCents > 0) {
      out.push({ kind: 'labor', qbItem: items.labor || 'Labor', title: 'Labor per man-hour', cents: s.laborCents,
                 text: 'Labor - ' + money2(s.laborCents) + '/man hour' + (w.laborNote ? '\n' + w.laborNote : '') });
    }
    return out;
  }
  // QuickBooks adds the lines up; that is all the total is.
  function snowSum() {
    const t = snowLines(snowObj(), siteLine()).reduce((a, l) => a + (l.cents || 0), 0);
    return { totalCents: t, grandCents: t };
  }
  // What it needs before it can go: nothing guessed for him.
  function snowProblems() {
    const s = snowObj(), out = [];
    if (!(s.tiers['1-3'] > 0)) out.push('Put in the 1–3" price per push');
    if (s.mode === 'perInch' && !(s.perInchCents > 0)) out.push('Put in the price for each inch over 3"');
    if (!areasText(s)) out.push('Pick what gets cleared');
    if (!siteLine()) out.push('Add the job’s address — it goes on the bid');
    s.extras.forEach(x => {
      const name = String(x.name || '').trim();
      if (name && !(x.cents > 0)) out.push(name + ': put in its price per visit');
      else if (!name && x.cents > 0) out.push('An extra has a price but no name');
    });
    return out;
  }

  // His own Snow accounts' prices for a box (snow.js has what this person
  // may read: the owner, or whoever may see Snow or Billing). The same kind
  // of customer first; all of them when none of those has one. Never put in
  // a box by itself -- only offered, to tap.
  function snowYours(key, type, over) {
    const S = window.YDSnow;
    if (!S || !S.accounts || !S.pricing) return null;
    const acc = S.accounts() || {}, pr = S.pricing() || {};
    const valueOf = p => {
      const pricing = p.pricing || {}, tiers = pricing.tiers || {};
      if (key === 'salt') {
        const x = (Array.isArray(p.extras) ? p.extras : []).find(x => x && /salt/i.test(x.name || '') && num(x.cents) > 0);
        return x ? num(x.cents) : null;
      }
      if (key === 'labor') return num(p.laborRateCents) > 0 ? num(p.laborRateCents) : null;
      if (key === 'perInch') {
        const pi = pricing.mode === 'tieredPlusPerInch' && pricing.perInch;
        return pi && num(pi.cents) > 0 && Number(pi.aboveInches) === over ? num(pi.cents) : null;
      }
      const t = tiers[key];
      return t && t.mode !== 'inherit' && num(t.cents) > 0 ? num(t.cents) : null;
    };
    const pick = kind => Object.keys(acc)
      .filter(id => acc[id] && acc[id].active !== false && pr[id] && (kind === null || (acc[id].type === 'commercial') === kind))
      .map(id => valueOf(pr[id])).filter(v => v !== null).sort((a, b) => a - b);
    let vals = pick(type === 'commercial'), every = false;
    if (!vals.length) { vals = pick(null); every = true; }
    if (!vals.length) return null;
    return { lo: vals[0], hi: vals[vals.length - 1], mid: vals[Math.floor((vals.length - 1) / 2)], n: vals.length,
             who: every ? 'Your snow accounts' : type === 'commercial' ? 'Your commercial accounts' : 'Your residential accounts' };
  }
  // The accounts' prices are fetched with the Snow tab's list; any not in
  // yet are fetched once, for the suggestions.
  let snowPricesAsked = false;
  function askSnowPrices() {
    const S = window.YDSnow;
    if (snowPricesAsked || !S || !S.refreshPricing || !S.accounts) return;
    const acc = S.accounts() || {};
    if (!Object.keys(acc).length) return;            // not in yet: asked at the next drawing
    snowPricesAsked = true;
    const pr = S.pricing() || {};
    const missing = Object.keys(acc).filter(id => !pr[id]);
    if (!missing.length) return;
    Promise.resolve(S.refreshPricing(missing)).then(() => {
      if (snowNow() && jobShown() && !typingHere()) render();
    }, () => {});
  }

  function snowToggleHtml(ro) {
    const on = snowNow();
    const auto = est.snowBid !== true && est.snowBid !== false;
    // On a bid, or wherever it is switched on already.
    if (!on && auto && !(typeof isBidStatus === 'function' && isBidStatus(statusNow()))) return '';
    const said = auto ? (on ? (qb() && qb().snowBid ? 'sent as one' : 'from the services') : '')
      : 'set by hand' + (ro ? '' : ' · <button type="button" class="link-btn" onclick="estSnowBid(null)">let the services decide</button>');
    return '<div class="snb-toggle"><label class="est-switch"><input type="checkbox"' + (on ? ' checked' : '') + (ro ? ' disabled' : '') +
      ' onchange="estSnowBid(this.checked)"> ❄️ Snow bid — priced per push</label>' +
      (said ? '<span class="muted">' + said + '</span>' : '') + '</div>';
  }

  function renderSnow(wrap, ro) {
    const s = snowObj();
    askSnowPrices();
    const fold = folded();
    wrap.dataset.folded = fold ? '1' : '';
    if (fold) {
      wrap.innerHTML = '<div class="est-qb est-folded" id="estQb"></div>' + snowSummaryHtml(s);
      renderQb();
      return;
    }
    const chatOpen = !!(est.chat.length || busyHere() || snowChatOpen[currentJobId || '']);
    wrap.innerHTML =
      (settled() ? '<div class="est-refold"><button class="link-btn ro-ok" onclick="estUnfold(false)">▴ Fold the bid back to one line</button></div>' : '') +
      snowToggleHtml(ro) +
      '<div class="field"><span class="label">Notes from the site visit — what gets cleared, anything to know' +
        (ro ? '' : ' <button class="link-btn est-today" onclick="estNoteToday()">+ today’s date</button>') + '</span>' +
        '<textarea id="estNotes" rows="3" ' + (ro ? 'readonly ' : '') + 'oninput="estNotesInput(this.value)" onblur="estNotesDone()" ' +
        'placeholder="Drive and front walk, mailbox. Long drive with a turnaround. They have a dog — paw-friendly melt.">' +
        esc(est.notes) + '</textarea>' + snapHtml(ro) + '</div>' +
      ((est.questions || []).length ? '<div class="est-questions"><b>Claude asks:</b><ul>' +
        est.questions.map(q => '<li>' + esc(q) + '</li>').join('') + '</ul></div>' : '') +
      ((est.flags || []).length ? '<div class="est-flags"><b>Flags:</b><ul>' + est.flags.map(q => '<li>' + esc(q) + '</li>').join('') + '</ul></div>' : '') +
      chatHtml(ro, chatOpen) +
      (!chatOpen && !ro ? '<div class="snb-talk"><button type="button" class="link-btn" onclick="estSnowChat()">💬 Talk to Claude about this bid</button></div>' : '') +
      snowFormHtml(s, ro) +
      ((est.work.length || est.materials.length) ? '<p class="hint">' + (est.work.length + est.materials.length) +
        ' labor & material line' + (est.work.length + est.materials.length === 1 ? ' is' : 's are') +
        ' kept from before it was a snow bid — left off, and back if it’s switched off.</p>' : '') +
      '<div id="snbProbs">' + snowProbsHtml() + '</div>' +
      '<h4 class="est-h">What the customer sees</h4><div id="snbPreview">' + snowPreviewHtml(s) + '</div>' +
      '<div class="est-qb est-jump-to" id="estQb"></div>';
    const log = el('estChat'); if (log) log.scrollTop = log.scrollHeight;
    renderQb();
    drawn(wrap);
  }

  // A tap button: on, or not.
  const snowChip = (on, act, label, ro) => '<button type="button" class="stage-step' + (on ? ' on' : '') + '"' + (ro ? ' disabled' : '') +
    ' aria-pressed="' + (on ? 'true' : 'false') + '" onclick="' + act + '">' + label + '</button>';
  function yoursHtml(field, key, cur, y, ro) {
    if (!y) return '';
    const range = y.lo === y.hi ? cents(y.lo) : cents(y.lo) + '–' + cents(y.hi);
    return '<div class="snb-yours"><span class="muted">' + esc(y.who) + ' (' + y.n + '): ' + range +
        (y.n > 2 && y.lo !== y.hi ? ', most ' + cents(y.mid) : '') + '</span>' +
      (ro || cur === y.mid ? '' : ' <button type="button" class="link-btn" onclick="estSnowUse(\'' + field + '\', \'' + key + '\', ' + y.mid + ')">Use ' +
        cents(y.mid) + '</button>') + '</div>';
  }
  function moneyBox(field, key, cur, label, ro, y, hint) {
    return '<div class="snb-price"><label><span>' + label + (hint ? ' <small class="muted">' + hint + '</small>' : '') + '</span>' +
      '<span class="snb-money">$<input inputmode="decimal" value="' + esc(cur > 0 ? (cur / 100).toFixed(2) : '') + '" placeholder="0.00"' +
        (ro ? ' readonly' : '') + ' oninput="estSnowSet(\'' + field + '\', \'' + key + '\', this.value)"></span></label>' +
      yoursHtml(field, key, cur, y, ro) + '</div>';
  }
  function snowFormHtml(s, ro) {
    const type = snowType(s), over = snowOver(s);
    const t = s.tiers;
    const deeper = s.mode === 'tiers' && (s.deeper || t['6+'] > 0 || t['9+'] > 0);
    const tierBox = ([k, label]) => moneyBox('tier', k, t[k], label + ' per push', ro, snowYours(k, type));
    return '<div class="snb">' +
      '<div class="snb-sec"><span class="label">Customer is</span><div class="stage-steps">' +
        snowChip(type === 'residential', "estSnowTap('type', 'residential')", '🏠 A home', ro) +
        snowChip(type === 'commercial', "estSnowTap('type', 'commercial')", '🏢 A business', ro) + '</div>' +
        '<span class="muted snb-said">' + (s.type ? 'set by hand' + (ro ? '' : ' · <button type="button" class="link-btn" onclick="estSnowTap(\'type\', \'\')">from the job</button>')
          : 'from the job’s Business name') + '</span></div>' +

      '<div class="snb-sec"><span class="label">What gets cleared</span><div class="stage-steps">' +
        SNOW_AREAS.map(([id, label]) => snowChip(s.areas.indexOf(id) !== -1, "estSnowTap('area', '" + id + "')", esc(label), ro)).join('') + '</div>' +
        '<input class="snb-other" value="' + esc(s.areasOther) + '" placeholder="Anything else — e.g. side door path, garage apron"' + (ro ? ' readonly' : '') +
          ' oninput="estSnowSet(\'other\', \'\', this.value)">' +
        (!ro && String(est.notes || '').trim() ? '<button type="button" class="link-btn" onclick="estDraftFromNotes()">Pick them from my notes</button>' : '') + '</div>' +

      '<h4 class="est-h">Price per push <span class="muted">— per visit, each snowfall</span></h4>' +
      '<div class="stage-steps snb-modes">' +
        snowChip(s.mode === 'tiers', "estSnowTap('mode', 'tiers')", 'By depth — 1–3", 3–6"…', ro) +
        snowChip(s.mode === 'perInch', "estSnowTap('mode', 'perInch')", '1–3" + each inch over 3"', ro) + '</div>' +
      '<div class="snb-prices">' +
        (s.mode === 'perInch' ? tierBox(SNOW_TIERS[0]) +
            moneyBox('perInch', '', s.perInchCents, 'Each inch over 3"', ro, snowYours('perInch', type, 3))
          : SNOW_TIERS.slice(0, deeper ? 4 : 2).map(tierBox).join('') +
            (over ? moneyBox('perInch', '', s.perInchCents, 'Each inch over ' + over + '"', ro, snowYours('perInch', type, over), 'if you charge it') : '')) +
      '</div>' +
      (s.mode === 'tiers' && !deeper && !ro ? '<button type="button" class="link-btn" onclick="estSnowTap(\'deeper\')">+ Prices for 6–9" and 9"+</button>' : '') +
      '<div class="field snb-storm"><span class="label">Under the prices — what this bid says about storms <small class="muted">' +
        (String(s.stormNote || '').trim() ? 'this bid’s own words' + (ro ? '' : ' · <button type="button" class="link-btn" onclick="estSnowTap(\'storm\')">back to my usual words</button>')
          : 'your usual words (Pricing rules → Snow bids)') + '</small></span>' +
        '<textarea rows="3"' + (ro ? ' readonly' : '') + ' oninput="estSnowSet(\'storm\', \'\', this.value)">' + esc(snowStormNote(s)) + '</textarea></div>' +

      '<h4 class="est-h">Salt <span class="muted">— each application; leave empty for none</span></h4>' +
      '<div class="snb-prices">' + moneyBox('salt', '', s.saltCents, 'Salt per application', ro, snowYours('salt', type)) + '</div>' +
      '<div class="stage-steps">' + snowChip(!!s.paw, "estSnowTap('paw')", '🐾 Paw-friendly ice melt', ro) + '</div>' +

      '<h4 class="est-h">Extras <span class="muted">— each visit, e.g. a back deck</span></h4>' +
      (s.extras.length ? '<div class="snb-extras">' + s.extras.map(x => '<div class="snb-extra">' +
          '<input class="snb-xname" value="' + esc(x.name) + '" placeholder="What — e.g. Back deck"' + (ro ? ' readonly' : '') +
            ' oninput="estSnowSet(\'xname\', \'' + safeId(x.id) + '\', this.value)">' +
          '<span class="snb-money">$<input inputmode="decimal" value="' + esc(x.cents > 0 ? (x.cents / 100).toFixed(2) : '') + '" placeholder="0.00"' +
            (ro ? ' readonly' : '') + ' oninput="estSnowSet(\'xcents\', \'' + safeId(x.id) + '\', this.value)"></span>' +
          (ro ? '' : '<button type="button" class="bd-edit-btn del" onclick="estSnowTap(\'xdel\', \'' + safeId(x.id) + '\')" aria-label="Remove">✕</button>') +
        '</div>').join('') + '</div>' : '') +
      (ro ? '' : '<button type="button" class="btn btn-sm" onclick="estSnowTap(\'xadd\')">+ Add an extra</button>') +

      '<h4 class="est-h">Long storms <span class="muted">— labor per man-hour, if you charge it</span></h4>' +
      '<div class="snb-prices">' + moneyBox('labor', '', s.laborCents, 'Labor per man-hour', ro, snowYours('labor', type)) + '</div>' +

      '<div class="est-crewnote snb-crew"><span>👷 Notes for the crew — not on the bid; they go on the Snow account when it’s accepted</span>' +
        '<textarea rows="2"' + (ro ? ' readonly' : '') + ' placeholder="Where the snow goes, what to watch for — the gate code, the low wall by the drive"' +
        ' oninput="estSnowSet(\'crew\', \'\', this.value)">' + esc(s.crewNotes) + '</textarea></div>' +
    '</div>';
  }
  function snowProbsHtml() {
    const p = snowProblems();
    return p.length ? '<div class="est-problems snb-probs"><b>Before it can go to QuickBooks:</b><ul>' +
      p.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div>' : '';
  }
  function snowPreviewHtml(s) {
    const lines = snowLines(s, siteLine());
    const total = lines.reduce((a, l) => a + (l.cents || 0), 0);
    const q = qb();
    return '<div class="cv snb-cv"><div class="cv-head"><b>' + esc((el('customerName') && el('customerName').value) || 'Customer') + '</b>' +
        (q && q.docNumber ? ' · Estimate #' + esc(q.docNumber) : '') + '</div>' +
      lines.map(l => '<div class="cv-line"><div class="cv-text"><div class="cv-scope">' + esc(l.text) + '</div></div>' +
        '<div class="cv-amt">' + (l.cents > 0 ? cents(l.cents) : '—') + '</div></div>').join('') +
      '<div class="cv-total"><span>Total</span><b>' + cents(total) + '</b></div>' +
      '<div class="hint">Laid out as QuickBooks will show it: each line its own price, billed for each visit. ' +
        'No warranty, terms or payment lines on a snow bid.</div></div>';
  }
  // Said yes to: the bid in one look, under its QuickBooks line.
  function snowSummaryHtml(s) {
    const lines = snowLines(s, '');
    const areas = areasText(s);
    const row = (what, c) => '<div class="est-words-line"><b>' + esc(what) + '</b> ' + cents(c) + '</div>';
    return '<div class="est-words snb-sum"><h4 class="est-h">❄️ The snow bid <span class="muted">— per push</span></h4>' +
      (s.mode === 'perInch' ? SNOW_TIERS.slice(0, 1) : SNOW_TIERS).filter(t => s.tiers[t[0]] > 0)
        .map(t => row(t[1] + ' per push', s.tiers[t[0]])).join('') +
      (snowOver(s) && s.perInchCents > 0 ? row('Each inch over ' + snowOver(s) + '"', s.perInchCents) : '') +
      lines.filter(l => l.kind !== 'plow' && l.cents > 0).map(l => row(l.title, l.cents)).join('') +
      (areas ? '<div class="est-words-text">Clears the ' + esc(areas) + '.</div>' : '') +
      (String(s.crewNotes || '').trim() ? '<div class="est-words-crew">👷 For the crew: ' + esc(s.crewNotes.trim()) + '</div>' : '') +
    '</div>';
  }
  // On the Snow route already: the server marked the bid done.
  function snowWon() {
    const b = typeof boardFields !== 'undefined' && boardFields ? boardFields : {};
    return b.removeWhy === 'snow' || /^snow:/.test(String(b.replacedBy || ''));
  }
  function snowWonHtml(q, can) {
    if (!q || !q.id) return '';
    if (snowWon()) {
      return '<div class="snb-won">❄️ On the Snow route — their Snow account is priced from this bid. ' +
        '<button type="button" class="btn btn-sm ro-ok" onclick="switchTab(\'snow\')">Open Snow</button></div>';
    }
    if (isAccepted(q)) {
      return '<div class="snb-won">❄️ They said yes — Job Hub puts them on the Snow route. ' +
        (can ? '<button type="button" class="btn btn-sm btn-filled" onclick="estSnowYes()"' + (checking ? ' disabled' : '') + '>' +
          (checking ? 'Working…' : 'Do it now') + '</button>' : '') + '</div>';
    }
    if ((q.status || 'Pending') === 'Pending' && can) {
      return '<div class="est-invoice-quiet"><button type="button" class="link-btn" onclick="estSnowYes()"' + (checking ? ' disabled' : '') + '>' +
        (checking ? 'Working…' : 'Said yes another way? Put them on the Snow route') + '</button></div>';
    }
    return '';
  }

  // What the job's price is when it becomes a snow bid: nothing -- it has
  // no whole-job total (the price per push is shown instead, never added
  // into any total). One typed in by hand stays.
  function clearJobPrice() {
    if (typeof manualJobPrice === 'undefined' || manualJobPrice) return;
    const box = el('jobPrice');
    if (!box || !box.value) return;
    box.value = '';
    try { baseJobPrice = 0; } catch (e) { /* app.js not loaded */ }
    if (typeof updateJobPriceSourceTag === 'function') updateJobPriceSourceTag();
    if (typeof updateSummary === 'function') updateSummary();
  }
  // Switched by hand (true/false), or back to the services' say (null).
  window.estSnowBid = async function (on) {
    if (!changes()) return;
    const was = est;
    if (on === null) delete est.snowBid;
    else {
      if (on && hasLines() && !(await ydConfirm('Its labor and materials lines are kept — left off while it’s a snow bid, and back if you switch it off.',
        { title: 'Make this a snow bid, priced per push?', ok: 'Make it a snow bid' }))) { render(); return; }
      if (est !== was) return;
      est.snowBid = !!on;
    }
    if (snowNow()) { snowObj(); clearJobPrice(); }
    changed(true);
  };
  function snowChanged() {
    if (typeof markDirty === 'function') markDirty();
    render();
  }
  // Typed in a box: kept, and what depends on it caught up once the typing
  // pauses -- the box under the fingers is never drawn again.
  let snowTimer = null;
  function snowTyped() {
    if (typeof markDirty === 'function') markDirty();
    clearTimeout(snowTimer);
    snowTimer = setTimeout(() => {
      if (!snowNow()) return;
      const p = el('snbPreview'); if (p) p.innerHTML = snowPreviewHtml(snowObj());
      const b = el('snbProbs'); if (b) b.innerHTML = snowProbsHtml();
      renderQb();
    }, 400);
  }
  const posCents = v => { const c = toCents(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return c !== null && c > 0 ? c : null; };
  window.estSnowSet = function (field, key, v) {
    if (!changes() || !snowNow()) return;
    const s = snowObj();
    const x = key ? s.extras.find(e => safeId(e.id) === key) : null;
    if (field === 'tier' && key in s.tiers) s.tiers[key] = posCents(v);
    else if (field === 'perInch') s.perInchCents = posCents(v);
    else if (field === 'salt') s.saltCents = posCents(v);
    else if (field === 'labor') s.laborCents = posCents(v);
    else if (field === 'xname' && x) x.name = String(v || '').slice(0, 60);
    else if (field === 'xcents' && x) x.cents = posCents(v);
    else if (field === 'other') s.areasOther = String(v || '').slice(0, 300);
    else if (field === 'crew') s.crewNotes = String(v || '').slice(0, 2000);
    // Typed back to his usual words: the usual again (it follows his rules).
    else if (field === 'storm') s.stormNote = String(v || '').trim() === snowUsualStorm(s).trim() ? '' : String(v || '').slice(0, 600);
    else return;
    snowTyped();
  };
  window.estSnowUse = function (field, key, c) {
    if (!changes() || !snowNow() || !(Number(c) > 0)) return;
    const s = snowObj();
    if (field === 'tier' && key in s.tiers) s.tiers[key] = Math.round(c);
    else if (field === 'perInch') s.perInchCents = Math.round(c);
    else if (field === 'salt') s.saltCents = Math.round(c);
    else if (field === 'labor') s.laborCents = Math.round(c);
    else return;
    snowChanged();
  };
  window.estSnowTap = function (what, v) {
    if (!changes() || !snowNow()) return;
    const s = snowObj();
    if (what === 'type') s.type = v === 'commercial' || v === 'residential' ? v : null;
    else if (what === 'area' && SNOW_AREA_IDS.indexOf(v) !== -1) {
      const i = s.areas.indexOf(v);
      if (i === -1) s.areas = SNOW_AREA_IDS.filter(id => id === v || s.areas.indexOf(id) !== -1);
      else s.areas.splice(i, 1);
      s.areasSet = true;
    } else if (what === 'mode') s.mode = v === 'perInch' ? 'perInch' : 'tiers';
    else if (what === 'paw') s.paw = !s.paw;
    else if (what === 'deeper') s.deeper = true;
    else if (what === 'storm') s.stormNote = '';
    else if (what === 'xadd') {
      if (s.extras.length >= 12) { showToast('That’s as many extras as one bid takes'); return; }
      s.extras.push({ id: newId('sx'), name: '', cents: null });
      snowChanged();
      const boxes = document.querySelectorAll('#estimateWrap .snb-xname');
      if (boxes.length) boxes[boxes.length - 1].focus();
      return;
    } else if (what === 'xdel') {
      const at = s.extras.findIndex(x => safeId(x.id) === v);
      if (at === -1) return;
      const gone = s.extras.splice(at, 1)[0], jobAt = currentJobId, loadAt = loads;
      snowChanged();
      const back = () => {
        if ((jobAt ? currentJobId !== jobAt : loads !== loadAt) || !snowNow()) { showToast('Another job is open — nothing put back'); return; }
        const list = snowObj().extras;
        if (!list.some(x => x.id === gone.id)) { list.splice(Math.min(at, list.length), 0, gone); snowChanged(); }
      };
      const msg = 'Removed “' + (String(gone.name || '').trim() || 'the extra') + '”';
      if (typeof showUndo === 'function') showUndo(msg, back); else showToast(msg);
      return;
    } else return;
    snowChanged();
  };
  window.estSnowChat = function () {
    snowChatOpen[currentJobId || ''] = true;
    render();
    const b = el('estMsg'); if (b) b.focus();
  };

  // What gets cleared, from the words of his notes (plain matching, no
  // Claude): on leaving the notes only while he has not picked any himself,
  // and only ever adding -- a chip he took off stays off.
  function snowFromNotes(asked) {
    const s = snowObj(), words = String(est.notes || '');
    let n = 0;
    if (!s.areasSet || asked) {
      SNOW_AREAS.forEach(([id]) => {
        if (SNOW_AREA_WORDS[id].test(words) && s.areas.indexOf(id) === -1) { s.areas.push(id); n++; }
      });
      s.areas = SNOW_AREA_IDS.filter(id => s.areas.indexOf(id) !== -1);
    }
    if (s.paw === null && PAW_WORDS.test(words)) { s.paw = true; n++; }
    if (n) snowChanged();
    if (asked) showToast(n ? 'Picked from your notes — check what gets cleared' : 'Nothing more in your notes to pick — tap what gets cleared');
  }

  // The snow bid as Claude reads it (estimates.py draft_snow). d: the job's
  // saved copy when it is not the open one.
  function snowForClaude(e, d) {
    const s = e.snow || cleanSnow({});
    const dollars = c => (c > 0 ? c / 100 : null);
    const prices = {};
    SNOW_TIERS.forEach(t => { prices[t[0]] = dollars(s.tiers[t[0]]); });
    return { type: snowType(s, d ? d.business || '' : null), areas: s.areas.slice(), areasOther: s.areasOther, mode: s.mode,
             prices: prices, perInch: { dollars: dollars(s.perInchCents), over: snowOver(s) },
             salt: { dollars: dollars(s.saltCents), paw: !!s.paw },
             extras: s.extras.map(x => ({ name: x.name, dollars: dollars(x.cents) })),
             laborDollars: dollars(s.laborCents), crewNotes: s.crewNotes };
  }
  // Claude's answer about a snow bid: only words -- what gets cleared, the
  // extras' names (their prices stay his to fill), the crew's notes.
  function applySnow(e, r) {
    if (!e.snow) e.snow = cleanSnow({});
    const s = e.snow, did = !!r.updated;
    if (did) {
      s.areas = SNOW_AREA_IDS.filter(id => (r.areas || []).indexOf(id) !== -1);
      s.areasOther = String(r.areasOther || '').slice(0, 300);
      s.areasSet = true;
      s.crewNotes = String(r.crewNotes || '').slice(0, 2000);
      (r.extras || []).forEach(n => {
        const name = String(n || '').trim().slice(0, 60);
        if (name && s.extras.length < 12 && !s.extras.some(x => String(x.name || '').trim().toLowerCase() === name.toLowerCase())) {
          s.extras.push({ id: newId('sx'), name: name, cents: null });
        }
      });
    }
    e.questions = (r.questions || []).map(String);
    e.flags = (r.flags || []).map(String);
    e.chat.push({ role: 'assistant', text: String(r.reply || (did ? 'Updated the bid.' : 'No change.')),
                  at: new Date().toISOString(), changed: did });
    return did;
  }

  // What QuickBooks' answer says of a snow bid (quickbooks.py _snow_bid_now),
  // taken off the record so none of it lands in qbEstimate: the fields the
  // server wrote on the job (into this device's copy too), and what to say.
  function snowAnswer(r) {
    const out = { patch: null, said: '', done: false };
    if (!r || typeof r !== 'object') return out;
    const done = r.snowDone, acct = r.snowAccount, err = r.snowError;
    delete r.snowDone; delete r.snowAccount; delete r.snowError;
    const name = (el('customerName') && el('customerName').value.trim()) || 'They';
    if (done && typeof done === 'object') {
      out.patch = {};
      ['snowChecked', 'removeWhy', 'replacedBy', 'removeNote', 'bidStage', 'bidStageAt'].forEach(k => {
        if (done[k] !== undefined) out.patch[k] = done[k];
      });
      out.said = '❄️ ' + name + (acct && acct.made === false ? ' — joined to their Snow account (your prices there kept)'
        : ' is on the Snow route — their account is priced from this bid');
      out.done = true;
    } else if (err) out.said = '❄️ ' + err;
    else if (r.snowBid && isAccepted(r)) {
      out.said = 'QuickBooks says: accepted' + (r.env && r.env !== 'production'
        ? ' — but this is the test company, so nothing goes on the Snow route' : ' — it goes on the Snow route at the next hourly look');
    }
    return out;
  }
  window.estSnowYes = async function () {
    const q = qb(), jobId = currentJobId;
    if (!q || !q.id || checking || !sends() || !changes() || !snowNow()) return;
    if (!isAccepted(q) && !(await ydConfirm('Their Snow account is made from this bid, priced as it is, and the bid comes off the Bids board. ' +
        'QuickBooks still shows the estimate as waiting — mark it accepted there too if you like.',
        { title: 'They said yes — put them on the Snow route?', ok: 'Put them on the route' }))) return;
    if (currentJobId !== jobId || checking) return;
    checking = true; renderQb();
    try {
      const r = await askQb('/qb/estimate-status', { estimateId: q.id, jobId: jobId, env: q.env || null, snowYes: true });
      if (r.missing) { if (!goneFromQb(jobId, r)) showToast(r.error || 'That estimate is no longer in QuickBooks'); return; }
      const sn = snowAnswer(r);
      afterQb(jobId, r, false, sn.patch);
      showToast(sn.said || 'Nothing changed', 7000);
    } catch (e) {
      showToast('QuickBooks: ' + (e.message || e));
    } finally {
      checking = false; renderQb();
    }
  };

  // Into QuickBooks in his own words and products (snowLines). No ZIP
  // lookup and no trip -- what is on the job is checked as it is.
  async function snowToQB(email) {
    const startJob = currentJobId;
    const probs = snowProblems();
    if (probs.length) { showToast(probs[0]); return; }
    if (!(await zipChecked())) return;
    if (currentJobId !== startJob) return;
    const f = id => (el(id).value || '').trim();
    if (!f('customerName')) { showToast('Add a customer name first'); return; }
    const to = f('email'), q = qb() || {};
    const s = snowObj(), site = siteLine();
    const lines = snowLines(s, site);
    const total = lines.reduce((a, l) => a + (l.cents || 0), 0);
    if (email) {
      if (!to) { showToast('Add the customer’s email on the job first'); return; }
      if (!(await ydConfirm(cents(s.tiers['1-3']) + ' per push (1–3")' + (s.saltCents > 0 ? ', salt ' + cents(s.saltCents) + ' per application' : ''),
        { title: (q.sentAt ? 'Email the updated snow bid' : 'Email this snow bid') + ' to ' + to + ' from QuickBooks?', ok: 'Email it' }))) return;
      if (currentJobId !== startJob || saving || qbAsking) return;
    }
    qbAsking = true; renderQb();
    let real = false, same = true;
    try {
      real = await realCompanyOrTest(email ? 'Emailing this snow bid' : 'This snow bid');
      if (real && q.id) same = await qbUnchanged(q);
    } finally { qbAsking = false; renderQb(); }
    if (!real) { showToast('Not sent — QuickBooks is on the test company'); return; }
    if (!same) return;
    if (currentJobId !== startJob) { showToast('Another job was opened — nothing was sent'); return; }
    if (typeof autosave === 'function') autosave();
    const jobId = currentJobId;
    if (!jobId) { showToast('Save the job first'); return; }
    saving = true; renderQb();
    try {
      const out = await askQb('/qb/estimate', {
        jobId: jobId, email: !!email, testOk: !!(qbCompany && qbCompany.env !== 'production'),
        estimateId: q.id || null, customerId: q.customerId || hubCustomer() || null,
        env: q.env || (hubCustomer() ? 'production' : null),
        customer: { name: f('customerName'), email: to, phone: f('phone'), address: tidyCase(f('address')),
                    city: tidyCase(f('city')), state: stateWord(f('state')), zip: f('zip') },
        site: site,
        snowBid: { commercial: snowType(s) === 'commercial',
                   lines: lines.map(l => ({ kind: l.kind, qbItem: l.qbItem || '', text: l.text, cents: l.cents })) },
        // Nothing of an ordinary estimate goes with it: no takeoff, no
        // payments message, no warranty or terms, no lien-waiver notice.
        work: [], memo: '', endItems: [], lienNotice: false, totalCents: total,
      });
      const version = { at: new Date().toISOString(), emailed: !!email, docNumber: out.docNumber || null, snow: true,
        totalCents: total, taxCents: 0, materialsCents: 0, materials: [],
        work: lines.filter(l => l.cents > 0).map(l => ({ title: l.title, cents: l.cents })) };
      if (currentJobId === jobId) {
        est.sent = (est.sent || []).concat([version]).slice(-SENT_KEEP);
        if (typeof markDirty === 'function') markDirty();
      } else {
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
  }

  // The bid's services decide whether it is a snow bid (until switched by
  // hand): a service added or taken off draws it the right way.
  (function watchServices() {
    const t = el('serviceTypeTags');
    if (!t || typeof MutationObserver !== 'function') return;
    new MutationObserver(() => {
      if (!el('estimateWrap') || !P() || snowNow() === drawnSnow) return;
      if (jobShown() && !typingHere()) render(); else stale = true;
    }).observe(t, { childList: true, subtree: true });
  })();
  // His Snow accounts arrived: their prices are offered beside the boxes.
  document.addEventListener('yd-snow-accounts', () => {
    if (P() && snowNow() && jobShown() && !typingHere()) render();
  });

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
  // A photo from the site visit, taken from the bid itself. Jonah (21 Oct
  // 2026): "button on bid notes to take a photo that auto uploads photo to
  // job hub so i can do that with my phone or the ipad and not have to sift
  // through my icloud photos". The camera opens straight away (`capture`; a
  // computer offers its files) and the picture goes on the job as a Before
  // photo -- the site photos Claude looks at when it builds the bid
  // (functions/estimates.py _photos) -- through the job's own photo queue
  // (jobphotos.js jpPicked: shrunk, kept on the phone, sent when there is
  // signal). The line beside it says how many the job has.
  function snapWords(n) {
    return n ? '📷 ' + n + ' site photo' + (n === 1 ? '' : 's') + ' on this job — Claude looks at them when it builds the bid.'
      : 'It goes on the job as a Before photo — Claude looks at those when it builds the bid.';
  }
  function snapHtml(ro) {
    if (ro || !currentJobId || typeof window.jpPicked !== 'function') return '';
    const n = window.YDJobPhotos && YDJobPhotos.count ? YDJobPhotos.count(currentJobId, 'before') : null;
    return '<div class="est-snap"><label class="btn btn-sm est-snap-btn">📷 Take a photo' +
        '<input type="file" accept="image/*" capture="environment" hidden data-job="' + esc(currentJobId) + '"' +
        ' onchange="estSnap(this)"></label>' +
      '<span class="est-snap-n" data-est-snap>' + esc(snapWords(n)) + '</span></div>';
  }
  window.estSnap = function (input) {
    const n = (input.files || []).length;
    if (!n || typeof window.jpPicked !== 'function') return;
    // Said only for photos it took in: jpPicked says itself why one was not
    // (signed out, a file it could not read).
    const waiting = () => (window.YDJobPhotos && YDJobPhotos.waiting ? YDJobPhotos.waiting() : 0);
    const before = waiting();
    Promise.resolve(window.jpPicked(input, 'before')).then(() => {
      if (waiting() > before) showToast(n === 1 ? 'Photo added to the job (Before)' : n + ' photos added to the job (Before)');
    });
  };
  // The count follows the photos as they are taken, sent and come in.
  function snapCount() {
    const s = document.querySelector('[data-est-snap]');
    if (s && window.YDJobPhotos && YDJobPhotos.count) s.textContent = snapWords(YDJobPhotos.count(currentJobId, 'before'));
  }
  window.addEventListener('load', () => { if (window.YDJobPhotos && YDJobPhotos.onChange) YDJobPhotos.onChange(snapCount); });
  window.estMemoInput = function (v) { est.memo = v; if (typeof markDirty === 'function') markDirty(); };

  window.estSet = function (field, v) {
    if (!changes()) return;
    if (field === 'spoilCuYd' || field === 'brushCuYd') est[field] = num(v);
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
    // Miles typed in are his, and stay when the address changes; the box
    // emptied, they are looked up again.
    if (field === 'miles') {
      delete est.fuel.milesAt;
      if (est.fuel.miles === null && currentJobId) { delete trippedFor[currentJobId]; autoTrip(); }
    }
    changed(false);
  };

  window.estWork = async function (id, field, v) {
    const w = find(est.work, id);
    if (!w || !changes()) return;
    if (field === 'crewDays' || field === 'qty') w[field] = num(v);
    else if (field === 'rate') w.rateCents = toCents(v);
    else if (field === 'amount') w.amountCents = toCents(v);
    else if (field === 'allIn') w.allInCents = toCents(v);
    else if (field === 'add') w.addCents = toCents(v);
    else if (field === 'profit') {
      if (v === '__other') {
        const read = a => toCents(String(a).replace(/[$,\s]/g, ''));
        const a = await ydPrompt('', '', { title: 'Profit per crew-day for this line ($)', type: 'number', ok: 'Use it',
          check: a => { const c = read(a); return c !== null && c >= 0 ? '' : 'A dollar amount, please'; } });
        const c = a === null ? null : read(a);
        const now = find(est.work, id);          // the estimate may have been swapped meanwhile
        if (now && c !== null && c >= 0) now.profit = c;
        changed(true);                    // redrawn either way: the list shows what is chosen
        return;
      }
      w.profit = v === '' ? null : Number(v);
    }
    else if (field === 'kind') {
      // A fixed price turned all-in keeps its figure as the all-in one.
      if (v === 'allin' && num(w.allInCents) === null && num(w.amountCents) !== null) w.allInCents = w.amountCents;
      w.kind = v; changed(true); return;
    }
    // The customer reads this line with its materials in its price (customerLines).
    else if (field === 'withMats') { if (v) w.withMats = true; else delete w.withMats; changed(true); return; }
    // Done by a sub / installer (pricing.js workLine `sub`): ticked on, it
    // asks who and what they charge; ticked off, it is gone, and crew-days
    // typed on the line before count again (they are kept, never cleared).
    else if (field === 'subOn') {
      if (v) w.sub = { by: '', cents: null }; else delete w.sub;
      changed(true);
      return;
    }
    else if (field === 'subBy') { if (w.sub) w.sub.by = String(v || '').slice(0, 120); }
    else if (field === 'subCents') { if (w.sub) w.sub.cents = toCents(v); }
    // The service the line is, by hand (its how-we-do-it and its tools), or
    // back to the one its heading names. Nothing to re-price.
    else if (field === 'service') {
      if (v) w.service = String(v); else delete w.service;
      if (typeof markDirty === 'function') markDirty();
      if (typeof scheduleJobTools === 'function') scheduleJobTools();
      render();
      return;
    }
    // Typed in: the notes for the crew are his now -- Claude no longer
    // rewrites them unless he asks it to (workLine).
    else if (field === 'crewNote') { w.crewNote = String(v); w.crewNoteBy = 'hand'; wordsChanged(); return; }
    else { w[field] = String(v); wordsChanged(); return; }      // title, scope, QuickBooks product
    changed(false);
  };
  window.estPickPrice = function (id, pid) {
    const w = find(est.work, id);
    if (!w || !changes()) return;
    const p = pid ? book[pid] : null;
    // Another service: the adjustments ticked for the old one go.
    if (w.priceId !== (p ? pid : null)) w.adjust = [];
    w.priceId = p ? pid : null;
    if (p) {
      w.unit = p.unit || 'each';
      if (Number.isInteger(p.priceCents)) w.rateCents = p.priceCents;
      w.minimumCents = Number.isInteger(p.minimumCents) ? p.minimumCents : null;
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
    else if (field === 'taxIn') { if (v) m.taxIn = true; else delete m.taxIn; }
    else if (field === 'delivery' || field === 'category') { m[field] = v; changed(true); return; }
    else if (field === 'name') { m.name = String(v); wordsChanged(); return; }
    // Which line the crew's page lists it under: nothing to re-price.
    else if (field === 'forWork') { m.forWork = v ? String(v) : null; if (typeof markDirty === 'function') markDirty(); return; }
    // In an all-in price or not: the line's labour moves with it, and the
    // chip on the line says so.
    else if (field === 'allInOf') { m.allInOf = v ? String(v) : null; changed(true); return; }
    else m[field] = String(v);                               // the unit: it prices
    changed(false);
  };
  // Picking from Supplies takes its name for what the customer reads, unless
  // something is written there already.
  window.estPickSupply = function (id, sid) {
    const m = find(est.materials, id);
    if (!m || !changes()) return;
    const it = sid ? catalog().items[sid] : null;
    const was = m.supplyId || null;
    m.supplyId = it ? sid : null;
    // His pick: Claude's answers keep it (seedAsBought, matLine).
    if (it) m.handPicked = true; else delete m.handPicked;
    if (it && !String(m.name || '').trim()) m.name = it.name || '';
    // Picked by hand from the whole list: kept for these words too.
    if (it && window.YDMatch) YDMatch.remember(m.name, sid);
    changed(true);
    if (it && typeof ydOrderJoined === 'function') ydOrderJoined(m.name, sid, was);
  };

  // ------------------------------------------- typed-in items into Supplies
  //
  // Materials typed straight onto a bid (not picked from Supplies) can be
  // added to Supplies in one go: Jonah picks each one's supplier (or names a
  // new one), checks the unit and cost, and they are filed there -- priced
  // when a cost is given -- and the lines linked to them, so the next bid
  // and the order list find them. Plain code.

  let toSup = null;                 // lineId -> {vendorId, newVendor, unit, cost} while the panel is open
  const canAddSupplies = () => changes() && ydCan('supplies', 'change') && !!(window.YDSupplies && window.YDSupplies.addSourced);
  const typedLines = () => est.materials.filter(m => !m.plant && !m.supplyId && String(m.name || '').trim());

  function toSupHtml() {
    if (!toSup) return '';
    const lines = typedLines().filter(m => toSup[m.id]);
    if (!lines.length) return '';
    const vendors = Object.values(catalog().vendors).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const cats = P() ? kinds().filter(([k]) => k !== 'plant' && k !== 'tools') : [];
    return '<div class="est-tosup"><div class="est-src-head">Add to Supplies — pick where each one comes from</div>' +
      lines.map(m => {
        const id = safeId(m.id), t = toSup[m.id];
        return '<div class="est-tosup-row"><b>' + esc(m.name) + '</b>' +
          '<label><span>Supplier</span><select onchange="estToSupSet(\'' + id + '\', \'vendorId\', this.value, true)">' +
            '<option value="">— skip this one —</option>' +
            vendors.map(v => '<option value="' + esc(v.id) + '"' + (t.vendorId === v.id ? ' selected' : '') + '>' + esc(v.name) + '</option>').join('') +
            '<option value="new"' + (t.vendorId === 'new' ? ' selected' : '') + '>＋ A new supplier…</option></select></label>' +
          (t.vendorId === 'new' ? '<label><span>New supplier’s name</span><input value="' + esc(t.newVendor) + '" ' +
            'oninput="estToSupSet(\'' + id + '\', \'newVendor\', this.value)"></label>' : '') +
          '<label><span>Sold per</span><input value="' + esc(t.unit) + '" placeholder="each" oninput="estToSupSet(\'' + id + '\', \'unit\', this.value)" onchange="estToSupSet(\'' + id + '\', \'unit\', this.value, true)"></label>' +
          // Sold by the box but measured on the bid in feet: how much one covers.
          (m.unit && unitKey(t.unit) !== unitKey(m.unit)
            ? '<label><span>One ' + esc(t.unit || 'of these') + ' covers (' + esc(m.unit) + ')</span><input inputmode="decimal" value="' + esc(t.covers || '') + '" ' +
              'oninput="estToSupSet(\'' + id + '\', \'covers\', this.value)"></label>' : '') +
          '<label><span>Cost per ' + esc(t.unit || 'each') + ' ($)</span><input inputmode="decimal" value="' + esc(t.cost) + '" placeholder="blank = no price yet" ' +
            'oninput="estToSupSet(\'' + id + '\', \'cost\', this.value)"></label>' +
          '<label><span>Kind</span><select onchange="estToSupSet(\'' + id + '\', \'category\', this.value)">' +
            cats.map(([k, n]) => '<option value="' + esc(k) + '"' + (t.category === k ? ' selected' : '') + '>' + esc(n) + '</option>').join('') +
          '</select></label></div>';
      }).join('') +
      '<div class="field-actions"><button class="btn btn-sm btn-filled" onclick="estToSupSave()">Add to Supplies</button>' +
      '<button class="btn btn-sm" onclick="estToSupCancel()">Cancel</button></div></div>';
  }
  function redrawToSup() {
    const b = el('estToSup');
    if (b) b.innerHTML = toSupHtml();
  }
  window.estToSupplies = function () {
    if (!canAddSupplies()) return;
    toSup = {};
    typedLines().forEach(m => {
      toSup[m.id] = { vendorId: '', newVendor: '', unit: m.unit || 'each',
                      cost: num(m.costCents) > 0 ? (m.costCents / 100).toFixed(2) : '', category: m.category || 'other' };
    });
    render();
  };
  window.estToSupSet = function (id, k, v, redraw) {
    const m = find(est.materials, id);
    if (!toSup || !m || !toSup[m.id]) return;
    toSup[m.id][k] = String(v);
    if (redraw) redrawToSup();
  };
  window.estToSupCancel = function () { toSup = null; render(); };
  window.estToSupSave = function () {
    if (!toSup || !canAddSupplies()) return;
    const vendors = catalog().vendors;
    // Every row checked first: nothing is saved until all of them are right.
    const rows = [];
    let bad = '';
    typedLines().forEach(m => {
      const t = toSup[m.id];
      if (!t || !t.vendorId || bad) return;
      const vendor = t.vendorId === 'new' ? String(t.newVendor || '').trim() : (vendors[t.vendorId] || {}).name;
      if (!vendor) { bad = 'Give the new supplier a name'; return; }
      const c = String(t.cost || '').trim(), dollarsIn = c === '' ? null : Number(c.replace(/[$,\s]/g, ''));
      if (dollarsIn !== null && !(dollarsIn > 0)) { bad = 'A cost should be a dollar amount, or blank'; return; }
      const per = String(t.unit || '').trim() || 'each';
      let coverage = null;
      if (m.unit && unitKey(per) !== unitKey(m.unit)) {
        coverage = num(String(t.covers || '').replace(/[^0-9.]/g, ''));
        if (!(coverage > 0)) { bad = 'Say how many ' + m.unit + ' one ' + per + ' of “' + m.name + '” covers'; return; }
      }
      rows.push({ m: m, t: t, vendor: vendor, per: per, coverage: coverage, cents: dollarsIn === null ? null : Math.round(dollarsIn * 100) });
    });
    if (bad) { showToast(bad); return; }
    let added = 0;
    rows.forEach(r => {
      // "Terminal cap — Menards" is filed as "Terminal cap" under Menards.
      const name = String(r.m.name).trim().replace(new RegExp('\\s+[—–-]\\s*' + r.vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i'), '');
      const sid = window.YDSupplies.addSourced({ vendor: r.vendor, vendorId: r.t.vendorId === 'new' ? null : r.t.vendorId,
        name: name, per: r.per, cents: r.cents, category: r.t.category || '',
        coverage: r.coverage, takeoffUnit: r.coverage ? r.m.unit : '',
        note: 'Added from a bid ' + new Date().toISOString().slice(0, 10) });
      if (!sid) return;
      r.m.supplyId = sid;
      added++;
    });
    toSup = null;
    changed(true);
    showToast(added ? 'Added ' + added + ' to Supplies and linked ' + (added === 1 ? 'it' : 'them') : 'Pick a supplier for at least one');
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
  // A line of work among the materials is nothing to go and buy: no web
  // search is paid for to find where it is sold (workNotOrdered).
  const unpriced = l => l.problems.some(p => p === 'no price in Supplies' || p === 'no cost') &&
    !workNotOrdered(find(est.materials, l.id));
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
    // "4" PVC tee (into the drain line) — TEMP wall": the notes after a dash
    // or in brackets say what it is for, not what it is.
    const bare = String((m && m.name) || l.name || '').replace(/\s+[—–]\s.*$/, '').replace(/\([^)]*\)/g, ' ');
    const want = nameWords(bare);
    if (!want.length) return [];
    const c = catalog(), skip = P().NOT_FOR_ESTIMATES || [];
    let ids = Object.values(c.items)
      .filter(it => it.id !== l.supplyId && skip.indexOf(it.category) === -1 && c.prices[it.id] && num(c.prices[it.id].cents) > 0)
      .map(it => {
        const have = nameWords(it.name + ' ' + (it.also || ''));
        const hit = want.filter(w => have.indexOf(w) !== -1).length;
        return { it: it, hit: hit, score: hit / want.length };
      })
      .filter(x => x.hit >= Math.min(2, want.length) && x.score >= 0.6)
      .sort((a, b) => b.score - a.score || String(a.it.name).length - String(b.it.name).length)
      .map(x => x.it.id);
    // Seed is offered in its biggest bag only (the shortest names were the
    // 5 lb bags), and plain "grass seed" gets his usual one first.
    const M = window.YDMatch;
    if (M && M.biggestBag) {
      ids = ids.map(id => M.biggestBag(id, c)).filter((id, i, a) => a.indexOf(id) === i && id !== l.supplyId);
      const usual = M.plainSeed(bare) ? M.usualSeed(c) : null;
      if (usual && usual !== l.supplyId && num((c.prices[usual] || {}).cents) > 0) ids = [usual].concat(ids.filter(id => id !== usual));
    }
    return ids.slice(0, 3);
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

  window.estUseFound = async function (id, k) {
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
      const read = a => num(String(a).replace(/[^0-9.]/g, ''));
      const was = est;
      const a = await ydPrompt('So the estimate orders the right number of them.', '', {
        title: 'How much does one ' + o.per + ' cover, in ' + unit + '?', type: 'number', ok: 'Use it',
        check: a => read(a) > 0 ? '' : 'A number above 0, please' });
      if (a === null) return;
      // Another job opened, or this line gone, while it was asked.
      if (est !== was || find(est.materials, id) !== m || found[foundKey(id)] !== f) return;
      const n = read(a);
      if (!(n > 0)) return;
      coverage = n; takeoffUnit = unit;
    }
    // The line's own (unpriced) item takes the price only when it is sold the
    // same way; otherwise the product goes in as an item of its own.
    const c = catalog(), linked = m.supplyId ? c.items[m.supplyId] : null;
    const into = linked && unitKey(o.per) === unitKey((c.prices[linked.id] || {}).per || linked.unit) ? linked.id : null;
    const note = ('Found on the web ' + new Date().toISOString().slice(0, 10) + (o.where ? ' (' + o.where + ')' : '') + ': ' +
                  (o.url || 'no link') + (o.note ? ' — ' + o.note : '')).slice(0, 300);
    const sid = window.YDSupplies && window.YDSupplies.addSourced ? window.YDSupplies.addSourced({
      vendor: o.supplier, name: o.product, sku: o.sku, cents: priceCents, into: into, url: o.url,
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
  // Taken off, with Undo on the toast: the line goes back where it was, as
  // it was. Only onto the same job -- another job opened in between keeps
  // its own lines (a new job counts as the same until the form is loaded
  // with another).
  window.estRemove = function (kind, id) {
    if (!changes()) return;
    const list = kind === 'work' ? est.work : est.materials;
    const at = list.findIndex(x => safeId(x.id) === id);
    if (at === -1) return;
    const line = list[at], jobAt = currentJobId, loadAt = loads;
    if (kind === 'work') est.work = est.work.filter(x => safeId(x.id) !== id);
    else est.materials = est.materials.filter(x => safeId(x.id) !== id);
    changed(true);
    const name = String((kind === 'work' ? line.title : line.name) || '').trim() || (kind === 'work' ? 'the labor line' : 'the material');
    const putBack = () => {
      const same = jobAt ? currentJobId === jobAt : loads === loadAt;
      if (!same || !changes()) { showToast('Another job is open — nothing put back'); return; }
      const now = kind === 'work' ? est.work : est.materials;
      if (now.some(x => x.id === line.id)) return;
      now.splice(Math.min(at, now.length), 0, line);
      changed(true);
    };
    const msg = 'Removed “' + (name.length > 40 ? name.slice(0, 39) + '…' : name) + '”';
    if (typeof showUndo === 'function') showUndo(msg, putBack); else showToast(msg);
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
    if (snowNow()) { snowFromNotes(true); return; }
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
    // A snow bid's notes are read by the app itself -- what gets cleared --
    // never sent to Claude for a takeoff (Jonah, 16 Oct 2026: code over
    // Claude, and snow is priced per push).
    if (snowNow()) { if (notesTyped && changes()) snowFromNotes(false); return; }
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
             status: d ? d.jobStatus : statusNow(),
             location: [v('address'), [v('city'), v('state')].filter(Boolean).join(', ')].filter(Boolean).join(', '),
             estimate: d ? fromSaved(d.estimate || {}) : est, data: d };
  }

  function currentForClaude(e, city) {
    const r = P() ? P().price(e, ctx(city)) : null;
    const dollars = c => (num(c) === null ? null : num(c) / 100);
    // What the app prices each line at, for Claude to talk about (it never
    // sets one): the line's labour, an all-in line's split, and what each
    // material comes to for the customer.
    return {
      work: e.work.map((w, i) => {
        const p = r ? r.work[i] : null, a = p && p.allIn;
        return { id: w.id, title: w.title || '', scope: w.scope || '', kind: w.kind || 'crew',
          crewDays: num(w.crewDays), priceId: w.priceId || null, qty: num(w.qty),
          factors: (Array.isArray(w.adjust) ? w.adjust : []).map(a => a.id),
          amountDollars: dollars(w.amountCents), allInDollars: dollars(w.allInCents), addDollars: dollars(w.addCents),
          priced: p && p.cents ? p.cents / 100 : null,
          allInSplit: a && a.labourCents !== null ? { materials: (a.materialsCents + a.deliveryCents) / 100, count: a.count,
                                                      labour: a.labourCents / 100 } : null,
          // The notes for the crew on the line, and whether they are his own
          // words (typed by him) or still Claude's.
          crew: String(w.crewNote || '').slice(0, 1500), crewMine: crewNoteMine(w),
          // Done by a sub or installer: not his crew's days (its cost is
          // what they charge).
          doneBy: w.sub ? { who: String(w.sub.by || ''), chargeDollars: dollars(w.sub.cents) } : null };
      }),
      materials: e.materials.map((m, i) => ({ id: m.id, supplyId: m.supplyId || null, name: m.name || '', qty: num(m.qty),
        unit: m.unit || '', plant: !!m.plant, tree: m.tree || null,
        costEachDollars: num(m.costCents) === null ? null : m.costCents / 100, delivery: m.delivery || 'auto',
        allInOf: m.allInOf && e.work.some(w => w.id === m.allInOf && w.kind === 'allin') ? m.allInOf : '',
        // The item he picked on the line himself: Claude keeps it.
        handPicked: !!(m.handPicked && m.supplyId),
        customerDollars: r && r.takeoff[i] && r.takeoff[i].clientCents ? r.takeoff[i].clientCents / 100 : null })),
      spoilCuYd: num(e.spoilCuYd), brushCuYd: num(e.brushCuYd),
      totals: r ? { materials: r.materialsCents / 100, labour: r.laborCents / 100, total: r.totalCents / 100,
                    crewDays: r.crewDays, notPriced: r.problems.slice(0, 20) } : null,
    };
  }

  // Claude's estimate onto ours (e), line by line by id.
  function mergeWork(got, e) {
    return (got || []).map(g => workLine(g, g.id ? e.work.find(w => w.id === g.id) : null));
  }
  // A line's notes for the crew are Jonah's own once he has typed in them
  // (crewNoteBy 'hand'), or when written before Claude wrote any (no mark).
  const crewNoteMine = w => w.crewNoteBy === 'hand' || (!w.crewNoteBy && !!String(w.crewNote || '').trim());
  // His latest message is about what the crew are told ("tell the guys to
  // mind the sprinkler heads"): then Claude may change his own notes too.
  let crewAsked = false;
  const CREW_WORDS = /\b(crew|guys)\b/i;
  function workLine(g, was) {
    const w = was ? clone(was) : { id: newId('ew'), kind: 'crew', profit: null, qbItem: '' };
    w.title = String(g.title || '');
    w.scope = String(g.scope || '');
    // The same work told to the crew (Jonah, 21 Oct 2026: yes to Claude
    // writing "a 2–4 line crew version per line" when it builds the
    // estimate). Written into the line's notes for the crew while they are
    // empty or still Claude's; his own words only when he asked about the
    // crew -- and they stay his. Nothing said keeps what is there.
    const crew = String(g.crew || '').trim().slice(0, 3000);
    if (crew && (!crewNoteMine(w) || crewAsked)) {
      const his = crewNoteMine(w);
      w.crewNote = crew;
      w.crewNoteBy = his ? 'hand' : 'claude';
    }
    w.kind = ['crew', 'flat', 'amount', 'allin'].indexOf(g.kind) !== -1 ? g.kind : w.kind || 'crew';
    // Crew-days on any line: priced by them, or (by the unit, fixed) how
    // long it takes -- for his profit per day and the fuel.
    if (num(g.crewDays) > 0) w.crewDays = num(g.crewDays);
    if (w.kind === 'flat') {
      const p = g.priceId && book[g.priceId] ? book[g.priceId] : null;
      if (p) {
        const another = w.priceId !== g.priceId;
        if (another || num(w.rateCents) === null) w.rateCents = Number.isInteger(p.priceCents) ? p.priceCents : null;
        if (another) w.minimumCents = Number.isInteger(p.minimumCents) ? p.minimumCents : null;
        w.priceId = g.priceId; w.unit = p.unit || 'each';
        // The adjustments Claude says the site notes call for, copied from
        // the service with their amounts (an id it made up is ignored).
        if (Array.isArray(g.factors)) {
          const had = Array.isArray(w.adjust) && !another ? w.adjust : [];
          w.adjust = g.factors.map(fid => had.find(a => a.id === fid) ||
            ((p.factors || []).filter(f => f && f.id === fid).map(f => ({ id: f.id, name: String(f.name || ''), how: f.how || 'pct', amount: num(f.amount) || 0 }))[0]))
            .filter(Boolean);
        }
      }
      if (num(g.qty) !== null) w.qty = num(g.qty);
    }
    if (w.kind === 'amount' && num(g.amountDollars) > 0) w.amountCents = Math.round(num(g.amountDollars) * 100);
    if (w.kind === 'allin') {
      if (num(g.allInDollars) > 0) w.allInCents = Math.round(num(g.allInDollars) * 100);
      // Labour outside the all-in: as given now, none when it gives none.
      w.addCents = num(g.addDollars) > 0 ? Math.round(num(g.addDollars) * 100) : null;
    }
    return w;
  }
  // Which all-in line each material's price is in. Claude names a line it
  // is adding in the same answer by its title (it has no id yet); one that
  // names no all-in line here is charged on its own.
  function joinAllIn(e) {
    const lines = e.work.filter(w => w.kind === 'allin');
    const key = s => String(s || '').trim().toLowerCase();
    e.materials.forEach(m => {
      if (!m.allInOf) return;
      if (lines.some(w => w.id === m.allInOf)) return;
      const w = lines.find(x => key(x.title) === key(m.allInOf));
      m.allInOf = w ? w.id : null;
    });
  }
  function mergeMaterials(got, e, said) {
    return (got || []).map(g => matLine(g, g.id ? e.materials.find(m => m.id === g.id) : null, e, said));
  }
  // said: what the app changed of Claude's answer, for its flags.
  function matLine(g, was, e, said) {
    const items = catalog().items;
    const m = was ? clone(was) : { id: newId('em'), delivery: 'auto' };
    m.plant = !!g.plant;
    m.supplyId = !m.plant && g.supplyId && items[g.supplyId] ? g.supplyId : null;
    // Another item than the one he picked on the line: Claude's pick now.
    if (!was || was.supplyId !== m.supplyId) delete m.handPicked;
    m.name = String(g.name || (m.supplyId ? items[m.supplyId].name : '') || '');
    m.qty = num(g.qty);
    if (!m.supplyId) m.unit = String(g.unit || m.unit || '');
    // Joined to Supplies, the quantity is in the item's own takeoff unit --
    // a unit left from before ("3 lb" off QuickBooks) would be read wrongly
    // (pricing.js takes "lb" on a bag of known weight as pounds of it).
    else m.unit = /^(lbs?|pounds?)$/i.test(String(g.unit || '').trim()) && window.YDMatch &&
      YDMatch.pack(items[m.supplyId], catalog().prices[m.supplyId]).lb ? 'lb' : '';
    if (m.plant) m.tree = g.tree === 'single' || g.tree === 'multi' ? g.tree : null;
    if (num(g.costEachDollars) > 0) m.costCents = Math.round(num(g.costEachDollars) * 100);
    // Only what Jonah said for this job ("we'll pick up the edgers"); left
    // on auto, his rules say (pricing.js wayOf).
    if (['delivered', 'pickup', 'rides'].indexOf(g.delivery) !== -1) m.delivery = g.delivery;
    // An all-in line's id or title (joinAllIn makes it an id), or none.
    if (typeof g.allInOf === 'string') m.allInOf = g.allInOf.trim() || null;
    if (e) seedAsBought(m, e, said);
    return m;
  }

  // Grass seed as Jonah buys it (22 Oct 2026: "grass seed in jobs is always
  // madison park priced from the largest bag size unless otherwise
  // specified"): seed Claude puts on a line is his usual seed (Pricing rules)
  // unless his notes or messages name the one it picked, and always in its
  // biggest bag -- Claude's 5 lb bag priced seed at $5.04 a pound where the
  // 50 lb bag he buys is $4.14. A seed he picked on the line himself
  // (handPicked) is his and is never changed.
  function seedAsBought(m, e, said) {
    const M = window.YDMatch;
    if (!m.supplyId || m.handPicked || !M || !M.biggestBag) return;
    const c = catalog(), it = c.items[m.supplyId];
    if (!it) return;
    let sid = M.biggestBag(m.supplyId, c), swapped = false;
    const usual = M.isGrassSeed(it) ? M.usualSeed(c) : null;
    if (usual && c.items[usual] && M.famOf(c.items[usual]) !== M.famOf(it) && !M.namedIn(it, hisWords(e))) {
      sid = usual; swapped = true;
    }
    if (sid === m.supplyId) return;
    // The amount in the new item's measure: square feet stay square feet,
    // pounds of seed become pounds of the bag. Where they don't meet (square
    // feet of a seed sold by the pound with no coverage), Claude's pick stays.
    const f = M.fitQty({ qty: m.qty, unit: m.unit || measuredIn(it, c.prices[m.supplyId]) }, c.items[sid], c.prices[sid]);
    if (!f) return;
    // What the customer reads follows the item, unless it says something else.
    if (!String(m.name || '').trim() || m.name === it.name) m.name = c.items[sid].name || '';
    m.supplyId = sid;
    m.qty = f.qty;
    m.unit = M.unitKey(f.unit) === 'lb' ? 'lb' : '';
    if (swapped && said) {
      said.push('🌱 Grass seed: your usual ' + c.items[sid].name + ', not the ' + it.name + ' Claude picked — you didn’t name it. ' +
        'Tap another seed under the line to change it.');
    }
  }
  // What one of an item is measured in for estimates (supplymatch.js fitQty):
  // what it covers, or what it is sold by.
  const measuredIn = (it, pr) => num(it.coverage) > 0 ? String(it.takeoffUnit || '') : String((pr && pr.per) || it.unit || '');
  // Jonah's own words about the job: his site-visit notes and his messages.
  const hisWords = e => [e.notes].concat((e.chat || []).filter(x => x.role === 'user').map(x => x.text)).join(' \n ');
  // Only what changed (r.mode 'patch', estimates.py): the lines given are
  // changed in place or added at the end, the ids in r.removed come off, and
  // every other line stays exactly as it is.
  function patchLines(list, got, removed, line) {
    const out = list.map(x => clone(x));
    (got || []).forEach(g => {
      const i = g.id ? out.findIndex(x => x.id === g.id) : -1;
      if (i === -1) out.push(line(g, null));
      else out[i] = line(g, out[i]);
    });
    return out.filter(x => (removed || []).indexOf(x.id) === -1);
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
    // "Put it in QuickBooks" / "send it to them": Claude only builds the
    // estimate -- Jonah puts it in and sends it himself with the buttons,
    // after adding tags in QuickBooks (20 Oct 2026). Answered here in code,
    // with no Claude call to pay for.
    if (qbAsk(text)) { qbFromChat(text); return; }
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

  // 'put' (into QuickBooks, not emailed), 'email' (through QuickBooks to the
  // customer), or null: anything else goes to Claude. Either one is answered
  // with which button to tap (qbFromChat) -- the chat never sends.
  // Only a clear instruction counts: it needs a doing word.
  // Only a message that IS the instruction counts -- "put it in QuickBooks",
  // "ok send it to them", "put it in qb but don't email it". A sentence that
  // only mentions QuickBooks ("before you put it in QuickBooks, change...",
  // "don't put it in QuickBooks yet", "I already put it in QB") goes to
  // Claude, which knows which button does what.
  function qbAsk(text) {
    let t = String(text || '').toLowerCase().replace(/[’‘`]/g, "'").replace(/[.!,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
    t = t.replace(/^((ok(ay)?|yes|yep|yeah|great|perfect|cool|thanks|good|alright|all right|looks good|sounds good|please|now|so|go ahead and|can you|could you|you can|let's)\s+)+/, '')
      .replace(/\s+(please|now|thanks|thank you)$/, '').trim();
    const IT = '( (it|this|that|the (estimate|bid)|this (estimate|bid)))?';
    const QB = '(quick ?books|qbo|qb)';
    // To a person ("to pat") -- never "to QuickBooks", which is a put.
    const WHO = '( (over )?to (them|him|her|the customer|the client|(?!quick ?books\\b|qbo?\\b)[a-z]+))?';
    // "Send it through QuickBooks" is the button that emails it.
    if (new RegExp('^(send|e-?mail)' + IT + WHO + ' (through|via|from|with|using) ' + QB + '$').test(t)) return 'email';
    if (new RegExp('^(send|e-?mail)' + IT + WHO + '$').test(t) && /^(send|e-?mail) (it|this|the|that)/.test(t)) return 'email';
    const m = t.match(new RegExp('^(put|send|push|create|make|build|enter|load|upload|get|add)' + IT + ' (in|into|in to|to|over to|on) ' + QB));
    if (!m) return null;
    const rest = t.slice(m[0].length).trim();
    if (!rest) return 'put';
    if (/^(but |and )?(don't|dont|do not|not|no need to|without) (e-?mail|send)(ing)?( it)?( to (them|him|her|the customer|the client))?( yet)?$/.test(rest)) return 'put';
    if (new RegExp('^(and|then|and then) (e-?mail|send)( it)?' + WHO + '$').test(rest)) return 'email';
    return null;
  }
  function qbFromChat(text) {
    const at = new Date().toISOString();
    est.chat.push({ role: 'user', text: text, at: at, changed: false },
      { role: 'assistant', at: at, changed: false,
        text: 'I only build the estimate — I don’t put it in QuickBooks or send it. When it’s ready, tap ' +
              '“Put in QuickBooks, don’t email yet” under the estimate, add your tags in QuickBooks, and send it from there ' +
              '(or tap “Send through QuickBooks” to email it straight away).' });
    draftMsg = '';
    changed(true);
  }

  async function ask(jobId) {
    const job = jobFacts(jobId);
    const e0 = job && job.estimate;
    const asked = e0 && e0.chat[e0.chat.length - 1];
    if (!job || !asked || asked.role !== 'user') { askNext(); return; }
    building = jobId;
    if (jobId === currentJobId) render();
    const snowy = snowOf(e0, job.services, job.status, job.data ? job.data.qbEstimate : qb());
    // The newest site-visit (Before) photos go with the first build and with
    // a message about the photos; the ones he names by number ("photo 7")
    // with a message that names them (estimates.py _photos) -- not every
    // message: each photo costs (Jonah, 21 Oct 2026).
    const firstBuild = !(e0.work.length || e0.materials.length);
    const photoNums = snowy ? [] : photoNumsIn(asked.text);
    const photos = !snowy && (firstBuild || (!photoNums.length && PHOTO_WORDS.test(String(asked.text || ''))));
    try {
      const r = await window.YDClaude.post('/estimate/draft', {
        jobId: jobId,
        customer: job.customer,
        location: job.location,
        services: job.services,
        jobNotes: job.notes,
        siteNotes: String(e0.notes || '').trim(),
        chat: e0.chat.slice(-CHAT_SEND).map(m => ({ role: m.role, text: m.text })),
        // A snow bid is talked about as one (estimates.py draft_snow): its
        // price sheet, and no takeoff to price.
        current: snowy ? { work: [], materials: [] } : currentForClaude(e0, job.city),
        snow: snowy ? snowForClaude(e0, job.data) : undefined,
        // This copy of the app can take just the lines that change (less for
        // Claude to write, so cheaper and quicker).
        patchOk: true,
        photos: photos,
        photoNums: photoNums,
        // His usual grass seed in its biggest bag (Pricing rules): the one
        // Claude uses unless he names another (estimates.py).
        usualSeed: snowy || !window.YDMatch || !YDMatch.usualSeed ? null : YDMatch.usualSeed(catalog()),
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
  function apply(e, r, city) {
    if (r.mode === 'snow') return applySnow(e, r);
    const patch = r.mode === 'patch';
    const spoil = num(r.spoilCuYd) !== null ? (num(r.spoilCuYd) || null) : e.spoilCuYd;
    const brush = num(r.brushCuYd) !== null ? (num(r.brushCuYd) || null) : e.brushCuYd;
    const did = !!(r.updated !== false && ((r.work || []).length || (r.materials || []).length ||
      (patch && ((r.removed || []).length || spoil !== e.spoilCuYd || brush !== e.brushCuYd))));
    const said = [];
    if (did) {
      const lastAsk = e.chat.filter(m => m.role === 'user').slice(-1)[0];
      crewAsked = !!(lastAsk && CREW_WORDS.test(String(lastAsk.text || '')));
      e.work = patch ? patchLines(e.work, r.work, r.removed, workLine) : mergeWork(r.work, e);
      crewAsked = false;
      e.materials = patch ? patchLines(e.materials, r.materials, r.removed, (g, was) => matLine(g, was, e, said))
        : mergeMaterials(r.materials, e, said);
      e.spoilCuYd = spoil;
      e.brushCuYd = brush;
      joinAllIn(e);
    }
    e.questions = (r.questions || []).map(String);
    e.flags = (r.flags || []).map(String).concat(said);
    let text = String(r.reply || (did ? 'Updated the estimate.' : 'No change.'));
    // An all-in line's split, worked out by the app, under the answer: what
    // Jonah asked for is a sum, and the sum is the app's to do.
    if (did && P() && e.work.some(w => w.kind === 'allin')) {
      const says = allInSays(P().price(e, ctx(city, e)), e);
      if (says) text += '\n\n🧮 ' + says.replace(/\n/g, '\n🧮 ');
    }
    const msg = { role: 'assistant', text: text, at: new Date().toISOString(), changed: did };
    // Which of the job's photos it looked at for this answer, by number (none:
    // left off -- a field set to undefined would make the whole save fail).
    if (num(r.photos) > 0) msg.photos = num(r.photos);
    const seen = (Array.isArray(r.photoNums) ? r.photoNums : []).filter(Number.isInteger);
    if (seen.length) msg.photoNums = seen;
    e.chat.push(msg);
    return did;
  }

  function land(jobId, r) {
    if (jobId === currentJobId) {
      const before = { jobId: jobId, work: clone(est.work), materials: clone(est.materials), spoilCuYd: est.spoilCuYd, brushCuYd: est.brushCuYd,
                       questions: est.questions.slice(), flags: est.flags.slice(), snow: est.snow ? clone(est.snow) : null };
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
    apply(e, r, d.city || '');
    e.chat = e.chat.slice(-CHAT_KEEP);
    // Through JSON, as the form's save does: Firestore refuses a write with
    // an undefined anywhere in it.
    const patch = { estimate: clone(e) };
    // A snow bid has no whole-job price to follow.
    const total = P() && !snowOf(e, d.serviceTypes, d.jobStatus, d.qbEstimate) ? P().price(e, ctx(d.city || '')).totalCents : 0;
    if (!d.manualJobPrice && total > 0) {
      // Its add-ons and its invoice's change orders (app.js addOnsOf).
      const extra = typeof addOnsOf === 'function' ? addOnsOf(d)
        : (d.additionalCosts || []).reduce((s, x) => s + (parseFloat(x.materialCost) || 0) + (parseFloat(x.laborCost) || 0), 0);
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
    est.work = undo.work; est.materials = undo.materials; est.spoilCuYd = undo.spoilCuYd; est.brushCuYd = undo.brushCuYd;
    est.questions = undo.questions || []; est.flags = undo.flags || [];
    if (undo.snow !== undefined) est.snow = undo.snow;
    const lastMsg = est.chat[est.chat.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') lastMsg.changed = false;
    est.chat.push({ role: 'user', text: '(Undid that change.)', at: new Date().toISOString(), changed: false });
    undo = null;
    changed(true);
    showToast('Put back as it was');
  };

  window.estNewChat = async function () {
    const was = est;
    if (!(await ydConfirm('The estimate stays as it is.', { title: 'Start the conversation over?', ok: 'Start over' }))) return;
    if (est !== was) return;
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
  // The ZIP typed on the job is not the one the map has for its address
  // (14 Oct 2026: an estimate went out with the wrong ZIP on it).
  function zipWrong() {
    const s = est.site, typed = (el('zip') && el('zip').value || '').trim();
    return !!(s && s.zip && s.at === siteKey() && typed.slice(0, 5) !== s.zip && s.zipOk !== typed);
  }
  // A bid whose map point was found before the ZIP was kept has none to check
  // against: it is looked up once, just before sending.
  async function zipKnown() {
    const s = est.site, key = siteKey(), jobId = currentJobId;
    if (snowNow() || !s || s.at !== key || s.zip || s.zipLooked === key || !jobId || !window.YDClaude) return;
    s.zipLooked = key;
    try {
      const r = await window.YDClaude.post('/estimate/trip', {
        jobId: jobId, address: (el('address').value || '').trim(), city: (el('city').value || '').trim(),
        state: (el('state').value || '').trim(), zip: (el('zip').value || '').trim() });
      if (est.site === s && currentJobId === jobId && /^\d{5}/.test(String(r.zip || ''))) s.zip = String(r.zip).slice(0, 5);
    } catch (e) { /* no answer: sent as typed, as before */ }
  }
  // Before anything goes to QuickBooks: fix the ZIP, or keep it on purpose.
  // Two buttons, so neither answer can be had by mistake: change it, or
  // keep the typed one on purpose. × / Escape sends nothing.
  async function zipChecked() {
    if (!zipWrong()) return true;
    const s = est.site, typed = (el('zip').value || '').trim();
    const where = [tidyCase(el('address').value), tidyCase(el('city').value)].filter(Boolean).join(', ');
    const pick = await ydChoose('The ZIP on this job is ' + (typed || 'empty') + ', but the map has ' + where + ' in ' + s.zip + '.', [
      { id: 'fix', label: 'Change it to ' + s.zip },
      { id: 'keep', label: 'Send it with ' + (typed || 'no ZIP'), hint: 'as typed' },
    ], { title: 'Check the ZIP', cancel: 'Don’t send yet' });
    if (!pick || est.site !== s) return false;
    if (pick.id === 'fix') {
      el('zip').value = s.zip;
      el('zip').dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof markDirty === 'function') markDirty();
      s.at = siteKey();               // the same place on the map, under the corrected address
      return true;
    }
    s.zipOk = typed;
    return true;
  }
  // A town MDS delivers to by zone (Madison) needs the job's map point too.
  function zonedTown() {
    const r = P() && P().rules(), rates = (r && r.delivery && r.delivery.rates) || {};
    const base = P() ? P().placeKey((el('city') && el('city').value) || '') : '';
    return !!base && !est.deliveryTown && Object.keys(rates).some(k => P().placeKey(k).indexOf(base + ' ') === 0);
  }
  // Whether the miles should be looked up by themselves now (Jonah, 15 Oct
  // 2026: he should not have to press "Find miles"): an estimate with lines
  // that is missing its miles (fuel on) or the map point a town priced by
  // zone needs, on a job with an address and an id, open to someone who may
  // change it, with a signal -- and this address not looked up already this
  // visit (trippedFor). Never on an estimate the customer has said yes to:
  // its price is agreed, and miles landing on it would move it -- except
  // one accepted in QuickBooks, whose price stands whatever is found: its
  // delivery and fuel are counted at cost (21 Oct 2026), so it needs the
  // map point (the MDS zone) and the miles all the same.
  function tripWanted() {
    // A snow bid has no trip: it is priced per push, not by the miles.
    if (snowNow()) return false;
    const fixed = !!(P() && P().asAccepted(est));
    if (!currentJobId || !hasLines() || !changes() || (settled() && !fixed) || !navigator.onLine) return false;
    if (!window.YDClaude || !window.YDClaude.available()) return false;
    if (!(el('address') && el('address').value.trim())) return false;
    const needSite = zonedTown() && !(est.site && est.site.at === siteKey());
    // Miles looked up for another address (it was changed) are looked up again.
    const fu = est.fuel || {};
    const needMiles = (num(fu.miles) === null || (fu.milesAt && fu.milesAt !== siteKey())) && !(est.off || {}).fuel;
    return (needSite || needMiles) && trippedFor[currentJobId] !== siteKey();
  }
  function autoTrip() {
    if (!tripWanted()) return;
    // Asked again when the time comes: two redraws in a row would otherwise
    // both ask for the same miles.
    setTimeout(() => { if (tripWanted()) window.estFindMiles(false); }, 800);
  }
  // Until 15 Oct the lookup only started when the estimate was drawn whole,
  // so an address typed in after the lines were built -- or a signal coming
  // back -- never brought the miles. Now: once the address box is left
  // (not at every letter), and when the signal returns. The totals follow
  // the town at once, as the delivery rate is by town (and the job's price
  // with them, as after any change to the estimate -- but not once the
  // customer has said yes).
  document.addEventListener('change', e => {
    const t = e.target;
    if (!t || ['address', 'city', 'state', 'zip'].indexOf(t.id) === -1 || !jobShown() || !P() || !hasLines()) return;
    if (!settled() && typeof syncJobPriceFromProposals === 'function') syncJobPriceFromProposals();
    renderTotals();
    autoTrip();
  });
  window.addEventListener('online', () => { if (jobShown()) autoTrip(); });

  // Every other job too: its miles and map point looked up by themselves,
  // without anyone opening it (Jonah, 21 Oct 2026: "instead of pressing find
  // miles on estimates the hub just does it automatically"). On the owner's
  // device, one job at a time, each address once a visit, written through
  // patchJob like a move on the board. The rules are tripWanted's: never an
  // estimate the customer said yes to in Job Hub (its price would move), nor
  // a snow bid, nor the open job (autoTrip does that one, on the screen).
  const TRIPS_MAX = 30;           // lookups a visit, at most
  const tripTried = {};           // job id -> the address looked up this visit
  let tripsRunning = false, tripsTimer = null;
  const siteKeyOf = d => ['address', 'city', 'zip'].map(f => String(d[f] || '').trim().toLowerCase()).join('|');
  function zonedTownOf(city) {
    const rates = (P().rules().delivery || {}).rates || {};
    const base = P().placeKey(city || '');
    return !!base && Object.keys(rates).some(k => P().placeKey(k).indexOf(base + ' ') === 0);
  }
  function settledJob(d) {
    const q = d.qbEstimate, inv = d.qbInvoiceRef;
    return !!(q && q.id && (['Accepted', 'Closed', 'Converted'].indexOf(q.status) !== -1 || (inv && inv.id)));
  }
  function tripNeed(id, d) {
    if (!d || d.deletedAt || d.removeWhy || id === currentJobId || d.bidStage === 'lost') return false;
    const e = d.estimate;
    if (!e || typeof e !== 'object' || !((e.work || []).length || (e.materials || []).length)) return false;
    if (snowOf(e, d.serviceTypes, d.jobStatus, d.qbEstimate) || !String(d.address || '').trim()) return false;
    if (!P().asAccepted(e) && settledJob(d)) return false;
    const key = siteKeyOf(d);
    if (tripTried[id] === key) return false;
    const fu = e.fuel || {};
    const needMiles = (num(fu.miles) === null || (fu.milesAt && fu.milesAt !== key)) && !(e.off || {}).fuel;
    const needSite = zonedTownOf(d.city) && !e.deliveryTown && !(e.site && e.site.at === key);
    return needMiles || needSite;
  }
  function tripsForAll() {
    clearTimeout(tripsTimer);
    tripsTimer = setTimeout(runTrips, 4000);
  }
  async function runTrips() {
    if (tripsRunning || !P() || !P().ready() || !window.YDAuth || !window.YDAuth.isOwner || !ydCan('jobs', 'change')) return;
    if (!navigator.onLine || !window.YDClaude || !window.YDClaude.available() || !window.YDSync || typeof getJobIndex !== 'function') return;
    tripsRunning = true;
    try {
      let n = 0;
      for (const j of getJobIndex()) {
        if (n >= TRIPS_MAX || !navigator.onLine) break;
        let d = null;
        try { d = JSON.parse(readJobBlob(j.id) || 'null'); } catch (err) {}
        if (!tripNeed(j.id, d)) continue;
        const key = siteKeyOf(d);
        tripTried[j.id] = key;
        n++;
        let r = null;
        try {
          r = await window.YDClaude.post('/estimate/trip', { jobId: j.id, address: String(d.address).trim(),
            city: String(d.city || '').trim(), state: String(d.state || '').trim(), zip: String(d.zip || '').trim() });
        } catch (err) { continue; }
        // Read again: the job may have changed, or been opened, meanwhile.
        let now = null;
        try { now = JSON.parse(readJobBlob(j.id) || 'null'); } catch (err) {}
        if (!now || !now.estimate || j.id === currentJobId || siteKeyOf(now) !== key) continue;
        const e = clone(now.estimate);
        let got = false;
        if (r && Array.isArray(r.point) && typeof r.point[0] === 'number' && typeof r.point[1] === 'number') {
          e.site = { lat: r.point[0], lng: r.point[1], at: key, zip: /^\d{5}/.test(String(r.zip || '')) ? String(r.zip).slice(0, 5) : null,
                     zipOk: e.site && e.site.at === key ? e.site.zipOk || null : null };
          got = true;
        }
        const fu = e.fuel || {};
        if (r && num(r.miles) !== null && (num(fu.miles) === null || (fu.milesAt && fu.milesAt !== key))) {
          e.fuel = Object.assign({}, fu, { miles: Math.round(num(r.miles) * 10) / 10, milesAt: key });
          got = true;
        }
        if (got) window.YDSync.patchJob(j.id, { estimate: e });
        await new Promise(res => setTimeout(res, 1500));
      }
    } finally { tripsRunning = false; }
  }
  ['yd-jobs-changed', 'yd-pricing'].forEach(ev => document.addEventListener(ev, tripsForAll));

  // ------------------------------------------------ the crew's notes, by Claude
  //
  // Jonah (22 Oct 2026): "there needs to be specific notes per job for each
  // service ... simple bullet points ... were installing _ amount of edging
  // around _ garden beds" -- and, asked, "yes, automatically" for jobs made
  // in QuickBooks (an estimate built here gets them from the build). So on
  // his device, every booked or in-progress job's lines with no notes for
  // the crew go to Claude once (/estimate/crew: the words as the customer
  // read them, the materials for each line, the site notes), one job at a
  // time, and the bullets come back as Claude's (crewNoteBy 'claude') --
  // never over his own words, never into a line he emptied by hand
  // (crewNoteBy 'hand'). est.crewAsked: the lines already sent, so a line
  // added later is sent then and an answer of nothing is not asked twice.
  // "✨ Write the crew’s notes" on the job sends them again by hand.
  const CREW_MAX = 8;                 // jobs a visit, at most
  const crewTried = {};               // job id -> sent this visit
  let crewRunning = false, crewTimer = null, crewHere = false;
  const crewEmpty = w => !String(w.crewNote || '').trim() && w.crewNoteBy !== 'hand';
  function crewWanted(d, again) {
    const e = d && d.estimate;
    if (!e || typeof e !== 'object' || e.v !== 2) return [];
    const asked = Array.isArray(e.crewAsked) ? e.crewAsked : [];
    return (e.work || []).filter(w => w && w.id && (String(w.title || '').trim() || String(w.scope || '').trim()) &&
      (again ? crewEmpty(w) || w.crewNoteBy === 'claude' : crewEmpty(w) && asked.indexOf(w.id) === -1));
  }
  function crewNeed(id, d) {
    if (!d || d.deletedAt || d.removeWhy || crewTried[id]) return false;
    const st = typeof normStatus === 'function' ? normStatus(d.jobStatus, d) : d.jobStatus;
    if (st !== 'booked' && st !== 'inprogress') return false;
    if (snowOf(d.estimate || {}, d.serviceTypes, d.jobStatus, d.qbEstimate)) return false;
    return crewWanted(d, false).length > 0;
  }
  // What is sent: each line as the crew's page has it (its words, how much,
  // its materials -- dollar figures already blanked), and the site notes.
  function crewAsk(d, lines) {
    const parts = window.YDCrewJobs && YDCrewJobs.workParts ? YDCrewJobs.workParts(d) : null;
    const want = new Set(lines.map(w => safeId(w.id)));
    const work = parts ? parts.work.filter(w => want.has(w.id)) : lines.map(w => ({ id: safeId(w.id), title: w.title, scope: w.scope }));
    return { siteNotes: String((d.estimate || {}).notes || '').slice(0, 3000),
             lines: work.slice(0, 20).map(w => ({ id: w.id, title: w.title || '', scope: w.scope || '', qty: w.qty || null, unit: w.unit || '',
               materials: parts ? parts.materials.filter(m => m.work === w.id).map(m => ({ name: m.name, qty: m.qty, unit: m.unit })) : [] })) };
  }
  // Claude's bullets onto an estimate's lines: only where the line's notes
  // are still empty -- or, sent again by hand, still Claude's.
  function crewTake(e, sent, got, again) {
    const by = {};
    (got || []).forEach(x => { if (x && x.id && String(x.crew || '').trim()) by[x.id] = String(x.crew).trim().slice(0, 3000); });
    let n = 0;
    e.work.forEach(w => {
      const said = by[safeId(w.id)];
      if (!said || !(crewEmpty(w) || (again && w.crewNoteBy === 'claude'))) return;
      w.crewNote = said; w.crewNoteBy = 'claude'; n++;
    });
    e.crewAsked = Array.from(new Set((Array.isArray(e.crewAsked) ? e.crewAsked : []).concat(sent))).slice(-80);
    return n;
  }
  function crewForAll() {
    clearTimeout(crewTimer);
    crewTimer = setTimeout(runCrew, 6000);
  }
  async function runCrew() {
    if (crewRunning || !window.YDAuth || !window.YDAuth.isOwner || !ydCan('jobs', 'change')) return;
    if (!navigator.onLine || !window.YDClaude || !window.YDClaude.available() || !window.YDSync || typeof getJobIndex !== 'function') return;
    if (!window.YDSync.jobsHeard || !window.YDSync.jobsHeard()) return;
    crewRunning = true;
    try {
      let n = 0;
      for (const j of getJobIndex()) {
        if (n >= CREW_MAX || !navigator.onLine) break;
        let d = null;
        try { d = JSON.parse(readJobBlob(j.id) || 'null'); } catch (err) {}
        if (!crewNeed(j.id, d)) continue;
        crewTried[j.id] = true;
        n++;
        await crewWrite(j.id, d, false);
        await new Promise(res => setTimeout(res, 1500));
      }
    } finally { crewRunning = false; }
  }
  // One job's lines to Claude and back into the job: the open one through
  // the form (it is saved with it), any other through patchJob, read again
  // first (it may have changed meanwhile). Answers how many lines got notes,
  // or null when it could not be done.
  async function crewWrite(id, d, again) {
    const lines = crewWanted(d, again);
    if (!lines.length) return 0;
    const sent = lines.map(w => w.id);
    if (id === currentJobId) { crewHere = true; render(); }
    let r = null;
    try { r = await window.YDClaude.post('/estimate/crew', Object.assign({ jobId: id }, crewAsk(d, lines))); }
    catch (err) { r = null; }
    if (id === currentJobId) crewHere = false;
    if (!r || r.error) { if (id === currentJobId) render(); return null; }
    if (id === currentJobId) {
      const n = crewTake(est, sent, r.lines, again);
      changed(true);
      return n;
    }
    let now = null;
    try { now = JSON.parse(readJobBlob(id) || 'null'); } catch (err) {}
    if (!now || !now.estimate) return null;
    const e = clone(now.estimate);
    const n = crewTake(e, sent, r.lines, again);
    window.YDSync.patchJob(id, { estimate: e });
    return n;
  }
  // By hand, on the job: the lines with no notes, and Claude's own again.
  window.estCrewNotes = async function () {
    if (!changes() || crewHere || !currentJobId) return;
    if (!window.YDClaude || !window.YDClaude.available() || !navigator.onLine) { showToast('No signal — try again when there is'); return; }
    if (typeof autosave === 'function' && typeof dirty !== 'undefined' && dirty) autosave();
    const d = { estimate: est, serviceTypes: jobLike().serviceTypes, qbInvoiceRef: jobLike().qbInvoiceRef };
    if (!crewWanted(d, true).length) { showToast('Every line already has your own notes for the crew'); return; }
    const n = await crewWrite(currentJobId, d, true);
    showToast(n === null ? 'Claude could not write them just now — try again' : n ? 'Crew notes written for ' + n + ' line' + (n === 1 ? '' : 's') : 'Nothing new to write');
  };
  ['yd-jobs-changed'].forEach(ev => document.addEventListener(ev, crewForAll));
  window.addEventListener('online', crewForAll);
  window.addEventListener('online', tripsForAll);
  // An automatic lookup that found no miles says so beside the box, rather
  // than leaving it empty with no word why. job id -> the address it was for.
  const tripMissed = {};
  // Someone typing in the estimate: an answer arriving redraws only the
  // numbers, not the box under their fingers (and the iPad's keyboard).
  const typingHere = () => {
    const w = el('estimateWrap'), a = document.activeElement;
    return !!(w && a && w.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName));
  };
  window.estFindMiles = async function (asked) {
    if (tripping || !changes() || !window.YDClaude || snowNow()) return;
    if (!asked && !navigator.onLine) return;
    const addr = (el('address').value || '').trim();
    if (!addr) { if (asked) showToast('Add the job’s address first'); return; }
    // The job's map point is kept under its id, so it needs one.
    if (!currentJobId && typeof autosave === 'function') autosave();
    const jobId = currentJobId, key = siteKey();
    trippedFor[jobId] = key;
    delete tripMissed[jobId];
    tripping = true; renderTotals();
    try {
      const r = await window.YDClaude.post('/estimate/trip', {
        jobId: jobId, address: addr, city: (el('city').value || '').trim(), state: (el('state').value || '').trim(),
        zip: (el('zip').value || '').trim(),
      });
      // Another job was opened while the server answered: nothing lands on
      // the wrong job, and this one is asked again when it is next opened
      // (it used to count as asked, so its miles never came that visit).
      if (currentJobId !== jobId) { if (!asked) delete trippedFor[jobId]; return; }
      if (Array.isArray(r.point) && typeof r.point[0] === 'number' && typeof r.point[1] === 'number') {
        const keptZip = est.site && est.site.at === key ? est.site.zipOk || null : null;
        est.site = { lat: r.point[0], lng: r.point[1], at: key, zip: /^\d{5}/.test(String(r.zip || '')) ? String(r.zip).slice(0, 5) : null, zipOk: keptZip };
        if (zipWrong()) showToast('Check the ZIP: the map has this address in ' + est.site.zip, 6000);
      }
      if (num(r.miles) !== null) {
        // Miles typed by hand stay; an empty box is filled, and miles looked
        // up for the address before it changed are replaced (milesAt).
        const was = est.fuel || {};
        if (asked || num(was.miles) === null || (was.milesAt && was.milesAt !== key)) {
          est.fuel = Object.assign({}, est.fuel, { miles: Math.round(num(r.miles) * 10) / 10, milesAt: key });
        }
        changed(asked || !typingHere());
        // Found by itself: kept straight away, as Claude's answers are (land),
        // so opening another job a moment later does not lose them.
        if (!asked && typeof autosave === 'function') autosave();
        // A rural address the map does not know is measured to the town.
        if (asked || r.approx) showToast(est.fuel.miles + ' miles each way' + (r.approx ? ' — to the middle of town; check it' : ''));
      } else if (asked) showToast(r.error || 'Could not find that address');
      else tripMissed[jobId] = key;
    } catch (e) {
      if (asked) showToast('Miles: ' + (e.message || e));
      // The signal went: asked again when it comes back ('online').
      else if (!navigator.onLine) delete trippedFor[jobId];
      else tripMissed[jobId] = key;
    } finally {
      tripping = false; renderTotals();
    }
  };

  // ------------------------------------------------------- QuickBooks

  async function askQb(path, body) {
    if (window.YDClaude && window.YDClaude.post) return window.YDClaude.post(path, body);
    throw new Error('The server is not set up');
  }

  // Which QuickBooks company is connected (Jonah, 13 Oct 2026: a real bid
  // went into Intuit's TEST company -- production had never been switched
  // on). Asked once a session. While it is the test company the estimate
  // says so in red, and nothing is sent there unless he types TEST (the
  // server refuses it too, main.py).
  let qbCompany = null, qbCompanyAsked = false;
  async function qbCompanyNow() {
    if (qbCompany) return qbCompany;
    try {
      const s = await askQb('/qb/status', {});
      qbCompany = { env: s.env || '', name: s.company || '', connected: !!s.connected };
    } catch (e) { qbCompany = null; }
    return qbCompany;
  }
  function askCompany() {
    if (qbCompanyAsked || !sends()) return;
    qbCompanyAsked = true;
    qbCompanyNow().then(() => renderQb());
  }
  // true: go ahead (the real company, or he typed TEST for the test one).
  async function realCompanyOrTest(what) {
    const c = await qbCompanyNow();
    if (!c || c.env === 'production') return true;
    const typed = await ydPrompt('QuickBooks is connected to Intuit’s TEST company' + (c.name ? ' (“' + c.name + '”)' : '') +
      ' — NOT your real QuickBooks.\n\n' + what + ' would only go to the test company: not your real books, and no customer sees it.\n\n' +
      'Switch Job Hub to your real QuickBooks first. To send to the test company anyway, type TEST:', '', {
        title: 'This is the test company', ok: 'Send to the test company', cancel: 'Don’t send', danger: true,
        check: v => v.trim().toUpperCase() === 'TEST' ? '' : 'Type TEST to send it to the test company' });
    return !!typed && typed.trim().toUpperCase() === 'TEST';
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
  // Who a line done by someone else might be: his subcontractors (subs.js,
  // the owner's) and the names already on this estimate's other lines --
  // picked or typed, the box takes any name.
  window.estLoadSubNames = function () {
    const names = {};
    (window.YDSubs && YDSubs.list ? YDSubs.list() : []).forEach(s => { if (s.name) names[s.name] = true; });
    (est.work || []).forEach(w => { if (w.sub && String(w.sub.by || '').trim()) names[String(w.sub.by).trim()] = true; });
    let dl = el('estSubNames');
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'estSubNames'; document.body.appendChild(dl); }
    dl.innerHTML = Object.keys(names).sort().map(n => '<option value="' + esc(n) + '">').join('');
  };

  // True to go ahead: QuickBooks' estimate still totals what Job Hub last
  // put there, or he says to replace it anyway.
  async function qbUnchanged(q) {
    const lastSent = (est.sent || []).slice(-1)[0];
    if (!lastSent || !(lastSent.totalCents > 0)) return true;
    let now = null;
    try {
      const s = await askQb('/qb/estimate-status', { estimateId: q.id, env: q.env || null, jobId: currentJobId });
      if (s && !s.missing) now = Math.round(Number(s.total) * 100);
    } catch (e) { return true; }
    if (now === null || !isFinite(now) || Math.abs(now - lastSent.totalCents) <= 100) return true;
    return ydConfirm('Estimate #' + (q.docNumber || '') + ' was changed in QuickBooks: it totals ' + cents(now) +
      ' there, but Job Hub last sent ' + cents(lastSent.totalCents) + '.\n\nSending from Job Hub replaces it with Job Hub’s ' +
      'version — the changes made in QuickBooks will be lost. Make the same changes here first if you want to keep them.',
      { title: 'Replace it anyway?', ok: 'Replace it', cancel: 'Keep QuickBooks’ version', danger: true });
  }

  window.estToQB = async function (email) {
    if (saving || qbAsking || !sends() || !changes()) return;
    // A snow bid goes in his snow products and words (snowToQB).
    if (snowNow()) return snowToQB(email);
    const startJob = currentJobId;
    const r = priced();
    if (!r || !(r.totalCents > 0)) return;
    if (r.problems.length) {
      // Worded for the button pressed: "Put in QuickBooks, don't email yet"
      // asked "send it anyway?" (office test, 16 Oct 2026).
      if (!(await ydConfirm('• ' + r.problems.slice(0, 8).join('\n• '),
        { title: 'Some of this isn’t priced yet — ' + (email ? 'send it anyway?' : 'put it in QuickBooks anyway?'),
          ok: email ? 'Send it anyway' : 'Put it in anyway', cancel: 'Not yet' }))) return;
      if (currentJobId !== startJob || saving || qbAsking) return;
    }
    qbAsking = true; renderQb();
    try { await zipKnown(); } finally { qbAsking = false; renderQb(); }
    if (currentJobId !== startJob) return;
    if (!(await zipChecked())) return;
    if (currentJobId !== startJob) return;
    const f = id => (el(id).value || '').trim();
    if (!f('customerName')) { showToast('Add a customer name first'); return; }
    const to = f('email');
    const q = qb() || {};
    if (email) {
      if (!to) { showToast('Add the customer’s email on the job first'); return; }
      // Goes to the customer, so it is asked every time.
      if (!(await ydConfirm('Total ' + cents(r.grandCents) + (r.tax.cents > 0 ? ' (with ' + cents(r.tax.cents) + ' sales tax)' : ''),
        { title: (q.sentAt ? 'Email the updated estimate' : 'Email this estimate') + ' to ' + to + ' from QuickBooks?', ok: 'Email it' }))) return;
      if (currentJobId !== startJob || saving || qbAsking) return;
    }
    // Two questions for QuickBooks before anything is sent. A second tap, or
    // another job opened, while they are asked must not send twice or send
    // this estimate under the other job.
    qbAsking = true; renderQb();
    let real = false, same = true;
    try {
      real = await realCompanyOrTest(email ? 'Emailing this estimate' : 'This estimate');
      // Changed in QuickBooks since Job Hub last sent it (13 Oct 2026: #1677's
      // labour was raised there by hand): sending from here replaces the whole
      // estimate with Job Hub's version, so say so first.
      if (real && q.id) same = await qbUnchanged(q);
    } finally { qbAsking = false; renderQb(); }
    if (!real) { showToast('Not sent — QuickBooks is on the test company'); return; }
    if (!same) return;
    if (currentJobId !== startJob) { showToast('Another job was opened — nothing was sent'); return; }
    // The job is saved first so it has an id, and so what is on screen is
    // what is kept with the job.
    if (typeof autosave === 'function') autosave();
    const jobId = currentJobId;
    if (!jobId) { showToast('Save the job first'); return; }
    const site = siteLine();
    saving = true; renderQb();
    try {
      // Each line taxed or not (pricing.js salesTax): QuickBooks works out the
      // tax on the taxed ones from the job's address.
      // A line with its materials in its price (customerLines) goes as one
      // line, the materials named in its description.
      const cl = customerLines(r);
      const work = cl.work.map(w => ({ title: w.title, scope: withIncludes(w), cents: w.cents, qbItem: w.qbItem, taxable: w.taxable }));
      const parts = cl.parts;
      const out = await askQb('/qb/estimate', {
        jobId: jobId, email: !!email, testOk: !!(qbCompany && qbCompany.env !== 'production'),
        // The job's customer (customers.js) when this job has no QuickBooks
        // customer of its own yet: the estimate goes to their profile, not to
        // a new one made from however the name was typed.
        estimateId: q.id || null, customerId: q.customerId || hubCustomer() || null,
        env: q.env || (hubCustomer() ? 'production' : null),
        customer: { name: f('customerName'), email: to, phone: f('phone'), address: tidyCase(f('address')),
                    city: tidyCase(f('city')), state: stateWord(f('state')), zip: f('zip') },
        site: site,
        work: work,
        materialParts: parts.map(m => ({ head: m.head, list: m.list, cents: m.cents, taxable: m.taxed })),
        materials: { list: P().materialsList(r), cents: r.materialsCents },
        memo: String(est.memo || '').trim() || defaultMemo(r.totalCents),
        // The warranty and terms products, last (their text is read from
        // QuickBooks by the server).
        endItems: P().endItems(whoFor()),
        // A home gets Wisconsin's lien-waiver notice attached (a separate
        // page it must have before signing); the server attaches it once.
        lienNotice: whoFor() === 'home',
        totalCents: r.grandCents,
      });
      // QuickBooks' tax comes from the address; a county rate other than the
      // one in Pricing rules makes its total differ from Job Hub's.
      const qbTotal = Math.round(Number(out.total) * 100);
      if (isFinite(qbTotal) && Math.abs(qbTotal - r.grandCents) > 100) {
        setTimeout(() => showToast('QuickBooks’ total is ' + cents(qbTotal) + ' (its sales tax for this address) — Job Hub showed ' +
          cents(r.grandCents) + '. The message gives each payment as its share of the total, so it still adds up.', 9000), 2500);
      }
      // This version, as it went (see SENT_KEEP).
      const version = { at: new Date().toISOString(), emailed: !!email, docNumber: out.docNumber || null,
        totalCents: r.grandCents, taxCents: r.tax.cents, materialsCents: r.materialsCents,
        work: work.map(w => ({ title: w.title, cents: w.cents })), materials: P().materialsList(r),
        cost: costSnapshot(r) };
      // The fuel prices it was priced with stay with it once it has gone: the
      // weekly EIA figure moving must not move the price of an estimate the
      // customer already has (14 Oct 2026: a sent estimate re-priced itself
      // $1.28 higher). Cleared by hand, it follows the current price again.
      const keepFuel = f0 => {
        const fu = r.fuel || {};
        f0 = f0 || {};
        if (num(f0.gasCents) !== null && (num(f0.dieselCents) !== null || num(fu.dieselCents) === null)) return f0;
        return Object.assign({}, f0, {
          gasCents: num(f0.gasCents) !== null ? num(f0.gasCents) : num(fu.gasCents),
          dieselCents: num(f0.dieselCents) !== null ? num(f0.dieselCents) : num(fu.dieselCents) });
      };
      if (currentJobId === jobId) {
        est.sent = (est.sent || []).concat([version]).slice(-SENT_KEEP);
        est.fuel = keepFuel(est.fuel);
        if (typeof markDirty === 'function') markDirty();
      } else {
        // Another job was opened while QuickBooks answered: onto the saved copy.
        const d = savedJob(jobId);
        if (d && window.YDSync) {
          const e = fromSaved(d.estimate || {});
          e.sent = (e.sent || []).concat([version]).slice(-SENT_KEEP);
          e.fuel = keepFuel(e.fuel);
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

  // QuickBooks' answer in words. Real QuickBooks says Converted for an
  // estimate made into an invoice; the test company says Closed.
  const QB_SAID = { Pending: 'no answer yet', Accepted: 'accepted', Closed: 'made into an invoice',
                    Converted: 'made into an invoice', Rejected: 'turned down' };
  // The customer said yes: Accepted, or invoiced after an acceptance (QuickBooks
  // keeps the date it was accepted).
  const isAccepted = s => !!s && (s.status === 'Accepted' ||
    ((s.status === 'Closed' || s.status === 'Converted') && !!s.acceptedDate));
  // Already at a yes or past it, as last known: no news.
  const pastYes = s => !!s && ['Accepted', 'Closed', 'Converted'].indexOf(s.status) !== -1;
  function stillBid(jobId) {
    const d = savedJob(jobId);
    return !!d && typeof isBidStatus === 'function' && isBidStatus(d.jobStatus);
  }

  // What QuickBooks said, onto the job. A bid that was just emailed moves to
  // Sent (which starts the Follow up clock); QuickBooks' number becomes the
  // job's estimate number.
  //
  // The first time the answer is seen to be yes, the job notes when
  // (acceptedSeenAt, once, never moved -- the server's hourly check does the
  // same): a bid moved after that (marked lost after all) is left where it
  // was put, however often QuickBooks is asked again (sync.js bookIfAccepted).
  // extra: more fields for the same save -- what the server wrote on the job
  // when it put a snow bid on the Snow route (snowAnswer).
  function afterQb(jobId, r, emailed, extra) {
    const open = currentJobId === jobId;
    const was = (open ? qb() : null) || {};
    const merged = Object.assign({}, was, r);
    Object.keys(merged).forEach(k => { if (merged[k] === undefined) merged[k] = null; });
    // Made again after the last one was deleted in QuickBooks: that is over.
    if (merged.id) delete merged.deleted;
    const patch = Object.assign({}, extra || {}, { qbEstimate: merged });
    const stored = savedJob(jobId) || {};
    const before = open ? qb() : stored.qbEstimate;
    const seenAt = stored.acceptedSeenAt || (open && typeof boardFields !== 'undefined' && boardFields.acceptedSeenAt);
    if (isAccepted(r) && !seenAt) {
      // Seen at a yes before acceptedSeenAt existed: dated by QuickBooks'
      // own acceptance date, or the last look before this one -- not now,
      // or a bid marked lost in between would be booked all over again.
      patch.acceptedSeenAt = pastYes(before)
        ? String((before && (before.acceptedDate || before.syncedAt)) || new Date().toISOString())
        : new Date().toISOString();
    } else if (r.status === 'Pending' && seenAt) {
      // Back to waiting (changed and sent again): the next yes is news.
      patch.acceptedSeenAt = null;
    }
    // Emailed -- from here, or from QuickBooks itself, seen for the first
    // time (Jonah adds his tags in QuickBooks and sends it there): a bid
    // still waiting to go out moves to Sent, dated when it went. Only that
    // once, as the server's hourly look does (quickbooks.py _emailed_patch):
    // a bid put back by hand afterwards stays where it was put. The job's
    // own place and status -- the form's when it is the one open.
    const stage = open ? boardFields.bidStage : stored.bidStage;
    const status = open && typeof jobStatus !== 'undefined' ? jobStatus : stored.jobStatus;
    const nowEmailed = r.emailStatus === 'EmailSent' && !(before && before.emailStatus === 'EmailSent');
    if ((emailed || nowEmailed) && (typeof isBidStatus !== 'function' || isBidStatus(status)) &&
        ['won', 'lost', 'sent', 'followUp'].indexOf(stage) === -1) {
      patch.bidStage = 'sent';
      patch.bidStageAt = (!emailed && r.emailedAt) || new Date().toISOString();
    }
    if (window.YDSync) window.YDSync.patchJob(jobId, patch);
    if (currentJobId === jobId && r.docNumber && el('estimateNumber').value.trim() !== String(r.docNumber)) {
      el('estimateNumber').value = r.docNumber;
      if (typeof updateJobHeadBadge === 'function') updateJobHeadBadge();
      if (typeof markDirty === 'function') markDirty();
    }
    renderQb();
  }

  // QuickBooks answered that the job's estimate is deleted there (the server
  // has already put `deleted` on the job): onto this device's copy too, so
  // the Job tab offers to put it in again now. True when that was the answer.
  function goneFromQb(jobId, r) {
    if (!r || !r.deleted) return false;
    if (window.YDSync) window.YDSync.patchJob(jobId, { qbEstimate: r.deleted });
    const d = r.deleted.deleted || {};
    showToast('Estimate' + (d.docNumber ? ' #' + d.docNumber : '') + ' was deleted in QuickBooks — put it in again from the estimate', 7000);
    renderQb();
    return true;
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
      if (r.missing) { if (!goneFromQb(jobId, r) && !quiet) showToast(r.error || 'That estimate is no longer in QuickBooks'); return; }
      const wasBid = stillBid(jobId);
      // A snow bid said yes to was put on the Snow route by that same look
      // (quickbooks.py _snow_bid_now): said so, and never booked.
      const sn = snowAnswer(r);
      // Accepted books the bid by itself, on the owner's device (sync.js
      // bookIfAccepted, which this save passes through) -- no question asked.
      afterQb(jobId, r, false, sn.patch);
      if (sn.said) { if (!quiet || sn.done) showToast(sn.said, 7000); return; }
      // Asked by hand, the answer is always said: by the booking, when this
      // answer booked it (a moment after the save), else here -- an accepted
      // bid can stay a bid (another device's job to book, or it was moved
      // after the yes), and saying nothing then looked like no answer.
      if (!quiet) {
        setTimeout(() => {
          if (wasBid && !stillBid(jobId)) return;
          showToast('QuickBooks says: ' + (QB_SAID[r.status] || r.status || 'no answer yet') +
            (isAccepted(r) && stillBid(jobId) ? ' — still a bid here; “Make it a job” books it' : ''), 5000);
        }, 50);
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
    logBook(id, book[id], data);
    book[id] = Object.assign({}, book[id] || {}, data);
    Promise.resolve(window.YDDb.put('priceBook', id, data)).catch(e => {
      console.warn('[estimate] price not saved:', (e && e.code) || e);
      showToast('A price could not be saved');
    });
  }

  // A service's price, minimum or adjustments changed: into the change
  // history (changelog.js), kind 'service'. A brand-new service is recorded
  // once it has a price.
  function logBook(id, was, data) {
    const C = window.YDChangeLog;
    if (!C) return;
    const o = was || {};
    const n = Object.assign({}, o, data);
    const name = n.name || 'A service';
    const unitOf = p => (p.method === 'fixed' ? '' : p.method === 'crew' ? ' per crew-day' : p.unit ? ' per ' + p.unit : '');
    const price = p => (Number.isInteger(p.priceCents) ? C.money(p.priceCents) + unitOf(p) : 'no price');
    // An adjustment counts once it has an amount (a new blank one is not a change).
    const factors = all => {
      const list = (Array.isArray(all) ? all : []).filter(f => f && f.amount != null);
      return list.length ? list.map(f => (f.name || 'adjustment') + ' ' + (f.how === 'pct' ? f.amount + '%' : C.money(f.amount)) +
        (f.how === 'unit' ? ' per unit' : '')).join(', ') : 'none';
    };
    const lines = [];
    const base = { area: 'price', access: 'jobs', kind: 'service', what: 'Service — ' + name, ref: { path: 'priceBook', id: id } };
    if ('priceCents' in data || 'unit' in data || 'method' in data) {
      if (price(o) !== price(n) && (was || Number.isInteger(n.priceCents))) lines.push(Object.assign({}, base, { field: 'Price', before: was ? price(o) : 'new', after: price(n) }));
    }
    if ('minimumCents' in data && (Number.isInteger(o.minimumCents) ? o.minimumCents : null) !== (Number.isInteger(n.minimumCents) ? n.minimumCents : null) && (was || Number.isInteger(n.minimumCents))) {
      const m = c => (Number.isInteger(c) ? C.money(c) : 'none');
      lines.push(Object.assign({}, base, { field: 'Minimum charge', before: m(o.minimumCents), after: m(n.minimumCents) }));
    }
    if ('factors' in data && was && factors(o.factors) !== factors(n.factors)) {
      lines.push(Object.assign({}, base, { field: 'Adjustments', before: factors(o.factors), after: factors(n.factors) }));
    }
    if (lines.length) C.add(lines);
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
      // Turf and the like are priced by the square foot and adjusted by
      // factors, not by profit per day (Jonah, 13 Oct 2026).
      '<p class="hint">Every service you sell and how it is priced. ' +
        '<b>By the unit</b>: a price per sq ft, foot, each… plus the things that adjust it, ticked on each estimate. ' +
        '<b>By crew-days</b>: priced at your profit per day — your notes say how. <b>Fixed</b>: one price. ' +
        'Your notes on how a service is priced are read by Claude every time it builds an estimate; customers never see them. ' +
        'Materials still come from Supplies.</p>' +
      (ro ? '' : '<div class="field-actions">' +
        '<button class="btn btn-sm btn-filled" onclick="pbAdd()">+ Add a service</button>' +
        (sends() ? '<button class="btn btn-sm" onclick="pbFromQb()">Bring in from QuickBooks</button>' : '') +
        '<button class="btn btn-sm" onclick="pbPasteOpen()">Paste a sheet</button>' +
      '</div>') +
      '<div id="pbPaste" hidden class="field mt"><span class="label">Paste from Excel or Sheets — columns: Name, Unit, Price, Category, Description, Notes for Claude (only Name and Price are needed)</span>' +
        '<textarea id="pbPasteText" rows="6"></textarea>' +
        '<div class="field-actions"><button class="btn btn-sm btn-filled" onclick="pbPasteSave()">Add these</button>' +
        '<button class="btn btn-sm" onclick="pbPasteOpen(false)">Cancel</button></div></div>' +
      '<input id="pbFilter" class="mt" placeholder="Search your services" value="' + esc(f) + '" oninput="pbFilterInput(this.value)">' +
      (list.length ? '<div class="pb-list">' + list.map(p => {
        const head = (p.category || '') !== lastCat ? '<div class="pb-cat">' + esc(p.category || 'No group') + '</div>' : '';
        lastCat = p.category || '';
        return head + serviceHtml(p, ro);
      }).join('') + '</div>'
        : '<div class="empty-msg">' + (f ? 'Nothing matches.' : 'No services yet. Add one — e.g. Artificial turf, by the sq ft.') + '</div>');
  }

  // One service, everything about it in one card.
  const METHODS = [['unit', 'By the unit'], ['crew', 'By crew-days'], ['fixed', 'Fixed price']];
  const HOWS = [['pct', '% of the price'], ['unit', '$ per unit'], ['flat', '$ once']];
  function serviceHtml(p, ro) {
    const id = safeId(p.id), dis = ro ? ' disabled' : '';
    const method = p.method || 'unit';
    const on = (field, v, ph, cls, mode) => '<input class="' + (cls || '') + '" value="' + esc(v == null ? '' : v) + '" placeholder="' + esc(ph) + '"' +
      (mode ? ' inputmode="' + mode + '"' : '') + dis + ' onchange="pbField(\'' + id + '\', \'' + field + '\', this.value)">';
    const area = (field, v, ph, rows) => '<textarea rows="' + rows + '" placeholder="' + esc(ph) + '"' + (ro ? ' readonly' : '') +
      ' onchange="pbField(\'' + id + '\', \'' + field + '\', this.value)">' + esc(v || '') + '</textarea>';
    const money = c => (Number.isInteger(c) ? (c / 100).toFixed(2) : '');
    const factors = (p.factors || []).filter(x => x && x.id);
    return '<div class="pb-card">' +
      '<div class="pb-top">' + on('name', p.name, 'Service, e.g. Artificial turf', 'pb-name') +
        '<select' + dis + ' onchange="pbField(\'' + id + '\', \'method\', this.value)">' +
          METHODS.map(([k, n]) => '<option value="' + k + '"' + (k === method ? ' selected' : '') + '>' + n + '</option>').join('') + '</select>' +
        (ro ? '' : '<button class="bd-edit-btn del" onclick="pbRemove(\'' + id + '\')" aria-label="Remove">✕</button>') + '</div>' +
      (method === 'crew' ? '<div class="hint">Priced by crew-days at your profit per day. Your notes below tell Claude how to work out the days.</div>'
        : '<div class="pb-nums">' +
          '<label><span>' + (method === 'fixed' ? 'Price ($)' : 'Price per unit ($)') + '</span>' + on('price', money(p.priceCents), '0.00', '', 'decimal') + '</label>' +
          (method === 'fixed' ? '' : '<label><span>Unit</span>' + on('unit', p.unit, 'sq ft', 'pb-unit') + '</label>') +
          '<label><span>Minimum charge ($)</span>' + on('minimum', money(p.minimumCents), 'none', '', 'decimal') + '</label>' +
          '<label><span>Group</span>' + on('category', p.category, 'e.g. Turf & lawn', 'pb-catin') + '</label>' +
        '</div>') +
      '<div class="field"><span class="label">How it’s priced — your notes (Claude reads these on every estimate)</span>' +
        area('notes', p.notes, 'e.g. Base price by the sq ft of turf laid. Add for slope, tight access, old lawn to strip, long hauls; less for big open areas. Infill and base are materials.', 3) + '</div>' +
      (method === 'crew' ? '' : '<div class="pb-factors"><span class="label">What adjusts it (ticked on each estimate)</span>' +
        factors.map(x => {
          const fid = safeId(x.id);
          const fon = (field, v, ph, mode, cls) => '<input class="' + (cls || '') + '" value="' + esc(v == null ? '' : v) + '" placeholder="' + esc(ph) + '"' +
            (mode ? ' inputmode="' + mode + '"' : '') + dis + ' onchange="pbFactor(\'' + id + '\', \'' + fid + '\', \'' + field + '\', this.value)">';
          const amt = x.how === 'pct' ? (num(x.amount) == null ? '' : String(num(x.amount))) : money(x.amount);
          return '<div class="pb-factor">' + fon('name', x.name, 'e.g. Steep slope', '', 'pb-fname') +
            '<select' + dis + ' onchange="pbFactor(\'' + id + '\', \'' + fid + '\', \'how\', this.value)">' +
              HOWS.map(([k, n]) => '<option value="' + k + '"' + (k === (x.how || 'pct') ? ' selected' : '') + '>' + n + '</option>').join('') + '</select>' +
            fon('amount', amt, x.how === 'pct' ? 'e.g. 15 (or -10)' : 'e.g. 0.40', 'decimal', 'pb-famt') +
            (ro ? '' : '<button class="bd-edit-btn del" onclick="pbFactor(\'' + id + '\', \'' + fid + '\', \'remove\')" aria-label="Remove">✕</button>') +
          '</div>';
        }).join('') +
        (ro ? '' : '<button class="btn btn-sm" onclick="pbFactorAdd(\'' + id + '\')">+ Add an adjustment</button>') + '</div>') +
      '<details class="pb-desc-box"' + (p.description ? ' open' : '') + '><summary>What the customer reads (optional)</summary>' +
        area('description', p.description, 'Scope wording put on the estimate when this service is picked', 2) + '</details>' +
      (p.qbItemName ? '<span class="pb-qb" title="QuickBooks product">QB: ' + esc(p.qbItemName) + '</span>' : '') +
    '</div>';
  }
  window.pbFactorAdd = function (id) {
    if (!changes() || !book[id]) return;
    const list = (book[id].factors || []).slice();
    list.push({ id: newId('f'), name: '', how: 'pct', amount: null });
    writeBook(id, { factors: list });
    renderBook();
  };
  window.pbFactor = function (id, fid, field, v) {
    if (!changes() || !book[id]) return;
    let list = (book[id].factors || []).map(x => Object.assign({}, x));
    const x = list.find(y => safeId(y.id) === fid);
    if (!x) return;
    if (field === 'remove') list = list.filter(y => y !== x);
    else if (field === 'name') x.name = String(v).trim().slice(0, 80);
    else if (field === 'how') { x.how = ['pct', 'unit', 'flat'].indexOf(v) !== -1 ? v : 'pct'; x.amount = null; }
    else if (field === 'amount') {
      const s = String(v).replace(/[$,%\s]/g, '');
      if (s === '') x.amount = null;
      else if (!isFinite(parseFloat(s))) { showToast('The amount should be a number'); renderBook(); return; }
      else x.amount = x.how === 'pct' ? Math.round(parseFloat(s) * 100) / 100 : Math.round(parseFloat(s) * 100);
    }
    writeBook(id, { factors: list });
    renderBook();
  };
  window.pbFilterInput = function (v) {
    renderBook(v);
    const i = el('pbFilter'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); }
  };

  window.pbField = function (id, field, v) {
    if (!changes() || !book[id]) return;
    if (field === 'price' || field === 'minimum') {
      const c = window.YDSupplies.parseCents(v);
      if (typeof c === 'number' && isNaN(c)) { showToast('That amount isn’t a number'); renderBook(); return; }
      writeBook(id, { [field === 'price' ? 'priceCents' : 'minimumCents']: c == null ? null : c });
    } else if (field === 'method') {
      writeBook(id, { method: ['unit', 'crew', 'fixed'].indexOf(v) !== -1 ? v : 'unit' });
    } else if (field === 'name') {
      if (!String(v).trim()) { showToast('A price needs a name'); renderBook(); return; }
      writeBook(id, { name: String(v).trim(), qbItemId: null, qbItemName: null });
    } else {
      writeBook(id, { [field]: String(v).trim() });
    }
    renderBook();
  };
  window.pbAdd = async function () {
    const name = await ydPrompt('', '', { title: 'Add a service to the price book', placeholder: 'e.g. Artificial turf', ok: 'Add it' });
    if (!name || !name.trim()) return;
    const id = newId('pb');
    writeBook(id, { name: name.trim(), method: 'unit', unit: 'sq ft', priceCents: null, minimumCents: null, factors: [],
                    category: '', description: '', notes: '',
                    qbItemId: null, qbItemName: null, active: true, createdAt: new Date().toISOString() });
    renderBook();
  };
  window.pbRemove = async function (id) {
    const p = book[id];
    if (!p || !(await ydConfirm('Estimates already made keep their lines.',
      { title: 'Take “' + (p.name || '') + '” out of the price book?', ok: 'Take it out', danger: true }))) return;
    if (!book[id]) return;
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
  // nobody is typing in it, otherwise just the numbers -- and not at all
  // while the Job tab is hidden (a Pricing rules change is two redraws, a
  // Supplies import dozens): it is drawn once when the tab is next opened.
  // The job's price follows either way; the Tracking tab shows it.
  const jobShown = () => { const p = el('panel-job'); return !!(p && p.classList.contains('active')); };
  function repaint() {
    if (jobShown()) {
      const w = el('estimateWrap');
      const a = document.activeElement;
      if (w && a && w.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) renderTotals();
      else render();
    } else stale = true;
    if (typeof syncJobPriceFromProposals === 'function') syncJobPriceFromProposals();
  }
  // Supplies or the kinds of material changed: the pickers' list is drawn
  // afresh the next time one is used.
  function onCatalog() {
    supplyList = null; kindsNow = null;
    repaint();
  }
  document.addEventListener('yd-supplies', onCatalog);
  document.addEventListener('yd-pricing', onCatalog);
  // A job issue on the open job came or was handled: it shows under its
  // material (jobissues.js tells only when the open job's changed).
  document.addEventListener('yd-job-issues', () => {
    if (!el('estimateWrap') || !P() || snowNow()) return;
    if (jobShown() && !typingHere()) render(); else stale = true;
  });
  // The Job tab opened (app.js switchTab sets its class): drawn now if
  // anything changed while it was hidden -- and on a phone, the boxes drawn
  // while it was hidden are sized to what is in them now they can be measured.
  (function watchJobTab() {
    const p = el('panel-job');
    if (!p || typeof MutationObserver !== 'function') return;
    new MutationObserver(() => {
      if (!jobShown()) return;
      if (stale) render(); else drawn(el('estimateWrap'));
    }).observe(p, { attributes: true, attributeFilter: ['class'] });
  })();

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const k = on ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k !== authKey) { authKey = k; if (on) start(); else stop(); }
    render();
  });
})();
