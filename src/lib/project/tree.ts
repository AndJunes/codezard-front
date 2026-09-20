/**
 * Turns the agent's flat file list into the nested structure the visualiser draws.
 *
 * The agent sends `files: [{path: "src/main.py", ...}, ...]` — paths, not a tree. Building
 * the tree here rather than in the component keeps it testable and keeps the component from
 * doing two jobs at once.
 */

import type { ProjectFile } from "../agents/events"

export type TreeFile = { kind: "file"; name: string; path: string; file: ProjectFile }
export type TreeDir = { kind: "dir"; name: string; path: string; children: TreeNode[] }
export type TreeNode = TreeFile | TreeDir

export function buildTree(files: readonly ProjectFile[]): TreeNode[] {
  const root: TreeDir = { kind: "dir", name: "", path: "", children: [] }
  // Keyed by full path, so two directories that share a name at different depths stay
  // separate — `src/api` and `tests/api` are not the same node.
  const directories = new Map<string, TreeDir>([["", root]])

  for (const file of files) {
    const segments = file.path.split("/").filter((segment) => segment && segment !== ".")
    const name = segments.pop()
    if (name === undefined) continue // A path of only separators; nothing to place.

    let parent = root
    let prefix = ""
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment
      let directory = directories.get(prefix)
      if (!directory) {
        directory = { kind: "dir", name: segment, path: prefix, children: [] }
        directories.set(prefix, directory)
        parent.children.push(directory)
      }
      parent = directory
    }
    parent.children.push({ kind: "file", name, path: file.path, file })
  }

  return sortInPlace(root.children)
}

/** Directories first, then alphabetical — the order every file explorer uses. */
function sortInPlace(nodes: TreeNode[]): TreeNode[] {
  nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1))
  for (const node of nodes) if (node.kind === "dir") sortInPlace(node.children)
  return nodes
}

/** Every directory path in the tree, for "expand everything by default". */
export function directoryPaths(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "dir" ? [node.path, ...directoryPaths(node.children)] : [],
  )
}

/**
 * The file to show before the user picks one.
 *
 * A README first, because it is what a person opens first; otherwise the first file that
 * actually has text. Landing on a file the agent redacted would make the panel look broken
 * on arrival.
 */
export function defaultSelection(files: readonly ProjectFile[]): string | null {
  const readable = files.filter((file) => file.text !== null)
  const readme = readable.find((file) => /^readme(\.|$)/i.test(file.path.split("/").pop() ?? ""))
  return (readme ?? readable[0] ?? files[0])?.path ?? null
}
