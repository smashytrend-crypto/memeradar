// GeckoTerminal public API (https://www.geckoterminal.com/dex-api): trending + new pools per network,
// and 15-minute price candles (OHLCV) for the top tokens — used for the 4h change and the
// mini charts, since DexScreener only reports 5m / 1h / 6h / 24h changes.
import { IS_BROWSER, RateLimiter, errMsg, every, getJSON, num, toMs } from '../util.js?v=mutlqg2c';
import { gtCurve, isAddressOn, normAddr } from '../chains.js?v=mutlqg2c';

const API = 'https://api.geckoterminal.com/api/v2/networks';
const NAME = 'geckoterminal';
const HEADERS = { accept: 'application/json;version=20230302' };
const MIN = 60_000;
export const CANDLE_MS = 15 * MIN;

/**
 * OHLCV response → candles as [startMs, open, close], oldest first. GeckoTerminal lists newest
 * first and leaves out intervals without trades; rows with a non-positive price are dropped.
 */
export function parseOhlcv(json) {
  const list = json?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const row of list) {
    if (!Array.isArray(row)) continue;
    const ts = num(row[0]);
    const open = num(row[1]);
    const close = num(row[4]);
    if (!(ts > 0) || !(open > 0) || !(close > 0)) continue;
    out.push([ts * 1000, open, close]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

export function poolToPatch(pool, tokensById, network = 'solana') {
  const a = pool.attributes || {};
  const baseId = pool.relationships?.base_token?.data?.id || '';
  const prefix = `${network}_`;
  const mint = baseId.startsWith(prefix) ? baseId.slice(prefix.length) : '';
  const tok = tokensById.get(baseId)?.attributes || {};
  const tx = a.transactions || {};
  const pc = a.price_change_percentage || {};
  const vol = a.volume_usd || {};
  const txn = (k) => (tx[k] ? { buys: num(tx[k].buys), sells: num(tx[k].sells) } : undefined);
  return {
    mint,
    dex: pool.relationships?.dex?.data?.id,
    pool: a.address,
    patch: {
      name: tok.name,
      symbol: tok.symbol,
      image: tok.image_url && tok.image_url !== 'missing.png' ? tok.image_url : undefined,
      priceUsd: num(a.base_token_price_usd),
      mcap: num(a.market_cap_usd) ?? num(a.fdv_usd),
      fdv: num(a.fdv_usd),
      liquidity: num(a.reserve_in_usd),
      change: { m5: num(pc.m5) ?? 0, h1: num(pc.h1) ?? 0, h6: num(pc.h6) ?? 0, h24: num(pc.h24) ?? 0 },
      volume: { m5: num(vol.m5), h1: num(vol.h1), h6: num(vol.h6), h24: num(vol.h24) },
      txns: { m5: txn('m5'), h1: txn('h1'), h6: txn('h6'), h24: txn('h24') },
      createdAt: toMs(a.pool_created_at),
    },
  };
}

// One budget for every network's engine: the free tier's limit is per IP.
const shared = { lim: null };

export function startGeckoTerminal(store) {
  const chain = store.chain;
  const BASE = `${API}/${chain.gt}`;
  const active = () => store.active;
  // Free (keyless) tier: about 10 requests/min per IP, and it varies with their traffic. Stay
  // under it: pool lists take ~2–3 of these, candles the rest.
  const lim = (shared.lim ??= new RateLimiter(6));
  let strikes = 0;
  let okCount = 0;
  let lastOk = 0;

  async function fetchPools(path, rankName) {
    const json = await lim.run(() => getJSON(`${BASE}/${path}`, { headers: HEADERS }));
    const tokensById = new Map((json.included || []).filter((x) => x.type === 'token').map((x) => [x.id, x]));
    const mints = [];
    const now = Date.now();
    for (const pool of json.data || []) {
      const { mint: raw, patch, dex, pool: poolAddr } = poolToPatch(pool, tokensById, chain.gt);
      const mint = normAddr(chain, raw);
      if (!isAddressOn(chain, mint)) continue;
      // A launchpad's bonding-curve pool: the token hasn't graduated to a real DEX yet.
      const curve = gtCurve(dex, chain.gt);
      if (curve) patch.launchpad = curve;
      const existing = store.get(mint);
      // DexScreener aggregates across all pairs; prefer it when fresh.
      if (existing && now - (existing.enriched.dexAt || 0) < 120_000) {
        for (const k of ['priceUsd', 'mcap', 'fdv', 'liquidity', 'change', 'volume', 'txns']) delete patch[k];
      }
      const t = store.upsert(mint, patch, NAME);
      if (!t) continue;
      if (curve && poolAddr) {
        const key = String(poolAddr).toLowerCase();
        if (!t.curvePools?.has(key)) {
          (t.curvePools ??= new Set()).add(key);
          // DexScreener may have counted the curve (or a dust pool) as graduation before the
          // curve was known: undo it; its next refresh re-decides with the curve in mind.
          if (t.graduated && (t.liquidity || 0) < 1000) {
            t.graduated = false;
            t.migratedAt = 0;
            t.bondingProgress = null;
          }
        }
      }
      mints.push(mint);
    }
    if (rankName) store.setRanking(rankName, mints);
  }

  // A 429 carries no CORS header, so in the browser it surfaces as a bare TypeError without a
  // status (as does a dropped connection). Treat both as the rate limit: pause 30 s, doubling
  // while they keep coming (max 2 min). That is a short wait, not an outage — shown in yellow.
  const blind = (err) => IS_BROWSER && err instanceof TypeError && err.status == null;
  const fail = (err) => {
    if (err?.status === 429 || blind(err)) {
      const ms = Math.min(30_000 * 2 ** strikes++, 2 * MIN);
      lim.pause(ms);
      // Data arrived recently: a short enforced pause is routine, keep the dot green.
      const recent = Date.now() - lastOk < 4 * MIN;
      store.setSource(NAME, recent ? 'ok' : 'connecting', `${recent ? `OK · ${okCount} odświeżeń · ` : ''}krótka przerwa (limit darmowego API) — wznawiam za ${Math.round(ms / 1000)} s`);
      return;
    }
    store.setSource(NAME, 'error', errMsg(err));
  };
  const ok = () => {
    strikes = 0;
    lastOk = Date.now();
    store.setSource(NAME, 'ok', `OK · ${++okCount} odświeżeń`);
  };

  every(
    120_000,
    async () => {
      await fetchPools('trending_pools?include=base_token&duration=5m', 'gecko:trending5m');
      await fetchPools('trending_pools?include=base_token&duration=1h', 'gecko:trending1h');
      ok();
    },
    fail,
    active,
  );
  every(
    90_000,
    async () => {
      await fetchPools('new_pools?include=base_token&page=1', null);
      ok();
    },
    fail,
    active,
  );
  // EVM networks have few DexScreener profiles / boosts: the busiest pools fill the radar instead.
  if (chain.evm) {
    every(
      180_000,
      async () => {
        await fetchPools('pools?include=base_token&sort=h24_tx_count_desc&page=1', 'gecko:busy');
        await fetchPools('pools?include=base_token&sort=h24_volume_usd_desc&page=1', 'gecko:volume');
        await fetchPools('trending_pools?include=base_token&duration=6h&page=1', 'gecko:trending6h');
        await fetchPools('new_pools?include=base_token&page=2', null);
        ok();
      },
      fail,
      active,
    );
  }

  // 24 h of 15-minute candles per token, from the same pool DexScreener prices it by (tokens can
  // have several pools at very different prices). The top 100 refresh every ~5 minutes.
  every(
    2_500,
    async () => {
      const now = Date.now();
      // EVM radars are filled from GeckoTerminal's pool lists: let discovery use the shared
      // budget first, until the list has some depth.
      if (chain.evm && store.ranked.length < 40) return;
      const [t] = store.pickForRefresh('ohlcv', 1, now, {
        intervals: { top: 5 * MIN, hot: 15 * MIN, young: 20 * MIN, rest: 6 * 60 * MIN },
        filter: (tok) => !!tok.pairAddress && ((store.rank.get(tok.mint) || Infinity) <= 150 || tok.pinnedUntil > now),
      });
      if (!t) return;
      const pool = t.pairAddress;
      let json;
      try {
        json = await lim.run(() =>
          getJSON(`${BASE}/pools/${pool}/ohlcv/minute?aggregate=15&limit=97&currency=usd&token=${t.mint}`, { headers: HEADERS }),
        );
      } catch (err) {
        // Put the token back in the queue so it is retried soon after the pause.
        if (err?.status !== 404) t.enriched.ohlcv = 0;
        throw err;
      }
      if (t.pairAddress === pool) store.setCandles(t.mint, parseOhlcv(json), pool);
      ok();
    },
    (err) => {
      // A pool GeckoTerminal doesn't know (404) is not a source outage.
      if (err?.status !== 404) fail(err);
    },
    active,
  );
}
