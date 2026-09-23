/**
 * The backend agent's streaming contract, as types.
 *
 * Mirrors `docs/es/api.md` of agente-backend. Written down here so that the day the backend
 * renames a field, this project stops compiling instead of rendering `undefined` at a user.
 */

export type ExecutionStatus = "passed" | "failed" | "no_evidence" | "not_executed"

export type ProjectStatus =
  /** The plan asked for files that were never written. Off to the side, like FAILED. */
  | "INCOMPLETE"
  | "GENERATED"
  | "VALIDATED"
  | "EXECUTED"
  | "TESTED"
  | "VERIFIED"
  | "PARTIAL"
  | "FAILED"

export type ProjectFile = {
  path: string
  bytes: number
  lines: number
  sha256: string
  /** Null when the project is over the size cap, or the file looks like a credential. */
  text: string | null
  why_no_text?: string
}

export type Project = {
  id: string
  name: string
  status: ProjectStatus
  simulated: boolean
  reason: string
  files: ProjectFile[]
  totals: { files: number; directories: number; lines: number }
  zip: { name: string; bytes: number; sha256: string } | null
  integrity: { ok: boolean; reason: string }
  /**
   * What the certifier did, in order: structure, syntax, imports, tests, the documented
   * command, the CRUD probe. The agent has always sent it and nothing drew it, so "how did this
   * run?" had no answer on screen.
   */
  phases?: { name: string; status: string; detail: string }[]
  /**
   * Relative, and used verbatim.
   *
   * The agent's docs are explicit: "la URL siempre se toma de `project.download_url` en el
   * stream del chat; el cliente nunca la arma". Composing it from `id` would break silently
   * the day the route changes.
   */
  download_url: string | null
}

export type StepEvent = {
  type: "step"
  name: string
  status: "executed" | "skipped" | "fallback" | "error"
  summary: string
  ms: number
  source: string
  detail?: {
    /**
     * What this step WROTE: path to content, for the generation steps.
     *
     * It is a preview, and `done` stays authoritative — a repair can replace any of these
     * before the project is certified, so the two are allowed to differ. `null` means the
     * agent sent the path without its text, which it does past its own size ceiling.
     */
    wrote?: Record<string, string | null>
  } | null
}

export type DoneEvent = {
  type: "done"
  answer: string
  evidence: { observed: { status: ExecutionStatus } | null } | null
  cost: { text: string } | null
  project: Project | null
}

export type AgentEvent =
  | StepEvent
  | DoneEvent
  | { type: "phase"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; name: string; result: string }
  | { type: "cost"; text: string }

export const isDone = (event: AgentEvent): event is DoneEvent => event.type === "done"

/**
 * Splits an SSE byte stream into events.
 *
 * The agent sends `data: {json}\n\n` with no `event:` field — the kind is inside the JSON.
 * A chunk can end mid-event, so the tail is kept for the next read; dropping it silently
 * loses whole events under load, which is the bug this shape exists to avoid.
 */
export const readEvents = (body: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> =>
  readSse<AgentEvent>(body)

/** The same framing for any event shape: the console speaks it too. */
export async function* readSse<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const parts = buffer.split("\n\n")
    buffer = parts.pop() ?? ""
    for (const part of parts) {
      if (!part.startsWith("data: ")) continue
      yield JSON.parse(part.slice(6)) as T
    }
  }
}
