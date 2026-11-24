// Node-style request handler shared by the Vercel function (deploy/api/[...path].js) and the
// local harness in tests, so what I test is exactly what gets deployed.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { emailStatus } from '../email.js';
import * as accounts from './auth.js';
import * as store from './store.js';
import * as feed from './feed.js';
import * as trading from './trading.js';
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
  const balances = await store.walletFor(user.id);
  send(res, 201, { ok: true, user, balances, wallet: balances.real, accounts: accountInfo(user), expiresAt },
    { 'set-cookie': cookieHeader(token, req) });
});

route('POST', '/api/auth/login', async (req, res) => {
  const body = await readBody(req);
  const { token, user } = await accounts.login({ email: body.email, password: body.password, ip: clientIp(req) });
  await store.ensureWallets(user.id, config.demo.startingBalanceCents);
  const balances = await store.walletFor(user.id);
  send(res, 200, { ok: true, user, balances, wallet: balances.real, accounts: accountInfo(user) },
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
  // Lazy: covers accounts created before demo wallets existed.
  await store.ensureWallets(user.id, config.demo.startingBalanceCents);
  ok(res, {
    user, accounts: accountInfo(user),
    balances: await store.walletFor(user.id),
    cashier: { mode: config.gates.mode, realMoneyEnabled: config.gates.realMoneyEnabled },
  });
});
route('GET', '/api/me', (req, res) => ROUTES.find((r) => r.path === '/api/auth/session').fn(req, res));

// ---------------------------------------------------------------- wallet
route('GET', '/api/wallet', async (req, res) => {
  const user = await requireUser(req);
  await store.ensureWallets(user.id, config.demo.startingBalanceCents);
  const balances = await store.walletFor(user.id);
  ok(res, { ...balances, wallet: balances.real, balances, realMoneyEnabled: config.gates.realMoneyEnabled });
});

// ---------------------------------------------------------------- market data
// Generated by src/cloud/feed.js: simulated, deterministic and identical on every instance.
// `source` and `disclaimer` travel with every payload so no client can mistake it for a real feed.
const feedMeta = () => ({ source: feed.SOURCE, disclaimer: feed.DISCLAIMER, serverTime: Date.now() });

route('GET', '/api/markets', async (req, res) =>
  ok(res, { ...feedMeta(), currency: 'USD', symbols: feed.symbolList() }));

route('GET', '/api/markets/:symbol', async (req, res) => {
  const market = feed.findMarket(req.params.symbol);
  if (!market) throw Object.assign(new Error(`Unknown market "${req.params.symbol}".`), { status: 404, code: 'SYMBOL_UNKNOWN' });
  const q = feed.quoteAt(market.code);
  const prev = feed.quoteAt(market.code, Date.now() - 24 * 3600 * 1000);
  ok(res, {
    ...feedMeta(),
    symbol: {
      code: market.code, name: market.name, group: market.group, digits: market.digits,
      pipSize: Math.pow(10, -market.digits), tickMs: feed.TICK_MS,
      epoch: q.epoch, last: q.quote, bid: q.bid, ask: q.ask,
      changePct: prev && prev.quote ? Number((((q.quote - prev.quote) / prev.quote) * 100).toFixed(3)) : 0,
    },
  });
});

route('GET', '/api/markets/:symbol/ticks', async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const data = feed.ticks(req.params.symbol, url.searchParams.get('count') || 60);
  if (!data) throw Object.assign(new Error(`Unknown market "${req.params.symbol}".`), { status: 404, code: 'SYMBOL_UNKNOWN' });
  ok(res, { ...feedMeta(), ...data });
});

route('GET', '/api/markets/:symbol/candles', async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const data = feed.candles(req.params.symbol, url.searchParams.get('granularity') || 60, url.searchParams.get('count') || 60);
  if (!data) throw Object.assign(new Error(`Unknown market "${req.params.symbol}".`), { status: 404, code: 'SYMBOL_UNKNOWN' });
  ok(res, { ...feedMeta(), ...data });
});

// ---------------------------------------------------------------- demo trading
route('GET', '/api/trading/limits', async (req, res) =>
  ok(res, {
    ...feedMeta(),
    realMoneyEnabled: config.gates.realMoneyEnabled,
    limits: trading.__limits(),
    payouts: await trading.payoutLadder(),
    contractTypes: [{ code: 'CALL', name: 'Rise' }, { code: 'PUT', name: 'Fall' }],
  }));

route('POST', '/api/trades', async (req, res) => {
  const user = await requireUser(req);
  const body = await readBody(req);
  const result = await trading.openTrade({
    userId: user.id,
    symbol: body.symbol,
    contractType: body.contractType || body.contract_type,
    stakeCents: body.stakeCents !== undefined ? Number(body.stakeCents) : Math.round(Number(body.stake || 0) * 100),
    durationTicks: body.durationTicks !== undefined ? Number(body.durationTicks) : Number(body.duration),
  });
  send(res, 201, { ok: true, ...result });
});

route('GET', '/api/trades', async (req, res) => {
  const user = await requireUser(req);
  const url = new URL(req.url, 'http://localhost');
  const result = await trading.listTrades(user.id, { status: url.searchParams.get('status') || 'all', limit: url.searchParams.get('limit') });
  ok(res, { ...result, balances: await store.walletFor(user.id) });
});

route('GET', '/api/trades/:id', async (req, res) => {
  const user = await requireUser(req);
  ok(res, { trade: await trading.getTrade(user.id, req.params.id), balances: await store.walletFor(user.id) });
});

// ---------------------------------------------------------------- routing
const splitPath = (p) => String(p || '/').replace(/\/+$/, '').split('/').filter(Boolean);

/** Exact paths win; then `/api/trades/:id` style patterns, with params matched onto req.params. */
function matchRoute(method, pathname) {
  const exact = ROUTES.find((r) => r.method === method && r.path === pathname);
  if (exact) return { ...exact, params: {} };
  const want = splitPath(pathname);
  for (const r of ROUTES) {
    if (r.method !== method || r.path.indexOf(':') === -1) continue;
    const have = splitPath(r.path);
    if (have.length !== want.length) continue;
    const params = {};
    let match = true;
    for (let i = 0; i < have.length; i++) {
      if (have[i].startsWith(':')) params[have[i].slice(1)] = decodeURIComponent(want[i]);
      else if (have[i] !== want[i]) { match = false; break; }
    }
    if (match) return { ...r, params };
  }
  return null;
}

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

  const hit = matchRoute(req.method, url.pathname);
  if (!hit) return send(res, 404, { ok: false, error: 'not found', code: 'NOT_FOUND' });
  req.params = hit.params;

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
