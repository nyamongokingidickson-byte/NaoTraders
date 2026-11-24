// Async data access for the serverless (Postgres) build. Every function is a thin, explicit
// query — no ORM — so the SQL in db/schema.postgres.sql stays the single source of truth.
import crypto from 'node:crypto';
import { one, many, tx } from '../pg.js';

export const now = () => Date.now();
export const newId = (prefix) => `${prefix}_${crypto.randomUUID()}`;

// ---------------------------------------------------------------- accounts / ledger
export async function ensureAccounts(userId) {
  const t = now();
  const platform = [
    ['deposit_clearing', 'Cashier deposits in transit', 'asset'],
    ['withdrawal_clearing', 'Cashier withdrawals out', 'asset'],
    ['escrow', 'Customer stakes in play', 'liability'],
    ['platform_revenue', 'Platform trading revenue', 'revenue'],
    ['house_capital', 'House capital', 'equity'],
  ];
  await tx(async (c) => {
    for (const [code, name, type] of platform) {
      await c.query('INSERT INTO accounts(code,name,type,created_at) VALUES($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING', [code, name, type, t]);
    }
    if (userId) {
      await c.query('INSERT INTO accounts(code,name,type,owner_user_id,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT (code) DO NOTHING',
        [`customer:${userId}`, `Customer wallet ${userId}`, 'liability', userId, t]);
      await c.query('INSERT INTO accounts(code,name,type,owner_user_id,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT (code) DO NOTHING',
        [`hold:${userId}`, `Customer withdrawal holds ${userId}`, 'liability', userId, t]);
    }
  });
}

/** Balances are derived from the journal, never stored. */
export async function walletFor(userId) {
  const rows = await many(`
    SELECT account_code, COALESCE(SUM(amount),0)::bigint AS balance
    FROM entries WHERE account_code IN ($1,$2) GROUP BY account_code`,
    [`customer:${userId}`, `hold:${userId}`]);
  const sum = (code) => Number(rows.find((r) => r.account_code === code)?.balance ?? 0) || 0;
  const available = sum(`customer:${userId}`);
  const held = sum(`hold:${userId}`);
  return { userId, availableCents: available, heldCents: held, totalCents: available + held, currency: 'USD' };
}

// ---------------------------------------------------------------- users
export async function findUserByEmail(email) {
  return one('SELECT * FROM users WHERE email=$1', [String(email || '').trim().toLowerCase()]);
}

export async function findUserById(id) {
  return one('SELECT * FROM users WHERE id=$1', [id]);
}

export async function insertUser({ id, email, passwordHash, displayName, role = 'customer', verified = true, lastLoginIp = null }) {
  const t = now();
  const rows = await many(`INSERT INTO users(id,email,password_hash,display_name,role,status,created_at,email_verified,last_login_at,last_login_ip)
    VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8,$9) RETURNING *`,
    [id, email, passwordHash, displayName, role, t, verified ? 1 : 0, verified ? t : null, lastLoginIp]);
  return rows[0];
}

export async function touchLogin(userId, ip) {
  await many('UPDATE users SET last_login_at=$1, last_login_ip=$2 WHERE id=$3', [now(), ip, userId]);
}

export async function setPassword(userId, passwordHash) {
  await many('UPDATE users SET password_hash=$1 WHERE id=$2', [passwordHash, userId]);
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    emailVerified: !!row.email_verified,
    createdAt: Number(row.created_at),
    lastLoginAt: row.last_login_at === null ? null : Number(row.last_login_at),
  };
}

// ---------------------------------------------------------------- sessions
export async function createSession({ userId, tokenHash, ttlMs }) {
  const t = now();
  await many('DELETE FROM sessions WHERE expires_at < $1', [t]);
  await many('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)', [tokenHash, userId, t, t + ttlMs]);
  return { expiresAt: t + ttlMs };
}

export async function sessionUser(tokenHash) {
  return one(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires_at > $2`, [tokenHash, now()]);
}

export async function deleteSession(tokenHash) {
  await many('DELETE FROM sessions WHERE token=$1', [tokenHash]);
}

export async function deleteUserSessions(userId) {
  const rows = await many('DELETE FROM sessions WHERE user_id=$1 RETURNING token', [userId]);
  return rows.length;
}

// ---------------------------------------------------------------- pending registrations
export async function upsertPending({ email, passwordHash, displayName }) {
  await many(`INSERT INTO pending_users(email,password_hash,display_name,created_at) VALUES($1,$2,$3,$4)
    ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, display_name=EXCLUDED.display_name, created_at=EXCLUDED.created_at`,
    [email, passwordHash, displayName, now()]);
}

export async function getPending(email) {
  return one('SELECT * FROM pending_users WHERE email=$1', [email]);
}

export async function deletePending(email) {
  await many('DELETE FROM pending_users WHERE email=$1', [email]);
}

// ---------------------------------------------------------------- email OTPs
export async function activeOtp(email, purpose) {
  return one(`SELECT * FROM email_otps WHERE email=$1 AND purpose=$2 AND consumed_at IS NULL
    ORDER BY created_at DESC LIMIT 1`, [email, purpose]);
}

export async function previousSendCount(email, purpose) {
  const row = await one('SELECT sends FROM email_otps WHERE email=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1', [email, purpose]);
  return row ? row.sends : 0;
}

export async function replaceOtp({ id, email, purpose, codeHash, maxAttempts, sends, ttlMs }) {
  const t = now();
  await tx(async (c) => {
    await c.query('UPDATE email_otps SET consumed_at=$1 WHERE email=$2 AND purpose=$3 AND consumed_at IS NULL', [t, email, purpose]);
    await c.query(`INSERT INTO email_otps(id,email,purpose,code_hash,attempts,max_attempts,sends,created_at,expires_at,last_sent_at)
      VALUES($1,$2,$3,$4,0,$5,$6,$7,$8,$7)`, [id, email, purpose, codeHash, maxAttempts, sends, t, t + ttlMs]);
  });
  return { expiresAt: t + ttlMs };
}

export async function consumeOtp(id) {
  await many('UPDATE email_otps SET consumed_at=$1 WHERE id=$2', [now(), id]);
}

export async function recordOtpFailure(id, attempts, exhausted) {
  await many('UPDATE email_otps SET attempts=$1, consumed_at=$2 WHERE id=$3', [attempts, exhausted ? now() : null, id]);
}

// ---------------------------------------------------------------- reset tickets
export async function createResetTicket({ tokenHash, userId, email, ttlMs }) {
  const t = now();
  await many('INSERT INTO reset_tickets(token_hash,user_id,email,created_at,expires_at) VALUES($1,$2,$3,$4,$5)',
    [tokenHash, userId, email, t, t + ttlMs]);
  return { expiresAt: t + ttlMs };
}

export async function getResetTicket(tokenHash) {
  return one('SELECT * FROM reset_tickets WHERE token_hash=$1', [tokenHash]);
}

export async function consumeResetTicket(tokenHash) {
  await many('UPDATE reset_tickets SET used_at=$1 WHERE token_hash=$2', [now(), tokenHash]);
}

// ---------------------------------------------------------------- rate limiting
export async function recordRateEvent(key) {
  const t = now();
  await many('INSERT INTO rate_events(key,ts) VALUES($1,$2)', [key, t]);
  return t;
}

export async function rateWindow(key, windowMs) {
  const since = now() - windowMs;
  const rows = await many('SELECT ts FROM rate_events WHERE key=$1 AND ts > $2 ORDER BY ts ASC', [key, since]);
  return { count: rows.length, oldest: rows.length ? Number(rows[0].ts) : null };
}

export async function pruneRateEvents() {
  await many('DELETE FROM rate_events WHERE ts < $1', [now() - 24 * 60 * 60 * 1000]);
}

// ---------------------------------------------------------------- audit
export async function audit(actorId, action, payload = null) {
  await many('INSERT INTO audit_log(actor_id,action,payload,created_at) VALUES($1,$2,$3,$4)',
    [actorId, action, payload ? JSON.stringify(payload) : null, now()]);
}

export async function ledgerIntegrity() {
  const unbalanced = await many('SELECT * FROM ledger_unbalanced');
  const orphan = await one(`SELECT COUNT(*)::int AS c FROM entries e LEFT JOIN accounts a ON a.code=e.account_code WHERE a.code IS NULL`);
  const global = await one('SELECT COALESCE(SUM(amount),0)::bigint AS s FROM entries');
  return { unbalancedTxns: unbalanced.length, orphanEntries: orphan.c, globalSum: Number(global.s), ok: unbalanced.length === 0 && orphan.c === 0 && Number(global.s) === 0 };
}
