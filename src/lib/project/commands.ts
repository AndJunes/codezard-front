/**
 * The three things a person does first with a generated project — install it, start it, test
 * it — as commands the console will accept, worked out from the project's own files.
 *
 * Read from the files rather than assumed because "start" is not one command: an Express
 * project says it in `package.json`, a Python one says it in whichever module is the
 * entrypoint, and a Go one says nothing this console could run. A suggestion that would only
 * be refused is not offered.
 */

export interface Suggestion {
  label: string
  command: string
}

type FileLike = { path: string; text: string | null }

const ENTRY_CANDIDATES = [
  "src/server.js", "src/index.js", "src/app.js", "server.js", "index.js", "app.js",
]
const PYTHON_ENTRY = ["main.py", "app/main.py", "src/main.py", "server.py", "app.py"]

/** What `npm init` writes and nobody means: running it always fails. */
const PLACEHOLDER_TEST = /no test specified/i

export function suggestions(files: FileLike[]): Suggestion[] {
  const has = (path: string) => files.some((file) => file.path === path)
  const list: Suggestion[] = []

  const manifest = files.find((file) => file.path === "package.json")
  if (manifest) {
    let pkg: { main?: string; scripts?: Record<string, string> } = {}
    try {
      pkg = manifest.text ? JSON.parse(manifest.text) : {}
    } catch {}
    const scripts = pkg.scripts ?? {}

    list.push({ label: "Instalar dependencias", command: "npm install" })

    const entry = pkg.main && has(pkg.main) ? pkg.main : ENTRY_CANDIDATES.find(has)
    if (scripts.start) list.push({ label: "Iniciar", command: "npm start" })
    else if (entry) list.push({ label: "Iniciar", command: `node ${entry}` })

    const hasJsTests = files.some((file) => /^tests?\/.+\.(c|m)?js$/.test(file.path))
    if (scripts.test && !PLACEHOLDER_TEST.test(scripts.test)) {
      list.push({ label: "Tests", command: "npm test" })
    } else if (hasJsTests) {
      list.push({ label: "Tests", command: "node --test tests/" })
    }
    return list
  }

  const python = PYTHON_ENTRY.find(has)
  if (python) list.push({ label: "Iniciar", command: `python3 ${python}` })
  if (files.some((file) => /^tests\/.+\.py$/.test(file.path))) {
    list.push({ label: "Tests", command: "python3 -m unittest discover -s tests -t ." })
  }
  return list
}
