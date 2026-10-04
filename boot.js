window.__MR_VERSION = 'mutxbptp';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mutxbptp';

window.__MR_ENGINE = engine;
await import('./app.js?v=mutxbptp');
