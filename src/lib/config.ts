/**
 * Everything this server needs from its environment, read in one place.
 *
 * The token never reaches the client: it is read here, on the server, and attached to the
 * outgoing request. Nothing under `src/components` may import this file.
 */
export const config = {
  /** The CodeZard gateway. Reachable over the internal Docker network, not from the browser. */
  gatewayUrl: process.env.GATEWAY_URL ?? "http://gateway:8000",
  /** The service name the gateway routes under: /api/{service}/... */
  backendService: process.env.BACKEND_SERVICE ?? "backend",
  /** Shared secret with the backend agent. Empty means the agent is running open. */
  agentToken: process.env.MIRAG_TOKEN ?? "",
  /**
   * Which language to ask the agent in.
   *
   * It defaults to `en` on its side, so leaving this out means a Spanish screen talking to an
   * English agent: the answers come back in the wrong language and the prepared demos stop
   * matching, which reads as the agent refusing to answer rather than as a locale mismatch.
   */
  locale: process.env.MIRAG_LOCALE ?? "es",
}
