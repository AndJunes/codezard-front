import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { KEY, authorization, clear, expired, load, save, shorten } from "./session"
import type { Session } from "./types"

/**
 * A stand-in for `localStorage` that can also be made to fail the way a real one does.
 *
 * Private windows, blocked site data and cross-origin iframes all throw on the property
 * access itself — not on the method — which is why every read in `session.ts` is wrapped and
 * why this double can be told to throw.
 */
function storage(throws = false) {
  const data = new Map<string, string>()
  return {
    data,
    getItem(key: string) {
      if (throws) throw new DOMException("denied", "SecurityError")
      return data.get(key) ?? null
    },
    setItem(key: string, value: string) {
      if (throws) throw new DOMException("denied", "SecurityError")
      data.set(key, value)
    },
    removeItem(key: string) {
      if (throws) throw new DOMException("denied", "SecurityError")
      data.delete(key)
    },
  }
}

const NOW = 1_700_000_000_000
const ALIVE: Session = {
  address: "G" + "A".repeat(55),
  token: "head.tail",
  expires_at: Math.floor(NOW / 1000) + 3_600,
}

function use(fake: ReturnType<typeof storage>): void {
  vi.stubGlobal("localStorage", fake)
}

afterEach(() => vi.unstubAllGlobals())

describe("loading a session", () => {
  let fake: ReturnType<typeof storage>

  beforeEach(() => {
    fake = storage()
    use(fake)
  })

  it("comes back as it went in", () => {
    save(ALIVE)
    expect(load(NOW)).toEqual(ALIVE)
  })

  it("is a NEW object every call, which is a trap worth knowing about", () => {
    // It parses JSON, so two calls are equal but never the same object. Harmless on its own,
    // and the reason a billing screen once refetched itself several times a second: an
    // `$effect` that did `session = load()` and then read `session` saw a fresh object every
    // run, counted it as a change, and woke itself up forever. Anything assigning this into
    // reactive state must not also read that state in the same effect.
    save(ALIVE)
    const first = load(NOW)
    const second = load(NOW)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
  })

  it("is nothing when none was saved", () => {
    expect(load(NOW)).toBeNull()
  })

  it("drops one that expired rather than returning it", () => {
    // A token that is kept around is one that something will eventually send.
    save({ ...ALIVE, expires_at: Math.floor(NOW / 1000) - 10 })
    expect(load(NOW)).toBeNull()
    expect(fake.data.has(KEY)).toBe(false)
  })

  it("drops one that is about to expire", () => {
    const seconds = 30
    save({ ...ALIVE, expires_at: Math.floor(NOW / 1000) + seconds })
    expect(load(NOW)).toBeNull()
  })

  it("drops something that is not JSON", () => {
    fake.data.set(KEY, "{not json")
    expect(load(NOW)).toBeNull()
    expect(fake.data.has(KEY)).toBe(false)
  })

  it("drops something that is JSON but is not a session", () => {
    fake.data.set(KEY, JSON.stringify({ hello: "world" }))
    expect(load(NOW)).toBeNull()
  })
})

describe("when storage is unavailable", () => {
  it("reads as no session rather than throwing", () => {
    use(storage(true))
    expect(() => load(NOW)).not.toThrow()
    expect(load(NOW)).toBeNull()
  })

  it("saving still hands the session back for this tab", () => {
    use(storage(true))
    // It will not survive a reload, and that is the whole cost: the screen keeps working.
    expect(save(ALIVE)).toEqual(ALIVE)
  })

  it("clearing does nothing and says nothing", () => {
    use(storage(true))
    expect(() => clear()).not.toThrow()
  })
})

describe("the authorization header", () => {
  it("is a bearer token when there is a session", () => {
    expect(authorization(ALIVE)).toEqual({ Authorization: "Bearer head.tail" })
  })

  it("is nothing at all when there is not", () => {
    // Not an empty `Authorization`, which a server would have to decide what to do with.
    expect(authorization(null)).toEqual({})
  })
})

describe("expiry", () => {
  it("is decided against the clock it is given", () => {
    expect(expired(ALIVE, NOW)).toBe(false)
    expect(expired(ALIVE, NOW + 3_600_000)).toBe(true)
  })
})

describe("shortening an address", () => {
  it("keeps both ends, which is what a person checks", () => {
    expect(shorten("G" + "A".repeat(50) + "WXYZ12")).toBe("GAAAAA…WXYZ12")
  })

  it("leaves something already short alone", () => {
    expect(shorten("GABC")).toBe("GABC")
  })
})
