/*
 * Money add-on for Corner.
 * Lives in its own file and is only loaded when someone switches it on
 * (Settings & backup → Add-ons). Its data is kept in its own section
 * ("pm/addon-money"), separate from tasks and webs.
 *
 * Version 0: a placeholder while the design is being finalised.
 */
(function () {
  'use strict';
  var CSS = '' +
    '.mny{display:flex;flex-direction:column;gap:14px}' +
    '.mny-hero{border-radius:18px;padding:22px 22px 20px;background:var(--grad-soft);border:1px solid var(--line)}' +
    '.mny-hero b{display:block;font-family:var(--font-head);font-size:22px;margin-bottom:4px}' +
    '.mny-hero p{margin:0;color:var(--muted);max-width:620px}' +
    '.mny-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}' +
    '.mny-card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px;box-shadow:var(--shadow)}' +
    '.mny-card h3{margin:0 0 6px;font-family:var(--font-head);font-size:16px;display:flex;align-items:center;gap:8px}' +
    '.mny-card p{margin:0;color:var(--muted);font-size:13px;line-height:1.5}' +
    '.mny-step{display:inline-block;margin-top:10px;font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);background:var(--accent-soft);border-radius:999px;padding:3px 9px}' +
    '.mny-note{font-size:12px;color:var(--faint)}';

  function mount(el, api) {
    if (!document.getElementById('mny-css')) { var st = document.createElement('style'); st.id = 'mny-css'; st.textContent = CSS; document.head.appendChild(st); }
    el.innerHTML =
      '<div class="mny">' +
        '<div class="mny-hero"><b>💰 Money is on its way</b>' +
          '<p>This is your Money section. It’s switched on and ready. The pages below are being designed now and will appear here as they’re finished. Nothing here touches your tasks or webs.</p></div>' +
        '<div class="mny-grid">' +
          '<div class="mny-card"><h3>📉 Debts</h3><p>Add each debt with its interest and monthly payment, and see your path to debt freedom: snowball or avalanche, with a debt-free date.</p><span class="mny-step">Coming first</span></div>' +
          '<div class="mny-card"><h3>🧾 Monthly budget</h3><p>Plan each month by category, log what you spend, and watch it fill in charts: where it goes, planned vs. spent, and month to month.</p><span class="mny-step">Next</span></div>' +
          '<div class="mny-card"><h3>🎯 Savings goals</h3><p>Set a target and a monthly amount to see when you’ll reach it, with a progress ring for each goal.</p><span class="mny-step">After that</span></div>' +
        '</div>' +
        '<div class="mny-note">Shows the math, not financial advice. Your money data stays in its own private section.</div>' +
      '</div>';
  }

  window.CornerAddons && window.CornerAddons.register({
    id: 'money',
    title: 'Money',
    subtitle: 'Debts, budget and savings, all in one calm place.',
    mount: mount
  });
})();
