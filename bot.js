// Trading bot DEMO: finds memecoins whose chart is going up (momentum on the radar's live data)
// and makes quick round trips — buy, then take profit / stop loss / trailing stop / time limit.
// Own demo wallet (Wallet → BOT), separate from the spot positions. Runs while the app is open.

const TICK_MS = 2000;
const DAY_MS = 86_400_000;

/** Settings shown in the panel, in groups: [key, label, unit, min, max, step, hint]. */
export const FIELD_GROUPS = [
  ['💰 Kwota i wyjścia', [
    ['buyUsd', 'Kwota zakupu', '$', 1, 1e6, 1, 'Za tyle bot kupuje przy każdym wejściu'],
    ['tp', 'Take profit', '%', 0.5, 1000, 0.5, 'Sprzedaje, gdy cena wzrośnie o tyle % od zakupu'],
    ['sl', 'Stop loss', '%', 0.5, 95, 0.5, 'Zamyka pozycję dokładnie przy cenie −tyle % od zakupu (gwarantowany stop)'],
    ['be', 'Stop na zero po', '%', 0, 1000, 0.5, 'Po wzroście o tyle % sprzedaje, gdy cena wróci do ceny zakupu — zysk nie zamieni się w stratę (0 = wyłączony)'],
    ['trail', 'Trailing stop', '%', 0, 90, 0.5, 'Sprzedaje, gdy cena spadnie o tyle % od szczytu (0 = wyłączony)'],
    ['trailArm', 'Trailing od wzrostu', '%', 0, 1000, 0.5, 'Trailing włącza się dopiero po takim wzroście (0 = od wzrostu równego trailingowi)'],
    ['partAt', 'Sprzedaj połowę przy', '%', 0, 1000, 0.5, 'Przy takim zysku sprzedaje połowę, reszta jedzie dalej do TP (0 = wyłączone)'],
    ['stallSec', 'Wyjście bez ruchu po', 's', 0, 7200, 10, 'Jeśli po tylu sekundach pozycja nie urosła o wartość niżej — zamyka ją i szuka lepszej (0 = wyłączone)'],
    ['stallPk', '…gdy wzrost poniżej', '%', 0, 100, 0.5, 'Próg dla wyjścia bez ruchu'],
    ['maxHoldMin', 'Maks. czas pozycji', 'min', 0, 1440, 1, 'Po tylu minutach zamyka pozycję po cenie rynkowej (0 = bez limitu)'],
    ['maxPos', 'Maks. otwartych pozycji', '', 1, 20, 1, 'Ile tokenów bot może trzymać naraz'],
    ['cooldownMin', 'Przerwa po wyjściu', 'min', 0, 1440, 1, 'Tyle minut bot nie wraca do tego samego tokena'],
    ['maxDayLoss', 'Dzienny limit straty', '$', 0, 1e9, 1, 'Bot sam się zatrzyma po takiej stracie w ciągu dnia (0 = bez limitu)'],
  ]],
  ['🎯 Wejście — co kupować', [
    ['minC5', 'Wzrost 5 min od', '%', 0, 500, 0.5, 'Minimalny wzrost ceny w ostatnich 5 minutach (wybicie)'],
    ['maxC5', 'Wzrost 5 min do', '%', 1, 5000, 1, 'Pomija tokeny, które już wystrzeliły ponad tyle %'],
    ['minVolAcc', 'Wolumen vs zwykły od', '×', 0, 50, 0.5, 'Wolumen z 5 min względem średnich 5 min z ostatniej godziny (3× = trzy razy większy ruch niż zwykle; 0 = nie sprawdzaj)'],
    ['minBuys', 'Kupujący od', '%', 0, 100, 1, 'Udział kupna w obrocie z ostatnich 5 minut'],
    ['maxBuys', 'Kupujący do', '%', 0, 100, 1, 'Prawie samo kupno to często sztuczny ruch (0 = bez limitu)'],
    ['minVol5', 'Wolumen 5 min od', '$', 0, 1e8, 100, 'Minimalny obrót w ostatnich 5 minutach'],
    ['minLiq', 'Płynność od', '$', 0, 1e9, 1000, 'Minimalna płynność puli (mniejsza = większy poślizg)'],
    ['maxLiq', 'Płynność do', '$', 0, 1e9, 1000, 'Małe, wczesne pule ruszają się najmocniej (0 = bez limitu)'],
    ['minMc', 'MCap od', '$', 0, 1e10, 1000, ''],
    ['maxMc', 'MCap do', '$', 0, 1e12, 1000, '0 = bez limitu'],
    ['maxAgeH', 'Wiek tokena do', 'h', 0, 10000, 0.5, 'Tylko tokeny młodsze niż tyle godzin (0 = dowolny)'],
    ['maxHype', 'Hype score do', '', 0, 100, 1, 'Najwyższy hype to zwykle tokeny, które już urosły — spóźnione wejście (0 = bez limitu)'],
    ['minSafety', 'Bezpieczeństwo od', '/100', 0, 100, 1, 'Minimalny wynik bezpieczeństwa tokena (0 = nie sprawdzaj)'],
    ['minC1', 'Wzrost 1h od', '%', -100, 100000, 1, '−100 = nie sprawdzaj'],
    ['maxC1', 'Wzrost 1h do', '%', 0, 100000, 1, 'Tokeny po +kilkuset % w godzinę często kończą się zrzutem (0 = bez limitu)'],
    ['maxR30', 'Maks. skok w 30 s', '%', 0, 1000, 0.5, 'Nie kupuje tuż po gwałtownym skoku — zwykle zaraz oddaje (0 = nie sprawdzaj)'],
  ]],
];
export const FIELDS = FIELD_GROUPS.flatMap(([, f]) => f);
// The recommended strategy — chosen on 4 hours of recorded live Solana radar data (two
// independent sessions, every hour in profit after fees): enter only strong breakouts (+30% in
// 5 min on 3× the usual volume) in small, early pools that the hype ranking hasn't priced in
// yet; cut what doesn't move within 2 minutes, let the winners run to +150%.
export const DEFAULTS = {
  buyUsd: 25, tp: 150, sl: 8, be: 0, trail: 0, trailArm: 0, partAt: 0, stallSec: 120, stallPk: 3, maxHoldMin: 20, maxPos: 3,
  cooldownMin: 60, maxDayLoss: 0,
  minC5: 30, maxC5: 300, minVolAcc: 3, minBuys: 50, maxBuys: 80, minVol5: 8000, minLiq: 15000, maxLiq: 50000, minMc: 0, maxMc: 0,
  maxAgeH: 12, maxHype: 50, minSafety: 40, minC1: 0, maxC1: 300, maxR30: 0, minR60: -100, rising: false, gradOnly: false,
};
/** Bumped when the recommended strategy changes: saved settings move to the new one. */
const CFG_VER = 2;

// ---------- pure logic (tested) ----------

/** Share of buys in the last 5 minutes, 0–100 (volume when known, else trade counts); null if unknown. */
export function buyShare(r) {
  if (r.bv5 != null && r.sv5 != null && r.bv5 + r.sv5 > 0) return (r.bv5 / (r.bv5 + r.sv5)) * 100;
  const b = (r.jb5 ?? r.b5) || 0, s = (r.js5 ?? r.s5) || 0;
  return b + s > 0 ? (b / (b + s)) * 100 : null;
}

/** Whether the latest price samples are climbing, not falling back from a top. */
export function risingNow(ph) {
  const p = (ph || []).filter((v) => v > 0);
  if (p.length < 4) return false;
  const last = p[p.length - 1];
  const peak = Math.max(...p.slice(-8));
  return last > p[p.length - 4] && last >= peak * 0.97;
}

/**
 * Why a row doesn't qualify for a buy (null = it does). `ret(ms)`: the token's own price change in
 * % over the last `ms` (from the prices the bot saw), or null while it has no such history.
 */
export function rejectReason(r, cfg, now = Date.now(), ret = () => null) {
  if (!(r.p > 0)) return 'brak ceny';
  if (r.hpt || r.rk === 'danger') return 'ryzyko';
  if (cfg.minSafety > 0 && !(r.sc >= cfg.minSafety)) return 'bezpieczeństwo';
  if (cfg.gradOnly && r.bp != null) return 'bonding curve';
  if (r.ds && now - r.ds < 15 * 60_000) return 'dev sprzedaje';
  if (cfg.maxAgeH > 0 && !(r.ca > 0 && now - r.ca <= cfg.maxAgeH * 3600e3)) return 'wiek';
  if (!(r.c5 >= cfg.minC5) || r.c5 > cfg.maxC5) return 'wzrost 5m';
  if (cfg.minC1 > -100 && !(r.c1 >= cfg.minC1)) return 'wzrost 1h';
  if (cfg.maxC1 > 0 && r.c1 > cfg.maxC1) return 'wzrost 1h';
  const bs = buyShare(r);
  if (cfg.minBuys > 0 && !(bs >= cfg.minBuys)) return 'kupujący';
  if (cfg.maxBuys > 0 && bs > cfg.maxBuys) return 'kupujący';
  const vol5 = r.v5 ?? ((r.bv5 || 0) + (r.sv5 || 0) || null);
  if (cfg.minVol5 > 0 && !(vol5 >= cfg.minVol5)) return 'wolumen';
  // Volume speeding up: the last 5 minutes against the hour's average 5 minutes.
  if (cfg.minVolAcc > 0 && !(vol5 > 0 && r.v1 > 0 && vol5 / (r.v1 / 12) >= cfg.minVolAcc)) return 'wolumen';
  if (cfg.minLiq > 0 && !(r.lq >= cfg.minLiq)) return 'płynność';
  if (cfg.maxLiq > 0 && r.lq > cfg.maxLiq) return 'płynność';
  if (cfg.minMc > 0 && !(r.mc >= cfg.minMc)) return 'mcap';
  if (cfg.maxMc > 0 && r.mc > cfg.maxMc) return 'mcap';
  // The hype list's top scores are tokens that already ran: late entries.
  if (cfg.maxHype > 0 && r.hs > cfg.maxHype) return 'przegrzany';
  // Not chasing a spike: a jump in the last 30 s mostly gives back right after.
  if (cfg.maxR30 > 0) {
    const r30 = ret(30_000);
    if (r30 == null || r30 > cfg.maxR30) return 'skok';
  }
  if (cfg.minR60 > -100) {
    const r60 = ret(60_000);
    if (r60 == null || r60 < cfg.minR60) return 'wykres';
  }
  if (cfg.rising && !risingNow(r.ph)) return 'wykres';
  return null;
}

/** Ranking of buy candidates: stronger move with more buyers first. */
export const signalScore = (r) => (r.c5 || 0) * ((buyShare(r) ?? 50) / 50) + (r.c1 > 0 ? Math.min(r.c1, 50) / 10 : 0);

/**
 * Liquidity used for a sale's price impact. The feeds sometimes report an absurdly small pool for a
 * moment ($50 instead of $30k); a real drain shows in the price itself (the stop loss handles it),
 * so the pool is never taken below half of what it was at the buy.
 */
export const sellLiq = (lq0, lq) => Math.max(lq > 0 ? lq : 0, (lq0 > 0 ? lq0 : 0) * 0.5);

/** Price impact of a trade of `usd` in a pool with `liq` total liquidity (constant product, ~usd/liq). */
export const impact = (usd, liq) => (liq > 0 ? Math.min(0.25, usd / liq) : 0.02);

/** The price move of a position in % from the market price it was bought at (fees aside). */
export const movePct = (pos, price) => (price / (pos.px || pos.p) - 1) * 100;

/**
 * Exit due for a position at `price` (null = hold). `pos.peak` = highest price since the buy.
 * Take profit / stop loss / trailing are the price's move from the buy, exactly the % set
 * (fees only show in the $ result).
 */
export function exitReason(pos, price, cfg, now = Date.now()) {
  if (!(price > 0) || !((pos.px || pos.p) > 0)) return null;
  const pct = movePct(pos, price);
  const eps = 1e-9; // 0.92 / 1 − 1 is −7.999…%
  if (pct <= -cfg.sl + eps) return 'sl';
  const peak = Math.max(pos.peak || 0, price);
  const top = movePct(pos, peak);
  // Half off at the first target, the rest rides on to take profit / trailing.
  if (cfg.partAt > 0 && !pos.part && pct >= cfg.partAt - eps) return 'part';
  if (pct >= cfg.tp - eps) return 'tp';
  // Break even: once up by `be`%, a fall back to the buy price closes it (no winner turns loser).
  if (cfg.be > 0 && top >= cfg.be && pct <= 0.5) return 'be';
  const arm = cfg.trailArm > 0 ? cfg.trailArm : cfg.trail;
  if (cfg.trail > 0 && top >= arm && price <= peak * (1 - cfg.trail / 100)) return 'trail';
  // Dead trade: nothing happened in the first minutes — the money works better elsewhere.
  if (cfg.stallSec > 0 && now - pos.t >= cfg.stallSec * 1000 && top < cfg.stallPk) return 'stall';
  if (cfg.maxHoldMin > 0 && now - pos.t >= cfg.maxHoldMin * 60_000) return 'time';
  return null;
}

/**
 * Price feed glitch guard: a read more than ×3 away from the last accepted price is held back
 * (`pend`) and only taken when the next read confirms it (a real dump / pump stays there).
 */
export function checkGlitch(last, pend, price) {
  if (!(last > 0)) return { ok: true, pend: null };
  const r = price / last;
  if (r <= 3 && r >= 1 / 3) return { ok: true, pend: null };
  if (pend > 0 && price / pend < 1.5 && price / pend > 1 / 1.5) return { ok: true, pend: null };
  return { ok: false, pend: price };
}

export const EXIT_NAMES = { tp: '🎯 Take profit', part: '🎯 Połowa zysku', sl: '🛑 Stop loss', be: '🛡️ Stop na zero', trail: '📉 Trailing stop', stall: '😴 Brak ruchu', time: '⏱️ Limit czasu', manual: '✋ Ręcznie', reset: '♻️ Reset', gone: '❔ Brak tokenów' };

// ---------- the bot ----------

export function createBot(deps) {
  const { toast, engine, tradeFee, excluded, openToken, openWallet, onChange, fmt, esc } = deps;
  // Real mode: trades go through `exec` (signed Solana swaps) into the real bot's own storage.
  const REAL = !!deps.exec;
  const KEY = deps.key || 'mr:bot';
  const LOCK = deps.lockKey || 'mr:botLock';
  const canTrade = deps.canTrade || (() => true);
  // Real trades on their way. In memory (this tab's swaps in flight) and in B.pend / p.sellSig
  // (saved with the signature, so a reload mid-trade finds out from the chain what happened).
  const pending = new Set();
  const sellingNow = new Set();
  const retryAt = new Map();
  const myPend = new Map(); // this tab's buys in flight (re-applied if another tab's save drops them)
  const mySell = new Map(); // this tab's sales in flight: mint → their markers
  const tabId = deps.tabId || Math.random().toString(36).slice(2);
  // Whether another tab is still open (its trades in flight are its own to finish).
  const tabAlive = deps.tabAlive || ((id) => id === tabId);
  // REAL: the bot spends from the Spot wallet itself (the same SOL as manual trades) — what is free
  // there now, minus buys already on their way. DEMO: its own virtual capital.
  const freeCash = () => (REAL ? Math.max(0, (deps.walletCash?.() || 0) - Object.values(B.pend).reduce((a, e) => a + (e.usd || 0), 0)) : B.cash);
  const fresh = () => ({ cfgVer: CFG_VER, cash: 0, deposits: 0, on: false, cfg: { ...DEFAULTS }, pos: {}, pend: {}, booked: [], hist: [], tx: [], log: [], cool: {}, feesPaid: 0, rev: 0 });
  const load = () => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY));
      if (v && typeof v === 'object') {
        const b = { ...fresh(), ...v };
        b.cfg = { ...DEFAULTS, ...(v.cfg || {}) };
        // A new recommended strategy: settings move to it (the stake and the daily limit stay).
        if ((v.cfgVer || 1) < CFG_VER) {
          b.cfg = { ...DEFAULTS, buyUsd: b.cfg.buyUsd, maxDayLoss: b.cfg.maxDayLoss, open: b.cfg.open };
          b.cfgVer = CFG_VER;
          b.log = [{ t: Date.now(), msg: '🧠 Nowa strategia bota (z testów na danych z rynku) — ustawienia zaktualizowane' }, ...(b.log || [])];
        }
        for (const k of ['hist', 'tx', 'log']) if (!Array.isArray(b[k])) b[k] = [];
        if (!b.pos || typeof b.pos !== 'object') b.pos = {};
        if (!b.pend || typeof b.pend !== 'object') b.pend = {};
        if (!Array.isArray(b.booked)) b.booked = [];
        if (!b.cool || typeof b.cool !== 'object') b.cool = {};
        // Older saves kept these runtime flags (a reload mid-sale left the position stuck).
        for (const q of Object.values(b.pos)) {
          delete q.selling;
          delete q.retryAt;
        }
        return b;
      }
    } catch {
      /* private mode / bad data */
    }
    return fresh();
  };
  let B = load();
  const S = { calMonth: 0, touch: 0, lastScan: null, dirty: true, px: new Map() };
  const save = () => {
    B.hist = B.hist.slice(0, 2000).filter((h) => Date.now() - h.closedAt < 400 * DAY_MS);
    B.tx = B.tx.slice(0, 200);
    B.log = B.log.slice(0, 40);
    B.rev = (B.rev || 0) + 1;
    try {
      localStorage.setItem(KEY, JSON.stringify(B));
    } catch {
      /* private mode */
    }
    S.dirty = true;
    onChange?.();
  };
  // Another tab changed the bot (or its wallet): take its copy.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    B = load();
    // A save from another tab made before ours landed can lack this tab's trades in flight: put
    // them back (with their reserved stake), so nothing is refunded or sold twice.
    for (const [m, e2] of myPend) {
      if (!B.pend[m] && !B.booked.includes(e2.sig || '-')) {
        B.pend[m] = { ...e2 };
        B.cash -= e2.usd;
      }
    }
    for (const [m, mk] of mySell) if (B.pos[m] && !B.pos[m].sellTab) Object.assign(B.pos[m], mk);
    S.dirty = true;
    onChange?.();
  });

  // One tab trades at a time (two open tabs would buy everything twice).
  function leader() {
    const now = Date.now();
    try {
      const l = JSON.parse(localStorage.getItem(LOCK) || 'null');
      if (l && l.id !== tabId && now - l.at < 3 * TICK_MS) return false;
      localStorage.setItem(LOCK, JSON.stringify({ id: tabId, at: now }));
    } catch {
      /* private mode: this tab is the only one that can run */
    }
    return true;
  }

  const note = (msg) => B.log.unshift({ t: Date.now(), msg });
  const chainNow = () => engine()?.chain || 'solana';
  const dayStart = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const pnlToday = () => B.hist.filter((h) => h.closedAt >= dayStart()).reduce((a, h) => a + h.pnl, 0);

  /** Live rows (fresh prices only) of the bot's positions on the network on screen. */
  function liveRows() {
    const E = engine();
    if (!E) return new Map();
    const chain = E.chain;
    const mints = Object.keys(B.pos).filter((m) => B.pos[m].chain === chain);
    const out = new Map();
    for (const r of E.rowsFor(chain, mints)) if (r?.p > 0 && (!(E.since > 0) || r.pa >= E.since)) out.set(r.m, r);
    return out;
  }
  /** Mints the app should keep loaded on this network (their prices drive the exits). */
  const tracked = () => Object.keys(B.pos).filter((m) => B.pos[m].chain === chainNow());

  /** Remembers a booked trade's signature (each one is booked once, whichever tab sees it first). */
  const markBooked = (sig) => sig && (B.booked = [sig, ...B.booked.filter((x) => x !== sig)].slice(0, 100));
  /** The market price of `m` now, when the radar has a fresh one. */
  function priceNow(m, chain) {
    const E = engine();
    const r = E?.rowsFor?.(chain || 'solana', [m])[0];
    return r?.p > 0 && r.pa > 0 && Date.now() - r.pa < 30_000 ? r.p : null;
  }

  /**
   * A real buy's position from its on-chain fill. `reserved`: the stake still held for it in the
   * budget (0 if another tab already gave it back, or a stale save dropped it).
   */
  function openFromFill(m, e, f, reserved) {
    if (B.booked.includes(f.sig)) return false;
    markBooked(f.sig);
    const tokens = Number(f.tokensRaw) / 10 ** (f.decimals ?? 6);
    if (!(tokens > 0) || !(f.usdSpent > 0)) {
      // SOL went out with nothing to hold: the stake stays spent (the budget never overspends).
      note(`⚠️ Zakup $${esc(e.s || '?')} przeszedł bez tokenów — sprawdź Wallet → Tokeny`);
      return false;
    }
    // Like DEMO: the % moves (TP / SL / stall…) are measured from the market price at the moment of
    // the purchase; the all-in cost per token (fees, rent, slippage) only goes into the $ result.
    const cost = f.usdSpent / tokens;
    const px = priceNow(m, e.chain) || (e.px > 0 ? e.px : cost);
    B.cash += reserved - f.usdSpent; // what the swap really took
    const prev = B.pos[m];
    if (prev) {
      // Two fills of one mint (two tabs): one position holding both.
      const t2 = Number(prev.raw || 0) / 10 ** (prev.dec ?? 6) + tokens;
      Object.assign(prev, { usd: prev.usd + f.usdSpent, p: (prev.usd + f.usdSpent) / t2, raw: String(BigInt(prev.raw || '0') + BigInt(f.tokensRaw)) });
    } else {
      B.pos[m] = { p: cost, px, usd: f.usdSpent, fee: 0, t: Date.now(), chain: e.chain || 'solana', n: e.n || '', s: e.s || '', i: e.i || '', lq: e.lq || 0, lq0: e.lq || 0, peak: px, last: px, lastAt: Date.now(), c5: e.c5, raw: f.tokensRaw, dec: f.decimals ?? 6, sig: f.sig };
    }
    B.tx.unshift({ t: Date.now(), type: 'open', amount: f.usdSpent, s: e.s || '', m, fee: 0, sig: f.sig });
    note(`🟢 Kupiono $${esc(e.s || '?')} za ${fmt.usd(f.usdSpent)}`);
    toast(`🤖 Bot kupił $${e.s || '?'} za ${fmt.usd(f.usdSpent)}`);
    return true;
  }

  /** Real buy: the stake is reserved now, the position appears once the swap is confirmed. */
  function buyReal(r) {
    const usd = Math.min(B.cfg.buyUsd, freeCash());
    if (!(usd >= 1) || pending.has(r.m) || B.pend[r.m]) return false;
    pending.add(r.m);
    B.cash -= usd;
    const entry = { usd, t: Date.now(), tab: tabId, px: r.p, chain: chainNow(), n: r.n || '', s: r.s || '', i: r.i || '', lq: r.lq || 0, c5: r.c5 };
    B.pend[r.m] = entry;
    myPend.set(r.m, entry);
    note(`⏳ Kupuję $${esc(r.s || '?')} za ${fmt.usd(usd)} · +${(r.c5 || 0).toFixed(1)}% w 5 min`);
    let sentSig = null;
    const onSent = ({ sig, blockhash }) => {
      sentSig = sig;
      Object.assign(entry, { sig, bh: blockhash });
      if (B.pend[r.m]) Object.assign(B.pend[r.m], { sig, bh: blockhash });
      save();
    };
    // Still this attempt's reservation in the budget?
    const mine = () => {
      const e = B.pend[r.m];
      return e && e.tab === tabId && e.t === entry.t ? e : null;
    };
    deps.exec
      .buy(r.m, usd, { onSent, refPx: r.p })
      .then((f) => {
        const e = mine();
        if (e) delete B.pend[r.m];
        openFromFill(r.m, e || entry, f, e ? e.usd : 0);
      })
      .catch((e) => {
        B.cool[r.m] = Date.now(); // not again right away
        if ((!sentSig && !e.sent) || e.failed || e.expired) {
          // Proven that nothing was bought: the stake goes back.
          const own = mine();
          if (own) B.cash += own.usd;
          if (own) delete B.pend[r.m];
          note(`⚠️ Zakup $${esc(r.s || '?')} nieudany: ${esc(e.message || e)}`);
          toast(`🤖 Zakup $${r.s || '?'} nieudany: ${e.message || e}`);
        } else {
          // It went out and may have landed: the stake stays reserved until the chain says.
          note(`⚠️ Nie wiadomo jeszcze, czy zakup $${esc(r.s || '?')} wszedł — sprawdzam w sieci`);
          toast(`🤖 Sprawdzam, czy zakup $${r.s || '?'} wszedł…`);
        }
      })
      .finally(() => {
        pending.delete(r.m);
        myPend.delete(r.m);
        save();
      });
    return true;
  }

  // Trades left unresolved (a reload mid-swap, or no answer from the network): asked again until
  // the chain says what happened. Only the trading tab does it.
  let resolving = false;
  async function resolveOpen(lead) {
    if (!REAL || resolving || !deps.exec.resolve) return;
    resolving = true;
    let changed = false;
    try {
      for (const [m, e] of Object.entries(B.pend)) {
        // Each tab resolves its own trades; the trading tab also takes those of tabs that are gone.
        if (pending.has(m) || (e.tab !== tabId && (!lead || tabAlive(e.tab)))) continue;
        if (!e.sig) {
          // Never signed and sent (stopped before): nothing was bought.
          B.cash += e.usd;
          delete B.pend[m];
          note(`↩️ Zakup $${esc(e.s || '?')} przerwany przed wysłaniem — budżet zwrócony`);
          changed = true;
          continue;
        }
        const st = await deps.exec.resolve(e.sig, m, 'buy', e.bh).catch(() => ({ state: 'unknown' }));
        const cur = B.pend[m];
        if (!cur || cur.sig !== e.sig) continue;
        if (st.state === 'landed') {
          delete B.pend[m];
          openFromFill(m, cur, st.result, cur.usd);
        } else if (st.state === 'failed' || st.state === 'expired') {
          B.cash += cur.usd;
          delete B.pend[m];
          B.cool[m] = Date.now();
          note(`↩️ Zakup $${esc(cur.s || '?')} nie wszedł — budżet zwrócony`);
        } else if (Date.now() - cur.t > 15 * 60_000) {
          delete B.pend[m];
          note(`⚠️ Nie udało się ustalić, czy zakup $${esc(cur.s || '?')} wszedł — sprawdź Wallet → Tokeny`);
        } else continue;
        changed = true;
      }
      for (const [m, p] of Object.entries(B.pos)) {
        if (sellingNow.has(m)) continue;
        if (p.sellTab && p.sellTab !== tabId && (!lead || tabAlive(p.sellTab))) continue;
        if (!p.sellSig && !p.sellTab) continue;
        if (!p.sellSig) {
          // A sale that never went out (its tab is gone).
          if (p.sellTab && p.sellTab !== tabId) {
            clearSell(p);
            changed = true;
          }
          continue;
        }
        const st = await deps.exec.resolve(p.sellSig, m, 'sell', p.sellBh).catch(() => ({ state: 'unknown' }));
        const q = B.pos[m];
        if (!q || q.sellSig !== p.sellSig) continue;
        if (st.state === 'landed') {
          bookReal(m, q, q.sellF ?? 1, q.sellWhy || 'manual', { ...st.result, sig: q.sellSig });
        } else if (st.state === 'failed' || st.state === 'expired' || Date.now() - (q.sellAt || 0) > 15 * 60_000) {
          clearSell(q); // the exits will try again
        } else continue;
        changed = true;
      }
    } finally {
      resolving = false;
      if (changed) save();
    }
  }
  /** Whether this tab trades now (read only: doesn't take the lock). */
  function isLeader() {
    try {
      const l = JSON.parse(localStorage.getItem(LOCK) || 'null');
      return !l || l.id === tabId || Date.now() - l.at >= 3 * TICK_MS;
    } catch {
      return true;
    }
  }
  setInterval(() => REAL && resolveOpen(isLeader()), 20_000);

  function buy(r) {
    if (REAL) return buyReal(r);
    const cfg = B.cfg;
    const usd = Math.min(cfg.buyUsd, B.cash);
    if (!(usd >= 1)) return false;
    const chain = chainNow();
    const fee = tradeFee(usd, chain);
    if (fee >= usd * 0.5) return false;
    // Fills above the screen price: the pool's price impact, then fees buy fewer tokens.
    const fill = r.p * (1 + impact(usd, r.lq));
    const entry = fill * (usd / (usd - fee));
    B.cash -= usd;
    B.feesPaid += fee;
    B.pos[r.m] = { p: entry, px: r.p, usd, fee, t: Date.now(), chain, n: r.n || '', s: r.s || '', i: r.i || '', lq: r.lq || 0, lq0: r.lq || 0, peak: r.p, last: r.p, lastAt: Date.now(), c5: r.c5 };
    B.tx.unshift({ t: Date.now(), type: 'open', amount: usd, s: r.s || '', m: r.m, fee });
    note(`🟢 Kupno $${esc(r.s || '?')} za ${fmt.usd(usd)} · +${(r.c5 || 0).toFixed(1)}% w 5 min`);
    return true;
  }

  /** Selling position `p` at `px`: what comes back after the pool's price impact and the fees. */
  function proceeds(p, px) {
    const gross = Math.max(0, p.usd * ((px * (1 - impact(p.usd * (px / p.px || 1), sellLiq(p.lq0 ?? p.lq, p.lq)))) / p.p));
    const fee = Math.min(gross, tradeFee(gross, p.chain));
    return { gross, fee, back: gross - fee };
  }

  /** Books a sale (real or simulated) into the bot's wallet and history. */
  function book(m, p, f, back, fee, move, why) {
    const part = p.usd * f;
    const buyFee = (p.fee || 0) * f;
    const pnl = back - part;
    B.cash += back;
    B.feesPaid += fee;
    if (f >= 1) {
      delete B.pos[m];
      B.cool[m] = Date.now();
    } else {
      p.usd -= part;
      p.fee = (p.fee || 0) - buyFee;
      p.part = true;
    }
    B.hist.unshift({ m, s: p.s, n: p.n, chain: p.chain, usd: part, pnl, pct: move, fee: fee + buyFee, why, f, openedAt: p.t, closedAt: Date.now() });
    B.tx.unshift({ t: Date.now(), type: 'close', amount: back, s: p.s || '', m, pnl, fee });
    note(`${pnl >= 0 ? '✅' : '🔻'} ${EXIT_NAMES[why] || why}: $${esc(p.s || '?')} ${fmt.pct(move)} (${money(pnl)}${REAL ? '' : ' po opłatach'})`);
    return pnl;
  }

  const clearSell = (q) => {
    for (const k of ['sellSig', 'sellBh', 'sellF', 'sellWhy', 'sellAt', 'sellTab']) delete q[k];
  };
  /** Books a confirmed real sale. */
  function bookReal(m, q, f, why, r) {
    clearSell(q);
    if (B.booked.includes(r.sig)) return null;
    markBooked(r.sig);
    const sold = Number(r.tokensSold) / 10 ** (q.dec ?? 6);
    const move = sold > 0 ? (r.usdReceived / sold / (q.px || q.p) - 1) * 100 : 0;
    if (f < 1) q.raw = String(BigInt(q.raw || '0') - BigInt(r.tokensSold || '0'));
    const pnl = book(m, q, f, r.usdReceived, 0, move, why);
    toast(`🤖 ${EXIT_NAMES[why] || why}: $${q.s || '?'} ${money(pnl)}`);
    return pnl;
  }

  /** A sale of `m` running here or in another tab, or sent and not yet resolved. */
  const sellBusy = (m, p) => sellingNow.has(m) || !!p.sellSig || (!!p.sellTab && p.sellTab !== tabId && tabAlive(p.sellTab));

  /** Real sale: a swap of the position's tokens (all of them on a full close). */
  function sellReal(m, why, frac, refPx) {
    const p = B.pos[m];
    if (!p || sellBusy(m, p) || Date.now() < (retryAt.get(m) || 0)) return null;
    if (!canTrade()) {
      // Locked: nothing can be signed. The next price after the unlock sells; one reminder a minute.
      if (Date.now() - (S.lockWarnAt || 0) > 60_000) {
        S.lockWarnAt = Date.now();
        toast(`🔒 ${EXIT_NAMES[why] || why} na $${p.s || '?'} — odblokuj wallet, żeby bot mógł sprzedać`);
      }
      return null;
    }
    const f = Math.min(1, Math.max(0, frac));
    const raw = f >= 1 || !p.raw ? p.raw || 'all' : String((BigInt(p.raw) * BigInt(Math.round(f * 1000))) / 1000n);
    if (raw !== 'all' && !(BigInt(raw) > 0n)) {
      if (f < 1) return null; // too little for a partial sale
      book(m, p, 1, 0, 0, -100, 'gone'); // a record without tokens
      return 0;
    }
    sellingNow.add(m);
    const marks = { sellAt: Date.now(), sellTab: tabId, sellF: f, sellWhy: why };
    Object.assign(p, marks);
    mySell.set(m, marks);
    save();
    let sentSig = null;
    const onSent = ({ sig, blockhash }) => {
      sentSig = sig;
      Object.assign(marks, { sellSig: sig, sellBh: blockhash });
      const q = B.pos[m];
      if (q) Object.assign(q, { sellSig: sig, sellBh: blockhash });
      save();
    };
    deps.exec
      .sell(m, raw, { onSent, refPx })
      .then((r) => {
        // Booked once: here, unless another tab already booked this signature.
        const q = B.pos[m];
        if (q && (!q.sellSig || q.sellSig === r.sig)) bookReal(m, q, f, why, r);
      })
      .catch((e) => {
        const q = B.pos[m];
        if (!q) return;
        if ((sentSig || e.sent) && !e.failed && !e.expired) {
          // It went out and may have sold: the chain decides (resolveOpen), not a second sale.
          q.sellAt = Date.now();
          note(`⚠️ Nie wiadomo jeszcze, czy sprzedaż $${esc(q.s || '?')} weszła — sprawdzam w sieci`);
          return;
        }
        clearSell(q);
        if (e.empty) {
          // Sold outside the bot (or never arrived): nothing left to sell — the record closes.
          book(m, q, 1, 0, 0, -100, 'gone');
          note(`⚠️ $${esc(q.s || '?')}: brak tokenów w walletcie — pozycja zamknięta`);
          return;
        }
        retryAt.set(m, Date.now() + 10_000);
        note(`⚠️ Sprzedaż $${esc(q.s || '?')} nieudana: ${esc(e.message || e)} — ponowię`);
        toast(`🤖 Sprzedaż $${q.s || '?'} nieudana — ponowię za 10 s`);
      })
      .finally(() => {
        sellingNow.delete(m);
        mySell.delete(m);
        save();
      });
    return 0;
  }

  /** Sells position `m` (all of it, or `frac` of it) at `price`; returns the result in $. */
  function sell(m, price, why, frac = 1) {
    if (REAL) return sellReal(m, why, frac, price);
    const p = B.pos[m];
    if (!p) return null;
    let px = price > 0 ? price : p.last;
    // A guaranteed stop: closes at exactly −SL% from the buy price, also when the price gapped
    // past it between two reads (set 8% → sold at −8%).
    if (why === 'sl') px = (p.px || p.p) * (1 - B.cfg.sl / 100);
    // …and take profit sells at its level (a jump past it doesn't add a windfall).
    else if (why === 'tp') px = Math.min(px, (p.px || p.p) * (1 + B.cfg.tp / 100));
    else if (why === 'part') px = Math.min(px, (p.px || p.p) * (1 + B.cfg.partAt / 100));
    const f = Math.min(1, Math.max(0, frac));
    const { fee, back } = proceeds({ ...p, usd: p.usd * f }, px);
    return book(m, p, f, back, fee, movePct(p, px), why);
  }

  function candidates() {
    const E = engine();
    if (!E) return [];
    const base = { minMcap: 0, minLiq: 0, maxAgeH: 0, safe: false, q: '' };
    const seen = new Map();
    for (const [view, n] of [['hype', 150], ['surge', 80], ['new', 40]]) for (const r of E.snapshot(view, base, n).rows) seen.set(r.m, r);
    const now = Date.now();
    // Own price history (last 5 min) of every token on the lists: the 30 s / 60 s moves.
    for (const r of seen.values()) {
      if (!(r.p > 0)) continue;
      let h = S.px.get(r.m);
      if (!h) S.px.set(r.m, (h = []));
      if (!h.length || h[h.length - 1][1] !== r.p) h.push([now, r.p]);
      while (h.length && now - h[0][0] > 300_000) h.shift();
    }
    if (S.px.size > 1500) for (const [m, h] of S.px) if (!h.length || now - h[h.length - 1][0] > 300_000) S.px.delete(m);
    return [...seen.values()];
  }
  /** The token's price change in % over the last `ms` (null without history that long). */
  function ret(m, ms, now = Date.now()) {
    const h = S.px.get(m);
    if (!h || !h.length || now - h[0][0] < ms * 0.8) return null;
    let a = h[0][1];
    for (const [t, p] of h) if (t <= now - ms) a = p;
    const b = h[h.length - 1][1];
    return a > 0 ? (b / a - 1) * 100 : null;
  }

  /** A new price for position `m`: exits checked right away. True when it was sold. */
  function onPrice(m, price, lq, now = Date.now(), at = 0) {
    const p = B.pos[m];
    if (!p || !(price > 0)) return false;
    // The held read itself (the same radar row again, no new data) never confirms itself.
    if (p.pend > 0 && at > 0 && at === p.pendAt) return false;
    // A feed glitch (one read ×3 off) must not sell: such a price counts once the next read agrees.
    const g = checkGlitch(p.last, p.pend, price);
    p.pend = g.pend;
    p.pendAt = g.pend ? at : 0;
    if (!g.ok) return false;
    p.last = price;
    p.lastAt = now;
    if (lq > 0) p.lq = lq;
    const why = exitReason(p, price, B.cfg, now);
    p.peak = Math.max(p.peak || 0, price);
    if (!why) return false;
    const pnl = sell(m, price, why, why === 'part' ? 0.5 : 1);
    if (REAL) return false; // the swap books itself (and saves) once confirmed
    toast(`🤖 ${EXIT_NAMES[why]}: $${p.s || '?'} ${money(pnl)}`);
    return true;
  }

  // Live prices of the bot's positions every second (the radar's aggregators refresh every few
  // seconds; a fast dump would blow past the stop loss): one position per second, the one read
  // longest ago first — on Solana straight from the pool on chain, else Jupiter / DexScreener.
  let liveBusy = false;
  async function liveLoop() {
    const E = engine();
    if (!E?.live || liveBusy || document.hidden) return;
    const chain = E.chain;
    const mine = Object.entries(B.pos).filter(([, p]) => p.chain === chain);
    if (!mine.length) return;
    try {
      const l = JSON.parse(localStorage.getItem(LOCK) || 'null');
      if (l && l.id !== tabId) return; // another tab trades
    } catch {
      /* private mode */
    }
    const [m] = mine.sort((a, b) => (a[1].liveAt || 0) - (b[1].liveAt || 0))[0];
    liveBusy = true;
    try {
      const r = await E.live(m);
      if (E.chain !== chain || !B.pos[m]) return;
      B.pos[m].liveAt = Date.now();
      if (r?.p > 0 && onPrice(m, r.p, 0)) save();
    } catch {
      /* the regular tick still has the radar's price */
    } finally {
      liveBusy = false;
    }
  }
  setInterval(liveLoop, 1000);

  function tick() {
    const E = engine();
    if (!E || document.hidden) return;
    if (!leader()) return;
    const now = Date.now();
    const cfg = B.cfg;
    let changed = false;
    // Exits first, on fresh prices (a paused network's positions wait until it is back on screen).
    const live = liveRows();
    for (const m of Object.keys(B.pos)) {
      const r = live.get(m);
      if (r && !(B.pos[m].liveAt > (r.pa || 0))) changed = onPrice(m, r.p, r.lq, now, r.pa) || changed;
    }
    if (B.on && cfg.maxDayLoss > 0 && pnlToday() <= -cfg.maxDayLoss) {
      B.on = false;
      note(`⛔ Dzienny limit straty (${fmt.usd(cfg.maxDayLoss)}) — bot zatrzymany`);
      toast('🤖 Bot zatrzymany: dzienny limit straty');
      changed = true;
    }
    // Entries: one buy per tick at most, the strongest signal first.
    if (B.on && Object.keys(B.pos).length + Object.keys(B.pend).length < cfg.maxPos && !(REAL && !canTrade())) {
      if (freeCash() < 1) {
        if (!S.lowCash) note(REAL ? '💸 Za mało SOL w walletcie Spot — wpłać SOL (Wallet → Spot)' : '💸 Brak kapitału — doładuj bota w Wallet → BOT');
        S.lowCash = true;
      } else {
        S.lowCash = false;
        const chain = E.chain;
        const rows = candidates();
        let checked = 0;
        const best = rows
          .filter((r) => {
            if (B.pos[r.m] || B.pend[r.m] || pending.has(r.m) || excluded(r) || now - (B.cool[r.m] || 0) < cfg.cooldownMin * 60_000) return false;
            // A fresh price only (a paused network's rows are hours old for a moment after a switch).
            if (!(r.pa > 0) || now - r.pa > 60_000 || (E.since > 0 && r.pa < E.since)) return false;
            checked++;
            return !rejectReason(r, cfg, now, (ms) => ret(r.m, ms, now));
          })
          .sort((a, b) => signalScore(b) - signalScore(a));
        S.lastScan = { t: now, n: checked, hits: best.length, chain };
        if (best[0] && buy(best[0])) {
          if (!REAL) toast(`🤖 Bot kupił $${best[0].s || '?'} za ${fmt.usd(B.pos[best[0].m].usd)}`);
          changed = true;
        }
      }
    }
    for (const m of Object.keys(B.cool)) if (now - B.cool[m] > DAY_MS) delete B.cool[m];
    // Latest prices / peaks are kept every 10 s (the trailing stop needs its peak after a reload).
    if (changed || (Object.keys(B.pos).length && now - (S.savedAt || 0) > 10_000)) {
      S.savedAt = now;
      save();
    }
    S.dirty = true;
  }
  setInterval(tick, TICK_MS);

  // ---------- panel (BOT tab, above the radar list) ----------
  const sign = (v) => (v >= 0 ? '+' : '−');
  const money = (v) => `${sign(v)}${Math.abs(v) < 100 ? `$${Math.abs(v).toFixed(2)}` : fmt.usd(Math.abs(v))}`;
  const feeUsd = (v) => `$${(v || 0).toFixed(2)}`;

  function positionsView() {
    const now = Date.now();
    return Object.entries(B.pos)
      .map(([m, p]) => {
        const ratio = p.last > 0 ? proceeds(p, p.last).back / p.usd : null;
        return { m, p, pct: p.last > 0 ? movePct(p, p.last) : null, pnl: ratio ? p.usd * (ratio - 1) : null, value: ratio ? p.usd * ratio : p.usd, stale: now - (p.lastAt || 0) > 60_000, other: p.chain !== chainNow() };
      })
      .sort((a, b) => b.p.t - a.p.t);
  }
  function stats() {
    const pos = positionsView();
    const inPos = pos.reduce((a, x) => a + x.value, 0);
    const done = B.hist;
    // Finished trades = positions (a half sale and the rest are one trade); a partly sold position
    // still open counts once it closes.
    const trades = new Map();
    for (const h of done) {
      if (B.pos[h.m]?.t === h.openedAt) continue;
      const k = `${h.m}:${h.openedAt}`;
      trades.set(k, (trades.get(k) ?? 0) + h.pnl);
    }
    const n = trades.size;
    const wins = [...trades.values()].filter((v) => v > 0).length;
    return { pos, inPos, equity: B.cash + inPos, total: done.reduce((a, h) => a + h.pnl, 0), today: pnlToday(), any: done.length > 0, n, wins, rate: n ? (wins / n) * 100 : null };
  }

  function settingsHtml() {
    const c = B.cfg;
    return `<details class="bot-set" ${B.cfg.open === false ? '' : 'open'}><summary>⚙️ Ustawienia bota</summary>
      ${FIELD_GROUPS.map(([title, fields]) => `<h4 class="bot-gh">${title}</h4><div class="bot-grid">${fields.map(([k, label, unit, min, max, step, hint]) => `<label title="${esc(hint)}"><span>${label}${unit ? ` <small>${unit}</small>` : ''}</span><input type="number"${min < 0 ? '' : ' inputmode="decimal"'} data-bot-cfg="${k}" min="${min}" max="${max}" step="${step}" value="${c[k]}" /></label>`).join('')}</div>`).join('')}
      <label class="toggle-row"><input type="checkbox" data-bot-cfg="rising" ${c.rising ? 'checked' : ''} /> <span>Wymagaj rosnących ostatnich cen</span></label>
      <label class="toggle-row"><input type="checkbox" data-bot-cfg="gradOnly" ${c.gradOnly ? 'checked' : ''} /> <span>Tylko tokeny po graduacji (bez bonding curve)</span></label>
      <div class="bot-acts"><button data-bot="defaults">🏆 Zalecana strategia</button></div>
      <p class="note"><b>Zalecana strategia</b> (🏆) została dobrana na 4 godzinach nagranych danych z radaru Solany — dwóch niezależnych sesjach, w każdej godzinie na plusie po opłatach. Bot kupuje tylko <b>silne wybicia</b>: +30% w 5 min przy wolumenie 3× większym niż zwykle, w małych, wczesnych pulach (płynność $15–50k, token do 12 h), zanim ranking hype je „przegrzeje”, z przewagą kupujących, bez tokenów po +300% w godzinę (częste zrzuty). Pozycję, która w 2 minuty nie urośnie o 3%, zamyka; stop loss 8%; zwycięzcom pozwala urosnąć do +150% (maks. 20 min). Wygrywa ok. 40–60% transakcji, ale średni zysk jest kilka razy większy niż średnia strata.</p>
      <p class="note">Co 2 s bot przegląda listy Hype, Wybicia wolumenu i Nowe na wybranej sieci. Procenty TP / SL to zmiana ceny od zakupu — dokładnie tyle, ile ustawisz (stop loss gwarantowany, take profit realizowany na swoim poziomie). Kwota w $ pokazuje wynik po opłatach (ok. 3% za kupno i sprzedaż razem) i poślizgu. Ceny pozycji bota są czytane na żywo co ~1 s, a pojedynczy błędny odczyt ceny (skok ×3, który zaraz wraca) jest ignorowany. Wyniki z przeszłości nie gwarantują przyszłych — rynek memecoinów zmienia się z godziny na godzinę. Bot działa, gdy aplikacja jest otwarta na ekranie.</p>
    </details>`;
  }

  function statusHtml() {
    const s = stats();
    const low = freeCash() < 1 && !Object.keys(B.pos).length && !Object.keys(B.pend).length;
    const locked = REAL && !canTrade();
    const full = Object.keys(B.pos).length + Object.keys(B.pend).length >= B.cfg.maxPos;
    const idle = !isLeader() ? 'Bot handluje w innej karcie' : full ? 'Komplet pozycji — czekam na wyjście' : locked ? '' : freeCash() < 1 ? '' : 'Startuje…';
    const scan = S.lastScan && Date.now() - S.lastScan.t < 10_000 ? `Skan: ${S.lastScan.n} tokenów, ${S.lastScan.hits} z sygnałem` : B.on ? idle : '';
    return `<div class="bot-head">
        <div class="bot-title"><b>🤖 BOT ${REAL ? 'REAL' : 'DEMO'}</b><span class="bot-pill ${B.on ? 'on' : ''}">${B.on ? '● Działa' : 'Zatrzymany'}</span></div>
        <button class="bot-toggle ${B.on ? 'stop' : ''}" data-bot="toggle">${B.on ? '■ Stop' : '▶ Start'}</button>
      </div>
      <div class="bot-stats">
        <div><span>${REAL ? 'Wallet Spot (wolne)' : 'Kapitał bota'}</span><b>${fmt.usd(freeCash())}</b></div>
        <div><span>W pozycjach</span><b>${fmt.usd(s.inPos)}</b></div>
        <div><span>Dziś</span><b class="${s.today >= 0 ? 'up' : 'down'}">${s.any ? money(s.today) : '—'}</b></div>
        <div><span>Łącznie</span><b class="${s.total >= 0 ? 'up' : 'down'}">${s.any ? money(s.total) : '—'}</b></div>
        <div><span>Transakcje</span><b>${s.n}${s.rate != null ? ` <small>${Math.round(s.rate)}% wygr.</small>` : ''}</b></div>
      </div>
      ${locked ? `<div class="bot-warn">🔒 Wallet zablokowany — bot nie kupi ani nie sprzeda. <button data-bot="vault">Odblokuj</button></div>` : ''}
      ${low ? (REAL ? `<div class="bot-warn">Za mało SOL w walletcie Spot. <button data-bot="vault">⬇️ Wpłać w Wallet → Spot</button></div>` : `<div class="bot-warn">Bot nie ma kapitału. <button data-bot="wallet">⬇️ Doładuj w Wallet → BOT</button></div>`) : ''}
      ${Object.keys(B.pend).length ? `<p class="note bot-scan">⏳ Zakupy w toku: ${Object.keys(B.pend).length}</p>` : ''}
      ${scan ? `<p class="note bot-scan">${scan}</p>` : ''}`;
  }

  function positionsHtml() {
    const s = stats();
    const rows = s.pos
      .map((x) => `<div class="bot-pos">
          <button class="bot-tok" data-bot-open="${esc(x.m)}">${x.p.i ? `<img src="${esc(x.p.i)}" alt="" loading="lazy" />` : ''}<b>$${esc(x.p.s || '?')}</b><small>${fmt.dur(Date.now() - x.p.t)}${x.other ? ' · inna sieć' : x.stale ? ' · brak ceny' : ''}</small></button>
          <div class="bot-pnl"><b class="${(x.pnl || 0) >= 0 ? 'up' : 'down'}">${x.pnl != null ? money(x.pnl) : '—'}</b><small>${fmt.pct(x.pct)} · ${fmt.usd(x.p.usd)}</small></div>
          <button class="bot-sell" data-bot-sell="${esc(x.m)}">Sprzedaj</button>
        </div>`)
      .join('');
    const log = B.log.slice(0, 12).map((l) => `<div><small>${fmt.ago(l.t)}</small> ${l.msg}</div>`).join('');
    return `<h3 class="pos-h">Pozycje bota <small>${s.pos.length}/${B.cfg.maxPos}</small></h3>
      ${rows || `<p class="note">${B.on ? 'Bot szuka tokenów z rosnącym wykresem…' : 'Brak pozycji. Ustaw parametry i naciśnij Start.'}</p>`}
      ${log ? `<h3 class="pos-h">Dziennik</h3><div class="bot-log">${log}</div>` : ''}`;
  }

  function render(el) {
    if (!el) return;
    if (!el.querySelector('#botStatus')) {
      el.innerHTML = `<div id="botStatus"></div><div id="botPos"></div><div id="botSet"></div>`;
      el.querySelector('#botSet').innerHTML = settingsHtml();
      el.addEventListener('click', onClick);
      el.addEventListener('change', onChange_);
      el.addEventListener('toggle', (e) => {
        if (e.target.matches?.('details.bot-set')) {
          B.cfg.open = e.target.open;
          save();
        }
      }, true);
      el.addEventListener('touchstart', () => (S.touch = Date.now() + 60_000), { passive: true });
      for (const ev of ['touchend', 'touchcancel']) el.addEventListener(ev, () => (S.touch = Date.now() + 400), { passive: true });
    }
    // A finger on the panel: wait (a rebuilt button loses the tap on iOS).
    if (Date.now() < S.touch) return;
    for (const [id, html] of [['#botStatus', statusHtml()], ['#botPos', positionsHtml()]]) {
      const box = el.querySelector(id);
      if (box.dataset.html !== html) {
        box.dataset.html = html;
        box.innerHTML = html;
      }
    }
  }

  function syncInputs(root) {
    for (const inp of root.querySelectorAll('[data-bot-cfg]')) {
      const k = inp.dataset.botCfg;
      if (inp.type === 'checkbox') inp.checked = !!B.cfg[k];
      else if (document.activeElement !== inp) inp.value = B.cfg[k];
    }
  }

  function onChange_(e) {
    const inp = e.target.closest('[data-bot-cfg]');
    if (!inp) return;
    const k = inp.dataset.botCfg;
    if (inp.type === 'checkbox') B.cfg[k] = inp.checked;
    else {
      const f = FIELDS.find((x) => x[0] === k);
      const raw = String(inp.value).trim();
      const v = Number(raw.replace(',', '.'));
      // An emptied / unparseable field is not 0: the saved value comes back.
      if (!f || raw === '' || inp.validity?.badInput || !Number.isFinite(v)) return (inp.value = B.cfg[k]);
      B.cfg[k] = Math.max(f[3], Math.min(f[4], v));
      inp.value = B.cfg[k];
    }
    save();
    toast('🤖 Zapisano ustawienia bota');
  }

  function onClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    const act = b.dataset.bot;
    if (act === 'toggle') {
      if (!B.on && REAL) {
        if (!canTrade()) return toast('Najpierw odblokuj wallet hasłem (Wallet → Spot)');
        if (!confirm(`Uruchomić bota na PRAWDZIWYCH środkach?\n\nBot kupuje za SOL z walletu Spot (wolne: ${fmt.usd(freeCash())}) — tymi samymi środkami co radar.\nZakup: ${fmt.usd(B.cfg.buyUsd)} · maks. ${B.cfg.maxPos} pozycje naraz (do ${fmt.usd(B.cfg.buyUsd * B.cfg.maxPos)} w pozycjach) · dzienny limit straty: ${B.cfg.maxDayLoss > 0 ? fmt.usd(B.cfg.maxDayLoss) : 'brak'}.\nBot sam kupuje i sprzedaje, dopóki aplikacja jest otwarta.`)) return;
      }
      B.on = !B.on;
      if (B.on && !engine()) {
        B.on = false;
        return toast('Bot działa tylko w wersji z danymi na żywo');
      }
      note(B.on ? '▶ Bot uruchomiony' : '■ Bot zatrzymany (otwarte pozycje dalej pilnują TP / SL)');
      save();
      toast(B.on ? '🤖 Bot uruchomiony' : '🤖 Bot zatrzymany');
    } else if (act === 'defaults') {
      B.cfg = { ...DEFAULTS, buyUsd: B.cfg.buyUsd, maxDayLoss: B.cfg.maxDayLoss, open: true };
      syncInputs(b.closest('#botPanel') || document);
      save();
      toast('🏆 Ustawiono zalecaną strategię');
    } else if (act === 'wallet') openWallet();
    else if (act === 'vault') (deps.openVault || openWallet)();
    else if (b.dataset.botOpen) openToken(b.dataset.botOpen);
    else if (b.dataset.botSell) {
      const m = b.dataset.botSell;
      const p = B.pos[m];
      if (!p) return;
      if (p.chain !== chainNow()) return toast('Ta pozycja jest na innej sieci — przełącz sieć, żeby sprzedać');
      const r = liveRows().get(m);
      if (REAL) {
        if (!canTrade()) return toast('Najpierw odblokuj wallet hasłem');
        if (sellBusy(m, p)) return toast('Sprzedaż już trwa…');
        retryAt.delete(m); // a tap is the retry: no waiting out the 10 s back-off
        if (sell(m, r?.p || p.last, 'manual') == null) return toast('Nie mogę teraz sprzedać — spróbuj za chwilę');
        toast(`⏳ Sprzedaję $${p.s || '?'}…`);
      } else {
        const pnl = sell(m, r?.p || p.last, 'manual');
        save();
        toast(`🤖 Sprzedano $${p.s || '?'} ${money(pnl)}`);
      }
    }
    S.touch = 0;
    render(b.closest('#botPanel'));
  }

  // ---------- Wallet → BOT ----------
  function calendarHtml() {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() - S.calMonth, 1);
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const byDay = new Map();
    const counted = new Set(); // one trade per position and day (a half sale + the rest)
    for (const h of B.hist) {
      const dt = new Date(h.closedAt);
      if (dt.getFullYear() !== first.getFullYear() || dt.getMonth() !== first.getMonth()) continue;
      const o = byDay.get(dt.getDate()) || { pnl: 0, n: 0 };
      o.pnl += h.pnl;
      const ck = `${h.m}:${h.openedAt}:${dt.getDate()}`;
      if (!counted.has(ck)) {
        counted.add(ck);
        o.n++;
      }
      byDay.set(dt.getDate(), o);
    }
    const total = [...byDay.values()].reduce((a, o) => a + o.pnl, 0);
    const lead = (first.getDay() + 6) % 7;
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<div class="cal-d empty"></div>');
    const today = S.calMonth === 0 ? now.getDate() : -1;
    const short = (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.abs(v) >= 10 ? Math.round(v) : v.toFixed(1));
    for (let d = 1; d <= days; d++) {
      const o = byDay.get(d);
      const cls = o ? (o.pnl > 0 ? 'win' : o.pnl < 0 ? 'loss' : 'flat') : '';
      cells.push(`<div class="cal-d ${cls}${d === today ? ' today' : ''}" title="${o ? `${o.n} transakcji · ${sign(o.pnl)}$${Math.abs(o.pnl).toFixed(2)}` : ''}"><span>${d}</span>${o ? `<b>${sign(o.pnl)}${short(Math.abs(o.pnl))}</b>` : ''}</div>`);
    }
    const month = first.toLocaleString('pl-PL', { month: 'long', year: 'numeric' });
    return `<h3 class="pos-h">Kalendarz PnL bota</h3>
      <div class="cal"><div class="cal-head"><button data-bcal="1" aria-label="Poprzedni miesiąc">‹</button><b>${month}</b><span class="${total > 0 ? 'up' : total < 0 ? 'down' : 'muted'}">${byDay.size ? money(total) : '—'}</span><button data-bcal="-1" ${S.calMonth === 0 ? 'disabled' : ''} aria-label="Następny miesiąc">›</button></div>
        <div class="cal-grid">${['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'].map((x) => `<div class="cal-w">${x}</div>`).join('')}${cells.join('')}</div></div>`;
  }

  function renderWallet(el) {
    if (!el) return;
    const s = stats();
    if (REAL) return renderWalletReal(el, s);
    const pnl = s.equity - B.deposits;
    const TX = { deposit: ['⬇️', REAL ? 'Przydzielony budżet' : 'Doładowanie'], withdraw: ['⬆️', 'Wypłata do Spot'], open: ['🤖', 'Kupno bota'], close: ['✅', 'Sprzedaż bota'], reset: ['♻️', 'Reset bota'] };
    const card = `<div class="wallet-card">
        <span>${REAL ? 'Budżet bota (wolny)' : 'Kapitał bota'}</span><b>${fmt.usd(B.cash)}</b>
        <div class="wallet-sub"><div><span>W pozycjach</span><b>${fmt.usd(s.inPos)}</b></div><div><span>Razem</span><b>${fmt.usd(s.equity)}</b></div>
          <div><span>Wynik</span><b class="${pnl >= 0 ? 'up' : 'down'}">${B.deposits > 0 ? `${money(pnl)} <small>${fmt.pct((pnl / B.deposits) * 100)}</small>` : '—'}</b></div></div>
      </div>`;
    const statsCard = `<div class="card"><h3>Statystyki bota</h3><div class="bot-stats">
        <div><span>Transakcje</span><b>${s.n}</b></div>
        <div><span>Wygrane</span><b class="up">${s.wins}</b></div>
        <div><span>Skuteczność</span><b>${s.rate != null ? `${Math.round(s.rate)}%` : '—'}</b></div>
        <div><span>Opłaty</span><b>${feeUsd(B.feesPaid)}</b></div>
        <div><span>Status</span><b>${B.on ? '● Działa' : 'Stop'}</b></div>
      </div></div>`;
    const hist = `<p class="note">${REAL ? 'Przydzielono' : 'Wpłacono'} łącznie ${fmt.usd(B.deposits)}.</p><h3 class="pos-h">Historia</h3>
      <div class="pos-closed">${
        B.tx.slice(0, 30).map((t) => `<div><span>${TX[t.type]?.[0] || '•'} ${TX[t.type]?.[1] || t.type}${t.s ? ` <small>$${esc(t.s)}</small>` : ''} <small>· ${fmt.ago(t.t)}</small></span><b class="${t.type === 'open' || t.type === 'withdraw' ? 'down' : t.type === 'reset' ? '' : 'up'}">${t.type === 'open' || t.type === 'withdraw' ? '−' : t.type === 'reset' ? '' : '+'}${fmt.usd(t.amount)}${t.pnl != null ? ` <small class="${t.pnl >= 0 ? 'up' : 'down'}">(${money(t.pnl)})</small>` : ''}${t.fee > 0 ? `<small class="muted tx-fee">opłaty ${feeUsd(t.fee)}</small>` : ''}</b></div>`).join('') ||
        `<div><span class="muted">Brak operacji — ${REAL ? 'przydziel budżet' : 'doładuj kapitał bota'}, żeby zaczął handlować.</span></div>`
      }</div>`;
    if (!el.querySelector('#bwCard')) {
      el.innerHTML = `<div id="bwCard"></div><div id="bwCal"></div>
        ${`<div class="card wallet-top"><h3>Doładuj kapitał bota DEMO</h3>
          <div class="pos-form"><input id="botTopUp" type="number" inputmode="decimal" min="0" step="any" placeholder="Kwota w $" /><button data-bw="topup">⬇️ Doładuj</button></div>
          <div class="quick-amt">${[100, 500, 1000, 5000].map((v) => `<button data-bw-amt="${v}">+$${fmt.n(v)}</button>`).join('')}</div>
          <p class="note">Osobny wallet bota — wirtualne pieniądze, niezależne od Spot i Perpetuals. Za kapitał bot kupuje tokeny według ustawień w zakładce BOT.</p>
        </div>
        <div id="bwStats"></div><div id="bwHist"></div>
        <div class="d-acts" style="margin-top:16px"><button data-bw="reset">♻️ Wyzeruj bota DEMO</button></div>`}`;
      el.addEventListener('click', onWalletClick);
    }
    for (const [id, html] of [['#bwCard', card], ['#bwCal', calendarHtml()], ['#bwStats', statsCard], ['#bwHist', hist]]) {
      const box = el.querySelector(id);
      if (box.dataset.html !== html) {
        box.dataset.html = html;
        box.innerHTML = html;
      }
    }
  }

  /**
   * Wallet → BOT in REAL: no separate money — the bot trades from the Spot wallet (shared with the
   * radar); here are its share of it, its results and its history.
   */
  function renderWalletReal(el, s) {
    const total = B.hist.reduce((a, h) => a + h.pnl, 0);
    const TX = { open: ['🤖', 'Kupno bota'], close: ['✅', 'Sprzedaż bota'], reset: ['♻️', 'Reset statystyk'] };
    const card = `<div class="wallet-card real">
        <span>Wallet Spot — wspólny dla radaru i bota</span><b>${fmt.usd(freeCash())} <small>wolne</small></b>
        <div class="wallet-sub"><div><span>W pozycjach bota</span><b>${fmt.usd(s.inPos)}</b></div><div><span>Dziś</span><b class="${s.today >= 0 ? 'up' : 'down'}">${s.any ? money(s.today) : '—'}</b></div>
          <div><span>Wynik bota</span><b class="${total >= 0 ? 'up' : 'down'}">${s.any ? money(total) : '—'}</b></div></div>
      </div>`;
    const statsCard = `<div class="card"><h3>Statystyki bota</h3><div class="bot-stats">
        <div><span>Transakcje</span><b>${s.n}</b></div>
        <div><span>Wygrane</span><b class="up">${s.wins}</b></div>
        <div><span>Skuteczność</span><b>${s.rate != null ? `${Math.round(s.rate)}%` : '—'}</b></div>
        <div><span>Maks. w pozycjach</span><b>${fmt.usd(B.cfg.buyUsd * B.cfg.maxPos)}</b></div>
        <div><span>Status</span><b>${B.on ? '● Działa' : 'Stop'}</b></div>
      </div></div>`;
    const tx = B.tx.filter((t) => TX[t.type]).slice(0, 30);
    const hist = `<h3 class="pos-h">Historia bota</h3><div class="pos-closed">${
      tx.map((t) => `<div><span>${TX[t.type][0]} ${TX[t.type][1]}${t.s ? ` <small>$${esc(t.s)}</small>` : ''} <small>· ${fmt.ago(t.t)}</small>${t.sig ? ` <a href="https://solscan.io/tx/${esc(t.sig)}" target="_blank" rel="noopener noreferrer">tx ↗</a>` : ''}</span><b class="${t.type === 'open' ? 'down' : t.type === 'reset' ? '' : 'up'}">${t.type === 'open' ? '−' : t.type === 'reset' ? '' : '+'}${fmt.usd(t.amount)}${t.pnl != null ? ` <small class="${t.pnl >= 0 ? 'up' : 'down'}">(${money(t.pnl)})</small>` : ''}</b></div>`).join('') ||
      '<div><span class="muted">Bot jeszcze nie handlował.</span></div>'
    }</div>`;
    if (!el.querySelector('#bwCard') || el.dataset.real !== '1') {
      el.dataset.real = '1';
      el.innerHTML = `<div id="bwCard"></div>
        <div class="card"><p class="note" style="margin:0">Bot handluje <b>tymi samymi środkami co radar</b> — SOL z walletu Spot. Nie ma osobnego budżetu: SOL wpłacasz w <b>Wallet → Spot</b>, a ryzyko bota ograniczasz w zakładce BOT: kwota zakupu × maks. liczba pozycji i dzienny limit straty. Zostaw w walletcie ok. 0.01 SOL na opłaty.</p>
          <div class="bot-acts"><button data-bw="spot">👛 Wallet → Spot</button></div></div>
        <div id="bwCal"></div><div id="bwStats"></div><div id="bwHist"></div>
        <div class="d-acts" style="margin-top:16px"><button data-bw="reset">♻️ Wyzeruj statystyki bota</button></div>`;
      if (!el.dataset.click) {
        el.dataset.click = '1';
        el.addEventListener('click', onWalletClick);
      }
    }
    for (const [id, html] of [['#bwCard', card], ['#bwCal', calendarHtml()], ['#bwStats', statsCard], ['#bwHist', hist]]) {
      const box = el.querySelector(id);
      if (box.dataset.html !== html) {
        box.dataset.html = html;
        box.innerHTML = html;
      }
    }
  }

  function onWalletClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    const el = b.closest('#walletBotBody');
    if (b.dataset.bcal) {
      S.calMonth = Math.max(0, Math.min(12, S.calMonth + Number(b.dataset.bcal)));
    } else if (b.dataset.bw === 'spot') {
      return (deps.openVault || openWallet)();
    } else if (!REAL && (b.dataset.bwAmt || b.dataset.bw === 'topup')) {
      const inp = el?.querySelector('#botTopUp');
      const amt = b.dataset.bwAmt ? Number(b.dataset.bwAmt) : Number(String(inp?.value || '').replace(',', '.'));
      if (!(amt > 0) || amt > 1e12) return toast('Wpisz kwotę doładowania');
      B.cash += amt;
      B.deposits += amt;
      B.tx.unshift({ t: Date.now(), type: 'deposit', amount: amt });
      note(REAL ? `➕ Przydzielono budżet ${fmt.usd(amt)}` : `⬇️ Doładowano ${fmt.usd(amt)}`);
      if (inp && !b.dataset.bwAmt) inp.value = '';
      save();
      toast(REAL ? `🤖 Budżet bota: +${fmt.usd(amt)}` : `🤖 Doładowano bota: +${fmt.usd(amt)}`);
    } else if (b.dataset.bw === 'reset') {
      // Real positions hold real tokens: they must be sold first, never just forgotten.
      if (REAL && (Object.keys(B.pos).length || Object.keys(B.pend).length || pending.size)) return toast('Bot ma otwarte pozycje — najpierw je sprzedaj');
      if (!confirm(REAL ? 'Wyzerować statystyki i historię bota? Twoje środki w walletcie się nie zmienią. Ustawienia zostają.' : 'Wyzerować bota DEMO? Kapitał, otwarte pozycje bota, historia i statystyki zostaną wyczyszczone. Ustawienia zostają.')) return;
      B = { ...fresh(), cfg: B.cfg, tx: [{ t: Date.now(), type: 'reset', amount: 0 }] };
      save();
      toast('♻️ Bot wyzerowany');
    }
    renderWallet(el);
  }

  return {
    render,
    renderWallet,
    tracked,
    count: () => Object.keys(B.pos).length,
    /** Value of the bot's open positions now ($). */
    exposure: () => stats().inPos,
    running: () => B.on,
    holds: (m) => !!B.pos[m] || !!B.pend[m] || pending.has(m),
    /** Real swaps running in this tab right now. */
    swapping: () => pending.size + sellingNow.size,
    /** Real trades in flight or not yet resolved (a reload now would leave them to be resolved). */
    inFlight: () => pending.size + sellingNow.size + Object.keys(B.pend).length + Object.values(B.pos).filter((p) => p.sellSig).length,
    dirty: () => S.dirty,
  };
}
