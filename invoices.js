// Invoices -- every unpaid QuickBooks invoice, when it went out and when to
// remind (Jonah, 15 Oct 2026: "i want jobhub to track invoices & when they
// were sent and when to send reminder invoices").
//
// The list is kept by the server's hourly look at QuickBooks
// (functions/quickbooks.py sync_invoices -> invoices/{QuickBooks id}): who,
// what is still owed, the invoice's date and due date, every time it was
// emailed, and whether the customer has opened it -- invoices made from a job
// here, from a storm, or by hand in QuickBooks alike. When a reminder is due
// is worked out here by THE REMINDER RULE, the same as the summaries'
// (functions/digest.py invoice_state):
//   - a deposit paid on a job not finished yet: the rest is due when the job
//     is done, so no reminder until then;
//   - never emailed from QuickBooks: send it;
//   - else the first reminder `firstAfterDays` after the due date (or the day
//     the job was finished, if later), then every `everyDays` after the last,
//     up to `max` -- then it is time to call.
// Every email of the invoice after the first counts as a reminder (sent from
// here or from QuickBooks), and so does one noted by hand (a call, a text).
// A reminder sent from here is the invoice emailed again by QuickBooks, with
// its pay link (/qb/invoice-remind) -- the same email QuickBooks' own
// reminders send.
(function () {
  'use strict';

  const RULES = { firstAfterDays: 3, everyDays: 7, max: 4 };
  let invoices = {};        // id -> invoices/{id}
  let rules = Object.assign({}, RULES);
  let unsub = null, loaded = false;
  let view = 'todo';        // todo | owed | paid
  let editingRules = false;
  let picking = '';         // the invoice whose job is being picked by hand
  const busy = {};          // id -> true while a reminder is being sent

  const el = id => document.getElementById(id);
  const sees = () => typeof ydCan === 'function' && ydCan('billing', 'see');
  const changes = () => typeof ydCan === 'function' && ydCan('billing', 'change');
  const money = n => (typeof fmtMoney === 'function' ? fmtMoney(Number(n) || 0) : '$' + (Number(n) || 0).toFixed(2));
  const safe = s => String(s || '').replace(/[^A-Za-z0-9_-]/g, '');
  const pad = n => String(n).padStart(2, '0');
  const isoDay = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const today = () => isoDay(new Date());
  // The day here of a time QuickBooks or this app wrote ("2026-10-13T13:06:57-07:00");
  // a bare date stays as it is.
  function day(s) {
    s = String(s || '');
    if (s.length <= 10) return s;
    const t = new Date(s);
    return isNaN(t) ? s.slice(0, 10) : isoDay(t);
  }
  function addDays(iso, n) {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return isoDay(d);
  }
  const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);
  function shortDay(iso) {
    const d = new Date(day(iso) + 'T12:00:00');
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  // The job an invoice is on, as this device holds it (none for a storm's
  // or one made by hand in QuickBooks). One in Recently deleted is none.
  //
  // A job's saved text is parsed only when it has changed: every redraw asked
  // for every invoice's job, and Home asks again, and a job's text (estimate,
  // photos list, notes) is large. Readers only look at what comes back.
  const jobParsed = {};     // job id -> { raw, d } as last read
  function jobOf(inv) {
    if (!inv.jobId || typeof readJobBlob !== 'function') return null;
    const raw = readJobBlob(inv.jobId) || '';
    let c = jobParsed[inv.jobId];
    if (!c || c.raw !== raw) {
      let d = null;
      try { d = JSON.parse(raw || 'null'); } catch (e) { return null; }
      c = jobParsed[inv.jobId] = { raw: raw, d: d };
    }
    const d = c.d;
    return d && d.deletedAt ? null : d;
  }

  // Jonah often makes the invoice before the work starts, to collect the
  // deposit -- QuickBooks won't take a deposit on an estimate once it has
  // been accepted (15 Oct 2026). So on a job here that isn't finished, an
  // invoice with nothing paid is asking for the deposit (`deposit`), and one
  // with the deposit paid is waiting for the job to be done. Once it is
  // done, the bill for the rest is the first email after the deposit came
  // in; emails before that were the deposit's, not reminders for the rest
  // (`rest`). The same rule as functions/digest.py invoice_state -- change
  // both together.
  function stateOf(inv) {
    if (!inv.open || !(Number(inv.balance) > 0)) return { kind: 'paid' };
    let emails = (inv.emails || []).filter(Boolean).map(day).sort();
    let hand = (inv.handReminders || []).map(h => day(h && h.at)).filter(Boolean).sort();
    const job = jobOf(inv);
    const done = !!job && (typeof normStatus === 'function' ? normStatus(job.jobStatus, job) : job.jobStatus) === 'complete';
    const total = Number(inv.total) || 0, bal = Number(inv.balance) || 0;
    const part = bal < total - 0.005;
    if (job && !done && part) return { kind: 'waiting', job };
    const deposit = !!job && !done;
    const dueDay = day(inv.dueDate || inv.txnDate);
    const late = dueDay ? daysBetween(dueDay, today()) : 0;
    let since = '';
    if (done && part && job.completedAt) {
      const fin = day(job.completedAt);
      const before = (inv.payments || []).map(p => p && p.date).filter(d => d && d <= fin).sort();
      since = before.length ? before[before.length - 1] : '';
    }
    if (since) {
      emails = emails.filter(d => d > since);
      hand = hand.filter(d => d > since);
    }
    const base = { late, deposit, rest: !!since, job };
    // QuickBooks says it was emailed but not when (before Job Hub watched):
    // sent, no reminders yet.
    if (!emails.length && !hand.length && (since || inv.emailStatus !== 'EmailSent')) return Object.assign(base, { kind: 'unsent' });
    if (day(inv.snoozeUntil) > today()) return Object.assign(base, { kind: 'later', next: day(inv.snoozeUntil), snoozed: true });
    let start;
    if (since) start = (emails.length ? emails : hand)[0];
    else {
      start = dueDay || today();
      if (done && day(job.completedAt) > start) start = day(job.completedAt);
    }
    const count = Math.max(0, emails.length - 1) + hand.length;
    const last = emails.concat(hand).sort().slice(-1)[0];
    if (count >= rules.max) return Object.assign(base, { kind: 'call', count, last });
    const next = count === 0 ? addDays(start, rules.firstAfterDays) : addDays(last, rules.everyDays);
    return Object.assign(base, { kind: today() >= next ? 'due' : 'later', next, count, last });
  }
  // About what the deposit is: the job's own payment plan when its estimate
  // can be priced here, else the usual share (Pricing rules -> payments).
  function depositOf(inv, job) {
    const total = Number(inv.total) || 0;
    try {
      const r = job && job.estimate && window.YDEstimate && YDEstimate.priceSaved ? YDEstimate.priceSaved(job.estimate, job.city || '', undefined, job.deliveryQuotes) : null;
      const first = r && r.payments && r.payments[0], grand = r && (r.grandCents || r.totalCents);
      if (first && grand > 0 && r.payments.length > 1) return Math.round(total * first.cents / grand * 100) / 100;
    } catch (e) { /* priced below instead */ }
    const p = (window.YDPricing && YDPricing.rules && (YDPricing.rules() || {}).payments) || {};
    const pct = Number(p.minDepositPct) > 0 ? Number(p.minDepositPct) : 50;
    return Math.round(total * pct) / 100;
  }
  const wantsYou = st => st.kind === 'due' || st.kind === 'unsent' || st.kind === 'call';

  // ------------------------------------------------------------- drawing

  // Drawn only while All Jobs is on screen: the jobs feed fires all day, and
  // each redraw works out every unpaid invoice's state. What came in while
  // another tab was open is drawn when All Jobs opens (watchPanel, below).
  let dirty = false, panelWatched = false;
  const onScreen = () => {
    if (!panelWatched) return true;
    const p = el('panel-dashboard');
    return !!(p && p.classList.contains('active'));
  };
  function render() {
    const sec = el('invSection');
    if (!sec) return;
    sec.hidden = !sees();
    if (!sees()) return;
    if (!onScreen()) { dirty = true; return; }
    dirty = false;
    const wrap = el('invWrap');
    const idx = typeof getJobIndex === 'function' ? getJobIndex() : [];
    const list = Object.values(invoices).map(inv => ({ inv, st: stateOf(inv) }));
    const open = list.filter(x => x.st.kind !== 'paid');
    const todo = open.filter(x => wantsYou(x.st));
    const paid = list.filter(x => x.st.kind === 'paid');
    const owedTotal = open.reduce((s, x) => s + (Number(x.inv.balance) || 0), 0);
    const badge = el('invBadge');
    if (badge) {
      badge.textContent = todo.length ? todo.length + ' to do' : open.length ? money(owedTotal) + ' owed' : '';
      badge.className = 'section-badge' + (todo.length ? ' eq-alert' : '');
    }
    if (!loaded) { wrap.innerHTML = '<p class="empty-msg">Loading invoices…</p>'; return; }
    const shown = view === 'todo' ? todo : view === 'paid' ? paid : open;
    const order = { unsent: 0, due: 1, call: 2, waiting: 4, later: 3, paid: 5 };
    shown.sort((a, b) => order[a.st.kind] - order[b.st.kind] || (b.st.late || 0) - (a.st.late || 0) ||
      String(a.inv.customerName).localeCompare(String(b.inv.customerName)));
    const tab = (k, label, n) => '<button type="button" class="' + (view === k ? 'on' : '') + '" onclick="invView(\'' + k + '\')">' +
      label + ' <b>' + n + '</b></button>';
    wrap.innerHTML =
      '<div class="inv-sum">' + (open.length ? '<b>' + money(owedTotal) + '</b> owed on ' + open.length + ' invoice' + (open.length === 1 ? '' : 's') : 'Nothing owed.') +
        (changes() ? ' <button class="link-btn" onclick="invCheckNow()">↻ Check QuickBooks now</button>' : '') + '</div>' +
      '<div class="inv-views">' + tab('todo', 'To do', todo.length) + tab('owed', 'All owed', open.length) + tab('paid', 'Paid', paid.length) + '</div>' +
      (shown.length ? shown.map(x => rowHtml(x.inv, x.st, idx)).join('')
        : '<p class="empty-msg">' + (view === 'todo' ? 'No reminders due — nothing to chase today.' : view === 'paid' ? 'Nothing paid in the last month.' : 'Nothing owed.') + '</p>') +
      rulesHtml();
  }

  function stateText(st, inv) {
    const dep = st.deposit ? 'Deposit' + (inv ? ' ' + money(depositOf(inv, st.job)) : '') : '';
    switch (st.kind) {
      // How soon, on the app's one scale: to do today orange, gone too long
      // (time to call) red, waiting dashed, done an outline with a check.
      case 'unsent': return '<span class="inv-chip due">' + (st.rest ? 'Job done — email the bill for the rest'
        : st.deposit ? 'Not emailed yet — send it for the deposit' : 'Not emailed yet — send it') + '</span>';
      case 'due': return '<span class="inv-chip due">' + (dep ? dep + ' not paid — ' : '') +
        (st.count ? 'reminder ' + (st.count + 1) + ' due' : (dep ? 'first reminder due' : 'First reminder due')) + '</span>';
      case 'call': return '<span class="inv-chip now">' + (dep ? dep + ' not paid — ' : '') + st.count + ' reminders sent — time to call</span>';
      case 'waiting': return '<span class="inv-chip info">Deposit paid — the rest is due when the job is done</span>';
      case 'later': return '<span class="inv-chip later">' + (dep ? dep + ' · ' : '') + (st.snoozed ? 'Put off until ' : 'Next reminder ') + esc(shortDay(st.next)) + '</span>';
      default: return '<span class="inv-chip done">✓ Paid</span>';
    }
  }
  // Which job here the invoice is for -- found by the job holding it, or the
  // one open job of the customer's name; picked or changed by hand here.
  function jobLineHtml(inv, st, idx) {
    const j = inv.jobId ? idx.find(x => x.id === inv.jobId) : null;
    const how = inv.jobBy === 'name' ? ' (same name)' : '';
    if (picking === inv.id) {
      const open = idx.filter(x => !x.lost && x.status !== 'quoting').sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return '<div class="inv-jobpick"><select id="invJobSel" class="searchable">' +
        '<option value="">Not a job here (a storm, a one-off…)</option>' +
        open.map(x => '<option value="' + esc(x.id) + '"' + (x.id === inv.jobId ? ' selected' : '') + '>' +
          esc(x.name) + (x.est ? ' #' + esc(x.est) : '') + (x.status === 'complete' ? ' (finished)' : '') + '</option>').join('') +
        '</select><button class="btn btn-sm btn-filled" onclick="invSetJob(\'' + safe(inv.id) + '\')">Save</button>' +
        '<button class="btn btn-sm" onclick="invPickJob(\'\')">Cancel</button></div>';
    }
    return '<div class="inv-job">' + (j ? '🧱 ' + jobNameHtml(j.name, j.est) + '<span class="muted">' + esc(how) + '</span>'
        : inv.jobId ? '🧱 A job not on this device' : '<span class="muted">No job here</span>') +
      (changes() && st.kind !== 'paid' ? ' <button class="link-btn" onclick="invPickJob(\'' + safe(inv.id) + '\')">' + (inv.jobId ? 'Change' : 'Pick the job') + '</button>' : '') +
    '</div>';
  }
  function rowHtml(inv, st, idx) {
    const id = safe(inv.id);
    const emails = (inv.emails || []).filter(Boolean).sort();
    const facts = [];
    facts.push((emails.length ? 'Sent ' + shortDay(emails[0]) : inv.emailStatus === 'EmailSent' ? 'Emailed' : 'Not emailed') +
      (inv.viewed ? ' · 👀 opened' : ''));
    if (inv.dueDate && !st.rest && st.kind !== 'waiting') facts.push('Due ' + shortDay(inv.dueDate) + (st.late > 0 && st.kind !== 'paid'
      ? ' · <b class="inv-late">' + st.late + ' day' + (st.late === 1 ? '' : 's') + ' late</b>' : ''));
    (inv.payments || []).forEach(p => { if (p && p.amount > 0) facts.push('Paid ' + money(p.amount) + ' ' + shortDay(p.date)); });
    const hand = inv.handReminders || [];
    const rem = Math.max(0, emails.length - 1);
    if (rem || hand.length) {
      facts.push((rem ? rem + ' reminder' + (rem === 1 ? '' : 's') + ' emailed' : '') + (rem && hand.length ? ', ' : '') +
        (hand.length ? hand.length + ' by hand' : '') + ' — last ' + esc(shortDay(emails.concat(hand.map(h => h.at)).sort().slice(-1)[0])));
    }
    if (st.kind === 'paid' && inv.paidAt) facts.push('Paid off ' + shortDay(inv.paidAt));
    const can = changes() && st.kind !== 'paid';
    return '<div class="inv-row k-' + st.kind + '" id="invR_' + id + '">' +
      '<div class="inv-top"><span class="inv-who"><b>' + esc(inv.customerName || 'A customer') + '</b>' +
          (inv.docNumber ? ' <span class="muted">#' + esc(inv.docNumber) + '</span>' : '') + '</span>' +
        '<span class="inv-amt"><b>' + money(st.kind === 'paid' ? inv.total : inv.balance) + '</b>' +
          (st.kind !== 'paid' && Number(inv.balance) < Number(inv.total) - 0.005 ? '<small> of ' + money(inv.total) + '</small>' : '') + '</span></div>' +
      '<div class="inv-facts">' + facts.join(' · ') + '</div>' +
      jobLineHtml(inv, st, idx) +
      '<div class="inv-next">' + stateText(st, inv) + '</div>' +
      '<div class="inv-acts">' +
        (can && st.kind !== 'waiting' ? '<button class="btn btn-sm' + (wantsYou(st) ? ' btn-filled' : '') + '" onclick="invRemind(\'' + id + '\')"' +
          (busy[inv.id] ? ' disabled' : '') + '>' + (busy[inv.id] ? 'Sending…' : st.kind === 'unsent' ? '📧 Email it' : '📧 Send reminder') + '</button>' : '') +
        (can && st.kind !== 'waiting' ? '<button class="btn btn-sm" onclick="invHand(\'' + id + '\')">✔ Called or texted</button>' : '') +
        (can && wantsYou(st) && st.kind !== 'unsent' ? '<button class="btn btn-sm" onclick="invSnooze(\'' + id + '\')">Not yet — a week</button>' : '') +
        (inv.jobId && typeof loadJob === 'function' ? '<button class="btn btn-sm" onclick="invOpenJob(\'' + safe(inv.jobId) + '\')">The job</button>' : '') +
        (inv.link && /^https:\/\/[a-z.]*qbo\.intuit\.com\//.test(inv.link)
          ? '<a class="btn btn-sm" href="' + esc(inv.link) + '" target="_blank" rel="noopener">QuickBooks ↗</a>' : '') +
      '</div>' +
    '</div>';
  }

  // The rule itself, set by whoever may change billing.
  function rulesHtml() {
    const words = 'First reminder ' + rules.firstAfterDays + ' day' + (rules.firstAfterDays === 1 ? '' : 's') + ' after it’s due, then every ' +
      rules.everyDays + ' days, up to ' + rules.max + ' — then call.';
    if (!editingRules || !changes()) {
      return '<div class="inv-rules muted">⏰ ' + words + (changes() ? ' <button class="link-btn" onclick="invRules(true)">Change</button>' : '') + '</div>';
    }
    const box = (id, v, label) => '<label class="inv-rule"><span>' + label + '</span><input id="' + id + '" type="number" min="0" max="60" inputmode="numeric" value="' + v + '"></label>';
    return '<div class="inv-rules-edit">' +
      box('invFirst', rules.firstAfterDays, 'Days after it’s due for the first reminder') +
      box('invEvery', rules.everyDays, 'Days between reminders') +
      box('invMax', rules.max, 'Reminders before it’s time to call') +
      '<div class="field-actions"><button class="btn btn-sm btn-filled" onclick="invSaveRules()">Save</button>' +
      '<button class="btn btn-sm" onclick="invRules(false)">Cancel</button></div></div>';
  }

  // ------------------------------------------------------------- actions

  window.invPickJob = function (id) {
    picking = id || '';
    render();
    const sel = el('invJobSel');
    if (sel && typeof makeSearchable === 'function') makeSearchable(sel);
  };
  // Picked by hand: kept whatever the hourly look would have said
  // (quickbooks.py _inv_doc, jobBy 'hand').
  window.invSetJob = function (id) {
    const inv = invoices[id], sel = el('invJobSel');
    if (!inv || !sel || !changes()) return;
    inv.jobId = sel.value || null;
    inv.jobBy = 'hand';
    picking = '';
    render();
    Promise.resolve(window.YDDb.put('invoices', inv.id, { jobId: inv.jobId, jobBy: 'hand', updatedAt: new Date().toISOString() }))
      .catch(e => showToast(e && e.code === 'permission-denied' ? 'Not allowed — Billing access needed' : 'Saved on this device — it goes up with signal'));
  };
  window.invView = function (v) { view = ['todo', 'owed', 'paid'].indexOf(v) !== -1 ? v : 'todo'; render(); };
  // As search.js opens one: the job already in the form is just shown.
  window.invOpenJob = async function (jobId) {
    if (typeof currentJobId !== 'undefined' && currentJobId === jobId) { switchTab('job'); return; }
    if (!(await ydLeaveUnsavedJob())) return;
    if (typeof loadJob === 'function') loadJob(jobId);
  };
  window.invRemind = async function (id) {
    const inv = invoices[id];
    if (!inv || !changes() || busy[id] || !window.YDClaude) return;
    const st = stateOf(inv);
    // Goes to the customer, so it is asked every time.
    if (!(await ydConfirm('Invoice' + (inv.docNumber ? ' #' + inv.docNumber : '') + ' (' + money(inv.balance) + ' owed) goes to ' +
        (inv.email || inv.customerName) + ' from QuickBooks.',
        { title: st.kind === 'unsent' ? 'Email the invoice?' : 'Email a reminder?', ok: 'Email it' }))) return;
    if (busy[id]) return;
    busy[id] = true; render();
    try {
      await window.YDClaude.post('/qb/invoice-remind', { id: inv.id });
      showToast('📧 Sent to ' + (inv.email || inv.customerName));
    } catch (e) {
      showToast('Not sent: ' + String((e && e.message) || e).slice(0, 140), 7000);
    } finally {
      delete busy[id]; render();
    }
  };
  // A call or a text counts as a reminder too, so the next one is timed from it.
  // How, as a button each -- one tap; Other takes a few words.
  const HAND_WAYS = [{ id: 'Called', label: 'Called' }, { id: 'Texted', label: 'Texted' },
    { id: 'In person', label: 'In person' }, { id: 'Emailed', label: 'Emailed', hint: 'myself, not from QuickBooks' },
    { id: 'Left a message', label: 'Left a message' }, { id: 'other', label: 'Other', ask: 'How, in a few words' }];
  window.invHand = async function (id) {
    if (!invoices[id] || !changes()) return;
    const at = new Date().toISOString();
    const pick = await ydChoose('How did you remind ' + (invoices[id].customerName || 'them') + '?', HAND_WAYS,
      { title: 'Reminded them yourself' });
    if (!pick) return;
    const inv = invoices[id];
    if (!inv) return;
    const how = pick.id === 'other' ? pick.text : pick.id;
    const me = (window.YDAuth && window.YDAuth.user && (window.YDAuth.user.displayName || window.YDAuth.user.email)) || '';
    const hand = (inv.handReminders || []).concat([{ at: at, how: String(how).trim().slice(0, 60) || 'By hand', by: me }]);
    inv.handReminders = hand;
    render();
    Promise.resolve(window.YDDb.put('invoices', inv.id, { handReminders: hand, updatedAt: new Date().toISOString() }))
      .catch(e => showToast(e && e.code === 'permission-denied' ? 'Not allowed — Billing access needed' : 'Saved on this device — it goes up with signal'));
  };
  window.invSnooze = function (id) {
    const inv = invoices[id];
    if (!inv || !changes()) return;
    inv.snoozeUntil = addDays(today(), 7);
    render();
    Promise.resolve(window.YDDb.put('invoices', inv.id, { snoozeUntil: inv.snoozeUntil, updatedAt: new Date().toISOString() }))
      .catch(e => console.warn('[invoices] not put off on the server yet:', e && (e.code || e.message)));
  };
  window.invCheckNow = async function () {
    if (!changes() || !window.YDClaude) return;
    showToast('Checking QuickBooks…');
    try { await window.YDClaude.post('/qb/invoices-now', {}); showToast('Invoices up to date'); }
    catch (e) { showToast('Could not check: ' + String((e && e.message) || e).slice(0, 120), 6000); }
  };
  window.invRules = function (on) { editingRules = !!on; render(); };
  window.invSaveRules = function () {
    const n = id => { const v = parseInt((el(id) || {}).value, 10); return isFinite(v) && v >= 0 && v <= 60 ? v : null; };
    const next = { firstAfterDays: n('invFirst'), everyDays: n('invEvery'), max: n('invMax') };
    if (Object.values(next).some(v => v === null) || next.everyDays < 1 || next.max < 1) {
      showToast('Whole numbers — at least 1 day between reminders and 1 reminder'); return;
    }
    rules = next;
    editingRules = false;
    render();
    Promise.resolve(window.YDDb.put('settings', 'invoiceReminders', Object.assign({ updatedAt: new Date().toISOString() }, next)))
      .catch(e => showToast(e && e.code === 'permission-denied' ? 'Not allowed — Billing access needed' : 'Saved on this device — it goes up with signal'));
  };
  // Home's "Waiting on you" opens the list here.
  window.openInvoices = function () {
    if (typeof switchTab === 'function') switchTab('dashboard');
    view = 'todo'; render();
    const s = el('invSection');
    if (s && s.scrollIntoView) s.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  // ------------------------------------------------------------- data

  function start() {
    stop();
    if (!window.YDDb || !sees()) return;
    unsub = window.YDDb.watch('invoices', (changes, meta) => {
      changes.forEach(c => {
        if (c.type === 'removed') delete invoices[c.id];
        else invoices[c.id] = Object.assign({ id: c.id }, c.data);
      });
      if (meta && !meta.fromCache) loaded = true;
      else if (Object.keys(invoices).length) loaded = true;
      render();
      document.dispatchEvent(new CustomEvent('yd-invoices'));
    }, () => { loaded = true; render(); });
    Promise.resolve(window.YDDb.get('settings', 'invoiceReminders')).then(r => {
      if (r) Object.keys(RULES).forEach(k => { if (typeof r[k] === 'number' && r[k] >= 0) rules[k] = r[k]; });
      render();
    }).catch(() => {});
  }
  function stop() {
    if (unsub) { try { unsub(); } catch (e) { /* already gone */ } }
    unsub = null; invoices = {}; loaded = false;
  }

  window.YDInvoices = {
    all: () => invoices,
    stateOf: stateOf,
    // About what a deposit is, as the list says it (Home's rows).
    depositOf: depositOf,
    // Search (search.js): the list on All Jobs, on the view that holds this
    // invoice; its row, to light up.
    show: function (id) {
      const inv = invoices[id];
      if (typeof switchTab === 'function') switchTab('dashboard');
      if (inv) { const st = stateOf(inv); view = st.kind === 'paid' ? 'paid' : wantsYou(st) ? 'todo' : 'owed'; }
      picking = '';
      render();
      return el('invR_' + safe(id));
    },
    // What wants doing, most late first (Home).
    toDo: () => Object.values(invoices).map(inv => ({ inv, st: stateOf(inv) })).filter(x => wantsYou(x.st))
      .sort((a, b) => (b.st.late || 0) - (a.st.late || 0)),
    render: render,
  };

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user && sees();
    const k = on ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k === authKey) return;
    authKey = k;
    if (on) start(); else stop();
    render();
  });
  // Which job is finished moves an invoice on (waiting -> reminders).
  document.addEventListener('yd-jobs-changed', render);
  function watchPanel() {
    const p = el('panel-dashboard');
    if (!p || typeof MutationObserver !== 'function') return;
    panelWatched = true;
    new MutationObserver(() => { if (dirty && onScreen()) render(); }).observe(p, { attributes: true, attributeFilter: ['class'] });
  }
  function boot() { watchPanel(); render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
