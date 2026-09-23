<script lang="ts">
  import * as api from "../../lib/billing/client"
  import { BillingError } from "../../lib/billing/client"
  import * as fmt from "../../lib/billing/format"
  import { load, shorten } from "../../lib/billing/session"
  import type { Account, Catalogue, Invoice, Product, Session } from "../../lib/billing/types"
  import { detect, type Wallet } from "../../lib/billing/wallet"

  /**
   * The billing screen: what you have, what it costs, and how to pay for more.
   *
   * THREE THINGS IT REFUSES TO DO
   *
   * It never computes a balance. `account.balance` is the sum of a ledger the gateway keeps,
   * and a number added up here would be a second opinion about somebody's money — right
   * until the day it is not.
   *
   * It never asks for a secret key. Signing happens inside the wallet extension; this page
   * sees a public address and a signature. A field that takes a seed is a field that ends up
   * in a screenshot.
   *
   * It never decides that an invoice is paid. It asks, repeatedly, and shows the answer. The
   * only thing that can settle an invoice is a payment on the ledger.
   *
   * WHY IT POLLS
   *
   * An invoice is paid by a wallet this app never hears from — a different tab, a phone, a
   * hardware device. There is no event to wait for, so the screen asks while a person is
   * looking at it, and the gateway reconciles the rest on its own for the ones who walk away.
   */

  let session = $state<Session | null>(null)
  let catalogue = $state<Catalogue | null>(null)
  let account = $state<Account | null>(null)
  let invoice = $state<Invoice | null>(null)
  let wallet = $state<Wallet | null>(null)

  let busy = $state("")
  let error = $state("")
  let notice = $state("")
  let copied = $state("")

  let poller: ReturnType<typeof setInterval> | undefined
  const POLL_MS = 5_000

  $effect(() => {
    session = load()
    void refreshCatalogue()
    void detect().then((found) => (wallet = found))
    if (session) void refreshAccount()
    return () => clearInterval(poller)
  })

  /**
   * The screen only ever shows one failure at a time, and it is always the latest thing the
   * person did. Stacking them would leave a stale message under a fresh one.
   */
  async function attempt(what: string, action: () => Promise<void>): Promise<void> {
    busy = what
    error = ""
    try {
      await action()
    } catch (raised) {
      error =
        raised instanceof BillingError || raised instanceof Error
          ? raised.message
          : String(raised)
    } finally {
      busy = ""
    }
  }

  async function refreshCatalogue(): Promise<void> {
    try {
      catalogue = await api.catalogue()
    } catch (raised) {
      // The price list is public, so a failure here means the gateway is down or is not
      // selling anything — worth saying plainly rather than rendering an empty page.
      error = raised instanceof Error ? raised.message : String(raised)
    }
  }

  async function refreshAccount(): Promise<void> {
    if (!load()) {
      session = null
      account = null
      return
    }
    account = await api.account()
  }

  // ── signing in ─────────────────────────────────────────────────────────────

  function connect(): Promise<void> {
    return attempt("connect", async () => {
      const found = wallet ?? (await detect())
      wallet = found
      if (!found) {
        throw new BillingError(
          "No se detectó ninguna billetera Stellar en este navegador. Instalá Freighter " +
            "para entrar con tu cuenta.",
        )
      }
      const address = await found.address()
      const issued = await api.challenge(address)
      const signature = await found.sign(issued.message, address)
      session = await api.verify(issued.challenge, signature)
      notice = `Entraste como ${shorten(session.address)}`
      await refreshAccount()
    })
  }

  function signOut(): void {
    // One call, through the client: it is the only thing that talks to the session store,
    // and two places clearing it is two places to forget one of the other bits of state.
    api.signOut()
    session = null
    account = null
    invoice = null
    notice = ""
    clearInterval(poller)
  }

  // ── buying ─────────────────────────────────────────────────────────────────

  function buy(product: Product): Promise<void> {
    return attempt(product.id, async () => {
      invoice = await api.checkout(product.id)
      notice = ""
      watch(invoice.id)
    })
  }

  /**
   * Ask about this invoice until it is settled or its window closes.
   *
   * The interval is cleared before a new one starts: two checkouts in a row would otherwise
   * leave the first timer running and polling an invoice nobody is looking at.
   */
  function watch(id: string): void {
    clearInterval(poller)
    poller = setInterval(async () => {
      try {
        const latest = await api.invoice(id)
        invoice = latest
        if (latest.status !== "pending") {
          clearInterval(poller)
          if (latest.status === "paid") {
            notice = `Pago acreditado: ${fmt.exact(latest.tokens)} tokens.`
            await refreshAccount()
          }
        }
      } catch {
        // A single failed poll says nothing: the network blinked, or the gateway is
        // restarting. The timer keeps going; a real problem shows up as the invoice
        // expiring, which is a state the screen already draws.
      }
    }, POLL_MS)
  }

  function dismiss(): void {
    clearInterval(poller)
    invoice = null
  }

  async function copy(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      copied = what
      setTimeout(() => (copied = copied === what ? "" : copied), 1_800)
    } catch {
      // Clipboard access can be denied, and the value is on screen to be selected by hand.
      copied = ""
    }
  }

  const products = $derived([...(catalogue?.plans ?? []), ...(catalogue?.packs ?? [])])
  const asset = $derived(catalogue?.asset ?? "XLM")
  const balance = $derived(account?.balance ?? null)
  const expiresIn = $derived(invoice ? fmt.remaining(invoice.expires_at) : "")
</script>

<section class="billing">
  <header class="head">
    <div>
      <h1>Créditos y suscripción</h1>
      <p class="sub">
        CodeZard se cobra en tokens: es lo mismo que se consume al generar, así que el precio
        no depende de cuántos proyectos hagas sino de cuánto trabajo pidas.
      </p>
    </div>

    {#if session}
      <div class="who">
        <span class="badge badge--good" title={session.address}>{shorten(session.address)}</span>
        <button class="btn" onclick={signOut}>Salir</button>
      </div>
    {:else}
      <button class="btn btn--primary" onclick={connect} disabled={busy === "connect"}>
        {busy === "connect" ? "Conectando…" : "Entrar con mi billetera"}
      </button>
    {/if}
  </header>

  {#if error}
    <p class="msg msg--bad" role="alert">{error}</p>
  {/if}
  {#if notice}
    <p class="msg msg--good">{notice}</p>
  {/if}

  {#if session && balance}
    <div class="cards">
      <article class="card stat">
        <h2>Saldo</h2>
        <p class="big">{fmt.tokens(balance.total)}</p>
        <p class="exact">{fmt.exact(balance.total)} tokens</p>
        {#if balance.granted > 0}
          <p class="split">
            {fmt.tokens(balance.granted)} del plan · {fmt.tokens(balance.purchased)} comprados
          </p>
        {/if}
      </article>

      <article class="card stat">
        <h2>Plan</h2>
        {#if account?.subscription && account.subscription.status === "active"}
          <p class="big">{account.plan?.name ?? account.subscription.plan}</p>
          <p class="exact">Renueva el {fmt.when(account.subscription.renews_at)}</p>
        {:else if account?.subscription}
          <p class="big">Vencido</p>
          <p class="exact">
            El período terminó el {fmt.when(account.subscription.renews_at)}. Los tokens del
            plan no se acumulan; los comprados sí.
          </p>
        {:else}
          <p class="big dim">Sin plan</p>
          <p class="exact">Podés usar packs de tokens sin suscribirte.</p>
        {/if}
      </article>

      {#if catalogue}
        <article class="card stat">
          <h2>Para arrancar un run</h2>
          <p class="big">{fmt.tokens(catalogue.reserve)}</p>
          <p class="exact">
            Es un piso, no un depósito: no se descuenta. Sirve para decirte que no alcanza
            antes de empezar, y no a mitad de una generación.
          </p>
        </article>
      {/if}
    </div>
  {/if}

  {#if invoice}
    <article class="card invoice">
      <header>
        <h2>Pagá esta factura</h2>
        <span
          class="badge badge--{invoice.status === 'paid'
            ? 'good'
            : invoice.status === 'pending'
              ? 'pending'
              : 'bad'}"
        >
          {invoice.status === "paid"
            ? "Acreditada"
            : invoice.status === "pending"
              ? "Esperando el pago"
              : "Vencida"}
        </span>
      </header>

      {#if invoice.status === "pending"}
        <p class="sub">
          Enviá el importe exacto <b>con el memo</b>. Sin el memo no hay forma de saber que el
          pago es tuyo, y queda sin acreditar.
          {#if expiresIn}La cotización vale {expiresIn} más.{/if}
        </p>

        <dl class="fields">
          <div>
            <dt>Importe</dt>
            <dd>
              <code>{fmt.asset(invoice.amount, invoice.asset)}</code>
              <button class="copy" onclick={() => copy(invoice!.amount, "amount")}>
                {copied === "amount" ? "copiado" : "copiar"}
              </button>
            </dd>
          </div>
          <div>
            <dt>Dirección</dt>
            <dd>
              <code class="wrap">{invoice.destination}</code>
              <button class="copy" onclick={() => copy(invoice!.destination, "dest")}>
                {copied === "dest" ? "copiado" : "copiar"}
              </button>
            </dd>
          </div>
          <div>
            <dt>Memo (texto)</dt>
            <dd>
              <code>{invoice.memo}</code>
              <button class="copy" onclick={() => copy(invoice!.memo, "memo")}>
                {copied === "memo" ? "copiado" : "copiar"}
              </button>
            </dd>
          </div>
        </dl>
        <p class="poll pulse">Revisando la red cada {POLL_MS / 1000} s…</p>
      {:else if invoice.status === "paid"}
        <p class="sub">
          Acreditados {fmt.exact(invoice.tokens)} tokens.
          {#if invoice.tx_hash}<code class="wrap">{invoice.tx_hash}</code>{/if}
        </p>
      {:else}
        <p class="sub">
          Esta cotización venció sin pago. Generá otra: el precio se vuelve a calcular con la
          cotización del momento.
        </p>
      {/if}

      <button class="btn" onclick={dismiss}>Cerrar</button>
    </article>
  {/if}

  <h2 class="section">Planes</h2>
  <div class="grid">
    {#each catalogue?.plans ?? [] as product (product.id)}
      <article class="card product">
        <h3>{product.name}</h3>
        <p class="price">{fmt.usd(product.price)}<span class="per">/mes</span></p>
        <p class="tokens">{fmt.tokens(product.tokens)} tokens por período</p>
        <p class="desc">{product.description}</p>
        <button
          class="btn btn--primary"
          onclick={() => buy(product)}
          disabled={!session || busy === product.id}
        >
          {busy === product.id ? "Generando factura…" : "Suscribirme"}
        </button>
      </article>
    {/each}
  </div>

  <h2 class="section">Packs de tokens</h2>
  <p class="sub">Se compran una vez y no vencen. Sirven solos o encima de un plan.</p>
  <div class="grid">
    {#each catalogue?.packs ?? [] as product (product.id)}
      <article class="card product">
        <h3>{product.name}</h3>
        <p class="price">{fmt.usd(product.price)}</p>
        <p class="tokens">{fmt.tokens(product.tokens)} tokens</p>
        <p class="desc">{product.description}</p>
        <button
          class="btn"
          onclick={() => buy(product)}
          disabled={!session || busy === product.id}
        >
          {busy === product.id ? "Generando factura…" : "Comprar"}
        </button>
      </article>
    {/each}
  </div>

  {#if !session && products.length}
    <p class="sub">
      Entrá con tu billetera Stellar para comprar. La misma dirección que paga es la cuenta:
      no hay contraseña que recordar ni que nos puedan robar.
    </p>
  {/if}

  {#if account?.entries.length}
    <h2 class="section">Movimientos</h2>
    <table class="ledger">
      <thead>
        <tr><th>Cuándo</th><th>Qué</th><th class="num">Tokens</th><th>Detalle</th></tr>
      </thead>
      <tbody>
        {#each [...account.entries].reverse() as entry (entry.id)}
          <tr>
            <td class="dim">{fmt.when(entry.at)}</td>
            <td><span class="badge badge--{fmt.tone(entry)}">{fmt.label(entry.kind)}</span></td>
            <td class="num">{fmt.delta(entry.tokens)}</td>
            <td class="dim">{entry.memo}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="sub">
      El saldo es la suma de estas filas y nada más. Si algún número no cierra, la cuenta está
      acá entera.
    </p>
  {/if}

  <p class="sub foot">
    Los pagos se liquidan en la red Stellar ({asset}). Las cotizaciones se congelan al crear
    la factura, así que el importe que ves es el que se paga.
  </p>
</section>

<style>
  .billing {
    max-width: 1000px;
    margin: 0 auto;
    padding: 1.6rem 1.25rem 4rem;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    overflow-y: auto;
    width: 100%;
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  h1 {
    margin: 0;
    font-size: 1.5rem;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .sub {
    margin: 0.15rem 0 0;
    color: var(--text-dim);
    max-width: 66ch;
  }
  .foot {
    margin-top: 1.5rem;
    font-size: 0.86rem;
  }

  .msg {
    margin: 0;
    padding: 0.6rem 0.9rem;
    border-radius: var(--radius);
    border: 1px solid var(--line);
  }
  .msg--bad {
    color: var(--bad);
    background: color-mix(in oklab, var(--bad) 12%, transparent);
    border-color: color-mix(in oklab, var(--bad) 35%, transparent);
  }
  .msg--good {
    color: var(--good);
    background: color-mix(in oklab, var(--good) 12%, transparent);
    border-color: color-mix(in oklab, var(--good) 35%, transparent);
  }

  .cards,
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 0.75rem;
  }

  .stat h2,
  .product h3 {
    margin: 0;
    font-size: 0.74rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
  }
  .product h3 {
    font-size: 1rem;
    text-transform: none;
    letter-spacing: 0;
    color: var(--text);
  }

  .big {
    margin: 0.3rem 0 0;
    font-size: 1.9rem;
    font-weight: 700;
    line-height: 1.1;
  }
  .big.dim {
    color: var(--text-dim);
  }
  .exact,
  .split {
    margin: 0.25rem 0 0;
    font-size: 0.84rem;
    color: var(--text-dim);
  }

  .section {
    margin: 1.4rem 0 0;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
  }

  .product {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .price {
    margin: 0;
    font-size: 1.45rem;
    font-weight: 700;
  }
  .per {
    font-size: 0.82rem;
    font-weight: 400;
    color: var(--text-dim);
  }
  .tokens {
    margin: 0;
    color: var(--accent);
    font-weight: 600;
  }
  .desc {
    margin: 0 0 0.6rem;
    color: var(--text-dim);
    font-size: 0.88rem;
    flex: 1;
  }

  .invoice header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .invoice h2 {
    margin: 0;
    font-size: 1rem;
  }
  .fields {
    margin: 0.9rem 0;
    display: grid;
    gap: 0.6rem;
  }
  .fields dt {
    font-size: 0.74rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
  }
  .fields dd {
    margin: 0.15rem 0 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  code {
    font-family: var(--mono);
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0.2rem 0.5rem;
    font-size: 0.9rem;
  }
  /* An address is 56 characters and must not push the card wider than the screen. */
  code.wrap {
    word-break: break-all;
  }
  .copy {
    border: 1px solid var(--line);
    background: transparent;
    color: var(--text-dim);
    border-radius: 999px;
    padding: 0.1rem 0.55rem;
    font-size: 0.76rem;
  }
  .copy:hover {
    border-color: var(--accent);
    color: var(--text);
  }
  .poll {
    margin: 0 0 0.9rem;
    font-size: 0.84rem;
    color: var(--pending);
  }

  .ledger {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }
  .ledger th {
    text-align: left;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    font-weight: 600;
    padding: 0.35rem 0.6rem;
  }
  .ledger td {
    padding: 0.45rem 0.6rem;
    border-top: 1px solid var(--line);
    vertical-align: top;
  }
  .ledger .num {
    text-align: right;
    font-family: var(--mono);
    white-space: nowrap;
  }
  .ledger .dim {
    color: var(--text-dim);
  }

  @media (max-width: 640px) {
    /* The detail column is the first thing to go: it is the one that repeats what the badge
       beside it already says. */
    .ledger th:last-child,
    .ledger td:last-child {
      display: none;
    }
  }
</style>
