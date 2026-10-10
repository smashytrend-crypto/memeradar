// GoPlus Security (https://docs.gopluslabs.io): free token safety checks on EVM networks —
// honeypot, sell / buy tax, mint and owner powers — plus holder count and top-holder share.
// Results go into the same shapes RugCheck / Jupiter fill on Solana (t.rug risks, t.audit,
// holders), so scoring and the UI treat every network alike.
import { RateLimiter, errMsg, every, getJSON, num } from '../util.js?v=mv2zx1lk';

const BASE = 'https://api.gopluslabs.io/api/v1/token_security';
const NAME = 'goplus';

const on = (v) => v === '1' || v === 1;

/** GoPlus result for one token → { rug, audit, holders }. */
export function goplusToReport(r) {
  const risks = [];
  const add = (level, name, description, value) => risks.push({ level, name, description, value });
  const buyTax = num(r.buy_tax);
  const sellTax = num(r.sell_tax);
  if (on(r.is_honeypot)) add('danger', 'Honeypot', 'Tokena nie da się sprzedać.');
  if (on(r.cannot_sell_all)) add('danger', 'Nie można sprzedać całości', 'Kontrakt blokuje sprzedaż wszystkich tokenów.');
  if (on(r.cannot_buy)) add('warn', 'Zakup zablokowany', 'Kontrakt nie pozwala obecnie kupić tokena.');
  if (sellTax >= 0.1) add('danger', 'Wysoki podatek od sprzedaży', '', `${(sellTax * 100).toFixed(0)}%`);
  else if (sellTax >= 0.05) add('warn', 'Podatek od sprzedaży', '', `${(sellTax * 100).toFixed(0)}%`);
  if (buyTax >= 0.1) add('danger', 'Wysoki podatek od zakupu', '', `${(buyTax * 100).toFixed(0)}%`);
  else if (buyTax >= 0.05) add('warn', 'Podatek od zakupu', '', `${(buyTax * 100).toFixed(0)}%`);
  if (on(r.is_mintable)) add('warn', 'Można dodrukować tokeny', 'Właściciel kontraktu może zwiększyć podaż.');
  if (on(r.owner_change_balance)) add('danger', 'Właściciel może zmieniać salda', 'Kontrakt pozwala właścicielowi zmieniać salda portfeli.');
  if (on(r.hidden_owner)) add('danger', 'Ukryty właściciel', '');
  if (on(r.can_take_back_ownership)) add('danger', 'Można odzyskać własność kontraktu', '');
  if (on(r.selfdestruct)) add('danger', 'Kontrakt może się samozniszczyć', '');
  if (on(r.transfer_pausable)) add('warn', 'Transfery można wstrzymać', '');
  if (on(r.is_blacklisted)) add('warn', 'Czarna lista portfeli', 'Właściciel może blokować wybrane portfele.');
  if (on(r.slippage_modifiable)) add('warn', 'Zmienny podatek', 'Właściciel może zmieniać podatki.');
  if (r.is_open_source === '0') add('warn', 'Kod kontraktu niezweryfikowany', '');
  if (on(r.is_proxy)) add('warn', 'Kontrakt proxy', 'Logikę kontraktu można podmienić.');

  // Top 10 wallets by share, leaving out pools / contracts and locked positions.
  const holders = Array.isArray(r.holders) ? r.holders : [];
  const people = holders.filter((h) => !on(h.is_contract) && !on(h.is_locked));
  const top10 = people.slice(0, 10).reduce((acc, h) => acc + (num(h.percent) || 0), 0) * 100;
  const creator = num(r.creator_percent);
  // LP burned or locked: LP tokens held by the zero / dead address or in a lock (V2-style pools;
  // concentrated-liquidity pools have no LP token, so this stays unknown there).
  const lp = Array.isArray(r.lp_holders) ? r.lp_holders : [];
  const dead = (a) => /^0x0{40}$|^0x0{36}dead$|^0x000000000000000000000000000000000000dead$/i.test(a || '');
  const lpBurnPct = lp.length ? lp.filter((h) => on(h.is_locked) || dead(h.address)).reduce((a, h) => a + (num(h.percent) || 0), 0) * 100 : null;
  const danger = risks.filter((x) => x.level === 'danger').length;
  return {
    rug: { score: danger ? 80 : risks.length ? 30 : 0, risks, at: Date.now(), source: 'GoPlus', lpBurnPct },
    audit: {
      topHoldersPercentage: holders.length ? top10 : undefined,
      devBalancePercentage: creator != null ? creator * 100 : undefined,
      // Creator history on EVM: other honeypots deployed by the same address.
      honeypotSameCreator: num(r.honeypot_with_same_creator),
      // Same meaning as Solana's mint / freeze authority (for the safety filters).
      // (separate names: scoring treats Solana's authority fields as its own risks; GoPlus already
      // reports these as risks above)
      evmMintOff: r.is_mintable != null ? !on(r.is_mintable) : undefined,
      evmFreezeOff: r.transfer_pausable != null || r.is_blacklisted != null ? !(on(r.transfer_pausable) || on(r.is_blacklisted)) : undefined,
    },
    creator: typeof r.creator_address === 'string' ? r.creator_address.toLowerCase() : undefined,
    topHolders: people.slice(0, 10).filter((h) => typeof h.address === 'string').map((h) => ({ a: h.address.toLowerCase(), pct: (num(h.percent) || 0) * 100 })),
    holders: num(r.holder_count) || undefined,
  };
}

export function startGoPlus(store) {
  const chainId = store.chain.goplus;
  const lim = new RateLimiter(20);
  let okCount = 0;
  store.setSource(NAME, 'connecting', 'czeka na tokeny w czołówce rankingu');

  async function check(t) {
    const json = await lim.run(() => getJSON(`${BASE}/${chainId}?contract_addresses=${t.mint}`));
    const r = json?.result?.[t.mint] || json?.result?.[t.mint.toLowerCase()];
    if (!r) return;
    const { rug, audit, holders, creator, topHolders } = goplusToReport(r);
    t.rug = rug;
    t.audit = audit;
    if (topHolders.length) t.topHolders = topHolders;
    store.upsert(t.mint, { holders, creator: t.creator || creator }, NAME);
    store.setSource(NAME, 'ok', `OK · ${++okCount} raportów`);
  }

  const fail = (err) => {
    if (err?.status === 429) lim.pause(60_000);
    store.setSource(NAME, 'error', errMsg(err));
  };

  // Safety barely changes, holder counts do: top tokens every 5 min (≈20 requests a minute).
  every(
    3000,
    async () => {
      const [t] = store.pickForRefresh('goplus', 1, Date.now(), {
        intervals: { top: 5 * 60_000, hot: 20 * 60_000, young: 30 * 60_000, rest: 6 * 3600_000 },
        filter: (tok) => (store.rank.get(tok.mint) || Infinity) <= 120 || tok.pinnedUntil > Date.now(),
      });
      if (t) await check(t);
    },
    fail,
    () => store.active,
  );

  return { check: (t) => check(t).catch(fail) };
}
