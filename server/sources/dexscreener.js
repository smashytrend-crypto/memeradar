// DexScreener public API (https://docs.dexscreener.com/api/reference):
// discovery (profiles / boosts) + batched market data for every tracked token.
import { RateLimiter, errMsg, every, getJSON, isMint, num, sleep, toMs } from '../util.js';
import { Store } from '../store.js';
import { isCurvePair } from '../constants.js';

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

/** Merges all pairs of one base token into a single token patch. */
export function pairsToPatch(pairs) {
  const sorted = [...pairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const top = sorted[0];
  const sum = (path) => pairs.reduce((acc, p) => acc + (path(p) || 0), 0);
  const created = Math.min(...pairs.map((p) => p.pairCreatedAt || Infinity));
  const dexPairs = pairs.filter((p) => !isCurvePair(p));
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
    change: {
      m5: num(top.priceChange?.m5),
      h1: num(top.priceChange?.h1),
      h6: num(top.priceChange?.h6),
      h24: num(top.priceChange?.h24),
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
    boosts: num(top.boosts?.active),
    socials: Object.keys(socials).length ? socials : undefined,
    // Trades on a real DEX pool (for launchpad tokens: the curve is finished).
    graduated: dexPairs.length > 0 || undefined,
    hadCurve: dexPairs.length < pairs.length,
    dexSince: Number.isFinite(dexSince) ? toMs(dexSince) : undefined,
  };
}

export function startDexScreener(store, config) {
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
      if (p?.chainId !== 'solana') continue;
      const mint = p.baseToken?.address;
      if (!isMint(mint) || (onlyMints && !onlyMints.has(mint))) continue;
      if (!groups.has(mint)) groups.set(mint, []);
      groups.get(mint).push(p);
    }
    const now = Date.now();
    for (const [mint, group] of groups) {
      const { hadCurve, dexSince, ...patch } = pairsToPatch(group);
      const t = store.upsert(mint, patch, NAME);
      if (!t) continue;
      t.enriched.dexAt = now;
      // The first DEX pool of a launchpad token is created at graduation.
      const fromLaunchpad = hadCurve || t.launchpad || /(pump|bonk)$/.test(mint);
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
      const list = (Array.isArray(data) ? data : []).filter((x) => x.chainId === 'solana' && isMint(x.tokenAddress));
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
      if (rankName) store.setRanking(rankName, list.map((x) => x.tokenAddress));
    }
    store.setSource(NAME, 'ok', `OK · ${++okCount} odświeżeń`);
  }

  async function enrichLoop() {
    for (;;) {
      const batch = store.pickForRefresh('dex', 30, Date.now(), {
        // Fresh launches get refreshed every minute: without a paid PumpPortal key this is
        // where their live activity (txns / volume / curve progress) comes from.
        intervals: { young: 60_000 },
      });
      if (!batch.length) {
        await sleep(1000);
        continue;
      }
      try {
        const mints = batch.map((t) => t.mint);
        const data = await fast.run(() => getJSON(`${BASE}/tokens/v1/solana/${mints.join(',')}`));
        applyPairs(Array.isArray(data) ? data : data?.pairs, new Set(mints));
        store.setSource(NAME, 'ok', `OK · ${++okCount} odświeżeń`);
      } catch (err) {
        fail(fast)(err);
        await sleep(2000);
      }
    }
  }

  every(30_000, discovery, fail(slow));
  enrichLoop();

  return {
    /** Free-text / CA search across all of Solana — adds results to the radar. */
    async search(q) {
      const data = await fast.run(() => getJSON(`${BASE}/latest/dex/search?q=${encodeURIComponent(q)}`));
      return applyPairs(data?.pairs);
    },
    async refresh(mint) {
      const data = await fast.run(() => getJSON(`${BASE}/tokens/v1/solana/${mint}`));
      return applyPairs(Array.isArray(data) ? data : data?.pairs, new Set([mint]));
    },
  };
}
