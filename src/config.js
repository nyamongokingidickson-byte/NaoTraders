// Central configuration. Everything money-related is OFF by default (demo only).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Parse the project's existing .env so we reuse the live Deriv app id / names. */
function readExistingEnv() {
  const candidates = [
    process.env.EXISTING_ENV_FILE,
    path.join(ROOT, '..', 'audit', 'NovaTrade KE-main', '.env'),
    path.join(ROOT, '..', 'NovaTrade KE-main', '.env'),
    path.join(ROOT, '.env'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const out = {};
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
      return { ...out, __source: file };
    } catch { /* keep looking */ }
  }
  return {};
}

const existing = readExistingEnv();

const env = process.env;
const bool = (v, d = false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));

export const config = {
  root: ROOT,
  port: Number(env.PORT || 4173),
  env: env.NODE_ENV || 'development',
  publicUrl: env.APP_URL || '',
  dbFile: env.DB_FILE || path.join(ROOT, 'data', 'platform.db'),

  // ---- Deriv: REUSE the existing integration and credentials, do not add new ones ----
  deriv: {
    appId: env.DERIV_APP_ID || existing.VITE_DERIV_APP_ID || existing.NEXT_PUBLIC_DERIV_APP_ID || '',
    appName: existing.NEXT_PUBLIC_DERIV_APP_NAME || 'NovaTrade KE',
    wsUrl: env.DERIV_WS_URL || 'wss://ws.derivws.com/websockets/v3',
    // read-only usage: ticks/candles/active_symbols + proposal quotes for payout verification
    readOnly: true,
    connectTimeoutMs: Number(env.DERIV_CONNECT_TIMEOUT_MS || 8000),
    envSource: existing.__source || null,
    realAccountToken: env.DERIV_TOKEN || null, // never used for execution by this platform
  },

  // ---- Market feed ----
  feed: {
    // 'auto' tries Deriv first, falls back to the deterministic replay feed
    mode: env.MARKET_FEED || 'auto',
    symbols: (env.MARKET_SYMBOLS || 'R_100,R_75,R_50,R_25,R_10,1HZ100V,1HZ75V')
      .split(',').map(s => s.trim()).filter(Boolean),
  },

  // ---- Hard safety gates (regulatory) ----
  gates: {
    // Real-money cashier + execution stay disabled until licensing is approved.
    realMoneyEnabled: bool(env.REAL_MONEY_ENABLED, false),
    // 'demo' = only DEMO currency wallets; 'live' would require realMoneyEnabled
    mode: bool(env.REAL_MONEY_ENABLED, false) ? 'live' : 'demo',
    requireAdminApprovalForWithdrawals: true,
    requireAdminApprovalForDepositsOver: Number(env.DEPOSIT_APPROVAL_THRESHOLD_CENTS || 50000),
    jurisdiction: env.JURISDICTION || 'KE',
  },

  risk: {
    maxExposureCents: Number(env.MAX_EXPOSURE_CENTS || 500000),      // platform-wide open payout liability
    maxStakeCents: Number(env.MAX_STAKE_CENTS || 50000),             // per ticket
    maxExposurePerSymbolCents: Number(env.MAX_EXPOSURE_PER_SYMBOL_CENTS || 200000),
  },

  limits: {
    minStakeCents: Number(env.MIN_STAKE_CENTS || 100),
    maxDurationTicks: 30,
    allowedTickDurations: [1, 2, 3, 5, 10, 15, 30],
    allowedSecondDurations: [15, 30, 60, 120],
  },

  session: {
    cookieName: 'nt_session',
    ttlMs: 1000 * 60 * 60 * 12,
  },

  email: {
    // 'console' writes .eml/JSON files to var/outbox (development, no credentials needed).
    // 'smtp' needs SMTP_HOST/PORT/USER/PASS. 'resend' needs RESEND_API_KEY.
    // Prefer a configured provider automatically: if RESEND_API_KEY is present (as it is on
    // the Vercel project) use Resend rather than silently writing codes to a local file.
    transport: env.EMAIL_TRANSPORT
      || (env.RESEND_API_KEY ? 'resend' : (env.SMTP_HOST && env.SMTP_USER ? 'smtp' : 'console')),
    from: env.MAIL_FROM || 'NovaTrade KE <no-reply@novatrade.ke>',
    replyTo: env.MAIL_REPLY_TO || 'support@novatrade.ke',
    outboxDir: path.join(ROOT, 'var', 'outbox'),
    smtp: {
      host: env.SMTP_HOST || '',
      port: Number(env.SMTP_PORT || 587),
      secure: String(env.SMTP_SECURE || 'false') === 'true',
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
    },
    resendApiKey: env.RESEND_API_KEY || '',
  },

  otp: {
    length: 6,
    ttlMs: Number(env.OTP_TTL_MS || 5 * 60 * 1000),        // 5 minutes
    resendCooldownMs: Number(env.OTP_RESEND_MS || 60 * 1000), // 60 seconds
    maxAttempts: Number(env.OTP_MAX_ATTEMPTS || 5),
    maxSends: Number(env.OTP_MAX_SENDS || 5),
    resetTicketTtlMs: Number(env.RESET_TICKET_TTL_MS || 15 * 60 * 1000),
  },

  security: {
    minPasswordLength: Number(env.MIN_PASSWORD_LENGTH || 8),
    loginAttemptsPerEmail: Number(env.LOGIN_ATTEMPTS_PER_EMAIL || 10),
    loginWindowMs: Number(env.LOGIN_WINDOW_MS || 15 * 60 * 1000),
    registerPerIp: Number(env.REGISTER_PER_IP || 5),
    resetRequestPerEmail: Number(env.RESET_REQUEST_PER_EMAIL || 3),
    // Cookie is marked Secure automatically when the request arrives over https.
    forceSecureCookie: String(env.FORCE_SECURE_COOKIE || 'false') === 'true',
  },

  payout: {
    // 'table' = platform-configured multipliers; 'deriv_proposal' = ask Deriv for the
    // authoritative payout on every ticket (requires reachable Deriv API), falling back to table.
    mode: env.PAYOUT_MODE || 'table',
    defaultCurrency: 'USD',
    houseEdgeBpsFloor: 100, // never allow a configured multiplier below 1.01x
  },
};

export default config;
