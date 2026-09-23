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
  /**
   * The gateway asking to be paid, which is not the same as something going wrong.
   *
   * Its own kind rather than an `error` with a nicer sentence, because the two need
   * different endings: an error says what broke, and this says what it costs and where to
   * go. Drawn in red with the rest, it would read as a failure the person caused.
   */
  | {
      id: string
      from: "agent"
      kind: "paywall"
      text: string
      /** What one run costs, as the 402 quoted it. Empty when it could not be priced. */
      price: string
    }

let counter = 0
/** Stable keys for the `{#each}`. Nothing outside the transcript reads these. */
export const messageId = (): string => `m${++counter}`

export const seconds = (ms: number): string =>
  ms < 1000 ? `${Math.max(ms, 0)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
