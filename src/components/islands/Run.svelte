<script lang="ts">
  import { onMount } from "svelte"
  import { mayGenerate, next, type State } from "../../lib/flow/machine"
  import { readEvents, isDone, type AgentEvent, type Project } from "../../lib/agents/events"
  import { badgeForProject } from "../../lib/ui/status"
  import { messageId, type Message } from "../../lib/chat/messages"
  import type { Answer, Interpretation, Plan, Questionnaire } from "../../lib/plan/schema"
  import Files from "./Files.svelte"
  import QuestionnairePopup from "./Questionnaire.svelte"
  import PlanCard from "./PlanCard.svelte"
  import Steps from "./Steps.svelte"

  // The only interactive piece in the app. Everything else is HTML, which is the reason for
  // choosing Astro: a page that mostly sits still should not ship a framework to sit still.

  let state = $state<State>("IDEA")
  let messages = $state<Message[]>([])
  let pending = $state<Questionnaire | null>(null)
  let draft = $state("")
  let busy = $state(false)
  let project = $state<Project | null>(null)

  let transcript: HTMLDivElement | undefined
  let composer: HTMLTextAreaElement | undefined
  let panes: HTMLDivElement | undefined

  /**
   * The chat column can be narrowed or put away entirely.
   *
   * Both, not one: narrowing is for reading a long file beside the conversation, hiding is
   * for reading the project with nothing else on screen. A single "collapse" button would
   * have forced a choice between them.
   */
  const MIN_CHAT = 320
  const MAX_CHAT_FRACTION = 0.62
  let chatWidth = $state(420)
  let chatOpen = $state(true)
  let dragging = $state(false)

  /**
   * Both panes are always rendered; which one shows is `data-chat` on <html>, and the
   * inline script in <head> sets it before the first paint.
   *
   * Switching the markup from here instead meant the server rendered the conversation, the
   * island hydrated, and only then did it disappear — a flash of the thing being hidden, on
   * every single load.
   */
  onMount(() => {
    const root = document.documentElement
    chatOpen = root.dataset.chat !== "closed"
    const stored = Number(getComputedStyle(root).getPropertyValue("--chat-w").replace("px", ""))
    if (Number.isFinite(stored) && stored >= MIN_CHAT) chatWidth = stored
  })

  $effect(() => {
    const root = document.documentElement
    root.dataset.chat = chatOpen ? "open" : "closed"
    root.style.setProperty("--chat-w", `${Math.round(chatWidth)}px`)
    try {
      localStorage.setItem("cz:chat-width", String(Math.round(chatWidth)))
      localStorage.setItem("cz:chat-open", chatOpen ? "yes" : "no")
    } catch {}
  })

  const clampChat = (width: number): number =>
    Math.max(MIN_CHAT, Math.min(width, (panes?.clientWidth ?? 1200) * MAX_CHAT_FRACTION))

  function grab(event: PointerEvent) {
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    dragging = true
  }

  function drag(event: PointerEvent) {
    if (!dragging || !panes) return
    event.preventDefault()
    chatWidth = clampChat(event.clientX - panes.getBoundingClientRect().left)
  }

  function drop(event: PointerEvent) {
    ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
    dragging = false
  }

  // A divider that can only be dragged is a divider a keyboard cannot move at all.
  function nudge(event: KeyboardEvent) {
    const step = event.shiftKey ? 64 : 16
    if (event.key === "ArrowLeft") chatWidth = clampChat(chatWidth - step)
    else if (event.key === "ArrowRight") chatWidth = clampChat(chatWidth + step)
    else return
    event.preventDefault()
  }

  /**
   * The plan is read back out of the transcript instead of being kept beside it.
   *
   * Two copies would have to be mutated together — approving one and leaving the rendered
   * one at "draft" is exactly the kind of drift that shows up as a button that does nothing.
   * Here the message holds the only copy, so `plan.status = "approved"` is visible wherever
   * it is drawn.
   */
  const planMessages = $derived(
    messages.filter((m): m is Extract<Message, { kind: "plan" }> => m.kind === "plan"),
  )
  const plan = $derived(planMessages.at(-1)?.plan ?? null)

  const HINTS: Partial<Record<State, string>> = {
    PM_ANALYSIS: "El PM está leyendo…",
    QUESTIONNAIRE: "Respondé las preguntas de arriba",
    PLAN_REJECTED: "El PM está revisando…",
    PM_REVISION: "El PM está revisando…",
    PLAN_APPROVED: "Generá el proyecto para seguir",
    BACKEND_GENERATION: "El agente está escribiendo el proyecto…",
    ZIP_READY: "Listo. Empezá otro para volver a arrancar.",
  }
  /**
   * Which of the three stages the run is in.
   *
   * The header used to explain the flow in a sentence — "contás la idea, el PM la convierte
   * en un plan, vos lo aprobás" — which says what happens but never where you are. The same
   * three stages as a row says both, and it comes from the state machine rather than from a
   * counter that could disagree with it.
   */
  const STAGES = [
    { label: "Idea", states: ["IDEA", "PM_ANALYSIS", "QUESTIONNAIRE"] },
    { label: "Plan", states: ["PLAN_REVIEW", "PLAN_REJECTED", "PM_REVISION"] },
    { label: "Proyecto", states: ["PLAN_APPROVED", "BACKEND_GENERATION", "ZIP_READY"] },
  ] as const
  const stage = $derived(STAGES.findIndex((s) => (s.states as readonly string[]).includes(state)))

  const canType = $derived((state === "IDEA" || state === "PLAN_REVIEW") && !pending && !busy)
  const hint = $derived(
    state === "IDEA"
      ? "Contá qué querés construir…"
      : state === "PLAN_REVIEW"
        ? "Pedí cambios con tus palabras, o aceptá el plan…"
        : (HINTS[state] ?? ""),
  )

  function say(message: Message) {
    messages.push(message)
  }

  const agent = (text: string): Message => ({ id: messageId(), from: "agent", kind: "text", text })

  // New turns scroll into view; a streaming step does not, so reading the transcript while
  // the agent works is not a fight with the scrollbar.
  $effect(() => {
    void messages.length
    void pending
    requestAnimationFrame(() => transcript?.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" }))
  })

  function go(event: Parameters<typeof next>[1]) {
    const to = next(state, event)
    if (to) state = to
  }

  async function post(url: string, body: unknown, method = "POST") {
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const data = await r.json()
    if (!r.ok) throw new Error(data.detail ?? data.error ?? `HTTP ${r.status}`)
    return data
  }

  function fail(error: unknown) {
    say({ id: messageId(), from: "agent", kind: "error", text: String(error) })
  }

  function send() {
    const text = draft.trim()
    if (!text || !canType) return
    draft = ""
    say({ id: messageId(), from: "user", kind: "text", text })
    if (state === "IDEA") void describe(text)
    else void revise(text)
  }

  async function describe(idea: string) {
    busy = true
    try {
      go("DESCRIBE")
      const interpretation: Interpretation = await post("/api/pm/analyze", { idea })
      if (interpretation.summary) say(agent(interpretation.summary))
      if (interpretation.questionnaire) {
        pending = interpretation.questionnaire
        go("ASK")
      } else {
        await propose([])
      }
    } catch (e) {
      fail(e)
    } finally {
      busy = false
    }
  }

  function answered(answers: Answer[], pairs: { question: string; answer: string }[]) {
    pending = null
    // The questionnaire folds back into the conversation as one turn, so what was decided
    // stays readable next to everything else instead of vanishing with the popup.
    if (pairs.length) say({ id: messageId(), from: "user", kind: "answers", pairs })
    else say({ id: messageId(), from: "user", kind: "text", text: "Seguí sin esas respuestas." })
    go("DESCRIBE")
    void propose(answers)
  }

  function dismiss() {
    // Closing is "go on with what I gave you", not "cancel": the PM has to answer something,
    // and it is better at saying what it still does not know than the popup is.
    const answers: Answer[] = []
    answered(answers, [])
  }

  async function propose(answers: Answer[]) {
    busy = true
    try {
      const idea = messages.find((m) => m.from === "user" && m.kind === "text")
      const result = await post("/api/pm/plan", {
        idea: idea && idea.kind === "text" ? idea.text : "",
        answers,
      })
      if ("questions" in result) {
        // A second round is a normal outcome: the answers opened something new.
        pending = result as Questionnaire
        go("ASK")
      } else {
        say({ id: messageId(), from: "agent", kind: "plan", plan: result as Plan })
        go("PROPOSE")
      }
    } catch (e) {
      fail(e)
    } finally {
      busy = false
    }
  }

  async function revise(feedback: string) {
    if (!plan) return
    busy = true
    try {
      go("REJECT")
      go("REVISE")
      const revised: Plan = await post("/api/pm/plan", { plan, feedback }, "PUT")
      say({ id: messageId(), from: "agent", kind: "plan", plan: revised })
      go("PROPOSE")
    } catch (e) {
      fail(e)
    } finally {
      busy = false
    }
  }

  function approve() {
    if (!plan) return
    plan.status = "approved"
    go("APPROVE")
    say(agent("Plan aprobado. A partir de acá no se modifica: el agente lo usa como especificación."))
  }

  function askForChanges() {
    composer?.focus()
  }

  async function generate() {
    if (!plan || !mayGenerate(state) || busy) return
    busy = true
    project = null

    say({ id: messageId(), from: "agent", kind: "steps", steps: [], running: true, ms: 0 })
    // Read back through the proxy: mutating the object that was pushed would not be tracked.
    const live = messages.at(-1) as Extract<Message, { kind: "steps" }>
    const started = Date.now()
    const ticking = setInterval(() => (live.ms = Date.now() - started), 250)

    try {
      go("GENERATE")
      const r = await fetch("/api/backend/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      })
      if (!r.ok || !r.body) {
        const detail = await r.json().catch(() => ({}))
        throw new Error(detail.detail ?? detail.error ?? `HTTP ${r.status}`)
      }
      for await (const event of readEvents(r.body)) apply(event, live)
      go("DELIVER")
      if (project) say({ id: messageId(), from: "agent", kind: "project", project })
    } catch (e) {
      fail(e)
      state = "PLAN_APPROVED"
    } finally {
      clearInterval(ticking)
      live.ms = Date.now() - started
      live.running = false
      busy = false
    }
  }

  function apply(event: AgentEvent, live: Extract<Message, { kind: "steps" }>) {
    if (event.type === "step") live.steps.push(`${event.name} · ${event.summary}`)
    else if (event.type === "phase") live.steps.push(event.text)
    if (isDone(event)) project = event.project
  }

  function restart() {
    state = "IDEA"
    messages = []
    pending = null
    draft = ""
    project = null
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }
</script>

<!-- Defined once and rendered in both places, so the header and the rail can never end up
     showing two different marks for the same thing. -->
{#snippet chatIcon()}
  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M21 13.5a3 3 0 0 1-3 3H9l-5 3.5V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z" />
    <circle cx="8.6" cy="9.8" r="0.9" />
    <circle cx="12.5" cy="9.8" r="0.9" />
    <circle cx="16.4" cy="9.8" r="0.9" />
  </svg>
{/snippet}

<div class="panes" class:panes--dragging={dragging} bind:this={panes}>
  <button class="rail" onclick={() => (chatOpen = true)} title="Mostrar la conversación">
    {@render chatIcon()}
    <span class="sr-only">Mostrar la conversación</span>
  </button>

  <section class="chat">
    <header class="chat__head">
      <div class="chat__title">
        {@render chatIcon()}
        <h1>Construir un proyecto</h1>
        <button class="hide" onclick={() => (chatOpen = false)} title="Esconder la conversación">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
          <span class="sr-only">Esconder la conversación</span>
        </button>
      </div>

      <ol class="stages">
        {#each STAGES as item, i}
          <li class:stages--done={i < stage} class:stages--now={i === stage} aria-current={i === stage ? "step" : undefined}>
            <span class="stages__n">{i < stage ? "✓" : i + 1}</span>
            {item.label}
          </li>
        {/each}
      </ol>
    </header>

    <div class="transcript" bind:this={transcript}>
      {#if !messages.length}
        <p class="opening">
          Describí lo que querés construir con tus palabras. Si falta algo, te lo voy a preguntar
          antes de proponerte nada.
        </p>
      {/if}

      {#each messages as message (message.id)}
        {#if message.from === "user"}
          <div class="turn turn--user">
            <div class="bubble">
              {#if message.kind === "text"}
                {message.text}
              {:else}
                <ul class="pairs">
                  {#each message.pairs as pair}
                    <li><span>{pair.question}</span> <b>{pair.answer}</b></li>
                  {/each}
                </ul>
              {/if}
            </div>
          </div>
        {:else}
          <div class="turn">
            {#if message.kind === "text"}
              <p class="said">{message.text}</p>
            {:else if message.kind === "plan"}
              <PlanCard
                plan={message.plan}
                active={message.plan === plan && state === "PLAN_REVIEW"}
                {busy}
                onapprove={approve}
                onreject={askForChanges}
              />
            {:else if message.kind === "steps"}
              <Steps steps={message.steps} running={message.running} ms={message.ms} />
            {:else if message.kind === "project"}
              {@const badge = badgeForProject(message.project.status)}
              <div class="done">
                <div class="done__head">
                  <b>{message.project.name}</b>
                  <span class="badge badge--{badge.tone}">{badge.label}</span>
                </div>
                <p class="dim">{badge.detail}</p>
                <p class="dim">Los {message.project.totals.files} archivos están a la derecha. El ZIP se baja desde ahí.</p>
                <button class="btn" onclick={restart}>Empezar otro</button>
              </div>
            {:else}
              <p class="error" role="alert">{message.text}</p>
            {/if}
          </div>
        {/if}
      {/each}

      {#if planMessages.length > 1}
        <p class="versions">Versiones: {planMessages.map((m) => `v${m.plan.version}`).join(" → ")}</p>
      {/if}

      {#if state === "PLAN_APPROVED"}
        <div class="turn cta">
          <button class="btn btn--primary" onclick={generate} disabled={busy}>Generar el proyecto</button>
        </div>
      {/if}
    </div>

    <!-- The popup hangs off this wrapper, so it sits over the conversation and directly on
         top of the box it is standing in for. -->
    <div class="foot">
      {#if pending}
        <QuestionnairePopup questionnaire={pending} onfinish={answered} ondismiss={dismiss} />
      {/if}

      <div class="composer" class:composer--off={!canType}>
        <textarea
          bind:this={composer}
          bind:value={draft}
          rows="1"
          maxlength="4000"
          placeholder={hint}
          disabled={!canType}
          {onkeydown}
        ></textarea>
        <button class="send" onclick={send} disabled={!canType || !draft.trim()} title="Enviar">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
          <span class="sr-only">Enviar</span>
        </button>
      </div>
    </div>
  </section>

  <div
    class="grip"
    role="separator"
    aria-orientation="vertical"
    aria-label="Ancho de la conversación"
    aria-valuenow={Math.round(chatWidth)}
    aria-valuemin={MIN_CHAT}
    aria-valuemax={Math.round((panes?.clientWidth ?? 1200) * MAX_CHAT_FRACTION)}
    tabindex="0"
    onpointerdown={grab}
    onpointermove={drag}
    onpointerup={drop}
    onpointercancel={drop}
    onkeydown={nudge}
    ondblclick={() => (chatWidth = clampChat(420))}
  ></div>

  <Files {project} {busy} />
</div>

<style>
  /* Three panes across the window: the sidebar is a sibling in index.astro, the chat is a
     fixed column, and the project panel takes whatever is left — code is what wants the
     room. Only the transcript scrolls, so the composer stays put like any chat. */
  .panes { display: flex; flex: 1; min-height: 0; min-width: 0; }
  /* Driven by a custom property rather than an inline `width`, so the stacked layout below
     can override it. An inline style would outrank the media query and leave a 420px column
     on a phone. */
  .chat {
    flex: 0 0 var(--chat-w, 420px);
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  /* The same band as the project panel's header, for the same reason: without it the title
     was the first line of the conversation rather than the frame around it. */
  .chat__head {
    padding: 1rem clamp(1rem, 2.2vw, 1.6rem) 0.75rem;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }
  .chat__title { display: flex; align-items: center; gap: 0.55rem; }
  .chat__head h1 { margin: 0; font-size: 1.22rem; flex: 1; min-width: 0; }

  .stages { display: flex; align-items: center; gap: 0.55rem; list-style: none; margin: 0.7rem 0 0; padding: 0; font-size: 0.78rem; }
  .stages li { display: flex; align-items: center; gap: 0.35rem; color: var(--text-dim); white-space: nowrap; }
  /* The connector is drawn by the item that follows, so the last one has no dangling tail. */
  .stages li + li::before { content: ""; width: 1.1rem; height: 1px; background: var(--line); margin-right: 0.2rem; }
  .stages__n { display: grid; place-items: center; width: 17px; height: 17px; border-radius: 50%; border: 1px solid var(--line); font-size: 0.66rem; font-weight: 600; }
  .stages--done { color: var(--text-dim); }
  .stages--done .stages__n { border-color: var(--accent); color: var(--accent); }
  .stages--now { color: var(--text); font-weight: 600; }
  .stages--now .stages__n { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }

  .ico { width: 20px; height: 20px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .chat__title .ico { color: var(--accent); }
  .chat__title .ico circle { fill: currentColor; stroke: none; }
  .rail .ico circle { fill: currentColor; stroke: none; }

  .hide { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 8px; background: none; color: var(--text-dim); }
  .hide:hover { background: var(--surface-2); color: var(--text); }
  .hide svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }

  /* Put away, the column leaves a rail rather than nothing: a conversation that vanishes
     without a trace looks like it was lost, not hidden. */
  /* Which of the two shows is decided by <html data-chat>, so it is already right on the
     first frame. The island only keeps that attribute in step. */
  .rail { display: none; }
  :global(:root[data-chat="closed"]) .rail { display: flex; }
  :global(:root[data-chat="closed"]) .chat,
  :global(:root[data-chat="closed"]) .grip { display: none; }

  /* Put away, the column leaves the same mark that titles it, and nothing else. The name
     still reaches a screen reader and the pointer through `title`; on screen a 40px strip
     of sideways text was just hard to read. */
  .rail {
    /* No `display` here on purpose: it is set by the two state rules above, and repeating
       it below them would win on source order and show the rail while the chat is open. */
    flex: 0 0 44px;
    flex-direction: column; align-items: center;
    padding: 0.9rem 0;
    border: 0; border-right: 1px solid var(--line);
    background: none; color: var(--text-dim);
  }
  .rail:hover { background: var(--surface); color: var(--accent); }

  .grip {
    flex: 0 0 5px;
    cursor: col-resize;
    background: var(--line);
    /* Widens the grab area without widening the line: 5px of border-box with the colour
       inset, so the target is comfortable and the seam still reads as one pixel. */
    border-inline: 2px solid var(--bg);
    background-clip: padding-box;
  }
  .grip:hover, .grip:focus-visible { background: var(--accent); }
  .panes--dragging { cursor: col-resize; user-select: none; }
  .panes--dragging .grip { background: var(--accent); }
  .dim { color: var(--text-dim); margin: 0.2rem 0; }

  .transcript { flex: 1; min-height: 0; overflow-y: auto; padding: 0.4rem clamp(1rem, 2.2vw, 1.6rem) 1rem; display: flex; flex-direction: column; gap: 0.9rem; }
  .opening { color: var(--text-dim); margin: 0.5rem 0; line-height: 1.6; }

  .turn { display: flex; flex-direction: column; }
  .turn--user { align-items: flex-end; }
  .bubble { max-width: 88%; background: var(--surface-2); border: 1px solid var(--line); border-radius: 14px 14px 4px 14px; padding: 0.55rem 0.85rem; white-space: pre-wrap; }
  .pairs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  .pairs li { font-size: 0.88rem; }
  .pairs span { color: var(--text-dim); }

  /* The agent speaks without a bubble: on a narrow column, two facing bubbles halve the
     width available to the one side that has paragraphs, lists and a plan to show. */
  .said { margin: 0; white-space: pre-wrap; line-height: 1.6; }
  .error { color: var(--bad); margin: 0; }

  .done { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 0.9rem 1.1rem; }
  .done__head { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 0.3rem; }
  .done .btn { margin-top: 0.7rem; }

  .versions { margin: 0; font-family: var(--mono); font-size: 0.78rem; color: var(--text-dim); }
  .cta { align-items: flex-start; }

  .foot { position: relative; flex: none; padding: 0.6rem clamp(1rem, 2.2vw, 1.6rem) 1rem; border-top: 1px solid var(--line); }

  .composer { display: flex; align-items: flex-end; gap: 0.5rem; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 0.45rem 0.45rem 0.45rem 0.85rem; }
  .composer:focus-within { border-color: color-mix(in oklab, var(--accent) 55%, var(--line)); }
  .composer--off { opacity: 0.6; }
  .composer textarea {
    flex: 1; min-width: 0; resize: none;
    max-height: 9rem;
    background: none; border: 0; color: var(--text); font: inherit; line-height: 1.5;
    padding: 0.3rem 0;
  }
  .composer textarea:focus { outline: none; }
  .composer textarea::placeholder { color: var(--text-dim); }

  .send { flex: none; width: 32px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 50%; background: var(--accent); color: var(--accent-ink); }
  .send:disabled { background: var(--surface-2); color: var(--text-dim); cursor: not-allowed; }
  .send svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

  /* Below this the two panes stack, and the chat stops being a scroll container of its own
     — nested scrolling on a phone means one of the two always traps the gesture. */
  @media (max-width: 1100px) {
    .panes { flex-direction: column; }
    /* Stacked, width is the screen's and the divider has nothing to divide. Hiding stays:
       it is the one of the two that still means something on a phone. */
    .chat { flex: 0 0 auto; }
    .grip { display: none; }
    .rail { flex: 0 0 auto; flex-direction: row; justify-content: center; padding: 0.55rem; border-right: 0; border-bottom: 1px solid var(--line); }
    .transcript { overflow: visible; }
    /* The page scrolls instead of the transcript here, so the composer would drift off the
       bottom as the conversation grows — and the questionnaire, which hangs off it, with it.
       Sticky keeps both reachable without nesting a second scroll container inside the
       page's own. */
    .foot { position: sticky; bottom: 0; background: var(--bg); }
  }
</style>
