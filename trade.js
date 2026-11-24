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
  const state = {
    session: null, symbols: [], market: null, ticks: [], candles: [], chart: 'ticks',
    type: 'CALL', limits: null, payouts: [], trades: [], timer: null,
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
      buildDurations();
      buildStakeChips();
    }

    const markets = await getJSON('/api/markets');
    if (markets.ok && markets.data.symbols.length) {
      state.symbols = markets.data.symbols;
      renderMarkets();
      selectMarket(state.symbols[0].code);
    }

    await refreshTrades();
    state.timer = setInterval(tick, 2000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') tick();
    });
  }

  function renderBalances(balances) {
    if (!balances) return;
    $('#balDemo').textContent = money(balances.demo.totalCents);
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

  function multiplierFor(type, duration) {
    const row = state.payouts.find((p) => p.contractType === type && p.durationTicks === Number(duration));
    return row ? row.multiplierBp : null;
  }

  function updatePreview() {
    const stake = Math.round(Number($('#stake').value || 0) * 100);
    const duration = Number($('#duration').value || 5);
    const bp = multiplierFor(state.type, duration);
    const el = $('#preview');
    if (!Number.isInteger(stake) || stake <= 0) { el.textContent = 'Enter a stake to see the return.'; return; }
    if (!bp) { el.textContent = 'Payout unavailable for that duration.'; return; }
    const payout = Math.floor((stake * bp) / 10000);
    el.innerHTML = `Stake <b>${money(stake)}</b> · payout if right <b>${money(payout)}</b> ·
      profit <b>${money(payout - stake)}</b> · loss if wrong <b>${money(stake)}</b><br>
      Settles on the price ${duration} tick${duration === 1 ? '' : 's'} after entry (≈${duration * 2}s).`;
  }

  function setType(type) {
    state.type = type;
    for (const b of document.querySelectorAll('.types button')) b.setAttribute('aria-pressed', String(b.dataset.type === type));
    const place = $('#place');
    place.dataset.type = type;
    place.textContent = type === 'CALL' ? 'Rise' : 'Fall';
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
          durationTicks: Number($('#duration').value),
        }),
      });
      if (!ok) { msg(data.error || 'Could not place that contract.', 'err'); return; }
      msg(`${data.trade.contractType === 'CALL' ? 'Rise' : 'Fall'} on ${data.trade.symbol} placed at ${nf(data.trade.entrySpot, 5)}.`, 'ok');
      renderBalances(data.balances);
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
          <td>${t.contractType === 'CALL' ? 'Rise' : 'Fall'}</td>
          <td class="num">${money(t.stakeCents)}</td>
          <td class="num">${nf(t.entrySpot, 2)}</td>
          <td data-exp="${t.expiryEpoch}">${Math.max(0, Math.ceil((t.expiryEpoch - Date.now()) / 1000))}s</td>
          <td class="num">${money(t.payoutCents)}</td></tr>`).join('')
      : '<tr><td colspan="6" class="empty">No open contracts.</td></tr>';

    $('#closedBody').innerHTML = closed.length
      ? closed.slice(0, 12).map((t) => `<tr>
          <td><b>${t.symbol}</b></td>
          <td>${t.contractType === 'CALL' ? 'Rise' : 'Fall'}</td>
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

  // ------------------------------------------------------------------ wiring
  $('#stake').addEventListener('input', updatePreview);
  $('#duration').addEventListener('change', updatePreview);
  $('#place').addEventListener('click', place);
  for (const b of document.querySelectorAll('.types button')) b.addEventListener('click', () => setType(b.dataset.type));
  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', async () => {
      state.chart = b.dataset.chart;
      for (const o of document.querySelectorAll('.tabs button')) o.setAttribute('aria-pressed', String(o.dataset.chart === state.chart));
      if (state.chart === 'candles') await loadCandles();
      draw();
    });
  }
  window.addEventListener('resize', draw);

  boot().catch(() => {
    $('#whenSignedOut').hidden = false;
    msg('Could not reach the trading API.', 'err');
  });
})();
