<script lang="ts">
  import { buildTree, directoryPaths, defaultSelection, type TreeNode } from "../../lib/project/tree"
  import { badgeForProject } from "../../lib/ui/status"
  import type { Project } from "../../lib/agents/events"

  // Not an island of its own: it renders inside Run.svelte's island because it reads the
  // same `project`. Two islands would mean two copies of that state and a way to keep them
  // in sync — a shared store for something that never leaves one screen.
  let { project, busy }: { project: Project | null; busy: boolean } = $props()

  const tree = $derived(project ? buildTree(project.files) : [])

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

  const selected = $derived(project?.files.find((file) => file.path === selectedPath) ?? null)
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
  {#if project}
    {@const badge = badgeForProject(project.status)}
    <header class="head">
      <div class="title">
        <strong>{project.name}</strong>
        <span class="badge badge--{badge.tone}">{badge.label}</span>
      </div>
      <p class="meta">
        {project.totals.files} archivos · {project.totals.directories} carpetas · {project.totals.lines} líneas
      </p>
      {#if project.download_url}
        <a class="btn btn--primary dl" href={project.download_url} download>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M5 21h14" /></svg>
          <span>Descargar ZIP{#if project.zip}&nbsp;· {kb(project.zip.bytes)}{/if}</span>
        </a>
      {:else}
        <p class="nodl">Sin descarga: {project.integrity.reason || "no pasó el control de integridad"}.</p>
      {/if}
    </header>

    <div class="split">
      <nav class="tree" aria-label="Archivos">{@render nodes(tree, 0)}</nav>

      <div class="viewer">
        {#if selected}
          <div class="viewer__head">
            <code>{selected.path}</code>
            <span class="meta">{selected.lines} líneas · {kb(selected.bytes)}</span>
          </div>
          {#if selected.text === null}
            <p class="withheld">
              El agente no incluyó el contenido de este archivo.
              <span>{selected.why_no_text ?? "No dio un motivo."}</span>
              El archivo sí está en el ZIP.
            </p>
          {:else}
            <div class="code">
              <pre class="gutter" aria-hidden="true">{lines.map((_, i) => i + 1).join("\n")}</pre>
              <pre class="src">{selected.text}</pre>
            </div>
          {/if}
        {:else}
          <p class="empty">Elegí un archivo para verlo.</p>
        {/if}
      </div>
    </div>
  {:else}
    <div class="blank">
      <svg viewBox="0 0 24 24" aria-hidden="true" class="blank__ico"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
      {#if busy}
        <p class="pulse">Generando…</p>
        <p class="meta">La estructura aparece cuando el agente termina de escribirla.</p>
      {:else}
        <p>Acá va a aparecer el proyecto</p>
        <p class="meta">Cada archivo que genere el agente, con su contenido, antes de descargar nada.</p>
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

  .head { padding: 1rem 1.1rem; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 0.45rem; }
  .title { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
  .title strong { font-size: 1rem; }
  .meta { margin: 0; font-size: 0.8rem; color: var(--text-dim); }
  .dl { display: inline-flex; align-items: center; gap: 0.45rem; align-self: flex-start; text-decoration: none; }
  .dl svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .nodl { margin: 0; font-size: 0.82rem; color: var(--pending); }

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

  @media (max-width: 1100px) {
    .files { border-left: 0; border-top: 1px solid var(--line); min-height: 60vh; }
    .split { flex-direction: column; }
    .tree { flex: 0 0 auto; max-height: 30vh; border-right: 0; border-bottom: 1px solid var(--line); }
  }
</style>
