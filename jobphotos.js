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
    Promise.resolve(window.YDDb.put('jobPhotos', item.id, {
      jobId: item.jobId, stage: item.stage, caption: '',
      path: base + '.jpg', thumbPath: base + '_t.jpg', url: item.url, thumbUrl: item.thumbUrl,
      w: item.w, h: item.h, by: item.by, byName: item.byName, at: item.at, deleteAsked: null,
    })).catch(e => {
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

  function ordered() {
    const list = Object.keys(photos).map(id => Object.assign({ id: id }, photos[id]));
    // Only this person's waiting photos: on a shared phone the next person
    // to sign in can neither send nor see someone else's (they go up when
    // whoever took them signs in again).
    Object.values(queue).forEach(q => {
      if (q.jobId === jobId && q.by === myUid() && !photos[q.id]) list.push(Object.assign({ pending: true }, q));
    });
    return list.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  }
  function thumbHtml(p) {
    const st = status[p.id] || {};
    const src = p.pending ? st.preview : p.thumbUrl;
    const note = p.pending
      ? (busy[p.id] ? '<span class="jp-sending" data-jp-progress="' + safe(p.id) + '">Sending ' + Math.round((st.progress || 0) * 100) + '%</span>'
        : '<span class="jp-sending jp-wait">' + esc(st.error || 'Waiting for signal') + '</span>')
      : (p.deleteAsked ? '<span class="jp-asked">🗑 Delete?</span>' : '');
    return '<button type="button" class="jp-thumb" onclick="jpOpen(\'' + safe(p.id) + '\')">' +
      (src ? '<img src="' + esc(src) + '" alt="" loading="lazy">' : '<span class="jp-noimg">📷</span>') + note +
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

  window.YDJobPhotos = { mount: mount, jobShown: jobShown,
                         waiting: () => Object.values(queue).filter(q => q.by === myUid()).length };
})();
