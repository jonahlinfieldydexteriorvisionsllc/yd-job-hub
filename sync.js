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
  // Job fields written by the server (QuickBooks' answers, the plant-care
  // email, when the estimate was first seen accepted); all are in app.js
  // BOARD_FIELDS so the form carries them. jobLine (where Jonah put a booked
  // job in line, jobline.js) is not the server's but is carried the same
  // way: moved on the iPad while the laptop has the job open with typing in
  // it, the laptop's next save would put it back -- the newest move wins
  // (newerLine).
  const SERVER_FIELDS = ['qbEstimate', 'qbInvoiceRef', 'careEmail', 'acceptedSeenAt', 'fromQuickBooks', 'qbFilled', 'snowChecked',
    'removeWhy', 'replacedBy', 'removeNote', 'customerId', 'customerBy', 'qbChangesIn', 'qbChangesOff',
    'chaseDrafts', 'chaseHeard', 'chaseLostCard', 'thanksEmail', 'jobLine'];
  // A place in line set (or put back) after the one this copy has.
  const newerLine = (s, l) => !!s && typeof s === 'object' && String(s.at || '') > String((l && l.at) || '');

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

  // Every job on the device, those in Recently deleted too (app.js
  // getJobIndexAll): they are still kept in step with the cloud.
  function indexById() {
    const map = {};
    getJobIndexAll().forEach(j => { map[j.id] = j; });
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
  // Picked out by the index's status, which every save keeps equal to the
  // job's own: reading every stored job to find the few (now none) still
  // marked 'active' was one more full pass over them at every launch.
  function migrateStatuses() {
    if (!window.YDAuth || !window.YDAuth.isOwner || typeof normStatus !== 'function') return;
    getJobIndex().forEach(j => {
      if (j.status !== 'active') return;
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
  // via: what moved it when it was not a person's own tap ('QuickBooks'),
  // for the change history.
  function patchJob(id, patch, via) {
    const raw = readJobBlob(id);
    if (!raw) return false;
    let data;
    try { data = JSON.parse(raw); } catch { return false; }
    // A bid booked from anywhere brings its estimate's materials onto
    // Materials to Order (app.js bookedOrderItems).
    if (patch.jobStatus === 'booked' && isBidStatus(data.jobStatus) && !patch.orderItems &&
        typeof bookedOrderItems === 'function') {
      const list = bookedOrderItems(id, data);
      if (list) patch = Object.assign({}, patch, { orderItems: list });
    }
    // Where a finished job stands with its invoice (finishedStage): finished
    // from somewhere that did not say (anything but a move on the Jobs board,
    // which picks the column itself), or its QuickBooks invoice changed --
    // made, or paid off. Done here, on the patch, because the server writes
    // the same stage (quickbooks.py) and this device's copy, pushed whole a
    // moment later, would otherwise put the old one back.
    const after = Object.assign({}, data, patch);
    if (statusOf(after) === 'complete' && !('workStage' in patch) &&
        ('qbInvoiceRef' in patch || (patch.jobStatus === 'complete' && statusOf(data) !== 'complete'))) {
      const stage = finishedStage(after);
      if (stage !== after.workStage) patch = Object.assign({}, patch, { workStage: stage, workStageAt: new Date().toISOString() });
    }
    // When a job was finished, and whether it has plants (plantcare.js): on
    // the patch, so a form open with typing in it carries them too.
    if (window.YDPlants) patch = Object.assign({}, patch, window.YDPlants.patchExtras(data, patch));
    // A job finished from anywhere: its plant-care email (estimate.js).
    const finished = patch.jobStatus === 'complete' && data.jobStatus !== 'complete';
    // Where it stood before, for the change history (changelog.js).
    const was = { jobStatus: data.jobStatus, bidStage: data.bidStage, workStage: data.workStage,
                  customerName: data.customerName, estimateNumber: data.estimateNumber };
    Object.assign(data, patch, { lastModified: new Date().toISOString() });
    if (finished && window.YDEstimate && window.YDEstimate.jobCompleted) window.YDEstimate.jobCompleted(id, data);
    try {
      localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(data));
    } catch (err) {
      showToast('Could not save that move on this device');
      return false;
    }
    const map = indexById();
    map[id] = buildIndexEntry(id, data);
    writeIndex(map);
    if (window.YDChangeLog) window.YDChangeLog.jobMoved(id, was, data, via);

    if (id === currentJobId) {
      if (dirty) {
        // Keep what is being typed; just carry the move into it.
        if (patch.jobStatus) { jobStatus = patch.jobStatus; syncStatusSelect(); updateCtxBar(); }
        BOARD_FIELDS.forEach(f => { if (f in patch) boardFields[f] = patch[f]; });
        // Where the bid stands, on its banner (app.js bidWhere).
        if (typeof showBidBanner === 'function') showBidBanner();
      } else {
        loadJob(id, true);
      }
    }
    queuePush(id);
    refreshVisible();
    bookIfAccepted(id, data);
    return true;
  }

  // Accepted in QuickBooks = booked (Jonah, 9 Oct 2026: "pull accepted
  // estimates from quickbooks and add them as jobs"). A bid whose estimate
  // the customer accepted becomes a job by itself, through patchJob like
  // Make it a job -- so Materials to Order fills from the estimate, which the
  // server cannot do. The owner's device does it. A bid someone moved AFTER
  // the acceptance came in (marked lost after all, say) is left where they
  // put it.
  //
  // "After" is measured from acceptedSeenAt, written once when the estimate
  // was first seen accepted. qbEstimate.syncedAt alone moved on with every
  // status check, so a bid marked lost after the acceptance was booked again
  // by the next check (review, 9 Oct). Jobs from before acceptedSeenAt fall
  // back to syncedAt.
  //
  // Accepted then made into an invoice before anyone looked ('Closed', or
  // 'Converted') still counts, when QuickBooks has an accepted date for it.
  // The one reading of it: the Bids board and Home ask here (YDSync.qbAccepted),
  // functions/digest.py qb_accepted reads a job's record the same way.
  function qbAccepted(q) {
    q = q || {};
    return q.status === 'Accepted' ||
      ((q.status === 'Closed' || q.status === 'Converted') && !!q.acceptedDate);
  }
  // The customer turned the estimate down in QuickBooks. Not lost by itself
  // -- Jonah may still talk them round -- but never chased (boards.js
  // toChase, digest.py _bids, followup.py).
  const qbTurnedDown = q => !!q && q.status === 'Rejected';

  // ------------------------------------------- a finished job and its invoice
  //
  // A finished job is Ready to invoice, Invoiced or Paid (the Jobs board's
  // last three columns). Ten fields used to say where a job was and they
  // disagreed: the form set Complete and left the card wherever it was, the
  // invoice was made in QuickBooks and the card still said Ready to invoice.
  // Now the job has ONE stage (app.js jobStage; the server's twin is
  // functions/stages.py stage_of), and a finished job's column is that
  // stage: read by the form (app.js onStatusChange), the board (boards.js
  // workColumn) and this file's patchJob. With a QuickBooks invoice,
  // QuickBooks decides (owed: Invoiced, nothing owed: Paid); without one the
  // column set by hand stands -- a job Jonah marked Paid (cash) stays Paid.
  const END_STAGES = { toInvoice: 0, invoiced: 1, paid: 2 };
  const statusOf = d => (typeof normStatus === 'function' ? normStatus(d.jobStatus, d) : (d.jobStatus || 'quoting'));
  const COLUMN_OF = { finished: 'toInvoice', invoiced: 'invoiced', paid: 'paid' };
  function finishedStage(d) {
    // Asked of a job finished or being finished, whatever its status says yet.
    const s = jobStage(Object.assign({}, d || {}, { jobStatus: 'complete' }));
    return COLUMN_OF[s.id] || 'toInvoice';
  }
  // The server moved a finished job on (quickbooks.py: invoice made, or paid
  // off) while this device holds a newer copy, or has the job open with
  // typing in it. Its stage is carried in only when this copy is finished
  // too -- this device moving a job back to In progress is not undone. With
  // a QuickBooks invoice the server's column is QuickBooks' answer (stage_of),
  // so it is taken either way (a payment taken off in QuickBooks moves a job
  // from Paid back to Invoiced).
  function takeServerStage(local, theirs) {
    const s = theirs.workStage, l = local.workStage;
    if (END_STAGES[s] == null || !(theirs.qbInvoiceRef && theirs.qbInvoiceRef.id)) return false;
    if (statusOf(local) !== 'complete') return false;
    if (s === l) return false;
    local.workStage = s;
    local.workStageAt = theirs.workStageAt || new Date().toISOString();
    return true;
  }

  // A bid QuickBooks has emailed moves to Sent once, on the server
  // (quickbooks.py _emailed_patch). A copy saved here meanwhile -- or the
  // form open with typing in it -- would put it back under "Bid to send",
  // so the move is carried in, like the stage above: only onto a bid still
  // waiting to go out, and only a move newer than where it was put.
  const BID_UNSENT = ['', 'siteVisit', 'toSend'];
  function takeServerSent(local, theirs) {
    if (theirs.bidStage !== 'sent' || !isBidStatus(local.jobStatus)) return false;
    if (BID_UNSENT.indexOf(String(local.bidStage || '')) === -1) return false;
    if (String(theirs.bidStageAt || '') <= String(local.bidStageAt || '')) return false;
    local.bidStage = 'sent';
    local.bidStageAt = theirs.bidStageAt;
    return true;
  }

  const booking = new Set();
  function bookIfAccepted(id, d) {
    if (!d || booking.has(id) || !window.YDAuth || !window.YDAuth.isOwner || !ydCan('jobs', 'change')) return;
    const q = d.qbEstimate || {};
    if (!qbAccepted(q) || !isBidStatus(d.jobStatus) || d.bidStage === 'won' || d.deletedAt) return;
    // A snow bid said yes to is a season's contract: it goes on the Snow
    // route (quickbooks.py snow_bids, estimate.js), never on the job list.
    if (q.snowBid || d.removeWhy === 'snow' || (window.YDEstimate && YDEstimate.isSnowJob && YDEstimate.isSnowJob(d))) return;
    const seenAt = d.acceptedSeenAt || q.syncedAt;
    if (d.bidStageAt && seenAt && String(d.bidStageAt) > String(seenAt)) return;
    booking.add(id);
    setTimeout(() => {
      const at = new Date().toISOString();
      const ok = patchJob(id, { bidStage: 'won', bidStageAt: at, jobStatus: 'booked', workStage: 'scheduled', workStageAt: at }, 'QuickBooks');
      booking.delete(id);
      if (ok) showToast((d.customerName || 'A customer') + ' accepted the estimate in QuickBooks — booked as a job', 6000);
    }, 0);
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
    boardKnown.set(id, NOT_ON_BOARD);
    window.YDDb.remove('jobBoard', id).catch(err => {
      boardKnown.delete(id);
      console.warn('[sync] job board delete failed', err.code || err.message);
    });
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
      // What the job is, in a few words, shown beside the name (app.js jobWhat).
      what: typeof jobWhat === 'function' ? jobWhat(d) : '',
      updatedAt: new Date().toISOString(),
    };
  }

  // A bid is not a job until it is booked (app.js isBidStatus), so it is not
  // on the crew's clock either: booking it puts it there.
  // Nor is a job marked to be taken off (a copy, or a snow contract now on the
  // Snow route -- app.js removeBoxHtml), nor one in Recently deleted.
  const onBoard = d => !d.removeWhy && !d.deletedAt && (typeof normStatus === 'function' ? normStatus(d.jobStatus, d) : (d.jobStatus || 'quoting')) !== 'quoting';

  // What this device knows the board holds for each job: the crew-visible
  // part of its entry, or NOT_ON_BOARD for none. A job missing from the map
  // is unknown -- before the first look at the board this session, or after
  // another device changed the job -- and unknown means "send it".
  //
  // Every autosave used to rewrite the entry with a fresh time on it, so each
  // pause in typing made every crew phone download it and redraw its clock;
  // and every autosave of a bid sent a delete for an entry that was never
  // there. Now only a change the crew would see goes out.
  const NOT_ON_BOARD = '-';
  const boardKnown = new Map();
  const boardSig = e => (e ? [e.name, e.address, e.status, e.what || ''].join('\n') : NOT_ON_BOARD);

  function pushBoard(id, data) {
    // Whoever may change jobs: the owner, or an admin given that. The rules
    // refuse it from anyone else, whose app has no business maintaining the
    // list anyway.
    if (!ydCan('jobs', 'change')) return;
    // The crew's page for the job (crewjobs.js) follows the same save -- and
    // a fault there must never stop the job itself being saved.
    if (window.YDCrewJobs) {
      try { YDCrewJobs.mirror(id, data); } catch (e) { console.warn('[sync] crew copy not made for', id, e); }
    }
    const entry = onBoard(data) ? boardEntry(id, data) : null;
    const sig = boardSig(entry);
    if (boardKnown.get(id) === sig) return;
    boardKnown.set(id, sig);
    const write = entry ? window.YDDb.put('jobBoard', id, entry) : window.YDDb.remove('jobBoard', id);
    Promise.resolve(write)
      .catch(err => {
        // Refused, not merely offline (Firestore keeps those): the next save
        // tries again.
        if (boardKnown.get(id) === sig) boardKnown.delete(id);
        console.warn('[sync] job board not yet updated for', id, err.code || err.message);
      });
  }

  // Settles true once the server has the job, false if it could not be sent.
  async function pushNow(id) {
    // Someone allowed only to look at jobs never sends one up.
    if (!ydCan('jobs', 'change')) { forgetUnsent(id); return false; }
    const raw = readJobBlob(id);
    if (!raw) { forgetUnsent(id); return false; }
    let data;
    try { data = JSON.parse(raw); } catch { forgetUnsent(id); return false; }
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
      return true;
    } catch (err) {
      // Offline is not an error worth shouting about -- Firestore queues the
      // write and sends it when the signal comes back. Anything else is.
      console.warn('[sync] push failed for', id, err.code || err.message);
      setCloudState('offline');
      return false;
    }
  }

  // Sent now rather than after the usual pause, settling once the server has
  // it -- for something the server is about to read. The plant-care email
  // reads the finished job there; asked for on a timer, it ran ahead of the
  // save and found no email address, or no job at all (review, 7 Oct).
  // Gives up after 20 seconds: with no signal, the write stays queued in
  // Firestore but nothing waits on it.
  function sendNow(id) {
    if (!watching) return Promise.resolve(false);
    clearTimeout(pushTimers[id]);
    return Promise.race([pushNow(id), new Promise(done => setTimeout(() => done(false), 20000))]);
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
      getJobIndexAll().forEach(j => {
        const raw = readJobBlob(j.id);
        if (!raw) return;
        let d; try { d = JSON.parse(raw); } catch { return; }
        // After this pass the board holds what this device wants for the
        // job, so saves from here on are compared with that (pushBoard).
        if (!onBoard(d)) { bids.add(j.id); boardKnown.set(j.id, NOT_ON_BOARD); return; }
        const want = boardEntry(j.id, d), have = board[j.id];
        boardKnown.set(j.id, boardSig(want));
        if (!have || boardSig(have) !== boardSig(want)) {
          writes.push(['jobBoard', j.id, want]);
        }
      });

      // A board entry whose job is gone would leave crew able to clock in to
      // work that no longer exists. Gone means gone from the cloud as well as
      // from this device: a job the cloud still has but this phone could not
      // store (no room left on it, say) is not gone.
      // A bid comes off it too, until it is booked.
      const gone = Object.keys(board).filter(id => bids.has(id) || (!readJobBlob(id) && !cloudJobIds.has(id)));
      gone.forEach(id => boardKnown.set(id, NOT_ON_BOARD));

      // Handed to Firestore, not awaited, like every other write here: it
      // sends them whenever the signal allows.
      // Refused (not merely offline): those are unknown again, so the next
      // save of each tries once more.
      if (writes.length) {
        window.YDDb.putMany(writes).catch(err => {
          writes.forEach(w => boardKnown.delete(w[1]));
          console.warn('[sync] job board update failed', err.code || err.message);
        });
      }
      if (gone.length) {
        window.YDDb.removeMany(gone.map(id => ['jobBoard', id])).catch(err => {
          gone.forEach(id => boardKnown.delete(id));
          console.warn('[sync] job board tidy-up failed', err.code || err.message);
        });
      }
      if (writes.length || gone.length) {
        console.info('[sync] job board: ' + writes.length + ' updated, ' + gone.length + ' removed');
      }
    } catch (err) {
      console.warn('[sync] job board reconcile failed', err.code || err.message);
    }
  }

  function pushAllLocal() {
    const idx = getJobIndexAll();
    const entries = [];
    idx.forEach(j => {
      const raw = readJobBlob(j.id);
      if (!raw) return;
      try { entries.push([j.id, JSON.parse(raw)]); } catch {}
    });
    return entries.length ? window.YDDb.putManyJobs(entries).then(() => entries.length) : Promise.resolve(0);
  }

  // ---------------------------------------------------------------- pull

  // A copy kept here because its time looked newer than the server's (a
  // phone clock running fast is enough) can still be missing what the server
  // wrote: QuickBooks' answer, the care email. Pushed as it was, it put the
  // old values back and the hourly check reported the same news again
  // (review, 7 Oct). Only what is plainly further along is taken -- a field
  // this copy does not have yet, or the same estimate moved on from Pending
  // -- so a stale snapshot can never wind a newer answer back.
  const EST_STEP = { Pending: 0, Accepted: 1, Rejected: 1, Closed: 2, Converted: 2 };
  const estStep = s => EST_STEP[s || 'Pending'] || 0;
  // The estimate the server filled from QuickBooks (quickbooks.py), where
  // this copy's has no lines at all: taken too. Kept back, it went up empty
  // with qbFilled -- "filled" -- and the job had no work on it (Oct 2026).
  const estHasLines = e => !!(e && ((e.work || []).length || (e.materials || []).length));
  const qbFilledEstimate = (local, theirs) => !!(theirs.estimate && theirs.estimate.fromQb && estHasLines(theirs.estimate) && !estHasLines(local.estimate));
  function takeServerFields(local, theirs) {
    let took = false;
    // The change orders on its invoice the server has put in the price
    // (quickbooks.py _price_follows): this copy's price, saved after the
    // server's, moves by the same -- or the push would take them back out.
    // One whose change orders were put in by hand (qbChangesOff) is never
    // moved by them.
    const cin = theirs.qbChangesIn;
    if (typeof cin === 'number' && cin !== local.qbChangesIn) {
      const price = parseMoney(local.jobPrice || '');
      const had = typeof local.qbChangesIn === 'number' ? local.qbChangesIn : 0;
      if (!theirs.qbChangesOff && !local.qbChangesOff && price > 0 && cin !== had) local.jobPrice = (price + (cin - had) / 100).toFixed(2);
      local.qbChangesIn = cin;
      took = true;
    }
    SERVER_FIELDS.forEach(f => {
      const s = theirs[f], l = local[f];
      if (s == null || f === 'qbChangesIn') return;
      // The follow-up emails the server drafted, one more at a time
      // (followup.py auto): every one it has is kept with this copy's.
      if (f === 'chaseDrafts' && l && typeof s === 'object') {
        if (Object.keys(s).some(k => !(k in l))) { local[f] = Object.assign({}, l, s); took = true; }
        return;
      }
      if (f === 'jobLine') {
        if (newerLine(s, l)) { local[f] = s; took = true; }
        return;
      }
      const ahead = l == null ||
        (f === 'qbEstimate' && s.id && s.id === l.id && (estStep(s.status) > estStep(l.status) ||
          // Emailed since (quickbooks.py _emailed_patch), with no answer lost.
          (estStep(s.status) === estStep(l.status) && s.emailStatus === 'EmailSent' &&
            (l.emailStatus !== 'EmailSent' || String(s.emailedAt || '') > String(l.emailedAt || ''))))) ||
        // The estimate this copy has was deleted in QuickBooks since
        // (quickbooks.py _deleted_record).
        (f === 'qbEstimate' && !s.id && s.deleted && l.id && String(s.deleted.id) === String(l.id)) ||
        // The invoice as QuickBooks has it now: its balance, its change orders.
        (f === 'qbInvoiceRef' && s.id && s.id === l.id && String(s.syncedAt || '') > String(l.syncedAt || '')) ||
        // Where the thank-you stands (followup.py): each record the server
        // writes is newer -- held, then sent -- and an older one pushed back
        // over "sent" would show it as still to go.
        (f === 'thanksEmail' && String(s.at || '') > String(l.at || ''));
      if (ahead) { local[f] = s; took = true; }
    });
    if (qbFilledEstimate(local, theirs)) {
      // What was typed on the estimate here (its site notes) stays.
      local.estimate = Object.assign({}, theirs.estimate, local.estimate && local.estimate.notes ? { notes: local.estimate.notes } : {});
      took = true;
    }
    return took;
  }

  // Someone is in one of the open job's boxes (the Job or Tracking tab, the
  // estimate and its chat with Claude included). The form is not rebuilt
  // under them: the cursor jumped, and what was half typed went.
  function formBusy() {
    const a = document.activeElement;
    if (!a || a === document.body || !a.closest || !a.closest('#panel-job, #panel-tracking')) return false;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || !!a.isContentEditable;
  }
  // The open job brought up to date from its stored copy, keeping a message
  // to Claude typed and not yet sent (estimate.js keeps it only in memory,
  // and loading the job empties the chat box).
  function reloadOpenJob() {
    const box = document.getElementById('estMsg');
    const draft = box ? box.value : '';
    loadJob(currentJobId, true);
    if (draft && typeof estMsgInput === 'function') {
      estMsgInput(draft);
      const again = document.getElementById('estMsg');
      if (again) again.value = draft;
    }
  }
  // Changed elsewhere while someone was in one of its boxes: brought up to
  // date as soon as they leave them, if nothing has been typed since (typing
  // keeps theirs, as when the change came in with edits already made).
  let freeTimer = null;
  function reloadWhenFree() {
    if (freeTimer) return;
    const id = currentJobId;
    freeTimer = setInterval(() => {
      if (currentJobId === id && formBusy()) return;
      clearInterval(freeTimer); freeTimer = null;
      if (currentJobId !== id) return;
      if (dirty) { showToast('This job was changed on another device — your edits here are kept'); return; }
      let d = null;
      try { d = JSON.parse(readJobBlob(id) || 'null'); } catch (e) {}
      if (d && !d.deletedAt) reloadOpenJob();
    }, 1500);
  }

  function applyRemote(changes) {
    if (!changes.length) return;
    applyingRemote = true;
    const keepOurs = [];
    try {
      const map = indexById();
      let openJobChanged = false;
      // Whether anything on this device changed. Most snapshots are this
      // device's own autosave coming back round; rewriting the index and
      // telling a dozen screens to redraw for it (each re-reading every job)
      // cost most of a second after every pause in typing, worst on the iPad.
      let touched = false;

      changes.forEach(c => {
        if (c.type === 'removed') {
          touched = true;
          localStorage.removeItem(STORAGE_PREFIX + c.id);
          delete map[c.id];
          boardKnown.delete(c.id);
          if (c.id === currentJobId) openJobChanged = true;
          return;
        }
        // Deleted on this device, the delete not yet confirmed by the server:
        // the cloud's copy is on its way out and must not be written back.
        if (pendingDeletes.has(c.id)) return;
        // Already holding exactly this copy, as the index says without the
        // stored job being read and parsed. The first snapshot of every
        // launch lists every job, nearly all of them unchanged.
        const theirsAt = c.data && c.data.lastModified;
        if (theirsAt && map[c.id] && map[c.id].lastModified === theirsAt &&
            localStorage.getItem(STORAGE_PREFIX + c.id) !== null) return;
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
        // What the server wrote into it meanwhile is carried into ours first,
        // or the push would put the old values back.
        if (mine && theirs && mine > theirs) {
          const tookFields = takeServerFields(local, c.data || {});
          const tookStage = takeServerStage(local, c.data || {});
          const tookSent = takeServerSent(local, c.data || {});
          // The QuickBooks side of its payments (app.js mergePayments).
          const pays = typeof mergePayments === 'function' ? mergePayments(local.payments, (c.data || {}).payments) : null;
          if (pays && pays.changed) local.payments = pays.list;
          if (c.id === currentJobId && typeof mergeOpenPayments === 'function') mergeOpenPayments((c.data || {}).payments);
          if (tookFields || tookStage || tookSent || (pays && pays.changed)) {
            touched = true;
            try { localStorage.setItem(STORAGE_PREFIX + c.id, JSON.stringify(local)); } catch (e) {}
            map[c.id] = buildIndexEntry(c.id, local);
            if (c.id === currentJobId) {
              SERVER_FIELDS.forEach(f => { if (local[f] != null) boardFields[f] = local[f]; });
              if (tookStage) { boardFields.workStage = local.workStage; boardFields.workStageAt = local.workStageAt; }
              if (tookSent) { boardFields.bidStage = local.bidStage; boardFields.bidStageAt = local.bidStageAt; }
              if (typeof showBidBanner === 'function') showBidBanner();
              if (window.YDEstimate && window.YDEstimate.takeQb) window.YDEstimate.takeQb(local.estimate);
              // Its invoice's change orders: the add-ons table and the price.
              if (typeof ydInvoiceChanged === 'function') ydInvoiceChanged();
            }
            bookIfAccepted(c.id, local);
          }
          // The other device's save rewrote the crew's board entry; ours goes
          // back up, and pushBoard must not skip it as "already sent".
          boardKnown.delete(c.id);
          keepOurs.push(c.id);
          return;
        }
        try {
          localStorage.setItem(STORAGE_PREFIX + c.id, JSON.stringify(c.data));
        } catch (e) {
          console.warn('[sync] no room on this device for', c.id);
          return;
        }
        touched = true;
        map[c.id] = buildIndexEntry(c.id, c.data);
        // Changed on another device: what the board holds for it is unknown
        // here until this device next sends it -- except a bid that stays a
        // bid, which has no entry wherever it is saved.
        if (!(boardKnown.get(c.id) === NOT_ON_BOARD && !onBoard(c.data || {}))) boardKnown.delete(c.id);
        bookIfAccepted(c.id, c.data);
        // Brought in from QuickBooks: its materials joined to Supplies (app.js).
        if (typeof fillFromQb === 'function') fillFromQb(c.id, c.data);
        // The crew's page for it follows what the server or another device
        // wrote (crewjobs.js; it checks the server's copy first).
        if (window.YDCrewJobs && YDCrewJobs.remote) {
          try { YDCrewJobs.remote(c.id); } catch (e) { console.warn('[sync] crew copy not checked for', c.id, e); }
        }
        if (c.id === currentJobId) {
          openJobChanged = true;
          // What only the server writes -- QuickBooks' answers, the care
          // email -- goes into the open form even when it has unsaved edits,
          // or the next save would put the old values back. The same while
          // someone is in one of the form's boxes (the form is not reloaded
          // under them -- reloadWhenFree): what they type next is saved over
          // this copy with these carried in.
          if (dirty || formBusy()) {
            SERVER_FIELDS.forEach(f => {
              if (!c.data || c.data[f] == null) return;
              if (f === 'jobLine' && !newerLine(c.data[f], boardFields[f])) return;
              boardFields[f] = c.data[f];
            });
            // And the estimate the server filled from QuickBooks, into one
            // with no lines yet (estimate.js keeps what was typed).
            if (window.YDEstimate && window.YDEstimate.takeQb) window.YDEstimate.takeQb(c.data && c.data.estimate);
            // The change orders on its invoice: the add-ons table and the
            // price box (base + add-ons) come to what the server saved.
            if (typeof ydInvoiceChanged === 'function') ydInvoiceChanged();
            if (typeof mergeOpenPayments === 'function') mergeOpenPayments(c.data && c.data.payments);
            // And the stage the server moved it to with its invoice, or the
            // form's next save would put the card back in Ready to invoice.
            const form = { workStage: boardFields.workStage, jobStatus: jobStatus };
            if (takeServerStage(form, c.data || {})) {
              boardFields.workStage = form.workStage; boardFields.workStageAt = form.workStageAt;
            }
            // And a bid QuickBooks emailed, moved to Sent.
            const bid = { bidStage: boardFields.bidStage, bidStageAt: boardFields.bidStageAt, jobStatus: jobStatus };
            if (takeServerSent(bid, c.data || {})) { boardFields.bidStage = bid.bidStage; boardFields.bidStageAt = bid.bidStageAt; }
            if (typeof showBidBanner === 'function') showBidBanner();
          }
        }
      });

      if (!touched) return;
      writeIndex(map);

      // The job open on screen changed somewhere else. If there are unsaved
      // edits here, do NOT overwrite them -- losing what someone just typed is
      // far worse than showing a slightly stale record. Say so instead.
      if (openJobChanged) {
        // Moved to Recently deleted elsewhere counts as deleted here.
        let stillHere = false;
        try { const d = JSON.parse(readJobBlob(currentJobId) || 'null'); stillHere = !!d && !d.deletedAt; } catch (e) {}
        if (stillHere && dirty) {
          showToast('This job was changed on another device — your edits here are kept');
        } else if (stillHere && formBusy()) {
          reloadWhenFree();
        } else if (stillHere) {
          reloadOpenJob();
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
      // In here, so a snapshot that changed nothing (the return above) still
      // sends up the copies this device kept as newer.
      keepOurs.forEach(queuePush);
    }
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

    // The general watcher: it also reports the moment the server first
    // confirms the cached copy, even when nothing changed, which the board
    // tidy-up below has to wait for.
    // Each watch answers for itself only: a refusal from one already given
    // up (a start-up race) must not take down the one now running.
    const mine = ++watchGen;
    unsubscribe = window.YDDb.watch('jobs',
      (changes, meta) => {
        if (mine !== watchGen) return;
        noteCloudIds(changes);
        applyRemote(changes);
        // Firestore always delivers a cached snapshot FIRST, even when online,
        // so fromCache alone does not mean offline -- reading it that way made
        // a healthy connection report as "saved on this device". Only a server
        // snapshot is positive proof of being connected; a cached one just
        // tells us nothing new, so leave the state alone.
        if (meta.fromCache) return;
        watchTries = 0;
        setCloudState('synced');
        if (meta.size > 0) markMigrated();
        // The crew's job board is tidied only once this device holds what the
        // cloud holds. Run at startup, it compared the board against a phone
        // that had not received its jobs yet -- on a fresh phone, every job --
        // and deleted the lot, leaving the crew nothing to clock in to.
        if (!boardReconciled) { boardReconciled = true; reconcileBoard(); }
      },
      () => { if (mine !== watchGen) return; setCloudState('offline'); watchAgain(); }
    );
  }
  // A watch the server refused is over for good -- Firestore ends it. Seen
  // at start-up (22 Oct 2026: "Missing or insufficient permissions" on the
  // owner's laptop, before the sign-in had settled), and `watching` then
  // kept every later start away: no job changed on another device or by
  // the server arrived all session. So it is started again, a little later
  // each time (3 s, 6 s ... up to a minute); saves made meanwhile wait in
  // `unsent` as they do with no signal.
  let watchTries = 0, watchTimer = 0, watchGen = 0;
  function watchAgain() {
    if (unsubscribe) { try { unsubscribe(); } catch (e) {} }
    unsubscribe = null;
    watching = false;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      if (window.YDAuth && window.YDAuth.user && window.YDDb && ydCan('jobs', 'see')) startSync();
    }, Math.min(60000, 3000 * Math.pow(2, watchTries++)));
  }

  // ---------------------------------------------------------------- wrapping

  // Wrap rather than edit, so app.js keeps working untouched if sync never
  // starts. Each wrapper does the original thing first, then mirrors it.

  const _persistJob = window.persistJob;
  let savedTimer = null;
  window.persistJob = function (announce) {
    const ok = _persistJob.apply(this, arguments);
    if (ok) {
      queuePush(currentJobId);
      // The other screens that draw from jobs (search, the calendar's job
      // colours, subcontractors, receipts...) hear of the save once typing
      // pauses. They used to hear of it only from its echo off the cloud,
      // which applyRemote now passes over without redrawing anything.
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => document.dispatchEvent(new CustomEvent('yd-jobs-changed')), 1500);
    }
    return ok;
  };

  // Deleted for good (app.js purgeJob, from Recently deleted). Moving a job
  // to Recently deleted is a patchJob like any other change.
  const _purgeJob = window.purgeJob;
  window.purgeJob = async function (id) {
    const existed = !!readJobBlob(id);
    // app.js purgeJob waits for its "Delete for good?" window. Checked before
    // that answer, the job was always still here, so the cloud copy was never
    // deleted and the job came back on the next snapshot.
    await _purgeJob.apply(this, arguments);
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
    patchJob: patchJob,
    sendNow: sendNow,
    // The job lifecycle's shared readings (see above): boards.js, home.js and
    // app.js ask these rather than each working it out again.
    qbAccepted: qbAccepted,
    qbTurnedDown: qbTurnedDown,
    finishedStage: finishedStage,
    // Whether the server's job list has arrived on this device, and whether a
    // job is in it (crewjobs.js: a crew copy is only taken down for a job the
    // server no longer has -- never on a device still filling its list).
    jobsHeard: () => boardReconciled,
    inCloud: id => cloudJobIds.has(id),
    stop:() => { clearTimeout(watchTimer); if (unsubscribe) unsubscribe(); watching = false; setCloudState('off'); },
  };
})();
