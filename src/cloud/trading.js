// Demo trading engine: rise/fall (CALL/PUT) binary contracts on the simulated feed.
//
// Money movement is real double-entry bookkeeping against the same ledger the wallet reads:
//   open   demo:<user> −stake        escrow +stake
//   win    escrow −stake  demo:<user> +payout  platform_revenue −(payout − stake)
//   loss   escrow −stake  platform_revenue +stake
//   void   escrow −stake  demo:<user> +stake          (expiry price exactly equals entry)
// so a balance always reconciles with the journal, and a losing streak really does reduce it.
//
// Settlement is lazy: serverless has no cron, so any read of a user's trades first settles whatever
// has expired. The exit price comes from the same pure function that produced the entry price, so a
// trade settles against the exact price the tape showed at expiry — on any instance, at any time.
import { config } from '../config.js';
import { one, many, tx } from '../pg.js';
import * as store from './store.js';
import { findMarket, quoteAt, TICK_MS as FEED_TICK_MS } from './feed.js';

const cfg = () => config.trading;
const now = () => Date.now();

const fail = (message, code, status = 400, extra = {}) =>
  Object.assign(new Error(message), { status, code, ...extra });

export const CONTRACT_TYPES = ['CALL', 'PUT'];

// Two accounts share one identity: the demo wallet (virtual funds, fully tradeable) and the real
// wallet (ledger-backed cash, currently unfunded because the cashier is not switched on yet).
// A contract records which wallet paid for it, and every entry it books goes back to that wallet.
export const MODES = ['demo', 'real'];
export const accountCode = (mode, userId) => (mode === 'real' ? `customer:${userId}` : `demo:${userId}`);

// Payout ladder, in basis points of stake. Kept in the table so it can be changed without a deploy.
const DEFAULT_RULES = [
  [1, 18000], [2, 18300], [3, 18500], [5, 18800],
  [10, 19100], [15, 19300], [30, 19600],
];

export async function ensureTrading() {
  const t = now();
  for (const contractType of CONTRACT_TYPES) {
    for (const [duration, bp] of DEFAULT_RULES) {
      await one(
        `INSERT INTO payout_rules(contract_type,symbol,duration_ticks,payout_multiplier_bp,source,active,notes,updated_at)
         VALUES($1,'*',$2,$3,'table',1,'default ladder', $4)
         ON CONFLICT (contract_type, symbol, duration_ticks) DO NOTHING RETURNING id`,
        [contractType, duration, bp, t]);
    }
  }
}

async function payoutRule(contractType, symbol, durationTicks) {
  const row = await one(
    `SELECT * FROM payout_rules
      WHERE contract_type=$1 AND active=1 AND duration_ticks=$2 AND (symbol=$3 OR symbol='*')
      ORDER BY (symbol=$3) DESC LIMIT 1`,
    [contractType, durationTicks, symbol]);
  return row || null;
}

/** Shape a trades row for the API. */
export function tradeView(row) {
  const stake = Number(row.stake_cents);
  const payout = Number(row.payout_cents);
  return {
    id: row.id,
    mode: row.mode || 'demo',
    symbol: row.symbol,
    contractType: row.contract_type,
    stakeCents: stake,
    durationTicks: Number(row.duration_ticks),
    entrySpot: Number(row.entry_spot),
    entryEpoch: Number(row.entry_epoch),
    expiryEpoch: row.expiry_epoch === null ? null : Number(row.expiry_epoch),
    exitSpot: row.exit_spot === null ? null : Number(row.exit_spot),
    payoutCents: payout,
    profitCents: row.profit_cents === null ? null : Number(row.profit_cents),
    status: row.status,
    ticksSeen: Number(row.ticks_seen || 0),
    openedAt: Number(row.opened_at),
    settledAt: row.settled_at === null ? null : Number(row.settled_at),
    // What the contract can still return while it is open (payout minus stake).
    potentialProfitCents: payout - stake,
  };
}

function validate({ symbol, contractType, stakeCents, durationTicks, mode }) {
  if (!MODES.includes(mode)) throw fail('mode must be demo or real.', 'MODE_INVALID');
  const market = findMarket(symbol);
  if (!market) throw fail(`Unknown market "${symbol}".`, 'SYMBOL_UNKNOWN', 404);
  const type = String(contractType || '').toUpperCase();
  if (!CONTRACT_TYPES.includes(type)) throw fail('contractType must be CALL (rise) or PUT (fall).', 'CONTRACT_TYPE_INVALID');
  const stake = Number(stakeCents);
  if (!Number.isInteger(stake) || stake <= 0) throw fail('Enter a stake in whole cents.', 'STAKE_INVALID');
  if (stake < cfg().minStakeCents) throw fail(`Minimum stake is $${(cfg().minStakeCents / 100).toFixed(2)}.`, 'STAKE_TOO_SMALL');
  if (stake > cfg().maxStakeCents) throw fail(`Maximum stake is $${(cfg().maxStakeCents / 100).toFixed(2)}.`, 'STAKE_TOO_LARGE');
  const duration = Number(durationTicks);
  if (!cfg().allowedTickDurations.includes(duration)) {
    throw fail(`Duration must be one of ${cfg().allowedTickDurations.join(', ')} ticks.`, 'DURATION_INVALID');
  }
  return { market, type, stake, duration, mode };
}

/** Open a contract against the demo or real wallet. */
export async function openTrade({ userId, symbol, contractType, stakeCents, durationTicks, mode = 'demo' }) {
  const { market, type, stake, duration, mode: walletMode } = validate({ symbol, contractType, stakeCents, durationTicks, mode });
  await ensureTrading();
  await store.ensureWallets(userId, config.demo.startingBalanceCents);

  const wallet = await store.walletFor(userId);
  const funds = wallet[walletMode];
  if (funds.availableCents < stake) {
    throw fail(
      walletMode === 'real'
        ? 'Your real account has no funds. Deposits are not available yet — trade on the demo account.'
        : 'Not enough demo funds for that stake.',
      'INSUFFICIENT_FUNDS', 400, { mode: walletMode, availableCents: funds.availableCents });
  }

  const open = await one(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(stake_cents),0)::bigint AS exposure
       FROM trades WHERE user_id=$1 AND status='OPEN' AND symbol=$2`, [userId, market.code]);
  if (open.n >= (cfg().maxOpenTradesPerUser || 20)) {
    throw fail(`You already have ${open.n} open contracts. Close or wait for them to expire.`, 'TOO_MANY_OPEN_TRADES');
  }
  if (Number(open.exposure) + stake > cfg().maxExposurePerSymbolCents) {
    throw fail(`Exposure on ${market.code} would exceed $${(cfg().maxExposurePerSymbolCents / 100).toFixed(0)}.`, 'EXPOSURE_LIMIT');
  }

  const rule = await payoutRule(type, market.code, duration);
  if (!rule) throw fail('No payout is configured for that contract.', 'PAYOUT_UNAVAILABLE', 503);
  const payoutCents = Math.floor((stake * Number(rule.payout_multiplier_bp)) / 10000);

  // Enter at the tick that is currently on the tape, not at an arbitrary millisecond between
  // ticks: the price a trader sees is the tick, so that is the price the contract opens at, and the
  // contract then runs for exactly `duration` ticks from it.
  const entryEpoch = Math.floor(now() / FEED_TICK_MS) * FEED_TICK_MS;
  const entry = quoteAt(market.code, entryEpoch).quote;
  const expiryEpoch = entryEpoch + duration * FEED_TICK_MS;
  const id = store.newId('trd');
  const t = entryEpoch;

  await tx(async (c) => {
    const txnId = store.newId('txn');
    await c.query('INSERT INTO txns(id,kind,ref,memo,created_at) VALUES($1,$2,$3,$4,$5)',
      [txnId, 'trade_stake', `trade-open:${id}`, `${type} ${market.code} stake`, t]);
    await c.query('INSERT INTO entries(txn_id,account_code,amount,created_at) VALUES($1,$2,$3,$4)', [txnId, accountCode(walletMode, userId), -stake, t]);
    await c.query('INSERT INTO entries(txn_id,account_code,amount,created_at) VALUES($1,$2,$3,$4)', [txnId, 'escrow', stake, t]);

    await c.query(
      `INSERT INTO trades(id,user_id,mode,symbol,contract_type,stake_cents,duration_ticks,entry_spot,entry_epoch,
                          expiry_epoch,status,payout_cents,payout_rule_id,payout_source,ticks_seen,opened_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'OPEN',$11,$12,$13,0,$14)`,
      [id, userId, walletMode, market.code, type, stake, duration, entry, entryEpoch, expiryEpoch, payoutCents, rule.id, rule.source, t]);
  });

  await store.audit(userId, 'trade.open', { id, symbol: market.code, type, stake, duration });

  const row = await one('SELECT * FROM trades WHERE id=$1', [id]);
  const balances = await store.walletFor(userId);
  return { trade: tradeView(row), balances };
}

/**
 * Settle every expired OPEN contract for this user. Safe to call on every request: rows are locked
 * and re-checked inside the transaction, so a double settle is impossible.
 */
export async function settleDue(userId, limit = 50) {
  const due = await many(
    `SELECT id FROM trades WHERE user_id=$1 AND status='OPEN' AND expiry_epoch <= $2 ORDER BY expiry_epoch LIMIT $3`,
    [userId, now(), limit]);
  let settled = 0;
  for (const { id } of due) {
    const result = await settleOne(userId, id);
    if (result) {
      settled += 1;
      await store.audit(userId, 'trade.settle', result).catch(() => {});
    }
  }
  return settled;
}

async function settleOne(userId, tradeId) {
  return tx(async (c) => {
    const locked = await c.query('SELECT * FROM trades WHERE id=$1 AND user_id=$2 FOR UPDATE', [tradeId, userId]);
    const row = locked[0];            // pg.tx hands back rows, not a result object
    if (!row || row.status !== 'OPEN') return false;
    if (Number(row.expiry_epoch) > now()) return false;

    const exit = quoteAt(row.symbol, Number(row.expiry_epoch)).quote;
    const entry = Number(row.entry_spot);
    const stake = Number(row.stake_cents);
    const payout = Number(row.payout_cents);

    let status = 'VOID', profit = 0;
    if (exit > entry) { status = row.contract_type === 'CALL' ? 'WON' : 'LOST'; }
    else if (exit < entry) { status = row.contract_type === 'PUT' ? 'WON' : 'LOST'; }
    if (status === 'WON') profit = payout - stake;
    if (status === 'LOST') profit = -stake;

    const walletCode = accountCode(row.mode || 'demo', userId);
    const t = now();
    const ref = `trade-settle:${row.id}`;
    const txnId = store.newId('txn');
    const kind = status === 'VOID' ? 'trade_void' : (status === 'WON' ? 'trade_payout' : 'trade_loss');

    const existing = await c.query('SELECT id FROM txns WHERE ref=$1', [ref]);
    if (existing.length) return false; // already booked

    await c.query('INSERT INTO txns(id,kind,ref,memo,created_at) VALUES($1,$2,$3,$4,$5)',
      [txnId, kind, ref, `${row.contract_type} ${row.symbol} ${status}`, t]);
    const entry2 = (code, amount) => c.query(
      'INSERT INTO entries(txn_id,account_code,amount,created_at) VALUES($1,$2,$3,$4)', [txnId, code, amount, t]);

    if (status === 'VOID') {
      await entry2('escrow', -stake);
      await entry2(walletCode, stake);
    } else if (status === 'WON') {
      await entry2('escrow', -stake);
      await entry2(walletCode, payout);
      await entry2('platform_revenue', -(payout - stake));
    } else {
      await entry2('escrow', -stake);
      await entry2('platform_revenue', stake);
    }

    const ticksSeen = Math.max(0, Math.round((Number(row.expiry_epoch) - Number(row.entry_epoch)) / FEED_TICK_MS));
    await c.query(
      'UPDATE trades SET status=$1, exit_spot=$2, profit_cents=$3, settled_at=$4, ticks_seen=$5 WHERE id=$6',
      [status, exit, profit, t, ticksSeen, row.id]);
    return { id: row.id, status, exit, entry, symbol: row.symbol, mode: row.mode || 'demo' };
  });
}

export async function listTrades(userId, { status = 'all', limit = 50, mode = null } = {}) {
  await settleDue(userId);
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const wantMode = MODES.includes(mode) ? mode : null;
  const where = ['user_id=$1'];
  const args = [userId];
  if (wantMode) { args.push(wantMode); where.push(`mode=$${args.length}`); }
  if (status !== 'all') { args.push(String(status).toUpperCase()); where.push(`status=$${args.length}`); }
  args.push(n);
  const rows = await many(
    `SELECT * FROM trades WHERE ${where.join(' AND ')} ORDER BY opened_at DESC LIMIT $${args.length}`, args);
  const summary = await one(
    `SELECT COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE status='WON')::int AS won,
            COUNT(*) FILTER (WHERE status='LOST')::int AS lost,
            COUNT(*) FILTER (WHERE status='VOID')::int AS void,
            COUNT(*) FILTER (WHERE status='OPEN')::int AS open,
            COALESCE(SUM(profit_cents) FILTER (WHERE status IN ('WON','LOST')),0)::bigint AS realised_cents
       FROM trades WHERE ${where.slice(0, wantMode ? 2 : 1).join(' AND ')}`,
    wantMode ? [userId, wantMode] : [userId]);
  return {
    trades: rows.map(tradeView),
    summary: {
      count: summary.count, won: summary.won, lost: summary.lost, void: summary.void, open: summary.open,
      realisedCents: Number(summary.realised_cents),
    },
  };
}

export async function getTrade(userId, id) {
  await settleDue(userId);
  const row = await one('SELECT * FROM trades WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!row) throw fail('Trade not found.', 'TRADE_NOT_FOUND', 404);
  return tradeView(row);
}

/** The payout table, so a client can preview a contract before placing it. */
export async function payoutLadder() {
  await ensureTrading();
  const rows = await many(
    `SELECT contract_type, duration_ticks, payout_multiplier_bp, source
       FROM payout_rules WHERE active=1 AND symbol='*' ORDER BY duration_ticks, contract_type`);
  return rows.map((r) => ({
    contractType: r.contract_type,
    durationTicks: Number(r.duration_ticks),
    multiplierBp: Number(r.payout_multiplier_bp),
    payoutPct: Number(r.payout_multiplier_bp) / 100,
    source: r.source,
  }));
}

export const __limits = () => ({
  minStakeCents: cfg().minStakeCents,
  maxStakeCents: cfg().maxStakeCents,
  durations: cfg().allowedTickDurations,
  maxOpenTradesPerUser: cfg().maxOpenTradesPerUser,
});
