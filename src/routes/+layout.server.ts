import type { LayoutServerLoad } from './$types';
import { getSnapshot } from '$lib/server/database';

export const load: LayoutServerLoad = () => ({ snapshot: getSnapshot() });
