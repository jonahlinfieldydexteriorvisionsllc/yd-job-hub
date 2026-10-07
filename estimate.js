// Estimates: built on the Job tab, sent to the customer through QuickBooks.
//
// How Jonah works: he writes what the job is, in his own words ("16x20 paver
// patio, two steps, 40 ft of steel edging"), presses Build with Claude, checks
// the lines, and sends it. QuickBooks numbers it, emails it, and records the
// customer's answer; invoicing and payment then happen in QuickBooks.
//
// THE PRICE BOOK is what the business charges -- priceBook/{id}: name, unit,
// priceCents, category, description (what the customer reads), notes (his
// pricing rules, read by Claude), qbItemId (the matching QuickBooks product,
// filled in by the server the first time it is used). Claude chooses entries
// and quantities; the rate on a price-book line always comes from the book
// (the server copies it, and so does this file), so an estimate cannot go out
// at a price he did not set unless he types it himself.
//
// THE ESTIMATE lives on the job as `estimate` {ask, lines, memo, questions},
// saved with the form like the materials list. What QuickBooks has is
// `qbEstimate` {id, docNumber, customerId, status, sentAt, link…}, written by
// the server and patched in here, carried through form saves (BOARD_FIELDS).
// When the estimate has lines, the job price follows its total.

(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const safeId = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const cents = c => fmtMoney((Number(c) || 0) / 100);
  const sees = () => typeof ydCan === 'function' && ydCan('jobs', 'see');
  const changes = () => typeof ydCan === 'function' && ydCan('jobs', 'change');
  const sends = () => typeof ydCan === 'function' && ydCan('billing', 'change');

  let est = blank();
  let book = {};              // price book, id -> entry
  let unsub = null;
  let building = false, saving = false, checking = false;
  const checkedAt = {};       // job id -> when its QuickBooks status was last asked for
  let draftMsg = '';          // what is typed in the chat box, not sent yet
  let undo = null;            // {jobId, lines, memo} from before Claude's last change

  // chat: the conversation with Claude about this estimate, [{role, text, at,
  // changed}] -- kept with the job so it can be picked up again later.
  function blank() { return { ask: '', lines: [], memo: '', questions: [], chat: [] }; }
  const CHAT_KEEP = 60;

  // ------------------------------------------------------------- the money

  // A line's amount in cents, from quantity and rate; never NaN.
  function lineCents(l) {
    if (l.kind === 'section') return 0;
    const q = Number(l.qty), r = Number(l.rateCents);
    return isFinite(q) && isFinite(r) ? Math.round(q * r) : 0;
  }
  function subtotalCents() { return est.lines.reduce((s, l) => s + lineCents(l), 0); }
  const items = () => est.lines.filter(l => l.kind !== 'section');

  // ------------------------------------------------------- the job's record

  window.YDEstimate = {
    get() {
      return { ask: est.ask || '', memo: est.memo || '', questions: (est.questions || []).slice(),
               lines: est.lines.map(l => Object.assign({}, l)),
               chat: est.chat.slice(-CHAT_KEEP).map(m => ({ role: m.role, text: m.text, at: m.at || null, changed: !!m.changed })) };
    },
    load(e) {
      est = blank();
      if (e && typeof e === 'object') {
        est.ask = String(e.ask || ''); est.memo = String(e.memo || '');
        est.questions = Array.isArray(e.questions) ? e.questions.map(String) : [];
        est.lines = (Array.isArray(e.lines) ? e.lines : []).map(l => Object.assign({ id: newId('el') }, l));
        est.chat = (Array.isArray(e.chat) ? e.chat : []).filter(m => m && m.text)
          .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: String(m.text), at: m.at || null, changed: !!m.changed }));
        // Notes written before the conversation existed start it.
        if (!est.chat.length && est.ask.trim()) est.chat.push({ role: 'user', text: est.ask.trim(), at: null, changed: false });
      }
      draftMsg = ''; undo = null;
      render();
      autoCheck();
    },
    hasLines: () => items().length > 0,
    totalDollars: () => subtotalCents() / 100,
    book: () => book,
  };

  function changed(redraw) {
    if (typeof syncJobPriceFromProposals === 'function') syncJobPriceFromProposals();
    if (typeof updateJobPriceSourceTag === 'function') updateJobPriceSourceTag();
    if (typeof markDirty === 'function') markDirty();
    if (redraw) render(); else renderTotals();
  }

  const qb = () => (typeof boardFields !== 'undefined' && boardFields.qbEstimate) || null;

  // ---------------------------------------------------------------- drawing

  function render() {
    const wrap = el('estimateWrap');
    const sec = el('estimateSection');
    if (!wrap || !sec) return;
    sec.hidden = !sees();
    if (!sees()) return;
    const ro = !changes();
    const names = Object.keys(book).map(id => [id, book[id]])
      .sort((a, b) => String(a[1].category || '').localeCompare(String(b[1].category || '')) ||
        String(a[1].name || '').localeCompare(String(b[1].name || '')));

    const last = est.chat.length - 1;
    wrap.innerHTML =
      '<div class="est-chat" id="estChat">' +
        (est.chat.length ? est.chat.map((m, i) => '<div class="est-msg ' + (m.role === 'assistant' ? 'claude' : 'me') + '">' +
            '<div class="est-who">' + (m.role === 'assistant' ? '✨ Claude' : 'You') + '</div>' +
            '<div class="est-text">' + esc(m.text) + '</div>' +
            (m.role === 'assistant' && m.changed ? '<div class="est-did">Updated the estimate below' +
              (i === last && undo && undo.jobId === currentJobId && !ro ? ' · <button class="link-btn" onclick="estUndo()">Undo</button>' : '') +
              '</div>' : '') +
          '</div>').join('')
          : '<div class="est-hello">Tell Claude what to price, the way you’d tell someone — “16x20 paver patio, Brussels in Sandstone, 2 steps off the back door, 40 ft steel edging, tear out the old deck.” ' +
            'Then keep talking: “make it 18x20”, “add a fire pit”, “why is the base so much?”. It prices from your price book.</div>') +
        (building ? '<div class="est-msg claude"><div class="est-who">✨ Claude</div><div class="est-text muted">Working on it…</div></div>' : '') +
      '</div>' +
      (ro ? '' : '<div class="est-send">' +
        '<textarea id="estMsg" rows="2" placeholder="' + (est.chat.length ? 'Message Claude about this estimate' : 'What to price…') + '" ' +
          'oninput="estMsgInput(this.value)" onkeydown="estMsgKey(event)">' + esc(draftMsg) + '</textarea>' +
        '<button class="btn btn-filled" onclick="estSend()"' + (building ? ' disabled' : '') + '>' + (building ? '…' : 'Send') + '</button>' +
      '</div>') +
      '<div class="field-actions">' +
        '<button class="btn btn-sm" onclick="openPriceBook()">💲 Price book (' + Object.keys(book).length + ')</button>' +
        (!ro && est.chat.length ? '<button class="btn btn-sm" onclick="estNewChat()">Start the conversation over</button>' : '') +
      '</div>' +
      ((est.questions || []).length ? '<div class="est-questions"><b>Claude needs to know:</b><ul>' +
        est.questions.map(q => '<li>' + esc(q) + '</li>').join('') + '</ul>' +
        '<div class="hint">Answer in the chat above, or fix the lines by hand.</div></div>' : '') +
      '<div class="est-lines">' +
        (est.lines.length ? est.lines.map((l, i) => lineHtml(l, i, names, ro)).join('')
          : '<div class="empty-msg">No lines yet. Write what to price and press Build with Claude, or add lines yourself.</div>') +
      '</div>' +
      (ro ? '' : '<div class="field-actions est-add">' +
        '<button class="btn btn-sm" onclick="estAdd(\'item\')">+ Line</button>' +
        '<button class="btn btn-sm" onclick="estAdd(\'section\')">+ Section heading</button>' +
        (est.lines.length ? '<button class="btn btn-sm" onclick="estClear()">Clear all lines</button>' : '') +
      '</div>') +
      '<div class="est-totals" id="estTotals"></div>' +
      '<div class="field mt"><span class="label">Message on the estimate — the scope of work the customer reads</span>' +
        '<textarea id="estMemo" rows="4" ' + (ro ? 'readonly ' : '') + 'oninput="estMemoInput(this.value)" ' +
        'placeholder="What will be done and what they end up with. Claude writes this when it builds the estimate.">' +
        esc(est.memo) + '</textarea></div>' +
      '<div class="est-qb" id="estQb"></div>';

    wrap.querySelectorAll('select.searchable').forEach(s => { if (typeof makeSearchable === 'function') makeSearchable(s); });
    const log = el('estChat'); if (log) log.scrollTop = log.scrollHeight;
    renderTotals();
  }

  function lineHtml(l, i, names, ro) {
    const id = safeId(l.id);
    const dis = ro ? ' disabled' : '';
    const moves = ro ? '' : '<span class="est-moves">' +
      '<button class="bd-edit-btn" onclick="estMove(\'' + id + '\', -1)"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move up">↑</button>' +
      '<button class="bd-edit-btn" onclick="estMove(\'' + id + '\', 1)"' + (i === est.lines.length - 1 ? ' disabled' : '') + ' aria-label="Move down">↓</button>' +
      '<button class="bd-edit-btn del" onclick="estRemove(\'' + id + '\')" aria-label="Remove line">✕</button></span>';
    if (l.kind === 'section') {
      return '<div class="est-row est-section">' +
        '<input value="' + esc(l.description || '') + '" placeholder="Section heading, e.g. Back patio"' + dis +
          ' oninput="estField(\'' + id + '\', \'description\', this.value)">' + moves + '</div>';
    }
    const p = l.priceId ? book[l.priceId] : null;
    const bookRate = p && Number.isInteger(p.priceCents) ? p.priceCents : null;
    const off = bookRate != null && bookRate !== Number(l.rateCents);
    const missing = l.priceId && !p;
    return '<div class="est-row' + (l.needsPrice && !Number(l.rateCents) ? ' needs' : '') + '">' +
      '<div class="est-item">' +
        '<select class="searchable" title="From the price book"' + dis + ' onchange="estPick(\'' + id + '\', this.value)">' +
          '<option value="">' + (l.priceId && missing ? 'Removed from the price book' : 'Not in the price book') + '</option>' +
          names.map(([pid, e]) => '<option value="' + esc(pid) + '"' + (pid === l.priceId ? ' selected' : '') + '>' +
            esc(e.name) + (Number.isInteger(e.priceCents) ? ' — ' + cents(e.priceCents) + '/' + esc(e.unit || 'each') : '') +
            '</option>').join('') +
        '</select>' +
        '<input class="est-desc" value="' + esc(l.description || '') + '" placeholder="What the customer reads"' + dis +
          ' oninput="estField(\'' + id + '\', \'description\', this.value)">' +
      '</div>' +
      '<div class="est-nums">' +
        '<label><span>Qty</span><input inputmode="decimal" value="' + esc(fmtQty(l.qty)) + '"' + dis +
          ' oninput="estField(\'' + id + '\', \'qty\', this.value)"></label>' +
        '<label><span>Unit</span><input value="' + esc(l.unit || '') + '" placeholder="each"' + dis +
          ' oninput="estField(\'' + id + '\', \'unit\', this.value)"></label>' +
        '<label><span>Rate' + (off ? ' <i title="Price book says ' + esc(cents(bookRate)) + '">✎</i>' : '') + '</span>' +
          '<input inputmode="decimal" value="' + esc(l.rateCents != null && l.rateCents !== '' ? (Number(l.rateCents) / 100).toFixed(2) : '') + '"' + dis +
          ' placeholder="0.00" oninput="estField(\'' + id + '\', \'rate\', this.value)"></label>' +
        '<div class="est-amt" id="estAmt_' + id + '">' + cents(lineCents(l)) + '</div>' +
        moves +
      '</div>' +
    '</div>';
  }

  function fmtQty(q) {
    const n = Number(q);
    return q === '' || q == null || !isFinite(n) ? '' : String(Math.round(n * 100) / 100);
  }

  function renderTotals() {
    const t = el('estTotals');
    if (!t) return;
    est.lines.forEach(l => { const a = el('estAmt_' + safeId(l.id)); if (a) a.textContent = cents(lineCents(l)); });
    const sub = subtotalCents();
    const unpriced = items().filter(l => !Number(l.rateCents)).length;
    const taxable = !!(el('taxable') && el('taxable').checked);
    t.innerHTML = items().length
      ? '<div><span>Subtotal</span><b>' + cents(sub) + '</b></div>' +
        (taxable ? '<div class="muted"><span>Sales tax (QuickBooks works out the exact tax)</span><span>about ' + cents(Math.round(sub * 0.055)) + '</span></div>' : '') +
        (unpriced ? '<div class="warn">' + unpriced + ' line' + (unpriced === 1 ? ' has' : 's have') + ' no price yet</div>' : '')
      : '';
    renderQb();
  }

  function renderQb() {
    const box = el('estQb');
    if (!box) return;
    const q = qb();
    const can = sends() && changes();
    const n = items().length;
    const when = s => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
    const status = q ? ({ Pending: 'Waiting on the customer', Accepted: '✅ Accepted', Closed: 'Made into an invoice',
      Rejected: 'Turned down' }[q.status] || q.status || '') : '';
    box.innerHTML =
      (q && q.id ? '<div class="est-qb-line"><b>QuickBooks estimate' + (q.docNumber ? ' #' + esc(q.docNumber) : '') + '</b>' +
        (q.total != null ? ' · ' + fmtMoney(Number(q.total) || 0) : '') +
        (status ? ' · ' + esc(status) : '') +
        (q.sentAt ? ' · emailed ' + esc(when(q.sentAt)) + (q.sentTo ? ' to ' + esc(q.sentTo) : '') : ' · not emailed yet') +
        (q.acceptedBy ? ' · accepted by ' + esc(q.acceptedBy) : '') +
        (q.env === 'sandbox' ? ' <span class="est-sandbox">TEST COMPANY</span>' : '') + '</div>' : '') +
      (can ? '<div class="field-actions">' +
        '<button class="btn btn-sm btn-filled" onclick="estToQB(true)"' + (saving || !n ? ' disabled' : '') + '>' +
          (saving ? 'Working…' : q && q.id ? (q.sentAt ? '✉️ Update & re-send' : '✉️ Email it from QuickBooks') : '✉️ Send through QuickBooks') + '</button>' +
        '<button class="btn btn-sm" onclick="estToQB(false)"' + (saving || !n ? ' disabled' : '') + '>' +
          (q && q.id ? 'Update in QuickBooks only' : 'Put in QuickBooks, don’t email yet') + '</button>' +
        (q && q.link && /^https:\/\/[a-z.]*qbo\.intuit\.com\//.test(q.link)
          ? '<a class="btn btn-sm" href="' + esc(q.link) + '" target="_blank" rel="noopener">Open in QuickBooks</a>' : '') +
        (q && q.id ? '<button class="btn btn-sm" onclick="estCheck(false)"' + (checking ? ' disabled' : '') + '>' +
          (checking ? 'Checking…' : 'Check for an answer') + '</button>' : '') +
      '</div>' : (q ? '' : '<div class="hint">Sending estimates needs Billing access.</div>'));
  }

  // --------------------------------------------------------------- editing

  function line(id) { return est.lines.find(l => safeId(l.id) === id); }

  window.estMemoInput = function (v) { est.memo = v; if (typeof markDirty === 'function') markDirty(); };

  window.estField = function (id, field, v) {
    const l = line(id);
    if (!l || !changes()) return;
    if (field === 'qty') {
      const n = parseFloat(String(v).replace(/,/g, ''));
      l.qty = isFinite(n) ? n : '';
    } else if (field === 'rate') {
      const c = window.YDSupplies && window.YDSupplies.parseCents ? window.YDSupplies.parseCents(v)
        : Math.round(parseFloat(String(v).replace(/[$,]/g, '')) * 100);
      l.rateCents = typeof c === 'number' && isFinite(c) ? c : '';
      if (l.rateCents) l.needsPrice = false;
    } else {
      l[field] = String(v);
    }
    changed(false);
  };

  // Picking from the price book takes its unit, its rate and (if the line
  // says nothing yet) its wording.
  window.estPick = function (id, pid) {
    const l = line(id);
    if (!l || !changes()) return;
    const p = pid ? book[pid] : null;
    l.priceId = p ? pid : null;
    if (p) {
      l.name = p.name || '';
      l.unit = p.unit || 'each';
      if (Number.isInteger(p.priceCents)) { l.rateCents = p.priceCents; l.needsPrice = false; }
      if (!String(l.description || '').trim()) l.description = p.description || p.name || '';
      if (l.qty === '' || l.qty == null) l.qty = 1;
    }
    changed(true);
  };

  window.estAdd = function (kind) {
    if (!changes()) return;
    est.lines.push(kind === 'section' ? { id: newId('el'), kind: 'section', description: '' }
      : { id: newId('el'), kind: 'item', priceId: null, name: '', description: '', qty: 1, unit: '', rateCents: '' });
    changed(true);
  };
  window.estRemove = function (id) {
    if (!changes()) return;
    est.lines = est.lines.filter(l => safeId(l.id) !== id);
    changed(true);
  };
  window.estMove = function (id, dir) {
    const i = est.lines.findIndex(l => safeId(l.id) === id), j = i + dir;
    if (i < 0 || j < 0 || j >= est.lines.length) return;
    const t = est.lines[i]; est.lines[i] = est.lines[j]; est.lines[j] = t;
    changed(true);
  };
  window.estClear = function () {
    if (!confirm('Take every line off this estimate?')) return;
    est.lines = []; est.questions = [];
    changed(true);
  };

  // A tax change moves the estimate's tax line.
  document.addEventListener('change', e => { if (e.target && e.target.id === 'taxable') renderTotals(); });

  // ------------------------------------------------ talking to Claude
  //
  // Each message goes with the whole conversation and the estimate as it is
  // on screen (lines changed by hand included). Claude answers in words and,
  // when asked for a change, with the whole estimate as it should now be,
  // which replaces the lines -- with one Undo, because a conversation
  // changes things in steps and the last step is the one most often wrong.

  window.estMsgInput = function (v) { draftMsg = v; };
  window.estMsgKey = function (e) {
    // Enter sends on a keyboard; on a phone Enter is a new line and Send is the button.
    if (e.key === 'Enter' && !e.shiftKey && !(window.matchMedia && matchMedia('(pointer: coarse)').matches)) {
      e.preventDefault(); window.estSend();
    }
  };

  window.estSend = async function () {
    if (building || !changes()) return;
    if (!window.YDClaude || !window.YDClaude.available()) { showToast('Sign in to use Claude'); return; }
    const text = String(draftMsg || '').trim();
    if (!text) { const b = el('estMsg'); if (b) b.focus(); return; }
    const customer = (el('customerName').value || '').trim();
    if (!customer) { showToast('Add a customer name first'); return; }
    if (!Object.keys(book).length && !est.chat.length &&
        !confirm('The price book is empty, so Claude can only lay out the lines — every price will be blank.\n\nCarry on?')) return;
    // Saved first so the job has an id that means only itself (see claude.js).
    if (!currentJobId && typeof autosave === 'function') autosave();
    const forJob = currentJobId;
    est.chat.push({ role: 'user', text: text, at: new Date().toISOString(), changed: false });
    if (!est.ask.trim()) est.ask = text;
    draftMsg = '';
    building = true;
    changed(true);
    try {
      const city = [el('city').value, el('state').value].filter(Boolean).join(', ');
      const r = await window.YDClaude.post('/estimate/draft', {
        customer: customer,
        location: [el('address').value, city].filter(Boolean).join(', '),
        services: (typeof serviceTypes !== 'undefined' ? serviceTypes.slice() : []),
        notes: (el('notes').value || '').trim(),
        chat: est.chat.slice(-30).map(m => ({ role: m.role, text: m.text })),
        current: { memo: est.memo || '', lines: est.lines.map(l => ({ kind: l.kind, priceId: l.priceId || null,
          name: l.name || '', description: l.description || '', qty: l.qty, unit: l.unit || '', rateCents: Number(l.rateCents) || 0 })) },
      });
      if (currentJobId !== forJob) { showToast('A different job is open now — Claude’s answer was not put in it'); return; }
      const lines = (r.lines || []).map(l => Object.assign({ id: newId('el') }, l));
      const apply = r.updated !== false && lines.length > 0;
      if (apply) {
        undo = { jobId: forJob, lines: est.lines, memo: est.memo, questions: est.questions };
        est.lines = lines;
        const msg = String(r.message || '').trim();
        if (msg) est.memo = msg;
      } else {
        // Undo only ever undoes the change it is shown beside.
        undo = null;
      }
      est.questions = (r.questions || []).map(String);
      est.chat.push({ role: 'assistant', text: String(r.reply || (apply ? 'Updated the estimate.' : 'No change.')),
                      at: new Date().toISOString(), changed: apply });
      changed(true);
    } catch (e) {
      // The message stays in the box to send again.
      est.chat.pop();
      draftMsg = text;
      showToast('Claude: ' + (e.message || e));
    } finally {
      building = false; render();
    }
  };

  window.estUndo = function () {
    if (!undo || undo.jobId !== currentJobId || !changes()) return;
    est.lines = undo.lines; est.memo = undo.memo; est.questions = undo.questions || [];
    const lastMsg = est.chat[est.chat.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') lastMsg.changed = false;
    est.chat.push({ role: 'user', text: '(Undid that change.)', at: new Date().toISOString(), changed: false });
    undo = null;
    changed(true);
    showToast('Put back as it was');
  };

  window.estNewChat = function () {
    if (!confirm('Start the conversation over? The estimate lines stay as they are.')) return;
    est.chat = []; est.questions = []; undo = null;
    changed(true);
  };

  // ------------------------------------------------------- QuickBooks

  async function askQb(path, body) {
    if (window.YDClaude && window.YDClaude.post) return window.YDClaude.post(path, body);
    throw new Error('The server is not set up');
  }

  window.estToQB = async function (email) {
    if (saving || !sends() || !changes()) return;
    const its = items();
    if (!its.length) return;
    const unpriced = its.filter(l => !Number(l.rateCents)).length;
    if (unpriced && !confirm(unpriced + ' line' + (unpriced === 1 ? ' has' : 's have') + ' no price and will show as $0.00. Carry on?')) return;
    const f = id => (el(id).value || '').trim();
    if (!f('customerName')) { showToast('Add a customer name first'); return; }
    const to = f('email');
    const q = qb() || {};
    if (email) {
      if (!to) { showToast('Add the customer’s email on the job first'); return; }
      if (!confirm((q.sentAt ? 'Email the updated estimate' : 'Email this estimate') + ' to ' + to +
        ' from QuickBooks?\n\nTotal ' + cents(subtotalCents()) + (el('taxable').checked ? ' plus tax' : ''))) return;
    }
    // The job is saved first so it has an id, and so what is on screen is
    // what is kept with the job.
    if (typeof autosave === 'function') autosave();
    const jobId = currentJobId;
    if (!jobId) { showToast('Save the job first'); return; }
    saving = true; renderQb();
    try {
      const r = await askQb('/qb/estimate', {
        jobId: jobId, email: !!email, taxable: !!el('taxable').checked,
        estimateId: q.id || null, customerId: q.customerId || null,
        customer: { name: f('customerName'), email: to, phone: f('phone'), address: f('address'),
                    city: f('city'), state: f('state'), zip: f('zip') },
        memo: est.memo || '',
        lines: est.lines.map(l => ({ kind: l.kind, priceId: l.priceId || null, name: l.name || '',
          description: l.description || '', qty: Number(l.qty) || 0, unit: l.unit || '',
          rateCents: Number(l.rateCents) || 0 })),
      });
      afterQb(jobId, r, email);
      showToast(email ? 'Emailed from QuickBooks' + (r.docNumber ? ' — estimate #' + r.docNumber : '')
        : 'Saved in QuickBooks' + (r.docNumber ? ' as estimate #' + r.docNumber : ''));
    } catch (e) {
      showToast('QuickBooks: ' + (e.message || e));
    } finally {
      saving = false; renderQb();
    }
  };

  // What QuickBooks said, onto the job. A bid that was just emailed moves to
  // Sent (which starts the Follow up clock); QuickBooks' number becomes the
  // job's estimate number.
  function afterQb(jobId, r, emailed) {
    const was = (currentJobId === jobId ? qb() : null) || {};
    const merged = Object.assign({}, was, r);
    Object.keys(merged).forEach(k => { if (merged[k] === undefined) merged[k] = null; });
    const patch = { qbEstimate: merged };
    const stage = currentJobId === jobId ? boardFields.bidStage : null;
    if (emailed && (typeof jobStatus === 'undefined' || jobStatus === 'quoting') &&
        ['won', 'lost', 'sent', 'followUp'].indexOf(stage) === -1) {
      patch.bidStage = 'sent'; patch.bidStageAt = new Date().toISOString();
    }
    if (window.YDSync) window.YDSync.patchJob(jobId, patch);
    if (currentJobId === jobId && r.docNumber && el('estimateNumber').value.trim() !== String(r.docNumber)) {
      el('estimateNumber').value = r.docNumber;
      if (typeof updateJobHeadBadge === 'function') updateJobHeadBadge();
      if (typeof markDirty === 'function') markDirty();
    }
    renderQb();
  }

  window.estCheck = async function (quiet) {
    const q = qb();
    const jobId = currentJobId;
    if (!q || !q.id || checking || !sends()) return;
    checking = true; if (!quiet) renderQb();
    checkedAt[jobId] = Date.now();
    try {
      const r = await askQb('/qb/estimate-status', { estimateId: q.id });
      if (currentJobId !== jobId) return;
      if (r.missing) { if (!quiet) showToast('That estimate is no longer in QuickBooks'); return; }
      const before = q.status;
      afterQb(jobId, r, false);
      if (r.status === 'Accepted' && before !== 'Accepted' && boardFields.bidStage !== 'won' &&
          confirm('The customer accepted estimate #' + (r.docNumber || '') + ' in QuickBooks.\n\nMark the bid Won and the job Booked?')) {
        const at = new Date().toISOString();
        window.YDSync.patchJob(jobId, { bidStage: 'won', bidStageAt: at, jobStatus: 'booked', workStage: 'scheduled', workStageAt: at });
      } else if (!quiet) {
        showToast('QuickBooks says: ' + ({ Pending: 'no answer yet', Accepted: 'accepted', Closed: 'made into an invoice',
          Rejected: 'turned down' }[r.status] || r.status));
      }
    } catch (e) {
      if (!quiet) showToast('QuickBooks: ' + (e.message || e));
    } finally {
      checking = false; renderQb();
    }
  };

  // Opening a job whose estimate is out asks QuickBooks for an answer, at
  // most every half hour per job -- so an acceptance shows up without a press.
  function autoCheck() {
    const q = qb();
    if (!q || !q.id || q.status !== 'Pending' || !sends() || !navigator.onLine) return;
    if (Date.now() - (checkedAt[currentJobId] || 0) < 30 * 60000) return;
    setTimeout(() => window.estCheck(true), 1500);
  }

  // ------------------------------------------------------------ price book

  function bookList() {
    return Object.keys(book).map(id => Object.assign({ id }, book[id]))
      .sort((a, b) => String(a.category || '').localeCompare(String(b.category || '')) ||
        String(a.name || '').localeCompare(String(b.name || '')));
  }
  function writeBook(id, data) {
    data.updatedAt = new Date().toISOString();
    book[id] = Object.assign({}, book[id] || {}, data);
    Promise.resolve(window.YDDb.put('priceBook', id, data)).catch(e => {
      console.warn('[estimate] price not saved:', (e && e.code) || e);
      showToast('A price could not be saved');
    });
  }

  window.openPriceBook = function () {
    const m = el('pbModal');
    if (!m) return;
    m.classList.add('active');
    renderBook();
  };
  window.closePriceBook = function () { const m = el('pbModal'); if (m) m.classList.remove('active'); render(); };

  function renderBook(filter) {
    const body = el('pbBody');
    if (!body) return;
    const ro = !changes();
    const f = String(filter != null ? filter : (el('pbFilter') ? el('pbFilter').value : '')).toLowerCase().trim();
    const list = bookList().filter(p => !f || [p.name, p.category, p.description, p.notes].join(' ').toLowerCase().indexOf(f) !== -1);
    let lastCat = null;
    body.innerHTML =
      '<p class="hint">What you charge. Claude prices estimates only from this list, and each entry becomes a product in QuickBooks the first time it is used. ' +
        '“Notes for Claude” are your pricing rules — minimums, what’s included, waste — Claude reads them; customers never see them.</p>' +
      (ro ? '' : '<div class="field-actions">' +
        '<button class="btn btn-sm btn-filled" onclick="pbAdd()">+ Add a price</button>' +
        (sends() ? '<button class="btn btn-sm" onclick="pbFromQb()">Bring in from QuickBooks</button>' : '') +
        '<button class="btn btn-sm" onclick="pbPasteOpen()">Paste a sheet</button>' +
      '</div>') +
      '<div id="pbPaste" hidden class="field mt"><span class="label">Paste from Excel or Sheets — columns: Name, Unit, Price, Category, Description, Notes for Claude (only Name and Price are needed)</span>' +
        '<textarea id="pbPasteText" rows="6"></textarea>' +
        '<div class="field-actions"><button class="btn btn-sm btn-filled" onclick="pbPasteSave()">Add these</button>' +
        '<button class="btn btn-sm" onclick="pbPasteOpen(false)">Cancel</button></div></div>' +
      '<input id="pbFilter" class="mt" placeholder="Search the price book" value="' + esc(f) + '" oninput="pbFilterInput(this.value)">' +
      (list.length ? '<div class="pb-list">' + list.map(p => {
        const id = safeId(p.id);
        const head = (p.category || '') !== lastCat ? '<div class="pb-cat">' + esc(p.category || 'No category') + '</div>' : '';
        lastCat = p.category || '';
        const dis = ro ? ' disabled' : '';
        const on = (field, v, ph, cls) => '<input class="' + (cls || '') + '" value="' + esc(v == null ? '' : v) + '" placeholder="' + ph + '"' + dis +
          ' onchange="pbField(\'' + id + '\', \'' + field + '\', this.value)">';
        return head + '<div class="pb-row">' +
          '<div class="pb-top">' + on('name', p.name, 'Name, e.g. Paver patio — standard', 'pb-name') +
            on('price', Number.isInteger(p.priceCents) ? (p.priceCents / 100).toFixed(2) : '', 'Price', 'pb-price') +
            '<span class="pb-per">per</span>' + on('unit', p.unit, 'sq ft', 'pb-unit') +
            on('category', p.category, 'Category', 'pb-catin') +
            (ro ? '' : '<button class="bd-edit-btn del" onclick="pbRemove(\'' + id + '\')" aria-label="Remove">✕</button>') + '</div>' +
          '<div class="pb-more">' + on('description', p.description, 'What the customer reads on the estimate', 'pb-desc') +
            on('notes', p.notes, 'Notes for Claude (your pricing rule)', 'pb-notes') +
            (p.qbItemName ? '<span class="pb-qb" title="QuickBooks product">QB: ' + esc(p.qbItemName) + '</span>' : '') + '</div>' +
        '</div>';
      }).join('') + '</div>'
        : '<div class="empty-msg">' + (f ? 'Nothing matches.' : 'No prices yet. Add them, paste your sheet, or bring them in from QuickBooks.') + '</div>');
  }
  window.pbFilterInput = function (v) {
    renderBook(v);
    const i = el('pbFilter'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); }
  };

  window.pbField = function (id, field, v) {
    if (!changes() || !book[id]) return;
    if (field === 'price') {
      const c = window.YDSupplies.parseCents(v);
      if (typeof c === 'number' && isNaN(c)) { showToast('That price isn’t a number'); renderBook(); return; }
      writeBook(id, { priceCents: c == null ? null : c });
    } else if (field === 'name') {
      if (!String(v).trim()) { showToast('A price needs a name'); renderBook(); return; }
      // A renamed entry gets its own QuickBooks product next time; the old
      // one is left alone in QuickBooks.
      writeBook(id, { name: String(v).trim(), qbItemId: null, qbItemName: null });
    } else {
      writeBook(id, { [field]: String(v).trim() });
    }
    renderBook();
  };
  window.pbAdd = function () {
    const name = prompt('What is it? (e.g. Paver patio — standard install)');
    if (!name || !name.trim()) return;
    const id = newId('pb');
    writeBook(id, { name: name.trim(), unit: 'each', priceCents: null, category: '', description: '', notes: '',
                    qbItemId: null, qbItemName: null, active: true, createdAt: new Date().toISOString() });
    renderBook();
  };
  window.pbRemove = function (id) {
    const p = book[id];
    if (!p || !confirm('Take “' + (p.name || '') + '” out of the price book? Estimates already made keep their lines.')) return;
    delete book[id];
    Promise.resolve(window.YDDb.remove('priceBook', id)).catch(e => console.warn('[estimate] not removed:', (e && e.code) || e));
    renderBook();
  };

  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function byName(name) {
    const n = norm(name);
    return Object.keys(book).find(id => norm(book[id].name) === n) || null;
  }

  window.pbFromQb = async function () {
    if (!sends() || !changes()) return;
    showToast('Asking QuickBooks for its products…');
    try {
      const r = await askQb('/qb/items', {});
      let added = 0, linked = 0;
      (r.items || []).forEach(it => {
        if (!it.name || it.type === 'Category') return;
        const have = Object.keys(book).find(id => book[id].qbItemId === it.id) || byName(it.name);
        const price = typeof it.price === 'number' && it.price > 0 ? Math.round(it.price * 100) : null;
        if (have) {
          if (!book[have].qbItemId) { writeBook(have, { qbItemId: it.id, qbItemName: it.name }); linked++; }
          return;
        }
        writeBook(newId('pb'), { name: it.name, unit: 'each', priceCents: price, category: '', description: it.description || '',
                                 notes: '', qbItemId: it.id, qbItemName: it.name, active: true, createdAt: new Date().toISOString() });
        added++;
      });
      renderBook();
      showToast(added + ' added from QuickBooks' + (linked ? ', ' + linked + ' matched to what was here' : '') +
        (added ? ' — set the unit on each' : ''));
    } catch (e) {
      showToast('QuickBooks: ' + (e.message || e));
    }
  };

  window.pbPasteOpen = function (show) {
    const b = el('pbPaste'); if (!b) return;
    b.hidden = show === false;
    if (!b.hidden) el('pbPasteText').focus();
  };
  const COLS = {
    name: ['name', 'item', 'service', 'product', 'description of work'],
    unit: ['unit', 'per', 'uom', 'units'],
    price: ['price', 'rate', 'cost', 'unit price', 'amount', 'charge'],
    category: ['category', 'type', 'group', 'section'],
    description: ['description', 'customer description', 'what customer reads'],
    notes: ['notes', 'notes for claude', 'rule', 'rules', 'pricing rule'],
  };
  window.pbPasteSave = function () {
    if (!changes()) return;
    const rows = window.YDSupplies.parseTable(el('pbPasteText').value);
    if (rows.length < 2) { showToast('Paste the column names and at least one row'); return; }
    const keys = rows[0].map(h => { const t = norm(h); return Object.keys(COLS).find(k => COLS[k].indexOf(t) !== -1) || null; });
    if (keys.indexOf('name') === -1 || keys.indexOf('price') === -1) {
      showToast('The first row needs a Name column and a Price column'); return;
    }
    let added = 0, updated = 0, bad = 0;
    rows.slice(1).forEach(r => {
      const v = {}; keys.forEach((k, i) => { if (k && r[i] != null) v[k] = String(r[i]).trim(); });
      if (!v.name) return;
      const c = window.YDSupplies.parseCents(v.price);
      if (typeof c === 'number' && isNaN(c)) { bad++; return; }
      const data = { name: v.name, priceCents: c == null ? null : c };
      ['unit', 'category', 'description', 'notes'].forEach(k => { if (v[k]) data[k] = v[k]; });
      const have = byName(v.name);
      if (have) { writeBook(have, data); updated++; }
      else {
        writeBook(newId('pb'), Object.assign({ unit: 'each', category: '', description: '', notes: '', qbItemId: null,
          qbItemName: null, active: true, createdAt: new Date().toISOString() }, data));
        added++;
      }
    });
    el('pbPasteText').value = '';
    pbPasteOpen(false);
    renderBook();
    showToast(added + ' added, ' + updated + ' updated' + (bad ? ', ' + bad + ' skipped (price not a number)' : ''));
  };

  // ------------------------------------------------------------- start/stop

  function stop() {
    if (unsub) { try { unsub(); } catch (e) {} }
    unsub = null; book = {};
  }
  function start() {
    stop();
    if (!sees() || !window.YDDb) return;
    unsub = window.YDDb.watch('priceBook', changes => {
      changes.forEach(c => { if (c.type === 'removed') delete book[c.id]; else book[c.id] = c.data; });
      const m = el('pbModal');
      if (m && m.classList.contains('active')) {
        // Not redrawn under someone typing in it.
        const a = document.activeElement;
        if (!(a && m.contains(a) && /INPUT|TEXTAREA/.test(a.tagName))) renderBook();
      } else render();
    }, () => {});
  }

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const k = on ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k !== authKey) { authKey = k; if (on) start(); else stop(); }
    render();
  });
})();
