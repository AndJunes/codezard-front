import type { APIRoute } from "astro"
import { generate, promptFor } from "../../../lib/agents/backend"
import type { Plan } from "../../../lib/plan/schema"

export const prerender = false

/**
 * The gate, and the pipe.
 *
 * The gate: a plan that is not approved never reaches the agent. This is checked here and not
 * only in the screen, because "the button was not rendered" is not a rule — anyone can POST.
 *
 * The pipe: the agent's body is handed straight back. Reading it here to inspect or reshape
 * it would re-introduce the buffering that was just removed from the gateway.
 */
export const POST: APIRoute = async ({ request }) => {
  let plan: Plan
  try {
    ({ plan } = await request.json())
  } catch {
    return json({ error: "malformed_body" }, 400)
  }

  if (!plan || typeof plan !== "object") return json({ error: "plan_required" }, 400)
  if (plan.status !== "approved") {
    return json(
      { error: "plan_not_approved", detail: "El Backend no empieza sin un plan aprobado." },
      409,
    )
  }

  const upstream = await generate(promptFor(plan), request.signal)
  if (!upstream.ok || !upstream.body) {
    return json({ error: "agent_unavailable", status: upstream.status }, 502)
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform matters as much as no-cache: without it an intermediary is free to
      // compress the stream, and compressing means buffering it first.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
