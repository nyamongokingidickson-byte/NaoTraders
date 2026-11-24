// Node-style request handler shared by the Vercel function (deploy/api/[...path].js) and the
// local harness in tests, so what I test is exactly what gets deployed.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { emailStatus } from '../email.js';
import * as accounts from './auth.js';
import * as store from './store.js';
import { ledgerIntegrity } from './store.js';
import { pgHealth } from '../pg.js';

const ROUTES = [];
const route = (method, path, fn) => ROUTES.push({ method, path, fn });

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(payload);
}
const ok = (res, obj = {}) => send(res, 200, { ok: true, ...obj });

function fail(res, err) {
  // Validation errors carry an explicit status; anything else is an internal fault.
  const status = err.status || (err.code ? 400 : 500);
  const body = { ok: false, error: err.message };
  if (err.code) body.code = err.code;
  if (err.retryAfterMs) body.retryAfterMs = err.retryAfterMs;
  if (err.attemptsLeft !== undefined) body.attemptsLeft = err.attemptsLeft;
  send(res, status, body, err.retryAfterMs ? { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) } : {});
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;   // Vercel pre-parses JSON
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

function cookieHeader(token, req) {
  const maxAge = Math.floor(config.session.ttlMs / 1000);
  const secure = req.headers['x-forwarded-proto'] === 'https' || config.security.forceSecureCookie || config.env === 'production';
  return `${config.session.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
const clearCookie = () => `${config.session.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

const sessionOf = (req) => accounts.sessionForToken(parseCookies(req)[config.session.cookieName]);
const requireUser = async (req) => {
  const user = await sessionOf(req);
  if (!user) throw Object.assign(new Error('not authenticated'), { status: 401, code: 'NOT_AUTHENTICATED' });
  return user;
};
const accountInfo = (user) => ({
  accountNumber: `NT-${user.id.replace(/^usr_/, '').slice(0, 8).toUpperCase()}`,
  currency: 'USD', role: user.role, status: user.status,
  emailVerified: user.emailVerified, memberSince: user.createdAt, lastLoginAt: user.lastLoginAt,
});

// ---------------------------------------------------------------- health
route('GET', '/healthz', async (req, res) => {
  const [pg, integrity] = await Promise.all([pgHealth(), ledgerIntegrity()]);
  send(res, integrity.ok ? 200 : 503, {
    ok: integrity.ok, runtime: 'vercel-serverless', db: pg,
    email: emailStatus().transport,
    gates: { mode: config.gates.mode, realMoneyEnabled: config.gates.realMoneyEnabled },
    ledger: integrity,
  });
});

// ---------------------------------------------------------------- auth
route('POST', '/api/auth/register', async (req, res) => {
  const body = await readBody(req);
  const { token, user, expiresAt } = await accounts.register({ ...body, ip: clientIp(req) });
  send(res, 201, { ok: true, user, wallet: await store.walletFor(user.id), accounts: accountInfo(user), expiresAt },
    { 'set-cookie': cookieHeader(token, req) });
});

route('POST', '/api/auth/login', async (req, res) => {
  const body = await readBody(req);
  const { token, user } = await accounts.login({ email: body.email, password: body.password, ip: clientIp(req) });
  send(res, 200, { ok: true, user, wallet: await store.walletFor(user.id), accounts: accountInfo(user) },
    { 'set-cookie': cookieHeader(token, req) });
});

route('POST', '/api/auth/logout', async (req, res) => {
  await accounts.logout(parseCookies(req)[config.session.cookieName]);
  send(res, 200, { ok: true }, { 'set-cookie': clearCookie() });
});

route('POST', '/api/auth/logout-all', async (req, res) => {
  const user = await requireUser(req);
  const count = await accounts.logoutAll(user.id);
  send(res, 200, { ok: true, sessionsInvalidated: count }, { 'set-cookie': clearCookie() });
});

route('POST', '/api/auth/forgot-password', async (req, res) => {
  const body = await readBody(req);
  ok(res, await accounts.requestPasswordReset({ email: body.email, ip: clientIp(req) }));
});

route('POST', '/api/auth/reset/complete', async (req, res) => {
  const body = await readBody(req);
  const result = await accounts.completePasswordReset({ ticket: body.ticket, password: body.password, confirmPassword: body.confirmPassword });
  send(res, 200, { ok: true, ...result, message: 'Password updated. Please sign in with your new password.' }, { 'set-cookie': clearCookie() });
});

route('GET', '/api/auth/session', async (req, res) => {
  const user = await sessionOf(req);
  if (!user) return send(res, 401, { ok: false, error: 'not authenticated', code: 'NOT_AUTHENTICATED' });
  ok(res, { user, wallet: await store.walletFor(user.id), accounts: accountInfo(user), cashier: { mode: config.gates.mode } });
});
route('GET', '/api/me', (req, res) => ROUTES.find((r) => r.path === '/api/auth/session').fn(req, res));

// ---------------------------------------------------------------- wallet
route('GET', '/api/wallet', async (req, res) => {
  const user = await requireUser(req);
  ok(res, { wallet: await store.walletFor(user.id) });
});

// Trading endpoints live on the market-data service during the migration; be explicit rather
// than returning an empty array that looks like "no trades".
route('GET', '/api/markets', async (req, res) =>
  send(res, 503, { ok: false, code: 'FEED_UNAVAILABLE', error: 'Live market data is served by the trading service; this serverless deployment handles accounts and wallets only.' }));

// ---------------------------------------------------------------- dispatch
export async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': req.headers.origin || '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  const hit = ROUTES.find((r) => r.method === req.method && r.path === url.pathname);
  if (!hit) return send(res, 404, { ok: false, error: 'not found', code: 'NOT_FOUND' });

  try {
    await hit.fn(req, res);
  } catch (err) {
    if (!err.status || err.status >= 500) console.error('[api]', url.pathname, err.code || '', err.message);
    fail(res, err);
  }
}

export { store };
export const __routes = ROUTES;
export const __randomId = () => crypto.randomUUID();
