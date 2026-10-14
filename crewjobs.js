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
  let waitTimer = null;
  let reconciled = false;
  const el = id => document.getElementById(id);
  const safe = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const statusOf = d => (typeof normStatus === 'function' ? normStatus(d.jobStatus, d) : (d.jobStatus || 'quoting'));
  // A price typed into free text ("gave them $500 off") never reaches a
  // crew phone.
  const noMoney = s => String(s == null ? '' : s).replace(/\$\s?\d[\d,]*(\.\d+)?/g, '$—');
  const numOr = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

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

  // What a crew member may know about a job -- nothing else is copied.
  function crewEntry(d) {
    const est = d.estimate || {};
    const lines = (est.work || []).filter(w => w && (w.title || w.scope || w.crewNote)).slice(0, 40);
    const items = catalogue().items;
    return {
      name: String(d.customerName || '').trim() || 'Untitled job',
      address: d.address || '', city: d.city || '', state: d.state || '', zip: d.zip || '',
      phone: d.phone || '',
      status: statusOf(d),
      est: String(d.estimateNumber || '').trim(),
      services: (d.serviceTypes || []).slice(0, 20),
      siteNotes: noMoney(est.notes).slice(0, 8000),
      notes: noMoney(d.notes).slice(0, 4000),
      // Each piece of work: its scope, Jonah's notes for the crew (never on
      // the estimate), and -- a service sold by the unit -- how much of it.
      work: lines.map((w, i) => ({
        id: safe(w.id) || 'w' + i,
        title: noMoney(w.title).slice(0, 200), scope: noMoney(w.scope).slice(0, 3000),
        crewNote: noMoney(w.crewNote).slice(0, 3000),
        days: numOr(w.crewDays),
        qty: w.kind === 'flat' ? numOr(w.qty) : null,
        unit: w.kind === 'flat' ? noMoney(w.unit).slice(0, 30) : '',
      })),
      // The takeoff: how much of each, in the unit it is measured in, and
      // which piece of work it is for (an id from `work`; '' the whole job).
      materials: (est.materials || []).filter(m => m && m.name).slice(0, 120)
        .map(m => ({ name: noMoney(m.name).slice(0, 200), qty: numOr(m.qty), unit: noMoney(unitOf(m)).slice(0, 30),
                     plant: !!m.plant, tree: m.plant && (m.tree === 'single' || m.tree === 'multi') ? m.tree : '',
                     work: safe(workFor(m, lines, items)),
                     how: m.delivery === 'pickup' ? 'pick up' : m.delivery === 'rides' ? 'rides on a delivery' : '' })),
      // Soil and debris to haul away (cu yd), as the estimate has it.
      spoil: numOr(est.spoilCuYd),
      order: (d.orderItems || []).filter(o => o && o.name).slice(0, 120)
        .map(o => ({ name: noMoney(o.name).slice(0, 200), qty: noMoney(o.quantity || o.qty || '').slice(0, 30),
                     per: noMoney(o.per || '').slice(0, 30), supplier: vendorName(o.vendorId), ordered: !!o.ordered })),
    };
  }
  const shows = d => SHOWN.indexOf(statusOf(d)) !== -1 && !d.crewHidden;

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
  document.addEventListener('yd-supplies', () => { if (Object.keys(waiting).length && catalogueReady()) flushWaiting(false); });

  // Once per session on the device that runs the jobs: every booked or
  // in-progress job has its crew copy, and nothing else does. It waits (up
  // to half a minute) for Supplies, so copies already right on the server
  // are seen to be right rather than rewritten without their units.
  async function reconcile(tries) {
    if (reconciled || !window.YDDb || typeof ydCan !== 'function' || !ydCan('jobs', 'change')) return;
    if (typeof getJobIndex !== 'function' || typeof readJobBlob !== 'function') return;
    if (!catalogueReady() && (tries || 0) < 10) { setTimeout(() => reconcile((tries || 0) + 1), 3000); return; }
    reconciled = true;
    let have = {};
    try { have = await window.YDDb.list('jobCrew'); } catch (e) { reconciled = false; return; }
    const ids = new Set();
    getJobIndex().forEach(j => {
      let d = null;
      try { d = JSON.parse(readJobBlob(j.id) || 'null'); } catch (e) { d = null; }
      if (!d) return;
      ids.add(j.id);
      if (shows(d)) {
        const entry = crewEntry(d);
        // Already right on the server: only remember it, write nothing.
        if (have[j.id] && sameEntry(have[j.id], entry)) { sent[j.id] = JSON.stringify(entry); return; }
        mirror(j.id, d);
      } else if (have[j.id]) {
        delete sent[j.id];
        mirror(j.id, d);
      }
    });
    // A copy whose job is gone.
    Object.keys(have).forEach(id => { if (!ids.has(id)) Promise.resolve(window.YDDb.remove('jobCrew', id)).catch(() => {}); });
  }
  // Field order is not the same both sides (the server hands a map back in
  // its own order), so each is written out with its keys sorted.
  const stable = v => JSON.stringify(v === undefined ? null : v, (k, x) => x && typeof x === 'object' && !Array.isArray(x)
    ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x);
  function sameEntry(a, b) {
    return Object.keys(b).every(k => stable(a[k]) === stable(b[k]));
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
    const haul = j.spoil > 0 ? '<div class="cj-haul">🚛 About <b class="cj-m">' + esc(fmtNum(j.spoil)) + ' cu yd</b> of soil and debris to haul away</div>' : '';
    return sec('🛠 The work', lines + (lines ? haul : '')) +
      sec(lines ? '🧱 Materials for the whole job' : '🧱 Materials for the job', rest.length ? matTable(rest) : '') +
      (lines ? '' : sec('🚛 Haul away', haul));
  }

  function pageHtml(id, j, preview) {
    const where = [j.address, [j.city, j.state].filter(Boolean).join(', '), j.zip].filter(Boolean).join(', ');
    const tel = String(j.phone || '').replace(/[^0-9+]/g, '');
    const days = window.YDCalendar && YDCalendar.forJob ? YDCalendar.forJob(id) : [];
    const sec = (title, body) => body ? '<div class="cj-sec"><div class="cj-h">' + title + '</div>' + body + '</div>' : '';
    return '<div class="cj-page">' +
      (preview ? '<div class="cj-preview">This is the page the crew see for this job — no prices anywhere. ' +
        'Hide it from them with “Hide from crew” on the Job tab.</div>' : '') +
      '<div class="cj-top"><div class="cj-name">' + esc(j.name) + (j.est ? ' <span class="job-num">#' + esc(j.est) + '</span>' : '') + '</div>' +
        '<span class="cj-status">' + (j.status === 'inprogress' ? 'In progress' : 'Booked') + '</span></div>' +
      (where ? '<a class="snow-addr" href="' + esc(mapUrl(j)) + '" target="_blank" rel="noopener">📍 ' + esc(where) +
        '<span class="snow-go">Directions</span></a>' : '<div class="muted">No address on the job yet.</div>') +
      (tel ? '<a class="cj-call" href="tel:' + esc(tel) + '">📞 ' + esc(j.phone) + '</a>' : '') +
      ((j.services || []).length ? '<div class="cj-tags">' + j.services.map(s => '<span class="svc-tag">' + esc(s) + '</span>').join('') + '</div>' : '') +
      sec('👷 Who is working', days.length ? days.slice(0, 12).map(x => '<div class="cj-day"><b>' +
          esc(new Date(x.day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })) + '</b>' +
          (x.time ? ' · ' + esc(x.time) : '') + (x.crew.length ? ' — ' + esc(x.crew.join(', ')) : '') + '</div>').join('') : '') +
      workHtml(j, sec) +
      sec('📝 Notes from the site visit', j.siteNotes ? '<div class="cj-text">' + marked(j.siteNotes) + '</div>' : '') +
      sec('🛒 Ordered', (j.order || []).length ? '<table class="cj-table"><tbody>' + j.order.map(o =>
          '<tr><td>' + (o.ordered ? '✓ ' : '') + esc(o.name) + (o.supplier ? ' <span class="muted">· ' + esc(o.supplier) + '</span>' : '') +
          '</td><td class="cj-q">' + esc([o.qty, o.per].filter(Boolean).join(' ')) + '</td></tr>').join('') + '</tbody></table>' : '') +
      sec('🗒 Notes', j.notes ? '<div class="cj-text">' + marked(j.notes) + '</div>' : '') +
      '<div class="cj-photos" id="cjPhotos" data-job="' + safe(id) + '"></div>' +
      '<div class="field-actions">' +
        (!preview && window.openNoteForJonah ? '<button class="btn btn-filled" onclick="openNoteForJonah(\'' + safe(id) + '\', ' +
          esc(JSON.stringify(j.name)).replace(/'/g, '&#39;') + ')">📝 Leave a note for Jonah about this job</button>' : '') +
      '</div>' +
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
        '<button class="modal-close">&times;</button></div><div class="modal-body"></div></div>';
      m.querySelector('.modal-close').onclick = () => m.classList.remove('active');
      document.body.appendChild(m);
    }
    m.querySelector('h2').textContent = title;
    m.classList.add('active');
    return m.querySelector('.modal-body');
  }
  function afterPage(id) {
    if (window.YDJobPhotos) YDJobPhotos.mount(el('cjPhotos'), id);
  }

  // A crew member opening one of their jobs.
  window.openCrewJob = function (id) {
    const j = jobs[id];
    if (!j) return;
    modalBody('Job').innerHTML = pageHtml(id, j, false);
    afterPage(id);
  };
  // The owner's "What the crew see", from the job open on the Job tab.
  window.previewCrewJob = function () {
    if (typeof getJobData !== 'function') return;
    const d = getJobData();
    const id = typeof currentJobId !== 'undefined' ? currentJobId : '';
    modalBody('What the crew see').innerHTML = pageHtml(id, crewEntry(d), true) +
      (shows(d) ? '' : '<p class="ntf-warn">The crew do not see this job now — ' +
        (d.crewHidden ? 'it is hidden from them.' : 'only booked and in-progress jobs are shown to them.') + '</p>');
    afterPage(id);
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
          '<small>' + esc([j.address, j.city].filter(Boolean).join(', ')) + '</small></span>' +
        '<span class="cj-status">' + (j.status === 'inprogress' ? 'In progress' : 'Booked') + '</span></button>').join('')
      : '<p class="empty-msg">No booked jobs right now.</p>';
  }

  function stop() { if (unsub) { try { unsub(); } catch (e) {} } unsub = null; jobs = {}; }
  function start(a) {
    stop();
    if (!window.YDDb || !a.user || a.mode !== 'cloud') return;
    unsub = window.YDDb.watch('jobCrew', changes => {
      changes.forEach(c => { if (c.type === 'removed') delete jobs[c.id]; else jobs[c.id] = c.data || {}; });
      render();
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
  window.YDCrewJobs = { mirror: mirror, render: render, entry: crewEntry, workFor: workFor,
    // The crew's booked and in-progress jobs, as their Jobs tab lists them
    // (a crew phone; empty for anyone who has the Job tab instead).
    list: () => listed() };
})();
