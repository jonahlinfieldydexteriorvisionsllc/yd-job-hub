// Issues with a job, noted by the crew lead -- so the next bid is right.
//
// Jonah (26 Oct 2026): "some way for crew lead to note issues with a job. for
// example this ... job we should have booked a dump trailer. the crew was way
// over on rock and soil. So we may also be over calculating rock quantity".
//
// WHERE THEY ARE NOTED. The crew's page for the job (crewjobs.js) has
// "⚠️ Note a job issue" (and ⚠️ Issue on the bar along its foot); the Job tab
// has the same under "Issues from the crew", for an admin crew lead who reads
// jobs there -- and for Jonah, when he is told one on the phone. All taps: what
// happened (too much material, ran short, equipment we didn't have, took
// longer, a site problem, something else), then -- for the material ones --
// which material, from the job's own list on its crew copy (or typed), about
// how much, and a short note.
//
// WHAT IS KEPT. An issue is a note from the crew (crewnotes.js) of its own
// kind -- crewNotes/{cn…} with kind 'issue' -- so it is saved on the phone at
// once, signal or not, buzzes Jonah's phone as a note does (/notes/ping and
// the five-minute reminders run), and needs no security rule of its own:
//   { uid, by, text (the issue in words, for the buzz), jobId, jobName, at,
//     readAt (Jonah has handled it), notifiedAt,
//     kind: 'issue',
//     issue: { type: over|short|equipment|time|site|other,
//              material, supplyId, materialKind, unit, planned (the
//              takeoff's quantity on the crew copy -- the size of the job,
//              before waste), equipment, workId, work (a piece of work, for
//              "took longer"), amount (their words: "about 3 yd over"),
//              note } }
// -- every field there, null when it does not apply, so a later "estimates
// that learn from finished jobs" can read them as they are.
//
// WHERE JONAH SEES THEM. On the job (Job tab, "⚠️ Issues from the crew", with
// ✓ Mark handled), under the matching material on the job's estimate, in
// 📝 Notes from the crew and Home's Waiting on you, and on All Jobs: what
// keeps coming up over the last 12 months, counted in plain code by what
// happened and the kind of material ("Too much material — Decorative rock ·
// 3 jobs"), and the ones not handled yet. The rules let only the owner read
// everyone's; a crew lead sees the ones they sent.

(function () {
  'use strict';

  const TYPES = [
    { id: 'over', icon: '📦', name: 'Too much material', mat: true, amountPh: 'e.g. about 3 yd left over' },
    { id: 'short', icon: '📉', name: 'Ran short on material', mat: true, amountPh: 'e.g. needed about 2 more tons' },
    { id: 'equipment', icon: '🚜', name: 'Needed equipment we didn’t have', equip: true },
    { id: 'time', icon: '⏰', name: 'Took longer than planned', work: true, amountPh: 'e.g. about half a day more' },
    { id: 'site', icon: '🚧', name: 'Site problem', needNote: true, notePh: 'e.g. old concrete footing under the bed — had to break it out' },
    { id: 'other', icon: '❓', name: 'Something else', needNote: true },
  ];
  const TYPE = {};
  TYPES.forEach(t => { TYPE[t.id] = t; });
  // What a job most often turns out to need -- a tap each; anything else typed.
  const EQUIPMENT = ['Dump trailer', 'Mini-ex', 'Skid steer', 'Dumpster', 'Another truck'];
  const MAX = { material: 200, equipment: 80, work: 200, amount: 120, note: 1000 };
  const PATTERN_DAYS = 365;
  const SHOW_OPEN = 10;

  const el = id => document.getElementById(id);
  const safe = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const isOwner = () => !!(window.YDAuth && YDAuth.isOwner);
  const signedIn = () => !!(window.YDAuth && YDAuth.mode === 'cloud' && YDAuth.user);
  const can = (a, l) => typeof ydCan === 'function' && ydCan(a, l);
  const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const keyOf = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const numOr = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
  const fmtNum = q => Number(q).toLocaleString('en-US', { maximumFractionDigits: 2 });

  function all() { return window.YDCrewNotes && YDCrewNotes.issues ? YDCrewNotes.issues() : []; }
  const newest = (a, b) => String(b.at || '').localeCompare(String(a.at || ''));
  function forJob(id) { return id ? all().filter(n => n.jobId === id).sort(newest) : []; }
  function when(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  const kindName = k => (k && window.YDPricing && YDPricing.kindName ? YDPricing.kindName(k) : k) || '';

  // ---------------------------------------------------------- the form
  //
  // draft: { jobId, jobName, mats [{name, supplyId, kind, unit, qty, plant}],
  //          work [{id, title}], type, mat (index | -1 typed | null),
  //          matText, equip (name | '' typed | null), equipText, workId,
  //          amount, note }
  let draft = null;

  function modal() {
    let m = el('issueModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal-overlay';
      m.id = 'issueModal';
      m.onclick = ev => { if (ev.target === m) m.classList.remove('active'); };
      m.innerHTML = '<div class="modal" style="max-width:560px"><div class="modal-head"><h2>⚠️ Note a job issue</h2>' +
        '<button class="modal-close">&times;</button></div><div class="modal-body"></div></div>';
      m.querySelector('.modal-close').onclick = () => m.classList.remove('active');
      document.body.appendChild(m);
    }
    m.classList.add('active');
    return m.querySelector('.modal-body');
  }

  // The job's materials and its pieces of work, from its crew copy (or the
  // same parts worked out from the job on the Job tab): each material once.
  function partsOf(parts) {
    const seen = {};
    const mats = ((parts && parts.materials) || []).filter(m => {
      const k = (m && m.supplyId) || keyOf(m && m.name);
      if (!m || !m.name || !k || seen[k]) return false;
      seen[k] = true;
      return true;
    }).slice(0, 60).map(m => ({ name: clip(m.name, MAX.material), supplyId: m.supplyId ? safe(m.supplyId) : null,
      kind: m.plant ? 'plant' : clip(m.kind, 40) || null, unit: clip(m.unit, 30) || null, qty: numOr(m.qty), plant: !!m.plant }));
    const work = ((parts && parts.work) || []).filter(w => w && w.title).slice(0, 30)
      .map((w, i) => ({ id: safe(w.id) || 'w' + i, title: clip(w.title, MAX.work) }));
    return { mats: mats, work: work };
  }

  function open(jobId, jobName, parts) {
    if (!signedIn() || !jobId) return;
    const p = partsOf(parts);
    draft = { jobId: jobId, jobName: clip(jobName, 120), mats: p.mats, work: p.work, type: null, mat: null, matText: '',
              equip: null, equipText: '', workId: null, amount: '', note: '' };
    draw();
  }
  // What is typed is read back before the form is drawn again (a tap on a
  // kind or a material redraws it), so nothing typed is lost.
  function keep() {
    if (!draft) return;
    const v = id => { const b = el(id); return b ? b.value : null; };
    [['jiMatText', 'matText'], ['jiEquipText', 'equipText'], ['jiAmount', 'amount'], ['jiNote', 'note']].forEach(([id, k]) => {
      const got = v(id);
      if (got !== null) draft[k] = got;
    });
  }
  const pressed = on => ' aria-pressed="' + (on ? 'true' : 'false') + '"';

  function draw() {
    if (!draft) return;
    const body = modal();
    const t = draft.type ? TYPE[draft.type] : null;
    const btn = (on, call, inner, cls) => '<button type="button" class="ji-btn' + (cls ? ' ' + cls : '') + (on ? ' on' : '') + '"' +
      pressed(on) + ' onclick="' + call + '">' + inner + '</button>';
    let more = '';
    if (t && t.mat) {
      more += '<div class="field"><span class="label">Which material?</span><div class="ji-grid">' +
        draft.mats.map((m, i) => btn(draft.mat === i, 'jiMat(' + i + ')', (m.plant ? '🌱 ' : '') + esc(m.name) +
          (m.qty !== null ? '<small>' + esc(fmtNum(m.qty) + (m.unit ? ' ' + m.unit : '')) + ' planned</small>' : ''))).join('') +
        btn(draft.mat === -1, 'jiMat(-1)', '✏️ Something else') + '</div>' +
        (draft.mat === -1 || !draft.mats.length
          ? '<input id="jiMatText" class="ji-text" maxlength="' + MAX.material + '" placeholder="What material — e.g. river rock" value="' + esc(draft.matText) + '">' : '') +
        '</div>';
    }
    if (t && t.equip) {
      more += '<div class="field"><span class="label">What did you need?</span><div class="ji-grid">' +
        EQUIPMENT.map((q, i) => btn(draft.equip === q, 'jiEquip(' + i + ')', esc(q))).join('') +
        btn(draft.equip === '', 'jiEquip(-1)', '✏️ Something else') + '</div>' +
        (draft.equip === '' ? '<input id="jiEquipText" class="ji-text" maxlength="' + MAX.equipment + '" placeholder="What — e.g. a plate compactor" value="' + esc(draft.equipText) + '">' : '') +
        '</div>';
    }
    if (t && t.work && draft.work.length) {
      more += '<div class="field"><span class="label">Which part of the work? <span class="muted">(if it was one)</span></span><div class="ji-grid">' +
        draft.work.map((w, i) => btn(draft.workId === w.id, 'jiWork(' + i + ')', esc(w.title))).join('') + '</div></div>';
    }
    if (t && (t.mat || t.work)) {
      more += '<div class="field"><span class="label">About how much? <span class="muted">(if you know)</span></span>' +
        '<input id="jiAmount" class="ji-text" maxlength="' + MAX.amount + '" placeholder="' + esc(t.amountPh || '') + '" value="' + esc(draft.amount) + '"></div>';
    }
    if (t) {
      more += '<div class="field"><span class="label">Note' + (t.needNote ? '' : ' <span class="muted">(if there’s more to say)</span>') + '</span>' +
        '<textarea id="jiNote" rows="3" maxlength="' + MAX.note + '" placeholder="' +
          esc(t.notePh || 'e.g. Should have booked a dump trailer — 2 extra trips to the yard') + '">' + esc(draft.note) + '</textarea></div>' +
        '<div class="hint">' + (isOwner() ? 'It is kept on the job, with the ones the crew send.'
          : 'Jonah’s phone gets it. It saves even with no signal and goes when you have it.') + '</div>' +
        '<div class="field-actions"><button class="btn btn-filled" onclick="jiSend()">' + (isOwner() ? 'Save it' : 'Send to Jonah') + '</button>' +
          '<button class="btn btn-sm" onclick="jiClose()">Cancel</button></div>';
    }
    body.innerHTML = '<div class="ji-job">📐 ' + esc(draft.jobName || 'This job') + '</div>' +
      '<div class="field"><span class="label">What happened?</span><div class="ji-grid ji-kinds">' +
        TYPES.map(x => btn(draft.type === x.id, 'jiType(\'' + x.id + '\')', '<span class="ji-ico">' + x.icon + '</span>' + esc(x.name), 'ji-kind')).join('') +
      '</div></div>' + more;
  }
  window.jiType = function (id) {
    if (!draft || !TYPE[id]) return;
    keep();
    if (draft.type !== id) { draft.mat = null; draft.equip = null; draft.workId = null; }
    draft.type = id;
    draw();
    const focus = TYPE[id].needNote ? el('jiNote') : null;
    if (focus) focus.focus();
  };
  window.jiMat = function (i) {
    if (!draft) return;
    keep();
    draft.mat = draft.mat === i ? null : i;
    draw();
    if (i === -1 && el('jiMatText')) el('jiMatText').focus();
  };
  window.jiEquip = function (i) {
    if (!draft) return;
    keep();
    const q = i === -1 ? '' : EQUIPMENT[i];
    draft.equip = draft.equip === q ? null : q;
    draw();
    if (i === -1 && el('jiEquipText')) el('jiEquipText').focus();
  };
  window.jiWork = function (i) {
    if (!draft || !draft.work[i]) return;
    keep();
    draft.workId = draft.workId === draft.work[i].id ? null : draft.work[i].id;
    draw();
  };
  window.jiClose = function () { const m = el('issueModal'); if (m) m.classList.remove('active'); draft = null; };

  window.jiSend = function () {
    if (!draft) return;
    keep();
    const t = TYPE[draft.type];
    if (!t) { showToast('Tap what happened first'); return; }
    const m = t.mat && draft.mat !== null && draft.mat >= 0 ? draft.mats[draft.mat] : null;
    const material = t.mat ? (m ? m.name : clip(draft.matText, MAX.material)) : '';
    if (t.mat && !material) { showToast('Tap the material — or type it'); return; }
    const equipment = t.equip ? (draft.equip ? draft.equip : clip(draft.equipText, MAX.equipment)) : '';
    if (t.equip && !equipment) { showToast('Tap what you needed — or type it'); return; }
    const w = t.work ? draft.work.find(x => x.id === draft.workId) : null;
    const amount = t.mat || t.work ? clip(draft.amount, MAX.amount) : '';
    const note = String(draft.note || '').trim().slice(0, MAX.note);
    if (t.needNote && !note) { showToast('Write what happened'); if (el('jiNote')) el('jiNote').focus(); return; }
    const issue = {
      type: t.id,
      material: material || null,
      supplyId: m && m.supplyId ? m.supplyId : null,
      materialKind: m && m.kind ? m.kind : null,
      unit: m && m.unit ? m.unit : null,
      planned: m && m.qty !== null ? m.qty : null,
      equipment: equipment || null,
      workId: w ? w.id : null,
      work: w ? w.title : null,
      amount: amount || null,
      note: note || null,
    };
    // In words, for the buzz on his phone and the notes list (each puts
    // its own ⚠️ beside it, from `kind`).
    const about = material || equipment || (w ? w.title : '');
    const text = t.name + (about ? ': ' + about : '') + (amount ? ' — ' + amount : '') + (note ? '\n' + note : '');
    if (!window.YDCrewNotes || !YDCrewNotes.sendIssue || !YDCrewNotes.sendIssue(text, draft.jobId, draft.jobName || null, issue)) {
      showToast('Not sent — try again in a moment');
      return;
    }
    window.jiClose();
  };

  // ------------------------------------------------------- one issue, shown

  function aboutHtml(n) {
    const i = n.issue || {};
    const what = i.material || i.equipment || i.work || '';
    const planned = i.planned !== null && i.planned !== undefined && isFinite(i.planned)
      ? ' <span class="muted">(' + esc(fmtNum(i.planned) + (i.unit ? ' ' + i.unit : '')) + ' planned)</span>' : '';
    return (what ? '<b>' + esc(what) + '</b>' + planned : '') +
      (i.amount ? (what ? ' — ' : '') + esc(i.amount) : '');
  }
  // opts: { job: show its job's name and Open the job }
  function rowHtml(n, opts) {
    const i = n.issue || {}, t = TYPE[i.type] || TYPE.other;
    const about = aboutHtml(n);
    const id = safe(n.id);
    return '<div class="ji-row' + (n.readAt ? ' handled' : '') + '">' +
      '<div class="ji-top"><span class="ji-chip">' + t.icon + ' ' + esc(t.name) + '</span>' +
        '<span class="muted">' + (opts && opts.job && n.jobName ? esc(n.jobName) + ' · ' : '') + esc(n.by || 'Someone') + ' · ' + esc(when(n.at)) + '</span></div>' +
      (about ? '<div class="ji-about">' + about + '</div>' : '') +
      (i.note ? '<div class="ji-note">' + esc(i.note) + '</div>' : '') +
      '<div class="ji-acts">' +
        (isOwner()
          ? (n.readAt ? '<span class="ji-done">✓ Handled</span><button class="link-btn" onclick="jiHandled(\'' + id + '\', false)">Not handled after all</button>'
            : '<button class="btn btn-sm" onclick="jiHandled(\'' + id + '\', true)">✓ Mark handled</button>') +
            (opts && opts.job && n.jobId ? '<button class="link-btn" onclick="jiOpenJob(\'' + safe(n.jobId) + '\')">Open the job</button>' : '')
          : '<span class="muted">' + (n.readAt ? '✓ Jonah has handled it' : 'Not handled yet') + '</span>') +
      '</div></div>';
  }
  window.jiHandled = function (id, on) {
    if (!isOwner() || !window.YDCrewNotes || !YDCrewNotes.handled) return;
    YDCrewNotes.handled(id, !!on);
    if (on && typeof showUndo === 'function') showUndo('Marked handled', () => YDCrewNotes.handled(id, false));
  };
  window.jiOpenJob = function (jobId) {
    if (typeof openNoteJob !== 'function') return;
    Promise.resolve(openNoteJob(jobId)).then(() => {
      setTimeout(() => { const s = el('jobIssuesSection'); if (s && !s.hidden && s.scrollIntoView) s.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 300);
    });
  };

  // ------------------------------------------------ the crew's job page

  // The page's own section (crewjobs.js puts the box; mounted after each
  // draw): the button, and what this person has noted on this job.
  let crewBox = null;   // { node, jobId, name, parts, preview }
  function mount(node, jobId, j, preview) {
    if (!node) return;
    crewBox = { node: node, jobId: jobId, name: (j && j.name) || '', parts: j || {}, preview: !!preview };
    drawCrew();
  }
  function drawCrew() {
    const b = crewBox;
    if (!b || !b.node || !b.node.isConnected) { crewBox = null; return; }
    const mine = b.preview ? [] : forJob(b.jobId);
    b.node.innerHTML = '<div class="cj-h">⚠️ Job issues</div>' +
      '<button class="btn cj-go-btn ji-big" ' + (b.preview ? 'disabled title="The crew lead’s button"' : 'onclick="cjIssue(\'' + safe(b.jobId) + '\')"') + '>' +
        '⚠️ Note a job issue<span class="cj-go-sub">Too much or too little material, equipment we didn’t have, took longer…</span></button>' +
      (mine.length ? '<div class="ji-list">' + mine.slice(0, 20).map(n => rowHtml(n)).join('') + '</div>'
        : b.preview ? '<p class="hint">The crew lead notes them here; you see them on the Job tab and All Jobs.</p>' : '');
  }

  // ------------------------------------------------------- the Job tab

  let jobId = null;
  function jobShown(id) {
    jobId = id || null;
    if (!signedIn() || !can('jobs', 'see')) return;
    let sec = el('jobIssuesSection');
    if (!sec) {
      const after = el('jobEodSection') || el('jobSigsSection') || el('jobPhotosSection') || el('estimateSection');
      if (!after) return;
      sec = document.createElement('div');
      sec.className = 'section';
      sec.id = 'jobIssuesSection';
      sec.hidden = true;
      sec.innerHTML = '<div class="section-head"><span class="section-title">⚠️ Issues from the crew</span>' +
        '<span class="section-badge" id="jobIssuesBadge"></span></div><div class="section-body" id="jobIssuesBody"></div>';
      after.insertAdjacentElement('afterend', sec);
    }
    drawJob();
  }
  // A bid has not been worked: nothing to note, unless one was.
  function jobIsWorked() {
    if (typeof jobStatus === 'undefined' || typeof normStatus !== 'function') return false;
    return normStatus(jobStatus) !== 'quoting';
  }
  function drawJob() {
    const sec = el('jobIssuesSection'), body = el('jobIssuesBody'), badge = el('jobIssuesBadge');
    if (!sec || !body) return;
    const list = forJob(jobId);
    sec.hidden = !jobId || !signedIn() || !can('jobs', 'see') || (!list.length && !jobIsWorked());
    if (sec.hidden) return;
    const open = list.filter(n => !n.readAt).length;
    if (badge) badge.textContent = open ? open + ' not handled' : '';
    body.innerHTML = (list.length ? '<div class="ji-list">' + list.map(n => rowHtml(n)).join('') + '</div>'
        : '<p class="empty-msg">' + (isOwner() ? 'Nothing from the crew on this job.' : 'You haven’t noted anything on this job.') + '</p>') +
      '<div class="field-actions"><button class="btn btn-sm ro-ok" onclick="jiNew()">⚠️ Note an issue</button></div>';
  }
  window.jiNew = function () {
    if (!jobId || typeof getJobData !== 'function') return;
    const d = getJobData();
    const parts = window.YDCrewJobs && YDCrewJobs.workParts ? YDCrewJobs.workParts(d) : {};
    open(jobId, String(d.customerName || '').trim() || 'This job', parts);
  };

  // Under a material on the job's estimate: what the crew said about it
  // (the matching material -- the same Supplies item, else the same name).
  function matHtml(id, m) {
    if (!id || !m) return '';
    const k = keyOf(m.name);
    const hits = forJob(id).filter(n => {
      const i = n.issue || {};
      if (i.type !== 'over' && i.type !== 'short') return false;
      return (m.supplyId && i.supplyId && i.supplyId === m.supplyId) || (!!k && keyOf(i.material) === k);
    });
    return hits.length ? '<div class="ji-under">' + hits.map(n => {
      const t = TYPE[n.issue.type];
      return '<div>⚠️ ' + esc(t.name) + (n.issue.amount ? ' — ' + esc(n.issue.amount) : '') +
        ' <span class="muted">· ' + esc(n.by || '') + ', ' + esc(when(n.at).split(',')[0]) + (n.readAt ? ' · handled' : '') + '</span></div>';
    }).join('') + '</div>' : '';
  }

  // ------------------------------------------------- All Jobs: patterns

  // What keeps coming up: the last 12 months' issues counted by what
  // happened and what it was about -- the kind of material when known (so
  // red granite and river rock both count as decorative rock), else the
  // material or the equipment by name. Plain counting, no Claude.
  function patterns(list) {
    const since = Date.now() - PATTERN_DAYS * 86400000;
    const groups = {};
    list.forEach(n => {
      const i = n.issue || {};
      if (!(Date.parse(n.at) >= since)) return;
      const t = TYPE[i.type] || TYPE.other;
      let k = t.id, label = '';
      if (t.mat && i.materialKind) { k += '|k:' + keyOf(i.materialKind); label = kindName(i.materialKind); }
      else if (t.mat && i.material) { k += '|n:' + keyOf(i.material); label = i.material; }
      else if (t.equip && i.equipment) { k += '|e:' + keyOf(i.equipment); label = i.equipment; }
      const g = groups[k] || (groups[k] = { t: t, label: label, jobs: {}, names: {}, n: 0, last: '' });
      g.n++;
      if (n.jobId) g.jobs[n.jobId] = n.jobName || 'A job';
      if (t.mat && i.materialKind && i.material) g.names[keyOf(i.material)] = i.material;
      if (String(n.at) > g.last) g.last = String(n.at);
    });
    return Object.values(groups).map(g => Object.assign(g, { jobCount: Object.keys(g.jobs).length }))
      .sort((a, b) => b.jobCount - a.jobCount || b.n - a.n || b.last.localeCompare(a.last));
  }
  let listShowAll = false;
  window.jiListAll = function () { listShowAll = !listShowAll; drawList(); };
  function drawList() {
    let sec = el('crewIssuesSection');
    const on = signedIn() && isOwner();
    if (!sec) {
      if (!on) return;
      const after = el('evaListSection') || el('dashTableWrap');
      const at = after && (after.id === 'evaListSection' ? after : after.closest('.section'));
      if (!at) return;
      sec = document.createElement('div');
      sec.className = 'section';
      sec.id = 'crewIssuesSection';
      sec.innerHTML = '<div class="section-head"><span class="section-title">⚠️ Issues from the crew — across jobs</span>' +
        '<span class="section-badge" id="crewIssuesBadge"></span></div><div class="section-body" id="crewIssuesBody"></div>';
      at.insertAdjacentElement('afterend', sec);
    }
    sec.hidden = !on;
    if (!on) return;
    const body = el('crewIssuesBody'), badge = el('crewIssuesBadge');
    const list = all().sort(newest);
    const open = list.filter(n => !n.readAt);
    if (badge) badge.textContent = open.length ? open.length + ' not handled' : '';
    if (!list.length) {
      body.innerHTML = '<p class="empty-msg">' + (window.YDCrewNotes && YDCrewNotes.loaded && !YDCrewNotes.loaded() ? 'Loading…'
        : 'No issues from the crew yet. The crew lead notes one on the job’s page (⚠️ Issue).') + '</p>';
      return;
    }
    const pats = patterns(list);
    const shown = listShowAll ? open : open.slice(0, SHOW_OPEN);
    body.innerHTML =
      (pats.length ? '<div class="cj-h">What keeps coming up — the last 12 months</div><div class="ji-pats">' + pats.slice(0, 12).map(g => {
        const jobs = Object.values(g.jobs);
        const names = Object.values(g.names);
        return '<div class="ji-pat' + (g.jobCount > 1 ? ' many' : '') + '"><span class="ji-pat-n">' + g.jobCount + (g.jobCount === 1 ? ' job' : ' jobs') + '</span>' +
          '<span class="ji-pat-t">' + g.t.icon + ' ' + esc(g.t.name) + (g.label ? ' — <b>' + esc(g.label) + '</b>' : '') +
            (names.length > 1 || (names.length === 1 && keyOf(names[0]) !== keyOf(g.label)) ? ' <span class="muted">(' + esc(names.slice(0, 4).join(', ')) + ')</span>' : '') +
            '<small>' + esc(jobs.slice(0, 5).join(' · ')) + (jobs.length > 5 ? ' · ' + (jobs.length - 5) + ' more' : '') + '</small></span></div>';
      }).join('') + '</div>' : '') +
      '<div class="cj-h" style="margin-top:14px">Not handled yet' + (open.length ? ' (' + open.length + ')' : '') + '</div>' +
      (open.length ? '<div class="ji-list">' + shown.map(n => rowHtml(n, { job: true })).join('') + '</div>' +
          (open.length > SHOW_OPEN ? '<button class="link-btn" onclick="jiListAll()">' + (listShowAll ? 'Show fewer' : 'Show all ' + open.length) + '</button>' : '')
        : '<p class="empty-msg">All handled.</p>');
  }

  // ----------------------------------------------------------- wiring

  // The estimate shows them under its materials (estimate.js): told when
  // the open job's change.
  let jobSig = '';
  function changed() {
    drawCrew();
    drawJob();
    drawList();
    const sig = JSON.stringify(forJob(jobId).map(n => [n.id, !!n.readAt]));
    if (sig !== jobSig) { jobSig = sig; document.dispatchEvent(new CustomEvent('yd-job-issues', { detail: { jobId: jobId } })); }
  }
  document.addEventListener('yd-crew-notes', changed);
  // A bid booked on the form (its status changed and was saved): the
  // section comes.
  document.addEventListener('yd-jobs-changed', drawJob);
  document.addEventListener('yd-auth', () => {
    if (typeof currentJobId !== 'undefined') jobShown(currentJobId); else drawJob();
    drawList();
  });

  window.YDJobIssues = {
    TYPES: TYPES.map(t => ({ id: t.id, icon: t.icon, name: t.name })),
    open: open, mount: mount, jobShown: jobShown, matHtml: matHtml,
    // For a later "estimates that learn from finished jobs": every issue
    // this device can read, or one job's, newest first (copies).
    all: () => all().sort(newest), forJob: forJob, patterns: () => patterns(all()),
  };
})();
