# codezard-front

The screen for CodeZard: you describe an idea, a PM agent turns it into a plan, you approve
it, and only then a backend agent generates the project. Once it exists you can browse its
files, run commands in it from a console, and download it as a ZIP.

This repo is only the screen. It needs two others running behind it, so the quickest way in is
[Run the whole stack](#run-the-whole-stack).

```bash
npm install
cp .env.example .env     # PowerShell: Copy-Item .env.example .env
npm run dev              # http://localhost:4321
```

Requires Node **22.12 or newer** (Astro 7).

## Run the whole stack

CodeZard is three sibling folders. Each one is started on its own, **in this order**, because
each needs the one before it:

| # | Folder | What it is | Command | Port |
|---|---|---|---|---|
| 1 | `agente-backend` | The PM and the backend agent, in one process | `python -m mirag_manager serve` | 8100 |
| 2 | `CodeZard` | The gateway: owns the run, holds the tokens | `gateway` | 8000 |
| 3 | `codezard-front` | This screen | `npm run dev` | 4321 |

### First time only

**1. `agente-backend`**

```bash
cd agente-backend
python -m venv .venv
# PowerShell: .venv\Scripts\Activate.ps1      bash/zsh: source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env     # PowerShell: Copy-Item .env.example .env
```

Then edit `agente-backend/.env`:

```ini
MIRAG_PORT=8100                 # the example says 8000, which is the gateway's port
MIRAG_TOKEN=<a secret>          # python -c "import secrets; print(secrets.token_urlsafe(32))"
MIRAG_OFFLINE=0                 # 0 = real model calls (costs money); see the note below
OPENROUTER_API_KEY=sk-or-...
MIRAG_CONSOLE=1                 # optional: lets the screen run commands in a generated project
```

`MIRAG_OFFLINE=1` (the agent's default) is a rehearsal lock: the PM replays one fixed plan, a
meeting-room booking API, labelled as simulated, and the backend only answers its prepared
demos. It shows the screen working without a key and without spending, but it is not a way to
generate your own idea.

**2. `CodeZard`**

```bash
cd CodeZard
python -m venv .venv
# PowerShell: .venv\Scripts\Activate.ps1      bash/zsh: source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
```

Then edit `CodeZard/.env`: set `MIRAG_TOKEN` to **the same value** as in `agente-backend/.env`
(both orchestration tokens read it from there), and, if you turned the console on above,
`GATEWAY_ORCHESTRATION__CONSOLE=true`. The console needs both switches; either one alone leaves
it off.

**3. `codezard-front`**

```bash
cd codezard-front
npm install
cp .env.example .env     # GATEWAY_URL=http://127.0.0.1:8000
```

### Every time

Three terminals, in this order. With each virtualenv activated (or by calling
`.venv\Scripts\python.exe` directly):

```bash
# 1 — agente-backend
python -m mirag_manager serve
#   backend: chat
#   pm: analyze, plan, revise

# 2 — CodeZard
gateway
#   Gateway ready. Registered services: backend (… :8100/backend), pm (… :8100/pm)

# 3 — codezard-front
npm run dev
#   http://localhost:4321
```

Open **`http://localhost:4321`**. On Windows the dev server listens on the IPv6 loopback, so
`http://127.0.0.1:4321` can be refused while `localhost` works.

### Check that it is wired

```bash
curl http://127.0.0.1:8000/health/services
# {"status":"ok","services":[{"name":"backend","status":"up",…},{"name":"pm","status":"up",…}]}
```

Both `up` means the gateway reaches the manager. If the screen still fails to send, look here:

| What you see | Usually |
|---|---|
| `gateway_unreachable` (502) from `/api/run/...` | The gateway is down, or `GATEWAY_URL` is wrong. With no `.env` the fallback is `http://gateway:8000`, a Docker name a terminal cannot resolve |
| Send answers `404` | The gateway has no `/runs` routes: `GATEWAY_ORCHESTRATION__ENABLED` is not `true` in `CodeZard/.env` |
| `/health/services` shows `pm` down, or `/pm/...` answers `404` | `mirag serve` is running instead of `python -m mirag_manager serve`. Only the manager routes `/pm` and `/backend` |
| A `401` from the agent | The tokens differ between `agente-backend/.env` and `CodeZard/.env` |
| Every idea gets the same meeting-room booking plan, marked simulated | `MIRAG_OFFLINE=1`: the PM is replaying its scripted double. Set `MIRAG_OFFLINE=0`, add the key, restart the manager |
| The PM answers `502` | Its model call failed. Check the manager's terminal, then the key, its credit and `MIRAG_MODEL` |
| The console says it is off | Needs `MIRAG_CONSOLE=1` on the agent **and** `GATEWAY_ORCHESTRATION__CONSOLE=true` on the gateway; restart both |
| Port 8100 answers oddly after a restart | Two managers can end up on the same port on Windows: `netstat -ano \| findstr :8100` should show one listener |

### With Docker instead

From `CodeZard`, which builds the agents from the sibling `agente-backend` folder:

```bash
cd CodeZard
cp .env.local.example .env.local      # set OPENROUTER_API_KEY and MIRAG_TOKEN
docker compose -f docker-compose.local.yml --env-file .env.local up -d --build
```

That publishes the gateway on **`127.0.0.1:8090`** and nothing else. The screen stays on your
machine and points there:

```bash
# bash/zsh
GATEWAY_URL=http://127.0.0.1:8090 npm run dev
# PowerShell
$env:GATEWAY_URL = "http://127.0.0.1:8090"; npm run dev
```

Neither console switch is set in that compose, so the console is off there.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on `http://localhost:4321`. Reads `.env` |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serves the build: `node ./dist/server/entry.mjs`. **Does not read `.env`** — see below |
| `npm test` | `vitest run`. There are no test files yet, so it exits with code 1 ("No test files found") |
| `npm run check` | `astro check`. Needs `@astrojs/check`, which is not in `devDependencies` yet |

**`preview` and the environment.** The built server only reads real environment variables, so
`GATEWAY_URL` from `.env` is ignored and the fallback `http://gateway:8000` is used. Export it,
or let Node load the file:

```bash
node --env-file=.env ./dist/server/entry.mjs
# or: GATEWAY_URL=http://127.0.0.1:8000 npm run preview
# PowerShell: $env:GATEWAY_URL = "http://127.0.0.1:8000"; npm run preview
```

`HOST` and `PORT` choose where the built server listens.

## Configuration

One variable, on purpose:

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_URL` | `http://gateway:8000` | Where the CodeZard gateway lives, as seen from this server |

The agents' tokens, the service names and the language are configured in the gateway
(`GATEWAY_ORCHESTRATION__*`, in `CodeZard/.env`), not here. `astro.config.mjs` copies `.env`
into `process.env` for whatever a real variable has not already set, so a variable you export
always wins over the file.

## How it is wired

```
browser ──► Astro (SSR, public)
              └─► gateway :8000     /runs/*        (internal network)
                    └─► agent manager :8100
                          ├─ /pm       analyze · plan · revise
                          └─ /backend  chat
```

Astro is the only piece facing the internet. `src/pages/api/run/[...path].ts` forwards
`/api/run/*` to the gateway's `/runs/*` and decides nothing: the gateway's address is internal
and its agent tokens are secrets, and neither may reach a browser. That is the whole reason this
app needs a server at all, and why `output` is `server` rather than `static`.

The gateway's routes are `POST /runs`, `GET /runs/{id}`, `POST /runs/{id}/answers`,
`/rejection`, `/approval`, `/generation` (SSE), `GET /runs/{id}/events` (SSE),
`POST /runs/{id}/console` (SSE) and `GET /runs/{id}/download` (the ZIP). Their contract lives in
`CodeZard`.

## The two things worth knowing before changing anything

**This app holds no agent logic and no tokens.** The PM is `mirag_pm`, inside `agente-backend`,
reached through the gateway. There is no scripted double here any more, and no state machine:
`src/lib/flow/run.ts` is five calls that each return the whole run, and one that streams.

**Approval is enforced on the gateway.** `POST /runs/{id}/approval` takes no body, so approving
is an act and not a claim the browser writes into a field. Generating a run that is not approved
is refused with `409`. "The button was not rendered" is not a rule: anyone can POST.

## Layout

| Path | What lives there |
|---|---|
| `src/pages/api/run/[...path].ts` | The only server route: a pipe to the gateway. Streams SSE, the ZIP and console output untouched |
| `src/lib/flow/run.ts` | The run as the screen sees it: calls to the gateway, nothing decided here |
| `src/lib/plan/schema.ts` | **The plan.** The contract between the PM and the backend |
| `src/lib/agents/events.ts` | The backend agent's SSE contract, as types, and the readers for it |
| `src/lib/chat/messages.ts` | The transcript: everything said so far, in order |
| `src/lib/project/history.ts` | The projects this browser has opened, and a read-only copy of each |
| `src/lib/project/{tree,language,render}.ts` | The file list as a tree, what a file is, and highlighting/Markdown loaded on first click |
| `src/lib/project/commands.ts` | The install / start / test commands the console suggests, worked out from the project's own files |
| `src/lib/ui/status.ts` | How each status is shown — one table, on purpose |
| `src/components/islands/Run.svelte` | The only hydrated island. Everything else under `islands/` renders inside it |
| `src/components/islands/{Files,Console}.svelte` | The generated project's file browser, and its terminal |
| `src/components/islands/{Questionnaire,PlanCard,Steps}.svelte` | The PM's questions, one version of the plan, what the agent did |

## `not_executed` is not a pass

The backend agent's default is to deliver code and its tests **without running them**
(`MIRAG_EXECUTION=off`); running them is a QA agent's job. So `not_executed` and `GENERATED`
are what it returns in that mode, and `src/lib/ui/status.ts` renders them as *pendiente de QA*,
with the same visual weight as a failure — never as approved. UX-4 of the PRD asks for exactly
that, and it is the reason the mapping lives in one table instead of inside the components.

With `MIRAG_EXECUTION=true` the agent does run them, and `passed`, `failed` and `no_evidence`
appear too. `no_evidence` (it finished but printed no test marker) is not a pass either.

## Known limitations

- The gateway keeps a run in memory for **one hour**, by design (`TC-5` and `DR-4` of the PRD).
  So the browser keeps its own list of projects and a read-only snapshot of each in
  `localStorage` (`cz:runs`, `cz:snap:<id>`). After a gateway restart, or an hour, an old
  project still opens, but read-only: there is no live run for the console or the ZIP to use.
- The language sent to the agents is fixed per deployment, by the gateway
  (`GATEWAY_ORCHESTRATION__LOCALE`, default `es`). The agents default to `en` on their side,
  and a mismatch makes them stop recognising prepared demos.
- There are no tests yet (`npm test` exits with 1), and `npm run check` needs a package that
  is not installed.
