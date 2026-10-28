// Menards and Home Depot lists, made by Claude on Jonah's computer.
//
// Jonah (wish card, 27-28 Oct 2026): jobs with Menards or Home Depot orders
// should have Claude "build the list on the menards or home depot website and
// name it ... under the client name with the estimate number" -- "Saved list
// per job not into cart", and "I want this to run the moment a job is
// accepted".
//
// Neither store has a way in for apps and both turn robots away, so the
// server cannot do it. A routine on his computer does (Claude desktop app →
// Scheduled → "Store lists"), in his own Chrome where he is signed in to both
// stores. It never adds to the cart, checks out or pays: it makes a saved
// list he opens and orders from. This file is the Job Hub half -- the
// request, the button that makes one, the request made by itself when a job
// is booked, and the answer shown on the job.
//
// storeLists/{jobId}__{store}, one per job and store:
//   jobId, store ('menards' | 'homedepot'), vendorId, name ("Jane Doe - Est #1234"),
//   status: 'asked' → 'working' → 'done' | 'failed'; 'cancelled' when taken back,
//   lines: [{ key, name, sku, link, qty, amount, check }] -- what was still
//     to order when it was asked: qty is the whole number to put on the list,
//     amount the order's own words, check = that number needs a look,
//   askedAt, askedBy, auto (asked by itself as the job was booked), updatedAt;
//   the routine's: startedAt, doneAt, by, result {added, failed: [{name, why}],
//     note, url}.
// A record of its own rather than fields on the job: the routine writes its
// answer whenever it finishes, and a phone with the job open would put the
// job's old copy back over it.

(function () {
  'use strict';

  const PATH = 'storeLists';
  // Asked by itself only for jobs booked from the day this came in -- the
  // jobs booked before have the button.
  const AUTO_FROM = '2026-10-29';
  const STORES = {
    menards: { label: 'Menards', site: 'menards.com' },
    homedepot: { label: 'Home Depot', site: 'homedepot.com' },
  };
  let lists = {};           // docId -> record
  let unsub = null, key = null, heard = false;
  const askedHere = new Set();   // auto requests made on this device this visit
  const esc2 = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s));
  const idOf = (jobId, store) => String(jobId) + '__' + store;
  const canSee = () => typeof ydCan === 'function' && ydCan('jobs', 'see');
  const canAsk = () => typeof ydCan === 'function' && ydCan('jobs', 'change') && !(typeof jobsReadOnly === 'function' && jobsReadOnly());
  const catalog = () => (window.YDSupplies && YDSupplies.catalog ? YDSupplies.catalog() : { items: {}, prices: {}, vendors: {} });

  // Which store a supplier is, by its name or its website.
  function storeOf(vid, cat) {
    const v = vid && (cat || catalog()).vendors[vid];
    if (!v) return null;
    const s = String(v.name || '') + ' ' + String(v.website || '');
    if (/menards/i.test(s)) return 'menards';
    if (/home\s*depot|homedepot\.com/i.test(s)) return 'homedepot';
    return null;
  }

  // ------------------------------------------------ what goes on the list
  //
  // A job's lines: the form's for the job open in it (what was just typed
  // counts), else its saved copy.
  function jobOf(jobId) {
    let d = null;
    try { d = JSON.parse(readJobBlob(jobId) || 'null'); } catch (e) {}
    const open = typeof currentJobId !== 'undefined' && currentJobId === jobId;
    const items = open ? orderItems : (d && Array.isArray(d.orderItems) ? d.orderItems : []);
    return { d: d || {}, items: items || [] };
  }
  // How many to put on the list: what to buy when the line is in what one
  // covers ("2 lengths" for 40 ft of drain, one box for 81 pins), bags for
  // pounds, else the line's own number. check: that number may be wrong --
  // a unit that is not the item's, or no number at all.
  function listQty(it, cat) {
    const c = typeof orderCost === 'function' && cat.prices && Object.keys(cat.prices).length ? orderCost(it, cat) : null;
    const n = c && c.buy ? c.buy : c && c.bags ? c.bags : orderQtyOf(it);
    const sid = orderSupply(it, cat), s = sid ? cat.items[sid] : null;
    // Sold in packs or rolls with no price to work it out from.
    const packUnpriced = !!(s && Number(s.coverage) > 1 && !(c && (c.buy || typeof c.each === 'number')));
    return { qty: n > 0 ? Math.max(1, Math.ceil(n - 1e-9)) : 1, check: !(n > 0) || !!(c && c.unitOff) || packUnpriced };
  }
  // The lines still to order from that supplier, as the routine reads them.
  function linesFor(jobId, vid) {
    const cat = catalog();
    const j = jobOf(jobId);
    return j.items.map((it, i) => ({ it: it, i: i })).filter(x => x.it && typeof x.it === 'object' &&
        String(x.it.name || '').trim() && !x.it.ordered && !x.it.notBought && orderVendor(x.it, cat) === vid)
      .map(x => {
        const sid = orderSupply(x.it, cat), s = sid ? cat.items[sid] : null;
        const q = listQty(x.it, cat);
        const link = s && s.link && window.YDSupplies && YDSupplies.websiteUrl ? YDSupplies.websiteUrl({ website: s.link }) : '';
        return { key: ordLineKey(x.it, x.i), name: String(s ? s.name : x.it.name), sku: s && s.sku ? String(s.sku).trim() : '',
                 link: link || '', qty: q.qty, amount: typeof orderAmountText === 'function' ? orderAmountText(x.it, cat) : String(x.it.quantity || ''),
                 check: q.check };
      });
  }
  // "Jane Doe - Est #1234": his ask, the client and the estimate number.
  // A plain hyphen -- a store's list title may not take every character.
  function listName(d) {
    const who = String(d.customerName || '').trim() || 'Job';
    const est = String(d.estimateNumber || '').trim();
    return (who + (est ? ' - Est #' + est : '')).slice(0, 60);
  }
  // The same lines, the same amounts: whether the list made still matches.
  const sig = lines => (lines || []).map(l => l.key + ':' + l.qty).sort().join('|');

  // ------------------------------------------------ asking
  function ask(jobId, vid, auto) {
    const cat = catalog();
    const store = storeOf(vid, cat);
    if (!store || !jobId || !window.YDDb) return false;
    const lines = linesFor(jobId, vid);
    if (!lines.length) return false;
    const j = jobOf(jobId);
    const now = new Date().toISOString();
    const was = lists[idOf(jobId, store)];
    const rec = { jobId: jobId, store: store, vendorId: vid, name: listName(j.d), status: 'asked', lines: lines,
                  askedAt: now, askedBy: typeof notBoughtMark === 'function' ? notBoughtMark().by : '', auto: !!auto,
                  again: !!(was && was.status === 'done'), updatedAt: now,
                  startedAt: null, doneAt: null, by: null, result: was && was.result ? was.result : null };
    lists[idOf(jobId, store)] = rec;
    // Never awaited: with no signal it waits on the phone and goes when
    // there is some, like every other write.
    YDDb.put(PATH, idOf(jobId, store), rec).catch(err => console.warn('[storelists] not saved', err));
    redraw();
    return true;
  }
  function askNow(jobKey, vidKey) {
    if (!canAsk()) { showToast('You can look at jobs but not change them'); return; }
    const jobId = (getJobIndex().find(x => ordId(x.id) === jobKey) || {}).id;
    const vid = Object.keys(catalog().vendors).find(v => ordId(v) === vidKey);
    if (!jobId || !vid) return;
    if (!ask(jobId, vid, false)) { showToast('Nothing left to order there'); return; }
    showToast('Asked — Claude makes the ' + STORES[storeOf(vid)].label + ' list on your computer within about 10 minutes (it needs to be on)', 6000);
  }
  function cancel(jobKey, store) {
    if (!canAsk()) return;
    const id = Object.keys(lists).find(k => ordId(k) === ordId(jobKey) + '__' + store);
    const r = id && lists[id];
    if (!r || r.status !== 'asked') return;
    r.status = 'cancelled';
    r.updatedAt = new Date().toISOString();
    YDDb.put(PATH, id, { status: 'cancelled', updatedAt: r.updatedAt }).catch(err => console.warn('[storelists] not saved', err));
    redraw();
  }

  // ------------------------------------------------ asked by itself
  //
  // A job booked from AUTO_FROM on (a yes in QuickBooks, Make it a job, a
  // move on the Bids board, one brought in from QuickBooks) with Menards or
  // Home Depot lines still to order gets its list asked for once, as soon as
  // its order list is there -- the owner's device does it, as it books the
  // job (sync.js bookIfAccepted). Once: any record at all, even one he took
  // back, means it was asked. Only after the server has said which lists
  // there are, so a list already made is never asked for again.
  function sweep() {
    if (!heard || !window.YDAuth || !YDAuth.isOwner || !canAsk() || typeof ordersJobs !== 'function') return;
    if (typeof orderReady === 'function' && !orderReady()) return;
    const cat = catalog();
    ordersJobs().forEach(j => {
      const d = j.d || {};
      const st = typeof normStatus === 'function' ? normStatus(d.jobStatus, d) : d.jobStatus;
      if (st !== 'booked' && st !== 'inprogress') return;
      if (d.bidStage !== 'won' || String(d.bidStageAt || '') < AUTO_FROM || d.deletedAt || d.removeWhy) return;
      const vids = {};
      j.left.forEach(it => { const v = orderVendor(it, cat); if (storeOf(v, cat)) vids[v] = true; });
      Object.keys(vids).forEach(v => {
        const id = idOf(j.id, storeOf(v, cat));
        if (lists[id] || askedHere.has(id)) return;
        askedHere.add(id);
        ask(j.id, v, true);
      });
    });
  }
  let sweepTimer = 0;
  const sweepSoon = () => { clearTimeout(sweepTimer); sweepTimer = setTimeout(sweep, 2000); };
  ['yd-jobs-changed', 'yd-supplies', 'yd-pricing'].forEach(ev => document.addEventListener(ev, sweepSoon));

  // ------------------------------------------------ on screen
  function whenWords(at) {
    const d = new Date(at);
    if (!isFinite(d.getTime())) return '';
    const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
    return (new Date().toDateString() === d.toDateString() ? '' : fmtDateMD(localYMD(d)) + ' ') + t;
  }
  // Under a Menards or Home Depot group of a job's order list: the button,
  // or where the list stands. '' for any other supplier.
  function html(jobId, vid) {
    if (!jobId || !canSee()) return '';
    const cat = catalog();
    const store = storeOf(vid, cat);
    if (!store) return '';
    const label = STORES[store].label;
    const r = lists[idOf(jobId, store)];
    const jk = ordId(jobId), vk = ordId(vid);
    const lines = canAsk() ? linesFor(jobId, vid) : [];
    const button = text => lines.length && canAsk()
      ? '<button type="button" class="btn btn-sm sl-btn" onclick="ydStoreListAsk(\'' + jk + '\', \'' + vk + '\')">' + text + '</button>' : '';
    let said = '';
    if (!r || r.status === 'cancelled') {
      said = button('🛒 Have Claude make the ' + label + ' list');
    } else if (r.status === 'asked') {
      said = '<span class="sl-said">🛒 ' + label + ' list asked for' + (r.auto ? ' (by itself, as the job was booked)' : '') +
        ' — Claude makes it on your computer within about 10 minutes, while it’s on</span>' +
        (canAsk() ? ' <button type="button" class="link-btn" onclick="ydStoreListCancel(\'' + jk + '\', \'' + store + '\')">Cancel</button>' : '');
    } else if (r.status === 'working') {
      said = '<span class="sl-said">🛒 Claude is making the ' + label + ' list now…</span>';
    } else if (r.status === 'done') {
      const res = r.result || {};
      const failed = Array.isArray(res.failed) ? res.failed : [];
      const total = (r.lines || []).length;
      const added = typeof res.added === 'number' ? res.added : total - failed.length;
      const url = window.YDSupplies && YDSupplies.websiteUrl ? YDSupplies.websiteUrl({ website: res.url || '' }) : '';
      said = '<span class="sl-said sl-done">✓ ' + label + ' list “' + esc2(r.name) + '” made ' + esc2(whenWords(r.doneAt)) +
        ' — ' + added + ' of ' + total + ' item' + (total === 1 ? '' : 's') + '</span>' +
        (url ? ' <a class="link-btn" href="' + esc2(url) + '" target="_blank" rel="noopener">Open the list</a>' : '') +
        (failed.length ? '<br><span class="warn-text">Not added: ' + failed.map(f => esc2(f.name || 'an item') + (f.why ? ' (' + esc2(f.why) + ')' : '')).join('; ') + '</span>' : '') +
        (res.note ? '<br><span class="muted">' + esc2(res.note) + '</span>' : '') +
        // Lines changed since (swapped, an amount changed, one added).
        (lines.length && sig(lines) !== sig(r.lines) ? ' ' + button('↻ Update the ' + label + ' list') : '');
    } else if (r.status === 'failed') {
      const res = r.result || {};
      said = '<span class="warn-text">⚠ ' + label + ' list not made' + (res.note ? ': ' + esc2(res.note) : '') + '</span> ' + button('Try again');
    }
    return said ? '<div class="sl-row">' + said + '</div>' : '';
  }
  function redraw() {
    if (typeof orderListsRedraw === 'function') orderListsRedraw();
  }

  // ------------------------------------------------ watching
  function stop() {
    if (unsub) { try { unsub(); } catch (e) {} }
    unsub = null; lists = {}; heard = false;
  }
  function start() {
    stop();
    if (!window.YDDb || !YDDb.watch || !canSee()) return;
    unsub = YDDb.watch(PATH, (changes, meta) => {
      let any = false;
      (changes || []).forEach(c => {
        if (!c || !c.id) return;
        if (c.type === 'removed') delete lists[c.id]; else lists[c.id] = c.data || {};
        any = true;
      });
      if (meta && meta.fromCache === false && !heard) { heard = true; sweepSoon(); }
      if (any) redraw();
    }, () => {});
  }
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user ? a.user.uid + '|' + (a.key || '') : null;
    if (k === key) return;
    key = k;
    if (k) start(); else stop();
  });

  window.ydStoreListAsk = askNow;
  window.ydStoreListCancel = cancel;
  window.YDStoreLists = { html: html, storeOf: storeOf, linesFor: linesFor, listName: listName, of: (jobId, store) => lists[idOf(jobId, store)] || null };
})();
