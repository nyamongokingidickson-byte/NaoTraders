// Account flows for the serverless build: registration, login, logout and link-based
// password reset — all against Postgres, all async.
//
// Registration activates the account immediately (no emailed code); the password reset
// journey emails a single-use link carrying a reset ticket. Passwords are scrypt, sessions
// are sha-256 digests, and a completed reset invalidates every session for that user.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { renderResetEmail, sendMail } from '../email.js';
import { err, hashPassword, verifyPassword, validateEmail, validatePassword, validateName, sha256 } from '../password.js';
import * as store from './store.js';

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

// ---------------------------------------------------------------- reset link mail
async function sendResetMail({ email, name, link, expiresAt }) {
  const minutes = Math.max(1, Math.round((expiresAt - store.now()) / 60000));
  const mail = renderResetEmail({ name, link, expiresMinutes: minutes });
  return sendMail({ to: email, subject: 'Reset your NovaTrade KE password', html: mail.html, text: mail.text, tag: 'reset' });
}

// ---------------------------------------------------------------- registration
export async function register({ displayName, email, password, confirmPassword, ip = 'unknown' }) {
  const cleanEmail = validateEmail(email);
  const name = validateName(displayName);
  if (password !== confirmPassword) throw err('Passwords do not match.', 'PASSWORD_MISMATCH');
  validatePassword(password, cleanEmail);

  if (await store.findUserByEmail(cleanEmail)) {
    throw err('An account with this email already exists. Please log in instead.', 'ALREADY_REGISTERED', 409);
  }
  const rl = await limit(`register-ip:${ip}`, { limit: config.security.registerPerIp, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) throw tooMany(rl.retryAfterMs);

  const id = store.newId('usr');
  const row = await store.insertUser({
    id, email: cleanEmail, passwordHash: hashPassword(password), displayName: name,
    verified: true, lastLoginIp: ip,
  });
  await store.ensureAccounts(id);
  await store.audit(id, 'user.create', { email: cleanEmail, activation: 'immediate' });

  const token = crypto.randomBytes(32).toString('hex');
  const { expiresAt } = await store.createSession({ userId: id, tokenHash: sha256(token), ttlMs: config.session.ttlMs });
  await store.touchLogin(id, ip);
  return { token, expiresAt, user: store.publicUser({ ...row, last_login_at: store.now() }) };
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
  const generic = { message: 'If that email is registered, we have sent a password reset link. It expires in 30 minutes.' };
  let cleanEmail;
  try { cleanEmail = validateEmail(email); } catch { return generic; }

  const perEmail = await limit(`reset:${cleanEmail}`, { limit: config.security.resetRequestPerEmail, windowMs: config.security.loginWindowMs });
  const perIp = await limit(`reset-ip:${ip}`, { limit: config.security.resetRequestPerEmail * 4, windowMs: config.security.loginWindowMs });
  if (!perEmail.allowed || !perIp.allowed) return generic;

  const user = await store.findUserByEmail(cleanEmail);
  if (!user) return generic;

  try {
    const ticket = crypto.randomBytes(32).toString('hex');
    const { expiresAt } = await store.createResetTicket({
      tokenHash: sha256(ticket), userId: user.id, email: cleanEmail, ttlMs: config.reset.ticketTtlMs,
    });
    const link = `${config.appUrl}/reset-password?token=${ticket}`;
    const delivery = await sendResetMail({ email: cleanEmail, name: user.display_name, link, expiresAt });
    await store.audit(user.id, 'password.reset_requested', { transport: delivery.transport });
  } catch (e) {
    await store.audit(user.id, 'password.reset_send_failed', { error: e.message });
    console.error('[reset] send failed:', e.message);
  }
  return generic;
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
