// Trenches DEMO — swap math of memecoin launchpads and DEX pools as pure functions (tested).
//
// pump.fun bonding curve (constant product on virtual reserves): starts at 30 SOL × 1,073,000,000
// tokens; 793,100,000 tokens are sold on the curve, then it completes and the token migrates
// (~410 SOL market cap). Market cap is price × 1B supply, so the reserves follow from it:
// vSol = √(mcSol × k / 1e9), vTok = k / vSol — and the curve progress pump.fun shows is
// (tokens sold) / 793.1M. After migration (PumpSwap / Raydium / Meteora) the pool is a
// constant-product AMM whose two sides each hold half the liquidity.
//
// Fees (as on Axiom / Padre / Photon): 1% platform fee on every swap, the venue's fee
// (pump.fun curve 1.25%, PumpSwap / AMM ~0.25%), plus the network: priority fee + tip (Solana),
// gas (EVM).

export const PUMP = { vSol0: 30, vTok0: 1_073_000_000, realTok: 793_100_000, supply: 1_000_000_000 };
PUMP.k = PUMP.vSol0 * PUMP.vTok0;
PUMP.endVTok = PUMP.vTok0 - PUMP.realTok;
PUMP.endMcSol = ((PUMP.k / PUMP.endVTok) / PUMP.endVTok) * PUMP.supply; // ≈ 410.9 SOL

export const TFEES = { platform: 0.01, curve: 0.0125, amm: 0.0025, solBase: 0.000005 };

/** pump.fun curve state from the market cap in SOL. */
export function curveFromMc(mcSol) {
  if (!(mcSol > 0)) return null;
  const vSol = Math.sqrt((mcSol * PUMP.k) / PUMP.supply);
  const vTok = PUMP.k / vSol;
  const progress = Math.max(0, Math.min(100, ((PUMP.vTok0 - vTok) / PUMP.realTok) * 100));
  return { vSol, vTok, progress };
}

/** Constant-product swap: `inAmt` of reserve X into the pool, fee taken from the input. */
export function cpSwap(resIn, resOut, inAmt, fee) {
  if (!(resIn > 0) || !(resOut > 0) || !(inAmt > 0)) return 0;
  const net = inAmt * (1 - fee);
  return resOut - (resIn * resOut) / (resIn + net);
}

/**
 * Pool model of a token for a swap: reserves in native coin and tokens.
 * curve: { mcNative } for a pump.fun token on its curve; amm: { liqUsd, priceNative, nativeUsd }.
 */
export function poolOf(t) {
  if (t.curve && t.mcNative > 0) {
    const c = curveFromMc(t.mcNative);
    return c && { kind: 'curve', nat: c.vSol, tok: c.vTok, fee: TFEES.curve, progress: c.progress, maxTok: Math.max(0, c.vTok - PUMP.endVTok) };
  }
  if (t.liqUsd > 0 && t.priceNative > 0 && t.nativeUsd > 0) {
    const nat = t.liqUsd / 2 / t.nativeUsd;
    return { kind: 'amm', nat, tok: nat / t.priceNative, fee: TFEES.amm };
  }
  return null;
}

/** Spot price (native per token) of a pool. */
export const spot = (pool) => pool.nat / pool.tok;

/**
 * Buy with `amount` native: platform fee off the input, the venue's fee inside the swap.
 * Returns { tokens, avg, impact, platformFee, venueFee } (impact: avg price vs spot, %).
 */
export function quoteBuy(pool, amount) {
  if (!pool || !(amount > 0)) return null;
  const platformFee = amount * TFEES.platform;
  const toPool = amount - platformFee;
  let tokens = cpSwap(pool.nat, pool.tok, toPool, pool.fee);
  // The curve can't sell past its last token: the rest of the order would fail on chain.
  if (pool.kind === 'curve' && pool.maxTok != null && tokens > pool.maxTok) tokens = pool.maxTok;
  if (!(tokens > 0)) return null;
  const avg = amount / tokens;
  return { tokens, avg, impact: (avg / spot(pool) - 1) * 100, platformFee, venueFee: toPool * pool.fee };
}

/** Sell `tokens`: the venue's fee inside the swap, platform fee off the output. */
export function quoteSell(pool, tokens) {
  if (!pool || !(tokens > 0)) return null;
  const gross = cpSwap(pool.tok, pool.nat, tokens, pool.fee);
  if (!(gross > 0)) return null;
  const platformFee = gross * TFEES.platform;
  const out = gross - platformFee;
  const avg = out / tokens;
  return { out, avg, impact: (1 - avg / spot(pool)) * 100, platformFee, venueFee: (gross / (1 - pool.fee)) * pool.fee };
}

// ---------- positions ----------

export function newWallet() {
  return { cash: {}, deposits: {}, pos: {}, hist: [], tx: [], stats: { fees: 0 }, rev: 0 };
}
export const posKey = (chain, mint) => `${chain}:${mint}`;

/** Books a buy: `spent` native leaves the wallet (amount + network fee). */
export function bookBuy(w, { chain, mint, meta, amount, network, q, mcNow, t }) {
  const k = posKey(chain, mint);
  const p = (w.pos[k] ||= { chain, mint, ...meta, tokens: 0, spent: 0, got: 0, bought: 0, buys: 0, sells: 0, openedAt: t, entryMc: 0, fees: 0, tp: null, sl: null });
  Object.assign(p, meta);
  const fees = q.platformFee + q.venueFee + network;
  w.cash[chain] = (w.cash[chain] || 0) - amount - network;
  // Entry market cap: weighted by the tokens of each buy.
  if (mcNow > 0) p.entryMc = (p.entryMc * p.tokens + mcNow * (1 + q.impact / 100) * q.tokens) / (p.tokens + q.tokens);
  p.tokens += q.tokens;
  p.bought += q.tokens;
  p.spent += amount + network;
  p.fees += fees;
  p.buys++;
  w.stats.fees += fees;
  return p;
}

/** Books a sell of `tokens`; closes the position when nothing is left. Returns { pnl, closed }. */
export function bookSell(w, { chain, mint, tokens, network, q, t, reason = 'trade' }) {
  const k = posKey(chain, mint);
  const p = w.pos[k];
  if (!p) return null;
  const part = Math.min(1, tokens / p.tokens);
  const costPart = p.spent * (tokens / p.bought); // average cost of these tokens
  const net = q.out - network;
  w.cash[chain] = (w.cash[chain] || 0) + net;
  const fees = q.platformFee + q.venueFee + network;
  p.fees += fees;
  w.stats.fees += fees;
  p.got += net;
  p.tokens -= tokens;
  p.sells++;
  const pnl = net - costPart;
  if (part >= 0.9999 || p.tokens <= p.bought * 1e-9) {
    const total = p.got - p.spent;
    w.hist.unshift({ chain, mint, sym: p.sym, name: p.name, icon: p.icon, spent: p.spent, got: p.got, pnl: total, pct: p.spent > 0 ? (total / p.spent) * 100 : 0, entryMc: p.entryMc, exitMc: q.mcAt ?? null, openedAt: p.openedAt, t, reason, fees: p.fees });
    delete w.pos[k];
    return { pnl, closed: true, total };
  }
  return { pnl, closed: false };
}

/** Value and PnL of a position at a spot price (native per token). */
export function posValue(p, priceNative) {
  const value = priceNative > 0 ? p.tokens * priceNative : null;
  const pnl = value != null ? value + p.got - p.spent : null;
  return { value, pnl, pct: pnl != null && p.spent > 0 ? (pnl / p.spent) * 100 : null };
}

/**
 * Candles from individual prices (trades + live ticks): [{ t (ms), p, v? }] → [[ms, o, h, l, c, vol]]
 * per `ms` bucket. Each candle opens where the previous one closed, so the line stays continuous
 * (a second without trades simply has no candle).
 */
export function tickCandles(points, ms) {
  const pts = points.filter((x) => x.p > 0 && x.t > 0).sort((a, b) => a.t - b.t);
  const out = [];
  let cur = null;
  let prevClose = null;
  for (const x of pts) {
    const b = Math.floor(x.t / ms) * ms;
    if (!cur || cur[0] !== b) {
      if (cur) prevClose = cur[4];
      const o = prevClose ?? x.p;
      cur = [b, o, Math.max(o, x.p), Math.min(o, x.p), x.p, x.v || 0];
      out.push(cur);
    } else {
      cur[2] = Math.max(cur[2], x.p);
      cur[3] = Math.min(cur[3], x.p);
      cur[4] = x.p;
      cur[5] += x.v || 0;
    }
  }
  return out;
}
