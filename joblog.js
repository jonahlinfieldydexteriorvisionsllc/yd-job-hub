// The daily log of a job: notes said or typed on the job, and the day put
// together from them.
//
// Jonah (23 Oct 2026, AI idea #4; "go" 26 Oct): "Voice notes and photos
// turned into daily logs and client updates is a great idea." Talking costs
// nothing: the 🎤 on the phone's own keyboard turns speech into text, so the
// note box here is a plain, big text box -- tap it, tap the microphone, talk.
//
// A NOTE is jobNotes/{jn…} {uid, by, jobId, jobName, day (Chicago
// YYYY-MM-DD), text, at, editedAt} -- anyone working writes their own, on the
// crew's job page or the Job tab, saved on the phone at once, signal or not.
// Whoever sees jobs reads them all; a crew member their own.
//
// THE LOG is jobLogs/{jobId}_{day}, written by the server (functions/
// joblog.py): every evening for each job worked that day, or now with
// "Write today's log". Who was on it and how long, what was ticked done, the
// photos and their captions, the notes and the crew's issues -- in plain code;
// Claude only turns the notes into a few short points. Whoever sees jobs
// reads the logs on the Job tab, day by day. "✉️ Draft an update to the
// customer" on a day has Claude write a few lines to the homeowner into his
// Gmail Drafts -- only when tapped (Jonah, 28 Oct: "draft only when i tap").

(function () {
  'use strict';

  const MAX_LEN = 2000;
  const SHOW_DAYS = 7;          // days shown before "Show the N earlier"
  const el = id => document.getElementById(id);
  const safe = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const signedIn = () => !!(window.YDAuth && YDAuth.mode === 'cloud' && YDAuth.user);
  const can = (a, l) => typeof ydCan === 'function' && ydCan(a, l);
  const me = () => (window.YDAuth && YDAuth.user) || null;
  const newId = () => 'jn' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const dayWords = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const timeOf = iso => { const t = new Date(iso); return isNaN(t) ? '' : t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); };
  function myName() {
    const own = window.YDRemind && YDRemind.me && YDRemind.me();
    const u = me();
    return (own && own.name) || (u && (u.displayName || u.email)) || 'Someone';
  }

  // ------------------------------------------------------------ watching
  //
  // Whoever sees jobs: the notes and logs of the job on the Job tab. A crew
  // phone: its own notes (the rules let it ask for those only), for the job
  // page that is open.
  let notes = {}, logs = {};
  let watchingJob = null, unsubs = [];
  let mineUnsub = null, mine = {};

  function stopJob() { unsubs.forEach(u => { try { u(); } catch (e) { /* gone */ } }); unsubs = []; }
  function watchJob(id) {
    if (id === watchingJob) return;
    stopJob();
    watchingJob = id || null; notes = {}; logs = {};
    if (!id || !signedIn() || !can('jobs', 'see') || !window.YDDb) { drawAll(); return; }
    const take = into => changes => {
      changes.forEach(c => { if (c.type === 'removed') delete into[c.id]; else into[c.id] = c.data || {}; });
      drawAll();
    };
    unsubs.push(YDDb.watchWhere('jobNotes', 'jobId', id, take(notes), () => {}));
    unsubs.push(YDDb.watchWhere('jobLogs', 'jobId', id, take(logs), () => {}));
  }
  function watchMine() {
    if (mineUnsub) { try { mineUnsub(); } catch (e) { /* gone */ } }
    mineUnsub = null; mine = {};
    const u = me();
    if (!u || !signedIn() || !window.YDDb) return;
    mineUnsub = YDDb.watchWhere('jobNotes', 'uid', u.uid, changes => {
      changes.forEach(c => { if (c.type === 'removed') delete mine[c.id]; else mine[c.id] = c.data || {}; });
      drawCrew();
    }, () => {});
  }

  function notesFor(jobId, onlyMine) {
    const src = onlyMine ? mine : Object.assign({}, mine, notes);
    return Object.keys(src).map(id => Object.assign({ id: id }, src[id]))
      .filter(n => n.jobId === jobId).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  }

  // ------------------------------------------------------------- saving

  function save(jobId, jobName, boxId) {
    const box = el(boxId), u = me();
    if (!box || !u || !jobId) return;
    const text = String(box.value || '').trim().slice(0, MAX_LEN);
    if (!text) { showToast('Say or type something first'); box.focus(); return; }
    const id = newId(), at = new Date().toISOString();
    const rec = { uid: u.uid, by: myName(), jobId: jobId, jobName: String(jobName || '').slice(0, 120) || null,
                  day: today(), text: text, at: at, editedAt: null };
    // Shown at once; the write goes when there is signal (never waited on).
    mine[id] = rec;
    if (watchingJob === jobId) notes[id] = rec;
    box.value = '';
    try { sessionStorage.removeItem('ydjobhub_jlDraft_' + boxId); } catch (e) { /* private window */ }
    drawJob(true); drawCrew(true);
    Promise.resolve(YDDb.put('jobNotes', id, rec)).catch(e => {
      console.error('[joblog] note not saved', e);
      delete mine[id]; delete notes[id];
      drawAll(); drawCrew();
      showToast('That note was not saved — try again');
    });
    showToast(navigator.onLine === false ? 'Note saved on this phone — it goes when you have signal' : 'Note saved');
  }
  window.jlSave = function (jobId, boxId) {
    const name = boxId === 'jlJobBox' ? (typeof getJobData === 'function' ? String(getJobData().customerName || '').trim() : '')
      : (crewBox && crewBox.name) || '';
    save(jobId, name, boxId);
  };
  // What is typed is kept through a redraw and a closed window (a long
  // dictation lost to a tap outside would be the worst of it).
  window.jlKeep = function (box) {
    try { sessionStorage.setItem('ydjobhub_jlDraft_' + box.id, box.value); } catch (e) { /* private window */ }
  };
  const draftOf = boxId => { try { return sessionStorage.getItem('ydjobhub_jlDraft_' + boxId) || ''; } catch (e) { return ''; } };

  window.jlRemove = async function (id) {
    const n = mine[id] || notes[id];
    const u = me();
    if (!n || !u || !(n.uid === u.uid || can('jobs', 'change'))) return;
    if (!(await ydConfirm('Take this note off the job?', { ok: 'Take it off' }))) return;
    delete mine[id]; delete notes[id];
    drawAll(); drawCrew();
    Promise.resolve(YDDb.remove('jobNotes', id)).catch(() => showToast('Not taken off — try again'));
  };

  // ------------------------------------------------------------ drawing

  function boxHtml(jobId, boxId, disabled) {
    return '<div class="jl-box">' +
      '<textarea id="' + boxId + '" class="jl-text" rows="3" maxlength="' + MAX_LEN + '" oninput="jlKeep(this)"' +
        (disabled ? ' disabled' : '') + ' placeholder="What happened today? Tap here, then the 🎤 on your keyboard to talk.">' +
        esc(draftOf(boxId)) + '</textarea>' +
      '<div class="jl-acts"><button class="btn btn-filled ro-ok" ' + (disabled ? 'disabled' : 'onclick="jlSave(\'' + safe(jobId) + '\', \'' + boxId + '\')"') +
        '>💾 Save the note</button>' +
        '<span class="hint">🎤 = your keyboard’s microphone. Kept with today’s log.</span></div></div>';
  }
  function noteRow(n) {
    const u = me();
    const mineOne = u && n.uid === u.uid;
    return '<div class="jl-note"><div class="jl-note-top"><b>' + esc(n.by || 'Someone') + '</b> <span class="muted">· ' +
        esc(n.day === today() ? timeOf(n.at) : dayWords(n.day) + ', ' + timeOf(n.at)) + '</span>' +
        (mineOne || can('jobs', 'change') ? '<button class="link-btn jl-x" onclick="jlRemove(\'' + safe(n.id) + '\')" aria-label="Take the note off">✕</button>' : '') +
      '</div><div class="jl-note-text">' + esc(n.text) + '</div></div>';
  }

  // The Job tab.
  let jobId = null, showAll = false;
  function jobShown(id) {
    if (id !== jobId) showAll = false;
    jobId = id || null;
    if (!signedIn() || !can('jobs', 'see')) return;
    let sec = el('jobLogSection');
    if (!sec) {
      const after = el('jobIssuesSection') || el('jobEodSection') || el('jobSigsSection') || el('jobPhotosSection') || el('estimateSection');
      if (!after) return;
      sec = document.createElement('div');
      sec.className = 'section';
      sec.id = 'jobLogSection';
      sec.hidden = true;
      sec.innerHTML = '<div class="section-head"><span class="section-title">📒 Daily log</span>' +
        '<span class="section-badge" id="jobLogBadge"></span></div><div class="section-body" id="jobLogBody"></div>';
      after.insertAdjacentElement('afterend', sec);
    }
    watchJob(jobId);
    drawJob();
  }
  // A bid has not been worked: no log, unless there is one.
  function jobIsWorked() {
    if (typeof jobStatus === 'undefined' || typeof normStatus !== 'function') return false;
    return normStatus(jobStatus) !== 'quoting';
  }

  function logHtml(l) {
    const f = l.facts || {};
    const p = f.photos || {};
    const nPhotos = (p.before || 0) + (p.during || 0) + (p.after || 0);
    const up = l.update || null;
    const changes = can('jobs', 'change');
    const d = safe(l.day);
    return '<div class="jl-day">' +
      '<div class="jl-day-top"><b>' + esc(dayWords(l.day)) + '</b>' +
        (l.hours ? ' <span class="muted">· ' + esc(l.hours) + '</span>' : '') +
        (nPhotos ? ' <span class="muted">· 📷 ' + nPhotos + '</span>' : '') + '</div>' +
      '<div class="jl-day-text">' + esc(l.text || l.codeText || '') + '</div>' +
      (changes ? '<div class="jl-acts">' +
        (up && up.at ? '<span class="jl-done">✓ Update drafted ' + esc(dayWords(String(up.at).slice(0, 10))) + '</span>' +
          (up.link ? ' <a class="link-btn" href="' + esc(up.link) + '" target="_blank" rel="noopener">Open it in Gmail</a>' : '') +
          '<button class="link-btn" onclick="jlUpdate(\'' + d + '\')">Draft another</button>'
          : '<button class="btn btn-sm" onclick="jlUpdate(\'' + d + '\')">✉️ Draft an update to the customer</button>') +
        '<button class="link-btn" onclick="jlWrite(\'' + d + '\')">↻ Write it again</button>' +
      '</div>' : '') +
    '</div>';
  }

  // Never redrawn under someone talking or typing (the microphone types
  // into the box): what arrives meanwhile shows once they save or leave it.
  function drawJob(force) {
    const sec = el('jobLogSection'), body = el('jobLogBody'), badge = el('jobLogBadge');
    if (!sec || !body) return;
    const days = Object.values(logs).filter(l => l && l.day).sort((a, b) => b.day.localeCompare(a.day));
    const todays = notesFor(jobId).filter(n => n.day === today());
    sec.hidden = !jobId || !signedIn() || !can('jobs', 'see') || (!days.length && !todays.length && !jobIsWorked());
    if (sec.hidden) return;
    const box = el('jlJobBox');
    if (!force && box && document.activeElement === box) return;
    if (badge) badge.textContent = days.length ? days.length + (days.length === 1 ? ' day' : ' days') : '';
    const shown = showAll ? days : days.slice(0, SHOW_DAYS);
    const hasToday = days.some(l => l.day === today());
    body.innerHTML = boxHtml(jobId, 'jlJobBox', false) +
      (todays.length ? '<div class="jl-h">Today’s notes</div><div class="jl-notes">' + todays.map(noteRow).join('') + '</div>' : '') +
      (can('jobs', 'change') ? '<div class="field-actions"><button class="btn btn-sm" onclick="jlWrite(\'' + today() + '\')">📒 ' +
        (hasToday ? 'Write today’s log again' : 'Write today’s log now') + '</button>' +
        '<span class="hint">It is written by itself every evening for each job worked that day.</span></div>' : '') +
      (shown.length ? '<div class="jl-days">' + shown.map(logHtml).join('') + '</div>' : '<p class="empty-msg">No days logged yet.</p>') +
      (days.length > shown.length ? '<button class="link-btn" onclick="jlShowAll()">Show the ' + (days.length - shown.length) + ' earlier days</button>' : '');
  }
  window.jlShowAll = function () { showAll = true; drawJob(true); };

  let busy = false;
  window.jlWrite = async function (day) {
    if (!jobId || busy || !can('jobs', 'change') || !window.YDClaude) return;
    if (window.YDSync && YDSync.sendNow) { try { await YDSync.sendNow(jobId); } catch (e) { /* the server has the last save */ } }
    busy = true;
    showToast('Writing the log…');
    try {
      const r = await YDClaude.post('/joblog/now', { jobId: jobId, day: day });
      if (r && r.error) throw new Error(r.error);
      showToast('Log written for ' + dayWords(day));
    } catch (e) { showToast((e && e.message) || 'Not written — try again'); }
    busy = false;
  };
  window.jlUpdate = async function (day) {
    if (!jobId || busy || !can('jobs', 'change') || !window.YDClaude) return;
    busy = true;
    showToast('Writing the update…');
    try {
      const r = await YDClaude.post('/joblog/update', { jobId: jobId, day: day });
      if (r && r.error) throw new Error(r.error);
      showToast('Update saved in your Gmail Drafts' + (r.to ? ' — to ' + r.to : ''));
    } catch (e) { showToast((e && e.message) || 'Not written — try again'); }
    busy = false;
  };

  // The crew's job page (crewjobs.js puts the box; mounted after each draw).
  let crewBox = null;   // { node, jobId, name, preview }
  function mount(node, id, j, preview) {
    if (!node) return;
    crewBox = { node: node, jobId: id, name: (j && j.name) || '', preview: !!preview };
    drawCrew();
  }
  function drawCrew(force) {
    const b = crewBox;
    if (!b || !b.node || !b.node.isConnected) { crewBox = null; return; }
    const box = el('jlCrewBox');
    if (!force && box && document.activeElement === box) return;      // never redrawn under someone talking
    const list = b.preview ? [] : notesFor(b.jobId, true).slice(0, 10);
    b.node.innerHTML = '<div class="cj-h">🎤 Today on this job</div>' + boxHtml(b.jobId, 'jlCrewBox', b.preview) +
      (b.preview ? '<p class="hint">The crew say or type what happened; you see it on the Job tab’s Daily log.</p>' : '') +
      (list.length ? '<div class="jl-notes">' + list.map(noteRow).join('') + '</div>' : '');
  }
  function drawAll() { drawJob(); }

  let who = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user ? a.user.uid + ':' + (a.key || a.role) : null;
    if (k === who) return;
    who = k;
    watchingJob = null; stopJob();
    if (!k) { if (mineUnsub) { try { mineUnsub(); } catch (x) { /* gone */ } } mineUnsub = null; mine = {}; return; }
    watchMine();
    if (typeof currentJobId !== 'undefined') jobShown(currentJobId);
  });

  window.YDJobLog = { jobShown: jobShown, mount: mount };
})();
