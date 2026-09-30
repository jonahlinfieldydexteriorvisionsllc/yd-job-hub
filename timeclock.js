// The crew time clock.
//
// Two numbers come out of every shift and they are not the same number:
//
//   PAID      every minute from clock-in to clock-out, pauses included.
//             What the business owes the person.
//   BILLABLE  paid time minus the pauses. What a client can be charged for.
//
// That split is the whole reason the pause button exists. A crew member who
// stops for fuel or to load salt is still working and still being paid, but
// no client should be charged for it. Without the pause there would have to be
// a choice between underpaying the crew and overbilling the customer, and both
// are the kind of mistake that is discovered months later.
//
// A pause is still PAID. Only the client's side of it goes away.
//
// Everything is one document per shift in `timeEntries`, pauses included as an
// array inside it. A shift is a single person at a single place, so nothing
// two people do at once can collide -- which is why pauses are not their own
// collection.
//
// Crew never write a pay rate; the rules forbid it. The rate is stamped by the
// owner at approval, from the worker's own record, so a historical shift does
// not silently change value when rates go up.

(function () {
  'use strict';

  const DEFAULT_RATE_CENTS = 2500;   // $25/hr, the standing crew rate

  // Buttons, not a text box: this gets tapped in the cold with gloves on.
  const PAUSE_REASONS = ['Gas', 'Salt / materials', 'Dump run', 'Driving', 'Break', 'Other'];

  let entries = {};      // id -> shift. Crew see only their own; owner sees all.
  let board = {};        // jobId -> { name, address, status }
  let people = {};       // uid -> user record (owner only)
  let unsub = [];
  let watchKey = null;   // uid + role the current watches were built for
  let ticker = null;     // redraws the running clock every second
  let picking = false;   // job picker open
  let pausingId = null;  // shift whose reason buttons are showing
  let clockingFor = null; // owner clocking somebody else in

  const el = id => document.getElementById(id);
  const nowIso = () => new Date().toISOString();
  const ms = iso => (iso ? new Date(iso).getTime() : 0);
  const me = () => (window.YDAuth && window.YDAuth.user) || null;
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);

  // ------------------------------------------------------------ the numbers
  //
  // Deliberately the only place a shift's length is worked out, so the clock
  // card, the approval queue, the job's labour cost and the snow invoice can
  // never disagree about the same shift.

  const startMsOf = e => (typeof e.startedMs === 'number' ? e.startedMs : ms(e.startedAt));
  const endMsOf = e => (typeof e.endedMs === 'number' ? e.endedMs
    : (e.endedAt ? ms(e.endedAt) : null));

  function paidMs(e) {
    const start = startMsOf(e);
    if (!start) return 0;
    const end = endMsOf(e) != null ? endMsOf(e) : Date.now();
    return Math.max(0, end - start);
  }

  // Paused time overlapping a window. With no window given it is the whole
  // shift; the snow side passes a single stop's arrive/depart instead, which
  // is what makes a pause land on the right client's invoice or on none.
  function pausedMs(e, from, to) {
    const lo = from == null ? startMsOf(e) : from;
    const hi = to == null ? (endMsOf(e) != null ? endMsOf(e) : Date.now()) : to;
    if (!(hi > lo)) return 0;
    return (e.pauses || []).reduce((sum, p) => {
      const ps = ms(p.startedAt);
      if (!ps) return sum;
      const pe = p.endedAt ? ms(p.endedAt) : Date.now();
      return sum + Math.max(0, Math.min(pe, hi) - Math.max(ps, lo));
    }, 0);
  }

  function billableMs(e) { return Math.max(0, paidMs(e) - pausedMs(e)); }

  // What a customer could actually be charged for. Labor and receipts are the
  // business's own time, so however long they ran, none of it is billable --
  // counting it would inflate every "billable hours" figure with work nobody
  // is ever invoiced for.
  function chargeableMs(e) { return canPause(e) ? billableMs(e) : 0; }

  const hours = milli => Math.round(milli / 36000) / 100;   // 2dp, for display

  // Wages are worked out from the milliseconds, never from the rounded hours.
  // Rounding to two decimals first and then multiplying quietly loses a few
  // cents a shift, and these numbers are somebody's pay.
  const costOf = (milli, rateCents) => Math.round(milli / 3600000 * rateCents);

  function fmtDur(milli) {
    const total = Math.floor(milli / 60000);
    const h = Math.floor(total / 60), m = total % 60;
    return h ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + 'm';
  }

  function clockTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString('en-US',
      { hour: 'numeric', minute: '2-digit' });
  }

  const running = e => !e.endedAt;

  // ----------------------------------------------------- what needs a look
  //
  // An ordinary clocked shift is trusted. Somebody tapped Clock in when they
  // started and Clock out when they stopped, and making the owner confirm each
  // one turns approval into a rubber stamp -- which is worse than no approval
  // at all, because a rubber stamp still looks like oversight.
  //
  // Two things do get stopped:
  //
  //   a shift TYPED IN by hand, because nobody watched the clock run; the
  //   times are a recollection, and that is exactly where a mistake lands
  //
  //   any shift longer than LONG_SHIFT_HOURS, however it was made, because at
  //   that length a forgotten clock-out and a genuinely long day look
  //   identical, and the difference is hours of wages
  //
  // The rules enforce the same two conditions, so this is not merely what the
  // app chooses to show.
  const LONG_SHIFT_HOURS = 8;
  const LONG_SHIFT_MS = LONG_SHIFT_HOURS * 3600000;

  function needsReview(paid, source) {
    return source === 'manual' || paid > LONG_SHIFT_MS;
  }

  // 'ok' is a finished shift that stands on its own; 'approved' is one the
  // owner decided. Both are real hours and both count.
  const counts = e => e.status === 'ok' || e.status === 'approved';
  const awaitingOwner = e => e.status === 'pending' && !running(e);
  const whyFlagged = e => e.source === 'manual'
    ? 'typed in by hand'
    : 'longer than ' + LONG_SHIFT_HOURS + ' hours';

  // Snow (with a storm running) and jobs are work a customer pays for. Labor,
  // receipts and snow with no storm are the business's own time: every minute
  // is paid and none of it is billable to anybody, so there is nothing for a
  // pause to withhold and the button is not offered.
  const BILLABLE_KINDS = ['job', 'storm'];
  const canPause = e => BILLABLE_KINDS.indexOf(e.kind) !== -1;
  const OVERHEAD_LABEL = { snow: 'Snow', labor: 'Labor', receipts: 'Receipts' };
  const openPause = e => (e.pauses || []).find(p => !p.endedAt) || null;
  const rateOf = uid => ((people[uid] || {}).rateCents) || DEFAULT_RATE_CENTS;

  // --------------------------------------------------------------- the list

  function mine() {
    const u = me();
    return u ? Object.values(entries).filter(e => e.uid === u.uid) : [];
  }
  function myOpenShift() { return mine().find(running) || null; }

  // ----------------------------------------------------------------- writes

  function write(id, data, what) {
    if (!window.YDDb) { showToast('Not saved — still connecting'); return; }
    // Not awaited, for the same reason as the storm screen: Firestore settles
    // the promise only when the server acknowledges, and this gets tapped in a
    // driveway with one bar.
    Promise.resolve(window.YDDb.put('timeEntries', id, data)).catch(e => {
      if (e && e.code === 'permission-denied') {
        console.error('[clock] ' + what + ' refused by the rules');
        showToast('Not saved — you are not allowed to do that');
      } else {
        console.warn('[clock] ' + what + ' not yet on the server:', (e && e.code) || (e && e.message));
      }
    });
  }

  // ---------------------------------------------------------------- clock in

  window.clockInTo = function (kind, targetId, targetName) {
    const u = me();
    if (!u) return;
    const forUid = clockingFor || u.uid;
    const already = Object.values(entries).find(e => e.uid === forUid && running(e));
    if (already) {
      // Switching is one action on purpose. Two taps means it does not happen
      // and the hours end up on the wrong job.
      endShift(already.id, 'switched');
    }

    const id = 'te' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    const rec = {
      uid: forUid,
      workerName: forUid === u.uid
        ? (u.displayName || u.email || 'Me')
        : ((people[forUid] || {}).name || (people[forUid] || {}).email || 'Worker'),
      kind: kind,                 // 'job' or 'storm'
      targetId: targetId,
      targetName: targetName,     // kept as it read then; jobs get renamed
      startedAt: nowIso(),
      endedAt: null,
      // The milliseconds are what the security rules read. Rules cannot do
      // arithmetic on a date written as text, and the eight-hour check has to
      // be enforced there rather than only here.
      startedMs: Date.now(),
      endedMs: null,
      pauses: [],
      note: '',
      source: 'clock',
      status: 'running',
      createdBy: u.uid,
    };
    entries[id] = Object.assign({ id: id }, rec);
    picking = false; clockingFor = null;
    render();
    write(id, rec, 'clocking in');
    showToast('Clocked in — ' + targetName);
  };

  window.openJobPicker = function (forUid) {
    clockingFor = forUid || null;
    picking = true;
    render();
  };

  // ------------------------------------------------- a shift they forgot
  //
  // Phone dead, hands full, simply forgot. Without this the hours are either
  // lost or invented later by the owner, so the honest thing is to let the
  // person who did the work write down when they did it -- and then have the
  // owner agree, because unlike a clocked shift nobody watched the clock run.

  let addingShift = false;
  let addFor = null;          // set when the owner is filing one for somebody

  window.openAddShift = function (forUid) {
    addFor = forUid || null;
    addingShift = true;
    picking = false;
    render();
  };
  window.cancelAddShift = function () { addingShift = false; addFor = null; render(); };

  function addShiftHtml() {
    const today = new Date();
    const iso = d => d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
    const jobs = Object.keys(board).map(id => Object.assign({ id: id }, board[id]))
      .filter(j => j.status !== 'complete')
      .sort((a, b) => String(a.name).localeCompare(b.name));

    return '<div class="addshift">' +
      '<p class="clock-lead">A shift you forgot to clock in for</p>' +
      '<div class="field"><span class="label">What were you on?</span>' +
        '<select id="asTarget">' +
          '<option value="labor|labor|Labor">Labor</option>' +
          '<option value="snow|snow|Snow">Snow</option>' +
          '<option value="receipts|receipts|Receipts">Receipts</option>' +
          jobs.map(j => '<option value="job|' + esc(j.id) + '|' + esc(j.name) + '">' +
            esc(j.name) + '</option>').join('') +
        '</select></div>' +
      '<div class="field"><span class="label">Day</span>' +
        '<input type="date" id="asDate" value="' + iso(today) + '" max="' + iso(today) + '"></div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Started</span><input type="time" id="asFrom"></div>' +
        '<div class="field"><span class="label">Finished</span><input type="time" id="asTo"></div>' +
      '</div>' +
      '<div class="field"><span class="label">What happened?</span>' +
        '<textarea id="asWhy" rows="2" placeholder="e.g. phone died, forgot to clock in"></textarea></div>' +
      '<div class="hint">This one goes to the office to approve, because the clock ' +
        'was not running.</div>' +
      '<div class="field-actions">' +
        '<button class="btn btn-filled clock-big" onclick="submitAddShift()">Send it in</button>' +
        '<button class="btn btn-sm" onclick="cancelAddShift()">Cancel</button>' +
      '</div>' +
    '</div>';
  }

  const two = n => String(n).padStart(2, '0');

  window.submitAddShift = function () {
    const u = me();
    if (!u) return;
    const forUid = addFor || u.uid;

    const parts = ((el('asTarget') || {}).value || '').split('|');
    const day = (el('asDate') || {}).value;
    const from = (el('asFrom') || {}).value;
    const to = (el('asTo') || {}).value;
    const why = ((el('asWhy') || {}).value || '').trim();

    if (!day || !from || !to) { showToast('Fill in the day and both times'); return; }

    const startMs = new Date(day + 'T' + from).getTime();
    let endMs = new Date(day + 'T' + to).getTime();
    if (!startMs || !endMs) { showToast('Those times did not make sense'); return; }
    // Finished before it started means it ran past midnight.
    if (endMs <= startMs) endMs += 24 * 3600000;

    if (endMs - startMs > 24 * 3600000) { showToast('That is longer than a day'); return; }
    if (startMs > Date.now() + 60000) { showToast('That is in the future'); return; }

    const id = 'te' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    const rec = {
      uid: forUid,
      workerName: forUid === u.uid
        ? ((people[forUid] || {}).name || u.displayName || u.email || 'Me')
        : ((people[forUid] || {}).name || (people[forUid] || {}).email || 'Worker'),
      kind: parts[0], targetId: parts[1], targetName: parts[2],
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      startedMs: startMs, endedMs: endMs,
      pauses: [],
      note: why,
      source: 'manual',
      status: 'pending',       // always: nobody watched the clock run
      createdBy: u.uid,
    };
    entries[id] = Object.assign({ id: id }, rec);
    addingShift = false; addFor = null;
    render();
    write(id, rec, 'submitting a shift');
    showToast('Sent in — ' + fmtDur(endMs - startMs) + ' on ' + parts[2]);
  };
  window.cancelJobPicker = function () { picking = false; clockingFor = null; render(); };

  // ----------------------------------------------------------- pause/resume

  window.askPause = function (id) { pausingId = id; render(); };
  window.cancelPause = function () { pausingId = null; render(); };

  window.pauseClock = function (id, reason) {
    const e = entries[id];
    if (!e || !running(e) || openPause(e)) return;
    e.pauses = (e.pauses || []).concat([{ startedAt: nowIso(), endedAt: null, reason: reason }]);
    pausingId = null;
    render();
    write(id, { pauses: e.pauses }, 'pausing');
    showToast('Paused — ' + reason + '. Still on the clock.');
  };

  window.resumeClock = function (id) {
    const e = entries[id];
    if (!e) return;
    const p = openPause(e);
    if (!p) return;
    p.endedAt = nowIso();
    render();
    write(id, { pauses: e.pauses }, 'resuming');
    showToast('Back on');
  };

  // --------------------------------------------------------------- clock out

  function endShift(id, why) {
    const e = entries[id];
    if (!e || !running(e)) return;
    const stamp = nowIso(), stampMs = Date.now();
    // An open pause is closed too, or the shift would look paused forever and
    // its billable time would be wrong.
    const p = openPause(e);
    if (p) p.endedAt = stamp;
    e.endedAt = stamp;
    e.endedMs = stampMs;

    // A normal day settles itself. Only a shift past the eight-hour mark goes
    // to the owner, because that is where a forgotten clock-out hides.
    e.status = needsReview(paidMs(e), e.source) ? 'pending' : 'ok';

    render();
    write(id, { endedAt: stamp, endedMs: stampMs, pauses: e.pauses, status: e.status },
      why || 'clocking out');
    return e.status;
  }

  window.clockOut = function (id) {
    const e = entries[id];
    if (!e) return;
    const dur = fmtDur(paidMs(e));
    const status = endShift(id);
    showToast(status === 'pending'
      ? 'Clocked out — ' + dur + '. Over ' + LONG_SHIFT_HOURS +
        ' hours, so it goes to the office to check.'
      : 'Clocked out — ' + dur);
  };

  // ------------------------------------------------------------- the display

  function render() {
    renderClockCard();
    // Not while the name and rate are being typed into: the clock redraws
    // every second, and rebuilding the form would clear the fields mid-word.
    if (workerUid && !editingWorker
        && el('workerModal') && el('workerModal').classList.contains('active')) renderWorker();
    if (isOwner()) { renderOnNow(); renderApprovals(); renderCrew(); renderTotals(); }
    manageTicker();
  }
  window.renderClock = render;

  // A running clock only needs redrawing while it is actually on screen and
  // actually running.
  function manageTicker() {
    const visible = el('panel-clock') && el('panel-clock').classList.contains('active');
    const live = Object.values(entries).some(running);
    if (visible && live && !ticker) ticker = setInterval(render, 1000);
    if ((!visible || !live) && ticker) { clearInterval(ticker); ticker = null; }
  }

  function renderClockCard() {
    const wrap = el('clockWrap');
    if (!wrap) return;
    const shift = myOpenShift();

    const badge = el('clockBadge');
    if (badge) badge.textContent = shift ? (openPause(shift) ? 'Paused' : 'On the clock') : '';

    if (addingShift) { wrap.innerHTML = addShiftHtml(); return; }
    if (picking) {
      // The running clock redraws every second, and rebuilding the picker
      // replaces the search box. While somebody is actually typing in it, only
      // the list may be touched -- otherwise the field would be swapped out
      // from under them once a second, mid-word.
      //
      // The rest of the time the whole picker is rebuilt, so that a storm
      // starting while this screen is open turns the Snow button into tonight's
      // storm instead of leaving it stale. Anything already typed is carried
      // across.
      const box = el('clockSearch');
      if (box && document.activeElement === box) { filterJobPicker(); return; }
      const typed = box ? box.value : '';
      wrap.innerHTML = pickerHtml();
      if (typed) {
        const fresh = el('clockSearch');
        if (fresh) { fresh.value = typed; filterJobPicker(); }
      }
      return;
    }
    wrap.innerHTML = shift ? liveHtml(shift) : idleHtml();
  }

  function idleHtml() {
    return '<div class="clock-idle">' +
      '<p class="clock-lead">Not on the clock.</p>' +
      '<button class="btn btn-filled clock-big" onclick="openJobPicker()">Clock in</button>' +
      recentHtml() +
      '<button class="btn btn-sm" onclick="openAddShift()">Forgot to clock in?</button>' +
      '<button class="btn btn-sm wk-mine" onclick="openWorker()">My hours</button>' +
    '</div>';
  }

  function liveHtml(e) {
    const p = openPause(e);
    const paid = paidMs(e), bill = billableMs(e);
    return '<div class="clock-live' + (p ? ' paused' : '') + '">' +
      '<div class="clock-where">' + esc(e.targetName) +
        (e.kind === 'storm' ? ' <span class="clock-kind">storm</span>' : '') +
        (OVERHEAD_LABEL[e.kind] ? ' <span class="clock-kind">not a job</span>' : '') + '</div>' +
      '<div class="clock-elapsed">' + fmtDur(paid) + '</div>' +
      '<div class="clock-sub">in at ' + clockTime(e.startedAt) +
        (pausedMs(e) ? ' · ' + fmtDur(pausedMs(e)) + ' paused · ' + fmtDur(bill) + ' billable' : '') +
      '</div>' +
      (p ? '<div class="clock-pausenote">Paused for ' + esc(p.reason) +
             ' — still being paid, not billed to the customer.</div>' : '') +
      (pausingId === e.id
        ? '<div class="pause-reasons"><p class="clock-lead">What for?</p>' +
            PAUSE_REASONS.map(r =>
              '<button class="btn" onclick="pauseClock(\'' + e.id + '\', \'' + r.replace(/'/g, "\\'") + '\')">' +
              r + '</button>').join('') +
            '<button class="btn btn-sm" onclick="cancelPause()">Never mind</button>' +
          '</div>'
        : '<div class="clock-actions">' +
            (canPause(e)
              ? (p
                  ? '<button class="btn btn-filled clock-big" onclick="resumeClock(\'' + e.id + '\')">Back on</button>'
                  : '<button class="btn btn-accent clock-big" onclick="askPause(\'' + e.id + '\')">Pause</button>')
              : '') +
            '<button class="btn clock-big" onclick="clockOut(\'' + e.id + '\')">Clock out</button>' +
            '<button class="btn btn-sm" onclick="openJobPicker()">Switch to something else</button>' +
            '<button class="btn btn-sm" onclick="openWorker()">My hours</button>' +
          '</div>') +
    '</div>';
  }

  // The last few places this person worked, so the usual case is one tap.
  function recentHtml() {
    const seen = {}, out = [];
    mine().filter(e => e.endedAt)
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .forEach(e => {
        const key = e.kind + ':' + e.targetId;
        if (seen[key] || out.length >= 3) return;
        if (e.kind === 'job' && !board[e.targetId]) return;   // job is gone
        seen[key] = 1; out.push(e);
      });
    if (!out.length) return '';
    return '<div class="clock-recent"><p class="clock-lead">Back to where you were</p>' +
      out.map(e => '<button class="btn" onclick="clockInTo(\'' + e.kind + '\', \'' +
        e.targetId + '\', \'' + esc(e.targetName).replace(/'/g, '&#39;') + '\')">' +
        esc(e.targetName) + '</button>').join('') + '</div>';
  }

  function pickerHtml() {
    const storm = window.YDStorm && YDStorm.current();
    const stormOpen = storm && storm.status === 'open';

    // Snow points at the open storm when there is one, so its pauses land on
    // the right customer's invoice. With no storm running it is still snow
    // work -- loading salt, fixing a plow -- but it belongs to no customer, so
    // it is booked as the business's own time like the other two.
    return '<div class="picker">' +
      '<p class="clock-lead">What are you working on?</p>' +
      '<div class="picker-kinds">' +
        (stormOpen
          ? kindBtn('storm', storm.id, 'Tonight’s storm', '❄️', 'kind-snow')
          : kindBtn('snow', 'snow', 'Snow', '❄️', 'kind-snow')) +
        kindBtn('labor', 'labor', 'Labor', '🛠️', 'kind-labor') +
        kindBtn('receipts', 'receipts', 'Receipts', '🧾', 'kind-receipts') +
      '</div>' +
      '<p class="clock-lead picker-or">… or a job</p>' +
      '<input id="clockSearch" class="picker-search" placeholder="Search every job…" oninput="filterJobPicker()">' +
      '<div id="pickerList">' + pickerList() + '</div>' +
      '<button class="btn btn-sm" onclick="cancelJobPicker()">Cancel</button>' +
    '</div>';
  }

  function kindBtn(kind, id, label, icon, cls) {
    return '<button class="picker-kind ' + cls + '" onclick="clockInTo(\'' + kind + '\', \'' +
      id + '\', \'' + label.replace(/'/g, "\\'") + '\')">' +
      '<span class="kind-icon">' + icon + '</span>' + label + '</button>';
  }

  // Only the list is redrawn, never the whole picker. Rebuilding the picker
  // would replace the search box itself, and the field would lose focus after
  // every single character typed.
  window.filterJobPicker = function () {
    const list = el('pickerList');
    if (list) list.innerHTML = pickerList();
  };

  const rank = j => j.status === 'active' ? 0 : j.status === 'complete' ? 2 : 1;

  // With nothing typed this is EVERY active job, however many there are. The
  // usual case is clocking in to work already under way, and having to search
  // for that would be the wrong way round. Typing searches the lot, finished
  // jobs included, because a callback on a closed job still needs somewhere to
  // put the hours.
  function pickerList() {
    const search = ((el('clockSearch') || {}).value || '').trim().toLowerCase();
    const jobs = Object.keys(board).map(id => Object.assign({ id: id }, board[id]));

    const list = search
      ? jobs.filter(j => (j.name + ' ' + (j.address || '')).toLowerCase().indexOf(search) !== -1)
            .sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(b.name))
      : jobs.filter(j => j.status === 'active')
            .sort((a, b) => String(a.name).localeCompare(b.name));

    if (!list.length) {
      return '<p class="empty-msg">' + (search ? 'No job matches that.'
        : 'No active jobs. Search above for a quoted or finished one.') + '</p>';
    }
    return list.map(j =>
      '<button class="picker-job" onclick="clockInTo(\'job\', \'' + j.id + '\', \'' +
        esc(j.name).replace(/'/g, '&#39;') + '\')">' +
        '<span class="picker-name">' + esc(j.name) + '</span>' +
        (j.address ? '<span class="picker-addr">' + esc(j.address) + '</span>' : '') +
        '<span class="picker-flag ' + esc(j.status || '') + '">' + esc(j.status || 'job') + '</span>' +
      '</button>').join('');
  }

  // ------------------------------------------------------------ owner views

  function renderOnNow() {
    const wrap = el('onNowWrap');
    if (!wrap) return;
    const live = Object.values(entries).filter(running)
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const badge = el('onNowBadge');
    if (badge) badge.textContent = live.length ? live.length + ' working' : '';

    wrap.innerHTML = (live.length
      ? live.map(e => {
          const p = openPause(e);
          return '<div class="on-now' + (p ? ' paused' : '') + '">' +
            '<button class="on-who linkish" onclick="openWorker(\'' + e.uid + '\')">' +
              esc(e.workerName) + '</button>' +
            '<span class="on-where">' + esc(e.targetName) + '</span>' +
            '<span class="on-time">' + fmtDur(paidMs(e)) + (p ? ' · paused (' + esc(p.reason) + ')' : '') + '</span>' +
            '<button class="btn btn-sm" onclick="clockOut(\'' + e.id + '\')">Clock out</button>' +
          '</div>';
        }).join('')
      : '<p class="empty-msg">Nobody is on the clock.</p>') +
      '<div class="field-actions"><button class="btn btn-sm" onclick="pickWorkerToClockIn()">Clock somebody in</button></div>';
  }

  // Their phone is dead, or they forgot. The entry records who actually
  // created it, so this is never mistaken for the person's own clock-in.
  window.pickWorkerToClockIn = function () {
    const crew = Object.keys(people)
      .filter(uid => people[uid].role === 'crew' && people[uid].active);
    if (!crew.length) { showToast('No crew members approved yet'); return; }
    const names = crew.map((uid, i) => (i + 1) + '. ' + (people[uid].name || people[uid].email));
    const pick = prompt('Clock in who?\n\n' + names.join('\n'), '1');
    const i = parseInt(pick, 10) - 1;
    if (!(i >= 0 && i < crew.length)) return;
    openJobPicker(crew[i]);
  };

  function renderApprovals() {
    const wrap = el('approveWrap');
    if (!wrap) return;
    const waiting = Object.values(entries).filter(awaitingOwner)
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const badge = el('approveBadge');
    if (badge) badge.textContent = waiting.length ? waiting.length + ' waiting' : '';
    const sec = el('clockApproveSection');
    if (sec) sec.hidden = false;

    if (!waiting.length) {
      wrap.innerHTML = '<p class="empty-msg">Nothing waiting. Ordinary clocked shifts ' +
        'go through on their own — only shifts typed in by hand, or longer than ' +
        LONG_SHIFT_HOURS + ' hours, land here.</p>';
      return;
    }
    wrap.innerHTML = waiting.map(e => {
      const paid = paidMs(e), bill = billableMs(e), pause = pausedMs(e);
      return '<div class="appr">' +
        '<div class="appr-top">' +
          '<button class="appr-who linkish" onclick="openWorker(\'' + e.uid + '\')">' +
            esc(e.workerName) + '</button>' +
          '<span class="appr-where">' + esc(e.targetName) + '</span>' +
          '<span class="appr-why">' + whyFlagged(e) + '</span>' +
        '</div>' +
        (e.note ? '<div class="appr-note">“' + esc(e.note) + '”</div>' : '') +
        '<div class="appr-times">' +
          new Date(e.startedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }) +
          ' · ' + clockTime(e.startedAt) + ' – ' + clockTime(e.endedAt) +
        '</div>' +
        '<div class="appr-nums">' +
          '<span><strong>' + fmtDur(paid) + '</strong> paid</span>' +
          (pause ? '<span>' + fmtDur(pause) + ' paused</span>' : '') +
          '<span><strong>' + fmtDur(bill) + '</strong> billable</span>' +
          '<span class="appr-cost">' + money(costOf(paid, rateOf(e.uid))) + '</span>' +
        '</div>' +
        ((e.pauses || []).length
          ? '<div class="appr-pauses">' + e.pauses.map(p =>
              esc(p.reason) + ' ' + fmtDur(Math.max(0, (p.endedAt ? ms(p.endedAt) : Date.now()) - ms(p.startedAt)))
            ).join(' · ') + '</div>'
          : '') +
        '<div class="appr-act">' +
          '<button class="btn btn-filled btn-sm" onclick="approveShift(\'' + e.id + '\')">Approve</button>' +
          '<button class="btn btn-sm" onclick="rejectShift(\'' + e.id + '\')">Reject</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  const money = c => '$' + (c / 100).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Approval is where the money is decided. The rate is read from the worker's
  // record and written onto the shift, so raising someone's rate next year
  // does not quietly re-value every shift they have ever worked.
  // A shift that settled itself has no rate on it -- the rules forbid crew
  // from writing one, and rightly so. The owner's app stamps it the first time
  // it sees it, which is what stops a later change of rate quietly re-valuing
  // work already done. Until then the figures use the worker's current rate,
  // so nothing is ever blank; the stamp just freezes it.
  function stampUnpriced() {
    if (!isOwner() || !window.YDDb) return;
    Object.keys(entries).forEach(id => {
      const e = entries[id];
      if (!counts(e) || running(e) || e.rateCents != null) return;
      const patch = {
        rateCents: rateOf(e.uid),
        costCents: costOf(paidMs(e), rateOf(e.uid)),
        paidHours: hours(paidMs(e)),
        billableHours: hours(chargeableMs(e)),
      };
      Object.assign(e, patch);
      write(id, patch, 'pricing a settled shift');
    });
  }

  window.approveShift = function (id) {
    const e = entries[id];
    if (!e || !isOwner()) return;
    const patch = {
      status: 'approved',
      rateCents: rateOf(e.uid),
      paidHours: hours(paidMs(e)),
      billableHours: hours(billableMs(e)),
      // Stamped, not recalculated later, so the wage bill for a shift can
      // never drift from what was approved.
      costCents: costOf(paidMs(e), rateOf(e.uid)),
      approvedBy: (me() || {}).uid || '',
      approvedAt: nowIso(),
    };
    Object.assign(e, patch);
    render();
    write(id, patch, 'approving');
    if (typeof refreshJobLabour === 'function') refreshJobLabour();
    showToast('Approved — ' + fmtDur(paidMs(e)) + ' for ' + e.workerName);
  };

  window.rejectShift = function (id) {
    const e = entries[id];
    if (!e || !isOwner()) return;
    const why = prompt('Why is this being rejected? The crew member sees this.');
    if (why === null) return;
    const patch = { status: 'rejected', rejectedReason: why.trim(),
                    approvedBy: (me() || {}).uid || '', approvedAt: nowIso() };
    Object.assign(e, patch);
    render();
    write(id, patch, 'rejecting');
  };

  function rangeStart(which) {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    if (which === 'week' || which === 'lastweek') {
      d.setDate(d.getDate() - d.getDay());                 // back to Sunday
      if (which === 'lastweek') d.setDate(d.getDate() - 7);
    } else if (which === 'month') {
      d.setDate(1);
    } else return 0;
    return d.getTime();
  }

  // ------------------------------------------------------------- your crew
  //
  // Signing in creates a 'pending' record that grants nothing until the owner
  // changes the role. Until this screen existed there was no way to make that
  // change except by editing the database by hand, which meant the first step
  // of using the clock at all was a trip to the Firebase console.

  function renderCrew() {
    const wrap = el('crewWrap');
    if (!wrap) return;
    const all = Object.keys(people).map(uid => people[uid])
      .filter(u => u.uid !== ((me() || {}).uid));

    const waiting = all.filter(u => u.role === 'pending' || u.active === false);
    const active = all.filter(u => u.role === 'crew' && u.active);

    const badge = el('crewBadge');
    if (badge) badge.textContent = waiting.filter(u => u.role === 'pending').length
      ? waiting.filter(u => u.role === 'pending').length + ' asking to join' : '';

    wrap.innerHTML =
      (waiting.length
        ? waiting.map(u => '<div class="crew-row waiting">' +
            '<span class="crew-name">' + esc(u.name || u.email) + '</span>' +
            '<span class="crew-mail">' + esc(u.email) + '</span>' +
            '<span class="crew-state">' + (u.role === 'pending' ? 'wants access' : 'switched off') + '</span>' +
            '<button class="btn btn-sm btn-filled" onclick="approveCrew(\'' + u.uid + '\')">' +
              (u.role === 'pending' ? 'Let them in' : 'Switch back on') + '</button>' +
            (u.role === 'pending'
              ? '<button class="btn btn-sm" onclick="denyCrew(\'' + u.uid + '\')">Not them</button>' : '') +
          '</div>').join('')
        : '') +
      (active.length
        ? active.map(u => '<div class="crew-row">' +
            '<button class="crew-name linkish" onclick="openWorker(\'' + u.uid + '\')">' +
              esc(u.name || u.email) + '</button>' +
            '<span class="crew-mail">' + esc(u.email) + '</span>' +
            '<button class="btn btn-sm" onclick="setWorkerRate(\'' + u.uid + '\')">' +
              money(rateOf(u.uid)) + '/hr</button>' +
            '<button class="remove-btn" onclick="removeCrew(\'' + u.uid + '\')" title="Switch off">&times;</button>' +
          '</div>').join('')
        : '<p class="empty-msg">No crew yet. Send them the app link and ask them to ' +
          'sign in with Google — they will show up here to let in.</p>');
  }

  function setRole(uid, patch, msg) {
    if (!isOwner() || !people[uid]) return;
    people[uid] = Object.assign({}, people[uid], patch);
    render();
    Promise.resolve(window.YDDb.put('users', uid, patch))
      .catch(e => console.warn('[clock] role change not saved:', e.code || e.message));
    if (msg) showToast(msg);
  }

  window.approveCrew = function (uid) {
    const u = people[uid];
    if (!u) return;
    setRole(uid, { role: 'crew', active: true },
      (u.name || u.email) + ' can now clock in');
  };

  // Denied, not deleted: the record is the audit trail of who asked, and the
  // rules forbid deleting user records outright.
  window.denyCrew = function (uid) {
    const u = people[uid];
    if (!u || !confirm('Refuse access for ' + (u.email) + '?')) return;
    setRole(uid, { role: 'denied', active: false }, 'Refused');
  };

  window.removeCrew = function (uid) {
    const u = people[uid];
    if (!u || !confirm('Switch off access for ' + (u.name || u.email) +
        '?\n\nTheir hours are kept. You can switch them back on any time.')) return;
    setRole(uid, { active: false }, (u.name || u.email) + ' switched off');
  };

  function renderTotals() {
    const wrap = el('totalsWrap');
    if (!wrap) return;
    const which = (el('clockRange') || {}).value || 'week';
    const from = rangeStart(which);
    const to = which === 'lastweek' ? from + 7 * 864e5 : Infinity;

    const inRange = e => startMsOf(e) >= from && startMsOf(e) < to;
    const done = Object.values(entries).filter(e => counts(e) && inRange(e));
    const pending = Object.values(entries).filter(e => awaitingOwner(e) && inRange(e));

    const byWorker = {};
    done.forEach(e => {
      const w = byWorker[e.uid] = byWorker[e.uid] ||
        { name: e.workerName, uid: e.uid, paid: 0, bill: 0, cost: 0 };
      w.paid += paidMs(e); w.bill += chargeableMs(e);
      w.cost += e.costCents != null ? e.costCents
        : costOf(paidMs(e), e.rateCents || rateOf(e.uid));
    });
    const list = Object.values(byWorker).sort((a, b) => b.paid - a.paid);
    const totalCost = list.reduce((s, w) => s + w.cost, 0);

    const badge = el('totalsBadge');
    if (badge) badge.textContent = totalCost ? money(totalCost) : '';

    wrap.innerHTML = (list.length
      ? '<div class="table-wrap"><table><thead><tr><th>Worker</th><th>Paid</th>' +
        '<th>Billable</th><th>Rate</th><th>Cost</th></tr></thead><tbody>' +
        list.map(w =>
          '<tr><td class="bold">' + esc(w.name) + '</td>' +
          '<td>' + fmtDur(w.paid) + '</td>' +
          '<td>' + fmtDur(w.bill) + '</td>' +
          '<td><button class="btn btn-sm" onclick="setWorkerRate(\'' + w.uid + '\')">' +
            money(rateOf(w.uid)) + '/hr</button></td>' +
          '<td class="bold">' + money(w.cost) + '</td></tr>').join('') +
        '</tbody><tfoot><tr><td colspan="4" style="text-align:right;font-weight:700">Total</td>' +
        '<td style="font-weight:700">' + money(totalCost) + '</td></tr></tfoot></table></div>'
      : '<p class="empty-msg">No approved hours in this range.</p>') +
      whereItWentHtml(done) +
      (pending.length
        ? '<p class="hint">' + pending.length + ' shift' + (pending.length === 1 ? '' : 's') +
          ' still waiting for approval. Those are not counted above, or on any job.</p>'
        : '');
  }

  // Hours on a job show up on that job. Labor, receipts and snow-with-no-storm
  // show up nowhere else at all, so without this the money spent on them would
  // be invisible -- which is the part of a wage bill worth watching, because
  // none of it is charged to anyone.
  function whereItWentHtml(done) {
    if (!done.length) return '';
    const bucket = {};
    done.forEach(e => {
      const key = e.kind === 'job' ? 'Jobs'
        : e.kind === 'storm' ? 'Snow (storms)'
        : (OVERHEAD_LABEL[e.kind] || 'Other');
      const b = bucket[key] = bucket[key] || { ms: 0, cents: 0, billable: false };
      b.ms += paidMs(e);
      b.cents += e.costCents != null ? e.costCents
        : costOf(paidMs(e), e.rateCents || rateOf(e.uid));
      if (BILLABLE_KINDS.indexOf(e.kind) !== -1) b.billable = true;
    });

    const rows = Object.keys(bucket).sort((a, b) => bucket[b].cents - bucket[a].cents);
    const overhead = rows.filter(k => !bucket[k].billable)
      .reduce((s, k) => s + bucket[k].cents, 0);

    return '<div class="went"><div class="went-head">Where the hours went</div>' +
      rows.map(k => '<div class="went-row' + (bucket[k].billable ? '' : ' overhead') + '">' +
        '<span>' + esc(k) + '</span>' +
        '<span>' + fmtDur(bucket[k].ms) + '</span>' +
        '<span class="went-cost">' + money(bucket[k].cents) + '</span>' +
      '</div>').join('') +
      (overhead
        ? '<div class="went-note">' + money(overhead) +
          ' of this is not charged to any customer.</div>'
        : '') +
    '</div>';
  }

  // --------------------------------------------------------- a worker's page
  //
  // Everything about one person in one place: what they are on right now, what
  // they have worked this week and this season, where those hours went, what
  // they are owed, and every shift behind the numbers. The totals table answers
  // "what do I owe everyone"; this answers "what has Marco actually been doing",
  // which is the question asked when somebody queries their pay.
  //
  // A crew member opening it sees their own page and nobody else's -- the rules
  // only ever gave them their own shifts to read.

  let workerUid = null;
  let workerRange = 'week';

  window.openWorker = function (uid) {
    workerUid = uid || ((me() || {}).uid);
    workerRange = 'week';
    editingWorker = false;
    const m = el('workerModal');
    if (m) m.classList.add('active');
    renderWorker();
  };
  window.closeWorker = function () {
    const m = el('workerModal');
    if (m) m.classList.remove('active');
    workerUid = null;
  };
  window.setWorkerRange = function (r) { workerRange = r; renderWorker(); };

  function renderWorker() {
    const body = el('workerBody');
    if (!body || !workerUid) return;
    const u = people[workerUid] || {};
    const isMe = workerUid === ((me() || {}).uid);
    const name = u.name || u.email || (isMe ? 'My hours' : 'Worker');

    const title = el('workerTitle');
    if (title) title.textContent = name;

    const all = Object.values(entries).filter(e => e.uid === workerUid);
    const from = rangeStart(workerRange);
    const to = workerRange === 'lastweek' ? from + 7 * 864e5 : Infinity;
    const inRange = all.filter(e => startMsOf(e) >= from && startMsOf(e) < to);

    const approved = inRange.filter(counts);
    const waiting = inRange.filter(awaitingOwner);
    const live = all.find(running);

    const paid = approved.reduce((s, e) => s + paidMs(e), 0);
    const bill = approved.reduce((s, e) => s + chargeableMs(e), 0);
    const owed = approved.reduce((s, e) => s + (e.costCents != null ? e.costCents
      : costOf(paidMs(e), e.rateCents || rateOf(e.uid))), 0);

    body.innerHTML =
      (editingWorker && isOwner()
        ? '<div class="wk-edit">' +
            '<div class="grid g2">' +
              '<div class="field"><span class="label">Name</span>' +
                '<input id="wkName" value="' + esc(u.name || '') + '" placeholder="What they go by"></div>' +
              '<div class="field"><span class="label">Hourly rate</span>' +
                '<input id="wkRate" inputmode="decimal" value="' +
                  (rateOf(workerUid) / 100).toFixed(2) + '"></div>' +
            '</div>' +
            '<div class="hint">A new rate applies to shifts approved from now on. ' +
              'Shifts already approved keep the rate they were approved at.</div>' +
            '<div class="field-actions">' +
              '<button class="btn btn-filled" onclick="saveWorkerEdit()">Save</button>' +
              '<button class="btn" onclick="cancelWorkerEdit()">Cancel</button>' +
            '</div>' +
          '</div>'
        : '<div class="wk-top">' +
            '<div><div class="wk-name">' + esc(name) + '</div>' +
            (u.email ? '<div class="wk-mail">' + esc(u.email) + '</div>' : '') + '</div>' +
            (isOwner()
              ? '<button class="btn btn-sm" onclick="editWorker()">' +
                money(rateOf(workerUid)) + '/hr · Edit</button>'
              : '<span class="wk-rate">' + money(rateOf(workerUid)) + '/hr</span>') +
          '</div>') +

      (live
        ? '<div class="wk-live">On the clock now — <strong>' + esc(live.targetName) +
          '</strong>, ' + fmtDur(paidMs(live)) +
          (openPause(live) ? ' · paused for ' + esc(openPause(live).reason) : '') + '</div>'
        : '') +

      '<div class="filter-bar wk-range">' +
        ['week', 'lastweek', 'month', 'all'].map(r =>
          '<button class="btn btn-sm' + (workerRange === r ? ' btn-filled' : '') +
          '" onclick="setWorkerRange(\'' + r + '\')">' +
          ({ week: 'This week', lastweek: 'Last week', month: 'This month', all: 'All time' })[r] +
          '</button>').join('') +
      '</div>' +

      '<div class="wk-cards">' +
        wkCard('Paid', fmtDur(paid), 'what they worked') +
        wkCard('Billable', fmtDur(bill), 'chargeable to customers') +
        wkCard('Wages', money(owed), 'approved only', 'accent-top') +
      '</div>' +

      whereItWentHtml(approved) +

      (waiting.length
        ? '<div class="wk-waiting">' + waiting.length + ' shift' + (waiting.length === 1 ? '' : 's') +
          ' waiting for approval — ' + fmtDur(waiting.reduce((s, e) => s + paidMs(e), 0)) +
          ', not counted above.</div>'
        : '') +

      '<div class="wk-head">Every shift</div>' +
      (inRange.length
        ? '<div class="table-wrap"><table><thead><tr><th>When</th><th>What</th>' +
          '<th>Paid</th><th>Billable</th><th></th></tr></thead><tbody>' +
          inRange.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
            .map(e => shiftRow(e)).join('') +
          '</tbody></table></div>'
        : '<p class="empty-msg">Nothing in this range.</p>');
  }

  function wkCard(label, value, sub, cls) {
    return '<div class="wk-card ' + (cls || '') + '">' +
      '<div class="wk-card-label">' + label + '</div>' +
      '<div class="wk-card-value">' + value + '</div>' +
      '<div class="wk-card-sub">' + sub + '</div></div>';
  }

  function shiftRow(e) {
    const pause = pausedMs(e);
    const when = new Date(e.startedAt);
    return '<tr class="shift-' + e.status + '">' +
      '<td>' + when.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }) +
        '<span class="shift-time">' + clockTime(e.startedAt) +
        (e.endedAt ? '–' + clockTime(e.endedAt) : ' — still on') + '</span></td>' +
      '<td class="bold">' + esc(e.targetName) +
        (pause ? '<span class="shift-pause">' + fmtDur(pause) + ' paused</span>' : '') + '</td>' +
      '<td>' + fmtDur(paidMs(e)) + '</td>' +
      '<td>' + (canPause(e) ? fmtDur(billableMs(e)) : '—') + '</td>' +
      '<td><span class="shift-flag ' + e.status + '">' +
        (running(e) ? 'on the clock'
          : e.status === 'ok' ? 'counted'
          : e.status === 'approved' ? 'approved'
          : e.status === 'rejected' ? 'rejected'
          : 'waiting') + '</span></td>' +
    '</tr>';
  }

  // Name and rate are edited on the worker's own page, in real fields.
  //
  // The name matters because Google hands over whatever the person happens to
  // have on their account -- an email prefix, a nickname, sometimes nothing --
  // and that string is what ends up beside their hours on every screen. It has
  // to be changeable to whatever they are actually called.

  let editingWorker = false;

  window.editWorker = function () { editingWorker = true; renderWorker(); };
  window.cancelWorkerEdit = function () { editingWorker = false; renderWorker(); };

  window.saveWorkerEdit = function () {
    if (!isOwner() || !workerUid) return;
    const name = ((el('wkName') || {}).value || '').trim();
    const raw = ((el('wkRate') || {}).value || '').replace(/[^0-9.]/g, '');
    const cents = Math.round(parseFloat(raw) * 100);

    if (!name) { showToast('Give them a name'); return; }
    if (!(cents > 0)) { showToast('That hourly rate does not look right'); return; }

    const patch = { name: name, rateCents: cents };
    people[workerUid] = Object.assign({}, people[workerUid], patch);

    // The name is copied onto each shift when it is created, so changing it
    // here would otherwise leave every past shift showing the old one. Only
    // unapproved shifts are touched: an approved shift is a payroll record and
    // is left exactly as it was agreed.
    Object.keys(entries).forEach(id => {
      const e = entries[id];
      if (e.uid !== workerUid || e.status === 'approved') return;
      e.workerName = name;
      write(id, { workerName: name }, 'renaming shift');
    });

    editingWorker = false;
    render();
    Promise.resolve(window.YDDb.put('users', workerUid, patch))
      .catch(e => console.warn('[clock] worker not saved:', e.code || e.message));
    showToast('Saved — ' + name + ' at ' + money(cents) + '/hr');
  };

  // Kept so the rate button in the weekly totals still works; it opens the
  // page rather than a browser prompt.
  window.setWorkerRate = function (uid) {
    openWorker(uid);
    editingWorker = true;
    renderWorker();
  };

  // ------------------------------------------------- what other screens ask

  // Approved hours only. Pending time is deliberately excluded from anything
  // that feeds money: a job whose profit moves on its own when a shift is
  // later rejected is a job whose numbers nobody trusts.
  function forJob(jobId) {
    const out = { byWorker: {}, paidHours: 0, billableHours: 0, costCents: 0, pendingHours: 0 };
    if (!jobId) return out;
    Object.values(entries).forEach(e => {
      if (e.kind !== 'job' || e.targetId !== jobId) return;
      if (awaitingOwner(e)) { out.pendingHours += hours(paidMs(e)); return; }
      if (!counts(e)) return;
      const p = e.paidHours != null ? e.paidHours : hours(paidMs(e));
      const b = e.billableHours != null ? e.billableHours : hours(billableMs(e));
      const w = out.byWorker[e.workerName] = out.byWorker[e.workerName] || { paid: 0, billable: 0 };
      w.paid += p; w.billable += b;
      out.paidHours += p; out.billableHours += b;
      out.costCents += e.costCents != null ? e.costCents
        : costOf(paidMs(e), e.rateCents || rateOf(e.uid));
    });
    out.paidHours = Math.round(out.paidHours * 100) / 100;
    out.billableHours = Math.round(out.billableHours * 100) / 100;
    out.pendingHours = Math.round(out.pendingHours * 100) / 100;
    return out;
  }

  // Minutes a storm's crew were paused while inside one stop's window. The
  // snow billing subtracts this so a fuel stop during a driveway comes off
  // that customer's labour line, and one between driveways comes off nobody's.
  function pausedMinutesAt(stormId, fromIso, toIso) {
    const lo = ms(fromIso), hi = ms(toIso);
    if (!(lo && hi && hi > lo)) return 0;
    let worst = 0;
    Object.values(entries).forEach(e => {
      if (e.kind !== 'storm' || e.targetId !== stormId) return;
      // The longest single person's pause, not the sum: if two crew stop for
      // fuel together that is one interruption to the customer's service, not
      // two.
      worst = Math.max(worst, pausedMs(e, lo, hi));
    });
    return Math.round(worst / 60000);
  }

  window.YDClock = {
    forJob: forJob,
    pausedMinutesAt: pausedMinutesAt,
    entries: () => entries,
    render: render,
  };

  // ---------------------------------------------------------------- loading

  function start(owner) {
    if (!window.YDDb) return;

    const u = me();
    if (!u) return;

    // Rebuild whenever the account or the role changes, rather than only on a
    // first run. A crew member reads their shifts through a filtered query and
    // an owner reads the whole collection; keeping the first set of watches
    // after a promotion would leave an owner looking at one person's hours and
    // wondering where everyone else went.
    const key = u.uid + ':' + (owner ? 'owner' : 'crew');
    if (watchKey === key) return;
    unsub.forEach(fn => { try { fn(); } catch (e) {} });
    unsub = [];
    entries = {}; board = {}; people = {};
    watchKey = key;

    const onEntries = changes => {
      changes.forEach(c => {
        if (c.type === 'removed') delete entries[c.id];
        else entries[c.id] = Object.assign({ id: c.id }, c.data);
      });
      stampUnpriced();
      render();
      if (typeof refreshJobLabour === 'function') refreshJobLabour();
    };
    const onEntriesError = err => {
      if (err && err.code === 'permission-denied') {
        console.error('[clock] cannot read time entries');
        showToast('Your hours could not be loaded');
      }
      render();
    };

    // A crew member may read only their own shifts, so they must ask only for
    // their own -- Firestore refuses a whole-collection read outright when the
    // rules could not have permitted every row in it.
    unsub.push(owner
      ? window.YDDb.watch('timeEntries', onEntries, onEntriesError)
      : window.YDDb.watchWhere('timeEntries', 'uid', u.uid, onEntries, onEntriesError));

    unsub.push(window.YDDb.watch('jobBoard', changes => {
      changes.forEach(c => {
        if (c.type === 'removed') delete board[c.id];
        else board[c.id] = Object.assign({ id: c.id }, c.data);
      });
      render();
    }, () => render()));

    if (owner) {
      unsub.push(window.YDDb.watch('users', changes => {
        changes.forEach(c => {
          if (c.type === 'removed') delete people[c.id];
          else people[c.id] = Object.assign({ uid: c.id }, c.data);
        });
        render();
      }, () => render()));
    }
  }

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const owner = a.isOwner === true;
    ['clockOnNowSection', 'clockApproveSection', 'clockCrewSection', 'clockTotalsSection'].forEach(id => {
      const s = el(id); if (s) s.hidden = !owner;
    });
    const tab = el('tabClock');
    if (tab) tab.hidden = !(a.mode === 'cloud' && a.user);
    if (a.mode === 'cloud' && a.user) {
      start(owner);
    } else if (watchKey) {
      // Signed out. Drop the watches and the data with them, so nothing of one
      // person's is still on screen when the next one signs in.
      unsub.forEach(fn => { try { fn(); } catch (e) {} });
      unsub = []; watchKey = null;
      entries = {}; board = {}; people = {};
      render();
    }
  });

  function boot() { render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
