// Trading bot DEMO: finds memecoins whose chart is going up (momentum on the radar's live data)
// and makes quick round trips — buy, then take profit / stop loss / trailing stop / time limit.
// Own demo wallet (Wallet → BOT), separate from the spot positions. Runs while the app is open.

const KEY = 'mr:bot';
const LOCK = 'mr:botLock';
const TICK_MS = 2000;
const DAY_MS = 86_400_000;

/** Settings shown in the panel: [key, label, unit, min, max, step, hint]. */
export const FIELDS = [
  ['buyUsd', 'Kwota zakupu', '$', 1, 1e6, 1, 'Za tyle bot kupuje przy każdym wejściu'],
  ['tp', 'Take profit', '%', 0.5, 1000, 0.5, 'Sprzedaje, gdy cena wzrośnie o tyle % od zakupu'],
  ['sl', 'Stop loss', '%', 0.5, 95, 0.5, 'Zamyka pozycję dokładnie przy cenie −tyle % od zakupu (gwarantowany stop)'],
  ['trail', 'Trailing stop', '%', 0, 90, 0.5, 'Po wzroście o tyle % sprzedaje, gdy cena spadnie o tyle % od szczytu (0 = wyłączony)'],
  ['maxHoldMin', 'Maks. czas pozycji', 'min', 0, 1440, 1, 'Po tylu minutach zamyka pozycję po cenie rynkowej (0 = bez limitu)'],
  ['maxPos', 'Maks. otwartych pozycji', '', 1, 20, 1, 'Ile tokenów bot może trzymać naraz'],
  ['minC5', 'Wzrost 5 min od', '%', 0, 500, 0.5, 'Minimalny wzrost ceny w ostatnich 5 minutach'],
  ['maxC5', 'Wzrost 5 min do', '%', 1, 5000, 1, 'Pomija tokeny, które już wystrzeliły ponad tyle % (wejście na szczycie)'],
  ['minBuys', 'Przewaga kupujących od', '%', 0, 100, 1, 'Udział kupna w transakcjach z ostatnich 5 minut'],
  ['minVol5', 'Wolumen 5 min od', '$', 0, 1e8, 100, 'Minimalny obrót w ostatnich 5 minutach'],
  ['minLiq', 'Płynność od', '$', 0, 1e9, 1000, 'Minimalna płynność puli (mniejsza = większy poślizg ceny)'],
  ['minMc', 'MCap od', '$', 0, 1e10, 1000, ''],
  ['maxMc', 'MCap do', '$', 0, 1e12, 1000, '0 = bez limitu'],
  ['minSafety', 'Bezpieczeństwo od', '/100', 0, 100, 1, 'Minimalny wynik bezpieczeństwa tokena (0 = nie sprawdzaj)'],
  ['cooldownMin', 'Przerwa po wyjściu', 'min', 0, 1440, 1, 'Tyle minut bot nie wraca do tego samego tokena'],
  ['maxDayLoss', 'Dzienny limit straty', '$', 0, 1e9, 1, 'Bot sam się zatrzyma po takiej stracie w ciągu dnia (0 = bez limitu)'],
];
export const DEFAULTS = {
  buyUsd: 25, tp: 15, sl: 8, trail: 5, maxHoldMin: 20, maxPos: 3,
  minC5: 3, maxC5: 40, minBuys: 55, minVol5: 3000, minLiq: 15000, minMc: 30000, maxMc: 20_000_000,
  minSafety: 60, cooldownMin: 30, maxDayLoss: 0, gradOnly: false,
};

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

/** Why a row doesn't qualify for a buy (null = it does). */
export function rejectReason(r, cfg, now = Date.now()) {
  if (!(r.p > 0)) return 'brak ceny';
  if (r.hpt || r.rk === 'danger') return 'ryzyko';
  if (cfg.minSafety > 0 && !(r.sc >= cfg.minSafety)) return 'bezpieczeństwo';
  if (cfg.gradOnly && r.bp != null) return 'bonding curve';
  if (r.ds && now - r.ds < 15 * 60_000) return 'dev sprzedaje';
  if (!(r.c5 >= cfg.minC5) || r.c5 > cfg.maxC5) return 'wzrost 5m';
  if (cfg.minBuys > 0 && !(buyShare(r) >= cfg.minBuys)) return 'kupujący';
  const vol5 = r.v5 ?? ((r.bv5 || 0) + (r.sv5 || 0) || null);
  if (cfg.minVol5 > 0 && !(vol5 >= cfg.minVol5)) return 'wolumen';
  if (cfg.minLiq > 0 && !(r.lq >= cfg.minLiq)) return 'płynność';
  if (cfg.minMc > 0 && !(r.mc >= cfg.minMc)) return 'mcap';
  if (cfg.maxMc > 0 && r.mc > cfg.maxMc) return 'mcap';
  if (!risingNow(r.ph)) return 'wykres';
  return null;
}

/** Ranking of buy candidates: stronger move with more buyers first. */
export const signalScore = (r) => (r.c5 || 0) * ((buyShare(r) ?? 50) / 50) + (r.c1 > 0 ? Math.min(r.c1, 50) / 10 : 0);

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
  if (pct >= cfg.tp - eps) return 'tp';
  const peak = Math.max(pos.peak || 0, price);
  if (cfg.trail > 0 && movePct(pos, peak) >= cfg.trail && price <= peak * (1 - cfg.trail / 100)) return 'trail';
  if (cfg.maxHoldMin > 0 && now - pos.t >= cfg.maxHoldMin * 60_000) return 'time';
  return null;
}

export const EXIT_NAMES = { tp: '🎯 Take profit', sl: '🛑 Stop loss', trail: '📉 Trailing stop', time: '⏱️ Limit czasu', manual: '✋ Ręcznie', reset: '♻️ Reset' };

// ---------- the bot ----------

export function createBot(deps) {
  const { toast, engine, tradeFee, excluded, openToken, openWallet, onChange, fmt, esc } = deps;
  const tabId = Math.random().toString(36).slice(2);
  const fresh = () => ({ cash: 0, deposits: 0, on: false, cfg: { ...DEFAULTS }, pos: {}, hist: [], tx: [], log: [], cool: {}, feesPaid: 0, rev: 0 });
  const load = () => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY));
      if (v && typeof v === 'object') {
        const b = { ...fresh(), ...v };
        b.cfg = { ...DEFAULTS, ...(v.cfg || {}) };
        for (const k of ['hist', 'tx', 'log']) if (!Array.isArray(b[k])) b[k] = [];
        if (!b.pos || typeof b.pos !== 'object') b.pos = {};
        if (!b.cool || typeof b.cool !== 'object') b.cool = {};
        return b;
      }
    } catch {
      /* private mode / bad data */
    }
    return fresh();
  };
  let B = load();
  const S = { calMonth: 0, touch: 0, lastScan: null, dirty: true };
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

  function buy(r) {
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
    B.pos[r.m] = { p: entry, px: r.p, usd, fee, t: Date.now(), chain, n: r.n || '', s: r.s || '', i: r.i || '', lq: r.lq || 0, peak: r.p, last: r.p, lastAt: Date.now(), c5: r.c5 };
    B.tx.unshift({ t: Date.now(), type: 'open', amount: usd, s: r.s || '', m: r.m, fee });
    note(`🟢 Kupno $${esc(r.s || '?')} za ${fmt.usd(usd)} · +${(r.c5 || 0).toFixed(1)}% w 5 min`);
    return true;
  }

  /** Selling position `p` at `px`: what comes back after the pool's price impact and the fees. */
  function proceeds(p, px) {
    const gross = Math.max(0, p.usd * ((px * (1 - impact(p.usd * (px / p.px || 1), p.lq))) / p.p));
    const fee = Math.min(gross, tradeFee(gross, p.chain));
    return { gross, fee, back: gross - fee };
  }

  function sell(m, price, why) {
    const p = B.pos[m];
    if (!p) return null;
    let px = price > 0 ? price : p.last;
    // A guaranteed stop: closes at exactly −SL% from the buy price, also when the price gapped
    // past it between two reads (set 8% → sold at −8%).
    if (why === 'sl') px = (p.px || p.p) * (1 - B.cfg.sl / 100);
    const { fee, back } = proceeds(p, px);
    const move = movePct(p, px);
    const pnl = back - p.usd;
    B.cash += back;
    B.feesPaid += fee;
    delete B.pos[m];
    B.cool[m] = Date.now();
    B.hist.unshift({ m, s: p.s, n: p.n, chain: p.chain, usd: p.usd, pnl, pct: move, fee: fee + (p.fee || 0), why, openedAt: p.t, closedAt: Date.now() });
    B.tx.unshift({ t: Date.now(), type: 'close', amount: back, s: p.s || '', m, pnl, fee });
    note(`${pnl >= 0 ? '✅' : '🔻'} ${EXIT_NAMES[why] || why}: $${esc(p.s || '?')} ${fmt.pct(move)} (${money(pnl)} po opłatach)`);
    return pnl;
  }

  function candidates() {
    const E = engine();
    if (!E) return [];
    const base = { minMcap: 0, minLiq: 0, maxAgeH: 0, safe: false, q: '' };
    const seen = new Map();
    for (const [view, n] of [['hype', 150], ['surge', 80]]) for (const r of E.snapshot(view, base, n).rows) seen.set(r.m, r);
    return [...seen.values()];
  }

  /** A new price for position `m`: exits checked right away. True when it was sold. */
  function onPrice(m, price, lq, now = Date.now()) {
    const p = B.pos[m];
    if (!p || !(price > 0)) return false;
    p.last = price;
    p.lastAt = now;
    if (lq > 0) p.lq = lq;
    const why = exitReason(p, price, B.cfg, now);
    p.peak = Math.max(p.peak || 0, price);
    if (!why) return false;
    const pnl = sell(m, price, why);
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
      if (r && !(B.pos[m].liveAt > (r.pa || 0))) changed = onPrice(m, r.p, r.lq, now) || changed;
    }
    if (B.on && cfg.maxDayLoss > 0 && pnlToday() <= -cfg.maxDayLoss) {
      B.on = false;
      note(`⛔ Dzienny limit straty (${fmt.usd(cfg.maxDayLoss)}) — bot zatrzymany`);
      toast('🤖 Bot zatrzymany: dzienny limit straty');
      changed = true;
    }
    // Entries: one buy per tick at most, the strongest signal first.
    if (B.on && Object.keys(B.pos).length < cfg.maxPos) {
      if (B.cash < 1) {
        if (!S.lowCash) note('💸 Brak kapitału — doładuj bota w Wallet → BOT');
        S.lowCash = true;
      } else {
        S.lowCash = false;
        const chain = E.chain;
        const rows = candidates();
        let checked = 0;
        const best = rows
          .filter((r) => {
            if (B.pos[r.m] || excluded(r) || now - (B.cool[r.m] || 0) < cfg.cooldownMin * 60_000) return false;
            // A fresh price only (a paused network's rows are hours old for a moment after a switch).
            if (!(r.pa > 0) || now - r.pa > 60_000 || (E.since > 0 && r.pa < E.since)) return false;
            checked++;
            return !rejectReason(r, cfg, now);
          })
          .sort((a, b) => signalScore(b) - signalScore(a));
        S.lastScan = { t: now, n: checked, hits: best.length, chain };
        if (best[0] && buy(best[0])) {
          toast(`🤖 Bot kupił $${best[0].s || '?'} za ${fmt.usd(B.pos[best[0].m].usd)}`);
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
    const wins = done.filter((h) => h.pnl > 0).length;
    return { pos, inPos, equity: B.cash + inPos, total: done.reduce((a, h) => a + h.pnl, 0), today: pnlToday(), n: done.length, wins, rate: done.length ? (wins / done.length) * 100 : null };
  }

  function settingsHtml() {
    const c = B.cfg;
    return `<details class="bot-set" ${B.cfg.open === false ? '' : 'open'}><summary>⚙️ Ustawienia bota</summary>
      <div class="bot-grid">${FIELDS.map(([k, label, unit, min, max, step, hint]) => `<label title="${esc(hint)}"><span>${label}${unit ? ` <small>${unit}</small>` : ''}</span><input type="number" inputmode="decimal" data-bot-cfg="${k}" min="${min}" max="${max}" step="${step}" value="${c[k]}" /></label>`).join('')}</div>
      <label class="toggle-row"><input type="checkbox" data-bot-cfg="gradOnly" ${c.gradOnly ? 'checked' : ''} /> <span>Tylko tokeny po graduacji (bez bonding curve)</span></label>
      <div class="bot-acts"><button data-bot="defaults">↺ Domyślne</button></div>
      <p class="note">Jak działa: co 2 s bot przegląda listy Hype i Wybicia wolumenu na wybranej sieci i kupuje token, którego wykres właśnie rośnie (wzrost w 5 min w Twoim zakresie, rosnące ostatnie ceny, przewaga kupujących, wolumen, płynność, MCap i bezpieczeństwo). Wychodzi na take profit, stop loss, trailing stop albo po limicie czasu. Procenty TP / SL to zmiana ceny od zakupu — dokładnie tyle, ile ustawisz (stop loss gwarantowany: 8% = sprzedaż przy −8%, nawet gdy cena przeskoczy ten poziom). % przy pozycji to też zmiana ceny; kwota w $ pokazuje wynik po opłatach (jak w Wallet → Spot, ok. 3% za kupno i sprzedaż razem). Ceny pozycji bota czytane są na żywo co ~1 s. Bot działa, gdy aplikacja jest otwarta na ekranie.</p>
    </details>`;
  }

  function statusHtml() {
    const s = stats();
    const low = B.cash < 1 && !Object.keys(B.pos).length;
    const scan = S.lastScan && Date.now() - S.lastScan.t < 10_000 ? `Skan: ${S.lastScan.n} tokenów, ${S.lastScan.hits} z sygnałem` : B.on ? 'Startuje…' : '';
    return `<div class="bot-head">
        <div class="bot-title"><b>🤖 BOT DEMO</b><span class="bot-pill ${B.on ? 'on' : ''}">${B.on ? '● Działa' : 'Zatrzymany'}</span></div>
        <button class="bot-toggle ${B.on ? 'stop' : ''}" data-bot="toggle">${B.on ? '■ Stop' : '▶ Start'}</button>
      </div>
      <div class="bot-stats">
        <div><span>Kapitał bota</span><b>${fmt.usd(B.cash)}</b></div>
        <div><span>W pozycjach</span><b>${fmt.usd(s.inPos)}</b></div>
        <div><span>Dziś</span><b class="${s.today >= 0 ? 'up' : 'down'}">${s.n ? money(s.today) : '—'}</b></div>
        <div><span>Łącznie</span><b class="${s.total >= 0 ? 'up' : 'down'}">${s.n ? money(s.total) : '—'}</b></div>
        <div><span>Transakcje</span><b>${s.n}${s.rate != null ? ` <small>${Math.round(s.rate)}% wygr.</small>` : ''}</b></div>
      </div>
      ${low ? `<div class="bot-warn">Bot nie ma kapitału. <button data-bot="wallet">⬇️ Doładuj w Wallet → BOT</button></div>` : ''}
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
      const v = Number(String(inp.value).replace(',', '.'));
      if (!Number.isFinite(v)) return (inp.value = B.cfg[k]);
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
      B.on = !B.on;
      if (B.on && !engine()) {
        B.on = false;
        return toast('Bot działa tylko w wersji z danymi na żywo');
      }
      note(B.on ? '▶ Bot uruchomiony' : '■ Bot zatrzymany (otwarte pozycje dalej pilnują TP / SL)');
      save();
      toast(B.on ? '🤖 Bot uruchomiony' : '🤖 Bot zatrzymany');
    } else if (act === 'defaults') {
      B.cfg = { ...DEFAULTS, open: true };
      syncInputs(b.closest('#botPanel') || document);
      save();
      toast('🤖 Przywrócono domyślne ustawienia');
    } else if (act === 'wallet') openWallet();
    else if (b.dataset.botOpen) openToken(b.dataset.botOpen);
    else if (b.dataset.botSell) {
      const m = b.dataset.botSell;
      const p = B.pos[m];
      if (!p) return;
      if (p.chain !== chainNow()) return toast('Ta pozycja jest na innej sieci — przełącz sieć, żeby sprzedać');
      const r = liveRows().get(m);
      const pnl = sell(m, r?.p || p.last, 'manual');
      save();
      toast(`🤖 Sprzedano $${p.s || '?'} ${money(pnl)}`);
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
    for (const h of B.hist) {
      const dt = new Date(h.closedAt);
      if (dt.getFullYear() !== first.getFullYear() || dt.getMonth() !== first.getMonth()) continue;
      const o = byDay.get(dt.getDate()) || { pnl: 0, n: 0 };
      o.pnl += h.pnl;
      o.n++;
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
    const pnl = s.equity - B.deposits;
    const TX = { deposit: ['⬇️', 'Doładowanie'], withdraw: ['⬆️', 'Wypłata do Spot'], open: ['🤖', 'Kupno bota'], close: ['✅', 'Sprzedaż bota'], reset: ['♻️', 'Reset bota'] };
    const card = `<div class="wallet-card">
        <span>Kapitał bota</span><b>${fmt.usd(B.cash)}</b>
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
    const hist = `<p class="note">Wpłacono łącznie ${fmt.usd(B.deposits)}.</p><h3 class="pos-h">Historia</h3>
      <div class="pos-closed">${
        B.tx.slice(0, 30).map((t) => `<div><span>${TX[t.type]?.[0] || '•'} ${TX[t.type]?.[1] || t.type}${t.s ? ` <small>$${esc(t.s)}</small>` : ''} <small>· ${fmt.ago(t.t)}</small></span><b class="${t.type === 'open' || t.type === 'withdraw' ? 'down' : t.type === 'reset' ? '' : 'up'}">${t.type === 'open' || t.type === 'withdraw' ? '−' : t.type === 'reset' ? '' : '+'}${fmt.usd(t.amount)}${t.pnl != null ? ` <small class="${t.pnl >= 0 ? 'up' : 'down'}">(${money(t.pnl)})</small>` : ''}${t.fee > 0 ? `<small class="muted tx-fee">opłaty ${feeUsd(t.fee)}</small>` : ''}</b></div>`).join('') ||
        '<div><span class="muted">Brak operacji — doładuj kapitał bota, żeby zaczął handlować.</span></div>'
      }</div>`;
    if (!el.querySelector('#bwCard')) {
      el.innerHTML = `<div id="bwCard"></div><div id="bwCal"></div>
        <div class="card wallet-top"><h3>Doładuj kapitał bota DEMO</h3>
          <div class="pos-form"><input id="botTopUp" type="number" inputmode="decimal" min="0" step="any" placeholder="Kwota w $" /><button data-bw="topup">⬇️ Doładuj</button></div>
          <div class="quick-amt">${[100, 500, 1000, 5000].map((v) => `<button data-bw-amt="${v}">+$${fmt.n(v)}</button>`).join('')}</div>
          <p class="note">Osobny wallet bota — wirtualne pieniądze, niezależne od Spot i Perpetuals. Za kapitał bot kupuje tokeny według ustawień w zakładce BOT.</p>
        </div>
        <div id="bwStats"></div><div id="bwHist"></div>
        <div class="d-acts" style="margin-top:16px"><button data-bw="reset">♻️ Wyzeruj bota DEMO</button></div>`;
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

  function onWalletClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    const el = b.closest('#walletBotBody');
    if (b.dataset.bcal) {
      S.calMonth = Math.max(0, Math.min(12, S.calMonth + Number(b.dataset.bcal)));
    } else if (b.dataset.bwAmt || b.dataset.bw === 'topup') {
      const inp = el?.querySelector('#botTopUp');
      const amt = b.dataset.bwAmt ? Number(b.dataset.bwAmt) : Number(String(inp?.value || '').replace(',', '.'));
      if (!(amt > 0) || amt > 1e12) return toast('Wpisz kwotę doładowania');
      B.cash += amt;
      B.deposits += amt;
      B.tx.unshift({ t: Date.now(), type: 'deposit', amount: amt });
      note(`⬇️ Doładowano ${fmt.usd(amt)}`);
      if (inp && !b.dataset.bwAmt) inp.value = '';
      save();
      toast(`🤖 Doładowano bota: +${fmt.usd(amt)}`);
    } else if (b.dataset.bw === 'reset') {
      if (!confirm('Wyzerować bota DEMO? Kapitał, otwarte pozycje bota, historia i statystyki zostaną wyczyszczone. Ustawienia zostają.')) return;
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
    running: () => B.on,
    holds: (m) => !!B.pos[m],
    dirty: () => S.dirty,
  };
}
