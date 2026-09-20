<script lang="ts">
  import type { Plan } from "../../lib/plan/schema"

  /**
   * One version of the plan, as a turn in the conversation.
   *
   * Superseded versions stay rendered and lose their buttons. Removing them would make the
   * transcript claim the PM proposed once and got it right, and the feedback that produced
   * the next version would have nothing to point at.
   */
  let {
    plan,
    active,
    busy,
    onapprove,
    onreject,
  }: {
    plan: Plan
    active: boolean
    busy: boolean
    onapprove: () => void
    onreject: () => void
  } = $props()
</script>

<article class="plan" class:plan--past={!active}>
  <header>
    <h3>Plan v{plan.version}</h3>
    {#if plan.revisionOf}
      <span class="from">revisión de la v{plan.revisionOf.version}</span>
    {/if}
    {#if plan.status === "approved"}
      <span class="badge badge--good">Aprobado</span>
    {:else if !active}
      <span class="badge badge--neutral">Reemplazado</span>
    {/if}
  </header>

  {#if plan.revisionOf?.feedback}
    <p class="feedback">Por tu comentario: «{plan.revisionOf.feedback}»</p>
  {/if}

  <p class="purpose">{plan.purpose}</p>

  {#if plan.entities.length}
    <h4>Entidades</h4>
    <ul>{#each plan.entities as e}<li><b>{e.name}</b> — {e.fields.join(", ")}</li>{/each}</ul>
  {/if}
  {#if plan.flows.length}
    <h4>Flujos</h4>
    <ul>{#each plan.flows as f}<li><b>{f.name}</b>: {f.steps.join(" → ")}</li>{/each}</ul>
  {/if}
  {#if plan.constraints.length}
    <h4>Restricciones</h4>
    <ul>{#each plan.constraints as c}<li>{c.statement}</li>{/each}</ul>
  {/if}

  <!-- As prominent as the rest, never folded away: a plan that hides what it does not know
       reads as more certain than it is. -->
  <h4 class="warn">Lo que este plan NO resuelve</h4>
  {#if plan.openQuestions.length}
    <ul class="warn-list">{#each plan.openQuestions as q}<li>{q}</li>{/each}</ul>
  {:else}
    <p class="warn-list">Nada quedó abierto — y eso debería ser raro.</p>
  {/if}

  {#if active && plan.status !== "approved"}
    <div class="actions">
      <button class="btn btn--primary" onclick={onapprove} disabled={busy}>Aceptar el plan</button>
      <button class="btn" onclick={onreject} disabled={busy}>Pedir cambios</button>
    </div>
  {/if}
</article>

<style>
  .plan { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 1rem 1.15rem; }
  /* Dimmed, not hidden: it is still readable, and it is visibly no longer the live one. */
  .plan--past { opacity: 0.62; }
  .plan--past:hover { opacity: 1; }

  header { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 0.4rem; }
  h3 { margin: 0; font-size: 1rem; }
  .from { font-size: 0.8rem; color: var(--text-dim); }
  .feedback { margin: 0 0 0.5rem; font-size: 0.85rem; color: var(--text-dim); font-style: italic; }
  .purpose { margin: 0; white-space: pre-wrap; }
  h4 { margin: 0.9rem 0 0.25rem; font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-dim); }
  h4.warn { color: var(--pending); }
  ul { margin: 0.2rem 0; padding-left: 1.1rem; }
  .warn-list { color: var(--pending); margin: 0.2rem 0; }
  .actions { display: flex; gap: 0.5rem; margin-top: 1rem; flex-wrap: wrap; }
</style>
