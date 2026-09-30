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
  function resolveTier(tiers, label) {
    const seen = new Set();
    let node = tiers[label];
    while (node && node.mode === 'inherit' && node.from && !seen.has(label)) {
      seen.add(label);
      label = node.from;
      node = tiers[label];
    }
    return node || { mode: 'unset' };
  }

  // What one visit bills. The single place this is worked out -- storm billing,
  // the route screen and the reports all call this, so they cannot disagree.
  function priceVisit(id, inches, minutesOnSite, crewSize) {
    const p = pricing[id];
    if (!p || !p.pricing) return null;
    const pr = p.pricing;

    let base = 0;
    if (pr.mode === 'tieredPlusPerInch' && inches > pr.perInch.aboveInches) {
      const first = resolveTier(pr.tiers, '1-3');
      base = (first.cents || 0) + pr.perInch.cents * (inches - pr.perInch.aboveInches);
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
    const labor = p.laborRateCents
      ? Math.round((minutesOnSite || 0) / 60 * p.laborRateCents * (crewSize || 1))
      : 0;

    return { plowCents: base - salt, saltCents: salt, laborCents: labor, totalCents: base + labor };
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

  window.YDSnow = {
    accounts: () => accounts,
    pricing: () => pricing,
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
  async function geocodeAddress(street, townHint) {
    const towns = townHint ? [townHint] : ['Madison', 'Middleton', 'Verona', 'Fitchburg', 'Waunakee', 'Monroe'];
    for (const town of towns) {
      const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
        street: street, city: town, state: 'WI', country: 'USA', format: 'json', limit: '1',
      });
      try {
        const j = await fetch(url).then(r => r.json());
        if (j && j.length) {
          return { lat: +j[0].lat, lng: +j[0].lon, town: town, matched: j[0].display_name };
        }
      } catch (e) { /* try the next town */ }
      await new Promise(r => setTimeout(r, 1100));   // their policy: 1 request/sec
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
    set('sfT13', t && t['1-3'] && dollars(t['1-3'].cents));
    set('sfT46', t && t['4-6'] && dollars(t['4-6'].cents));
    set('sfT6',  t && t['6+']  && dollars(t['6+'].cents));
    set('sfT9',  t && t['9+']  && dollars(t['9+'].cents));
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

    const id = editingId || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
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

    const tierOrInherit = (id, below) => {
      const c = money(id);
      return c === null ? { mode: 'inherit', from: below } : { mode: 'flat', cents: c };
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

    try {
      // Both halves together: an account with an address but no pricing would
      // quietly bill nothing.
      await window.YDDb.putMany([
        ['snowAccounts', id, pub],
        ['snowAccounts/' + id + '/private', PRICING_DOC, priv],
      ]);
      pricing[id] = priv;
      closeSnowForm();
      showToast(geo ? (name + ' added — located in ' + geo.town) : (name + ' saved'));
    } catch (e) {
      console.error('[snow] save failed', e);
      showToast('Could not save: ' + (e.message || 'unknown error'));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save account';
    }
  };

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    if (a.mode === 'cloud' && a.user) start();
    const add = document.getElementById('snowAddBtn');
    if (add) add.hidden = !(a.isOwner === true);
  });
})();
