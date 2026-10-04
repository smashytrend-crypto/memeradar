window.__MR_VERSION = 'mutm9tuk';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mutm9tuk';

window.__MR_ENGINE = engine;
await import('./app.js?v=mutm9tuk');
