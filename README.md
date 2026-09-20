# codezard-front

The screen for CodeZard: you describe an idea, a PM agent turns it into a plan, you approve
it, and only then a backend agent generates the project.

```bash
npm install
cp .env.example .env     # and fill it in
npm run dev
```

## How it is wired

```
browser ──► Astro (SSR, public)
              ├─► scripted PM        (in this server, for now)
              └─► gateway :8000      (internal network)
                    └─► agent :8000  (internal network)
```

Astro is the only piece facing the internet. The agent's token is read on this server and
attached to the outgoing request; it never reaches the browser. That is the whole reason this
app needs a server at all, and why `output` is `server` rather than `static`.

## The two things worth knowing before changing anything

**The PM does not exist yet.** `agente_pm` is a folder of markdown, with no code and no
endpoint. `src/lib/agents/pm.ts` declares the interface and ships a scripted double behind it,
so the screen is whole today and the swap is one line in `resolve()`.

**Approval is enforced on the server.** `src/pages/api/backend/generate.ts` answers `409` to
any plan that is not `approved`. "The button was not rendered" is not a rule: anyone can POST.

## Layout

| Path | What lives there |
|---|---|
| `src/lib/plan/schema.ts` | **The plan.** The contract between the PM and the backend |
| `src/lib/flow/machine.ts` | The states of the flow, and which moves are legal |
| `src/lib/agents/pm.ts` | The PM interface, and the scripted double |
| `src/lib/agents/backend.ts` | The real agent, through the gateway |
| `src/lib/agents/events.ts` | The agent's SSE contract, as types |
| `src/lib/ui/status.ts` | How each status is shown — one table, on purpose |
| `src/components/islands/Run.svelte` | The only hydrated component |

## `not_executed` is not a pass

The backend agent delivers code and its tests **without running them**; running them will be a
QA agent's job. So `not_executed` and `GENERATED` are what production returns every time, and
`src/lib/ui/status.ts` renders them as *pendiente de QA*, with the same visual weight as a
failure — never as approved. UX-4 of the PRD asks for exactly that, and it is the reason the
mapping lives in one table instead of inside the components.

## Known limitations

- The sidebar history lives in session memory. Persisting it contradicts `TC-5` and `DR-4` of
  the PRD, so it is a product decision rather than a choice of library.
- The `locale` sent to the agent is fixed per deployment (`MIRAG_LOCALE`, default `es`). The
  agent defaults to `en` on its side, and a mismatch makes it stop recognising prepared demos.
- The PM double asks one fixed round of questions, plus a second if storage is left undecided.
  A real PM would judge; this one only proves the loop exists.
