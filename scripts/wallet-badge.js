/*
 * NovaTrade KE — wallet header widget.
 *
 * Replaces the app's Log in / Sign up buttons with the signed-in user's balances, in the same
 * header slot, and keeps the two in sync across client-side re-renders.
 *
 * Everything it shows comes from the platform's own session and wallet endpoints
 * (/api/auth/session, /api/wallet), which read the double-entry ledger. There is no mock
 * authentication and no hard-coded money in this file: if the API says zero, the header says zero.
 *
 * The chosen account (real or demo) is a UI selection; it is remembered in localStorage and
 * announced on `nt:account-changed`, but it never invents a balance.
 */
(function () {
  'use strict';

  if (window.__ntWalletBadge) return;
  window.__ntWalletBadge = true;

  var ACCOUNT_KEY = 'nt:active-account';
  var root = document.documentElement;

  // Hide the Log in / Sign up buttons from the very first paint and show a placeholder of the same
  // size, so a signed-in visitor never sees them appear and then vanish.
  root.setAttribute('data-nt-auth', 'pending');

  var state = {
    status: 'pending', // pending | in | out
    user: null,
    accounts: null,
    balances: null,
    account: readAccount(),
    open: false,
  };

  var widget = null;
  var applying = false;

  // ---------------------------------------------------------------- helpers
  function readAccount() {
    try {
      var v = localStorage.getItem(ACCOUNT_KEY);
      return v === 'real' || v === 'demo' ? v : '';
    } catch (e) {
      return '';
    }
  }

  function writeAccount(account) {
    try { localStorage.setItem(ACCOUNT_KEY, account); } catch (e) { /* private mode */ }
  }

  function money(cents) {
    var n = Number(cents || 0) / 100;
    try {
      return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
    } catch (e) {
      return '$' + n.toFixed(2);
    }
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  // Writing textContent always replaces the text node, which the MutationObserver would see as a
  // change and re-render on — so only write when the value actually differs.
  function setText(node, value) {
    if (node && node.textContent !== String(value)) node.textContent = String(value);
  }

  function activeBalance() {
    var b = state.balances;
    if (!b) return null;
    return state.account === 'real' ? b.real : b.demo;
  }

  // ---------------------------------------------------------------- styles
  var CSS = [
    /* Log in / Sign up are hidden while we decide, and once we know the visitor is signed in. */
    '[data-nt-authbtn]{display:none!important}',

    '.nt-wallet{display:inline-flex;align-items:center;gap:8px;margin-left:8px;position:relative;vertical-align:middle}',
    '.nt-wallet button{font-family:inherit}',

    /* Real / Demo selector — sized like the header buttons it replaces (32px tall, 4px radius). */
    '.nt-seg{display:inline-flex;height:3.2rem;border:1px solid var(--border-normal,#323738);border-radius:4px;overflow:hidden}',
    '.nt-seg-btn{appearance:none;border:0;background:transparent;color:var(--text-less-prominent,#7f8ea3);',
    'font-size:1.3rem;font-weight:700;line-height:1;letter-spacing:.02em;padding:0 1rem;height:100%;cursor:pointer;',
    'display:inline-flex;align-items:center;gap:.6rem;transition:background .15s ease,color .15s ease}',
    '.nt-seg__label{text-transform:uppercase;font-size:1.05rem;letter-spacing:.06em;opacity:.85;}',
    '.nt-seg__amt{font-variant-numeric:tabular-nums;font-size:1.3rem;font-weight:700;color:var(--text-prominent,#fff)}',
    '.nt-seg-btn[aria-pressed="true"] .nt-seg__amt{color:inherit}',
    '.nt-seg-btn:hover{background:var(--button-tertiary-hover,rgba(255,255,255,.06))}',
    '.nt-seg-btn[aria-pressed="true"]{background:var(--border-normal,#323738);color:var(--text-prominent,#fff)}',
    '.nt-seg-btn:focus-visible{outline:2px solid var(--brand-red-coral,#ff444f);outline-offset:-2px}',

    /* Balance button — opens the account menu. */
    '.nt-amt{appearance:none;display:inline-flex;align-items:center;gap:.6rem;height:3.2rem;padding:0 1.1rem;cursor:pointer;',
    'border:1px solid var(--border-normal,#323738);border-radius:4px;background:transparent;',
    'color:var(--text-prominent,#fff);font-size:1.4rem;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;',
    'transition:background .15s ease}',
    '.nt-amt:hover{background:var(--button-tertiary-hover,rgba(255,255,255,.06))}',
    '.nt-amt:focus-visible{outline:2px solid var(--brand-red-coral,#ff444f);outline-offset:1px}',
    '.nt-amt__value{font-variant-numeric:tabular-nums}',
    /* Desktop shows both balances in the selector itself; the pill is then just the menu affordance. */
    '@media (min-width:601px){.nt-amt__value,.nt-amt__tag,.nt-amt__cur{display:none}.nt-amt{padding:0 .7rem}}',
    '.nt-amt__cur{font-size:1.1rem;font-weight:600;color:var(--text-less-prominent,#7f8ea3);letter-spacing:.04em}',
    '.nt-amt__tag{display:none;font-size:1rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;',
    'color:var(--text-less-prominent,#7f8ea3)}',
    '.nt-amt__caret{width:0;height:0;border-left:3.5px solid transparent;border-right:3.5px solid transparent;',
    'border-top:4px solid currentColor;opacity:.7;margin-left:.2rem}',

    /* Placeholder that occupies the same space while the session is being read. */
    '.nt-skel{display:inline-flex;align-items:center;gap:8px;margin-left:8px;vertical-align:middle}',
    '.nt-skel i{display:block;height:3.2rem;border-radius:4px;background:var(--border-normal,#323738);opacity:.45;',
    'animation:nt-pulse 1.1s ease-in-out infinite}',
    '.nt-skel i:first-child{width:104px}',
    '.nt-skel i:last-child{width:118px;margin-left:8px}',
    '@keyframes nt-pulse{0%,100%{opacity:.28}50%{opacity:.55}}',
    '@media (prefers-reduced-motion:reduce){.nt-skel i{animation:none;opacity:.4}}',

    /* Account menu. Fixed-positioned so the app's header overflow cannot clip it. */
    '.nt-menu{position:fixed;z-index:2147483000;width:284px;padding:1.2rem;border-radius:8px;',
    'background:var(--general-main-1,#0e0e0e);border:1px solid var(--border-normal,#323738);',
    'box-shadow:0 12px 32px rgba(0,0,0,.45);color:var(--text-general,#c2c2c2);',
    'font-size:1.3rem;line-height:1.45;text-align:left}',
    '.nt-menu__who{font-weight:700;color:var(--text-prominent,#fff);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.nt-menu__meta{color:var(--text-less-prominent,#7f8ea3);font-size:1.2rem;margin-top:.2rem}',
    '.nt-menu__sep{height:1px;background:var(--border-normal,#323738);margin:1rem 0}',
    '.nt-menu__row{display:flex;align-items:center;justify-content:space-between;width:100%;gap:1rem;',
    'padding:.7rem .6rem;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer;text-align:left;font-size:1.3rem}',
    '.nt-menu__row:hover{background:var(--button-tertiary-hover,rgba(255,255,255,.06))}',
    '.nt-menu__row[aria-checked="true"]{background:var(--button-tertiary-default,rgba(255,255,255,.04))}',
    '.nt-menu__label{display:inline-flex;align-items:center;gap:.6rem;font-weight:600;color:var(--text-prominent,#fff)}',
    '.nt-menu__dot{width:6px;height:6px;border-radius:50%;background:transparent;border:1px solid var(--border-normal,#7f8ea3)}',
    '.nt-menu__row[aria-checked="true"] .nt-menu__dot{background:var(--brand-red-coral,#ff444f);border-color:var(--brand-red-coral,#ff444f)}',
    '.nt-menu__val{font-variant-numeric:tabular-nums;font-weight:700;color:var(--text-prominent,#fff)}',
    '.nt-menu__note{font-size:1.15rem;color:var(--text-less-prominent,#7f8ea3);padding:0 .6rem .4rem}',
    '.nt-menu__link{display:block;padding:.7rem .6rem;border-radius:4px;color:var(--text-prominent,#fff);',
    'text-decoration:none;font-weight:600;font-size:1.3rem;background:transparent;border:0;cursor:pointer;width:100%;text-align:left;font-family:inherit}',
    '.nt-menu__link:hover{background:var(--button-tertiary-hover,rgba(255,255,255,.06))}',
    '.nt-menu__link--danger{color:var(--text-loss-danger,#ff444f)}',
    '.nt-menu__err{color:var(--text-loss-danger,#ff444f);font-size:1.2rem;padding:.2rem .6rem .4rem}',

    /* Small screens: the header has no room for both controls, so the selector moves into the menu. */
    '@media (max-width:600px){',
    '.nt-seg{display:none}',
    '.nt-amt__tag{display:inline}',
    '.nt-amt{padding:0 .9rem}',
    '.nt-skel i:last-child{width:96px}',
    '.nt-menu{width:calc(100vw - 24px);max-width:320px}',
    '}',
  ].join('');

  function injectStyles() {
    if (document.getElementById('nt-wallet-styles')) return;
    var style = el('style', { id: 'nt-wallet-styles', type: 'text/css' });
    style.textContent = CSS;
    (document.head || root).appendChild(style);
  }
  injectStyles();

  // ---------------------------------------------------------------- API
  function getSession() {
    return fetch('/api/auth/session', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) return { ok: false };
      if (!res.ok) throw new Error('session probe failed');
      return res.json().then(function (data) {
        return { ok: data && data.ok !== false, data: data };
      });
    });
  }

  function getWallet() {
    return fetch('/api/wallet', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    }).then(function (res) {
      if (!res.ok) throw new Error('wallet fetch failed');
      return res.json();
    });
  }

  // ---------------------------------------------------------------- applying auth state
  var AUTH_BTN = /^(log\s*-?\s*in|sign\s*-?\s*in|sign\s*-?\s*up|register|create\s+account|open\s+account)$/i;

  function hideAppAuthButtons() {
    var scope = document.querySelectorAll('.auth-actions button, header button');
    for (var i = 0; i < scope.length; i++) {
      var b = scope[i];
      if (b.closest('.nt-wallet') || b.closest('.nt-menu')) continue;
      var text = (b.innerText || b.textContent || '').trim();
      if (!AUTH_BTN.test(text)) continue;
      if (b.getAttribute('data-nt-authbtn') !== '1') {
        b.setAttribute('data-nt-authbtn', '1');
        // The bundle delegates clicks on these; leaving them interactive behind the wallet would
        // let a stale handler fire, so neutralise them rather than only hiding them.
        b.setAttribute('tabindex', '-1');
        b.setAttribute('aria-hidden', 'true');
      }
    }
  }

  function showAppAuthButtons() {
    var hidden = document.querySelectorAll('[data-nt-authbtn]');
    for (var i = 0; i < hidden.length; i++) {
      hidden[i].removeAttribute('data-nt-authbtn');
      hidden[i].removeAttribute('tabindex');
      hidden[i].removeAttribute('aria-hidden');
    }
  }

  function slot() {
    var actions = document.querySelector('.auth-actions');
    if (!actions) return null;
    // Sit exactly where the Log in / Sign up buttons were: immediately before them.
    var first = null;
    var kids = actions.children;
    for (var i = 0; i < kids.length; i++) {
      var t = (kids[i].innerText || '').trim();
      if (AUTH_BTN.test(t)) { first = kids[i]; break; }
    }
    return { parent: actions, before: first };
  }

  function mount(node) {
    var s = slot();
    if (!s) return false;
    if (node.parentNode === s.parent && (!s.before || node.nextElementSibling === s.before)) return true;
    if (s.before) s.parent.insertBefore(node, s.before);
    else s.parent.appendChild(node);
    return true;
  }

  function removeWidget() {
    if (widget && widget.parentNode) widget.parentNode.removeChild(widget);
    widget = null;
    closeMenu();
  }

  // ---------------------------------------------------------------- widget
  function accountLabel() { return state.account === 'real' ? 'Real' : 'Demo'; }

  function buildWidget() {
    var segReal = el('button', {
      type: 'button', class: 'nt-seg-btn', 'data-nt-acc': 'real',
      title: 'Real account', 'aria-pressed': 'false',
    }, [
      el('span', { class: 'nt-seg__label', text: 'Real' }),
      el('span', { class: 'nt-seg__amt', 'data-nt-amt': 'real', text: '—' }),
    ]);
    var segDemo = el('button', {
      type: 'button', class: 'nt-seg-btn', 'data-nt-acc': 'demo',
      title: 'Demo account', 'aria-pressed': 'false',
    }, [
      el('span', { class: 'nt-seg__label', text: 'Demo' }),
      el('span', { class: 'nt-seg__amt', 'data-nt-amt': 'demo', text: '—' }),
    ]);
    var seg = el('div', { class: 'nt-seg', role: 'group', 'aria-label': 'Switch between real and demo account' }, [segReal, segDemo]);

    var value = el('span', { class: 'nt-amt__value', 'data-nt-value': '1', text: '—' });
    var cur = el('span', { class: 'nt-amt__cur', text: 'USD' });
    var tag = el('span', { class: 'nt-amt__tag', 'data-nt-tag': '1', text: 'Demo' });
    var caret = el('span', { class: 'nt-amt__caret', 'aria-hidden': 'true' });
    var amt = el('button', {
      type: 'button', class: 'nt-amt', 'data-nt-menu-btn': '1',
      'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-label': 'Account menu',
      title: 'Account menu',
    }, [tag, value, cur, caret]);

    var node = el('div', { class: 'nt-wallet', 'data-nt-wallet': '1' }, [seg, amt]);

    node.addEventListener('click', function (ev) {
      var target = ev.target;
      var accBtn = target.closest && target.closest('[data-nt-acc]');
      if (accBtn) { ev.preventDefault(); ev.stopPropagation(); setAccount(accBtn.getAttribute('data-nt-acc')); return; }
      if (target.closest && target.closest('[data-nt-menu-btn]')) { ev.preventDefault(); ev.stopPropagation(); toggleMenu(); }
    });

    return node;
  }

  function renderWidget() {
    if (!widget) return;
    var b = activeBalance();
    var all = state.balances;
    var value = widget.querySelector('[data-nt-value]');
    var tag = widget.querySelector('[data-nt-tag]');
    var buttons = widget.querySelectorAll('[data-nt-acc]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', buttons[i].getAttribute('data-nt-acc') === state.account ? 'true' : 'false');
    }
    // Both balances are shown side by side; the selected one is the highlighted segment.
    ['real', 'demo'].forEach(function (key) {
      var cell = widget.querySelector('[data-nt-amt="' + key + '"]');
      if (cell) setText(cell, all && all[key] ? money(all[key].totalCents) : '—');
    });
    if (value) setText(value, b ? money(b.totalCents) : '—');
    if (tag) setText(tag, accountLabel());
    var realBtn = widget.querySelector('[data-nt-acc="real"]');
    if (realBtn && all && all.real) {
      realBtn.title = all.real.totalCents > 0
        ? 'Real account — ' + money(all.real.totalCents)
        : 'Real account — unfunded, deposits are disabled on this platform';
    }
    var demoBtn = widget.querySelector('[data-nt-acc="demo"]');
    if (demoBtn) demoBtn.title = 'Demo account — virtual practice funds';
    var amt = widget.querySelector('[data-nt-menu-btn]');
    if (amt && b) {
      amt.setAttribute('aria-label', accountLabel() + ' account, ' + money(b.totalCents) + '. Open account menu');
      amt.title = state.account === 'real'
        ? (b.totalCents > 0 ? 'Real account (from the ledger)' : 'Real account — unfunded, cashier disabled')
        : 'Demo account — virtual funds';
    }
    root.setAttribute('data-nt-account', state.account);
  }

  function setAccount(account) {
    if (account !== 'real' && account !== 'demo') return;
    state.account = account;
    writeAccount(account);
    renderWidget();
    refreshMenu();
    // Re-read the wallet so the number shown after a switch is the current ledger figure.
    getWallet().then(function (data) {
      if (data && data.real && data.demo) {
        state.balances = data;
        renderWidget();
        refreshMenu();
      }
    }).catch(function () { /* keep the figures we already have */ });
    try {
      document.dispatchEvent(new CustomEvent('nt:account-changed', {
        detail: { account: account, balance: activeBalance() },
      }));
    } catch (e) { /* no CustomEvent */ }
  }

  // ---------------------------------------------------------------- menu
  var menu = null;

  function closeMenu() {
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null;
    state.open = false;
    if (widget) {
      var btn = widget.querySelector('[data-nt-menu-btn]');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
  }

  function toggleMenu() {
    if (state.open) { closeMenu(); return; }
    openMenu();
  }

  function openMenu() {
    if (!state.balances || !widget) return;
    closeMenu();
    menu = el('div', { class: 'nt-menu', role: 'menu', 'data-nt-menu': '1' });
    fillMenu();
    document.body.appendChild(menu);

    var btn = widget.querySelector('[data-nt-menu-btn]');
    var r = btn.getBoundingClientRect();
    var width = menu.offsetWidth;
    var left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    var top = r.bottom + 8;
    if (top + menu.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - menu.offsetHeight - 8);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    state.open = true;
    btn.setAttribute('aria-expanded', 'true');
    var firstRow = menu.querySelector('[data-nt-acc]');
    if (firstRow) firstRow.focus({ preventScroll: true });
  }

  function refreshMenu() { if (menu) fillMenu(); }

  function fillMenu() {
    if (!menu) return;
    while (menu.firstChild) menu.removeChild(menu.firstChild);
    var user = state.user || {};
    var acc = state.accounts || {};
    var b = state.balances;

    menu.appendChild(el('div', { class: 'nt-menu__who', text: user.email || 'Signed in' }));
    menu.appendChild(el('div', {
      class: 'nt-menu__meta',
      text: (acc.accountNumber ? 'Account ' + acc.accountNumber : '') + (acc.currency ? ' · ' + acc.currency : ''),
    }));
    menu.appendChild(el('div', { class: 'nt-menu__sep' }));

    ['real', 'demo'].forEach(function (key) {
      var bal = b[key] || { totalCents: 0, availableCents: 0, heldCents: 0 };
      var row = el('button', {
        type: 'button', class: 'nt-menu__row', role: 'menuitemradio',
        'data-nt-acc': key, 'aria-checked': state.account === key ? 'true' : 'false',
      }, [
        el('span', { class: 'nt-menu__label' }, [
          el('span', { class: 'nt-menu__dot', 'aria-hidden': 'true' }),
          el('span', { text: key === 'real' ? 'Real account' : 'Demo account' }),
        ]),
        el('span', { class: 'nt-menu__val', text: money(bal.totalCents) }),
      ]);
      row.addEventListener('click', function (ev) {
        ev.preventDefault();
        setAccount(key);
        closeMenu();
      });
      menu.appendChild(row);
    });

    var realBal = b.real || { totalCents: 0, heldCents: 0 };
    var note = realBal.totalCents > 0
      ? (realBal.heldCents > 0 ? money(realBal.heldCents) + ' of real funds is held for pending withdrawals.' : 'Real balance is read from the ledger.')
      : 'The real account is unfunded — deposits are disabled on this platform.';
    menu.appendChild(el('div', { class: 'nt-menu__note', text: note }));
    menu.appendChild(el('div', { class: 'nt-menu__note', text: 'Demo funds are virtual practice money and cannot be withdrawn.' }));
    menu.appendChild(el('div', { class: 'nt-menu__sep' }));

    var tradeLink = el('a', { class: 'nt-menu__link', href: '/trade', text: 'Trade demo account' });
    menu.appendChild(tradeLink);
    var balancesLink = el('a', { class: 'nt-menu__link', href: '/account', text: 'Your balances' });
    menu.appendChild(balancesLink);

    var logout = el('button', { type: 'button', class: 'nt-menu__link nt-menu__link--danger', 'data-nt-logout': '1', text: 'Log out' });
    logout.addEventListener('click', function (ev) {
      ev.preventDefault();
      logout.disabled = true;
      logout.textContent = 'Signing out…';
      fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(function (res) {
          if (!res.ok) throw new Error('logout failed');
          setStatus('out');
        })
        .catch(function () {
          logout.disabled = false;
          logout.textContent = 'Log out';
          if (menu) menu.appendChild(el('div', { class: 'nt-menu__err', text: 'Could not sign out. Please try again.' }));
        });
    });
    menu.appendChild(logout);
  }

  // ---------------------------------------------------------------- state transitions
  function showSkeleton() {
    var skel = document.querySelector('.nt-skel');
    if (skel) { mount(skel); return; }
    skel = el('div', { class: 'nt-skel', 'aria-hidden': 'true' }, [el('i'), el('i')]);
    if (!mount(skel)) {
      // No header on this page yet — the observer mounts it when the header renders.
    }
  }

  function removeSkeleton() {
    var skel = document.querySelector('.nt-skel');
    if (skel && skel.parentNode) skel.parentNode.removeChild(skel);
  }

  function setStatus(status) {
    state.status = status;
    root.setAttribute('data-nt-auth', status);

    if (status === 'out') {
      state.user = null;
      state.accounts = null;
      state.balances = null;
      removeWidget();
      removeSkeleton();
      showAppAuthButtons();
      try {
        document.dispatchEvent(new CustomEvent('nt:auth-changed', { detail: { authenticated: false } }));
      } catch (e) { /* ignore */ }
      return;
    }

    if (status === 'pending') {
      hideAppAuthButtons();
      showSkeleton();
      return;
    }

    // status === 'in'
    removeSkeleton();
    if (!widget) widget = buildWidget();
    if (!mount(widget)) { /* header not rendered yet; observer will mount */ }
    hideAppAuthButtons();
    renderWidget();
    try {
      document.dispatchEvent(new CustomEvent('nt:auth-changed', {
        detail: { authenticated: true, user: state.user, balances: state.balances, account: state.account },
      }));
    } catch (e) { /* ignore */ }
  }

  function applySession(data) {
    state.user = data.user || null;
    state.accounts = data.accounts || null;
    state.balances = data.balances || (data.wallet ? { real: data.wallet, demo: { totalCents: 0, availableCents: 0, heldCents: 0 } } : null);
    if (!state.account) {
      // First visit on this browser: default to whichever wallet actually holds money, demo first.
      state.account = state.balances && state.balances.demo && state.balances.demo.totalCents > 0 ? 'demo' : 'real';
      writeAccount(state.account);
    }
    setStatus('in');
  }

  function probe() {
    getSession().then(function (r) {
      if (!r.ok) { setStatus('out'); return; }
      applySession(r.data || {});
    }).catch(function () {
      // Network/API failure: never leave the header stuck hidden; fall back to the app's own buttons.
      setStatus('out');
    });
  }

  // ---------------------------------------------------------------- keep the header in sync
  function apply() {
    if (applying) return;
    applying = true;
    try {
      if (state.status === 'pending') {
        hideAppAuthButtons();
        showSkeleton();
      } else if (state.status === 'in') {
        hideAppAuthButtons();
        if (widget) {
          if (!mount(widget)) { /* header absent on this page */ }
          renderWidget();
        }
      } else if (state.status === 'out') {
        showAppAuthButtons();
      }
    } finally {
      applying = false;
    }
  }

  var scheduled = false;
  function scheduleApply() {
    if (scheduled) return;
    scheduled = true;
    var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
    raf(function () { scheduled = false; apply(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  } else {
    apply();
  }

  try {
    var mo = new MutationObserver(scheduleApply);
    mo.observe(root, { childList: true, subtree: true });
  } catch (e) { /* no observer: the click-through paths still work */ }

  // Close the menu on outside click / Escape / scrolling away.
  document.addEventListener('click', function (ev) {
    if (!state.open) return;
    if (menu && (menu.contains(ev.target) || ev.target.closest('[data-nt-menu-btn]'))) return;
    closeMenu();
  }, true);
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && state.open) { closeMenu(); }
  });
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', closeMenu, true);

  // Coming back to the tab, or restoring from the back/forward cache: re-read the session so the
  // header can never show a wallet that the server has since expired.
  window.addEventListener('focus', function () { if (state.status === 'in') probe(); });
  window.addEventListener('pageshow', function (ev) { if (ev.persisted) probe(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.status !== 'pending') probe();
  });

  probe();
})();
