// Receipts -- a tab of its own: the ones to sort, then every one so far.
//
// The server reads the owner's email every half hour (functions/receipts.py)
// and writes each purchase it finds to receipts/{id}: the store, the date,
// every line, the tax and the total, and a job it thinks the purchase is for
// when the delivery address or a name on the order says so. This screen is
// where each one is put against a job.
//
// "Add to job" puts the ticked lines into that job's materials (Tracking),
// one materials line per receipt line, plus that job's share of the sales
// tax, so the job carries what was actually paid. The lines go in through
// YDSync.patchJob -- the same road a board move takes -- so this device's
// copy, the cloud and the crew's job list all follow, and a job open in the
// form keeps what is being typed into it. Every line carries the receipt's id
// and the split's id, which is what makes Undo exact.
//
// An order is nearly always for one job, so that is the whole screen: pick
// the job, Add to job, and every line goes on. For the odd order that covers
// two, "Split across jobs" brings up a tick box per line: add some lines to
// one job, the rest to another. Tax is shared out by value, and the last
// split takes whatever cent is left so the jobs add up to the receipt exactly.

(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const safeId = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const endpoint = () => ((window.YD_CONFIG || {}).claudeEndpoint || '').replace(/\/+$/, '');
  const money = c => fmtMoney((Number(c) || 0) / 100);
  const me = () => (window.YDAuth && window.YDAuth.user) || null;

  let receipts = {};          // id -> record
  let state = null;           // settings/receipts: when email was last read
  let unsubs = [];
  let loaded = false;
  let checking = false;
  let deferred = false;       // a redraw held back while something is being chosen
  const ticked = {};          // receipt id -> Set of line indexes, once changed by hand
  const chosen = {};          // receipt id -> job id picked
  const splitting = {};       // receipt id -> true once "Split across jobs" is pressed

  const KIND = {
    materials: 'Materials', plants: 'Plants', dump_and_disposal: 'Dump & disposal',
    equipment_and_repairs: 'Equipment & repairs', fuel: 'Fuel', tools: 'Tools', rental: 'Rental',
    subcontractor: 'Subcontractor', vehicle: 'Vehicle', office_and_software: 'Office & software',
    insurance: 'Insurance', utilities_and_phone: 'Utilities & phone', other: 'Other',
  };
  const WHY = { overhead: 'Shop / overhead', personal: 'Personal (deletes it)', notPurchase: 'Not a purchase',
    alreadyEntered: 'Already entered' };

  const sees = () => typeof ydCan === 'function' && ydCan('jobs', 'see');
  const sorts = () => typeof ydCan === 'function' && ydCan('jobs', 'change');

  // ------------------------------------------------------------ the record

  // Which lines already sit on a job, and on which.
  function splitOf(r) {
    const at = {};
    (r.splits || []).forEach(s => (s.lines || []).forEach(i => { at[i] = s; }));
    return at;
  }
  function freeLines(r) {
    const at = splitOf(r);
    return (r.lines || []).map((_, i) => i).filter(i => !at[i]);
  }
  // Split up, either because it was asked for or because part of it is
  // already on a job.
  function isSplit(rid, r) {
    return !!splitting[rid] || (r.splits || []).length > 0;
  }
  function tickedLines(rid, r) {
    const free = freeLines(r);
    return ticked[rid] && isSplit(rid, r) ? free.filter(i => ticked[rid].has(i)) : free;
  }

  function jobsList() {
    const order = { inprogress: 0, booked: 1, quoting: 2, complete: 3 };
    return (typeof loadAllJobs === 'function' ? loadAllJobs() : [])
      .filter(j => j && j._id)
      .map(j => ({ id: j._id, name: (j.customerName || '').trim() || 'Untitled job',
        est: String(j.estimateNumber || '').trim(), status: normStatus(j.jobStatus, j) }))
      .sort((a, b) => (order[a.status] - order[b.status]) || a.name.localeCompare(b.name));
  }
  function jobLabel(j) {
    return j.name + (j.est ? ' #' + j.est : '') + (j.status === 'complete' ? ' (complete)' : '');
  }

  // ------------------------------------------------------------ writing

  // Not awaited: a write only settles when the server answers, and a truck
  // with no signal would sit frozen. Firestore holds it until then.
  function write(rid, data) {
    data.updatedAt = new Date().toISOString();
    data.updatedBy = (me() || {}).uid || '';
    Promise.resolve(window.YDDb.put('receipts', rid, data)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[receipts] not yet on the server:', (e && e.code) || e);
    });
  }

  // Change one job's materials by a function, wherever that job is: through
  // patchJob for the stored copy, and -- when it is open in the form with
  // unsaved typing -- in the form too, so its next save keeps the change.
  function changeJobMaterials(jobId, fn) {
    let job;
    try { job = JSON.parse(readJobBlob(jobId) || 'null'); } catch (e) { job = null; }
    if (!job) { showToast('That job is not on this device yet'); return null; }
    const openWithEdits = jobId === currentJobId && dirty;
    if (!window.YDSync || !YDSync.patchJob(jobId, { materials: fn(job.materials || []) })) {
      showToast('Could not change that job');
      return null;
    }
    if (openWithEdits) { materials = fn(materials); renderMaterials(); }
    return job;
  }

  // ------------------------------------------------------------ actions

  window.rcTick = function (rid, i, on) {
    const r = receipts[rid];
    if (!r) return;
    if (!ticked[rid]) ticked[rid] = new Set(freeLines(r));
    if (on) ticked[rid].add(i); else ticked[rid].delete(i);
    redraw();
  };

  window.rcPickJob = function (rid, jobId) {
    chosen[rid] = jobId;
  };

  window.rcSplit = function (rid, on) {
    if (on) splitting[rid] = true; else { delete splitting[rid]; delete ticked[rid]; }
    redraw(true);
  };

  window.rcAssign = function (rid) {
    if (!sorts()) { showToast('You can look at jobs but not change them'); return; }
    const r = receipts[rid];
    if (!r) return;
    const jobId = chosen[rid] != null ? chosen[rid] : ((r.suggest && r.suggest.jobId) || '');
    if (!jobId) { showToast('Pick the job first'); return; }
    const free = freeLines(r);
    const idxs = tickedLines(rid, r);
    if (!idxs.length) { showToast('Tick at least one line'); return; }

    const lines = r.lines || [];
    const all = lines.reduce((s, l) => s + (l.cents || 0), 0);
    const part = idxs.reduce((s, i) => s + (lines[i].cents || 0), 0);
    const last = idxs.length === free.length;
    const taxSoFar = (r.splits || []).reduce((s, x) => s + (x.taxCents || 0), 0);
    const tax = last ? (r.taxCents || 0) - taxSoFar
      : (all ? Math.round((r.taxCents || 0) * part / all) : 0);

    const sid = 'sp' + Date.now().toString(36) + uid();
    const from = (r.vendor || 'Receipt') + (r.orderNo ? ' #' + r.orderNo : '');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : localYMD();
    const add = idxs.map(i => {
      const l = lines[i];
      return { id: uid(), item: l.name || 'Item', date, location: from,
        price: ((l.cents || 0) / 100).toFixed(2), qty: l.qty ? String(l.qty) : '', unit: l.unit || '',
        receiptId: rid, splitId: sid };
    });
    if (tax) add.push({ id: uid(), item: 'Sales tax', date, location: from, price: (tax / 100).toFixed(2),
      qty: '', unit: '', receiptId: rid, splitId: sid });

    const job = changeJobMaterials(jobId, list => list.concat(add));
    if (!job) return;
    const splits = (r.splits || []).concat([{
      id: sid, jobId, jobName: (job.customerName || '').trim() || 'Untitled job',
      est: String(job.estimateNumber || '').trim(), lines: idxs, cents: part, taxCents: tax,
      at: new Date().toISOString(), by: (me() || {}).uid || '',
    }]);
    const status = last ? 'done' : (r.status === 'skipped' ? 'skipped' : 'new');
    // Shown at once rather than when the server echoes it back.
    receipts[rid] = Object.assign({}, r, { splits, status });
    delete ticked[rid]; delete chosen[rid];
    write(rid, { splits, status });
    showToast(add.length + ' line' + (add.length === 1 ? '' : 's') + ' (' + money(part + tax) + ') added to ' +
      splits[splits.length - 1].jobName);
    redraw(true);
  };

  window.rcUndo = function (rid, sid) {
    if (!sorts()) { showToast('You can look at jobs but not change them'); return; }
    const r = receipts[rid];
    const s = r && (r.splits || []).find(x => x.id === sid);
    if (!s) return;
    if (!confirm('Take these lines back off ' + s.jobName + '?')) return;
    // A job deleted since has nothing left to take back.
    if (readJobBlob(s.jobId)) {
      if (!changeJobMaterials(s.jobId, list => list.filter(m => !(m.receiptId === rid && m.splitId === sid)))) return;
    }
    const splits = (r.splits || []).filter(x => x.id !== sid);
    const status = r.status === 'skipped' ? 'skipped' : 'new';
    receipts[rid] = Object.assign({}, r, { splits, status });
    write(rid, { splits, status });
    redraw(true);
  };

  // Deleting a receipt only removes it from the hub: the email stays in Gmail,
  // and the server remembers it has read that email, so it never comes back.
  // Lines already put on a job stay on the job. The owner's alone (rules).
  const owner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  function drop(ids) {
    ids.forEach(id => { delete receipts[id]; delete ticked[id]; delete chosen[id]; delete splitting[id]; });
    Promise.resolve(window.YDDb.removeMany(ids.map(id => ['receipts', id])))
      .catch(e => console.warn('[receipts] not deleted:', (e && e.code) || e));
    redraw(true);
  }
  window.rcDelete = function (rid) {
    const r = receipts[rid];
    if (!r || !owner()) return;
    if (!confirm('Delete this ' + (r.vendor || '') + ' receipt from the hub?' +
      ((r.splits || []).length ? ' Lines already added to jobs stay on the jobs.' : ''))) return;
    drop([rid]);
    showToast('Deleted');
  };
  window.rcDeleteAside = function () {
    const ids = Object.keys(receipts).filter(id => receipts[id].status === 'skipped');
    if (!ids.length || !owner()) return;
    if (!confirm('Delete all ' + ids.length + ' set-aside receipts from the hub?')) return;
    drop(ids);
    showToast(ids.length + ' deleted');
  };

  window.rcSkip = function (rid, why) {
    if (!why || !receipts[rid]) return;
    if (!sorts()) { showToast('You can look at jobs but not change them'); redraw(true); return; }
    // Personal purchases have no business in the hub at all.
    if (why === 'personal' && owner()) { drop([rid]); showToast('Personal — deleted from the hub'); return; }
    receipts[rid] = Object.assign({}, receipts[rid], { status: 'skipped', skipWhy: why });
    write(rid, { status: 'skipped', skipWhy: why, skippedBy: (me() || {}).uid || '' });
    showToast('Set aside — find it under "Set aside" if that was wrong');
    redraw(true);
  };

  window.rcPutBack = function (rid) {
    const r = receipts[rid];
    if (!r) return;
    if (!sorts()) { showToast('You can look at jobs but not change them'); return; }
    const status = freeLines(r).length ? 'new' : 'done';
    receipts[rid] = Object.assign({}, r, { status, skipWhy: '' });
    write(rid, { status, skipWhy: '', skippedBy: '' });
    redraw(true);
  };

  async function ask(path) {
    const user = me();
    if (!user) throw new Error('Not signed in');
    if (!endpoint()) throw new Error('The server address is not configured');
    const token = await user.getIdToken();
    const res = await fetch(endpoint() + path, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('failed (' + res.status + ')'));
    return data;
  }

  window.rcCheckNow = async function () {
    if (checking) return;
    if (!sorts()) { showToast('You can look at jobs but not change them'); return; }
    checking = true; redraw(true);
    try {
      const rep = (await ask('/receipts/now')).report || {};
      if (rep.busy) showToast('Already checking — new receipts will appear here');
      else if (rep.needsPermission) showToast('Reading email is not switched on yet');
      else {
        const found = (rep.new || 0) + (rep.added || 0);
        showToast(found ? found + ' receipt' + (found === 1 ? '' : 's') + ' found'
          + (rep.waiting ? ' — ' + rep.waiting + ' more on the next check' : '')
          : 'No new receipts' + (rep.waiting ? ' yet — ' + rep.waiting + ' waiting for the next check' : ''));
      }
    } catch (e) {
      showToast('Could not check email: ' + e.message);
    }
    checking = false;
    await loadState();
    redraw(true);
  };

  // ------------------------------------------------------------ drawing

  function lineHtml(rid, r, i, at, isTicked, split) {
    const l = r.lines[i];
    const s = at[i];
    const qty = l.qty ? ' <span class="muted">' + esc(String(l.qty)) + (l.unit ? ' ' + esc(l.unit) : '') + '</span>' : '';
    if (!split) {
      return '<div class="rc-line rc-plain"><span class="rc-lname">' + esc(l.name) + qty + '</span>' +
        '<span class="rc-lamt">' + money(l.cents) + '</span></div>';
    }
    return '<label class="rc-line' + (s ? ' rc-on-job' : '') + '">' +
      '<input type="checkbox"' + (s ? ' checked disabled' : (isTicked ? ' checked' : '')) +
        (s ? '' : ' onchange="rcTick(\'' + rid + '\',' + i + ',this.checked)"') + '>' +
      '<span class="rc-lname">' + esc(l.name) + qty +
        (s ? ' <span class="rc-ljob">→ ' + jobNameHtml(s.jobName, s.est) + '</span>' : '') + '</span>' +
      '<span class="rc-lamt">' + money(l.cents) + '</span></label>';
  }

  function splitsHtml(rid, r) {
    return (r.splits || []).map(s =>
      '<div class="rc-split"><span>Added to <b>' + jobNameHtml(s.jobName, s.est) + '</b> — ' +
        (s.lines || []).length + ' line' + ((s.lines || []).length === 1 ? '' : 's') +
        (s.taxCents ? ' + tax' : '') + ', ' + money((s.cents || 0) + (s.taxCents || 0)) + '</span>' +
        (sorts() ? '<button class="btn btn-sm" onclick="rcUndo(\'' + rid + '\',\'' + safeId(s.id) + '\')">Undo</button>' : '') +
      '</div>').join('');
  }

  function cardHtml(r, jobs) {
    const rid = safeId(r.id);
    const at = splitOf(r);
    const free = freeLines(r);
    const tickedSet = new Set(tickedLines(rid, r));
    const pick = chosen[rid] != null ? chosen[rid] : ((r.suggest && r.suggest.jobId) || '');
    const sug = r.suggest && jobs.find(j => j.id === r.suggest.jobId);
    const owed = r.paid === false && r.docType === 'invoice';
    const split = isSplit(rid, r);
    return '<div class="rc-card" id="rc_' + rid + '">' +
      '<div class="rc-top">' +
        '<span class="rc-vendor">' + esc(r.vendor || 'Receipt') + '</span>' +
        (r.orderNo ? '<span class="rc-tag">#' + esc(r.orderNo) + '</span>' : '') +
        '<span class="rc-tag">' + fmtDateMD(r.date) + '</span>' +
        (owed ? '<span class="rc-tag rc-owed">Owed</span>' : '') +
        '<span class="rc-total">' + money(r.totalCents) + '</span>' +
      '</div>' +
      '<div class="rc-sum">' + esc(r.summary || '') +
        ' <span class="muted">· ' + esc(KIND[r.kind] || 'Other') + '</span></div>' +
      (r.whose === 'unsure' ? '<div class="rc-note">Claude was not sure this one is for the business.</div>' : '') +
      (sug && free.length ? '<div class="rc-suggest">Looks like <b>' + jobNameHtml(sug.name, sug.est) + '</b> — ' +
        esc(r.suggest.why || '') + '</div>' : '') +
      (split && free.length ? '<div class="rc-hint">Tick the lines for one job, add them, then do the rest.' +
        ((r.splits || []).length ? '' : ' <button class="rc-link" onclick="rcSplit(\'' + rid + '\', false)">All one job after all</button>') +
        '</div>' : '') +
      '<div class="rc-lines">' +
        (r.lines || []).map((_, i) => lineHtml(rid, r, i, at, tickedSet.has(i), split)).join('') +
        (r.taxCents ? '<div class="rc-line rc-taxrow' + (split ? '' : ' rc-plain') + '">' + (split ? '<span></span>' : '') +
          '<span class="rc-lname">Sales tax' +
          (split && free.length ? ' <span class="muted">(shared by value)</span>' : '') +
          '</span><span class="rc-lamt">' + money(r.taxCents) + '</span></div>' : '') +
      '</div>' +
      (!split && free.length > 1 && sorts() ?
        '<button class="rc-link" onclick="rcSplit(\'' + rid + '\', true)">Split across jobs</button>' : '') +
      splitsHtml(rid, r) +
      (free.length && sorts() ?
        '<div class="rc-assign">' +
          '<select class="searchable" id="rcJob_' + rid + '" onchange="rcPickJob(\'' + rid + '\', this.value)">' +
            '<option value="">Which job?</option>' +
            jobs.map(j => '<option value="' + safeId(j.id) + '"' + (j.id === pick ? ' selected' : '') + '>' +
              esc(jobLabel(j)) + '</option>').join('') +
          '</select>' +
          '<button class="btn btn-sm btn-filled" onclick="rcAssign(\'' + rid + '\')">Add ' +
            (tickedSet.size === free.length ? 'to job' : tickedSet.size + ' to job') + '</button>' +
        '</div>' : '') +
      '<div class="rc-foot">' +
        (r.link ? '<a class="btn btn-sm" href="' + esc(r.link) + '" target="_blank" rel="noopener">Open the email</a>' : '') +
        (sorts() ? '<select class="rc-skip" onchange="rcSkip(\'' + rid + '\', this.value)">' +
          '<option value="">' + ((r.splits || []).length ? 'The rest is not a job cost…' : 'Not a job cost…') + '</option>' +
          Object.keys(WHY).map(k => '<option value="' + k + '">' + WHY[k] + '</option>').join('') +
        '</select>' : '') +
        (owner() ? '<button class="btn btn-sm rc-del" onclick="rcDelete(\'' + rid + '\')">🗑 Delete</button>' : '') +
      '</div>' +
    '</div>';
  }

  // One line in All receipts: what it was, when, what it came to, and where
  // it went -- the jobs it was put on, or why it was set aside.
  function rowHtml(r) {
    const rid = safeId(r.id);
    const where = r.status === 'skipped'
      ? '<span class="rc-tag">' + esc(r.skippedBy === 'claude' ? 'Personal (Claude)' : (WHY[r.skipWhy] || 'Set aside')) + '</span>'
      : r.status === 'new' ? '<span class="rc-tag rc-owed">To sort</span>' : '';
    return '<div class="rc-row"><span class="rc-row-main"><b>' + esc(r.vendor || 'Receipt') + '</b> ' +
        '<span class="muted">' + fmtDateMD(r.date) + (r.orderNo ? ' · #' + esc(r.orderNo) : '') + '</span> ' +
        esc(r.summary || '') + '</span>' + where +
        '<span class="rc-row-amt">' + money(r.totalCents) + '</span>' +
        (r.link ? '<a class="btn btn-sm" href="' + esc(r.link) + '" target="_blank" rel="noopener">Email</a>' : '') +
        (r.status === 'skipped' && sorts() ? '<button class="btn btn-sm" onclick="rcPutBack(\'' + rid + '\')">Put back</button>' : '') +
        (owner() ? '<button class="btn btn-sm rc-del" onclick="rcDelete(\'' + rid + '\')" title="Delete">🗑</button>' : '') +
      '</div>' +
      ((r.splits || []).length ? '<div class="rc-row-splits">' + splitsHtml(rid, r) + '</div>' : '');
  }

  function stateHtml() {
    if (!state) return '';
    if (state.needsPermission) {
      return '<div class="rc-note">Reading email is not switched on yet. In the Google Admin console, the ' +
        'Job Hub service needs <b>gmail.readonly</b> added beside gmail.send and gmail.compose.</div>';
    }
    if (!state.lastRunAt) return '';
    const t = new Date(state.lastRunAt);
    const when = isNaN(t) ? '' : t.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return when ? '<span class="muted">Email last checked ' + esc(when) + '</span>' : '';
  }

  const byNewest = (a, b) => String(b.date || '').localeCompare(String(a.date || '')) ||
    String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  function allReceipts() {
    return Object.keys(receipts).map(id => Object.assign({ id }, receipts[id]));
  }

  // The count on the tab, and a dot on More for a phone, where Receipts sits
  // behind More.
  function badges(open) {
    const c = el('rcTabCount');
    if (c) c.textContent = open ? String(open) : '';
    const more = el('tabMore');
    if (more) more.toggleAttribute('data-dot', open > 0);
    // What More says under "Receipts" when it is opened.
    if (typeof TAB_HINT === 'object') {
      TAB_HINT.receipts = open ? '🟡 ' + open + ' to sort' : 'Purchases from your email — put each on its job';
    }
  }

  function render() {
    const sec = el('rcSection'), hist = el('rcHistorySection'), tab = el('tabReceipts');
    if (!sec) return;
    const on = !!(window.YDAuth && window.YDAuth.mode === 'cloud' && window.YDAuth.user) && sees();
    sec.hidden = hist.hidden = !on;
    if (tab) tab.hidden = !on;
    if (!on) { badges(0); return; }

    const all = allReceipts();
    const open = all.filter(r => r.status === 'new').sort(byNewest);
    const jobs = jobsList();
    badges(open.length);

    el('rcBadge').textContent = open.length ? open.length + ' to sort' : '';
    el('rcBar').innerHTML =
      (sorts() ? '<button class="btn btn-sm" onclick="rcCheckNow()"' + (checking ? ' disabled' : '') + '>' +
        (checking ? 'Checking email…' : '📧 Check email now') + '</button>' : '') + stateHtml();
    el('rcList').innerHTML = !loaded ? '<p class="empty-msg">Loading receipts…</p>'
      : open.length ? open.map(r => cardHtml(r, jobs)).join('')
      : '<p class="empty-msg">Nothing to sort. Receipts that arrive by email show up here by themselves.</p>';
    renderHistory();
  }

  // ------------------------------------------------------------ All receipts

  const VIEWS = { all: 'All', done: 'Sorted', skipped: 'Set aside' };
  let view = 'all';
  window.rcView = function (v) { if (VIEWS[v]) { view = v; renderHistory(); } };
  // Typing in the search box redraws only the list under it, so the box keeps
  // its focus and what was typed.
  window.rcSearchNow = function () { renderHistory(); };

  function matches(r, words) {
    if (!words.length) return true;
    const hay = [r.vendor, r.orderNo, r.summary, r.date,
      (r.lines || []).map(l => l.name + ' ' + (l.itemNo || '')).join(' '),
      (r.splits || []).map(x => x.jobName + ' ' + (x.est || '')).join(' ')].join(' ').toLowerCase();
    return words.every(w => hay.indexOf(w) !== -1);
  }

  function renderHistory() {
    const wrap = el('rcHistory');
    if (!wrap) return;
    const words = String((el('rcSearch') || {}).value || '').toLowerCase().split(/\s+/).filter(Boolean);
    const every = allReceipts().filter(r => r.status !== 'new');
    const shown = every.filter(r => (view === 'all' || r.status === view) && matches(r, words)).sort(byNewest);
    const aside = every.filter(r => r.status === 'skipped');
    el('rcHistBadge').textContent = every.length ? String(every.length) : '';
    el('rcHistBar').innerHTML = Object.keys(VIEWS).map(v =>
      '<button class="btn btn-sm' + (view === v ? ' btn-filled' : '') + '" onclick="rcView(\'' + v + '\')">' +
      VIEWS[v] + '</button>').join('') +
      (view === 'skipped' && aside.length && owner()
        ? '<button class="btn btn-sm rc-del" onclick="rcDeleteAside()">🗑 Delete all ' + aside.length + ' set aside</button>' : '');

    if (!shown.length) {
      wrap.innerHTML = '<p class="empty-msg">' + (words.length ? 'Nothing matches.' : 'Nothing here yet.') + '</p>';
      return;
    }
    // By month, newest first, each with what it came to.
    const months = [];
    shown.slice(0, 300).forEach(r => {
      const key = String(r.date || '').slice(0, 7);
      let m = months[months.length - 1];
      if (!m || m.key !== key) { m = { key, rows: [], cents: 0 }; months.push(m); }
      m.rows.push(r); m.cents += r.totalCents || 0;
    });
    const label = key => {
      const d = new Date(key + '-01T12:00:00');
      return isNaN(d) ? 'No date' : d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    };
    wrap.innerHTML = months.map(m =>
      '<div class="rc-month"><span>' + esc(label(m.key)) + '</span><span>' + m.rows.length + ' · ' +
        money(m.cents) + '</span></div>' + m.rows.map(rowHtml).join('')).join('') +
      (shown.length > 300 ? '<p class="empty-msg">Showing the newest 300 — search to find older ones.</p>' : '');
  }

  // A snapshot arriving while a job is being chosen would rebuild the list
  // under the person's finger and lose what they typed into the picker. Hold
  // it until they move on.
  function redraw(force) {
    const p = el('panel-receipts');
    if (!p || !p.classList.contains('active')) {
      // Off screen, only the counts on the tab and on More need to be right.
      deferred = true;
      badges(Object.values(receipts).filter(r => r.status === 'new').length);
      return;
    }
    const sec = el('rcSection');
    if (!force && sec && sec.contains(document.activeElement) && document.activeElement !== document.body) {
      deferred = true;
      return;
    }
    deferred = false;
    render();
  }
  document.addEventListener('focusout', () => {
    if (deferred) setTimeout(() => {
      const sec = el('rcSection');
      if (!sec || !sec.contains(document.activeElement)) redraw();
    }, 0);
  });
  // The job list comes from jobs, which arrive and change on their own.
  document.addEventListener('yd-jobs-changed', () => redraw());

  // ------------------------------------------------------------ data

  async function loadState() {
    // Kept with the owner's settings; an admin simply does not see it.
    try { state = await window.YDDb.get('settings', 'receipts'); } catch (e) { state = null; }
  }

  function stop() {
    unsubs.forEach(u => { try { u(); } catch (e) {} });
    unsubs = []; receipts = {}; state = null; loaded = false;
  }
  function start() {
    stop();
    unsubs.push(window.YDDb.watch('receipts', (changes, meta) => {
      changes.forEach(c => {
        if (c.type === 'removed') delete receipts[c.id];
        else receipts[c.id] = c.data;
      });
      if (meta && meta.fromCache === false) loaded = true;
      if (changes.length || loaded) redraw();
    }, () => { loaded = true; redraw(); }));
    if (window.YDAuth && window.YDAuth.isOwner) loadState().then(() => redraw());
  }

  // Opening Receipts also re-reads when email was last checked: the half-
  // hourly run may have changed it (switched on, say) since the app opened.
  window.YDReceipts = {
    render: () => {
      redraw(true);
      if (window.YDAuth && window.YDAuth.isOwner && window.YDDb) loadState().then(() => redraw(true));
    },
  };

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user && sees();
    const k = on ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k !== authKey) {
      authKey = k;
      if (on && window.YDDb) start(); else stop();
    }
    render();
  });
})();
