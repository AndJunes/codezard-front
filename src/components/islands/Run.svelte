<script lang="ts">
  import { onMount } from "svelte"
  import { SvelteMap } from "svelte/reactivity"
  import { fade } from "svelte/transition"
  import * as run from "../../lib/flow/run"
  import type { Run, RunState } from "../../lib/flow/run"
  import { readEvents, isDone, type AgentEvent, type Project } from "../../lib/agents/events"
  import { badgeForProject } from "../../lib/ui/status"
  import { readable } from "../../lib/ui/problem"
  import * as history from "../../lib/project/history"
  import { messageId, type Message } from "../../lib/chat/messages"
  import type { Answer, Plan, Questionnaire } from "../../lib/plan/schema"
  import Files from "./Files.svelte"
  import QuestionnairePopup from "./Questionnaire.svelte"
  import PlanCard from "./PlanCard.svelte"
  import Steps from "./Steps.svelte"

  // The only interactive piece in the app. Everything else is HTML, which is the reason for
  // choosing Astro: a page that mostly sits still should not ship a framework to sit still.

  /**
   * Where the run is, as the SERVER last reported it. Read, never assigned.
   *
   * It used to be assigned here on every step, by a state machine that shipped in this
   * bundle — along with the round counter, the policy for merging answers across rounds, the
   * prompt the backend agent was given, and `plan.status = "approved"`, which was how
   * approval came to be a field the browser wrote rather than an act the server performed.
   * All of it is in the gateway now. What is left here is what a screen is for.
   */
  let state = $state<RunState>("IDEA")
  let runId = $state("")
  let messages = $state<Message[]>([])
  let pending = $state<Questionnaire | null>(null)
  let draft = $state("")
  let busy = $state(false)
  let project = $state<Project | null>(null)
  /**
   * What is on screen is the browser's saved copy, not a live run.
   *
   * Set when the server cannot give a project back — it forgot it (the gateway keeps runs an
   * hour, in memory) or it is unreachable — and the copy in `history` is shown instead. Nothing
   * can be decided from a copy: it cannot type, approve or generate, because the server would
   * have no run to apply any of it to.
   */
  let readonly = $state(false)
  /** The last run the server sent, for the snapshot. Not reactive: nothing draws from it. */
  let lastRun: Run | null = null
  /**
   * Files seen so far, while they are being written. Empty once `project` arrives.
   *
   * A Map and not the Project shape on purpose: this is a growing list of paths and text,
   * with no id, no verdict and no ZIP — inventing those fields to reuse the type would mean
   * drawing a status badge for a project that has not been certified yet.
   *
   * A `SvelteMap`, not `$state(new Map())`. Svelte proxies arrays and plain objects but not
   * built-in Maps, so `.set()` on a `$state` Map notifies nobody — and the old
   * `written = written` that followed it assigned the same reference, which is not a change
   * either. The panel stayed on "escribiendo los archivos" for the whole generation while
   * the files arrived, unseen, one `step` at a time.
   */
  let written = new SvelteMap<string, string | null>()

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

    // What the sidebar asked for from another page. It cannot dispatch an event there —
    // this island is the only listener and it does not exist outside the home page — so the
    // intent arrives in the URL. Read once and wiped from the address bar, so a reload or a
    // shared link does not silently reopen somebody else's project.
    const asked = new URLSearchParams(location.search)
    const wanted = asked.get("open") ?? ""
    const fresh = asked.has("new")
    if (wanted || fresh) {
      history.replaceState(null, "", location.pathname)
    }

    let previous = ""
    try {
      previous = localStorage.getItem(STORED_RUN) ?? ""
    } catch {}
    if (wanted) void load(wanted, true)
    else if (fresh) restart()
    else if (previous) void load(previous)

    // The sidebar is plain HTML with no access to this state, so it asks by event. Both are
    // refused while a request is in flight: this island holds ONE run's worth of state, and
    // switching under a request would let its answer land in somebody else's transcript.
    const onNew = () => {
      if (!busy) restart()
    }
    const onOpen = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      if (id && id !== runId && !busy) void load(id, true)
    }
    window.addEventListener("cz:new", onNew)
    window.addEventListener("cz:open", onOpen)
    return () => {
      window.removeEventListener("cz:new", onNew)
      window.removeEventListener("cz:open", onOpen)
    }
  })

  // The sidebar's own scripts read these two to highlight the open project and to grey out
  // "new" and "open" while something is running.
  $effect(() => {
    const root = document.documentElement
    root.dataset.busy = busy ? "yes" : "no"
    root.dataset.run = runId
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
   * Two copies would have to be kept in step, and a rendered plan that disagrees with the
   * one being acted on is exactly the kind of drift that shows up as a button that does
   * nothing. The message holds the only copy.
   *
   * Nothing here writes to it any more. `status` is the server's to set, and this reads it.
   */
  const planMessages = $derived(
    messages.filter((m): m is Extract<Message, { kind: "plan" }> => m.kind === "plan"),
  )
  const plan = $derived(planMessages.at(-1)?.plan ?? null)

  const HINTS: Partial<Record<RunState, string>> = {
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

  const canType = $derived(
    (state === "IDEA" || state === "PLAN_REVIEW") && !pending && !busy && !readonly,
  )
  /**
   * The PM is mid-request: no partial text exists to show, only that it is working.
   *
   * Scoped to the PM's own two states on purpose. `BACKEND_GENERATION` is `busy` too, but that
   * wait already has a live answer — the `steps` message's own "Trabajando" line — and a
   * second, contentless dot bubble under it would just be noise repeating what it already
   * says.
   */
  const thinking = $derived(busy && (state === "PM_ANALYSIS" || state === "PM_REVISION"))
  const hint = $derived(
    readonly
      ? "Copia guardada · solo lectura"
      : state === "IDEA"
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
    void thinking
    requestAnimationFrame(() => transcript?.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" }))
  })

  /**
   * Draw whatever the server says the run is now.
   *
   * The one place `state` changes. Before, nine `go()` calls moved a local machine and the
   * screen believed itself; if the server disagreed — because a request failed, or because
   * the run had moved on in another tab — nothing noticed.
   */
  function show(next: Run) {
    lastRun = next
    runId = next.runId
    state = next.state
    pending = next.questionnaire?.questions?.length ? next.questionnaire : null
    remember(next.runId)
    persist(next)
  }

  const STORED_RUN = "cz:run"

  /** The id of the open project, so a reload has something to ask about. */
  function remember(id: string): void {
    try {
      if (id) localStorage.setItem(STORED_RUN, id)
      else localStorage.removeItem(STORED_RUN)
    } catch {}
  }

  /**
   * Keep what the screen is showing, so the project outlives the server's memory of it.
   *
   * Called from `show`, which is the one place the server's answer lands — so every state
   * worth going back to is saved without a second list of "when to save" to keep in step.
   * The index is cheap; the snapshot carries file text and is only written once there is
   * something to read.
   */
  function persist(next: Run): void {
    history.upsert({
      id: next.runId,
      title: history.clip(next.idea),
      name: project?.name ?? "",
      state: next.state,
      gone: false,
    })
    // A finished run is redrawn in two steps — the run first, its project after the event
    // replay. Saving in between would replace a copy that HAS the project with one that does
    // not, and if the replay then failed, the project would be gone from both places.
    const settled = next.state === "ZIP_READY" || next.state === "FAILED" ||
      next.state === "BACKEND_GENERATION"
    if (settled && !project && history.loadSnapshot(next.runId)?.project) return
    const steps = messages.filter((m) => m.kind === "steps").at(-1) as
      Extract<Message, { kind: "steps" }> | undefined
    history.saveSnapshot(next.runId, {
      run: next,
      project: project ? $state.snapshot(project) as Project : null,
      steps: steps ? [...steps.steps] : [],
      ms: steps?.ms ?? 0,
    })
  }

  /** The conversation as the run recorded it: idea, summary, answers and plan. */
  function replay(next: Run): void {
    if (next.idea) say({ id: messageId(), from: "user", kind: "text", text: next.idea })
    if (next.summary) say(agent(next.summary))
    for (const answer of next.answers) {
      say({ id: messageId(), from: "user", kind: "answers",
            pairs: [{ question: answer.questionId, answer: answer.value }] })
    }
    if (next.plan) say({ id: messageId(), from: "agent", kind: "plan", plan: next.plan })
  }

  /**
   * Put a reloaded page back where it was.
   *
   * Everything drawn here is rebuilt from the RUN, not from anything the browser kept: the
   * idea, the summary, the questionnaire and the plan all live on the server, which is what
   * moving the orchestration bought. A refresh mid-generation used to lose the conversation
   * while the work carried on with nobody able to watch it.
   *
   * When the server cannot answer, `fallback` decides what is left. What this no longer does
   * is forget the id: it used to `remember("")` on ANY failure, so the gateway being down for
   * the length of a reload took the project out of the browser as well.
   */
  async function resume(id: string): Promise<void> {
    let next: Run
    try {
      next = await run.read(id)
    } catch (e) {
      fallback(id, e)
      return
    }
    replay(next)
    show(next)

    if (next.state === "BACKEND_GENERATION" || next.state === "ZIP_READY" ||
        next.state === "FAILED") {
      await watch(() => run.follow(id), id)
    }
  }

  /**
   * The server could not give the run back. Those are two different situations and they used
   * to be one: it FORGOT it (404 — a restart, or the hour it keeps runs for), or it could not
   * be REACHED. The first is permanent and the second is not, so only the first is recorded
   * as gone; both show the browser's copy when there is one.
   */
  function fallback(id: string, error: unknown): void {
    const forgotten = error instanceof run.RunError && error.status === 404
    if (forgotten) history.markGone(id)
    const copy = history.loadSnapshot(id)
    if (copy) {
      restore(id, copy, forgotten)
      return
    }
    if (forgotten) {
      remember("")
      say(agent("Este proyecto ya no está en el servidor: se guarda una hora y solo en memoria, " +
                "y no llegó a guardarse una copia en este navegador."))
    } else {
      say({ id: messageId(), from: "agent", kind: "error",
            text: "No pude conectar con el servidor. El proyecto sigue guardado en este " +
                  "navegador: probá de nuevo en un momento." })
    }
  }

  /** Draw a saved copy. Read-only: there is no run on the server for anything to act on. */
  function restore(id: string, copy: history.Snapshot, forgotten: boolean): void {
    readonly = true
    replay(copy.run)
    if (copy.steps.length) {
      say({ id: messageId(), from: "agent", kind: "steps", steps: copy.steps, running: false, ms: copy.ms })
    }
    lastRun = copy.run
    runId = id
    state = copy.run.state
    pending = null
    project = copy.project
    if (copy.project) say({ id: messageId(), from: "agent", kind: "project", project: copy.project })
    remember(id)
    const midway = copy.run.state === "BACKEND_GENERATION" && !copy.project
      ? " La generación estaba en curso cuando se guardó, así que puede estar incompleto."
      : ""
    say(agent(forgotten
      ? "Este proyecto ya no está en el servidor (guarda cada proyecto una hora, en memoria). " +
        "Lo que ves es la copia guardada en este navegador: se puede leer, no continuar." + midway
      : "No pude conectar con el servidor, así que te muestro la copia guardada en este " +
        "navegador. Cuando vuelva, recargá la página para retomarlo." + midway))
  }

  /**
   * Open a project: on load, from the sidebar, or the one the page was left on.
   *
   * `busy` covers the wait, so the composer cannot take a new idea while the old project is
   * still being fetched into the same transcript.
   */
  async function load(id: string, fresh = false): Promise<void> {
    if (fresh) reset()
    remember(id)
    busy = true
    try {
      await resume(id)
    } finally {
      busy = false
    }
  }

  /**
   * An error becomes a turn in the conversation. A 402 becomes a different one.
   *
   * The gateway asking to be paid is not a failure, and showing it in the same red box as
   * "the agent returned nothing" tells the person they broke something when what they need
   * is a price and a link. The quote comes from the 402 itself, so the number on screen is
   * the number the server would charge rather than one repeated here.
   */
  function fail(error: unknown) {
    if (error instanceof run.RunError && error.needsPayment) {
      const offer = error.payment?.accepts?.[0]
      say({
        id: messageId(),
        from: "agent",
        kind: "paywall",
        text: error.message,
        price: offer ? `${offer.maxAmountRequired} ${offer.asset}` : "",
      })
      return
    }
    // `describe` and not `String`: anything can be thrown, and `String` renders a plain
    // object as the literal words "[object Object]".
    const text = error instanceof run.RunError ? error.message : readable(error)
    say({ id: messageId(), from: "agent", kind: "error", text })
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
    state = "PM_ANALYSIS"  // optimistic, for the hint under the composer; `show` corrects it
    try {
      const started = await run.start(idea)
      if (started.summary) say(agent(started.summary))
      if (started.plan) say({ id: messageId(), from: "agent", kind: "plan", plan: started.plan })
      show(started)
    } catch (e) {
      state = "IDEA"
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
    // Only this round's answers are sent. Carrying every previous one along was this
    // component's job because each request was independent; the run keeps them now, and
    // merges them by question id so a later round never overwrites an earlier one.
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
    state = "PM_ANALYSIS"
    try {
      // The idea used to be rebuilt by scanning the transcript for the first user message,
      // and the round number was sent from here and dropped by the route on the way. The run
      // holds both.
      const next = await run.answer(runId, answers)
      if (next.plan && next.state === "PLAN_REVIEW") {
        say({ id: messageId(), from: "agent", kind: "plan", plan: next.plan })
      }
      show(next)
    } catch (e) {
      state = "QUESTIONNAIRE"
      fail(e)
    } finally {
      busy = false
    }
  }

  async function revise(feedback: string) {
    if (!plan) return
    busy = true
    state = "PM_REVISION"
    try {
      // The plan is not sent back up. The run knows which one is being rejected, which also
      // means a stale tab cannot revise a version that is no longer current.
      const next = await run.reject(runId, feedback)
      if (next.plan) say({ id: messageId(), from: "agent", kind: "plan", plan: next.plan })
      show(next)
    } catch (e) {
      state = "PLAN_REVIEW"
      fail(e)
    } finally {
      busy = false
    }
  }

  async function approve() {
    if (!plan || busy) return
    busy = true
    try {
      // `plan.status = "approved"` used to be the whole of this. The screen wrote the field,
      // posted the object, and the server checked the field it had just been handed. Now the
      // request IS the approval and the server records it; the plan the screen draws has the
      // status the server set.
      const next = await run.approve(runId)
      if (next.plan) plan.status = next.plan.status
      show(next)
      say(agent("Plan aprobado. A partir de acá no se modifica: el agente lo usa como especificación."))
    } catch (e) {
      fail(e)
    } finally {
      busy = false
    }
  }

  function askForChanges() {
    composer?.focus()
  }

  async function generate() {
    // `mayGenerate(state)` was a local table's opinion. The button is still hidden unless the
    // run is approved, but that is now courtesy: the server refuses with a 409 either way,
    // and the 409 is what makes it a rule.
    if (!plan || state !== "PLAN_APPROVED" || busy) return
    busy = true
    project = null
    written.clear()

    // The plan is not sent: the run holds the approved one, and sending it would put back
    // the thing this whole change removed — a body the caller controls deciding what gets
    // built.
    await watch(() => run.generate(runId), runId, "PLAN_APPROVED")
  }

  /**
   * Read a stream of events into the transcript, from whichever end supplies it.
   *
   * Starting a generation and reattaching to one are the same job once the bytes are
   * flowing, and the only difference — what to fall back to if it breaks — is a parameter.
   * Writing it twice is how the reattached one quietly stops getting the closing project.
   */
  async function watch(open: () => Promise<ReadableStream<Uint8Array>>, id: string,
                       onFailure: RunState = "FAILED"): Promise<void> {
    busy = true
    say({ id: messageId(), from: "agent", kind: "steps", steps: [], running: true, ms: 0 })
    // Read back through the proxy: mutating the object that was pushed would not be tracked.
    const live = messages.at(-1) as Extract<Message, { kind: "steps" }>
    const started = Date.now()
    const ticking = setInterval(() => (live.ms = Date.now() - started), 250)

    try {
      state = "BACKEND_GENERATION"
      for await (const event of readEvents(await open())) apply(event, live)
      // Read back rather than assumed. The server knows whether an artifact came out of that
      // stream; the browser only knows the stream ended.
      show(await run.read(id))
      if (project) say({ id: messageId(), from: "agent", kind: "project", project })
    } catch (e) {
      fail(e)
      state = onFailure
    } finally {
      clearInterval(ticking)
      live.ms = Date.now() - started
      live.running = false
      busy = false
    }
  }

  function apply(event: AgentEvent, live: Extract<Message, { kind: "steps" }>) {
    if (event.type === "step") {
      live.steps.push(`${event.name} · ${event.summary}`)
      // The agent sends each group's files as it writes them, so the panel fills up during
      // the generation instead of appearing all at once ten minutes later. A preview: the
      // `done` event below replaces it with the project that was actually certified, which
      // can differ wherever a repair changed something.
      for (const [path, text] of Object.entries(event.detail?.wrote ?? {})) {
        written.set(path, text)
      }
    } else if (event.type === "phase") live.steps.push(event.text)
    if (isDone(event)) project = event.project
  }

  /** Back to a blank screen. The saved projects are NOT touched: they are what "open" reads. */
  function reset() {
    state = "IDEA"
    runId = ""
    messages = []
    pending = null
    draft = ""
    project = null
    written.clear()
    readonly = false
    lastRun = null
  }

  function restart() {
    reset()
    remember("")
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
                active={message.plan === plan && state === "PLAN_REVIEW" && !readonly}
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
                {#if message.project.reason && message.project.reason !== badge.detail}
                  <p class="dim reason">{message.project.reason}</p>
                {/if}
                <p class="dim">Los {message.project.totals.files} archivos están a la derecha. El ZIP se baja desde ahí.</p>
                <button class="btn" onclick={restart}>Empezar otro</button>
              </div>
            {:else if message.kind === "paywall"}
              <!-- Deliberately not red and deliberately not `role="alert"`: nothing failed,
                   and interrupting a screen reader to announce a price is the wrong urgency.
                   What it needs is the amount and the way out. -->
              <div class="paywall">
                <p>{message.text}</p>
                {#if message.price}
                  <p class="dim">Un run cuesta <b>{message.price}</b> al precio de ahora.</p>
                {/if}
                <a class="btn btn--primary" href="/billing">Ver planes y saldo</a>
              </div>
            {:else}
              <p class="error" role="alert">{message.text}</p>
            {/if}
          </div>
        {/if}
      {/each}

      {#if thinking}
        <div class="turn" transition:fade={{ duration: 120 }}>
          <div class="typing" role="status" aria-label="El PM está escribiendo">
            <span></span><span></span><span></span>
          </div>
        </div>
      {/if}

      {#if planMessages.length > 1}
        <p class="versions">Versiones: {planMessages.map((m) => `v${m.plan.version}`).join(" → ")}</p>
      {/if}

      {#if state === "PLAN_APPROVED" && !readonly}
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

  <!-- `generating`, not `busy`. The panel used to say "the agent is writing the files" while
       the PM was still reading the idea, because `busy` is true for every call the island
       makes. It is only true here when the backend agent is actually producing something. -->
  <Files {project} {written} {runId} {readonly} busy={state === "BACKEND_GENERATION"} />
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

  /* The accent, not `--bad`. Being asked to pay is an ordinary state of a paid product; the
     red box is for the agent having failed. */
  .paywall {
    border: 1px solid color-mix(in oklab, var(--accent) 35%, var(--line));
    background: color-mix(in oklab, var(--accent) 8%, transparent);
    border-radius: var(--radius);
    padding: 0.85rem 1rem;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .paywall p { margin: 0; }
  .paywall a { text-decoration: none; }

  /* Three dots and nothing else: there is no partial answer to show while the PM is mid
     -request, only that it is working — the same thing "Trabajando" says in words for the
     generation step below. */
  .typing { display: flex; align-items: center; gap: 0.3rem; padding: 0.35rem 0.1rem; }
  .typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--text-dim); animation: typing-bounce 1.2s ease-in-out infinite; }
  .typing span:nth-child(2) { animation-delay: 0.15s; }
  .typing span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes typing-bounce { 0%, 60%, 100% { opacity: 0.3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
  @media (prefers-reduced-motion: reduce) { .typing span { animation: none; opacity: 0.7; } }

  .done { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 0.9rem 1.1rem; }
  .done__head { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 0.3rem; }
  .done .reason { font-family: var(--mono); font-size: 0.82rem; }
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
