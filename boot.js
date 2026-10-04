window.__MR_VERSION = 'muu85t1w';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=muu85t1w';

window.__MR_ENGINE = engine;
await import('./app.js?v=muu85t1w');
