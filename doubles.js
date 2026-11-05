// Costs counted twice (Jonah, 4 Nov 2026: "we need to go through and make sure
// we dont have duplicate items on jobs because i hand entered all of hte mds
// orders up until mkaing this app"). When the year's receipts came in from his
// email and were sorted onto jobs, the lines he had typed for the same orders
// stayed, so those jobs carry the cost twice and their profit reads low.
//
// All Jobs → 🔁 Costs counted twice lists them, worked out fresh from the jobs
// and the receipts, so nothing is stored here but his answers. A typed line is
// one of these:
//   whole    to the cent what a whole receipt on the same job came to
//   line     to the cent one line of a receipt on the job, with a word in common
//   waiting  to the cent a receipt still to sort: nothing doubled yet, and
//            putting the receipt on the job takes the typed line off
//   filed    to the cent a receipt filed on another job: which job is his call
// The receipt stays and the typed line goes, because the receipt has the item
// numbers, the tax and the order. Both are real: the typed line is marked
// `notDouble` and never asked about again. New receipts take off the typed line
// they repeat by themselves (receipts.js typedRepeats).
(function () {
  'use strict';

  const WHOLE_DAYS = 14, LINE_DAYS = 7;
  const el = id => document.getElementById(id);
  const cents = v => Math.round((parseFloat(v) || 0) * 100);
  const gap = (a, b) => {
    const x = new Date(String(a || '').slice(0, 10) + 'T12:00:00'), y = new Date(String(b || '').slice(0, 10) + 'T12:00:00');
    return isNaN(x) || isNaN(y) ? 9999 : Math.abs(Math.round((x - y) / 864e5));
  };
  const wordsOf = s => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2));
  const shareWord = (a, b) => { const w = wordsOf(b); return Array.from(wordsOf(a)).some(x => w.has(x)); };
  const liveJob = j => j && !j.deletedAt && !j.removeWhy;
  let shown = false;

  // The rows of one job's costs that repeat a receipt.
  function onJob(j, receipts) {
    const rows = Array.isArray(j.materials) ? j.materials : [];
    const typed = rows.filter(m => m && !m.receiptId && !m.notDouble && cents(m.price) > 0);
    if (!typed.length) return [];
    const groups = {};
    rows.filter(m => m && m.receiptId).forEach(m => {
      const g = groups[m.receiptId] = groups[m.receiptId] || { rid: m.receiptId, cents: 0, date: m.date, name: m.vendor || m.location || 'Receipt', no: m.orderNo || '', link: m.link || '' };
      g.cents += cents(m.price);
    });
    const out = [], usedGroup = {}, usedLine = {}, usedRc = {};
    const add = (m, kind, other) => out.push({ jobId: j._id, jobName: j.customerName || 'Untitled job', row: m, kind: kind, other: other });
    typed.forEach(m => {
      const c = cents(m.price);
      const g = Object.values(groups).find(x => !usedGroup[x.rid] && x.cents === c && gap(x.date, m.date) <= WHOLE_DAYS);
      if (g) { usedGroup[g.rid] = true; add(m, 'whole', g); return; }
      const l = rows.find(x => x && x.receiptId && !usedLine[x.id] && cents(x.price) === c && gap(x.date, m.date) <= LINE_DAYS && shareWord(x.item, m.item));
      if (l) { usedLine[l.id] = true; add(m, 'line', { rid: l.receiptId, cents: c, date: l.date, name: l.vendor || l.location || 'Receipt', no: l.orderNo || '', link: l.link || '', item: l.item }); return; }
      const hit = Object.entries(receipts).find(([rid, r]) => r && !groups[rid] && !usedRc[rid] && Number(r.totalCents) === c && gap(r.date, m.date) <= LINE_DAYS &&
        ['new', 'done'].indexOf(r.status) !== -1);
      if (!hit) return;
      const r = hit[1], other = (r.splits || []).find(s => s && s.to === 'job' && s.jobId !== j._id);
      if (r.status === 'done' && !other) return;
      usedRc[hit[0]] = true;
      add(m, r.status === 'new' ? 'waiting' : 'filed', { rid: hit[0], cents: c, date: r.date, name: r.vendor || 'Receipt', no: r.orderNo || '', link: r.link || '', jobName: other ? other.jobName : '' });
    });
    return out;
  }
  function find() {
    const receipts = window.YDReceipts && YDReceipts.all ? YDReceipts.all() || {} : {};
    const list = [];
    (typeof loadAllJobs === 'function' ? loadAllJobs() : []).filter(liveJob).forEach(j => { list.push(...onJob(j, receipts)); });
    return list;
  }
  const sure = x => x.kind === 'whole' || x.kind === 'line';
  const day = d => (typeof fmtDateMD === 'function' && d ? fmtDateMD(String(d).slice(0, 10)) : String(d || ''));
  const WORDS = { whole: 'is the whole of', line: 'is a line of', waiting: 'is to the cent', filed: 'is to the cent' };

  function rowHtml(x) {
    const m = x.row, o = x.other, j = ordId(x.jobId), r = ordId(m.id);
    const what = '<b>' + esc(day(m.date)) + ' · ' + fmtMoney(cents(m.price) / 100) + '</b> ' + esc(String(m.item || '').slice(0, 70)) +
      (m.location ? ' <span class="muted">· ' + esc(m.location) + '</span>' : '');
    const rc = esc(o.name) + (o.no ? ' #' + esc(o.no) : '') + ' ' + esc(day(o.date)) +
      (x.kind === 'waiting' ? ', still to sort' : x.kind === 'filed' ? ', filed on ' + esc(o.jobName || 'another job') : '');
    const open = /^https:/.test(o.link || '') ? ' <a class="link-btn" href="' + esc(o.link) + '" target="_blank" rel="noopener">the email</a>' : '';
    const acts = x.kind === 'filed' ? ''
      : x.kind === 'waiting' ? '<button class="btn btn-sm btn-filled" onclick="dblFile(\'' + j + '\', \'' + r + '\')">Put the receipt on this job</button>'
      : '<button class="btn btn-sm btn-filled" onclick="dblOff(\'' + j + '\', \'' + r + '\')">Take off the typed line</button>';
    return '<div class="dbl-row"><div>' + what + '</div><div class="dbl-rc">' + WORDS[x.kind] + ' ' + rc + open + '</div>' +
      '<div class="dbl-acts">' + acts + ' <button class="link-btn" onclick="dblBoth(\'' + j + '\', \'' + r + '\')">Both are real</button></div></div>';
  }
  function draw() {
    const sec = el('dblSection'), wrap = el('dblWrap');
    if (!sec || !wrap) return;
    const on = typeof ydCan === 'function' && ydCan('jobs', 'change') && window.YDReceipts && YDReceipts.loaded && YDReceipts.loaded();
    const list = on ? find() : [];
    sec.hidden = !list.length;
    el('dblBadge').textContent = list.length ? String(list.length) : '';
    if (!list.length) { wrap.innerHTML = ''; return; }
    const doubled = list.filter(sure), total = doubled.reduce((t, x) => t + cents(x.row.price), 0);
    const jobs = {};
    list.forEach(x => { (jobs[x.jobId] = jobs[x.jobId] || []).push(x); });
    wrap.innerHTML = '<p>' + (doubled.length ? '<b>' + fmtMoney(total / 100) + '</b> is on these jobs twice: a line typed by hand and the receipt for the same order, so their ' +
        'costs read high and their profit low. The receipt stays and the typed line comes off.' : 'Typed lines with a receipt to the same cent.') + '</p>' +
      (doubled.length ? '<div class="field-actions"><button class="btn btn-filled" onclick="dblAllOff()">Take off all ' + doubled.length + ' typed lines</button> ' +
        '<button class="btn" onclick="dblShow()">' + (shown ? 'Fold the list' : 'Show them') + '</button></div>' : '') +
      (shown || !doubled.length ? Object.keys(jobs).map(id => '<div class="dbl-job"><button class="link-btn dbl-name" onclick="dblOpen(\'' + ordId(id) + '\')">' +
        esc(jobs[id][0].jobName) + '</button>' + jobs[id].map(rowHtml).join('') + '</div>').join('') : '');
  }
  function soon() { clearTimeout(soon.t); soon.t = setTimeout(draw, 400); }

  const jobOf = key => (loadAllJobs() || []).find(j => ordId(j._id) === key);
  const hit = (jk, rk) => find().find(x => ordId(x.jobId) === jk && ordId(x.row.id) === rk);
  // Back on a job, each to where it was: rows of `back` not there now.
  function putBack(jobId, back) {
    YDReceipts.changeJob(jobId, list => list.concat(back.filter(b => !list.some(m => m.id === b.id))));
    draw();
  }
  window.dblOff = function (jk, rk) {
    const x = hit(jk, rk);
    if (!x || !YDReceipts.changeJob(x.jobId, list => list.filter(m => m.id !== x.row.id))) return;
    draw();
    showUndo('Typed line taken off ' + x.jobName, () => putBack(x.jobId, [x.row]), 9000);
  };
  window.dblAllOff = async function () {
    const all = find().filter(sure);
    const total = all.reduce((t, x) => t + cents(x.row.price), 0);
    const byJob = {};
    all.forEach(x => { (byJob[x.jobId] = byJob[x.jobId] || []).push(x.row); });
    const ok = await ydConfirm('Their receipts stay on the jobs, so each job still has the cost once.',
      { title: 'Take off ' + all.length + ' typed lines (' + fmtMoney(total / 100) + ')?', ok: 'Take them off', cancel: 'Not yet' });
    if (!ok) return;
    Object.keys(byJob).forEach(id => {
      const off = new Set(byJob[id].map(m => m.id));
      YDReceipts.changeJob(id, list => list.filter(m => !off.has(m.id)));
    });
    draw();
    showUndo(all.length + ' typed lines taken off', () => Object.keys(byJob).forEach(id => putBack(id, byJob[id])), 15000);
  };
  window.dblBoth = function (jk, rk) {
    const x = hit(jk, rk);
    if (!x) return;
    YDReceipts.changeJob(x.jobId, list => list.map(m => (m.id === x.row.id ? Object.assign({}, m, { notDouble: true }) : m)));
    draw();
  };
  window.dblFile = function (jk, rk) {
    const x = hit(jk, rk);
    if (x && x.kind === 'waiting' && YDReceipts.fileOnJob(x.other.rid, x.jobId)) draw();
  };
  window.dblShow = function () { shown = !shown; draw(); };
  window.dblOpen = function (key) { const j = jobOf(key); if (j && typeof loadJob === 'function') loadJob(j._id); };

  ['yd-jobs-changed', 'yd-receipts', 'yd-auth'].forEach(ev => document.addEventListener(ev, soon));
  window.YDDoubles = { draw: soon, find: find };
})();
