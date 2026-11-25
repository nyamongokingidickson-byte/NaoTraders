/*
 * NovaTrade KE — market data bridge.
 *
 * The mirrored platform is a Deriv client: every chart, ticker and bot run speaks Deriv's JSON
 * protocol over a WebSocket to wss://ws.derivws.com. This script puts the platform's own API in
 * front of that socket, so all of those components read the same simulated feed the rest of the
 * site uses (/api/markets/*) and the same demo wallet (/api/trades).
 *
 * It replaces `window.WebSocket` for Deriv hosts only — everything else (same-origin sockets, if
 * any) passes straight through to the browser's real WebSocket.
 *
 * Honesty rules baked in:
 *   • prices come from /api/markets, which labels them synthetic; nothing is invented here
 *   • `authorize` is never faked: it is answered from the platform's own session (one sign-in at
 *     /login covers the whole site) and names the same two accounts the wallet shows — the demo
 *     wallet, which trades, and the real wallet, which exists but is unfunded because the cashier
 *     is not switched on yet
 *   • unsupported Deriv features return a protocol-shaped error instead of a made-up success
 */
(function () {
  'use strict';

  if (window.__ntBridge) return;
  window.__ntBridge = true;

  var NativeWS = window.WebSocket;
  var DERIV_HOST = /(^|\.)derivws\.com$|(^|\.)deriv\.com$|(^|\.)binary\.com$|(^|\.)binaryws\.com$/i;
  var TICK_MS = 2000;

  var stats = { sockets: 0, requests: 0, served: 0, errors: 0, subscriptions: 0, byType: {}, unknownKeys: {}, log: [] };
  window.__ntBridgeStats = stats;

  // ---------------------------------------------------------------- account bootstrap
  // The app shell boots from localStorage before it makes any request: it reads `accountsList`
  // (loginid → token), `clientAccounts` (loginid → currency/type), `active_loginid`, `authToken`
  // and `account_type`, and only then opens its socket and asks to be authorised. The server puts
  // the account list in the readable `nt_accounts` cookie at sign-in, so this runs synchronously in
  // <head> and the app is already signed in by the time its bundles execute — no second login.
  var ACCOUNTS_COOKIE = 'nt_accounts';

  function readCookie(name) {
    var parts = String(document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }

  function parseAccounts(raw) {
    if (!raw) return null;
    try {
      var data = JSON.parse(raw);
      if (data && data.accounts && data.accounts.length) return data;
    } catch (e) { /* not JSON */ }
    return null;
  }

  // The mirror app deletes any cookie it does not recognise while it boots, so the durable copy of
  // the account list lives in localStorage (written at sign-in and by the session check below).
  function readAccounts() {
    try {
      var stored = parseAccounts(window.localStorage.getItem('nt:client'));
      if (stored) return stored;
    } catch (e) { /* private mode */ }
    var raw = readCookie(ACCOUNTS_COOKIE);
    if (raw) {
      try {
        var b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        var data = parseAccounts(decodeURIComponent(escape(atob(b64))));
        if (data) {
          try { window.localStorage.setItem('nt:client', JSON.stringify(data)); } catch (e) {}
          return data;
        }
      } catch (e) { /* fall through */ }
    }
    return null;
  }

  var CLEARABLE = ['accountsList', 'clientAccounts', 'active_loginid', 'authToken', 'account_type'];

  function seedAppStorage() {
    var data = readAccounts();
    var store = window.localStorage;
    if (!data) {
      // Signed out: clear the app's stale account state so it stops believing it is authorised.
      for (var i = 0; i < CLEARABLE.length; i++) { try { store.removeItem(CLEARABLE[i]); } catch (e) {} }
      return null;
    }
    var wanted = (function () { try { return store.getItem('nt:active-account') === 'real' ? 'real' : 'demo'; } catch (e) { return 'demo'; } })();
    var active = null;
    var accountsList = {};
    var clientAccounts = {};
    for (var j = 0; j < data.accounts.length; j++) {
      var a = data.accounts[j];
      if (!a || !a.loginid) continue;
      if (a.mode === wanted) active = a;
      accountsList[a.loginid] = a.token;
      clientAccounts[a.loginid] = {
        loginid: a.loginid, token: a.token, currency: a.currency || 'USD',
        is_virtual: a.mode === 'demo' ? 1 : 0, account_type: a.mode === 'demo' ? 'demo' : 'real',
      };
    }
    if (!active) active = data.accounts[0];
    try {
      store.setItem('accountsList', JSON.stringify(accountsList));
      store.setItem('clientAccounts', JSON.stringify(clientAccounts));
      store.setItem('active_loginid', active.loginid);
      store.setItem('authToken', active.token);
      store.setItem('account_type', active.mode === 'demo' ? 'demo' : 'real');
    } catch (e) { /* private mode: the app will simply ask to sign in */ }
    return { mode: active.mode, loginid: active.loginid, accounts: data.accounts };
  }

  var bootstrap = seedAppStorage();
  window.__ntAccount = bootstrap;

  // Nothing stored yet. A session may still exist (old sign-in, cleared browser storage), so ask
  // the server once and, if it knows who this is, seed and reload so the app boots authorised.
  if (!bootstrap) {
    var tried = false;
    try { tried = sessionStorage.getItem('nt:seed-tried') === '1'; } catch (e) {}
    if (!tried) {
      api('/api/auth/session').then(function (r) {
        try {
          if (r.ok && r.body.client) {
            localStorage.setItem('nt:client', JSON.stringify(r.body.client));
            sessionStorage.setItem('nt:seed-tried', '1');
            window.location.reload();
          } else if (!r.ok) {
            localStorage.removeItem('nt:client');
          }
        } catch (e) { /* nothing more we can do */ }
      }).catch(function () { /* offline: the header still explains the state */ });
    }
  } else {
    try { sessionStorage.removeItem('nt:seed-tried'); } catch (e) {}
  }
  // The header's account switch writes the choice then fires this; keep the two in step.
  document.addEventListener('nt:account-changed', function () {
    var next = seedAppStorage();
    window.__ntAccount = next;
    // The app shell reads the account list once, at boot, and authorises with it. On the pages that
    // host it, a switch therefore reloads into the other account instead of pretending to switch
    // under a running client (a bot is never left trading the account you just left).
    if (document.querySelector('script[src*="static/js/index."]')) {
      try { window.location.reload(); } catch (e) { /* nothing to reload */ }
    }
  });
  // A stale readable cookie (session expired server-side) still boots the app as signed in; the
  // first api() call answers 401 and the bridge reports InvalidToken, which is correct and visible.

  // ---------------------------------------------------------------- off-platform calls
  // The bot builder reports each run to Deriv's analytics service (dbot-conf on appspot). That host is
  // not part of this platform and answers 422 for these payloads, which used to surface as an error
  // every time a bot ran. The report carries nothing this platform needs, so answer it locally: no
  // failed request, no console error, and no trade data leaving the site.
  var DERIV_ANALYTICS = /dbot-conf|deriv-bi-reporting|(^|\/\/)([^/]*\.)?appspot\.com/i;
  if (typeof window.fetch === 'function' && !window.fetch.__ntPatched) {
    var nativeFetch = window.fetch.bind(window);
    var patched = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (DERIV_ANALYTICS.test(url)) {
        return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return nativeFetch(input, init);
    };
    patched.__ntPatched = true;
    window.fetch = patched;
  }

  // ---------------------------------------------------------------- helpers
  function api(path, options) {
    return fetch(path, Object.assign({ credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } }, options || {}))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          return { ok: res.ok, status: res.status, body: body };
        });
      });
  }

  function parse(message) {
    try { return typeof message === 'string' ? JSON.parse(message) : JSON.parse(String(message)); } catch (e) { return null; }
  }

  // Deriv/our-feed symbol aliases. Unknown symbols fall back to a stable market so a request never
  // hangs, but the response echoes the requested symbol back.
  var ALIASES = {
    '1HZ10V': 'R_10', '1HZ25V': 'R_25', '1HZ50V': 'R_50', '1HZ75V': 'R_75', '1HZ100V': 'R_100',
    'R_10': 'R_10', 'R_25': 'R_25', 'R_50': 'R_50', 'R_75': 'R_75', 'R_100': 'R_100',
    'frxEURUSD': 'frxEURUSD', 'frxGBPUSD': 'frxGBPUSD', 'frxUSDJPY': 'frxUSDJPY', 'frxXAUUSD': 'frxXAUUSD',
    'cryBTCUSD': 'cryBTCUSD', 'cryETHUSD': 'cryETHUSD', 'cryXRPUSD': 'cryXRPUSD',
  };
  function mapSymbol(symbol) {
    if (!symbol) return 'R_100';
    if (ALIASES[symbol]) return ALIASES[symbol];
    var s = String(symbol).toUpperCase();
    if (ALIASES[s]) return ALIASES[s];
    if (/^R_\d+$/.test(s)) return 'R_100';           // any other volatility index → R_100 shape
    if (/^(BTC|CRYBTC)/.test(s) || /BTC/.test(s)) return 'cryBTCUSD';
    if (/^(ETH|CRYETH)/.test(s) || /ETH/.test(s)) return 'cryETHUSD';
    if (/XRP/.test(s)) return 'cryXRPUSD';
    if (/EUR/.test(s)) return 'frxEURUSD';
    if (/GBP/.test(s)) return 'frxGBPUSD';
    if (/JPY/.test(s)) return 'frxUSDJPY';
    if (/XAU|GOLD/.test(s)) return 'frxXAUUSD';
    return 'R_100';
  }

  // Mirrors digitMultiplierBp in src/cloud/trading.js so the quote a bot or bulk trader sees is the
  // payout the server will actually pay: (1 - 4% margin) / probability of winning.
  function digitMultiplierBp(type, barrier) {
    var b = Number(barrier);
    var p;
    if (type === 'DIGITEVEN' || type === 'DIGITODD') p = 0.5;
    else if (type === 'DIGITOVER') p = (9 - b) / 10;
    else if (type === 'DIGITUNDER') p = b / 10;
    else if (type === 'DIGITMATCH') p = 0.1;
    else if (type === 'DIGITDIFF') p = 0.9;
    else return null;
    if (!(p > 0) || p > 1) return null;
    return Math.round(((1 - 0.04) / p) * 10000);
  }

  function digitsFor(market) {
    var meta = market && market.digits != null ? market.digits : 2;
    return meta;
  }

  var marketCache = { at: 0, byCode: {} };
  function loadMarkets() {
    var now = Date.now();
    if (now - marketCache.at < 1500 && Object.keys(marketCache.byCode).length) return Promise.resolve(marketCache.byCode);
    return api('/api/markets').then(function (r) {
      var map = {};
      if (r.ok && r.body.symbols) for (var i = 0; i < r.body.symbols.length; i++) map[r.body.symbols[i].code] = r.body.symbols[i];
      marketCache = { at: now, byCode: map };
      return map;
    }).catch(function () { return marketCache.byCode; });
  }

  // ---------------------------------------------------------------- framing
  function BridgeSocket(url) {
    var self = this;
    self.url = String(url);
    self.readyState = 0; // CONNECTING
    self.protocol = '';
    self.extensions = '';
    self.bufferedAmount = 0;
    self.binaryType = 'blob';
    self._listeners = { open: [], message: [], close: [], error: [] };
    self._subs = {};    // req_id -> { kind, symbol, timer }
    self._closed = false;
    stats.sockets += 1;

    setTimeout(function () {
      if (self._closed) return;
      self.readyState = 1;
      self._emit('open', { type: 'open' });
    }, 30);
  }

  BridgeSocket.prototype._emit = function (type, event) {
    var list = this._listeners[type] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i].call(this, event); } catch (e) { /* a listener threw; never break the socket */ }
    }
    var handler = this['on' + type];
    if (typeof handler === 'function') {
      try { handler.call(this, event); } catch (e) { /* ignore */ }
    }
  };

  BridgeSocket.prototype._deliver = function (payload) {
    if (this._closed) return;
    stats.served += 1;
    var data = JSON.stringify(payload);
    this._emit('message', { type: 'message', data: data, target: this });
  };

  BridgeSocket.prototype.addEventListener = function (type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  };
  BridgeSocket.prototype.removeEventListener = function (type, fn) {
    var list = this._listeners[type] || [];
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  BridgeSocket.prototype.dispatchEvent = function () { return true; };

  BridgeSocket.prototype.send = function (raw) {
    var self = this;
    var req = parse(raw);
    if (!req) return;
    var type = requestType(req);
    stats.requests += 1;
    stats.byType[type] = (stats.byType[type] || 0) + 1;
    if (type === 'unknown') {
      var key = Object.keys(req).filter(function (k) { return k !== 'req_id'; }).join(',');
      stats.unknownKeys[key] = (stats.unknownKeys[key] || 0) + 1;
    }
    stats.log.push({
      t: type, at: Date.now(),
      symbol: req.symbol || req.ticks || req.ticks_history || req.candles || '',
      subscribe: req.subscribe ? 1 : 0, contract: req.contract_id || '',
      detail: (req.buy || req.proposal)
        ? { buy: req.buy, proposal: req.proposal, price: req.price, underlying: (req.parameters || {}).underlying_symbol || req.symbol,
            contract_type: req.contract_type || (req.parameters || {}).contract_type || '',
            barrier: req.barrier || (req.parameters || {}).barrier || '' }
        : null,
    });
    if (stats.log.length > 200) stats.log.shift();

    Promise.resolve()
      .then(function () { return handle(self, req, type); })
      .catch(function (err) {
        stats.errors += 1;
        self._deliver(errorFor(req, type, 'InternalError', (err && err.message) || 'bridge failure'));
      });
  };

  BridgeSocket.prototype.close = function () {
    if (this._closed) return;
    this._closed = true;
    this.readyState = 3;
    for (var id in this._subs) if (this._subs[id].timer) clearInterval(this._subs[id].timer);
    this._subs = {};
    this._emit('close', { type: 'close', code: 1000, reason: 'bridge closed', wasClean: true });
  };

  function requestType(req) {
    if (req.ping) return 'ping';
    if (req.ticks) return 'ticks';
    if (req.ticks_history) return 'ticks_history';
    if (req.candles) return 'candles';
    if (req.active_symbols) return 'active_symbols';
    if (req.contracts_for) return 'contracts_for';
    if (req.proposal) return 'proposal';
    if (req.buy) return 'buy';
    if (req.sell) return 'sell';
    if (req.portfolio) return 'portfolio';
    if (req.profit_table) return 'profit_table';
    if (req.proposal_open_contract) return 'proposal_open_contract';
    if (req.balance) return 'balance';
    if (req.statement) return 'statement';
    if (req.authorize) return 'authorize';
    if (req.get_settings) return 'get_settings';
    if (req.get_account_status) return 'get_account_status';
    if (req.landing_company) return 'landing_company';
    if (req.residence_list) return 'residence_list';
    if (req.states_list) return 'states_list';
    if (req.forget_all) return 'forget_all';
    if (req.forget) return 'forget';
    if (req.website_status) return 'website_status';
    if (req.trading_times) return 'trading_times';
    if (req.payout_currencies) return 'payout_currencies';
    if (req.time) return 'time';
    if (req.transaction) return 'transaction';
    if (req.exchange_rates) return 'exchange_rates';
    if (req.ping_stream) return 'ping_stream';
    return 'unknown';
  }

  function errorFor(req, type, code, message) {
    return { msg_type: type, echo_req: req, req_id: req.req_id, error: { code: code, message: message } };
  }

  var NOT_SUPPORTED = 'This platform serves simulated market data and demo contracts only.';

  // Which wallet this socket trades with. Set by authorize, and refreshed from the boot state.
  function modeOf(socket) {
    if (socket && socket._mode) return socket._mode;
    if (window.__ntAccount && window.__ntAccount.mode) return window.__ntAccount.mode;
    return 'demo';
  }
  function loginidOf(mode) {
    var list = (window.__ntAccount && window.__ntAccount.accounts) || [];
    for (var i = 0; i < list.length; i++) if (list[i].mode === mode) return list[i].loginid;
    return mode === 'real' ? 'CR00000000' : 'VRTC00000000';
  }
  function modeOfToken(token) {
    if (token === 'nt-real') return 'real';
    if (token === 'nt-demo') return 'demo';
    return null;
  }
  var REAL_UNFUNDED = 'Your real account has no funds yet. Deposits are not available on this platform, so switch to the demo account to trade.';
  // API error codes → the protocol codes a Deriv client knows how to display.
  var ERROR_ALIASES = { INSUFFICIENT_FUNDS: 'InsufficientBalance', TOO_MANY_OPEN_TRADES: 'MaxContractsReached', EXPOSURE_LIMIT: 'MaxContractsReached' };

  // ---------------------------------------------------------------- handlers
  function handle(socket, req, type) {
    if (type === 'ping') {
      return socket._deliver({ msg_type: 'ping', ping: 'pong', echo_req: req, req_id: req.req_id });
    }
    if (type === 'time') {
      return socket._deliver({ msg_type: 'time', time: Math.floor(Date.now() / 1000), echo_req: req, req_id: req.req_id });
    }
    if (type === 'website_status') {
      return socket._deliver({
        msg_type: 'website_status',
        website_status: {
          site_status: 'up',
          api_status: 'up',
          currencies_config: { USD: { is_crypto: false, type: 'fiat', name: 'US Dollar' } },
          clients_country: 'KE',
        },
        echo_req: req, req_id: req.req_id,
      });
    }
    if (type === 'payout_currencies') {
      return socket._deliver({ msg_type: 'payout_currencies', payout_currencies: ['USD'], echo_req: req, req_id: req.req_id });
    }
    if (type === 'active_symbols') {
      return loadMarkets().then(function (map) {
        var rows = Object.keys(map).map(function (code) {
          var m = map[code];
          return {
            symbol: code,
            display_name: m.name,
            market: m.group === 'volatility' ? 'synthetic_index' : m.group,
            submarket: m.group === 'volatility' ? 'random_index' : m.group,
            market_display_name: m.group,
            submarket_display_name: m.group,
            pip: Math.pow(10, -m.digits),
            exchange_is_open: 1,
            is_trading_suspended: 0,
            allow_forward_starting: 1,
            spot: m.last,
            display_order: 1,
          };
        });
        socket._deliver({ msg_type: 'active_symbols', active_symbols: rows, echo_req: req, req_id: req.req_id });
      });
    }
    if (type === 'contracts_for') {
      return loadMarkets().then(function () {
        var symbol = mapSymbol(req.contracts_for);
        var durations = [1, 2, 3, 5, 10, 15, 30];
        var contracts = [];
        ['CALL', 'PUT'].forEach(function (ct) {
          durations.forEach(function (d) {
            contracts.push({
              contract_type: ct,
              contract_display: ct === 'CALL' ? 'Rise' : 'Fall',
              min_contract_duration: d + 't',
              max_contract_duration: d + 't',
              expiry_type: 'tick',
              barrier: null,
              barriers: 0,
              start_type: 'spot',
            });
          });
        });
        socket._deliver({
          msg_type: 'contracts_for',
          contracts_for: {
            available: contracts,
            close: null,
            feed_license: 'demo',
            hit_count: contracts.length,
            open: 1,
            spot: null,
            start_type: 'spot',
          },
          echo_req: req, req_id: req.req_id,
        });
      });
    }
    if (type === 'trading_times') {
      var today = new Date();
      return socket._deliver({
        msg_type: 'trading_times',
        trading_times: { markets: [{ name: 'synthetic_index', submarkets: [{ name: 'random_index', symbols: [{ symbol: 'R_100', times: { open: ['00:00:00'], close: ['23:59:59'] } }] }] }] },
        echo_req: req, req_id: req.req_id,
      });
    }
    if (type === 'ticks' || type === 'ticks_history') {
      return handleTicks(socket, req, type);
    }
    if (type === 'candles') {
      var m = mapSymbol(req.candles);
      return api('/api/markets/' + encodeURIComponent(m) + '/candles?granularity=' + (req.granularity || 60) + '&count=' + (req.count || 60))
        .then(function (r) {
          var rows = (r.body.candles || []).map(function (c) {
            return { epoch: Math.floor(c.epoch / 1000), open: c.open, high: c.high, low: c.low, close: c.close };
          });
          socket._deliver({ msg_type: 'candles', candles: rows, echo_req: req, req_id: req.req_id });
        });
    }
    if (type === 'proposal') {
      return handleProposal(socket, req);
    }
    if (type === 'buy') {
      return handleBuy(socket, req);
    }
    if (type === 'portfolio') {
      return api('/api/trades?limit=50&mode=' + modeOf(socket)).then(function (r) {
        if (!r.ok) return socket._deliver(errorFor(req, 'portfolio', 'AuthorizationRequired', 'Sign in to see contracts.'));
        var open = (r.body.trades || []).filter(function (t) { return t.status === 'OPEN'; });
        socket._deliver({
          msg_type: 'portfolio',
          portfolio: {
            contracts: open.map(function (t) {
              return {
                contract_id: t.id, contract_type: t.contractType, symbol: t.symbol,
                buy_price: t.stakeCents / 100, payout: t.payoutCents / 100,
                purchase_time: Math.floor(t.openedAt / 1000), expiry_time: Math.floor(t.expiryEpoch / 1000),
                entry_spot: t.entrySpot, longcode: (t.contractType === 'CALL' ? 'Rise' : 'Fall') + ' ' + t.symbol,
                shortcode: t.id, current_spot: t.entrySpot, is_valid_to_sell: 0,
              };
            }),
          },
          echo_req: req, req_id: req.req_id,
        });
      });
    }
    if (type === 'profit_table' || type === 'statement') {
      return api('/api/trades?limit=50&mode=' + modeOf(socket)).then(function (r) {
        var list = (r.body.trades || []).filter(function (t) { return t.status !== 'OPEN'; });
        socket._deliver({
          msg_type: type,
          profit_table: { transactions: list.map(function (t) {
            return {
              app_id: 36300, contract_id: t.id, action_type: t.profitCents >= 0 ? 'sell' : 'buy',
              amount: (t.profitCents || 0) / 100, buy_price: t.stakeCents / 100,
              contract_type: t.contractType, symbol: t.symbol, transaction_time: Math.floor((t.settledAt || t.openedAt) / 1000),
              shortcode: t.id, longcode: t.contractType + ' ' + t.symbol, purchase_time: Math.floor(t.openedAt / 1000),
              sell_time: Math.floor((t.settledAt || 0) / 1000), duration: t.durationTicks + 't',
            };
          }) },
          echo_req: req, req_id: req.req_id,
        });
      });
    }
    if (type === 'balance') {
      return api('/api/wallet').then(function (r) {
        if (!r.ok) return socket._deliver(errorFor(req, 'balance', 'AuthorizationRequired', 'Sign in to see your balance.'));
        var mode = modeOf(socket);
        var wallet = (mode === 'real' ? r.body.real : r.body.demo) || { totalCents: 0 };
        socket._deliver({
          msg_type: 'balance',
          balance: {
            balance: wallet.totalCents / 100, currency: 'USD',
            loginid: loginidOf(mode), account_type: mode, is_virtual: mode === 'demo' ? 1 : 0,
          },
          echo_req: req, req_id: req.req_id,
        });
        if (req.subscribe) {
          var id = req.req_id || 'balance';
          var sock = socket;
          if (socket._subs[id] && socket._subs[id].timer) clearInterval(socket._subs[id].timer);
          socket._subs[id] = { kind: 'balance', timer: setInterval(function () {
            api('/api/wallet').then(function (w) {
              if (!w.ok) return;
              var m2 = modeOf(sock);
              var w2 = (m2 === 'real' ? w.body.real : w.body.demo) || { totalCents: 0 };
              sock._deliver({ msg_type: 'balance', balance: { balance: w2.totalCents / 100, currency: 'USD', loginid: loginidOf(m2), account_type: m2, is_virtual: m2 === 'demo' ? 1 : 0 }, echo_req: req, req_id: req.req_id });
            });
          }, 3000) };
        }
      });
    }
    if (type === 'forget' || type === 'forget_all') {
      var ids = type === 'forget' ? [req.forget] : Object.keys(socket._subs);
      if (type === 'forget' && req.forget === 'ticks') ids = Object.keys(socket._subs);   // app-wide unsubscribe
      for (var i = 0; i < ids.length; i++) {
        var sub = socket._subs[ids[i]];
        if (sub && sub.timer) clearInterval(sub.timer);
        delete socket._subs[ids[i]];
      }
      return socket._deliver({ msg_type: type, forget: type === 'forget' ? 1 : ids, echo_req: req, req_id: req.req_id });
    }
    if (type === 'authorize') {
      // Not faked: the answer is the platform's own session. The token only says which of the two
      // accounts the app wants; the credential is the HttpOnly session cookie the request carries.
      return Promise.all([api('/api/auth/session'), api('/api/wallet')]).then(function (out) {
        var session = out[0], wallet = out[1];
        if (!session.ok || !session.body.user) {
          return socket._deliver(errorFor(req, 'authorize', 'InvalidToken', 'Sign in to NovaTrade KE to use the trading tools.'));
        }
        var user = session.body.user;
        var mode = modeOfToken(req.authorize) || modeOf(socket);
        socket._mode = mode;
        var demo = (wallet.body && wallet.body.demo) || { totalCents: 0 };
        var real = (wallet.body && wallet.body.real) || { totalCents: 0 };
        var accounts = (window.__ntAccount && window.__ntAccount.accounts) || [];
        var accountList = accounts.length ? accounts.map(function (a) {
          return { loginid: a.loginid, currency: a.currency || 'USD', is_virtual: a.mode === 'demo' ? 1 : 0, account_type: a.mode };
        }) : [{ loginid: loginidOf('demo'), currency: 'USD', is_virtual: 1, account_type: 'demo' },
              { loginid: loginidOf('real'), currency: 'USD', is_virtual: 0, account_type: 'real' }];
        var balance = (mode === 'real' ? real.totalCents : demo.totalCents) / 100;
        socket._deliver({
          msg_type: 'authorize',
          echo_req: req, req_id: req.req_id,
          authorize: {
            email: user.email,
            user_id: user.id,
            country: 'ke',
            currency: 'USD',
            balance: balance,
            loginid: loginidOf(mode),
            is_virtual: mode === 'demo' ? 1 : 0,
            landing_company_name: 'svg',
            landing_company_fullname: 'NovaTrade KE (simulated)',
            scopes: ['read', 'trade', 'trading_information', 'payments'],
            preferred_language: 'EN',
            account_list: accountList,
            upgradeable_landing_companies: [],
          },
        });
      });
    }
    if (type === 'get_settings') {
      return api('/api/auth/session').then(function (r) {
        if (!r.ok) return socket._deliver(errorFor(req, 'get_settings', 'AuthorizationRequired', 'Sign in to continue.'));
        socket._deliver({
          msg_type: 'get_settings', echo_req: req, req_id: req.req_id,
          get_settings: {
            country_code: 'ke', email_consent: 0, email_consent_prompt: '',
            first_name: '', last_name: '', phone: '', residence: 'ke', scope: ['read', 'trade'],
          },
        });
      });
    }
    if (type === 'get_account_status') {
      return socket._deliver({
        msg_type: 'get_account_status', echo_req: req, req_id: req.req_id,
        get_account_status: { authentication: { attempts: { count: 0, available: 3 } }, status: ['not_authenticated'], risk_classification: 'low' },
      });
    }
    if (type === 'landing_company' || type === 'residence_list' || type === 'states_list') {
      return socket._deliver(errorFor(req, type, 'UnrecognisedRequest', 'Not needed on this platform.'));
    }
    if (type === 'proposal_open_contract') {
      return streamOpenContract(socket, req);
    }
    if (type === 'transaction') {
      return streamTransactions(socket, req);
    }
    if (type === 'sell' || type === 'ping_stream') {
      return socket._deliver(errorFor(req, type, 'UnsupportedFeature', NOT_SUPPORTED));
    }
    return socket._deliver(errorFor(req, type || 'unknown', 'UnrecognisedRequest', 'The market data bridge does not implement "' + type + '".'));
  }

  function handleTicks(socket, req, type) {
    var requested = type === 'ticks' ? req.ticks : req.ticks_history;
    var market = mapSymbol(requested);
    if (type === 'ticks_history') {
      var count = req.count || 60;
      var style = req.style || 'ticks';
      if (style === 'candles') {
        var granularity = Number(req.granularity || 60);
        return api('/api/markets/' + encodeURIComponent(market) + '/candles?granularity=' + granularity + '&count=' + count)
          .then(function (r) {
            var rows = (r.body.candles || []).map(function (c) {
              return { epoch: Math.floor(c.epoch / 1000), open: c.open, high: c.high, low: c.low, close: c.close };
            });
            socket._deliver({ msg_type: 'candles', candles: rows, echo_req: req, req_id: req.req_id });
            // A candle chart keeps listening: stream the forming candle as an `ohlc`.
            if (req.subscribe) streamOhlc(socket, req, requested, market, granularity);
          });
      }
      return api('/api/markets/' + encodeURIComponent(market) + '/ticks?count=' + count).then(function (r) {
        var list = (r.body.ticks || []);
        socket._deliver({
          msg_type: 'history',
          echo_req: req, req_id: req.req_id,
          history: {
            prices: list.map(function (t) { return t.quote; }),
            times: list.map(function (t) { return Math.floor(t.epoch / 1000); }),
          },
        });
        // `subscribe: 1` on a tick history means "and then keep sending me ticks", which is exactly
        // how the bot builder starts listening before it trades.
        if (req.subscribe) streamTicks(socket, req, requested, market, count);
      });
    }

    // ticks (subscribe) — one immediate tick, then one every 2 s while subscribed
    return streamTicks(socket, req, requested, market, 0);
  }

  /** One immediate tick, then one every TICK_MS until the client forgets the subscription. */
  function streamTicks(socket, req, requested, market, skipInitial) {
    return loadMarkets().then(function (map) {
      var meta = map[market] || { digits: 2, last: 0 };
      var digits = digitsFor(meta);
      var id = req.req_id || ('ticks:' + market);
      var send = function (quote, epoch) {
        socket._deliver({
          msg_type: 'tick',
          echo_req: req, req_id: req.req_id,
          tick: {
            symbol: requested, quote: quote, epoch: Math.floor(epoch / 1000),
            pip_size: Math.pow(10, -digits), id: String(Math.floor(epoch / 1000)),
          },
        });
      };
      if (!skipInitial) {
        api('/api/markets/' + encodeURIComponent(market) + '/ticks?count=1').then(function (r) {
          var t = (r.body.ticks || [])[0];
          if (t) send(t.quote, t.epoch);
        });
      }
      if (!req.subscribe) return;
      stats.subscriptions += 1;
      if (socket._subs[id] && socket._subs[id].timer) clearInterval(socket._subs[id].timer);
      socket._subs[id] = { kind: 'ticks', symbol: market, timer: setInterval(function () {
        api('/api/markets/' + encodeURIComponent(market) + '/ticks?count=1').then(function (r) {
          var t = (r.body.ticks || [])[0];
          if (t) send(t.quote, t.epoch);
        });
      }, TICK_MS) };
    });
  }

  /** The forming candle, refreshed every tick, shaped as an `ohlc` message. */
  function streamOhlc(socket, req, requested, market, granularity) {
    stats.subscriptions += 1;
    var id = req.req_id || ('ohlc:' + market);
    var periodMs = granularity * 1000;
    var send = function () {
      var now = Date.now();
      var start = Math.floor(now / periodMs) * periodMs;
      api('/api/markets/' + encodeURIComponent(market) + '/candles?granularity=' + granularity + '&count=2').then(function (r) {
        var rows = r.body.candles || [];
        var last = rows[rows.length - 1];
        if (!last) return;
        socket._deliver({
          msg_type: 'ohlc',
          echo_req: req, req_id: req.req_id,
          ohlc: {
            open: last.open, high: last.high, low: last.low, close: last.close,
            epoch: Math.floor((last.epoch || start) / 1000), granularity,
            id: String(Math.floor(start / 1000)), symbol: requested,
          },
        });
      });
    };
    send();
    if (socket._subs[id] && socket._subs[id].timer) clearInterval(socket._subs[id].timer);
    socket._subs[id] = { kind: 'ohlc', symbol: market, timer: setInterval(send, TICK_MS) };
  }

  function handleProposal(socket, req) {
    if (modeOf(socket) === 'real') {
      return Promise.resolve(api('/api/wallet')).then(function (w) {
        var real = (w.body && w.body.real) || { totalCents: 0 };
        if (real.totalCents <= 0) {
          return socket._deliver(errorFor(req, 'proposal', 'InsufficientBalance', REAL_UNFUNDED));
        }
        return buildProposal(socket, req);
      });
    }
    return buildProposal(socket, req);
  }

  function buildProposal(socket, req) {
    var market = mapSymbol(req.symbol || (req.proposal && req.proposal.symbol));
    var type = String(req.contract_type || (req.proposal && req.proposal.contract_type) || 'CALL').toUpperCase();
    var duration = Number(req.duration || 5);
    var stake = Number(req.amount || 10);
    var barrier = req.barrier !== undefined ? req.barrier : (req.proposal && req.proposal.barrier);
    var isDigit = /^DIGIT/.test(type);
    if (isDigit) duration = 1;
    return Promise.all([loadMarkets(), api('/api/trading/limits')]).then(function (out) {
      var map = out[0], limits = out[1];
      var meta = map[market] || { last: 0, digits: 2 };
      var ladder = (limits.body.payouts || []).filter(function (p) { return p.contractType === type; });
      var row = ladder.filter(function (p) { return p.durationTicks === duration; })[0] || ladder[0];
      if (isDigit) { var digitBp = digitMultiplierBp(type, Number(barrier)); if (digitBp) row = { multiplierBp: digitBp }; }
      if (!row) row = { multiplierBp: 18800 };
      // Deriv quotes proposals in currency units to the cent (stake 10 @ 1.88x => 18.8), not floored dollars.
      var payout = Math.round((stake * row.multiplierBp) / 100) / 100;
      socket._deliver({
        msg_type: 'proposal',
        echo_req: req, req_id: req.req_id,
        proposal: {
          id: 'prop-' + market + '-' + duration,
          ask_price: stake,
          payout,
          spot: meta.last,
          spot_time: Math.floor(Date.now() / 1000),
          display_value: String(payout),
          date_start: Math.floor(Date.now() / 1000),
          longcode: contractLabel(type) + ' in ' + market + ' for ' + duration + ' tick' + (duration === 1 ? '' : 's'),
          contract_type: type,
          symbol: market,
          duration: duration + 't',
          barrier: barrier === null || barrier === undefined ? '0' : String(barrier),
          spot_time_expiry: Math.floor(Date.now() / 1000) + duration * 2,
        },
      });
    });
  }

  // Deriv contract codes and the names the platform UI shows for them.
  var CONTRACT_NAMES = {
    CALL: 'Rise', PUT: 'Fall',
    DIGITEVEN: 'Even', DIGITODD: 'Odd',
    DIGITOVER: 'Over', DIGITUNDER: 'Under',
    DIGITMATCH: 'Matches', DIGITDIFF: 'Differs',
  };
  function contractLabel(type) { return CONTRACT_NAMES[type] || type; }

  function handleBuy(socket, req) {
    var params = req.parameters || {};
    var market = mapSymbol(params.symbol || params.underlying_symbol || req.symbol || (ALIASES[req.buy] ? req.buy : ''));
    var amount = Number(params.amount || req.price || 10);
    var type = String((req.parameters && req.parameters.contract_type) || req.contract_type || 'CALL').toUpperCase();
    var duration = Number((req.parameters && req.parameters.duration) || req.duration || 5);
    // Digit contracts carry their barrier as a digit; the server settles on the expiry tick's last digit.
    var isDigit = /^DIGIT/.test(type);
    var barrier = params.barrier !== undefined ? params.barrier
      : (req.barrier !== undefined ? req.barrier : (req.parameters && req.parameters.barrier));
    barrier = barrier === undefined || barrier === null || barrier === '' ? null : Number(barrier);
    if (isDigit) duration = 1;

    return Promise.all([api('/api/auth/session'), api('/api/markets/' + encodeURIComponent(market) + '/ticks?count=1')]).then(function (out) {
      var session = out[0], tick = (out[1].body.ticks || [])[0];
      if (!session.ok) {
        return socket._deliver(errorFor(req, 'buy', 'AuthorizationRequired', 'Sign in with NovaTrade KE to trade.'));
      }
      var mode = modeOf(socket);
      return api('/api/trades', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbol: market,
          contractType: type,
          stakeCents: Math.round(amount * 100),
          durationTicks: duration,
          mode: mode,
          barrier: isDigit ? barrier : null,
        }),
      }).then(function (res) {
        if (!res.ok) {
          var code = ERROR_ALIASES[res.body.code] || res.body.code || 'ContractCreationFailure';
          var message = res.body.error || 'Could not create that contract.';
          if (mode === 'real' && res.body.code === 'INSUFFICIENT_FUNDS') message = REAL_UNFUNDED;
          return socket._deliver(errorFor(req, 'buy', code, message));
        }
        var t = res.body.trade;
        socket._deliver({
          msg_type: 'buy',
          echo_req: req, req_id: req.req_id,
          buy: {
            contract_id: t.id,
            transaction_id: t.id,
            buy_price: t.stakeCents / 100,
            payout: t.payoutCents / 100,
            start_time: Math.floor(t.entryEpoch / 1000),
            purchase_time: Math.floor(t.entryEpoch / 1000),
            balance_after: ((res.body.balances || {})[mode] || {}).totalCents / 100,
            longcode: contractLabel(t.contractType) + ' ' + t.symbol,
            shortcode: t.id,
          },
        });
      });
    });
  }

  // ---------------------------------------------------------------- contracts
  /** A trades row in the shape `proposal_open_contract` subscribers expect. */
  function contractView(t) {
    var stake = t.stakeCents / 100;
    var payout = t.payoutCents / 100;
    var settled = t.status !== 'OPEN';
    var profit = settled ? (t.profitCents || 0) / 100 : 0;
    var entry = t.entrySpot;
    var exit = t.exitSpot === null || t.exitSpot === undefined ? null : t.exitSpot;
    return {
      contract_id: t.id,
      transaction_ids: { buy: t.id, sell: settled ? 'sell-' + t.id : undefined },
      buy_price: stake,
      payout,
      profit,
      profit_percentage: stake ? Number(((profit / stake) * 100).toFixed(2)) : 0,
      contract_type: t.contractType,
      symbol: t.symbol,
      longcode: contractLabel(t.contractType) + ' in ' + t.symbol + ' for ' + t.durationTicks + ' tick' + (t.durationTicks === 1 ? '' : 's'),
      entry_spot: entry,
      entry_tick: entry,
      current_spot: settled ? exit : entry,
      current_spot_time: Math.floor((t.settledAt || t.entryEpoch) / 1000),
      exit_tick: exit,
      status: settled ? t.status : 'open',
      is_sold: settled ? 1 : 0,
      is_valid_to_sell: 0,          // no early close on this platform
      is_expired: settled ? 1 : 0,
      purchase_time: Math.floor(t.entryEpoch / 1000),
      sell_time: settled ? Math.floor((t.settledAt || t.expiryEpoch) / 1000) : undefined,
      sell_price: settled ? (t.status === 'WON' ? payout : t.status === 'VOID' ? stake : 0) : 0,
      date_start: Math.floor(t.entryEpoch / 1000),
      date_expiry: t.expiryEpoch ? Math.floor(t.expiryEpoch / 1000) : undefined,
      tick_count: t.durationTicks,
      tick_passed: settled ? t.durationTicks : Math.min(t.durationTicks - 1, Math.max(0, Math.round((Date.now() - t.entryEpoch) / TICK_MS))),
      underlying: t.symbol,
      mode: t.mode || 'demo',
    };
  }

  /**
   * `proposal_open_contract`: one row, then — if the client subscribed — one update per tick until
   * the contract settles. Settlement happens on the server (lazily, when the trade is read), so this
   * poll is also what moves the contract to WON/LOST and returns the payout to the wallet.
   */
  function streamOpenContract(socket, req) {
    var id = req.contract_id;
    // With no contract_id this is Deriv's "every open contract on my account" subscription, which
    // is how the bot builder follows the contracts it buys until they settle.
    if (!id) return streamAllContracts(socket, req);
    var stop = function () {
      var sub = socket._subs[req.req_id || id];
      if (sub && sub.timer) clearInterval(sub.timer);
      delete socket._subs[req.req_id || id];
    };
    var read = function () {
      return api('/api/trades/' + encodeURIComponent(id)).then(function (r) {
        if (!r.ok) {
          stop();
          return socket._deliver(errorFor(req, 'proposal_open_contract', r.body.code || 'ContractNotFound', r.body.error || 'Unknown contract.'));
        }
        var view = contractView(r.body.trade);
        socket._deliver({ msg_type: 'proposal_open_contract', proposal_open_contract: view, echo_req: req, req_id: req.req_id });
        if (view.is_sold) stop();
        return view;
      });
    };
    return read().then(function (view) {
      if (!req.subscribe || !view || view.is_sold) return;
      stats.subscriptions += 1;
      var key = req.req_id || id;
      if (socket._subs[key] && socket._subs[key].timer) clearInterval(socket._subs[key].timer);
      socket._subs[key] = { kind: 'purchase', symbol: view.symbol, timer: setInterval(read, 1000) };
    });
  }

  /**
   * The account-wide open-contract feed: one message per contract that is open, plus one final
   * message when it settles (that poll is also what settles it, since expiry is lazy).
   */
  function streamAllContracts(socket, req) {
    var sold = {};
    var tick = function () {
      return api('/api/trades?limit=20&mode=' + modeOf(socket)).then(function (r) {
        var list = r.body.trades || [];
        for (var i = 0; i < list.length; i++) {
          var t = list[i];
          var view = contractView(t);
          if (view.is_sold) {
            if (sold[t.id]) continue;
            sold[t.id] = true;
            socket._deliver({ msg_type: 'proposal_open_contract', proposal_open_contract: view, echo_req: req, req_id: req.req_id });
          } else {
            socket._deliver({ msg_type: 'proposal_open_contract', proposal_open_contract: view, echo_req: req, req_id: req.req_id });
          }
        }
        return Object.keys(sold).length >= list.length && list.length > 0;
      });
    };
    return tick().then(function () {
      if (!req.subscribe) return;
      stats.subscriptions += 1;
      var key = req.req_id || 'proposal_open_contract';
      if (socket._subs[key] && socket._subs[key].timer) clearInterval(socket._subs[key].timer);
      socket._subs[key] = { kind: 'contracts', timer: setInterval(tick, 1000) };
    });
  }

  /** `transaction` stream: buys and settlements on the active account, newest last. */
  function streamTransactions(socket, req) {
    var seen = {};
    var deliver = function (t, action, amount) {
      socket._deliver({
        msg_type: 'transaction', echo_req: req, req_id: req.req_id,
        transaction: {
          action, contract_id: t.id, transaction_id: t.id,
          amount, balance: 0,
          symbol: t.symbol, contract_type: t.contractType,
          transaction_time: Math.floor((action === 'sell' ? (t.settledAt || t.expiryEpoch || t.entryEpoch) : t.entryEpoch) / 1000),
          purchase_time: Math.floor(t.entryEpoch / 1000),
          longcode: (t.contractType === 'CALL' ? 'Rise' : 'Fall') + ' in ' + t.symbol,
          app_id: 36300, mode: t.mode || 'demo',
        },
      });
    };
    var poll = function () {
      return api('/api/trades?limit=20&mode=' + modeOf(socket)).then(function (r) {
        var list = (r.body.trades || []).slice().reverse();
        for (var i = 0; i < list.length; i++) {
          var t = list[i];
          if (!seen[t.id]) { seen[t.id] = t.status; deliver(t, 'buy', t.stakeCents / 100); continue; }
          if (seen[t.id] === 'OPEN' && t.status !== 'OPEN') { seen[t.id] = t.status; deliver(t, 'sell', (t.profitCents || 0) / 100); }
        }
      });
    };
    return poll().then(function () {
      if (!req.subscribe) return;
      stats.subscriptions += 1;
      var key = req.req_id || 'transaction';
      if (socket._subs[key] && socket._subs[key].timer) clearInterval(socket._subs[key].timer);
      socket._subs[key] = { kind: 'transaction', timer: setInterval(poll, TICK_MS) };
    });
  }

  // ---------------------------------------------------------------- install
  function Bridged(url, protocols) {
    var target = typeof url === 'string' ? url : (url && url.toString ? url.toString() : '');
    var host = '';
    try { host = new URL(target, location.href).hostname; } catch (e) { host = ''; }
    if (DERIV_HOST.test(host)) return new BridgeSocket(target);
    return protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
  }

  Bridged.prototype = NativeWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { Bridged[k] = NativeWS[k]; });
  Bridged.CONNECTING = 0; Bridged.OPEN = 1; Bridged.CLOSING = 2; Bridged.CLOSED = 3;

  window.WebSocket = Bridged;
  window.__ntBridgeActive = true;
})();
