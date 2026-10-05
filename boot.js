window.__MR_VERSION = 'muvpa7h6';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=muvpa7h6';

window.__MR_ENGINE = engine;
await import('./app.js?v=muvpa7h6');
