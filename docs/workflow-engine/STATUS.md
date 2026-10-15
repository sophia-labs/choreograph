# Loom Slice 1 — STATUS

*Branch `feat/workflow-engine-slice-1`. Updated 2026-06-14.*

## What's done (local build green)

The Choreograph Workflow Engine ("Loom") Slice 1 is implemented per `SPEC.md`:

- **`runAgentNode` primitive** (`src/workflow/run-node.ts`) — built on the SAME `spawner.enqueue` machinery chat uses. Per-node model, tool-surface (`curated`/`dynamic`/`none`), forced structured-output schema, turn budget. Resolves the node result (status + telemetry + structured output) from the terminal bus event. Dependency-injected as a `NodeRunner` so drivers are unit-testable without bwrap.
- **Forced structured output** (the packaged Prime host worker) — when `output_schema` is set the worker exposes a required `submit` tool; Pi validates the model's call against the schema and retries on mismatch. The validated object returns as `structured_output`.
- **Telemetry wire-through** (WP2) — the worker now sums `AssistantMessage.usage` and counts tool calls into `SpawnResult.{tokens,tool_calls}`; the spawner attaches the full `SpawnResult` to the terminal bus event; `runAgentNode` reads it.
- **Deterministic driver** (`src/workflow/driver-survey-synthesize.ts`) — hardcoded `parallel map → synthesize` topology. K cheap-model map nodes (curated read tools, `MapFindingsSchema`) → 1 synth node (`none` tools, `SynthesisSchema`) → orchestrator writes the synthesis doc (code serializes).
- **Provenance emitter** (`src/workflow/{vocab,provenance}.ts`) — vocab-driven `wf:Run` + `wf:AgentRun` serializer. Exact predicates + datatypes (`xsd:long` for queued/started, etc.), `INSERT DATA` only, `wf:partOfRun` (never `wf:run`), structural self-check that throws on drift, best-effort idempotency delete, `ensureWorkflowDef` (urn workflow subject for `prov:used`).
- **HTTP endpoint** `POST /api/workflows/run` (`src/orchestrator.ts`) — auth → resolve docs (explicit `doc_ids` or `search_documents`) → ensure workflow def → fan out → emit provenance → JSON summary.
- **Tests** (`src/test/workflow-*.test.ts`) — 23 passing across provenance/structured/driver/run-node, + 1 gated gateway integration test (skipped without creds).

### Verification done locally (macOS)
- `pnpm build` (worker `tsc -b`): **green**.
- Workflow suites: **23 pass / 1 skipped** (`pnpm exec tsx --test src/test/workflow-*.test.ts`).
- 41/41 non-Linux suites near the edits pass → **no chat-path regression**.
- All new/edited files are **biome-clean** and typecheck-clean under strict mode.

## Reality vs spec (fixed reality, per the goal)

1. **No `provider` field; cheap model = OpenRouter model id.** The orchestrator LLM proxy always routes real calls through OpenRouter (`spawner.ts:1453`), so per-node model is the only lever needed. Default map model `mistralai/mistral-nemo`, synth `google/gemini-2.5-flash` (override via body or `WORKFLOW_MAP_MODEL`/`WORKFLOW_SYNTH_MODEL`).
2. **`prov:used` → a `urn:sophia:wf:` subject, not a document URI.** `write_document` has replace-semantics and doc subjects are materializer-owned/hazardous; a urn workflow subject is contract-shaped, travels verbatim, and is safe. Full workflow-anatomy (AgentNodes/archetypes/wires via emporium `workflow_ingest_apply`) is the deferred next slice.
3. **Synthesis doc write is best-effort** (`write_document` create-on-new-id is unverified on the platform). On failure the run still completes and the markdown is in the response + a `note`.

## What's stubbed / deferred (SPEC §8–§9)

No DSL/interpreter, no resume-journaling, no worker pool (K≤8 on the semaphore), lightweight local assertion (not the full emporium suite), one bwrap sandbox per map node.

## Can't run on macOS (bwrap is Linux-only)

The full fan-out E2E (spawner → bwrap → worker → gateway) needs Linux + cgroups, so `src/test/{api,cgroup,spawner}.test.ts` are cancelled locally (`/proc/self/cgroup` ENOENT) — environmental, not regressions. **Host validation is the remaining gate.**

## Deploy + validate (host)

**Local run command (host, bwrap available):**
```bash
curl -sS -X POST http://localhost:3456/api/workflows/run \
  -H "x-internal-service: $MNEMOSYNE_INTERNAL_SERVICE_SECRET" \
  -H "x-user-id: <cognito-sub-with-acl>" \
  -H 'content-type: application/json' \
  -d '{"graph_id":"workflow-engine-smoke","question":"What is the engine for?","k":4}'
```

**See the run in the graph (SPARQL, run-timeline join):**
```sparql
PREFIX wf: <http://mnemosyne.dev/workflow#>
PREFIX prov: <http://www.w3.org/ns/prov#>
SELECT ?run ?model ?tokens ?state WHERE {
  ?run wf:runId "<runId>" ; prov:used ?wf .
  ?a wf:partOfRun ?run ; wf:model ?model ; wf:tokens ?tokens ; wf:state ?state .
}
```

**Gated gateway integration test** (provenance round-trip, no bwrap needed):
```bash
MNEMOSYNE_GATEWAY_BASE_URL=… MNEMOSYNE_SERVICE_TOKEN=… \
WORKFLOW_TEST_GRAPH=workflow-engine-smoke WORKFLOW_TEST_USER=<sub> \
pnpm exec tsx --test src/test/workflow-run.integration.test.ts
```

## Known infra note (pre-existing, not this work)

The host runtime is gated by `pnpm check`; the packaged Prime runtime is built and tested in its source repository before bundle publication.
