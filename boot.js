window.__MR_VERSION = 'mutnqo4b';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mutnqo4b';

window.__MR_ENGINE = engine;
await import('./app.js?v=mutnqo4b');
