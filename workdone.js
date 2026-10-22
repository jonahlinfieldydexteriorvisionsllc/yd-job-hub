// The work on a job, ticked off as it is done.
//
// Jonah (22 Oct 2026): "there should be a punch list for each service in
// the estimate so crew can mark when something is complete so I can always
// see the progress of a job" -- for "jobs booked from now on and booked
// jobs". Each piece of work on a job -- its estimate's work lines and the
// change orders on its QuickBooks invoice, the same list the crew's page
// shows (crewjobs.js workParts) -- gets a big "✓ Done" on the crew's page.
// Who ticked it and when is kept; a tick can be taken back (Undo, or "Not
// done yet" later). Jonah and the office see "3 of 5 done" wherever a job
// is shown: the Jobs board, the Job tab, Home, My Jobs, the crew's page.
// When every piece is ticked he is asked whether to mark it finished --
// never done by itself (finishing still wants its before and after photos,
// jobphotos.js readyToFinish).
//
// Called "work done", not "punch list", on purpose: the Jobs board already
// has a Punch list column (a job under way, down to its last bits). The two
// meet there: a card in that column lists what is still not ticked -- the
// punch list in the usual sense.
//
// Where the ticks live: workDone/{jobId}, one document per job. The crew
// cannot read or write jobs/* (it carries the price; Firestore grants a
// whole document or nothing), so the ticks are their own record:
//   lines: { <line id>: { done, uid, by, at, title } },
//   last: the one line this write changes, updatedAt.
// `last` is what lets the rules check that a write changes one line only,
// as the person writing, on a job they can see (one with a crew page). The
// line ids are the estimate's own (ew…, ewqb… for a job made in
// QuickBooks), so a job booked before this needs nothing written to it:
// its lines are read from its estimate as they are, and start unticked.
//
// Offline: a tick is a Firestore write, never awaited. With no signal it
// shows as ticked at once and waits on the phone until there is some.

(function () {
  'use strict';

  const PATH = 'workDone';
  // A job is under way for a season at most: ticks changed in the last 200
  // days are kept live on every device. An older job opened on the Job tab
  // reads its own once (want).
  const LIVE_DAYS = 200;
  let ticks = {};             // jobId -> { lines, updatedAt }
  let unsub = null, key = null;
  const asked = {};           // jobId -> read once already (older than the live window)
  const safe = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const esc2 = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s));
  const signedIn = () => !!(window.YDAuth && YDAuth.mode === 'cloud' && YDAuth.user);
  const seesJobs = () => typeof ydCan === 'function' && ydCan('jobs', 'see');

  function tickOf(jobId, lineId) {
    const t = ticks[jobId];
    return t && t.lines && t.lines[lineId] && typeof t.lines[lineId] === 'object' ? t.lines[lineId] : null;
  }
  const isDone = (jobId, lineId) => { const t = tickOf(jobId, lineId); return !!(t && t.done === true); };

  // ------------------------------------------------ which lines a job has
  //
  // The office's jobs: worked out from the job itself (crewjobs.js lines,
  // the same list its crew page is made from). A crew phone: from the crew
  // copy (jobCrew), whose `work` is that list.
  function linesOfJob(j) {
    return j && window.YDCrewJobs && YDCrewJobs.lines ? YDCrewJobs.lines(j) : [];
  }
  function linesOfCopy(c) {
    return (c && Array.isArray(c.work) ? c.work : []).filter(w => w && w.id).map(w => ({ id: String(w.id), title: String(w.title || '') }));
  }

  // How far the work is: only the lines the job has NOW count (a tick on a
  // line since taken off the estimate counts for nothing).
  function progress(jobId, lines) {
    const list = (lines || []).filter(w => w && w.id);
    const done = list.filter(w => isDone(jobId, w.id));
    const left = list.filter(w => !isDone(jobId, w.id));
    return { done: done.length, total: list.length, all: list.length > 0 && !left.length, any: done.length > 0,
             left: left.map(w => w.title || 'Work') };
  }
  const statusOf = j => (typeof normStatus === 'function' ? normStatus(j.jobStatus, j) : (j.jobStatus || 'quoting'));
  const underWay = st => st === 'booked' || st === 'inprogress';
  // A job's progress, for the office (the board, Home, My Jobs): null when
  // there is nothing worth saying -- a bid, a job with no work lines, or a
  // booked one nobody has started (a row of "0 of 5" on every job to come
  // would only be noise). Work under way says how far, even at nothing.
  function ofJob(j) {
    if (!j || !j._id) return null;
    const st = statusOf(j);
    if (st === 'quoting' || st === 'lost') return null;
    const p = progress(j._id, linesOfJob(j));
    if (!p.total) return null;
    if (!p.any && st !== 'inprogress') return null;
    p.status = st;
    p.underWay = underWay(st);
    return p;
  }

  // ------------------------------------------------ drawing
  const pct = p => (p.total ? Math.round(100 * p.done / p.total) : 0);
  const words = p => p.all ? 'All ' + p.total + ' done' : p.done + ' of ' + p.total + ' done';
  // "3 of 5 done" over a thin bar. `cls` for where it sits.
  function barHtml(p, cls) {
    if (!p || !p.total) return '';
    return '<span class="wd-prog' + (p.all ? ' all' : '') + (cls ? ' ' + cls : '') + '">' +
      '<span class="wd-prog-w">✅ ' + esc2(words(p)) + '</span>' +
      '<span class="wd-bar" aria-hidden="true"><i style="width:' + pct(p) + '%"></i></span></span>';
  }
  function whenWords(at) {
    const d = new Date(at);
    if (!isFinite(d.getTime())) return '';
    const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const that = new Date(d); that.setHours(0, 0, 0, 0);
    const diff = Math.round((day - that) / 86400000);
    return diff === 0 ? t : diff === 1 ? 'yesterday ' + t
      : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + t;
  }
  const firstName = s => String(s || '').trim().split(/\s+/)[0] || 'Someone';

  // One piece of work's tick, under its heading: a big button until it is
  // done, then who did it and when, with a way back. `preview`: the owner's
  // "What the crew see" -- shown, not pressed. data-wd lets a tick from
  // another phone redraw just this (fresh), not the page under the thumb.
  function lineHtml(jobId, w, opts) {
    opts = opts || {};
    const id = safe(jobId), line = safe(w && w.id);
    if (!id || !line) return '';
    const t = tickOf(id, line);
    const done = !!(t && t.done === true);
    const can = !opts.preview && signedIn();
    const attrs = ' data-wd="' + id + '|' + line + '" data-t="' + esc2(String((w && w.title) || '').slice(0, 200)) + '"' +
      (opts.preview ? ' data-wdp="1"' : '');
    if (done) {
      return '<div class="wd-line on"' + attrs + '>' +
        '<span class="wd-done">✅ Done</span><span class="wd-who">' + esc2(firstName(t.by)) +
          (t.at ? ' · ' + esc2(whenWords(t.at)) : '') + '</span>' +
        (can ? '<button type="button" class="link-btn wd-undo ro-ok" onclick="wdTick(this, false)">Not done yet</button>' : '') +
      '</div>';
    }
    return '<div class="wd-line"' + attrs + '>' +
      '<button type="button" class="btn wd-btn ro-ok"' + (can ? ' onclick="wdTick(this, true)"' : ' disabled') + '>' +
        '<span class="wd-box" aria-hidden="true"></span>Mark this done</button>' +
    '</div>';
  }
  // Over the work on a page: how far the job is (data-wd-sum: redrawn in
  // place too).
  function sumHtml(jobId, lines) {
    const id = safe(jobId);
    const p = progress(id, lines);
    if (!p.total) return '';
    return '<div class="wd-sum" data-wd-sum="' + id + '">' + barHtml(p) +
      (p.all ? '<span class="wd-sum-all">Every piece of work is ticked off.</span>' : '') + '</div>';
  }

  // What is on screen follows the ticks -- each tick and each count drawn
  // again where it is, so a page being read stays where it was.
  const pageLines = {};       // jobId -> the lines its open page was drawn with (for its count)
  function fresh() {
    document.querySelectorAll('[data-wd]').forEach(n => {
      const [id, line] = String(n.dataset.wd).split('|');
      const now = lineHtml(id, { id: line, title: n.dataset.t || '' }, { preview: n.dataset.wdp === '1' });
      if (n.outerHTML !== now) n.outerHTML = now;
    });
    document.querySelectorAll('[data-wd-sum]').forEach(n => {
      const id = n.dataset.wdSum;
      if (!pageLines[id]) return;
      const now = sumHtml(id, pageLines[id]);
      if (n.outerHTML !== now) n.outerHTML = now;
    });
    document.querySelectorAll('.cj-work').forEach(w => {
      const t = w.querySelector('[data-wd]');
      if (t) w.classList.toggle('wd-work-done', t.classList.contains('on'));
    });
  }
  let toldTimer = 0;
  function changed() {
    fresh();
    // A first tick on a Booked job puts it In progress (startTicked).
    startTicked();
    // Home, the boards, My Jobs and the crew's lists redraw on this.
    clearTimeout(toldTimer);
    toldTimer = setTimeout(() => document.dispatchEvent(new CustomEvent('yd-workdone')), 60);
  }

  // ------------------------------------------------ ticking
  function me() {
    const r = window.YDRemind && YDRemind.me ? YDRemind.me() : null;
    const u = (window.YDAuth && YDAuth.user) || {};
    return { uid: u.uid || '', name: String((r && r.name) || u.displayName || u.email || 'Someone').slice(0, 80) };
  }
  function setLine(jobId, lineId, done, title) {
    const id = safe(jobId), line = safe(lineId);
    const who = me();
    if (!id || !line || !who.uid || !window.YDDb) return false;
    const at = new Date().toISOString();
    const t = { done: !!done, uid: who.uid, by: who.name, at: at, title: String(title || '').slice(0, 200) };
    // Shown at once, signal or not (the watch says the same a moment later).
    const was = ticks[id] ? Object.assign({}, ticks[id], { lines: Object.assign({}, ticks[id].lines) }) : null;
    const now = ticks[id] || (ticks[id] = { lines: {} });
    now.lines = Object.assign({}, now.lines || {}, { [line]: t });
    now.updatedAt = at;
    changed();
    Promise.resolve(window.YDDb.put(PATH, id, { lines: { [line]: t }, last: line, updatedAt: at })).catch(e => {
      // Refused (the job came off the crew's list meanwhile): put it back as it was.
      console.warn('[workdone] tick not saved', (e && e.code) || e);
      if (was) ticks[id] = was; else delete ticks[id];
      changed();
      if (typeof showToast === 'function') showToast('That tick did not save — the job may be off your list now', 5000);
    });
    return true;
  }
  // The button: ticked (on) or taken back. Undo on the bar for a slip of
  // the thumb either way.
  window.wdTick = function (b, on) {
    const box = b && b.closest('[data-wd]');
    if (!box) return;
    const [id, line] = String(box.dataset.wd).split('|');
    const title = box.dataset.t || 'That';
    if (!setLine(id, line, on, title)) return;
    const name = title.length > 40 ? title.slice(0, 40) + '…' : title;
    const msg = on ? '✅ ' + name + ' — done' : name + ' — not done yet';
    if (typeof showUndo === 'function') showUndo(msg, () => setLine(id, line, !on, title));
    else if (typeof showToast === 'function') showToast(msg);
  };

  // ------------------------------------------------ the day's ticks
  //
  // What was ticked off on a day (Home's crew's day, the end-of-day list):
  // [{ jobId, line, title, by, uid, at }], newest first. Only ticks still
  // standing -- one taken back is not work done.
  const localDay = iso => { const d = new Date(iso); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  function tickedOn(day, uid) {
    const out = [];
    Object.keys(ticks).forEach(jobId => {
      const lines = (ticks[jobId] && ticks[jobId].lines) || {};
      Object.keys(lines).forEach(line => {
        const t = lines[line];
        if (!t || t.done !== true || !t.at || localDay(t.at) !== day) return;
        if (uid && t.uid !== uid) return;
        out.push({ jobId: jobId, line: line, title: String(t.title || 'Work'), by: String(t.by || ''), uid: t.uid, at: t.at });
      });
    });
    return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  // A job's name for a list of ticks: the crew's copy on a crew phone, the
  // job itself in the office.
  function jobName(jobId) {
    const c = window.YDCrewJobs && YDCrewJobs.list ? YDCrewJobs.list().find(x => x.id === jobId) : null;
    if (c && c.name) return String(c.name);
    const j = typeof loadAllJobs === 'function' ? loadAllJobs().find(x => x && x._id === jobId) : null;
    return (j && String(j.customerName || '').trim()) || 'A job';
  }

  // Jobs whose every piece is ticked and that are not finished yet: the
  // owner is asked whether to mark each one finished (Home, the board).
  function allDone() {
    if (!seesJobs() || typeof loadAllJobs !== 'function') return [];
    return loadAllJobs().filter(j => j && j._id && ticks[j._id] && !j.deletedAt && !j.removeWhy).map(j => ({ j: j, p: ofJob(j) }))
      .filter(x => x.p && x.p.all && x.p.underWay);
  }

  // An older job opened on the Job tab (ticks outside the live window): its
  // own ticks read once.
  function want(jobId) {
    const id = safe(jobId);
    if (!id || ticks[id] || asked[id] || !signedIn() || !window.YDDb || !YDDb.get) return;
    asked[id] = true;
    Promise.resolve(YDDb.get(PATH, id)).then(d => { if (d && !ticks[id]) { ticks[id] = d; changed(); } }).catch(() => {});
  }

  // ------------------------------------------------ the first tick starts the job
  //
  // Jonah (22 Oct 2026): "when the crew tick the first piece on a Booked
  // job, move it to In progress by itself." Done the way a job accepted in
  // QuickBooks books itself (sync.js bookIfAccepted): through the app's own
  // save (YDSync.patchJob -- the job, its crew page, the clock's list, the
  // change history), on a device that may change jobs -- the one that
  // ticked, or the owner's when it sees someone else's tick (only one
  // device acts on each tick). Only a tick newer than the job's last move
  // counts: a job put back to Booked by hand after it stays Booked until a
  // piece is ticked again.
  const starting = new Set();
  function startTicked() {
    const a = window.YDAuth;
    if (!a || !a.user || typeof ydCan !== 'function' || !ydCan('jobs', 'change') || typeof loadAllJobs !== 'function' ||
        !window.YDSync || !YDSync.patchJob) return;
    Object.keys(ticks).forEach(id => {
      if (starting.has(id)) return;
      const lines = (ticks[id] && ticks[id].lines) || {};
      const j = loadAllJobs().find(x => x && x._id === id);
      if (!j || statusOf(j) !== 'booked' || j.deletedAt || j.removeWhy) return;
      const on = new Set(linesOfJob(j).map(w => w.id));
      const since = String(j.workStageAt || '');
      const t = Object.keys(lines).map(k => Object.assign({ line: k }, lines[k]))
        .filter(x => x.done === true && on.has(x.line) && String(x.at || '') > since && (x.uid === a.user.uid || a.isOwner))
        .sort((x, y) => String(x.at).localeCompare(String(y.at)))[0];
      if (!t) return;
      starting.add(id);
      setTimeout(() => {
        const ok = YDSync.patchJob(id, { workStage: 'inProgress', workStageAt: new Date().toISOString(), jobStatus: 'inprogress' },
          firstName(t.by) + '’s first tick');
        starting.delete(id);
        if (ok && typeof showToast === 'function') {
          showToast((String(j.customerName || '').trim() || 'A job') + ' is In progress — ' + firstName(t.by) + ' ticked off the first piece', 5000);
        }
      }, 0);
    });
  }
  // The jobs came in after the ticks (a fresh start): looked at again.
  let startTimer = 0;
  document.addEventListener('yd-jobs-changed', () => { clearTimeout(startTimer); startTimer = setTimeout(startTicked, 300); });

  // ------------------------------------------------ watching
  function stop() {
    if (unsub) { try { unsub(); } catch (e) {} }
    unsub = null;
    ticks = {};
    Object.keys(asked).forEach(k => delete asked[k]);
  }
  function start() {
    stop();
    if (!window.YDDb || !YDDb.watchFrom) return;
    const from = new Date(Date.now() - LIVE_DAYS * 86400000).toISOString();
    unsub = YDDb.watchFrom(PATH, 'updatedAt', from, list => {
      let any = false;
      (list || []).forEach(c => {
        if (!c || !c.id) return;
        if (c.type === 'removed') { if (ticks[c.id]) { delete ticks[c.id]; any = true; } return; }
        ticks[c.id] = c.data || {};
        any = true;
      });
      if (any) changed();
    }, () => {});
  }
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user ? a.user.uid : null;
    if (k === key) return;
    key = k;
    if (k) start(); else { stop(); changed(); }
  });

  window.YDWorkDone = {
    progress: progress, ofJob: ofJob, linesOfJob: linesOfJob, linesOfCopy: linesOfCopy,
    barHtml: barHtml, lineHtml: lineHtml, sumHtml: sumHtml, words: words,
    // A page (the crew's, or the Job tab's work) says which lines its count
    // is over, so fresh() can redraw it.
    page: (jobId, lines) => { pageLines[safe(jobId)] = lines || []; },
    tickedOn: tickedOn, allDone: allDone, want: want, isDone: isDone, whenWords: whenWords, jobName: jobName,
    // Any tick ever made on the job (a finished job shows its ticks only then).
    has: jobId => { const t = ticks[safe(jobId)]; return !!(t && t.lines && Object.keys(t.lines).length); },
  };
})();
