// Marking out a booked job with paint, before the crew start.
//
// Jonah (22 Oct 2026): "Im also gonna start using marking paint on jobsites
// that is color coded so the guys know what to do. So after a job is booked
// it will need to go on my to-do to schedule a time to go and mark things
// out." So every job booked from that day on gets ONE card on his My to-dos
// board -- "📍 Mark out <customer>", linked to the job, the job's pieces of
// work as a checklist to tick as each is marked, and the paint colours'
// key (services.js, settings/serviceList.paint) in its notes. He sets the
// day on the card like any other to-do.
//
// Where it is kept: settings/markOut (owner only) --
//   { since,                  when this started
//     before: [jobId],        jobs already booked then: no card by itself
//                             (his answer: from now on; one tap adds one)
//     jobs: { jobId: { cardId, at } | { none: true, at } } }
// A job with an entry is never given another card -- not when the card is
// ticked off, moved or deleted, and not when it is booked a second time.
// "No mark-out" (a mowing contract, say) is an entry too. Made on the
// owner's device only (it is his to-do board), from whatever booked the
// job: the Job tab, the Jobs board, or QuickBooks through the server. The
// card's id comes from the job's (mo<jobId>) and is made only if no device
// made it already, so two of his devices never make two.
//
// On the Job tab, beside "What the crew see": where the job stands, Open it,
// and by hand -- add one (a job booked before), or "No mark-out needed".

(function () {
  'use strict';

  const DOC = 'markOut';
  const TODO = 'todo';                 // the My to-dos board (boards.js seedBoards)
  const el = id => document.getElementById(id);
  const safe = v => String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '');
  const iso = () => new Date().toISOString();
  const owner = () => !!(window.YDAuth && window.YDAuth.isOwner && window.YDAuth.mode === 'cloud' && window.YDAuth.user);
  const statusOf = d => (typeof normStatus === 'function' ? normStatus(d.jobStatus, d) : (d.jobStatus || 'quoting'));
  const BOOKED = ['booked', 'inprogress'];
  const cardIdOf = jobId => 'mo' + safe(jobId);

  let state = null;            // settings/markOut, once read from the server
  let reading = null;
  let running = false, timer = null;

  function read() {
    if (reading) return reading;
    reading = Promise.resolve(window.YDDb.getFresh('settings', DOC)).then(d => {
      state = d ? { since: d.since || null, before: Array.isArray(d.before) ? d.before : [], jobs: d.jobs || {} } : null;
      return state;
    }).finally(() => { reading = null; });
    return reading;
  }
  // Written as the database merges it (the jobs map key by key), and kept
  // here at once so the Job tab says so straight away.
  function save(patch) {
    if (!state) state = { since: null, before: [], jobs: {} };
    if (patch.since) state.since = patch.since;
    if (patch.before) state.before = patch.before.slice();
    Object.keys(patch.jobs || {}).forEach(id => { state.jobs[id] = patch.jobs[id]; });
    Promise.resolve(window.YDDb.put('settings', DOC, Object.assign({}, patch, { updatedAt: iso() })))
      .catch(e => console.warn('[markout] not saved yet:', (e && e.code) || e));
  }

  function jobOf(id) {
    try { return JSON.parse(readJobBlob(id) || 'null'); } catch (e) { return null; }
  }
  const snowJob = d => !!(window.YDEstimate && window.YDEstimate.isSnowJob && window.YDEstimate.isSnowJob(d));
  const live = d => !!d && !d.deletedAt && !d.removeWhy;
  function due(id, d) {
    return live(d) && BOOKED.indexOf(statusOf(d)) !== -1 && !snowJob(d) &&
      state.before.indexOf(id) === -1 && !state.jobs[id];
  }

  // The card: the job's pieces of work to tick as each is marked, and what
  // each colour means.
  function cardFor(id, d) {
    const name = String(d.customerName || '').trim() || 'Untitled job';
    const num = String(d.estimateNumber || '').trim();
    const work = (((d.estimate || {}).work) || []).filter(w => w && String(w.title || '').trim()).slice(0, 30);
    const key = window.YDServices && YDServices.paint ? YDServices.paint() : [];
    const where = [d.address, d.city].filter(Boolean).join(', ');
    const b = window.YDBoards && YDBoards.boards ? YDBoards.boards()[TODO] : null;
    const col = b && b.columns && b.columns[0] ? b.columns[0].id : 'admin0';
    const now = iso();
    return {
      title: '📍 Mark out ' + name + (num ? ' #' + num : ''),
      notes: 'Set a day to go out and mark the job with the marking paint before the crew start.' +
        (where ? '\n\nWhere: ' + where : '') +
        (key.length ? '\n\nColours:\n' + key.map(k => '• ' + k.name + ' — ' + k.means).join('\n')
          : '\n\nThe paint colours’ key is not set yet (🧰 Services → 🎨 Marking paint colours).'),
      checklist: work.map((w, i) => ({ id: 'mk' + i, text: String(w.title).trim().slice(0, 200), done: false })),
      column: col, order: Date.now(), due: null, dueTime: null,
      remindMins: null, hasReminder: false, remindUids: [], noReminder: false,
      type: null, urgency: 'normal', labels: [], color: null, assignees: [],
      jobId: id, jobName: name, jobNum: num || null,
      // His to do on site, not one for Claude's card runs (cards.py).
      noClaude: true, markOut: id,
      doneAt: null, createdAt: now, createdBy: 'Job Hub', updatedAt: now, updatedBy: 'Job Hub',
    };
  }
  // Made only if no device has made it yet (the same id from the same job).
  function makeCard(id, d) {
    const cid = cardIdOf(id), card = cardFor(id, d);
    return Promise.resolve(window.YDDb.transact([['boards/' + TODO + '/cards', cid]], ([cur]) => [cur ? null : card]))
      .then(() => { save({ jobs: { [id]: { cardId: cid, at: iso() } } }); return true; })
      .catch(e => { console.warn('[markout] card not made yet:', (e && e.code) || e); return false; });
  }

  // Every booked job not yet seen to, once the jobs on this device are the
  // server's (a fresh phone still filling its list would think none are
  // booked yet). The first time ever: the jobs booked then are "before".
  function soon() { clearTimeout(timer); timer = setTimeout(run, 3000); }
  async function run() {
    if (running || !owner() || !window.YDDb || !window.YDSync || typeof getJobIndex !== 'function') return;
    if (!YDSync.jobsHeard || !YDSync.jobsHeard() || !navigator.onLine) return;
    if (!window.YDBoards || !YDBoards.ready || !YDBoards.ready() || !YDBoards.boards()[TODO]) return;
    running = true;
    try {
      try { await read(); } catch (e) { return; }
      if (!state) {
        const before = getJobIndex().map(j => j.id).filter(id => { const d = jobOf(id); return live(d) && BOOKED.indexOf(statusOf(d)) !== -1; });
        save({ since: iso(), before: before, jobs: {} });
        render();
        return;
      }
      for (const j of getJobIndex()) {
        const d = jobOf(j.id);
        if (!due(j.id, d)) continue;
        await makeCard(j.id, d);
      }
      render();
    } finally { running = false; }
  }
  ['yd-jobs-changed', 'yd-boards-ready'].forEach(ev => document.addEventListener(ev, soon));
  window.addEventListener('online', soon);

  // ------------------------------------------------------------ the Job tab

  function cardNow(id) {
    const k = state && state.jobs[id];
    if (!k || !k.cardId || !window.YDBoards) return null;
    const c = ((YDBoards.cards() || {})[TODO] || {})[k.cardId];
    return c || null;
  }
  function render() {
    const row = el('markOutRow');
    if (!row) return;
    const id = typeof currentJobId !== 'undefined' ? currentJobId : null;
    if (!owner() || !id || !state) { row.innerHTML = ''; return; }
    const k = state.jobs[id];
    let h;
    if (k && k.none) {
      h = '📍 No mark-out for this job <button type="button" class="link-btn" onclick="markOutAdd()">Add a mark-out to-do</button>';
    } else if (k && k.cardId) {
      const c = cardNow(id), b = YDBoards.boards()[TODO];
      const done = c && b && YDBoards.doneCol && c.column === YDBoards.doneCol(b);
      // Gone from the board only once the board's cards are here to say so.
      const gone = !c && YDBoards.cardsReady && YDBoards.cardsReady(TODO);
      h = '📍 ' + (gone ? 'Mark-out to-do made ' + esc(new Date(k.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) +
            ', since taken off My to-dos <button type="button" class="link-btn" onclick="markOutAdd()">Add another</button>'
          : !c ? 'Mark-out to-do on My to-dos'
          : (done ? 'Marked out ✓' : 'Mark-out on My to-dos' + (c.due ? ' — ' + esc(new Date(c.due + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })) : ' — no day set yet')) +
            ' <button type="button" class="link-btn" onclick="markOutOpen()">Open it</button>');
    } else {
      h = '📍 <button type="button" class="link-btn" onclick="markOutAdd()">Add a mark-out to-do</button>' +
        ' <button type="button" class="link-btn" onclick="markOutNone()">No mark-out needed</button>';
    }
    row.innerHTML = h;
  }
  window.markOutAdd = async function () {
    const id = typeof currentJobId !== 'undefined' ? currentJobId : null;
    if (!owner() || !id) return;
    if (typeof dirty !== 'undefined' && dirty && typeof autosave === 'function') autosave();
    const d = jobOf(id);
    if (!d) return;
    if (!navigator.onLine) { showToast('No signal — try again when there is'); return; }
    try { await read(); } catch (e) {}
    // Asked again after "No mark-out" (or after its card went): a new card.
    const k = state && state.jobs[id];
    if (k && k.cardId && cardNow(id)) { render(); return; }
    if (k && k.cardId) {
      try { await window.YDDb.remove('boards/' + TODO + '/cards', cardIdOf(id)); } catch (e) {}
    }
    const ok = await makeCard(id, d);
    render();
    showToast(ok ? 'Mark-out to-do added to My to-dos' : 'Not added — check the signal');
  };
  window.markOutNone = function () {
    const id = typeof currentJobId !== 'undefined' ? currentJobId : null;
    if (!owner() || !id) return;
    save({ jobs: { [id]: { none: true, at: iso() } } });
    render();
    showUndo('No mark-out for this job', () => {
      // Undone: as if never asked (this device's copy and the server's).
      if (state) delete state.jobs[id];
      Promise.resolve(window.YDDb.put('settings', DOC, { jobs: { [id]: null }, updatedAt: iso() })).catch(() => {});
      render();
    });
  };
  window.markOutOpen = function () {
    const id = typeof currentJobId !== 'undefined' ? currentJobId : null;
    const k = id && state && state.jobs[id];
    if (!k || !k.cardId) return;
    // The card's own window, over the Job tab (boards.js).
    if (typeof window.openCardDetail === 'function') window.openCardDetail(TODO, k.cardId);
  };

  window.YDMarkOut = { refresh: render, run: soon };
  document.addEventListener('yd-cards-changed', render);
  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user && a.isOwner ? a.user.uid : null;
    if (k === authKey) return;
    authKey = k;
    state = null;
    if (k) { read().then(render).catch(() => {}); soon(); } else render();
  });
})();
