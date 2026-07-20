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
let settingsSyncPromise: Promise<void> | null = null;
let syncRequested = false;
let pollTimer: number | null = null;
let snapshotVersion = 0;

class SyncRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export async function initializeState(serverSnapshot: AppSnapshot, backendAvailable = true): Promise<void> {
  if (initialized) return;
  initialized = true;
  serviceAvailable.set(backendAvailable);
  try {
    const [cached, pending] = await Promise.all([readCachedSnapshot(), getOutbox()]);
    const baseline = backendAvailable ? serverSnapshot : cached ?? serverSnapshot;
    snapshot.set(mergePendingChanges(baseline, pending, cached));
    snapshotVersion += 1;
    await writeCachedSnapshot(get(snapshot) ?? baseline);
    await updatePendingCount();
  } catch (cause) {
    console.error('Offline storage could not be initialized; using server data.', cause);
    snapshot.set(serverSnapshot);
    snapshotVersion += 1;
  } finally {
    stateReady.set(true);
  }
  window.addEventListener('online', () => void syncNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow();
  });
  void syncNow();
}

export async function replaceSnapshot(value: AppSnapshot): Promise<void> {
  snapshot.set(value);
  snapshotVersion += 1;
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

export async function saveLocalSettings(input: Omit<SettingsInput, 'operationId'>): Promise<'synced' | 'queued'> {
  if (!get(snapshot)) throw new Error('Application data is not ready.');
  validateSettings(input);
  const operation = await queueSettings(input);
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
  if (navigator.storage?.persist) void navigator.storage.persist();
  if (!navigator.onLine) return 'queued';
  try {
    await flushSettings();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Settings synchronization failed.';
    syncError.set(message);
    syncState.set(navigator.onLine ? 'error' : 'offline');
    const retryable = !(cause instanceof SyncRequestError) || cause.retryable;
    if (retryable) scheduleRetry();
    return 'queued';
  }
  let pending = (await getOutbox()).find((item) => item.id === 'settings');
  if (pending?.operationId === operation.operationId) {
    await flushSettings();
    pending = (await getOutbox()).find((item) => item.id === 'settings');
  }
  if (pending?.operationId === operation.operationId) {
    return 'queued';
  }
  syncError.set(null);
  syncState.set('idle');
  return 'synced';
}

function validateSettings(input: Omit<SettingsInput, 'operationId'>): void {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error('Settings are not ready yet. Reload and try again.');
  }
  if (!Number.isSafeInteger(input.overallBudgetYen) || input.overallBudgetYen < 0 || input.overallBudgetYen > 1_000_000_000) {
    throw new Error('Overall budget must be a whole number between 0 and 1,000,000,000 yen.');
  }
  for (const leg of input.legs) {
    if (!Number.isSafeInteger(leg.budgetYen) || leg.budgetYen < 0 || leg.budgetYen > 1_000_000_000) {
      throw new Error('Every leg budget must be a whole number between 0 and 1,000,000,000 yen.');
    }
    if (leg.startsOn && leg.endsOn && leg.startsOn > leg.endsOn) {
      throw new Error('A leg end date cannot be before its start date.');
    }
  }
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
        (await responseMessage(response)) || `Sync failed with status ${response.status}.`,
        response.status >= 500 || response.status === 408 || response.status === 429
      );
    }
  } finally {
    window.clearTimeout(timeout);
  }
}

async function flushSettings(): Promise<void> {
  if (settingsSyncPromise) return settingsSyncPromise;
  settingsSyncPromise = (async () => {
    while (true) {
      const item = (await getOutbox()).find((candidate) => candidate.kind === 'settings');
      if (!item?.settings) return;
      const settings = {
        ...item.settings,
        operationId: item.settings.operationId ?? item.operationId,
        expectedRevision: item.settings.expectedRevision ?? get(snapshot)?.trip.settingsRevision ?? 0
      };
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(settings),
          signal: controller.signal
        });
        if (!response.ok) {
          if (response.status >= 500) serviceAvailable.set(false);
          throw new SyncRequestError(
            (await responseMessage(response)) || `Settings sync failed with status ${response.status}.`,
            response.status >= 500 || response.status === 408 || response.status === 429
          );
        }
        const committed: AppSnapshot = await response.json();
        await completeOutbox(item);
        const newer = (await getOutbox()).filter((candidate) => candidate.kind === 'settings');
        await replaceSnapshot(mergePendingChanges(committed, newer));
        serviceAvailable.set(true);
        await updatePendingCount();
      } catch (cause) {
        await markAttempt(item);
        const replacement = (await getOutbox()).find((candidate) => candidate.kind === 'settings');
        if (replacement && replacement.operationId !== item.operationId) continue;
        throw cause;
      } finally {
        window.clearTimeout(timeout);
      }
    }
  })().finally(() => {
    settingsSyncPromise = null;
  });
  return settingsSyncPromise;
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
      let terminalError: Error | null = null;
      try {
        await flushSettings();
      } catch (cause) {
        if (cause instanceof SyncRequestError && !cause.retryable) terminalError = cause;
        else throw cause;
      }
      const items = (await getOutbox()).filter((item) => item.kind !== 'settings');
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
      const versionBeforeRefresh = snapshotVersion;
      const response = await fetch('/api/snapshot', { cache: 'no-store' });
      if (!response.ok) {
        if (response.status >= 500) serviceAvailable.set(false);
        throw new Error('Could not refresh server data.');
      }
      const serverSnapshot: AppSnapshot = await response.json();
      const remaining = await getOutbox();
      const mergedSnapshot = mergePendingChanges(serverSnapshot, remaining);
      if (snapshotVersion === versionBeforeRefresh) await replaceSnapshot(mergedSnapshot);
      else syncRequested = true;
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
        scheduleRetry();
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

function scheduleRetry(): void {
  if (pollTimer !== null) return;
  pollTimer = window.setTimeout(() => {
    pollTimer = null;
    void syncNow();
  }, 10_000);
}

function mergePendingChanges(
  serverSnapshot: AppSnapshot,
  items: Awaited<ReturnType<typeof getOutbox>>,
  localSnapshot: AppSnapshot | null | undefined = get(snapshot)
): AppSnapshot {
  const local = localSnapshot;
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
