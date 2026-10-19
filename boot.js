const pageVersion = document.querySelector('meta[name="mr-version"]')?.content || window.__MR_VERSION;
if (pageVersion && pageVersion !== 'mvfudd8b') {
  let tried = '1';
  try {
    tried = sessionStorage.getItem('mr:vfix');
    sessionStorage.setItem('mr:vfix', 'mvfudd8b');
  } catch {}
  if (tried !== 'mvfudd8b') {
    location.replace(location.pathname + '?v=mvfudd8b' + location.hash);
    throw new Error('stale page');
  }
}
window.__MR_VERSION = 'mvfudd8b';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mvfudd8b';

window.__MR_ENGINE = engine;
await import('./app.js?v=mvfudd8b');
