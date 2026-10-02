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

(function () {
  'use strict';

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

  async function fetchWeek(p) {
    const pt = PLACES[p];
    const q = new URLSearchParams({
      latitude: pt.lat, longitude: pt.lng, timezone: 'America/Chicago', forecast_days: 7,
      temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch',
      current: 'temperature_2m,weather_code,wind_speed_10m,apparent_temperature',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,' +
             'precipitation_sum,snowfall_sum,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset',
      hourly: 'temperature_2m,weather_code,precipitation_probability,precipitation,snowfall,' +
              'wind_speed_10m,wind_gusts_10m,is_day',
    });
    const spot = pt.lat.toFixed(4) + ',' + pt.lng.toFixed(4);
    const geo = { headers: { Accept: 'application/geo+json' } };
    // The numbers, the warnings and the written forecast come from three
    // places; ask for all three at once so a slow one does not hold up the rest.
    const [om, warn, words] = await Promise.allSettled([
      fetch('https://api.open-meteo.com/v1/forecast?' + q),
      fetch('https://api.weather.gov/alerts/active?point=' + spot, geo).then(a => a.json()),
      fetch('https://api.weather.gov/points/' + spot, geo).then(a => a.json())
        .then(p => fetch(p.properties.forecast, geo)).then(a => a.json()),
    ]);
    if (om.status !== 'fulfilled' || !om.value.ok) throw new Error('forecast unavailable');
    const j = await om.value.json();
    const d = j.daily;
    const h = j.hourly;
    const out = {
      at: Date.now(),
      now: { temp: j.current.temperature_2m, feels: j.current.apparent_temperature,
             code: j.current.weather_code, wind: j.current.wind_speed_10m },
      days: d.time.map((t, i) => ({
        date: t, code: d.weather_code[i], hi: d.temperature_2m_max[i], lo: d.temperature_2m_min[i],
        pop: d.precipitation_probability_max[i], rain: d.precipitation_sum[i],
        // Open-Meteo gives snowfall in centimetres even when everything else
        // is in inches.
        snow: Math.round(((d.snowfall_sum[i] || 0) / 2.54) * 10) / 10,
        wind: d.wind_speed_10m_max[i], gust: d.wind_gusts_10m_max[i],
      })),
      // Times are local ("2026-10-01T14:00") because timezone is set above.
      hours: h.time.map((t, i) => ({
        t, temp: h.temperature_2m[i], code: h.weather_code[i], pop: h.precipitation_probability[i],
        rain: h.precipitation[i], snow: Math.round(((h.snowfall[i] || 0) / 2.54) * 10) / 10,
        wind: h.wind_speed_10m[i], gust: h.wind_gusts_10m[i], day: h.is_day[i],
      })),
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

  function hourCell(x, isNow) {
    const pop = x.pop || 0;
    const snowy = x.snow >= 0.1;
    const amount = snowy ? '❄️' + x.snow + '"' : rainAmount(x.rain);
    return '<div class="wxh' + (isNow ? ' now' : '') + (snowy ? ' snow' : '') + '">' +
      '<div class="wxh-t">' + (isNow ? 'Now' : hourLabel(x.t)) + '</div>' +
      '<div class="wxh-i">' + iconFor(x.code, x.day) + '</div>' +
      '<div class="wxh-deg">' + Math.round(x.temp) + '°</div>' +
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

  // The hours on show, added up: "about 0.42 in of rain over the next 24 hours".
  function hoursTotal(hours, isToday) {
    const rain = hours.reduce((s, x) => s + (x.snow >= 0.1 ? 0 : (x.rain || 0)), 0);
    const snow = Math.round(hours.reduce((s, x) => s + (x.snow || 0), 0) * 10) / 10;
    const span = isToday ? 'over the next 24 hours' : 'over the day';
    const bits = [];
    if (rain >= 0.01) bits.push('about ' + rain.toFixed(2) + '" of rain');
    if (snow >= 0.1) bits.push('about ' + snow + '" of snow');
    return bits.length
      ? '<div class="wxp-total">💧 ' + bits.join(' and ') + ' ' + span + '</div>'
      : '<div class="wxp-total dry">No rain or snow expected ' + span + '</div>';
  }

  function draw() {
    const chip = el('wxChip');
    if (chip) {
      if (data && data.now) {
        const cur = nowReading();
        const [icon] = codeOf(cur.code);
        chip.innerHTML = '<span class="wxc-icon">' + icon + '</span><span class="wxc-temp">' +
          Math.round(cur.temp) + '°</span>' + (data.alerts && data.alerts.length ? '<span class="wxc-alert">!</span>' : '') +
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
        '<div class="wxp-now"><span class="wxp-big">' + codeOf(n.code)[0] + ' ' + Math.round(n.temp) + '°</span>' +
          '<span class="wxp-sub">' + codeOf(n.code)[1] +
            (n.feels != null ? ' · feels ' + Math.round(n.feels) + '°' : '') +
            ' · wind ' + Math.round(n.wind) + ' mph' +
            (n.forecast ? ' · forecast for this hour' : '') + '</span></div>' +
        '<div class="wxp-places">' + Object.keys(PLACES).map(k =>
          '<button class="wxp-place' + (k === place ? ' on' : '') + '" onclick="wxPlace(\'' + k + '\')">' + PLACES[k].name + '</button>').join('') +
        '</div>' +
      '</div>' +
      (data.alerts && data.alerts.length ? '<div class="wxp-alert">⚠️ ' + data.alerts.map(esc).join(' · ') + '</div>' : '') +
      '<div class="wxp-head">' + esc(dayTitle) + '<span>°F · 💧 chance · inches · wind</span></div>' +
      (hours.length
        ? '<div class="wxp-hours">' + hours.map((x, k) => hourCell(x, isToday && k === 0 && x.t.slice(0, 13) === thisHour)).join('') + '</div>' +
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
        return '<button type="button" class="wxp-day' + (snowy ? ' snow' : '') + (i === sel ? ' on' : '') +
          '" onclick="wxDay(' + i + ')" aria-pressed="' + (i === sel) + '">' +
          '<div class="wxp-name">' + dayName(d.date) + '</div>' +
          '<div class="wxp-icon" title="' + esc(words) + '">' + icon + '</div>' +
          '<div class="wxp-words">' + esc(words) + '</div>' +
          '<div class="wxp-temps"><b>' + Math.round(d.hi) + '°</b> <span>' + Math.round(d.lo) + '°</span></div>' +
          '<div class="wxp-extra">' +
            (d.pop ? '💧' + d.pop + '%' : '') +
            (snowy ? ' ❄️' + d.snow + '"' : (d.rain >= 0.05 ? ' ' + d.rain.toFixed(2) + '"' : '')) +
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

  function boot() {
    refresh(false);
    // Kept current while the app is open; a closed app cannot fetch anyway.
    clearInterval(timer);
    timer = setInterval(() => refresh(false), 10 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
