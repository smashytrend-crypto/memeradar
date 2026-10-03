// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=mus7ukpe';

window.__MR_ENGINE = engine;
await import('./app.js?v=mus7ukpe');
