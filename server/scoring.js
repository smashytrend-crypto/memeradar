import { clamp } from './util.js?v=mv2bfqxf';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** log-scaled saturation: 0 → 0, `full` → 1. */
export const logSat = (x, full) => (x > 0 ? Math.min(1, Math.log1p(x) / Math.log1p(full)) : 0);

/** Aggregates live (on-chain stream) trades into 5m / 1h windows. */
export function liveStats(trades, now) {
  const s = { b5: 0, s5: 0, bv5: 0, sv5: 0, b1: 0, s1: 0, bv1: 0, sv1: 0, traders5: 0, traders1: 0 };
  if (!trades?.length) return s;
  const t5 = new Set();
  const t1 = new Set();
  for (const tr of trades) {
    const age = now - tr.t;
    if (age > HOUR || age < -MIN) continue;
    const buy = tr.side === 'buy';
    if (buy) (s.b1++, (s.bv1 += tr.sol));
    else (s.s1++, (s.sv1 += tr.sol));
    if (tr.trader) t1.add(tr.trader);
    if (age <= 5 * MIN) {
      if (buy) (s.b5++, (s.bv5 += tr.sol));
      else (s.s5++, (s.sv5 += tr.sol));
      if (tr.trader) t5.add(tr.trader);
    }
  }
  s.traders5 = t5.size;
  s.traders1 = t1.size;
  return s;
}

/** Holder growth per hour, from sampled history or Jupiter's 1h % change. */
export function holderGrowth(t, now) {
  const h = t.holdersHist;
  if (h?.length >= 2) {
    const last = h[h.length - 1];
    let first = h[0];
    for (const p of h) {
      if (last[0] - p[0] <= HOUR) {
        first = p;
        break;
      }
    }
    const span = last[0] - first[0];
    if (span >= 5 * MIN && now - last[0] < 30 * MIN) return ((last[1] - first[1]) / span) * HOUR;
  }
  if (t.holderChange1h != null && t.holders) {
    const prev = t.holders / (1 + t.holderChange1h / 100);
    return t.holders - prev;
  }
  return 0;
}

/** Risk flags from RugCheck + Jupiter audit + market structure. */
export function assessRisk(t) {
  const flags = [];
  let penalty = 0;
  let checked = false;

  if (t.rug) {
    checked = true;
    for (const r of t.rug.risks || []) {
      const level = r.level === 'danger' ? 'danger' : r.level === 'warn' ? 'warn' : 'info';
      if (level === 'info') continue;
      flags.push({ level, name: r.name, desc: r.description || '', value: r.value || '' });
      penalty += level === 'danger' ? 0.15 : 0.04;
    }
  }

  const a = t.audit;
  if (a) {
    checked = true;
    if (a.mintAuthorityDisabled === false) {
      flags.push({ level: 'danger', name: 'Aktywne mint authority', desc: 'Twórca może dodrukować tokeny.' });
      penalty += 0.25;
    }
    if (a.freezeAuthorityDisabled === false) {
      flags.push({ level: 'danger', name: 'Aktywne freeze authority', desc: 'Twórca może zamrozić Twoje tokeny.' });
      penalty += 0.25;
    }
    if (a.topHoldersPercentage > 50) {
      flags.push({ level: 'danger', name: 'Top 10 holderów > 50%', value: `${a.topHoldersPercentage.toFixed(1)}%` });
      penalty += 0.15;
    } else if (a.topHoldersPercentage > 30) {
      flags.push({ level: 'warn', name: 'Top 10 holderów > 30%', value: `${a.topHoldersPercentage.toFixed(1)}%` });
      penalty += 0.05;
    }
    if (a.devBalancePercentage > 10) {
      flags.push({ level: 'warn', name: 'Duży portfel dewelopera', value: `${a.devBalancePercentage.toFixed(1)}%` });
      penalty += 0.05;
    }
  }

  const onCurve = t.launchpad && !t.graduated;
  if (!onCurve && t.enriched?.dexAt && t.liquidity < 1000) {
    flags.push({ level: 'danger', name: 'Płynność praktycznie zerowa', value: `$${Math.round(t.liquidity || 0)}`, desc: 'Pula jest pusta — nie da się sprzedać.' });
    penalty += 0.4;
  } else if (!onCurve && t.liquidity > 0 && t.liquidity < 5000 && t.mcap > 50_000) {
    flags.push({ level: 'warn', name: 'Bardzo niska płynność', value: `$${Math.round(t.liquidity)}` });
    penalty += 0.1;
  }

  const level = flags.some((f) => f.level === 'danger')
    ? 'danger'
    : flags.some((f) => f.level === 'warn')
      ? 'warn'
      : checked
        ? 'ok'
        : 'unknown';
  return { level, flags, penalty: Math.min(0.6, penalty) };
}

/**
 * Derived market numbers: max of DEX aggregates and our own live trade stream
 * (the stream is fresher for young pump.fun tokens, DEX covers everything else).
 */
export function marketView(t, now, solPrice = 0) {
  const live = liveStats(t.trades, now);
  const tx = t.txns || {};
  const dexB5 = tx.m5?.buys || 0;
  const dexS5 = tx.m5?.sells || 0;
  const dexB1 = tx.h1?.buys || 0;
  const dexS1 = tx.h1?.sells || 0;
  const useLive5 = live.b5 + live.s5 > dexB5 + dexS5;
  const useLive1 = live.b1 + live.s1 > dexB1 + dexS1;
  return {
    live,
    buys5: useLive5 ? live.b5 : dexB5,
    sells5: useLive5 ? live.s5 : dexS5,
    buys1h: useLive1 ? live.b1 : dexB1,
    sells1h: useLive1 ? live.s1 : dexS1,
    vol5: Math.max(t.volume?.m5 || 0, (live.bv5 + live.sv5) * solPrice),
    vol1h: Math.max(t.volume?.h1 || 0, (live.bv1 + live.sv1) * solPrice),
    traders5: live.traders5,
    traders1h: Math.max(live.traders1, t.traders1h || 0),
  };
}

/**
 * Volume surge: last-5-minute volume vs. the token's own average 5-minute volume.
 * The baseline window is capped by the token's age, so a 20-minute-old token that
 * trades evenly scores ~1×, not 18× (6h volume spread over its real lifetime).
 */
export function volumeSurge(t, vol5, now) {
  // Age of the DEX market (a graduated token's pool starts at migration, not at launch).
  const age = now - (t.migratedAt || t.createdAt || now - 6 * HOUR);
  // A pool a few minutes old has no baseline yet: its first trades are a launch, not a surge.
  if (age < 15 * MIN) return 0;
  const h6 = t.volume?.h6 || 0;
  const h1 = t.volume?.h1 || 0;
  const window6 = Math.min(Math.max(age, 10 * MIN), 6 * HOUR);
  const window1 = Math.min(Math.max(age, 10 * MIN), HOUR);
  // Exclude the current 5 minutes from the baseline so the spike doesn't dilute itself.
  const avg6 = Math.max(0, h6 - vol5) / Math.max(1, window6 / (5 * MIN) - 1);
  const avg1 = Math.max(0, h1 - vol5) / Math.max(1, window1 / (5 * MIN) - 1);
  // Floor: below ~$250 per 5 min a token is effectively dormant; cap keeps ratios readable.
  const baseline = Math.max(avg6, avg1 * 0.5, 250);
  return vol5 > 0 ? Math.min(99, vol5 / baseline) : 0;
}

const BASE_WEIGHTS = {
  momentum: 0.18,
  volume: 0.12,
  surge: 0.12,
  pressure: 0.07,
  price: 0.07,
  social: 0.2,
  discovery: 0.12,
  holders: 0.12,
};

/**
 * Hype Score 0–100. Every part is normalised to 0..1, weighted, then
 * multiplied by a risk factor. Pure function of the token + context.
 */
export function computeHype(t, now, { solPrice = 0, rankings = {}, hasX = false } = {}) {
  const m = marketView(t, now, solPrice);
  const tx5 = m.buys5 + m.sells5;
  const tx1h = m.buys1h + m.sells1h;

  const momentum = 0.45 * logSat(tx5, 400) + 0.35 * logSat(tx1h, 4000) + 0.2 * logSat(m.traders1h, 1500);

  const turnover = t.mcap > 0 ? m.vol1h / t.mcap : 0;
  const volume = 0.6 * logSat(m.vol1h, 2_000_000) + 0.4 * (1 - Math.exp(-turnover / 0.5));

  const total5 = tx5 >= 6 ? tx5 : tx1h;
  const buys = tx5 >= 6 ? m.buys5 : m.buys1h;
  const pressure = total5 >= 6 ? clamp(0.5 + ((buys / total5) - 0.5) * 2.5) : 0.5;

  const c5 = t.change?.m5 || 0;
  const c1 = t.change?.h1 || 0;
  const price = 0.5 + 0.5 * Math.tanh((c5 * 1.5 + c1) / 80);

  let social = 0;
  const x = t.x;
  if (x && x.lastPoll) {
    const accel = x.prev != null && x.prev > 0 ? clamp((x.mentions1h - x.prev) / x.prev / 2 + 0.5) : 0.5;
    social =
      0.4 * logSat(x.mentions1h, 150) +
      0.25 * logSat(x.authors, 80) +
      0.2 * logSat(x.engagement, 5000) +
      0.15 * (x.mentions1h > 0 ? accel : 0);
  }
  // Proxies for social attention available without X: paid boosts, filled-in socials, DEX profile.
  const s = t.socials || {};
  const presence =
    0.5 * logSat(t.boosts || 0, 500) +
    0.2 * (s.twitter ? 1 : 0) +
    0.1 * (s.telegram ? 1 : 0) +
    0.1 * (s.website ? 1 : 0) +
    0.1 * (t.hasProfile ? 1 : 0);
  social = hasX ? 0.8 * social + 0.2 * presence : presence;

  let best = 0;
  let lists = 0;
  for (const map of Object.values(rankings)) {
    const r = map.get(t.mint);
    if (!r) continue;
    lists++;
    best = Math.max(best, 1 - (r - 1) / 100);
  }
  const discovery = clamp(best + 0.1 * Math.max(0, lists - 1));

  const growth = holderGrowth(t, now);
  const holders = 0.65 * logSat(growth, 1500) + 0.35 * logSat(t.holders || 0, 25_000);

  // Sudden volume: ratio above 1× counts, damped for tiny absolute volume.
  const surgeRatio = volumeSurge(t, m.vol5, now);
  const surge = logSat(Math.max(0, surgeRatio - 1), 15) * Math.min(1, m.vol5 / 3000);

  const parts = { momentum, volume, surge, pressure, price, social, discovery, holders };
  const weights = { ...BASE_WEIGHTS, social: hasX ? BASE_WEIGHTS.social : 0.08 };
  let wsum = 0;
  let base = 0;
  for (const k in parts) {
    base += parts[k] * weights[k];
    wsum += weights[k];
  }
  base /= wsum;

  // Dead tokens should not float up on neutral price/pressure alone.
  if (tx1h === 0 && m.vol1h < 100) base *= 0.25;

  const risk = assessRisk(t);
  const score = Math.round(1000 * base * (1 - risk.penalty)) / 10;

  return {
    score,
    parts,
    risk,
    market: { ...m, live: undefined, holderGrowth1h: Math.round(growth), surge: Math.round(surgeRatio * 10) / 10 },
  };
}
