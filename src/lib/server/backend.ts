import type { AppSnapshot } from '$lib/types';

const backendUrl = (process.env.HAKUI_API_URL ?? 'http://127.0.0.1:3005').replace(/\/$/, '');

export const unavailableSnapshot: AppSnapshot = {
  trip: {
    id: '00000000-0000-0000-0000-000000000000',
    name: 'Japan 2026',
    currency: 'JPY',
    overallBudgetYen: 0,
    startsOn: null,
    endsOn: null,
    active: true,
    settingsRevision: 0
  },
  legs: [],
  categories: [],
  transactions: [],
  currentLegId: null
};

export async function backendRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${backendUrl}/${path.replace(/^\//, '')}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(15_000)
  });
}

export async function loadSnapshot(): Promise<{ snapshot: AppSnapshot; backendAvailable: boolean }> {
  try {
    const response = await backendRequest('/snapshot', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(2_000)
    });
    if (!response.ok) throw new Error(`Backend returned ${response.status}`);
    return { snapshot: await response.json(), backendAvailable: true };
  } catch (cause) {
    console.error('Hakui backend is unavailable; serving the offline shell.', cause);
    return { snapshot: unavailableSnapshot, backendAvailable: false };
  }
}
