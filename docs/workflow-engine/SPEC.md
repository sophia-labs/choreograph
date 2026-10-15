# Choreograph Workflow Engine — Slice 1 Spec

*Working name: **Loom** (the engine that weaves many agent-threads into one fabric of work). Status: spec, 2026-06-14. Author: Vera + Sophia.*

> **North star.** A harness-independent, graph-native workflow engine that runs **inside Choreograph** — so we own the orchestration loop end to end, fan out cheap-model inference at will, and emit knowledge-graph events the way a hosted harness never could. This is foundational, not a feature: it is how Sophia stops borrowing Anthropic's `Workflow` runtime and starts running its own.

---

## 0. The reframe (why this is foundational)

**Chat and workflows are the same engine.** A chat turn already *is* `agent()`: Choreograph spawns a bwrap-isolated Pi worker with a system prompt + tool surface + model, runs it to `done`, and streams events back. A workflow is just *many* of those nodes composed by deterministic code. Slice 1 reveals that identity by factoring the chat spawn path into a reusable **`runAgentNode(spec)`** primitive and building one deterministic topology on top of it. The chat endpoint becomes the primitive's first caller; the workflow endpoint its second.

The commons' law — **"agents judge, code serializes"** (`workflow-commons/lessons-agents-judge-code-serializes`) — maps directly onto the architecture:

| Commons principle | Loom realization |
|---|---|
| Code serializes | the deterministic driver + the vocab-driven provenance serializer (no LLM mints URIs/triples) |
| Agents judge | the Pi workers (map findings, synthesis prose) — judgment validated as untrusted input via schema |
| Idempotency by construction | `INSERT DATA` on fresh `urn:` subjects; re-emit guarded by delete-then-insert |
| Loud halts | every non-success in spawn/emit is a stop with full payload |

---

## 1. Architecture — three layers, three drivers

```
┌─────────────────────────────────────────────────────────────────┐
│  POST /api/workflows/run        (HTTP entry, harness-independent) │  ── driver 1: harness independence
└───────────────┬─────────────────────────────────────────────────┘
                │
        ┌───────▼────────────────────────────────────┐
        │  Deterministic driver (TS, hardcoded shape) │  parallel map → synthesize
        │   runSurveySynthesize(input): RunRecord     │
        └───┬───────────────────────────────┬─────────┘
            │ N× (cheap models, concurrent)  │ 1×
   ┌────────▼─────────┐            ┌──────────▼─────────┐
   │  runAgentNode()  │  ……×K……    │   runAgentNode()    │  ── driver 2: cheap-model fan-out
   │  (the primitive) │            │   (synthesizer)     │
   └────────┬─────────┘            └──────────┬─────────┘
            │ SpawnRequest (stdin JSON)        │
   ┌────────▼──────────────────────────────────▼─────────┐
   │  SandboxSpawner.enqueue()  → bwrap → Pi worker        │  (existing; semaphore=8)
   └──────────────────────────────────────────────────────┘
            │ AgentNodeResult[] (status, tokens, timing, structured)
   ┌────────▼──────────────────────────────────────────────┐
   │  Provenance emitter (vocab-driven serializer)          │  ── driver 3: graph-native events
   │   emitRunProvenance(proxy, graphId, RunRecord)         │
   │   → HostedMnemosyneProxy.callTool("sparql_update", …)  │
   │   → wf:Run + K+1 wf:AgentRun  (INSERT DATA)            │
   └────────────────────────────────────────────────────────┘
```

**Layer 1 — `runAgentNode(spec) → AgentNodeResult`.** The factored primitive. Wraps `spawner.enqueue()` + terminal-result collection into a Promise, and adds four capabilities the chat path doesn't expose today: per-node **model**, per-node **tool surface**, per-node **structured output** (forced `submit` tool), and **telemetry capture** (tokens, toolCalls, timing). Chat is refactored to call it too (regression guard, not new behavior).

**Layer 2 — the deterministic driver.** For Slice 1 this is **one hardcoded topology** in plain TypeScript: `parallel map → synthesize`. **No DSL, no interpreter** — that is deliberately deferred. The driver runs K `runAgentNode` calls via `Promise.all` (actual concurrency bounded by the existing semaphore), collects schema-validated results, then runs one synthesizer node.

**Layer 3 — the provenance emitter.** A vocab-driven serializer that turns a `RunRecord` into a `wf:Run` + N `wf:AgentRun` `INSERT DATA` block and posts it from the **orchestrator** via `HostedMnemosyneProxy.callTool("sparql_update", …)`, then runs a lightweight assertion pass.

---

## 2. The demo workflow (hardcoded): `graph-survey-synthesize`

Chosen because it dogfoods all three drivers at once and reuses the `graph-surveyor` archetype the commons already defines.

**Input:** `{ graphId, question, docIds[], mapModel, synthModel, k }`.

- **Phase 1 — map (parallel, cheap model ×K).** Each worker is given one `docId` + the question, with the `read_document` tool (curated surface) and a forced `submit` schema. Returns `{ docId, relevance: 0..1, keyPoints: string[], evidence: string[] }`.
- **Phase 2 — synthesize (×1).** One worker receives all map findings in its prompt (read-only tools), returns `{ title, markdown }` via `submit`. **The orchestrator writes the synthesis document** (code serializes) via `HostedMnemosyneProxy` `write_document`, capturing `synthesisDocId`.
- **Emit.** `wf:Run` + (K map + 1 synth) `wf:AgentRun`, plus `prov:used` → the workflow-definition doc and `prov:generated`/`wf:generatedFile` → the synthesis doc.

This exercises: graph **read** (input), graph **write** (synthesis), graph **provenance** (telemetry), cheap-model **fan-out**, and **HTTP** invocation with zero Claude Code in the loop.

---

## 3. Grounded seams (the build map)

All file:line refs verified 2026-06-14 against branch state. `src/` is the canonical flat tree.

### Spawn + concurrency
- Entry: `SandboxSpawner.enqueue(opts: SpawnOptions): SandboxRecord` — `src/spawner.ts:217`. Async-executes via `executeSpawn` → `doSpawn` (`spawner.ts:629`) → `spawn("bwrap", …)` (`spawner.ts:699`).
- **Concurrency: semaphore, default 8** — `new Semaphore(options?.maxConcurrentSpawns ?? 8)` (`spawner.ts:198`); acquire/release around `doSpawn` (`spawner.ts:605-627`). Each sandbox isolated (own cgroup `spawner.ts:686`, tmpfs, stdio). **K concurrent works out of the box.**
- Init message (all spawn data) sent as one JSON line on stdin — `spawner.ts:801`. Shape in agent report; fields: `intent`, `messages`, `system_prompt`, `wards`, `mnemosyne` (graph+auth+tool_profile), `model`, `depth`, `parent_spawn_id`.
- Agent call site: the workflow runtime resolves a canonical Agent Session and sends a complete runtime/ontology binding through `run-node.ts` to `spawner.ts`.
- Result return: NDJSON on stdout from the content-pinned Sophia host worker; `spawner.ts` validates the complete result/checkpoint authority before emitting a terminal lifecycle event.

### Worker internals
- Task input: one canonical `AgentSpawnRequest` over the Sophia host protocol.
- Provider and model are resolved together from the graph-pinned prompt binding; ambient defaults cannot rewrite an ontological workflow node.
- System prompt, Agent/Geist identity, skills, harness, runtime profile, and structured-output schema travel as explicit Meaningful Object bindings.
- Every external tool call crosses a host gate with an exact steward/profile allowlist; sandbox-side discovery is not authority.
- Simple and constrained Prime execute the same semantic core and differ only by host-validated constraints.
- Usage, tool counts, structured output, and the semantic checkpoint are validated before terminal projection.

### Pi structured output + models
- No native schema output. **Emulate:** `Tool<TSchema>` (TypeBox) + `validateToolArguments(tool, toolCall)` AJV (`pi/packages/ai/src/utils/validation.ts:64-93`) + `beforeToolCall` block hook (`pi/packages/agent/src/types.ts:46-49`, `agent-loop.ts:476-489`).
- Model per-spawn: `getModel(provider, modelId)`; providers anthropic/openai/google/mistral/xai/groq/openrouter/bedrock. Cheap: `groq:llama3-8b-8192` (free), `mistral:mistral-nemo` ($0.15), `openai:gpt-4o-mini` ($0.15), `google:gemini-2.5-flash-lite`, `anthropic:claude-haiku-4-5`.

### HTTP + auth + orchestrator→graph
- Routes: raw `node:http`, `routeRequest()` if-blocks on method+pathname (`orchestrator.ts:109-821`); add new endpoint before the 404 at `orchestrator.ts:820`.
- Auth: `resolveHostedAuthContext(headers)` (`src/auth.ts:31-72`) — internal-service (`x-internal-service` + `x-user-id`) or bearer; helper `requireAuthenticatedOwner()` (`orchestrator.ts:1024-1045`).
- **Orchestrator→graph RDF: `HostedMnemosyneProxy`** (`src/mnemosyne.ts:159-564`). Construct with `toolProfile: "full"`, `requiredTools: ["sparql_update","write_document","search_documents","read_document"]`, `serviceAuth: resolveGatewayServiceAuth(ownerUserId)` (`mnemosyne.ts:614-630`), then `await proxy.start()` and `proxy.callTool("sparql_update", { … })`. Service-auth synth session at `mnemosyne.ts:318-335` posts to `{gateway}/g/{graphId}/mcp`.

---

## 4. Provenance contract (emit EXACTLY this)

Namespace `wf: <http://mnemosyne.dev/workflow#>`, `prov: <http://www.w3.org/ns/prov#>`, vocab v0.2.0. Source of truth: `workflow-commons/wf-vocab` (block `block-a290f7c9`). **`INSERT DATA` only** (pattern-form `INSERT…WHERE` fails silently on this platform). Datatypes are load-bearing — the frontend joins on these names.

### `wf:Run` — subject `urn:sophia:wf-run:{runId}` ; `rdf:type` **both** `wf:Run` and `prov:Activity`
| Predicate | xsd | Req | Value |
|---|---|---|---|
| `wf:runId` | string | ✓ | the run id |
| `wf:workflowName` | string | ✓ | `"graph-survey-synthesize"` |
| `wf:status` | string | ✓ | `completed`\|`failed`\|`stopped` |
| `wf:totalTokens` | integer | ✓ | Σ agent tokens |
| `wf:agentCount` | integer | ✓ | K+1 |
| `wf:durationMs` | integer | ✓ | wall-clock |
| `prov:used` | uri | ✓ | **workflow-definition doc URI** (resolved, never hand-built) |
| `prov:startedAtTime` | dateTime | ✓ | ISO |
| `prov:endedAtTime` | dateTime | ✓ | ISO |
| `prov:generated` | uri | – | synthesis doc URI |
| `wf:generatedFile` | string | – | synthesis doc id / path |

### `wf:AgentRun` — subject `urn:sophia:wf-run:{runId}:agent:{slug(label)}` ; `rdf:type wf:AgentRun`
| Predicate | xsd | Req | Value |
|---|---|---|---|
| `wf:partOfRun` | uri | ✓ | the Run subject (**never `wf:run`**) |
| `wf:label` | string | ✓ | node label (e.g. `map:doc-3`, `synthesize`) |
| `wf:phaseIndex` | integer | ✓ | 1-based |
| `wf:model` | string | ✓ | `provider:modelId` |
| `wf:state` | string | ✓ | `done`\|`truncated`\|`error` |
| `wf:tokens` | integer | ✓ | total tokens |
| `wf:toolCalls` | integer | ✓ | count |
| `wf:durationMs` | integer | ✓ | per-node wall-clock |
| `wf:queuedAt` | **long** | ✓ | epoch ms |
| `wf:startedAt` | **long** | ✓ | epoch ms |
| `wf:cached` | boolean | ✓ | `false` (live); `true` only on journal replay |
| `wf:agentType` | string | – | e.g. `graph-surveyor` |

**slug(label):** `replace(/[^A-Za-z0-9_-]+/g, "-")`, strip leading/trailing `-`, **case preserved** (do not lowercase).

**`prov:used` for the slice:** resolve the workflow-definition doc URI via `SELECT ?w WHERE { ?w wf:name "graph-survey-synthesize" }`. If absent, the engine **ensures** a minimal definition document once (idempotent by title) via `write_document` and uses its doc URI. Full anatomy (AgentNodes, archetypes, `flowsInto`/`exemplifies`/`produces` CRDT wires) is **deferred to the emporium `workflow_ingest_apply` path** — out of scope for Slice 1.

### Example emit (shape)
```sparql
PREFIX wf:   <http://mnemosyne.dev/workflow#>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX xsd:  <http://www.w3.org/2001/XMLSchema#>
INSERT DATA {
  <urn:sophia:wf-run:20260614-aa31> a wf:Run, prov:Activity ;
    wf:runId "20260614-aa31" ; wf:workflowName "graph-survey-synthesize" ;
    wf:status "completed" ; wf:totalTokens 18422 ; wf:agentCount 5 ; wf:durationMs 41230 ;
    prov:used <…workflow-def-doc-uri…> ;
    prov:startedAtTime "2026-06-14T09:02:11Z"^^xsd:dateTime ;
    prov:endedAtTime   "2026-06-14T09:02:52Z"^^xsd:dateTime .
  <urn:sophia:wf-run:20260614-aa31:agent:map-doc-3> a wf:AgentRun ;
    wf:partOfRun <urn:sophia:wf-run:20260614-aa31> ; wf:label "map:doc-3" ;
    wf:phaseIndex 1 ; wf:model "mistral:mistral-nemo" ; wf:state "done" ;
    wf:tokens 3110 ; wf:toolCalls 1 ; wf:durationMs 9820 ;
    wf:queuedAt 1781773331000 ; wf:startedAt 1781773331450 ; wf:cached false .
  # … remaining map agents + synthesize …
}
```

**Idempotency / re-emit:** before insert, `DELETE { <run> ?p ?o }` for the run subject and each agent subject (or `DROP`-scope by subject) so a re-run of the same `runId` converges. Run a lightweight assertion pass after emit: every required predicate present per subject, no `wf:run` (the v0.1 drift) anywhere, datatypes correct.

---

## 5. Data shapes (TS)

```ts
// layer 1
interface AgentNodeSpec {
  label: string;                 // wf:label + slug source
  phaseIndex: number;            // 1-based
  prompt: string;                // becomes messages[0] (user)
  systemPrompt?: string;
  provider: string;              // "mistral" | "groq" | "google" | "openrouter" | …
  model: string;                 // model id within provider
  graphId: string;
  toolMode?: "curated" | "dynamic" | "none";
  excludeTools?: string[];
  schema?: TSchema;              // TypeBox → forced `submit` tool
  wards?: Partial<WardConfig>;
}
interface AgentNodeResult {
  label: string; phaseIndex: number;
  state: "done" | "truncated" | "error";
  output: string;                // done summary
  structured?: unknown;          // validated submit payload
  provider: string; model: string;
  turns: number; toolCalls: number; tokens: number;
  queuedAt: number; startedAt: number; durationMs: number;
  messages?: unknown[];
}
// layer 2/3
interface RunRecord {
  runId: string; workflowName: "graph-survey-synthesize";
  workflowDocUri: string; status: "completed" | "failed" | "stopped";
  startedAt: number; endedAt: number;
  agents: AgentNodeResult[];
  totalTokens: number; agentCount: number; durationMs: number;
  synthesisDocId?: string;
}
```

---

## 6. Work packages

> Order: WP1→WP2 (sequenced, both touch the worker/spawn wire), then WP3‖WP4, then WP5, WP6 throughout, WP7 last. Everything is **local code + local/gateway tests**. No deploy without explicit go-ahead.

**WP0 — branch + scaffolding.** Branch `feat/workflow-engine-slice-1` off `main`. New module dir `src/workflow/` (`run-node.ts`, `driver-survey-synthesize.ts`, `provenance.ts`, `vocab.ts`, `types.ts`).

**WP1 — `runAgentNode` primitive + per-node knobs.**
- Extend the canonical `AgentSpawnRequest` (`wire-protocol.ts`): `provider_override?`, `model_override?`, `tool_mode?`, `exclude_tools?`, `output_schema?` (serialized TypeBox/JSON-schema).
- Sophia host worker: provider-aware host inference, host-gated curated/dynamic tools, and a validated `submit` tool for forced structured output.
- Orchestrator: `runAgentNode(spec): Promise<AgentNodeResult>` — builds the worker config, calls `enqueue`, subscribes to the event bus for this `sandbox_id`, resolves on the terminal lifecycle event, maps to `AgentNodeResult`. Refactor the chat path (`orchestrator.ts:757`) to go through a shared config-builder (no behavior change).

**WP2 — telemetry wire-through.** Carry usage and tool counts through the Sophia host protocol into `AgentNodeResult`, with host timestamps and validated semantic checkpoints.

**WP3 — deterministic driver + demo.** `driver-survey-synthesize.ts`: `runSurveySynthesize(input): Promise<RunRecord>`. `Promise.all` of K map `runAgentNode` (curated read tools, cheap model, map schema), then 1 synth node (read tools, synth schema), then orchestrator writes the synthesis doc via `HostedMnemosyneProxy.write_document` and captures `synthesisDocId`. Map/synth TypeBox schemas in `types.ts`.

**WP4 — provenance emitter.** `vocab.ts` (predicate/datatype tables + slug + URN minters, mirrored from §4) and `provenance.ts`: `serializeRunProvenance(run): string` (INSERT DATA) + `emitRunProvenance(proxy, graphId, run)` (DELETE-then-INSERT, then assertion pass). `ensureWorkflowDef(proxy, graphId)` resolves/creates the definition doc URI for `prov:used`.

**WP5 — HTTP endpoint.** `POST /api/workflows/run` in `routeRequest()`: `requireAuthenticatedOwner` → parse `{graph_id, question, doc_ids?|folder_id?, k?, map_model?, synth_model?}` → build a `HostedMnemosyneProxy` (full profile, serviceAuth) → `runSurveySynthesize` → `emitRunProvenance` → `sendJson(202|200, { runId, status, summary, synthesisDocId, provenance:{ runUri, agentCount, totalTokens } })`. Stream phase events over the existing SSE bus if cheap; otherwise synchronous with `runId`.

**WP6 — tests.** Unit: exact provenance, artifact-pin admission, result/checkpoint validation, submit-tool validation, and `runAgentNode` through the shared Sophia worker. Integration: a graph-defined Domain Agent workflow and canonical Agent Session projection.

**WP7 — STATUS.md + verification.** `docs/workflow-engine/STATUS.md`: what's done, what's stubbed, the exact local run command, the SPARQL to see the run, and the deploy/verify steps (left for Vera — no deploy performed).

---

## 7. Definition of "basically done" (acceptance)

1. `POST /api/workflows/run` against a real graph runs K cheap-model map workers **concurrently** + 1 synthesizer, writes a synthesis document, and returns the structured summary — **with zero Claude Code / Anthropic harness in the loop.**
2. The run emits a contract-valid `wf:Run` + (K+1) `wf:AgentRun` via direct `sparql_update` (exact predicates, exact datatypes, `INSERT DATA`, no `wf:run`), idempotent on re-run of the same `runId`.
3. Provenance is queryable: the protocol run-timeline SPARQL returns the run, its `prov:used` workflow doc, and its per-agent telemetry (tokens/model/timing).
4. Map workers run on a **cheap model** (default `mistral:mistral-nemo`, swappable per request); per-agent `wf:tokens` is populated (telemetry gap closed).
5. Unit + one integration test green; chat path unbroken.
6. `STATUS.md` written; nothing deployed to the live host.

---

## 8. Risks & explicitly deferred

- **Telemetry wire-through (WP2)** is the only research-confirmed gap — token usage is currently discarded worker-side. Highest-risk WP; do it second so everything downstream has real numbers.
- **Structured output is emulated** (submit tool). Author schemas in TypeBox directly (no lossy JSON-Schema↔TypeBox conversion). Cap retries via wards to avoid loops.
- **`prov:used` honesty.** Slice ensures a minimal def doc; full workflow anatomy (nodes/wires/archetypes) goes through `workflow_ingest_apply` later — do **not** hand-mint doc-fragment subjects (the materializer wipes `#`-subjects).
- **One bwrap sandbox per map node** is heavy for pure read-only LLM calls. Acceptable at K≤8 on the current t3.large. Deferred: a lightweight in-process node for trusted read-only map work, and a worker **pool/fleet** for K≫8.
- **No DSL/interpreter, no resume-journaling, no campaign/optimization workflows** in Slice 1 — the topology is hardcoded. These are the obvious next slices once the primitive + emitter are proven.
- **No assertion-suite parity** with the emporium server — we run a lightweight local check, not the full generated suite. Graduating to `workflow_ingest_apply` for definitions restores it.

---

## 9. Next slices (after this lands)

1. **The interpreter** — replace the hardcoded topology with the Workflow-dialect runtime (`agent()/parallel()/pipeline()/phase()`), so workflow *scripts* become portable artifacts the commons already knows how to file.
2. **Resume-journaling** — cache `runAgentNode` by `(prompt, opts)`; replay unchanged prefixes (and emit `wf:cached true`).
3. **In-Sophia triggering** — a chat agent or a graph event kicks off a workflow run.
4. **Fleet** — worker pool / burst capacity for real fan-out (K≫8).
5. **Definition round-trip** — file the workflow *definition* (anatomy + archetypes + wires) through `workflow_ingest_apply`, closing author→run→provenance fully inside Sophia.
