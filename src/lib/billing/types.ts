/**
 * The shapes the gateway sends. Written out rather than inferred, so that a change on the
 * server surfaces here as a type error instead of as `undefined` on a screen about money.
 *
 * Amounts arrive as BOTH an integer number of micros and a decimal string. The string is for
 * reading; the integer is for arithmetic. Nothing on this side ever adds money — the gateway
 * does that — and keeping the integer available means nothing here has to parse the string
 * back if that ever changes.
 */

export interface Money {
  micros: number
  /** `"19"`, `"0.5"`. Already trimmed: no trailing zeros to strip. */
  usd: string
}

export interface Product {
  id: string
  kind: "plan" | "pack"
  name: string
  price: Money
  tokens: number
  description: string
  /** Plans only. */
  cadence?: string
  /** Plans only: how long one grant lasts. 7 for the free plan, 30 for the paid ones. */
  period_days?: number
  /** Plans only: granted rather than sold, and it renews itself. */
  free?: boolean
  overage?: boolean
}

export interface Pricing {
  per_million: Money
  margin_bps: number
  minimum_charge: number
}

export interface Catalogue {
  plans: Product[]
  packs: Product[]
  pricing: Pricing
  /** The asset payments settle in: `"XLM"` or `"USDC"`. */
  asset: string
  /** Tokens an account must hold before a run may start. */
  reserve: number
  /**
   * Which Stellar the gateway is on: `"stellar-testnet"` or `"stellar"`.
   *
   * The browser needs it to tell the wallet which network to sign for. Guessing it produces
   * signatures that verify nowhere, and the failure reads as a broken wallet.
   */
  network: string
}

export interface Balance {
  account: string
  /** From the current subscription period. Lost at renewal. */
  granted: number
  /** Bought outright. Kept. */
  purchased: number
  total: number
}

export interface Subscription {
  account: string
  plan: string
  status: "active" | "expired" | "cancelled"
  started_at: string
  renews_at: string
}

export type EntryKind =
  | "grant"
  | "purchase"
  | "usage"
  | "refund"
  | "adjustment"
  | "expiry"

export interface LedgerEntry {
  id: string
  kind: EntryKind
  /** Signed: positive credits, negative debits. */
  tokens: number
  at: string
  amount: Money
  reference: string
  memo: string
}

/** What has been spent, and on how many runs. Derived from the ledger, never a counter. */
export interface Usage {
  tokens: number
  runs: number
  cost: Money
  /** The start of the window. `null` means "everything". */
  since: string | null
}

export interface Account {
  account: string
  balance: Balance
  subscription: Subscription | null
  plan: Product | null
  /** This period only, which is the window the balance is about. */
  usage: Usage
  /** Everything, ever. The comparison that makes the first number mean something. */
  lifetime: Usage
  entries: LedgerEntry[]
}

export interface Invoice {
  id: string
  account: string
  sku: string
  kind: "plan" | "pack" | "x402"
  tokens: number
  price: Money
  asset: string
  /** What to transfer, as the network spells amounts. */
  amount: string
  destination: string
  /** What the payment must carry so it can be matched. It is the id. */
  memo: string
  status: "pending" | "paid" | "expired" | "cancelled"
  created_at: string
  expires_at: string
  tx_hash: string
}

export interface Challenge {
  address: string
  /** The exact text the wallet has to sign. Readable on purpose. */
  message: string
  /** The sealed challenge, handed back unchanged when verifying. */
  challenge: string
  expires_in: number
}

export interface Session {
  address: string
  token: string
  /** Unix seconds. */
  expires_at: number
}

/**
 * What a 402 carries: why, and everything that would be accepted instead.
 *
 * Deliberately the protocol's own shape rather than this app's error envelope. An x402
 * client reads exactly these keys, and a screen that understands them can show a price
 * instead of the word "error".
 */
export interface PaymentRequirement {
  scheme: string
  network: string
  maxAmountRequired: string
  resource: string
  description: string
  payTo: string
  asset: string
  maxTimeoutSeconds: number
  extra: Record<string, unknown>
}

export interface PaymentRequired {
  x402Version: number
  error: string
  accepts: PaymentRequirement[]
}
