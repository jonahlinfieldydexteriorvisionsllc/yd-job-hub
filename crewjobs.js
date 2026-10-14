// The crew's view of a job: everything they need on site, no prices.
//
// Jonah (12 Oct 2026): "i need a separate interface for the crew to see
// where its all the client info & job info without prices for everything &
// then they can upload images there" -- name, address, phone and site notes;
// "after a job is booked i want the job page to have the estimate
// information attached without pricing so it should say all the
// measurements, type of mulch were laying, everything that is important info
// for the crew to know"; every booked and in-progress job, with a switch on
// the job to hide one.
//
// The crew cannot read jobs/* at all (a job carries the quote, the costs and
// the margin, and Firestore cannot hide a field), so each booked or
// in-progress job also gets a crew-safe copy, jobCrew/{jobId}, written from
// the same save that writes the clock's jobBoard entry (sync.js). It carries
// only what is listed in crewEntry() -- and any dollar amount typed into a
// note or a scope is blanked, since a note might say what was agreed.
//
// The crew read it on their Jobs tab; the owner sees exactly the same page
// from the Job tab (👷 What the crew see).

(function () {
  'use strict';

  const SHOWN = ['booked', 'inprogress'];
  let jobs = {};              // id -> crew copy (a crew phone)
  let unsub = null;
  const sent = {};            // id -> what this device last wrote (no rewrite of the same)
  let reconciled = false;
  const el = id => document.getElementById(id);
  const safe = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const statusOf = d => (typeof normStatus === 'function' ? normStatus(d.jobStatus, d) : (d.jobStatus || 'quoting'));
  // A price typed into free text ("gave them $500 off") never reaches a
  // crew phone.
  const noMoney = s => String(s == null ? '' : s).replace(/\$\s?\d[\d,]*(\.\d+)?/g, '$—');
  const numOr = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

  function vendorName(id) {
    const c = window.YDSupplies && YDSupplies.catalog ? YDSupplies.catalog() : null;
    return (c && c.vendors && c.vendors[id] && c.vendors[id].name) || '';
  }

  // What a crew member may know about a job -- nothing else is copied.
  function crewEntry(d) {
    const est = d.estimate || {};
    return {
      name: String(d.customerName || '').trim() || 'Untitled job',
      address: d.address || '', city: d.city || '', state: d.state || '', zip: d.zip || '',
      phone: d.phone || '',
      status: statusOf(d),
      est: String(d.estimateNumber || '').trim(),
      services: (d.serviceTypes || []).slice(0, 20),
      siteNotes: noMoney(est.notes).slice(0, 8000),
      notes: noMoney(d.notes).slice(0, 4000),
      work: (est.work || []).filter(w => w && (w.title || w.scope)).slice(0, 40)
        .map(w => ({ title: noMoney(w.title).slice(0, 200), scope: noMoney(w.scope).slice(0, 3000), days: numOr(w.crewDays) })),
      materials: (est.materials || []).filter(m => m && m.name).slice(0, 120)
        .map(m => ({ name: String(m.name).slice(0, 200), qty: numOr(m.qty), unit: m.unit || '',
                     how: m.delivery === 'pickup' ? 'pick up' : m.delivery === 'rides' ? 'rides on a delivery' : '' })),
      order: (d.orderItems || []).filter(o => o && o.name).slice(0, 120)
        .map(o => ({ name: String(o.name).slice(0, 200), qty: String(o.quantity || o.qty || '').slice(0, 30),
                     per: o.per || '', supplier: vendorName(o.vendorId), ordered: !!o.ordered })),
    };
  }
  const shows = d => SHOWN.indexOf(statusOf(d)) !== -1 && !d.crewHidden;

  // Called from sync.js with every job it sends up: the crew copy follows.
  // Only whoever may change jobs writes it (the rules say so too), and only
  // when it actually differs from what was last written.
  function mirror(id, d) {
    if (!window.YDDb || typeof ydCan !== 'function' || !ydCan('jobs', 'change') || !id) return;
    if (!d || !shows(d)) {
      if (sent[id] === null) return;
      sent[id] = null;
      Promise.resolve(window.YDDb.remove('jobCrew', id)).catch(() => {});
      return;
    }
    const entry = crewEntry(d);
    const sig = JSON.stringify(entry);
    if (sent[id] === sig) return;
    sent[id] = sig;
    Promise.resolve(window.YDDb.put('jobCrew', id, Object.assign({}, entry, { updatedAt: new Date().toISOString() })))
      .catch(e => console.warn('[crewjobs] crew copy not yet sent for', id, (e && e.code) || e));
  }

  // Once per session on the device that runs the jobs: every booked or
  // in-progress job has its crew copy, and nothing else does.
  async function reconcile() {
    if (reconciled || !window.YDDb || typeof ydCan !== 'function' || !ydCan('jobs', 'change')) return;
    if (typeof getJobIndex !== 'function' || typeof readJobBlob !== 'function') return;
    reconciled = true;
    let have = {};
    try { have = await window.YDDb.list('jobCrew'); } catch (e) { reconciled = false; return; }
    const ids = new Set();
    getJobIndex().forEach(j => {
      let d = null;
      try { d = JSON.parse(readJobBlob(j.id) || 'null'); } catch (e) { d = null; }
      if (!d) return;
      ids.add(j.id);
      if (shows(d)) {
        const entry = crewEntry(d);
        // Already right on the server: only remember it, write nothing.
        if (have[j.id] && sameEntry(have[j.id], entry)) { sent[j.id] = JSON.stringify(entry); return; }
        mirror(j.id, d);
      } else if (have[j.id]) {
        delete sent[j.id];
        mirror(j.id, d);
      }
    });
    // A copy whose job is gone.
    Object.keys(have).forEach(id => { if (!ids.has(id)) Promise.resolve(window.YDDb.remove('jobCrew', id)).catch(() => {}); });
  }
  function sameEntry(a, b) {
    const keys = Object.keys(b);
    return keys.every(k => JSON.stringify(a[k] === undefined ? null : a[k]) === JSON.stringify(b[k] === undefined ? null : b[k]));
  }

  // ------------------------------------------------------------ the page

  function mapUrl(j) {
    const where = [j.address, j.city, j.state, j.zip].filter(Boolean).join(', ');
    return where ? 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(where) : '';
  }
  const fmtQty = (q, u) => (q == null ? '' : (Math.round(q * 100) / 100) + (u ? ' ' + u : ''));
  function pageHtml(id, j, preview) {
    const where = [j.address, [j.city, j.state].filter(Boolean).join(', '), j.zip].filter(Boolean).join(', ');
    const tel = String(j.phone || '').replace(/[^0-9+]/g, '');
    const days = window.YDCalendar && YDCalendar.forJob ? YDCalendar.forJob(id) : [];
    const sec = (title, body) => body ? '<div class="cj-sec"><div class="cj-h">' + title + '</div>' + body + '</div>' : '';
    return '<div class="cj-page">' +
      (preview ? '<div class="cj-preview">This is the page the crew see for this job — no prices anywhere. ' +
        'Hide it from them with “Hide from crew” on the Job tab.</div>' : '') +
      '<div class="cj-top"><div class="cj-name">' + esc(j.name) + (j.est ? ' <span class="job-num">#' + esc(j.est) + '</span>' : '') + '</div>' +
        '<span class="cj-status">' + (j.status === 'inprogress' ? 'In progress' : 'Booked') + '</span></div>' +
      (where ? '<a class="snow-addr" href="' + esc(mapUrl(j)) + '" target="_blank" rel="noopener">📍 ' + esc(where) +
        '<span class="snow-go">Directions</span></a>' : '<div class="muted">No address on the job yet.</div>') +
      (tel ? '<a class="cj-call" href="tel:' + esc(tel) + '">📞 ' + esc(j.phone) + '</a>' : '') +
      ((j.services || []).length ? '<div class="cj-tags">' + j.services.map(s => '<span class="svc-tag">' + esc(s) + '</span>').join('') + '</div>' : '') +
      sec('👷 Who is working', days.length ? days.slice(0, 12).map(x => '<div class="cj-day"><b>' +
          esc(new Date(x.day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })) + '</b>' +
          (x.time ? ' · ' + esc(x.time) : '') + (x.crew.length ? ' — ' + esc(x.crew.join(', ')) : '') + '</div>').join('') : '') +
      sec('📝 Site notes', j.siteNotes ? '<div class="cj-text">' + esc(j.siteNotes) + '</div>' : '') +
      sec('🛠 The work', (j.work || []).map(w => '<div class="cj-work"><b>' + esc(w.title || 'Work') + '</b>' +
          (w.days ? ' <span class="muted">· ' + w.days + ' crew-day' + (w.days === 1 ? '' : 's') + '</span>' : '') +
          (w.scope ? '<div class="cj-text">' + esc(w.scope) + '</div>' : '') + '</div>').join('')) +
      sec('🧱 Materials for the job', (j.materials || []).length ? '<table class="cj-table"><tbody>' + j.materials.map(m =>
          '<tr><td>' + esc(m.name) + (m.how ? ' <span class="muted">(' + esc(m.how) + ')</span>' : '') + '</td><td class="cj-q">' +
          esc(fmtQty(m.qty, m.unit)) + '</td></tr>').join('') + '</tbody></table>' : '') +
      sec('🛒 Ordered', (j.order || []).length ? '<table class="cj-table"><tbody>' + j.order.map(o =>
          '<tr><td>' + (o.ordered ? '✓ ' : '') + esc(o.name) + (o.supplier ? ' <span class="muted">· ' + esc(o.supplier) + '</span>' : '') +
          '</td><td class="cj-q">' + esc([o.qty, o.per].filter(Boolean).join(' ')) + '</td></tr>').join('') + '</tbody></table>' : '') +
      sec('🗒 Notes', j.notes ? '<div class="cj-text">' + esc(j.notes) + '</div>' : '') +
      '<div class="cj-photos" id="cjPhotos" data-job="' + safe(id) + '"></div>' +
      '<div class="field-actions">' +
        (!preview && window.openNoteForJonah ? '<button class="btn btn-filled" onclick="openNoteForJonah(\'' + safe(id) + '\', ' +
          esc(JSON.stringify(j.name)).replace(/'/g, '&#39;') + ')">📝 Leave a note for Jonah about this job</button>' : '') +
      '</div>' +
    '</div>';
  }

  function modalBody(title) {
    let m = el('crewJobModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal-overlay';
      m.id = 'crewJobModal';
      m.onclick = ev => { if (ev.target === m) m.classList.remove('active'); };
      m.innerHTML = '<div class="modal" style="max-width:680px"><div class="modal-head"><h2></h2>' +
        '<button class="modal-close">&times;</button></div><div class="modal-body"></div></div>';
      m.querySelector('.modal-close').onclick = () => m.classList.remove('active');
      document.body.appendChild(m);
    }
    m.querySelector('h2').textContent = title;
    m.classList.add('active');
    return m.querySelector('.modal-body');
  }
  function afterPage(id) {
    if (window.YDJobPhotos) YDJobPhotos.mount(el('cjPhotos'), id);
  }

  // A crew member opening one of their jobs.
  window.openCrewJob = function (id) {
    const j = jobs[id];
    if (!j) return;
    modalBody('Job').innerHTML = pageHtml(id, j, false);
    afterPage(id);
  };
  // The owner's "What the crew see", from the job open on the Job tab.
  window.previewCrewJob = function () {
    if (typeof getJobData !== 'function') return;
    const d = getJobData();
    const id = typeof currentJobId !== 'undefined' ? currentJobId : '';
    modalBody('What the crew see').innerHTML = pageHtml(id, crewEntry(d), true) +
      (shows(d) ? '' : '<p class="ntf-warn">The crew do not see this job now — ' +
        (d.crewHidden ? 'it is hidden from them.' : 'only booked and in-progress jobs are shown to them.') + '</p>');
    afterPage(id);
  };

  // ------------------------------------------------------- the Jobs tab

  // In progress first, then booked; A to Z within each.
  function listed() {
    return Object.keys(jobs).map(id => Object.assign({ id: id }, jobs[id]))
      .sort((a, b) => (a.status === 'inprogress' ? 0 : 1) - (b.status === 'inprogress' ? 0 : 1) ||
        String(a.name).localeCompare(String(b.name)));
  }
  function render() {
    // Home shows the same list (home.js).
    document.dispatchEvent(new CustomEvent('yd-crew-jobs'));
    const wrap = el('crewJobsWrap');
    if (!wrap) return;
    const list = listed();
    wrap.innerHTML = list.length ? list.map(j => '<button class="cj-row" onclick="openCrewJob(\'' + safe(j.id) + '\')">' +
        '<span class="cj-row-name"><b>' + esc(j.name) + '</b>' + (j.est ? ' <span class="job-num">#' + esc(j.est) + '</span>' : '') +
          '<small>' + esc([j.address, j.city].filter(Boolean).join(', ')) + '</small></span>' +
        '<span class="cj-status">' + (j.status === 'inprogress' ? 'In progress' : 'Booked') + '</span></button>').join('')
      : '<p class="empty-msg">No booked jobs right now.</p>';
  }

  function stop() { if (unsub) { try { unsub(); } catch (e) {} } unsub = null; jobs = {}; }
  function start(a) {
    stop();
    if (!window.YDDb || !a.user || a.mode !== 'cloud') return;
    unsub = window.YDDb.watch('jobCrew', changes => {
      changes.forEach(c => { if (c.type === 'removed') delete jobs[c.id]; else jobs[c.id] = c.data || {}; });
      render();
    }, () => render());
  }

  let key = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const crew = on && typeof ydCan === 'function' && !ydCan('jobs', 'see');
    const tab = el('tabCrewJobs');
    if (tab) tab.hidden = !crew;
    const pv = el('crewPreviewBtn');
    if (pv) pv.hidden = !(on && typeof ydCan === 'function' && ydCan('jobs', 'see'));
    const k = crew ? a.user.uid : null;
    if (k !== key) { key = k; if (crew) start(a); else stop(); }
    if (on && typeof ydCan === 'function' && ydCan('jobs', 'change')) setTimeout(reconcile, 4000);
    if (!on) { reconciled = false; Object.keys(sent).forEach(k2 => delete sent[k2]); }
  });

  window.YDCrewJobs = { mirror: mirror, render: render, entry: crewEntry,
    // The crew's booked and in-progress jobs, as their Jobs tab lists them
    // (a crew phone; empty for anyone who has the Job tab instead).
    list: () => listed() };
})();
