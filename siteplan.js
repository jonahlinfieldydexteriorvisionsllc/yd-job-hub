// Bird's-eye site plans (Jonah, 5 Nov 2026: "Claude draws a to-scale plan in the
// estimate chat, the customer gets it as a PDF on the estimate, the crew sees it
// on their job page ... turf flush systems first").
//
// Claude sends what is on the plan, in feet: functions/estimates.py _site_plan
// says the shape. Nothing here is a picture of Claude's: this file draws it, so
// the scale is true and every length and area printed is worked out from the
// points, never typed. The estimate keeps it as estimate.sitePlan:
//   { title, widthFt, heightFt, notes: [..],
//     shapes: [{ kind: area|line|point, style, label, dim, points: [{x, y}] }] }
// x runs right and y runs down from the sheet's top left corner.
//   YDPlan.svg(plan)   the drawing, for a page
//   YDPlan.pdf(plan)   one landscape page, as a Blob, for the customer
//   YDPlan.key(plan)   changes when the plan does
(function () {
  'use strict';

  const AREA = { turf: ['#7ac47f', 'Turf'], lawn: ['#bfe3ad', 'Lawn'], pavers: ['#cdbba8', 'Pavers'], gravel: ['#dcd6cb', 'Gravel'],
    concrete: ['#dcdce2', 'Concrete'], bed: ['#b0916b', 'Planting bed'], mulch: ['#94745a', 'Mulch'], house: ['#bdb6c9', 'Building'],
    deck: ['#cdac82', 'Deck'], other: ['#ece7f1', 'Other'] };
  const LINE = { pipe: ['#2f6fd6', 'Pipe', '10 6'], drain: ['#1a5fb4', 'Drain', '14 7'], flush: ['#0e9bb5', 'Flush line', '10 6'],
    edge: ['#514859', 'Edging', ''], wall: ['#2E2840', 'Wall', ''], fence: ['#8b5a2b', 'Fence', '4 5'], wire: ['#c9922f', 'Wire', '3 6'],
    other: ['#6c637a', 'Line', ''] };
  const POINT = { valve: ['#c8492b', 'Valve'], emitter: ['#0e9bb5', 'Emitter'], drain: ['#1a5fb4', 'Drain'], light: ['#c9922f', 'Light'],
    tree: ['#2f8f5b', 'Tree'], shrub: ['#5aa469', 'Shrub'], post: ['#514859', 'Post'], other: ['#6c637a', 'Point'] };

  const WIDE = 1000, TALL = 640, PAD = 30, MOST = 2000;     // feet: functions/estimates.py keeps to it too
  const safe = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const num = v => (typeof v === 'number' && isFinite(v) ? Math.min(MOST, Math.max(0, v)) : 0);
  // Words from outside the file must be its own keys, not "constructor".
  const known = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? k : 'other');
  const ptsOf = s => (Array.isArray(s && s.points) ? s.points : []).map(p => ({ x: num(p && p.x), y: num(p && p.y) }));
  const feet = n => (Math.round(n * 10) / 10).toString();

  function lengthOf(p) {
    let t = 0;
    for (let i = 1; i < p.length; i++) t += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    return t;
  }
  // The area inside the corners (the shoelace sum).
  function areaOf(p) {
    let t = 0;
    for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; t += a.x * b.y - b.x * a.y; }
    return Math.abs(t) / 2;
  }
  const middle = p => ({ x: p.reduce((s, q) => s + q.x, 0) / p.length, y: p.reduce((s, q) => s + q.y, 0) / p.length });
  // Halfway along a line by distance, where its words go.
  function along(p) {
    let left = lengthOf(p) / 2;
    for (let i = 1; i < p.length; i++) {
      const d = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
      if (d >= left && d > 0) { const t = left / d; return { x: p[i - 1].x + (p[i].x - p[i - 1].x) * t, y: p[i - 1].y + (p[i].y - p[i - 1].y) * t }; }
      left -= d;
    }
    return p[0] || { x: 0, y: 0 };
  }
  // The sheet's size: what Claude said, stretched to hold anything past it.
  function sheet(plan) {
    let w = num(plan.widthFt), h = num(plan.heightFt);
    (plan.shapes || []).forEach(s => ptsOf(s).forEach(p => { w = Math.max(w, p.x); h = Math.max(h, p.y); }));
    return { w: Math.max(w, 1), h: Math.max(h, 1) };
  }
  // Every 5 ft on a small plan, 10 or 20 on a big one, so it stays a grid.
  const gridStep = big => (big <= 60 ? 5 : big <= 150 ? 10 : big <= 400 ? 20 : 100);

  function text(x, y, words, size, anchor, weight) {
    return '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" font-size="' + size + '" text-anchor="' + (anchor || 'middle') + '"' +
      (weight ? ' font-weight="' + weight + '"' : '') + ' fill="#2E2840" stroke="#fff" stroke-width="3.5" paint-order="stroke" stroke-linejoin="round">' +
      safe(words) + '</text>';
  }

  function svg(plan) {
    if (!plan || !Array.isArray(plan.shapes) || !plan.shapes.length) return '';
    const { w, h } = sheet(plan);
    const u = Math.min((WIDE - PAD * 2) / w, (TALL - PAD * 2) / h);
    const dx = (WIDE - w * u) / 2, dy = 46;
    const X = v => dx + v * u, Y = v => dy + v * u;
    const line = p => p.map(q => X(q.x).toFixed(1) + ',' + Y(q.y).toFixed(1)).join(' ');
    const step = gridStep(Math.max(w, h));
    let grid = '';
    for (let x = 0; x <= w + 0.01; x += step) grid += '<line x1="' + X(x).toFixed(1) + '" y1="' + Y(0).toFixed(1) + '" x2="' + X(x).toFixed(1) + '" y2="' + Y(h).toFixed(1) + '"/>';
    for (let y = 0; y <= h + 0.01; y += step) grid += '<line x1="' + X(0).toFixed(1) + '" y1="' + Y(y).toFixed(1) + '" x2="' + X(w).toFixed(1) + '" y2="' + Y(y).toFixed(1) + '"/>';
    const areas = [], lines = [], points = [], words = [], used = {};
    plan.shapes.forEach(s => {
      const p = ptsOf(s), label = String(s.label || '');
      if (s.kind === 'area' && p.length >= 3) {
        const k = known(AREA, s.style), c = AREA[k];
        used['a' + k] = [c[0], c[1], 'area'];
        areas.push('<polygon points="' + line(p) + '" fill="' + c[0] + '" stroke="#2E2840" stroke-width="1.2"/>');
        const m = middle(p);
        const big = areaOf(p);
        words.push(text(X(m.x), Y(m.y), label + (s.dim ? ' · ' + Math.round(big).toLocaleString('en-US') + ' sq ft' : ''), 14));
      } else if (s.kind === 'line' && p.length >= 2) {
        const k = known(LINE, s.style), c = LINE[k];
        used['l' + k] = [c[0], c[1], 'line', c[2]];
        lines.push('<polyline points="' + line(p) + '" fill="none" stroke="' + c[0] + '" stroke-width="3" stroke-linecap="round"' +
          (c[2] ? ' stroke-dasharray="' + c[2] + '"' : '') + '/>');
        const m = along(p), said = [label, s.dim ? feet(lengthOf(p)) + ' ft' : ''].filter(Boolean).join(' · ');
        if (said) words.push(text(X(m.x), Y(m.y) - 7, said, 13));
      } else if (s.kind === 'point' && p.length) {
        const k = known(POINT, s.style), c = POINT[k];
        used['p' + k] = [c[0], c[1], 'point'];
        points.push('<circle cx="' + X(p[0].x).toFixed(1) + '" cy="' + Y(p[0].y).toFixed(1) + '" r="6.5" fill="' + c[0] + '" stroke="#fff" stroke-width="2"/>');
        if (label) words.push(text(X(p[0].x) + 11, Y(p[0].y) + 4, label, 13, 'start'));
      }
    });
    // A scale bar, so a print at any size can still be measured.
    const bar = Math.max(step, Math.round(w / 40) * 10 || step);
    const barW = bar * u, bottom = dy + h * u;
    const barY = bottom + 26;
    const scale = '<line x1="' + dx.toFixed(1) + '" y1="' + barY + '" x2="' + (dx + barW).toFixed(1) + '" y2="' + barY + '" stroke="#2E2840" stroke-width="3"/>' +
      '<text x="' + (dx + barW + 8).toFixed(1) + '" y="' + (barY + 5) + '" font-size="13" fill="#2E2840">' + bar + ' ft</text>' +
      '<text x="' + (dx + w * u).toFixed(1) + '" y="' + (barY + 5) + '" font-size="13" fill="#2E2840" text-anchor="end">Sheet ' + feet(w) + ' × ' + feet(h) + ' ft · grid ' + step + ' ft</text>';
    // What each colour and line means.
    let lx = dx, ly = barY + 26, legend = '';
    Object.keys(used).forEach(k => {
      const [color, name, kind, dash] = used[k];
      const room = 34 + name.length * 7.5;
      if (lx + room > WIDE - 10) { lx = dx; ly += 22; }
      legend += kind === 'area' ? '<rect x="' + lx.toFixed(1) + '" y="' + (ly - 11) + '" width="20" height="13" fill="' + color + '" stroke="#2E2840"/>'
        : kind === 'line' ? '<line x1="' + lx.toFixed(1) + '" y1="' + (ly - 5) + '" x2="' + (lx + 20).toFixed(1) + '" y2="' + (ly - 5) + '" stroke="' + color + '" stroke-width="3"' + (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/>'
        : '<circle cx="' + (lx + 10).toFixed(1) + '" cy="' + (ly - 5) + '" r="6" fill="' + color + '"/>';
      legend += '<text x="' + (lx + 26).toFixed(1) + '" y="' + ly + '" font-size="13" fill="#2E2840">' + safe(name) + '</text>';
      lx += room;
    });
    const notes = (Array.isArray(plan.notes) ? plan.notes : []).slice(0, 6).map(String);
    let noteRows = '', ny = ly + 8;
    notes.forEach(n => { ny += 18; noteRows += '<text x="' + dx.toFixed(1) + '" y="' + ny + '" font-size="13" fill="#2E2840">' + safe(n) + '</text>'; });
    const total = Math.ceil(ny + 16);
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + WIDE + '" height="' + total + '" viewBox="0 0 ' + WIDE + ' ' + total + '" role="img" aria-label="' + safe(plan.title || 'Site plan') + '" ' +
        'font-family="Arial, Helvetica, sans-serif" style="display:block;width:100%;height:auto;background:#fff">' +
      '<rect width="' + WIDE + '" height="' + total + '" fill="#fff"/>' +
      '<text x="' + dx.toFixed(1) + '" y="28" font-size="20" font-weight="700" fill="#2E2840">' + safe(plan.title || 'Site plan') + '</text>' +
      '<g stroke="#e4dfea" stroke-width="1">' + grid + '</g>' +
      '<rect x="' + X(0).toFixed(1) + '" y="' + Y(0).toFixed(1) + '" width="' + (w * u).toFixed(1) + '" height="' + (h * u).toFixed(1) + '" fill="none" stroke="#b9b1c6"/>' +
      areas.join('') + lines.join('') + points.join('') + words.join('') + scale + legend + noteRows + '</svg>';
  }

  // Changes when anything on the plan does: which PDF is on which estimate.
  function key(plan) {
    let h = 0;
    const s = JSON.stringify(plan || null);
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // One landscape letter page holding the drawing as a photo. Written by hand,
  // as signatures.js writes its papers: no library, so it works in a truck.
  function pdfBytes(jpeg, w, h) {
    const enc = new TextEncoder();
    const parts = [], offs = [];
    let len = 0;
    const add = b => { const u = typeof b === 'string' ? enc.encode(b) : b; parts.push(u); len += u.length; };
    const obj = (n, body) => { offs[n] = len; add(n + ' 0 obj\n'); body(); add('\nendobj\n'); };
    const pageW = 792, pageH = 612, margin = 28;
    const fit = Math.min((pageW - margin * 2) / w, (pageH - margin * 2) / h);
    const dw = (w * fit).toFixed(2), dh = (h * fit).toFixed(2);
    const px = ((pageW - w * fit) / 2).toFixed(2), py = ((pageH - h * fit) / 2).toFixed(2);
    const draw = 'q ' + dw + ' 0 0 ' + dh + ' ' + px + ' ' + py + ' cm /Im0 Do Q';
    add('%PDF-1.4\n');
    obj(1, () => add('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
    obj(3, () => add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageW + ' ' + pageH + '] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'));
    obj(4, () => {
      add('<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n');
      add(jpeg);
      add('\nendstream');
    });
    obj(5, () => add('<< /Length ' + draw.length + ' >>\nstream\n' + draw + '\nendstream'));
    const xref = len;
    add('xref\n0 6\n0000000000 65535 f \n' + [1, 2, 3, 4, 5].map(n => String(offs[n]).padStart(10, '0') + ' 00000 n \n').join(''));
    add('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    const out = new Uint8Array(len);
    let at = 0;
    parts.forEach(u => { out.set(u, at); at += u.length; });
    return out;
  }
  async function pdf(plan) {
    const mark = svg(plan);
    if (!mark) throw new Error('No plan to print');
    const img = new Image();
    await new Promise((ok, no) => {
      img.onload = ok;
      img.onerror = () => no(new Error('The plan could not be drawn'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(mark);
    });
    const c = document.createElement('canvas');
    c.width = 2000;
    c.height = Math.round(2000 * (img.naturalHeight || img.height) / (img.naturalWidth || img.width));
    const x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, c.width, c.height);
    x.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.92));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return new Blob([pdfBytes(bytes, c.width, c.height)], { type: 'application/pdf' });
  }

  window.YDPlan = { svg: svg, pdf: pdf, key: key, lengthOf: lengthOf, areaOf: areaOf };
})();
