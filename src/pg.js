// Postgres access layer for the Vercel-native build.
//
// Serverless has no synchronous SQL driver, so every query here is async. Two backends:
//   • `pg` (node-postgres) against DATABASE_URL — production on Vercel/Neon/Supabase
//   • PGlite (real Postgres compiled to WASM) — tests and local development
// Both speak the same SQL, so the schema and queries are identical.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';

// Neon/Hyperdrive style hosts publish AAAA records; if IPv6 egress is unavailable the pool
// would fail with ECONNREFUSED. Prefer A records.
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* older Node */ }

let backend = null;   // { kind, query, exec, tx, close }
let initPromise = null;

const SCHEMA_FILE = path.join(import.meta.dirname, '..', 'db', 'schema.postgres.sql');

function usePg() {
  return !!process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith('pglite:');
}

async function createPgBackend() {
  const pg = await import('pg').then((m) => m.default ?? m);

  // Managed providers (Aiven, Neon, Supabase) present their own CA chain. node-postgres v8
  // also parses `sslmode` out of the URL and applies its own rules, which fights an explicit
  // `ssl` option — so strip the param and decide here.
  const raw = process.env.DATABASE_URL || '';
  const url = new URL(raw);
  const sslmode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');
  url.searchParams.delete('channel_binding');   // libpq-only, ignored by node-postgres
  url.searchParams.delete('connect_timeout');

  let ssl;
  if (process.env.PG_CA_CERT) {
    // strongest option: verify the server with the provider's CA bundle
    ssl = { ca: process.env.PG_CA_CERT.replace(/\\n/g, '\n'), rejectUnauthorized: true };
  } else if (process.env.PG_SSL_NO_VERIFY === 'true') {
    ssl = { rejectUnauthorized: false };
  } else if (sslmode && sslmode !== 'disable') {
    // Managed providers with public certificates (Neon, Supabase, RDS) verify fully. A
    // provider presenting a private CA (Aiven) is handled by the fallback below.
    ssl = { rejectUnauthorized: true };
  } else if (process.env.PGSSL === 'true') {
    ssl = { rejectUnauthorized: false };
  }

  const pool = new pg.Pool({
    connectionString: url.toString(),
    ssl,
    max: Number(process.env.PG_POOL_MAX || 3),          // serverless: keep pools small
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    application_name: 'novatrade-platform',
  });
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    if (!/SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(e.message || '')) throw e;
    // provider uses its own CA chain: stay encrypted, drop certificate verification
    console.warn('[pg] server certificate is not publicly trusted; continuing encrypted without verification');
    await pool.end();
    const relaxed = new pg.Pool({
      connectionString: url.toString(), ssl: { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX || 3), idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000, application_name: 'novatrade-platform',
    });
    await relaxed.query('SELECT 1');
    return {
      kind: 'pg',
      query: async (text, params) => (await relaxed.query(text, params)).rows,
      exec: async (sql) => { await relaxed.query(sql); },
      tx: async (fn) => {
        const client = await relaxed.connect();
        try {
          await client.query('BEGIN');
          const wrapped = {
            query: async (text, params) => (await client.query(text, params)).rows,
            exec: async (sql) => { await client.query(sql); },
          };
          const result = await fn(wrapped);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          try { await client.query('ROLLBACK'); } catch { /* connection gone */ }
          throw err;
        } finally { client.release(); }
      },
      close: async () => relaxed.end(),
    };
  }
  return {
    kind: 'pg',
    query: async (text, params) => (await pool.query(text, params)).rows,
    exec: async (sql) => { await pool.query(sql); },
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const wrapped = {
          query: async (text, params) => (await client.query(text, params)).rows,
          exec: async (sql) => { await client.query(sql); },
        };
        const result = await fn(wrapped);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
        throw err;
      } finally {
        client.release();
      }
    },
    close: async () => pool.end(),
  };
}

async function createPgliteBackend() {
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = process.env.PGLITE_DIR || 'memory://';
  const lite = await PGlite.create(dir);
  return {
    kind: 'pglite',
    query: async (text, params) => (await lite.query(text, params)).rows,
    exec: async (sql) => { await lite.exec(sql); },
    tx: async (fn) => {
      await lite.exec('BEGIN');
      try {
        const result = await fn({
          query: async (text, params) => (await lite.query(text, params)).rows,
          exec: async (sql) => { await lite.exec(sql); },
        });
        await lite.exec('COMMIT');
        return result;
      } catch (err) {
        try { await lite.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
    },
    close: async () => lite.close(),
  };
}

/**
 * Connect once per process/invocation and run migrations.
 *
 * On a serverless host PGlite is in-memory per invocation: every account would vanish when the
 * request ends. So refuse to start there without a real DATABASE_URL rather than appear to work.
 */
export async function db() {
  if (backend) return backend;
  if (!initPromise) {
    if (!usePg() && process.env.VERCEL && !process.env.ALLOW_EPHEMERAL_DB) {
      throw Object.assign(
        new Error('DATABASE_URL is not set on this deployment. Accounts need persistent storage; '
          + 'add the Postgres connection string to the project environment variables.'),
        { status: 503, code: 'DATABASE_NOT_CONFIGURED' },
      );
    }
    initPromise = (async () => {
      backend = usePg() ? await createPgBackend() : await createPgliteBackend();
      await migrate(backend);
      return backend;
    })();
  }
  return initPromise;
}

/** Apply db/schema.postgres.sql idempotently. */
export async function migrate(conn) {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  await conn.exec(sql);
}

// ---------------------------------------------------------------- query helpers
export const q = (text, params) => db().then((c) => c.query(text, params));
export const one = async (text, params) => (await q(text, params))[0] ?? null;
export const many = (text, params) => q(text, params);
export const run = async (text, params) => q(text, params);
export const tx = (fn) => db().then((c) => c.tx(fn));

export async function closeAll() {
  if (backend) { await backend.close(); backend = null; initPromise = null; }
}

/** Health probe used by /healthz. */
export async function pgHealth() {
  const conn = await db();
  const started = Date.now();
  const rows = await conn.query('SELECT 1 AS ok');
  return { backend: conn.kind, ok: rows[0]?.ok === 1, latencyMs: Date.now() - started };
}
