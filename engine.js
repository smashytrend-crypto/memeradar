// The whole radar engine running inside the browser (no server): the same Store, scoring and
// source adapters as the Node server, fetching DexScreener / Jupiter / GeckoTerminal / RugCheck
// directly (all allow cross-origin reads) and pump.fun graduations over PumpPortal's WebSocket.
import { Store } from './server/store.js';
import { isMint } from './server/util.js';
import { startPumpPortal } from './server/sources/pumpportal.js';
import { startDexScreener } from './server/sources/dexscreener.js';
import { startGeckoTerminal } from './server/sources/geckoterminal.js';
import { startJupiter } from './server/sources/jupiter.js';
import { startRugCheck } from './server/sources/rugcheck.js';

const config = {
  demo: false,
  onlyGraduated: true,
  maxTokens: 4000, // phones: keep memory modest
  dexscreenerRpm: 150,
  whaleSol: 5,
  maxTradeSubs: 0,
  pumpPortalKey: '',
  xBearer: '',
};

const store = new Store(config);
store.setSource('x', 'off', 'wymaga klucza X API (wersja serwerowa)');
store.setSource('ai', 'off', 'analiza AI dostępna w wersji serwerowej');

const src = {
  pump: startPumpPortal(store, config),
  dex: startDexScreener(store, config),
  jup: startJupiter(store, config),
  rug: startRugCheck(store, config),
};
startGeckoTerminal(store, config);

setInterval(() => store.rescore(), 2000);
setInterval(() => store.prune(), 60_000);

export const engine = {
  snapshot(view, filters, limit = 100, mints = []) {
    return { t: Date.now(), view, rows: store.list(view, filters, limit, mints), stats: store.stats(), sources: store.sources };
  },
  feed: () => store.feed.slice(0, 60),
  onFeed: (fn) => store.on('feed', fn),
  async detail(mint) {
    if (!isMint(mint)) return null;
    let t = store.get(mint);
    if (!t) {
      await Promise.allSettled([src.dex.refresh(mint), src.jup.refresh(mint)]);
      t = store.get(mint);
    }
    if (!t) return null;
    if (!t.pinnedUntil || t.pinnedUntil < Date.now()) {
      if (!t.rug) src.rug.check(t);
    }
    store.pin(mint);
    return store.detail(t);
  },
  async search(q) {
    q = q.trim().slice(0, 64);
    if (q.length < 2) return [];
    if (isMint(q) && !store.get(q)) await Promise.allSettled([src.dex.refresh(q), src.jup.refresh(q)]);
    else if (store.list('hype', { q }, 20).length < 5) await src.dex.search(q).catch(() => {});
    store.rescore();
    return isMint(q) && store.get(q) ? [store.row(store.get(q))] : store.list('hype', { q }, 20);
  },
};
