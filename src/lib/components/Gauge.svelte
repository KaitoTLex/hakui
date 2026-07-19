<script lang="ts">
  import { formatYen } from '$lib/format';

  export let label: string;
  export let spent: number;
  export let budget: number;
  export let color = 'var(--aqua)';

  $: remaining = budget - spent;
  $: percent = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
</script>

<article class="gauge-card">
  <div class="gauge-heading">
    <span>{label}</span>
    <strong>{budget > 0 ? `${Math.round(percent)}% used` : 'Set a budget'}</strong>
  </div>
  <svg viewBox="0 0 200 114" role="img" aria-label={`${label}: ${formatYen(remaining)} remaining`}>
    <path class="track" d="M20 100 A80 80 0 0 1 180 100" pathLength="100" />
    <path
      class:over={remaining < 0}
      class="progress"
      d="M20 100 A80 80 0 0 1 180 100"
      pathLength="100"
      stroke-dasharray={`${percent} 100`}
      style={`--gauge-color: ${color}`}
    />
    <text x="100" y="80" text-anchor="middle" class:negative={remaining < 0}>{formatYen(remaining)}</text>
    <text x="100" y="100" text-anchor="middle" class="caption">{remaining < 0 ? 'over budget' : 'remaining'}</text>
  </svg>
  <div class="gauge-foot">
    <span>Spent {formatYen(spent)}</span>
    <span>Budget {formatYen(budget)}</span>
  </div>
</article>

<style>
  .gauge-card { padding: 1rem 1rem .8rem; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
  .gauge-heading, .gauge-foot { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .gauge-heading span { font-weight: 760; }
  .gauge-heading strong { font-size: .74rem; color: var(--muted); }
  svg { width: 100%; max-height: 10rem; overflow: visible; }
  path { fill: none; stroke-width: 17; stroke-linecap: round; }
  .track { stroke: var(--track); }
  .progress { stroke: var(--gauge-color); transition: stroke-dasharray .5s ease; }
  .progress.over { stroke: var(--danger); }
  text { fill: var(--text); font-size: 18px; font-weight: 800; }
  text.negative { fill: var(--danger); }
  .caption { fill: var(--muted); font-size: 9px; font-weight: 650; text-transform: uppercase; letter-spacing: .08em; }
  .gauge-foot { color: var(--muted); font-size: .72rem; }
</style>
