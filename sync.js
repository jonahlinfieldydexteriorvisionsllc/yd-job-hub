// Cloud sync.
//
// Design note, because it explains everything below: the app already had a
// complete, working data layer built on localStorage, and rewriting it to talk
// to Firestore directly would have meant touching every screen. Instead this
// file keeps localStorage as the app's working store and mirrors it to the
// cloud in both directions:
//
//   local save  ->  push the one job that changed
//   cloud change ->  write it into localStorage, rebuild the index, re-render
//
// Nothing in app.js knows any of this is happening. The functions below are
// wrapped rather than edited, so the original behaviour is intact if sync is
// switched off or never starts (no config, crew account, offline first run).
//
// Loads AFTER app.js, which is what lets it see the globals it wraps.

(function () {
  'use strict';

  const MIGRATED_KEY = STORAGE_PREFIX + 'migratedAt';
  const PUSH_DELAY = 800;

  let watching = false;
  let applyingRemote = false;   // guards against a change we just wrote coming
                                // back round the loop and being pushed again
  let pushTimers = {};
  let cloudState = 'connecting'; // connecting | synced | offline | off
  let unsubscribe = null;

  // ---------------------------------------------------------------- helpers

  function indexById() {
    const map = {};
    getJobIndex().forEach(j => { map[j.id] = j; });
    return map;
  }

  function writeIndex(map) {
    const list = Object.values(map).sort((a, b) =>
      String(b.lastModified || '').localeCompare(String(a.lastModified || '')));
    saveJobIndex(list);
    invalidateJobsCache();
  }

  function refreshVisible() {
    // Only redraw what is actually on screen -- re-rendering everything on
    // every remote change makes typing stutter.
    const active = document.querySelector('.tab-panel.active');
    const id = active ? active.id : '';
    if (id === 'panel-dashboard') renderDashboard();
    if (id === 'panel-matdash') renderMatDash();
    if (document.getElementById('managerModal').classList.contains('active')) renderJobList();
  }

  function setCloudState(s) {
    cloudState = s;
    updateCtxBar();
  }

  // ---------------------------------------------------------------- push

  function queuePush(id) {
    if (!watching || applyingRemote || !id) return;
    clearTimeout(pushTimers[id]);
    pushTimers[id] = setTimeout(() => pushNow(id), PUSH_DELAY);
  }

  async function pushNow(id) {
    const raw = readJobBlob(id);
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    try {
      await window.YDDb.putJob(id, data);
      setCloudState('synced');
    } catch (err) {
      // Offline is not an error worth shouting about -- Firestore queues the
      // write and sends it when the signal comes back. Anything else is.
      console.warn('[sync] push failed for', id, err.code || err.message);
      setCloudState('offline');
    }
  }

  function pushAllLocal() {
    const idx = getJobIndex();
    const entries = [];
    idx.forEach(j => {
      const raw = readJobBlob(j.id);
      if (!raw) return;
      try { entries.push([j.id, JSON.parse(raw)]); } catch {}
    });
    return entries.length ? window.YDDb.putManyJobs(entries).then(() => entries.length) : Promise.resolve(0);
  }

  // ---------------------------------------------------------------- pull

  function applyRemote(changes) {
    if (!changes.length) return;
    applyingRemote = true;
    try {
      const map = indexById();
      let openJobChanged = false;

      changes.forEach(c => {
        if (c.type === 'removed') {
          localStorage.removeItem(STORAGE_PREFIX + c.id);
          delete map[c.id];
        } else {
          localStorage.setItem(STORAGE_PREFIX + c.id, JSON.stringify(c.data));
          map[c.id] = buildIndexEntry(c.id, c.data);
        }
        if (c.id === currentJobId) openJobChanged = true;
      });

      writeIndex(map);

      // The job open on screen changed somewhere else. If there are unsaved
      // edits here, do NOT overwrite them -- losing what someone just typed is
      // far worse than showing a slightly stale record. Say so instead.
      if (openJobChanged) {
        if (dirty) {
          showToast('This job was changed on another device — your edits here are kept');
        } else if (readJobBlob(currentJobId)) {
          loadJob(currentJobId);
        }
      }

      refreshVisible();
    } finally {
      applyingRemote = false;
    }
  }

  // ---------------------------------------------------------------- startup

  async function startSync() {
    if (watching) return;

    let cloudCount = 0;
    try {
      cloudCount = await window.YDDb.countJobs();
    } catch (err) {
      console.warn('[sync] could not count cloud jobs', err.code || err.message);
      setCloudState('offline');
    }

    const localCount = getJobIndex().length;
    const alreadyMigrated = !!localStorage.getItem(MIGRATED_KEY);

    // First run with jobs here but nothing in the cloud: this device's data is
    // the only copy, so it becomes the seed. Backup to Downloads FIRST -- the
    // build spec requires it, and an automatic backup before a one-way data
    // move is cheap insurance.
    if (cloudCount === 0 && localCount > 0 && !alreadyMigrated) {
      try {
        exportAllJobs();
        const n = await pushAllLocal();
        localStorage.setItem(MIGRATED_KEY, new Date().toISOString());
        showToast(n + ' job' + (n === 1 ? '' : 's') + ' moved to the cloud');
      } catch (err) {
        console.error('[sync] migration failed', err);
        showToast('Could not move jobs to the cloud — your jobs are still safe on this device');
      }
    }

    watching = true;

    // countJobs() above went to the server, so reaching here without throwing
    // means we are genuinely connected.
    setCloudState('synced');

    unsubscribe = window.YDDb.watchJobs(
      (changes, meta) => {
        applyRemote(changes);
        // Firestore always delivers a cached snapshot FIRST, even when online,
        // so fromCache alone does not mean offline -- reading it that way made
        // a healthy connection report as "saved on this device". Only a server
        // snapshot is positive proof of being connected; a cached one just
        // tells us nothing new, so leave the state alone.
        if (!meta.fromCache) setCloudState('synced');
      },
      () => setCloudState('offline')
    );
  }

  // ---------------------------------------------------------------- wrapping

  // Wrap rather than edit, so app.js keeps working untouched if sync never
  // starts. Each wrapper does the original thing first, then mirrors it.

  const _persistJob = window.persistJob;
  window.persistJob = function (announce) {
    const ok = _persistJob.apply(this, arguments);
    if (ok) queuePush(currentJobId);
    return ok;
  };

  const _deleteJob = window.deleteJob;
  window.deleteJob = function (id) {
    const existed = !!readJobBlob(id);
    _deleteJob.apply(this, arguments);
    // Only reaches the cloud if the local delete actually happened (the user
    // may have cancelled the confirm).
    if (existed && !readJobBlob(id) && watching) {
      window.YDDb.removeJob(id).catch(err =>
        console.warn('[sync] delete failed', err.code || err.message));
    }
  };

  const _duplicateJob = window.duplicateJob;
  window.duplicateJob = function (id) {
    const before = new Set(getJobIndex().map(j => j.id));
    _duplicateJob.apply(this, arguments);
    getJobIndex().forEach(j => { if (!before.has(j.id)) queuePush(j.id); });
  };

  // Restore-from-backup is how the existing 21 jobs get into the cloud: the
  // original writes them to localStorage, and this pushes the lot up.
  const _importAllJobs = window.importAllJobs;
  window.importAllJobs = function (event) {
    _importAllJobs.apply(this, arguments);
    if (!watching) return;
    // The original parses the file asynchronously, so wait for it to land.
    setTimeout(() => {
      pushAllLocal()
        .then(n => { if (n) showToast(n + ' jobs synced to the cloud'); })
        .catch(err => console.warn('[sync] bulk push failed', err));
    }, 1200);
  };

  // Show cloud state alongside the existing saved/unsaved dot.
  const _updateCtxBar = window.updateCtxBar;
  window.updateCtxBar = function () {
    _updateCtxBar.apply(this, arguments);
    const t = document.getElementById('ctxDotText');
    if (!t || cloudState === 'off') return;
    if (storageBroken || dirty) return;          // local state is more urgent
    if (cloudState === 'synced')      t.textContent = 'Saved · Synced';
    else if (cloudState === 'offline') t.textContent = 'Saved on this device';
    else                               t.textContent = 'Saved';
  };

  // ---------------------------------------------------------------- go

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    if (a.mode !== 'cloud' || !a.user) { setCloudState('off'); return; }
    if (a.role !== 'owner') { setCloudState('off'); return; }  // crew screens come later
    if (!window.YDDb) { setCloudState('off'); return; }
    startSync();
  });

  // Expose a little of this for diagnostics.
  window.YDSync = {
    status: () => ({ watching, cloudState, applyingRemote }),
    pushAll: pushAllLocal,
    stop: () => { if (unsubscribe) unsubscribe(); watching = false; setCloudState('off'); },
  };
})();
