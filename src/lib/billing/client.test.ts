import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  BillingError,
  PaymentRequiredError,
  account,
  catalogue,
  checkout,
  isPaymentRequired,
  verify,
} from "./client"
import { KEY } from "./session"

/** A `localStorage` that only has to remember, for the session the client reads. */
function storage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    has: (key: string) => data.has(key),
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

beforeEach(() => vi.stubGlobal("localStorage", storage()))
afterEach(() => vi.unstubAllGlobals())

describe("reading the catalogue", () => {
  it("goes through this app's own proxy, never straight at the gateway", () => {
    // The gateway's address is internal and its tokens are secrets; the browser may not have
    // either. The proxy exists for that and for nothing else.
    const fetched = answering(200, { plans: [], packs: [] })
    void catalogue()
    expect(fetched.mock.calls[0][0]).toBe("/api/billing/plans")
  })

  it("hands back what the gateway said", async () => {
    answering(200, { plans: [{ id: "starter" }], packs: [], asset: "XLM" })
    await expect(catalogue()).resolves.toMatchObject({ asset: "XLM" })
  })
})

describe("the session travelling with a call", () => {
  it("is sent when there is one", async () => {
    vi.stubGlobal("localStorage", storage({ [KEY]: SESSION }))
    const fetched = answering(200, { account: "G" })

    await account()

    const headers = fetched.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer head.tail")
  })

  it("is simply absent when there is none", async () => {
    const fetched = answering(200, { plans: [], packs: [] })
    await catalogue()

    const headers = fetched.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })
})

describe("what an error becomes", () => {
  it("carries the gateway's own message and code", async () => {
    answering(400, { error: { code: "billing_error", message: "no hay plan 'gratis'" } })

    await expect(checkout("gratis")).rejects.toMatchObject({
      message: "no hay plan 'gratis'",
      code: "billing_error",
      status: 400,
    })
  })

  it("falls back to the status when there is no message to show", async () => {
    answering(503, {})
    await expect(catalogue()).rejects.toThrow("HTTP 503")
  })

  it("is a BillingError and not a bare Error", async () => {
    answering(500, {})
    await expect(catalogue()).rejects.toBeInstanceOf(BillingError)
  })
})

describe("a 402", () => {
  const document = {
    x402Version: 1,
    error: "this gateway charges for runs",
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

  it("is a request for money, not a failure, and carries the price", async () => {
    answering(402, document)

    await expect(checkout("tokens-1m")).rejects.toBeInstanceOf(PaymentRequiredError)
    await checkout("tokens-1m").catch((raised: PaymentRequiredError) => {
      expect(raised.document.accepts[0].maxAmountRequired).toBe("5.0000000")
      expect(raised.status).toBe(402)
    })
  })

  it("is only read as one when the body really is that document", async () => {
    // A 402 from somewhere else in the stack — a proxy, a CDN — is an ordinary failure.
    answering(402, { error: { message: "upstream said no" } })
    await expect(checkout("tokens-1m")).rejects.not.toBeInstanceOf(PaymentRequiredError)
  })

  it("is recognised by the shape and not by the status", () => {
    expect(isPaymentRequired({ accepts: [] })).toBe(true)
    expect(isPaymentRequired({ error: "no" })).toBe(false)
    expect(isPaymentRequired(null)).toBe(false)
    expect(isPaymentRequired("402")).toBe(false)
  })
})

describe("a 401", () => {
  it("throws away the token, so the next call is not the same rejection", async () => {
    const store = storage({ [KEY]: SESSION })
    vi.stubGlobal("localStorage", store)
    answering(401, { error: { code: "unauthorized", message: "that session expired" } })

    await expect(account()).rejects.toThrow("that session expired")
    expect(store.has(KEY)).toBe(false)
  })
})

describe("signing in", () => {
  it("sends the sealed challenge back and never the address", async () => {
    // The address is inside the challenge. A caller that could name it would name somebody
    // else's and sign their own.
    const fetched = answering(200, {
      address: "G" + "A".repeat(55),
      token: "new.token",
      expires_at: Math.floor(Date.now() / 1000) + 3_600,
    })

    await verify("sealed.challenge", "c2lnbmF0dXJl")

    const body = JSON.parse(String(fetched.mock.calls[0][1]?.body))
    expect(body).toEqual({ challenge: "sealed.challenge", signature: "c2lnbmF0dXJl" })
    expect(body.address).toBeUndefined()
  })

  it("keeps the session it was given", async () => {
    const store = storage()
    vi.stubGlobal("localStorage", store)
    answering(200, {
      address: "G" + "A".repeat(55),
      token: "new.token",
      expires_at: Math.floor(Date.now() / 1000) + 3_600,
    })

    await verify("sealed", "sig")
    expect(store.has(KEY)).toBe(true)
  })
})
