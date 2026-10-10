window.__MR_VERSION = 'mv2dlcgj';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mv2dlcgj';

window.__MR_ENGINE = engine;
await import('./app.js?v=mv2dlcgj');
