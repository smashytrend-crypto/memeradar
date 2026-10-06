window.__MR_VERSION = 'mux6rwf6';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mux6rwf6';

window.__MR_ENGINE = engine;
await import('./app.js?v=mux6rwf6');
