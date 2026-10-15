# Contributing to Sophia Compute

Thanks for your interest. Sophia Compute (code name `choreograph`) is licensed under the [MIT License](LICENSE) and
maintained by Sophia Labs. By contributing, you agree that your contributions are submitted under, and may be
distributed under, that same license.

## Getting started

The repository uses [pnpm](https://pnpm.io/) through Corepack and Node.js 22.19 or newer. pi comes from npm
(`@earendil-works/pi-*`); there are no submodules.

```sh
git clone https://github.com/sophia-labs/choreograph.git
cd choreograph
corepack enable
pnpm install
pnpm build
pnpm check
pnpm test
```

`pnpm test` runs everywhere; the cgroup and bubblewrap suites run on Linux only and skip elsewhere. `pnpm dev:vm`
and `pnpm test:vm` run the orchestrator and the full suite inside a small Linux VM (Lima or multipass on macOS,
WSL2 on Windows) for the bubblewrap path.

## Tooling

| Concern | Tool | Command |
|---|---|---|
| Formatting and linting | [Biome](https://biomejs.dev/) | `pnpm check` |
| Typecheck | TypeScript | `pnpm check`, `pnpm check:types` (no file worse than `scripts/check-types.baseline.json`) |
| Tests | `node:test` through `tsx` | `pnpm test` |
| The service folder gardend runs | esbuild | `node deploy/build-gardend-service.mjs <dir> --natives host` |

Tests live in `src/test/*.test.ts` and `packages/*/test/`. Add or change tests with every behaviour change; tests run
real code (real processes, real stores), not mocks.

## Where to work

- `src/` is the orchestrator: the HTTP API, the workflow engine, the agent runtime and its host bridge, capabilities.
- `packages/agent-body` is the agent body (upstream pi behind the host bridge); `packages/canonical-json` is the
  canonical JSON and digest contract; `packages/sophia-kernel-runtime` and `crates/jupyter-bridge` are the kernel
  runtime for the bubblewrap path.
- `deploy/` builds what runs: the gardend service folder and the Linux runtime bundles.

## Pull requests

Branch off `main`, write [Conventional Commits](https://www.conventionalcommits.org/) (`feat(workflow): …`,
`fix(spawner): …`), keep `pnpm check` and `pnpm test` green, and describe what changed and why. Never commit secrets,
keys or `.env` files; add new settings to `.env.example`. Report security problems privately as
[SECURITY.md](SECURITY.md) says, not in a public issue.
