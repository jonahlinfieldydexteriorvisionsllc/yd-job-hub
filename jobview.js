// One job, one screen.
//
// A job was split across two tabs: Job (its details, estimate and materials)
// and Tracking (hours, purchases, payments, what it made), with Tracking
// behind More on a phone, and the client's boxes alone 2½ screens long ahead of
// the estimate (review of 4 Nov 2026; Jonah: "Yes, do that next"). Now it is
// the Job tab, one part at a time, picked with tap buttons that wrap (never a
// row that scrolls sideways):
//   Details    the client's boxes, the stage, the notes (and the old Proposal Import)
//   Estimate   estimate.js
//   Materials  what to order, the tools
//   Costs      labour, purchases, add-ons, payments, what it made
//   Photos     photos, signatures, change orders
//   Log        the daily log, issues, end-of-day notes (only once there are any)
//
// This file holds nothing of the job's own: each part is drawn by the file it
// always belonged to, into a place on the panel (index.html data-job-view). It
// says which part is showing, words each button with what is waiting there,
// and draws the strip over them: what the job is, its price, and a tap to get
// there or ring them, so the boxes only need opening to change something. The
// Editing bar above already holds the name and the stage.
//
// Which part a job opens on goes by where it stands: a bid on its estimate, a
// booked job on what to order, one under way or finished on its costs. A job
// with no name yet opens on its details. Nothing is remembered between jobs:
// what shows when a job is opened never depends on what was looked at last.
//
// Whatever is on another part of the job stays filled in while it is hidden;
// only the costs (which ask the pricing rules) and the estimate's box sizes
// wait until they are shown: arrived() below.
(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const box = id => String((el(id) || {}).value || '').trim();
  const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');
  const dollars = n => '$' + Math.round(n).toLocaleString('en-US');
  const LOG_PARTS = ['jobLogSection', 'jobIssuesSection', 'jobEodSection'];
  const logHasAny = () => LOG_PARTS.some(id => { const s = el(id); return !!(s && !s.hidden); });
  const stageNow = () => jobStage(formStageData()).id;

  function estimateWords() {
    const n = box('estimateNumber');
    const q = boardFields.qbEstimate;
    if (n) return '#' + n + (q && (q.status === 'Accepted' || q.acceptedDate) ? ' · accepted' : '');
    return hasEstimate() ? 'Being built' : 'Not started';
  }
  function materialWords() {
    const lines = orderItems.filter(m => m && String(m.name || '').trim());
    if (!lines.length) return 'Nothing yet';
    const left = lines.filter(m => !m.ordered && !m.notBought).length;
    return left ? left + ' to order' : 'All ordered';
  }
  function costWords() {
    const got = round2(payments.reduce((t, p) => t + (parseFloat(p.amount) || 0), 0));
    const bill = formBill();
    const owed = round2(bill.total - got);
    if (bill.total > 0 && owed <= 0) return 'Paid in full';
    if (got > 0) return dollars(owed) + ' owed';
    const spent = round2(materials.reduce((t, m) => t + (parseFloat(m.price) || 0), 0));
    if (spent > 0) return dollars(spent) + ' bought';
    return labor.length ? plural(labor.length, 'worker') : 'Nothing yet';
  }
  function photoWords() {
    const n = window.YDJobPhotos && YDJobPhotos.count ? YDJobPhotos.count(currentJobId) : null;
    return n === null ? 'Signed papers too' : n ? plural(n, 'photo') : 'No photos yet';
  }
  function logWords() {
    const n = window.YDJobIssues && currentJobId ? YDJobIssues.forJob(currentJobId).filter(i => !i.readAt).length : 0;
    return n ? plural(n, 'new issue') : 'Notes & issues';
  }

  // long: said on anything wider than a phone.
  const VIEWS = [
    { id: 'details', icon: '📋', name: 'Details', sub: () => !box('address') ? 'No address yet' : !box('phone') && !box('email') ? 'No phone or email' : 'Client & notes' },
    { id: 'estimate', icon: '📝', name: 'Estimate', sub: estimateWords },
    { id: 'materials', icon: '🧱', name: 'Materials', sub: materialWords },
    { id: 'costs', icon: '💵', name: 'Costs', long: ' & payments', sub: costWords },
    { id: 'papers', icon: '📷', name: 'Photos', long: ' & papers', sub: photoWords },
    { id: 'log', icon: '📒', name: 'Log', sub: logWords, shows: () => view === 'log' || logHasAny() },
  ];

  let view = 'details';
  let lastId = null;
  let timer = null;

  const panelOn = () => { const p = el('panel-job'); return !!(p && p.classList.contains('active')); };
  const showing = v => view === v && panelOn();

  function firstView() {
    if (!currentJobId || !box('customerName')) return 'details';
    const s = stageNow();
    return s === 'bid' || s === 'lost' ? 'estimate' : s === 'booked' ? 'materials' : 'costs';
  }

  function apply() {
    document.querySelectorAll('#panel-job [data-job-view]').forEach(d => { d.hidden = d.dataset.jobView !== view; });
  }

  // On hand on every part: where it is, the price, and a tap to go or ring.
  function stripHtml() {
    if (!currentJobId) return '';
    const street = box('address');
    const where = [street, [box('city'), box('state')].filter(Boolean).join(', '), box('zip')].filter(Boolean).join(' ').trim();
    const shortWhere = [street, box('city')].filter(Boolean).join(', ');
    const phone = box('phone'), email = box('email');
    const what = jobWhat({ crewWhat: box('crewWhat'), estimate: window.YDEstimate ? YDEstimate.get() : null, serviceTypes: serviceTypes });
    const price = parseMoney(box('jobPrice'));
    if (!what && !price && !where && !phone && !email) return '';
    const top = what || price ? '<div class="js-top"><span class="js-what">' + esc(what) + '</span>' +
      (price ? '<span class="js-price">' + esc(fmtMoney(price)) + '</span>' : '') + '</div>' : '';
    const links = [];
    if (where) links.push('<a class="btn btn-sm js-place" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&amp;destination=' +
      esc(encodeURIComponent(where)) + '"><span class="js-icon">📍</span><span class="js-addr">' + esc(shortWhere || where) + '</span></a>');
    if (phone) links.push('<a class="btn btn-sm" aria-label="Call ' + esc(phone) + '" href="tel:' + esc(phone.replace(/[^\d+]/g, '')) +
      '"><span class="js-icon">📞</span><span class="js-long">' + esc(phone) + '</span></a>');
    if (email) links.push('<a class="btn btn-sm js-mail" aria-label="Email ' + esc(email) + '" href="mailto:' + esc(email) +
      '"><span class="js-icon">✉️</span><span class="js-long">' + esc(email) + '</span></a>');
    return top + (links.length ? '<div class="js-links">' + links.join('') + '</div>' : '');
  }

  // Drawn only when it has changed: a button redrawn under a finger loses the tap.
  let drawnViews = null, drawnStrip = null;
  function drawNow() {
    clearTimeout(timer); timer = null;
    const wrap = el('jobViews'), strip = el('jobStrip');
    if (!wrap || !strip) return;
    const html = VIEWS.filter(v => !v.shows || v.shows()).map(v => {
      let sub = '';
      try { sub = v.sub() || ''; } catch (e) { sub = ''; }
      // .ro-ok: a look-only admin may look at every part.
      return '<button type="button" class="jv-btn ro-ok' + (v.id === view ? ' on' : '') + '"' + (v.id === view ? ' aria-current="true"' : '') +
        ' onclick="YDJobView.show(\'' + v.id + '\')"><b><span class="jv-icon">' + v.icon + ' </span>' + esc(v.name) +
        (v.long ? '<span class="jv-long">' + esc(v.long) + '</span>' : '') + '</b><small>' + esc(sub) + '</small></button>';
    }).join('');
    if (html !== drawnViews) { wrap.innerHTML = html; drawnViews = html; }
    const s = stripHtml();
    if (s !== drawnStrip) { strip.innerHTML = s; drawnStrip = s; strip.hidden = !s; }
    const none = el('jobLogNone');
    if (none) none.hidden = logHasAny();
  }
  // The figures change at every key typed in the price or a box: a moment after.
  function draw() {
    if (timer || !panelOn()) return;
    timer = setTimeout(drawNow, 120);
  }

  // A part has come on screen (a tap, or the tab opened on it).
  function arrived() {
    if (!panelOn()) return;
    drawNow();
    // Labour is not redrawn while hidden. This draws it, then the figures,
    // then Estimate vs actual.
    if (view === 'costs' && typeof renderLabor === 'function') renderLabor();
    document.dispatchEvent(new CustomEvent('yd-job-view', { detail: { view: view } }));
  }

  function show(id) {
    if (!VIEWS.some(v => v.id === id)) return;
    view = id;
    apply();
    arrived();
  }

  // The job in the form changed (app.js jobOnScreen). stay: the same job, just
  // given its id by its first save, with someone typing in it.
  function jobShown(id, stay) {
    const next = id || null;
    const same = next === lastId;
    lastId = next;
    if (same || stay) { draw(); return; }
    view = firstView();
    apply();
    arrived();
  }

  document.addEventListener('yd-job-issues', draw);
  document.addEventListener('yd-eod', draw);
  (function followLogParts() {
    if (typeof MutationObserver !== 'function') return;
    const seen = new MutationObserver(draw);
    LOG_PARTS.forEach(id => { const s = el(id); if (s) seen.observe(s, { attributes: true, attributeFilter: ['hidden'] }); });
  })();

  window.YDJobView = { show: show, showing: showing, draw: draw, arrived: arrived, jobShown: jobShown, now: () => view };
})();
