/**
 * Turning the gateway's numbers into something a person reads.
 *
 * Kept out of the component so that the rules are testable and stated once. A token count is
 * the number this whole product is priced in, and "4.000.000" across three columns is a
 * figure nobody compares at a glance — "4M" is.
 */

import type { EntryKind, LedgerEntry, Money } from "./types"

/** `4_000_000` → `"4M"`, `12_500` → `"12,5k"`, `900` → `"900"`. */
export function tokens(count: number): string {
  const value = Math.abs(count)
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`
  if (value >= 1_000) return `${trim(value / 1_000)}k`
  return String(value)
}

/** Exact, for the one place a person checks the arithmetic. */
export function exact(count: number): string {
  return new Intl.NumberFormat("es").format(count)
}

function trim(value: number): string {
  // One decimal, and not a trailing ",0": `4M` reads as four million, `4,0M` reads as a
  // measurement.
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded)
    ? String(rounded)
    : String(rounded).replace(".", ",")
}

export function usd(amount: Money): string {
  return `US$ ${amount.usd}`
}

/** `"80.0000000" XLM` → `"80 XLM"`. Seven decimals is a protocol detail, not a price tag. */
export function asset(amount: string, code: string): string {
  const trimmed = amount.includes(".")
    ? amount.replace(/0+$/, "").replace(/\.$/, "")
    : amount
  return `${trimmed} ${code}`
}

/** A date a person can read, in their own locale, without the seconds. */
export function when(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** How long is left, in words. `""` once there is none. */
export function remaining(iso: string, now: number = Date.now()): string {
  const ms = new Date(iso).getTime() - now
  if (!Number.isFinite(ms) || ms <= 0) return ""
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.floor(hours / 24)} días`
}

const LABELS: Record<EntryKind, string> = {
  grant: "Incluido en el plan",
  purchase: "Compra",
  usage: "Consumo",
  refund: "Devolución",
  adjustment: "Ajuste",
  expiry: "Fin del período",
}

export function label(kind: EntryKind): string {
  return LABELS[kind] ?? kind
}

/** The badge a movement gets. A debit is not a failure, so it is not red. */
export function tone(entry: LedgerEntry): "good" | "neutral" | "pending" {
  if (entry.tokens > 0) return "good"
  return entry.kind === "expiry" ? "pending" : "neutral"
}

/** `+4M` / `−12,5k`. A real minus sign, not a hyphen. */
export function delta(count: number): string {
  return `${count >= 0 ? "+" : "−"}${tokens(count)}`
}
