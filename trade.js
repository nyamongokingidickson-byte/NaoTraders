// Demo trading screen. Everything it shows comes from the platform API:
//   /api/auth/session        who is signed in + balances
//   /api/markets             the simulated market list
//   /api/markets/:c/ticks    the tick tape
//   /api/markets/:c/candles  the 1-minute candles
//   /api/trading/limits      stakes, durations and the payout ladder
//   /api/trades              open + settled contracts (settlement happens server-side on read)
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const money = (cents) => (Number(cents || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const nf = (v, digits = 2) => Number(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const DIGIT_TYPES = ['DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'];
  const BARRIER_TYPES = ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'];
  const LABELS = {
    CALL: 'Rise', PUT: 'Fall', DIGITEVEN: 'Even', DIGITODD: 'Odd',
    DIGITOVER: 'Over', DIGITUNDER: 'Under', DIGITMATCH: 'Matches', DIGITDIFF: 'Differs',
  };
  const isDigitType = (t) => DIGIT_TYPES.includes(t);
  const state = {
    session: null, symbols: [], market: null, ticks: [], candles: [], chart: 'ticks',
    type: 'CALL', limits: null, payouts: [], digitMultipliers: {}, trades: [], timer: null,
    mode: 'demo', embed: false, balances: null,
  };
  const params = new URLSearchParams(location.search);
  const MODE_KEY = 'nt:active-account';

  // Deriv's symbol codes (what the platform tabs pass in their links) mapped onto this feed.
  const SYMBOL_ALIASES = {
    '1HZ10V': 'R_10', '1HZ25V': 'R_25', '1HZ50V': 'R_50', '1HZ75V': 'R_75', '1HZ100V': 'R_100',
    R_10: 'R_10', R_25: 'R_25', R_50: 'R_50', R_75: 'R_75', R_100: 'R_100',
    frxEURUSD: 'frxEURUSD', frxGBPUSD: 'frxGBPUSD', frxUSDJPY: 'frxUSDJPY',
    frxXAUUSD: 'frxXAUUSD', cryBTCUSD: 'cryBTCUSD', cryETHUSD: 'cryETHUSD', cryXRPUSD: 'cryXRPUSD',
  };
  const readMode = () => {
    try { return localStorage.getItem(MODE_KEY) === 'real' ? 'real' : 'demo'; } catch { return 'demo'; }
  };
  const writeMode = (mode) => {
    state.mode = mode === 'real' ? 'real' : 'demo';
    try { localStorage.setItem(MODE_KEY, state.mode); } catch { /* private mode */ }
    applyAccountMode();
  };

  async function getJSON(path, options) {
    const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...(options || {}) });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    return { ok: res.ok, status: res.status, data };
  }

  const msg = (text, kind = '') => {
    const el = $('#msg');
    el.textContent = text || '';
    el.className = `msg ${kind}`.trim();
  };

  // ------------------------------------------------------------------ session + bootstrap
  async function boot() {
    const { ok, status, data } = await getJSON('/api/auth/session');
    if (!ok) {
      if (status === 401) { location.replace('/login'); return; }
      $('#whenSignedOut').hidden = false;
      return;
    }
    state.session = data;
    $('#app').hidden = false;
    $('#tables').hidden = false;
    $('#balPill').hidden = false;
    $('#whoPill').hidden = false;
    $('#whoPill').textContent = data.accounts?.accountNumber || data.user?.email || '';
    renderBalances(data.balances);

    const limits = await getJSON('/api/trading/limits');
    if (limits.ok) {
      state.limits = limits.data.limits;
      state.payouts = limits.data.payouts || [];
      state.digitMultipliers = limits.data.digitMultipliers || {};
      buildDurations();
      buildStakeChips();
    }

    const markets = await getJSON('/api/markets');
    if (markets.ok && markets.data.symbols.length) {
      state.symbols = markets.data.symbols;
      renderMarkets();
      const wanted = SYMBOL_ALIASES[params.get('symbol')] || params.get('symbol');
      selectMarket(state.symbols.some((s) => s.code === wanted) ? wanted : state.symbols[0].code);
    }

    state.mode = readMode();
    applyAccountMode();
    setType(params.get('trade_type') === 'digits' ? 'DIGITEVEN' : 'CALL');
    talkToParent();

    await refreshTrades();
    state.timer = setInterval(tick, 2000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') tick();
    });
  }

  // One identity, two wallets. The switcher at the top of this page (and the header of the platform
  // shell that embeds it) picks which wallet an order is booked against. Nothing is faked: a real
  // order is really sent to the real wallet, and the platform refuses it while that wallet is
  // unfunded — the refusal is shown verbatim instead of a made-up success.
  function applyAccountMode() {
    const real = state.mode === 'real';
    for (const b of document.querySelectorAll('.acct button')) {
      b.setAttribute('aria-pressed', String(b.dataset.acct === state.mode));
    }
    const warn = $('#realWarn');
    if (warn) warn.hidden = !real;
    const head = $('#ticketHead');
    if (head) head.textContent = real ? 'Place a real trade' : 'Place a demo trade';
    const note = $('#acctNote');
    if (note) note.textContent = real ? 'real wallet' : 'virtual funds';
    const place = $('#place');
    if (place) {
      place.disabled = false;
      place.textContent = LABELS[state.type] || state.type;
      place.dataset.type = isDigitType(state.type) ? 'DIGIT' : state.type;
      place.title = '';
    }
    updatePreview();
  }

  function setMode(mode, { announce = false } = {}) {
    const next = mode === 'real' ? 'real' : 'demo';
    if (next === state.mode && announce) return;
    writeMode(next);
    if (announce) msg(next === 'real' ? 'Switched to the real account.' : 'Switched to the demo account.', '');
    try { window.dispatchEvent(new CustomEvent('nt:account-changed', { detail: { mode: next } })); } catch { /* old browsers */ }
  }

  function renderBalances(balances) {
    if (!balances) return;
    state.balances = balances;
    $('#balDemo').textContent = money(balances.demo.totalCents);
    if ($('#pillDemo')) $('#pillDemo').textContent = money(balances.demo.totalCents);
    if ($('#pillReal')) $('#pillReal').textContent = money(balances.real.totalCents);
    if ($('#realBalInline')) $('#realBalInline').textContent = money(balances.real.totalCents);
  }

  // ------------------------------------------------------------------ markets
  function renderMarkets() {
    const list = $('#marketList');
    list.innerHTML = '';
    for (const s of state.symbols) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mkt';
      btn.dataset.code = s.code;
      btn.setAttribute('aria-pressed', String(state.market === s.code));
      btn.innerHTML = `<span><span class="code">${s.code}</span><span class="grp">${s.group}</span></span>
        <span class="quote"><span data-q="${s.code}">${nf(s.last, s.digits)}</span>
        <span class="grp ${s.changePct >= 0 ? 'up' : 'down'}">${s.changePct >= 0 ? '+' : ''}${s.changePct}%</span></span>`;
      btn.addEventListener('click', () => selectMarket(s.code));
      list.appendChild(btn);
    }
  }

  function updateMarketQuotes(symbols) {
    for (const s of symbols) {
      const cell = document.querySelector(`[data-q="${s.code}"]`);
      if (cell) cell.textContent = nf(s.last, s.digits);
    }
  }

  async function selectMarket(code) {
    state.market = code;
    for (const b of document.querySelectorAll('.mkt')) b.setAttribute('aria-pressed', String(b.dataset.code === code));
    const meta = state.symbols.find((s) => s.code === code);
    $('#symName').textContent = meta ? `${meta.code} · ${meta.name}` : code;
    await Promise.all([loadTicks(), loadCandles()]);
    draw();
    updatePreview();
  }

  async function loadTicks() {
    if (!state.market) return;
    const { ok, data } = await getJSON(`/api/markets/${encodeURIComponent(state.market)}/ticks?count=120`);
    if (!ok) return;
    state.ticks = data.ticks || [];
    const meta = state.symbols.find((s) => s.code === state.market);
    const digits = meta ? meta.digits : 2;
    const last = state.ticks[state.ticks.length - 1];
    if (last) {
      $('#symPrice').textContent = nf(last.quote, digits);
      const prev = state.ticks[0];
      const chg = prev && prev.quote ? ((last.quote - prev.quote) / prev.quote) * 100 : 0;
      const el = $('#symChg');
      el.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(3)}%`;
      el.className = `chg ${chg >= 0 ? 'up' : 'down'}`;
    }
    $('#chartFoot').textContent = `${state.ticks.length} ticks · 2 s apart · simulated feed · not market data`;
  }

  async function loadCandles() {
    if (!state.market) return;
    const { ok, data } = await getJSON(`/api/markets/${encodeURIComponent(state.market)}/candles?granularity=60&count=60`);
    if (ok) state.candles = data.candles || [];
  }

  // ------------------------------------------------------------------ chart
  function draw() {
    const canvas = $('#chart');
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || 600;
    const cssH = canvas.clientHeight || 260;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const pad = { l: 8, r: 58, t: 10, b: 18 };
    const w = cssW - pad.l - pad.r;
    const h = cssH - pad.t - pad.b;

    const series = state.chart === 'ticks'
      ? state.ticks.map((t) => ({ x: t.epoch, y: t.quote }))
      : state.candles.map((c) => ({ x: c.epoch, y: c.close, o: c.open, hi: c.high, lo: c.low }));
    if (!series.length) return;

    const ys = series.map((p) => p.y);
    let min = Math.min(...ys);
    let max = Math.max(...ys);
    if (state.chart === 'candles') {
      min = Math.min(min, ...series.map((p) => p.lo));
      max = Math.max(max, ...series.map((p) => p.hi));
    }
    const span = max - min || Math.max(max * 0.001, 0.0001);
    min -= span * 0.12;
    max += span * 0.12;
    const X = (i) => pad.l + (i / Math.max(1, series.length - 1)) * w;
    const Y = (v) => pad.t + h - ((v - min) / (max - min)) * h;

    // grid + price axis
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = min + ((max - min) * i) / 4;
      const y = Y(v);
      ctx.strokeStyle = 'rgba(148,163,184,0.12)';
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + w, y); ctx.stroke();
      ctx.fillStyle = 'rgba(148,163,184,0.75)';
      ctx.fillText(nf(v, (state.symbols.find((s) => s.code === state.market) || { digits: 2 }).digits), pad.l + w + 6, y);
    }

    if (state.chart === 'ticks') {
      const rising = series[series.length - 1].y >= series[0].y;
      const line = rising ? '#34d399' : '#f87171';
      const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + h);
      grad.addColorStop(0, rising ? 'rgba(52,211,153,0.28)' : 'rgba(248,113,113,0.28)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath();
      series.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.y)) : ctx.moveTo(X(i), Y(p.y))));
      ctx.strokeStyle = line;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.lineTo(X(series.length - 1), pad.t + h);
      ctx.lineTo(X(0), pad.t + h);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      // last price marker
      const lastY = Y(series[series.length - 1].y);
      ctx.fillStyle = line;
      ctx.beginPath(); ctx.arc(X(series.length - 1), lastY, 3, 0, Math.PI * 2); ctx.fill();
    } else {
      const cw = Math.max(2, (w / series.length) * 0.62);
      series.forEach((c, i) => {
        const up = c.y >= c.o;
        const x = X(i);
        ctx.strokeStyle = up ? '#34d399' : '#f87171';
        ctx.fillStyle = up ? '#34d399' : '#f87171';
        ctx.beginPath(); ctx.moveTo(x, Y(c.hi)); ctx.lineTo(x, Y(c.lo)); ctx.lineWidth = 1; ctx.stroke();
        const yTop = Y(Math.max(c.o, c.y));
        const yBot = Y(Math.min(c.o, c.y));
        ctx.fillRect(x - cw / 2, yTop, cw, Math.max(1.5, yBot - yTop));
      });
    }
  }

  // ------------------------------------------------------------------ ticket
  function buildDurations() {
    const sel = $('#duration');
    sel.innerHTML = '';
    for (const d of state.limits?.durations || [5]) {
      const o = document.createElement('option');
      o.value = String(d);
      o.textContent = `${d} tick${d === 1 ? '' : 's'} · ~${d * 2}s`;
      sel.appendChild(o);
    }
    sel.value = '5';
  }

  function buildStakeChips() {
    const chips = [5, 10, 25, 50, 100];
    const wrap = $('#stakeChips');
    wrap.innerHTML = '';
    for (const v of chips) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `$${v}`;
      b.addEventListener('click', () => { $('#stake').value = String(v); updatePreview(); });
      wrap.appendChild(b);
    }
  }

  function multiplierFor(type, duration, barrier) {
    if (isDigitType(type)) {
      if (BARRIER_TYPES.includes(type)) return state.digitMultipliers[`${type}:${Number(barrier)}`] || null;
      return state.digitMultipliers[`${type}:0`] || state.digitMultipliers[`${type}:5`] || null;
    }
    const row = state.payouts.find((p) => p.contractType === type && p.durationTicks === Number(duration));
    return row ? row.multiplierBp : null;
  }
  const chosenBarrier = () => {
    const v = Number($('#barrier') && $('#barrier').value);
    return Number.isInteger(v) ? v : 5;
  };
  const effectiveDuration = () => (isDigitType(state.type) ? 1 : Number($('#duration').value || 5));

  function updatePreview() {
    const stake = Math.round(Number($('#stake').value || 0) * 100);
    const duration = effectiveDuration();
    const bp = multiplierFor(state.type, duration, chosenBarrier());
    const el = $('#preview');
    if (!Number.isInteger(stake) || stake <= 0) { el.textContent = 'Enter a stake to see the return.'; return; }
    if (!bp) { el.textContent = 'Payout unavailable for that duration.'; return; }
    const payout = Math.floor((stake * bp) / 10000);
    const wallet = state.mode === 'real'
      ? `Real wallet: <b>${money(state.balances ? state.balances.real.availableCents : 0)}</b> available`
      : `Demo wallet: <b>${money(state.balances ? state.balances.demo.availableCents : 0)}</b> available`;
    const how = isDigitType(state.type)
      ? `settles on the last digit of the next tick${BARRIER_TYPES.includes(state.type) ? ` against barrier ${chosenBarrier()}` : ''}`
      : `settles ${duration} tick${duration === 1 ? '' : 's'} after entry (≈${duration * 2}s)`;
    el.innerHTML = `Stake <b>${money(stake)}</b> · payout if right <b>${money(payout)}</b> ·
      profit <b>${money(payout - stake)}</b> · loss if wrong <b>${money(stake)}</b><br>
      ${wallet} · ${how}.`;
  }

  function setType(type) {
    state.type = type;
    for (const b of document.querySelectorAll('[data-type]')) {
      if (b.id === 'place') continue;
      b.setAttribute('aria-pressed', String(b.dataset.type === type));
    }
    const digit = isDigitType(type);
    $('#barrierField').hidden = !BARRIER_TYPES.includes(type);
    // A digit contract is a one-tick contract, so the duration control is replaced by that fact
    // rather than left showing an irrelevant choice.
    $('#duration').hidden = digit;
    $('#duration').disabled = digit;
    $('#durationNote').hidden = !digit;
    const place = $('#place');
    place.dataset.type = digit ? 'DIGIT' : type;
    place.textContent = LABELS[type] || type;
    updatePreview();
  }

  async function place() {
    const btn = $('#place');
    const stake = Number($('#stake').value || 0);
    if (!state.market) return;
    btn.disabled = true;
    msg('');
    try {
      const { ok, data } = await getJSON('/api/trades', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbol: state.market,
          contractType: state.type,
          stakeCents: Math.round(stake * 100),
          durationTicks: effectiveDuration(),
          barrier: BARRIER_TYPES.includes(state.type) ? chosenBarrier() : null,
          mode: state.mode,
        }),
      });
      if (!ok) {
        msg(data.error || 'Could not place that contract.', 'err');
        post({ type: 'TRADE_REJECTED', mode: state.mode, code: data.code || '', error: data.error || '' });
        return;
      }
      const labels = state.mode === 'real' ? 'Real' : 'Demo';
      msg(`${labels} · ${data.trade.contractLabel || LABELS[data.trade.contractType] || data.trade.contractType} on ${data.trade.symbol} placed at ${nf(data.trade.entrySpot, 5)}.`, 'ok');
      renderBalances(data.balances);
      post({ type: 'TRADE_PLACED', mode: state.mode, trade: data.trade });
      await refreshTrades();
    } catch {
      msg('Network problem — the contract was not placed.', 'err');
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------------ trades
  async function refreshTrades() {
    const { ok, data } = await getJSON('/api/trades?limit=40');
    if (!ok) return;
    state.trades = data.trades || [];
    renderBalances(data.balances);
    const open = state.trades.filter((t) => t.status === 'OPEN');
    const closed = state.trades.filter((t) => t.status !== 'OPEN');

    $('#openBody').innerHTML = open.length
      ? open.map((t) => `<tr>
          <td><b>${t.symbol}</b></td>
          <td>${t.contractLabel || LABELS[t.contractType] || t.contractType}</td>
          <td class="num">${money(t.stakeCents)}</td>
          <td class="num">${nf(t.entrySpot, 2)}</td>
          <td data-exp="${t.expiryEpoch}">${Math.max(0, Math.ceil((t.expiryEpoch - Date.now()) / 1000))}s</td>
          <td class="num">${money(t.payoutCents)}</td></tr>`).join('')
      : '<tr><td colspan="6" class="empty">No open contracts.</td></tr>';

    $('#closedBody').innerHTML = closed.length
      ? closed.slice(0, 12).map((t) => `<tr>
          <td><b>${t.symbol}</b></td>
          <td>${t.contractLabel || LABELS[t.contractType] || t.contractType}</td>
          <td class="num">${money(t.stakeCents)}</td>
          <td class="num">${nf(t.entrySpot, 2)} → ${t.exitSpot === null ? '—' : nf(t.exitSpot, 2)}</td>
          <td><span class="tag ${t.status}">${t.status}</span></td>
          <td class="num ${t.profitCents > 0 ? 'up' : t.profitCents < 0 ? 'down' : ''}">${t.profitCents === null ? '—' : money(t.profitCents)}</td></tr>`).join('')
      : '<tr><td colspan="6" class="empty">Nothing settled yet.</td></tr>';

    const s = data.summary || {};
    $('#summaryFoot').textContent = s.count
      ? `${s.count} contract${s.count === 1 ? '' : 's'} · ${s.won} won · ${s.lost} lost · ${s.open} open · realised ${money(s.realisedCents)}`
      : 'Your settled contracts will appear here.';
  }

  // ------------------------------------------------------------------ loop
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const markets = await getJSON('/api/markets');
      if (markets.ok) { state.symbols = markets.data.symbols; updateMarketQuotes(state.symbols); }
      await loadTicks();
      if (state.chart === 'candles') await loadCandles();
      draw();
      // countdown for open contracts
      for (const cell of document.querySelectorAll('[data-exp]')) {
        cell.textContent = `${Math.max(0, Math.ceil((Number(cell.dataset.exp) - Date.now()) / 1000))}s`;
      }
      if (state.trades.some((t) => t.status === 'OPEN')) await refreshTrades();
    } finally { busy = false; }
  }

  // ------------------------------------------------------------------ embedding
  // The DTrader tab renders this page in a same-origin frame. It announces itself so the shell can
  // hide its spinner, reports orders so the shell can toast them, and accepts the shell's account
  // switches (AUTH_TOKEN / DTRADER_AUTH / ACCOUNT_CHANGED all name the active login id).
  const post = (payload) => {
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ source: 'nova-trader', ...payload }, location.origin); } catch { /* detached */ }
  };
  const modeFromLoginId = (loginid) => (/^VRT/i.test(String(loginid || '')) ? 'demo' : 'real');

  function talkToParent() {
    const embedded = window.parent !== window;
    if (!embedded) return;
    post({ type: 'DTRADER_READY' });
    post({ type: 'COMPONENTS_READY' });
    window.addEventListener('message', (event) => {
      if (event.origin !== location.origin) return;
      const data = event.data || {};
      const loginid = data.active_loginid
        || (data.payload && (data.payload.active_loginid || data.payload.loginid))
        || data.loginid;
      if (loginid && /^(VRT|CR)/i.test(String(loginid))) {
        setMode(modeFromLoginId(loginid));
      } else if (data.type === 'DTRADER_LOGOUT') {
        setMode('demo');
      }
    });
    // late handshake: a shell that mounted before this frame existed may already have sent auth
    post({ type: 'DTRADER_REQUEST_AUTH' });
  }

  // ------------------------------------------------------------------ wiring
  $('#stake').addEventListener('input', updatePreview);
  $('#duration').addEventListener('change', updatePreview);
  $('#place').addEventListener('click', place);
  for (const b of document.querySelectorAll('[data-type]')) {
    if (b.id === 'place') continue;
    b.addEventListener('click', () => setType(b.dataset.type));
  }
  if ($('#barrier')) $('#barrier').addEventListener('input', updatePreview);
  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', async () => {
      state.chart = b.dataset.chart;
      for (const o of document.querySelectorAll('.tabs button')) o.setAttribute('aria-pressed', String(o.dataset.chart === state.chart));
      if (state.chart === 'candles') await loadCandles();
      draw();
    });
  }
  window.addEventListener('resize', draw);

  for (const b of document.querySelectorAll('.acct button')) b.addEventListener('click', () => setMode(b.dataset.acct, { announce: true }));
  // The platform shell and this page are the same origin, so a switch in either one is visible here.
  window.addEventListener('nt:account-changed', () => { state.mode = readMode(); applyAccountMode(); });
  window.addEventListener('storage', (e) => { if (e.key === MODE_KEY) { state.mode = readMode(); applyAccountMode(); } });

  if (params.get('embed') === '1' || window.parent !== window) document.body.classList.add('embed');

  boot().catch(() => {
    $('#whenSignedOut').hidden = false;
    msg('Could not reach the trading API.', 'err');
    post({ type: 'COMPONENTS_READY' });
  });
})();
