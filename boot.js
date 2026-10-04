window.__MR_VERSION = 'mutmsx0x';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mutmsx0x';

window.__MR_ENGINE = engine;
await import('./app.js?v=mutmsx0x');
