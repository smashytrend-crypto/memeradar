import { computeHype } from './scoring.js?v=mutkyp9h';
import { CURVE_DEXES, NON_MEME, NON_MEME_TAGS, PUMP_INITIAL_VTOKENS, PUMP_K, PUMP_TOKENS_FOR_SALE } from './constants.js?v=mutkyp9h';
import { Emitter, clamp } from './util.js?v=mutkyp9h';
import { change4h, freshCandles, sparkPoints } from './candles.js?v=mutkyp9h';
import { EVM_BASE_ASSETS, EVM_NON_MEME_SYMBOLS, evmEligible, getChain, isAddressOn, normAddr } from './chains.js?v=mutkyp9h';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NESTED = new Set(['change', 'volume', 'txns', 'socials', 'audit']);
const TEXT = new Set(['name', 'symbol', 'image', 'description']);
const MAX_TRADES = 400;
const HIST_EVERY = 15_000;
const HIST_LEN = 180; // 45 minutes of samples
const EMA = 0.35; // smoothing per rescore tick (~2s) so ranks don't jitter

/**
 * Is the hype building or fading? Compares the trading pace (volume per minute) of the last
 * 5 minutes with the last hour, and the last hour with the last 6 hours.
 * hot = accelerating hard, up = speeding up, flat = steady, cool = slowing, dead = fading out.
 */
export function freshness(vol5, vol1h, vol6h) {
  if (!(vol1h >= 1000)) return null;
  const r5 = (vol5 || 0) / 5;
  const r60 = vol1h / 60;
  const r360 = vol6h > 0 ? vol6h / 360 : r60;
  const accel = r5 / r60;
  const trend = r360 > 0 ? r60 / r360 : 1;
  if (accel >= 1.6 && trend >= 1.1) return 'hot';
  if (accel >= 1.2) return 'up';
  if (accel < 0.35 && trend < 0.9) return 'dead';
  if (accel < 0.6) return 'cool';
  return 'flat';
}

function blank(mint, now) {
  return {
    mint,
    name: '',
    symbol: '',
    image: '',
    description: '',
    uri: '',
    createdAt: 0,
    firstSeen: now,
    lastActivity: 0,
    sources: new Set(),
    launchpad: null,
    bondingProgress: null,
    graduated: false,
    migratedAt: 0,
    creator: '',
    pairAddress: '',
    dexId: '',
    dexUrl: '',
    priceUsd: 0,
    mcap: 0,
    fdv: 0,
    liquidity: 0,
    change: {},
    volume: {},
    txns: {},
    holders: 0,
    holderChange1h: null,
    holdersHist: [],
    organicScore: null,
    organicLabel: '',
    traders1h: null,
    verified: false,
    tags: [],
    socials: {},
    boosts: 0,
    hasProfile: false,
    audit: null,
    rug: null,
    trades: [],
    x: null,
    hype: { score: 0, parts: {}, risk: { level: 'unknown', flags: [], penalty: 0 }, market: {} },
    hist: [],
    enriched: {},
    pinnedUntil: 0,
    lastSpike: 0,
    lastWhale: 0,
    lastMarketFromStream: 0,
    buyVol: {},
    sellVol: {},
    jupTx: {},
    candles: null,
    candlesAt: 0,
    candlesPool: '',
  };
}

// Bidi overrides / zero-width chars let scam names render reversed or spoofed.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Token trades on a real DEX pool (curve finished, or never had one). */
const surgeRank = (t) => (t.hype.market?.surge || 0) * Math.log10((t.hype.market?.vol5 || 0) + 10);

export function isOnDex(t) {
  if (t.graduated) return true;
  return !t.launchpad && !!t.dexId && !CURVE_DEXES.has(t.dexId);
}

const fmtK = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}K` : String(Math.round(v)));

function isClean(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'number' && !Number.isFinite(v)) return false;
  return true;
}

function cleanObj(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (isClean(v)) out[k] = v;
  return out;
}

export class Store extends Emitter {
  constructor(config) {
    super();
    this.config = config;
    this.chain = getChain(config.chain);
    // The engine of a network the viewer isn't looking at pauses its source loops.
    this.active = true;
    this.tokens = new Map();
    this.rankings = {}; // name -> Map(mint -> rank)
    this.sources = {}; // name -> { state, msg, at, count }
    this.solPrice = 0;
    this.hasX = !!config.xBearer;
    this.ranked = [];
    this.rank = new Map();
    this.feed = [];
    this.launchTimes = [];
    this.migrationTimes = [];
    this.tradeCount = 0;
    this.tradeTimes = [];
    this.startedAt = Date.now();
  }

  // ---------- sources ----------

  setSource(name, state, msg = '') {
    const prev = this.sources[name] || { count: 0 };
    this.sources[name] = { state, msg, at: Date.now(), count: prev.count + (state === 'ok' ? 1 : 0) };
  }

  // ---------- writes ----------

  get(mint) {
    return this.tokens.get(normAddr(this.chain, mint));
  }

  /** Create-or-update a token. Returns the token, or null if rejected (not a memecoin / invalid). */
  upsert(mint, patch = {}, source) {
    mint = normAddr(this.chain, mint);
    if (!isAddressOn(this.chain, mint) || NON_MEME.has(mint)) return null;
    const sym = this.chain.evm && patch.symbol ? String(patch.symbol).toUpperCase() : '';
    const nonMemeSymbol = sym && (EVM_BASE_ASSETS.has(sym) || (this.chain.memeOnly !== false && EVM_NON_MEME_SYMBOLS.has(sym)));
    if (nonMemeSymbol || patch.tags?.some?.((tag) => NON_MEME_TAGS.has(tag))) {
      // Tags (from Jupiter) can arrive after another source already added the token.
      this.tokens.delete(mint);
      return null;
    }
    const now = Date.now();
    let t = this.tokens.get(mint);
    if (!t) {
      t = blank(mint, now);
      this.tokens.set(mint, t);
    }
    if (source) t.sources.add(source);
    for (const [k, v] of Object.entries(patch)) {
      if (!isClean(v)) continue;
      if (NESTED.has(k) && typeof v === 'object') {
        t[k] = { ...t[k], ...cleanObj(v) };
      } else if (TEXT.has(k)) {
        const text = String(v).replace(INVISIBLE, '').trim();
        // Keep the first image: sources disagree on URLs, and swapping them makes avatars flicker.
        if (k === 'image' && t.image) continue;
        if (text) t[k] = text.slice(0, k === 'description' ? 600 : 300);
      } else if (k === 'createdAt') {
        if (v > 0 && (!t.createdAt || v < t.createdAt)) t.createdAt = v;
      } else if (k === 'holders') {
        if (v > 0) this.#recordHolders(t, v, now);
      } else if (k === 'graduated') {
        if (v && !t.graduated) {
          t.graduated = true;
          t.bondingProgress = 100;
        }
      } else {
        t[k] = v;
      }
    }
    return t;
  }

  #recordHolders(t, n, now) {
    t.holders = n;
    const h = t.holdersHist;
    const last = h[h.length - 1];
    if (last && now - last[0] < 20_000) last[1] = n;
    else h.push([now, n]);
    while (h.length > 2 && now - h[0][0] > 2 * HOUR) h.shift();
    if (h.length > 200) h.splice(0, h.length - 200);
  }

  /** Converts pump.fun curve reserves into % progress to graduation. */
  static pumpProgress(vTokens) {
    if (!(vTokens > 0)) return undefined;
    return clamp(((PUMP_INITIAL_VTOKENS - vTokens) / PUMP_TOKENS_FOR_SALE) * 100, 0, 100);
  }

  /**
   * Curve progress from the token price in SOL (no trade stream needed):
   * mcapSol = K·1e9 / vTokens²  ⇒  vTokens = √(K·1e9 / mcapSol).
   */
  static pumpProgressFromPriceSol(priceSol) {
    if (!(priceSol > 0)) return undefined;
    return Store.pumpProgress(Math.sqrt((PUMP_K * 1e9) / (priceSol * 1e9)));
  }

  /** New launch from the on-chain stream (pump.fun / bonk). */
  onLaunch(l) {
    if (this.config.onlyGraduated) return null;
    const now = Date.now();
    const t = this.upsert(
      l.mint,
      {
        name: l.name,
        symbol: l.symbol,
        uri: l.uri,
        launchpad: l.launchpad,
        creator: l.creator,
        createdAt: l.t || now,
        bondingProgress: l.launchpad === 'pump' ? Store.pumpProgress(l.vTokens) ?? 0 : l.progress,
      },
      l.source || 'pumpportal',
    );
    if (!t) return null;
    if (l.mcapSol && this.solPrice) this.#streamMarket(t, l.mcapSol, now);
    t.lastActivity = now;
    this.launchTimes.push(now);
    this.pushFeed({
      type: 'launch',
      mint: t.mint,
      text: `${t.name || 'Nowy token'} ($${t.symbol || '?'}) wystartował na ${l.launchpad === 'bonk' ? 'bonk.fun' : 'pump.fun'}`,
      sol: l.initialBuySol,
    });
    return t;
  }

  #streamMarket(t, mcapSol, now) {
    // Only trust the stream for price when DEX data is stale (stream = bonding-curve price).
    if (now - (t.enriched.dexAt || 0) < 90_000 && t.graduated) return;
    const mcap = mcapSol * this.solPrice;
    if (!(mcap > 0)) return;
    t.mcap = mcap;
    t.priceUsd = mcap / 1e9;
    t.lastMarketFromStream = now;
  }

  /** Live trade from the on-chain stream. */
  addTrade(mint, tr) {
    const t = this.tokens.get(mint);
    if (!t) return;
    const now = Date.now();
    t.trades.push({ t: tr.t || now, side: tr.side, sol: tr.sol || 0, trader: tr.trader || '' });
    if (t.trades.length > MAX_TRADES) t.trades.splice(0, t.trades.length - MAX_TRADES);
    t.lastActivity = now;
    this.tradeCount++;
    this.tradeTimes.push(now);
    if (tr.mcapSol && this.solPrice) this.#streamMarket(t, tr.mcapSol, now);
    if (t.launchpad === 'pump' && !t.graduated && tr.vTokens) t.bondingProgress = Store.pumpProgress(tr.vTokens);
    if (tr.progress != null && !t.graduated) t.bondingProgress = tr.progress;

    if (tr.side === 'buy' && tr.sol >= this.config.whaleSol && now - t.lastWhale > 30_000) {
      t.lastWhale = now;
      this.pushFeed({
        type: 'whale',
        mint,
        text: `Wieloryb kupił ${tr.sol.toFixed(1)} SOL ${t.symbol ? '$' + t.symbol : 'tokena'}`,
        sol: tr.sol,
      });
    }
  }

  onMigration(mint, info = {}) {
    const t = this.upsert(mint, { graduated: true, migratedAt: Date.now() }, info.source || 'pumpportal');
    if (!t) return;
    t.lastActivity = Date.now();
    this.migrationTimes.push(Date.now());
    this.pushFeed({
      type: 'migrate',
      mint,
      text: `${t.name || t.symbol || 'Token'} ukończył bonding curve i przeszedł na DEX${info.pool ? ` (${info.pool})` : ''}`,
    });
  }

  /** Replaces a named ranking list (e.g. "gecko:trending") with a fresh ordered list of mints. */
  setRanking(name, mints) {
    const map = new Map();
    let i = 1;
    for (let m of mints) {
      m = normAddr(this.chain, m);
      if (this.tokens.has(m) && !map.has(m)) map.set(m, i++);
    }
    this.rankings[name] = map;
  }

  pushFeed(ev) {
    const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), ...ev };
    this.feed.unshift(item);
    if (this.feed.length > 150) this.feed.length = 150;
    this.emit('feed', item);
  }

  /** Mark a token as requested by a viewer — protects it from pruning and bumps refresh priority. */
  /** 15-minute price candles from GeckoTerminal for the token's main pool (see candles.js). */
  setCandles(mint, candles, pool) {
    const t = this.tokens.get(mint);
    if (!t) return;
    t.candles = candles?.length ? candles : null;
    t.candlesAt = Date.now();
    t.candlesPool = pool;
  }

  pin(mint, ms = 15 * MIN) {
    const t = this.tokens.get(mint);
    if (t) t.pinnedUntil = Math.max(t.pinnedUntil, Date.now() + ms);
  }

  // ---------- scoring / ranking ----------

  rescore(now = Date.now()) {
    const ctx = { solPrice: this.solPrice, rankings: this.rankings, hasX: this.hasX };
    const arr = [];
    for (const t of this.tokens.values()) {
      const prev = t.hype.score;
      const h = computeHype(t, now, ctx);
      h.raw = h.score;
      h.score = t.hist.length ? Math.round((prev + (h.score - prev) * EMA) * 10) / 10 : h.score;
      t.hype = h;
      const last = t.hist[t.hist.length - 1];
      if (!last || now - last[0] >= HIST_EVERY) {
        t.hist.push([now, t.hype.score, t.priceUsd || 0]);
        if (t.hist.length > HIST_LEN) t.hist.shift();
      }
      // Spike: +15 points vs ~1 minute ago — only for tokens with a few minutes of real
      // market data, otherwise every newly discovered token would "jump" from 0.
      if (!t.marketSince && (t.mcap > 0 || t.liquidity > 0)) t.marketSince = now;
      const settled = t.marketSince && now - t.marketSince > 3 * MIN && t.hist.length >= 5;
      const ref = settled ? t.hist[t.hist.length - 5][1] : t.hype.score;
      const surge = t.hype.market?.surge || 0;
      const vol5 = t.hype.market?.vol5 || 0;
      if (settled && surge >= 4 && vol5 >= 5000 && now - (t.lastSurge || 0) > 15 * MIN) {
        t.lastSurge = now;
        this.pushFeed({
          type: 'surge',
          mint: t.mint,
          text: `Wybicie wolumenu ${t.symbol ? '$' + t.symbol : t.name}: $${fmtK(vol5)} w 5 min (${surge.toFixed(1)}× średniej)`,
        });
      }
      if (settled && t.hype.score >= 40 && t.hype.score - ref >= 15 && now - t.lastSpike > 10 * MIN) {
        t.lastSpike = now;
        this.pushFeed({
          type: 'spike',
          mint: t.mint,
          text: `Hype ${t.symbol ? '$' + t.symbol : t.name} skoczył ${ref.toFixed(0)} → ${t.hype.score.toFixed(0)}`,
        });
      }
      const hasMarket = t.mcap > 0 || t.liquidity > 0;
      const eligible = !this.chain.evm || evmEligible(this.chain, t, now);
      if (t.hype.score > 0 && hasMarket && eligible && (!this.config.onlyGraduated || isOnDex(t))) arr.push(t);
    }
    arr.sort((a, b) => b.hype.score - a.hype.score);
    this.ranked = arr;
    this.rank = new Map(arr.map((t, i) => [t.mint, i + 1]));

    const cut = (list, age) => {
      while (list.length && now - list[0] > age) list.shift();
    };
    cut(this.launchTimes, HOUR);
    cut(this.migrationTimes, 24 * HOUR);
    cut(this.tradeTimes, MIN);
  }

  topMints(n) {
    return this.ranked.slice(0, n).map((t) => t.mint);
  }

  /**
   * Picks up to `n` tokens most overdue for refresh from a given source.
   * Refresh cadence depends on rank/activity so hot tokens stay fresh.
   */
  pickForRefresh(kind, n, now = Date.now(), { filter, intervals } = {}) {
    const iv = { top: 15_000, hot: 45_000, young: 120_000, rest: 15 * MIN, ...intervals };
    const cands = [];
    for (const t of this.tokens.values()) {
      if (filter && !filter(t)) continue;
      const rank = this.rank.get(t.mint) || Infinity;
      const pinned = t.pinnedUntil > now;
      const active = now - t.lastActivity < 5 * MIN;
      const young = now - (t.createdAt || t.firstSeen) < HOUR;
      const interval = rank <= 100 || pinned ? iv.top : rank <= 500 || active ? iv.hot : young ? iv.young : iv.rest;
      const last = t.enriched[kind] || 0;
      const overdue = (now - last) / interval;
      if (overdue >= 1) cands.push([overdue * (1 + t.hype.score / 20) * (pinned ? 5 : 1), t]);
    }
    cands.sort((a, b) => b[0] - a[0]);
    const picked = cands.slice(0, n).map(([, t]) => t);
    for (const t of picked) t.enriched[kind] = now;
    return picked;
  }

  /** Drops dead tokens so memory stays bounded while the universe keeps growing. */
  prune(now = Date.now()) {
    const dead = [];
    for (const t of this.tokens.values()) {
      if (t.pinnedUntil > now) continue;
      const age = now - (t.createdAt || t.firstSeen);
      // Fetching a token is not activity: a dead token refreshed every few seconds is still dead.
      const idle = now - Math.max(t.lastActivity, t.firstSeen);
      const small = (t.mcap || 0) < 8000 && (t.liquidity || 0) < 3000;
      if ((age > 30 * MIN && idle > 20 * MIN && small && t.hype.score < 5) || (idle > 6 * HOUR && t.hype.score < 2)) {
        dead.push(t.mint);
      }
    }
    for (const m of dead) this.tokens.delete(m);
    let removed = dead.length;
    const max = this.config.maxTokens;
    if (this.tokens.size > max) {
      const list = [...this.tokens.values()]
        .filter((t) => t.pinnedUntil <= now)
        .sort((a, b) => a.hype.score - b.hype.score || a.lastActivity - b.lastActivity);
      for (const t of list.slice(0, this.tokens.size - max)) {
        this.tokens.delete(t.mint);
        removed++;
      }
    }
    return removed;
  }

  // ---------- reads ----------

  list(view, f = {}, limit = 100, mints = []) {
    const now = Date.now();
    const q = (f.q || '').trim().toLowerCase();
    const pass = (t) => {
      if (f.minMcap && (t.mcap || 0) < f.minMcap) return false;
      if (f.minLiq && (t.liquidity || 0) < f.minLiq && !(t.launchpad && !t.graduated)) return false;
      if (f.maxAgeH && t.createdAt && now - t.createdAt > f.maxAgeH * HOUR) return false;
      if (f.safe && t.hype.risk.level === 'danger') return false;
      if (q && !(t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.mint.toLowerCase() === q))
        return false;
      return true;
    };
    if (this.config.onlyGraduated && (view === 'new' || view === 'graduating')) view = 'graduated';
    let list;
    switch (view) {
      case 'new':
        list = [...this.tokens.values()]
          .filter((t) => t.createdAt && now - t.createdAt < 3 * HOUR && pass(t))
          .sort((a, b) => b.createdAt - a.createdAt);
        break;
      case 'graduating':
        list = [...this.tokens.values()]
          .filter((t) => t.launchpad && !t.graduated && t.bondingProgress >= 30 && now - t.lastActivity < 30 * MIN && pass(t))
          .sort((a, b) => b.bondingProgress - a.bondingProgress || b.hype.score - a.hype.score);
        break;
      case 'graduated':
        if (this.chain.evm) {
          // EVM: few launchpads report graduation, so this lists tokens new on a DEX in the last
          // 24 h (graduation time when known, otherwise the first DEX pool) from the radar.
          const since = (t) => t.migratedAt || t.createdAt || 0;
          list = this.ranked.filter((t) => now - since(t) < 24 * HOUR && pass(t)).sort((a, b) => since(b) - since(a));
          break;
        }
        list = [...this.tokens.values()]
          .filter((t) => t.graduated && t.migratedAt && now - t.migratedAt < 24 * HOUR && (t.mcap > 0 || t.liquidity > 0) && pass(t))
          .sort((a, b) => b.migratedAt - a.migratedAt);
        break;
      case 'surge':
        // Sudden volume: ≥2× own baseline and meaningful absolute size, strongest first.
        list = this.ranked
          .filter((t) => (t.hype.market?.surge || 0) >= 2 && (t.hype.market?.vol5 || 0) >= 2000 && pass(t))
          .sort((a, b) => surgeRank(b) - surgeRank(a));
        break;
      case 'social':
        list = this.ranked
          .filter((t) => pass(t) && (this.hasX ? t.x?.mentions1h > 0 : t.hype.parts.social > 0))
          .sort((a, b) =>
            this.hasX
              ? (b.x?.mentions1h || 0) - (a.x?.mentions1h || 0) || b.hype.score - a.hype.score
              : b.hype.parts.social - a.hype.parts.social || b.hype.score - a.hype.score,
          );
        break;
      case 'watch':
        list = mints.map((m) => this.get(m)).filter(Boolean);
        break;
      default:
        list = this.ranked.filter(pass);
    }
    return list.slice(0, limit).map((t) => this.row(t, now));
  }

  /** Compact row for the leaderboard. */
  row(t, now = Date.now()) {
    const m = t.hype.market || {};
    const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
    // Jupiter's buy/sell split, only while fresh (it refreshes every ~15 s for the top tokens).
    const jupFresh = now - (t.enriched.jupAt || 0) < 3 * MIN;
    const vol = (o, k) => (jupFresh && o?.[k] != null ? Math.round(o[k]) : null);
    const jt = jupFresh ? t.jupTx || {} : {};
    return {
      m: t.mint,
      n: t.name,
      s: t.symbol,
      i: t.image,
      ca: t.createdAt || null,
      p: t.priceUsd || null,
      mc: t.mcap || t.fdv || null,
      lq: t.liquidity || null,
      v5: m.vol5 || null,
      v1: m.vol1h || null,
      v24: t.volume?.h24 || null,
      c5: r1(t.change?.m5),
      c1: r1(t.change?.h1),
      c6: r1(t.change?.h6),
      c24: r1(t.change?.h24),
      c4: r1(change4h(t, now)),
      bv5: vol(t.buyVol, 'm5'),
      sv5: vol(t.sellVol, 'm5'),
      bv1: vol(t.buyVol, 'h1'),
      sv1: vol(t.sellVol, 'h1'),
      jb5: jt.b5 ?? null,
      js5: jt.s5 ?? null,
      jb1: jt.b1 ?? null,
      js1: jt.s1 ?? null,
      cd: sparkPoints(freshCandles(t, now), now, t.candlesAt),
      b5: m.buys5 || 0,
      s5: m.sells5 || 0,
      b1: m.buys1h || 0,
      s1: m.sells1h || 0,
      tr: m.traders1h || null,
      h: t.holders || null,
      // Holder structure for the list's Axiom-style icons (null = not known yet).
      dv: r1(t.audit?.devBalancePercentage ?? null),
      t10: r1(t.audit?.topHoldersPercentage ?? null),
      ins: r1(t.rug?.insidersPct ?? null),
      lpb: r1(t.rug?.lpBurnPct ?? null),
      dp: t.dexPaid ?? null,
      cr: t.creator || null,
      dm: t.audit?.devMints ?? null, // tokens the creator launched
      dmg: t.audit?.devMigrations ?? null, // …of which graduated
      dhp: t.audit?.honeypotSameCreator ?? null, // EVM: other honeypots by the creator
      fz: freshness(m.vol5, m.vol1h, t.volume?.h6),
      hg: m.holderGrowth1h || null,
      x: t.x?.mentions1h ?? null,
      xc: t.x?.capped || false,
      hs: t.hype.score,
      hp: Object.fromEntries(Object.entries(t.hype.parts).map(([k, v]) => [k, Math.round(v * 100)])),
      hh: t.hist.slice(-40).map((p) => p[1]),
      ph: t.hist.slice(-40).map((p) => p[2]),
      pt: t.hist.length ? Math.round((now - t.hist[t.hist.length - 1][0]) / 1000) : 0, // age of the newest sample, s
      pi: t.hist.length > 1 ? Math.round((t.hist[t.hist.length - 1][0] - t.hist[Math.max(0, t.hist.length - 40)][0]) / Math.min(39, t.hist.length - 1) / 1000) : 15, // mean spacing, s
      bp: t.launchpad && !t.graduated ? r1(t.bondingProgress) : null,
      gr: t.graduated,
      ma: t.migratedAt || null,
      lp: t.launchpad,
      rk: t.hype.risk.level,
      src: [...t.sources],
      tw: !!t.socials.twitter,
      tg: !!t.socials.telegram,
      web: !!t.socials.website,
      bo: t.boosts || 0,
      rank: this.rank.get(t.mint) || null,
      vs: m.surge || null,
      fr: now - (t.enriched.dexAt || 0) < 120_000, // price freshly confirmed by DexScreener
      ai: t.ai?.result?.headline || null,
      live: now - t.lastActivity < 2 * 60_000,
    };
  }

  detail(t) {
    const now = Date.now();
    return {
      ...this.row(t, now),
      description: t.description,
      socials: t.socials,
      pair: t.pairAddress,
      dexId: t.dexId,
      dexUrl: t.dexUrl,
      fdv: t.fdv,
      creator: t.creator,
      organicScore: t.organicScore,
      organicLabel: t.organicLabel,
      verified: t.verified,
      audit: t.audit,
      // Holder structure (like Axiom's token panel), from whichever sources have it.
      devPct: t.audit?.devBalancePercentage ?? null,
      top10Pct: t.audit?.topHoldersPercentage ?? null,
      insidersPct: t.rug?.insidersPct ?? null,
      insiders: t.rug?.insiders ?? null,
      lpBurnPct: t.rug?.lpBurnPct ?? null,
      dexPaid: t.dexPaid ?? null,
      risk: t.hype.risk,
      market: t.hype.market,
      txns: t.txns,
      volume: t.volume,
      change: t.change,
      buyVol: t.buyVol,
      sellVol: t.sellVol,
      x: t.x && {
        mentions1h: t.x.mentions1h,
        capped: t.x.capped,
        authors: t.x.authors,
        engagement: t.x.engagement,
        reach: t.x.reach,
        lastPoll: t.x.lastPoll,
        tweets: t.x.tweets,
        hist: t.x.hist,
      },
      trades: t.trades.slice(-40).reverse(),
      hist: t.hist,
      holdersHist: t.holdersHist.slice(-120),
      rankings: Object.fromEntries(
        Object.entries(this.rankings)
          .map(([k, map]) => [k, map.get(t.mint)])
          .filter(([, v]) => v),
      ),
      firstSeen: t.firstSeen,
      ai: t.ai
        ? { status: t.ai.status, at: t.ai.at, error: t.ai.error, result: t.ai.result, auto: t.ai.auto }
        : null,
      aiEnabled: !!this.aiEnabled,
    };
  }

  stats() {
    let live = 0;
    let grad24 = 0;
    const now = Date.now();
    for (const t of this.tokens.values()) {
      if (now - t.lastActivity < 5 * MIN) live++;
      if (t.migratedAt && now - t.migratedAt < 24 * HOUR) grad24++;
    }
    return {
      tracked: this.tokens.size,
      ranked: this.ranked.length,
      active5m: live,
      launches1h: this.launchTimes.length,
      launches1m: this.launchTimes.filter((x) => now - x < MIN).length,
      migrations24h: Math.max(grad24, this.migrationTimes.length),
      tradesPerMin: this.tradeTimes.length,
      liveTrades: !!this.config.pumpPortalKey || (!!this.config.demo && !this.config.onlyGraduated),
      onlyGraduated: !!this.config.onlyGraduated,
      aiEnabled: !!this.aiEnabled,
      solPrice: this.solPrice,
      chain: this.chain.id,
      native: this.chain.native,
      hasX: this.hasX,
      demo: !!this.config.demo,
      uptime: now - this.startedAt,
    };
  }
}
