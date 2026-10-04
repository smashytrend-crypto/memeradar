window.__MR_VERSION = 'muuc3hva';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=muuc3hva';

window.__MR_ENGINE = engine;
await import('./app.js?v=muuc3hva');
