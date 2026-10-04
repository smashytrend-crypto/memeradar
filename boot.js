window.__MR_VERSION = 'muu8d6ti';
// Starts the in-browser engine, then the regular UI (which detects it and skips the server).
import { engine } from './engine.js?v=muu8d6ti';

window.__MR_ENGINE = engine;
await import('./app.js?v=muu8d6ti');
