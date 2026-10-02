// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=murf2dkr';

window.__MR_ENGINE = engine;
await import('./app.js?v=murf2dkr');
