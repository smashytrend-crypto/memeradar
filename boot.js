window.__MR_VERSION = 'muua81b1';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=muua81b1';

window.__MR_ENGINE = engine;
await import('./app.js?v=muua81b1');
