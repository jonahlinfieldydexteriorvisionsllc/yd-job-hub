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
  let people = {};       // uid -> user record (owner and admins; crew get their own)
  // uid -> hourly rate in cents, from payRates/{uid}. Kept apart from the user
  // record because admins read user records (for names) and Firestore cannot
  // hide one field of a document -- so a rate there was readable by anyone
  // allowed to see the crew list.
  let rates = {};
  let ratesLoaded = false;
  // Whether the server answered for payRates at all: true once the security
  // rules that know about rates (and admins) are published. Until then rates
  // are saved where they always were, and nobody can be made an admin -- the
  // old rules would lock an admin out of everything.
  let newRulesLive = false;
  let unsub = [];
  let watchKey = null;   // uid + role the current watches were built for
  let ticker = null;     // redraws the running clock every second
  let picking = false;   // job picker open
  let pausingId = null;  // shift whose reason buttons are showing
  let clockingFor = null; // owner clocking somebody else in
  let usersLoaded = false; // owner: worker list (and so their rates) has arrived

  const el = id => document.getElementById(id);
  const nowIso = () => new Date().toISOString();
  const ms = iso => (iso ? new Date(iso).getTime() : 0);
  const me = () => (window.YDAuth && window.YDAuth.user) || null;
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  // Everyone's hours and pay are for the owner and for an admin given "Crew
  // hours & pay"; crew see only their own.
  const seesAll = () => ydCan('hours', 'see');
  const decides = () => ydCan('hours', 'change');
  // Nobody settles their own pay: an admin may approve other people's shifts
  // but never their own. firestore.rules says the same.
  const mayDecide = e => !!e && decides() && (isOwner() || e.uid !== (me() || {}).uid);

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
  // The rate on the user record is the old place for it, read until the move
  // to payRates has happened (see moveRates).
  const rateOf = uid => rates[uid] || ((people[uid] || {}).rateCents) || DEFAULT_RATE_CENTS;

  // The name a person goes by. The owner renames people on Your Crew and on
  // their own page, and both write it to the person's user record -- so it is
  // read from there whenever it is known, and the name stamped on a shift when
  // it was made is only the fallback. A rename then shows on every shift at
  // once, both ways of renaming agree, and no shift is rewritten to do it.
  function whoIs(uid, stamped) {
    const p = people[uid];
    return (p && p.name) || stamped || (p && p.email) || 'Worker';
  }
  const workerOf = e => whoIs(e.uid, e.workerName);

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
    if (!targetName) targetName = nameFor(kind, targetId);
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
      // The name the owner gave them, not whatever their Google account says.
      workerName: whoIs(forUid, forUid === u.uid ? (u.displayName || u.email || 'Me') : ''),
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
    // The forgotten-shift form is drawn in the same place and takes priority,
    // so left open it would hide the picker that was just asked for.
    addingShift = false; addFor = null;
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

  // Each choice carries only its kind and id; the name is looked up when the
  // shift is sent. Carrying the name too, split on '|', cut short any job whose
  // name had a '|' in it.
  function targetOptions() {
    const jobs = Object.keys(board).map(id => Object.assign({ id: id }, board[id]))
      .filter(j => j.status !== 'complete')
      .sort((a, b) => String(a.name).localeCompare(b.name));
    return '<option value="labor|labor">Labor</option>' +
      '<option value="snow|snow">Snow</option>' +
      '<option value="receipts|receipts">Receipts</option>' +
      jobs.map(j => '<option value="job|' + esc(j.id) + '">' + esc(j.name) + '</option>').join('');
  }

  function addShiftHtml() {
    const today = new Date();
    const iso = d => d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());

    return '<div class="addshift">' +
      '<p class="clock-lead">A shift you forgot to clock in for</p>' +
      '<div class="field"><span class="label">What were you on?</span>' +
        '<select id="asTarget" class="searchable">' + targetOptions() + '</select></div>' +
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

    // Split at the first '|' only: everything after it is the id.
    const target = (el('asTarget') || {}).value || '';
    const cut = target.indexOf('|');
    const kind = cut > 0 ? target.slice(0, cut) : '';
    const targetId = cut > 0 ? target.slice(cut + 1) : '';
    const day = (el('asDate') || {}).value;
    const from = (el('asFrom') || {}).value;
    const to = (el('asTo') || {}).value;
    const why = ((el('asWhy') || {}).value || '').trim();

    if (!kind || !targetId) { showToast('Pick what you were working on'); return; }
    if (!day || !from || !to) { showToast('Fill in the day and both times'); return; }

    const startMs = new Date(day + 'T' + from).getTime();
    let endMs = new Date(day + 'T' + to).getTime();
    if (!startMs || !endMs) { showToast('Those times did not make sense'); return; }
    // The same time twice is a slip, not a shift. Read as running past
    // midnight it became a 24-hour day sent to the office as a real one.
    if (endMs === startMs) { showToast('It finished the minute it started? Check the times'); return; }
    // Finished before it started means it ran past midnight. The next day is
    // worked out on the calendar, not by adding 24 hours, which is an hour out
    // on the two nights a year the clocks change.
    if (endMs <= startMs) {
      const next = new Date(day + 'T' + to);
      next.setDate(next.getDate() + 1);
      endMs = next.getTime();
    }

    if (endMs - startMs > 25 * 3600000) { showToast('That is longer than a day'); return; }
    // The END has to be in the past too -- a shift typed in at noon cannot
    // finish at five tonight.
    if (startMs > Date.now() + 60000 || endMs > Date.now() + 60000) {
      showToast('That is in the future'); return;
    }

    const targetName = nameFor(kind, targetId);
    const id = 'te' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    const rec = {
      uid: forUid,
      workerName: whoIs(forUid, forUid === u.uid ? (u.displayName || u.email || 'Me') : ''),
      kind: kind, targetId: targetId, targetName: targetName,
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
    showToast('Sent in — ' + fmtDur(endMs - startMs) + ' on ' + targetName);
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
    e.pauses = e.pauses || [];
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
    // Always an array. Firestore refuses a write containing undefined and
    // fails the whole thing with it, so a shift that somehow had no pauses
    // list could not be clocked out at all.
    e.pauses = e.pauses || [];
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
    // Nor while a change is being asked for (the same reason).
    if (workerUid && !editingWorker && !asking
        && el('workerModal') && el('workerModal').classList.contains('active')) renderWorker();
    if (seesAll()) { renderOnNow(); renderApprovals(); renderTotals(); }
    if (isOwner()) renderCrew();
    manageTicker();
  }
  window.renderClock = render;

  // A running clock only needs redrawing while it is actually on screen and
  // actually running -- and only the parts with a running time in them. The
  // approvals, the crew list and the wages table do not change from one second
  // to the next, and rebuilding all of them every second made the owner's
  // screen sluggish on a phone for no visible gain.
  function manageTicker() {
    const visible = el('panel-clock') && el('panel-clock').classList.contains('active');
    const live = Object.values(entries).some(running);
    if (visible && live && !ticker) ticker = setInterval(tick, 1000);
    if ((!visible || !live) && ticker) { clearInterval(ticker); ticker = null; }
  }
  // Each second only the running times change, so only their text is touched.
  // Rebuilding the cards instead wiped the "forgot to clock in" form a second
  // after it was opened, and swapped the Pause and Clock out buttons out from
  // under a gloved thumb mid-tap.
  function tick() {
    document.querySelectorAll('[data-live-entry]').forEach(n => {
      const e = entries[n.dataset.liveEntry];
      if (e && running(e)) n.textContent = fmtDur(paidMs(e));
    });
    manageTicker();
  }

  function renderClockCard() {
    const wrap = el('clockWrap');
    if (!wrap) return;
    const shift = myOpenShift();

    const badge = el('clockBadge');
    if (badge) badge.textContent = shift ? (openPause(shift) ? 'Paused' : 'On the clock') : '';

    if (addingShift) {
      // Built once, then left alone. The clock redraws on every change from
      // the database -- another crew member pausing, a job being saved -- and
      // rebuilding this form each time wiped the times and the reason while
      // they were being typed. Only the list of jobs is brought up to date,
      // and not while it is open, so a job that arrives after the form was
      // opened can still be picked.
      const sel = el('asTarget');
      if (!sel) { wrap.innerHTML = addShiftHtml(); return; }
      if (document.activeElement !== sel) {
        const keep = sel.value;
        sel.innerHTML = targetOptions();
        sel.value = keep;
        if (sel.selectedIndex < 0) sel.selectedIndex = 0;   // that job has gone
      }
      return;
    }
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
      '<div class="clock-elapsed" data-live-entry="' + safeId(e.id) + '">' + fmtDur(paid) + '</div>' +
      '<div class="clock-sub">in at ' + clockTime(e.startedAt) +
        (pausedMs(e) ? ' · ' + fmtDur(pausedMs(e)) + ' paused · ' + fmtDur(bill) + ' billable' : '') +
      '</div>' +
      (p ? '<div class="clock-pausenote">Paused for ' + esc(p.reason) +
             ' — still being paid, not billed to the customer.</div>' : '') +
      (pausingId === e.id
        ? '<div class="pause-reasons"><p class="clock-lead">What for?</p>' +
            PAUSE_REASONS.map(r =>
              '<button class="btn" onclick="pauseClock(\'' + safeId(e.id) + '\', \'' + r.replace(/'/g, "\\'") + '\')">' +
              r + '</button>').join('') +
            '<button class="btn btn-sm" onclick="cancelPause()">Never mind</button>' +
          '</div>'
        : '<div class="clock-actions">' +
            (canPause(e)
              ? (p
                  ? '<button class="btn btn-filled clock-big" onclick="resumeClock(\'' + safeId(e.id) + '\')">Back on</button>'
                  : '<button class="btn btn-accent clock-big" onclick="askPause(\'' + safeId(e.id) + '\')">Pause</button>')
              : '') +
            '<button class="btn clock-big" onclick="clockOut(\'' + safeId(e.id) + '\')">Clock out</button>' +
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
        // A storm is only somewhere to go back to while it is still running;
        // otherwise this would clock someone into last week's storm.
        if (e.kind === 'storm') {
          const s = window.YDStorm && YDStorm.current();
          if (!s || s.id !== e.targetId || s.status !== 'open') return;
        }
        seen[key] = 1; out.push(e);
      });
    if (!out.length) return '';
    return '<div class="clock-recent"><p class="clock-lead">Back to where you were</p>' +
      out.map(e => '<button class="btn" onclick="clockInTo(\'' + safeId(e.kind) + '\', \'' +
        safeId(e.targetId) + '\')">' + esc(e.targetName) + '</button>').join('') + '</div>';
  }

  // Ids go into onclick handlers, and some of them come from crew phones. Only
  // the characters our own ids are made of get through; anything else could
  // close the string and run as code on the owner's screen.
  function safeId(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, ''); }

  // The name shown on a shift, looked up from the id when the button is tapped
  // rather than written into the button -- a job called O'Brien used to end the
  // handler's text at the apostrophe and the button did nothing.
  function nameFor(kind, id) {
    if (kind === 'job') return (board[id] && board[id].name) || 'Job';
    if (kind === 'storm') return 'Tonight’s storm';
    return OVERHEAD_LABEL[kind] || 'Other';
  }

  function pickerHtml() {
    const storm = window.YDStorm && YDStorm.current();
    const stormOpen = storm && storm.status === 'open';

    // Snow points at the open storm when there is one, so its pauses land on
    // the right customer's invoice. With no storm running it is still snow
    // work -- loading salt, fixing a plow -- but it belongs to no customer, so
    // it is booked as the business's own time like the other two.
    // Says whose clock this is when the owner is starting somebody else's, so
    // it cannot be mistaken for clocking himself in.
    const lead = clockingFor && clockingFor !== ((me() || {}).uid)
      ? 'What is ' + esc(whoIs(clockingFor)) + ' working on?'
      : 'What are you working on?';
    return '<div class="picker">' +
      '<p class="clock-lead">' + lead + '</p>' +
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
    return '<button class="picker-kind ' + cls + '" onclick="clockInTo(\'' + safeId(kind) + '\', \'' +
      safeId(id) + '\')">' +
      '<span class="kind-icon">' + icon + '</span>' + label + '</button>';
  }

  // Only the list is redrawn, never the whole picker. Rebuilding the picker
  // would replace the search box itself, and the field would lose focus after
  // every single character typed.
  window.filterJobPicker = function () {
    const list = el('pickerList');
    if (list) list.innerHTML = pickerList();
  };

  // Jobs being worked on come first: in progress, then booked.
  const isLive = s => s === 'inprogress' || s === 'booked' || s === 'active';
  const rank = j => j.status === 'inprogress' || j.status === 'active' ? 0 : j.status === 'booked' ? 1
    : j.status === 'complete' ? 3 : 2;

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
      : jobs.filter(j => isLive(j.status))
            .sort((a, b) => String(a.name).localeCompare(b.name));

    if (!list.length) {
      return '<p class="empty-msg">' + (search ? 'No job matches that.'
        : 'No booked or in-progress jobs. Search above for a quoted or finished one.') + '</p>';
    }
    return list.map(j =>
      '<button class="picker-job" onclick="clockInTo(\'job\', \'' + safeId(j.id) + '\')">' +
        '<span class="picker-name">' + esc(j.name) + '</span>' +
        (j.address ? '<span class="picker-addr">' + esc(j.address) + '</span>' : '') +
        '<span class="picker-flag ' + esc(j.status || '') + '">' +
          esc(typeof statusLabel === 'function' ? statusLabel(j.status) : (j.status || 'job')) + '</span>' +
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
            '<button class="on-who linkish" onclick="openWorker(\'' + safeId(e.uid) + '\')">' +
              esc(workerOf(e)) + '</button>' +
            '<span class="on-where">' + esc(e.targetName) + '</span>' +
            '<span class="on-time"><span data-live-entry="' + safeId(e.id) + '">' + fmtDur(paidMs(e)) + '</span>' +
              (p ? ' · paused (' + esc(p.reason) + ')' : '') + '</span>' +
            (mayDecide(e) || e.uid === (me() || {}).uid
              ? '<button class="btn btn-sm" onclick="clockOut(\'' + safeId(e.id) + '\')">Clock out</button>' : '') +
          '</div>';
        }).join('')
      : '<p class="empty-msg">Nobody is on the clock.</p>') +
      // Clocking other people in and out is changing their hours.
      (!decides() ? ''
        : choosingWorker ? workerChooserHtml()
        : '<div class="field-actions"><button class="btn btn-sm" onclick="pickWorkerToClockIn()">Clock somebody in</button></div>');
  }

  // Their phone is dead, or they forgot. The entry records who actually
  // created it, so this is never mistaken for the person's own clock-in.
  //
  // A list of names to tap, drawn where the button was. It used to be a
  // browser prompt asking for a number from a numbered list, which on a phone
  // meant reading the list, closing it in your head and typing a digit.
  let choosingWorker = false;

  // Anyone who works: crew, and admins (who clock in like everyone else).
  // Not the person doing the clocking -- an admin may not set their own hours
  // this way, and the owner clocks themself in from the card at the top.
  function crewToClockIn() {
    const mine = (me() || {}).uid;
    return Object.keys(people)
      .filter(uid => (people[uid].role === 'crew' || people[uid].role === 'admin') &&
        people[uid].active && uid !== mine)
      .sort((a, b) => whoIs(a).localeCompare(whoIs(b)));
  }

  function workerChooserHtml() {
    const crew = crewToClockIn();
    return '<div class="picker">' +
      '<p class="clock-lead">Clock in who?</p>' +
      crew.map(uid => {
        const on = Object.values(entries).find(e => e.uid === uid && running(e));
        return '<button class="picker-job" onclick="clockInWorker(\'' + safeId(uid) + '\')">' +
          '<span class="picker-name">' + esc(whoIs(uid)) + '</span>' +
          '<span class="picker-addr">' + (on
            ? 'On the clock at ' + esc(on.targetName) + ' — this moves them'
            : esc(people[uid].email || '')) + '</span>' +
        '</button>';
      }).join('') +
      '<button class="btn btn-sm" onclick="cancelPickWorker()">Cancel</button>' +
    '</div>';
  }

  window.pickWorkerToClockIn = function () {
    if (!crewToClockIn().length) { showToast('No crew members approved yet'); return; }
    choosingWorker = true;
    renderOnNow();
  };
  window.cancelPickWorker = function () { choosingWorker = false; renderOnNow(); };

  // The job picker opens in the clock card at the top of the screen, which on
  // a phone is out of sight from here -- so it is brought into view.
  window.clockInWorker = function (uid) {
    if (!people[uid]) return;
    choosingWorker = false;
    openJobPicker(uid);
    const card = el('clockWrap');
    if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  function renderApprovals() {
    const wrap = el('approveWrap');
    if (!wrap) return;
    const waiting = Object.values(entries).filter(awaitingOwner)
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const asked = requestsHtml();
    const nAsked = isOwner() ? Object.values(requests).filter(r => r.status === 'pending' && ASKABLE.indexOf(r.type) !== -1).length : 0;
    const badge = el('approveBadge');
    if (badge) badge.textContent = waiting.length + nAsked ? (waiting.length + nAsked) + ' waiting' : '';
    const sec = el('clockApproveSection');
    if (sec) sec.hidden = false;

    if (!waiting.length && !nAsked) {
      wrap.innerHTML = '<p class="empty-msg">Nothing waiting. Ordinary clocked shifts ' +
        'go through on their own — only shifts typed in by hand, or longer than ' +
        LONG_SHIFT_HOURS + ' hours, land here, and changes the crew ask for.</p>';
      return;
    }
    wrap.innerHTML = asked + waiting.map(e => {
      // Chargeable, not merely unpaused: a long Labor day is not billable to
      // anybody, however few pauses it had.
      const paid = paidMs(e), bill = chargeableMs(e), pause = pausedMs(e);
      return '<div class="appr">' +
        '<div class="appr-top">' +
          '<button class="appr-who linkish" onclick="openWorker(\'' + safeId(e.uid) + '\')">' +
            esc(workerOf(e)) + '</button>' +
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
          (canPause(e)
            ? '<span><strong>' + fmtDur(bill) + '</strong> billable</span>'
            : '<span>not billable</span>') +
          '<span class="appr-cost">' + money(costOf(paid, rateOf(e.uid))) + '</span>' +
        '</div>' +
        ((e.pauses || []).length
          ? '<div class="appr-pauses">' + e.pauses.map(p =>
              esc(p.reason) + ' ' + fmtDur(Math.max(0, (p.endedAt ? ms(p.endedAt) : Date.now()) - ms(p.startedAt)))
            ).join(' · ') + '</div>'
          : '') +
        (mayDecide(e)
          ? '<div class="appr-act">' +
              '<button class="btn btn-filled btn-sm" onclick="approveShift(\'' + safeId(e.id) + '\')">Approve</button>' +
              '<button class="btn btn-sm" onclick="rejectShift(\'' + safeId(e.id) + '\')">Reject</button>' +
            '</div>'
          : '<div class="appr-act muted">' + (decides() ? 'Your own shift — the owner approves it' : 'Waiting for the owner') + '</div>') +
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
    // Not until the worker list has arrived. The shifts often load first, and
    // stamping then froze every settled shift at the default rate for good --
    // a $30/hr worker's night recorded at $25.
    if (!decides() || !window.YDDb || !usersLoaded || !ratesLoaded) return;
    Object.keys(entries).forEach(id => {
      const e = entries[id];
      if (!counts(e) || running(e) || e.rateCents != null) return;
      // An admin never prices their own shifts; the owner's device does.
      if (!mayDecide(e)) return;
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
    if (!mayDecide(e)) return;
    const patch = {
      status: 'approved',
      rateCents: rateOf(e.uid),
      paidHours: hours(paidMs(e)),
      // Chargeable, the same figure a self-settled shift is stamped with: a
      // Labor or Receipts shift is never billable, however it was approved.
      billableHours: hours(chargeableMs(e)),
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
    showToast('Approved — ' + fmtDur(paidMs(e)) + ' for ' + workerOf(e));
  };

  window.rejectShift = function (id) {
    const e = entries[id];
    if (!mayDecide(e)) return;
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
    const active = all.filter(u => (u.role === 'crew' || u.role === 'admin') && u.active);

    const badge = el('crewBadge');
    if (badge) badge.textContent = waiting.filter(u => u.role === 'pending').length
      ? waiting.filter(u => u.role === 'pending').length + ' asking to join' : '';

    // The owner's own row comes first, so their name can be changed too.
    const meRec = people[(me() || {}).uid];
    wrap.innerHTML =
      (meRec
        ? '<div class="crew-row">' +
            '<span class="crew-name">' + esc(meRec.name || meRec.email) + ' <span class="crew-mail">(you)</span></span>' +
            '<span class="crew-mail">' + esc(meRec.email || '') + '</span>' +
            '<button class="btn btn-sm" onclick="renameWorker(\'' + safeId(meRec.uid) + '\')">Rename</button>' +
          '</div>'
        : '') +
      (waiting.length
        ? waiting.map(u => '<div class="crew-row waiting">' +
            '<span class="crew-name">' + esc(u.name || u.email) + '</span>' +
            '<span class="crew-mail">' + esc(u.email) + '</span>' +
            '<span class="crew-state">' + (u.role === 'pending' ? 'wants access'
              : u.role === 'denied' ? 'refused' : 'switched off') + '</span>' +
            // Somebody refused is not offered the same filled-in button as a
            // crew member switched off for the winter: theirs is plain, and
            // asks before letting them in.
            '<button class="btn btn-sm' + (u.role === 'denied' ? '' : ' btn-filled') +
              '" onclick="approveCrew(\'' + safeId(u.uid) + '\')">' +
              (u.role === 'pending' ? 'Let them in'
                : u.role === 'denied' ? 'Let them in after all…' : 'Switch back on') + '</button>' +
            (u.role === 'pending'
              ? '<button class="btn btn-sm" onclick="denyCrew(\'' + safeId(u.uid) + '\')">Not them</button>' : '') +
          '</div>').join('')
        : '') +
      (active.length
        ? active.map(u => '<div class="crew-row">' +
            '<button class="crew-name linkish" onclick="openWorker(\'' + safeId(u.uid) + '\')">' +
              esc(u.name || u.email) + '</button>' +
            (u.role === 'admin' ? '<span class="crew-admin">admin</span>' : '') +
            '<span class="crew-mail">' + esc(u.email) + '</span>' +
            '<button class="btn btn-sm" onclick="openAccess(\'' + safeId(u.uid) + '\')">' +
              (u.role === 'admin' ? 'Access' : 'Make admin…') + '</button>' +
            '<button class="btn btn-sm" onclick="renameWorker(\'' + safeId(u.uid) + '\')">Rename</button>' +
            '<button class="btn btn-sm" onclick="setWorkerRate(\'' + safeId(u.uid) + '\')">' +
              money(rateOf(u.uid)) + '/hr</button>' +
            '<button class="remove-btn" onclick="removeCrew(\'' + safeId(u.uid) + '\')" title="Switch off">&times;</button>' +
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

  // The name shown everywhere -- the clock, the work log, boards, calendars.
  // It starts as whatever the person's Google account is called, which is
  // often a nickname or an email address.
  window.renameWorker = function (uid) {
    const u = people[uid];
    if (!u || !isOwner()) return;
    const now = u.name || u.email || '';
    const name = prompt('What should ' + (now || 'this person') + ' be called in Job Hub?', now);
    if (name === null) return;
    const clean = name.trim().slice(0, 60);
    if (!clean) { showToast('A name cannot be blank'); return; }
    setRole(uid, { name: clean }, 'Renamed to ' + clean);
  };

  window.approveCrew = function (uid) {
    const u = people[uid];
    if (!u) return;
    const who = u.name || u.email;
    // Letting in somebody already turned away is done on purpose or not at
    // all. Their row sits among people asking to join, and one stray tap on
    // it used to hand crew access to the very person who had been refused.
    if (u.role === 'denied' && !confirm('Let ' + who + (u.name && u.email ? ' (' + u.email + ')' : '') +
        ' in after all?\n\nYou refused them before. They will be able to sign in, ' +
        'clock in and see the crew side of Job Hub.')) return;
    // Switching someone back on keeps what they were: an admin switched off
    // for the winter comes back an admin, with the same access.
    if (u.role === 'admin' || u.role === 'crew') setRole(uid, { active: true }, who + ' switched back on');
    else setRole(uid, { role: 'crew', active: true }, who + ' can now clock in');
  };

  // Denied, not deleted: the record is the audit trail of who asked, and the
  // rules forbid deleting user records outright.
  window.denyCrew = function (uid) {
    const u = people[uid];
    if (!u || !confirm('Refuse access for ' + (u.email) + '?')) return;
    setRole(uid, { role: 'denied', active: false }, 'Refused');
  };

  // ------------------------------------------------------- admins and access
  //
  // An admin is someone who helps run the business: they clock in like crew,
  // and the owner picks, area by area, whether they see nothing, can look, or
  // can change things. The same table is enforced in firestore.rules; this
  // is only the form for setting it.
  //
  // Never shared with anyone, whatever is ticked here: who gets in and what
  // they may do, the owner's Personal calendar, the QuickBooks connection,
  // and the Problems screen.
  const AREAS = [
    { id: 'jobs', label: 'Jobs & bids', hint: 'Job, Tracking and All Jobs; the Bids and Jobs boards; materials bought' },
    { id: 'snow', label: 'Snow', hint: 'Snow accounts and their prices; starting and running storms' },
    { id: 'billing', label: 'Billing', hint: 'Storm bills, invoices, season reports; sending to QuickBooks. Closing a storm also needs Crew hours & pay: See' },
    { id: 'hours', label: 'Crew hours & pay', hint: 'Everyone’s shifts and pay rates; approving shifts (never their own)' },
    { id: 'calendars', label: 'Calendars', hint: 'Every shared calendar — never your Personal one' },
    { id: 'boards', label: 'Boards', hint: 'Every board and card, not only those shared with them' },
    { id: 'supplies', label: 'Supplies & prices', hint: 'What things cost; adding and editing supplies' },
    { id: 'equipment', label: 'Equipment', hint: 'Machines, services and problems' },
    { id: 'contacts', label: 'Contacts', hint: 'People to call next season' },
  ];
  const LEVEL_WORDS = { none: 'Off', see: 'See', change: 'Change' };
  let accessUid = null;

  window.openAccess = function (uid) {
    if (!isOwner() || !people[uid]) return;
    accessUid = uid;
    renderAccess();
    const m = el('accessModal');
    if (m) m.classList.add('active');
  };
  window.closeAccess = function () {
    const m = el('accessModal');
    if (m) m.classList.remove('active');
    accessUid = null;
  };

  function renderAccess() {
    const body = el('accessBody'), u = people[accessUid];
    if (!body || !u) return;
    const isAdmin = u.role === 'admin';
    const acc = (isAdmin && u.access) || {};
    const title = el('accessTitle');
    if (title) title.textContent = (u.name || u.email) + (isAdmin ? ' — admin' : '');
    body.innerHTML =
      '<p class="acc-lead">' + (isAdmin
        ? 'Pick what ' + esc(u.name || u.email) + ' can do in each part of Job Hub. They always keep their own clock and the crew screens.'
        : esc(u.name || u.email) + ' is crew. As an admin they can also see — or change — the parts of the business you pick below.') + '</p>' +
      '<div class="acc-list">' + AREAS.map(a => {
        const lv = acc[a.id] || 'none';
        return '<div class="acc-row">' +
          '<div class="acc-area"><b>' + esc(a.label) + '</b><small>' + esc(a.hint) + '</small></div>' +
          '<div class="acc-seg" role="radiogroup" aria-label="' + esc(a.label) + '">' +
            ['none', 'see', 'change'].map(l =>
              '<label class="acc-opt' + (l === lv ? ' on' : '') + '"><input type="radio" name="acc-' + a.id + '" value="' + l + '"' +
                (l === lv ? ' checked' : '') + ' onchange="accessPicked(this)">' + LEVEL_WORDS[l] + '</label>').join('') +
          '</div></div>';
      }).join('') + '</div>' +
      '<div class="acc-never">Only you, always: letting people in and setting their access, your Personal calendar, ' +
        'the QuickBooks connection, and the Problems screen.</div>' +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="saveAccess()">' + (isAdmin ? 'Save access' : 'Make them an admin') + '</button>' +
        (isAdmin ? '<button class="btn" onclick="makeCrew()">Back to crew</button>' : '') +
        '<button class="btn btn-sm" onclick="closeAccess()">Cancel</button>' +
      '</div>';
  }

  window.accessPicked = function (input) {
    const seg = input.closest('.acc-seg');
    if (seg) seg.querySelectorAll('.acc-opt').forEach(o => o.classList.toggle('on', o.contains(input)));
  };

  // Every area is written out, 'none' included. The save merges into the
  // stored record, and a map merges key by key -- an area left out would keep
  // whatever it was set to before.
  function accessFromForm() {
    const out = {};
    AREAS.forEach(a => {
      const r = document.querySelector('input[name="acc-' + a.id + '"]:checked');
      out[a.id] = r ? r.value : 'none';
    });
    return out;
  }

  window.saveAccess = function () {
    const u = people[accessUid];
    if (!isOwner() || !u) return;
    if (!newRulesLive) {
      showToast('Not yet — the new security rules have to be published first, or an admin would be locked out of everything');
      return;
    }
    const access = accessFromForm();
    const wasAdmin = u.role === 'admin';
    const any = Object.values(access).some(l => l !== 'none');
    if (!wasAdmin && !confirm('Make ' + (u.name || u.email) + ' an admin?\n\n' +
        (any ? 'They will be able to ' + AREAS.filter(a => access[a.id] !== 'none')
          .map(a => (access[a.id] === 'change' ? 'change ' : 'see ') + a.label.toLowerCase()).join(', ') + '.'
          : 'Nothing is ticked yet, so for now they will have the same screens as crew.'))) return;
    setRole(accessUid, { role: 'admin', access: access },
      (u.name || u.email) + (wasAdmin ? '’s access saved' : ' is now an admin'));
    closeAccess();
  };

  window.makeCrew = function () {
    const u = people[accessUid];
    if (!isOwner() || !u || !confirm('Make ' + (u.name || u.email) + ' crew again?\n\n' +
        'They lose every admin area and keep only their own clock and the crew screens.')) return;
    const none = {};
    AREAS.forEach(a => { none[a.id] = 'none'; });
    setRole(accessUid, { role: 'crew', access: none }, (u.name || u.email) + ' is crew again');
    closeAccess();
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
    const to = which === 'lastweek' ? rangeStart('week') : Infinity;

    const inRange = e => startMsOf(e) >= from && startMsOf(e) < to;
    const done = Object.values(entries).filter(e => counts(e) && inRange(e));
    const pending = Object.values(entries).filter(e => awaitingOwner(e) && inRange(e));

    const byWorker = {};
    done.forEach(e => {
      const w = byWorker[e.uid] = byWorker[e.uid] ||
        { name: workerOf(e), uid: e.uid, paid: 0, bill: 0, cost: 0 };
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
          '<td><button class="btn btn-sm" onclick="setWorkerRate(\'' + safeId(w.uid) + '\')">' +
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
    asking = null;          // a half-asked change closed with × or Escape is let go
    const m = el('workerModal');
    if (m) m.classList.add('active');
    renderWorker();
    // A crew member's own page shows their rate, so their record is read
    // again here: a raise given since they signed in shows the next time they
    // look, not the next time they sign in.
    if (!seesAll()) loadMyRecord();
  };
  window.closeWorker = function () {
    const m = el('workerModal');
    if (m) m.classList.remove('active');
    workerUid = null;
    asking = null;
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
    const to = workerRange === 'lastweek' ? rangeStart('week') : Infinity;
    const inRange = all.filter(e => startMsOf(e) >= from && startMsOf(e) < to);

    const approved = inRange.filter(counts);
    const waiting = inRange.filter(awaitingOwner);
    const live = all.find(running);

    const paid = approved.reduce((s, e) => s + paidMs(e), 0);
    const bill = approved.reduce((s, e) => s + chargeableMs(e), 0);
    const owed = approved.reduce((s, e) => s + (e.costCents != null ? e.costCents
      : costOf(paidMs(e), e.rateCents || rateOf(e.uid))), 0);

    // The owner names people; the owner, or an admin with Crew hours & pay,
    // sets their rate -- though never an admin their own.
    const canName = isOwner();
    const canRate = decides() && (isOwner() || !isMe);
    // Your own page, unless you are the owner: a locked shift can be asked about.
    const askable = isMe && !isOwner();
    body.innerHTML =
      (editingWorker && (canName || canRate)
        ? '<div class="wk-edit">' +
            '<div class="grid g2">' +
              (canName ? '<div class="field"><span class="label">Name</span>' +
                '<input id="wkName" value="' + esc(u.name || '') + '" placeholder="What they go by"></div>' : '') +
              (canRate ? '<div class="field"><span class="label">Hourly rate</span>' +
                '<input id="wkRate" inputmode="decimal" value="' +
                  (rateOf(workerUid) / 100).toFixed(2) + '"></div>' : '') +
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
            (canName || canRate
              ? '<button class="btn btn-sm" onclick="editWorker()">' +
                money(rateOf(workerUid)) + '/hr · Edit</button>'
              : '<span class="wk-rate">' + money(rateOf(workerUid)) + '/hr</span>') +
          '</div>') +

      (live
        ? '<div class="wk-live">On the clock now — <strong>' + esc(live.targetName) +
          '</strong>, <span data-live-entry="' + safeId(live.id) + '">' + fmtDur(paidMs(live)) + '</span>' +
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

      (askable && asking && entries[asking] ? askHtml(entries[asking]) : '') +
      '<div class="wk-head">Every shift</div>' +
      (inRange.length
        ? '<div class="table-wrap"><table><thead><tr><th>When</th><th>What</th>' +
          '<th>Paid</th><th>Billable</th><th></th>' + (askable ? '<th></th>' : '') + '</tr></thead><tbody>' +
          inRange.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
            .map(e => shiftRow(e, askable)).join('') +
          '</tbody></table></div>'
        : '<p class="empty-msg">Nothing in this range.</p>') +
      (askable ? myRequestsHtml(workerUid) : '');
  }

  // ------------------------------------------------------- change requests
  //
  // A shift that has gone through (counted or approved) is locked to the crew.
  // When one is wrong -- clocked out late, forgot to clock in at the shop --
  // they ask for a change (Jonah, 6 Oct 2026: clock times and storm figures;
  // clock times first). It lands in the owner's Waiting for You; approving
  // applies it to the shift, hours and pay worked out again. The requests
  // are kept, not deleted (changeRequests in firestore.rules: crew file and
  // withdraw their own, only the owner decides).
  let requests = {};          // id -> request (the owner's queue, or a crew member's own)
  let asking = null;          // the shift a change is being asked for, on My hours
  const pendingFor = id => Object.values(requests).find(r => r.targetId === id && r.status === 'pending');

  function writeRequest(id, data, what) {
    Promise.resolve(window.YDDb.put('changeRequests', id, data)).catch(err => {
      if (err && err.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[clock] ' + what + ' not yet on the server:', (err && err.code) || err);
    });
  }
  const hm = iso => { const d = new Date(iso); return isNaN(d) ? '' : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  // A time typed for a shift lands on whichever day puts it nearest the time
  // it replaces. A snow shift that ran 11:40 pm to 6 am and should have
  // started at 12:05 starts just after midnight the NEXT day, not 24 hours
  // earlier (the reviewer's case, 7 Oct). An end is then kept after the start
  // and within a day of it.
  function nearTime(ref, time) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
    const at = new Date(ref);
    if (!m || isNaN(at)) return null;
    let best = null;
    [-1, 0, 1].forEach(shift => {
      const d = new Date(at);
      d.setDate(d.getDate() + shift);
      d.setHours(+m[1], +m[2], 0, 0);
      if (!best || Math.abs(d - at) < Math.abs(best - at)) best = d;
    });
    return best;
  }
  function shiftTimes(e, startTime, endTime) {
    const start = nearTime(e.startedAt, startTime);
    let end = start && nearTime(e.endedAt || e.startedAt, endTime);
    if (!start || !end) return null;
    while (end <= start) end.setDate(end.getDate() + 1);
    while (end - start > 24 * 3600000) end.setDate(end.getDate() - 1);
    if (end <= start) return null;
    return { start: start.toISOString(), end: end.toISOString() };
  }
  // "Tue 10/6 11:40 PM" -- a request's times always carry their day, so a
  // change that crosses midnight cannot look like the same day's shift.
  const dayTime = iso => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }) + ' ' + clockTime(iso);
  };
  const spanOf = (a, b) => (ms(b) > ms(a) ? fmtDur(ms(b) - ms(a)) : '');

  function askHtml(e) {
    return '<div class="add-area wk-ask">' +
      '<div class="add-label">Ask for a change to ' + new Date(e.startedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }) +
        ' · ' + esc(e.targetName || '') + ' (' + clockTime(e.startedAt) + '–' + clockTime(e.endedAt) + ')</div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Should have started</span><input type="time" id="crStart" value="' + hm(e.startedAt) + '"></div>' +
        '<div class="field"><span class="label">Should have ended</span><input type="time" id="crEnd" value="' + hm(e.endedAt) + '"></div>' +
      '</div>' +
      '<div class="field"><span class="label">Why</span><input id="crWhy" placeholder="e.g. forgot to clock out at the shop"></div>' +
      '<div class="field-actions"><button class="btn btn-filled btn-sm" onclick="sendRequest()">Send to the office</button>' +
        '<button class="btn btn-sm" onclick="cancelRequest()">Cancel</button></div>' +
    '</div>';
  }
  function myRequestsHtml(uid) {
    const mineR = Object.values(requests).filter(r => r.requestedBy === uid && r.type === 'timeEntry')
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 8);
    if (!mineR.length) return '';
    return '<div class="wk-head">Changes you asked for</div>' + mineR.map(r => '<div class="wk-req ' + esc(r.status) + '">' +
      new Date((r.before || {}).startedAt || r.createdAt).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }) + ': ' +
      clockTime((r.before || {}).startedAt) + '–' + clockTime((r.before || {}).endedAt) + ' → ' +
      clockTime((r.after || {}).startedAt) + '–' + clockTime((r.after || {}).endedAt) + ' · <b>' +
      ({ pending: 'waiting', approved: 'changed', rejected: 'turned down', withdrawn: 'withdrawn' }[r.status] || esc(r.status)) + '</b>' +
      (r.status === 'rejected' && r.decidedReason ? ' — ' + esc(r.decidedReason) : '') +
      (r.status === 'pending' ? ' <button class="link-btn" onclick="withdrawRequest(\'' + safeId(r.id) + '\')">withdraw</button>' : '') +
    '</div>').join('');
  }
  window.askChange = function (id) { asking = id; renderWorker(); };
  window.cancelRequest = function () { asking = null; renderWorker(); };
  window.sendRequest = function () {
    const e = entries[asking], u = me();
    if (!e || !u || e.uid !== u.uid) return;
    const t = shiftTimes(e, (el('crStart') || {}).value, (el('crEnd') || {}).value);
    const start = t && t.start, end = t && t.end;
    const why = ((el('crWhy') || {}).value || '').trim();
    if (!start || !end) { showToast('Put in both times'); return; }
    if (!why) { showToast('Say why, so the office knows'); return; }
    if (start === e.startedAt && end === e.endedAt) { showToast('Those are the times it has now'); return; }
    if (ms(end) - ms(start) > 20 * 3600000) { showToast('That is longer than a day — check the times'); return; }
    const id = 'cr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const rec = { type: 'timeEntry', targetPath: 'timeEntries/' + e.id, targetId: e.id,
      requestedBy: u.uid, requestedByName: whoIs(u.uid), reason: why.slice(0, 300), status: 'pending',
      before: { startedAt: e.startedAt, endedAt: e.endedAt || null },
      after: { startedAt: start, endedAt: end }, createdAt: nowIso() };
    requests[id] = Object.assign({ id: id }, rec);
    asking = null;
    writeRequest(id, rec, 'asking for a change');
    renderWorker();
    showToast('Sent — the office will look at it');
  };
  window.withdrawRequest = function (id) {
    const r = requests[id];
    if (!r || r.status !== 'pending') return;
    r.status = 'withdrawn';
    writeRequest(id, { status: 'withdrawn' }, 'withdrawing a request');
    renderWorker();
  };

  // The owner's side, at the top of Waiting for You: clock times, and the
  // figures on a closed storm's stop (storm.js) -- approving one of those
  // fixes the stop and works that customer's bill out again (billing.js).
  const ASKABLE = ['timeEntry', 'stopFigures'];
  const figure = v => (typeof v === 'number' && isFinite(v) ? v : null);
  function stopRequestHtml(r) {
    const b = r.before || {}, a = r.after || {};
    const bits = [];
    if (figure(a.inchesCleared) !== figure(b.inchesCleared)) bits.push(esc(String(figure(b.inchesCleared) != null ? figure(b.inchesCleared) : '–')) + '" → <b>' + esc(String(figure(a.inchesCleared))) + '"</b>');
    if (figure(a.saltBags) !== figure(b.saltBags)) bits.push(esc(String(figure(b.saltBags) != null ? figure(b.saltBags) : 0)) + ' → <b>' + esc(String(figure(a.saltBags))) + ' bags</b>');
    const storm = window.YDBilling && YDBilling.storms()[r.stormId];
    const day = storm && storm.startedAt ? new Date(storm.startedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }) : 'a storm';
    return '<div class="appr appr-req">' +
      '<div class="appr-top"><b>' + esc(whoIs(r.requestedBy, r.requestedByName)) + '</b> asks to change a storm stop</div>' +
      '<div class="appr-times">❄️ ' + esc(r.accountName || r.accountId || 'A stop') + ' · ' + esc(day) + ': ' + (bits.join(', ') || 'no change') + '</div>' +
      (r.reason ? '<div class="appr-note">“' + esc(r.reason) + '”</div>' : '') +
      '<div class="appr-act"><button class="btn btn-filled btn-sm" onclick="approveRequest(\'' + safeId(r.id) + '\')">Approve — fix the bill</button>' +
        '<button class="btn btn-sm" onclick="rejectRequest(\'' + safeId(r.id) + '\')">Reject</button></div>' +
    '</div>';
  }
  function requestsHtml() {
    if (!isOwner()) return '';
    const list = Object.values(requests).filter(r => r.status === 'pending' && ASKABLE.indexOf(r.type) !== -1)
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    return list.map(r => {
      if (r.type === 'stopFigures') return stopRequestHtml(r);
      const b = r.before || {}, a = r.after || {};
      return '<div class="appr appr-req">' +
        '<div class="appr-top"><b>' + esc(whoIs(r.requestedBy, r.requestedByName)) + '</b> asks to change a shift</div>' +
        '<div class="appr-times">Now: ' + dayTime(b.startedAt) + ' – ' + dayTime(b.endedAt) +
          (spanOf(b.startedAt, b.endedAt) ? ' (' + spanOf(b.startedAt, b.endedAt) + ')' : '') + '<br>' +
          'Asks for: <b>' + dayTime(a.startedAt) + ' – ' + dayTime(a.endedAt) +
          (spanOf(a.startedAt, a.endedAt) ? ' (' + spanOf(a.startedAt, a.endedAt) + ')' : '') + '</b></div>' +
        (r.reason ? '<div class="appr-note">“' + esc(r.reason) + '”</div>' : '') +
        '<div class="appr-act"><button class="btn btn-filled btn-sm" onclick="approveRequest(\'' + safeId(r.id) + '\')">Approve</button>' +
          '<button class="btn btn-sm" onclick="rejectRequest(\'' + safeId(r.id) + '\')">Reject</button></div>' +
      '</div>';
    }).join('');
  }
  window.approveRequest = function (id) {
    const r = requests[id];
    if (!r || r.status !== 'pending' || !isOwner()) return;
    if (r.type === 'stopFigures') { approveStopRequest(r); return; }
    const e = entries[r.targetId];
    if (!e) { showToast('That shift is no longer there'); return; }
    // The rules let a crew member file a request naming any shift, so the
    // shift must be the asker's own -- and still the one they looked at: a
    // change made to it since (by the office) is not quietly undone.
    if (e.uid !== r.requestedBy) { showToast('That shift is not theirs — reject it'); return; }
    const b = r.before || {};
    if (ms(b.startedAt) !== ms(e.startedAt) || ms(b.endedAt || 0) !== ms(e.endedAt || 0)) {
      showToast('That shift has changed since they asked — reject it and they can ask again'); return;
    }
    const a = r.after || {};
    const patch = {};
    if (a.startedAt) { patch.startedAt = a.startedAt; patch.startedMs = ms(a.startedAt); }
    if (a.endedAt) { patch.endedAt = a.endedAt; patch.endedMs = ms(a.endedAt); }
    const next = Object.assign({}, e, patch);
    if (!(ms(next.endedAt) > ms(next.startedAt))) { showToast('Those times end before they start'); return; }
    // The hours and pay stamped on it are worked out again, at the rate it
    // was settled at (or theirs now, if it never was).
    if (e.rateCents != null || e.status === 'approved' || e.status === 'ok') {
      const rate = e.rateCents != null ? e.rateCents : rateOf(e.uid);
      Object.assign(patch, { rateCents: rate, paidHours: hours(paidMs(next)), billableHours: hours(chargeableMs(next)),
                             costCents: costOf(paidMs(next), rate) });
    }
    Object.assign(patch, { changedBy: (me() || {}).uid || '', changedAt: nowIso(), changeRequestId: id });
    Object.assign(e, patch);
    write(e.id, patch, 'applying a change');
    r.status = 'approved';
    writeRequest(id, { status: 'approved', decidedBy: (me() || {}).uid || '', decidedAt: nowIso() }, 'approving a change');
    render();
    if (typeof refreshJobLabour === 'function') refreshJobLabour();
    showToast('Changed — ' + fmtDur(paidMs(e)) + ' for ' + workerOf(e));
  };
  // One at a time: the bill is worked out on the server, which takes a
  // moment, and a second tap meanwhile fixed it twice.
  const deciding = new Set();
  function approveStopRequest(r) {
    const a = r.after || {};
    if (deciding.has(r.id)) return;
    if (!window.YDBilling || !YDBilling.fixVisit) { showToast('Storm billing is still loading — try again'); return; }
    if (figure(a.inchesCleared) == null) { showToast('That request has no depth in it — reject it'); return; }
    deciding.add(r.id);
    // What the crew said the stop has now, and whose stop: checked against
    // the stop itself before anything changes (billing.js fixVisit).
    YDBilling.fixVisit(r.stormId, r.targetId, figure(a.inchesCleared), figure(a.saltBags), (me() || {}).uid || '',
                       { accountId: r.accountId || null, before: r.before || {} })
      .then(res => {
        r.status = 'approved';
        writeRequest(r.id, { status: 'approved', decidedBy: (me() || {}).uid || '', decidedAt: nowIso() }, 'approving a change');
        render();
        showToast('Changed — ' + YDBilling.fixedWords(res), res.inQuickBooks || res.numbered ? 9000 : 3000);
      })
      .catch(err => showToast((err && err.message) || 'Not changed', 6000))
      .then(() => deciding.delete(r.id));
  }
  window.rejectRequest = function (id) {
    const r = requests[id];
    if (!r || r.status !== 'pending' || !isOwner()) return;
    const why = prompt('Why not? They see this.');
    if (why === null) return;
    r.status = 'rejected';
    writeRequest(id, { status: 'rejected', decidedReason: why.trim().slice(0, 300), decidedBy: (me() || {}).uid || '', decidedAt: nowIso() }, 'turning down a change');
    render();
  };

  function wkCard(label, value, sub, cls) {
    return '<div class="wk-card ' + (cls || '') + '">' +
      '<div class="wk-card-label">' + label + '</div>' +
      '<div class="wk-card-value">' + value + '</div>' +
      '<div class="wk-card-sub">' + sub + '</div></div>';
  }

  function shiftRow(e, askable) {
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
      (askable ? '<td>' + (running(e) || !e.endedAt ? ''
        : pendingFor(e.id) ? '<span class="muted">change asked</span>'
        : '<button class="link-btn" onclick="askChange(\'' + safeId(e.id) + '\')">Ask for a change</button>') + '</td>' : '') +
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
    if (!workerUid) return;
    const isMe = workerUid === ((me() || {}).uid);
    const canName = isOwner();
    const canRate = decides() && (isOwner() || !isMe);
    if (!canName && !canRate) return;
    // Same limit as Rename on Your Crew, so the two ways of naming agree.
    const name = canName ? ((el('wkName') || {}).value || '').trim().slice(0, 60) : null;
    const raw = ((el('wkRate') || {}).value || '').replace(/[^0-9.]/g, '');
    const cents = canRate ? Math.round(parseFloat(raw) * 100) : null;

    if (canName && !name) { showToast('Give them a name'); return; }
    if (canRate && !(cents > 0)) { showToast('That hourly rate does not look right'); return; }

    // No shift is rewritten. Every screen reads the name from the user
    // record (whoIs), so past shifts show the new name at once -- and Save
    // here and Rename on Your Crew can no longer leave them disagreeing.
    // Rewriting used to cost one database write per shift the person had
    // ever worked, on every save, even when only the rate had changed.
    if (canName) {
      people[workerUid] = Object.assign({}, people[workerUid], { name: name });
      Promise.resolve(window.YDDb.put('users', workerUid, { name: name }))
        .catch(e => console.warn('[clock] name not saved:', e.code || e.message));
    }
    if (canRate) {
      rates[workerUid] = cents;
      const uid = workerUid;
      if (!newRulesLive && isOwner()) {
        // The rules that know about payRates are not published yet: keep the
        // rate where it has always been. It moves across by itself later.
        people[uid] = Object.assign({}, people[uid], { rateCents: cents });
        Promise.resolve(window.YDDb.put('users', uid, { rateCents: cents }))
          .catch(e => console.warn('[clock] rate not saved:', e.code || e.message));
      } else {
        Promise.resolve(window.YDDb.put('payRates', uid, { rateCents: cents, updatedAt: nowIso() }))
          .catch(e => {
            console.warn('[clock] rate not saved:', e.code || e.message);
            if (e && e.code === 'permission-denied') showToast('Rate not saved — not allowed');
          });
      }
    }

    editingWorker = false;
    render();
    showToast('Saved — ' + (name || whoIs(workerUid)) + (canRate ? ' at ' + money(cents) + '/hr' : ''));
  };

  // Rates used to live on each person's user record, where anyone allowed
  // to read that record (an admin, for names) could read the rate too. Once,
  // on the owner's device, each one is copied to payRates/{uid} -- and only
  // after the server has taken that copy is it cleared from the user record,
  // so a rate is never lost to a refused or half-done move.
  let movingRates = false;
  async function moveRates() {
    if (!isOwner() || !usersLoaded || !ratesLoaded || !newRulesLive || movingRates || !window.YDDb) return;
    // Everyone whose user record still holds a rate -- including anyone whose
    // copy landed last time but whose old rate was never cleared (the app
    // closed between the two). Only the copy is skipped when it already exists.
    const todo = Object.keys(people).filter(uid => typeof people[uid].rateCents === 'number');
    if (!todo.length) return;
    movingRates = true;
    try {
      for (const uid of todo) {
        const cents = people[uid].rateCents;
        if (rates[uid] == null) {
          await window.YDDb.put('payRates', uid, { rateCents: cents, updatedAt: nowIso() });
          rates[uid] = cents;
        }
        await window.YDDb.put('users', uid, { rateCents: null });
        people[uid] = Object.assign({}, people[uid], { rateCents: null });
      }
    } catch (e) {
      // Most likely the rules for payRates are not published yet. Nothing is
      // lost: the rate stays on the user record and is still read from there.
      console.warn('[clock] pay rates not moved yet:', e.code || e.message);
    } finally {
      movingRates = false;
    }
  }

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
      // By the name they go by now, so one person renamed part-way through a
      // job is one row on its labour, not two.
      const who = workerOf(e);
      const w = out.byWorker[who] = out.byWorker[who] || { paid: 0, billable: 0 };
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
    // Change requests: the owner's queue, or a crew member's own (storm.js
    // shows a crew member's storm-figure requests on the Snow tab).
    requests: () => requests,
    entries: () => entries,
    people: () => people,
    render: render,
    // The work log uses these rather than its own arithmetic, so a shift is
    // the same length in the log as on the pay sheet.
    paidMs: paidMs,
    chargeableMs: chargeableMs,
    pausedMs: pausedMs,
    startMsOf: startMsOf,
    endMsOf: endMsOf,
    counts: counts,
    awaitingOwner: awaitingOwner,
    fmtDur: fmtDur,
    who: workerOf,
    // A job's name as it reads today when the job is still listed: jobs get
    // renamed, and the work log should not show one job under two names.
    label: e => (e.kind === 'job' && board[e.targetId] && board[e.targetId].name) ||
      e.targetName || OVERHEAD_LABEL[e.kind] || 'Other',
  };

  // ---------------------------------------------------------------- loading

  // The work log listens for this. It is sent when names change as well as
  // shifts, because the log shows the name a person goes by now.
  function announce() { document.dispatchEvent(new CustomEvent('yd-clock-changed')); }

  // Crew cannot watch the users collection -- only the owner may read anyone
  // else's record -- but each person may read their own. Without it a crew
  // phone knew neither the name the owner gave them, so every new shift was
  // stamped with their Google name, nor their rate, so "My hours" priced
  // every shift the owner's app had not yet stamped at the standing $25.
  // A read, not a write, so it cannot freeze anything when there is no signal.
  function loadMyRecord() {
    const u = me(), key = watchKey;
    if (!u || !window.YDDb || !key) return;
    Promise.resolve(window.YDDb.get('users', u.uid)).then(d => {
      if (!d || watchKey !== key) return;    // signed out or switched meanwhile
      people[u.uid] = Object.assign({ uid: u.uid }, d);
      render();
      announce();
    }).catch(() => { /* offline with nothing cached: the Google name and the default rate stand */ });
    // Their own rate, from where rates live now.
    Promise.resolve(window.YDDb.get('payRates', u.uid)).then(d => {
      if (!d || watchKey !== key || !(d.rateCents > 0)) return;
      rates[u.uid] = d.rateCents;
      render();
    }).catch(() => { /* not published yet, or offline: the old record's rate stands */ });
  }

  function start() {
    if (!window.YDDb) return;

    const u = me();
    if (!u) return;
    const all = seesAll();
    // Admins read the user records too (names on every list), never the rates.
    const readsPeople = isOwner() || !!(window.YDAuth && window.YDAuth.isAdmin);

    // Rebuild whenever the account, the role or the access changes, rather
    // than only on a first run. A crew member reads their shifts through a
    // filtered query and the owner reads the whole collection; keeping the
    // first set of watches after a promotion would leave someone looking at
    // one person's hours and wondering where everyone else went.
    const key = (window.YDAuth && window.YDAuth.key) || u.uid;
    if (watchKey === key) return;
    unsub.forEach(fn => { try { fn(); } catch (e) {} });
    unsub = [];
    entries = {}; board = {}; people = {}; rates = {}; usersLoaded = false; ratesLoaded = false;
    requests = {}; asking = null;
    watchKey = key;

    // Change requests: the owner reads them all (the queue); anyone else only
    // their own, asked for by name -- the rules refuse a wider read.
    const onRequests = changes => {
      changes.forEach(c => {
        if (c.type === 'removed') delete requests[c.id];
        else requests[c.id] = Object.assign({ id: c.id }, c.data);
      });
      render();
      if (workerUid && !asking && el('workerModal') && el('workerModal').classList.contains('active')) renderWorker();
      // The Snow tab shows the crew how their storm-figure requests went.
      document.dispatchEvent(new CustomEvent('yd-requests'));
    };
    unsub.push(isOwner()
      ? window.YDDb.watch('changeRequests', onRequests, () => {})
      : window.YDDb.watchWhere('changeRequests', 'requestedBy', u.uid, onRequests, () => {}));

    const onEntries = changes => {
      changes.forEach(c => {
        if (c.type === 'removed') delete entries[c.id];
        else entries[c.id] = Object.assign({ id: c.id }, c.data);
      });
      stampUnpriced();
      render();
      if (typeof refreshJobLabour === 'function') refreshJobLabour();
      announce();
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
    unsub.push(all
      ? window.YDDb.watch('timeEntries', onEntries, onEntriesError)
      : window.YDDb.watchWhere('timeEntries', 'uid', u.uid, onEntries, onEntriesError));

    unsub.push(window.YDDb.watch('jobBoard', changes => {
      changes.forEach(c => {
        if (c.type === 'removed') delete board[c.id];
        else board[c.id] = Object.assign({ id: c.id }, c.data);
      });
      render();
      announce();          // a renamed job reads under its new name in the log
    }, () => render()));

    if (readsPeople) {
      unsub.push(window.YDDb.watch('users', changes => {
        changes.forEach(c => {
          if (c.type === 'removed') delete people[c.id];
          else people[c.id] = Object.assign({ uid: c.id }, c.data);
        });
        usersLoaded = true;
        stampUnpriced();
        moveRates();
        render();
        // A rename shows on the open job's labour and in the work log too.
        if (typeof refreshJobLabour === 'function') refreshJobLabour();
        announce();
      }, () => render()));
    }
    if (all) {
      // Rates arrive apart from the people; nothing is priced until both have
      // (a shift stamped before its worker's rate came would be frozen at the
      // default). If the rates cannot be read at all -- the rules for them not
      // published yet -- the old rate on the user record is used instead.
      unsub.push(window.YDDb.watch('payRates', (changes, meta) => {
        changes.forEach(c => {
          if (c.type === 'removed' || !(c.data && c.data.rateCents > 0)) delete rates[c.id];
          else rates[c.id] = c.data.rateCents;
        });
        // Only the server's answer counts as "the rates are in": a new phone's
        // empty cache would otherwise price every settled shift at $25.
        if (meta && meta.fromCache === false) { ratesLoaded = true; newRulesLive = true; }
        stampUnpriced();
        moveRates();
        render();
        if (typeof refreshJobLabour === 'function') refreshJobLabour();
      }, () => { ratesLoaded = true; newRulesLive = false; stampUnpriced(); render(); }));
    }
    if (!readsPeople || !all) loadMyRecord();
  }

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const signedIn = a.mode === 'cloud' && a.user;
    // Who is on the clock, the approvals and the wage totals: everyone's
    // hours. Your Crew -- who gets in, and what they may do -- is the owner's.
    ['clockOnNowSection', 'clockApproveSection', 'clockTotalsSection'].forEach(id => {
      const s = el(id); if (s) s.hidden = !(signedIn && seesAll());
    });
    const crewSec = el('clockCrewSection');
    if (crewSec) crewSec.hidden = !(signedIn && a.isOwner === true);
    const tab = el('tabClock');
    if (tab) tab.hidden = !signedIn;
    if (signedIn) {
      start();
    } else if (watchKey) {
      // Signed out. Drop the watches and the data with them, so nothing of one
      // person's is still on screen when the next one signs in.
      unsub.forEach(fn => { try { fn(); } catch (e) {} });
      unsub = []; watchKey = null;
      entries = {}; board = {}; people = {}; rates = {}; usersLoaded = false; ratesLoaded = false;
      closeAccess();
      // Half-done screens go too. A form the owner opened to file a shift for
      // somebody else, left open, would otherwise file the next person's
      // shift under that somebody.
      picking = false; clockingFor = null; pausingId = null; choosingWorker = false;
      addingShift = false; addFor = null; editingWorker = false;
      closeWorker();
      render();
    }
  });

  function boot() { render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
