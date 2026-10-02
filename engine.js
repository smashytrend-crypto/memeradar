// The whole radar engine running inside the browser (no server): the same Store, scoring and
// source adapters as the Node server, fetching the data sources directly (all allow
// cross-origin reads). One engine per network, created the first time the viewer opens it; only
// the network on screen polls its sources, the others pause (and keep their data for a quick
// switch back).
import { Store } from './server/store.js';
import { every, getJSON, num } from './server/util.js';
import { CHAINS, getChain, isAddressOn, normAddr } from './server/chains.js';
import { startPumpPortal } from './server/sources/pumpportal.js';
import { startDexScreener } from './server/sources/dexscreener.js';
import { startGeckoTerminal } from './server/sources/geckoterminal.js';
import { startJupiter } from './server/sources/jupiter.js';
import { startRugCheck } from './server/sources/rugcheck.js';
import { startGoPlus } from './server/sources/goplus.js';

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
  startGeckoTerminal(store, baseConfig);
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

  return {
    chain,
    store,
    snapshot(view, filters, limit = 100, mints = []) {
      return { t: Date.now(), view, rows: store.list(view, filters, limit, mints), stats: store.stats(), sources: store.sources };
    },
    feed: () => store.feed.slice(0, 60),
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
      store.pin(mint);
      return store.detail(t);
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
  for (const e of engines.values()) e.store.active = e === current;
  current.store.rescore();
  return current;
}

export const engine = {
  chains: CHAINS,
  get chain() {
    return current?.chain.id;
  },
  /** Switches the network on screen (creating its engine on first use). */
  setChain: (id) => use(id).chain.id,
  snapshot: (...a) => current.snapshot(...a),
  feed: () => current.feed(),
  onFeed: (fn) => feedHandlers.add(fn),
  detail: (mint) => current.detail(mint),
  search: (q) => current.search(q),
};
