// Minimal Solana toolkit for real trading (no dependencies): base58, Jupiter swap transactions
// (parse, safety checks, signing slot), JSON-RPC with failover. Pure functions are exported for
// tests; nothing here ever sees a private key (signing happens in vault.js).

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = Object.fromEntries([...B58].map((c, i) => [c, i]));

export function b58encode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let zeros = 0;
  while (zeros < b.length && b[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < b.length; i++) {
    let carry = b[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => B58[d]).join('');
}

export function b58decode(str) {
  const s = String(str).trim();
  if (!s || /[^1-9A-HJ-NP-Za-km-z]/.test(s)) throw new Error('Niepoprawny zapis base58');
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const bytes = [];
  for (let i = zeros; i < s.length; i++) {
    let carry = B58_MAP[s[i]];
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  bytes.reverse().forEach((v, i) => (out[zeros + i] = v));
  return out;
}

export const b64decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Solana "compact-u16" length prefix: [value, bytes used]. */
export function shortvec(bytes, at) {
  let v = 0;
  for (let i = 0; i < 3; i++) {
    const b = bytes[at + i];
    if (b === undefined) throw new Error('Uszkodzona transakcja');
    v |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return [v, i + 1];
  }
  throw new Error('Uszkodzona transakcja');
}

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
/** Programs a Jupiter swap may call. Anything else in a transaction we are asked to sign = refuse. */
export const ALLOWED_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter aggregator v6
  'ComputeBudget111111111111111111111111111111',
  '11111111111111111111111111111111', // System (wrap SOL into the user's own WSOL account)
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated token accounts
]);

/**
 * Parses a serialized (legacy or v0) transaction: signature slots, the message to sign, its static
 * account keys and the programs its top-level instructions call. Throws on anything malformed.
 */
export function parseTx(tx) {
  const [nSig, l1] = shortvec(tx, 0);
  const msgAt = l1 + 64 * nSig;
  if (nSig < 1 || msgAt >= tx.length) throw new Error('Uszkodzona transakcja');
  let at = msgAt;
  const versioned = (tx[at] & 0x80) !== 0;
  if (versioned) {
    if ((tx[at] & 0x7f) !== 0) throw new Error('Nieobsługiwana wersja transakcji');
    at++;
  }
  const header = { required: tx[at], roSigned: tx[at + 1], roUnsigned: tx[at + 2] };
  at += 3;
  const [nKeys, l2] = shortvec(tx, at);
  at += l2;
  const keys = [];
  for (let i = 0; i < nKeys; i++) {
    if (at + 32 > tx.length) throw new Error('Uszkodzona transakcja');
    keys.push(b58encode(tx.subarray(at, at + 32)));
    at += 32;
  }
  if (at + 32 > tx.length) throw new Error('Uszkodzona transakcja');
  const blockhash = b58encode(tx.subarray(at, at + 32));
  at += 32;
  const [nIx, l3] = shortvec(tx, at);
  at += l3;
  const programs = [];
  const ixs = [];
  for (let i = 0; i < nIx; i++) {
    if (at >= tx.length) throw new Error('Uszkodzona transakcja');
    const pid = tx[at++];
    const [nAcc, la] = shortvec(tx, at);
    at += la;
    const accounts = tx.subarray(at, at + nAcc);
    at += nAcc;
    const [nData, ld] = shortvec(tx, at);
    at += ld;
    const data = tx.subarray(at, at + nData);
    at += nData;
    // Programs are always static keys (the runtime never calls a program from a lookup table).
    if (at > tx.length || pid >= keys.length) throw new Error('Uszkodzona transakcja');
    programs.push(keys[pid]);
    ixs.push({ program: keys[pid], accounts: [...accounts], data });
  }
  // v0: accounts loaded from address lookup tables (indexes after the static keys).
  const lookups = [];
  if (versioned) {
    const [nL, ll] = shortvec(tx, at);
    at += ll;
    for (let i = 0; i < nL; i++) {
      if (at + 32 > tx.length) throw new Error('Uszkodzona transakcja');
      const table = b58encode(tx.subarray(at, at + 32));
      at += 32;
      const [nw, lw] = shortvec(tx, at);
      const writable = [...tx.subarray(at + lw, at + lw + nw)];
      at += lw + nw;
      const [nr, lr] = shortvec(tx, at);
      const readonly = [...tx.subarray(at + lr, at + lr + nr)];
      at += lr + nr;
      if (at > tx.length) throw new Error('Uszkodzona transakcja');
      lookups.push({ table, writable, readonly });
    }
  }
  if (at !== tx.length) throw new Error('Uszkodzona transakcja');
  return { nSig, msgAt, message: tx.subarray(msgAt), header, keys, programs, ixs, versioned, blockhash, lookups };
}

/**
 * Every account of a parsed transaction in runtime order (static keys, then lookup-table writable,
 * then lookup-table read-only) and the set the transaction may write. `tables`: table → addresses.
 */
export function allAccounts(p, tables) {
  const n = p.keys.length;
  const { required, roSigned, roUnsigned } = p.header;
  const writable = new Set(p.keys.filter((_, i) => (i < required ? i < required - roSigned : i < n - roUnsigned)));
  const loadedW = [];
  const loadedR = [];
  for (const l of p.lookups || []) {
    const addrs = tables.get(l.table);
    if (!addrs) throw new Error('Brak tabeli adresów transakcji');
    for (const i of l.writable) {
      if (i >= addrs.length) throw new Error('Uszkodzona tabela adresów');
      loadedW.push(addrs[i]);
      writable.add(addrs[i]);
    }
    for (const i of l.readonly) {
      if (i >= addrs.length) throw new Error('Uszkodzona tabela adresów');
      loadedR.push(addrs[i]);
    }
  }
  return { list: [...p.keys, ...loadedW, ...loadedR], writable };
}
/** Addresses stored in an address lookup table account (56-byte header, then 32-byte keys). */
export function lookupAddresses(bytes) {
  const out = [];
  for (let at = 56; at + 32 <= bytes.length; at += 32) out.push(b58encode(bytes.subarray(at, at + 32)));
  return out;
}

/**
 * What a mint allows that could hurt a holder: a freeze authority, or a Token-2022 extension that
 * lets someone take, block or tax the tokens. → { decimals, bad: reason | null }
 */
export function mintRisk(bytes, program) {
  if (!bytes || bytes.length < 82) return { decimals: null, bad: 'to nie jest token' };
  const decimals = bytes[44];
  if (u32(bytes, 46) === 1) return { decimals, bad: 'twórca może zamrozić Twoje tokeny (freeze authority)' };
  if (program === TOKEN_2022 && bytes.length > 166 && bytes[165] === 1) {
    // Token-2022 extensions: only known harmless ones pass; anything else (PermanentDelegate,
    // TransferHook, NonTransferable, Pausable, confidential transfers, future ones…) is refused.
    const zero = (d) => d.every((b) => b === 0);
    const NAMES = { 9: 'token nie może być przenoszony (NonTransferable)', 12: 'ktoś może zabrać tokeny z Twojego konta (PermanentDelegate)', 14: 'każdy transfer uruchamia obcy program (TransferHook)', 26: 'twórca może wstrzymać transfery tokena (Pausable)' };
    for (let at = 166; at + 4 <= bytes.length; ) {
      const type = bytes[at] | (bytes[at + 1] << 8);
      const len = bytes[at + 2] | (bytes[at + 3] << 8);
      const v = bytes.subarray(at + 4, at + 4 + len);
      at += 4 + len;
      if (type === 0 && len === 0) break; // padding
      if (type === 12 && v.length >= 32 && zero(v.subarray(0, 32))) continue; // no delegate set
      if (type === 14 && v.length >= 64 && zero(v.subarray(32, 64))) continue; // no hook program
      if (type === 6) {
        if (v[0] === 2) return { decimals, bad: 'nowe konta są zamrożone (DefaultAccountState)' };
        continue;
      }
      if (type === 1) {
        // A transfer fee: at most 1%, and nobody able to raise it later.
        if (v.length < 108 || (v[106] | (v[107] << 8)) > 100 || (v[88] | (v[89] << 8)) > 100) return { decimals, bad: 'podatek od transferu powyżej 1% (TransferFee)' };
        if (!zero(v.subarray(0, 32))) return { decimals, bad: 'twórca może podnieść podatek od transferu (TransferFee)' };
        continue;
      }
      if ([3, 10, 18, 19, 20, 21, 22, 23, 25].includes(type)) continue; // close authority, interest, metadata, groups, UI scale
      return { decimals, bad: NAMES[type] || `nieznane rozszerzenie tokena (Token-2022 #${type})` };
    }
  }
  return { decimals, bad: null };
}

const u32 = (d, at) => (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0;
const u64 = (d, at) => BigInt(u32(d, at)) | (BigInt(u32(d, at + 4)) << 32n);

const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SYSTEM = '11111111111111111111111111111111';
const BUDGET = 'ComputeBudget111111111111111111111111111111';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022]);

// ---------- associated token accounts (derived here, never taken from the API) ----------
const P = 2n ** 255n - 19n;
const fmod = (a) => ((a % P) + P) % P;
function fpow(b, e) {
  let r = 1n;
  b = fmod(b);
  for (; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
  }
  return r;
}
const ED_D = fmod(-121665n * fpow(121666n, P - 2n));
/** Whether 32 bytes are a point on the ed25519 curve (program addresses must not be). */
export function onCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  y = fmod(y & ((1n << 255n) - 1n));
  const y2 = (y * y) % P;
  const x2 = (fmod(y2 - 1n) * fpow(fmod(ED_D * y2 + 1n), P - 2n)) % P;
  return x2 === 0n || fpow(x2, (P - 1n) / 2n) === 1n;
}
async function sha256(parts) {
  const len = parts.reduce((a, x) => a + x.length, 0);
  const buf = new Uint8Array(len);
  let at = 0;
  for (const x of parts) buf.set(x, (at += x.length) - x.length);
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buf));
}
/** Solana program-derived address (find_program_address). */
export async function findPda(seeds, programId) {
  const tail = [b58decode(programId), new TextEncoder().encode('ProgramDerivedAddress')];
  for (let bump = 255; bump >= 0; bump--) {
    const h = await sha256([...seeds, Uint8Array.of(bump), ...tail]);
    if (!onCurve(h)) return b58encode(h);
  }
  throw new Error('Brak adresu PDA');
}
/** The owner's associated token account for `mint` under a token program. */
export const ataOf = (owner, mint, tokenProgram = TOKEN_PROGRAM) => findPda([b58decode(owner), b58decode(tokenProgram), b58decode(mint)], ATA);

const ROUTE = 'e517cb977ae3ad2a'; // route
const SHARED = 'c1209b3341d69c81'; // shared_accounts_route
const hex8 = (d) => Array.from(d.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
/**
 * The Jupiter swap instruction of a parsed transaction: who signs for the tokens, where they come
 * from and go to, and its amounts. null when it isn't one of the known ExactIn route forms.
 */
export function swapInfo(p) {
  const jix = (p.ixs || []).filter((ix) => ix.program === JUP);
  if (jix.length !== 1) return null;
  const { accounts: a, data: d } = jix[0];
  const kind = hex8(d);
  const key = (i) => (i < p.keys.length ? p.keys[i] : null); // lookup-table accounts can't be verified
  const at = d.length - 19; // … in_amount u64, quoted_out_amount u64, slippage_bps u16, platform_fee_bps u8
  if (at < 8) return null;
  const tail = { inAmount: u64(d, at), quotedOut: u64(d, at + 8), slippageBps: d[at + 16] | (d[at + 17] << 8), feeBps: d[at + 18] };
  // Optional accounts that are "none" are passed as the Jupiter program itself.
  if (kind === ROUTE && a.length >= 9) return { ...tail, authority: key(a[1]), src: key(a[2]), dst: key(a[3]), dst2: key(a[4]), fee: key(a[6]) };
  if (kind === SHARED && a.length >= 13) return { ...tail, authority: key(a[2]), src: key(a[3]), dst: key(a[6]), dst2: JUP, fee: key(a[9]) };
  return null;
}

/**
 * Safety checks before signing a swap built by Jupiter. Returns null when fine, else the reason
 * to refuse. Not only which programs are called — every top-level instruction outside the Jupiter
 * route must be one a swap needs, in its harmless form:
 *  • ComputeBudget: unit limit / price, with the priority fee capped (`maxFeeLamports`);
 *  • System: only a transfer of at most `maxTransfer` lamports (wrapping SOL for a buy) — never
 *    Assign / Allocate / anything that would hand our account to another program;
 *  • Associated token accounts: create our own (we pay, we own);
 *  • Token / Token-2022: only SyncNative and closing an account back to us (unwrapping SOL) —
 *    never Transfer, Approve (delegate), SetAuthority (new owner) or a close paid to someone else.
 * We must be the only signer and the fee payer.
 */
export function checkSwapTx(p, owner, { maxTransfer = 0n, maxFeeLamports = 0, inAmount = null, maxSlipBps = 0, src = [], dst = [], wsolAta = null, quotedOut = null, minOut = 0n } = {}) {
  const ours = new Set([wsolAta, ...src, ...dst]); // the only token accounts a swap may create
  if (p.header.required !== 1 || p.nSig !== 1) return 'transakcja wymaga więcej niż jednego podpisu';
  if (p.keys[0] !== owner) return 'płatnikiem transakcji nie jest Twój wallet';
  const bad = p.programs.find((x) => !ALLOWED_PROGRAMS.has(x));
  if (bad) return `transakcja wywołuje nieznany program (${bad.slice(0, 6)}…)`;
  if (!p.programs.includes(JUP)) return 'to nie jest swap Jupitera';
  // The swap itself: from our token account to our token account (addresses derived here),
  // exactly the amount asked, slippage within the setting, no platform fee, no fee account.
  const sw = swapInfo(p);
  if (!sw) return 'nieznany rodzaj swapu Jupitera';
  if (sw.authority !== owner) return 'swap podpisuje ktoś inny';
  if (!src.includes(sw.src)) return 'swap pobiera z cudzego konta tokenów';
  if (!dst.includes(sw.dst) || sw.dst2 !== JUP) return 'swap wysyła tokeny na cudze konto';
  if (sw.fee !== JUP || sw.feeBps !== 0) return 'swap pobiera dodatkową prowizję';
  if (inAmount != null && sw.inAmount !== BigInt(inAmount)) return 'swap ma inną kwotę niż zlecona';
  if (sw.slippageBps > maxSlipBps) return 'swap ma większy poślizg niż ustawiony';
  // The minimum the Jupiter program will accept on chain: the quote that was checked, and at least
  // the floor the app worked out itself.
  if (quotedOut != null && sw.quotedOut !== BigInt(quotedOut)) return 'swap ma inną wycenę niż sprawdzona';
  if ((sw.quotedOut * BigInt(10_000 - sw.slippageBps)) / 10_000n < BigInt(minOut)) return 'swap przyjąłby za mało w zamian';
  let cuLimit = 1_400_000;
  let cuPrice = 0n; // micro-lamports per compute unit
  let moved = 0n;
  for (const ix of p.ixs || []) {
    const d = ix.data;
    const a = ix.accounts;
    if (ix.program === JUP) continue;
    if (ix.program === BUDGET) {
      if (d[0] === 2 && d.length >= 5) cuLimit = u32(d, 1);
      else if (d[0] === 3 && d.length >= 9) cuPrice = u64(d, 1);
      else if (!(d[0] === 1 || d[0] === 4)) return 'nieznana instrukcja opłat';
    } else if (ix.program === SYSTEM) {
      // Transfer = 2 (u32 LE), lamports u64; from = us (static key 0), to our wrapped-SOL account.
      if (!(d.length === 12 && u32(d, 0) === 2 && a[0] === 0)) return 'transakcja zawiera niedozwoloną operację na Twoim koncie';
      if (!(a[1] < p.keys.length && p.keys[a[1]] === wsolAta)) return 'transakcja przelewa SOL na cudze konto';
      moved += u64(d, 4);
      if (moved > BigInt(maxTransfer)) return 'transakcja przelewa więcej SOL niż kwota zakupu';
    } else if (ix.program === ATA) {
      // Create (no data / 0) or CreateIdempotent (1): payer and owner = us, and only our own WSOL /
      // traded-token account (the program itself refuses an address that isn't derived from them).
      if (!((d.length === 0 || d[0] === 0 || d[0] === 1) && a[0] === 0 && a[2] === 0)) return 'niedozwolone konto tokenów';
      if (!(a[1] < p.keys.length && ours.has(p.keys[a[1]]))) return 'transakcja zakłada niepotrzebne konto tokenów';
    } else if (TOKEN_PROGRAMS.has(ix.program)) {
      if (d[0] === 17 && d.length === 1) continue; // SyncNative
      // CloseAccount (9): [account, destination, owner] — the rent / wrapped SOL comes back to us.
      if (!(d[0] === 9 && d.length === 1 && a[1] === 0 && a[2] === 0)) return 'transakcja zawiera niedozwoloną operację na Twoich tokenach';
    }
  }
  const prioFee = (cuPrice * BigInt(cuLimit)) / 1_000_000n;
  if (prioFee > BigInt(Math.ceil(maxFeeLamports))) return 'opłata priorytetowa wyższa niż ustawiona';
  return null;
}

/** The transaction with our signature in slot 0. */
export function withSignature(tx, sig) {
  const out = new Uint8Array(tx);
  const [, l1] = shortvec(out, 0);
  out.set(sig, l1);
  return out;
}

// ---------- JSON-RPC ----------
export const DEFAULT_RPCS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];

export function createRpc(getCustom = () => '') {
  let idx = 0; // rotates among DEFAULT_RPCS only: a custom node (Helius…) is always asked first
  return async function rpc(method, params = [], { timeout = 12_000, only = '' } = {}) {
    const c = String(getCustom() || '').trim();
    const d = DEFAULT_RPCS;
    const s = idx % d.length;
    const urls = only ? [only] : [...(/^https:\/\/[^\s"'<>]+$/.test(c) ? [c] : []), ...d.slice(s), ...d.slice(0, s)];
    let last;
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctl.signal });
        if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
        const j = await r.json();
        if (j.error) {
          // A real answer about the request (not the node): don't retry elsewhere.
          const e = new Error(j.error.message || 'RPC error');
          e.rpc = j.error;
          throw e;
        }
        const k = d.indexOf(url);
        if (k >= 0) idx = k;
        return j.result;
      } catch (e) {
        last = e;
        if (e.rpc) throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`węzeł Solana nie odpowiada (${last?.message || 'brak połączenia'})`);
  };
}
