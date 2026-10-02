// Weather, in three layers.
//
//   1. Both counties, always on screen   -- Dane and Green, one request each
//   2. Any town, on demand               -- fetched when looked at, not before
//   3. Every stop on a storm night       -- snowfall at that exact address
//
// Layer 3 is the one that matters for money: it is the property's own snowfall
// that decides which tier a visit bills at, not the town's.
//
// Two sources, both free and neither needing a key:
//   weather.gov  -- forecast, alerts, snowfall, wind, rain, heat index
//   open-meteo   -- ground temperature at depth, which weather.gov does not carry
//
// A web app can only fetch while it is open. There is no background update and
// no alert when it is closed. So everything cached is stamped with the time it
// was taken and that time is always shown -- a number whose age you cannot see
// is worse than no number.

(function () {
  'use strict';

  const NWS = 'https://api.weather.gov';
  const ZONES = { Dane: 'WIZ063', Green: 'WIZ068' };
  const GRID_KEY = 'ydjobhub_nwsGrid_';     // grid for a point never changes
  const FRESH_MS = 15 * 60 * 1000;

  const cache = {};                          // key -> { at, data }

  function fresh(key) {
    const c = cache[key];
    return c && (Date.now() - c.at) < FRESH_MS ? c.data : null;
  }
  function put(key, data) { cache[key] = { at: Date.now(), data: data }; return data; }

  function ageText(key) {
    const c = cache[key];
    if (!c) return '';
    const mins = Math.round((Date.now() - c.at) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const h = Math.round(mins / 60);
    return h + (h === 1 ? ' hour ago' : ' hours ago');
  }

  async function getJson(url) {
    const r = await fetch(url, { headers: { 'Accept': 'application/geo+json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // ---------------------------------------------------------------- points

  // The grid square a point falls in never changes, so it is looked up once
  // and kept. Saves a request on every refresh thereafter.
  async function gridFor(lat, lng) {
    const k = GRID_KEY + lat.toFixed(4) + ',' + lng.toFixed(4);
    try {
      const saved = localStorage.getItem(k);
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    const j = await getJson(NWS + '/points/' + lat.toFixed(4) + ',' + lng.toFixed(4));
    const g = {
      office: j.properties.gridId, x: j.properties.gridX, y: j.properties.gridY,
      city: (j.properties.relativeLocation || {}).properties
        ? j.properties.relativeLocation.properties.city : null,
    };
    try { localStorage.setItem(k, JSON.stringify(g)); } catch (e) {}
    return g;
  }

  function inchesFromMm(v) { return v == null ? 0 : v / 25.4; }

  // The API returns ISO intervals like "2026-11-29T06:00:00+00:00/PT6H", so
  // each entry covers a span rather than an instant. "PT6H", "P1D",
  // "P1DT12H" -> milliseconds; 0 for anything not in that shape.
  function durationMs(iso) {
    const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
    if (!m) return 0;
    const [w, d, h, min, s] = m.slice(1).map(x => +x || 0);
    return ((((w * 7 + d) * 24 + h) * 60 + min) * 60 + s) * 1000;
  }
  function spanOf(v) {
    const parts = String((v && v.validTime) || '').split('/');
    const start = new Date(parts[0]).getTime();
    return { start: start, end: start + durationMs(parts[1]) };
  }

  // Sum a gridpoint series over the next N hours. Each entry is the amount
  // for its whole span, so a span only partly inside the window counts for
  // that part. Counting by start time alone dropped the six-hour block that
  // began two hours ago and is still falling.
  function sumNext(series, hours) {
    if (!series || !series.values) return 0;
    const now = Date.now(), until = now + hours * 3600 * 1000;
    let total = 0;
    series.values.forEach(v => {
      const t = spanOf(v);
      if (!isFinite(t.start) || !v.value) return;
      if (t.end <= t.start) {                       // no usable length
        if (t.start >= now && t.start <= until) total += v.value;
        return;
      }
      const overlap = Math.min(t.end, until) - Math.max(t.start, now);
      if (overlap > 0) total += v.value * overlap / (t.end - t.start);
    });
    return total;
  }

  // The value in force NOW. A series starts when the forecast was issued,
  // often many hours earlier, so its first entry was the temperature at
  // perhaps 1 am -- shown as "now" in the afternoon. Nothing covering this
  // moment means no figure, rather than an old one passed off as current.
  function valueNow(series) {
    if (!series || !series.values) return null;
    const now = Date.now();
    const hit = series.values.find(v => {
      const t = spanOf(v);
      return t.start <= now && now < t.end;
    });
    return hit ? hit.value : null;
  }

  async function pointWeather(lat, lng) {
    const key = 'pt:' + lat.toFixed(3) + ',' + lng.toFixed(3);
    const hit = fresh(key);
    if (hit) return hit;
    const g = await gridFor(lat, lng);
    const j = await getJson(NWS + '/gridpoints/' + g.office + '/' + g.x + ',' + g.y);
    const p = j.properties;
    return put(key, {
      city: g.city,
      tempF: cToF(valueNow(p.temperature)),
      windMph: kmhToMph(valueNow(p.windSpeed)),
      gustMph: kmhToMph(valueNow(p.windGust)),
      heatIndexF: cToF(valueNow(p.heatIndex)),
      snow24: inchesFromMm(sumNext(p.snowfallAmount, 24)),
      snow48: inchesFromMm(sumNext(p.snowfallAmount, 48)),
      rain24: sumNext(p.quantitativePrecipitation, 24) / 25.4,
      rainChance: valueNow(p.probabilityOfPrecipitation),
      cacheKey: key,
    });
  }

  function cToF(c) { return c == null ? null : Math.round(c * 9 / 5 + 32); }
  function kmhToMph(k) { return k == null ? null : Math.round(k * 0.621371); }

  // Ground temperature is not in the government forecast at all, so it comes
  // from open-meteo. Surface tells you about frost and whether seed will take;
  // deeper tells you whether the ground is genuinely frozen for digging.
  async function groundTemp(lat, lng) {
    const key = 'soil:' + lat.toFixed(3) + ',' + lng.toFixed(3);
    const hit = fresh(key);
    if (hit) return hit;
    const u = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
      latitude: lat, longitude: lng,
      hourly: 'soil_temperature_0cm,soil_temperature_18cm',
      temperature_unit: 'fahrenheit', forecast_days: '1', timezone: 'America/Chicago',
    });
    const j = await getJson(u);
    const i = Math.min(new Date().getHours(), j.hourly.time.length - 1);
    return put(key, {
      surfaceF: Math.round(j.hourly.soil_temperature_0cm[i]),
      deepF: Math.round(j.hourly.soil_temperature_18cm[i]),
      cacheKey: key,
    });
  }

  async function alertsFor(zone) {
    const key = 'alerts:' + zone;
    const hit = fresh(key);
    if (hit) return hit;
    const j = await getJson(NWS + '/alerts/active?zone=' + zone);
    return put(key, (j.features || []).map(f => ({
      event: f.properties.event,
      severity: f.properties.severity,
      headline: f.properties.headline,
    })));
  }

  // ---------------------------------------------------------------- render

  const COUNTY_POINTS = {
    Dane:  { lat: 43.0731, lng: -89.4012 },   // Madison
    Green: { lat: 42.6011, lng: -89.6385 },   // Monroe
  };

  async function renderCounties() {
    const wrap = document.getElementById('weatherWrap');
    if (!wrap) return;
    wrap.innerHTML = '<div class="wx-loading">Checking the weather…</div>';

    const out = [];
    for (const county of Object.keys(ZONES)) {
      const pt = COUNTY_POINTS[county];
      try {
        const [w, soil, alerts] = await Promise.all([
          pointWeather(pt.lat, pt.lng),
          groundTemp(pt.lat, pt.lng).catch(() => null),
          alertsFor(ZONES[county]).catch(() => []),
        ]);
        out.push(countyCard(county, w, soil, alerts));
      } catch (e) {
        out.push('<div class="wx-card"><div class="wx-county">' + county + ' County</div>' +
                 '<div class="wx-fail">Weather unavailable — ' + esc(e.message) + '</div></div>');
      }
    }
    wrap.innerHTML = out.join('');
  }

  function countyCard(county, w, soil, alerts) {
    const bad = (alerts || []).filter(a => /warning|watch|advisory/i.test(a.event));
    return '<div class="wx-card' + (bad.length ? ' has-alert' : '') + '">' +
      '<div class="wx-head">' +
        '<span class="wx-county">' + county + ' County</span>' +
        '<span class="wx-age">' + ageText(w.cacheKey) + '</span>' +
      '</div>' +
      (bad.length ? '<div class="wx-alert">' +
        bad.map(a => esc(a.event)).join(' · ') + '</div>' : '') +
      '<div class="wx-figures">' +
        fig(w.tempF != null ? w.tempF + '&deg;' : '—', 'now') +
        fig(w.snow24 >= 0.05 ? w.snow24.toFixed(1) + '"' : '—', 'snow 24h') +
        fig(w.windMph != null ? w.windMph : '—', 'wind mph') +
        // Gusts as a figure of their own: "10g16" (pilot shorthand for 10 mph
        // gusting to 16) meant nothing to anyone reading it.
        (w.gustMph != null && w.windMph != null && w.gustMph >= w.windMph + 5 ? fig(w.gustMph, 'gusts mph') : '') +
        fig(w.rain24 >= 0.01 ? w.rain24.toFixed(2) + '"' : '—', 'rain 24h') +
        (soil ? fig(soil.surfaceF + '&deg;', 'ground') : '') +
        (w.heatIndexF != null ? fig(w.heatIndexF + '&deg;', 'feels') : '') +
      '</div>' +
      (w.snow48 >= 0.05 ? '<div class="wx-note">' + w.snow48.toFixed(1) + '" expected over 48 hours</div>' : '') +
    '</div>';
  }

  function fig(value, label) {
    return '<div class="wx-fig"><div class="wx-val">' + value + '</div>' +
           '<div class="wx-lab">' + label + '</div></div>';
  }

  // ---------------------------------------------------------------- exports

  window.YDWeather = {
    pointWeather, groundTemp, alertsFor, renderCounties, ageText,

    // Layer 3: snowfall at one property, for the storm screen.
    async forStop(lat, lng) {
      if (lat == null) return null;
      try { return await pointWeather(lat, lng); } catch (e) { return null; }
    },

    // Layer 2: any address, looked up when asked for.
    async forAddress(address) {
      const geo = await window.YDSnowGeocode(address);
      if (!geo) return null;
      const w = await pointWeather(geo.lat, geo.lng);
      return Object.assign({ place: geo.matched }, w);
    },
  };

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    if (a.mode === 'cloud' && a.user) setTimeout(renderCounties, 1200);
  });
})();
