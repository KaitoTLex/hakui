import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteTransaction, upsertTransaction } from '$lib/server/database';
import { transactionInputSchema } from '$lib/validation';

export const PUT: RequestHandler = async ({ request, params }) => {
  const input = transactionInputSchema.safeParse(await request.json());
  if (!input.success || input.data.id !== params.id) {
    error(400, input.success ? 'Transaction ID does not match URL.' : input.error.issues[0]?.message);
  }
  try {
    return json(upsertTransaction(input.data));
  } catch (cause) {
    error(409, cause instanceof Error ? cause.message : 'Unable to save transaction.');
  }
};

export const DELETE: RequestHandler = ({ params, request }) => {
  const expectedRevision = Number(request.headers.get('x-hakui-revision'));
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) error(400, 'A valid transaction revision is required.');
  try {
    deleteTransaction(params.id, expectedRevision);
    return new Response(null, { status: 204 });
  } catch (cause) {
    error(409, cause instanceof Error ? cause.message : 'Unable to delete transaction.');
  }
};
