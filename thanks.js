// The thank-you a customer gets once their job is paid off -- the app's side.
//
// Jonah (26 Oct 2026): "routine so when a final payment is recieved for an
// invoice in quickbooks email is sent thanking for choosing us and requesting
// a review". The server sends it (functions/followup.py: the hourly run, in
// the morning, and thanks_now for "Send it now"). Here:
//   - the owner's settings for it, settings/followUp: his Google review link,
//     sent by itself or put in his Gmail Drafts (thanksSend false), and his
//     own words for it -- ⋯ → All settings → Follow-ups & thank-yous
//     (search.js), the button on the Bids board, and Home;
//   - the line on a finished job, under its invoice (estimate.js): sent,
//     drafted, held and why, or when it will go -- with "Don't send a
//     thank-you" (noThanks on the job) and "Send it now";
//   - Home's "Waiting on you" lines for the ones held.
// The rules are followup.py's -- change both: paid off in QuickBooks, on or
// after the day it started (thanksFrom), within WITHIN_DAYS, the review link
// saved, an email to send it to that is the customer's.
(function () {
  'use strict';

  const WITHIN_DAYS = 30;            // followup.THANKS_WITHIN_DAYS
  const LAST_RUN_HOUR = 11;          // followup.SEND_HOURS: 8, 9, 10 and 11 o'clock
  // followup.py THANKS_SUBJECT / THANKS_BODY -- the same words.
  const SUBJECT = 'Thank you from YD Exterior Visions';
  const BODY = 'Hi {name},\n\n' +
    'Thank you for choosing YD Exterior Visions for your {work}. It was a pleasure working with you, ' +
    'and I hope you enjoy it for years to come.\n\n' +
    'If you have a minute, a Google review would mean a lot to us:\n' +
    '{link}\n\n' +
    'And if anything ever comes up, just reply to this email.\n\n' +
    'Thanks again,\n' +
    'Jonah\n' +
    'YD Exterior Visions';

  const safeId = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const can = (area, level) => typeof ydCan === 'function' && ydCan(area, level);
  const looksLikeEmail = s => /^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$/i.test(String(s || '').trim());
  const mailLink = s => /^https:\/\/mail\.google\.com\//.test(String(s || ''));
  const day = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
  const ymd = iso => { const d = new Date(iso); return isNaN(d) ? '' : localYMD(d); };

  let conf = null;          // settings/followUp, once read (the owner reads it); null: not known
  let unsub = null;
  const busy = {};          // job id -> "Send it now" waiting on the server
  const justSent = {};      // job id -> the record the server answered with, until the job brings it

  function changed() {
    document.dispatchEvent(new CustomEvent('yd-thanks'));
    if (window.YDEstimate && YDEstimate.redrawCare) YDEstimate.redrawCare();
  }
  function stop() {
    if (unsub) { try { unsub(); } catch (e) { /* gone already */ } }
    unsub = null;
    conf = null;
  }
  function start() {
    stop();
    if (!isOwner() || !window.YDDb || !window.YDDb.watch) return;
    // The owner may read every settings record; only this one is wanted.
    unsub = window.YDDb.watch('settings', (changes, meta) => {
      const c = changes.find(x => x.id === 'followUp');
      if (c) conf = c.type === 'removed' ? {} : (c.data || {});
      // The server's first answer, with no such record: none saved yet.
      else if (conf === null && meta && meta.fromCache === false) conf = {};
      else return;
      changed();
    }, () => {});
  }

  // A thank-you has gone, been drafted, or he asked them himself
  // (followup.py thanks_done).
  const done = rec => !!(rec && (rec.sentAt || rec.draftId || rec.byHand || rec.unconfirmed));

  // Where a job's thank-you stands: { id, rec, paidDay }. null: not a
  // finished job, so nothing to say.
  //   sent / unsure / drafted / byHand -- done; off -- ticked not to;
  //   notPaid -- finished, the invoice not paid off yet; handPaid -- paid,
  //   but not in QuickBooks; old -- paid over WITHIN_DAYS ago; before --
  //   paid before thank-yous went by themselves; noLink -- waits for the
  //   review link; noEmail / notCustomer -- held for its address; due --
  //   goes in the next morning's run.
  function stateOf(d, jobId) {
    d = d || {};
    const rec = d.thanksEmail || {};
    const mine = jobId && justSent[jobId];
    if (!done(rec) && mine) return { id: mine.draftId ? 'drafted' : 'sent', rec: mine };
    if (rec.sentAt) return { id: rec.unconfirmed ? 'unsure' : 'sent', rec: rec };
    if (rec.draftId) return { id: 'drafted', rec: rec };
    if (rec.byHand) return { id: 'byHand', rec: rec };
    const st = typeof jobStage === 'function' ? jobStage(d) : { id: '' };
    if (['finished', 'invoiced', 'paid'].indexOf(st.id) === -1 || d.deletedAt || d.removeWhy) return null;
    if (d.noThanks) return { id: 'off', rec: rec };
    if (st.id !== 'paid') return { id: 'notPaid', rec: rec };
    if (!st.qb) return { id: 'handPaid', rec: rec };
    // The sweep stamps workStageAt as it moves the job to Paid; not moved
    // yet, it is today's.
    const paidDay = d.workStage === 'paid' ? ymd(d.workStageAt) : localYMD();
    if (!paidDay) return { id: 'handPaid', rec: rec };
    const age = Math.round((Date.parse(localYMD() + 'T12:00:00') - Date.parse(paidDay + 'T12:00:00')) / 864e5);
    if (age > WITHIN_DAYS) return { id: 'old', rec: rec, paidDay: paidDay };
    if (conf) {
      // Not started yet: the first run that finds a job paid off starts it
      // from that day (followup.py _ThanksRun._start) -- today's.
      if (paidDay < String(conf.thanksFrom || localYMD()).slice(0, 10)) return { id: 'before', rec: rec, paidDay: paidDay };
      if (!String(conf.reviewLink || '').trim()) return { id: 'noLink', rec: rec, paidDay: paidDay };
    } else if (rec.held === 'noLink') return { id: 'noLink', rec: rec, paidDay: paidDay };
    if (rec.held === 'noEmail' && !looksLikeEmail(d.email)) return { id: 'noEmail', rec: rec, paidDay: paidDay };
    if (rec.held === 'notCustomer') return { id: 'notCustomer', rec: rec, paidDay: paidDay };
    return { id: 'due', rec: rec, paidDay: paidDay };
  }

  // When the next run sends it: the last morning run is at 11.
  const nextMorning = () => (new Date().getHours() < LAST_RUN_HOUR ? 'this morning' : 'tomorrow morning') + ' (8 to noon)';
  const drafting = () => !!(conf && conf.thanksSend === false);

  // The line on a finished job (estimate.js, under its invoice). d: the job
  // as the form has it.
  function lineHtml(d, jobId) {
    if (!jobId || !can('jobs', 'see')) return '';
    const s = stateOf(d, jobId);
    if (!s) return '';
    const id = safeId(jobId), r = s.rec || {};
    const to = r.to ? ' to ' + esc(r.to) : '';
    const paid = s.paidDay ? 'Paid ' + esc(fmtDateMD(s.paidDay)) : 'Paid off';
    const where = drafting() ? 'goes into your Gmail Drafts' : 'goes to them by itself';
    let words;
    switch (s.id) {
      case 'sent': words = 'Thank-you sent ' + esc(day(r.sentAt || r.at)) + to + ', with your review link.'; break;
      case 'unsure': words = 'A thank-you' + to + ' was being sent ' + esc(day(r.sentAt || r.at)) +
        ' and Gmail never answered — look in your Sent mail. It won’t be sent again.'; break;
      case 'drafted': words = 'Thank-you drafted ' + esc(day(r.at)) + to + ' — in your Gmail Drafts to read and send.'; break;
      case 'byHand': words = 'You asked them for a review yourself' + (r.emailedAt ? ' (' + esc(day(r.emailedAt)) + ')' : '') +
        ' — no thank-you sent.'; break;
      case 'off': words = 'No thank-you for this job.'; break;
      case 'notPaid': words = 'When the invoice is paid off in QuickBooks, a thank-you with your Google review link ' + where +
        ' the next morning.'; break;
      case 'handPaid': words = 'Paid, but not in QuickBooks — no thank-you goes by itself.'; break;
      case 'old': words = paid + ', over ' + WITHIN_DAYS + ' days ago — no thank-you goes by itself now.'; break;
      case 'before': words = paid + ', before thank-yous went by themselves' +
        (conf && conf.thanksFrom ? ' (from ' + esc(fmtDateMD(conf.thanksFrom)) + ')' : '') + ' — none sent.'; break;
      case 'noLink': words = paid + ' — the thank-you is held until your Google review link is added.'; break;
      case 'noEmail': words = paid + ' — held: no email on the job or its QuickBooks customer. Add theirs and it goes the next morning.'; break;
      case 'notCustomer': words = paid + ' — held: the email on it is yours, the crew’s or a test address.'; break;
      default: words = paid + ' — a thank-you with your review link ' + where + ' ' + nextMorning() + '.';
    }
    const isDone = done(r) || ['sent', 'drafted'].indexOf(s.id) !== -1;
    const owner = isOwner(), bills = owner || can('billing', 'change');
    const linkMissing = !!(conf && !String(conf.reviewLink || '').trim());
    const acts = [];
    if (!isDone && s.id !== 'off' && owner && (s.id === 'noLink' || linkMissing)) {
      acts.push('<button class="btn btn-sm btn-filled" onclick="chaseReviewLink()">Add your review link</button>');
    } else if (!isDone && bills && ['off', 'notCustomer', 'noEmail'].indexOf(s.id) === -1) {
      // Held for its address: nothing to send it to until that is fixed.
      acts.push('<button class="btn btn-sm" onclick="thanksSendNow(\'' + id + '\')"' + (busy[jobId] ? ' disabled' : '') + '>' +
        (busy[jobId] ? 'Sending…' : drafting() ? 'Draft it now' : 'Send it now') + '</button>');
    }
    if (mailLink(r.link) && isDone) {
      acts.push('<a class="btn btn-sm" href="' + esc(r.link) + '" target="_blank" rel="noopener">' +
        (s.id === 'drafted' ? 'Open the draft' : 'Open the email') + '</a>');
    }
    const tick = !isDone && can('jobs', 'change')
      ? '<label class="chk est-nothanks"><input type="checkbox"' + (d.noThanks ? ' checked' : '') +
        ' onchange="thanksNoSend(\'' + id + '\', this.checked)"> 🚫 Don’t send a thank-you for this job</label>' : '';
    return '<div class="est-care est-thanks">🙏 ' + words + (acts.length ? ' ' + acts.join(' ') : '') + '</div>' +
      (tick ? '<div class="est-care">' + tick + '</div>' : '');
  }

  // Home's "Waiting on you" (owner): the link to add while thank-yous wait
  // for it, and each job held for its address.
  function homeRows(jobs) {
    if (!isOwner()) return [];
    const list = (jobs || []).map(j => ({ j: j, s: stateOf(j, j._id) })).filter(x => x.s);
    const out = [];
    const needLink = list.filter(x => x.s.id === 'noLink');
    if (needLink.length) {
      const n = needLink.length;
      out.push({ icon: '🔗', main: '<b>Add your Google review link</b>',
        small: n + ' thank-you' + (n === 1 ? ' is' : 's are') + ' waiting on it, for jobs paid off — ' +
          needLink.slice(0, 3).map(x => esc(String(x.j.customerName || 'A job').trim())).join(' · ') + (n > 3 ? ' …' : ''),
        call: 'chaseReviewLink()' });
    }
    list.filter(x => x.s.id === 'noEmail' || x.s.id === 'notCustomer').forEach(x => out.push({
      icon: '🙏', main: '<b>Thank-you held</b> · ' + esc(String(x.j.customerName || 'A job').trim()),
      small: x.s.id === 'noEmail' ? 'Paid off, but no email for them — add it on the job' : 'The email on it is yours, the crew’s or a test address',
      call: "homeOpenJob('" + safeId(x.j._id) + "')" }));
    return out;
  }

  // ------------------------------------------------------------ settings

  function save(patch, what) {
    if (!isOwner() || !window.YDDb) { showToast('Not saved — still connecting'); return; }
    conf = Object.assign({}, conf || {}, patch);       // shown at once
    changed();
    Promise.resolve(window.YDDb.put('settings', 'followUp', Object.assign({}, patch, { updatedAt: new Date().toISOString() })))
      .catch(e => {
        if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
        else console.warn('[thanks] ' + what + ' not yet on the server:', (e && e.code) || e);
      });
  }
  const current = async () => conf || (await Promise.resolve(window.YDDb && window.YDDb.get('settings', 'followUp')).catch(() => null)) || {};

  // The link the thank-you asks for a review with (also on the Bids board).
  window.chaseReviewLink = async function () {
    if (!isOwner() || !window.YDDb) return;
    const now = await current();
    const got = await ydPrompt('Paste the link from Google Business Profile → “Ask for reviews”. The thank-you that goes to a ' +
      'customer once their job is paid off asks them for a review with it. No link, no thank-yous go.',
      now.reviewLink || '', { title: 'Google review link', placeholder: 'https://g.page/r/…/review',
        check: v => !v.trim() || /^https:\/\/\S+$/.test(v.trim()) ? '' : 'That isn’t a web link (it starts https://)' });
    if (got == null) return;
    const link = String(got).trim();
    save({ reviewLink: link }, 'the review link');
    showToast(link ? 'Saved — the thank-yous will carry it' : 'Removed — no thank-yous go until there is a link');
  };

  async function editWords() {
    const now = await current();
    const got = await ydForm('The thank-you in your words. {name} becomes their first name (“there” for a business), ' +
      '{work} what the job was (“paver patio”), {link} your review link. Empty a box for the usual words.', [
      { id: 'subject', label: 'Subject', value: now.thanksSubject || SUBJECT },
      { id: 'body', label: 'The email', value: now.thanksBody || BODY, multiline: true,
        check: v => !v.trim() || /\{link\}/.test(v) ? '' : 'Keep {link} where your review link goes' },
    ], { title: 'The thank-you’s words', ok: 'Save' });
    if (!got) return;
    const subject = String(got.subject || '').trim(), body = String(got.body || '').trim();
    // The usual words are kept as nothing saved, so they stay the usual ones.
    save({ thanksSubject: subject === SUBJECT ? '' : subject, thanksBody: body === BODY.trim() ? '' : body }, 'the words');
    showToast('Saved — the next thank-you uses them');
  }

  window.openThanksSettings = async function () {
    if (!isOwner()) return;
    const now = await current();
    const link = String(now.reviewLink || '').trim();
    const pick = await ydChoose('Once a job is paid off in QuickBooks, the customer gets a thank-you from your Gmail the next morning ' +
      'asking for a Google review — never twice, and never with “Don’t send a thank-you” ticked on the job.' +
      (now.thanksFrom ? ' Jobs paid from ' + fmtDateMD(now.thanksFrom) + ' on.' : ''), [
      { id: 'link', label: '🔗 Google review link', hint: link || 'Not added yet — no thank-yous go until it is' },
      { id: 'send', label: '✉️ Send them by themselves', hint: 'From your Gmail, 8 to noon — a reply comes to you' },
      { id: 'draft', label: '📝 Put them in my Gmail Drafts instead', hint: 'You read each one and send it yourself' },
      { id: 'words', label: '✏️ The words', hint: now.thanksBody || now.thanksSubject ? 'Your own words' : 'The usual words — change them' },
      { id: 'welcome', label: '👋 After a yes: the next-steps email', hint: { draft: 'Into your Gmail Drafts', send: 'Sends by itself', off: 'Off' }[welcomeMode(now)] },
    ], { title: 'Follow-ups & thank-yous', value: now.thanksSend === false ? 'draft' : 'send', cancel: 'Close' });
    if (!pick) return;
    if (pick.id === 'link') { window.chaseReviewLink(); return; }
    if (pick.id === 'words') { editWords(); return; }
    if (pick.id === 'welcome') { openWelcomeSettings(); return; }
    save({ thanksSend: pick.id === 'send' }, 'the thank-you choice');
    showToast(pick.id === 'send' ? 'Thank-yous will send themselves' : 'Thank-yous will go into your Gmail Drafts');
  };

  // ------------------------------------------------------------ on the job

  const redraw = () => { if (window.YDEstimate && YDEstimate.redrawCare) YDEstimate.redrawCare(); };

  window.thanksNoSend = function (jobId, on) {
    if (!can('jobs', 'change') || !window.YDSync || !YDSync.patchJob) return;
    if (jobId === currentJobId && typeof boardFields !== 'undefined') boardFields.noThanks = !!on;
    if (!YDSync.patchJob(jobId, { noThanks: !!on })) { showToast('Could not save that'); return; }
    showToast(on ? '🚫 No thank-you will go for this job' : 'A thank-you can go for this job again');
    redraw();
  };

  window.thanksSendNow = async function (jobId) {
    if (busy[jobId] || !window.YDClaude) return;
    const draft = drafting();
    const yes = await ydConfirm(draft ? 'Put the thank-you with your review link in your Gmail Drafts now?'
      : 'Send the thank-you with your review link to this customer now, from your Gmail?',
      { title: 'The thank-you', ok: draft ? 'Draft it' : 'Send it' });
    if (!yes) return;
    // The server reads the job: their email, if it was just typed, goes up first.
    if (jobId === currentJobId && typeof dirty !== 'undefined' && dirty && typeof autosave === 'function') autosave();
    busy[jobId] = true; redraw();
    try {
      const up = window.YDSync && YDSync.sendNow ? await YDSync.sendNow(jobId) : true;
      if (!up) { showToast('No signal — press it again when there is one'); return; }
      const r = await window.YDClaude.post('/followup/thanks', { jobId: jobId });
      // The server wrote it on the job; shown now, until the job brings it.
      if (r.record) justSent[jobId] = r.record;
      showToast(r.drafted ? '🙏 The thank-you is in your Gmail Drafts' : '🙏 Thank-you sent' + (r.to ? ' to ' + r.to : ''));
    } catch (e) {
      showToast('Thank-you not sent: ' + (e.message || e), 6000);
    } finally {
      delete busy[jobId]; redraw();
    }
  };

  // ------------------------------------------------------------ after a yes
  //
  // Jonah (27 Oct 2026): "have generic email that gets sent after an estimate
  // is accepted thanking them and giving next steps down payment etc." The
  // server writes it (followup.py, the after-a-yes section): the morning
  // after the yes is seen in QuickBooks, into his Gmail Drafts until he
  // chooses to have it sent (settings/followUp.welcome 'draft' | 'send' |
  // 'off'), in his words once he changes them. Here: the line on the job, the
  // "Don't send" tick (noWelcome), and the choice in Follow-ups & thank-yous.
  // followup.py WELCOME_SUBJECT / WELCOME_BODY -- the same words.
  const W_SUBJECT = 'Next steps for your {work} — YD Exterior Visions';
  const W_BODY = 'Hi {name},\n\n' +
    'Thank you for accepting our estimate for your {work} — we\'re glad to be working with you.\n\n' +
    'Here\'s what happens next:\n\n' +
    '1. Deposit: you\'ll get the deposit invoice from QuickBooks by email. You can pay it online with the ' +
    'button in that email (a bank transfer costs you nothing), or by check made out to YD Exterior Visions LLC.\n\n' +
    '2. Scheduling: once the deposit is in, we order your materials and put you on the schedule, ' +
    'and we\'ll be in touch with a start date.\n\n' +
    '3. Before we dig: we have the public utility lines marked, so you may see paint or flags in the yard a few ' +
    'days before we start. If you have private lines (an invisible dog fence, irrigation, lighting, a line to a ' +
    'shed), please let us know where they run.\n\n' +
    '4. Questions or changes: just reply to this email.\n\n' +
    'Thanks again for choosing us,\n' +
    'Jonah\n' +
    'YD Exterior Visions';
  const W_WITHIN_DAYS = 14;          // followup.WELCOME_WITHIN_DAYS
  // followup.py welcome_mode: drafts until he chooses.
  const welcomeMode = c => (c && (c.welcome === 'send' || c.welcome === 'off')) ? c.welcome : 'draft';

  // The line on a booked job whose estimate was accepted (estimate.js, beside
  // the thank-you's). '' when there is nothing to say.
  function welcomeHtml(d, jobId) {
    if (!jobId || !can('jobs', 'see')) return '';
    d = d || {};
    const rec = d.welcomeEmail || {};
    const st = typeof normStatus === 'function' ? normStatus(d.jobStatus, d) : d.jobStatus;
    const isDone = done(rec);
    if (!isDone && (!d.acceptedSeenAt || d.removeWhy || d.deletedAt || ['booked', 'inprogress'].indexOf(st) === -1)) return '';
    const to = rec.to ? ' to ' + esc(rec.to) : '';
    const mode = welcomeMode(conf);
    let words;
    if (rec.sentAt) words = rec.unconfirmed ? 'The next-steps email' + to + ' was being sent ' + esc(day(rec.sentAt)) +
      ' and Gmail never answered — look in your Sent mail.' : 'Next-steps email sent ' + esc(day(rec.sentAt)) + to + '.';
    else if (rec.draftId) words = 'Next-steps email drafted ' + esc(day(rec.at)) + to + ' — in your Gmail Drafts to read and send.';
    else if (rec.byHand) words = 'You emailed them about the deposit / next steps yourself — none sent.';
    else if (d.noWelcome) words = 'No next-steps email for this job.';
    else if (mode === 'off') words = 'Next-steps emails are switched off (⋯ → All settings → Follow-ups & thank-yous).';
    else {
      const yes = ymd(d.acceptedSeenAt);
      const age = yes ? Math.round((Date.parse(localYMD() + 'T12:00:00') - Date.parse(yes + 'T12:00:00')) / 864e5) : 0;
      // Not started yet: the first run that finds a yes starts it from that
      // day (followup.py _WelcomeRun._start) -- today's.
      const from = String((conf && conf.welcomeFrom) || localYMD()).slice(0, 10);
      if (!yes || age > W_WITHIN_DAYS || yes < from) return '';
      if (rec.held === 'noEmail' && !looksLikeEmail(d.email)) words = 'Next-steps email held: no email on the job or its QuickBooks customer.';
      else if (rec.held === 'notCustomer') words = 'Next-steps email held: the email on it is yours, the crew’s or a test address.';
      else words = 'They said yes — a thank-you with the next steps (deposit, scheduling) ' +
        (mode === 'send' ? 'goes to them by itself ' : 'goes into your Gmail Drafts ') + nextMorning() + '.';
    }
    const link = mailLink(rec.link) && (rec.sentAt || rec.draftId)
      ? ' <a class="btn btn-sm" href="' + esc(rec.link) + '" target="_blank" rel="noopener">' + (rec.draftId ? 'Open the draft' : 'Open the email') + '</a>' : '';
    const tick = !isDone && can('jobs', 'change')
      ? '<div class="est-care"><label class="chk est-nothanks"><input type="checkbox"' + (d.noWelcome ? ' checked' : '') +
        ' onchange="welcomeNoSend(\'' + safeId(jobId) + '\', this.checked)"> 🚫 Don’t send the next-steps email for this job</label></div>' : '';
    return '<div class="est-care est-thanks">👋 ' + words + link + '</div>' + tick;
  }

  window.welcomeNoSend = function (jobId, on) {
    if (!can('jobs', 'change') || !window.YDSync || !YDSync.patchJob) return;
    if (jobId === currentJobId && typeof boardFields !== 'undefined') boardFields.noWelcome = !!on;
    if (!YDSync.patchJob(jobId, { noWelcome: !!on })) { showToast('Could not save that'); return; }
    showToast(on ? '🚫 No next-steps email will go for this job' : 'The next-steps email can go for this job again');
    redraw();
  };

  async function editWelcomeWords() {
    const now = await current();
    const got = await ydForm('The email a customer gets the morning after they accept your estimate. {name} becomes their first ' +
      'name (“there” for a business), {work} what the job is (“paver patio”). Empty a box for the usual words.', [
      { id: 'subject', label: 'Subject', value: now.welcomeSubject || W_SUBJECT },
      { id: 'body', label: 'The email', value: now.welcomeBody || W_BODY, multiline: true },
    ], { title: 'The next-steps email’s words', ok: 'Save' });
    if (!got) return;
    const subject = String(got.subject || '').trim(), body = String(got.body || '').trim();
    save({ welcomeSubject: subject === W_SUBJECT ? '' : subject, welcomeBody: body === W_BODY.trim() ? '' : body }, 'the next-steps words');
    showToast('Saved — the next one uses them');
  }

  async function openWelcomeSettings() {
    const now = await current();
    const mode = welcomeMode(now);
    const pick = await ydChoose('The morning after a customer accepts your estimate in QuickBooks, they get a thank-you with the next ' +
      'steps — the deposit invoice, scheduling, marking the utility lines. Never twice, never for snow, and not when you’ve ' +
      'emailed them about the deposit yourself.', [
      { id: 'draft', label: '📝 Put it in my Gmail Drafts', hint: 'You read each one and send it yourself (how it starts)' },
      { id: 'send', label: '✉️ Send it by itself', hint: 'From your Gmail, 8 to noon — a reply comes to you' },
      { id: 'off', label: '🚫 Don’t send them', hint: 'No next-steps emails at all' },
      { id: 'words', label: '✏️ The words', hint: now.welcomeBody || now.welcomeSubject ? 'Your own words' : 'The usual words — read and change them' },
    ], { title: 'After a yes: the next-steps email', value: mode, cancel: 'Close' });
    if (!pick) return;
    if (pick.id === 'words') { editWelcomeWords(); return; }
    save({ welcome: pick.id }, 'the next-steps choice');
    showToast(pick.id === 'send' ? 'Next-steps emails will send themselves' : pick.id === 'off' ? 'No next-steps emails will go'
      : 'Next-steps emails will go into your Gmail Drafts');
  }

  // ------------------------------------------------------------ how he writes
  //
  // Jonah (30 Oct 2026, wish card): "read all my personally sent emails to
  // find my voice so you can improve writing as me." The guide made from the
  // emails he typed himself (settings/voice.guide, owner-only) goes with
  // every email Claude writes as him -- follow-ups, replies, a lead's first
  // reply, card emails, plant care, progress updates (functions/voice.py).
  // Here he reads it and changes it; emptied, Claude writes without it.
  // Until he has one, Claude's proposal (settings/voice.proposed, which the
  // server never reads) fills the box: Save is his OK.
  window.openVoiceSettings = async function () {
    if (!isOwner() || !window.YDDb) return;
    const now = (await Promise.resolve(window.YDDb.get('settings', 'voice')).catch(() => null)) || {};
    const proposal = !String(now.guide || '').trim() && String(now.proposed || '').trim();
    const got = await ydForm((proposal ? 'Claude’s guide from the emails you typed yourself, waiting for your OK: change any line, ' +
      'then Save to start using it. ' : '') +
      'How you write, for every email Claude writes as you — follow-ups, replies, a lead’s first reply, ' +
      'card emails, plant care, progress updates. It changes how they sound, never the facts or prices in them. Empty it ' +
      'and Claude writes without it.', [
      { id: 'guide', label: 'How you write', value: now.guide || proposal || '', multiline: true, rows: 14 },
    ], { title: 'How you write', ok: proposal ? 'Save — use it' : 'Save' });
    if (!got) return;
    const guide = String(got.guide || '').trim();
    if (guide === String(now.guide || '').trim() && !proposal) return;
    // Saving is his answer to the proposal either way -- taken, changed or
    // emptied -- so it never fills the box again.
    Promise.resolve(window.YDDb.put('settings', 'voice', { guide: guide, by: 'hand', proposed: null, updatedAt: new Date().toISOString() }))
      .then(() => showToast(guide ? 'Saved — the next email Claude writes uses it' : 'Emptied — Claude writes without it'))
      .catch(e => showToast(e && e.code === 'permission-denied' ? 'Not saved — not allowed' : 'Not saved — try again'));
  };

  window.YDThanks = { lineHtml: lineHtml, homeRows: homeRows, stateOf: stateOf, conf: () => conf, welcomeHtml: welcomeHtml };

  document.addEventListener('yd-auth', e => {
    const a = (e && e.detail) || {};
    if (a.user && a.isOwner) start(); else stop();
  });
})();
