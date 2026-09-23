<script lang="ts">
  import * as run from "../../lib/flow/run"
  import { readSse, type Project } from "../../lib/agents/events"
  import { suggestions } from "../../lib/project/commands"

  /**
   * A terminal for the generated project.
   *
   * Until this existed a project was verified once, by a probe nobody could watch, and never
   * STARTED: there was nowhere to install its dependencies, bring the server up, or type a
   * command and see what came back. This is that place. It shows what the agent's verification
   * did, and — while the run is live on the server — runs commands in the project's own
   * folder and streams what they print.
   *
   * Every command is its own block with its own connection, so a server can keep running in
   * one while another command probes it. Stopping is hanging up: the request closes, and the
   * process tree dies behind it.
   */
  let { runId, project, live }: { runId: string; project: Project; live: boolean } = $props()

  type Line = { kind: "out" | "err" | "meta" | "ok" | "bad" | "warn"; text: string }
  type Block = {
    id: number
    command: string
    lines: Line[]
    state: "running" | "ok" | "failed" | "stopped"
    note: string
  }

  /** Enough to read what a build says, not enough to make the page crawl on a runaway log. */
  const MAX_LINES = 5000
  // eslint-disable-next-line no-control-regex
  const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

  let open = $state(true)
  let blocks = $state<Block[]>([])
  let input = $state("")
  let scroller: HTMLDivElement | undefined
  let tick = $state(0)
  let stick = true
  let sequence = 0
  const controllers = new Map<number, AbortController>()
  const recall: string[] = []
  let recalled = -1

  const chips = $derived(suggestions(project.files))

  /** The certifier's phases, drawn: how the agent itself ran this project. */
  const verification = $derived(
    (project.phases ?? []).map((phase): Line => ({
      kind: phase.status === "ok" ? "ok" : phase.status === "failed" ? "bad" : "warn",
      text: `${phase.status === "ok" ? "✓" : phase.status === "failed" ? "✗" : "–"} ${phase.name}` +
        (phase.detail ? ` — ${phase.detail}` : ""),
    })),
  )

  const clean = (text: string) => text.replace(ANSI, "")

  function push(block: Block, kind: Line["kind"], text: string) {
    block.lines.push({ kind, text: clean(text) })
    if (block.lines.length > MAX_LINES) block.lines.splice(0, block.lines.length - MAX_LINES)
    tick++
  }

  const REASON: Record<string, string> = {
    stopped: "detenido",
    timeout: "se cortó por tiempo",
    output: "se cortó por exceso de salida",
  }

  function apply(block: Block, event: run.ConsoleEvent) {
    if (event.type === "stdout") push(block, "out", event.text)
    else if (event.type === "stderr") push(block, "err", event.text)
    else if (event.type === "error") {
      push(block, "bad", event.message)
      block.state = "failed"
    } else if (event.type === "exit") {
      const seconds = event.ms < 1000 ? `${event.ms} ms` : `${(event.ms / 1000).toFixed(1)} s`
      if (event.reason) {
        block.state = "stopped"
        block.note = `${REASON[event.reason] ?? event.reason} · ${seconds}`
      } else {
        block.state = event.code === 0 ? "ok" : "failed"
        block.note = `código ${event.code} · ${seconds}`
      }
    }
  }

  /** What went wrong, in words for the person and not for the gateway. */
  function explain(error: unknown): string {
    if (error instanceof run.RunError) {
      switch (error.code) {
        case "console_disabled":
          return "La consola está apagada en el servidor (GATEWAY_ORCHESTRATION__CONSOLE y MIRAG_CONSOLE)."
        case "project_gone":
          return "El agente ya no tiene este proyecto: los guarda una hora y solo en memoria."
        case "no_project":
          return "Este run todavía no generó ningún proyecto."
        case "run_not_found":
          return "El servidor ya no tiene este run."
      }
      return error.message
    }
    return "No pude conectar con el servidor."
  }

  async function runCommand(command: string) {
    const text = command.trim()
    if (!text || !live) return
    if (recall.at(-1) !== text) recall.push(text)
    recalled = -1
    stick = true

    blocks.push({ id: ++sequence, command: text, lines: [], state: "running", note: "" })
    const block = blocks.at(-1) as Block  // through the proxy: pushing into the raw object is not seen
    const controller = new AbortController()
    controllers.set(block.id, controller)
    tick++

    try {
      const body = await run.execute(runId, text, controller.signal)
      for await (const event of readSse<run.ConsoleEvent>(body)) apply(block, event)
      // A stream that ends without `exit` is a connection that dropped, not a command that
      // finished — saying "ok" for it would be the same lie the whole product exists to avoid.
      if (block.state === "running") {
        block.state = "failed"
        block.note = "se cortó la conexión"
      }
    } catch (error) {
      if (controller.signal.aborted) {
        block.state = "stopped"
        block.note = "detenido"
      } else {
        push(block, "bad", explain(error))
        block.state = "failed"
      }
    } finally {
      controllers.delete(block.id)
    }
  }

  const stop = (id: number) => controllers.get(id)?.abort()

  function submit(event: SubmitEvent) {
    event.preventDefault()
    const command = input
    input = ""
    void runCommand(command)
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (!recall.length) return
      event.preventDefault()
      recalled = event.key === "ArrowUp"
        ? Math.min(recalled + 1, recall.length - 1)
        : Math.max(recalled - 1, -1)
      input = recalled < 0 ? "" : recall[recall.length - 1 - recalled]
    } else if (event.key === "l" && event.ctrlKey) {
      event.preventDefault()
      clear()
    }
  }

  /** Finished blocks only: clearing must not make a running server invisible. */
  function clear() {
    blocks = blocks.filter((block) => block.state === "running")
  }

  function onscroll() {
    if (!scroller) return
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
  }

  $effect(() => {
    void tick
    if (!stick) return
    requestAnimationFrame(() => scroller?.scrollTo({ top: scroller.scrollHeight }))
  })

  // A different run is a different project: what was running belongs to the old one.
  let seen = runId
  const abortAll = () => {
    for (const controller of controllers.values()) controller.abort()
    controllers.clear()
  }
  $effect(() => {
    const id = runId
    if (id === seen) return
    seen = id
    abortAll()
    blocks = []
  })
  // And leaving — the project going away, a new run starting — stops whatever is still up.
  $effect(() => abortAll)
</script>

<section class="console" class:console--closed={!open} aria-label="Consola del proyecto">
  <header class="bar">
    <button class="bar__title" type="button" onclick={() => (open = !open)} aria-expanded={open}>
      <svg class="chev" class:chev--open={open} viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
      Consola
    </button>
    {#if open}
      <div class="chips">
        {#each chips as chip}
          <button class="chip" type="button" disabled={!live} title={chip.command}
                  onclick={() => runCommand(chip.command)}>{chip.label}</button>
        {/each}
      </div>
      <button class="bar__clear" type="button" onclick={clear} title="Limpiar lo terminado (Ctrl+L)">Limpiar</button>
    {/if}
  </header>

  {#if open}
    <div class="out" bind:this={scroller} {onscroll} role="log" aria-live="off" tabindex="0">
      {#if verification.length}
        <div class="blk">
          <div class="cmd"><span class="dim">Verificación del agente</span></div>
          {#each verification as line}<div class="ln ln--{line.kind}">{line.text}</div>{/each}
        </div>
      {/if}

      {#each blocks as block (block.id)}
        <div class="blk">
          <div class="cmd">
            <span class="prompt">$</span> <span class="cmd__text">{block.command}</span>
            {#if block.state === "running"}
              <span class="dim pulse">en curso…</span>
              <button class="stop" type="button" onclick={() => stop(block.id)}>Detener</button>
            {:else}
              <span class="end end--{block.state}">{block.note}</span>
            {/if}
          </div>
          {#each block.lines as line}<div class="ln ln--{line.kind}">{line.text}</div>{/each}
        </div>
      {/each}

      {#if !blocks.length}
        <p class="hint">
          {#if live}
            Instalá, iniciá y probá el proyecto acá. Un servidor puede quedar corriendo mientras
            corrés otro comando, por ejemplo <code>curl http://localhost:3000/</code>.
          {:else}
            Esta es una copia guardada: para ejecutar el proyecto tiene que estar vivo en el servidor.
          {/if}
        </p>
      {/if}
    </div>

    <form class="in" onsubmit={submit}>
      <span class="prompt" aria-hidden="true">$</span>
      <input
        bind:value={input}
        {onkeydown}
        disabled={!live}
        aria-label="Comando"
        placeholder={live ? "npm install · npm start · node -e …" : "Solo lectura"}
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
      />
    </form>
  {/if}
</section>

<style>
  .console {
    flex: 0 0 auto;
    display: flex; flex-direction: column;
    height: clamp(180px, 34vh, 340px);
    border-top: 1px solid var(--line);
    background: var(--bg);
    min-height: 0;
  }
  .console--closed { height: auto; }

  .bar { display: flex; align-items: center; gap: 0.6rem; padding: 0.35rem 0.7rem; background: var(--surface); border-bottom: 1px solid var(--line); }
  .console--closed .bar { border-bottom: 0; }
  .bar__title { display: flex; align-items: center; gap: 0.4rem; border: 0; background: none; color: var(--text); font-size: 0.78rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; padding: 0.15rem 0.2rem; }
  .chev { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; transition: transform 120ms ease; }
  .chev--open { transform: rotate(90deg); }
  @media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
  .chips { display: flex; gap: 0.4rem; flex-wrap: wrap; flex: 1; min-width: 0; }
  .chip { border: 1px solid var(--line); background: var(--surface-2); color: var(--text); border-radius: 999px; padding: 0.12rem 0.65rem; font-size: 0.78rem; }
  .chip:hover:not(:disabled) { border-color: var(--accent); }
  .chip:disabled { opacity: 0.45; cursor: not-allowed; }
  .bar__clear { margin-left: auto; border: 0; background: none; color: var(--text-dim); font-size: 0.78rem; }
  .bar__clear:hover { color: var(--text); }

  .out { flex: 1; min-height: 0; overflow: auto; padding: 0.5rem 0.8rem; font-family: var(--mono); font-size: 0.78rem; line-height: 1.5; }
  .out:focus-visible { outline-offset: -2px; }
  .blk + .blk { margin-top: 0.6rem; }
  .cmd { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.1rem; }
  .cmd__text { color: var(--text); font-weight: 600; word-break: break-all; }
  .prompt { color: var(--accent); }
  .dim { color: var(--text-dim); }
  .ln { white-space: pre-wrap; word-break: break-word; min-height: 1.5em; }
  .ln--out { color: var(--text); }
  .ln--err { color: var(--pending); }
  .ln--meta { color: var(--text-dim); }
  .ln--ok { color: var(--good); }
  .ln--bad { color: var(--bad); }
  .ln--warn { color: var(--pending); }
  .end { font-size: 0.72rem; color: var(--text-dim); }
  .end--ok { color: var(--good); }
  .end--failed { color: var(--bad); }
  .end--stopped { color: var(--pending); }
  .stop { margin-left: auto; border: 1px solid color-mix(in oklab, var(--bad) 55%, var(--line)); background: none; color: var(--bad); border-radius: 999px; padding: 0 0.6rem; font-size: 0.72rem; }
  .stop:hover { background: color-mix(in oklab, var(--bad) 12%, transparent); }
  .hint { margin: 0; font-family: var(--font); color: var(--text-dim); font-size: 0.82rem; line-height: 1.55; }
  .hint code { font-family: var(--mono); background: var(--surface-2); padding: 0.05rem 0.3rem; border-radius: 4px; }

  .in { flex: none; display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.8rem; border-top: 1px solid var(--line); background: var(--surface); font-family: var(--mono); font-size: 0.82rem; }
  .in input { flex: 1; min-width: 0; border: 0; background: none; color: var(--text); font: inherit; padding: 0.15rem 0; }
  .in input:focus { outline: none; }
  .in input::placeholder { color: var(--text-dim); }
  .in input:disabled { cursor: not-allowed; }
</style>
