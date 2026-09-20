import { config } from "../config"

/**
 * The backend agent, reached through the gateway.
 *
 * This forwards the response body untouched. It does not read it, buffer it or inspect it:
 * the agent reports its progress over minutes, and anything that waits for the last byte
 * turns that into a blank screen followed by everything at once — which is precisely the bug
 * that was just fixed one layer down, in the gateway.
 */
export async function generate(question: string, signal: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (config.agentToken) headers["X-Mirag-Token"] = config.agentToken

  return fetch(`${config.gatewayUrl}/api/${config.backendService}/api/v1/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ question, locale: config.locale }),
    // Carried through so that closing the tab stops the work upstream. Without it the model
    // keeps being paid for by someone who already left.
    signal,
  })
}

/**
 * Turns an approved plan into the single prompt the agent takes.
 *
 * Empty sections are omitted rather than emitted blank. A trailing "Entidades:" with nothing
 * after it is noise to a model, and it changes the text enough that the agent stopped
 * recognising a question it otherwise answers — which is how this was noticed.
 */
export function promptFor(plan: {
  purpose: string
  entities: { name: string; fields: string[] }[]
  flows: { name: string; steps: string[] }[]
  constraints: { statement: string }[]
}): string {
  const sections: string[] = []
  if (plan.entities.length) {
    sections.push("Entidades: " + plan.entities.map((e) => `${e.name} (${e.fields.join(", ")})`).join("; "))
  }
  if (plan.flows.length) {
    sections.push("Flujos: " + plan.flows.map((f) => `${f.name}: ${f.steps.join(" → ")}`).join("; "))
  }
  if (plan.constraints.length) {
    sections.push("Restricciones: " + plan.constraints.map((c) => c.statement).join("; "))
  }
  return sections.length ? [plan.purpose, "", ...sections].join("\n") : plan.purpose
}
