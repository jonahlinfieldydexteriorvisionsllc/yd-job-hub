// Which Supplies item a material written in words is -- "Road gravel: 2.25
// Tons" off a QuickBooks estimate, "Contours pavers" on an order list.
//
// Jonah (15 Oct 2026), on a job brought in from QuickBooks: "a fuckload of materials on his
// list that are literally in the supplies list it says 'no price' add to
// supplies". Names were matched only when every word was spelled the same
// and the unit was the item's own, or (on the order list) only when the
// whole name was identical. So:
//   - words are compared as words: plurals, punctuation, a one-letter typo
//     ("Countours") and the notes after a dash or in brackets don't matter;
//   - every item he picks for a name is remembered (settings/supplyAliases),
//     so his words ("leveling sand" -> Torpedo sand) find it by themselves
//     from then on, on every job;
//   - an item is joined by itself only when it is the ONE that fits (all the
//     words, a unit it is sold or measured in). When several fit (Contours
//     6cm or XL; three grass seed mixes) or only some of the words do, the
//     likely ones are offered as buttons -- "add to Supplies" is only for a
//     material nothing in Supplies is close to.
//
// Jonah again (15 Oct 2026, night): five materials on a job "say not in
// supplies even though ... MDS" has them -- his estimate says "4.5oz barrier
// fabric", "Fabric pins", "Garden blend soil", "Straw erosion control blanket
// 4x50", "Grass seed"; Supplies says "Needle punch fabric 4.5 oz", "Steel
// fabric staples", "Garden mix (compost/topsoil blend)", "Straw erosion
// blanket 4'×50'", "Madison Parks grass seed 50 lb". People in the trade
// write the same thing many ways, so a name is now read the way he would:
//   - sizes and weights are numbers, however written: 4x50 = 4'×50' = 4 x 50,
//     4.5oz = 4.5 oz. A size that disagrees (4x50 against 8'×112.5') rules
//     the item out; one that agrees puts it first;
//   - a word inside a longer one counts (soil in topsoil), and so do two
//     words run together (top soil = topsoil);
//   - a short list of trade words that mean the same thing (barrier fabric,
//     pins and staples, blend and mix, bark and mulch);
//   - words that only describe ("control", "premium", "contractor") count
//     for little, and what the thing IS (the last word: fabric, soil,
//     blanket) counts double.
// Joining by itself stays strict -- a wrong join is worse than a tap: only
// the one item with every real word spelled out and a unit that fits.
//
// Jonah (26 Oct 2026), on a job from QuickBooks: "items in her job we get
// from mds that arent linked". 14 of its 15 materials were in Supplies
// and none joined: "Rochester Concrete Products Reno Pavers" (Supplies: "Reno
// 6cm paver"), "Polymeric Jointing Sand — Beige" (three colours fit; the one
// word that told them apart was after the dash, and notes were dropped),
// "Techniseal Structure Bond Adhesive: 2 canisters" ("Structurebond foam
// adhesive", by the can), "Grand Fire Pit Kit, Four-Layer" ("Grand fire pit,
// 4 layers"). So:
//   - a maker's name says who makes it, not what it is: never needed for a
//     join, only used to choose between items that all fit (MAKERS);
//   - when several items fit, the notes choose -- a colour after a dash, a
//     word in brackets -- if they name exactly one of them;
//   - two of his words run together are one of the item's ("structure bond"
//     = structurebond), as one of his can be two of the item's;
//   - counts are numbers however written (four-layer = 4 layers), and a
//     count that disagrees rules an item out like a size does;
//   - a can is a canister, and a bag, can or pail of a thing sold each is
//     one of it.
// And a job's materials are joined again whenever this gets better
// (estimate.js LINK_V), not only once when the job comes in.
// Plain code: no Claude call.
(function () {
  'use strict';

  const STOP = ['the', 'a', 'an', 'and', 'of', 'for', 'with', 'in', 'x', 'per', 'or', 'to', 'approx', 'approximately', 'about'];
  // What a quantity is written in -- never a word of the name.
  const UNIT_WORDS = ['ton', 'tons', 'yard', 'yards', 'yd', 'yds', 'cu', 'cubic', 'sq', 'ft', 'square', 'feet', 'foot', 'lf',
    'linear', 'lb', 'lbs', 'pound', 'pounds', 'bag', 'bags', 'pc', 'pcs', 'piece', 'pieces', 'each', 'ea', 'roll', 'rolls',
    'pallet', 'pallets', 'gal', 'gallon', 'gallons', 'box', 'boxes', 'bundle', 'bundles', 'oz', 'cm', 'mm'];
  const OLD_UNIT_WORDS = UNIT_WORDS.slice(0, -3);
  // Words that say what kind or how good, not what the thing is. "Kit" says
  // how it comes ("Grand fire pit kit" is the fire pit).
  const FILLER = ['control', 'premium', 'quality', 'grade', 'heavy', 'duty', 'commercial', 'contractor', 'standard',
    'regular', 'bulk', 'bagged', 'light', 'pro', 'professional', 'select', 'new', 'brand', 'kit'];
  // Who makes it. His estimates name the maker; Supplies mostly names only
  // the product ("Reno 6cm paver", "Structurebond foam adhesive"). Longest
  // first, so "rochester concrete products" goes before "rochester".
  const MAKERS = ['rochester concrete products', 'rochester concrete', 'rochester', 'rcp', 'county materials', 'techniseal',
    'techo-bloc', 'techo bloc', 'belgard', 'unilock', 'versa-lok', 'versa lok', 'alliance', 'gator', 'nds', 'necessories',
    'borgert', 'quikrete', 'sakrete', 'dewitt', 'oatey', 'border concepts', 'vigoro', 'scotts', 'pennington']
    .sort((a, b) => b.length - a.length);
  // A bag, can or pail of a thing sold each is one of it.
  const ONE_EACH = ['bag', 'can', 'pail', 'bucket', 'tube', 'jug', 'bottle', 'cartridge', 'kit'];
  // Trade words for the same thing (after plurals come off). Each way round.
  const SAME = [['barrier', 'fabric'], ['geotextile', 'fabric'], ['pin', 'staple'], ['blend', 'mix'], ['bark', 'mulch'],
    ['edging', 'edge'], ['poly', 'polymeric'], ['stake', 'spike'], ['seed', 'seeding'], ['stone', 'rock'],
    ['flagstone', 'flag'], ['weed', 'landscape']];
  const SYN = {};
  SAME.forEach(([a, b]) => { (SYN[a] = SYN[a] || []).push(b); (SYN[b] = SYN[b] || []).push(a); });

  const plural = w => (w.length > 3 && /[a-z]s$/.test(w) && !/ss$/.test(w)) ? w.slice(0, -1) : w;
  function words(s) {
    return String(s || '').toLowerCase()
      .replace(/[”″"]/g, ' in ').replace(/[^a-z0-9.]+/g, ' ').split(' ')
      .map(w => w.replace(/\.+$/, '').replace(/^\.+/, ''))
      .filter(w => w && STOP.indexOf(w) === -1 && UNIT_WORDS.indexOf(w) === -1 && !/^\d+(\.\d+)?$/.test(w))
      .map(plural);
  }
  // The name without its notes: "Screened topsoil (1") — finish grading".
  const bare = name => String(name || '').replace(/\s+[—–-]\s.*$/, '').replace(/\([^)]*\)/g, ' ').replace(/:.*$/, '');
  // The key his picks are kept under: the words, then the sizes -- so
  // "Contours 6cm" and "Contours 8cm" are never the same pick.
  function keyOf(name) {
    const sp = specs(bare(name));
    const tail = Object.keys(sp.m).sort().map(k => sp.m[k] + k).concat(sp.sizes);
    return words(sp.rest).concat(tail).join(' ');
  }
  // The key as kept before 16 Oct 2026 (sizes as written), so picks made then
  // still count.
  const oldKeyOf = name => String(bare(name) || '').toLowerCase().replace(/[”″"]/g, ' in ').replace(/[^a-z0-9.]+/g, ' ').split(' ')
    .map(w => w.replace(/\.+$/, '').replace(/^\.+/, ''))
    .filter(w => w && STOP.indexOf(w) === -1 && OLD_UNIT_WORDS.indexOf(w) === -1 && !/^\d+(\.\d+)?$/.test(w))
    .map(plural).join(' ');

  // Sizes and weights out of a name, as numbers: "4x50" / "4'×50'" -> size
  // 4x50; "4.5oz" / "4.5 oz" -> oz 4.5; "50 lb" -> lb 50. rest: the name
  // without them, for the words.
  const MEASURE = { oz: 'oz', lb: 'lb', lbs: 'lb', '#': 'lb', pound: 'lb', pounds: 'lb', cm: 'cm', mm: 'mm', gal: 'gal',
    gallon: 'gal', in: 'in', inch: 'in', '"': 'in', '”': 'in', '″': 'in' };
  // A number as written: 4, 4.5, 3/4, 1-1/2.
  const NUM = /(\d+-\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)/.source;
  const FT_IN = /\s*(?:'|′|’|ft|"|”|″|in)?/.source;
  function n(s) {
    const t = String(s).replace(/,/g, '');
    const f = t.match(/^(?:(\d+)-)?(\d+)\/(\d+)$/);
    const v = f ? (f[1] ? +f[1] : 0) + (+f[3] ? f[2] / f[3] : 0) : parseFloat(t);
    return String(Math.round(v * 1000) / 1000);
  }
  const SIZE_RE = new RegExp(NUM + FT_IN + /\s*[x×X*]\s*/.source + NUM + FT_IN, 'g');
  const MEASURE_RE = new RegExp(NUM + /\s*(oz|lbs?|#|pounds?|cm|mm|gal(?:lons?)?|inch|in(?![a-z])|"|”|″)(?![a-z])/.source, 'gi');
  // How many of something a kit has -- "4 layers", "Four-Layer", "3 courses":
  // the 3-layer fire pit is not the 4-layer one.
  const COUNT_RE = new RegExp(NUM + /\s*-?\s*(layer|course|tier)s?(?![a-z])/.source, 'gi');
  const NUM_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const NUM_WORD_RE = new RegExp('\\b(' + NUM_WORDS.join('|') + ')\\b', 'gi');
  function specs(s) {
    const out = { sizes: [], m: {} };
    let rest = String(s || '').replace(NUM_WORD_RE, w => String(NUM_WORDS.indexOf(w.toLowerCase()) + 1))
      .replace(COUNT_RE, (all, a, k) => { k = k.toLowerCase(); if (out.m[k] === undefined) out.m[k] = n(a); return ' '; })
      .replace(SIZE_RE,
      (all, a, b) => { out.sizes.push(n(a) + 'x' + n(b)); return ' '; });
    rest = rest.replace(MEASURE_RE,
      (all, a, u) => {
        const k = MEASURE[u.toLowerCase()] || MEASURE[u.toLowerCase().replace(/s$/, '')] || (/^gal/i.test(u) ? 'gal' : null);
        if (k && out.m[k] === undefined) out.m[k] = n(a);
        return ' ';
      });
    out.rest = rest;
    return out;
  }
  // -1: they disagree (rules the item out), 0: nothing to compare, else how
  // many agree.
  function specFit(a, b) {
    let agree = 0;
    for (const k of Object.keys(a.m)) {
      if (b.m[k] === undefined) continue;
      if (a.m[k] !== b.m[k]) return -1;
      agree++;
    }
    if (a.sizes.length && b.sizes.length) {
      const flip = z => z.split('x').reverse().join('x');
      if (!a.sizes.some(z => b.sizes.indexOf(z) !== -1 || b.sizes.indexOf(flip(z)) !== -1)) return -1;
      agree++;
    }
    return agree;
  }

  // Two words are the same word: equal, or (5+ letters) one letter added,
  // dropped, changed or swapped -- "countours" is "contours".
  function near(a, b) {
    if (a === b) return true;
    if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) {
      if (a.slice(i + 1) === b.slice(i + 1)) return true;                       // changed
      return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);   // swapped
    }
    const [l, s] = a.length > b.length ? [a, b] : [b, a];
    return l.slice(i + 1) === s.slice(i);                                       // added / dropped
  }
  // How well one word of his is in an item's words: 1 the word itself (or
  // two of its words run together), 0.8 a trade word for the same thing, 0.7
  // inside a longer word (soil in topsoil), else 0. exact: spelled out.
  function credit(w, have) {
    if (have.some(h => near(w, h))) return { c: 1, exact: true };
    for (let i = 0; i + 1 < have.length; i++) if (have[i] + have[i + 1] === w) return { c: 1, exact: true };
    if ((SYN[w] || []).some(s => have.some(h => near(s, h)))) return { c: 0.8 };
    if (w.length >= 4 && have.some(h => h.length > w.length + 2 && (h.indexOf(w) === 0 || h.slice(-w.length) === w))) return { c: 0.7 };
    return { c: 0 };
  }
  // His word i and the one beside it, run together, are one of the item's:
  // "Structure Bond" is "Structurebond", "top soil" is "topsoil". Spelled
  // exactly, and never a lone letter: "flexible T-shaped" run together is
  // one letter off "flexible", which the L-shaped edging has too.
  function runTogether(want, i, have) {
    const pairs = [];
    if (i + 1 < want.length && want[i].length > 1 && want[i + 1].length > 1) pairs.push(want[i] + want[i + 1]);
    if (i > 0 && want[i - 1].length > 1 && want[i].length > 1) pairs.push(want[i - 1] + want[i]);
    return pairs.some(p => have.indexOf(p) !== -1);
  }

  // The makers named in some words, as words ("rochester concrete product").
  const flat = s => ' ' + String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  function makerWords(name) {
    let t = flat(name);
    const out = [];
    MAKERS.forEach(p => {
      const f = flat(p);
      if (t.indexOf(f) === -1) return;
      t = t.split(f).join(' ');
      words(p).forEach(w => { if (out.indexOf(w) === -1) out.push(w); });
    });
    return out;
  }

  // One unit, however it is written: "sq. ft" = "sf", "Tons" = "ton".
  function unitKey(u) {
    const s = String(u || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
    const table = [[/^(each|ea|pc|pcs|piece|pieces|unit|units)$/, 'each'], [/^(sq ?ft|sf|square f(ee|oo)t)$/, 'sqft'],
      [/^(lf|lin ?ft|linear ?ft|linear f(ee|oo)t|ft|feet|foot)$/, 'lf'], [/^(tons?|t)$/, 'ton'],
      [/^(yards?|yds?|cu ?yds?|cubic yards?)$/, 'yd'], [/^(cu ?ft|cubic f(ee|oo)t)$/, 'cuft'], [/^(gal|gallons?)$/, 'gal'],
      [/^(lbs?|pounds?|#)$/, 'lb'], [/^(bags?)$/, 'bag'], [/^(rolls?)$/, 'roll'], [/^(cans?|canisters?)$/, 'can'],
      [/^(days?|daily|per day|day rate)$/, 'day']];
    const hit = table.find(([re]) => re.test(s));
    return hit ? hit[1] : s.replace(/s$/, '');
  }
  const num = v => { const x = parseFloat(v); return isFinite(x) ? x : null; };

  // A bag (or box, pail) sold by weight: how many pounds one holds -- the
  // item's own "Bag weight" in Supplies, else read off its name ("Madison
  // Parks grass seed 50 lb"). Nothing for an item sold by the pound itself.
  // part: priced by the part of it used, the rest kept for the next job
  // (Jonah, 15 Oct 2026: "we always buy the biggest bag of grass seed so
  // pricing should be based off of the cost per lb of that bag") -- the
  // item's own tick, else on for seed.
  function pack(it, pr) {
    if (!it) return { lb: null, part: false };
    const sold = unitKey((pr && pr.per) || it.unit);
    const own = num(it.packLb);
    const lb = sold === 'lb' ? null : own > 0 ? own : packFromName(it.name);
    // Ticked (or not) on the item wins; untouched, seed in a bag of known
    // weight is.
    const part = typeof it.partUse === 'boolean' ? it.partUse : !!(lb && partByKind(it));
    return { lb: lb > 0 ? lb : null, part: part };
  }
  function packFromName(name) {
    const lb = specs(name).m.lb;
    return lb !== undefined && num(lb) > 0 ? num(lb) : null;
  }
  // Seed is the one kind bought big and used a bit at a time by default; any
  // other item can be ticked so in Supplies.
  const partByKind = it => String(it.category || '').toLowerCase() === 'seed';

  // ------------------------------------------------------------- grass seed
  //
  // Jonah (22 Oct 2026): "grass seed in jobs is always madison park priced
  // from the largest bag size unless otherwise specified". Which seed is his
  // usual one is his to set (Pricing rules -> Materials: pricing/rules
  // .seed.supplyId); the code only knows what grass seed is, that a name like
  // "Grass seed" names none in particular, and that seed is bought in its
  // biggest bag. Claude had put the 5 lb bag on two estimates: $5.04 a pound
  // where the 50 lb bag he buys is $4.14.
  const SEED_WORDS = ['seed', 'seeding', 'overseed', 'overseeding', 'reseed', 'reseeding'];
  // Words that say only "grass seed", never which one.
  const PLAIN_SEED = SEED_WORDS.concat(['grass', 'lawn', 'turf', 'mix', 'blend', 'quality', 'premium', 'standard',
    'regular', 'bulk', 'bagged', 'new']);
  // "Grass seed", "Lawn seed mix", "Grass seed — front yard": a seed named by
  // nothing but those words, so his usual one is it.
  function plainSeed(name) {
    const ws = words(specs(bare(name)).rest);
    return ws.some(w => SEED_WORDS.indexOf(w) !== -1) && ws.every(w => PLAIN_SEED.indexOf(w) !== -1);
  }
  // A Supplies item that is grass seed: of the seed kind, and seed by what
  // it is (the last word of its name: seed, mix) -- not the straw blanket,
  // the straw bale or the seed-starter fertiliser filed beside it.
  function isGrassSeed(it) {
    if (!it || String(it.category || '').toLowerCase() !== 'seed') return false;
    const ws = itemInfo(it).bareWords;
    return ws.length > 0 && ['seed', 'seeding', 'mix', 'blend'].indexOf(ws[ws.length - 1]) !== -1;
  }
  // One product in its several bag sizes: the same supplier and the same
  // words once the sizes are out ("Madison Parks grass seed" 5, 20, 50 lb).
  const famOf = it => (it.vendorId || '') + '|' + itemInfo(it).nameWords.join(' ');
  // The biggest bag of the product an item is -- itself when it is not
  // bought by the bag and used a bit at a time, or is the biggest already.
  // Priced bags only, where prices can be seen.
  function biggestBag(id, cat) {
    const it = cat && cat.items ? cat.items[id] : null;
    if (!it) return id;
    const prices = cat.prices || {};
    const p = pack(it, prices[id]);
    if (!p.part || !p.lb) return id;
    const seesPrices = Object.keys(prices).length > 0;
    const fam = famOf(it);
    let best = id, lb = p.lb;
    Object.keys(cat.items).forEach(k => {
      const o = cat.items[k];
      if (k === id || !o || famOf(o) !== fam) return;
      if (seesPrices && !(prices[k] && num(prices[k].cents) > 0)) return;
      const q = pack(o, prices[k]);
      if (q.part && q.lb > lb) { best = k; lb = q.lb; }
    });
    return best;
  }
  // His usual grass seed, in its biggest bag; null until he sets one.
  function usualSeed(cat) {
    const r = window.YDPricing && window.YDPricing.rules ? window.YDPricing.rules() : null;
    const id = r && r.seed ? r.seed.supplyId : null;
    if (!id || !cat || !cat.items || !cat.items[id]) return null;
    return biggestBag(id, cat);
  }
  // Whether his words name an item: the first word of its name that says
  // which one it is -- its brand ("shady", "quick", "pennington"); "shade"
  // is near enough to "shady". Grass, seed, mix and sizes say nothing.
  function namedIn(it, text) {
    const own = itemInfo(it).bareWords.filter(w => PLAIN_SEED.indexOf(w) === -1 && FILLER.indexOf(w) === -1);
    if (!own.length) return false;
    return words(text).some(w => near(w, own[0]));
  }

  // A material's quantity in what the item is measured in for estimates (its
  // takeoff unit when it covers an area, else what it is sold by): as it is,
  // or -- given in what the item is sold by -- times what one covers; or in
  // pounds, for a bag whose weight is known. Null when the units don't meet
  // ("100 lb" of something sold by the bag with no weight known).
  function fitQty(m, it, pr) {
    const cov = num(it.coverage) > 0 ? num(it.coverage) : null;
    const sold = unitKey((pr && pr.per) || it.unit);
    const measured = cov ? unitKey(it.takeoffUnit) : sold;
    const u = unitKey(m.unit), q = num(m.qty);
    const unit = cov ? String(it.takeoffUnit || '') : String((pr && pr.per) || it.unit || '');
    if (u === measured || (!u && measured === 'each') || (measured === 'each' && ONE_EACH.indexOf(u) !== -1)) return { qty: q, unit: unit };
    if (cov && (u === sold || (!u && sold === 'each'))) return { qty: q === null ? null : Math.round(q * cov * 1000) / 1000, unit: unit };
    // "Grass seed: 3 lb" of a 50 lb bag: kept in pounds (pricing.js works
    // the bags from the bag's weight).
    if (u === 'lb' && pack(it, pr).lb) return { qty: q, unit: 'lb' };
    return null;
  }

  // The word is what the item IS, not what it goes with: "fabric" in
  // "Needle punch fabric 4.5 oz" (nothing but a size after it), not in
  // "Fabric pin" (a pin) -- so asked about fabric, the roll comes first.
  function isHeadOf(name, head) {
    const toks = String(name || '').toLowerCase().replace(/[”″"']/g, ' ').split(/[^a-z0-9.]+/).filter(Boolean).map(plural);
    for (let i = 0; i < toks.length; i++) {
      if (!near(toks[i], head) && !(SYN[head] || []).some(s => near(toks[i], s))) continue;
      const next = toks[i + 1];
      if (!next || /^\d/.test(next) || UNIT_WORDS.indexOf(next) !== -1 || /^(oz|in|mm|cm)$/.test(next)) return true;
    }
    return false;
  }

  // A line of WORK written among the materials. A QuickBooks estimate's
  // Material Fee listed "Existing vegetation removal — complete, including
  // root systems 632 sq ft", "Small pine tree removal — ..." and "Bed
  // excavation to 5" depth ..." beside the fabric and the stone, and every
  // one of them went onto the job's Materials to Order (Jonah, 21 Oct 2026:
  // the job's services "listed as to be ordered"). What a thing IS is the
  // last word of its name before any note -- after a dash, a comma, in
  // brackets, or "to / of / with ..." -- (removal, excavation), or the name
  // starts by saying what to do ("Remove the old sod"). Only words that are
  // never something bought count: edging, mulch, seed, planting and rental
  // are things to buy as often as work, so they never do ("Dumpster —
  // spoils removal" is a dumpster). None of the 907 Supplies items read as
  // work (22 Oct 2026). functions/quickbooks.py _reads_as_work is the same rule -- keep
  // the two the same.
  const WORK_HEADS = ['removal', 'excavation', 'extraction', 'demolition', 'demo', 'installation', 'install',
    'grading', 'regrading', 'hauling', 'haul-off', 'cleanup', 'clean-up', 'preparation', 'prep', 'labor', 'labour',
    'tilling', 'rototilling', 'trenching', 'digging', 'compaction', 'aeration', 'dethatching', 'pruning', 'trimming',
    'mowing', 'stripping', 'restoration', 'repair', 'grinding', 'service', 'work'];
  const WORK_VERBS = ['remove', 'excavate', 'install', 'haul', 'dig', 'trench', 'till', 'rototill', 'demolish',
    'extract', 'regrade', 'dethatch', 'aerate', 'prune', 'prep', 'prepare'];
  const NOTE_CUT = /\s[—–-]\s|[,:;(]|\s(?:to|of|for|with|including|below|above|after|before|around|along|at|in|on|from|into|under|behind|and|&)\s/;
  function readsAsWork(name) {
    const lead = String(name || '').toLowerCase().replace(/\([^)]*\)/g, ' ').split(NOTE_CUT)[0];
    const ws = lead.split(/\s+/).map(w => w.replace(/^[^a-z]+|[^a-z-]+$/g, '')).filter(w => /[a-z]/.test(w));
    if (!ws.length) return false;
    if (WORK_VERBS.indexOf(ws[0]) !== -1) return true;
    let head = ws[ws.length - 1];
    if (WORK_HEADS.indexOf(head) === -1 && /s$/.test(head)) head = head.slice(0, -1);
    return WORK_HEADS.indexOf(head) !== -1;
  }

  let aliases = {};           // key (keyOf) -> supply id, his picks
  const itemWords = new Map();  // item -> {name, words, specs}, kept while its name is the same

  function itemInfo(it) {
    const text = String(it.name || '') + ' ' + String(it.also || '');
    const got = itemWords.get(it.id);
    if (got && got.text === text) return got;
    const sp = specs(it.name);
    // nameWords: the name's own, without what it is also called (one
    // product's bag sizes are told apart by them -- famOf); bareWords: and
    // without its notes ("Seed Mix (by the lb)"), for what it is.
    const info = { text: text, words: words(sp.rest + ' ' + String(it.also || '')), nameWords: words(sp.rest),
                   bareWords: words(specs(bare(it.name)).rest), specs: sp, maker: makerWords(it.name) };
    itemWords.set(it.id, info);
    return info;
  }

  // { sure: {id, qty, unit, by} | null, options: [id, ...] } for a material
  // {name, qty, unit}. cat: YDSupplies.catalog(). skip: kinds never offered
  // (tools). Priced items only where prices can be seen.
  // opts.anyUnit: the order list, where a line's unit is only words in its
  // quantity -- the one item with all the words is it, whatever the unit.
  function match(m, cat, skip, opts) {
    const out = { sure: null, options: [] };
    if (!cat || !cat.items) return out;
    skip = skip || [];
    const seesPrices = cat.prices && Object.keys(cat.prices).length > 0;
    const usable = it => it && skip.indexOf(it.category) === -1 &&
      (!seesPrices || (cat.prices[it.id] && num(cat.prices[it.id].cents) > 0));
    const key = keyOf(m.name);
    const wantSpecs = specs(bare(m.name));
    const want = words(wantSpecs.rest);
    if (!want.length) return out;
    // "Grass seed" that names no seed is his usual one (below), whatever was
    // picked for those words on some job before.
    let usual = plainSeed(m.name) ? usualSeed(cat) : null;
    if (usual && !usable(cat.items[usual])) usual = null;
    const mine = usual ? null : aliases[key] || aliases[oldKeyOf(m.name)];
    if (mine && usable(cat.items[mine])) {
      const f = fitQty(m, cat.items[mine], cat.prices && cat.prices[mine]);
      out.sure = { id: mine, qty: f ? f.qty : null, unit: f ? f.unit : '', by: 'yours', unitOff: !f };
      return out;
    }
    const wantSpecN = Object.keys(wantSpecs.m).length + (wantSpecs.sizes.length ? 1 : 0);
    // Who makes it, the describing words ("kit": the fire pit kit, not its
    // coping) and the words of his notes ("— Beige", "(behind wall)"):
    // never needed, but they choose between items that all fit.
    const maker = makerWords(m.name);
    const optional = w => FILLER.indexOf(w) !== -1 || maker.indexOf(w) !== -1;
    const choosing = [];
    want.filter(optional).concat(words(specs(m.name).rest).filter(w => want.indexOf(w) === -1))
      .forEach(w => { if (choosing.indexOf(w) === -1) choosing.push(w); });
    // What it is: the last word that is more than a describing word or a
    // maker (sand, mulch, fabric, blanket). It counts double, and is always
    // needed; describing words and makers a quarter.
    const real = want.filter(w => !optional(w));
    const head = (real.length ? real : want)[(real.length ? real : want).length - 1];
    const weight = w => w === head ? 2 : optional(w) ? 0.25 : 1;
    const total = want.reduce((s, w) => s + weight(w), 0);
    const scored = [];
    Object.values(cat.items).forEach(it => {
      if (!usable(it)) return;
      const info = itemInfo(it);
      // Another maker's: a Belgard paver is not the Rochester one he named.
      if (maker.length && info.maker.length && !info.maker.some(w => maker.indexOf(w) !== -1)) return;
      let got = 0, exact = true, headC = 0;
      want.forEach((w, i) => {
        let c = credit(w, info.words);
        if (!c.exact && runTogether(want, i, info.words)) c = { c: 1, exact: true };
        got += c.c * weight(w);
        if (w === head) headC = c.c;
        if (!c.exact && (w === head || !optional(w))) exact = false;
      });
      if (!got) return;
      const score = got / total;
      if (score < 0.5 && headC < 0.7) return;
      const fit = specFit(wantSpecs, info.specs);
      if (fit < 0) return;                      // 4x50 is not 8x112.5
      const p = pack(it, cat.prices && cat.prices[it.id]);
      // Every real word spelled out, and every size he gave the item's own.
      scored.push({ it: it, full: exact && fit === wantSpecN, pack: p, fam: famOf(it),
                    pick: choosing.filter(w => credit(w, info.words).exact).length,
                    score: score + fit * 0.15 + (isHeadOf(it.name, head) ? 0.2 : 0),
                    extra: info.words.length - want.length });
    });
    // Best first -- among the ones that fit, the one his maker and notes name;
    // the same product in several bag sizes, biggest bag first.
    scored.sort((a, b) => (b.full - a.full) || (a.full ? b.pick - a.pick : 0) || (b.score - a.score) || (a.extra - b.extra) ||
      (a.fam === b.fam ? (b.pack.lb || 0) - (a.pack.lb || 0) : 0) ||
      String(a.it.name).length - String(b.it.name).length);
    // A product bought by the bag and used a bit at a time (seed) is always
    // bought in its biggest bag: the smaller bags of it are never offered.
    const biggest = {};
    scored.forEach(x => {
      if (!x.pack.part || !x.pack.lb) return;
      const b = biggest[x.fam];
      if (!b || (x.pack.lb || 0) > (b.pack.lb || 0)) biggest[x.fam] = x;
    });
    const shown = scored.filter(x => !x.pack.part || !x.pack.lb || biggest[x.fam] === x);
    // His usual seed in its biggest bag is it; the other seeds stay offered
    // after it, for a job that wants another.
    if (usual) {
      const f = fitQty(m, cat.items[usual], cat.prices && cat.prices[usual]);
      out.sure = { id: usual, qty: f ? f.qty : null, unit: f ? f.unit : '', by: 'usual', unitOff: !f };
      out.options = [usual].concat(shown.map(x => x.it.id).filter(id => id !== usual)).slice(0, 4);
      return out;
    }
    // The one that fits -- or, of several, the one his maker or notes name
    // more of than any other ("Polymeric sand — Beige" of three colours).
    const full = shown.filter(x => x.full);
    const win = full.length === 1 || (full.length > 1 && full[0].pick > full[1].pick) ? full[0] : null;
    if (win) {
      const it = win.it, f = fitQty(m, it, cat.prices && cat.prices[it.id]);
      // With no unit to check (the order list, a line with no unit) it joins
      // only a clear winner: "Fabric pins" is not "Fabric pin (light)" while
      // a box of fabric staples is nearly as likely.
      const next = shown.find(x => x !== win);
      const clear = !next || (next.full ? next.pick < win.pick : next.score < win.score - 0.25);
      const unitGiven = !!unitKey(m.unit);
      if (f && (unitGiven || clear)) { out.sure = { id: it.id, qty: f.qty, unit: f.unit, by: 'name' }; return out; }
      if (opts && opts.anyUnit && clear) { out.sure = { id: it.id, qty: null, unit: '', by: 'name', unitOff: true }; return out; }
    }
    out.options = shown.slice(0, 4).map(x => x.it.id);
    return out;
  }

  // His pick, kept for the next time these words come up.
  function remember(name, supplyId) {
    const key = keyOf(name);
    if (!key || !supplyId) return;
    // Another seed picked for plain "grass seed" is for that job (a shady
    // yard); the next job's is his usual one again.
    if (plainSeed(name)) return;
    if (aliases[key] === supplyId) return;
    aliases[key] = supplyId;
    // Every list showing these words takes the pick at once (app.js order list).
    document.dispatchEvent(new CustomEvent('yd-supply-aliases'));
    if (!window.YDDb || !(typeof ydCan === 'function' && ydCan('supplies', 'change'))) return;
    const patch = { map: {}, updatedAt: new Date().toISOString() };
    patch.map[key] = supplyId;
    Promise.resolve(window.YDDb.put('settings', 'supplyAliases', patch))
      .catch(e => console.warn('[match] pick not kept on the server:', e && (e.code || e.message)));
  }

  function load() {
    if (!window.YDDb || !(typeof ydCan === 'function' && ydCan('supplies', 'see'))) return;
    Promise.resolve(window.YDDb.get('settings', 'supplyAliases')).then(d => {
      aliases = Object.assign({}, (d && d.map) || {}, aliases);
      document.dispatchEvent(new CustomEvent('yd-supply-aliases'));
    }).catch(() => {});
  }
  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const k = on ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k === authKey) return;
    authKey = k;
    aliases = {};
    if (on) load();
  });

  window.YDMatch = { match: match, remember: remember, keyOf: keyOf, fitQty: fitQty, unitKey: unitKey, near: near,
                     pack: pack, packFromName: packFromName, partByKind: partByKind, readsAsWork: readsAsWork,
                     plainSeed: plainSeed, isGrassSeed: isGrassSeed, famOf: famOf, biggestBag: biggestBag,
                     usualSeed: usualSeed, namedIn: namedIn };
})();
