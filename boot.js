// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=murdi7b2';

window.__MR_ENGINE = engine;
await import('./app.js?v=murdi7b2');
