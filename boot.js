window.__MR_VERSION = 'mv2nguv7';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mv2nguv7';

window.__MR_ENGINE = engine;
await import('./app.js?v=mv2nguv7');
