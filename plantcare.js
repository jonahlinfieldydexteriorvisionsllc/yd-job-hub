// Jobs with plants, and the plant-care email each one owes once it is done.
//
// Jonah (14 Oct 2026): "make it so all jobs that include any plants are
// flagged so that when theyre marked as done an email with care info needs
// to be sent."
//
// HAS PLANTS is worked out in code from what the job already says -- no
// Claude call (his "code over Claude"):
//   - its estimate: a "+ Plant" line, or a material of the Plants or
//     Planting package kind (Supplies says which kind an item is);
//   - what was bought for it (Tracking's materials, many from receipts) and
//     Materials to Order: a Plants item in Supplies, or a line that reads like
//     a plant ("Limelight hydrangea #3 pot", "Autumn Blaze maple 2" cal");
//   - the Planting service.
// Jonah can say Yes or No by hand on the Job tab (job `plants`: 'yes' | 'no';
// '' = worked out), and that always wins. The answer is kept on the job as
// `hasPlants`, worked out again at every save (app.js getJobData, sync.js
// patchJob), so the server's daily summary reads it without redoing this.
//
// THE CARE EMAIL IS OWED from the moment a job with plants is marked Complete
// -- `completedAt`, stamped however it was finished (the status on the Job
// tab, a move on the Jobs board, anything else through sync.js patchJob) --
// until Claude has drafted it (`careEmail`, functions/care.py) or Jonah says
// he sent it himself or it isn't needed (`careDone` {how: 'self' |
// 'notNeeded', at, by}). Until then the job says "🌱 Care email owed" on the
// Job tab, its Jobs-board card, the job list and All Jobs, and the owner's
// morning and evening summaries list it (functions/digest.py).
//
// A job finished before this existed has no completedAt and owes nothing --
// otherwise every planting job from the summer would light up at once. "It
// still needs one" on such a job starts it owing.
//
// Only people who may see jobs ever see any of this (the crew never get jobs
// at all); only people who may change jobs get the buttons.

(function () {
  'use strict';

  const el = id => document.getElementById(id);
  const sees = () => typeof ydCan === 'function' && ydCan('jobs', 'see');
  const changes = () => typeof ydCan === 'function' && ydCan('jobs', 'change');
  const safe = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const key = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const statusOf = d => (typeof normStatus === 'function' ? normStatus(d.jobStatus, d) : (d.jobStatus || 'quoting'));

  // -------------------------------------------------- does it have plants?

  // A line that reads like a plant: a plant's name, or a nursery size (a
  // caliper, balled and burlapped, a numbered pot). Kinds of tree that are
  // also mulch or lumber (pine, cedar, oak, fir) are left out -- "pine bark
  // mulch" is not a plant.
  const PLANT_WORDS = new RegExp('\\b(' + [
    'plants?(?!\\s*(?:food|mix|starter|soil|fert))', 'trees?', 'shrubs?', 'bush(?:es)?(?!\\s*hog)',
    'perennials?', 'annuals', 'evergreens?', 'arborvitaes?', 'hydrangeas?', 'hostas?', 'boxwoods?', 'junipers?',
    'yews?', 'spir(?:a|e)eas?', 'lilacs?', 'day ?lil(?:y|ies)', 'viburnums?', 'dogwoods?', 'redbuds?',
    'serviceberr(?:y|ies)', 'ninebarks?', 'weigelas?', 'forsythias?', 'barberr(?:y|ies)', 'potentillas?',
    'sedums?', 'coneflowers?', 'salvias?', 'catmint', 'holly', 'hollies', 'rhododendrons?', 'azaleas?',
    'ornamental grass(?:es)?', 'maples?', 'birch(?:es)?', 'lindens?', 'honey ?locusts?', 'spruces?', 'magnolias?',
    'crab ?apples?', 'hemlocks?', 'lavender', 'peon(?:y|ies)', 'black[- ]eyed susans?', 'astilbes?', 'heucheras?',
    'coral ?bells', 'ferns?', 'roses',
  ].join('|') + ')\\b', 'i');
  const PLANT_SIZES = /(^|[^a-z])(b\s*&\s*b|\d+(\.\d+)?\s*("|in\.?|inch(es)?)?\s*cal(iper)?|#\s*\d+\s*(pot|cont(ainer)?)|\d+\s*gal(lon)?\.?\s*(pot|cont(ainer)?)|container[- ]grown)([^a-z]|$)/i;
  // Things for plants, not plants: "tree & shrub fertilizer", "tree
  // watering bag", "shrub rake", "tree removal".
  const FOR_PLANTS = /\b(fertili[sz]er|food|mulch|soil|mix|stakes?|staking|bags?|rings?|guards?|wrap|spray|killer|seed|edging|fabric|rake|pruners?|shears|saw|removal|grind(ing)?|stump)\b/i;
  // Wood, not trees: "2x4x8 Spruce Pine Fir stud", "birch plywood", "maple
  // board" -- a deck job is not a planting job.
  const LUMBER = /\b(\d+\s*x\s*\d+|lumber|plywood|ply|osb|studs?|boards?|planks?|joists?|beams?|posts?|timbers?|veneer|dowels?|decking|trim|moulding|molding|spf|kiln[- ]dried|pressure[- ]treated|treated|furring|lath)\b/i;
  function readsLikePlant(text) {
    const t = String(text || '');
    return !!t.trim() && (PLANT_WORDS.test(t) || PLANT_SIZES.test(t)) && !FOR_PLANTS.test(t) && !LUMBER.test(t);
  }
  const isPlantKind = k => ['plant', 'plants'].indexOf(key(k)) !== -1;
  const isPlantingKind = k => ['planting', 'plantingpackage'].indexOf(key(k)) !== -1;

  // Supplies: the items, and the names and item numbers of its Plants items,
  // worked out again only when the list changes size.
  let plantIndex = null;
  function supplies() {
    const c = window.YDSupplies && window.YDSupplies.catalog ? window.YDSupplies.catalog() : null;
    const items = (c && c.items) || {};
    const ids = Object.keys(items);
    if (!plantIndex || plantIndex.n !== ids.length || plantIndex.items !== items) {
      const names = new Set(), skus = new Set();
      ids.forEach(id => {
        const it = items[id];
        if (!it || !isPlantKind(it.category)) return;
        [it.name].concat(String(it.also || '').split(/[;,]/)).map(key).filter(Boolean).forEach(n => names.add(n));
        if (it.sku) skus.add(key(it.sku));
      });
      plantIndex = { n: ids.length, items: items, names: names, skus: skus };
    }
    return { items: items, loaded: ids.length > 0, names: plantIndex.names, skus: plantIndex.skus };
  }

  // What says this job has plants: { yes, why: [plain words], unsure,
  // estPlants }. `unsure`: Supplies has not arrived yet and could have said
  // more (an item's kind), so a yes saved earlier is kept for now. `estPlants`:
  // the estimate's named "+ Plant" lines and Plants items, which are what
  // Claude writes the email from (care.py plants_of, supply_plants).
  function found(d) {
    const out = { yes: false, why: [], unsure: false, estPlants: 0 };
    if (!d) return out;
    const sup = supplies();
    const mats = ((d.estimate || {}).materials) || [];
    let onEst = 0, planting = 0;
    (Array.isArray(mats) ? mats : []).forEach(m => {
      if (!m) return;
      const it = m.supplyId ? sup.items[m.supplyId] : null;
      if (m.supplyId && !sup.loaded) out.unsure = true;
      const name = String(m.name || (it && it.name) || '').trim();
      // An empty "+ Plant" line just added is not a plant yet.
      if (m.plant) { if (name) { onEst++; out.estPlants++; } return; }
      const kind = (it && it.category) || m.category || '';
      // A Plants item picked from Supplies: care.py writes about these too.
      if (isPlantKind(kind)) { onEst++; if (name) out.estPlants++; }
      else if (isPlantingKind(kind)) planting++;
      else if (readsLikePlant(name)) onEst++;
    });
    if (onEst) out.why.push(onEst === 1 ? 'a plant on the estimate' : onEst + ' plant lines on the estimate');
    if (planting) out.why.push('the planting package on the estimate');

    // A line bought or to be ordered: a Plants item in Supplies (by item
    // number or name), else its words.
    const bought = [];
    const looksBought = (name, sku, supplyId) => {
      const it = supplyId ? sup.items[supplyId] : null;
      if (it) return isPlantKind(it.category);
      if (sup.loaded && ((sku && sup.skus.has(key(sku))) || sup.names.has(key(name)))) return true;
      if (readsLikePlant(name)) return true;
      if (!sup.loaded && (supplyId || String(name || '').trim())) out.unsure = true;
      return false;
    };
    (Array.isArray(d.materials) ? d.materials : []).forEach(e => {
      if (e && looksBought(e.item, e.itemNo, null)) bought.push(String(e.item || '').trim());
    });
    let ordered = 0;
    (Array.isArray(d.orderItems) ? d.orderItems : []).forEach(it => {
      // From the estimate: already counted there.
      if (it && !it.fromEstimate && looksBought(it.name, null, it.supplyId)) ordered++;
    });
    if (bought.length) out.why.push('bought: ' + bought.slice(0, 2).join(', ') + (bought.length > 2 ? ' +' + (bought.length - 2) + ' more' : ''));
    if (ordered) out.why.push('plants on Materials to Order');
    if ((Array.isArray(d.serviceTypes) ? d.serviceTypes : []).some(s => /\bplanting\b/i.test(String(s || '')))) {
      out.why.push('the Planting service');
    }
    out.yes = out.why.length > 0;
    return out;
  }

  // The answer: his own Yes or No, else what was found -- or, while Supplies
  // is still loading and nothing certain was found, the yes saved before.
  function has(d) {
    if (!d) return false;
    if (d.plants === 'yes') return true;
    if (d.plants === 'no') return false;
    const f = found(d);
    return f.yes || (f.unsure && d.hasPlants === true);
  }

  // Where the job's care email stands: null (no plants, or not finished),
  // 'owed', 'drafted' (Claude wrote it into his Gmail Drafts), 'self' (he
  // sent it himself), 'notNeeded', or 'old' (finished before care emails were
  // tracked, nothing done about it).
  function state(d) {
    if (!d || statusOf(d) !== 'complete' || !has(d)) return null;
    if (d.careEmail) return 'drafted';
    if (d.careDone && d.careDone.how) return d.careDone.how === 'notNeeded' ? 'notNeeded' : 'self';
    return d.completedAt ? 'owed' : 'old';
  }
  const owed = d => state(d) === 'owed';

  // What a change made without the form (sync.js patchJob) must also carry:
  // when the job was finished, and whether it has plants now. Put on the
  // patch itself, so a form open with typing in it takes them too (its next
  // save rebuilds the job from its own fields).
  function patchExtras(data, patch) {
    const extra = {};
    if (patch.jobStatus === 'complete' && statusOf(data) !== 'complete') extra.completedAt = new Date().toISOString();
    const after = Object.assign({}, data, patch, extra);
    extra.hasPlants = has(after);
    return extra;
  }

  // ----------------------------------------------------------- the pieces

  const when = s => {
    const t = new Date(s);
    return isNaN(t) ? '' : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const badge = d => has(d) ? ' <span class="plant-badge" title="This job has plants">🌱</span>' : '';
  const owedChip = d => owed(d) ? ' <span class="care-chip">🌱 Care email owed</span>' : '';

  // The buttons that settle it, for a job not open on the Job tab as much as
  // for one that is.
  function settleButtons(jobId) {
    if (!changes()) return '';
    const id = safe(jobId);
    return '<button class="btn btn-sm" onclick="careMark(\'' + id + '\', \'self\')">✓ Sent it myself</button>' +
      '<button class="btn btn-sm" onclick="careMark(\'' + id + '\', \'notNeeded\')">Not needed for this job</button>';
  }

  // The Jobs board card's sheet (boards.js openJobCard).
  function sheetHtml(jobId, d) {
    if (!sees()) return '';
    const s = state(d);
    if (s === 'owed') {
      // Claude writes it from the estimate's plants (care.py), when it has some.
      const how = !changes() ? ''
        : found(d).estPlants > 0 ? ' Open the job to have Claude write it, or:' : ' Send it yourself, then:';
      return '<div class="care-sheet owed">🌱 <b>Plant-care email owed</b> — finished ' + esc(when(d.completedAt)) + '.' + how +
        (changes() ? '<div class="field-actions">' + settleButtons(jobId) + '</div>' : '') + '</div>';
    }
    if (s === 'drafted') return '<div class="care-sheet">🌱 Plant-care email drafted ' + esc(when(d.careEmail.at)) + '.</div>';
    if (s === 'self') return '<div class="care-sheet">🌱 Plant-care email sent by you ' + esc(when(d.careDone.at)) + '.</div>';
    if (s === 'notNeeded') return '<div class="care-sheet">🌱 No plant-care email needed for this job.</div>';
    return has(d) ? '<div class="care-sheet">🌱 This job has plants.</div>' : '';
  }

  // Above All Jobs: every finished job still owing one, whatever the filters.
  function owedNoteHtml(jobs) {
    if (!sees()) return '';
    const list = (jobs || []).filter(owed)
      .sort((a, b) => String(a.completedAt || '').localeCompare(String(b.completedAt || '')));
    if (!list.length) return '';
    return '<div class="care-note">🌱 <b>Plant-care email owed</b> (' + list.length + '): ' +
      list.map(d => '<button class="link-btn" onclick="loadJob(\'' + safe(d._id) + '\')">' +
        (typeof jobNameHtml === 'function' ? jobNameHtml(d.customerName, String(d.estimateNumber || '').trim()) : esc(d.customerName || 'Untitled')) +
        '</button>').join(', ') + '</div>';
  }

  // ------------------------------------------------------- the Job tab

  // The job on the Job tab as it stands, typing included.
  function openJob() {
    if (typeof getJobData !== 'function') return null;
    try { return getJobData(); } catch (e) { return null; }
  }
  let shownKey = '';
  function refresh() {
    const banner = el('careBanner'), why = el('plantsWhy'), auto = el('plantsAutoOpt'), head = el('plantsHeadBadge');
    if (!banner && !why) return;
    const d = sees() ? openJob() : null;
    if (!d) {
      if (banner) { banner.hidden = true; banner.innerHTML = ''; }
      if (head) head.hidden = true;
      return;
    }
    const f = found(d), yes = has(d);
    if (auto) auto.textContent = 'Auto — ' + (f.yes || (f.unsure && d.hasPlants === true) ? 'has plants' : 'no plants found');
    if (why) {
      why.textContent = d.plants === 'yes' ? 'Set by you: this job has plants'
        : d.plants === 'no' ? 'Set by you: no plants — no care email asked for'
        : f.yes ? 'Found: ' + f.why.join(' · ') : f.unsure && d.hasPlants === true ? 'Supplies still loading…' : '';
    }
    if (head) head.hidden = !yes;
    if (!banner) return;
    const s = state(d);
    // The estimate's own plant-care line follows when where it stands
    // changes (finished, settled, set to No plants) -- not at every key.
    const now = [typeof currentJobId !== 'undefined' ? currentJobId : '', s, d.plants, statusOf(d)].join('|');
    if (now !== shownKey) { shownKey = now; redrawEstimateCare(); }
    banner.hidden = !s;
    banner.className = 'care-banner' + (s === 'owed' ? ' owed' : '');
    if (!s) { banner.innerHTML = ''; return; }
    const id = (typeof currentJobId !== 'undefined' && currentJobId) || '';
    const write = changes() && f.estPlants > 0
      ? '<button class="btn btn-sm btn-filled" onclick="estCareEmail()">✨ Write it now</button>' : '';
    const undo = changes() ? ' <button class="link-btn" onclick="careUndo(\'' + safe(id) + '\')">Undo</button>' : '';
    if (s === 'owed') {
      banner.innerHTML = '<span>🌱 <b>Plant-care email owed.</b> This job has plants and was finished ' + esc(when(d.completedAt)) + '.' +
        (changes() && !f.estPlants ? ' <span class="muted">Claude writes it from the estimate’s “+ Plant” lines and Plants items, and this job has none — send it yourself.</span>' : '') +
        '</span><span class="care-btns">' + write + settleButtons(id) + '</span>';
    } else if (s === 'old') {
      banner.innerHTML = '<span>🌱 This job has plants and was finished before care emails were tracked.</span>' +
        (changes() ? '<span class="care-btns"><button class="btn btn-sm" onclick="careStillNeeded(\'' + safe(id) + '\')">It still needs one</button></span>' : '');
    } else if (s === 'drafted') {
      banner.innerHTML = '<span>🌱 Plant-care email drafted ' + esc(when(d.careEmail.at)) + ' — in your Gmail Drafts to read and send.</span>';
    } else if (s === 'self') {
      banner.innerHTML = '<span>🌱 Plant-care email sent by you' + (d.careDone.at ? ' ' + esc(when(d.careDone.at)) : '') + '.' + undo + '</span>';
    } else {
      banner.innerHTML = '<span>🌱 No plant-care email needed for this job' + (d.careDone.at ? ' (' + esc(when(d.careDone.at)) + ')' : '') + '.' + undo + '</span>';
    }
  }
  // Typing changes the job a little at a time: worked out again once it
  // pauses, not at every key.
  let soon = null;
  function refreshSoon() { clearTimeout(soon); soon = setTimeout(refresh, 500); }

  // His Yes / No / Auto on the Job tab (a form field, saved with the job).
  window.plantsPicked = function () {
    if (typeof markDirty === 'function') markDirty();
    refresh();
  };
  function redrawEstimateCare() {
    if (window.YDEstimate && window.YDEstimate.redrawCare) window.YDEstimate.redrawCare();
  }

  function myName() {
    const own = window.YDRemind && YDRemind.me && YDRemind.me();
    const u = window.YDAuth && window.YDAuth.user;
    return (own && own.name) || (u && (u.displayName || u.email)) || '';
  }
  // The job settled or changed without the form, like a board move: the
  // same path, so every device, the lists and an open form all follow.
  function patch(jobId, fields, done) {
    if (!changes()) { showToast('You can look at jobs but not change them'); return false; }
    // Never saved yet (it can only be the job on the form): saved first.
    if (!jobId && typeof autosave === 'function') { autosave(); jobId = currentJobId; }
    if (!jobId || !window.YDSync || !window.YDSync.patchJob(jobId, fields)) { showToast('Could not save that'); return false; }
    refresh();
    if (done) showToast(done);
    return true;
  }
  const nameOf = jobId => {
    let d = null;
    try { d = JSON.parse(readJobBlob(jobId) || 'null'); } catch (e) {}
    return (d && String(d.customerName || '').trim()) || 'This job';
  };
  window.careMark = function (jobId, how) {
    if (how !== 'self' && how !== 'notNeeded') return;
    const ok = patch(jobId, { careDone: { how: how, at: new Date().toISOString(), by: myName() } },
      how === 'self' ? '🌱 Marked sent — ' + nameOf(jobId) + ' owes no care email now'
        : '🌱 ' + nameOf(jobId) + ' — no care email needed');
    // From the Jobs board's sheet: its buttons are spent.
    const m = el('boardModal');
    if (ok && m && m.classList.contains('active') && typeof closeBoardModal === 'function') closeBoardModal();
  };
  window.careUndo = function (jobId) {
    patch(jobId, { careDone: null }, '🌱 The care email is owed again');
  };
  window.careStillNeeded = function (jobId) {
    patch(jobId, { completedAt: new Date().toISOString() }, '🌱 The care email is owed — it is on your summaries until it is done');
  };

  // Redrawn when the job on the form may have changed under it: another
  // device, a board move, the care email drafted, Supplies arriving.
  document.addEventListener('yd-jobs-changed', refreshSoon);
  // Supplies changes items in place (a rename, a new "also called", one
  // moved into or out of Plants): the plant names are worked out again.
  document.addEventListener('yd-supplies', () => { plantIndex = null; refreshSoon(); });
  document.addEventListener('yd-auth', refreshSoon);

  // Every change on the form (markDirty) -- the estimate's lines, materials,
  // the services -- can change the answer. Wrapped, as sync.js wraps saves,
  // so app.js need not know.
  if (typeof window.markDirty === 'function') {
    const _markDirty = window.markDirty;
    window.markDirty = function () {
      const r = _markDirty.apply(this, arguments);
      refreshSoon();
      return r;
    };
  }

  window.YDPlants = {
    found: found,
    has: has,
    state: state,
    owed: owed,
    patchExtras: patchExtras,
    badge: badge,
    owedChip: owedChip,
    sheetHtml: sheetHtml,
    owedNoteHtml: owedNoteHtml,
    refresh: refresh,
    readsLikePlant: readsLikePlant,
  };
})();
