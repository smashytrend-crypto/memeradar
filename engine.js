// The whole radar engine running inside the browser (no server): the same Store, scoring and
// source adapters as the Node server, fetching the data sources directly (all allow
// cross-origin reads). One engine per network, created the first time the viewer opens it; only
// the network on screen polls its sources, the others pause (and keep their data for a quick
// switch back).
import { Store } from './server/store.js?v=muu7qgut';
import { every, getJSON, num } from './server/util.js?v=muu7qgut';
import { CHAINS, getChain, isAddressOn, normAddr } from './server/chains.js?v=muu7qgut';
import { startPumpPortal } from './server/sources/pumpportal.js?v=muu7qgut';
import { startDexScreener } from './server/sources/dexscreener.js?v=muu7qgut';
import { startGeckoTerminal } from './server/sources/geckoterminal.js?v=muu7qgut';
import { startJupiter } from './server/sources/jupiter.js?v=muu7qgut';
import { startRugCheck } from './server/sources/rugcheck.js?v=muu7qgut';
import { startGoPlus } from './server/sources/goplus.js?v=muu7qgut';

const baseConfig = {
  demo: false,
  onlyGraduated: true,
  maxTokens: 3000, // phones: keep memory modest
  dexscreenerRpm: 150,
  whaleSol: 5,
  maxTradeSubs: 0,
  pumpPortalKey: '',
  xBearer: '',
};

/** Header price of the network's native coin (EVM): the wrapped coin's most liquid DexScreener pair. */
function startNativePrice(store) {
  const [dexChain, addr] = store.chain.nativeRef;
  every(
    60_000,
    async () => {
      const pairs = await getJSON(`https://api.dexscreener.com/tokens/v1/${dexChain}/${addr}`);
      const best = (Array.isArray(pairs) ? pairs : [])
        .filter((p) => p.baseToken?.address?.toLowerCase() === addr.toLowerCase())
        .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      const p = num(best?.priceUsd);
      if (p) store.solPrice = p;
    },
    () => {},
    () => store.active,
  );
}

function createEngine(chainId) {
  const chain = getChain(chainId);
  const store = new Store({ ...baseConfig, chain: chain.id });
  store.setSource('x', 'off', 'wymaga klucza X API (wersja serwerowa)');
  store.setSource('ai', 'off', 'analiza AI dostępna w wersji serwerowej');
  const src = { dex: startDexScreener(store, baseConfig) };
  src.gt = startGeckoTerminal(store, baseConfig);
  if (chain.evm) {
    src.safety = startGoPlus(store);
    startNativePrice(store);
  } else {
    src.pump = startPumpPortal(store, baseConfig);
    src.jup = startJupiter(store, baseConfig);
    src.safety = startRugCheck(store, baseConfig);
  }
  const refresh = (a) => Promise.allSettled([src.dex.refresh(a), src.jup?.refresh(a)]);
  setInterval(() => store.active && store.rescore(), 2000);
  setInterval(() => store.prune(), 60_000);

  // ---- trades: whales + tracked wallets ----
  const tracked = new Set(); // watched tokens + open positions on this network
  const seenTx = new Map(); // mint -> Set of tx hashes already processed
  const tradesCache = new Map(); // mint -> { at, list }
  const whaleUsd = WHALE_USD[chain.id] || 1000;
  /** Feed items for big trades and tracked wallets among trades not seen before. */
  function processTrades(t, list) {
    let seen = seenTx.get(t.mint);
    const first = !seen;
    if (!seen) seenTx.set(t.mint, (seen = new Set()));
    // Forget tokens opened long ago (never the tracked ones: they'd repeat alerts).
    if (first && seenTx.size > 80) {
      for (const k of seenTx.keys()) {
        if (k !== t.mint && !tracked.has(k)) seenTx.delete(k);
        if (seenTx.size <= 60) break;
      }
    }
    let alerts = 0;
    const name = t.symbol ? '$' + t.symbol : t.name || t.mint.slice(0, 6);
    for (const tr of [...list].reverse()) {
      if (!tr.tx || seen.has(tr.tx)) continue;
      seen.add(tr.tx);
      // The first batch is history: mark it seen without alerting (only recent trades alert).
      if (first && Date.now() - tr.t > 90_000) continue;
      const w = wallets.get(normAddr(chain, tr.wallet));
      if (w) {
        store.pushFeed({ type: 'wallet', mint: t.mint, at: tr.t, text: `${w.emoji || '👛'} ${w.name}: ${tr.side === 'buy' ? 'kupił' : 'sprzedał'} ${name} za $${Math.round(tr.usd).toLocaleString('pl-PL')}` });
      } else if (tr.usd >= whaleUsd && alerts++ < 5) {
        store.pushFeed({ type: 'whale', mint: t.mint, at: tr.t, text: `🐋 ${tr.side === 'buy' ? 'Kupno' : 'Sprzedaż'} ${name} za $${Math.round(tr.usd).toLocaleString('pl-PL')}` });
      }
    }
    if (seen.size > 2000) seenTx.set(t.mint, new Set([...seen].slice(-800)));
  }
  async function trades(mint, priority = false) {
    const t = store.get(normAddr(chain, mint));
    if (!t?.pairAddress) return null;
    const c = tradesCache.get(t.mint);
    if (c && c.pool === t.pairAddress && Date.now() - c.at < 25_000) return c.list;
    const list = await src.gt.trades(t, priority);
    tradesCache.set(t.mint, { at: Date.now(), pool: t.pairAddress, list });
    if (tradesCache.size > 60) tradesCache.delete(tradesCache.keys().next().value);
    processTrades(t, list);
    return list;
  }
  // Watched tokens and open positions: one of them every 45 s (shared GeckoTerminal budget).
  let watchIdx = 0;
  every(
    45_000,
    async () => {
      const mints = [...tracked].filter((m) => store.get(m)?.pairAddress);
      if (!mints.length || Date.now() - (store.focusAt || 0) < 15_000) return;
      await trades(mints[watchIdx++ % mints.length]);
    },
    () => {},
    () => store.active,
  );
  // Tracked wallets launching a token (from the free new-token stream, Solana).
  store.launchHook = (l) => {
    const w = wallets.get(normAddr(chain, l.creator));
    if (!w) return;
    store.pushFeed({ type: 'wallet', mint: l.mint, text: `${w.emoji || '👛'} ${w.name} wypuścił nowy token ${l.symbol ? '$' + l.symbol : l.name || ''}` });
  };

  // Watched tokens: load the ones this network doesn't hold yet (after a reload or a prune) and
  // keep them from being pruned. Each missing one is fetched at most once a minute.
  const tried = new Map();
  function ensureWatched(mints) {
    const now = Date.now();
    for (const m of mints) {
      if (!isAddressOn(chain, m)) continue;
      tracked.add(normAddr(chain, m));
      if (store.get(m)) {
        store.pin(m, 5 * 60_000);
        continue;
      }
      if (now - (tried.get(m) || 0) < 60_000) continue;
      tried.set(m, now);
      refresh(m).then(() => store.pin(m, 5 * 60_000));
    }
  }

  return {
    chain,
    store,
    snapshot(view, filters, limit = 100, mints = []) {
      if (view === 'watch') ensureWatched(mints);
      return { t: Date.now(), view, rows: store.list(view, filters, limit, mints), stats: store.stats(), sources: store.sources };
    },
    feed: () => store.feed.slice(0, 60),
    /** Keep these tokens loaded and protected from pruning (watchlist, demo positions). */
    track(mints) {
      tracked.clear();
      ensureWatched(mints);
    },
    async detail(mint) {
      if (!isAddressOn(chain, mint)) return null;
      mint = normAddr(chain, mint);
      let t = store.get(mint);
      if (!t) {
        await refresh(mint);
        t = store.get(mint);
      }
      if (!t) return null;
      if (!t.rug && (!t.pinnedUntil || t.pinnedUntil < Date.now())) src.safety.check(t);
      src.dex.paid(mint).catch(() => {});
      store.pin(mint);
      // A token window opened: its data gets the GeckoTerminal budget first (15 s, renewed once a
      // minute while it stays open), background candles / watched trades the rest.
      const now = Date.now();
      if (store.focusMint !== mint || now - (store.focusAt || 0) > 60_000) {
        store.focusMint = mint;
        store.focusAt = now;
      }
      // EVM dev: GeckoTerminal knows the deployer and their holding (once per 30 min).
      if (chain.evm && Date.now() - (t.devInfoAt || 0) > 30 * 60_000) {
        t.devInfoAt = Date.now();
        // 404 = not indexed: wait the full 30 min; other errors: retry in ~3 min.
        src.gt.info(t, true).then((i) => (t.devInfo = i)).catch((e) => (t.devInfoAt = e?.status === 404 ? Date.now() : Date.now() - 27 * 60_000));
      }
      return store.detail(t);
    },
    /** Latest trades of the token's main pool (cached 25 s), newest first; null without a pool. */
    trades: (mint) => trades(mint, true),
    /** Candles [ms, o, h, l, c, vol] for the chart (cached 50 s per timeframe). */
    async candles(mint, tf) {
      const t = store.get(normAddr(chain, mint));
      if (!t?.pairAddress) return null;
      const key = `${t.mint}|${t.pairAddress}|${tf}`;
      const c = candleCache.get(key);
      if (c && Date.now() - c.at < 50_000) return c.list;
      const list = await src.gt.candles(t, tf, true);
      candleCache.set(key, { at: Date.now(), list });
      if (candleCache.size > 30) candleCache.delete(candleCache.keys().next().value);
      return list;
    },
    async search(q) {
      q = q.trim().slice(0, 64);
      if (q.length < 2) return [];
      const isAddr = isAddressOn(chain, q);
      if (isAddr && !store.get(q)) await refresh(q);
      else if (store.list('hype', { q }, 20).length < 5) await src.dex.search(q).catch(() => {});
      store.rescore();
      return isAddr && store.get(q) ? [store.row(store.get(q))] : store.list('hype', { q }, 20);
    },
  };
}

// Big-trade threshold per network ($) for the whale feed.
const WHALE_USD = { solana: 1000, bsc: 1000, base: 1000, robinhood: 500, ethereum: 5000 };
// Wallets the viewer tracks (address -> { name, emoji }), shared by every network's engine.
const wallets = new Map();
const candleCache = new Map();

const engines = new Map();
const feedHandlers = new Set();
let current = null;

function use(chainId) {
  const id = getChain(chainId).id;
  if (!engines.has(id)) {
    const e = createEngine(id);
    e.store.on('feed', (item) => {
      if (current === e) for (const fn of feedHandlers) fn(item);
    });
    engines.set(id, e);
  }
  current = engines.get(id);
  for (const e of engines.values()) {
    const on = e === current;
    // Prices of a network that was paused are frozen until its sources refresh them.
    if (on && !e.store.active) e.since = Date.now();
    e.store.active = on;
  }
  current.store.rescore();
  return current;
}

export const engine = {
  chains: CHAINS,
  get chain() {
    return current?.chain.id;
  },
  /** When the network on screen became active: its rows' prices count as live only once updated after it. */
  get since() {
    return current?.since || 0;
  },
  /** Switches the network on screen (creating its engine on first use). */
  setChain: (id) => use(id).chain.id,
  snapshot: (...a) => current.snapshot(...a),
  feed: () => current.feed(),
  onFeed: (fn) => feedHandlers.add(fn),
  detail: (mint) => current.detail(mint),
  /** Load / pin tokens on the network on screen (demo positions). */
  track: (mints) => current.track(mints),
  /**
   * Live rows of tokens on any network whose engine has run this session (a paused network's
   * data is as of when it was last on screen). Missing tokens are left out.
   */
  rowsFor(chainId, mints) {
    const e = engines.get(chainId);
    if (!e) return [];
    return mints.map((m) => e.store.get(m)).filter(Boolean).map((t) => e.store.row(t));
  },
  search: (q) => current.search(q),
  trades: (mint) => current.trades(mint),
  candles: (mint, tf) => current.candles(mint, tf),
  /** The viewer's tracked wallets: [{ a, name, emoji }]. */
  setWallets(list) {
    wallets.clear();
    for (const w of list || []) if (w?.a) wallets.set(w.a.startsWith('0x') ? w.a.toLowerCase() : w.a, w);
  },
};
