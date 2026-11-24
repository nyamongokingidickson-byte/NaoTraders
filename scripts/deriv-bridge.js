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
 *   • no `authorize` is ever faked: it is answered with an error, so the app stays unauthenticated
 *     — trading is performed against the platform session cookie and the demo wallet, via
 *     /api/trades, and every stake/payout is booked in the ledger
 *   • unsupported Deriv features return a protocol-shaped error instead of a made-up success
 */
(function () {
  'use strict';

  if (window.__ntBridge) return;
  window.__ntBridge = true;

  var NativeWS = window.WebSocket;
  var DERIV_HOST = /(^|\.)derivws\.com$|(^|\.)deriv\.com$|(^|\.)binary\.com$|(^|\.)binaryws\.com$/i;
  var TICK_MS = 2000;

  var stats = { sockets: 0, requests: 0, served: 0, errors: 0, subscriptions: 0, byType: {}, unknownKeys: {} };
  window.__ntBridgeStats = stats;

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
    if (req.balance) return 'balance';
    if (req.statement) return 'statement';
    if (req.authorize) return 'authorize';
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
      return api('/api/trades?limit=50').then(function (r) {
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
      return api('/api/trades?limit=50').then(function (r) {
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
        var demo = r.body.demo || { totalCents: 0 };
        socket._deliver({
          msg_type: 'balance',
          balance: { balance: demo.totalCents / 100, currency: 'USD', loginid: 'NT-DEMO', account_type: 'demo' },
          echo_req: req, req_id: req.req_id,
        });
        if (req.subscribe) {
          var id = req.req_id || 'balance';
          var sock = socket;
          if (socket._subs[id] && socket._subs[id].timer) clearInterval(socket._subs[id].timer);
          socket._subs[id] = { kind: 'balance', timer: setInterval(function () {
            api('/api/wallet').then(function (w) {
              if (!w.ok) return;
              sock._deliver({ msg_type: 'balance', balance: { balance: (w.body.demo || {}).totalCents / 100, currency: 'USD', loginid: 'NT-DEMO', account_type: 'demo' }, echo_req: req, req_id: req.req_id });
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
      // Never faked: this deployment has one identity system, the platform session cookie.
      return socket._deliver(errorFor(req, 'authorize', 'InvalidToken', 'Deriv authorisation is not used on this platform. Sign in with NovaTrade KE.'));
    }
    if (type === 'sell' || type === 'transaction' || type === 'ping_stream') {
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
        return api('/api/markets/' + encodeURIComponent(market) + '/candles?granularity=' + (req.granularity || 60) + '&count=' + count)
          .then(function (r) {
            var rows = (r.body.candles || []).map(function (c) {
              return { epoch: Math.floor(c.epoch / 1000), open: c.open, high: c.high, low: c.low, close: c.close };
            });
            socket._deliver({
              msg_type: 'candles',
              candles: rows,
              echo_req: req, req_id: req.req_id,
            });
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
      });
    }

    // ticks (subscribe) — one immediate tick, then one every 2 s while subscribed
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
      api('/api/markets/' + encodeURIComponent(market) + '/ticks?count=1').then(function (r) {
        var t = (r.body.ticks || [])[0];
        if (t) send(t.quote, t.epoch);
      });
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

  function handleProposal(socket, req) {
    var market = mapSymbol(req.symbol || (req.proposal && req.proposal.symbol));
    var type = (req.contract_type || (req.proposal && req.proposal.contract_type) || 'CALL').toUpperCase();
    var duration = Number(req.duration || 5);
    var stake = Number(req.amount || 10);
    return Promise.all([loadMarkets(), api('/api/trading/limits')]).then(function (out) {
      var map = out[0], limits = out[1];
      var meta = map[market] || { last: 0, digits: 2 };
      var ladder = (limits.body.payouts || []).filter(function (p) { return p.contractType === type; });
      var row = ladder.filter(function (p) { return p.durationTicks === duration; })[0] || ladder[0] || { multiplierBp: 18800 };
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
          longcode: (type === 'CALL' ? 'Rise' : 'Fall') + ' in ' + market + ' for ' + duration + ' ticks',
          contract_type: type,
          symbol: market,
          duration: duration + 't',
          barrier: '0',
          spot_time_expiry: Math.floor(Date.now() / 1000) + duration * 2,
        },
      });
    });
  }

  function handleBuy(socket, req) {
    var market = mapSymbol(req.symbol || req.buy);
    var amount = Number(req.price || 10);
    var type = (req.parameters && req.parameters.contract_type) || (req.contract_type) || 'CALL';
    var duration = Number((req.parameters && req.parameters.duration) || req.duration || 5);

    return Promise.all([api('/api/auth/session'), api('/api/markets/' + encodeURIComponent(market) + '/ticks?count=1')]).then(function (out) {
      var session = out[0], tick = (out[1].body.ticks || [])[0];
      if (!session.ok) {
        return socket._deliver(errorFor(req, 'buy', 'AuthorizationRequired', 'Sign in with NovaTrade KE to trade.'));
      }
      return api('/api/trades', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbol: market,
          contractType: String(type).toUpperCase(),
          stakeCents: Math.round(amount * 100),
          durationTicks: duration,
        }),
      }).then(function (res) {
        if (!res.ok) {
          return socket._deliver(errorFor(req, 'buy', res.body.code || 'ContractCreationFailure', res.body.error || 'Could not create that contract.'));
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
            balance_after: ((res.body.balances || {}).demo || {}).totalCents / 100,
            longcode: (t.contractType === 'CALL' ? 'Rise' : 'Fall') + ' ' + t.symbol,
            shortcode: t.id,
          },
        });
      });
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
