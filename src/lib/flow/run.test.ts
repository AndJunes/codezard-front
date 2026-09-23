import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { KEY } from "../billing/session"
import { RunError, start } from "./run"

/**
 * What a failed run call becomes.
 *
 * The one thing worth pinning here is that a 402 is not flattened into `Error("HTTP 402")`.
 * That status carries a price, an address and a memo, and losing them turns "here is what
 * this costs" into "something went wrong".
 */

function storage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  }
}

const SESSION = JSON.stringify({
  address: "G" + "A".repeat(55),
  token: "head.tail",
  expires_at: Math.floor(Date.now() / 1000) + 3_600,
})

/**
 * `fetch`, replaced, and typed with its real signature.
 *
 * `vi.fn(async () => ...)` infers a mock that takes no arguments, and then `calls[0][1]` is
 * out of bounds at the type level — so the assertions about which URL and which headers were
 * sent would not compile, which are the assertions worth making.
 */
function answering(status: number, body: unknown) {
  const fetched = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  )
  vi.stubGlobal("fetch", fetched)
  return fetched
}

const QUOTE = {
  x402Version: 1,
  error: "this gateway charges for runs: sign in or pay per call",
  accepts: [
    {
      scheme: "exact",
      network: "stellar-testnet",
      maxAmountRequired: "5.0000000",
      asset: "XLM",
      payTo: "G" + "B".repeat(55),
      resource: "/runs",
      description: "833,333 CodeZard tokens",
      maxTimeoutSeconds: 120,
      extra: { memo: "cz123" },
    },
  ],
}

beforeEach(() => vi.stubGlobal("localStorage", storage()))
afterEach(() => vi.unstubAllGlobals())

describe("starting a run", () => {
  it("carries the session so the gateway knows whose balance to check", async () => {
    vi.stubGlobal("localStorage", storage({ [KEY]: SESSION }))
    const fetched = answering(200, { runId: "r1", state: "PM_ANALYSIS" })

    await start("a bike workshop tracker")

    const headers = fetched.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer head.tail")
  })

  it("sends no authorization at all when nobody is signed in", async () => {
    const fetched = answering(200, { runId: "r1", state: "PM_ANALYSIS" })
    await start("an idea")

    const headers = fetched.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })
})

describe("a 402 from the gateway", () => {
  it("is marked as a request for money rather than a failure", async () => {
    answering(402, QUOTE)

    const raised = await start("an idea").catch((error: RunError) => error)

    expect(raised).toBeInstanceOf(RunError)
    expect((raised as RunError).needsPayment).toBe(true)
  })

  it("keeps the price, the address and the memo", async () => {
    answering(402, QUOTE)

    const raised = (await start("an idea").catch((error: RunError) => error)) as RunError
    const offer = raised.payment?.accepts[0]

    expect(offer?.maxAmountRequired).toBe("5.0000000")
    expect(offer?.asset).toBe("XLM")
    expect(offer?.extra.memo).toBe("cz123")
  })

  it("uses the document's own sentence rather than the bare status", async () => {
    answering(402, QUOTE)
    await expect(start("an idea")).rejects.toThrow(/charges for runs/)
  })
})

describe("every other failure", () => {
  it("keeps the gateway's message and code", async () => {
    answering(409, { error: { code: "illegal_transition", message: "APPROVE no se permite" } })

    const raised = (await start("an idea").catch((error: RunError) => error)) as RunError

    expect(raised.message).toBe("APPROVE no se permite")
    expect(raised.code).toBe("illegal_transition")
    expect(raised.needsPayment).toBe(false)
    expect(raised.payment).toBeNull()
  })

  it("falls back to the status when there is nothing to quote", async () => {
    answering(502, {})
    await expect(start("an idea")).rejects.toThrow("HTTP 502")
  })

  it("does not read a 402 from elsewhere in the stack as a quote", async () => {
    // A proxy or a CDN can answer 402 with its own body. Without `accepts` it is not an
    // x402 document and pretending otherwise would draw a paywall with no price in it.
    answering(402, { error: { message: "upstream refused" } })

    const raised = (await start("an idea").catch((error: RunError) => error)) as RunError
    expect(raised.payment).toBeNull()
    expect(raised.message).toBe("upstream refused")
  })
})
