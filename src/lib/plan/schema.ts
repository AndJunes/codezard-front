/**
 * The plan: what the PM produces and the Backend consumes.
 *
 * This shape did not exist anywhere. The closest thing is FR-1.2 of the PRD, which asks for
 * "a structured specification containing: purpose, entities, user roles, core flows, and
 * non-functional constraints" — five fields in prose, no schema, no example. Writing it down
 * here is what turns a paragraph into a contract, so every field below is a decision.
 */

export type Entity = {
  name: string
  description: string
  fields: string[]
}

export type Role = {
  name: string
  can: string[]
}

export type Flow = {
  name: string
  steps: string[]
}

export type Constraint = {
  kind: "performance" | "security" | "compatibility" | "other"
  statement: string
}

export type PlanStatus = "draft" | "approved"

export type Plan = {
  /** 1, 2, 3… A rejection never mutates a plan: it produces the next version. */
  version: number
  purpose: string
  entities: Entity[]
  roles: Role[]
  flows: Flow[]
  constraints: Constraint[]
  /**
   * What the PM could not settle, in plain words.
   *
   * Not in the PRD, and added on purpose. DR-2 forbids the evidence bundle from ever
   * declaring an empty `not_checked`, for the same reason: a plan that does not say what it
   * does not know reads as more certain than it is, and this whole product rests on not
   * doing that. An empty array here is a claim, and it should be a rare one.
   */
  openQuestions: string[]
  status: PlanStatus
  /** Why this version exists. Empty for v1; the user's own words for the rest. */
  revisionOf?: { version: number; feedback: string }
}

export type Question = {
  id: string
  /** The question in plain language — UX-3 forbids jargon without a gloss. */
  text: string
  /** Free text when absent. Options make the answer comparable across runs. */
  options?: string[]
}

export type Questionnaire = {
  /** Why these questions and not others. Shown above them, so they do not feel arbitrary. */
  reason: string
  questions: Question[]
}

export type Answer = { questionId: string; value: string }

export type Interpretation = {
  /** What the PM understood, before asking anything. FR-1.2. */
  summary: string
  /** Absent when the idea was complete enough, which is rare. */
  questionnaire?: Questionnaire
}

export const isApproved = (plan: Plan): boolean => plan.status === "approved"
