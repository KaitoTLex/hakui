<script lang="ts">
  import { onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { snapshot, saveLocalTransaction, stateReady } from '$lib/client/state';
  import { compressReceipt } from '$lib/client/image';
  import { getReceipt as getLocalReceipt } from '$lib/client/offline-db';
  import type { PaymentMethod, PurchaseTiming } from '$lib/types';

  export let data;

  let initializedFor = '\0';
  let mode: 'manual' | 'scan' = $page.url.searchParams.get('mode') === 'manual' ? 'manual' : 'scan';
  let id: string = crypto.randomUUID();
  let merchant = '';
  let amountYen = 0;
  let transactionDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
  let legId = '';
  let categoryId = '';
  let paymentMethod: PaymentMethod = 'unknown';
  let purchaseTiming: PurchaseTiming = 'during_trip';
  let notes = '';
  let receipt: Blob | undefined;
  let preview = '';
  let saving = false;
  let error = '';
  let loadedReceipt = '';
  let storedPreview = '';
  let receiptDetails: { ocrState: string; confidence: number | null; processingError: string | null; extraction: { totalSourceLine?: string } | null } | null = null;

  $: current = $snapshot ?? data.snapshot;
  $: requestedId = $page.url.searchParams.get('id') ?? '';
  $: editing = current.transactions.find((transaction) => transaction.id === requestedId);
  $: if (editing?.receiptId && editing.receiptId !== loadedReceipt) {
    loadedReceipt = editing.receiptId;
    void loadReceipt(editing.receiptId);
  }
  $: if ($stateReady && requestedId !== initializedFor) {
    initializedFor = requestedId;
    if (editing) {
      id = editing.id; merchant = editing.merchant; amountYen = editing.amountYen;
      transactionDate = editing.transactionDate ?? ''; legId = editing.legId ?? ''; categoryId = editing.categoryId ?? '';
      paymentMethod = editing.paymentMethod; purchaseTiming = editing.purchaseTiming; notes = editing.notes; mode = 'manual';
    } else {
      legId = current.currentLegId ?? current.legs[0]?.id ?? '';
      categoryId = current.categories.find((category) => category.name === 'Other')?.id ?? '';
    }
  }

  async function chooseReceipt(event: Event): Promise<void> {
    error = '';
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      receipt = await compressReceipt(file);
      if (preview) URL.revokeObjectURL(preview);
      preview = URL.createObjectURL(receipt);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not process this image.';
    }
  }

  async function loadReceipt(receiptId: string): Promise<void> {
    const localReceipt = await getLocalReceipt(receiptId);
    if (localReceipt) {
      if (storedPreview) URL.revokeObjectURL(storedPreview);
      storedPreview = URL.createObjectURL(localReceipt);
      receiptDetails = { ocrState: 'queued', confidence: null, processingError: null, extraction: null };
    }
    try {
      const response = await fetch(`/api/receipts/${receiptId}`);
      if (response.ok) receiptDetails = await response.json();
    } catch {
      if (!localReceipt) receiptDetails = null;
    }
  }

  async function submit(): Promise<void> {
    error = '';
    if (!merchant.trim() && !receipt) { error = 'Add a description or receipt image.'; return; }
    if (amountYen < 0) { error = 'Amount cannot be negative.'; return; }
    saving = true;
    try {
      const incomplete = !transactionDate || !legId || !categoryId || paymentMethod === 'unknown';
      await saveLocalTransaction({
        id,
        legId: legId || null,
        categoryId: categoryId || null,
        merchant: merchant.trim() || 'Receipt scan',
        amountYen: Number(amountYen) || 0,
        transactionDate: transactionDate || null,
        paymentMethod,
        purchaseTiming,
        notes: notes.trim(),
        source: receipt ? 'scan' : editing?.source ?? 'manual',
        status: receipt ? 'pending_ocr' : incomplete ? 'needs_review' : 'confirmed',
        revision: (editing?.revision ?? 0) + 1
      }, receipt);
      await goto('/transactions');
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save this expense.';
    } finally {
      saving = false;
    }
  }

  onDestroy(() => {
    if (preview) URL.revokeObjectURL(preview);
    if (storedPreview) URL.revokeObjectURL(storedPreview);
  });
</script>

<div class="page capture-page">
  <div class="page-heading"><div><h1>{editing ? 'Edit expense' : 'Add expense'}</h1><p>Saved to this device first, even when the server is unreachable.</p></div></div>

  {#if !editing}
    <div class="mode-switch"><button class:active={mode === 'scan'} onclick={() => mode = 'scan'}>Scan receipt</button><button class:active={mode === 'manual'} onclick={() => mode = 'manual'}>Manual entry</button></div>
  {/if}

  <form class="entry card" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
    {#if editing?.receiptId}
      <section class="ocr-review">
        <img src={storedPreview || `/api/receipts/${editing.receiptId}/image`} alt="Scanned receipt" />
        <div>
          <span class="eyebrow">OCR review</span>
          <h2>{receiptDetails?.ocrState === 'failed' ? 'Automatic reading failed' : 'Confirm the extracted details'}</h2>
          <p>{receiptDetails?.processingError ?? (receiptDetails?.confidence != null ? `${Math.round(receiptDetails.confidence * 100)}% total confidence. Saving this form confirms your corrections.` : 'Receipt details are loading.')}</p>
          {#if receiptDetails?.extraction?.totalSourceLine}<code>{receiptDetails.extraction.totalSourceLine}</code>{/if}
        </div>
      </section>
    {/if}
    {#if mode === 'scan' && !editing}
      <label class:has-preview={preview} class="receipt-drop">
        {#if preview}<img src={preview} alt="Receipt preview" /><span>Choose a different receipt</span>{:else}<strong>Photograph your receipt</strong><span>Fill the frame, flatten the paper, and avoid glare.</span><b>Open camera or gallery</b>{/if}
        <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" onchange={chooseReceipt} />
      </label>
      <p class="privacy-note">The image is compressed on your phone. OCR runs privately on your NixOS server after synchronization.</p>
    {/if}

    {#if error}<div class="message error">{error}</div>{/if}

    <div class="form-grid two">
      <div class="field wide"><label for="merchant">Expense or merchant</label><input id="merchant" bind:value={merchant} placeholder={receipt ? 'Optional before OCR' : 'e.g. Lawson'} /></div>
      <div class="field"><label for="amount">Amount in yen</label><input id="amount" bind:value={amountYen} type="number" inputmode="numeric" min="0" step="1" /></div>
      <div class="field"><label for="date">Transaction date</label><input id="date" bind:value={transactionDate} type="date" /></div>
      <div class="field"><label for="leg">Trip leg</label><select id="leg" bind:value={legId}><option value="">No leg</option>{#each current.legs as leg}<option value={leg.id}>{leg.name}</option>{/each}</select></div>
      <div class="field"><label for="category">Category</label><select id="category" bind:value={categoryId}><option value="">Uncategorized</option>{#each current.categories.filter((item) => item.active) as category}<option value={category.id}>{category.name}</option>{/each}</select></div>
      <div class="field"><label for="payment">Payment method</label><select id="payment" bind:value={paymentMethod}><option value="unknown">Unknown</option><option value="cash">Cash</option><option value="card">Card</option></select></div>
      <div class="field"><label for="timing">Budget treatment</label><select id="timing" bind:value={purchaseTiming}><option value="during_trip">Count in trip budgets</option><option value="pre_trip">Pre-trip, track separately</option></select></div>
      <div class="field wide"><label for="notes">Notes</label><textarea id="notes" bind:value={notes} placeholder="Optional context"></textarea></div>
    </div>
    <div class="form-actions"><button class="button" type="submit" disabled={saving}>{saving ? 'Saving locally' : editing ? 'Save changes' : 'Add expense'}</button><a class="button secondary" href={editing ? '/transactions' : '/'}>Cancel</a></div>
  </form>
</div>

<style>
  .capture-page { max-width: 800px; }
  .mode-switch { margin-bottom: .8rem; padding: .3rem; display: grid; grid-template-columns: 1fr 1fr; background: var(--track); border-radius: .9rem; }
  .mode-switch button { min-height: 2.55rem; border: 0; border-radius: .7rem; background: transparent; color: var(--muted); font-weight: 750; }
  .mode-switch button.active { background: var(--surface); color: var(--pink-dark); box-shadow: var(--shadow-sm); }
  .entry { padding: .9rem; }
  .ocr-review { margin-bottom: 1rem; padding: .8rem; display: grid; grid-template-columns: 5.5rem 1fr; gap: .9rem; align-items: center; border-radius: .9rem; background: var(--aqua-soft); }
  .ocr-review img { width: 5.5rem; height: 7rem; object-fit: cover; object-position: top; border-radius: .6rem; background: white; }
  .ocr-review h2 { margin: .15rem 0; font-size: .92rem; }
  .ocr-review p { margin: 0; color: var(--muted); font-size: .69rem; line-height: 1.4; }
  .ocr-review code { margin-top: .45rem; padding: .3rem .4rem; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-radius: .4rem; background: color-mix(in srgb, var(--surface) 70%, transparent); font-size: .62rem; }
  .receipt-drop { min-height: 15rem; margin-bottom: .5rem; padding: 1.2rem; display: grid; place-items: center; align-content: center; gap: .5rem; overflow: hidden; border: 2px dashed color-mix(in srgb, var(--pink) 45%, var(--line)); border-radius: 1rem; background: linear-gradient(145deg, var(--surface-strong), var(--pink-soft)); text-align: center; cursor: pointer; }
  .receipt-drop strong { font-size: 1.1rem; }
  .receipt-drop span { max-width: 24rem; color: var(--muted); font-size: .76rem; line-height: 1.45; }
  .receipt-drop b { margin-top: .45rem; padding: .6rem .8rem; border-radius: .7rem; background: var(--pink); color: white; font-size: .75rem; }
  .receipt-drop input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .receipt-drop.has-preview { background: var(--track); }
  .receipt-drop img { width: 100%; max-height: 24rem; object-fit: contain; border-radius: .7rem; }
  .privacy-note { margin: .5rem .2rem 1.1rem; color: var(--muted); font-size: .68rem; line-height: 1.45; }
  .entry .message { margin-bottom: 1rem; }
  @media (min-width: 700px) { .entry { padding: 1.4rem; } .wide { grid-column: 1 / -1; } }
</style>
