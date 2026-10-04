window.__MR_VERSION = 'muu4nwbk';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=muu4nwbk';

window.__MR_ENGINE = engine;
await import('./app.js?v=muu4nwbk');
