/**
 * Turning anything that was thrown into a sentence a person can read.
 *
 * WHY THIS EXISTS
 *     `String(raised)` gives `"[object Object]"` for every plain object, and plain objects
 *     are exactly what browser wallets throw. Stellar Wallets Kit rejects with
 *     `{ code, message }`; a wallet extension underneath it nests its own as
 *     `{ error: { code, message } }`. Neither is an `Error`, so `raised instanceof Error`
 *     is false and the fallback runs — which is how a working wallet flow ends up showing
 *     the words "object Object" to somebody trying to sign in.
 *
 *     Anything thrown can reach a screen, so the translation belongs in one place rather
 *     than in each `catch`. `JSON.stringify` is the last resort instead of `String`: a shape
 *     nobody anticipated should still be legible enough to report.
 */

/** The shapes seen in practice. Everything else falls through to the last resort. */
interface Thrown {
  message?: unknown
  error?: { message?: unknown; code?: unknown; ext?: unknown } | string
  code?: unknown
  ext?: unknown
  detail?: unknown
}

/**
 * Words that mean "the person changed their mind", in the phrasings wallets actually use.
 *
 * Matched on the message and not on a code, reluctantly: the kit answers `code: -1` for
 * closing the modal AND for "there is no active address", so the code cannot tell them
 * apart. Getting this wrong in one direction shows a red error to somebody who simply
 * clicked away; in the other it stays quiet about a real failure — so the list is kept to
 * phrases that cannot mean anything else.
 */
const CANCELLED =
  /\b(closed the modal|user (declined|rejected|denied|cancell?ed)|request (was )?(declined|rejected)|cancell?ed by (the )?user)\b/i

export function readable(raised: unknown): string {
  if (raised == null) return "Algo falló y no dijo qué."
  if (typeof raised === "string") return raised
  if (raised instanceof Error && raised.message) return raised.message

  const thrown = raised as Thrown

  // A wallet extension's own error, nested by the kit.
  if (thrown.error && typeof thrown.error === "object") {
    const inner = thrown.error as { message?: unknown }
    if (typeof inner.message === "string" && inner.message) return inner.message
  }
  if (typeof thrown.error === "string" && thrown.error) return thrown.error
  if (typeof thrown.message === "string" && thrown.message) return thrown.message
  if (typeof thrown.detail === "string" && thrown.detail) return thrown.detail

  // No message, but a code is still something a person can quote when asking for help.
  const code = thrown.code
  if (typeof code === "number" || typeof code === "string") {
    const extra = typeof thrown.ext === "string" && thrown.ext ? `: ${thrown.ext}` : ""
    return `La billetera respondió con el error ${code}${extra}.`
  }

  try {
    const json = JSON.stringify(raised)
    // `{}` is what an object with no enumerable fields serialises to, which says no more
    // than "[object Object]" did.
    if (json && json !== "{}") return json
  } catch {
    // Circular, or something that refuses to serialise.
  }
  return "Algo falló y no dijo qué."
}

/** Did the person simply change their mind? Then there is nothing to report. */
export function cancelled(raised: unknown): boolean {
  return CANCELLED.test(readable(raised))
}
