// Real trades on Solana: Jupiter swaps signed by the vault. Nothing is signed unless it is provably
// the swap that was asked for (solana.js checkSwapTx): we are its only signer and fee payer; every
// instruction is a harmless swap step; the swap moves exactly the amount asked from our own token
// account to our own token account (addresses derived here, not taken from the API) with no fee and
// no more slippage than set. A simulation on a Solana node must then show the tokens / SOL arriving
// on our account. Sent, re-sent until confirmed, and the real fill read back from chain.

import { SOL_MINT, TOKEN_2022, TOKEN_PROGRAM, allAccounts, ataOf, b58encode, b64decode, b64encode, checkSwapTx, lookupAddresses, mintRisk, parseTx, swapInfo, withSignature } from './solana.js?v=mvegrk6b';

const JUP = 'https://lite-api.jup.ag/swap/v1';
export const LAMPORTS = 1e9;
export const RESERVE_LAMPORTS = 10_000_000; // 0.01 SOL kept for network fees
const MAX_EXTRA_LAMPORTS = 15_000_000; // fees + token-account rent a swap may cost on top
const SYSTEM_ID = '11111111111111111111111111111111';
// How far the app's own market price may be from the swap's minimum output before we refuse
// (memecoins move fast; a stop loss must still sell into a falling market).
const FEED_TOL = { buy: 0.3, sell: 0.5 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, init, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    try {
      const r = await fetch(url, { ...init, signal: ctl.signal });
      if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`Jupiter HTTP ${r.status}`), { retry: true });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || `Jupiter HTTP ${r.status}`);
      return j;
    } catch (e) {
      last = e;
      if (!e.retry && e.name !== 'AbortError') throw e;
      await sleep(800 * 2 ** i);
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

/**
 * Owner's SOL change (native + wrapped: a buy's close of the WSOL account also hands back WSOL the
 * wallet already held) and token change in a confirmed transaction (jsonParsed meta).
 */
export function fillFromTx(t, owner, mint) {
  const keys = t.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const i = keys.indexOf(owner);
  const native = i >= 0 ? BigInt(t.meta.postBalances[i]) - BigInt(t.meta.preBalances[i]) : 0n;
  const amt = (list, m) => (list || []).filter((b) => b.owner === owner && b.mint === m).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  const delta = (m) => amt(t.meta.postTokenBalances, m) - amt(t.meta.preTokenBalances, m);
  const dec = [...(t.meta.postTokenBalances || []), ...(t.meta.preTokenBalances || [])].find((b) => b.mint === mint)?.uiTokenAmount.decimals;
  return { solDelta: native + (mint === SOL_MINT ? 0n : delta(SOL_MINT)), tokenDelta: delta(mint), decimals: dec ?? null };
}

/** SPL token account bytes → { mint, owner, amount } (null when not a token account). */
export function readTokenAccount(bytes) {
  if (!bytes || bytes.length < 72) return null;
  let amount = 0n;
  for (let i = 71; i >= 64; i--) amount = (amount << 8n) | BigInt(bytes[i]);
  return { mint: b58encode(bytes.subarray(0, 32)), owner: b58encode(bytes.subarray(32, 64)), amount };
}
const accBytes = (acc) => (acc?.data?.[0] != null ? b64decode(acc.data[0]) : null);

const errOf = (msg, extra) => Object.assign(new Error(msg), extra);

export function createTrader({ vault, rpc, solUsd, settings, onStep = () => {}, wait = sleep }) {
  let queue = Promise.resolve();
  const owner = () => vault.status().pub;
  // One trade at a time: balances and fills stay unambiguous.
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  async function balance() {
    return Number(await rpc('getBalance', [owner(), { commitment: 'confirmed' }]).then((r) => r.value));
  }

  /** Every token account of the wallet (both token programs): [{ pubkey, mint, raw, dec }]. */
  async function tokenAccounts() {
    const out = [];
    for (const programId of [TOKEN_PROGRAM, TOKEN_2022]) {
      const r = await rpc('getTokenAccountsByOwner', [owner(), { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      for (const a of r.value || []) {
        const info = a.account?.data?.parsed?.info;
        if (info?.mint) out.push({ pubkey: a.pubkey, mint: info.mint, raw: BigInt(info.tokenAmount.amount), dec: info.tokenAmount.decimals });
      }
    }
    return out;
  }
  const byMint = (accs) => {
    const out = new Map();
    for (const a of accs) out.set(a.mint, { raw: (out.get(a.mint)?.raw || 0n) + a.raw, dec: a.dec });
    return out;
  };
  /** mint → { raw (BigInt), dec } */
  const tokenBalances = async () => byMint(await tokenAccounts());
  const held = (map, mint) => map.get(mint) || { raw: 0n, dec: null };

  /** Status of a sent transaction: 'confirmed' | 'failed' | 'expired' | 'unknown'. */
  async function statusOf(sig, blockhash) {
    const st = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]).catch(() => null);
    if (!st) return { state: 'unknown' };
    const v = st.value?.[0];
    const final = v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized');
    if (final) return v.err ? { state: 'failed', err: v.err } : { state: 'confirmed' };
    if (v === null && blockhash) {
      // Not found, and its blockhash can no longer be used: it can never land.
      const valid = await rpc('isBlockhashValid', [blockhash, { commitment: 'confirmed' }]).then((r) => r.value, () => null);
      if (valid === false) return { state: 'expired' };
    }
    return { state: 'unknown' };
  }

  /** The confirmed transaction's real fill (retries: a node may lag a few seconds). */
  async function readFill(sig, mint) {
    for (let i = 0; i < 10; i++) {
      const t = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
      if (t?.meta) return fillFromTx(t, owner(), mint);
      await wait(1500);
    }
    return null;
  }

  async function accountsBytes(addrs) {
    if (!addrs.length) return [];
    const r = await rpc('getMultipleAccounts', [addrs, { encoding: 'base64', commitment: 'confirmed' }]);
    return (r.value || []).map(accBytes);
  }

  async function swap({ inMint, outMint, amount, slipBps, kind, onSent, refPx }) {
    const me = owner();
    if (!me || !vault.status().unlocked) throw new Error('Wallet zablokowany — odblokuj go w Wallet');
    const px = solUsd();
    if (!(px > 0)) throw new Error('Brak ceny SOL — spróbuj za chwilę');
    const mint = kind === 'buy' ? outMint : inMint;
    // The token itself, read from chain: its decimals, and nothing that would let someone freeze,
    // take or tax what we buy.
    const mintAcc = (await rpc('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }])).value;
    const risk = mintRisk(accBytes(mintAcc), mintAcc?.owner);
    if (risk.decimals == null) throw new Error('Nie mogę odczytać tokena z sieci');
    if (kind === 'buy' && risk.bad) throw new Error(`Odrzucono token: ${risk.bad}`);
    // A floor that doesn't come from Jupiter: the output the app's own market price implies.
    let floor = 0n;
    if (refPx > 0) {
      const keep = (1 - slipBps / 1e4) * (1 - FEED_TOL[kind]);
      const out = kind === 'buy' ? ((Number(amount) / LAMPORTS) * px / refPx) * 10 ** risk.decimals : ((Number(amount) / 10 ** risk.decimals) * refPx / px) * LAMPORTS;
      if (Number.isFinite(out) && out > 0) floor = BigInt(Math.floor(out * keep));
    }
    onStep('quote');
    const q = await getJson(`${JUP}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slipBps}&restrictIntermediateTokens=true`);
    const minOut = BigInt(q.otherAmountThreshold || 0);
    if (!(BigInt(q.outAmount || 0) > 0n) || !(minOut > 0n)) throw new Error('Brak trasy wymiany dla tego tokena');
    if (String(q.inAmount) !== String(amount)) throw new Error('Odrzucono wycenę: inna kwota niż zlecona');
    if (minOut < floor) throw new Error('Odrzucono: Jupiter wycenia dużo gorzej niż rynek (cena uciekła albo za mała płynność)');
    const need = minOut > floor ? minOut : floor;
    const s = settings();
    const feeCap = s.priorityMaxLamports * 1.1 + 10_000;
    const j = await getJson(`${JUP}/swap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: me,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: Math.round(s.priorityMaxLamports), priorityLevel: 'veryHigh' } },
      }),
    });
    const tx = b64decode(j.swapTransaction);
    const parsed = parseTx(tx);
    // Our own token accounts, derived here — the swap may only move between them.
    const wsolAta = await ataOf(me, SOL_MINT);
    const mintAtas = [await ataOf(me, mint, TOKEN_PROGRAM), await ataOf(me, mint, TOKEN_2022)];
    const bad = checkSwapTx(parsed, me, {
      // A buy wraps exactly its SOL amount; a sell moves no SOL of ours.
      maxTransfer: kind === 'buy' ? BigInt(amount) : 0n,
      maxFeeLamports: feeCap,
      inAmount: BigInt(amount),
      maxSlipBps: slipBps,
      src: kind === 'buy' ? [wsolAta] : mintAtas,
      dst: kind === 'buy' ? mintAtas : [wsolAta],
      wsolAta,
    });
    if (bad) throw new Error(`Odrzucono transakcję: ${bad}`);
    const sw = swapInfo(parsed);
    // Every account it can write (lookup tables resolved) — and which of them are our token accounts.
    const tables = new Map();
    for (const l of parsed.lookups) {
      const t = (await rpc('getAccountInfo', [l.table, { encoding: 'base64', commitment: 'confirmed' }])).value;
      if (!t || t.owner !== 'AddressLookupTab1e1111111111111111111111111') throw new Error('Odrzucono transakcję: nieznana tabela adresów');
      tables.set(l.table, lookupAddresses(accBytes(t)));
    }
    const { writable } = allAccounts(parsed, tables);
    const mine = await tokenAccounts();
    const side = kind === 'buy' ? sw.dst : sw.src;
    const others = mine.filter((a) => writable.has(a.pubkey) && a.pubkey !== sw.src && a.pubkey !== sw.dst && a.pubkey !== wsolAta).map((a) => a.pubkey);
    // What the transaction really does on a Solana node, before we sign anything: the trade's own
    // token account, our wallet, and every other token account of ours it touches.
    onStep('simulate');
    const watch = [side, ...others];
    const pre = await accountsBytes(watch);
    const solPre = await balance();
    const sim = await rpc('simulateTransaction', [b64encode(tx), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [me, ...watch] } }]);
    if (sim.value.err) throw new Error(`Symulacja odrzuciła transakcję (${JSON.stringify(sim.value.err).slice(0, 80)}) — zwykle za mało SOL albo za duży poślizg`);
    const acc = sim.value.accounts?.[0];
    const solPost = Number(acc?.lamports ?? NaN);
    if (!Number.isFinite(solPost)) throw new Error('Symulacja nie zwróciła salda — przerwano');
    // Our account must stay a plain wallet (owned by the System program).
    if (acc.owner !== SYSTEM_ID) throw new Error('Odrzucono transakcję: zmieniałaby właściciela Twojego konta');
    const post = watch.map((_, i) => readTokenAccount(accBytes(sim.value.accounts?.[i + 1])));
    const before = pre.map(readTokenAccount);
    if (kind === 'buy') {
      if (solPre - solPost > Number(amount) + MAX_EXTRA_LAMPORTS) throw new Error('Odrzucono transakcję: zabrałaby więcej SOL niż kwota zakupu i opłaty');
      const out = post[0];
      if (!out || out.owner !== me || out.mint !== mint || out.amount - (before[0]?.amount || 0n) < need) throw new Error('Odrzucono transakcję: symulacja nie pokazuje zakupionych tokenów na Twoim koncie');
    } else {
      const left = post[0];
      // Exactly the amount asked leaves the token account (a partial sale stays partial).
      if (!before[0] || (left && left.owner !== me) || before[0].amount - (left?.amount || 0n) > BigInt(amount)) throw new Error('Odrzucono transakcję: sprzedałaby więcej tokenów niż zlecono');
      if (BigInt(solPost - solPre) < need - BigInt(Math.ceil(feeCap)) - 10_000n) throw new Error('Odrzucono transakcję: symulacja nie pokazuje SOL za sprzedaż na Twoim koncie');
    }
    // Other token accounts of ours (e.g. an intermediate USDC account): nothing may leave them, and
    // their owner, delegate and close authority stay exactly as they are.
    for (let i = 1; i < watch.length; i++) {
      const a = pre[i];
      const b = accBytes(sim.value.accounts?.[i + 1]);
      const same = (x, y, from, to) => x && y && x.subarray(from, to).every((v, k) => v === y[from + k]);
      if (!a || !b || !same(a, b, 0, 64) || !same(a, b, 72, 108) || !same(a, b, 129, 165) || readTokenAccount(b).amount < readTokenAccount(a).amount) {
        throw new Error('Odrzucono transakcję: ruszałaby inne Twoje tokeny');
      }
    }
    onStep('sign');
    const sig = await vault.sign(parsed.message);
    const signed = withSignature(tx, sig);
    const sigStr = b58encode(sig);
    const wire = b64encode(signed);
    onStep('send');
    // Saved by the caller before it goes out: a reload mid-trade can still find out what happened.
    onSent?.({ sig: sigStr, blockhash: parsed.blockhash });
    const sent = { sig: sigStr, sent: true };
    try {
      return await confirmAndFill({ wire, sigStr, blockhash: parsed.blockhash, mint, sent, preAccs: mine, solPre, kind });
    } catch (e) {
      // Whatever goes wrong after sending, the caller learns that it went out.
      if (e?.sent) throw e;
      throw errOf(`${e?.message || e} — sprawdzam w sieci (tx ${sigStr.slice(0, 8)}…)`, { ...sent, unknown: true });
    }
  }

  async function confirmAndFill({ wire, sigStr, blockhash, mint, sent, preAccs, solPre, kind }) {
    const send = () => rpc('sendTransaction', [wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]).catch(() => {});
    await send();
    const started = Date.now();
    let sentAt = Date.now();
    let checkedAt = 0;
    for (;;) {
      await wait(1500);
      const st = await rpc('getSignatureStatuses', [[sigStr], { searchTransactionHistory: false }]).catch(() => null);
      const v = st?.value?.[0];
      const final = v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized');
      // An error seen only at 'processed' may belong to a dropped fork: wait for it to confirm.
      if (final && v.err) throw errOf(`Transakcja odrzucona przez sieć (${JSON.stringify(v.err).slice(0, 60)}) — pobrano tylko opłatę sieci`, { ...sent, failed: true });
      if (final) break;
      if (Date.now() - sentAt > 3000) {
        sentAt = Date.now();
        send();
      }
      if (Date.now() - started > 20_000 && Date.now() - checkedAt > 5000) {
        checkedAt = Date.now();
        const valid = await rpc('isBlockhashValid', [blockhash, { commitment: 'confirmed' }]).then((r) => r.value, () => null);
        if (valid === false || Date.now() - started > 150_000) {
          if (valid === false) await wait(4000); // a block in flight may still confirm it
          const fin = await statusOf(sigStr, blockhash);
          if (fin.state === 'confirmed') break;
          if (fin.state === 'failed') throw errOf(`Transakcja odrzucona przez sieć (${JSON.stringify(fin.err).slice(0, 60)}) — pobrano tylko opłatę sieci`, { ...sent, failed: true });
          if (fin.state === 'expired') throw errOf('Transakcja nie weszła do sieci (wygasła) — nic nie zostało pobrane', { ...sent, expired: true });
          // No proof either way: it may still have gone through.
          throw errOf(`Nie udało się potwierdzić transakcji — sprawdzam dalej (tx ${sigStr.slice(0, 8)}…)`, { ...sent, unknown: true });
        }
      }
    }
    // The real fill, read back from chain (the quote is only an estimate).
    onStep('fill');
    const f = await readFill(sigStr, mint);
    if (f && f.decimals != null) return { ...sent, ...f };
    // Confirmed but the transaction isn't readable yet: measure it from the balances (WSOL netted
    // like in fillFromTx). Only a clear result is accepted; otherwise it is resolved later.
    const preMap = byMint(preAccs);
    const postMap = byMint(await tokenAccounts());
    const solNow = await balance();
    const tokenDelta = held(postMap, mint).raw - held(preMap, mint).raw;
    const solDelta = BigInt(solNow - solPre) + (held(postMap, SOL_MINT).raw - held(preMap, SOL_MINT).raw);
    const clear = kind === 'buy' ? tokenDelta > 0n && solDelta < 0n : tokenDelta < 0n && solDelta > 0n;
    if (!clear) throw errOf(`Transakcja weszła, ale węzeł jeszcze jej nie pokazuje — sprawdzam dalej (tx ${sigStr.slice(0, 8)}…)`, { ...sent, unknown: true });
    return { ...sent, solDelta, tokenDelta, decimals: held(postMap, mint).dec ?? held(preMap, mint).dec ?? f?.decimals ?? null, estimated: true };
  }

  const buyResult = (f, px) => {
    const solSpent = Number(-f.solDelta) / LAMPORTS;
    return { sig: f.sig, tokensRaw: f.tokenDelta.toString(), decimals: f.decimals, solSpent, usdSpent: solSpent * px, estimated: !!f.estimated };
  };
  const sellResult = (f, px, asked) => {
    const solGot = Number(f.solDelta) / LAMPORTS;
    return { sig: f.sig, tokensSold: (f.tokenDelta < 0n ? -f.tokenDelta : asked).toString(), solReceived: solGot, usdReceived: solGot * px, estimated: !!f.estimated };
  };

  return {
    owner,
    balance,
    tokenBalances,
    /**
     * Buys `usd` worth of `mint` with SOL. `refPx`: the app's market price of the token ($), for a
     * floor that doesn't depend on Jupiter. → { sig, tokensRaw, decimals, usdSpent, solSpent }
     * Errors carry `sent` once the transaction went out; then only `failed` / `expired` prove that
     * nothing was bought.
     */
    buy: (mint, usd, { onSent, refPx } = {}) =>
      serial(async () => {
        const px = solUsd();
        if (!(px > 0)) throw new Error('Brak ceny SOL — spróbuj za chwilę');
        const lamports = Math.floor((usd / px) * LAMPORTS);
        if (lamports < 100_000) throw new Error('Za mała kwota');
        const bal = await balance();
        if (bal - lamports < RESERVE_LAMPORTS) throw new Error(`Za mało SOL w walletcie (${(bal / LAMPORTS).toFixed(4)} SOL; zostaw 0.01 SOL na opłaty)`);
        const f = await swap({ inMint: SOL_MINT, outMint: mint, amount: String(lamports), slipBps: settings().slipBuyBps, kind: 'buy', onSent, refPx });
        if (!(f.tokenDelta > 0n) || f.decimals == null) throw errOf('Transakcja przeszła, ale nie widać zakupionych tokenów — sprawdzam dalej', { sig: f.sig, sent: true, unknown: true });
        const r = buyResult(f, px);
        if (!(r.usdSpent > 0)) r.usdSpent = (lamports / LAMPORTS) * px;
        return r;
      }),
    /** Sells `raw` units of `mint` (or everything the wallet holds with 'all') for SOL. */
    sell: (mint, raw, { onSent, refPx } = {}) =>
      serial(async () => {
        const px = solUsd();
        if (!(px > 0)) throw new Error('Brak ceny SOL — spróbuj za chwilę');
        let amount = raw === 'all' ? null : BigInt(raw);
        let h = held(await tokenBalances(), mint);
        // An empty read right after a buy can be a node lagging behind: look once more.
        if (!(h.raw > 0n)) {
          await wait(3000);
          h = held(await tokenBalances(), mint);
        }
        if (amount == null || amount > h.raw) amount = h.raw;
        if (!(amount > 0n)) throw errOf('Brak tych tokenów w walletcie', { empty: true });
        const f = await swap({ inMint: mint, outMint: SOL_MINT, amount: amount.toString(), slipBps: settings().slipSellBps, kind: 'sell', onSent, refPx });
        return sellResult(f, px, amount);
      }),
    /**
     * What became of a trade sent before a reload: { state: 'landed', result } with the same result
     * as buy() / sell(), or 'failed' / 'expired' (nothing traded) / 'unknown' (ask again later).
     */
    resolve: async (sig, mint, kind, blockhash) => {
      const px = solUsd();
      if (!(px > 0)) return { state: 'unknown' }; // its $ value needs the SOL price
      const st = await statusOf(sig, blockhash);
      if (st.state !== 'confirmed') return st;
      const f = await readFill(sig, mint);
      if (!f || f.decimals == null) return { state: 'unknown' };
      return { state: 'landed', result: kind === 'buy' ? buyResult({ sig, ...f }, px) : sellResult({ sig, ...f }, px, 0n) };
    },
  };
}
