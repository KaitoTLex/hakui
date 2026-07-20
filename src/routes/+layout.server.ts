import type { LayoutServerLoad } from './$types';
import { loadSnapshot } from '$lib/server/backend';

export const load: LayoutServerLoad = () => loadSnapshot();
