import type { APIRoute } from "astro"
import { resolve } from "../../../lib/agents/pm"
import type { Plan } from "../../../lib/plan/schema"

export const prerender = false

/** Produces the first plan, or another questionnaire if answers opened new questions. */
export const POST: APIRoute = async ({ request }) => {
  try {
    const { idea, answers } = await request.json()
    if (typeof idea !== "string" || !Array.isArray(answers)) {
      return json({ error: "idea_and_answers_required" }, 400)
    }
    return json(await resolve().plan(idea, answers))
  } catch {
    return json({ error: "malformed_body" }, 400)
  }
}

/** A rejection. Returns the next version; the previous one is never mutated. */
export const PUT: APIRoute = async ({ request }) => {
  try {
    const { plan, feedback } = (await request.json()) as { plan: Plan; feedback: string }
    if (!plan || typeof feedback !== "string" || !feedback.trim()) {
      return json({ error: "plan_and_feedback_required" }, 400)
    }
    if (plan.status === "approved") {
      // CA-08: once approved the plan is frozen for this run.
      return json({ error: "plan_already_approved" }, 409)
    }
    return json(await resolve().revise(plan, feedback))
  } catch {
    return json({ error: "malformed_body" }, 400)
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
