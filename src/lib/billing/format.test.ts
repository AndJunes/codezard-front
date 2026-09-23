import { describe, expect, it } from "vitest"
import { asset, delta, label, remaining, tokens, tone, usd, when } from "./format"
import type { LedgerEntry } from "./types"

function entry(changes: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "e1",
    kind: "purchase",
    tokens: 1_000,
    at: "2026-09-23T12:00:00+00:00",
    amount: { micros: 8_000_000, usd: "8" },
    reference: "invoice:cz1",
    memo: "",
    ...changes,
  }
}

describe("token counts", () => {
  it("are shortened, because nobody compares seven digits at a glance", () => {
    expect(tokens(4_000_000)).toBe("4M")
    expect(tokens(12_500)).toBe("12,5k")
    expect(tokens(900)).toBe("900")
  })

  it("never say 4,0M when they mean 4M", () => {
    expect(tokens(4_000_000)).not.toContain(",")
    expect(tokens(1_000)).toBe("1k")
  })

  it("read the same either side of zero", () => {
    expect(tokens(-12_500)).toBe("12,5k")
  })

  it("show a sign when they are a movement", () => {
    expect(delta(4_200)).toBe("+4,2k")
    // A real minus sign: a hyphen in a column of numbers reads as a dash.
    expect(delta(-4_200)).toBe("−4,2k")
    expect(delta(0)).toBe("+0")
  })
})

describe("money", () => {
  it("is printed from the string the gateway sent, never recomputed", () => {
    expect(usd({ micros: 19_000_000, usd: "19" })).toBe("US$ 19")
  })

  it("loses the protocol's trailing zeros", () => {
    // Seven decimals is how Stellar spells an amount. It is not a price tag.
    expect(asset("80.0000000", "XLM")).toBe("80 XLM")
    expect(asset("0.5000000", "XLM")).toBe("0.5 XLM")
  })

  it("leaves an integer amount alone", () => {
    expect(asset("80", "USDC")).toBe("80 USDC")
  })
})

describe("dates", () => {
  it("are rendered, not echoed", () => {
    expect(when("2026-09-23T12:00:00+00:00")).not.toBe("2026-09-23T12:00:00+00:00")
  })

  it("hand back something unreadable unchanged rather than saying Invalid Date", () => {
    expect(when("not a date")).toBe("not a date")
  })
})

describe("how long is left", () => {
  const now = Date.parse("2026-09-23T12:00:00Z")

  it("counts in minutes inside an hour", () => {
    expect(remaining("2026-09-23T12:25:00Z", now)).toBe("25 min")
  })

  it("never says zero while there is still time", () => {
    expect(remaining("2026-09-23T12:00:30Z", now)).toBe("1 min")
  })

  it("says nothing at all once there is none", () => {
    // The screen has a different sentence for an expired quote; this must not compete.
    expect(remaining("2026-09-23T11:59:00Z", now)).toBe("")
  })

  it("moves up to hours and days", () => {
    expect(remaining("2026-09-24T06:00:00Z", now)).toBe("18 h")
    expect(remaining("2026-09-28T12:00:00Z", now)).toBe("5 días")
  })
})

describe("what a movement looks like", () => {
  it("names each kind in words", () => {
    expect(label("grant")).toBe("Incluido en el plan")
    expect(label("usage")).toBe("Consumo")
  })

  it("does not paint a debit as a failure", () => {
    // Spending tokens is the product working. Red is for something going wrong.
    expect(tone(entry({ kind: "usage", tokens: -500 }))).toBe("neutral")
  })

  it("marks a credit as good and an expiry as worth noticing", () => {
    expect(tone(entry({ kind: "purchase", tokens: 1_000 }))).toBe("good")
    expect(tone(entry({ kind: "expiry", tokens: -1_000 }))).toBe("pending")
  })
})
