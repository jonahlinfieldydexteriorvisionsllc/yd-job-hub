// Diggers Hotline tickets on the jobs. Jonah's routine 9 of 14 (wish card,
// 26 Oct 2026): a to-do "File Diggers ticket" dated 5 working days before
// the first dig day, and once the ticket is in, "good until" and a reminder
// the day before it lapses.
//
// He files the tickets himself (his account). The server reads Diggers
// Hotline's emails (functions/diggers.py) into digTickets/{ticket no}: the
// start date (clear to dig from), who for, the work address, the job it
// matched, the utilities' answers (response) and its clock (lapseOn,
// lapsed). Here:
//   - the Job tab (#digRow, beside the mark-out): the ticket's state, or
//     "no ticket yet — file it by <day>", "No ticket needed", and a ticket
//     that matched no job can be put on this one;
//   - a card on his My to-dos, "🚧 File the Diggers ticket — <name>", due 5
//     working days before the first day on the Job schedule (Wisconsin
//     wants 3 working days), made once per job on the owner's device, and
//     ticked off by itself when the ticket's email comes in;
//   - the crew's job page: the ticket number and "clear to dig from".
// Kept in settings/digging (owner only), as markout.js keeps its own:
//   jobs: { jobId: { cardId, at } | { none: true, at } }
(function () {
  'use strict';

  const TODO = 'todo';
  const DOC = 'digging';
  const LEAD_WORKDAYS = 5;          // the to-do's day: this many working days before the first day
  const LOOK_DAYS = 30;             // a first day further off than this gets no to-do yet
  const GRACE = 10;                 // start within, no break longer than (functions/diggers.py)
  // Work that digs. Wisconsin wants a ticket for any digging, so this leans
  // wide; "No ticket needed" on the Job tab for the rest.
  const DIGS = /\b(walls?|retaining|pavers?|patios?|drain\w*|trench\w*|light\w*|trees?|plant\w*|shrubs?|excavat\w*|footings?|posts?|fenc\w*|grad(?:e|ing)|fire ?pits?|walkways?|paths?|steps|edging|boulders?|sod|irrigat\w*|french|dig\w*|stump|turf|grading|garden|beds?|window ?wells?)\b/i;

  const el = id => document.getElementById(id);
  const safe = v => String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '');
  const iso = () => new Date().toISOString();
  const owner = () => !!(window.YDAuth && window.YDAuth.isOwner && window.YDAuth.mode === 'cloud' && window.YDAuth.user);
  const signedIn = () => !!(window.YDAuth && window.YDAuth.mode === 'cloud' && window.YDAuth.user);
  const statusOf = d => (typeof normStatus === 'function' ? normStatus(d.jobStatus, d) : (d.jobStatus || 'quoting'));
  const BOOKED = ['booked', 'inprogress'];
  const cardIdOf = jobId => 'dg' + safe(jobId);

  let tickets = {};          // digTickets/{no}
  let unsub = null;
  let state = null;          // settings/digging, once read
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
  function whenWords(s) {
    const t = new Date(String(s).length > 10 ? s : s + 'T00:00');
    if (isNaN(t)) return '';
    const h = t.getHours();
    return dayWords(s) + (String(s).length > 10 ? ', ' + (h % 12 || 12) + (t.getMinutes() ? ':' + pad(t.getMinutes()) : '') + (h < 12 ? ' am' : ' pm') : '');
  }

  // ------------------------------------------------------------ the job

  function jobOf(id) {
    try { return JSON.parse(readJobBlob(id) || 'null'); } catch (e) { return null; }
  }
  function digs(d) {
    if (!d) return false;
    const words = [].concat(d.serviceTypes || [], (((d.estimate || {}).work) || []).map(w => (w && w.title) || ''), d.crewWhat || '')
      .join(' · ');
    return DIGS.test(words);
  }
  // Its tickets, newest start first.
  function forJob(jobId) {
    return Object.values(tickets).filter(t => t.jobId === jobId)
      .sort((a, b) => String(b.start || '').localeCompare(String(a.start || '')));
  }
  // The first day on the Job schedule from today on, or ''.
  function firstDay(jobId) {
    const days = window.YDCalendar && YDCalendar.forJob ? YDCalendar.forJob(jobId, 120) : [];
    const job = days.filter(x => x.jobDay).map(x => x.day).sort();
    return job[0] || '';
  }
  // The ticket that covers the job now (not lapsed), or null.
  function current(jobId) {
    const t = forJob(jobId)[0];
    if (!t) return null;
    const lapseOn = (t.clock && t.clock.lapseOn) || addDays(String(t.start).slice(0, 10), GRACE);
    return Object.assign({}, t, { lapseOn, lapsed: today() > lapseOn, clear: new Date() >= new Date(t.start) });
  }
  function responseWords(r) {
    if (!r) return 'utilities not answered yet';
    if (r.allDone) return 'every utility answered ✓';
    return (r.waitingNames || []).length ? 'waiting on ' + r.waitingNames.join(', ') : r.waiting + ' not answered';
  }

  // ------------------------------------------------------------ state

  function read() {
    if (reading) return reading;
    reading = Promise.resolve(window.YDDb.getFresh('settings', DOC)).then(d => {
      state = { jobs: (d && d.jobs) || {} };
      return state;
    }).finally(() => { reading = null; });
    return reading;
  }
  function save(jobs) {
    if (!state) state = { jobs: {} };
    Object.keys(jobs).forEach(id => { if (jobs[id] == null) delete state.jobs[id]; else state.jobs[id] = jobs[id]; });
    Promise.resolve(window.YDDb.put('settings', DOC, { jobs: jobs, updatedAt: iso() }))
      .catch(e => console.warn('[digging] not saved yet:', (e && e.code) || e));
  }

  // ------------------------------------------------------------ the to-do

  function cardFor(id, d, first) {
    const name = String(d.customerName || '').trim() || 'Untitled job';
    const num = String(d.estimateNumber || '').trim();
    const where = [d.address, d.city].filter(Boolean).join(', ');
    const work = (((d.estimate || {}).work) || []).map(w => w && String(w.title || '').trim()).filter(Boolean).slice(0, 8);
    const b = window.YDBoards && YDBoards.boards ? YDBoards.boards()[TODO] : null;
    const col = b && b.columns && b.columns[0] ? b.columns[0].id : 'admin0';
    const due = [backWorkdays(first, LEAD_WORKDAYS), today()].sort()[1];
    const now = iso();
    return {
      title: '🚧 File the Diggers ticket — ' + name + (num ? ' #' + num : ''),
      notes: 'First day on the Job schedule: ' + dayWords(first) + '. Wisconsin wants the ticket in at least 3 working days ' +
        'before digging; this is 5 to be safe.\n\nFile it at diggershotline.com (or 811).' +
        (where ? '\n\nWhere: ' + where : '') + (work.length ? '\n\nThe work: ' + work.join(', ') : '') +
        '\n\nJob Hub reads the ticket from your email when it comes in and ticks this off.',
      checklist: [], column: col, order: Date.now(), due: due, dueTime: null,
      remindMins: null, hasReminder: false, remindUids: [], noReminder: false,
      type: 'todo', urgency: 'normal', labels: [], color: null, assignees: [],
      jobId: id, jobName: name, jobNum: num || null, noClaude: true, digTicket: id,
      doneAt: null, createdAt: now, createdBy: 'Job Hub', updatedAt: now, updatedBy: 'Job Hub',
    };
  }
  function makeCard(id, d, first) {
    const cid = cardIdOf(id), card = cardFor(id, d, first);
    return Promise.resolve(window.YDDb.transact([['boards/' + TODO + '/cards', cid]], ([cur]) => [cur ? null : card]))
      .then(() => { save({ [id]: { cardId: cid, at: iso() } }); return true; })
      .catch(e => { console.warn('[digging] card not made yet:', (e && e.code) || e); return false; });
  }
  const cardNow = id => {
    const k = state && state.jobs[id];
    return k && k.cardId && window.YDBoards ? ((YDBoards.cards() || {})[TODO] || {})[k.cardId] || null : null;
  };
  const cardDone = c => {
    const b = window.YDBoards && YDBoards.boards()[TODO];
    return !!(c && b && YDBoards.doneCol && c.column === YDBoards.doneCol(b));
  };

  // On the owner's device, once the jobs, boards and calendar are the
  // server's: a to-do for each digging job with a first day coming and no
  // ticket; a to-do whose ticket has come in, ticked off.
  function soon() { clearTimeout(timer); timer = setTimeout(run, 4000); }
  async function run() {
    if (running || !owner() || !window.YDDb || typeof getJobIndex !== 'function') return;
    if (!window.YDSync || !YDSync.jobsHeard || !YDSync.jobsHeard() || !navigator.onLine) return;
    if (!window.YDBoards || !YDBoards.ready || !YDBoards.ready() || !YDBoards.boards()[TODO]) return;
    if (!window.YDCalendar || !YDCalendar.ready || !YDCalendar.ready()) return;
    running = true;
    try {
      try { await read(); } catch (e) { return; }
      const horizon = addDays(today(), LOOK_DAYS);
      for (const j of getJobIndex()) {
        const d = jobOf(j.id);
        if (!d || d.deletedAt || d.removeWhy) continue;
        const k = state.jobs[j.id];
        const t = current(j.id);
        // The ticket came in: its to-do is done.
        if (t && !t.lapsed && k && k.cardId) {
          const c = cardNow(j.id);
          if (c && !cardDone(c) && YDBoards.setDone) YDBoards.setDone(TODO, k.cardId, true);
          continue;
        }
        if (k || (t && !t.lapsed) || BOOKED.indexOf(statusOf(d)) === -1 || !digs(d)) continue;
        const first = firstDay(j.id);
        if (!first || first > horizon) continue;
        await makeCard(j.id, d, first);
      }
      render();
    } finally { running = false; }
  }

  // ------------------------------------------------------------ the Job tab

  function unmatched() {
    const from = addDays(today(), -45);
    return Object.values(tickets).filter(t => !t.jobId && String(t.called || t.start || '') >= from)
      .sort((a, b) => String(b.start).localeCompare(String(a.start)));
  }
  function render() {
    const row = el('digRow');
    if (!row) return;
    const id = typeof currentJobId !== 'undefined' ? currentJobId : null;
    const d = id ? jobOf(id) : null;
    if (!owner() || !id || !d || !state) { row.innerHTML = ''; return; }
    const t = current(id);
    const k = state.jobs[id];
    let h = '';
    if (t) {
      h = '🚧 Diggers ticket ' + esc(t.no) + ' — ' + (t.lapsed
        ? '<b class="dig-late">lapsed ' + esc(dayWords(t.lapseOn)) + '</b> — file a new one'
        : (t.clear ? 'clear to dig since ' : 'clear to dig from ') + esc(whenWords(t.start)) + ' · ' +
          esc(t.clock && t.clock.lastWork ? 'good while work goes on, until ' + dayWords(t.lapseOn) + ' if it stops'
            : 'start by ' + dayWords(t.lapseOn)) + ' · ' + esc(responseWords(t.response)));
    } else if (k && k.none) {
      h = '🚧 No Diggers ticket needed <button type="button" class="link-btn" onclick="digUndoNone()">Undo</button>';
    } else if (BOOKED.indexOf(statusOf(d)) !== -1 && digs(d)) {
      const first = firstDay(id);
      const c = cardNow(id);
      h = '🚧 No Diggers ticket yet' + (first ? ' — file it by ' + esc(dayWords([backWorkdays(first, LEAD_WORKDAYS), today()].sort()[1])) +
          ' (first day ' + esc(dayWords(first)) + ')' : ' — put the first day on the Job schedule and a to-do is made') +
        (c ? ' <button type="button" class="link-btn" onclick="digOpenCard()">Open the to-do</button>' : '') +
        ' <button type="button" class="link-btn" onclick="digNone()">No ticket needed</button>';
    }
    const loose = t ? [] : unmatched();
    if (loose.length && (h || BOOKED.indexOf(statusOf(d)) !== -1)) {
      h += '<span class="dig-loose">Tickets on no job yet: ' + loose.slice(0, 3).map(x =>
        '<button type="button" class="link-btn" onclick="digPut(\'' + safe(x.no) + '\')">' +
        esc('#' + x.no + ' ' + (x.workFor || '') + ' · ' + (x.address || '')) + ' — this job’s</button>').join(' ') + '</span>';
    }
    row.innerHTML = h;
  }
  window.digNone = function () {
    const id = typeof currentJobId !== 'undefined' ? currentJobId : null;
    if (!owner() || !id) return;
    save({ [id]: { none: true, at: iso() } });
    render();
  };
  window.digUndoNone = function () {
    const id = typeof currentJobId !== 'undefined' ? currentJobId : null;
    if (!owner() || !id) return;
    save({ [id]: null });
    render();
    soon();
  };
  window.digOpenCard = function () {
    const id = typeof currentJobId !== 'undefined' ? currentJobId : null;
    const k = id && state && state.jobs[id];
    if (k && k.cardId && typeof window.openCardDetail === 'function') window.openCardDetail(TODO, k.cardId);
  };
  // A ticket that matched no job, put on this one (the server never moves it again).
  window.digPut = function (no) {
    const id = typeof currentJobId !== 'undefined' ? currentJobId : null;
    if (!owner() || !id || !tickets[no]) return;
    tickets[no] = Object.assign({}, tickets[no], { jobId: id, jobBy: 'hand' });
    render();
    soon();
    Promise.resolve(window.YDDb.put('digTickets', no, { jobId: id, jobBy: 'hand', updatedAt: iso() }))
      .catch(e => showToast(e && e.code === 'permission-denied' ? 'Not allowed' : 'Saved on this device — it goes up with signal'));
  };

  // ------------------------------------------------------------ the crew's page

  // crewjobs.js: the ticket, for the crew -- whether they may dig.
  function crewHtml(jobId) {
    const t = current(jobId);
    if (!t) return '';
    return '<div class="cj-dig' + (t.lapsed || !t.clear ? ' wait' : '') + '">🚧 <b>Locate ticket ' + esc(t.no) + '</b> — ' +
      (t.lapsed ? 'lapsed: do not dig until Jonah files a new one'
        : t.clear ? 'clear to dig since ' + esc(whenWords(t.start)) : 'NOT clear to dig until ' + esc(whenWords(t.start))) +
      (t.response && !t.response.allDone && !t.lapsed ? '<br><span class="muted">Still waiting on: ' + esc((t.response.waitingNames || []).join(', ')) +
        ' — look for their paint or flags before digging.</span>' : '') +
      '<br><span class="muted">Private lines (sprinklers, lights, a line to a garage) are never marked.</span></div>';
  }

  // ------------------------------------------------------------ watching

  function start() {
    stop();
    unsub = window.YDDb.watch('digTickets', changes => {
      changes.forEach(c => { if (c.type === 'removed') delete tickets[c.id]; else tickets[c.id] = Object.assign({ no: c.id }, c.data); });
      render();
      soon();
      document.dispatchEvent(new CustomEvent('yd-dig-tickets'));
    }, () => {});
  }
  function stop() { if (unsub) { try { unsub(); } catch (e) {} } unsub = null; tickets = {}; }

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user ? a.user.uid + ':' + (a.key || a.role) : null;
    if (k === authKey) return;
    authKey = k;
    state = null;
    if (!k) { stop(); render(); return; }
    start();
    if (a.isOwner) { read().then(render).catch(() => {}); soon(); }
  });
  ['yd-jobs-changed', 'yd-boards-ready', 'yd-cards-changed', 'yd-calendar-changed'].forEach(ev => document.addEventListener(ev, soon));
  document.addEventListener('yd-cards-changed', render);
  window.addEventListener('online', soon);

  window.YDDigging = {
    refresh: render,
    crewHtml: crewHtml,
    forJob: forJob,
    current: current,
    // Home: digging jobs starting within a week with no ticket.
    toFile: () => {
      if (!owner() || !state || typeof getJobIndex !== 'function') return [];
      const week = addDays(today(), 7);
      return getJobIndex().map(j => ({ j, d: jobOf(j.id) }))
        .filter(x => x.d && !x.d.deletedAt && !x.d.removeWhy && BOOKED.indexOf(statusOf(x.d)) !== -1 && digs(x.d) &&
          !(state.jobs[x.j.id] && state.jobs[x.j.id].none) && !(current(x.j.id) && !current(x.j.id).lapsed))
        .map(x => Object.assign(x, { first: firstDay(x.j.id) })).filter(x => x.first && x.first <= week);
    },
    _digs: digs,
    _backWorkdays: backWorkdays,
  };
})();
