if (window.__MR_VERSION && window.__MR_VERSION !== 'mv75c9is') {
  let tried = '1';
  try {
    tried = sessionStorage.getItem('mr:vfix');
    sessionStorage.setItem('mr:vfix', 'mv75c9is');
  } catch {}
  if (tried !== 'mv75c9is') {
    location.replace(location.pathname + '?v=mv75c9is' + location.hash);
    throw new Error('stale page');
  }
}
window.__MR_VERSION = 'mv75c9is';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mv75c9is';

window.__MR_ENGINE = engine;
await import('./app.js?v=mv75c9is');
