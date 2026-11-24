-- NovaTrade KE — Postgres schema (parity with the SQLite schema in src/db.js).
-- Money is BIGINT minor units (cents). All timestamps are BIGINT epoch-ms to keep the
-- application's arithmetic identical across both engines.

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('customer','admin')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at     BIGINT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 1,
  last_login_at  BIGINT,
  last_login_ip  TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,          -- sha-256 digest of the cookie value
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

-- ---------------------------------------------------------------- registration / reset
CREATE TABLE IF NOT EXISTS pending_users (
  email         TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_otps (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  purpose      TEXT NOT NULL CHECK (purpose IN ('register','reset')),
  code_hash    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  sends        INTEGER NOT NULL DEFAULT 1,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  last_sent_at BIGINT NOT NULL,
  consumed_at  BIGINT
);
CREATE INDEX IF NOT EXISTS email_otps_lookup ON email_otps(email, purpose, consumed_at);

CREATE TABLE IF NOT EXISTS reset_tickets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at    BIGINT
);

CREATE TABLE IF NOT EXISTS rate_events (
  key TEXT NOT NULL,
  ts  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_events_key ON rate_events(key, ts);

-- ---------------------------------------------------------------- double-entry ledger
CREATE TABLE IF NOT EXISTS accounts (
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('asset','liability','revenue','expense','equity')),
  owner_user_id TEXT REFERENCES users(id),
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS txns (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  ref        TEXT,
  memo       TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS txns_created ON txns(created_at DESC);

CREATE TABLE IF NOT EXISTS entries (
  id           BIGSERIAL PRIMARY KEY,
  txn_id       TEXT NOT NULL REFERENCES txns(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL REFERENCES accounts(code),
  amount       BIGINT NOT NULL,          -- signed minor units; per-txn sum must be 0
  created_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_txn ON entries(txn_id);
CREATE INDEX IF NOT EXISTS entries_account ON entries(account_code);

-- ---------------------------------------------------------------- trading
CREATE TABLE IF NOT EXISTS trades (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  symbol         TEXT NOT NULL,
  contract_type  TEXT NOT NULL CHECK (contract_type IN ('CALL','PUT')),
  stake_cents    BIGINT NOT NULL CHECK (stake_cents > 0),
  duration_ticks INTEGER NOT NULL CHECK (duration_ticks > 0),
  entry_spot     NUMERIC(20,8) NOT NULL,
  entry_epoch    BIGINT NOT NULL,
  expiry_epoch   BIGINT,
  status         TEXT NOT NULL CHECK (status IN ('OPEN','WON','LOST','VOID')),
  exit_spot      NUMERIC(20,8),
  payout_cents   BIGINT NOT NULL,
  profit_cents   BIGINT,
  payout_rule_id INTEGER,
  payout_source  TEXT NOT NULL DEFAULT 'table',
  ticks_seen     INTEGER NOT NULL DEFAULT 0,
  opened_at      BIGINT NOT NULL,
  settled_at     BIGINT
);
CREATE INDEX IF NOT EXISTS trades_user ON trades(user_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS trades_open ON trades(status) WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS payout_rules (
  id                  BIGSERIAL PRIMARY KEY,
  contract_type       TEXT NOT NULL,
  symbol              TEXT NOT NULL DEFAULT '*',
  duration_ticks      INTEGER NOT NULL,
  payout_multiplier_bp INTEGER NOT NULL,
  source              TEXT NOT NULL DEFAULT 'table',
  active              INTEGER NOT NULL DEFAULT 1,
  notes               TEXT,
  updated_at          BIGINT NOT NULL,
  UNIQUE (contract_type, symbol, duration_ticks)
);

CREATE TABLE IF NOT EXISTS cashier_txns (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL CHECK (type IN ('deposit','withdrawal')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency     TEXT NOT NULL DEFAULT 'DEMO',
  method       TEXT NOT NULL DEFAULT 'demo',
  status       TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','settled')),
  reference    TEXT,
  note         TEXT,
  created_at   BIGINT NOT NULL,
  decided_at   BIGINT,
  decided_by   TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS cashier_user ON cashier_txns(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  payload    TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_created ON audit_log(created_at DESC);

-- ---------------------------------------------------------------- integrity views
-- Ledger must balance per transaction and globally. Surfaced by /healthz and the admin page.
CREATE OR REPLACE VIEW ledger_unbalanced AS
  SELECT txn_id, SUM(amount) AS signed_sum
  FROM entries GROUP BY txn_id HAVING SUM(amount) <> 0;
