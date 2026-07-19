import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const configSchema = z.object({
  server: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    origin: z.url(),
    bodySizeLimit: z.string().regex(/^\d+[KMG]?$/i)
  }),
  storage: z.object({
    databasePath: z.string().min(1),
    backupDirectory: z.string().min(1),
    initialCsvPath: z.string().min(1)
  }),
  trip: z.object({
    timezone: z.string().min(1),
    currency: z.literal('JPY')
  }),
  receipts: z.object({
    maxUploadBytes: z.number().int().positive(),
    maxPixels: z.number().int().positive(),
    jpegMaxEdge: z.number().int().min(640).max(4096),
    jpegQuality: z.number().min(0.1).max(1)
  }),
  ocr: z.object({
    languages: z.array(z.string().min(1)).min(1),
    timeoutSeconds: z.number().int().min(5).max(120),
    maxConcurrentJobs: z.number().int().min(1).max(4),
    translationFallback: z.boolean()
  })
});

export type HakuiConfig = z.infer<typeof configSchema>;

let cachedConfig: HakuiConfig | undefined;

function workspacePath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

export function loadConfig(): HakuiConfig {
  if (cachedConfig) return cachedConfig;

  const path = workspacePath(process.env.HAKUI_CONFIG ?? './config/hakui.json');
  const parsed = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  parsed.storage.databasePath = workspacePath(parsed.storage.databasePath);
  parsed.storage.backupDirectory = workspacePath(parsed.storage.backupDirectory);
  parsed.storage.initialCsvPath = workspacePath(parsed.storage.initialCsvPath);
  cachedConfig = parsed;
  return parsed;
}
