// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mus7jq3m';

window.__MR_ENGINE = engine;
await import('./app.js?v=mus7jq3m');
