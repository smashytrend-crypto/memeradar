if (window.__MR_VERSION && window.__MR_VERSION !== 'mv75y801') {
  let tried = '1';
  try {
    tried = sessionStorage.getItem('mr:vfix');
    sessionStorage.setItem('mr:vfix', 'mv75y801');
  } catch {}
  if (tried !== 'mv75y801') {
    location.replace(location.pathname + '?v=mv75y801' + location.hash);
    throw new Error('stale page');
  }
}
window.__MR_VERSION = 'mv75y801';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mv75y801';

window.__MR_ENGINE = engine;
await import('./app.js?v=mv75y801');
