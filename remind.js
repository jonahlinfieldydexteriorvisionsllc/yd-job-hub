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
//   - to whoever it is theirs (isMine): the people on it; with nobody on it,
//     a crew task goes to every crew member and anything else to whoever
//     made it (the owner, mostly).
// A thing's own Remind box overrides the usual one for the people it
// reminds, and "No reminder" switches it off for everyone. Ticked off,
// nothing.
//
// Who gets the usual reminders: everyone with "Remind me of everything" on
// (Notifications & summaries -- on unless they switch it off; Jonah, 12 Oct:
// "make it so crew members can get notifications"), for every calendar
// entry and card that is theirs, and the owner for each machine due.

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
  // pickup, and one on Crew tasks or tagged 👷 Crew a crew task. Anything on
  // the Crew tasks calendar is a crew task.
  const BY_CALENDAR = { visits: 'bid', schedule: 'crew', personal: 'personal', crew: 'crew' };
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
  // this person. `mine`: the thing is theirs (isMine).
  function line(item, type, timed, mine) {
    if (!item) return '';
    if (item.noReminder) return '🔕 No reminder';
    if (item.hasReminder && item.remindMins != null) return '🔔 Reminder: ' + setWords(item.remindMins).toLowerCase();
    return usualFor(item) && mine ? '🔔 Reminder: ' + usualWords(type, timed) : '';
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
      return 'Usual: ' + when + ', to the people on it — or, with nobody on it, to every crew member.';
    }
    if (autoOn === false) {
      return 'Usual: nothing — your automatic reminders are off (⋯ → Notifications &amp; summaries).';
    }
    return 'Usual: ' + when + '. Phones need notifications switched on: ⋯ → Notifications &amp; summaries.';
  }

  // Who counts as crew (Jonah, 12 Oct 2026: "mark profiles in the app as
  // crew members"): ticked on Your Crew. A crew account is unless unticked,
  // an admin only when ticked, the owner never.
  function isCrewMember(u) {
    if (!u || u.role === 'owner') return false;
    return u.crewMember === true || (u.role === 'crew' && u.crewMember !== false);
  }

  // Whose a thing is. Jonah (12 Oct 2026): "my cards are cards i dont select
  // anyone else on or ones i select myself on." So it is theirs when they are
  // on it; with nobody on it, a crew task is every crew member's and
  // anything else is whoever made it's -- the owner's when that is nobody we
  // know (made from his email, an import, a machine's own card). The 👤 Mine
  // filters, My day and the reminders (functions/reminders.py _is_mine) all
  // read it this way. `who` = { uid, owner, crew (a crew member),
  // makerOf(createdBy) -> uid or '' }.
  function isMine(onUids, type, maker, who) {
    if (!who || !who.uid) return false;
    if (onUids.indexOf(who.uid) !== -1) return true;
    if (onUids.length) return false;
    if ((typeById(type) || {}).crew) return !!who.crew;
    if (maker) return maker === who.uid;
    return !!who.owner;
  }
  // A card keeps the NAME of whoever made it; makerOf turns that into them.
  function cardIsMine(card, board, who) {
    if (!card || !who) return false;
    const on = (card.assignees || []).map(a => a && a.uid).filter(Boolean);
    const maker = who.makerOf ? who.makerOf(card.createdBy) : '';
    return isMine(on, typeOf(card, { boardId: board && board.id }), maker, who);
  }
  // A calendar entry keeps the uid of whoever made it (from 12 Oct 2026; the
  // ones before are the owner's).
  function eventIsMine(ev, cal, who) {
    if (!ev || !who) return false;
    const on = (ev.crew || []).map(c => c && c.uid).filter(Boolean);
    return isMine(on, typeOf(ev, { calKind: cal && cal.kind }), ev.createdBy || '', who);
  }
  // This person, as isMine wants them. `people`: uid -> user record, where
  // this device has them (the owner's and an admin's do; a crew phone knows
  // only its own, and a card's maker it cannot name is not its anyway).
  function who(people) {
    const a = window.YDAuth || {};
    if (!a.user) return null;
    const byName = {};
    Object.keys(people || {}).forEach(uid => {
      const p = people[uid] || {};
      [p.name, p.email].forEach(n => { const k = String(n || '').trim().toLowerCase(); if (k) byName[k] = uid; });
    });
    const mine = meRec || { role: a.role };
    return { uid: a.user.uid, owner: !!a.isOwner, crew: isCrewMember(mine),
             makerOf: by => byName[String(by || '').trim().toLowerCase()] || '' };
  }

  // Whether this one will buzz this person by the usual rule -- for the 🔔
  // beside it. Its own reminder is shown by the screen itself.
  function usualFor(item) {
    return autoOn === true && !!item && !item.noReminder && !item.hasReminder;
  }

  // On for everyone unless they switched it off (notify.js DEFAULTS).
  let meRec = null;         // this person's own user record (crewMember)
  function readPrefs(a) {
    autoOn = null; meRec = null;
    if (!a || a.mode !== 'cloud' || !a.user || !window.YDDb) return;
    Promise.resolve(window.YDDb.get('digestPrefs', a.user.uid)).then(p => {
      autoOn = p && typeof p.autoRemind === 'boolean' ? p.autoRemind : true;
    }).catch(() => { autoOn = true; });
    Promise.resolve(window.YDDb.get('users', a.user.uid)).then(u => {
      meRec = u ? Object.assign({ uid: a.user.uid }, u) : null;
      document.dispatchEvent(new CustomEvent('yd-remind-me'));
    }).catch(() => {});
  }
  document.addEventListener('yd-auth', e => readPrefs(e.detail || {}));

  window.YDRemind = {
    TYPES: TYPES,
    typeById: typeById,
    typeOf: typeOf,
    icon: icon,
    color: color,
    ink: ink,
    isCrewMember: isCrewMember,
    cardIsMine: cardIsMine,
    eventIsMine: eventIsMine,
    who: who,
    me: () => meRec,
    usualWords: usualWords,
    usualHint: usualHint,
    setWords: setWords,
    line: line,
    optionsHtml: optionsHtml,
    fromChoice: fromChoice,
    usualFor: usualFor,
    // notify.js tells this when the person flips the switch.
    setAuto: on => { autoOn = !!on; },
    autoOn: () => autoOn,
  };
})();
