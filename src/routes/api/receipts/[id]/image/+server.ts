import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getReceipt } from '$lib/server/database';

export const GET: RequestHandler = ({ params }) => {
  const receipt = getReceipt(params.id);
  if (!receipt) error(404, 'Receipt not found.');
  return new Response(new Uint8Array(receipt.image), {
    headers: { 'content-type': receipt.mimeType, 'cache-control': 'private, max-age=86400' }
  });
};
