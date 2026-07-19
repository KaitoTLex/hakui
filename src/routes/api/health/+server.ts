import { json } from '@sveltejs/kit';
import { getSnapshot } from '$lib/server/database';

export const GET = () => {
  const snapshot = getSnapshot();
  return json({ status: 'ok', transactions: snapshot.transactions.length });
};
