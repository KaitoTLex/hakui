import { get, writable } from 'svelte/store';
import type { AppSnapshot, Transaction, TransactionInput } from '$lib/types';
import {
  completeOutbox,
  getOutbox,
  getReceipt,
  markAttempt,
  queueDelete,
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
  const pendingReceiptId = await queueUpsert(input, receipt);
  transaction.receiptId ??= pendingReceiptId ?? null;
  await replaceSnapshot(next);
  await updatePendingCount();
  if (navigator.storage?.persist) void navigator.storage.persist();
  void syncNow();
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

async function request(item: Awaited<ReturnType<typeof getOutbox>>[number]): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try {
    let response: Response;
    if (item.kind === 'delete') {
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
        (await response.text()) || `Sync failed with status ${response.status}.`,
        response.status >= 500 || response.status === 408 || response.status === 429
      );
    }
  } finally {
    window.clearTimeout(timeout);
  }
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
      await updatePendingCount();
      if ((await getOutbox()).length === 0) {
        const response = await fetch('/api/snapshot', { cache: 'no-store' });
        if (!response.ok) {
          if (response.status >= 500) serviceAvailable.set(false);
          throw new Error('Could not refresh server data.');
        }
        const serverSnapshot = await response.json();
        if ((await getOutbox()).length === 0) await replaceSnapshot(serverSnapshot);
        serviceAvailable.set(true);
        if (serverSnapshot.transactions.some((transaction: Transaction) => transaction.status === 'pending_ocr')) {
          if (pollTimer !== null) window.clearTimeout(pollTimer);
          pollTimer = window.setTimeout(() => {
            pollTimer = null;
            void syncNow();
          }, 5_000);
        }
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
