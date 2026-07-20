import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { TransactionInput } from '$lib/types';
import { completeOutbox, getOutbox, getReceipt, markAttempt, queueDelete, queueSettings, queueUpsert } from './offline-db';

function input(revision: number, merchant: string): TransactionInput {
  return {
    id: '8a5e622f-bd6d-43e8-82b7-fd4771728e78',
    legId: null,
    categoryId: null,
    merchant,
    amountYen: 100,
    transactionDate: '2026-07-19',
    paymentMethod: 'cash',
    purchaseTiming: 'during_trip',
    notes: '',
    source: 'scan',
    status: 'pending_ocr',
    revision
  };
}

describe('offline outbox safety', () => {
  it('preserves receipts and newer edits when an old request completes', async () => {
    const receiptId = await queueUpsert(input(1, 'Receipt scan'), new Blob(['receipt'], { type: 'image/jpeg' }));
    const first = (await getOutbox())[0];
    expect(receiptId).toBeTruthy();
    expect(await getReceipt(receiptId!)).toBeTruthy();

    const preservedId = await queueUpsert(input(2, 'Corrected merchant'));
    const second = (await getOutbox())[0];
    expect(preservedId).toBe(receiptId);
    expect(second.operationId).not.toBe(first.operationId);

    await completeOutbox(first);
    expect((await getOutbox())[0].operationId).toBe(second.operationId);
    expect(await getReceipt(receiptId!)).toBeTruthy();

    const retriedId = await queueUpsert(input(2, 'Corrected merchant'), new Blob(['replacement'], { type: 'image/jpeg' }));
    expect(retriedId).toBe(receiptId);

    await markAttempt(first);
    expect((await getOutbox())[0].attempts).toBe(0);

    await queueDelete(second.id, 2);
    expect((await getOutbox())[0].kind).toBe('delete');
    expect(await getReceipt(receiptId!)).toBeUndefined();
  });

  it('persists settings in the outbox for offline synchronization', async () => {
    await queueSettings({
      overallBudgetYen: 500_000,
      currentLegId: null,
      legs: []
    });
    const settings = (await getOutbox()).find((item) => item.kind === 'settings');
    expect(settings?.settings?.overallBudgetYen).toBe(500_000);
    expect(settings?.attempts).toBe(0);
  });
});
