// Token icons, fast: the APIs hand out full-size originals (often MBs) on slow public IPFS
// gateways (ipfs.io rate-limits with 429). Each icon gets a list of sources, best first:
//   IPFS → pump.fun's own Pinata gateway, resized there (what pump.fun itself shows);
//   any URL → wsrv.nl (free image proxy on Cloudflare's cache, used by Jupiter), resized to webp;
//   finally the original. A source that errors or stalls for 5 s hands over to the next one, and
// re-rendered lists keep their already-loading <img> elements instead of restarting them.

const IPFS_SUB = /^([a-z0-9]{46,62})\.ipfs\./i; // bafy….ipfs.dweb.link
const IPFS_PATH = /\/ipfs\/([a-zA-Z0-9]{46,62})(\/[^?#]*)?/; // https://ipfs.io/ipfs/Qm…
const STALL_MS = 6_000;
const DEAD_MS = 10 * 60_000; // an icon with no working source isn't retried for 10 min

/** IPFS content id (and path inside it) of a gateway / ipfs:// URL, or null. */
export function ipfsOf(url) {
  if (typeof url !== 'string') return null;
  if (url.startsWith('ipfs://')) {
    const rest = url.slice(7).replace(/^ipfs\//, '');
    const [cid, ...p] = rest.split('/');
    return cid.length >= 46 ? { cid, path: p.length ? `/${p.join('/')}` : '' } : null;
  }
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const sub = u.hostname.match(IPFS_SUB);
  if (sub) return { cid: sub[1], path: u.pathname === '/' ? '' : u.pathname };
  const m = u.pathname.match(IPFS_PATH);
  return m ? { cid: m[1], path: m[2] || '' } : null;
}

// Hosts that keep failing on this device (blocked network, outage) drop to the back — only on
// real load errors in the last minute, only while some other host does load (so a slow network
// doesn't demote everything), and never for a host that has loaded here.
const fails = new Map(); // host → [error times]
const oks = new Set();
const dead = new Map(); // icon URL → until when it isn't retried (every source failed)
const hostOf = (s) => {
  try {
    return new URL(s).hostname;
  } catch {
    return '';
  }
};
function bad(s) {
  const h = hostOf(s);
  if (oks.has(h) || !oks.size) return false;
  const now = Date.now();
  const recent = (fails.get(h) || []).filter((t) => now - t < 60_000);
  fails.set(h, recent);
  return recent.length >= 3;
}

/** Sources for an icon shown at `px` CSS pixels (2× for retina), best first. */
export function iconSources(url, px = 40) {
  if (typeof url !== 'string' || !url) return [];
  if (/^data:image\//i.test(url)) return [url];
  const w = Math.min(256, Math.round(px * 2));
  const ipfs = ipfsOf(url);
  const proxy = (src) => `https://wsrv.nl/?url=${encodeURIComponent(src)}&w=${w}&h=${w}&fit=cover&output=webp&maxage=31d`;
  let list;
  if (ipfs) {
    const gw = (host) => `https://${host}/ipfs/${ipfs.cid}${ipfs.path}`;
    list = [
      `${gw('pump.mypinata.cloud')}?img-width=${w}&img-height=${w}&img-fit=cover&img-format=webp`,
      proxy(gw('ipfs.io')),
      gw('dweb.link'),
      gw('ipfs.io'),
    ];
  } else if (/^https:\/\//i.test(url)) list = [proxy(url), url];
  else if (/^http:\/\//i.test(url)) list = [proxy(url)]; // plain http would be blocked on an https page
  else return [];
  const good = list.filter((s) => !bad(s));
  return good.length ? [...good, ...list.filter((s) => bad(s))] : list;
}

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** `<img>` for a token icon with its fallback chain ('' when there is no usable URL). */
export function iconImg(url, px = 40, { lazy = true } = {}) {
  if (Date.now() < (dead.get(url) || 0)) return '';
  const list = iconSources(url, px);
  if (!list.length) return '';
  return `<img src="${escAttr(list[0])}" data-icon="${escAttr(url)}" data-alt="${escAttr(list.slice(1).join(' '))}" alt="" ${lazy ? 'loading="lazy" ' : ''}decoding="async" referrerpolicy="no-referrer">`;
}

/** Next source of an icon; `stalled`: too slow, not an error (doesn't count against the host). */
function next(img, stalled = false) {
  const alts = (img.dataset.alt || '').split(' ').filter(Boolean);
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (stalled) img.dataset.stalled = '1';
  else if (!offline) {
    const h = hostOf(img.currentSrc || img.src);
    fails.set(h, [...(fails.get(h) || []), Date.now()].slice(-10));
  }
  if (!alts.length) {
    // Rebuilt lists won't restart the chain: 10 min for an icon every source refused, under a
    // minute when it was only slow or the device was offline.
    dead.set(img.dataset.icon, Date.now() + (img.dataset.stalled || offline ? 45_000 : DEAD_MS));
    img.remove(); // the initials underneath stay
    return;
  }
  img.dataset.alt = alts.slice(1).join(' ');
  if (img.dataset.t0) img.dataset.t0 = String(Date.now());
  img.src = alts[0];
}

let installed = false;
/** Once per page: error → next source; a source that stalls is replaced too. */
export function installIconFallbacks() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  // Load errors don't bubble, but they can be caught on the way down.
  document.addEventListener('error', (e) => e.target?.tagName === 'IMG' && e.target.dataset.icon != null && next(e.target), true);
  document.addEventListener('load', (e) => e.target?.tagName === 'IMG' && e.target.dataset.icon != null && oks.add(hostOf(e.target.currentSrc || e.target.src)), true);
  window.addEventListener('online', () => dead.clear());
  // The stall clock runs only while an icon is really visible (IntersectionObserver also clips
  // by scroll boxes) — lazy icons off screen haven't started loading.
  const io =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (e.isIntersecting) e.target.dataset.t0 ||= String(Date.now());
            else delete e.target.dataset.t0;
          }
        })
      : null;
  const watch = (root) => {
    if (!io || root.nodeType !== 1) return;
    if (root.matches('img[data-icon]')) io.observe(root);
    for (const img of root.querySelectorAll('img[data-icon]')) io.observe(img);
  };
  if (io) {
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) watch(n);
    }).observe(document.documentElement, { childList: true, subtree: true });
    watch(document.documentElement);
  }
  // Back from the background (iOS suspends timers and loads): the clocks start over.
  const restart = () => {
    const now = String(Date.now());
    for (const img of document.querySelectorAll('img[data-icon][data-t0]')) img.dataset.t0 = now;
  };
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && restart());
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    last = now;
    if (document.hidden) return;
    if (gap > 3_000) return restart(); // the page was asleep
    for (const img of document.querySelectorAll('img[data-icon][data-t0]')) {
      if (img.complete || !img.isConnected || !img.dataset.alt) continue;
      if (now - Number(img.dataset.t0) > STALL_MS) next(img, true);
    }
  }, 1_000);
}

/**
 * innerHTML that keeps the icons already in the element: a refresh rebuilding the markup every
 * second would otherwise restart every image download from scratch (and never finish slow ones).
 */
export function setHtml(el, html) {
  const keep = new Map(); // icon URL → its existing <img> nodes, in order (copycats share icons)
  for (const img of el.querySelectorAll('img[data-icon]')) {
    const q = keep.get(img.dataset.icon);
    if (q) q.push(img);
    else keep.set(img.dataset.icon, [img]);
  }
  el.innerHTML = html;
  if (!keep.size) return;
  for (const img of el.querySelectorAll('img[data-icon]')) {
    const old = keep.get(img.dataset.icon)?.shift();
    if (old && old !== img) img.replaceWith(old);
  }
}
