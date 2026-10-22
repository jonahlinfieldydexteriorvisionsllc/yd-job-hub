// The end of the day: a short list that whoever Jonah picks fills in before
// going home -- the day's photos, what got done, what's left, anything
// important, what they need from him -- and sends him as one report.
//
// Jonah (22 Oct 2026): "we need to make an end of day recurring task list for
// [the crew lead] that includes uploading all images taken during that day, writing a
// brief summary of what got done, whats left, anything important, and listing
// any questsions or things he needs from me. i want to be able to add more
// things to this."
//
// THE LIST is settings/endOfDay. Everyone who works here reads it; only the
// owner changes it (firestore.rules), in 📋 End of day → ⚙ Change the list
// (All settings has it too):
//   items     [{id, kind, label, hint, need}], in the order they are asked.
//             kind 'photos' (the day's photos onto the jobs worked, then a
//             tick), 'text' (a box to write in) or 'check' (a tick box).
//             need: it cannot be sent without it.
//   who       [uid] -- who gets it (the crew lead, to start with).
//   at        'HH:MM' -- from then, on a day they worked, it is on their Home.
//   remind, remindAt -- their phone is reminded at remindAt if it is not in
//             (functions/endofday.py). Two settings: switching the reminder
//             off keeps its time.
//   storms    whether a night on a storm alone counts as a day worked.
// Until he first changes it, DEFAULT_ITEMS stand (endofday.py has the same).
//
// A REPORT is endOfDay/{uid}_{day}, one per person per day, so changes sent
// later replace it: {uid, by, day, jobs [{id, name, photos}], jobIds, items
// (the list as it was when sent), answers {itemId: words, or true/false},
// photos {count, sending}, sentAt, sentCount, readAt, notifiedAt, updatedAt}.
// Each person writes and reads their own; the owner reads them all and marks
// them read. Every send clears readAt and notifiedAt, so changes are told and
// read again. The server buzzes the owner's phone (endofday.py tell_owner, in
// the five-minute run and at once through /notes/ping); his evening summary
// has each one, or says it is not in yet, and the next morning's has one that
// came in after it, or never.
//
// It comes up by itself when they clock out for the day (timeclock.js sends
// yd-clocked-out), and sits on their Home from `at` on a day they worked (or
// once they are off the clock) until it is sent. The ⋯ menu and More open it
// any time. The owner reads them on Home (Waiting on you), in the 📋 End of
// day window and on each job's Job tab.
//
// What is typed is kept on the phone as it is typed (localStorage), so an
// update, a reload or no signal loses nothing; Send is not waited on --
// Firestore keeps it on the phone until there is signal, as every write here.

(function () {
  'use strict';

  const DEFAULT_ITEMS = [
    { id: 'photos', kind: 'photos', label: 'Upload today’s photos',
      hint: 'Add the day’s photos to each job you worked, then tick it.', need: false },
    { id: 'done', kind: 'text', label: 'What got done today', hint: '', need: true },
    { id: 'left', kind: 'text', label: 'What’s left', hint: '', need: false },
    { id: 'important', kind: 'text', label: 'Anything important', hint: '', need: false },
    { id: 'questions', kind: 'text', label: 'Questions — or anything you need from Jonah', hint: '', need: false },
  ];
  const DEFAULTS = { at: '15:00', remind: true, remindAt: '17:00', storms: false };
  const KIND_NAME = { photos: 'The day’s photos', text: 'Something to write', check: 'A tick box' };
  const STAGES = [['before', 'before'], ['during', 'during'], ['after', 'after']];
  const MAX_TEXT = 4000;
  const MAX_LABEL = 120;
  const MAX_ITEMS = 30;
  const WATCH_DAYS = 60;      // the owner's reports kept live; older ones are asked for when looked for
  const DRAFT_DAYS = 7;       // what is typed is kept on the phone this long
  const LIST_SHOW = 20;       // reports in the window before "Show more"
  const EARLY_HOURS = 5;      // before 5 am, the end of day still open is yesterday's
  const DRAFT = 'ydjobhub_eod_';   // + uid + '_' + day

  const el = id => document.getElementById(id);
  const safe = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const signedIn = () => !!(window.YDAuth && YDAuth.mode === 'cloud' && YDAuth.user);
  const myUid = () => (signedIn() ? YDAuth.user.uid : '');
  const isOwner = () => !!(window.YDAuth && YDAuth.isOwner);
  const nowIso = () => new Date().toISOString();
  const today = () => localYMD();
  const isDay = s => /^\d{4}-\d\d-\d\d$/.test(String(s || ''));
  const isTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
  function addDays(ymd, n) { const d = new Date(ymd + 'T12:00:00'); d.setDate(d.getDate() + n); return localYMD(d); }
  const dayStartMs = ymd => new Date(ymd + 'T00:00:00').getTime();
  const idOf = (uid, day) => uid + '_' + day;
  const newId = () => 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  // "Today", "Yesterday", else "Wed, Oct 22".
  function dayWords(ymd) {
    if (ymd === today()) return 'Today';
    if (ymd === addDays(today(), -1)) return 'Yesterday';
    return new Date(ymd + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  const longDay = ymd => new Date(ymd + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  // "4:52pm", the way the calendar writes a time.
  function timeWords(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s*([AP])M$/i, (m, ap) => ap.toLowerCase() + 'm');
  }
  // "4:52pm" today, "Thu 7:10am" another day.
  function whenWords(iso, day) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return (localYMD(d) === day ? '' : d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ') + timeWords(iso);
  }
  const clockWords = hhmm => (isTime(hhmm) ? timeWords(new Date('2000-01-01T' + hhmm + ':00').toISOString()) : '');

  // ------------------------------------------------------------- the list

  let cfg = null;             // settings/endOfDay as read (null: none saved yet)
  let cfgRead = false;        // the database has answered once (or could not)

  function tidyItem(it) {
    const kind = KIND_NAME[it.kind] ? it.kind : 'text';
    return { id: safe(it.id) || newId(), kind: kind, label: String(it.label || '').trim().slice(0, MAX_LABEL) || KIND_NAME[kind],
             hint: String(it.hint || '').trim().slice(0, 300), need: it.need === true };
  }
  // The list as it stands: his, or the starting one until he changes it.
  function conf() {
    const c = cfg || {};
    let items = Array.isArray(c.items) ? c.items.filter(x => x && typeof x === 'object').map(tidyItem) : DEFAULT_ITEMS.map(tidyItem);
    // One photos item at most, and one of each id.
    const seen = {};
    let photos = false;
    items = items.filter(it => {
      if (seen[it.id] || (it.kind === 'photos' && photos)) return false;
      seen[it.id] = 1;
      if (it.kind === 'photos') photos = true;
      return true;
    }).slice(0, MAX_ITEMS);
    return {
      items: items,
      who: Array.isArray(c.who) ? c.who.filter(x => typeof x === 'string' && x) : [],
      at: isTime(c.at) ? c.at : DEFAULTS.at,
      remind: typeof c.remind === 'boolean' ? c.remind : DEFAULTS.remind,
      remindAt: isTime(c.remindAt) ? c.remindAt : DEFAULTS.remindAt,
      storms: c.storms === true,
    };
  }
  const onList = uid => !!uid && conf().who.indexOf(uid) !== -1;

  // Read when they sign in and each time they come back to the app; the
  // owner's own changes are kept here as he makes them.
  function loadCfg(fresh) {
    if (!signedIn() || !window.YDDb) return;
    const ask = fresh && YDDb.getFresh ? YDDb.getFresh('settings', 'endOfDay') : YDDb.get('settings', 'endOfDay');
    Promise.resolve(ask).then(d => {
      cfg = d || null;
      read();
    }).catch(e => {
      // No signal: the phone's copy. Not allowed (rules not out yet): no list.
      if (fresh && !(e && e.code === 'permission-denied')) { loadCfg(false); return; }
      read();
    });
  }
  function read() {
    cfgRead = true;
    changed();
    const o = openWhenRead;
    openWhenRead = null;
    if (o) window.openEndOfDay(o.day);
  }
  function saveCfg(patch) {
    if (!isOwner() || !window.YDDb) return;
    // The first change writes the whole list -- the starting one included --
    // so what the crew read is exactly what he sees.
    const c = conf();
    cfg = Object.assign({}, cfg || {}, c, patch, { updatedAt: nowIso(), updatedBy: myUid() });
    Promise.resolve(YDDb.put('settings', 'endOfDay', cfg))
      .catch(e => showToast(e && e.code === 'permission-denied' ? 'Not saved — only Jonah changes the list' : 'Not on the server yet — it will be'));
    changed();
  }

  // ------------------------------------------------------------- reports

  let reports = {};           // id -> report this person may read: their own; the owner's, everyone's recent ones
  let older = {};             // the owner's, from further back (asked for by the window or a job)
  let unsub = null;
  const known = () => Object.assign({}, older, reports);

  function watchReports(a) {
    stopReports();
    if (!window.YDDb || !a || !a.user || a.mode !== 'cloud') return;
    const take = changes => {
      changes.forEach(c => {
        if (c.type === 'removed') delete reports[c.id];
        else reports[c.id] = Object.assign({ id: c.id }, c.data);
      });
      changed();
    };
    // The owner reads them all (the recent ones live); anyone else only
    // their own -- the rules refuse a question that could include another's.
    unsub = a.isOwner ? YDDb.watchFrom('endOfDay', 'day', addDays(today(), -WATCH_DAYS), take, () => {})
      : YDDb.watchWhere('endOfDay', 'uid', a.user.uid, take, () => {});
  }
  function stopReports() {
    if (unsub) { try { unsub(); } catch (e) { /* already gone */ } }
    unsub = null; reports = {}; older = {};
  }

  // The report sent for that person and day: the server's, or one sent from
  // this phone still waiting for signal.
  function sentReport(uid, day) {
    const r = known()[idOf(uid, day)];
    if (r && r.sentAt) return r;
    const d = uid === myUid() ? readDraft(day) : null;
    return d && d.sentAt ? { id: idOf(uid, day), uid: uid, day: day, sentAt: d.sentAt, pending: true } : null;
  }

  function personName(uid, fallback) {
    const p = window.YDClock && YDClock.people ? (YDClock.people() || {})[uid] : null;
    return (p && p.name) || fallback || 'Someone';
  }
  const firstName = (uid, fallback) => String(personName(uid, fallback)).trim().split(/\s+/)[0] || 'Someone';
  // The first thing they wrote, for a line on Home.
  function firstWords(r) {
    const items = Array.isArray(r.items) && r.items.length ? r.items : conf().items;
    const a = r.answers || {};
    const it = items.find(x => x.kind === 'text' && typeof a[x.id] === 'string' && a[x.id].trim());
    return it ? a[it.id].trim().replace(/\s+/g, ' ') : '';
  }

  // ------------------------------------------------------------ the clock

  // A person's shifts that began on `day` and count as a day's work: not
  // one turned down, and not a storm unless the list says so.
  function shiftsOn(uid, day) {
    if (!window.YDClock || !uid) return [];
    const all = (YDClock.shifts ? YDClock.shifts() : YDClock.entries()) || {};
    const a = dayStartMs(day), b = dayStartMs(addDays(day, 1));
    const storms = conf().storms;
    return Object.values(all).filter(e => {
      if (!e || e.uid !== uid || e.status === 'rejected' || (!storms && e.kind === 'storm')) return false;
      const s = YDClock.startMsOf(e);
      return s >= a && s < b;
    });
  }
  // The jobs they clocked into that day, in the order they went to them.
  function jobsWorked(uid, day) {
    const seen = {}, out = [];
    shiftsOn(uid, day).sort((x, y) => YDClock.startMsOf(x) - YDClock.startMsOf(y)).forEach(e => {
      if (e.kind !== 'job' || !e.targetId || seen[e.targetId]) return;
      seen[e.targetId] = 1;
      out.push({ id: String(e.targetId), name: String((YDClock.label ? YDClock.label(e) : e.targetName) || 'Job').slice(0, 120) });
    });
    return out;
  }
  // Off the clock and not on a break: done for the day.
  function offClock() {
    const m = window.YDClock && YDClock.mine ? YDClock.mine() : null;
    return !!m && !m.shift && !m.onBreak;
  }
  function pastAt() {
    const [h, m] = conf().at.split(':').map(Number);
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes() >= h * 60 + m;
  }

  // ------------------------------------------------------- on the phone

  const draftKey = day => DRAFT + myUid() + '_' + day;
  function readDraft(day) {
    try {
      const v = JSON.parse(localStorage.getItem(draftKey(day)) || 'null');
      return v && typeof v === 'object' ? v : null;
    } catch (e) { return null; }
  }
  function writeDraft(day, d) {
    try { localStorage.setItem(draftKey(day), JSON.stringify(d)); } catch (e) { /* private window: kept while open */ }
  }
  // A week is plenty: a report is sent the same day or the next.
  function pruneDrafts() {
    const cut = addDays(today(), -DRAFT_DAYS);
    try {
      Object.keys(localStorage).forEach(k => {
        const m = k.indexOf(DRAFT) === 0 && k.match(/_(\d{4}-\d\d-\d\d)$/);
        if (m && m[1] < cut) localStorage.removeItem(k);
      });
    } catch (e) { /* no storage */ }
  }

  // ------------------------------------------------- what Home shows

  // This person's end of day, if they get one: today's (to do once it is
  // past `at` on a day they worked, or they are off the clock; then sent),
  // and yesterday's if they worked and it never went.
  function forMe() {
    const uid = myUid();
    if (!uid || !cfgRead || !onList(uid)) return [];
    const t = today(), y = addDays(t, -1), out = [];
    const sent = sentReport(uid, t);
    if (sent) out.push({ day: t, state: 'sent', sentAt: sent.sentAt, pending: !!sent.pending });
    else if (shiftsOn(uid, t).length && (pastAt() || offClock())) out.push({ day: t, state: 'todo' });
    if (shiftsOn(uid, y).length && !sentReport(uid, y)) out.push({ day: y, state: 'late' });
    return out;
  }
  // The owner's: reports in and not read yet, newest first (his own aside).
  function unread() {
    if (!isOwner()) return [];
    return Object.values(known()).filter(r => r && r.sentAt && !r.readAt && r.uid !== myUid())
      .sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)))
      .map(r => ({ id: r.id, uid: r.uid, who: personName(r.uid, r.by), day: r.day, words: firstWords(r), at: r.sentAt }));
  }
  // The owner's: everyone on the list who worked today, and whether theirs is in.
  function crewToday() {
    if (!isOwner() || !cfgRead) return [];
    const t = today();
    return conf().who.filter(uid => uid !== myUid()).map(uid => {
      const r = sentReport(uid, t);
      if (!r && !shiftsOn(uid, t).length) return null;
      return { uid: uid, id: idOf(uid, t), who: personName(uid, r && r.by), sent: !!r, sentAt: r ? r.sentAt : '', read: !!(r && r.readAt) };
    }).filter(Boolean);
  }

  // ------------------------------------------------------------- a window

  function modal(id, title, cls) {
    let m = el(id);
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal-overlay';
      m.id = id;
      m.innerHTML = '<div class="modal eod-modal' + (cls ? ' ' + cls : '') + '"><div class="modal-head"><h2></h2>' +
        '<button type="button" class="modal-close" aria-label="Close">&times;</button></div><div class="modal-body"></div></div>';
      m.onclick = ev => { if (ev.target === m) m.classList.remove('active'); };
      m.querySelector('.modal-close').onclick = () => m.classList.remove('active');
      document.body.appendChild(m);
    }
    m.querySelector('h2').textContent = title;
    m.classList.add('active');
    return m.querySelector('.modal-body');
  }
  const isOpen = id => { const m = el(id); return !!(m && m.classList.contains('active')); };
  // Told when a window closes, however it was closed (×, Back, Esc, a tap
  // outside): the form stops counting photos and keeps what was typed.
  function onClose(id, fn) {
    const m = el(id);
    if (!m || m.dataset.watched) return;
    m.dataset.watched = '1';
    new MutationObserver(() => { if (!m.classList.contains('active')) fn(); })
      .observe(m, { attributes: true, attributeFilter: ['class'] });
  }

  // =========================================================== the form

  let form = null;            // { day, jobs [{id, name}], hand, answers } -- the one open
  let saveTimer = 0;
  let photoUnsub = null, photoStop = null, photoRecs = {}, photoRange = ['', ''];

  // Before 5 am the day still open is yesterday's, if they worked it and it
  // has not gone; otherwise today.
  function defaultDay() {
    const t = today(), y = addDays(t, -1), uid = myUid();
    if (new Date().getHours() < EARLY_HOURS && shiftsOn(uid, y).length && !sentReport(uid, y)) return y;
    return t;
  }

  let openWhenRead = null;    // asked for before the list had arrived (a notification tapped at start-up)
  window.openEndOfDay = function (day) {
    if (!signedIn()) return;
    if (!cfgRead) { openWhenRead = { day: day || '' }; return; }
    const uid = myUid();
    if (!onList(uid)) { window.openEodReports(); return; }
    day = isDay(day) ? day : defaultDay();
    // One already open is kept first, then drawn again from what was kept.
    if (form) closeForm();
    const d = readDraft(day) || {};
    const sent = known()[idOf(uid, day)];
    // The newer of what is on the phone and what was sent (from another
    // phone, perhaps).
    const fromSent = !!(sent && sent.sentAt && (!d.savedAt || String(sent.sentAt) > String(d.savedAt)));
    const answers = Object.assign({}, fromSent ? sent.answers : (d.answers || (sent && sent.answers) || {}));
    const hand = fromSent ? true : !!d.hand;
    const before = fromSent ? (sent.jobs || []) : (d.jobs || (sent && sent.jobs) || []);
    form = { day: day, hand: hand, answers: answers,
             jobs: tidyJobs(hand ? before : jobsWorked(uid, day).concat(before)) };
    const body = modal('eodModal', '📋 End of day — ' + (day === today() ? 'today' : longDay(day)), 'eod-form');
    onClose('eodModal', closeForm);
    // Every tick and pick is kept as it is made (app.js guardWindows: such a
    // window is not "typed in"; the boxes say so themselves, eodType).
    el('eodModal').setAttribute('data-autosave', '');
    body.innerHTML = formHtml();
    startPhotos(day);
    refreshForm();
  };
  window.eodLater = function () {
    const m = el('eodModal');
    if (m) m.classList.remove('active');
    if (form) showToast('Kept — it’s on Home until you send it');
  };
  function closeForm() {
    if (!form) return;
    clearTimeout(saveTimer);
    saveForm();
    form = null;
    stopPhotos();
    changed();
  }
  function tidyJobs(list) {
    const seen = {}, out = [];
    (list || []).forEach(j => {
      const id = j && String(j.id || '');
      if (!id || seen[id]) return;
      seen[id] = 1;
      out.push({ id: id, name: String(j.name || 'Job').slice(0, 120) });
    });
    return out;
  }
  function saveForm() {
    if (!form) return;
    const d = readDraft(form.day) || {};
    writeDraft(form.day, Object.assign(d, { jobs: form.jobs, hand: form.hand, answers: form.answers, savedAt: nowIso() }));
  }
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveForm, 400); }

  // Built once when it opens and then only filled in: drawing it again would
  // take the cursor out of a box mid-word, or swap the photo button out
  // from under the phone's picker.
  function formHtml() {
    const items = conf().items;
    return '<div data-eod-sent></div>' +
      '<div class="eod-sec" id="eodJobs">' + jobsHtml() + '</div>' +
      (items.length ? items.map(itemHtml).join('') : '<p class="muted">Jonah has not put anything on the list yet.</p>') +
      '<div class="eod-acts">' +
        '<button type="button" class="btn btn-filled eod-send" data-eod-send onclick="eodSend()">Send to Jonah</button>' +
        '<button type="button" class="btn eod-later" onclick="eodLater()">Later</button>' +
      '</div>' +
      '<p class="hint eod-foot">Kept on this phone as you type — nothing is lost. It goes to Jonah when you press Send; ' +
        'with no signal, as soon as there is some.</p>';
  }

  function boardJobs() {
    const b = (window.YDClock && YDClock.board && YDClock.board()) || {};
    return Object.values(b).filter(j => j && j.id && j.name)
      .map(j => ({ id: String(j.id), name: typeof jobLabel === 'function' ? jobLabel(j.name, j.what || '') : j.name }))
      .sort((a, c) => a.name.localeCompare(c.name));
  }
  function jobsHtml() {
    const others = boardJobs().filter(j => !form.jobs.some(p => p.id === j.id));
    return '<div class="eod-h">🔨 Jobs ' + (form.day === today() ? 'today' : 'that day') + '</div>' +
      (form.jobs.length
        ? '<div class="eod-jobs">' + form.jobs.map(j => '<span class="eod-job">' + esc(j.name) +
            '<button type="button" onclick="eodDropJob(\'' + safe(j.id) + '\')" aria-label="Take ' + esc(j.name) + ' off">&times;</button></span>').join('') + '</div>'
        : '<p class="muted eod-none">No job clocked ' + (form.day === today() ? 'today' : 'that day') + ' — add the ones you worked on.</p>') +
      (others.length ? '<select class="eod-addjob" onchange="eodAddJob(this.value)" aria-label="Add a job">' +
        '<option value="">＋ Add a job…</option>' +
        others.map(j => '<option value="' + safe(j.id) + '">' + esc(j.name) + '</option>').join('') + '</select>' : '') +
      tickedHtml(myUid(), form.day, form.jobs);
  }
  // The work this person ticked off that day on the job pages (workdone.js),
  // job by job -- a start on "what got done", and Jonah sees it with the report.
  function tickedHtml(uid, day, named) {
    const list = window.YDWorkDone && YDWorkDone.tickedOn && uid ? YDWorkDone.tickedOn(day, uid) : [];
    if (!list.length) return '';
    const by = {}, order = [];
    list.slice().reverse().forEach(t => { if (!by[t.jobId]) { by[t.jobId] = []; order.push(t.jobId); } by[t.jobId].push(t.title); });
    const nameOf = id => ((named || []).find(j => j && j.id === id) || {}).name || YDWorkDone.jobName(id);
    return '<div class="eod-ticked"><div class="eod-ticked-h">✅ Ticked off as done</div>' + order.map(id =>
      '<div class="eod-ticked-row"><b>' + esc(nameOf(id)) + '</b> — ' + esc(by[id].join(', ')) + '</div>').join('') + '</div>';
  }
  window.eodAddJob = function (id) {
    if (!form || !id) return;
    const j = boardJobs().find(x => x.id === id);
    if (!j || form.jobs.some(x => x.id === id)) return;
    form.jobs.push(j);
    form.hand = true;
    jobsChanged();
  };
  window.eodDropJob = function (id) {
    if (!form) return;
    form.jobs = form.jobs.filter(j => safe(j.id) !== id);
    form.hand = true;
    jobsChanged();
  };
  function jobsChanged() {
    const j = el('eodJobs'), p = el('eodPJobs');
    if (j) j.innerHTML = jobsHtml();
    if (p) p.innerHTML = photoJobsHtml();
    countPhotos();
    saveForm();
  }

  function itemHtml(it, i) {
    const id = safe(it.id), v = form.answers[it.id];
    const need = it.need ? ' <span class="eod-need">needed</span>' : '';
    const hint = it.hint ? '<div class="hint eod-hint">' + esc(it.hint) + '</div>' : '';
    const head = '<div class="eod-h"><span class="eod-n">' + (i + 1) + '</span>' + esc(it.label) + need + '</div>';
    if (it.kind === 'check') {
      return '<div class="eod-item" data-eod-item="' + id + '">' +
        '<label class="eod-check eod-check-big"><span class="eod-n">' + (i + 1) + '</span>' +
          '<input type="checkbox" data-eod-tick="' + id + '"' + (v === true ? ' checked' : '') + ' onchange="eodTick(this)">' +
          '<span>' + esc(it.label) + need + '</span></label>' + hint + '</div>';
    }
    if (it.kind === 'photos') {
      return '<div class="eod-item eod-photos" data-eod-item="' + id + '">' + head + hint +
        '<div id="eodPJobs">' + photoJobsHtml() + '</div>' +
        '<div class="hint eod-pnote" data-eod-pnote hidden></div>' +
        '<label class="eod-check"><input type="checkbox" data-eod-tick="' + id + '"' + (v === true ? ' checked' : '') +
          ' onchange="eodTick(this)"><span>All of ' + (form.day === today() ? 'today’s' : 'that day’s') + ' photos are up</span></label></div>';
    }
    return '<div class="eod-item" data-eod-item="' + id + '">' + head + hint +
      '<textarea rows="3" maxlength="' + MAX_TEXT + '" data-eod-text="' + id + '" oninput="eodType(this)" aria-label="' +
        esc(it.label) + '">' + esc(typeof v === 'string' ? v : '') + '</textarea></div>';
  }
  // A job's photo buttons, as on the job's own page: Before, During, After
  // (each photo on a job is marked one of them), straight onto that job.
  function photoJobsHtml() {
    if (!form.jobs.length) return '<p class="muted">Add the job(s) above, then their photos here.</p>';
    return form.jobs.map(j => '<div class="eod-pjob">' +
      '<div class="eod-pjob-h"><b>' + esc(j.name) + '</b><span class="eod-pn" data-eod-pn="' + safe(j.id) + '"></span></div>' +
      '<div class="jp-add">' + STAGES.map(([k, name]) =>
        '<label class="btn jp-btn jp-btn-' + k + '">📷 Add <span class="jp-btn-what">' + name + ' photo</span>' +
        '<input type="file" accept="image/*" multiple hidden data-job="' + safe(j.id) + '" onchange="jpPicked(this, \'' + k + '\')"></label>').join('') +
      '</div></div>').join('');
  }

  window.eodType = function (t) {
    if (!form) return;
    const id = t.getAttribute('data-eod-text');
    const it = conf().items.find(x => safe(x.id) === id);
    if (!it) return;
    form.answers[it.id] = t.value.slice(0, MAX_TEXT);
    const box = t.closest('.eod-item');
    if (box) box.classList.remove('eod-miss');
    // Kept on the phone as it is typed, so a tap outside the window that
    // closes it loses nothing -- not "Save, or close it with ×".
    const o = t.closest('.modal-overlay');
    if (o) delete o.dataset.typed;
    saveSoon();
  };
  window.eodTick = function (box) {
    if (!form) return;
    const id = box.getAttribute('data-eod-tick');
    const it = conf().items.find(x => safe(x.id) === id);
    if (!it) return;
    form.answers[it.id] = !!box.checked;
    const row = box.closest('.eod-item');
    if (row) row.classList.remove('eod-miss');
    saveForm();
  };

  // What changes while it is open: whether it has gone, and the photos.
  function refreshForm() {
    if (!form || !isOpen('eodModal')) return;
    const m = el('eodModal');
    const sent = sentReport(myUid(), form.day);
    const box = m.querySelector('[data-eod-sent]');
    if (box) {
      box.innerHTML = sent ? '<div class="eod-banner">✓ ' + (sent.pending ? 'Saved — it goes to Jonah when this phone has signal'
        : 'Sent to Jonah at ' + esc(whenWords(sent.sentAt, form.day)) + (sent.readAt ? ' · Jonah has read it' : '')) +
        '. Change anything and send it again.</div>' : '';
    }
    const send = m.querySelector('[data-eod-send]');
    if (send) send.textContent = sent ? 'Send the changes to Jonah' : 'Send to Jonah';
    // Jobs clocked into since it opened join the list, unless it was picked by hand.
    if (!form.hand) {
      const now = tidyJobs(jobsWorked(myUid(), form.day).concat(form.jobs));
      if (now.length !== form.jobs.length) { form.jobs = now; jobsChanged(); }
    }
    countPhotos();
  }

  // ------------------------------------------------- the day's photos

  // This person's photos taken that day: the ones on the server (asked for
  // by the time taken, which covers everyone's for the day -- a handful),
  // and the ones still on this phone waiting for signal.
  function startPhotos(day) {
    stopPhotos();
    photoRange = [new Date(dayStartMs(day)).toISOString(), new Date(dayStartMs(addDays(day, 1))).toISOString()];
    if (window.YDDb && YDDb.watchFrom) {
      photoUnsub = YDDb.watchFrom('jobPhotos', 'at', photoRange[0], changes => {
        changes.forEach(c => { if (c.type === 'removed') delete photoRecs[c.id]; else photoRecs[c.id] = c.data || {}; });
        countPhotos();
      }, () => {});
    }
    if (window.YDJobPhotos && YDJobPhotos.onChange) photoStop = YDJobPhotos.onChange(countPhotos);
  }
  function stopPhotos() {
    if (photoUnsub) { try { photoUnsub(); } catch (e) { /* already gone */ } }
    if (photoStop) { try { photoStop(); } catch (e) { /* already gone */ } }
    photoUnsub = photoStop = null;
    photoRecs = {};
  }
  function photoCounts() {
    const uid = myUid(), [from, to] = photoRange;
    const byJob = {};
    let count = 0, sending = 0;
    const inDay = at => typeof at === 'string' && at >= from && at < to;
    Object.keys(photoRecs).forEach(id => {
      const p = photoRecs[id];
      if (!p || p.by !== uid || p.deleteAsked || !inDay(p.at)) return;
      byJob[p.jobId] = (byJob[p.jobId] || 0) + 1;
      count++;
    });
    const queued = window.YDJobPhotos && YDJobPhotos.queued ? YDJobPhotos.queued() : [];
    queued.forEach(q => {
      if (photoRecs[q.id] || !inDay(q.at)) return;
      byJob[q.jobId] = (byJob[q.jobId] || 0) + 1;
      count++;
      sending++;
    });
    return { byJob: byJob, count: count, sending: sending };
  }
  function countPhotos() {
    const m = el('eodModal');
    if (!form || !m) return;
    const n = photoCounts();
    m.querySelectorAll('[data-eod-pn]').forEach(s => {
      const id = s.getAttribute('data-eod-pn');
      const k = Object.keys(n.byJob).filter(j => safe(j) === id).reduce((t, j) => t + n.byJob[j], 0);
      s.textContent = k ? '📷 ' + k + ' photo' + (k === 1 ? '' : 's') + (form.day === today() ? ' today' : ' that day') : 'No photos yet';
      s.classList.toggle('none', !k);
    });
    const note = m.querySelector('[data-eod-pnote]');
    if (note) {
      const elsewhere = Object.keys(n.byJob).filter(j => !form.jobs.some(x => x.id === j)).reduce((t, j) => t + n.byJob[j], 0);
      const words = [];
      if (n.sending) words.push(n.sending === 1 ? '1 photo is still sending from this phone — it goes by itself.'
        : n.sending + ' photos are still sending from this phone — they go by themselves.');
      if (elsewhere) words.push(elsewhere + ' more on ' + (elsewhere === 1 ? 'a job' : 'jobs') + ' not listed above.');
      note.textContent = words.join(' ');
      note.hidden = !words.length;
    }
  }

  // --------------------------------------------------------------- send

  window.eodSend = function () {
    if (!form || !signedIn() || !window.YDDb) return;
    clearTimeout(saveTimer);
    const uid = myUid(), day = form.day, c = conf();
    // Everything marked "needed" first, the first one missing shown.
    const missing = c.items.filter(it => it.need && (it.kind === 'text'
      ? !(typeof form.answers[it.id] === 'string' && form.answers[it.id].trim()) : form.answers[it.id] !== true));
    const m = el('eodModal');
    if (missing.length) {
      missing.forEach(it => {
        const row = m && m.querySelector('[data-eod-item="' + safe(it.id) + '"]');
        if (row) row.classList.add('eod-miss');
      });
      const first = m && m.querySelector('[data-eod-item="' + safe(missing[0].id) + '"]');
      if (first) {
        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const box = first.querySelector('textarea, input');
        if (box) setTimeout(() => { try { box.focus({ preventScroll: true }); } catch (e) { /* older phone */ } }, 300);
      }
      showToast((missing[0].kind === 'text' ? 'Fill in: ' : 'Tick: ') + missing[0].label);
      return;
    }
    const n = photoCounts();
    const answers = {};
    c.items.forEach(it => {
      const v = form.answers[it.id];
      answers[it.id] = it.kind === 'text' ? String(typeof v === 'string' ? v : '').trim().slice(0, MAX_TEXT) : v === true;
    });
    const was = known()[idOf(uid, day)];
    const at = nowIso();
    const me = window.YDRemind && YDRemind.me ? YDRemind.me() : null;
    const rec = {
      uid: uid, by: String((me && me.name) || YDAuth.user.displayName || YDAuth.user.email || 'Someone').slice(0, 80), day: day,
      jobs: form.jobs.map(j => ({ id: j.id, name: j.name, photos: n.byJob[j.id] || 0 })),
      jobIds: form.jobs.map(j => j.id),
      items: c.items.map(it => ({ id: it.id, kind: it.kind, label: it.label })),
      answers: answers,
      photos: { count: n.count, sending: n.sending },
      sentAt: at, sentCount: ((was && was.sentCount) || 0) + 1,
      // A send is new to him: told and unread again.
      readAt: null, notifiedAt: null, updatedAt: at,
    };
    const id = idOf(uid, day);
    reports[id] = Object.assign({ id: id }, rec);
    const d = readDraft(day) || {};
    writeDraft(day, Object.assign(d, { jobs: form.jobs, hand: form.hand, answers: form.answers, savedAt: at, sentAt: at }));
    // Never awaited: with no signal it waits on the phone and goes when it
    // can (a write only settles once the server has it).
    Promise.resolve(YDDb.put('endOfDay', id, rec)).then(() => ping()).catch(e => {
      console.warn('[eod] not sent:', (e && e.code) || e);
      if (e && e.code === 'permission-denied') {
        // Refused, not waiting: it must not look sent.
        const back = readDraft(day) || {};
        delete back.sentAt;
        writeDraft(day, back);
        if (reports[id] && reports[id].sentAt === at) delete reports[id];
        changed();
        showToast('Not sent — not allowed. Tell Jonah.', 6000);
      }
    });
    const m2 = el('eodModal');
    if (m2) m2.classList.remove('active');
    showToast(navigator.onLine === false ? 'Saved — it goes to Jonah when you have signal' : 'Sent to Jonah — thanks');
    changed();
  };
  // Tell him now rather than at the next five-minute run.
  function ping() {
    if (!window.YDClaude || !YDClaude.available || !YDClaude.available()) return;
    YDClaude.post('/notes/ping', {}).catch(() => {});
  }

  // When they clock out for the day: the list, straight away, if theirs is
  // not in. Clocking out to go somewhere else is a Switch, which ends the
  // shift without this.
  document.addEventListener('yd-clocked-out', e => {
    const d = e.detail || {};
    const uid = myUid();
    if (!uid || d.uid !== uid || !onList(uid) || (d.kind === 'storm' && !conf().storms)) return;
    const t = today();
    if (sentReport(uid, t) || !shiftsOn(uid, t).length) return;
    // After the clock has said so -- and not if they clocked straight back in.
    setTimeout(() => { if (!form && offClock()) window.openEndOfDay(t); }, 1200);
  });

  // ============================================ reading them (and history)

  let listShow = LIST_SHOW;
  let olderAsked = false;

  window.openEodReports = function (focusId) {
    if (!signedIn()) return;
    modal('eodListModal', isOwner() ? '📋 End of day' : '📋 Your end-of-day reports', 'eod-list');
    listShow = LIST_SHOW;
    renderList();
    const id = safe(focusId);
    if (!id) return;
    // Opened from Home or a notification: that one is being read now.
    if (isOwner()) window.eodRead(id, true);
    setTimeout(() => {
      const n = el('eodRep_' + id);
      if (n) { n.scrollIntoView({ block: 'start', behavior: 'smooth' }); n.classList.add('eod-flash'); setTimeout(() => n.classList.remove('eod-flash'), 1600); }
    }, 60);
  };

  function photosWords(r, jobId) {
    const p = r.photos || {};
    const jobs = Array.isArray(r.jobs) ? r.jobs : [];
    if (jobId) {
      const j = jobs.find(x => x && x.id === jobId);
      const k = j ? Number(j.photos) || 0 : 0;
      return k ? k + ' photo' + (k === 1 ? '' : 's') + ' on this job' : 'no photos on this job';
    }
    const n = Number(p.count) || 0;
    const per = jobs.filter(j => j && Number(j.photos) > 0);
    return (n ? n + ' photo' + (n === 1 ? '' : 's') : 'no photos') +
      (per.length > 1 ? ' (' + per.map(j => String(j.name).split(' · ')[0] + ' ' + j.photos).join(', ') + ')' : '') +
      (Number(p.sending) > 0 ? ' — ' + p.sending + ' still sending then' : '');
  }

  // One report as he reads it. opts.job: shown on that job's page.
  function reportHtml(r, opts) {
    opts = opts || {};
    const items = Array.isArray(r.items) && r.items.length ? r.items : conf().items;
    const a = r.answers || {};
    const owner = isOwner();
    const seesJobs = typeof ydCan === 'function' && ydCan('jobs', 'see');
    const jobs = (Array.isArray(r.jobs) ? r.jobs : []).filter(j => j && j.id);
    const rows = items.map(it => {
      const v = a[it.id];
      if (it.kind === 'photos') {
        return '<div class="eod-rep-row eod-rep-tick ' + (v === true ? 'yes' : 'no') + '">📷 ' +
          (v === true ? 'Photos all up' : 'Photos not ticked as all up') + ' · ' + esc(photosWords(r, opts.job)) + '</div>';
      }
      if (it.kind === 'check') {
        return '<div class="eod-rep-row eod-rep-tick ' + (v === true ? 'yes' : 'no') + '">' + (v === true ? '✓ ' : '✗ ') + esc(it.label) + '</div>';
      }
      const s = typeof v === 'string' ? v.trim() : '';
      return '<div class="eod-rep-row"><div class="eod-rep-l">' + esc(it.label) + '</div>' +
        '<div class="eod-rep-t' + (s ? '' : ' none') + '">' + (s ? esc(s) : '—') + '</div></div>';
    }).join('');
    const unreadOne = owner && r.sentAt && !r.readAt && r.uid !== myUid();
    const head = (opts.job || owner ? '<b>' + esc(personName(r.uid, r.by)) + '</b> · ' : '') + esc(dayWords(r.day)) +
      '<span class="muted"> · ' + (r.pending ? 'waiting for signal' : 'sent ' + esc(whenWords(r.sentAt, r.day))) +
      (Number(r.sentCount) > 1 ? ' · changed' : '') + '</span>';
    const jobLine = jobs.length && !opts.job ? '<div class="eod-rep-jobs">🔨 ' + jobs.map(j => seesJobs
      ? '<button type="button" class="link-btn" onclick="eodOpenJob(\'' + safe(j.id) + '\')">' + esc(j.name) + '</button>'
      : esc(j.name)).join(', ') + '</div>' : '';
    const acts = owner && r.uid !== myUid() && !opts.job ? '<div class="eod-rep-acts">' + (r.readAt
      ? '<button type="button" class="link-btn" onclick="eodRead(\'' + safe(r.id) + '\', false)">Mark unread</button>'
      : '<button type="button" class="btn btn-sm" onclick="eodRead(\'' + safe(r.id) + '\', true)">✓ Read it</button>') + '</div>'
      : !owner && !opts.job && r.uid === myUid() && onList(myUid()) && r.day >= addDays(today(), -DRAFT_DAYS)
      ? '<div class="eod-rep-acts"><button type="button" class="link-btn" onclick="eodChange(\'' + safe(r.day) + '\')">Change it</button></div>' : '';
    return '<div class="eod-rep' + (unreadOne ? ' unread' : '') + '" id="eodRep_' + safe(r.id) + '">' +
      '<div class="eod-rep-h">' + head + '</div>' + jobLine + (opts.job ? '' : tickedHtml(r.uid, r.day, jobs)) + rows + acts + '</div>';
  }

  function renderList() {
    const m = el('eodListModal');
    if (!m || !m.classList.contains('active')) return;
    const body = m.querySelector('.modal-body');
    const owner = isOwner(), uid = myUid();
    const mineToo = onList(uid);
    const top = '<div class="eod-list-top">' +
      (mineToo ? '<button type="button" class="btn btn-filled" onclick="eodFillIn()">📋 Fill in ' + (owner ? 'mine' : 'today’s') + '</button>' : '') +
      (owner ? '<button type="button" class="btn" onclick="openEodSettings()">⚙ Change the list</button>' : '') +
    '</div>';
    // The owner: who worked today or yesterday and has not sent theirs.
    const missing = [];
    if (owner && cfgRead) {
      [today(), addDays(today(), -1)].forEach(day => conf().who.forEach(w => {
        if (w === uid || sentReport(w, day) || !shiftsOn(w, day).length) return;
        missing.push('<div class="eod-missing">📋 <b>' + esc(personName(w)) + '</b> — ' +
          (day === today() ? 'today’s isn’t in yet' : 'yesterday’s was never sent') + '</div>');
      }));
    }
    const list = Object.values(known()).filter(r => r && r.sentAt && (owner || r.uid === uid))
      .sort((a, b) => String(b.day).localeCompare(String(a.day)) || String(b.sentAt).localeCompare(String(a.sentAt)));
    const n = unread().length;
    const empty = !owner && !mineToo ? 'Jonah has not put you on the end-of-day list.'
      : owner && !conf().who.length ? 'Nobody gets the end-of-day list yet — ⚙ Change the list to pick who.'
      : 'No end-of-day reports yet.';
    body.innerHTML = top + missing.join('') +
      (owner && n > 1 ? '<div class="field-actions"><button type="button" class="btn btn-sm" onclick="eodReadAll()">✓ Mark all ' + n + ' read</button></div>' : '') +
      (list.length ? list.slice(0, listShow).map(r => reportHtml(r)).join('') : '<p class="empty-msg">' + esc(empty) + '</p>') +
      (list.length > listShow || (owner && !olderAsked)
        ? '<div class="field-actions"><button type="button" class="btn btn-sm" onclick="eodMore()">Show more</button></div>' : '');
  }
  window.eodFillIn = function () {
    const m = el('eodListModal');
    if (m) m.classList.remove('active');
    window.openEndOfDay();
  };
  window.eodChange = function (day) {
    const m = el('eodListModal');
    if (m) m.classList.remove('active');
    window.openEndOfDay(day);
  };
  window.eodMore = function () {
    listShow += LIST_SHOW;
    // The owner's from before the live ones: asked for once, when first wanted.
    if (isOwner() && !olderAsked && window.YDDb && YDDb.listWhere) {
      olderAsked = true;
      Promise.resolve(YDDb.listWhere('endOfDay', 'day', '<', addDays(today(), -WATCH_DAYS))).then(found => {
        Object.keys(found || {}).forEach(id => { older[id] = Object.assign({ id: id }, found[id]); });
        changed();
      }).catch(e => { olderAsked = false; showToast('Older ones need signal'); console.warn('[eod] older not read:', (e && e.code) || e); });
    }
    renderList();
  };
  window.eodRead = function (id, on) {
    if (!isOwner() || !window.YDDb) return;
    const r = known()[id];
    if (!r || r.pending || !!r.readAt === !!on) return;
    r.readAt = on ? nowIso() : null;
    Promise.resolve(YDDb.put('endOfDay', id, { readAt: r.readAt })).catch(e => console.warn('[eod] read not saved:', (e && e.code) || e));
    changed();
  };
  window.eodReadAll = function () { unread().forEach(x => window.eodRead(x.id, true)); };
  window.eodOpenJob = async function (jobId) {
    ['eodListModal', 'eodModal'].forEach(id => { const m = el(id); if (m) m.classList.remove('active'); });
    if (typeof currentJobId !== 'undefined' && currentJobId === jobId) { switchTab('job'); return; }
    if (typeof ydLeaveUnsavedJob === 'function' && !(await ydLeaveUnsavedJob())) return;
    if (typeof loadJob === 'function') loadJob(jobId);
    if (typeof switchTab === 'function') switchTab('job');
  };

  // ==================================================== changing the list

  window.openEodSettings = function () {
    if (!isOwner()) return;
    const l = el('eodListModal');
    if (l) l.classList.remove('active');
    const body = modal('eodSetModal', '📋 End-of-day list', 'eod-set');
    // Each change is saved as it is made: nothing to lose by closing it.
    el('eodSetModal').setAttribute('data-autosave', '');
    body.innerHTML = '';
    renderSettings();
  };

  function peopleList() {
    const ppl = (window.YDClock && YDClock.people ? YDClock.people() : null) || {};
    return Object.keys(ppl).map(uid => Object.assign({ uid: uid }, ppl[uid]))
      .filter(p => p.active === true && ['crew', 'admin', 'owner'].indexOf(p.role) !== -1)
      .sort((a, b) => (a.role === 'owner') - (b.role === 'owner') || String(a.name || '').localeCompare(String(b.name || '')));
  }
  function renderSettings() {
    const m = el('eodSetModal');
    if (!m || !m.classList.contains('active')) return;
    const c = conf();
    const ppl = peopleList();
    const whoHtml = ppl.map(p => {
      const on = c.who.indexOf(p.uid) !== -1;
      return '<button type="button" class="eod-who-b' + (on ? ' on' : '') + '" aria-pressed="' + on + '" onclick="eodSetWho(\'' + safe(p.uid) + '\')">' +
        (on ? '✓ ' : '') + esc(p.name || p.email || 'Someone') + (p.role === 'owner' ? ' (you)' : '') + '</button>';
    }).join('');
    // Someone on the list who is no longer an active worker: shown, to take off.
    const gone = c.who.filter(uid => !ppl.some(p => p.uid === uid)).map(uid =>
      '<button type="button" class="eod-who-b on gone" aria-pressed="true" onclick="eodSetWho(\'' + safe(uid) + '\')">✓ ' + esc(personName(uid, 'Someone no longer here')) + '</button>').join('');
    const hasPhotos = c.items.some(it => it.kind === 'photos');
    const row = (it, i) => {
      const id = safe(it.id);
      return '<div class="eod-set-row">' +
        '<div class="eod-set-move">' +
          '<button type="button" class="btn btn-sm" onclick="eodSetMove(\'' + id + '\', -1)"' + (i === 0 ? ' disabled' : '') + ' aria-label="Up">↑</button>' +
          '<button type="button" class="btn btn-sm" onclick="eodSetMove(\'' + id + '\', 1)"' + (i === c.items.length - 1 ? ' disabled' : '') + ' aria-label="Down">↓</button>' +
        '</div>' +
        '<div class="eod-set-main">' +
          '<input class="eod-set-label" value="' + esc(it.label) + '" maxlength="' + MAX_LABEL + '" aria-label="What it says" onchange="eodSetItem(\'' + id + '\', \'label\', this.value)">' +
          '<div class="eod-set-opts">' +
            (it.kind === 'photos' ? '<span class="eod-set-kind">📷 The day’s photos, onto each job, then a tick</span>'
              : '<select aria-label="What kind" onchange="eodSetItem(\'' + id + '\', \'kind\', this.value)">' +
                  ['text', 'check'].map(k => '<option value="' + k + '"' + (it.kind === k ? ' selected' : '') + '>' + KIND_NAME[k] + '</option>').join('') +
                '</select>') +
            '<label class="eod-set-need"><input type="checkbox"' + (it.need ? ' checked' : '') + ' onchange="eodSetItem(\'' + id + '\', \'need\', this.checked)"> Needed to send</label>' +
          '</div>' +
          '<input class="eod-set-hint" value="' + esc(it.hint) + '" maxlength="300" placeholder="A hint under it (optional)" aria-label="Hint" onchange="eodSetItem(\'' + id + '\', \'hint\', this.value)">' +
        '</div>' +
        '<button type="button" class="remove-btn" onclick="eodSetRemove(\'' + id + '\')" title="Take it off the list" aria-label="Take it off">&times;</button>' +
      '</div>';
    };
    m.querySelector('.modal-body').innerHTML =
      '<p class="hint">What they fill in before going home. It comes to you as one report — on your phone, on Home, in your evening summary and on each job’s page.</p>' +
      '<div class="eod-set-h">Who gets it</div>' +
      '<div class="eod-who">' + (whoHtml + gone || '<span class="muted">Loading the crew…</span>') + '</div>' +
      '<div class="eod-set-h">The list <span class="muted">— in this order</span></div>' +
      c.items.map(row).join('') +
      '<div class="eod-set-add">' +
        '<button type="button" class="btn btn-sm" onclick="eodSetAdd(\'text\')">＋ Something to write</button>' +
        '<button type="button" class="btn btn-sm" onclick="eodSetAdd(\'check\')">＋ A tick box</button>' +
        (hasPhotos ? '' : '<button type="button" class="btn btn-sm" onclick="eodSetAdd(\'photos\')">＋ The day’s photos</button>') +
      '</div>' +
      '<div class="eod-set-h">When</div>' +
      '<label class="eod-set-line">On their Home from <input type="time" value="' + esc(c.at) + '" onchange="eodSetTime(\'at\', this.value)"> ' +
        'on a day they worked, until it’s sent — and it opens by itself when they clock out.</label>' +
      // The reminder and its time are two settings: switching it off keeps the time.
      '<div class="eod-set-line"><label class="eod-set-tick"><input type="checkbox"' + (c.remind ? ' checked' : '') +
        ' onchange="eodSetFlag(\'remind\', this.checked)"> Remind their phone</label> at ' +
        '<input type="time" value="' + esc(c.remindAt) + '" aria-label="Reminder time" onchange="eodSetTime(\'remindAt\', this.value)"> ' +
        'if theirs isn’t in by then</div>' +
      '<label class="eod-set-tick eod-set-wide"><input type="checkbox"' + (c.storms ? ' checked' : '') + ' onchange="eodSetFlag(\'storms\', this.checked)">' +
        '<span>A night on a snow storm counts as a day worked</span></label>' +
      '<div class="field-actions"><button type="button" class="btn btn-filled btn-sm" onclick="closeEodSettings()">Done</button></div>';
  }
  window.closeEodSettings = function () { const m = el('eodSetModal'); if (m) m.classList.remove('active'); };

  function itemsWith(fn) {
    const items = conf().items.map(x => Object.assign({}, x));
    fn(items);
    saveCfg({ items: items });
  }
  window.eodSetWho = function (uid) {
    if (!isOwner() || !uid) return;
    const who = conf().who.slice();
    const i = who.indexOf(uid);
    if (i === -1) who.push(uid); else who.splice(i, 1);
    saveCfg({ who: who });
    renderSettings();
  };
  window.eodSetItem = function (id, field, v) {
    if (!isOwner()) return;
    if (field === 'label' && !String(v || '').trim()) { showToast('Say what it is'); renderSettings(); return; }
    itemsWith(items => {
      const it = items.find(x => safe(x.id) === id);
      if (!it) return;
      if (field === 'need') it.need = !!v;
      else if (field === 'kind') { if (it.kind !== 'photos' && (v === 'text' || v === 'check')) it.kind = v; }
      else if (field === 'label') it.label = String(v).trim().slice(0, MAX_LABEL);
      else if (field === 'hint') it.hint = String(v || '').trim().slice(0, 300);
    });
    // Only a change of kind changes what the row shows.
    if (field === 'kind') renderSettings();
  };
  window.eodSetMove = function (id, dir) {
    if (!isOwner()) return;
    itemsWith(items => {
      const i = items.findIndex(x => safe(x.id) === id), j = i + dir;
      if (i < 0 || j < 0 || j >= items.length) return;
      const t = items[i]; items[i] = items[j]; items[j] = t;
    });
    renderSettings();
  };
  window.eodSetRemove = async function (id) {
    const c = conf();
    const it = c.items.find(x => safe(x.id) === id);
    if (!isOwner() || !it) return;
    if (c.items.length === 1) { showToast('The list needs at least one thing on it'); return; }
    if (!(await ydConfirm('Reports already sent keep it.', { title: 'Take “' + it.label + '” off the list?', ok: 'Take it off', danger: true }))) return;
    itemsWith(items => { const i = items.findIndex(x => safe(x.id) === id); if (i !== -1) items.splice(i, 1); });
    renderSettings();
  };
  window.eodSetAdd = async function (kind) {
    if (!isOwner() || !KIND_NAME[kind]) return;
    const c = conf();
    if (c.items.length >= MAX_ITEMS) { showToast('That’s the most the list holds'); return; }
    if (kind === 'photos') {
      if (c.items.some(x => x.kind === 'photos')) return;
      itemsWith(items => items.unshift(tidyItem(DEFAULT_ITEMS[0])));
      renderSettings();
      return;
    }
    const label = await ydPrompt(kind === 'check' ? 'They tick it before sending — e.g. “Trailer locked up”.' : 'They write a few words — e.g. “Materials used up”.',
      '', { title: kind === 'check' ? 'A tick box' : 'Something to write', placeholder: kind === 'check' ? 'Trailer locked up' : 'Materials used up', ok: 'Add it' });
    if (!label || !label.trim()) return;
    itemsWith(items => items.push(tidyItem({ id: newId(), kind: kind, label: label, hint: '', need: false })));
    renderSettings();
  };
  window.eodSetTime = function (field, v) {
    if (!isOwner() || (field !== 'at' && field !== 'remindAt')) return;
    if (!isTime(v)) { showToast('Pick a time'); renderSettings(); return; }
    saveCfg({ [field]: v });
  };
  window.eodSetFlag = function (field, on) {
    if (!isOwner() || (field !== 'remind' && field !== 'storms')) return;
    saveCfg({ [field]: !!on });
  };

  // ======================================================== the Job tab

  let jobId = null;
  let jobShowAll = false;
  const jobAsked = {};        // job id -> its older reports asked for (the owner's)

  // Called by app.js whenever the job on the Job tab changes. A job's
  // end-of-day notes, newest first; nothing at all when it has none.
  function jobShown(id) {
    if (!signedIn() || typeof ydCan !== 'function' || !ydCan('jobs', 'see')) return;
    if (id !== jobId) jobShowAll = false;
    jobId = id || null;
    let sec = el('jobEodSection');
    if (!sec) {
      const after = el('jobSigsSection') || el('jobPhotosSection') || el('estimateSection');
      if (!after) return;
      sec = document.createElement('div');
      sec.className = 'section';
      sec.id = 'jobEodSection';
      sec.hidden = true;
      sec.innerHTML = '<div class="section-head"><span class="section-title">End-of-day notes</span></div>' +
        '<div class="section-body" id="jobEodBody"></div>';
      after.insertAdjacentElement('afterend', sec);
    }
    // The owner's from before the live ones, once per job.
    if (jobId && isOwner() && !jobAsked[jobId] && window.YDDb && YDDb.listWhere) {
      const asked = jobAsked[jobId] = jobId;
      Promise.resolve(YDDb.listWhere('endOfDay', 'jobIds', 'array-contains', asked)).then(found => {
        Object.keys(found || {}).forEach(k => { if (!reports[k]) older[k] = Object.assign({ id: k }, found[k]); });
        if (jobId === asked) drawJob();
      }).catch(() => { delete jobAsked[asked]; });
    }
    drawJob();
  }
  function drawJob() {
    const sec = el('jobEodSection'), body = el('jobEodBody');
    if (!sec || !body) return;
    const list = jobId ? Object.values(known()).filter(r => r && r.sentAt && Array.isArray(r.jobIds) && r.jobIds.indexOf(jobId) !== -1)
      .sort((a, b) => String(b.day).localeCompare(String(a.day)) || String(b.sentAt).localeCompare(String(a.sentAt))) : [];
    sec.hidden = !list.length;
    const show = jobShowAll ? list : list.slice(0, 3);
    body.innerHTML = show.map(r => reportHtml(r, { job: jobId })).join('') +
      (list.length > 3 ? '<button type="button" class="link-btn ro-ok" onclick="eodJobAll()">' +
        (jobShowAll ? 'Show fewer' : 'Show all ' + list.length) + '</button>' : '');
  }
  window.eodJobAll = function () { jobShowAll = !jobShowAll; drawJob(); };

  // ------------------------------------------------------------ wiring

  // Everything that shows any of this is told when anything changes.
  let changeTimer = 0;
  function changed() {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      document.dispatchEvent(new CustomEvent('yd-eod'));
      menuItem();
      renderList();
      refreshForm();
      drawJob();
      // The editor only for a change it did not make itself, and never under
      // a box being typed in.
      const s = el('eodSetModal');
      if (s && s.classList.contains('active') && !s.contains(document.activeElement)) renderSettings();
    }, 60);
  }
  function menuItem() {
    const b = el('menuEod');
    if (!b) return;
    const show = signedIn() && (isOwner() || (cfgRead && onList(myUid())));
    b.hidden = !show;
    const n = unread().length;
    b.textContent = '📋 End of day' + (n ? ' (' + n + ')' : '');
  }
  // For the More sheet (app.js): what to call it, or null.
  function menu() {
    if (!signedIn()) return null;
    if (isOwner()) {
      const n = unread().length;
      return { label: '📋 End of day' + (n ? ' (' + n + ')' : ''), hint: 'What the crew sent at the end of each day — and the list itself', call: 'openEodReports()' };
    }
    return cfgRead && onList(myUid())
      ? { label: '📋 End of day', hint: 'Today’s photos, what got done, what’s left, questions for Jonah', call: 'openEndOfDay()' } : null;
  }

  let who = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user ? a.user.uid + ':' + (a.key || a.role) : null;
    if (k === who) return;
    who = k;
    ['eodModal', 'eodListModal', 'eodSetModal'].forEach(id => { const m = el(id); if (m) m.classList.remove('active'); });
    form = null; stopPhotos();
    cfg = null; cfgRead = false; olderAsked = false;
    Object.keys(jobAsked).forEach(x => delete jobAsked[x]);
    if (!k) { stopReports(); changed(); return; }
    watchReports(a);
    loadCfg(true);
    pruneDrafts();
    if (typeof currentJobId !== 'undefined') jobShown(currentJobId);
  });
  // Back in the app (the list may have been changed meanwhile; a new day).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !signedIn()) return;
    loadCfg(true);
    changed();
  });
  // The clock moving (a clock-in, out, a break) changes who has worked today.
  document.addEventListener('yd-clock-changed', changed);

  window.YDEndOfDay = { forMe: forMe, unread: unread, crewToday: crewToday, menu: menu, jobShown: jobShown,
                        items: () => conf().items, onList: onList };
})();
