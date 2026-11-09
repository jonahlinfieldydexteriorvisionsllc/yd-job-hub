// Where and when a photo was taken, read from the photo itself, and which job
// that spot is.
//
// Jonah (9 Nov 2026): yes to Job Hub keeping each photo's location and the
// time it was taken, and saying when a photo looks like it is on the wrong
// job -- "because eventually i want you setup to access the icloud photos for
// work phones and then auto upload and sort photos taken by location to the
// job theyre on". So the reading and the matching are here, apart from the
// screens: the same rules will sort photos that come in by themselves.
//
// A camera writes the time and its GPS reading into the photo (EXIF). The
// photo is shrunk on the phone before it is sent (jobphotos.js), and that
// drops all of it, so it is read here first, from the file as picked.
//
// What survives to be read depends on the phone, not on Job Hub: a phone's
// browser removes the location from a photo picked on the phone (Android
// always, an iPhone unless the picker's Options say to keep it, and never for
// one taken with the camera from the picker). A photo picked on a computer --
// the original, synced from iCloud or copied off a phone -- keeps it. The time
// taken mostly survives either way.
//
// A job's own spot is its address's map point, the one the estimate keeps for
// the miles (estimate.site), as long as it is for the address the job has now.

(function () {
  'use strict';

  // A JPEG keeps its time and place in its first 64 KB, before the picture.
  // An iPhone HEIC usually near the start too, but a big one (48 MP, Live
  // Photo) can have it after the picture, so a HEIC not found in the first
  // part is read whole, up to READ_ALL.
  const READ_FIRST = 512 * 1024;
  const READ_ALL = 60 * 1024 * 1024;
  const M_PER_MILE = 1609.344;
  // How near counts as "at" a job, in miles. A phone's GPS outdoors is good to
  // a few yards, but a map point for an address can sit at the middle of the
  // lot or out at the road, and a big property is big.
  const AT_MILES = 0.1;       // within this of another job's point: taken there
  const OFF_MILES = 0.25;     // beyond this from its own job's point: not taken at its job
  const FAR_MILES = 1;        // beyond this, said as a warning even with no other job near

  // ------------------------------------------------------- reading the photo

  // The EXIF block: in a JPEG its own segment near the start; in an iPhone's
  // HEIC (and any other) found by its header, "Exif" then a TIFF start.
  function tiffStart(dv) {
    const n = dv.byteLength;
    const isExif = p => p + 10 <= n && dv.getUint32(p) === 0x45786966 && dv.getUint16(p + 4) === 0;
    const isTiff = p => p + 4 <= n && (dv.getUint32(p) === 0x49492A00 || dv.getUint32(p) === 0x4D4D002A);
    if (n > 4 && dv.getUint16(0) === 0xFFD8) {
      let p = 2;
      while (p + 4 <= n && dv.getUint8(p) === 0xFF) {
        const m = dv.getUint8(p + 1);
        if (m === 0xD9 || m === 0xDA) break;                 // end, or the picture itself
        if (m === 0xFF) { p++; continue; }                   // padding
        if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { p += 2; continue; }
        const len = dv.getUint16(p + 2);
        if (len < 2) break;
        if (m === 0xE1 && isExif(p + 4) && isTiff(p + 10)) return p + 10;
        p += 2 + len;
      }
      // A JPEG with none in its header has none: the picture data after it
      // is not searched (slow, and stray bytes could look like a header).
      return -1;
    }
    for (let p = 0; p + 14 <= n; p++) {
      if (dv.getUint8(p) === 0x45 && isExif(p) && isTiff(p + 6)) return p + 6;
    }
    return -1;
  }

  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  function readTiff(dv, t) {
    const le = dv.getUint16(t) === 0x4949;
    const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
    if (u16(t + 2) !== 42) return null;
    const ifd = off => {
      const at = t + off, out = {};
      if (!off || at + 2 > dv.byteLength) return out;
      const count = u16(at);
      if (count > 1000) return out;
      for (let i = 0; i < count; i++) {
        const e = at + 2 + i * 12;
        if (e + 12 > dv.byteLength) break;
        out[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 };
      }
      return out;
    };
    const dataAt = e => ((SIZE[e.type] || 1) * e.count <= 4 ? e.at : t + u32(e.at));
    const text = e => {
      if (!e) return '';
      const o = dataAt(e);
      let s = '';
      for (let i = 0; i < Math.min(e.count, 64); i++) {
        const c = dv.getUint8(o + i);
        if (!c) break;
        s += String.fromCharCode(c);
      }
      return s.trim();
    };
    const num = e => (!e ? NaN : e.type === 3 ? u16(e.at) : e.type === 4 ? u32(e.at) : NaN);
    // `zero`: what a 0/0 counts as (seconds and minutes written as 0/0 by
    // some cameras mean nothing past the degrees).
    const ratio = (e, i, zero) => {
      if (!e || (e.type !== 5 && e.type !== 10) || e.count <= i) return NaN;
      const o = dataAt(e) + i * 8;
      const top = e.type === 10 ? dv.getInt32(o, le) : u32(o);
      const bottom = e.type === 10 ? dv.getInt32(o + 4, le) : u32(o + 4);
      return bottom ? top / bottom : (zero == null ? NaN : zero);
    };
    // The time and the place are read apart: an odd number in one never
    // loses the other.
    const tryRead = fn => { try { return fn(); } catch (e) { return null; } };
    const main = ifd(u32(t + 4));
    const exif = tryRead(() => (main[0x8769] ? ifd(num(main[0x8769])) : {})) || {};
    const gps = tryRead(() => (main[0x8825] ? ifd(num(main[0x8825])) : {})) || {};
    const out = { at: tryRead(() => whenOf(text(exif[0x9003]) || text(exif[0x9004]) || text(main[0x0132]),
                                             text(exif[0x9011]) || text(exif[0x9010]))),
                  lat: null, lng: null, acc: null };
    tryRead(() => {
      const deg = e => ratio(e, 0) + ratio(e, 1, 0) / 60 + ratio(e, 2, 0) / 3600;
      let lat = deg(gps[2]), lng = deg(gps[4]);
      if (/^S/i.test(text(gps[1]))) lat = -lat;
      if (/^W/i.test(text(gps[3]))) lng = -lng;
      if (isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (Math.abs(lat) > 0.0001 || Math.abs(lng) > 0.0001)) {
        out.lat = Math.round(lat * 1e6) / 1e6;
        out.lng = Math.round(lng * 1e6) / 1e6;
        const acc = tryRead(() => ratio(gps[31], 0));
        out.acc = isFinite(acc) && acc >= 0 && acc < 100000 ? Math.round(acc) : null;
      }
    });
    return out.at || out.lat != null ? out : null;
  }

  // "2026:11:07 13:48:09" and, when the camera wrote it, "-06:00". With no
  // offset the time is the device's own (photos come from phones set to
  // Wisconsin time). Nothing before 2000 or more than a day ahead (a clock
  // never set).
  function whenOf(s, offset) {
    const m = /^(\d{4}):(\d\d):(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(s || '');
    if (!m) return null;
    const d = /^[+-]\d\d:\d\d$/.test(offset || '')
      ? new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + offset)
      : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const t = d.getTime();
    if (!isFinite(t) || d.getFullYear() < 2000 || t > Date.now() + 86400000) return null;
    return d.toISOString();
  }

  // From a picked file: { at, lat, lng, acc } (at an ISO time or null, the
  // place null when there is none), or null when the photo says neither.
  // Never throws: a photo that can't be read this way is still added.
  async function read(file) {
    try {
      if (!file || typeof file.slice !== 'function') return null;
      const bytes = async end => {
        const part = file.slice(0, end);
        return part.arrayBuffer ? part.arrayBuffer() : new Response(part).arrayBuffer();
      };
      const size = file.size || 0;
      const first = await bytes(Math.min(size || READ_FIRST, READ_FIRST));
      const got = fromBytes(first);
      const head = new DataView(first);
      const jpeg = head.byteLength > 2 && head.getUint16(0) === 0xFFD8;
      // A JPEG is settled by its header. Anything else with no place found in
      // the first part (none there, or its numbers past the part read) is
      // read whole.
      if (jpeg || size <= READ_FIRST || size > READ_ALL || (got && got.lat != null)) return got;
      return fromBytes(await bytes(size)) || got;
    } catch (e) {
      return null;
    }
  }
  function fromBytes(buf) {
    try {
      const dv = new DataView(buf);
      const t = tiffStart(dv);
      return t < 0 ? null : readTiff(dv, t);
    } catch (e) {
      return null;                       // a cut-off or odd file: nothing read
    }
  }

  // ------------------------------------------------------- which job it is

  function miles(a, b) {
    const r = x => x * Math.PI / 180;
    const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h))) / M_PER_MILE;
  }

  // A job's spot: its address's map point, only while it is for the address
  // the job has now (estimate.js keeps `at` as address|city|zip, lower case).
  function pointOf(job) {
    const s = job && job.estimate && job.estimate.site;
    if (!s || typeof s.lat !== 'number' || typeof s.lng !== 'number') return null;
    const key = ['address', 'city', 'zip'].map(f => String(job[f] || '').trim().toLowerCase()).join('|');
    return key.replace(/\|/g, '') && s.at === key ? { lat: s.lat, lng: s.lng } : null;
  }

  const gone = j => !j || j.removeWhy || j.deletedAt || j.deleted;
  const open = j => !/^complete|^lost/i.test(String(j.status || '')) && !j.completedAt;

  // Where a photo was taken, against the job it is on.
  //   taken  { lat, lng, acc } from read()
  //   job    the job it is on (a job record, with `_id` or `id`)
  //   jobs   every job this device has, to find the one it was taken at
  // Answers null (no place in the photo) or
  //   { kind: 'here' }                         at its job
  //   { kind: 'near', miles }                  a little way from its job's point
  //   { kind: 'far', miles }                   well away, no other job there
  //   { kind: 'other', miles, job }            at another job's address
  //   { kind: 'unknown', job? }                its job has no map point (job: one it was taken at)
  function judge(taken, job, jobs) {
    if (!taken || typeof taken.lat !== 'number' || typeof taken.lng !== 'number') return null;
    const id = job && (job._id || job.id);
    // A GPS reading the phone itself called rough widens the circle.
    const slack = taken.acc ? Math.min(taken.acc, 500) / M_PER_MILE : 0;
    const own = pointOf(job);
    const ownMiles = own ? Math.max(0, miles(taken, own) - slack) : null;
    // The job it was taken at: within AT_MILES, an open job before a
    // finished one (the same house can have last year's job too), then nearest.
    let at = null;
    (jobs || []).forEach(j => {
      const jid = j && (j._id || j.id);
      if (gone(j) || !jid || jid === id) return;
      const p = pointOf(j);
      if (!p) return;
      const d = Math.max(0, miles(taken, p) - slack);
      if (d > AT_MILES) return;
      const better = !at || (open(j) && !open(at.job)) || (open(j) === open(at.job) && d < at.d);
      if (better) at = { job: j, d: d };
    });
    if (own == null) return at ? { kind: 'unknown', job: at.job } : { kind: 'unknown' };
    if (ownMiles <= OFF_MILES) return { kind: 'here' };
    if (at) return { kind: 'other', miles: ownMiles, job: at.job };
    return ownMiles > FAR_MILES ? { kind: 'far', miles: ownMiles } : { kind: 'near', miles: ownMiles };
  }

  // "0.4 mi", "3 mi", "120 mi".
  const milesWords = m => (m < 10 ? (Math.round(m * 10) / 10) : Math.round(m)) + ' mi';

  window.YDPhotoPlace = { read: read, fromBytes: fromBytes, judge: judge, pointOf: pointOf, miles: miles,
                          milesWords: milesWords, AT_MILES: AT_MILES, OFF_MILES: OFF_MILES, FAR_MILES: FAR_MILES };
})();
