// DexScreener public API (https://docs.dexscreener.com/api/reference):
// discovery (profiles / boosts) + batched market data for every tracked token.
import { RateLimiter, errMsg, every, getJSON, num, sleep, toMs } from '../util.js?v=mutkyp9h';
import { Store } from '../store.js?v=mutkyp9h';
import { isCurvePair } from '../constants.js?v=mutkyp9h';
import { isAddressOn, normAddr } from '../chains.js?v=mutkyp9h';

const BASE = 'https://api.dexscreener.com';
const NAME = 'dexscreener';

/** Boost / profile icons come either as full URLs or as bare DexScreener CMS image ids. */
export function iconUrl(icon) {
  if (!icon) return undefined;
  if (/^https?:\/\//.test(icon)) return icon;
  return `https://cdn.dexscreener.com/cms/images/${encodeURIComponent(icon)}?width=128&height=128&fit=crop&quality=95&format=auto`;
}

export function linksToSocials(links = []) {
  const out = {};
  for (const l of links || []) {
    const type = String(l.type || l.label || '').toLowerCase();
    const url = l.url;
    if (!url) continue;
    if (type === 'twitter' || type === 'x' || /(?:twitter|x)\.com\//.test(url)) out.twitter ??= url;
    else if (type === 'telegram' || /t\.me\//.test(url)) out.telegram ??= url;
    else if (type === 'discord') out.discord ??= url;
    else if (type === 'website' || !type) out.website ??= url;
  }
  return out;
}

/**
 * Merges all pairs of one base token into a single token patch. `curvePools` (lowercased pool
 * addresses) marks pools another source knows to be a launchpad curve although DexScreener lists
 * them under a regular DEX (e.g. Pons on Robinhood Chain runs as a Uniswap v4 hook).
 */
export function pairsToPatch(pairs, curvePools) {
  const sorted = [...pairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const top = sorted[0];
  const sum = (path) => pairs.reduce((acc, p) => acc + (path(p) || 0), 0);
  const created = Math.min(...pairs.map((p) => p.pairCreatedAt || Infinity));
  const onCurve = (p) => isCurvePair(p) || !!curvePools?.has(String(p.pairAddress).toLowerCase());
  // A launchpad can create a near-empty DEX pool at launch (Pons on Robinhood): while another
  // source knows the token's curve, only a pool with real liquidity counts as graduation.
  const real = (p) => (p.liquidity?.usd || 0) >= 1000;
  const dexPairs = pairs.filter((p) => !onCurve(p) && (!curvePools?.size || real(p)));
  const curvePair = pairs.find((p) => isCurvePair(p));
  const dexSince = Math.min(...dexPairs.map((p) => p.pairCreatedAt || Infinity));
  const info = top.info || {};
  const socials = linksToSocials([...(info.socials || []), ...(info.websites || []).map((w) => ({ type: 'website', url: w.url }))]);
  return {
    name: top.baseToken?.name,
    symbol: top.baseToken?.symbol,
    image: info.imageUrl,
    priceUsd: num(top.priceUsd),
    mcap: num(top.marketCap) ?? num(top.fdv),
    fdv: num(top.fdv),
    liquidity: sum((p) => p.liquidity?.usd),
    // A window without trades has no entry: that is a 0% move, not "keep the old value".
    change: {
      m5: num(top.priceChange?.m5) ?? 0,
      h1: num(top.priceChange?.h1) ?? 0,
      h6: num(top.priceChange?.h6) ?? 0,
      h24: num(top.priceChange?.h24) ?? 0,
    },
    volume: {
      m5: sum((p) => p.volume?.m5),
      h1: sum((p) => p.volume?.h1),
      h6: sum((p) => p.volume?.h6),
      h24: sum((p) => p.volume?.h24),
    },
    txns: Object.fromEntries(
      ['m5', 'h1', 'h6', 'h24'].map((k) => [k, { buys: sum((p) => p.txns?.[k]?.buys), sells: sum((p) => p.txns?.[k]?.sells) }]),
    ),
    pairAddress: top.pairAddress,
    dexId: top.dexId,
    dexUrl: top.url,
    createdAt: Number.isFinite(created) ? toMs(created) : undefined,
    boosts: num(top.boosts?.active) ?? 0,
    socials: Object.keys(socials).length ? socials : undefined,
    // Trades on a real DEX pool (for launchpad tokens: the curve is finished).
    graduated: dexPairs.length > 0 || undefined,
    hadCurve: dexPairs.length < pairs.length,
    curveDex: curvePair?.dexId,
    dexSince: Number.isFinite(dexSince) ? toMs(dexSince) : undefined,
  };
}

export function startDexScreener(store, config) {
  const chain = store.chain;
  const isAddr = (a) => isAddressOn(chain, a);
  const norm = (a) => normAddr(chain, a);
  const active = () => store.active;
  const slow = new RateLimiter(50); // profiles / boosts: 60 rpm
  const fast = new RateLimiter(config.dexscreenerRpm); // pairs: 300 rpm
  let okCount = 0;

  const fail = (lim) => (err) => {
    if (err?.status === 429) lim.pause(30_000);
    store.setSource(NAME, 'error', errMsg(err));
  };

  function applyPairs(pairs, onlyMints) {
    const groups = new Map();
    for (const p of pairs || []) {
      if (p?.chainId !== chain.dex) continue;
      const mint = norm(p.baseToken?.address);
      if (!isAddr(mint) || (onlyMints && !onlyMints.has(mint))) continue;
      if (!groups.has(mint)) groups.set(mint, []);
      groups.get(mint).push(p);
    }
    const now = Date.now();
    for (const [mint, group] of groups) {
      const curvePools = store.get(mint)?.curvePools;
      const { hadCurve, curveDex, dexSince, ...patch } = pairsToPatch(group, curvePools);
      // Still on a curve GeckoTerminal knows about and DexScreener only sees a dust pool: leave the
      // market data to GeckoTerminal (and don't mark DexScreener's data as fresh, which would make
      // GeckoTerminal skip its own update).
      const curveOnly = curvePools?.size && !patch.graduated;
      if (curveOnly) {
        for (const k of ['priceUsd', 'mcap', 'fdv', 'liquidity', 'pairAddress', 'dexId', 'dexUrl', 'change', 'volume', 'txns']) delete patch[k];
      }
      const t = store.upsert(mint, patch, NAME);
      if (!t) continue;
      if (curveOnly) continue;
      // Where the token was launched (its curve pool's DEX), for the launchpad badge.
      if (curveDex && !t.launchpad) t.launchpad = curveDex === 'pumpfun' ? 'pump' : curveDex;
      t.enriched.dexAt = now;
      // The first DEX pool of a launchpad token is created at graduation.
      const fromLaunchpad = hadCurve || t.launchpad || (!chain.evm && /(pump|bonk)$/.test(mint));
      if (patch.graduated && fromLaunchpad && !t.migratedAt && dexSince) t.migratedAt = dexSince;
      if ((patch.volume.m5 || 0) > 0) t.lastActivity = Math.max(t.lastActivity, now - 60_000);
      // Still on the pump.fun curve: derive progress from the curve pair's SOL price.
      const curve = group.find((p) => p.dexId === 'pumpfun' && p.quoteToken?.address === 'So11111111111111111111111111111111111111112');
      if (curve && !t.graduated) {
        t.launchpad ??= 'pump';
        const progress = Store.pumpProgressFromPriceSol(num(curve.priceNative));
        if (progress != null) t.bondingProgress = progress;
      }
    }
    return [...groups.keys()];
  }

  async function discovery() {
    const endpoints = [
      ['token-profiles/latest/v1', 'dex:profiles'],
      ['token-boosts/latest/v1', 'dex:boosts'],
      ['token-boosts/top/v1', 'dex:topBoosts'],
      ['community-takeovers/latest/v1', null],
    ];
    for (const [path, rankName] of endpoints) {
      const data = await slow.run(() => getJSON(`${BASE}/${path}`));
      const list = (Array.isArray(data) ? data : []).filter((x) => x.chainId === chain.dex && isAddr(x.tokenAddress));
      for (const item of list) {
        const socials = linksToSocials(item.links);
        store.upsert(
          item.tokenAddress,
          {
            image: iconUrl(item.icon),
            description: item.description,
            hasProfile: true,
            boosts: num(item.totalAmount),
            socials: Object.keys(socials).length ? socials : undefined,
          },
          NAME,
        );
      }
      if (rankName) store.setRanking(rankName, list.map((x) => norm(x.tokenAddress)));
    }
    store.setSource(NAME, 'ok', `OK · ${++okCount} odświeżeń`);
  }

  async function enrichLoop() {
    for (;;) {
      if (!active()) {
        await sleep(500);
        continue;
      }
      const batch = store.pickForRefresh('dex', 30, Date.now(), {
        // Fresh launches get refreshed every minute: without a paid PumpPortal key this is
        // where their live activity (txns / volume / curve progress) comes from.
        // Top 100 every 5 s, the next 400 / active ones every 20 s (≈90 of the 300 req/min allowed).
        intervals: { top: config.refreshTopMs ?? 5_000, hot: 20_000, young: 60_000 },
      });
      if (!batch.length) {
        await sleep(1000);
        continue;
      }
      try {
        const mints = batch.map((t) => t.mint);
        const data = await fast.run(() => getJSON(`${BASE}/tokens/v1/${chain.dex}/${mints.join(',')}`));
        applyPairs(Array.isArray(data) ? data : data?.pairs, new Set(mints));
        store.setSource(NAME, 'ok', `OK · ${++okCount} odświeżeń`);
      } catch (err) {
        fail(fast)(err);
        await sleep(2000);
      }
    }
  }

  every(30_000, discovery, fail(slow), active);

  enrichLoop();

  const api = {
    /** Whether the token's DexScreener profile is paid for ("DEX paid"), cached for 10 minutes. */
    async paid(mint, force = false) {
      const t = store.get(mint);
      if (!t || (!force && Date.now() - (t.dexPaidAt || 0) < 10 * 60_000)) return t?.dexPaid;
      const data = await slow.run(() => getJSON(`${BASE}/orders/v1/${chain.dex}/${t.mint}`));
      const orders = Array.isArray(data) ? data : data?.orders || [];
      t.dexPaid = orders.some((o) => o.type === 'tokenProfile' && o.status === 'approved');
      t.dexPaidAt = Date.now();
      return t.dexPaid;
    },
    /** Free-text / CA search across the whole network — adds results to the radar. */
    async search(q) {
      const data = await fast.run(() => getJSON(`${BASE}/latest/dex/search?q=${encodeURIComponent(q)}`));
      return applyPairs(data?.pairs);
    },
    async refresh(mint) {
      mint = norm(mint);
      const data = await fast.run(() => getJSON(`${BASE}/tokens/v1/${chain.dex}/${mint}`));
      return applyPairs(Array.isArray(data) ? data : data?.pairs, new Set([mint]));
    },
  };

  // "DEX paid" for the listed tokens: one orders lookup every 4 s (top 100 re-checked every 20 min).
  every(
    4000,
    async () => {
      const [t] = store.pickForRefresh('paid', 1, Date.now(), {
        intervals: { top: 20 * 60_000, hot: 60 * 60_000, young: 60 * 60_000, rest: 24 * 3600_000 },
        filter: (tok) => (store.rank.get(tok.mint) || Infinity) <= 100 || tok.pinnedUntil > Date.now(),
      });
      if (t) await api.paid(t.mint, true);
    },
    () => {},
    active,
  );

  return api;
}
