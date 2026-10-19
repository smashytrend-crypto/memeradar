const pageVersion = document.querySelector('meta[name="mr-version"]')?.content || window.__MR_VERSION;
if (pageVersion && pageVersion !== 'mveuyl2z') {
  let tried = '1';
  try {
    tried = sessionStorage.getItem('mr:vfix');
    sessionStorage.setItem('mr:vfix', 'mveuyl2z');
  } catch {}
  if (tried !== 'mveuyl2z') {
    location.replace(location.pathname + '?v=mveuyl2z' + location.hash);
    throw new Error('stale page');
  }
}
window.__MR_VERSION = 'mveuyl2z';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mveuyl2z';

window.__MR_ENGINE = engine;
await import('./app.js?v=mveuyl2z');
