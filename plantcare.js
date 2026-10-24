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
    if (!d || statusOf(d) !== 'complete' || !cares(d)) return null;
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
    // Booked just now (or still on Auto since): Plants / Turf written down.
    const settled = decide(after);
    if (settled.plants || settled.turf) {
      Object.assign(extra, settled, { careDecidedAt: new Date().toISOString() });
      Object.assign(after, settled);
    }
    extra.hasPlants = has(after);
    extra.hasTurf = turfHas(after);
    return extra;
  }

  // --------------------------------------------------- does it have turf?
  //
  // Jonah (21 Oct 2026): "turf jobs once completed automatically draft a care
  // email to the client." Turf is artificial turf (the "Artificial Turf"
  // service, priced by the sq ft): worked out the same way, in code, from a
  // labour line's heading, a material, or the job's services -- and his own
  // Yes / No on the Job tab (job `turf`) always wins. Saved as `hasTurf`. One
  // care email per job covers whatever went in: plants, turf, or both
  // (care.py), so `careEmail` / `careDone` / `completedAt` are shared.
  //
  // "Turfstone" pavers, "Turf Builder" fertiliser and turf-type fescue seed
  // are not artificial turf.
  const TURF_WORDS = /\b(artificial|synthetic|fake)\s+(turf|grass|lawn)\b|\bputting\s+greens?\b|\bturf\b/i;
  const NOT_TURF = /\bturf[\s-]*(builder|type)\b|\bfescue\b|\bseed|\bfertili[sz]|\bsod\b|\bweed/i;
  function readsLikeTurf(text) {
    const t = String(text || '');
    return !!t.trim() && TURF_WORDS.test(t) && !NOT_TURF.test(t);
  }
  // { yes, why, estTurf }: estTurf = the estimate's turf lines, which are
  // what Claude writes the turf part of the email from (care.py turf_of).
  function turfFound(d) {
    const out = { yes: false, why: [], estTurf: 0 };
    if (!d) return out;
    const sup = supplies();
    const e = d.estimate || {};
    let work = 0, mats = 0;
    (Array.isArray(e.work) ? e.work : []).forEach(w => { if (w && readsLikeTurf(w.title)) work++; });
    (Array.isArray(e.materials) ? e.materials : []).forEach(m => {
      if (!m) return;
      const it = m.supplyId ? sup.items[m.supplyId] : null;
      if (readsLikeTurf(m.name || (it && it.name))) mats++;
    });
    out.estTurf = work + mats;
    if (work) out.why.push(work === 1 ? 'a turf line on the estimate' : work + ' turf lines on the estimate');
    if (mats) out.why.push(mats === 1 ? 'turf among the materials' : mats + ' turf materials');
    if ((Array.isArray(d.serviceTypes) ? d.serviceTypes : []).some(readsLikeTurf)) out.why.push('the Artificial Turf service');
    out.yes = out.why.length > 0;
    return out;
  }
  function turfHas(d) {
    if (!d) return false;
    if (d.turf === 'yes') return true;
    if (d.turf === 'no') return false;
    return turfFound(d).yes;
  }
  // ------------------------------------- settled the moment it is a job
  //
  // Jonah (23 Oct 2026): "turf and plant status should be decided the moment
  // a job is accepted -- if it has no turf or plants on the scope or in it
  // then mark those as no." So once a bid is booked (any way: the Job tab,
  // the board, QuickBooks accepted) and Plants / Turf are still on Auto, the
  // answer is written down as Yes or No -- from the estimate's lines and
  // materials, the services, what was bought, and the words of its scope.
  // His own pick on the Job tab still changes it at any time. Left on Auto
  // only while there is nothing to judge from yet (a QuickBooks import whose
  // estimate has not been read in) or Supplies is still loading.
  //
  // A scope sentence about taking plants out ("remove the existing shrubs")
  // is not a planting job.
  const TAKING_OUT = /\b(remov\w*|tear(ing)?\s*out|rip(ping)?\s*out|dig(ging)?\s*out|haul\w*|dispos\w*|clear(ing)?|cut(ting)?\s*down|grind\w*|stumps?|trim\w*|prun\w*|existing)\b/i;
  function scopeSays(d, reads) {
    const e = d.estimate || {};
    return (Array.isArray(e.work) ? e.work : []).some(w => w && [w.title].concat(String(w.scope || '').split(/[.\n;•]+/))
      .some(t => reads(t) && !TAKING_OUT.test(String(t || ''))));
  }
  const accepted = d => statusOf(d) !== 'quoting' && !d.removeWhy && !d.deletedAt;
  function judgeable(d) {
    const e = d.estimate || {};
    return (Array.isArray(e.work) && e.work.length > 0) || (Array.isArray(e.materials) && e.materials.length > 0) ||
      (Array.isArray(d.serviceTypes) && d.serviceTypes.length > 0) || (Array.isArray(d.materials) && d.materials.length > 0);
  }
  // { plants?: 'yes'|'no', turf?: 'yes'|'no' } for the answers still on Auto
  // on an accepted job; {} when there is nothing to settle.
  function decide(d) {
    const out = {};
    if (!d || !accepted(d) || !judgeable(d)) return out;
    if (!d.plants) {
      const f = found(d);
      if (!f.unsure) out.plants = f.yes || scopeSays(d, readsLikePlant) ? 'yes' : 'no';
    }
    if (!d.turf) out.turf = turfFound(d).yes || scopeSays(d, readsLikeTurf) ? 'yes' : 'no';
    return out;
  }

  // A care email is owed for this job once it is finished: plants or turf.
  const cares = d => has(d) || turfHas(d);
  // What the email is called for this job.
  function careWord(d) {
    const p = has(d), t = turfHas(d);
    return p && t ? 'Care' : t ? 'Turf-care' : 'Plant-care';
  }
  // Whether Claude has something to write from: plants on the estimate, or
  // turf (its care is the same whatever the product, so a turf job set by
  // hand is enough).
  const canWrite = d => found(d).estPlants > 0 || turfHas(d);

  // ----------------------------------------------------------- the pieces

  const when = s => {
    const t = new Date(s);
    return isNaN(t) ? '' : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const badge = d => (has(d) ? ' <span class="plant-badge" title="This job has plants">🌱</span>' : '') +
    (turfHas(d) ? ' <span class="plant-badge" title="This job has artificial turf">🟩</span>' : '');
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
    const s = state(d), word = careWord(d);
    if (s === 'owed') {
      // Claude writes it from the estimate's plants and the turf (care.py).
      const how = !changes() ? ''
        : canWrite(d) ? ' Open the job to have Claude write it, or:' : ' Send it yourself, then:';
      return '<div class="care-sheet owed">🌱 <b>' + word + ' email owed</b> — finished ' + esc(when(d.completedAt)) + '.' + how +
        (changes() ? '<div class="field-actions">' + settleButtons(jobId) + '</div>' : '') + '</div>';
    }
    if (s === 'drafted') return '<div class="care-sheet">🌱 ' + word + ' email drafted ' + esc(when(d.careEmail.at)) + '.</div>';
    if (s === 'self') return '<div class="care-sheet">🌱 ' + word + ' email sent by you ' + esc(when(d.careDone.at)) + '.</div>';
    if (s === 'notNeeded') return '<div class="care-sheet">🌱 No ' + word.toLowerCase() + ' email needed for this job.</div>';
    return has(d) && turfHas(d) ? '<div class="care-sheet">🌱 This job has plants and artificial turf.</div>'
      : has(d) ? '<div class="care-sheet">🌱 This job has plants.</div>'
      : turfHas(d) ? '<div class="care-sheet">🟩 This job has artificial turf.</div>' : '';
  }

  // Above All Jobs: every finished job still owing one, whatever the filters.
  function owedNoteHtml(jobs) {
    if (!sees()) return '';
    const list = (jobs || []).filter(owed)
      .sort((a, b) => String(a.completedAt || '').localeCompare(String(b.completedAt || '')));
    if (!list.length) return '';
    return '<div class="care-note">🌱 <b>Care email owed</b> (' + list.length + '): ' +
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
    const tWhy = el('turfWhy'), tAuto = el('turfAutoOpt');
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
      why.textContent = d.plants && d.careDecidedAt ? 'Settled when it became a job' + (d.plants === 'yes' ? ': has plants' : ': no plants on its estimate or scope') + ' — change it here'
        : d.plants === 'yes' ? 'Set by you: this job has plants'
        : d.plants === 'no' ? 'Set by you: no plants — no care email asked for'
        : f.yes ? 'Found: ' + f.why.join(' · ') : f.unsure && d.hasPlants === true ? 'Supplies still loading…' : '';
    }
    if (head) head.hidden = !yes;
    const tf = turfFound(d);
    if (tAuto) tAuto.textContent = 'Auto — ' + (tf.yes ? 'has turf' : 'no turf found');
    if (tWhy) {
      tWhy.textContent = d.turf && d.careDecidedAt ? 'Settled when it became a job' + (d.turf === 'yes' ? ': has turf' : ': no turf on its estimate or scope') + ' — change it here'
        : d.turf === 'yes' ? 'Set by you: this job has artificial turf'
        : d.turf === 'no' ? 'Set by you: no turf' : tf.yes ? 'Found: ' + tf.why.join(' · ') : '';
    }
    if (!banner) return;
    const s = state(d);
    // The estimate's own plant-care line follows when where it stands
    // changes (finished, settled, set to No plants) -- not at every key.
    const now = [typeof currentJobId !== 'undefined' ? currentJobId : '', s, d.plants, d.turf, statusOf(d)].join('|');
    if (now !== shownKey) { shownKey = now; redrawEstimateCare(); }
    banner.hidden = !s;
    banner.className = 'care-banner' + (s === 'owed' ? ' owed' : '');
    if (!s) { banner.innerHTML = ''; return; }
    const id = (typeof currentJobId !== 'undefined' && currentJobId) || '';
    const write = changes() && canWrite(d)
      ? '<button class="btn btn-sm btn-filled" onclick="estCareEmail()">✨ Write it now</button>' : '';
    const word = careWord(d), what = has(d) && turfHas(d) ? 'plants and artificial turf' : turfHas(d) ? 'artificial turf' : 'plants';
    const undo = changes() ? ' <button class="link-btn" onclick="careUndo(\'' + safe(id) + '\')">Undo</button>' : '';
    if (s === 'owed') {
      banner.innerHTML = '<span>🌱 <b>' + word + ' email owed.</b> This job has ' + what + ' and was finished ' + esc(when(d.completedAt)) + '.' +
        (changes() && !canWrite(d) ? ' <span class="muted">Claude writes it from the estimate’s “+ Plant” lines and Plants items, and this job has none — send it yourself.</span>' : '') +
        '</span><span class="care-btns">' + write + settleButtons(id) + '</span>';
    } else if (s === 'old') {
      banner.innerHTML = '<span>🌱 This job has ' + what + ' and was finished before care emails were tracked.</span>' +
        (changes() ? '<span class="care-btns"><button class="btn btn-sm" onclick="careStillNeeded(\'' + safe(id) + '\')">It still needs one</button></span>' : '');
    } else if (s === 'drafted') {
      banner.innerHTML = '<span>🌱 ' + word + ' email drafted ' + esc(when(d.careEmail.at)) + ' — in your Gmail Drafts to read and send.</span>';
    } else if (s === 'self') {
      banner.innerHTML = '<span>🌱 ' + word + ' email sent by you' + (d.careDone.at ? ' ' + esc(when(d.careDone.at)) : '') + '.' + undo + '</span>';
    } else {
      banner.innerHTML = '<span>🌱 No ' + word.toLowerCase() + ' email needed for this job' + (d.careDone.at ? ' (' + esc(when(d.careDone.at)) + ')' : '') + '.' + undo + '</span>';
    }
  }
  // Typing changes the job a little at a time: worked out again once it
  // pauses, not at every key.
  let soon = null;
  function refreshSoon() { clearTimeout(soon); soon = setTimeout(refresh, 500); }

  // His Yes / No / Auto on the Job tab (a form field, saved with the job).
  window.plantsPicked = window.turfPicked = function () {
    // Picked by hand now: no longer "settled when it became a job".
    if (typeof boardFields === 'object' && boardFields) boardFields.careDecidedAt = null;
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
    decide: decide,
    badge: badge,
    owedChip: owedChip,
    sheetHtml: sheetHtml,
    owedNoteHtml: owedNoteHtml,
    refresh: refresh,
    readsLikePlant: readsLikePlant,
    // Artificial turf -- the same care email (care.py).
    turfFound: turfFound,
    turfHas: turfHas,
    cares: cares,
    careWord: careWord,
    canWrite: canWrite,
    readsLikeTurf: readsLikeTurf,
  };
})();
