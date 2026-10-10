// Perpetuals DEMO on live Hyperliquid data: markets, mark / oracle prices, funding, order book and
// candles straight from Hyperliquid's public API (free, no key), trading rules from perps-math.js.
// The account lives in this browser only (localStorage 'mr:perps') — virtual dollars.

import * as M from './perps-math.js?v=mv2uwc6i';

const API = 'https://api.hyperliquid.xyz/info';
const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const KEY = 'mr:perps';
const TF_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
const MIN_ORDER = 10; // Hyperliquid's minimum order value ($)
const FAV = ['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE', 'XRP', 'kPEPE', 'WIF', 'FARTCOIN', 'SUI'];

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ls = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};

// ---------- formatting ----------
export function fmtPx(p) {
  if (!(p > 0) || !Number.isFinite(p)) return '—';
  if (p >= 100_000) return `$${p.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return `$${Number(p.toPrecision(5)).toLocaleString('en-US', { maximumFractionDigits: 10 })}`;
}
const money = (v, signed = false) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${signed ? (v > 0.004 ? '+' : v < -0.004 ? '−' : '') : v < 0 ? '−' : ''}$${s}`;
};
const pct = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`);
const cls = (v) => (!Number.isFinite(v) || Math.abs(v) < 1e-9 ? '' : v > 0 ? 'up' : 'down');
const big = (v) => (!Number.isFinite(v) ? '—' : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`);
const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
const sideTxt = (s) => (s > 0 ? 'Long' : 'Short');

export function createPerps({ toast, loadLW, onChange, nav }) {
  // ---------- account ----------
  const loadAcct = () => loadAcctFrom(ls.get(KEY, {}));
  function loadAcctFrom(raw) {
    const a = Object.assign(M.newAccount(), raw || {});
    for (const k of ['pos', 'lev', 'cross']) if (!a[k] || typeof a[k] !== 'object') a[k] = {};
    for (const k of ['orders', 'hist', 'tx']) if (!Array.isArray(a[k])) a[k] = [];
    if (!Number.isFinite(a.cash)) a.cash = 0;
    if (!Number.isFinite(a.deposits)) a.deposits = 0;
    a.stats = Object.assign({ fees: 0, funding: 0, liqs: 0 }, a.stats || {});
    if (!Number.isFinite(a.rev)) a.rev = 0;
    return a;
  }
  let A = loadAcct();
  let savedAt = 0;
  // Another tab (or this one, frozen in the background) may hold an older copy: every write bumps
  // a revision and a newer stored revision always wins before this tab touches the account.
  const storedRev = () => {
    try {
      return Number(localStorage.getItem(`${KEY}:rev`)) || 0;
    } catch {
      return 0;
    }
  };
  function syncFromStorage() {
    if (storedRev() > A.rev) {
      A = loadAcct();
      S.dirty = true;
    }
  }
  const save = () => {
    A.hist = A.hist.slice(0, 300);
    A.tx = A.tx.slice(0, 300);
    A.rev = Math.max(A.rev, storedRev()) + 1;
    ls.set(KEY, A);
    try {
      localStorage.setItem(`${KEY}:rev`, String(A.rev));
    } catch {
      /* private mode */
    }
    savedAt = Date.now();
    onChange?.();
  };
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    A = loadAcct();
    S.dirty = true;
  });

  // ---------- runtime state ----------
  const S = {
    markets: new Map(),
    list: [],
    metaAt: 0,
    metaBusy: false,
    metaErr: '',
    book: {},
    coin: ls.get('mr:perpCoin', 'BTC'),
    tf: ls.get('mr:perpTf', '15m'),
    side: 1,
    type: 'market',
    picker: false,
    q: '',
    candles: null,
    candlesBusy: '',
    chart: null,
    ws: null,
    wsOk: false,
    subs: new Map(), // key → subscription object (sent)
    catching: false,
    editing: null,
    fundPending: 0,
    dirty: true,
  };
  const mkt = (c) => S.markets.get(c);
  const tiersOf = (c) => mkt(c)?.tiers || M.marginTiers(mkt(c)?.maxLev || 20);
  const markOf = (c) => mkt(c)?.mark;
  const coinsInUse = () => [...new Set([...Object.keys(A.pos), ...A.orders.map((o) => o.coin)])];
  const marks = () => {
    const m = {};
    for (const c of coinsInUse()) if (markOf(c) > 0) m[c] = markOf(c);
    return m;
  };
  const busy = () => Object.keys(A.pos).length > 0 || A.orders.length > 0;
  const sheetVisible = () => !$('#perpSheet')?.hidden;
  const walletVisible = () => !$('#walletSheet')?.hidden && !$('#walletPerpBody')?.hidden;
  const levOf = (c) => {
    const p = A.pos[c];
    if (p) return p.lev;
    const max = mkt(c)?.maxLev || 20;
    return Math.max(1, Math.min(max, A.lev[c] || Math.min(10, max)));
  };
  const crossOf = (c) => {
    const p = A.pos[c];
    if (p) return p.cross;
    if (mkt(c)?.onlyIso) return false;
    return A.cross[c] ?? true;
  };

  // ---------- Hyperliquid API ----------
  async function post(body) {
    const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
    if (!r.ok) throw new Error(`Hyperliquid HTTP ${r.status}`);
    return r.json();
  }
  function applyCtx(coin, c) {
    const m = mkt(coin);
    if (!m || !c) return;
    const n = (v) => (v == null || v === '' ? undefined : Number(v));
    if (n(c.markPx) > 0) m.mark = n(c.markPx);
    if (n(c.midPx) > 0) m.mid = n(c.midPx);
    if (n(c.oraclePx) > 0) m.oracle = n(c.oraclePx);
    if (Number.isFinite(n(c.funding))) m.funding = n(c.funding);
    if (Number.isFinite(n(c.openInterest))) m.oi = n(c.openInterest);
    if (Number.isFinite(n(c.dayNtlVlm))) m.vol = n(c.dayNtlVlm);
    if (n(c.prevDayPx) > 0) m.prev = n(c.prevDayPx);
    m.at = Date.now();
  }
  async function refreshMeta() {
    if (S.metaBusy) return;
    S.metaBusy = true;
    try {
      const [meta, ctxs] = await post({ type: 'metaAndAssetCtxs' });
      const tables = new Map((meta?.marginTables || []).map((x) => [x?.[0], x?.[1]?.marginTiers]));
      (meta?.universe || []).forEach((u, i) => {
        if (!u?.name) return;
        const m = mkt(u.name) || { coin: u.name };
        Object.assign(m, {
          maxLev: Number(u.maxLeverage) || 20,
          szDec: Number(u.szDecimals) || 0,
          onlyIso: !!u.onlyIsolated,
          delisted: !!u.isDelisted,
        });
        m.tiers = M.marginTiers(m.maxLev, tables.get(u.marginTableId));
        S.markets.set(u.name, m);
        applyCtx(u.name, ctxs?.[i]);
      });
      S.list = [...S.markets.values()].filter((m) => !m.delisted && m.mark > 0).sort((a, b) => (b.vol || 0) - (a.vol || 0)).map((m) => m.coin);
      if (!mkt(S.coin)) S.coin = S.list[0] || 'BTC';
      S.metaAt = Date.now();
      S.metaErr = '';
    } catch (e) {
      S.metaErr = e?.message || 'brak połączenia';
      S.metaAt = Date.now() - 1_000; // retry in a couple of seconds
    } finally {
      S.metaBusy = false;
      S.dirty = true;
    }
  }

  // ---------- WebSocket (live mark price, candles, order book) ----------
  function wantedSubs() {
    const w = new Map();
    const add = (s) => w.set(JSON.stringify(s), s);
    for (const c of coinsInUse()) add({ type: 'activeAssetCtx', coin: c });
    if (sheetVisible()) {
      add({ type: 'activeAssetCtx', coin: S.coin });
      add({ type: 'candle', coin: S.coin, interval: S.tf });
      add({ type: 'l2Book', coin: S.coin });
    }
    return w;
  }
  let wsRetry = 0;
  let pingT = null;
  function ensureWs() {
    const want = wantedSubs();
    if (!want.size) {
      if (S.ws) {
        S.ws.onclose = null;
        S.ws.close();
        S.ws = null;
        S.wsOk = false;
        S.subs.clear();
      }
      return;
    }
    if (typeof WebSocket === 'undefined') return;
    if (!S.ws) {
      if (Date.now() < wsRetry) return;
      const ws = (S.ws = new WebSocket(WS_URL));
      S.subs.clear();
      ws.onopen = () => {
        S.wsOk = true;
        clearInterval(pingT);
        pingT = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ method: 'ping' })), 30_000);
        ensureWs();
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        onWs(msg);
      };
      ws.onclose = ws.onerror = () => {
        if (S.ws !== ws) return;
        clearInterval(pingT);
        S.ws = null;
        S.wsOk = false;
        S.subs.clear();
        wsRetry = Date.now() + 3_000;
      };
      return;
    }
    if (S.ws.readyState !== 1) return;
    for (const [k, s] of want) {
      if (S.subs.has(k)) continue;
      S.ws.send(JSON.stringify({ method: 'subscribe', subscription: s }));
      S.subs.set(k, s);
    }
    for (const [k, s] of S.subs) {
      if (want.has(k)) continue;
      S.ws.send(JSON.stringify({ method: 'unsubscribe', subscription: s }));
      S.subs.delete(k);
    }
  }
  function onWs(msg) {
    const d = msg?.data;
    if (msg?.channel === 'activeAssetCtx' && d?.coin) {
      applyCtx(d.coin, d.ctx);
      S.dirty = true;
    } else if (msg?.channel === 'candle' && d?.s === S.coin && d?.i === S.tf) {
      const bar = { time: Math.floor(d.t / 1000), open: +d.o, high: +d.h, low: +d.l, close: +d.c, v: +d.v };
      const c = S.candles;
      if (c?.key === `${S.coin}|${S.tf}`) {
        const last = c.list[c.list.length - 1];
        if (last && last.time === bar.time) c.list[c.list.length - 1] = bar;
        else if (!last || bar.time > last.time) c.list.push(bar);
        try {
          if (S.chart?.key === c.key) {
            S.chart.candle.update(bar);
            S.chart.vol.update({ time: bar.time, value: bar.v, color: bar.close >= bar.open ? 'rgba(31,214,143,0.35)' : 'rgba(255,77,106,0.35)' });
          }
        } catch {
          /* out-of-order bar */
        }
      }
    } else if (msg?.channel === 'l2Book' && d?.coin && Array.isArray(d.levels)) {
      const lv = (arr) => (arr || []).map((l) => ({ px: +l.px, sz: +l.sz })).filter((l) => l.px > 0 && l.sz > 0);
      S.book[d.coin] = { bids: lv(d.levels[0]), asks: lv(d.levels[1]), at: Date.now() };
    }
  }
  async function bookFor(coin) {
    const b = S.book[coin];
    if (b && Date.now() - b.at < 5_000) return b;
    try {
      const j = await post({ type: 'l2Book', coin });
      const lv = (arr) => (arr || []).map((l) => ({ px: +l.px, sz: +l.sz })).filter((l) => l.px > 0 && l.sz > 0);
      return (S.book[coin] = { bids: lv(j?.levels?.[0]), asks: lv(j?.levels?.[1]), at: Date.now() });
    } catch {
      return null;
    }
  }

  // ---------- execution ----------
  /** Market fill against the book (taker): { sz, px } or null; capped at 8% slippage like the app. */
  function marketFill(coin, side, sz, book, limitPx) {
    const m = mkt(coin);
    const ref = m?.mid || m?.mark;
    if (!(ref > 0)) return null;
    const levels = book ? (side > 0 ? book.asks : book.bids) : null;
    if (!levels?.length) return { sz, px: ref };
    const cap = limitPx ?? ref * (1 + side * M.MARKET_SLIPPAGE);
    const r = M.walkBook(levels, sz, cap, side);
    // The 20 levels the API returns can be thinner than the real book: the rest at the worst level.
    if (r.filled < sz - 1e-12 && levels.length >= 20 && r.worst != null && (side > 0 ? r.worst < cap : r.worst > cap)) {
      const rest = sz - r.filled;
      return { sz, px: ((r.avg || 0) * r.filled + r.worst * rest) / sz };
    }
    if (!(r.filled > 0)) return null;
    return { sz: r.filled, px: r.avg };
  }
  function record(type, o) {
    A.tx.unshift({ type, t: Date.now(), ...o });
  }
  function bookFill(f, reason) {
    const r = M.applyFill(A, f);
    A.stats.fees += f.fee;
    for (const row of r.closed) A.hist.unshift({ ...row, reason });
    return r;
  }
  const fresh = (c) => mkt(c)?.mark > 0 && Date.now() - (mkt(c).at || 0) < 30_000;
  /** Why trading is paused right now (null: go). */
  const blocked = (coin) =>
    S.catching ? 'Synchronizuję konto z rynkiem — chwila…' : !fresh(coin) ? 'Brak aktualnej ceny z Hyperliquid — spróbuj za chwilę' : null;
  async function placeOrder(form) {
    if (S.placing) return;
    S.placing = true;
    try {
      await placeOrderNow(form);
    } finally {
      S.placing = false;
    }
  }
  async function placeOrderNow(form) {
    syncFromStorage();
    const coin = S.coin;
    const m = mkt(coin);
    const why = blocked(coin);
    if (why) return toast(why);
    const side = S.side;
    const p = A.pos[coin];
    const cross = crossOf(coin);
    let lev = levOf(coin);
    const ntl = Number(form.sz);
    if (!(ntl > 0)) return toast('Wpisz wielkość pozycji w $');
    const adds = !p || p.side === side || ntl > p.sz * m.mark; // opens or adds (not only a reduction)
    const maxL = M.maxLevAt(m.tiers, ntl + (p && p.side === side ? p.sz * m.mark : 0));
    if (lev > maxL) {
      // Bigger positions fall into a lower-leverage margin tier.
      if (p && p.side === side) return toast(`Przy tej wielkości maks. dźwignia to ${maxL}× — zmniejsz pozycję`);
      lev = maxL;
    }
    const tp = Number(form.tp) > 0 ? M.roundPx(Number(form.tp), m.szDec) : null;
    const sl = Number(form.sl) > 0 ? M.roundPx(Number(form.sl), m.szDec) : null;
    if (S.type === 'limit') {
      const px = M.roundPx(Number(form.px), m.szDec);
      if (!(px > 0)) return toast('Wpisz cenę limit');
      const sz = M.roundSz(ntl / px, m.szDec);
      if (!(sz > 0)) return toast('Za mała wielkość dla tego rynku');
      if (adds && sz * px < MIN_ORDER) return toast(`Minimalne zlecenie na Hyperliquid to $${MIN_ORDER}`);
      const book = await bookFor(coin);
      if (S.catching) return toast('Synchronizuję konto z rynkiem — chwila…');
      const best = side > 0 ? book?.asks?.[0]?.px ?? m.mid : book?.bids?.[0]?.px ?? m.mid;
      // A limit that crosses the book fills at once as a taker (up to its price).
      if (best && (side > 0 ? px >= best : px <= best)) return execMarket({ coin, side, sz, lev, cross, tp, sl, limitPx: px, book });
      const mk = marks();
      mk[coin] = m.mark;
      const needs = M.fillNeeds(A, { coin, side, sz, px, lev }, M.PERP_FEES.maker);
      if (needs > M.available(A, mk) + 1e-9) return toast(`Za mało środków — dostępne ${money(M.available(A, mk))}`);
      A.orders.push({ id: A.seq++, coin, side, sz, px, lev, cross, reduceOnly: false, tp, sl, t: Date.now() });
      save();
      S.dirty = true;
      return toast(`📌 Zlecenie limit: ${sideTxt(side)} ${sz} ${coin} @ ${fmtPx(px)}`);
    }
    const ref = m.mid || m.mark;
    const sz = M.roundSz(ntl / ref, m.szDec);
    if (!(sz > 0)) return toast('Za mała wielkość dla tego rynku');
    if (adds && sz * ref < MIN_ORDER) return toast(`Minimalne zlecenie na Hyperliquid to $${MIN_ORDER}`);
    const book = await bookFor(coin);
    if (S.catching) return toast('Synchronizuję konto z rynkiem — chwila…');
    return execMarket({ coin, side, sz, lev, cross, tp, sl, book });
  }
  function execMarket({ coin, side, sz, lev, cross, tp, sl, limitPx, book }) {
    const m = mkt(coin);
    const f = marketFill(coin, side, sz, book, limitPx);
    if (!f) return toast('Brak płynności w księdze zleceń');
    let fsz = M.roundSz(f.sz, m.szDec);
    const mk = marks();
    mk[coin] = m.mark;
    const avail = M.available(A, mk);
    const cur = A.pos[coin];
    // "Max" amounts are worked out on the mid price; the real fill can be a bit worse: trim the
    // opening part to what the free margin covers instead of refusing the order.
    const useLev = cur && cur.side === side ? cur.lev : lev;
    const closing = cur && cur.side !== side ? Math.min(cur.sz, fsz) : 0;
    if (M.fillNeeds(A, { coin, side, sz: fsz, px: f.px, lev }) > avail + 1e-9) {
      const fit = closing + M.roundSz(M.maxOpenSz(avail, f.px, useLev), m.szDec);
      if (fit >= fsz * 0.98 && fit > 0) fsz = M.roundSz(fit, m.szDec);
      else return toast(`Za mało środków — potrzeba ${money(M.fillNeeds(A, { coin, side, sz: fsz, px: f.px, lev }))}, dostępne ${money(avail)}. Doładuj wallet Perpetuals.`);
    }
    if (!(fsz > 0)) return toast('Brak płynności w księdze zleceń');
    if (fsz - closing > 1e-12 && (fsz - closing) * f.px < MIN_ORDER && !closing) return toast(`Minimalne zlecenie na Hyperliquid to $${MIN_ORDER}`);
    const fee = fsz * f.px * M.PERP_FEES.taker;
    const r = bookFill({ coin, side, sz: fsz, px: f.px, fee, lev, cross, t: Date.now() }, 'trade');
    const p = A.pos[coin];
    if (p && p.side === side) {
      if (tp && (side > 0 ? tp > f.px : tp < f.px)) p.tp = tp;
      if (sl && (side > 0 ? sl < f.px : sl > f.px)) p.sl = sl;
    }
    record(cur && cur.side !== side ? 'close' : 'open', { coin, side, sz: fsz, px: f.px, fee, pnl: r.closed.length ? r.realized : null });
    save();
    S.dirty = true;
    const slip = m.mid ? ((f.px - m.mid) / m.mid) * 100 * side : 0;
    toast(`${side > 0 ? '🟢' : '🔴'} ${sideTxt(side)} ${fsz} ${coin} @ ${fmtPx(f.px)} · opłata ${money(fee)}${Math.abs(slip) >= 0.05 ? ` · poślizg ${slip.toFixed(2)}%` : ''}${fsz < sz - 1e-12 ? ' · częściowo' : ''}`);
  }
  async function closePos(coin, frac) {
    syncFromStorage();
    const p = A.pos[coin];
    const m = mkt(coin);
    if (!p || !m) return;
    const why = blocked(coin);
    if (why) return toast(why);
    if (S.closing === coin) return;
    S.closing = coin;
    try {
      const book = await bookFor(coin);
      // The position may have changed while the book loaded (trigger, liquidation, other tab).
      const cur = A.pos[coin];
      if (!cur || cur.side !== p.side || S.catching) return;
      const part = M.roundSz(cur.sz * frac, m.szDec);
      if (frac < 1 && !(part > 0)) return toast('Za mała pozycja na częściowe zamknięcie');
      const sz = frac >= 1 ? cur.sz : Math.min(cur.sz, part);
      const f = marketFill(coin, -cur.side, sz, book);
      if (!f) return toast('Brak płynności w księdze zleceń');
      const fsz = Math.min(f.sz, cur.sz);
      const fee = fsz * f.px * M.PERP_FEES.taker;
      const r = bookFill({ coin, side: -cur.side, sz: fsz, px: f.px, fee, lev: cur.lev, cross: cur.cross, t: Date.now() }, 'trade');
      record('close', { coin, side: cur.side, sz: fsz, px: f.px, fee, pnl: r.realized, reason: 'trade' });
      save();
      S.dirty = true;
      toast(`✅ Zamknięto ${coin} ${frac < 1 ? `${Math.round(frac * 100)}% ` : ''}@ ${fmtPx(f.px)} · PnL ${money(r.realized - fee, true)}`);
    } finally {
      S.closing = null;
    }
  }

  // ---------- engine: limit fills, TP / SL, liquidations, funding ----------
  /** One pass at the given prices (live or replayed). Returns whether the account changed. */
  function step(t, mk, mids, notes, live) {
    let changed = false;
    for (const o of [...A.orders]) {
      if (o.t > t) continue; // replay: placed after this moment
      const px = mids[o.coin] ?? mk[o.coin];
      if (!(px > 0)) continue;
      if (!(o.side > 0 ? px <= o.px : px >= o.px)) continue;
      A.orders = A.orders.filter((x) => x.id !== o.id);
      const fee = o.sz * o.px * M.PERP_FEES.maker;
      const needs = M.fillNeeds(A, { coin: o.coin, side: o.side, sz: o.sz, px: o.px, lev: o.lev }, M.PERP_FEES.maker);
      if (needs > M.available(A, mk) + 1e-9) {
        notes.push(`❌ Anulowano limit ${o.coin} — brak środków`);
        changed = true;
        continue;
      }
      const r = bookFill({ coin: o.coin, side: o.side, sz: o.sz, px: o.px, fee, lev: o.lev, cross: o.cross, t }, 'limit');
      const p = A.pos[o.coin];
      if (p && p.side === o.side) {
        if (o.tp) p.tp = o.tp;
        if (o.sl) p.sl = o.sl;
      }
      record(r.closed.length ? 'close' : 'open', { coin: o.coin, side: o.side, sz: o.sz, px: o.px, fee, pnl: r.closed.length ? r.realized : null, reason: 'limit' });
      notes.push(`📌 Limit ${sideTxt(o.side)} ${o.sz} ${o.coin} wykonany @ ${fmtPx(o.px)}`);
      changed = true;
    }
    for (const p of Object.values(A.pos)) {
      const mark = mk[p.coin];
      if (!(mark > 0)) continue;
      const hit = M.triggerHit(p, mark);
      if (!hit) continue;
      // Triggers send a market order: live it fills on the book, replayed at the trigger.
      const f = live ? marketFill(p.coin, -p.side, p.sz, S.book[p.coin]?.at > Date.now() - 5_000 ? S.book[p.coin] : null) : { sz: p.sz, px: hit === 'sl' ? p.sl : p.tp };
      if (!f) continue;
      const sz = Math.min(p.sz, f.sz);
      const fee = sz * f.px * M.PERP_FEES.taker;
      const r = bookFill({ coin: p.coin, side: -p.side, sz, px: f.px, fee, lev: p.lev, cross: p.cross, t }, hit);
      record('close', { coin: p.coin, side: p.side, sz, px: f.px, fee, pnl: r.realized, reason: hit });
      notes.push(`${hit === 'sl' ? '🛑 SL' : '🎯 TP'} ${p.coin} @ ${fmtPx(f.px)} · PnL ${money(r.realized - fee, true)}`);
      changed = true;
    }
    const ev = M.liquidate(A, mk, tiersOf, t, { replay: !live });
    for (const e of ev) {
      A.stats.liqs++;
      record('liq', { coin: e.coin, pnl: e.pnl, kind: e.kind, partial: e.partial, returned: e.returned ?? 0 });
      notes.push(`💥 LIKWIDACJA ${e.coin}${e.partial ? ' (20%)' : ''}${e.kind === 'backstop' ? ' — cały margin stracony' : e.returned > 0 ? ` — zwrócono ${money(e.returned)}` : ''}`);
      changed = true;
    }
    return changed;
  }

  /** Funding for one hour, for the positions held at that hour (snapshot). */
  function settleFunding(snap, rates) {
    let total = 0;
    for (const h of snap) {
      const r = rates[h.coin];
      if (!r) continue;
      const pay = h.side * h.sz * r.px * Math.max(-M.FUNDING_CAP, Math.min(M.FUNDING_CAP, r.rate));
      const p = A.pos[h.coin];
      if (p && p.side === h.side && p.openedAt === h.openedAt) {
        if (p.cross) A.cash -= pay;
        else p.margin -= pay;
        p.funding += pay;
      } else A.cash -= pay; // closed since the hour: the payment still lands on the account
      A.stats.funding += pay;
      total += pay;
    }
    return total;
  }
  const snapshot = (hour) => Object.values(A.pos).filter((p) => p.openedAt < hour).map((p) => ({ coin: p.coin, side: p.side, sz: p.sz, openedAt: p.openedAt }));
  /** Rows of a paged Hyperliquid time-range request (500 / 5000 rows per call). */
  async function paged(body, from, to, timeOf, max = 40) {
    const out = [];
    let start = from;
    for (let i = 0; i < max && start <= to; i++) {
      const page = await post(body(start, to));
      if (!Array.isArray(page) || !page.length) break;
      out.push(...page);
      const last = timeOf(page[page.length - 1]);
      if (!(last >= start)) break;
      start = last + 1;
      if (page.length < 500) break;
    }
    return out;
  }
  async function settledRates(hour, coins) {
    // The settled rate of the hour that just ended (null for coins not published yet).
    const out = {};
    let missing = false;
    await Promise.all(
      coins.map(async (coin) => {
        const m = mkt(coin);
        try {
          const list = await post({ type: 'fundingHistory', coin, startTime: hour - 10 * 60_000, endTime: hour + 10 * 60_000 });
          const hit = (list || []).find((f) => Math.abs(f.time - hour) < 10 * 60_000);
          if (hit && (m?.oracle || m?.mark) > 0) out[coin] = { rate: Number(hit.fundingRate), px: m.oracle || m.mark };
          else missing = true;
        } catch {
          missing = true;
        }
      }),
    );
    // After a few minutes the live predicted rate stands in for anything still missing.
    if (missing && Date.now() - hour > 5 * 60_000)
      for (const c of coins) if (!out[c] && Number.isFinite(mkt(c)?.funding) && (mkt(c)?.oracle || mkt(c)?.mark) > 0) out[c] = { rate: mkt(c).funding, px: mkt(c).oracle || mkt(c).mark };
    return { rates: out, complete: coins.every((c) => out[c]) };
  }

  /** The page was asleep (iPhone background tab): replay what the market did meanwhile. */
  async function catchUp(from, to) {
    S.catching = true;
    const notes = [];
    const snapshotAcct = JSON.stringify(A);
    try {
      const coins = coinsInUse();
      const gap = to - from;
      const iv = gap <= 3 * 86400e3 ? '1m' : gap <= 40 * 86400e3 ? '15m' : '1h';
      const ivMs = TF_MS[iv];
      const pts = [];
      let lastFund = 0;
      await Promise.all(
        coins.map(async (coin) => {
          const cs = await paged((st, en) => ({ type: 'candleSnapshot', req: { coin, interval: iv, startTime: st, endTime: en } }), from - ivMs, to, (c) => c.t);
          for (const c of cs) {
            const o = +c.o, h = +c.h, l = +c.l, cl = +c.c;
            const path = cl >= o ? [o, l, h, cl] : [o, h, l, cl]; // likely order inside the candle
            const t0 = Math.max(c.t, from);
            path.forEach((px, k) => pts.push({ t: t0 + (k * Math.max(1, c.T - t0)) / 4, coin, px }));
          }
          // Every coin in use: a limit order can open a position during the gap.
          const fh = await paged((st, en) => ({ type: 'fundingHistory', coin, startTime: st, endTime: en }), from + 1, to, (f) => f.time);
          for (const f of fh) if (f.time > from && f.time <= to) pts.push({ t: f.time, coin, fund: Number(f.fundingRate), k: 1 });
          for (const f of fh) lastFund = Math.max(lastFund, f.time);
        }),
      );
      pts.sort((a, b) => a.t - b.t || (a.k || 0) - (b.k || 0));
      const mk = {};
      let funded = 0;
      for (let i = 0; i < pts.length; ) {
        // All points of one moment first, so no coin is judged at a stale price.
        const t = pts[i].t;
        const group = [];
        while (i < pts.length && pts[i].t === t) group.push(pts[i++]);
        for (const pt of group) if (pt.fund == null) mk[pt.coin] = pt.px;
        for (const pt of group) {
          if (pt.fund == null) continue;
          const p = A.pos[pt.coin];
          if (p && p.openedAt < pt.t && mk[pt.coin] > 0) {
            const pay = M.applyFunding(A, pt.coin, pt.fund, mk[pt.coin]);
            A.stats.funding += pay;
            funded += pay;
          }
        }
        if (!coinsInUse().every((c) => mk[c] > 0)) continue;
        const mids = {};
        for (const pt of group) if (pt.fund == null) mids[pt.coin] = pt.px;
        step(t, mk, mids, notes, false);
      }
      if (Math.abs(funded) >= 0.01) notes.push(`⏱ Funding w tym czasie: ${money(-funded, true)}`);
      // Hours whose rate is not published yet are settled by the live path.
      const lastHour = Math.floor(to / M.HOUR) * M.HOUR;
      A.fundAt = lastFund >= lastHour - 60_000 || to - lastHour > 5 * 60_000 ? lastHour : lastHour - M.HOUR;
      A.lastTick = to;
      S.catchFails = 0;
    } catch {
      // Leave the account as it was and try again soon (the gap is replayed once data comes).
      A = Object.assign(loadAcctFrom(JSON.parse(snapshotAcct)));
      S.catchFails = (S.catchFails || 0) + 1;
      S.catchRetryAt = Date.now() + Math.min(60_000, 5_000 * S.catchFails);
      if (S.catchFails >= 6) {
        A.lastTick = Date.now();
        notes.push('Nie udało się odtworzyć rynku z czasu, gdy aplikacja była w tle');
      }
    } finally {
      S.catching = false;
      save();
      S.dirty = true;
      if (notes.length) toast(notes.slice(0, 3).join(' · '));
    }
  }

  function fundingPass(t) {
    const hour = Math.floor(t / M.HOUR) * M.HOUR;
    if (!A.fundAt) A.fundAt = hour;
    if (A.fundAt < hour) {
      // Positions held at the hour pay its funding, even if closed before the rate is published.
      if (!S.fundSnap || S.fundSnap.hour !== hour) S.fundSnap = { hour, list: snapshot(hour) };
      if (!S.fundPending && t - (S.fundTry || 0) > 20_000) {
        S.fundPending = 1;
        S.fundTry = t;
        const snap = S.fundSnap;
        settledRates(hour, [...new Set(snap.list.map((h) => h.coin))])
          .then(({ rates, complete }) => {
            if (A.fundAt >= hour || !complete) return;
            const paid = settleFunding(snap.list, rates);
            A.fundAt = hour;
            S.fundSnap = null;
            save();
            S.dirty = true;
            if (Math.abs(paid) >= 0.01) toast(`⏱ Funding: ${money(-paid, true)}`);
          })
          .finally(() => (S.fundPending = 0));
      }
    }
  }

  async function engine() {
    const t = Date.now();
    if (S.catching) return;
    syncFromStorage();
    if (!busy()) {
      A.lastTick = t;
      // A funding hour still waiting for its rate is settled even after the positions closed.
      if (S.fundSnap && A.fundAt < S.fundSnap.hour) fundingPass(t);
      else A.fundAt = Math.floor(t / M.HOUR) * M.HOUR;
      return;
    }
    // Replaying needs each market's margin tiers: wait for the market list first.
    if (!coinsInUse().every((c) => mkt(c)?.tiers)) return;
    if (A.lastTick && t - A.lastTick > 20_000) {
      if (t < (S.catchRetryAt || 0)) return;
      return catchUp(A.lastTick, t);
    }
    // Only fresh prices count; while they are stale the clock stops and the gap is replayed later.
    if (!coinsInUse().every(fresh)) return;
    const mk = marks();
    const mids = {};
    for (const c of coinsInUse()) if (mkt(c)?.mid > 0) mids[c] = mkt(c).mid;
    const notes = [];
    const changed = step(t, mk, mids, notes, true);
    fundingPass(t);
    A.lastTick = t;
    if (notes.length) toast(notes.join(' · '));
    if (changed) {
      save();
      S.dirty = true;
    } else if (t - savedAt > 5_000) save();
  }

  // ---------- candles + chart ----------
  async function loadCandles() {
    const key = `${S.coin}|${S.tf}`;
    if (S.candles?.key === key && Date.now() - S.candles.at < 60_000) return;
    if (S.candlesBusy === key) return;
    S.candlesBusy = key;
    try {
      const ms = TF_MS[S.tf];
      const end = Date.now();
      const cs = await post({ type: 'candleSnapshot', req: { coin: S.coin, interval: S.tf, startTime: end - 400 * ms, endTime: end } });
      const list = (cs || []).map((c) => ({ time: Math.floor(c.t / 1000), open: +c.o, high: +c.h, low: +c.l, close: +c.c, v: +c.v })).filter((c) => c.close > 0);
      if (`${S.coin}|${S.tf}` === key) S.candles = { key, list, at: Date.now() };
    } catch {
      if (`${S.coin}|${S.tf}` === key && S.candles?.key !== key) S.candles = { key, list: [], at: Date.now() - 50_000, err: true };
    } finally {
      S.candlesBusy = '';
      drawChart();
    }
  }
  async function drawChart() {
    const box = $('#pfChartBox');
    if (!box || !sheetVisible()) return;
    const msg = $('#pfChartMsg');
    if (!window.LightweightCharts && !(await loadLW())) {
      msg.hidden = false;
      msg.textContent = 'Wykres niedostępny';
      return;
    }
    const LW = window.LightweightCharts;
    if (!S.chart || S.chart.el !== box) {
      try {
        S.chart?.chart.remove();
      } catch {
        /* gone */
      }
      const chart = LW.createChart(box, {
        autoSize: true,
        layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#7c879a', fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
        grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
        timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false, rightOffset: 4 },
        crosshair: { mode: LW.CrosshairMode.Normal },
        handleScroll: { vertTouchDrag: false, horzTouchDrag: true, mouseWheel: true, pressedMouseMove: true },
        handleScale: { pinch: true, mouseWheel: true, axisPressedMouseMove: true },
        localization: { locale: 'pl-PL' },
      });
      const candle = chart.addCandlestickSeries({
        upColor: '#1fd68f', downColor: '#ff4d6a', borderVisible: false, wickUpColor: '#1fd68f', wickDownColor: '#ff4d6a',
        priceFormat: { type: 'custom', minMove: 1e-9, formatter: (v) => (v > 0 ? fmtPx(v).slice(1) : '') },
      });
      candle.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.2 } });
      const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
      S.chart = { chart, candle, vol, el: box, key: '', lines: [], linesKey: '' };
    }
    const key = `${S.coin}|${S.tf}`;
    const c = S.candles?.key === key ? S.candles : null;
    if (!c?.list.length) {
      msg.hidden = false;
      msg.textContent = c?.err ? 'Brak połączenia z Hyperliquid — ponawiam…' : 'Ładowanie świec…';
      if (S.chart.key) {
        S.chart.candle.setData([]);
        S.chart.vol.setData([]);
        S.chart.key = '';
      }
    } else if (S.chart.key !== key || S.chart.dataAt !== c.at) {
      // New snapshot (other market / timeframe, or a refresh after sleep): keep the user's zoom on refresh.
      const keep = S.chart.key === key ? S.chart.chart.timeScale().getVisibleLogicalRange() : null;
      S.chart.dataAt = c.at;
      msg.hidden = true;
      S.chart.candle.setData(c.list);
      S.chart.vol.setData(c.list.map((b) => ({ time: b.time, value: b.v, color: b.close >= b.open ? 'rgba(31,214,143,0.35)' : 'rgba(255,77,106,0.35)' })));
      const n = c.list.length;
      if (!keep) S.chart.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 90), to: n + 4 });
      S.chart.key = key;
    }
    drawLines();
  }
  function drawLines() {
    const ch = S.chart;
    if (!ch) return;
    const p = A.pos[S.coin];
    const lines = [];
    if (p) {
      lines.push({ price: p.entry, color: '#52a8ff', title: `${p.side > 0 ? 'L' : 'S'} ${p.lev}×` });
      const liq = M.positionLiq(A, p, { ...marks(), [p.coin]: markOf(p.coin) || p.entry }, tiersOf);
      if (liq) lines.push({ price: liq, color: '#ffb224', title: 'Likw.', style: 2 });
      if (p.tp) lines.push({ price: p.tp, color: '#1fd68f', title: 'TP', style: 2 });
      if (p.sl) lines.push({ price: p.sl, color: '#ff4d6a', title: 'SL', style: 2 });
    }
    for (const o of A.orders) if (o.coin === S.coin) lines.push({ price: o.px, color: '#9aa4b5', title: `Limit ${o.side > 0 ? 'L' : 'S'}`, style: 1 });
    const k = JSON.stringify(lines.map((l) => [l.title, Number(l.price.toPrecision(6))]));
    if (k === ch.linesKey) return;
    ch.linesKey = k;
    for (const l of ch.lines) ch.candle.removePriceLine(l);
    ch.lines = lines.map((l) => ch.candle.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: l.style ?? 0, axisLabelVisible: true, title: l.title }));
  }

  // ---------- UI: perps sheet ----------
  const val = (id) => $(`#${id}`)?.value ?? '';
  function skeleton(body) {
    body.innerHTML = `
      <div id="pfAcct"></div>
      <div class="pf-market" id="pfMarket"></div>
      <div class="pf-pick" id="pfPick" hidden>
        <input id="pfQ" type="search" placeholder="Szukaj rynku (np. SOL, PEPE)" autocomplete="off" autocapitalize="characters" />
        <div id="pfList"></div>
      </div>
      <div class="card pf-chart">
        <div class="tf-row" id="pfTf">${Object.keys(TF_MS).map((tf) => `<button data-pf-tf="${tf}">${tf}</button>`).join('')}</div>
        <div class="pf-chart-box" id="pfChartBox"><div class="lw-msg" id="pfChartMsg">Ładowanie świec…</div></div>
      </div>
      <div class="card pf-order" id="pfOrder">
        <div class="pf-seg pf-side"><button data-pf-side="1">Long</button><button data-pf-side="-1">Short</button></div>
        <div class="pf-row">
          <div class="pf-seg pf-small"><button data-pf-type="market">Market</button><button data-pf-type="limit">Limit</button></div>
          <div class="pf-seg pf-small" id="pfMode"><button data-pf-mode="cross">Cross</button><button data-pf-mode="iso">Isolated</button></div>
        </div>
        <div class="pf-lev">
          <span>Dźwignia <b id="pfLevV"></b></span>
          <input id="pfLev" type="range" min="1" max="50" step="1" />
          <div class="pf-lev-q" id="pfLevQ"></div>
        </div>
        <label class="pf-field" id="pfPxRow" hidden><span>Cena limit</span><input id="pfPx" type="number" inputmode="decimal" step="any" placeholder="Cena" /><button data-pf-mid>Mid</button></label>
        <label class="pf-field"><span>Wielkość (USD)</span><input id="pfSz" type="number" inputmode="decimal" step="any" placeholder="Wartość pozycji w $" /></label>
        <div class="quick-amt pf-pct">${[10, 25, 50, 75, 100].map((v) => `<button data-pf-pct="${v}">${v}%</button>`).join('')}</div>
        <div class="pf-tpsl">
          <label class="pf-field"><span>TP</span><input id="pfTp" type="number" inputmode="decimal" step="any" placeholder="opcjonalnie" /></label>
          <label class="pf-field"><span>SL</span><input id="pfSl" type="number" inputmode="decimal" step="any" placeholder="opcjonalnie" /></label>
        </div>
        <div id="pfSum" class="pf-sum"></div>
        <button class="pf-go" data-pf-submit></button>
      </div>
      <div id="pfPos"></div>
      <div id="pfOrders"></div>
      <div id="pfHist"></div>
      <p class="note">Ceny, funding, księga zleceń i świece na żywo z Hyperliquid. Margin, likwidacje, funding co godzinę i opłaty (taker 0,045%, maker 0,015%) liczone według zasad Hyperliquid. Wirtualne pieniądze — to symulator do nauki, nie porada inwestycyjna.</p>`;
  }
  const put = (el, html) => {
    if (!el || el.dataset.html === html) return;
    // Never rebuild a block while its input is being typed in (it would close the keyboard).
    if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    el.dataset.html = html;
    el.innerHTML = html;
  };
  function acctHtml() {
    const mk = marks();
    const tv = M.totalValue(A, mk);
    const up = Object.values(A.pos).reduce((s, p) => s + (mk[p.coin] ? M.upnl(p, mk[p.coin]) : 0), 0);
    return `<div class="pf-acct">
      <div><span>Konto</span><b>${money(tv)}</b></div>
      <div><span>Dostępne</span><b>${money(M.available(A, mk))}</b></div>
      <div><span>uPnL</span><b class="${cls(up)}">${money(up, true)}</b></div>
    </div>
    <button class="pf-topup" data-pf-wallet>⬇️ Doładuj wallet Perpetuals</button>${A.deposits <= 0 ? '<p class="note pf-hint">Najpierw doładuj <b>Wallet Perpetuals (DEMO)</b> — przycisk „Doładuj” albo Wallet → Perpetuals.</p>' : ''}`;
  }
  function marketHtml() {
    const m = mkt(S.coin);
    if (!m) return `<div class="pf-mbar"><button class="pf-coin" data-pf-pick>${esc(S.coin)} ▾</button><span class="muted">${S.metaErr ? `Brak połączenia z Hyperliquid (${esc(S.metaErr)}) — ponawiam…` : 'Łączę z Hyperliquid…'}</span></div>`;
    const ch = m.prev > 0 ? ((m.mark - m.prev) / m.prev) * 100 : null;
    const next = Math.ceil(Date.now() / M.HOUR) * M.HOUR - Date.now();
    const mm = String(Math.floor(next / 60_000)).padStart(2, '0');
    const ss = String(Math.floor((next % 60_000) / 1000)).padStart(2, '0');
    const fr = (m.funding || 0) * 100;
    return `<div class="pf-mbar">
        <button class="pf-coin" data-pf-pick>${esc(m.coin)}-USD <small>${m.maxLev}×</small> ▾</button>
        <div class="pf-px"><b>${fmtPx(m.mark)}</b><small class="${cls(ch)}">${pct(ch)}</small></div>
      </div>
      <div class="pf-stats">
        <div><span>Funding 1h</span><b class="${fr > 0 ? 'down' : fr < 0 ? 'up' : ''}">${fr >= 0 ? '' : '−'}${Math.abs(fr).toFixed(4)}%</b><small>za ${mm}:${ss}</small></div>
        <div><span>Oracle</span><b>${fmtPx(m.oracle)}</b></div>
        <div><span>OI</span><b>${big((m.oi || 0) * m.mark)}</b></div>
        <div><span>Wol. 24h</span><b>${big(m.vol)}</b></div>
      </div>`;
  }
  function listHtml() {
    const q = S.q.trim().toUpperCase();
    const coins = S.list.filter((c) => !q || c.toUpperCase().includes(q)).slice(0, q ? 60 : 40);
    const favs = FAV.filter((c) => mkt(c));
    return `${q ? '' : `<div class="chips pf-favs">${favs.map((c) => `<button data-pf-coin="${esc(c)}" class="${c === S.coin ? 'active' : ''}">${esc(c)}</button>`).join('')}</div>`}
      <div class="pf-mlist">${
        coins
          .map((c) => {
            const m = mkt(c);
            const ch = m.prev > 0 ? ((m.mark - m.prev) / m.prev) * 100 : null;
            return `<button data-pf-coin="${esc(c)}"><span><b>${esc(c)}</b> <small>${m.maxLev}×</small></span><span>${fmtPx(m.mark)} <small class="${cls(ch)}">${pct(ch, 1)}</small></span><small class="muted">${big(m.vol)}</small></button>`;
          })
          .join('') || '<p class="note">Brak rynków dla tego wyszukiwania.</p>'
      }</div>`;
  }
  function formState() {
    const coin = S.coin;
    const m = mkt(coin);
    const p = A.pos[coin];
    const lev = levOf(coin);
    const cross = crossOf(coin);
    const max = m?.maxLev || 50;
    const sideEl = $('#pfOrder');
    if (!sideEl) return;
    sideEl.classList.toggle('short', S.side < 0);
    sideEl.querySelectorAll('[data-pf-side]').forEach((b) => b.classList.toggle('on', Number(b.dataset.pfSide) === S.side));
    sideEl.querySelectorAll('[data-pf-type]').forEach((b) => b.classList.toggle('on', b.dataset.pfType === S.type));
    sideEl.querySelectorAll('[data-pf-mode]').forEach((b) => {
      b.classList.toggle('on', (b.dataset.pfMode === 'cross') === cross);
      b.disabled = !!p || (m?.onlyIso && b.dataset.pfMode === 'cross');
    });
    $('#pfPxRow').hidden = S.type !== 'limit';
    const r = $('#pfLev');
    r.max = String(max);
    if (document.activeElement !== r) r.value = String(lev);
    r.disabled = !!p;
    $('#pfLevV').textContent = `${lev}×${p ? ' (pozycja otwarta)' : ''}`;
    const qs = [1, 2, 3, 5, 10, 20, 25, 40, 50].filter((x) => x <= max);
    if (!qs.includes(max)) qs.push(max);
    const qh = qs.map((x) => `<button data-pf-lev="${x}" class="${x === lev ? 'on' : ''}" ${p ? 'disabled' : ''}>${x}×</button>`).join('');
    const qe = $('#pfLevQ');
    if (qe.dataset.html !== qh) {
      qe.dataset.html = qh;
      qe.innerHTML = qh;
    }
    const go = $('[data-pf-submit]');
    go.textContent = `${S.side > 0 ? 'Long' : 'Short'} ${coin}${S.type === 'limit' ? ' · limit' : ''}`;
  }
  function sumHtml() {
    const coin = S.coin;
    const m = mkt(coin);
    if (!m) return '';
    const mk = marks();
    mk[coin] = m.mark;
    const avail = M.available(A, mk);
    const lev = levOf(coin);
    const ntl = Number(val('pfSz')) || 0;
    const px = S.type === 'limit' && Number(val('pfPx')) > 0 ? Number(val('pfPx')) : (S.side > 0 ? S.book[coin]?.asks?.[0]?.px : S.book[coin]?.bids?.[0]?.px) || m.mid || m.mark;
    const sz = ntl > 0 ? M.roundSz(ntl / px, m.szDec) : 0;
    const fee = sz * px * (S.type === 'limit' ? M.PERP_FEES.maker : M.PERP_FEES.taker);
    const margin = sz > 0 ? M.fillNeeds(A, { coin, side: S.side, sz, px, lev }) - sz * px * M.PERP_FEES.taker : 0;
    const liq = sz > 0 ? M.previewLiq(A, { coin, side: S.side, sz, px, lev, cross: crossOf(coin) }, mk, tiersOf) : null;
    const maxNtl = avail / (1 / lev + M.PERP_FEES.taker);
    const liqDist = liq ? Math.abs((liq - px) / px) * 100 : null;
    return `<div><span>Wielkość</span><b>${sz > 0 ? `${sz} ${esc(coin)}` : '—'}</b></div>
      <div><span>Margin</span><b>${sz > 0 ? money(margin) : '—'}</b></div>
      <div><span>Cena likwidacji</span><b class="warn-t">${liq ? `${fmtPx(liq)} <small>(${liqDist.toFixed(1)}%)</small>` : sz > 0 ? 'brak' : '—'}</b></div>
      <div><span>Opłata</span><b>${sz > 0 ? money(fee) : '—'}</b></div>
      <div><span>Dostępne</span><b>${money(avail)}</b></div>
      <div><span>Maks. pozycja</span><b>${money(maxNtl)}</b></div>`;
  }
  function posHtml() {
    const list = Object.values(A.pos);
    if (!list.length) return '<h3 class="pos-h">Pozycje (0)</h3><div class="empty"><b>Brak otwartych pozycji</b>Wybierz rynek, ustaw dźwignię i wielkość, potem Long albo Short.</div>';
    const mk = marks();
    return `<h3 class="pos-h">Pozycje (${list.length})</h3>${list
      .map((p) => {
        const m = mkt(p.coin);
        const mark = mk[p.coin];
        const pnl = mark ? M.upnl(p, mark) : null;
        const r = mark ? M.roe(p, mark) : null;
        const liq = mark ? M.positionLiq(A, p, mk, tiersOf) : null;
        const ntl = mark ? p.sz * mark : p.sz * p.entry;
        const margin = p.cross ? ntl / p.lev : p.margin + (pnl || 0);
        const ed = S.editing === p.coin;
        return `<div class="pos-card pf-pos ${p.side > 0 ? 'long' : 'short'}">
          <div class="pos-top">
            <div class="pos-name" data-pf-goto="${esc(p.coin)}"><b>${esc(p.coin)} <span class="chip ${p.side > 0 ? 'up' : 'down'}">${sideTxt(p.side)} ${p.lev}×</span> <span class="chip">${p.cross ? 'Cross' : 'Isolated'}</span></b><small>${p.sz} ${esc(p.coin)} · ${money(ntl)}</small></div>
            <div class="pos-pct ${cls(pnl)}">${money(pnl, true)}<small>${pct(r)}</small></div>
          </div>
          <div class="pos-grid">
            <div><span>Wejście</span><b>${fmtPx(p.entry)}</b></div>
            <div><span>Mark</span><b>${fmtPx(mark)}</b></div>
            <div><span>Likwidacja</span><b class="warn-t">${liq ? fmtPx(liq) : 'brak'}</b></div>
            <div><span>Margin${p.cross ? ' (cross)' : ''}</span><b>${money(margin)}</b></div>
            <div><span>Funding</span><b class="${cls(-p.funding)}">${money(-p.funding, true)}</b></div>
            <div><span>TP / SL</span><b>${p.tp ? fmtPx(p.tp) : '—'} / ${p.sl ? fmtPx(p.sl) : '—'}</b></div>
          </div>
          ${
            ed
              ? `<div class="pf-tpsl pf-edit"><label class="pf-field"><span>TP</span><input id="pfETp" type="number" inputmode="decimal" step="any" value="${esc(S.draft?.tp ?? p.tp ?? '')}" placeholder="cena" /></label>
                 <label class="pf-field"><span>SL</span><input id="pfESl" type="number" inputmode="decimal" step="any" value="${esc(S.draft?.sl ?? p.sl ?? '')}" placeholder="cena" /></label></div>
                 <div class="pos-acts"><button data-pf-save="${esc(p.coin)}">💾 Zapisz</button><button data-pf-edit="">Anuluj</button></div>`
              : ''
          }
          <div class="pos-acts">
            <button data-pf-close="${esc(p.coin)}|0.25">25%</button><button data-pf-close="${esc(p.coin)}|0.5">50%</button><button data-pf-close="${esc(p.coin)}|1">Zamknij</button>
            ${ed ? '' : `<button data-pf-edit="${esc(p.coin)}">TP/SL</button>`}
          </div>
          ${p.cross ? '' : `<div class="pos-acts pf-marg"><span>Margin</span><button data-pf-margin="${esc(p.coin)}|-">− 10%</button><button data-pf-margin="${esc(p.coin)}|+">+ 10%</button></div>`}
        </div>`;
      })
      .join('')}`;
  }
  function ordersHtml() {
    if (!A.orders.length) return '';
    return `<h3 class="pos-h">Zlecenia limit (${A.orders.length})</h3><div class="pos-closed">${A.orders
      .map((o) => `<div><span>${esc(o.coin)} <small class="${o.side > 0 ? 'up' : 'down'}">${sideTxt(o.side)} ${o.lev}×</small> <small>${o.sz} @ ${fmtPx(o.px)} · ${ago(o.t)}</small></span><button class="share-mini" data-pf-cancel="${o.id}" aria-label="Anuluj">✕</button></div>`)
      .join('')}</div>`;
  }
  const REASON = { trade: '', limit: '📌 ', sl: '🛑 SL · ', tp: '🎯 TP · ', liq: '💥 Likwidacja · ' };
  function histHtml() {
    const h = A.hist.slice(0, 25);
    if (!h.length) return '';
    return `<h3 class="pos-h">Historia</h3><div class="pos-closed">${h
      .map((r) => {
        const net = r.pnl - (r.fees || 0) - (r.funding || 0);
        return `<div><span>${esc(r.coin)} <small class="${r.side > 0 ? 'up' : 'down'}">${sideTxt(r.side)} ${r.lev}×</small> <small>${REASON[r.reason] || ''}${r.sz} · ${fmtPx(r.entry)} → ${fmtPx(r.exit)} · ${ago(r.t)}</small></span><b class="${cls(net)}">${money(net, true)}<small class="muted tx-fee">opłaty ${money(r.fees || 0)}${r.funding ? ` · funding ${money(-r.funding, true)}` : ''}</small></b></div>`;
      })
      .join('')}</div>`;
  }
  function render() {
    const body = $('#perpBody');
    if (!body) return;
    if (!body.querySelector('#pfOrder')) {
      skeleton(body);
      S.chart = null;
    }
    put($('#pfAcct'), acctHtml());
    put($('#pfMarket'), marketHtml());
    const pick = $('#pfPick');
    pick.hidden = !S.picker;
    if (S.picker) put($('#pfList'), listHtml());
    body.querySelectorAll('[data-pf-tf]').forEach((b) => b.classList.toggle('active', b.dataset.pfTf === S.tf));
    formState();
    put($('#pfSum'), sumHtml());
    put($('#pfPos'), posHtml());
    put($('#pfOrders'), ordersHtml());
    put($('#pfHist'), histHtml());
    loadCandles();
    drawChart();
  }
  function selectCoin(c) {
    if (!mkt(c)) return;
    S.coin = c;
    ls.set('mr:perpCoin', c);
    S.picker = false;
    S.q = '';
    const q = $('#pfQ');
    if (q) q.value = '';
    const px = $('#pfPx');
    if (px) px.value = '';
    for (const id of ['pfTp', 'pfSl']) if ($(`#${id}`)) $(`#${id}`).value = '';
    ensureWs();
    render();
  }

  function onClick(e) {
    const t = e.target.closest('button, [data-pf-goto]');
    if (!t) return;
    syncFromStorage();
    const d = t.dataset;
    if (d.pfSide) S.side = Number(d.pfSide);
    else if (d.pfType) S.type = d.pfType;
    else if (d.pfMode) {
      if (A.pos[S.coin]) return toast('Trybu nie zmienisz przy otwartej pozycji');
      A.cross[S.coin] = d.pfMode === 'cross';
      save();
    } else if (d.pfLev) {
      if (A.pos[S.coin]) return;
      A.lev[S.coin] = Number(d.pfLev);
      save();
    } else if (d.pfPct) {
      const m = mkt(S.coin);
      if (!m) return;
      const mk = marks();
      mk[S.coin] = m.mark;
      // A small buffer for the fill being a little worse than the mid price.
      const max = (M.available(A, mk) / (1 / levOf(S.coin) + M.PERP_FEES.taker)) * 0.995;
      if (!(max >= MIN_ORDER)) return toast('Za mało środków — doładuj wallet Perpetuals');
      $('#pfSz').value = String(Math.floor(max * (Number(d.pfPct) / 100) * 100) / 100);
    } else if (d.pfMid !== undefined) {
      const m = mkt(S.coin);
      if (m) $('#pfPx').value = String(M.roundPx(m.mid || m.mark, m.szDec));
    } else if (d.pfSubmit !== undefined) {
      document.activeElement?.blur?.();
      const f = { sz: val('pfSz'), px: val('pfPx'), tp: val('pfTp'), sl: val('pfSl') };
      placeOrder(f).then(() => {
        render();
      });
      return;
    } else if (d.pfPick !== undefined) {
      S.picker = !S.picker;
      if (S.picker && !S.list.length) refreshMeta();
    } else if (d.pfCoin) return selectCoin(d.pfCoin);
    else if (d.pfTf) {
      S.tf = d.pfTf;
      ls.set('mr:perpTf', S.tf);
      ensureWs();
    } else if (d.pfClose) {
      const [coin, frac] = d.pfClose.split('|');
      closePos(coin, Number(frac)).then(render);
      return;
    } else if (d.pfEdit !== undefined) {
      S.editing = d.pfEdit || null;
      S.draft = null;
    }
    else if (d.pfSave) {
      const p = A.pos[d.pfSave];
      if (!p) return;
      const m = mkt(p.coin);
      const mark = markOf(p.coin) || p.entry;
      const tp = Number(val('pfETp')) > 0 ? M.roundPx(Number(val('pfETp')), m?.szDec || 0) : null;
      const sl = Number(val('pfESl')) > 0 ? M.roundPx(Number(val('pfESl')), m?.szDec || 0) : null;
      if (tp && (p.side > 0 ? tp <= mark : tp >= mark)) return toast(`TP musi być ${p.side > 0 ? 'powyżej' : 'poniżej'} ceny mark`);
      if (sl && (p.side > 0 ? sl >= mark : sl <= mark)) return toast(`SL musi być ${p.side > 0 ? 'poniżej' : 'powyżej'} ceny mark`);
      p.tp = tp;
      p.sl = sl;
      S.editing = null;
      S.draft = null;
      document.activeElement?.blur?.();
      save();
      toast('TP / SL zapisane');
    } else if (d.pfMargin) {
      const [coin, dir] = d.pfMargin.split('|');
      const p = A.pos[coin];
      const m = mkt(coin);
      if (!p || p.cross || !m?.mark) return;
      const delta = Math.max(1, p.margin * 0.1);
      const mk = marks();
      if (dir === '+') {
        if (M.available(A, mk) < delta) return toast('Za mało dostępnych środków');
        A.cash -= delta;
        p.margin += delta;
      } else {
        // Hyperliquid's transfer requirement: what stays must cover max(initial margin, 10% of value).
        const ntl = p.sz * m.mark;
        if (p.margin - delta + M.upnl(p, m.mark) < Math.max(ntl / p.lev, 0.1 * ntl)) return toast('Nie można zdjąć więcej marginu z tej pozycji');
        A.cash += delta;
        p.margin -= delta;
      }
      save();
    } else if (d.pfCancel) {
      A.orders = A.orders.filter((o) => String(o.id) !== d.pfCancel);
      save();
      toast('Zlecenie anulowane');
    } else if (d.pfGoto) {
      selectCoin(d.pfGoto);
      $('#perpSheet').scrollTop = 0;
      return;
    } else if (d.pfWallet !== undefined) return nav?.('wallet');
    else return;
    render();
  }
  function onInput(e) {
    const id = e.target.id;
    if (id === 'pfLev') {
      if (A.pos[S.coin]) return;
      A.lev[S.coin] = Number(e.target.value);
      formState();
      put($('#pfSum'), sumHtml());
      clearTimeout(onInput.t);
      onInput.t = setTimeout(save, 400);
    } else if (id === 'pfSz' || id === 'pfPx') put($('#pfSum'), sumHtml());
    else if (id === 'pfETp' || id === 'pfESl') S.draft = { tp: val('pfETp'), sl: val('pfESl') };
    else if (id === 'pfQ') {
      S.q = e.target.value;
      $('#pfList').dataset.html = '';
      const el = $('#pfList');
      el.dataset.html = listHtml();
      el.innerHTML = el.dataset.html;
    }
  }

  // ---------- UI: perps wallet ----------
  /** PnL calendar like the spot one: realised result per day (after fees and funding, liquidations included). */
  function calendarHtml() {
    const back = S.calMonth || 0;
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const byDay = new Map();
    for (const r of A.hist) {
      const dt = new Date(r.t);
      if (dt.getFullYear() !== first.getFullYear() || dt.getMonth() !== first.getMonth()) continue;
      const k = dt.getDate();
      const o = byDay.get(k) || { pnl: 0, n: 0 };
      o.pnl += r.pnl - (r.fees || 0) - (r.funding || 0);
      o.n++;
      byDay.set(k, o);
    }
    const total = [...byDay.values()].reduce((a, o) => a + o.pnl, 0);
    const lead = (first.getDay() + 6) % 7; // Monday first
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<div class="cal-d empty"></div>');
    const today = back === 0 ? now.getDate() : -1;
    const short = (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.abs(v) >= 10 ? Math.round(v) : v.toFixed(1));
    for (let dd = 1; dd <= days; dd++) {
      const o = byDay.get(dd);
      const c = o ? (o.pnl > 0 ? 'win' : o.pnl < 0 ? 'loss' : 'flat') : '';
      cells.push(`<div class="cal-d ${c}${dd === today ? ' today' : ''}" title="${o ? `${o.n} zamknięć · ${money(o.pnl, true)}` : ''}"><span>${dd}</span>${o ? `<b>${o.pnl >= 0 ? '+' : '−'}${short(Math.abs(o.pnl))}</b>` : ''}</div>`);
    }
    const month = first.toLocaleString('pl-PL', { month: 'long', year: 'numeric' });
    return `<h3 class="pos-h">Kalendarz PnL</h3>
      <div class="cal"><div class="cal-head"><button data-pw-cal="1" aria-label="Poprzedni miesiąc">‹</button><b>${month}</b><span class="${total > 0 ? 'up' : total < 0 ? 'down' : 'muted'}">${byDay.size ? money(total, true) : '—'}</span><button data-pw-cal="-1" ${back === 0 ? 'disabled' : ''} aria-label="Następny miesiąc">›</button></div>
        <div class="cal-grid">${['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'].map((x) => `<div class="cal-w">${x}</div>`).join('')}${cells.join('')}</div></div>`;
  }
  const TXL = { deposit: ['⬇️', 'Doładowanie'], open: ['📈', 'Otwarcie'], close: ['✅', 'Zamknięcie'], liq: ['💥', 'Likwidacja'], reset: ['♻️', 'Reset walletu'] };
  function walletRender(body) {
    if (!body) return;
    if (!body.querySelector('#pwCard')) {
      body.innerHTML = `<div id="pwCard"></div><div id="pwCal"></div>
        <div class="card wallet-top"><h3>Doładuj wallet Perpetuals <small>DEMO</small></h3>
          <div class="pos-form">
            <input id="pwTopUp" type="number" inputmode="decimal" min="0" step="any" placeholder="Kwota w $" />
            <button data-pw="topup">⬇️ Doładuj</button>
          </div>
          <div class="quick-amt">${[100, 500, 1000, 5000].map((v) => `<button data-pw-amt="${v}">+$${v.toLocaleString('pl-PL')}</button>`).join('')}</div>
          <p class="note">Osobny wallet do gry na perpach (USDC na Hyperliquid). Wirtualne pieniądze — doładuj dowolną kwotę.</p>
        </div>
        <div id="pwStats"></div><div id="pwHist"></div>
        <div class="d-acts" style="margin-top:16px"><button data-pw="open">📈 Otwórz Perpy</button><button data-pw="reset">♻️ Wyzeruj wallet Perpetuals</button></div>`;
    }
    const mk = marks();
    const tv = M.totalValue(A, mk);
    const up = Object.values(A.pos).reduce((s, p) => s + (mk[p.coin] ? M.upnl(p, mk[p.coin]) : 0), 0);
    const used = tv - M.available(A, mk);
    const res = tv - A.deposits;
    put(
      $('#pwCard', body),
      `<div class="wallet-card perp-card">
        <span>Wartość konta Perpetuals</span><b>${money(tv)}</b>
        <div class="wallet-sub"><div><span>Dostępne</span><b>${money(M.available(A, mk))}</b></div><div><span>Margin w użyciu</span><b>${money(Math.max(0, used))}</b></div>
          <div><span>Wynik</span><b class="${cls(res)}">${A.deposits > 0 ? `${money(res, true)} <small>${pct((res / A.deposits) * 100, 1)}</small>` : '—'}</b></div></div>
        <div class="wallet-sub"><div><span>uPnL</span><b class="${cls(up)}">${money(up, true)}</b></div><div><span>Pozycje</span><b>${Object.keys(A.pos).length}</b></div><div><span>Zlecenia</span><b>${A.orders.length}</b></div></div>
      </div>`,
    );
    put($('#pwCal', body), calendarHtml());
    const closed = A.hist.filter((r) => r.full !== false || r.reason !== 'trade');
    const wins = closed.filter((r) => r.pnl - (r.fees || 0) - (r.funding || 0) > 0).length;
    put(
      $('#pwStats', body),
      `<div class="pos-pnl">
        <div><span>Zamknięte</span><b>${closed.length}</b><small>${closed.length ? `${Math.round((wins / closed.length) * 100)}% zyskownych` : '—'}</small></div>
        <div><span>Opłaty</span><b>${money(A.stats.fees)}</b><small>taker 0,045% · maker 0,015%</small></div>
        <div><span>Funding</span><b class="${cls(-A.stats.funding)}">${money(-A.stats.funding, true)}</b><small>likwidacje: ${A.stats.liqs}</small></div>
      </div>`,
    );
    const tx = A.tx.slice(0, 30);
    put(
      $('#pwHist', body),
      `<p class="note">Wpłacono łącznie ${money(A.deposits)}.</p><h3 class="pos-h">Historia</h3><div class="pos-closed">${
        tx.length
          ? tx
              .map((t) => {
                const [ic, label] = TXL[t.type] || ['•', t.type];
                const right = t.type === 'deposit' ? `<b class="up">+${money(t.amount)}</b>` : t.type === 'reset' ? '<b></b>' : t.type === 'liq' ? `<b class="down">${money(t.pnl, true)}</b>` : `<b class="${cls(t.pnl)}">${t.pnl != null ? money(t.pnl, true) : `${t.sz} @ ${fmtPx(t.px)}`}${t.fee ? `<small class="muted tx-fee">opłata ${money(t.fee)}</small>` : ''}</b>`;
                return `<div><span>${ic} ${label}${t.coin ? ` <small>${esc(t.coin)}${t.side ? ` ${sideTxt(t.side)}` : ''}</small>` : ''} <small>· ${ago(t.t)}</small></span>${right}</div>`;
              })
              .join('')
          : '<div><span class="muted">Brak operacji — doładuj wallet, żeby zacząć grać na perpach DEMO.</span></div>'
      }</div>`,
    );
  }
  function onWalletClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.pwCal) {
      S.calMonth = Math.max(0, Math.min(24, (S.calMonth || 0) + Number(b.dataset.pwCal)));
      return walletRender(e.currentTarget);
    }
    syncFromStorage();
    const amt = b.dataset.pwAmt;
    const act = b.dataset.pw;
    if (amt || act === 'topup') {
      const input = $('#pwTopUp');
      const v = amt ? Number(amt) : Number(input?.value);
      if (!(v > 0) || v > 1e12) return toast('Wpisz kwotę doładowania');
      A.cash += v;
      A.deposits += v;
      record('deposit', { amount: v });
      save();
      if (!amt && input) input.value = '';
      toast(`⬇️ Doładowano ${money(v)} — wallet Perpetuals ${money(M.totalValue(A, marks()))}`);
    } else if (act === 'reset') {
      if (!confirm('Wyzerować wallet Perpetuals DEMO? Saldo, otwarte pozycje, zlecenia i historia perpów zostaną usunięte.')) return;
      A = M.newAccount();
      A.stats = { fees: 0, funding: 0, liqs: 0 };
      record('reset', { amount: 0 });
      save();
      toast('Wallet Perpetuals wyzerowany');
    } else if (act === 'open') return nav?.('perps');
    else return;
    walletRender(e.currentTarget);
  }

  // ---------- loop ----------
  let lastRender = 0;
  async function loop() {
    const vis = sheetVisible();
    const wvis = walletVisible();
    const need = vis || wvis || busy();
    if (need) {
      const every = vis ? 5_000 : S.wsOk && !wvis ? 10_000 : 4_000;
      if (Date.now() - S.metaAt > every) refreshMeta();
    }
    ensureWs();
    try {
      await engine();
    } catch {
      /* next pass */
    }
    const now = Date.now();
    if (vis && (S.dirty || now - lastRender > 1_000) && !sheetTouchBusy()) {
      S.dirty = false;
      lastRender = now;
      render();
    }
    if (wvis && !sheetTouchBusy()) walletRender($('#walletPerpBody'));
  }
  let touchUntil = 0;
  const sheetTouchBusy = () => Date.now() < touchUntil;
  for (const sel of ['#perpSheet', '#walletPerpBody']) {
    const el = $(sel);
    if (!el) continue;
    el.addEventListener('touchstart', () => (touchUntil = Date.now() + 60_000), { passive: true });
    for (const ev of ['touchend', 'touchcancel']) el.addEventListener(ev, () => (touchUntil = Date.now() + 400), { passive: true });
  }
  document.addEventListener('touchend', () => touchUntil > Date.now() + 400 && (touchUntil = Date.now() + 400), { passive: true, capture: true });
  $('#perpSheet')?.addEventListener('click', onClick);
  $('#perpSheet')?.addEventListener('input', onInput);
  $('#walletPerpBody')?.addEventListener('click', onWalletClick);
  // Back from the background: run the engine at once (replays the gap if needed).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (S.candles) S.candles.at = 0; // fresh candles: the live stream missed the sleep
    loop();
  });
  setInterval(loop, 1_000);
  setTimeout(loop, 0);

  return {
    render() {
      S.dirty = true;
      render();
      refreshMeta();
      ensureWs();
    },
    renderWallet: (el) => walletRender(el),
    count: () => Object.keys(A.pos).length,
    _state: () => ({ A, S }),
  };
}
