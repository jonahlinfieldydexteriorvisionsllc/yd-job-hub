// How long each piece of work took -- the crew's production log.
//
// Jonah (22-23 Oct 2026): "figure out a way to implement something so my
// crew lead can track what each specific thing we do takes time-wise ...
// '200LF of wood edging installed in ___ amount of time'". Then: "i want it
// to be detailed. I want info on how long, how many guys, what was done, if
// it was moving soil or other materials how far were they moved. If it was
// installing edging how many LF. This needs to be detailed because 2
// dedicated years of this level of tracking would lead to estimates that
// can fully build themselves."
//
// So each entry says: what was done (a kind of task, from a fixed list, so
// the numbers can be added up across jobs -- and the job's own line), how
// much (a number and its unit: LF, sq ft, cu yd...), how long (hours on the
// clock) and how many people (so man-hours), for moving material what it
// was, how far and how (wheelbarrow, skid steer...), and what the site was
// like (tight access, slope, rocky...) -- the things that make the same
// work take twice as long. Everything is a tap except the numbers.
//
// Asked when a piece of work is ticked done on the crew's page
// (workdone.js), with Skip; and "⏱ Log time" under any piece, for a day's
// part of a long one (100 of 200 LF on Monday). Anyone on the crew may log;
// it is theirs to change or delete, the owner's too.
//
// Stored in productionLog/{pl…} (firestore.rules): the crew read their own,
// whoever sees jobs reads them all. All Jobs → "⏱ How long things take"
// adds them up: for each kind of task and unit, how much per man-hour,
// over how many jobs -- the figure an estimate's crew-days can come from.

(function () {
  'use strict';

  const PATH = 'productionLog';
  const el = id => document.getElementById(id);
  const esc2 = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s));
  const safe = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const signedIn = () => !!(window.YDAuth && YDAuth.mode === 'cloud' && YDAuth.user);
  const seesJobs = () => typeof ydCan === 'function' && ydCan('jobs', 'see');

  // The kinds of task. `unit`: the one it is usually counted in (picked
  // first, changeable); `moves`: material is moved, so how far and how is
  // asked. Ids are kept for good -- the totals add up by them.
  const TASKS = [
    { id: 'dig', name: '⛏ Dig / excavate', unit: 'cu yd', moves: true },
    { id: 'move', name: '🚜 Move material', unit: 'cu yd', moves: true },
    { id: 'haul', name: '🚛 Haul away / dump', unit: 'cu yd', moves: true },
    { id: 'grade', name: '📐 Grade', unit: 'sq ft' },
    { id: 'base', name: '🪨 Base & compact', unit: 'sq ft', moves: true },
    { id: 'pavers', name: '🧱 Lay pavers', unit: 'sq ft' },
    { id: 'wall', name: '🧱 Build wall', unit: 'face sq ft' },
    { id: 'edging', name: '〰 Install edging', unit: 'LF' },
    { id: 'spread', name: '🟤 Spread mulch / rock', unit: 'cu yd', moves: true },
    { id: 'plant', name: '🌱 Plant', unit: 'each' },
    { id: 'sod', name: '🟩 Sod / seed', unit: 'sq ft' },
    { id: 'drain', name: '💧 Drainage', unit: 'LF' },
    { id: 'turf', name: '🟩 Artificial turf', unit: 'sq ft' },
    { id: 'clean', name: '🧹 Clean up', unit: '' },
    { id: 'other', name: '… Something else', unit: '' },
  ];
  const UNITS = ['LF', 'sq ft', 'face sq ft', 'cu yd', 'tons', 'each', 'bags'];
  const HOW = ['Wheelbarrow', 'By hand / buckets', 'Skid steer', 'Mini-ex', 'Tractor', 'Truck / trailer'];
  const SITE = ['Easy', 'Tight access', 'Slope', 'Rocky', 'Clay / wet', 'Roots', 'Steps'];
  const PEOPLE = [1, 2, 3, 4, 5, 6];
  const taskOf = id => TASKS.find(t => t.id === id) || null;

  let logs = {};              // id -> entry
  let unsub = null, key = null;
  let form = null;            // the entry being filled in

  // A first guess at the kind of task from the work's own words, so most
  // times it is already lit.
  const GUESS = [
    [/edg/i, 'edging'], [/paver|patio|walkway|walk\b/i, 'pavers'], [/wall|retaining|seat/i, 'wall'],
    [/drain|downspout|french|catch basin|channel/i, 'drain'], [/turf/i, 'turf'], [/sod|seed|lawn/i, 'sod'],
    [/plant|tree|shrub|perennial/i, 'plant'], [/mulch|rock|stone bed|river rock/i, 'spread'],
    [/grad/i, 'grade'], [/excavat|dig|remov|demo/i, 'dig'], [/haul|dump/i, 'haul'], [/clean/i, 'clean'],
  ];
  const guess = title => (GUESS.find(g => g[0].test(String(title || ''))) || [null, ''])[1];

  // ------------------------------------------------ the form

  function me() {
    const r = window.YDRemind && YDRemind.me ? YDRemind.me() : null;
    const u = (window.YDAuth && YDAuth.user) || {};
    return { uid: u.uid || '', name: String((r && r.name) || u.displayName || u.email || 'Someone').slice(0, 80) };
  }
  function modal(title) {
    let m = el('plModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal-overlay';
      m.id = 'plModal';
      m.setAttribute('data-autosave', '');
      m.innerHTML = '<div class="modal" style="max-width:560px"><div class="modal-head"><h2></h2>' +
        '<button class="modal-close" onclick="plClose()">&times;</button></div><div class="modal-body" id="plBody"></div></div>';
      document.body.appendChild(m);
    }
    m.querySelector('h2').textContent = title;
    m.classList.add('active');
    return el('plBody');
  }
  window.plClose = function () { const m = el('plModal'); if (m) m.classList.remove('active'); form = null; };

  // Open the form for a piece of work. `done`: it was just ticked done (the
  // form then says so, and Skip closes it).
  function ask(jobId, lineId, title, opts) {
    if (!signedIn()) return;
    opts = opts || {};
    const was = opts.entry || null;
    const t = was ? was.task : guess(title);
    form = was ? Object.assign({}, was, { conditions: (was.conditions || []).slice() }) : {
      jobId: jobId, jobName: opts.jobName || (window.YDWorkDone && YDWorkDone.jobName ? YDWorkDone.jobName(jobId) : ''),
      lineId: lineId || '', lineTitle: String(title || '').slice(0, 200),
      task: t, unit: (taskOf(t) || {}).unit || '', qty: null, hours: null, people: null,
      material: '', distanceFt: null, moveHow: '', conditions: [], notes: '',
    };
    form.id = was ? was.id : null;
    form.justDone = !!opts.done;
    draw();
  }
  function chips(list, on, call, label) {
    return list.map(v => {
      const id = typeof v === 'object' ? v.id : v;
      const name = typeof v === 'object' ? v.name : (label ? label(v) : v);
      const lit = Array.isArray(on) ? on.indexOf(id) !== -1 : on === id;
      return '<button type="button" class="pl-chip' + (lit ? ' on' : '') + '" aria-pressed="' + lit + '" ' +
        'onclick="' + call + '(this.dataset.v)" data-v="' + esc2(id) + '">' + esc2(name) + '</button>';
    }).join('');
  }
  function draw() {
    if (!form) return;
    const t = taskOf(form.task);
    const body = modal(form.id ? 'Change this entry' : '⏱ How long did it take?');
    const num = (id, val, ph, step) => '<input type="number" inputmode="decimal" min="0" step="' + (step || 'any') + '" id="' + id + '"' +
      ' value="' + (val == null ? '' : esc2(val)) + '" placeholder="' + esc2(ph) + '" oninput="plNum(this)">';
    body.innerHTML =
      (form.justDone ? '<div class="hint pl-done">✅ ' + esc2(form.lineTitle || 'That') + ' is ticked done. Log how it went — these add up, job after job, ' +
        'into how long each kind of work really takes.</div>' : '') +
      '<div class="field"><span class="label">What was done</span><div class="pl-chips pl-tasks">' + chips(TASKS, form.task, 'plTask') + '</div>' +
        (form.lineTitle ? '<div class="hint">On this job: ' + esc2(form.lineTitle) + '</div>' : '') + '</div>' +
      '<div class="field"><span class="label">How much' + (t && t.unit ? '' : ' (if it can be counted)') + '</span>' +
        '<div class="pl-row">' + num('plQty', form.qty, 'e.g. 200') + '</div>' +
        '<div class="pl-chips">' + chips(UNITS, form.unit, 'plUnit') + '</div></div>' +
      '<div class="field"><span class="label">How long — hours on site for it</span>' +
        '<div class="pl-row">' + num('plHours', form.hours, 'e.g. 3.5', '0.25') + '</div></div>' +
      '<div class="field"><span class="label">How many people on it</span><div class="pl-chips">' +
        chips(PEOPLE, form.people, 'plPeople', n => n === 6 ? '6+' : String(n)) + '</div>' +
        '<div class="hint" id="plMan">' + manWords() + '</div></div>' +
      (t && t.moves ?
        '<div class="field pl-move"><span class="label">Moving material — what, how far, how</span>' +
          '<input id="plMaterial" value="' + esc2(form.material || '') + '" placeholder="e.g. topsoil, road gravel, pavers" oninput="plText(this)">' +
          '<div class="pl-row">' + num('plDist', form.distanceFt, 'how far, in feet', '5') + '<span class="pl-unit">ft, one way</span></div>' +
          '<div class="pl-chips">' + chips(HOW, form.moveHow, 'plHow') + '</div></div>' : '') +
      '<div class="field"><span class="label">The site</span><div class="pl-chips">' + chips(SITE, form.conditions, 'plSite') + '</div></div>' +
      '<div class="field"><span class="label">Anything else (optional)</span>' +
        '<textarea id="plNotes" rows="2" placeholder="e.g. hit a big root, waited an hour on the gravel" oninput="plText(this)">' + esc2(form.notes || '') + '</textarea></div>' +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="plSave()">Save</button>' +
        '<button class="btn" onclick="plClose()">' + (form.justDone ? 'Skip' : 'Cancel') + '</button>' +
        (form.id ? '<button class="btn btn-sm" onclick="plDelete()">🗑 Delete</button>' : '') +
      '</div>';
  }
  function manWords() {
    const h = Number(form && form.hours), p = Number(form && form.people);
    if (!(h > 0) || !(p > 0)) return '';
    const mh = Math.round(h * p * 100) / 100;
    const q = Number(form.qty);
    return mh + ' man-hours' + (q > 0 && form.unit ? ' · ' + (Math.round(q / mh * 10) / 10) + ' ' + form.unit + ' per man-hour' : '');
  }
  window.plTask = function (id) {
    if (!form || !taskOf(id)) return;
    readBoxes();
    const was = taskOf(form.task);
    form.task = id;
    // The unit follows the task until one is tapped.
    if (!form.unitPicked || !form.unit) form.unit = taskOf(id).unit || (was ? form.unit : '');
    draw();
  };
  window.plUnit = function (u) { if (!form) return; readBoxes(); form.unit = form.unit === u ? '' : u; form.unitPicked = true; draw(); };
  window.plPeople = function (n) { if (!form) return; readBoxes(); form.people = Number(n) || null; draw(); };
  window.plHow = function (h) { if (!form) return; readBoxes(); form.moveHow = form.moveHow === h ? '' : h; draw(); };
  window.plSite = function (s) {
    if (!form) return;
    readBoxes();
    const i = form.conditions.indexOf(s);
    if (i === -1) form.conditions.push(s); else form.conditions.splice(i, 1);
    draw();
  };
  window.plNum = function () { readBoxes(); const m = el('plMan'); if (m) m.textContent = manWords(); };
  window.plText = function () { readBoxes(); };
  function readBoxes() {
    if (!form) return;
    const n = id => { const b = el(id); if (!b) return undefined; const v = parseFloat(b.value); return isFinite(v) && v >= 0 ? v : null; };
    const q = n('plQty'), h = n('plHours'), d = n('plDist');
    if (q !== undefined) form.qty = q;
    if (h !== undefined) form.hours = h;
    if (d !== undefined) form.distanceFt = d;
    if (el('plMaterial')) form.material = el('plMaterial').value.slice(0, 120);
    if (el('plNotes')) form.notes = el('plNotes').value.slice(0, 1000);
  }

  window.plSave = function () {
    if (!form || !window.YDDb) return;
    readBoxes();
    if (!form.task) { showToast('Tap what was done'); return; }
    if (!(form.hours > 0) || form.hours > 24) { showToast('Put in how many hours it took'); return; }
    if (!form.people) { showToast('Tap how many people were on it'); return; }
    const who = me();
    const t = taskOf(form.task) || {};
    const at = new Date().toISOString();
    const id = form.id || 'pl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const was = logs[id] || {};
    const rec = {
      jobId: safe(form.jobId) || null, jobName: String(form.jobName || '').slice(0, 120),
      lineId: safe(form.lineId) || null, lineTitle: String(form.lineTitle || '').slice(0, 200),
      task: form.task, unit: form.unit || '', qty: form.qty > 0 ? form.qty : null,
      hours: Math.round(form.hours * 100) / 100, people: Math.min(20, Math.max(1, Math.round(form.people))),
      manHours: Math.round(form.hours * form.people * 100) / 100,
      material: t.moves ? String(form.material || '').trim() : '', distanceFt: t.moves && form.distanceFt > 0 ? form.distanceFt : null,
      moveHow: t.moves ? form.moveHow || '' : '', conditions: form.conditions.slice(0, 10), notes: String(form.notes || '').trim(),
      uid: was.uid || who.uid, by: was.by || who.name, at: was.at || at, updatedAt: at,
      day: was.day || (typeof localYMD === 'function' ? localYMD(new Date()) : at.slice(0, 10)),
    };
    logs[id] = Object.assign({ id: id }, rec);
    // Never awaited: with no signal it waits on the phone and goes when it can.
    Promise.resolve(window.YDDb.put(PATH, id, rec)).catch(e => {
      showToast(e && e.code === 'permission-denied' ? 'Not saved — not allowed' : 'Saved on this phone — it goes up when there is signal');
    });
    plClose();
    showToast('⏱ Logged — ' + rec.manHours + ' man-hours' + (rec.qty ? ' for ' + rec.qty + ' ' + rec.unit : ''));
    changed();
  };
  window.plDelete = async function () {
    if (!form || !form.id || !window.YDDb) return;
    if (typeof ydConfirm === 'function' && !(await ydConfirm('', { title: 'Delete this entry?', ok: 'Delete', danger: true }))) return;
    const id = form.id;
    delete logs[id];
    Promise.resolve(window.YDDb.remove(PATH, id)).catch(() => showToast('Not deleted — not allowed'));
    plClose();
    changed();
  };
  window.plOpen = function (id) { const e = logs[id]; if (e) ask(e.jobId, e.lineId, e.lineTitle, { entry: e }); };
  // From a button on the crew's page (workdone.js): the piece of work it is under.
  window.plLog = function (b) {
    const box = b && b.closest('[data-wd]');
    if (!box) return;
    const [id, line] = String(box.dataset.wd).split('|');
    ask(id, line, box.dataset.t || '');
  };

  // Entries for one piece of work (the crew's page shows how many).
  const forLine = (jobId, lineId) => Object.values(logs).filter(e => e.jobId === jobId && e.lineId === lineId);

  // ------------------------------------------------ adding them up
  //
  // For each kind of task and unit: how much was done in how many
  // man-hours, over how many jobs -- and so how much per man-hour. Entries
  // with no amount still count their man-hours (Clean up has none).
  function totals() {
    const g = {};
    Object.values(logs).forEach(e => {
      if (!e || !e.task) return;
      const k = e.task + '|' + (e.qty > 0 ? e.unit || '' : '');
      const t = g[k] || (g[k] = { task: e.task, unit: e.qty > 0 ? e.unit || '' : '', qty: 0, manHours: 0, n: 0, jobs: new Set(), dist: [], list: [] });
      t.qty += e.qty > 0 ? Number(e.qty) : 0;
      t.manHours += Number(e.manHours) || 0;
      t.n++;
      if (e.jobId) t.jobs.add(e.jobId);
      if (e.distanceFt > 0) t.dist.push(Number(e.distanceFt));
      t.list.push(e);
    });
    return Object.values(g).sort((a, b) => b.manHours - a.manHours);
  }
  let openGroup = '';
  function render() {
    const sec = el('prodSection'), wrap = el('prodWrap');
    if (!sec || !wrap) return;
    sec.hidden = !seesJobs();
    if (!seesJobs()) return;
    const all = totals();
    if (!all.length) {
      wrap.innerHTML = '<p class="empty-msg" style="margin-top:0">Nothing logged yet. When the crew tick a piece of work done on a job, ' +
        'they are asked how long it took, how many were on it, how much got done and, for moving material, how far. ' +
        'Job after job it adds up here into how long each kind of work really takes.</p>';
      return;
    }
    wrap.innerHTML = '<div class="table-wrap"><table class="pl-table"><thead><tr><th>Work</th><th>Done</th><th>Man-hours</th>' +
      '<th>Per man-hour</th><th>Jobs</th><th>Moved (avg ft)</th></tr></thead><tbody>' +
      all.map(t => {
        const k = t.task + '|' + t.unit;
        const rate = t.qty > 0 && t.manHours > 0 ? (Math.round(t.qty / t.manHours * 10) / 10) + ' ' + t.unit : '—';
        const avg = t.dist.length ? Math.round(t.dist.reduce((a, b) => a + b, 0) / t.dist.length) : '';
        return '<tr class="pl-grow" onclick="plGroup(this.dataset.k)" data-k="' + esc2(k) + '"><td>' + esc2((taskOf(t.task) || {}).name || t.task) + '</td>' +
          '<td>' + (t.qty > 0 ? esc2(Math.round(t.qty * 10) / 10 + ' ' + t.unit) : '—') + '</td>' +
          '<td>' + esc2(Math.round(t.manHours * 10) / 10) + '</td><td><b>' + esc2(rate) + '</b></td>' +
          '<td>' + t.jobs.size + '</td><td>' + esc2(avg) + '</td></tr>' +
          (openGroup === k ? '<tr><td colspan="6">' + t.list.sort((a, b) => String(b.at).localeCompare(String(a.at))).map(entryHtml).join('') + '</td></tr>' : '');
      }).join('') + '</tbody></table></div>' +
      '<div class="hint">Tap a row for each entry. "Per man-hour" = how much one person gets done in an hour, over every entry so far.</div>';
  }
  function entryHtml(e) {
    const bits = [e.qty > 0 ? e.qty + ' ' + e.unit : '', e.hours + ' h × ' + e.people + (e.people === 1 ? ' person' : ' people'),
      e.distanceFt ? (e.material ? e.material + ' ' : '') + e.distanceFt + ' ft' + (e.moveHow ? ' by ' + e.moveHow.toLowerCase() : '') : '',
      (e.conditions || []).join(', ')].filter(Boolean);
    return '<div class="pl-entry"><button class="link-btn" onclick="plOpen(\'' + safe(e.id) + '\')">' + esc2(e.jobName || 'A job') + '</button> · ' +
      esc2(e.day || '') + ' · ' + esc2(String(e.by || '').split(' ')[0]) + '<br><small>' + esc2(bits.join(' · ')) +
      (e.lineTitle ? ' — ' + esc2(e.lineTitle) : '') + (e.notes ? ' — “' + esc2(e.notes) + '”' : '') + '</small></div>';
  }
  window.plGroup = function (k) { openGroup = openGroup === k ? '' : k; render(); };

  // ------------------------------------------------ watching
  let tellTimer = 0;
  function changed() {
    render();
    clearTimeout(tellTimer);
    tellTimer = setTimeout(() => document.dispatchEvent(new CustomEvent('yd-production')), 60);
  }
  function stop() { if (unsub) { try { unsub(); } catch (e) {} } unsub = null; logs = {}; }
  function start(a) {
    stop();
    if (!window.YDDb || !a.user || a.mode !== 'cloud') return;
    const take = list => {
      (list || []).forEach(c => {
        if (!c || !c.id) return;
        if (c.type === 'removed') delete logs[c.id]; else logs[c.id] = Object.assign({ id: c.id }, c.data);
      });
      changed();
    };
    // Whoever sees jobs reads them all; anyone else only their own (the
    // rules refuse a question that could include someone else's).
    unsub = seesJobs() ? window.YDDb.watch(PATH, take, () => {})
      : window.YDDb.watchWhere(PATH, 'uid', a.user.uid, take, () => {});
  }
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user ? a.user.uid + ':' + (a.key || a.role) : null;
    if (k === key) return;
    key = k;
    if (k) start(a); else { stop(); render(); }
  });

  window.YDProduction = { ask: ask, forLine: forLine, totals: totals, TASKS: TASKS };
})();
