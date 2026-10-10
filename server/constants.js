/** Well-known non-meme Solana mints (stables, LSTs, infra tokens) excluded from the radar. */
export const NON_MEME = new Set([
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', // USDS
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', // JTO
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', // PYTH
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL
  '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4', // JLP
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', // ORCA
  '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ', // W
  'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', // RENDER
  'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux', // HNT
  'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS', // KMNO
  'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7', // DRIFT
  'TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6', // TNSR
  'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', // cbBTC
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // WBTC
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // WETH
]);

export const NON_MEME_TAGS = new Set(['lst', 'stable', 'stablecoin', 'defi', 'rwa', 'yield', 'yb', 'jup-lend-earn', 'xstocks', 'stocks', 'equities']);

/** DexScreener dexIds of launchpad bonding-curve pools (not a real DEX market yet). */
export const CURVE_DEXES = new Set(['pumpfun', 'meteoradbc', 'launchlab', 'moonshot', 'boop', 'fourmeme']);
export const isCurvePair = (p) =>
  CURVE_DEXES.has(p?.dexId) || (p?.labels || []).some((l) => /launch ?lab|dbc|bonding/i.test(l));

/** pump.fun bonding curve constants (virtual token reserves at start / real tokens sold at graduation). */
export const PUMP_INITIAL_VTOKENS = 1_073_000_000;
export const PUMP_TOKENS_FOR_SALE = 793_100_000;
/** Constant product of the pump.fun curve: 30 virtual SOL × 1.073B virtual tokens. */
export const PUMP_K = 30 * PUMP_INITIAL_VTOKENS;
