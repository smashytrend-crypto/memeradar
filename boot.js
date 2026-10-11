if (window.__MR_VERSION && window.__MR_VERSION !== 'mv3q1cma') {
  let tried = '1';
  try {
    tried = sessionStorage.getItem('mr:vfix');
    sessionStorage.setItem('mr:vfix', 'mv3q1cma');
  } catch {}
  if (tried !== 'mv3q1cma') {
    location.replace(location.pathname + '?v=mv3q1cma' + location.hash);
    throw new Error('stale page');
  }
}
window.__MR_VERSION = 'mv3q1cma';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mv3q1cma';

window.__MR_ENGINE = engine;
await import('./app.js?v=mv3q1cma');
