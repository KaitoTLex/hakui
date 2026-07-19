import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const configPath = resolve(process.env.HAKUI_CONFIG ?? './config/hakui.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));

process.env.HAKUI_CONFIG = configPath;
process.env.HOST = config.server.host;
process.env.PORT = String(config.server.port);
process.env.ORIGIN = config.server.origin;
process.env.BODY_SIZE_LIMIT = config.server.bodySizeLimit;
process.env.NODE_ENV = 'production';

await import('../build/index.js');
