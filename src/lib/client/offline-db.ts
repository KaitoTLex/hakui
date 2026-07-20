import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AppSnapshot, SettingsInput, TransactionInput } from '$lib/types';

export interface OutboxItem {
  id: string;
  operationId: string;
  kind: 'upsert' | 'delete' | 'settings';
  transaction?: TransactionInput;
  settings?: SettingsInput;
  receiptId?: string;
  revision?: number;
  attempts: number;
  updatedAt: string;
}

interface HakuiDb extends DBSchema {
  snapshots: {
    key: string;
    value: AppSnapshot;
  };
  outbox: {
    key: string;
    value: OutboxItem;
  };
  receipts: {
    key: string;
    value: Blob;
  };
}

let database: Promise<IDBPDatabase<HakuiDb>> | undefined;

function getDatabase(): Promise<IDBPDatabase<HakuiDb>> {
  if (typeof indexedDB === 'undefined') throw new Error('Offline storage is only available in the browser.');
  database ??= openDB<HakuiDb>('hakui-offline', 1, {
    upgrade(db) {
      db.createObjectStore('snapshots');
      db.createObjectStore('outbox');
      db.createObjectStore('receipts');
    }
  });
  return database;
}

export async function readCachedSnapshot(): Promise<AppSnapshot | undefined> {
  return (await getDatabase()).get('snapshots', 'current');
}

export async function writeCachedSnapshot(snapshot: AppSnapshot): Promise<void> {
  await (await getDatabase()).put('snapshots', snapshot, 'current');
}

export async function queueUpsert(input: TransactionInput, receipt?: Blob): Promise<string | undefined> {
  const db = await getDatabase();
  const transaction = db.transaction(['outbox', 'receipts'], 'readwrite');
  const existing = await transaction.objectStore('outbox').get(input.id);
  const receiptId = existing?.receiptId ?? (receipt ? crypto.randomUUID() : undefined);
  if (receipt && receiptId) await transaction.objectStore('receipts').put(receipt, receiptId);
  await transaction.objectStore('outbox').put(
    {
      id: input.id,
      operationId: crypto.randomUUID(),
      kind: 'upsert',
      transaction: input,
      receiptId,
      attempts: 0,
      updatedAt: new Date().toISOString()
    },
    input.id
  );
  await transaction.done;
  return receiptId;
}

export async function queueDelete(id: string, revision: number): Promise<void> {
  const db = await getDatabase();
  const transaction = db.transaction(['outbox', 'receipts'], 'readwrite');
  const existing = await transaction.objectStore('outbox').get(id);
  if (existing?.receiptId) await transaction.objectStore('receipts').delete(existing.receiptId);
  await transaction.objectStore('outbox').put(
    { id, operationId: crypto.randomUUID(), kind: 'delete', revision, attempts: 0, updatedAt: new Date().toISOString() },
    id
  );
  await transaction.done;
}

export async function queueSettings(settings: Omit<SettingsInput, 'operationId'>): Promise<OutboxItem> {
  const operationId = crypto.randomUUID();
  const item: OutboxItem = {
    id: 'settings',
    operationId,
    kind: 'settings',
    settings: { ...settings, operationId },
    attempts: 0,
    updatedAt: new Date().toISOString()
  };
  await (await getDatabase()).put('outbox', item, 'settings');
  return item;
}

export async function getOutbox(): Promise<OutboxItem[]> {
  return (await getDatabase()).getAll('outbox');
}

export async function getReceipt(id: string): Promise<Blob | undefined> {
  return (await getDatabase()).get('receipts', id);
}

export async function completeOutbox(item: OutboxItem): Promise<void> {
  const db = await getDatabase();
  const transaction = db.transaction(['outbox', 'receipts'], 'readwrite');
  const current = await transaction.objectStore('outbox').get(item.id);
  if (current?.operationId === item.operationId) {
    await transaction.objectStore('outbox').delete(item.id);
    if (item.receiptId) await transaction.objectStore('receipts').delete(item.receiptId);
  }
  await transaction.done;
}

export async function markAttempt(item: OutboxItem): Promise<void> {
  const db = await getDatabase();
  const transaction = db.transaction('outbox', 'readwrite');
  const current = await transaction.store.get(item.id);
  if (current?.operationId === item.operationId) {
    await transaction.store.put({ ...item, attempts: item.attempts + 1 }, item.id);
  }
  await transaction.done;
}
