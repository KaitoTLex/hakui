import { get, writable } from 'svelte/store';
import type { AppSnapshot, SettingsInput, Transaction, TransactionInput } from '$lib/types';
import {
  completeOutbox,
  getOutbox,
  getReceipt,
  markAttempt,
  queueDelete,
  queueSettings,
  queueUpsert,
  readCachedSnapshot,
  writeCachedSnapshot
} from './offline-db';

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

export const snapshot = writable<AppSnapshot | null>(null);
export const syncState = writable<SyncState>('idle');
export const pendingCount = writable(0);
export const syncError = writable<string | null>(null);
export const serviceAvailable = writable(true);
export const stateReady = writable(false);

let initialized = false;
let syncPromise: Promise<void> | null = null;
let syncRequested = false;
let pollTimer: number | null = null;

class SyncRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export async function initializeState(serverSnapshot: AppSnapshot, backendAvailable = true): Promise<void> {
  if (initialized) return;
  initialized = true;
  serviceAvailable.set(backendAvailable);
  const cached = await readCachedSnapshot();
  snapshot.set(cached ?? serverSnapshot);
  if (!cached && backendAvailable) await writeCachedSnapshot(serverSnapshot);
  stateReady.set(true);
  await updatePendingCount();
  window.addEventListener('online', () => void syncNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow();
  });
  void syncNow();
}

export async function replaceSnapshot(value: AppSnapshot): Promise<void> {
  snapshot.set(value);
  await writeCachedSnapshot(value);
}

async function updatePendingCount(): Promise<void> {
  pendingCount.set((await getOutbox()).length);
}

export async function saveLocalTransaction(input: TransactionInput, receipt?: Blob): Promise<void> {
  if (!get(snapshot)) throw new Error('Application data is not ready.');
  const pendingReceiptId = await queueUpsert(input, receipt);
  const current = get(snapshot);
  if (!current) throw new Error('Application data is not ready.');
  const existing = current.transactions.find((transaction) => transaction.id === input.id);
  const now = new Date().toISOString();
  const transaction: Transaction = {
    ...input,
    tripId: current.trip.id,
    receiptId: existing?.receiptId ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  const next = {
    ...current,
    transactions: [transaction, ...current.transactions.filter((item) => item.id !== input.id)]
  };
  transaction.receiptId ??= pendingReceiptId ?? null;
  await replaceSnapshot(next);
  await updatePendingCount();
  if (navigator.storage?.persist) void navigator.storage.persist();
  await syncItem(input.id);
}

export async function saveLocalSettings(input: SettingsInput): Promise<void> {
  if (!get(snapshot)) throw new Error('Application data is not ready.');
  await queueSettings(input);
  const current = get(snapshot);
  if (!current) throw new Error('Application data is not ready.');
  const legs = new Map(input.legs.map((leg) => [leg.id, leg]));
  await replaceSnapshot({
    ...current,
    trip: { ...current.trip, overallBudgetYen: input.overallBudgetYen },
    currentLegId: input.currentLegId,
    legs: current.legs.map((leg) => {
      const update = legs.get(leg.id);
      return update ? { ...leg, ...update } : leg;
    })
  });
  await updatePendingCount();
  await syncItem('settings');
}

async function syncItem(id: string): Promise<void> {
  if (!navigator.onLine) return;
  await syncNow();
  if ((await getOutbox()).some((item) => item.id === id)) {
    const detail = get(syncError);
    throw new Error(`Saved on this device, but server synchronization failed.${detail ? ` ${detail}` : ''}`);
  }
}

export async function deleteLocalTransaction(id: string): Promise<void> {
  const current = get(snapshot);
  if (!current) return;
  const existing = current.transactions.find((transaction) => transaction.id === id);
  await queueDelete(id, existing?.revision ?? 0);
  await replaceSnapshot({ ...current, transactions: current.transactions.filter((transaction) => transaction.id !== id) });
  await updatePendingCount();
  void syncNow();
}

export async function discardFailedChanges(): Promise<void> {
  const failed = (await getOutbox()).filter((item) => item.attempts > 0);
  for (const item of failed) await completeOutbox(item);
  syncError.set(null);
  await updatePendingCount();
  await syncNow();
}

async function request(item: Awaited<ReturnType<typeof getOutbox>>[number]): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try {
    let response: Response;
    if (item.kind === 'settings' && item.settings) {
      response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item.settings),
        signal: controller.signal
      });
    } else if (item.kind === 'delete') {
      response = await fetch(`/api/transactions/${item.id}`, {
        method: 'DELETE',
        headers: { 'x-hakui-revision': String(item.revision ?? 0) },
        signal: controller.signal
      });
    } else if (item.receiptId && item.transaction) {
      const receipt = await getReceipt(item.receiptId);
      if (!receipt) throw new Error('The queued receipt image is missing.');
      const body = new FormData();
      body.set('transaction', JSON.stringify(item.transaction));
      body.set('receipt', receipt, `${item.receiptId}.jpg`);
      response = await fetch(`/api/receipts/${item.receiptId}`, { method: 'PUT', body, signal: controller.signal });
    } else {
      response = await fetch(`/api/transactions/${item.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item.transaction),
        signal: controller.signal
      });
    }
    if (!response.ok) {
      if (response.status >= 500) serviceAvailable.set(false);
      throw new SyncRequestError(
        (await responseMessage(response)) || `Sync failed with status ${response.status}.`,
        response.status >= 500 || response.status === 408 || response.status === 429
      );
    }
  } finally {
    window.clearTimeout(timeout);
  }
}

async function responseMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { message?: unknown; detail?: unknown };
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.detail === 'string') return parsed.detail;
  } catch {
    // Plain-text errors are returned as-is.
  }
  return text;
}

export function syncNow(): Promise<void> {
  if (syncPromise) {
    syncRequested = true;
    return syncPromise;
  }
  syncPromise = (async () => {
    syncState.set('syncing');
    syncError.set(null);
    try {
      const items = await getOutbox();
      let terminalError: Error | null = null;
      for (const item of items) {
        try {
          await request(item);
          await completeOutbox(item);
        } catch (cause) {
          await markAttempt(item);
          if (cause instanceof SyncRequestError && !cause.retryable) {
            terminalError ??= cause;
            continue;
          }
          throw cause;
        }
      }
      const remaining = await getOutbox();
      await updatePendingCount();
      const response = await fetch('/api/snapshot', { cache: 'no-store' });
      if (!response.ok) {
        if (response.status >= 500) serviceAvailable.set(false);
        throw new Error('Could not refresh server data.');
      }
      const serverSnapshot: AppSnapshot = await response.json();
      const mergedSnapshot = mergePendingChanges(serverSnapshot, remaining);
      await replaceSnapshot(mergedSnapshot);
      serviceAvailable.set(true);
      if (serverSnapshot.transactions.some((transaction: Transaction) => transaction.status === 'pending_ocr')) {
        if (pollTimer !== null) window.clearTimeout(pollTimer);
        pollTimer = window.setTimeout(() => {
          pollTimer = null;
          void syncNow();
        }, 5_000);
      }
      if (terminalError) throw terminalError;
      syncState.set('idle');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Synchronization failed.';
      syncError.set(message);
      syncState.set(navigator.onLine ? 'error' : 'offline');
      await updatePendingCount();
      const retryable = !(cause instanceof SyncRequestError) || cause.retryable;
      if (navigator.onLine && retryable && pollTimer === null) {
        pollTimer = window.setTimeout(() => {
          pollTimer = null;
          void syncNow();
        }, 10_000);
      }
    } finally {
      syncPromise = null;
      if (syncRequested) {
        syncRequested = false;
        queueMicrotask(() => void syncNow());
      }
    }
  })();
  return syncPromise;
}

function mergePendingChanges(serverSnapshot: AppSnapshot, items: Awaited<ReturnType<typeof getOutbox>>): AppSnapshot {
  const local = get(snapshot);
  let merged = serverSnapshot;
  for (const item of items) {
    if (item.kind === 'settings' && item.settings) {
      const legs = new Map(item.settings.legs.map((leg) => [leg.id, leg]));
      merged = {
        ...merged,
        trip: { ...merged.trip, overallBudgetYen: item.settings.overallBudgetYen },
        currentLegId: item.settings.currentLegId,
        legs: merged.legs.map((leg) => ({ ...leg, ...(legs.get(leg.id) ?? {}) }))
      };
    } else if (item.kind === 'delete') {
      merged = { ...merged, transactions: merged.transactions.filter((transaction) => transaction.id !== item.id) };
    } else if (item.transaction) {
      const optimistic = local?.transactions.find((transaction) => transaction.id === item.id);
      if (optimistic) {
        merged = {
          ...merged,
          transactions: [optimistic, ...merged.transactions.filter((transaction) => transaction.id !== item.id)]
        };
      }
    }
  }
  return merged;
}
