// Replies to Google reviews (Jonah, 11 Nov 2026: "setup auto replying to GBP
// reveiws").
//
// The server reads the Business Profile's reviews every hour and writes a
// reply for each one with no reply yet (functions/gbpreviews.py): plain words
// for a star rating alone, Claude's for a review with words. They are listed
// here, at the top of the Media tab under the neighbors asking for work: who,
// how many stars, what they wrote, and the reply in a box he can change.
// Post reply puts it on Google under YD Exterior Visions (/reviews/reply);
// Skip leaves it. "Post replies by themselves" is his switch: on, a reply to a
// 4 or 5 star review that comes in after that goes up at the next hourly look
// (lower ratings always wait for him).
//
// Records: gbpReviews/{id} (owner only; the server makes them and posts),
// settings/reviewReplies {mode, autoFrom, autoSince, checkedAt, error, ...}.
(function () {
  'use strict';

  const COL = 'gbpReviews';
  const SAVE_AFTER_MS = 1500;
  const MAX_REPLY = 1500;
  const WORDS_SHOWN = 260;

  const el = id => document.getElementById(id);
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner && window.YDAuth.user);
  const esc = s => (typeof window.esc === 'function' ? window.esc(s)
    : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const toast = m => { if (typeof window.showToast === 'function') window.showToast(m); };
  const idSafe = id => String(id || '').replace(/[^A-Za-z0-9_-]/g, '');

  let reviews = {};          // id -> record (status 'new' only)
  let conf = null;           // settings/reviewReplies
  let unwatch = null;
  let who = null;
  let scrollWanted = 0;
  const drafts = {};
  const whole = {};
  const saveTimers = {};
  const posting = {};        // id -> true while its reply is going up
  let checking = false;

  function changed() { document.dispatchEvent(new CustomEvent('yd-reviews')); }
  function cut(v, n) {
    let t = String(v == null ? '' : v);
    if (t.length <= n) return t;
    t = t.slice(0, n);
    return /[\uD800-\uDBFF]$/.test(t) ? t.slice(0, -1) : t;
  }

  function watch() {
    if (unwatch) { unwatch(); unwatch = null; }
    reviews = {};
    if (!isOwner() || !window.YDDb || !window.YDDb.watchWhere) return;
    unwatch = window.YDDb.watchWhere(COL, 'status', 'new', changes => {
      changes.forEach(c => {
        if (c.type === 'removed' || !c.data || c.data.status !== 'new') delete reviews[c.id];
        else reviews[c.id] = Object.assign({ id: c.id }, c.data);
      });
      changed();
    }, () => {});
  }
  async function readConf() {
    if (!isOwner() || !window.YDDb) return;
    try { conf = (await window.YDDb.get('settings', 'reviewReplies')) || {}; } catch (e) { return; }
    changed();
  }

  const timeOf = r => { const t = Date.parse(r.createTime || r.foundAt || ''); return isNaN(t) ? 0 : t; };
  function ago(iso) {
    const t = Date.parse(iso || '');
    if (isNaN(t)) return '';
    const d = Math.floor((Date.now() - t) / 86400000);
    if (d <= 0) {
      const m = Math.max(0, Math.round((Date.now() - t) / 60000));
      if (m < 60) return m <= 1 ? 'just now' : m + ' min ago';
      return Math.round(m / 60) + ' hr ago';
    }
    if (d === 1) return 'yesterday';
    if (d < 60) return d + ' days ago';
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  const list = () => Object.values(reviews).sort((a, b) => timeOf(b) - timeOf(a));
  // Only reviews with a reply written count as waiting on him (one still
  // being written shows, but isn't counted on Home).
  const ready = () => list().filter(r => r.reply);
  const replyOf = r => (Object.prototype.hasOwnProperty.call(drafts, r.id) ? drafts[r.id] : String(r.reply || ''));
  const stars = n => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
  const autoOn = () => !!(conf && conf.mode === 'auto');

  function cardHtml(r) {
    const id = idSafe(r.id);
    const text = String(r.comment || '');
    const long = text.length > WORDS_SHOWN;
    const clip = long && !whole[id];
    const low = (r.stars || 0) <= 3;
    const busy = !!posting[id];
    return '<div class="na-ask rv-card' + (low ? ' rv-low' : '') + '">' +
      '<div class="na-head"><b><span class="rv-stars" aria-label="' + (r.stars || 0) + ' stars">' + stars(r.stars || 0) + '</span> ' +
        esc(r.reviewer || 'A Google user') + '</b><small>' + esc(ago(r.createTime)) +
        (low ? ' · a low rating: worth a call as well' : '') + '</small></div>' +
      (text ? '<div class="sp-text' + (clip ? ' sp-ready-clip' : '') + '">' + esc(text) + '</div>' +
        (long ? '<button class="sp-ready-more" onclick="rvWords(\'' + id + '\')">' + (clip ? 'Show all their words' : 'Show less') + '</button>' : '')
        : '<p class="hint">Stars only, no words.</p>') +
      (r.reply ? '<label class="na-label" for="rvReply_' + id + '">Your reply — change it if you like, it’s saved' +
          (r.draftBy === 'claude' ? ' (written by Claude)' : '') + '</label>' +
        '<textarea id="rvReply_' + id + '" class="na-reply" rows="4" maxlength="' + MAX_REPLY + '" ' +
          'oninput="rvTyped(\'' + id + '\', this.value)" onchange="rvSave(\'' + id + '\')">' + esc(replyOf(r)) + '</textarea>' +
        '<div class="sp-acts sp-ready-acts na-acts">' +
          '<button class="btn btn-filled" onclick="rvPost(\'' + id + '\')"' + (busy ? ' disabled' : '') + '>' +
            (busy ? 'Posting…' : '⭐ Post reply on Google') + '</button>' +
          '<button class="btn" onclick="rvSkip(\'' + id + '\')"' + (busy ? ' disabled' : '') + '>Skip</button></div>'
        : '<p class="hint">The reply is being written — it shows here within the hour.</p>') +
    '</div>';
  }

  function confLine() {
    const c = conf || {};
    const bits = [];
    if (c.error) bits.push('<p class="na-run na-run-bad">⚠️ Google reviews couldn’t be read: ' + esc(c.error) + '</p>');
    else if (c.checkedAt) {
      bits.push('<p class="na-run">Google looked at ' + esc(ago(c.checkedAt)) +
        (c.total ? ' · ' + esc(String(c.total)) + ' reviews, ' + esc(Number(c.average || 0).toFixed(1)) + ' stars' : '') + '.</p>');
    }
    bits.push('<div class="rv-auto"><span>' + (autoOn()
      ? '<b>Replies post by themselves</b> for 4 and 5 star reviews that come in from now on (lower ratings wait for you).'
      : 'Every reply waits for you to post it.') + '</span>' +
      '<button class="btn" onclick="rvAuto(' + (autoOn() ? 'false' : 'true') + ')">' +
        (autoOn() ? 'Turn off — I’ll post each one' : 'Post 4–5 star replies by themselves') + '</button>' +
      '<button class="btn" onclick="rvCheck()"' + (checking ? ' disabled' : '') + '>' + (checking ? 'Looking…' : 'Look at Google now') + '</button></div>');
    return bits.join('');
  }

  // The section on the Media tab (socialposts.js draws it in).
  function html() {
    if (!isOwner()) return '';
    const all = list();
    const c = conf || {};
    if (!all.length && !c.error && !c.checkedAt) return '';
    const body = all.map(cardHtml).join('') +
      (all.length ? '' : '<p class="empty-msg">Every Google review has a reply.</p>') + confLine();
    return '<div class="section" id="rvBox"><div class="section-head"><span class="section-title">⭐ Google reviews to answer</span>' +
      '<span class="section-badge">' + (ready().length || '') + '</span></div><div class="section-body">' + body + '</div></div>';
  }
  function afterDraw() {
    if (scrollWanted && el('rvBox')) {
      const on = Date.now() < scrollWanted;
      scrollWanted = 0;
      if (on) el('rvBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ------------------------------------------------------------ taps

  const find = id => reviews[id] || Object.values(reviews).find(r => idSafe(r.id) === id);
  function patch(id, fields, what) {
    if (!window.YDDb) return Promise.resolve();
    return Promise.resolve(window.YDDb.put(COL, id, Object.assign({ updatedAt: new Date().toISOString() }, fields)))
      .catch(e => { console.warn('[reviews] not saved:', e && (e.code || e.message)); toast('Not saved — ' + what); });
  }
  window.rvWords = id => { whole[id] = !whole[id]; changed(); };
  window.rvTyped = (id, v) => {
    drafts[id] = cut(v, MAX_REPLY);
    clearTimeout(saveTimers[id]);
    saveTimers[id] = setTimeout(() => window.rvSave(id), SAVE_AFTER_MS);
  };
  window.rvSave = id => {
    clearTimeout(saveTimers[id]);
    const r = find(id);
    if (!r || !Object.prototype.hasOwnProperty.call(drafts, id)) return;
    const v = drafts[id];
    if (v === String(r.reply || '')) return;
    r.reply = v;
    patch(r.id, { reply: v, replyByHand: true }, 'your reply');
  };
  window.rvPost = async id => {
    const r = find(id);
    if (!r || posting[id]) return;
    const box = el('rvReply_' + id);
    if (box) { window.rvTyped(id, box.value); window.rvSave(id); }
    const text = (box ? box.value : replyOf(r)).trim();
    if (!text) { toast('The reply is empty'); return; }
    const ok = typeof window.ydConfirm === 'function'
      ? await window.ydConfirm('Post this reply under ' + (r.reviewer || 'their') + '’s review on Google? Everyone looking at YD Exterior Visions on Google will see it.',
        { ok: 'Post it' })
      : true;
    if (!ok) return;
    if (!window.YDClaude || !window.YDClaude.post) { toast('Job Hub isn’t ready — try again in a moment'); return; }
    posting[id] = true;
    changed();
    let res;
    try { res = await window.YDClaude.post('/reviews/reply', { id: r.id, reply: text }); } catch (e) { res = { error: (e && e.message) || 'not reached' }; }
    delete posting[id];
    if (res && res.ok) {
      delete reviews[r.id];
      toast('Posted on Google');
    } else toast('Not posted — ' + ((res && res.error) || 'try again'));
    changed();
  };
  window.rvSkip = id => {
    const r = find(id);
    if (!r) return;
    window.rvSave(id);
    const was = Object.assign({}, r);
    delete reviews[r.id];
    changed();
    const by = (window.YDAuth && window.YDAuth.user && window.YDAuth.user.uid) || '';
    patch(r.id, { status: 'skipped', doneAt: new Date().toISOString(), doneBy: by }, 'skipping it');
    if (typeof window.showUndo === 'function') {
      window.showUndo('Skipped — no reply goes up', () => {
        reviews[r.id] = was;
        changed();
        patch(r.id, { status: 'new', doneAt: null, doneBy: null }, 'putting it back');
      });
    } else toast('Skipped');
  };
  window.rvAuto = async on => {
    if (!isOwner() || !window.YDDb) return;
    if (on && typeof window.ydConfirm === 'function') {
      const ok = await window.ydConfirm('From now on, the reply written for each new 4 or 5 star Google review goes up by itself at the next hourly look, without you seeing it first. ' +
        'Reviews of 3 stars or fewer still wait for you. Turn it on?', { ok: 'Turn it on' });
      if (!ok) return;
    }
    const patchConf = on ? { mode: 'auto', autoFrom: 4, autoSince: new Date().toISOString() } : { mode: 'ask' };
    conf = Object.assign({}, conf, patchConf);
    changed();
    Promise.resolve(window.YDDb.put('settings', 'reviewReplies', patchConf))
      .then(() => toast(on ? 'Replies to 4–5 star reviews post by themselves now' : 'Every reply waits for you now'))
      .catch(() => { toast('Not saved — try again'); readConf(); });
  };
  window.rvCheck = async () => {
    if (checking || !window.YDClaude) return;
    checking = true;
    changed();
    let res;
    try { res = await window.YDClaude.post('/reviews/check', {}); } catch (e) { res = { error: (e && e.message) || 'not reached' }; }
    checking = false;
    await readConf();
    if (res && res.error) toast('Google couldn’t be read — ' + res.error);
    else toast((res && res.new) ? res.new + ' new review' + (res.new === 1 ? '' : 's') : 'Nothing new on Google');
    changed();
  };
  // A push tapped (app.js NOTIFICATION_WINDOWS, notify.js) or Home's line.
  window.openReviews = function () {
    scrollWanted = Date.now() + 30000;
    if (typeof window.openPosts === 'function') window.openPosts();
  };

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user && a.isOwner ? a.user.uid : null;
    if (k === who) return;
    who = k;
    conf = null;
    [drafts, whole, posting].forEach(o => Object.keys(o).forEach(x => { delete o[x]; }));
    Object.keys(saveTimers).forEach(x => { clearTimeout(saveTimers[x]); delete saveTimers[x]; });
    if (k) { watch(); readConf(); } else { if (unwatch) { unwatch(); unwatch = null; } reviews = {}; changed(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && who) readConf(); });

  window.YDReviews = {
    html: html,
    afterDraw: afterDraw,
    ready: ready,
    count: () => ready().length,
  };
})();
