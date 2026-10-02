// The work log: who worked where, on which days, for how long.
//
// It owns no data. Every row is a shift the time clock already recorded, and
// every length comes from the clock's own arithmetic (YDClock.paidMs and
// friends) -- so an hour in the log is the same hour on the pay sheet and on
// the job's labour cost, and the three can never disagree.
//
// Three ways to read the same shifts, because the questions differ:
//   BY DAY     "what happened on Tuesday"         -- the diary
//   BY JOB     "how much time has the Smith patio taken, and by whom"
//   BY PERSON  "where has Marco been all week"
//
// A shift is filed under the day it STARTED. A storm that runs from 10 pm to
// 4 am is one night's work, and splitting it at midnight would show the same
// storm on two days with neither total being the one anybody remembers.
//
// The owner sees everyone. A crew member sees only their own shifts, because
// those are the only ones the rules ever let their phone read.

(function () {
  'use strict';

  let range = 'week';
  let customFrom = '', customTo = '';
  let who = '';            // uid filter, '' for everyone
  let where = '';          // place filter, '' for everywhere
  let view = 'day';        // 'day' | 'job' | 'person'

  const el = id => document.getElementById(id);
  const two = n => String(n).padStart(2, '0');
  // Everyone's hours: the owner, or an admin given Crew hours & pay. Crew
  // see their own (theirs is all the clock loads for them anyway).
  const isOwner = () => ydCan('hours', 'see');
  const C = () => window.YDClock;

  function dayOf(d) { return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()); }
  function startOfDay(s) { return new Date(s + 'T00:00:00').getTime(); }
  function longDay(s) {
    return new Date(s + 'T00:00:00').toLocaleDateString('en-US',
      { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  function clock(msVal) {
    return msVal ? new Date(msVal).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
  }
  // Hours as a plain decimal for the spreadsheet: 7.75, not "7h 45m".
  const decHours = milli => (Math.round(milli / 36000) / 100).toFixed(2);

  // Where a shift was, as something two places cannot share. Two jobs can
  // both be called "Smith patio"; they never have the same id. Grouping and
  // filtering by the name merged them into one, with one total for both.
  const placeKey = e => e.kind + ':' + (e.targetId || '');

  // The name a person goes by now, from their record where the clock knows it.
  const nameOf = e => (C().who ? C().who(e) : (e.workerName || 'Worker'));

  // [from, to) in milliseconds for the chosen range.
  function bounds() {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const day = 864e5;
    if (range === 'today') return [d.getTime(), d.getTime() + day];
    if (range === 'week' || range === 'lastweek') {
      d.setDate(d.getDate() - d.getDay());
      if (range === 'lastweek') d.setDate(d.getDate() - 7);
      const a = d.getTime(); d.setDate(d.getDate() + 7);
      return [a, d.getTime()];
    }
    if (range === 'month' || range === 'lastmonth') {
      d.setDate(1);
      if (range === 'lastmonth') d.setMonth(d.getMonth() - 1);
      const a = d.getTime(); d.setMonth(d.getMonth() + 1);
      return [a, d.getTime()];
    }
    if (range === 'custom') {
      const a = customFrom ? startOfDay(customFrom) : 0;
      const b = customTo ? startOfDay(customTo) + day : Infinity;
      return [a, b];
    }
    return [0, Infinity];
  }

  // Every shift in range as a flat row. Rejected shifts are left out: they
  // were decided not to have happened.
  function rows() {
    const c = C();
    if (!c) return [];
    const [from, to] = bounds();
    const out = [];
    Object.values(c.entries()).forEach(e => {
      if (e.status === 'rejected') return;
      const s = c.startMsOf(e);
      if (!s || s < from || s >= to) return;
      const live = !e.endedAt;
      const counted = c.counts(e);
      const pending = !live && !counted;
      out.push({
        e: e, uid: e.uid, name: nameOf(e), where: c.label(e), placeKey: placeKey(e), kind: e.kind,
        day: dayOf(new Date(s)), start: s, end: c.endMsOf(e),
        paid: c.paidMs(e), billable: c.chargeableMs(e), paused: c.pausedMs(e),
        live: live, pending: pending, counted: counted,
      });
    });
    return out.filter(r => (!who || r.uid === who) && (!where || r.placeKey === where))
      .sort((a, b) => b.start - a.start);
  }

  // ---------------------------------------------------------------- render

  function render() {
    const wrap = el('worklogWrap');
    if (!wrap) return;
    const c = C();
    if (!c || !(window.YDAuth && window.YDAuth.user)) {
      wrap.innerHTML = '<p class="empty-msg">Sign in to see the work log.</p>';
      return;
    }

    // Filter choices come from every shift on record, not just this range, so
    // picking a person does not make the other names disappear from the list.
    const all = Object.values(c.entries()).filter(e => e.status !== 'rejected');
    const names = {};
    all.forEach(e => { names[e.uid] = nameOf(e); });
    // Keyed by place, labelled by name: two jobs with one name are two choices.
    const places = {};
    all.forEach(e => { places[placeKey(e)] = c.label(e); });
    const placeKeys = Object.keys(places).sort((a, b) => places[a].localeCompare(places[b]));

    const list = rows();
    const totals = list.filter(r => r.counted).reduce((t, r) => {
      t.paid += r.paid; t.billable += r.billable; return t;
    }, { paid: 0, billable: 0 });
    const notCounted = list.filter(r => !r.counted);
    const days = new Set(list.map(r => r.day)).size;

    wrap.innerHTML =
      '<div class="filter-bar wl-filters">' +
        '<select onchange="wlSet(\'range\', this.value)">' +
          [['today', 'Today'], ['week', 'This week'], ['lastweek', 'Last week'], ['month', 'This month'],
           ['lastmonth', 'Last month'], ['all', 'All time'], ['custom', 'Pick dates…']]
            .map(([v, t]) => '<option value="' + v + '"' + (range === v ? ' selected' : '') + '>' + t + '</option>').join('') +
        '</select>' +
        (range === 'custom'
          ? '<input type="date" value="' + customFrom + '" onchange="wlSet(\'from\', this.value)" aria-label="From">' +
            '<input type="date" value="' + customTo + '" onchange="wlSet(\'to\', this.value)" aria-label="To">'
          : '') +
        (isOwner() && Object.keys(names).length > 1
          ? '<select onchange="wlSet(\'who\', this.value)"><option value="">Everyone</option>' +
            Object.keys(names).sort((a, b) => names[a].localeCompare(names[b])).map(uid =>
              '<option value="' + esc(uid) + '"' + (who === uid ? ' selected' : '') + '>' + esc(names[uid]) + '</option>').join('') +
            '</select>' : '') +
        '<select class="searchable" onchange="wlSet(\'where\', this.value)"><option value="">Every job &amp; place</option>' +
          placeKeys.map(k => '<option value="' + esc(k) + '"' + (where === k ? ' selected' : '') + '>' +
            esc(places[k]) + '</option>').join('') +
        '</select>' +
      '</div>' +
      '<div class="wl-views">' +
        [['day', 'By day'], ['job', 'By job'], ['person', isOwner() ? 'By person' : 'Summary']]
          .map(([v, t]) => '<button class="btn btn-sm' + (view === v ? ' btn-filled' : '') +
            '" onclick="wlSet(\'view\', \'' + v + '\')">' + t + '</button>').join('') +
        (list.length ? '<button class="btn btn-sm" onclick="wlExport()">⬇ Spreadsheet</button>' : '') +
      '</div>' +
      (list.length
        ? '<div class="wl-sum">' +
            sumCard('Hours worked', c.fmtDur(totals.paid)) +
            sumCard('Billable', c.fmtDur(totals.billable)) +
            sumCard('Days', String(days)) +
            sumCard('Shifts', String(list.length)) +
          '</div>' +
          (notCounted.length
            ? '<div class="hint">' + notCounted.length + ' shift' + (notCounted.length === 1 ? ' is' : 's are') +
              ' still running or waiting for approval — shown, but not in the totals.</div>' : '') +
          (view === 'day' ? byDay(list)
            : view === 'job' ? byGroup(list, 'placeKey', 'where', 'uid', 'name')
            : byGroup(list, 'uid', 'name', 'placeKey', 'where'))
        : '<p class="empty-msg">No shifts in this range' + (who || where ? ' for this filter' : '') + '.</p>');
  }

  function sumCard(label, value) {
    return '<div class="wl-card"><div class="wl-card-label">' + label + '</div>' +
      '<div class="wl-card-value">' + esc(value) + '</div></div>';
  }

  function byDay(list) {
    const c = C();
    const days = {};
    list.forEach(r => { (days[r.day] = days[r.day] || []).push(r); });
    return Object.keys(days).sort().reverse().map(d => {
      const rs = days[d].sort((a, b) => a.start - b.start);
      const total = rs.filter(r => r.counted).reduce((s, r) => s + r.paid, 0);
      return '<div class="wl-day">' +
        '<div class="wl-day-head"><span>' + longDay(d) + '</span><span>' + c.fmtDur(total) + '</span></div>' +
        rs.map(r => '<div class="wl-row">' +
          '<div class="wl-who">' + esc(r.name) + '</div>' +
          '<div class="wl-where">' + esc(r.where) +
            (r.paused >= 60000 ? '<span class="wl-tag">paused ' + c.fmtDur(r.paused) + '</span>' : '') +
            (r.live ? '<span class="wl-tag live">on the clock</span>' : '') +
            (r.pending ? '<span class="wl-tag wait">waiting approval</span>' : '') +
            (r.e.source === 'manual' ? '<span class="wl-tag">typed in</span>' : '') +
          '</div>' +
          '<div class="wl-time">' + clock(r.start) + ' – ' + (r.end ? clock(r.end) : 'now') + '</div>' +
          '<div class="wl-hrs">' + c.fmtDur(r.paid) + '</div>' +
        '</div>').join('') +
      '</div>';
    }).join('');
  }

  // One block per job (or person), with the other side broken out under it:
  // a job lists who worked it; a person lists where they went.
  //
  // Grouped by id (`key`, `subKey`) and only labelled by name (`label`,
  // `subLabel`), so two jobs or two people sharing a name stay apart. The
  // list arrives newest first, so each label is the most recent one.
  function byGroup(list, key, label, subKey, subLabel) {
    const c = C();
    const groups = {};
    list.forEach(r => {
      const g = groups[r[key]] = groups[r[key]] ||
        { label: r[label], paid: 0, billable: 0, waiting: 0, days: new Set(), parts: {}, live: false };
      if (r.live) g.live = true;
      if (r.pending) g.waiting += r.paid;
      if (!r.counted) return;
      g.paid += r.paid; g.billable += r.billable; g.days.add(r.day);
      const p = g.parts[r[subKey]] = g.parts[r[subKey]] || { label: r[subLabel], paid: 0, days: new Set() };
      p.paid += r.paid; p.days.add(r.day);
    });
    return Object.keys(groups).sort((a, b) => groups[b].paid - groups[a].paid).map(k => {
      const g = groups[k];
      const parts = Object.keys(g.parts).sort((a, b) => g.parts[b].paid - g.parts[a].paid);
      return '<div class="wl-day">' +
        '<div class="wl-day-head"><span>' + esc(g.label) + (g.live ? ' <span class="wl-tag live">on the clock</span>' : '') +
          '</span><span>' + c.fmtDur(g.paid) + '</span></div>' +
        '<div class="wl-group-sub">' +
          (g.days.size ? g.days.size + ' day' + (g.days.size === 1 ? '' : 's') : '') +
          (g.billable && g.billable !== g.paid ? ' · ' + c.fmtDur(g.billable) + ' billable' : '') +
          (g.waiting ? (g.days.size ? ' · ' : '') + '<span class="wl-tag wait">' + c.fmtDur(g.waiting) +
            ' waiting approval</span>' : '') +
        '</div>' +
        (parts.length ? parts.map(p => '<div class="wl-row wl-part">' +
          '<div class="wl-where">' + esc(g.parts[p].label) + '</div>' +
          '<div class="wl-time">' + g.parts[p].days.size + ' day' + (g.parts[p].days.size === 1 ? '' : 's') + '</div>' +
          '<div class="wl-hrs">' + c.fmtDur(g.parts[p].paid) + '</div>' +
        '</div>').join('') : '<div class="cal-none">' + (g.live && !g.waiting ? 'On the clock now' : 'Not approved yet') + '</div>') +
      '</div>';
    }).join('');
  }

  // --------------------------------------------------------------- controls

  window.wlSet = function (what, value) {
    if (what === 'range') range = value;
    else if (what === 'from') customFrom = value;
    else if (what === 'to') customTo = value;
    else if (what === 'who') who = value;
    else if (what === 'where') where = value;
    else if (what === 'view') view = value;
    render();
  };

  // Excel runs any cell that starts with = + - or @ as a formula, quotes or
  // not. Names come from Google accounts and job names from whoever typed
  // them, so one beginning "=HYPERLINK(" would be live in the owner's
  // spreadsheet. A leading apostrophe makes Excel show it as plain text. None
  // of the numbers here is ever negative, so no figure is touched by this.
  function cellSafe(v) {
    const s = String(v == null ? '' : v);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }

  // A spreadsheet with one line per shift. BOM and CRLF so Excel opens it with
  // the right characters and the right line breaks, same as the billing export.
  window.wlExport = function () {
    const c = C();
    const list = rows().slice().sort((a, b) => a.start - b.start);
    if (!list.length) return;
    const q = v => '"' + cellSafe(v).replace(/"/g, '""') + '"';
    const head = ['Date', 'Worker', 'Where', 'Type', 'Start', 'End', 'Hours worked', 'Billable hours',
                  'Paused minutes', 'Status'];
    const lines = [head.map(q).join(',')].concat(list.map(r => [
      r.day, r.name, r.where, r.kind, clock(r.start), r.end ? clock(r.end) : '',
      decHours(r.paid), decHours(r.billable), Math.round(r.paused / 60000),
      r.live ? 'running' : r.pending ? 'waiting approval' : 'ok',
    ].map(q).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const [from, to] = bounds();
    a.href = URL.createObjectURL(blob);
    a.download = 'work-log-' + (from ? dayOf(new Date(from)) : 'start') + '-to-' +
      (isFinite(to) ? dayOf(new Date(to - 1)) : dayOf(new Date())) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  // ---------------------------------------------------------------- wiring

  // Redrawn when shifts change and when the Clock tab is opened -- never on the
  // clock's one-second tick, which would rebuild the whole log every second.
  function redrawIfVisible() {
    const p = el('panel-clock');
    if (p && p.classList.contains('active')) render();
  }
  document.addEventListener('yd-clock-changed', redrawIfVisible);
  document.addEventListener('yd-auth', e => {
    const s = el('worklogSection');
    const a = e.detail || {};
    if (s) s.hidden = !(a.mode === 'cloud' && a.user);
    if (!(a.mode === 'cloud' && a.user)) { who = ''; where = ''; }
    render();
  });

  window.YDWorkLog = { render: render };
})();
