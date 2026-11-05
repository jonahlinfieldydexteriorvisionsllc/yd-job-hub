// Money: what comes in and what goes out, on one tab.
//
// It was on six screens: invoices and subcontractors on All Jobs, bills to pay
// on Receipts, monthly bills and tax dates in pop-ups off All settings, the
// pay sheet and wages on the Clock (review of 4 Nov 2026; Jonah: "Yes, Money
// tab"). This file holds no money of its own. Each list still belongs to its
// own file and is drawn into a place on this panel (index.html):
//   Owed to you  invoices.js
//   To pay       monthlybills.js, receipts.js (Invoices to pay)
//   Subs         subs.js
//   Payroll      paysheet.js, timeclock.js (Hours & Wages), paychecks.js
//   Tax dates    deadlines.js
//
// One view at a time, picked with tap buttons that wrap (never a row that
// scrolls sideways): these lists are long, and stacked they were 20 screens on
// a phone. Each button says what is waiting there, so the tab reads at a glance.
//
// What each person gets is what they could see before, by the same access:
// Billing for invoices, Hours for wages; bills, subs, the pay sheet and tax
// dates are the owner's. Nobody with none of it gets the tab.
(function () {
  'use strict';

  const KEY = 'ydjobhub_moneyView';
  const el = id => document.getElementById(id);
  const signedIn = () => !!(window.YDAuth && YDAuth.mode === 'cloud' && YDAuth.user);
  const owner = () => signedIn() && YDAuth.isOwner === true;
  const can = (area, level) => signedIn() && typeof ydCan === 'function' && ydCan(area, level);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');
  const dollars = n => '$' + Math.round(n).toLocaleString('en-US');

  const VIEWS = [
    { id: 'owed', icon: '💵', name: 'Owed to you', sees: () => can('billing', 'see'),
      sub: () => {
        const open = Object.values(YDInvoices.all() || {}).filter(i => i.open && Number(i.balance) > 0);
        if (!open.length) return 'Nothing owed';
        const todo = YDInvoices.toDo ? YDInvoices.toDo().length : 0;
        return dollars(open.reduce((t, i) => t + Number(i.balance), 0)) + (todo ? ' · ' + todo + ' to do' : '');
      },
      open: () => YDInvoices.render() },
    { id: 'pay', icon: '💸', name: 'To pay', sees: () => owner() || can('billing', 'see'),
      sub: () => {
        const bills = window.YDMonthlyBills ? YDMonthlyBills.due() : [];
        const inv = (window.YDReceipts && YDReceipts.toPay ? YDReceipts.toPay() : []).filter(r => r && !r.pulled);
        return [bills.length ? plural(bills.length, 'bill') + ' due' : '', inv.length ? plural(inv.length, 'invoice') : '']
          .filter(Boolean).join(' · ') || 'Nothing due';
      },
      open: () => {
        if (window.YDMonthlyBills) YDMonthlyBills.show();
        if (window.YDReceipts && YDReceipts.renderPay) YDReceipts.renderPay();
      } },
    { id: 'subs', icon: '🤝', name: 'Subs', sees: owner,
      sub: () => {
        const n = YDSubs.toMatch().reduce((t, x) => t + x.n, 0);
        return n ? plural(n, 'bill') + ' to match' : 'All matched';
      },
      open: () => YDSubs.render() },
    { id: 'payroll', icon: '👷', name: 'Payroll', sees: () => can('hours', 'see'),
      sub: () => (owner() && window.YDPaySheet ? 'Pay day ' + YDPaySheet.nextDay() : 'Hours & wages'),
      open: () => {
        if (owner() && window.YDPaySheet) YDPaySheet.show();
        if (typeof window.renderClock === 'function') window.renderClock();
      } },
    { id: 'tax', icon: '🗓️', name: 'Tax dates', sees: owner,
      sub: () => {
        const n = YDDeadlines.soon().length;
        return n ? plural(n, 'date') + ' coming up' : 'Nothing soon';
      },
      open: () => YDDeadlines.show() },
  ];

  let view = '';
  try { view = localStorage.getItem(KEY) || ''; } catch (e) { /* private window: just this visit */ }

  const allowed = () => VIEWS.filter(v => v.sees());
  const panelOn = () => { const p = el('panel-money'); return !!(p && p.classList.contains('active')); };
  const words = v => { try { return v.sub() || ''; } catch (e) { return ''; } };
  function current(list) { return list.find(v => v.id === view) || list[0] || null; }

  function buttons() {
    const wrap = el('moneyViews');
    if (!wrap) return;
    const list = allowed(), now = current(list);
    // One view has nothing to choose between.
    wrap.innerHTML = list.length < 2 ? '' : list.map(v =>
      '<button type="button" class="mn-view-btn' + (now && v.id === now.id ? ' on' : '') + '" aria-pressed="' + !!(now && v.id === now.id) +
        '" onclick="YDMoney.show(\'' + v.id + '\')"><b>' + v.icon + ' ' + esc(v.name) + '</b><small>' + esc(words(v)) + '</small></button>').join('');
  }

  // The tab, and the lines on the screens these lists used to be on.
  function access() {
    const list = allowed();
    const tab = el('tabMoney');
    if (tab) tab.hidden = !list.length;
    document.querySelectorAll('.mn-moved').forEach(n => { n.hidden = !list.some(v => v.id === n.dataset.view); });
    ['billsSection', 'paySheetSection', 'dlSection'].forEach(id => { const s = el(id); if (s) s.hidden = !owner(); });
  }

  function render() {
    const list = allowed(), now = current(list);
    access();
    if (!now) return;
    view = now.id;
    buttons();
    document.querySelectorAll('#panel-money [data-money]').forEach(n => { n.hidden = n.dataset.money !== view; });
    try { now.open(); } catch (e) { console.warn('[money] ' + view + ':', e); }
    emptyNote();
  }
  // A view whose lists all have nothing in them (Invoices to pay shows only
  // when there are some, and it may be all a person has there).
  function emptyNote() {
    const box = document.querySelector('#panel-money [data-money="' + view + '"]'), note = el('moneyEmpty');
    if (box && note) note.hidden = Array.from(box.querySelectorAll('.section')).some(s => !s.hidden);
  }

  // Every way in: this tab's buttons, Home's Waiting on you, a tapped
  // notification, Search, the openX of each list.
  function show(id) {
    if (VIEWS.some(v => v.id === id)) {
      view = id;
      try { localStorage.setItem(KEY, id); } catch (e) { /* private window: just this visit */ }
    }
    if (panelOn()) render();
    else if (typeof switchTab === 'function') switchTab('money');
  }

  window.YDMoney = {
    render: render,
    show: show,
    // Is this view on screen now? Each list draws itself only then.
    showing: id => panelOn() && view === id,
  };

  document.addEventListener('yd-auth', access);
  document.addEventListener('yd-my-record', access);
  // What each button says waiting there.
  ['yd-invoices', 'yd-receipts', 'yd-bills', 'yd-subs', 'yd-deadlines', 'yd-paysheet'].forEach(ev =>
    document.addEventListener(ev, () => { if (panelOn()) { buttons(); emptyNote(); } }));
})();
