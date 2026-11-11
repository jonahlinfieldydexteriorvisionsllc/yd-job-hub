// Neighbors asking for work -- the post finder (Jonah, 10 Nov 2026).
//
// A routine on his PC reads Nextdoor and his local Facebook groups, in his
// own Chrome, for neighbors asking for landscaping, hardscaping or snow work,
// and writes each one here with a reply already written in his words
// (YDAsks.add, called from the Job Hub page open in that Chrome). He copies
// the reply, opens the post and posts it himself. Nothing here ever posts or
// messages anyone: both sites ban automated posting (it can get the account
// shut down), and a public reply in his name is his to send.
//
// Where it shows: the top of the Media tab (his 9 Nov rule for Nextdoor
// things: "not smack dab on my home page"), a line on Home's Waiting on you,
// a count on the tab, and one buzz on his phone per find from the server
// (reminders.neighbor_asks, which also forgets them after 60 days).
//
// Records: neighborAsks/{nd_<post id> | fb_<post id>} -- owner only (rules).
(function () {
  'use strict';

  const COL = 'neighborAsks';
  const SITES = {
    nextdoor: { name: 'Nextdoor', icon: '🏘️', host: /^(www\.)?nextdoor\.com$/, prefix: 'nd_' },
    facebook: { name: 'Facebook', icon: '📘', host: /^(www\.|m\.|web\.)?facebook\.com$/, prefix: 'fb_' },
  };
  const SERVICES = {
    snow: 'Snow removal', walls: 'Retaining wall', patio: 'Patio or walkway', landscaping: 'Landscaping',
    drainage: 'Drainage', cleanup: 'Yard cleanup', mulch: 'Mulch or rock', edging: 'Edging', lawn: 'Lawn care',
    turf: 'Artificial turf', gutters: 'Gutters', other: 'Yard work',
  };
  // Four days on, the neighbor has most likely found someone: folded away,
  // not gone. The finder never hands in one older than this either (add).
  const STALE_DAYS = 4;
  // The routine's own word on how its last run went (settings/postFinder),
  // said on the tab and Home when a run failed or none has come for this
  // long. It runs twice a day, so a whole missed day shows.
  const QUIET_HOURS = 30;
  const WORDS_SHOWN = 240;
  // Facebook's newer post ids ("pfbid…") run past 60 characters. Keep = rules.
  const ID_RE = /^[A-Za-z0-9_-]{4,100}$/;
  const SAVE_AFTER_MS = 1500;   // a typed reply saves itself after this pause
  const MAX = { who: 60, where: 80, text: 1200, reply: 1500, why: 200, url: 500 };

  const el = id => document.getElementById(id);
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner && window.YDAuth.user);
  const esc = s => (typeof window.esc === 'function' ? window.esc(s)
    : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const toast = m => { if (typeof window.showToast === 'function') window.showToast(m); };

  let asks = {};            // id -> record (status 'new' only: what the watch brings)
  let run = null;           // settings/postFinder
  let unwatch = null;
  let who = null;
  let scrollWanted = 0;     // a push tapped: scroll to the list once it draws
  const drafts = {};        // id -> reply being typed (kept through redraws)
  const whole = {};         // id -> showing all their words
  const saveTimers = {};    // id -> the pending save of a typed reply
  // id -> {copied, opened}: kept on this phone, because opening the post
  // usually opens the Nextdoor or Facebook app and Job Hub may reload by the
  // time he comes back -- the tick should still be the button that leads.
  const TAPS_KEY = 'ydjobhub_askTaps';
  let taps = {};
  try { taps = JSON.parse(localStorage.getItem(TAPS_KEY) || '{}') || {}; } catch (e) { taps = {}; }
  function tap(id, k) {
    taps[id] = Object.assign({}, taps[id], { [k]: Date.now() });
    // Only the asks still listed are kept.
    Object.keys(taps).forEach(x => { if (!findAsk(x)) delete taps[x]; });
    try { localStorage.setItem(TAPS_KEY, JSON.stringify(taps)); } catch (e) { /* this visit only */ }
  }
  const tapped = (id, k) => !!(taps[id] && taps[id][k]);
  // Cut to a length without splitting an emoji in two (half an emoji can make
  // the save fail); never longer than n however the characters are counted.
  function cut(v, n) {
    let t = String(v == null ? '' : v);
    if (t.length <= n) return t;
    t = t.slice(0, n);
    return /[\uD800-\uDBFF]$/.test(t) ? t.slice(0, -1) : t;
  }

  function changed() {
    document.dispatchEvent(new CustomEvent('yd-asks'));
  }

  // ------------------------------------------------------------ reading

  function watch() {
    if (unwatch) { unwatch(); unwatch = null; }
    asks = {};
    if (!isOwner() || !window.YDDb || !window.YDDb.watchWhere) return;
    unwatch = window.YDDb.watchWhere(COL, 'status', 'new', changes => {
      changes.forEach(c => {
        if (c.type === 'removed' || !c.data || c.data.status !== 'new') delete asks[c.id];
        else asks[c.id] = Object.assign({ id: c.id }, c.data);
      });
      changed();
    }, () => {});
  }
  async function readRun() {
    if (!isOwner() || !window.YDDb) return;
    try { run = (await window.YDDb.get('settings', 'postFinder')) || null; } catch (e) { return; }
    changed();
  }

  // ------------------------------------------------------------ the words

  const timeOf = a => { const t = Date.parse(a.postedAt || a.foundAt || ''); return isNaN(t) ? 0 : t; };
  const isStale = a => { const t = timeOf(a); return !!t && Date.now() - t > STALE_DAYS * 86400000; };
  function ago(iso) {
    const t = Date.parse(iso || '');
    if (isNaN(t)) return '';
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (m < 60) return m <= 1 ? 'just now' : m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' hr ago';
    const d = Math.round(h / 24);
    return d === 1 ? 'yesterday' : d + ' days ago';
  }
  // Only a page on the site the find came from is ever a link (the address
  // came off a web page, so it is checked, never trusted).
  function safeUrl(a) {
    const s = SITES[a.site];
    try {
      const u = new URL(String(a.url || ''));
      return s && u.protocol === 'https:' && s.host.test(u.hostname) && !u.username && !u.password ? u.href : '';
    } catch (e) { return ''; }
  }
  const idSafe = id => String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  const replyOf = a => (Object.prototype.hasOwnProperty.call(drafts, a.id) ? drafts[a.id] : String(a.reply || ''));

  function list() {
    return Object.values(asks).sort((a, b) => timeOf(b) - timeOf(a));
  }

  // What Home and the tab count: the fresh ones (a stale one waits folded).
  function fresh() { return list().filter(a => !isStale(a)); }

  // What's wrong with the finder, in words for him, or '' (Home says it too).
  function trouble() {
    if (!run || !run.at) return '';
    const at = Date.parse(run.at);
    if (run.problem) return 'Its last look (' + ago(run.at) + '): ' + run.problem;
    if (!isNaN(at) && Date.now() - at > QUIET_HOURS * 3600000) {
      return 'It hasn’t looked since ' + ago(run.at) + '. It runs on your computer: it needs the computer on and awake, ' +
        'the Claude app open, and Chrome signed in to Nextdoor and Facebook.';
    }
    return '';
  }
  function runLine() {
    if (!run || !run.at) return '';
    const t = trouble();
    return t ? '<p class="na-run na-run-bad">⚠️ The post finder: ' + esc(t) + '</p>'
      : '<p class="na-run">Last looked ' + esc(ago(run.at)) + '.</p>';
  }

  function cardHtml(a) {
    const id = idSafe(a.id);
    const s = SITES[a.site] || { name: 'Online', icon: '💬' };
    const text = String(a.text || '');
    const long = text.length > WORDS_SHOWN;
    const clip = long && !whole[id];
    const url = safeUrl(a);
    const posted = a.postedAt ? 'posted ' + ago(a.postedAt) : 'found ' + ago(a.foundAt);
    const openBtn = lead => url
      ? '<a class="btn' + (lead ? ' btn-filled' : '') + '" href="' + esc(url) + '" target="_blank" rel="noopener" onclick="naOpened(\'' + id + '\')">' +
          (tapped(id, 'opened') ? 'Open the post again' : 'Open the post on ' + esc(s.name)) + '</a>'
      : '';
    const copyBtn = lead => '<button class="btn' + (lead ? ' btn-filled' : '') + '" onclick="naCopy(\'' + id + '\')">' +
      (tapped(id, 'copied') ? '📋 Copy it again' : '📋 Copy the reply') + '</button>';
    const doneBtn = lead => '<button class="btn' + (lead ? ' btn-filled' : '') + '" onclick="naDone(\'' + id + '\')">✓ I replied</button>';
    // The button to press next leads: copy, then open, then the tick.
    const acts = tapped(id, 'opened') ? doneBtn(true) + copyBtn() + openBtn()
      : tapped(id, 'copied') ? openBtn(true) + copyBtn() + doneBtn()
      : copyBtn(true) + openBtn() + doneBtn();
    const help = !url ? 'No link came with this one: find it on ' + s.name + ' by the name above.'
      : a.site === 'facebook' ? 'If Facebook opens the group and not the post, look for ' + (a.who ? a.who + '’s' : 'the') + ' post near the top. ' +
          'Some groups don’t allow business replies: their rules are on the group’s About page.'
      : '';
    return '<div class="na-ask">' +
      '<div class="na-head"><b>' + s.icon + ' ' + esc(a.who || 'A neighbor') + '</b>' +
        (a.where ? ' · ' + esc(a.where) : '') +
        '<small>' + esc(posted) + ' · ' + esc(SERVICES[a.service] || SERVICES.other) + (a.why ? ' — ' + esc(a.why) : '') + '</small></div>' +
      '<div class="sp-text' + (clip ? ' sp-ready-clip' : '') + '">' + esc(text) + '</div>' +
      (long ? '<button class="sp-ready-more" onclick="naWords(\'' + id + '\')">' + (clip ? 'Show all their words' : 'Show less') + '</button>' : '') +
      '<label class="na-label" for="naReply_' + id + '">Your reply — change it if you like, it’s saved</label>' +
      '<textarea id="naReply_' + id + '" class="na-reply" rows="5" maxlength="' + MAX.reply + '" ' +
        'oninput="naTyped(\'' + id + '\', this.value)" onchange="naSaveReply(\'' + id + '\')">' + esc(replyOf(a)) + '</textarea>' +
      (help ? '<p class="hint">' + esc(help) + '</p>' : '') +
      '<div class="sp-acts sp-ready-acts na-acts">' + acts +
        '<button class="btn" onclick="naSkip(\'' + id + '\')">Skip</button></div>' +
    '</div>';
  }

  // The section at the top of the Media tab (socialposts.js draws it in).
  function html() {
    if (!isOwner()) return '';
    const all = list();
    const now = all.filter(a => !isStale(a));
    const older = all.filter(isStale);
    const line = runLine();
    // Nothing to show and the finder well: no section at all.
    if (!all.length && !trouble()) return '';
    const body = (all.length ? '' : line) +
      now.map(cardHtml).join('') +
      (older.length ? '<details class="na-older"><summary>' + older.length + ' older ' + (older.length === 1 ? 'one' : 'ones') +
        ' — more than ' + STALE_DAYS + ' days old, most likely settled</summary>' + older.map(cardHtml).join('') + '</details>' : '') +
      (all.length ? line : '') +
      '<p class="hint">Found on Nextdoor and your Facebook groups by the post finder on your computer. ' +
        'It never posts for you: copy the reply, open the post, paste it in.</p>';
    return '<div class="section" id="naBox"><div class="section-head"><span class="section-title">🙋 Neighbors asking for work</span>' +
      '<span class="section-badge">' + (now.length ? now.length : '') + '</span></div>' +
      '<div class="section-body">' + body + '</div></div>';
  }
  // After the tab drew: a tapped push lands on the list.
  function afterDraw() {
    if (scrollWanted && el('naBox')) {
      const on = Date.now() < scrollWanted;
      scrollWanted = 0;
      if (on) el('naBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ------------------------------------------------------------ taps

  function patch(id, fields, what) {
    if (!window.YDDb) return Promise.resolve();
    // Said at once: with no signal the write only settles on reaching the server.
    return Promise.resolve(window.YDDb.put(COL, id, Object.assign({ updatedAt: new Date().toISOString() }, fields)))
      .catch(e => { console.warn('[asks] not saved:', e && (e.code || e.message)); toast('Not saved — ' + what); });
  }
  const findAsk = id => asks[id] || Object.values(asks).find(a => idSafe(a.id) === id);

  window.naWords = id => { whole[id] = !whole[id]; changed(); };
  // Typed words save themselves after a pause, and before anything else is
  // pressed on the card: on an iPhone a tap on a button doesn't take the
  // cursor out of the box, so "changed" never fires by itself.
  window.naTyped = (id, v) => {
    drafts[id] = cut(v, MAX.reply);
    clearTimeout(saveTimers[id]);
    saveTimers[id] = setTimeout(() => window.naSaveReply(id), SAVE_AFTER_MS);
  };
  window.naSaveReply = id => {
    clearTimeout(saveTimers[id]);
    const a = findAsk(id);
    if (!a || !Object.prototype.hasOwnProperty.call(drafts, id)) return;
    const v = drafts[id];
    if (v === String(a.reply || '')) return;
    a.reply = v;
    patch(a.id, { reply: v }, 'your reply');
  };
  window.naCopy = id => {
    const a = findAsk(id);
    if (!a) return;
    const box = el('naReply_' + id);
    const t = box ? box.value : replyOf(a);
    if (box) { window.naTyped(id, t); window.naSaveReply(id); }
    if (!t.trim()) { toast('The reply is empty'); return; }
    const done = () => { tap(id, 'copied'); changed(); toast('Copied — now open the post and paste it in'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done, () => toast('Could not copy — hold on the words to copy them'));
    } else toast('Could not copy — hold on the words to copy them');
  };
  window.naOpened = id => { window.naSaveReply(id); tap(id, 'opened'); setTimeout(changed, 0); };
  function settle(id, status, said) {
    const a = findAsk(id);
    if (!a) return;
    window.naSaveReply(id);
    const was = Object.assign({}, a);
    delete asks[a.id];
    changed();
    const by = (window.YDAuth && window.YDAuth.user && window.YDAuth.user.uid) || '';
    patch(a.id, { status: status, doneAt: new Date().toISOString(), doneBy: by }, said.toLowerCase());
    if (typeof window.showUndo === 'function') {
      window.showUndo(said, () => {
        asks[a.id] = was;
        changed();
        patch(a.id, { status: 'new', doneAt: null, doneBy: null }, 'putting it back');
      });
    } else toast(said);
  }
  window.naDone = id => settle(id, 'replied', 'Ticked off');
  window.naSkip = id => settle(id, 'skipped', 'Skipped');

  // A push tapped (app.js NOTIFICATION_WINDOWS, notify.js), or Home's line:
  // the Media tab, at the list.
  window.openAsks = function () {
    scrollWanted = Date.now() + 30000;
    if (typeof window.openPosts === 'function') window.openPosts();
  };

  // ------------------------------------------------------------ the routine's door

  // Called by the post finder from the Job Hub page in his Chrome. Every field
  // is checked here, not trusted: the words came off public web pages.
  function postIdOf(site, item) {
    if (item.postId && ID_RE.test(String(item.postId))) return String(item.postId);
    try {
      const u = new URL(String(item.url || ''));
      const m = site === 'nextdoor' ? u.pathname.match(/\/p\/([A-Za-z0-9_-]{4,100})(?:\/|$)/)
        : (u.pathname.match(/\/(?:posts|permalink)\/([A-Za-z0-9_-]{4,100})(?:\/|$)/) ||
           [null, u.searchParams.get('story_fbid') || u.searchParams.get('multi_permalinks') || '']);
      return m && ID_RE.test(m[1] || '') ? m[1] : '';
    } catch (e) { return ''; }
  }
  function cleanItem(item) {
    item = item || {};
    const site = String(item.site || '').toLowerCase();
    const s = SITES[site];
    if (!s) return { error: 'site must be nextdoor or facebook' };
    const url = safeUrl({ site: site, url: item.url });
    if (!url || url.length > MAX.url) return { error: 'not a ' + s.name + ' address' };
    const postId = postIdOf(site, item);
    if (!postId) return { error: 'no post id in the address (give postId)' };
    const text = cut(String(item.text || '').trim(), MAX.text);
    const reply = cut(String(item.reply || '').trim(), MAX.reply);
    if (!text) return { error: 'their words are missing' };
    if (!reply) return { error: 'the reply is missing' };
    let t = Date.parse(item.postedAt || '');
    if (!isNaN(t) && t > Date.now()) t = Date.now();            // never in the future
    // Too old to be worth answering (and it would only arrive folded away).
    if (!isNaN(t) && Date.now() - t > STALE_DAYS * 86400000) return { error: 'posted more than ' + STALE_DAYS + ' days ago' };
    return {
      id: s.prefix + postId,
      rec: {
        site: site, url: url,
        who: cut(String(item.who || '').trim(), MAX.who),
        where: cut(String(item.where || '').trim(), MAX.where),
        text: text, reply: reply,
        service: Object.prototype.hasOwnProperty.call(SERVICES, item.service) ? item.service : 'other',
        why: cut(String(item.why || '').trim(), MAX.why),
        postedAt: isNaN(t) ? null : new Date(t).toISOString(),
      },
    };
  }
  const idOf = item => { const c = cleanItem(item); return c.id || ''; };
  // Which of these the finder has met before (any status: one he skipped or
  // answered must never come back). Read from the server, not the cache.
  async function seen(ids) {
    if (!isOwner() || !window.YDDb) throw new Error('not signed in to Job Hub as the owner');
    const out = [];
    for (const id of (ids || []).map(String)) {
      if (!/^(nd|fb)_[A-Za-z0-9_-]{4,100}$/.test(id)) continue;
      if (asks[id] || await window.YDDb.getFresh(COL, id)) out.push(id);
    }
    return out;
  }
  async function add(items) {
    if (!isOwner() || !window.YDDb) throw new Error('not signed in to Job Hub as the owner');
    const added = [], skipped = [];
    // Each find on its own: one that can't be saved is said, the rest go on.
    // A write only settles once the server has it, so none waits for ever.
    const inTime = (p, what) => Promise.race([p, new Promise((_, no) =>
      setTimeout(() => no(new Error(what + ': no answer from Job Hub')), 20000))]);
    const handed = [];
    for (const item of (Array.isArray(items) ? items : []).slice(0, 30)) {
      const c = cleanItem(item);
      if (c.error) { skipped.push({ url: cut(String((item || {}).url || ''), 120), why: c.error }); continue; }
      if (handed.indexOf(c.id) !== -1) { skipped.push({ id: c.id, why: 'already found' }); continue; }
      handed.push(c.id);
      try {
        if (asks[c.id] || await inTime(window.YDDb.getFresh(COL, c.id), 'not checked')) { skipped.push({ id: c.id, why: 'already found' }); continue; }
        const now = new Date().toISOString();
        await inTime(window.YDDb.put(COL, c.id, Object.assign(c.rec, { status: 'new', notifiedAt: null, foundAt: now, updatedAt: now })), 'not saved');
        added.push(c.id);
      } catch (e) {
        skipped.push({ id: c.id, why: String((e && (e.code || e.message)) || 'not saved') });
      }
    }
    return { added: added, skipped: skipped };
  }
  // The run's own word, for the line on the tab: when it looked, how many
  // posts it read on each site, and anything that stopped it.
  async function ran(r) {
    if (!isOwner() || !window.YDDb) throw new Error('not signed in to Job Hub as the owner');
    r = r || {};
    const looked = {};
    Object.keys(SITES).forEach(k => { const n = Number((r.looked || {})[k]); if (isFinite(n) && n >= 0) looked[k] = Math.round(n); });
    run = { at: new Date().toISOString(), looked: looked, found: Math.max(0, Math.round(Number(r.found) || 0)),
      problem: cut(String(r.problem || '').trim(), 300) };
    await window.YDDb.put('settings', 'postFinder', run);
    changed();
    return run;
  }

  // ------------------------------------------------------------ the rest of Job Hub

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user && a.isOwner ? a.user.uid : null;
    if (k === who) return;
    who = k;
    run = null;
    // Nothing half-typed carries over to another sign-in.
    [drafts, whole].forEach(o => Object.keys(o).forEach(x => { delete o[x]; }));
    Object.keys(saveTimers).forEach(x => { clearTimeout(saveTimers[x]); delete saveTimers[x]; });
    if (k) { watch(); readRun(); } else { if (unwatch) { unwatch(); unwatch = null; } asks = {}; changed(); }
  });
  // Back to the app: the run's line may have moved.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && who) readRun(); });

  window.YDAsks = {
    html: html,
    afterDraw: afterDraw,
    // Home's line and the tab's count: fresh asks, newest first.
    fresh: fresh,
    count: () => fresh().length,
    // What's wrong with the finder, or '' (Home's line).
    trouble: () => (isOwner() ? trouble() : ''),
    sites: SITES,
    services: SERVICES,
    // The post finder's door (see above).
    seen: seen,
    add: add,
    ran: ran,
    idOf: idOf,
    // For the tests.
    _clean: cleanItem,
  };
})();
