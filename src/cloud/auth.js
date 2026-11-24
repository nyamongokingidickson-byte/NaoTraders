// Account flows for the serverless build: registration with emailed OTP, login, logout and
// OTP-verified password reset — all against Postgres, all async.
//
// Same rules as the SQLite build (src/auth.js): scrypt passwords, single-use hashed OTPs with
// a 5-minute TTL, attempt and resend limits, sha-256 session digests, reset invalidates every
// session. Phase 2 replaces src/auth.js with this module and deletes the duplicate.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { renderOtpEmail, sendMail } from '../email.js';
import { err, hashPassword, verifyPassword, validateEmail, validatePassword, validateName, sha256 } from '../password.js';
import * as store from './store.js';

const SCRYPT_OTP = { N: 16384, r: 8, p: 1, keylen: 32 };

const hashOtp = (code, salt) => {
  const key = crypto.scryptSync(String(code), salt, SCRYPT_OTP.keylen, { N: SCRYPT_OTP.N, r: SCRYPT_OTP.r, p: SCRYPT_OTP.p });
  return `scrypt$${SCRYPT_OTP.N}$${salt}$${key.toString('hex')}`;
};

const checkOtpHash = (code, stored) => {
  try {
    const [, N, salt, hash] = String(stored).split('$');
    const key = crypto.scryptSync(String(code), salt, SCRYPT_OTP.keylen, { N: Number(N), r: SCRYPT_OTP.r, p: SCRYPT_OTP.p });
    const a = Buffer.from(hash, 'hex');
    return a.length === key.length && crypto.timingSafeEqual(a, key);
  } catch { return false; }
};

const generateCode = () => String(crypto.randomInt(0, 10 ** config.otp.length)).padStart(config.otp.length, '0');

const tooMany = (retryAfterMs) => {
  const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return err(`Too many attempts. Please wait ${secs} second${secs === 1 ? '' : 's'} and try again.`, 'RATE_LIMITED', 429, { retryAfterMs });
};

/** Sliding-window limiter. Records the attempt first so concurrent requests cannot race past it. */
async function limit(key, { limit: max, windowMs }) {
  await store.recordRateEvent(key);
  const win = await store.rateWindow(key, windowMs);
  const allowed = win.count <= max;
  return {
    allowed,
    used: win.count,
    limit: max,
    retryAfterMs: allowed ? 0 : Math.max(1000, (win.oldest ?? store.now()) + windowMs - store.now()),
  };
}

// ---------------------------------------------------------------- OTP
async function issueOtp({ email, purpose }) {
  const active = await store.activeOtp(email, purpose);
  if (active) {
    const wait = config.otp.resendCooldownMs - (store.now() - Number(active.last_sent_at));
    if (wait > 0) throw err(`Please wait ${Math.ceil(wait / 1000)}s before requesting another code.`, 'OTP_COOLDOWN', 429, { retryAfterMs: wait });
  }
  const sends = (await store.previousSendCount(email, purpose)) + 1;
  if (sends > config.otp.maxSends) throw err('Too many codes requested for this address. Please try again later.', 'OTP_TOO_MANY_SENDS', 429);

  const code = generateCode();
  const salt = crypto.randomBytes(16).toString('hex');
  const { expiresAt } = await store.replaceOtp({
    id: store.newId('otp'), email, purpose, codeHash: hashOtp(code, salt),
    maxAttempts: config.otp.maxAttempts, sends, ttlMs: config.otp.ttlMs,
  });
  return { code, expiresAt, resendAfterMs: config.otp.resendCooldownMs };
}

async function verifyOtp({ email, purpose, code }) {
  const row = await store.activeOtp(email, purpose);
  if (!row) throw err('No active code for this email. Please request a new one.', 'OTP_NOT_FOUND');

  if (Number(row.expires_at) <= store.now()) {
    await store.consumeOtp(row.id);
    throw err('That code has expired. Please request a new one.', 'OTP_EXPIRED');
  }
  if (row.attempts >= row.max_attempts) {
    await store.consumeOtp(row.id);
    throw err('Too many incorrect attempts. Please request a new code.', 'OTP_ATTEMPTS_EXCEEDED', 429);
  }
  if (!/^\d+$/.test(String(code || '')) || !checkOtpHash(code, row.code_hash)) {
    const attempts = row.attempts + 1;
    const exhausted = attempts >= row.max_attempts;
    await store.recordOtpFailure(row.id, attempts, exhausted);
    throw err(
      exhausted ? 'Too many incorrect attempts. Please request a new code.'
        : `Incorrect code. ${row.max_attempts - attempts} attempt${row.max_attempts - attempts === 1 ? '' : 's'} remaining.`,
      exhausted ? 'OTP_ATTEMPTS_EXCEEDED' : 'OTP_INVALID', 400, { attemptsLeft: row.max_attempts - attempts },
    );
  }
  await store.consumeOtp(row.id);
  return row;
}

async function sendOtpMail({ email, purpose, name, code, expiresAt }) {
  const minutes = Math.max(1, Math.round((expiresAt - store.now()) / 60000));
  const mail = renderOtpEmail({ purpose, code, name, expiresMinutes: minutes });
  const subject = purpose === 'reset' ? 'Your NovaTrade KE password reset code' : 'Your NovaTrade KE verification code';
  return sendMail({ to: email, subject, html: mail.html, text: mail.text, tag: purpose });
}

// ---------------------------------------------------------------- registration
export async function registerStart({ displayName, email, password, confirmPassword, ip = 'unknown' }) {
  const cleanEmail = validateEmail(email);
  const name = validateName(displayName);
  if (password !== confirmPassword) throw err('Passwords do not match.', 'PASSWORD_MISMATCH');
  validatePassword(password, cleanEmail);

  if (await store.findUserByEmail(cleanEmail)) {
    throw err('An account with this email already exists. Please log in instead.', 'ALREADY_REGISTERED', 409);
  }
  const rl = await limit(`register-ip:${ip}`, { limit: config.security.registerPerIp, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) throw tooMany(rl.retryAfterMs);

  await store.upsertPending({ email: cleanEmail, passwordHash: hashPassword(password), displayName: name });
  const otp = await issueOtp({ email: cleanEmail, purpose: 'register' });
  const delivery = await sendOtpMail({ email: cleanEmail, purpose: 'register', name, code: otp.code, expiresAt: otp.expiresAt });
  await store.audit(null, 'register.otp_sent', { email: cleanEmail, transport: delivery.transport });

  return { email: cleanEmail, expiresInMs: otp.expiresAt - store.now(), resendAfterMs: otp.resendAfterMs, transport: delivery.transport };
}

export async function registerResend({ email }) {
  const cleanEmail = validateEmail(email);
  const pending = await store.getPending(cleanEmail);
  if (!pending) throw err('No pending registration for this email. Please register again.', 'NO_PENDING_REGISTRATION', 404);

  const otp = await issueOtp({ email: cleanEmail, purpose: 'register' });
  const delivery = await sendOtpMail({ email: cleanEmail, purpose: 'register', name: pending.display_name, code: otp.code, expiresAt: otp.expiresAt });
  await store.audit(null, 'register.otp_resent', { email: cleanEmail });
  return { email: cleanEmail, expiresInMs: otp.expiresAt - store.now(), resendAfterMs: otp.resendAfterMs, transport: delivery.transport };
}

export async function registerVerify({ email, code, ip = 'unknown' }) {
  const cleanEmail = validateEmail(email);
  const pending = await store.getPending(cleanEmail);
  if (!pending) throw err('No pending registration for this email. Please register again.', 'NO_PENDING_REGISTRATION', 404);

  await verifyOtp({ email: cleanEmail, purpose: 'register', code });

  const id = store.newId('usr');
  const row = await store.insertUser({
    id, email: cleanEmail, passwordHash: pending.password_hash,
    displayName: pending.display_name, verified: true, lastLoginIp: ip,
  });
  await store.deletePending(cleanEmail);
  await store.ensureAccounts(id);
  await store.audit(id, 'user.create', { email: cleanEmail, verified: true });

  const token = crypto.randomBytes(32).toString('hex');
  const { expiresAt } = await store.createSession({ userId: id, tokenHash: sha256(token), ttlMs: config.session.ttlMs });
  return { token, expiresAt, user: store.publicUser(row) };
}

// ---------------------------------------------------------------- login
export async function login({ email, password, ip = 'unknown' }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !password) throw err('Please enter your email and password.', 'MISSING_CREDENTIALS');

  const perEmail = await limit(`login:${cleanEmail}`, { limit: config.security.loginAttemptsPerEmail, windowMs: config.security.loginWindowMs });
  if (!perEmail.allowed) throw tooMany(perEmail.retryAfterMs);
  const perIp = await limit(`login-ip:${ip}`, { limit: config.security.loginAttemptsPerEmail * 3, windowMs: config.security.loginWindowMs });
  if (!perIp.allowed) throw tooMany(perIp.retryAfterMs);

  const row = await store.findUserByEmail(cleanEmail);
  if (!row) throw err('Account not found. Please register first.', 'ACCOUNT_NOT_FOUND', 404);
  if (!verifyPassword(password, row.password_hash)) {
    throw err('Incorrect password. Please try again.', 'INVALID_PASSWORD', 401, { attemptsLeft: Math.max(0, perEmail.limit - perEmail.used) });
  }
  if (row.status !== 'active') throw err('This account is suspended. Please contact support.', 'ACCOUNT_SUSPENDED', 403);
  if (!row.email_verified) throw err('Please verify your email address before logging in.', 'ACCOUNT_UNVERIFIED', 403);

  const token = crypto.randomBytes(32).toString('hex');
  const { expiresAt } = await store.createSession({ userId: row.id, tokenHash: sha256(token), ttlMs: config.session.ttlMs });
  await store.touchLogin(row.id, ip);
  await store.audit(row.id, 'user.login', { ip });
  return { token, expiresAt, user: store.publicUser({ ...row, last_login_at: store.now() }) };
}

export async function sessionForToken(token) {
  if (!token) return null;
  const row = await store.sessionUser(sha256(token));
  return row ? store.publicUser(row) : null;
}

export async function logout(token) {
  if (token) await store.deleteSession(sha256(token));
}

export async function logoutAll(userId) {
  return store.deleteUserSessions(userId);
}

// ---------------------------------------------------------------- password reset
export async function requestPasswordReset({ email, ip = 'unknown' }) {
  const generic = { message: 'If that email is registered, we have sent a 6-digit code. It expires in 5 minutes.' };
  let cleanEmail;
  try { cleanEmail = validateEmail(email); } catch { return generic; }

  const perEmail = await limit(`reset:${cleanEmail}`, { limit: config.security.resetRequestPerEmail, windowMs: config.security.loginWindowMs });
  const perIp = await limit(`reset-ip:${ip}`, { limit: config.security.resetRequestPerEmail * 4, windowMs: config.security.loginWindowMs });
  if (!perEmail.allowed || !perIp.allowed) return generic;

  const user = await store.findUserByEmail(cleanEmail);
  if (!user) return generic;

  try {
    const otp = await issueOtp({ email: cleanEmail, purpose: 'reset' });
    const delivery = await sendOtpMail({ email: cleanEmail, purpose: 'reset', name: user.display_name, code: otp.code, expiresAt: otp.expiresAt });
    await store.audit(user.id, 'password.reset_requested', { transport: delivery.transport });
  } catch (e) {
    await store.audit(user.id, 'password.reset_send_failed', { error: e.message });
    console.error('[reset] send failed:', e.message);
  }
  return generic;
}

export async function verifyResetCode({ email, code }) {
  const cleanEmail = validateEmail(email);
  const user = await store.findUserByEmail(cleanEmail);
  if (!user) throw err('That code is not valid. Please request a new one.', 'OTP_NOT_FOUND');

  await verifyOtp({ email: cleanEmail, purpose: 'reset', code });

  const ticket = crypto.randomBytes(32).toString('hex');
  const { expiresAt } = await store.createResetTicket({ tokenHash: sha256(ticket), userId: user.id, email: cleanEmail, ttlMs: config.otp.resetTicketTtlMs });
  await store.audit(user.id, 'password.reset_verified', null);
  return { ticket, email: cleanEmail, expiresInMs: expiresAt - store.now() };
}

export async function completePasswordReset({ ticket, password, confirmPassword }) {
  if (!ticket) throw err('Your reset session expired. Please start again.', 'RESET_TICKET_INVALID');
  const row = await store.getResetTicket(sha256(ticket));
  if (!row || row.used_at) throw err('This reset link has already been used. Please start again.', 'RESET_TICKET_USED');
  if (Number(row.expires_at) <= store.now()) throw err('Your reset session expired. Please start again.', 'RESET_TICKET_EXPIRED');

  const user = await store.findUserById(row.user_id);
  if (!user) throw err('Account not found.', 'ACCOUNT_NOT_FOUND', 404);
  if (password !== confirmPassword) throw err('Passwords do not match.', 'PASSWORD_MISMATCH');
  validatePassword(password, row.email);
  if (verifyPassword(password, user.password_hash)) throw err('Your new password must be different from your current password.', 'PASSWORD_UNCHANGED');

  await store.setPassword(user.id, hashPassword(password));
  await store.consumeResetTicket(row.token_hash);
  const invalidated = await store.deleteUserSessions(user.id);
  await store.audit(user.id, 'password.reset_completed', { sessionsInvalidated: invalidated });

  return { email: row.email, sessionsInvalidated: invalidated };
}
