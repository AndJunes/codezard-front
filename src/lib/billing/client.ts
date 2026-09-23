/**
 * Everything the screen asks the gateway about money. Seven calls, no decisions.
 *
 * Like `flow/run.ts`, this is a client and nothing more: it does not know what a plan costs,
 * whether a balance is enough, or whether an invoice has been paid. Those are the gateway's
 * to answer, and a second opinion held here would be a second thing that can be wrong about
 * somebody's money.
 *
 * The one piece of judgement it does exercise is about ERRORS, and it is this: a 402 is not a
 * failure. It is the server quoting a price, in the shape an x402 client reads, and turning
 * it into `Error("HTTP 402")` would throw away the only part worth showing.
 */

import { authorization, clear, load, save } from "./session"
import type {
  Account,
  Catalogue,
  Challenge,
  Invoice,
  PaymentRequired,
  Session,
} from "./types"

/** The gateway's own message, not a generic one. */
export class BillingError extends Error {
  constructor(
    message: string,
    readonly code = "",
    readonly status = 0,
  ) {
    super(message)
  }
}

/**
 * A 402. Carries the price rather than only the refusal.
 *
 * Separate from `BillingError` so that a caller has to decide what to do about being asked
 * for money — a screen shows a paywall, a retry loop gives up — instead of it arriving as
 * one more message in a red box.
 */
export class PaymentRequiredError extends BillingError {
  constructor(readonly document: PaymentRequired) {
    super(document.error || "This needs to be paid for", "payment_required", 402)
  }
}

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const session = load()
  const response = await fetch(`/api/billing${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...authorization(session) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const payload = await response.json().catch(() => ({}))
  if (response.ok) return payload as T

  if (response.status === 402 && isPaymentRequired(payload)) {
    throw new PaymentRequiredError(payload)
  }
  if (response.status === 401) {
    // The token is gone or rejected. Dropping it here means the next call does not send it
    // again and get the same answer — and the screen sees a signed-out state rather than a
    // signed-in one that fails every request.
    clear()
  }
  const error = (payload as { error?: { message?: string; code?: string } })?.error
  throw new BillingError(
    error?.message ?? `HTTP ${response.status}`,
    error?.code ?? "",
    response.status,
  )
}

/** Is this body a 402 document, or something else that happened to arrive with that status? */
export function isPaymentRequired(payload: unknown): payload is PaymentRequired {
  const body = payload as PaymentRequired | null
  return Boolean(body && typeof body === "object" && Array.isArray(body.accepts))
}

// ── the price list ───────────────────────────────────────────────────────────

/** Public: what is on sale, and what a token costs. */
export const catalogue = () => call<Catalogue>("/plans")

// ── signing in ───────────────────────────────────────────────────────────────

/** Ask for the text the wallet has to sign. */
export const challenge = (address: string) =>
  call<Challenge>("/auth/challenge", "POST", { address })

/**
 * Hand back the signature and keep the session.
 *
 * The address is NOT sent: it is sealed inside the challenge, which is what stops a caller
 * from naming somebody else's account and signing their own.
 */
export async function verify(challengeToken: string, signature: string): Promise<Session> {
  const session = await call<Session>("/auth/verify", "POST", {
    challenge: challengeToken,
    signature,
  })
  return save(session)
}

export function signOut(): void {
  clear()
}

// ── the account ──────────────────────────────────────────────────────────────

/** Balance, subscription and recent movements, in one read. */
export const account = () => call<Account>("")

// ── buying ───────────────────────────────────────────────────────────────────

/** Create an invoice. Its amount is frozen the moment it is created. */
export const checkout = (sku: string, asset = "") =>
  call<Invoice>("/checkout", "POST", { sku, asset })

/**
 * Has it been paid?
 *
 * Safe to poll: the gateway asks the network every time, and crediting the tokens behind it
 * is keyed on the invoice id, so calling this ten times credits once.
 */
export const invoice = (id: string) => call<Invoice>(`/invoices/${id}`)
