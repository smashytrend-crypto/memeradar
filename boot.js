if (window.__MR_VERSION && window.__MR_VERSION !== 'mv7p1tkk') {
  let tried = '1';
  try {
    tried = sessionStorage.getItem('mr:vfix');
    sessionStorage.setItem('mr:vfix', 'mv7p1tkk');
  } catch {}
  if (tried !== 'mv7p1tkk') {
    location.replace(location.pathname + '?v=mv7p1tkk' + location.hash);
    throw new Error('stale page');
  }
}
window.__MR_VERSION = 'mv7p1tkk';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mv7p1tkk';

window.__MR_ENGINE = engine;
await import('./app.js?v=mv7p1tkk');
