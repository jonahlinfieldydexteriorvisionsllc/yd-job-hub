// Boards: cards in columns, the way Trello does it, but inside Job Hub.
//
// There are two very different kinds of board here, and keeping them apart is
// the whole design.
//
// BIDS AND JOBS ARE NOT STORED AS CARDS. They are a live view of the jobs
// themselves, grouped by where each job has got to. Dragging a card does not
// move a card -- it changes the job (its bidStage / workStage, and its status
// where that follows). Storing them as separate cards would mean every job
// existing twice, and the two copies would drift the first time someone
// changed a status in the job form instead of on the board. These two are
// owner-only: a job carries its price, and crew cannot read jobs at all.
//
// EVERYTHING ELSE IS A STORED BOARD -- boards/{id} with its cards in
// boards/{id}/cards. To-do lists and crew task lists. Each board carries a
// visibleTo list of crew uids; the security rules let a crew member read a
// board only when they are on it, and let them move a card and tick its
// checklist but not rewrite it. That is what makes "the boards I share with
// specific guys" enforceable rather than cosmetic.

(function () {
  'use strict';

  // --------------------------------------------------------------- constants

  const BIDS = {
    id: 'bids', virtual: true, name: 'Bids', color: '#2f6fd6',
    columns: [
      { id: 'siteVisit', name: 'Site visit' },
      { id: 'toSend', name: 'Bid to send' },
      { id: 'sent', name: 'Sent — waiting' },
      { id: 'followUp', name: 'Follow up' },
      { id: 'won', name: 'Won' },
      { id: 'lost', name: 'Lost' },
    ],
  };
  const JOBS = {
    id: 'jobs', virtual: true, name: 'Jobs', color: '#2f8f5b',
    columns: [
      { id: 'scheduled', name: 'Scheduled' },
      { id: 'inProgress', name: 'In progress' },
      { id: 'punchList', name: 'Punch list' },
      { id: 'toInvoice', name: 'Ready to invoice' },
      { id: 'invoiced', name: 'Invoiced' },
      { id: 'paid', name: 'Paid' },
    ],
  };
  const QUOTING_STAGES = ['siteVisit', 'toSend', 'sent', 'followUp'];
  const ACTIVE_STAGES = ['scheduled', 'inProgress', 'punchList'];
  const COMPLETE_STAGES = ['toInvoice', 'invoiced', 'paid'];

  // Won, lost and paid cards would pile up forever. They stay on the board
  // long enough to be seen, then drop off -- the job itself is untouched.
  const SHOW_WON_DAYS = 30, SHOW_LOST_DAYS = 45, SHOW_PAID_DAYS = 30;

  // Templates for new stored boards.
  const TEMPLATES = {
    crew: { label: 'Crew task list', columns: ['To do', 'Doing', 'Done'] },
    admin: { label: 'To-do list', columns: ['This week', 'Recurring', 'Waiting on', 'Done'] },
    blank: { label: 'Blank', columns: ['To do', 'Done'] },
  };

  // Colours a board or a label can be. Picked to be told apart at a glance in
  // daylight and in the dark theme, including by the colour-blind -- no two
  // that differ only by red/green.
  const PALETTE = ['#2f6fd6', '#1a9c8c', '#2f8f5b', '#8bb22a', '#e0a526',
                   '#e07b24', '#d64545', '#d94f8a', '#8e5bc7', '#66418f', '#6b7a8f'];

  const DEFAULT_LABELS = [
    { id: 'urgent', name: 'Urgent', color: '#d64545' },
    { id: 'waiting', name: 'Waiting', color: '#e0a526' },
    { id: 'materials', name: 'Materials', color: '#e07b24' },
    { id: 'equipment', name: 'Equipment', color: '#2f6fd6' },
    { id: 'office', name: 'Office', color: '#8e5bc7' },
  ];

  // ------------------------------------------------------------------- state

  let boards = {};          // stored boards, id -> board
  let cards = {};           // boardId -> { cardId -> card }
  let people = {};          // owner only: uid -> user record
  let current = null;       // the board on screen
  let openCard = null;      // { boardId, cardId } of the card being viewed
  let editingBoard = null;  // board id being edited, '' for a new one
  let unsubBoards = null, unsubPeople = null;
  let cardUnsubs = {};
  // Boards whose cards have arrived from the server at least once. The first
  // answer can come from the local cache, and on a fresh phone that is empty:
  // anything deciding "this card does not exist" has to wait for this.
  let cardsLoaded = {};
  let seeded = false;
  let ready = false;        // boards have arrived from the server at least once
  let dragging = null;      // { boardId, cardId } while a card is dragged

  // The Maintenance board is made and kept in step by equipment.js, one card
  // per machine and per problem noted on it. Deleting it would only see it
  // made again the next time Job Hub opened, so it cannot be deleted.
  const MAINTENANCE = 'maintenance';

  const el = id => document.getElementById(id);
  const val = id => ((el(id) || {}).value || '').trim();
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  // The Bids and Jobs boards are the jobs themselves, so they follow Jobs.
  const seesJobs = () => ydCan('jobs', 'see');
  const movesJobs = () => ydCan('jobs', 'change');
  // Every stored board, not only the ones shared with you; and running them.
  const seesAllBoards = () => ydCan('boards', 'see');
  const editsBoards = () => ydCan('boards', 'change');
  const safeId = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const me = () => (window.YDAuth && window.YDAuth.user) || null;
  const two = n => String(n).padStart(2, '0');
  const nowIso = () => new Date().toISOString();
  const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function localDay(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }
  function daysSince(iso) {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return isFinite(t) ? Math.floor((Date.now() - t) / 864e5) : null;
  }
  function shortDay(day) {
    if (!day) return '';
    const d = new Date(day + 'T00:00:00');
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function initials(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2)
      .map(w => w[0].toUpperCase()).join('') || '?';
  }
  function myName() {
    const u = me();
    if (!u) return '';
    return (people[u.uid] && people[u.uid].name) || u.displayName || u.email || '';
  }
  // A card with no column shows in the first one, so everything that works
  // out where a card sits has to read it the same way.
  function colOf(board, k) {
    return k.column || (board && board.columns && board.columns[0] ? board.columns[0].id : '');
  }
  // Phones and tablets do not drag reliably, so there a card is moved from
  // the sheet that opens when it is tapped -- and the screen should say so.
  function touchScreen() {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }

  // ------------------------------------------------------------ job columns

  function jobsList() {
    return (typeof loadAllJobs === 'function' ? loadAllJobs() : []).filter(j => j && j._id);
  }

  function bidColumn(j) {
    const stage = j.bidStage;
    const quoting = (j.jobStatus || 'quoting') === 'quoting';
    // Won and Lost only count while the job's status agrees. A lost bid whose
    // customer rang back and was set Active in the form used to sit in Lost on
    // this board AND in Scheduled on the Jobs board.
    if (stage === 'won' && !quoting) return (daysSince(j.bidStageAt) || 0) <= SHOW_WON_DAYS ? 'won' : null;
    if (stage === 'lost' && quoting) return (daysSince(j.bidStageAt) || 0) <= SHOW_LOST_DAYS ? 'lost' : null;
    if (!quoting) return null;
    return QUOTING_STAGES.indexOf(stage) !== -1 ? stage : 'toSend';
  }

  // A stage only counts if it agrees with the job's status. If someone changes
  // the status in the job form, the board follows the form rather than showing
  // a complete job sitting in "In progress".
  function workColumn(j) {
    const st = typeof normStatus === 'function' ? normStatus(j.jobStatus, j) : j.jobStatus;
    const stage = j.workStage;
    // Booked jobs are Scheduled; In progress jobs are In progress or on the
    // Punch list. A stage that disagrees with the status follows the status.
    if (st === 'booked') return 'scheduled';
    if (st === 'inprogress') return stage === 'punchList' ? 'punchList' : 'inProgress';
    if (st === 'complete') {
      const col = COMPLETE_STAGES.indexOf(stage) !== -1 ? stage
        : (j.qbInvoiced ? 'invoiced' : 'toInvoice');
      if (col === 'paid' && (daysSince(j.workStageAt) || 0) > SHOW_PAID_DAYS) return null;
      return col;
    }
    return null;
  }

  function jobCards(board) {
    const out = {};
    board.columns.forEach(c => { out[c.id] = []; });
    jobsList().forEach(j => {
      const col = board.id === 'bids' ? bidColumn(j) : workColumn(j);
      if (col && out[col]) out[col].push(j);
    });
    const since = j => board.id === 'bids' ? (j.bidStageAt || j.lastModified) : (j.workStageAt || j.lastModified);
    Object.keys(out).forEach(k => out[k].sort((a, b) =>
      String(since(a) || '').localeCompare(String(since(b) || ''))));
    return out;
  }

  // Moving a job card changes the job. The status follows where it makes sense:
  // a bid marked Won becomes an active job and appears on the Jobs board.
  function moveJob(jobId, boardId, col) {
    const j = jobsList().find(x => x._id === jobId);
    if (!j) return;
    // A card dropped back where it was (a drag that changed its mind) is not
    // a move. Treating it as one restamped the job, which reset its age and
    // cleared the "untouched for a fortnight" warning on a bid going cold.
    if ((boardId === 'bids' ? bidColumn(j) : workColumn(j)) === col) return;
    const at = nowIso();
    let patch;
    if (boardId === 'bids') {
      if (col === 'won') {
        patch = { bidStage: 'won', bidStageAt: at };
        if ((j.jobStatus || 'quoting') === 'quoting') {
          patch.jobStatus = 'booked'; patch.workStage = 'scheduled'; patch.workStageAt = at;
        }
      } else if (col === 'lost') {
        patch = { bidStage: 'lost', bidStageAt: at, jobStatus: 'quoting' };
      } else {
        patch = { bidStage: col, bidStageAt: at, jobStatus: 'quoting' };
      }
    } else {
      patch = { workStage: col, workStageAt: at,
                jobStatus: col === 'scheduled' ? 'booked' : ACTIVE_STAGES.indexOf(col) !== -1 ? 'inprogress' : 'complete' };
    }
    if (!window.YDSync || !window.YDSync.patchJob(jobId, patch)) {
      showToast('Could not move that job');
      return;
    }
    const name = (j.customerName || 'Job').trim();
    const colName = (boardId === 'bids' ? BIDS : JOBS).columns.find(c => c.id === col).name;
    showToast(name + ' → ' + colName + (col === 'won' && patch.jobStatus === 'booked'
      ? ' (now on the Jobs board)' : ''));
    render();
  }

  // ------------------------------------------------------------ board lists

  function visibleBoards() {
    const stored = Object.values(boards).sort((a, b) =>
      (a.order || 0) - (b.order || 0) || String(a.name || '').localeCompare(b.name || ''));
    return seesJobs() ? [BIDS, JOBS].concat(stored) : stored;
  }
  function boardById(id) {
    if (id === 'bids') return seesJobs() ? BIDS : null;
    if (id === 'jobs') return seesJobs() ? JOBS : null;
    return boards[id] || null;
  }

  // ---------------------------------------------------------------- render

  function render() {
    const wrap = el('boardsWrap');
    if (!wrap) return;
    const list = visibleBoards();

    if (!me() || !window.YDDb) {
      const local = window.YDAuth && window.YDAuth.mode === 'local';
      wrap.innerHTML = '<p class="empty-msg">' + (local
        ? 'Boards need a connection. They will appear once Job Hub can reach the internet.'
        : 'Loading…') + '</p>';
      return;
    }
    if (!list.length) {
      wrap.innerHTML = '<p class="empty-msg">' + (editsBoards()
        ? 'No boards yet.' : 'No boards have been shared with you yet.') + '</p>';
      return;
    }
    if (!current || !boardById(current)) current = rememberedBoard(list);
    const board = boardById(current);
    refreshComputer();

    wrap.innerHTML =
      computerLine() +
      '<div class="bd-picker">' +
        list.map(b => '<button class="bd-chip' + (b.id === current ? ' on' : '') +
          '" style="--c:' + safeColor(b.color) + '" onclick="showBoard(\'' + b.id + '\')">' +
          '<span class="bd-dot"></span>' + esc(b.name || 'Board') +
          (b.visibleTo && b.visibleTo.length && editsBoards()
            ? '<span class="bd-shared" title="Shared with crew">👥 ' + b.visibleTo.length + '</span>' : '') +
          '</button>').join('') +
        (editsBoards() ? '<button class="bd-chip bd-add" onclick="editBoard(\'\')">+ New board</button>' : '') +
      '</div>' +
      '<div class="bd-head" style="--c:' + safeColor(board.color) + '">' +
        '<div class="bd-title">' + esc(board.name) + '</div>' +
        '<div class="bd-sub">' + boardSubtitle(board) + '</div>' +
        '<div class="bd-actions">' +
          (!board.virtual && editsBoards()
            ? '<button class="btn btn-sm" onclick="editBoard(\'' + board.id + '\')">Board settings</button>' : '') +
          (!board.virtual && editsBoards()
            ? '<button class="btn btn-sm btn-filled" onclick="addCard(\'' + board.id + '\', \'' +
              board.columns[0].id + '\')">+ Add card</button>' : '') +
          (board.virtual && movesJobs()
            ? '<button class="btn btn-sm btn-filled" onclick="addJobCard(\'' + board.id + '\', \'' +
              board.columns[0].id + '\')">' + (board.id === 'bids' ? '+ New bid' : '+ New job') + '</button>' : '') +
        '</div>' +
      '</div>' +
      (board.id === 'bids' ? followUpHtml() : '') +
      '<div class="bd-cols">' + columnsHtml(board) + '</div>';
  }

  // ------------------------------------------------------------- follow up
  //
  // Bids waiting on an answer long enough to chase, oldest first, at the top
  // of the Bids board. Same rule as the summaries (digest.py CHASE_AFTER_DAYS):
  // Sent for 5 days, or moved to Follow up. "Write the email" has Claude draft
  // a follow-up from the job into Gmail Drafts -- never sent -- and the draft
  // is noted on the job (followUps) so the list says when the last one was.
  const CHASE_AFTER_DAYS = { sent: 5, followUp: 0 };
  const drafting = {};      // job id -> true while its email is being written

  function toChase() {
    return jobsList().map(j => {
      const col = bidColumn(j);
      const days = daysSince(j.bidStageAt || j.lastModified);
      return { j, col, days: days || 0 };
    }).filter(b => b.col in CHASE_AFTER_DAYS && b.days >= CHASE_AFTER_DAYS[b.col])
      .sort((a, b) => b.days - a.days);
  }

  const looksLikeEmail = s => /^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$/i.test(String(s || '').trim());
  const agoText = d => d === 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';

  function followUpHtml() {
    if (!movesJobs()) return '';
    const list = toChase();
    if (!list.length) return '';
    return '<div class="bd-chase">' +
      '<div class="bd-chase-head">📨 Follow up <span class="bd-count">' + list.length + '</span>' +
        '<span class="bd-chase-sub">Bids waiting on an answer, oldest first. The email is saved in Gmail Drafts for you to read and send.</span></div>' +
      list.map(({ j, col, days }) => {
        const price = parseMoney(j.jobPrice);
        const ups = (Array.isArray(j.followUps) ? j.followUps : []).filter(f => f && f.at);
        const last = ups[ups.length - 1];
        const lastDays = last ? daysSince(last.at) : null;
        const busy = !!drafting[j._id];
        const email = looksLikeEmail(j.email);
        return '<div class="bd-chase-row">' +
          '<div class="bd-chase-main" onclick="openJobCard(\'bids\', \'' + safeId(j._id) + '\')">' +
            '<div class="bd-chase-name">' + esc((j.customerName || 'Untitled job').trim()) +
              (j.estimateNumber ? ' <span class="job-num">#' + esc(j.estimateNumber) + '</span>' : '') +
              (price ? ' · <span class="bd-money">' + fmtMoney(price) + '</span>' : '') + '</div>' +
            '<div class="bd-chase-line">' + (col === 'followUp' ? 'In Follow up' : 'Sent') + ' ' + agoText(days) +
              (j.bidStageAt ? ' (' + shortDay(localDay(new Date(j.bidStageAt))) + ')' : '') +
              (last ? ' · follow-up drafted ' + agoText(lastDays || 0) +
                (ups.length > 1 ? ' (' + ups.length + ' so far)' : '') : '') + '</div>' +
          '</div>' +
          '<div class="bd-chase-act">' +
            (last && /^https:\/\/mail\.google\.com\//.test(String(last.link || ''))
              ? '<a class="btn btn-sm" href="' + esc(last.link) + '" target="_blank" rel="noopener">Open draft</a>' : '') +
            (email
              ? '<button class="btn btn-sm btn-filled" ' + (busy ? 'disabled' : '') +
                ' onclick="writeFollowUp(\'' + safeId(j._id) + '\')">' +
                (busy ? 'Writing…' : last ? 'Write another' : 'Write the email') + '</button>'
              : '<span class="bd-chase-none" title="Add the customer’s email on the job first">No email on the job</span>') +
          '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  window.writeFollowUp = async function (jobId) {
    if (!movesJobs() || drafting[jobId]) return;
    const j = jobsList().find(x => x._id === jobId);
    const user = me();
    const base = ((window.YD_CONFIG || {}).claudeEndpoint || '').replace(/\/+$/, '');
    if (!j || !user) return;
    if (!base) { showToast('The server address is not configured'); return; }
    drafting[jobId] = true;
    render();
    try {
      const res = await fetch(base + '/followup/draft', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + await user.getIdToken(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: jobId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || ('failed (' + res.status + ')'));
      // Read the job again: it may have changed while Claude was writing.
      const now = jobsList().find(x => x._id === jobId) || j;
      const ups = (Array.isArray(now.followUps) ? now.followUps : []).concat([{
        at: nowIso(), draftId: data.draftId || null, link: data.link || null,
        subject: data.subject || '', by: myName() || null,
      }]);
      if (!window.YDSync || !window.YDSync.patchJob(jobId, { followUps: ups })) {
        showToast('Draft saved in Gmail, but this device could not note it on the job');
      } else {
        showToast('Follow-up saved in Gmail Drafts — read it and send it from there');
      }
    } catch (e) {
      showToast('Could not write the email: ' + e.message);
    } finally {
      delete drafting[jobId];
      render();
    }
  };

  function boardSubtitle(b) {
    const touch = touchScreen();
    if (b.id === 'bids') return 'Every bid, from site visit to won or lost. ' +
      (touch ? 'Tap a card to move the job along.' : 'Drag a card, or tap it, to move the job along.');
    if (b.id === 'jobs') return 'Every job you have won, until it is paid. Moving a card changes the job’s status.' +
      (touch ? ' Tap a card to move it.' : '');
    const shared = (b.visibleTo || []).map(uid => personName(uid)).filter(Boolean);
    return (editsBoards()
      ? (shared.length ? 'Shared with ' + shared.map(esc).join(', ') : 'Only you can see this board')
      : 'Shared with you') +
      (touch && canMove(b.id) ? '. Tap a card to move it.' : '');
  }

  function columnsHtml(board) {
    if (board.virtual) {
      const grouped = jobCards(board);
      return board.columns.map(c => column(board, c, grouped[c.id].map(j => jobCardHtml(board, j)))).join('');
    }
    const mine = Object.values(cards[board.id] || {});
    return board.columns.map((c, i) => {
      const inCol = mine.filter(k => colOf(board, k) === c.id)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      const last = i === board.columns.length - 1;
      return column(board, c, inCol.map(k => storedCardHtml(board, k, last)));
    }).join('');
  }

  function column(board, c, cardHtml) {
    return '<div class="bd-col" data-board="' + board.id + '" data-col="' + c.id + '" ' +
        'ondragover="bdDragOver(event)" ondragleave="bdDragLeave(event)" ondrop="bdDrop(event)">' +
      '<div class="bd-col-head"><span>' + esc(c.name) + '</span>' +
        '<span class="bd-count">' + cardHtml.length + '</span></div>' +
      '<div class="bd-col-body">' +
        (cardHtml.join('') || '<div class="bd-empty">Nothing here</div>') +
        (!board.virtual && editsBoards()
          ? '<button class="bd-add-card" onclick="addCard(\'' + board.id + '\', \'' + c.id + '\')">+ Add a card</button>' : '') +
        // Won, Lost and Paid are where jobs end up, not where they start.
        (board.virtual && movesJobs() && ['won', 'lost', 'paid'].indexOf(c.id) === -1
          ? '<button class="bd-add-card" onclick="addJobCard(\'' + board.id + '\', \'' + c.id + '\')">' +
            (board.id === 'bids' ? '+ Add a bid' : '+ Add a job') + '</button>' : '') +
      '</div>' +
    '</div>';
  }

  function hasDraft(j) {
    const e = j.estimate;
    return !!(e && ((e.work || []).length || (e.materials || []).length) && !(j.qbEstimate && j.qbEstimate.id) &&
      ['siteVisit', 'toSend'].indexOf(bidColumn(j)) !== -1);
  }
  function jobCardHtml(board, j) {
    const since = board.id === 'bids' ? (j.bidStageAt || j.lastModified) : (j.workStageAt || j.lastModified);
    const days = daysSince(since);
    const price = parseMoney(j.jobPrice);
    const where = [j.address, j.city].filter(Boolean).join(', ');
    const services = (j.serviceTypes || []).join(', ');
    // A bid nobody has touched in a fortnight is the one about to be lost.
    const stale = board.id === 'bids' && ['sent', 'followUp'].indexOf(bidColumn(j)) !== -1 && days >= 14;
    return '<div class="bd-card' + coverClass(j.cardColor) + '" draggable="true" data-board="' + board.id + '" data-card="' + j._id + '" ' +
        coverStyle(j.cardColor) +
        'ondragstart="bdDragStart(event)" ondragend="bdDragEnd(event)" ' +
        'onclick="openJobCard(\'' + board.id + '\', \'' + j._id + '\')">' +
      '<div class="bd-card-title">' + esc(j.customerName || 'Untitled job') +
        (j.estimateNumber ? ' <span class="job-num">#' + esc(j.estimateNumber) + '</span>' : '') + '</div>' +
      (where ? '<div class="bd-card-line">' + esc(where) + '</div>' : '') +
      (services ? '<div class="bd-card-line muted">' + esc(services) + '</div>' : '') +
      // Claude's draft is waiting to be checked and sent (estimate.js).
      (board.id === 'bids' && hasDraft(j) ? '<div class="bd-card-line bd-draft">✨ Estimate drafted — check it & send</div>' : '') +
      // The customer said yes in QuickBooks (seen by the hourly check, quickbooks.sweep).
      (board.id === 'bids' && j.qbEstimate && j.qbEstimate.status === 'Accepted' && bidColumn(j) !== 'won'
        ? '<div class="bd-card-line bd-draft">✅ Accepted in QuickBooks — book it</div>' : '') +
      '<div class="bd-card-foot">' +
        (price ? '<span class="bd-money">' + fmtMoney(price) + '</span>' : '') +
        (days != null ? '<span class="bd-age' + (stale ? ' late' : '') + '">' +
          (days === 0 ? 'today' : days + 'd') + '</span>' : '') +
      '</div>' +
    '</div>';
  }

  // The linked job's number. Saved on the card since 2 Oct; older cards get it
  // from the job itself, which only the owner's device has.
  function jobNumOf(k) {
    if (k.jobNum) return k.jobNum;
    if (!k.jobId || !seesJobs()) return '';
    const j = jobsList().find(x => x._id === k.jobId);
    return j ? String(j.estimateNumber || '').trim() : '';
  }

  function storedCardHtml(board, k, inLastColumn) {
    const labels = (k.labels || []).map(id => (board.labels || []).find(l => l.id === id)).filter(Boolean);
    const list = k.checklist || [];
    const done = list.filter(i => i.done).length;
    const today = localDay();
    const dueState = !k.due || inLastColumn ? '' : k.due < today ? ' late' : k.due === today ? ' today' : '';
    return '<div class="bd-card' + (inLastColumn ? ' done' : '') + coverClass(k.color) + '" draggable="true" ' +
        coverStyle(k.color) +
        'data-board="' + board.id + '" data-card="' + k.id + '" ' +
        'ondragstart="bdDragStart(event)" ondragend="bdDragEnd(event)" ' +
        'onclick="openCardDetail(\'' + board.id + '\', \'' + k.id + '\')">' +
      (labels.length ? '<div class="bd-labels">' + labels.map(l =>
        '<span class="bd-label" style="--c:' + safeColor(l.color) + '">' + esc(l.name) + '</span>').join('') + '</div>' : '') +
      '<div class="bd-card-title">' + esc(k.title || 'Untitled') + '</div>' +
      (k.jobName ? '<div class="bd-card-line">📋 ' + esc(k.jobName) +
        (jobNumOf(k) ? ' <span class="job-num">#' + esc(jobNumOf(k)) + '</span>' : '') + '</div>' : '') +
      '<div class="bd-card-foot">' +
        (k.due ? '<span class="bd-due' + dueState + '">📅 ' + shortDay(k.due) + '</span>' : '') +
        (list.length ? '<span class="bd-check' + (done === list.length ? ' all' : '') + '">☑ ' +
          done + '/' + list.length + '</span>' : '') +
        (k.notes ? '<span class="bd-note" title="Has notes">≡</span>' : '') +
        (isOwner() && k.claude && k.claude.status === 'done' ? '<span class="bd-claude" title="Claude did this — check it">🤖</span>' : '') +
        (isOwner() && k.claude && k.claude.status === 'needs_info' ? '<span class="bd-claude ask" title="Claude needs something from you">🤖?</span>' : '') +
        (isOwner() && k.claude && k.claude.status === 'working' ? '<span class="bd-claude" title="Claude at home is working on this">🖥…</span>' : '') +
        (isOwner() && k.claude && k.claude.status === 'waiting_ok' && !k.claude.approvedAt ? '<span class="bd-claude ask" title="Built — waiting for your OK">🖥 OK?</span>' : '') +
        '<span class="bd-people">' + (k.assignees || []).map(a =>
          '<span class="bd-face" title="' + esc(nameOn(a)) + '">' + esc(initials(nameOn(a))) + '</span>').join('') + '</span>' +
      '</div>' +
    '</div>';
  }

  function personName(uid) {
    const p = people[uid];
    return p ? (p.name || p.email || 'Worker') : '';
  }
  // The name someone goes by now. A card keeps the name it was given when
  // they were put on it, which is only the fallback (a crew phone cannot read
  // other people's records) -- so a rename on Your Crew shows on every card.
  const nameOn = a => personName(a.uid) || a.name || 'Worker';

  // Colours come from a fixed palette, but they are also read back out of the
  // database and dropped into a style attribute -- so anything that is not a
  // plain hex colour is refused rather than trusted.
  function safeColor(c) {
    return /^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? c : '#6b7a8f';
  }

  // A card can be colour-coded: a band of colour across its top, the way
  // Trello does it, so a list can be read by colour at a glance.
  const hasCover = c => /^#[0-9a-fA-F]{3,8}$/.test(String(c || ''));
  const coverClass = c => (hasCover(c) ? ' covered' : '');
  const coverStyle = c => (hasCover(c) ? 'style="--cover:' + c + '" ' : '');

  // The colour choice in the card editor and on a job's card: none, or one of
  // the board palette.
  function colorPickHtml(name, current) {
    return '<div class="bd-swatches">' +
      '<label class="bd-swatch none" title="No colour"><input type="radio" name="' + name + '" value=""' +
        (hasCover(current) ? '' : ' checked') + '><span></span></label>' +
      PALETTE.map(c => '<label class="bd-swatch" style="--c:' + c + '"><input type="radio" name="' + name +
        '" value="' + c + '"' + (current === c ? ' checked' : '') + '><span></span></label>').join('') +
    '</div>';
  }
  function pickedColor(name) {
    const r = document.querySelector('input[name="' + name + '"]:checked');
    return r && hasCover(r.value) ? r.value : '';
  }

  // Each device remembers which board it was last looking at.
  function rememberedBoard(list) {
    let id = null;
    try { id = localStorage.getItem('ydjobhub_board'); } catch (e) {}
    return (id && list.some(b => b.id === id)) ? id : list[0].id;
  }
  window.showBoard = function (id) {
    current = id;
    try { localStorage.setItem('ydjobhub_board', id); } catch (e) {}
    render();
  };

  // ---------------------------------------------------------- drag and drop
  //
  // Mouse dragging on a laptop. Phones do not fire these events reliably, so
  // every card can also be moved from the sheet that opens when it is tapped --
  // which is the better way on a small screen anyway.

  window.bdDragStart = function (e) {
    const c = e.currentTarget;
    dragging = { boardId: c.dataset.board, cardId: c.dataset.card };
    c.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', dragging.cardId); e.dataTransfer.effectAllowed = 'move'; } catch (err) {}
  };
  window.bdDragEnd = function (e) {
    e.currentTarget.classList.remove('dragging');
    document.querySelectorAll('.bd-col.over').forEach(c => c.classList.remove('over'));
    dragging = null;
  };
  window.bdDragOver = function (e) {
    if (!dragging || dragging.boardId !== e.currentTarget.dataset.board) return;
    if (!canMove(dragging.boardId)) return;
    e.preventDefault();
    e.currentTarget.classList.add('over');
  };
  window.bdDragLeave = function (e) {
    if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('over');
  };
  window.bdDrop = function (e) {
    e.preventDefault();
    const col = e.currentTarget;
    col.classList.remove('over');
    if (!dragging || dragging.boardId !== col.dataset.board) return;
    const { boardId, cardId } = dragging;
    dragging = null;
    // Work out which card it was dropped above, so the order sticks.
    const siblings = Array.from(col.querySelectorAll('.bd-card')).filter(c => c.dataset.card !== cardId);
    const before = siblings.find(c => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    moveCard(boardId, cardId, col.dataset.col, before ? before.dataset.card : null);
  };

  function canMove(boardId) {
    if (boardId === 'bids' || boardId === 'jobs') return movesJobs();
    // Anyone a board is shared with moves its cards. Seeing every board (an
    // admin's "Boards: see") is not the same as being on one.
    const b = boards[boardId], mine = (me() || {}).uid;
    return editsBoards() || !!(b && (b.visibleTo || []).indexOf(mine) !== -1);
  }

  function moveCard(boardId, cardId, col, beforeId) {
    if (boardId === 'bids' || boardId === 'jobs') { moveJob(cardId, boardId, col); return; }
    const set = cards[boardId] || {};
    const k = set[cardId];
    const board = boards[boardId];
    if (!k || !board) return;
    // Cards with no column sit in the first one on screen, so they count
    // there too -- otherwise a card dropped among them was placed as if the
    // column were empty.
    const inCol = Object.values(set).filter(x => x.id !== cardId && colOf(board, x) === col)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    let order;
    const idx = beforeId ? inCol.findIndex(x => x.id === beforeId) : -1;
    if (idx === -1) order = inCol.length ? (inCol[inCol.length - 1].order || 0) + 1000 : 1000;
    else if (idx === 0) order = (inCol[0].order || 0) - 1000;
    else order = ((inCol[idx - 1].order || 0) + (inCol[idx].order || 0)) / 2;
    if (k.column === col && k.order === order) return;

    const last = board.columns[board.columns.length - 1].id;
    const patch = { column: col, order: order, updatedAt: nowIso(), updatedBy: myName() };
    // Reaching the last column is "done"; leaving it is "not done any more".
    patch.doneAt = col === last ? (k.doneAt || nowIso()) : null;
    Object.assign(k, patch);
    render();
    if (openCard && openCard.cardId === cardId) renderCardDetail();
    writeCard(boardId, cardId, patch);
  }

  // ------------------------------------------------------------- job cards

  window.openJobCard = function (boardId, jobId) {
    const board = boardById(boardId);
    const j = jobsList().find(x => x._id === jobId);
    if (!board || !j) return;
    const col = boardId === 'bids' ? bidColumn(j) : workColumn(j);
    openModal(esc(j.customerName || 'Job'),
      '<div class="bd-detail-sub">' + esc([j.address, j.city].filter(Boolean).join(', ')) + '</div>' +
      ((j.serviceTypes || []).length ? '<div class="bd-detail-line">' + esc(j.serviceTypes.join(', ')) + '</div>' : '') +
      (parseMoney(j.jobPrice) ? '<div class="bd-detail-line bold">' + fmtMoney(parseMoney(j.jobPrice)) + '</div>' : '') +
      '<div class="bd-move-label">Move to</div>' +
      '<div class="bd-move">' + board.columns.map(c =>
        '<button class="bd-move-btn' + (c.id === col ? ' on' : '') + '" style="--c:' + safeColor(board.color) + '" ' +
        (c.id === col ? 'disabled' : 'onclick="moveJobFromSheet(\'' + jobId + '\', \'' + boardId + '\', \'' + c.id + '\')"') +
        '>' + esc(c.name) + '</button>').join('') + '</div>' +
      '<div class="bd-move-label">Card colour</div>' +
      '<div onchange="setJobCardColor(\'' + safeId(jobId) + '\')">' + colorPickHtml('jcColor', j.cardColor) + '</div>' +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="openJobFromBoard(\'' + jobId + '\')">Open the job</button>' +
        '<button class="btn btn-sm" onclick="closeBoardModal()">Close</button>' +
      '</div>');
  };
  // Kept on the job itself, through the same path as a move, so the colour
  // shows on every device and survives the next save of the job form.
  window.setJobCardColor = function (jobId) {
    if (!movesJobs() || !window.YDSync) return;
    if (!window.YDSync.patchJob(jobId, { cardColor: pickedColor('jcColor') })) {
      showToast('Could not change that card');
      return;
    }
    render();
  };
  window.moveJobFromSheet = function (jobId, boardId, col) {
    closeBoardModal();
    moveJob(jobId, boardId, col);
  };
  window.openJobFromBoard = function (jobId) {
    closeBoardModal();
    // Already the job in the form: just go to it. Loading it again would read
    // the saved copy over whatever has been typed and not yet saved.
    if (typeof currentJobId !== 'undefined' && currentJobId === jobId) { switchTab('job'); return; }
    if (typeof dirty !== 'undefined' && dirty &&
        !confirm('The job open now has unsaved changes. Open this one anyway?')) return;
    if (typeof loadJob === 'function') loadJob(jobId);
    switchTab('job');
  };

  // A card on Bids or Jobs IS a job, so adding one makes the job: just the
  // customer's name for now, in the column it was added to. The rest is
  // filled in on the Job tab ("Open the job" on the card that opens).
  window.addJobCard = function (boardId, col) {
    const board = boardById(boardId);
    if (!board || !board.virtual || !movesJobs() || typeof createJobRecord !== 'function') return;
    const name = prompt(boardId === 'bids' ? 'Who is the bid for? (customer name)' : 'Who is the job for? (customer name)');
    if (!name || !name.trim()) return;
    const at = nowIso();
    const fields = { customerName: name.trim() };
    if (boardId === 'bids') {
      Object.assign(fields, { bidStage: col, bidStageAt: at, jobStatus: 'quoting' });
    } else {
      Object.assign(fields, { workStage: col, workStageAt: at,
        jobStatus: col === 'scheduled' ? 'booked' : ACTIVE_STAGES.indexOf(col) !== -1 ? 'inprogress' : 'complete' });
    }
    const id = createJobRecord(fields);
    if (!id) return;
    render();
    showToast(name.trim() + ' added to ' + board.columns.find(c => c.id === col).name);
    window.openJobCard(boardId, id);
  };

  // ----------------------------------------------------------- stored cards

  window.addCard = function (boardId, col) {
    if (!editsBoards()) return;
    openCard = { boardId: boardId, cardId: '', column: col };
    renderCardEditor();
  };

  window.openCardDetail = function (boardId, cardId) {
    openCard = { boardId: boardId, cardId: cardId };
    renderCardDetail();
  };

  function renderCardDetail() {
    const board = boards[openCard.boardId];
    const k = board && (cards[board.id] || {})[openCard.cardId];
    if (!k) { closeBoardModal(); return; }
    const labels = (k.labels || []).map(id => (board.labels || []).find(l => l.id === id)).filter(Boolean);
    const list = k.checklist || [];
    const here = colOf(board, k);
    openModal(esc(k.title || 'Card'),
      (labels.length ? '<div class="bd-labels big">' + labels.map(l =>
        '<span class="bd-label" style="--c:' + safeColor(l.color) + '">' + esc(l.name) + '</span>').join('') + '</div>' : '') +
      '<div class="bd-detail-meta">' +
        '<span>📌 ' + esc(board.name) + '</span>' +
        (k.due ? '<span>📅 ' + shortDay(k.due) + '</span>' : '') +
        ((k.assignees || []).length ? '<span>👤 ' + k.assignees.map(a => esc(nameOn(a))).join(', ') + '</span>' : '') +
        (k.jobName ? '<span>📋 ' + esc(k.jobName) + (jobNumOf(k) ? ' #' + esc(jobNumOf(k)) : '') + '</span>' : '') +
      '</div>' +
      (k.notes ? '<div class="bd-notes">' + esc(k.notes) + '</div>' : '') +
      (list.length ? '<div class="bd-move-label">Checklist</div><div class="bd-checklist">' +
        list.map(i => '<label class="chk bd-chk"><input type="checkbox"' + (i.done ? ' checked' : '') +
          ' onchange="toggleCheck(\'' + i.id + '\', this.checked)"><span' + (i.done ? ' class="struck"' : '') + '>' +
          esc(i.text) + '</span></label>').join('') + '</div>' : '') +
      '<div class="bd-move-label">Move to</div>' +
      '<div class="bd-move">' + board.columns.map(c =>
        '<button class="bd-move-btn' + (c.id === here ? ' on' : '') + '" style="--c:' + safeColor(board.color) + '" ' +
        (c.id === here ? 'disabled' : 'onclick="moveCardFromSheet(\'' + c.id + '\')"') +
        '>' + esc(c.name) + '</button>').join('') + '</div>' +
      (k.updatedBy ? '<div class="hint">Last moved by ' + esc(k.updatedBy) + '</div>' : '') +
      claudeHtml(board, k) +
      '<div class="field-actions">' +
        (editsBoards() ? '<button class="btn btn-filled" onclick="editCard()">Edit</button>' : '') +
        '<button class="btn btn-sm" onclick="closeBoardModal()">Close</button>' +
      '</div>');
  }

  // ------------------------------------------------- Claude on the cards
  //
  // Two Claudes work the cards. The server does it every hour from 7 am to
  // 7 pm (research, writing, emails left in Gmail Drafts -- never sent). When
  // the owner leaves the computer at home on, Claude there checks every 20
  // minutes instead and can do more: websites, documents, and changes to Job
  // Hub itself -- which it builds and then waits for "Put it live". The
  // computer says it is awake in settings/homeComputer; while it is, the
  // server leaves the cards to it. What either did is kept on the card as
  // `claude` (`by: 'computer'` for the one at home). Only the owner sees this
  // and steers it: the work can name customers and prices.
  const MACHINE_BOARD = 'maintenance';
  const COMPUTER_AWAKE_MIN = 45;

  // When the computer at home last checked in. Read now and then rather than
  // watched: it changes every 20 minutes and only the owner's screen shows it.
  let homeComputer = null, homeComputerAt = 0;
  function computerAwake() {
    const t = homeComputer && Date.parse(homeComputer.lastSeenAt || '');
    return !!t && Date.now() - t < COMPUTER_AWAKE_MIN * 60000;
  }
  function refreshComputer() {
    if (!isOwner() || !window.YDDb || Date.now() - homeComputerAt < 60000) return;
    homeComputerAt = Date.now();
    Promise.resolve(window.YDDb.get('settings', 'homeComputer'))
      .then(d => { homeComputer = d; redrawIfVisible(); })
      .catch(() => {});
  }
  function computerLine() {
    if (!isOwner() || !homeComputer || !homeComputer.lastSeenAt) return '';
    const t = new Date(homeComputer.lastSeenAt);
    const when = t.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return '<div class="bd-computer' + (computerAwake() ? ' on' : '') + '">🖥 ' +
      (computerAwake() ? 'Computer at home is on — last checked the cards ' : 'Computer at home is off — last on ') +
      esc(when) + '</div>';
  }

  function claudeHtml(board, k) {
    if (!isOwner() || board.virtual || board.id === MACHINE_BOARD || k.auto) return '';
    const c = k.claude || null;
    const last = board.columns[board.columns.length - 1].id;
    const finished = colOf(board, k) === last;
    const head = '<div class="bd-move-label">Claude</div>';
    if (k.noClaude) {
      return head + '<div class="cl-box muted">Claude leaves this card alone.' +
        '<div class="field-actions"><button class="btn btn-sm" onclick="claudeAllow(true)">Let Claude look at it</button></div></div>';
    }
    if (!c) {
      return head + '<div class="cl-box muted">' + (finished ? 'Done — Claude does not look at finished cards.'
        : computerAwake() ? 'Claude on the computer at home looks at new cards every 20 minutes and does the ones it can.'
        : 'Claude looks at new cards every hour from 7 am to 7 pm and does the ones it can by itself.') +
        '<div class="field-actions">' +
          (finished ? '' : '<button class="btn btn-sm btn-filled" onclick="claudeNow()">🤖 Ask Claude now</button>') +
          '<button class="btn btn-sm" onclick="claudeAllow(false)">Not for Claude</button>' +
        '</div></div>';
    }
    const when = c.at ? new Date(c.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    const who = c.by === 'computer' ? '🖥 Claude at home' : '🤖 Claude';
    if (c.status === 'working') {
      return head + '<div class="cl-box working"><div class="cl-title">' + who + ' is working on this' +
        (when ? ' <span class="muted">· since ' + esc(when) + '</span>' : '') + '</div>' +
        '<div class="hint">What it did shows here when it has finished.</div></div>';
    }
    const title = c.status === 'done' ? who + ' did this — check it'
      : c.status === 'needs_info' ? who + ' needs something from you'
      : c.status === 'waiting_ok' ? (c.approvedAt ? '🖥 Going live on the next check (within 20 minutes)'
        : '🖥 Built — waiting for your OK to put it live')
      : '🤖 Not one Claude can do';
    return head + '<div class="cl-box ' + esc(c.status || '') + '">' +
      '<div class="cl-title">' + title + (when ? ' <span class="muted">· ' + esc(when) + '</span>' : '') + '</div>' +
      (c.summary ? '<div class="cl-summary">' + esc(c.summary) + '</div>' : '') +
      (c.result ? '<div class="cl-result">' + esc(c.result) + '</div>' : '') +
      ((c.drafts || []).length ? '<div class="cl-drafts">' + c.drafts.map(d =>
        '<a class="btn btn-sm" href="' + esc(safeLink(d.link)) + '" target="_blank" rel="noopener">✉️ Draft to ' +
        esc(d.to || '') + '</a>').join('') + '</div>' : '') +
      (c.status === 'needs_info' ? '<div class="hint">Add what it needs to the card (Edit → Notes) and it looks again ' +
        (computerAwake() ? 'within 20 minutes' : 'within the hour') + '.</div>' : '') +
      '<div class="field-actions">' +
        (c.status === 'waiting_ok' && !c.approvedAt
          ? '<button class="btn btn-sm btn-filled" onclick="claudeApprove()">✅ Put it live</button>' : '') +
        '<button class="btn btn-sm" onclick="claudeAgain()">Ask Claude again</button>' +
        '<button class="btn btn-sm" onclick="claudeAllow(false)">Not for Claude</button>' +
      '</div></div>';
  }

  // Only links into Gmail are drawn as links -- the text comes from the server,
  // but a link is where a stray address would do harm.
  function safeLink(u) {
    return /^https:\/\/mail\.google\.com\//.test(String(u || '')) ? u : 'https://mail.google.com/mail/#drafts';
  }

  function claudePatch(patch) {
    const k = openCard && (cards[openCard.boardId] || {})[openCard.cardId];
    if (!k || !isOwner()) return null;
    Object.assign(k, patch);
    render(); renderCardDetail();
    writeCard(openCard.boardId, openCard.cardId, patch);
    return k;
  }
  // A change Claude at home built goes live only on the owner's say-so. The
  // whole record is written back, approval added: the save merges, and a
  // record written in pieces could keep a stale field.
  window.claudeApprove = function () {
    const k = openCard && (cards[openCard.boardId] || {})[openCard.cardId];
    if (!k || !k.claude || k.claude.status !== 'waiting_ok') return;
    if (!confirm('Put this change live for everyone using Job Hub?')) return;
    claudePatch({ claude: Object.assign({}, k.claude, { approvedAt: nowIso(), approvedBy: myName() }) });
    showToast('It goes live on the next check — within 20 minutes');
  };
  window.claudeAllow = function (yes) {
    claudePatch({ noClaude: !yes });
    showToast(yes ? 'Claude will look at this card' : 'Claude will leave this card alone');
  };
  // Forgets what Claude did, so the next run (or Ask now) does it afresh.
  window.claudeAgain = function () {
    if (!confirm('Have Claude do this card again? What it did before is replaced (drafts already in Gmail stay there).')) return;
    claudePatch({ claude: null });
    showToast('Claude will look at it again within the hour');
  };
  window.claudeNow = async function () {
    if (!openCard || !isOwner() || !window.YDClaude) return;
    const ids = { boardId: openCard.boardId, cardId: openCard.cardId };
    showToast('Claude is on it — this can take a minute');
    try {
      const r = await window.YDClaude.post('/cards/now', ids);
      const got = (r.report || [])[0] || {};
      showToast(got.status === 'done' ? 'Claude did it — have a look'
        : got.status === 'needs_info' ? 'Claude needs something from you'
        : got.status === 'not_mine' ? 'Not one Claude can do'
        : got.skipped ? 'Not now — ' + got.skipped : 'Claude could not finish this one');
    } catch (e) {
      showToast(e.message || 'Claude could not be reached');
    }
  };

  window.moveCardFromSheet = function (col) {
    if (!openCard) return;
    moveCard(openCard.boardId, openCard.cardId, col, null);
  };

  window.toggleCheck = function (itemId, done) {
    const k = (cards[openCard.boardId] || {})[openCard.cardId];
    if (!k) return;
    const checklist = (k.checklist || []).map(i => i.id === itemId
      ? Object.assign({}, i, { done: !!done, doneBy: done ? myName() : null }) : i);
    const patch = { checklist: checklist, updatedAt: nowIso(), updatedBy: myName() };
    Object.assign(k, patch);
    render(); renderCardDetail();
    writeCard(openCard.boardId, openCard.cardId, patch);
  };

  window.editCard = function () {
    if (!openCard || !editsBoards()) return;
    renderCardEditor();
  };

  function renderCardEditor() {
    const board = boards[openCard.boardId];
    if (!board) return;
    const k = openCard.cardId ? (cards[board.id] || {})[openCard.cardId] : {};
    const crew = crewPeople();
    pickJobs = jobsList();
    const linked = k.jobId ? pickJobs.find(j => j._id === k.jobId) : null;
    const chosen = new Set((k.assignees || []).map(a => a.uid));
    const labelsOn = new Set(k.labels || []);

    openModal(openCard.cardId ? 'Edit card' : 'New card on ' + esc(board.name),
      '<div class="field"><span class="label">What needs doing</span>' +
        '<input id="cdTitle" value="' + esc(k.title || '') + '" placeholder="e.g. Pick up 3 pallets of pavers"></div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Column</span><select id="cdCol">' +
          board.columns.map(c => '<option value="' + c.id + '"' +
            (c.id === (k.column || openCard.column || board.columns[0].id) ? ' selected' : '') + '>' +
            esc(c.name) + '</option>').join('') + '</select></div>' +
        '<div class="field"><span class="label">Due</span>' +
          '<input type="date" id="cdDue" value="' + esc(k.due || '') + '"></div>' +
      '</div>' +
      '<div class="field"><span class="label">Labels</span><div class="bd-pick">' +
        (board.labels || []).map(l => '<label class="bd-pick-item" style="--c:' + safeColor(l.color) + '">' +
          '<input type="checkbox" class="cdLabel" value="' + l.id + '"' + (labelsOn.has(l.id) ? ' checked' : '') + '>' +
          '<span class="bd-label">' + esc(l.name) + '</span></label>').join('') +
      '</div></div>' +
      '<div class="field"><span class="label">Card colour</span>' + colorPickHtml('cdColor', k.color) + '</div>' +
      (crew.length ? '<div class="field"><span class="label">Who is on it</span><div class="bd-pick">' +
        crew.map(p => '<label class="bd-pick-item"><input type="checkbox" class="cdWho" value="' + p.uid + '"' +
          (chosen.has(p.uid) ? ' checked' : '') + '><span>' + esc(p.name) + '</span></label>').join('') +
        '</div>' +
        (board.visibleTo && board.visibleTo.length ? '' :
          '<div class="hint">This board is not shared with anyone yet, so the people you pick ' +
          'here will not see it until you share it in Board settings.</div>') +
      '</div>' : '') +
      // A search box rather than a list of every customer's name, which grew
      // too long to scroll. A job not on this device keeps its link as it was.
      // Someone without Jobs has no jobs to pick from; whatever is linked stays.
      (!seesJobs() ? '<input type="hidden" id="cdJob" value="' + esc(k.jobId || '') + '">' :
      '<div class="field"><span class="label">Linked job</span>' +
        '<input type="hidden" id="cdJob" value="' + esc(k.jobId || '') + '">' +
        '<div class="jobpick">' +
          '<input id="cdJobSearch" autocomplete="off" placeholder="Search by name, address, town or estimate #" ' +
            'value="' + esc(linked ? jobLine(linked) : (k.jobName || '')) + '" ' +
            'oninput="cardJobFilter()" onfocus="cardJobFilter(true)" onkeydown="cardJobKey(event)" onblur="cardJobBlur()">' +
          '<button type="button" class="jobpick-clear" onclick="cardJobPick(\'\')" ' +
            'title="Unlink the job" aria-label="Unlink the job">&times;</button>' +
        '</div>' +
        '<div class="jobpick-list" id="cdJobList" role="listbox" hidden></div>' +
        '<div class="hint">Crew see only the job’s name, never its price.</div></div>') +
      '<div class="field"><span class="label">Notes</span>' +
        '<textarea id="cdNotes" rows="3" placeholder="Details, measurements, where to find things">' +
        esc(k.notes || '') + '</textarea></div>' +
      '<div class="field"><span class="label">Checklist — one item per line</span>' +
        '<textarea id="cdList" rows="4" placeholder="e.g.\n4 bags polymeric sand\nedge restraint">' +
        esc((k.checklist || []).map(i => (i.done ? '[x] ' : '') + i.text).join('\n')) + '</textarea>' +
        '<div class="hint">Start a line with [x] to mark it already done.</div></div>' +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="saveCard()">Save</button>' +
        '<button class="btn btn-sm" onclick="' + (openCard.cardId ? 'renderCardDetail2()' : 'closeBoardModal()') + '">Cancel</button>' +
        (openCard.cardId ? '<button class="btn btn-sm" onclick="removeCard()">Delete card</button>' : '') +
      '</div>');
    const t = el('cdTitle'); if (t) t.focus();
  }
  window.renderCardDetail2 = function () { renderCardDetail(); };

  // ---------------------------------------------------- the linked-job search

  let pickJobs = [];     // every job on this device, read when the editor opens
  let pickShown = [];    // the matches on screen, in order
  let pickAt = -1;       // the one the arrow keys are on

  // How a job is named in the box: who, and where -- two jobs for the same
  // customer are told apart by the address.
  function jobLine(j) {
    return (j.customerName || 'Untitled job') + (j.estimateNumber ? ' #' + j.estimateNumber : '') +
      (j.address ? ' — ' + j.address : '');
  }
  const isDone = j => normStatusOf(j) === 'complete';
  function normStatusOf(j) {
    return typeof normStatus === 'function' ? normStatus(j.jobStatus, j) : (j.jobStatus || 'quoting');
  }

  // Every word typed must appear somewhere in the job: "smith oak" finds the
  // Smith job on Oak Street; an estimate number or a ZIP works on its own.
  function jobMatches(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return pickJobs.filter(j => {
      if (!words.length) return true;
      const hay = [j.customerName, j.address, j.city, j.zip, j.estimateNumber,
        (j.serviceTypes || []).join(' ')].join(' ').toLowerCase();
      return words.every(w => hay.indexOf(w) !== -1);
    }).sort((a, b) => (isDone(a) - isDone(b)) ||
      String(a.customerName || '').localeCompare(String(b.customerName || '')));
  }

  // On focus the whole list shows, open jobs first; typing narrows it. The
  // box still holding the linked job's name is not a search for it.
  window.cardJobFilter = function (focusing) {
    const box = el('cdJobSearch'), list = el('cdJobList');
    if (!box || !list) return;
    const linked = pickJobs.find(j => j._id === val('cdJob'));
    const q = focusing && linked && box.value === jobLine(linked) ? '' : box.value;
    const all = jobMatches(q);
    pickShown = all.slice(0, 40);
    pickAt = pickShown.length ? 0 : -1;
    list.innerHTML = pickShown.length
      ? pickShown.map((j, i) => {
          const st = normStatusOf(j);
          return '<button type="button" class="jobpick-item' + (i === pickAt ? ' on' : '') + '" role="option" ' +
            'onmousedown="event.preventDefault()" onclick="cardJobPick(\'' + safeId(j._id) + '\')">' +
            '<span class="jobpick-name">' + esc(j.customerName || 'Untitled job') +
              (j.estimateNumber ? ' <span class="job-num">#' + esc(j.estimateNumber) + '</span>' : '') + '</span>' +
            '<span class="jobpick-where">' + esc([j.address, j.city].filter(Boolean).join(', ') || '—') + '</span>' +
            (typeof statusPill === 'function' ? statusPill(st) : '') +
          '</button>';
        }).join('') +
        (all.length > pickShown.length ? '<div class="jobpick-more">' + (all.length - pickShown.length) +
          ' more — keep typing to narrow it down</div>' : '')
      : '<div class="jobpick-more">No job matches “' + esc(q) + '”</div>';
    list.hidden = false;
  };

  window.cardJobPick = function (id) {
    const j = id ? pickJobs.find(x => x._id === id) : null;
    el('cdJob').value = j ? j._id : '';
    el('cdJobSearch').value = j ? jobLine(j) : '';
    el('cdJobList').hidden = true;
    if (!j) el('cdJobSearch').focus();
  };

  window.cardJobKey = function (e) {
    const list = el('cdJobList');
    if (!list || list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!pickShown.length) return;
      pickAt = (pickAt + (e.key === 'ArrowDown' ? 1 : -1) + pickShown.length) % pickShown.length;
      list.querySelectorAll('.jobpick-item').forEach((b, i) => {
        b.classList.toggle('on', i === pickAt);
        if (i === pickAt) b.scrollIntoView({ block: 'nearest' });
      });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (pickShown[pickAt]) cardJobPick(pickShown[pickAt]._id);
    } else if (e.key === 'Escape') {
      // Closes the list only, not the whole card editor behind it.
      e.preventDefault();
      cardJobBlur();
    }
  };

  // Leaving the box without picking puts back what is actually linked, so
  // half-typed words never look like a link that is not there.
  window.cardJobBlur = function () {
    const list = el('cdJobList'), box = el('cdJobSearch');
    if (list) list.hidden = true;
    if (!box) return;
    const id = val('cdJob');
    const j = pickJobs.find(x => x._id === id);
    const k = openCard && openCard.cardId ? (cards[openCard.boardId] || {})[openCard.cardId] : null;
    box.value = j ? jobLine(j) : (id && k && k.jobId === id ? (k.jobName || '') : '');
  };

  window.saveCard = function () {
    if (!openCard || !editsBoards()) return;
    const board = boards[openCard.boardId];
    const title = val('cdTitle');
    if (!title) { showToast('Say what needs doing'); return; }
    const id = openCard.cardId || newId('cd');
    const was = (cards[board.id] || {})[id] || {};

    // A copy, used up as lines are matched, so two lines that both say
    // "Sweep" keep two different ids and ticking one does not tick both.
    const oldList = (was.checklist || []).slice();
    const checklist = (el('cdList').value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      .map((line, i) => {
        const done = /^\[x\]\s*/i.test(line);
        const text = line.replace(/^\[x\]\s*/i, '');
        // Keep an item's id (and who ticked it) if the same line was there before.
        const at = oldList.findIndex(o => o.text === text);
        const prev = at === -1 ? null : oldList.splice(at, 1)[0];
        return { id: prev ? prev.id : 'ck' + i + Date.now().toString(36), text: text, done: done,
                 doneBy: done ? ((prev && prev.doneBy) || myName()) : null };
      });

    const crew = crewPeople();
    const assignees = Array.from(document.querySelectorAll('.cdWho:checked'))
      .map(i => crew.find(p => p.uid === i.value)).filter(Boolean)
      .map(p => ({ uid: p.uid, name: p.name }));
    const jobId = val('cdJob');
    const job = jobId ? jobsList().find(j => j._id === jobId) : null;
    // Linked to a job this device does not have: leave the link as it was.
    const keepLink = !job && jobId && jobId === was.jobId;
    const col = val('cdCol') || board.columns[0].id;
    const last = board.columns[board.columns.length - 1].id;

    const rec = {
      title: title,
      column: col,
      order: was.column === col && was.order != null ? was.order : endOrder(board.id, col),
      due: val('cdDue') || null,
      labels: Array.from(document.querySelectorAll('.cdLabel:checked')).map(i => i.value),
      color: pickedColor('cdColor'),
      assignees: assignees,
      jobId: job ? job._id : (keepLink ? was.jobId : null),
      jobName: job ? (job.customerName || 'Untitled job') : (keepLink ? (was.jobName || null) : null),
      jobNum: job ? (String(job.estimateNumber || '').trim() || null) : (keepLink ? (was.jobNum || null) : null),
      notes: el('cdNotes').value.trim(),
      checklist: checklist,
      doneAt: col === last ? (was.doneAt || nowIso()) : null,
      createdAt: was.createdAt || nowIso(),
      createdBy: was.createdBy || myName(),
      updatedAt: nowIso(),
      updatedBy: myName(),
    };
    cards[board.id] = cards[board.id] || {};
    cards[board.id][id] = Object.assign({ id: id }, rec);
    openCard.cardId = id;
    render(); renderCardDetail();
    writeCard(board.id, id, rec);
  };

  function endOrder(boardId, col) {
    const board = boards[boardId];
    const inCol = Object.values(cards[boardId] || {}).filter(k => board ? colOf(board, k) === col : k.column === col);
    return inCol.length ? Math.max.apply(null, inCol.map(k => k.order || 0)) + 1000 : 1000;
  }

  window.removeCard = function () {
    if (!openCard || !editsBoards()) return;
    const k = (cards[openCard.boardId] || {})[openCard.cardId];
    if (!k || !confirm('Delete "' + k.title + '"?')) return;
    delete cards[openCard.boardId][openCard.cardId];
    const where = 'boards/' + openCard.boardId + '/cards';
    const id = openCard.cardId;
    closeBoardModal(); render();
    Promise.resolve(window.YDDb.remove(where, id))
      .catch(e => console.warn('[boards] card not removed:', e.code || e.message));
  };

  function crewPeople() {
    return Object.keys(people)
      .filter(uid => people[uid].active && ['crew', 'admin', 'owner'].indexOf(people[uid].role) !== -1)
      .map(uid => ({ uid: uid, name: people[uid].name || people[uid].email || 'Worker', role: people[uid].role }))
      .sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0) || a.name.localeCompare(b.name));
  }

  // ------------------------------------------------------- board settings

  // The columns and labels being edited, kept here while the form is open so
  // adding, removing and reordering can redraw the lists without losing what
  // has been typed. Each keeps its id from when it was made: renaming a column
  // keeps its cards, and deleting the middle one moves only ITS cards.
  let draftCols = [], draftLabels = [];

  window.editBoard = function (id) {
    if (!editsBoards()) return;
    editingBoard = id;
    const b = id ? boards[id] : {};
    const crew = crewPeople().filter(p => p.role !== 'owner');
    const shared = new Set(b.visibleTo || []);
    const color = b.color || PALETTE[Object.keys(boards).length % PALETTE.length];
    draftCols = (b.columns || TEMPLATES.crew.columns.map(n => ({ name: n })))
      .map(c => ({ id: c.id || null, name: c.name }));
    draftLabels = (b.labels || DEFAULT_LABELS).map(l => ({ id: l.id, name: l.name, color: l.color }));

    openModal(id ? 'Board settings' : 'New board',
      '<div class="field"><span class="label">Name</span>' +
        '<input id="bdName" value="' + esc(b.name || '') + '" placeholder="e.g. Crew — this week"></div>' +
      '<div class="field"><span class="label">Colour</span><div class="bd-swatches">' +
        PALETTE.map(c => '<label class="bd-swatch" style="--c:' + c + '"><input type="radio" name="bdColor" value="' + c + '"' +
          (c === color ? ' checked' : '') + '><span></span></label>').join('') + '</div></div>' +
      (id ? '' :
        '<div class="field"><span class="label">Start from</span><select id="bdTemplate" onchange="bdTemplateChanged()">' +
          Object.keys(TEMPLATES).map(t => '<option value="' + t + '"' + (t === 'crew' ? ' selected' : '') + '>' +
            TEMPLATES[t].label + '</option>').join('') +
        '</select></div>') +
      '<div class="field"><span class="label">Columns, left to right</span>' +
        '<div id="bdColList" class="bd-edit-list"></div>' +
        '<button class="btn btn-sm" onclick="bdColAdd()">+ Add a column</button>' +
        '<div class="hint">The last column counts as done. Cards in a column you delete move to the first column.</div>' +
      '</div>' +
      '<div class="field"><span class="label">Labels</span>' +
        '<div id="bdLabelList" class="bd-edit-list"></div>' +
        '<button class="btn btn-sm" onclick="bdLabelAdd()">+ Add a label</button>' +
      '</div>' +
      '<div class="field"><span class="label">Who can see it</span>' +
        (crew.length
          ? '<div class="bd-pick">' + crew.map(p => '<label class="bd-pick-item"><input type="checkbox" class="bdShare" value="' +
              esc(p.uid) + '"' + (shared.has(p.uid) ? ' checked' : '') + '><span>' + esc(p.name) + '</span></label>').join('') + '</div>' +
            '<div class="hint">Anyone ticked sees this board and its cards, can move cards and tick ' +
            'checklists. They cannot add, edit or delete cards. Leave everyone unticked to keep it to yourself.</div>'
          : '<div class="hint">No crew accounts yet. Once someone signs in and you approve them, they appear here.</div>') +
      '</div>' +
      (id === MAINTENANCE
        ? '<div class="hint">This board is kept in step with the Equipment tab — a card for every machine ' +
          'with a service coming up and every problem noted on one — so it cannot be deleted. ' +
          'Rename it, recolour it or share it as you like.</div>'
        : '') +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="saveBoard()">Save</button>' +
        '<button class="btn btn-sm" onclick="closeBoardModal()">Cancel</button>' +
        (id && id !== MAINTENANCE ? '<button class="btn btn-sm" onclick="removeBoard(\'' + id + '\')">Delete board</button>' : '') +
      '</div>');
    drawDrafts();
    const n = el('bdName'); if (n && !id) n.focus();
  };

  // Read whatever has been typed back into the drafts before a redraw.
  function readDrafts() {
    document.querySelectorAll('.bdColName').forEach((inp, i) => { if (draftCols[i]) draftCols[i].name = inp.value; });
    document.querySelectorAll('.bdLabelName').forEach((inp, i) => { if (draftLabels[i]) draftLabels[i].name = inp.value; });
  }

  function drawDrafts() {
    const cl = el('bdColList'), ll = el('bdLabelList');
    if (cl) cl.innerHTML = draftCols.map((c, i) =>
      '<div class="bd-edit-row">' +
        '<span class="bd-edit-num">' + (i + 1) + '</span>' +
        '<input class="bdColName" value="' + esc(c.name) + '" placeholder="Column name" aria-label="Column ' + (i + 1) + '">' +
        '<button class="bd-edit-btn" onclick="bdColMove(' + i + ', -1)"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move earlier">↑</button>' +
        '<button class="bd-edit-btn" onclick="bdColMove(' + i + ', 1)"' + (i === draftCols.length - 1 ? ' disabled' : '') + ' aria-label="Move later">↓</button>' +
        '<button class="bd-edit-btn del" onclick="bdColRemove(' + i + ')"' + (draftCols.length === 1 ? ' disabled' : '') + ' aria-label="Delete column">✕</button>' +
      '</div>').join('');
    if (ll) ll.innerHTML = draftLabels.length ? draftLabels.map((l, i) =>
      '<div class="bd-edit-label">' +
        '<div class="bd-edit-row">' +
          '<span class="bd-label" style="--c:' + safeColor(l.color) + '">' + esc(l.name || 'Label') + '</span>' +
          '<input class="bdLabelName" value="' + esc(l.name) + '" placeholder="Label name" ' +
            'oninput="this.previousElementSibling.textContent = this.value || \'Label\'" aria-label="Label name">' +
          '<button class="bd-edit-btn del" onclick="bdLabelRemove(' + i + ')" aria-label="Delete label">✕</button>' +
        '</div>' +
        '<div class="bd-swatches small">' + PALETTE.map(c =>
          '<button class="bd-dotpick' + (c === l.color ? ' on' : '') + '" style="--c:' + c + '" ' +
          'onclick="bdLabelColor(' + i + ', \'' + c + '\')" aria-label="Colour"></button>').join('') + '</div>' +
      '</div>').join('') : '<div class="hint">No labels.</div>';
  }

  window.bdColAdd = function () {
    readDrafts();
    // New columns go in just before the last (done) column, which is nearly
    // always where a new step belongs.
    draftCols.splice(Math.max(0, draftCols.length - 1), 0, { id: null, name: '' });
    drawDrafts();
    const inputs = document.querySelectorAll('.bdColName');
    const box = inputs[Math.max(0, draftCols.length - 2)];
    if (box) box.focus();
  };
  window.bdColMove = function (i, d) {
    readDrafts();
    const j = i + d;
    if (j < 0 || j >= draftCols.length) return;
    const t = draftCols[i]; draftCols[i] = draftCols[j]; draftCols[j] = t;
    drawDrafts();
  };
  window.bdColRemove = function (i) {
    readDrafts();
    if (draftCols.length <= 1) return;
    draftCols.splice(i, 1);
    drawDrafts();
  };
  window.bdLabelAdd = function () {
    readDrafts();
    draftLabels.push({ id: null, name: '', color: PALETTE[draftLabels.length % PALETTE.length] });
    drawDrafts();
    const inputs = document.querySelectorAll('.bdLabelName');
    if (inputs.length) inputs[inputs.length - 1].focus();
  };
  window.bdLabelRemove = function (i) { readDrafts(); draftLabels.splice(i, 1); drawDrafts(); };
  window.bdLabelColor = function (i, c) {
    readDrafts();
    if (draftLabels[i] && /^#[0-9a-fA-F]{6}$/.test(c)) draftLabels[i].color = c;
    drawDrafts();
  };

  window.bdTemplateChanged = function () {
    const t = TEMPLATES[val('bdTemplate')] || TEMPLATES.blank;
    draftCols = t.columns.map(n => ({ id: null, name: n }));
    drawDrafts();
  };

  window.saveBoard = function () {
    if (!editsBoards()) return;
    readDrafts();
    const name = val('bdName');
    if (!name) { showToast('Give the board a name'); return; }
    const cols = draftCols.map(c => ({ id: c.id, name: String(c.name || '').trim() })).filter(c => c.name);
    if (!cols.length) { showToast('A board needs at least one column'); return; }
    const id = editingBoard || newId('bd');
    const was = boards[id] || {};
    const stamp = Date.now().toString(36);
    const columns = cols.map((c, i) => ({ id: c.id || 'col' + i + stamp, name: c.name }));
    const labels = draftLabels.filter(l => String(l.name || '').trim()).map((l, i) => ({
      id: l.id || 'lb' + i + stamp, name: String(l.name).trim(), color: safeColor(l.color),
    }));
    const colorInput = document.querySelector('input[name="bdColor"]:checked');

    const rec = {
      name: name,
      color: colorInput ? colorInput.value : PALETTE[0],
      columns: columns,
      labels: labels,
      visibleTo: Array.from(document.querySelectorAll('.bdShare:checked')).map(i => i.value),
      order: was.order != null ? was.order : Object.keys(boards).length + 1,
      createdAt: was.createdAt || nowIso(),
      updatedAt: nowIso(),
    };
    boards[id] = Object.assign({ id: id }, rec);
    write('boards', id, rec, 'saving the board');

    // Cards in a column that no longer exists go to the first column rather
    // than vanishing from view. And "done" follows the last column wherever
    // it now is: reordering can make a different column last, and the cards
    // in it are done from now on, while those left behind in the old last
    // column are not done any more.
    const live = new Set(columns.map(c => c.id));
    const lastId = columns[columns.length - 1].id;
    Object.values(cards[id] || {}).forEach(k => {
      const patch = {};
      if (!live.has(k.column)) patch.column = columns[0].id;
      // Except the Equipment tab's own cards: whether a machine's problem is
      // fixed is on the machine, and Equipment files those cards by it.
      // Stamping them done here would record every open problem that ended
      // up in the new last column as fixed, when nobody had touched it.
      if (!k.auto) {
        const done = (patch.column || k.column) === lastId;
        if (done && !k.doneAt) patch.doneAt = nowIso();
        if (!done && k.doneAt) patch.doneAt = null;
      }
      if (!Object.keys(patch).length) return;
      patch.updatedAt = nowIso();
      patch.updatedBy = myName();
      Object.assign(k, patch);
      writeCard(id, k.id, patch);
    });

    if (!cardUnsubs[id]) watchCards(id);
    closeBoardModal();
    current = id;
    render();
    showToast(name + ' saved');
  };

  window.removeBoard = function (id) {
    const b = boards[id];
    if (!b || !editsBoards() || id === MAINTENANCE) return;
    const n = Object.keys(cards[id] || {}).length;
    if (!confirm('Delete the board "' + b.name + '"' + (n ? ' and its ' + n + ' card' + (n === 1 ? '' : 's') : '') +
                 '? This cannot be undone.')) return;
    const ids = Object.keys(cards[id] || {});
    if (cardUnsubs[id]) { cardUnsubs[id](); delete cardUnsubs[id]; }
    delete boards[id]; delete cards[id]; delete cardsLoaded[id];
    current = null;
    closeBoardModal(); render();
    // Cards first: a card left behind under a deleted board would be
    // unreachable, since the rules check the board to decide who may read it.
    Promise.resolve(window.YDDb.removeMany(
      ids.map(cid => ['boards/' + id + '/cards', cid]).concat([['boards', id]])
    )).catch(e => console.warn('[boards] board not yet removed:', e.code || e.message));
  };

  // ---------------------------------------------------------------- modal

  function openModal(title, html) {
    const m = el('boardModal');
    const t = el('boardModalTitle');
    const b = el('boardModalBody');
    if (!m || !b) return;
    if (t) t.innerHTML = title;
    b.innerHTML = html;
    m.classList.add('active');
  }
  window.closeBoardModal = function () {
    const m = el('boardModal');
    if (m) m.classList.remove('active');
    openCard = null; editingBoard = null;
  };

  // ---------------------------------------------------------------- writes

  // Never awaited: a Firestore write only settles when the server answers, and
  // waiting for that in a truck with no signal would freeze the screen. The
  // local copy is already updated; Firestore sends the write when it can.
  function write(path, id, data, what) {
    if (!window.YDDb) { showToast('Not saved — still connecting'); return; }
    Promise.resolve(window.YDDb.put(path, id, data)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[boards] ' + what + ' not yet on the server:', (e && e.code) || e);
    });
  }
  function writeCard(boardId, cardId, data) {
    write('boards/' + boardId + '/cards', cardId, data, 'card ' + cardId);
  }

  // --------------------------------------------------------------- loading

  function watchCards(boardId) {
    if (cardUnsubs[boardId] || !window.YDDb) return;
    cardUnsubs[boardId] = window.YDDb.watch('boards/' + boardId + '/cards', (changes, meta) => {
      const set = cards[boardId] = cards[boardId] || {};
      changes.forEach(c => {
        if (c.type === 'removed') delete set[c.id];
        else set[c.id] = Object.assign({ id: c.id }, c.data);
      });
      // Set before the event below goes out, so whoever is listening sees it.
      if (meta && !meta.fromCache) cardsLoaded[boardId] = true;
      redrawIfVisible();
      // The calendar shows cards with due dates.
      document.dispatchEvent(new CustomEvent('yd-cards-changed'));
      if (openCard && openCard.boardId === boardId && openCard.cardId && !document.getElementById('cdTitle')) {
        renderCardDetail();
      }
    });
  }

  function onBoards(changes, meta) {
    changes.forEach(c => {
      if (c.type === 'removed') {
        delete boards[c.id];
        if (cardUnsubs[c.id]) { cardUnsubs[c.id](); delete cardUnsubs[c.id]; }
        delete cards[c.id]; delete cardsLoaded[c.id];
      } else {
        boards[c.id] = Object.assign({ id: c.id }, c.data);
        watchCards(c.id);
      }
    });
    // Only seed once the server has actually answered. An empty answer from the
    // local cache on a fresh phone would otherwise create the starter boards a
    // second time.
    // The first answer from the server, as opposed to the local cache: only
    // now is "this board does not exist" actually true.
    if (meta && !meta.fromCache && !ready) {
      ready = true;
      document.dispatchEvent(new CustomEvent('yd-boards-ready'));
    }
    if (isOwner() && !seeded && meta && !meta.fromCache) {
      seeded = true;
      if (!Object.keys(boards).length) seedOnce();
      if (!boards[WISHES]) wishesOnce();
    }
    redrawIfVisible();
  }

  // "Job Hub wishes" (Jonah, 6 Oct 2026): a card from his phone whenever he
  // thinks of something for the app. "Work on the wish list" starts by
  // copying new cards into WISHLIST.md; Claude's hourly card run leaves this
  // board alone (cards.py SKIP_BOARDS). Made once -- deleted, it stays gone.
  const WISHES = 'wishes';
  async function wishesOnce() {
    let flags = null;
    try { flags = await window.YDDb.get('settings', 'seeds'); } catch (e) { return; }
    if ((flags && flags.wishes) || boards[WISHES]) return;
    const b = {
      name: 'Job Hub wishes', color: '#2a9d8f', order: 90, visibleTo: [],
      columns: [{ id: 'w0', name: 'New wishes' }, { id: 'w1', name: 'On the wish list' }, { id: 'w2', name: 'Built' }],
      labels: DEFAULT_LABELS, createdAt: nowIso(), updatedAt: nowIso(),
    };
    boards[WISHES] = Object.assign({ id: WISHES }, b);
    write('boards', WISHES, b, 'wishes board');
    write('settings', 'seeds', { wishes: true }, 'seed marker');
    watchCards(WISHES);
    redrawIfVisible();
  }

  // Two boards to start with, so the screen is not empty on day one. Fixed ids
  // mean two devices seeding at once write the same two boards, not four.
  // Only ever once. Seeding whenever there were no boards brought the two
  // starters back every time the owner deleted them.
  async function seedOnce() {
    let flags = null;
    try { flags = await window.YDDb.get('settings', 'seeds'); } catch (e) { return; }
    if (flags && flags.boards) return;
    if (Object.keys(boards).length) return;
    seedBoards();
    write('settings', 'seeds', { boards: true }, 'seed marker');
    redrawIfVisible();
  }

  function seedBoards() {
    const mk = (id, name, color, tpl, order) => ({
      name: name, color: color, order: order, visibleTo: [],
      columns: TEMPLATES[tpl].columns.map((n, i) => ({ id: tpl + i, name: n })),
      labels: DEFAULT_LABELS, createdAt: nowIso(), updatedAt: nowIso(),
    });
    const todo = mk('todo', 'My to-dos', '#8e5bc7', 'admin', 1);
    const crew = mk('crew', 'Crew tasks', '#e07b24', 'crew', 2);
    boards.todo = Object.assign({ id: 'todo' }, todo);
    boards.crew = Object.assign({ id: 'crew' }, crew);
    write('boards', 'todo', todo, 'seeding');
    write('boards', 'crew', crew, 'seeding');
    watchCards('todo'); watchCards('crew');
  }

  function redrawIfVisible() {
    const p = el('panel-boards');
    if (p && p.classList.contains('active')) render();
  }

  function stop() {
    if (unsubBoards) { unsubBoards(); unsubBoards = null; }
    if (unsubPeople) { unsubPeople(); unsubPeople = null; }
    Object.values(cardUnsubs).forEach(u => u());
    cardUnsubs = {}; cardsLoaded = {}; boards = {}; cards = {}; people = {}; seeded = false; current = null; ready = false;
  }

  function start(a) {
    stop();
    if (!window.YDDb || !a.user) return;
    if (seesAllBoards()) {
      unsubBoards = window.YDDb.watch('boards', onBoards);
    } else {
      // Crew may only ask for the boards that list them.
      unsubBoards = window.YDDb.watchContains('boards', 'visibleTo', a.user.uid, onBoards,
        () => redrawIfVisible());
    }
    // Names for the people on cards, and who a board can be shared with.
    if (a.isOwner || a.isAdmin) {
      unsubPeople = window.YDDb.watch('users', changes => {
        changes.forEach(c => {
          if (c.type === 'removed') delete people[c.id];
          else people[c.id] = c.data;
        });
        redrawIfVisible();
      }, () => {});
    }
  }

  window.YDBoards = {
    render: render,
    ready: () => ready,
    // Whether a board's cards have come from the server, not just the cache.
    cardsReady: id => !!cardsLoaded[id],
    boards: () => boards,
    cards: () => cards,
    people: () => people,
    // For the calendar: every stored card with a due date, with its board.
    dueCards: () => {
      const out = [];
      Object.keys(cards).forEach(bid => {
        const b = boards[bid];
        if (!b) return;
        const last = b.columns[b.columns.length - 1].id;
        Object.values(cards[bid]).forEach(k => {
          if (k.due) out.push({ board: b, card: k, done: colOf(b, k) === last });
        });
      });
      return out;
    },
  };

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const tab = el('tabBoards');
    const on = a.mode === 'cloud' && !!a.user;
    if (tab) tab.hidden = !on;
    if (on) start(a); else stop();
    render();
  });
  document.addEventListener('yd-jobs-changed', redrawIfVisible);

  function boot() { render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
