if (window.__MR_VERSION && window.__MR_VERSION !== 'mv2zx1lk') {
  let tried = '1';
  try {
    tried = sessionStorage.getItem('mr:vfix');
    sessionStorage.setItem('mr:vfix', 'mv2zx1lk');
  } catch {}
  if (tried !== 'mv2zx1lk') {
    location.replace(location.pathname + '?v=mv2zx1lk' + location.hash);
    throw new Error('stale page');
  }
}
window.__MR_VERSION = 'mv2zx1lk';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mv2zx1lk';

window.__MR_ENGINE = engine;
await import('./app.js?v=mv2zx1lk');
