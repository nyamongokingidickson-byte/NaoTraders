/*
 * NovaTrade KE — real-account notice.
 *
 * Every tab in the platform (Bot Builder, Bulk Trader, Charts, DTrader, Copy Trading …) trades the
 * account the header says is selected. The real wallet exists but cannot be funded yet: deposits are
 * not switched on, so its balance is genuinely 0.00 and the server refuses any order booked against
 * it (INSUFFICIENT_FUNDS, with that reason in the message).
 *
 * This banner makes that state visible on every tab instead of leaving a trader to discover it when a
 * button appears to do nothing: it says what the real wallet holds, why an order will be refused, and
 * offers one tap back to the demo account. It never hides the real account and never invents a balance
 * — the figure comes from /api/wallet, which reads the ledger.
 */
(function () {
  'use strict';

  if (window.__ntRealNotice) return;
  window.__ntRealNotice = true;

  var ACCOUNT_KEY = 'nt:active-account';
  var realCents = null;
  var banner = null;

  function account() {
    try { return localStorage.getItem(ACCOUNT_KEY) === 'real' ? 'real' : 'demo'; } catch (e) { return 'demo'; }
  }

  function money(cents) {
    var n = Number(cents || 0) / 100;
    try { return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }); }
    catch (e) { return '$' + n.toFixed(2); }
  }

  function styles() {
    if (document.getElementById('nt-real-notice-style')) return;
    var css = [
      '#nt-real-notice{position:sticky;top:0;z-index:9998;display:flex;gap:10px;align-items:center;flex-wrap:wrap;',
      'background:#2a1f06;color:#fcd34d;border-bottom:1px solid #59430d;padding:9px 12px;',
      'font:600 12.5px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}',
      '#nt-real-notice strong{color:#fde68a}',
      '#nt-real-notice .nt-real-notice__btn{margin-left:auto;background:#fbbf24;color:#231a03;border:0;border-radius:8px;',
      'padding:7px 12px;font:800 12.5px/1 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;cursor:pointer}',
      '#nt-real-notice .nt-real-notice__btn:hover{background:#fcd34d}',
      '@media(max-width:600px){#nt-real-notice{font-size:12px;padding:8px 10px}#nt-real-notice .nt-real-notice__btn{margin-left:0}}',
    ].join('');
    var s = document.createElement('style');
    s.id = 'nt-real-notice-style';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  function switchToDemo() {
    try { localStorage.setItem(ACCOUNT_KEY, 'demo'); } catch (e) { /* private mode */ }
    try { document.dispatchEvent(new CustomEvent('nt:account-changed', { detail: { account: 'demo' } })); } catch (e) { /* no CustomEvent */ }
    // The shell authorises once per boot, so a reload is what actually moves the bot / bulk trader /
    // chart onto the other wallet — exactly what the header switcher does.
    location.reload();
  }

  function render() {
    var show = account() === 'real';
    if (!show) {
      if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
      banner = null;
      return;
    }
    styles();
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'nt-real-notice';
      banner.setAttribute('role', 'status');
      var btn = document.createElement('button');
      btn.className = 'nt-real-notice__btn';
      btn.type = 'button';
      btn.textContent = 'Switch to demo';
      btn.addEventListener('click', switchToDemo);
      banner.appendChild(document.createElement('span'));
      banner.appendChild(btn);
    }
    var text = banner.firstChild;
    var held = realCents === null ? 'an empty wallet' : money(realCents);
    text.innerHTML = '';
    var strong = document.createElement('strong');
    strong.textContent = 'Real account selected';
    text.appendChild(strong);
    text.appendChild(document.createTextNode(
      ' — ' + held + ' available. Deposits are not switched on yet, so orders on this account are refused. ' +
      'Trade on the demo account to keep practising.'));
    if (!banner.parentNode) {
      var host = document.body;
      if (host) host.insertBefore(banner, host.firstChild);
    }
  }

  function loadBalance() {
    fetch('/api/wallet', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.real) { realCents = Number(data.real.availableCents || 0) + Number(data.real.heldCents || 0); }
        render();
      })
      .catch(function () { render(); });
  }

  document.addEventListener('nt:account-changed', function () { render(); });
  window.addEventListener('storage', function (e) { if (e.key === ACCOUNT_KEY) render(); });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { render(); loadBalance(); });
  else { render(); loadBalance(); }
})();
