import { pathToFileURL } from 'node:url';
import { startServer } from './web/server.js';

export * from './config/index.js';
export * from './api/index.js';
export * from './services/index.js';
export * from './types/index.js';
export * from './utils/index.js';
export * from './web/index.js';

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryUrl) startServer();
