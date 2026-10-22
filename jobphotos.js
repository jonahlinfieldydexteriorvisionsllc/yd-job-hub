// Photos on a job: taken on site, each marked Before, During or After, with
// who took it.
//
// Jonah (12 Oct 2026): the crew "can upload images" on their job page; "when
// a photo is uploaded it should be marked as; before, during, or after.
// Uploads should show which user uploaded them."
//
// The picture lives in Cloud Storage (storage.rules): a 1600 px copy and a
// small one for the grid, jobPhotos/{jobId}/{photoId}.jpg and ..._t.jpg. Its
// record is jobPhotos/{photoId} in Firestore -- the job, the stage, who and
// when, both addresses -- and that record is what the screens watch.
//
// Made for a phone on one bar, or none: a photo is shrunk on the phone first
// (a 4 MB camera picture becomes a few hundred KB, and the location the camera
// stamped in it is dropped), kept on the phone (IndexedDB) until it is up, and
// sent when the signal comes back -- even if the app was closed in between.
//
// Anyone working sees and adds photos. Whoever took one can change its stage
// or ask for it to be deleted; deleting is for whoever may change jobs (the
// owner, admins with Jobs: change), since a job's photos are its record.

(function () {
  'use strict';

  const STAGES = [['before', 'Before'], ['during', 'During'], ['after', 'After']];
  const STAGE_NAME = { before: 'Before', during: 'During', after: 'After' };
  const FULL_PX = 1600, THUMB_PX = 360;
  const MAX_PICK = 20;
  const el = id => document.getElementById(id);
  const safe = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const signedIn = () => !!(window.YDAuth && YDAuth.mode === 'cloud' && YDAuth.user);
  const myUid = () => (signedIn() ? YDAuth.user.uid : '');
  const changesJobs = () => typeof ydCan === 'function' && ydCan('jobs', 'change');

  let jobId = null;        // the job whose photos are being watched
  let photos = {};         // id -> record, for jobId
  let loaded = false;      // the server has answered for jobId
  let unsub = null;
  const mounts = new Set();  // containers showing jobId's photos
  const queue = {};        // id -> photo waiting on this phone { id, jobId, stage, full, thumb, ... }
  const status = {};       // id -> { progress, waiting, error, preview (object URL) }
  const busy = {};         // id -> being sent right now
  let viewing = null;      // id open in the viewer
  const queueWatchers = new Set();  // told whenever the photos on screen or waiting here change

  // ------------------------------------------------------------ names, dates

  function myName() {
    const me = window.YDRemind && YDRemind.me ? YDRemind.me() : null;
    const u = signedIn() ? YDAuth.user : {};
    return String((me && me.name) || u.displayName || String(u.email || '').split('@')[0] || 'Someone').slice(0, 80);
  }
  // The name as it is now (a rename on Your Crew shows on old photos too),
  // or as it was when the photo was taken on a phone that has no people list.
  function nameOf(p) {
    const people = window.YDClock && YDClock.people ? YDClock.people() : null;
    const now = people && p.by && people[p.by] && people[p.by].name;
    return now || p.byName || 'Someone';
  }
  const when = iso => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const newId = () => 'jp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // ------------------------------------------------- the phone's own queue
  //
  // IndexedDB, because a photo is too big for localStorage and must outlive
  // the app being closed in a truck with no signal. If the browser refuses
  // IndexedDB (a private window), the queue lives in memory only and the
  // photo is sent while the page stays open.

  const DB_NAME = 'ydjobhub_photos', STORE = 'queue';
  let dbp = null;
  function idb() {
    if (!dbp) dbp = new Promise((res, rej) => {
      if (!window.indexedDB) { rej(new Error('no IndexedDB')); return; }
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  function tx(mode, fn) {
    return idb().then(db => new Promise((res, rej) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => res(out && out.result);
      t.onerror = () => rej(t.error);
    }));
  }
  const qSave = item => tx('readwrite', s => s.put(item)).catch(e => console.warn('[photos] kept in memory only:', e));
  const qDrop = id => tx('readwrite', s => s.delete(id)).catch(() => {});
  const qLoad = () => tx('readonly', s => s.getAll()).catch(() => []);

  // ------------------------------------------------------- shrinking a photo

  async function decode(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* older Safari: below */ }
    }
    return new Promise((res, rej) => {
      const img = new Image(), u = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(u); res(img); };
      img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('unreadable')); };
      img.src = u;
    });
  }
  function toJpeg(src, max, quality) {
    const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
    const k = Math.min(1, max / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.drawImage(src, 0, 0, w, h);
    return new Promise((res, rej) => c.toBlob(b => (b ? res({ blob: b, w: w, h: h }) : rej(new Error('could not shrink'))), 'image/jpeg', quality));
  }

  // ------------------------------------------------------------ sending

  // Picked from a Before / During / After button: shrink each, keep it on
  // the phone, show it at once, then send.
  window.jpPicked = async function (input, stage) {
    const files = Array.from(input.files || []).filter(f => /^image\//.test(f.type) || !f.type);
    input.value = '';
    const forJob = input.getAttribute('data-job') || jobId;
    if (!files.length || !forJob || !STAGE_NAME[stage]) return;
    if (!signedIn()) { showToast('Sign in to add photos'); return; }
    if (files.length > MAX_PICK) showToast('Adding the first ' + MAX_PICK + ' — pick the rest after');
    let failed = 0;
    for (const f of files.slice(0, MAX_PICK)) {
      try {
        const img = await decode(f);
        const full = await toJpeg(img, FULL_PX, 0.82);
        const thumb = await toJpeg(img, THUMB_PX, 0.7);
        if (img.close) img.close();
        const item = { id: newId(), jobId: forJob, stage: stage, full: full.blob, thumb: thumb.blob,
                       w: full.w, h: full.h, by: myUid(), byName: myName(), at: new Date().toISOString() };
        // Its number: the next after the job's highest -- known only once the
        // job's photos have come (else it is given one later; see numbered).
        if (forJob === jobId && loaded) {
          const nums = ordered().map(p => p.num).filter(Number.isInteger);
          item.num = (nums.length ? Math.max(...nums) : 0) + 1;
        }
        queue[item.id] = item;
        status[item.id] = { progress: 0, preview: URL.createObjectURL(item.thumb) };
        await qSave(item);
        drawAll();
        send(item);
      } catch (e) {
        failed++;
        console.warn('[photos] could not read a photo:', e);
      }
    }
    if (failed) showToast(failed === 1 ? 'One photo could not be read — try it as a JPG' : failed + ' photos could not be read');
  };

  // A file that may already be up from an earlier try: storage.rules lets a
  // photo be written once and never overwritten (nobody swaps a picture out
  // afterwards), so a second upload of the same file would be refused for
  // ever. Asked for first, uploaded only if it is not there.
  async function upOnce(path, blob, tried, onProgress) {
    if (tried) {
      try { return await YDStore.url(path); }
      catch (e) { if (!e || e.code !== 'storage/object-not-found') throw e; }
    }
    return YDStore.upload(path, blob, 'image/jpeg', onProgress);
  }

  async function send(item) {
    if (busy[item.id] || !window.YDStore || !window.YDDb || item.by !== myUid()) return;
    const st = status[item.id] || (status[item.id] = { progress: 0, preview: URL.createObjectURL(item.thumb) });
    if (navigator.onLine === false) { st.waiting = true; drawAll(); return; }
    busy[item.id] = true;
    st.waiting = false; st.error = ''; drawAll();
    const base = 'jobPhotos/' + item.jobId + '/' + item.id;
    const tried = !!item.tries;
    item.tries = (item.tries || 0) + 1;
    try {
      // Each address is kept on the phone as soon as it is known, so a try
      // that dies half way picks up where it stopped.
      if (!item.thumbUrl) { item.thumbUrl = await upOnce(base + '_t.jpg', item.thumb, tried); qSave(item); }
      if (!item.url) {
        item.url = await upOnce(base + '.jpg', item.full, tried, p => { st.progress = p; drawProgress(item.id); });
        qSave(item);
      }
      fileRecord(item, base);
    } catch (e) {
      const code = (e && e.code) || '';
      console.warn('[photos] not sent yet:', code || e);
      st.waiting = true;
      st.error = code === 'storage/unauthorized' ? 'Not allowed to send photos yet'
        : code === 'storage/quota-exceeded' ? 'Photo storage is full'
        : navigator.onLine === false || /retry-limit|network/.test(code) ? '' : 'Not sent yet';
    } finally {
      delete busy[item.id];
      drawAll();
    }
  }

  // Both files are up: the record. Not awaited -- it waits in Firestore's
  // own offline queue (kept on the phone) if the signal drops now, so the
  // photo comes off this queue. If the server REFUSES it (rules not yet
  // published, say), the photo goes back on the queue with its addresses,
  // and the next try only files the record.
  function fileRecord(item, base) {
    const rec = {
      jobId: item.jobId, stage: item.stage, caption: '',
      path: base + '.jpg', thumbPath: base + '_t.jpg', url: item.url, thumbUrl: item.thumbUrl,
      w: item.w, h: item.h, by: item.by, byName: item.byName, at: item.at, deleteAsked: null,
    };
    if (Number.isInteger(item.num)) rec.num = item.num;     // left off when not known yet (never undefined)
    Promise.resolve(window.YDDb.put('jobPhotos', item.id, rec)).catch(e => {
      console.warn('[photos] record not saved:', (e && e.code) || e);
      queue[item.id] = item;
      status[item.id] = { progress: 1, waiting: true, preview: URL.createObjectURL(item.thumb),
                          error: e && e.code === 'permission-denied' ? 'Sent, but not allowed to file it yet' : 'Not filed yet' };
      qSave(item);
      drawAll();
    });
    delete queue[item.id];
    const st = status[item.id];
    if (st && st.preview) URL.revokeObjectURL(st.preview);
    delete status[item.id];
    qDrop(item.id);
  }

  // Everything this person left waiting, on this phone.
  function sendWaiting() {
    if (!signedIn()) return;
    Object.values(queue).forEach(it => { if (it.by === myUid()) send(it); });
  }
  async function loadQueue() {
    const items = await qLoad();
    (items || []).forEach(it => {
      if (!it || !it.id || queue[it.id]) return;
      queue[it.id] = it;
      if (!status[it.id]) status[it.id] = { progress: 0, preview: it.thumb ? URL.createObjectURL(it.thumb) : '' };
    });
    drawAll();
    sendWaiting();
  }

  window.jpRetry = id => { const it = queue[id]; if (it) send(it); };
  window.jpDiscard = async id => {
    if (!queue[id] || queue[id].by !== myUid() || !(await ydConfirm('It has not been sent.', { title: 'Throw this photo away?', ok: 'Throw it away', danger: true }))) return;
    if (!queue[id]) return;
    if (status[id] && status[id].preview) URL.revokeObjectURL(status[id].preview);
    delete queue[id]; delete status[id];
    qDrop(id);
    if (viewing === id) jpClose();
    drawAll();
  };

  // ----------------------------------------------------------- watching

  function watch(id) {
    if (unsub) { try { unsub(); } catch (e) { /* already gone */ } }
    unsub = null; photos = {}; loaded = false; jobId = id;
    if (!id || !signedIn() || !window.YDDb) { drawAll(); return; }
    unsub = window.YDDb.watchWhere('jobPhotos', 'jobId', id, (changes, meta) => {
      changes.forEach(c => { if (c.type === 'removed') delete photos[c.id]; else photos[c.id] = c.data || {}; });
      if (meta && !meta.fromCache) loaded = true;
      drawAll();
      if (viewing && !photos[viewing] && !queue[viewing]) jpClose();
      else if (viewing) drawViewer();
    }, () => { loaded = true; drawAll(); });
  }

  // Show job `id`'s photos in `container` (the crew's job page, the owner's
  // "What the crew see", the Job tab).
  function mount(container, id) {
    if (!container) return;
    container.setAttribute('data-job', safe(id || ''));
    mounts.forEach(c => { if (!c.isConnected) mounts.delete(c); });
    mounts.add(container);
    if (id !== jobId) watch(id || null);
    else draw(container);
  }

  // ------------------------------------------------------------- drawing

  // Every photo on a job has its own number -- 1, 2, 3 in the order taken --
  // so Jonah can say "look at photo 7", to Claude or to the crew (21 Oct
  // 2026). It is kept on the record (`num`): a photo deleted later never
  // renumbers the rest. A new photo takes the next after the job's highest;
  // one that came in without a number (taken before the job's photos had
  // loaded, or before 21 Oct) or with one an earlier photo already has is
  // given the next free one, in the order taken -- shown so at once, and
  // written by whoever may change jobs. estimates.py _numbered does the same.
  const byTaken = (a, b) => String(a.at || '') < String(b.at || '') ? -1 : String(a.at || '') > String(b.at || '') ? 1
    : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  function numbered(list) {
    const used = new Set(), num = {}, rest = [];
    list.slice().sort(byTaken).forEach(p => {
      const n = p.num;
      if (Number.isInteger(n) && n >= 1 && !used.has(n)) { used.add(n); num[p.id] = n; }
      else rest.push(p);
    });
    let next = used.size ? Math.max(...used) : 0;
    rest.forEach(p => { num[p.id] = ++next; });
    return num;
  }
  // Photos given a number only here (none kept, or one already taken): kept
  // on their records, once the server has answered for the job.
  function keepNumbers(list, num) {
    if (!loaded || !changesJobs()) return;
    list.forEach(p => {
      if (p.pending || p.num === num[p.id] || !photos[p.id]) return;
      photos[p.id].num = num[p.id];          // asked once, not at every redraw
      patch(p.id, { num: num[p.id] });
    });
  }

  function ordered() {
    const list = Object.keys(photos).map(id => Object.assign({ id: id }, photos[id]));
    // Only this person's waiting photos: on a shared phone the next person
    // to sign in can neither send nor see someone else's (they go up when
    // whoever took them signs in again).
    Object.values(queue).forEach(q => {
      if (q.jobId === jobId && q.by === myUid() && !photos[q.id]) list.push(Object.assign({ pending: true }, q));
    });
    const num = numbered(list);
    keepNumbers(list, num);
    return list.map(p => Object.assign(p, { num: num[p.id] })).sort(byTaken);
  }
  function thumbHtml(p) {
    const st = status[p.id] || {};
    const src = p.pending ? st.preview : p.thumbUrl;
    const note = p.pending
      ? (busy[p.id] ? '<span class="jp-sending" data-jp-progress="' + safe(p.id) + '">Sending ' + Math.round((st.progress || 0) * 100) + '%</span>'
        : '<span class="jp-sending jp-wait">' + esc(st.error || 'Waiting for signal') + '</span>')
      : (p.deleteAsked ? '<span class="jp-asked">🗑 Delete?</span>' : '');
    // ro-ok: looking at a photo still works on a look-only Job screen (the
    // viewer offers changes only to whoever may make them).
    return '<button type="button" class="jp-thumb ro-ok" onclick="jpOpen(\'' + safe(p.id) + '\')" aria-label="Photo ' + p.num + '">' +
      (src ? '<img src="' + esc(src) + '" alt="" loading="lazy">' : '<span class="jp-noimg">📷</span>') + note +
      '<span class="jp-num">' + p.num + '</span>' +
      '<span class="jp-by">' + esc(p.pending ? (p.byName || 'Me') : nameOf(p)) + '</span></button>';
  }
  function draw(container) {
    const id = container.getAttribute('data-job');
    if (!id) {
      container.innerHTML = (container.id === 'jobPhotosBody' ? '' : '<div class="cj-h">📷 Photos</div>') +
        '<p class="muted">Save the job first, then add photos.</p>';
      return;
    }
    if (!signedIn()) { container.innerHTML = ''; return; }
    const list = ordered();
    const asked = list.filter(p => p.deleteAsked && !p.pending).length;
    const groups = STAGES.map(([k, name]) => {
      const mine = list.filter(p => p.stage === k);
      return mine.length ? '<div class="jp-stage"><div class="jp-stage-h"><span class="jp-chip jp-' + k + '">' + name + '</span> ' +
        mine.length + '</div><div class="jp-grid">' + mine.map(thumbHtml).join('') + '</div></div>' : '';
    }).join('');
    // On the Job tab the section already says Photos; there only the count.
    const inSection = container.id === 'jobPhotosBody';
    const count = list.length ? (inSection ? list.length + ' photo' + (list.length === 1 ? '' : 's') : ' · ' + list.length) : '';
    const askedHtml = asked && changesJobs() ? ' <span class="jp-asked-n">' + asked + ' asked to be deleted</span>' : '';
    container.innerHTML =
      (inSection ? (count || askedHtml ? '<div class="cj-h">' + count + askedHtml + '</div>' : '')
        : '<div class="cj-h">📷 Photos' + count + askedHtml + '</div>') +
      '<div class="jp-add">' + STAGES.map(([k, name]) =>
        // "Add before photo", not just "Before": the bare word read like a
        // filter on the photos below. "before photo" kept together, so on a
        // phone all three break the same way.
        '<label class="btn jp-btn jp-btn-' + k + '">📷 Add <span class="jp-btn-what">' + name.toLowerCase() + ' photo</span>' +
        '<input type="file" accept="image/*" multiple hidden data-job="' + safe(id) + '" onchange="jpPicked(this, \'' + k + '\')"></label>').join('') +
      '</div>' +
      (groups || '<p class="muted">' + (loaded || !navigator.onLine ? 'No photos yet. Tap Add before, during or after photo, then take or choose the photos.' : 'Loading…') + '</p>');
  }
  function drawAll() {
    mounts.forEach(c => { if (!c.isConnected) mounts.delete(c); else draw(c); });
    // The "photos first" window counts this phone's waiting photos too.
    queueWatchers.forEach(fn => fn());
  }
  // Only the percentage, so a big upload does not redraw the grid 50 times.
  function drawProgress(id) {
    const pct = Math.round(((status[id] && status[id].progress) || 0) * 100);
    document.querySelectorAll('[data-jp-progress="' + safe(id) + '"]').forEach(n => { n.textContent = 'Sending ' + pct + '%'; });
  }

  // ------------------------------------------------------------ the viewer

  function viewerEl() {
    let v = el('jpViewer');
    if (!v) {
      v = document.createElement('div');
      v.id = 'jpViewer';
      v.className = 'jp-viewer';
      v.onclick = ev => { if (ev.target === v) jpClose(); };
      document.body.appendChild(v);
    }
    return v;
  }
  function drawViewer() {
    const list = ordered();
    const i = list.findIndex(p => p.id === viewing);
    if (i < 0) { jpClose(); return; }
    const p = list[i], st = status[p.id] || {};
    const mine = p.by && p.by === myUid();
    const canStage = !p.pending && (mine || changesJobs());
    const src = p.pending ? st.preview : (p.url || p.thumbUrl);
    const ago = p.deleteAsked ? 'Delete asked by ' + esc(p.deleteAsked.name || 'the crew') + (p.deleteAsked.at ? ' · ' + esc(when(p.deleteAsked.at)) : '') : '';
    viewerEl().innerHTML =
      '<div class="jp-v-top">' +
        '<b class="jp-v-num">Photo ' + p.num + '</b>' +
        '<span class="jp-chip jp-' + esc(p.stage) + '">' + esc(STAGE_NAME[p.stage] || '') + '</span>' +
        '<span class="jp-v-who">📷 ' + esc(p.pending ? (p.byName || 'Me') : nameOf(p)) + ' · ' + esc(when(p.at)) + '</span>' +
        '<button type="button" class="jp-v-x" onclick="jpClose()" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="jp-v-img">' +
        (i > 0 ? '<button type="button" class="jp-v-nav jp-v-prev" onclick="jpNav(-1)" aria-label="Previous">‹</button>' : '') +
        (src ? '<img src="' + esc(src) + '" alt="">' : '') +
        (i < list.length - 1 ? '<button type="button" class="jp-v-nav jp-v-next" onclick="jpNav(1)" aria-label="Next">›</button>' : '') +
      '</div>' +
      '<div class="jp-v-bar">' +
        (p.pending
          ? '<span class="jp-v-note">' + esc(busy[p.id] ? 'Sending…' : (st.error || 'Waiting for signal — it sends by itself')) + '</span>' +
            (busy[p.id] ? '' : '<button type="button" class="btn" onclick="jpRetry(\'' + safe(p.id) + '\')">Try again</button>') +
            '<button type="button" class="btn" onclick="jpDiscard(\'' + safe(p.id) + '\')">Throw away</button>'
          : (canStage ? '<span class="jp-v-stages">' + STAGES.map(([k, name]) =>
              '<button type="button" class="jp-v-stage' + (p.stage === k ? ' on' : '') + '" onclick="jpStage(\'' + safe(p.id) + '\', \'' + k + '\')">' + name + '</button>').join('') + '</span>' : '') +
            (ago ? '<span class="jp-v-note">' + ago + '</span>' : '') +
            (changesJobs()
              ? '<button type="button" class="btn jp-v-del" onclick="jpDelete(\'' + safe(p.id) + '\')">Delete</button>'
              : mine ? (p.deleteAsked
                  ? '<button type="button" class="btn" onclick="jpAskDelete(\'' + safe(p.id) + '\', false)">Keep it after all</button>'
                  : '<button type="button" class="btn" onclick="jpAskDelete(\'' + safe(p.id) + '\', true)">Ask Jonah to delete</button>')
              : '') +
            (p.url ? '<a class="btn" href="' + esc(p.url) + '" target="_blank" rel="noopener">Full size</a>' : '')) +
      '</div>';
  }
  window.jpOpen = id => {
    viewing = id;
    drawViewer();
    viewerEl().classList.add('active');
  };
  window.jpClose = () => {
    viewing = null;
    const v = el('jpViewer');
    if (v) { v.classList.remove('active'); v.innerHTML = ''; }
  };
  window.jpNav = dir => {
    const list = ordered();
    const i = list.findIndex(p => p.id === viewing);
    const next = list[i + dir];
    if (next) { viewing = next.id; drawViewer(); }
  };
  document.addEventListener('keydown', ev => {
    if (!viewing) return;
    if (ev.key === 'Escape') { ev.stopPropagation(); jpClose(); }
    else if (ev.key === 'ArrowLeft') jpNav(-1);
    else if (ev.key === 'ArrowRight') jpNav(1);
  }, true);

  // --------------------------------------------------------------- changes

  function patch(id, fields) {
    Promise.resolve(window.YDDb.put('jobPhotos', id, Object.assign({ updatedAt: new Date().toISOString() }, fields)))
      .catch(e => showToast(e && e.code === 'permission-denied' ? 'Not allowed to change that photo' : 'Not saved yet — will retry'));
  }
  window.jpStage = (id, stage) => {
    const p = photos[id];
    if (!p || !STAGE_NAME[stage] || p.stage === stage) return;
    p.stage = stage;
    patch(id, { stage: stage });
    drawAll(); drawViewer();
  };
  window.jpAskDelete = (id, ask) => {
    const p = photos[id];
    if (!p) return;
    p.deleteAsked = ask ? { by: myUid(), name: myName(), at: new Date().toISOString() } : null;
    patch(id, { deleteAsked: p.deleteAsked });
    drawAll(); drawViewer();
    if (ask) showToast('Jonah will see you asked');
  };
  window.jpDelete = async id => {
    const p = photos[id];
    if (!p || !changesJobs() || !(await ydConfirm('It cannot be brought back.', { title: 'Delete this photo for good?', ok: 'Delete', danger: true }))) return;
    if (!photos[id]) return;
    // The record first, so it leaves every screen at once; the files after.
    // A file left behind by a dropped signal costs pennies and harms nothing.
    Promise.resolve(window.YDDb.remove('jobPhotos', id)).catch(e => showToast(e && e.code === 'permission-denied' ? 'Not allowed to delete photos' : 'Not deleted yet — will retry'));
    [p.path, p.thumbPath].filter(Boolean).forEach(path => {
      Promise.resolve(window.YDStore && YDStore.remove(path)).catch(e => console.warn('[photos] file left behind:', path, (e && e.code) || e));
    });
    // The viewer moves on to the next photo (or the one before the last).
    const list = ordered(), i = list.findIndex(x => x.id === id);
    const next = list[i + 1] || list[i - 1];
    delete photos[id];
    if (viewing === id) { if (next) { viewing = next.id; drawViewer(); } else jpClose(); }
    drawAll();
  };

  // ------------------------------------- finishing a job: its photos first
  //
  // Jonah (21 Oct 2026): "when job is marked complete it prompts to add
  // photos. job cannot be marked complete until there is a minimum of 1
  // before and 1 after photo allow only Jonah to mark it complete without
  // photos." Every way a job becomes Finished asks here first -- the stage
  // buttons on the Job tab (app.js pickStage) and a move on the Jobs board
  // (boards.js moveJob: a drag, the card's Move to, a one-tap button) -- and
  // nothing about the job changes until the answer is yes, so Cancel leaves
  // it exactly as it was. With both photos on the job it goes straight
  // through, no window. Otherwise the window says what is missing, with Add
  // before / Add after photo buttons right in it; only the owner gets
  // "Finish it without photos".
  // A photo counts when it is on the job and nobody has asked for it to be
  // deleted. One still waiting on this phone for signal counts too: it is
  // taken, just not sent yet. With no signal it goes by what this phone
  // knows (Firestore's own copy, and this phone's waiting photos).
  // Not in the database rules: they cannot look through a job's photos
  // (other documents), and a photo still on a phone has no record there yet
  // -- such a rule would refuse the whole job save of someone finishing a job
  // in a truck with no signal.
  const NEEDED = ['before', 'after'];
  const SERVER_WAIT_MS = 4000;  // how long a missing photo waits for the server's word before the window opens
  let finishing = null;         // the job being checked right now (one at a time)

  // Resolves true when job `id` may be marked Finished now. opts.name: the
  // customer's name, for the window's words.
  function readyToFinish(id, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      // A second tap while the first is still being answered is the same ask.
      if (finishing) { resolve(false); return; }
      finishing = id || '-';
      const owner = !!(window.YDAuth && YDAuth.isOwner);
      const recs = {};          // the job's photo records, as this phone knows them
      const canLook = !!(id && signedIn() && window.YDDb && window.YDDb.watchWhere);
      // `sure`: what this phone has is the answer -- the server has said, or
      // there is no signal and its own copy has been read.
      let sure = !canLook;
      let waited = false, win = null, stop = null, done = false;
      const have = () => {
        const n = { before: 0, after: 0, sending: 0 };
        Object.keys(recs).forEach(k => {
          const p = recs[k];
          if (!p.deleteAsked && n[p.stage] != null) n[p.stage]++;
        });
        Object.values(queue).forEach(q => {
          if (!id || q.jobId !== id || q.by !== myUid() || recs[q.id] || n[q.stage] == null) return;
          n[q.stage]++;
          n.sending++;
        });
        return n;
      };
      const enough = n => NEEDED.every(k => n[k] > 0);
      const timer = setTimeout(() => { waited = true; update(); }, SERVER_WAIT_MS);
      const slow = setTimeout(() => { if (!done && !win) showToast('Checking the job’s photos…'); }, 700);

      function finish(ok) {
        if (done) return;
        done = true;
        finishing = null;
        clearTimeout(timer); clearTimeout(slow);
        if (stop) { try { stop(); } catch (e) { /* already gone */ } }
        queueWatchers.delete(update);
        if (win) win.remove();
        resolve(ok);
      }
      function update() {
        if (done) return;
        const n = have();
        if (!win) {
          if (enough(n)) { finish(true); return; }
          if (!sure && !waited) return;     // a moment more for the server's word
          open();
        }
        drawFinish(n);
      }

      // Built once and then only filled in: a redraw while the phone's photo
      // picker is open must not swap the file box out from under it.
      function open() {
        const name = String(opts.name || '').trim();
        win = document.createElement('div');
        win.className = 'modal-overlay ask-overlay active';
        win.innerHTML =
          '<div class="modal ask-modal jpf" role="dialog" aria-modal="true" aria-labelledby="jpfTitle">' +
            '<div class="modal-head"><h2 id="jpfTitle">Photos before it’s finished</h2>' +
              '<button type="button" class="modal-close" aria-label="Cancel">&times;</button></div>' +
            '<div class="modal-body">' +
              '<div class="ask-text" data-jpf-say></div>' +
              '<div class="jpf-rows" data-jpf-rows></div>' +
              '<div class="hint jpf-note" data-jpf-note hidden></div>' +
              (id ? '<div class="jp-add jpf-add">' + NEEDED.map(k =>
                '<label class="btn jp-btn jp-btn-' + k + '" data-jpf-add="' + k + '">📷 Add <span class="jp-btn-what">' + k + ' photo</span>' +
                '<input type="file" accept="image/*" multiple hidden data-job="' + safe(id) + '" onchange="jpPicked(this, \'' + k + '\')"></label>').join('') +
                '</div>' : '') +
              '<div class="ask-actions">' +
                '<button type="button" class="btn" data-jpf="cancel">Cancel</button>' +
                (owner ? '<button type="button" class="btn" data-jpf="skip">Finish it without photos</button>' : '') +
                '<button type="button" class="btn btn-filled" data-jpf="finish">✓ Mark it finished</button>' +
              '</div>' +
            '</div>' +
          '</div>';
        win.setAttribute('data-name', name);
        win.querySelector('.modal-close').onclick = () => finish(false);
        // A tap on the backdrop is Cancel, as on the app's other questions
        // (once a photo has been picked, guardWindows keeps the window open).
        let pressedOut = !window.PointerEvent;
        win.addEventListener('pointerdown', e => { pressedOut = e.target === win; });
        win.addEventListener('click', e => {
          if (e.target === win) { if (pressedOut) finish(false); return; }
          const b = e.target.closest('[data-jpf]');
          const what = b && b.getAttribute('data-jpf');
          if (what === 'cancel') finish(false);
          else if (what === 'finish' && enough(have())) finish(true);
          else if (what === 'skip' && owner) finish(true);
        });
        document.body.appendChild(win);
        setTimeout(() => {
          const first = win && win.querySelector('.jpf-add label:not([hidden]), [data-jpf="cancel"]');
          if (first && !done) { try { first.focus({ preventScroll: true }); } catch (e) { /* older browser */ } }
        }, 30);
      }
      function drawFinish(n) {
        const ok = enough(n), name = win.getAttribute('data-name');
        const whose = name ? esc(name) + '’s job' : 'This job';
        win.querySelector('[data-jpf-say]').innerHTML = ok
          ? 'Both are on it now — it can be marked Finished.'
          : !id ? 'Save the job first, then add its photos: a job is marked Finished once it has at least one Before and one After photo.'
          : whose + ' can be marked Finished once it has at least one Before and one After photo.' +
            (owner ? '' : ' Only Jonah can finish a job without them.');
        win.querySelector('[data-jpf-rows]').innerHTML = NEEDED.map(k =>
          '<div class="jpf-row' + (n[k] ? ' ok' : '') + '"><span class="jp-chip jp-' + k + '">' + STAGE_NAME[k] + '</span>' +
          '<span>' + (n[k] ? '✓ ' + n[k] + ' photo' + (n[k] === 1 ? '' : 's') : 'None yet') + '</span></div>').join('');
        const notes = [];
        if (n.sending) notes.push(n.sending === 1 ? '1 of them is still sending from this phone — it counts.'
          : n.sending + ' of them are still sending from this phone — they count.');
        if (navigator.onLine === false) notes.push('No signal — going by the photos this phone knows about.');
        else if (!sure && id) notes.push('No word from the server yet — going by the photos this phone knows about.');
        const note = win.querySelector('[data-jpf-note]');
        note.textContent = notes.join(' ');
        note.hidden = !notes.length;
        win.querySelectorAll('[data-jpf-add]').forEach(l => { l.hidden = ok || n[l.getAttribute('data-jpf-add')] > 0; });
        win.querySelector('[data-jpf="finish"]').hidden = !ok;
        const skip = win.querySelector('[data-jpf="skip"]');
        if (skip) skip.hidden = ok;
      }

      if (canLook) {
        stop = window.YDDb.watchWhere('jobPhotos', 'jobId', id, (changes, meta) => {
          changes.forEach(c => {
            if (c.type === 'removed' || !c.data || c.data.jobId !== id) delete recs[c.id];
            else recs[c.id] = c.data;
          });
          if (!meta || !meta.fromCache || navigator.onLine === false) sure = true;
          update();
        }, () => { sure = true; update(); });
        // Answered before the watch was even handed back: stop it now.
        if (done) { try { stop(); } catch (e) { /* already gone */ } }
      }
      if (done) return;
      queueWatchers.add(update);
      update();
    });
  }

  // ----------------------------------------------- the Job tab (office)

  // Called by app.js whenever the job on the Job tab changes (opened, new,
  // first saved). The crew have no Job tab; they see photos on their job page.
  function jobShown(id) {
    if (typeof ydCan !== 'function' || !ydCan('jobs', 'see')) return;
    let sec = el('jobPhotosSection');
    if (!sec) {
      const after = el('estimateSection');
      if (!after) return;
      sec = document.createElement('div');
      sec.className = 'section';
      sec.id = 'jobPhotosSection';
      sec.innerHTML = '<div class="section-head"><span class="section-title">Photos</span></div>' +
        '<div class="section-body" id="jobPhotosBody"></div>';
      after.insertAdjacentElement('afterend', sec);
    }
    mount(el('jobPhotosBody'), id || '');
  }

  // ------------------------------------------------------------ sign-in

  let who = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user ? a.user.uid : null;
    if (k === who) return;
    who = k;
    jpClose();
    if (!k) { watch(null); return; }
    if (jobId) watch(jobId);
    loadQueue();
    // The job already on the Job tab when sign-in finished (app.js tells us
    // about every change after this).
    if (typeof currentJobId !== 'undefined') jobShown(currentJobId);
  });
  window.addEventListener('online', sendWaiting);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sendWaiting(); });

  window.YDJobPhotos = { mount: mount, jobShown: jobShown, readyToFinish: readyToFinish,
                         waiting: () => Object.values(queue).filter(q => q.by === myUid()).length };
})();
