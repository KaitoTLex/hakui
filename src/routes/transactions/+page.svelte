<script lang="ts">
  import { snapshot, deleteLocalTransaction } from '$lib/client/state';
  import { formatDate, formatYen } from '$lib/format';
  import type { Transaction } from '$lib/types';

  export let data;

  let search = '';
  let legFilter = 'all';
  let categoryFilter = 'all';
  let timingFilter = 'all';
  let statusFilter = 'all';
  let groupBy = 'none';
  let sortBy = 'date-desc';

  $: current = $snapshot ?? data.snapshot;
  $: legs = new Map(current.legs.map((leg) => [leg.id, leg.name]));
  $: categories = new Map(current.categories.map((category) => [category.id, category]));
  $: filtered = current.transactions.filter((transaction) => {
    const text = `${transaction.merchant} ${transaction.notes}`.toLowerCase();
    return (!search || text.includes(search.toLowerCase())) &&
      (legFilter === 'all' || transaction.legId === legFilter) &&
      (categoryFilter === 'all' || transaction.categoryId === categoryFilter) &&
      (timingFilter === 'all' || transaction.purchaseTiming === timingFilter) &&
      (statusFilter === 'all' || transaction.status === statusFilter);
  }).sort((a, b) => {
    if (sortBy === 'date-asc') return (a.transactionDate ?? '9999').localeCompare(b.transactionDate ?? '9999');
    if (sortBy === 'amount-desc') return b.amountYen - a.amountYen;
    if (sortBy === 'amount-asc') return a.amountYen - b.amountYen;
    if (sortBy === 'merchant') return a.merchant.localeCompare(b.merchant);
    return (b.transactionDate ?? '').localeCompare(a.transactionDate ?? '');
  });
  $: groups = buildGroups(filtered, groupBy);
  $: filteredTotal = filtered.reduce((sum, transaction) => sum + transaction.amountYen, 0);

  function groupName(transaction: Transaction, field: string): string {
    if (field === 'leg') return legs.get(transaction.legId ?? '') ?? 'No leg';
    if (field === 'category') return categories.get(transaction.categoryId ?? '')?.name ?? 'Uncategorized';
    if (field === 'payment') return transaction.paymentMethod === 'unknown' ? 'Unknown payment' : transaction.paymentMethod;
    if (field === 'timing') return transaction.purchaseTiming === 'pre_trip' ? 'Pre-trip' : 'During trip';
    if (field === 'date') return formatDate(transaction.transactionDate);
    return 'All transactions';
  }

  function buildGroups(transactions: Transaction[], field: string): Array<{ name: string; items: Transaction[]; total: number }> {
    const grouped = new Map<string, Transaction[]>();
    for (const transaction of transactions) {
      const name = groupName(transaction, field);
      grouped.set(name, [...(grouped.get(name) ?? []), transaction]);
    }
    return [...grouped].map(([name, items]) => ({ name, items, total: items.reduce((sum, item) => sum + item.amountYen, 0) }));
  }

  async function remove(transaction: Transaction): Promise<void> {
    if (confirm(`Delete ${transaction.merchant}? This will sync to the server.`)) await deleteLocalTransaction(transaction.id);
  }
</script>

<div class="page transactions-page">
  <div class="page-heading">
    <div><h1>Transactions</h1><p>{filtered.length} purchases · {formatYen(filteredTotal)} visible</p></div>
    <a class="button" href="/capture">Add expense</a>
  </div>

  <section class="controls card" aria-label="Transaction controls">
    <div class="field search"><span>Search</span><input bind:value={search} type="search" placeholder="Merchant or notes" /></div>
    <div class="field"><span>Leg</span><select bind:value={legFilter}><option value="all">All legs</option>{#each current.legs as leg}<option value={leg.id}>{leg.name}</option>{/each}</select></div>
    <div class="field"><span>Category</span><select bind:value={categoryFilter}><option value="all">All categories</option>{#each current.categories as category}<option value={category.id}>{category.name}</option>{/each}</select></div>
    <div class="field"><span>Timing</span><select bind:value={timingFilter}><option value="all">All spending</option><option value="during_trip">During trip</option><option value="pre_trip">Pre-trip</option></select></div>
    <div class="field"><span>Status</span><select bind:value={statusFilter}><option value="all">All statuses</option><option value="confirmed">Confirmed</option><option value="needs_review">Needs review</option><option value="pending_ocr">Waiting for OCR</option></select></div>
    <div class="field"><span>Group</span><select bind:value={groupBy}><option value="none">No grouping</option><option value="leg">Leg</option><option value="category">Category</option><option value="date">Date</option><option value="payment">Payment</option><option value="timing">Timing</option></select></div>
    <div class="field"><span>Sort</span><select bind:value={sortBy}><option value="date-desc">Newest date</option><option value="date-asc">Oldest date</option><option value="amount-desc">Highest amount</option><option value="amount-asc">Lowest amount</option><option value="merchant">Merchant A–Z</option></select></div>
  </section>

  {#each groups as group}
    <section class="transaction-group">
      {#if groupBy !== 'none'}<div class="group-heading"><h2>{group.name}</h2><span>{group.items.length} items · {formatYen(group.total)}</span></div>{/if}
      <div class="mobile-list">
        {#each group.items as transaction}
          <article class="transaction-card card">
            <a href={`/capture?id=${transaction.id}`}>
              <div class="transaction-top"><strong>{transaction.merchant}</strong><b>{formatYen(transaction.amountYen)}</b></div>
              <div class="transaction-meta"><span>{formatDate(transaction.transactionDate)}</span><span>{legs.get(transaction.legId ?? '') ?? 'No leg'}</span><span>{categories.get(transaction.categoryId ?? '')?.name ?? 'Uncategorized'}</span></div>
              <div class="transaction-flags">{#if transaction.status !== 'confirmed'}<span class="pill review">{transaction.status === 'pending_ocr' ? 'Waiting for OCR' : 'Needs review'}</span>{/if}{#if transaction.purchaseTiming === 'pre_trip'}<span class="pill prepaid">Pre-trip</span>{/if}</div>
            </a>
            <button aria-label={`Delete ${transaction.merchant}`} onclick={() => remove(transaction)}>Delete</button>
          </article>
        {/each}
      </div>
      <div class="table-wrap card">
        <table>
          <thead><tr><th>Expense</th><th>Date</th><th>Leg</th><th>Category</th><th>Payment</th><th>Status</th><th class="number">Amount</th><th></th></tr></thead>
          <tbody>{#each group.items as transaction}<tr>
            <td><a href={`/capture?id=${transaction.id}`}><strong>{transaction.merchant}</strong>{#if transaction.notes}<small>{transaction.notes}</small>{/if}</a></td>
            <td>{formatDate(transaction.transactionDate)}</td><td>{legs.get(transaction.legId ?? '') ?? '—'}</td><td>{categories.get(transaction.categoryId ?? '')?.name ?? '—'}</td><td class="capitalize">{transaction.paymentMethod}</td>
            <td>{#if transaction.status !== 'confirmed'}<span class="pill review">Review</span>{/if}{#if transaction.purchaseTiming === 'pre_trip'}<span class="pill prepaid">Pre-trip</span>{/if}</td>
            <td class="number"><strong>{formatYen(transaction.amountYen)}</strong></td><td><button class="row-delete" aria-label={`Delete ${transaction.merchant}`} onclick={() => remove(transaction)}>Delete</button></td>
          </tr>{/each}</tbody>
        </table>
      </div>
    </section>
  {:else}
    <div class="empty card">No transactions match these filters.</div>
  {/each}
</div>

<style>
  .page-heading .button { display: none; }
  .controls { padding: .8rem; display: grid; grid-template-columns: 1fr 1fr; gap: .7rem; }
  .controls .search { grid-column: 1 / -1; }
  .controls input, .controls select { min-height: 2.55rem; padding: .55rem .65rem; font-size: .8rem; }
  .transaction-group { margin-top: 1.25rem; }
  .group-heading { margin: 0 .25rem .55rem; display: flex; justify-content: space-between; align-items: end; gap: 1rem; }
  .group-heading h2 { margin: 0; font-size: .92rem; text-transform: capitalize; }
  .group-heading span { color: var(--muted); font-size: .68rem; }
  .mobile-list { display: grid; gap: .65rem; }
  .transaction-card { padding: .9rem; display: grid; grid-template-columns: 1fr auto; align-items: center; }
  .transaction-card > button { border: 0; background: transparent; color: var(--danger); font-size: .68rem; }
  .transaction-top { display: flex; justify-content: space-between; gap: .8rem; }
  .transaction-top strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .86rem; }
  .transaction-top b { font-size: .88rem; white-space: nowrap; }
  .transaction-meta { margin-top: .38rem; display: flex; flex-wrap: wrap; gap: .35rem .7rem; color: var(--muted); font-size: .66rem; }
  .transaction-flags { margin-top: .5rem; display: flex; gap: .35rem; }
  .table-wrap { display: none; overflow-x: auto; border-radius: var(--radius-md); }
  @media (min-width: 760px) {
    .page-heading .button { display: inline-flex; }
    .controls { grid-template-columns: 2fr repeat(6, minmax(7rem, 1fr)); overflow-x: auto; }
    .controls .search { grid-column: auto; min-width: 12rem; }
    .mobile-list { display: none; }
    .table-wrap { display: block; }
    table { width: 100%; border-collapse: collapse; font-size: .75rem; }
    th { padding: .75rem; text-align: left; color: var(--muted); font-size: .64rem; text-transform: uppercase; letter-spacing: .06em; background: var(--surface-strong); }
    td { padding: .72rem .75rem; border-top: 1px solid var(--line); white-space: nowrap; }
    td:first-child { min-width: 12rem; max-width: 18rem; white-space: normal; }
    td:first-child a { display: grid; }
    td small { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 16rem; }
    .number { text-align: right; }
    .capitalize { text-transform: capitalize; }
    td .pill + .pill { margin-left: .25rem; }
    .row-delete { border: 0; background: transparent; color: var(--danger); font-size: .66rem; cursor: pointer; }
  }
</style>
