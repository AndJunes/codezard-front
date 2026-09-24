<script lang="ts">
  import * as api from "../../lib/billing/client"
  import { BillingError, BillingOffError } from "../../lib/billing/client"
  import * as fmt from "../../lib/billing/format"
  import { load, shorten } from "../../lib/billing/session"
  import type { Account, Catalogue, Invoice, Product, Session } from "../../lib/billing/types"
  import * as wallet from "../../lib/billing/wallet"

  /**
   * The billing screen: what you have, what you have spent, and how to get more.
   *
   * THREE THINGS IT REFUSES TO DO
   *
   * It never computes a balance. `account.balance` is the sum of a ledger the gateway keeps,
   * and a number added up here would be a second opinion about somebody's money — right
   * until the day it is not.
   *
   * It never asks for a secret key. Signing happens inside whichever wallet the person
   * picked; this page sees a public address and a signature.
   *
   * It never decides that an invoice is paid. It asks, repeatedly, and shows the answer.
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

  let busy = $state("")
  let error = $state("")
  let offline = $state("")
  let notice = $state("")
  let copied = $state("")

  let poller: ReturnType<typeof setInterval> | undefined
  const POLL_MS = 5_000

  $effect(() => {
    session = load()
    void refreshCatalogue()
    if (session) void refreshAccount().catch(report)
    return () => clearInterval(poller)
  })

  function report(raised: unknown): void {
    if (raised instanceof BillingOffError) {
      // Not a failure and not the person's doing: this deployment sells nothing. It gets its
      // own panel rather than the red box, which would say they broke something.
      offline = raised.message
      return
    }
    error = raised instanceof Error ? raised.message : String(raised)
  }

  /**
   * The screen shows one failure at a time, and it is always the latest thing the person
   * did. Stacking them leaves a stale message under a fresh one.
   */
  async function attempt(what: string, action: () => Promise<void>): Promise<void> {
    busy = what
    error = ""
    try {
      await action()
    } catch (raised) {
      report(raised)
    } finally {
      busy = ""
    }
  }

  async function refreshCatalogue(): Promise<void> {
    try {
      catalogue = await api.catalogue()
      offline = ""
    } catch (raised) {
      report(raised)
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
      if (!catalogue) {
        throw new BillingError("Todavía no pude leer la lista de planes. Probá de nuevo.")
      }
      // The gateway's network, never a guess: a signature made for the wrong Stellar
      // verifies nowhere, and the failure reads as a broken wallet.
      const network = catalogue.network
      const address = await wallet.connect(network)
      const issued = await api.challenge(address)
      const signature = await wallet.sign(network, address, issued.message)
      session = await api.verify(issued.challenge, signature)
      notice = `Entraste como ${shorten(session.address)}. Ya tenés el plan Free activo.`
      await refreshAccount()
    })
  }

  function signOut(): void {
    api.signOut()
    void wallet.disconnect()
    session = null
    account = null
    invoice = null
    notice = ""
    clearInterval(poller)
  }

  // ── buying ─────────────────────────────────────────────────────────────────

  /**
   * Buy, or do the thing that has to happen first.
   *
   * A disabled button with no explanation is the complaint this answers: without a session
   * these used to be greyed out and clicking them did nothing, with nothing on screen saying
   * that signing in was the missing step. Now the first click opens the wallet, and the
   * second one buys.
   */
  function buy(product: Product): Promise<void> {
    if (!session) return connect()
    if (product.kind === "plan") return subscribe(product)
    return attempt(product.id, async () => {
      invoice = await api.checkout(product.id)
      notice = ""
      watch(invoice.id)
    })
  }

  /**
   * Subscribing is a contract call, not an invoice.
   *
   * The gateway builds the transaction, the wallet signs it, the gateway submits it — and
   * the payment and the subscription happen in that one transaction, so they cannot come
   * apart. There is no memo to get right and no poller to wait for: by the time this returns
   * the chain has it and the account has been settled against it.
   */
  function subscribe(product: Product): Promise<void> {
    return attempt(product.id, async () => {
      const current = session
      if (!current || !catalogue) throw new BillingError("Entrá con tu billetera primero.")
      const quote = await api.subscription(product.id)
      notice = "Confirmá la suscripción en tu billetera…"
      const signed = await wallet.signTransaction(quote.network, current.address, quote.xdr)
      notice = "Enviando a la red…"
      const done = await api.submitSubscription(signed)
      notice = `Suscripción activa. Transacción ${done.transaction.slice(0, 10)}…`
      await refreshAccount()
    })
  }

  function labelFor(product: Product): string {
    const plan = product.kind === "plan"
    if (busy === product.id) return plan ? "Firmá en tu billetera…" : "Generando factura…"
    if (!session) return "Entrar para comprar"
    if (plan) return contract ? "Suscribirme" : "No disponible todavía"
    return selling ? "Comprar" : "No disponible todavía"
  }

  /** A plan needs the contract; a pack needs somewhere to send the money. Different things. */
  function offered(product: Product): boolean {
    return product.kind === "plan" ? Boolean(contract) : selling
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

  const asset = $derived(catalogue?.asset ?? "XLM")
  const destination = $derived(catalogue?.destination ?? "")
  const contract = $derived(catalogue?.contract ?? "")
  /** Nothing can be bought until there is somewhere to send the money. */
  const selling = $derived(Boolean(destination))
  const balance = $derived(account?.balance ?? null)
  const usage = $derived(account?.usage ?? null)
  const plan = $derived(account?.plan ?? null)
  const free = $derived(catalogue?.plans.find((p) => p.free) ?? null)
  const paid = $derived(catalogue?.plans.filter((p) => !p.free) ?? [])
  const expiresIn = $derived(invoice ? fmt.remaining(invoice.expires_at) : "")

  /**
   * How much of THIS period's grant is gone, as a percentage.
   *
   * Against the grant and not against the total: purchased tokens do not belong to a week,
   * so counting them would make a bar that never fills and says nothing.
   */
  const spent = $derived(
    usage && plan?.tokens ? Math.min(100, Math.round((usage.tokens / plan.tokens) * 100)) : 0,
  )
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
    {:else if !offline}
      <button class="btn btn--primary" onclick={connect} disabled={busy === "connect"}>
        {busy === "connect" ? "Conectando…" : "Entrar con mi billetera"}
      </button>
    {/if}
  </header>

  {#if offline}
    <!-- Not an error: this gateway simply is not selling anything. Saying so calmly, with
         what to change, beats a red box repeating a status code. -->
    <div class="card off">
      <h2>El cobro está apagado en este gateway</h2>
      <p>{offline}</p>
    </div>
  {:else}
    {#if error}
      <p class="msg msg--bad" role="alert">{error}</p>
    {/if}
    {#if notice}
      <p class="msg msg--good">{notice}</p>
    {/if}

    {#if session && balance && usage}
      <div class="cards">
        <article class="card stat">
          <h2>Saldo</h2>
          <p class="big">{fmt.tokens(balance.total)}</p>
          <p class="exact">{fmt.exact(balance.total)} tokens</p>
          {#if balance.granted > 0 && balance.purchased > 0}
            <p class="split">
              {fmt.tokens(balance.granted)} del plan · {fmt.tokens(balance.purchased)} comprados
            </p>
          {/if}
        </article>

        <article class="card stat">
          <h2>Consumo {plan?.free ? "de esta semana" : "de este período"}</h2>
          <p class="big">{fmt.tokens(usage.tokens)}</p>
          <p class="exact">
            {usage.runs}
            {usage.runs === 1 ? "run" : "runs"}
            {#if usage.since}· desde el {fmt.when(usage.since)}{/if}
          </p>
          {#if plan?.tokens}
            <!-- Against the grant, not the total: purchased tokens do not belong to a week. -->
            <div
              class="bar"
              role="progressbar"
              aria-valuenow={spent}
              aria-valuemin="0"
              aria-valuemax="100"
              aria-label="Parte del plan consumida"
            >
              <span style="width: {spent}%" class:bar__full={spent >= 100}></span>
            </div>
            <p class="split">{spent}% de {fmt.tokens(plan.tokens)} incluidos</p>
          {/if}
          {#if account && account.lifetime.runs !== usage.runs}
            <p class="split">
              En total: {account.lifetime.runs} runs, {fmt.tokens(account.lifetime.tokens)}
            </p>
          {/if}
        </article>

        <article class="card stat">
          <h2>Plan</h2>
          {#if account?.subscription?.status === "active"}
            <p class="big">{plan?.name ?? account.subscription.plan}</p>
            <p class="exact">
              {plan?.free ? "Se renueva solo el" : "Renueva el"}
              {fmt.when(account.subscription.renews_at)}
            </p>
            {#if plan?.free}
              <p class="split">
                Los tokens del plan no se acumulan: cada semana arranca de nuevo. Los que
                compres aparte sí quedan.
              </p>
            {/if}
          {:else if account?.subscription}
            <p class="big">Vencido</p>
            <p class="exact">
              El período terminó el {fmt.when(account.subscription.renews_at)}. Los tokens del
              plan no se acumulan; los comprados sí.
            </p>
          {:else}
            <p class="big dim">Sin plan</p>
          {/if}
        </article>
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

    {#if catalogue}
      <article class="card deposit">
        <div class="deposit__text">
          <h2>Dónde depositar</h2>
          {#if selling}
            <p class="sub">
              Esta es la dirección que recibe los pagos, en {asset} sobre {catalogue.network ===
              "stellar-testnet"
                ? "Stellar testnet"
                : "Stellar"}. Cada compra genera una factura con su <b>memo</b>: sin el memo el
              pago llega pero no hay forma de saber de quién es.
            </p>
          {:else}
            <p class="sub">
              Este gateway todavía no tiene dirección de cobro, así que no se puede comprar
              nada. El plan Free funciona igual. Se configura con
              <code>GATEWAY_BILLING__DESTINATION</code> en <code>CodeZard/.env</code>.
            </p>
          {/if}
        </div>
        {#if selling}
          <div class="deposit__address">
            <code class="wrap">{destination}</code>
            <button class="copy" onclick={() => copy(destination, "deposit")}>
              {copied === "deposit" ? "copiado" : "copiar"}
            </button>
          </div>
        {/if}
      </article>
    {/if}

    {#if free}
      <article class="card freecard">
        <div>
          <h2>{free.name} · {fmt.tokens(free.tokens)} tokens por semana</h2>
          <p class="sub">{free.description}</p>
        </div>
        {#if session}
          <span class="badge badge--good">Activo</span>
        {:else}
          <span class="badge badge--neutral">Entrá y ya lo tenés</span>
        {/if}
      </article>
    {/if}

    <h2 class="section">Planes</h2>
    {#if contract}
      <p class="sub">
        Las suscripciones son un contrato en Stellar: el pago y el período quedan registrados
        en la misma transacción, así que no pueden quedar desfasados. Podés verificarlo vos
        mismo sin preguntarnos nada.
        <a class="link" href="https://stellar.expert/explorer/testnet/contract/{contract}"
           target="_blank" rel="noopener noreferrer">Ver el contrato</a>
      </p>
    {/if}
    <div class="grid">
      {#each paid as product (product.id)}
        <article class="card product">
          <h3>{product.name}</h3>
          <p class="price">
            {fmt.usd(product.price)}<span class="per"
              >/{product.period_days === 7 ? "semana" : "mes"}</span
            >
          </p>
          <p class="tokens">{fmt.tokens(product.tokens)} tokens por período</p>
          <p class="desc">{product.description}</p>
          <button
            class="btn btn--primary"
            onclick={() => buy(product)}
            disabled={busy === product.id || (!!session && !offered(product))}
          >
            {labelFor(product)}
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
            disabled={busy === product.id || (!!session && !offered(product))}
          >
            {labelFor(product)}
          </button>
        </article>
      {/each}
    </div>

    {#if !session && catalogue}
      <p class="sub">
        Entrá con tu billetera Stellar para activar el plan Free y para comprar. La misma
        dirección que paga es la cuenta: no hay contraseña que recordar ni que nos puedan robar.
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
      Los pagos se liquidan en la red Stellar ({asset}{catalogue?.network === "stellar-testnet"
        ? ", testnet"
        : ""}). Las cotizaciones se congelan al crear la factura, así que el importe que ves es
      el que se paga.
    </p>
  {/if}
</section>

<style>
  /* No `overflow` here: the page's `main` is the scroll container, so the scrollbar lands
     at the window edge instead of down the side of this centred box. */
  .billing {
    max-width: 1000px;
    margin: 0 auto;
    padding: 1.6rem 1.25rem 4rem;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
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

  /* Neutral, not red: nothing failed and nobody did anything wrong. */
  .off h2 {
    margin: 0 0 0.4rem;
    font-size: 1.05rem;
  }
  .off p {
    margin: 0;
    color: var(--text-dim);
    max-width: 70ch;
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

  .bar {
    margin-top: 0.6rem;
    height: 6px;
    border-radius: 999px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 999px;
  }
  /* Spent, not broken: the loudest colour this product has for "look at this". */
  .bar span.bar__full {
    background: var(--pending);
  }

  .deposit {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .deposit h2 {
    margin: 0 0 0.2rem;
    font-size: 1.05rem;
  }
  .deposit__text {
    flex: 1 1 22rem;
  }
  .deposit__address {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    min-width: 0;
  }

  .link {
    color: var(--accent);
  }

  .freecard {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    border-color: color-mix(in oklab, var(--accent) 35%, var(--line));
    background: color-mix(in oklab, var(--accent) 6%, var(--surface));
  }
  .freecard h2 {
    margin: 0;
    font-size: 1.05rem;
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
