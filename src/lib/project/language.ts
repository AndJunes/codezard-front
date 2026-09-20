/**
 * What a file is, decided from its name.
 *
 * Kept away from the renderer so the mapping is one list to read and change, and so that a
 * file the agent invents tomorrow lands on plain text rather than on a wrong grammar —
 * highlighting Python as JSON is worse than not highlighting it at all.
 */

export type FileKind =
  | { render: "markdown" }
  | { render: "code"; language: string }
  | { render: "plain" }

/** Extension → highlight.js language id. Only what the agent actually emits. */
const BY_EXTENSION: Record<string, string> = {
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  json: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  env: "ini",
  sql: "sql",
  html: "xml",
  xml: "xml",
  css: "css",
  dockerfile: "dockerfile",
}

/** Files with no extension, or whose extension says nothing useful. */
const BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  "requirements.txt": "ini",
  ".env": "ini",
  ".env.example": "ini",
  ".gitignore": "ini",
}

export function kindOf(path: string): FileKind {
  const name = (path.split("/").pop() ?? path).toLowerCase()

  if (name.endsWith(".md") || name.endsWith(".markdown")) return { render: "markdown" }

  const byName = BY_NAME[name]
  if (byName) return { render: "code", language: byName }

  // `.env.example` and `requirements.txt` are why the whole name is checked first: taking
  // the last dotted piece would call them "example" and "txt".
  const extension = name.includes(".") ? (name.split(".").pop() ?? "") : ""
  const byExtension = BY_EXTENSION[extension]
  return byExtension ? { render: "code", language: byExtension } : { render: "plain" }
}
