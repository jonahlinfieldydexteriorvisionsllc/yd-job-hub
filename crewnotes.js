// Notes from the crew to the owner.
//
// Jonah (12 Oct 2026): "there should be a spot on job pages or a button on
// the app that says 'leave note for jonah' or something along those lines
// where they can put a note in and i get a notification so we can save time
// talking on the phone."
//
// A note is crewNotes/{id} {uid, by, text, jobId, jobName, at, readAt,
// notifiedAt}. Anyone on the crew writes their own (firestore.rules), and it
// is saved on the phone at once, signal or not. The owner's phone is told
// straight away when there is signal (/notes/ping), and otherwise within five
// minutes by the reminders run (functions/reminders.py _crew_notes), which
// stamps notifiedAt so nothing is told twice. The owner reads them under
// 📝 Notes from the crew (⋯ menu, More, and a notification opens it) and
// marks them read; a crew member sees the ones they sent.

(function () {
  'use strict';

  const MAX_LEN = 2000;
  let notes = {};             // id -> note
  let unsub = null;
  let forJob = null;          // { id, name } the note form was opened for
  const el = id => document.getElementById(id);
  const me = () => (window.YDAuth && window.YDAuth.user) || null;
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const nowIso = () => new Date().toISOString();
  const newId = () => 'cn' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const safe = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');

  function myName() {
    const own = window.YDRemind && YDRemind.me();
    const u = me();
    return (own && own.name) || (u && (u.displayName || u.email)) || 'Someone';
  }

  // The job the person is clocked into now, if any: the note's job unless
  // they pick another.
  function clockedJob() {
    const u = me();
    if (!u || !window.YDClock) return null;
    const all = YDClock.entries() || {};
    const run = (Array.isArray(all) ? all : Object.values(all))
      .find(e => e && e.uid === u.uid && e.status === 'running' && e.kind === 'job');
    return run ? { id: run.targetId, name: YDClock.label(run) } : null;
  }
  function jobChoices() {
    const b = (window.YDClock && YDClock.board && YDClock.board()) || {};
    return Object.values(b).filter(j => j && j.id && j.name).sort((a, c) => String(a.name).localeCompare(c.name));
  }

  // ------------------------------------------------------------ the form

  function modal(id, title) {
    let m = el(id);
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal-overlay';
      m.id = id;
      m.onclick = ev => { if (ev.target === m) m.classList.remove('active'); };
      m.innerHTML = '<div class="modal" style="max-width:520px"><div class="modal-head"><h2></h2>' +
        '<button class="modal-close">&times;</button></div><div class="modal-body"></div></div>';
      m.querySelector('.modal-close').onclick = () => m.classList.remove('active');
      document.body.appendChild(m);
    }
    m.querySelector('h2').textContent = title;
    m.classList.add('active');
    return m.querySelector('.modal-body');
  }

  window.openNoteForJonah = function (jobId, jobName) {
    if (!me()) return;
    forJob = jobId ? { id: jobId, name: jobName || '' } : clockedJob();
    const jobs = jobChoices();
    const body = modal('noteModal', '📝 Leave a note for Jonah');
    body.innerHTML =
      '<div class="field"><span class="label">What about</span><select id="noteJob">' +
        '<option value="">— not about one job —</option>' +
        jobs.map(j => '<option value="' + safe(j.id) + '"' + (forJob && forJob.id === j.id ? ' selected' : '') + '>' +
          esc(j.name) + '</option>').join('') +
        (forJob && forJob.id && !jobs.some(j => j.id === forJob.id)
          ? '<option value="' + safe(forJob.id) + '" selected>' + esc(forJob.name || 'This job') + '</option>' : '') +
      '</select></div>' +
      '<div class="field"><span class="label">Note</span>' +
        // The usual ones, a tap each -- typing on a phone in gloves is slow.
        // A tap only starts the note; the rest is theirs to write.
        '<div class="note-chips">' + CHIPS.map((c, i) =>
          '<button type="button" class="note-chip" onclick="noteChip(' + i + ')">' + c[0] + '</button>').join('') + '</div>' +
        '<textarea id="noteText" rows="5" maxlength="' + MAX_LEN + '" placeholder="e.g. Ran short 2 pallets of pavers — need them by Thursday"></textarea></div>' +
      '<div class="hint">Jonah’s phone gets it as a notification. It saves even with no signal and goes when you have it.</div>' +
      '<div class="field-actions"><button class="btn btn-filled" onclick="sendNoteForJonah()">Send</button>' +
        '<button class="btn btn-sm" onclick="closeNoteForJonah()">Cancel</button></div>';
    const t = el('noteText'); if (t) t.focus();
  };
  window.closeNoteForJonah = function () { const m = el('noteModal'); if (m) m.classList.remove('active'); };

  // [what the chip says, what it puts in the box]
  const CHIPS = [
    ['📦 Need more material', 'Need more material: '],
    ['⏰ Running late', 'Running late — '],
    ['🔧 Machine problem', 'Machine problem: '],
    ['✅ Done for the day', 'Done for the day. '],
  ];
  // Into an empty box, or on a new line under what is there already; the
  // cursor left at the end, ready for the rest.
  window.noteChip = function (i) {
    const t = el('noteText'), c = CHIPS[i];
    if (!t || !c) return;
    const now = t.value.replace(/\s+$/, '');
    t.value = (now ? now + '\n' : '') + c[1];
    t.focus();
    try { t.setSelectionRange(t.value.length, t.value.length); } catch (e) { /* not a text box that takes it */ }
  };

  window.sendNoteForJonah = function () {
    const u = me();
    const text = ((el('noteText') || {}).value || '').trim().slice(0, MAX_LEN);
    if (!u || !window.YDDb) return;
    if (!text) { showToast('Write the note first'); return; }
    const jobId = (el('noteJob') || {}).value || '';
    const job = jobId ? (jobChoices().find(j => j.id === jobId) || (forJob && forJob.id === jobId ? forJob : null)) : null;
    const id = newId();
    const rec = { uid: u.uid, by: myName(), text: text, jobId: jobId || null, jobName: job ? (job.name || null) : null,
                  at: nowIso(), readAt: null, notifiedAt: null };
    notes[id] = Object.assign({ id: id }, rec);
    // Never awaited: with no signal the write waits on the phone and goes
    // when it can (a write only settles when the server has it).
    Promise.resolve(window.YDDb.put('crewNotes', id, rec)).then(() => ping()).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not sent — not allowed');
      else console.warn('[notes] not yet on the server:', (e && e.code) || e);
    });
    closeNoteForJonah();
    showToast(navigator.onLine === false ? 'Saved — it goes to Jonah when you have signal' : 'Sent to Jonah');
    render();
  };
  // Tell the owner now rather than at the next five-minute run.
  function ping() {
    if (!window.YDClaude || !YDClaude.available || !YDClaude.available()) return;
    YDClaude.post('/notes/ping', {}).catch(() => {});
  }

  // ----------------------------------------------------- the owner's list

  const unread = () => Object.values(notes).filter(n => !n.readAt);
  window.openCrewNotes = function () {
    modal('notesListModal', isOwner() ? '📝 Notes from the crew' : '📝 Your notes to Jonah');
    render();
  };
  function render() {
    // Home lists the unread ones (home.js); it is told whenever they may
    // have changed, which is whenever this redraws.
    document.dispatchEvent(new CustomEvent('yd-crew-notes'));
    const m = el('notesListModal');
    const badge = el('menuCrewNotes');
    if (badge) {
      const n = isOwner() ? unread().length : 0;
      badge.textContent = '📝 Notes from the crew' + (n ? ' (' + n + ')' : '');
    }
    if (!m || !m.classList.contains('active')) return;
    const body = m.querySelector('.modal-body');
    const list = Object.values(notes).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    body.innerHTML = (list.length ? list.slice(0, 100).map(n =>
      '<div class="note-row' + (n.readAt ? ' read' : '') + '">' +
        '<div class="note-head"><b>' + esc(n.by || 'Someone') + '</b>' +
          (n.jobName ? ' · ' + esc(n.jobName) : '') +
          '<span class="muted"> · ' + esc(when(n.at)) + '</span></div>' +
        '<div class="note-text">' + esc(n.text || '') + '</div>' +
        (isOwner() ? '<div class="note-acts">' +
          (n.readAt ? '<button class="link-btn" onclick="markCrewNote(\'' + safe(n.id) + '\', false)">Mark unread</button>'
            : '<button class="link-btn" onclick="markCrewNote(\'' + safe(n.id) + '\', true)">Mark read</button>') +
          (n.jobId && typeof loadJob === 'function' ? '<button class="link-btn" onclick="openNoteJob(\'' + safe(n.jobId) + '\')">Open the job</button>' : '') +
        '</div>' : '') +
      '</div>').join('') : '<p class="empty-msg">' + (isOwner() ? 'No notes from the crew yet.' : 'No notes sent yet.') + '</p>') +
      (isOwner() && unread().length > 1 ? '<div class="field-actions"><button class="btn btn-sm" onclick="markAllCrewNotes()">Mark all read</button></div>' : '') +
      (!isOwner() ? '<div class="field-actions"><button class="btn btn-filled btn-sm" onclick="openNoteForJonah()">+ New note</button></div>' : '');
  }
  function when(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  window.markCrewNote = function (id, read) {
    const n = notes[id];
    if (!n || !isOwner()) return;
    n.readAt = read ? nowIso() : null;
    Promise.resolve(window.YDDb.put('crewNotes', id, { readAt: n.readAt })).catch(() => {});
    render();
  };
  window.markAllCrewNotes = function () { unread().forEach(n => window.markCrewNote(n.id, true)); };
  window.openNoteJob = async function (jobId) {
    const m = el('notesListModal'); if (m) m.classList.remove('active');
    if (!(await ydLeaveUnsavedJob())) return;
    loadJob(jobId);
    switchTab('job');
  };

  // ---------------------------------------------------------------- wiring

  function stop() { if (unsub) { try { unsub(); } catch (e) {} } unsub = null; notes = {}; }
  function start(a) {
    stop();
    if (!window.YDDb || !a.user || a.mode !== 'cloud') return;
    const take = changes => {
      changes.forEach(c => { if (c.type === 'removed') delete notes[c.id]; else notes[c.id] = Object.assign({ id: c.id }, c.data); });
      render();
    };
    // The owner reads them all; anyone else only their own (the rules
    // refuse a question that could include someone else's).
    unsub = a.isOwner ? window.YDDb.watch('crewNotes', take, () => {})
      : window.YDDb.watchWhere('crewNotes', 'uid', a.user.uid, take, () => {});
  }
  let key = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const k = on ? a.user.uid + ':' + a.role : null;
    const item = el('menuCrewNotes');
    if (item) item.hidden = !(on && a.isOwner);
    const send = el('menuNoteJonah');
    if (send) send.hidden = !(on && !a.isOwner);
    const onClock = el('clockNoteBtn');
    if (onClock) onClock.hidden = !(on && !a.isOwner);
    if (k !== key) { key = k; if (on) start(a); else stop(); }
  });

  window.YDCrewNotes = { unread: () => unread().length, openFor: (id, name) => window.openNoteForJonah(id, name),
    // The owner's unread notes, newest first (Home).
    unreadList: () => unread().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
      .map(n => ({ id: n.id, by: n.by || 'Someone', text: n.text || '', jobId: n.jobId || '', jobName: n.jobName || '', at: n.at || '' })) };
})();
