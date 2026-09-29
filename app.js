// MemeRadar frontend — vanilla JS, no build step. Server pushes snapshots over SSE every 2s;
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

const state = {
  view: LS.get('view', 'hype'),
  filters: LS.get('filters', { minMcap: 0, minLiq: 0, maxAgeH: 0, safe: false }),
  watch: new Set(LS.get('watch', [])),
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
    const zeros = Math.floor(-Math.log10(p));
    const digits = Math.round(p * 10 ** (zeros + 4)).toString().replace(/0+$/, '') || '0';
    const z = String(zeros).split('').map((d) => SUB[d]).join(''); // 0.0₄12 = 0.000012
    return `$0.0${z}${digits}`;
  },
  pct(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    const s = a >= 10000 ? `${(v / 1000).toFixed(0)}K` : a >= 1000 ? `${(v / 1000).toFixed(1)}K` : a >= 100 ? v.toFixed(0) : v.toFixed(1);
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
 * Price points for a token's mini chart, oldest first, as [ageMs, price]. DexScreener's % changes
 * give where the price was 24 h / 6 h / 1 h / 5 min ago (so a full chart shows immediately), and
 * our own samples (every ~15 s) fill in the last minutes. For a market younger than a window, that
 * window's change is taken as "since the pool opened".
 */
function priceSeries(d) {
  if (!(d.p > 0)) return [];
  const now = nowTs();
  const age = Math.max(MIN_MS, now - (d.ma || d.ca || now - 86400e3));
  const pts = [];
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
  const ph = (d.ph || []).filter((v) => v > 0);
  ph.forEach((v, i) => pts.push([(ph.length - 1 - i) * 15e3 + 1000, v]));
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

/** e.g. "👁 12m +340% · 4.4×" — null until there is something worth showing. */
function sinceSeen(d) {
  const base = seenBase(d);
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

// ---------- header ----------
function renderStats(s) {
  const items = [
    ['SOL', s.solPrice ? `$${s.solPrice.toFixed(2)}` : '—'],
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
  items.forEach(([, v], i) => {
    const b = el.children[i].firstElementChild;
    if (b.textContent !== v) b.textContent = v;
  });
  if (!STATIC) $('#demoBanner').hidden = !s.demo;
}

const SRC_LABEL = { pumpportal: 'pump.fun', dexscreener: 'DexScreener', jupiter: 'Jupiter', geckoterminal: 'Gecko', rugcheck: 'RugCheck', x: 'X', ai: 'AI' };
function renderSources(src) {
  const el = $('#sources');
  // Rebuild only when a source's state or message changes (not on every snapshot).
  const html = Object.entries(SRC_LABEL)
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

// ---------- podium ----------
function renderPodium(rows) {
  const el = $('#podium');
  if (state.view !== 'hype' || rows.length < 3) {
    el.innerHTML = '';
    return;
  }
  const top = rows.slice(0, 3);
  const key = top.map((r) => r.m).join();
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    el.innerHTML = top
      .map(
        (d, i) => `<article class="pcard" data-m="${d.m}">
        <span class="pc-medal">#${i + 1} HYPE</span>
        <div class="pc-top">
          ${avatar(d, 'lg')}
          <div class="pc-id"><b>${esc(d.n || d.s)}</b><small>$${esc(d.s)}</small></div>
          <div class="ring"><svg viewBox="0 0 70 70"><circle class="bg" cx="35" cy="35" r="30" fill="none" stroke-width="6"/>
            <circle class="fg" cx="35" cy="35" r="30" fill="none" stroke-width="6" stroke-dasharray="188.5" stroke-dashoffset="188.5"/></svg><b data-k="hs"></b></div>
        </div>
        <p class="pc-ai" data-k="ai" hidden></p>
        <div class="pc-spark"><svg class="spark big" viewBox="0 0 300 46" preserveAspectRatio="none" aria-label="Cena: ostatnie 24 h">
          <path class="sp-a" data-k="area"/><path class="sp-l" data-k="line" fill="none" stroke-width="2.2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><path class="sp-d" data-k="dot" fill="none" stroke-width="6" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg></div>
        <div class="pc-metrics">
          <div><span>MCap</span><b data-k="mc"></b></div>
          <div><span>1h</span><b data-k="c1"></b></div>
          <div><span>Wol. 1h</span><b data-k="v1"></b></div>
          <div><span>${d.x != null ? '𝕏 / 1h' : 'Holderzy'}</span><b data-k="x"></b></div>
        </div>
      </article>`,
      )
      .join('');
  }
  top.forEach((d, i) => {
    const card = el.children[i];
    const h = heat(d.hs);
    card.style.setProperty('--heat', h);
    const k = (n) => card.querySelector(`[data-k="${n}"]`);
    k('hs').textContent = d.hs.toFixed(0);
    card.querySelector('.fg').style.strokeDashoffset = String(188.5 * (1 - d.hs / 100));
    const mc = miniChart(d, 300, 46, 4);
    card.querySelector('.spark').classList.toggle('down', !!mc && !mc.up);
    k('line').setAttribute('d', mc ? mc.line : '');
    k('area').setAttribute('d', mc ? mc.area : '');
    k('dot').setAttribute('d', mc ? mc.dot : '');
    k('mc').textContent = fmt.usd(d.mc);
    k('c1').textContent = fmt.pct(d.c1);
    k('c1').className = cls(d.c1);
    k('v1').textContent = fmt.usd(d.v1);
    k('x').textContent = d.x != null ? `${d.x}${d.xc ? '+' : ''}` : fmt.n(d.h);
    const ai = k('ai');
    ai.hidden = !d.ai;
    if (d.ai && ai.textContent !== `🤖 ${d.ai}`) ai.textContent = `🤖 ${d.ai}`;
  });
}

// ---------- table ----------
function rowTemplate() {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = `
    <div class="c-rank"><span class="rank-n"></span><span class="rank-d"></span></div>
    <div class="c-token"><div class="tok"><span class="av-slot"></span><div class="tok-t">
      <div class="tok-name"><b></b><small></small></div><div class="tok-sub"></div></div></div></div>
    <div class="c-hype"><div class="hype"><span class="hype-n"></span><div class="hype-v"><div class="hype-bar"><i></i></div>
      <svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="Cena: ostatnie 24 h"><path class="sp-a"/><path class="sp-l" fill="none" stroke-width="1.8" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><path class="sp-d" fill="none" stroke-width="5" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg></div></div></div>
    <div class="c-price num"></div>
    <div class="c-ch c-5m num"><span class="pct"></span></div>
    <div class="c-ch c-1h num"><span class="pct"></span></div>
    <div class="c-ch c-24 num"><span class="pct"></span></div>
    <div class="c-mc num"></div>
    <div class="c-liq num"></div>
    <div class="c-vol num"></div>
    <div class="c-bs"><div class="bs"><div class="bs-bar"><span class="b"></span><span class="s"></span></div><div class="bs-n"><span class="up"></span><span class="lbl"></span><span class="down"></span></div></div></div>
    <div class="c-hold num hold"><b></b><small></small></div>
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
    rankN: $('.rank-n', el), rankD: $('.rank-d', el), av: $('.av-slot', el), name: $('.tok-name b', el), sym: $('.tok-name small', el),
    sub: $('.tok-sub', el), hs: $('.hype-n', el), hbar: $('.hype-bar i', el), sp: $('.sp-l', el), spA: $('.sp-a', el), spD: $('.sp-d', el), svg: $('.spark', el), price: $('.c-price', el),
    c5: $('.c-5m .pct', el), c1: $('.c-1h .pct', el), c24: $('.c-24 .pct', el), mc: $('.c-mc', el), liq: $('.c-liq', el),
    vol: $('.c-vol', el), bsB: $('.bs-bar .b', el), bsS: $('.bs-bar .s', el), bsNb: $('.bs-n .up', el), bsNs: $('.bs-n .down', el),
    bsL: $('.bs-n .lbl', el), quick: $('.c-quick', el), holdB: $('.hold b', el), holdS: $('.hold small', el), x: $('.c-x', el), risk: $('.risk', el), star: $('.star', el),
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
  const mc = miniChart(d, 100, 30);
  const key = mc ? mc.line : '';
  if (entry.spark !== key) {
    entry.spark = key;
    q.svg.classList.toggle('down', !!mc && !mc.up);
    q.sp.setAttribute('d', mc ? mc.line : '');
    q.spA.setAttribute('d', mc ? mc.area : '');
    q.spD.setAttribute('d', mc ? mc.dot : '');
  }

  setText(q.price, fmt.price(d.p), d.p, p.p);
  for (const [node, v] of [[q.c5, d.c5], [q.c1, d.c1], [q.c24, d.c24]]) {
    node.textContent = fmt.pct(v);
    node.className = `pct ${cls(v)}`;
  }
  setText(q.mc, fmt.usd(d.mc));
  setText(q.liq, fmt.usd(d.lq));
  setText(q.vol, fmt.usd(d.v1));

  // buy / sell pressure (5m, falls back to 1h when quiet)
  const use5 = d.b5 + d.s5 >= 6;
  const b = use5 ? d.b5 : d.b1;
  const s = use5 ? d.s5 : d.s1;
  q.bsB.style.flexGrow = b || (s ? 0 : 1);
  q.bsS.style.flexGrow = s || (b ? 0 : 1);
  q.bsNb.textContent = fmt.n(b);
  q.bsNs.textContent = fmt.n(s);
  q.bsL.textContent = use5 ? '5m' : '1h';

  // Compact line under the token for narrow screens, where these columns don't fit.
  const xPart = d.x != null
    ? `<a class="q-x" href="https://x.com/search?q=${encodeURIComponent(d.m)}&f=live" target="_blank" rel="noopener">𝕏 ${d.x}${d.xc ? '+' : ''} postów/h</a>`
    : `<a class="q-x" href="https://x.com/search?q=${encodeURIComponent(d.m)}&f=live" target="_blank" rel="noopener" title="Najnowsze posty z tym kontraktem na X">𝕏 ↗</a>`;
  const quick = sinceChip + `<span class="q-b" title="Kupna (${use5 ? '5 min' : '1 h'})">▲ ${fmt.n(b)}</span><span class="q-s" title="Sprzedaże (${use5 ? '5 min' : '1 h'})">▼ ${fmt.n(s)}</span><span class="q-l">${use5 ? '5m' : '1h'}</span>`
    + `<span class="q-kv"><i>MC</i> ${fmt.usd(d.mc)}</span><span class="q-kv"><i>Vol</i> ${fmt.usd(d.v1)}</span>${xPart}`;
  if (entry.quick !== quick) {
    q.quick.innerHTML = quick;
    entry.quick = quick;
  }

  setText(q.holdB, fmt.n(d.h));
  q.holdS.textContent = d.hg ? `${d.hg > 0 ? '+' : ''}${fmt.n(d.hg)}/h` : '';
  q.holdS.className = d.hg > 0 ? 'up' : d.hg < 0 ? 'down' : '';
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
  $('#tabs [data-view="graduated"]').lastChild.textContent = only ? 'Świeże graduacje' : 'Po graduacji';
  $('#feedChips [data-f="launch"]').hidden = only;
  if (only && (state.view === 'new' || state.view === 'graduating')) setView('graduated');
}

function applySnapshot(snap) {
  applyMode(snap.stats);
  $('#feedChips [data-f="whale"]').hidden = !snap.stats.liveTrades;
  renderStats(snap.stats);
  renderSources(snap.sources);
  $('#liveBadge').className = `live-badge${state.paused ? ' paused' : ''}`;
  $('#liveBadge').lastChild.textContent = STATIC ? 'MIGAWKA' : state.paused ? 'PAUZA' : 'LIVE';
  if (snap.view === 'hype') $('#c-hype').textContent = fmt.n(snap.stats.ranked);
  if (state.paused || snap.view !== state.view) return;
  if (state.firstSnapshot) $('#rows').innerHTML = '';
  renderPodium(renderRows(snap.rows));
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
      applySnapshot(ENGINE.snapshot(state.view, filters, 100, state.view === 'watch' ? [...state.watch] : []));
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

function setView(view) {
  state.view = view;
  LS.set('view', view);
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  for (const e of state.rows.values()) e.el.remove();
  state.rows.clear();
  state.prevRanks.clear();
  state.firstSnapshot = true;
  $('#podium').innerHTML = '';
  $('#podium').dataset.key = '';
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
  $('#c-watch').textContent = state.watch.size || '';
  toast(state.watch.has(mint) ? '★ Dodano do obserwowanych' : 'Usunięto z obserwowanych');
  const e = state.rows.get(mint);
  if (e) updateRow(e, e.data, 0);
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

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Skopiowano adres kontraktu');
  } catch {
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
  if (push) history.replaceState(null, '', `#t=${mint}`);
  clearInterval(detailTimer);
  await loadDetail(mint);
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
  const links = [
    d.dexUrl || d.pair ? ['DexScreener', d.dexUrl || `https://dexscreener.com/solana/${d.pair}`, true] : ['DexScreener', `https://dexscreener.com/solana/${d.m}`, true],
    ['Jupiter (kup)', `https://jup.ag/swap/SOL-${d.m}`],
    d.lp === 'pump' || d.m.endsWith('pump') ? ['pump.fun', `https://pump.fun/coin/${d.m}`] : null,
    ['Birdeye', `https://birdeye.so/token/${d.m}?chain=solana`],
    ['GMGN', `https://gmgn.ai/sol/token/${d.m}`],
    ['Solscan', `https://solscan.io/token/${d.m}`],
    ['RugCheck', `https://rugcheck.xyz/tokens/${d.m}`],
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
    ['Holderzy', `${fmt.n(d.h)} ${d.hg ? `<small class="${d.hg > 0 ? 'up' : 'down'}">${d.hg > 0 ? '+' : ''}${fmt.n(d.hg)}/h</small>` : ''}`],
    ['Wiek', d.ca ? fmt.ago(d.ca) : '—'],
    (() => {
      const s = sinceSeen(d);
      return ['Od kiedy go widzisz', s ? `<span class="${s.cls}">${fmt.pct(s.pct)} · ${fmtX(s.r)}</span> <small class="muted">${fmt.ago(s.t)}</small>` : '—'];
    })(),
    ['Zmiana 5m', `<span class="${cls(d.c5)}">${fmt.pct(d.c5)}</span>`],
    ['Zmiana 1h', `<span class="${cls(d.c1)}">${fmt.pct(d.c1)}</span>`],
    ['Zmiana 6h', `<span class="${cls(d.c6)}">${fmt.pct(d.c6)}</span>`],
    ['Zmiana 24h', `<span class="${cls(d.c24)}">${fmt.pct(d.c24)}</span>`],
    d.bp != null ? ['Bonding curve', `${d.bp.toFixed(1)}%`] : ['Status', d.gr ? '🎓 Na DEX' : d.dexId || '—'],
    ['Organic score', d.organicScore != null ? `${Math.round(d.organicScore)} ${d.organicLabel ? `<small class="muted">${esc(d.organicLabel)}</small>` : ''}` : '—'],
    ['Wybicie wolumenu 5m', d.vs ? `<span class="${d.vs >= 2 ? 'up' : ''}">${d.vs.toFixed(1)}×</span> <small class="muted">średniej</small>` : '—'],
    ['Pozycja w rankingu', d.rank ? `#${d.rank}` : '—'],
    ['DEX', esc(d.dexId || (d.bp != null ? 'bonding curve' : '—'))],
  ];

  const flags = d.risk?.flags?.length
    ? d.risk.flags.map((f) => `<div class="flag ${f.level}"><span>${f.level === 'danger' ? '⛔' : '⚠️'}</span><div><b>${esc(f.name)} ${f.value ? `<small>${esc(f.value)}</small>` : ''}</b>${f.desc ? `<small>${esc(f.desc)}</small>` : ''}</div></div>`).join('')
    : `<div class="flag ${d.risk?.level === 'ok' ? 'ok' : ''}"><span>${d.risk?.level === 'ok' ? '✅' : '❔'}</span><div><b>${RISK_TXT[d.risk?.level] || 'Nie sprawdzono'}</b><small>${d.risk?.level === 'ok' ? 'RugCheck / audyt Jupitera nie zgłaszają problemów.' : 'Raport bezpieczeństwa pojawi się, gdy token wejdzie do czołówki.'}</small></div></div>`;

  const x = d.x;
  const tweets = x?.tweets?.length
    ? x.tweets
        .map(
          (t) => `<a class="tweet" href="https://x.com/${encodeURIComponent(t.user || 'i')}/status/${encodeURIComponent(t.id)}" target="_blank" rel="noopener">
          <div class="tweet-h"><b>${esc(t.name || t.user)}</b><small>@${esc(t.user)} · ${fmt.ago(t.at)}</small><span class="fol">${fmt.n(t.followers)} obs.</span></div>
          <p>${esc(t.text)}</p><div class="tweet-m"><span>♥ ${fmt.n(t.likes)}</span><span>⟲ ${fmt.n(t.rts)}</span><span>💬 ${fmt.n(t.replies)}</span></div></a>`,
        )
        .join('')
    : `<p class="note">${x ? 'Brak postów w ostatniej godzinie.' : 'Dane z X pojawią się, gdy token wejdzie do top 60 (wymaga X_BEARER_TOKEN).'}</p>`;

  const trades = d.trades?.length
    ? `<table class="trades">${d.trades
        .slice(0, 25)
        .map((t) => `<tr><td class="side ${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? 'Kupno' : 'Sprzedaż'}</td><td class="mono">${fmt.sol(t.sol)}</td><td class="mono muted">${fmt.short(t.trader)}</td><td class="mono muted">${fmt.ago(t.t)}</td></tr>`)
        .join('')}</table>`
    : '<p class="note">Lista pojedynczych transakcji wymaga klucza PumpPortal (PUMPPORTAL_API_KEY). Liczby kupna/sprzedaży powyżej pochodzą z DexScreenera i odświeżają się co 15–60 s.</p>';

  const ranks = Object.entries(d.rankings || {});
  const hasPair = !!d.pair && !STATIC; // the preview frame cannot embed other sites
  const chartTab = hasPair ? state.chartTab : 'hype';

  // Sections are rebuilt only when their HTML actually changes, and the chart card is never
  // rebuilt on refresh — re-inserting the DexScreener iframe would reload the chart.
  const sections = {
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
    body.innerHTML = `${sec('head')}${sec('ai')}${sec('grid')}
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
    const src = `https://dexscreener.com/solana/${d.pair}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=5`;
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
  box.innerHTML = '<div class="sr-empty">Szukam na całej Solanie…</div>';
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

function togglePause() {
  state.paused = !state.paused;
  $('#pauseBtn').classList.toggle('on', state.paused);
  $('#pauseBtn .pi').textContent = state.paused ? '▶' : '❚❚';
  $('#pauseBtn .pl').textContent = state.paused ? 'Wznów' : 'Zamroź';
  toast(state.paused ? 'Tabela zamrożona — feed działa dalej' : 'Aktualizacje wznowione');
}
$('#pauseBtn').addEventListener('click', togglePause);

$('#rows').addEventListener('click', (e) => {
  const star = e.target.closest('.star');
  const row = e.target.closest('.row[data-m]');
  if (!row || e.target.closest('a')) return; // links (e.g. 𝕏 search) open on their own
  if (star) {
    e.stopPropagation();
    toggleWatch(row.dataset.m);
    return;
  }
  openDetail(row.dataset.m);
});
$('#podium').addEventListener('click', (e) => {
  const c = e.target.closest('.pcard');
  if (c) openDetail(c.dataset.m);
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
  if (typing) return;
  if (e.key === '/') {
    e.preventDefault();
    search.focus();
  } else if (e.key.toLowerCase() === 'p') togglePause();
});

// ---------- boot ----------
$('#c-watch').textContent = state.watch.size || '';
$$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
skeleton();
if (STATIC) {
  const when = new Date(STATIC.t).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' });
  const banner = $('#demoBanner');
  banner.innerHTML = `<b>Podgląd</b>: migawka prawdziwych danych z ${when} (DexScreener, pump.fun, Jupiter, RugCheck). Wersja odświeżana na żywo co 2 s działa po uruchomieniu serwera (<code>npm start</code>), za darmo.`;
  banner.hidden = false;
  document.body.classList.add('static');
}
connect();
const deep = location.hash.match(/^#t=([1-9A-HJ-NP-Za-km-z]{32,44})$/);
if (deep) openDetail(deep[1], false);
