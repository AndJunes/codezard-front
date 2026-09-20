/**
 * Highlighting and Markdown, loaded only when a file that needs them is opened.
 *
 * Both libraries together are several times the size of this whole app, and neither is
 * needed to describe an idea, answer a questionnaire or approve a plan. They arrive on the
 * first click on a file, not on the first paint of the page.
 */

type Highlighter = typeof import("highlight.js").default
type MarkdownIt = InstanceType<typeof import("markdown-it").default>

/** highlight.js registers ~190 grammars; these are the ones the agent actually emits. */
const GRAMMARS = {
  python: () => import("highlight.js/lib/languages/python"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  json: () => import("highlight.js/lib/languages/json"),
  bash: () => import("highlight.js/lib/languages/bash"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  ini: () => import("highlight.js/lib/languages/ini"),
  sql: () => import("highlight.js/lib/languages/sql"),
  xml: () => import("highlight.js/lib/languages/xml"),
  css: () => import("highlight.js/lib/languages/css"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
} as const

let highlighter: Promise<Highlighter> | null = null
let markdown: Promise<MarkdownIt> | null = null

function loadHighlighter(): Promise<Highlighter> {
  const ids = Object.keys(GRAMMARS) as (keyof typeof GRAMMARS)[]
  return Promise.all([import("highlight.js/lib/core"), ...ids.map((id) => GRAMMARS[id]())]).then(
    ([core, ...loaded]) => {
      const hljs = core.default
      ids.forEach((id, index) => hljs.registerLanguage(id, loaded[index].default))
      return hljs
    },
  )
}

function ready(): Promise<Highlighter> {
  return (highlighter ??= loadHighlighter())
}

export async function highlight(source: string, language: string): Promise<string> {
  const hljs = await ready()
  if (!hljs.getLanguage(language)) return escapeHtml(source)
  // `ignoreIllegals` because this is model-written code: a file that does not quite parse
  // should still be readable, not throw and blank the panel.
  return hljs.highlight(source, { language, ignoreIllegals: true }).value
}

function loadMarkdown(): Promise<MarkdownIt> {
  return Promise.all([import("markdown-it"), ready()]).then(([{ default: MarkdownIt }, hljs]) =>
    new MarkdownIt({
      // Off deliberately. The README is written by a language model, so raw HTML inside it
      // is untrusted input; `html: false` makes markdown-it escape it instead of running
      // it, and markdown-it's own link validator already refuses `javascript:` and `data:`.
      // That safety is why this uses markdown-it rather than a smaller renderer that passes
      // HTML straight through and needs a sanitiser bolted on afterwards.
      html: false,
      linkify: true,
      highlight: (code, language) =>
        language && hljs.getLanguage(language)
          ? hljs.highlight(code, { language, ignoreIllegals: true }).value
          : "", // returning nothing makes markdown-it escape the block itself
    }),
  )
}

export async function renderMarkdown(source: string): Promise<string> {
  const md = await (markdown ??= loadMarkdown())
  return md.render(source)
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"))
}
