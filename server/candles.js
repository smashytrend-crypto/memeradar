// Price candles (OHLC from GeckoTerminal, stored as [startMs, open, close, high, low], oldest
// first) → the price at a past moment, the 4 h change, and a compact point list for mini charts.
// The candle length adapts to the pool's age (see candleSpec): 1-minute detail for young tokens,
// 5-minute for older ones; mini charts show the last 6 hours.

const MIN = 60_000;
const HOUR = 3_600_000;
export const CANDLE_MS = 15 * MIN; // default when a token carries no candle length
const STALE_MS = 30 * MIN;
const SPARK_MAX = 160; // points per mini chart after decimation
export const SPARK_WINDOW = 6 * HOUR;

const sig = (v) => Number(v.toPrecision(4));

/**
 * Candle length and count to request for a pool of this age: 1-minute candles while it is
 * younger than 5 h (its whole life), 5-minute after that (~8 h: the 6 h chart window plus the
 * 4 h-ago reference, with room for intervals without trades).
 */
export function candleSpec(ageMs) {
  if (ageMs > 0 && ageMs < 5 * HOUR) return { minutes: 1, limit: 300 };
  return { minutes: 5, limit: 100 };
}

/**
 * Price at time `ts`, or null without candles. Inside a candle the price is interpolated from open
 * to close; in a gap after a candle (no trades) it is that candle's close; before the first candle
 * (pool younger than the window, or no trades before it) it is the first candle's open.
 */
export function priceAt(candles, ts, ms = CANDLE_MS) {
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
  const frac = (ts - start) / ms;
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
  const ref = priceAt(c, now - 4 * HOUR, t.candleMs || CANDLE_MS);
  return ref > 0 ? (t.priceUsd / ref - 1) * 100 : null;
}

/**
 * Keep at most `max` points while preserving spikes: the series is cut into equal time buckets
 * and each bucket keeps its lowest and highest point, in time order (first and last always kept).
 */
export function decimate(pts, max = SPARK_MAX) {
  if (pts.length <= max) return pts;
  const buckets = Math.floor((max - 2) / 2);
  const t0 = pts[0][0];
  const span = pts[pts.length - 1][0] - t0 || 1;
  const out = [pts[0]];
  let b = -1;
  let lo = null;
  let hi = null;
  const flush = () => {
    if (!lo) return;
    if (lo === hi) out.push(lo);
    else out.push(...(lo[0] <= hi[0] ? [lo, hi] : [hi, lo]));
  };
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const k = Math.max(0, Math.min(buckets - 1, Math.floor(((p[0] - t0) / span) * buckets)));
    if (k !== b) {
      flush();
      b = k;
      lo = hi = p;
    } else {
      if (p[1] < lo[1]) lo = p;
      if (p[1] > hi[1]) hi = p;
    }
  }
  flush();
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Candles → [tsSec, price] points for a mini chart over the last 6 h (or the pool's life),
 * oldest first. Each candle adds its high and low (in the order the move suggests) and its close,
 * so wicks — pumps and dumps inside a candle — stay visible; then the series is decimated to
 * ~160 points. The in-progress candle's close is stamped at `observedAt` (when the candles were
 * fetched), so live price samples taken after it can extend the line.
 */
export function sparkPoints(candles, now = Date.now(), observedAt = now, ms = CANDLE_MS) {
  if (!candles?.length) return null;
  const from = now - SPARK_WINDOW;
  // Non-empty candles can reach back further (and days for thin pools) — keep only the window.
  let i = 0;
  while (i < candles.length && candles[i][0] + ms <= from) i++;
  if (i === candles.length) return null;
  const pts = candles[i][0] < from || i > 0 ? [[from, priceAt(candles, from, ms)]] : [[candles[0][0], candles[0][1]]];
  const cap = Math.min(observedAt || now, now);
  for (const [start, open, close, high, low] of candles.slice(i)) {
    const end = Math.min(start + ms, cap);
    if (end <= start) continue;
    const span = end - start;
    if (high > 0 && low > 0 && (high > Math.max(open, close) || low < Math.min(open, close))) {
      const wicks = close >= open ? [low, high] : [high, low];
      pts.push([start + span / 3, wicks[0]], [start + (2 * span) / 3, wicks[1]]);
    }
    pts.push([end, close]);
  }
  // A candle straddling the window edge can add points before it: keep the series in order.
  const t0 = pts[0][0];
  for (let k = pts.length - 1; k > 0; k--) if (pts[k][0] <= t0) pts.splice(k, 1);
  return decimate(pts).map(([ts, p]) => [Math.round(ts / 1000), sig(p)]);
}
