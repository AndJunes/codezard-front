/**
 * The states of the user story, and the only place that decides which move is legal.
 *
 * The rule this exists to enforce: the Backend cannot start until the user has explicitly
 * approved a plan. Keeping that in one table — rather than in whichever component happens to
 * render the button — is what makes it checkable, and what lets the server refuse a request
 * that never went through the screen at all.
 */

export type State =
  | "IDEA"
  | "PM_ANALYSIS"
  | "QUESTIONNAIRE"
  | "PLAN_REVIEW"
  | "PLAN_REJECTED"
  | "PM_REVISION"
  | "PLAN_APPROVED"
  | "BACKEND_GENERATION"
  | "ZIP_READY"

export type Event =
  | "DESCRIBE"   // the user writes the idea
  | "ASK"        // the PM needs more information
  | "PROPOSE"    // the PM produces a plan
  | "REJECT"     // the user asks for changes
  | "REVISE"     // the PM takes the feedback
  | "APPROVE"    // the user accepts, and only this opens the Backend
  | "GENERATE"
  | "DELIVER"
  | "RESET"

const TRANSITIONS: Record<State, Partial<Record<Event, State>>> = {
  IDEA: { DESCRIBE: "PM_ANALYSIS" },
  // The PM may ask again after reading the answers: a second round of questions is a normal
  // outcome, not a failure. That is why ASK loops back here from QUESTIONNAIRE.
  PM_ANALYSIS: { ASK: "QUESTIONNAIRE", PROPOSE: "PLAN_REVIEW" },
  QUESTIONNAIRE: { DESCRIBE: "PM_ANALYSIS", ASK: "QUESTIONNAIRE" },
  PLAN_REVIEW: { REJECT: "PLAN_REJECTED", APPROVE: "PLAN_APPROVED" },
  PLAN_REJECTED: { REVISE: "PM_REVISION" },
  PM_REVISION: { PROPOSE: "PLAN_REVIEW" },
  // No way back. Once approved, the plan is frozen for this run: CA-08.
  PLAN_APPROVED: { GENERATE: "BACKEND_GENERATION" },
  BACKEND_GENERATION: { DELIVER: "ZIP_READY" },
  ZIP_READY: { RESET: "IDEA" },
}

export function next(state: State, event: Event): State | null {
  return TRANSITIONS[state][event] ?? null
}

export function can(state: State, event: Event): boolean {
  return next(state, event) !== null
}

/** The single gate the Backend sits behind. */
export function mayGenerate(state: State): boolean {
  return can(state, "GENERATE")
}
