<script lang="ts">
  import Gauge from '$lib/components/Gauge.svelte';
  import { formatDate, formatYen } from '$lib/format';
  import { snapshot } from '$lib/client/state';

  export let data;

  $: current = $snapshot ?? data.snapshot;
  $: during = current.transactions.filter((transaction) => transaction.purchaseTiming === 'during_trip');
  $: prepaid = current.transactions.filter((transaction) => transaction.purchaseTiming === 'pre_trip');
  $: currentLeg = current.legs.find((leg) => leg.id === current.currentLegId) ?? current.legs[0];
  $: legSpent = during.filter((transaction) => transaction.legId === currentLeg?.id).reduce((sum, item) => sum + item.amountYen, 0);
  $: totalSpent = during.reduce((sum, item) => sum + item.amountYen, 0);
  $: prepaidTotal = prepaid.reduce((sum, item) => sum + item.amountYen, 0);
  $: today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
  $: todaySpent = during
    .filter((transaction) => transaction.transactionDate === today)
    .reduce((sum, item) => sum + item.amountYen, 0);
  $: recent = [...current.transactions]
    .sort((a, b) => (b.transactionDate ?? '').localeCompare(a.transactionDate ?? '') || b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);
  $: categories = new Map(current.categories.map((category) => [category.id, category]));
</script>

<div class="page dashboard">
  <div class="hero">
    <div>
      <span class="eyebrow">Current leg</span>
      <h1>{currentLeg?.name ?? 'Japan'}</h1>
      <p>Keep the trip moving without losing track of the small purchases.</p>
    </div>
    <div class="hero-actions">
      <a class="button" href="/capture?mode=scan">Scan receipt</a>
      <a class="button secondary" href="/capture?mode=manual">Manual entry</a>
    </div>
  </div>

  <section class="gauges" aria-label="Budget progress">
    <Gauge label={`${currentLeg?.name ?? 'Leg'} budget`} spent={legSpent} budget={currentLeg?.budgetYen ?? 0} />
    <Gauge label="Overall trip budget" spent={totalSpent} budget={current.trip.overallBudgetYen} color="var(--pink)" />
  </section>

  <section class="quick-stats">
    <article class="stat card">
      <span>Spent today</span><strong>{formatYen(todaySpent)}</strong><small>{formatDate(today)}</small>
    </article>
    <article class="stat card prepaid-card">
      <span>Pre-trip spending</span><strong>{formatYen(prepaidTotal)}</strong><small>Tracked outside both budgets</small>
    </article>
    <article class="stat card">
      <span>Needs review</span><strong>{current.transactions.filter((item) => item.status !== 'confirmed').length}</strong><small>Missing or scanned details</small>
    </article>
  </section>

  <div class="section-title"><h2>Recent activity</h2><a href="/transactions">View all</a></div>
  <section class="recent card">
    {#each recent as transaction}
      <a class="recent-row" href={`/capture?id=${transaction.id}`}>
        <span class="category-mark" style={`--category: ${categories.get(transaction.categoryId ?? '')?.color ?? '#98909c'}`}></span>
        <div><strong>{transaction.merchant}</strong><small>{categories.get(transaction.categoryId ?? '')?.name ?? 'Uncategorized'} · {formatDate(transaction.transactionDate)}</small></div>
        <div class="amount"><strong>{formatYen(transaction.amountYen)}</strong>{#if transaction.purchaseTiming === 'pre_trip'}<span class="pill prepaid">Pre-trip</span>{/if}</div>
      </a>
    {:else}
      <div class="empty">Your first expense will appear here.</div>
    {/each}
  </section>
</div>

<style>
  .hero { padding: .7rem 0 1.2rem; display: grid; gap: 1.1rem; }
  .hero h1 { margin: .1rem 0; font-size: clamp(2.35rem, 11vw, 4.5rem); line-height: .98; letter-spacing: -.07em; }
  .hero p { margin: .6rem 0 0; max-width: 31rem; color: var(--muted); font-size: .9rem; line-height: 1.55; }
  .hero-actions { display: grid; grid-template-columns: 1fr 1fr; gap: .65rem; }
  .gauges { display: grid; gap: .8rem; }
  .quick-stats { margin-top: .8rem; display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; }
  .stat { min-width: 0; padding: 1rem; display: grid; gap: .25rem; }
  .stat span { color: var(--muted); font-size: .7rem; font-weight: 750; }
  .stat strong { font-size: 1.25rem; letter-spacing: -.04em; }
  .stat small { color: var(--muted); font-size: .62rem; line-height: 1.35; }
  .prepaid-card { background: linear-gradient(135deg, var(--surface), var(--pink-soft)); }
  .quick-stats .stat:last-child { grid-column: 1 / -1; }
  .recent { overflow: hidden; }
  .recent-row { padding: .85rem .9rem; display: grid; grid-template-columns: .6rem minmax(0, 1fr) auto; align-items: center; gap: .7rem; border-bottom: 1px solid var(--line); }
  .recent-row:last-child { border-bottom: 0; }
  .category-mark { width: .55rem; height: 2.1rem; border-radius: 99px; background: var(--category); }
  .recent-row > div { min-width: 0; display: grid; }
  .recent-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .84rem; }
  .recent-row small { margin-top: .15rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .67rem; }
  .amount { justify-items: end; gap: .22rem; }
  .amount .pill { font-size: .55rem; padding: .16rem .38rem; }
  @media (min-width: 650px) {
    .hero { grid-template-columns: 1fr auto; align-items: end; }
    .hero-actions { display: flex; }
    .gauges { grid-template-columns: 1fr 1fr; }
    .quick-stats { grid-template-columns: repeat(3, 1fr); }
    .quick-stats .stat:last-child { grid-column: auto; }
  }
</style>
