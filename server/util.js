export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

/** Minimal event emitter that runs in Node and in the browser (the engine runs in both). */
export class Emitter {
  #handlers = new Map();
  on(event, fn) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(fn);
    return this;
  }
  off(event, fn) {
    this.#handlers.get(event)?.delete(fn);
    return this;
  }
  emit(event, ...args) {
    for (const fn of this.#handlers.get(event) || []) fn(...args);
    return this;
  }
}
export const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

/** Number(v) or undefined when not finite. */
export const num = (v) => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Parses an ISO date / epoch (s or ms) into epoch ms, or undefined. */
export const toMs = (v) => {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : undefined;
};

export const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isMint = (s) => typeof s === 'string' && MINT_RE.test(s);

export class HttpError extends Error {
  constructor(status, url, headers) {
    super(`HTTP ${status} for ${url.split('?')[0]}`);
    this.status = status;
    this.headers = headers;
  }
}

/** fetch JSON with timeout; throws HttpError on non-2xx. */
export async function getJSON(url, { headers = {}, timeout = 12000, onHeaders } = {}) {
  const res = await fetch(url, {
    // In a browser a custom user-agent would force a CORS preflight, so only send it from Node.
    headers: { accept: 'application/json', ...(IS_BROWSER ? {} : { 'user-agent': 'memeradar/1.0' }), ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  onHeaders?.(res.headers);
  if (!res.ok) throw new HttpError(res.status, url, res.headers);
  return res.json();
}

/**
 * Spaces calls evenly to stay under a requests-per-minute budget.
 * Only the waiting is serialized; the calls themselves may overlap.
 */
export class RateLimiter {
  constructor(perMinute) {
    this.interval = 60000 / Math.max(perMinute, 0.01);
    this.next = 0;
    this.pausedUntil = 0;
    this.chain = Promise.resolve();
  }

  async run(fn) {
    const slot = this.chain.then(async () => {
      const now = Date.now();
      const at = Math.max(this.next, this.pausedUntil, now);
      this.next = at + this.interval;
      if (at > now) await sleep(at - now);
    });
    this.chain = slot;
    await slot;
    return fn();
  }

  /** Back off (e.g. after HTTP 429). */
  pause(ms) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }
}

/**
 * Runs fn every `ms`, never overlapping, swallowing (and reporting) errors. With `gate`, the loop
 * idles while gate() is false (e.g. the engine of a network the viewer isn't looking at).
 */
export function every(ms, fn, onError, gate) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      if (gate && !gate()) {
        await sleep(500);
        continue;
      }
      try {
        await fn();
      } catch (err) {
        onError?.(err);
      }
      await sleep(ms);
    }
  })();
  return () => {
    stopped = true;
  };
}

/** Human-friendly error message for source status. */
export function errMsg(err) {
  if (err instanceof HttpError) return err.status === 429 ? 'limit zapytań (429)' : `HTTP ${err.status}`;
  if (err?.name === 'TimeoutError') return 'timeout';
  return err?.cause?.code || err?.message || String(err);
}
