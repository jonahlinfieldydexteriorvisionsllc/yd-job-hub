// 📣 Media: Facebook, Instagram, Google Business Profile and Nextdoor posts on a schedule.
// Jonah (30 Oct 2026): "lets setup automatic facebook, nextdoors, and google
// profile posting. i want a set schedule for all this where posts go up at
// the right times on the right days."
//
// The server does the work (functions/social.py): after the morning and
// evening summaries it fills the next 8 days of slots -- a finished job with
// After photos, else one of the month's seasonal posts -- and every five
// minutes a post whose time has come goes up. Nextdoor keeps its Publish API
// from a business promoting itself, so a Nextdoor post is "ready" at its time
// and one tap opens Nextdoor with the words already in.
//
// The Media tab (the owner's alone). Jonah, 9 Nov 2026: "hub should have a
// media tab that tracks when posts went up and where and thats where the
// nextdoor thing should be not smack dab on my home page." At its top, what
// needs him: a Nextdoor post ready to put up, a post held for his OK or one
// that didn't go up. Under that, one part at a time: Went up (every post
// that went up, when and where, with its link), Coming up (each post's words,
// photos and time to change, hold, let go, skip or post now), The schedule
// (settings/social.slots -- social.py DEFAULT_SLOTS until he changes it, and
// the line under every post) and Hook up (Facebook, Instagram, Google). It was
// a window called Posts until then. Home's Waiting on you has one line for a
// post held or not gone up (YDPosts.needs), nothing for Nextdoor.
(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const safeId = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner && window.YDAuth.user);

  const PLACES = ['facebook', 'instagram', 'google', 'nextdoor'];
  // A post of his own has no photos yet, and Instagram can't take one without.
  const OWN_PLACES = PLACES.filter(p => p !== 'instagram');
  const NAMES = { facebook: 'Facebook', instagram: 'Instagram', google: 'Google', nextdoor: 'Nextdoor' };
  const ICONS = { facebook: '📘', instagram: '📷', google: '📍', nextdoor: '🏘️' };
  // The same as functions/social.py DEFAULT_SLOTS (keep the two the same).
  const DEFAULT_SLOTS = [
    { id: 'fb1', place: 'facebook', day: 2, time: '09:30', every: 1, season: 'all' },
    { id: 'fb2', place: 'facebook', day: 4, time: '13:00', every: 1, season: 'all' },
    { id: 'fb3', place: 'facebook', day: 6, time: '09:00', every: 1, season: 'growing' },
    { id: 'ig1', place: 'instagram', day: 3, time: '12:00', every: 1, season: 'all' },
    { id: 'ig2', place: 'instagram', day: 6, time: '10:00', every: 1, season: 'all' },
    { id: 'gb1', place: 'google', day: 2, time: '08:30', every: 1, season: 'all' },
    { id: 'nd1', place: 'nextdoor', day: 4, time: '18:00', every: 2, season: 'all' },
  ];
  const WHY = {
    facebook: 'Weekday mid-morning and early afternoon are the steadiest times on Facebook; Saturday morning is when ' +
      'homeowners plan their yard, April to October.',
    instagram: 'Days Facebook doesn’t already have the same job. Every post here carries its photos, and uses Facebook’s ' +
      'words. A link in the words can’t be tapped on Instagram.',
    google: 'A Google post stays on your profile, so one fresh one every week is the point — early in the week, before ' +
      'the searches pick up. The week’s new After photos go onto the profile with it.',
    nextdoor: 'Nextdoor’s own advice: Thursday or Friday, 5–7 pm, and a new post about every two weeks — more reads as ' +
      'selling to the neighbours.',
  };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const SEASONS = [['all', 'All year'], ['growing', 'Apr–Oct'], ['winter', 'Nov–Mar']];
  const STATUS = {
    queued: ['Goes up by itself', 'sp-st-later'], held: ['Waiting for your OK', 'sp-st-due'],
    posting: ['Going up…', 'sp-st-info'], posted: ['✓ Up', 'sp-st-done'], ready: ['Ready for you to post', 'sp-st-due'],
    failed: ['Didn’t go up', 'sp-st-now'], notConnected: ['Not hooked up', 'sp-st-info'],
    missed: ['Missed its time', 'sp-st-info'], skipped: ['Skipped', 'sp-st-info'],
  };
  const NEEDS = ['held', 'ready', 'failed'];
  const SHARE_SOURCE = 'YD Exterior Visions';
  // How many photos a post takes (functions/social.py PHOTOS, keep the same).
  const PHOTO_MOST = { facebook: 4, instagram: 4, google: 1, nextdoor: 4 };
  const STAGE_WORDS = { after: 'After', before: 'Before', during: 'During' };

  let cfg = null;          // settings/social as read
  let hook = null;         // /social/status: the hookups
  let posts = {};          // socialPosts by id (from three weeks back), kept live
  // Every post that went up, older ones too: read when Went up is looked at
  // (status == posted, one question), not watched. The live three weeks above
  // win over these where both have a post.
  let old = {};
  let oldAt = 0;           // when it was last read (0 = never)
  let oldReading = false;
  let oldFailed = false;
  const OLD_AGAIN_MS = 5 * 60000;
  let upPlace = '';        // Went up: one place only, or '' for all of them
  let unwatch = null;
  let who = null;
  // up | coming | schedule | hookup. Went up first: the tracking was the ask.
  let view = 'up';
  let readyUntil = 0;      // a Nextdoor push is on its way to the ready card (openNextdoor)
  let open = null;         // the post opened for changing
  let busy = '';           // what the server is doing for us
  const drafts = {};       // post id -> words typed and not saved yet (kept through redraws)
  const choosing = {};     // post id -> showing the job's photos to choose from
  const jobShots = {};     // job id -> its photos, read when he asks to choose
  let own = null;          // "a post of your own" form, while open
  let fbForm = { appId: '', appSecret: '' };

  // ------------------------------------------------------------ reading

  async function loadCfg() {
    if (!isOwner() || !window.YDDb) return;
    try { cfg = (await window.YDDb.get('settings', 'social')) || {}; } catch (e) { if (!cfg) return; }
    changed();
  }
  async function loadHook() {
    try { hook = await window.YDClaude.post('/social/status', {}); } catch (e) { hook = hook || { error: e.message }; }
    if (hook && hook.google && cfg) cfg.google = hook.google;
    draw();
  }
  function watchPosts() {
    if (unwatch) { unwatch(); unwatch = null; }
    posts = {};
    if (!isOwner() || !window.YDDb || !window.YDDb.watchFrom) return;
    const from = addDays(localYMD(), -21);
    unwatch = window.YDDb.watchFrom('socialPosts', 'day', from, changes => {
      changes.forEach(c => { if (c.type === 'removed') delete posts[c.id]; else posts[c.id] = Object.assign({ id: c.id }, c.data); });
      changed();
    });
  }
  // Every post that has gone up, ever. A post only gets to 'posted' once, so
  // this list only grows; a fresh read now and then picks up older ones the
  // live three weeks don't hold. No signal: Firestore answers from its cache.
  async function readOld(force) {
    if (!isOwner() || !window.YDDb || !window.YDDb.listWhere || oldReading) return;
    if (!force && oldAt && Date.now() - oldAt < OLD_AGAIN_MS) return;
    oldReading = true;
    const was = who;
    try {
      const got = await window.YDDb.listWhere('socialPosts', 'status', '==', 'posted');
      if (who !== was) return;            // signed out or in as someone else meanwhile
      old = {};
      Object.entries(got || {}).forEach(([id, d]) => { old[id] = Object.assign({ id: id }, d); });
      oldAt = Date.now();
      oldFailed = false;
    } catch (e) {
      console.warn('[posts] earlier posts not read:', e && (e.code || e.message));
      oldFailed = true;
    } finally { oldReading = false; }
    changed();
  }
  const panelOn = () => !!(el('panel-media') && el('panel-media').classList.contains('active'));
  function changed() {
    document.dispatchEvent(new CustomEvent('yd-social'));
    countOnTab();
    if (panelOn()) draw();
  }
  // What needs him, on the tab itself (the sidebar copies it): a Nextdoor
  // post to put up, one held for his OK, one that didn't go up.
  function countOnTab() {
    const c = el('mediaTabCount');
    if (!c) return;
    const n = window.YDPosts ? window.YDPosts.needs().length : 0;
    const t = n ? String(n) : '';
    if (c.textContent !== t) c.textContent = t;
    if (el('tabMedia')) el('tabMedia').classList.toggle('tab-counted', !!n);
    // A phone has Media under More: a dot on More, and what More says under it.
    if (typeof ydMoreDot === 'function') ydMoreDot();
    if (typeof TAB_HINT === 'object') {
      const ready = window.YDPosts ? window.YDPosts.readyToPost().length : 0;
      TAB_HINT.media = !n ? MEDIA_HINT
        : ready === n ? '🟡 ' + n + ' Nextdoor post' + (n === 1 ? '' : 's') + ' ready to put up'
        : '🟡 ' + n + ' post' + (n === 1 ? ' needs' : 's need') + ' you' + (ready ? ' — ' + ready + ' for Nextdoor' : '');
    }
  }
  const MEDIA_HINT = 'When each post went up and where, what goes up next, and Nextdoor posts to put up';

  const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00'); d.setDate(d.getDate() + n); return localYMD(d); };
  function when(iso) {
    const t = new Date(iso);
    if (isNaN(t)) return '';
    const day = localYMD(t), today = localYMD();
    const d = day === today ? 'Today' : day === addDays(today, 1) ? 'Tomorrow' : day === addDays(today, -1) ? 'Yesterday'
      : t.toLocaleDateString('en-US', Object.assign({ weekday: 'short', month: 'short', day: 'numeric' },
          t.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}));   // last year's posts say so
    return d + ', ' + t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  }
  const slotsOf = c => (Array.isArray((c || {}).slots) ? c.slots : DEFAULT_SLOTS);
  const placeOn = (c, p) => ((((c || {}).places || {})[p]) || {}).on !== false;

  // ------------------------------------------------------------ saving

  function save(patch, what) {
    if (!isOwner()) return Promise.resolve();
    cfg = Object.assign({}, cfg || {}, patch);
    changed();
    return Promise.resolve(window.YDDb.put('settings', 'social', Object.assign({ updatedAt: new Date().toISOString() }, patch)))
      .catch(e => { console.warn('[posts] not saved:', e && (e.code || e.message)); showToast('Not saved yet — ' + what); });
  }
  function patchPost(id, patch, what) {
    const p = posts[id] || old[id];
    if (!p) return Promise.resolve();
    Object.assign(p, patch);
    // The same post may be in both (the live weeks and the read of every
    // post that went up): both show the change.
    if (posts[id] && old[id] && old[id] !== posts[id]) Object.assign(old[id], patch);
    changed();
    return Promise.resolve(window.YDDb.put('socialPosts', id, Object.assign({ updatedAt: new Date().toISOString() }, patch)))
      .catch(e => { console.warn('[posts] not saved:', e && (e.code || e.message)); showToast('Not saved — ' + what); });
  }
  async function ask(path, body, doing) {
    busy = doing || 'Working…';
    draw();
    try { return await window.YDClaude.post(path, body || {}); }
    catch (e) { showToast(e.message); return null; }
    finally { busy = ''; draw(); }
  }

  // Planned posts still to come that nobody touched go, and the schedule is
  // filled again: what changing the times means. The words are kept on the
  // server (socialWords, socialIdeas), so this costs no new writing. A held
  // one stays held (planned again it could go up by itself).
  async function replan() {
    const soon = Date.now() + 10 * 60000;
    // One he OK'd stays too: planned again it would start held and lose his OK.
    const gone = Object.values(posts).filter(p => p.kind !== 'own' && !p.edited && !p.okAt &&
      ['queued', 'notConnected'].indexOf(p.status) !== -1 && new Date(p.at).getTime() > soon);
    if (gone.length && window.YDDb.removeMany) {
      await Promise.resolve(window.YDDb.removeMany(gone.map(p => ['socialPosts', p.id]))).catch(() => {});
      gone.forEach(p => { delete posts[p.id]; });
    }
    const r = await ask('/social/plan-now', {}, 'Filling the schedule…');
    if (r && !r.off) showToast(r.planned ? 'Planned ' + r.planned + ' post' + (r.planned === 1 ? '' : 's') : 'Nothing new to plan');
  }

  // ------------------------------------------------------------ the tab

  function draw() {
    const body = el('spBody');
    if (!body) return;
    if (!isOwner()) { body.innerHTML = ''; return; }     // signed out: nothing of his left on screen
    if (!panelOn()) return;
    // A box being typed in is never wiped by a redraw; it draws on leaving it.
    if (body.contains(document.activeElement) && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName) &&
        document.activeElement.type !== 'checkbox') { body.dataset.later = '1'; return; }
    body.dataset.later = '';
    if (!cfg) { body.innerHTML = '<p class="empty-msg">Loading…</p>'; return; }
    if (!cfg.on) { body.innerHTML = section('📣 Start posting', '', startHtml()); return; }
    const views = [
      ['up', '📜 Went up', upWords()],
      ['coming', '🗓️ Coming up', comingWords()],
      ['schedule', '⏰ The schedule', scheduleWords()],
      ['hookup', '🔌 Hook up', hookupWords()],
      // The website's weekly report (sitereport.js): searches, place on Google, what to change.
      ['site', '🔎 Website', window.YDSiteReport ? window.YDSiteReport.words() : ''],
    ];
    const titles = { up: '📜 Posts that went up', coming: '🗓️ Coming up', schedule: '⏰ The schedule', hookup: '🔌 Hook up', site: '🔎 The website on Google' };
    body.innerHTML =
      (busy ? '<div class="sp-busy">⏳ ' + esc(busy) + '</div>' : '') +
      readyHtml() + needsHtml() +
      '<div class="mn-views sp-views">' + views.map(([k, name, small]) =>
        '<button type="button" class="mn-view-btn' + (view === k ? ' on' : '') + '" aria-pressed="' + (view === k) +
          '" onclick="spView(\'' + k + '\')"><b>' + name + '</b><small>' + esc(small) + '</small></button>').join('') + '</div>' +
      section(titles[view] || '', view === 'up' ? upBadge() : '',
        view === 'schedule' ? autoHtml() + scheduleHtml() : view === 'hookup' ? hookupHtml() : view === 'coming' ? comingHtml() :
          view === 'site' ? (window.YDSiteReport ? window.YDSiteReport.html() : '') : upHtml());
    // A Nextdoor push tapped: the ready card, once it has drawn.
    if (readyUntil && el('spReadyBox')) {
      const on = Date.now() < readyUntil;
      readyUntil = 0;
      if (on) el('spReadyBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  const section = (title, badge, inner, id) => '<div class="section"' + (id ? ' id="' + id + '"' : '') + '>' +
    '<div class="section-head"><span class="section-title">' + title + '</span>' +
      '<span class="section-badge">' + esc(badge || '') + '</span></div>' +
    '<div class="section-body">' + inner + '</div></div>';

  // What each part's button says is in it.
  const monthKey = iso => { const t = new Date(iso); return isNaN(t) ? '' : localYMD(t).slice(0, 7); };
  const upAt = p => p.postedAt || p.at;
  const isDown = p => !!p.takenDownAt;
  function upWords() {
    const month = localYMD().slice(0, 7);
    const n = wentUp().filter(p => !isDown(p) && monthKey(upAt(p)) === month).length;
    return n ? n + ' this month' : (oldAt ? 'None yet this month' : '');
  }
  function upBadge() {
    const n = wentUp().filter(p => !isDown(p)).length;
    return n ? n + ' in all' : '';
  }
  function comingWords() {
    const next = Object.values(posts).filter(p => ['queued', 'notConnected'].indexOf(p.status) !== -1 &&
      new Date(p.at).getTime() > Date.now()).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
    return next ? 'Next: ' + (NAMES[next.place] || '') + ' ' + when(next.at) : 'Nothing planned';
  }
  function scheduleWords() {
    if (cfg.pausedUntil && cfg.pausedUntil >= localYMD()) {
      return 'Paused until ' + new Date(cfg.pausedUntil + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    return cfg.auto === false ? 'Each waits for your OK' : 'Posts go up by themselves';
  }
  function hookupWords() {
    if (!hook) return '';
    const off = PLACES.filter(p => placeOn(cfg, p) && !hooked(p));
    return off.length ? off.map(p => NAMES[p]).join(', ') + ' not hooked up' : 'All hooked up';
  }

  // ---- what needs him, over every part

  // Held for his OK, or didn't go up. One ready for Nextdoor has its own card.
  function needsHtml() {
    const list = Object.values(posts).filter(p => p.status === 'held' || p.status === 'failed')
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return list.length ? section('⚠️ Needs you', String(list.length), list.map(rowHtml).join('')) : '';
  }
  function readyHtml() {
    const list = window.YDPosts.readyToPost();
    return list.length ? section('🏘️ Ready for Nextdoor', list.length > 1 ? String(list.length) : '',
      list.map(readyCardHtml).join(''), 'spReadyBox') : '';
  }

  function startHtml() {
    return '<p>Job Hub can put your posts up on <b>Facebook</b> and your <b>Google Business Profile</b> by itself, at ' +
        'set times on set days, and get your <b>Nextdoor</b> posts ready for one tap.</p>' +
      '<ul class="sp-list">' +
        '<li>Each slot gets a job you finished with its After photos — the newest first, then the rest of the season ' +
          'through the winter. With none left, one of the month’s seasonal posts.</li>' +
        '<li>Never a customer’s name, street or price. Anything that slips through waits for your OK.</li>' +
        '<li>The evening before, your phone is told what goes up tomorrow, so you can change or stop one.</li>' +
      '</ul>' +
      '<p class="hint">The times to start with (you can change them):</p>' + slotsSummaryHtml(DEFAULT_SLOTS) +
      '<button class="btn btn-filled" onclick="spStart()">Start the schedule</button>';
  }

  function slotsSummaryHtml(list) {
    return '<div class="sp-sum">' + PLACES.map(p => {
      const mine = list.filter(s => s.place === p);
      return '<div><b>' + ICONS[p] + ' ' + NAMES[p] + '</b> ' + (mine.length ? mine.map(slotWords).join(' · ')
        : '<span class="muted">none</span>') + '</div>';
    }).join('') + '</div>';
  }
  function slotWords(s) {
    const [h, m] = s.time.split(':').map(Number);
    const t = new Date(2026, 0, 1, h, m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
    return DAYS[s.day] + ' ' + t + (s.every === 2 ? ' every other week' : '') +
      (s.season === 'growing' ? ' (Apr–Oct)' : s.season === 'winter' ? ' (Nov–Mar)' : '');
  }

  function autoHtml() {
    const paused = cfg.pausedUntil && cfg.pausedUntil >= localYMD();
    const auto = cfg.auto !== false;
    return '<div class="sp-auto">' +
      '<div class="sp-choice"><button class="btn btn-sm' + (auto ? ' btn-filled' : '') + '" onclick="spAuto(true)">' +
        (auto ? '✓ ' : '') + 'Go up by themselves</button>' +
      '<button class="btn btn-sm' + (!auto ? ' btn-filled' : '') + '" onclick="spAuto(false)">' +
        (!auto ? '✓ ' : '') + 'Each waits for my OK</button></div>' +
      (paused
        ? '<div class="sp-paused">⏸ Paused until ' + esc(new Date(cfg.pausedUntil + 'T12:00:00').toLocaleDateString('en-US',
            { weekday: 'short', month: 'short', day: 'numeric' })) + ' <button class="link-btn" onclick="spPause(\'\')">Start again now</button></div>'
        : '<div class="sp-pause"><span class="muted">Pause posting:</span> ' +
            [[7, 'a week'], [14, 'two weeks'], [30, 'a month']].map(([n, w]) =>
              '<button class="link-btn" onclick="spPause(' + n + ')">' + w + '</button>').join(' · ') + '</div>') +
    '</div>';
  }

  // ---- coming up

  function comingHtml() {
    const today = localYMD();
    const list = Object.values(posts).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    // What needs him is over every part (needsHtml, readyHtml); what went up
    // is Went up. Here: what is still to come, and what never went up.
    const ahead = list.filter(p => NEEDS.indexOf(p.status) === -1 && p.day >= today &&
      ['queued', 'posting', 'notConnected'].indexOf(p.status) !== -1);
    const gone = list.filter(p => ['missed', 'skipped'].indexOf(p.status) !== -1 ||
      (p.status === 'notConnected' && p.day < today)).reverse().slice(0, 30);
    const off = PLACES.filter(p => placeOn(cfg, p) && !hooked(p));
    const paused = cfg.pausedUntil && cfg.pausedUntil >= today;
    let byDay = '', lastDay = '';
    ahead.forEach(p => {
      if (p.day !== lastDay) {
        lastDay = p.day;
        // "Today", or "Tue, Nov 3" -- just "Tue" made two Tuesdays one heading.
        const w = when(p.at);
        byDay += '<h4 class="sp-day">' + esc(w.slice(0, w.lastIndexOf(', '))) + '</h4>';
      }
      byDay += rowHtml(p);
    });
    return (off.length ? '<div class="sp-note">' + off.map(p => ICONS[p] + ' ' + NAMES[p]).join(', ') +
          (off.length === 1 ? ' isn’t' : ' aren’t') + ' hooked up yet — ' + (off.indexOf('nextdoor') !== -1 && off.length === 1
            ? '' : 'until ' + (off.length === 1 ? 'it is' : 'they are') + ', those posts are kept here for you to copy. ') +
          '<button class="link-btn" onclick="spView(\'hookup\')">Hook up</button></div>' : '') +
      (paused ? '<div class="sp-paused">⏸ Posting is paused until ' + esc(new Date(cfg.pausedUntil + 'T12:00:00').toLocaleDateString('en-US',
          { weekday: 'short', month: 'short', day: 'numeric' })) + ' <button class="link-btn" onclick="spPause(\'\')">Start again now</button></div>' : '') +
      (byDay || '<p class="empty-msg">Nothing planned yet' + (cfg.planWaiting
        ? ' — ' + cfg.planWaiting + ' slot' + (cfg.planWaiting === 1 ? ' has' : 's have') + ' nothing to post yet'
        : '') + '.</p>') +
      '<div class="field-actions"><button class="btn btn-sm" onclick="spPlanNow()"' + (busy ? ' disabled' : '') +
        '>Plan them now</button><button class="btn btn-sm" onclick="spOwnOpen()">+ A post of your own</button></div>' +
      (own ? ownHtml() : '') +
      (gone.length ? '<details class="sp-gone"><summary>Missed or skipped (' + gone.length + ')</summary>' +
        gone.map(rowHtml).join('') + '</details>' : '');
  }

  // ---- went up

  // Every post that went up: the read of all of them, with the live three
  // weeks over it (a tick or a takedown shows at once). Newest first.
  function wentUp() {
    const all = Object.assign({}, old);
    Object.values(posts).forEach(p => { if (p.status === 'posted') all[p.id] = p; else delete all[p.id]; });
    return Object.values(all).sort((a, b) => String(upAt(b)).localeCompare(String(upAt(a))));
  }
  function upHtml() {
    if (!oldAt && !oldFailed) readOld();
    const all = wentUp();
    if (!all.length) {
      return oldFailed ? '<p class="empty-msg">Couldn’t read the posts that went up. <button class="link-btn" onclick="spReadOld()">Try again</button></p>'
        : oldAt ? '<p class="empty-msg">Nothing has gone up yet.</p>' : '<p class="empty-msg">Reading…</p>';
    }
    const live = all.filter(p => !isDown(p));
    const count = place => live.filter(p => p.place === place).length;
    // One place at a time, or all of them: buttons that wrap, never a row
    // that scrolls sideways. Only places something went up on.
    const places = PLACES.filter(p => count(p) || all.some(x => x.place === p));
    const chip = (k, words) => '<button type="button" class="btn btn-sm' + (upPlace === k ? ' btn-filled' : '') +
      '" aria-pressed="' + (upPlace === k) + '" onclick="spUpPlace(\'' + k + '\')">' + words + '</button>';
    const shown = upPlace ? all.filter(p => p.place === upPlace) : all;
    let out = '', month = '';
    shown.forEach(p => {
      const m = monthKey(upAt(p));
      if (m !== month) {
        month = m;
        const inMonth = shown.filter(x => monthKey(upAt(x)) === m);
        const n = inMonth.filter(x => !isDown(x)).length, down = inMonth.length - n;
        // One taken down is listed but not counted: said, so the sum adds up.
        out += '<h4 class="sp-day">' + esc(m ? new Date(m + '-15T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : 'No date') +
          ' · ' + n + ' post' + (n === 1 ? '' : 's') + (down ? ' up, ' + down + ' taken down' : '') + '</h4>';
      }
      out += rowHtml(p, true);
    });
    return '<div class="sp-choice sp-up-places">' + chip('', 'All · ' + live.length) +
        places.map(p => chip(p, ICONS[p] + ' ' + NAMES[p] + ' · ' + count(p))).join('') + '</div>' +
      (out || '<p class="empty-msg">Nothing has gone up on ' + esc(NAMES[upPlace] || '') + ' yet.</p>') +
      '<p class="hint">Deleted one on the site yourself? Open it here and tap “It’s not up any more”: it stays listed and leaves the counts. ' +
        'These are the posts Job Hub put up or you ticked off; one posted straight on the site isn’t here.</p>' +
      (oldFailed ? '<p class="hint">Couldn’t read the older ones just now — these are the last three weeks. ' +
        '<button class="link-btn" onclick="spReadOld()">Try again</button></p>' : '');
  }

  function hooked(place) {
    if (place === 'nextdoor') return true;              // posted by him, from here
    if (place === 'facebook') return !!(hook && hook.facebook && hook.facebook.connected);
    if (place === 'instagram') return !!((hook && hook.instagram && hook.instagram.ok) || (cfg.instagram && cfg.instagram.ok));
    if (place === 'google') return !!((hook && hook.google && hook.google.ok) || (cfg.google && cfg.google.ok));
    return false;
  }

  const whatOf = p => p.kind === 'job' ? (p.jobName || 'A finished job') + (p.town ? ' · ' + p.town : '')
    : p.kind === 'idea' ? (/^yt-/.test(p.ideaId || '') ? '📝 ' : '🍂 ') + (p.topic || 'Seasonal post') : '✍️ Your post';
  const photosOf = p => (p.photos || []).filter(x => /^https:\/\//.test((x || {}).url || ''));
  // The word on a photo that isn't of the finished job. After needs none.
  const stageTag = x => (x.stage === 'before' || x.stage === 'during')
    ? '<span class="sp-photo-tag">' + STAGE_WORDS[x.stage] + '</span>' : '';

  // listed: in Went up, where every row is up, so "✓ Up" on each says nothing.
  function rowHtml(p, listed) {
    const down = p.status === 'posted' && isDown(p);
    const st = down ? ['Taken down', 'sp-st-info'] : STATUS[p.status] || [p.status, ''];
    const chip = listed === true && p.status === 'posted' && !down ? '' : '<span class="sp-st ' + st[1] + '">' + esc(st[0]) + '</span>';
    const isOpen = open === p.id;
    const what = whatOf(p);
    const photos = photosOf(p);
    // One that went up shows when it really went up (Post now, a tick for
    // Nextdoor), not the time it was planned for.
    const t = p.status === 'posted' ? upAt(p) : p.at;
    return '<div class="sp-row' + (isOpen ? ' open' : '') + (down ? ' sp-down' : '') + '" id="spRow_' + safeId(p.id) + '">' +
      '<button class="sp-row-head" onclick="spOpen(\'' + safeId(p.id) + '\')" aria-expanded="' + isOpen + '">' +
        '<span class="sp-place">' + ICONS[p.place] + '</span>' +
        '<span class="sp-main"><b>' + esc(NAMES[p.place] || '') + ' · ' + esc(when(t)) + '</b>' +
          '<small>' + esc(what) + '</small>' +
          (isOpen ? '' : '<small class="sp-snip">' + esc(String(p.text || '').slice(0, 110)) + '</small>') +
          chip + '</span>' +
        (photos[0] ? '<img class="sp-thumb" src="' + esc(photos[0].thumb || photos[0].url) + '" alt="" loading="lazy">' : '') +
      '</button>' +
      // Where to see it, without opening the post first.
      (p.status === 'posted' && !down && !isOpen && /^https:\/\//.test(p.link || '')
        ? '<a class="sp-see" href="' + esc(p.link) + '" target="_blank" rel="noopener">See it on ' + esc(NAMES[p.place] || 'the site') + ' ↗</a>' : '') +
      (p.status === 'held' && p.heldWhy ? '<div class="sp-why">⚠️ ' + esc(p.heldWhy) + '</div>' : '') +
      // "Not hooked up yet" is said once at the top, not under every post.
      ((p.status === 'failed' || p.status === 'notConnected') && p.error && !/isn.t hooked up yet$/.test(p.error)
        ? '<div class="sp-why">' + esc(p.error) + '</div>' : '') +
      (isOpen ? openHtml(p, photos) : '') +
    '</div>';
  }

  // Every photo on the post's job, to swap in by hand: the code picks by how
  // alike photos are and when they were taken, so the last word is his.
  function chooserHtml(p) {
    const id = safeId(p.id);
    if (!choosing[id]) {
      return '<div class="field-actions"><button class="btn btn-sm" onclick="spChoose(\'' + id + '\')">🖼️ Choose from all this job’s photos</button></div>';
    }
    const close = '<div class="field-actions"><button class="btn btn-sm" onclick="spChoose(\'' + id + '\')">Done choosing</button></div>';
    const leftWhy = (post, pid) => ((post.photosLeftOut || []).find(l => l.id === pid) || {}).why;
    const rows = jobShots[p.jobId];
    if (!rows) return '<p class="hint">Reading this job’s photos…</p>' + close;
    if (!rows.length) return '<p class="hint">This job has no photos to choose from.</p>' + close;
    const most = PHOTO_MOST[p.place] || 4;
    const on = (p.photos || []).map(x => x.id);
    const shot = x => {
      const at = on.indexOf(x.id);
      return '<button class="sp-pick' + (at !== -1 ? ' on' : '') + '" aria-pressed="' + (at !== -1) + '" ' +
        'onclick="spPick(\'' + id + '\', \'' + safeId(x.id) + '\')" aria-label="' + (at !== -1 ? 'Take this photo off the post' : 'Put this photo on the post') + '">' +
        '<img src="' + esc(x.thumb) + '" alt="" loading="lazy">' +
        (at !== -1 ? '<span class="sp-pick-n">' + (at + 1) + '</span>' : '') +
        (leftWhy(p, x.id) ? '<span class="sp-pick-warn" aria-label="Claude left this one out">⚠️</span>' : '') + '</button>';
    };
    return '<div class="sp-chooser"><p class="hint">' +
        (most === 1 ? 'This post takes 1 photo: tap one to swap it in.'
          : 'Tap a photo to put it on the post or take it off. It takes up to ' + most + '; once it’s full, a new one replaces the last. ' +
            'The numbers are the order they show in, and ★ on the photos above makes one first. ⚠️ means Claude left it out.') + '</p>' +
      ['after', 'before', 'during'].map(s => {
        const list = rows.filter(x => x.stage === s);
        return list.length ? '<div class="sp-chooser-head">' + STAGE_WORDS[s] + '</div><div class="sp-photos">' + list.map(shot).join('') + '</div>' : '';
      }).join('') + close + '</div>';
  }

  function shareUrl(p) {
    // Nextdoor's share link: its composer opens with the words already in
    // (developer.nextdoor.com share plugin; body up to 3,500 characters).
    // Cut by whole characters: a cut through an emoji leaves half of it, and
    // encodeURIComponent throws on that -- the whole Posts window stopped drawing.
    let chars = Array.from(String(p.text || ''));
    while (chars.length && encodeURIComponent(chars.join('')).length > 3400) chars = chars.slice(0, -20);
    return 'https://nextdoor.com/sharekit/?source=' + encodeURIComponent(SHARE_SOURCE) + '&body=' + encodeURIComponent(chars.join(''));
  }

  function openHtml(p, photos) {
    const id = safeId(p.id);
    const live = ['queued', 'held', 'failed', 'notConnected', 'missed', 'ready'].indexOf(p.status) !== -1;
    const at = new Date(p.at);
    const local = isNaN(at) ? '' : localYMD(at) + 'T' + String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0');
    const btn = (call, words, filled) => '<button class="btn btn-sm' + (filled ? ' btn-filled' : '') + '" onclick="' + call + '">' + words + '</button>';
    let acts = [];
    if (p.status === 'ready' || (p.place === 'nextdoor' && live && p.status !== 'queued')) {
      acts.push('<a class="btn btn-sm btn-filled" href="' + esc(shareUrl(p)) + '" target="_blank" rel="noopener">Open Nextdoor with the words in</a>');
      acts.push(btn("spDone('" + id + "')", '✓ I posted it'));
    }
    if (p.status === 'held') acts.push(btn("spLet('" + id + "')", new Date(p.at) <= new Date() ? 'OK — post it now' : 'OK — let it go up', true));
    if (p.status === 'queued') acts.push(btn("spHold('" + id + "')", 'Hold it'));
    if (live && p.place !== 'nextdoor' && hooked(p.place)) acts.push(btn("spNow('" + id + "')", p.status === 'failed' ? 'Try again now' : 'Post now'));
    if (live && p.place === 'nextdoor' && p.status === 'queued') acts.push(btn("spNow('" + id + "')", 'Get it ready now'));
    acts.push(btn("spCopy('" + id + "')", '📋 Copy the words'));
    if (live && p.kind === 'job' && p.status !== 'ready') acts.push(btn("spRewrite('" + id + "')", '✍️ Write it again'));
    if (live && p.status !== 'ready') acts.push(btn("spSkip('" + id + "')", 'Skip it'));
    if (p.link && /^https:\/\//.test(p.link)) acts.push('<a class="btn btn-sm" href="' + esc(p.link) + '" target="_blank" rel="noopener">See it ↗</a>');
    // One deleted on the site stays on the list, said to be gone, and leaves
    // the counts. Nothing on the site changes from here.
    if (p.status === 'posted') {
      acts.push(isDown(p) ? btn("spDown('" + id + "', false)", 'It’s still up') : btn("spDown('" + id + "', true)", 'It’s not up any more'));
    }
    return '<div class="sp-open">' +
      (live && p.status !== 'ready'
        ? '<label class="sp-lbl">The words' + (p.place === 'google' ? ' <span class="muted">(Google adds a Call button)</span>' : '') +
            '<textarea id="spText_' + id + '" rows="8" maxlength="5000">' + esc(drafts[id] != null ? drafts[id] : p.text || '') +
            '</textarea></label>' +
          '<div class="field-actions"><button class="btn btn-sm" onclick="spSaveText(\'' + id + '\')">Save the words</button></div>' +
          // Jonah, 2 Nov 2026: "add notes for claude to view on media posts
          // that are going up". Kept with the job's words, so every later
          // writing of this job's posts follows it too.
          (p.kind === 'job'
            ? '<label class="sp-lbl">Note for Claude <span class="muted">(what to say or leave out — it writes this job’s posts again with it)</span>' +
                '<textarea id="spNote_' + id + '" rows="2" maxlength="1000" placeholder="e.g. say it was a full backyard redo; don’t mention the old deck">' +
                esc(drafts['n_' + id] != null ? drafts['n_' + id] : p.jobNote || '') + '</textarea></label>' +
              '<div class="field-actions"><button class="btn btn-sm" onclick="spRewrite(\'' + id + '\', true)">✍️ Write it again with my note</button></div>'
            : '')
        : '<div class="sp-text">' + esc(p.text || '') + '</div>') +
      (photos.length ? '<div class="sp-photos">' + photos.map((x, i) => '<span class="sp-photo">' +
          '<a href="' + esc(x.url) + '" target="_blank" rel="noopener"><img src="' + esc(x.thumb || x.url) + '" alt="Photo ' + (i + 1) + '" loading="lazy"></a>' +
          stageTag(x) +
          // Its place in p.photos, not in this https-only list.
          (live && photos.length > 0 ? '<button class="sp-photo-x" onclick="spDropPhoto(\'' + id + '\', ' +
            (p.photos || []).indexOf(x) + ')" aria-label="Leave this photo out">✕</button>' : '') +
          (live && i > 0 ? '<button class="sp-photo-first" onclick="spFirstPhoto(\'' + id + '\', ' +
            (p.photos || []).indexOf(x) + ')" aria-label="Make this the first photo">★</button>' : '') +
        '</span>').join('') + '</div>' +
        (p.place === 'nextdoor' && p.status === 'ready' ? '<p class="hint">Tap a photo to open it, save it, then add it in Nextdoor.</p>' : '')
        : '') +
      (live && p.kind === 'job' && p.jobId ? chooserHtml(p) : '') +
      (live && p.status !== 'ready' && p.status !== 'posting'
        ? '<label class="sp-lbl">When<input type="datetime-local" id="spAt_' + id + '" value="' + esc(local) + '" ' +
            'onchange="spMove(\'' + id + '\', this.value)"></label>' : '') +
      '<div class="sp-acts">' + acts.join('') + '</div>' +
      (p.kind === 'job' && p.jobId ? '<p class="hint">From the job ' + esc(p.jobName || '') + (p.jobNum ? ' #' + esc(p.jobNum) : '') +
        '. Tick “Don’t post” on the job to keep all of its posts off.</p>' : '') +
    '</div>';
  }

  function ownHtml() {
    return '<div class="sp-own">' +
      '<b>A post of your own</b>' +
      '<div class="sp-choice">' + OWN_PLACES.map(p => '<button class="btn btn-sm' + (own.places[p] ? ' btn-filled' : '') +
        '" onclick="spOwnPlace(\'' + p + '\')">' + (own.places[p] ? '✓ ' : '') + ICONS[p] + ' ' + NAMES[p] + '</button>').join('') + '</div>' +
      '<label class="sp-lbl">The words<textarea id="spOwnText" rows="6" oninput="spOwnSet(\'text\', this.value)">' + esc(own.text) + '</textarea></label>' +
      '<label class="sp-lbl">When<input type="datetime-local" id="spOwnAt" value="' + esc(own.at) + '" oninput="spOwnSet(\'at\', this.value)"></label>' +
      '<div class="field-actions"><button class="btn btn-filled" onclick="spOwnSave()">Put it on the schedule</button>' +
        '<button class="btn" onclick="spOwnCancel()">Cancel</button></div></div>';
  }

  // ---- the schedule

  function scheduleHtml() {
    const list = slotsOf(cfg);
    const sign = cfg.signOff || {};
    return '<p class="hint">Each time below gets one post. Changing a time plans the coming week again (posts you changed ' +
        'by hand stay as they are).</p>' +
      PLACES.map(p => {
        const on = placeOn(cfg, p);
        const mine = list.map((s, i) => [s, i]).filter(([s]) => s.place === p);
        return '<div class="sp-place-box">' +
          '<div class="sp-place-head"><b>' + ICONS[p] + ' ' + NAMES[p] + '</b>' +
            '<div class="sp-choice"><button class="btn btn-sm' + (on ? ' btn-filled' : '') + '" onclick="spPlaceOn(\'' + p + '\', true)">' +
              (on ? '✓ ' : '') + 'Post here</button><button class="btn btn-sm' + (!on ? ' btn-filled' : '') +
              '" onclick="spPlaceOn(\'' + p + '\', false)">' + (!on ? '✓ ' : '') + 'Not here</button></div></div>' +
          (on ? '<p class="hint">' + esc(WHY[p]) + '</p>' + mine.map(([s, i]) => slotHtml(s, i)).join('') +
            '<button class="link-btn" onclick="spSlotAdd(\'' + p + '\')">+ Another time for ' + NAMES[p] + '</button>' +
            (p !== 'google' ? '<label class="sp-lbl">Under every ' + NAMES[p] + ' post <span class="muted">(your phone number, ' +
              'website — or leave it empty)</span><textarea id="spSign_' + p + '" rows="2" maxlength="300">' + esc(sign[p] || '') +
              '</textarea></label><div class="field-actions"><button class="btn btn-sm" onclick="spSign(\'' + p + '\')">Save the line</button></div>'
              : '') : '') +
        '</div>';
      }).join('') +
      yardTalkHtml() +
      (Array.isArray(cfg.slots) ? '<button class="btn btn-sm" onclick="spSlotsReset()">Back to the recommended times</button>' : '');
  }

  // Jonah, 4 Nov 2026: a Yard Talk post, once it is live, goes on the schedule
  // by itself. Read from the site's own feed, so one waiting for his OK isn't in it.
  function yardTalkHtml() {
    const on = cfg.yardTalk !== false;
    return '<div class="sp-place-box"><div class="sp-place-head"><b>📝 New Yard Talk posts</b>' +
        '<div class="sp-choice"><button class="btn btn-sm' + (on ? ' btn-filled' : '') + '" onclick="spYardTalk(true)">' +
          (on ? '✓ ' : '') + 'Announce them</button><button class="btn btn-sm' + (!on ? ' btn-filled' : '') +
          '" onclick="spYardTalk(false)">' + (!on ? '✓ ' : '') + 'Don’t</button></div></div>' +
      '<p class="hint">When a new post is live on the website, it takes the next time on Facebook, Instagram and Nextdoor, ' +
        'once each. Whatever was planned there goes back in line. Posts you changed by hand stay put.</p></div>';
  }

  function slotHtml(s, i) {
    return '<div class="sp-slot">' +
      '<div class="sp-days">' + DAYS.map((d, k) => '<button class="sp-day-btn' + (s.day === k ? ' on' : '') +
        '" onclick="spSlot(' + i + ', \'day\', ' + k + ')">' + d + '</button>').join('') + '</div>' +
      '<div class="sp-slot-row"><input type="time" value="' + esc(s.time) + '" onchange="spSlot(' + i + ', \'time\', this.value)" ' +
        'aria-label="Time">' +
        '<button class="link-btn sp-slot-x" onclick="spSlotRemove(' + i + ')" aria-label="Take this time off">✕ Take it off</button></div>' +
      '<div class="sp-slot-row">' +
        '<button class="btn btn-sm' + (s.every !== 2 ? ' btn-filled' : '') + '" onclick="spSlot(' + i + ', \'every\', 1)">Every week</button>' +
        '<button class="btn btn-sm' + (s.every === 2 ? ' btn-filled' : '') + '" onclick="spSlot(' + i + ', \'every\', 2)">Every other week</button></div>' +
      '<div class="sp-slot-row">' + SEASONS.map(([k, w]) => '<button class="btn btn-sm' + (s.season === k ? ' btn-filled' : '') +
        '" onclick="spSlot(' + i + ', \'season\', \'' + k + '\')">' + w + '</button>').join('') + '</div>' +
    '</div>';
  }

  // ---- hooking up

  function hookupHtml() {
    const fb = (hook && hook.facebook) || {};
    const g = (hook && hook.google) || cfg.google || {};
    const ig = (hook && hook.instagram) || cfg.instagram || {};
    const fbc = cfg.facebook || {};
    const redirect = fb.redirect || '';
    const copy = (text, label) => '<button class="btn btn-sm" data-copy="' + esc(text) + '" onclick="spCopyText(this.dataset.copy)">📋 ' +
      label + '</button>';
    const fbHtml = fb.connected
      ? '<p>✓ Posting to <b>' + esc(fbc.pageName || 'your Page') + '</b>' +
          (fbc.pageLink ? ' <a href="' + esc(fbc.pageLink) + '" target="_blank" rel="noopener">↗</a>' : '') + '</p>' +
        ((fbc.pages || []).length > 1 ? '<div class="sp-choice">' + fbc.pages.map(x => '<button class="btn btn-sm' +
          (x.id === fbc.pageId ? ' btn-filled' : '') + '" onclick="spFbPage(\'' + safeId(x.id) + '\')">' + esc(x.name) + '</button>').join('') + '</div>' : '') +
        '<div class="field-actions"><button class="btn btn-sm" onclick="spFbConnect()">Hook up again</button>' +
          '<button class="btn btn-sm" onclick="spFbOff()">Unhook Facebook</button></div>'
      : (fbc.error ? '<div class="sp-why">' + esc(fbc.error) + '</div>' : '') + (!fb.appSet
        ? '<ol class="sp-steps">' +
            '<li>On a computer, open <a href="https://developers.facebook.com/apps/creation/" target="_blank" rel="noopener">' +
              'developers.facebook.com → Create app</a> (signed in as you, the Page’s admin — register as a developer first if it ' +
              'asks). Name it “YD Job Hub”, pick the use case <b>Manage everything on your Page</b> (under Content management), ' +
              'no business portfolio, and Create app.</li>' +
            '<li>In the app: <b>Use cases → Customize</b> — Add <b>pages_manage_posts</b> and <b>pages_read_engagement</b>. Under ' +
              '<b>Facebook Login for Business → Settings</b>, add this to <b>Valid OAuth Redirect URIs</b> and Save:<div class="sp-code">' +
              esc(redirect || 'shown once the server is updated') + '</div>' + (redirect ? copy(redirect, 'Copy it') : '') + '</li>' +
            '<li><b>App settings → Basic</b>: Privacy policy URL <span class="sp-code">' +
              'https://jonahlinfieldydexteriorvisionsllc.github.io/yd-job-hub/privacy.html</span>, Data deletion instructions URL ' +
              '<span class="sp-code">https://jonahlinfieldydexteriorvisionsllc.github.io/yd-job-hub/privacy.html#delete</span>, ' +
              'Category “Business and pages”, Save. Then <b>Publish</b> in the left menu (until it is published, posts show only ' +
              'to you).</li>' +
            '<li>Copy the <b>App ID</b> and the <b>App secret</b> (Show) from App settings → Basic into here:' +
              '<label class="sp-lbl">App ID<input id="spFbId" inputmode="numeric" autocomplete="off" value="' + esc(fbForm.appId) +
                '" oninput="spFbSet(\'appId\', this.value)"></label>' +
              '<label class="sp-lbl">App secret<input id="spFbSecret" type="password" autocomplete="off" value="' + esc(fbForm.appSecret) +
                '" oninput="spFbSet(\'appSecret\', this.value)"></label>' +
              '<div class="field-actions"><button class="btn btn-filled" onclick="spFbApp()">Save them</button></div></li>' +
          '</ol>'
        : '<p>Your Facebook app is set up (App ID ' + esc(fb.appId || '') + ').' + (redirect ? ' Its Valid OAuth Redirect URI must be:' +
            '<span class="sp-code">' + esc(redirect) + '</span>' : '') + '</p>' +
          '<div class="field-actions"><button class="btn btn-filled" onclick="spFbConnect()">Hook up Facebook</button>' +
            '<button class="link-btn" onclick="spFbAppAgain()">Put in a different app</button></div>' +
          '<p class="hint">Facebook asks which Pages to share — tick <b>YD Exterior Visions</b>. Job Hub only ever posts as ' +
            'the business, never to your own Page. If Facebook doesn’t show the Pages, tap <b>Edit access</b> (or Edit ' +
            'previous settings) there.</p>');
    const igHtml = ig.ok
      ? '<p>✓ Posting to <b>@' + esc(ig.username || '') + '</b>.</p><button class="btn btn-sm" onclick="spInstagram()">Check again</button>'
      : (ig.error ? '<div class="sp-why">' + esc(ig.error) + '</div>' : '') +
        '<ol class="sp-steps">' +
          '<li>In the Instagram app, signed in as the business: make it a <b>Business</b> account (Settings → Account type and ' +
            'tools) and link it to the <b>YD Exterior Visions</b> Facebook Page.</li>' +
          '<li>At <a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener">developers.facebook.com</a>, ' +
            'in the YD Job Hub app: <b>Use cases → Customize</b> — add <b>instagram_basic</b>, <b>instagram_content_publish</b>, ' +
            '<b>ads_management</b> and <b>ads_read</b>.</li>' +
          '<li>Under Facebook above, tap <b>Hook up again</b>. Tick the YD Exterior Visions Page and the Instagram account when ' +
            'Facebook asks.</li>' +
          '<li><button class="btn btn-sm btn-filled" onclick="spInstagram()">Check Instagram</button></li>' +
        '</ol>';
    const gHtml = g.ok
      ? '<p>✓ Posting to <b>' + esc(g.title || 'your Business Profile') + '</b>. The week’s new After photos go onto the ' +
          'profile with each post.</p><button class="btn btn-sm" onclick="spGoogle()">Check again</button>'
      : (g.error ? '<div class="sp-why">' + esc(g.error) + '</div>' : '') +
        '<ol class="sp-steps">' +
          '<li><b>Ask Google for access</b> (free; Google reviews it, usually within a couple of weeks): open the ' +
            '<a href="https://support.google.com/business/contact/api_default" target="_blank" rel="noopener">Business Profile API ' +
            'form</a>, choose <b>Application for Basic API Access</b>, sign in as an owner of the profile, and give the project ' +
            'number <span class="sp-code">147632184660</span>.</li>' +
          '<li>Once Google says yes: in Cloud Shell, paste<div class="sp-code">gcloud services enable mybusiness.googleapis.com ' +
            'mybusinessaccountmanagement.googleapis.com mybusinessbusinessinformation.googleapis.com --project yd-job-hub</div>' +
            copy('gcloud services enable mybusiness.googleapis.com mybusinessaccountmanagement.googleapis.com mybusinessbusinessinformation.googleapis.com --project yd-job-hub', 'Copy it') + '</li>' +
          '<li>Google Admin console → Security → API controls → Domain-wide delegation → the Job Hub row (the one that already ' +
            'has gmail.send) → Edit → add <span class="sp-code">https://www.googleapis.com/auth/business.manage</span> on its own line → Authorize.</li>' +
          '<li>Make sure jonahlinfield@ydexteriorvisions.com is an <b>owner or manager</b> of the Business Profile ' +
            '(Business Profile → ⋮ → Business Profile settings → People and access).</li>' +
          '<li><button class="btn btn-sm btn-filled" onclick="spGoogle()">Check Google</button></li>' +
        '</ol>';
    const ndHtml = '<p>Nextdoor keeps posting by itself for public agencies, local news, local events and marketplace listings, ' +
        'not for a business promoting itself. So at each Nextdoor time your phone is told and the post waits at the top of ' +
        'Media, where one tap opens Nextdoor with the words already in — add the photos and post.</p>';
    return '<div class="sp-place-box"><b>📘 Facebook</b>' + fbHtml + '</div>' +
      '<div class="sp-place-box"><b>📷 Instagram</b>' + igHtml + '</div>' +
      '<div class="sp-place-box"><b>📍 Google Business Profile</b>' + gHtml + '</div>' +
      '<div class="sp-place-box"><b>🏘️ Nextdoor</b>' + ndHtml + '</div>';
  }

  // ------------------------------------------------------------ taps

  // The tab arrived at (app.js switchTab): read what may have moved since.
  function render() {
    if (!isOwner()) return;
    draw();
    loadCfg();
    loadHook();
    // Went up's button counts the month, which can be older than the live weeks.
    readOld();
  }
  // Every old way in -- Home's Waiting on you, a push about a post held or
  // not gone up, Search, a habit -- lands on the tab.
  window.openPosts = function () {
    if (!isOwner() || typeof switchTab !== 'function' || !el('panel-media')) return;
    showTab();
    if (panelOn()) render();
    else switchTab('media');
  };
  // The phone's "Nextdoor post ready": the tab, at its card, which may still
  // be on its way when the app has only just opened.
  window.openNextdoor = function () {
    readyUntil = Date.now() + 30000;
    window.openPosts();
  };
  // An app.js from before 9 Nov (one load can mix old and new files) still
  // sends a Nextdoor push here.
  window.homeNextdoor = window.openNextdoor;
  window.spView = k => { view = k; open = null; draw(); if (k === 'up') readOld(); };
  // The website report read or changed: drawn when it's the part showing, and
  // its button's words either way.
  document.addEventListener('yd-site-report', () => draw());
  window.spUpPlace = k => { upPlace = PLACES.indexOf(k) !== -1 ? k : ''; open = null; draw(); };
  window.spReadOld = () => readOld(true);
  window.spDown = (id, on) => {
    const p = posts[id] || old[id];
    if (!p || p.status !== 'posted') return;
    const was = p.takenDownAt || null;
    patchPost(id, { takenDownAt: on ? new Date().toISOString() : null }, on ? 'marking it taken down' : 'marking it up');
    if (window.showUndo) showUndo(on ? 'Marked as taken down' : 'Marked as still up', () => patchPost(id, { takenDownAt: was }, 'putting it back'));
  };
  window.spStart = async () => {
    await save({ on: true, auto: true, from: new Date().toISOString() }, 'starting the schedule');
    view = 'coming';
    const r = await ask('/social/plan-now', {}, 'Filling the next week…');
    if (r && !r.off) showToast(r.planned ? 'Planned ' + r.planned + ' post' + (r.planned === 1 ? '' : 's') : 'Started — nothing to post yet');
  };
  window.spAuto = on => save({ auto: !!on }, 'that choice');
  window.spPause = days => {
    if (!days) { save({ pausedUntil: null }, 'starting again'); return; }
    save({ pausedUntil: addDays(localYMD(), days - 1) }, 'pausing');
    if (window.showUndo) showUndo('Posting paused', () => save({ pausedUntil: null }, 'starting again'));
  };
  window.spPlanNow = () => replan();
  window.spOpen = id => { open = open === id ? null : id; draw(); };
  window.spSaveText = id => {
    const t = el('spText_' + id);
    if (!t) return;
    const text = t.value.trim();
    if (!text) { showToast('The words are empty'); return; }
    t.blur();
    delete drafts[id];
    // His own words: nothing holds them (social.py checks only Claude's).
    patchPost(id, { text: text, edited: true }, 'the words').then(() => showToast('Saved'));
  };
  window.spDropPhoto = (id, i) => {
    const p = posts[id];
    if (!p) return;
    const was = (p.photos || []).slice();
    if (lastPhotoStays(p, was.length)) return;
    patchPost(id, { photos: was.filter((_, k) => k !== i), edited: true }, 'the photos');
    if (window.showUndo) showUndo('Photo left out', () => patchPost(id, { photos: was }, 'the photos'));
  };
  // Instagram can't take a post with no photo.
  function lastPhotoStays(p, count) {
    if (p.place !== 'instagram' || count > 1) return false;
    showToast('Instagram needs a photo — tap another one on first');
    return true;
  }
  window.spFirstPhoto = (id, i) => {
    const p = posts[id];
    if (!p || !(p.photos || [])[i]) return;
    const was = p.photos.slice();
    patchPost(id, { photos: [was[i]].concat(was.filter((_, k) => k !== i)), edited: true }, 'the photos');
    if (window.showUndo) showUndo('Moved to first', () => patchPost(id, { photos: was }, 'the photos'));
  };
  window.spChoose = async id => {
    const p = posts[id];
    if (!p) return;
    choosing[id] = !choosing[id];
    // Read afresh each time: a photo may have been added to the job since.
    delete jobShots[p.jobId];
    draw();
    if (!choosing[id]) return;
    let got = null;
    try { got = await window.YDDb.listWhere('jobPhotos', 'jobId', '==', p.jobId); }
    catch (e) { console.warn('[posts] job photos not read:', e && (e.code || e.message)); }
    if (!got) { choosing[id] = false; showToast('Couldn’t read this job’s photos — try again'); draw(); return; }
    jobShots[p.jobId] = Object.entries(got)
      .filter(([, x]) => !x.deleteAsked && /^https:\/\//.test(x.url || '') && STAGE_WORDS[x.stage])
      .map(([pid, x]) => ({ id: pid, url: x.url, thumb: x.thumbUrl || x.url, stage: x.stage, at: x.at || '' }))
      .sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    draw();
  };
  window.spPick = (id, pid) => {
    const p = posts[id];
    const row = p && (jobShots[p.jobId] || []).find(x => safeId(x.id) === pid);
    if (!row) return;
    const was = (p.photos || []).slice();
    const most = PHOTO_MOST[p.place] || 4;
    const one = { id: row.id, url: row.url, thumb: row.thumb, stage: row.stage };
    const isOn = was.some(x => x.id === row.id);
    if (isOn && lastPhotoStays(p, was.length)) return;
    const full = !isOn && was.length >= most;
    patchPost(id, { photos: isOn ? was.filter(x => x.id !== row.id) : was.slice(0, full ? most - 1 : most).concat(one), edited: true }, 'the photos');
    const why = !isOn && ((p.photosLeftOut || []).find(l => l.id === row.id) || {}).why;
    if (window.showUndo && (full || why)) showUndo(why ? 'Claude left this one out: ' + why : 'Swapped in for the last photo', () => patchPost(id, { photos: was }, 'the photos'));
  };
  window.spMove = (id, v) => {
    const t = new Date(v);
    if (!v || isNaN(t)) return;
    if (t < new Date()) { showToast('Pick a time still to come — or Post now'); draw(); return; }
    // A missed or failed one moved to a new time goes back in line: left as
    // it was, nothing would ever put it up (the server takes queued ones).
    const p = posts[id];
    const again = p && (p.status === 'missed' || p.status === 'failed') ? { status: 'queued', error: null, tries: 0 } : {};
    patchPost(id, Object.assign({ at: t.toISOString(), day: localYMD(t), edited: true }, again), 'the time')
      .then(() => showToast('Moved to ' + when(t.toISOString())));
  };
  window.spHold = id => patchPost(id, { status: 'held', heldWhy: 'You held it' }, 'holding it');
  window.spLet = id => {
    const p = posts[id];
    if (!p) return;
    if (new Date(p.at) <= new Date()) { window.spNow(id); return; }
    patchPost(id, { status: 'queued', heldWhy: null, okAt: new Date().toISOString() }, 'your OK');
  };
  window.spSkip = id => {
    const p = posts[id];
    if (!p) return;
    const was = { status: p.status, heldWhy: p.heldWhy || null };
    patchPost(id, { status: 'skipped' }, 'skipping it');
    // Only queued or held can be put back (the rules refuse a post being set
    // to failed, missed, not hooked up or ready) -- no Undo that can't undo.
    if (window.showUndo && (was.status === 'queued' || was.status === 'held')) {
      showUndo('Skipped', () => patchPost(id, was, 'putting it back'));
    } else showToast('Skipped');
  };
  // Said at once: with no signal the write only settles once it reaches the server.
  window.spDone = id => {
    if (!posts[id]) return;
    patchPost(id, { status: 'posted', postedAt: new Date().toISOString(), heldWhy: null }, 'ticking it off');
    showToast('✓ Ticked off — it’s under Went up');
  };

  // ---- A Nextdoor post ready, at the top of Media. Jonah (4 Nov 2026): "keep
  // the tap"; (9 Nov) on the Media tab, not Home. Everything that tap needs
  // is on the card: the words, the photos, the button that opens Nextdoor and
  // the tick. Opening Nextdoor doesn't mean it went up, so nothing is saved
  // until he says so; the tick just takes the lead once he has been there.
  const READY_WORDS = 240;      // past this the words fold to a few lines
  const readyOpened = {};       // opened from here this visit
  const readyWhole = {};        // showing all the words
  window.spReadyOpened = id => { readyOpened[id] = true; changed(); };
  window.spReadyWords = id => { readyWhole[id] = !readyWhole[id]; changed(); };
  // Nothing can put a ready post back (the rules refuse it), so it asks.
  window.spReadySkip = async id => {
    if (await ydConfirm('Skip this Nextdoor post? It won’t come back. The next one comes up on its own day.', { ok: 'Skip it' })) window.spSkip(id);
  };
  function readyCardHtml(p) {
    const id = safeId(p.id);
    const text = String(p.text || '');
    const long = text.length > READY_WORDS;
    const clip = long && !readyWhole[id];
    const been = !!readyOpened[id];
    const photos = photosOf(p);
    const openIt = (words, lead) => '<a class="btn' + (lead ? ' btn-filled' : '') + '" href="' + esc(shareUrl(p)) + '" target="_blank" rel="noopener" ' +
      'onclick="spReadyOpened(\'' + id + '\')">' + words + '</a>';
    const tick = lead => '<button class="btn' + (lead ? ' btn-filled' : '') + '" onclick="spDone(\'' + id + '\')">✓ I posted it</button>';
    return '<div class="sp-ready">' +
      '<div class="sp-ready-what"><b>' + esc(whatOf(p)) + '</b><small>Ready since ' + esc(when(p.readyAt || p.at)) + '</small></div>' +
      '<div class="sp-text' + (clip ? ' sp-ready-clip' : '') + '">' + esc(text) + '</div>' +
      (long ? '<button class="sp-ready-more" onclick="spReadyWords(\'' + id + '\')">' + (clip ? 'Show all the words' : 'Show less') + '</button>' : '') +
      (photos.length ? '<div class="sp-photos">' + photos.map((x, i) => '<span class="sp-photo">' +
          '<a href="' + esc(x.url) + '" target="_blank" rel="noopener"><img src="' + esc(x.thumb || x.url) + '" alt="Photo ' + (i + 1) + '"></a>' + stageTag(x) + '</span>').join('') + '</div>' +
        '<p class="hint">Tap a photo to open it, save it, then add it in Nextdoor.</p>' : '') +
      // The job's other photos, to swap in, right here on the card.
      (p.kind === 'job' && p.jobId ? chooserHtml(p) : '') +
      '<div class="sp-acts sp-ready-acts">' +
        (been ? tick(true) + openIt('Open Nextdoor again') : openIt('🏘️ Open Nextdoor with the words in', true) + tick()) +
        '<button class="btn" onclick="spCopy(\'' + id + '\')">📋 Copy words</button>' +
        '<button class="btn" onclick="spReadySkip(\'' + id + '\')">Skip it</button>' +
      '</div></div>';
  }
  window.spNow = async id => {
    const p = posts[id];
    if (!p) return;
    if (!(await ydConfirm('Put this ' + (NAMES[p.place] || '') + ' post up now?', { ok: 'Post it now' }))) return;
    const r = await ask('/social/post-now', { id: p.id }, 'Posting…');
    if (!r) return;
    showToast(r.status === 'posted' ? '✓ It’s up' : r.status === 'ready' ? 'Ready — open Nextdoor to post it'
      : 'Not posted: ' + (r.error || r.status));
  };
  // Claude writes the job's words again; every post of the job not up yet
  // and not changed by hand takes them (social.py rewrite).
  // withNote: from "Write it again with my note" -- the note box goes too
  // (an emptied box takes the note off).
  window.spRewrite = async (id, withNote) => {
    const p = posts[id];
    if (!p) return;
    const box = withNote ? el('spNote_' + safeId(p.id)) : null;
    if (p.edited && !(await ydConfirm('You changed this one by hand — Claude’s new words won’t replace yours here ' +
        '(they will on the job’s other posts). Go on?', { ok: 'Write them again' }))) return;
    delete drafts[safeId(p.id)];
    delete drafts['n_' + safeId(p.id)];
    const body = box ? { id: p.id, note: box.value.trim().slice(0, 1000) } : { id: p.id };
    const r = await ask('/social/rewrite', body, 'Claude is writing it again…');
    if (r) showToast(r.error || 'Written again — ' + r.posts + ' post' + (r.posts === 1 ? '' : 's') + ' changed');
  };
  window.spCopy = id => {
    const p = posts[id];
    if (p) window.spCopyText(p.text || '');
  };
  window.spCopyText = text => {
    const t = String(text || '');
    if (!navigator.clipboard) { showToast('Could not copy — hold on the words to copy them'); return; }
    navigator.clipboard.writeText(t).then(() => showToast('Copied'), () => showToast('Could not copy'));
  };
  window.spOwnOpen = () => {
    const t = new Date(Date.now() + 3600000);
    t.setMinutes(0, 0, 0);
    own = { places: { facebook: true, google: false, nextdoor: false }, text: '',
      at: localYMD(t) + 'T' + String(t.getHours()).padStart(2, '0') + ':00' };
    draw();
  };
  window.spOwnPlace = p => { if (own) { own.places[p] = !own.places[p]; draw(); } };
  window.spOwnSet = (k, v) => { if (own) own[k] = v; };
  window.spOwnCancel = () => { own = null; draw(); };
  window.spOwnSave = () => {
    if (!own) return;
    const text = String(own.text || '').trim(), t = new Date(own.at);
    const places = PLACES.filter(p => own.places[p]);
    if (!text) { showToast('Write the words'); return; }
    if (!places.length) { showToast('Pick where it goes'); return; }
    if (!own.at || isNaN(t) || t < new Date()) { showToast('Pick a time still to come'); return; }
    const stamp = Date.now().toString(36);
    const entries = places.map(p => ['socialPosts', 'sph' + stamp + p.charAt(0), {
      place: p, at: t.toISOString(), day: localYMD(t), kind: 'own', slotId: null, jobId: null, ideaId: null,
      text: text.slice(0, p === 'google' ? 1500 : 5000), words: text, signOff: '', photos: [],
      status: cfg.auto === false ? 'held' : 'queued', heldWhy: cfg.auto === false ? 'Waiting for your OK' : null,
      tries: 0, error: null, edited: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      by: (window.YDAuth.user || {}).uid || '' }]);
    own = null;
    Promise.resolve(window.YDDb.putMany(entries)).then(() => showToast('On the schedule'), () => showToast('Not saved — try again'));
  };

  function setSlots(list) {
    save({ slots: list }, 'the schedule').then(replan);
  }
  window.spSlot = (i, k, v) => {
    const list = slotsOf(cfg).map(s => Object.assign({}, s));
    if (!list[i]) return;
    if (k === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return;
    list[i][k] = v;
    setSlots(list);
  };
  window.spSlotAdd = p => {
    const list = slotsOf(cfg).map(s => Object.assign({}, s));
    list.push({ id: 's' + Date.now().toString(36), place: p, day: 3, time: p === 'nextdoor' ? '18:00' : '10:00',
      every: p === 'nextdoor' ? 2 : 1, season: 'all' });
    setSlots(list);
  };
  window.spSlotRemove = i => {
    const was = slotsOf(cfg).map(s => Object.assign({}, s));
    setSlots(was.filter((_, k) => k !== i));
    if (window.showUndo) showUndo('Took that time off', () => setSlots(was));
  };
  window.spSlotsReset = () => setSlots(DEFAULT_SLOTS.map(s => Object.assign({}, s)));
  window.spPlaceOn = (p, on) => {
    save({ places: Object.assign({}, cfg.places, { [p]: { on: !!on } }) }, 'that choice').then(replan);
  };
  window.spSign = p => {
    const t = el('spSign_' + p);
    if (!t) return;
    t.blur();
    save({ signOff: Object.assign({}, cfg.signOff, { [p]: t.value.trim().slice(0, 300) }) }, 'the line')
      .then(() => showToast('Saved — on posts planned from now'));
  };
  window.spYardTalk = on => { save({ yardTalk: !!on }, 'that choice').then(replan); };
  window.spFbSet = (k, v) => { fbForm[k] = v; };
  window.spFbApp = async () => {
    const r = await ask('/social/fb/app', { appId: fbForm.appId, appSecret: fbForm.appSecret }, 'Checking with Facebook…');
    if (!r) return;
    if (r.error) { showToast(r.error); return; }
    fbForm = { appId: '', appSecret: '' };
    showToast('Saved — now hook up Facebook');
    loadHook();
  };
  window.spFbAppAgain = () => { if (hook && hook.facebook) hook.facebook.appSet = false; draw(); };
  window.spFbConnect = async () => {
    const r = await ask('/social/fb/connect-url', {}, 'Opening Facebook…');
    if (!r) return;
    if (r.error) { showToast(r.error); return; }
    // A full navigation, as QuickBooks: Facebook's page brings him back to
    // the server's page, which links back here.
    window.location.href = r.url;
  };
  window.spFbPage = async id => {
    const r = await ask('/social/fb/page', { pageId: id }, 'Switching Page…');
    if (r && r.error) showToast(r.error);
    loadCfg();
    loadHook();
  };
  window.spFbOff = async () => {
    if (!(await ydConfirm('Unhook Facebook? Posts there stop going up until you hook it up again.', { ok: 'Unhook' }))) return;
    await ask('/social/fb/disconnect', {}, 'Unhooking…');
    loadCfg();
    loadHook();
  };
  window.spInstagram = async () => {
    const r = await ask('/social/instagram/check', {}, 'Checking Instagram…');
    if (r) showToast(r.ok ? '✓ Instagram is hooked up — @' + (r.username || '') : (r.error || 'Not yet'));
    loadCfg();
    loadHook();
  };
  window.spGoogle = async () => {
    const r = await ask('/social/google/check', {}, 'Checking Google…');
    if (r) showToast(r.ok ? '✓ Google is hooked up — ' + (r.title || 'your profile') : (r.error || 'Not yet'));
    loadCfg();
    loadHook();
  };

  // A box left after typing draws what waited -- but not under the press that
  // left it: the redraw used to swap "Save the words" for a new button between
  // mouse-down and mouse-up, so the click never happened. Focus moving to
  // something else in the window waits; otherwise the redraw waits a moment.
  document.addEventListener('focusout', e => {
    const body = el('spBody');
    if (!body || !body.dataset.later) return;
    if (e.relatedTarget && body.contains(e.relatedTarget)) return;
    setTimeout(draw, 300);
  });
  // Words typed and not saved yet survive any redraw.
  document.addEventListener('input', e => {
    const t = e.target;
    if (t && t.id && t.id.indexOf('spText_') === 0) drafts[t.id.slice(7)] = t.value;
    if (t && t.id && t.id.indexOf('spNote_') === 0) drafts['n_' + t.id.slice(7)] = t.value;
  });

  // ------------------------------------------------------------ the rest of Job Hub

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user && a.isOwner ? a.user.uid : null;
    if (k === who) return;
    who = k;
    cfg = null;
    hook = null;
    open = null;
    own = null;
    old = {};
    oldAt = 0;
    oldFailed = false;
    upPlace = '';
    // Nothing half-typed or half-done carries over to another sign-in.
    [drafts, choosing, readyOpened, readyWhole].forEach(o => Object.keys(o).forEach(k => { delete o[k]; }));
    showTab();
    if (k) { loadCfg(); watchPosts(); } else { if (unwatch) { unwatch(); unwatch = null; } posts = {}; changed(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && who) loadCfg(); });
  // The tab is the owner's alone (the rules let only him read socialPosts).
  function showTab() {
    const t = el('tabMedia');
    if (t) t.hidden = !who;
  }

  window.YDPosts = {
    // The tab's count and Home's Waiting on you: posts that need him (held,
    // ready on Nextdoor, didn't go up), soonest first.
    needs: () => isOwner() && cfg && cfg.on
      ? Object.values(posts).filter(p => NEEDS.indexOf(p.status) !== -1).sort((a, b) => String(a.at).localeCompare(String(b.at)))
      : [],
    // Posts waiting for his tap on Nextdoor (the card at the top of Media).
    readyToPost: () => window.YDPosts.needs().filter(p => p.status === 'ready'),
    // app.js switchTab, on arriving at the tab.
    render: render,
    // A home.js from before 9 Nov (one load can mix old and new files) asks
    // for the Nextdoor card it used to draw: nothing now, so Home doesn't break.
    readyHtml: () => '',
    on: () => !!(cfg && cfg.on),
    names: NAMES,
    icons: ICONS,
    // For the tests.
    _shareUrl: shareUrl,
  };
})();
