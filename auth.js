// Account UI: login, registration (activated immediately) and link-based password reset.
// All validation is mirrored server-side — nothing here is trusted.
(() => {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  const PATHS = {
    login: '/login',
    register: '/register',
    forgot: '/forgot-password',
    'reset-password': '/reset-password',
    done: '/login',
  };
  const FROM_PATH = {
    '/login': 'login', '/register': 'register', '/forgot-password': 'forgot',
    '/reset-password': 'reset-password', '/auth': 'login',
  };

  const KEY_RESET_TICKET = 'nt_reset_ticket';

  const store = {
    get: (k) => { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
    del: (k) => { try { sessionStorage.removeItem(k); } catch {} },
  };

  // The reset link carries the ticket as ?token=…; keep it across reloads, then drop it from view.
  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) {
    store.set(KEY_RESET_TICKET, urlToken);
    try { history.replaceState({ view: 'reset-password' }, '', '/reset-password?token=' + urlToken); } catch {}
  }
  const resetTicket = () => urlToken || store.get(KEY_RESET_TICKET);

  let currentView = 'login';

  // ---------------------------------------------------------------- dom helpers
  function setAlert(message, kind = 'err', html = '') {
    const el = $('#alert');
    if (!message) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.className = `alert ${kind === 'err' ? '' : kind}`.trim();
    el.innerHTML = html || message;
  }
  const clearAlert = () => setAlert('');

  function fieldError(name, message) {
    const el = $(`.view.active .err[data-err="${name}"]`);
    if (el) el.textContent = message || '';
    const input = $(`.view.active [name="${name}"]`);
    if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }
  function clearFieldErrors() {
    $$('.view.active .err').forEach((e) => { e.textContent = ''; });
    $$('.view.active input').forEach((i) => i.setAttribute('aria-invalid', 'false'));
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.label = button.textContent;
      button.textContent = label || 'Please wait…';
      button.disabled = true;
    } else {
      button.textContent = button.dataset.label || button.textContent;
      button.disabled = false;
    }
  }

  // ---------------------------------------------------------------- http
  async function api(path, body, method = 'POST') {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok || data.ok === false) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.code = data.code;
      err.status = res.status;
      err.retryAfterMs = data.retryAfterMs;
      err.attemptsLeft = data.attemptsLeft;
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------- routing
  function showView(name, { push = true, title } = {}) {
    currentView = name;
    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
    document.title = `NovaTrade KE — ${title || labelFor(name)}`;
    if (push && PATHS[name] && name !== 'reset-password') {
      const target = PATHS[name];
      if (location.pathname !== target) history.pushState({ view: name }, '', target);
    }
    setAlert('');
    clearFieldErrors();
    const first = $('.view.active input');
    if (first && window.matchMedia('(min-width: 700px)').matches) first.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  const labelFor = (v) => ({
    login: 'Sign in', register: 'Create account', forgot: 'Reset password',
    'reset-password': 'New password', done: 'Done',
  }[v] || 'Account');

  function resolveInitialView() {
    const base = FROM_PATH[location.pathname.replace(/\/$/, '') || '/login'] || 'login';
    // A reset page without a ticket cannot do anything — send them to request a link.
    if (base === 'reset-password' && !resetTicket()) return 'forgot';
    return base;
  }

  function showDone({ title, message, cta }) {
    $('#doneTitle').textContent = title;
    $('#doneMessage').textContent = message;
    $('#doneCta').textContent = cta;
    showView('done');
  }

  // ---------------------------------------------------------------- password meter
  function scorePassword(pw) {
    let score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
    if (/[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
    return Math.min(4, score);
  }
  function wireMeter(inputId, meterId) {
    const input = document.getElementById(inputId);
    const meter = document.getElementById(meterId);
    if (!input || !meter) return;
    input.addEventListener('input', () => meter.setAttribute('data-score', String(scorePassword(input.value))));
  }

  // ---------------------------------------------------------------- reveal buttons
  $$('.reveal').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? 'Show' : 'Hide';
      btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    });
  });

  // ---------------------------------------------------------------- LOGIN
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert(); clearFieldErrors();
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPassword').value;
    if (!email) return fieldError('email', 'Enter your email address.');
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return fieldError('email', 'That email address looks incomplete.');
    if (!password) return fieldError('password', 'Enter your password.');

    const btn = $('#loginSubmit');
    setBusy(btn, true, 'Signing in…');
    try {
      await api('/api/auth/login', { email, password });
      store.del(KEY_RESET_TICKET);
      setBusy(btn, false);
      btn.textContent = 'Signed in — opening dashboard…';
      location.replace('/');
    } catch (err) {
      setBusy(btn, false);
      if (err.code === 'ACCOUNT_NOT_FOUND') {
        fieldError('email', 'Account not found. Please register first.');
        setAlert('Account not found. Please register first.', 'err',
          'We have no account with that email. <a href="/register">Create an account</a> — it takes a minute.');
      } else if (err.code === 'INVALID_PASSWORD') {
        fieldError('password', 'Incorrect password. Please try again.');
        setAlert(err.attemptsLeft !== undefined && err.attemptsLeft <= 3
          ? `Incorrect password. Please try again. ${err.attemptsLeft} attempt${err.attemptsLeft === 1 ? '' : 's'} left before a short lockout.`
          : 'Incorrect password. Please try again.');
        $('#loginPassword').select();
      } else {
        setAlert(err.message);
      }
    }
  });

  // ---------------------------------------------------------------- REGISTER
  $('#registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert(); clearFieldErrors();
    const displayName = $('#regName').value.trim();
    const email = $('#regEmail').value.trim();
    const password = $('#regPassword').value;
    const confirmPassword = $('#regConfirm').value;

    let bad = false;
    if (displayName.length < 2) { fieldError('displayName', 'Enter your full name.'); bad = true; }
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) { fieldError('email', 'Enter a valid email address.'); bad = true; }
    if (password.length < 8) { fieldError('password', 'Password must be at least 8 characters.'); bad = true; }
    else if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) { fieldError('password', 'Include at least one letter and one number.'); bad = true; }
    if (password !== confirmPassword) { fieldError('confirmPassword', 'Passwords do not match.'); bad = true; }
    if (bad) return;

    const btn = $('#registerSubmit');
    setBusy(btn, true, 'Creating account…');
    try {
      await api('/api/auth/register', { displayName, email, password, confirmPassword });
      setBusy(btn, false, 'Account created');
      showDone({
        title: 'Account created',
        message: 'You are signed in and your account is ready. Opening your dashboard…',
        cta: 'Go to dashboard',
      });
      setTimeout(() => location.replace('/'), 900);
    } catch (err) {
      setBusy(btn, false);
      if (err.code === 'ALREADY_REGISTERED') {
        fieldError('email', 'That email is already registered.');
        setAlert('An account with this email already exists. <a href="/login">Sign in instead</a> — or <a href="/forgot-password">reset your password</a> if you have forgotten it.', 'err');
      } else if (err.code === 'WEAK_PASSWORD') { fieldError('password', err.message); setAlert(err.message); }
      else if (err.code === 'PASSWORD_MISMATCH') { fieldError('confirmPassword', err.message); setAlert(err.message); }
      else if (err.code === 'INVALID_NAME') { fieldError('displayName', err.message); setAlert(err.message); }
      else if (err.code === 'INVALID_EMAIL') { fieldError('email', err.message); setAlert(err.message); }
      else setAlert(err.message);
    }
  });

  // ---------------------------------------------------------------- FORGOT (emails a link)
  $('#forgotForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert(); clearFieldErrors();
    const email = $('#forgotEmail').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return fieldError('email', 'Enter the email on your account.');

    const btn = $('#forgotSubmit');
    setBusy(btn, true, 'Sending…');
    try {
      const data = await api('/api/auth/forgot-password', { email });
      setBusy(btn, false);
      showDone({
        title: 'Check your email',
        message: data.message || 'If that email is registered, we have sent a password reset link. It expires in 30 minutes.',
        cta: 'Back to sign in',
      });
    } catch (err) {
      setBusy(btn, false);
      setAlert(err.message);
    }
  });

  // ---------------------------------------------------------------- RESET: new password
  $('#newPasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert(); clearFieldErrors();
    const ticket = resetTicket();
    const password = $('#newPassword').value;
    const confirmPassword = $('#newConfirm').value;
    if (!ticket) { setAlert('That reset link is missing its token. Please request a new link.'); return showView('forgot'); }

    let bad = false;
    if (password.length < 8) { fieldError('password', 'Password must be at least 8 characters.'); bad = true; }
    else if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) { fieldError('password', 'Include at least one letter and one number.'); bad = true; }
    if (password !== confirmPassword) { fieldError('confirmPassword', 'Passwords do not match.'); bad = true; }
    if (bad) return;

    const btn = $('#newPasswordSubmit');
    setBusy(btn, true, 'Updating…');
    try {
      const data = await api('/api/auth/reset/complete', { ticket, password, confirmPassword });
      store.del(KEY_RESET_TICKET);
      setBusy(btn, false);
      showDone({
        title: 'Password updated',
        message: data.message || 'Your password has been changed and all devices were signed out.',
        cta: 'Sign in with your new password',
      });
    } catch (err) {
      setBusy(btn, false);
      if (err.code === 'WEAK_PASSWORD') fieldError('password', err.message);
      else if (err.code === 'PASSWORD_MISMATCH') fieldError('confirmPassword', err.message);
      else if (err.code === 'PASSWORD_UNCHANGED') fieldError('password', err.message);
      if (err.code === 'RESET_TICKET_USED' || err.code === 'RESET_TICKET_EXPIRED' || err.code === 'RESET_TICKET_INVALID') {
        store.del(KEY_RESET_TICKET);
        setAlert(err.message + ' Redirecting…');
        setTimeout(() => showView('forgot'), 1400);
      } else setAlert(err.message);
    }
  });

  // ---------------------------------------------------------------- misc wiring
  wireMeter('regPassword', 'pwMeter');
  wireMeter('newPassword', 'newPwMeter');

  $$('input[type="email"]').forEach((input) => {
    input.addEventListener('blur', () => { input.value = input.value.trim().toLowerCase(); });
  });

  window.addEventListener('popstate', () => showView(resolveInitialView(), { push: false }));

  // If a session already exists, skip straight to the dashboard.
  (async function guard() {
    const view = resolveInitialView();
    showView(view, { push: false });
    if (view !== 'login' && view !== 'register') return;
    try {
      const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
      if (res.ok) location.replace('/');
    } catch { /* offline: stay on the form */ }
  })();
})();
