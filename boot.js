if (window.__MR_VERSION && window.__MR_VERSION !== 'mvdpxmv5') {
  let tried = '1';
  try {
    tried = sessionStorage.getItem('mr:vfix');
    sessionStorage.setItem('mr:vfix', 'mvdpxmv5');
  } catch {}
  if (tried !== 'mvdpxmv5') {
    location.replace(location.pathname + '?v=mvdpxmv5' + location.hash);
    throw new Error('stale page');
  }
}
window.__MR_VERSION = 'mvdpxmv5';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mvdpxmv5';

window.__MR_ENGINE = engine;
await import('./app.js?v=mvdpxmv5');
