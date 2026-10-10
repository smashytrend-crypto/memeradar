window.__MR_VERSION = 'mv2qm0je';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mv2qm0je';

window.__MR_ENGINE = engine;
await import('./app.js?v=mv2qm0je');
