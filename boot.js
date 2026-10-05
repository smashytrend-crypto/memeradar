window.__MR_VERSION = 'muut7dva';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=muut7dva';

window.__MR_ENGINE = engine;
await import('./app.js?v=muut7dva');
