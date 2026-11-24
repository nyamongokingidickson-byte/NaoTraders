// Account UI: login, registration with emailed OTP, password reset with OTP.
// All validation is mirrored server-side — nothing here is trusted.
(() => {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  const PATHS = {
    login: '/login',
    register: '/register',
    verify: '/verify-email',
    forgot: '/forgot-password',
    'reset-code': '/reset-password',
    'reset-password': '/reset-password',
    done: '/login',
  };
  const FROM_PATH = {
    '/login': 'login', '/register': 'register', '/verify-email': 'verify',
    '/forgot-password': 'forgot', '/reset-password': 'reset-flow', '/auth': 'login',
  };

  const store = {
    get: (k) => { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
    del: (k) => { try { sessionStorage.removeItem(k); } catch {} },
  };

  let currentView = 'login';
  let resendTimer = null;

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
    if (push && PATHS[name]) {
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
    login: 'Sign in', register: 'Create account', verify: 'Verify email',
    forgot: 'Reset password', 'reset-code': 'Enter reset code', 'reset-password': 'New password', done: 'Done',
  }[v] || 'Account');

  function resolveInitialView() {
    const base = FROM_PATH[location.pathname.replace(/\/$/, '') || '/login'] || 'login';
    if (base === 'reset-flow') {
      if (store.get('nt_reset_ticket')) return 'reset-password';
      if (store.get('nt_reset_email')) return 'reset-code';
      return 'forgot';
    }
    if (base === 'verify' && !store.get('nt_reg_email')) return 'register';
    return base;
  }

  // ---------------------------------------------------------------- resend cooldown
  function startResend(button, timerEl, seconds, onExpire) {
    clearInterval(resendTimer);
    let left = Math.max(0, Math.ceil(seconds));
    const label = button.dataset.label || button.textContent.replace(/\s*\(\d+s\)$/, '');
    button.dataset.label = label;
    if (left <= 0) {
      button.disabled = false;
      if (timerEl) timerEl.textContent = '';
      return;
    }
    button.disabled = true;
    if (timerEl) timerEl.textContent = ` (${left}s)`;
    resendTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(resendTimer);
        button.disabled = false;
        if (timerEl) timerEl.textContent = '';
        onExpire?.();
      } else if (timerEl) timerEl.textContent = ` (${left}s)`;
    }, 1000);
  }

  function showDevHint(el, transport) {
    if (!el) return;
    if (transport !== 'console') { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = 'Development mode: no mail server is configured, so the message is written to the server outbox. ' +
      '<a href="/api/dev/outbox" target="_blank" rel="noopener">View outbox</a>';
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

  // ---------------------------------------------------------------- OTP input hygiene
  $$('.otp').forEach((input) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 6);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.closest('form')?.requestSubmit();
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
      const data = await api('/api/auth/login', { email, password });
      store.del('nt_reg_email'); store.del('nt_reset_email'); store.del('nt_reset_ticket');
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
      } else if (err.code === 'ACCOUNT_UNVERIFIED') {
        store.set('nt_reg_email', email);
        setAlert('That account is not verified yet. Check your email for the 6-digit code.', 'info');
        setTimeout(() => showView('verify'), 900);
      } else if (err.code === 'RATE_LIMITED') {
        setAlert(err.message);
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
    setBusy(btn, true, 'Sending code…');
    try {
      const data = await api('/api/auth/register', { displayName, email, password, confirmPassword });
      store.set('nt_reg_email', data.email || email);
      setBusy(btn, false);
      $('#verifyEmail').textContent = store.get('nt_reg_email');
      $('#verifyCode').value = '';
      showView('verify');
      setAlert('We sent a 6-digit code to your email. It expires in 5 minutes.', 'ok');
      startResend($('#resendBtn'), $('#resendTimer'), Math.ceil((data.resendAfterMs || 60000) / 1000));
      showDevHint($('#devOutboxHint'), data.transport);
      setTimeout(() => $('#verifyCode').focus(), 120);
    } catch (err) {
      setBusy(btn, false);
      if (err.code === 'ALREADY_REGISTERED') {
        fieldError('email', 'That email is already registered.');
        setAlert('An account with this email already exists. <a href="/login">Sign in instead</a> — or reset your password if you have forgotten it.', 'err');
      } else if (err.code === 'WEAK_PASSWORD') { fieldError('password', err.message); setAlert(err.message); }
      else if (err.code === 'PASSWORD_MISMATCH') { fieldError('confirmPassword', err.message); setAlert(err.message); }
      else if (err.code === 'INVALID_NAME') { fieldError('displayName', err.message); setAlert(err.message); }
      else if (err.code === 'INVALID_EMAIL') { fieldError('email', err.message); setAlert(err.message); }
      else setAlert(err.message);
    }
  });

  // ---------------------------------------------------------------- VERIFY (register)
  $('#verifyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert(); clearFieldErrors();
    const email = store.get('nt_reg_email');
    const code = $('#verifyCode').value.trim();
    if (!email) { setAlert('Start again — we lost track of that email.'); return showView('register'); }
    if (code.length !== 6) return fieldError('code', 'Enter the 6-digit code.');

    const btn = $('#verifySubmit');
    setBusy(btn, true, 'Verifying…');
    try {
      await api('/api/auth/register/verify', { email, code });
      store.del('nt_reg_email');
      setBusy(btn, false, 'Activated');
      $('#doneTitle').textContent = 'Account activated';
      $('#doneMessage').textContent = 'Your email is verified and your account is ready. Opening your dashboard…';
      $('#doneCta').textContent = 'Go to dashboard';
      showView('done');
      setTimeout(() => location.replace('/'), 900);
    } catch (err) {
      setBusy(btn, false);
      if (err.code === 'OTP_INVALID') fieldError('code', err.message);
      else if (err.code === 'OTP_EXPIRED' || err.code === 'OTP_ATTEMPTS_EXCEEDED' || err.code === 'OTP_NOT_FOUND') {
        fieldError('code', err.message);
        $('#resendBtn').disabled = false;
      } else if (err.code === 'OTP_COOLDOWN') { setAlert(err.message, 'info'); startResend($('#resendBtn'), $('#resendTimer'), Math.ceil((err.retryAfterMs || 60000) / 1000)); }
      setAlert(`${err.message}`, err.code === 'OTP_COOLDOWN' ? 'info' : 'err');
    }
  });

  $('#resendBtn').addEventListener('click', async () => {
    const email = store.get('nt_reg_email');
    if (!email) return showView('register');
    const btn = $('#resendBtn');
    setBusy(btn, true, 'Sending…');
    try {
      const data = await api('/api/auth/register/resend', { email });
      btn.dataset.label = 'Resend code';
      setBusy(btn, false);
      setAlert('A new code is on its way. The previous code no longer works.', 'ok');
      startResend(btn, $('#resendTimer'), Math.ceil((data.resendAfterMs || 60000) / 1000));
      showDevHint($('#devOutboxHint'), data.transport);
    } catch (err) {
      setBusy(btn, false);
      if (err.code === 'OTP_COOLDOWN') {
        startResend(btn, $('#resendTimer'), Math.ceil((err.retryAfterMs || 60000) / 1000));
        setAlert(err.message, 'info');
      } else if (err.code === 'NO_PENDING_REGISTRATION') {
        setAlert('That registration expired. Please sign up again.', 'err');
        setTimeout(() => showView('register'), 1200);
      } else setAlert(err.message);
    }
  });

  $('#changeEmail').addEventListener('click', (e) => {
    e.preventDefault();
    store.del('nt_reg_email');
    showView('register');
  });

  // ---------------------------------------------------------------- FORGOT
  $('#forgotForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert(); clearFieldErrors();
    const email = $('#forgotEmail').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return fieldError('email', 'Enter the email on your account.');

    const btn = $('#forgotSubmit');
    setBusy(btn, true, 'Sending…');
    try {
      const data = await api('/api/auth/forgot-password', { email });
      store.set('nt_reset_email', email);
      store.del('nt_reset_ticket');
      setBusy(btn, false);
      $('#resetEmail').textContent = email;
      $('#resetCode').value = '';
      showView('reset-code');
      setAlert(data.message || 'If that email is registered, we sent a 6-digit code.', 'info');
      startResend($('#resetResendBtn'), $('#resetResendTimer'), 60);
      setTimeout(() => $('#resetCode').focus(), 120);
    } catch (err) {
      setBusy(btn, false);
      setAlert(err.message);
    }
  });

  // ---------------------------------------------------------------- RESET: verify code
  $('#resetCodeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert(); clearFieldErrors();
    const email = store.get('nt_reset_email');
    const code = $('#resetCode').value.trim();
    if (!email) return showView('forgot');
    if (code.length !== 6) return fieldError('code', 'Enter the 6-digit code.');

    const btn = $('#resetCodeSubmit');
    setBusy(btn, true, 'Checking…');
    try {
      const data = await api('/api/auth/reset/verify', { email, code });
      store.set('nt_reset_ticket', data.ticket);
      setBusy(btn, false);
      showView('reset-password');
      setAlert('Code verified. Choose a new password below.', 'ok');
    } catch (err) {
      setBusy(btn, false);
      fieldError('code', err.message);
      if (err.code === 'OTP_EXPIRED' || err.code === 'OTP_ATTEMPTS_EXCEEDED' || err.code === 'OTP_NOT_FOUND') $('#resetResendBtn').disabled = false;
      setAlert(err.message, err.code === 'OTP_COOLDOWN' ? 'info' : 'err');
    }
  });

  $('#resetResendBtn').addEventListener('click', async () => {
    const email = store.get('nt_reset_email');
    if (!email) return showView('forgot');
    const btn = $('#resetResendBtn');
    setBusy(btn, true, 'Sending…');
    try {
      const data = await api('/api/auth/forgot-password', { email });
      btn.dataset.label = 'Resend code';
      setBusy(btn, false);
      setAlert(data.message || 'If that email is registered, we sent a new code.', 'info');
      startResend(btn, $('#resetResendTimer'), 60);
      showDevHint($('#resetDevHint'), 'console');
    } catch (err) {
      setBusy(btn, false);
      setAlert(err.message);
    }
  });

  // ---------------------------------------------------------------- RESET: new password
  $('#newPasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert(); clearFieldErrors();
    const ticket = store.get('nt_reset_ticket');
    const password = $('#newPassword').value;
    const confirmPassword = $('#newConfirm').value;
    if (!ticket) { setAlert('Your reset session expired. Please request a new code.', 'err'); return showView('forgot'); }

    let bad = false;
    if (password.length < 8) { fieldError('password', 'Password must be at least 8 characters.'); bad = true; }
    else if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) { fieldError('password', 'Include at least one letter and one number.'); bad = true; }
    if (password !== confirmPassword) { fieldError('confirmPassword', 'Passwords do not match.'); bad = true; }
    if (bad) return;

    const btn = $('#newPasswordSubmit');
    setBusy(btn, true, 'Updating…');
    try {
      const data = await api('/api/auth/reset/complete', { ticket, password, confirmPassword });
      store.del('nt_reset_ticket'); store.del('nt_reset_email');
      setBusy(btn, false);
      $('#doneTitle').textContent = 'Password updated';
      $('#doneMessage').textContent = data.message || 'Your password has been changed and all devices were signed out.';
      $('#doneCta').textContent = 'Sign in with your new password';
      showView('done');
    } catch (err) {
      setBusy(btn, false);
      if (err.code === 'WEAK_PASSWORD') fieldError('password', err.message);
      else if (err.code === 'PASSWORD_MISMATCH') fieldError('confirmPassword', err.message);
      else if (err.code === 'PASSWORD_UNCHANGED') fieldError('password', err.message);
      if (err.code === 'RESET_TICKET_USED' || err.code === 'RESET_TICKET_EXPIRED' || err.code === 'RESET_TICKET_INVALID') {
        store.del('nt_reset_ticket'); store.del('nt_reset_email');
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
