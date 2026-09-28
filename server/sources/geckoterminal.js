// GeckoTerminal public API (https://www.geckoterminal.com/dex-api): trending + new Solana pools.
import { RateLimiter, errMsg, every, getJSON, isMint, num, toMs } from '../util.js';

const BASE = 'https://api.geckoterminal.com/api/v2/networks/solana';
const NAME = 'geckoterminal';
const HEADERS = { accept: 'application/json;version=20230302' };

export function poolToPatch(pool, tokensById) {
  const a = pool.attributes || {};
  const baseId = pool.relationships?.base_token?.data?.id || '';
  const mint = baseId.startsWith('solana_') ? baseId.slice(7) : '';
  const tok = tokensById.get(baseId)?.attributes || {};
  const tx = a.transactions || {};
  const pc = a.price_change_percentage || {};
  const vol = a.volume_usd || {};
  const txn = (k) => (tx[k] ? { buys: num(tx[k].buys), sells: num(tx[k].sells) } : undefined);
  return {
    mint,
    patch: {
      name: tok.name,
      symbol: tok.symbol,
      image: tok.image_url && tok.image_url !== 'missing.png' ? tok.image_url : undefined,
      priceUsd: num(a.base_token_price_usd),
      mcap: num(a.market_cap_usd) ?? num(a.fdv_usd),
      fdv: num(a.fdv_usd),
      liquidity: num(a.reserve_in_usd),
      change: { m5: num(pc.m5), h1: num(pc.h1), h6: num(pc.h6), h24: num(pc.h24) },
      volume: { m5: num(vol.m5), h1: num(vol.h1), h6: num(vol.h6), h24: num(vol.h24) },
      txns: { m5: txn('m5'), h1: txn('h1'), h6: txn('h6'), h24: txn('h24') },
      createdAt: toMs(a.pool_created_at),
    },
  };
}

export function startGeckoTerminal(store) {
  const lim = new RateLimiter(10); // free tier is 30 rpm per IP; stay well below
  let okCount = 0;

  async function fetchPools(path, rankName) {
    const json = await lim.run(() => getJSON(`${BASE}/${path}`, { headers: HEADERS }));
    const tokensById = new Map((json.included || []).filter((x) => x.type === 'token').map((x) => [x.id, x]));
    const mints = [];
    const now = Date.now();
    for (const pool of json.data || []) {
      const { mint, patch } = poolToPatch(pool, tokensById);
      if (!isMint(mint)) continue;
      const existing = store.get(mint);
      // DexScreener aggregates across all pairs; prefer it when fresh.
      if (existing && now - (existing.enriched.dexAt || 0) < 120_000) {
        for (const k of ['priceUsd', 'mcap', 'fdv', 'liquidity', 'change', 'volume', 'txns']) delete patch[k];
      }
      if (store.upsert(mint, patch, NAME)) mints.push(mint);
    }
    if (rankName) store.setRanking(rankName, mints);
  }

  const fail = (err) => {
    if (err?.status === 429) lim.pause(90_000);
    store.setSource(NAME, 'error', errMsg(err));
  };
  const ok = () => store.setSource(NAME, 'ok', `OK · ${++okCount} odświeżeń`);

  every(
    90_000,
    async () => {
      await fetchPools('trending_pools?include=base_token&duration=5m', 'gecko:trending5m');
      await fetchPools('trending_pools?include=base_token&duration=1h', 'gecko:trending1h');
      ok();
    },
    fail,
  );
  every(
    60_000,
    async () => {
      await fetchPools('new_pools?include=base_token&page=1', null);
      ok();
    },
    fail,
  );
}
