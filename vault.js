// Key vault for real trading. The private key is never stored in readable form:
//  • at rest: AES-256-GCM ciphertext of the 32-byte seed, key derived from the user's password
//    with PBKDF2-SHA256 (600 000 iterations, random salt) — only the ciphertext and the public
//    address live in IndexedDB;
//  • when unlocked: imported into WebCrypto as a NON-EXTRACTABLE Ed25519 key — it can sign, but no
//    code can read it back out; no extractable copy is ever made (the key is checked by signing
//    and verifying a random challenge), and the decrypted bytes are wiped right after the import;
//  • failed passwords are throttled in the app (persisted and re-read on every attempt). Someone
//    holding the device could still try passwords offline: the password's strength and the 600 000
//    PBKDF2 rounds are the real protection.
// There is deliberately no way to display or export the key from the app. While unlocked, code
// running in the page could still ask it to sign — hence the strict CSP and the transaction checks.

import { b58decode, b58encode } from './solana.js?v=mvegrk6b';

const ITER = 600_000;
const PKCS8_ED25519 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
export const MIN_PASSWORD = 12;

/** Why a password is too weak to protect the key (offline guessing), or null. */
export function weakPassword(pw) {
  const s = String(pw || '');
  if (s.length < MIN_PASSWORD) return `Hasło musi mieć co najmniej ${MIN_PASSWORD} znaków`;
  if (new Set(s.toLowerCase()).size < 6) return 'Hasło ma za mało różnych znaków';
  const low = s.toLowerCase();
  for (const run of ['0123456789012', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm', 'qwertzuiopasdfghjklyxcvbnm', '1qaz2wsx3edc4rfv']) {
    const back = [...run].reverse().join('');
    for (let i = 0; i + 6 <= low.length; i++) if (run.includes(low.slice(i, i + 6)) || back.includes(low.slice(i, i + 6))) return 'Hasło zawiera prosty ciąg znaków (np. 123456, qwerty)';
  }
  if (/^(.{1,3})\1+$/.test(low)) return 'Hasło to powtórzony fragment';
  if (/^(password|haslo|hasło|solana|phantom|bitcoin|memecoin|dmn)/.test(low) && s.length < 16) return 'Hasło jest zbyt oczywiste';
  return null;
}

/** Accepts a Phantom / Solflare base58 export or a solana-keygen JSON byte array (64 bytes: seed + public key). */
export function parseSecret(text) {
  if (text && typeof text === 'object' && text.seed instanceof Uint8Array) return text; // already parsed
  const s = String(text || '').trim();
  let bytes;
  if (s.startsWith('[')) {
    let arr;
    try {
      arr = JSON.parse(s);
    } catch {
      throw new Error('Nie rozumiem tego klucza');
    }
    if (!Array.isArray(arr) || arr.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error('Nie rozumiem tego klucza');
    bytes = Uint8Array.from(arr);
  } else bytes = b58decode(s);
  // 32 bytes is what a wallet ADDRESS decodes to: refused, never mistaken for a key.
  if (bytes.length === 32) {
    bytes.fill(0);
    throw new Error('To jest adres walletu (publiczny), a nie klucz prywatny — w Phantom wybierz „Pokaż klucz prywatny”');
  }
  if (bytes.length !== 64) {
    bytes.fill(0);
    throw new Error('Klucz prywatny Solany ma 64 bajty (eksport z Phantom / Solflare) — to nie wygląda na klucz');
  }
  const seed = bytes.slice(0, 32);
  const claimedPub = bytes.slice(32);
  bytes.fill(0);
  return { seed, claimedPub };
}

const pkcs8 = (seed) => {
  const out = new Uint8Array(48);
  out.set(PKCS8_ED25519);
  out.set(seed, 16);
  return out;
};

/** IndexedDB record store (one record). */
export function idbStore(name = 'dmn-vault') {
  const open = () =>
    new Promise((res, rej) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('v');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('v', mode);
      const q = fn(t.objectStore('v'));
      t.oncomplete = () => res(q?.result);
      t.onerror = () => rej(t.error);
    }).finally(() => db.close());
  };
  return {
    get: () => tx('readonly', (s) => s.get('key')),
    set: (v) => tx('readwrite', (s) => s.put(v, 'key')),
    del: () => tx('readwrite', (s) => s.delete('key')),
  };
}

export function createVault(store = idbStore(), cr = globalThis.crypto) {
  const subtle = cr.subtle;
  let rec = null; // { v, pub, salt, iv, ct, iter, fails, waitUntil }
  let key = null; // non-extractable CryptoKey while unlocked
  let supported = null;
  let busy = false;

  async function checkSupport() {
    if (supported != null) return supported;
    try {
      const seed = cr.getRandomValues(new Uint8Array(32));
      const k = await subtle.importKey('pkcs8', pkcs8(seed), { name: 'Ed25519' }, false, ['sign']);
      await subtle.sign({ name: 'Ed25519' }, k, new Uint8Array(1));
      seed.fill(0);
      supported = true;
    } catch {
      supported = false;
    }
    return supported;
  }

  async function deriveAes(password, salt, iter) {
    const pw = new TextEncoder().encode(password);
    try {
      const base = await subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveKey']);
      // Never fewer rounds than ours, whatever a stored record says.
      return await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: Math.max(ITER, iter || 0) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    } finally {
      pw.fill(0);
    }
  }

  /** A non-extractable signing key for `seed` (the seed is wiped). */
  async function keyOf(seed) {
    const pk = pkcs8(seed);
    try {
      return await subtle.importKey('pkcs8', pk, { name: 'Ed25519' }, false, ['sign']);
    } finally {
      pk.fill(0);
      seed.fill(0);
    }
  }
  /** Whether `k` signs for public key `pub` (a random challenge, verified — nothing is exported). */
  async function signsFor(k, pub) {
    const challenge = cr.getRandomValues(new Uint8Array(32));
    const sig = await subtle.sign({ name: 'Ed25519' }, k, challenge);
    const vk = await subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    return subtle.verify({ name: 'Ed25519' }, vk, sig, challenge);
  }

  async function load() {
    rec = (await store.get()) || null;
    return rec;
  }


  return {
    checkSupport,
    load,
    status: () => ({ hasKey: !!rec, unlocked: !!key, pub: rec?.pub || null, waitUntil: rec?.waitUntil || 0 }),

    /** Encrypts and stores a new key (replaces any old one) and leaves the vault unlocked. */
    async importKey(secret, password) {
      let parsed = null;
      try {
        if (!(await checkSupport())) throw new Error('Ta przeglądarka nie obsługuje bezpiecznego podpisu Ed25519 — zaktualizuj iOS / przeglądarkę');
        const weak = weakPassword(password);
        if (weak) throw new Error(weak);
        parsed = parseSecret(secret);
        // Never over a key saved meanwhile (e.g. in another tab): that one is removed first, on purpose.
        if (await store.get()) throw new Error('Na tym urządzeniu jest już zapisany klucz — odśwież stronę');
        const { seed, claimedPub } = parsed;
        const salt = cr.getRandomValues(new Uint8Array(16));
        const iv = cr.getRandomValues(new Uint8Array(12));
        const aes = await deriveAes(password, salt, ITER);
        const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, aes, seed));
        const k = await keyOf(seed.slice());
        if (!(await signsFor(k, claimedPub))) throw new Error('Klucz jest uszkodzony (część publiczna się nie zgadza)');
        const next = { v: 1, pub: b58encode(claimedPub), salt, iv, ct, iter: ITER, fails: 0, waitUntil: 0, lastFail: 0 };
        await store.set(next);
        rec = next;
        key = k;
        return rec.pub;
      } finally {
        parsed?.seed.fill(0);
        parsed?.claimedPub?.fill(0);
      }
    },

    /** Decrypts with the password into a non-extractable signing key. */
    async unlock(password) {
      if (busy) throw new Error('Sprawdzam hasło…');
      busy = true;
      let seed = null;
      try {
        // Always the stored record: another tab's failed attempts count too.
        const r = await load();
        if (!r) throw new Error('Brak zapisanego klucza');
        const now = Date.now();
        // A clock moved back past the last failure doesn't lift the wait either.
        if (r.fails >= 5 && (now < (r.waitUntil || 0) || now < (r.lastFail || 0))) {
          throw new Error(`Za dużo błędnych prób — spróbuj za ${Math.max(1, Math.ceil(((r.waitUntil || now) - now) / 1000))} s`);
        }
        try {
          const aes = await deriveAes(String(password || ''), r.salt, r.iter);
          seed = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: r.iv }, aes, r.ct));
        } catch {
          r.fails = (r.fails || 0) + 1;
          r.lastFail = Date.now();
          if (r.fails >= 5) r.waitUntil = Date.now() + Math.min(3600_000, 30_000 * 2 ** (r.fails - 5));
          await store.set(r);
          throw new Error(r.fails >= 5 ? 'Błędne hasło — kolejna próba za chwilę' : 'Błędne hasło');
        }
        // The decrypted key must still belong to the saved address.
        const k = await keyOf(seed);
        if (!(await signsFor(k, b58decode(r.pub)))) throw new Error('Zapisany klucz nie pasuje do adresu');
        if (rec !== r) throw new Error('Klucz został zmieniony — spróbuj jeszcze raz');
        key = k;
        if (r.fails) {
          r.fails = 0;
          r.waitUntil = 0;
          await store.set(r);
        }
        return r.pub;
      } finally {
        seed?.fill(0);
        busy = false;
      }
    },

    lock() {
      key = null;
    },

    /** Ed25519 signature of `message` (the vault must be unlocked). */
    async sign(message) {
      if (!key) throw new Error('Wallet zablokowany — odblokuj go hasłem');
      return new Uint8Array(await subtle.sign({ name: 'Ed25519' }, key, message));
    },

    /** Deletes the stored key for good. */
    async remove() {
      key = null;
      rec = null;
      await store.del();
    },
  };
}
