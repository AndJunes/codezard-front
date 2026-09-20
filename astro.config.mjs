import node from "@astrojs/node"
import svelte from "@astrojs/svelte"
import { defineConfig } from "astro/config"

export default defineConfig({
  // 'server' and not 'static': the agent's token has to live somewhere the browser cannot
  // read, and that somewhere is this server. It is the only reason this app needs one.
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [svelte()],
})
