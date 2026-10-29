// Customers writing in about their jobs: one "Needs you" list on Home.
//
// Routine #1 on the wish board ("Inbox desk"; Jonah, 28 Oct 2026: "yes. but
// draft only when i tap draft a reply"). Each hour the server
// (functions/inboxdesk.py) puts an email from the customer on a booked or
// under-way job into inboxNeeds/{messageId} {jobId, jobName, from, subject,
// snippet, link, at, open, answeredAt, doneAt, draft}; it leaves by itself
// once he has answered in that thread. Here: the open ones on Home's Waiting
// on you; a tap gives Open the email / ✍️ Draft a reply (Claude, in his
// voice, into his Gmail Drafts -- never sent) / Open the job / ✓ Done.
// Also "✍️ Draft a reply" for a lead from email (customers.js).
//
// His inbox: the owner's only (firestore.rules).

(function () {
  'use strict';

  let rows = {}, unsub = null, who = null;
  const isOwner = () => !!(window.YDAuth && YDAuth.isOwner && YDAuth.mode === 'cloud' && YDAuth.user);
  const gmail = u => /^https:\/\/mail\.google\.com\//.test(String(u || '')) ? String(u) : '';
  const tell = () => document.dispatchEvent(new CustomEvent('yd-inbox'));

  function watch() {
    if (unsub) { try { unsub(); } catch (e) { /* gone */ } }
    unsub = null; rows = {};
    if (!isOwner() || !window.YDDb) { tell(); return; }
    unsub = YDDb.watchWhere('inboxNeeds', 'open', true, changes => {
      changes.forEach(c => { if (c.type === 'removed' || !(c.data && c.data.open)) delete rows[c.id]; else rows[c.id] = c.data; });
      tell();
    }, () => {});
  }
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const k = a.mode === 'cloud' && a.user && a.isOwner ? a.user.uid : null;
    if (k === who) return;
    who = k;
    watch();
  });

  function list() {
    return Object.keys(rows).map(id => Object.assign({ id: id }, rows[id]))
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  }

  let busy = false;
  async function draft(kind, id) {
    if (busy || !window.YDClaude) return null;
    busy = true;
    showToast('Writing the reply…');
    try {
      const r = await YDClaude.post('/inbox/draft', { kind: kind, id: id });
      if (r && r.error) throw new Error(r.error);
      showToast('Reply saved in your Gmail Drafts — nothing was sent');
      return r;
    } catch (e) { showToast((e && e.message) || 'Not written — try again'); return null; }
    finally { busy = false; }
  }

  window.ibOpen = async function (id) {
    const n = rows[id];
    if (!n) return;
    const d = n.draft && gmail(n.draft.link);
    const choices = [
      gmail(n.link) ? { id: 'mail', label: '📧 Open the email', hint: n.subject || '' } : null,
      d ? { id: 'draft', label: '✉️ Open the reply draft', hint: 'Drafted — read it, change it, send it' }
        : { id: 'write', label: '✍️ Draft a reply', hint: 'Claude writes it the way you write, into your Gmail Drafts' },
      n.jobId ? { id: 'job', label: '📐 Open the job', hint: n.jobName || '' } : null,
      { id: 'done', label: '✓ Done', hint: 'Take it off the list (it goes by itself once you answer in Gmail)' },
    ].filter(Boolean);
    const pick = await ydChoose((n.snippet || '').slice(0, 300), choices, { title: '📬 ' + (n.jobName || 'A customer') + ' wrote', cancel: 'Close' });
    if (!pick) return;
    if (pick.id === 'mail') window.open(gmail(n.link), '_blank', 'noopener');
    else if (pick.id === 'draft') window.open(d, '_blank', 'noopener');
    else if (pick.id === 'job' && typeof openNoteJob === 'function') openNoteJob(n.jobId);
    else if (pick.id === 'write') {
      const r = await draft('need', id);
      if (r && gmail(r.link)) window.open(gmail(r.link), '_blank', 'noopener');
    } else if (pick.id === 'done') {
      delete rows[id];
      tell();
      const at = new Date().toISOString();
      Promise.resolve(YDDb.put('inboxNeeds', id, { open: false, doneAt: at, doneBy: (YDAuth.user && YDAuth.user.uid) || null }))
        .catch(() => { rows[id] = n; tell(); showToast('Not saved — try again'); });
      if (typeof showUndo === 'function') showUndo('Taken off the list', () => {
        rows[id] = n; tell();
        Promise.resolve(YDDb.put('inboxNeeds', id, { open: true, doneAt: null, doneBy: null })).catch(() => {});
      });
    }
  };

  // A lead from email (customers.js): the reply, written when he taps.
  window.ibDraftLead = async function (id) {
    const r = await draft('lead', id);
    if (r && gmail(r.link)) window.open(gmail(r.link), '_blank', 'noopener');
  };

  window.YDInboxDesk = { list: list };
})();
