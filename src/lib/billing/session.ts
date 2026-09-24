/**
 * Where the session token lives, and the one rule about it.
 *
 * THE RULE: this file never sees a secret key. A Stellar secret seed is the account; putting
 * one in a browser — even in memory, even "just to sign once" — is handing over the balance
 * to every script on the page and every extension watching it. What is stored here is a
 * token the GATEWAY minted, which proves an address and expires in hours. Losing it costs a
 * sign-in; losing a seed costs everything.
 *
 * `localStorage` and not a cookie, on purpose: a cookie would be attached to every request to
 * this origin automatically, including the ones this app does not make. The token is read
 * explicitly and sent explicitly, by the two places that talk to the gateway.
 *
 * Every access is wrapped: in a private window, with site data blocked, or inside an iframe
 * with third-party storage disabled, `localStorage` throws on the property access itself. A
 * billing screen that cannot remember a session should still draw.
 */

import type { Session } from "./types"

export const KEY = "cz:session"

/** A minute of slack, so a token is never sent in the second it dies. */
const SKEW_S = 60

export function load(now: number = Date.now()): Session | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return null
  }
  if (!raw) return null

  let session: Session
  try {
    session = JSON.parse(raw) as Session
  } catch {
    clear()
    return null
  }
  if (!session?.token || !session?.address) {
    clear()
    return null
  }
  if (expired(session, now)) {
    // Removed rather than returned and ignored: a token that is kept around is one that
    // something will eventually send.
    clear()
    return null
  }
  return session
}

export function save(session: Session): Session {
  try {
    localStorage.setItem(KEY, JSON.stringify(session))
  } catch {
    // Storage is unavailable or full. The session still works for this tab — the caller holds
    // it in memory — it just will not survive a reload.
  }
  return session
}

export function clear(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing to do: there is no storage to clear.
  }
}

export function expired(session: Session, now: number = Date.now()): boolean {
  return session.expires_at * 1000 - SKEW_S * 1000 <= now
}

/** The `Authorization` header for a session, or nothing at all. */
export function authorization(session: Session | null): Record<string, string> {
  return session ? { Authorization: `Bearer ${session.token}` } : {}
}

/** `GABC…WXYZ`. An address is 56 characters and a screen has room for about twelve. */
export function shorten(address: string, edge = 6): string {
  return address.length > edge * 2 + 1
    ? `${address.slice(0, edge)}…${address.slice(-edge)}`
    : address
}
