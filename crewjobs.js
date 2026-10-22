// The crew's view of a job: everything they need on site, no prices.
//
// Jonah (12 Oct 2026): "i need a separate interface for the crew to see
// where its all the client info & job info without prices for everything &
// then they can upload images there" -- name, address, phone and site notes;
// "after a job is booked i want the job page to have the estimate
// information attached without pricing so it should say all the
// measurements, type of mulch were laying, everything that is important info
// for the crew to know"; every booked and in-progress job, with a switch on
// the job to hide one.
//
// The crew cannot read jobs/* at all (a job carries the quote, the costs and
// the margin, and Firestore cannot hide a field), so each booked or
// in-progress job also gets a crew-safe copy, jobCrew/{jobId}, written from
// the same save that writes the clock's jobBoard entry (sync.js). It carries
// only what is listed in crewEntry() -- and any dollar amount typed into a
// note or a scope is blanked, since a note might say what was agreed.
//
// The crew read it on their Jobs tab; the owner sees exactly the same page
// from the Job tab (👷 What the crew see).
//
// THE WORK, LAID OUT FOR DOING IT. Jonah (14 Oct 2026): "i want the crew to
// be able to see the specific notes about all the work the square footage for
// the beds the linear footage of the edging etc all the info that would be
// important to know to do the work." The estimate already holds all of it:
// each labour line's scope; the takeoff, every material in the unit it is
// MEASURED in (320 sq ft of pavers, 120 ft of edging, 3.5 cu yd of mulch --
// the net figure, before waste, which is the size of the job); a service sold
// by the unit (1,200 sq ft of sod); the soil to haul away; the site-visit
// notes. So the page goes line by line -- each piece of work with its notes
// for the crew and the materials for it underneath -- and any measurement
// written in a note is in bold. Which line a material is for is worked out
// from the words (workFor) unless Jonah picked it on the estimate.

(function () {
  'use strict';

  const SHOWN = ['booked', 'inprogress'];
  let jobs = {};              // id -> crew copy (a crew phone)
  let unsub = null;
  const sent = {};            // id -> what this device last wrote (no rewrite of the same)
  const waiting = {};         // id -> a job whose copy waits for Supplies to load (its units)
  const forced = {};          // id -> a job whose copy went up without them, to send again
  let waitTimer = null;
  let reconciled = false;
  const el = id => document.getElementById(id);
  const safe = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const statusOf = d => (typeof normStatus === 'function' ? normStatus(d.jobStatus, d) : (d.jobStatus || 'quoting'));
  // A price typed into free text ("gave them $500 off") never reaches a
  // crew phone.
  // Any money written into free text ("$4,500", "$ 500", "$.50", "budget
  // ~15k", "800 dollars", "USD 300") -- never measurements, which the crew
  // need ("320 sq ft", "45 ft of edging").
  const noMoney = s => String(s == null ? '' : s)
    .replace(/[$＄]\s*\.?\d[\d,]*(\.\d+)?/g, '$—')
    .replace(/\busd\s*\d[\d,]*(\.\d+)?/gi, '$—')
    .replace(/\b\d[\d,]*(\.\d+)?\s?(k|grand|dollars?|bucks|usd)\b/gi, '$—');
  const numOr = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

  // The job's own notes are the OFFICE's: on real jobs they hold invoice
  // numbers, late fees, what was paid and what is still owed -- with the
  // dollar figures blanked (noMoney) the facts still showed on a crew
  // phone. But on a job brought in from QuickBooks the same notes carry the
  // work itself, which the crew need. So the notes go line by line (and
  // bullet by bullet), and any piece that talks about billing is left out;
  // the rest goes. The proper answer is a notes-for-the-crew box of its own
  // on the job -- Jonah's call; until then this keeps the money side home.
  const BILLING = /\b(invoic\w*|paid|unpaid|prepaid|owe[sd]?|owing|balance|late\s*fees?|deposits?|payments?|due|quick\s*books|qbo|estimate\s*(#|no\b|number))/i;
  function crewNotes(text) {
    return String(text == null ? '' : text).split(/\r?\n/).map(line => {
      if (!BILLING.test(line)) return line;
      // A line with bullets in it loses only its billing pieces.
      const dot = (line.match(/[•·▪●]/) || ['•'])[0];
      const kept = line.split(/[•·▪●]/).map(s => s.trim()).filter(s => s && !BILLING.test(s));
      return kept.length ? (/^\s*[•·▪●]/.test(line) ? dot + ' ' : '') + kept.join(' ' + dot + ' ') : null;
    }).filter(line => line !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function catalogue() {
    const c = window.YDSupplies && YDSupplies.catalog ? YDSupplies.catalog() : null;
    return c || { items: {}, prices: {}, vendors: {} };
  }
  function vendorName(id) {
    const c = catalogue();
    return (c.vendors && c.vendors[id] && c.vendors[id].name) || '';
  }

  // The unit a material line is counted in -- the same one the estimate
  // shows beside its quantity (estimate.js, pricing.js materialLine): an
  // item that covers an area or a length ("1 roll covers 750 sq ft") is
  // counted in that; anything else in the unit it is sold by. A line picked
  // from Supplies keeps no unit of its own, so it is looked up here. Only the
  // unit is read from the price record -- never a price.
  function unitOf(m) {
    if (m.plant) return '';
    const it = m.supplyId ? catalogue().items[m.supplyId] : null;
    if (!it) return String(m.unit || '');
    if (numOr(it.coverage) > 0) return String(it.takeoffUnit || '');
    const pr = catalogue().prices[m.supplyId];
    return String((pr && pr.per) || it.unit || m.unit || '');
  }
  // Supplies has loaded on this device (and its units with it). A crew copy
  // made before then would go up with its units missing, so it waits.
  function catalogueReady() {
    if (!window.YDSupplies || !YDSupplies.catalog) return true;
    const c = YDSupplies.catalog();
    if (!Object.keys(c.items || {}).length) return false;
    // The suppliers too: each order line carries its supplier's name.
    if (!Object.keys(c.vendors || {}).length) return false;
    return !!c.pricesReady || Object.keys(c.prices || {}).length > 0 || !ydCan('supplies', 'see');
  }
  const needsCatalogue = d => ((d.estimate || {}).materials || []).some(m => m && m.supplyId && !m.plant);

  // ---------------------------------------- which piece of work a material is for
  //
  // Picked by hand on the estimate (m.forWork: a labour line's id, or 'none'
  // for the whole job), else worked out from the words: the material's name
  // and what kind of material it is, against each line's heading (which
  // counts for more) and scope. A job with one line puts everything on it. A tie, or
  // nothing in common, is the whole job's -- base gravel shared by the patio
  // and the walk is listed once, not under one of them by chance.
  const KIND_HINTS = {
    soil: 'soil topsoil grading bed lawn', fill: 'fill grading',
    mulch: 'mulch bed', stone: 'gravel base stone patio walk', decorative: 'rock stone bed',
    pavers: 'paver patio walk walkway path driveway step', wall: 'wall block retaining seat',
    natural: 'flagstone boulder stone step', firepit: 'fire pit firepit', fireplace: 'fireplace',
    kitchen: 'kitchen grill', edging: 'edging edge border bed', hardscape: 'patio wall walk base fabric',
    adhesive: 'patio wall walk', drainage: 'drain drainage downspout gutter', seed: 'seed lawn grass turf',
    planting: 'plant planting tree shrub', plant: 'plant planting tree shrub perennial',
  };
  const STOP = new Set(('the and for with from into over under onto per each new old our their your this that ' +
    'bag ton yard yd cu sq ft inch lb roll pallet piece box case color colour natural mix grade').split(' '));
  function wordsOf(text) {
    const out = new Set();
    String(text || '').toLowerCase().split(/[^a-z]+/).forEach(w => {
      if (w.length < 3) return;
      if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) w = w.slice(0, -1);   // pavers -> paver, beds -> bed
      if (!STOP.has(w)) out.add(w);
    });
    return out;
  }
  function workFor(m, work, items) {
    const lines = (work || []).filter(Boolean);
    if (!m || m.forWork === 'none' || !lines.length) return '';
    if (m.forWork && lines.some(w => w.id === m.forWork)) return m.forWork;
    // In a line's all-in price: that line's material.
    if (m.allInOf && lines.some(w => w.id === m.allInOf)) return m.allInOf;
    if (lines.length === 1) return lines[0].id || '';
    const it = m.supplyId && items ? items[m.supplyId] : null;
    const kind = m.plant ? 'plant' : (it && it.category) || m.category || '';
    // The material's own words count for more than what its kind suggests:
    // "landscape fabric" belongs with the bed whose scope says fabric, not
    // the patio its kind (hardscape) leans towards.
    const named = wordsOf(m.name), hinted = wordsOf(KIND_HINTS[kind] || '');
    let best = '', top = 0, tie = false;
    lines.forEach(w => {
      const title = wordsOf(w.title), scope = wordsOf(w.scope);
      let score = 0;
      named.forEach(x => { score += title.has(x) ? 6 : scope.has(x) ? 4 : 0; });
      hinted.forEach(x => { if (!named.has(x)) score += title.has(x) ? 2 : scope.has(x) ? 1 : 0; });
      if (score > top) { top = score; best = w.id || ''; tie = false; }
      else if (score === top && score > 0) tie = true;
    });
    return top > 0 && !tie ? best : '';
  }

  // The tools the job takes (services.js toolsFor: its services' tools,
  // with what was changed by hand on the job), names and machine types
  // only. Left out altogether until the services list has been read on this
  // device: the copy is merged on the server, so the tools already there
  // stay rather than being written over with none.
  const servicesReady = () => !!(window.YDServices && YDServices.ready && YDServices.ready());
  function toolsEntry(d) {
    return YDServices.jobTools(d).slice(0, 60).map(t => ({
      name: noMoney(t.name).slice(0, 80), kind: t.eq ? noMoney(t.kindName).slice(0, 40) : '', qty: t.qty || null }));
  }

  // ------------------------------------------------ rentals
  //
  // Jonah (21 Oct 2026): "rentals always need to be specially noted for the
  // crew with where to pick them up and for how long." A rental (Supplies
  // kind 'rental': the mini-excavator, the jumping jack) is on the estimate
  // and priced in, never shown to the customer (pricing.js NOT_LISTED); here
  // it gets its own section on the crew's page instead of a line among the
  // materials: what, how long, and the shop -- name, address, phone, hours
  // -- with directions. Whether it is reserved (its order line ticked).
  const isRental = (m, items) => {
    const it = m && m.supplyId ? items[m.supplyId] : null;
    return String((it && it.category) || (m && m.category) || '').toLowerCase() === 'rental';
  };
  function shopOf(vid) {
    const v = vid ? (catalogue().vendors || {})[vid] : null;
    if (!v) return null;
    return { name: String(v.name || '').slice(0, 80), address: String(v.address || '').slice(0, 200),
             phone: String(v.phone || '').slice(0, 40), hours: String(v.hours || '').slice(0, 120) };
  }
  function rentalsEntry(d, items) {
    const est = d.estimate || {}, out = [], seen = {};
    const orderOf = sid => (d.orderItems || []).find(o => o && o.supplyId === sid);
    (est.materials || []).filter(m => m && m.name && isRental(m, items)).slice(0, 20).forEach(m => {
      const it = m.supplyId ? items[m.supplyId] : null;
      const o = m.supplyId ? orderOf(m.supplyId) : null;
      if (m.supplyId) seen[m.supplyId] = true;
      out.push({ name: noMoney((it && it.name) || m.name).slice(0, 200), days: numOr(m.qty), unit: noMoney(unitOf(m)).slice(0, 30),
                 shop: shopOf(it && it.vendorId), reserved: !!(o && o.ordered) });
    });
    // One put on the order list by hand, not on the estimate.
    (d.orderItems || []).filter(o => o && o.name && o.supplyId && !seen[o.supplyId] && isRental(o, items)).slice(0, 10).forEach(o => {
      const it = items[o.supplyId];
      out.push({ name: noMoney(it.name || o.name).slice(0, 200), days: numOr(o.qty), unit: noMoney(o.per || '').slice(0, 30),
                 shop: shopOf(it.vendorId), reserved: !!o.ordered });
    });
    return out;
  }

  // The change orders on the job's QuickBooks invoice (quickbooks.py
  // _invoice_changes): work the crew must know about, after the rest, in
  // QuickBooks' words -- never what it costs.
  function changeWork(d) {
    // Only those the job counts (app.js qbChangesOf): one whose change
    // orders were put in by hand has them in its own lines already.
    const ref = d.qbInvoiceRef || {};
    const counted = typeof d.qbChangesIn === 'number' && !d.qbChangesOff;
    return (counted && Array.isArray(ref.changes) ? ref.changes : []).filter(c => c && (c.name || c.words)).slice(0, 20).map((c, i) => {
      const name = String(c.name || c.item || '');
      return { id: 'co' + (safe(c.id) || i), title: noMoney(/change order/i.test(name) ? name : 'Change order — ' + name).slice(0, 200),
               scope: noMoney(c.words).slice(0, 6000), crewNote: '', days: null, qty: null, unit: '' };
    });
  }

  // What a crew member may know about a job -- nothing else is copied.
  function crewEntry(d) {
    const est = d.estimate || {};
    const lines = (est.work || []).filter(w => w && (w.title || w.scope || w.crewNote)).slice(0, 40);
    const items = catalogue().items;
    const out = {
      name: String(d.customerName || '').trim() || 'Untitled job',
      // What the job is, in a few words (app.js jobWhat), beside the name.
      what: typeof jobWhat === 'function' ? noMoney(jobWhat(d)) : '',
      address: d.address || '', city: d.city || '', state: d.state || '', zip: d.zip || '',
      phone: d.phone || '',
      status: statusOf(d),
      est: String(d.estimateNumber || '').trim(),
      services: (d.serviceTypes || []).slice(0, 20),
      siteNotes: noMoney(est.notes).slice(0, 8000),
      notes: noMoney(crewNotes(d.notes)).slice(0, 4000),
      // Each piece of work: its scope, Jonah's notes for the crew (never on
      // the estimate), and -- a service sold by the unit -- how much of it.
      // The scope whole, as the customer was sent it (a QuickBooks line holds
      // up to 4,000 characters; cut at 3,000, the end of a long one was lost).
      work: lines.map((w, i) => ({
        id: safe(w.id) || 'w' + i,
        title: noMoney(w.title).slice(0, 200), scope: noMoney(w.scope).slice(0, 6000),
        crewNote: noMoney(w.crewNote).slice(0, 3000),
        days: numOr(w.crewDays),
        qty: w.kind === 'flat' ? numOr(w.qty) : null,
        unit: w.kind === 'flat' ? noMoney(w.unit).slice(0, 30) : '',
      })).concat(changeWork(d)),
      // The takeoff: how much of each, in the unit it is measured in, and
      // which piece of work it is for (an id from `work`; '' the whole job).
      // (Rentals have their own section: `rentals`.)
      materials: (est.materials || []).filter(m => m && m.name && !isRental(m, items)).slice(0, 120)
        .map(m => ({ name: noMoney(m.name).slice(0, 200), qty: numOr(m.qty), unit: noMoney(unitOf(m)).slice(0, 30),
                     plant: !!m.plant, tree: m.plant && (m.tree === 'single' || m.tree === 'multi') ? m.tree : '',
                     work: safe(workFor(m, lines, items)),
                     how: m.delivery === 'pickup' ? 'pick up' : m.delivery === 'rides' ? 'rides on a delivery' : '' })),
      // Soil and debris to haul away (cu yd), as the estimate has it.
      spoil: numOr(est.spoilCuYd),
      // Brush only: it goes in a dumpster of its own.
      brush: numOr(est.brushCuYd),
      order: (d.orderItems || []).filter(o => o && o.name && !isRental(o, items)).slice(0, 120)
        .map(o => ({ name: noMoney(o.name).slice(0, 200), qty: noMoney(o.quantity || o.qty || '').slice(0, 30),
                     per: noMoney(o.per || '').slice(0, 30), supplier: vendorName(o.vendorId), ordered: !!o.ordered })),
      rentals: rentalsEntry(d, items),
    };
    if (servicesReady()) out.tools = toolsEntry(d);
    return out;
  }
  const shows = d => SHOWN.indexOf(statusOf(d)) !== -1 && !d.crewHidden && !d.removeWhy && !d.deletedAt;

  // Called from sync.js with every job it sends up: the crew copy follows.
  // Only whoever may change jobs writes it (the rules say so too), and only
  // when it actually differs from what was last written. `force`: go up even
  // though Supplies never loaded (better a copy without units than none).
  function mirror(id, d, force) {
    if (!window.YDDb || typeof ydCan !== 'function' || !ydCan('jobs', 'change') || !id) return;
    if (!d || !shows(d)) {
      delete waiting[id];
      if (sent[id] === null) return;
      sent[id] = null;
      Promise.resolve(window.YDDb.remove('jobCrew', id)).catch(() => {});
      return;
    }
    if (!force && needsCatalogue(d) && !catalogueReady()) {
      waiting[id] = d;
      if (!waitTimer) waitTimer = setTimeout(() => flushWaiting(true), 30000);
      return;
    }
    delete waiting[id];
    // Sent before Supplies arrived (its units missing): sent again when it does.
    if (force && needsCatalogue(d) && !catalogueReady()) forced[id] = d; else delete forced[id];
    const entry = crewEntry(d);
    const sig = JSON.stringify(entry);
    if (sent[id] === sig) return;
    sent[id] = sig;
    Promise.resolve(window.YDDb.put('jobCrew', id, Object.assign({}, entry, { updatedAt: new Date().toISOString() })))
      .catch(e => console.warn('[crewjobs] crew copy not yet sent for', id, (e && e.code) || e));
  }
  function flushWaiting(force) {
    clearTimeout(waitTimer); waitTimer = null;
    Object.keys(waiting).forEach(id => { const d = waiting[id]; delete waiting[id]; mirror(id, d, force); });
  }
  document.addEventListener('yd-supplies', () => {
    if (!catalogueReady()) return;
    if (Object.keys(waiting).length) flushWaiting(false);
    Object.keys(forced).forEach(id => { const d = forced[id]; delete forced[id]; mirror(id, d); });
  });

  // Once per session on the device that runs the jobs: every booked or
  // in-progress job has its crew copy, and nothing else does. It waits (up
  // to half a minute) for Supplies, so copies already right on the server
  // are seen to be right rather than rewritten without their units.
  async function reconcile(tries) {
    if (reconciled || !window.YDDb || typeof ydCan !== 'function' || !ydCan('jobs', 'change')) return;
    if (typeof getJobIndexAll !== 'function' || typeof readJobBlob !== 'function') return;
    // The services list too (each job's tools come from it).
    if ((!catalogueReady() || !servicesReady()) && (tries || 0) < 10) { setTimeout(() => reconcile((tries || 0) + 1), 3000); return; }
    reconciled = true;
    let have = {};
    try { have = await window.YDDb.list('jobCrew'); } catch (e) { reconciled = false; return; }
    serverHad = have;
    const ready = catalogueReady();
    const ids = new Set();
    // Those in Recently deleted too, so a copy left behind is taken down.
    getJobIndexAll().forEach(j => {
      let d = null;
      try { d = JSON.parse(readJobBlob(j.id) || 'null'); } catch (e) { d = null; }
      if (!d) return;
      ids.add(j.id);
      if (shows(d)) {
        // Supplies never came: a copy already on the server keeps its units
        // rather than being rewritten without them.
        if (!ready && have[j.id] && needsCatalogue(d)) return;
        const entry = crewEntry(d);
        // Already right on the server: only remember it, write nothing.
        if (have[j.id] && sameEntry(have[j.id], entry)) { sent[j.id] = JSON.stringify(entry); return; }
        mirror(j.id, d);
      } else if (have[j.id]) {
        delete sent[j.id];
        mirror(j.id, d);
      }
    });
    // A copy whose job is gone -- from the server, not just from this device
    // (a fresh phone, or one just signed back in, is still filling its list;
    // sync.js guards the crew's job board the same way).
    const S = window.YDSync;
    if (!S || !S.jobsHeard || !S.jobsHeard()) return;
    Object.keys(have).forEach(id => {
      if (!ids.has(id) && !S.inCloud(id)) Promise.resolve(window.YDDb.remove('jobCrew', id)).catch(() => {});
    });
  }
  // Field order is not the same both sides (the server hands a map back in
  // its own order), so each is written out with its keys sorted.
  const stable = v => JSON.stringify(v === undefined ? null : v, (k, x) => x && typeof x === 'object' && !Array.isArray(x)
    ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x);
  // A copy from before the tools (16 Oct 2026) or the rentals (21 Oct) and a
  // job with none are the same: no rewrite of every booked job just to say
  // "no tools" or "no rentals".
  const EMPTY_LISTS = ['tools', 'rentals'];
  function sameEntry(a, b) {
    return Object.keys(b).every(k => {
      const was = a[k] === undefined && EMPTY_LISTS.indexOf(k) !== -1 ? [] : a[k];
      return stable(was) === stable(b[k]);
    });
  }

  // A service's tools changed (or a machine was renamed, sold, or the list
  // of machines came in): every booked job's crew copy follows, without
  // waiting for each job to be saved. Only the copies this device already
  // looked after this session (sent), and only where the copy now differs
  // (mirror compares) -- or, not yet written this session, differs from
  // the server's.
  let serverHad = null, refreshTimer = null;
  function refreshAll() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (!reconciled || !servicesReady() || typeof ydCan !== 'function' || !ydCan('jobs', 'change')) return;
      Object.keys(sent).forEach(id => {
        if (typeof sent[id] !== 'string') return;
        let d = null;
        try { d = JSON.parse(readJobBlob(id) || 'null'); } catch (e) { d = null; }
        if (!d || !shows(d)) return;
        const entry = crewEntry(d);
        const sig = JSON.stringify(entry);
        if (sent[id] === sig) return;
        if (serverHad && serverHad[id] && sameEntry(serverHad[id], entry)) { sent[id] = sig; return; }
        mirror(id, d);
      });
    }, 1500);
  }
  ['yd-services', 'yd-tools', 'yd-equipment-changed'].forEach(ev => document.addEventListener(ev, refreshAll));

  // A job changed on another device or by the server (sync.js applyRemote):
  // QuickBooks' words kept in step, an estimate filled from QuickBooks. The
  // crew copy was only ever written by the device that saved the job, so
  // what the server wrote never reached the crew's page. A moment later --
  // after the device that made the change has written its copy -- the
  // server's copy is looked at, and written only when it differs, so the
  // laptop and the iPad do not both rewrite every save the other made.
  // With no signal it is left to that device, or this one's next launch.
  const remoteWait = {};
  function remote(id) {
    if (!reconciled || !id || !window.YDDb || typeof ydCan !== 'function' || !ydCan('jobs', 'change')) return;
    clearTimeout(remoteWait[id]);
    remoteWait[id] = setTimeout(async () => {
      delete remoteWait[id];
      let d = null;
      try { d = JSON.parse(readJobBlob(id) || 'null'); } catch (e) { d = null; }
      if (!d) return;               // gone: the delete takes its copy down
      if (shows(d) && needsCatalogue(d) && !catalogueReady()) return;
      const want = shows(d) ? crewEntry(d) : null;
      const sig = want ? JSON.stringify(want) : null;
      if (sent[id] === sig) return;
      let have = null;
      try { have = await window.YDDb.getFresh('jobCrew', id); } catch (e) { return; }
      if (want ? have && sameEntry(have, want) : !have) { sent[id] = sig; return; }
      mirror(id, d);
    }, 5000);
  }

  // ------------------------------------------------------------ the page

  function mapUrl(j) {
    const where = [j.address, j.city, j.state, j.zip].filter(Boolean).join(', ');
    return where ? 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(where) : '';
  }
  const fmtNum = q => Number(q).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const fmtQty = (q, u) => (q == null ? '' : fmtNum(q) + (u ? ' ' + u : ''));

  // A measurement written in a note -- 16x20, 12' x 14', 40 ft, 3", 360 sq
  // ft, 2.5 cu yd, 8 tons, 120 LF, 3 crew-days -- in bold, so the numbers
  // that matter on site are found at a glance. (No look-behind in it: an
  // older iPhone cannot read one, and the whole page would fail.)
  const UNITS = 'sq\\.?\\s?f(?:ee|oo)?t|square\\s+f(?:ee|oo)t|sf|sq\\.?\\s?yds?|square\\s+yards?|' +
    'lin(?:ear|\\.)?\\s?f(?:ee|oo)?t|lf|cu(?:bic|\\.)?\\s?y(?:ar)?ds?|cy|yards?|yds?|tons?|lbs?|pounds?|' +
    'gal(?:lons?)?|feet|foot|ft|inch(?:es)?|in|pallets?|bags?|rolls?|plants?|trees?|shrubs?|perennials?|' +
    'steps?|crew[- ]days?|days?|hours?|hrs?';
  const MEASURE = new RegExp(
    '\\b\\d+(?:\\.\\d+)?\\s?(?:\'|ft)?\\s?[x×]\\s?\\d+(?:\\.\\d+)?(?:\\s?(?:\'|"|ft\\b|in\\b))?' +   // 16x20, 12' x 14'
    '|\\b\\d[\\d,]*(?:\\.\\d+)?\\s?(?:' + UNITS + ')\\b' +                                         // 40 ft, 2.5 cu yd
    '|\\b\\d+(?:\\.\\d+)?\\s?["\'″′]', 'gi');                                                       // 3", 12'
  function marked(text) {
    const s = String(text || '');
    let out = '', last = 0, m;
    MEASURE.lastIndex = 0;
    while ((m = MEASURE.exec(s))) {
      if (!m[0]) { MEASURE.lastIndex++; continue; }
      out += esc(s.slice(last, m.index)) + '<b class="cj-m">' + esc(m[0]) + '</b>';
      last = m.index + m[0].length;
    }
    return out + esc(s.slice(last));
  }

  function matTable(list) {
    return '<table class="cj-table"><tbody>' + list.map(m =>
      '<tr><td>' + (m.plant ? '🌱 ' : '') + esc(m.name) +
        (m.tree ? ' <span class="muted">(' + (m.tree === 'single' ? 'single-trunk tree' : 'multi-trunk or evergreen tree') + ')</span>' : '') +
        (m.how ? ' <span class="muted">(' + esc(m.how) + ')</span>' : '') +
      '</td><td class="cj-q">' + esc(fmtQty(m.qty, m.unit)) + '</td></tr>').join('') + '</tbody></table>';
  }
  // The work, line by line: the heading (with how much, for work sold by
  // the unit), the scope, Jonah's notes for the crew, and the materials for
  // that line. Whatever is for the whole job -- or a copy made before lines
  // had ids -- follows under its own heading.
  function workHtml(j, sec) {
    const work = j.work || [], mats = j.materials || [];
    const ids = {};
    work.forEach(w => { if (w.id) ids[w.id] = true; });
    const lines = work.map(w => {
      const mine = w.id ? mats.filter(m => m.work === w.id) : [];
      return '<div class="cj-work">' +
        '<div class="cj-work-h"><b>' + esc(w.title || 'Work') + '</b>' +
          (w.qty > 0 ? ' <span class="cj-big">' + esc(fmtQty(w.qty, w.unit)) + '</span>' : '') +
          (w.days ? ' <span class="muted">· ' + esc(fmtNum(w.days)) + ' crew-day' + (w.days === 1 ? '' : 's') + '</span>' : '') +
        '</div>' +
        (w.scope ? '<div class="cj-text">' + marked(w.scope) + '</div>' : '') +
        (w.crewNote ? '<div class="cj-crewnote"><div class="cj-crewnote-h">👷 For the crew</div><div class="cj-text">' +
          marked(w.crewNote) + '</div></div>' : '') +
        (mine.length ? '<div class="cj-sub">Materials for this</div>' + matTable(mine) : '') +
      '</div>';
    }).join('');
    const rest = mats.filter(m => !m.work || !ids[m.work]);
    const haul = (j.spoil > 0 ? '<div class="cj-haul">🚛 About <b class="cj-m">' + esc(fmtNum(j.spoil)) + ' cu yd</b> of soil and debris to haul away</div>' : '') +
      (j.brush > 0 ? '<div class="cj-haul">🌿 About <b class="cj-m">' + esc(fmtNum(j.brush)) + ' cu yd</b> of brush — its own dumpster, no soil or rock in it</div>' : '');
    return sec('🛠 The work', lines + (lines ? haul : '')) +
      sec(lines ? '🧱 Materials for the whole job' : '🧱 Materials for the job', rest.length ? matTable(rest) : '') +
      (lines ? '' : sec('🚛 Haul away', haul));
  }

  // ------------------------------------------------ rentals to pick up
  //
  // Each rental with how long it is for, the shop it comes from (Directions
  // and a call button, a gloved thumb's size, as for the job), its hours,
  // and -- when the job is on the schedule -- the day to have it by: the
  // job's first day ahead. A shop with no address in Supplies says so, so
  // nobody drives off guessing which branch.
  const dirTo = a => 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(a);
  function rentalsHtml(j, days, preview) {
    const list = Array.isArray(j.rentals) ? j.rentals : [];
    if (!list.length) return '';
    const first = (days || []).find(x => x.jobDay) || null;
    const when = first ? new Date(first.day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
    return '<div class="cj-sec cj-rentals"><div class="cj-h">🚜 Rentals to pick up</div>' + list.map(r => {
      const s = r.shop || {}, tel = String(s.phone || '').replace(/[^0-9+]/g, '');
      const long = r.days > 0 ? fmtQty(r.days, /^(day|days|daily|per day)$/i.test(r.unit || '') || !r.unit ? (r.days === 1 ? 'day' : 'days') : r.unit) : '';
      return '<div class="cj-rental">' +
        '<div class="cj-rental-h"><b>' + esc(r.name) + '</b>' + (long ? ' <span class="cj-big">' + esc(long) + '</span>' : '') +
          (r.reserved ? ' <span class="cj-rental-ok">✓ reserved</span>' : '') + '</div>' +
        '<div class="cj-rental-where">Pick up at <b>' + esc(s.name || 'the rental shop') + '</b>' +
          (s.address ? ' — ' + esc(s.address) : ' <span class="warn-text">· no address for it in Supplies yet' +
            (preview ? ' (Supplies → the supplier → Edit supplier)' : ' — ask Jonah which one') + '</span>') +
          (s.hours ? '<div class="muted">Open ' + esc(s.hours) + '</div>' : '') +
          (when ? '<div>Have it for <b>' + esc(when) + '</b> — the first day on the schedule</div>' : '') + '</div>' +
        (s.address || tel ? '<div class="cj-go">' +
          (s.address ? '<a class="btn cj-go-btn" href="' + esc(dirTo(s.address)) + '" target="_blank" rel="noopener">🧭 Directions</a>' : '') +
          (tel ? '<a class="btn cj-go-btn" href="tel:' + esc(tel) + '">📞 Call<span class="cj-go-sub">' + esc(s.phone) + '</span></a>' : '') +
        '</div>' : '') +
      '</div>';
    }).join('') + '</div>';
  }

  // ------------------------------------------------ the tools to bring
  //
  // Jonah (16 Oct 2026): the tool list "viewable by the crew on the front
  // page of the job so they know what they need ... right by the material
  // list". Above the work (whose materials sit under each line), so it is
  // seen before the long scopes: machines by type, then hand tools, each a
  // button to tap as it goes on the truck. The ticks are this phone's own,
  // for today only (packing is every morning) -- never sent anywhere.
  const PACKED = 'ydjobhub_toolsPacked';
  const today = () => { const t = new Date(); return t.getFullYear() + '-' + (t.getMonth() + 1) + '-' + t.getDate(); };
  function packedOf(id) {
    try {
      const p = JSON.parse(localStorage.getItem(PACKED) || 'null');
      return p && p.day === today() && p.jobs && p.jobs[id] ? p.jobs[id] : {};
    } catch (e) { return {}; }
  }
  function setPacked(id, key, on) {
    try {
      let p = JSON.parse(localStorage.getItem(PACKED) || 'null');
      if (!p || p.day !== today()) p = { day: today(), jobs: {} };
      const mine = p.jobs[id] || (p.jobs[id] = {});
      if (on) mine[key] = 1; else delete mine[key];
      localStorage.setItem(PACKED, JSON.stringify(p));
    } catch (e) { /* private mode: the tick still shows until the page is closed */ }
  }
  const toolTick = t => String((t.kind || '') + '|' + t.name).toLowerCase();
  const toolWords = t => (t.qty ? t.qty + ' × ' : '') + t.name;
  const kindsWord = n => (/\s/.test(n) || /s$/i.test(n) ? n : /[^aeiou]y$/i.test(n) ? n.slice(0, -1) + 'ies' : n + 's');
  function toolsHtml(id, j, preview) {
    const tools = Array.isArray(j.tools) ? j.tools : null;
    if (!tools || !tools.length) {
      return preview ? '<div class="cj-sec"><div class="cj-h">🧰 Tools to bring</div><div class="muted">None yet — they come from the ' +
        'job’s services (🧰 Tools for this Job, beside Materials to Order).</div></div>' : '';
    }
    const packed = preview ? {} : packedOf(id);
    const groups = [], at = {};
    tools.forEach(t => {
      const g = t.kind ? kindsWord(t.kind) : 'Hand tools';
      if (!(g in at)) { at[g] = groups.length; groups.push({ name: g, list: [] }); }
      groups[at[g]].list.push(t);
    });
    const n = tools.filter(t => packed[toolTick(t)]).length;
    return '<div class="cj-sec cj-tools" data-job="' + esc(safe(id)) + '"><div class="cj-h">🧰 Tools to bring' +
        (preview ? '' : ' <span class="cj-tools-n">' + (n ? n + ' of ' + tools.length + ' packed' : tools.length) + '</span>') + '</div>' +
      groups.map(g => '<div class="cj-sub">' + esc(g.name) + '</div><div class="cj-tool-chips">' + g.list.map(t => {
        const on = !!packed[toolTick(t)];
        return '<button type="button" class="cj-tool' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-k="' + esc(toolTick(t)) + '"' +
          (preview ? ' disabled' : ' onclick="cjToolPacked(this)"') + '>' + (on ? '✓ ' : '') + esc(toolWords(t)) + '</button>';
      }).join('') + '</div>').join('') +
      (preview ? '' : '<div class="hint cj-tools-hint">Tap each one as it goes on the truck — the ticks stay on this phone, for today.</div>') +
    '</div>';
  }
  // One tap: that button and the count, nothing else redrawn.
  window.cjToolPacked = function (b) {
    const box = b && b.closest('.cj-tools');
    if (!box) return;
    const id = box.dataset.job, on = !b.classList.contains('on');
    setPacked(id, b.dataset.k, on);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.textContent = (on ? '✓ ' : '') + b.textContent.replace(/^✓ /, '');
    const all = box.querySelectorAll('.cj-tool'), done = box.querySelectorAll('.cj-tool.on').length;
    const cnt = box.querySelector('.cj-tools-n');
    if (cnt) cnt.textContent = done ? done + ' of ' + all.length + ' packed' : String(all.length);
  };

  // ------------------------------------------- on the clock, from the page
  //
  // The crew open a job's page when they get there, so the page itself
  // clocks them in: one big button, or -- already on its clock -- saying so.
  // On another job's clock, the same tap moves them here (the clock's own
  // switch: one action, so the hours never land on the wrong job).
  function myShift() {
    const m = window.YDClock && YDClock.mine ? YDClock.mine() : null;
    return m && m.shift ? m.shift : null;
  }
  const onThisJob = (s, id) => !!s && s.kind === 'job' && s.targetId === id && !s.leaving;
  function clockHtml(id, preview) {
    const s = myShift();
    if (!preview && onThisJob(s, id)) {
      return '<div class="cj-clock cj-on" data-cj-clock>✅ <b>You’re on the clock here</b>' +
        '<small>' + esc(s.inWords || '') + (s.paused ? ' · paused' : '') + ' · ' +
        '<button class="link-btn" onclick="cjToClock()">Go to the clock</button></small></div>';
    }
    return '<div class="cj-clock" data-cj-clock>' +
      '<button class="btn btn-filled cj-clock-btn" ' + (preview ? 'disabled title="The crew’s button"' : 'onclick="cjClockIn(\'' + safe(id) + '\')"') + '>' +
        '⏱ ' + (!preview && s && !s.leaving ? 'Switch to this job' : 'Clock in to this job') + '</button>' +
      (!preview && s && !s.leaving ? '<small>On the clock at ' + esc(s.where || 'another job') + ' — this moves you here</small>' : '') +
    '</div>';
  }
  // The bar along the foot: a photo, a note, the clock -- always in reach
  // however far down the page they have read.
  function barHtml(id, j, preview) {
    const s = myShift();
    const on = !preview && onThisJob(s, id);
    const off = preview ? ' disabled' : '';
    return '<button class="cj-bar-btn" onclick="cjPhoto()"' + off + '>📷<span>Photo</span></button>' +
      '<button class="cj-bar-btn" onclick="cjNote(\'' + safe(id) + '\')"' + off + '>📝<span>Note</span></button>' +
      (on ? '<button class="cj-bar-btn cj-bar-on" onclick="cjToClock()">✅<span>On the clock</span></button>'
        : '<button class="cj-bar-btn cj-bar-in" onclick="cjClockIn(\'' + safe(id) + '\')"' + off + '>⏱<span>' +
            (!preview && s && !s.leaving ? 'Switch here' : 'Clock in') + '</span></button>');
  }

  function pageHtml(id, j, preview) {
    // "Town, WI 12345", as an address is written (it read "WI, 12345").
    const where = [j.address, j.city, [j.state, j.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const tel = String(j.phone || '').replace(/[^0-9+]/g, '');
    const days = window.YDCalendar && YDCalendar.forJob ? YDCalendar.forJob(id) : [];
    const sec = (title, body) => body ? '<div class="cj-sec"><div class="cj-h">' + title + '</div>' + body + '</div>' : '';
    // The site-visit notes are where the gate code, the dog, where to park
    // and what to watch for live: above the work, not under it. A long one
    // shows its start and opens on a tap. (Not the job's own notes: those
    // are the office's -- see crewNotes -- and stay at the foot.)
    const before = j.siteNotes ? ['<div class="cj-text">' + marked(j.siteNotes) + '</div>'] : [];
    const long = String(j.siteNotes || '').length > 600;
    // "7:30am" as the rest of the app writes a time (the calendar's own
    // words), not "07:30".
    const timeOf = x => x.when || (x.time ? x.time : '');
    return '<div class="cj-page">' +
      (preview ? '<div class="cj-preview">This is the page the crew see for this job — no prices anywhere. ' +
        'Hide it from them with “Hide from crew” on the Job tab.</div>' : '') +
      '<div class="cj-top"><div class="cj-name">' + esc(j.name) + (j.est ? ' <span class="job-num">#' + esc(j.est) + '</span>' : '') +
        (j.what ? '<div class="cj-what">' + esc(j.what) + '</div>' : '') + '</div>' +
        '<span class="cj-status">' + (j.status === 'inprogress' ? 'In progress' : 'Booked') + '</span></div>' +
      (where ? '<div class="cj-where">📍 ' + esc(where) + '</div>' : '<div class="muted">No address on the job yet.</div>') +
      // Two big buttons a gloved thumb can find, side by side.
      (where || tel ? '<div class="cj-go">' +
        (where ? '<a class="btn cj-go-btn" href="' + esc(mapUrl(j)) + '" target="_blank" rel="noopener">🧭 Directions</a>' : '') +
        (tel ? '<a class="btn cj-go-btn" href="tel:' + esc(tel) + '">📞 Call<span class="cj-go-sub">' + esc(j.phone) + '</span></a>' : '') +
      '</div>' : '') +
      (before.length ? '<div class="cj-before' + (long ? ' cj-folded' : '') + '" id="cjBefore">' +
          '<div class="cj-before-h">⚠️ Before you start</div>' +
          '<div class="cj-before-body">' + before.join('') + '</div>' +
          (long ? '<button class="link-btn cj-before-more" onclick="cjBeforeAll()">Show all</button>' : '') +
        '</div>' : '') +
      clockHtml(id, preview) +
      // Each service a button: what it is, in words to tell the homeowner
      // (services.js What we do).
      ((j.services || []).length ? '<div class="cj-tags">' + j.services.map(s => '<button type="button" class="svc-tag svc-tag-btn" data-n="' + esc(s) +
          '" onclick="openWhatWeDo(this.dataset.n)">' + esc(s) + ' ⓘ</button>').join('') +
        '<div class="hint cj-tags-hint">Tap a service for how to describe it to the homeowner.</div></div>' : '') +
      // A day with nobody put on the entry says "Anyone" rather than a date
      // with no names, which read as if the names were missing.
      sec('👷 Who is working', days.length ? days.slice(0, 12).map(x => '<div class="cj-day"><b>' +
          esc(new Date(x.day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })) + '</b>' +
          (timeOf(x) ? ' · ' + esc(timeOf(x)) : '') +
          (x.crew.length ? ' — ' + esc(x.crew.join(', ')) : x.nobody ? ' — <span class="muted">Anyone</span>' : '') + '</div>').join('') : '') +
      rentalsHtml(j, days, preview) +
      toolsHtml(id, j, preview) +
      workHtml(j, sec) +
      sec('🛒 Ordered', (j.order || []).length ? '<table class="cj-table"><tbody>' + j.order.map(o =>
          '<tr><td>' + (o.ordered ? '✓ ' : '') + esc(o.name) + (o.supplier ? ' <span class="muted">· ' + esc(o.supplier) + '</span>' : '') +
          '</td><td class="cj-q">' + esc([o.qty, o.per].filter(Boolean).join(' ')) + '</td></tr>').join('') + '</tbody></table>' : '') +
      sec('🗒 Notes', j.notes ? '<div class="cj-text">' + marked(j.notes) + '</div>' : '') +
      // A paper receipt for this job: it goes on the job by itself
      // (receipts.js rcPhotoForJob) -- no asking which job.
      (preview ? '' : '<div class="cj-receipt"><button class="btn cj-go-btn" onclick="rcPhotoForJob(\'' + safe(id) + '\')">' +
        '🧾 Add a receipt for this job</button></div>') +
      '<div class="cj-photos" id="cjPhotos" data-job="' + safe(id) + '"></div>' +
      // Sign-offs and anything else the customer signs (signatures.js).
      (preview ? '' : '<div class="cj-sigs" id="cjSigs" data-job="' + safe(id) + '"></div>') +
    '</div>';
  }

  function modalBody(title) {
    let m = el('crewJobModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal-overlay';
      m.id = 'crewJobModal';
      m.onclick = ev => { if (ev.target === m) m.classList.remove('active'); };
      m.innerHTML = '<div class="modal" style="max-width:680px"><div class="modal-head"><h2></h2>' +
        '<button class="modal-close">&times;</button></div><div class="modal-body"></div></div>' +
        // The bar is the window's, not the page's: fixed to the foot of the
        // screen while the page scrolls under it (inside the page it would
        // scroll away with it).
        '<div class="cj-bar" id="cjBar"></div>';
      m.querySelector('.modal-close').onclick = () => m.classList.remove('active');
      document.body.appendChild(m);
    }
    m.querySelector('h2').textContent = title;
    m.classList.add('active');
    return m.querySelector('.modal-body');
  }
  let pageId = null, pagePreview = false;    // the job whose page is open
  function afterPage(id, j, preview) {
    pageId = id; pagePreview = !!preview;
    pageSig = preview ? '' : sigOf(j);
    const bar = el('cjBar');
    if (bar) bar.innerHTML = barHtml(id, j, preview);
    if (window.YDJobPhotos) YDJobPhotos.mount(el('cjPhotos'), id);
    // What the signed PDF says about the job: the crew have no job form.
    if (window.YDSignatures && el('cjSigs') && j) {
      YDSignatures.mount(el('cjSigs'), id, {
        name: j.name || 'Customer', customer: j.name || '',
        address: [j.address, j.city, [j.state, j.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
        number: j.est || '', work: (j.work || []).map(w => w.title).filter(Boolean).slice(0, 20),
      });
    }
  }
  const pageOpen = () => { const m = el('crewJobModal'); return !!(m && m.classList.contains('active')); };
  // The clock changed (clocked in here, or out): the button and the bar
  // say so -- only those, so the page and its photos are left where they are.
  function freshClock() {
    if (!pageOpen() || !pageId || pagePreview) return;
    const now = clockHtml(pageId, false);
    document.querySelectorAll('#crewJobModal [data-cj-clock]').forEach(n => { if (n.outerHTML !== now) n.outerHTML = now; });
    const bar = el('cjBar');
    const b = barHtml(pageId, jobs[pageId] || {}, false);
    if (bar && bar.innerHTML !== b) bar.innerHTML = b;
  }
  document.addEventListener('yd-clock-changed', freshClock);

  // The job's crew copy changed while its page is open (Jonah changed the
  // work, QuickBooks' words came in): the page is drawn again, where it was
  // scrolled to. Not while a box on it is being typed in -- then once that
  // is left. A copy that only got a new time stamp is left alone.
  let pageSig = '', pageWaiting = false;
  const sigOf = j => { const o = Object.assign({}, j || {}); delete o.updatedAt; return JSON.stringify(o); };
  function freshPage() {
    if (!pageOpen() || !pageId || pagePreview) return;
    const m = el('crewJobModal');
    const a = document.activeElement;
    if (a && m.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) {
      if (!pageWaiting) {
        pageWaiting = true;
        a.addEventListener('blur', () => { pageWaiting = false; setTimeout(freshPage, 0); }, { once: true });
      }
      return;
    }
    const j = jobs[pageId];
    const body = m.querySelector('.modal-body');
    if (!body) return;
    if (!j) {
      body.innerHTML = '<p class="empty-msg">This job is no longer on your list.</p>';
      const bar = el('cjBar'); if (bar) bar.innerHTML = '';
      pageSig = '';
      return;
    }
    if (sigOf(j) === pageSig) return;
    const scrollers = [m, m.querySelector('.modal'), body];
    const tops = scrollers.map(n => (n ? n.scrollTop : 0));
    const opened = !!(el('cjBefore') && !el('cjBefore').classList.contains('cj-folded'));
    body.innerHTML = pageHtml(pageId, j, false);
    afterPage(pageId, j, false);
    if (opened && el('cjBefore')) el('cjBefore').classList.remove('cj-folded');
    scrollers.forEach((n, i) => { if (n) n.scrollTop = tops[i]; });
  }

  window.cjClockIn = function (id) {
    const j = jobs[id];
    if (!j || typeof window.clockInTo !== 'function') return;
    if (onThisJob(myShift(), id)) { freshClock(); return; }
    window.clockInTo('job', id, typeof jobLabel === 'function' ? jobLabel(j.name || 'Job', j.what || '') : (j.name || 'Job'));
    freshClock();
  };
  window.cjToClock = function () {
    const m = el('crewJobModal'); if (m) m.classList.remove('active');
    if (typeof switchTab === 'function') switchTab('clock');
  };
  window.cjNote = function (id) {
    const j = jobs[id];
    if (window.openNoteForJonah) openNoteForJonah(id, (j && j.name) || '');
  };
  // The photos are at the foot of the page, under Before / During / After:
  // brought into view and lit up, so the right button is the next tap.
  window.cjPhoto = function () {
    const p = el('cjPhotos');
    if (!p) return;
    if (p.scrollIntoView) p.scrollIntoView({ block: 'center', behavior: 'smooth' });
    p.classList.add('cj-flash');
    setTimeout(() => p.classList.remove('cj-flash'), 1600);
  };
  window.cjBeforeAll = function () {
    const b = el('cjBefore');
    if (b) b.classList.remove('cj-folded');
  };

  // A crew member opening one of their jobs.
  window.openCrewJob = function (id) {
    const j = jobs[id];
    if (!j) return;
    modalBody('Job').innerHTML = pageHtml(id, j, false);
    afterPage(id, j, false);
  };
  // The owner's "What the crew see", from the job open on the Job tab.
  window.previewCrewJob = function () {
    if (typeof getJobData !== 'function') return;
    const d = getJobData();
    const id = typeof currentJobId !== 'undefined' ? currentJobId : '';
    const entry = crewEntry(d);
    modalBody('What the crew see').innerHTML = pageHtml(id, entry, true) +
      (shows(d) ? '' : '<p class="ntf-warn">The crew do not see this job now — ' +
        (d.crewHidden ? 'it is hidden from them.' : 'only booked and in-progress jobs are shown to them.') + '</p>');
    afterPage(id, entry, true);
  };

  // ------------------------------------------------------- the Jobs tab

  // In progress first, then booked; A to Z within each.
  function listed() {
    return Object.keys(jobs).map(id => Object.assign({ id: id }, jobs[id]))
      .sort((a, b) => (a.status === 'inprogress' ? 0 : 1) - (b.status === 'inprogress' ? 0 : 1) ||
        String(a.name).localeCompare(String(b.name)));
  }
  function render() {
    // Home shows the same list (home.js).
    document.dispatchEvent(new CustomEvent('yd-crew-jobs'));
    const wrap = el('crewJobsWrap');
    if (!wrap) return;
    const list = listed();
    wrap.innerHTML = list.length ? list.map(j => '<button class="cj-row" onclick="openCrewJob(\'' + safe(j.id) + '\')">' +
        '<span class="cj-row-name"><b>' + esc(j.name) + '</b>' + (j.est ? ' <span class="job-num">#' + esc(j.est) + '</span>' : '') +
          (j.what ? '<span class="cj-row-what">' + esc(j.what) + '</span>' : '') +
          '<small>' + esc([j.address, j.city].filter(Boolean).join(', ')) + '</small></span>' +
        '<span class="cj-status">' + (j.status === 'inprogress' ? 'In progress' : 'Booked') + '</span></button>').join('')
      : '<p class="empty-msg">No booked jobs right now.</p>';
  }

  function stop() { if (unsub) { try { unsub(); } catch (e) {} } unsub = null; jobs = {}; }
  function start(a) {
    stop();
    if (!window.YDDb || !a.user || a.mode !== 'cloud') return;
    unsub = window.YDDb.watch('jobCrew', changes => {
      let pageChanged = false;
      changes.forEach(c => {
        if (c.id === pageId) pageChanged = true;
        if (c.type === 'removed') delete jobs[c.id]; else jobs[c.id] = c.data || {};
      });
      render();
      if (pageChanged) freshPage();
    }, () => render());
  }

  let key = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const crew = on && typeof ydCan === 'function' && !ydCan('jobs', 'see');
    const tab = el('tabCrewJobs');
    if (tab) tab.hidden = !crew;
    const pv = el('crewPreviewBtn');
    if (pv) pv.hidden = !(on && typeof ydCan === 'function' && ydCan('jobs', 'see'));
    const k = crew ? a.user.uid : null;
    if (k !== key) { key = k; if (crew) start(a); else stop(); }
    if (on && typeof ydCan === 'function' && ydCan('jobs', 'change')) setTimeout(reconcile, 4000);
    if (!on) {
      reconciled = false;
      Object.keys(sent).forEach(k2 => delete sent[k2]);
      Object.keys(waiting).forEach(k2 => delete waiting[k2]);
      clearTimeout(waitTimer); waitTimer = null;
    }
  });

  // workFor: the estimate shows which line it would put each material under
  // (estimate.js, "For the crew, this is for").
  window.YDCrewJobs = { mirror: mirror, remote: remote, render: render, entry: crewEntry, workFor: workFor,
    // The crew's booked and in-progress jobs, as their Jobs tab lists them
    // (a crew phone; empty for anyone who has the Job tab instead).
    list: () => listed() };
})();
