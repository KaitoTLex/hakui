import { json } from '@sveltejs/kit';
import { getSnapshot } from '$lib/server/database';

export const GET = () => json(getSnapshot(), { headers: { 'cache-control': 'no-store' } });
