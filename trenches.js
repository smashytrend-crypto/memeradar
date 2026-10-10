// Trenches DEMO — memecoin trading the way Axiom / Padre / Photon show it: live launchpad columns
// (New pairs → Final stretch → Migrated), one-tap buys in the network's coin, a token page with
// chart, trades and buy / sell presets. Data: PumpPortal launches + migrations (via the engine)
// and Jupiter's Tokens API on Solana; the radar's own data on EVM networks. Swaps are priced with
// trench-math.js (pump.fun curve / AMM pools, real fees). Virtual money, own wallet per network.

import * as T from './trench-math.js?v=mv2dlcgj';
import { iconImg, setHtml } from './img.js?v=mv2dlcgj';

const KEY = 'mr:trench';
// Chart timeframes: seconds ones are built here from trades + the live price (APIs stop at 1 min).
const TF_MS = { '1s': 1e3, '15s': 15e3, '30s': 30e3, '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3 };
const SUB_TF = new Set(['1s', '15s', '30s']);
const SET_KEY = 'mr:trenchSet';
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
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const toMs = (v) => (v ? (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v) || null) : null);

// ---------- formatting ----------
const usd = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K` : a.toFixed(a >= 100 ? 0 : 2);
  return `${v < 0 ? '−' : ''}$${s}`;
};
const nat = (v, sym, signed = false) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const s = a >= 1000 ? a.toFixed(0) : a >= 10 ? a.toFixed(2) : a >= 1 ? a.toFixed(3) : a.toFixed(4);
  return `${signed ? (v > 0 ? '+' : v < 0 ? '−' : '') : v < 0 ? '−' : ''}${s} ${sym}`;
};
const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v) >= 100 ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(1)}%`);
const cls = (v) => (v == null || !Number.isFinite(v) || Math.abs(v) < 1e-9 ? '' : v > 0 ? 'up' : 'down');
const age = (t, now = Date.now()) => {
  if (!t) return '—';
  const s = Math.max(0, (now - t) / 1000);
  return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
/** Tiny prices the way terminals show them: $0.0₅1234 (5 zeros after the point). */
const fpx = (v) => {
  if (!(v > 0) || !Number.isFinite(v)) return '—';
  if (v >= 1) return `$${v.toFixed(4)}`;
  if (v >= 0.001) return `$${v.toFixed(6)}`;
  const zeros = Math.floor(-Math.log10(v));
  const digits = String(Math.round(v * 10 ** (zeros + 3))).slice(0, 4).replace(/0+$/, '') || '0';
  return `$0.0${String(zeros).split('').map((d) => '₀₁₂₃₄₅₆₇₈₉'[d]).join('')}${digits}`;
};
const tokAmt = (v) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0));

// Network fees per chain (EVM: gas in $ per swap, like the spot demo); Solana from settings.
const GAS_USD = { ethereum: 3, base: 0.05, bsc: 0.1, robinhood: 0.05 };
const PRESETS = { solana: [0.1, 0.5, 1, 2], bsc: [0.02, 0.05, 0.1, 0.5], base: [0.002, 0.005, 0.01, 0.05], ethereum: [0.005, 0.01, 0.05, 0.1], robinhood: [0.002, 0.005, 0.01, 0.05] };
const TOPUP = { solana: [1, 5, 10, 50], bsc: [0.5, 1, 5, 10], base: [0.1, 0.5, 1, 5], ethereum: [0.1, 0.5, 1, 5], robinhood: [0.1, 0.5, 1, 5] };
const COLS = { solana: [['new', 'Nowe'], ['stretch', 'Final Stretch'], ['migrated', 'Migrated']], evm: [['new', 'Nowe pary'], ['hot', 'Trending'], ['surge', 'Wybicia']] };
const SHORT = { solana: 'SOL', bsc: 'BNB', base: 'Base', ethereum: 'ETH', robinhood: 'HOOD' };
/** Launchpad id from Jupiter's / PumpPortal's name. */
function lpOf(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return null;
  for (const [re, id] of [[/pump/, 'pump'], [/bonk|launchlab/, 'bonk'], [/bags/, 'bags'], [/moon/, 'moonshot'], [/believe/, 'believe'], [/heaven/, 'heaven'], [/boop/, 'boop'], [/dbc|meteora/, 'dbc'], [/jup/, 'jup'], [/daos/, 'daos']])
    if (re.test(n)) return id;
  return n;
}
// Axiom-style protocol chips.
const PROTOCOLS = [['pump', 'Pump'], ['bonk', 'Bonk'], ['bags', 'Bags'], ['moonshot', 'Moonshot'], ['believe', 'Believe'], ['heaven', 'Heaven'], ['boop', 'Boop'], ['dbc', 'Meteora DBC'], ['jup', 'Jup Studio'], ['other', 'Inne']];
const KNOWN_LP = new Set(PROTOCOLS.map(([k]) => k));
// Range filters: [key, label, unit multiplier, ends: 'mm' min + max, 'x' max only, 'n' min only].
const AUDIT = [['t10', 'Top 10 %', 1, 'mm'], ['dv', 'Dev trzyma %', 1, 'mm'], ['h', 'Holderzy', 1, 'mm'], ['org', 'Organic score', 1, 'mm'], ['dm', 'Tokeny deva', 1, 'x'], ['dmg', 'Migracje deva', 1, 'n'], ['age', 'Wiek (min)', 1, 'mm'], ['prog', 'Krzywa %', 1, 'mm']];
const METRICS = [['mc', 'MC (tys. $)', 1000, 'mm'], ['lq', 'Płynność (tys. $)', 1000, 'mm'], ['v5', 'Wolumen 5m (tys. $)', 1000, 'mm'], ['tx', 'Transakcje 5m', 1, 'mm'], ['b5', 'Kupna 5m', 1, 'mm'], ['tr5', 'Traderzy 5m', 1, 'mm']];

export function createTrenches({ engine, chains, chain, setChain, nativeUsd, toast, loadLW, nav }) {
  // ---------- wallet ----------
  const loadW = () => {
    const w = Object.assign(T.newWallet(), ls.get(KEY, {}) || {});
    for (const k of ['cash', 'deposits', 'pos']) if (!w[k] || typeof w[k] !== 'object') w[k] = {};
    for (const k of ['hist', 'tx']) if (!Array.isArray(w[k])) w[k] = [];
    w.stats = Object.assign({ fees: 0 }, w.stats || {});
    if (!Number.isFinite(w.rev)) w.rev = 0;
    return w;
  };
  let W = loadW();
  const storedRev = () => {
    try {
      return Number(localStorage.getItem(`${KEY}:rev`)) || 0;
    } catch {
      return 0;
    }
  };
  const sync = () => {
    if (storedRev() > W.rev) W = loadW();
  };
  const save = () => {
    W.hist = W.hist.slice(0, 300);
    W.tx = W.tx.slice(0, 300);
    W.rev = Math.max(W.rev, storedRev()) + 1;
    ls.set(KEY, W);
    try {
      localStorage.setItem(`${KEY}:rev`, String(W.rev));
    } catch {
      /* private mode */
    }
    S.dirty = true;
  };
  window.addEventListener('storage', (e) => e.key === `${KEY}:rev` && (sync(), (S.dirty = true)));

  const set = Object.assign({ slip: 20, prio: 0.001, tip: 0.001, quick: {}, presets: {}, sells: [10, 25, 50, 100] }, ls.get(SET_KEY, {}) || {});
  const saveSet = () => ls.set(SET_KEY, set);

  // ---------- runtime ----------
  const S = {
    tk: new Map(), // mint → token card data (Solana feed)
    col: 'new',
    open: null, // mint on the token page
    live: null, // { p, mc, at }
    trades: null,
    tf: TF_MS[set.tf] ? set.tf : '1m',
    ticks: [], // live prices of the open token [{ t, p }] (second candles)
    candles: null,
    chart: null,
    busy: false,
    dirty: true,
    pollAt: {},
    px: {}, // position key → { p (usd), mc, at }
    settings: false,
    draft: {},
  };
  const C = () => chain();
  const cfg = () => chains.find((c) => c.id === C()) || { id: C(), native: 'SOL', evm: false };
  const sym = () => cfg().native || 'SOL';
  const isSol = () => C() === 'solana';
  const nUsd = (c = C()) => (c === 'solana' ? engine.trenches.solPrice() || nativeUsd('solana') : nativeUsd(c)) || 0;
  const presets = () => set.presets[C()] || PRESETS[C()] || PRESETS.solana;
  const quick = () => set.quick[C()] ?? presets()[1];
  const visible = () => !$('#trenchSheet')?.hidden;
  const walletVisible = () => !$('#walletSheet')?.hidden && !$('#walletTrenchBody')?.hidden;
  const myPos = () => Object.values(W.pos);

  // ---------- Solana feed: Jupiter + PumpPortal ----------
  function fromJup(j) {
    if (!j?.id) return;
    const a = j.audit || {};
    const s5 = j.stats5m || {};
    const s1 = j.stats1h || {};
    const t = S.tk.get(j.id) || { m: j.id, seen: Date.now() };
    const lp = lpOf(j.launchpad) || t.lp || null;
    Object.assign(t, {
      n: j.name ?? t.n,
      s: j.symbol ?? t.s,
      i: j.icon || t.i,
      dev: j.dev || t.dev,
      lp,
      ca: toMs(j.firstPool?.createdAt || j.createdAt) || t.ca,
      mc: num(j.mcap) ?? t.mc,
      lq: num(j.liquidity) ?? t.lq,
      p: num(j.usdPrice) ?? t.p,
      h: num(j.holderCount) ?? t.h,
      t10: num(a.topHoldersPercentage) ?? t.t10,
      dv: j.audit ? num(a.devBalancePercentage) ?? 0 : t.dv,
      dm: num(a.devMints) ?? t.dm,
      dmg: a.devMints != null ? num(a.devMigrations) ?? 0 : t.dmg,
      v5: (num(s5.buyVolume) || 0) + (num(s5.sellVolume) || 0),
      v1: (num(s1.buyVolume) || 0) + (num(s1.sellVolume) || 0),
      b5: num(s5.numBuys) || 0,
      s5: num(s5.numSells) || 0,
      c5: num(s5.priceChange),
      tr5: num(s5.numTraders) || 0,
      org: num(j.organicScore) ?? t.org,
      grad: !!j.graduatedPool || t.grad || false,
      ga: toMs(j.graduatedAt) || t.ga || null,
      soc: { tw: j.twitter || t.soc?.tw, tg: j.telegram || t.soc?.tg, web: j.website || t.soc?.web },
      upd: Date.now(),
    });
    progressOf(t);
    S.tk.set(j.id, t);
  }
  function progressOf(t) {
    if (t.grad) return (t.prog = 100);
    const sp = nUsd('solana');
    if (t.lp === 'pump' && t.mc > 0 && sp > 0) t.prog = T.curveFromMc(t.mc / sp)?.progress ?? null;
    return t.prog;
  }
  engine.trenches.onPump((msg) => {
    const type = String(msg.txType || '').toLowerCase();
    const sp = nUsd('solana');
    if (type === 'create') {
      const t = S.tk.get(msg.mint) || { m: msg.mint, seen: Date.now() };
      const vt = num(msg.vTokensInBondingCurve);
      Object.assign(t, {
        n: t.n || msg.name,
        s: t.s || msg.symbol,
        dev: t.dev || msg.traderPublicKey,
        lp: msg.pool === 'bonk' || msg.pool === 'launchlab' ? 'bonk' : 'pump',
        ca: t.ca || Date.now(),
        mc: sp > 0 && num(msg.marketCapSol) ? num(msg.marketCapSol) * sp : t.mc,
        prog: vt ? Math.max(0, ((T.PUMP.vTok0 - vt) / T.PUMP.realTok) * 100) : t.prog,
        h: t.h || 1,
        initBuy: num(msg.solAmount),
        upd: t.upd || 0,
      });
      S.tk.set(msg.mint, t);
      if (S.col === 'new') S.dirty = true;
    } else if (type.includes('migrat')) {
      const t = S.tk.get(msg.mint) || { m: msg.mint, seen: Date.now(), upd: 0 };
      t.lp ||= msg.pool === 'bonk' || msg.pool === 'launchlab' ? 'bonk' : 'pump';
      t.grad = true;
      t.ga = t.ga || Date.now();
      t.prog = 100;
      S.tk.set(msg.mint, t);
      S.dirty = true;
    }
  });
  function trimFeed() {
    if (S.tk.size < 1500) return;
    const keep = new Set([...myPos().map((p) => p.mint), S.open].filter(Boolean));
    const arr = [...S.tk.values()].sort((a, b) => (b.upd || b.seen) - (a.upd || a.seen));
    for (const t of arr.slice(900)) if (!keep.has(t.m)) S.tk.delete(t.m);
  }
  async function poll(name, ms, fn) {
    if (Date.now() - (S.pollAt[name] || 0) < ms) return;
    S.pollAt[name] = Date.now();
    try {
      await fn();
      S.err = '';
    } catch (e) {
      S.err = e?.message || 'brak połączenia';
    }
  }
  async function solFeed(vis) {
    const jup = engine.trenches.jup;
    if (vis) {
      await poll('recent', 6_000, async () => (await jup('tokens/v2/recent?limit=100')).forEach(fromJup));
      await poll('lists', 30_000, async () => {
        S.listTurn = (S.listTurn || 0) + 1;
        const path = S.listTurn % 2 ? 'tokens/v2/toptraded/5m?limit=100' : 'tokens/v2/toptrending/5m?limit=100';
        (await jup(path)).forEach((j) => (j.launchpad || S.tk.has(j.id) ? fromJup(j) : null));
      });
    }
    // Stats for what is on screen and every held token (up to 100 per call).
    await poll('search', vis ? 6_000 : 15_000, async () => {
      const want = new Set();
      for (const p of myPos()) if (p.chain === 'solana') want.add(p.mint);
      if (S.open && isSol()) want.add(S.open);
      if (vis) {
        // What each column would hold before filters: hidden tokens keep getting fresh data,
        // so they reappear once they meet the limits.
        const shown = columns().flatMap(([k]) => colList(k, { raw: true }).slice(0, 30));
        shown.sort((a, b) => (a.upd || 0) - (b.upd || 0));
        for (const t of shown) if (want.size < 100) want.add(t.m);
      }
      if (!want.size) return;
      const list = await jup(`tokens/v2/search?query=${[...want].join(',')}`, true);
      for (const j of list || []) {
        fromJup(j);
        const t = S.tk.get(j.id);
        if (t?.p) S.px[T.posKey('solana', j.id)] = { p: t.p, mc: t.mc, lq: t.lq, at: Date.now() };
      }
    });
    trimFeed();
  }
  /** EVM: the radar's rows of the network on screen. */
  function evmRows() {
    try {
      // Radar rows know which socials exist (sf), not their links (soc stays for links only).
      return (engine.trenches.list('hype', 200) || []).map((r) => ({ m: r.m, n: r.n, s: r.s, i: r.i, ca: r.ca, mc: r.mc, lq: r.lq, p: r.p, h: r.h, t10: r.t10, dv: r.dv, v5: r.v5, v1: r.v1, b5: r.b5, s5: r.s5, c5: r.c5, c1: r.c1, grad: true, soc: {}, sf: { tw: !!r.tw, tg: !!r.tg, web: !!r.web }, hype: r.hs ?? r.score ?? 0 }));
    } catch {
      return [];
    }
  }

  // ---------- columns ----------
  const columns = () => (isSol() ? COLS.solana : COLS.evm);
  // ---------- filters (per column, like Axiom's Pulse) ----------
  const fKey = (k) => `${isSol() ? 'sol' : 'evm'}:${k}`;
  // Settings of older versions: the four quick toggles become the same filters on every column.
  if (!set.fc) {
    const o = set.f || {};
    const base = { ...(o.soc ? { any: true } : {}), ...(o.t10 ? { t10: [null, 30] } : {}), ...(o.dev ? { dv: [null, 10] } : {}), ...(o.h ? { h: [50, null] } : {}) };
    set.fc = {};
    for (const g of ['sol', 'evm']) for (const [k] of COLS[g === 'sol' ? 'solana' : 'evm']) set.fc[`${g}:${k}`] = structuredClone(base);
    delete set.f;
  }
  const colF = (k) => (set.fc[fKey(k)] ||= {});
  const RANGES = [...AUDIT, ...METRICS];
  function activeCount(f) {
    let n = 0;
    for (const [k] of RANGES) if (f[k] && (f[k][0] != null || f[k][1] != null)) n++;
    if (f.lp?.length) n++;
    if (f.inc) n++;
    if (f.exc) n++;
    for (const k of ['tw', 'tg', 'web', 'any']) if (f[k]) n++;
    return n;
  }
  const words = (v) => String(v || '').toLowerCase().split(',').map((w) => w.trim()).filter(Boolean);
  function passes(t, f, now = Date.now()) {
    if (!f) return true;
    if (f.lp?.length) {
      const lp = t.lp && KNOWN_LP.has(t.lp) ? t.lp : 'other';
      if (!f.lp.includes(lp)) return false;
    }
    const text = `${t.s || ''} ${t.n || ''}`.toLowerCase();
    const inc = words(f.inc);
    if (inc.length && !inc.some((w) => text.includes(w))) return false;
    if (words(f.exc).some((w) => text.includes(w))) return false;
    const val = {
      t10: t.t10, dv: t.dv, h: t.h, org: t.org, dm: t.dm, dmg: t.dmg,
      // As the card shows it: since migration on Migrated, since launch before.
      age: (t.grad && t.ga) || t.ca ? (now - ((t.grad && t.ga) || t.ca)) / 60_000 : null,
      prog: t.grad ? 100 : t.prog,
      mc: t.mc, lq: t.lq, v5: t.v5,
      tx: t.b5 != null || t.s5 != null ? (t.b5 || 0) + (t.s5 || 0) : null,
      b5: t.b5, tr5: t.tr5,
    };
    for (const [k, , mul] of RANGES) {
      const r = f[k];
      if (!r) continue;
      const v = val[k];
      // Not known yet (very fresh token): a "max" limit lets it through, a "min" limit doesn't.
      if (r[0] != null && !(v != null && v >= r[0] * mul)) return false;
      if (r[1] != null && v != null && v > r[1] * mul) return false;
    }
    const soc = t.sf || t.soc || {};
    if (f.tw && !soc.tw) return false;
    if (f.tg && !soc.tg) return false;
    if (f.web && !soc.web) return false;
    if (f.any && !(soc.tw || soc.tg || soc.web)) return false;
    return true;
  }
  /** Tokens of a column, filtered (raw: before filters). */
  function colList(k, { raw = false } = {}) {
    const now = Date.now();
    const f = raw ? null : colF(k);
    const ok = (t) => passes(t, f, now);
    if (!isSol()) {
      const rows = evmRows().filter(ok);
      if (k === 'new') return rows.filter((r) => r.ca).sort((a, b) => b.ca - a.ca).slice(0, 50);
      if (k === 'surge') return rows.filter((r) => r.v5 > 0).sort((a, b) => (b.v5 || 0) - (a.v5 || 0)).slice(0, 50);
      return rows.slice(0, 50);
    }
    const all = [...S.tk.values()].filter(ok);
    if (k === 'new') return all.filter((t) => !t.grad && t.ca && now - t.ca < 60 * 60_000).sort((a, b) => b.ca - a.ca).slice(0, 60);
    if (k === 'stretch') return all.filter((t) => !t.grad && t.prog >= 40 && now - (t.upd || t.seen) < 30 * 60_000).sort((a, b) => b.prog - a.prog).slice(0, 50);
    return all.filter((t) => t.grad && t.ga && now - t.ga < 24 * 3600_000).sort((a, b) => b.ga - a.ga).slice(0, 50);
  }

  // ---------- trading ----------
  const tokenData = (mint) => {
    if (isSol()) return S.tk.get(mint) || null;
    return evmRows().find((r) => r.m === mint) || null;
  };
  /** Best current price data of a token (live chart price beats the list's). */
  function priceData(mint) {
    const t = tokenData(mint);
    const live = S.open === mint && S.live && Date.now() - S.live.at < 5_000 ? S.live : null;
    const px = S.px[T.posKey(C(), mint)];
    const p = live?.p || (px && px.at > (t?.upd || 0) ? px.p : t?.p) || px?.p || null;
    const mc = live?.mc || t?.mc || px?.mc || null;
    const lq = t?.lq || px?.lq || null;
    return { t, p, mc, lq };
  }
  function poolFor(mint) {
    const { t, p, mc, lq } = priceData(mint);
    const u = nUsd();
    if (!(u > 0) || !(p > 0)) return null;
    const curve = isSol() && t?.lp === 'pump' && !t?.grad;
    return T.poolOf(curve ? { curve: true, mcNative: (mc || p * 1e9) / u } : { liqUsd: lq, priceNative: p / u, nativeUsd: u });
  }
  const netFee = () => (isSol() ? Number(set.prio) + Number(set.tip) + T.TFEES.solBase : (GAS_USD[C()] || 0.1) / (nUsd() || 1));
  const failFee = () => (isSol() ? Number(set.prio) + T.TFEES.solBase : netFee() * 0.4);
  function metaOf(mint) {
    const t = tokenData(mint) || {};
    return { sym: t.s || mint.slice(0, 4), name: t.n || '', icon: t.i || '' };
  }
  function buy(mint, amount) {
    sync();
    const c = C();
    const fee = netFee();
    if (!(amount > 0)) return toast('Wpisz kwotę');
    if ((W.cash[c] || 0) < amount + fee - 1e-12) return toast(`Za mało ${sym()} w wallecie Trenches (${nat(W.cash[c] || 0, sym())}) — doładuj: 👛 u góry`);
    const pool = poolFor(mint);
    if (!pool) return toast('Brak ceny / płynności — spróbuj za chwilę');
    const q = T.quoteBuy(pool, amount);
    if (!q) return toast('Nie da się kupić — pula pusta');
    if (q.impact > Number(set.slip)) {
      // On chain the swap reverts: the priority fee is paid anyway.
      W.cash[c] = (W.cash[c] || 0) - failFee();
      W.stats.fees += failFee();
      W.tx.unshift({ type: 'fail', t: Date.now(), chain: c, mint, sym: metaOf(mint).sym, fee: failFee() });
      save();
      return toast(`❌ Transakcja odrzucona: wpływ na cenę ${q.impact.toFixed(1)}% > slippage ${set.slip}% · opłata ${nat(failFee(), sym())}`);
    }
    const { mc } = priceData(mint);
    bookBuy(c, mint, amount, fee, q, mc);
  }
  function bookBuy(c, mint, amount, fee, q, mc) {
    const meta = metaOf(mint);
    T.bookBuy(W, { chain: c, mint, meta, amount, network: fee, q, mcNow: mc, t: Date.now() });
    W.tx.unshift({ type: 'buy', t: Date.now(), chain: c, mint, sym: meta.sym, amount, tokens: q.tokens, fee: q.platformFee + q.venueFee + fee });
    save();
    toast(`🟢 Kupiono ${tokAmt(q.tokens)} ${meta.sym} za ${nat(amount, sym())} · wpływ ${q.impact.toFixed(1)}%`);
  }
  function sell(mint, frac, reason = 'trade') {
    sync();
    const c = C();
    const p = W.pos[T.posKey(c, mint)];
    if (!p) return;
    const tokens = frac >= 1 ? p.tokens : p.tokens * frac;
    const pool = poolFor(mint);
    if (!pool) return toast('Brak ceny / płynności — nie da się sprzedać (rug?)');
    const q = T.quoteSell(pool, tokens);
    if (!q || q.out <= netFee()) return toast('Sprzedaż nie pokryje opłat — brak płynności');
    if (reason === 'trade' && q.impact > Number(set.slip)) {
      W.cash[c] = (W.cash[c] || 0) - failFee();
      W.stats.fees += failFee();
      save();
      return toast(`❌ Transakcja odrzucona: wpływ na cenę ${q.impact.toFixed(1)}% > slippage ${set.slip}%`);
    }
    const { mc } = priceData(mint);
    q.mcAt = mc;
    const r = T.bookSell(W, { chain: c, mint, tokens, network: netFee(), q, t: Date.now(), reason });
    W.tx.unshift({ type: 'sell', t: Date.now(), chain: c, mint, sym: p.sym, amount: q.out - netFee(), tokens, pnl: r?.pnl, fee: q.platformFee + q.venueFee + netFee(), reason });
    save();
    const tag = reason === 'tp' ? '🎯 TP' : reason === 'sl' ? '🛑 SL' : '🔴 Sprzedano';
    toast(`${tag} ${Math.round(Math.min(1, frac) * 100)}% ${p.sym} → ${nat(q.out - netFee(), sym())}${r?.closed ? ` · wynik ${nat(r.total, sym(), true)}` : ''}`);
  }
  /** Sells just enough to get the money put in back (Axiom's "sell initials"). */
  function sellInit(mint) {
    const p = W.pos[T.posKey(C(), mint)];
    const pool = poolFor(mint);
    if (!p || !pool) return;
    const need = p.spent - p.got;
    if (need <= 0) return toast('Wkład już odzyskany');
    const all = T.quoteSell(pool, p.tokens);
    if (!all || all.out - netFee() <= need) return sell(mint, 1);
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const q = T.quoteSell(pool, p.tokens * mid);
      if (q && q.out - netFee() >= need) hi = mid;
      else lo = mid;
    }
    sell(mint, hi);
  }
  /** TP / SL on PnL %: checked whenever a held token's price updates. */
  function checkExits() {
    for (const p of myPos()) {
      if (p.chain !== C() || (p.tp == null && p.sl == null)) continue;
      const { p: price } = priceData(p.mint);
      const u = nUsd();
      if (!(price > 0) || !(u > 0)) continue;
      const v = T.posValue(p, price / u);
      if (v.pct == null) continue;
      if (p.tp != null && v.pct >= p.tp) sell(p.mint, 1, 'tp');
      else if (p.sl != null && v.pct <= -Math.abs(p.sl)) sell(p.mint, 1, 'sl');
    }
  }

  // ---------- token page: chart, live price, trades ----------
  async function openToken(mint) {
    S.open = mint;
    S.live = null;
    S.trades = null;
    S.candles = null;
    S.ticks = [];
    S.draft = {};
    S.dirty = true;
    render();
    $('#trenchSheet').scrollTop = 0;
    try {
      await engine.detail(mint);
    } catch {
      /* data may still come */
    }
    loadCandles();
    loadTrades();
  }
  async function loadCandles() {
    const mint = S.open;
    const tf = S.tf;
    if (!mint) return;
    if (SUB_TF.has(tf)) {
      // Second candles: every trade's price plus the live price sampled each second.
      // Trades come newest first: oldest first, so the last trade of a second closes its candle.
      const pts = [...(S.trades?.list || [])].reverse().filter((x) => x.price > 0).map((x) => ({ t: x.t, p: x.price, v: x.usd }));
      S.candles = { key: `${mint}|${tf}`, list: T.tickCandles(pts.concat(S.ticks), TF_MS[tf]), at: Date.now(), sub: true };
      return drawChart();
    }
    try {
      const list = await engine.candles(mint, tf);
      if (S.open !== mint || S.tf !== tf) return;
      S.candles = { key: `${mint}|${tf}`, list: list || [], at: Date.now() };
    } catch {
      if (S.open !== mint || S.tf !== tf) return; // switched meanwhile: not this chart's result
      S.candles = { key: `${mint}|${tf}`, list: [], at: Date.now() - 40_000, err: true };
    }
    drawChart();
  }
  async function loadTrades() {
    const mint = S.open;
    if (!mint) return;
    try {
      const list = await engine.trades(mint);
      if (S.open === mint) S.trades = { list: list || [], at: Date.now() };
    } catch {
      if (S.open === mint) S.trades = { list: S.trades?.list || [], at: Date.now() - 15_000 };
    }
    S.dirty = true;
    if (S.open === mint && SUB_TF.has(S.tf)) loadCandles(); // new trades into the second candles
  }
  async function liveTick() {
    const mint = S.open;
    if (!mint || S.liveBusy) return;
    S.liveBusy = true;
    try {
      const l = await engine.live(mint);
      if (S.open === mint && l?.p > 0) {
        S.live = { p: l.p, mc: l.mc, at: Date.now() };
        S.ticks.push({ t: S.live.at, p: l.p });
        if (S.ticks.length > 7200) S.ticks.splice(0, S.ticks.length - 7200);
        S.px[T.posKey(C(), mint)] = { ...(S.px[T.posKey(C(), mint)] || {}), p: l.p, mc: l.mc, at: Date.now() };
        applyLive();
      }
    } catch {
      /* next second */
    } finally {
      S.liveBusy = false;
    }
  }
  function mcK() {
    const { p, mc } = priceData(S.open);
    return p > 0 && mc > 0 ? mc / p : 0;
  }
  function applyLive() {
    const ch = S.chart;
    const c = S.candles;
    if (!ch || !c || ch.key !== c.key || !S.live) return;
    const K = ch.K || 1;
    const ms = TF_MS[S.tf];
    const v = S.live.p * K;
    const tsec = Math.floor(Math.floor(Date.now() / ms) * ms / 1000);
    const last = ch.last;
    try {
      if (last && last.time === tsec) {
        last.close = v;
        last.high = Math.max(last.high, v);
        last.low = Math.min(last.low, v);
        ch.candle.update({ ...last });
      } else if (!last || tsec > last.time) {
        ch.last = { time: tsec, open: last?.close ?? v, high: Math.max(v, last?.close ?? v), low: Math.min(v, last?.close ?? v), close: v };
        ch.candle.update({ ...ch.last });
      }
    } catch {
      /* out of order */
    }
  }
  async function drawChart() {
    const box = $('#tcChart');
    if (!box || !S.open) return;
    const msg = $('#tcMsg');
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
        priceFormat: { type: 'custom', minMove: 1e-9, formatter: (v) => (v > 0 ? usd(v) : '') },
      });
      candle.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 } });
      S.chart = { chart, candle, el: box, key: '', K: 1, last: null, lines: [], linesKey: '' };
    }
    const ch = S.chart;
    const c = S.candles;
    const key = `${S.open}|${S.tf}`;
    if (ch.secs !== SUB_TF.has(S.tf)) {
      ch.secs = SUB_TF.has(S.tf);
      ch.chart.timeScale().applyOptions({ secondsVisible: ch.secs });
    }
    if (!c || c.key !== key || !c.list.length) {
      msg.hidden = false;
      msg.textContent = !c ? 'Ładowanie świec…' : c.err ? 'Limit darmowego API — ponawiam…' : c.sub ? 'Zbieram transakcje i cenę na żywo…' : 'Świece pojawią się za chwilę (bardzo nowy token) — cena na żywo poniżej';
      if (ch.key && ch.key !== key) {
        ch.candle.setData([]);
        ch.key = '';
        ch.last = null;
      }
      if (!c?.list.length && S.live && ch.key !== key) {
        ch.key = key;
        ch.K = mcK() || 1;
        ch.last = null;
        msg.hidden = true;
        applyLive();
      }
    } else if (ch.key !== key || ch.dataAt !== c.at) {
      msg.hidden = true;
      ch.K = mcK() || 1;
      // Candles are [ms, o, h, l, c, vol] in $ per token: shown as market cap.
      const bars = c.list.map((k) => ({ time: Math.floor(k[0] / 1000), open: k[1] * ch.K, high: k[2] * ch.K, low: k[3] * ch.K, close: k[4] * ch.K }));
      ch.candle.setData(bars);
      ch.last = bars.length ? { ...bars[bars.length - 1] } : null;
      const show = c.sub ? 120 : 80;
      if (ch.key !== key) ch.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - show), to: bars.length + 3 });
      ch.key = key;
      ch.dataAt = c.at;
    }
    // My entry market cap as a line.
    const p = W.pos[T.posKey(C(), S.open)];
    const lk = p?.entryMc ? String(Math.round(p.entryMc)) : '';
    if (lk !== ch.linesKey) {
      ch.linesKey = lk;
      for (const l of ch.lines) ch.candle.removePriceLine(l);
      ch.lines = p?.entryMc ? [ch.candle.createPriceLine({ price: p.entryMc, color: '#52a8ff', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'B' })] : [];
    }
  }

  // ---------- UI ----------
  const put = (el, html) => {
    if (!el || el.dataset.html === html) return;
    if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    el.dataset.html = html;
    setHtml(el, html); // keeps the icons that are still loading
  };
  const icon = (t, size = 44) => {
    const letter = esc((t.s || '?').slice(0, 1).toUpperCase());
    return `<span class="tr-ic" style="width:${size}px;height:${size}px">${iconImg(t.i, size, { lazy: size < 40 || !S.open })}<b>${letter}</b></span>`;
  };
  const SOC = { tw: '𝕏', tg: '✈︎', web: '🌐' };
  function cardHtml(t, now) {
    const prog = t.grad ? null : t.prog;
    const pc = prog == null ? '' : prog >= 85 ? 'hot' : prog >= 50 ? 'mid' : '';
    const held = W.pos[T.posKey(C(), t.m)];
    const chips = [];
    if (t.t10 != null) chips.push(`<span class="chip ${t.t10 > 30 ? 'down' : t.t10 > 20 ? 'warn' : 'up'}" title="Top 10 holderów">T10 ${Math.round(t.t10)}%</span>`);
    if (t.dv != null) chips.push(`<span class="chip ${t.dv > 10 ? 'down' : t.dv > 3 ? 'warn' : 'up'}" title="Dev trzyma">DEV ${t.dv < 0.1 ? 0 : t.dv.toFixed(t.dv < 10 ? 1 : 0)}%</span>`);
    if (t.dm != null) chips.push(`<span class="chip ${t.dm >= 5 && !(t.dmg > 0) ? 'down' : t.dmg > 0 ? 'up' : ''}" title="Tokeny deva / zmigrowane">👨‍🍳 ${t.dm}${t.dmg != null ? `/${t.dmg}` : ''}</span>`);
    for (const k of ['tw', 'tg', 'web']) if (t.soc?.[k] || t.sf?.[k]) chips.push(`<span class="chip soc">${SOC[k]}</span>`);
    return `<div class="tr-card${held ? ' held' : ''}" data-tr-open="${esc(t.m)}">
      <div class="tr-left">${icon(t)}${prog != null ? `<i class="tr-prog ${pc}"><i style="width:${Math.max(3, Math.min(100, prog)).toFixed(0)}%"></i></i>` : ''}</div>
      <div class="tr-mid">
        <div class="tr-name"><b>${esc(t.s || '?')}</b> <span>${esc(t.n || '')}</span></div>
        <div class="tr-line"><span class="tr-age">${age(t.grad && t.ga ? t.ga : t.ca, now)}</span>${t.lp ? `<span class="tr-lp ${esc(t.lp)}">${esc(t.lp)}</span>` : ''}<span>👥 ${t.h ?? '—'}</span><span class="${t.b5 >= t.s5 ? 'up' : 'down'}">${t.b5 || 0}/${t.s5 || 0}</span>${prog != null ? `<span class="tr-pp ${pc}">${prog.toFixed(0)}%</span>` : ''}</div>
        <div class="tr-chips">${chips.join('')}</div>
      </div>
      <div class="tr-right">
        <div class="tr-mc"><small>MC</small> <b>${usd(t.mc)}</b></div>
        <div class="tr-v"><small>V</small> ${usd(t.v5 || t.v1)}</div>
        <button class="tr-buy" data-tr-quick="${esc(t.m)}">⚡ ${quick()}</button>
      </div>
    </div>`;
  }
  function headHtml() {
    const c = C();
    const u = nUsd();
    const cash = W.cash[c] || 0;
    return `<div class="tr-top">
      <div class="tr-chains">${chains.map((x) => `<button data-tr-chain="${esc(x.id)}" class="${x.id === c ? 'on' : ''}">${esc(SHORT[x.id] || x.native || x.id)}</button>`).join('')}</div>
      <button class="tr-bal" data-tr-wallet>👛 ${nat(cash, sym())}<small>${u ? usd(cash * u) : ''}</small></button>
    </div>
    <div class="tr-quick">
      <span>⚡ Szybkie kupno</span>
      ${presets().map((v) => `<button data-tr-qset="${v}" class="${v === quick() ? 'on' : ''}">${v}</button>`).join('')}
      <button data-tr-settings class="${S.settings ? 'on' : ''}">⚙️</button>
    </div>`;
  }
  function settingsHtml() {
    if (!S.settings) return '';
    return `<div class="card tr-set">
      <h3>Ustawienia <small>jak w Axiom</small></h3>
      <label class="pf-field"><span>Slippage %</span><input data-set="slip" type="number" inputmode="decimal" value="${esc(set.slip)}" /></label>
      ${isSol() ? `<label class="pf-field"><span>Priority fee (SOL)</span><input data-set="prio" type="number" inputmode="decimal" value="${esc(set.prio)}" /></label>
      <label class="pf-field"><span>Tip / bribe (SOL)</span><input data-set="tip" type="number" inputmode="decimal" value="${esc(set.tip)}" /></label>` : `<p class="note">Gas ≈ ${usd(GAS_USD[C()] || 0.1)} za transakcję.</p>`}
      <label class="pf-field"><span>Presety kupna (${esc(sym())})</span><input data-set="presets" type="text" inputmode="decimal" value="${esc(presets().join(' '))}" /></label>
      <p class="note">Każda transakcja: 1% opłaty platformy + opłata puli (krzywa pump.fun 1,25%, AMM ~0,25%) + sieć${isSol() ? ' (priority + tip)' : ' (gas)'}. Gdy wpływ na cenę przekroczy slippage, transakcja się nie wykona, a opłata priority przepada — jak na prawdziwym łańcuchu.</p>
    </div>`;
  }
  function filtersHtml() {
    const f = colF(S.col);
    const n = activeCount(f);
    const colName = (columns().find(([k]) => k === S.col) || [])[1] || '';
    const sum = [];
    for (const [k, label, mul] of RANGES) {
      const r = f[k];
      if (!r || (r[0] == null && r[1] == null)) continue;
      const pctUnit = / %$/.test(label);
      const name = label.replace(/ \(.*\)$/, '').replace(/ %$/, '');
      const u = mul === 1000 ? 'k$' : k === 'age' ? ' min' : pctUnit ? '%' : '';
      sum.push(`${name} ${r[0] != null ? `≥${r[0]}${u}` : ''}${r[0] != null && r[1] != null ? ' ' : ''}${r[1] != null ? `≤${r[1]}${u}` : ''}`);
    }
    if (f.lp?.length) sum.push(f.lp.map((x) => (PROTOCOLS.find(([k]) => k === x) || [x, x])[1]).join('/'));
    if (f.inc) sum.push(`+${f.inc}`);
    if (f.exc) sum.push(`−${f.exc}`);
    for (const [k, l] of [['tw', '𝕏'], ['tg', 'TG'], ['web', 'WWW'], ['any', 'Socials']]) if (f[k]) sum.push(l);
    const bar = `<div class="tr-fbar"><button data-tr-fopen class="${S.fopen ? 'on' : ''}">🎚️ Filtry${n ? ` <b>${n}</b>` : ''}</button>${n ? '<button data-tr-fclear>Wyczyść</button>' : ''}<span class="tr-fsum">${sum.map((x) => `<i>${esc(x)}</i>`).join('')}</span></div>`;
    if (!S.fopen) return bar;
    const range = ([k, label, , ends]) => {
      const r = f[k] || [null, null];
      const inp = (i, ph) => `<input data-tr-range="${k}|${i}" type="number" inputmode="decimal" step="any" placeholder="${ph}" value="${r[i] ?? ''}" />`;
      return `<div class="tr-frow"><span>${esc(label)}</span>${ends === 'x' ? '<i></i>' : inp(0, 'min')}${ends === 'n' ? '<i></i>' : inp(1, 'max')}</div>`;
    };
    const chip = (attr, on, label) => `<button ${attr} class="${on ? 'active' : ''}">${label}</button>`;
    const sol = isSol();
    return `${bar}<div class="card tr-fpanel">
      <div class="tr-fhead"><b>Filtry: ${esc(colName)}</b><button data-tr-fall>Kopiuj do wszystkich kolumn</button></div>
      ${sol ? `<h4>Protokoły</h4><div class="chips">${PROTOCOLS.map(([k, l]) => chip(`data-tr-lp="${k}"`, f.lp?.includes(k), l)).join('')}</div>` : ''}
      <h4>Słowa kluczowe <small>nazwa lub ticker, po przecinku</small></h4>
      <div class="tr-kw"><label class="pf-field"><span>Szukaj</span><input data-tr-kw="inc" type="text" autocapitalize="off" autocomplete="off" placeholder="np. cat, ai" value="${esc(f.inc || '')}" /></label>
        <label class="pf-field"><span>Wyklucz</span><input data-tr-kw="exc" type="text" autocapitalize="off" autocomplete="off" placeholder="np. test" value="${esc(f.exc || '')}" /></label></div>
      <h4>Audyt</h4>${AUDIT.filter(([k]) => sol || !['dm', 'dmg', 'org', 'prog'].includes(k)).map(range).join('')}
      <h4>Metryki</h4>${METRICS.filter(([k]) => sol || k !== 'tr5').map(range).join('')}
      <h4>Socials</h4><div class="chips">${chip('data-tr-soc="tw"', f.tw, '𝕏 Twitter')}${chip('data-tr-soc="tg"', f.tg, 'Telegram')}${chip('data-tr-soc="web"', f.web, 'Strona')}${chip('data-tr-soc="any"', f.any, 'Min. jeden')}</div>
      <p class="note">Puste pole = bez limitu. Gdy danych jeszcze nie ma (bardzo świeży token), limit „max” go przepuszcza, a „min” ukrywa. Snipers / insiders / bundles nie są dostępne w darmowych danych.</p>
    </div>`;
  }
  function tabsHtml() {
    const cols = columns();
    if (!cols.some(([k]) => k === S.col)) S.col = cols[0][0];
    return `<div class="pf-seg tr-tabs">${cols.map(([k, l]) => `<button data-tr-col="${k}" class="${k === S.col ? 'on' : ''}">${l}<small>${colList(k).length}</small></button>`).join('')}</div>`;
  }
  function listHtml() {
    const cols = columns();
    if (!cols.some(([k]) => k === S.col)) S.col = cols[0][0];
    const now = Date.now();
    const list = colList(S.col);
    const empty = isSol()
      ? `<div class="empty"><b>${S.err ? 'Brak połączenia z Jupiterem' : 'Ładuję tokeny…'}</b>${S.err ? esc(S.err) + ' — ponawiam.' : 'Nowe launche pump.fun pojawiają się co kilka sekund.'}</div>`
      : '<div class="empty"><b>Brak tokenów</b>Dane z radaru tej sieci ładują się.</div>';
    if (!list.length && activeCount(colF(S.col)) && !S.err && colList(S.col, { raw: true }).length) return '<div class="empty"><b>Filtry ukrywają wszystkie tokeny</b>Poluzuj filtry tej kolumny albo „Wyczyść”.</div>';
    return list.length ? `<div class="tr-list">${list.map((t) => cardHtml(t, now)).join('')}</div>` : empty;
  }
  function posListHtml() {
    const u = nUsd();
    const list = myPos().filter((p) => p.chain === C());
    if (!list.length) return '';
    return `<h3 class="pos-h">Moje pozycje (${list.length})</h3><div class="tr-mypos">${list
      .map((p) => {
        const { p: price } = priceData(p.mint);
        const v = T.posValue(p, price > 0 && u > 0 ? price / u : null);
        return `<button data-tr-open="${esc(p.mint)}"><span>${icon({ i: p.icon, s: p.sym }, 28)} <b>${esc(p.sym)}</b></span><span>${nat(v.value, sym())}</span><span class="${cls(v.pnl)}">${nat(v.pnl, sym(), true)} <small>${pct(v.pct)}</small></span></button>`;
      })
      .join('')}</div>`;
  }
  function tokenHtml() {
    const mint = S.open;
    const { t, p, mc, lq } = priceData(mint);
    const u = nUsd();
    const pos = W.pos[T.posKey(C(), mint)];
    const v = pos ? T.posValue(pos, p > 0 && u > 0 ? p / u : null) : null;
    const meta = t || metaOf(mint);
    const curve = isSol() && t?.lp === 'pump' && !t?.grad;
    const prog = curve ? progressOf(t) : null;
    const link = (href, label) => `<a href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`;
    const ex = cfg().explorer ? cfg().explorer(mint) : null;
    return `<div class="tr-head">
        <button class="tr-back" data-tr-back>‹</button>
        ${icon({ i: t?.i || pos?.icon, s: t?.s || pos?.sym }, 40)}
        <div class="tr-hn"><b>${esc(t?.s || pos?.sym || mint.slice(0, 6))}</b><small>${esc(t?.n || pos?.name || '')} · ${age(t?.ca)}</small></div>
        <div class="tr-hmc"><b>${usd(mc)}</b><small class="${cls(t?.c5)}">5m ${pct(t?.c5)}</small></div>
      </div>
      <div class="tr-links">
        <button data-tr-copy="${esc(mint)}">📋 ${esc(mint.slice(0, 4))}…${esc(mint.slice(-4))}</button>
        ${isSol() ? link(`https://pump.fun/coin/${mint}`, 'pump.fun') : ''}${link(`https://dexscreener.com/${cfg().dex || C()}/${mint}`, 'DexScreener')}${ex ? link(ex, cfg().explorerName || 'Explorer') : ''}
        ${t?.soc?.tw ? link(t.soc.tw, '𝕏') : ''}${t?.soc?.tg ? link(t.soc.tg, 'TG') : ''}${t?.soc?.web ? link(t.soc.web, 'WWW') : ''}
      </div>
      ${curve && prog != null ? `<div class="tr-curve"><span>Krzywa pump.fun</span><i class="tr-prog big ${prog >= 85 ? 'hot' : prog >= 50 ? 'mid' : ''}"><i style="width:${prog.toFixed(1)}%"></i></i><b>${prog.toFixed(1)}%</b></div>` : t?.grad ? '<div class="tr-curve"><span>🎓 Po migracji — handel w puli AMM</span></div>' : ''}
      <div class="tr-stats">
        <div><span>Cena</span><b>${fpx(p)}</b></div>
        <div><span>Płynność</span><b>${usd(lq)}</b></div>
        <div><span>Holderzy</span><b>${t?.h ?? '—'}</b></div>
        <div><span>Top 10</span><b class="${t?.t10 > 30 ? 'down' : ''}">${t?.t10 != null ? `${Math.round(t.t10)}%` : '—'}</b></div>
        <div><span>Dev</span><b class="${t?.dv > 10 ? 'down' : ''}">${t?.dv != null ? `${t.dv.toFixed(1)}%` : '—'}</b></div>
        <div><span>Tx 5m</span><b><span class="up">${t?.b5 ?? 0}</span>/<span class="down">${t?.s5 ?? 0}</span></b></div>
      </div>
      ${pos ? `<div class="card tr-pos">
        <div class="tr-pos-top"><span>Moja pozycja</span><b class="${cls(v?.pnl)}">${nat(v?.pnl, sym(), true)} <small>${pct(v?.pct)}</small></b></div>
        <div class="tr-pos-grid">
          <div><span>Wartość</span><b>${nat(v?.value, sym())}</b><small>${u && v?.value != null ? usd(v.value * u) : ''}</small></div>
          <div><span>Włożone</span><b>${nat(pos.spent, sym())}</b><small>sprzedane ${nat(pos.got, sym())}</small></div>
          <div><span>Tokeny</span><b>${tokAmt(pos.tokens)}</b><small>wejście MC ${usd(pos.entryMc)}</small></div>
        </div>
        <div class="tr-tpsl"><label class="pf-field"><span>TP +%</span><input data-tr-exit="tp" type="number" inputmode="decimal" placeholder="np. 100" value="${pos.tp ?? ''}" /></label><label class="pf-field"><span>SL −%</span><input data-tr-exit="sl" type="number" inputmode="decimal" placeholder="np. 40" value="${pos.sl ?? ''}" /></label></div>
      </div>` : ''}`;
  }
  function tradeBoxHtml() {
    const mint = S.open;
    const pos = W.pos[T.posKey(C(), mint)];
    const amt = Number(S.draft.amt) || quick();
    const pool = poolFor(mint);
    const q = pool ? T.quoteBuy(pool, amt) : null;
    return `<div class="card tr-trade">
      <div class="tr-row"><span>Kup</span><small>saldo ${nat(W.cash[C()] || 0, sym())}</small></div>
      <div class="tr-btns">${presets().map((v) => `<button class="b" data-tr-buy="${v}">${v} ${esc(sym())}</button>`).join('')}</div>
      <div class="tr-custom"><input id="trAmt" type="number" inputmode="decimal" step="any" placeholder="Inna kwota (${esc(sym())})" value="${esc(S.draft.amt || '')}" /><button class="b" data-tr-buyc>Kup</button></div>
      <p class="note tr-q">${q ? `≈ ${tokAmt(q.tokens)} tokenów · wpływ na cenę ${q.impact.toFixed(1)}% · opłaty ${nat(q.platformFee + q.venueFee + netFee(), sym())}` : 'Brak ceny / płynności'}</p>
      ${pos ? `<div class="tr-row"><span>Sprzedaj</span><small>${tokAmt(pos.tokens)} tokenów</small></div>
      <div class="tr-btns">${set.sells.map((v) => `<button class="s" data-tr-sell="${v}">${v}%</button>`).join('')}<button class="s" data-tr-init>Initials</button></div>` : ''}
    </div>`;
  }
  function tradesHtml() {
    const tr = S.trades?.list || [];
    const dev = tokenData(S.open)?.dev;
    if (!tr.length) return S.trades ? '<p class="note">Brak transakcji (albo limit darmowego API).</p>' : '<p class="note">Ładowanie transakcji…</p>';
    const now = Date.now();
    return `<h3 class="pos-h">Transakcje</h3><div class="tr-trades">${tr
      .slice(0, 30)
      .map((x) => `<div class="${x.side === 'buy' ? 'up' : 'down'}"><span>${x.side === 'buy' ? 'B' : 'S'}</span><span>${usd(x.usd)}</span><span class="muted">${esc(String(x.wallet || '').slice(0, 4))}…${dev && x.wallet === dev ? ' 👨‍🍳 DEV' : ''}</span><span class="muted">${age(x.t, now)}</span></div>`)
      .join('')}</div>`;
  }

  function render() {
    const body = $('#trenchBody');
    if (!body) return;
    const mode = S.open ? 'token' : 'list';
    if (body.dataset.mode !== mode) {
      body.dataset.mode = mode;
      body.innerHTML =
        mode === 'list'
          ? '<div id="trHead"></div><div id="trSet"></div><div id="trMy"></div><div id="trTabs"></div><div id="trFilt"></div><div id="trList"></div><p class="note">Dane na żywo: PumpPortal (launche, migracje) i Jupiter (MC, holderzy, top 10, dev). Wirtualne pieniądze — trening, nie porada inwestycyjna.</p>'
          : `<div id="trTok"></div><div class="card tr-chart"><div class="tf-row" id="trTf">${Object.keys(TF_MS).map((x) => `<button data-tr-tf="${x}">${x}</button>`).join('')}</div><div class="tr-chart-box" id="tcChart"><div class="lw-msg" id="tcMsg">Ładowanie świec…</div></div></div><div id="trTrade"></div><div id="trTrades"></div>`;
      S.chart = null;
    }
    if (mode === 'list') {
      put($('#trHead'), headHtml());
      put($('#trSet'), settingsHtml());
      put($('#trMy'), posListHtml());
      put($('#trTabs'), tabsHtml());
      put($('#trFilt'), filtersHtml());
      put($('#trList'), listHtml());
    } else {
      put($('#trTok'), tokenHtml());
      body.querySelectorAll('[data-tr-tf]').forEach((b) => b.classList.toggle('active', b.dataset.trTf === S.tf));
      put($('#trTrade'), tradeBoxHtml());
      put($('#trTrades'), tradesHtml());
      drawChart();
    }
  }

  // ---------- events ----------
  function onClick(e) {
    const el = e.target.closest('button, [data-tr-open], a');
    if (!el || el.tagName === 'A') return;
    const d = el.dataset;
    if (d.trQuick) {
      e.stopPropagation();
      buy(d.trQuick, quick());
    } else if (d.trOpen) return openToken(d.trOpen);
    else if (d.trBack !== undefined) {
      S.open = null;
      S.live = null;
    } else if (d.trCol) S.col = d.trCol;
    else if (d.trChain) {
      if (d.trChain !== C()) setChain(d.trChain);
      S.open = null;
    } else if (d.trWallet !== undefined) return nav?.('wallet');
    else if (d.trQset) {
      set.quick[C()] = Number(d.trQset);
      saveSet();
    } else if (d.trSettings !== undefined) S.settings = !S.settings;
    else if (d.trFopen !== undefined) S.fopen = !S.fopen;
    else if (d.trFclear !== undefined) {
      set.fc[fKey(S.col)] = {};
      saveSet();
    } else if (d.trFall !== undefined) {
      const f = colF(S.col);
      for (const [k] of columns()) set.fc[fKey(k)] = structuredClone(f);
      saveSet();
      toast('Filtry skopiowane do wszystkich kolumn');
    } else if (d.trLp) {
      const f = colF(S.col);
      const lp = new Set(f.lp || []);
      if (lp.has(d.trLp)) lp.delete(d.trLp);
      else lp.add(d.trLp);
      if (lp.size) f.lp = [...lp];
      else delete f.lp;
      saveSet();
    } else if (d.trSoc) {
      const f = colF(S.col);
      if (f[d.trSoc]) delete f[d.trSoc];
      else f[d.trSoc] = true;
      saveSet();
    } else if (d.trBuy) buy(S.open, Number(d.trBuy));
    else if (d.trBuyc !== undefined) {
      document.activeElement?.blur?.();
      buy(S.open, Number($('#trAmt')?.value));
    } else if (d.trSell) sell(S.open, Number(d.trSell) / 100);
    else if (d.trInit !== undefined) sellInit(S.open);
    else if (d.trTf) {
      S.tf = d.trTf;
      set.tf = S.tf;
      saveSet();
      S.candles = null;
      loadCandles();
    } else if (d.trCopy) {
      navigator.clipboard?.writeText(d.trCopy).then(() => toast('Skopiowano adres'), () => toast(d.trCopy));
      return;
    } else return;
    S.dirty = true;
    render();
  }
  function onChange(e) {
    const el = e.target;
    if (el.dataset.trRange) {
      const [k, i] = el.dataset.trRange.split('|');
      const f = colF(S.col);
      const r = f[k] || [null, null];
      const raw = String(el.value).trim().replace(',', '.');
      const v = raw === '' ? null : Number(raw);
      r[Number(i)] = Number.isFinite(v) ? v : null;
      if (r[0] == null && r[1] == null) delete f[k];
      else f[k] = r;
      saveSet();
      S.dirty = true;
      return;
    }
    if (el.dataset.trKw) {
      const f = colF(S.col);
      const v = String(el.value).trim().slice(0, 120);
      if (v) f[el.dataset.trKw] = v;
      else delete f[el.dataset.trKw];
      saveSet();
      S.dirty = true;
      return;
    }
    if (el.dataset.set) {
      const k = el.dataset.set;
      if (k === 'presets') {
        const vals = String(el.value).replace(/,/g, '.').split(/\s+/).map(Number).filter((v) => v > 0).slice(0, 4);
        if (vals.length) set.presets[C()] = vals;
      } else if (Number(el.value) >= 0) set[k] = Number(el.value);
      saveSet();
      S.dirty = true;
    } else if (el.dataset.trExit) {
      const p = W.pos[T.posKey(C(), S.open)];
      if (!p) return;
      const v = Number(el.value);
      p[el.dataset.trExit] = el.value === '' || !(v > 0) ? null : v;
      save();
      toast(el.value === '' ? 'Usunięto' : `${el.dataset.trExit.toUpperCase()} ustawione: ${el.dataset.trExit === 'tp' ? '+' : '−'}${v}%`);
    }
  }
  function onInput(e) {
    if (e.target.id === 'trAmt') {
      S.draft.amt = e.target.value;
      const q = $('.tr-q');
      const pool = poolFor(S.open);
      const amt = Number(e.target.value) || quick();
      const r = pool ? T.quoteBuy(pool, amt) : null;
      if (q) q.textContent = r ? `≈ ${tokAmt(r.tokens)} tokenów · wpływ na cenę ${r.impact.toFixed(1)}% · opłaty ${nat(r.platformFee + r.venueFee + netFee(), sym())}` : 'Brak ceny / płynności';
    }
  }

  // ---------- wallet (Wallet → Trenches) ----------
  function walletRender(body) {
    if (!body) return;
    sync();
    const c = C();
    const u = nUsd();
    if (!body.querySelector('#twCard') || body.dataset.chain !== c) {
      body.dataset.chain = c;
      body.innerHTML = `<div id="twCard"></div>
        <div class="card wallet-top"><h3>Doładuj wallet Trenches <small>DEMO · ${esc(cfg().name || c)}</small></h3>
          <div class="pos-form"><input id="twTopUp" type="number" inputmode="decimal" min="0" step="any" placeholder="Kwota w ${esc(sym())}" /><button data-tw="topup">⬇️ Doładuj</button></div>
          <div class="quick-amt">${(TOPUP[c] || TOPUP.solana).map((v) => `<button data-tw-amt="${v}">+${v} ${esc(sym())}</button>`).join('')}</div>
          <p class="note">Osobny wallet do Trenches, w ${esc(sym())} jak na Axiom / Padre — każda sieć ma swoje saldo. Wirtualne pieniądze.</p>
        </div><div id="twStats"></div><div id="twHist"></div>
        <div class="d-acts" style="margin-top:16px"><button data-tw="open">🔥 Otwórz Trenches</button><button data-tw="reset">♻️ Wyzeruj wallet Trenches</button></div>`;
    }
    const list = myPos().filter((p) => p.chain === c);
    let inPos = 0;
    let upnl = 0;
    for (const p of list) {
      const { p: price } = priceData(p.mint);
      const v = T.posValue(p, price > 0 && u > 0 ? price / u : null);
      inPos += v.value || 0;
      upnl += v.pnl || 0;
    }
    const cash = W.cash[c] || 0;
    const dep = W.deposits[c] || 0;
    const total = cash + inPos;
    const res = total - dep;
    const others = Object.keys(W.cash).filter((k) => k !== c && Math.abs(W.cash[k]) > 1e-9);
    put(
      $('#twCard', body),
      `<div class="wallet-card trench-card">
        <span>Saldo Trenches · ${esc(cfg().name || c)}</span><b>${nat(cash, sym())}</b><small class="muted">${u ? usd(cash * u) : ''}</small>
        <div class="wallet-sub"><div><span>W pozycjach</span><b>${nat(inPos, sym())}</b></div><div><span>Razem</span><b>${nat(total, sym())}</b></div>
          <div><span>Wynik</span><b class="${cls(res)}">${dep > 0 ? `${nat(res, sym(), true)} <small>${pct((res / dep) * 100)}</small>` : '—'}</b></div></div>
        ${others.length ? `<p class="note">Inne sieci: ${others.map((k) => `${esc(k)} ${(W.cash[k] || 0).toFixed(3)}`).join(' · ')}</p>` : ''}
      </div>`,
    );
    const closed = W.hist.filter((h) => h.chain === c);
    const wins = closed.filter((h) => h.pnl > 0).length;
    const realized = closed.reduce((a, h) => a + h.pnl, 0);
    put(
      $('#twStats', body),
      `<div class="pos-pnl">
        <div><span>Zamknięte</span><b>${closed.length}</b><small>${closed.length ? `${Math.round((wins / closed.length) * 100)}% zyskownych` : '—'}</small></div>
        <div><span>Zrealizowany</span><b class="${cls(realized)}">${nat(realized, sym(), true)}</b><small>otwarte: ${nat(upnl, sym(), true)}</small></div>
        <div><span>Opłaty</span><b>${nat(W.stats.fees, sym())}</b><small>wszystkie sieci</small></div>
      </div>`,
    );
    const tx = W.tx.filter((x) => x.chain === c || (!x.chain && x.type === 'reset')).slice(0, 30);
    const TXL = { deposit: ['⬇️', 'Doładowanie'], buy: ['🟢', 'Kupno'], sell: ['🔴', 'Sprzedaż'], fail: ['❌', 'Odrzucona tx'], reset: ['♻️', 'Reset'] };
    put(
      $('#twHist', body),
      `<h3 class="pos-h">Historia</h3><div class="pos-closed">${
        tx.length
          ? tx
              .map((x) => {
                const [ic, l] = TXL[x.type] || ['•', x.type];
                const right = x.type === 'deposit' ? `<b class="up">+${nat(x.amount, sym())}</b>` : x.type === 'buy' ? `<b class="down">−${nat(x.amount, sym())}</b>` : x.type === 'sell' ? `<b class="up">+${nat(x.amount, sym())}${x.pnl != null ? ` <small class="${cls(x.pnl)}">(${nat(x.pnl, sym(), true)})</small>` : ''}</b>` : x.type === 'fail' ? `<b class="down">−${nat(x.fee, sym())}</b>` : '<b></b>';
                return `<div><span>${ic} ${l}${x.sym ? ` <small>${esc(x.sym)}${x.reason && x.reason !== 'trade' ? ` · ${esc(x.reason.toUpperCase())}` : ''}</small>` : ''} <small>· ${age(x.t)}</small></span>${right}</div>`;
              })
              .join('')
          : '<div><span class="muted">Brak operacji — doładuj wallet i graj w Trenches.</span></div>'
      }</div>`,
    );
  }
  function onWalletClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    sync();
    const c = C();
    if (b.dataset.twAmt || b.dataset.tw === 'topup') {
      const input = $('#twTopUp');
      const v = b.dataset.twAmt ? Number(b.dataset.twAmt) : Number(input?.value);
      if (!(v > 0) || v > 1e9) return toast('Wpisz kwotę');
      W.cash[c] = (W.cash[c] || 0) + v;
      W.deposits[c] = (W.deposits[c] || 0) + v;
      W.tx.unshift({ type: 'deposit', t: Date.now(), chain: c, amount: v });
      save();
      if (input && !b.dataset.twAmt) input.value = '';
      toast(`⬇️ Doładowano ${nat(v, sym())} — wallet Trenches ${nat(W.cash[c], sym())}`);
    } else if (b.dataset.tw === 'reset') {
      if (!confirm('Wyzerować wallet Trenches DEMO? Salda wszystkich sieci, pozycje i historia Trenches zostaną usunięte.')) return;
      W = T.newWallet();
      W.tx.unshift({ type: 'reset', t: Date.now() });
      save();
      toast('Wallet Trenches wyzerowany');
    } else if (b.dataset.tw === 'open') return nav?.('trench');
    else return;
    walletRender(e.currentTarget);
  }

  // ---------- loop ----------
  let touchUntil = 0;
  for (const sel of ['#trenchSheet', '#walletTrenchBody']) {
    const el = $(sel);
    if (!el) continue;
    el.addEventListener('touchstart', () => (touchUntil = Date.now() + 60_000), { passive: true });
    for (const ev of ['touchend', 'touchcancel']) el.addEventListener(ev, () => (touchUntil = Date.now() + 400), { passive: true });
  }
  document.addEventListener('touchend', () => touchUntil > Date.now() + 400 && (touchUntil = Date.now() + 400), { passive: true, capture: true });
  $('#trenchSheet')?.addEventListener('click', onClick);
  $('#trenchSheet')?.addEventListener('change', onChange);
  $('#trenchSheet')?.addEventListener('input', onInput);
  $('#walletTrenchBody')?.addEventListener('click', onWalletClick);

  let lastRender = 0;
  let tick = 0;
  async function loop() {
    tick++;
    const vis = visible();
    const held = myPos().some((p) => p.chain === C());
    if (isSol() && (vis || held || walletVisible())) solFeed(vis).then(() => (S.dirty = true));
    if (!isSol()) for (const p of myPos()) if (p.chain === C()) {
      const r = engine.trenches.rows(C(), [p.mint])[0];
      if (r?.p) S.px[T.posKey(C(), p.mint)] = { p: r.p, mc: r.mc, lq: r.lq, at: Date.now() };
    }
    if (vis && S.open) {
      liveTick();
      if (tick % (SUB_TF.has(S.tf) ? 13 : 20) === 0) loadTrades();
      if (S.candles && Date.now() - S.candles.at > 50_000) loadCandles();
    }
    checkExits();
    const now = Date.now();
    if (vis && Date.now() >= touchUntil && (S.dirty || now - lastRender > 1_000)) {
      S.dirty = false;
      lastRender = now;
      render();
    }
    if (walletVisible() && Date.now() >= touchUntil) walletRender($('#walletTrenchBody'));
  }
  setInterval(loop, 1_000);
  setTimeout(loop, 0);

  return {
    render() {
      S.dirty = true;
      render();
    },
    renderWallet: (el) => walletRender(el),
    count: () => myPos().filter((p) => p.chain === C()).length,
    chainChanged() {
      S.open = null;
      S.dirty = true;
      if (visible()) render();
    },
    _s: () => ({ S, W }),
  };
}
