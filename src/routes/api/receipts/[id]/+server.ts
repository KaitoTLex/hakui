import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  beginReceipt,
  completeReceipt,
  createReceipt,
  failReceipt,
  getReceipt,
  getTransactionRevision,
  upsertTransaction
} from '$lib/server/database';
import { loadConfig } from '$lib/server/config';
import { enqueueOcr } from '$lib/server/ocr';
import { transactionInputSchema } from '$lib/validation';

export const GET: RequestHandler = ({ params }) => {
  const receipt = getReceipt(params.id);
  if (!receipt) error(404, 'Receipt not found.');
  const { image: _, ...metadata } = receipt;
  return json({ ...metadata, extraction: metadata.extractedJson ? JSON.parse(metadata.extractedJson) : null });
};

export const PUT: RequestHandler = async ({ request, params }) => {
  const existing = getReceipt(params.id);
  const form = await request.formData();
  const rawTransaction = form.get('transaction');
  const file = form.get('receipt');
  if (typeof rawTransaction !== 'string' || !(file instanceof File)) error(400, 'Transaction and receipt image are required.');
  const input = transactionInputSchema.safeParse(JSON.parse(rawTransaction));
  if (!input.success) error(400, input.error.issues[0]?.message);
  if (existing?.transactionId !== undefined && existing.transactionId !== input.data.id) {
    error(409, 'Receipt belongs to a different transaction.');
  }
  const serverRevision = getTransactionRevision(input.data.id);
  if (existing && serverRevision !== null && input.data.revision > serverRevision) upsertTransaction(input.data);
  if (existing?.ocrState === 'complete') return json({ receiptId: existing.id, state: existing.ocrState });
  if (existing?.ocrState === 'processing') return json({ receiptId: existing.id, state: existing.ocrState }, { status: 202 });
  const config = loadConfig();
  if (file.size > config.receipts.maxUploadBytes) error(413, 'Receipt image is too large.');

  const image = new Uint8Array(await file.arrayBuffer());
  if (!existing) {
    upsertTransaction({ ...input.data, status: 'pending_ocr', source: 'scan' });
    createReceipt(params.id, input.data.id, image, file.type || 'application/octet-stream');
  }
  beginReceipt(params.id);
  try {
    const result = await enqueueOcr(image);
    completeReceipt(params.id, result.text, result.extraction, result.mimeType);
    return json({ receiptId: params.id, state: 'complete', extraction: result.extraction });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Receipt OCR failed.';
    failReceipt(params.id, message);
    return json({ receiptId: params.id, state: 'failed', error: message }, { status: 202 });
  }
};
