// Wallet tracker — reading a swap out of a Solana transaction (jsonParsed, as getTransaction
// returns it): how much SOL / WSOL / USDC the wallet gave or got against which token. Pure
// functions, unit-tested.

export const WSOL = 'So11111111111111111111111111111111111111112';
export const STABLES = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
const ATA_RENT = 0.00203928; // SOL locked when a token account is opened (comes back on close)

// Programs whose logs mean a swap may be inside (launchpads, AMMs, aggregators, trading bots).
export const DEX_PROGRAMS = [
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // pump.fun
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', // Raydium LaunchLab (bonk)
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', // Meteora DAMM v2
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora DAMM v1
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', // Meteora DBC
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca
  '6m2CDdhRgxpH4WjvdzxAYbGxwdGUz5MziiL5jek2kBma', // OKX DEX
];
const SWAP_LOG = /Instruction: (Buy|Sell|Swap\w*|Route\w*|SharedAccountsRoute|ExactOutRoute|SwapBaseIn|SwapBaseOut|BuyExactIn|SellExactIn)|ray_log/i;

/** From a logs notification: is it worth fetching the whole transaction? */
export function looksLikeSwap(logs) {
  if (!Array.isArray(logs)) return false;
  return logs.some((l) => SWAP_LOG.test(l) || DEX_PROGRAMS.some((p) => l.includes(p)));
}

const key = (k) => (typeof k === 'string' ? k : k?.pubkey);
const ui = (b) => {
  const a = b?.uiTokenAmount;
  if (!a) return 0;
  if (a.uiAmountString != null) return Number(a.uiAmountString) || 0;
  return Number(a.uiAmount) || 0;
};

/**
 * The wallet's swap in a transaction: { side: 'buy' | 'sell', mint, tokens, sol, usd, t, sig }
 * (sol: the SOL / WSOL side, usd: a stablecoin side), or null for anything else (transfers,
 * failed transactions, several tokens at once).
 */
export function parseSwap(tx, wallet) {
  if (!tx?.meta || tx.meta.err) return null;
  const keys = (tx.transaction?.message?.accountKeys || []).map(key);
  const i = keys.indexOf(wallet);
  const meta = tx.meta;
  let sol = 0;
  if (i >= 0 && meta.preBalances && meta.postBalances) {
    sol = (meta.postBalances[i] - meta.preBalances[i]) / 1e9;
    if (i === 0) sol += (meta.fee || 0) / 1e9; // the network fee isn't part of the price
  }
  // Token balances of accounts the wallet owns, by mint: post − pre.
  const delta = new Map();
  const opened = new Set();
  const add = (b, sign) => {
    if (b?.owner !== wallet || !b.mint) return;
    delta.set(b.mint, (delta.get(b.mint) || 0) + sign * ui(b));
  };
  for (const b of meta.preTokenBalances || []) add(b, -1);
  for (const b of meta.postTokenBalances || []) add(b, 1);
  const pre = new Set((meta.preTokenBalances || []).filter((b) => b.owner === wallet).map((b) => b.accountIndex));
  for (const b of meta.postTokenBalances || []) if (b.owner === wallet && !pre.has(b.accountIndex) && b.mint !== WSOL) opened.add(b.mint);
  sol += delta.get(WSOL) || 0;
  delta.delete(WSOL);
  let usd = 0;
  for (const s of STABLES) {
    usd += delta.get(s) || 0;
    delta.delete(s);
  }
  const moved = [...delta].filter(([, v]) => Math.abs(v) > 1e-12);
  if (moved.length !== 1) return null;
  const [mint, tokens] = moved[0];
  // Opening the token account locks ~0.002 SOL of rent: not part of what the token cost; closing
  // it in a sell refunds that rent: not part of what the tokens fetched.
  if (tokens > 0 && opened.has(mint) && sol < 0) sol = Math.min(0, sol + ATA_RENT);
  if (tokens < 0 && sol > 0) {
    const preAcc = (meta.preTokenBalances || []).find((b) => b.owner === wallet && b.mint === mint);
    const stillThere = preAcc && (meta.postTokenBalances || []).some((b) => b.accountIndex === preAcc.accountIndex);
    if (preAcc && !stillThere) sol = Math.max(0, sol - ((meta.preBalances?.[preAcc.accountIndex] || 0) / 1e9 || ATA_RENT));
  }
  const t = tx.blockTime ? tx.blockTime * 1000 : Date.now();
  const sig = tx.transaction?.signatures?.[0] || '';
  const pos = (v) => (v > 1e-9 ? v : 0); // the side that moved, 0 for the other
  // The wallet's token account of this mint: its own history is every trade of this token.
  const tb = [...(meta.postTokenBalances || []), ...(meta.preTokenBalances || [])].find((b) => b.owner === wallet && b.mint === mint);
  const acct = tb ? keys[tb.accountIndex] || null : null;
  if (tokens > 0 && (sol < -1e-6 || usd < -1e-6)) return { side: 'buy', mint, tokens, sol: pos(-sol), usd: pos(-usd), t, sig, acct };
  if (tokens < 0 && (sol > 1e-6 || usd > 1e-6)) return { side: 'sell', mint, tokens: -tokens, sol: pos(sol), usd: pos(usd), t, sig, acct };
  return null;
}

/**
 * Realised PnL of a sell from the wallet's earlier trades of the token (average cost, like
 * kolscan). `earlier`: parsed swaps of that token BEFORE the sell, oldest first (blockTime has
 * 1 s resolution, so the caller's on-chain order is kept). Legs paid in stablecoins are valued
 * at `su` ($ per SOL). Returns { sol, pct, partial } or null when no buy is known.
 */
export function sellPnl(earlier, sell, su = 0) {
  const val = (x) => (x.sol || 0) + (x.usd > 0 ? (su > 0 ? x.usd / su : NaN) : 0);
  let tokens = 0;
  let cost = 0; // SOL
  for (const x of earlier) {
    if (x.sig === sell.sig) continue;
    if (x.side === 'buy') {
      tokens += x.tokens;
      cost += val(x);
    } else if (tokens > 0) {
      const part = Math.min(1, x.tokens / tokens);
      cost -= cost * part;
      tokens -= Math.min(tokens, x.tokens);
    }
  }
  const proceeds = val(sell);
  if (!(tokens > 0) || !(cost > 0) || !Number.isFinite(cost) || !Number.isFinite(proceeds)) return null;
  // Selling more than the buys seen (transfer in, or history cut off): only the covered part counts.
  const cov = Math.min(1, tokens / sell.tokens);
  const basis = cost * Math.min(1, sell.tokens / tokens);
  const pnl = proceeds * cov - basis;
  return { sol: pnl, pct: (pnl / basis) * 100, partial: cov < 0.98 };
}
