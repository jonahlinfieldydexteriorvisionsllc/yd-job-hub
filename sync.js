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
  // Every job the cloud listener currently reports. The board tidy-up uses it
  // to tell a job that is gone from one this device has not stored yet.
  const cloudJobIds = new Set();
  let boardReconciled = false;

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
    if (id === 'panel-supplies' && typeof matSectionHidden === 'function' && !matSectionHidden()) renderMatDash();
    if (document.getElementById('managerModal').classList.contains('active')) renderJobList();
    // The boards and the calendar draw from jobs too; they decide for
    // themselves whether they are on screen.
    document.dispatchEvent(new CustomEvent('yd-jobs-changed'));
  }

  // Once, on the owner's device: jobs still marked with the old 'active' are
  // rewritten as Booked or In progress, by where they sat on the Jobs board.
  // Done through patchJob, so the cloud copy and the crew's job list follow.
  function migrateStatuses() {
    if (!window.YDAuth || !window.YDAuth.isOwner || typeof normStatus !== 'function') return;
    getJobIndex().forEach(j => {
      let d = null;
      try { d = JSON.parse(readJobBlob(j.id) || 'null'); } catch (e) {}
      if (d && d.jobStatus === 'active') patchJob(j.id, { jobStatus: normStatus('active', d) });
    });
  }

  // ------------------------------------------------------------ patch a job
  //
  // The Bids and Jobs boards move a job without opening it. That has to go
  // through the same path as a save from the form -- local copy, index, cloud,
  // crew job board -- or the job would be in one place on this device and
  // another everywhere else. If that job happens to be open in the form, the
  // form is brought along too, so its next save does not put the card back.
  function patchJob(id, patch) {
    const raw = readJobBlob(id);
    if (!raw) return false;
    let data;
    try { data = JSON.parse(raw); } catch { return false; }
    Object.assign(data, patch, { lastModified: new Date().toISOString() });
    try {
      localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(data));
    } catch (err) {
      showToast('Could not save that move on this device');
      return false;
    }
    const map = indexById();
    map[id] = buildIndexEntry(id, data);
    writeIndex(map);

    if (id === currentJobId) {
      if (dirty) {
        // Keep what is being typed; just carry the move into it.
        if (patch.jobStatus) { jobStatus = patch.jobStatus; syncStatusSelect(); updateCtxBar(); }
        BOARD_FIELDS.forEach(f => { if (f in patch) boardFields[f] = patch[f]; });
      } else {
        loadJob(id, true);
      }
    }
    queuePush(id);
    refreshVisible();
    return true;
  }

  function setCloudState(s) {
    cloudState = s;
    updateCtxBar();
  }

  // ---------------------------------------------------------------- push

  // Saves made before sync has started (the first connection can take a while
  // in a truck) are remembered and sent once it does, rather than dropped --
  // a dropped push is how a newer edit lost to an older cloud copy.
  //
  // Remembered on the device, not just in memory, and forgotten only once the
  // job has been handed to Firestore (whose own queue then survives a
  // restart). Held in memory alone, a brand-new job saved in the first seconds
  // and the app then closed never reached the cloud: next time, the cloud's
  // snapshot had nothing to say about a job it had never had, so nothing sent
  // it up until it was edited again.
  const UNSENT_KEY = STORAGE_PREFIX + 'unsentPushes';
  const unsent = (() => {
    try { return new Set(JSON.parse(localStorage.getItem(UNSENT_KEY) || '[]')); }
    catch (e) { return new Set(); }
  })();
  function saveUnsent() {
    try {
      if (unsent.size) localStorage.setItem(UNSENT_KEY, JSON.stringify([...unsent]));
      else localStorage.removeItem(UNSENT_KEY);
    } catch (e) { console.warn('[sync] could not note an unsent save', e); }
  }
  function forgetUnsent(id) {
    if (unsent.delete(id)) saveUnsent();
  }
  function queuePush(id) {
    if (!id || applyingRemote) return;
    // Saved again after being deleted -- restored from a backup, say. The
    // save is the newer wish, so a delete still waiting to go out is dropped.
    if (pendingDeletes.delete(id)) savePendingDeletes();
    if (!watching) { unsent.add(id); saveUnsent(); return; }
    clearTimeout(pushTimers[id]);
    pushTimers[id] = setTimeout(() => pushNow(id), PUSH_DELAY);
  }

  // ---------------------------------------------------------------- delete
  //
  // A job deleted before sync had started -- in the first seconds after the
  // app opened, or on a device that could not reach Firebase at all -- used
  // to be deleted on that device only, and the cloud's copy came straight
  // back with the next snapshot as if the delete had never happened. So a
  // delete is written down here, kept across a reload, sent once sync is
  // running, and forgotten only when the server has confirmed it. Until then
  // applyRemote refuses to write the job back.
  const DELETES_KEY = STORAGE_PREFIX + 'pendingDeletes';
  const pendingDeletes = (() => {
    try { return new Set(JSON.parse(localStorage.getItem(DELETES_KEY) || '[]')); }
    catch (e) { return new Set(); }
  })();
  function savePendingDeletes() {
    try {
      if (pendingDeletes.size) localStorage.setItem(DELETES_KEY, JSON.stringify([...pendingDeletes]));
      else localStorage.removeItem(DELETES_KEY);
    } catch (e) { console.warn('[sync] could not note a pending delete', e); }
  }
  function forgetDelete(id) {
    if (pendingDeletes.delete(id)) savePendingDeletes();
  }
  function queueDelete(id) {
    // Deleted before its first save got out: there is nothing to send.
    forgetUnsent(id);
    pendingDeletes.add(id);
    savePendingDeletes();
    if (watching) sendDelete(id);
  }
  function sendDelete(id) {
    // Not awaited: with no signal the promise only settles when the signal
    // returns, and Firestore holds the delete in its own queue until then.
    window.YDDb.removeJob(id)
      .then(() => forgetDelete(id))
      .catch(err => {
        // Refused, not merely offline. Forget it, so the job is not hidden
        // on this device while it carries on existing everywhere else.
        console.warn('[sync] delete failed', err.code || err.message);
        forgetDelete(id);
      });
    // Otherwise the crew's clock would keep offering a job that is gone.
    window.YDDb.remove('jobBoard', id).catch(err =>
      console.warn('[sync] job board delete failed', err.code || err.message));
  }

  // ------------------------------------------------------------- job board
  //
  // Crew cannot be given a job record -- the quote, the costs and the margin
  // all live in it, and Firestore cannot hide a field. So every job also gets
  // a stripped companion record they CAN read, carrying only what is needed to
  // clock in to the right work and drive to it.
  //
  // It is written here rather than anywhere else because this is the one place
  // every job save already passes through. That is what makes a new job appear
  // on the crew's clock by itself, with nothing for the owner to remember.

  function boardEntry(id, d) {
    return {
      name: (d.customerName || '').trim() || 'Untitled job',
      address: [d.address, d.city, d.state].filter(Boolean).join(', '),
      // The crew's clock lists booked and in-progress jobs first; the old
      // 'active' is translated so a job not yet re-saved still shows.
      status: typeof normStatus === 'function' ? normStatus(d.jobStatus, d) : (d.jobStatus || 'quoting'),
      updatedAt: new Date().toISOString(),
    };
  }

  // A bid is not a job until it is booked (app.js isBidStatus), so it is not
  // on the crew's clock either: booking it puts it there.
  const onBoard = d => (typeof normStatus === 'function' ? normStatus(d.jobStatus, d) : (d.jobStatus || 'quoting')) !== 'quoting';

  function pushBoard(id, data) {
    // Whoever may change jobs: the owner, or an admin given that. The rules
    // refuse it from anyone else, whose app has no business maintaining the
    // list anyway.
    if (!ydCan('jobs', 'change')) return;
    const write = onBoard(data) ? window.YDDb.put('jobBoard', id, boardEntry(id, data)) : window.YDDb.remove('jobBoard', id);
    Promise.resolve(write)
      .catch(err => console.warn('[sync] job board not yet updated for', id,
        err.code || err.message));
  }

  async function pushNow(id) {
    // Someone allowed only to look at jobs never sends one up.
    if (!ydCan('jobs', 'change')) { forgetUnsent(id); return; }
    const raw = readJobBlob(id);
    if (!raw) { forgetUnsent(id); return; }
    let data;
    try { data = JSON.parse(raw); } catch { forgetUnsent(id); return; }
    // Not awaited, and deliberately before the job push: if the signal dies
    // between the two, the clock having an extra job on it is harmless, while
    // a saved job the crew cannot clock into is the failure that matters.
    pushBoard(id, data);
    try {
      const sent = window.YDDb.putJob(id, data);
      // In Firestore's hands now; its queue keeps it until the server has it.
      forgetUnsent(id);
      await sent;
      setCloudState('synced');
    } catch (err) {
      // Offline is not an error worth shouting about -- Firestore queues the
      // write and sends it when the signal comes back. Anything else is.
      console.warn('[sync] push failed for', id, err.code || err.message);
      setCloudState('offline');
    }
  }

  // Bring the board in line with the jobs that already exist -- the 21 from
  // before the clock was built, and anything edited on another device while
  // this one was shut. Only what is actually missing or stale is written, so
  // the usual case costs nothing.
  async function reconcileBoard() {
    if (!ydCan('jobs', 'change')) return;
    try {
      const board = await window.YDDb.list('jobBoard');
      const writes = [];
      const bids = new Set();
      getJobIndex().forEach(j => {
        const raw = readJobBlob(j.id);
        if (!raw) return;
        let d; try { d = JSON.parse(raw); } catch { return; }
        if (!onBoard(d)) { bids.add(j.id); return; }
        const want = boardEntry(j.id, d), have = board[j.id];
        if (!have || have.name !== want.name || have.address !== want.address
            || have.status !== want.status) {
          writes.push(['jobBoard', j.id, want]);
        }
      });

      // A board entry whose job is gone would leave crew able to clock in to
      // work that no longer exists. Gone means gone from the cloud as well as
      // from this device: a job the cloud still has but this phone could not
      // store (no room left on it, say) is not gone.
      // A bid comes off it too, until it is booked.
      const gone = Object.keys(board).filter(id => bids.has(id) || (!readJobBlob(id) && !cloudJobIds.has(id)));

      // Handed to Firestore, not awaited, like every other write here: it
      // sends them whenever the signal allows.
      if (writes.length) {
        window.YDDb.putMany(writes).catch(err =>
          console.warn('[sync] job board update failed', err.code || err.message));
      }
      if (gone.length) {
        window.YDDb.removeMany(gone.map(id => ['jobBoard', id])).catch(err =>
          console.warn('[sync] job board tidy-up failed', err.code || err.message));
      }
      if (writes.length || gone.length) {
        console.info('[sync] job board: ' + writes.length + ' updated, ' + gone.length + ' removed');
      }
    } catch (err) {
      console.warn('[sync] job board reconcile failed', err.code || err.message);
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
    const keepOurs = [];
    try {
      const map = indexById();
      let openJobChanged = false;

      changes.forEach(c => {
        if (c.type === 'removed') {
          localStorage.removeItem(STORAGE_PREFIX + c.id);
          delete map[c.id];
          if (c.id === currentJobId) openJobChanged = true;
          return;
        }
        // Deleted on this device, the delete not yet confirmed by the server:
        // the cloud's copy is on its way out and must not be written back.
        if (pendingDeletes.has(c.id)) return;
        let local = null;
        try { local = JSON.parse(readJobBlob(c.id) || 'null'); } catch (e) {}
        const mine = local && local.lastModified, theirs = c.data && c.data.lastModified;
        // Our own save coming back round. Every autosave used to reload the
        // whole form from it -- the cursor jumped, and anyone who had moved to
        // another tab was pulled back to the Job tab.
        if (mine && theirs && mine === theirs) return;
        // Older than what this device already has: an edit made here before
        // sync had started, about to be overwritten by the stale cloud copy.
        // Keep ours and send it up instead.
        if (mine && theirs && mine > theirs) { keepOurs.push(c.id); return; }
        try {
          localStorage.setItem(STORAGE_PREFIX + c.id, JSON.stringify(c.data));
        } catch (e) {
          console.warn('[sync] no room on this device for', c.id);
          return;
        }
        map[c.id] = buildIndexEntry(c.id, c.data);
        if (c.id === currentJobId) openJobChanged = true;
      });

      writeIndex(map);

      // The job open on screen changed somewhere else. If there are unsaved
      // edits here, do NOT overwrite them -- losing what someone just typed is
      // far worse than showing a slightly stale record. Say so instead.
      if (openJobChanged) {
        const stillHere = !!readJobBlob(currentJobId);
        if (stillHere && dirty) {
          showToast('This job was changed on another device — your edits here are kept');
        } else if (stillHere) {
          loadJob(currentJobId, true);
        } else if (dirty) {
          // Deleted elsewhere while being edited here. The edits win, as
          // above: the autosave already on its way puts the job back.
          showToast('This job was deleted on another device — your edits here will keep it');
        } else {
          // Deleted elsewhere with nothing typed here. Left in the form, the
          // next keystroke autosaved the deleted job back to life. Emptied
          // quietly -- nobody is moved off the screen they are on, and only
          // someone looking at the job is told why it went blank.
          clearJobForm();
          const onScreen = document.querySelector('.tab-panel.active');
          if (onScreen && (onScreen.id === 'panel-job' || onScreen.id === 'panel-tracking')) {
            showToast('This job was deleted on another device');
          }
        }
      }

      refreshVisible();
    } finally {
      applyingRemote = false;
    }
    keepOurs.forEach(queuePush);
  }

  // ---------------------------------------------------------------- startup

  // This device has seen the cloud holding jobs, so it must never act as the
  // seed for an empty one.
  function markMigrated() {
    try {
      if (!localStorage.getItem(MIGRATED_KEY)) localStorage.setItem(MIGRATED_KEY, new Date().toISOString());
    } catch (e) {}
  }

  function noteCloudIds(changes) {
    changes.forEach(c => {
      if (c.type === 'removed') cloudJobIds.delete(c.id); else cloudJobIds.add(c.id);
    });
  }

  async function startSync() {
    if (watching) return;

    const localCount = getJobIndex().length;
    let alreadyMigrated = false;
    try { alreadyMigrated = !!localStorage.getItem(MIGRATED_KEY); } catch (e) {}

    // The count is only there to decide whether this device must seed an
    // empty cloud, so it is only asked when that could be the answer. Every
    // other launch starts syncing at once -- with no signal included, where
    // the count could only fail after keeping sync waiting.
    // Only ever the owner's device: an admin's phone is never the seed.
    if (localCount > 0 && !alreadyMigrated && window.YDAuth && window.YDAuth.isOwner) {
      let cloudCount = null;     // stays null when the server could not be asked
      try {
        cloudCount = await window.YDDb.countJobs();
        // countJobs() goes to the server, so an answer means we are genuinely
        // connected.
        setCloudState('synced');
      } catch (err) {
        console.warn('[sync] could not count cloud jobs', err.code || err.message);
        setCloudState('offline');
      }

      if (cloudCount > 0) {
        markMigrated();
      } else if (cloudCount === 0) {
        // First run with jobs here but nothing in the cloud: this device's
        // data is the only copy, so it becomes the seed. Backup to Downloads
        // FIRST -- the build spec requires it, and an automatic backup before
        // a one-way data move is cheap insurance.
        try {
          exportAllJobs();
          const n = await pushAllLocal();
          markMigrated();
          showToast(n + ' job' + (n === 1 ? '' : 's') + ' moved to the cloud');
        } catch (err) {
          console.error('[sync] migration failed', err);
          showToast('Could not move jobs to the cloud — your jobs are still safe on this device');
        }
      }
      // A count that failed says nothing about the cloud. It used to be read
      // as "the cloud is empty", so every launch with no signal downloaded a
      // backup, then copied this device's jobs over the cloud's -- newer edits
      // from other devices included -- and stalled sync until the signal came
      // back. Now nothing is seeded, and the question is asked again next time.
    }

    watching = true;
    // Saves made before sync was running, this session or an earlier one.
    // Each stays on the list until pushNow has handed it to Firestore, so
    // closing the app in the moment before that still loses nothing.
    [...unsent].forEach(id => queuePush(id));
    // Deletes made before sync was running, this session or an earlier one.
    pendingDeletes.forEach(sendDelete);
    migrateStatuses();

    // The general watcher rather than watchJobs: it also reports the moment
    // the server first confirms the cached copy, even when nothing changed,
    // which the board tidy-up below has to wait for.
    unsubscribe = window.YDDb.watch('jobs',
      (changes, meta) => {
        noteCloudIds(changes);
        applyRemote(changes);
        // Firestore always delivers a cached snapshot FIRST, even when online,
        // so fromCache alone does not mean offline -- reading it that way made
        // a healthy connection report as "saved on this device". Only a server
        // snapshot is positive proof of being connected; a cached one just
        // tells us nothing new, so leave the state alone.
        if (meta.fromCache) return;
        setCloudState('synced');
        if (meta.size > 0) markMigrated();
        // The crew's job board is tidied only once this device holds what the
        // cloud holds. Run at startup, it compared the board against a phone
        // that had not received its jobs yet -- on a fresh phone, every job --
        // and deleted the lot, leaving the crew nothing to clock in to.
        if (!boardReconciled) { boardReconciled = true; reconcileBoard(); }
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
    // may have cancelled the confirm). Before sync is running it waits in
    // pendingDeletes rather than being dropped.
    if (existed && !readJobBlob(id)) queueDelete(id);
  };

  const _duplicateJob = window.duplicateJob;
  window.duplicateJob = function (id) {
    const before = new Set(getJobIndex().map(j => j.id));
    _duplicateJob.apply(this, arguments);
    getJobIndex().forEach(j => { if (!before.has(j.id)) queuePush(j.id); });
  };

  const _createJobRecord = window.createJobRecord;
  window.createJobRecord = function () {
    const id = _createJobRecord.apply(this, arguments);
    if (id) { queuePush(id); refreshVisible(); }
    return id;
  };

  // Restore announces exactly which jobs it took once the file has been read,
  // and only those go up -- not every job on the device after a fixed wait
  // that a slow file read could outlast.
  document.addEventListener('yd-jobs-restored', e => {
    (e.detail || []).forEach(id => queuePush(id));
  });

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
    // Jobs come down to whoever may see them: the owner, and an admin given
    // Jobs. Crew have their own screens, none of which read jobs -- the clock
    // reads jobBoard and the route reads storms, both of which watch
    // themselves. Mirroring jobs into a crew phone would only be refused.
    if (!ydCan('jobs', 'see')) {
      if (watching && unsubscribe) { unsubscribe(); watching = false; }
      setCloudState('off');
      return;
    }
    if (!window.YDDb) { setCloudState('off'); return; }
    startSync();
  });

  // Expose a little of this for diagnostics.
  window.YDSync = {
    status: () => ({ watching, cloudState, applyingRemote }),
    pushAll: pushAllLocal,
    patchJob: patchJob,
    stop: () => { if (unsubscribe) unsubscribe(); watching = false; setCloudState('off'); },
  };
})();
