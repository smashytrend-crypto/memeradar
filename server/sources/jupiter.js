// Jupiter Tokens API v2 (https://dev.jup.ag/docs/tokens): trending / organic lists, holder counts,
// organic score, audit (mint/freeze authority, top holders) and bonding-curve progress. Also SOL price.
import { RateLimiter, errMsg, every, getJSON, isMint, num, toMs } from '../util.js?v=mv2qi6wu';

const BASE = 'https://lite-api.jup.ag';
const NAME = 'jupiter';
const SOL = 'So11111111111111111111111111111111111111112';

const z = (v) => num(v) ?? 0;

export function jupToPatch(j) {
  const s1 = j.stats1h || {};
  const s5 = j.stats5m || {};
  const s6 = j.stats6h || {};
  const s24 = j.stats24h || {};
  const a = j.audit || {};
  const socials = {};
  if (j.twitter) socials.twitter = j.twitter;
  if (j.telegram) socials.telegram = j.telegram;
  if (j.website) socials.website = j.website;
  const lp = String(j.launchpad || '').toLowerCase();
  return {
    name: j.name,
    symbol: j.symbol,
    creator: typeof j.dev === 'string' ? j.dev : undefined,
    image: j.icon,
    holders: num(j.holderCount),
    holderChange1h: z(s1.holderChange),
    priceUsd: num(j.usdPrice),
    mcap: num(j.mcap),
    fdv: num(j.fdv),
    liquidity: num(j.liquidity),
    organicScore: num(j.organicScore),
    organicLabel: j.organicScoreLabel,
    traders1h: z(s1.numTraders),
    // Buy / sell volume in USD and trade counts across all pools — DexScreener only reports the
    // total volume, and counts for one pair. Jupiter leaves out zero fields (and quiet windows),
    // so a missing value means 0, not "unknown".
    buyVol: { m5: z(s5.buyVolume), h1: z(s1.buyVolume), h6: z(s6.buyVolume), h24: z(s24.buyVolume) },
    sellVol: { m5: z(s5.sellVolume), h1: z(s1.sellVolume), h6: z(s6.sellVolume), h24: z(s24.sellVolume) },
    jupTx: { b5: z(s5.numBuys), s5: z(s5.numSells), b1: z(s1.numBuys), s1: z(s1.numSells) },
    verified: !!j.isVerified,
    tags: Array.isArray(j.tags) ? j.tags : undefined,
    launchpad: lp.includes('pump') ? 'pump' : lp.includes('bonk') || lp.includes('letsbonk') ? 'bonk' : lp ? lp : undefined,
    bondingProgress: num(j.bondingCurve),
    graduated: j.graduatedPool ? true : undefined,
    migratedAt: toMs(j.graduatedAt),
    createdAt: toMs(j.firstPool?.createdAt),
    socials: Object.keys(socials).length ? socials : undefined,
    audit:
      j.audit &&
      {
        mintAuthorityDisabled: a.mintAuthorityDisabled,
        freezeAuthorityDisabled: a.freezeAuthorityDisabled,
        topHoldersPercentage: num(a.topHoldersPercentage),
        // Jupiter leaves out zero fields: no dev balance listed means the dev holds none.
        devBalancePercentage: num(a.devBalancePercentage) ?? 0,
        // Creator history: tokens the dev has launched, and how many of them graduated.
        devMints: num(a.devMints),
        devMigrations: a.devMints != null ? num(a.devMigrations) ?? 0 : undefined,
      },
    // Jupiter's % changes back-fill tokens DexScreener has not refreshed yet.
    jupChange: { m5: z(s5.priceChange), h1: z(s1.priceChange), h6: z(s6.priceChange), h24: z(s24.priceChange) },
  };
}

export function startJupiter(store) {
  const lim = new RateLimiter(40);
  let okCount = 0;
  const ok = () => store.setSource(NAME, 'ok', `OK · ${++okCount} odświeżeń`);
  const fail = (err) => {
    if (err?.status === 429) lim.pause(30_000);
    store.setSource(NAME, 'error', errMsg(err));
  };

  function apply(list) {
    const mints = [];
    const now = Date.now();
    for (const j of Array.isArray(list) ? list : []) {
      if (!isMint(j?.id)) continue;
      const { jupChange, ...patch } = jupToPatch(j);
      const existing = store.get(j.id);
      if (!existing || now - (existing.enriched.dexAt || 0) > 120_000) patch.change = jupChange;
      if (existing && now - (existing.enriched.dexAt || 0) < 120_000) {
        delete patch.priceUsd;
        delete patch.mcap;
        delete patch.liquidity;
      }
      const t = store.upsert(j.id, patch, NAME);
      if (t) {
        t.enriched.jupAt = now;
        mints.push(j.id);
      }
    }
    return mints;
  }

  const lists = [
    ['tokens/v2/toptrending/5m?limit=100', 'jup:trending5m'],
    ['tokens/v2/toptrending/1h?limit=100', 'jup:trending1h'],
    ['tokens/v2/toporganicscore/1h?limit=100', 'jup:organic1h'],
    ['tokens/v2/toptraded/1h?limit=100', 'jup:traded1h'],
    ['tokens/v2/recent?limit=100', null],
  ];

  every(
    45_000,
    async () => {
      for (const [path, rank] of lists) {
        const mints = apply(await lim.run(() => getJSON(`${BASE}/${path}`)));
        if (rank) store.setRanking(rank, mints);
      }
      ok();
    },
    fail,
    () => store.active,
  );

  every(
    30_000,
    async () => {
      const data = await lim.run(() => getJSON(`${BASE}/price/v3?ids=${SOL}`));
      const p = num(data?.[SOL]?.usdPrice);
      if (p) store.solPrice = p;
    },
    fail,
    () => store.active,
  );

  // Holder counts, audit and buy/sell volume for whatever currently ranks: up to 100 mints per
  // call, so the top 100 refresh every ~15 s for ~6 requests a minute.
  every(
    5_000,
    async () => {
      const batch = store.pickForRefresh('jup', 100, Date.now(), {
        intervals: { top: 15_000, hot: 60_000, young: 180_000, rest: 30 * 60_000 },
        filter: (t) => t.hype.score > 3 || t.pinnedUntil > Date.now() || (t.launchpad && !t.graduated && t.bondingProgress >= 20),
      });
      if (!batch.length) return;
      apply(await lim.run(() => getJSON(`${BASE}/tokens/v2/search?query=${batch.map((t) => t.mint).join(',')}`)));
      ok();
    },
    fail,
    () => store.active,
  );

  return {
    async refresh(mint) {
      return apply(await lim.run(() => getJSON(`${BASE}/tokens/v2/search?query=${mint}`)));
    },
  };
}
