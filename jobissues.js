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
//              note, materials, equipmentList, works } }
// -- every field there, null when it does not apply, so a later "estimates
// that learn from finished jobs" can read them as they are.
//
// SEVERAL AT ONCE (Jonah, 5 Nov 2026: "i went to note a issue of too much
// material and it wont let me select multiple"; the first ask above was
// already rock AND soil). One note, one buzz, one ✓ Mark handled. About
// several materials, `materials` is the list [{material, supplyId,
// materialKind, unit, planned, amount}], each with its own "how much", and the
// top-level fields are the words for all of them: material "Road gravel,
// Topsoil", amount "Road gravel (12 tons planned): about 3 tons; Topsoil: 1
// yd", supplyId, materialKind, unit and planned null, because no one of them
// speaks for the rest. So anything reading the words needs no change, and
// anything matching a material goes through matsOf here or lessons.mats_of.
// About one material the note is as it always was and `materials` is null,
// and every note from before this reads the same way. equipmentList [names]
// and works [{id, title}] are the same idea, for two or more.
//
// WHERE JONAH SEES THEM. On the job (Job tab, "⚠️ Issues from the crew", with
// ✓ Mark handled), under the matching material on the job's estimate, in
// 📝 Notes from the crew and Home's Waiting on you, and on All Jobs: what
// keeps coming up over the last 12 months, counted in plain code by what
// happened and the kind of material ("Too much material — Decorative rock ·
// 3 jobs"), and the ones not handled yet. The rules let only the owner read
// everyone's; a crew lead sees the ones they sent.
//
// LESSONS (Jonah, 30 Oct 2026: "make it so notes can be added to jobs like
// if we overorderd on material or issues that arised so claude and the crew
// and me can learn and do better on future jobs"). Any issue may say what to
// do next time (issue.nextTime), and "💡 Something to remember next time" is
// a kind of its own -- what worked, what to watch for. Jonah and an admin
// note them on the Job tab of any job that has been worked, a finished one
// too, and Jonah puts any of them right: ✏️ Change, or Remove (deletedAt,
// with Undo -- nobody's note is ever lost). Claude adds its own when a job is
// finished, from the job's daily logs and notes (functions/lessons.py; uid
// 'claude', 🤖 -- no to-do, no buzz). They come back on the next job like
// it: Claude is given the ones that fit a bid it builds (with the finished
// jobs, pastjobs.py), and the page of a booked job shows "💡 Last time on a
// job like this" (jobLessons/{jobId}, made by the server: the crew cannot
// read other jobs or other people's notes).

(function () {
  'use strict';

  // nextPh: what "next time" might say for that kind (a lesson is one already).
  const TYPES = [
    { id: 'over', icon: '📦', name: 'Too much material', mat: true, amountPh: 'e.g. about 3 yd left over',
      nextPh: 'e.g. order 2 yd less mulch for beds this size' },
    { id: 'short', icon: '📉', name: 'Ran short on material', mat: true, amountPh: 'e.g. needed about 2 more tons',
      nextPh: 'e.g. add 10% more base on a sloped yard' },
    { id: 'equipment', icon: '🚜', name: 'Needed equipment we didn’t have', equip: true,
      nextPh: 'e.g. book the dump trailer when there’s sod to haul' },
    { id: 'time', icon: '⏰', name: 'Took longer than planned', work: true, amountPh: 'e.g. about half a day more',
      nextPh: 'e.g. plan half a day more when the soil is clay' },
    { id: 'site', icon: '🚧', name: 'Site problem', needNote: true, notePh: 'e.g. old concrete footing under the bed — had to break it out',
      nextPh: 'e.g. probe the beds for old concrete at the bid' },
    { id: 'lesson', icon: '💡', name: 'Something to remember next time', needNote: true, noNext: true, lesson: true,
      notePh: 'e.g. Black steel edging looked best with the river rock — use it again' },
    { id: 'other', icon: '❓', name: 'Something else', needNote: true },
  ];
  const TYPE = {};
  TYPES.forEach(t => { TYPE[t.id] = t; });
  // What a job most often turns out to need -- a tap each; anything else typed.
  const EQUIPMENT = ['Dump trailer', 'Mini-ex', 'Skid steer', 'Dumpster', 'Another truck'];
  const MAX = { material: 200, equipment: 80, work: 200, amount: 120, note: 1000, next: 400 };
  const TEXT_ABOUT = 430;   // its part of the note's words: with the rest at their longest, the note's 2,000 still holds
  const MAX_MATS = 120;     // as many as a crew copy carries
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

  // One Jonah took off (deletedAt) is gone everywhere -- kept only for Undo.
  function all() { return (window.YDCrewNotes && YDCrewNotes.issues ? YDCrewNotes.issues() : []).filter(n => !n.deletedAt); }
  // Claude's own, from a finished job's logs (functions/lessons.py).
  const isClaude = n => !!n && n.uid === 'claude';
  const newest = (a, b) => String(b.at || '').localeCompare(String(a.at || ''));
  function forJob(id) { return id ? all().filter(n => n.jobId === id).sort(newest) : []; }
  const notesFor = id => (id && window.YDCrewNotes && YDCrewNotes.forJob ? YDCrewNotes.forJob(id) : []);
  function when(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  const kindName = k => (k && window.YDPricing && YDPricing.kindName ? YDPricing.kindName(k) : k) || '';

  // What a note is about, an entry each: its list when it has one, else the
  // one thing on top (about one thing, or from before there were lists).
  function matsOf(i) {
    if (!i) return [];
    if (Array.isArray(i.materials) && i.materials.length) return i.materials;
    return i.material ? [{ material: i.material, supplyId: i.supplyId || null, materialKind: i.materialKind || null,
      unit: i.unit || null, planned: i.planned === undefined ? null : i.planned, amount: i.amount || null }] : [];
  }
  function equipOf(i) {
    if (!i) return [];
    if (Array.isArray(i.equipmentList) && i.equipmentList.length) return i.equipmentList;
    return i.equipment ? [i.equipment] : [];
  }
  function worksOf(i) {
    if (!i) return [];
    if (Array.isArray(i.works) && i.works.length) return i.works;
    return i.work ? [{ id: i.workId || null, title: i.work }] : [];
  }
  const plannedWords = x => (x.planned !== null && x.planned !== undefined && isFinite(x.planned)
    ? fmtNum(x.planned) + (x.unit ? ' ' + x.unit : '') + ' planned' : '');

  // ---------------------------------------------------------- the form
  //
  // draft: { jobId, jobName, mats [{name, supplyId, kind, unit, qty, plant}],
  //          work [{id, title}], type, picks [indexes into mats, as tapped],
  //          typed [what's typed, a box each; empty = Something else is off],
  //          typedWas (those words while it is off), amts {pick's index or
  //          't'+typed index: how much}, equips [names; '' = typed],
  //          equipText, workIds [ids], amount (for took longer), note, next,
  //          editId (✏️ Change: the note's id), orig (its issue as it was) }
  let draft = null;

  function modal(title) {
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
    m.querySelector('h2').textContent = title || '⚠️ Note a job issue';
    m.classList.add('active');
    return m.querySelector('.modal-body');
  }

  // The job's materials and its pieces of work, from its crew copy (or the
  // same parts worked out from the job on the Job tab): each material once.
  function partsOf(parts) {
    const seen = {}, mats = [];
    ((parts && parts.materials) || []).forEach(m => {
      const k = (m && m.supplyId) || keyOf(m && m.name);
      if (!m || !m.name || !k) return;
      const qty = numOr(m.qty), unit = clip(m.unit, 30) || null, had = seen[k];
      // On two lines (topsoil for the beds and the lawn) it is one button
      // with both amounts, or how far over it was reads wrong later.
      if (had) {
        if (had.unit !== unit) had.qty = null;
        else if (had.qty !== null && qty !== null) had.qty = Math.round((had.qty + qty) * 100) / 100;
        return;
      }
      seen[k] = { name: clip(m.name, MAX.material), supplyId: m.supplyId ? safe(m.supplyId) : null,
        kind: m.plant ? 'plant' : clip(m.kind, 40) || null, unit: unit, qty: qty, plant: !!m.plant };
      mats.push(seen[k]);
    });
    const work = ((parts && parts.work) || []).filter(w => w && w.title).slice(0, 30)
      .map((w, i) => ({ id: safe(w.id) || 'w' + i, title: clip(w.title, MAX.work) }));
    return { mats: mats.slice(0, MAX_MATS), work: work };
  }
  // The job's own list, when this device holds the job: the one open on the
  // Job tab, or Jonah's copy of any other. Else nothing, and the note's own
  // materials are what the form has.
  function partsOfJob(id) {
    if (!id || !window.YDCrewJobs || !YDCrewJobs.workParts) return {};
    if (id === jobId && typeof getJobData === 'function') return YDCrewJobs.workParts(getJobData());
    try {
      const raw = typeof readJobBlob === 'function' ? readJobBlob(id) : null;
      return raw ? YDCrewJobs.workParts(JSON.parse(raw)) : {};
    } catch (e) { return {}; }
  }

  function open(jobId, jobName, parts) {
    if (!signedIn() || !jobId) return;
    const p = partsOf(parts);
    draft = blank(jobId, jobName, p);
    draw();
  }
  // No materials to tap on the job: the box to type one is all there is.
  function blank(id, name, p) {
    return { jobId: id, jobName: clip(name, 120), mats: p.mats, work: p.work, type: null, picks: [], typed: p.mats.length ? [] : [''],
             typedWas: [], amts: {}, equips: [], equipText: '', workIds: [], amount: '', note: '', next: '', editId: null, orig: null };
  }
  // ✏️ Change (Jonah): the same form, filled in from the note, with its
  // job's own materials and work to tap when this device holds the job.
  window.jiEdit = function (id) {
    if (!isOwner() || !signedIn()) return;
    const n = all().find(x => x.id === id);
    if (!n) return;
    const i = n.issue || {};
    const p = partsOf(partsOfJob(n.jobId));
    const type = TYPE[i.type] ? i.type : 'other';
    // Whatever the note names stays on the form even when the job isn't open
    // here or has changed since: a button for each, already on, so it keeps
    // its Supplies item and planned amount and can still be tapped off.
    const picks = [], amts = {};
    if (TYPE[type].mat) matsOf(i).forEach(x => {
      let at = p.mats.findIndex(m => (x.supplyId && m.supplyId === x.supplyId) || keyOf(m.name) === keyOf(x.material));
      if (at < 0) {
        at = p.mats.length;
        p.mats.push({ name: clip(x.material, MAX.material), supplyId: x.supplyId ? safe(x.supplyId) : null, kind: x.materialKind || null,
                      unit: x.unit || null, qty: numOr(x.planned), plant: x.materialKind === 'plant' });
      } else {
        // What the note knows and the job's copy doesn't stays with it.
        const m = p.mats[at];
        m.supplyId = m.supplyId || (x.supplyId ? safe(x.supplyId) : null);
        m.kind = m.kind || x.materialKind || null;
        m.unit = m.unit || x.unit || null;
        if (m.qty === null) m.qty = numOr(x.planned);
      }
      if (picks.indexOf(at) === -1) picks.push(at);
      if (x.amount) amts[at] = x.amount;
    });
    const equips = [];
    let equipText = '';
    if (TYPE[type].equip) equipOf(i).forEach(q => {
      if (EQUIPMENT.indexOf(q) !== -1) { equips.push(q); return; }
      if (equips.indexOf('') === -1) equips.push('');
      equipText = equipText ? equipText + ', ' + q : q;
    });
    const workIds = [];
    if (TYPE[type].work) worksOf(i).forEach((w, k) => {
      let at = p.work.find(x => x.id === w.id || keyOf(x.title) === keyOf(w.title));
      if (!at) { at = { id: safe(w.id) || 'was' + k, title: clip(w.title, MAX.work) }; p.work.push(at); }
      if (workIds.indexOf(at.id) === -1) workIds.push(at.id);
    });
    draft = Object.assign(blank(n.jobId, n.jobName, p), { type: type, picks: picks, amts: amts, equips: equips, equipText: equipText, workIds: workIds,
              amount: TYPE[type].work ? i.amount || '' : '', note: i.note || '', next: i.nextTime || '', editId: n.id, orig: i });
    draw();
  };
  // What is typed is read back before the form is drawn again (a tap on a
  // kind or a material redraws it), so nothing typed is lost.
  function keep() {
    if (!draft) return;
    const v = id => { const b = el(id); return b ? b.value : null; };
    [['jiEquipText', 'equipText'], ['jiAmount', 'amount'], ['jiNote', 'note'], ['jiNext', 'next']].forEach(([id, k]) => {
      const got = v(id);
      if (got !== null) draft[k] = got;
    });
    document.querySelectorAll('#issueModal [data-typed]').forEach(b => { draft.typed[+b.dataset.typed] = b.value; });
    document.querySelectorAll('#issueModal [data-amt]').forEach(b => { draft.amts[b.dataset.amt] = b.value; });
  }
  // What's picked so far, in the order tapped, then what's been typed: a
  // "how much" box each.
  function entries() {
    return draft.picks.map(i => ({ key: String(i), name: draft.mats[i].name, m: draft.mats[i] }))
      .concat(draft.typed.map((s, i) => ({ key: 't' + i, name: clip(s, MAX.material), m: null })));
  }
  const pressed = on => ' aria-pressed="' + (on ? 'true' : 'false') + '"';

  function draw() {
    if (!draft) return;
    const body = modal(draft.editId ? '✏️ Change this note' : '⚠️ Note a job issue');
    const t = draft.type ? TYPE[draft.type] : null;
    const btn = (on, call, inner, cls) => '<button type="button" class="ji-btn' + (cls ? ' ' + cls : '') + (on ? ' on' : '') + '"' +
      pressed(on) + ' onclick="' + call + '">' + inner + '</button>';
    let more = '';
    const has = (list, v) => list.indexOf(v) !== -1;
    if (t && t.mat) {
      const many = draft.mats.length > 0;
      more += '<div class="field"><span class="label">' + (many ? 'Which materials? <span class="muted">(tap each one)' +
        (draft.picks.length ? ' · ' + draft.picks.length + ' picked' : '') + '</span>' : 'What material?') + '</span>' +
        (many ? '<div class="ji-grid ji-multi">' +
          draft.mats.map((m, i) => btn(has(draft.picks, i), 'jiMat(' + i + ')', (m.plant ? '🌱 ' : '') + esc(m.name) +
            (m.qty !== null ? '<small>' + esc(fmtNum(m.qty) + (m.unit ? ' ' + m.unit : '')) + ' planned</small>' : ''))).join('') +
          btn(draft.typed.length > 0, 'jiMat(-1)', '✏️ Something else') + '</div>' : '') +
        draft.typed.map((s, i) => '<input class="ji-text" data-typed="' + i + '" maxlength="' + MAX.material +
          '" placeholder="What material — e.g. river rock" oninput="jiTypedName(' + i + ', this.value)" value="' + esc(s) + '">').join('') +
        (draft.typed.length ? '<button type="button" class="btn btn-sm ji-more" onclick="jiMatMore()">+ Another one</button>' : '') +
        '</div>';
      const ents = entries();
      if (ents.length) {
        more += '<div class="field"><span class="label">About how much? <span class="muted">(if you know)</span></span>' +
          ents.map(x => {
            const box = '<input class="ji-text" data-amt="' + x.key + '" maxlength="' + MAX.amount + '" placeholder="' + esc(t.amountPh || '') +
              '" value="' + esc(draft.amts[x.key] || '') + '">';
            return ents.length > 1 ? '<label class="ji-amt"><span data-name="' + x.key + '">' + esc(x.name || 'Something else') + '</span>' + box + '</label>' : box;
          }).join('') + '</div>';
      }
    }
    if (t && t.equip) {
      more += '<div class="field"><span class="label">What did you need? <span class="muted">(tap each one)</span></span><div class="ji-grid ji-multi">' +
        EQUIPMENT.map((q, i) => btn(has(draft.equips, q), 'jiEquip(' + i + ')', esc(q))).join('') +
        btn(has(draft.equips, ''), 'jiEquip(-1)', '✏️ Something else') + '</div>' +
        (has(draft.equips, '') ? '<input id="jiEquipText" class="ji-text" maxlength="' + MAX.equipment + '" placeholder="What — e.g. a plate compactor" value="' + esc(draft.equipText) + '">' : '') +
        '</div>';
    }
    if (t && t.work && draft.work.length) {
      more += '<div class="field"><span class="label">Which work? <span class="muted">(tap each part, if you can say)</span></span><div class="ji-grid ji-multi">' +
        draft.work.map((w, i) => btn(has(draft.workIds, w.id), 'jiWork(' + i + ')', esc(w.title))).join('') + '</div></div>';
    }
    if (t && t.work) {
      more += '<div class="field"><span class="label">About how much? <span class="muted">(if you know)</span></span>' +
        '<input id="jiAmount" class="ji-text" maxlength="' + MAX.amount + '" placeholder="' +
          esc(draft.workIds.length > 1 ? 'e.g. a day on one, half a day on the other' : t.amountPh || '') + '" value="' + esc(draft.amount) + '"></div>';
    }
    if (t) {
      more += '<div class="field"><span class="label">' + (t.lesson ? 'What to remember' : 'Note' + (t.needNote ? '' : ' <span class="muted">(if there’s more to say)</span>')) + '</span>' +
        '<textarea id="jiNote" rows="3" maxlength="' + MAX.note + '" placeholder="' +
          esc(t.notePh || 'e.g. Should have booked a dump trailer — 2 extra trips to the yard') + '">' + esc(draft.note) + '</textarea></div>' +
        // What to do differently: what the next bid and the next crew are
        // shown (functions/lessons.py).
        (t.noNext ? '' : '<div class="field"><span class="label">💡 Next time we should… <span class="muted">(if you know)</span></span>' +
          '<textarea id="jiNext" rows="2" maxlength="' + MAX.next + '" placeholder="' + esc(t.nextPh || 'e.g. ask about it at the bid') + '">' +
          esc(draft.next) + '</textarea></div>') +
        '<div class="hint">' + (draft.editId ? 'The next bid Claude builds and the crew’s next job like it get the changed words.'
          : isOwner() ? 'It is kept on the job, with the ones the crew send — and comes back on the next job like it, for Claude’s bid and the crew.'
          : 'Jonah’s phone gets it, and the next job like it shows it. It saves even with no signal and goes when you have it.') + '</div>' +
        '<div class="field-actions"><button class="btn btn-filled" onclick="jiSend()">' + (draft.editId ? 'Save the change' : isOwner() ? 'Save it' : 'Send to Jonah') + '</button>' +
          // More than one thing went wrong on a job: each is a note of its own.
          (draft.editId ? '' : '<button class="btn btn-sm" onclick="jiSend(true)">' + (isOwner() ? 'Save, add another' : 'Send, add another') + '</button>') +
          '<button class="btn btn-sm" onclick="jiClose()">Cancel</button></div>';
    }
    body.innerHTML = '<div class="ji-job">📐 ' + esc(draft.jobName || 'This job') + '</div>' +
      '<div class="field"><span class="label">What happened?</span><div class="ji-grid ji-kinds">' +
        TYPES.map(x => btn(draft.type === x.id, 'jiType(\'' + x.id + '\')', '<span class="ji-ico">' + x.icon + '</span>' + esc(x.name), 'ji-kind')).join('') +
      '</div></div>' + more;
    // A tap counts as much as a word typed: a stray tap outside the window
    // doesn't lose it (app.js guardWindows; a fresh window starts untouched).
    if (t) el('issueModal').dataset.typed = '1';
  }
  window.jiType = function (id) {
    if (!draft || !TYPE[id]) return;
    keep();
    // What's tapped under another kind stays, in case this tap was the slip;
    // only what the chosen kind asks for is saved.
    draft.type = id;
    draw();
    const focus = TYPE[id].needNote ? el('jiNote') : TYPE[id].mat && !draft.mats.length ? typedBox(0) : null;
    if (focus) focus.focus();
  };
  // A tap puts it on or takes it off; the others stay as they are.
  const toggled = (list, v) => (list.indexOf(v) === -1 ? list.concat([v]) : list.filter(x => x !== v));
  const typedBox = i => document.querySelector('#issueModal [data-typed="' + i + '"]');
  window.jiMat = function (i) {
    if (!draft) return;
    keep();
    if (i === -1) {
      if (draft.typed.length) { draft.typedWas = draft.typed; draft.typed = []; }
      else draft.typed = draft.typedWas.length ? draft.typedWas : [''];
    } else draft.picks = toggled(draft.picks, i);
    draw();
    if (i === -1 && draft.typed.length && typedBox(draft.typed.length - 1)) typedBox(draft.typed.length - 1).focus();
  };
  // The how-much box for what's being typed says so as it is typed.
  window.jiTypedName = function (i, words) {
    const span = document.querySelector('#issueModal [data-name="t' + i + '"]');
    if (span) span.textContent = clip(words, MAX.material) || 'Something else';
  };
  window.jiMatMore = function () {
    if (!draft) return;
    keep();
    draft.typed.push('');
    draw();
    if (typedBox(draft.typed.length - 1)) typedBox(draft.typed.length - 1).focus();
  };
  window.jiEquip = function (i) {
    if (!draft) return;
    keep();
    draft.equips = toggled(draft.equips, i === -1 ? '' : EQUIPMENT[i]);
    draw();
    if (i === -1 && el('jiEquipText')) el('jiEquipText').focus();
  };
  window.jiWork = function (i) {
    if (!draft || !draft.work[i]) return;
    keep();
    draft.workIds = toggled(draft.workIds, draft.work[i].id);
    draw();
  };
  window.jiClose = function () { const m = el('issueModal'); if (m) m.classList.remove('active'); draft = null; };

  window.jiSend = function (again) {
    if (!draft) return;
    keep();
    const t = TYPE[draft.type];
    if (!t) { showToast('Tap what happened first'); return; }
    // Something else tapped with nothing typed beside other picks is a thing
    // they meant to add: asked, not quietly left off.
    const emptyBox = t.mat && draft.mats.length && draft.typed.length && !draft.typed.some(x => clip(x, MAX.material));
    const mats = t.mat && !emptyBox ? entries().filter(x => x.name).map(x => {
      const m = x.m || {};
      return { material: x.name, supplyId: m.supplyId || null, materialKind: m.kind || null, unit: m.unit || null,
               planned: m.qty === null || m.qty === undefined ? null : m.qty, amount: clip(draft.amts[x.key], MAX.amount) || null };
    }) : [];
    if (t.mat && !mats.length) {
      showToast(emptyBox ? 'Type the other material — or tap ✏️ Something else off' : 'Tap the material — or type it');
      if (typedBox(0)) typedBox(0).focus();
      return;
    }
    const typedOn = t.equip && draft.equips.indexOf('') !== -1;
    const typedEquip = typedOn ? clip(draft.equipText, MAX.equipment).split(/\s*,\s*/).filter(Boolean) : [];
    const equips = t.equip ? draft.equips.filter(q => q).concat(typedEquip) : [];
    if (t.equip && (!equips.length || (typedOn && !typedEquip.length))) {
      showToast(equips.length ? 'Type what else you needed — or tap ✏️ Something else off' : 'Tap what you needed — or type it');
      if (el('jiEquipText')) el('jiEquipText').focus();
      return;
    }
    const works = t.work ? draft.workIds.map(id => draft.work.find(x => x.id === id)).filter(Boolean) : [];
    const note = String(draft.note || '').trim().slice(0, MAX.note);
    if (t.needNote && !note) { showToast(t.lesson ? 'Write what to remember' : 'Write what happened'); if (el('jiNote')) el('jiNote').focus(); return; }
    const next = t.noNext ? '' : String(draft.next || '').trim().slice(0, MAX.next);
    const one = mats.length === 1 ? mats[0] : null;
    const manyWords = mats.filter(x => x.amount || plannedWords(x)).map(x => {
      const p = plannedWords(x);
      return x.material + (p ? ' (' + p + ')' : '') + (x.amount ? ': ' + x.amount : '');
    }).join('; ');
    const issue = {
      type: t.id,
      material: mats.map(x => x.material).join(', ') || null,
      supplyId: one ? one.supplyId : null,
      materialKind: one ? one.materialKind : null,
      unit: one ? one.unit : null,
      planned: one ? one.planned : null,
      equipment: equips.join(', ') || null,
      workId: works.length === 1 ? works[0].id : null,
      work: works.map(x => x.title).join(', ') || null,
      amount: (t.mat ? (one ? one.amount : manyWords) : t.work ? clip(draft.amount, MAX.amount) : '') || null,
      note: note || null,
      nextTime: next || null,
      materials: mats.length > 1 ? mats : null,
      equipmentList: equips.length > 1 ? equips : null,
      works: works.length > 1 ? works.map(x => ({ id: x.id, title: x.title })) : null,
    };
    // In words, for the buzz on his phone and the notes list (each puts
    // its own ⚠️ beside it, from `kind`). A long list is cut so the note and
    // next time still fit; the record keeps every one of them.
    const about = clip(t.mat ? mats.map(x => x.material + (x.amount ? ' — ' + x.amount : '')).join(', ')
      : issue.equipment || issue.work || '', TEXT_ABOUT);
    const text = t.name + (about ? ': ' + about : '') + (!t.mat && issue.amount ? ' — ' + issue.amount : '') + (note ? '\n' + note : '') +
      (next ? '\nNext time: ' + next : '');
    if (draft.editId) {
      if (!window.YDCrewNotes || !YDCrewNotes.editIssue || !YDCrewNotes.editIssue(draft.editId, issue, text)) {
        showToast('Not changed — try again in a moment');
        return;
      }
      showToast('Changed');
      window.jiClose();
      return;
    }
    const id = window.YDCrewNotes && YDCrewNotes.sendIssue ? YDCrewNotes.sendIssue(text, draft.jobId, draft.jobName || null, issue) : null;
    if (!id) {
      showToast('Not sent — try again in a moment');
      return;
    }
    // A lesson Jonah notes himself is nothing for him to handle.
    if (t.lesson && isOwner() && typeof id === 'string') YDCrewNotes.handled(id, true);
    const had = draft;
    window.jiClose();
    if (again) {
      draft = blank(had.jobId, had.jobName, { mats: had.mats, work: had.work });
      draw();
      el('issueModal').scrollTop = 0;
    }
  };

  // ------------------------------------------------------- one issue, shown

  function aboutHtml(n) {
    const i = n.issue || {};
    const line = x => {
      const p = plannedWords(x);
      return '<b>' + esc(x.material) + '</b>' + (p ? ' <span class="muted">(' + esc(p) + ')</span>' : '') + (x.amount ? ' — ' + esc(x.amount) : '');
    };
    const mats = matsOf(i);
    if (mats.length > 1) return mats.map(x => '<div>' + line(x) + '</div>').join('');
    if (mats.length) return line(mats[0]);
    const what = i.equipment || i.work || '';
    return (what ? '<b>' + esc(what) + '</b>' : '') + (i.amount ? (what ? ' — ' : '') + esc(i.amount) : '');
  }
  // opts: { job: show its job's name and Open the job }
  function rowHtml(n, opts) {
    const i = n.issue || {}, t = TYPE[i.type] || TYPE.other;
    const about = aboutHtml(n);
    const id = safe(n.id);
    const bot = isClaude(n);
    // A lesson is read, not handled: the word for it says so.
    const done = t.lesson ? 'Seen' : 'Handled';
    return '<div class="ji-row' + (n.readAt ? ' handled' : '') + (t.lesson || bot ? ' lesson' : '') + '">' +
      '<div class="ji-top"><span class="ji-chip">' + t.icon + ' ' + esc(t.name) + '</span>' +
        '<span class="muted">' + (opts && opts.job && n.jobName ? esc(n.jobName) + ' · ' : '') + (bot ? '🤖 Claude' : esc(n.by || 'Someone')) +
          ' · ' + esc(when(n.at)) + (n.editedAt ? ' · changed' : '') + '</span></div>' +
      (about ? '<div class="ji-about">' + about + '</div>' : '') +
      (i.note ? '<div class="ji-note">' + esc(i.note) + '</div>' : '') +
      (i.nextTime ? '<div class="ji-next">💡 Next time: ' + esc(i.nextTime) + '</div>' : '') +
      '<div class="ji-acts">' +
        (isOwner()
          ? (bot ? '<span class="muted">From the job’s daily logs</span>'
            : n.readAt ? '<span class="ji-done">✓ ' + done + '</span><button class="link-btn" onclick="jiHandled(\'' + id + '\', false)">Not ' + done.toLowerCase() + ' after all</button>'
            : '<button class="btn btn-sm" onclick="jiHandled(\'' + id + '\', true)">✓ Mark ' + done.toLowerCase() + '</button>') +
            '<button class="link-btn" onclick="jiEdit(\'' + id + '\')">✏️ Change</button>' +
            '<button class="link-btn" onclick="jiRemove(\'' + id + '\')">Remove</button>' +
            (opts && opts.job && n.jobId ? '<button class="link-btn" onclick="jiOpenJob(\'' + safe(n.jobId) + '\')">Open the job</button>' : '')
          : '<span class="muted">' + (n.readAt ? '✓ Jonah has ' + (t.lesson ? 'seen' : 'handled') + ' it' : 'Not ' + done.toLowerCase() + ' yet') + '</span>') +
      '</div></div>';
  }
  window.jiHandled = function (id, on) {
    if (!isOwner() || !window.YDCrewNotes || !YDCrewNotes.handled) return;
    YDCrewNotes.handled(id, !!on);
    if (on && typeof showUndo === 'function') showUndo('Marked done', () => YDCrewNotes.handled(id, false));
  };
  // Taken off: no bid or crew page gets it again. Undo puts it back.
  window.jiRemove = function (id) {
    if (!isOwner() || !window.YDCrewNotes || !YDCrewNotes.removeIssue) return;
    YDCrewNotes.removeIssue(id, true);
    if (typeof showUndo === 'function') showUndo('Removed', () => YDCrewNotes.removeIssue(id, false));
  };
  window.jiOpenJob = function (jobId) {
    if (typeof openNoteJob !== 'function') return;
    Promise.resolve(openNoteJob(jobId)).then(() => {
      if (window.YDJobView) YDJobView.show('log');
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
        '⚠️ Note a job issue<span class="cj-go-sub">Too much or too little material, equipment we didn’t have, took longer, something to remember next time…</span></button>' +
      (mine.length ? '<div class="ji-list">' + mine.slice(0, 20).map(n => rowHtml(n)).join('') + '</div>'
        : b.preview ? '<p class="hint">The crew lead notes them here; you see them on the Job tab and All Jobs.</p>' : '');
  }

  // ----------------------------------- last time on a job like this
  //
  // The lessons from other jobs that fit this one: jobLessons/{jobId}
  // {items [{id, type, icon, head, planned, amount, note, nextTime, job,
  // town, when, by}], at}, made by the server once an hour for each booked
  // or under-way job (functions/lessons.py) -- no customer, no dollars. Read
  // once a while per job (the phone's own copy when there is no signal).
  const LIKE_FRESH_MS = 10 * 60 * 1000;
  const like = {};            // jobId -> { items, at (read), busy }
  function likeOf(id) { return (id && like[id] && like[id].items) || []; }
  function readLike(id, then) {
    if (!id || !signedIn() || !window.YDDb || !YDDb.get) return;
    const had = like[id];
    // A read already on its way tells every page waiting on it, not only the
    // first: the crew page is drawn again as it opens (a ticket or service
    // arriving), and the box on the new page stayed empty.
    if (had && had.busy) { if (then) had.waiters.push(then); return; }
    if (had && Date.now() - had.at < LIKE_FRESH_MS) return;
    const waiters = then ? [then] : [];
    like[id] = { items: had ? had.items : [], at: Date.now(), busy: true, waiters: waiters };
    Promise.resolve(YDDb.get('jobLessons', id)).then(d => {
      const items = d && Array.isArray(d.items) ? d.items.filter(x => x && (x.head || x.note)).slice(0, 8) : [];
      like[id] = { items: items, at: Date.now(), busy: false, waiters: [] };
      waiters.forEach(f => { try { f(); } catch (e) {} });
    }).catch(() => { like[id] = { items: had ? had.items : [], at: 0, busy: false, waiters: [] }; });
  }
  function likeListHtml(items) {
    return '<div class="ji-list">' + items.map(x => {
      const from = [x.job, x.town, x.when].filter(Boolean).join(' · ');
      return '<div class="ji-row lesson">' +
        '<div class="ji-top"><span class="ji-chip">' + esc(x.icon || '💡') + ' ' + esc(x.head || '') + '</span>' +
          (x.planned ? '<span class="muted">' + esc(x.planned) + '</span>' : '') + '</div>' +
        (x.amount ? '<div class="ji-about">' + esc(x.amount) + '</div>' : '') +
        (x.note ? '<div class="ji-note">' + esc(x.note) + '</div>' : '') +
        (x.nextTime ? '<div class="ji-next">💡 Next time: ' + esc(x.nextTime) + '</div>' : '') +
        (from || x.by ? '<div class="ji-from muted">' + esc(from) + (x.by ? (from ? ' — ' : '') + esc(x.by) : '') + '</div>' : '') +
      '</div>';
    }).join('') + '</div>';
  }
  // The crew's page of a job (crewjobs.js puts the box near its top).
  function mountLike(node, id) {
    if (!node) return;
    const draw = () => {
      if (!node.isConnected) return;
      const items = likeOf(id);
      node.hidden = !items.length;
      node.innerHTML = items.length ? '<div class="cj-h">💡 Last time on a job like this</div>' + likeListHtml(items) : '';
    };
    draw();
    readLike(id, draw);
  }

  // ------------------------------------------------------- the Job tab

  let jobId = null;
  function jobShown(id) {
    jobId = id || null;
    if (!signedIn() || !can('jobs', 'see')) return;
    drawJob();
    readLike(jobId, () => { if (id === jobId) drawJob(); });
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
    const like = likeOf(jobId);
    const plain = notesFor(jobId);
    sec.hidden = !jobId || !signedIn() || !can('jobs', 'see') || (!list.length && !jobIsWorked() && !like.length && !plain.length);
    if (sec.hidden) return;
    const open = list.filter(n => !n.readAt).length;
    if (badge) badge.textContent = open ? open + ' not handled' : '';
    body.innerHTML = (list.length ? '<div class="ji-list">' + list.map(n => rowHtml(n)).join('') + '</div>'
        : '<p class="empty-msg">' + (isOwner() ? 'Nothing noted on this job yet.' : 'You haven’t noted anything on this job.') + '</p>') +
      // The crew's plain notes about it ("📝 Leave a note for Jonah" on the
      // job's page), with who wrote them.
      (plain.length ? '<div class="cj-h" style="margin-top:14px">📝 Notes from the crew</div><div class="ji-list">' +
        plain.map(n => '<div class="ji-row' + (n.readAt ? ' handled' : '') + '"><div class="ji-top"><span class="muted">' +
          esc(n.by || 'Someone') + ' · ' + esc(when(n.at)) + (n.readAt ? ' · read' : '') + '</span></div>' +
          '<div class="ji-note">' + esc(n.text || '') + '</div></div>').join('') + '</div>' : '') +
      (jobIsWorked() ? '<div class="field-actions"><button class="btn btn-sm ro-ok" onclick="jiNew()">⚠️ Note an issue or lesson</button></div>' : '') +
      // What the crew are shown for it from the jobs like it.
      (like.length ? '<div class="cj-h" style="margin-top:14px">💡 Last time on a job like this</div>' + likeListHtml(like) : '');
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
    const same = x => (m.supplyId && x.supplyId && x.supplyId === m.supplyId) || (!!k && keyOf(x.material) === k);
    const hits = [];
    forJob(id).forEach(n => {
      const i = n.issue || {};
      if (i.type !== 'over' && i.type !== 'short') return;
      const x = matsOf(i).find(same);
      if (x) hits.push({ n: n, x: x });
    });
    return hits.length ? '<div class="ji-under">' + hits.map(h => {
      const t = TYPE[h.n.issue.type];
      return '<div>⚠️ ' + esc(t.name) + (h.x.amount ? ' — ' + esc(h.x.amount) : '') +
        ' <span class="muted">· ' + esc(h.n.by || '') + ', ' + esc(when(h.n.at).split(',')[0]) + (h.n.readAt ? ' · handled' : '') + '</span></div>';
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
      // Something to remember is no count of anything going wrong.
      if (t.lesson) return;
      // Each thing the note is about counts as its own, as if noted apart;
      // two of one kind in a note count once.
      const abouts = [];
      if (t.mat) matsOf(i).forEach(x => abouts.push(x.materialKind
        ? { k: t.id + '|k:' + keyOf(x.materialKind), label: kindName(x.materialKind), name: x.material }
        : { k: t.id + '|n:' + keyOf(x.material), label: x.material }));
      else if (t.equip) equipOf(i).forEach(q => abouts.push({ k: t.id + '|e:' + keyOf(q), label: q }));
      if (!abouts.length) abouts.push({ k: t.id, label: '' });
      const counted = {};
      abouts.forEach(a => {
        const g = groups[a.k] || (groups[a.k] = { t: t, label: a.label, jobs: {}, names: {}, n: 0, last: '' });
        if (!counted[a.k]) { counted[a.k] = true; g.n++; }
        if (n.jobId) g.jobs[n.jobId] = n.jobName || 'A job';
        if (a.name) g.names[keyOf(a.name)] = a.name;
        if (String(n.at) > g.last) g.last = String(n.at);
      });
    });
    return Object.values(groups).map(g => Object.assign(g, { jobCount: Object.keys(g.jobs).length }))
      .sort((a, b) => b.jobCount - a.jobCount || b.n - a.n || b.last.localeCompare(a.last));
  }
  let listShowAll = false;
  window.jiListAll = function () { listShowAll = !listShowAll; drawList(); };
  function drawList() {
    const sec = el('crewIssuesSection');
    if (!sec) return;
    const on = signedIn() && isOwner();
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
    open: open, mount: mount, mountLike: mountLike, jobShown: jobShown, matHtml: matHtml,
    // For a later "estimates that learn from finished jobs": every issue
    // this device can read, or one job's, newest first (copies).
    all: () => all().sort(newest), forJob: forJob, patterns: () => patterns(all()),
  };
})();
