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

/**
 * The wallet modules the page offers, and why they are mocked one by one.
 *
 * `wallet.ts` imports each module's own entrypoint rather than calling `defaultModules()`,
 * because that helper CONSTRUCTS every module it knows — including MetaMask's, which reaches
 * for a Snap session on construction and logs a transport timeout in any browser without it.
 * The cost of importing them by name is this list: a module added there must be added here,
 * or its real dependencies load in Node and fail (`@stellar/freighter-api` is CommonJS).
 *
 * Albedo and Rabet are absent on purpose. Both declare `signMessage` and then refuse it, and
 * signing in here is signing a message, so offering them is offering a dead end.
 */
const WALLETS: ReadonlyArray<readonly [string, string]> = [
  ["@creit.tech/stellar-wallets-kit/modules/freighter", "FreighterModule"],
  ["@creit.tech/stellar-wallets-kit/modules/xbull", "xBullModule"],
  ["@creit.tech/stellar-wallets-kit/modules/lobstr", "LobstrModule"],
  ["@creit.tech/stellar-wallets-kit/modules/hana", "HanaModule"],
]

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
  for (const [path, name] of WALLETS) {
    vi.doMock(path, () => ({ [name]: class {} }))
  }
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
  for (const [path] of WALLETS) vi.doUnmock(path)
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

  it("offers the wallets it names, and nothing it did not", async () => {
    // The guard against going back to `defaultModules()`. That helper builds all fifteen
    // modules it knows before any filter runs, so `filterBy` cannot stop one from doing
    // something on construction — and MetaMask's does: it reaches for a Snap session and
    // logs a transport timeout in every browser without MetaMask installed. Counting the
    // modules is the cheapest thing that notices the day someone swaps the list back.
    const { calls } = fakeKit()
    const wallet = await fresh()

    await wallet.connect("stellar-testnet")

    const { modules } = calls.init as { modules: unknown[] }
    expect(modules).toHaveLength(WALLETS.length)
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

    await expect(wallet.connect("stellar-testnet")).rejects.toThrow(/desbloqueada/)
  })

  it("never lets a plain object reach the screen as [object Object]", async () => {
    // THE bug: the kit rejects with `{ code, message }`, which is not an `Error`, so the
    // screen's `String(raised)` rendered it as the literal words "object Object".
    fakeKit({
      authModal: vi.fn(async () => {
        throw { code: -3, message: "Please set the wallet first" }
      }),
    })
    const wallet = await fresh()

    // `connect` resolves to a string, so the union needs narrowing before `.message`.
    const raised = await wallet
      .connect("stellar-testnet")
      .then(() => null)
      .catch((error: Error) => error)
    expect(raised).toBeInstanceOf(Error)
    expect(raised?.message).toBe("Please set the wallet first")
    expect(raised?.message).not.toContain("object Object")
  })

  it("reads an extension's error out of the kit's wrapper", async () => {
    fakeKit({
      authModal: vi.fn(async () => {
        throw { error: { code: -4, message: "La billetera está bloqueada" } }
      }),
    })
    const wallet = await fresh()

    await expect(wallet.connect("stellar-testnet")).rejects.toThrow(/bloqueada/)
  })

  it("closing the picker is a cancellation, not a failure", async () => {
    // The kit rejects with this when the modal is dismissed. A red box here would tell
    // somebody off for changing their mind.
    fakeKit({
      authModal: vi.fn(async () => {
        throw { code: -1, message: "The user closed the modal." }
      }),
    })
    const wallet = await fresh()

    const raised = await wallet
      .connect("stellar-testnet")
      .then(() => null)
      .catch((error: Error) => error)
    expect(raised?.constructor.name).toBe("WalletCancelled")
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

  it("refusing to sign is a cancellation", async () => {
    fakeKit({
      signMessage: vi.fn(async () => {
        throw { code: 4, message: "The user rejected this request" }
      }),
    })
    const wallet = await fresh()

    const raised = await wallet
      .sign("stellar-testnet", ADDRESS, "m")
      .then(() => null)
      .catch((error: Error) => error)
    expect(raised?.constructor.name).toBe("WalletCancelled")
  })

  it("a real failure carries the wallet's own words", async () => {
    fakeKit({
      signMessage: vi.fn(async () => {
        throw { code: -2, message: "El dispositivo no responde" }
      }),
    })
    const wallet = await fresh()

    await expect(wallet.sign("stellar-testnet", ADDRESS, "m")).rejects.toThrow(/no responde/)
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
