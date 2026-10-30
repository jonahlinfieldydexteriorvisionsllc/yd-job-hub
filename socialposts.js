// 📣 Posts: Facebook, Google Business Profile and Nextdoor on a schedule.
// Jonah (30 Oct 2026): "lets setup automatic facebook, nextdoors, and google
// profile posting. i want a set schedule for all this where posts go up at
// the right times on the right days."
//
// The server does the work (functions/social.py): after the morning and
// evening summaries it fills the next 8 days of slots -- a finished job with
// After photos, else one of the month's seasonal posts -- and every five
// minutes a post whose time has come goes up. Nextdoor only lets approved
// partners post by themselves, so a Nextdoor post is "ready" at its time and
// one tap here opens Nextdoor with the words already in.
//
// Here (the owner's alone): what is coming up and what went up, each post's
// words, photos and time to change, hold, let go, skip or post now; the
// schedule itself (settings/social.slots -- social.py DEFAULT_SLOTS until he
// changes it); the line under every post (signOff); and hooking up Facebook
// and Google. Home's Waiting on you shows posts that need him (YDPosts.needs).
(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const safeId = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner && window.YDAuth.user);

  const PLACES = ['facebook', 'google', 'nextdoor'];
  const NAMES = { facebook: 'Facebook', google: 'Google', nextdoor: 'Nextdoor' };
  const ICONS = { facebook: '📘', google: '📍', nextdoor: '🏘️' };
  // The same as functions/social.py DEFAULT_SLOTS (keep the two the same).
  const DEFAULT_SLOTS = [
    { id: 'fb1', place: 'facebook', day: 2, time: '09:30', every: 1, season: 'all' },
    { id: 'fb2', place: 'facebook', day: 4, time: '13:00', every: 1, season: 'all' },
    { id: 'fb3', place: 'facebook', day: 6, time: '09:00', every: 1, season: 'growing' },
    { id: 'gb1', place: 'google', day: 2, time: '08:30', every: 1, season: 'all' },
    { id: 'nd1', place: 'nextdoor', day: 4, time: '18:00', every: 2, season: 'all' },
  ];
  const WHY = {
    facebook: 'Weekday mid-morning and early afternoon are the steadiest times on Facebook; Saturday morning is when ' +
      'homeowners plan their yard, April to October.',
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

  let cfg = null;          // settings/social as read
  let hook = null;         // /social/status: the hookups
  let posts = {};          // socialPosts by id (from three weeks back)
  let unwatch = null;
  let who = null;
  let view = 'coming';     // coming | schedule | hookup
  let open = null;         // the post opened for changing
  let busy = '';           // what the server is doing for us
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
  function changed() {
    document.dispatchEvent(new CustomEvent('yd-social'));
    if (el('spModal') && el('spModal').classList.contains('active')) draw();
  }

  const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00'); d.setDate(d.getDate() + n); return localYMD(d); };
  function when(iso) {
    const t = new Date(iso);
    if (isNaN(t)) return '';
    const day = localYMD(t), today = localYMD();
    const d = day === today ? 'Today' : day === addDays(today, 1) ? 'Tomorrow' : day === addDays(today, -1) ? 'Yesterday'
      : t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
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
    const p = posts[id];
    if (!p) return Promise.resolve();
    Object.assign(p, patch);
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
    const gone = Object.values(posts).filter(p => p.kind !== 'own' && !p.edited &&
      ['queued', 'notConnected'].indexOf(p.status) !== -1 && new Date(p.at).getTime() > soon);
    if (gone.length && window.YDDb.removeMany) {
      await Promise.resolve(window.YDDb.removeMany(gone.map(p => ['socialPosts', p.id]))).catch(() => {});
      gone.forEach(p => { delete posts[p.id]; });
    }
    const r = await ask('/social/plan-now', {}, 'Filling the schedule…');
    if (r && !r.off) showToast(r.planned ? 'Planned ' + r.planned + ' post' + (r.planned === 1 ? '' : 's') : 'Nothing new to plan');
  }

  // ------------------------------------------------------------ the window

  function modal() {
    let m = el('spModal');
    if (m) return m;
    m = document.createElement('div');
    m.className = 'modal-overlay';
    m.id = 'spModal';
    m.innerHTML = '<div class="modal sp-modal" role="dialog" aria-labelledby="spTitle">' +
      '<div class="modal-head"><h2 id="spTitle">📣 Posts</h2>' +
      '<button class="modal-close" onclick="closePosts()" aria-label="Close">&times;</button></div>' +
      '<div class="modal-body" id="spBody"></div></div>';
    document.body.appendChild(m);
    return m;
  }

  function draw() {
    const body = el('spBody');
    if (!body || !el('spModal').classList.contains('active')) return;
    // A box being typed in is never wiped by a redraw; it draws on leaving it.
    if (body.contains(document.activeElement) && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName) &&
        document.activeElement.type !== 'checkbox') { body.dataset.later = '1'; return; }
    body.dataset.later = '';
    if (!cfg) { body.innerHTML = '<p class="empty-msg">Loading…</p>'; return; }
    if (!cfg.on) { body.innerHTML = startHtml(); return; }
    const tabs = [['coming', 'Coming up'], ['schedule', 'The schedule'], ['hookup', 'Hook up']];
    body.innerHTML =
      (busy ? '<div class="sp-busy">⏳ ' + esc(busy) + '</div>' : '') +
      autoHtml() +
      '<div class="sp-tabs">' + tabs.map(([k, w]) => '<button class="btn btn-sm' + (view === k ? ' btn-filled' : '') +
        '" onclick="spView(\'' + k + '\')">' + w + '</button>').join('') + '</div>' +
      (view === 'schedule' ? scheduleHtml() : view === 'hookup' ? hookupHtml() : comingHtml());
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
    const needs = list.filter(p => NEEDS.indexOf(p.status) !== -1);
    const ahead = list.filter(p => NEEDS.indexOf(p.status) === -1 && p.day >= today &&
      ['queued', 'posting', 'notConnected'].indexOf(p.status) !== -1);
    const gone = list.filter(p => ['posted', 'missed', 'skipped'].indexOf(p.status) !== -1 ||
      (p.status === 'notConnected' && p.day < today)).reverse().slice(0, 30);
    const off = PLACES.filter(p => placeOn(cfg, p) && !hooked(p));
    let byDay = '', lastDay = '';
    ahead.forEach(p => {
      if (p.day !== lastDay) {
        lastDay = p.day;
        byDay += '<h4 class="sp-day">' + esc(when(p.at).split(',')[0]) + '</h4>';
      }
      byDay += rowHtml(p);
    });
    return (off.length ? '<div class="sp-note">' + off.map(p => ICONS[p] + ' ' + NAMES[p]).join(', ') +
          (off.length === 1 ? ' isn’t' : ' aren’t') + ' hooked up yet — ' + (off.indexOf('nextdoor') !== -1 && off.length === 1
            ? '' : 'until ' + (off.length === 1 ? 'it is' : 'they are') + ', those posts are kept here for you to copy. ') +
          '<button class="link-btn" onclick="spView(\'hookup\')">Hook up</button></div>' : '') +
      (needs.length ? '<h3 class="sp-h">Needs you</h3>' + needs.map(rowHtml).join('') : '') +
      '<h3 class="sp-h">Coming up</h3>' +
      (byDay || '<p class="empty-msg">Nothing planned yet' + (cfg.planWaiting
        ? ' — ' + cfg.planWaiting + ' slot' + (cfg.planWaiting === 1 ? ' has' : 's have') + ' nothing to post yet'
        : '') + '.</p>') +
      '<div class="field-actions"><button class="btn btn-sm" onclick="spPlanNow()"' + (busy ? ' disabled' : '') +
        '>Plan them now</button><button class="btn btn-sm" onclick="spOwnOpen()">+ A post of your own</button></div>' +
      (own ? ownHtml() : '') +
      (gone.length ? '<details class="sp-gone"><summary>Gone up and past (' + gone.length + ')</summary>' +
        gone.map(rowHtml).join('') + '</details>' : '');
  }

  function hooked(place) {
    if (place === 'nextdoor') return true;              // posted by him, from here
    if (place === 'facebook') return !!(hook && hook.facebook && hook.facebook.connected);
    if (place === 'google') return !!((hook && hook.google && hook.google.ok) || (cfg.google && cfg.google.ok));
    return false;
  }

  function rowHtml(p) {
    const st = STATUS[p.status] || [p.status, ''];
    const isOpen = open === p.id;
    const what = p.kind === 'job' ? (p.jobName || 'A finished job') + (p.town ? ' · ' + p.town : '')
      : p.kind === 'idea' ? '🍂 ' + (p.topic || 'Seasonal post') : '✍️ Your post';
    const photos = (p.photos || []).filter(x => /^https:\/\//.test((x || {}).url || ''));
    return '<div class="sp-row' + (isOpen ? ' open' : '') + '" id="spRow_' + safeId(p.id) + '">' +
      '<button class="sp-row-head" onclick="spOpen(\'' + safeId(p.id) + '\')" aria-expanded="' + isOpen + '">' +
        '<span class="sp-place">' + ICONS[p.place] + '</span>' +
        '<span class="sp-main"><b>' + esc(NAMES[p.place] || '') + ' · ' + esc(when(p.at)) + '</b>' +
          '<small>' + esc(what) + '</small>' +
          (isOpen ? '' : '<small class="sp-snip">' + esc(String(p.text || '').slice(0, 110)) + '</small>') +
          '<span class="sp-st ' + st[1] + '">' + esc(st[0]) + '</span></span>' +
        (photos[0] ? '<img class="sp-thumb" src="' + esc(photos[0].thumb || photos[0].url) + '" alt="" loading="lazy">' : '') +
      '</button>' +
      (p.status === 'held' && p.heldWhy ? '<div class="sp-why">⚠️ ' + esc(p.heldWhy) + '</div>' : '') +
      ((p.status === 'failed' || p.status === 'notConnected') && p.error ? '<div class="sp-why">' + esc(p.error) + '</div>' : '') +
      (isOpen ? openHtml(p, photos) : '') +
    '</div>';
  }

  function shareUrl(p) {
    // Nextdoor's share link: its composer opens with the words already in
    // (developer.nextdoor.com share plugin; body up to 3,500 characters).
    let body = String(p.text || '');
    while (encodeURIComponent(body).length > 3400) body = body.slice(0, -20);
    return 'https://nextdoor.com/sharekit/?source=' + encodeURIComponent(SHARE_SOURCE) + '&body=' + encodeURIComponent(body);
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
    if (live && p.status !== 'ready') acts.push(btn("spSkip('" + id + "')", 'Skip it'));
    if (p.link) acts.push('<a class="btn btn-sm" href="' + esc(p.link) + '" target="_blank" rel="noopener">See it ↗</a>');
    return '<div class="sp-open">' +
      (live && p.status !== 'ready'
        ? '<label class="sp-lbl">The words' + (p.place === 'google' ? ' <span class="muted">(Google adds a Call button)</span>' : '') +
            '<textarea id="spText_' + id + '" rows="8" maxlength="5000">' + esc(p.text || '') + '</textarea></label>' +
          '<div class="field-actions"><button class="btn btn-sm" onclick="spSaveText(\'' + id + '\')">Save the words</button></div>'
        : '<div class="sp-text">' + esc(p.text || '') + '</div>') +
      (photos.length ? '<div class="sp-photos">' + photos.map((x, i) => '<span class="sp-photo">' +
          '<a href="' + esc(x.url) + '" target="_blank" rel="noopener"><img src="' + esc(x.thumb || x.url) + '" alt="Photo ' + (i + 1) + '" loading="lazy"></a>' +
          (live && p.status !== 'ready' && photos.length > 0 ? '<button class="sp-photo-x" onclick="spDropPhoto(\'' + id + '\', ' + i + ')" aria-label="Leave this photo out">✕</button>' : '') +
        '</span>').join('') + '</div>' +
        (p.place === 'nextdoor' && p.status === 'ready' ? '<p class="hint">Tap a photo to open it, save it, then add it in Nextdoor.</p>' : '')
        : '') +
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
      '<div class="sp-choice">' + PLACES.map(p => '<button class="btn btn-sm' + (own.places[p] ? ' btn-filled' : '') +
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
      (Array.isArray(cfg.slots) ? '<button class="btn btn-sm" onclick="spSlotsReset()">Back to the recommended times</button>' : '');
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
      : !fb.appSet
        ? '<ol class="sp-steps">' +
            '<li>On a computer, open <a href="https://developers.facebook.com/apps/creation/" target="_blank" rel="noopener">' +
              'developers.facebook.com → Create app</a> (signed in as you, the Page’s admin). Name it “YD Job Hub”, pick the use ' +
              'case <b>Manage everything on your Page</b>, and finish.</li>' +
            '<li>In the app: <b>Use cases → Manage everything on your Page → Customize</b> — make sure ' +
              '<b>pages_manage_posts</b> is there. Under <b>Facebook Login → Settings</b>, add this to ' +
              '<b>Valid OAuth Redirect URIs</b>:<div class="sp-code">' + esc(redirect || 'shown once the server is updated') + '</div>' +
              (redirect ? copy(redirect, 'Copy it') : '') + '</li>' +
            '<li><b>App settings → Basic</b>: put in the Privacy Policy URL ' +
              '<span class="sp-code">https://jonahlinfieldydexteriorvisionsllc.github.io/yd-job-hub/privacy.html</span>, then switch the ' +
              'app to <b>Live</b> at the top (so posts show to everyone, not only you).</li>' +
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
          '<p class="hint">Facebook asks which Pages to share — tick your business Page.</p>';
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
    const ndHtml = '<p>Nextdoor only lets approved partners post by themselves. Until then, at each Nextdoor time your phone is ' +
        'told, and one tap here opens Nextdoor with the words already in — add the photos and post.</p>' +
      '<p class="hint">To have Job Hub post there by itself too, Nextdoor has to say yes: ' +
        '<a href="https://developer.nextdoor.com/reference/applying-for-access" target="_blank" rel="noopener">apply for their ' +
        'Publish API</a>. No promise they will for one business.</p>';
    return '<div class="sp-place-box"><b>📘 Facebook</b>' + fbHtml + '</div>' +
      '<div class="sp-place-box"><b>📍 Google Business Profile</b>' + gHtml + '</div>' +
      '<div class="sp-place-box"><b>🏘️ Nextdoor</b>' + ndHtml + '</div>';
  }

  // ------------------------------------------------------------ taps

  window.openPosts = function () {
    if (!isOwner()) return;
    modal().classList.add('active');
    draw();
    loadCfg();
    loadHook();
  };
  window.closePosts = function () {
    const m = el('spModal');
    if (m) m.classList.remove('active');
  };
  window.spView = k => { view = k; open = null; draw(); };
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
    // His own words: nothing holds them (social.py checks only Claude's).
    patchPost(id, { text: text, edited: true }, 'the words').then(() => showToast('Saved'));
  };
  window.spDropPhoto = (id, i) => {
    const p = posts[id];
    if (!p) return;
    const was = (p.photos || []).slice();
    patchPost(id, { photos: was.filter((_, k) => k !== i), edited: true }, 'the photos');
    if (window.showUndo) showUndo('Photo left out', () => patchPost(id, { photos: was }, 'the photos'));
  };
  window.spMove = (id, v) => {
    const t = new Date(v);
    if (!v || isNaN(t)) return;
    if (t < new Date()) { showToast('Pick a time still to come — or Post now'); draw(); return; }
    patchPost(id, { at: t.toISOString(), day: localYMD(t), edited: true }, 'the time').then(() => showToast('Moved to ' + when(t.toISOString())));
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
    if (window.showUndo) showUndo('Skipped', () => patchPost(id, was, 'putting it back'));
  };
  window.spDone = id => patchPost(id, { status: 'posted', postedAt: new Date().toISOString(), heldWhy: null }, 'ticking it off');
  window.spNow = async id => {
    const p = posts[id];
    if (!p) return;
    if (!(await ydConfirm('Put this ' + (NAMES[p.place] || '') + ' post up now?', { ok: 'Post it now' }))) return;
    const r = await ask('/social/post-now', { id: p.id }, 'Posting…');
    if (!r) return;
    showToast(r.status === 'posted' ? '✓ It’s up' : r.status === 'ready' ? 'Ready — open Nextdoor to post it'
      : 'Not posted: ' + (r.error || r.status));
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
  window.spGoogle = async () => {
    const r = await ask('/social/google/check', {}, 'Checking Google…');
    if (r) showToast(r.ok ? '✓ Google is hooked up — ' + (r.title || 'your profile') : (r.error || 'Not yet'));
    loadCfg();
    loadHook();
  };

  // A box left after typing draws what waited.
  document.addEventListener('focusout', () => {
    const body = el('spBody');
    if (body && body.dataset.later) setTimeout(draw, 0);
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
    const m = el('spModal');
    if (m) m.classList.remove('active');
    if (k) { loadCfg(); watchPosts(); } else { if (unwatch) { unwatch(); unwatch = null; } posts = {}; changed(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && who) loadCfg(); });

  window.YDPosts = {
    // Home's Waiting on you: posts that need him (held, ready on Nextdoor,
    // didn't go up), soonest first.
    needs: () => isOwner() && cfg && cfg.on
      ? Object.values(posts).filter(p => NEEDS.indexOf(p.status) !== -1).sort((a, b) => String(a.at).localeCompare(String(b.at)))
      : [],
    on: () => !!(cfg && cfg.on),
    names: NAMES,
    icons: ICONS,
    // For the tests.
    _shareUrl: shareUrl,
  };
})();
