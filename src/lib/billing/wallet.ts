/**
 * Signing in, through Stellar Wallets Kit.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: the secret key never enters this page. The kit talks to
 * whichever wallet the person picked — Freighter, xBull, LOBSTR, Hana — and each of those
 * holds the key, shows the person what they are about to sign, and hands back a signature.
 * Nothing here can read a seed, and nothing here should ever ask for one: a field that
 * accepts a secret key is a field that ends up in a screenshot.
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

import { cancelled, readable } from "../ui/problem"

/**
 * The wallets on offer, imported one by one rather than through `defaultModules()`.
 *
 * `defaultModules()` looks like the obvious call and is the wrong one here. It CONSTRUCTS
 * every module before returning them, so its `filterBy` cannot prevent a constructor from
 * doing anything — and one of them does. MetaMask's module (`@metamask/connect-stellar`)
 * reaches for a Snap session as soon as it is built; on a browser without MetaMask that
 * request does not fail, it TIMES OUT ("Failed to restore Stellar MetaMask session:
 * Transport request timed out"), and the picker never opens. Measured in a real browser:
 * clicking "Entrar con mi billetera" did nothing at all, with no error to show for it.
 *
 * Importing each module also keeps the whole MetaMask package out of the bundle, which is
 * the second reason to do it this way.
 *
 * WHICH WALLETS, AND WHY NOT ALL OF THEM
 *     Signing in here means signing a message. Albedo and Rabet declare `signMessage` and
 *     then refuse it outright ("Albedo does not support the signMessage function"), so
 *     listing them offers a door that is painted on: the person picks their own wallet and
 *     is told it cannot do the one thing being asked. They are left out until sign-in has a
 *     path that does not need a signed message.
 *
 * Adding one is a line here, and the cost of getting it wrong is somebody unable to sign in,
 * so they are named rather than collected.
 */
async function wallets() {
  const [freighter, xbull, lobstr, hana] = await Promise.all([
    import("@creit.tech/stellar-wallets-kit/modules/freighter"),
    import("@creit.tech/stellar-wallets-kit/modules/xbull"),
    import("@creit.tech/stellar-wallets-kit/modules/lobstr"),
    import("@creit.tech/stellar-wallets-kit/modules/hana"),
  ])
  return [
    new freighter.FreighterModule(),
    new xbull.xBullModule(),
    new lobstr.LobstrModule(),
    new hana.HanaModule(),
  ]
}

/** What the gateway calls its network, and what the kit calls the same thing. */
const PASSPHRASES: Record<string, string> = {
  "stellar-testnet": "Test SDF Network ; September 2015",
  stellar: "Public Global Stellar Network ; September 2015",
}

export class WalletError extends Error {}

/**
 * The person closed the picker, or refused to sign.
 *
 * Its own type because the screen's answer is nothing at all: showing a red box to somebody
 * who deliberately clicked away tells them they broke something they chose not to do.
 */
export class WalletCancelled extends WalletError {}

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
  const target = passphrase as (typeof Networks)[keyof typeof Networks]

  if (started === null) {
    // The kit defaults to a light picker, which lands as a white sheet over a dark page and
    // reads as somebody else's dialog rather than part of this one.
    const { SwkAppDarkTheme } = await import("@creit.tech/stellar-wallets-kit/types")
    StellarWalletsKit.init({
      modules: await wallets(),
      network: target,
      theme: SwkAppDarkTheme,
    })
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
  let address: string | undefined
  try {
    ;({ address } = await kit.authModal())
  } catch (raised) {
    // Closing the picker is not a failure. The kit rejects with the same `code: -1` it uses
    // for real problems, so the phrasing is what tells them apart — see `ui/problem.ts`.
    if (cancelled(raised)) throw new WalletCancelled("Cancelaste la conexión.")
    throw new WalletError(readable(raised))
  }
  if (!address) {
    throw new WalletError(
      "La billetera no devolvió ninguna dirección. ¿Está desbloqueada?",
    )
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
    if (cancelled(raised)) throw new WalletCancelled("No firmaste el mensaje.")
    throw new WalletError(readable(raised))
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
    if (cancelled(raised)) throw new WalletCancelled("No firmaste la transacción.")
    throw new WalletError(readable(raised))
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

export function base64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
