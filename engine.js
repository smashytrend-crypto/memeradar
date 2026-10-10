// The whole radar engine running inside the browser (no server): the same Store, scoring and
// source adapters as the Node server, fetching the data sources directly (all allow
// cross-origin reads). One engine per network, created the first time the viewer opens it; only
// the network on screen polls its sources, the others pause (and keep their data for a quick
// switch back).
import { Store } from './server/store.js?v=mv2zx1lk';
import { RateLimiter, every, getJSON, num } from './server/util.js?v=mv2zx1lk';
import { CHAINS, getChain, isAddressOn, normAddr } from './server/chains.js?v=mv2zx1lk';
import { startPumpPortal } from './server/sources/pumpportal.js?v=mv2zx1lk';
import { startDexScreener } from './server/sources/dexscreener.js?v=mv2zx1lk';
import { startGeckoTerminal } from './server/sources/geckoterminal.js?v=mv2zx1lk';
import { startJupiter } from './server/sources/jupiter.js?v=mv2zx1lk';
import { startRugCheck } from './server/sources/rugcheck.js?v=mv2zx1lk';
import { startGoPlus } from './server/sources/goplus.js?v=mv2zx1lk';

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
  function processTrades(t, list, quiet = false) {
    // Background scans (TOP wallets) only learn whether the creator sold: no feed alerts.
    if (quiet) {
      const dev = t.creator ? normAddr(chain, t.creator) : null;
      if (dev) for (const tr of list) if (tr.side === 'sell' && normAddr(chain, tr.wallet) === dev && tr.t > (t.devSoldAt || 0)) t.devSoldAt = tr.t;
      return;
    }
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
    const whales = [];
    const name = t.symbol ? '$' + t.symbol : t.name || t.mint.slice(0, 6);
    const dev = t.creator ? normAddr(chain, t.creator) : null;
    for (const tr of [...list].reverse()) {
      // The creator selling (any trade we see, history included): anti-rug exits on it.
      if (dev && tr.side === 'sell' && normAddr(chain, tr.wallet) === dev && tr.t > (t.devSoldAt || 0)) t.devSoldAt = tr.t;
      if (!tr.tx || seen.has(tr.tx)) continue;
      seen.add(tr.tx);
      // The first batch is history: mark it seen without alerting (only recent trades alert).
      if (first && Date.now() - tr.t > 90_000) continue;
      const w = wallets.get(normAddr(chain, tr.wallet));
      if (w) {
        store.pushFeed({ type: 'wallet', mint: t.mint, at: tr.t, text: `${w.emoji || '👛'} ${w.name}: ${tr.side === 'buy' ? 'kupił' : 'sprzedał'} ${name} za $${Math.round(tr.usd).toLocaleString('pl-PL')}` });
      } else if (tr.usd >= whaleUsd) whales.push(tr);
    }
    // At most 5 big trades per batch: the newest ones (still in time order).
    for (const tr of whales.slice(-5)) store.pushFeed({ type: 'whale', mint: t.mint, at: tr.t, text: `🐋 ${tr.side === 'buy' ? 'Kupno' : 'Sprzedaż'} ${name} za $${Math.round(tr.usd).toLocaleString('pl-PL')}` });
    if (seen.size > 2000) seenTx.set(t.mint, new Set([...seen].slice(-800)));
  }
  async function trades(mint, priority = false, quiet = false) {
    const t = store.get(normAddr(chain, mint));
    if (!t?.pairAddress) return null;
    const c = tradesCache.get(t.mint);
    if (c && c.pool === t.pairAddress && Date.now() - c.at < 25_000) {
      // Fetched by a quiet scan: the first regular reader still raises the alerts.
      if (c.quiet && !quiet) {
        c.quiet = false;
        processTrades(t, c.list);
      }
      return c.list;
    }
    const list = await src.gt.trades(t, priority);
    tradesCache.set(t.mint, { at: Date.now(), pool: t.pairAddress, list, quiet });
    if (tradesCache.size > 60) tradesCache.delete(tradesCache.keys().next().value);
    processTrades(t, list, quiet);
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
      store.viewingAt = now;
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
    /**
     * Live price + market cap of the open token (the chart asks every second): Solana pools read
     * on chain (constant-product pools: PumpSwap / Raydium), else Jupiter's price, else DexScreener.
     */
    async live(mint) {
      if (!isAddressOn(chain, mint)) return null;
      const t = store.get(normAddr(chain, mint));
      if (!t) return null;
      const k = t.mcap > 0 && t.priceUsd > 0 ? t.mcap / t.priceUsd : 0; // MC per unit of price
      let p = null;
      let source = '';
      const pool = t.chainPool;
      if (!chain.evm && pool && pool.id === t.pairAddress && !t.chainBad && store.solPrice > 0) {
        const v = await rpcVaults(pool);
        const usd = pool.quoteMint === SOL_MINT ? store.solPrice : STABLES.has(pool.quoteMint) ? 1 : 0;
        // A quote coin we can't price never works; nodes that don't answer count as misses.
        if (!usd) t.chainBad = true;
        else if (!v && (t.chainMiss = (t.chainMiss || 0) + 1) > 5) t.chainBad = true;
        if (v && usd) {
          const cp = (v.q / v.b) * usd;
          // Sanity check against the aggregators (a pool type whose vaults don't give the price).
          const r = t.priceUsd > 0 ? cp / t.priceUsd : 1;
          if (r > 0.6 && r < 1.7) {
            p = cp;
            source = 'chain';
          } else if ((t.chainMiss = (t.chainMiss || 0) + 1) > 5) t.chainBad = true;
        }
      }
      if (!p && !chain.evm) {
        try {
          const j = await jupLim.run(() => getJSON(`https://lite-api.jup.ag/price/v3?ids=${t.mint}`, { timeout: 3000 }));
          const jp = num(j?.[t.mint]?.usdPrice);
          if (jp > 0) {
            p = jp;
            source = 'jupiter';
          }
        } catch {
          /* fall back to DexScreener */
        }
      }
      if (!p) {
        const r = await src.dex.live(mint);
        return r && { ...r, source: 'dexscreener' };
      }
      if (k > 0) store.upsert(t.mint, { priceUsd: p, mcap: p * k }, 'live');
      return { p, mc: k > 0 ? p * k : null, at: Date.now(), source };
    },
    /**
     * Copies: other tokens with the same ticker (DexScreener search, every network — the oldest
     * is the "OG") and the token's X / Telegram / website links reused by other tokens the radar
     * knows. Cached 30 min per token.
     */
    async copies(mint) {
      const t = store.get(normAddr(chain, mint));
      if (!t?.symbol) return null;
      if (t.copyInfo && Date.now() - t.copyInfo.at < 30 * 60_000) return t.copyInfo;
      const sym = String(t.symbol).toUpperCase();
      let pairs;
      try {
        pairs = await src.dex.searchRaw(t.symbol);
      } catch {
        return t.copyInfo || null; // a failed search isn't "no copies": try again next time
      }
      const byToken = new Map();
      for (const p of pairs) {
        const b = p?.baseToken;
        if (!b?.address || String(b.symbol || '').toUpperCase() !== sym) continue;
        const key = `${p.chainId}:${String(b.address).toLowerCase()}`;
        const o = byToken.get(key) || { chain: p.chainId, address: b.address, name: b.name, at: Infinity, mc: 0 };
        o.at = Math.min(o.at, Number(p.pairCreatedAt) || Infinity);
        o.mc = Math.max(o.mc, Number(p.marketCap || p.fdv) || 0);
        byToken.set(key, o);
      }
      const me = `${chain.dex}:${t.mint.toLowerCase()}`;
      const list = [...byToken.values()];
      const others = list.filter((o) => `${o.chain}:${o.address.toLowerCase()}` !== me);
      // The search returns at most 30 pairs: without our own token among them the list is partial.
      const partial = !list.some((o) => `${o.chain}:${o.address.toLowerCase()}` === me) || pairs.length >= 30;
      const og = partial ? null : list.filter((o) => o.at < Infinity).sort((a, b) => a.at - b.at)[0] || null;
      const top = [...others].sort((a, b) => b.mc - a.mc)[0] || null;
      // Links reused across tokens the radar holds (same X account / TG / site = likely a copy).
      const norm = (u) => String(u || '').toLowerCase().replace(/^https?:\/\/(www\.|mobile\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
      const shared = {};
      for (const k of ['twitter', 'telegram', 'website']) {
        const mine = norm(t.socials?.[k]);
        if (!mine) continue;
        let n = 0;
        for (const o of store.tokens.values()) if (o !== t && norm(o.socials?.[k]) === mine) n++;
        if (n) shared[k] = n;
      }
      t.copyInfo = {
        at: Date.now(),
        same: others.length,
        partial,
        isOg: !!og && `${og.chain}:${og.address.toLowerCase()}` === me,
        og: og && { chain: og.chain, address: og.address, mc: og.mc, at: og.at },
        top: top && { chain: top.chain, address: top.address, mc: top.mc },
        shared,
      };
      return t.copyInfo;
    },
    /** Latest trades of the token's main pool (cached 25 s), newest first; null without a pool. */
    trades: (mint) => trades(mint, true),
    /** Trades for the background wallet scanner: no priority, the chart's requests go first. */
    scan: (mint) => trades(mint, false, true),
    /** Candles [ms, o, h, l, c, vol] for the chart (cached 50 s per timeframe). */
    async candles(mint, tf) {
      const t = store.get(normAddr(chain, mint));
      if (!t?.pairAddress) return null;
      const key = `${t.mint}|${t.pairAddress}|${tf}`;
      const c = candleCache.get(key);
      if (c && Date.now() - c.at < 50_000) return c.list.map((k) => [...k]); // copies: the chart edits its bars
      // GeckoTerminal doesn't know every pool DexScreener prices by (fresh migrations, some
      // DEXes): then the token's own most liquid pool on GeckoTerminal is used.
      // The alternative pool stands in only for the pair it replaced, and the main pool gets
      // another chance after 5 minutes.
      let list = [];
      const a = altPool.get(t.mint);
      const alt = a && a.pair === t.pairAddress && Date.now() - a.at < 5 * 60_000 ? a.pool : null;
      if (a && !alt) altPool.delete(t.mint);
      try {
        list = await src.gt.candles(t, tf, 2, alt || t.pairAddress);
      } catch (e) {
        if (e?.status !== 404) throw e;
      }
      if (!list.length) {
        if (alt) altPool.delete(t.mint);
        else {
          const pools = await src.gt.tokenPools(t, 2).catch(() => []);
          const other = pools.find((p) => p.toLowerCase() !== String(t.pairAddress).toLowerCase()) || null;
          if (other) {
            altPool.set(t.mint, { pool: other, pair: t.pairAddress, at: Date.now() });
            list = await src.gt.candles(t, tf, 2, other).catch(() => []);
          }
        }
      }
      // Nothing for this pool: don't ask GeckoTerminal again (candles + pools) for 5 minutes.
      candleCache.set(key, { at: list.length ? Date.now() : Date.now() + 250_000, list });
      if (candleCache.size > 30) candleCache.delete(candleCache.keys().next().value);
      return list.map((k) => [...k]);
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
const altPool = new Map(); // mint -> { pool, pair, at }: GeckoTerminal pool used for candles when the main one isn't known there

// ---- real-time price for the open chart (Solana) ----
// Free public RPC nodes: the pool's two vault balances, read every second (a new block every
// ~0.4 s), give the price on chain — far fresher than the aggregators' cached prices.
const RPCS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
let rpcIdx = 0;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLES = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
async function rpcVaults(pool) {
  for (let i = 0; i < RPCS.length; i++) {
    const url = RPCS[(rpcIdx + i) % RPCS.length];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [[pool.base, pool.quote], { encoding: 'jsonParsed', commitment: 'processed' }] }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const amt = (v) => num(v?.data?.parsed?.info?.tokenAmount?.uiAmountString ?? v?.data?.parsed?.info?.tokenAmount?.uiAmount);
      const [b, q] = (json?.result?.value || []).map(amt);
      if (!(b > 0) || !(q > 0)) throw new Error('no reserves');
      rpcIdx = (rpcIdx + i) % RPCS.length; // stick to the node that answered
      return { b, q };
    } catch {
      /* next node */
    }
  }
  return null;
}
const jupLim = new RateLimiter(50);

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
  scanTrades: (mint) => current.scan(mint),
  copies: (mint) => current.copies(mint),
  live: (mint) => current.live(mint),
  candles: (mint, tf) => current.candles(mint, tf),
  /** The viewer's tracked wallets: [{ a, name, emoji }]. */
  setWallets(list) {
    wallets.clear();
    for (const w of list || []) if (w?.a) wallets.set(w.a.startsWith('0x') ? w.a.toLowerCase() : w.a, w);
  },
};
