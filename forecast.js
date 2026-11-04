// The week's weather, one tap away from anywhere in the app.
//
// A small button in the header shows the temperature now; tapping it drops a
// panel with seven days -- conditions, high and low, chance of rain or snow,
// how much snow, and wind -- that stays open while the rest of the app is
// used, until it is tapped again.
//
// Open-Meteo for the forecast (the same source the morning summary uses, so
// the panel and the 5 am email agree) and weather.gov for official warnings.
// Neither needs a key.
//
// The last forecast is kept on the device with the time it was fetched, so in
// a truck with no signal the panel still shows something -- and says how old
// it is, because a forecast whose age you cannot see is worse than none.
//
// HOW MUCH IS COMING (Jonah, 3 Nov 2026: "have weather on front page and stuff
// show hourly estiamte quantity of rainfall/snowfall/ice"): each hour says how
// much rain, snow and ice to expect, in the panel and on Home. Rain and snow
// are Open-Meteo's. Ice it doesn't give: an hour it calls freezing rain or
// drizzle counts its precipitation as ice, and weather.gov's own ice figure
// (6-hour blocks, shared across their hours) is laid over it, the bigger of
// the two standing. That figure is a 200 KB answer, so it is asked for only
// when a wet hour near freezing is ahead, and after the numbers are on screen.

(function () {
  'use strict';

  // A temperature, or a dash when the forecast left it out: Math.round(null)
  // printed a confident 0 degrees.
  const deg = v => (typeof v === 'number' && isFinite(v) ? Math.round(v) + '°' : '—');

  const PLACES = {
    madison: { name: 'Madison', lat: 43.0731, lng: -89.4012 },
    monroe: { name: 'Monroe', lat: 42.6011, lng: -89.6385 },
  };
  const STORE = 'ydjobhub_week_';
  const FRESH_MS = 30 * 60 * 1000;

  // WMO weather codes -> an icon and a few words.
  const CODES = {
    0: ['☀️', 'Clear'], 1: ['🌤️', 'Mostly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Cloudy'],
    45: ['🌫️', 'Fog'], 48: ['🌫️', 'Freezing fog'],
    51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌧️', 'Heavy drizzle'],
    56: ['🌧️', 'Freezing drizzle'], 57: ['🌧️', 'Freezing drizzle'],
    61: ['🌦️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'],
    66: ['🧊', 'Freezing rain'], 67: ['🧊', 'Freezing rain'],
    71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'], 75: ['❄️', 'Heavy snow'], 77: ['🌨️', 'Snow grains'],
    80: ['🌦️', 'Showers'], 81: ['🌧️', 'Showers'], 82: ['⛈️', 'Heavy showers'],
    85: ['🌨️', 'Snow showers'], 86: ['❄️', 'Heavy snow showers'],
    95: ['⛈️', 'Thunderstorms'], 96: ['⛈️', 'Storms, hail'], 99: ['⛈️', 'Storms, hail'],
  };
  const codeOf = c => CODES[c] || ['🌡️', '—'];
  // Freezing drizzle and freezing rain: what falls in such an hour is ice.
  const ICY = [56, 57, 66, 67];
  // A wet hour at or under this may be ice, so weather.gov is asked.
  const ICE_TEMP_F = 36;
  // Hours shown on Home; the rest are in the panel.
  const FALLING_MAX = 12;

  let open = false;
  // Only a town that is still in the list: one saved by an older version that
  // has since been taken out would otherwise break every redraw.
  let place = (() => {
    try { const p = localStorage.getItem(STORE + 'place'); return PLACES[p] ? p : 'madison'; }
    catch (e) { return 'madison'; }
  })();
  let data = null;          // { at, now, days, alerts }
  let loading = false;
  let timer = null;
  let sel = 0;              // which day the hourly strip shows; 0 = the next 24 hours

  const el = id => document.getElementById(id);

  function saved(p) {
    try { return JSON.parse(localStorage.getItem(STORE + p) || 'null'); } catch (e) { return null; }
  }
  function keep(p, d) {
    try { localStorage.setItem(STORE + p, JSON.stringify(d)); } catch (e) {}
  }

  // weather.gov is often slow, sometimes very. The numbers (Open-Meteo) wait
  // for its warnings and written forecast, so it gets this long and no more
  // -- with no limit the header button sat on "…" for a minute on one bar.
  // `until`: the moment to give up (one limit for /points and the forecast
  // after it together).
  const NWS_WAIT_MS = 8000;
  function nwsJson(url, until) {
    const stop = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = stop ? setTimeout(() => stop.abort(), Math.max(0, until - Date.now())) : null;
    return fetch(url, { headers: { Accept: 'application/geo+json' }, signal: stop ? stop.signal : undefined })
      .then(r => {
        if (!r.ok) { const e = new Error('weather.gov said ' + r.status); e.status = r.status; throw e; }
        return r.json();
      })
      .finally(() => clearTimeout(timer));
  }
  // Where a town's written forecast is: weather.gov answers that once for a
  // point (/points) and it does not change, so it is kept on the device
  // rather than asked for before every forecast.
  async function forecastUrl(p, spot, until) {
    const key = STORE + 'nws_' + p;
    let url = null;
    try { url = localStorage.getItem(key); } catch (e) {}
    if (!url) {
      const pt = await nwsJson('https://api.weather.gov/points/' + spot, until);
      url = pt && pt.properties && pt.properties.forecast;
      if (!/^https:\/\/api\.weather\.gov\//.test(String(url || ''))) throw new Error('no forecast for this point');
      try { localStorage.setItem(key, url); } catch (e) {}
    }
    return url;
  }
  async function writtenForecast(p, spot, until) {
    const key = STORE + 'nws_' + p;
    const url = await forecastUrl(p, spot, until);
    try {
      return await nwsJson(url, until);
    } catch (e) {
      // The forecast moved (weather.gov redraws its grid now and then): ask
      // /points again next time.
      if (e.status === 404) { try { localStorage.removeItem(key); } catch (err) {} }
      throw e;
    }
  }

  async function fetchWeek(p) {
    const pt = PLACES[p];
    const q = new URLSearchParams({
      latitude: pt.lat, longitude: pt.lng, timezone: 'America/Chicago', forecast_days: 7,
      temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch',
      current: 'temperature_2m,weather_code,wind_speed_10m,apparent_temperature',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,' +
             'precipitation_sum,snowfall_sum,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset',
      hourly: 'temperature_2m,weather_code,precipitation_probability,precipitation,rain,showers,snowfall,' +
              'wind_speed_10m,wind_gusts_10m,is_day',
    });
    const spot = pt.lat.toFixed(4) + ',' + pt.lng.toFixed(4);
    // The numbers, the warnings and the written forecast come from three
    // places; ask for all three at once, and weather.gov's two only for so
    // long (NWS_WAIT_MS), so a slow one does not hold up the rest.
    const until = Date.now() + NWS_WAIT_MS;
    const [om, warn, words] = await Promise.allSettled([
      fetch('https://api.open-meteo.com/v1/forecast?' + q),
      nwsJson('https://api.weather.gov/alerts/active?point=' + spot, until),
      writtenForecast(p, spot, until),
    ]);
    if (om.status !== 'fulfilled' || !om.value.ok) throw new Error('forecast unavailable');
    const j = await om.value.json();
    const d = j.daily;
    const h = j.hourly;
    // In inches, going by the unit the answer names: asked for inches it
    // gives inches. (Divided by 2.54 whatever it said, this panel showed 40%
    // of the snow coming. Found 3 Nov 2026.)
    const inches = (v, units, key) => (v || 0) / (units && units[key] === 'cm' ? 2.54 : 1);
    const out = {
      at: Date.now(),
      now: { temp: j.current.temperature_2m, feels: j.current.apparent_temperature,
             code: j.current.weather_code, wind: j.current.wind_speed_10m },
      days: d.time.map((t, i) => ({
        date: t, code: d.weather_code[i], hi: d.temperature_2m_max[i], lo: d.temperature_2m_min[i],
        pop: d.precipitation_probability_max[i], rain: d.precipitation_sum[i],
        snow: Math.round(inches(d.snowfall_sum[i], j.daily_units, 'snowfall_sum') * 10) / 10,
        wind: d.wind_speed_10m_max[i], gust: d.wind_gusts_10m_max[i],
      })),
      // Times are local ("2026-10-01T14:00") because timezone is set above.
      hours: h.time.map((t, i) => {
        const icy = ICY.indexOf(h.weather_code[i]) >= 0;
        const liquid = ((h.rain || [])[i] || 0) + ((h.showers || [])[i] || 0);
        return {
          t, temp: h.temperature_2m[i], code: h.weather_code[i], pop: h.precipitation_probability[i],
          rain: h.precipitation[i], snow: Math.round(inches(h.snowfall[i], j.hourly_units, 'snowfall') * 100) / 100,
          // Rain on its own (rain: everything that falls, as water), and ice.
          wet: icy ? 0 : Math.round(liquid * 1000) / 1000, ice: icy ? h.precipitation[i] || 0 : 0,
          wind: h.wind_speed_10m[i], gust: h.wind_gusts_10m[i], day: h.is_day[i],
        };
      }),
      alerts: [],
      text: [],
    };
    // Warnings and the written forecast are extras: the numbers are still
    // worth showing without them.
    if (warn.status === 'fulfilled') {
      out.alerts = (warn.value.features || []).map(f => f.properties && f.properties.event).filter(Boolean).slice(0, 3);
    }
    if (words.status === 'fulfilled' && words.value.properties) {
      // startTime carries the local offset, so its first ten characters are
      // the local date the period belongs to ("Tonight" is still today).
      out.text = (words.value.properties.periods || []).map(p => ({
        date: String(p.startTime).slice(0, 10), name: p.name, words: p.detailedForecast,
      }));
    }
    return out;
  }

  // weather.gov's ice, inches per local hour ("2026-11-05T14"). A figure covers
  // a stretch ("...T18:00:00+00:00/PT6H"), shared evenly across its hours.
  function iceByHour(series) {
    const out = {};
    const hoursIn = d => {
      const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?)?/.exec(String(d || ''));
      return m ? (Number(m[1]) || 0) * 24 + (Number(m[2]) || 0) : 0;
    };
    (series && series.values || []).forEach(v => {
      const [at, span] = String(v.validTime || '').split('/');
      const start = Date.parse(at), n = hoursIn(span);
      if (!(v.value > 0) || isNaN(start) || !n) return;
      for (let i = 0; i < n; i++) {
        const k = hourKey(new Date(start + i * 3600000));
        out[k] = (out[k] || 0) + v.value / 25.4 / n;
      }
    });
    return out;
  }
  // Never waited on: the numbers are on screen first, and this is only an extra.
  async function addIce(p, got) {
    if (!(got.hours || []).some(x => x.temp <= ICE_TEMP_F && x.rain > 0)) return;
    const pt = PLACES[p];
    const until = Date.now() + NWS_WAIT_MS;
    try {
      const url = await forecastUrl(p, pt.lat.toFixed(4) + ',' + pt.lng.toFixed(4), until);
      const grid = await nwsJson(url.replace(/\/forecast$/, ''), until);
      const byHour = iceByHour(grid && grid.properties && grid.properties.iceAccumulation);
      got.hours.forEach(x => { x.ice = Math.max(x.ice || 0, byHour[x.t.slice(0, 13)] || 0); });
      keep(p, got);
      if (p === place) { data = got; draw(); }
    } catch (e) {
      console.warn('[forecast] no ice figure:', e.message);
    }
  }

  async function refresh(force) {
    // The town this fetch is for, held on to. Changing town while it was on
    // its way used to file Madison's forecast under Monroe and show it as
    // Monroe's for the next half hour.
    const p = place;
    const have = saved(p);
    if (have) data = have;
    // A copy saved before the hourly view existed has no hours: fetch anew.
    if (!force && have && have.hours && Date.now() - have.at < FRESH_MS) { draw(); return; }
    if (loading) return;
    loading = true; draw();
    try {
      const got = await fetchWeek(p);
      keep(p, got);
      if (p === place) data = got;
      addIce(p, got);
    } catch (e) {
      console.warn('[forecast]', e.message);
    } finally {
      loading = false;
      draw();
      // The town was changed meanwhile, and its own fetch was turned away
      // because this one was running: fetch it now.
      if (p !== place) refresh(false);
    }
  }

  function ago(at) {
    const m = Math.round((Date.now() - at) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    return h < 48 ? h + ' hr ago' : Math.round(h / 24) + ' days ago';
  }

  // Named from the date itself, never from its place in the list. A copy
  // saved on Monday and opened on Wednesday with no signal used to call
  // Monday "Today".
  function dayName(iso) {
    const now = new Date();
    if (iso === dayKey(now)) return 'Today';
    if (iso === dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))) return 'Tomorrow';
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
  }

  // Clear and mostly clear at night get a moon, not a sun.
  function iconFor(code, day) {
    if (day === 0 && (code === 0 || code === 1)) return '🌙';
    if (day === 0 && code === 2) return '☁️';
    return codeOf(code)[0];
  }

  const two = n => (n < 10 ? '0' : '') + n;
  // A day and an hour as Open-Meteo writes them, from local date parts (never
  // toISOString). Both sort as text in time order.
  function dayKey(dt) {
    return dt.getFullYear() + '-' + two(dt.getMonth() + 1) + '-' + two(dt.getDate());
  }
  function hourKey(dt) { return dayKey(dt) + 'T' + two(dt.getHours()); }

  // Days already over are left out. A saved copy is kept for when there is no
  // signal, and its first days may be gone by the time it is read.
  function daysAhead() {
    const today = dayKey(new Date());
    return (data.days || []).filter(d => d.date >= today);
  }

  // What it is like now. The reading saved with the forecast is only "now"
  // while it is fresh; from a copy hours old, the forecast for this hour is
  // the better guess -- the chip said 54° at six in the morning in a truck at
  // 20° because it was yesterday afternoon's reading.
  function nowReading() {
    if (Date.now() - data.at < 90 * 60000 || !data.hours) return data.now;
    const key = hourKey(new Date());
    const h = data.hours.find(x => x.t.slice(0, 13) === key);
    return h ? { temp: h.temp, code: h.code, wind: h.wind, feels: null, forecast: true } : data.now;
  }
  function hourLabel(t) {
    const hr = Number(t.slice(11, 13));
    return (hr % 12 || 12) + (hr < 12 ? 'a' : 'p');
  }

  // Today shows the next 24 hours from now (so at 9 pm it runs into tomorrow
  // morning); any other day shows that day midnight to midnight.
  //
  // "From now" is the first hour at or after this one. It used to fall back
  // to the copy's very first hour when this exact hour was missing, which
  // showed an old copy's hours from days ago with the first marked "Now".
  function hoursFor(day) {
    const all = data.hours || [];
    if (day && day.date === dayKey(new Date())) {
      const now = hourKey(new Date());
      const from = all.findIndex(x => x.t.slice(0, 13) >= now);
      return from < 0 ? [] : all.slice(from, from + 24);
    }
    return all.filter(x => day && x.t.slice(0, 10) === day.date);
  }

  // Gusts are worth a mention only when they are well above the steady wind.
  // Written out ("gusts 16"): the old "10g16" and "10–16" left Jonah guessing.
  const gusty = (w, g) => g != null && w != null && g >= w + 5;

  // Rain in an hour, in inches. Under a hundredth is a trace -- damp
  // pavement, not a washed-out afternoon.
  function rainAmount(inches) {
    if (!(inches > 0)) return '';
    return inches < 0.01 ? 'trace' : inches.toFixed(2) + '"';
  }

  // Rain in an hour, apart from snow and ice. (A copy saved before `wet` was
  // kept: everything that fell, unless it snowed.)
  const rainOf = x => (x.wet != null ? x.wet : (x.snow >= 0.1 ? 0 : (x.rain || 0)));
  // How much of each is expected in an hour. More than one can fall in it.
  function amountsOf(x) {
    const out = [], rain = rainOf(x);
    if (rain >= 0.01) out.push('🌧️' + rain.toFixed(2) + '"');
    if (x.snow >= 0.1) out.push('❄️' + x.snow.toFixed(1) + '"');
    if (x.ice >= 0.005) out.push('🧊' + x.ice.toFixed(2) + '"');
    return out;
  }

  function hourCell(x, isNow) {
    const pop = x.pop || 0;
    const snowy = x.snow >= 0.1;
    const amount = amountsOf(x).join('<br>') || rainAmount(rainOf(x));
    return '<div class="wxh' + (isNow ? ' now' : '') + (snowy ? ' snow' : '') + '">' +
      '<div class="wxh-t">' + (isNow ? 'Now' : hourLabel(x.t)) + '</div>' +
      '<div class="wxh-i">' + iconFor(x.code, x.day) + '</div>' +
      '<div class="wxh-deg">' + deg(x.temp) + '</div>' +
      // A bar whose height is the chance of rain or snow, so a wet afternoon
      // can be seen at a glance across the strip.
      '<div class="wxh-bar"><span style="height:' + Math.min(100, pop) + '%"></span></div>' +
      '<div class="wxh-wet">' + (pop >= 10 ? '💧' + pop + '%' : '') + '</div>' +
      // How much is expected to fall in this hour, beside how likely it is.
      '<div class="wxh-amt">' + amount + '</div>' +
      '<div class="wxh-w">' + Math.round(x.wind) + ' mph' +
        (gusty(x.wind, x.gust) ? '<br>gusts ' + Math.round(x.gust) : '') + '</div>' +
    '</div>';
  }

  // The hours on show, added up: "about 0.42" of rain and about 3" of snow".
  function totalWords(hours) {
    const sum = fn => hours.reduce((s, x) => s + (fn(x) || 0), 0);
    const rain = sum(rainOf), snow = sum(x => x.snow), ice = sum(x => x.ice);
    const bits = [];
    if (rain >= 0.01) bits.push('about ' + rain.toFixed(2) + '" of rain');
    if (snow >= 0.1) bits.push('about ' + snow.toFixed(1) + '" of snow');
    if (ice >= 0.01) bits.push('about ' + ice.toFixed(2) + '" of ice');
    return bits.length > 1 ? bits.slice(0, -1).join(', ') + ' and ' + bits[bits.length - 1] : bits.join('');
  }
  function hoursTotal(hours, isToday) {
    const span = isToday ? 'over the next 24 hours' : 'over the day';
    const bits = totalWords(hours);
    return bits
      ? '<div class="wxp-total">💧 ' + bits + ' ' + span + '</div>'
      : '<div class="wxp-total dry">No rain or snow expected ' + span + '</div>';
  }

  function draw() {
    // Home shows today's weather from the same copy (YDForecast below).
    document.dispatchEvent(new CustomEvent('yd-forecast'));
    const chip = el('wxChip');
    if (chip) {
      if (data && data.now) {
        const cur = nowReading();
        const [icon] = codeOf(cur.code);
        chip.innerHTML = '<span class="wxc-icon">' + icon + '</span><span class="wxc-temp">' +
          deg(cur.temp) + '</span>' + (data.alerts && data.alerts.length ? '<span class="wxc-alert">!</span>' : '') +
          '<span class="wxc-caret">' + (open ? '▴' : '▾') + '</span>';
      } else {
        chip.innerHTML = '<span class="wxc-icon">🌡️</span><span class="wxc-temp">' + (loading ? '…' : '—') + '</span>' +
          '<span class="wxc-caret">' + (open ? '▴' : '▾') + '</span>';
      }
      chip.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    const panel = el('wxPanel');
    if (!panel) return;
    panel.hidden = !open;
    if (!open) return;
    if (!data) {
      panel.innerHTML = '<div class="wxp-msg">' + (loading ? 'Getting the forecast…' : 'The forecast could not be reached.') + '</div>';
      return;
    }
    const days = daysAhead();
    if (!days.length || !data.now) {
      panel.innerHTML = '<div class="wxp-msg">The saved forecast is out of date and a new one could not be ' +
        'reached. ' + (loading ? 'Trying now…' : '<button class="wxp-refresh" onclick="wxRefresh()">↻ Try again</button>') + '</div>';
      return;
    }
    const n = nowReading();
    if (sel >= days.length) sel = 0;
    const selDay = days[sel];
    const isToday = selDay.date === dayKey(new Date());
    const hours = hoursFor(selDay);
    const thisHour = hourKey(new Date());
    const said = (data.text || []).filter(p => p.date === selDay.date);
    const dayTitle = isToday ? 'Next 24 hours' :
      new Date(selDay.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) + ', hour by hour';
    panel.innerHTML =
      '<div class="wxp-top">' +
        '<div class="wxp-now"><span class="wxp-big">' + codeOf(n.code)[0] + ' ' + deg(n.temp) + '</span>' +
          '<span class="wxp-sub">' + codeOf(n.code)[1] +
            (n.feels != null ? ' · feels ' + deg(n.feels) : '') +
            ' · wind ' + Math.round(n.wind) + ' mph' +
            (n.forecast ? ' · forecast for this hour' : '') + '</span></div>' +
        '<div class="wxp-places">' + Object.keys(PLACES).map(k =>
          '<button class="wxp-place' + (k === place ? ' on' : '') + '" onclick="wxPlace(\'' + k + '\')">' + PLACES[k].name + '</button>').join('') +
        '</div>' +
      '</div>' +
      (data.alerts && data.alerts.length ? '<div class="wxp-alert">⚠️ ' + data.alerts.map(esc).join(' · ') + '</div>' : '') +
      '<div class="wxp-head">' + esc(dayTitle) + '<span>°F · 💧 chance · inches · wind</span></div>' +
      (hours.length
        ? '<div class="wxp-hours" data-keep="wx-' + place + '-' + selDay.date + '">' + hours.map((x, k) => hourCell(x, isToday && k === 0 && x.t.slice(0, 13) === thisHour)).join('') + '</div>' +
          hoursTotal(hours, isToday)
        : '<div class="wxp-msg">No hourly figures for this day yet — refresh with ↻.</div>') +
      (said.length
        ? '<div class="wxp-text">' + said.map(p => '<p><b>' + esc(p.name) + ':</b> ' + esc(p.words) + '</p>').join('') +
            '<div class="wxp-src">National Weather Service forecast</div></div>'
        : '') +
      '<div class="wxp-head">' + days.length + ' day' + (days.length === 1 ? '' : 's') +
        '<span>tap a day for its hours</span></div>' +
      '<div class="wxp-days">' + days.map((d, i) => {
        const [icon, words] = codeOf(d.code);
        const snowy = d.snow >= 0.1;
        const gust = gusty(d.wind, d.gust) ? 'gusts ' + Math.round(d.gust) : '';
        const wind = '💨 ' + Math.round(d.wind) + ' mph';
        const ice = (data.hours || []).reduce((s, x) => s + (x.t.slice(0, 10) === d.date ? x.ice || 0 : 0), 0);
        return '<button type="button" class="wxp-day' + (snowy ? ' snow' : '') + (i === sel ? ' on' : '') +
          '" onclick="wxDay(' + i + ')" aria-pressed="' + (i === sel) + '">' +
          '<div class="wxp-name">' + dayName(d.date) + '</div>' +
          '<div class="wxp-icon" title="' + esc(words) + '">' + icon + '</div>' +
          '<div class="wxp-words">' + esc(words) + '</div>' +
          '<div class="wxp-temps"><b>' + deg(d.hi) + '</b> <span>' + deg(d.lo) + '</span></div>' +
          '<div class="wxp-extra">' +
            (d.pop ? '💧' + d.pop + '%' : '') +
            (snowy ? ' ❄️' + d.snow + '"' : (d.rain >= 0.05 ? ' ' + d.rain.toFixed(2) + '"' : '')) +
            (ice >= 0.01 ? ' 🧊' + ice.toFixed(2) + '"' : '') +
            // On a phone each day is one row, so the wind joins this line.
            '<span class="wxp-w"> ' + wind + (gust ? ', ' + gust : '') + '</span>' +
          '</div>' +
          '<div class="wxp-wind">' + wind + (gust ? '<br>' + gust : '') + '</div>' +
        '</button>';
      }).join('') + '</div>' +
      '<div class="wxp-foot">' + PLACES[place].name + ' · updated ' + ago(data.at) + (loading ? ' · refreshing…' : '') +
        ' <button class="wxp-refresh" onclick="wxRefresh()">↻</button></div>';
  }

  window.toggleWeek = function () {
    open = !open;
    draw();
    if (open) refresh(false);
  };
  // The panel floats over whatever is on screen, so it closes the way a
  // floating thing does: Escape, or a tap anywhere else. It used to stay
  // open over the Job form -- across tabs too -- until the weather button
  // was found and pressed again (office test, 16 Oct 2026).
  function closeWeek() {
    if (!open) return;
    open = false;
    draw();
  }
  // The phone's Back closes it too (app.js backClosesWindows).
  window.closeWeek = closeWeek;
  // Caught on the way down, before app.js's Escape handling: a window or
  // the ⋯ menu open in front is closed first by that press, not this panel.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !open || e.isComposing) return;
    const menu = document.getElementById('headerMenu');
    if ((menu && !menu.hidden) || (typeof topOverlay === 'function' && topOverlay())) return;
    closeWeek();
  }, true);
  // The weather button itself is left out: it toggles the panel on its own.
  // Home's weather line only ever opens it, so it reopens straight after.
  document.addEventListener('pointerdown', e => {
    if (!open) return;
    const t = e.target;
    if (t && t.closest && t.closest('#wxPanel, #wxChip')) return;
    closeWeek();
  }, true);
  window.wxRefresh = function () { refresh(true); };
  window.wxDay = function (i) {
    sel = i;
    draw();
    const strip = el('wxPanel') && el('wxPanel').querySelector('.wxp-hours');
    if (strip) strip.scrollIntoView({ block: 'nearest' });
  };
  window.wxPlace = function (p) {
    if (!PLACES[p]) return;
    place = p;
    try { localStorage.setItem(STORE + 'place', p); } catch (e) {}
    data = saved(p);
    draw();
    refresh(false);
  };

  // Today's weather for Home (home.js): what it is like now and the day
  // ahead, in the town picked here, from the copy the header button shows --
  // null until there is one. Never fetched for Home on its own.
  window.YDForecast = {
    today: () => {
      if (!data || !data.now) return null;
      const t = dayKey(new Date());
      const d = (data.days || []).find(x => x.date === t);
      const n = nowReading();
      const [icon, words] = codeOf(n.code);
      return {
        place: PLACES[place].name, icon: icon, words: words, temp: deg(n.temp), feels: n.feels != null ? deg(n.feels) : '',
        hi: d ? deg(d.hi) : '', lo: d ? deg(d.lo) : '', pop: d && d.pop ? d.pop : 0,
        rain: d && d.rain >= 0.05 ? d.rain.toFixed(2) + '"' : '', snow: d && d.snow >= 0.1 ? d.snow + '"' : '',
        wind: d && typeof d.wind === 'number' ? Math.round(d.wind) + ' mph' + (gusty(d.wind, d.gust) ? ', gusts ' + Math.round(d.gust) : '') : '',
        alerts: (data.alerts || []).slice(), age: ago(data.at), stale: Date.now() - data.at > 3 * 3600000,
        falling: falling(),
      };
    },
  };
  // The next 24 hours for Home: only the hours with something falling, and
  // the total. null when it should stay dry.
  function falling() {
    const hours = hoursFor({ date: dayKey(new Date()) });
    const cells = hours.filter(x => amountsOf(x).length).map(x => ({ at: hourLabel(x.t), says: amountsOf(x) }));
    if (!cells.length) return null;
    return { cells: cells.slice(0, FALLING_MAX), more: Math.max(0, cells.length - FALLING_MAX), total: totalWords(hours) };
  }

  function boot() {
    refresh(false);
    // Kept current while the app is on screen; a closed app cannot fetch
    // anyway, and one in the background is fetched for on its return (below).
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) refresh(false); }, 10 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
