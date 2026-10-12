// What kind of thing a calendar entry or a board card is, and when it buzzes
// the phone without anybody setting a reminder on it.
//
// Jonah (12 Oct 2026): "i want all of my things on the calendar to auto send
// notifications to my phone", "every card thats mine" too -- and to pick what
// each one is, "a quote appointment or a material pickup, because some stuff
// on the calendar just needs to be done that day but not at a specific time".
// Bids ping an hour before AND half an hour before. Each kind has its own
// colour ("blue should be crew tasks ie: things not for jonah to handle",
// pink personal, yellow doctors, green quotes).
//
// The usual reminder (functions/reminders.py _usual sends it, by the same
// rules):
//   - anything at a set time: 30 minutes before; a bid appointment 1 hour
//     and 30 minutes before;
//   - anything for no particular time (all day, a pickup, a to-do): one list
//     at 7 am of all of that day's -- the calendar's "any time today"
//     checklist, on the phone;
//   - a crew task: only to the people on it.
// A thing's own Remind box overrides the usual one for the people it
// reminds, and "No reminder" switches it off for everyone. Ticked off,
// nothing.
//
// Who gets the usual reminders: each person with "Remind me of everything"
// switched on (Notifications & summaries -- on for the owner unless he turns
// it off, off for everyone else until they turn it on). They get every
// calendar entry they can see, every machine service due if they see
// Equipment, and every card that is theirs (cardIsMine).

(function () {
  'use strict';

  // `timed`: whether it happens at a set time. Picking one that is not sets
  // the entry to all day (null: leaves it as it is); a card simply needs no
  // time. `color`: each kind has its own on the calendar (Jonah, 12 Oct:
  // "a certain color for everything" -- crew blue, personal pink, doctors
  // yellow, quotes green; the rest are ours to suggest). `ink`: dark
  // writing on a light colour.
  const TYPES = [
    { id: 'bid', icon: '📋', name: 'Bid appointment', timed: true, color: '#2f8f5b' },
    { id: 'appt', icon: '🕑', name: 'Appointment', timed: true, color: '#8e5bc7' },
    { id: 'doctor', icon: '🩺', name: 'Doctor’s appointment', timed: true, color: '#f2c230', ink: '#2b2200' },
    { id: 'pickup', icon: '🚚', name: 'Material pickup', timed: false, color: '#e07b24' },
    { id: 'delivery', icon: '🚛', name: 'Delivery', timed: false, color: '#8a6d3b' },
    { id: 'todo', icon: '✅', name: 'To do that day', timed: false, color: '#1a9c8c' },
    // "Things not for Jonah to handle": on his calendar so he sees them all,
    // but they buzz only the people on them.
    { id: 'crew', icon: '👷', name: 'Crew task', timed: false, color: '#2f6fd6', crew: true },
    { id: 'personal', icon: '🏠', name: 'Personal', timed: null, color: '#d94f8a' },
  ];
  const TIMED_LEADS = [30];
  const LEADS = { bid: [60, 30] };
  // The card from a pickup email (functions/receipts.py) and Jonah's own
  // forwarded to-dos carry this as their maker.
  const EMAIL_MADE = 'job hub (email)';

  // Picking one's own reminder: the usual one, none at all, or a set time.
  const CHOICES = [
    ['', 'Usual'], ['none', 'No reminder'], ['0', 'At the time'], ['10', '10 minutes before'],
    ['30', '30 minutes before'], ['60', '1 hour before'], ['120', '2 hours before'],
    ['1440', 'The day before'], ['2880', 'Two days before'],
  ];

  let autoOn = null;        // this person's "Remind me of everything" (null: not read yet)

  const typeById = id => TYPES.find(t => t.id === id) || null;

  // What a thing is. Nothing picked, it goes by where it is: Site visits
  // ("Estimates and walk-throughs") are bid appointments, the Work schedule
  // (who is working which job) crew tasks, Personal personal; a card on
  // Pickups -- made from a store's "ready for pickup" email -- is a material
  // pickup, and one on Crew tasks or tagged 👷 Crew a crew task.
  const BY_CALENDAR = { visits: 'bid', schedule: 'crew', personal: 'personal' };
  function typeOf(item, where) {
    if (item && typeById(item.type)) return item.type;
    where = where || {};
    if (BY_CALENDAR[where.calKind]) return BY_CALENDAR[where.calKind];
    if (where.boardId === 'pickups') return 'pickup';
    if (where.boardId === 'crew' || (item && (item.labels || []).indexOf('crew') !== -1)) return 'crew';
    return '';
  }
  function icon(type) { const t = typeById(type); return t ? t.icon : ''; }
  function color(type) { const t = typeById(type); return t ? t.color : ''; }
  function ink(type) { const t = typeById(type); return (t && t.ink) || ''; }
  // A crew task buzzes only the people on it; anything else, whoever it is
  // for (every entry they see, every card of theirs).
  const forMe = (type, onIt) => !(typeById(type) || {}).crew || !!onIt;

  function minutesWords(m) {
    if (m >= 60 && m % 60 === 0) return m === 60 ? '1 hour' : (m / 60) + ' hours';
    return m + ' minutes';
  }
  // When the usual reminder comes, in words: "1 hour and 30 minutes before".
  function usualWords(type, timed) {
    if (!timed) return 'in the day’s list at 7 am';
    return (LEADS[type] || TIMED_LEADS).map(minutesWords).join(' and ') + ' before';
  }

  // A reminder set on the thing itself, in words: "30 minutes before".
  function setWords(mins) {
    const hit = CHOICES.find(c => c[0] === String(mins));
    return hit ? hit[1] : minutesWords(Number(mins)) + ' before';
  }
  // The reminder line for the details window, '' when there is none for
  // this person. `onIt`: they are one of the people on it.
  function line(item, type, timed, onIt) {
    if (!item) return '';
    if (item.noReminder) return '🔕 No reminder';
    if (item.hasReminder && item.remindMins != null) return '🔔 Reminder: ' + setWords(item.remindMins).toLowerCase();
    return usualFor(item) && forMe(type, onIt) ? '🔔 Reminder: ' + usualWords(type, timed) : '';
  }

  // The Remind box's value for a saved entry or card.
  function choiceOf(item) {
    if (!item) return '';
    if (item.noReminder) return 'none';
    return item.hasReminder && item.remindMins != null ? String(item.remindMins) : '';
  }
  function optionsHtml(item) {
    const on = choiceOf(item);
    // A set time that is not one of the choices (an imported entry) stays
    // as it is rather than turning into "Usual" on the next save.
    const list = CHOICES.some(c => c[0] === on) ? CHOICES
      : CHOICES.concat([[on, minutesWords(Number(on)) + ' before']]);
    return list.map(([v, words]) => '<option value="' + v + '"' + (v === on ? ' selected' : '') + '>' +
      words + '</option>').join('');
  }
  // What the box says, as the fields saved. Whoever set a reminder before
  // keeps theirs when someone else edits it.
  function fromChoice(v, was, uid) {
    if (v === 'none') return { hasReminder: false, remindMins: null, remindUids: [], noReminder: true };
    if (v === '') return { hasReminder: false, remindMins: null, remindUids: [], noReminder: false };
    return { hasReminder: true, remindMins: parseInt(v, 10), noReminder: false,
             remindUids: Array.from(new Set(((was && was.remindUids) || []).concat(uid ? [uid] : []))) };
  }
  // The line under the Remind box: what "Usual" means for this one.
  function usualHint(type, timed) {
    const when = usualWords(type, timed);
    if ((typeById(type) || {}).crew) {
      return 'Usual: ' + when + ', to the people on it who have automatic reminders on — not to you unless you are one of them.';
    }
    if (autoOn === false) {
      return 'Usual: nothing — your automatic reminders are off (⋯ → Notifications &amp; summaries).';
    }
    return 'Usual: ' + when + '. Phones need notifications switched on: ⋯ → Notifications &amp; summaries.';
  }

  // Whether a card is this person's. The 👤 Mine filter, the calendar's "only
  // mine" and the reminders (functions/reminders.py _card_is_mine) all read
  // it this way: they are on it; or nobody is on it and they made it, or it
  // is the owner's -- made from his own email (a pickup, a forwarded to-do)
  // or on a board of his marked Private. `who` = { uid, names (lower case:
  // their name and email), owner }. A card keeps the name of whoever made it,
  // so after a rename only the cards they are on still count.
  function cardIsMine(card, board, who) {
    if (!card || !who || !who.uid) return false;
    const on = card.assignees || [];
    if (on.some(a => a && a.uid === who.uid)) return true;
    if (on.length) return false;
    const by = String(card.createdBy || '').trim().toLowerCase();
    if (by && (who.names || []).indexOf(by) !== -1) return true;
    return !!who.owner && (by === EMAIL_MADE || !!(board && board.ownerOnly === true));
  }

  // Whether this one will buzz this person by the usual rule -- for the 🔔
  // beside it. Its own reminder is shown by the screen itself.
  function usualFor(item) {
    return autoOn === true && !!item && !item.noReminder && !item.hasReminder;
  }

  function readPrefs(a) {
    autoOn = null;
    if (!a || a.mode !== 'cloud' || !a.user || !window.YDDb) return;
    const fallback = !!a.isOwner;
    Promise.resolve(window.YDDb.get('digestPrefs', a.user.uid)).then(p => {
      autoOn = p && typeof p.autoRemind === 'boolean' ? p.autoRemind : fallback;
    }).catch(() => { autoOn = fallback; });
  }
  document.addEventListener('yd-auth', e => readPrefs(e.detail || {}));

  window.YDRemind = {
    TYPES: TYPES,
    typeById: typeById,
    typeOf: typeOf,
    icon: icon,
    color: color,
    ink: ink,
    forMe: forMe,
    usualWords: usualWords,
    usualHint: usualHint,
    setWords: setWords,
    line: line,
    optionsHtml: optionsHtml,
    fromChoice: fromChoice,
    cardIsMine: cardIsMine,
    usualFor: usualFor,
    // notify.js tells this when the person flips the switch.
    setAuto: on => { autoOn = !!on; },
    autoOn: () => autoOn,
  };
})();
