/**
 * Talking to a Stellar wallet extension, without depending on one.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: the secret key never enters this page. Signing happens
 * inside the extension, which holds the key, shows the person what they are about to sign and
 * hands back a signature. Nothing here can read a seed, and nothing here should ever ask for
 * one — a field that accepts a secret key is a field that ends up in a screenshot, a password
 * manager and a support ticket.
 *
 * Freighter is detected rather than imported. Bundling a wallet SDK would add a dependency to
 * a page that works without it, and would pin one wallet as THE wallet. What is used here is
 * the small injected API the extension puts on `window`, behind feature detection, so a
 * browser with no wallet gets an honest "there is none" instead of a crash.
 *
 * The API is asynchronous and injected late: an extension is not guaranteed to have run by
 * the time this module does, so `detect` waits briefly rather than deciding on the first
 * frame that nothing is installed.
 */

export interface Wallet {
  readonly name: string
  /** The public key the wallet is currently unlocked to. */
  address(): Promise<string>
  /** Sign arbitrary bytes and return the signature, base64. */
  sign(message: string, address: string): Promise<string>
}

/** What Freighter injects. Only the three calls used here are described. */
interface FreighterApi {
  isConnected?: () => Promise<boolean | { isConnected: boolean }>
  requestAccess?: () => Promise<string | { address?: string; error?: unknown }>
  getAddress?: () => Promise<{ address?: string; error?: unknown }>
  getPublicKey?: () => Promise<string>
  signMessage?: (
    message: string,
    options?: { address?: string },
  ) => Promise<string | { signedMessage?: string | Uint8Array; signerAddress?: string; error?: unknown }>
}

declare global {
  interface Window {
    freighterApi?: FreighterApi
  }
}

const POLL_MS = 100
const WAIT_MS = 1_500

export class WalletError extends Error {}

/**
 * The wallet in this browser, or `null`.
 *
 * Polls briefly because extensions inject on their own schedule; a single synchronous check
 * on load reports "no wallet" to people who have one.
 */
export async function detect(timeoutMs = WAIT_MS): Promise<Wallet | null> {
  if (typeof window === "undefined") return null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (window.freighterApi) return freighter(window.freighterApi)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return window.freighterApi ? freighter(window.freighterApi) : null
}

function freighter(api: FreighterApi): Wallet {
  return {
    name: "Freighter",

    async address(): Promise<string> {
      // `requestAccess` is what prompts the person to connect; `getAddress` only answers once
      // they have. Asking for access first is what makes the first click work.
      const granted = await api.requestAccess?.().catch(() => null)
      const fromAccess = typeof granted === "string" ? granted : granted?.address
      if (fromAccess) return fromAccess

      const current = await api.getAddress?.().catch(() => null)
      if (current?.address) return current.address

      // The older API, still what some installed versions expose.
      const legacy = await api.getPublicKey?.().catch(() => null)
      if (legacy) return legacy

      throw new WalletError("The wallet did not hand over an address. Is it unlocked?")
    },

    async sign(message: string, address: string): Promise<string> {
      if (!api.signMessage) {
        throw new WalletError(
          "This wallet cannot sign a message. Update Freighter, or pay an invoice instead.",
        )
      }
      const signed = await api.signMessage(message, { address })
      const raw = typeof signed === "string" ? signed : signed?.signedMessage
      if (!raw) throw new WalletError("The wallet returned no signature.")
      return typeof raw === "string" ? raw : base64(raw)
    },
  }
}

/** Bytes to base64, which is how the gateway expects a signature. */
export function base64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
