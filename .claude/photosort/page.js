// Photos from iCloud onto the right job (the Job Hub half). Run inside the
// live Job Hub page in Chrome, signed in as the owner; photosort.py is the PC
// half and the routine (ROUTINE.md beside them, kept on the PC) puts the two
// together.
//
// YDPhotoSort.near(photos)   the jobs and leads within reach of each photo,
//                            with what Claude needs to tell them apart: what
//                            the work is, where the job stands, and whether
//                            the crew were clocked in there that day.
// YDPhotoSort.input()        adds the file box the routine hands the shrunk
//                            photos to (Claude in Chrome's file upload). The
//                            page can't fetch them from the PC itself: the
//                            browser blocks a website reaching this computer.
// YDPhotoSort.put(photo, jobId, stage, why)
//                            uploads one photo to the job the way the app
//                            does (photo + small copy in Storage, a jobPhotos
//                            record with when and where it was taken), reads
//                            it back from the server. The record id comes
//                            from the photo, so a second put can't add a copy.
(function () {
  'use strict';

  const M_PER_MILE = 1609.344;
  // A photo is "at" a place within this (photoplace.js AT_MILES), widened by
  // how far off the phone says its own reading may be, up to ACC_MAX_M.
  const REACH_MILES = 0.1;
  const ACC_MAX_M = 500;
  // Leads count for this long after they came in; finished jobs for this long
  // after they were finished (After photos are often taken a few days late).
  const LEAD_DAYS = 180;
  const FINISHED_DAYS = 30;
  const GEO_KEY = 'ydjobhub_photoSortGeo';
  const INPUT_ID = 'ydPhotoSortIn';
  const STAGES = ['before', 'during', 'after'];

  const geoMem = (() => { try { return JSON.parse(localStorage.getItem(GEO_KEY) || '{}'); } catch (e) { return {}; } })();
  const keepGeo = () => { try { localStorage.setItem(GEO_KEY, JSON.stringify(geoMem)); } catch (e) { /* only a cache */ } };
  const chicagoDay = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const clean = v => String(v == null ? '' : v).trim();
  const list = v => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);

  // An address's map point: Job Hub's own server lookup (Census, Dane
  // County's address list, then OpenStreetMap), kept so it is asked once.
  // An address no map knows yet (a new street) is asked again after
  // NOT_FOUND_DAYS; a lookup that failed (no answer) is not kept at all and
  // says so (`failed`), so the photo waits for a run that can check.
  const NOT_FOUND_DAYS = 3;
  async function pointFor(street, city, state, zip, failed) {
    if (!clean(street)) return null;
    const key = [street, city, zip].map(x => clean(x).toLowerCase()).join('|');
    const kept = geoMem[key];
    if (kept && typeof kept.lat === 'number') return kept;
    if (kept && kept.none && Date.now() - kept.none < NOT_FOUND_DAYS * 864e5) return null;
    try {
      const r = await window.YDClaude.post('/geo/find', { street: clean(street), city: clean(city), state: clean(state) || 'WI', zip: clean(zip) });
      if (!r || r.error) { failed.n++; return null; }
      geoMem[key] = r.found && r.geo && typeof r.geo.lat === 'number' ? { lat: r.geo.lat, lng: r.geo.lng } : { none: Date.now() };
      keepGeo();
    } catch (e) {
      failed.n++;
      return null;
    }
    return typeof geoMem[key].lat === 'number' ? geoMem[key] : null;
  }

  function workOf(j) {
    return ((j.estimate || {}).work || []).map(w => clean(w.title)).filter(Boolean).slice(0, 8);
  }
  function needOf(c) {
    const m = String(c.note || c.notes || '').match(/What they need:\s*([^.\n]+)/i);
    return clean((m && m[1]) || list(c.services).join(', ') || c.what);
  }
  function clockedDays(jobId) {
    try {
      const days = (window.YDClock && YDClock.jobShifts ? YDClock.jobShifts(jobId) : []).map(s => s.day);
      return Array.from(new Set(days)).sort();
    } catch (e) { return []; }
  }

  // Every job and lead that could own a photo taken on `day` (YYYY-MM-DD):
  // open bids, booked and running jobs, jobs finished in the last
  // FINISHED_DAYS, and leads with no job yet. Lost and removed ones never.
  async function places(day) {
    const t = Date.parse(day + 'T12:00:00-06:00');
    const jobs = await window.YDDb.list('jobs');
    const out = [], tiedLeads = new Set();
    for (const [id, j] of Object.entries(jobs || {})) {
      if (!j || j.removeWhy || j.deletedAt) continue;
      const st = typeof window.jobStage === 'function' ? window.jobStage(j).id : '';
      if (st === 'lost') continue;
      if (['finished', 'invoiced', 'paid'].indexOf(st) !== -1) {
        const fin = Date.parse(j.completedAt || '');
        if (!isFinite(fin) || t - fin > FINISHED_DAYS * 864e5) continue;
      }
      // Only a job that is itself a choice stands in for its lead: a repeat
      // customer's old finished job doesn't hide their new lead.
      if (j.customerId) tiedLeads.add(j.customerId);
      out.push({ kind: 'job', id: id, j: j, stage: st });
    }
    const customers = await window.YDDb.list('customers');
    for (const [id, c] of Object.entries(customers || {})) {
      if (!c || !/^ld/.test(id) || c.mergedInto || tiedLeads.has(id)) continue;
      const added = Date.parse(c.addedAt || c.createdAt || '');
      if (!isFinite(added) || t - added > LEAD_DAYS * 864e5 || added - t > 2 * 864e5) continue;
      out.push({ kind: 'lead', id: id, c: c, stage: 'lead' });
    }
    return out;
  }

  async function pointOfPlace(p, failed) {
    if (p.kind === 'job') {
      const own = window.YDPhotoPlace && YDPhotoPlace.pointOf ? YDPhotoPlace.pointOf(p.j) : null;
      return own || pointFor(p.j.address, p.j.city, p.j.state, p.j.zip, failed);
    }
    return pointFor(p.c.address || p.c.street, p.c.city, p.c.state, p.c.zip, failed);
  }

  // For each photo: the places within reach, nearest first.
  async function near(photos) {
    if (!window.YDPhotoPlace || !YDPhotoPlace.miles) throw new Error('Job Hub has not loaded photoplace.js');
    const byDay = {};
    const result = [];
    for (const ph of photos) {
      const day = chicagoDay(ph.at || ph.found);
      byDay[day] = byDay[day] || await places(day);
      const reachM = REACH_MILES * M_PER_MILE + Math.min(Math.max(Number(ph.acc) || 0, 0), ACC_MAX_M);
      const hits = [], failed = { n: 0 }, unlocated = [];
      for (const p of byDay[day]) {
        const pt = await pointOfPlace(p, failed);
        if (!pt) {
          // An open job or lead with an address no map knows yet: it could be
          // where the photo was taken, so it is named for the routine.
          const rec = p.j || p.c || {};
          if (clean(rec.address || rec.street)) {
            unlocated.push({ kind: p.kind, id: p.id, name: clean(rec.customerName || rec.name), stage: p.stage,
                             address: [rec.address || rec.street, rec.city].map(clean).filter(Boolean).join(', '),
                             work: p.j ? workOf(p.j) : [], need: p.c ? needOf(p.c) : '' });
          }
          continue;
        }
        const m = YDPhotoPlace.miles({ lat: ph.lat, lng: ph.lng }, pt) * M_PER_MILE;
        if (m > reachM) continue;
        const base = { kind: p.kind, id: p.id, stage: p.stage, feet: Math.round(m * 3.281) };
        if (p.kind === 'job') {
          const j = p.j, days = clockedDays(p.id);
          hits.push(Object.assign(base, {
            name: clean(j.customerName || j.name), address: [j.address, j.city].map(clean).filter(Boolean).join(', '),
            services: list(j.serviceTypes || j.services).slice(0, 8), work: workOf(j), crewWhat: clean(j.crewWhat),
            quoteDate: j.quoteDate || '', completedAt: j.completedAt || '',
            clockedThatDay: days.indexOf(day) !== -1, clockedDays: days.slice(-12),
          }));
        } else {
          const c = p.c;
          hits.push(Object.assign(base, {
            name: clean(c.name || [c.first, c.last].join(' ')),
            address: [c.address || c.street, c.city].map(clean).filter(Boolean).join(', '),
            need: needOf(c), addedAt: c.addedAt || '',
          }));
        }
      }
      hits.sort((a, b) => a.feet - b.feet);
      // lookupFailed: some address couldn't be checked this run (the map
      // server didn't answer), so an empty `near` proves nothing yet.
      result.push({ id: ph.id, file: ph.file, at: ph.at, day: day,
                    phoneSaysWithinFeet: ph.acc != null ? Math.round(ph.acc * 3.281) : null,
                    lookupFailed: failed.n > 0, near: hits, unlocated: unlocated.slice(0, 20) });
    }
    return result;
  }

  // ------------------------------------------------------- the file box

  function input() {
    let box = document.getElementById(INPUT_ID);
    if (!box) {
      box = document.createElement('input');
      box.type = 'file';
      box.id = INPUT_ID;
      box.multiple = true;
      box.accept = 'image/jpeg';
      box.setAttribute('aria-label', 'iCloud photos for Job Hub');
      box.style.cssText = 'position:fixed;top:0;left:0;width:220px;height:28px;z-index:99999;background:#fff';
      document.body.appendChild(box);
    }
    return INPUT_ID;
  }
  function fileFromBox(name) {
    const box = document.getElementById(INPUT_ID);
    const f = box && Array.from(box.files || []).find(x => x.name === name);
    if (!f) throw new Error(name + ' was not handed to the page');
    return f;
  }
  function done() {
    const box = document.getElementById(INPUT_ID);
    if (box) box.remove();
  }

  // ---------------------------------------------------------------- put

  // A file a run already sent before it was cut off is used as it is:
  // Storage takes a file once and never overwrites it (storage.rules), so a
  // second upload would be refused on every run after (jobphotos.js upOnce).
  async function upOnce(path, file) {
    try { return await window.YDStore.url(path); }
    catch (e) { if (!e || e.code !== 'storage/object-not-found') throw e; }
    return window.YDStore.upload(path, file, 'image/jpeg');
  }

  // opts.unsure: the photo couldn't settle between jobs (opts.alt = the other
  // job ids); Job Hub shows it with "Check the job" and a move to each.
  async function put(ph, jobId, stage, why, opts) {
    opts = opts || {};
    if (!window.YDAuth || !YDAuth.isOwner || !YDAuth.user) throw new Error('not signed in as the owner');
    if (STAGES.indexOf(stage) === -1) throw new Error('stage must be before, during or after');
    if (!/^jp[a-f0-9]{16}$/.test(String(ph.id || ''))) throw new Error('not a photo from photosort.py');
    const job = await window.YDDb.getFresh('jobs', jobId);
    if (!job || job.removeWhy || job.deletedAt) throw new Error('no such job ' + jobId);
    // Put before (any job): leave it, wherever it is now. Someone may have
    // moved it to another job by hand, and that stands.
    const was = await window.YDDb.getFresh('jobPhotos', ph.id);
    if (was) return { ok: true, already: true, jobId: was.jobId, num: was.num };
    // The same photo already in Job Hub under another id (its iCloud file was
    // made again): same file name, same moment taken.
    if (ph.file && ph.at) {
      const same = await window.YDDb.listWhere('jobPhotos', 'fromICloud.file', '==', clean(ph.file));
      const hit = Object.values(same || {}).find(p => p && p.taken && p.taken.at === ph.at);
      if (hit) return { ok: true, already: true, jobId: hit.jobId, num: hit.num };
    }
    const thumb = fileFromBox(ph.id + '_t.jpg');
    const full = fileFromBox(ph.id + '.jpg');
    const alt = [];
    for (const id of (Array.isArray(opts.alt) ? opts.alt : []).slice(0, 3)) {
      if (!id || id === jobId) continue;
      const other = await window.YDDb.getFresh('jobs', id);
      if (other && !other.removeWhy && !other.deletedAt) alt.push({ jobId: id, name: clean(other.customerName || other.name).slice(0, 80) });
    }
    const base = 'jobPhotos/' + jobId + '/' + ph.id;
    const thumbUrl = await upOnce(base + '_t.jpg', thumb);
    const url = await upOnce(base + '.jpg', full);
    // The next number on the job (jobphotos.js numbered: a new photo takes
    // max + 1; the owner's device mends a clash by itself).
    const theirs = await window.YDDb.listWhere('jobPhotos', 'jobId', '==', jobId);
    const num = Object.values(theirs || {}).reduce((m, p) => Math.max(m, Number(p.num) || 0), 0) + 1;
    const rec = {
      jobId: jobId, stage: stage, caption: '', path: base + '.jpg', thumbPath: base + '_t.jpg',
      url: url, thumbUrl: thumbUrl, w: ph.w, h: ph.h, by: YDAuth.user.uid,
      byName: (window.YDRemind && YDRemind.me && YDRemind.me().name) || 'Jonah',
      at: ph.at || new Date().toISOString(), deleteAsked: null, num: num,
      taken: { at: ph.at || null, lat: ph.lat, lng: ph.lng, acc: typeof ph.acc === 'number' ? ph.acc : null },
      // Where it came from and why it went here, so a wrong one can be traced.
      fromICloud: { file: clean(ph.file), model: clean(ph.model), sortedAt: new Date().toISOString(), why: clean(why).slice(0, 300),
                    unsure: !!opts.unsure && alt.length > 0, alt: opts.unsure ? alt : [] },
    };
    await window.YDDb.put('jobPhotos', ph.id, rec);
    const back = await window.YDDb.getFresh('jobPhotos', ph.id);
    if (!back || back.jobId !== jobId) throw new Error('saved but not read back from the server');
    return { ok: true, jobId: jobId, num: num, stage: stage };
  }

  window.YDPhotoSort = { near: near, input: input, put: put, done: done };
})();
