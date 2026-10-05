// On-chain stream of pump.fun / bonk.fun launches, trades and migrations via PumpPortal's
// free WebSocket (https://pumpportal.fun/data-api/real-time). One connection only — their rule.
import { num } from '../util.js?v=muvpa7h6';

const WS_URL = 'wss://pumpportal.fun/api/data';
const NAME = 'pumpportal';
const MIN = 60_000;

export function startPumpPortal(store, config) {
  let ws = null;
  let backoff = 1000;
  let lastMsg = 0;
  const subs = new Set();
  const toSub = new Set();
  const toUnsub = new Set();

  const send = (obj) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  // Since 2026 PumpPortal serves per-token trade streams only to funded API keys;
  // new tokens + migrations stay free. Without a key, activity comes from DexScreener.
  const tradesEnabled = !!config.pumpPortalKey;

  const subscribe = (mint) => {
    if (!tradesEnabled) return;
    if (subs.has(mint) || toSub.has(mint)) return;
    if (subs.size + toSub.size >= config.maxTradeSubs) return;
    toUnsub.delete(mint);
    toSub.add(mint);
  };

  const unsubscribe = (mint) => {
    toSub.delete(mint);
    if (subs.has(mint)) toUnsub.add(mint);
  };

  const launchpadOf = (pool) => (pool === 'bonk' || pool === 'launchlab' ? 'bonk' : 'pump');

  function handle(msg) {
    if (msg && typeof msg.message === 'string' && /api key/i.test(msg.message)) {
      store.setSource(NAME, 'ok', 'launche i migracje na żywo · transakcje wymagają PUMPPORTAL_API_KEY');
      return;
    }
    if (!msg || typeof msg !== 'object' || !msg.mint) return;
    lastMsg = Date.now();
    const type = String(msg.txType || '').toLowerCase();

    if (type === 'create') {
      // Tracked wallets launching a token (wallet tracker) — seen even when launches aren't listed.
      store.launchHook?.({ mint: msg.mint, name: msg.name, symbol: msg.symbol, creator: msg.traderPublicKey });
      const t = store.onLaunch({
        mint: msg.mint,
        name: msg.name,
        symbol: msg.symbol,
        uri: msg.uri,
        creator: msg.traderPublicKey,
        launchpad: launchpadOf(msg.pool),
        vTokens: num(msg.vTokensInBondingCurve),
        mcapSol: num(msg.marketCapSol),
        initialBuySol: num(msg.solAmount),
      });
      if (t) subscribe(t.mint);
    } else if (type === 'buy' || type === 'sell') {
      store.addTrade(msg.mint, {
        side: type,
        sol: num(msg.solAmount) || 0,
        trader: msg.traderPublicKey,
        mcapSol: num(msg.marketCapSol),
        vTokens: msg.pool === 'pump' ? num(msg.vTokensInBondingCurve) : undefined,
      });
    } else if (type.includes('migrat')) {
      store.onMigration(msg.mint, { pool: msg.pool });
    }
  }

  let pausedOff = false; // closed because the network went off screen

  function connect() {
    store.setSource(NAME, 'connecting', 'łączenie…');
    const url = config.pumpPortalKey ? `${WS_URL}?api-key=${encodeURIComponent(config.pumpPortalKey)}` : WS_URL;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      store.setSource(NAME, 'error', err.message);
      setTimeout(connect, backoff);
      return;
    }
    const socket = ws;
    const connectTimer = setTimeout(() => {
      if (socket.readyState === WebSocket.CONNECTING) socket.close();
    }, 15_000);
    ws.onopen = () => {
      clearTimeout(connectTimer);
      backoff = 1000;
      lastMsg = Date.now();
      store.setSource(NAME, 'ok', 'strumień na żywo');
      // New tokens are free; with onlyGraduated they only feed the wallet tracker's launch alerts.
      send({ method: 'subscribeNewToken' });
      send({ method: 'subscribeMigration' });
      // Re-subscribe everything after a reconnect.
      for (const m of subs) toSub.add(m);
      subs.clear();
    };
    ws.onmessage = async (ev) => {
      try {
        const text = typeof ev.data === 'string' ? ev.data : await new Response(ev.data).text();
        handle(JSON.parse(text));
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      clearTimeout(connectTimer);
      // Network not on screen: stay disconnected until it is (the 30 s check reconnects).
      if (store.active === false) {
        pausedOff = true;
        store.setSource(NAME, 'connecting', 'wstrzymane (inna sieć)');
        return;
      }
      store.setSource(NAME, 'error', `rozłączono — ponawiam za ${Math.round(backoff / 1000)}s`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60_000);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  // Flush subscription changes in batches.
  setInterval(() => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const chunk = (set) => [...set].slice(0, 200);
    const add = chunk(toSub);
    if (add.length) {
      send({ method: 'subscribeTokenTrade', keys: add });
      for (const m of add) (toSub.delete(m), subs.add(m));
    }
    const rem = chunk(toUnsub);
    if (rem.length) {
      send({ method: 'unsubscribeTokenTrade', keys: rem });
      for (const m of rem) (toUnsub.delete(m), subs.delete(m));
    }
  }, 1500);

  // Keep trade subscriptions on tokens that matter: fresh launches + anything ranking high.
  setInterval(() => {
    if (store.active === false) {
      if (ws && ws.readyState <= 1) ws.close();
      return;
    }
    if (pausedOff) {
      pausedOff = false;
      connect();
      return;
    }
    const now = Date.now();
    const top = store.topMints(300);
    const topSet = new Set(top);
    for (const m of subs) {
      const t = store.get(m);
      if (!t) {
        unsubscribe(m);
        continue;
      }
      if (topSet.has(m) || t.pinnedUntil > now) continue;
      const age = now - (t.createdAt || t.firstSeen);
      const recent = t.trades.filter((x) => now - x.t < 10 * MIN).length;
      if (age > 10 * MIN && recent < 5) unsubscribe(m);
    }
    for (const m of top) {
      const t = store.get(m);
      if (t && (t.launchpad || t.dexId === 'pumpfun' || t.dexId === 'pumpswap')) subscribe(m);
    }
    // Stale connection watchdog: new launches (always subscribed) arrive every few seconds.
    const silence = 2 * MIN;
    if (ws?.readyState === WebSocket.OPEN && now - lastMsg > silence) {
      store.setSource(NAME, 'error', 'brak danych — restart połączenia');
      ws.close();
    } else if (ws?.readyState === WebSocket.OPEN) {
      store.setSource(
        NAME,
        'ok',
        tradesEnabled
          ? `na żywo · transakcje ${subs.size} tokenów`
          : config.onlyGraduated
            ? 'graduacje pump.fun na żywo'
            : 'launche i migracje na żywo (transakcje: dodaj PUMPPORTAL_API_KEY)',
      );
    }
  }, 30_000);

  connect();
  return { subscribe };
}
