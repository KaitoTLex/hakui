<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { initializeState, pendingCount, snapshot, syncState, syncNow } from '$lib/client/state';
  import '../app.css';

  export let data;

  onMount(() => initializeState(data.snapshot));

  const nav = [
    { href: '/', label: 'Dashboard', mark: 'H' },
    { href: '/transactions', label: 'Transactions', mark: 'T' },
    { href: '/capture', label: 'Add expense', mark: '+' },
    { href: '/settings', label: 'Settings', mark: 'S' }
  ];
</script>

<svelte:head><title>Hakui</title><meta name="description" content="Trip bookkeeping that works offline" /></svelte:head>

<div class="app-shell">
  <aside class="sidebar">
    <a class="brand" href="/" aria-label="Hakui dashboard"><span>H</span><div>Hakui<small>Trip bookkeeping</small></div></a>
    <nav aria-label="Primary navigation">
      {#each nav as item}
        <a href={item.href} class:active={$page.url.pathname === item.href}>
          <i>{item.mark}</i><span>{item.label}</span>
        </a>
      {/each}
    </nav>
    <div class="sidebar-foot">
      <span class:online={$syncState === 'idle'} class="status-dot"></span>
      {$syncState === 'syncing' ? 'Syncing changes' : $pendingCount ? `${$pendingCount} pending` : 'Stored safely'}
    </div>
  </aside>

  <main>
    <header class="topbar">
      <div>
        <span class="eyebrow">Japan 2026</span>
        <strong>{$snapshot?.legs.find((leg) => leg.id === $snapshot?.currentLegId)?.name ?? 'Trip overview'}</strong>
      </div>
      <button class="sync-button" onclick={() => syncNow()} disabled={$syncState === 'syncing'}>
        {$syncState === 'syncing' ? 'Syncing' : $pendingCount ? `Sync ${$pendingCount}` : 'Synced'}
      </button>
    </header>
    <slot />
  </main>

  <nav class="bottom-nav" aria-label="Mobile navigation">
    {#each nav as item}
      <a href={item.href} class:active={$page.url.pathname === item.href} class:add={item.href === '/capture'}>
        <i>{item.mark}</i><span>{item.label === 'Add expense' ? 'Add' : item.label}</span>
      </a>
    {/each}
  </nav>
</div>
