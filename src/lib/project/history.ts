import type { Project } from "../agents/events"
import type { Run, RunState } from "../flow/run"

/**
 * The projects this browser has opened, and a copy of what each one showed.
 *
 * The gateway keeps a run for an hour and only in memory — a restart or a lunch break and it
 * is gone, by design. Before this the browser kept ONE id (`cz:run`) and, worse, threw it away
 * on any failed read, including the gateway being down for a moment. So a project you had just
 * been looking at could vanish from the screen and from the browser in the same reload.
 *
 * Two things are kept, and they are not equal:
 *
 *   the index      ids and short titles. Pointers. The server stays the authority: an id is
 *                  only ever asked about, and approving or generating goes by id, never by
 *                  anything stored here.
 *   the snapshot   what the screen already showed — the run, the steps and the finished
 *                  project — so a project can still be READ once the server has forgotten it.
 *                  It is never sent anywhere and nothing is decided from it; a restored
 *                  project is read-only.
 *
 * Every read and write is wrapped: storage throws in private mode and when it is full, and a
 * history that cannot be saved must not take the chat down with it.
 */

export interface Saved {
  id: string
  /** The idea, clipped. What names the entry until the project has a name of its own. */
  title: string
  /** The generated project's name, once there is one. */
  name: string
  state: RunState
  updatedAt: number
  /** The server said it no longer has this run. The snapshot, if any, is all that is left. */
  gone: boolean
}

export interface Snapshot {
  run: Run
  project: Project | null
  steps: string[]
  ms: number
}

/** Fired on `window` after every write, so the sidebar and the island stay in step. */
export const CHANGED = "cz:history"

const INDEX = "cz:runs"
const SNAPSHOT = "cz:snap:"
const MAX_ENTRIES = 40
/** Snapshots carry file text, up to 400 kB each; storage is about 5 MB in total. */
const MAX_SNAPSHOTS = 6

export const clip = (text: string, max = 64): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const valid = (value: unknown): value is Saved =>
  typeof value === "object" && value !== null &&
  typeof (value as Saved).id === "string" && (value as Saved).id !== "" &&
  typeof (value as Saved).title === "string"

function read(): Saved[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(INDEX) ?? "[]")
    return Array.isArray(parsed) ? parsed.filter(valid) : []
  } catch {
    return []
  }
}

function write(entries: Saved[]): void {
  const kept = [...entries].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ENTRIES)
  try {
    localStorage.setItem(INDEX, JSON.stringify(kept))
    const alive = new Set(kept.slice(0, MAX_SNAPSHOTS).map((entry) => entry.id))
    for (const entry of kept) if (!alive.has(entry.id)) localStorage.removeItem(SNAPSHOT + entry.id)
    for (const entry of entries) {
      if (!kept.some((k) => k.id === entry.id)) localStorage.removeItem(SNAPSHOT + entry.id)
    }
  } catch {}
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHANGED))
}

/** Newest first. */
export const list = (): Saved[] => read().sort((a, b) => b.updatedAt - a.updatedAt)

export function upsert(patch: Partial<Saved> & { id: string }): void {
  const entries = read()
  const found = entries.find((entry) => entry.id === patch.id)
  if (found) Object.assign(found, patch, { updatedAt: Date.now() })
  else {
    entries.push({ title: "", name: "", state: "IDEA", gone: false, ...patch, updatedAt: Date.now() })
  }
  write(entries)
}

export function markGone(id: string): void {
  const entries = read()
  const found = entries.find((entry) => entry.id === id)
  if (!found || found.gone) return
  found.gone = true
  // `updatedAt` is left alone: finding out that the server forgot it is not activity.
  write(entries)
}

export function remove(id: string): void {
  try {
    localStorage.removeItem(SNAPSHOT + id)
  } catch {}
  write(read().filter((entry) => entry.id !== id))
}

export function clear(): void {
  for (const entry of read()) {
    try {
      localStorage.removeItem(SNAPSHOT + entry.id)
    } catch {}
  }
  write([])
}

export function saveSnapshot(id: string, snapshot: Snapshot): void {
  const body = JSON.stringify(snapshot)
  try {
    localStorage.setItem(SNAPSHOT + id, body)
  } catch {
    // Full. Make room by dropping the oldest OTHER snapshot and try once more; a project
    // that cannot be saved is a smaller loss than one that evicts the one being looked at.
    const oldest = list().filter((entry) => entry.id !== id).at(-1)
    if (!oldest) return
    try {
      localStorage.removeItem(SNAPSHOT + oldest.id)
      localStorage.setItem(SNAPSHOT + id, body)
    } catch {}
  }
}

export function loadSnapshot(id: string): Snapshot | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SNAPSHOT + id) ?? "null")
    const snapshot = parsed as Snapshot | null
    return snapshot && typeof snapshot === "object" && snapshot.run?.runId === id ? snapshot : null
  } catch {
    return null
  }
}
