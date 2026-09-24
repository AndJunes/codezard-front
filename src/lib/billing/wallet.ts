/**
 * Signing in, through Stellar Wallets Kit.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: the secret key never enters this page. The kit talks to
 * whichever wallet the person picked — Freighter, xBull, Albedo, Lobstr, Rabet, Hana, a
 * Ledger — and each of those holds the key, shows the person what they are about to sign, and
 * hands back a signature. Nothing here can read a seed, and nothing here should ever ask for
 * one: a field that accepts a secret key is a field that ends up in a screenshot.
 *
 * WHY THE KIT AND NOT ONE WALLET
 *     The first version of this feature-detected Freighter on `window`. That works and it
 *     picks a winner: anyone holding their account in xBull or on a Ledger simply could not
 *     sign in. The kit is one interface over all of them, with the wallet picker included, so
 *     "which wallet" stops being a decision this code makes on somebody else's behalf.
 *
 * WHY IT IS IMPORTED LAZILY
 *     Two reasons, and both are load-bearing. The kit registers custom elements and reaches
 *     for `window` at import time, so importing it at the top of a module would run during
 *     server-side rendering and crash the page before it painted. And it is a large
 *     dependency that only matters to somebody who is about to sign in — on the first paint
 *     of a billing screen nobody has clicked anything yet.
 *
 * WHICH NETWORK
 *     The gateway's, always. It is read from `/billing/plans` and passed in, because a
 *     signature made for the wrong Stellar verifies nowhere and the failure reads as "your
 *     wallet is broken" rather than as a mismatch.
 */

/** What the gateway calls its network, and what the kit calls the same thing. */
const PASSPHRASES: Record<string, string> = {
  "stellar-testnet": "Test SDF Network ; September 2015",
  stellar: "Public Global Stellar Network ; September 2015",
}

export class WalletError extends Error {}

let started: string | null = null

type Kit = typeof import("@creit.tech/stellar-wallets-kit").StellarWalletsKit

/**
 * Load the kit and point it at ``network``. Safe to call repeatedly.
 *
 * `init` is called once per page; asking for a different network afterwards only changes the
 * network, because re-initialising would throw away the wallet the person already picked.
 */
async function load(network: string): Promise<Kit> {
  if (typeof window === "undefined") {
    throw new WalletError("A wallet can only be reached from a browser")
  }
  const passphrase = PASSPHRASES[network]
  if (!passphrase) {
    throw new WalletError(`This gateway is on an unknown Stellar network (${network})`)
  }

  const { StellarWalletsKit, Networks } = await import("@creit.tech/stellar-wallets-kit")
  const { defaultModules } = await import("@creit.tech/stellar-wallets-kit/modules/utils")
  const target = passphrase as (typeof Networks)[keyof typeof Networks]

  if (started === null) {
    // `defaultModules()` is every wallet that needs no extra configuration. WalletConnect is
    // deliberately not among them: it wants a project id, and a sign-in button that fails
    // for want of one is worse than one wallet fewer.
    StellarWalletsKit.init({ modules: defaultModules(), network: target })
    started = network
  } else if (started !== network) {
    StellarWalletsKit.setNetwork(target)
    started = network
  }
  return StellarWalletsKit
}

/**
 * Open the wallet picker and return the address the person connected with.
 *
 * The modal is the kit's own. It lists what is installed, offers to install what is not, and
 * ends with the wallet selected — which is why this returns an address rather than a wallet:
 * from here on the kit knows which one to talk to.
 */
export async function connect(network: string): Promise<string> {
  const kit = await load(network)
  const { address } = await kit.authModal()
  if (!address) {
    throw new WalletError("The wallet did not hand over an address. Is it unlocked?")
  }
  return address
}

/**
 * Sign the gateway's challenge, and return the signature as base64.
 *
 * Not every wallet can sign an arbitrary message — it is optional in SEP-43, and a hardware
 * wallet may refuse. That comes back as a plain error rather than as a stack trace, because
 * the person's options at that point are a different wallet or a different way in, and they
 * need to be told which.
 */
export async function sign(network: string, address: string, message: string): Promise<string> {
  const kit = await load(network)
  let signed: { signedMessage?: unknown }
  try {
    signed = await kit.signMessage(message, {
      address,
      networkPassphrase: PASSPHRASES[network],
    })
  } catch (raised) {
    throw new WalletError(reason(raised))
  }
  const value = signed?.signedMessage
  if (typeof value === "string" && value) return value
  // SEP-43 says base64; some wallets answer with the raw bytes anyway.
  if (value instanceof Uint8Array) return base64(value)
  throw new WalletError("This wallet cannot sign a message. Try another one.")
}

/**
 * Sign a transaction the GATEWAY built, and hand the signed XDR back.
 *
 * The browser never assembles a Soroban invocation. Doing that means simulating it first to
 * learn its resource footprint, and shipping that machinery here would be a second
 * implementation of something the gateway already has. So the gateway says what the
 * transaction is, the wallet says who agrees to it, and neither can do the other's half.
 */
export async function signTransaction(
  network: string,
  address: string,
  xdr: string,
): Promise<string> {
  const kit = await load(network)
  let signed: { signedTxXdr?: string }
  try {
    signed = await kit.signTransaction(xdr, {
      address,
      networkPassphrase: PASSPHRASES[network],
    })
  } catch (raised) {
    throw new WalletError(reason(raised))
  }
  if (!signed?.signedTxXdr) {
    throw new WalletError("The wallet returned no signed transaction.")
  }
  return signed.signedTxXdr
}

/** Let the wallet go. The session token is dropped separately: they are different things. */
export async function disconnect(): Promise<void> {
  if (started === null) return
  try {
    const { StellarWalletsKit } = await import("@creit.tech/stellar-wallets-kit")
    await StellarWalletsKit.disconnect()
  } catch {
    // Nothing to disconnect, or a wallet that does not implement it. Either way the page is
    // already treating the person as signed out.
  }
}

/** The kit reports errors as `{ code, message }`; everything else is whatever was thrown. */
function reason(raised: unknown): string {
  const error = raised as { message?: string } | null
  if (error && typeof error.message === "string" && error.message) return error.message
  return String(raised)
}

export function base64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
