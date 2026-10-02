// RugCheck (https://api.rugcheck.xyz/swagger/index.html): safety report for top tokens.
import { RateLimiter, errMsg, every, getJSON } from '../util.js?v=murdi7b2';

const BASE = 'https://api.rugcheck.xyz/v1';
const NAME = 'rugcheck';

export function startRugCheck(store) {
  const lim = new RateLimiter(20);
  let okCount = 0;
  store.setSource(NAME, 'connecting', 'czeka na tokeny w czołówce rankingu');

  async function check(t) {
    const r = await lim.run(() => getJSON(`${BASE}/tokens/${t.mint}/report/summary`));
    t.rug = {
      score: r.score_normalised ?? r.score,
      risks: (r.risks || []).map((x) => ({
        name: x.name,
        description: x.description,
        value: x.value,
        level: x.level,
      })),
      lpLockedPct: r.lpLockedPct,
      at: Date.now(),
    };
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
