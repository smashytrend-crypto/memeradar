// Wallet Tracker — what tracked Solana wallets (your own list + KOLs listed on kolscan.io) buy and
// sell, live. Free public Solana RPC: a WebSocket logsSubscribe per wallet tells the moment a
// wallet's transaction lands; the transaction is then read (getTransaction) and decoded as a
// swap (track-parse.js). When the WebSocket is unavailable it falls back to polling each wallet's
// latest signatures. Token names, icons and market caps come from Jupiter's Tokens API.

import { parseSwap, looksLikeSwap, sellPnl } from './track-parse.js?v=mv2oem6j';
import { KOLS } from './kols.js?v=mv2oem6j';

const RPCS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
const WSS = ['wss://solana-rpc.publicnode.com', 'wss://api.mainnet-beta.solana.com'];
const FEED_KEY = 'mr:trackFeed';
const SET_KEY = 'mr:trackSet';
const ACT_KEY = 'mr:trackAct';
const MAX_SUBS = 150;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DAY = 86_400_000;

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeImg = (u) => (/^https:\/\//i.test(u || '') ? u : '');
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
const ago = (t, now = Date.now()) => {
  if (!t) return '—';
  const s = Math.max(0, (now - t) / 1000);
  return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < DAY / 1000 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
const usd = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return `$${a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K` : a.toFixed(a >= 10 ? 0 : 2)}`;
};
const solFmt = (v) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3));
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function createTracker({ getWallets, addWallet, removeWallet, toast, solUsd, openToken, pushFeed, emojis = ['👛'] }) {
  const set = Object.assign({ on: true, kol: true, hide: true, days: 7, off: {}, side: 'all', who: 'all', min: 0, tab: 'live' }, ls.get(SET_KEY, {}) || {});
  const saveSet = () => ls.set(SET_KEY, set);
  const act = ls.get(ACT_KEY, {}) || {}; // address → { t: last trade seen on chain, at: when checked }
  const saveAct = () => ls.set(ACT_KEY, act);
  let feed = (ls.get(FEED_KEY, []) || []).filter((x) => x?.sig && x.w && Date.now() - x.t < 2 * DAY);
  const seen = new Set(feed.map((x) => x.sig));
  const S = { subFail: new Map(), solPx: 0, txc: new Map(), pnlBusy: false, seedBudget: 60, ws: null, wsOk: false, wsFails: 0, wsIdx: 0, subs: new Map(), pending: new Map(), subOf: new Map(), lastMsg: 0, mode: 'ws', tokens: new Map(), tokQ: new Set(), dirty: true, polled: new Map(), lastSig: new Map() };

  // ---------- wallets ----------
  /** Everyone tracked: own wallets first (they win on duplicates), then the KOL list. */
  function universe() {
    const out = new Map();
    for (const w of getWallets() || []) if (SOL_RE.test(w.a)) out.set(w.a, { a: w.a, name: w.name, emoji: w.emoji || '👛', mine: true });
    if (set.kol) for (const k of KOLS) if (!out.has(k.wallet)) out.set(k.wallet, { a: k.wallet, name: k.name, emoji: '⭐', tw: k.twitter, kol: true });
    return [...out.values()];
  }
  const recentDays = (a) => (act[a]?.t ? (Date.now() - act[a].t) / DAY : null);
  /** Followed live: not switched off, and (own wallet, or a KOL active in the last N days / not checked yet). */
  function isLive(w) {
    if (set.off[w.a]) return false;
    if (w.mine || !set.hide) return true;
    const d = recentDays(w.a);
    return !(act[w.a]?.at && (d == null || d > set.days));
  }
  function liveList() {
    return universe()
      .filter(isLive)
      .sort((x, y) => (y.mine ? 1 : 0) - (x.mine ? 1 : 0) || (act[y.a]?.t || 0) - (act[x.a]?.t || 0))
      .slice(0, MAX_SUBS);
  }
  const byAddr = () => new Map(universe().map((w) => [w.a, w]));

  // ---------- RPC (queued, a few requests a second) ----------
  let rpcIdx = 0;
  const queue = [];
  let running = 0;
  function rpc(method, params, priority = false) {
    return new Promise((resolve, reject) => {
      const job = { method, params, resolve, reject };
      if (priority) queue.unshift(job);
      else queue.push(job);
      pump();
    });
  }
  let nextAt = 0;
  function pump() {
    if (!queue.length || running >= 2) return;
    const wait = nextAt - Date.now();
    if (wait > 0) return void setTimeout(pump, wait);
    nextAt = Date.now() + 220;
    const job = queue.shift();
    running++;
    call(job.method, job.params)
      .then(job.resolve, job.reject)
      .finally(() => {
        running--;
        pump();
      });
    pump();
  }
  async function call(method, params) {
    let err;
    for (let i = 0; i < RPCS.length; i++) {
      const url = RPCS[(rpcIdx + i) % RPCS.length];
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (j.error) throw new Error(j.error.message || 'RPC error');
        rpcIdx = (rpcIdx + i) % RPCS.length;
        return j.result;
      } catch (e) {
        err = e;
      }
    }
    throw err || new Error('RPC niedostępne');
  }

  // ---------- transactions → trades ----------
  const inflight = new Set();
  async function readTx(sig, wallet, tries = 0) {
    if (seen.has(sig) || (tries === 0 && inflight.has(sig))) return;
    inflight.add(sig);
    let tx;
    try {
      tx = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }], true);
    } catch {
      tx = undefined;
    }
    // Just landed: the node may not serve it yet.
    if (!tx) {
      if (tries < 3) setTimeout(() => readTx(sig, wallet, tries + 1), 1500 * (tries + 1));
      else inflight.delete(sig);
      return;
    }
    inflight.delete(sig);
    if (seen.has(sig)) return;
    seen.add(sig);
    const tr = parseSwap(tx, wallet);
    act[wallet] = { ...(act[wallet] || {}), t: Math.max(act[wallet]?.t || 0, tx.blockTime ? tx.blockTime * 1000 : 0), at: act[wallet]?.at || Date.now() };
    if (!tr) return;
    const item = { ...tr, w: wallet };
    feed.unshift(item);
    feed.sort((a, b) => b.t - a.t);
    if (feed.length > 400) feed.length = 400;
    ls.set(FEED_KEY, feed.slice(0, 300));
    saveAct();
    S.tokQ.add(tr.mint);
    S.dirty = true;
    const w = byAddr().get(wallet);
    // Fresh trades of your own wallets also go to the radar's live feed.
    if (w?.mine && Date.now() - tr.t < 5 * 60_000) {
      const name = S.tokens.get(tr.mint)?.s;
      pushFeed?.({ type: 'wallet', mint: tr.mint, at: tr.t, text: `${w.emoji} ${w.name}: ${tr.side === 'buy' ? 'kupił' : 'sprzedał'} ${name ? `$${name}` : short(tr.mint)} za ${solFmt(tr.sol || 0)} SOL` });
    }
  }

  // ---------- live: WebSocket logsSubscribe per wallet ----------
  let rid = 1;
  function wsConnect() {
    if (S.ws || !set.on || document.hidden) return;
    const url = WSS[S.wsIdx % WSS.length];
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      return wsFail();
    }
    S.ws = ws;
    S.subs.clear();
    S.pending.clear();
    S.subOf.clear();
    const timer = setTimeout(() => ws.readyState === 0 && ws.close(), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      S.lastMsg = Date.now();
      syncSubs();
    };
    ws.onmessage = (ev) => {
      S.lastMsg = Date.now();
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.id && S.pending.has(m.id)) {
        const a = S.pending.get(m.id);
        S.pending.delete(m.id);
        if (typeof m.result === 'number') {
          S.subs.set(a, m.result);
          S.subOf.set(m.result, a);
          S.wsOk = true;
          S.wsFails = 0;
          S.mode = 'ws';
          S.subFail.delete(a);
        } else {
          // Refused (often a subscription limit): back off for that wallet, longer each time.
          const f = S.subFail.get(a) || { n: 0 };
          f.n++;
          f.until = Date.now() + Math.min(30 * 60_000, 15_000 * 2 ** f.n);
          S.subFail.set(a, f);
        }
        return;
      }
      if (m.method === 'logsNotification') {
        const v = m.params?.result?.value;
        const a = S.subOf.get(m.params?.subscription);
        if (!a || !v?.signature || v.err || seen.has(v.signature)) return;
        if (looksLikeSwap(v.logs)) readTx(v.signature, a);
        else act[a] = { ...(act[a] || {}), t: Date.now(), at: act[a]?.at || Date.now() };
      }
    };
    ws.onclose = ws.onerror = () => {
      clearTimeout(timer);
      if (S.ws !== ws) return;
      S.ws = null;
      S.wsOk = false;
      S.subs.clear();
      S.subOf.clear();
      wsFail();
    };
  }
  function wsFail() {
    S.wsFails++;
    S.wsIdx++;
    // Neither WebSocket works here: poll the wallets instead.
    if (S.wsFails >= 4) S.mode = 'poll';
    S.dirty = true;
  }
  function syncSubs() {
    const ws = S.ws;
    if (!ws || ws.readyState !== 1) return;
    const want = new Set(liveList().map((w) => w.a));
    for (const a of want) {
      if (S.subs.has(a) || [...S.pending.values()].includes(a) || S.subFail.get(a)?.until > Date.now()) continue;
      const id = rid++;
      S.pending.set(id, a);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [a] }, { commitment: 'confirmed' }] }));
    }
    for (const [a, sub] of S.subs) {
      if (want.has(a)) continue;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: rid++, method: 'logsUnsubscribe', params: [sub] }));
      S.subs.delete(a);
      S.subOf.delete(sub);
    }
  }

  // ---------- activity checks + polling fallback ----------
  async function checkWallet(w, seed) {
    let sigs;
    try {
      sigs = await rpc('getSignaturesForAddress', [w.a, { limit: seed ? 10 : 5 }]);
    } catch {
      return;
    }
    const ok = (sigs || []).filter((s) => !s.err && s.blockTime);
    act[w.a] = { t: ok[0] ? ok[0].blockTime * 1000 : act[w.a]?.t || 0, at: Date.now() };
    saveAct();
    S.dirty = true;
    const last = S.lastSig.get(w.a);
    const fresh = [];
    for (const s of ok) {
      if (s.signature === last) break;
      fresh.push(s);
    }
    if (ok[0]) S.lastSig.set(w.a, ok[0].signature);
    // Seeding: the last few hours of trades; polling: whatever is new since the last look.
    // (the history fetched at start is capped: ~200 KOLs would flood the free RPC)
    const horizon = seed ? 6 * 3_600_000 : 30 * 60_000;
    const n = seed ? Math.min(w.mine ? 3 : 1, S.seedBudget) : 6;
    for (const s of fresh.slice(0, n)) {
      if (Date.now() - s.blockTime * 1000 >= horizon || seen.has(s.signature)) continue;
      if (seed) S.seedBudget--;
      readTx(s.signature, w.a);
    }
  }
  let checkTurn = 0;
  function background() {
    if (!set.on || document.hidden) return;
    const all = universe().filter((w) => !set.off[w.a]);
    // Activity: every wallet checked once per 30 min — own wallets first; at most ~1 request a second.
    const stale = all.filter((w) => Date.now() - (act[w.a]?.at || 0) > 30 * 60_000).sort((x, y) => (y.mine ? 1 : 0) - (x.mine ? 1 : 0));
    if (stale.length && queue.length < 3 && (checkTurn++ % (S.mode === 'poll' ? 2 : 1) === 0)) {
      const w = stale[0];
      act[w.a] = { ...(act[w.a] || {}), at: Date.now() - 29 * 60_000 }; // not twice at once
      checkWallet(w, !S.lastSig.has(w.a));
    }
    // Polling mode: each followed wallet in turn.
    if (S.mode === 'poll' && queue.length < 4) {
      const live = liveList();
      const w = live.sort((x, y) => (S.polled.get(x.a) || 0) - (S.polled.get(y.a) || 0))[0];
      if (w && Date.now() - (S.polled.get(w.a) || 0) > Math.max(15_000, live.length * 700)) {
        S.polled.set(w.a, Date.now());
        checkWallet(w, false);
      }
    }
  }

  // ---------- PnL of sells: the wallet's token-account history, average cost ----------
  async function swapOf(sig, wallet) {
    const k = `${sig}|${wallet}`;
    if (S.txc.has(k)) return S.txc.get(k);
    let tx = null;
    try {
      tx = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    } catch {
      return undefined; // try again later
    }
    const r = tx ? parseSwap(tx, wallet) : null;
    S.txc.set(k, r);
    if (S.txc.size > 3000) S.txc.delete(S.txc.keys().next().value);
    return r;
  }
  /** One sell at a time, the newest one on screen first. */
  async function pnlPass(list) {
    if (S.pnlBusy || queue.length > 4) return;
    const x = list.find((y) => y.side === 'sell' && y.acct && y.pnl === undefined && !(y.pnlTry > Date.now()));
    if (!x) return;
    S.pnlBusy = true;
    try {
      // Only what came before this sell, newest first as the node lists it.
      const sigs = (await rpc('getSignaturesForAddress', [x.acct, { before: x.sig, limit: 40 }])) || [];
      const before = sigs.filter((s) => !s.err).slice(0, 30);
      const trades = [];
      let missing = false;
      for (const s of before) {
        const r = await swapOf(s.signature, x.w);
        if (r === undefined) missing = true;
        else if (r && r.mint === x.mint) trades.push(r);
      }
      if (missing) {
        x.pnlTry = Date.now() + 30_000;
        return;
      }
      trades.reverse(); // oldest first, in on-chain order (same-second trades included)
      const res = sellPnl(trades, x, solUsdNow());
      const cut = sigs.length >= 40 || before.length >= 30; // the oldest buys may be further back
      x.pnl = res ? { ...res, partial: res.partial || cut } : null;
      ls.set(FEED_KEY, feed.slice(0, 300));
      S.dirty = true;
    } catch {
      x.pnlTry = Date.now() + 30_000;
    } finally {
      S.pnlBusy = false;
    }
  }

  /** $ per SOL: the radar's when it is on Solana, else Jupiter's (fetched with the token info). */
  const solUsdNow = () => solUsd() || S.solPx || 0;

  // ---------- token info (Jupiter, batched) ----------
  let tokBusy = false;
  async function loadTokens() {
    if (tokBusy) return;
    for (const x of feed.slice(0, 120)) if (!S.tokens.has(x.mint)) S.tokQ.add(x.mint);
    const mints = [...S.tokQ].filter((m) => !S.tokens.has(m) || Date.now() - S.tokens.get(m).at > 120_000).slice(0, 49);
    S.tokQ.clear();
    const WSOL = 'So11111111111111111111111111111111111111112';
    if (!solUsd() && Date.now() - (S.solPxAt || 0) > 60_000) mints.push(WSOL);
    if (!mints.length) return;
    tokBusy = true;
    try {
      const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mints.join(',')}`, { signal: AbortSignal.timeout(10_000) });
      const list = r.ok ? await r.json() : [];
      for (const j of list || []) {
        if (j.id === WSOL) {
          if (Number(j.usdPrice) > 0) (S.solPx = Number(j.usdPrice)), (S.solPxAt = Date.now());
          continue;
        }
        S.tokens.set(j.id, { s: j.symbol, n: j.name, i: safeImg(j.icon), mc: Number(j.mcap) || null, p: Number(j.usdPrice) || null, at: Date.now() });
      }
      for (const m of mints) if (!S.tokens.has(m)) S.tokens.set(m, { at: Date.now() });
      S.dirty = true;
    } catch {
      for (const m of mints) S.tokQ.add(m);
    } finally {
      tokBusy = false;
    }
  }

  // ---------- UI ----------
  const visible = () => !$('#trackSheet')?.hidden;
  const put = (el, html) => {
    if (!el || el.dataset.html === html) return;
    if (el.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
    el.dataset.html = html;
    el.innerHTML = html;
  };
  function statusHtml() {
    const live = liveList().length;
    const st = !set.on ? ['off', 'Wyłączony'] : S.mode === 'ws' && S.wsOk ? ['ok', `Na żywo · ${S.subs.size}/${live} portfeli`] : S.mode === 'poll' ? ['warn', `Odpytywanie co kilkanaście s · ${live} portfeli`] : ['warn', 'Łączenie z Solaną…'];
    return `<div class="tk-status ${st[0]}"><i></i><span>${st[1]}</span><button data-tk-on>${set.on ? 'Wyłącz' : 'Włącz'}</button></div>
      <div class="pf-seg tk-tabs"><button data-tk-tab="live" class="${set.tab === 'live' ? 'on' : ''}">Na żywo</button><button data-tk-tab="wallets" class="${set.tab === 'wallets' ? 'on' : ''}">Portfele <small>${universe().length}</small></button></div>`;
  }
  function tradeView(x, wmap, su) {
    const w = wmap.get(x.w) || { name: short(x.w), emoji: '👛' };
    const tk = S.tokens.get(x.mint) || {};
    const valUsd = (x.sol || 0) * su + (x.usd || 0);
    const pxUsd = x.tokens > 0 ? valUsd / x.tokens : null;
    const mcAt = pxUsd && tk.mc && tk.p ? pxUsd * (tk.mc / tk.p) : null;
    return { w, tk, valUsd, mcAt };
  }
  function clusterHtml(list, wmap, su) {
    const now = Date.now();
    const by = new Map();
    for (const x of list) {
      if (x.side !== 'buy' || now - x.t > 30 * 60_000) continue;
      const c = by.get(x.mint) || { mint: x.mint, ws: new Set(), sol: 0, last: 0 };
      c.ws.add(x.w);
      c.sol += x.sol || 0;
      c.last = Math.max(c.last, x.t);
      by.set(x.mint, c);
    }
    const hot = [...by.values()].filter((c) => c.ws.size >= 2).sort((a, b) => b.ws.size - a.ws.size || b.last - a.last).slice(0, 5);
    if (!hot.length) return '';
    return `<div class="card tk-hot"><h3>🔥 Wspólne kupna <small>≥2 portfele · 30 min</small></h3>${hot
      .map((c) => {
        const tk = S.tokens.get(c.mint) || {};
        const names = [...c.ws].map((a) => wmap.get(a)?.name || short(a));
        return `<button class="tk-hrow" data-tk-token="${esc(c.mint)}">${icon(tk, c.mint, 28)}<span><b>${esc(tk.s || short(c.mint))}</b><small>${esc(names.slice(0, 3).join(', '))}${names.length > 3 ? ` +${names.length - 3}` : ''}</small></span><span class="tk-hn">${c.ws.size} 👛<small>${solFmt(c.sol)} SOL · ${usd(c.sol * su)}</small></span></button>`;
      })
      .join('')}</div>`;
  }
  const icon = (tk, mint, size) => `<span class="tk-ic" style="width:${size}px;height:${size}px">${tk.i ? `<img src="${esc(tk.i)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<b>${esc((tk.s || mint).slice(0, 1).toUpperCase())}</b></span>`;
  /** Realised PnL of a sell in $ (and %); ≈ when part of the bag's buys wasn't found. */
  function pnlHtml(x, su) {
    if (!x.acct) return '';
    if (x.pnl === undefined) return '<span class="tk-pnl muted">PnL…</span>';
    if (!x.pnl) return '<span class="tk-pnl muted" title="Nie znaleziono kupna tego tokena (np. przelew)">PnL ?</span>';
    const v = x.pnl.sol * (su || 0);
    const sign = x.pnl.sol >= 0 ? '+' : '−';
    return `<span class="tk-pnl ${x.pnl.sol >= 0 ? 'up' : 'down'}">${x.pnl.partial ? '≈' : ''}PnL ${su ? `${sign}${usd(Math.abs(v)).slice(0)}` : `${x.pnl.sol >= 0 ? '+' : '−'}${solFmt(Math.abs(x.pnl.sol))} SOL`} <small>(${x.pnl.pct >= 0 ? '+' : '−'}${Math.abs(x.pnl.pct).toFixed(0)}%)</small></span>`;
  }
  function liveHtml() {
    const wmap = byAddr();
    const su = solUsdNow();
    const now = Date.now();
    const list = feed.filter((x) => {
      const w = wmap.get(x.w);
      if (!w || set.off[x.w]) return false;
      if (set.side !== 'all' && x.side !== set.side) return false;
      if (set.who === 'kol' && !w.kol) return false;
      if (set.who === 'mine' && !w.mine) return false;
      if (set.min && (x.sol || 0) + (su ? (x.usd || 0) / su : 0) < set.min) return false;
      return true;
    });
    const chip = (attr, v, cur, label) => `<button data-${attr}="${v}" class="${String(cur) === String(v) ? 'active' : ''}">${label}</button>`;
    const filters = `<div class="chips tk-f">${chip('tk-side', 'all', set.side, 'Wszystko')}${chip('tk-side', 'buy', set.side, '🟢 Kupna')}${chip('tk-side', 'sell', set.side, '🔴 Sprzedaże')}</div>
      <div class="chips tk-f">${chip('tk-who', 'all', set.who, 'Wszyscy')}${chip('tk-who', 'kol', set.who, '⭐ KOL')}${chip('tk-who', 'mine', set.who, '👛 Moje')}<span class="tk-sep"></span>${[0, 0.5, 1, 5].map((v) => chip('tk-min', v, set.min, v ? `≥${v} SOL` : 'Każda kwota')).join('')}</div>`;
    S.shown = list.slice(0, 40);
    const rows = list
      .slice(0, 150)
      .map((x) => {
        const { w, tk, valUsd, mcAt } = tradeView(x, wmap, su);
        return `<div class="tk-row ${x.side}">
          <button class="tk-tok" data-tk-token="${esc(x.mint)}">${icon(tk, x.mint, 34)}</button>
          <div class="tk-main">
            <div class="tk-l1"><span class="tk-w">${esc(w.emoji)} ${esc(w.name)}</span><b class="tk-side">${x.side === 'buy' ? 'KUPIŁ' : 'SPRZEDAŁ'}</b><button class="tk-sym" data-tk-token="${esc(x.mint)}">${esc(tk.s || short(x.mint))}</button></div>
            <div class="tk-l2"><b>${x.sol ? `${solFmt(x.sol)} SOL` : usd(x.usd)}</b><span>${su ? usd(valUsd) : ''}</span>${mcAt ? `<span>MC ${usd(mcAt)}</span>` : ''}${x.side === 'sell' ? pnlHtml(x, su) : ''}</div>
          </div>
          <div class="tk-r"><small>${ago(x.t, now)}</small><a href="https://solscan.io/tx/${esc(x.sig)}" target="_blank" rel="noopener">tx ↗</a></div>
        </div>`;
      })
      .join('');
    const empty = !set.on
      ? '<div class="empty"><b>Tracker wyłączony</b>Włącz go przyciskiem u góry.</div>'
      : `<div class="empty"><b>Czekam na transakcje…</b>${universe().length ? 'Pojawią się tu, gdy śledzone portfele kupią lub sprzedadzą token.' : 'Dodaj portfele w zakładce „Portfele” albo włącz listę KOL-i.'}</div>`;
    return filters + clusterHtml(list, wmap, su) + (rows ? `<div class="tk-feed">${rows}</div>` : empty);
  }
  function walletsHtml() {
    const all = universe();
    const now = Date.now();
    const row = (w) => {
      const a = act[w.a];
      const d = recentDays(w.a);
      const on = !set.off[w.a];
      const live = isLive(w);
      const status = !a?.at ? '<i class="muted">sprawdzam…</i>' : !a.t ? '<i class="down">brak transakcji</i>' : d <= set.days ? `<i class="up">aktywny ${ago(a.t, now)} temu</i>` : `<i class="down">nieaktywny ${Math.floor(d)} dni</i>`;
      const n24 = feed.filter((x) => x.w === w.a && now - x.t < DAY).length;
      return `<div class="tk-wrow${live ? '' : ' dim'}">
        <span class="tk-we">${esc(w.emoji)}</span>
        <div class="tk-wn"><b>${esc(w.name)}${w.kol ? ' <span class="chip tk-kol">KOL</span>' : ''}</b>
          <small>${w.tw ? `<a href="https://x.com/${esc(String(w.tw).replace(/^@/, ''))}" target="_blank" rel="noopener">@${esc(String(w.tw).replace(/^@/, ''))}</a> · ` : ''}<button class="tk-copy" data-tk-copy="${esc(w.a)}">${esc(short(w.a))}</button> · ${status}${n24 ? ` · ${n24} tx/24h` : ''}</small></div>
        <button class="tk-tg ${on ? 'on' : ''}" data-tk-toggle="${esc(w.a)}" aria-label="Śledź / nie śledź">${on ? 'ON' : 'OFF'}</button>
        ${w.mine ? `<button class="tk-del" data-tk-del="${esc(w.a)}" aria-label="Usuń">✕</button>` : ''}
      </div>`;
    };
    const mine = all.filter((w) => w.mine);
    const kols = all.filter((w) => w.kol).sort((x, y) => (act[y.a]?.t || 0) - (act[x.a]?.t || 0));
    return `<div class="card tk-add"><h3>➕ Dodaj portfel <small>Solana</small></h3>
        <div class="tk-form"><input id="tkAddr" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Adres portfela" />
        <input id="tkName" type="text" autocomplete="off" placeholder="Nazwa" /><select id="tkEmoji">${emojis.map((e) => `<option>${e}</option>`).join('')}</select>
        <button data-tk-add>Śledź</button></div></div>
      <h3 class="pos-h">Moje portfele (${mine.length})</h3>${mine.map(row).join('') || '<p class="note">Brak — dodaj adres powyżej.</p>'}
      <div class="tk-kolhead"><h3 class="pos-h">⭐ KOL-e z kolscan.io (${KOLS.length})</h3><button class="tk-tg ${set.kol ? 'on' : ''}" data-tk-kol>${set.kol ? 'ON' : 'OFF'}</button></div>
      <label class="toggle-row"><input type="checkbox" data-tk-hide ${set.hide ? 'checked' : ''} /> <span>Śledź tylko aktywnych KOL-i (transakcja w ostatnich ${set.days} dniach)</span></label>
      ${set.kol ? kols.map(row).join('') || '<p class="note">Lista KOL-i jest pusta.</p>' : '<p class="note">Lista KOL-i wyłączona.</p>'}
      <p class="note">Aktywność sprawdzana na łańcuchu co 30 min. Lista KOL-i: publicznie podane portfele z kolscan.io — mogą się zmienić, a KOL może handlować też z innych portfeli.</p>`;
  }
  function render() {
    const body = $('#trackBody');
    if (!body) return;
    if (!body.querySelector('#tkHead')) body.innerHTML = '<div id="tkHead"></div><div id="tkBody"></div>';
    put($('#tkHead'), statusHtml());
    put($('#tkBody'), set.tab === 'wallets' ? walletsHtml() : liveHtml());
  }

  // ---------- events ----------
  function onClick(e) {
    const b = e.target.closest('button, a');
    if (!b || b.tagName === 'A') return;
    const d = b.dataset;
    if (d.tkTab) set.tab = d.tkTab;
    else if (d.tkOn !== undefined) {
      set.on = !set.on;
      if (!set.on && S.ws) S.ws.close();
    } else if (d.tkSide) set.side = d.tkSide;
    else if (d.tkWho) set.who = d.tkWho;
    else if (d.tkMin) set.min = Number(d.tkMin);
    else if (d.tkToken) return openToken?.(d.tkToken);
    else if (d.tkToggle) {
      if (set.off[d.tkToggle]) delete set.off[d.tkToggle];
      else set.off[d.tkToggle] = true;
    } else if (d.tkKol !== undefined) set.kol = !set.kol;
    else if (d.tkDel) {
      removeWallet(d.tkDel);
      toast('Przestałem śledzić portfel');
    } else if (d.tkAdd !== undefined) {
      const a = String($('#tkAddr')?.value || '').trim();
      if (!SOL_RE.test(a)) return toast('Podaj adres portfela Solana');
      addWallet(a, $('#tkName')?.value, $('#tkEmoji')?.value || '👛');
      $('#tkAddr').value = '';
      $('#tkName').value = '';
      document.activeElement?.blur?.();
    } else if (d.tkCopy) {
      navigator.clipboard?.writeText(d.tkCopy).then(() => toast('Skopiowano adres'), () => toast(d.tkCopy));
      return;
    } else return;
    saveSet();
    S.dirty = true;
    syncSubs();
    render();
  }
  function onChange(e) {
    if (e.target.dataset.tkHide !== undefined) {
      set.hide = e.target.checked;
      saveSet();
      syncSubs();
      S.dirty = true;
      render();
    }
  }
  $('#trackSheet')?.addEventListener('click', onClick);
  $('#trackSheet')?.addEventListener('change', onChange);
  let touchUntil = 0;
  $('#trackSheet')?.addEventListener('touchstart', () => (touchUntil = Date.now() + 60_000), { passive: true });
  document.addEventListener('touchend', () => touchUntil > Date.now() + 400 && (touchUntil = Date.now() + 400), { passive: true, capture: true });

  // ---------- loop ----------
  let tick = 0;
  setInterval(() => {
    tick++;
    if (set.on && !document.hidden) {
      if (S.mode === 'ws' || tick % 60 === 0) wsConnect(); // poll mode retries the socket once a minute
      if (S.ws && S.ws.readyState === 1 && tick % 5 === 0) syncSubs();
      // A socket that went silent for 3 minutes with many wallets: reconnect.
      if (S.ws && S.wsOk && Date.now() - S.lastMsg > 180_000 && S.subs.size > 20) S.ws.close();
      background();
      if (tick % 2 === 0) loadTokens();
      if (visible() && set.tab === 'live' && S.shown) pnlPass(S.shown);
    }
    if (visible() && Date.now() >= touchUntil && (S.dirty || tick % 5 === 0)) {
      S.dirty = false;
      render();
    }
  }, 1_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wsConnect();
  });

  return {
    render() {
      S.dirty = true;
      render();
    },
    walletsChanged() {
      syncSubs();
      S.dirty = true;
    },
  };
}
