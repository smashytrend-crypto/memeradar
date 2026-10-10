// Supported networks: ids used by each data source, native coin, address format, explorer links.
// Solana keeps its own sources (PumpPortal, Jupiter, RugCheck); the EVM chains run on
// DexScreener + GeckoTerminal for market data and GoPlus for safety checks and holder counts.
import { isMint } from './util.js?v=mv2dlcgj';

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
export const isEvmAddress = (s) => typeof s === 'string' && EVM_RE.test(s);

export const CHAINS = {
  solana: {
    id: 'solana',
    name: 'Solana',
    native: 'SOL',
    dex: 'solana', // DexScreener chainId
    gt: 'solana', // GeckoTerminal network id
    goplus: null,
    evm: false,
    color: '#14F195',
    explorer: (a) => `https://solscan.io/token/${a}`,
    explorerName: 'Solscan',
  },
  bsc: {
    id: 'bsc',
    name: 'BNB Chain',
    native: 'BNB',
    dex: 'bsc',
    gt: 'bsc',
    goplus: 56,
    evm: true,
    color: '#F0B90B',
    // Wrapped native coin on its DexScreener chain, for the header price.
    nativeRef: ['bsc', '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'],
    explorer: (a) => `https://bscscan.com/token/${a}`,
    explorerName: 'BscScan',
    gmgn: 'bsc',
    buy: (a) => `https://pancakeswap.finance/swap?outputCurrency=${a}`,
    buyName: 'PancakeSwap (kup)',
  },
  base: {
    id: 'base',
    name: 'Base',
    native: 'ETH',
    dex: 'base',
    gt: 'base',
    goplus: 8453,
    evm: true,
    color: '#0052FF',
    nativeRef: ['ethereum', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'],
    explorer: (a) => `https://basescan.org/token/${a}`,
    explorerName: 'BaseScan',
    gmgn: 'base',
    buy: (a) => `https://app.uniswap.org/swap?chain=base&outputCurrency=${a}`,
    buyName: 'Uniswap (kup)',
  },
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum',
    native: 'ETH',
    dex: 'ethereum',
    gt: 'eth',
    goplus: 1,
    evm: true,
    memeOnly: false, // Ethereum radar also lists non-meme projects
    color: '#627EEA',
    nativeRef: ['ethereum', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'],
    explorer: (a) => `https://etherscan.io/token/${a}`,
    explorerName: 'Etherscan',
    gmgn: 'eth',
    buy: (a) => `https://app.uniswap.org/swap?chain=mainnet&outputCurrency=${a}`,
    buyName: 'Uniswap (kup)',
  },
  robinhood: {
    id: 'robinhood',
    name: 'Robinhood',
    native: 'ETH',
    dex: 'robinhood',
    gt: 'robinhood',
    goplus: 4663,
    evm: true,
    color: '#CCFF00',
    nativeRef: ['ethereum', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'],
    explorer: (a) => `https://robinhoodscan.io/token/${a}`,
    explorerName: null, // no explorer link we could verify
    buy: null,
  },
};

export const CHAIN_IDS = Object.keys(CHAINS);
export const getChain = (id) => (Object.hasOwn(CHAINS, id) ? CHAINS[id] : CHAINS.solana);

/** Address check for a chain. */
export const isAddressOn = (chain, s) => (chain.evm ? isEvmAddress(s) : isMint(s));

/** Canonical form used as the store key: EVM addresses lowercased (sources mix checksum case). */
export const normAddr = (chain, s) => (chain.evm && typeof s === 'string' ? s.toLowerCase() : s);

/** Stablecoins, wrapped / staked native coins and gold tokens: never shown on any network. */
export const EVM_BASE_ASSETS = new Set(
  [
    'USDT', 'USDC', 'DAI', 'BUSD', 'FDUSD', 'USDE', 'USDS', 'PYUSD', 'TUSD', 'USD1', 'USDG', 'RLUSD', 'FRAX', 'LUSD', 'GHO', 'USDB', 'CRVUSD', 'SUSDE', 'USDBC', 'EURC', 'USD0', 'USDD',
    'ETH', 'WETH', 'BNB', 'WBNB', 'STETH', 'WSTETH', 'RETH', 'CBETH', 'WEETH', 'EZETH', 'METH', 'SLISBNB', 'BNBX',
    'BTC', 'WBTC', 'BTCB', 'CBBTC', 'TBTC', 'LBTC', 'SOLVBTC',
    'XAUT', 'PAXG',
  ].map((s) => s.toUpperCase()),
);

/**
 * Well-known non-meme projects (majors, DeFi / infra), matched by symbol — trending lists on the
 * meme-only networks are full of them.
 */
export const EVM_NON_MEME_SYMBOLS = new Set(
  [
    'LINK', 'UNI', 'AAVE', 'MKR', 'SKY', 'LDO', 'CRV', 'CVX', 'COMP', 'SNX', 'BAL', 'SUSHI', 'YFI', '1INCH', 'PENDLE', 'ENA', 'ETHFI', 'EIGEN', 'ONDO', 'QNT', 'GRT',
    'ARB', 'OP', 'MATIC', 'POL', 'IMX', 'LRC', 'ZRO', 'STRK', 'MNT', 'ZK',
    'CAKE', 'XVS', 'ALPACA', 'TWT', 'BAKE', 'AERO', 'VIRTUAL', 'MORPHO', 'WLD', 'ENS', 'RNDR', 'RENDER', 'FET', 'AGIX', 'OCEAN', 'INJ',
    'ADA', 'XRP', 'DOGE', 'DOT', 'TRX', 'LTC', 'BCH', 'AVAX', 'SOL', 'TON', 'ATOM', 'FIL', 'ZEC', 'XLM', 'NEAR', 'APT', 'SUI', 'SEI', 'TIA', 'HYPE',
    'SERV', 'GTC', 'RAIL', 'FUSE', 'SAND', 'MANA', 'AXS', 'APE', 'BLUR', 'GALA', 'CHZ', 'ENJ',
  ].map((s) => s.toUpperCase()),
);

/** Established memecoins kept on EVM radars even though they are older than the age window. */
export const EVM_KNOWN_MEMES = new Set(
  ['PEPE', 'SHIB', 'FLOKI', 'WOJAK', 'MOG', 'SPX', 'TURBO', 'BRETT', 'TOSHI', 'DEGEN', 'MIGGLES', 'KEYCAT', 'BABYDOGE', 'TUT', 'MUBARAK', 'BROCCOLI', 'CHEEMS', 'NEIRO', 'APU', 'ANDY', 'BOBO', 'LADYS', 'HOSKY', 'PEPECOIN', 'BITCOIN', 'DOGE2', 'SKI', 'BENJI', 'DOGINME', 'MOODENG', 'PONKE'].map((s) => s.toUpperCase()),
);

const BASE_ASSET_NAME = /\b(staked|wrapped|bridged|restaked|liquid staking|stablecoin|usd)\b/i;
const NON_MEME_NAME = /\b(vault|treasury|tokenized|xstock|index|etf)\b/i;
const EVM_MAX_AGE = 60 * 24 * 3600_000;
const EVM_MAX_MCAP = 3e9;

/**
 * Whether an EVM token belongs on the meme radar: DEX trending lists there mix memes with DeFi,
 * AI-infra, staking and stock tokens, which carry no tags. Keeps tokens younger than ~2 months
 * (where new memes live) plus well-known memes, and drops obvious non-memes by name / size.
 */
export function isEvmMeme(t, now = Date.now()) {
  const sym = String(t.symbol || '').toUpperCase();
  if (EVM_KNOWN_MEMES.has(sym)) return true;
  if (isBaseAsset(t) || EVM_NON_MEME_SYMBOLS.has(sym) || NON_MEME_NAME.test(t.name || '')) return false;
  if ((t.mcap || t.fdv || 0) > EVM_MAX_MCAP) return false;
  return !!t.createdAt && now - t.createdAt <= EVM_MAX_AGE;
}

/** Stablecoin / wrapped or staked coin / gold token — not a project to track. */
export function isBaseAsset(t) {
  return EVM_BASE_ASSETS.has(String(t.symbol || '').toUpperCase()) || BASE_ASSET_NAME.test(t.name || '');
}

/** Whether an EVM token is listed on its network's radar (Ethereum also takes non-meme projects). */
export const evmEligible = (chain, t, now) => (chain.memeOnly === false ? !isBaseAsset(t) : isEvmMeme(t, now));

/** GeckoTerminal dex ids of launchpad bonding curves on EVM networks → launchpad key. */
export const GT_CURVES = { 'four-meme': 'fourmeme', 'pons-v2': 'pons', 'o1-launchpad': 'o1' };

/** Launchpad key for a GeckoTerminal dex id (ids may carry a network suffix, e.g. o1-launchpad-robinhood). */
export const gtCurve = (dexId, network) => GT_CURVES[dexId] || GT_CURVES[String(dexId || '').replace(`-${network}`, '')];
