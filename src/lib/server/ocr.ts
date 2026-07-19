import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from './config';
import { linesToText, parseReceiptLines, parseTsv } from './receipt-parser';
import type { OcrExtraction } from '$lib/types';

const execute = promisify(execFile);
let queue = Promise.resolve();

export interface OcrResult {
  text: string;
  extraction: OcrExtraction;
  mimeType: string;
  width: number;
  height: number;
}

async function command(file: string, args: string[], timeout: number): Promise<string> {
  const { stdout } = await execute(file, args, { timeout, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' });
  return stdout;
}

async function translate(text: string, timeout: number): Promise<string> {
  if (!loadConfig().ocr.translationFallback) return '';
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(process.env.HAKUI_TRANSLATE_COMMAND ?? 'hakui-translate', [], { stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
      child.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (chunks.reduce((size, item) => size + item.length, 0) > 2 * 1024 * 1024) child.kill('SIGKILL');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
        else reject(new Error('Local translation failed.'));
      });
      child.stdin.end(text);
    });
  } catch {
    return '';
  }
}

async function processImage(image: Uint8Array): Promise<OcrResult> {
  const config = loadConfig();
  const timeout = config.ocr.timeoutSeconds * 1000;
  const directory = await mkdtemp(join(tmpdir(), 'hakui-ocr-'));
  const input = join(directory, 'receipt');
  const grayscale = join(directory, 'grayscale.png');
  const threshold = join(directory, 'threshold.png');
  try {
    await writeFile(input, image);
    const identity = await command('magick', ['identify', '-format', '%m %w %h', input], timeout);
    const [format, widthText, heightText] = identity.trim().split(/\s+/);
    const width = Number(widthText);
    const height = Number(heightText);
    const mimeTypes: Record<string, string> = { JPEG: 'image/jpeg', PNG: 'image/png', WEBP: 'image/webp', HEIC: 'image/heic' };
    if (!mimeTypes[format] || !Number.isFinite(width) || !Number.isFinite(height)) throw new Error('Unsupported receipt image.');
    if (width * height > config.receipts.maxPixels) throw new Error('Receipt image dimensions are too large.');

    await command('magick', [input, '-auto-orient', '-alpha', 'remove', '-alpha', 'off', '-colorspace', 'Gray', '-deskew', '40%', '-bordercolor', 'white', '-border', '20x20', '-strip', grayscale], timeout);
    await command('magick', [grayscale, '-contrast-stretch', '1%x1%', '-threshold', '65%', threshold], timeout);

    const language = config.ocr.languages.join('+');
    const variants = [
      await command('tesseract', [grayscale, 'stdout', '-l', language, '--oem', '1', '--psm', '4', 'tsv'], timeout),
      await command('tesseract', [threshold, 'stdout', '-l', language, '--oem', '1', '--psm', '6', 'tsv'], timeout)
    ];
    const parsed = variants.map((tsv) => {
      const lines = parseTsv(tsv);
      return { lines, extraction: parseReceiptLines(lines) };
    });
    let selected = parsed.reduce((best, item) => item.extraction.confidence > best.extraction.confidence ? item : best);
    if (selected.extraction.amountYen === null) {
      const translated = await translate(linesToText(selected.lines), timeout);
      selected = { lines: selected.lines, extraction: parseReceiptLines(selected.lines, translated) };
    }
    return { text: linesToText(selected.lines), extraction: selected.extraction, mimeType: mimeTypes[format], width, height };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function enqueueOcr(image: Uint8Array): Promise<OcrResult> {
  const result = queue.then(() => processImage(image));
  queue = result.then(() => undefined, () => undefined);
  return result;
}
