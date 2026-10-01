// Snow — accounts, and the groundwork the storm workflow sits on.
//
// Two collections, deliberately separate (see firestore.rules):
//
//   snowAccounts/{id}            name, address, lat/lng, trigger inches,
//                                service window, area notes  -> crew CAN read
//   snowAccounts/{id}/private/*  tier rates, labour rate, salt, phone, email
//                                                            -> owner only
//
// Firestore grants access per document and never per field, so the only way to
// let crew see the route without seeing the money is to keep them apart. The
// app mirrors that split rather than merging them and hoping the UI hides the
// right things.

(function () {
  'use strict';

  const PRICING_DOC = 'rates';          // snowAccounts/{id}/private/rates

  let accounts = {};                    // id -> public record
  let pricing = {};                     // id -> private record (owner only)
  let unsubAccounts = null;
  let loaded = false;

  // ---------------------------------------------------------------- money

  function cents(c) {
    if (c === null || c === undefined) return '—';
    return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  // A blank tier inherits the next lower one, per the build spec: an account
  // priced only at 1-3 and 4-6 bills the 4-6 rate for anything deeper.
  //
  // An 'inherit' tier never carries a price of its own, even if the stored
  // record still has one. Saves are merged into the stored record, so clearing
  // the 1-3" price used to leave the old figure sitting beside 'inherit' --
  // and with nothing below 1-3 to inherit from, that stale figure was what got
  // billed while the form showed the field blank.
  function resolveTier(tiers, label) {
    const all = tiers || {};
    const seen = new Set();
    let node = all[label];
    while (node && node.mode === 'inherit' && node.from && !seen.has(label)) {
      seen.add(label);
      label = node.from;
      node = all[label];
    }
    if (!node || node.mode === 'inherit') return { mode: 'unset' };
    return node;
  }

  // The price typed against one tier, or null when it inherits -- what the
  // form shows, so it matches what resolveTier will bill.
  function ownCents(node) {
    return node && node.mode !== 'inherit' && node.cents != null ? node.cents : null;
  }

  // What one visit bills. The single place this is worked out -- storm billing,
  // the route screen and the reports all call this, so they cannot disagree.
  function priceVisit(id, inches, minutesOnSite, crewSize) {
    const p = pricing[id];
    if (!p || !p.pricing) return null;
    const pr = p.pricing;

    let base = 0;
    if (pr.mode === 'tieredPlusPerInch' && pr.perInch && inches > pr.perInch.aboveInches) {
      const first = resolveTier(pr.tiers, '1-3');
      // Rounded to whole cents: depths come in half inches, and $12.25 an inch
      // over half an inch is 612.5 cents -- a total no invoice line can show,
      // so the printed lines stopped adding up to the stored total.
      base = (first.cents || 0) +
             Math.round((pr.perInch.cents || 0) * (inches - pr.perInch.aboveInches));
    } else {
      const label = inches <= 3 ? '1-3' : inches <= 6 ? '4-6' : inches <= 9 ? '6+' : '9+';
      base = resolveTier(pr.tiers, label).cents || 0;
    }

    // Salt is carved OUT of the base, not added to it: for these accounts the
    // agreed rate already includes it. Showing it separately is what lets salt
    // revenue be seen at all.
    const salt = pr.salt && pr.salt.included ? (pr.salt.portionCents || 0) : 0;

    // Labour is per man-hour, so crew size multiplies it. Accounts with no
    // labour rate bill the flat tier however long the night takes.
    //
    // The hours are rounded to two decimals BEFORE being multiplied, because
    // that rounded figure is what gets printed on the customer's invoice. Work
    // it out the other way and the line does not add up on its face: 95 minutes
    // with two crew shows as 3.17 hours at $25, which a customer reads as
    // $79.25, while the exact arithmetic gives $79.17. The eight pence does not
    // matter; an invoice whose own multiplication is wrong does.
    //
    // The multiplying is done in whole hundredths of an hour. 0.57 x 2550 in
    // floating point is 1453.4999..., which rounded to $14.53 where the
    // invoice's own 0.57 hours at $25.50 reads $14.54; 57 x 2550 / 100 is
    // exactly 1453.5 and rounds the way the printed line does.
    const hundredths = p.laborRateCents
      ? Math.round((minutesOnSite || 0) / 60 * (crewSize || 1) * 100)
      : 0;
    const manHours = hundredths / 100;
    const labor = p.laborRateCents ? Math.round(hundredths * p.laborRateCents / 100) : 0;

    return { plowCents: base - salt, saltCents: salt, laborCents: labor,
             manHours: manHours, totalCents: base + labor };
  }

  // ---------------------------------------------------------------- render

  function priceSummary(id) {
    const p = pricing[id];
    if (!p || !p.pricing) return '';
    const pr = p.pricing;
    const first = resolveTier(pr.tiers, '1-3');
    let s = cents(first.cents);
    if (pr.mode === 'tieredPlusPerInch') {
      s += ' + ' + cents(pr.perInch.cents) + '/in over ' + pr.perInch.aboveInches + '"';
    } else {
      const second = resolveTier(pr.tiers, '4-6');
      if (second.cents && second.cents !== first.cents) s += ' / ' + cents(second.cents);
    }
    s += p.laborRateCents ? ' + ' + cents(p.laborRateCents) + '/man-hr' : ' · no hourly';
    return s;
  }

  function mapsLink(a) {
    const q = encodeURIComponent(
      (a.lat && a.lng) ? (a.lat + ',' + a.lng) : (a.address + ', ' + (a.town || '') + ' WI'));
    return 'https://maps.google.com/?q=' + q;
  }

  function render() {
    const wrap = document.getElementById('snowAccountsWrap');
    if (!wrap) return;
    const ids = Object.keys(accounts).sort((x, y) =>
      (accounts[x].name || '').localeCompare(accounts[y].name || ''));

    const badge = document.getElementById('snowCountBadge');
    if (badge) badge.textContent = ids.length ? ids.length + ' accounts' : '';

    if (!ids.length) {
      wrap.innerHTML = loaded
        ? '<p class="empty-msg">No snow accounts yet.</p>'
        : '<p class="empty-msg">Loading…</p>';
      return;
    }

    const isOwner = !!(window.YDAuth && window.YDAuth.isOwner);

    wrap.innerHTML = ids.map(id => {
      const a = accounts[id];
      const held = Array.isArray(a.vacationHolds) && a.vacationHolds.length;
      return '<div class="snow-card' + (a.active === false ? ' inactive' : '') + '">' +
        '<div class="snow-card-head">' +
          '<span class="snow-name">' + esc(a.name) + '</span>' +
          (a.type === 'commercial' ? '<span class="snow-tag commercial">commercial</span>' : '') +
          (a.saltApplies ? '<span class="snow-tag salt">salt</span>' : '') +
          (a.minTriggerInches > 1 ? '<span class="snow-tag trigger">' + a.minTriggerInches + '"+ only</span>' : '') +
          (a.lat == null ? '<span class="snow-tag nolocation">no location</span>' : '') +
          (held ? '<span class="snow-tag hold">on hold</span>' : '') +
        '</div>' +
        '<a class="snow-addr" href="' + mapsLink(a) + '" target="_blank" rel="noopener">' +
          esc(a.address) + (a.town ? ', ' + esc(a.town) : '') +
          '<span class="snow-go">open in maps</span>' +
        '</a>' +
        (a.areaNotes ? '<div class="snow-notes">' + esc(a.areaNotes) + '</div>' : '') +
        (isOwner ? '<div class="snow-price">' + esc(priceSummary(id)) + '</div>' : '') +
        (a.driveSqFt ? '<div class="snow-sq">' + a.driveSqFt + ' sq ft drive' +
          (a.walkSqFt ? ' · ' + a.walkSqFt + ' sq ft walks' : '') + '</div>' : '') +
      '</div>';
    }).join('');
  }

  // ---------------------------------------------------------------- loading

  async function start() {
    if (unsubAccounts) return;
    const db = window.YDDb;
    if (!db || !db.watch) return;

    unsubAccounts = db.watch('snowAccounts', changes => {
      changes.forEach(c => {
        if (c.type === 'removed') delete accounts[c.id];
        else accounts[c.id] = c.data;
      });
      loaded = true;
      render();
      loadPricing();          // only the owner will get anything back
    }, () => { loaded = true; render(); });
  }

  // Pricing lives in a subcollection per account, so it is fetched per account
  // rather than watched. Crew are refused by the rules and simply see no
  // prices -- which is the intended outcome, not an error.
  async function loadPricing() {
    if (!window.YDAuth || !window.YDAuth.isOwner) return;
    const ids = Object.keys(accounts).filter(id => !pricing[id]);
    if (!ids.length) return;
    for (const id of ids) {
      try {
        const d = await window.YDDb.get('snowAccounts/' + id + '/private', PRICING_DOC);
        if (d) pricing[id] = d;
      } catch (e) { /* not permitted, or offline -- leave prices blank */ }
    }
    render();
  }

  // ---------------------------------------------------------------- exports

  // Fetch these accounts' pricing again, fresh. Closing a storm calls this so
  // the bill is worked out from the prices as they stand now -- not from
  // whatever happened to be loaded when the app opened, which might be
  // nothing yet, or a price since changed on another device. A read (unlike a
  // write) settles from the local cache when there is no signal.
  async function refreshPricing(ids) {
    if (!window.YDAuth || !window.YDAuth.isOwner || !window.YDDb) return;
    await Promise.all(ids.map(async id => {
      try {
        const d = await window.YDDb.get('snowAccounts/' + id + '/private', PRICING_DOC);
        if (d) pricing[id] = d;
      } catch (e) { /* offline with nothing cached -- reported by the caller */ }
    }));
  }

  window.YDSnow = {
    accounts: () => accounts,
    pricing: () => pricing,
    refreshPricing,
    priceVisit,
    resolveTier,
    render,

    // Used once, by the import. Writes the public and private halves together
    // so an account cannot exist with an address but no pricing.
    async importAccounts(pub, priv) {
      const entries = [];
      Object.keys(pub).forEach(id => {
        entries.push(['snowAccounts', id, pub[id]]);
        if (priv[id]) entries.push(['snowAccounts/' + id + '/private', PRICING_DOC, priv[id]]);
      });
      await window.YDDb.putMany(entries);
      return Object.keys(pub).length;
    },
  };

  // ---------------------------------------------------------------- adding

  // The address is the only thing typed that the app can turn into more: the
  // town, the map position, which weather area it falls in, and its place in
  // the driving order all come from geocoding it. So it is looked up on save
  // rather than asking anyone to type coordinates.
  //
  // OpenStreetMap's geocoder is used because it can be called from the browser.
  // The Census one is more precise for US addresses but refuses browser calls;
  // checked against it on four real addresses, this agreed to within 8 metres
  // on three and 46 on the fourth -- far inside what routing and weather need.
  async function geocodeAddress(input, townHint) {
    // People type addresses whole -- "7009 Harvest Hill Rd, Madison, WI 53717".
    // The geocoder wants the street on its own, with the town as a separate
    // field, and quietly returns nothing when the town appears in both. So
    // split it here rather than asking anyone to type it in pieces.
    const parts = String(input).split(',').map(s => s.trim()).filter(Boolean);
    const street = parts[0];
    let hint = townHint;
    if (!hint && parts.length > 1 && !/^(WI|Wisconsin)/i.test(parts[1]) && !/^\d{5}/.test(parts[1])) {
      hint = parts[1];
    }
    const KNOWN = ['Madison', 'Middleton', 'Verona', 'Fitchburg', 'Waunakee', 'Monroe'];
    // Try any town they gave first, then the towns YD actually works.
    const towns = hint ? [hint].concat(KNOWN.filter(t => t.toLowerCase() !== hint.toLowerCase())) : KNOWN;

    // Street types get abbreviated on a spreadsheet and the geocoder does not
    // always understand them. "5914 High Tower Tr" finds nothing; "…Trail"
    // finds it immediately. Jonah's own sheet writes Angel B as "cimarron tr",
    // so without this an address typed the way he writes it saves with no
    // location and then quietly never appears on a route.
    //
    // Only a TRAILING abbreviation is expanded: "4918 St Annes Dr" must keep
    // its "St" as Saint rather than becoming "Street Annes Drive".
    const STREET_TYPES = {
      tr: 'Trail', trl: 'Trail', cir: 'Circle', crcl: 'Circle', rd: 'Road',
      dr: 'Drive', st: 'Street', ave: 'Avenue', av: 'Avenue', ln: 'Lane',
      ct: 'Court', blvd: 'Boulevard', pl: 'Place', ter: 'Terrace',
      terr: 'Terrace', pkwy: 'Parkway', pky: 'Parkway', hwy: 'Highway',
      sq: 'Square', cres: 'Crescent', pt: 'Point', hts: 'Heights',
    };
    function expandStreetType(s) {
      const words = s.trim().split(/\s+/);
      if (words.length < 2) return null;
      const last = words[words.length - 1].replace(/\.$/, '').toLowerCase();
      const full = STREET_TYPES[last];
      if (!full || full.toLowerCase() === last) return null;
      return words.slice(0, -1).join(' ') + ' ' + full;
    }

    // Try it as typed first, then with the street type spelled out.
    const expanded = expandStreetType(street);
    const spellings = expanded ? [street, expanded] : [street];

    for (const town of towns) {
      for (const spelling of spellings) {
        const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
          street: spelling, city: town, state: 'WI', country: 'USA', format: 'json', limit: '1',
        });
        try {
          const j = await fetch(url).then(r => r.json());
          if (j && j.length) {
            return { lat: +j[0].lat, lng: +j[0].lon, town: town, matched: j[0].display_name };
          }
        } catch (e) { /* try the next spelling or town */ }
        await new Promise(r => setTimeout(r, 1100));   // their policy: 1 request/sec
      }
    }
    return null;
  }

  const val = id => (document.getElementById(id) || {}).value || '';
  const checked = id => !!(document.getElementById(id) || {}).checked;
  const money = id => {
    const n = parseFloat(String(val(id)).replace(/[$,\s]/g, ''));
    return isNaN(n) ? null : Math.round(n * 100);
  };

  let editingId = null;

  // Shared, so the yard address in Settings is looked up the same way.
  window.YDSnowGeocode = geocodeAddress;

  window.openSnowForm = function (id) {
    editingId = id || null;
    const a = id ? accounts[id] : null;
    const p = id ? pricing[id] : null;
    document.getElementById('snowFormTitle').textContent = a ? 'Edit Snow Account' : 'Add Snow Account';

    const set = (el, v) => { const n = document.getElementById(el); if (n) n.value = v == null ? '' : v; };
    const tick = (el, v) => { const n = document.getElementById(el); if (n) n.checked = !!v; };
    const dollars = c => (c == null ? '' : (c / 100).toString());

    set('sfName', a && a.name); set('sfAddress', a && a.address);
    set('sfType', (a && a.type) || 'residential');
    set('sfPhone', p && p.phone); set('sfEmail', p && p.email);
    set('sfNotes', a && a.areaNotes);
    set('sfTrigger', String((a && a.minTriggerInches) || 1));
    set('sfWindow', (a && a.serviceWindow) || 'standard');
    set('sfDrive', a && a.driveSqFt); set('sfWalk', a && a.walkSqFt);

    const pr = p && p.pricing;
    const t = pr && pr.tiers;
    set('sfT13', t && dollars(ownCents(t['1-3'])));
    set('sfT46', t && dollars(ownCents(t['4-6'])));
    set('sfT6',  t && dollars(ownCents(t['6+'])));
    set('sfT9',  t && dollars(ownCents(t['9+'])));
    tick('sfPerInchOn', pr && pr.mode === 'tieredPlusPerInch');
    set('sfPerInchAmt', pr && pr.perInch && dollars(pr.perInch.cents));
    set('sfPerInchAbove', pr && pr.perInch && pr.perInch.aboveInches);
    set('sfLabor', p && dollars(p.laborRateCents));
    tick('sfNoLabor', !!(p && p.laborRateCents === null));
    tick('sfSaltOn', !!(pr && pr.salt && pr.salt.included));
    set('sfSaltAmt', pr && pr.salt && dollars(pr.salt.portionCents));

    snowFormToggle();
    document.getElementById('snowFormModal').classList.add('active');
  };

  window.closeSnowForm = function () {
    document.getElementById('snowFormModal').classList.remove('active');
    editingId = null;
  };

  window.snowFormToggle = function () {
    document.getElementById('sfPerInchRow').hidden = !checked('sfPerInchOn');
    document.getElementById('sfSaltRow').hidden = !checked('sfSaltOn');
    const noLabor = checked('sfNoLabor');
    document.getElementById('sfLabor').disabled = noLabor;
    document.getElementById('sfNoLaborHint').hidden = !noLabor;
  };

  window.saveSnowForm = async function () {
    const btn = document.getElementById('sfSaveBtn');
    const name = val('sfName').trim();
    const address = val('sfAddress').trim();
    if (!name)    { showToast('Give the account a name'); return; }
    if (!address) { showToast('An address is needed — the route and weather depend on it'); return; }

    btn.disabled = true;
    btn.textContent = 'Finding the address…';

    // Two accounts named the same thing produced the same id, and the second
    // silently replaced the first. Jonah's own sheet has two Baxter properties
    // at different addresses, so this is not hypothetical -- adding the second
    // would have erased the first with no warning at all.
    let id = editingId;
    if (!id) {
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'account';
      id = base;
      let n = 2;
      while (accounts[id]) id = base + '-' + (n++);
      if (id !== base) console.info('[snow] "' + name + '" already exists; saving as ' + id);
    }
    const existing = editingId ? accounts[editingId] : null;

    // Only look the address up when it is new or has changed -- no point
    // hitting the geocoder to re-confirm something already known.
    let geo = null;
    if (!existing || existing.address !== address || !existing.lat) {
      geo = await geocodeAddress(address);
      if (!geo) {
        document.getElementById('sfGeoHint').textContent =
          'Could not find that address. Check the spelling — it can be saved anyway, but it will not appear on a route until it can be located.';
      }
    }

    btn.textContent = 'Saving…';

    const pub = {
      name: name,
      address: address,
      town: geo ? geo.town : (existing && existing.town) || null,
      lat: geo ? geo.lat : (existing && existing.lat) || null,
      lng: geo ? geo.lng : (existing && existing.lng) || null,
      geocodedAs: geo ? geo.matched : (existing && existing.geocodedAs) || null,
      type: val('sfType'),
      active: existing ? existing.active !== false : true,
      season: '2026-27',
      minTriggerInches: parseInt(val('sfTrigger'), 10) || 1,
      serviceWindow: val('sfWindow'),
      areaNotes: val('sfNotes').trim(),
      vacationHolds: (existing && existing.vacationHolds) || [],
      driveSqFt: parseInt(val('sfDrive'), 10) || null,
      walkSqFt: parseInt(val('sfWalk'), 10) || null,
      saltApplies: checked('sfSaltOn'),
    };

    // cents is written as null on an inheriting tier, not left out: the save
    // is merged into the stored record, so leaving it out kept the old price.
    const tierOrInherit = (id, below) => {
      const c = money(id);
      return c === null ? { mode: 'inherit', from: below, cents: null } : { mode: 'flat', cents: c };
    };
    const perInchOn = checked('sfPerInchOn');
    const priv = {
      phone: val('sfPhone').trim(),
      email: val('sfEmail').trim().toLowerCase(),
      laborRateCents: checked('sfNoLabor') ? null : money('sfLabor'),
      pricing: {
        mode: perInchOn ? 'tieredPlusPerInch' : 'tiered',
        tiers: {
          '1-3': tierOrInherit('sfT13', null),
          '4-6': tierOrInherit('sfT46', '1-3'),
          '6+':  tierOrInherit('sfT6', '4-6'),
          '9+':  tierOrInherit('sfT9', '6+'),
        },
        perInch: perInchOn
          ? { cents: money('sfPerInchAmt') || 0, aboveInches: parseInt(val('sfPerInchAbove'), 10) || 3 }
          : null,
        salt: {
          included: checked('sfSaltOn'),
          portionCents: checked('sfSaltOn') ? (money('sfSaltAmt') || 0) : 0,
          perBagCents: null,
        },
      },
    };

    // Both halves together: an account with an address but no pricing would
    // quietly bill nothing. Not awaited -- the write lands locally at once and
    // reaches the server when there is signal, so saving never hangs.
    Promise.resolve(window.YDDb.putMany([
      ['snowAccounts', id, pub],
      ['snowAccounts/' + id + '/private', PRICING_DOC, priv],
    ])).catch(e => console.warn('[snow] account not yet on the server:', e.code || e.message));
    pricing[id] = priv;
    accounts[id] = pub;
    render();
    closeSnowForm();
    showToast(geo ? (name + ' added — located in ' + geo.town) : (name + ' saved'));
    btn.disabled = false;
    btn.textContent = 'Save account';
  };

  // Signing out does not reload the page. Without dropping the watch and the
  // data, the next person to sign in on the same phone would never get a
  // fresh listener -- and would still have the owner's pricing in memory.
  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const key = a.mode === 'cloud' && a.user ? a.user.uid + ':' + a.role : null;
    if (key !== authKey) {
      if (unsubAccounts) { try { unsubAccounts(); } catch (err) {} unsubAccounts = null; }
      accounts = {}; pricing = {}; loaded = false;
      authKey = key;
    }
    if (key) start(); else render();
    const add = document.getElementById('snowAddBtn');
    if (add) add.hidden = !(a.isOwner === true);
  });
})();
