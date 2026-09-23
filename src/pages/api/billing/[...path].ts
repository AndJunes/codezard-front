import type { APIRoute } from "astro"
import { config } from "../../../lib/config"

export const prerender = false

/**
 * A pipe to the gateway's billing API, for the same one reason the run pipe exists: the
 * gateway's address is internal and may not reach a browser.
 *
 * It decides nothing about money. It does not know what a plan costs, whether a session is
 * valid or whether an invoice was paid — every one of those is a question only the gateway
 * can answer, and answering any of them here would mean a second place that could be wrong.
 *
 * WHAT IT DOES CARRY, AND WHY EACH ONE
 *
 * `Authorization` travels through. The session token is minted by the gateway, proves an
 * account, and is useless to this server — which is exactly why it is forwarded rather than
 * stored, swapped or re-signed here. Nothing about the caller is inferred from a cookie: the
 * browser holds the token and sends it, and a pipe that added an identity of its own would be
 * a second source of truth about who is calling.
 *
 * `X-Payment` and `X-Payment-Response` travel through because x402 is an end-to-end protocol
 * between the paying client and the gateway. A proxy that dropped either would break it while
 * looking like it worked: the payment would arrive stripped, and the settlement would never
 * reach the client that paid.
 */
const FORWARDED_REQUEST = ["authorization", "x-payment"]
const FORWARDED_RESPONSE = ["x-payment-response", "www-authenticate"]

const proxy: APIRoute = async ({ params, request }) => {
  const path = params.path ?? ""
  const upstream = `${config.gatewayUrl}/billing${path ? `/${path}` : ""}`

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  for (const name of FORWARDED_REQUEST) {
    const value = request.headers.get(name)
    if (value) headers[name] = value
  }

  let response: Response
  try {
    response = await fetch(upstream, {
      method: request.method,
      headers,
      body: request.method === "GET" ? undefined : await request.text(),
      signal: request.signal,
    })
  } catch (error) {
    // The gateway being unreachable is the one failure it cannot report on its own.
    return new Response(
      JSON.stringify({ error: { code: "gateway_unreachable", message: String(error) } }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    )
  }

  const out: Record<string, string> = {
    "Content-Type": response.headers.get("content-type") ?? "application/json",
    // A balance and an invoice status are the two things that must never be served from a
    // cache: one is money, the other is "has it arrived yet".
    "Cache-Control": "no-store",
  }
  for (const name of FORWARDED_RESPONSE) {
    const value = response.headers.get(name)
    if (value) out[name] = value
  }
  return new Response(response.body, { status: response.status, headers: out })
}

export const GET = proxy
export const POST = proxy
