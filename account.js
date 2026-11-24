// Balances page: reads the signed-in user's wallets from the API and renders them.
// No number on this page is hard-coded — every figure comes from /api/wallet, which derives
// balances from the ledger. If the session is gone, send the visitor to /login.
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const money = (cents) => {
    const n = Number(cents || 0) / 100;
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
  };

  function alertBox(message, kind = 'err') {
    const el = $('#alert');
    if (!message) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.className = `alert ${kind === 'err' ? '' : kind}`.trim();
    el.textContent = message;
  }

  async function getJSON(path, options) {
    const res = await fetch(path, { credentials: 'same-origin', ...(options || {}) });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data };
  }

  function render(session) {
    const { user, accounts, balances, cashier } = session;

    $('#pageTitle').textContent = `Hi ${String(user.displayName || '').split(' ')[0] || 'there'}`;
    const who = $('#who');
    who.hidden = false;
    who.innerHTML = `<strong>${user.email}</strong> · Account ${accounts.accountNumber} · Member since `
      + new Date(accounts.memberSince).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

    $('#demoAmount').textContent = money(balances.demo.totalCents);
    $('#realAmount').textContent = money(balances.real.totalCents);

    const realEnabled = Boolean(cashier && cashier.realMoneyEnabled);
    $('#realTag').textContent = realEnabled ? 'Cashier enabled' : 'Cashier disabled';
    if (balances.real.heldCents > 0) {
      $('#realNote').textContent = `${money(balances.real.availableCents)} available, ${money(balances.real.heldCents)} held for pending withdrawals.`;
    }

    $('#loading').hidden = true;
    $('#balances').hidden = false;
    $('#actions').hidden = false;
  }

  async function load() {
    const { ok, status, data } = await getJSON('/api/auth/session');
    if (!ok || data.ok === false) {
      if (status === 401) { location.replace('/login'); return; }
      $('#loading').hidden = true;
      $('#whenSignedOut').hidden = false;
      alertBox(data.error || 'We could not load your account.');
      return;
    }
    render(data);
  }

  $('#logoutBtn').addEventListener('click', async () => {
    const btn = $('#logoutBtn');
    btn.disabled = true;
    btn.textContent = 'Signing out…';
    await getJSON('/api/auth/logout', { method: 'POST' });
    location.replace('/login');
  });

  load().catch(() => {
    $('#loading').hidden = true;
    $('#whenSignedOut').hidden = false;
    alertBox('We could not reach the server. Please try again.');
  });
})();
