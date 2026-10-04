window.__MR_VERSION = 'mutpbd0j';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mutpbd0j';

window.__MR_ENGINE = engine;
await import('./app.js?v=mutpbd0j');
