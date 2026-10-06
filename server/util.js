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
    this.queue = [];
    this.timer = null;
    this.bursts = []; // times of priority jobs let through early
    this.probeAt = 0; // last chart job let through a pause
  }

  /**
   * Runs fn in the next free slot; `priority` jumps the queue (something the viewer is waiting for).
   * A number ranks priority jobs (higher first: 2 = the chart before 1 = trades and the rest).
   */
  run(fn, priority = false) {
    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject, priority: Number(priority) || 0 };
      if (job.priority) {
        // Newest first within its rank, behind any job of a higher rank.
        const i = this.queue.findIndex((j) => j.priority <= job.priority);
        this.queue.splice(i < 0 ? this.queue.length : i, 0, job);
      } else this.queue.push(job);
      this.#pump();
    });
  }

  #pump() {
    if (!this.queue.length) return;
    const now = Date.now();
    // Something the viewer waits for may jump the spacing (not a pause), at most three times a minute:
    // the free tiers allow short bursts above the average rate we keep to.
    if (this.queue[0].priority && this.pausedUntil <= now && this.next > now) {
      this.bursts = this.bursts.filter((t) => now - t < 60_000);
      if (this.bursts.length < 3) {
        this.bursts.push(now);
        const job = this.queue.shift();
        Promise.resolve().then(job.fn).then(job.resolve, job.reject);
        return this.#pump();
      }
    }
    // During a back-off pause the chart's request (rank 2) may still go out as a probe every 10 s:
    // the free tiers count per minute, so a chart should not wait out a pause (up to 2 min) that a
    // background call caused. A probe that succeeds ends the pause.
    if (this.queue[0].priority >= 2 && this.pausedUntil > now && now - this.probeAt >= 10_000) {
      this.probeAt = now;
      const job = this.queue.shift();
      Promise.resolve()
        .then(job.fn)
        .then((v) => {
          this.resume();
          job.resolve(v);
        }, job.reject);
      return this.#pump();
    }
    let at = Math.max(this.next, this.pausedUntil, now);
    if (this.queue[0].priority >= 2 && this.pausedUntil > now) at = Math.min(at, this.probeAt + 10_000);
    if (at > now) {
      // Re-arm when a priority job brings the wake-up forward.
      if (this.timer && this.timerAt <= at) return;
      clearTimeout(this.timer);
      this.timerAt = at;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.#pump();
      }, at - now);
      return;
    }
    if (this.timer) return;
    this.next = now + this.interval;
    const job = this.queue.shift();
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject);
    this.#pump();
  }

  /** Back off (e.g. after HTTP 429). */
  pause(ms) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  /** Ends a back-off pause early (a request just went through, so the limit is not hit). */
  resume() {
    if (this.pausedUntil <= Date.now()) return;
    this.pausedUntil = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.#pump();
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
