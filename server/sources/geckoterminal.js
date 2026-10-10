// GeckoTerminal public API (https://www.geckoterminal.com/dex-api): trending + new pools per network,
// and 15-minute price candles (OHLCV) for the top tokens — used for the 4h change and the
// mini charts, since DexScreener only reports 5m / 1h / 6h / 24h changes.
import { IS_BROWSER, RateLimiter, errMsg, every, getJSON, num, toMs } from '../util.js?v=mv2qm0je';
import { gtCurve, isAddressOn, normAddr } from '../chains.js?v=mv2qm0je';

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

/** OHLCV response → full candles [startMs, open, high, low, close, volumeUsd], oldest first. */
export function parseOhlcvFull(json) {
  const list = json?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const row of list) {
    if (!Array.isArray(row)) continue;
    const [ts, o, h, l, c, v] = row.map(num);
    if (!(ts > 0) || !(o > 0) || !(c > 0)) continue;
    out.push([ts * 1000, o, Math.max(h || 0, o, c), Math.min(l > 0 ? l : Infinity, o, c), c, v || 0]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * Pool trades response → [{ t, side, usd, wallet, tx, price, amount }], newest first. `mint` picks
 * the token side (a trade's price / amount are for the token, not the quote coin).
 */
export function parseTrades(json, mint) {
  const list = Array.isArray(json?.data) ? json.data : [];
  const m = String(mint || '').toLowerCase();
  const out = [];
  for (const x of list) {
    const a = x?.attributes || {};
    const side = a.kind === 'buy' || a.kind === 'sell' ? a.kind : null;
    if (!side) continue;
    // On a buy the token is what was received ("to"); on a sell it is what was given ("from").
    const toIsToken = String(a.to_token_address || '').toLowerCase() === m;
    const fromIsToken = String(a.from_token_address || '').toLowerCase() === m;
    const tokenSide = toIsToken ? 'to' : fromIsToken ? 'from' : side === 'buy' ? 'to' : 'from';
    const t = toMs(a.block_timestamp);
    const usd = num(a.volume_in_usd);
    if (!(t > 0) || !(usd >= 0)) continue;
    out.push({
      t,
      side,
      usd,
      wallet: typeof a.tx_from_address === 'string' ? a.tx_from_address : '',
      tx: typeof a.tx_hash === 'string' ? a.tx_hash : '',
      price: num(a[`price_${tokenSide}_in_usd`]) || null,
      amount: num(a[`${tokenSide}_token_amount`]) || 0,
    });
  }
  return out.sort((a, b) => b.t - a.t);
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

  // false when the network went off screen (queued jobs of a paused network are dropped).
  async function fetchPools(path, rankName) {
    if (!store.active) return false;
    const json = await lim.run(() => (store.active ? getJSON(`${BASE}/${path}`, { headers: HEADERS }) : null));
    if (!json) return false;
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
    return true;
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
      if (!(await fetchPools('trending_pools?include=base_token&duration=5m', 'gecko:trending5m'))) return;
      if (!(await fetchPools('trending_pools?include=base_token&duration=1h', 'gecko:trending1h'))) return;
      ok();
    },
    fail,
    active,
  );
  every(
    90_000,
    async () => {
      if (await fetchPools('new_pools?include=base_token&page=1', null)) ok();
    },
    fail,
    active,
  );
  // EVM networks have few DexScreener profiles / boosts: the busiest pools fill the radar instead.
  if (chain.evm) {
    every(
      180_000,
      async () => {
        for (const [path, rank] of [
          ['pools?include=base_token&sort=h24_tx_count_desc&page=1', 'gecko:busy'],
          ['pools?include=base_token&sort=h24_volume_usd_desc&page=1', 'gecko:volume'],
          ['trending_pools?include=base_token&duration=6h&page=1', 'gecko:trending6h'],
          ['new_pools?include=base_token&page=2', null],
        ]) {
          if (!(await fetchPools(path, rank))) return;
        }
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
      // A token window is open: its trades / candles get the budget (they are what the viewer
      // is looking at); background candles wait.
      // While a token window is open (polled every 4 s) its chart / trades come first.
      if (now - (store.viewingAt || 0) < 8_000 || now - (store.focusAt || 0) < 15_000) return;
      const [t] = store.pickForRefresh('ohlcv', 1, now, {
        intervals: { top: 5 * MIN, hot: 15 * MIN, young: 20 * MIN, rest: 6 * 60 * MIN },
        filter: (tok) => !!tok.pairAddress && ((store.rank.get(tok.mint) || Infinity) <= 150 || tok.pinnedUntil > now),
      });
      if (!t) return;
      const pool = t.pairAddress;
      let json;
      try {
        json = await lim.run(() =>
          store.active ? getJSON(`${BASE}/pools/${pool}/ohlcv/minute?aggregate=15&limit=97&currency=usd&token=${t.mint}`, { headers: HEADERS }) : null,
        );
        if (!json) return; // the network went off screen while queued
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

  // Viewer requests share the backoff: a 429 pauses the limiter like any background call.
  const guard = async (p) => {
    try {
      const json = await p;
      ok();
      return json;
    } catch (err) {
      if (err?.status !== 404) fail(err);
      throw err;
    }
  };
  const TF = { '1m': ['minute', 1], '5m': ['minute', 5], '15m': ['minute', 15], '1h': ['hour', 1], '4h': ['hour', 4] };
  return {
    /** Latest ~300 trades of the token's main pool, newest first (`priority`: the viewer waits). */
    async trades(t, priority = false) {
      if (!t?.pairAddress) return [];
      const pool = t.pairAddress;
      const json = await guard(lim.run(() => getJSON(`${BASE}/pools/${pool}/trades`, { headers: HEADERS }), priority));
      return parseTrades(json, t.mint);
    },
    /** Full candles for the chart: tf = 1m / 5m / 15m / 1h / 4h. */
    async candles(t, tf = '5m', priority = false, pool = t?.pairAddress) {
      if (!pool) return [];
      const [unit, agg] = TF[tf] || TF['5m'];
      const json = await guard(
        lim.run(() => getJSON(`${BASE}/pools/${pool}/ohlcv/${unit}?aggregate=${agg}&limit=200&currency=usd&token=${t.mint}`, { headers: HEADERS }), priority),
      );
      return parseOhlcvFull(json);
    },
    /** The token's pools on GeckoTerminal, most liquid first (addresses). */
    async tokenPools(t, priority = false) {
      const json = await guard(lim.run(() => getJSON(`${BASE}/tokens/${t.mint}/pools?page=1`, { headers: HEADERS }), priority));
      return (Array.isArray(json?.data) ? json.data : [])
        .map((p) => ({ a: p?.attributes?.address, liq: num(p?.attributes?.reserve_in_usd) || 0 }))
        .filter((p) => typeof p.a === 'string')
        .sort((a, b) => b.liq - a.liq)
        .map((p) => p.a);
    },
    /** Token info: developer address / holding (EVM dev check), holder distribution, categories. */
    async info(t, priority = false) {
      const json = await guard(lim.run(() => getJSON(`${BASE}/tokens/${t.mint}/info`, { headers: HEADERS }), priority));
      const a = json?.data?.attributes || {};
      return {
        dev: typeof a.developer_address === 'string' ? normAddr(chain, a.developer_address) : null,
        devPct: num(a.developer_holding_percentage) ?? null,
        holders: num(a.holders?.count) ?? null,
        categories: Array.isArray(a.categories) ? a.categories.slice(0, 6) : [],
      };
    },
  };
}
