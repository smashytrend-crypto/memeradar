const pageVersion = document.querySelector('meta[name="mr-version"]')?.content || window.__MR_VERSION;
if (pageVersion && pageVersion !== 'mvegrk6b') {
  let tried = '1';
  try {
    tried = sessionStorage.getItem('mr:vfix');
    sessionStorage.setItem('mr:vfix', 'mvegrk6b');
  } catch {}
  if (tried !== 'mvegrk6b') {
    location.replace(location.pathname + '?v=mvegrk6b' + location.hash);
    throw new Error('stale page');
  }
}
window.__MR_VERSION = 'mvegrk6b';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mvegrk6b';

window.__MR_ENGINE = engine;
await import('./app.js?v=mvegrk6b');
