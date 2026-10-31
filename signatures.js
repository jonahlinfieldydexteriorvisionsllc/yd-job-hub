// Signed papers on a job: a change order, a sign-off when the work is
// finished, or anything else -- signed by the customer with a finger on the
// iPad (or a phone), saved on the job as a PDF.
//
// Jonah (15 Oct 2026): yes to "customers sign change orders and sign-offs on
// the iPad inside Job Hub" (Lumin PDF stays for the odd one-off PDF).
//
//   - What: a change order (what is changing, the price going up or down,
//     what it does to the schedule), a sign-off (the work finished, the
//     walk-through notes) or anything else (a title and the words).
//   - The customer signs in the box, types their name and ticks that they
//     agree; the date and time are filled in by themselves.
//   - The phone makes the PDF itself -- no library fetched from the
//     internet, so it works in a yard with no signal -- with the job, the
//     words, the signature, who signed, when, who collected it, and a
//     fingerprint (SHA-256) of what was signed, so a later edit would show.
//     Wisconsin's electronic signatures law (Wis. Stat. ch. 137) asks that
//     the record show who signed, what and when: the PDF, the fingerprint
//     and the record kept here do. No legal wording beyond that without
//     Jonah.
//   - Saved: the PDF to Cloud Storage, jobDocs/{jobId}/{uid}/{docId}.pdf
//     (storage.rules), and its record jobDocs/{docId} (firestore.rules).
//     Signed with no signal, the record waits in Firestore's own queue and
//     the PDF on the phone (IndexedDB), and both go when there is signal --
//     the way job photos do (jobphotos.js).
//   - Email a copy to the customer, and a change order's price onto the
//     job's QuickBooks invoice: buttons, his tap, never by themselves
//     (functions/jobdocs.py, quickbooks.add_change_order).
//   - The crew collect sign-offs and anything else; a change order, which
//     carries a price, is for whoever may change jobs. The crew never see a
//     price here.

(function () {
  'use strict';

  const KINDS = [
    ['change', '🔁 Change order', 'Something is changing — price or schedule'],
    ['signoff', '✅ Sign-off', 'The work is finished'],
    ['other', '✍️ Something else', 'Any other paper to sign'],
  ];
  const KIND_NAME = { change: 'Change order', signoff: 'Sign-off', other: 'Signed paper' };
  const AGREE = {
    change: 'I agree to the change above.',
    changePrice: 'I agree to the change above, including the price change.',
    signoff: 'I confirm the work above is finished.',
    other: 'I agree to the above.',
  };
  const el = id => document.getElementById(id);
  const safe = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const signedIn = () => !!(window.YDAuth && YDAuth.mode === 'cloud' && YDAuth.user);
  const myUid = () => (signedIn() ? YDAuth.user.uid : '');
  const can = (area, level) => typeof ydCan === 'function' && ydCan(area, level);
  const newId = () => 'sg' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const money = c => (c < 0 ? '−' : '+') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = iso => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  function myName() {
    const me = window.YDRemind && YDRemind.me ? YDRemind.me() : null;
    const u = signedIn() ? YDAuth.user : {};
    return String((me && me.name) || u.displayName || String(u.email || '').split('@')[0] || 'Someone').slice(0, 80);
  }

  // ----------------------------------------------------------- the PDF
  //
  // A small PDF written by hand: Letter pages, Helvetica (built into every
  // PDF reader, so nothing is embedded), and the signature as a JPEG. Text
  // is Latin-1; curly quotes and dashes are turned into plain ones.

  const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556,
    222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
  const latin = s => String(s == null ? '' : s)
    .replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/[–—−]/g, '-')
    .replace(/…/g, '...').replace(/[•·]/g, '-').replace(/ /g, ' ').replace(/\r/g, '')
    .replace(/[^\n\x20-\x7e\xa0-\xff]/g, '?');
  const pdfStr = s => '(' + latin(s).replace(/[\\()]/g, c => '\\' + c) + ')';
  function widthOf(s, size, bold) {
    let w = 0;
    for (const ch of latin(s)) { const c = ch.charCodeAt(0); w += c >= 32 && c <= 126 ? W_REG[c - 32] : 556; }
    return w * size / 1000 * (bold ? 1.06 : 1);
  }
  function wrap(text, size, bold, max) {
    const out = [];
    latin(text).split('\n').forEach(par => {
      let line = '';
      par.split(/(\s+)/).forEach(word => {
        if (!word) return;
        const next = line + word;
        if (widthOf(next.trimEnd(), size, bold) <= max || !line.trim()) { line = next; return; }
        out.push(line.trimEnd());
        line = word.trimStart();
        // A word longer than the line (a long web address) is cut.
        while (widthOf(line, size, bold) > max && line.length > 1) {
          let n = line.length;
          while (n > 1 && widthOf(line.slice(0, n), size, bold) > max) n--;
          out.push(line.slice(0, n)); line = line.slice(n);
        }
      });
      out.push(line.trimEnd());
    });
    return out;
  }

  // Pages of drawing commands, laid out top to bottom.
  function layout(parts, sig) {
    const PW = 612, PH = 792, M = 54, MAXW = PW - 2 * M;
    const pages = [];
    let ops = [], y = PH - M;
    const newPage = () => { pages.push(ops); ops = []; y = PH - M; };
    const room = h => { if (y - h < M + 30) newPage(); };
    const text = (s, size, bold, grey, x) => {
      ops.push('BT /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf ' + (grey ? '0.4 0.4 0.4 rg ' : '0 0 0 rg ') +
        (x || M).toFixed(2) + ' ' + y.toFixed(2) + ' Td ' + pdfStr(s) + ' Tj ET');
    };
    const para = (s, size, bold, grey, after) => {
      wrap(s, size, bold, MAXW).forEach(l => { room(size * 1.35); y -= size * 1.35; text(l, size, bold, grey); });
      y -= after == null ? 6 : after;
    };
    const rule = () => { room(10); y -= 6; ops.push('0.75 0.75 0.75 RG 0.6 w ' + M + ' ' + y.toFixed(2) + ' m ' + (PW - M) + ' ' + y.toFixed(2) + ' l S'); y -= 10; };
    parts.forEach(p => {
      if (p.rule) return rule();
      if (p.gap) { y -= p.gap; return; }
      if (p.label) {
        room(30);
        para(p.label, 9, true, true, 1);
        para(p.text || '-', 11, false, false, 10);
        return;
      }
      para(p.text, p.size || 11, !!p.bold, !!p.grey, p.after);
    });
    // The signature: the picture over a line, then who and when.
    if (sig) {
      const w = 240, h = Math.round(w * sig.h / sig.w);
      room(h + 70);
      y -= h + 4;
      ops.push('q ' + w + ' 0 0 ' + h + ' ' + M + ' ' + y.toFixed(2) + ' cm /Im1 Do Q');
      y -= 4;
      ops.push('0 0 0 RG 0.8 w ' + M + ' ' + y.toFixed(2) + ' m ' + (M + 300) + ' ' + y.toFixed(2) + ' l S');
      (sig.under || []).forEach(l => para(l.text, l.size || 10, !!l.bold, !!l.grey, 0));
    }
    pages.push(ops);
    return pages;
  }

  function pdfBytes(pages, jpeg) {
    const chunks = [], offsets = [];
    let len = 0;
    const add = part => {
      const b = typeof part === 'string' ? Uint8Array.from(part, c => c.charCodeAt(0) & 255) : part;
      chunks.push(b); len += b.length;
    };
    const objs = [];             // index = object number - 1: array of parts
    const obj = parts => { objs.push(parts); return objs.length; };
    const fonts = [obj(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']),
                   obj(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'])];
    const img = jpeg ? obj(['<< /Type /XObject /Subtype /Image /Width ' + jpeg.w + ' /Height ' + jpeg.h +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.bytes.length + ' >>\nstream\n',
      jpeg.bytes, '\nendstream']) : 0;
    const res = '/Resources << /Font << /F1 ' + fonts[0] + ' 0 R /F2 ' + fonts[1] + ' 0 R >>' +
      (img ? ' /XObject << /Im1 ' + img + ' 0 R >>' : '') + ' >>';
    const kids = [];
    const pagesId = obj(null);   // filled once the kids are known
    pages.forEach(ops => {
      const body = ops.join('\n');
      const content = obj(['<< /Length ' + body.length + ' >>\nstream\n' + body + '\nendstream']);
      kids.push(obj(['<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 612 792] ' + res + ' /Contents ' + content + ' 0 R >>']));
    });
    objs[pagesId - 1] = ['<< /Type /Pages /Kids [' + kids.map(k => k + ' 0 R').join(' ') + '] /Count ' + kids.length + ' >>'];
    const catalog = obj(['<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>']);
    add('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    objs.forEach((parts, i) => {
      offsets.push(len);
      add((i + 1) + ' 0 obj\n');
      parts.forEach(add);
      add('\nendobj\n');
    });
    const xref = len;
    add('xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' +
      offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join(''));
    add('trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalog + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    const out = new Uint8Array(len);
    let at = 0;
    chunks.forEach(c => { out.set(c, at); at += c.length; });
    return out;
  }

  async function sha256(bytes) {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const utf8 = s => new TextEncoder().encode(s);
  const joinBytes = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

  // ------------------------------------------------- the signature box

  let pad = null;              // { canvas, ctx, ink, last }
  function startPad(canvas) {
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const box = canvas.getBoundingClientRect();
    canvas.width = Math.round(box.width * ratio);
    canvas.height = Math.round(box.height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, box.width, box.height);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
    pad = { canvas: canvas, ctx: ctx, ink: 0, last: null, down: false };
    const at = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.onpointerdown = e => {
      e.preventDefault();
      // Ink counts as typed (app.js guardWindows, backClosesWindows): a stray
      // tap outside, or the phone's Back -- an iPad's swipe from the edge,
      // right beside the box -- threw a customer's signature away without a
      // word, where Esc asks first.
      const win = canvas.closest('.modal-overlay');
      if (win) win.dataset.typed = '1';
      canvas.setPointerCapture(e.pointerId);
      pad.down = true; pad.last = at(e);
      ctx.beginPath(); ctx.arc(pad.last.x, pad.last.y, 1.1, 0, Math.PI * 2); ctx.fillStyle = '#111'; ctx.fill();
    };
    canvas.onpointermove = e => {
      if (!pad.down) return;
      e.preventDefault();
      const p = at(e), l = pad.last;
      ctx.beginPath(); ctx.moveTo(l.x, l.y);
      ctx.quadraticCurveTo(l.x, l.y, (l.x + p.x) / 2, (l.y + p.y) / 2);
      ctx.lineTo(p.x, p.y); ctx.stroke();
      pad.ink += Math.hypot(p.x - l.x, p.y - l.y);
      pad.last = p;
      readyCheck();
    };
    canvas.onpointerup = canvas.onpointercancel = () => { pad.down = false; readyCheck(); };
  }
  // The iPad turned on its side: an empty box is laid out again for its new
  // size (a signed one is left as it is -- Clear redoes it).
  window.addEventListener('resize', () => {
    if (pad && !pad.ink && pad.canvas.isConnected) startPad(pad.canvas);
  });
  window.sgClear = function () {
    if (!pad) return;
    const box = pad.canvas.getBoundingClientRect();
    pad.ctx.fillStyle = '#fff'; pad.ctx.fillRect(0, 0, box.width, box.height);
    pad.ink = 0;
    readyCheck();
  };
  // The signature as a JPEG, cropped to where the ink is.
  function signatureJpeg() {
    const c = pad.canvas, g = c.getContext('2d');
    const data = g.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
      const i = (y * c.width + x) * 4;
      if (data[i] < 200) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    const padPx = 12;
    x0 = Math.max(0, x0 - padPx); y0 = Math.max(0, y0 - padPx);
    x1 = Math.min(c.width, x1 + padPx); y1 = Math.min(c.height, y1 + padPx);
    const w = Math.max(40, x1 - x0), h = Math.max(20, y1 - y0);
    // Never taller than a third of its width, so it sits on the line.
    const out = document.createElement('canvas');
    const scale = Math.min(1, 900 / w);
    out.width = Math.round(w * scale); out.height = Math.round(Math.max(h, w / 3) * scale);
    const o = out.getContext('2d');
    o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height);
    o.drawImage(c, x0, y0, w, h, 0, (out.height - h * scale) / 2, w * scale, h * scale);
    const url = out.toDataURL('image/jpeg', 0.9);
    const bin = atob(url.split(',')[1]);
    return { bytes: Uint8Array.from(bin, ch => ch.charCodeAt(0)), w: out.width, h: out.height };
  }

  // --------------------------------------------------------- the window

  let form = null;             // { jobId, info, kind }
  function modal() {
    let m = el('sgModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal-overlay';
      m.id = 'sgModal';
      m.innerHTML = '<div class="modal sg-modal"><div class="modal-head"><h2>Get a signature</h2>' +
        '<button class="modal-close" onclick="sgClose()" aria-label="Close">&times;</button></div><div class="modal-body" id="sgBody"></div></div>';
      document.body.appendChild(m);
    }
    m.classList.add('active');
    return el('sgBody');
  }
  window.sgClose = function () {
    const m = el('sgModal');
    if (m) m.classList.remove('active');
    form = null; pad = null;
  };
  let asking = false;           // the "close without saving?" question is up
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || asking || !form || !el('sgModal') || !el('sgModal').classList.contains('active')) return;
    e.stopPropagation();
    if (!(pad && pad.ink)) { sgClose(); return; }
    asking = true;
    ydConfirm('Close without saving the signature?', { ok: 'Close it', cancel: 'Keep signing', danger: true })
      .then(ok => { asking = false; if (ok) sgClose(); });
  }, true);

  const kindsFor = () => KINDS.filter(([k]) => k !== 'change' || can('jobs', 'change'));

  // Step one: what is being signed.
  window.sgStart = function (jobId) {
    if (!signedIn()) { showToast('Sign in first'); return; }
    const info = infoFor(jobId);
    if (!jobId || !info) { showToast('Save the job first, then get a signature'); return; }
    form = { jobId: jobId, info: info, kind: '' };
    modal().innerHTML = '<p class="sg-for">' + esc(info.name) + (info.address ? ' · ' + esc(info.address) : '') + '</p>' +
      '<div class="sg-kinds">' + kindsFor().map(([k, name, hint]) =>
        '<button type="button" class="sg-kind" onclick="sgKind(\'' + k + '\')"><b>' + esc(name) + '</b><small>' + esc(hint) + '</small></button>').join('') +
      '</div>';
  };

  // Step two: the words, the signature, the name.
  window.sgKind = function (kind) {
    if (!form || !KIND_NAME[kind] || (kind === 'change' && !can('jobs', 'change'))) return;
    form.kind = kind;
    const info = form.info;
    const field = (id, label, html) => '<div class="field"><span class="label">' + label + '</span>' + html + '</div>';
    const area = (id, ph, val) => '<textarea id="' + id + '" rows="4" placeholder="' + esc(ph) + '" oninput="sgReady()">' + esc(val || '') + '</textarea>';
    let body = '';
    if (kind === 'change') {
      body = field('sgWhat', 'What is changing', area('sgWhat', 'e.g. Add a 3-ft extension to the patio on the garage side')) +
        '<div class="field"><span class="label">Price change</span><div class="sg-price">' +
          '<label class="sg-sign"><input type="radio" name="sgSign" value="1" checked onchange="sgReady()"> Adds</label>' +
          '<label class="sg-sign"><input type="radio" name="sgSign" value="-1" onchange="sgReady()"> Takes off</label>' +
          '<span class="sg-dollar">$</span><input id="sgAmount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00" oninput="sgReady()">' +
        '</div><div class="hint">Leave it empty when the price does not change.</div></div>' +
        field('sgSchedule', 'What it does to the schedule', '<input id="sgSchedule" placeholder="e.g. One more day; no change">');
    } else if (kind === 'signoff') {
      body = field('sgWork', 'The work finished', area('sgWork', 'What was done', (info.work || []).join('\n'))) +
        field('sgNotes', 'Walk-through notes', area('sgNotes', 'Anything the customer pointed out, or to come back for'));
    } else {
      body = field('sgTitle', 'What it is', '<input id="sgTitle" placeholder="e.g. Permission to park the trailer on the lawn" oninput="sgReady()">') +
        field('sgText', 'The words', area('sgText', 'What the customer is agreeing to'));
    }
    modal().innerHTML = '<p class="sg-for"><b>' + esc(KIND_NAME[kind]) + '</b> · ' + esc(info.name) +
        (info.address ? ' · ' + esc(info.address) : '') + '</p>' + body +
      '<div class="field"><span class="label">Customer signs here</span>' +
        '<div class="sg-pad-wrap"><canvas id="sgPad" class="sg-pad" aria-label="Signature box"></canvas>' +
        '<button type="button" class="btn btn-sm sg-clear" onclick="sgClear()">Clear</button></div></div>' +
      field('sgName', 'Customer’s name, printed', '<input id="sgName" autocomplete="off" value="' + esc(info.customer || '') + '" oninput="sgReady()">') +
      '<label class="chk sg-agree"><input type="checkbox" id="sgAgree" onchange="sgReady()"> <span id="sgAgreeText"></span></label>' +
      '<p class="hint">Signed now, ' + esc(new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })) +
        ', collected by ' + esc(myName()) + '. The PDF is saved on the job' + (navigator.onLine === false ? ' — and sent as soon as there is signal.' : '.') + '</p>' +
      '<div class="field-actions"><button class="btn btn-filled" id="sgSave" onclick="sgSave()" disabled>Sign &amp; save</button>' +
        '<button class="btn btn-sm" onclick="sgStart(\'' + safe(form.jobId) + '\')">Back</button></div>';
    startPad(el('sgPad'));
    sgReady();
  };
  function amountCents() {
    // A minus typed in the box means the same as "Takes off" (the box once
    // read it as no price change at all, and said nothing).
    const v = Math.abs(parseFloat((el('sgAmount') || {}).value));
    if (!isFinite(v) || v <= 0) return null;
    const sign = (document.querySelector('input[name="sgSign"]:checked') || {}).value === '-1' ? -1 : 1;
    return sign * Math.round(v * 100);
  }
  function agreeText() {
    if (!form) return '';
    if (form.kind === 'change') return amountCents() ? AGREE.changePrice : AGREE.change;
    return AGREE[form.kind];
  }
  function missing() {
    if (!form) return 'x';
    const v = id => String((el(id) || {}).value || '').trim();
    if (form.kind === 'change' && !v('sgWhat')) return 'Say what is changing';
    if (form.kind === 'signoff' && !v('sgWork')) return 'Say what work is finished';
    if (form.kind === 'other' && (!v('sgTitle') || !v('sgText'))) return 'Fill in what it is and the words';
    if (!pad || pad.ink < 25) return 'The customer signs in the box';
    if (!v('sgName')) return 'Type the customer’s name';
    if (!(el('sgAgree') || {}).checked) return 'Tick that they agree';
    return '';
  }
  function readyCheck() { window.sgReady(); }
  // What the customer is agreeing to, as the boxes say it now. Ticked, then
  // the words or the price changed: the tick no longer stands for what is
  // on the paper, so it comes off and they tick it again.
  let agreedTo = null;
  function termsNow() {
    const v = id => String((el(id) || {}).value || '').trim();
    return JSON.stringify([amountCents(), v('sgWhat'), v('sgWork'), v('sgNotes'), v('sgTitle'), v('sgText'), v('sgSchedule')]);
  }
  window.sgReady = function () {
    const box = el('sgAgree');
    if (box && box.checked) {
      const now = termsNow();
      if (agreedTo === null) agreedTo = now;
      else if (agreedTo !== now) { box.checked = false; agreedTo = null; showToast('The paper changed — they tick “I agree” again'); }
    } else agreedTo = null;
    const t = el('sgAgreeText');
    if (t) t.textContent = agreeText();
    const b = el('sgSave');
    if (b) { const m = missing(); b.disabled = !!m; b.title = m; }
  };

  // Sign & save: the record, the PDF, both on their way.
  window.sgSave = async function () {
    const why = missing();
    if (why) { showToast(why); return; }
    const f = form, info = f.info;
    const v = id => String((el(id) || {}).value || '').trim();
    const signedAt = new Date();
    const id = newId(), uid = myUid();
    const rec = {
      jobId: f.jobId, jobName: info.name, kind: f.kind,
      title: f.kind === 'other' ? v('sgTitle').slice(0, 200) : KIND_NAME[f.kind],
      what: f.kind === 'change' ? v('sgWhat').slice(0, 5000) : null,
      amountCents: f.kind === 'change' ? amountCents() : null,
      schedule: f.kind === 'change' ? v('sgSchedule').slice(0, 500) : null,
      work: f.kind === 'signoff' ? v('sgWork').slice(0, 5000) : null,
      notes: f.kind === 'signoff' ? v('sgNotes').slice(0, 5000) : null,
      text: f.kind === 'other' ? v('sgText').slice(0, 5000) : null,
      address: info.address || '', jobNumber: info.number || '',
      agreed: agreeText(),
      signedName: v('sgName').slice(0, 120), signedAt: signedAt.toISOString(),
      by: uid, byName: myName(),
    };
    const btn = el('sgSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const sig = signatureJpeg();
      // The fingerprint: everything signed, and the signature itself.
      const content = JSON.stringify(rec);
      rec.contentHash = await sha256(joinBytes(utf8(content), sig.bytes));
      const pdf = pdfBytes(layout(pdfParts(rec), Object.assign({}, sig, { under: underLines(rec) })), sig);
      rec.pdfHash = await sha256(pdf);
      rec.path = 'jobDocs/' + f.jobId + '/' + uid + '/' + id + '.pdf';
      rec.size = pdf.length;
      rec.pending = true;
      rec.createdAt = new Date().toISOString();
      const item = { id: id, by: uid, jobId: f.jobId, path: rec.path, pdf: new Blob([pdf], { type: 'application/pdf' }) };
      queue[id] = item;
      await qSave(item);
      // Not awaited: with no signal it waits in Firestore's own queue.
      Promise.resolve(window.YDDb.put('jobDocs', id, rec)).catch(e => {
        console.warn('[signatures] record not saved:', (e && e.code) || e);
        showToast(e && e.code === 'permission-denied' ? 'Not allowed to save that' : 'Not saved yet — it will try again');
      });
      docs[id] = Object.assign({ _local: true }, rec);
      sgClose();
      drawAll();
      send(item);
      showToast('Signed and saved');
    } catch (e) {
      console.warn('[signatures] could not make the PDF:', e);
      showToast('Could not make the PDF — nothing was saved. Try again.');
      if (btn) { btn.disabled = false; btn.textContent = 'Sign & save'; }
    }
  };

  // What the PDF says, top to bottom.
  function pdfParts(r) {
    const day = new Date(r.signedAt);
    const parts = [
      { text: 'YD Exterior Visions LLC', size: 16, bold: true, after: 2 },
      { text: r.kind === 'other' ? r.title : r.kind === 'change' ? 'CHANGE ORDER' : 'SIGN-OFF - WORK FINISHED', size: 13, bold: true, after: 8 },
      { rule: true },
      { text: 'Customer: ' + (r.jobName || ''), after: 1 },
    ];
    if (r.address) parts.push({ text: 'Job site: ' + r.address, after: 1 });
    if (r.jobNumber) parts.push({ text: 'Job #: ' + r.jobNumber, after: 1 });
    parts.push({ text: 'Date: ' + day.toLocaleDateString('en-US', { dateStyle: 'long' }), after: 4 }, { rule: true });
    if (r.kind === 'change') {
      parts.push({ label: 'What is changing', text: r.what });
      if (r.amountCents) parts.push({ label: 'Price change', text: money(r.amountCents) + (r.amountCents > 0 ? ' (added to the job)' : ' (taken off the job)') });
      if (r.schedule) parts.push({ label: 'Schedule', text: r.schedule });
    } else if (r.kind === 'signoff') {
      parts.push({ label: 'Work finished', text: r.work });
      if (r.notes) parts.push({ label: 'Walk-through notes', text: r.notes });
    } else {
      parts.push({ label: 'Details', text: r.text });
    }
    parts.push({ gap: 6 }, { text: r.agreed, bold: true, after: 8 });
    return parts;
  }
  function underLines(r) {
    const d = new Date(r.signedAt);
    return [
      { text: 'Signed by: ' + r.signedName, bold: true },
      { text: 'Signed on: ' + d.toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric',
        minute: '2-digit', timeZoneName: 'short' }) },
      { text: 'Collected by: ' + r.byName + ', for YD Exterior Visions LLC' },
      { text: ' ', size: 6 },
      { text: 'Signed electronically in YD Job Hub. Fingerprint (SHA-256) of what was signed and the signature:', size: 7, grey: true },
      { text: r.contentHash, size: 7, grey: true },
    ];
  }

  // ----------------------------------------- the PDF waiting on this phone

  const DB_NAME = 'ydjobhub_sigs', STORE = 'queue';
  let dbp = null;
  function idb() {
    if (!dbp) dbp = new Promise((res, rej) => {
      if (!window.indexedDB) { rej(new Error('no IndexedDB')); return; }
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  function tx(mode, fn) {
    return idb().then(db => new Promise((res, rej) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => res(out && out.result);
      t.onerror = () => rej(t.error);
    }));
  }
  const qSave = item => tx('readwrite', s => s.put(item)).catch(e => console.warn('[signatures] kept in memory only:', e));
  const qDrop = id => tx('readwrite', s => s.delete(id)).catch(() => {});
  const qLoad = () => tx('readonly', s => s.getAll()).catch(() => []);
  const queue = {}, busy = {};

  async function send(item) {
    if (busy[item.id] || !window.YDStore || !window.YDDb || item.by !== myUid() || navigator.onLine === false) return;
    busy[item.id] = true;
    try {
      // Written once (storage.rules): asked for first after a try that died.
      let there = false;
      if (item.tries) { try { await YDStore.url(item.path); there = true; } catch (e) { if (!e || e.code !== 'storage/object-not-found') throw e; } }
      item.tries = (item.tries || 0) + 1;
      if (!there) await YDStore.upload(item.path, item.pdf, 'application/pdf');
      await Promise.resolve(window.YDDb.put('jobDocs', item.id, { pending: false, sentAt: new Date().toISOString() }));
      delete queue[item.id];
      qDrop(item.id);
      if (docs[item.id]) docs[item.id].pending = false;
    } catch (e) {
      console.warn('[signatures] PDF not sent yet:', (e && e.code) || e);
      qSave(item);
    } finally {
      delete busy[item.id];
      drawAll();
    }
  }
  function sendWaiting() {
    if (!signedIn()) return;
    Object.values(queue).forEach(it => { if (it.by === myUid()) send(it); });
  }
  async function loadQueue() {
    (await qLoad() || []).forEach(it => { if (it && it.id && !queue[it.id]) queue[it.id] = it; });
    drawAll();
    sendWaiting();
  }

  // ---------------------------------------------------- the list on a job

  let jobId = null, docs = {}, unsub = null, loaded = false;
  const mounts = new Map();    // container -> info for the PDF
  function watch(id) {
    if (unsub) { try { unsub(); } catch (e) { /* gone */ } }
    unsub = null; docs = {}; loaded = false; jobId = id;
    if (!id || !signedIn() || !window.YDDb) { drawAll(); return; }
    const take = (changes, meta) => {
      changes.forEach(c => {
        if (c.type === 'removed') { delete docs[c.id]; return; }
        if (c.data && c.data.jobId === jobId) docs[c.id] = c.data;
      });
      if (meta && !meta.fromCache) loaded = true;
      drawAll();
    };
    // Whoever may see jobs: every paper on the job. The crew: theirs.
    unsub = can('jobs', 'see') ? window.YDDb.watchWhere('jobDocs', 'jobId', id, take, () => { loaded = true; drawAll(); })
      : window.YDDb.watchWhere('jobDocs', 'by', myUid(), take, () => { loaded = true; drawAll(); });
  }
  // Show job `id`'s signed papers in `container`; `info` is what the PDF
  // says about the job (the crew's job page has no job form to read).
  function mount(container, id, info) {
    if (!container) return;
    mounts.forEach((v, c) => { if (!c.isConnected) mounts.delete(c); });
    mounts.set(container, info || null);
    container.setAttribute('data-job', safe(id || ''));
    if (id !== jobId) watch(id || null); else draw(container);
  }
  // The job as the PDF names it: from the container that asked, else the
  // Job tab's form.
  function infoFor(id) {
    let got = null;
    mounts.forEach((info, c) => { if (!got && info && c.getAttribute('data-job') === safe(id)) got = info; });
    if (got) return got;
    if (typeof currentJobId === 'undefined' || currentJobId !== id) return null;
    const v = f => String((el(f) || {}).value || '').trim();
    let work = [];
    try {
      const raw = typeof readJobBlob === 'function' ? readJobBlob(id) : null;
      const j = raw ? JSON.parse(raw) : null;
      work = ((j && j.estimate && j.estimate.work) || []).map(w => String(w.title || '').trim()).filter(Boolean).slice(0, 20);
    } catch (e) { /* none */ }
    const name = v('customerName') || 'Customer';
    return { name: name, customer: [v('firstName'), v('lastName')].filter(Boolean).join(' ') || name,
             address: [v('address'), v('city'), [v('state'), v('zip')].filter(Boolean).join(' ')].filter(Boolean).join(', '),
             number: v('estimateNumber'), work: work };
  }

  function rowHtml(id, d) {
    const local = queue[id];
    const sees = can('jobs', 'see'), changes = can('jobs', 'change');
    const chips = [];
    if (d.pending || local) chips.push('<span class="sg-chip wait">PDF waiting for signal</span>');
    if (d.emailed && d.emailed.ok) chips.push('<span class="sg-chip done">✓ Emailed ' + esc(when(d.emailed.at)) + '</span>');
    if (d.qb && d.qb.ok) chips.push('<span class="sg-chip done">✓ On QuickBooks ' + esc(d.qb.entity === 'Estimate' ? 'estimate' : 'invoice') +
      (d.qb.docNumber ? ' #' + esc(d.qb.docNumber) : '') + '</span>');
    const what = d.kind === 'change' ? d.what : d.kind === 'signoff' ? d.work : d.text;
    return '<div class="sg-row">' +
      '<div class="sg-row-main"><b>' + esc(d.kind === 'other' ? d.title : KIND_NAME[d.kind] || 'Signed') + '</b>' +
        (sees && d.kind === 'change' && d.amountCents ? ' <span class="sg-amt">' + esc(money(d.amountCents)) + '</span>' : '') +
        '<div class="sg-row-what">' + esc(String(what || '').split('\n')[0].slice(0, 140)) + '</div>' +
        '<small>Signed by ' + esc(d.signedName || '') + ' · ' + esc(when(d.signedAt)) + (d.byName ? ' · collected by ' + esc(d.byName) : '') + '</small>' +
        (chips.length ? '<div class="sg-chips">' + chips.join('') + '</div>' : '') +
      '</div>' +
      '<div class="sg-acts">' +
        '<a class="btn btn-sm sg-open" data-sg="' + safe(id) + '" target="_blank" rel="noopener">📄 Open PDF</a>' +
        (changes && !d.pending && !local ? '<button class="btn btn-sm" onclick="sgEmail(\'' + safe(id) + '\')">✉️ ' +
          (d.emailed && d.emailed.ok ? 'Email again' : 'Email a copy') + '</button>' : '') +
        (can('billing', 'change') && d.kind === 'change' && d.amountCents && !(d.qb && d.qb.ok) && !d.pending && !local
          ? '<button class="btn btn-sm" onclick="sgQb(\'' + safe(id) + '\')">Add to QuickBooks</button>' : '') +
      '</div></div>';
  }
  function draw(container) {
    const id = container.getAttribute('data-job');
    if (!signedIn()) { container.innerHTML = ''; return; }
    const onJobTab = container.id === 'jobSigsBody';
    if (!id) { container.innerHTML = onJobTab ? '<p class="muted">Save the job first, then get a signature.</p>' : ''; return; }
    const list = Object.keys(docs).filter(k => docs[k].jobId === id)
      .sort((a, b) => String(docs[b].signedAt || '').localeCompare(String(docs[a].signedAt || '')));
    container.innerHTML = (onJobTab ? '' : '<div class="cj-h">✍️ Signatures</div>') +
      '<button type="button" class="btn sg-start" onclick="sgStart(\'' + safe(id) + '\')">✍️ Get a signature</button>' +
      (list.length ? '<div class="sg-list">' + list.map(k => rowHtml(k, docs[k])).join('') + '</div>'
        : '<p class="muted">' + (loaded || navigator.onLine === false ? 'Nothing signed yet — change orders and sign-offs go here.' : 'Loading…') + '</p>');
    fillLinks(container);
  }
  function drawAll() { mounts.forEach((info, c) => { if (!c.isConnected) mounts.delete(c); else draw(c); }); }
  // The PDF's address: the copy on this phone while it waits, else Storage.
  function fillLinks(container) {
    container.querySelectorAll('a.sg-open[data-sg]').forEach(a => {
      const id = a.dataset.sg, local = queue[id], d = docs[id];
      if (local && local.pdf) { a.href = URL.createObjectURL(local.pdf); return; }
      if (!d || !d.path || !window.YDStore) return;
      YDStore.url(d.path).then(u => { a.href = u; }).catch(() => { a.classList.add('missing'); a.title = 'Not found yet'; });
    });
  }

  window.sgEmail = async function (id) {
    const d = docs[id];
    if (!d || !can('jobs', 'change')) return;
    if (!(await ydConfirm('Email the signed ' + (KIND_NAME[d.kind] || 'paper').toLowerCase() + ' PDF to the customer now?',
      { title: 'Email a copy', ok: 'Email it' }))) return;
    showToast('Sending…');
    try {
      const r = await YDClaude.post('/docs/email', { docId: id });
      if (r && r.error) throw new Error(r.error);
      showToast('Emailed to ' + ((r && r.to) || 'the customer'));
    } catch (e) { showToast((e && e.message) || 'Not sent — try again'); }
  };
  window.sgQb = async function (id) {
    const d = docs[id];
    if (!d || !can('billing', 'change')) return;
    if (!(await ydConfirm('Add this change order (' + money(d.amountCents) + ') to the job’s QuickBooks invoice, with the signed PDF attached?',
      { title: 'Add to QuickBooks', ok: 'Add it' }))) return;
    showToast('Adding to QuickBooks…');
    try {
      const r = await YDClaude.post('/qb/change-order', { docId: id });
      if (r && r.error) throw new Error(r.error);
      showToast('On QuickBooks ' + (r.entity === 'Estimate' ? 'estimate' : 'invoice') + (r.docNumber ? ' #' + r.docNumber : '') +
        (r.attachError ? ' — attach the PDF by hand (' + r.attachError + ')' : ''));
    } catch (e) { showToast((e && e.message) || 'Not added — try again'); }
  };

  // The Job tab: a section after the photos (app.js jobOnScreen).
  function jobShown(id) {
    if (!can('jobs', 'see')) return;
    let sec = el('jobSigsSection');
    if (!sec) {
      const after = el('jobPhotosSection') || el('estimateSection');
      if (!after) return;
      sec = document.createElement('div');
      sec.className = 'section';
      sec.id = 'jobSigsSection';
      sec.innerHTML = '<div class="section-head"><span class="section-title">Signatures</span></div>' +
        '<div class="section-body" id="jobSigsBody"></div>';
      after.insertAdjacentElement('afterend', sec);
    }
    mount(el('jobSigsBody'), id || '', null);
  }

  let who = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user ? a.user.uid + ':' + (a.key || a.role) : null;
    if (k === who) return;
    who = k;
    sgClose();
    if (!k) { watch(null); return; }
    if (jobId) watch(jobId);
    loadQueue();
    if (typeof currentJobId !== 'undefined') jobShown(currentJobId);
  });
  window.addEventListener('online', sendWaiting);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sendWaiting(); });

  window.YDSignatures = { mount: mount, jobShown: jobShown, waiting: () => Object.values(queue).filter(q => q.by === myUid()).length,
                          _pdf: { layout: layout, pdfBytes: pdfBytes, wrap: wrap } };
})();
