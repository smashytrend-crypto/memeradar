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
  view: ((v) => (v === 'pos' ? 'hype' : v))(LS.get('view', 'hype')), // 'pos' was a tab in an older version
  filters: LS.get('filters', { minMcap: 0, minLiq: 0, maxAgeH: 0, safe: false }),
  watch: new Set(LS.get('watch', [])),
  hidden: new Set(LS.get('hidden', [])), // tokens the viewer hid from the lists
  blocked: new Set(LS.get('blocked', [])), // creators whose tokens are hidden
  positions: LS.get('positions', {}), // mint -> { p: entry price, mc, usd, t, chain, n, s, i, last }
  closed: LS.get('closedPositions', []), // closed demo trades (last 90 days) for the 1d / 7d / 30d P&L
  wallet: { cash: 0, deposits: 0, tx: [], ...LS.get('wallet', {}) }, // demo wallet funding the demo positions
  quickBuy: LS.get('quickBuy', [50, 100, 250, 500]), // the viewer's quick-buy amounts in $
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
  if (d.bp != null) chips.push(`<span class="chip ${d.lp === 'bonk' ? 'bonk' : 'pump'}">${d.lp === 'bonk' ? 'bonk' : 'pump'}</span><span class="bc"><span class="bc-bar"><i style="width:${d.bp}%"></i></span>${d.bp.toFixed(0)}%</span>`);
  else if (d.gr) chips.push('<span class="chip grad">🎓 DEX</span>');
  const pos = posPnl(d);
  if (pos) chips.push(`<span class="chip pos ${pos.cls}" title="Twoja pozycja DEMO: ${fmt.pct(pos.pct)}${pos.usd != null ? ` (${pos.usd >= 0 ? '+' : ''}${fmt.usd(pos.usd)})` : ''}">💼 DEMO ${fmt.pct(pos.pct)}</span>`);
  if (d.fz && FRESH[d.fz]) chips.push(`<span class="chip fz ${FRESH[d.fz][2]}" title="Hype teraz: ${FRESH[d.fz][1]}">${FRESH[d.fz][0]} ${FRESH[d.fz][1]}</span>`);
  const serial = creatorWarning(d);
  if (serial) chips.push(`<span class="chip warnc" title="${esc(serial.tip)}">${serial.short}</span>`);
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
  const watched = state.watch.has(d.m);
  q.star.classList.toggle('on', watched);
  q.star.textContent = watched ? '★' : '☆';

  entry.data = d;
}

// Values refresh in place every snapshot; the row ORDER changes at most every REORDER_MS so the
// list doesn't jump around under the reader's finger.
const REORDER_MS = 5_000;

function displayOrder(rows) {
  const now = Date.now();
  if (!state.order || state.firstSnapshot || now - (state.lastReorder || 0) >= REORDER_MS) {
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
  if (f.minMcap || f.minLiq || f.maxAgeH || f.safe) return '<b>Nic nie pasuje do filtrów</b>Poluzuj filtry, aby zobaczyć więcej tokenów.';
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
      !(f.paid && r.dp !== true),
  );
}

function applySnapshot(snap) {
  applyMode(snap.stats);
  $('#feedChips [data-f="whale"]').hidden = !snap.stats.liveTrades;
  snap.rows = viewerFilter(snap.rows, snap.view);
  if (snap.view === 'hype') state.hypeRows = snap.rows;
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
      if (state.view !== 'hype') state.hypeRows = viewerFilter(ENGINE.snapshot('hype', filters, 100).rows, 'hype');
      // Demo positions on this network stay loaded even when off the list.
      const posHere = Object.keys(state.positions).filter((m) => (state.positions[m].chain || 'solana') === ENGINE.chain);
      if (posHere.length) ENGINE.track(posHere);
      applySnapshot(ENGINE.snapshot(state.view, filters, 100, state.view === 'watch' ? [...state.watch] : []));
      if (sheetOpen('pos') && !sheetBusy()) renderPositions();
      if (sheetOpen('wallet') && !sheetBusy()) renderWallet();
    };
    run();
    state.tick = setInterval(run, 2000);
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
  if (state.view === 'watch') params.set('mints', [...state.watch].join(','));
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
  if (d.dm >= 20 && (d.dmg || 0) / d.dm < 0.05)
    return { short: '🧑‍🍳 seryjny twórca', tip: `Twórca stworzył ${fmt.n(d.dm)} tokenów, graduację przeszło ${fmt.n(d.dmg || 0)}` };
  return null;
}

/** The viewer's position in a token: P&L vs. the saved entry price, or null. */
function posPnl(d) {
  const p = state.positions[d.m];
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
  const m = String(text || '').trim().replace(/[\s$]/g, '').replace(',', '.').match(/^(\d*\.?\d+)([kmb])?$/i);
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

function savePosition(mint, price, usd, mc, d = {}) {
  // Funded from the demo wallet: the stake leaves the balance now and returns (with P&L) on close.
  state.wallet.cash -= usd;
  walletTx('open', usd, { n: d.n || '', s: d.s || '' });
  saveWallet();
  const prev = state.positions[mint];
  if (prev && prev.p > 0 && prev.usd > 0) {
    // Buying more: one position with the average entry (weighted by tokens bought).
    const tokens = prev.usd / prev.p + usd / price;
    prev.p = (prev.usd + usd) / tokens;
    prev.mc = prev.mc && mc ? (prev.usd + usd) / (prev.usd / prev.mc + usd / mc) : prev.mc || mc;
    prev.usd += usd;
    prev.w = prev.w !== false;
    LS.set('positions', state.positions);
    renderPosCount();
    return;
  }
  state.positions[mint] = {
    w: true,
    p: price,
    mc: mc || 0,
    usd: usd > 0 ? usd : 0,
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
}

/** Closes a demo position at `price` (its current price), keeping the result for the P&L history. */
/** Sells `fraction` (0–1] of a demo position at `price`; 1 closes it. */
function sellPosition(mint, fraction, price, extra = {}) {
  const p = state.positions[mint];
  if (!p) return;
  const f = p.usd > 0 ? Math.min(1, Math.max(0, fraction)) : 1;
  const exit = price > 0 ? price : p.last?.p;
  const part = (p.usd || 0) * f;
  // Wallet-funded positions pay the sold part's current value back into the demo balance.
  if (p.w && part > 0) {
    const back = exit > 0 && p.p > 0 ? part * (exit / p.p) : part;
    state.wallet.cash += back;
    walletTx('close', back, { n: p.n, s: p.s, pnl: back - part, f });
    saveWallet();
  }
  if (exit > 0 && p.p > 0) {
    const pct = (exit / p.p - 1) * 100;
    state.closed.unshift({
      m: mint, n: p.n, s: p.s, chain: p.chain, usd: part, pct, f,
      pnl: part > 0 ? part * (exit / p.p - 1) : 0, openedAt: p.t, closedAt: Date.now(), ...extra,
    });
    state.closed = state.closed.filter((c) => Date.now() - c.closedAt < 90 * 86400e3).slice(0, 500);
    LS.set('closedPositions', state.closed);
  }
  if (f >= 1 || p.usd - part < 0.005) delete state.positions[mint];
  else p.usd -= part;
  LS.set('positions', state.positions);
  renderPosCount();
}
const closePosition = (mint, price) => sellPosition(mint, 1, price);

/** Buys `usd` of the token in the drawer at the current price (quick buy). */
function quickBuy(usd) {
  const d = state.detail;
  if (!d || !state.selected) return;
  if (usd > state.wallet.cash + 1e-9) {
    toast(`Za mało środków w walletcie DEMO (saldo ${fmt.usd(state.wallet.cash)}) — doładuj go`);
    closeDetail();
    return openSheet('wallet');
  }
  if (!(d.p > 0) || !(d.mc > 0)) return toast('Brak ceny lub MC — spróbuj za chwilę');
  const had = !!state.positions[state.selected];
  savePosition(state.selected, d.p, usd, d.mc, d);
  toast(`💼 ${had ? 'Dokupiono' : 'Kupiono'} DEMO za ${fmt.usd(usd)} przy MC ${fmt.usd(d.mc)}`);
  renderDetail(d);
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
};
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
  if (!(p.mc > 0)) return toast('Brak MC wejścia — wpisz wartość w %');
  const pct = kind === 'sl' ? (1 - v / p.mc) * 100 : (v / p.mc - 1) * 100;
  if (!(pct > 0 && pct < k.max)) return toast(`MC musi być ${kind === 'sl' ? 'niższe' : 'wyższe'} niż MC wejścia (${fmt.usd(p.mc)})`);
  setExit(kind, mint, Math.round(pct * 10) / 10);
}

const exitRow = (kind, p, attr) => {
  const k = EXITS[kind];
  const v = p[kind];
  const mcAt = v && p.mc > 0 ? p.mc * (kind === 'sl' ? 1 - v / 100 : 1 + v / 100) : null;
  // Expected result of this level: TP on the share it sells, SL on the whole position.
  const share = kind === 'tp' ? (p.tpf || 100) / 100 : 1;
  const est = v && p.usd > 0 ? p.usd * share * (v / 100) : null;
  const estLine = est != null
    ? `<small class="sl-est ${kind}">${kind === 'tp' ? `Przewidywany zysk: <b>+${fmt.usd(est)}</b>${share < 1 ? ` (sprzeda ${Math.round(share * 100)}% za ${fmt.usd(p.usd * share + est)})` : ` (wypłata ${fmt.usd(p.usd + est)})`}` : `Przewidywana strata: <b>−${fmt.usd(est)}</b> (wróci ${fmt.usd(p.usd - est)})`}</small>`
    : '';
  return `<div class="sl-row ${kind}"><span>${k.icon} ${k.name}${v ? ` <b>${k.sign}${fmt.n(v)}%</b>${mcAt ? ` <small>MC ${fmt.usd(mcAt)}</small>` : ''}` : ' <small>wyłączony</small>'}</span>${estLine}
    <div>${k.presets.map((x) => `<button ${attr}="${kind}:${x}" class="${v === x ? 'on' : ''}">${k.sign}${x}%</button>`).join('')}<button ${attr}="${kind}:custom" class="${v && !k.presets.includes(v) ? 'on' : ''}">Własny</button>${kind === 'sl' ? `<button ${attr}="be:toggle" class="be ${p.be ? 'on' : ''}" title="Break even: sprzeda całość, gdy cena spadnie do +${BE_PCT}% od wejścia">🛡️ BE · Break even (+${BE_PCT}%)</button>` : ''}${v ? `<button ${attr}="${kind}:off" class="off" aria-label="Wyłącz">✕</button>` : ''}</div>${
      kind === 'sl' && p.be
        ? `<small class="sl-est be">🛡️ BE ${p.bea ? `aktywny — sprzeda całość przy <b>+${BE_PCT}%</b>${p.mc > 0 ? ` (MC ${fmt.usd(p.mc * (1 + BE_PCT / 100))})` : ''}${p.usd > 0 ? `, zysk <b>+${fmt.usd((p.usd * BE_PCT) / 100)}</b>` : ''}` : `czeka, aż zysk przekroczy +${BE_PCT}% — potem pilnuje ceny +${BE_PCT}%`}</small>`
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
  if (!Object.values(state.positions).some((p) => p.sl || p.tp || p.be)) return;
  let hit = false;
  for (const x of positionList()) {
    if (x.stale || x.pct == null) continue;
    if (x.p.be && !x.p.bea && x.pct > BE_PCT) {
      x.p.bea = true;
      LS.set('positions', state.positions);
      hit = true;
    }
    const kind = x.p.sl && x.pct <= -x.p.sl ? 'sl' : x.p.tp && x.pct >= x.p.tp ? 'tp' : x.p.be && x.p.bea && x.pct <= BE_PCT ? 'be' : null;
    if (!kind) continue;
    const f = kind === 'tp' ? (x.p.tpf || 100) / 100 : 1;
    sellPosition(x.m, f, x.r.p, { [kind]: true });
    // A partial take profit fires once; the rest of the position stays open without it.
    const left = state.positions[x.m];
    if (left) {
      delete left.tp;
      LS.set('positions', state.positions);
    }
    toast(`${EXITS[kind].icon} ${EXITS[kind].name}: sprzedano ${f < 1 ? `${Math.round(f * 100)}% ` : ''}${x.p.s ? '$' + x.p.s : f < 1 ? 'pozycji' : 'pozycję'} przy ${fmt.pct(x.pct)}`);
    hit = true;
  }
  if (!hit) return;
  if (sheetOpen('pos')) renderPositions();
  if (sheetOpen('wallet')) renderWallet();
  if (state.detail) renderDetail(state.detail);
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
    for (const r of rows) if (r?.p > 0) live.set(r.m, r);
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
    if (now - c.openedAt > ms) continue;
    pnl += c.pnl;
    cost += c.usd;
    trades++;
  }
  return { pnl, pct: cost > 0 ? (pnl / cost) * 100 : null, trades };
}

/** Profitable / losing demo positions: open ones by current P&L, closed trades (a position sold
 *  in parts counts once) by their total result. */
function winLoss(stat, list) {
  const open = { win: 0, loss: 0 };
  for (const x of stat) {
    if (x.pct == null || Math.abs(x.pct) < 1e-9) continue;
    open[x.pct > 0 ? 'win' : 'loss']++;
  }
  const trades = new Map();
  for (const c of state.closed) {
    const k = `${c.m}:${c.openedAt}`;
    trades.set(k, (trades.get(k) ?? 0) + (c.usd > 0 ? c.pnl : c.pct));
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
            </div>
            ${x.p.usd > 0 ? sellRow('data-pos-sell') : '<div class="qs-row"><button data-pos-sell="100">✖ Zamknij</button></div>'}
            ${exitRows(x.p, 'data-pos-exit')}
            <div class="pos-acts"><button data-pos-open>Otwórz token</button></div>
          </div>`;
        })
        .join('')
    : '<div class="empty"><b>Brak otwartych pozycji DEMO</b>Otwórz token z listy i w karcie „Pozycja DEMO” wpisz kwotę oraz MC wejścia.</div>';
  const recent = state.closed.filter((c) => Date.now() - c.closedAt < 30 * 86400e3).slice(0, 20);
  const history = recent.length
    ? `<h3 class="pos-h">Zamknięte (30 dni)</h3><div class="pos-closed">${recent
        .map((c) => `<div><span>${esc(c.n || fmt.short(c.m))} <small>${c.sl ? '🛑 SL · ' : c.tp ? '🎯 TP · ' : c.be ? '🛡️ BE · ' : ''}$${esc(c.s || '?')}${c.f && c.f < 1 ? ` · ${Math.round(c.f * 100)}%` : ''} · ${fmt.ago(c.closedAt)}</small></span><b class="${c.pct >= 0 ? 'up' : 'down'}">${fmt.pct(c.pct)}${c.usd > 0 ? ` · ${money(c.pnl)}` : ''}</b></div>`)
        .join('')}</div>`
    : '';
  const html = summary + `<h3 class="pos-h">Otwarte (${list.length})</h3>` + cards + history;
  if (body.dataset.html !== html) {
    body.dataset.html = html;
    body.innerHTML = html;
  }
}

// ---------- demo wallet screen ----------
function renderWallet() {
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
        ? tx.map((t) => `<div><span>${TX[t.type]?.[0] || '•'} ${TX[t.type]?.[1] || t.type}${t.s ? ` <small>$${esc(t.s)}</small>` : ''} <small>· ${fmt.ago(t.t)}</small></span><b class="${t.type === 'open' ? 'down' : t.type === 'reset' ? '' : 'up'}">${t.type === 'open' ? '−' : t.type === 'reset' ? '' : '+'}${fmt.usd(t.amount)}${t.pnl != null ? ` <small class="${t.pnl >= 0 ? 'up' : 'down'}">(${sign(t.pnl)}${fmt.usd(Math.abs(t.pnl))})</small>` : ''}</b></div>`).join('')
        : '<div><span class="muted">Brak operacji — doładuj wallet, żeby zacząć grać pozycjami DEMO.</span></div>'
    }</div>`;
  const body = $('#walletBody');
  if (!body.querySelector('#wCard')) {
    body.innerHTML = `<div id="wCard"></div>${form}<div id="wHist"></div>
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
  put('#wHist', hist);
}

const SHEETS = { pos: ['#posSheet', renderPositions], wallet: ['#walletSheet', renderWallet] };
// While a finger is on a sheet, live re-renders wait: replacing a button mid-tap loses the tap
// on iOS Safari.
let sheetTouch = 0;
for (const sel of ['#posSheet', '#walletSheet']) {
  $(sel).addEventListener('touchstart', () => (sheetTouch = Date.now() + 60_000), { passive: true });
  for (const ev of ['touchend', 'touchcancel']) $(sel).addEventListener(ev, () => (sheetTouch = Date.now() + 400), { passive: true });
}
const sheetBusy = () => Date.now() < sheetTouch;
function openSheet(name) {
  for (const [k, [sel]] of Object.entries(SHEETS)) $(sel).hidden = k !== name;
  document.body.classList.add('sheet-open');
  $$('#bottombar button').forEach((b) => b.classList.toggle('on', b.dataset.nav === name));
  SHEETS[name][1]();
  $(SHEETS[name][0]).scrollTop = 0;
}
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
// Small marks before a token's name: the network on EVM chains, the launchpad on Solana.
// Simplified badges in each platform's colours (not the official artwork).
const LAUNCHPADS = [
  [/pump/, 'pump.fun', '<rect x="3" y="8" width="18" height="8" rx="4" fill="#fff"/><path d="M12 8h5a4 4 0 0 1 0 8h-5z" fill="#5FCB86"/>', '#1b2a22'],
  [/bonk/, 'bonk.fun', '<circle cx="12" cy="12" r="9" fill="#F7931A"/><path d="M8.5 9.5h4.2a2 2 0 0 1 0 4H8.5zM8.5 13.5h4.8a2 2 0 0 1 0 4H8.5z" fill="none" stroke="#fff" stroke-width="1.6"/>'],
  [/launchlab|raydium/, 'Raydium LaunchLab', '<circle cx="12" cy="12" r="9" fill="#6A3CE0"/><path d="M12 5.5 17.6 8.7v6.6L12 18.5 6.4 15.3V8.7z" fill="none" stroke="#5CE1E6" stroke-width="1.6"/>'],
  [/met|dbc|meteora/, 'Meteora', '<circle cx="12" cy="12" r="9" fill="#1d1430"/><path d="M6 16 10 7l3 6 2-3 3 6" fill="none" stroke="#FF6B2C" stroke-width="2" stroke-linejoin="round"/>'],
  [/bags/, 'Bags', '<circle cx="12" cy="12" r="9" fill="#02C076"/><path d="M8 10h8l-1 7H9zM10 10a2 2 0 0 1 4 0" fill="none" stroke="#fff" stroke-width="1.6"/>'],
  [/believe/, 'Believe', '<circle cx="12" cy="12" r="9" fill="#fff"/><path d="M9 7v10h4a2.5 2.5 0 0 0 0-5H9m0 0h3.5a2.5 2.5 0 0 0 0-5H9" fill="none" stroke="#111" stroke-width="1.8"/>'],
  [/moon/, 'Moonshot', '<circle cx="12" cy="12" r="9" fill="#2a2140"/><path d="M14.5 6.5a6 6 0 1 0 3 8.5 5 5 0 0 1-3-8.5z" fill="#FFD84D"/>'],
  [/jup|studio/, 'Jupiter Studio', '<circle cx="12" cy="12" r="9" fill="#0e1a20"/><path d="M6 10c4-3 9-3 12 0M5.5 13.5c4.5-2.5 9.5-2.5 13 0M7 17c3-1.8 7-1.8 10 0" fill="none" stroke="#C7F284" stroke-width="1.6" stroke-linecap="round"/>'],
  [/heaven/, 'Heaven', '<circle cx="12" cy="12" r="9" fill="#f4f1e8"/><ellipse cx="12" cy="8" rx="5" ry="1.8" fill="none" stroke="#E0B341" stroke-width="1.5"/><path d="M12 11v7" stroke="#E0B341" stroke-width="1.8"/>'],
  [/boop/, 'boop.fun', '<circle cx="12" cy="12" r="9" fill="#FF5FA2"/><circle cx="12" cy="13" r="3.2" fill="#fff"/>'],
  [/stonk/, 'Stonk.fun', '<circle cx="12" cy="12" r="9" fill="#0f2a1a"/><path d="M6 16l4-4 3 2 5-6" fill="none" stroke="#3CF07A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'],
  [/metadao/, 'MetaDAO', '<circle cx="12" cy="12" r="9" fill="#111"/><path d="M7 16V8l5 5 5-5v8" fill="none" stroke="#fff" stroke-width="1.8"/>'],
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
}

/** Watchlist count for the network on screen (addresses are per network). */
function renderWatchCount() {
  const evm = chainCfg().evm;
  const n = [...state.watch].filter((m) => (evm ? /^0x[0-9a-fA-F]{40}$/.test(m) : !m.startsWith('0x'))).length;
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
const FEED_IC = { launch: '✨', whale: '🐋', migrate: '🎓', spike: '🔥', x: '𝕏', surge: '🚀', ai: '🤖' };
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
  if (state.watch.has(mint)) state.watch.delete(mint);
  else state.watch.add(mint);
  LS.set('watch', [...state.watch]);
  renderWatchCount();
  toast(state.watch.has(mint) ? '★ Dodano do obserwowanych' : 'Usunięto z obserwowanych');
  const star = state.rows.get(mint)?.el.querySelector('.star');
  if (star) {
    star.classList.toggle('on', state.watch.has(mint));
    star.textContent = state.watch.has(mint) ? '★' : '☆';
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
async function openDetail(mint, push = true) {
  state.selected = mint;
  state.detail = null;
  state.chartTab = STATIC ? 'hype' : 'dex';
  state.detailLayout = null;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  document.body.style.overflow = 'hidden';
  const known = state.rows.get(mint)?.data;
  $('#drawerBody').innerHTML = known ? detailSkeleton(known) : '<div class="empty"><b>Ładowanie…</b></div>';
  if (push) history.replaceState(null, '', `#t=${ENGINE ? `${ENGINE.chain}:` : ''}${mint}`);
  clearInterval(detailTimer);
  await loadDetail(mint);
  // Closed or switched to another token while loading: don't leave a poller behind.
  if (state.selected !== mint) return;
  clearInterval(detailTimer);
  detailTimer = setInterval(() => loadDetail(mint), 4000);
}

function closeDetail() {
  state.selected = null;
  clearInterval(detailTimer);
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
      $('#drawerBody').innerHTML = '<div class="empty"><b>Nie znaleziono tokena</b></div>';
      clearInterval(detailTimer);
      return;
    }
    state.detail = d;
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
  const watched = state.watch.has(d.m);
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
    d.socials?.twitter ? ['𝕏 projektu', d.socials.twitter] : null,
    d.socials?.telegram ? ['Telegram', d.socials.telegram] : null,
    d.socials?.website ? ['Strona', d.socials.website] : null,
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
      <p class="note" style="margin:8px 0">…albo wpisz własną kwotę i MC wejścia:</p>
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
    risk: `<div class="card"><h3>Bezpieczeństwo <small>${RISK_TXT[d.risk?.level] || ''}</small></h3><div class="flags">${flags}</div></div>`,
    x: `<div class="card"><h3>𝕏 — ostatnia godzina ${x?.lastPoll ? `<small>aktualizacja ${fmt.ago(x.lastPoll)} temu</small>` : ''}</h3>
        ${x ? `<div class="kv" style="margin-bottom:12px">
          <div><span>Wzmianki / 1h</span><b>${x.mentions1h}${x.capped ? '+' : ''}</b></div>
          <div><span>Unikalni autorzy</span><b>${fmt.n(x.authors)}</b></div>
          <div><span>Zaangażowanie</span><b>${fmt.n(x.engagement)}</b></div>
          <div><span>Zasięg (obs.)</span><b>${fmt.n(x.reach)}</b></div></div>` : ''}
        <div class="tweets">${tweets}</div></div>`,
    trades: `<div class="card"><h3>Transakcje na żywo <small>strumień on-chain</small></h3>${trades}</div>`,
    desc: d.description ? `<div class="card"><h3>Opis</h3><p class="desc">${esc(d.description)}</p></div>` : '',
  };

  const layoutKey = `${d.m}|${hasPair}`;
  if (state.detailLayout !== layoutKey) {
    // First render for this token (or its DEX pair just appeared): build the whole drawer.
    state.detailLayout = layoutKey;
    state.detailHtml = { ...sections };
    state.chartHist = null;
    const sec = (k) => `<div data-sec="${k}">${sections[k]}</div>`;
    body.innerHTML = `${sec('head')}${sec('pos')}${sec('holders')}${sec('ai')}${sec('grid')}
    <div class="d-stack">
      <div class="card"><h3>Wykres <span class="chart-tabs">
          ${hasPair ? `<button data-chart="dex" class="${chartTab === 'dex' ? 'active' : ''}">Cena (DexScreener)</button>` : ''}
          <button data-chart="hype" class="${chartTab === 'hype' ? 'active' : ''}">Hype i cena (radar)</button></span></h3>
        <div class="chart-box" id="chartBox"></div></div>
      ${sec('market')}${sec('risk')}${sec('x')}${sec('trades')}${sec('desc')}
    </div>`;
    renderChart(d, chartTab);
    $('#drawer').scrollTop = 0;
    return;
  }

  for (const [k, html] of Object.entries(sections)) {
    if (state.detailHtml[k] === html) continue;
    state.detailHtml[k] = html;
    const el = body.querySelector(`[data-sec="${k}"]`);
    if (el) el.innerHTML = html;
  }
  // Our own hype/price chart redraws only when a new history point arrives; the DexScreener
  // iframe is left alone and updates itself.
  if (chartTab === 'hype') renderChart(d, 'hype');
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

// ---------- filter presets ----------
const BUILTIN_PRESETS = [
  { name: '🛡 Bezpieczne', f: { maxDev: 5, minLp: 90, paid: true, safe: true } },
  { name: '🌱 Świeże (do 6 h)', f: { maxAgeH: 6, minMcap: 10000 } },
  { name: '🐳 Duże (MC od $1M)', f: { minMcap: 1000000, minLiq: 50000 } },
];
const EMPTY_FILTERS = { minMcap: 0, minLiq: 0, maxAgeH: 0, safe: false, maxDev: 0, minLp: 0, paid: false };

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
  for (const [id, key] of [['#fMcap', 'minMcap'], ['#fLiq', 'minLiq'], ['#fAge', 'maxAgeH'], ['#fDev', 'maxDev'], ['#fLp', 'minLp']]) $(id).value = String(state.filters[key] || 0);
  $('#fSafe').checked = !!state.filters.safe;
  $('#fPaid').checked = !!state.filters.paid;
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
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') closeDetail();
  else if (act === 'copy' && state.selected) copy(state.selected);
  else if (act === 'watch' && state.selected) toggleWatch(state.selected);
  else if (act === 'analyze' && state.selected) requestAnalysis(state.selected);
  else if (act === 'hide' && state.selected) hideToken(state.selected);
  else if (act === 'wallet-open') {
    closeDetail();
    openSheet('wallet');
  }
  else if (act === 'block' && state.detail?.creator) blockCreator(state.detail.creator);
  else if (act === 'pos-add' && state.selected && state.detail) {
    const d = state.detail;
    const usd = Number($('#posUsd')?.value) || 0;
    if (!(usd > 0)) return toast('Wpisz kwotę pozycji w $');
    if (usd > state.wallet.cash + 1e-9) {
      toast(`Za mało środków w walletcie DEMO (saldo ${fmt.usd(state.wallet.cash)}) — doładuj go`);
      closeDetail();
      return openSheet('wallet');
    }
    const raw = ($('#posEntry')?.value || '').trim();
    // Entry given as market cap (easier than long prices): price scales with market cap.
    const mc = raw ? parseAmount(raw) : d.mc;
    if (raw && !(mc > 0)) return toast('Nie rozumiem MC — wpisz np. 150k albo 1.2m');
    if (!(d.p > 0) || !(d.mc > 0)) return toast('Brak ceny lub MC — spróbuj za chwilę');
    const entry = d.p * (mc / d.mc);
    savePosition(state.selected, entry, usd, mc, d);
    toast(`💼 Pozycja DEMO otwarta przy MC ${fmt.usd(mc)}`);
    renderDetail(state.detail);
  } else if (act === 'qbuy') {
    quickBuy(Number(e.target.closest('[data-usd]').dataset.usd));
  } else if (act === 'qbuy-edit') {
    editQuickBuy();
  }
  const ex = e.target.closest('[data-exit]');
  if (ex && state.selected) {
    exitClick(state.selected, ex.dataset.exit);
    if (state.detail) renderDetail(state.detail);
  }
  const sell = e.target.closest('[data-sell]');
  if (sell && state.selected) {
    const f = Number(sell.dataset.sell) / 100;
    sellPosition(state.selected, f, state.detail?.p);
    toast(f >= 1 ? 'Pozycja DEMO zamknięta' : `Sprzedano ${Math.round(f * 100)}% pozycji DEMO`);
    if (state.detail) renderDetail(state.detail);
  }
  const chart = e.target.closest('[data-chart]');
  if (chart && state.detail) {
    state.chartTab = chart.dataset.chart;
    $$('[data-chart]').forEach((b) => b.classList.toggle('active', b === chart));
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
      toast('Nowa wersja aplikacji — odświeżam…');
      setTimeout(() => location.reload(), 1200);
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
$('#walletSheet').addEventListener('click', (e) => {
  if (e.target.closest('[data-sheet-close]')) return closeSheets();
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
$('#posSheet').addEventListener('click', (e) => {
  if (e.target.closest('[data-sheet-close]')) return closeSheets();
  if (e.target.closest('[data-sheet-wallet]')) return openSheet('wallet');
  const card = e.target.closest('[data-pos]');
  if (!card) return;
  const mint = card.dataset.pos;
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
    sellPosition(mint, f, x?.r?.p || x?.p.last?.p);
    // Instant (no confirmation — timing matters); a position on another network sells at the
    // last price seen there.
    const what = f >= 1 ? 'Pozycja DEMO zamknięta' : `Sprzedano ${Math.round(f * 100)}% pozycji DEMO`;
    toast(x?.stale ? `${what} po ostatniej znanej cenie (sprzed ${lastAt ? fmt.ago(lastAt) : '—'})` : what);
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
// Deep link: #t=<network>:<address> (older links: #t=<solana address>).
const deep = location.hash.match(/^#t=(?:(\w+):)?([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$/);
if (deep) {
  const net = deep[1] || (deep[2].startsWith('0x') ? null : 'solana');
  if (ENGINE && net && ENGINE.chains[net]) setChain(net);
  openDetail(deep[2].startsWith('0x') ? deep[2].toLowerCase() : deep[2], false);
}
