import node from "@astrojs/node"
import svelte from "@astrojs/svelte"
import { defineConfig } from "astro/config"
import { loadEnv } from "vite"

// `config.ts` reads `process.env.GATEWAY_URL` directly, on purpose: in every deployment that
// matters (Docker, a host's dashboard) the platform sets real process env vars, and that is
// what has to win. Vite's dev server never puts `.env` there by itself — it only ever exposes
// it through `import.meta.env` — so `astro dev` saw `undefined` and fell through to the
// Docker-only default, "gateway:8000", which nothing outside a container can resolve. This
// fills `process.env` from `.env` for whatever a real env var has not already set, so dev
// matches every environment that already worked.
for (const [key, value] of Object.entries(loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), ""))) {
  process.env[key] ??= value
}

export default defineConfig({
  // 'server' and not 'static': the agent's token has to live somewhere the browser cannot
  // read, and that somewhere is this server. It is the only reason this app needs one.
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [svelte()],
})
