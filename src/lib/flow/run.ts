import { authorization, load } from "../billing/session"
import type { PaymentRequired } from "../billing/types"
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
  /**
   * Who pays for this run. Empty on a gateway that is not charging, and then the whole
   * billing half of this screen stays out of the way.
   */
  account: string
  /** Tokens debited once it delivered. Zero until then, and on a run that never did. */
  charged: number
}

/** The gateway's own message, not a generic one. Its errors say which agent and why. */
export class RunError extends Error {
  constructor(
    message: string,
    readonly code = "",
    readonly status = 0,
    /**
     * The 402 document, when this is a request for money rather than a failure.
     *
     * Carried rather than flattened into the message: it holds the price, the address and
     * the memo, which is everything a screen needs to offer a way forward instead of a red
     * box saying "HTTP 402".
     */
    readonly payment: PaymentRequired | null = null,
  ) {
    super(message)
  }

  /** Is the gateway asking to be paid, as opposed to something having gone wrong? */
  get needsPayment(): boolean {
    return this.status === 402
  }
}

/** Headers for a call that spends money: the session, when there is one. */
function headers(): Record<string, string> {
  return { "Content-Type": "application/json", ...authorization(load()) }
}

function failure(status: number, payload: unknown): RunError {
  // A 402 is the gateway quoting a price, in the shape an x402 client reads. It is not the
  // house error envelope and must not be read as one.
  const body = payload as {
    error?: { message?: string; code?: string } | string
    detail?: string
    accepts?: unknown[]
  } | null
  if (status === 402 && body && Array.isArray(body.accepts)) {
    const document = body as unknown as PaymentRequired
    return new RunError(
      document.error || "This run has to be paid for",
      "payment_required",
      402,
      document,
    )
  }
  // The 409 for "not approved yet" and the 502 carrying an agent's own words are both worth
  // showing as they are; flattening them into "something went wrong" throws away the only
  // sentence that says what to do next.
  const error = typeof body?.error === "object" ? body.error : undefined
  return new RunError(
    error?.message ?? body?.detail ?? `HTTP ${status}`,
    error?.code ?? "",
    status,
  )
}

async function call(path: string, method = "POST", body?: unknown): Promise<Run> {
  const response = await fetch(`/api/run${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw failure(response.status, payload)
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

/**
 * The project's ZIP, through the run.
 *
 * The agent's own `download_url` is relative to the AGENT and its route wants a token the
 * browser never holds, so a link built from it pointed at this page's origin and got a 404.
 * The gateway knows which artifact a run produced and holds the token; the screen only names
 * the run.
 */
export const downloadPath = (runId: string) => `/api/run/${runId}/download`

/** What the console reports for one command. One `exit` ends it, unless an `error` did. */
export type ConsoleEvent =
  | { type: "start"; command: string }
  | { type: "stdout" | "stderr"; text: string }
  | { type: "exit"; code: number | null; ms: number; reason: "" | "stopped" | "timeout" | "output" }
  | { type: "error"; message: string }

/**
 * Run a command in the run's project and read what it prints, as it prints it.
 *
 * Aborting `signal` is how a command is stopped — including a server that never exits: the
 * request closes, the gateway closes the agent's connection, and the agent kills the process
 * tree. There is no separate "kill" call to forget to make.
 */
export async function execute(runId: string, command: string, signal: AbortSignal):
    Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(`/api/run/${runId}/console`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ command }),
    signal,
  })
  if (!response.ok || !response.body) {
    throw failure(response.status, await response.json().catch(() => ({})))
  }
  return response.body
}

async function stream(path: string, method: string): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(path, { method, headers: headers() })
  if (!response.ok || !response.body) {
    throw failure(response.status, await response.json().catch(() => ({})))
  }
  return response.body
}
