const pageVersion = document.querySelector('meta[name="mr-version"]')?.content || window.__MR_VERSION;
if (pageVersion && pageVersion !== 'mvef1tbm') {
  let tried = '1';
  try {
    tried = sessionStorage.getItem('mr:vfix');
    sessionStorage.setItem('mr:vfix', 'mvef1tbm');
  } catch {}
  if (tried !== 'mvef1tbm') {
    location.replace(location.pathname + '?v=mvef1tbm' + location.hash);
    throw new Error('stale page');
  }
}
window.__MR_VERSION = 'mvef1tbm';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mvef1tbm';

window.__MR_ENGINE = engine;
await import('./app.js?v=mvef1tbm');
