// Order ahead. Jonah's routine 6 of 14 (wish card, 26 Oct 2026, "Order-ahead desk: materials for the
// next 2 weeks of jobs, ordered in time"): for every booked job with a day on the Job schedule in the
// next two weeks and lines still to order, work back from that first day by each supplier's lead time
// -- "special order, order it by Monday for a Friday start" -- so no crew-day is lost waiting on
// material.
//
// It is a card on his My to-dos, "🧱 Order materials — <name>", due on the earliest order-by day,
// listing each supplier with its order-by day, its lines and how many are special order. Made once per
// job, on the owner's device (as digging.js makes the Diggers to-do); kept in step while it is open (a
// moved first day or a line ticked moves its day and words -- but a due day, title or words he changed
// on the card are his and stay); ticked off by itself when every line is ordered or marked not bought,
// or the job is done. A card ticked off by itself is followed by a new one if lines to order turn up
// again; one he ticked off or deleted is his answer and never comes back (the first day "from today on"
// moves every morning of a job under way, and it used to come back each day). The 7 am list tells him
// the morning it is due (functions/reminders.py: his cards due today), so nothing here sends a push.
//
// What is still to order is what Orders to place shows (app.js ordersJobs, orderVendor); the first day
// is the first day on the Job schedule (a pickup or a to-do tied to the job does not count).
// Lead time: the supplier's "Usually takes" on Supplies ("3–5 business days", "1 week", "next day")
// read as working days, the longest it says; none written = LEAD_WORKDAYS. A special-order line
// (Supplies' specialOrder, or the line's own) waits at least SPECIAL_WORKDAYS.
// Kept in settings/orderAhead (owner only): jobs: { jobId: { cardId, first, at, n, wrote {due, title,
// notes (a hash)}, autoDone } } -- n counts the cards made for the job (each its own id), wrote is what
// this last put on the card.
(function () {
  'use strict';

  const TODO = 'todo';
  const DOC = 'orderAhead';
  const LOOK_DAYS = 14;             // a first day further off than this gets no card yet
  const LEAD_WORKDAYS = 2;          // a supplier with no "Usually takes": time to set up a delivery or pickup
  const SPECIAL_WORKDAYS = 7;       // a special-order line, at the least

  const safe = v => String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '');
  const iso = () => new Date().toISOString();
  const owner = () => !!(window.YDAuth && window.YDAuth.isOwner && window.YDAuth.mode === 'cloud' && window.YDAuth.user);

  let state = null;          // settings/orderAhead, once read
  let reading = null, running = false, timer = null;

  // ------------------------------------------------------------ days

  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const today = () => ymd(new Date());
  function addDays(s, n) { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); }
  // Back n working days (Monday to Friday).
  function backWorkdays(s, n) {
    let d = s;
    while (n > 0) {
      d = addDays(d, -1);
      const w = new Date(d + 'T12:00:00').getDay();
      if (w !== 0 && w !== 6) n--;
    }
    return d;
  }
  const dayWords = s => new Date(s.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  // "3–5 business days to arrive" -> 5; "1 week" -> 5; "10 days" -> 8; "next day" -> 1; "same day" -> 0;
  // nothing it can read -> null.
  function leadDays(text) {
    const t = String(text || '').toLowerCase();
    if (!t.trim()) return null;
    // Figures first: "3-5 days, same day if in stock" is 5, not 0.
    const nums = (t.match(/\d+(\.\d+)?/g) || []).map(Number);
    if (!nums.length) {
      if (/same[ -]day|in stock|today/.test(t)) return 0;
      if (/next[ -]day|overnight|tomorrow/.test(t)) return 1;
      return null;
    }
    const n = Math.max.apply(null, nums);
    if (/week/.test(t)) return Math.ceil(n * 5);
    if (/business|working|work day/.test(t)) return Math.ceil(n);
    if (/day/.test(t)) return Math.ceil(n * 5 / 7);
    return null;
  }

  // ------------------------------------------------------------ what to order

  const statusOf = d => (typeof normStatus === 'function' ? normStatus(d.jobStatus, d) : (d.jobStatus || 'quoting'));
  // The first day on the Job schedule from today on, or ''.
  function firstDay(jobId) {
    const days = window.YDCalendar && YDCalendar.forJob ? YDCalendar.forJob(jobId, 120) : [];
    return days.filter(x => x.jobDay).map(x => x.day).sort()[0] || '';
  }
  // Each supplier's lines still to order, and its order-by day.
  function plan(j, first, cat) {
    const by = {};
    j.left.forEach(it => {
      const vid = (typeof orderVendor === 'function' ? orderVendor(it, cat) : it.vendorId) || '';
      const sid = typeof orderSupply === 'function' ? orderSupply(it, cat) : it.supplyId;
      const g = by[vid] || (by[vid] = { vid, name: vid ? ((cat.vendors[vid] || {}).name || 'Supplier') : 'No supplier picked yet', n: 0, special: 0 });
      g.n++;
      if (it.specialOrder || (sid && cat.items[sid] && cat.items[sid].specialOrder)) g.special++;
    });
    return Object.values(by).map(g => {
      const said = g.vid ? leadDays((cat.vendors[g.vid] || {}).leadTime) : null;
      let lead = said == null ? LEAD_WORKDAYS : said;
      if (g.special) lead = Math.max(lead, SPECIAL_WORKDAYS);
      return Object.assign(g, { lead, said, by: backWorkdays(first, lead) });
    }).sort((a, b) => a.by.localeCompare(b.by) || a.name.localeCompare(b.name));
  }
  // The jobs that need a card now: booked or under way, a first day within LOOK_DAYS, something left.
  function wanted(cat) {
    if (typeof ordersJobs !== 'function') return [];
    const horizon = addDays(today(), LOOK_DAYS);
    return ordersJobs().filter(j => !j.done && j.left.length && ['booked', 'inprogress'].indexOf(statusOf(j.d)) !== -1)
      .map(j => Object.assign(j, { first: firstDay(j.id) }))
      .filter(j => j.first && j.first <= horizon)
      .map(j => Object.assign(j, { groups: plan(j, j.first, cat) }));
  }

  // ------------------------------------------------------------ state

  // From the server, but at most every READ_AGAIN_MS: this runs seconds
  // after every job or card change (while he types), and what this device
  // writes is kept in `state` as it goes. Another device's change is seen
  // within two minutes; the cards' own ids stop a second card meanwhile.
  const READ_AGAIN_MS = 120000;
  let readAt = 0;
  function read() {
    if (reading) return reading;
    if (state && Date.now() - readAt < READ_AGAIN_MS) return Promise.resolve(state);
    reading = Promise.resolve(window.YDDb.getFresh('settings', DOC)).then(d => {
      state = { jobs: (d && d.jobs) || {} };
      readAt = Date.now();
      return state;
    }).finally(() => { reading = null; });
    return reading;
  }
  function save(jobs) {
    Object.keys(jobs).forEach(id => { if (jobs[id] == null) delete state.jobs[id]; else state.jobs[id] = jobs[id]; });
    Promise.resolve(window.YDDb.put('settings', DOC, { jobs: jobs, updatedAt: iso() }))
      .catch(e => console.warn('[orderahead] not saved yet:', (e && e.code) || e));
  }

  // ------------------------------------------------------------ the to-do

  function words(j) {
    const t = today();
    const lines = j.groups.map(g => '• ' + g.name + ' — order by ' + dayWords(g.by) + (g.by < t ? ' (late)' : '') + ': ' +
      g.n + ' line' + (g.n === 1 ? '' : 's') + (g.special ? ', ' + g.special + ' special order' : '') +
      (g.said == null && g.vid && !g.special ? ' (no lead time set — ' + LEAD_WORKDAYS + ' working days assumed)' : ''));
    return 'First day on the Job schedule: ' + dayWords(j.first) + '.\n\nOrder by:\n' + lines.join('\n') +
      '\n\nThe lines are on All Jobs → Orders to place, and on the job\'s Materials to Order. Tick each one as ' +
      'you order it (or "Didn\'t buy it"); this card ticks itself off when they are all done.' +
      '\n\nLead times come from each supplier\'s "Usually takes" on Supplies; a special-order line allows at least ' +
      SPECIAL_WORKDAYS + ' working days.';
  }
  function fieldsFor(j) {
    const name = String(j.d.customerName || '').trim() || 'Untitled job';
    const num = String(j.d.estimateNumber || '').trim();
    const due = [j.groups[0].by, today()].sort()[1];
    return { title: '🧱 Order materials — ' + name + (num ? ' #' + num : ''), notes: words(j), due: due,
      jobId: j.id, jobName: name, jobNum: num || null };
  }
  function newCard(j) {
    const b = window.YDBoards && YDBoards.boards ? YDBoards.boards()[TODO] : null;
    const col = b && b.columns && b.columns[0] ? b.columns[0].id : 'admin0';
    const now = iso();
    return Object.assign({
      checklist: [], column: col, order: Date.now(), dueTime: null,
      remindMins: null, hasReminder: false, remindUids: [], noReminder: false,
      type: 'todo', urgency: 'normal', labels: [], color: null, assignees: [],
      noClaude: true, orderAhead: j.id,
      doneAt: null, createdAt: now, createdBy: 'Job Hub', updatedAt: now, updatedBy: 'Job Hub',
    }, fieldsFor(j));
  }
  const cardsNow = () => (window.YDBoards && YDBoards.cards ? (YDBoards.cards() || {})[TODO] || {} : {});
  const cardDone = c => {
    const b = window.YDBoards && YDBoards.boards()[TODO];
    return !!(c && b && YDBoards.doneCol && c.column === YDBoards.doneCol(b));
  };
  // A short fingerprint of the words (FNV-1a), so settings need not hold them twice.
  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }
  const wroteOf = f => ({ due: f.due, title: f.title, notes: hash(f.notes) });
  // The n-th card for the job: its own id, the same on every device (two of
  // his devices running at once make one card, not two).
  function makeCard(j, n) {
    const cid = 'oa' + safe(j.id) + '_' + j.first.replace(/-/g, '') + (n > 1 ? '_' + n : '');
    return Promise.resolve(window.YDDb.transact([['boards/' + TODO + '/cards', cid]], ([cur]) => [cur ? null : newCard(j)]))
      .then(() => save({ [j.id]: { cardId: cid, first: j.first, at: iso(), n: n, wrote: wroteOf(fieldsFor(j)), autoDone: false } }))
      .catch(e => console.warn('[orderahead] card not made yet:', (e && e.code) || e));
  }
  // An open card that no longer says what is true: its day, its words. Only
  // what is still as this last wrote it changes -- what he changed is his.
  function keepInStep(jobId, k, c, j) {
    const f = fieldsFor(j), was = k.wrote || {};
    const patch = {};
    if (c.due !== f.due && (!was.due || c.due === was.due)) patch.due = f.due;
    if (c.title !== f.title && (!was.title || c.title === was.title)) patch.title = f.title;
    if (c.notes !== f.notes && (!was.notes || hash(String(c.notes || '')) === was.notes)) patch.notes = f.notes;
    if (!Object.keys(patch).length) return Promise.resolve();
    return Promise.resolve(window.YDDb.put('boards/' + TODO + '/cards', k.cardId,
      Object.assign(patch, { updatedAt: iso(), updatedBy: 'Job Hub' })))
      .then(() => save({ [jobId]: Object.assign({}, k, { wrote: Object.assign({}, was, wroteOf(f)) }) }))
      .catch(e => console.warn('[orderahead] card not updated yet:', (e && e.code) || e));
  }

  // On the owner's device, once the jobs, boards, calendar and Supplies are the server's.
  function soon() { clearTimeout(timer); timer = setTimeout(run, 5000); }
  async function run() {
    if (running || !owner() || !window.YDDb || !navigator.onLine) return;
    if (!window.YDSync || !YDSync.jobsHeard || !YDSync.jobsHeard()) return;
    if (!window.YDBoards || !YDBoards.ready || !YDBoards.ready() || !YDBoards.boards()[TODO]) return;
    // The cards themselves from the server too: before them every card reads as gone.
    if (!YDBoards.cardsReady || !YDBoards.cardsReady(TODO)) return;
    if (!window.YDCalendar || !YDCalendar.ready || !YDCalendar.ready()) return;
    const cat = window.YDSupplies && YDSupplies.catalog ? YDSupplies.catalog() : null;
    if (!cat || !Object.keys(cat.items || {}).length) return;
    running = true;
    try {
      try { await read(); } catch (e) { return; }
      const now = wanted(cat);
      const byId = {};
      now.forEach(j => { byId[j.id] = j; });
      const cards = cardsNow();
      // The cards already made: kept in step, or ticked off once nothing is left to order.
      for (const jobId of Object.keys(state.jobs)) {
        const k = state.jobs[jobId], c = k && cards[k.cardId];
        if (!c || cardDone(c)) continue;
        const j = byId[jobId];
        if (j) { await keepInStep(jobId, k, c, j); continue; }
        // Not wanted any more: done when nothing is left to order (or the job is finished or gone);
        // a first day moved past two weeks leaves the card as it is.
        const still = (typeof ordersJobs === 'function' ? ordersJobs() : []).find(x => x.id === jobId);
        if ((!still || !still.left.length || still.done) && YDBoards.setDone) {
          YDBoards.setDone(TODO, k.cardId, true, true);
          save({ [jobId]: Object.assign({}, k, { autoDone: true }) });
        }
      }
      // New: a job with no card yet, or whose last card ticked itself off and has lines to order
      // again. One he ticked off or deleted himself is left so.
      for (const j of now) {
        const k = state.jobs[j.id], c = k && cards[k.cardId];
        if (c && !cardDone(c)) continue;
        if (k && !k.autoDone) continue;
        await makeCard(j, k ? (k.n || 1) + 1 : 1);
      }
    } finally { running = false; }
  }

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user ? a.user.uid + ':' + (a.key || a.role) : null;
    if (k === authKey) return;
    authKey = k;
    state = null;
    if (k && a.isOwner) soon();
  });
  ['yd-jobs-changed', 'yd-boards-ready', 'yd-cards-changed', 'yd-calendar-changed', 'yd-supplies'].forEach(ev => document.addEventListener(ev, soon));
  window.addEventListener('online', soon);

  window.YDOrderAhead = {
    // What a card would say now, job by job (for a look in the console).
    preview: () => {
      const cat = window.YDSupplies && YDSupplies.catalog ? YDSupplies.catalog() : { items: {}, vendors: {} };
      return wanted(cat).map(j => ({ job: j.id, first: j.first, card: fieldsFor(j) }));
    },
    _leadDays: leadDays,
    _backWorkdays: backWorkdays,
  };
})();
