window.__MR_VERSION = 'mutlqg2c';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mutlqg2c';

window.__MR_ENGINE = engine;
await import('./app.js?v=mutlqg2c');
