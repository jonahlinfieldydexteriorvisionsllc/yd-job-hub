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
  let place = (() => { try { return localStorage.getItem(STORE + 'place') || 'madison'; } catch (e) { return 'madison'; } })();
  let data = null;          // { at, now, days, alerts }
  let loading = false;
  let timer = null;

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
    });
    const r = await fetch('https://api.open-meteo.com/v1/forecast?' + q);
    if (!r.ok) throw new Error('forecast unavailable (' + r.status + ')');
    const j = await r.json();
    const d = j.daily;
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
      alerts: [],
    };
    try {
      const a = await fetch('https://api.weather.gov/alerts/active?point=' + pt.lat.toFixed(4) + ',' + pt.lng.toFixed(4),
        { headers: { Accept: 'application/geo+json' } });
      const aj = await a.json();
      out.alerts = (aj.features || []).map(f => f.properties && f.properties.event).filter(Boolean).slice(0, 3);
    } catch (e) { /* the forecast is still worth showing without warnings */ }
    return out;
  }

  async function refresh(force) {
    const have = saved(place);
    if (have) data = have;
    if (!force && have && Date.now() - have.at < FRESH_MS) { draw(); return; }
    if (loading) return;
    loading = true; draw();
    try {
      data = await fetchWeek(place);
      keep(place, data);
    } catch (e) {
      console.warn('[forecast]', e.message);
    } finally {
      loading = false;
      draw();
    }
  }

  function ago(at) {
    const m = Math.round((Date.now() - at) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    return h < 48 ? h + ' hr ago' : Math.round(h / 24) + ' days ago';
  }

  function dayName(iso, i) {
    if (i === 0) return 'Today';
    if (i === 1) return 'Tomorrow';
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
  }

  function draw() {
    const chip = el('wxChip');
    if (chip) {
      if (data && data.now) {
        const [icon] = codeOf(data.now.code);
        chip.innerHTML = '<span class="wxc-icon">' + icon + '</span><span class="wxc-temp">' +
          Math.round(data.now.temp) + '°</span>' + (data.alerts && data.alerts.length ? '<span class="wxc-alert">!</span>' : '') +
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
    const n = data.now;
    panel.innerHTML =
      '<div class="wxp-top">' +
        '<div class="wxp-now"><span class="wxp-big">' + codeOf(n.code)[0] + ' ' + Math.round(n.temp) + '°</span>' +
          '<span class="wxp-sub">' + codeOf(n.code)[1] + ' · feels ' + Math.round(n.feels) + '° · wind ' + Math.round(n.wind) + ' mph</span></div>' +
        '<div class="wxp-places">' + Object.keys(PLACES).map(k =>
          '<button class="wxp-place' + (k === place ? ' on' : '') + '" onclick="wxPlace(\'' + k + '\')">' + PLACES[k].name + '</button>').join('') +
        '</div>' +
      '</div>' +
      (data.alerts && data.alerts.length ? '<div class="wxp-alert">⚠️ ' + data.alerts.map(esc).join(' · ') + '</div>' : '') +
      '<div class="wxp-days">' + data.days.map((d, i) => {
        const [icon, words] = codeOf(d.code);
        const snowy = d.snow >= 0.1;
        const wind = '💨 ' + Math.round(d.wind) + (d.gust && d.gust > d.wind + 8 ? '–' + Math.round(d.gust) : '') + ' mph';
        return '<div class="wxp-day' + (snowy ? ' snow' : '') + '">' +
          '<div class="wxp-name">' + dayName(d.date, i) + '</div>' +
          '<div class="wxp-icon" title="' + esc(words) + '">' + icon + '</div>' +
          '<div class="wxp-words">' + esc(words) + '</div>' +
          '<div class="wxp-temps"><b>' + Math.round(d.hi) + '°</b> <span>' + Math.round(d.lo) + '°</span></div>' +
          '<div class="wxp-extra">' +
            (d.pop ? '💧' + d.pop + '%' : '') +
            (snowy ? ' ❄️' + d.snow + '"' : (d.rain >= 0.05 ? ' ' + d.rain.toFixed(2) + '"' : '')) +
            // On a phone each day is one row, so the wind joins this line.
            '<span class="wxp-w"> ' + wind + '</span>' +
          '</div>' +
          '<div class="wxp-wind">' + wind + '</div>' +
        '</div>';
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
