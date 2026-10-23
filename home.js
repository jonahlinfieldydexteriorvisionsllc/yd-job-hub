// Home: where Job Hub opens.
//
// Jonah (14 Oct 2026): "make home page for the job hub with overviews of
// things ... jobs booked & jobs in progress - jobs that need to be invoiced -
// calendar schedule for the day for me & separate for the guys - list of my
// tasks to get done for the day", "in addition to whatever you think would
// be good".
//
// NOTHING HERE IS STORED, AND NOTHING IS READ FROM THE DATABASE. Every card
// is drawn from what the other screens already hold: the jobs on this device
// (app.js), the calendars and the cards (calendar.js, boards.js), the clock
// (timeclock.js), receipts, machines, notes from the crew, the storm and the
// weather. Asking the database again would be a second copy of the same
// facts that could disagree with the screen next door. Each of those says
// when it changes (a yd-... event), and Home redraws -- only while it is the
// screen showing, and only when what it would draw is different.
//
// The same rules decide what is on it as decide the screens it points to:
// which bids to chase and which jobs are ready to invoice are the Bids and
// Jobs boards' own (YDBoards), what is "mine" and what is the crew's is My
// day's (YDCalendar, remind.js). A tap goes where that thing lives, and a
// tick does what the same tick on the calendar does.
//
// Each person gets their own. The owner, everything. An admin, only what
// Your Crew → Access gives them. The crew: their clock, their day, the
// crew's tasks and their jobs -- never a price.

(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const safe = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const colour = c => (/^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? c : '#6b7a8f');
  const me = () => (window.YDAuth && window.YDAuth.user) || null;
  const signedIn = () => !!(window.YDAuth && window.YDAuth.mode === 'cloud' && me());
  // No Firebase on this device (it could not be reached at start): the jobs
  // saved here are still this person's to see and change.
  const localOnly = () => !!(window.YDAuth && window.YDAuth.mode === 'local');
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const can = (area, level) => (localOnly() ? area === 'jobs' : ydCan(area, level));
  const seesJobs = () => can('jobs', 'see');
  const showing = () => { const p = el('panel-home'); return !!(p && p.classList.contains('active')); };

  // How many of a list show before "Show all".
  const SHOW = 6;
  // Calendars and boards can take a few seconds to arrive on a cold start;
  // until then a card says it is loading rather than "nothing today".
  const WARM_UP_MS = 8000;

  let drawn = {};           // key -> the calendar occurrence a row stands for
  let lastHtml = '';        // what was last put on the screen
  const expanded = {};      // list key -> "Show all" pressed
  let soonTimer = 0, ticker = 0;
  let authAt = 0;           // when this person's sign-in was heard

  // ------------------------------------------------------------ the words

  function today() { return localYMD(); }
  function addDays(ymd, n) { const d = new Date(ymd + 'T12:00:00'); d.setDate(d.getDate() + n); return localYMD(d); }
  // "Today", "Tomorrow", "Yesterday", else "Thu, Oct 16".
  function dayWords(ymd) {
    const t = today();
    if (ymd === t) return 'Today';
    if (ymd === addDays(t, 1)) return 'Tomorrow';
    if (ymd === addDays(t, -1)) return 'Yesterday';
    return new Date(ymd + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  // Calendar days, not 24-hour blocks: at 2 am a bid sent yesterday
  // morning was sent "yesterday", not "today".
  function daysSince(iso) {
    const t = iso ? new Date(iso) : null;
    if (!t || isNaN(t)) return null;
    const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return Math.max(0, Math.round((midnight(new Date()) - midnight(t)) / 864e5));
  }
  const ago = d => d == null ? '' : d === 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const dur = ms => (window.YDClock && YDClock.fmtDur ? YDClock.fmtDur(ms) : Math.round(ms / 60000) + 'm');
  // Whole dollars on the tiles, where the cents are only noise.
  const dollars = v => '$' + Math.round(parseFloat(v) || 0).toLocaleString('en-US');

  // The name a person goes by, first name only: "Good morning, Jonah".
  function firstName() {
    const rec = window.YDRemind && YDRemind.me();
    const u = me();
    const n = (rec && rec.name) || (u && u.displayName) || '';
    return String(n).trim().split(/\s+/)[0] || '';
  }

  // ------------------------------------------------------- building blocks

  // One card on the grid: the app's own section look, a count in the head,
  // and a link to the screen it comes from.
  function card(id, title, badge, link, body, badgeAccent) {
    return '<section class="section hm-card" id="hm-' + id + '">' +
      '<div class="section-head"><span class="section-title">' + title + '</span>' +
        '<span class="hm-head-r">' +
          (badge ? '<span class="section-badge' + (badgeAccent ? ' accent' : '') + '">' + badge + '</span>' : '') +
          (link ? '<button class="hm-link" onclick="' + link[1] + '">' + link[0] + ' ›</button>' : '') +
        '</span></div>' +
      '<div class="hm-body">' + body + '</div></section>';
  }
  const sub = (words, n) => '<div class="hm-sub">' + words + (n != null ? ' <span class="hm-n">' + n + '</span>' : '') + '</div>';
  const empty = words => '<p class="hm-empty">' + words + '</p>';
  // The first few of a list, and "Show all N" for the rest.
  function capped(key, rows, max) {
    max = max || SHOW;
    if (rows.length <= max) return rows.join('');
    if (expanded[key]) {
      return rows.join('') + '<button class="hm-more" onclick="homeMore(\'' + safe(key) + '\')">Show fewer</button>';
    }
    return rows.slice(0, max).join('') +
      '<button class="hm-more" onclick="homeMore(\'' + safe(key) + '\')">Show all ' + rows.length + '</button>';
  }
  // A row standing for a calendar occurrence keeps it by a short key, the
  // way the calendar does, so a tap hands back exactly that one.
  function keep(x) { const k = 'h' + Object.keys(drawn).length; drawn[k] = x.o; return k; }

  // Something at a set time, drawn as My day draws it: a task (not an
  // appointment) has its tick box here too.
  function timedRow(x) {
    const k = keep(x);
    const line = [x.sub, x.who].filter(Boolean).join(' · ');
    return '<div class="md-row hm-row' + (x.done ? ' done' : '') + '" style="--c:' + colour(x.color) + '">' +
      (x.task && x.canTick ? '<input type="checkbox"' + (x.done ? ' checked' : '') +
        ' onchange="homeTick(\'' + k + '\', this.checked)" aria-label="Done">' : '') +
      '<button class="md-open" onclick="homeOpen(\'' + k + '\')">' +
        '<span class="md-time">' + esc(x.time) + '</span>' +
        '<span class="md-what"><b>' + esc(x.title) + '</b>' + (line ? '<small>' + esc(line) + '</small>' : '') + '</span>' +
      '</button></div>';
  }
  // Something for any time: a tick box when this person may tick it off,
  // its kind's colour down the side. `late`: it was due on an earlier day.
  function todoRow(x, late) {
    const k = keep(x);
    const due = late ? '<span class="hm-late">Due ' + esc(dayWords(x.day).replace(/^Yesterday$/, 'yesterday')) + '</span>' : '';
    const words = esc([x.sub, x.who].filter(Boolean).join(' · '));
    const line = [due, words].filter(Boolean).join(' · ');
    return '<div class="cal-todo hm-todo' + (x.done ? ' done' : '') + '" style="--c:' + colour(x.color) + '">' +
      (x.canTick ? '<input type="checkbox"' + (x.done ? ' checked' : '') + ' onchange="homeTick(\'' + k + '\', this.checked)" ' +
        'aria-label="Done">' : '<span class="cal-todo-dot"></span>') +
      '<button class="cal-todo-t" onclick="homeOpen(\'' + k + '\')">' + esc(x.title) +
        (line ? '<small>' + line + '</small>' : '') + '</button></div>';
  }
  // A plain line that goes somewhere: an icon, the words, something on the right.
  function line(icon, main, small, right, call, cls) {
    return '<button class="hm-line' + (cls ? ' ' + cls : '') + '" onclick="' + call + '">' +
      (icon ? '<span class="hm-line-i">' + icon + '</span>' : '') +
      '<span class="hm-line-m">' + main + (small ? '<small>' + small + '</small>' : '') + '</span>' +
      (right ? '<span class="hm-line-r">' + right + '</span>' : '') + '</button>';
  }

  // ------------------------------------------------------------------ jobs

  function jobs() {
    return (typeof loadAllJobs === 'function' ? loadAllJobs() : []).filter(j => j && j._id);
  }
  const statusOf = j => (typeof normStatus === 'function' ? normStatus(j.jobStatus, j) : j.jobStatus || 'quoting');
  const nameOf = j => String(j.customerName || '').trim() || 'Untitled job';
  const numOf = j => String(j.estimateNumber || '').trim();
  const priceOf = j => parseMoney(j.jobPrice || '');
  const whereOf = j => [j.address, j.city].filter(Boolean).join(', ');
  const servicesOf = j => (j.serviceTypes || []).join(', ');
  const B = () => window.YDBoards || null;
  // The invoice made from the job's estimate. One made in the other
  // QuickBooks company (the test one, before the switch to the real books)
  // is not this job's -- the Job tab ignores it the same way (estimate.js).
  function invoiceOf(j) {
    const inv = j.qbInvoiceRef, q = j.qbEstimate;
    if (!inv || !inv.id) return null;
    return inv.env && q && q.env && inv.env !== q.env ? null : inv;
  }
  // The job's one stage (app.js jobStage), the same answer the Job tab, the
  // boards and All Jobs give.
  const stageOf = j => (typeof jobStage === 'function' ? jobStage(j).id : '');
  // Finished, not invoiced yet: no QuickBooks invoice, not marked Invoiced
  // or Paid by hand.
  function needsInvoice(j) {
    return stageOf(j) === 'finished' && !invoiceOf(j);
  }
  function owed(j) {
    const inv = invoiceOf(j);
    const bal = inv ? parseFloat(inv.balance) : NaN;
    if (!(bal > 0.004)) return 0;
    return stageOf(j) === 'paid' ? 0 : bal;
  }
  // What the Invoices list says of a job's invoice -- the same rule
  // (invoices.js stateOf), so Home never calls "owed" what that list calls
  // "waiting": office testing, 16 Oct 2026, found a job in progress with its
  // deposit paid listed here as money owed while the list said the rest is
  // due when the job is done. Its own record when the list has one (fresher:
  // the hourly look at QuickBooks writes it); else the job's copy of the
  // invoice, which is enough for that first answer. null: no answer here.
  function invState(j) {
    const inv = invoiceOf(j), I = window.YDInvoices;
    if (!inv || !I || typeof I.stateOf !== 'function') return null;
    const rec = ((I.all && I.all()) || {})[inv.id];
    const src = rec ? Object.assign({}, rec, { jobId: rec.jobId || j._id })
      : { id: inv.id, open: true, balance: inv.balance, total: inv.total, jobId: j._id,
          emails: inv.sentAt ? [inv.sentAt] : [], emailStatus: inv.sentAt ? 'EmailSent' : '' };
    try {
      const st = I.stateOf(src);
      const bal = rec ? Number(rec.balance) || 0 : owed(j);
      const deposit = st.deposit && I.depositOf ? I.depositOf(src, st.job) : 0;
      return { st: st, bal: stageOf(j) === 'paid' ? 0 : bal, deposit: deposit };
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------- the sections

  function greetingHtml() {
    const h = new Date().getHours();
    const hello = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name = firstName();
    const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    // The crew get the weather as one line: on a phone the full box pushed
    // their clock and their day down past the fold.
    const crewish = signedIn() && !seesJobs();
    return '<div class="hm-top">' +
      '<div class="hm-hello"><div class="hm-hi">' + esc(hello + (name ? ', ' + name : '')) + '</div>' +
        '<div class="hm-date">' + esc(date) + '</div></div>' +
      jotHtml() +
      (crewish ? '' : weatherHtml()) +
    '</div>' + (crewish ? weatherLineHtml() : '');
  }

  // The same weather, in one line (the crew's Home).
  function weatherLineHtml() {
    const w = window.YDForecast && YDForecast.today();
    if (!w) return '';
    const bits = [w.hi && w.lo ? 'H ' + w.hi + ' · L ' + w.lo : '', w.pop >= 10 ? '💧 ' + w.pop + '%' : '',
      w.snow ? '❄️ ' + w.snow : w.rain ? w.rain + ' rain' : '', w.wind ? 'wind ' + w.wind : ''].filter(Boolean);
    return '<button class="hm-wx-line" onclick="homeWeather()" title="The week’s weather">' +
      '<span class="hm-wx-i">' + esc(w.icon) + '</span>' +
      '<span class="hm-wx-one"><b>' + esc(w.temp) + '</b> ' + esc(w.words) +
        (bits.length ? ' · ' + esc(bits.join(' · ')) : '') + (w.stale ? ' · from ' + esc(w.age) : '') + '</span>' +
      ((w.alerts || []).length ? '<span class="hm-wx-warn" title="' + esc(w.alerts.join(' · ')) + '">⚠️ ' + esc(w.alerts[0]) + '</span>' : '') +
    '</button>';
  }

  // Today's weather from the header button's copy (forecast.js); a tap
  // opens the full week.
  function weatherHtml() {
    const w = window.YDForecast && YDForecast.today();
    if (!w) return '';
    const bits = [w.hi && w.lo ? 'H ' + w.hi + ' · L ' + w.lo : '', w.pop >= 10 ? '💧 ' + w.pop + '%' : '',
      w.snow ? '❄️ ' + w.snow : w.rain ? w.rain + ' rain' : '', w.wind ? 'wind ' + w.wind : ''].filter(Boolean);
    return '<button class="hm-wx" onclick="homeWeather()" title="The week’s weather">' +
      '<span class="hm-wx-i">' + esc(w.icon) + '</span>' +
      '<span class="hm-wx-t"><b>' + esc(w.temp) + '</b> ' + esc(w.words) +
        '<small>' + esc(bits.join(' · ')) + (w.stale ? ' · from ' + esc(w.age) : '') + '</small>' +
        (w.alerts.length ? '<small class="hm-wx-alert">⚠️ ' + esc(w.alerts.join(' · ')) + '</small>' : '') +
      '</span></button>';
  }

  // A few one-tap starts, by what this person may do. Shorter words on a
  // phone, so they fit one row and today is not pushed down the screen.
  function actionsHtml() {
    const out = [];
    if (can('jobs', 'change') && signedIn() && typeof addJobCard === 'function') {
      out.push('<button class="btn btn-sm btn-filled" onclick="addJobCard(\'bids\', \'siteVisit\')">＋ <span class="hide-phone">New </span>bid</button>');
    }
    if (signedIn() && window.YDCalendar && YDCalendar.adds && YDCalendar.adds()) {
      out.push('<button class="btn btn-sm" onclick="homeAddEntry()">＋ Calendar<span class="hide-phone"> entry</span></button>');
    }
    if (signedIn() && !isOwner() && typeof openNoteForJonah === 'function') {
      out.push('<button class="btn btn-sm" onclick="openNoteForJonah()">📝 Note for Jonah</button>');
    }
    if (signedIn() && typeof rcPhoto === 'function') {
      out.push('<button class="btn btn-sm" onclick="rcPhoto()">📷 <span class="hide-phone">Add a </span>receipt</button>');
    }
    return out.length ? '<div class="hm-actions">' + out.join('') + '</div>' : '';
  }

  // The figures at a glance, each a tap to its card. Only for whoever sees
  // jobs -- these are money.
  function statsHtml(all) {
    if (!seesJobs()) return '';
    const onGo = all.filter(j => ['booked', 'inprogress'].indexOf(statusOf(j)) !== -1);
    const inProg = onGo.filter(j => statusOf(j) === 'inprogress').length;
    const toInv = all.filter(needsInvoice);
    // Every unpaid QuickBooks invoice when the Invoices list is here (storms'
    // and ones made in QuickBooks too); else the jobs' own.
    const invList = can('billing', 'see') && window.YDInvoices
      ? Object.values(YDInvoices.all() || {}).filter(i => i.open && Number(i.balance) > 0) : [];
    const owing = invList.length ? invList.map(i => Number(i.balance)) : all.map(owed).filter(v => v > 0);
    const g = bidGroups(all);
    const bidsOut = g ? g.chase.map(x => x.j).concat(g.waiting) : [];
    const chase = g ? g.chase.length : 0;
    const sum = list => list.reduce((s, j) => s + priceOf(j), 0);
    const tile = (go, color, n, label, small) => '<button class="hm-stat" style="--c:' + color + '" onclick="homeGo(\'' + go + '\')">' +
      '<span class="hm-stat-n">' + n + '</span><span class="hm-stat-l">' + label + '</span>' +
      (small ? '<small>' + small + '</small>' : '') + '</button>';
    return '<div class="hm-stats">' +
      tile('jobs', '#2f8f5b', onGo.length, 'Jobs on the go',
        (onGo.length ? dollars(sum(onGo)) + ' · ' : '') + inProg + ' in progress') +
      tile('invoice', '#c9922f', toInv.length, 'To invoice', toInv.length ? dollars(sum(toInv)) : 'all caught up') +
      (owing.length ? tile(invList.length ? 'invoices' : 'invoice', '#c8492b', dollars(owing.reduce((s, v) => s + v, 0)), 'Owed to you',
        'on ' + plural(owing.length, 'invoice')) : '') +
      tile('bids', '#2f6fd6', bidsOut.length, 'Bids out',
        (bidsOut.length ? dollars(sum(bidsOut)) : 'none waiting') + (chase ? ' · ' + chase + ' to chase' : '')) +
    '</div>';
  }

  // A storm being worked: right at the top, for anybody it is news to --
  // and for the crew, the one thing to do next: the property they are on
  // (Depart) or the next one on the route (Arrive), a tap away on the Snow
  // tab. Not on the storm's clock yet: one tap for that too.
  function stormHtml() {
    const s = window.YDStorm && YDStorm.current();
    if (!window.YDStages.stormOpen(s)) return '';
    const stops = Object.values((YDStorm.stops && YDStorm.stops()) || {})
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    const done = stops.filter(x => x.departedAt || x.skipped).length;
    const at = s.startedAt ? new Date(s.startedAt) : null;
    // "9:19pm", the way the calendar writes a time.
    const since = at && !isNaN(at) ? at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      .replace(/\s*([AP])M$/i, (m, ap) => ap.toLowerCase() + 'm') : '';
    const accounts = (window.YDSnow && YDSnow.accounts && YDSnow.accounts()) || {};
    const placeOf = x => (accounts[x.accountId] || {}).name || 'the next property';
    // The Snow tab's own answer when it has one (storm.js currentStop: this
    // person's stop on site, else the next to do); else worked out here.
    let cur = YDStorm.currentStop ? YDStorm.currentStop() : undefined;
    // Its id, should the answer come without one (the id is what Depart
    // and Arrive are found by).
    if (cur && !cur.id) cur = stops.find(x => x === cur || (x.accountId === cur.accountId && (x.pass || 1) === (cur.pass || 1))) || null;
    const here = cur !== undefined ? (cur && cur.id && cur.arrivedAt && !cur.departedAt ? cur : null)
      : stops.find(x => x.arrivedAt && !x.departedAt && !x.skipped);
    const next = here ? null : cur !== undefined ? (cur && cur.id ? cur : null) : stops.find(x => !x.arrivedAt && !x.skipped);
    const go = here ? { words: 'On site: ' + placeOf(here), act: 'Depart ›', id: here.id, icon: '📍' }
      : next ? { words: 'Next: ' + placeOf(next), act: 'Arrive ›', id: next.id, icon: '➡️' }
      : { words: stops.length ? 'Every stop done' : 'Route starting', act: 'Snow ›', id: '', icon: '✅' };
    const m = signedIn() && window.YDClock && YDClock.mine ? YDClock.mine() : null;
    const onStorm = !!(m && m.shift && m.shift.kind === 'storm' && m.shift.targetId === s.id);
    // Every stop done: the storm's shifts have ended at the last departure,
    // and one started now would run on with nothing to stop it -- so no
    // "Clock in to tonight's storm" until there is a stop to do again.
    const allDone = stops.length > 0 && done === stops.length;
    return '<div class="hm-storm">' +
      '<button class="hm-alert" onclick="homeStop(\'' + safe(go.id) + '\')">' +
        '<span class="hm-storm-l1">❄️ <b>Storm under way</b>' + (s.label ? ' — ' + esc(s.label) : '') +
          ' <span>' + (stops.length ? done + ' of ' + stops.length + ' stops done' : 'route starting') +
          (since ? ' · since ' + esc(since) : '') + '</span></span>' +
        '<span class="hm-storm-l2"><span class="hm-storm-what">' + go.icon + ' ' + esc(go.words) + '</span>' +
          '<span class="hm-alert-go">' + go.act + '</span></span>' +
      '</button>' +
      (m && !onStorm && !allDone && !(m.shift && m.shift.leaving) && typeof window.clockInTo === 'function'
        ? '<button class="btn btn-filled hm-storm-in" onclick="homeStormIn()">⏱ ' +
            (m.shift ? 'Switch to tonight’s storm' : 'Clock in to tonight’s storm') + '</button>' : '') +
    '</div>';
  }

  // This person's own clock (not the owner's: his is on the Clock tab, and
  // the crew's are under the crew's day).
  function clockHtml() {
    if (!signedIn() || isOwner() || !window.YDClock || !YDClock.mine) return '';
    const m = YDClock.mine();
    let body, badge = '';
    if (m.shift && m.shift.leaving) {
      // Clock out or Break just tapped: a few seconds to take it back
      // (timeclock.js), the same here as on the Clock tab.
      const brk = m.shift.leaving === 'break';
      badge = brk ? 'Going on break…' : 'Clocking out…';
      body = '<div class="hm-clock leaving">' +
          '<div class="hm-clock-where">' + esc(m.shift.where || 'Working') + '</div>' +
          '<div class="hm-clock-sub">' + (brk ? '🍔 Going on break' : 'Clocking out') + ' · <b>' + esc(dur(m.shift.ms)) + '</b></div></div>' +
        '<div class="hm-actions"><button class="btn btn-filled hm-big" onclick="homeClock(\'undoClockOut\', \'' + safe(m.shift.id) + '\')">' +
          '↩ Undo — stay on the clock</button></div>';
    } else if (m.shift) {
      badge = m.shift.paused ? 'Paused' : 'On the clock';
      body = '<div class="hm-clock on">' +
          '<div class="hm-clock-where">' + esc(m.shift.where || 'Working') + '</div>' +
          '<div class="hm-clock-sub">' + esc(m.shift.inWords || 'in at ' + m.shift.since) + ' · <b>' + esc(dur(m.shift.ms)) + '</b>' +
            (m.shift.paused ? ' · paused for ' + esc(m.shift.paused) : '') + '</div>' +
          (m.shift.note ? '<div class="hm-clock-note">⏱ ' + esc(m.shift.note) + '</div>' : '') + '</div>' +
        '<div class="hm-actions">' +
          '<button class="btn btn-filled" onclick="switchTab(\'clock\')">Go to the clock</button>' +
          '<button class="btn" onclick="homeClock(\'takeBreak\', \'' + safe(m.shift.id) + '\')">🍔 Break</button></div>' +
        // On a line of its own and marked as the one that ends the day.
        '<div class="hm-actions hm-out-row"><button class="btn hm-out" onclick="homeClock(\'clockOut\', \'' + safe(m.shift.id) + '\')">' +
          '⏹ Clock out</button></div>';
    } else if (m.onBreak) {
      badge = 'On break';
      body = '<div class="hm-clock">' +
          '<div class="hm-clock-where">🍔 On break</div>' +
          '<div class="hm-clock-sub">since ' + esc(m.onBreak.since) + ' · <b>' + esc(dur(m.onBreak.ms)) + '</b> · off the clock</div></div>' +
        '<div class="hm-actions">' +
          '<button class="btn btn-filled" onclick="homeClock(\'backFromBreak\', \'' + safe(m.onBreak.id) + '\')">Clock back in — ' +
            esc(m.onBreak.where || 'where you were') + '</button>' +
          '<button class="btn" onclick="switchTab(\'clock\')">Go to the clock</button></div>';
    } else {
      body = '<div class="hm-clock"><div class="hm-clock-where">Not on the clock</div></div>' +
        '<div class="hm-actions"><button class="btn btn-filled hm-big" onclick="homeClockIn()">Clock in</button></div>';
    }
    return card('clock', '⏱️ Your clock', badge, ['Clock', "switchTab('clock')"], body, true);
  }

  // The end-of-day list (eod.js), for whoever gets it: from mid-afternoon on
  // a day they worked -- or once they are off the clock -- until it is sent;
  // then that it went. Yesterday's too, if it never did.
  function eodHtml() {
    const E = window.YDEndOfDay;
    const rows = signedIn() && E && E.forMe ? E.forMe() : [];
    if (!rows.length) return '';
    const items = E.items ? E.items() : [];
    const what = items.slice(0, 4).map(it => (it.kind === 'photos' ? '📷 Photos' : it.label)).join(' · ') + (items.length > 4 ? ' …' : '');
    const todo = rows.find(r => r.state === 'todo'), late = rows.find(r => r.state === 'late'), sent = rows.find(r => r.state === 'sent');
    const body =
      (todo ? '<div class="hm-eod-what">Before you go: ' + esc(what) + '</div>' +
        '<div class="hm-actions"><button class="btn btn-filled hm-big" onclick="openEndOfDay(\'' + safe(todo.day) + '\')">📋 Fill in today’s end of day</button></div>' : '') +
      (sent ? '<div class="hm-eod-sent">✓ ' + (sent.pending ? 'Saved — it goes to Jonah when this phone has signal'
          : 'Sent to Jonah at ' + esc(new Date(sent.sentAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))) +
        ' <button class="link-btn" onclick="openEndOfDay(\'' + safe(sent.day) + '\')">Change it</button></div>' : '') +
      (late ? '<div class="hm-eod-late"><span class="hm-late">Yesterday’s end of day wasn’t sent.</span> ' +
        '<button class="btn btn-sm" onclick="openEndOfDay(\'' + safe(late.day) + '\')">Send yesterday’s</button></div>' : '');
    return card('eod', '📋 End of day', todo || late ? 'To do' : 'Sent', null, body, !!(todo || late));
  }

  // The day: what is mine (at set times, then for any time today and what
  // is late), and the crew's that is not mine.
  function dayData() {
    if (!signedIn() || !window.YDCalendar || !YDCalendar.day) return null;
    if (!YDCalendar.ready() && Date.now() - authAt < WARM_UP_MS) return 'loading';
    return YDCalendar.day(today()) || 'loading';
  }

  // A crew task nobody has been put on: every crew member's to pick up
  // (remind.js isMine), so it is in each of their days -- said as such, or
  // it reads as though it were theirs alone.
  const openCrew = x => !!(x && x.crewTask && x.open);

  // A day's count in the calendar's words (calendar.js countWords).
  const countWords = c => (window.YDCalendar && YDCalendar.countWords ? YDCalendar.countWords(c) : '');

  function myDayHtml(d) {
    if (!signedIn()) return '';
    const title = isOwner() ? '📅 My day' : '📅 Your day';
    const link = ['Calendar', "switchTab('calendar')"];
    if (d === 'loading' || !d) return card('day', title, '', link, empty('Loading…'));
    const ownLate = d.mineLate.filter(x => !openCrew(x)), ownAny = d.mineAny.filter(x => !openCrew(x));
    const crewLate = d.mineLate.filter(openCrew), crewAny = d.mineAny.filter(openCrew);
    // The day's one count, worked out by the calendar (calendar.js tally) and
    // said in its words -- "3 to do today · 2 from earlier" -- so Home, My day
    // and the calendar's day list give the same figure (crew testing, 16 Oct
    // 2026: they said 4, 2 + 2, and 5). The lists below carry no figures of
    // their own: a count for each part read as yet another number.
    const c = d.count || null;
    const left = c ? c.today + c.earlier : 0;
    // Reminders reach only a phone that has said yes to them (calendar.js,
    // the same note My day shows).
    const nudge = window.YDCalendar && YDCalendar.nudge ? YDCalendar.nudge() : '';
    if (isOwner() && window.YDRemind && YDRemind.place) {
      return card('day', title, countWords(c), link, nudge + placesHtml(d, ownLate, ownAny, crewLate, crewAny), left > 0);
    }
    const body = nudge +
      sub('🕑 Schedule') +
      (d.mineTimed.length ? capped('mineT', d.mineTimed.map(timedRow), 8)
        : empty('Nothing at a set time today.')) +
      // What is late first: it was wanted sooner than today's, and a long
      // list must not fold it away under "Show all".
      sub('✅ To do today') +
      (ownLate.length || ownAny.length ? capped('mineA', ownLate.map(x => todoRow(x, true)).concat(ownAny.map(x => todoRow(x, false))))
        : empty('Nothing else to get done today.')) +
      (crewLate.length || crewAny.length
        ? sub('👷 Crew tasks — anyone can do these') +
          capped('mineC', crewLate.map(x => todoRow(x, true)).concat(crewAny.map(x => todoRow(x, false))))
        : '');
    return card('day', title, countWords(c), link, body, left > 0);
  }

  // Notes to sort later (Jonah, 22 Oct 2026: "notes list on dashboard that
  // i can then sort when i get home so i dont have to select the proper
  // board whenever im out and about"): a box to type in, and the notes on
  // the Inbox board (boards.js), newest first -- each sorted onto a board
  // with a tap ("Sort" shows a button a board), or deleted. The owner's.
  let sortOpen = '';         // the note whose board buttons are showing

  // The box to jot one in is the first thing under his name, not in the
  // card (Jonah, 23 Oct 2026: "add a note should be on the top easily
  // accesible right when opening the app on mobile") -- Home is what the
  // app opens on, and on a phone the card sat under the figures and
  // Waiting on you, off the first screen. On a wide screen it comes after
  // the greeting and the weather, beside them where there is room
  // (styles.css .hm-jot). How many wait is a tap down to them.
  function jotHtml() {
    if (!isOwner() || !window.YDBoards || !YDBoards.inbox) return '';
    const n = YDBoards.inbox().length;
    return '<div class="hm-jot">' +
      '<div class="hm-note-add"><input id="hmNoteBox" maxlength="500" placeholder="📝 Jot a note — sort it later" ' +
        'enterkeyhint="done" onkeydown="if(event.key===\'Enter\'){event.preventDefault();homeNoteAdd()}" autocomplete="off">' +
        '<button type="button" class="btn btn-filled" onclick="homeNoteAdd()">Add</button></div>' +
      (n ? '<button type="button" class="hm-jot-n" onclick="homeGo(\'notes\')">' + n + (n === 1 ? ' note' : ' notes') + ' to sort ↓</button>' : '') +
    '</div>';
  }
  // The notes waiting -- only when there are some.
  function notesHtml() {
    if (!isOwner() || !window.YDBoards || !YDBoards.inbox) return '';
    const list = YDBoards.inbox();
    if (!list.length) return '';
    const targets = sortOpen ? YDBoards.sortTargets() : [];
    const rows = list.map(k => {
      const open = k.id === sortOpen;
      return '<div class="hm-note' + (open ? ' open' : '') + '">' +
        '<div class="hm-note-top"><span class="hm-note-t">' + esc(k.title || '') +
          (k.notes ? '<small>' + esc(String(k.notes).slice(0, 140)) + '</small>' : '') + '</span>' +
          '<button type="button" class="btn btn-sm hm-note-sort" onclick="homeNoteSort(\'' + safe(k.id) + '\')">' + (open ? 'Close' : 'Sort ▸') + '</button>' +
          '<button type="button" class="hm-note-x" onclick="homeNoteDrop(\'' + safe(k.id) + '\')" aria-label="Delete this note">✕</button></div>' +
        (open ? '<div class="hm-note-to">' + targets.map(b => '<button type="button" class="hm-note-b" style="--c:' + colour(b.color) + '"' +
            ' onclick="homeNoteTo(\'' + safe(k.id) + '\', \'' + safe(b.id) + '\')">' + esc(b.name || 'Board') + '</button>').join('') + '</div>' : '') +
        '</div>';
    });
    return card('notes', '📝 Notes to sort', list.length, ['Board', "homeBoard('inbox')"], capped('notes', rows, 6));
  }
  window.homeNoteAdd = function () {
    const box = el('hmNoteBox');
    const text = box ? box.value.trim() : '';
    if (!text) { if (box) box.focus(); return; }
    if (!YDBoards.inboxAdd(text)) { showToast('Notes can’t be saved just yet — still loading'); return; }
    box.value = '';
    // On a phone the list is screens below the box: say it went in.
    showToast('Note saved — sort it later');
    render();
    const again = el('hmNoteBox');
    if (again) again.focus();
  };
  window.homeNoteSort = function (id) { sortOpen = sortOpen === id ? '' : id; render(); };
  window.homeNoteTo = function (id, boardId) { sortOpen = ''; YDBoards.inboxSort(id, boardId); render(); };
  window.homeNoteDrop = async function (id) { await YDBoards.inboxDrop(id); render(); };

  // The owner's day with his to-dos split by where they get done. Jonah (22
  // Oct 2026): "my dashboard should have side by side for the to do list of
  // stuff to do in the office and stuff to do while im out". Two lists --
  // to do in the office, to do while out -- side by side where the card is
  // wide enough (a laptop: it is two thirds of Home's width there, html;
  // on a wider screen the schedule sits beside them too), one under the
  // other on a phone, the office's first. What could be done in either place (no place picked, and a tag
  // with no usual one) is a small list under them. Each list has its late
  // ones first, as the one list had; a tick does what it did (todoRow), and
  // the one count in the head is unchanged. Only his: the crew's day is the
  // crew's tasks, done out (Your day, unchanged for everyone else).
  function placesHtml(d, ownLate, ownAny, crewLate, crewAny) {
    const rows = ownLate.map(x => [x, true]).concat(ownAny.map(x => [x, false]));
    const of = id => rows.filter(r => (r[0].place || '') === id).map(r => todoRow(r[0], r[1]));
    const office = of('office'), out = of('out'), either = of('');
    const head = id => { const p = YDRemind.place(id); return (p.icon ? p.icon + ' ' : '') + p.list; };
    return '<div class="hm-places"><div class="hm-day-grid">' +
      '<div class="hm-day-sched">' + sub('🕑 Schedule') +
        (d.mineTimed.length ? capped('mineT', d.mineTimed.map(timedRow), 8) : empty('Nothing at a set time today.')) + '</div>' +
      '<div class="hm-day-office">' + sub(head('office')) +
        (office.length ? capped('mineO', office) : empty('Nothing for the office today.')) + '</div>' +
      '<div class="hm-day-out">' + sub(head('out')) +
        (out.length ? capped('mineOut', out) : empty('Nothing to get done out today.')) + '</div>' +
      (either.length ? '<div class="hm-day-either">' + sub(head('either')) + capped('mineE', either) + '</div>' : '') +
      '</div></div>' +
      (crewLate.length || crewAny.length
        ? sub('👷 Crew tasks — anyone can do these') +
          capped('mineC', crewLate.map(x => todoRow(x, true)).concat(crewAny.map(x => todoRow(x, false))))
        : '');
  }

  function crewDayHtml(d) {
    if (!signedIn()) return '';
    const crewView = !seesJobs() && !isOwner();
    const title = crewView ? '👷 The rest of the crew' : '👷 The crew’s day';
    // No link of its own: the calendar is one card up (My day's), and a
    // phone's narrow head has no room for both.
    const link = null;
    if (d === 'loading' || !d) return card('crew', title, '', link, empty('Loading…'));
    const tasks = d.crewAny.concat(d.crewLate);
    // Nobody on it (anyone's to do) apart from someone's already: the rows
    // of the second say who.
    const openLate = d.crewLate.filter(openCrew), openAny = d.crewAny.filter(openCrew);
    const takenLate = d.crewLate.filter(x => !openCrew(x)), takenAny = d.crewAny.filter(x => !openCrew(x));
    // Who is working right now: for whoever sees everyone's hours. A shift
    // on a long time (a clock-out forgotten, most likely) is marked.
    const now = window.YDClock && YDClock.onNow && can('hours', 'see') ? YDClock.onNow() : null;
    const onClock = now ? now.live.map(e => line(e.paused ? '⏸️' : e.long ? '⏱️' : '🟢', '<b>' + esc(e.who) + '</b> — ' + esc(e.where || 'on the clock'),
        [e.paused ? 'paused for ' + esc(e.paused) : '', e.long ? '<span class="hm-late">Long shift — still on?</span>' : '',
          e.since ? esc(e.since) : ''].filter(Boolean).join(' · '),
        esc(dur(e.ms)), "switchTab('clock')", (e.paused ? 'paused' : '') + (e.long ? ' hm-long' : '')))
      .concat(now.breaks.map(b => line('🍔', '<b>' + esc(b.who) + '</b> — on a break', esc(b.where), esc(dur(b.ms)),
        "switchTab('clock')", 'paused'))) : [];
    const body =
      sub('🕑 Schedule') +
      (d.crewTimed.length ? capped('crewT', d.crewTimed.map(timedRow), 8)
        : empty('Nothing on the crew’s calendar at a set time.')) +
      (!tasks.length ? sub('✅ Crew tasks') + empty('No crew tasks for today.') :
        (openLate.length || openAny.length ? sub('👷 Crew tasks — anyone can do these') +
          capped('crewA', openLate.map(x => todoRow(x, true)).concat(openAny.map(x => todoRow(x, false)))) : '') +
        (takenLate.length || takenAny.length ? sub('👤 Crew tasks someone is on') +
          capped('crewB', takenLate.map(x => todoRow(x, true)).concat(takenAny.map(x => todoRow(x, false)))) : '')) +
      (now ? sub('⏱️ On the clock now', now.live.length || null) +
        (onClock.length ? capped('onNow', onClock) : empty('Nobody is on the clock.')) : '') +
      tickedTodayHtml() +
      eodCrewHtml();
    // The crew's count by the same rule and words as My day's (calendar.js
    // tally): their tasks, at a set time or not, and the ones from earlier.
    const badge = now && now.live.length ? now.live.length + ' working' : countWords(d.crewCount || null);
    return card('crew', title, badge, link, body);
  }

  // The work the crew ticked off today (workdone.js), newest first: who,
  // what, on which job. For whoever sees the jobs (a tap opens the job).
  function tickedTodayHtml() {
    if (!seesJobs() || !window.YDWorkDone || !YDWorkDone.tickedOn) return '';
    const list = YDWorkDone.tickedOn(today());
    if (!list.length) return '';
    const names = {};
    jobs().forEach(j => { names[j._id] = nameOf(j); });
    return sub('✅ Work ticked off today', list.length) + capped('ticked', list.map(t => line('✅',
      '<b>' + esc(String(t.by || 'Someone').split(/\s+/)[0]) + '</b> — ' + esc(t.title),
      esc(names[t.jobId] || 'A job'), esc(YDWorkDone.whenWords(t.at)), "homeOpenJob('" + safe(t.jobId) + "')")), 4);
  }

  // The owner's: whose end of day is in today, of those on the list who
  // worked (eod.js). A tap opens theirs, or the list of them.
  function eodCrewHtml() {
    const list = isOwner() && window.YDEndOfDay && YDEndOfDay.crewToday ? YDEndOfDay.crewToday() : [];
    if (!list.length) return '';
    return sub('📋 End of day') + list.map(x => line(x.sent ? '✅' : '⏳',
      '<b>' + esc(x.who) + '</b> — ' + (x.sent ? 'sent' + (x.read ? '' : ', not read yet') : 'not in yet'),
      '', x.sent ? esc(new Date(x.sentAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })) : '',
      "openEodReports('" + (x.sent ? safe(x.id) : '') + "')", x.sent ? '' : 'paused')).join('');
  }

  // Booked and in progress, with the next day each is on the calendar.
  function jobsHtml(all) {
    if (!seesJobs()) return '';
    const next = signedIn() && window.YDCalendar && YDCalendar.nextForJobs ? YDCalendar.nextForJobs(60) : {};
    const list = all.filter(j => ['booked', 'inprogress'].indexOf(statusOf(j)) !== -1).map(j => ({ j: j, n: next[j._id] || null }))
      .sort((a, b) => (statusOf(a.j) === 'inprogress' ? 0 : 1) - (statusOf(b.j) === 'inprogress' ? 0 : 1) ||
        String(a.n ? a.n.day : '9999').localeCompare(b.n ? b.n.day : '9999') || nameOf(a.j).localeCompare(nameOf(b.j)));
    // A booked job with no day on the calendar is one to schedule; one under
    // way may simply have had its days already.
    // A booked job with no day says nothing on its own row: one line above
    // the list counts them ("Not on the calendar yet" on every row was most
    // of the card).
    const row = ({ j, n }) => {
      const when = n ? '<small class="hm-when">📅 ' + esc(dayWords(n.day)) + (n.time ? ' · ' + esc(n.time) : '') + '</small>'
        : !signedIn() || statusOf(j) === 'booked' ? ''
        : '<small class="hm-when none">No more days on the calendar</small>';
      const about = [whereOf(j), servicesOf(j)].filter(Boolean).join(' · ');
      // How far the crew have ticked the work off (workdone.js).
      const p = window.YDWorkDone ? YDWorkDone.ofJob(j) : null;
      return '<button class="hm-job" onclick="homeOpenJob(\'' + safe(j._id) + '\')">' +
        '<span class="hm-job-m">' + jobNameHtml(nameOf(j), numOf(j)) +
          (about ? '<small>' + esc(about) + '</small>' : '') + when + (p ? YDWorkDone.barHtml(p, 'wd-row') : '') + '</span>' +
        '<span class="hm-job-r">' +
          (priceOf(j) ? '<span class="hm-money">' + fmtMoney(priceOf(j)) + '</span>' : '') + '</span></button>';
    };
    const inProg = list.filter(x => statusOf(x.j) === 'inprogress'), booked = list.filter(x => statusOf(x.j) === 'booked');
    const unplanned = signedIn() ? booked.filter(x => !x.n).length : 0;
    // A few of each, then "Show all": on a wide screen the cards sit side by
    // side, and one long list left the cards beside it with a tall gap.
    const body = !list.length ? empty('Nothing booked yet.') :
      (inProg.length ? sub('🔨 In progress', inProg.length) + capped('jobsP', inProg.map(row), 4) : '') +
      (booked.length ? sub('📌 Booked', booked.length) +
        (unplanned ? '<div class="hm-note">📅 ' + unplanned + ' not scheduled yet</div>' : '') +
        capped('jobsB', booked.map(row), 4) : '');
    return card('jobs', '🔨 Booked & in progress', list.length || '', ['Jobs board', "homeBoard('jobs')"], body);
  }

  // Finished and not invoiced yet; then invoices still owed on.
  function invoiceHtml(all) {
    if (!seesJobs()) return '';
    const toInv = all.filter(needsInvoice)
      .sort((a, b) => String(a.workStageAt || a.lastModified || '').localeCompare(String(b.workStageAt || b.lastModified || '')));
    // Each job's invoice by the Invoices list's rule: paid there is off
    // here; a deposit paid on a job not finished yet is waiting for the job,
    // not on the customer, so it is listed apart and not as money owed.
    const unpaid = all.map(j => {
      const s = invState(j);
      return { j: j, bal: s ? s.bal : owed(j), st: s ? s.st : null, deposit: s ? s.deposit : 0 };
    }).filter(x => x.bal > 0.004 && !(x.st && x.st.kind === 'paid'))
      .sort((a, b) => String((invoiceOf(a.j) || {}).sentAt || '').localeCompare(String((invoiceOf(b.j) || {}).sentAt || '')));
    const owing = unpaid.filter(x => !(x.st && x.st.kind === 'waiting'));
    const waiting = unpaid.filter(x => x.st && x.st.kind === 'waiting');
    const total = toInv.reduce((s, j) => s + priceOf(j), 0);
    const invRow = j => {
      // How long it has waited: only when the board says when it was finished.
      const waited = j.workStage === 'toInvoice' ? daysSince(j.workStageAt) : null;
      const about = [whereOf(j), servicesOf(j)].filter(Boolean).join(' · ');
      return '<button class="hm-job" onclick="homeOpenJob(\'' + safe(j._id) + '\')">' +
        '<span class="hm-job-m">' + jobNameHtml(nameOf(j), numOf(j)) +
          (about ? '<small>' + esc(about) + '</small>' : '') +
          (waited != null ? '<small class="hm-when' + (waited >= 7 ? ' late' : '') + '">Finished ' + esc(ago(waited)) + '</small>' : '') +
        '</span><span class="hm-job-r"><span class="hm-money">' + (priceOf(j) ? fmtMoney(priceOf(j)) : '—') + '</span></span></button>';
    };
    // A deposit not paid yet on a job not finished is what is due now (the
    // Invoices list says "Deposit $X not paid"): its figure, not the whole
    // invoice's. `wait`: the deposit is in and the rest waits for the job.
    const owedRow = ({ j, bal, st, deposit }, wait) => {
      const inv = invoiceOf(j);
      const whole = parseFloat(inv.total);
      const dep = !wait && st && st.deposit && deposit > 0 && deposit < bal ? deposit : 0;
      return '<button class="hm-job" onclick="homeOpenJob(\'' + safe(j._id) + '\')">' +
        '<span class="hm-job-m">' + jobNameHtml(nameOf(j), numOf(j)) +
          '<small>Invoice' + (inv.docNumber ? ' #' + esc(inv.docNumber) : '') +
            (wait ? ' · deposit paid — the rest is due when the job is done'
              : (whole > 0 ? ' · ' + fmtMoney(whole) + ' in all' : '') +
                (inv.sentAt ? ' · sent ' + esc(ago(daysSince(inv.sentAt))) : '')) + '</small></span>' +
        (wait ? '<span class="hm-job-r"><span class="hm-money">' + fmtMoney(bal) + '</span><small>when done</small></span>'
          : '<span class="hm-job-r"><span class="hm-money owed">' + fmtMoney(dep || bal) + '</span><small>' +
            (dep ? 'deposit' : 'owed') + '</small></span>') + '</button>';
    };
    const body =
      (toInv.length ? capped('inv', toInv.map(invRow)) : empty('Nothing waiting to be invoiced.')) +
      (owing.length ? sub('💵 Waiting on payment', owing.length) + capped('owed', owing.map(x => owedRow(x, false))) : '') +
      (waiting.length ? sub('🔨 Deposit paid, job not done yet', waiting.length) +
        capped('owedWait', waiting.map(x => owedRow(x, true)), 3) : '');
    return card('invoice', '🧾 Needs invoicing', toInv.length ? toInv.length + ' · ' + dollars(total) : '',
      ['Jobs board', "homeBoard('jobs')"], body, toInv.length > 0);
  }

  // The open bids by what each wants next, each in one group only: a yes
  // to book, a draft to check and send, a chase (the Bids board's own
  // follow-up rule), the wait, or the site visit and the writing up.
  function bidGroups(all) {
    const b = B();
    if (!b || !b.bidColumn || !b.acceptedToBook || !b.hasDraft || !b.toChase) return null;
    const open = all.filter(j => { const c = b.bidColumn(j); return c && c !== 'won'; });
    const taken = {};
    const take = list => {
      const mine = list.filter(j => !taken[j._id]);
      mine.forEach(j => { taken[j._id] = true; });
      return mine;
    };
    const yes = take(open.filter(j => b.acceptedToBook(j)));
    // Turned down in QuickBooks: never chased or "waiting" (boards.js
    // turnedDown); `no` lists them for a "mark lost?" line.
    const no = take(open.filter(j => b.turnedDown && b.turnedDown(j)));
    const drafted = take(open.filter(j => b.hasDraft(j)));
    const chase = b.toChase().filter(x => !taken[x.j._id]);
    chase.forEach(x => { taken[x.j._id] = true; });
    const waiting = take(open.filter(j => b.bidColumn(j) === 'sent'));
    const toDo = take(open.filter(j => ['siteVisit', 'toSend'].indexOf(b.bidColumn(j)) !== -1));
    return { open, yes, no, drafted, chase, waiting, toDo };
  }

  function bidsHtml(all) {
    const g = seesJobs() ? bidGroups(all) : null;
    if (!g) return '';
    const { open, yes, drafted, chase, waiting, toDo } = g;
    const bc = j => B().bidColumn(j);
    const row = (j, words, late) => '<button class="hm-job" onclick="homeOpenJob(\'' + safe(j._id) + '\')">' +
      '<span class="hm-job-m">' + jobNameHtml(nameOf(j), numOf(j)) +
        (words ? '<small class="hm-when' + (late ? ' late' : '') + '">' + esc(words) + '</small>' : '') + '</span>' +
      '<span class="hm-job-r">' + (priceOf(j) ? '<span class="hm-money">' + fmtMoney(priceOf(j)) + '</span>' : '') + '</span></button>';
    const sentWords = j => { const d = daysSince(j.bidStageAt || j.lastModified); return d == null ? '' : 'Sent ' + ago(d); };
    // Bids the customer turned down in QuickBooks, when the Bids board
    // sorts them out (boards.js: `no`, not in any group below) -- listed so
    // they do not simply vanish from Home before they are marked lost.
    // (Each a job, or { j } like the chase list.)
    const no = (Array.isArray(g.no) ? g.no : []).map(x => (x && x.j ? x.j : x)).filter(j => j && j._id);
    const body = !open.length && !no.length ? empty('No bids open right now.') :
      (yes.length ? sub('✅ Said yes in QuickBooks — book it', yes.length) + capped('bidY', yes.map(j => row(j, 'Open it and press Make it a job'))) : '') +
      (drafted.length ? sub('📝 Estimate ready — check it & send', drafted.length) + capped('bidD', drafted.map(j => row(j, servicesOf(j)))) : '') +
      (chase.length ? sub('📨 Due a follow-up', chase.length) + capped('bidC', chase.map(x =>
        row(x.j, (x.col === 'followUp' ? 'In Follow up · ' : '') + sentWords(x.j), x.days >= 14))) : '') +
      (waiting.length ? sub('🕑 Waiting on the customer', waiting.length) + capped('bidW', waiting.map(j => row(j, sentWords(j)))) : '') +
      (toDo.length ? sub('📍 Site visits & bids to write', toDo.length) + capped('bidT', toDo.map(j =>
        row(j, bc(j) === 'siteVisit' ? 'Site visit' : 'Bid to send'))) : '') +
      (no.length ? sub('✖ Turned down in QuickBooks', no.length) +
        capped('bidN', no.map(j => row(j, 'Open it to mark it lost, or follow up'))) : '');
    const needs = yes.length + drafted.length + chase.length;
    return card('bids', '📋 Bids', needs ? needs + ' need you' : open.length || '', ['Bids board', "homeBoard('bids')"], body, needs > 0);
  }

  // What is waiting on this person: notes from the crew, hours to look at,
  // changes the crew asked for, receipts to sort, subcontractor bills to
  // put with a client.
  function waitingHtml() {
    if (!signedIn()) return '';
    const rows = [];
    let any = false;
    if (isOwner() && window.YDCrewNotes && YDCrewNotes.unreadList) {
      any = true;
      YDCrewNotes.unreadList().forEach(n => rows.push(line('📝', '<b>' + esc(n.by) + '</b>' + (n.jobName ? ' · ' + esc(n.jobName) : ''),
        esc(String(n.text).slice(0, 140)) + (String(n.text).length > 140 ? '…' : ''),
        esc(n.at ? dayWords(localYMD(new Date(n.at))) : ''), 'openCrewNotes()')));
    }
    // End-of-day reports in and not read yet (eod.js): a tap opens that one.
    if (isOwner() && window.YDEndOfDay && YDEndOfDay.unread) {
      any = true;
      YDEndOfDay.unread().forEach(r => rows.push(line('📋', '<b>' + esc(r.who) + '’s end of day</b>' +
          (r.day !== today() ? ' · ' + esc(dayWords(r.day)) : ''),
        esc(String(r.words).slice(0, 140)) + (String(r.words).length > 140 ? '…' : ''),
        esc(r.at ? new Date(r.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''),
        "openEodReports('" + safe(r.id) + "')")));
    }
    // A job whose every piece of work is ticked off (workdone.js): mark it
    // finished? Never done for him -- the Jobs board's card has the button
    // (which asks for the photos first).
    if (can('jobs', 'change') && window.YDWorkDone && YDWorkDone.allDone) {
      any = true;
      YDWorkDone.allDone().forEach(x => rows.push(line('✅', '<b>Everything on ' + esc(nameOf(x.j)) + ' is ticked</b>',
        'All ' + x.p.total + ' pieces of work done — mark it finished?', '', "homeBoard('jobs')")));
    }
    if (can('hours', 'change') && window.YDClock && YDClock.toDecide) {
      any = true;
      const t = YDClock.toDecide();
      if (t.shifts) rows.push(line('⏱️', '<b>' + plural(t.shifts, 'shift') + ' to look at</b>', 'Typed in by hand, or a very long day',
        '', "switchTab('clock')"));
      if (t.asks) rows.push(line('🙋', '<b>' + plural(t.asks, 'change') + ' the crew asked for</b>', 'Clock times or storm figures', '', "switchTab('clock')"));
    }
    // Receipts are sorted by whoever may change jobs (receipts.js): only
    // they are waited on.
    const rcTab = el('tabReceipts');
    if (can('jobs', 'change') && window.YDReceipts && rcTab && !rcTab.hidden) {
      any = true;
      const open = Object.values(YDReceipts.all() || {}).filter(r => r && window.YDStages.receipt(r).id === 'tosort')
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      if (open.length) {
        const top = open.slice(0, 3).map(r => esc(r.vendor || 'Receipt') +
          (r.totalCents != null ? ' ' + fmtMoney((Number(r.totalCents) || 0) / 100) : '')).join(' · ');
        // Photos that could not go on their job by themselves say so first.
        const stuck = YDReceipts.needsYou ? open.filter(YDReceipts.needsYou).length : 0;
        rows.push(line('🧾', '<b>' + plural(open.length, 'receipt') + ' to sort</b>',
          (stuck ? '<b>' + stuck + ' need' + (stuck === 1 ? 's' : '') + ' you</b> · ' : '') + top + (open.length > 3 ? ' …' : ''), '',
          "switchTab('receipts')"));
      }
    }
    // Subcontractor bills no client could be told from (subs.js) -- the
    // owner's, who alone has the subcontractors.
    if (isOwner() && window.YDSubs && YDSubs.toMatch) {
      any = true;
      const subs = YDSubs.toMatch(), n = subs.reduce((t, x) => t + x.n, 0);
      if (n) rows.push(line('🤝', '<b>' + plural(n, 'subcontractor bill') + ' to match to a client</b>',
        subs.map(x => esc(x.name) + ' · ' + x.n).join(' · '), '', "openSubBills('" + safe(subs[0].id) + "')"));
    }
    // Invoices to chase (invoices.js): a reminder due, one never emailed,
    // or past its reminders -- for whoever may send them.
    if (can('billing', 'change') && window.YDInvoices && YDInvoices.toDo) {
      any = true;
      const due = YDInvoices.toDo();
      if (due.length) {
        const owed = due.reduce((t, x) => t + (Number(x.inv.balance) || 0), 0);
        const top = due.slice(0, 3).map(x => esc(x.inv.customerName || 'A customer') + ' ' + fmtMoney(x.inv.balance)).join(' · ');
        rows.push(line('💵', '<b>' + plural(due.length, 'invoice') + ' to chase</b> · ' + fmtMoney(owed),
          top + (due.length > 3 ? ' …' : ''), '', 'openInvoices()'));
      }
    }
    if (!any) return '';
    return card('waiting', '📥 Waiting on you', rows.length || '', null,
      rows.length ? capped('wait', rows) : empty('Nothing waiting on you.'), rows.length > 0);
  }

  // Machines that want a look, for whoever sees Equipment.
  function equipmentHtml() {
    if (!signedIn() || !can('equipment', 'see') || !window.YDEquipment || !YDEquipment.needs) return '';
    const list = YDEquipment.needs();
    const down = list.filter(x => x.issue && x.issue.urgency === 'down').length;
    const rows = list.map(x => line(x.issue ? '🔧' : '🛢️', '<b>' + esc(x.name) + '</b>' +
        (x.issue ? ' <span class="hm-chip" style="' + '--c:' + colour(x.issue.color) + (typeof inkOn === 'function' ? ';color:' + inkOn(colour(x.issue.color)) : '') + '">' + esc(x.issue.label) + '</span>' : ''),
      (x.issue ? esc(x.issue.what) + (x.issue.more > 0 ? ' · +' + x.issue.more + ' more' : '') : '') +
        (x.due.state === 'overdue' || x.due.state === 'soon'
          ? (x.issue ? ' · ' : '') + '<span class="hm-due ' + x.due.state + '">Service ' + esc(x.due.text) + '</span>' : ''),
      '', "homeMachine('" + safe(x.id) + "')"));
    return card('equipment', '🚜 Equipment', down ? down + ' out of service' : list.length || '', ['Equipment', "switchTab('equipment')"],
      rows.length ? capped('eq', rows) : empty('Every machine is good to go.'), down > 0);
  }

  // The crew's own jobs (their Jobs tab's list), with the next day each is
  // on and whether they are on it today.
  function crewJobsHtml(d) {
    if (!signedIn() || seesJobs() || !window.YDCrewJobs || !YDCrewJobs.list) return '';
    const list = YDCrewJobs.list();
    const next = window.YDCalendar && YDCalendar.nextForJobs ? YDCalendar.nextForJobs(60) : {};
    const mineToday = {};
    // On it by name -- not a crew day nobody is on yet (anyone's: openCrew).
    if (d && d !== 'loading') d.mineTimed.concat(d.mineAny).forEach(x => { if (x.o && x.o.ev && x.o.ev.jobId && !openCrew(x)) mineToday[x.o.ev.jobId] = 1; });
    const rows = list.map(j => {
      const n = next[j.id];
      return '<button class="hm-job" onclick="openCrewJob(\'' + safe(j.id) + '\')">' +
        '<span class="hm-job-m"><b>' + esc(j.name || 'Job') + '</b>' + (j.est ? ' <span class="job-num">#' + esc(j.est) + '</span>' : '') +
          (j.what ? '<small class="hm-job-what">' + esc(j.what) + '</small>' : '') +
          '<small>' + esc([j.address, j.city].filter(Boolean).join(', ')) + '</small>' +
          (mineToday[j.id] ? '<small class="hm-when you">👷 You’re on it today</small>'
            : n ? '<small class="hm-when">📅 ' + esc(dayWords(n.day)) + (n.time ? ' · ' + esc(n.time) : '') + '</small>' : '') +
          (YDCrewJobs.progressHtml ? YDCrewJobs.progressHtml(j) : '') +
        '</span><span class="hm-job-r"><span class="cj-status">' + (j.status === 'inprogress' ? 'In progress' : 'Booked') + '</span></span></button>';
    });
    return card('cjobs', '🧰 Jobs', list.length || '', ['Jobs', "switchTab('crewjobs')"],
      rows.length ? capped('cjobs', rows) : empty('No booked jobs right now.'));
  }

  // ------------------------------------------------------------ drawing

  function html() {
    const a = window.YDAuth;
    if (!a || (a.mode === 'cloud' && !a.user)) return '<p class="empty-msg">Loading…</p>';
    drawn = {};
    const all = seesJobs() ? jobs() : [];
    const d = dayData();
    const crewish = signedIn() && !seesJobs();
    // What is waiting on the owner first, under the figures -- notes from
    // the crew, hours to look at, receipts -- then his day, the crew's, and
    // the work and the money. The crew: their clock, their day, the rest of
    // the crew, their jobs.
    const top = greetingHtml() + actionsHtml() + stormHtml() + statsHtml(all);
    // The owner's day is wide (placesHtml: his office and out lists side by
    // side), so on a wide screen it takes two thirds of the width beside
    // Waiting on you, and the rest flow in columns under them. A phone has
    // them one under the other, in the same order as before.
    if (!crewish && isOwner()) {
      const side = [waitingHtml(), notesHtml(), clockHtml(), eodHtml()].filter(Boolean).join('');
      const day = myDayHtml(d);
      return top + '<div class="hm-lead"><div class="hm-lead-side">' + side + '</div>' + day + '</div>' +
        '<div class="hm-grid">' + [crewDayHtml(d), jobsHtml(all), invoiceHtml(all), bidsHtml(all), equipmentHtml()]
          .filter(Boolean).join('') + '</div>';
    }
    const cards = crewish
      ? [clockHtml(), eodHtml(), myDayHtml(d), crewDayHtml(d), crewJobsHtml(d), waitingHtml(), equipmentHtml()]
      : [waitingHtml(), clockHtml(), eodHtml(), myDayHtml(d), crewDayHtml(d), jobsHtml(all), invoiceHtml(all), bidsHtml(all), equipmentHtml()];
    return top + '<div class="hm-grid">' + cards.filter(Boolean).join('') + '</div>';
  }

  function render() {
    const wrap = el('homeWrap');
    if (!wrap) return;
    clearTimeout(soonTimer); soonTimer = 0;
    let out;
    try { out = html(); } catch (e) {
      // One module not ready (or a bad record) must not leave Home blank:
      // say so -- and the fault is thrown again on its own, outside the
      // draw, so the Problems screen (problems.js) still hears of it.
      console.error('[home] could not draw', e);
      setTimeout(() => { throw e; }, 0);
      out = '<p class="empty-msg">Home could not be drawn just now — the tabs below still work.</p>';
    }
    // Drawn again only when something on it changed: the clock and every
    // other screen tell Home of changes it does not show, and replacing the
    // page under a thumb loses the tap.
    if (out !== lastHtml || !wrap.firstChild) {
      // A note half typed (notesHtml) is kept through the redraw, with the
      // cursor where it was.
      const nb = el('hmNoteBox');
      const typed = nb ? { v: nb.value, focus: document.activeElement === nb, at: nb.selectionStart } : null;
      wrap.innerHTML = out; lastHtml = out;
      const again = typed && el('hmNoteBox');
      if (again && typed.v) again.value = typed.v;
      if (again && typed.focus) { again.focus(); try { again.setSelectionRange(typed.at, typed.at); } catch (e) {} }
    }
    manageTicker();
  }
  // Many changes arrive together (a whole calendar, every card on a board):
  // one draw for the lot, and none at all while Home is not on screen --
  // switchTab draws it on arrival.
  function soon() {
    if (!showing() || soonTimer) return;
    soonTimer = setTimeout(() => { soonTimer = 0; if (showing()) render(); }, 80);
  }
  // Running times and "today" move on by themselves: once a minute while
  // Home is in front.
  function manageTicker() {
    const want = showing() && !document.hidden;
    if (want && !ticker) ticker = setInterval(() => { if (showing() && !document.hidden) render(); else manageTicker(); }, 60000);
    if (!want && ticker) { clearInterval(ticker); ticker = 0; }
  }

  // ------------------------------------------------------------- taps

  window.homeOpen = function (k) {
    const o = drawn[k];
    if (o && window.YDCalendar && YDCalendar.open) YDCalendar.open(o);
  };
  window.homeTick = function (k, on) {
    const o = drawn[k];
    if (o && window.YDCalendar && YDCalendar.tick) YDCalendar.tick(o, on);
    // Drawn again even when nothing changed: a tick that was refused must
    // not stay looking ticked.
    lastHtml = '';
    render();
  };
  window.homeMore = function (key) { expanded[key] = !expanded[key]; render(); };
  window.homeGo = function (id) {
    if (id === 'invoices' && window.openInvoices) { openInvoices(); return; }
    const c = el('hm-' + id);
    if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  window.homeBoard = function (id) {
    switchTab('boards');
    if (window.showBoard) showBoard(id);
  };
  // A job, on the Job tab -- the same way the calendar and the boards open
  // one: the job already in the form is just shown (loading it again would
  // throw away what is typed and not yet saved).
  window.homeOpenJob = async function (id) {
    if (typeof currentJobId !== 'undefined' && currentJobId === id) { switchTab('job'); return; }
    if (!(await ydLeaveUnsavedJob())) return;
    if (typeof loadJob === 'function') loadJob(id);
  };
  window.homeMachine = function (id) {
    switchTab('equipment');
    if (window.openEquipment) openEquipment(id);
  };
  window.homeClockIn = function () {
    switchTab('clock');
    if (window.openJobPicker) openJobPicker();
  };
  // Clock out, or back in from a break, by the clock's own buttons
  // (timeclock.js) -- then Home at once: the clock only tells the other
  // screens when the database answers, which with no signal is later.
  window.homeClock = function (what, id) {
    if (['clockOut', 'backFromBreak', 'takeBreak', 'undoClockOut'].indexOf(what) === -1 || typeof window[what] !== 'function') return;
    window[what](id);
    // Back from a break to a storm that has finished or a job that has gone:
    // the clock asks what instead, on its own tab.
    if (what === 'backFromBreak' && window.YDClock && YDClock.mine && !YDClock.mine().shift) { switchTab('clock'); return; }
    if (showing()) render();
  };
  // The storm's stop to see to next, on the Snow tab: scrolled to and
  // lit up for a moment. The Snow tab does it itself where it can
  // (storm.js focusStop: it also opens a folded stop); otherwise it is
  // found by the id storm.js gives each stop (stop-<its id>) -- looked for
  // a few times, as the Snow tab may still be drawing it.
  window.homeStop = function (id) {
    if (id && window.YDStorm && YDStorm.focusStop && YDStorm.focusStop(id) !== false) return;
    if (typeof switchTab === 'function') switchTab('snow');
    if (!id) return;
    const find = tries => {
      const n = document.getElementById('stop-' + safe(id));
      if (n) {
        if (n.scrollIntoView) n.scrollIntoView({ block: 'center', behavior: 'smooth' });
        n.classList.add('hm-flash');
        setTimeout(() => n.classList.remove('hm-flash'), 1800);
      } else if (tries > 0) setTimeout(() => find(tries - 1), 150);
    };
    setTimeout(() => find(8), 60);
  };
  // On the storm's clock in one tap (the clock's own clock-in, so it is
  // the same shift the Clock tab would start).
  window.homeStormIn = function () {
    const s = window.YDStorm && YDStorm.current();
    if (!window.YDStages.stormOpen(s) || typeof window.clockInTo !== 'function') return;
    window.clockInTo('storm', s.id);
    if (showing()) render();
  };
  window.homeAddEntry = function () {
    if (window.calAdd) calAdd(today());
  };
  // The week's weather drops down under the header, which is at the top of
  // the page: scrolled there, so it is not opened out of sight.
  window.homeWeather = function () {
    const p = el('wxPanel');
    if (p && p.hidden && window.toggleWeek) toggleWeek();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  window.YDHome = { render: render };

  // ------------------------------------------------------------ wiring

  // Looked at again a few times while everything is first arriving. Each
  // screen says when it changes, but at start-up a calendar's entries can
  // land in the same moment as the draw that was waiting for them (My day
  // here showed fewer than the Calendar until the next minute's redraw);
  // drawn again only if something on it is different.
  let warmTimers = [];
  function warmUp() {
    warmTimers.forEach(clearTimeout);
    warmTimers = [1500, 4000, 9000, 15000].map(ms => setTimeout(() => { if (showing()) render(); }, ms));
  }

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    if (a.user && !authAt) { authAt = Date.now(); warmUp(); }
    if (!a.user) authAt = 0;
    lastHtml = '';
    if (showing()) render();
  });
  ['yd-jobs-changed', 'yd-jobs-restored', 'yd-calendar-changed', 'yd-cards-changed', 'yd-boards-changed', 'yd-boards-ready',
   'yd-clock-changed', 'yd-requests', 'yd-receipts', 'yd-remind-me', 'yd-equipment-changed', 'yd-crew-notes',
   'yd-crew-jobs', 'yd-storm-changed', 'yd-forecast', 'yd-outreach', 'yd-invoices', 'yd-subs', 'yd-eod', 'yd-workdone'].forEach(name => document.addEventListener(name, soon));
  // Back to the app after a while: the day may have turned over.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && showing()) render(); else manageTicker(); });

  function boot() { if (showing()) render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
