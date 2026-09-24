import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { base64, connect, sign } from "./wallet"

/**
 * The wallet layer, with Stellar Wallets Kit replaced.
 *
 * What is worth pinning here is not that the kit works — that is the kit's problem. It is
 * that this page picks the gateway's NETWORK rather than guessing one, and that a wallet
 * which cannot sign a message says so instead of producing something unusable. A signature
 * made for the wrong Stellar verifies nowhere, and the failure reads as a broken wallet.
 */

const TESTNET = "Test SDF Network ; September 2015"
const PUBLIC = "Public Global Stellar Network ; September 2015"
const ADDRESS = "G" + "A".repeat(55)

function fakeKit(overrides: Record<string, unknown> = {}) {
  const calls: { init?: unknown; network?: unknown; sign?: unknown } = {}
  const kit = {
    init: vi.fn((params: unknown) => void (calls.init = params)),
    setNetwork: vi.fn((network: unknown) => void (calls.network = network)),
    authModal: vi.fn(async () => ({ address: ADDRESS })),
    signMessage: vi.fn(async (message: string, opts: unknown) => {
      calls.sign = { message, opts }
      return { signedMessage: "c2lnbmF0dXJl" }
    }),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  }
  vi.doMock("@creit.tech/stellar-wallets-kit", () => ({
    StellarWalletsKit: kit,
    Networks: { TESTNET, PUBLIC },
  }))
  vi.doMock("@creit.tech/stellar-wallets-kit/modules/utils", () => ({
    defaultModules: () => [{ productId: "freighter" }],
  }))
  return { kit, calls }
}

/** The module keeps "has the kit been initialised" across calls, so each test needs a fresh
 * copy of it — otherwise the second test sees the first one's kit. */
async function fresh() {
  vi.resetModules()
  return import("./wallet")
}

beforeEach(() => {
  // The module refuses to touch a wallet outside a browser, which is the guard that keeps
  // server-side rendering from crashing on a page nobody has clicked yet. These tests are
  // about what happens INSIDE one, so they say so.
  vi.stubGlobal("window", {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.doUnmock("@creit.tech/stellar-wallets-kit")
  vi.doUnmock("@creit.tech/stellar-wallets-kit/modules/utils")
})

describe("connecting", () => {
  it("returns the address the person picked a wallet with", async () => {
    fakeKit()
    const wallet = await fresh()

    await expect(wallet.connect("stellar-testnet")).resolves.toBe(ADDRESS)
  })

  it("initialises the kit for the network the GATEWAY is on", async () => {
    const { calls } = fakeKit()
    const wallet = await fresh()

    await wallet.connect("stellar")

    expect((calls.init as { network: string }).network).toBe(PUBLIC)
  })

  it("only initialises once, and switches network afterwards", async () => {
    // Re-initialising would throw away the wallet the person already picked.
    const { kit } = fakeKit()
    const wallet = await fresh()

    await wallet.connect("stellar-testnet")
    await wallet.connect("stellar")

    expect(kit.init).toHaveBeenCalledTimes(1)
    expect(kit.setNetwork).toHaveBeenCalledWith(PUBLIC)
  })

  it("refuses a network it does not know rather than signing for the wrong one", async () => {
    fakeKit()
    const wallet = await fresh()

    // Asserted on the message, not the class: `fresh()` re-imports the module, so its
    // `WalletError` is a different identity from the one imported at the top of this file.
    await expect(wallet.connect("ethereum")).rejects.toThrow(/unknown Stellar network/)
  })

  it("says so when the wallet hands over nothing", async () => {
    fakeKit({ authModal: vi.fn(async () => ({ address: "" })) })
    const wallet = await fresh()

    await expect(wallet.connect("stellar-testnet")).rejects.toThrow(/unlocked/)
  })
})

describe("signing", () => {
  it("signs the gateway's own text, for the gateway's own network", async () => {
    const { calls } = fakeKit()
    const wallet = await fresh()

    const signature = await wallet.sign("stellar-testnet", ADDRESS, "CodeZard sign-in\n…")

    expect(signature).toBe("c2lnbmF0dXJl")
    const sent = calls.sign as { message: string; opts: { networkPassphrase: string } }
    expect(sent.message).toContain("CodeZard sign-in")
    expect(sent.opts.networkPassphrase).toBe(TESTNET)
  })

  it("accepts raw bytes from a wallet that answers with them", async () => {
    // SEP-43 says base64; not every wallet does.
    fakeKit({
      signMessage: vi.fn(async () => ({ signedMessage: new Uint8Array([104, 105]) })),
    })
    const wallet = await fresh()

    await expect(wallet.sign("stellar-testnet", ADDRESS, "m")).resolves.toBe(btoa("hi"))
  })

  it("says plainly when a wallet cannot sign a message", async () => {
    // It is optional in SEP-43 and a hardware wallet may refuse. The person's options are a
    // different wallet or a different way in, and they need to be told which.
    fakeKit({ signMessage: vi.fn(async () => ({})) })
    const wallet = await fresh()

    await expect(wallet.sign("stellar-testnet", ADDRESS, "m")).rejects.toThrow(/another one/)
  })

  it("carries the wallet's own refusal instead of a stack trace", async () => {
    fakeKit({
      signMessage: vi.fn(async () => {
        throw { code: 4, message: "The user rejected this request" }
      }),
    })
    const wallet = await fresh()

    await expect(wallet.sign("stellar-testnet", ADDRESS, "m")).rejects.toThrow(/rejected/)
  })
})

describe("base64", () => {
  it("encodes bytes the way a signature is expected", () => {
    expect(base64(new Uint8Array([104, 105]))).toBe(btoa("hi"))
    expect(base64(new Uint8Array())).toBe("")
  })
})

describe("outside a browser", () => {
  it("refuses rather than reaching for a wallet that cannot exist", async () => {
    // Nothing at the top level of the module may touch `window`, or server-side rendering
    // crashes before the page paints. This is the guard that makes that safe.
    vi.unstubAllGlobals()
    const wallet = await fresh()

    await expect(wallet.connect("stellar-testnet")).rejects.toThrow(/browser/)
    expect(typeof connect).toBe("function")
    expect(typeof sign).toBe("function")
  })
})
