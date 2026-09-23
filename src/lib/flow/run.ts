import type { Plan, Questionnaire } from "../plan/schema"

/**
 * The run, as the screen sees it.
 *
 * This is the whole client: five calls that each return the complete run, and one that
 * streams. There is no state machine here, no round counter, no merge policy for answers and
 * no prompt — those moved to the gateway, which is the only place that can enforce them.
 * What the screen keeps is what it is for: what to draw.
 *
 * `state` is read, never written. Before, the island assigned it on every step and also
 * assigned `plan.status = "approved"`, which is how approval came to be a claim rather than
 * an act.
 */
export type RunState =
  | "IDEA"
  | "PM_ANALYSIS"
  | "QUESTIONNAIRE"
  | "PLAN_REVIEW"
  | "PLAN_REJECTED"
  | "PM_REVISION"
  | "PLAN_APPROVED"
  | "BACKEND_GENERATION"
  | "ZIP_READY"
  | "FAILED"

export interface Run {
  runId: string
  state: RunState
  idea: string
  summary: string
  questionnaire: Questionnaire | null
  plan: Plan | null
  answers: { questionId: string; value: string }[]
  round: number
  maxRounds: number
  artifactId: string
  error: string
}

/** The gateway's own message, not a generic one. Its errors say which agent and why. */
export class RunError extends Error {
  constructor(message: string, readonly code = "", readonly status = 0) {
    super(message)
  }
}

async function call(path: string, method = "POST", body?: unknown): Promise<Run> {
  const response = await fetch(`/api/run${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    // The 409 for "not approved yet" and the 502 carrying an agent's own words are both worth
    // showing as they are; flattening them into "something went wrong" throws away the only
    // sentence that says what to do next.
    const error = payload?.error
    throw new RunError(
      error?.message ?? payload?.detail ?? `HTTP ${response.status}`,
      error?.code ?? "",
      response.status,
    )
  }
  return payload as Run
}

/** An idea becomes a run. The PM is asked what it understood, and usually asks back. */
export const start = (idea: string) => call("", "POST", { idea })

/** The answers go back. The gateway decides whether that is a plan or another round. */
export const answer = (runId: string, answers: { questionId: string; value: string }[]) =>
  call(`/${runId}/answers`, "POST", { answers })

/** A rejection. The next version is a new plan, never an edit of the last. */
export const reject = (runId: string, feedback: string) =>
  call(`/${runId}/rejection`, "POST", { feedback })

/** The gate, and it sends no body: there is nothing left for the caller to claim. */
export const approve = (runId: string) => call(`/${runId}/approval`, "POST", {})

/** What a reloaded tab asks for. */
export const read = (runId: string) => call(`/${runId}`, "GET")

/** The generation's event stream. The caller reads it; the run's state moves server-side. */
export async function generate(runId: string): Promise<ReadableStream<Uint8Array>> {
  return stream(`/api/run/${runId}/generation`, "POST")
}

/**
 * Everything the run has already said, and everything it says next.
 *
 * What a tab that lost the connection asks for. `read` says WHERE a run is; this says how it
 * got there. A finished run replays and ends immediately, which is what a reload after the
 * fact wants; one still generating replays and then keeps going.
 */
export const follow = (runId: string) => stream(`/api/run/${runId}/events`, "GET")

async function stream(path: string, method: string): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
  })
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}))
    throw new RunError(
      payload?.error?.message ?? `HTTP ${response.status}`,
      payload?.error?.code ?? "",
      response.status,
    )
  }
  return response.body
}
