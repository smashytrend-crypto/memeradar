// Hyperliquid perpetuals — the exchange's own rules as pure functions (no DOM, no network), so
// the DEMO account behaves like a real Hyperliquid account and the rules can be unit-tested.
//
// Sources (Hyperliquid docs: Trading → Margining, Liquidations, Funding, Fees, Tick and lot size):
// - initial margin = notional / leverage; maintenance margin = half the initial margin at the
//   asset's max leverage (tiered: maintenance_margin = notional × rate − deduction);
// - unrealized PnL, liquidations and TP/SL triggers use the MARK price;
// - liquidation when equity < maintenance margin: isolated = the position's own margin,
//   cross = cross account value vs. the sum of cross maintenance margins;
//   liq_price = price − side × margin_available / size / (1 − l × side), l = maintenance rate;
// - a liquidation first goes to the book (market orders, the trader keeps what is left); below
//   2/3 of the maintenance margin the backstop liquidator takes over and the collateral is lost;
//   positions over $100k notional are liquidated 20% at a time (30 s cooldown);
// - funding every hour: size × oracle price × funding rate (longs pay when positive), cap 4%/h;
// - fees on notional, base tier: taker 0.045%, maker 0.015%;
// - prices: at most 5 significant figures and (6 − szDecimals) decimals; sizes: szDecimals.

export const PERP_FEES = { taker: 0.00045, maker: 0.00015 };
export const FUNDING_CAP = 0.04;
export const BACKSTOP_RATIO = 2 / 3;
export const PARTIAL_LIQ_NTL = 100_000;
export const PARTIAL_LIQ_FRAC = 0.2;
export const PARTIAL_LIQ_COOLDOWN = 30_000;
export const MARKET_SLIPPAGE = 0.08; // the Hyperliquid app's default limit for market orders
export const HOUR = 3_600_000;

const EPS = 1e-12;

/**
 * Margin tiers of an asset: [{ lb, lev, mmr, ded }] from the API's margin table
 * ([{ lowerBound, maxLeverage }]) or a single tier at the asset's max leverage.
 */
export function marginTiers(maxLev, table) {
  const raw = Array.isArray(table) && table.length ? table : [{ lowerBound: 0, maxLeverage: maxLev }];
  const sorted = raw
    .map((t) => ({ lb: Number(t.lowerBound) || 0, lev: Number(t.maxLeverage) || maxLev || 1 }))
    .sort((a, b) => a.lb - b.lb);
  sorted[0].lb = 0;
  const tiers = [];
  for (const t of sorted) {
    const mmr = 1 / (2 * t.lev);
    const prev = tiers[tiers.length - 1];
    // The deduction keeps the maintenance margin continuous where the tiers meet.
    const ded = prev ? prev.ded + t.lb * (mmr - prev.mmr) : 0;
    tiers.push({ lb: t.lb, lev: t.lev, mmr, ded });
  }
  return tiers;
}

export function tierAt(tiers, ntl) {
  let t = tiers[0];
  for (const x of tiers) if (ntl >= x.lb) t = x;
  return t;
}

export const maintMargin = (tiers, ntl) => {
  const t = tierAt(tiers, Math.abs(ntl));
  return Math.max(0, Math.abs(ntl) * t.mmr - t.ded);
};

/** Highest leverage allowed for a position of this notional. */
export const maxLevAt = (tiers, ntl) => tierAt(tiers, Math.abs(ntl)).lev;

export const upnl = (p, mark) => p.side * p.sz * (mark - p.entry);
/** Return on equity as Hyperliquid shows it: PnL over the position's initial margin. */
export const roe = (p, mark) => {
  const im = (p.sz * p.entry) / p.lev;
  return im > 0 ? (upnl(p, mark) / im) * 100 : 0;
};

/**
 * Price at which equity meets maintenance margin, when only this position's price moves.
 * equity0: equity at `mark` (isolated: margin + uPnL; cross: cross account value);
 * otherMM: maintenance margin of the other cross positions (0 for isolated).
 * Solves equity0 + side·sz·(P − mark) = otherMM + sz·P·mmr − ded for each tier.
 */
export function liqPrice({ side, sz, mark, equity0, otherMM = 0, tiers }) {
  if (!(sz > 0) || !(mark > 0)) return null;
  let t = tierAt(tiers, sz * mark);
  for (let i = 0; i < 4; i++) {
    const denom = sz * (side - t.mmr);
    if (Math.abs(denom) < EPS) return null;
    const p = (otherMM - t.ded - equity0 + side * sz * mark) / denom;
    if (!(p > 0)) return null;
    const t2 = tierAt(tiers, sz * p);
    if (t2 === t) return p;
    t = t2;
  }
  return null;
}

/** Walks the order book: levels best first [{ px, sz }]; stops past `limitPx` when given. */
export function walkBook(levels, sz, limitPx, side) {
  let left = sz;
  let cost = 0;
  let worst = null;
  for (const l of levels || []) {
    if (left <= EPS) break;
    if (limitPx != null && (side > 0 ? l.px > limitPx : l.px < limitPx)) break;
    const take = Math.min(left, l.sz);
    cost += take * l.px;
    left -= take;
    worst = l.px;
  }
  const filled = sz - Math.max(0, left);
  return { filled, avg: filled > EPS ? cost / filled : null, worst };
}

/** Size rounded down to the asset's lot (szDecimals). */
export function roundSz(sz, dec) {
  const f = 10 ** dec;
  return Math.floor(sz * f + 1e-9) / f;
}

/** Valid Hyperliquid perp price: 5 significant figures, at most 6 − szDecimals decimals. */
export function roundPx(px, szDec) {
  if (!(px > 0)) return px;
  if (Number.isInteger(px)) return px;
  const sig = Number(px.toPrecision(5));
  const maxDec = Math.max(0, 6 - szDec);
  return Number(sig.toFixed(maxDec));
}

// ---------- account ----------

export function newAccount() {
  return { cash: 0, deposits: 0, pos: {}, orders: [], hist: [], tx: [], lev: {}, cross: {}, fundAt: 0, seq: 1 };
}

const posList = (a) => Object.values(a.pos || {});

/** Cross account value: free collateral + uPnL of the cross positions. */
export function crossValue(a, marks) {
  return a.cash + posList(a).reduce((s, p) => s + (p.cross ? upnl(p, marks[p.coin] ?? p.entry) : 0), 0);
}
export function crossMM(a, marks, tiersOf, skip) {
  return posList(a).reduce((s, p) => (p.cross && p.coin !== skip ? s + maintMargin(tiersOf(p.coin), p.sz * (marks[p.coin] ?? p.entry)) : s), 0);
}
export const isoEquity = (p, mark) => p.margin + upnl(p, mark);

/** Everything: cross value + isolated margins with their PnL. */
export function totalValue(a, marks) {
  return crossValue(a, marks) + posList(a).reduce((s, p) => (p.cross ? s : s + isoEquity(p, marks[p.coin] ?? p.entry)), 0);
}

/** Margin of resting orders that would open or add to a position (reducing parts are free). */
export function orderMargin(a) {
  return (a.orders || []).reduce((s, o) => {
    const p = a.pos?.[o.coin];
    const open = o.reduceOnly ? 0 : p && p.side !== o.side ? Math.max(0, o.sz - p.sz) : o.sz;
    return s + (open * o.px) / o.lev + open * o.px * PERP_FEES.maker;
  }, 0);
}

/** Free to open new positions: cross value − cross initial margin − resting orders. */
export function available(a, marks) {
  const im = posList(a).reduce((s, p) => (p.cross ? s + (p.sz * (marks[p.coin] ?? p.entry)) / p.lev : s), 0);
  return Math.max(0, crossValue(a, marks) - im - orderMargin(a));
}

/** Liquidation price of an open position (null: cannot be liquidated by this price). */
export function positionLiq(a, p, marks, tiersOf) {
  const mark = marks[p.coin] ?? p.entry;
  const tiers = tiersOf(p.coin);
  if (!p.cross) return liqPrice({ side: p.side, sz: p.sz, mark, equity0: isoEquity(p, mark), tiers });
  return liqPrice({ side: p.side, sz: p.sz, mark, equity0: crossValue(a, marks), otherMM: crossMM(a, marks, tiersOf, p.coin), tiers });
}

/** Liquidation price a new order would get (preview, before sending). */
export function previewLiq(a, { coin, side, sz, px, lev, cross }, marks, tiersOf) {
  const sim = { ...a, pos: structuredClone(a.pos), hist: [], tx: [] };
  const fee = sz * px * PERP_FEES.taker;
  applyFill(sim, { coin, side, sz, px, fee, lev, cross, t: 0 });
  const p = sim.pos[coin];
  if (!p) return null;
  return positionLiq(sim, p, { ...marks, [coin]: px }, tiersOf);
}

/**
 * Margin a fill needs from free collateral: 0 when it only reduces a position (Hyperliquid always
 * lets a position be reduced; the fee comes out of its PnL / margin). Opening or adding:
 * notional / leverage + fee; flipping: for the part beyond the close.
 */
export function fillNeeds(a, { coin, side, sz, px, lev }, fee = PERP_FEES.taker) {
  const p = a.pos[coin];
  const open = p && p.side !== side ? Math.max(0, sz - p.sz) : sz;
  const useLev = p && p.side === side ? p.lev : lev;
  return (open * px) / useLev + open * px * fee;
}

/** Largest size (coins) the free collateral can open at this price and leverage. */
export const maxOpenSz = (avail, px, lev, fee = PERP_FEES.taker) => (px > 0 ? Math.max(0, avail) / (px / lev + px * fee) : 0);

/**
 * Books a fill into the account (one net position per coin, as on Hyperliquid).
 * Returns { realized, fee, closed: [history rows] }.
 */
export function applyFill(a, { coin, side, sz, px, fee, lev, cross, t, reason = 'trade' }) {
  const out = { realized: 0, fee, closed: [] };
  a.cash -= fee;
  let p = a.pos[coin];
  let left = sz;
  if (p && p.side !== side) {
    const closeSz = Math.min(left, p.sz);
    const realized = p.side * closeSz * (px - p.entry);
    const part = closeSz / p.sz;
    const feePart = fee * (closeSz / sz);
    out.realized += realized;
    if (p.cross) a.cash += realized;
    else {
      const release = p.margin * part;
      p.margin -= release;
      // An isolated position never loses more than its margin (the rest would be bad debt).
      a.cash += Math.max(0, release + realized);
    }
    p.fees += feePart;
    p.realized = (p.realized || 0) + realized;
    const row = {
      coin, side: p.side, sz: closeSz, entry: p.entry, exit: px, lev: p.lev, cross: p.cross, pnl: realized,
      fees: (p.fees * closeSz) / p.sz, funding: (p.funding * closeSz) / p.sz, openedAt: p.openedAt, t, reason,
      full: closeSz >= p.sz - EPS,
    };
    out.closed.push(row);
    p.fees -= row.fees;
    p.funding -= row.funding;
    p.sz -= closeSz;
    left -= closeSz;
    if (p.sz <= EPS) {
      delete a.pos[coin];
      p = null;
    }
  }
  if (left > EPS) {
    const ntl = left * px;
    const feeOpen = fee * (left / sz);
    if (p) {
      p.entry = (p.sz * p.entry + left * px) / (p.sz + left);
      p.sz += left;
      p.fees += feeOpen;
      if (!p.cross) {
        const m = ntl / p.lev;
        p.margin += m;
        a.cash -= m;
      }
    } else {
      p = a.pos[coin] = { coin, side, sz: left, entry: px, lev, cross: !!cross, margin: 0, openedAt: t, fees: feeOpen, funding: 0, realized: 0, sl: null, tp: null };
      if (!cross) {
        p.margin = ntl / lev;
        a.cash -= p.margin;
      }
    }
  }
  return out;
}

/** Funding payment on the hour; positive = paid by the account. */
export function applyFunding(a, coin, rate, oraclePx) {
  const p = a.pos[coin];
  if (!p || !Number.isFinite(rate) || !(oraclePx > 0)) return 0;
  const r = Math.max(-FUNDING_CAP, Math.min(FUNDING_CAP, rate));
  const pay = p.side * p.sz * oraclePx * r;
  if (p.cross) a.cash -= pay;
  else p.margin -= pay;
  p.funding += pay;
  return pay;
}

/** 'sl' / 'tp' when the mark crossed a trigger of the position. */
export function triggerHit(p, mark) {
  if (p.sl != null && (p.side > 0 ? mark <= p.sl : mark >= p.sl)) return 'sl';
  if (p.tp != null && (p.side > 0 ? mark >= p.tp : mark <= p.tp)) return 'tp';
  return null;
}

/**
 * Liquidation pass at the given marks. Returns events [{ coin, kind: 'book' | 'backstop',
 * partial, pnl, returned }]; mutates the account.
 */
export function liquidate(a, marks, tiersOf, t, { replay = false } = {}) {
  const events = [];
  // Replaying candles jumps between prices that were passed continuously: the exchange would have
  // liquidated through the book where equity crossed maintenance, never skipping to the backstop.
  const pxOf = (p) => (replay && !p.cross ? positionLiq(a, p, marks, tiersOf) || marks[p.coin] : marks[p.coin]) ?? p.entry;
  const close = (p, frac, kind) => {
    if (replay && kind === 'backstop') kind = 'book';
    const mark = pxOf(p);
    const sz = frac >= 1 ? p.sz : p.sz * frac;
    const before = a.cash;
    if (kind === 'backstop') {
      // The liquidator vault takes the position and the collateral behind it.
      const realized = p.side * p.sz * (mark - p.entry);
      events.push({ coin: p.coin, kind, partial: false, pnl: realized, lost: p.cross ? null : p.margin });
      a.hist.unshift({ coin: p.coin, side: p.side, sz: p.sz, entry: p.entry, exit: mark, lev: p.lev, cross: p.cross, pnl: p.cross ? realized : -p.margin, fees: p.fees, funding: p.funding, openedAt: p.openedAt, t, reason: 'liq', full: true });
      delete a.pos[p.coin];
      return;
    }
    const fee = sz * mark * PERP_FEES.taker;
    const r = applyFill(a, { coin: p.coin, side: -p.side, sz, px: mark, fee, lev: p.lev, cross: p.cross, t, reason: 'liq' });
    for (const row of r.closed) a.hist.unshift(row);
    events.push({ coin: p.coin, kind, partial: frac < 1, pnl: r.realized, returned: a.cash - before });
    if (frac < 1 && a.pos[p.coin]) a.pos[p.coin].liqCooldown = t + PARTIAL_LIQ_COOLDOWN;
  };
  // Isolated positions, each on its own margin.
  for (const p of posList(a)) {
    if (p.cross) continue;
    const mark = marks[p.coin];
    if (!(mark > 0)) continue;
    const eq = isoEquity(p, mark);
    const mm = maintMargin(tiersOf(p.coin), p.sz * mark);
    if (eq >= mm) continue;
    if (eq < BACKSTOP_RATIO * mm) close(p, 1, 'backstop');
    else if (p.sz * mark > PARTIAL_LIQ_NTL && !(p.liqCooldown > t)) close(p, PARTIAL_LIQ_FRAC, 'book');
    else if (!(p.liqCooldown > t)) close(p, 1, 'book');
  }
  // Cross: the whole cross account against the sum of its maintenance margins.
  const crossPos = posList(a).filter((p) => p.cross && marks[p.coin] > 0);
  if (crossPos.length) {
    const cv = crossValue(a, marks);
    const mm = crossMM(a, marks, tiersOf);
    if (cv < mm) {
      if (cv < BACKSTOP_RATIO * mm && !replay) {
        for (const p of crossPos) close(p, 1, 'backstop');
        a.cash = 0;
      } else {
        for (const p of crossPos) {
          const big = p.sz * marks[p.coin] > PARTIAL_LIQ_NTL;
          if (!(p.liqCooldown > t)) close(p, big ? PARTIAL_LIQ_FRAC : 1, 'book');
        }
      }
    }
  }
  // With no cross position left, a negative balance would be bad debt: the exchange absorbs it.
  if (a.cash < 0 && !posList(a).some((p) => p.cross)) a.cash = 0;
  return events;
}
