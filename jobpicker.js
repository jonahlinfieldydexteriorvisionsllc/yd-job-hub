// The Job tab with no job open.
//
// The tab always held a job's form, so with none open it showed an empty one
// that looked like a new job, with My Jobs thrown up over it (review of 4 Nov
// 2026, item 3; Jonah: "build the picker"). Now it lists what there is to open,
// in place: what is under way, what is booked in the order it is in line, and
// the newest bids, a tap each. Search looks through every job and bid, finished
// and lost ones too. + New at the top of the screen is still how a job starts,
// and that alone shows the empty form (app.js blankJobAsked).
//
// It holds nothing of its own. What it lists is the same job index My Jobs
// reads, and opening a row is loadJob.
(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // A long list of old bids is what My Jobs is for.
  const BIDS_SHOWN = 8;
  // Enough to find one by a town or a service; past that, more letters.
  const FOUND_SHOWN = 30;

  const panelOn = () => { const p = el('panel-job'); return !!(p && p.classList.contains('active')); };
  // Nothing open, and nobody asked for a new one. dirty: never true here with
  // the form out of sight, but nothing typed may ever be hidden.
  const wanted = () => !currentJobId && !blankJobAsked && !dirty;

  function rowHtml(j, d, more) {
    const what = d ? jobWhat(d) : (j.services || '');
    const money = j.price ? fmtMoney(j.price) : perPushOfJob(j.id) || 'No price yet';
    return '<button type="button" class="jp-row ro-ok" onclick="loadJob(\'' + ordId(j.id) + '\')">' +
      '<span class="jp-name">' + jobNameHtml(j.name, j.est) + (more ? ' ' + more : '') + '</span>' +
      '<span class="jp-sub">' + esc([j.city, what, money].filter(Boolean).join(' · ')) + '</span></button>';
  }
  const groupHtml = (head, rows, foot) => rows.length
    ? '<h3 class="jp-head">' + esc(head) + ' <span class="jp-n">' + rows.length + '</span></h3>' + rows.join('') + (foot || '') : '';

  function listHtml(jobs, full) {
    const of = stage => jobs.filter(j => j.stage === stage);
    const byDay = (a, b) => jobListDay(b).localeCompare(jobListDay(a)) || String(a.name || '').localeCompare(String(b.name || ''));

    const going = of('inprogress').sort(byDay).map(j => rowHtml(j, full[j.id]));

    // The line they said yes in, or the order he put them in (jobline.js).
    const booked = of('booked');
    const ids = new Set(booked.map(j => j.id));
    const spots = (window.YDJobLine ? YDJobLine.line() : []).filter(r => ids.has(r.id));
    const inLine = new Set(spots.map(r => r.id));
    const byId = {};
    booked.forEach(j => { byId[j.id] = j; });
    const lined = spots.map(r => rowHtml(byId[r.id], full[r.id], '<span class="bd-place">' + esc(YDJobLine.nth(r.place)) + '</span>'))
      .concat(booked.filter(j => !inLine.has(j.id)).sort(byDay).map(j => rowHtml(j, full[j.id])));

    const bids = of('bid').sort(byDay);
    const bidRows = bids.slice(0, BIDS_SHOWN).map(j => {
      const w = full[j.id] ? bidWhere(full[j.id]) : null;
      return rowHtml(j, full[j.id], w ? bidStandHtml(w) : '');
    });
    const rest = bids.length - bidRows.length;

    const html = groupHtml('🔨 In progress', going) + groupHtml('📌 Booked', lined) +
      groupHtml('📝 Newest bids', bidRows, rest > 0 ? '<p class="hint jp-more">' + rest + ' older ' + (rest === 1 ? 'bid' : 'bids') + ' — search finds them.</p>' : '');
    if (html) return html;
    return '<p class="empty-msg">' + (jobs.length ? 'Nothing in progress, booked or out for a bid. Search finds the finished ones.'
      : jobsReadOnly() ? 'No jobs here yet.' : 'No jobs here yet. + New at the top starts one.') + '</p>';
  }

  function foundHtml(jobs, full, words) {
    const hit = jobs.filter(j => {
      const d = full[j.id] || {};
      const text = [j.name, j.est, j.city, j.services, d.address, d.phone, d.email, d.crewWhat].join(' ').toLowerCase();
      return words.every(w => text.indexOf(w) !== -1);
    }).sort((a, b) => jobListDay(b).localeCompare(jobListDay(a)));
    if (!hit.length) return '<p class="empty-msg">No job or bid matches that.</p>';
    const shown = hit.slice(0, FOUND_SHOWN);
    return shown.map(j => rowHtml(j, full[j.id], j.stage ? stagePill(j.stage) : '')).join('') +
      (hit.length > shown.length ? '<p class="hint jp-more">' + (hit.length - shown.length) + ' more. Type a little more to narrow it.</p>' : '');
  }

  function draw() {
    const body = el('jpBody');
    if (!body) return;
    const words = String((el('jpSearch') || {}).value || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    // The whole job for what it is; the same list My Jobs reads otherwise. A
    // duplicate waiting to be taken off isn't a job to open.
    const full = {};
    loadAllJobs().forEach(d => { full[d._id] = d; });
    const jobs = getJobIndex().filter(j => !(full[j.id] && full[j.id].removeWhy));
    body.innerHTML = words.length ? foundHtml(jobs, full, words) : listHtml(jobs, full);
  }

  // Whether it shows follows from the form: called whenever the job in the form
  // changes and whenever the tab comes on screen.
  function sync() {
    const box = el('jobPicker');
    if (!box) return;
    const on = wanted();
    document.documentElement.toggleAttribute('data-job-pick', on);
    box.hidden = !on;
    if (on && panelOn()) draw();
  }

  // Not while someone is looking elsewhere: the job list changes all day.
  let soon = null;
  document.addEventListener('yd-jobs-changed', () => {
    clearTimeout(soon);
    soon = setTimeout(() => { if (wanted() && panelOn()) draw(); }, 300);
  });
  // Typing a search: the box itself is never redrawn, so it keeps the letters
  // and the keyboard whatever arrives underneath it.
  document.addEventListener('input', e => { if (e.target && e.target.id === 'jpSearch') draw(); });

  window.YDJobPicker = { sync: sync };
})();
