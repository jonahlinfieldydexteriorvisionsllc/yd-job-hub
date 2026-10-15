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
  function daysSince(iso) {
    const t = iso ? new Date(iso).getTime() : NaN;
    return isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 864e5)) : null;
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
  // Ready to invoice: the Jobs board's own column, unless QuickBooks already
  // has an invoice for it (made from the estimate before anybody moved it).
  function needsInvoice(j) {
    const col = B() && B().workColumn ? B().workColumn(j) : null;
    return col === 'toInvoice' && !invoiceOf(j);
  }
  function owed(j) {
    const inv = invoiceOf(j);
    const bal = inv ? parseFloat(inv.balance) : NaN;
    if (!(bal > 0.004)) return 0;
    const col = B() && B().workColumn ? B().workColumn(j) : null;
    return col === 'paid' ? 0 : bal;
  }

  // ---------------------------------------------------------- the sections

  function greetingHtml() {
    const h = new Date().getHours();
    const hello = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name = firstName();
    const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    return '<div class="hm-top">' +
      '<div class="hm-hello"><div class="hm-hi">' + esc(hello + (name ? ', ' + name : '')) + '</div>' +
        '<div class="hm-date">' + esc(date) + '</div></div>' +
      weatherHtml() +
    '</div>';
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
    const owing = all.map(owed).filter(v => v > 0);
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
      (owing.length ? tile('invoice', '#c8492b', dollars(owing.reduce((s, v) => s + v, 0)), 'Owed to you',
        'on ' + plural(owing.length, 'invoice')) : '') +
      tile('bids', '#2f6fd6', bidsOut.length, 'Bids out',
        (bidsOut.length ? dollars(sum(bidsOut)) : 'none waiting') + (chase ? ' · ' + chase + ' to chase' : '')) +
    '</div>';
  }

  // A storm being worked: right at the top, for anybody it is news to.
  function stormHtml() {
    const s = window.YDStorm && YDStorm.current();
    if (!s || s.status !== 'open') return '';
    const stops = Object.values((YDStorm.stops && YDStorm.stops()) || {});
    const done = stops.filter(x => x.departedAt || x.skipped).length;
    const at = s.startedAt ? new Date(s.startedAt) : null;
    // "9:19pm", the way the calendar writes a time.
    const since = at && !isNaN(at) ? at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      .replace(/\s*([AP])M$/i, (m, ap) => ap.toLowerCase() + 'm') : '';
    return '<button class="hm-alert" onclick="switchTab(\'snow\')">❄️ <b>Storm under way</b>' +
      (s.label ? ' — ' + esc(s.label) : '') +
      '<span>' + (stops.length ? done + ' of ' + stops.length + ' stops done' : 'route starting') +
        (since ? ' · since ' + esc(since) : '') + '</span><span class="hm-alert-go">Snow ›</span></button>';
  }

  // This person's own clock (not the owner's: his is on the Clock tab, and
  // the crew's are under the crew's day).
  function clockHtml() {
    if (!signedIn() || isOwner() || !window.YDClock || !YDClock.mine) return '';
    const m = YDClock.mine();
    let body, badge = '';
    if (m.shift) {
      badge = m.shift.paused ? 'Paused' : 'On the clock';
      body = '<div class="hm-clock on">' +
          '<div class="hm-clock-where">' + esc(m.shift.where || 'Working') + '</div>' +
          '<div class="hm-clock-sub">in at ' + esc(m.shift.since) + ' · <b>' + esc(dur(m.shift.ms)) + '</b>' +
            (m.shift.paused ? ' · paused for ' + esc(m.shift.paused) : '') + '</div></div>' +
        '<div class="hm-actions">' +
          '<button class="btn btn-filled" onclick="switchTab(\'clock\')">Go to the clock</button>' +
          '<button class="btn" onclick="homeClock(\'clockOut\', \'' + safe(m.shift.id) + '\')">Clock out</button></div>';
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

  // The day: what is mine (at set times, then for any time today and what
  // is late), and the crew's that is not mine.
  function dayData() {
    if (!signedIn() || !window.YDCalendar || !YDCalendar.day) return null;
    if (!YDCalendar.ready() && Date.now() - authAt < WARM_UP_MS) return 'loading';
    return YDCalendar.day(today()) || 'loading';
  }

  function myDayHtml(d) {
    if (!signedIn()) return '';
    const title = isOwner() ? '📅 My day' : '📅 Your day';
    const link = ['Calendar', "switchTab('calendar')"];
    if (d === 'loading' || !d) return card('day', title, '', link, empty('Loading…'));
    const todo = d.mineAny.concat(d.mineLate);
    const left = todo.filter(x => !x.done).length;
    const body =
      sub('🕑 Schedule', d.mineTimed.length || null) +
      (d.mineTimed.length ? capped('mineT', d.mineTimed.map(timedRow), 8)
        : empty('Nothing at a set time today.')) +
      // What is late first: it was wanted sooner than today's, and a long
      // list must not fold it away under "Show all".
      sub('✅ To do today', left || null) +
      (todo.length ? capped('mineA', d.mineLate.map(x => todoRow(x, true)).concat(d.mineAny.map(x => todoRow(x, false))))
        : empty('Nothing else to get done today.'));
    return card('day', title, left ? left + ' to do' : todo.length ? 'all done' : '', link, body, left > 0);
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
    const left = tasks.filter(x => !x.done).length;
    // Who is working right now: for whoever sees everyone's hours.
    const now = window.YDClock && YDClock.onNow && can('hours', 'see') ? YDClock.onNow() : null;
    const onClock = now ? now.live.map(e => line(e.paused ? '⏸️' : '🟢', '<b>' + esc(e.who) + '</b> — ' + esc(e.where || 'on the clock'),
        e.paused ? 'paused for ' + esc(e.paused) : '', esc(dur(e.ms)), "switchTab('clock')", e.paused ? 'paused' : ''))
      .concat(now.breaks.map(b => line('🍔', '<b>' + esc(b.who) + '</b> — on a break', esc(b.where), esc(dur(b.ms)),
        "switchTab('clock')", 'paused'))) : [];
    const body =
      sub('🕑 Schedule', d.crewTimed.length || null) +
      (d.crewTimed.length ? capped('crewT', d.crewTimed.map(timedRow), 8)
        : empty('Nothing on the crew’s calendar at a set time.')) +
      sub('✅ Crew tasks', left || null) +
      (tasks.length ? capped('crewA', d.crewLate.map(x => todoRow(x, true)).concat(d.crewAny.map(x => todoRow(x, false))))
        : empty('No crew tasks for today.')) +
      (now ? sub('⏱️ On the clock now', now.live.length || null) +
        (onClock.length ? capped('onNow', onClock) : empty('Nobody is on the clock.')) : '');
    const badge = now && now.live.length ? now.live.length + ' working' : left ? left + ' to do' : '';
    return card('crew', title, badge, link, body);
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
    const row = ({ j, n }) => {
      const when = n ? '<small class="hm-when">📅 ' + esc(dayWords(n.day)) + (n.time ? ' · ' + esc(n.time) : '') + '</small>'
        : !signedIn() ? '' : statusOf(j) === 'booked' ? '<small class="hm-when none">Not on the calendar yet</small>'
        : '<small class="hm-when none">No more days on the calendar</small>';
      const about = [whereOf(j), servicesOf(j)].filter(Boolean).join(' · ');
      return '<button class="hm-job" onclick="homeOpenJob(\'' + safe(j._id) + '\')">' +
        '<span class="hm-job-m">' + jobNameHtml(nameOf(j), numOf(j)) +
          (about ? '<small>' + esc(about) + '</small>' : '') + when + '</span>' +
        '<span class="hm-job-r">' +
          (priceOf(j) ? '<span class="hm-money">' + fmtMoney(priceOf(j)) + '</span>' : '') + '</span></button>';
    };
    const inProg = list.filter(x => statusOf(x.j) === 'inprogress'), booked = list.filter(x => statusOf(x.j) === 'booked');
    const body = !list.length ? empty('Nothing booked yet.') :
      (inProg.length ? sub('🔨 In progress', inProg.length) + capped('jobsP', inProg.map(row)) : '') +
      (booked.length ? sub('📌 Booked', booked.length) + capped('jobsB', booked.map(row)) : '');
    return card('jobs', '🔨 Booked & in progress', list.length || '', ['Jobs board', "homeBoard('jobs')"], body);
  }

  // Finished and not invoiced yet; then invoices still owed on.
  function invoiceHtml(all) {
    if (!seesJobs()) return '';
    const toInv = all.filter(needsInvoice)
      .sort((a, b) => String(a.workStageAt || a.lastModified || '').localeCompare(String(b.workStageAt || b.lastModified || '')));
    const owing = all.map(j => ({ j: j, bal: owed(j) })).filter(x => x.bal > 0)
      .sort((a, b) => String((invoiceOf(a.j) || {}).sentAt || '').localeCompare(String((invoiceOf(b.j) || {}).sentAt || '')));
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
    const owedRow = ({ j, bal }) => {
      const inv = invoiceOf(j);
      const whole = parseFloat(inv.total);
      return '<button class="hm-job" onclick="homeOpenJob(\'' + safe(j._id) + '\')">' +
        '<span class="hm-job-m">' + jobNameHtml(nameOf(j), numOf(j)) +
          '<small>Invoice' + (inv.docNumber ? ' #' + esc(inv.docNumber) : '') +
            (whole > 0 ? ' · ' + fmtMoney(whole) + ' in all' : '') +
            (inv.sentAt ? ' · sent ' + esc(ago(daysSince(inv.sentAt))) : '') + '</small></span>' +
        '<span class="hm-job-r"><span class="hm-money owed">' + fmtMoney(bal) + '</span><small>owed</small></span></button>';
    };
    const body =
      (toInv.length ? capped('inv', toInv.map(invRow)) : empty('Nothing waiting to be invoiced.')) +
      (owing.length ? sub('💵 Waiting on payment', owing.length) + capped('owed', owing.map(owedRow)) : '');
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
    const body = !open.length ? empty('No bids open right now.') :
      (yes.length ? sub('✅ Said yes in QuickBooks — book it', yes.length) + capped('bidY', yes.map(j => row(j, 'Open it and press Make it a job'))) : '') +
      (drafted.length ? sub('✨ Estimate drafted — check it & send', drafted.length) + capped('bidD', drafted.map(j => row(j, servicesOf(j)))) : '') +
      (chase.length ? sub('📨 Due a follow-up', chase.length) + capped('bidC', chase.map(x =>
        row(x.j, (x.col === 'followUp' ? 'In Follow up · ' : '') + sentWords(x.j), x.days >= 14))) : '') +
      (waiting.length ? sub('🕑 Waiting on the customer', waiting.length) + capped('bidW', waiting.map(j => row(j, sentWords(j)))) : '') +
      (toDo.length ? sub('📍 Site visits & bids to write', toDo.length) + capped('bidT', toDo.map(j =>
        row(j, bc(j) === 'siteVisit' ? 'Site visit' : 'Bid to send'))) : '');
    const needs = yes.length + drafted.length + chase.length;
    return card('bids', '📋 Bids', needs ? needs + ' need you' : open.length || '', ['Bids board', "homeBoard('bids')"], body, needs > 0);
  }

  // What is waiting on this person: notes from the crew, hours to look at,
  // changes the crew asked for, receipts to sort.
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
      const open = Object.values(YDReceipts.all() || {}).filter(r => r && r.status === 'new')
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      if (open.length) {
        const top = open.slice(0, 3).map(r => esc(r.vendor || 'Receipt') +
          (r.totalCents != null ? ' ' + fmtMoney((Number(r.totalCents) || 0) / 100) : '')).join(' · ');
        rows.push(line('🧾', '<b>' + plural(open.length, 'receipt') + ' to sort</b>', top + (open.length > 3 ? ' …' : ''), '',
          "switchTab('receipts')"));
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
        (x.issue ? ' <span class="hm-chip" style="--c:' + colour(x.issue.color) + '">' + esc(x.issue.label) + '</span>' : ''),
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
    if (d && d !== 'loading') d.mineTimed.concat(d.mineAny).forEach(x => { if (x.o && x.o.ev && x.o.ev.jobId) mineToday[x.o.ev.jobId] = 1; });
    const rows = list.map(j => {
      const n = next[j.id];
      return '<button class="hm-job" onclick="openCrewJob(\'' + safe(j.id) + '\')">' +
        '<span class="hm-job-m"><b>' + esc(j.name || 'Job') + '</b>' + (j.est ? ' <span class="job-num">#' + esc(j.est) + '</span>' : '') +
          '<small>' + esc([j.address, j.city].filter(Boolean).join(', ')) + '</small>' +
          (mineToday[j.id] ? '<small class="hm-when you">👷 You’re on it today</small>'
            : n ? '<small class="hm-when">📅 ' + esc(dayWords(n.day)) + (n.time ? ' · ' + esc(n.time) : '') + '</small>' : '') +
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
    // The owner's day first, then the crew's, then the work and the money.
    // The crew: their clock, their day, the rest of the crew, their jobs.
    const cards = crewish
      ? [clockHtml(), myDayHtml(d), crewDayHtml(d), crewJobsHtml(d), waitingHtml(), equipmentHtml()]
      : [clockHtml(), myDayHtml(d), crewDayHtml(d), jobsHtml(all), invoiceHtml(all), bidsHtml(all), waitingHtml(), equipmentHtml()];
    return greetingHtml() + actionsHtml() + stormHtml() + statsHtml(all) +
      '<div class="hm-grid">' + cards.filter(Boolean).join('') + '</div>';
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
    if (out !== lastHtml || !wrap.firstChild) { wrap.innerHTML = out; lastHtml = out; }
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
  window.homeOpenJob = function (id) {
    if (typeof currentJobId !== 'undefined' && currentJobId === id) { switchTab('job'); return; }
    if (typeof dirty !== 'undefined' && dirty && !confirm('The job open now has unsaved changes. Open this one anyway?')) return;
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
    if (['clockOut', 'backFromBreak'].indexOf(what) === -1 || typeof window[what] !== 'function') return;
    window[what](id);
    // Back from a break to a storm that has finished or a job that has gone:
    // the clock asks what instead, on its own tab.
    if (what === 'backFromBreak' && window.YDClock && YDClock.mine && !YDClock.mine().shift) { switchTab('clock'); return; }
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

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    if (a.user && !authAt) authAt = Date.now();
    if (!a.user) authAt = 0;
    lastHtml = '';
    if (showing()) render();
  });
  ['yd-jobs-changed', 'yd-jobs-restored', 'yd-calendar-changed', 'yd-cards-changed', 'yd-boards-changed', 'yd-boards-ready',
   'yd-clock-changed', 'yd-requests', 'yd-receipts', 'yd-remind-me', 'yd-equipment-changed', 'yd-crew-notes',
   'yd-crew-jobs', 'yd-storm-changed', 'yd-forecast'].forEach(name => document.addEventListener(name, soon));
  // Back to the app after a while: the day may have turned over.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && showing()) render(); else manageTicker(); });

  function boot() { if (showing()) render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
