// Async data access for the serverless (Postgres) build. Every function is a thin, explicit
// query — no ORM — so the SQL in db/schema.postgres.sql stays the single source of truth.
import crypto from 'node:crypto';
import { one, many, tx } from '../pg.js';

export const now = () => Date.now();
export const newId = (prefix) => `${prefix}_${crypto.randomUUID()}`;

// ---------------------------------------------------------------- accounts / ledger
// The platform's own accounts and each customer's three wallets have to exist before any money can
// move. Both are idempotent in SQL, but issuing them as a round trip per account made every request
// that touches money wait on a dozen remote queries (6s for one trade against a hosted Postgres).
// They are therefore remembered per process: one platform pass, one pass per customer.
let platformAccounts = null;
const customerAccounts = new Set();
const PLATFORM_ACCOUNTS = [
  ['deposit_clearing', 'Cashier deposits in transit', 'asset'],
  ['withdrawal_clearing', 'Cashier withdrawals out', 'asset'],
  ['escrow', 'Customer stakes in play', 'liability'],
  ['platform_revenue', 'Platform trading revenue', 'revenue'],
  ['house_capital', 'House capital', 'equity'],
  // Counterparty for virtual demo credits, so demo funding stays a balanced journal entry.
  ['demo_house', 'Demo funds issuer (virtual)', 'equity'],
];

async function insertPlatformAccounts() {
  const t = now();
  await tx(async (c) => {
    for (const [code, name, type] of PLATFORM_ACCOUNTS) {
      await c.query('INSERT INTO accounts(code,name,type,created_at) VALUES($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING', [code, name, type, t]);
    }
  });
}

export async function ensureAccounts(userId) {
  if (!platformAccounts) {
    platformAccounts = insertPlatformAccounts().catch((err) => { platformAccounts = null; throw err; });
  }
  await platformAccounts;
  if (!userId || customerAccounts.has(userId)) return;
  const t = now();
  await tx(async (c) => {
    await c.query('INSERT INTO accounts(code,name,type,owner_user_id,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT (code) DO NOTHING',
      [`customer:${userId}`, `Customer wallet ${userId}`, 'liability', userId, t]);
    await c.query('INSERT INTO accounts(code,name,type,owner_user_id,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT (code) DO NOTHING',
      [`hold:${userId}`, `Customer withdrawal holds ${userId}`, 'liability', userId, t]);
    await c.query('INSERT INTO accounts(code,name,type,owner_user_id,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT (code) DO NOTHING',
      [`demo:${userId}`, `Demo wallet ${userId} (virtual)`, 'liability', userId, t]);
  });
  customerAccounts.add(userId);
}

/**
 * Credit a new account with its starting demo funds. Virtual money, but recorded properly:
 * a single journal entry that debits the demo issuer and credits the demo wallet, so the
 * ledger stays balanced and the number on screen is derived, never stored or made up.
 * Idempotent — keyed on the transaction ref, so repeat calls cannot double-credit.
 */
const seededDemo = new Set();
export async function seedDemoFunds(userId, cents) {
  if (!Number.isInteger(cents) || cents <= 0) return { credited: false, cents: 0 };
  if (seededDemo.has(userId)) return { credited: false, cents: 0 };
  const ref = `demo-seed:${userId}`;
  const existing = await one('SELECT id FROM txns WHERE ref=$1 LIMIT 1', [ref]);
  if (existing) { seededDemo.add(userId); return { credited: false, cents: 0 }; }

  const txnId = newId('txn');
  const t = now();
  await tx(async (c) => {
    await c.query('INSERT INTO txns(id,kind,ref,memo,created_at) VALUES($1,$2,$3,$4,$5)',
      [txnId, 'demo_seed', ref, 'Starting demo (virtual) funds', t]);
    await c.query('INSERT INTO entries(txn_id,account_code,amount,created_at) VALUES($1,$2,$3,$4)', [txnId, `demo:${userId}`, cents, t]);
    await c.query('INSERT INTO entries(txn_id,account_code,amount,created_at) VALUES($1,$2,$3,$4)', [txnId, 'demo_house', -cents, t]);
  });
  seededDemo.add(userId);
  return { credited: true, cents };
}

/** Accounts, demo wallet ensured and demo funds seeded once. Safe to call on every request. */
export async function ensureWallets(userId, demoStartingCents) {
  await ensureAccounts(userId);
  return seedDemoFunds(userId, demoStartingCents);
}

/** Balances are derived from the journal, never stored. */
export async function walletFor(userId) {
  const codes = [`customer:${userId}`, `hold:${userId}`, `demo:${userId}`];
  const rows = await many(`
    SELECT account_code, COALESCE(SUM(amount),0)::bigint AS balance
    FROM entries WHERE account_code = ANY($1) GROUP BY account_code`, [codes]);
  const sum = (code) => Number(rows.find((r) => r.account_code === code)?.balance ?? 0) || 0;

  const available = sum(`customer:${userId}`);
  const held = sum(`hold:${userId}`);
  const demo = sum(`demo:${userId}`);

  return {
    currency: 'USD',
    // Real wallet: funded only by cashier activity, which is disabled on this platform.
    real: { availableCents: available, heldCents: held, totalCents: available + held },
    // Demo wallet: virtual funds issued at signup, spendable in the demo platform only.
    demo: { availableCents: demo, heldCents: 0, totalCents: demo, virtual: true },
    // Backwards-compatible flat fields (the real wallet).
    userId, availableCents: available, heldCents: held, totalCents: available + held,
  };
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
