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

  function paidMs(e) {
    const start = ms(e.startedAt);
    if (!start) return 0;
    const end = e.endedAt ? ms(e.endedAt) : Date.now();
    return Math.max(0, end - start);
  }

  // Paused time overlapping a window. With no window given it is the whole
  // shift; the snow side passes a single stop's arrive/depart instead, which
  // is what makes a pause land on the right client's invoice or on none.
  function pausedMs(e, from, to) {
    const lo = from == null ? ms(e.startedAt) : from;
    const hi = to == null ? (e.endedAt ? ms(e.endedAt) : Date.now()) : to;
    if (!(hi > lo)) return 0;
    return (e.pauses || []).reduce((sum, p) => {
      const ps = ms(p.startedAt);
      if (!ps) return sum;
      const pe = p.endedAt ? ms(p.endedAt) : Date.now();
      return sum + Math.max(0, Math.min(pe, hi) - Math.max(ps, lo));
    }, 0);
  }

  function billableMs(e) { return Math.max(0, paidMs(e) - pausedMs(e)); }

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
      pauses: [],
      note: '',
      status: 'pending',
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
    const stamp = nowIso();
    // An open pause is closed too, or the shift would look paused forever and
    // its billable time would be wrong.
    const p = openPause(e);
    if (p) p.endedAt = stamp;
    e.endedAt = stamp;
    render();
    write(id, { endedAt: stamp, pauses: e.pauses }, why || 'clocking out');
  }

  window.clockOut = function (id) {
    const e = entries[id];
    if (!e) return;
    endShift(id);
    showToast('Clocked out — ' + fmtDur(paidMs(e)) + ', waiting for approval');
  };

  // ------------------------------------------------------------- the display

  function render() {
    renderClockCard();
    if (isOwner()) { renderOnNow(); renderApprovals(); renderTotals(); }
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

    if (picking) {
      // The running clock redraws every second. If the picker is already up,
      // only its list may be touched -- redrawing the whole thing would
      // replace the search box mid-word, once a second.
      if (el('clockSearch')) filterJobPicker();
      else wrap.innerHTML = pickerHtml();
      return;
    }
    wrap.innerHTML = shift ? liveHtml(shift) : idleHtml();
  }

  function idleHtml() {
    return '<div class="clock-idle">' +
      '<p class="clock-lead">Not on the clock.</p>' +
      '<button class="btn btn-filled clock-big" onclick="openJobPicker()">Clock in</button>' +
      recentHtml() +
    '</div>';
  }

  function liveHtml(e) {
    const p = openPause(e);
    const paid = paidMs(e), bill = billableMs(e);
    return '<div class="clock-live' + (p ? ' paused' : '') + '">' +
      '<div class="clock-where">' + esc(e.targetName) +
        (e.kind === 'storm' ? ' <span class="clock-kind">storm</span>' : '') + '</div>' +
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
            (p
              ? '<button class="btn btn-filled clock-big" onclick="resumeClock(\'' + e.id + '\')">Back on</button>'
              : '<button class="btn btn-accent clock-big" onclick="askPause(\'' + e.id + '\')">Pause</button>') +
            '<button class="btn clock-big" onclick="clockOut(\'' + e.id + '\')">Clock out</button>' +
            '<button class="btn btn-sm" onclick="openJobPicker()">Switch to another job</button>' +
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

    return '<div class="picker">' +
      '<p class="clock-lead">What are you working on?</p>' +
      (storm && storm.status === 'open'
        ? '<button class="btn btn-accent clock-big" onclick="clockInTo(\'storm\', \'' + storm.id +
          '\', \'Tonight\\u2019s storm\')">❄️ Tonight’s storm</button>'
        : '') +
      '<input id="clockSearch" class="picker-search" placeholder="Search jobs…" oninput="filterJobPicker()">' +
      '<div id="pickerList">' + pickerList(jobList()) + '</div>' +
      '<button class="btn btn-sm" onclick="cancelJobPicker()">Cancel</button>' +
    '</div>';
  }

  // Only the list is redrawn, never the whole picker. Rebuilding the picker
  // would replace the search box itself, and the field would lose focus after
  // every single character typed.
  window.filterJobPicker = function () {
    const list = el('pickerList');
    if (list) list.innerHTML = pickerList(jobList());
  };

  function jobList() {
    return Object.keys(board).map(id => Object.assign({ id: id }, board[id]))
      .filter(j => j.status !== 'complete')
      .sort((a, b) =>
        (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) ||
        String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  function pickerList(jobs) {
    const search = ((el('clockSearch') || {}).value || '').trim().toLowerCase();
    const list = search
      ? jobs.filter(j => (j.name + ' ' + (j.address || '')).toLowerCase().indexOf(search) !== -1)
      : jobs.slice(0, 12);
    if (!list.length) return '<p class="empty-msg">No jobs match.</p>';
    return list.map(j =>
      '<button class="picker-job" onclick="clockInTo(\'job\', \'' + j.id + '\', \'' +
        esc(j.name).replace(/'/g, '&#39;') + '\')">' +
        '<span class="picker-name">' + esc(j.name) + '</span>' +
        (j.address ? '<span class="picker-addr">' + esc(j.address) + '</span>' : '') +
        (j.status === 'active' ? '<span class="picker-flag">active</span>' : '') +
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
            '<span class="on-who">' + esc(e.workerName) + '</span>' +
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
    const waiting = Object.values(entries)
      .filter(e => e.status === 'pending' && e.endedAt)
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const badge = el('approveBadge');
    if (badge) badge.textContent = waiting.length ? waiting.length + ' waiting' : '';
    const sec = el('clockApproveSection');
    if (sec) sec.hidden = false;

    if (!waiting.length) {
      wrap.innerHTML = '<p class="empty-msg">Nothing waiting. Finished shifts show up here to approve.</p>';
      return;
    }
    wrap.innerHTML = waiting.map(e => {
      const paid = paidMs(e), bill = billableMs(e), pause = pausedMs(e);
      return '<div class="appr">' +
        '<div class="appr-top">' +
          '<span class="appr-who">' + esc(e.workerName) + '</span>' +
          '<span class="appr-where">' + esc(e.targetName) + '</span>' +
        '</div>' +
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

  function renderTotals() {
    const wrap = el('totalsWrap');
    if (!wrap) return;
    const which = (el('clockRange') || {}).value || 'week';
    const from = rangeStart(which);
    const to = which === 'lastweek' ? from + 7 * 864e5 : Infinity;

    const done = Object.values(entries).filter(e =>
      e.status === 'approved' && ms(e.startedAt) >= from && ms(e.startedAt) < to);
    const pending = Object.values(entries).filter(e =>
      e.status === 'pending' && e.endedAt && ms(e.startedAt) >= from && ms(e.startedAt) < to);

    const byWorker = {};
    done.forEach(e => {
      const w = byWorker[e.uid] = byWorker[e.uid] ||
        { name: e.workerName, uid: e.uid, paid: 0, bill: 0, cost: 0 };
      w.paid += paidMs(e); w.bill += billableMs(e);
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
      (pending.length
        ? '<p class="hint">' + pending.length + ' shift' + (pending.length === 1 ? '' : 's') +
          ' still waiting for approval. Those are not counted above, or on any job.</p>'
        : '');
  }

  window.setWorkerRate = function (uid) {
    if (!isOwner()) return;
    const cur = rateOf(uid);
    const v = prompt('Hourly rate for ' + ((people[uid] || {}).name || 'this worker') +
                     '\n\nThis applies to shifts approved from now on. Already-approved shifts keep the rate they were approved at.',
                     (cur / 100).toString());
    if (v === null) return;
    const cents = Math.round(parseFloat(v.replace(/[^0-9.]/g, '')) * 100);
    if (!(cents > 0)) { showToast('That is not a rate'); return; }
    people[uid] = Object.assign({}, people[uid], { rateCents: cents });
    render();
    Promise.resolve(window.YDDb.put('users', uid, { rateCents: cents }))
      .catch(e => console.warn('[clock] rate not saved:', e.code || e.message));
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
      if (e.status === 'pending' && e.endedAt) { out.pendingHours += hours(paidMs(e)); return; }
      if (e.status !== 'approved') return;
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
    if (unsub.length || !window.YDDb) return;

    const u = me();

    const onEntries = changes => {
      changes.forEach(c => {
        if (c.type === 'removed') delete entries[c.id];
        else entries[c.id] = Object.assign({ id: c.id }, c.data);
      });
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
    ['clockOnNowSection', 'clockApproveSection', 'clockTotalsSection'].forEach(id => {
      const s = el(id); if (s) s.hidden = !owner;
    });
    const tab = el('tabClock');
    if (tab) tab.hidden = !(a.mode === 'cloud' && a.user);
    if (a.mode === 'cloud' && a.user) start(owner);
  });

  function boot() { render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
