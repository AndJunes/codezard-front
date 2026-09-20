import type { APIRoute } from "astro"
import { resolve } from "../../../lib/agents/pm"

export const prerender = false

export const POST: APIRoute = async ({ request }) => {
  let idea: unknown
  try {
    ({ idea } = await request.json())
  } catch {
    return json({ error: "malformed_body" }, 400)
  }
  if (typeof idea !== "string" || !idea.trim()) {
    return json({ error: "idea_required" }, 400)
  }
  // FR-1.1 of the PRD caps the intent at 4.000 characters.
  if (idea.length > 4000) return json({ error: "idea_too_long", max: 4000 }, 400)

  return json(await resolve().analyze(idea))
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
