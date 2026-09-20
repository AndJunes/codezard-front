<script lang="ts">
  import { seconds } from "../../lib/chat/messages"

  /**
   * What the agent did, collapsed into one line.
   *
   * Open while it runs, because a long silence with no sign of work reads as a hang; closed
   * once it finishes, because by then the project panel is the answer and thirty pipeline
   * stages are just noise between the question and it.
   */
  let { steps, running, ms }: { steps: string[]; running: boolean; ms: number } = $props()

  let open = $state(true)
  let touched = false

  $effect(() => {
    if (!running && !touched) open = false
  })
</script>

<div class="steps">
  <button
    class="line"
    onclick={() => {
      touched = true
      open = !open
    }}
    aria-expanded={open}
  >
    <svg class="chev" class:chev--open={open} viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
    <span class:pulse={running}>{running ? "Trabajando" : "Trabajó"} {seconds(ms)}</span>
    <span class="n">{steps.length} pasos</span>
  </button>
  {#if open}
    <ol>{#each steps as step}<li>{step}</li>{/each}</ol>
  {/if}
</div>

<style>
  .steps { font-size: 0.85rem; }
  .line { display: flex; align-items: center; gap: 0.45rem; width: 100%; text-align: left; border: 0; background: none; color: var(--text-dim); padding: 0.3rem 0.2rem; border-radius: 8px; }
  .line:hover { color: var(--text); }
  .n { margin-left: auto; font-size: 0.78rem; font-variant-numeric: tabular-nums; }
  .chev { width: 13px; height: 13px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; transition: transform 120ms ease; }
  .chev--open { transform: rotate(90deg); }
  @media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
  ol { margin: 0.3rem 0 0; padding-left: 1.6rem; font-family: var(--mono); font-size: 0.78rem; color: var(--text-dim); line-height: 1.6; }
</style>
