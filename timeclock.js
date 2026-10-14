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
// A BREAK is neither: the Break button clocks the person out (endedFor
// 'break') and "Clock back in" starts a new shift on the same work, so the
// break sits on no shift at all (see takeBreak).
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
  // What a pause is FOR -- still paid, the customer not charged (Jonah, 9 Oct
  // 2026: "pause ... pauses hours billed to client and they select what
  // theyre going to do"). A break is not one of these any more: it has its
  // own button and it is unpaid.
  const PAUSE_REASONS = ['Gas', 'Salt / materials', 'Dump run', 'Driving', 'Equipment trouble', 'Other'];

  // A BREAK (Jonah, 9 Oct 2026: "a button for break and it takes them off
  // the clock and they can click a button to clock back in"). It is a real
  // clock-out, marked endedFor 'break': the break is on no shift, so it is
  // neither paid nor billed, and nothing in the pay or billing sums changes.
  // For BREAK_SHOW_HOURS afterwards the clock offers "Clock back in" to the
  // same work in one tap, and the office sees them as on break.
  const BREAK_SHOW_HOURS = 4;

  // id -> shift. Crew see only their own (all of them); the owner and admins
  // with Crew hours & pay see everyone's RECENT shifts, and every one still
  // waiting for approval however old (see "older shifts" below).
  let entries = {};
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
  const whyFlagged = e => autoStopped(e)
    ? 'no clock-out — stopped at ' + hoursWord(e.autoLimitHours || autoOutHours)
    // Stopped by the clock, then given its real end (by them or the office).
    : e.autoEnded === true ? 'no clock-out — end put right'
    : e.source === 'manual' ? 'typed in by hand'
    : paidMs(e) > LONG_SHIFT_MS ? 'longer than ' + LONG_SHIFT_HOURS + ' hours'
    : e.changedAt ? 'times changed' : 'longer than ' + LONG_SHIFT_HOURS + ' hours';

  // ------------------------------------------------ the clock stops itself
  //
  // Jonah (14 Oct 2026): "automatically clock people out once they hit 16
  // hours without clocking out." The server does it (functions/autoclock.py,
  // every five minutes), so it happens with the phone off, flat or out of
  // signal: a shift still running autoOutHours after it started is ended AT
  // that moment -- not when it was noticed -- marked autoEnded, and goes to
  // the office like any shift over eight hours; the person and the owner are
  // told by phone. How many hours is the owner's to say (Your Crew), kept in
  // settings/public.clock so every phone can say when its shift will stop.
  //
  // This side mostly shows it: no phone stops a shift by itself for passing
  // the limit (the server has, or will). Only a Clock out tapped after the
  // limit, on a screen that has not heard yet, ends the shift AT the limit
  // (endShift) -- the same moment the server gives it, so whichever arrives
  // first, the shift ends in the same place.
  const AUTO_OUT_DEFAULT = 16, AUTO_OUT_MIN = 8, AUTO_OUT_MAX = 24;
  let autoOutHours = AUTO_OUT_DEFAULT;
  const autoOutMs = () => autoOutHours * 3600000;
  const hoursWord = h => (Number(h) || AUTO_OUT_DEFAULT) + ' hours';
  // Stopped by the clock, and still at the time it stopped it. The person's
  // own clock-out arriving later from a phone that had no signal (earlier,
  // so it wins -- firestore.rules), or times the office fixed, leave the
  // marks on the shift but make it not the clock's end any more.
  const autoStopped = e => !!e && e.autoEnded === true && typeof e.autoEndedMs === 'number' &&
    endMsOf(e) === e.autoEndedMs;
  // When a running shift stops by itself, and how near that is: 0 not yet
  // near, 1 within the last hour, 2 past it (this phone has not heard yet).
  const stopsAt = e => startMsOf(e) + autoOutMs();
  function limitState(e) {
    if (!e || !running(e)) return 0;
    const left = stopsAt(e) - Date.now();
    return left <= 0 ? 2 : left <= 3600000 ? 1 : 0;
  }
  function readAutoOut() {
    const key = watchKey;
    if (!window.YDDb || !key) return;
    Promise.resolve(window.YDDb.get('settings', 'public')).then(pub => {
      if (watchKey !== key) return;
      const h = pub && pub.clock && pub.clock.autoOutHours;
      const next = typeof h === 'number' && h >= AUTO_OUT_MIN && h <= AUTO_OUT_MAX ? h : AUTO_OUT_DEFAULT;
      if (next !== autoOutHours) { autoOutHours = next; render(); }
    }).catch(() => { /* offline with nothing cached: the usual 16 hours */ });
  }

  // The owner sets it on Your Crew.
  window.setAutoOutHours = function () {
    if (!isOwner() || !window.YDDb) return;
    const typed = prompt('After how many hours on the clock, with nobody clocking out, should a shift stop by itself?\n\n' +
      'Between ' + AUTO_OUT_MIN + ' and ' + AUTO_OUT_MAX + '. The shift ends at that hour and goes to you to check.', String(autoOutHours));
    if (typed === null) return;
    const h = Math.round(parseFloat(String(typed).replace(/[^0-9.]/g, '')) * 2) / 2;    // whole or half hours
    if (!(h >= AUTO_OUT_MIN && h <= AUTO_OUT_MAX)) {
      showToast('Pick a number of hours from ' + AUTO_OUT_MIN + ' to ' + AUTO_OUT_MAX); return;
    }
    autoOutHours = h;
    render();
    // Merged: the board list the crew read lives in the same record.
    Promise.resolve(window.YDDb.put('settings', 'public', { clock: { autoOutHours: h, updatedAt: nowIso() } }))
      .catch(e => {
        console.warn('[clock] automatic clock-out hours not saved:', (e && e.code) || e);
        if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      });
    showToast('Shifts nobody clocks out of now stop by themselves after ' + hoursWord(h));
  };

  // The note on a crew member's own Clock screen after the clock stopped
  // their shift, until they tap OK (on this phone).
  const AUTO_SEEN_KEY = 'ydjobhub_autoStopSeen';
  function myAutoStop() {
    let last = null;
    mine().forEach(e => { if (e.endedAt && (!last || (endMsOf(e) || 0) > (endMsOf(last) || 0))) last = e; });
    if (!autoStopped(last)) return null;
    if (Date.now() - endMsOf(last) > 2 * 864e5) return null;
    try { if (localStorage.getItem(AUTO_SEEN_KEY) === last.id) return null; } catch (e) { /* shown */ }
    return last;
  }
  window.seenAutoStop = function (id) {
    try { localStorage.setItem(AUTO_SEEN_KEY, id); } catch (e) {}
    render();
  };

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
        // Most likely, a phone that had no signal while the clock stopped
        // this shift by itself: its tap (a pause, a clock-out later than
        // that) arrives after, and the server's end stands. The screen
        // already shows the shift as the server has it.
        const s = entries[id] || older[id];
        const stopped = s && (s.autoEnded === true || (startMsOf(s) && startMsOf(s) + autoOutMs() <= Date.now()));
        showToast(stopped
          ? 'That shift had already been stopped by the clock at ' + hoursWord((s && s.autoLimitHours) || autoOutHours) +
            ' — it goes to the office to check. Stopped earlier? Ask for a change on My hours.'
          : 'Not saved — you are not allowed to do that', stopped ? 8000 : undefined);
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
  // From a person's page: one they forgot, filed for them by whoever settles
  // their shifts (their phone was dead, say). The form is at the top of the
  // Clock screen, so the page is closed and the form brought into view; it
  // still goes to Waiting for You, like any shift typed in by hand.
  window.addShiftFor = function (uid) {
    if (!people[uid] || !decides() || (!isOwner() && uid === (me() || {}).uid)) return;
    closeWorker();
    if (typeof switchTab === 'function' && !clockShowing()) switchTab('clock');
    // A form already open (their own, or someone else's) is drawn again
    // for this person rather than left saying the wrong name.
    const wrap = el('clockWrap');
    if (wrap && addingShift) wrap.innerHTML = '';
    window.openAddShift(uid);
    const card = el('clockWrap');
    if (card && card.scrollIntoView) card.scrollIntoView({ block: 'start', behavior: 'smooth' });
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

  // The job list the open form was last given, so a redraw with the same
  // jobs leaves it alone (see renderClockCard).
  let asOptions = null;

  function addShiftHtml() {
    const today = new Date();
    const iso = d => d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
    asOptions = targetOptions();

    // Says whose it is when it is filed for somebody else, so it cannot be
    // mistaken for one's own.
    const other = addFor && addFor !== (me() || {}).uid;
    return '<div class="addshift">' +
      '<p class="clock-lead">' + (other ? 'A shift ' + esc(whoIs(addFor)) + ' forgot to clock in for'
        : 'A shift you forgot to clock in for') + '</p>' +
      '<div class="field"><span class="label">What were you on?</span>' +
        '<select id="asTarget" class="searchable">' + asOptions + '</select></div>' +
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
    // "Other" says what, in a few words, so the office is not left guessing.
    // Cancel on that question is "never mind": the clock is not paused.
    if (reason === 'Other') {
      const typed = prompt('What are you going to do?');
      if (typed === null) return;
      const what = typed.trim().slice(0, 60);
      if (what) reason = 'Other: ' + what;
    }
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

  function endShift(id, why, extra) {
    const e = entries[id];
    if (!e || !running(e)) return;
    if (extra) Object.assign(e, extra);
    // Past the hour the clock stops a shift by itself, on a phone (or the
    // office's screen) that has not heard so yet: it ends at that hour, the
    // moment the server gives it, whoever taps -- never later. A clock-out
    // later than the server's stop would otherwise be written over it from
    // the office (whose writes the rules do not hold back).
    const late = limitState(e) === 2;
    const stampMs = late ? Math.max(startMsOf(e), stopsAt(e)) : Date.now();
    const stamp = new Date(stampMs).toISOString();
    // An open pause is closed too, or the shift would look paused forever and
    // its billable time would be wrong (one begun after the stop counts nothing).
    const p = openPause(e);
    if (p) p.endedAt = new Date(Math.max(stampMs, ms(p.startedAt))).toISOString();
    // Always an array. Firestore refuses a write containing undefined and
    // fails the whole thing with it, so a shift that somehow had no pauses
    // list could not be clocked out at all.
    e.pauses = e.pauses || [];
    e.endedAt = stamp;
    e.endedMs = stampMs;

    // A normal day settles itself. Only a shift past the eight-hour mark goes
    // to the owner, because that is where a forgotten clock-out hides -- and
    // one the clock had to stop always does, as the server sends it.
    e.status = late || needsReview(paidMs(e), e.source) ? 'pending' : 'ok';

    render();
    write(id, Object.assign({ endedAt: stamp, endedMs: stampMs, pauses: e.pauses, status: e.status }, extra || {}),
      why || 'clocking out');
    return e.status;
  }

  // ------------------------------------------------------------------ break

  window.takeBreak = function (id) {
    const e = entries[id];
    if (!e || !running(e)) return;
    const status = endShift(id, 'starting a break', { endedFor: 'break' });
    showToast('On break — off the clock. Tap Clock back in when you’re back.' +
      (status === 'pending' ? ' (Over ' + LONG_SHIFT_HOURS + ' hours, so the part before goes to the office to check.)' : ''), 5000);
  };

  // This person's break, while it is one: their last shift ended for a break,
  // in the last few hours, nothing started since, and not waved off.
  const BREAK_DONE_KEY = 'ydjobhub_breakDone';
  function breakDismissed(id) {
    try { return localStorage.getItem(BREAK_DONE_KEY) === id; } catch (e) { return false; }
  }
  function breakOf(list) {
    if (list.some(running)) return null;
    let last = null;
    list.forEach(e => { if (e.endedAt && (!last || (endMsOf(e) || 0) > (endMsOf(last) || 0))) last = e; });
    if (!last || last.endedFor !== 'break' || last.breakOverAt) return null;
    if (Date.now() - endMsOf(last) > BREAK_SHOW_HOURS * 3600000) return null;
    if (list.some(e => startMsOf(e) >= endMsOf(last))) return null;
    return last;
  }
  const myBreak = () => { const b = breakOf(mine()); return b && !breakDismissed(b.id) ? b : null; };

  window.backFromBreak = function (id) {
    const b = entries[id];
    if (!b) return;
    // A storm that has finished, or a job that has gone, is not somewhere to
    // go back to: the picker instead.
    const stormGone = b.kind === 'storm' && !(window.YDStorm && YDStorm.current() &&
      YDStorm.current().id === b.targetId && YDStorm.current().status === 'open');
    if (stormGone || (b.kind === 'job' && !board[b.targetId])) { window.openJobPicker(); return; }
    const was = fmtDur(Date.now() - endMsOf(b));
    window.clockInTo(b.kind, b.targetId, b.targetName);
    showToast('Back on — ' + b.targetName + ' (break ' + was + ')');
  };
  // "Done for the day" ends the break on the shift itself (breakOverAt), so
  // the office and the snow bill see it too -- on this phone alone, a storm
  // stop could have counted up to BREAK_SHOW_HOURS of somebody's evening as
  // a break. The phone's own note stays as well, for a write still waiting
  // on signal (or refused by rules not yet published).
  window.endBreakDay = function (id) {
    try { localStorage.setItem(BREAK_DONE_KEY, id); } catch (e) {}
    const b = entries[id];
    if (b && b.endedFor === 'break' && !b.breakOverAt && window.YDDb) {
      const at = Math.max(Date.now(), endMsOf(b) || 0);
      b.breakOverAt = at;
      Promise.resolve(window.YDDb.put('timeEntries', id, { breakOverAt: at }))
        .catch(e => console.warn('[clock] break end kept on this phone only:', (e && e.code) || e));
    }
    render();
  };

  window.clockOut = function (id) {
    const e = entries[id];
    if (!e || !running(e)) return;
    const late = limitState(e) === 2;
    const status = endShift(id);
    // Worked out after: past the limit, it ended at the limit.
    const dur = fmtDur(paidMs(e));
    showToast(late
      ? 'Clocked out at ' + hoursWord(autoOutHours) + ' — the clock stops a shift there by itself. ' +
        'It goes to the office to check.'
      : status === 'pending'
      ? 'Clocked out — ' + dur + '. Over ' + LONG_SHIFT_HOURS +
        ' hours, so it goes to the office to check.'
      : 'Clocked out — ' + dur, late ? 6000 : undefined);
  };

  // ------------------------------------------------------------- the display

  function render() {
    // Every change to the shifts, the names or the rates on this device ends
    // up here, so this is where the per-job labour sums are let go.
    forgetLabour();
    limitDrawn = limitSig();
    // The Clock screen's sections are drawn only while it is on screen:
    // opening the tab draws them (switchTab in app.js calls this), and a
    // phone on the Snow tab need not rebuild a hidden clock for every change.
    if (clockShowing()) {
      renderClockCard();
      if (seesAll()) { renderOnNow(); renderApprovals(); renderTotals(); }
      if (isOwner()) renderCrew();
    }
    // Not while the name and rate are being typed into: the clock redraws
    // every second, and rebuilding the form would clear the fields mid-word.
    // Nor while a change is being asked for (the same reason).
    // Nor while times are being changed on it (fixHtml).
    if (workerUid && !editingWorker && !asking && !(fixingIn === 'worker' && typingIn(el('wkMain')))
        && el('workerModal') && el('workerModal').classList.contains('active')) renderWorker();
    manageTicker();
  }
  window.renderClock = render;
  const clockShowing = () => !!(el('panel-clock') && el('panel-clock').classList.contains('active'));

  // A running clock only needs redrawing while it is actually on screen and
  // actually running -- and only the parts with a running time in them. The
  // approvals, the crew list and the wages table do not change from one second
  // to the next, and rebuilding all of them every second made the owner's
  // screen sluggish on a phone for no visible gain.
  function manageTicker() {
    const visible = el('panel-clock') && el('panel-clock').classList.contains('active');
    const live = Object.values(entries).some(running) || !!document.querySelector('[data-live-break]');
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
    // How long a break has run (the clock card, and On now for the office).
    // One that has just passed BREAK_SHOW_HOURS is not a break any more:
    // the screen is drawn again once, so "On break" and its Clock back in
    // go instead of counting up for ever.
    let over = false;
    document.querySelectorAll('[data-live-break]').forEach(n => {
      const b = entries[n.dataset.liveBreak];
      if (!b || !b.endedAt) return;
      if (Date.now() - endMsOf(b) > BREAK_SHOW_HOURS * 3600000) over = true;
      else n.textContent = fmtDur(Date.now() - endMsOf(b));
    });
    if (over) { render(); return; }      // render() sees to the ticker
    // A running shift coming up to, or passing, the hour the clock stops it
    // by itself: drawn again once, so the note about it shows.
    if (limitSig() !== limitDrawn) { render(); return; }
    manageTicker();
  }
  const limitSig = () => Object.values(entries).filter(running)
    .map(e => limitState(e) ? e.id + ':' + limitState(e) : '').join('');
  let limitDrawn = '';

  function renderClockCard() {
    const wrap = el('clockWrap');
    if (!wrap) return;
    const shift = myOpenShift();

    const badge = el('clockBadge');
    if (badge) badge.textContent = shift ? (openPause(shift) ? 'Paused' : 'On the clock') : (myBreak() ? 'On break' : '');

    if (addingShift) {
      // Built once, then left alone. The clock redraws on every change from
      // the database -- another crew member pausing, a job being saved -- and
      // rebuilding this form each time wiped the times and the reason while
      // they were being typed. Only the list of jobs is brought up to date,
      // and not while it is open, so a job that arrives after the form was
      // opened can still be picked.
      //
      // The list is a searchable one (makeSearchable in app.js): the select
      // itself is hidden and the typing happens in the box beside it, so it
      // is the whole control that must not have the focus. Rebuilding the
      // options while the box was in use put its text back to the picked job
      // after every letter. And an unchanged list is not rebuilt at all.
      const sel = el('asTarget');
      if (!sel) { wrap.innerHTML = addShiftHtml(); cardDrawn = null; return; }
      const control = sel.closest('.ssel') || sel;
      const opts = targetOptions();
      if (opts !== asOptions && !control.contains(document.activeElement)) {
        const keep = sel.value;
        sel.innerHTML = opts;
        asOptions = opts;
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
      cardDrawn = null;
      if (typed) {
        const fresh = el('clockSearch');
        if (fresh) { fresh.value = typed; filterJobPicker(); }
      }
      return;
    }
    // Not rebuilt when nothing on it has changed. The owner's clock redraws
    // whenever anybody's shift does, and each rebuild swapped the Pause and
    // Clock out buttons for new ones -- a tap landing in that instant was
    // lost. (The running time is kept current by tick(), not by this.)
    const html = shift ? liveHtml(shift) : idleHtml();
    if (html !== cardDrawn || !wrap.firstChild) { wrap.innerHTML = html; cardDrawn = html; }
  }
  let cardDrawn = null;       // the card as last drawn, by renderClockCard

  function breakHtml(b) {
    const id = safeId(b.id);
    return '<div class="clock-live clock-onbreak">' +
      '<div class="clock-where">🍔 On break</div>' +
      '<div class="clock-elapsed" data-live-break="' + id + '">' + fmtDur(Date.now() - endMsOf(b)) + '</div>' +
      '<div class="clock-sub">since ' + clockTime(b.endedAt) + ' · off the clock, not paid</div>' +
      '<div class="clock-actions">' +
        '<button class="btn btn-filled clock-big" onclick="backFromBreak(\'' + id + '\')">Clock back in — ' +
          esc(b.targetName) + '</button>' +
        '<button class="btn btn-sm" onclick="openJobPicker()">Clock in to something else</button>' +
        '<button class="btn btn-sm" onclick="endBreakDay(\'' + id + '\')">Done for the day</button>' +
        // The same way out as when not on the clock at all: a shift that
        // never got clocked, and their own hours.
        '<button class="btn btn-sm" onclick="openAddShift()">Forgot to clock in?</button>' +
        '<button class="btn btn-sm wk-mine" onclick="openWorker()">My hours</button>' +
      '</div>' +
    '</div>';
  }

  function idleHtml() {
    const b = myBreak();
    if (b) return breakHtml(b);
    return '<div class="clock-idle">' +
      autoStopHtml() +
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
      limitNoteHtml(e) +
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
            '<button class="btn clock-big clock-break-btn" onclick="takeBreak(\'' + safeId(e.id) + '\')">🍔 Break</button>' +
            '<button class="btn clock-big" onclick="clockOut(\'' + safeId(e.id) + '\')">Clock out</button>' +
            '<div class="clock-hint">' + (canPause(e) ? '<b>Pause</b> — still paid, the customer isn’t charged. ' : '') +
              '<b>Break</b> — off the clock, unpaid.</div>' +
            '<button class="btn btn-sm" onclick="openJobPicker()">Switch to something else</button>' +
            '<button class="btn btn-sm" onclick="openWorker()">My hours</button>' +
          '</div>') +
    '</div>';
  }

  // On the person's own running shift: when the clock will stop it, once
  // that is under an hour away -- and, past it, that it has (a phone with
  // no signal has not heard yet; the server stopped it at that hour).
  function limitNoteHtml(e) {
    const s = limitState(e);
    if (!s) return '';
    const at = clockTime(new Date(stopsAt(e)).toISOString());
    return '<div class="clock-pausenote clock-limit">⏱ ' + (s === 2
      ? 'Over ' + hoursWord(autoOutHours) + '. The clock stops a shift by itself then, so this one ended at ' + at +
        ' and goes to the office to check — this phone shows it once it has signal. Still working? Clock out, then clock in again.'
      : 'Still on? The clock stops this shift by itself at ' + at + ' (' + hoursWord(autoOutHours) +
        ' on the clock). Still working then? Clock in again after.') + '</div>';
  }

  // The clock stopped their last shift by itself: said once, on their own
  // screen, with the way to put it right.
  function autoStopHtml() {
    const a = myAutoStop();
    if (!a) return '';
    return '<div class="clock-pausenote clock-limit">⏱ Nobody clocked out of <b>' + esc(a.targetName) + '</b> (in ' +
      dayTime(a.startedAt) + '), so the clock stopped it at ' + hoursWord(a.autoLimitHours || autoOutHours) +
      ' — ' + dayTime(a.endedAt) + '. It goes to the office to check.' +
      '<div class="field-actions">' +
        // The owner fixes his own in Waiting for You; anyone else asks.
        (!isOwner() && a.status === 'pending' && !pendingFor(a.id)
          ? '<button class="btn btn-sm" onclick="openWorker(); askChange(\'' + safeId(a.id) + '\')">I stopped earlier — fix the time</button>' : '') +
        '<button class="btn btn-sm" onclick="seenAutoStop(\'' + safeId(a.id) + '\')">OK</button>' +
      '</div></div>';
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
    // Who is on a break right now (off the clock, coming back).
    const byUid = {};
    Object.values(entries).forEach(e => { (byUid[e.uid] = byUid[e.uid] || []).push(e); });
    const breaks = Object.keys(byUid).map(uid => breakOf(byUid[uid])).filter(Boolean);
    const badge = el('onNowBadge');
    if (badge) badge.textContent = live.length ? live.length + ' working' + (breaks.length ? ' · ' + breaks.length + ' on break' : '')
      : breaks.length ? breaks.length + ' on break' : '';

    wrap.innerHTML = (live.length || breaks.length
      ? breaks.map(b => '<div class="on-now paused">' +
          '<button class="on-who linkish" onclick="openWorker(\'' + safeId(b.uid) + '\')">' + esc(workerOf(b)) + '</button>' +
          '<span class="on-where">' + esc(b.targetName) + '</span>' +
          '<span class="on-time">🍔 on break <span data-live-break="' + safeId(b.id) + '">' +
            fmtDur(Date.now() - endMsOf(b)) + '</span></span>' +
        '</div>').join('') +
        live.map(e => {
          const p = openPause(e);
          return '<div class="on-now' + (p ? ' paused' : '') + '">' +
            '<button class="on-who linkish" onclick="openWorker(\'' + safeId(e.uid) + '\')">' +
              esc(workerOf(e)) + '</button>' +
            '<span class="on-where">' + esc(e.targetName) + '</span>' +
            '<span class="on-time"><span data-live-entry="' + safeId(e.id) + '">' + fmtDur(paidMs(e)) + '</span>' +
              (p ? ' · paused (' + esc(p.reason) + ')' : '') +
              // Forgot to clock out, most likely: the clock stops it soon.
              (limitState(e) === 2 ? ' · ⏱ over ' + hoursWord(autoOutHours) + ' — being stopped'
                : limitState(e) === 1 ? ' · ⏱ stops by itself at ' + clockTime(new Date(stopsAt(e)).toISOString()) : '') +
              '</span>' +
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
    // Not while times are being typed into a shift here (fixing, below): a
    // redraw for somebody else's pause would wipe them.
    if (fixingId && fixingIn === 'appr' && typingIn(wrap)) return;
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
        'go through on their own — only shifts typed in by hand, longer than ' +
        LONG_SHIFT_HOURS + ' hours or stopped by the clock after ' + hoursWord(autoOutHours) +
        ' with nobody clocking out land here, and changes the crew ask for.</p>';
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
        '<div class="appr-times">' + spanWords(e) +
          (e.changedAt ? ' <span class="muted">· times changed by the office</span>' : '') + '</div>' +
        (autoStopped(e)
          ? '<div class="appr-auto">⏱ Nobody clocked out, so the clock stopped it at ' +
              hoursWord(e.autoLimitHours || autoOutHours) + '.' +
              (mayDecide(e) ? ' If they finished earlier, change the end time before approving.' : '') + '</div>'
          : '') +
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
        (mayDecide(e) && fixingId === e.id && fixingIn === 'appr' ? fixHtml(e)
          : mayDecide(e)
          ? '<div class="appr-act">' +
              '<button class="btn btn-filled btn-sm" onclick="approveShift(\'' + safeId(e.id) + '\')">Approve</button>' +
              '<button class="btn btn-sm" onclick="fixTimes(\'' + safeId(e.id) + '\')">Change times</button>' +
              '<button class="btn btn-sm" onclick="rejectShift(\'' + safeId(e.id) + '\')">Reject</button>' +
            '</div>'
          : '<div class="appr-act muted">' + (decides() ? 'Your own shift — the owner approves it' : 'Waiting for the owner') + '</div>') +
      '</div>';
    }).join('');
  }

  // "Mon 10/12 · 6:00 AM – 10:00 PM", the end's day too when it is another
  // day: a 16-hour shift from 8 pm read "8:00 PM – 12:00 PM".
  function spanWords(e) {
    const day = iso => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
    const sameDay = e.endedAt && new Date(e.startedAt).toDateString() === new Date(e.endedAt).toDateString();
    return day(e.startedAt) + ' · ' + clockTime(e.startedAt) + ' – ' +
      (!e.endedAt ? 'now' : sameDay ? clockTime(e.endedAt) : day(e.endedAt) + ' ' + clockTime(e.endedAt));
  }

  // Whether somebody is typing in a box inside `node` just now.
  const typingIn = node => !!node && node.contains(document.activeElement) &&
    /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);

  // ----------------------------------------------------- changing the times
  //
  // The office's own hand on a shift's times (Jonah: every automatic value
  // gets a by-hand way to change it): above all the end the clock put on a
  // shift nobody clocked out of, but any finished shift a decider may settle
  // -- from Waiting for You, or a person's page. The hours and pay stamped
  // on it are worked out again at the rate it was settled at, exactly as
  // approving a crew member's change request does (applyRequest); a shift
  // still waiting stays waiting, to be approved as it now reads.
  let fixingId = null;
  // Where the form was opened -- 'worker' (a person's page) or 'appr'
  // (Waiting for You) -- so the one shift's form is drawn in one place only.
  let fixingIn = null;
  window.fixTimes = function (id) {
    const e = entries[id] || older[id];
    if (!e || !mayDecide(e) || running(e)) return;
    fixingId = id;
    fixingIn = workerUid && el('workerModal') && el('workerModal').classList.contains('active') ? 'worker' : 'appr';
    render();
    const box = el('fxEnd');
    if (box && box.focus) box.focus();
  };
  // The form is let go before the redraw, which skips a list still being
  // typed into (typingIn) -- a phone's Save tap can leave the box focused.
  const leaveForm = () => {
    const a = document.activeElement;
    if (a && a.closest && a.closest('#fxForm') && a.blur) a.blur();
  };
  window.cancelFixTimes = function () { leaveForm(); fixingId = null; fixingIn = null; render(); };
  function fixHtml(e) {
    const id = safeId(e.id);
    return '<div class="add-area wk-ask" id="fxForm">' +
      '<div class="add-label">Change the times — ' + esc(workerOf(e)) + ', ' + spanWords(e) + '</div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Started</span><input type="time" id="fxStart" value="' + hm(e.startedAt) + '"></div>' +
        '<div class="field"><span class="label">Finished</span><input type="time" id="fxEnd" value="' + hm(e.endedAt) + '"></div>' +
      '</div>' +
      '<div class="hint">Each time lands on the day nearest the one it replaces, so a night shift past midnight stays one shift.</div>' +
      '<div class="field-actions"><button class="btn btn-filled btn-sm" onclick="saveFixTimes(\'' + id + '\')">Save the times</button>' +
        '<button class="btn btn-sm" onclick="cancelFixTimes()">Cancel</button></div>' +
    '</div>';
  }
  window.saveFixTimes = function (id) {
    const e = entries[id] || older[id];
    if (!e || !mayDecide(e) || running(e)) { leaveForm(); fixingId = null; fixingIn = null; render(); return; }
    const t = shiftTimes(e, (el('fxStart') || {}).value, (el('fxEnd') || {}).value);
    if (!t) { showToast('Put in both times'); return; }
    if (ms(t.end) > Date.now() + 60000) { showToast('That ends in the future — check the times'); return; }
    if (ms(t.start) === ms(e.startedAt) && ms(t.end) === ms(e.endedAt)) { leaveForm(); fixingId = null; fixingIn = null; render(); return; }
    const patch = { startedAt: t.start, startedMs: ms(t.start), endedAt: t.end, endedMs: ms(t.end) };
    if (ms(t.end) - ms(t.start) > 20 * 3600000 &&
        !confirm('That makes it ' + fmtDur(ms(t.end) - ms(t.start)) + ' long. Keep those times?')) return;
    const next = Object.assign({}, e, patch);
    // A settled shift's figures follow its new length, at the rate it was
    // settled at (or theirs now, if it never was).
    if (e.rateCents != null || counts(e)) {
      const rate = e.rateCents != null ? e.rateCents : rateOf(e.uid);
      Object.assign(patch, { rateCents: rate, paidHours: hours(paidMs(next)), billableHours: hours(chargeableMs(next)),
                             costCents: costOf(paidMs(next), rate) });
    }
    Object.assign(patch, { changedBy: (me() || {}).uid || '', changedAt: nowIso() });
    const wasOld = isOld(e);
    Object.assign(e, patch);
    patchOlder(e.id, patch);
    leaveForm();
    fixingId = null; fixingIn = null;
    write(e.id, patch, 'changing the times');
    // From before the clock's cutoff, then or now, and counted: the summary
    // of old jobs' labour no longer adds up (after the shift's own write).
    if ((wasOld || isOld(e)) && counts(e)) markStale();
    render();
    if (typeof refreshJobLabour === 'function') refreshJobLabour();
    showToast('Times changed — ' + fmtDur(paidMs(e)) + (awaitingOwner(e) ? '. Approve it when it looks right.' : ''));
  };

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
    // The older shifts too, once read (the owner's device prices them before
    // summing them up for old jobs -- buildRoll).
    const all = known();
    let old = false;
    Object.keys(all).forEach(id => {
      const e = all[id];
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
      patchOlder(id, patch);
      write(id, patch, 'pricing a settled shift');
      if (isOld(e)) old = true;
    });
    if (old && !building) markStale();
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
    patchOlder(id, patch);
    write(id, patch, 'approving');
    // One from before the cutoff now counts on its job: the summary of old
    // jobs' labour has to take it in (after the shift's own write, so the
    // owner's device never sums from the shift as it was).
    if (isOld(e)) markStale();
    render();
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
    // Waiting or turned down, it was never in the summary of old jobs'
    // labour, so nothing there changes.
    patchOlder(id, patch);
    render();
    write(id, patch, 'rejecting');
  };

  // ------------------------------------------------------------ date ranges
  //
  // Jonah (14 Oct 2026): "make it so i can check the hours worked from any
  // set date to another date. not just last week, two weeks, month etc."
  // Every list of hours on the Clock tab -- Hours & Wages, a person's page,
  // Paychecks and the Work log -- offers the same choices, "Pick dates…"
  // among them (From and To, both days counted), and works them out here,
  // so a week is the same week on all four. Each place keeps its own choice
  // on this device; the last dates picked anywhere are offered first when
  // another place is switched to dates, so they can be compared side by side.
  //
  // A shift belongs to the day it STARTED (as the work log has always filed
  // it): a storm from 10 pm to 4 am is one night's work, in one range.
  const RANGES = [
    ['today', 'Today'], ['week', 'This week'], ['lastweek', 'Last week'],
    ['twoweeks', 'This week & last'], ['month', 'This month'], ['lastmonth', 'Last month'],
    ['year', 'This year'], ['all', 'All time'], ['custom', 'Pick dates…'],
  ];
  const RANGE_DEFAULT = { totals: 'week', worker: 'week', pay: 'month', worklog: 'week' };
  const RANGE_KEY = 'ydjobhub_hoursRange';
  // A real day typed in full. A date box being typed into passes through
  // years like 0002 on the way to 2026, and one of those would send the
  // office off reading every shift ever kept (olderFor).
  const isDay = s => typeof s === 'string' && /^(19|20|21)\d\d-\d\d-\d\d$/.test(s) &&
    !isNaN(new Date(s + 'T00:00:00').getTime());
  const dayStr = d => d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  // Days are added on the calendar, never as 24 hours: two days a year are
  // 23 or 25 hours long, and the last hour of the day the clocks go back
  // used to fall out of a range.
  const plusDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };

  let rangeMem = null;            // place -> { range, from, to }, and `last` dates picked
  function rangeStore() {
    if (rangeMem) return rangeMem;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(RANGE_KEY) || 'null'); } catch (e) { saved = null; }
    rangeMem = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    return rangeMem;
  }
  function rangeOf(place) {
    const s = rangeStore()[place] || {};
    return {
      range: RANGES.some(r => r[0] === s.range) ? s.range : (RANGE_DEFAULT[place] || 'week'),
      from: isDay(s.from) ? s.from : '',
      to: isDay(s.to) ? s.to : '',
    };
  }
  function keepRange(place, r) {
    const all = rangeStore();
    all[place] = { range: r.range, from: r.from, to: r.to };
    if (r.range === 'custom' && (r.from || r.to)) all.last = { from: r.from, to: r.to };
    try { localStorage.setItem(RANGE_KEY, JSON.stringify(all)); } catch (e) { /* private window: this visit only */ }
  }

  // [from, to) in milliseconds, local time. `to` is Infinity for a range
  // still running (nothing can have started in the future anyway).
  function rangeBounds(r) {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const sunday = plusDays(d, -d.getDay());
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    switch (r.range) {
      case 'today': return [d.getTime(), plusDays(d, 1).getTime()];
      case 'week': return [sunday.getTime(), Infinity];
      case 'lastweek': return [plusDays(sunday, -7).getTime(), sunday.getTime()];
      case 'twoweeks': return [plusDays(sunday, -7).getTime(), Infinity];
      case 'month': return [first.getTime(), Infinity];
      case 'lastmonth': return [new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(), first.getTime()];
      case 'year': return [new Date(d.getFullYear(), 0, 1).getTime(), Infinity];
      case 'custom': {
        const lo = r.from ? new Date(r.from + 'T00:00:00').getTime() : 0;
        const hi = r.to ? plusDays(new Date(r.to + 'T00:00:00'), 1).getTime() : Infinity;
        return [lo, hi];
      }
      default: return [0, Infinity];
    }
  }

  // The days a range covers, in words -- so "This week" says which week.
  function rangeWords(r) {
    const [lo, hi] = rangeBounds(r);
    if (!lo && !isFinite(hi)) return 'Every date';
    const year = new Date().getFullYear();
    const fmt = t => {
      const d = new Date(t);
      return d.toLocaleDateString('en-US', d.getFullYear() === year
        ? { weekday: 'short', month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' });
    };
    if (!lo) return 'Up to ' + fmt(hi - 1);
    const today = dayStr(new Date());
    // Still running: up to today.
    if (!isFinite(hi)) {
      return lo > Date.now() ? 'From ' + fmt(lo)
        : dayStr(new Date(lo)) === today ? 'Today' : fmt(lo) + ' – today';
    }
    const last = hi - 1;
    return dayStr(new Date(lo)) === dayStr(new Date(last)) ? fmt(lo) : fmt(lo) + ' – ' + fmt(last);
  }

  // The control itself: the choices, and From/To when picking dates. Each
  // place draws it where its old buttons were and redraws through
  // rangeRedraw (registered with YDHoursRange.onChange).
  const rangeRedraw = {};
  function rangeBarHtml(place) {
    const r = rangeOf(place), p = safeId(place);
    // No latest day: "the 1st to the 31st" can be picked mid-month.
    return '<span class="hr-range">' +
      '<select onchange="ydRangeSet(\'' + p + '\', \'range\', this.value)" aria-label="Which days">' +
        RANGES.map(([v, t]) => '<option value="' + v + '"' + (r.range === v ? ' selected' : '') + '>' + t + '</option>').join('') +
      '</select>' +
      (r.range === 'custom'
        ? '<label class="hr-day"><span>From</span><input type="date" value="' + r.from +
            '" onchange="ydRangeSet(\'' + p + '\', \'from\', this.value)"></label>' +
          '<label class="hr-day"><span>To</span><input type="date" value="' + r.to +
            '" onchange="ydRangeSet(\'' + p + '\', \'to\', this.value)"></label>'
        : '') +
      '<span class="hr-words">' + esc(rangeWords(r)) + '</span>' +
    '</span>';
  }

  // A date typed key by key changes several times on the way to the one
  // meant; the hours are worked out once it settles.
  const rangeTimers = {};
  window.ydRangeSet = function (place, what, value) {
    if (!RANGE_DEFAULT[place]) return;
    const r = rangeOf(place);
    if (what === 'range') {
      if (!RANGES.some(x => x[0] === value)) return;
      if (value === 'custom' && r.range !== 'custom' && !r.from && !r.to) {
        // Something to start from: the dates last picked anywhere, else the
        // days of the range being left (a week to nudge), else this month.
        const last = rangeStore().last || {};
        const [lo, hi] = rangeBounds(r);
        if (isDay(last.from) || isDay(last.to)) { r.from = isDay(last.from) ? last.from : ''; r.to = isDay(last.to) ? last.to : ''; }
        else if (lo) { r.from = dayStr(new Date(lo)); r.to = dayStr(new Date(Math.min(isFinite(hi) ? hi - 1 : Date.now(), Date.now()))); }
        else { r.from = dayStr(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); r.to = dayStr(new Date()); }
      }
      r.range = value;
    } else if (what === 'from' || what === 'to') {
      // An emptied box is "from the start" or "up to today"; anything not yet
      // a whole date is waited for.
      if (value && !isDay(value)) return;
      r[what] = value || '';
    } else return;
    // From after To is read as the days between them, the right way round.
    let swapped = false;
    if (r.from && r.to && r.from > r.to) { const t = r.from; r.from = r.to; r.to = t; swapped = true; }
    keepRange(place, r);
    clearTimeout(rangeTimers[place]);
    const redraw = () => { if (rangeRedraw[place]) rangeRedraw[place](what === 'range' || swapped); };
    if (what === 'range') redraw();
    else rangeTimers[place] = setTimeout(redraw, 350);
  };

  // Draws a place's range control into `holder`, unless one of its date
  // boxes is being typed into: replacing it then would throw the typing away.
  function placeRangeBar(holder, place, force) {
    if (!holder) return;
    const html = rangeBarHtml(place);
    if (holder.dataset.drawn === html) return;
    if (!force && holder.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') {
      freshWords(holder, place);
      return;
    }
    holder.innerHTML = html;
    holder.dataset.drawn = html;
  }
  // The days in words, put right without touching the boxes beside them.
  function freshWords(holder, place) {
    const w = holder && holder.querySelector('.hr-words');
    if (w) w.textContent = rangeWords(rangeOf(place));
  }

  window.YDHoursRange = {
    get: rangeOf,
    bounds: place => rangeBounds(rangeOf(place)),
    words: place => rangeWords(rangeOf(place)),
    barHtml: rangeBarHtml,
    place: placeRangeBar,
    freshWords: freshWords,
    onChange: (place, fn) => { rangeRedraw[place] = fn; },
    dayStr: dayStr,
  };
  rangeRedraw.totals = force => { placeRangeBar(el('clockRangeBar'), 'totals', force); renderTotals(); };
  rangeRedraw.worker = force => renderWorker(force);

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
            // Jonah (12 Oct 2026): "mark profiles in the app as crew members"
            // -- they see every crew task (the Crew tasks calendar is shared
            // with them) and are reminded of the ones nobody is on.
            '<button class="btn btn-sm crew-flag' + (YDRemind.isCrewMember(u) ? ' on' : '') +
              '" onclick="toggleCrewMember(\'' + safeId(u.uid) + '\')" title="Crew members see every crew task">' +
              (YDRemind.isCrewMember(u) ? '👷 Crew member' : '+ Crew member') + '</button>' +
            '<button class="btn btn-sm" onclick="openAccess(\'' + safeId(u.uid) + '\')">' +
              (u.role === 'admin' ? 'Access' : 'Make admin…') + '</button>' +
            '<button class="btn btn-sm" onclick="renameWorker(\'' + safeId(u.uid) + '\')">Rename</button>' +
            '<button class="btn btn-sm" onclick="setWorkerRate(\'' + safeId(u.uid) + '\')">' +
              money(rateOf(u.uid)) + '/hr</button>' +
            '<button class="remove-btn" onclick="removeCrew(\'' + safeId(u.uid) + '\')" title="Switch off">&times;</button>' +
          '</div>').join('')
        : '<p class="empty-msg">No crew yet. Send them the app link and ask them to ' +
          'sign in with Google — they will show up here to let in.</p>') +
      // The clock's own setting (see "the clock stops itself").
      '<div class="crew-row crew-setting">' +
        '<span class="crew-name">⏱ Forgot to clock out</span>' +
        '<span class="crew-mail">A shift stops by itself after <b>' + hoursWord(autoOutHours) +
          '</b> on the clock and comes to you to check. They and you get a notification.</span>' +
        '<button class="btn btn-sm" onclick="setAutoOutHours()">Change</button>' +
      '</div>';
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
    // Runs of spaces squeezed to one: "Alex  Test" is not a second person.
    const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!clean) { showToast('A name cannot be blank'); return; }
    setRole(uid, { name: clean }, 'Renamed to ' + clean);
  };

  window.toggleCrewMember = function (uid) {
    const u = people[uid];
    if (!u || !isOwner()) return;
    const on = !YDRemind.isCrewMember(u);
    setRole(uid, { crewMember: on }, (u.name || u.email) + (on
      ? ' is crew — they see every crew task' : ' is not crew any more'));
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
    // Jonah (12 Oct 2026): who sees and who changes each board is his to say
    // -- or an admin's he gives it to. Never a private board, never Private.
    { id: 'boardSharing', label: 'Board sharing', hint: 'Who sees each board and who can add & change its cards — never your private boards. Needs Boards: Change',
      levels: ['none', 'change'], words: { none: 'Off', change: 'On' } },
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
            (a.levels || ['none', 'see', 'change']).map(l =>
              '<label class="acc-opt' + (l === lv ? ' on' : '') + '"><input type="radio" name="acc-' + a.id + '" value="' + l + '"' +
                (l === lv ? ' checked' : '') + ' onchange="accessPicked(this)">' + (a.words || LEVEL_WORDS)[l] + '</label>').join('') +
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
          .map(a => a.levels ? 'set ' + a.label.toLowerCase() : (access[a.id] === 'change' ? 'change ' : 'see ') + a.label.toLowerCase()).join(', ') + '.'
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

  // Everyone's counted hours in the chosen days, one row a person -- what
  // Hours & Wages shows and what its spreadsheet holds.
  function totalsFor(from, to) {
    const pool = Object.values(known());
    const inRange = e => startMsOf(e) >= from && startMsOf(e) < to;
    const done = pool.filter(e => counts(e) && inRange(e));
    const pending = pool.filter(e => awaitingOwner(e) && inRange(e));
    const byWorker = {};
    done.forEach(e => {
      const w = byWorker[e.uid] = byWorker[e.uid] ||
        { name: workerOf(e), uid: e.uid, paid: 0, bill: 0, cost: 0, shifts: 0, days: new Set(), waiting: 0 };
      w.paid += paidMs(e); w.bill += chargeableMs(e); w.shifts++;
      w.days.add(YDHoursRange.dayStr(new Date(startMsOf(e))));
      w.cost += e.costCents != null ? e.costCents
        : costOf(paidMs(e), e.rateCents || rateOf(e.uid));
    });
    pending.forEach(e => { if (byWorker[e.uid]) byWorker[e.uid].waiting += paidMs(e); });
    const list = Object.values(byWorker).sort((a, b) => b.paid - a.paid);
    return { done: done, pending: pending, list: list, totalCost: list.reduce((s, w) => s + w.cost, 0) };
  }

  function renderTotals() {
    const wrap = el('totalsWrap');
    if (!wrap) return;
    placeRangeBar(el('clockRangeBar'), 'totals');
    const [from, to] = rangeBounds(rangeOf('totals'));

    // All time reaches back past the shifts kept live: the older ones are
    // read once, and this is drawn again when they land (render).
    const olderNow = olderFor(from);
    const t = totalsFor(from, to);
    const list = t.list, totalCost = t.totalCost, pending = t.pending;

    const badge = el('totalsBadge');
    if (badge) badge.textContent = totalCost ? money(totalCost) : '';

    // Only someone who may change pay gets the rate as a button to change it.
    const rateCell = w => decides() && (isOwner() || w.uid !== (me() || {}).uid)
      ? '<button class="btn btn-sm" onclick="setWorkerRate(\'' + safeId(w.uid) + '\')">' + money(rateOf(w.uid)) + '/hr</button>'
      : money(rateOf(w.uid)) + '/hr';
    wrap.innerHTML = olderNote(olderNow) + (list.length
      ? '<div class="table-wrap"><table><thead><tr><th>Worker</th><th>Paid</th>' +
        '<th>Billable</th><th>Rate</th><th>Cost</th></tr></thead><tbody>' +
        list.map(w =>
          '<tr><td class="bold"><button class="linkish" onclick="openWorker(\'' + safeId(w.uid) + '\')">' + esc(w.name) + '</button>' +
            '<span class="shift-time">' + w.days.size + ' day' + (w.days.size === 1 ? '' : 's') + '</span></td>' +
          '<td>' + fmtDur(w.paid) + '</td>' +
          '<td>' + fmtDur(w.bill) + '</td>' +
          '<td>' + rateCell(w) + '</td>' +
          '<td class="bold">' + money(w.cost) + '</td></tr>').join('') +
        '</tbody><tfoot><tr><td colspan="4" style="text-align:right;font-weight:700">Total</td>' +
        '<td style="font-weight:700">' + money(totalCost) + '</td></tr></tfoot></table></div>'
      : '<p class="empty-msg">No approved hours on these days.</p>') +
      whereItWentHtml(t.done) +
      (pending.length
        ? '<p class="hint">' + pending.length + ' shift' + (pending.length === 1 ? '' : 's') +
          ' still waiting for approval. Those are not counted above, or on any job.</p>'
        : '') +
      // Only with every shift in the range here (the work log's rule): a
      // sheet missing the older ones would not say so.
      (list.length && olderNow === 'ready'
        ? '<div class="field-actions"><button class="btn btn-sm" onclick="exportTotals()">⬇ Spreadsheet of these hours</button></div>' : '');
  }

  // Payroll for the chosen days, one line a person: hours as plain decimals
  // (7.75, not 7h 45m), the rate and the wages. BOM and CRLF so Excel opens
  // it right, the same as the work log's sheet; text cells guarded the same
  // way against being run as formulas.
  window.exportTotals = function () {
    if (!seesAll()) return;
    const [from, to] = rangeBounds(rangeOf('totals'));
    if (olderFor(from) !== 'ready') { showToast('Older shifts are still loading — try again in a moment'); return; }
    const t = totalsFor(from, to);
    if (!t.list.length) return;
    const dec = milli => (Math.round(milli / 36000) / 100).toFixed(2);
    const cell = v => { const s = String(v == null ? '' : v); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
    const q = v => '"' + cell(v).replace(/"/g, '""') + '"';
    const rows = [['Worker', 'Days', 'Shifts', 'Hours worked', 'Billable hours', 'Rate per hour', 'Wages',
                   'Hours waiting for approval']]
      .concat(t.list.map(w => [w.name, w.days.size, w.shifts, dec(w.paid), dec(w.bill),
        (rateOf(w.uid) / 100).toFixed(2), (w.cost / 100).toFixed(2), dec(w.waiting)]))
      .concat([['Total', '', t.list.reduce((s, w) => s + w.shifts, 0), dec(t.list.reduce((s, w) => s + w.paid, 0)),
        dec(t.list.reduce((s, w) => s + w.bill, 0)), '', (t.totalCost / 100).toFixed(2),
        dec(t.list.reduce((s, w) => s + w.waiting, 0))]]);
    const blob = new Blob(['\uFEFF' + rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'hours-and-wages-' + (from ? YDHoursRange.dayStr(new Date(from)) : 'start') + '-to-' +
      YDHoursRange.dayStr(new Date(isFinite(to) ? Math.min(to - 1, Date.now()) : Date.now())) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

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

  window.openWorker = function (uid) {
    workerUid = uid || ((me() || {}).uid);
    // The days shown are the ones last picked here, on this device (date
    // ranges, above): looking at one person's month, then the next's, is the
    // usual way round.
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
    if (fixingIn === 'worker') { fixingId = null; fixingIn = null; }
  };

  function renderWorker(forceBar) {
    const body = el('workerBody');
    if (!body || !workerUid) return;
    // Three parts, so the days being picked are never rebuilt from under a
    // date being typed (placeRangeBar) while the rest is drawn again.
    if (!el('wkMain') || !body.contains(el('wkMain'))) {
      body.innerHTML = '<div id="wkHead"></div><div class="filter-bar wk-range" id="wkRangeBar"></div><div id="wkMain"></div>';
    }
    const u = people[workerUid] || {};
    const isMe = workerUid === ((me() || {}).uid);
    const name = u.name || u.email || (isMe ? 'My hours' : 'Worker');

    const title = el('workerTitle');
    if (title) title.textContent = name;

    const [from, to] = rangeBounds(rangeOf('worker'));
    // All time reaches back past the shifts kept live: the older ones are
    // read once, and this is drawn again when they land (render).
    const olderNow = olderFor(from);
    const pool = known();
    const all = Object.values(pool).filter(e => e.uid === workerUid);
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
    // Somebody else's, for whoever settles their shifts: the times changed
    // by hand (the owner's own, too).
    const fixable = !askable && decides() && (isOwner() || !isMe);
    el('wkHead').innerHTML =
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
        : '');
    placeRangeBar(el('wkRangeBar'), 'worker', forceBar === true);
    el('wkMain').innerHTML =
      olderNote(olderNow) +

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

      (askable && asking && pool[asking] ? askHtml(pool[asking]) : '') +
      (fixingIn === 'worker' && fixingId && pool[fixingId] && pool[fixingId].uid === workerUid && mayDecide(pool[fixingId])
        ? fixHtml(pool[fixingId]) : '') +
      '<div class="wk-head">Every shift' +
        (fixable && people[workerUid]
          ? ' <button class="link-btn" onclick="addShiftFor(\'' + safeId(workerUid) + '\')">+ Add a shift ' +
              (isMe ? 'I' : 'they') + ' forgot to clock</button>' : '') + '</div>' +
      (inRange.length
        ? '<div class="table-wrap"><table><thead><tr><th>When</th><th>What</th>' +
          '<th>Paid</th><th>Billable</th><th></th>' + (askable || fixable ? '<th></th>' : '') + '</tr></thead><tbody>' +
          inRange.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
            .map(e => shiftRow(e, askable, fixable)).join('') +
          '</tbody></table></div>'
        : '<p class="empty-msg">No shifts on these days.</p>') +
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
    // A time left as it was is the time it was, to the second: the boxes
    // show whole minutes, and reading them back moved an untouched start
    // or end by up to a minute -- so "no change" was never seen as one.
    const same = (iso, time) => !!iso && hm(iso) === String(time || '') ? new Date(iso) : null;
    const start = same(e.startedAt, startTime) || nearTime(e.startedAt, startTime);
    let end = start && (same(e.endedAt, endTime) || nearTime(e.endedAt || e.startedAt, endTime));
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
    const e = entries[asking] || older[asking], u = me();
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
    if ('saltLbs' in a ? figure(a.saltLbs) !== figure(b.saltLbs) : figure(a.saltBags) !== figure(b.saltBags)) {
      bits.push('saltLbs' in a
        ? esc(String(figure(b.saltLbs) != null ? figure(b.saltLbs) : '–')) + ' → <b>' + esc(String(figure(a.saltLbs))) + ' lb salt</b>'
        : esc(String(figure(b.saltBags) != null ? figure(b.saltBags) : 0)) + ' → <b>' + esc(String(figure(a.saltBags))) + ' bags</b>');
    }
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
    const e = entries[r.targetId] || older[r.targetId];
    if (e || !windowed) { applyRequest(r, e); return; }
    // A shift from before the clock's cutoff, not read on this device: read
    // just that one (a crew phone holds all of its own, however old).
    if (deciding.has(r.id)) return;
    deciding.add(r.id);
    Promise.resolve(window.YDDb.get('timeEntries', r.targetId))
      .then(d => applyRequest(r, d ? Object.assign({ id: r.targetId }, d) : null))
      .catch(() => showToast('That shift could not be read — try again with a signal'))
      .then(() => deciding.delete(r.id));
  };
  function applyRequest(r, e) {
    const id = r.id;
    if (r.status !== 'pending') return;      // decided meanwhile
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
    const wasOld = isOld(e);
    Object.assign(e, patch);
    patchOlder(e.id, patch);
    write(e.id, patch, 'applying a change');
    // From before the clock's cutoff, then or now: the summary of old jobs'
    // labour no longer adds up (marked after the shift's own write).
    if (wasOld || isOld(e)) markStale();
    r.status = 'approved';
    writeRequest(id, { status: 'approved', decidedBy: (me() || {}).uid || '', decidedAt: nowIso() }, 'approving a change');
    render();
    if (typeof refreshJobLabour === 'function') refreshJobLabour();
    showToast('Changed — ' + fmtDur(paidMs(e)) + ' for ' + workerOf(e));
  }
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
    // the stop itself before anything changes (billing.js fixVisit, which
    // also reads an old storm's shifts first: olderReady).
    // Pounds; a request from before salt was weighed leaves the salt alone.
    YDBilling.fixVisit(r.stormId, r.targetId, figure(a.inchesCleared), 'saltLbs' in a ? figure(a.saltLbs) : undefined, (me() || {}).uid || '',
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

  function shiftRow(e, askable, fixable) {
    const pause = pausedMs(e);
    const when = new Date(e.startedAt);
    return '<tr class="shift-' + e.status + '">' +
      '<td>' + when.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }) +
        '<span class="shift-time">' + clockTime(e.startedAt) +
        // The end's day too when it is the next one: "10:00 PM–2:00 PM" read
        // as a shift going backwards.
        (!e.endedAt ? ' — still on'
          : '–' + (new Date(e.endedAt).toDateString() !== when.toDateString()
            ? new Date(e.endedAt).toLocaleDateString('en-US', { weekday: 'short' }) + ' ' : '') + clockTime(e.endedAt)) +
        '</span></td>' +
      '<td class="bold">' + esc(e.targetName) +
        (pause ? '<span class="shift-pause">' + fmtDur(pause) + ' paused</span>' : '') +
        (autoStopped(e) ? '<span class="shift-pause">⏱ no clock-out — stopped by the clock</span>' : '') + '</td>' +
      '<td>' + fmtDur(paidMs(e)) + '</td>' +
      '<td>' + (canPause(e) ? fmtDur(billableMs(e)) : '—') + '</td>' +
      '<td><span class="shift-flag ' + e.status + '">' +
        (running(e) ? 'on the clock'
          : e.status === 'ok' ? 'counted'
          : e.status === 'approved' ? 'approved'
          : e.status === 'rejected' ? 'rejected'
          : 'waiting') + '</span></td>' +
      // Not on a rejected one: a change to it would still leave it rejected.
      (askable ? '<td>' + (running(e) || !e.endedAt || e.status === 'rejected' ? ''
        : pendingFor(e.id) ? '<span class="muted">change asked</span>'
        : '<button class="link-btn" onclick="askChange(\'' + safeId(e.id) + '\')">Ask for a change</button>') + '</td>' : '') +
      (fixable && !askable ? '<td>' + (running(e) || !e.endedAt || e.status === 'rejected' || !mayDecide(e) ? ''
        : '<button class="link-btn" onclick="fixTimes(\'' + safeId(e.id) + '\')">Change times</button>') + '</td>' : '') +
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
    const name = canName ? ((el('wkName') || {}).value || '').trim().replace(/\s+/g, ' ').slice(0, 60) : null;
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

  // ----------------------------------------------------------- older shifts
  //
  // timeEntries only ever grows, and the owner's and admins' devices used to
  // watch all of it: every opening of the app after half an hour away read
  // every shift ever clocked again (Firestore bills per document), and every
  // screen walked the lot (review, 12 Oct). Now they keep live only the
  // shifts that started on or after `cutoff` -- 1 January of LAST year, so
  // this season and last are always whole -- plus every shift still waiting
  // for approval, however old, so Waiting for You never misses one. Two
  // questions on one field each, so no index has to be made for them.
  //
  // Anything older comes one of two ways:
  //   - the labour on old jobs, from ONE record, labour/before: every counted
  //     shift from before the cutoff added up per job and person by the
  //     owner's device, with exactly the sums sumJob does. It is worked out
  //     again when the cutoff moves on (a new year) or an old shift changes
  //     -- whoever changes one marks the record out of date (markStale);
  //   - the shifts themselves, read once (not watched) the first time
  //     somebody looks back that far: the work log's All time or older
  //     dates, a person's All time, a fix to an old storm's visit. Until a
  //     summary is there to use, old jobs' labour is worked out from these.
  const ROLL_PATH = 'labour', ROLL_ID = 'before';
  const ROLL_V = 1;              // the record's shape; a summary of another shape is worked out again
  // This page, as against any other device: whose "out of date" mark is whose.
  const DEVICE = 'd' + Math.random().toString(36).slice(2, 10);
  // Midnight UTC on 1 January of last year. The same on every device in any
  // time zone: two devices that put the line in different places would each
  // find the other's summary unusable and work it out again for ever. It is
  // only where "recent" starts, so it need not fall on a local midnight.
  const cutoffNow = () => Date.UTC(new Date().getUTCFullYear() - 1, 0, 1);
  let cutoff = 0;                // cutoffNow() as the watches started
  let windowed = false;          // this device keeps only the recent shifts live
  let recent = {}, waiting = {}; // what each of the two live questions has answered
  let liveFresh = false;         // the recent list's last answer came from the server
  let older = {};                // id -> shift from before the cutoff, once read
  let olderState = null;         // null | 'loading' | 'done' | 'failed'
  let olderGen = 0;              // moved on whatever was read is let go
  let olderFresh = false;        // read while connected: fit to make the summary from
  let olderWaiters = [];
  let olderWanted = false;       // old jobs' labour asked for with no summary to use
  let roll = null;               // labour/before as last heard
  let rollAnswered = false;      // any answer about it yet, even from this device's cache
  let rollHeard = false, rollFailed = false, rollIndex = null;
  let serverSlow = false;        // no word from the server about it for a while: no signal, most likely
  let lastMark;                  // the summary's "out of date" mark (staleAt) as last heard here
  let building = false, buildFailed = false;

  const isOld = e => !!e && startMsOf(e) < cutoff;
  const relabour = () => { if (typeof refreshJobLabour === 'function') refreshJobLabour(); };

  // A shift either live question has is in `entries`. One the recent list
  // drops stays while the waiting list still has it, and the other way round
  // (receipts.js keeps its two lists the same way).
  function settle(id) {
    const e = recent[id] || waiting[id];
    if (e) entries[id] = e; else delete entries[id];
  }
  function take(src, changes) {
    changes.forEach(c => {
      if (c.type === 'removed') {
        const was = src[c.id];
        delete src[c.id];
        // In neither list now: an old shift no longer waiting (approved or
        // turned down, perhaps on another device), or one whose start was
        // moved back before the cutoff. With the older ones read, it is kept
        // among them as this device last had it (its own change already on
        // it), and read again to be sure.
        if (!recent[c.id] && !waiting[c.id] && olderState === 'done') {
          if (isOld(was)) older[c.id] = was;
          readAgain(c.id);
        }
      } else {
        src[c.id] = Object.assign({ id: c.id }, c.data);
      }
      settle(c.id);
    });
  }
  function readAgain(id) {
    if (olderState !== 'done' || !window.YDDb) return;
    const gen = olderGen;
    Promise.resolve(window.YDDb.get('timeEntries', id)).then(d => {
      if (gen !== olderGen) return;
      if (d && isOld(d)) older[id] = Object.assign({ id: id }, d); else delete older[id];
      render(); relabour(); announce();
    }).catch(() => { /* no signal: the copy read before stands */ });
  }
  // This device changed a shift: the copy read with the older ones, too.
  function patchOlder(id, patch) {
    if (older[id] && older[id] !== entries[id]) Object.assign(older[id], patch);
  }

  // Every shift this device has: the live ones, and the older ones once read.
  // A live copy wins over a read one -- it is the newer of the two.
  function known() {
    return olderState === 'done' ? Object.assign({}, older, entries) : entries;
  }

  // Whether every shift from `from` (ms) on is here: 'ready'; 'loading' (and
  // now asked for); or 'failed', until Try again.
  function olderFor(from) {
    if (!windowed || !(from < cutoff) || olderState === 'done') return 'ready';
    if (olderState === 'failed') return 'failed';
    loadOlder();
    return olderState === 'loading' ? 'loading' : 'failed';
  }
  // The same, for code that has to wait for them. Settles with the state.
  function olderReady(from) {
    const state = olderFor(from);
    if (state !== 'loading') return Promise.resolve(state);
    return new Promise(res => olderWaiters.push(res));
  }
  // What a screen looking back that far says meanwhile.
  function olderNote(state) {
    return state === 'loading' ? '<div class="hint">Loading older shifts…</div>'
      : state === 'failed' ? '<div class="hint">Older shifts could not be read. ' +
          '<button class="link-btn" onclick="clockOlderAgain()">Try again</button></div>'
      : '';
  }
  window.clockOlderAgain = function () {
    if (olderState !== 'failed') return;
    olderState = null;
    loadOlder();
    render(); announce();
  };

  // Read once, not watched: nothing new starts that far back. A failure is
  // left as it is until Try again -- read again by itself, every redraw
  // would ask the server for all of them once more.
  function loadOlder() {
    if (!windowed || olderState === 'loading' || olderState === 'done' || olderState === 'failed') return;
    if (!window.YDDb || !window.YDDb.listWhere) return;
    olderState = 'loading';
    const gen = olderGen, freshAtStart = liveFresh;
    window.YDDb.listWhere('timeEntries', 'startedMs', '<', cutoff).then(got => {
      if (gen !== olderGen) return;          // let go meanwhile: signed out, or out of date
      older = {};
      Object.keys(got).forEach(id => { older[id] = Object.assign({ id: id }, got[id]); });
      olderState = 'done';
      // With no signal the answer is whatever this device had cached, which
      // may be only part of them: fine to look at, not to sum for good.
      olderFresh = freshAtStart && liveFresh;
      heardOlder();
    }).catch(err => {
      if (gen !== olderGen) return;
      olderState = 'failed';
      console.warn('[clock] older shifts not read:', (err && err.code) || err);
      heardOlder();
    });
  }
  function heardOlder() {
    const w = olderWaiters;
    olderWaiters = [];
    w.forEach(res => res(olderState === 'done' ? 'ready' : olderState));
    stampUnpriced();
    render(); relabour(); announce();
    checkOld();
  }
  // What was read may be out of date: let go, and read again when next
  // needed. A read still on its way is ignored when it lands.
  function dropOlder() {
    olderGen++;
    older = {}; olderState = null; olderFresh = false;
    forgetLabour();
    if (olderWaiters.length) loadOlder();
  }

  function rollUsable() {
    return !!(roll && roll.v === ROLL_V && roll.cutoff === cutoff && roll.stale !== true && Array.isArray(roll.jobs));
  }
  // Where the labour on old jobs comes from just now:
  //   'live'     nothing is left out on this device (crew, or an old firebase-init.js)
  //   'roll'     the summary, labour/before
  //   'raw'      the older shifts themselves, read
  //   'missing'  neither yet -- asked for (wantOlder)
  function oldSource() {
    if (!windowed) return 'live';
    if (rollUsable()) return 'roll';
    if (olderState === 'done') return 'raw';
    return 'missing';
  }
  function rollFor(jobId) {
    if (!rollIndex) {
      rollIndex = {};
      ((roll && roll.jobs) || []).forEach(j => { if (j && j.id) rollIndex[j.id] = j; });
    }
    return rollIndex[jobId] || null;
  }

  // The summary of the shifts from before the cutoff, added up exactly as
  // sumJob adds them: per job, per person -- by uid AND the name stamped on
  // the shift, which is what whoIs reads, so a later rename still shows
  // right -- the paid and billable hours, and the job's wage cost. A shift
  // whose figures can still move (no end yet, or neither a cost nor a rate
  // stamped, so priced at today's rate) is kept whole in `loose` and summed
  // the way a live one is. Shifts still waiting are not in it: they are live.
  function rollOf(list) {
    const jobs = {}, at = {};
    let counted = 0;
    list.forEach(e => {
      if (!isOld(e) || e.kind !== 'job' || !e.targetId || !counts(e)) return;
      counted++;
      const j = jobs[e.targetId] = jobs[e.targetId] || { id: e.targetId, cost: 0, rows: [], loose: [] };
      if (endMsOf(e) == null || (e.costCents == null && !e.rateCents)) {
        j.loose.push(JSON.parse(JSON.stringify(e)));     // no undefined can reach the write
        return;
      }
      const key = e.targetId + '\u0001' + (e.uid || '') + '\u0001' + (e.workerName || '');
      let row = at[key];
      if (!row) { row = at[key] = { uid: e.uid || '', name: e.workerName || '', paid: 0, billable: 0 }; j.rows.push(row); }
      row.paid += e.paidHours != null ? e.paidHours : hours(paidMs(e));
      row.billable += e.billableHours != null ? e.billableHours : hours(billableMs(e));
      j.cost += e.costCents != null ? e.costCents : costOf(paidMs(e), e.rateCents || rateOf(e.uid));
    });
    return { jobs: Object.keys(jobs).map(id => jobs[id]), counted: counted };
  }

  // The owner's device works the summary out -- from the older shifts read
  // while connected, after pricing any settled one never priced (as
  // stampUnpriced always has: the figures are then the same ones the old
  // whole-collection device came to). Written in one step that first checks
  // the record's "out of date" mark is still the one this device had heard
  // when it started -- any other mark, another device's or a later one of
  // its own (a second old shift approved while this was being worked out),
  // is a change these sums may not hold, so nothing is written and it is
  // worked out again. The mark and who made it are left on the record, so
  // every device can still tell a mark it has not heard of from one it has.
  function buildRoll() {
    building = true;
    stampUnpriced();
    // The live ones too: an old shift approved here a moment ago is still
    // in the waiting list until the server says otherwise.
    const made = rollOf(Object.values(known()));
    const doc = { v: ROLL_V, cutoff: cutoff, builtAt: nowIso(), counted: made.counted, jobs: made.jobs, stale: false };
    const basis = lastMark === undefined ? null : lastMark, key = watchKey;
    const write = window.YDDb.transact
      ? window.YDDb.transact([[ROLL_PATH, ROLL_ID]], ([cur]) => {
          const unheard = !!cur && (cur.staleAt || null) !== basis;
          return [unheard ? null : doc];
        })
      : window.YDDb.put(ROLL_PATH, ROLL_ID, doc);
    Promise.resolve(write).then(res => {
      if (key !== watchKey) return;
      building = false;
      // A mark this device had not heard of when it started: another
      // device's is answered by the summary watch (the older shifts read
      // again); its own, by working it out again. Looked at again shortly
      // either way, in case it came while this was being written.
      if (window.YDDb.transact && !(res && res[0])) setTimeout(checkOld, 3000);
    }).catch(err => {
      if (key !== watchKey) return;
      // Most likely no signal, or the rules for it not yet published. The
      // older shifts are here, so old jobs' labour is still right on this
      // device; it is tried again next time the app opens.
      building = false; buildFailed = true;
      console.warn('[clock] old jobs’ labour not summed:', (err && err.code) || err);
    });
  }

  // This device changed a shift from before the cutoff, so the summary no
  // longer adds up: marked out of date -- when, and by which device -- so
  // the owner's device works it out again and any device holding the older
  // shifts reads them again. Every change marks it, not only the first: a
  // device that read them between two changes must hear of the second.
  function markStale() {
    if (!windowed || !window.YDDb || rollFailed) return;   // unreadable: its rules not published yet
    // None made yet: the owner's device makes one anyway (and an admin may
    // not start the record). The owner's own device marks it regardless --
    // the one it has just written may not have come back to it yet.
    if (rollHeard && !roll && !isOwner()) return;
    // Never the same mark twice, even for two changes in one millisecond: a
    // summary being worked out is checked against the mark it started from.
    const mark = { stale: true, staleAt: Math.max(Date.now(), (lastMark || 0) + 1), staleBy: DEVICE };
    if (roll) roll = Object.assign({}, roll, mark);
    lastMark = mark.staleAt;
    rollIndex = null;
    forgetLabour();
    Promise.resolve(window.YDDb.put(ROLL_PATH, ROLL_ID, mark))
      .catch(err => console.warn('[clock] old jobs’ labour not marked out of date:', (err && err.code) || err));
    checkOld();
  }

  // Run whenever the summary, the older shifts, the people or the rates come
  // in. The owner's device makes the summary when there is none to use; any
  // other device -- or the owner's, until it can -- reads the older shifts
  // instead, once old jobs' labour has been asked for.
  function checkOld() {
    if (!windowed || building || !rollAnswered || rollUsable()) return;
    // A summary to a LATER cutoff: the year has moved on here too (start
    // again with it), or this device's clock says otherwise -- then it is
    // never replaced from here, or two devices that disagree would each undo
    // the other's for ever; the older shifts are read instead.
    const later = !!(roll && typeof roll.cutoff === 'number' && roll.cutoff > cutoff);
    if (later && newYear()) return;
    // Pricing never-priced shifts needs everyone's rate, and the summary
    // must come from what the server holds, not one phone's part-copy.
    if (!later && rollHeard && isOwner() && !rollFailed && !buildFailed &&
        usersLoaded && ratesLoaded && liveFresh) {
      if (olderState === 'done' && !olderFresh) dropOlder();
      if (olderState === 'done') { buildRoll(); return; }
      loadOlder();                           // checkOld again when they land
      return;
    }
    if (!olderWanted) return;
    // Read with no signal before: again, now there is one.
    if (olderState === 'done' && !olderFresh && liveFresh && (rollHeard || rollFailed)) dropOlder();
    // Once the server has said there is no summary to use -- or, with no
    // signal, from what this device has, rather than show old jobs short.
    if (rollHeard || rollFailed || serverSlow || navigator.onLine === false) loadOlder();
  }
  function wantOlder() {
    if (olderWanted) return;
    olderWanted = true;
    checkOld();
  }

  // The year has moved on since the watches started -- the app left open
  // over New Year, or another device already summed up to the new cutoff:
  // everything starts again with the new one. Looked at whenever the app
  // comes back on screen, too.
  function newYear() {
    if (!watchKey || !windowed || cutoffNow() === cutoff) return false;
    setTimeout(() => {
      if (watchKey && windowed && cutoffNow() !== cutoff) { watchKey = null; start(); }
    }, 0);
    return true;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { newYear(); readAutoOut(); }
  });

  // For All Jobs and a job's labour: '' while every old job's labour is in
  // the figures; otherwise the same note the work log shows (Try again
  // included when the older shifts could not be read).
  function oldLabourNote() {
    if (oldSource() !== 'missing' || !olderWanted) return '';
    return olderNote(olderState === 'failed' ? 'failed' : 'loading');
  }

  // Back to nothing, for a sign-in or a sign-out.
  function resetOlder() {
    recent = {}; waiting = {}; liveFresh = false;
    olderGen++;
    older = {}; olderState = null; olderFresh = false; olderWanted = false;
    const w = olderWaiters;
    olderWaiters = [];
    w.forEach(res => res('failed'));
    roll = null; rollAnswered = false; rollHeard = false; rollFailed = false; rollIndex = null;
    serverSlow = false; lastMark = undefined;
    building = false; buildFailed = false;
  }

  // ------------------------------------------------- what other screens ask

  // All Jobs asks for every job's labour on each redraw and each letter typed
  // in its search, and walking every shift on record once per job made that
  // jobs x shifts. So the shifts are filed by job once, and each job's sums
  // are kept, until anything they are worked out from changes -- a shift, a
  // name, a rate, or where old jobs' labour comes from -- which always ends
  // in render() (forgetLabour there), or is noticed by forJob (jobFrom).
  let jobIndex = null;        // jobId -> its shifts, in the same order as before
  let jobSums = {};           // jobId -> forJob's answer
  let jobFrom = null;         // oldSource() when jobIndex was made
  function forgetLabour() { jobIndex = null; jobSums = {}; jobFrom = null; }
  function shiftsOnJob(jobId) {
    if (!jobIndex) {
      jobIndex = {};
      jobFrom = oldSource();
      const file = e => {
        if (e.kind !== 'job' || !e.targetId) return;
        // With the summary in use, a settled shift from before the cutoff
        // is already in it; only one still waiting is counted from here.
        if (jobFrom === 'roll' && isOld(e) && e.status !== 'pending') return;
        (jobIndex[e.targetId] = jobIndex[e.targetId] || []).push(e);
      };
      Object.values(entries).forEach(file);
      if (jobFrom === 'raw') Object.keys(older).forEach(id => { if (!entries[id]) file(older[id]); });
    }
    return jobIndex[jobId] || [];
  }

  // Approved hours only. Pending time is deliberately excluded from anything
  // that feeds money: a job whose profit moves on its own when a shift is
  // later rejected is a job whose numbers nobody trusts.
  //
  // A copy each time, so nothing a screen does with the answer can change
  // what the next one is given.
  //
  // Old jobs: the summary of the shifts before the cutoff plus the live ones
  // -- or, until there is one to use, the older shifts read (asked for here;
  // the screens are told again when they land).
  function forJob(jobId) {
    if (!jobId) return sumJob(null).out;
    const src = oldSource();
    if (src === 'missing') wantOlder();
    if (jobIndex && jobFrom !== src) forgetLabour();
    if (!jobSums[jobId]) {
      const r = sumJob(jobId);
      // A counted shift with no end is still growing by the second: worked
      // out fresh every time, as it always was, rather than kept.
      if (!r.steady) return r.out;
      jobSums[jobId] = r.out;
    }
    const s = jobSums[jobId], byWorker = {};
    Object.keys(s.byWorker).forEach(k => { byWorker[k] = Object.assign({}, s.byWorker[k]); });
    return Object.assign({}, s, { byWorker: byWorker });
  }

  function sumJob(jobId) {
    const out = { byWorker: {}, paidHours: 0, billableHours: 0, costCents: 0, pendingHours: 0 };
    let steady = true;
    if (!jobId) return { out: out, steady: steady };
    const add = e => {
      if ((awaitingOwner(e) || counts(e)) && endMsOf(e) == null) steady = false;
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
    };
    shiftsOnJob(jobId).forEach(add);
    // From the summary: the settled older shifts, already added up (named
    // as they would be now), and any whose figures can still move, added
    // like the live ones.
    const r = jobFrom === 'roll' ? rollFor(jobId) : null;
    if (r) {
      (r.loose || []).forEach(add);
      (r.rows || []).forEach(row => {
        const who = whoIs(row.uid, row.name);
        const w = out.byWorker[who] = out.byWorker[who] || { paid: 0, billable: 0 };
        w.paid += row.paid; w.billable += row.billable;
        out.paidHours += row.paid; out.billableHours += row.billable;
      });
      out.costCents += r.cost || 0;
    }
    out.paidHours = Math.round(out.paidHours * 100) / 100;
    out.billableHours = Math.round(out.billableHours * 100) / 100;
    out.pendingHours = Math.round(out.pendingHours * 100) / 100;
    return { out: out, steady: steady };
  }

  // Minutes a storm's crew were paused while inside one stop's window. The
  // snow billing subtracts this so a fuel stop during a driveway comes off
  // that customer's labour line, and one between driveways comes off nobody's.
  //
  // A BREAK counts the same way. It used to be a pause reason, and since
  // 9 Oct it is a clock-out (endedFor 'break') -- so it sits on no shift,
  // and the pauses alone no longer saw it: a crew member's lunch in the
  // middle of a driveway was billed to that customer. The break runs from
  // the end of that shift to the person's next shift of any kind (clocking
  // in anywhere ends a break, as breakOf has it). With no next shift yet it
  // runs to now, but never past BREAK_SHOW_HOURS -- the clock's own limit,
  // after which it stops being a break at all.
  function pausedMinutesAt(stormId, fromIso, toIso) {
    const lo = ms(fromIso), hi = ms(toIso);
    if (!(lo && hi && hi > lo)) return 0;
    const overlap = (a, b) => Math.max(0, Math.min(b, hi) - Math.max(a, lo));
    // Every shift of each person who worked this storm, whatever it was on:
    // the shift after a break may be anywhere. A storm from before the
    // clock's cutoff needs the older shifts read first (olderReady).
    const pool = Object.values(known());
    const byUid = {};
    pool.forEach(e => {
      if (e.kind === 'storm' && e.targetId === stormId) byUid[e.uid] = byUid[e.uid] || [];
    });
    pool.forEach(e => { if (byUid[e.uid]) byUid[e.uid].push(e); });
    let worst = 0;
    Object.keys(byUid).forEach(uid => {
      const theirs = byUid[uid];
      let off = 0;
      theirs.forEach(e => {
        if (e.kind !== 'storm' || e.targetId !== stormId) return;
        off += pausedMs(e, lo, hi);
        const from = endMsOf(e);
        if (e.endedFor !== 'break' || from == null) return;
        // Their next shift, whatever it was on (a rejected one never happened).
        let next = null;
        theirs.forEach(x => {
          const s = startMsOf(x);
          if (x !== e && x.status !== 'rejected' && s >= from && (!next || s < startMsOf(next))) next = x;
        });
        // Only a break they came back from, to this storm, was a break in its
        // service. A "break" that turned into going home (no "Done for the
        // day" tapped, the next shift a job in the morning) was the end of
        // their night, as a plain clock-out always was -- counting it took
        // hours of the whole crew's labour off every stop the others did.
        if (!next || next.kind !== 'storm' || next.targetId !== stormId) return;
        let until = Math.min(startMsOf(next), from + BREAK_SHOW_HOURS * 3600000);
        // "Done for the day" ended it (endBreakDay).
        if (typeof e.breakOverAt === 'number') until = Math.min(until, e.breakOverAt);
        off += overlap(from, until);
      });
      // The longest single person's time off, not everyone's added up: if
      // two crew stop for fuel together that is one interruption to the
      // customer's service, not two. And never more than the visit itself.
      worst = Math.max(worst, Math.min(off, hi - lo));
    });
    return Math.round(worst / 60000);
  }

  window.YDClock = {
    forJob: forJob,
    pausedMinutesAt: pausedMinutesAt,
    // Change requests: the owner's queue, or a crew member's own (storm.js
    // shows a crew member's storm-figure requests on the Snow tab).
    requests: () => requests,
    // The live shifts: a crew member's own, or everyone's recent ones and
    // those still waiting (enough for who is on the clock now).
    entries: () => entries,
    // Those and, once read, the older ones -- for a screen looking further
    // back, which first asks olderFor(its start) and says olderNote(...)
    // while they come (the work log). olderReady waits for them.
    shifts: known,
    olderFor: olderFor,
    olderReady: olderReady,
    olderNote: olderNote,
    // '' when old jobs' labour is all in forJob's figures, else a note.
    oldLabourNote: oldLabourNote,
    // The jobs anyone can clock into (jobBoard): the crew's list of jobs.
    board: () => board,
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
    // Stopped by the clock after too long with nobody clocking out.
    autoStopped: autoStopped,
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

  // What the clock (and the work log, and a crew note's job list) shows of a
  // job from jobBoard. Its updatedAt is left out on purpose: it changes on
  // every save of the job, whether or not anything here did.
  const boardSig = j => [j.name, j.address, j.status].map(v => (v == null ? '' : String(v))).join('\u0001');

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
    // filtered query and the owner reads everyone's; keeping the
    // first set of watches after a promotion would leave someone looking at
    // one person's hours and wondering where everyone else went.
    const key = (window.YDAuth && window.YDAuth.key) || u.uid;
    if (watchKey === key) return;
    unsub.forEach(fn => { try { fn(); } catch (e) {} });
    unsub = [];
    entries = {}; board = {}; people = {}; rates = {}; usersLoaded = false; ratesLoaded = false;
    requests = {}; asking = null;
    resetOlder();
    forgetLabour();
    watchKey = key;
    // How long a shift runs before the clock stops it (the owner's setting).
    readAutoOut();
    // Everyone's shifts: only the recent ones live (see "older shifts"). A
    // phone still holding a firebase-init.js from before watchFrom watches
    // the whole collection, as it always did.
    cutoff = cutoffNow();
    windowed = all && !!window.YDDb.watchFrom && !!window.YDDb.listWhere;
    // No word from the server about the summary for a while: most likely no
    // signal, so old jobs' labour comes from what this device has meanwhile.
    if (windowed) setTimeout(() => {
      if (watchKey === key && !rollHeard) { serverSlow = true; checkOld(); }
    }, 8000);

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

    const heard = () => {
      stampUnpriced();
      render();
      relabour();
      announce();
    };
    const onEntries = changes => {
      changes.forEach(c => {
        if (c.type === 'removed') delete entries[c.id];
        else entries[c.id] = Object.assign({ id: c.id }, c.data);
      });
      heard();
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
    if (!all) {
      unsub.push(window.YDDb.watchWhere('timeEntries', 'uid', u.uid, onEntries, onEntriesError));
    } else if (!windowed) {
      unsub.push(window.YDDb.watch('timeEntries', onEntries, onEntriesError));
    } else {
      unsub.push(window.YDDb.watchFrom('timeEntries', 'startedMs', cutoff, (changes, meta) => {
        const was = liveFresh;
        liveFresh = !!(meta && meta.fromCache === false);
        // Connected again: a read of the older shifts that failed is tried
        // again by whatever wants them (screens on their next redraw).
        if (liveFresh && !was && olderState === 'failed') olderState = null;
        take(recent, changes);
        heard();
        checkOld();          // connected again: the owner's device may make the summary now
      }, onEntriesError));
      unsub.push(window.YDDb.watchWhere('timeEntries', 'status', 'pending', changes => {
        take(waiting, changes);
        heard();
      }, onEntriesError));
      // The summary of old jobs' labour. Unreadable (the rules for it not yet
      // published): the older shifts are read instead, when needed.
      unsub.push(window.YDDb.watch(ROLL_PATH, (changes, meta) => {
        changes.forEach(c => { if (c.id === ROLL_ID) roll = c.type === 'removed' ? null : c.data; });
        rollIndex = null;
        rollAnswered = true;
        if (meta && meta.fromCache === false) rollHeard = true;
        // Another device has changed a shift from before the cutoff: the
        // older ones read here may be out of date. (On the first answer
        // there is nothing read yet to be out of date.)
        const mark = (roll && roll.staleAt) || null;
        if (mark !== lastMark) {
          if (mark && roll.staleBy !== DEVICE && lastMark !== undefined &&
              (olderState === 'done' || olderState === 'loading')) dropOlder();
          lastMark = mark;
        }
        checkOld();
        render(); relabour(); announce();
      }, () => { rollAnswered = true; rollFailed = true; checkOld(); render(); relabour(); announce(); }));
    }

    // The office's every pause in typing on a job re-sends its entry here
    // with a new updatedAt, and each one used to redraw the whole Clock
    // screen on every phone -- rebuilding the Pause and Clock out buttons
    // under a thumb -- and the work log and All Jobs with it. Only a change
    // the clock shows (a job added or gone, its name, address or status) is
    // worth that.
    let boardHeard = false;
    unsub.push(window.YDDb.watch('jobBoard', changes => {
      let shown = !boardHeard;
      boardHeard = true;
      changes.forEach(c => {
        const was = board[c.id];
        if (c.type === 'removed') delete board[c.id];
        else board[c.id] = Object.assign({ id: c.id }, c.data);
        if (!was || c.type === 'removed' || boardSig(was) !== boardSig(board[c.id])) shown = true;
      });
      if (!shown) return;
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
        checkOld();
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
        checkOld();
      }, () => { ratesLoaded = true; newRulesLive = false; stampUnpriced(); render(); checkOld(); }));
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
      resetOlder(); windowed = false;
      forgetLabour();
      closeAccess();
      // Half-done screens go too. A form the owner opened to file a shift for
      // somebody else, left open, would otherwise file the next person's
      // shift under that somebody.
      picking = false; clockingFor = null; pausingId = null; choosingWorker = false;
      addingShift = false; addFor = null; editingWorker = false; fixingId = null; fixingIn = null;
      autoOutHours = AUTO_OUT_DEFAULT;
      closeWorker();
      render();
    }
  });

  function boot() { render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
