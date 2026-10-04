window.__MR_VERSION = 'muu8pwir';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=muu8pwir';

window.__MR_ENGINE = engine;
await import('./app.js?v=muu8pwir');
