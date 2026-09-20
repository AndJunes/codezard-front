<script lang="ts">
  import type { Answer, Questionnaire } from "../../lib/plan/schema"

  /**
   * The PM's questions, one at a time, over the conversation.
   *
   * A popup and not a form in the transcript, because these are a decision the conversation
   * is waiting on. Inline, the four questions scrolled away with everything else and the
   * chat carried on underneath as if nothing were pending. Here the conversation stays
   * visible and unmistakably blocked, and when it closes the answers land in it as one turn.
   */
  let {
    questionnaire,
    onfinish,
    ondismiss,
  }: {
    questionnaire: Questionnaire
    onfinish: (answers: Answer[], pairs: { question: string; answer: string }[]) => void
    ondismiss: () => void
  } = $props()

  let index = $state(0)
  let values = $state<Record<string, string>>({})
  /** Which questions had "Otra…" picked, so the free-text box stays open while typing. */
  let custom = $state<Record<string, boolean>>({})

  const question = $derived(questionnaire.questions[index])
  const isLast = $derived(index === questionnaire.questions.length - 1)
  const answered = $derived(Boolean(values[question?.id ?? ""]?.trim()))

  function advance() {
    if (isLast) finish()
    else index += 1
  }

  function finish() {
    const answers: Answer[] = []
    const pairs: { question: string; answer: string }[] = []
    for (const q of questionnaire.questions) {
      const value = values[q.id]?.trim()
      if (!value) continue // skipped: the PM is told nothing rather than told a guess
      answers.push({ questionId: q.id, value })
      pairs.push({ question: q.text, answer: value })
    }
    onfinish(answers, pairs)
  }

  function pick(option: string) {
    custom[question.id] = false
    values[question.id] = option
  }

  function chooseOther() {
    custom[question.id] = true
    values[question.id] = ""
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape") ondismiss()
    if (event.key !== "Enter" || event.shiftKey) return
    event.preventDefault()
    // Only when there is an answer. Enter on an empty question used to skip it, which is a
    // decision — "the PM gets told nothing about this" — and it should take the button that
    // says so, not a reflex keypress.
    if (answered) advance()
  }
</script>

<svelte:window on:keydown={onkeydown} />

<section class="pop" role="dialog" aria-modal="false" aria-labelledby="q-title">
  <header>
    <h3 id="q-title">{question.text}</h3>
    <button class="x" onclick={ondismiss} title="Seguir sin responder el resto">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      <span class="sr-only">Cerrar y seguir con lo que haya respondido</span>
    </button>
  </header>

  {#if index === 0}
    <p class="why">{questionnaire.reason}</p>
  {/if}

  <div class="body">
    {#if question.options}
      {#each question.options as option}
        <!-- Real radios: arrow keys, screen readers and form semantics come free, and the
             label is the whole row so the hit target is not the 14px circle. -->
        <label class="opt" class:opt--on={!custom[question.id] && values[question.id] === option}>
          <input
            type="radio"
            name={question.id}
            checked={!custom[question.id] && values[question.id] === option}
            onchange={() => pick(option)}
          />
          <span>{option}</span>
        </label>
      {/each}
      <label class="opt" class:opt--on={custom[question.id]}>
        <input type="radio" name={question.id} checked={custom[question.id]} onchange={chooseOther} />
        <span>Otra…</span>
      </label>
      {#if custom[question.id]}
        <!-- svelte-ignore a11y_autofocus -->
        <input class="free" bind:value={values[question.id]} placeholder="Escribilo con tus palabras" autofocus />
      {/if}
    {:else}
      <!-- svelte-ignore a11y_autofocus -->
      <input class="free" bind:value={values[question.id]} placeholder="Tu respuesta" autofocus />
    {/if}
  </div>

  <footer>
    <span class="count">{index + 1} de {questionnaire.questions.length}</span>
    <button class="skip" onclick={advance}>Saltar</button>
    <button class="btn btn--primary next" onclick={advance} disabled={!answered}>
      {isLast ? "Armar el plan" : "Siguiente"}
    </button>
  </footer>
</section>

<style>
  .pop {
    position: absolute;
    left: 50%;
    bottom: 100%;
    transform: translateX(-50%);
    width: min(100%, 34rem);
    margin-bottom: 0.7rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: 0 18px 40px rgb(0 0 0 / 0.55);
    padding: 1rem 1.1rem 0.75rem;
    z-index: 5;
  }
  @media (prefers-reduced-motion: no-preference) {
    .pop { animation: rise 160ms ease-out; }
    @keyframes rise { from { opacity: 0; transform: translate(-50%, 8px); } }
  }

  header { display: flex; align-items: flex-start; gap: 0.75rem; }
  h3 { margin: 0; font-size: 0.98rem; line-height: 1.4; }
  .why { margin: 0.5rem 0 0; font-size: 0.82rem; color: var(--text-dim); line-height: 1.45; }

  .x { flex: none; width: 26px; height: 26px; display: grid; place-items: center; border: 0; border-radius: 7px; background: none; color: var(--text-dim); }
  .x:hover { background: var(--surface-2); color: var(--text); }
  .x svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }

  .body { display: flex; flex-direction: column; gap: 0.15rem; margin: 0.8rem 0 0.6rem; }
  .opt { display: flex; align-items: center; gap: 0.6rem; padding: 0.42rem 0.55rem; border-radius: 9px; color: var(--text-dim); cursor: pointer; }
  .opt:hover { background: var(--surface-2); color: var(--text); }
  .opt--on { color: var(--text); }
  .opt input { accent-color: var(--accent); margin: 0; flex: none; }
  .free { width: 100%; margin-top: 0.35rem; background: var(--surface-2); color: var(--text); border: 1px solid var(--line); border-radius: 9px; padding: 0.5rem 0.7rem; font: inherit; }

  footer { display: flex; align-items: center; gap: 0.6rem; padding-top: 0.6rem; border-top: 1px solid var(--line); }
  .count { font-size: 0.78rem; color: var(--text-dim); font-variant-numeric: tabular-nums; }
  .skip { margin-left: auto; border: 0; background: none; color: var(--text-dim); font-size: 0.85rem; padding: 0.35rem 0.5rem; border-radius: 8px; }
  .skip:hover { background: var(--surface-2); color: var(--text); }
  .next { padding: 0.42rem 0.95rem; font-size: 0.88rem; }

  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
</style>
