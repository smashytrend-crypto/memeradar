// RugCheck (https://api.rugcheck.xyz/swagger/index.html): safety report for top tokens.
import { RateLimiter, errMsg, every, getJSON } from '../util.js?v=mv2qoo8l';

const BASE = 'https://api.rugcheck.xyz/v1';
const NAME = 'rugcheck';

/** RugCheck full report → risks, LP burned % of the main pool, insider share of top holders. */
export function rugToReport(r) {
  const liq = (m) => (m.lp?.baseUSD || 0) + (m.lp?.quoteUSD || 0);
  const main = [...(r.markets || [])].sort((a, b) => liq(b) - liq(a))[0];
  const insiders = (r.topHolders || []).filter((h) => h.insider);
  return {
    score: r.score_normalised ?? r.score,
    risks: (r.risks || []).map((x) => ({ name: x.name, description: x.description, value: x.value, level: x.level })),
    lpBurnPct: main?.lp ? Number(main.lp.lpLockedPct) || 0 : null,
    insidersPct: r.topHolders ? insiders.reduce((a, h) => a + (Number(h.pct) || 0), 0) : null,
    insiders: r.graphInsidersDetected ?? insiders.length,
    creator: typeof r.creator === 'string' ? r.creator : undefined,
    // Main constant-product pool's vaults (token / quote reserves): the chart reads them straight
    // from the chain for a real-time price.
    pool: ((m) => {
      if (!m || !['pump_fun_amm', 'raydium', 'raydium_cpmm'].includes(m.marketType)) return null;
      const tokenIsA = m.mintA === r.mint;
      if (!tokenIsA && m.mintB !== r.mint) return null;
      const pool = { id: m.pubkey, type: m.marketType, base: tokenIsA ? m.liquidityA : m.liquidityB, quote: tokenIsA ? m.liquidityB : m.liquidityA, quoteMint: tokenIsA ? m.mintB : m.mintA };
      return typeof pool.base === 'string' && typeof pool.quote === 'string' ? pool : null;
    })(main),
    // Top holder wallets (owners), leaving out pools / AMMs / lockers: for the chart's "top 10
    // holders" entry level.
    holders: Array.isArray(r.topHolders)
      ? r.topHolders
          .filter((h) => h && typeof h.owner === 'string' && !(r.knownAccounts || {})[h.owner] && !(r.markets || []).some((m) => m?.pubkey === h.owner || m?.liquidityA === h.address || m?.liquidityB === h.address))
          .slice(0, 10)
          .map((h) => ({ a: h.owner, pct: Number(h.pct) || 0 }))
      : null,
    // The creator's other tokens with their current market cap (dev history).
    devTokens: Array.isArray(r.creatorTokens)
      ? r.creatorTokens
          .filter((x) => x && x.mint && x.mint !== r.mint)
          .map((x) => ({ mint: x.mint, mc: Number(x.marketCap) || 0, at: Date.parse(x.createdAt) || 0 }))
          .slice(0, 200)
      : null,
  };
}

export function startRugCheck(store) {
  const lim = new RateLimiter(20);
  let okCount = 0;
  store.setSource(NAME, 'connecting', 'czeka na tokeny w czołówce rankingu');

  async function check(t) {
    // Full report: besides the risks it carries the markets (LP burned / locked) and top holders
    // flagged as insiders.
    const r = await lim.run(() => getJSON(`${BASE}/tokens/${t.mint}/report`, { timeout: 20_000 }));
    const rep = rugToReport(r);
    t.rug = { ...rep, at: Date.now() };
    if (rep.devTokens) t.devTokens = rep.devTokens;
    if (rep.holders) t.topHolders = rep.holders;
    if (rep.pool) t.chainPool = rep.pool;
    if (rep.creator && !t.creator) store.upsert(t.mint, { creator: rep.creator }, NAME);
    store.setSource(NAME, 'ok', `OK · ${++okCount} raportów`);
  }

  const fail = (err) => {
    if (err?.status === 429) lim.pause(60_000);
    if (err?.status !== 404) store.setSource(NAME, 'error', errMsg(err));
  };

  every(
    5000,
    async () => {
      const batch = store.pickForRefresh('rug', 3, Date.now(), {
        intervals: { top: 10 * 60_000, hot: 20 * 60_000, young: 60 * 60_000, rest: 6 * 3600_000 },
        filter: (t) => (store.rank.get(t.mint) || Infinity) <= 150 || t.pinnedUntil > Date.now(),
      });
      for (const t of batch) await check(t).catch(fail);
    },
    fail,
    () => store.active,
  );

  return { check: (t) => check(t).catch(fail) };
}
