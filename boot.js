window.__MR_VERSION = 'mutlkci3';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mutlkci3';

window.__MR_ENGINE = engine;
await import('./app.js?v=mutlkci3');
