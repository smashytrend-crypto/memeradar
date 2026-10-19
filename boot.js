const pageVersion = document.querySelector('meta[name="mr-version"]')?.content || window.__MR_VERSION;
if (pageVersion && pageVersion !== 'mveuqr33') {
  let tried = '1';
  try {
    tried = sessionStorage.getItem('mr:vfix');
    sessionStorage.setItem('mr:vfix', 'mveuqr33');
  } catch {}
  if (tried !== 'mveuqr33') {
    location.replace(location.pathname + '?v=mveuqr33' + location.hash);
    throw new Error('stale page');
  }
}
window.__MR_VERSION = 'mveuqr33';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mveuqr33';

window.__MR_ENGINE = engine;
await import('./app.js?v=mveuqr33');
