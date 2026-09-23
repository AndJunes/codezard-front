import type { APIRoute } from "astro"
import { config } from "../../../lib/config"

export const prerender = false

/**
 * A pipe to the gateway's run API. It decides nothing, and that is the whole point.
 *
 * What used to be here: three routes that read the body, checked `plan.status === "approved"`,
 * built the agent's prompt out of the plan, and dropped `round` and `maxRounds` on the way
 * past. Every one of those was a decision taken in a place that could not enforce it — the
 * approval check read a field the caller had just written.
 *
 * The gateway owns the run now, so this file exists for exactly one reason: the gateway's
 * URL is internal and its agent tokens are secrets, and neither may reach a browser. It
 * forwards bytes and copies the status back.
 *
 * The response body is handed straight back rather than read. Generation streams progress for
 * minutes, and anything that waits for the last byte turns that into a blank screen followed
 * by everything at once. The console and the ZIP go through the same pipe for the same reason.
 */
const proxy: APIRoute = async ({ params, request }) => {
  const path = params.path ?? ""
  const upstream = `${config.gatewayUrl}/runs${path ? `/${path}` : ""}`

  let response: Response
  try {
    response = await fetch(upstream, {
      method: request.method,
      headers: { "Content-Type": "application/json" },
      // GET has no body, and passing one throws rather than being ignored.
      body: request.method === "GET" ? undefined : await request.text(),
      // Carried through so that closing the tab stops the work upstream. Without it the model
      // keeps being paid for by someone who already left.
      signal: request.signal,
    })
  } catch (error) {
    // The gateway itself being unreachable is the one failure it cannot report on its own.
    return new Response(
      JSON.stringify({ error: { code: "gateway_unreachable", message: String(error) } }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    )
  }

  const type = response.headers.get("content-type") ?? "application/json"
  const headers: Record<string, string> = {
    "Content-Type": type,
    // no-transform matters as much as no-cache: without it an intermediary is free to
    // compress the stream, and compressing means buffering it first.
    "Cache-Control": "no-cache, no-transform",
  }
  // The ZIP's own name and checksum. Everything else stays behind: this pipe forwards what a
  // screen needs and nothing the gateway or the agent happened to add.
  for (const name of ["content-disposition", "content-length", "x-mirag-sha256"]) {
    const value = response.headers.get(name)
    if (value) headers[name] = value
  }
  return new Response(response.body, { status: response.status, headers })
}

export const GET = proxy
export const POST = proxy
