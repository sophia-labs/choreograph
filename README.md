# Sophia Compute (choreograph)

Sophia Compute is the workflow runtime of [Sophia](https://github.com/sophia-labs/gardend): it runs workflows whose
steps are programs and agents, against a Sophia graph. Its code, package and service ids are `choreograph`, the
engine's working name; the product is Sophia Compute.

On your own machine it runs as an **opt-in service of `gardend`** (the Sophia engine): `gardend` release
archives (from 0.1.4) carry it, built, under `services/choreograph/`. gardend starts it, gives it a loopback port, a per-start
secret and a member-scope token for the graph, and proxies it at `/services/choreograph`.

```sh
gardend service enable choreograph       # start it with gardend from now on (it also starts on a workflow's first run)
gardend chat key set                     # your own OpenRouter key; Sophia Compute and chat both use it
```

It needs **Node.js 22.19 or newer** on gardend's PATH, the same as Sophia's chat.

## License

MIT ([LICENSE](LICENSE)). Third-party components keep their own licenses ([NOTICE](NOTICE)); the agent body's
[pi](https://github.com/earendil-works/pi) is MIT too. Sophia Compute is maintained by Sophia Labs.

## What runs

- **The orchestrator** (`src/orchestrator.ts`): the HTTP API, the workflow engine (programs, agent steps, phases,
  a durable journal and runtime store), the model proxy (agents never hold a key), budgets and the sandbox pool.
- **The agent body** (`packages/agent-body`): one upstream [pi](https://github.com/earendil-works/pi) session
  (`@earendil-works/pi-coding-agent`, pinned exactly) per agent step, behind Choreograph's host bridge. Every model
  call and every tool call is the host's: the body holds no key and reaches no network. Its tools are the graph's,
  through gardend's MCP, at the workspace chat's authority (the Writer's, or the Reader's for a step that only reads).
- **Graph access**: gardend's `/mcp`, with the token gardend minted for the service. Every graph on a gardend belongs
  to its profile's owner.

Under gardend the orchestrator runs in **local-native** mode: agent bodies are plain child processes of the
orchestrator, with a scrubbed environment but no filesystem or network jail. That is fine for agents whose only
tools are the graph's. Linux hosts can run bodies under bubblewrap (the default `CHOREOGRAPH_SANDBOX_MODE`) with a
runtime bundle manifest instead.

## A workflow

A workflow is a small script: `meta` (name, phases, the execution binding, an input schema), then steps. A local
Sophia Compute fills in each agent step's runtime and identity, so a step names only what it asks:

```js
export const meta = {
	name: "what-needs-doing",
	description: "Read the garden and say what needs doing.",
	phases: [{ title: "read" }],
	execution: {
		schema: "choreograph.execution-binding.v1",
		controller: "composite", modelUse: "agentic", isolation: "sandbox", effects: "capability-bound",
		reproducibility: "nondeterministic", capabilities: ["choreograph.agent", "garden.graph"],
		authority: { minimumRole: "editor", dangerousOps: false }, mayInvokeChildren: false,
	},
	inputs: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
}
phase("read")
const result = await agent(args.question, { label: "reader", model: "openai/gpt-6-luna", toolMode: "dynamic", graphAccess: "read" })
return { answer: result.output }
```

Run it through gardend: `POST /services/choreograph/api/workflows/run` with `{ "workflow_name", "workflow_source",
"workflow_args", "graph_id" }` (the owner's key), or gardend's MCP tools `workflow_run_start` / `workflow_run_monitor`
for a workflow kept in the graph. `GET /services/choreograph/api/workflows/runs/<runId>` follows it.

## Develop

```sh
corepack enable
pnpm install
pnpm build
pnpm check      # Biome + TypeScript
pnpm test       # node:test suites (the Linux-only sandbox suites skip elsewhere)
node deploy/build-gardend-service.mjs <dir> --natives host    # the service folder gardend runs
```

`pnpm dev:local-native` runs the orchestrator from source on this machine; set `SOPHIA_AGENT_RUNTIME_ENTRYPOINT` to
`packages/agent-body/src/main.ts`, `CHOREOGRAPH_LOCAL_AGENT_DEFAULTS=1`, `WORKFLOW_DYNAMIC_SOURCE=1` and, for a
graph, `MNEMOSYNE_MCP_URL` + `MNEMOSYNE_MCP_ACCESS_TOKEN`. `.env.example` lists the variables the code reads.
Without a key, the host's scripted models (`mock:done`, `mock:text`, `mock:mnemosyne_search`) run a workflow end
to end with no provider.

Billing, Stripe and the Discord edge (Phanes) are in the source for hosted deployments and stay dormant unless their
environment is set; a local Sophia Compute charges nothing (`BILLING_FEE_BPS=0`).
