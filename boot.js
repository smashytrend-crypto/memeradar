window.__MR_VERSION = 'muu8yg5w';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=muu8yg5w';

window.__MR_ENGINE = engine;
await import('./app.js?v=muu8yg5w');
