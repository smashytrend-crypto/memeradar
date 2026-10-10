// DMN frontend — vanilla JS, no build step. Server pushes snapshots over SSE every 2s;
// rows are keyed by mint and patched in place (with FLIP re-ordering) so updates stay smooth.

// Static preview: a snapshot embedded by scripts/build-preview.mjs replaces the server.
const STATIC = window.__MR_SNAPSHOT || null;
// Serverless build: the engine runs in this page (web/engine.js).
const ENGINE = window.__MR_ENGINE || null;
const nowTs = () => (STATIC ? STATIC.t : Date.now());

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------- persistence ----------
const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`mr:${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`mr:${k}`, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};

// Network on screen (the in-browser engine runs one radar per network).
const CHAIN_LIST = ENGINE?.chains ? Object.values(ENGINE.chains) : null;
const chainCfg = () => (ENGINE?.chains && ENGINE.chains[ENGINE.chain]) || { id: 'solana', dex: 'solana', native: 'SOL', evm: false };
if (ENGINE) ENGINE.setChain(LS.get('chain', 'solana'));

const state = {
  view: ((v) => (v === 'pos' ? 'hype' : ENGINE && (v === 'new' || v === 'graduating') ? 'graduated' : v))(LS.get('view', 'hype')), // 'pos' was a tab in an older version
  filters: LS.get('filters', { minMcap: 0, minLiq: 0, maxAgeH: 0, safe: false }),
  watch: new Set(LS.get('watch', [])),
  watchChain: LS.get('watchChain', {}) || {}, // mint -> network it was starred on
  hidden: new Set(LS.get('hidden', [])), // tokens the viewer hid from the lists
  blocked: new Set(LS.get('blocked', [])), // creators whose tokens are hidden
  positions: LS.get('positions', {}), // mint -> { p: entry price, mc, usd, t, chain, n, s, i, last }
  closed: LS.get('closedPositions', []), // closed demo trades (last 90 days) for the 1d / 7d / 30d P&L
  wallet: { cash: 0, deposits: 0, tx: [], ...LS.get('wallet', {}) }, // demo wallet funding the demo positions
  quickBuy: LS.get('quickBuy', [50, 100, 250, 500]), // the viewer's quick-buy amounts in $
  fees: LS.get('fees', true) !== false, // demo trades pay realistic fees
  wallets: ((w) => (Array.isArray(w) ? w.filter((x) => x && typeof x.a === 'string') : []))(LS.get('wallets', [])), // tracked wallets [{ a, name, emoji }]
  candleTf: LS.get('candleTf', '5m'), // candle chart timeframe
  calMonth: 0, // PnL calendar: months back from the current one
  tr: null, // trades of the open token { m, list, at }
  candles: null, // candles of the open token { key, list, at }
  nativeUsd: {}, // network -> native coin price in $ (for network / priority fees)
  presets: LS.get('presets', []), // saved filter sets [{ name, f }]
  feedFilter: 'all',
  paused: false,
  rows: new Map(), // mint -> { el, data }
  prevRanks: new Map(),
  feed: [],
  selected: null,
  detail: null,
  chartTab: 'dex',
  es: null,
  lastSnapshot: 0,
  firstSnapshot: true,
  pendingSnapshot: null,
};
if (!state.positions || typeof state.positions !== 'object') state.positions = {};
if (!Array.isArray(state.closed)) state.closed = [];
if (!Array.isArray(state.wallet.tx)) state.wallet.tx = [];
// Positions saved before the demo wallet existed were never paid from it.
for (const p of Object.values(state.positions)) if (p && p.w === undefined) p.w = false;

// ---------- formatting ----------
const SUB = '₀₁₂₃₄₅₆₇₈₉';
const fmt = {
  usd(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (a >= 1e4) return `$${(v / 1e3).toFixed(1)}K`;
    if (a >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
    return `$${v.toFixed(0)}`;
  },
  price(p) {
    if (p == null || !Number.isFinite(p) || p <= 0) return '—';
    if (p >= 1000) return `$${p.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    if (p >= 1) return `$${p.toFixed(3)}`;
    if (p >= 0.001) return `$${p.toFixed(5)}`;
    // Zeros right after the decimal point, then 4 significant digits (exact powers of ten and
    // values that round up to the next decade included).
    let zeros = Math.ceil(-Math.log10(p)) - 1;
    let n = Math.round(p * 10 ** (zeros + 4));
    if (n >= 1e4) {
      zeros -= 1;
      n = Math.round(n / 10);
    }
    if (zeros < 3) return `$${p.toFixed(5)}`;
    const digits = String(n).replace(/0+$/, '') || '0';
    const z = String(zeros).split('').map((d) => SUB[d]).join(''); // 0.0₄12 = 0.000012
    return `$0.0${z}${digits}`;
  },
  pct(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    const s = a >= 1e6 ? `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M` : a >= 10000 ? `${(v / 1000).toFixed(0)}K` : a >= 1000 ? `${(v / 1000).toFixed(1)}K` : a >= 100 ? v.toFixed(0) : v.toFixed(1);
    return `${v > 0 ? '+' : ''}${s}%`;
  },
  n(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
    return Math.round(v).toLocaleString('pl-PL');
  },
  sol(v) {
    return v == null ? '—' : `${v >= 10 ? v.toFixed(1) : v.toFixed(2)} SOL`;
  },
  ago(ts, now = nowTs()) {
    if (!ts) return '—';
    const s = Math.max(0, (now - ts) / 1000);
    if (s < 60) return `${Math.floor(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  },
  short(a) {
    return a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '';
  },
  /** Duration: 45 s, 4 min, 3 h, 2 dni. */
  dur(ms) {
    const s = Math.max(0, ms / 1000);
    if (s < 60) return `${Math.round(s)} s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    if (s < 86400) return `${Math.round(s / 3600)} h`;
    const d = Math.round(s / 86400);
    return `${d} ${d === 1 ? 'dzień' : 'dni'}`;
  },
};
const cls = (v) => (v == null || !Number.isFinite(v) || Math.abs(v) < 0.05 ? 'flat' : v > 0 ? 'up' : 'down');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^(https?:|data:image\/)/i.test(u || '') ? u : '');

/** Heat hue for a score: cold blue → orange → hot pink. */
function heat(score) {
  const s = Math.max(0, Math.min(100, score || 0));
  if (s < 50) return 215 - (s / 50) * 190; // 215 → 25
  return (385 - ((s - 50) / 50) * 50) % 360; // 25 → 335
}

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function avatar(d, size = '') {
  const hue = hashHue(d.m);
  const initials = esc((d.s || d.n || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2) || '?');
  const img = safeUrl(d.i);
  return `<div class="av ${size}" style="background:linear-gradient(135deg,hsl(${hue},70%,45%),hsl(${(hue + 50) % 360},75%,35%))">
    <span class="av-i">${initials}</span>${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    <span class="av-live"></span></div>`;
}

function sparkPath(values, w, h, pad = 2) {
  const v = (values || []).filter((x) => Number.isFinite(x));
  if (v.length < 2) return { line: '', area: '' };
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = max - min || 1;
  const pts = v.map((y, i) => [(i / (v.length - 1)) * w, h - pad - ((y - min) / span) * (h - pad * 2)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  return { line, area: `${line}L${w},${h}L0,${h}Z` };
}

// ---------- mini price charts ----------
const MIN_MS = 60e3;

/**
 * Price points for a token's mini chart, oldest first, as [ageMs, price]. Preferably real
 * 15-minute candles for the last 24 h (GeckoTerminal, `d.cd`); otherwise DexScreener's % changes
 * give where the price was 24 h / 6 h / 1 h / 5 min ago (for a market younger than a window, that
 * window's change is taken as "since the pool opened"). Our own samples (every ~15 s) fill in the
 * minutes after the last candle, and the live price ends the line.
 */
function priceSeries(d) {
  if (!(d.p > 0)) return [];
  const now = nowTs();
  const pts = [];
  let newestAge = Infinity; // age of the newest candle point: live samples only fill in after it
  if (d.cd?.length >= 3) {
    for (const [ts, p] of d.cd) {
      const a = Math.max(0, now - ts * 1000);
      pts.push([a, p]);
      newestAge = Math.min(newestAge, a);
    }
  } else {
    const age = Math.max(MIN_MS, now - (d.ma || d.ca || now - 86400e3));
    let origin = false;
    for (const [win, ch] of [[86400e3, d.c24], [6 * 3600e3, d.c6], [3600e3, d.c1], [300e3, d.c5]]) {
      if (ch == null || !Number.isFinite(ch) || ch <= -100) continue;
      const p = d.p / (1 + ch / 100);
      if (!(p > 0)) continue;
      if (age >= win) pts.push([win, p]);
      else if (!origin) {
        pts.push([age, p]);
        origin = true;
      }
    }
  }
  // Our samples, newest last: `pt` = age of the newest (s), `pi` = mean spacing (s) — real
  // spacing can stretch when the network was off screen or the tab was throttled.
  const ph = d.ph || [];
  const step = (d.pi || 15) * 1000;
  const last = (d.pt || 0) * 1000 + 1000;
  ph.forEach((v, i) => {
    if (!(v > 0)) return;
    const a = (ph.length - 1 - i) * step + last;
    if (a < newestAge) pts.push([a, v]);
  });
  pts.push([0, d.p]);
  return pts.sort((a, b) => b[0] - a[0]);
}

/** Smooth path through points without overshoot (monotone cubic, Fritsch–Carlson). */
function monotonePath(pts) {
  const n = pts.length;
  const f = (v) => v.toFixed(1);
  if (n < 2) return '';
  if (n === 2) return `M${f(pts[0][0])},${f(pts[0][1])}L${f(pts[1][0])},${f(pts[1][1])}`;
  const dx = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    m[i] = dx[i] ? (pts[i + 1][1] - pts[i][1]) / dx[i] : 0;
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  t[n - 1] = m[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const h = a * a + b * b;
    if (h > 9) {
      const s = 3 / Math.sqrt(h);
      t[i] = s * a * m[i];
      t[i + 1] = s * b * m[i];
    }
  }
  let path = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    path += `C${f(pts[i][0] + h)},${f(pts[i][1] + t[i] * h)} ${f(pts[i + 1][0] - h)},${f(pts[i + 1][1] - t[i + 1] * h)} ${f(pts[i + 1][0])},${f(pts[i + 1][1])}`;
  }
  return path;
}

/**
 * Mini chart geometry on a log time axis (the whole day fits, recent minutes stay readable).
 * Returns line / area paths, the end-point dot and the trend direction.
 */
function miniChart(d, W, H, pad = 3) {
  const series = priceSeries(d);
  if (series.length < 2) return null;
  const maxAge = series[0][0] || 1;
  const lx = (a) => W * (1 - Math.log1p(a / MIN_MS) / Math.log1p(maxAge / MIN_MS));
  const vals = series.map((p) => p[1]);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const flat = max - min < max * 0.002;
  const y = (v) => (flat ? H / 2 : H - pad - ((v - min) / (max - min)) * (H - pad * 2));
  const pts = [];
  for (const [a, v] of series) {
    const x = lx(a);
    const last = pts[pts.length - 1];
    if (last && x - last[0] < 0.6) last[1] = y(v); // merge points closer than a pixel
    else pts.push([x, y(v)]);
  }
  if (pts.length < 2) return null;
  const line = monotonePath(pts);
  const end = pts[pts.length - 1];
  return {
    line,
    area: `${line}L${W},${H}L${pts[0][0].toFixed(1)},${H}Z`,
    dot: `M${end[0].toFixed(1)},${end[1].toFixed(1)}l0,0`,
    up: vals[vals.length - 1] >= vals[0],
  };
}

const SHIELD = `<svg class="shield" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.4 7.5 9.5 4.4-1.1 7.5-4.9 7.5-9.5V6L12 3Z"/><path class="chk" d="m8.8 12.2 2.2 2.2 4.3-4.6"/></svg>`;
const RISK_TXT = { ok: 'Brak istotnych flag', warn: 'Ostrzeżenia', danger: 'Wysokie ryzyko', unknown: 'Nie sprawdzono' };

// ---------- "since you first saw it" ----------
// Per-viewer baseline: the price when a token first appeared on this viewer's list, kept in
// localStorage so it survives reloads. Old entries expire after 7 days.
const SEEN_TTL = 7 * 86400e3;
const seen = new Map(Object.entries(LS.get('seen', {})));
let seenDirty = false;

function seenBase(d) {
  if (STATIC || !(d.p > 0)) return null;
  let s = seen.get(d.m);
  if (!s) {
    // Only start from a price DexScreener just confirmed: early prices from other sources
    // can differ and would fake a big move.
    if (d.fr === false) return null;
    s = { p: d.p, t: Date.now() };
    seen.set(d.m, s);
    seenDirty = true;
  }
  return s;
}

const fmtX = (r) => `${r >= 10 ? r.toFixed(0) : r >= 2 ? r.toFixed(1) : r.toFixed(2)}×`;

/** Baseline plus the highest multiple reached since first seen (fresh DexScreener prices only). */
function trackSeen(d) {
  const base = seenBase(d);
  if (!base) return null;
  const r = d.p / base.p;
  if (d.fr !== false && r > (base.m || 1)) {
    base.m = r;
    seenDirty = true;
  }
  return base;
}

/** e.g. "👁 12m +340% · 4.4×" — null until there is something worth showing. */
function sinceSeen(d) {
  const base = trackSeen(d);
  if (!base) return null;
  const r = d.p / base.p;
  const pct = (r - 1) * 100;
  if (Date.now() - base.t < 60_000 && Math.abs(pct) < 0.5) return null;
  return { r, pct, t: base.t, cls: cls(pct), text: `👁 ${fmt.ago(base.t)} ${fmt.pct(pct)} · ${fmtX(r)}` };
}

setInterval(() => {
  if (!seenDirty) return;
  seenDirty = false;
  const now = Date.now();
  for (const [m, s] of seen) if (now - s.t > SEEN_TTL) seen.delete(m);
  if (seen.size > 3000) {
    const oldest = [...seen.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, seen.size - 3000);
    for (const [m] of oldest) seen.delete(m);
  }
  LS.set('seen', Object.fromEntries(seen));
}, 10_000);

/**
 * Win rate of the (up to) 100 tokens on the main Hype list right now: a win is a token that
 * reached 2× its price at first sight at any point since — it stays a win even if it then
 * falls to zero; every other token on the list counts as a loss.
 */
function winRate(rows, target) {
  let wins = 0;
  for (const d of rows) {
    trackSeen(d);
    if (seen.get(d.m)?.m >= target) wins++;
  }
  return { wins, total: rows.length, pct: rows.length ? (wins / rows.length) * 100 : null };
}

/** Header tile for a win rate: [label, value, tooltip, class]. */
function winTile(rows, target, label, goal) {
  const wr = winRate(rows, target);
  return [
    label,
    wr.pct == null ? '—' : `${wr.pct.toFixed(1)}% · ${wr.wins}/${wr.total}`,
    `Z ${wr.total} tokenów na głównej liście Hype ${wr.wins} zrobiło co najmniej ${goal} od chwili, gdy je zobaczyłeś (zostają wygraną, nawet gdy potem spadną). Reszta liczy się jako przegrana.`,
    wr.wins ? 'gold' : '',
  ];
}

// ---------- header ----------
function renderStats(s) {
  const hr = STATIC ? null : state.hypeRows;
  const items = [
    [s.native || 'SOL', s.solPrice ? `$${s.solPrice.toFixed(2)}` : '—'],
    ...(hr ? [winTile(hr, 2, 'Win rate 2×', '2×'), winTile(hr, 1.5, 'Win rate +50%', '+50%')] : []),
    ['Śledzone tokeny', fmt.n(s.tracked)],
    ['Aktywne (5 min)', fmt.n(s.active5m)],
    ...(s.onlyGraduated
      ? []
      : [
          ['Launche / min', fmt.n(s.launches1m)],
          ['Launche / h', fmt.n(s.launches1h)],
        ]),
    ['Graduacje 24h', fmt.n(s.migrations24h)],
    ...(s.liveTrades ? [['Transakcje / min', fmt.n(s.tradesPerMin)]] : []),
  ];
  const el = $('#stats');
  const labels = items.map(([l]) => l).join('|');
  if (el.dataset.labels !== labels) {
    el.dataset.labels = labels;
    el.innerHTML = items.map(([l]) => `<div class="stat"><b></b><span>${l}</span></div>`).join('');
  }
  items.forEach(([, v, title = '', tone = ''], i) => {
    const box = el.children[i];
    const b = box.firstElementChild;
    if (b.textContent !== v) b.textContent = v;
    if (box.title !== title) box.title = title;
    if (b.className !== tone) b.className = tone;
  });
  if (!STATIC) $('#demoBanner').hidden = !s.demo;
}

const SRC_LABEL = { pumpportal: 'pump.fun', dexscreener: 'DexScreener', jupiter: 'Jupiter', geckoterminal: 'Gecko', rugcheck: 'RugCheck', goplus: 'GoPlus', x: 'X', ai: 'AI' };
// Sources each network uses (the others are left out of the status row).
const CHAIN_SOURCES = { solana: ['pumpportal', 'dexscreener', 'jupiter', 'geckoterminal', 'rugcheck', 'x', 'ai'], evm: ['dexscreener', 'geckoterminal', 'goplus', 'x', 'ai'] };
function renderSources(src) {
  const el = $('#sources');
  // Rebuild only when a source's state or message changes (not on every snapshot).
  const keys = CHAIN_SOURCES[chainCfg().evm ? 'evm' : 'solana'];
  const html = Object.entries(SRC_LABEL)
    // Sources switched off in this build (X and AI without keys) are left out entirely.
    .filter(([k]) => keys.includes(k) && src[k]?.state !== 'off')
    .map(([k, label]) => {
      const s = src[k] || { state: 'connecting', msg: 'oczekiwanie…' };
      return `<span class="src ${s.state}" tabindex="0"><i></i><span class="lbl">${label}</span>
        <span class="tip"><b>${label}</b><br>${esc(s.msg || s.state)}</span></span>`;
    })
    .join('');
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

// ---------- table ----------
function rowTemplate() {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = `
    <div class="c-rank"><span class="rank-n"></span><span class="rank-d"></span></div>
    <div class="c-token"><div class="tok"><span class="av-slot"></span><div class="tok-t">
      <div class="tok-name"><span class="src-slot"></span><b></b><small></small></div><div class="tok-sub"></div></div></div></div>
    <div class="c-hype"><div class="hype"><span class="hype-n"></span><div class="hype-v"><div class="hype-bar"><i></i></div>
      <svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="Cena: ostatnie 24 h"><path class="sp-a"/><path class="sp-l" fill="none" stroke-width="1.8" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><path class="sp-d" fill="none" stroke-width="5" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg></div></div></div>
    <div class="c-act"><a class="act-x" target="_blank" rel="noopener" title="Posty z tym kontraktem na X">𝕏</a><button class="act-cp" data-copy aria-label="Kopiuj adres kontraktu" title="Kopiuj adres kontraktu">⧉ CA</button></div>
    <div class="c-ch c-5m num"><span class="pct"></span></div>
    <div class="c-ch c-1h num"><span class="pct"></span></div>
    <div class="c-ch c-4h num"><span class="pct"></span></div>
    <div class="c-mc num mv"><b></b><small><i>Vol</i><span></span></small></div>
    <div class="c-liq num"></div>
    <div class="c-vol num"></div>
    <div class="c-bs"><div class="bs"><div class="bs-bar"><span class="b"></span><span class="s"></span></div><div class="bs-r up"><span class="n"></span><span class="v"></span></div><div class="bs-r down"><span class="n"></span><span class="v"></span></div></div></div>
    <div class="c-hold hold-ic"></div>
    <div class="c-x num"></div>
    <div class="c-risk"><div class="risk">${SHIELD}</div></div>
    <div class="c-star"><button class="star" aria-label="Obserwuj">☆</button></div>
    <div class="c-quick"></div>`;
  return el;
}

function flash(el, dir) {
  if (!dir || state.firstSnapshot) return;
  el.animate(
    [{ color: dir > 0 ? '#1fd68f' : '#ff4d6a', textShadow: `0 0 12px ${dir > 0 ? 'rgba(31,214,143,.7)' : 'rgba(255,77,106,.7)'}` }, { color: '', textShadow: 'none' }],
    { duration: 1200, easing: 'ease-out' },
  );
}

/** Assign a DOM property only when it changes, to avoid needless style / layout work. */
function setIf(el, prop, v) {
  if (el[prop] !== v) el[prop] = v;
}

function setText(el, text, dirVal, prevVal) {
  if (el.textContent === text) return;
  el.textContent = text;
  if (dirVal != null && prevVal != null && dirVal !== prevVal) flash(el, dirVal > prevVal ? 1 : -1);
}

function updateRow(entry, d, idx) {
  const { el } = entry;
  const p = entry.data || {};
  const now = nowTs();
  const q = entry.q || (entry.q = {
    rankN: $('.rank-n', el), rankD: $('.rank-d', el), av: $('.av-slot', el), name: $('.tok-name b', el), src: $('.src-slot', el), sym: $('.tok-name small', el),
    sub: $('.tok-sub', el), hs: $('.hype-n', el), hbar: $('.hype-bar i', el), sp: $('.sp-l', el), spA: $('.sp-a', el), spD: $('.sp-d', el), svg: $('.spark', el), actX: $('.act-x', el),
    c5: $('.c-5m .pct', el), c1: $('.c-1h .pct', el), c4: $('.c-4h .pct', el), mc: $('.c-mc b', el), mcV: $('.c-mc small span', el), liq: $('.c-liq', el),
    vol: $('.c-vol', el), bsB: $('.bs-bar .b', el), bsS: $('.bs-bar .s', el), bsNb: $('.bs-r.up .n', el), bsNs: $('.bs-r.down .n', el),
    bsVb: $('.bs-r.up .v', el), bsVs: $('.bs-r.down .v', el), bs: $('.bs', el), quick: $('.c-quick', el), holdIc: $('.hold-ic', el), x: $('.c-x', el), risk: $('.risk', el), star: $('.star', el),
  });

  const h = heat(d.hs);
  el.style.setProperty('--heat', h);
  el.classList.toggle('live', !!d.live);
  // Doubled (2×+) since the viewer first saw it: blinking gold frame.
  const doubled = sinceSeen(d)?.r >= 2;
  el.classList.toggle('x2', doubled);

  // rank (+ movement vs. previous snapshot)
  const shownRank = idx + 1; // position on screen (order refreshes every REORDER_MS)
  q.rankN.textContent = shownRank;
  const prevRank = state.prevRanks.get(d.m);
  if (state.view === 'hype' && prevRank && prevRank !== shownRank) {
    const diff = prevRank - shownRank;
    q.rankD.textContent = diff > 0 ? `▲${diff}` : `▼${-diff}`;
    q.rankD.className = `rank-d ${diff > 0 ? 'up' : 'down'}`;
    entry.rankShownAt = now;
  } else if (!entry.rankShownAt || now - entry.rankShownAt > 8000) {
    q.rankD.textContent = '';
  }

  if (p.i !== d.i || !q.av.firstChild) q.av.innerHTML = avatar(d);
  setText(q.name, d.n || d.s || fmt.short(d.m));
  const badge = srcBadge(d);
  if (entry.badge !== badge) {
    q.src.innerHTML = badge;
    entry.badge = badge;
  }
  setText(q.sym, d.s ? `$${d.s}` : '');

  // sub line: age, launchpad / bonding curve, socials
  const chips = [];
  const since = sinceSeen(d);
  const sinceChip = since
    ? `<span class="chip seen ${since.r >= 2 ? 'gold' : since.cls}" title="Od kiedy widzisz ten token na liście (${fmt.ago(since.t)} temu)">${since.text}</span>`
    : '';
  if (d.ca) chips.push(`<span class="chip ${now - d.ca < 3600e3 ? 'new' : ''}">${fmt.ago(d.ca, now)}</span>`);
  if (sinceChip) chips.push(sinceChip);
  if (d.bp != null) chips.push(`${lpChip(d.lp)}<span class="bc"><span class="bc-bar"><i style="width:${d.bp}%"></i></span>${d.bp.toFixed(0)}%</span>`);
  else if (d.gr) chips.push('<span class="chip grad">🎓 DEX</span>');
  const pos = posPnl(d);
  if (pos) chips.push(`<span class="chip pos ${pos.cls}" title="Twoja pozycja DEMO: ${fmt.pct(pos.pct)}${pos.usd != null ? ` (${pos.usd >= 0 ? '+' : ''}${fmt.usd(pos.usd)})` : ''}">💼 DEMO ${fmt.pct(pos.pct)}</span>`);
  if (d.fz && FRESH[d.fz]) chips.push(`<span class="chip fz ${FRESH[d.fz][2]}" title="Hype teraz: ${FRESH[d.fz][1]}">${FRESH[d.fz][0]} ${FRESH[d.fz][1]}</span>`);
  const serial = creatorWarning(d);
  if (serial) chips.push(`<span class="chip warnc" title="${esc(serial.tip)}">${serial.short}</span>`);
  if (d.sc != null) chips.push(`<span class="chip safe-sc ${scoreCls(d.sc)}" title="Ocena bezpieczeństwa ${d.sc}/100">🛡 ${d.sc}</span>`);
  if (d.cp) chips.push(`<span class="chip copyc" title="Ten ticker ma jeszcze ${d.cp} innych tokenów — ten nie jest najstarszy (OG)">🧬 kopia</span>`);
  if (d.cto) chips.push('<span class="chip cto" title="Community takeover — społeczność przejęła projekt (opłacone na DexScreenerze)">CTO</span>');
  if (d.ad) chips.push('<span class="chip adc" title="Płatna reklama na DexScreenerze">📣 Ad</span>');
  if (d.dr >= 80) chips.push(`<span class="chip gooddev" title="Ocena deva ${d.dr}/100 — jego wcześniejsze tokeny radziły sobie dobrze">⭐ dev ${d.dr}</span>`);
  if (d.vs >= 2) chips.push(`<span class="chip surge" title="Wolumen 5 min względem własnej średniej">🚀 ${d.vs.toFixed(1)}×</span>`);
  if (d.ai) chips.push(`<span class="chip ai" title="${esc(d.ai)}">🤖</span>`);
  if (d.bo) chips.push(`<span class="chip boost">⚡${d.bo}</span>`);
  chips.push(`<span class="soc"><i class="${d.tw ? 'on' : ''}">𝕏</i><i class="${d.tg ? 'on' : ''}">TG</i><i class="${d.web ? 'on' : ''}">WWW</i></span>`);
  const sub = chips.join('');
  if (entry.sub !== sub) {
    q.sub.innerHTML = sub;
    entry.sub = sub;
  }

  setText(q.hs, d.hs.toFixed(0), d.hs, p.hs);
  q.hbar.style.width = `${d.hs}%`;
  // Only rebuild the sparkline when its inputs change (or once a minute, as points age).
  const sparkIn = `${d.p}|${d.cd?.length}|${d.cd?.at(-1)?.join()}|${d.ph?.length}|${d.ph?.at(-1)}|${d.c5}|${d.c1}|${d.c24}|${Math.floor(nowTs() / 60e3)}`;
  const mc = entry.sparkIn === sparkIn ? undefined : miniChart(d, 100, 30);
  entry.sparkIn = sparkIn;
  const key = mc === undefined ? entry.spark : mc ? mc.line : '';
  if (entry.spark !== key) {
    entry.spark = key;
    q.svg.classList.toggle('down', !!mc && !mc.up);
    q.sp.setAttribute('d', mc ? mc.line : '');
    q.spA.setAttribute('d', mc ? mc.area : '');
    q.spD.setAttribute('d', mc ? mc.dot : '');
  }

  setIf(q.actX, 'href', `https://x.com/search?q=${encodeURIComponent(d.m)}&f=live`);
  for (const [node, v] of [[q.c5, d.c5], [q.c1, d.c1], [q.c4, d.c4]]) {
    node.textContent = fmt.pct(v);
    node.className = `pct ${cls(v)}`;
  }
  setText(q.mc, fmt.usd(d.mc));
  setText(q.mcV, fmt.usd(d.v24));
  setText(q.liq, fmt.usd(d.lq));
  setText(q.vol, fmt.usd(d.v1));

  // Buy / sell, 5 min — 1 h when quiet. With fresh Jupiter data both the counts and the USD volume
  // split come from it (all pools, so they agree); otherwise DexScreener's counts, without volume.
  // The bar weighs by volume when known, by counts otherwise.
  const jup = d.jb5 != null && d.bv5 != null;
  const [b5, s5, b1, s1] = jup ? [d.jb5, d.js5, d.jb1, d.js1] : [d.b5, d.s5, d.b1, d.s1];
  const use5 = b5 + s5 >= 6;
  const b = use5 ? b5 : b1;
  const s = use5 ? s5 : s1;
  const bv = jup ? (use5 ? d.bv5 : d.bv1) : null;
  const sv = jup ? (use5 ? d.sv5 : d.sv1) : null;
  const hasVol = bv != null && sv != null;
  const wb = hasVol ? bv : b;
  const ws = hasVol ? sv : s;
  q.bsB.style.flexGrow = wb || (ws ? 0 : 1);
  q.bsS.style.flexGrow = ws || (wb ? 0 : 1);
  setIf(q.bsNb, 'textContent', `▲ ${fmt.n(b)}`);
  setIf(q.bsNs, 'textContent', `▼ ${fmt.n(s)}`);
  setIf(q.bsVb, 'textContent', hasVol ? fmt.usd(bv) : '');
  setIf(q.bsVs, 'textContent', hasVol ? fmt.usd(sv) : '');
  q.bs.classList.toggle('h1', !use5);
  setIf(q.bs, 'title', `${use5 ? 'Ostatnie 5 min' : 'Ostatnia godzina'}: ${fmt.n(b)} kupna${hasVol ? ` za ${fmt.usd(bv)}` : ''}, ${fmt.n(s)} sprzedaży${hasVol ? ` za ${fmt.usd(sv)}` : ''}`);

  // Compact block under the token for narrow screens, where these columns don't fit: on the left
  // MC / Vol and buys over sells (count · volume); on the right 5m / 1h / 4h stacked.
  const chg = (label, v) => `<span class="q-c ${cls(v)}"><i>${label}</i>${fmt.pct(v)}</span>`;
  const win = use5 ? '5m' : '1h';
  const quick =
    `<div class="q-l">` +
    `<div class="q-mv"><span><i>MC</i>${fmt.usd(d.mc)}</span><span><i>Vol 24h</i>${fmt.usd(d.v24)}</span></div>` +
    `<div class="q-top">${sinceChip}${d.x != null ? `<span class="q-kv"><i>𝕏</i> ${d.x}${d.xc ? '+' : ''}/h</span>` : ''}</div>` +
    `<div class="q-bsx"><div class="q-bs">` +
    `<div class="q-b" title="Kupno — ostatnie ${use5 ? '5 min' : '1 h'}">▲ ${fmt.n(b)}${hasVol ? ` · ${fmt.usd(bv)}` : ''}<i>${win}</i></div>` +
    `<div class="q-s" title="Sprzedaż — ostatnie ${use5 ? '5 min' : '1 h'}">▼ ${fmt.n(s)}${hasVol ? ` · ${fmt.usd(sv)}` : ''}<i>${win}</i></div>` +
    `</div>${holderIcons(d)}</div>` +
    `</div>` +
    `<div class="q-r">${chg('5m', d.c5)}${chg('1h', d.c1)}${chg('4h', d.c4)}</div>`;
  if (entry.quick !== quick) {
    q.quick.innerHTML = quick;
    entry.quick = quick;
  }

  // Desktop: holder structure icons in their own column (phones show them in the quick block).
  const icons = holderIcons(d, true);
  if (entry.holdIc !== icons) {
    q.holdIc.innerHTML = icons;
    entry.holdIc = icons;
  }
  setText(q.x, d.x == null ? '—' : `${d.x}${d.xc ? '+' : ''}`, d.x, p.x);

  q.risk.className = `risk ${d.rk}`;
  q.risk.title = RISK_TXT[d.rk] || '';
  const watched = isWatched(d.m);
  q.star.classList.toggle('on', watched);
  q.star.textContent = watched ? '★' : '☆';

  entry.data = d;
}

// Values refresh in place every snapshot; the row ORDER changes at most every REORDER_MS so the
// list doesn't jump around under the reader's finger.
const REORDER_MS = 5_000;

// The list also holds still while a finger is on it or it is being scrolled, and for 1.5 s after
// (no tapping the wrong token because the rows moved).
let listHoldUntil = 0;
const listHeld = () => Date.now() < listHoldUntil;
function holdList(ms) {
  listHoldUntil = Math.max(listHoldUntil, Date.now() + ms);
  showHold();
}
let holdTimer = null;
function showHold() {
  const b = $('#holdBadge');
  if (!b) return;
  b.hidden = !listHeld();
  clearTimeout(holdTimer);
  if (listHeld()) holdTimer = setTimeout(showHold, listHoldUntil - Date.now() + 50);
}

function displayOrder(rows) {
  const now = Date.now();
  if (!state.order || state.firstSnapshot || (!listHeld() && now - (state.lastReorder || 0) >= REORDER_MS)) {
    state.lastReorder = now;
    state.order = rows.map((d) => d.m);
    return { list: rows, reordered: true };
  }
  const byMint = new Map(rows.map((d) => [d.m, d]));
  const kept = state.order.filter((m) => byMint.has(m));
  const keptSet = new Set(kept);
  state.order = [...kept, ...rows.filter((d) => !keptSet.has(d.m)).map((d) => d.m)];
  return { list: state.order.map((m) => byMint.get(m)), reordered: false };
}

function renderRows(rows) {
  const tbody = $('#rows');
  const { list, reordered } = displayOrder(rows);
  const current = [...tbody.children].map((el) => el.dataset.m);
  const orderChanged = current.length !== list.length || list.some((d, i) => current[i] !== d.m);

  const before = new Map();
  if (orderChanged) for (const [m, e] of state.rows) before.set(m, e.el.getBoundingClientRect().top);

  const seen = new Set();
  list.forEach((d, idx) => {
    seen.add(d.m);
    let entry = state.rows.get(d.m);
    if (!entry) {
      entry = { el: rowTemplate() };
      entry.el.dataset.m = d.m;
      if (!state.firstSnapshot) entry.el.classList.add('enter');
      state.rows.set(d.m, entry);
    }
    updateRow(entry, d, idx);
  });
  for (const [m, e] of state.rows) {
    if (!seen.has(m)) {
      e.el.remove();
      state.rows.delete(m);
    }
  }

  if (orderChanged) {
    // Move rows in place, one by one: never detach the whole list, or the page shrinks for a
    // moment and the browser jumps the scroll position back to the top.
    const scrollY = window.scrollY;
    let ref = tbody.firstElementChild;
    for (const d of list) {
      const el = state.rows.get(d.m).el;
      if (el === ref) ref = ref.nextElementSibling;
      else tbody.insertBefore(el, ref);
    }
    if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
    // FLIP: animate rows from old to new position.
    for (const [m, top] of before) {
      const e = state.rows.get(m);
      if (!e) continue;
      const dy = top - e.el.getBoundingClientRect().top;
      if (Math.abs(dy) > 2) {
        e.el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 600, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    }
  }

  if (reordered) state.prevRanks = new Map(list.map((d, i) => [d.m, i + 1]));
  const empty = $('#empty');
  empty.hidden = list.length > 0;
  if (!list.length) empty.innerHTML = emptyText();
  return list;
}

function emptyText() {
  if (state.view === 'watch') return '<b>Brak obserwowanych tokenów</b>Kliknij ☆ przy tokenie, aby dodać go do listy.';
  if (state.view === 'surge' && !state.firstSnapshot)
    return '<b>Brak wybić wolumenu w tej chwili</b>Pojawią się tu tokeny, których wolumen z 5 min jest co najmniej 2× wyższy niż ich średnia.';
  if (state.firstSnapshot) return '<b>Łączenie ze źródłami danych…</b>Pierwsze tokeny pojawią się w ciągu kilku sekund.';
  const f = state.filters;
  if (f.minMcap || f.minLiq || f.maxAgeH || f.safe || f.maxDev || f.minLp || f.paid || f.maxTop10 || f.maxIns || f.minHolders || f.auth || f.social) return '<b>Nic nie pasuje do filtrów</b>Poluzuj filtry, aby zobaczyć więcej tokenów.';
  if (state.hidden.size || state.blocked.size) return '<b>Brak tokenów do pokazania</b>Część tokenów jest ukryta lub zablokowana — sprawdź listę ukrytych.';
  return '<b>Zbieram dane…</b>Radar potrzebuje chwili, aby zebrać aktywność z rynku.';
}

function skeleton() {
  $('#rows').innerHTML = Array.from({ length: 8 }, () =>
    `<div class="row" style="cursor:default"><div><div class="sk" style="width:18px"></div></div>
      <div class="tok"><div class="av"></div><div style="flex:1"><div class="sk" style="width:60%;margin-bottom:6px"></div><div class="sk" style="width:40%;height:9px"></div></div></div>
      <div><div class="sk"></div></div></div>`,
  ).join('');
}

// ---------- snapshot handling ----------
function applyMode(s) {
  // Graduated-only mode: bonding-curve views and launch events don't apply.
  const only = !!s.onlyGraduated;
  if (state.onlyGraduated === only) return;
  state.onlyGraduated = only;
  for (const v of ['new', 'graduating']) $(`#tabs [data-view="${v}"]`).hidden = only;
  markChain();
  $('#feedChips [data-f="launch"]').hidden = only;
  if (only && (state.view === 'new' || state.view === 'graduating')) setView('graduated');
}

/**
 * Viewer-side filters on top of the engine's: hidden tokens, blocked creators and the holder
 * filters (dev %, LP burned, DEX paid). Watch / positions lists always show everything.
 */
function viewerFilter(rows, view) {
  if (view === 'watch') return rows;
  const f = state.filters;
  return rows.filter(
    (r) =>
      !state.hidden.has(r.m) &&
      !(r.cr && state.blocked.has(r.cr)) &&
      !(f.maxDev && r.dv != null && r.dv > f.maxDev) &&
      !(f.minLp && r.lpb != null && r.lpb < f.minLp) &&
      !(f.paid && r.dp !== true) &&
      !(f.maxTop10 && r.t10 != null && r.t10 > f.maxTop10) &&
      !(f.maxIns && r.ins != null && r.ins > f.maxIns) &&
      !(f.minHolders && !(r.h >= f.minHolders)) &&
      // Safety switches need the facts: unknown counts as not passing.
      !(f.auth && !(r.mad === true && r.fad === true)) &&
      !(f.social && !(r.tw || r.tg || r.web)),
  );
}

function applySnapshot(snap) {
  applyMode(snap.stats);
  // Whales come from the trades of watched tokens / positions / the open token (GeckoTerminal).
  $('#feedChips [data-f="whale"]').hidden = !snap.stats.liveTrades && !ENGINE;
  snap.rows = viewerFilter(snap.rows, snap.view).slice(0, 100);
  if (snap.view === 'hype') state.hypeRows = snap.rows;
  if (snap.stats.solPrice > 0) state.nativeUsd[ENGINE?.chain || 'solana'] = snap.stats.solPrice;
  renderStats(snap.stats);
  renderSources(snap.sources);
  $('#liveBadge').className = `live-badge${state.paused ? ' paused' : ''}`;
  $('#liveBadge').lastChild.textContent = STATIC ? 'MIGAWKA' : state.paused ? 'PAUZA' : 'LIVE';
  if (snap.view === 'hype') $('#c-hype').textContent = fmt.n(snap.stats.ranked);
  // Paused: keep the table frozen — but a new tab / network still gets its first render.
  if ((state.paused && !state.firstSnapshot) || snap.view !== state.view) return;
  if (state.firstSnapshot) $('#rows').innerHTML = '';
  renderRows(snap.rows);
  state.firstSnapshot = false;
}

function staticRows() {
  const all = new Map();
  for (const rows of Object.values(STATIC.views)) for (const r of rows) all.set(r.m, r);
  return all;
}

function staticSnapshot() {
  const f = state.filters;
  const now = STATIC.t;
  const pass = (r) =>
    !(f.minMcap && (r.mc || 0) < f.minMcap) &&
    !(f.minLiq && (r.lq || 0) < f.minLiq) &&
    !(f.maxAgeH && r.ca && now - r.ca > f.maxAgeH * 3600e3) &&
    !(f.safe && r.rk === 'danger');
  const rows =
    state.view === 'watch'
      ? [...state.watch].map((m) => staticRows().get(m)).filter(Boolean)
      : (STATIC.views[state.view] || STATIC.views.hype).filter(pass);
  return { t: STATIC.t, view: state.view, rows, stats: STATIC.stats, sources: STATIC.sources };
}

function connect() {
  if (ENGINE) {
    clearInterval(state.tick);
    const f = state.filters;
    const filters = { minMcap: f.minMcap || 0, minLiq: f.minLiq || 0, maxAgeH: f.maxAgeH || 0, safe: !!f.safe, q: '' };
    const run = () => {
      state.lastSnapshot = Date.now();
      // The win rate always counts the main Hype list, whichever tab is open.
      // Viewer-side filters (hidden, holders, safety…) need more rows than the 100 shown.
      const vf = state.filters;
      const lim = state.hidden.size || state.blocked.size || vf.maxDev || vf.minLp || vf.paid || vf.maxTop10 || vf.maxIns || vf.minHolders || vf.auth || vf.social ? 600 : 100;
      if (state.view !== 'hype') state.hypeRows = viewerFilter(ENGINE.snapshot('hype', filters, lim).rows, 'hype').slice(0, 100);
      // Demo positions on this network stay loaded even when off the list.
      const posHere = Object.keys(state.positions).filter((m) => (state.positions[m].chain || 'solana') === ENGINE.chain);
      // …and with the watched ones, their trades feed the whale / tracked-wallet alerts.
      ENGINE.track([...new Set([...posHere, ...watchedHere()])]);
      applySnapshot(ENGINE.snapshot(state.view, filters, lim, state.view === 'watch' ? watchedHere() : []));
      if (sheetOpen('pos') && !sheetBusy()) renderPositions();
      if (sheetOpen('wallet') && !sheetBusy()) renderWallet();
    };
    // Interval first: a connect() re-entered from the first run clears it instead of leaking it.
    state.tick = setInterval(run, 2000);
    run();
    if (!state.feedBound) {
      state.feedBound = true;
      state.feed = ENGINE.feed();
      renderFeed(true);
      ENGINE.onFeed(addFeed);
    }
    return;
  }
  if (STATIC) {
    state.lastSnapshot = Date.now();
    applySnapshot(staticSnapshot());
    if (!state.feed.length) {
      state.feed = STATIC.feed;
      renderFeed(true);
    }
    return;
  }
  state.es?.close();
  const f = state.filters;
  const params = new URLSearchParams({ view: state.view, limit: '100' });
  if (f.minMcap) params.set('minMcap', f.minMcap);
  if (f.minLiq) params.set('minLiq', f.minLiq);
  if (f.maxAgeH) params.set('maxAgeH', f.maxAgeH);
  if (f.safe) params.set('safe', '1');
  if (state.view === 'watch') params.set('mints', watchedHere().join(','));
  if (state.view !== 'hype') state.hypeRows = null; // win rate needs the Hype list (not streamed here)
  const es = new EventSource(`/api/stream?${params}`);
  state.es = es;
  es.addEventListener('snapshot', (e) => {
    state.lastSnapshot = Date.now();
    applySnapshot(JSON.parse(e.data));
  });
  es.addEventListener('feedInit', (e) => {
    state.feed = JSON.parse(e.data);
    renderFeed(true);
  });
  es.addEventListener('feed', (e) => addFeed(JSON.parse(e.data)));
  es.onerror = () => $('#liveBadge').classList.add('off');
}

// Connection watchdog (SSE auto-reconnects, but surface staleness).
setInterval(() => {
  if (STATIC) return;
  const stale = Date.now() - state.lastSnapshot > 8000;
  $('#liveBadge').classList.toggle('off', stale);
  if (stale) $('#liveBadge').lastChild.textContent = 'OFFLINE';
}, 2000);

// ---------- hype freshness / creator history / positions ----------
const FRESH = {
  hot: ['🚀', 'Rozkręca się', 'up'],
  up: ['📈', 'Przyspiesza', 'up'],
  flat: ['➡️', 'Stabilnie', ''],
  cool: ['😴', 'Słabnie', 'warn'],
  dead: ['📉', 'Wygasa', 'down'],
};

/** Polish plural: pl(n, 'token', 'tokeny', 'tokenów') → 1 token, 2–4 tokeny, 5+ / 12–14 tokenów. */
const pl = (n, one, few, many) => (n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const plTokens = (n) => pl(n, 'token', 'tokeny', 'tokenów');

/** Warning for a creator with a bad track record (serial launcher / honeypot deployer), or null. */
function creatorWarning(d) {
  if (d.dhp > 0) return { short: '☠️ twórca honeypotów', tip: `Ten twórca wdrożył już ${d.dhp} honeypot(y) (GoPlus)` };
  if (d.dr != null && d.dr < 25 && !(d.dm >= 20))
    return { short: '🧑‍🍳 seryjny twórca', tip: `Ocena deva ${d.dr}/100 — wiele tokenów, które do niczego nie doszły` };
  if (d.dm >= 20 && (d.dmg || 0) / d.dm < 0.05)
    return { short: '🧑‍🍳 seryjny twórca', tip: `Twórca stworzył ${fmt.n(d.dm)} tokenów, graduację przeszło ${fmt.n(d.dmg || 0)}` };
  return null;
}

/** The viewer's position in a token: P&L vs. the saved entry price, or null. */
/** The viewer's position in this address on the network on screen (an EVM address can be a
 *  different token on another network), or null. */
function posHere(m) {
  const p = state.positions[m];
  return p && (p.chain || 'solana') === (ENGINE?.chain || 'solana') ? p : null;
}

function posPnl(d) {
  const p = posHere(d.m);
  if (!p || !(p.p > 0) || !(d.p > 0)) return null;
  const pct = (d.p / p.p - 1) * 100;
  return { pct, usd: p.usd > 0 ? p.usd * (d.p / p.p - 1) : null, value: p.usd > 0 ? p.usd * (d.p / p.p) : null, cls: pct >= 0 ? 'up' : 'down', entry: p };
}

function renderPosCount() {
  const n = Object.keys(state.positions).length;
  $('#c-pos').textContent = n || '';
}

/** "150k", "1.5m", "2,3M", "$80K", "250000" → number (NaN when unreadable). */
function parseAmount(text) {
  // Thousands separators first ("150,000", "1,234,567"), then a decimal comma ("2,5m").
  const m = String(text || '')
    .trim()
    .replace(/[\s$]/g, '')
    .replace(/,(?=\d{3}(?:,\d{3})*(?:\.\d+)?[kmb]?$)/gi, '')
    .replace(',', '.')
    .match(/^(\d*\.?\d+)([kmb])?$/i);
  if (!m) return NaN;
  return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1);
}

// ---------- demo wallet ----------
function saveWallet() {
  state.wallet.tx = state.wallet.tx.slice(0, 200);
  LS.set('wallet', state.wallet);
}
function walletTx(type, amount, extra = {}) {
  state.wallet.tx.unshift({ t: Date.now(), type, amount, ...extra });
}
function deposit(amount) {
  state.wallet.cash += amount;
  state.wallet.deposits += amount;
  walletTx('deposit', amount);
  saveWallet();
}

// ---------- realistic demo fees ----------
// Every demo buy and sell pays what a real trade costs: the trading platform's fee (Axiom /
// Photon / BullX / GMGN take 1%), the DEX pool's swap fee (~0.3% on PumpSwap / Raydium /
// Uniswap / PancakeSwap) and the network fee — on Solana the base fee + priority fee / tip,
// ~0.001 SOL per transaction; gas on the EVM networks.
const FEES = {
  platform: 0.01,
  pool: 0.003,
  solTx: 0.001, // SOL per Solana transaction (priority fee + tip + base fee)
  gasUsd: { ethereum: 3, base: 0.05, bsc: 0.1, robinhood: 0.05 }, // $ per EVM transaction
};
/** Network fee of one transaction in $. */
function networkFee(chain = ENGINE?.chain || 'solana') {
  if (chain === 'solana') return FEES.solTx * (state.nativeUsd.solana || 150);
  return FEES.gasUsd[chain] ?? 0.1;
}
/** All fees of one trade worth `usd` on `chain` (0 with fees turned off). */
function tradeFee(usd, chain) {
  if (!state.fees || !(usd > 0)) return 0;
  return usd * (FEES.platform + FEES.pool) + networkFee(chain);
}
/** Fee amounts with cents ($1.42, $0.17) — fmt.usd rounds small values to whole dollars. */
const feeUsd = (v) => (v >= 1000 ? fmt.usd(v) : `$${(v || 0).toFixed(2)}`);
const feeNote = (fee) => (fee > 0 ? ` · opłaty ${feeUsd(fee)}` : '');

/** Buy price after fees: `usd` buys only (usd − fee) worth of tokens, so the entry is higher.
 *  null when the fees would eat most of the amount. */
function entryAfterFees(price, usd) {
  const fee = tradeFee(usd);
  if (fee >= usd * 0.5) return null;
  return { price: price * (usd / (usd - fee)), fee };
}

/** Saves a demo buy; false when it can't be added to the existing position (nothing is charged). */
function savePosition(mint, price, usd, mc, d = {}, fee = 0) {
  const prev = state.positions[mint];
  if (prev && prev.p > 0 && prev.usd > 0) {
    // The same EVM address can be a different token on another network.
    if ((prev.chain || 'solana') !== (ENGINE?.chain || 'solana')) {
      toast('Masz już pozycję DEMO pod tym adresem na innej sieci — najpierw ją sprzedaj');
      return false;
    }
    // Positions from before a wallet reset (or the wallet) aren't funded from it: new money
    // added to them could never come back.
    if (prev.w !== true) {
      toast('Ta pozycja jest poza walletem DEMO — sprzedaj ją, zanim dokupisz');
      return false;
    }
  }
  // Funded from the demo wallet: the stake leaves the balance now and returns (with P&L) on close.
  state.wallet.cash -= usd;
  walletTx('open', usd, { m: mint, n: d.n || '', s: d.s || '', p: price, ...(fee > 0 ? { fee } : {}) });
  saveWallet();
  if (prev && prev.p > 0 && prev.usd > 0) {
    // Buying more: one position with the average entry (weighted by tokens bought).
    const tokens = prev.usd / prev.p + usd / price;
    prev.p = (prev.usd + usd) / tokens;
    prev.mc = prev.mc && mc ? (prev.usd + usd) / (prev.usd / prev.mc + usd / mc) : prev.mc || mc;
    prev.usd += usd;
    prev.fees = (prev.fees || 0) + fee;
    // Break even is measured from the new average entry: armed only if still above +BE_PCT.
      // (measured at the market price, like the exit checks — the buy price includes the fees)
    if (prev.be) prev.bea = ((d.p > 0 ? d.p : price) / prev.p - 1) * 100 > BE_PCT;
    LS.set('positions', state.positions);
    renderPosCount();
    return true;
  }
  state.positions[mint] = {
    w: true,
    p: price,
    mc: mc || 0,
    usd: usd > 0 ? usd : 0,
    fees: fee, // fees paid so far ($), shown with the position
    t: Date.now(),
    chain: ENGINE?.chain || 'solana',
    // Name / icon and last seen price, for the positions list when the token isn't loaded.
    n: d.n || '',
    s: d.s || '',
    i: d.i || '',
    last: d.p > 0 ? { p: d.p, mc: d.mc || 0, at: Date.now() } : null,
  };
  LS.set('positions', state.positions);
  renderPosCount();
  return true;
}

/** Closes a demo position at `price` (its current price), keeping the result for the P&L history. */
/** Sells `fraction` (0–1] of a demo position at `price`; 1 closes it. */
function sellPosition(mint, fraction, price, extra = {}) {
  const p = state.positions[mint];
  if (!p) return;
  const f = p.usd > 0 ? Math.min(1, Math.max(0, fraction)) : 1;
  const exit = price > 0 ? price : p.last?.p;
  const part = (p.usd || 0) * f;
  // The sold part's value, minus the sale's fees (platform + pool + network).
  const gross = part > 0 ? (exit > 0 && p.p > 0 ? part * (exit / p.p) : part) : 0;
  const fee = Math.min(gross, tradeFee(gross, p.chain || 'solana'));
  const back = gross - fee;
  if (part > 0) p.fees = (p.fees || 0) + fee;
  // Wallet-funded positions pay it back into the demo balance.
  if (p.w && part > 0) {
    state.wallet.cash += back;
    walletTx('close', back, { m: mint, n: p.n, s: p.s, pnl: back - part, f, p: exit, ...(fee > 0 ? { fee } : {}) });
    saveWallet();
  }
  if (exit > 0 && p.p > 0) {
    const pct = part > 0 ? (back / part - 1) * 100 : (exit / p.p - 1) * 100;
    state.closed.unshift({
      m: mint, n: p.n, s: p.s, chain: p.chain, usd: part, pct, f,
      // Positions outside the wallet (opened before a reset) stay out of the statistics.
      w: p.w !== false,
      pnl: part > 0 ? back - part : 0, fee, openedAt: p.t, closedAt: Date.now(), ...extra,
    });
    state.closed = state.closed.filter((c) => Date.now() - c.closedAt < 90 * 86400e3).slice(0, 500);
    LS.set('closedPositions', state.closed);
  }
  if (f >= 1 || p.usd - part < 0.005) delete state.positions[mint];
  else p.usd -= part;
  LS.set('positions', state.positions);
  renderPosCount();
  return fee;
}
const closePosition = (mint, price) => sellPosition(mint, 1, price);

/** Buys `usd` of the token in the drawer at the current price (quick buy). */
/**
 * The freshest price for a trade in the open token: the radar's row (live every second while the
 * chart is open, and what the exit checks use), else the chart's live price, else the detail.
 * Only fresh: right after a network switch the row may hold a paused network's old price.
 */
function tradeQuote(d) {
  const live = state.live?.m === d.m && Date.now() - state.live.at < 10_000 ? state.live : null;
  const row = ENGINE?.rowsFor ? ENGINE.rowsFor(ENGINE.chain, [d.m])[0] : null;
  const rowOk = row?.p > 0 && (!(ENGINE?.since > 0) || row.pa >= ENGINE.since);
  const p = rowOk ? row.p : live?.p > 0 ? live.p : d.p;
  const mc = rowOk && row.mc > 0 ? row.mc : live?.p > 0 && live.mc > 0 ? live.mc : d.p > 0 && d.mc > 0 ? d.mc * (p / d.p) : d.mc;
  return { ...d, p, mc };
}

function quickBuy(usd) {
  const d0 = state.detail;
  if (!d0 || !state.selected) return;
  const d = tradeQuote(d0);
  if (usd > state.wallet.cash + 1e-9) {
    toast(`Za mało środków w walletcie DEMO (saldo ${fmt.usd(state.wallet.cash)}) — doładuj go`);
    closeDetail();
    return openWallet('spot');
  }
  if (!(d.p > 0) || !(d.mc > 0)) return toast('Brak ceny lub MC — spróbuj za chwilę');
  const had = !!posHere(state.selected);
  const buy = entryAfterFees(d.p, usd);
  if (!buy) return toast(`Za mała kwota — opłaty transakcji (${feeUsd(tradeFee(usd))}) zjadłyby większość`);
  if (!savePosition(state.selected, buy.price, usd, d.mc, d, buy.fee)) return;
  toast(`💼 ${had ? 'Dokupiono' : 'Kupiono'} DEMO za ${fmt.usd(usd)} przy MC ${fmt.usd(d.mc)}${feeNote(buy.fee)}`);
  renderDetail(d0);
}

function editQuickBuy() {
  const text = prompt('Kwoty szybkiego zakupu w $ (oddziel przecinkami, max 6):', state.quickBuy.join(', '));
  if (text == null) return;
  const list = text.split(/[,;\s]+/).map(parseAmount).filter((v) => v > 0).slice(0, 6);
  if (!list.length) return toast('Nie rozumiem kwot — wpisz np. 50, 100, 250');
  state.quickBuy = list;
  LS.set('quickBuy', list);
  if (state.detail) renderDetail(state.detail);
  toast('Zapisano przyciski szybkiego zakupu');
}

const quickBuyRow = (label) =>
  `<div class="qb-row"><span>${label}</span>${state.quickBuy.map((v) => `<button data-act="qbuy" data-usd="${v}">+$${fmt.n(v)}</button>`).join('')}<button class="qb-edit" data-act="qbuy-edit" aria-label="Ustaw kwoty szybkiego zakupu" title="Ustaw kwoty">⚙︎</button></div>`;
const sellRow = (attr) =>
  `<div class="qs-row">${[25, 50, 75, 100].map((v) => `<button ${attr}="${v}">${v === 100 ? 'Sprzedaj 100%' : `${v}%`}</button>`).join('')}</div>`;

// ---------- stop loss / take profit ----------
// Each position can carry p.sl (sell everything once down that %) and p.tp (once up that %).
const EXITS = {
  sl: { name: 'Stop loss', icon: '🛑', sign: '−', presets: [10, 20, 30, 50], max: 99, attr: 'sl' },
  tp: { name: 'Take profit', icon: '🎯', sign: '+', presets: [50, 100, 200, 500], max: 100000, attr: 'tp' },
  be: { name: 'Break even', icon: '🛡️' },
  safe: { name: 'SAFE', icon: '🔒' },
};
// SAFE: at +SAFE_PCT sell SAFE_PART of the position — at +100% half of it is worth the whole
// stake, so the stake comes back and the rest stays in play with nothing left to lose.
const SAFE_PCT = 100;
const SAFE_PART = 0.5;
// Break even: once the position has been above +BE_PCT, sell everything if it falls back there.
const BE_PCT = 5;

function setExit(kind, mint, pct) {
  const p = state.positions[mint];
  const k = EXITS[kind];
  if (!p) return;
  if (pct > 0) p[kind] = Math.min(k.max, pct);
  else delete p[kind];
  LS.set('positions', state.positions);
  toast(pct > 0 ? `${k.icon} ${k.name} ustawiony: ${k.sign}${fmt.n(p[kind])}%` : `${k.name} wyłączony`);
}

/** Manual level: a % ("25") or the market cap to sell at ("80k", "1.2m"). */
/** A position's entry market cap including the buy fees (MC moves 1:1 with price). */
const mcEntryOf = (p) => (p.last?.p > 0 && p.last?.mc > 0 ? (p.last.mc * p.p) / p.last.p : p.mc);

function askExit(kind, mint) {
  const p = state.positions[mint];
  const k = EXITS[kind];
  if (!p) return;
  const ex = kind === 'sl' ? 'stratę w % (np. 25) albo MC, przy którym sprzedać (np. 80k)' : 'zysk w % (np. 150) albo MC, przy którym sprzedać (np. 2m)';
  const text = prompt(`${k.name}: wpisz ${ex}:`, p[kind] ? String(p[kind]) : '');
  if (text == null) return;
  const raw = text.trim().replace(/[%+\-−]/g, '');
  const v = parseAmount(raw);
  if (!(v > 0)) return toast(kind === 'sl' ? 'Nie rozumiem — wpisz np. 25 albo 80k' : 'Nie rozumiem — wpisz np. 150 albo 2m');
  // With k / m / b it is a market cap; a bare number is a % (for stop loss only below 100).
  const isMc = /[kmb]$/i.test(raw) || (kind === 'sl' ? v >= 100 : v >= 100000);
  if (!isMc) return setExit(kind, mint, v);
  // Against the entry MC with the buy fees included (the exits compare prices with that entry).
  const mcIn = mcEntryOf(p);
  if (!(mcIn > 0)) return toast('Brak MC wejścia — wpisz wartość w %');
  const pct = kind === 'sl' ? (1 - v / mcIn) * 100 : (v / mcIn - 1) * 100;
  if (!(pct > 0 && pct < k.max)) return toast(`MC musi być ${kind === 'sl' ? 'niższe' : 'wyższe'} niż MC wejścia (${fmt.usd(mcIn)})`);
  setExit(kind, mint, Math.round(pct * 10) / 10);
}

const exitRow = (kind, p, attr) => {
  const k = EXITS[kind];
  const v = p[kind];
  // Market cap at the trigger price (the entry price includes the buy fees; MC moves with price).
  const mcEntry = mcEntryOf(p);
  const mcAt = v && mcEntry > 0 ? mcEntry * (kind === 'sl' ? 1 - v / 100 : 1 + v / 100) : null;
  // Expected result of this level: TP on the share it sells, SL on the whole position.
  const share = kind === 'tp' ? (p.tpf || 100) / 100 : 1;
  // After the sale's fees.
  const gross = v && p.usd > 0 ? p.usd * share * (kind === 'sl' ? 1 - v / 100 : 1 + v / 100) : null;
  const back = gross != null ? gross - Math.min(gross, tradeFee(gross, p.chain || 'solana')) : null;
  const est = back != null ? Math.abs(back - p.usd * share) : null;
  const estLine = est != null
    ? `<small class="sl-est ${kind}">${kind === 'tp' ? `Przewidywany zysk: <b>${back >= p.usd * share ? '+' : '−'}${fmt.usd(est)}</b>${share < 1 ? ` (sprzeda ${Math.round(share * 100)}% za ${fmt.usd(back)})` : ` (wypłata ${fmt.usd(back)})`}` : `Przewidywana strata: <b>−${fmt.usd(est)}</b> (wróci ${fmt.usd(back)})`}${state.fees ? ' · po opłatach' : ''}</small>`
    : '';
  return `<div class="sl-row ${kind}"><span>${k.icon} ${k.name}${v ? ` <b>${k.sign}${fmt.n(v)}%</b>${mcAt ? ` <small>MC ${fmt.usd(mcAt)}</small>` : ''}` : ' <small>wyłączony</small>'}</span>${estLine}
    <div>${k.presets.map((x) => `<button ${attr}="${kind}:${x}" class="${v === x ? 'on' : ''}">${k.sign}${x}%</button>`).join('')}<button ${attr}="${kind}:custom" class="${v && !k.presets.includes(v) ? 'on' : ''}">Własny</button>${kind === 'sl' ? `<button ${attr}="safe:toggle" class="safe ${p.safe ? 'on' : ''}" title="SAFE: sprzeda ${SAFE_PART * 100}% pozycji przy +${SAFE_PCT}% — wkład wraca, reszta zostaje w grze">🔒 SAFE · wyjmij wkład (+${SAFE_PCT}%)</button>` : ''}${kind === 'sl' ? `<button ${attr}="be:toggle" class="be ${p.be ? 'on' : ''}" title="Break even: sprzeda całość, gdy cena spadnie do +${BE_PCT}% od wejścia">🛡️ BE · Break even (+${BE_PCT}%)</button>` : ''}${v ? `<button ${attr}="${kind}:off" class="off" aria-label="Wyłącz">✕</button>` : ''}</div>${
      kind === 'sl' && p.be
        ? `<small class="sl-est be">🛡️ BE ${p.bea ? `aktywny — sprzeda całość przy <b>+${BE_PCT}%</b>${mcEntry > 0 ? ` (MC ${fmt.usd(mcEntry * (1 + BE_PCT / 100))})` : ''}${p.usd > 0 ? ((g) => { const r = g - Math.min(g, tradeFee(g, p.chain || 'solana')) - p.usd; return `, ${r >= 0 ? 'zysk' : 'strata'} <b>${r >= 0 ? '+' : '−'}${fmt.usd(Math.abs(r))}</b>${state.fees ? ' po opłatach' : ''}`; })(p.usd * (1 + BE_PCT / 100)) : ''}` : `czeka, aż zysk przekroczy +${BE_PCT}% — potem pilnuje ceny +${BE_PCT}%`}</small>`
        : ''
    }${
      kind === 'sl' && p.safe
        ? `<small class="sl-est safe">🔒 SAFE — sprzeda <b>${SAFE_PART * 100}%</b> przy <b>+${SAFE_PCT}%</b>${mcEntry > 0 ? ` (MC ${fmt.usd(mcEntry * (1 + SAFE_PCT / 100))})` : ''}${p.usd > 0 ? ((g) => `: wróci <b>${fmt.usd(g - Math.min(g, tradeFee(g, p.chain || 'solana')))}</b> (${state.fees ? 'wkład minus opłata sprzedaży' : 'cały wkład'}), a ${SAFE_PART * 100}% zostanie w grze`)(p.usd * SAFE_PART * (1 + SAFE_PCT / 100)) : ''}</small>`
        : ''
    }${
      kind === 'tp'
        ? `<span class="sl-sub">Ile pozycji sprzedać</span><div>${[25, 50, 75, 100].map((x) => `<button ${attr}="tpf:${x}" class="${(p.tpf || 100) === x ? 'on' : ''}">${x}%</button>`).join('')}</div>`
        : ''
    }</div>`;
};
const exitRows = (p, attr) => exitRow('tp', p, attr) + exitRow('sl', p, attr);
function exitClick(mint, value) {
  const [kind, v] = value.split(':');
  if (kind === 'safe') {
    const p = state.positions[mint];
    if (!p) return;
    if (p.safe) delete p.safe;
    else p.safe = true;
    LS.set('positions', state.positions);
    return toast(p.safe ? `🔒 SAFE: przy +${SAFE_PCT}% sprzeda ${SAFE_PART * 100}% i wyjmie wkład` : 'SAFE wyłączony');
  }
  if (kind === 'be') {
    const p = state.positions[mint];
    if (!p) return;
    if (p.be) {
      delete p.be;
      delete p.bea;
      LS.set('positions', state.positions);
      return toast('Break even wyłączony');
    }
    const x = positionList().find((y) => y.m === mint);
    p.be = true;
    // Armed right away when already above +BE_PCT; otherwise once the price gets there.
    p.bea = x?.pct > BE_PCT;
    LS.set('positions', state.positions);
    return toast(p.bea ? `🛡️ Break even: sprzeda całość, gdy cena spadnie do +${BE_PCT}%` : `🛡️ Break even włączy się, gdy zysk przekroczy +${BE_PCT}%`);
  }
  if (kind === 'tpf') {
    // Share of the position the take profit sells (the rest stays open).
    const p = state.positions[mint];
    if (!p) return;
    p.tpf = Number(v);
    LS.set('positions', state.positions);
    return toast(`🎯 Take profit sprzeda ${p.tpf}% pozycji`);
  }
  if (!EXITS[kind]) return;
  if (v === 'custom') askExit(kind, mint);
  else setExit(kind, mint, v === 'off' ? null : Number(v));
}

/** Sells every position whose live price reached its stop loss or take profit (while the app is open). */
function checkExits() {
  if (!Object.values(state.positions).some((p) => p.sl || p.tp || p.be || p.safe)) return;
  let hit = false;
  for (const x of positionList()) {
    if (x.stale || x.pct == null) continue;
    if (x.p.be && !x.p.bea && x.pct > BE_PCT) {
      x.p.bea = true;
      LS.set('positions', state.positions);
      hit = true;
    }
    const kind =
      x.p.sl && x.pct <= -x.p.sl ? 'sl'
      : x.p.safe && x.pct >= SAFE_PCT ? 'safe'
      : x.p.tp && x.pct >= x.p.tp ? 'tp'
      : x.p.be && x.p.bea && x.pct <= BE_PCT ? 'be'
      : null;
    if (!kind) continue;
    const f = kind === 'tp' ? (x.p.tpf || 100) / 100 : kind === 'safe' ? SAFE_PART : 1;
    const fee = sellPosition(x.m, f, x.r.p, { [kind]: true });
    // A partial take profit / SAFE fires once; the rest of the position stays open without it.
    const left = state.positions[x.m];
    if (left) {
      delete left[kind];
      LS.set('positions', state.positions);
    }
    toast(`${EXITS[kind].icon} ${EXITS[kind].name}: sprzedano ${f < 1 ? `${Math.round(f * 100)}% ` : ''}${x.p.s ? '$' + x.p.s : f < 1 ? 'pozycji' : 'pozycję'} przy ${fmt.pct(x.pct)}${feeNote(fee)}`);
    hit = true;
  }
  if (!hit) return;
  // A finger on the screen: the regular refresh redraws once it lifts (a rebuild now would
  // swallow the tap on iOS).
  if (!sheetBusy()) {
    if (sheetOpen('pos')) renderPositions();
    if (sheetOpen('wallet')) renderWallet();
  }
  if (state.detail && Date.now() >= drawerTouch) renderDetail(state.detail);
}
setInterval(checkExits, 2000);

// ---------- open demo positions (bottom bar) ----------
let posSaveAt = 0;

/** Every open position with its latest known price: live from the network's engine when it has
 *  run this session, otherwise the last price seen. */
function positionList() {
  const byChain = {};
  for (const [m, p] of Object.entries(state.positions)) (byChain[p.chain || 'solana'] ??= []).push(m);
  const live = new Map();
  for (const [chain, mints] of Object.entries(byChain)) {
    // Only the network on screen is live; a paused network's prices are frozen, so its
    // positions use the last price seen while it was on screen (shown as such).
    if (ENGINE && chain !== ENGINE.chain) continue;
    const rows = ENGINE ? ENGINE.rowsFor(chain, mints) : mints.map((m) => state.rows.get(m)?.data).filter(Boolean);
    // Right after switching back to a paused network its prices are hours old: a row counts as
    // live only once a source has refreshed its price (protects SL / TP / BE from stale prices).
    for (const r of rows) if (r?.p > 0 && (!ENGINE || !(ENGINE.since > 0) || r.pa >= ENGINE.since)) live.set(r.m, r);
  }
  const now = Date.now();
  let dirty = false;
  const list = Object.entries(state.positions).map(([m, p]) => {
    const r = live.get(m);
    if (r) {
      p.last = { p: r.p, mc: r.mc || 0, at: now };
      if (!p.n && r.n) Object.assign(p, { n: r.n, s: r.s, i: r.i });
      dirty = true;
    }
    const cur = r?.p || p.last?.p || 0;
    const ratio = cur > 0 && p.p > 0 ? cur / p.p : null;
    return {
      m, p, r, ratio, stale: !r,
      mcNow: r?.mc || p.last?.mc || null,
      mcIn: p.mc || (ratio && (r?.mc || p.last?.mc) ? (r?.mc || p.last.mc) / ratio : null),
      pct: ratio ? (ratio - 1) * 100 : null,
      value: ratio && p.usd > 0 ? p.usd * ratio : null,
      pnl: ratio && p.usd > 0 ? p.usd * (ratio - 1) : null,
    };
  });
  if (dirty && now - posSaveAt > 10_000) {
    posSaveAt = now;
    LS.set('positions', state.positions);
  }
  return list.sort((a, b) => b.p.t - a.p.t);
}

/** P&L of demo trades opened in the window: open ones at the current price, closed at exit. */
function pnlWindow(list, ms) {
  const now = Date.now();
  let pnl = 0;
  let cost = 0;
  let trades = 0;
  for (const x of list) {
    if (now - x.p.t > ms || x.pnl == null) continue;
    pnl += x.pnl;
    cost += x.p.usd;
    trades++;
  }
  for (const c of state.closed) {
    if (c.w === false || now - c.openedAt > ms) continue;
    pnl += c.pnl;
    cost += c.usd;
    trades++;
  }
  return { pnl, pct: cost > 0 ? (pnl / cost) * 100 : null, trades };
}

/** Profitable / losing demo positions, each counted once by its total result: open ones by the
 *  parts already sold plus the current P&L, closed ones by the sum of their sales. */
function winLoss(stat, list) {
  const trades = new Map();
  for (const c of state.closed) {
    if (c.w === false) continue;
    const k = `${c.m}:${c.openedAt}`;
    trades.set(k, (trades.get(k) ?? 0) + (c.usd > 0 ? c.pnl : c.pct));
  }
  const open = { win: 0, loss: 0 };
  for (const x of stat) {
    const now = x.p.usd > 0 ? x.pnl : x.pct;
    if (now == null) continue;
    const v = (trades.get(`${x.m}:${x.p.t}`) ?? 0) + now;
    if (Math.abs(v) < 1e-9) continue;
    open[v > 0 ? 'win' : 'loss']++;
  }
  // Partly sold positions still open are counted with the open ones.
  for (const x of list) trades.delete(`${x.m}:${x.p.t}`);
  const closed = { win: 0, loss: 0 };
  for (const v of trades.values()) if (v) closed[v > 0 ? 'win' : 'loss']++;
  const win = open.win + closed.win;
  const loss = open.loss + closed.loss;
  const rate = win + loss ? (win / (win + loss)) * 100 : null;
  const sub = (o, c) => `${o} ${pl(o, 'otwarta', 'otwarte', 'otwartych')} · ${c} ${pl(c, 'zamknięta', 'zamknięte', 'zamkniętych')}`;
  return `<div class="pos-wl">
      <div class="win"><span>Zyskowne</span><b>${win}</b><small>${sub(open.win, closed.win)}</small></div>
      <div class="loss"><span>Stratne</span><b>${loss}</b><small>${sub(open.loss, closed.loss)}</small></div>
      <div><span>Skuteczność</span><b class="${rate == null ? 'muted' : rate >= 50 ? 'up' : 'down'}">${rate == null ? '—' : `${Math.round(rate)}%`}</b>
        <i class="wl-bar"><i style="width:${rate ?? 0}%"></i></i></div>
    </div>`;
}

function renderPositions() {
  const body = $('#posBody');
  const list = positionList();
  // Statistics count the wallet's positions; ones opened before a wallet reset stay listed only.
  const stat = list.filter((x) => x.p.w !== false);
  const cost = stat.reduce((a, x) => a + (x.p.usd || 0), 0);
  const value = stat.reduce((a, x) => a + (x.value ?? x.p.usd ?? 0), 0);
  const pnl = value - cost;
  const sign = (v) => (v >= 0 ? '+' : '−');
  const money = (v) => `${sign(v)}${fmt.usd(Math.abs(v))}`;
  const w = [['1d', 86400e3], ['7d', 7 * 86400e3], ['30d', 30 * 86400e3]].map(([k, ms]) => [k, pnlWindow(stat, ms)]);
  const summary = `<div class="wallet-line">👛 Saldo walletu DEMO: <b>${fmt.usd(state.wallet.cash)}</b> <button data-sheet-wallet>Wallet</button></div>
    <div class="pos-sum">
      <div><span>Wkład</span><b>${fmt.usd(cost)}</b></div>
      <div><span>Wartość</span><b>${fmt.usd(value)}</b></div>
      <div><span>Zysk / strata</span><b class="${pnl >= 0 ? 'up' : 'down'}">${money(pnl)}${cost > 0 ? ` <small>${fmt.pct((pnl / cost) * 100)}</small>` : ''}</b></div>
    </div>
    ${winLoss(stat, list)}
    <div class="pos-pnl">${w
      .map(([k, x]) => `<div><span>PnL ${k}</span><b class="${x.trades ? (x.pnl >= 0 ? 'up' : 'down') : 'muted'}">${x.trades ? money(x.pnl) : '—'}</b><small>${x.trades ? `${x.pct != null ? fmt.pct(x.pct) + ' · ' : ''}${x.trades} ${pl(x.trades, 'pozycja', 'pozycje', 'pozycji')}` : 'brak'}</small></div>`)
      .join('')}</div>
    <p class="note">PnL okresu = pozycje otwarte w tym czasie (otwarte liczone po obecnej cenie, zamknięte po cenie zamknięcia). To pozycje treningowe — bez prawdziwych pieniędzy.</p>`;
  const cards = list.length
    ? list
        .map((x) => {
          const d = { m: x.m, n: x.p.n || x.r?.n, s: x.p.s || x.r?.s, i: x.p.i || x.r?.i };
          const ch = ENGINE?.chains?.[x.p.chain || 'solana'];
          return `<div class="pos-card" data-pos="${esc(x.m)}" data-chain="${esc(x.p.chain || 'solana')}">
            <div class="pos-top">${avatar(d)}<div class="pos-name"><b>${esc(d.n || fmt.short(x.m))}</b><small>$${esc(d.s || '?')}${ch ? ` · ${esc(ch.name)}` : ''} · ${fmt.ago(x.p.t)}${x.p.w === false ? ' · <i>poza statystykami</i>' : ''}${x.stale ? ` · <i>cena sprzed ${x.p.last?.at ? fmt.ago(x.p.last.at) : '—'}</i>` : ''}</small></div>
              <b class="pos-pct ${x.pct >= 0 ? 'up' : 'down'}">${x.pct != null ? `${fmt.pct(x.pct)}<small>${fmtX(x.ratio)}</small>` : '—'}</b></div>
            <div class="pos-grid">
              <div><span>MC wejścia</span><b>${fmt.usd(x.mcIn)}</b></div>
              <div><span>MC teraz</span><b>${fmt.usd(x.mcNow)}</b></div>
              <div><span>Wkład → wartość</span><b>${x.p.usd > 0 ? `${fmt.usd(x.p.usd)} → ${fmt.usd(x.value)}` : '—'}</b></div>
              <div><span>Zysk / strata</span><b class="${(x.pnl ?? 0) >= 0 ? 'up' : 'down'}">${x.pnl != null ? money(x.pnl) : '—'}</b></div>
              ${x.p.fees > 0 ? `<div><span>Zapłacone opłaty</span><b>${feeUsd(x.p.fees)}</b></div>` : ''}
            </div>
            ${x.p.usd > 0 ? sellRow('data-pos-sell') : '<div class="qs-row"><button data-pos-sell="100">✖ Zamknij</button></div>'}
            ${exitRows(x.p, 'data-pos-exit')}
            <div class="pos-acts"><button data-pos-open>Otwórz token</button>${x.pct != null ? '<button data-pos-share>📸 Karta PnL</button>' : ''}</div>
          </div>`;
        })
        .join('')
    : '<div class="empty"><b>Brak otwartych pozycji DEMO</b>Otwórz token z listy i w karcie „Pozycja DEMO” wpisz kwotę oraz MC wejścia.</div>';
  const recent = state.closed.filter((c) => Date.now() - c.closedAt < 30 * 86400e3).slice(0, 20);
  const history = recent.length
    ? `<h3 class="pos-h">Zamknięte (30 dni)</h3><div class="pos-closed">${recent
        .map((c) => `<div><span>${esc(c.n || fmt.short(c.m))} <small>${c.sl ? '🛑 SL · ' : c.tp ? '🎯 TP · ' : c.be ? '🛡️ BE · ' : c.safe ? '🔒 SAFE · ' : ''}$${esc(c.s || '?')}${c.f && c.f < 1 ? ` · ${Math.round(c.f * 100)}%` : ''} · ${fmt.ago(c.closedAt)}</small></span><b class="${c.pct >= 0 ? 'up' : 'down'}">${fmt.pct(c.pct)}${c.usd > 0 ? ` · ${money(c.pnl)}` : ''}</b><button class="share-mini" data-share-closed="${esc(c.m)}|${c.closedAt}" aria-label="Karta PnL">📸</button></div>`)
        .join('')}</div>`
    : '';
  const html = summary + `<h3 class="pos-h">Otwarte (${list.length})</h3>` + cards + history + pnlCalendar();
  if (body.dataset.html !== html) {
    body.dataset.html = html;
    body.innerHTML = html;
  }
}

// ---------- demo wallet screen ----------
function renderWallet() {
  // Spot (memecoin positions), Trenches or Perpetuals: three separate demo wallets.
  const mode = state.walletMode;
  const perpMode = mode === 'perps';
  $('#walletBody').hidden = mode !== 'spot';
  $('#walletPerpBody').hidden = !perpMode;
  $('#walletTrenchBody').hidden = mode !== 'trench';
  $$('#walletSeg button').forEach((b) => b.classList.toggle('on', b.dataset.wmode === mode));
  if (perpMode) return perps ? perps.renderWallet($('#walletPerpBody')) : ($('#walletPerpBody').innerHTML = '<p class="note">Perpetuals ładują się…</p>');
  if (mode === 'trench') return trenches ? trenches.renderWallet($('#walletTrenchBody')) : ($('#walletTrenchBody').innerHTML = '<p class="note">Trenches ładują się…</p>');
  const w = state.wallet;
  const list = positionList();
  const inPos = list.reduce((a, x) => a + (x.p.w ? x.value ?? x.p.usd ?? 0 : 0), 0);
  const equity = w.cash + inPos;
  const pnl = equity - w.deposits;
  const sign = (v) => (v >= 0 ? '+' : '−');
  const TX = { deposit: ['⬇️', 'Doładowanie'], open: ['💼', 'Otwarcie pozycji'], close: ['✅', 'Zamknięcie pozycji'], reset: ['♻️', 'Reset walletu'] };
  const tx = w.tx.slice(0, 30);
  const card = `<div class="wallet-card">
      <span>Saldo dostępne</span><b>${fmt.usd(w.cash)}</b>
      <div class="wallet-sub"><div><span>W pozycjach</span><b>${fmt.usd(inPos)}</b></div><div><span>Razem</span><b>${fmt.usd(equity)}</b></div>
        <div><span>Wynik</span><b class="${pnl >= 0 ? 'up' : 'down'}">${w.deposits > 0 ? `${sign(pnl)}${fmt.usd(Math.abs(pnl))} <small>${fmt.pct((pnl / w.deposits) * 100)}</small>` : '—'}</b></div></div>
    </div>`;
  // The top-up form is rendered once per opening, so live refreshes never touch the input
  // (rebuilding it would close the iPhone keyboard mid-typing).
  const form = `<div class="card wallet-top"><h3>Doładuj wallet DEMO</h3>
      <div class="pos-form">
        <input id="topUp" type="number" inputmode="decimal" min="0" step="any" placeholder="Kwota w $" />
        <button data-wallet="topup">⬇️ Doładuj</button>
      </div>
      <div class="quick-amt">${[100, 500, 1000, 5000].map((v) => `<button data-wallet-amt="${v}">+$${fmt.n(v)}</button>`).join('')}</div>
      <p class="note">To wirtualne pieniądze do treningu — możesz doładować dowolną kwotę.</p>
    </div>`;
  const hist = `<p class="note">Wpłacono łącznie ${fmt.usd(w.deposits)}.</p><h3 class="pos-h">Historia</h3>
    <div class="pos-closed">${
      tx.length
        ? tx.map((t) => `<div><span>${TX[t.type]?.[0] || '•'} ${TX[t.type]?.[1] || t.type}${t.s ? ` <small>$${esc(t.s)}</small>` : ''} <small>· ${fmt.ago(t.t)}</small></span><b class="${t.type === 'open' ? 'down' : t.type === 'reset' ? '' : 'up'}">${t.type === 'open' ? '−' : t.type === 'reset' ? '' : '+'}${fmt.usd(t.amount)}${t.pnl != null ? ` <small class="${t.pnl >= 0 ? 'up' : 'down'}">(${sign(t.pnl)}${fmt.usd(Math.abs(t.pnl))})</small>` : ''}${t.fee > 0 ? `<small class="muted tx-fee">opłaty ${feeUsd(t.fee)}</small>` : ''}</b></div>`).join('')
        : '<div><span class="muted">Brak operacji — doładuj wallet, żeby zacząć grać pozycjami DEMO.</span></div>'
    }</div>`;
  const paid = w.tx.reduce((a, t) => a + (t.fee > 0 ? t.fee : 0), 0);
  const ex = 100;
  const feesCard = `<div class="card wallet-fees"><h3>Opłaty transakcji <small>jak na prawdziwym rynku</small></h3>
      <label class="toggle-row"><input type="checkbox" data-wallet="fees" ${state.fees ? 'checked' : ''} /> <span>Realistyczne opłaty przy kupnie i sprzedaży</span></label>
      <p class="note">Każda transakcja: <b>${FEES.platform * 100}%</b> opłaty platformy (jak Axiom / Photon / BullX) + <b>${(FEES.pool * 100).toFixed(1)}%</b> opłaty puli DEX + opłata sieci: na Solanie ~${FEES.solTx} SOL (priority fee + tip, teraz ≈ ${feeUsd(networkFee('solana'))}), na sieciach EVM gas (ETH ≈ ${feeUsd(FEES.gasUsd.ethereum)}, Base ≈ ${feeUsd(FEES.gasUsd.base)}, BNB ≈ ${feeUsd(FEES.gasUsd.bsc)}, Robinhood ≈ ${feeUsd(FEES.gasUsd.robinhood)}).
      Przykład na Solanie: kupno za ${fmt.usd(ex)} kosztuje ≈ ${feeUsd(ex * (FEES.platform + FEES.pool) + networkFee('solana'))} opłat, a sprzedaż drugie tyle — pozycja musi urosnąć ok. +${(((1 + (FEES.platform + FEES.pool) + networkFee('solana') / ex) / (1 - (FEES.platform + FEES.pool) - networkFee('solana') / ex) - 1) * 100).toFixed(1)}%, żeby wyjść na zero.</p>
      <p class="note">Zapłacone opłaty (od ostatniego resetu): <b>${feeUsd(paid)}</b></p>
    </div>`;
  const body = $('#walletBody');
  if (!body.querySelector('#wCard')) {
    body.innerHTML = `<div id="wCard"></div>${form}<div id="wFees"></div><div id="wTrack"></div><div id="wDisc"></div><div id="wHist"></div>
      <div class="d-acts" style="margin-top:16px"><button data-wallet="reset">♻️ Wyzeruj wallet DEMO</button></div>`;
  }
  const put = (id, html) => {
    const el = body.querySelector(id);
    if (el.dataset.html !== html) {
      el.dataset.html = html;
      el.innerHTML = html;
    }
  };
  put('#wCard', card);
  put('#wFees', feesCard);
  put('#wTrack', walletTrackerCard());
  put('#wDisc', discoveryCard());
  put('#wHist', hist);
}

const SHEETS = { pos: ['#posSheet', renderPositions], wallet: ['#walletSheet', renderWallet], perps: ['#perpSheet', () => perps?.render()], trench: ['#trenchSheet', () => trenches?.render()] };
// While a finger is on a sheet, live re-renders wait: replacing a button mid-tap loses the tap
// on iOS Safari.
let sheetTouch = 0;
for (const sel of ['#posSheet', '#walletSheet', '#perpSheet', '#trenchSheet']) {
  $(sel).addEventListener('touchstart', () => (sheetTouch = Date.now() + 60_000), { passive: true });
  for (const ev of ['touchend', 'touchcancel']) $(sel).addEventListener(ev, () => (sheetTouch = Date.now() + 400), { passive: true });
}
const sheetBusy = () => Date.now() < sheetTouch;
// A touch whose target was replaced mid-gesture never bubbles its touchend to the sheet: end the
// guards from the document too, so live refreshes don't stay paused for a minute.
for (const ev of ['touchend', 'touchcancel'])
  document.addEventListener(ev, () => {
    const soon = Date.now() + 400;
    if (sheetTouch > soon) sheetTouch = soon;
    if (drawerTouch > soon) drawerTouch = soon;
  }, { passive: true, capture: true });
function openSheet(name) {
  for (const [k, [sel]] of Object.entries(SHEETS)) $(sel).hidden = k !== name;
  document.body.classList.add('sheet-open');
  $$('#bottombar button').forEach((b) => b.classList.toggle('on', b.dataset.nav === name));
  SHEETS[name][1]();
  $(SHEETS[name][0]).scrollTop = 0;
}
// Perpetuals DEMO (live Hyperliquid data; own wallet).
const WALLET_MODES = ['spot', 'trench', 'perps'];
state.walletMode = WALLET_MODES.includes(LS.get('walletMode', 'spot')) ? LS.get('walletMode', 'spot') : 'spot';
// Loaded as its own module: if it can't load (e.g. the single-file preview), only perps are off.
let perps = null;
import('./perps.js?v=mv2bfqxf')
  .then(({ createPerps }) => {
    perps = createPerps({
      toast: (m) => toast(m),
      loadLW: () => loadLW(),
      onChange: () => ($('#c-perp').textContent = perps?.count() || ''),
      nav: (where) => (where === 'wallet' ? openWallet('perps') : openSheet(where)),
    });
    $('#c-perp').textContent = perps.count() || '';
    if (sheetOpen('perps')) perps.render();
    if (sheetOpen('wallet')) renderWallet();
  })
  .catch(() => {
    $('#perpBody').innerHTML = '<div class="empty"><b>Perpetuals niedostępne</b>Nie udało się wczytać modułu.</div>';
  });
// Trenches DEMO (launchpad columns, one-tap memecoin trading; own wallet per network).
let trenches = null;
if (ENGINE?.trenches)
  import('./trenches.js?v=mv2bfqxf')
    .then(({ createTrenches }) => {
      trenches = createTrenches({
        engine: ENGINE,
        chains: CHAIN_LIST || [],
        chain: () => ENGINE.chain,
        setChain: (id) => setChain(id),
        nativeUsd: (c) => state.nativeUsd[c] || 0,
        toast: (m) => toast(m),
        loadLW: () => loadLW(),
        nav: (where) => (where === 'wallet' ? openWallet('trench') : openSheet(where)),
      });
      renderTrenchCount();
      if (sheetOpen('trench')) trenches.render();
      if (sheetOpen('wallet')) renderWallet();
    })
    .catch(() => {
      $('#trenchBody').innerHTML = '<div class="empty"><b>Trenches niedostępne</b>Nie udało się wczytać modułu.</div>';
    });
else $('#trenchBody').innerHTML = '<div class="empty"><b>Trenches działają w wersji przeglądarkowej</b>Otwórz stronę DMN.</div>';
function renderTrenchCount() {
  const el = $('#c-trench');
  if (el) el.textContent = trenches?.count() || '';
}
setInterval(renderTrenchCount, 3_000);
/** Opens the wallet on one of its sides: Spot (memecoins), Trenches or Perpetuals. */
function openWallet(mode) {
  state.walletMode = WALLET_MODES.includes(mode) ? mode : 'spot';
  LS.set('walletMode', state.walletMode);
  openSheet('wallet');
}
$('#walletSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-wmode]');
  if (!b) return;
  state.walletMode = WALLET_MODES.includes(b.dataset.wmode) ? b.dataset.wmode : 'spot';
  LS.set('walletMode', state.walletMode);
  renderWallet();
});
function closeSheets() {
  for (const [sel] of Object.values(SHEETS)) $(sel).hidden = true;
  document.body.classList.remove('sheet-open');
  $$('#bottombar button').forEach((b) => b.classList.toggle('on', b.dataset.nav === 'radar'));
}
const sheetOpen = (name) => !$(SHEETS[name][0]).hidden;

// ---------- holder structure icons (Axiom-style) ----------
const HICON = {
  top10: '<path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 11a2.5 2.5 0 1 0 0-5M2.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8M15.5 14.4c2.3.2 4.1 1.9 4.6 4.6"/>',
  dev: '<path d="M7 13.5V19h10v-5.5M7 13.5a4 4 0 1 1 1.9-7.4 4 4 0 0 1 6.2 0A4 4 0 1 1 17 13.5M7 16h10"/>',
  insiders: '<path d="M6 20V11a6 6 0 0 1 12 0v9l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5zM9.5 11h.01M14.5 11h.01"/>',
  lp: '<path d="M12 3c3 3.6 5 6.2 5 9.4A5 5 0 0 1 7 12.4c0-1.8.9-3.4 2.2-4.4 0 1.7.8 2.7 1.7 3.1 0-3 .4-5.4 1.1-8.1z"/>',
  paid: '<path d="M12 3l2.4 1.6 2.9-.2 1 2.7 2.3 1.8-.9 2.8.9 2.8-2.3 1.8-1 2.7-2.9-.2L12 21l-2.4-1.6-2.9.2-1-2.7-2.3-1.8.9-2.8-.9-2.8 2.3-1.8 1-2.7 2.9.2z"/><path d="M8.8 12.2l2.2 2.2 4.3-4.6"/>',
  holders: '<path d="M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM5 20c.8-3.6 3.6-5.8 7-5.8s6.2 2.2 7 5.8"/>',
};
const hico = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${HICON[k]}</svg>`;
// Colour by threshold: high share is bad (dev, top 10, insiders); for LP burned high is good.
const tone = (v, warn, bad, goodHigh = false) =>
  v == null ? 'na' : goodHigh ? (v >= bad ? 'up' : v >= warn ? 'warn' : 'down') : v >= bad ? 'down' : v >= warn ? 'warn' : 'up';
const shortPct = (v) => (v == null ? '—' : v > 0 && v < 1 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`);

/** Small icon + value cells: top 10, dev, insiders, LP burned, DEX paid, holders. */
function holderIcons(d, compact = false) {
  const evm = chainCfg().evm;
  const cells = [
    ['top10', tone(d.t10, 30, 50), shortPct(d.t10), `Top 10 holderów: ${shortPct(d.t10)}`],
    ['dev', tone(d.dv, 5, 15), shortPct(d.dv), `Dev trzyma: ${shortPct(d.dv)}`],
    evm ? null : ['insiders', tone(d.ins, 5, 15), shortPct(d.ins), `Insiderzy: ${shortPct(d.ins)}`],
    ['lp', tone(d.lpb, 50, 90, true), shortPct(d.lpb), `LP spalone: ${shortPct(d.lpb)}`],
    ['paid', d.dp == null ? 'na' : d.dp ? 'up' : 'down', d.dp == null ? '—' : d.dp ? (compact ? '✓' : 'Paid') : compact ? '✗' : 'Unpaid', `DEX paid: ${d.dp == null ? 'nie sprawdzono' : d.dp ? 'tak' : 'nie'}`],
    ['holders', 'plain', fmt.n(d.h), `Holderzy: ${fmt.n(d.h)}`],
  ].filter(Boolean);
  return `<div class="q-sec">${cells.map(([k, t, v, tip]) => `<span class="hs ${t}" title="${tip}">${hico(k)}${v}</span>`).join('')}</div>`;
}

// ---------- network / launchpad badges ----------
/** Launchpad chip next to the bonding-curve bar: pump / bonk, or the launchpad's name. */
function lpChip(lp) {
  const raw = String(lp || 'pump').toLowerCase();
  if (raw === 'pump' || raw === 'bonk') return `<span class="chip ${raw}">${raw}</span>`;
  const hit = LAUNCHPADS.find(([re]) => re.test(raw));
  return `<span class="chip">${esc(hit ? hit[1] : raw)}</span>`;
}
// Small marks before a token's name: the network on EVM chains, the launchpad on Solana.
// Simplified badges in each platform's colours (not the official artwork).
const LAUNCHPADS = [
  [/pump/, 'pump.fun', '<rect x="3" y="8" width="18" height="8" rx="4" fill="#fff"/><path d="M12 8h5a4 4 0 0 1 0 8h-5z" fill="#5FCB86"/>', '#1b2a22'],
  [/bonk/, 'bonk.fun', '<circle cx="12" cy="12" r="9" fill="#F7931A"/><path d="M8.5 9.5h4.2a2 2 0 0 1 0 4H8.5zM8.5 13.5h4.8a2 2 0 0 1 0 4H8.5z" fill="none" stroke="#fff" stroke-width="1.6"/>'],
  [/launchlab|raydium/, 'Raydium LaunchLab', '<circle cx="12" cy="12" r="9" fill="#6A3CE0"/><path d="M12 5.5 17.6 8.7v6.6L12 18.5 6.4 15.3V8.7z" fill="none" stroke="#5CE1E6" stroke-width="1.6"/>'],
  [/metadao/, 'MetaDAO', '<circle cx="12" cy="12" r="9" fill="#111"/><path d="M7 16V8l5 5 5-5v8" fill="none" stroke="#fff" stroke-width="1.8"/>'],
  [/met|dbc|meteora/, 'Meteora', '<circle cx="12" cy="12" r="9" fill="#1d1430"/><path d="M6 16 10 7l3 6 2-3 3 6" fill="none" stroke="#FF6B2C" stroke-width="2" stroke-linejoin="round"/>'],
  [/bags/, 'Bags', '<circle cx="12" cy="12" r="9" fill="#02C076"/><path d="M8 10h8l-1 7H9zM10 10a2 2 0 0 1 4 0" fill="none" stroke="#fff" stroke-width="1.6"/>'],
  [/believe/, 'Believe', '<circle cx="12" cy="12" r="9" fill="#fff"/><path d="M9 7v10h4a2.5 2.5 0 0 0 0-5H9m0 0h3.5a2.5 2.5 0 0 0 0-5H9" fill="none" stroke="#111" stroke-width="1.8"/>'],
  [/moon/, 'Moonshot', '<circle cx="12" cy="12" r="9" fill="#2a2140"/><path d="M14.5 6.5a6 6 0 1 0 3 8.5 5 5 0 0 1-3-8.5z" fill="#FFD84D"/>'],
  [/jup|studio/, 'Jupiter Studio', '<circle cx="12" cy="12" r="9" fill="#0e1a20"/><path d="M6 10c4-3 9-3 12 0M5.5 13.5c4.5-2.5 9.5-2.5 13 0M7 17c3-1.8 7-1.8 10 0" fill="none" stroke="#C7F284" stroke-width="1.6" stroke-linecap="round"/>'],
  [/heaven/, 'Heaven', '<circle cx="12" cy="12" r="9" fill="#f4f1e8"/><ellipse cx="12" cy="8" rx="5" ry="1.8" fill="none" stroke="#E0B341" stroke-width="1.5"/><path d="M12 11v7" stroke="#E0B341" stroke-width="1.8"/>'],
  [/boop/, 'boop.fun', '<circle cx="12" cy="12" r="9" fill="#FF5FA2"/><circle cx="12" cy="13" r="3.2" fill="#fff"/>'],
  [/stonk/, 'Stonk.fun', '<circle cx="12" cy="12" r="9" fill="#0f2a1a"/><path d="M6 16l4-4 3 2 5-6" fill="none" stroke="#3CF07A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'],
  [/ember/, 'Ember', '<circle cx="12" cy="12" r="9" fill="#2a1208"/><path d="M12 5.5c3 3.5 4.5 5.5 4.5 8a4.5 4.5 0 0 1-9 0c0-1.6.8-3 2-4 0 1.5.7 2.4 1.5 2.8 0-2.6.4-4.6 1-6.8z" fill="#FF6A2B"/>'],
];

function srcBadge(d) {
  const ch = chainCfg();
  if (ch.evm) {
    return `<svg class="tok-src" viewBox="0 0 24 24" style="color:${ch.color}" aria-label="${ch.name}"><title>${ch.name}</title>${CHAIN_ICONS[ch.id] || ''}</svg>`;
  }
  const lp = String(d.lp || (d.m.endsWith('pump') ? 'pump' : d.m.endsWith('bonk') ? 'bonk' : '')).toLowerCase();
  const hit = lp && LAUNCHPADS.find(([re]) => re.test(lp));
  if (hit) return `<svg class="tok-src" viewBox="0 0 24 24" aria-label="${hit[1]}"><title>${hit[1]}</title>${hit[3] ? `<circle cx="12" cy="12" r="10" fill="${hit[3]}"/>` : ''}${hit[2]}</svg>`;
  return `<svg class="tok-src sol" viewBox="0 0 24 24" aria-label="Solana"><title>Solana</title>${CHAIN_ICONS.solana}</svg>`;
}

// ---------- network switcher ----------
const CHAIN_ICONS = {
  solana: '<path d="M6.2 15.6a.7.7 0 0 1 .5-.2h13.9c.3 0 .5.4.3.6l-2.8 2.8a.7.7 0 0 1-.5.2H3.7c-.3 0-.5-.4-.3-.6zM6.2 4.8a.7.7 0 0 1 .5-.2h13.9c.3 0 .5.4.3.6l-2.8 2.8a.7.7 0 0 1-.5.2H3.7c-.3 0-.5-.4-.3-.6zM17.8 10.2a.7.7 0 0 0-.5-.2H3.4c-.3 0-.5.4-.3.6l2.8 2.8c.1.1.3.2.5.2h13.9c.3 0 .5-.4.3-.6z"/>',
  bsc: '<path d="M12 9.6 14.4 12 12 14.4 9.6 12zM5.6 9.6 8 12l-2.4 2.4L3.2 12zM18.4 9.6 20.8 12l-2.4 2.4L16 12zM12 3.2l5.2 5.2-1.4 1.4L12 6 8.2 9.8 6.8 8.4zM12 20.8l-5.2-5.2 1.4-1.4L12 18l3.8-3.8 1.4 1.4z"/>',
  base: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/>',
  ethereum: '<path d="M12 2 5.5 12.3 12 16l6.5-3.7z" opacity=".9"/><path d="M12 17.3 5.5 13.6 12 22l6.5-8.4z"/>',
  robinhood: '<path d="M18.9 2.6c-4.6.6-8.6 3.6-10.6 8l-3.3 7.2c-.2.4.2.8.6.6l2.3-1.2-1.6 4.5c-.1.4.4.6.6.3l2.9-4.6c.9.1 1.8-.1 2.5-.6l.3-1.7.9 1.2c2.5-1.8 4.6-6.3 5.3-12.9.1-.5-.4-.9-.9-.8z"/>',
};

function renderChains() {
  const el = $('#chains');
  if (!CHAIN_LIST) {
    el.hidden = true;
    return;
  }
  el.innerHTML = CHAIN_LIST.map(
    (c) =>
      `<button class="chain-btn" data-chain="${c.id}" style="--cc:${c.color}" title="${c.name}" aria-label="${c.name}"><svg viewBox="0 0 24 24" aria-hidden="true">${CHAIN_ICONS[c.id] || ''}</svg></button>`,
  ).join('');
  markChain();
}

function markChain() {
  // EVM networks: "fresh graduations" lists tokens new on a DEX (see Store.list).
  const grad = $('#tabs [data-view="graduated"]');
  if (grad && chainCfg().evm) grad.lastChild.textContent = 'Nowe na DEX';
  else if (grad) grad.lastChild.textContent = state.onlyGraduated ? 'Świeże graduacje' : 'Po graduacji';
  $$('#chains .chain-btn').forEach((b) => {
    const on = b.dataset.chain === ENGINE?.chain;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  });
}

function setChain(id) {
  if (!ENGINE || id === ENGINE.chain) return;
  ENGINE.setChain(id);
  LS.set('chain', ENGINE.chain);
  markChain();
  if (state.selected) closeDetail();
  state.hypeRows = null;
  state.feed = ENGINE.feed();
  renderFeed();
  $('#search').value = '';
  $('#searchResults').hidden = true;
  $('#sources').dataset.html = '';
  renderWatchCount();
  renderPosCount();
  setView(state.view === 'watch' ? 'hype' : state.view);
  trenches?.chainChanged();
  renderTrenchCount();
  if (sheetOpen('wallet')) renderWallet();
}

/** Watched tokens of the network on screen: by the network they were starred on (older entries
 *  without one: by address format). */
/** Watched on the network on screen (an EVM address can be another token elsewhere). */
function isWatched(m) {
  if (!state.watch.has(m)) return false;
  const c = state.watchChain[m];
  if (c) return c === (ENGINE?.chain || 'solana');
  return chainCfg().evm ? /^0x[0-9a-fA-F]{40}$/.test(m) : !m.startsWith('0x');
}

function watchedHere() {
  const evm = chainCfg().evm;
  const chain = ENGINE?.chain || 'solana';
  return [...state.watch].filter((m) => {
    const c = state.watchChain[m];
    if (c) return c === chain;
    return evm ? /^0x[0-9a-fA-F]{40}$/.test(m) : !m.startsWith('0x');
  });
}

/** Watchlist count for the network on screen (addresses are per network). */
function renderWatchCount() {
  const n = watchedHere().length;
  $('#c-watch').textContent = n || '';
}

function setView(view) {
  state.view = view;
  LS.set('view', view);
  $$('#tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
    b.setAttribute('aria-selected', String(b.dataset.view === view));
  });
  for (const e of state.rows.values()) e.el.remove();
  state.rows.clear();
  state.prevRanks.clear();
  state.firstSnapshot = true;
  $('#empty').hidden = true;
  skeleton();
  connect();
}

// ---------- feed ----------
const FEED_IC = { launch: '✨', whale: '🐋', wallet: '👛', migrate: '🎓', spike: '🔥', x: '𝕏', surge: '🚀', ai: '🤖' };
function feedItem(it) {
  return `<li class="fi ${it.type}" data-m="${it.mint}"><span class="fi-ic">${FEED_IC[it.type] || '•'}</span>
    <div class="fi-t">${esc(it.text)}<small data-at="${it.at}">${fmt.ago(it.at)} temu</small></div></li>`;
}
function renderFeed() {
  const list = state.feed.filter((x) => state.feedFilter === 'all' || x.type === state.feedFilter).slice(0, 80);
  $('#feed').innerHTML = list.length ? list.map(feedItem).join('') : '<li class="sr-empty">Czekam na zdarzenia…</li>';
}
function addFeed(it) {
  state.feed.unshift(it);
  if (state.feed.length > 200) state.feed.length = 200;
  if (state.feedFilter !== 'all' && it.type !== state.feedFilter) return;
  const ul = $('#feed');
  if (ul.firstElementChild?.classList.contains('sr-empty')) ul.innerHTML = '';
  ul.insertAdjacentHTML('afterbegin', feedItem(it));
  while (ul.children.length > 80) ul.lastElementChild.remove();
}
setInterval(() => {
  const now = nowTs();
  $$('#feed small[data-at]').forEach((s) => (s.textContent = `${fmt.ago(+s.dataset.at, now)} temu`));
}, 5000);

// ---------- watchlist ----------
function toggleWatch(mint) {
  if (isWatched(mint)) {
    state.watch.delete(mint);
    delete state.watchChain[mint];
  } else {
    state.watch.add(mint);
    state.watchChain[mint] = ENGINE?.chain || 'solana';
  }
  LS.set('watch', [...state.watch]);
  LS.set('watchChain', state.watchChain);
  renderWatchCount();
  toast(isWatched(mint) ? '★ Dodano do obserwowanych' : 'Usunięto z obserwowanych');
  const star = state.rows.get(mint)?.el.querySelector('.star');
  if (star) {
    star.classList.toggle('on', isWatched(mint));
    star.textContent = isWatched(mint) ? '★' : '☆';
  }
  if (state.view === 'watch') connect();
  if (state.selected === mint && state.detail) renderDetail(state.detail);
}

// ---------- toast ----------
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 1800);
}

/** Copies text; falls back to a hidden textarea where the async clipboard API is missing or blocked. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text); // must start inside the tap handler (iOS Safari)
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Quick copy from the list: tick on the button + toast; the drawer stays closed. */
async function copyFromList(mint, btn) {
  const sym = state.rows.get(mint)?.data?.s;
  const ok = await copyText(mint);
  toast(ok ? `Skopiowano adres${sym ? ` $${sym}` : ''}` : 'Nie udało się skopiować — otwórz token i skopiuj adres');
  if (!ok || !btn) return;
  const label = '⧉ CA';
  btn.classList.add('ok');
  btn.textContent = '✓ CA';
  setTimeout(() => {
    btn.classList.remove('ok');
    btn.textContent = label;
  }, 1200);
}

async function copy(text) {
  if (await copyText(text)) {
    toast('Skopiowano adres kontraktu');
  } else {
    // Clipboard blocked (e.g. inside the preview frame): select the full address instead.
    const el = $('#caFull');
    if (el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      toast('Adres zaznaczony — skopiuj go ⌘C / Ctrl+C');
    } else toast(text);
  }
}

// ---------- detail drawer ----------
let detailTimer;
let detailMiss = 0; // failed detail fetches in a row
async function openDetail(mint, push = true) {
  state.selected = mint;
  state.detail = null;
  state.chartTab = STATIC ? 'hype' : LS.get('chartTab2', 'candles');
  state.live = null;
  state.tr = null;
  state.candles = null;
  state.copiesFor = null;
  state.openedAt = Date.now();
  state.detailLayout = null;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  document.body.style.overflow = 'hidden';
  const known = state.rows.get(mint)?.data;
  $('#drawerBody').innerHTML = known ? detailSkeleton(known) : '<div class="empty"><b>Ładowanie…</b></div>';
  if (push) history.replaceState(null, '', `#t=${ENGINE ? `${ENGINE.chain}:` : ''}${mint}`);
  clearInterval(detailTimer);
  detailMiss = 0;
  await loadDetail(mint);
  // Closed or switched to another token while loading: don't leave a poller behind.
  if (state.selected !== mint) return;
  clearInterval(detailTimer);
  detailTimer = setInterval(() => loadDetail(mint), 4000);
}

function closeDetail() {
  state.selected = null;
  // Nothing re-renders the closed drawer from its old data (charts, iframes, candle loads).
  state.detail = null;
  state.detailLayout = null;
  clearInterval(detailTimer);
  stopLive();
  destroyLW();
  // Stop the hidden DexScreener chart (it keeps streaming); after the slide-out animation.
  setTimeout(() => {
    if (state.selected) return;
    state.chartFrame?.remove();
    state.chartFrame = null;
  }, 350);
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
  document.body.style.overflow = '';
  history.replaceState(null, '', location.pathname + location.search);
}

let drawerTouch = 0;
$('#drawer').addEventListener('touchstart', () => (drawerTouch = Date.now() + 60_000), { passive: true });
for (const ev of ['touchend', 'touchcancel']) $('#drawer').addEventListener(ev, () => (drawerTouch = Date.now() + 400), { passive: true });

async function loadDetail(mint) {
  if (ENGINE) {
    const d = await ENGINE.detail(mint);
    if (state.selected !== mint) return;
    if (!d) {
      // A couple of failed fetches (network blip, rate limit) aren't "not found": keep trying ~30 s.
      if (++detailMiss >= 8) {
        $('#drawerBody').innerHTML = '<div class="empty"><b>Nie znaleziono tokena</b></div>';
        clearInterval(detailTimer);
      } else if (!state.detail) $('#drawerBody').innerHTML = '<div class="empty"><b>Ładowanie…</b></div>';
      return;
    }
    detailMiss = 0;
    state.detail = d;
    loadTrades(mint);
    if (state.copiesFor !== mint && ENGINE.copies) {
      state.copiesFor = mint;
      ENGINE.copies(mint).catch(() => {});
    }
    // A finger on the drawer: wait, so a live re-render doesn't swallow the tap (iOS).
    if (Date.now() < drawerTouch) return;
    renderDetail(d);
    return;
  }
  if (STATIC) {
    clearInterval(detailTimer);
    const d = STATIC.details[mint];
    if (d) {
      state.detail = d;
      renderDetail(d);
    } else {
      $('#drawerBody').innerHTML = '<div class="empty"><b>Brak szczegółów w tej migawce</b>Pełne dane są dostępne w wersji na żywo.</div>';
    }
    return;
  }
  try {
    const res = await fetch(`/api/token/${mint}`);
    const d = await res.json();
    if (state.selected !== mint) return;
    if (!res.ok) {
      $('#drawerBody').innerHTML = `<div class="empty"><b>${esc(d.error || 'Błąd')}</b></div>`;
      clearInterval(detailTimer);
      return;
    }
    state.detail = d;
    renderDetail(d);
  } catch {
    /* transient — next poll retries */
  }
}

function detailSkeleton(d) {
  return `<div class="d-head">${avatar(d, 'xl')}<div class="d-id"><h2>${esc(d.n)} <small>$${esc(d.s)}</small></h2></div>
    <button class="d-close" data-act="close" aria-label="Zamknij">✕</button></div><div class="empty"><b>Ładowanie szczegółów…</b></div>`;
}

const PART_LABEL = {
  momentum: 'Aktywność transakcji',
  volume: 'Wolumen i obrót',
  surge: 'Wybicie wolumenu',
  pressure: 'Presja kupna',
  price: 'Momentum ceny',
  social: 'Social / 𝕏',
  discovery: 'Listy trendów',
  holders: 'Wzrost holderów',
};
const RANK_LABEL = {
  'gecko:trending5m': 'GeckoTerminal trending 5m',
  'gecko:trending1h': 'GeckoTerminal trending 1h',
  'jup:trending5m': 'Jupiter trending 5m',
  'jup:trending1h': 'Jupiter trending 1h',
  'jup:organic1h': 'Jupiter organic 1h',
  'jup:traded1h': 'Jupiter top traded 1h',
  'dex:profiles': 'DexScreener nowe profile',
  'dex:boosts': 'DexScreener boosty',
  'dex:topBoosts': 'DexScreener top boosty',
};

function renderDetail(d) {
  const body = $('#drawerBody');
  const scroll = $('#drawer').scrollTop;
  const h = heat(d.hs);
  const m = d.market || {};
  const watched = isWatched(d.m);
  const ch = chainCfg();
  const dexLink = ['DexScreener', d.dexUrl || `https://dexscreener.com/${ch.dex}/${d.pair || d.m}`, true];
  const chainLinks = ch.evm
    ? [
        ch.buy ? [ch.buyName, ch.buy(d.m)] : null,
        ch.gmgn ? ['GMGN', `https://gmgn.ai/${ch.gmgn}/token/${d.m}`] : null,
        ch.explorerName ? [ch.explorerName, ch.explorer(d.m)] : null,
        ['GoPlus', `https://gopluslabs.io/token-security/${ch.goplus}/${d.m}`],
      ]
    : [
        ['Jupiter (kup)', `https://jup.ag/swap/SOL-${d.m}`],
        d.lp === 'pump' || d.m.endsWith('pump') ? ['pump.fun', `https://pump.fun/coin/${d.m}`] : null,
        ['Birdeye', `https://birdeye.so/token/${d.m}?chain=solana`],
        ['GMGN', `https://gmgn.ai/sol/token/${d.m}`],
        ['Solscan', `https://solscan.io/token/${d.m}`],
        ['RugCheck', `https://rugcheck.xyz/tokens/${d.m}`],
      ];
  const links = [
    dexLink,
    ...chainLinks,
    ['Szukaj na 𝕏', `https://x.com/search?q=${encodeURIComponent(d.m)}&f=live`],
    linkUrl(d.socials?.twitter) ? ['𝕏 projektu', d.socials.twitter] : null,
    linkUrl(d.socials?.telegram) ? ['Telegram', d.socials.telegram] : null,
    linkUrl(d.socials?.website) ? ['Strona', d.socials.website] : null,
  ].filter(Boolean);

  const parts = Object.entries(d.hp || {})
    .map(([k, v]) => `<div class="part"><span>${PART_LABEL[k] || k}</span><div class="pb"><i style="width:${v}%"></i></div><b>${v}</b></div>`)
    .join('');
  const pen = Math.round((d.risk?.penalty || 0) * 100);

  const kv = [
    ['Cena', fmt.price(d.p)],
    ['Market cap', fmt.usd(d.mc)],
    ['FDV', fmt.usd(d.fdv)],
    ['Płynność', fmt.usd(d.lq)],
    ['Wolumen 5m', fmt.usd(d.v5)],
    ['Wolumen 1h', fmt.usd(d.v1)],
    ['Wolumen 24h', fmt.usd(d.v24)],
    ['Traderzy 1h', fmt.n(d.tr)],
    ['Kupno/sprz. 5m', `<span class="up">${fmt.n(d.b5)}</span> / <span class="down">${fmt.n(d.s5)}</span>`],
    ['Kupno/sprz. 1h', `<span class="up">${fmt.n(d.b1)}</span> / <span class="down">${fmt.n(d.s1)}</span>`],
    ['Wol. kupna 5m', `<span class="up">${fmt.usd(d.bv5)}</span>`],
    ['Wol. sprzed. 5m', `<span class="down">${fmt.usd(d.sv5)}</span>`],
    ['Wol. kupna 1h', `<span class="up">${fmt.usd(d.bv1)}</span>`],
    ['Wol. sprzed. 1h', `<span class="down">${fmt.usd(d.sv1)}</span>`],
    ['Holderzy', `${fmt.n(d.h)} ${d.hg ? `<small class="${d.hg > 0 ? 'up' : 'down'}">${d.hg > 0 ? '+' : ''}${fmt.n(d.hg)}/h</small>` : ''}`],
    ['Wiek', d.ca ? fmt.ago(d.ca) : '—'],
    (() => {
      const s = sinceSeen(d);
      return ['Od kiedy go widzisz', s ? `<span class="${s.cls}">${fmt.pct(s.pct)} · ${fmtX(s.r)}</span> <small class="muted">${fmt.ago(s.t)}</small>` : '—'];
    })(),
    ['Zmiana 5m', `<span class="${cls(d.c5)}">${fmt.pct(d.c5)}</span>`],
    ['Zmiana 1h', `<span class="${cls(d.c1)}">${fmt.pct(d.c1)}</span>`],
    ['Zmiana 4h', `<span class="${cls(d.c4)}">${fmt.pct(d.c4)}</span>`],
    ['Zmiana 6h', `<span class="${cls(d.c6)}">${fmt.pct(d.c6)}</span>`],
    ['Zmiana 24h', `<span class="${cls(d.c24)}">${fmt.pct(d.c24)}</span>`],
    d.bp != null ? ['Bonding curve', `${d.bp.toFixed(1)}%`] : ['Status', d.gr ? '🎓 Na DEX' : d.dexId || '—'],
    ['Organic score', d.organicScore != null ? `${Math.round(d.organicScore)} ${d.organicLabel ? `<small class="muted">${esc(d.organicLabel)}</small>` : ''}` : '—'],
    ['Wybicie wolumenu 5m', d.vs ? `<span class="${d.vs >= 2 ? 'up' : ''}">${d.vs.toFixed(1)}×</span> <small class="muted">średniej</small>` : '—'],
    ['Pozycja w rankingu', d.rank ? `#${d.rank}` : '—'],
    ['Hype teraz', d.fz && FRESH[d.fz] ? `<span class="${FRESH[d.fz][2]}">${FRESH[d.fz][0]} ${FRESH[d.fz][1]}</span>` : '—'],
    ['DEX', esc(d.dexId || (d.bp != null ? 'bonding curve' : '—'))],
  ];

  const flags = d.risk?.flags?.length
    ? d.risk.flags.map((f) => `<div class="flag ${f.level}"><span>${f.level === 'danger' ? '⛔' : '⚠️'}</span><div><b>${esc(f.name)} ${f.value ? `<small>${esc(f.value)}</small>` : ''}</b>${f.desc ? `<small>${esc(f.desc)}</small>` : ''}</div></div>`).join('')
    : `<div class="flag ${d.risk?.level === 'ok' ? 'ok' : ''}"><span>${d.risk?.level === 'ok' ? '✅' : '❔'}</span><div><b>${RISK_TXT[d.risk?.level] || 'Nie sprawdzono'}</b><small>${d.risk?.level === 'ok' ? (chainCfg().evm ? 'GoPlus nie zgłasza problemów.' : 'RugCheck / audyt Jupitera nie zgłaszają problemów.') : 'Raport bezpieczeństwa pojawi się, gdy token wejdzie do czołówki.'}</small></div></div>`;

  const x = d.x;
  const tweets = x?.tweets?.length
    ? x.tweets
        .map(
          (t) => `<a class="tweet" href="https://x.com/${encodeURIComponent(t.user || 'i')}/status/${encodeURIComponent(t.id)}" target="_blank" rel="noopener">
          <div class="tweet-h"><b>${esc(t.name || t.user)}</b><small>@${esc(t.user)} · ${fmt.ago(t.at)}</small><span class="fol">${fmt.n(t.followers)} obs.</span></div>
          <p>${esc(t.text)}</p><div class="tweet-m"><span>♥ ${fmt.n(t.likes)}</span><span>⟲ ${fmt.n(t.rts)}</span><span>💬 ${fmt.n(t.replies)}</span></div></a>`,
        )
        .join('')
    : `<p class="note">${x ? 'Brak postów w ostatniej godzinie.' : (ENGINE ? 'Posty z X są dostępne w wersji serwerowej (wymaga klucza X API).' : 'Dane z X pojawią się, gdy token wejdzie do top 60 (wymaga X_BEARER_TOKEN).')}</p>`;

  const trades = d.trades?.length
    ? `<table class="trades">${d.trades
        .slice(0, 25)
        .map((t) => `<tr><td class="side ${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? 'Kupno' : 'Sprzedaż'}</td><td class="mono">${fmt.sol(t.sol)}</td><td class="mono muted">${fmt.short(t.trader)}</td><td class="mono muted">${fmt.ago(t.t)}</td></tr>`)
        .join('')}</table>`
    : chainCfg().evm
      ? '<p class="note">Lista pojedynczych transakcji jest niedostępna w tej wersji. Liczby kupna/sprzedaży powyżej pochodzą z DexScreenera i odświeżają się co kilka sekund.</p>'
      : '<p class="note">Lista pojedynczych transakcji wymaga klucza PumpPortal (PUMPPORTAL_API_KEY). Liczby kupna/sprzedaży powyżej pochodzą z DexScreenera i odświeżają się co 15–60 s.</p>';

  const ranks = Object.entries(d.rankings || {});
  const hasPair = !!d.pair && !STATIC; // the preview frame cannot embed other sites
  const chartTab = hasPair ? state.chartTab : 'hype';

  // Sections are rebuilt only when their HTML actually changes, and the chart card is never
  // rebuilt on refresh — re-inserting the DexScreener iframe would reload the chart.
  // Holder structure, like Axiom's token panel. Green = healthy, red = a warning sign.
  const pctCell = (v, warn, bad, invert = false) => {
    if (v == null || !Number.isFinite(v)) return '<b class="muted">—</b>';
    const c = invert ? (v >= bad ? 'up' : v >= warn ? 'warn' : 'down') : v >= bad ? 'down' : v >= warn ? 'warn' : 'up';
    return `<b class="${c}">${v < 0.1 && v > 0 ? '<0.1' : v.toFixed(v >= 10 ? 0 : 1)}%</b>`;
  };
  const hstats = [
    ['Dev', pctCell(d.devPct, 5, 15), 'Udział tokenów w portfelu twórcy'],
    ['Top 10', pctCell(d.top10Pct, 30, 50), '10 największych portfeli (bez puli)'],
    ['Insiderzy', chainCfg().evm ? '<b class="muted">—</b>' : pctCell(d.insidersPct, 5, 15), 'Portfele powiązane z twórcą wśród top holderów (RugCheck)'],
    ['LP spalone', pctCell(d.lpBurnPct, 50, 90, true), 'Spalone lub zablokowane LP głównej puli'],
    ['DEX Paid', d.dexPaid == null ? '<b class="muted">—</b>' : d.dexPaid ? '<b class="up">Tak</b>' : '<b class="down">Nie</b>', 'Opłacony profil na DexScreenerze'],
    ['Holderzy', `<b>${fmt.n(d.h)}</b>`, 'Liczba portfeli z tym tokenem'],
  ];
  // Creator history: how many tokens they launched and how many graduated (Jupiter), or other
  // honeypots by the same deployer (GoPlus, EVM).
  const cw = creatorWarning(d);
  const creatorLink = d.creator ? `<a href="${esc(ch.evm ? (ch.explorerName ? ch.explorer(d.creator).replace('/token/', '/address/') : '#') : `https://solscan.io/account/${d.creator}`)}" target="_blank" rel="noopener">${esc(fmt.short(d.creator))}</a>` : '—';
  const history =
    d.dm != null
      ? `stworzył <b>${fmt.n(d.dm)}</b> ${plTokens(d.dm)}, graduację przeszło <b>${fmt.n(d.dmg || 0)}</b>${d.dm > 1 ? ` (${Math.round(((d.dmg || 0) / d.dm) * 100)}%)` : ''}`
      : d.dhp != null
        ? d.dhp > 0 ? `<b class="down">wdrożył już ${d.dhp} honeypot(y)</b>` : 'brak znanych honeypotów tego twórcy'
        : 'historia jeszcze się nie pobrała';
  const holdersCard = `<div class="card"><h3>Struktura holderów <small>jak w Axiom</small></h3>
    <div class="hstats">${hstats.map(([k, v, tip]) => `<div title="${esc(tip)}"><span>${k}</span>${v}</div>`).join('')}</div>
    <div class="creator ${cw ? 'bad' : ''}">🧑‍🍳 Twórca ${creatorLink} · ${history}${cw ? ` <span class="chip warnc">${cw.short}</span>` : ''}</div>
    ${devSection(d)}
    ${copySection(d)}
    <div class="d-acts">
      <button data-act="hide">🙈 Ukryj token</button>
      ${d.creator ? '<button data-act="block">⛔ Blokuj twórcę</button>' : ''}
    </div>
    <p class="note">Snajperzy, bundle i pro traderzy nie mają darmowego źródła danych — Axiom liczy je własnym, płatnym indeksowaniem.</p></div>`;

  // Trade journal: the viewer's own entry and live P&L.
  const pp = posPnl(d);
  const posCard = pp
    ? `<div class="card"><h3>💼 Pozycja <span class="demo-tag">DEMO</span> <small>od ${fmt.ago(pp.entry.t)}</small></h3>
      <div class="hstats">
        <div><span>MC wejścia</span><b>${fmt.usd(pp.entry.mc || (d.mc && d.p ? (pp.entry.p * d.mc) / d.p : null))}</b></div>
        <div><span>MC teraz</span><b>${fmt.usd(d.mc)}</b></div>
        <div><span>Wynik</span><b class="${pp.cls}">${fmt.pct(pp.pct)} · ${fmtX(d.p / pp.entry.p)}</b></div>
        ${pp.usd != null ? `<div><span>Włożone</span><b>${fmt.usd(pp.entry.usd)}</b></div><div><span>Wartość</span><b>${fmt.usd(pp.value)}</b></div><div><span>Zysk / strata</span><b class="${pp.cls}">${pp.usd >= 0 ? '+' : '−'}${fmt.usd(Math.abs(pp.usd))}</b></div>` : ''}
      </div>
      ${pp.entry.usd > 0 ? sellRow('data-sell') : '<div class="d-acts"><button data-sell="100">✖ Zamknij pozycję DEMO</button></div>'}
      ${exitRows(pp.entry, 'data-exit')}
      <div class="wallet-line" style="margin-top:10px">👛 Saldo DEMO: <b>${fmt.usd(state.wallet.cash)}</b> <button data-act="wallet-open">Doładuj</button></div>
      ${quickBuyRow('Dokup')}</div>`
    : `<div class="card"><h3>💼 Pozycja <span class="demo-tag">DEMO</span> <small>treningowa</small></h3>
      <p class="note" style="margin:0 0 8px">Pozycja treningowa — nie kupujesz prawdziwych tokenów. Grasz środkami z walletu DEMO, a zysk lub stratę widzisz na żywo („Otwarte pozycje” na dolnym pasku).</p>
      <div class="wallet-line">👛 Saldo DEMO: <b>${fmt.usd(state.wallet.cash)}</b> <button data-act="wallet-open">Doładuj</button></div>
      ${quickBuyRow('Kup')}
      <p class="note" style="margin:8px 0">…albo wpisz własną kwotę i MC wejścia (np. 150k; puste = obecny MC):</p>
      <div class="pos-form">
        <input id="posUsd" type="number" inputmode="decimal" min="0" step="any" placeholder="Kwota w $ z walletu DEMO" />
        <input id="posEntry" type="text" autocomplete="off" autocapitalize="off" placeholder="MC wejścia, np. 150k (puste = obecny)" />
        <button data-act="pos-add">💼 Zajmij pozycję DEMO</button>
      </div></div>`;

  const sections = {
    holders: holdersCard,
    pos: posCard,
    head: `<div class="d-head">${avatar(d, 'xl')}
      <div class="d-id"><h2>${esc(d.n || fmt.short(d.m))} <small>$${esc(d.s)}</small></h2>
        ${d.lp ? `<span class="chip ${d.lp === 'bonk' ? 'bonk' : 'pump'}" style="margin-left:6px">${esc(d.lp)}</span>` : ''}
        ${d.gr ? '<span class="chip grad" style="margin-left:4px">🎓 graduated</span>' : ''}
      </div>
      <button class="d-close" data-act="watch" aria-label="Obserwuj" style="color:${watched ? 'var(--warn)' : ''}">${watched ? '★' : '☆'}</button>
      <button class="d-close" data-act="close" aria-label="Zamknij">✕</button>
    </div>
    <div class="d-ca-row"><span class="d-ca-lbl">Adres kontraktu</span><code id="caFull" class="d-ca-full">${esc(d.m)}</code><button class="d-ca-btn" data-act="copy">Kopiuj</button></div>
    <div class="d-links">${links.map(([l, u, p]) => `<a href="${esc(u)}" target="_blank" rel="noopener"${p ? ' class="primary"' : ''}>${esc(l)} ↗</a>`).join('')}</div>`,
    ai: aiCard(d),
    grid: `<div class="d-grid">
      <div class="card d-score" style="--heat:${h}">
        <div class="ring"><svg viewBox="0 0 70 70"><circle class="bg" cx="35" cy="35" r="30" fill="none" stroke-width="5"/>
          <circle class="fg" cx="35" cy="35" r="30" fill="none" stroke-width="5" stroke-dasharray="188.5" stroke-dashoffset="${188.5 * (1 - d.hs / 100)}"/></svg><b>${d.hs.toFixed(0)}</b></div>
        <p>Hype Score${d.rank ? ` · #${d.rank} na radarze` : ''}</p>
      </div>
      <div class="card"><h3>Składowe Hype Score <small>0–100</small></h3><div class="parts">${parts}
        ${pen ? `<div class="part pen"><span>Kara za ryzyko</span><div class="pb"><i style="width:${pen}%"></i></div><b>−${pen}%</b></div>` : ''}</div></div>
    </div>`,
    market: `<div class="card"><h3>Rynek</h3><div class="kv">${kv.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
        ${ranks.length ? `<h3 style="margin-top:14px">Obecność na listach trendów</h3><div class="ranks">${ranks.map(([k, r]) => `<span class="chip">${esc(RANK_LABEL[k] || k)} · #${r}</span>`).join('')}</div>` : ''}
      </div>`,
    risk: `<div class="card"><h3>Bezpieczeństwo <small>${RISK_TXT[d.risk?.level] || ''}</small></h3>${safetyBlock(d.safety)}<div class="flags">${flags}</div></div>`,
    x: `<div class="card"><h3>𝕏 — ostatnia godzina ${x?.lastPoll ? `<small>aktualizacja ${fmt.ago(x.lastPoll)} temu</small>` : ''}</h3>
        ${x ? `<div class="kv" style="margin-bottom:12px">
          <div><span>Wzmianki / 1h</span><b>${x.mentions1h}${x.capped ? '+' : ''}</b></div>
          <div><span>Unikalni autorzy</span><b>${fmt.n(x.authors)}</b></div>
          <div><span>Zaangażowanie</span><b>${fmt.n(x.engagement)}</b></div>
          <div><span>Zasięg (obs.)</span><b>${fmt.n(x.reach)}</b></div></div>` : ''}
        <div class="tweets">${tweets}</div></div>`,
    trades: ENGINE ? tradesSection(d) : `<div class="card"><h3>Transakcje na żywo <small>strumień on-chain</small></h3>${trades}</div>`,
    desc: d.description ? `<div class="card"><h3>Opis</h3><p class="desc">${esc(d.description)}</p></div>` : '',
  };

  const chartTabs = `${hasPair && ENGINE?.candles ? `<button data-chart="candles" class="${chartTab === 'candles' ? 'active' : ''}">Świece DMN</button>` : ''}${hasPair ? `<button data-chart="dex" class="${chartTab === 'dex' ? 'active' : ''}">DexScreener</button>` : ''}
        <button data-chart="hype" class="${chartTab === 'hype' ? 'active' : ''}">Hype i cena (radar)</button>`;
  const layoutKey = d.m;
  if (state.detailLayout !== layoutKey) {
    // First render for this token: build the whole drawer.
    state.detailLayout = layoutKey;
    state.detailPair = hasPair;
    state.detailHtml = { ...sections };
    state.chartHist = null;
    const sec = (k) => `<div data-sec="${k}">${sections[k]}</div>`;
    // Chart first, right under the token header (above the position and the Hype Score).
    body.innerHTML = `${sec('head')}
    <div class="card d-chart"><h3>Wykres <span class="chart-tabs">
        ${chartTabs}</span></h3>
      <div class="chart-box" id="chartBox"></div></div>
    ${sec('pos')}${sec('holders')}${sec('ai')}${sec('grid')}
    <div class="d-stack">
      ${sec('market')}${sec('risk')}${sec('x')}${sec('trades')}${sec('desc')}
    </div>`;
    renderChart(d, chartTab);
    $('#drawer').scrollTop = 0;
    return;
  }

  // The DEX pair appeared (or the main pool changed) while the drawer is open: swap only the
  // chart, keeping the rest of the drawer, typed amounts and the scroll position.
  const frameSrc = state.chartFrame?.dataset.src || '';
  if (state.detailPair !== hasPair || (chartTab === 'dex' && d.pair && !frameSrc.includes(`/${d.pair}?`))) {
    state.detailPair = hasPair;
    state.chartHist = null;
    const tabs = body.querySelector('.d-chart .chart-tabs');
    if (tabs) tabs.innerHTML = chartTabs;
    const box = $('#chartBox');
    if (box) box.innerHTML = '';
    renderChart(d, chartTab);
  }

  const active = document.activeElement;
  for (const [k, html] of Object.entries(sections)) {
    if (state.detailHtml[k] === html) continue;
    const el = body.querySelector(`[data-sec="${k}"]`);
    // Don't rebuild a section while the viewer is typing in it (iOS would close the keyboard
    // and lose the text); it updates once the field loses focus.
    if (el && active && active.matches?.('input, textarea, select') && el.contains(active)) continue;
    state.detailHtml[k] = html;
    if (el) {
      // Inner scroll boxes (trades tables) keep their position across the refresh.
      const keep = [...el.querySelectorAll('.tr-wrap')].map((w) => w.scrollTop);
      el.innerHTML = html;
      el.querySelectorAll('.tr-wrap').forEach((w, i) => {
        if (keep[i]) w.scrollTop = keep[i];
      });
    }
  }
  // Our own hype/price chart redraws only when a new history point arrives; the DexScreener
  // iframe is left alone and updates itself.
  if (chartTab === 'hype') renderChart(d, 'hype');
  else if (chartTab === 'candles') renderChart(d, 'candles');
  $('#drawer').scrollTop = scroll;
}

const SENT_CLS = { 'bardzo pozytywny': 'up', pozytywny: 'up', mieszany: 'warn', negatywny: 'down' };
const ORG_CLS = { organiczny: 'up', mieszany: 'warn', podejrzany: 'down' };
const linkUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');

function aiCard(d) {
  const a = d.ai;
  const busy = a && (a.status === 'running' || a.status === 'queued');
  const btn = d.aiEnabled
    ? `<button class="ai-btn" data-act="analyze" ${busy ? 'disabled' : ''}>${busy ? '<i class="spin"></i>Analizuję…' : a?.result ? '↻ Odśwież' : '✨ Analizuj teraz'}</button>`
    : '';
  if (!d.aiEnabled && !a?.result) return ''; // AI off: keep the drawer free of it
  let body;
  if (!d.aiEnabled) {
    body = '<p class="note">Analiza AI jest wyłączona. Dodaj <code>ANTHROPIC_API_KEY</code> do pliku <code>.env</code>, aby Claude wyjaśniał, dlaczego token rośnie, i streszczał, co dzieje się na X.</p>';
  } else if (a?.result) {
    const r = a.result;
    const list = (arr) => (arr?.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
    body = `<p class="ai-head">${esc(r.headline)}</p>
      <div class="ai-tags">
        ${r.narrative ? `<span class="chip">🧭 ${esc(r.narrative)}</span>` : ''}
        <span class="chip ${SENT_CLS[r.sentiment] || ''}">Nastroje: ${esc(r.sentiment)}</span>
        <span class="chip ${ORG_CLS[r.organic] || ''}">Zainteresowanie: ${esc(r.organic)}</span>
      </div>
      ${r.why?.length ? `<h4>Dlaczego rośnie</h4>${list(r.why)}` : ''}
      ${r.x_summary ? `<h4>Co się dzieje na 𝕏</h4><p>${esc(r.x_summary)}</p>` : ''}
      ${r.red_flags?.length ? `<h4>Sygnały ostrzegawcze</h4>${list(r.red_flags)}` : ''}
      ${r.watch?.length ? `<h4>Na co patrzeć</h4>${list(r.watch)}` : ''}
      ${r.sources?.length ? `<div class="ai-src">${r.sources.filter((s) => linkUrl(s.url)).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)} ↗</a>`).join('')}</div>` : ''}`;
  } else if (busy) {
    body = '<p class="note">Claude przegląda dane tokena, wyszukuje posty na X i newsy… zwykle 20–60 s.</p>';
  } else {
    body = '<p class="note">Brak analizy. Radar analizuje automatycznie tokeny z nagłym wolumenem i skokiem hype — możesz też uruchomić ją teraz.</p>';
  }
  const meta = a?.at && a.status !== 'running' ? `<small>${a.status === 'error' ? `błąd: ${esc(a.error || '')} · ` : ''}${fmt.ago(a.at)} temu${a.auto ? ' · auto' : ''}</small>` : '';
  return `<div class="card ai-card"><h3><span>🤖 Dlaczego rośnie? <em>analiza AI</em></span>${meta}${btn}</h3>${body}</div>`;
}

async function requestAnalysis(mint) {
  if (STATIC || ENGINE) return toast('Analiza AI jest dostępna tylko w wersji serwerowej');
  try {
    const res = await fetch(`/api/analyze/${mint}`, { method: 'POST' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return toast(j.error || 'Nie udało się uruchomić analizy');
    toast('Analiza uruchomiona — wynik pojawi się za chwilę');
    loadDetail(mint);
  } catch {
    toast('Błąd połączenia');
  }
}

function renderChart(d, tab) {
  const box = $('#chartBox');
  if (!box) return;
  if (tab === 'candles' && d.pair) {
    drawCandles(d);
    loadCandles(d);
    startLive();
    return;
  }
  if (tab === 'dex' && d.pair) {
    const src = `https://dexscreener.com/${chainCfg().dex}/${d.pair}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=5`;
    // Keep the iframe alive across detail refreshes.
    const existing = state.chartFrame;
    if (existing && existing.dataset.src === src) box.appendChild(existing);
    else {
      const f = document.createElement('iframe');
      f.src = src;
      f.dataset.src = src;
      f.title = 'Wykres DexScreener';
      f.loading = 'lazy';
      state.chartFrame = f;
      box.appendChild(f);
    }
    return;
  }
  const hist = d.hist || [];
  const histKey = `${d.m}|${hist.length}|${hist[hist.length - 1]?.[0]}`;
  if (state.chartHist === histKey && box.querySelector('svg')) return; // nothing new to draw
  state.chartHist = histKey;
  if (hist.length < 2) {
    box.innerHTML = '<div class="empty"><b>Zbieram historię…</b>Wykres pojawi się po ~1 minucie obserwacji.</div>';
    return;
  }
  const W = 660;
  const H = 360;
  const hs = sparkPath(hist.map((p) => p[1]), W, H - 30, 24);
  const pr = sparkPath(hist.map((p) => p[2]), W, H - 30, 24);
  const hh = heat(d.hs);
  const t0 = hist[0][0];
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs><linearGradient id="hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hh},95%,60%)" stop-opacity=".35"/><stop offset="1" stop-color="hsl(${hh},95%,60%)" stop-opacity="0"/></linearGradient></defs>
    ${[0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${W}" y1="${(H - 30) * f}" y2="${(H - 30) * f}" stroke="#1c2431" stroke-dasharray="3 5"/>`).join('')}
    <path d="${hs.area}" fill="url(#hg)"/>
    <path d="${hs.line}" fill="none" stroke="hsl(${hh},95%,60%)" stroke-width="2.2" vector-effect="non-scaling-stroke"/>
    <path d="${pr.line}" fill="none" stroke="#52a8ff" stroke-width="1.6" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"/>
    <text x="6" y="${H - 8}" fill="#5a6576" font-size="11" font-family="JetBrains Mono">−${fmt.ago(t0)}</text>
    <text x="${W - 6}" y="${H - 8}" fill="#5a6576" font-size="11" font-family="JetBrains Mono" text-anchor="end">teraz</text>
  </svg><div class="chart-legend"><span><i style="background:hsl(${hh},95%,60%)"></i>Hype Score</span><span><i style="background:#52a8ff"></i>Cena</span></div>`;
}

// ---------- search ----------
let searchT;
let searchSel = -1;
async function doSearch(q) {
  const box = $('#searchResults');
  if (q.length < 2) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = `<div class="sr-empty">Szukam w sieci ${esc(chainCfg().name || 'Solana')}…</div>`;
  try {
    let rows;
    if (ENGINE) {
      rows = await ENGINE.search(q);
    } else if (STATIC) {
      const ql = q.toLowerCase();
      rows = [...staticRows().values()]
        .filter((r) => r.m === q || (r.s || '').toLowerCase().includes(ql) || (r.n || '').toLowerCase().includes(ql))
        .slice(0, 20);
    } else {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      ({ rows } = await res.json());
    }
    if ($('#search').value.trim() !== q) return;
    searchSel = -1;
    box.innerHTML = rows.length
      ? rows
          .map(
            (d) => `<div class="sr-item" data-m="${d.m}">${avatar(d)}<div class="sr-main"><b>${esc(d.n)} <span class="muted">$${esc(d.s)}</span></b>
            <small>${fmt.short(d.m)} · MCap ${fmt.usd(d.mc)} · 1h <span class="${cls(d.c1)}">${fmt.pct(d.c1)}</span></small></div>
            <b class="mono" style="color:hsl(${heat(d.hs)},95%,62%)">${d.hs.toFixed(0)}</b></div>`,
          )
          .join('')
      : '<div class="sr-empty">Nic nie znaleziono. Wklej pełny adres kontraktu, aby dodać dowolny token.</div>';
  } catch {
    box.innerHTML = '<div class="sr-empty">Błąd wyszukiwania</div>';
  }
}

// ---------- events ----------
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b && b.dataset.view !== state.view) setView(b.dataset.view);
});

function bindFilter(id, key, parse = Number) {
  const el = $(id);
  if (el.type === 'checkbox') el.checked = !!state.filters[key];
  else el.value = String(state.filters[key] || 0);
  el.addEventListener('change', () => {
    state.filters[key] = el.type === 'checkbox' ? el.checked : parse(el.value);
    LS.set('filters', state.filters);
    connect();
  });
}
bindFilter('#fMcap', 'minMcap');
bindFilter('#fLiq', 'minLiq');
bindFilter('#fAge', 'maxAgeH');
bindFilter('#fSafe', 'safe');
bindFilter('#fDev', 'maxDev');
bindFilter('#fLp', 'minLp');
bindFilter('#fPaid', 'paid');
bindFilter('#fTop10', 'maxTop10');
bindFilter('#fIns', 'maxIns');
bindFilter('#fHold', 'minHolders');
bindFilter('#fAuth', 'auth');
bindFilter('#fSocial', 'social');

// ---------- filter presets ----------
const BUILTIN_PRESETS = [
  { name: '🛡 Bezpieczne', f: { maxDev: 5, minLp: 90, paid: true, safe: true, auth: true, maxTop10: 30 } },
  { name: '🌱 Świeże (do 6 h)', f: { maxAgeH: 6, minMcap: 10000 } },
  { name: '🐳 Duże (MC od $1M)', f: { minMcap: 1000000, minLiq: 50000 } },
];
const EMPTY_FILTERS = { minMcap: 0, minLiq: 0, maxAgeH: 0, safe: false, maxDev: 0, minLp: 0, paid: false, maxTop10: 0, maxIns: 0, minHolders: 0, auth: false, social: false };

function renderPresets() {
  const opts = [
    '<option value="">wybierz…</option>',
    '<option value="reset">✖ Bez filtrów</option>',
    ...BUILTIN_PRESETS.map((p, i) => `<option value="b${i}">${esc(p.name)}</option>`),
    ...state.presets.map((p, i) => `<option value="u${i}">⭐ ${esc(p.name)}</option>`),
    '<option value="save">➕ Zapisz obecne filtry…</option>',
    state.presets.length ? '<option value="del">🗑 Usuń zapisany preset…</option>' : '',
  ];
  $('#fPreset').innerHTML = opts.join('');
}

function applyFilters(f) {
  state.filters = { ...EMPTY_FILTERS, ...f };
  LS.set('filters', state.filters);
  for (const [id, key] of [['#fMcap', 'minMcap'], ['#fLiq', 'minLiq'], ['#fAge', 'maxAgeH'], ['#fDev', 'maxDev'], ['#fLp', 'minLp'], ['#fTop10', 'maxTop10'], ['#fIns', 'maxIns'], ['#fHold', 'minHolders']]) $(id).value = String(state.filters[key] || 0);
  for (const [id, key] of [['#fSafe', 'safe'], ['#fPaid', 'paid'], ['#fAuth', 'auth'], ['#fSocial', 'social']]) $(id).checked = !!state.filters[key];
  connect();
}

$('#fPreset').addEventListener('change', (e) => {
  const v = e.target.value;
  e.target.value = '';
  if (!v) return;
  if (v === 'reset') {
    applyFilters({});
    toast('Filtry wyczyszczone');
  } else if (v[0] === 'b' || v[0] === 'u') {
    const p = (v[0] === 'b' ? BUILTIN_PRESETS : state.presets)[Number(v.slice(1))];
    if (p) {
      applyFilters(p.f);
      toast(`Preset: ${p.name}`);
    }
  } else if (v === 'save') {
    const name = (prompt('Nazwa presetu (np. „Moje gemy”):') || '').trim().slice(0, 30);
    if (!name) return;
    state.presets = [...state.presets.filter((p) => p.name !== name), { name, f: { ...state.filters } }];
    LS.set('presets', state.presets);
    renderPresets();
    toast(`Zapisano preset „${name}”`);
  } else if (v === 'del') {
    const list = state.presets.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
    const n = Number(prompt(`Który preset usunąć? Podaj numer:\n${list}`));
    if (n >= 1 && n <= state.presets.length) {
      const [gone] = state.presets.splice(n - 1, 1);
      LS.set('presets', state.presets);
      renderPresets();
      toast(`Usunięto preset „${gone.name}”`);
    }
  }
});
renderPresets();

// ---------- hidden tokens / blocked creators ----------
function renderHiddenBtn() {
  const n = state.hidden.size + state.blocked.size;
  $('#hiddenBtn').hidden = !n;
  $('#hiddenN').textContent = n;
}
function hideToken(mint) {
  state.hidden.add(mint);
  LS.set('hidden', [...state.hidden]);
  renderHiddenBtn();
  closeDetail();
  toast('🙈 Token ukryty — przywrócisz go przyciskiem 🙈 przy filtrach');
  connect();
}
function blockCreator(creator) {
  if (!creator) return;
  state.blocked.add(creator);
  LS.set('blocked', [...state.blocked]);
  renderHiddenBtn();
  closeDetail();
  toast('⛔ Twórca zablokowany — jego tokeny nie będą się pokazywać');
  connect();
}
$('#hiddenBtn').addEventListener('click', () => {
  if (!confirm(`Przywrócić ${state.hidden.size} ukrytych tokenów i ${state.blocked.size} zablokowanych twórców?`)) return;
  state.hidden.clear();
  state.blocked.clear();
  LS.set('hidden', []);
  LS.set('blocked', []);
  renderHiddenBtn();
  toast('Przywrócono wszystkie');
  connect();
});
renderHiddenBtn();

function togglePause() {
  state.paused = !state.paused;
  $('#pauseBtn').classList.toggle('on', state.paused);
  $('#pauseBtn .pi').textContent = state.paused ? '▶' : '❚❚';
  $('#pauseBtn .pl').textContent = state.paused ? 'Wznów' : 'Zamroź';
  $('#liveBadge').className = `live-badge${state.paused ? ' paused' : ''}`;
  $('#liveBadge').lastChild.textContent = state.paused ? 'PAUZA' : 'LIVE';
  toast(state.paused ? 'Tabela zamrożona — feed działa dalej' : 'Aktualizacje wznowione');
}
$('#pauseBtn').addEventListener('click', togglePause);

const releaseList = () => {
  if (listHoldUntil > Date.now() + 1500) listHoldUntil = Date.now() + 1500;
  showHold();
};
$('#rows').addEventListener('touchstart', (e) => {
  holdList(60_000);
  // The touched row can be replaced mid-touch: its own touchend still arrives.
  for (const ev of ['touchend', 'touchcancel']) e.target.addEventListener(ev, releaseList, { once: true, passive: true });
}, { passive: true });
for (const ev of ['touchend', 'touchcancel']) $('#rows').addEventListener(ev, releaseList, { passive: true });
window.addEventListener('scroll', () => holdList(1500), { passive: true });
$('#rows').addEventListener('click', (e) => {
  const star = e.target.closest('.star');
  const row = e.target.closest('.row[data-m]');
  if (!row || e.target.closest('a')) return; // links (e.g. 𝕏 search) open on their own
  if (e.target.closest('[data-copy]')) {
    e.stopPropagation();
    copyFromList(row.dataset.m, e.target.closest('[data-copy]'));
    return;
  }
  if (star) {
    e.stopPropagation();
    toggleWatch(row.dataset.m);
    return;
  }
  openDetail(row.dataset.m);
});

$('#feed').addEventListener('click', (e) => {
  const li = e.target.closest('.fi[data-m]');
  if (li) openDetail(li.dataset.m);
});
$('#feedChips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  state.feedFilter = b.dataset.f;
  $$('#feedChips button').forEach((x) => x.classList.toggle('active', x === b));
  renderFeed();
});

$('#scrim').addEventListener('click', closeDetail);
$('#drawer').addEventListener('click', (e) => {
  // A button tap finishes typing: let the section with the form re-render (it is held back
  // while one of its fields has focus).
  if (e.target.closest('button') && document.activeElement?.matches?.('input')) document.activeElement.blur();
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') closeDetail();
  else if (act === 'copy' && state.selected) copy(state.selected);
  else if (act === 'watch' && state.selected) toggleWatch(state.selected);
  else if (act === 'analyze' && state.selected) requestAnalysis(state.selected);
  else if (act === 'hide' && state.selected) hideToken(state.selected);
  else if (act === 'wallet-open') {
    closeDetail();
    openWallet('spot');
  }
  else if (act === 'block' && state.detail?.creator) blockCreator(state.detail.creator);
  else if (act === 'pos-add' && state.selected && state.detail) {
    const d = tradeQuote(state.detail);
    const usd = Number($('#posUsd')?.value) || 0;
    if (!(usd > 0)) return toast('Wpisz kwotę pozycji w $');
    if (usd > state.wallet.cash + 1e-9) {
      toast(`Za mało środków w walletcie DEMO (saldo ${fmt.usd(state.wallet.cash)}) — doładuj go`);
      closeDetail();
      return openWallet('spot');
    }
    const raw = ($('#posEntry')?.value || '').trim();
    // Entry given as market cap (easier than long prices): price scales with market cap.
    const mc = raw ? parseAmount(raw) : d.mc;
    if (raw && !(mc > 0)) return toast('Nie rozumiem MC — wpisz np. 150k albo 1.2m');
    if (!(d.p > 0) || !(d.mc > 0)) return toast('Brak ceny lub MC — spróbuj za chwilę');
    const buy = entryAfterFees(d.p * (mc / d.mc), usd);
    if (!buy) return toast(`Za mała kwota — opłaty transakcji (${feeUsd(tradeFee(usd))}) zjadłyby większość`);
    if (!savePosition(state.selected, buy.price, usd, mc, d, buy.fee)) return;
    toast(`💼 Pozycja DEMO otwarta przy MC ${fmt.usd(mc)}${feeNote(buy.fee)}`);
    renderDetail(state.detail);
  } else if (act === 'qbuy') {
    quickBuy(Number(e.target.closest('[data-usd]').dataset.usd));
  } else if (act === 'qbuy-edit') {
    editQuickBuy();
  }
  const ex = e.target.closest('[data-exit]');
  if (ex && state.selected && posHere(state.selected)) {
    exitClick(state.selected, ex.dataset.exit);
    if (state.detail) renderDetail(state.detail);
  }
  const sell = e.target.closest('[data-sell]');
  if (sell && state.selected && posHere(state.selected)) {
    const f = Number(sell.dataset.sell) / 100;
    const fee = sellPosition(state.selected, f, state.detail ? tradeQuote(state.detail).p : null);
    toast(`${f >= 1 ? 'Pozycja DEMO zamknięta' : `Sprzedano ${Math.round(f * 100)}% pozycji DEMO`}${feeNote(fee)}`);
    if (state.detail) renderDetail(state.detail);
  }
  const tfb = e.target.closest('[data-tf]');
  if (tfb && state.detail) {
    state.candleTf = tfb.dataset.tf;
    LS.set('candleTf', state.candleTf);
    renderChart(state.detail, 'candles');
  }
  const tw = e.target.closest('[data-track-wallet]');
  if (tw) {
    askTrackWallet(tw.dataset.trackWallet);
    if (state.detail) renderDetail(state.detail);
  }
  const chart = e.target.closest('[data-chart]');
  if (chart && state.detail) {
    state.chartTab = chart.dataset.chart;
    LS.set('chartTab2', state.chartTab);
    if (state.chartTab !== 'candles') stopLive();
    $$('[data-chart]').forEach((b) => b.classList.toggle('active', b === chart));
    destroyLW();
    $('#chartBox').innerHTML = '';
    renderChart(state.detail, state.chartTab);
  }
});

const search = $('#search');
search.addEventListener('input', () => {
  clearTimeout(searchT);
  searchT = setTimeout(() => doSearch(search.value.trim()), 280);
});
search.addEventListener('focus', () => search.value.trim().length >= 2 && doSearch(search.value.trim()));
search.addEventListener('keydown', (e) => {
  const items = $$('.sr-item');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    searchSel = Math.max(0, Math.min(items.length - 1, searchSel + (e.key === 'ArrowDown' ? 1 : -1)));
    items.forEach((it, i) => it.classList.toggle('sel', i === searchSel));
  } else if (e.key === 'Enter') {
    const it = items[Math.max(0, searchSel)];
    if (it) {
      openDetail(it.dataset.m);
      $('#searchResults').hidden = true;
      search.blur();
    }
  } else if (e.key === 'Escape') {
    $('#searchResults').hidden = true;
    search.blur();
  }
});
$('#searchResults').addEventListener('mousedown', (e) => {
  const it = e.target.closest('.sr-item');
  if (it) {
    e.preventDefault();
    openDetail(it.dataset.m);
    $('#searchResults').hidden = true;
    search.blur();
  }
});
search.addEventListener('blur', () => setTimeout(() => ($('#searchResults').hidden = true), 150));

document.addEventListener('keydown', (e) => {
  const typing = /input|select|textarea/i.test(document.activeElement?.tagName || '');
  if (e.key === 'Escape' && state.selected) closeDetail();
  else if (e.key === 'Escape' && document.body.classList.contains('sheet-open')) closeSheets();
  if (typing) return;
  if (e.key === '/') {
    e.preventDefault();
    search.focus();
  } else if (e.key.toLowerCase() === 'p') togglePause();
});

// ---------- auto-update ----------
// Safari may show a cached page after a deploy: check the live version now and then (and when
// the app comes back to the foreground) and reload into the new one.
async function checkVersion() {
  const mine = window.__MR_VERSION;
  if (!mine || document.activeElement?.matches('input, select, textarea')) return;
  try {
    const res = await fetch(`version.json?_=${Date.now()}`, { cache: 'no-store' });
    const { v } = await res.json();
    if (v && v !== mine) {
      // Once per version per tab (a stale cached page would otherwise reload forever); the ?v=
      // address skips the CDN's cached copy.
      let tried = null;
      try {
        tried = sessionStorage.getItem('mr:reloadFor');
      } catch {
        /* private mode */
      }
      if (tried === v) return;
      try {
        sessionStorage.setItem('mr:reloadFor', v);
      } catch {
        /* private mode */
      }
      toast('Nowa wersja aplikacji — odświeżam…');
      setTimeout(() => location.replace(`${location.pathname}?v=${encodeURIComponent(v)}${location.hash}`), 1200);
    }
  } catch {
    /* offline or not deployed with a version file */
  }
}
if (window.__MR_VERSION) {
  setInterval(checkVersion, 3 * 60_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkVersion());
  setTimeout(checkVersion, 5000);
}

// ---------- bottom bar ----------
// Shrinks while scrolling down (more room for the list) and grows back when scrolling up.
// Reacts only to a deliberate scroll (40 px one way), not to the small shifts live list
// updates cause.
let lastY = window.scrollY;
let scrollAcc = 0;
window.addEventListener(
  'scroll',
  () => {
    const y = window.scrollY;
    const dy = y - lastY;
    lastY = y;
    scrollAcc = Math.sign(dy) === Math.sign(scrollAcc) ? scrollAcc + dy : dy;
    const bar = $('#bottombar');
    if (y < 80) bar.classList.remove('mini');
    else if (scrollAcc > 40) bar.classList.add('mini');
    else if (scrollAcc < -40) bar.classList.remove('mini');
  },
  { passive: true },
);
$('#bottombar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-nav]');
  if (!b) return;
  // The bar stays on top of an open token window: any option closes the window first.
  if (state.selected) closeDetail();
  if (SHEETS[b.dataset.nav]) openSheet(b.dataset.nav);
  else {
    closeSheets();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});
$('#walletSheet').addEventListener('change', (e) => {
  if (e.target.dataset?.wallet !== 'fees') return;
  state.fees = e.target.checked;
  LS.set('fees', state.fees);
  toast(state.fees ? 'Opłaty transakcji włączone' : 'Opłaty transakcji wyłączone');
  renderWallet();
});
$('#walletSheet').addEventListener('click', (e) => {
  if (e.target.closest('[data-sheet-close]')) return closeSheets();
  if (e.target.closest('[data-wt-add]')) {
    const a = $('#wtAddr')?.value || '';
    trackWallet(a, $('#wtName')?.value || '', $('#wtEmoji')?.value || '👛');
    if (walletOf(a)) renderWallet();
    return;
  }
  const wd = e.target.closest('[data-wd-track]');
  if (wd) {
    const name = prompt(`Nazwa dla portfela ${fmt.short(wd.dataset.wdTrack)}:`, 'Smart');
    if (name == null) return;
    trackWallet(wd.dataset.wdTrack, name || 'Smart', '🧠');
    return renderWallet();
  }
  const del = e.target.closest('[data-wt-del]');
  if (del) {
    untrackWallet(del.dataset.wtDel);
    toast('Przestałem śledzić portfel');
    return renderWallet();
  }
  const quick = e.target.closest('[data-wallet-amt]');
  const act = e.target.closest('[data-wallet]')?.dataset.wallet;
  if (quick || act === 'topup') {
    const amount = quick ? Number(quick.dataset.walletAmt) : Number($('#topUp').value);
    if (!(amount > 0) || amount > 1e12) return toast('Wpisz kwotę doładowania');
    deposit(amount);
    if (!quick) $('#topUp').value = '';
    toast(`👛 Doładowano ${fmt.usd(amount)} — saldo ${fmt.usd(state.wallet.cash)}`);
    renderWallet();
  } else if (act === 'reset') {
    if (!confirm('Wyzerować wallet DEMO? Saldo, historia i statystyki pozycji (PnL, zyskowne / stratne, zamknięte) zostaną wyczyszczone. Otwarte pozycje zostają na liście, ale poza statystykami.')) return;
    state.wallet = { cash: 0, deposits: 0, tx: [] };
    walletTx('reset', 0);
    // Open positions stop counting against the wallet after a reset.
    for (const p of Object.values(state.positions)) p.w = false;
    LS.set('positions', state.positions);
    // Fresh statistics: closed history goes; earlier open positions no longer count (p.w false).
    state.closed = [];
    LS.set('closedPositions', state.closed);
    saveWallet();
    renderWallet();
    toast('Wallet DEMO wyzerowany');
  }
});
$('#perpSheet').addEventListener('click', (e) => {
  if (e.target.closest('[data-sheet-close]')) closeSheets();
});
$('#trenchSheet').addEventListener('click', (e) => {
  if (e.target.closest('[data-sheet-close]')) closeSheets();
});
$('#posSheet').addEventListener('click', (e) => {
  if (e.target.closest('[data-sheet-close]')) return closeSheets();
  if (e.target.closest('[data-sheet-wallet]')) return openWallet('spot');
  const cal = e.target.closest('[data-cal]');
  if (cal) {
    state.calMonth = Math.max(0, Math.min(24, state.calMonth + Number(cal.dataset.cal)));
    return renderPositions();
  }
  const sc = e.target.closest('[data-share-closed]');
  if (sc) {
    const [m, at] = sc.dataset.shareClosed.split('|');
    const c = state.closed.find((x) => x.m === m && String(x.closedAt) === at);
    if (!c) return;
    const ch = ENGINE?.chains?.[c.chain || 'solana'];
    return sharePnlCard({
      sym: c.s, name: c.n, pct: c.pct, pnl: c.usd > 0 ? c.pnl : null,
      sub: `${ch ? ch.name : ''}${c.sl ? ' · Stop loss' : c.tp ? ' · Take profit' : c.safe ? ' · SAFE' : c.be ? ' · Break even' : ''}`,
      rows: [
        ['Wkład', c.usd > 0 ? fmt.usd(c.usd) : '—'],
        ['Sprzedano', c.f && c.f < 1 ? `${Math.round(c.f * 100)}% pozycji` : 'całość'],
        ['Czas trzymania', c.openedAt ? fmt.dur(c.closedAt - c.openedAt) : '—'],
        ['Opłaty', c.fee > 0 ? feeUsd(c.fee) : '—'],
      ],
    });
  }
  const card = e.target.closest('[data-pos]');
  if (!card) return;
  const mint = card.dataset.pos;
  if (e.target.closest('[data-pos-share]')) {
    const x = positionList().find((p) => p.m === mint);
    if (!x || x.pct == null) return;
    const ch = ENGINE?.chains?.[x.p.chain || 'solana'];
    return sharePnlCard({
      sym: x.p.s, name: x.p.n, pct: x.pct, pnl: x.pnl,
      sub: `${ch ? ch.name : ''} · pozycja otwarta`,
      rows: [
        ['MC wejścia', fmt.usd(x.mcIn)],
        ['MC teraz', fmt.usd(x.mcNow)],
        ['Wkład → wartość', x.p.usd > 0 ? `${fmt.usd(x.p.usd)} → ${fmt.usd(x.value)}` : '—'],
        ['Czas trzymania', fmt.dur(Date.now() - x.p.t)],
      ],
    });
  }
  const exBtn = e.target.closest('[data-pos-exit]');
  if (exBtn) {
    exitClick(mint, exBtn.dataset.posExit);
    renderPositions();
    return;
  }
  const sellBtn = e.target.closest('[data-pos-sell]');
  if (sellBtn) {
    const x = positionList().find((p) => p.m === mint);
    const lastAt = x?.p.last?.at;
    const f = Number(sellBtn.dataset.posSell) / 100;
    const fee = sellPosition(mint, f, x?.r?.p || x?.p.last?.p);
    // Instant (no confirmation — timing matters); a position on another network sells at the
    // last price seen there.
    const what = f >= 1 ? 'Pozycja DEMO zamknięta' : `Sprzedano ${Math.round(f * 100)}% pozycji DEMO`;
    toast(`${x?.stale ? `${what} po ostatniej znanej cenie (sprzed ${lastAt ? fmt.ago(lastAt) : '—'})` : what}${feeNote(fee)}`);
    renderPositions();
    return;
  }
  // Open the token (switching network first if needed); the drawer opens above the sheet.
  if (ENGINE && card.dataset.chain !== ENGINE.chain) setChain(card.dataset.chain);
  openDetail(mint);
});
setInterval(() => {
  // Server / snapshot modes don't tick through the engine loop.
  if (!ENGINE && sheetOpen('pos')) renderPositions();
  if (!ENGINE && sheetOpen('wallet')) renderWallet();
}, 2000);

// ---------- boot ----------
renderChains();
ENGINE?.setWallets?.(state.wallets);
renderWatchCount();
renderPosCount();
$('#chains').addEventListener('click', (e) => {
  const b = e.target.closest('.chain-btn');
  if (b) setChain(b.dataset.chain);
});
$$('#tabs button').forEach((b) => {
  b.classList.toggle('active', b.dataset.view === state.view);
  b.setAttribute('aria-selected', String(b.dataset.view === state.view));
});
skeleton();
if (STATIC) {
  const when = new Date(STATIC.t).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' });
  const banner = $('#demoBanner');
  banner.innerHTML = `<b>Podgląd</b>: migawka prawdziwych danych z ${when} (DexScreener, pump.fun, Jupiter, RugCheck). Wersja odświeżana na żywo co 2 s działa po uruchomieniu serwera (<code>npm start</code>), za darmo.`;
  banner.hidden = false;
  document.body.classList.add('static');
}
connect();
// ---------- tracked wallets ----------
const normWallet = (a) => {
  if (typeof a !== 'string') return '';
  const s = a.trim();
  return s.startsWith('0x') ? s.toLowerCase() : s;
};
function walletOf(a) {
  const k = normWallet(a);
  return k ? state.wallets.find((w) => normWallet(w.a) === k) || null : null;
}
function saveWallets() {
  LS.set('wallets', state.wallets);
  ENGINE?.setWallets(state.wallets);
}
function trackWallet(a, name, emoji = '👛') {
  const addr = normWallet(a);
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return toast('To nie wygląda na adres portfela');
  const label = String(name || '').trim().slice(0, 24) || fmt.short(addr);
  const prev = walletOf(addr);
  if (prev) Object.assign(prev, { name: label, emoji });
  else state.wallets.push({ a: addr, name: label, emoji, t: Date.now() });
  saveWallets();
  toast(`${emoji} Śledzę portfel: ${label}`);
}
function untrackWallet(a) {
  const k = normWallet(a);
  state.wallets = state.wallets.filter((w) => normWallet(w.a) !== k);
  saveWallets();
}
/** Wallet cell: tracked label, DEV tag, or the short address (tap to track). */
function walletCell(a, creator) {
  const w = walletOf(a);
  const dev = creator && normWallet(creator) === normWallet(a);
  return `<button class="wal${w ? ' tracked' : ''}" data-track-wallet="${esc(a)}" title="${w ? 'Śledzony portfel' : 'Dotknij, aby śledzić ten portfel'}">${w ? `${esc(w.emoji || '👛')} ${esc(w.name)}` : esc(fmt.short(a))}${dev ? ' <i class="devtag">DEV</i>' : ''}</button>`;
}
const WALLET_EMOJI = ['👛', '🐋', '🧠', '🎯', '🔥', '👑', '🤖', '🐸', '💎', '⚠️'];
function askTrackWallet(a) {
  const w = walletOf(a);
  const name = prompt(`${w ? 'Zmień nazwę' : 'Nazwa dla portfela'} ${fmt.short(a)} (puste = przestań śledzić):`, w?.name || '');
  if (name == null) return;
  if (!name.trim()) {
    if (w) {
      untrackWallet(a);
      toast('Przestałem śledzić portfel');
    }
    return;
  }
  trackWallet(a, name, w?.emoji || '👛');
}

// ---------- wallet discovery ----------
// Every token window's top traders are remembered locally; wallets that were in profit on several
// different tokens (best: getting in early) are suggested for the wallet tracker.
function recordTraders(mint, list) {
  const d = state.detail?.m === mint ? state.detail : null;
  const price = d?.p;
  if (!(price > 0) || list.length < 20) return;
  const t0 = list[list.length - 1].t;
  const span = list[0].t - t0 || 1;
  // 'Early' = first buy within the token's first hour (or first tenth of its life), from launch;
  // without a launch time, the first 30% of the visible trades.
  const ca = d?.ca > 0 ? d.ca : 0;
  const isEarly = (fb) => fb != null && (ca ? fb - ca <= Math.max(3600e3, (list[0].t - ca) * 0.1) : fb - t0 <= span * 0.3);
  const firstBuy = new Map();
  for (const t of list) if (t.side === 'buy' && t.wallet && (!firstBuy.has(t.wallet) || t.t < firstBuy.get(t.wallet))) firstBuy.set(t.wallet, t.t);
  let disc = LS.get('disc', {});
  if (!disc || typeof disc !== 'object') disc = {};
  const now = Date.now();
  for (const o of topTraders(list, price)) {
    if (o.pnl == null || !o.w) continue;
    const e = (disc[o.w] ??= { n: {}, at: 0 });
    delete e.n[mint]; // re-insert = most recent
    e.n[mint] = [Math.round(o.pnl), isEarly(firstBuy.get(o.w)) ? 1 : 0, d?.s ? String(d.s).slice(0, 12) : '', Math.round(o.bUsd)];
    const nk = Object.keys(e.n);
    if (nk.length > 40) for (const k of nk.slice(0, nk.length - 40)) delete e.n[k];
    e.at = now;
    e.c = ENGINE?.chain || 'solana';
  }
  const keys = Object.keys(disc);
  if (keys.length > 800) for (const k of keys.sort((a, b) => disc[a].at - disc[b].at).slice(0, keys.length - 800)) delete disc[k];
  LS.set('disc', disc);
}
/** Wallets in profit on 3+ different tokens, best first. */
function discoveredWallets() {
  const disc = LS.get('disc', {}) || {};
  return Object.entries(disc)
    .map(([w, e]) => {
      const toks = Object.values(e.n || {});
      // A win: at least $50 and 20% of what they bought (not a few cents of unrealised gain).
      const win = (x) => x[0] >= Math.max(50, 0.2 * (x[3] || 0));
      const wins = toks.filter(win);
      return { w, c: e.c, wins: wins.length, early: wins.filter((x) => x[1]).length, pnl: toks.reduce((a, x) => a + x[0], 0), n: toks.length, syms: Object.values(e.n || {}).filter(win).map((x) => x[2]).filter(Boolean).slice(0, 4) };
    })
    .filter((x) => x.wins >= 3 && !walletOf(x.w))
    .sort((a, b) => b.wins - a.wins || b.early - a.early || b.pnl - a.pnl)
    .slice(0, 15);
}
function discoveryCard() {
  const list = discoveredWallets();
  const seen = Object.keys(LS.get('disc', {}) || {}).length;
  return `<div class="card wallet-disc"><h3>🔍 Odkryte portfele <small>${seen} zapamiętanych</small></h3>
    ${list.length
      ? list.map((x) => `<div class="wd-row"><div><b class="mono">${esc(fmt.short(x.w))}</b><small>na plusie w ${x.wins}/${x.n} tokenach${x.early ? ` · ${x.early}× wcześnie` : ''} · ${x.pnl >= 0 ? '+' : '−'}${fmt.usd(Math.abs(x.pnl))}${x.syms.length ? ` · ${x.syms.map((s) => '$' + esc(s)).join(' ')}` : ''}</small></div><button data-wd-track="${esc(x.w)}">Śledź</button></div>`).join('')
      : '<p class="note">Jeszcze nic — DMN zapamiętuje top traderów z każdego tokena, który otwierasz. Portfele na plusie w co najmniej 3 różnych tokenach pojawią się tutaj.</p>'}
  </div>`;
}

// ---------- live trades / top traders (open token) ----------
const WHALE_USD_UI = { solana: 1000, bsc: 1000, base: 1000, robinhood: 500, ethereum: 5000 };
let tradesBusy = false;
/** Loads the open token's latest trades (the engine caches them for 25 s). */
async function loadTrades(mint) {
  if (!ENGINE?.trades || tradesBusy) return;
  // The chart's history goes first on the shared free API budget (up to ~10 s after opening).
  if (state.chartTab === 'candles' && !(state.candles?.key?.startsWith(`${mint}|`) && state.candles.at > 0 && !state.candles.err) && Date.now() - (state.openedAt || 0) < 10_000) return;
  if (state.tr?.m === mint && Date.now() - state.tr.at < 40_000) return;
  tradesBusy = true;
  try {
    const list = await ENGINE.trades(mint);
    if (state.selected !== mint) return;
    state.tr = { m: mint, list: list || [], at: Date.now(), none: list == null };
    if (list?.length) recordTraders(mint, list);
    if (state.detail && Date.now() >= drawerTouch) renderDetail(state.detail);
  } catch {
    // Keep what we had and wait the usual 25 s before trying again.
    if (state.selected === mint) state.tr = { m: mint, list: state.tr?.m === mint ? state.tr.list : [], at: Date.now(), err: true };
  } finally {
    tradesBusy = false;
  }
}

/** Per-wallet summary of the trades: bought / sold $, result, still holding, what they're doing. */
function topTraders(list, price) {
  const by = new Map();
  for (const t of [...list].sort((a, b) => a.t - b.t)) {
    if (!t.wallet) continue;
    let o = by.get(t.wallet);
    if (!o) by.set(t.wallet, (o = { w: t.wallet, bUsd: 0, sUsd: 0, bAmt: 0, sAmt: 0, b: 0, s: 0, seq: [] }));
    if (t.side === 'buy') {
      o.bUsd += t.usd;
      o.bAmt += t.amount;
      o.b++;
    } else {
      o.sUsd += t.usd;
      o.sAmt += t.amount;
      o.s++;
    }
    o.seq.push(t.side);
  }
  return [...by.values()]
    .map((o) => {
      const held = Math.max(0, o.bAmt - o.sAmt);
      // Only sells of tokens bought in the window count; with no buys in it the result is unknown.
      const sRatio = o.sAmt > o.bAmt ? (o.bAmt > 0 ? o.bAmt / o.sAmt : 0) : 1;
      const pnl = o.b ? o.sUsd * sRatio + (price > 0 ? held * price : 0) - o.bUsd : null;
      const last3 = o.seq.slice(-3);
      const state_ =
        o.b && !o.s ? (o.b >= 3 && last3.every((x) => x === 'buy') ? 'dokupuje' : 'trzyma')
        : o.s && held <= o.bAmt * 0.02 ? (o.b ? 'sprzedał' : 'sprzedaje')
        : last3[last3.length - 1] === 'sell' ? 'sprzedaje'
        : 'trzyma';
      return { ...o, held, pnl, vol: o.bUsd + o.sUsd, status: state_ };
    })
    .sort((a, b) => b.vol - a.vol)
    .slice(0, 12);
}

function tradesSection(d) {
  const tr = state.tr?.m === d.m ? state.tr : null;
  if (!ENGINE?.trades) return '<div class="card"><h3>Transakcje na żywo</h3><p class="note">Dostępne w wersji przeglądarkowej.</p></div>';
  if (!d.pair) return '<div class="card"><h3>Transakcje na żywo</h3><p class="note">Token nie ma jeszcze puli DEX — transakcje pojawią się po graduacji.</p></div>';
  if (!tr) return '<div class="card"><h3>Transakcje na żywo</h3><p class="note">Ładowanie transakcji…</p></div>';
  if (!tr.list.length) return `<div class="card"><h3>Transakcje na żywo</h3><p class="note">${tr.err ? 'Nie udało się pobrać transakcji (limit darmowego API) — spróbuję za chwilę.' : 'Brak transakcji w tej puli.'}</p></div>`;
  const whale = WHALE_USD_UI[ENGINE.chain] || 1000;
  const rows = tr.list
    .slice(0, 30)
    .map((t) => `<tr class="${t.usd >= whale ? 'whale' : ''}"><td class="side ${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? 'Kupno' : 'Sprzedaż'}</td><td class="mono">${t.usd >= whale ? '🐋 ' : ''}${fmt.usd(t.usd)}</td><td>${walletCell(t.wallet, d.creator)}</td><td class="mono muted">${fmt.ago(t.t)}</td></tr>`)
    .join('');
  const buys = tr.list.filter((t) => t.side === 'buy');
  const bUsd = buys.reduce((a, t) => a + t.usd, 0);
  const sUsd = tr.list.reduce((a, t) => a + (t.side === 'sell' ? t.usd : 0), 0);
  const span = tr.list.length > 1 ? tr.list[0].t - tr.list[tr.list.length - 1].t : 0;
  const top = topTraders(tr.list, d.p);
  const STATUS = { dokupuje: 'up', trzyma: '', sprzedaje: 'down', sprzedał: 'muted' };
  const topRows = top
    .map((o) => `<tr><td>${walletCell(o.w, d.creator)}</td><td class="mono tt-vol"><span class="up">↑ ${fmt.usd(o.bUsd)}</span><span class="down">↓ ${fmt.usd(o.sUsd)}</span></td><td class="mono tt-res">${o.pnl == null ? '<b class="muted" title="Kupił przed widocznymi transakcjami">?</b>' : `<b class="${o.pnl >= 0 ? 'up' : 'down'}">${o.pnl >= 0 ? '+' : '−'}${fmt.usd(Math.abs(o.pnl))}</b>`}<small class="${STATUS[o.status]}">${o.status}</small></td></tr>`)
    .join('');
  return `<div class="card"><h3>Transakcje na żywo <small>${tr.list.length} ostatnich · ${span ? fmt.dur(span) : ''}</small></h3>
      <div class="tr-sum"><span class="up">Kupno ${fmt.usd(bUsd)}</span><span class="down">Sprzedaż ${fmt.usd(sUsd)}</span><span>${new Set(buys.map((t) => t.wallet)).size} kupujących</span></div>
      <div class="tr-wrap"><table class="trades">${rows}</table></div>
      <p class="note">🐋 = transakcja od ${fmt.usd(whale)}. Dotknij portfela, aby go śledzić (alerty w „Na żywo” → 👛 Portfele).</p></div>
    <div class="card"><h3>Top traderzy <small>z ostatnich ${tr.list.length} transakcji</small></h3>
      <div class="tr-wrap"><table class="trades top"><tr class="th"><td>Portfel</td><td>Kupił / sprzedał</td><td>Wynik</td></tr>${topRows}</table></div>
      <p class="note">Wynik = sprzedaż + wartość tego, co jeszcze trzyma, minus zakupy — tylko z widocznych transakcji (starsze nie są liczone).</p></div>`;
}

// ---------- copies / reused socials ----------
/** What an X link points at: a profile, a community, or someone's tweet (a common fake). */
function xLinkKind(u) {
  if (!u) return null;
  if (/\/status\/\d+/.test(u)) return { t: 'cudzy tweet (nie profil projektu)', bad: true };
  if (/\/i\/communities\//.test(u)) return { t: 'społeczność X', bad: false };
  if (/\/search\?|\/hashtag\//.test(u)) return { t: 'wyszukiwanie, nie profil', bad: true };
  return { t: 'profil', bad: false };
}
function copySection(d) {
  const c = d.copyInfo;
  const x = linkUrl(d.socials?.twitter) ? xLinkKind(d.socials.twitter) : null;
  const lines = [];
  if (c) {
    if (!c.same && !c.partial) lines.push('<span class="up">Jedyny token z tym tickerem</span>');
    else if (c.same) {
      lines.push(`Ten ticker ma jeszcze ${c.partial ? 'co najmniej ' : ''}<b>${c.same}</b> ${plTokens(c.same)}${c.isOg ? ' — <b class="up">ten jest najstarszy (OG)</b>' : ''}`);
      if (!c.isOg && c.og) lines.push(`<span class="warn">OG: ${esc(c.og.chain)} · MC ${fmt.usd(c.og.mc)}${c.og.at < Infinity ? ` · ${fmt.ago(c.og.at)}` : ''}</span>`);
      if (c.top && c.top.mc > (d.mc || 0)) lines.push(`Największa kopia: MC ${fmt.usd(c.top.mc)} (${esc(c.top.chain)})`);
    }
    const SH = { twitter: 'X', telegram: 'Telegram', website: 'Strona' };
    for (const [k, n] of Object.entries(c.shared || {})) lines.push(`<span class="down">${SH[k]} podpięty pod ${n} ${pl(n, 'inny token', 'inne tokeny', 'innych tokenów')}</span>`);
  }
  if (x) lines.push(`Link X: <span class="${x.bad ? 'down' : 'up'}">${x.t}</span>`);
  if (!lines.length) return '';
  return `<div class="copies"><b>🧬 Kopie i socjale</b>${lines.map((l) => `<div>${l}</div>`).join('')}</div>`;
}

// ---------- safety score ----------
const scoreCls = (v) => (v >= 70 ? 'up' : v >= 40 ? 'warn' : 'down');
function safetyBlock(sf) {
  if (!sf) return '<p class="note">Ocena bezpieczeństwa pojawi się po pierwszym raporcie (RugCheck / GoPlus).</p>';
  const c = scoreCls(sf.score);
  const items = sf.items.length
    ? `<div class="sf-items">${sf.items.map((i) => `<div><span>${esc(i.label)}</span><b class="down">${i.pts}</b></div>`).join('')}</div>`
    : '<p class="note">Bez znanych czerwonych flag.</p>';
  return `<div class="sf-score"><b class="${c}">${sf.score}</b><span>/100</span><div><b>Ocena bezpieczeństwa</b><small>${sf.veto ? 'weto: honeypot' : sf.score <= 79 && sf.items.some((i) => /^LP/.test(i.label)) ? 'maks. 79 przy niezablokowanym LP' : 'im wyżej, tym bezpieczniej'}</small></div><i class="dev-bar"><i class="${c}" style="width:${sf.score}%"></i></i></div>
    ${items}${sf.unchecked?.length ? `<p class="note">Nie sprawdzono: ${sf.unchecked.join(', ')}.</p>` : ''}`;
}

// ---------- dev rating / DexScreener orders (token window) ----------
function devSection(d) {
  const r = d.dev;
  const lines = [];
  if (r) {
    const c = r.score >= 70 ? 'up' : r.score >= 40 ? 'warn' : 'down';
    const what = r.honeypots
      ? `wdrożył już ${r.honeypots} honeypot(y)`
      : r.n === 0
        ? 'pierwszy token tego deva'
        : r.migrations
          ? `${fmt.n(r.n)} ${plTokens(r.n)}, graduację przeszło ${fmt.n(r.good)}`
          : `${fmt.n(r.n)} ${plTokens(r.n)} wcześniej · ${r.good} powyżej $100k${r.ok > r.good ? ` · ${r.ok - r.good} powyżej $30k` : ''}${r.best ? ` · najlepszy ${fmt.usd(r.best)}` : ''}`;
    lines.push(`<div class="dev-score"><b class="${c}">${r.score}</b><span>/100</span><div><b>Ocena deva</b><small>${what}</small></div><i class="dev-bar"><i class="${c}" style="width:${r.score}%"></i></i></div>`);
  }
  if (d.devTokens?.length)
    lines.push(`<div class="dev-tokens">${d.devTokens.map((x) => `<span class="chip ${x.mc >= 100000 ? 'up' : x.mc >= 30000 ? 'warn' : ''}" title="${esc(x.mint)}">${fmt.usd(x.mc)}${x.at ? ` · ${fmt.ago(x.at)}` : ''}</span>`).join('')}</div>`);
  if (d.devInfo?.dev) lines.push(`<p class="note">Deployer (GeckoTerminal): ${walletCell(d.devInfo.dev, d.creator)}${d.devInfo.devPct != null ? ` · trzyma ${d.devInfo.devPct.toFixed(1)}%` : ''}</p>`);
  const tw = d.creator && walletOf(d.creator);
  if (tw) lines.push(`<p class="note"><b>${esc(tw.emoji || '👛')} Twórca to śledzony portfel: ${esc(tw.name)}</b></p>`);
  // Paid DexScreener orders with timing relative to the launch.
  const ORDER = { tokenProfile: '✅ DEX paid', communityTakeover: '🤝 CTO', tokenAd: '📣 Reklama', trendingBarAd: '📣 Pasek trendów', boost: '⚡ Boost' };
  const os = (d.dsOrders || []).filter((o) => ORDER[o.type]);
  if (os.length) {
    const since = (at) => (d.launchedAt && at > d.launchedAt ? ` · ${fmt.dur(at - d.launchedAt)} po starcie` : '');
    lines.push(`<div class="orders">${os.map((o) => `<span class="chip ${o.type === 'communityTakeover' ? 'cto' : ''}" title="${o.at ? new Date(o.at).toLocaleString('pl-PL') : ''}">${ORDER[o.type]}${o.amount ? ` ${o.amount}` : ''}${o.at ? `${since(o.at)}` : ''}</span>`).join('')}</div>`);
  }
  return lines.join('');
}

// ---------- candle chart ----------
const TF_LIST = ['1m', '5m', '15m', '1h', '4h'];
let candlesBusy = null; // key of the load in flight
async function loadCandles(d) {
  const tf = state.candleTf;
  const key = `${d.m}|${tf}`;
  if (!ENGINE?.candles) return;
  if (state.candles?.key === key && Date.now() - state.candles.at < 50_000) return;
  // Built from what we have: the latest trades, else the prices the radar recorded (every 15 s).
  const synthesize = () => {
    const fromTrades = state.tr?.m === d.m ? candlesFrom(state.tr.list.filter((t) => t.price > 0).map((t) => [t.t, t.price, t.usd]), tf) : [];
    const fromHist = candlesFrom((d.hist || []).filter((h) => h[2] > 0).map((h) => [h[0], h[2], 0]), tf);
    const list = fromTrades.length >= fromHist.length ? fromTrades : fromHist;
    return { list, synth: list.length ? (list === fromTrades ? 'trades' : 'radar') : 'live' };
  };
  // Seen this token before: its saved history shows at once while fresh candles load.
  if (state.candles?.key !== key) {
    // …or, the first time, a provisional chart from the prices the radar has recorded.
    const cached = readCandleCache(key);
    const prov = cached ? null : synthesize();
    if (cached || prov.list.length > 1) {
      state.candles = cached ? { key, list: cached, at: 0, synth: 'cache' } : { key, list: prov.list, at: 0, synth: prov.synth };
      if (state.chartTab === 'candles' && state.detail?.m === d.m) drawCandles(state.detail);
    }
  }
  // One download at a time; when it ends it loads whatever is wanted then.
  if (candlesBusy) return;
  candlesBusy = key;
  const wanted = () => key === `${state.selected}|${state.candleTf}`;
  try {
    let list = await ENGINE.candles(d.m, tf);
    let synth = null;
    if (!list?.length) ({ list, synth } = synthesize());
    else saveCandleCache(key, list);
    if (wanted()) state.candles = { key, list: list || [], at: Date.now(), synth };
  } catch (e) {
    if (wanted()) {
      // Rate limited: keep the history we have (cached / previous) and try again in ~4 s; only
      // without any build one from trades / radar prices.
      const prev = state.candles?.key === key && state.candles.list.length ? state.candles : null;
      const cached = prev ? null : readCandleCache(key);
      const base = prev ? { list: prev.list, synth: prev.synth } : cached ? { list: cached, synth: 'cache' } : synthesize();
      state.candles = { key, ...base, at: Date.now() - (e?.status === 404 ? 0 : 46_000), err: e?.status !== 404 };
    }
  } finally {
    candlesBusy = null;
  }
  if (state.chartTab !== 'candles' || !state.detail || state.selected !== state.detail.m) return;
  // The timeframe or token changed while loading: load what is wanted now.
  if (!wanted()) return loadCandles(state.detail);
  drawCandles(state.detail);
}

// Candle history cache (last 24 token / timeframe sets): reopening a token shows its chart at once.
function readCandleCache(key) {
  const all = LS.get('cc', null);
  const e = all && typeof all === 'object' ? all[key] : null;
  return e && Date.now() - e.at < 24 * 3600e3 && Array.isArray(e.list) && e.list.length ? e.list.map((k) => [...k]) : null;
}
function saveCandleCache(key, list) {
  let all = LS.get('cc', {});
  if (!all || typeof all !== 'object') all = {};
  all[key] = { at: Date.now(), list: list.slice(-200) };
  const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
  for (const k of keys.slice(24)) delete all[k];
  LS.set('cc', all);
}

/** Points [ms, price, volumeUsd] → candles [start, o, h, l, c, vol] for the timeframe. */
function candlesFrom(points, tf) {
  const ms = TF_MS[tf] || 300e3;
  const out = [];
  for (const [t, p, v] of [...points].sort((a, b) => a[0] - b[0])) {
    const start = Math.floor(t / ms) * ms;
    const last = out[out.length - 1];
    if (last && last[0] === start) {
      last[2] = Math.max(last[2], p);
      last[3] = Math.min(last[3], p);
      last[4] = p;
      last[5] += v || 0;
    } else out.push([start, last ? last[4] : p, Math.max(p, last ? last[4] : p), Math.min(p, last ? last[4] : p), p, v || 0]);
  }
  return out;
}

/** The viewer's demo buys / sells of this token: [{ t, side, p }]. */
function myTrades(m) {
  return state.wallet.tx.filter((t) => t.m === m && (t.type === 'open' || t.type === 'close') && t.p > 0).map((t) => ({ t: t.t, side: t.type === 'open' ? 'buy' : 'sell', p: t.p }));
}

/**
 * Price levels for the chart: the viewer's buy level (open position's entry, else the average of
 * their recent buys), their sell level (average of recent sells) and the top 10 holders' average
 * entry — from their buys among the latest trades (Axiom shows the same line); without enough of
 * them, the 10 biggest buyers in those trades.
 */
function chartLevels(d, mine, tr) {
  const out = {};
  const recent = mine.filter((t) => Date.now() - t.t < 7 * 86400e3);
  const pos = posHere(d.m);
  const buys = recent.filter((t) => t.side === 'buy');
  const sells = recent.filter((t) => t.side === 'sell');
  if (pos?.p > 0) {
    out.buy = pos.p;
    out.buyN = buys.filter((t) => t.t >= pos.t).length || 1;
  } else if (buys.length) {
    out.buy = buys.reduce((a, t) => a + t.p, 0) / buys.length;
    out.buyN = buys.length;
  }
  if (sells.length) {
    out.sell = sells.reduce((a, t) => a + t.p, 0) / sells.length;
    out.sellN = sells.length;
  }
  // Volume-weighted average buy price of a set of wallets.
  const avgBuy = (pred) => {
    let usd = 0;
    let amt = 0;
    const who = new Set();
    for (const t of tr) {
      if (t.side !== 'buy' || !(t.amount > 0) || !(t.usd > 0) || !pred(t)) continue;
      usd += t.usd;
      amt += t.amount;
      who.add(t.wallet);
    }
    return amt > 0 ? { p: usd / amt, n: who.size } : null;
  };
  const holders = new Set((d.topHolders || []).map((h) => normWallet(h.a)));
  const h = holders.size ? avgBuy((t) => holders.has(normWallet(t.wallet))) : null;
  if (h && h.n >= 2) {
    out.top = h.p;
    out.topKind = 'holders';
  } else if (tr.length) {
    const by = new Map();
    for (const t of tr) if (t.side === 'buy' && t.amount > 0) by.set(t.wallet, (by.get(t.wallet) || 0) + t.amount);
    const top = new Set([...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map((e) => e[0]));
    const b = avgBuy((t) => top.has(t.wallet));
    if (b) {
      out.top = b.p;
      out.topKind = 'buyers';
    }
  }
  return out;
}

function drawCandlesSvg(d) {
  const box = $('#chartBox');
  if (!box) return;
  const tf = state.candleTf;
  const c = state.candles?.key === `${d.m}|${tf}` ? state.candles : null;
  const tfRow = `<div class="tf-row">${TF_LIST.map((x) => `<button data-tf="${x}" class="${x === tf ? 'active' : ''}">${x}</button>`).join('')}</div>`;
  if (!c || !c.list.length) {
    const html = `${tfRow}<div class="empty"><b>${c ? (c.err ? 'Limit darmowego API — spróbuję za chwilę' : 'Czekam na cenę na żywo…') : 'Ładowanie świec…'}</b></div>`;
    if (box.dataset.ck !== html || !box.querySelector('.tf-row')) {
      box.dataset.ck = html;
      box.innerHTML = html;
    }
    return;
  }
  const pos = posHere(d.m);
  const mine = myTrades(d.m);
  const tr = state.tr?.m === d.m ? state.tr.list : [];
  const whale = WHALE_USD_UI[ENGINE?.chain] || 1000;
  // The live price (polled every second) beats the 4-second detail refresh.
  const live = state.live?.m === d.m && Date.now() - state.live.at < 10_000 ? state.live : null;
  const nowP = live?.p || d.p;
  // Market-cap axis: MC moves 1:1 with price (fixed supply), so prices are scaled to MC.
  const mcK = (live?.mc || d.mc) > 0 && nowP > 0 ? (live?.mc || d.mc) / nowP : 0;
  const money = (v) => (mcK ? fmt.usd(v * mcK) : fmt.price(v));
  // Drawn at the box's real pixel size, so labels keep their shape on any screen.
  const W = Math.max(300, Math.round(box.clientWidth || 660));
  const H = Math.max(220, Math.round((box.clientHeight || 360) - 24));
  const key = `${W}x${H}|${(d.topHolders || []).length}|${c.key}|${c.at}|${c.list.length}|${pos ? `${pos.p}|${pos.sl}|${pos.tp}|${pos.safe}|${pos.be}` : ''}|${mine.length}|${tr.length}|${nowP}`;
  if (box.dataset.ck === key && box.querySelector('svg.candles')) return;
  box.dataset.ck = key;
  const list = c.list.slice(-Math.max(30, Math.min(120, Math.floor(W / 6))));
  // Live last candle: extend with the current price.
  const last = [...list[list.length - 1]];
  if (nowP > 0) {
    last[4] = nowP;
    last[2] = Math.max(last[2], nowP);
    last[3] = Math.min(last[3], nowP);
    list[list.length - 1] = last;
  }
  const PT = 44, PB = 64, PL = 4, PR = 64;
  const ph = H - PT - PB;
  let lo = Math.min(...list.map((k) => k[3]));
  let hi = Math.max(...list.map((k) => k[2]));
  // Position levels inside a sensible band around the visible prices join the range.
  const levels = [];
  const lv = chartLevels(d, mine, tr);
  if (lv.buy) levels.push([lv.buy, `Moje kupno${lv.buyN > 1 ? ` (śr. z ${lv.buyN})` : ''}`, '#4da3ff']);
  if (lv.sell) levels.push([lv.sell, `Moja sprzedaż${lv.sellN > 1 ? ` (śr. z ${lv.sellN})` : ''}`, '#ff8a4d']);
  if (lv.top) levels.push([lv.top, `Top 10 ${lv.topKind === 'holders' ? 'holderów' : 'kupujących'} · śr. wejście`, '#e4c15a']);
  if (pos?.p > 0) {
    if (pos.sl) levels.push([pos.p * (1 - pos.sl / 100), `SL −${fmt.n(pos.sl)}%`, '#ff4d6a']);
    if (pos.tp) levels.push([pos.p * (1 + pos.tp / 100), `TP +${fmt.n(pos.tp)}%`, '#1fd68f']);
    if (pos.safe) levels.push([pos.p * (1 + SAFE_PCT / 100), 'SAFE', '#f5b83d']);
    if (pos.be) levels.push([pos.p * (1 + BE_PCT / 100), 'BE', '#7cbcff']);
  }
  for (const [v] of levels) if (v > lo / 2 && v < hi * 2) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
  if (!(hi > lo)) hi = lo * 1.01 || 1;
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const y = (v) => PT + ph - ((v - lo) / (hi - lo)) * ph;
  const n = list.length;
  const step = (W - PL - PR) / n;
  const x = (i) => PL + step * i + step / 2;
  const t0 = list[0][0];
  const tfMs = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3 }[tf];
  const idxAt = (ts) => {
    if (ts < t0) return -1;
    for (let i = n - 1; i >= 0; i--) if (list[i][0] <= ts) return ts - list[i][0] <= tfMs * 2 || i === n - 1 ? i : -1;
    return -1;
  };
  const vmax = Math.max(...list.map((k) => k[5] || 0)) || 1;
  const bw = Math.max(1.5, step * 0.62);
  let svg = '';
  // Grid + price labels.
  for (let g = 0; g <= 4; g++) {
    const v = lo + ((hi - lo) * g) / 4;
    svg += `<line x1="${PL}" x2="${W - PR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="cg"/><text x="${W - PR + 6}" y="${(y(v) + 4).toFixed(1)}" class="cl">${money(v)}</text>`;
  }
  // Volume.
  list.forEach((k, i) => {
    const vh = ((k[5] || 0) / vmax) * (PB - 30);
    svg += `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${(H - 22 - vh).toFixed(1)}" width="${bw.toFixed(1)}" height="${vh.toFixed(1)}" class="${k[4] >= k[1] ? 'vu' : 'vd'}"/>`;
  });
  // Candles.
  list.forEach((k, i) => {
    const up = k[4] >= k[1];
    const yo = y(k[1]), yc = y(k[4]);
    svg += `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(k[2]).toFixed(1)}" y2="${y(k[3]).toFixed(1)}" class="${up ? 'wu' : 'wd'}"/><rect x="${(x(i) - bw / 2).toFixed(1)}" y="${Math.min(yo, yc).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(yc - yo)).toFixed(1)}" class="${up ? 'cu' : 'cd'}"/>`;
  });
  // Migration moment.
  if (d.ma) {
    const i = idxAt(d.ma);
    if (i >= 0) svg += `<line x1="${x(i)}" x2="${x(i)}" y1="${PT}" y2="${PT + ph}" class="mig"/><text x="${x(i) + 4}" y="${PT + ph - 6}" class="ml">🎓 migracja</text>`;
  }
  // Position levels.
  // Labels alternate left / right so close levels don't cover each other.
  levels.forEach(([v, label, col], li) => {
    if (v < lo || v > hi) return;
    const right = li % 2 === 1;
    svg += `<line x1="${PL}" x2="${W - PR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${col}" class="lvl"/><text x="${right ? W - PR - 4 : PL + 4}" y="${(y(v) - 4).toFixed(1)}" fill="${col}" class="ll"${right ? ' text-anchor="end"' : ''}>${esc(label)}</text>`;
  });
  // Whales / tracked wallets (from the latest trades).
  for (const t of tr) {
    const w = walletOf(t.wallet);
    if (!w && t.usd < whale) continue;
    const i = idxAt(t.t);
    if (i < 0 || !(t.price > 0) || t.price < lo || t.price > hi) continue;
    svg += `<circle cx="${x(i).toFixed(1)}" cy="${y(t.price).toFixed(1)}" r="${w ? 5 : 4}" class="${w ? 'tw' : t.side === 'buy' ? 'wb' : 'ws'}"><title>${w ? `${esc(w.name)}: ` : '🐋 '}${t.side === 'buy' ? 'kupno' : 'sprzedaż'} ${fmt.usd(t.usd)}</title></circle>`;
  }
  // The viewer's demo buys / sells.
  for (const t of mine) {
    const i = idxAt(t.t);
    if (i < 0) continue;
    const k = list[i];
    if (t.side === 'buy') {
      const yy = y(k[3]) + 6;
      svg += `<path d="M${x(i)} ${yy} l6 10 h-12 z" class="mb"><title>Twoje kupno DEMO</title></path>`;
    } else {
      const yy = y(k[2]) - 6;
      svg += `<path d="M${x(i)} ${yy} l6 -10 h-12 z" class="ms"><title>Twoja sprzedaż DEMO</title></path>`;
    }
  }
  // Time labels.
  const hhmm = (ts) => new Date(ts).toLocaleString('pl-PL', tf === '1h' || tf === '4h' ? { day: '2-digit', month: '2-digit', hour: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  for (const i of [0, Math.floor(n / 2), n - 1]) svg += `<text x="${Math.min(W - PR - 30, Math.max(PL, x(i) - 20)).toFixed(1)}" y="${H - 6}" class="cl">${hhmm(list[i][0])}</text>`;
  const SYN = { trades: 'świece z ostatnich transakcji', radar: 'świece z cen radaru', live: 'świece z ceny na żywo', cache: 'zapisana historia — odświeżam' };
  const legend = `<div class="c-legend">${c.synth ? `<span class="muted">ⓘ ${SYN[c.synth]}</span>` : ''}<span><i class="lg-mb"></i>Twoje kupno</span><span><i class="lg-ms"></i>Twoja sprzedaż</span><span><i class="lg-w"></i>🐋 Wieloryb</span>${state.wallets.length ? '<span><i class="lg-tw"></i>Śledzony</span>' : ''}</div>`;
  // Current market cap, big, next to the timeframes; the live dot shows the 1-second refresh.
  const head = `<div class="c-now"><i class="${live ? 'on' : ''}"></i>${mcK ? `MC ${fmt.usd(nowP * mcK)}` : fmt.price(nowP)}</div>`;
  box.innerHTML = `${tfRow}${head}<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="candles">${svg}</svg>${legend}`;
}

// ---------- TradingView Lightweight Charts (candle chart) ----------
// Loaded on first use from the site itself (vendor/), Apache-2.0. Until it is ready (or if it
// can't load) the built-in SVG chart is drawn instead.
let lwLoad = null;
function loadLW() {
  if (window.LightweightCharts) return Promise.resolve(true);
  if (lwLoad) return lwLoad;
  lwLoad = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = `vendor/lightweight-charts.js${window.__MR_VERSION ? `?v=${window.__MR_VERSION}` : ''}`;
    s.onload = () => resolve(!!window.LightweightCharts);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  }).then((ok) => {
    if (ok && state.chartTab === 'candles' && state.detail) drawCandles(state.detail);
    return ok;
  });
  return lwLoad;
}
function destroyLW() {
  try {
    state.lw?.chart.remove();
  } catch {
    /* already gone */
  }
  state.lw = null;
}

function drawCandles(d) {
  if (window.LightweightCharts) return drawCandlesLW(d);
  loadLW();
  drawCandlesSvg(d);
}

function drawCandlesLW(d) {
  const box = $('#chartBox');
  if (!box) return;
  const LW = window.LightweightCharts;
  const tf = state.candleTf;
  let lw = state.lw;
  if (!lw || lw.mint !== d.m || !lw.el.isConnected) {
    destroyLW();
    box.innerHTML = `<div class="tf-row">${TF_LIST.map((x) => `<button data-tf="${x}">${x}</button>`).join('')}</div><div class="c-now"></div><div class="lw-box"></div><div class="lw-msg" hidden></div><div class="c-legend"></div>`;
    const el = box.querySelector('.lw-box');
    const chart = LW.createChart(el, {
      autoSize: true,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#7c879a', fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: LW.CrosshairMode.Normal },
      // Vertical swipes scroll the token window, horizontal ones move the chart; pinch zooms.
      handleScroll: { vertTouchDrag: false, horzTouchDrag: true, mouseWheel: true, pressedMouseMove: true },
      handleScale: { pinch: true, mouseWheel: true, axisPressedMouseMove: true },
      localization: { locale: 'pl-PL' },
    });
    // Below zero is only the empty margin under the candles: no label there.
    const fmtV = (v) => (v < 0 ? '' : state.lw?.K ? fmt.usd(v) : fmt.price(v));
    const candle = chart.addCandlestickSeries({
      upColor: '#1fd68f', downColor: '#ff4d6a', borderVisible: false, wickUpColor: '#1fd68f', wickDownColor: '#ff4d6a',
      priceFormat: { type: 'custom', minMove: 1e-12, formatter: fmtV },
    });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.22 } });
    const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    lw = state.lw = { chart, candle, vol, el, mint: d.m, dataKey: '', linesKey: '', marksKey: '', lines: [], K: 0, tf: '' };
  }
  box.querySelectorAll('.tf-row button').forEach((b) => b.classList.toggle('active', b.dataset.tf === tf));
  const msg = box.querySelector('.lw-msg');
  const c = state.candles?.key === `${d.m}|${tf}` ? state.candles : null;
  if (!c || !c.list.length) {
    msg.hidden = false;
    msg.textContent = c ? (c.err ? 'Limit darmowego API — spróbuję za chwilę' : 'Czekam na cenę na żywo…') : 'Ładowanie świec…';
    if (lw.dataKey) {
      lw.candle.setData([]);
      lw.vol.setData([]);
      lw.dataKey = '';
    }
    return;
  }
  msg.hidden = true;
  const live = state.live?.m === d.m && Date.now() - state.live.at < 10_000 ? state.live : null;
  const nowP = live?.p || d.p;
  const off = -new Date().getTimezoneOffset() * 60; // the chart shows UTC: shift to local time
  const ms = TF_MS[tf] || 300e3;
  const tOf = (ts) => Math.floor(ts / ms) * (ms / 1000) + off;
  const dataKey = `${c.key}|${c.at}|${c.synth || ''}`;
  const toBar = (k, K) => ({ time: Math.floor(k[0] / 1000) + off, open: k[1] * K, high: k[2] * K, low: k[3] * K, close: k[4] * K });
  const volBar = (k) => ({ time: Math.floor(k[0] / 1000) + off, value: k[5] || 0, color: k[4] >= k[1] ? 'rgba(31,214,143,0.35)' : 'rgba(255,77,106,0.35)' });
  if (dataKey !== lw.dataKey) {
    // Market-cap scale: fixed for this data set (MC moves 1:1 with price), so live updates match.
    const mc = live?.mc || d.mc;
    lw.K = mc > 0 && nowP > 0 ? mc / nowP : 0;
    const K = lw.K || 1;
    lw.candle.setData(c.list.map((k) => toBar(k, K)));
    lw.vol.setData(c.list.map(volBar));
    if (lw.tf !== tf || lw.prov !== !!c.synth) {
      // A new timeframe / token, or the real history replacing a provisional one: show the
      // latest ~70 candles.
      const n = c.list.length;
      lw.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 70), to: n + 3 });
      lw.tf = tf;
      lw.prov = !!c.synth;
    }
    lw.dataKey = dataKey;
    lw.linesKey = '';
    lw.marksKey = '';
  }
  // The last candle follows the live price.
  const K = lw.K || 1;
  const lastK = c.list[c.list.length - 1];
  // Only a bar that covers the current interval follows the live price (a cached history can
  // end hours ago: the next live tick opens a fresh bar instead).
  if (nowP > 0 && Date.now() < lastK[0] + ms) {
    lw.candle.update({ time: Math.floor(lastK[0] / 1000) + off, open: lastK[1] * K, high: Math.max(lastK[2], nowP) * K, low: Math.min(lastK[3], nowP) * K, close: nowP * K });
  }
  // Levels: my buy / sell, top 10 entry, position exits.
  const pos = posHere(d.m);
  const mine = myTrades(d.m);
  const tr = state.tr?.m === d.m ? state.tr.list : [];
  const lv = chartLevels(d, mine, tr);
  const levels = [];
  if (lv.buy) levels.push([lv.buy, 'B', '#4da3ff']);
  if (lv.sell) levels.push([lv.sell, 'S', '#ff8a4d']);
  if (lv.top) levels.push([lv.top, 'Top 10', '#e4c15a']);
  if (pos?.p > 0) {
    if (pos.sl) levels.push([pos.p * (1 - pos.sl / 100), `SL −${fmt.n(pos.sl)}%`, '#ff4d6a']);
    if (pos.tp) levels.push([pos.p * (1 + pos.tp / 100), `TP +${fmt.n(pos.tp)}%`, '#1fd68f']);
    if (pos.safe) levels.push([pos.p * (1 + SAFE_PCT / 100), 'SAFE', '#f5b83d']);
    if (pos.be) levels.push([pos.p * (1 + BE_PCT / 100), 'BE', '#7cbcff']);
  }
  const linesKey = `${K}|${levels.map((l) => `${l[0].toPrecision(6)}${l[1]}`).join(',')}`;
  if (linesKey !== lw.linesKey) {
    for (const l of lw.lines) lw.candle.removePriceLine(l);
    lw.lines = levels.map(([v, title, color]) => lw.candle.createPriceLine({ price: v * K, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title }));
    lw.linesKey = linesKey;
  }
  // Markers: my trades, whales, tracked wallets, top holders, migration.
  const first = c.list[0][0];
  const whale = WHALE_USD_UI[ENGINE?.chain] || 1000;
  const marks = [];
  if (d.ma && d.ma >= first) marks.push({ time: tOf(d.ma), position: 'belowBar', color: '#c9a7ff', shape: 'square', text: '🎓' });
  for (const t of tr) {
    if (t.t < first) continue;
    const w = walletOf(t.wallet);
    if (w) marks.push({ time: tOf(t.t), position: t.side === 'buy' ? 'belowBar' : 'aboveBar', color: '#c9a7ff', shape: 'circle', text: `${w.emoji || '👛'} ${w.name}` });
    else if (t.usd >= whale) marks.push({ time: tOf(t.t), position: t.side === 'buy' ? 'belowBar' : 'aboveBar', color: t.side === 'buy' ? '#4da3ff' : '#ffaa4d', shape: 'circle', text: '🐋' });
  }
  for (const t of mine) {
    if (t.t < first) continue;
    marks.push(t.side === 'buy'
      ? { time: tOf(t.t), position: 'belowBar', color: '#1fd68f', shape: 'arrowUp', text: 'B' }
      : { time: tOf(t.t), position: 'aboveBar', color: '#ff4d6a', shape: 'arrowDown', text: 'S' });
  }
  marks.sort((a, b) => a.time - b.time);
  // One marker of a kind per candle (a busy candle would stack a tower of them).
  const seenMk = new Set();
  for (let i = marks.length - 1; i >= 0; i--) {
    const k = `${marks[i].time}|${marks[i].text}|${marks[i].position}`;
    if (seenMk.has(k)) marks.splice(i, 1);
    else seenMk.add(k);
  }
  const marksKey = `${dataKey}|${marks.length}|${marks.map((m) => m.time + m.text).join(',').length}`;
  if (marksKey !== lw.marksKey) {
    lw.candle.setMarkers(marks);
    lw.marksKey = marksKey;
  }
  const now = box.querySelector('.c-now');
  const SRC = { chain: '⚡ on-chain', jupiter: 'Jupiter', dexscreener: 'DexScreener' };
  const nowHtml = `<i class="${live ? 'on' : ''}"></i>${lw.K ? `MC ${fmt.usd(nowP * lw.K)}` : fmt.price(nowP)}${live?.source ? `<small>${SRC[live.source] || ''}</small>` : ''}`;
  if (now.innerHTML !== nowHtml) now.innerHTML = nowHtml;
  const SYN = { trades: 'świece z ostatnich transakcji', radar: 'świece z cen radaru', live: 'świece z ceny na żywo', cache: 'zapisana historia — odświeżam' };
  // One line only (the legend strip has room for one on a phone).
  const legend = c.synth ? `<span class="muted">ⓘ ${SYN[c.synth]}</span>` : '<span>Przesuń palcem · powiększ dwoma palcami</span>';
  const lg = box.querySelector('.c-legend');
  if (lg.dataset.html !== legend) {
    lg.dataset.html = legend;
    lg.innerHTML = legend;
  }
}

// ---------- live chart (every second) ----------
let liveTimer = null;
let liveBusy = false;
const TF_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3 };
function startLive() {
  if (!liveTimer && ENGINE?.live) liveTimer = setInterval(liveTick, 1000);
}
function stopLive() {
  clearInterval(liveTimer);
  liveTimer = null;
}
/** Folds a live price into the loaded candles: updates the last one, opens a new one when its
 *  interval has passed (the chart moves every second between candle downloads). */
function applyLive(p, at) {
  const c = state.candles;
  // Only the list of the timeframe on screen (another one's bars have a different spacing).
  if (!c?.list || c.key !== `${state.selected}|${state.candleTf}`) return;
  const ms = TF_MS[state.candleTf] || 300e3;
  if (!c.list.length) {
    // Nothing to download for this pool: the chart starts from the live price (never while the
    // history is just delayed by the rate limit).
    if (c.synth === 'live') c.list.push([Math.floor(at / ms) * ms, p, p, p, p, 0]);
    return;
  }
  const last = c.list[c.list.length - 1];
  if (at >= last[0] + ms) {
    const start = Math.floor(at / ms) * ms;
    c.list.push([start, last[4], Math.max(last[4], p), Math.min(last[4], p), p, 0]);
    if (c.list.length > 400) c.list.shift();
  } else {
    last[4] = p;
    last[2] = Math.max(last[2], p);
    last[3] = Math.min(last[3], p);
  }
}
async function liveTick() {
  const d = state.detail;
  if (!state.selected || state.chartTab !== 'candles' || !d || d.m !== state.selected) return stopLive();
  if (liveBusy || document.hidden) return;
  liveBusy = true;
  try {
    const r = await ENGINE.live(d.m);
    if (r?.p > 0 && state.selected === d.m) {
      state.live = { m: d.m, p: r.p, mc: r.mc, at: r.at, source: r.source };
      applyLive(r.p, r.at);
      // The TradingView chart updates in place (no rebuild), so it moves even under a finger;
      // the SVG fallback skips frames while the drawer is touched (iOS would lose the tap).
      if (state.chartTab === 'candles' && (window.LightweightCharts || Date.now() >= drawerTouch)) drawCandles(state.detail);
    }
  } catch {
    /* rate limited / offline: the next tick tries again */
  } finally {
    liveBusy = false;
  }
}

// ---------- PnL card (share) ----------
async function sharePnlCard(c) {
  const cv = document.createElement('canvas');
  cv.width = 1080;
  cv.height = 1350;
  const g = cv.getContext('2d');
  const up = c.pct >= 0;
  const bg = g.createLinearGradient(0, 0, 1080, 1350);
  bg.addColorStop(0, '#0b0f17');
  bg.addColorStop(1, up ? '#0d2a1f' : '#2a0d14');
  g.fillStyle = bg;
  g.fillRect(0, 0, 1080, 1350);
  g.fillStyle = up ? 'rgba(31,214,143,0.10)' : 'rgba(255,77,106,0.10)';
  g.beginPath();
  g.arc(900, 260, 420, 0, Math.PI * 2);
  g.fill();
  const font = (w, px) => `${w} ${px}px -apple-system, "SF Pro Display", "Segoe UI", Roboto, sans-serif`;
  g.fillStyle = '#ff7a2e';
  g.font = font(900, 64);
  g.fillText('DMN', 80, 140);
  g.fillStyle = '#f5b83d';
  g.font = font(800, 34);
  g.fillText('DEMO · trening', 240, 136);
  g.fillStyle = '#e8edf5';
  g.font = font(800, 76);
  g.fillText(String(c.sym ? `$${c.sym}` : c.name || 'Token').slice(0, 18), 80, 330);
  g.fillStyle = '#8a96a8';
  g.font = font(500, 38);
  g.fillText(String(c.sub || '').slice(0, 44), 80, 392);
  g.fillStyle = up ? '#1fd68f' : '#ff4d6a';
  g.font = font(900, 210);
  g.fillText(`${up ? '+' : ''}${c.pct >= 1000 ? Math.round(c.pct).toLocaleString('pl-PL') : c.pct.toFixed(1)}%`, 70, 640);
  if (c.pnl != null) {
    g.font = font(800, 76);
    g.fillText(`${c.pnl >= 0 ? '+' : '−'}$${Math.abs(c.pnl).toLocaleString('pl-PL', { maximumFractionDigits: 2 })}`, 80, 760);
  }
  g.fillStyle = '#8a96a8';
  g.font = font(500, 40);
  let yy = 900;
  for (const [k, v] of c.rows || []) {
    g.fillStyle = '#8a96a8';
    g.fillText(k, 80, yy);
    g.fillStyle = '#e8edf5';
    g.font = font(700, 40);
    g.fillText(v, 520, yy);
    g.font = font(500, 40);
    yy += 70;
  }
  g.fillStyle = '#5c6779';
  g.font = font(500, 30);
  g.fillText(`${new Date().toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' })} · pozycja treningowa, bez prawdziwych pieniędzy`, 80, 1290);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  if (!blob) return toast('Nie udało się utworzyć obrazka');
  const file = new File([blob], `dmn-pnl-${c.sym || 'token'}.png`, { type: 'image/png' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'DMN — wynik DEMO' });
      return;
    }
  } catch (e) {
    if (e?.name === 'AbortError') return;
  }
  // No file sharing: open the image (long-press to save on iPhone).
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win) {
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------- PnL calendar ----------
function pnlCalendar() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - state.calMonth, 1);
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const byDay = new Map();
  for (const c of state.closed) {
    if (c.w === false) continue;
    const dt = new Date(c.closedAt);
    if (dt.getFullYear() !== first.getFullYear() || dt.getMonth() !== first.getMonth()) continue;
    const k = dt.getDate();
    const o = byDay.get(k) || { pnl: 0, n: 0 };
    o.pnl += c.usd > 0 ? c.pnl : 0;
    o.n++;
    byDay.set(k, o);
  }
  const total = [...byDay.values()].reduce((a, o) => a + o.pnl, 0);
  const lead = (first.getDay() + 6) % 7; // Monday first
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="cal-d empty"></div>');
  const today = state.calMonth === 0 ? now.getDate() : -1;
  const short = (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.abs(v) >= 10 ? Math.round(v) : v.toFixed(1));
  for (let dd = 1; dd <= days; dd++) {
    const o = byDay.get(dd);
    const cls = o ? (o.pnl > 0 ? 'win' : o.pnl < 0 ? 'loss' : 'flat') : '';
    cells.push(`<div class="cal-d ${cls}${dd === today ? ' today' : ''}" title="${o ? `${o.n} transakcji · ${o.pnl >= 0 ? '+' : '−'}$${Math.abs(o.pnl).toFixed(2)}` : ''}"><span>${dd}</span>${o ? `<b>${o.pnl >= 0 ? '+' : '−'}${short(Math.abs(o.pnl))}</b>` : ''}</div>`);
  }
  const month = first.toLocaleString('pl-PL', { month: 'long', year: 'numeric' });
  return `<h3 class="pos-h">Kalendarz PnL</h3>
    <div class="cal"><div class="cal-head"><button data-cal="1" aria-label="Poprzedni miesiąc">‹</button><b>${month}</b><span class="${total > 0 ? 'up' : total < 0 ? 'down' : 'muted'}">${byDay.size ? `${total >= 0 ? '+' : '−'}${fmt.usd(Math.abs(total))}` : '—'}</span><button data-cal="-1" ${state.calMonth === 0 ? 'disabled' : ''} aria-label="Następny miesiąc">›</button></div>
      <div class="cal-grid">${['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'].map((x) => `<div class="cal-w">${x}</div>`).join('')}${cells.join('')}</div></div>`;
}

/** Wallet tracker card (wallet sheet). */
function walletTrackerCard() {
  const list = state.wallets
    .map((w) => `<div class="wt-row"><span>${esc(w.emoji || '👛')}</span><b>${esc(w.name)}</b><small class="mono">${esc(fmt.short(w.a))}</small><button data-wt-del="${esc(w.a)}" aria-label="Usuń">✕</button></div>`)
    .join('');
  return `<div class="card wallet-track"><h3>👛 Śledzone portfele <small>${state.wallets.length || ''}</small></h3>
      ${list || '<p class="note">Brak śledzonych portfeli. Dodaj adres poniżej albo dotknij portfela w „Transakcjach na żywo” lub „Top traderach” tokena.</p>'}
      <div class="pos-form wt-form">
        <input id="wtAddr" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Adres portfela" />
        <input id="wtName" type="text" autocomplete="off" placeholder="Nazwa, np. Smart dev" />
        <select id="wtEmoji">${WALLET_EMOJI.map((e) => `<option>${e}</option>`).join('')}</select>
        <button data-wt-add>➕ Śledź portfel</button>
      </div>
      <p class="note">Alerty w panelu „Na żywo” (👛 Portfele): gdy śledzony portfel kupi lub sprzeda obserwowany token, otwartą pozycję albo otwarty token, oraz gdy wypuści nowy token na pump.fun. Działa przy otwartej aplikacji.</p>
    </div>`;
}

// ---------- several tabs ----------
// Positions and the wallet live in localStorage: another tab (or an older Safari tab coming
// back) must pick up the latest copy instead of overwriting it with its stale one.
function reloadTradeState() {
  const positions = LS.get('positions', {});
  state.positions = positions && typeof positions === 'object' ? positions : {};
  for (const p of Object.values(state.positions)) if (p && p.w === undefined) p.w = false;
  const closed = LS.get('closedPositions', []);
  state.closed = Array.isArray(closed) ? closed : [];
  state.wallet = { cash: 0, deposits: 0, tx: [], ...LS.get('wallet', {}) };
  if (!Array.isArray(state.wallet.tx)) state.wallet.tx = [];
  posSaveAt = Date.now(); // positionList must not write straight back
  renderPosCount();
  if (sheetOpen('pos')) renderPositions();
  if (sheetOpen('wallet')) renderWallet();
  if (state.detail) renderDetail(state.detail);
}
window.addEventListener('storage', (e) => {
  if (['mr:positions', 'mr:wallet', 'mr:closedPositions'].includes(e.key)) reloadTradeState();
});
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reloadTradeState());
window.addEventListener('pageshow', (e) => e.persisted && reloadTradeState());

// Deep link: #t=<network>:<address> (older links: #t=<solana address>).
function openDeepLink() {
  const deep = location.hash.match(/^#t=(?:(\w+):)?([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$/);
  if (!deep) return;
  const net = deep[1] || (deep[2].startsWith('0x') ? null : 'solana');
  const switched = !!(ENGINE && net && Object.hasOwn(ENGINE.chains, net) && net !== ENGINE.chain);
  if (switched) setChain(net);
  // After a network switch the link is written back (setChain cleared it).
  openDetail(deep[2].startsWith('0x') ? deep[2].toLowerCase() : deep[2], switched);
}
openDeepLink();
// A link opened while the app is already running (the app's own replaceState doesn't fire this).
window.addEventListener('hashchange', openDeepLink);
