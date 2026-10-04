window.__MR_VERSION = 'mutlbs4f';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mutlbs4f';

window.__MR_ENGINE = engine;
await import('./app.js?v=mutlbs4f');
