/**
 * Everything this server needs from its environment, read in one place.
 *
 * It is one line long now, and that is the result worth pointing at.
 *
 * It used to hold both agents' tokens, both service names and the locale, because this server
 * called the agents directly and decided what to ask them. The gateway does that now: it
 * holds the tokens, it names the services, it picks the locale. What is left here is the
 * address of the thing that knows — which still may not reach a browser, since it is an
 * internal name on the Docker network.
 */
export const config = {
  /** The CodeZard gateway. Reachable over the internal Docker network, not from the browser. */
  gatewayUrl: process.env.GATEWAY_URL ?? "http://gateway:8000",
}
