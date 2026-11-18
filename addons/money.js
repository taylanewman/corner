/*
 * Money add-on for Corner (version 1).
 * Lives in its own file and only loads when switched on (Settings & backup → Add-ons).
 * Its data is kept in its own section ("pm/addon-money"), separate from tasks and webs.
 * Everything here is plain arithmetic: no AI, nothing sent anywhere else.
 * Shows the math, not financial advice.
 */
(function () {
  'use strict';

  /* ---------------- data ---------------- */
  var API = null, D = null, loaded = false, dirty = false, saveT = null, refreshToday = function () {};
  var root = null, tab = 'month', step = 1, tip = null;

  function blank() {
    return { v: 1, setupDone: false, incomes: [], sources: [], side: [], taxRate: 25, bills: [], debts: [], paid: {},
      style: 'snowball', extra: 0, cushion: { goal: 500, saved: 0 }, showOnToday: true };
  }
  function norm(d) {
    var b = blank(); d = d && typeof d === 'object' ? d : {};
    Object.keys(b).forEach(function (k) { if (d[k] === undefined || d[k] === null) d[k] = b[k]; });
    ['incomes', 'sources', 'side', 'bills', 'debts'].forEach(function (k) { if (!Array.isArray(d[k])) d[k] = []; });
    if (typeof d.paid !== 'object') d.paid = {};
    if (!d.cushion || typeof d.cushion !== 'object') d.cushion = b.cushion;
    return d;
  }
  function uid() { return Math.random().toString(36).slice(2, 10); }
  function save() {
    if (!API || !API.editable) return;
    dirty = true; clearTimeout(saveT);
    saveT = setTimeout(function () {
      API.save(D).then(function () { dirty = false; }, function () { dirty = false; API.toast('Couldn’t save your money changes. They’ll retry when you edit again.'); });
    }, 350);
  }
  function num(v) { var n = parseFloat(String(v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; }

  /* ---------------- dates ---------------- */
  function today() { return API ? API.today() : new Date().toISOString().slice(0, 10); }
  function P(s) { var a = s.split('-'); return new Date(+a[0], +a[1] - 1, +a[2]); }
  function S(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function add(s, n) { var d = P(s); d.setDate(d.getDate() + n); return S(d); }
  function dim(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function nice(s) { return P(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); }
  function short(s) { return P(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  function monthName(y, m) { return new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); }
  function money(n, cents) { var neg = n < 0; n = Math.abs(n); var s = '$' + n.toLocaleString(undefined, { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }); return neg ? '−' + s : s; }
  function m$(n) { return money(n, Math.round(n) !== n); }

  /* paydays for one income between from..to (inclusive) */
  function paydays(inc, from, to) {
    var out = [], amt = num(inc.amount);
    if (!amt) return out;
    if (inc.freq === 'weekly' || inc.freq === 'biweekly') {
      if (!inc.anchor) return out;
      var stepD = inc.freq === 'weekly' ? 7 : 14, a = P(inc.anchor), f = P(from);
      var k = Math.floor((f - a) / 864e5 / stepD) - 1, d = new Date(a); d.setDate(a.getDate() + k * stepD);
      for (var i = 0; i < 400; i++) { var s = S(d); if (s > to) break; if (s >= from) out.push({ date: s, amount: amt, inc: inc }); d.setDate(d.getDate() + stepD); }
    } else {
      var days = inc.freq === 'semimonthly' ? [inc.day1 || 1, inc.day2 || 15] : [inc.day1 || 1];
      var y = P(from).getFullYear(), m = P(from).getMonth();
      for (var j = 0; j < 30; j++) {
        days.forEach(function (dd) { var s = S(new Date(y, m, Math.min(dd, dim(y, m)))); if (s >= from && s <= to) out.push({ date: s, amount: amt, inc: inc }); });
        m++; if (m > 11) { m = 0; y++; } if (S(new Date(y, m, 1)) > to) break;
      }
    }
    return out;
  }
  function allPaydays(from, to) {
    var by = {};
    D.incomes.forEach(function (inc) { paydays(inc, from, to).forEach(function (p) { (by[p.date] = by[p.date] || []).push(p); }); });
    return Object.keys(by).sort().map(function (d) { return { date: d, items: by[d], amount: by[d].reduce(function (a, p) { return a + p.amount; }, 0) }; });
  }
  /* bill + debt-minimum due dates between from..to */
  function dues(from, to) {
    var out = [], src = D.bills.map(function (b) { return { id: b.id, name: b.name || 'Bill', amount: num(b.amount), freq: b.freq || 'monthly', day: +b.day || 1, month: +b.month || 1, date: b.date, autopay: !!b.autopay, kind: 'bill', since: b.added || D.since || '' }; })
      .concat(D.debts.filter(function (d) { return num(d.min) > 0 && num(d.balance) > 0; }).map(function (d) { return { id: 'd-' + d.id, name: (d.name || 'Debt') + ' (minimum)', amount: num(d.min), freq: 'monthly', day: +d.day || 1, autopay: !!d.autopay, kind: 'debt', since: d.added || D.since || '' }; }));
    var y0 = P(from).getFullYear(), m0 = P(from).getMonth();
    src.forEach(function (b) {
      if (b.freq === 'once') { if (b.date && b.date >= from && b.date <= to) out.push(occ(b, b.date)); return; }
      var y = y0, m = m0;
      for (var j = 0; j < 30; j++) {
        if (b.freq === 'monthly' || (b.freq === 'yearly' && m === b.month - 1)) {
          var s = S(new Date(y, m, Math.min(b.day, dim(y, m)))); if (s >= from && s <= to) out.push(occ(b, s));
        }
        m++; if (m > 11) { m = 0; y++; } if (S(new Date(y, m, 1)) > to) break;
      }
    });
    var sinceOf = {}; src.forEach(function (b) { sinceOf[b.id] = b.since; });
    out.forEach(function (o) { o.before = !!(sinceOf[o.id] && o.date < sinceOf[o.id]); });
    return out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  }
  /* past due dates from before you added a bill aren't shown as unpaid/late */
  function needsTick(o) { return !o.paid && !o.autopay && !(o.before && o.date < today()); }
  function occ(b, date) { var key = b.id + ':' + date; return { key: key, id: b.id, name: b.name, amount: b.amount, date: date, autopay: b.autopay, kind: b.kind, paid: !!D.paid[key] }; }

  /* ---------------- debt plan: plain sorting + month-by-month math ---------------- */
  function liveDebts() { return D.debts.filter(function (d) { return num(d.balance) > 0; }); }
  function order(style) {
    return liveDebts().slice().sort(function (a, b) {
      return style === 'avalanche' ? (num(b.apr) - num(a.apr)) || (num(a.balance) - num(b.balance)) : (num(a.balance) - num(b.balance)) || (num(b.apr) - num(a.apr));
    });
  }
  function simulate(style) {
    var ds = order(style).map(function (d) { return { id: d.id, name: d.name, bal: num(d.balance), r: num(d.apr) / 1200, min: num(d.min), promo: d.promoEnd || '', fee: num(d.fee), feeMonth: d.feeMonth ? +d.feeMonth : 0 }; });
    if (!ds.length) return { months: 0, interest: 0, done: {}, stuck: false };
    var budget = ds.reduce(function (a, d) { return a + d.min; }, 0) + num(D.extra);
    var t = P(today()), y = t.getFullYear(), m = t.getMonth(), interest = 0, done = {}, n = 0;
    while (n < 600 && ds.some(function (d) { return d.bal > 0.005; })) {
      n++; m++; if (m > 11) { m = 0; y++; }
      var ym = y + '-' + ('0' + (m + 1)).slice(-2);
      ds.forEach(function (d) {
        if (d.bal <= 0.005) return;
        var rate = (d.promo && ym <= d.promo.slice(0, 7)) ? 0 : d.r, i = d.bal * rate; d.bal += i; interest += i;
        if (d.fee && d.feeMonth === m + 1) d.bal += d.fee;
      });
      var left = budget;
      ds.forEach(function (d) { if (d.bal <= 0.005) return; var p = Math.min(d.min, d.bal); d.bal -= p; left -= p; });
      for (var i = 0; i < ds.length && left > 0.005; i++) { var d = ds[i]; if (d.bal <= 0.005) continue; var p2 = Math.min(left, d.bal); d.bal -= p2; left -= p2; }
      ds.forEach(function (d) { if (d.bal <= 0.005 && !done[d.id]) done[d.id] = ym; });
    }
    return { months: n, interest: interest, done: done, stuck: n >= 600, end: n ? (y + '-' + ('0' + (m + 1)).slice(-2)) : '' };
  }
  function ymNice(ym) { if (!ym) return ''; var a = ym.split('-'); return new Date(+a[0], +a[1] - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }); }
  function spanWords(n) { var y = Math.floor(n / 12), m = n % 12; return (y ? y + ' yr' + (y > 1 ? 's' : '') : '') + (y && m ? ' ' : '') + (m ? m + ' mo' : '') || 'this month'; }

  /* ---------------- taxes on side income ---------------- */
  function taxYear(yr) {
    var rows = D.side.filter(function (x) { return (x.date || '').slice(0, 4) === String(yr); });
    var earned = rows.reduce(function (a, x) { return a + num(x.amount); }, 0), rate = num(D.taxRate) / 100;
    var should = rows.reduce(function (a, x) { return a + num(x.amount) * rate; }, 0);
    var moved = rows.reduce(function (a, x) { return a + (x.moved ? num(x.amount) * rate : 0); }, 0);
    return { rows: rows, earned: earned, should: should, moved: moved };
  }

  /* ---------------- this month ---------------- */
  function monthSummary() {
    var t = P(today()), y = t.getFullYear(), m = t.getMonth(), from = S(new Date(y, m, 1)), to = S(new Date(y, m, dim(y, m)));
    var pays = allPaydays(from, to), payIn = pays.reduce(function (a, p) { return a + p.amount; }, 0);
    var side = D.side.filter(function (x) { return x.date >= from && x.date <= to; }), sideIn = side.reduce(function (a, x) { return a + num(x.amount); }, 0);
    var tax = sideIn * num(D.taxRate) / 100;
    var ds = dues(from, to), bills = ds.filter(function (o) { return o.kind === 'bill'; }).reduce(function (a, o) { return a + o.amount; }, 0);
    var mins = ds.filter(function (o) { return o.kind === 'debt'; }).reduce(function (a, o) { return a + o.amount; }, 0);
    return { y: y, m: m, payIn: payIn, sideIn: sideIn, tax: tax, bills: bills, mins: mins, left: payIn + sideIn - tax - bills - mins, pays: pays };
  }

  /* ---------------- drawing ---------------- */
  var esc = function (s) { return API ? API.esc(s) : String(s); };
  var RO = function () { return API && !API.editable ? ' disabled' : ''; };
  var TIPS = {
    apr: 'Interest % (also called APR) is what the card or loan charges you per year for the money you still owe. Higher % = it grows faster.',
    min: 'The smallest payment the lender accepts each month. Paying only this keeps you in good standing, but the debt shrinks slowly.',
    snowball: 'Quick wins: pay off the smallest balance first. Each payoff frees up money for the next one, which keeps you motivated.',
    avalanche: 'Save most: pay off the highest interest % first. It costs less overall, but the first win can take longer.',
    extra: 'Anything above your minimums that you can put toward debt each month. The app sends all of it to your focus debt.',
    promo: 'If a card has 0% interest until a certain date, put it here. The plan treats it as 0% until then.',
    fee: 'Some cards charge a yearly fee. Add it and pick the month it’s charged, and the plan will include it.',
    taxrate: 'A common rule of thumb for side/contract income is to set aside about 25–30%. Self-employment tax alone is about 15%, plus income tax. A tax professional can tell you the right % for you.',
    cushion: 'A small savings buffer for surprises (car repair, a slow month) so you don’t have to use a card. Many people start with $500, then build up.',
    left: 'What you get this month minus bills, debt minimums and taxes set aside. This is money you can choose a job for.'
  };
  function i(k) { return '<button type="button" class="mny-i" data-tip="' + k + '" aria-label="What does this mean?">ⓘ</button>'; }
  function tipBox() { return tip ? '<div class="mny-tip">' + esc(TIPS[tip] || '') + ' <button type="button" class="mny-x" data-tip="">Got it</button></div>' : ''; }

  function draw() {
    if (!root) return;
    if (!loaded) { root.innerHTML = '<div class="mny"><div class="mny-card">Loading your money…</div></div>'; return; }
    var h = '<div class="mny">';
    if (!D.setupDone) h += setupView();
    else {
      h += '<div class="mny-tabs" role="tablist">' + [['month', 'This month'], ['income', 'Income'], ['bills', 'Bills & paydays'], ['debts', 'Debts'], ['taxes', 'Taxes'], ['more', 'Settings']].map(function (t) {
        return '<button type="button" class="' + (tab === t[0] ? 'on' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>';
      h += tipBox();
      h += ({ month: monthView, income: incomeView, bills: billsView, debts: debtsView, taxes: taxesView, more: moreView }[tab] || monthView)();
    }
    h += '<div class="mny-note">Shows the math, not financial advice. Your money info stays in its own private section.</div></div>';
    var y = window.scrollY, c = document.getElementById('content'), cy = c ? c.scrollTop : 0;
    var act = document.activeElement, actKey = act && root.contains(act) ? act.getAttribute('data-k') + '|' + act.getAttribute('data-id') : null;
    root.innerHTML = h;
    if (c) c.scrollTop = cy; window.scrollTo(0, y);
    if (actKey) { var back = root.querySelector('[data-k="' + actKey.split('|')[0] + '"][data-id="' + actKey.split('|')[1] + '"]'); if (back) try { back.focus(); } catch (_) {} }
  }

  /* --- row editors (spreadsheet-style, saves as you type) --- */
  function incomeRows() {
    return '<div class="mny-rows">' + (D.incomes.length ? D.incomes.map(function (x) {
      return '<div class="mny-row inc"><input data-k="inc.who" data-id="' + x.id + '" placeholder="Whose? e.g. My paycheck" value="' + esc(x.who || '') + '"' + RO() + '>' +
        '<span class="mny-cur"><input data-k="inc.amount" data-id="' + x.id + '" inputmode="decimal" placeholder="Take-home $" value="' + esc(x.amount || '') + '"' + RO() + '></span>' +
        '<select data-k="inc.freq" data-id="' + x.id + '"' + RO() + '>' + [['biweekly', 'Every 2 weeks'], ['weekly', 'Every week'], ['semimonthly', 'Twice a month'], ['monthly', 'Once a month']].map(function (o) { return '<option value="' + o[0] + '"' + ((x.freq || 'biweekly') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
        ((x.freq === 'semimonthly' || x.freq === 'monthly') ?
          '<label class="mny-sm">On day <input data-k="inc.day1" data-id="' + x.id + '" inputmode="numeric" value="' + esc(x.day1 || 1) + '"' + RO() + '>' + (x.freq === 'semimonthly' ? ' &amp; <input data-k="inc.day2" data-id="' + x.id + '" inputmode="numeric" value="' + esc(x.day2 || 15) + '"' + RO() + '>' : '') + '</label>' :
          '<label class="mny-sm">A payday: <input type="date" data-k="inc.anchor" data-id="' + x.id + '" value="' + esc(x.anchor || '') + '"' + RO() + '></label>') +
        (API.editable ? '<button type="button" class="mny-del" data-del="incomes" data-id="' + x.id + '" aria-label="Remove">✕</button>' : '') + '</div>';
    }).join('') : '<div class="mny-empty">No paychecks yet.</div>') +
      (API.editable ? '<button type="button" class="mny-add" data-addrow="incomes">+ Add a paycheck</button>' : '') + '</div>';
  }
  function billRows() {
    return '<div class="mny-rows">' + (D.bills.length ? D.bills.map(function (x) {
      var f = x.freq || 'monthly';
      return '<div class="mny-row bill"><input data-k="bill.name" data-id="' + x.id + '" placeholder="Bill, e.g. Rent, Phone, Netflix" value="' + esc(x.name || '') + '"' + RO() + '>' +
        '<span class="mny-cur"><input data-k="bill.amount" data-id="' + x.id + '" inputmode="decimal" placeholder="Amount" value="' + esc(x.amount || '') + '"' + RO() + '></span>' +
        '<select data-k="bill.freq" data-id="' + x.id + '"' + RO() + '>' + [['monthly', 'Every month'], ['yearly', 'Once a year'], ['once', 'Just once']].map(function (o) { return '<option value="' + o[0] + '"' + (f === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
        (f === 'once' ? '<label class="mny-sm">Due <input type="date" data-k="bill.date" data-id="' + x.id + '" value="' + esc(x.date || '') + '"' + RO() + '></label>' :
          '<label class="mny-sm">Due day <input data-k="bill.day" data-id="' + x.id + '" inputmode="numeric" placeholder="1–31" value="' + esc(x.day || '') + '"' + RO() + '>' +
          (f === 'yearly' ? ' of <select data-k="bill.month" data-id="' + x.id + '"' + RO() + '>' + [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(function (mm) { return '<option value="' + mm + '"' + ((+x.month || 1) === mm ? ' selected' : '') + '>' + new Date(2000, mm - 1, 1).toLocaleDateString(undefined, { month: 'short' }) + '</option>'; }).join('') + '</select>' : '') + '</label>') +
        '<label class="mny-chk"><input type="checkbox" data-k="bill.autopay" data-id="' + x.id + '"' + (x.autopay ? ' checked' : '') + RO() + '> Autopay</label>' +
        (API.editable ? '<button type="button" class="mny-del" data-del="bills" data-id="' + x.id + '" aria-label="Remove">✕</button>' : '') + '</div>';
    }).join('') : '<div class="mny-empty">No bills yet.</div>') +
      (API.editable ? '<button type="button" class="mny-add" data-addrow="bills">+ Add a bill</button>' : '') + '</div>';
  }
  function debtRows(detail) {
    return '<div class="mny-rows">' + (D.debts.length ? D.debts.map(function (x) {
      return '<div class="mny-debt"><div class="mny-row debt"><input data-k="debt.name" data-id="' + x.id + '" placeholder="e.g. Visa, Car loan, IRS 2025" value="' + esc(x.name || '') + '"' + RO() + '>' +
        '<label class="mny-sm">Owe <span class="mny-cur"><input data-k="debt.balance" data-id="' + x.id + '" inputmode="decimal" value="' + esc(x.balance || '') + '"' + RO() + '></span></label>' +
        '<label class="mny-sm">Interest % ' + i('apr') + '<input data-k="debt.apr" data-id="' + x.id + '" inputmode="decimal" placeholder="e.g. 24.9" value="' + esc(x.apr || '') + '"' + RO() + '></label>' +
        '<label class="mny-sm">Minimum ' + i('min') + '<span class="mny-cur"><input data-k="debt.min" data-id="' + x.id + '" inputmode="decimal" value="' + esc(x.min || '') + '"' + RO() + '></span></label>' +
        '<label class="mny-sm">Due day <input data-k="debt.day" data-id="' + x.id + '" inputmode="numeric" placeholder="1–31" value="' + esc(x.day || '') + '"' + RO() + '></label>' +
        (API.editable ? '<button type="button" class="mny-del" data-del="debts" data-id="' + x.id + '" aria-label="Remove">✕</button>' : '') + '</div>' +
        (detail ? '<details class="mny-more"' + (x.promoEnd || x.fee || x.notes ? ' open' : '') + '><summary>Extras: 0% promo, yearly fee, notes</summary><div class="mny-row">' +
          '<label class="mny-sm">0% until ' + i('promo') + '<input type="date" data-k="debt.promoEnd" data-id="' + x.id + '" value="' + esc(x.promoEnd || '') + '"' + RO() + '></label>' +
          '<label class="mny-sm">Yearly fee ' + i('fee') + '<span class="mny-cur"><input data-k="debt.fee" data-id="' + x.id + '" inputmode="decimal" value="' + esc(x.fee || '') + '"' + RO() + '></span> in <select data-k="debt.feeMonth" data-id="' + x.id + '"' + RO() + '><option value="">—</option>' + [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(function (mm) { return '<option value="' + mm + '"' + ((+x.feeMonth) === mm ? ' selected' : '') + '>' + new Date(2000, mm - 1, 1).toLocaleDateString(undefined, { month: 'short' }) + '</option>'; }).join('') + '</select></label>' +
          '<label class="mny-chk"><input type="checkbox" data-k="debt.autopay" data-id="' + x.id + '"' + (x.autopay ? ' checked' : '') + RO() + '> Autopay</label>' +
          '<input class="mny-notes" data-k="debt.notes" data-id="' + x.id + '" placeholder="Notes" value="' + esc(x.notes || '') + '"' + RO() + '></div></details>' : '') + '</div>';
    }).join('') : '<div class="mny-empty">No debts. 🎉</div>') +
      (API.editable ? '<button type="button" class="mny-add" data-addrow="debts">+ Add a debt</button>' : '') + '</div>';
  }

  /* --- Start here --- */
  function setupView() {
    var steps = [
      ['When do you get paid?', 'Add each paycheck that comes in on a schedule: yours, your partner’s, any regular job. Use take-home pay (after tax). Side or contract pay that comes at random times goes on the Income page later.', incomeRows],
      ['What bills do you have?', 'Rent, phone, insurance, utilities, subscriptions: anything you pay regularly. You don’t need to be perfect; you can add more anytime. Card and loan payments go in the next step.', billRows],
      ['What do you owe?', 'Credit cards, loans, car, student loans, money owed to the IRS. If you don’t know the interest %, check the statement or app, or leave it blank for now.', function () { return debtRows(false); }]
    ];
    var s = steps[step - 1];
    return '<div class="mny-hero"><b>💰 Let’s set up your money</b><p>Three quick steps. You can skip any of them and fill it in later.</p></div>' +
      tipBox() +
      '<div class="mny-card"><div class="mny-step">Step ' + step + ' of 3</div><h3>' + s[0] + '</h3><p class="mny-p">' + s[1] + '</p>' + s[2]() +
      '<div class="mny-nav">' + (step > 1 ? '<button type="button" class="btn ghost" data-step="' + (step - 1) + '">← Back</button>' : '<span></span>') +
      '<span class="grow"></span><button type="button" class="btn ghost" data-step="' + (step < 3 ? step + 1 : 'done') + '">Skip</button>' +
      '<button type="button" class="btn primary" data-step="' + (step < 3 ? step + 1 : 'done') + '">' + (step < 3 ? 'Next →' : 'Finish 🎉') + '</button></div></div>';
  }

  /* --- This month --- */
  function monthView() {
    var s = monthSummary(), total = Math.max(1, s.payIn + s.sideIn);
    var seg = function (v, cls) { return v > 0 ? '<span class="' + cls + '" style="width:' + Math.min(100, v / total * 100).toFixed(1) + '%"></span>' : ''; };
    var ord = order(D.style), focus = ord[0], c = D.cushion, need = Math.max(0, num(c.goal) - num(c.saved));
    var ideas = [];
    if (s.left > 0 && need > 0) ideas.push('Put <b>' + money(Math.min(need, Math.max(25, Math.round(s.left * 0.25 / 5) * 5))) + '</b> toward your cushion (now ' + money(num(c.saved)) + ' of ' + money(num(c.goal)) + ')');
    if (s.left > 0 && focus) ideas.push('Pay extra on <b>' + esc(focus.name || 'your focus debt') + '</b> (your focus debt)');
    var t = today(), nexts = dues(add(t, -5), add(t, 31)).filter(needsTick).slice(0, 4);
    return '<div class="mny-card"><h3>' + esc(monthName(s.y, s.m)) + '</h3>' +
      (s.payIn + s.sideIn === 0 ? '<p class="mny-p">Add your paychecks in <a href="#" data-tab="bills">Bills &amp; paydays</a> to see your month.</p>' : '') +
      '<div class="mny-sum">' +
        '<div><span>You’ll get</span><b>' + money(s.payIn + s.sideIn) + '</b></div>' +
        (s.sideIn ? '<div class="sub"><span>· incl. side income</span><b>' + money(s.sideIn) + '</b></div>' : '') +
        '<div><span>Bills</span><b>−' + money(s.bills) + '</b></div>' +
        '<div><span>Debt minimums</span><b>−' + money(s.mins) + '</b></div>' +
        (s.tax ? '<div><span>Set aside for taxes</span><b>−' + money(s.tax) + '</b></div>' : '') +
        '<div class="tot"><span>Left over ' + i('left') + '</span><b class="' + (s.left < 0 ? 'neg' : 'pos') + '">' + money(s.left) + (s.left > 0 ? ' 🎉' : '') + '</b></div>' +
      '</div>' +
      '<div class="mny-bar">' + seg(s.bills, 'b1') + seg(s.mins, 'b2') + seg(s.tax, 'b3') + seg(Math.max(0, s.left), 'b4') + '</div>' +
      '<div class="mny-legend"><i class="b1"></i>Bills <i class="b2"></i>Debt <i class="b3"></i>Taxes <i class="b4"></i>Left over</div>' +
      (s.left < 0 ? '<p class="mny-warn">This month’s bills are more than what’s coming in. Check the Bills page: maybe something can move, or be paid from the next paycheck.</p>' : '') +
      (ideas.length ? '<div class="mny-ideas"><b>💡 Ideas for what’s left</b><ul>' + ideas.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul></div>' : '') +
      '</div>' +
      '<div class="mny-two">' +
        '<div class="mny-card"><h3>Coming up</h3>' + (nexts.length ? nexts.map(dueRow).join('') : '<p class="mny-p">Nothing to pay by hand in the next month.</p>') + '</div>' +
        '<div class="mny-card"><h3>🛟 Cushion ' + i('cushion') + '</h3>' + ring(num(c.saved), num(c.goal)) +
          '<p class="mny-p" style="text-align:center">' + money(num(c.saved)) + ' of ' + money(num(c.goal)) + (need ? '' : ' · reached! 🎉') + '</p>' +
          (API.editable ? '<div class="mny-row center"><span class="mny-cur"><input id="mny-cadd" inputmode="decimal" placeholder="Amount"></span><button type="button" class="btn" data-cushion="add">Add</button><button type="button" class="btn ghost" data-cushion="take">Took out</button></div>' : '') + '</div>' +
      '</div>';
  }
  function ring(v, goal) {
    var p = goal > 0 ? Math.min(1, v / goal) : 0, r = 34, C = 2 * Math.PI * r;
    return '<svg class="mny-ring" viewBox="0 0 90 90" width="90" height="90"><circle cx="45" cy="45" r="' + r + '" fill="none" stroke="var(--line)" stroke-width="9"/>' +
      '<circle cx="45" cy="45" r="' + r + '" fill="none" stroke="var(--accent)" stroke-width="9" stroke-linecap="round" stroke-dasharray="' + (C * p).toFixed(1) + ' ' + C.toFixed(1) + '" transform="rotate(-90 45 45)"/>' +
      '<text x="45" y="50" text-anchor="middle" font-size="16" font-weight="700" fill="currentColor">' + Math.round(p * 100) + '%</text></svg>';
  }
  function dueRow(o) {
    var t = today(), late = o.date < t && !o.paid;
    return '<div class="mny-due' + (o.paid ? ' paid' : '') + (late ? ' late' : '') + '">' +
      (API.editable ? '<button type="button" class="mny-ck" data-paid="' + esc(o.key) + '" aria-label="' + (o.paid ? 'Mark not paid' : 'Mark paid') + '">' + (o.paid ? '✓' : '') + '</button>' : '<span class="mny-ck">' + (o.paid ? '✓' : '') + '</span>') +
      '<span class="nm">' + (o.kind === 'debt' ? '💳 ' : '') + esc(o.name) + '</span><span class="dt">' + (o.date === t ? 'Today' : short(o.date)) + (late ? ' · late?' : '') + (o.autopay ? ' · autopay' : '') + '</span><b>' + m$(o.amount) + '</b></div>';
  }

  /* --- Bills & paydays (grouped by paycheck) --- */
  function billsView() {
    var t = today(), back = allPaydays(add(t, -35), t), start = back.length ? back[back.length - 1].date : t;
    var fut = allPaydays(add(start, 1), add(t, 75)), pays = [{ date: start, items: back.length ? back[back.length - 1].items : [], amount: back.length ? back[back.length - 1].amount : 0, none: !back.length }].concat(fut).slice(0, 5);
    if (pays.length < 2) pays.push({ date: add(t, 31), items: [], amount: 0 });
    var h = '<div class="mny-card"><h3>By paycheck</h3><p class="mny-p">Each paycheck, and the bills it needs to cover before the next one arrives. Tick them off as you pay.</p>';
    if (!D.incomes.length) h += '<p class="mny-warn">Add your paychecks below to group bills by payday.</p>';
    var behind = dues(add(start, -45), add(start, -1)).filter(needsTick);
    if (behind.length) h += '<div class="mny-pay late-box"><div class="mny-pay-h"><b>⏰ Not ticked off yet</b><span>from before this paycheck</span></div>' + behind.map(dueRow).join('') + '</div>';
    for (var k = 0; k < pays.length - 1; k++) {
      var p = pays[k], until = add(pays[k + 1].date, -1), list = dues(p.date, until), sum = list.reduce(function (a, o) { return a + o.amount; }, 0);
      var sides = D.side.filter(function (x) { return x.date >= p.date && x.date <= until && num(x.amount); }), sideNet = sides.reduce(function (a, x) { return a + num(x.amount) * (1 - num(D.taxRate) / 100); }, 0);
      h += '<div class="mny-pay"><div class="mny-pay-h"><b>' + (p.none ? 'Now' : '💵 ' + nice(p.date)) + '</b>' +
        (p.none ? '' : '<span>' + p.items.map(function (x) { return esc(x.inc.who || 'Paycheck'); }).join(' + ') + ' · ' + money(p.amount) + '</span>') +
        '<span class="grow"></span><span class="mny-sm">covers until ' + short(until) + '</span></div>' +
        sides.map(function (x) { return '<div class="mny-due incoming"><span class="mny-ck in">+</span><span class="nm">' + esc(srcName(x)) + '</span><span class="dt">' + short(x.date) + ' · after tax slice</span><b class="pos">+' + m$(Math.round(num(x.amount) * (1 - num(D.taxRate) / 100) * 100) / 100) + '</b></div>'; }).join('') +
        (list.length ? list.map(dueRow).join('') : '<div class="mny-empty">Nothing due in this stretch.</div>') +
        (p.none && !sides.length ? '' : '<div class="mny-left">Left from this stretch: <b class="' + (p.amount + sideNet - sum < 0 ? 'neg' : 'pos') + '">' + money(p.amount + sideNet - sum) + '</b></div>') + '</div>';
    }
    h += '</div>';
    h += '<div class="mny-card"><h3>Your paychecks</h3>' + incomeRows() + '</div>';
    h += '<div class="mny-card"><h3>Your bills</h3><p class="mny-p">Card and loan minimums come from the Debts page automatically.</p>' + billRows() + '</div>';
    return h;
  }

  /* --- Debts --- */
  function debtsView() {
    var live = liveDebts(), owe = live.reduce(function (a, d) { return a + num(d.balance); }, 0);
    var h = '';
    if (live.length) {
      var A = simulate('snowball'), B = simulate('avalanche'), mine = D.style === 'avalanche' ? B : A, other = D.style === 'avalanche' ? A : B;
      var ord = order(D.style), focus = ord[0], diff = Math.round(Math.abs(A.interest - B.interest));
      var tooLow = live.filter(function (d) { return num(d.min) > 0 && num(d.min) <= num(d.balance) * num(d.apr) / 1200 && !d.promoEnd; });
      h += '<div class="mny-card"><div class="mny-big"><span>You owe</span><b>' + money(owe) + '</b>' +
        (mine.stuck ? '<em>Payments don’t cover the interest yet: see below</em>' : '<em>Debt-free by <b>' + ymNice(mine.end) + '</b> · ' + spanWords(mine.months) + ' to go</em>') + '</div>' +
        '<div class="mny-focus"><div>🎯 <b>Focus on: ' + esc(focus.name || 'this debt') + '</b> (' + money(num(focus.balance)) + ')</div><p>Pay the minimum on everything else. Anything extra goes here.</p></div>' +
        '<div class="mny-row"><span class="mny-lbl">Style</span><div class="mny-seg">' +
          '<button type="button" class="' + (D.style !== 'avalanche' ? 'on' : '') + '" data-style="snowball">Quick wins</button><button type="button" class="' + (D.style === 'avalanche' ? 'on' : '') + '" data-style="avalanche">Save most</button></div>' + i(D.style === 'avalanche' ? 'avalanche' : 'snowball') +
          '<span class="mny-sm">' + (diff >= 1 ? (B.interest < A.interest ? (D.style === 'avalanche' ? 'Saves ' + money(diff) + ' vs quick wins' : 'Save most would save ' + money(diff) + ' more') : 'Both styles cost about the same here') : 'Both styles cost about the same here') + '</span></div>' +
        '<div class="mny-row"><span class="mny-lbl">Extra each month ' + i('extra') + '</span><span class="mny-cur"><input data-k="extra" data-id="x" inputmode="decimal" placeholder="0" value="' + esc(D.extra || '') + '"' + RO() + '></span></div>' +
        '<div class="mny-order">' + ord.map(function (d, ix) { return '<div><span class="n">' + (ix + 1) + '</span>' + esc(d.name || 'Debt') + '<span class="grow"></span><span class="mny-sm">paid off ' + (mine.done[d.id] ? ymNice(mine.done[d.id]) : '—') + '</span></div>'; }).join('') + '</div>' +
        timeline(ord, mine) +
        (tooLow.length ? '<p class="mny-warn">Heads up: the minimum on ' + tooLow.map(function (d) { return '<b>' + esc(d.name || 'a debt') + '</b>'; }).join(', ') + ' barely covers (or doesn’t cover) its interest, so the balance won’t shrink much without extra.</p>' : '') +
        '</div>';
    }
    h += '<div class="mny-card"><h3>Your debts</h3><p class="mny-p">Fill in what you know. Interest % is on your statement or card app (often called APR). Last year’s taxes owed? Add it here as “IRS”.</p>' + debtRows(true) + '</div>';
    return h;
  }
  function timeline(ord, sim) {
    if (!sim.months || sim.stuck) return '';
    var n = sim.months, t = P(today()), base = t.getFullYear() * 12 + t.getMonth(), prev = 0;
    var rows = ord.map(function (d) {
      var ym = sim.done[d.id]; if (!ym) return ''; var a = ym.split('-'), idx = (+a[0]) * 12 + (+a[1] - 1) - base;
      var left = prev / n * 100, w = Math.max(1.5, (idx - prev) / n * 100), full = idx / n * 100; prev = Math.max(prev, idx);
      return '<div class="mny-tl"><span class="nm">' + esc(d.name || 'Debt') + '</span><span class="tr"><i class="pay" style="width:' + full.toFixed(1) + '%"></i><i class="focus" style="left:' + left.toFixed(1) + '%;width:' + w.toFixed(1) + '%"></i></span></div>';
    }).join('');
    return '<div class="mny-tlw"><div class="mny-sm" style="margin:8px 0 4px">Timeline: darker = when it’s your focus</div>' + rows +
      '<div class="mny-tl axis"><span class="nm"></span><span class="tr"><em>now</em><em>' + ymNice(sim.end) + '</em></span></div></div>';
  }

  function srcName(x) { var s0 = D.sources.filter(function (q) { return q.id === x.src; })[0]; return s0 ? (s0.name || 'Unnamed') : (x.from || 'Side income'); }
  function payoutRows(list, opts) {
    var rate = num(D.taxRate);
    return '<div class="mny-rows">' + (list.length ? list.map(function (x) {
      var part = num(x.amount) * rate / 100;
      return '<div class="mny-row payout"><input type="date" data-k="side.date" data-id="' + x.id + '" value="' + esc(x.date || '') + '"' + RO() + '>' +
        (D.sources.length ? '<select data-k="side.src" data-id="' + x.id + '"' + RO() + '>' + D.sources.map(function (q) { return '<option value="' + q.id + '"' + (x.src === q.id ? ' selected' : '') + '>' + esc(q.name || 'Unnamed') + '</option>'; }).join('') + '<option value=""' + (!x.src ? ' selected' : '') + '>Other…</option></select>' : '') +
        ((!D.sources.length || !x.src) ? '<input data-k="side.from" data-id="' + x.id + '" placeholder="From, e.g. client name" value="' + esc(x.from || '') + '"' + RO() + '>' : '') +
        '<span class="mny-cur"><input data-k="side.amount" data-id="' + x.id + '" inputmode="decimal" placeholder="Amount" value="' + esc(x.amount || '') + '"' + RO() + '></span>' +
        '<span class="mny-sm">→ set aside <b>' + m$(Math.round(part * 100) / 100) + '</b></span>' +
        '<label class="mny-chk"><input type="checkbox" data-k="side.moved" data-id="' + x.id + '"' + (x.moved ? ' checked' : '') + RO() + '> Moved to savings</label>' +
        (API.editable ? '<button type="button" class="mny-del" data-del="side" data-id="' + x.id + '" aria-label="Remove">✕</button>' : '') + '</div>';
    }).join('') : '<div class="mny-empty">' + (opts && opts.empty || 'No payouts logged yet.') + '</div>') +
      (API.editable && !(opts && opts.noAdd) ? '<button type="button" class="mny-add" data-addrow="side">+ Log a payout</button>' : '') + '</div>';
  }

  /* --- Income: paychecks + side income together --- */
  function incomeView() {
    var t = P(today()), y = t.getFullYear(), m = t.getMonth(), from = S(new Date(y, m, 1)), to = S(new Date(y, m, dim(y, m))), yFrom = y + '-01-01';
    var payM = allPaydays(from, to).reduce(function (a, p) { return a + p.amount; }, 0);
    var sideM = D.side.filter(function (x) { return x.date >= from && x.date <= to; }).reduce(function (a, x) { return a + num(x.amount); }, 0);
    var sideY = D.side.filter(function (x) { return x.date >= yFrom && x.date <= today(); }), T = taxYear(y);
    var bySrc = {}; sideY.forEach(function (x) { var k = srcName(x); bySrc[k] = (bySrc[k] || 0) + num(x.amount); });
    var rows = D.side.slice().sort(function (a, b) { return (b.date || '') < (a.date || '') ? -1 : 1; }).slice(0, 40);
    return '<div class="mny-card"><h3>' + esc(monthName(y, m)) + '</h3><div class="mny-stats">' +
        '<div><span>Paychecks</span><b>' + money(payM) + '</b></div><div><span>Side income</span><b>' + money(sideM) + '</b></div>' +
        '<div><span>Total in</span><b>' + money(payM + sideM) + '</b></div>' +
        '<div class="' + (T.should - T.moved > 0.5 ? 'todo' : 'ok') + '"><span>Taxes still to move (' + y + ')</span><b>' + money(Math.max(0, T.should - T.moved)) + '</b></div></div></div>' +
      '<div class="mny-card"><h3>💵 Paychecks</h3><p class="mny-p">Regular pay that arrives on a schedule. Use take-home (after tax).</p>' + incomeRows() + '</div>' +
      '<div class="mny-card"><h3>🧾 Side &amp; contract income</h3><p class="mny-p">Pay that arrives at random times and has <b>no tax taken out</b>. Log each payout when it lands, and the app shows the slice (' + esc(num(D.taxRate)) + '%) to move to savings for taxes. ' + i('taxrate') + '</p>' +
        '<div class="mny-lbl" style="margin:4px 0 6px">Where it comes from</div><div class="mny-chips">' +
        D.sources.map(function (q) { return '<span class="mny-chip"><input data-k="src.name" data-id="' + q.id + '" placeholder="Client name" value="' + esc(q.name || '') + '"' + RO() + '>' + (bySrc[q.name || 'Unnamed'] ? '<em>' + money(bySrc[q.name || 'Unnamed']) + ' this year</em>' : '') + (API.editable ? '<button type="button" class="mny-del" data-del="sources" data-id="' + q.id + '" aria-label="Remove">✕</button>' : '') + '</span>'; }).join('') +
        (API.editable ? '<button type="button" class="mny-add" data-addrow="sources">+ Add a source</button>' : '') + '</div>' +
        '<div class="mny-lbl" style="margin:14px 0 6px">Payouts</div>' + payoutRows(rows) + '</div>';
  }

  /* --- Taxes (side / contract income) --- */
  function taxesView() {
    var yr = P(today()).getFullYear(), T = taxYear(yr), rate = num(D.taxRate);
    var rows = D.side.filter(function (x) { return !x.moved; }).sort(function (a, b) { return (b.date || '') < (a.date || '') ? -1 : 1; });
    return '<div class="mny-card"><h3>Taxes on side income · ' + yr + '</h3>' +
      '<p class="mny-p">Taxes aren’t taken out of contract pay, so it helps to move a slice into savings (like your HYSA) each time you’re paid, then pay the IRS from there.</p>' +
      '<div class="mny-row"><span class="mny-lbl">Set aside</span><input class="mny-pct" data-k="taxRate" data-id="x" inputmode="decimal" value="' + esc(rate) + '"' + RO() + '><span>% of each payout</span>' + i('taxrate') + '</div>' +
      '<div class="mny-stats"><div><span>Earned</span><b>' + money(T.earned) + '</b></div><div><span>Should be set aside</span><b>' + money(T.should) + '</b></div><div><span>Moved to savings</span><b>' + money(T.moved) + '</b></div><div class="' + (T.should - T.moved > 0.5 ? 'todo' : 'ok') + '"><span>Still to move</span><b>' + money(Math.max(0, T.should - T.moved)) + '</b></div></div>' +
      '</div>' +
      '<div class="mny-card"><h3>Still to move to savings</h3><p class="mny-p">Payouts whose tax slice hasn’t gone into savings yet. Tick each one once you’ve moved it. Log new payouts on the <a href="#" data-tab="income">Income</a> page.</p>' + payoutRows(rows, { noAdd: true, empty: 'All caught up. 🎉' }) + '</div>' +
      '<div class="mny-card mny-info"><h3>Good to know</h3><ul>' +
        '<li>The IRS expects tax on side income to be paid <b>during</b> the year, usually in four quarterly payments. Paying it all at the end can mean a penalty. A tax professional can tell you if that applies to you.</li>' +
        '<li>Owe from last year? Add it on the <a href="#" data-tab="debts">Debts</a> page (e.g. “IRS 2025”) with your payment plan amount.</li>' +
      '</ul></div>';
  }

  /* --- Settings --- */
  function moreView() {
    return '<div class="mny-card"><h3>Money settings</h3>' +
      '<label class="mny-chk big"><input type="checkbox" data-k="showOnToday" data-id="x"' + (D.showOnToday ? ' checked' : '') + RO() + '> Show money that’s due on my <b>Today</b> page</label>' +
      '<div class="mny-row"><span class="mny-lbl">Cushion goal ' + i('cushion') + '</span><span class="mny-cur"><input data-k="cgoal" data-id="x" inputmode="decimal" value="' + esc(D.cushion.goal || '') + '"' + RO() + '></span></div>' +
      (API.editable ? '<div class="mny-row"><button type="button" class="btn ghost" data-step="1">Go through setup again</button></div>' : '') + '</div>';
  }

  /* ---------------- Today card ---------------- */
  function todayCard(el) {
    if (!loaded || !D || !D.showOnToday) return false;
    var t = today(), list = dues(add(t, -7), add(t, 3)).filter(needsTick);
    var pays = allPaydays(t, t);
    if (!list.length && !pays.length) return false;
    el.innerHTML = '<h3>💰 Money<button class="link-btn sm" data-mny-open>Open</button></h3>' +
      (pays.length ? '<div class="mny-payday">💵 Payday today: ' + pays[0].items.map(function (x) { return esc(x.inc.who || 'Paycheck'); }).join(' + ') + ' · ' + money(pays[0].amount) + '</div>' : '') +
      list.map(dueRow).join('');
    if (!el._mny) {
      el._mny = true;
      el.addEventListener('click', function (e) {
        var p = e.target.closest('[data-paid]'); if (p) { e.stopPropagation(); togglePaid(p.getAttribute('data-paid')); refreshToday(); return; }
        if (e.target.closest('[data-mny-open]')) { e.stopPropagation(); tab = 'bills'; API.openView(); }
      });
    }
    return true;
  }
  function togglePaid(key) { if (!API.editable) return; if (D.paid[key]) delete D.paid[key]; else D.paid[key] = today(); save(); draw(); }

  /* ---------------- input handling ---------------- */
  function findIn(list, id) { return D[list].filter(function (x) { return x.id === id; })[0]; }
  var LIST = { inc: 'incomes', bill: 'bills', debt: 'debts', side: 'side', src: 'sources' };
  function onInput(e) {
    var el = e.target, k = el.getAttribute && el.getAttribute('data-k'); if (!k || !API.editable) return;
    var id = el.getAttribute('data-id'), v = el.type === 'checkbox' ? el.checked : el.value;
    if (k === 'extra') D.extra = num(v);
    else if (k === 'taxRate') D.taxRate = Math.max(0, Math.min(60, num(v)));
    else if (k === 'showOnToday') D.showOnToday = !!v;
    else if (k === 'cgoal') D.cushion.goal = num(v);
    else { var parts = k.split('.'), item = findIn(LIST[parts[0]], id); if (!item) return; item[parts[1]] = v; }
    save();
    /* redraw on change (not every keystroke) so numbers and plans update */
    if (e.type === 'change' || el.tagName === 'SELECT' || el.type === 'checkbox') setTimeout(draw, 0);   /* after focus moves, so Tab still works */
  }
  function onClick(e) {
    var t;
    if ((t = e.target.closest('[data-tip]'))) { var k = t.getAttribute('data-tip'); tip = (k && tip !== k) ? k : null; draw(); return; }
    if ((t = e.target.closest('[data-tab]'))) { e.preventDefault(); tab = t.getAttribute('data-tab'); tip = null; draw(); return; }
    if (!API.editable) return;
    if ((t = e.target.closest('[data-step]'))) {
      var s = t.getAttribute('data-step');
      if (s === 'done') { D.setupDone = true; if (!D.since) D.since = today(); tab = 'month'; save(); API.toast('All set! Here’s your month.'); }
      else { step = +s; if (step === 1 && D.setupDone) D.setupDone = false; }
      draw(); return;
    }
    if ((t = e.target.closest('[data-addrow]'))) {
      var L = t.getAttribute('data-addrow'), row = { id: uid() };
      if (L === 'incomes') { row.freq = 'biweekly'; row.who = D.incomes.length ? '' : 'My paycheck'; }
      if (L === 'bills') row.freq = 'monthly';
      if (L === 'side') { row.date = today(); if (D.sources.length) row.src = D.sources[0].id; }
      if (L === 'sources') row.name = '';
      if (L === 'bills' || L === 'debts') row.added = today();
      D[L].push(row); save(); draw();
      var f = root.querySelector('[data-id="' + row.id + '"]:not([type=date])'); if (f) f.focus(); return;
    }
    if ((t = e.target.closest('[data-del]'))) {
      var L2 = t.getAttribute('data-del'), id = t.getAttribute('data-id'), it = findIn(L2, id), ix = D[L2].indexOf(it);
      if (ix < 0) return; D[L2].splice(ix, 1); save(); draw();
      API.toast('Removed. Changed your mind? Add it again.');
      return;
    }
    if ((t = e.target.closest('[data-paid]'))) { togglePaid(t.getAttribute('data-paid')); return; }
    if ((t = e.target.closest('[data-style]'))) { D.style = t.getAttribute('data-style'); save(); draw(); return; }
    if ((t = e.target.closest('[data-cushion]'))) {
      var inp = root.querySelector('#mny-cadd'), amt = num(inp && inp.value); if (!amt) { inp && inp.focus(); return; }
      D.cushion.saved = Math.max(0, num(D.cushion.saved) + (t.getAttribute('data-cushion') === 'add' ? amt : -amt)); save(); draw(); return;
    }
  }

  /* ---------------- styles ---------------- */
  var CSS = '' +
    '.mny{display:flex;flex-direction:column;gap:14px;padding-bottom:30px}' +
    '.mny-hero{border-radius:18px;padding:20px 22px;background:var(--grad-soft);border:1px solid var(--line)}' +
    '.mny-hero b{display:block;font-family:var(--font-head);font-size:21px;margin-bottom:4px}.mny-hero p{margin:0;color:var(--muted)}' +
    '.mny-card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:var(--shadow)}' +
    '.mny-card h3{margin:0 0 8px;font-family:var(--font-head);font-size:16px;display:flex;align-items:center;gap:6px}' +
    '.mny-p{margin:0 0 10px;color:var(--muted);font-size:13.5px;line-height:1.5}' +
    '.mny-step{font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--accent);margin-bottom:6px}' +
    '.mny-tabs{display:flex;gap:4px;flex-wrap:wrap;background:var(--surface-2);border-radius:12px;padding:3px;align-self:flex-start;max-width:100%}' +
    '.mny-tabs button{padding:7px 13px;border-radius:9px;font-size:13px;font-weight:600;color:var(--muted)}' +
    '.mny-tabs button.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}' +
    '.mny-rows{display:flex;flex-direction:column;gap:8px}' +
    '.mny-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.mny-row.center{justify-content:center}' +
    '.mny input:not([type=checkbox]),.mny select{border:1px solid var(--line-2);background:var(--surface);color:var(--text);border-radius:9px;padding:8px 10px;font-size:14px;min-width:0;font-family:inherit}' +
    '.mny input:focus,.mny select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}' +
    '.mny-row.inc>input:first-child,.mny-row.bill>input:first-child,.mny-row.debt>input:first-child{flex:1 1 180px}' +
    '.mny-row.payout>input:nth-child(2){flex:1 1 160px}.mny-notes{flex:1 1 200px}' +
    '.mny-cur{position:relative;display:inline-flex}.mny-cur::before{content:"$";position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:14px;pointer-events:none}.mny-cur input{padding-left:20px!important;width:110px}' +
    '.mny-sm{font-size:12.5px;color:var(--muted);display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}.mny-sm input{width:64px}.mny-sm input[type=date]{width:auto}' +
    '.mny-pct{width:64px}.mny-lbl{font-size:13px;font-weight:600;min-width:120px;display:inline-flex;align-items:center;gap:4px}' +
    '.mny-chk{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}.mny-chk.big{font-size:14px;color:var(--text);margin-bottom:10px}' +
    '.mny-del{width:30px;height:30px;border-radius:8px;color:var(--faint)}.mny-del:hover{background:var(--surface-2);color:var(--red)}' +
    '.mny-add{align-self:flex-start;padding:7px 12px;border-radius:9px;border:1px dashed var(--line-2);color:var(--accent);font-weight:600;font-size:13px}' +
    '.mny-add:hover{background:var(--accent-soft)}' +
    '.mny-empty{color:var(--faint);font-size:13px;padding:4px 0}' +
    '.mny-nav{display:flex;gap:8px;align-items:center;margin-top:16px}.mny-nav .grow,.mny .grow{flex:1}' +
    '.mny-i{width:18px;height:18px;border-radius:50%;font-size:12px;line-height:1;color:var(--accent);display:inline-flex;align-items:center;justify-content:center}' +
    '.mny-tip{background:var(--accent-soft);border:1px solid var(--line);border-radius:12px;padding:10px 12px;font-size:13.5px;line-height:1.5}' +
    '.mny-x{margin-left:6px;font-weight:700;color:var(--accent);font-size:12.5px}' +
    '.mny-sum{display:flex;flex-direction:column;gap:6px;max-width:420px;margin:6px 0 12px}' +
    '.mny-sum>div{display:flex;justify-content:space-between;gap:12px;font-size:15px}.mny-sum>div.sub{font-size:12.5px;color:var(--muted);margin-top:-4px}' +
    '.mny-sum .tot{border-top:1px solid var(--line);padding-top:8px;font-size:17px}.mny-sum .tot span{display:inline-flex;align-items:center;gap:4px}' +
    '.pos{color:#16a34a}.neg{color:var(--red)}' +
    '.mny-bar{display:flex;height:12px;border-radius:999px;overflow:hidden;background:var(--surface-2)}' +
    '.mny-bar span{height:100%}.b1{background:var(--c3)}.b2{background:var(--c1)}.b3{background:var(--c2)}.b4{background:#4ade80}' +
    '.mny-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--muted);margin-top:6px;align-items:center}.mny-legend i{width:10px;height:10px;border-radius:3px;display:inline-block;margin-right:-6px}' +
    '.mny-warn{background:color-mix(in srgb,var(--red) 10%,transparent);border-radius:10px;padding:8px 10px;font-size:13px;margin:10px 0 0}' +
    '.mny-ideas{margin-top:12px;background:var(--surface-2);border-radius:12px;padding:10px 12px;font-size:13.5px}.mny-ideas ul{margin:6px 0 0;padding-left:18px}' +
    '.mny-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}' +
    '.mny-ring{display:block;margin:4px auto 0;color:var(--text)}' +
    '.mny-due{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);font-size:14px}.mny-due:last-child{border-bottom:0}' +
    '.mny-due .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mny-due .dt{font-size:12px;color:var(--muted);white-space:nowrap}' +
    '.mny-due.paid .nm,.mny-due.paid b{opacity:.5;text-decoration:line-through}.mny-due.late .dt{color:var(--red)}' +
    '.mny-ck{width:22px;height:22px;border-radius:7px;border:1.5px solid var(--line-2);display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#fff;flex:none}' +
    '.mny-due.paid .mny-ck{background:#22c55e;border-color:#22c55e}' +
    '.mny-pay{border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-top:10px}' +
    '.mny-pay-h{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:4px}.mny-pay-h span{font-size:13px;color:var(--muted)}' +
    '.mny-pay.late-box{border-color:color-mix(in srgb,var(--red) 35%,var(--line))}' +
    '.mny-left{text-align:right;font-size:13.5px;margin-top:6px}' +
    '.mny-big{display:flex;flex-direction:column;gap:2px;margin-bottom:10px}.mny-big span{font-size:13px;color:var(--muted)}.mny-big b{font-size:28px;font-family:var(--font-head)}.mny-big em{font-style:normal;font-size:14px}' +
    '.mny-focus{background:var(--accent-soft);border-radius:12px;padding:10px 12px;margin-bottom:12px}.mny-focus p{margin:4px 0 0;font-size:13px;color:var(--muted)}' +
    '.mny-seg{display:inline-flex;gap:2px;padding:2px;border-radius:10px;background:var(--surface-2)}.mny-seg button{padding:6px 12px;border-radius:8px;font-size:13px;font-weight:600;color:var(--muted)}.mny-seg button.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}' +
    '.mny-card .mny-row+.mny-row{margin-top:8px}' +
    '.mny-order{margin-top:12px;display:flex;flex-direction:column;gap:6px}.mny-order>div{display:flex;align-items:center;gap:8px;font-size:14px}' +
    '.mny-order .n{width:22px;height:22px;border-radius:50%;background:var(--accent);color:var(--accent-text,#fff);font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}' +
    '.mny-tl{display:flex;align-items:center;gap:8px;margin:3px 0}.mny-tl .nm{width:110px;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.mny-tl .tr{flex:1;position:relative;height:10px;background:var(--surface-2);border-radius:999px;overflow:hidden}' +
    '.mny-tl .pay{position:absolute;left:0;top:0;bottom:0;background:color-mix(in srgb,var(--accent) 30%,transparent)}.mny-tl .focus{position:absolute;top:0;bottom:0;background:var(--accent);border-radius:999px}' +
    '.mny-tl.axis .tr{background:none;height:auto;display:flex;justify-content:space-between;font-size:11px;color:var(--faint)}.mny-tl.axis em{font-style:normal}' +
    '.mny-more{margin:6px 0 4px 2px}.mny-more summary{font-size:12.5px;color:var(--accent);cursor:pointer;margin-bottom:6px}' +
    '.mny-debt{border-bottom:1px dashed var(--line);padding-bottom:8px}.mny-debt:last-of-type{border-bottom:0}' +
    '.mny-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-top:12px}' +
    '.mny-stats>div{background:var(--surface-2);border-radius:12px;padding:10px 12px}.mny-stats span{display:block;font-size:12px;color:var(--muted)}.mny-stats b{font-size:18px}' +
    '.mny-stats .todo b{color:var(--accent)}.mny-stats .ok b{color:#16a34a}' +
    '.mny-info ul{margin:0;padding-left:18px;font-size:13.5px;line-height:1.55;color:var(--muted)}.mny-info li+li{margin-top:6px}' +
    '.mny-chips{display:flex;flex-wrap:wrap;gap:8px;align-items:center}' +
    '.mny-chip{display:inline-flex;align-items:center;gap:6px;background:var(--surface-2);border-radius:12px;padding:4px 4px 4px 4px}.mny-chip input{width:150px}.mny-chip em{font-style:normal;font-size:12px;color:var(--muted)}' +
    '.mny-ck.in{background:color-mix(in srgb,#22c55e 15%,transparent);border-color:#22c55e;color:#16a34a}' +
    '.mny-note{font-size:12px;color:var(--faint);text-align:center}' +
    '.mny-payday{font-size:13px;background:color-mix(in srgb,#22c55e 12%,transparent);border-radius:9px;padding:6px 9px;margin-bottom:6px}' +
    '.addon-today .mny-due{font-size:13.5px}' +
    '@media (max-width:640px){.mny-lbl{min-width:0}.mny-cur input{width:96px}.mny-tl .nm{width:80px}}';
  function ensureCss() { if (document.getElementById('mny-css')) return; var st = document.createElement('style'); st.id = 'mny-css'; st.textContent = CSS; document.head.appendChild(st); }

  /* ---------------- hook into Corner ---------------- */
  window.CornerAddons && window.CornerAddons.register({
    id: 'money', title: 'Money', subtitle: 'Paydays, bills, debts and taxes: one calm place.',
    init: function (api, refresh) {
      API = api; refreshToday = refresh || refreshToday; ensureCss();
      api.load().then(function (d) {
        D = norm(d); loaded = true;
        if (!d && (D.incomes.length || D.bills.length)) D.setupDone = true;
        draw(); refreshToday();
      }, function () { D = norm(null); loaded = true; draw(); });
      api.watch(function (d) { if (!d || dirty) return; D = norm(d); loaded = true; if (!root || !root.contains(document.activeElement)) draw(); refreshToday(); });
    },
    mount: function (el, api) {
      API = API || api; ensureCss(); root = el;
      el.addEventListener('input', onInput); el.addEventListener('change', onInput); el.addEventListener('click', onClick);
      draw();
    },
    onShow: function () { draw(); },
    todayCard: function (el, api) { API = API || api; ensureCss(); return todayCard(el); }
  });
})();
