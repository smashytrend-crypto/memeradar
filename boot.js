window.__MR_VERSION = 'mutov394';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mutov394';

window.__MR_ENGINE = engine;
await import('./app.js?v=mutov394');
