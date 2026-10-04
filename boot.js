window.__MR_VERSION = 'mutn7xhe';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mutn7xhe';

window.__MR_ENGINE = engine;
await import('./app.js?v=mutn7xhe');
