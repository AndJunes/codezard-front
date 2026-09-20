/**
 * The transcript: everything said so far, in the order it was said.
 *
 * A list of messages rather than a set of "current" fields. The difference shows when a plan
 * is rejected: the old version stays where it was written instead of being overwritten by
 * its replacement, which is what makes "the earlier versions remain consultable" true by
 * construction rather than by remembering to keep a copy.
 */

import type { Plan } from "../plan/schema"
import type { Project } from "../agents/events"

export type Message =
  | { id: string; from: "user"; kind: "text"; text: string }
  /** A finished questionnaire, folded back into the conversation as one turn. */
  | { id: string; from: "user"; kind: "answers"; pairs: { question: string; answer: string }[] }
  | { id: string; from: "agent"; kind: "text"; text: string }
  | { id: string; from: "agent"; kind: "plan"; plan: Plan }
  | { id: string; from: "agent"; kind: "steps"; steps: string[]; running: boolean; ms: number }
  | { id: string; from: "agent"; kind: "project"; project: Project }
  | { id: string; from: "agent"; kind: "error"; text: string }

let counter = 0
/** Stable keys for the `{#each}`. Nothing outside the transcript reads these. */
export const messageId = (): string => `m${++counter}`

export const seconds = (ms: number): string =>
  ms < 1000 ? `${Math.max(ms, 0)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
