<script lang="ts">
  import { mayGenerate, next, type State } from "../../lib/flow/machine"
  import { readEvents, isDone, type AgentEvent, type Project } from "../../lib/agents/events"
  import { badgeForProject } from "../../lib/ui/status"
  import Files from "./Files.svelte"
  import type { Answer, Interpretation, Plan, Questionnaire } from "../../lib/plan/schema"

  // The only interactive piece in the app. Everything else is HTML, which is the reason for
  // choosing Astro: a page that mostly sits still should not ship a framework to sit still.

  let state = $state<State>("IDEA")
  let idea = $state("")
  let interpretation = $state<Interpretation | null>(null)
  let questionnaire = $state<Questionnaire | null>(null)
  let answers = $state<Record<string, string>>({})
  let plans = $state<Plan[]>([])
  let feedback = $state("")
  let steps = $state<string[]>([])
  let project = $state<Project | null>(null)
  let error = $state("")
  let busy = $state(false)

  const plan = $derived(plans.at(-1) ?? null)

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

  async function describe() {
    if (!idea.trim() || busy) return
    busy = true; error = ""
    try {
      go("DESCRIBE")
      interpretation = await post("/api/pm/analyze", { idea })
      if (interpretation?.questionnaire) { questionnaire = interpretation.questionnaire; go("ASK") }
      else await propose()
    } catch (e) { error = String(e) } finally { busy = false }
  }

  async function propose() {
    busy = true; error = ""
    try {
      const list: Answer[] = Object.entries(answers).map(([questionId, value]) => ({ questionId, value }))
      const result = await post("/api/pm/plan", { idea, answers: list })
      if ("questions" in result) {
        // A second round is a normal outcome: the answers opened something new.
        questionnaire = result as Questionnaire
        state = "PM_ANALYSIS"; go("ASK")
      } else {
        plans = [...plans, result as Plan]
        state = "PM_ANALYSIS"; go("PROPOSE")
      }
    } catch (e) { error = String(e) } finally { busy = false }
  }

  async function reject() {
    if (!plan || !feedback.trim() || busy) return
    busy = true; error = ""
    try {
      go("REJECT"); go("REVISE")
      const revised: Plan = await post("/api/pm/plan", { plan, feedback }, "PUT")
      plans = [...plans, revised]
      feedback = ""
      go("PROPOSE")
    } catch (e) { error = String(e) } finally { busy = false }
  }

  function approve() {
    if (!plan) return
    plans = [...plans.slice(0, -1), { ...plan, status: "approved" }]
    go("APPROVE")
  }

  async function generate() {
    if (!plan || !mayGenerate(state) || busy) return
    busy = true; error = ""; steps = []; project = null
    try {
      go("GENERATE")
      const r = await fetch("/api/backend/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      })
      if (!r.ok || !r.body) {
        const detail = await r.json().catch(() => ({}))
        throw new Error(detail.detail ?? detail.error ?? `HTTP ${r.status}`)
      }
      for await (const event of readEvents(r.body)) {
        apply(event)
      }
      go("DELIVER")
    } catch (e) { error = String(e); state = "PLAN_APPROVED" } finally { busy = false }
  }

  function apply(event: AgentEvent) {
    if (event.type === "step") steps = [...steps, `${event.name} · ${event.summary}`]
    else if (event.type === "phase") steps = [...steps, event.text]
    if (isDone(event)) project = event.project
  }

  function restart() {
    state = "IDEA"; idea = ""; interpretation = null; questionnaire = null
    answers = {}; plans = []; feedback = ""; steps = []; project = null; error = ""
  }
</script>

<div class="panes">
<section class="chat">
<header class="chat__head">
  <h1>Construir un proyecto</h1>
  <p class="dim">Contás la idea. El PM la convierte en un plan. Vos lo aprobás. Recién ahí se genera.</p>
</header>
<div class="run">
  {#if state === "IDEA"}
    <div class="card">
      <h2>¿Qué querés construir?</h2>
      <p class="dim">Describilo con tus palabras. Si falta algo, te lo voy a preguntar antes de proponerte nada.</p>
      <textarea bind:value={idea} rows="4" maxlength="4000" placeholder="Una API de reservas para un consultorio…"></textarea>
      <button class="btn btn--primary" onclick={describe} disabled={busy || !idea.trim()}>Empezar</button>
    </div>
  {/if}

  {#if interpretation && state !== "IDEA"}
    <div class="card"><h3>Lo que entendí</h3><p class="pre">{interpretation.summary}</p></div>
  {/if}

  {#if state === "QUESTIONNAIRE" && questionnaire}
    <div class="card">
      <h3>Antes de seguir</h3>
      <p class="dim">{questionnaire.reason}</p>
      {#each questionnaire.questions as q}
        <label class="q">
          <span>{q.text}</span>
          {#if q.options}
            <select bind:value={answers[q.id]}>
              <option value="" disabled selected>Elegí una</option>
              {#each q.options as o}<option>{o}</option>{/each}
            </select>
          {:else}
            <input bind:value={answers[q.id]} placeholder="Tu respuesta" />
          {/if}
        </label>
      {/each}
      <button class="btn btn--primary" onclick={propose} disabled={busy}>Generar el plan</button>
    </div>
  {/if}

  {#if plan && (state === "PLAN_REVIEW" || state === "PLAN_REJECTED" || state === "PM_REVISION")}
    <div class="card">
      <div class="row">
        <h3>Plan v{plan.version}</h3>
        {#if plan.revisionOf}<span class="dim">revisión de la v{plan.revisionOf.version}</span>{/if}
      </div>
      <p class="pre">{plan.purpose}</p>

      <h4>Entidades</h4>
      <ul>{#each plan.entities as e}<li><b>{e.name}</b> — {e.fields.join(", ")}</li>{/each}</ul>
      <h4>Flujos</h4>
      <ul>{#each plan.flows as f}<li><b>{f.name}</b>: {f.steps.join(" → ")}</li>{/each}</ul>
      <h4>Restricciones</h4>
      <ul>{#each plan.constraints as c}<li>{c.statement}</li>{/each}</ul>

      <!-- Shown as prominently as the rest, not folded away: a plan that hides what it does
           not know reads as more certain than it is. -->
      <h4 class="warn">Lo que este plan NO resuelve</h4>
      <ul class="warn-list">{#each plan.openQuestions as q}<li>{q}</li>{/each}</ul>

      <div class="actions">
        <button class="btn btn--primary" onclick={approve} disabled={busy}>Aceptar el plan</button>
        <input bind:value={feedback} placeholder="Qué cambiarías…" />
        <button class="btn" onclick={reject} disabled={busy || !feedback.trim()}>Pedir cambios</button>
      </div>
    </div>
  {/if}

  {#if plans.length > 1}
    <p class="dim versions">Versiones: {plans.map((p) => `v${p.version}`).join(" → ")}</p>
  {/if}

  {#if state === "PLAN_APPROVED"}
    <div class="card">
      <h3>Plan aprobado</h3>
      <p class="dim">A partir de acá el plan no se modifica. El agente lo usa como especificación.</p>
      <button class="btn btn--primary" onclick={generate} disabled={busy}>Generar el proyecto</button>
    </div>
  {/if}

  {#if steps.length}
    <div class="card">
      <h3>{state === "BACKEND_GENERATION" ? "Generando" : "Lo que pasó"}</h3>
      <ol class="steps">{#each steps as s}<li>{s}</li>{/each}</ol>
      {#if state === "BACKEND_GENERATION"}<p class="dim pulse">…</p>{/if}
    </div>
  {/if}

  {#if project}
    {@const badge = badgeForProject(project.status)}
    <div class="card">
      <div class="row">
        <h3>{project.name}</h3>
        <span class="badge badge--{badge.tone}">{badge.label}</span>
      </div>
      <p class="dim">{badge.detail}</p>
      <p class="dim">Los {project.totals.files} archivos están a la derecha. El ZIP se baja desde ahí.</p>
      <button class="btn" onclick={restart}>Empezar otro</button>
    </div>
  {/if}

  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>
</section>

<Files {project} {busy} />
</div>

<style>
  /* Three panes across the window: the sidebar is a sibling in index.astro, the chat is a
     fixed column, and the project panel takes whatever is left — code is what wants the
     room. The chat scrolls on its own so a long conversation never pushes the file tree
     off the screen. */
  .panes { display: flex; flex: 1; min-height: 0; min-width: 0; }
  .chat { flex: 0 0 clamp(360px, 34vw, 480px); min-width: 0; overflow-y: auto; padding: 1.6rem clamp(1rem, 2.2vw, 1.8rem); }
  .chat__head { margin-bottom: 1.2rem; }
  .chat__head h1 { margin: 0 0 0.25rem; font-size: 1.4rem; }
  .run { display: flex; flex-direction: column; gap: 1rem; }

  /* Below this the two panes stack, and the chat stops being a scroll container of its own
     — nested scrolling on a phone means one of the two always traps the gesture. */
  @media (max-width: 1100px) {
    .panes { flex-direction: column; }
    .chat { flex: 0 0 auto; overflow: visible; }
  }
  h2 { margin: 0 0 0.35rem; font-size: 1.35rem; }
  h3 { margin: 0 0 0.35rem; font-size: 1.05rem; }
  h4 { margin: 1rem 0 0.3rem; font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-dim); }
  h4.warn { color: var(--pending); }
  .dim { color: var(--text-dim); margin: 0.2rem 0; }
  .pre { white-space: pre-wrap; }
  .row { display: flex; align-items: center; gap: 0.75rem; justify-content: space-between; }
  ul, ol { margin: 0.2rem 0; padding-left: 1.1rem; }
  .warn-list { color: var(--pending); }
  .steps { font-family: var(--mono); font-size: 0.85rem; color: var(--text-dim); }
  .q { display: flex; flex-direction: column; gap: 0.3rem; margin: 0.75rem 0; }
  textarea, input, select {
    width: 100%; background: var(--surface-2); color: var(--text);
    border: 1px solid var(--line); border-radius: 10px; padding: 0.65rem 0.8rem; font: inherit;
  }
  .actions { display: flex; gap: 0.5rem; align-items: center; margin-top: 1rem; flex-wrap: wrap; }
  .actions input { flex: 1 1 14rem; width: auto; }
  .versions { font-family: var(--mono); font-size: 0.82rem; }
  .error { color: var(--bad); }
  .btn { text-decoration: none; display: inline-block; }
</style>
