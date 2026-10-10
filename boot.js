window.__MR_VERSION = 'mv29k8ss';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mv29k8ss';

window.__MR_ENGINE = engine;
await import('./app.js?v=mv29k8ss');
