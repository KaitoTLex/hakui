<script lang="ts">
  import { saveLocalSettings, snapshot, stateReady } from '$lib/client/state';
  import { formatYen } from '$lib/format';

  export let data;

  let overallBudgetYen = 0;
  let currentLegId = '';
  let legs: Array<{ id: string; name: string; budgetYen: number; startsOn: string; endsOn: string }> = [];
  let saving = false;
  let message = '';
  let failed = false;
  let dirty = false;
  let loadedSignature = '';
  let loadedRevision = 0;

  $: current = $snapshot ?? data.snapshot;
  $: settingsSignature = JSON.stringify([
    current.trip.settingsRevision,
    current.trip.overallBudgetYen,
    current.currentLegId,
    current.legs.map((leg) => [leg.id, leg.budgetYen, leg.startsOn, leg.endsOn])
  ]);
  $: if ($stateReady && !dirty && settingsSignature !== loadedSignature) {
    overallBudgetYen = current.trip.overallBudgetYen;
    currentLegId = current.currentLegId ?? '';
    legs = current.legs.map((leg) => ({ id: leg.id, name: leg.name, budgetYen: leg.budgetYen, startsOn: leg.startsOn ?? '', endsOn: leg.endsOn ?? '' }));
    loadedRevision = current.trip.settingsRevision;
    loadedSignature = settingsSignature;
  }
  $: prepaid = current.transactions.filter((item) => item.purchaseTiming === 'pre_trip').reduce((sum, item) => sum + item.amountYen, 0);

  async function save(): Promise<void> {
    saving = true; message = ''; failed = false;
    try {
      const outcome = await saveLocalSettings({
        expectedRevision: loadedRevision,
        overallBudgetYen: Number(overallBudgetYen),
        currentLegId: currentLegId || null,
        legs: legs.map((leg) => ({
          id: leg.id,
          budgetYen: Number(leg.budgetYen),
          startsOn: leg.startsOn || null,
          endsOn: leg.endsOn || null
        }))
      });
      dirty = false;
      message = outcome === 'synced' ? 'Trip settings saved and synchronized.' : 'Trip settings saved on this device and queued for synchronization.';
    } catch (cause) {
      failed = true; message = cause instanceof Error ? cause.message : 'Settings could not be saved.';
    } finally { saving = false; }
  }
</script>

<div class="page settings-page">
  <div class="page-heading"><div><h1>Trip settings</h1><p>Budgets exclude {formatYen(prepaid)} of separately tracked pre-trip spending.</p></div></div>
  <form class="settings-form" onsubmit={(event) => { event.preventDefault(); void save(); }}>
    <section class="card settings-section">
      <div class="section-copy"><h2>Overall budget</h2><p>The amount available for spending during the trip. Pre-trip purchases do not reduce this.</p></div>
      <div class="field"><label for="overall">Overall budget in yen</label><input id="overall" type="number" min="0" step="1" bind:value={overallBudgetYen} oninput={() => dirty = true} disabled={!$stateReady || saving} /></div>
      <div class="field"><label for="current-leg">Current leg</label><select id="current-leg" bind:value={currentLegId} onchange={() => dirty = true} disabled={!$stateReady || saving}>{#each legs as leg}<option value={leg.id}>{leg.name}</option>{/each}</select></div>
    </section>

    <section class="card settings-section legs-section">
      <div class="section-copy"><h2>Trip legs</h2><p>Dates are optional. The current leg selector always takes precedence.</p></div>
      {#each legs as leg, index}
        <fieldset disabled={saving}><legend><span>{index + 1}</span>{leg.name}</legend><div class="form-grid leg-grid"><div class="field"><label for={`budget-${leg.id}`}>Budget in yen</label><input id={`budget-${leg.id}`} type="number" min="0" step="1" bind:value={leg.budgetYen} oninput={() => dirty = true} /></div><div class="field"><label for={`start-${leg.id}`}>Start date</label><input id={`start-${leg.id}`} type="date" bind:value={leg.startsOn} onchange={() => dirty = true} /></div><div class="field"><label for={`end-${leg.id}`}>End date</label><input id={`end-${leg.id}`} type="date" bind:value={leg.endsOn} onchange={() => dirty = true} /></div></div></fieldset>
      {/each}
    </section>

    <section class="card settings-section">
      <div class="section-copy"><h2>Data and privacy</h2><p>Export a portable copy. Receipt images, OCR text, and transaction data stay on this device and your private server.</p></div>
      <a class="button secondary" href="/api/export">Export transactions as CSV</a>
    </section>

    {#if message}<div class:error={failed} class="message">{message}</div>{/if}
    <button class="button save" type="submit" disabled={saving || !$stateReady}>{saving ? 'Saving' : !$stateReady ? 'Loading settings' : 'Save trip settings'}</button>
  </form>
</div>

<style>
  .settings-page { max-width: 900px; }
  .settings-form { display: grid; gap: .9rem; }
  .settings-section { padding: 1rem; display: grid; gap: 1rem; }
  .section-copy h2 { margin: 0; font-size: 1rem; }
  .section-copy p { margin: .3rem 0 0; color: var(--muted); font-size: .75rem; line-height: 1.5; }
  fieldset { margin: 0; padding: 1rem 0; border: 0; border-top: 1px solid var(--line); }
  legend { padding: 0 0 .8rem; display: flex; align-items: center; gap: .55rem; font-size: .82rem; font-weight: 800; }
  legend span { width: 1.5rem; height: 1.5rem; display: grid; place-items: center; border-radius: .5rem; background: var(--pink-soft); color: var(--pink-dark); font-size: .65rem; }
  .save { width: 100%; }
  @media (min-width: 700px) {
    .settings-section:not(.legs-section) { grid-template-columns: minmax(14rem, 1fr) minmax(12rem, .8fr) minmax(12rem, .8fr); align-items: end; }
    .leg-grid { grid-template-columns: 1.2fr 1fr 1fr; }
    .save { width: fit-content; justify-self: end; }
  }
</style>
