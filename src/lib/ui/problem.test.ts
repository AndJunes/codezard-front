import { describe, expect, it } from "vitest"
import { cancelled, readable } from "./problem"

/**
 * The bug this file exists for: connecting a wallet showed the words "object Object".
 *
 * Stellar Wallets Kit rejects with plain objects — `{ code, message }` — and a wallet
 * extension nests its own inside that. Neither is an `Error`, so `raised instanceof Error`
 * is false and `String(raised)` runs, which is exactly how a plain object renders.
 */

describe("what a wallet actually throws", () => {
  it("reads the kit's own rejection", () => {
    // Stellar Wallets Kit, verbatim from its source.
    expect(readable({ code: -3, message: "Please set the wallet first" })).toBe(
      "Please set the wallet first",
    )
  })

  it("reads an extension's error nested inside the kit's", () => {
    expect(readable({ error: { code: -4, message: "User declined access" } })).toBe(
      "User declined access",
    )
  })

  it("prefers the nested message over the outer one", () => {
    // The outer is the kit saying "something went wrong"; the inner is the wallet saying
    // what. The second is the one worth showing.
    const raised = { message: "Unhandled error from the wallet", error: { message: "Locked" } }
    expect(readable(raised)).toBe("Locked")
  })

  it("never renders the words object Object", () => {
    for (const raised of [{ code: -1 }, {}, { weird: true }, Object.create(null)]) {
      expect(readable(raised)).not.toContain("object Object")
    }
  })

  it("quotes a bare code, because a person can at least report that", () => {
    expect(readable({ code: -4 })).toContain("-4")
    expect(readable({ code: -4, ext: "no permission" })).toContain("no permission")
  })
})

describe("everything else that can be thrown", () => {
  it("an Error keeps its message", () => {
    expect(readable(new Error("boom"))).toBe("boom")
  })

  it("a string is already a sentence", () => {
    expect(readable("plain trouble")).toBe("plain trouble")
  })

  it("null and undefined say something rather than nothing", () => {
    expect(readable(null)).toBeTruthy()
    expect(readable(undefined)).toBeTruthy()
    expect(readable(null)).not.toContain("null")
  })

  it("an Error with no message does not come back empty", () => {
    // An empty red box is worse than a vague one: it looks like the app lost its place.
    expect(readable(new Error())).toBeTruthy()
  })

  it("an unanticipated shape is still legible", () => {
    expect(readable({ status: 503, upstream: "horizon" })).toContain("horizon")
  })

  it("something circular does not take the screen down with it", () => {
    const loop: Record<string, unknown> = { code: undefined }
    loop.self = loop
    expect(() => readable(loop)).not.toThrow()
    expect(readable(loop)).toBeTruthy()
  })
})

describe("changing your mind is not a failure", () => {
  it("closing the picker is a cancellation", () => {
    // The kit rejects with this when the modal is dismissed, using the same code -1 it uses
    // for real problems — so the phrasing is the only thing that can tell them apart.
    expect(cancelled({ code: -1, message: "The user closed the modal." })).toBe(true)
  })

  it("so is refusing to sign, however the wallet words it", () => {
    for (const message of [
      "User declined access",
      "User rejected the request",
      "The request was declined",
      "Cancelled by user",
      "User denied the signature",
    ]) {
      expect(cancelled({ message }), message).toBe(true)
    }
  })

  it("a real problem is not mistaken for one", () => {
    for (const raised of [
      { code: -1, message: "There is no active address, the user needs to authenticate first." },
      { message: "Network request failed" },
      { code: -3, message: "Please set the wallet first" },
      new Error("the signature does not match that account"),
    ]) {
      expect(cancelled(raised), readable(raised)).toBe(false)
    }
  })
})
