window.__MR_VERSION = 'mv2uwc6i';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mv2uwc6i';

window.__MR_ENGINE = engine;
await import('./app.js?v=mv2uwc6i');
