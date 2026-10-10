window.__MR_VERSION = 'mv2qi6wu';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mv2qi6wu';

window.__MR_ENGINE = engine;
await import('./app.js?v=mv2qi6wu');
