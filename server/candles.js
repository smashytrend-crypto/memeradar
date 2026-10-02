// Price candles (15-minute OHLC from GeckoTerminal, stored as [startMs, open, close], oldest
// first) → the price at a past moment, the 4 h change, and a compact point list for mini charts.

export const CANDLE_MS = 15 * 60_000;
const HOUR = 3_600_000;
const STALE_MS = 30 * 60_000;

const sig = (v) => Number(v.toPrecision(4));

/**
 * Price at time `ts`, or null without candles. Inside a candle the price is interpolated from open
 * to close; in a gap after a candle (no trades) it is that candle's close; before the first candle
 * (pool younger than the window, or no trades before it) it is the first candle's open.
 */
export function priceAt(candles, ts) {
  if (!candles?.length) return null;
  if (ts <= candles[0][0]) return candles[0][1];
  let lo = 0;
  let hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candles[mid][0] <= ts) lo = mid;
    else hi = mid - 1;
  }
  const [start, open, close] = candles[lo];
  const frac = (ts - start) / CANDLE_MS;
  return frac >= 1 ? close : open + (close - open) * frac;
}

/** Candles usable for this token right now: same pool as its live price, fetched recently. */
export function freshCandles(t, now = Date.now()) {
  if (!t.candles?.length || !t.pairAddress || t.candlesPool !== t.pairAddress) return null;
  if (now - (t.candlesAt || 0) > STALE_MS) return null;
  return t.candles;
}

/**
 * % change over the last 4 hours: the live (DexScreener) price against the candle price 4 h ago.
 * For a pool younger than 4 h this is the change since the pool opened. Null when candles are
 * missing, stale, or disagree with the live price (a different market).
 */
export function change4h(t, now = Date.now()) {
  const c = freshCandles(t, now);
  if (!c || !(t.priceUsd > 0)) return null;
  const last = c[c.length - 1];
  if (now - last[0] < 2 * HOUR) {
    const r = t.priceUsd / last[2];
    if (r > 5 || r < 0.2) return null;
  }
  const ref = priceAt(c, now - 4 * HOUR);
  return ref > 0 ? (t.priceUsd / ref - 1) * 100 : null;
}

/**
 * Candles → [tsSec, price] points for a mini chart over the last 24 h, oldest first: the first
 * open, then each close at its candle's end — 15-minute resolution for the last 4 h, one point
 * per hour before that. The in-progress candle's close is stamped at `observedAt` (when the
 * candles were fetched), so live price samples taken after it can extend the line.
 */
export function sparkPoints(candles, now = Date.now(), observedAt = now) {
  if (!candles?.length) return null;
  const from = now - 24 * HOUR;
  // Thinly traded pools: 97 non-empty candles can reach back days — keep only the last 24 h.
  let i = 0;
  while (i < candles.length && candles[i][0] + CANDLE_MS <= from) i++;
  if (i === candles.length) return null;
  const out =
    i > 0
      ? [[Math.round(from / 1000), sig(priceAt(candles, from))]]
      : [[Math.round(candles[0][0] / 1000), sig(candles[0][1])]];
  let lastHour = -1;
  for (const [start, , close] of candles.slice(i)) {
    const end = Math.min(start + CANDLE_MS, observedAt || now, now);
    const point = [Math.round(end / 1000), sig(close)];
    if (now - end > 4 * HOUR) {
      const hour = Math.floor(end / HOUR);
      if (hour === lastHour) {
        out[out.length - 1] = point;
        continue;
      }
      lastHour = hour;
    }
    out.push(point);
  }
  return out;
}
