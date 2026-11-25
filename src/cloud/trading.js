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

// Rise/fall settle on the price moving; digit contracts settle on the last digit of the expiry
// tick. Both are priced here (see digitMultiplierBp) and both settle through the same ledger.
export const CONTRACT_TYPES = ['CALL', 'PUT', 'DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'];
export const DIGIT_CONTRACT_TYPES = ['DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'];
const BARRIER_TYPES = ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'];
export const CONTRACT_LABELS = {
  CALL: 'Rise', PUT: 'Fall',
  DIGITEVEN: 'Even', DIGITODD: 'Odd',
  DIGITOVER: 'Over', DIGITUNDER: 'Under',
  DIGITMATCH: 'Matches', DIGITDIFF: 'Differs',
};
const isDigitType = (t) => DIGIT_CONTRACT_TYPES.includes(t);

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

// Digit payouts are derived from the real probability of winning, minus a 4% house margin, so a
// trader can never be offered a price that is arithmetically impossible to fund:
//   even/odd  p = 5/10   over b  p = (9-b)/10   under b  p = b/10   match p = 1/10   differ p = 9/10
export function digitMultiplierBp(contractType, barrier) {
  const b = Number(barrier);
  let p;
  if (contractType === 'DIGITEVEN' || contractType === 'DIGITODD') p = 0.5;
  else if (contractType === 'DIGITOVER') p = (9 - b) / 10;
  else if (contractType === 'DIGITUNDER') p = b / 10;
  else if (contractType === 'DIGITMATCH') p = 0.1;
  else if (contractType === 'DIGITDIFF') p = 0.9;
  else return null;
  if (!(p > 0) || p > 1) return null;
  return Math.round(((1 - 0.04) / p) * 10000);
}

/** The last digit of a quote, at the market's own precision. */
export function lastDigitOf(quote, digits) {
  const scaled = Math.round(Number(quote) * Math.pow(10, Number(digits) || 2));
  return ((scaled % 10) + 10) % 10;
}

/** Did this digit contract win, lose, or void (a void is impossible for digits)? */
export function digitOutcome(contractType, barrier, digit) {
  const b = Number(barrier);
  switch (contractType) {
    case 'DIGITEVEN': return digit % 2 === 0 ? 'WON' : 'LOST';
    case 'DIGITODD': return digit % 2 === 1 ? 'WON' : 'LOST';
    case 'DIGITOVER': return digit > b ? 'WON' : 'LOST';
    case 'DIGITUNDER': return digit < b ? 'WON' : 'LOST';
    case 'DIGITMATCH': return digit === b ? 'WON' : 'LOST';
    case 'DIGITDIFF': return digit !== b ? 'WON' : 'LOST';
    default: return null;
  }
}

// The default ladder is seeded once per process, in a single statement: issuing 14 separate inserts
// made the first trade of every cold start wait on 14 remote round trips.
let ladderReady = null;
export function ensureTrading() {
  if (!ladderReady) {
    const rows = [];
    for (const contractType of CONTRACT_TYPES) {
      for (const [duration, bp] of DEFAULT_RULES) rows.push([contractType, duration, bp, 'table', 1, 'default ladder', now()]);
    }
    ladderReady = one(
      `INSERT INTO payout_rules(contract_type,symbol,duration_ticks,payout_multiplier_bp,source,active,notes,updated_at)
       SELECT u.contract_type, '*', u.duration_ticks, u.payout_multiplier_bp, u.source, u.active, u.notes, u.updated_at
         FROM unnest($1::text[], $2::int[], $3::int[], $4::text[], $5::int[], $6::text[], $7::bigint[])
              AS u(contract_type, duration_ticks, payout_multiplier_bp, source, active, notes, updated_at)
       ON CONFLICT (contract_type, symbol, duration_ticks) DO NOTHING RETURNING id`,
      [rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map((r) => r[3]),
        rows.map((r) => r[4]), rows.map((r) => r[5]), rows.map((r) => r[6])],
    ).catch((err) => { ladderReady = null; throw err; });
  }
  return ladderReady;
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
    contractLabel: CONTRACT_LABELS[row.contract_type] || row.contract_type,
    barrier: row.barrier === null || row.barrier === undefined ? null : Number(row.barrier),
    lastDigit: row.last_digit === null || row.last_digit === undefined ? null : Number(row.last_digit),
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

function validate({ symbol, contractType, stakeCents, durationTicks, mode, barrier: rawBarrier }) {
  if (!MODES.includes(mode)) throw fail('mode must be demo or real.', 'MODE_INVALID');
  const market = findMarket(symbol);
  if (!market) throw fail(`Unknown market "${symbol}".`, 'SYMBOL_UNKNOWN', 404);
  const type = String(contractType || '').toUpperCase();
  if (!CONTRACT_TYPES.includes(type)) {
    throw fail(`contractType must be one of ${CONTRACT_TYPES.join(', ')}.`, 'CONTRACT_TYPE_INVALID');
  }
  // Digit contracts run for a single tick, like they do on Deriv, and the barrier is a digit 0-9.
  const durationTicks_ = isDigitType(type) ? 1 : Number(durationTicks);
  let barrier = null;
  if (BARRIER_TYPES.includes(type)) {
    if (rawBarrier === null || rawBarrier === undefined || rawBarrier === '') {
      throw fail('Pick a barrier digit from 0 to 9 for that contract.', 'BARRIER_INVALID');
    }
    barrier = Number(rawBarrier);
    if (!Number.isInteger(barrier) || barrier < 0 || barrier > 9) {
      throw fail('Pick a barrier digit from 0 to 9 for that contract.', 'BARRIER_INVALID');
    }
    if (type === 'DIGITOVER' && barrier > 8) throw fail('Over 9 can never win — pick 0 to 8.', 'BARRIER_INVALID');
    if (type === 'DIGITUNDER' && barrier < 1) throw fail('Under 0 can never win — pick 1 to 9.', 'BARRIER_INVALID');
  }
  const stake = Number(stakeCents);
  if (!Number.isInteger(stake) || stake <= 0) throw fail('Enter a stake in whole cents.', 'STAKE_INVALID');
  if (stake < cfg().minStakeCents) throw fail(`Minimum stake is $${(cfg().minStakeCents / 100).toFixed(2)}.`, 'STAKE_TOO_SMALL');
  if (stake > cfg().maxStakeCents) throw fail(`Maximum stake is $${(cfg().maxStakeCents / 100).toFixed(2)}.`, 'STAKE_TOO_LARGE');
  const duration = durationTicks_;
  if (!cfg().allowedTickDurations.includes(duration)) {
    throw fail(`Duration must be one of ${cfg().allowedTickDurations.join(', ')} ticks.`, 'DURATION_INVALID');
  }
  return { market, type, stake, duration, mode, barrier };
}

/** Open a contract against the demo or real wallet. */
export async function openTrade({ userId, symbol, contractType, stakeCents, durationTicks, mode = 'demo', barrier = null }) {
  const { market, type, stake, duration, mode: walletMode, barrier: digitBarrier } =
    validate({ symbol, contractType, stakeCents, durationTicks, mode, barrier });
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

  let rule = null;
  let bp = null;
  if (isDigitType(type)) {
    bp = digitMultiplierBp(type, digitBarrier);
    if (!bp) throw fail('No payout is configured for that contract.', 'PAYOUT_UNAVAILABLE', 503);
  } else {
    rule = await payoutRule(type, market.code, duration);
    if (!rule) throw fail('No payout is configured for that contract.', 'PAYOUT_UNAVAILABLE', 503);
    bp = Number(rule.payout_multiplier_bp);
  }
  const payoutCents = Math.floor((stake * bp) / 10000);

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
                          expiry_epoch,status,payout_cents,payout_rule_id,payout_source,ticks_seen,opened_at,barrier)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'OPEN',$11,$12,$13,0,$14,$15)`,
      [id, userId, walletMode, market.code, type, stake, duration, entry, entryEpoch, expiryEpoch, payoutCents,
        rule ? rule.id : null, rule ? rule.source : 'formula', t, digitBarrier]);
  });

  await store.audit(userId, 'trade.open', { id, symbol: market.code, type, stake, duration, barrier: digitBarrier });

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
    let lastDigit = null;
    if (isDigitType(row.contract_type)) {
      const market = findMarket(row.symbol);
      lastDigit = lastDigitOf(exit, market ? market.digits : 2);
      status = digitOutcome(row.contract_type, row.barrier, lastDigit) || 'LOST';
    } else if (exit > entry) { status = row.contract_type === 'CALL' ? 'WON' : 'LOST'; }
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
      'UPDATE trades SET status=$1, exit_spot=$2, profit_cents=$3, settled_at=$4, ticks_seen=$5, last_digit=$6 WHERE id=$7',
      [status, exit, profit, t, ticksSeen, lastDigit, row.id]);
    return { id: row.id, status, exit, entry, symbol: row.symbol, mode: row.mode || 'demo', lastDigit };
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
