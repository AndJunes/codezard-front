<script lang="ts">
  import { buildTree, directoryPaths, defaultSelection, type TreeNode } from "../../lib/project/tree"
  import { badgeForProject } from "../../lib/ui/status"
  import { kindOf } from "../../lib/project/language"
  import { highlight, renderMarkdown } from "../../lib/project/render"
  import type { Project } from "../../lib/agents/events"

  // Not an island of its own: it renders inside Run.svelte's island because it reads the
  // same `project`. Two islands would mean two copies of that state and a way to keep them
  // in sync — a shared store for something that never leaves one screen.
  let { project, written, busy }: {
    project: Project | null
    /** Files the agent has written so far, while it is still writing. */
    written: Map<string, string | null>
    busy: boolean
  } = $props()

  /**
   * What to draw: the certified project when there is one, otherwise what has arrived.
   *
   * The panel used to stay empty until the closing event, so a ten-minute generation was a
   * spinner and then everything at once. These are the same files — the agent sends each
   * group's content as it writes it — but they carry no verdict and no ZIP yet, which is why
   * the header below draws no status badge until `project` lands.
   */
  const files = $derived(
    project
      ? project.files
      : [...written].map(([path, text]) => ({
          path,
          text,
          bytes: text ? new TextEncoder().encode(text).length : 0,
          lines: text ? text.split("\n").length : 0,
          sha256: "",
          why_no_text: text === null ? "el agente no mandó el contenido de este archivo" : undefined,
        })),
  )
  const showing = $derived(files.length > 0)

  const tree = $derived(buildTree(files))

  let openDirs = $state(new Set<string>())
  let selectedPath = $state<string | null>(null)

  // Re-runs whenever a new project arrives: expand everything and open a sensible file.
  // Keyed on the id so re-rendering the same project does not fight the user's clicks.
  let lastProjectId = $state<string | null>(null)
  $effect(() => {
    if (!project || project.id === lastProjectId) return
    lastProjectId = project.id
    openDirs = new Set(directoryPaths(buildTree(project.files)))
    selectedPath = defaultSelection(project.files)
  })

  // While the files are still arriving, keep the tree open and keep a file selected — a
  // directory that collapses itself as its siblings appear is worse than no preview.
  $effect(() => {
    if (project || written.size === 0) return
    openDirs = new Set(directoryPaths(tree))
    if (!selectedPath || !written.has(selectedPath)) selectedPath = defaultSelection(files)
  })

  const selected = $derived(files.find((file) => file.path === selectedPath) ?? null)
  /**
   * A file that ends in a newline splits into a final empty string. Numbering it would put
   * a line 99 on a file the agent reports as 98 lines long — two numbers on screen
   * disagreeing about the same file.
   */
  const lines = $derived.by(() => {
    const parts = selected?.text ? selected.text.split("\n") : []
    if (parts.length > 1 && parts.at(-1) === "") parts.pop()
    return parts
  })

  const kind = $derived(selected ? kindOf(selected.path) : null)

  /** Markdown is shown rendered; this is the way back to the file as the agent wrote it. */
  let raw = $state(false)
  $effect(() => {
    void selectedPath // read so this re-runs on every change of file
    raw = false
  })

  /**
   * Highlighted or rendered HTML for the current file.
   *
   * Async, so it is kept beside the path it belongs to: the panel shows plain text until it
   * resolves and swaps only when the result matches what is selected now. Without that, a
   * large file resolving late would paint itself over the small one clicked after it.
   */
  let view = $state<{ path: string; html: string } | null>(null)
  $effect(() => {
    const file = selected
    const shape = kind
    const asRaw = raw
    // Cleared, not just skipped. Leaving the previous result in place meant "Original"
    // kept showing the README's *rendered* HTML with the tags stripped out: the same words,
    // minus every `#` and backtick, passed off as the file on disk.
    if (!file || file.text === null || !shape || shape.render === "plain") {
      view = null
      return
    }
    if (shape.render === "markdown" && asRaw) {
      view = null
      return
    }

    let stale = false
    const show = (html: string) => {
      if (!stale) view = { path: file.path, html }
    }
    const work =
      shape.render === "markdown" ? renderMarkdown(file.text) : highlight(file.text, shape.language)
    // A failed render is not worth an error message: the plain text below is still the file.
    work.then(show).catch(() => {})
    return () => {
      stale = true
    }
  })

  const html = $derived(view && selected && view.path === selected.path ? view.html : null)

  function toggle(path: string) {
    // Reassigned rather than mutated: Svelte tracks the binding, not the Set's internals.
    const next = new Set(openDirs)
    next.has(path) ? next.delete(path) : next.add(path)
    openDirs = next
  }

  const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`)
</script>

{#snippet nodes(list: TreeNode[], depth: number)}
  {#each list as node (node.path)}
    {#if node.kind === "dir"}
      <button
        class="row row--dir"
        style="padding-left: {0.5 + depth * 0.8}rem"
        onclick={() => toggle(node.path)}
        aria-expanded={openDirs.has(node.path)}
      >
        <svg class="chev" class:chev--open={openDirs.has(node.path)} viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
        <span class="name">{node.name}</span>
      </button>
      {#if openDirs.has(node.path)}{@render nodes(node.children, depth + 1)}{/if}
    {:else}
      <button
        class="row"
        class:row--active={node.path === selectedPath}
        style="padding-left: {1.45 + depth * 0.8}rem"
        onclick={() => (selectedPath = node.path)}
      >
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v5h5" /><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /></svg>
        <span class="name">{node.name}</span>
        <!-- The agent withholds text for files over the size cap and for anything that
             looks like a credential. Marking them in the tree means the reason is visible
             before the click, not as an apology after it. -->
        {#if node.file.text === null}<span class="locked" title={node.file.why_no_text ?? "Sin contenido"}>—</span>{/if}
      </button>
    {/if}
  {/each}
{/snippet}

<section class="files" aria-label="Estructura del proyecto">
  {#if showing}
    {#if project}
      {@const badge = badgeForProject(project.status)}
    <header class="head">
      <p class="kicker">Proyecto generado</p>

      <!-- The name is the biggest thing here and the download is beside it, not above it.
           A full-width accent button was the loudest object on the screen, which made the
           first question this panel answered "where do I click" instead of "what is this". -->
      <div class="title">
        <h2>{project.name}</h2>
        {#if project.download_url}
          <a class="btn btn--primary dl" href={project.download_url} download>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M5 21h14" /></svg>
            <span>Descargar ZIP</span>
          </a>
        {/if}
      </div>

      <!-- The badge travels with the sentence that explains it. On its own, "Pendiente de
           QA" is a label the reader has to guess at; UX-4 asks that it carry the weight of
           a failure, and a word with no explanation carries none. -->
      <p class="status">
        <span class="badge badge--{badge.tone}">{badge.label}</span>
        <span class="status__why">{badge.detail}</span>
      </p>

      {#if !project.download_url}
        <!-- Which reason, and it is not always the same one. The ZIP can be perfectly well
             formed and the project still not be deliverable — INCOMPLETE and FAILED take the
             button away on the verdict, not on the integrity check. Reading `integrity.reason`
             unconditionally printed "Sin descarga: ." for exactly those cases. -->
        <p class="nodl">
          Sin descarga: {project.integrity.ok
            ? project.reason || "el proyecto no superó la verificación"
            : project.integrity.reason || "no pasó el control de integridad"}.
        </p>
      {/if}

      <dl class="stats">
        <div><dt>Archivos</dt><dd>{project.totals.files}</dd></div>
        <div><dt>Carpetas</dt><dd>{project.totals.directories}</dd></div>
        <div><dt>Líneas</dt><dd>{project.totals.lines}</dd></div>
        {#if project.zip}<div><dt>ZIP</dt><dd>{kb(project.zip.bytes)}</dd></div>{/if}
      </dl>
    </header>
    {:else}
      <!-- Still arriving. The name, the verdict, the totals and the ZIP do not exist yet and
           are not invented: what there is to say is how many files have landed. -->
      <header class="head head--live">
        <p class="kicker">Escribiéndose</p>
        <p class="status">
          <span class="badge badge--pending">En curso</span>
          <span class="status__why">
            {written.size} {written.size === 1 ? "archivo escrito" : "archivos escritos"} ·
            el veredicto y la descarga llegan al terminar
          </span>
        </p>
      </header>
    {/if}

    <div class="split">
      <nav class="tree" aria-label="Archivos">{@render nodes(tree, 0)}</nav>

      <div class="viewer">
        {#if selected}
          <div class="viewer__head">
            <code>{selected.path}</code>
            <div class="viewer__right">
              {#if kind?.render === "markdown" && selected.text !== null}
                <div class="seg" role="group" aria-label="Cómo ver el archivo">
                  <button class:seg--on={!raw} onclick={() => (raw = false)}>Formateado</button>
                  <button class:seg--on={raw} onclick={() => (raw = true)}>Original</button>
                </div>
              {/if}
              <span class="meta">{selected.lines} líneas · {kb(selected.bytes)}</span>
            </div>
          </div>
          {#if selected.text === null}
            <p class="withheld">
              El agente no incluyó el contenido de este archivo.
              <span>{selected.why_no_text ?? "No dio un motivo."}</span>
              El archivo sí está en el ZIP.
            </p>
          {:else if kind?.render === "markdown" && !raw}
            <!-- `@html` is safe here and only here because `renderMarkdown` runs markdown-it
                 with `html: false`: raw HTML inside the README is escaped, not executed. -->
            <div class="prose">{#if html}{@html html}{:else}<pre class="plain">{selected.text}</pre>{/if}</div>
          {:else}
            <div class="code">
              <pre class="gutter" aria-hidden="true">{lines.map((_, i) => i + 1).join("\n")}</pre>
              <!-- Same guarantee: highlight.js escapes the source it wraps in spans. Until it
                   resolves, the unhighlighted text is already correct — never a blank pane. -->
              <pre class="src">{#if html}{@html html}{:else}{selected.text}{/if}</pre>
            </div>
          {/if}
        {:else}
          <p class="empty">Elegí un archivo para verlo.</p>
        {/if}
      </div>
    </div>
  {:else}
    <!-- The header stays even with nothing in it, so the panel is identifiable before it
         has anything to show rather than being an unexplained empty half of the window. -->
    <header class="head head--empty">
      <p class="kicker">Proyecto</p>
      <h2 class="waiting">{busy ? "Generándose…" : "Todavía no hay ninguno"}</h2>
    </header>
    <div class="blank">
      <svg viewBox="0 0 24 24" aria-hidden="true" class="blank__ico"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
      {#if busy}
        <p class="pulse">El agente está escribiendo los archivos</p>
        <p class="meta">Van a ir apareciendo acá según los escriba.</p>
      {:else}
        <p>Acá vas a ver cada archivo antes de descargar nada</p>
        <p class="meta">El árbol completo, con el contenido de cada uno.</p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .files {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--line);
    background: var(--bg);
  }

  /* A band, not more page. The panel used to be one flat sheet from the title down to the
     code, so the header read as the first paragraph of the content instead of as its frame. */
  .head {
    padding: 0.9rem 1.15rem 1rem;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
    display: flex; flex-direction: column; gap: 0.55rem;
  }
  .head--empty { gap: 0.15rem; }
  .head--live { gap: 0.35rem; }

  /* Four steps down in size from here to the stats, so the eye is told what to read first
     instead of being handed four things of equal weight. */
  .kicker { margin: 0; font-size: 0.68rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-dim); }
  .title { display: flex; align-items: center; gap: 0.75rem; }
  .title h2 { margin: 0; font-size: 1.22rem; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .waiting { margin: 0; font-size: 1.05rem; font-weight: 600; color: var(--text-dim); }

  .status { margin: 0; display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
  .status__why { font-size: 0.82rem; color: var(--text-dim); line-height: 1.45; flex: 1 1 14rem; }

  .dl { flex: none; display: inline-flex; align-items: center; gap: 0.45rem; text-decoration: none; padding: 0.45rem 0.85rem; font-size: 0.88rem; }
  .dl svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
  .nodl { margin: 0; font-size: 0.82rem; color: var(--pending); }

  .stats { display: flex; gap: 1.6rem; margin: 0.15rem 0 0; }
  .stats div { display: flex; flex-direction: column-reverse; }
  .stats dt { font-size: 0.68rem; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-dim); }
  .stats dd { margin: 0; font-size: 1rem; font-weight: 600; font-variant-numeric: tabular-nums; }

  .meta { margin: 0; font-size: 0.8rem; color: var(--text-dim); }

  /* The tree keeps its width; the viewer takes the rest and is the only part that can be
     squeezed, because code is what benefits from the room. */
  .split { flex: 1; min-height: 0; display: flex; }
  .tree { flex: 0 0 210px; overflow: auto; padding: 0.6rem 0.35rem; border-right: 1px solid var(--line); }

  .row {
    display: flex; align-items: center; gap: 0.4rem;
    width: 100%; padding: 0.3rem 0.5rem;
    border: 0; border-radius: 7px;
    background: none; color: var(--text-dim);
    font-size: 0.85rem; text-align: left;
  }
  .row:hover { background: var(--surface-2); color: var(--text); }
  .row--active { background: var(--surface-2); color: var(--text); box-shadow: inset 2px 0 0 var(--accent); }
  .row--dir { color: var(--text); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .locked { margin-left: auto; color: var(--pending); font-weight: 700; }

  .ico, .chev { width: 15px; height: 15px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .chev { width: 12px; transition: transform 120ms ease; }
  .chev--open { transform: rotate(90deg); }
  @media (prefers-reduced-motion: reduce) { .chev { transition: none; } }

  .viewer { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .viewer__head { display: flex; align-items: baseline; gap: 0.75rem; justify-content: space-between; padding: 0.55rem 0.9rem; border-bottom: 1px solid var(--line); }
  .viewer__head code { font-family: var(--mono); font-size: 0.82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .code { flex: 1; min-height: 0; overflow: auto; display: flex; font-family: var(--mono); font-size: 0.8rem; line-height: 1.55; }
  .code pre { margin: 0; padding: 0.7rem 0; }
  .gutter { padding-inline: 0.75rem; text-align: right; color: var(--text-dim); opacity: 0.5; user-select: none; background: var(--surface); position: sticky; left: 0; }
  .src { padding-inline: 0.9rem; white-space: pre; }

  .withheld { margin: 0; padding: 1rem 1.1rem; color: var(--pending); font-size: 0.86rem; line-height: 1.5; }
  .withheld span { display: block; color: var(--text-dim); font-family: var(--mono); font-size: 0.8rem; margin: 0.3rem 0; }

  .empty, .blank { color: var(--text-dim); }
  .empty { padding: 1.1rem; margin: 0; }
  .blank { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.3rem; text-align: center; padding: 2rem 1.5rem; }
  .blank p { margin: 0; }
  .blank__ico { width: 34px; height: 34px; fill: none; stroke: currentColor; stroke-width: 1.2; opacity: 0.35; margin-bottom: 0.5rem; }

  .viewer__right { display: flex; align-items: center; gap: 0.7rem; flex: none; }

  .seg { display: flex; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; }
  .seg button { border: 0; background: none; color: var(--text-dim); font-size: 0.74rem; padding: 0.16rem 0.6rem; }
  .seg button:hover { color: var(--text); }
  .seg--on { background: var(--surface-2); color: var(--text) !important; }

  .prose { flex: 1; min-height: 0; overflow: auto; padding: 1rem 1.4rem 2.5rem; max-width: 62rem; }
  .plain { margin: 0; font-family: var(--mono); font-size: 0.8rem; line-height: 1.55; white-space: pre-wrap; }

  /* `:global` because this markup comes from markdown-it and highlight.js through `@html`,
     so it never carries Svelte's scoping attribute. Everything below is nested inside
     .prose / .code, which is what keeps it from leaking into the rest of the app. */
  .prose :global(h1) { font-size: 1.4rem; margin: 1.4rem 0 0.6rem; }
  .prose :global(h2) { font-size: 1.15rem; margin: 1.5rem 0 0.5rem; padding-bottom: 0.3rem; border-bottom: 1px solid var(--line); }
  .prose :global(h3) { font-size: 1rem; margin: 1.2rem 0 0.4rem; }
  .prose :global(h1:first-child), .prose :global(h2:first-child) { margin-top: 0; }
  .prose :global(p), .prose :global(ul), .prose :global(ol) { margin: 0.6rem 0; line-height: 1.65; }
  .prose :global(li) { margin: 0.2rem 0; }
  .prose :global(a) { color: var(--accent); }
  .prose :global(strong) { color: var(--text); }
  .prose :global(blockquote) { margin: 0.8rem 0; padding: 0.1rem 0 0.1rem 0.9rem; border-left: 2px solid var(--line); color: var(--text-dim); }
  .prose :global(hr) { border: 0; border-top: 1px solid var(--line); margin: 1.4rem 0; }
  .prose :global(table) { border-collapse: collapse; margin: 0.8rem 0; font-size: 0.88rem; }
  .prose :global(th), .prose :global(td) { border: 1px solid var(--line); padding: 0.35rem 0.6rem; text-align: left; }
  .prose :global(th) { background: var(--surface); }
  .prose :global(img) { max-width: 100%; }

  /* Inline code and fenced blocks. The block keeps its own background so a ```bash``` in a
     README reads as a block of terminal, which is how the README means it. */
  .prose :global(code) { font-family: var(--mono); font-size: 0.85em; background: var(--surface-2); padding: 0.1rem 0.35rem; border-radius: 5px; }
  .prose :global(pre) { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 0.8rem 1rem; overflow-x: auto; margin: 0.8rem 0; }
  .prose :global(pre code) { background: none; padding: 0; font-size: 0.8rem; line-height: 1.55; }

  /* One set of syntax colours for both places code appears: the file viewer and the fenced
     blocks inside a README. Strings take the brand green because strings are most of what a
     generated file is made of, and it keeps the panel looking like the rest of the product
     instead of like a pasted-in editor theme. */
  .prose :global(.hljs-comment), .code :global(.hljs-comment),
  .prose :global(.hljs-quote), .code :global(.hljs-quote) { color: #6b7280; font-style: italic; }
  .prose :global(.hljs-keyword), .code :global(.hljs-keyword),
  .prose :global(.hljs-literal), .code :global(.hljs-literal),
  .prose :global(.hljs-selector-tag), .code :global(.hljs-selector-tag) { color: #c792ea; }
  .prose :global(.hljs-string), .code :global(.hljs-string),
  .prose :global(.hljs-meta .hljs-string), .code :global(.hljs-meta .hljs-string) { color: var(--accent); }
  .prose :global(.hljs-number), .code :global(.hljs-number) { color: var(--pending); }
  .prose :global(.hljs-title), .code :global(.hljs-title),
  .prose :global(.hljs-title.function_), .code :global(.hljs-title.function_) { color: #82aaff; }
  .prose :global(.hljs-title.class_), .code :global(.hljs-title.class_),
  .prose :global(.hljs-type), .code :global(.hljs-type),
  .prose :global(.hljs-built_in), .code :global(.hljs-built_in) { color: #ffcb6b; }
  .prose :global(.hljs-attr), .code :global(.hljs-attr),
  .prose :global(.hljs-attribute), .code :global(.hljs-attribute),
  .prose :global(.hljs-variable), .code :global(.hljs-variable),
  .prose :global(.hljs-template-variable), .code :global(.hljs-template-variable) { color: #f78c6c; }
  .prose :global(.hljs-meta), .code :global(.hljs-meta),
  .prose :global(.hljs-section), .code :global(.hljs-section),
  .prose :global(.hljs-symbol), .code :global(.hljs-symbol),
  .prose :global(.hljs-bullet), .code :global(.hljs-bullet) { color: #89ddff; }
  .prose :global(.hljs-deletion), .code :global(.hljs-deletion) { color: var(--bad); }
  .prose :global(.hljs-emphasis) { font-style: italic; }
  .prose :global(.hljs-strong) { font-weight: 700; }

  @media (max-width: 1100px) {
    .files { border-left: 0; border-top: 1px solid var(--line); min-height: 60vh; }
    .split { flex-direction: column; }
    .tree { flex: 0 0 auto; max-height: 30vh; border-right: 0; border-bottom: 1px solid var(--line); }
  }
</style>
