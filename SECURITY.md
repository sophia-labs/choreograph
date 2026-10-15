# Security Policy

Choreograph's job is to run untrusted AI-agent code in isolation. The
**sandbox isolation boundary is security-critical**: a sandbox is a
bubblewrap-isolated child process with no network (`--unshare-net`), no shared
filesystem, and no ambient credentials, communicating only via NDJSON over
stdio. API keys never enter the sandbox — LLM calls are host-mediated through
the orchestrator's proxy, and Mnemosyne tools are proxied through gate calls.
Any defect that lets sandboxed code escape that boundary, reach the network,
read host credentials, or exfiltrate data through the wire protocol is treated
as a high-severity vulnerability.

We appreciate responsible disclosure and will work with you to understand and
resolve issues quickly.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report vulnerabilities privately to **security@sophia-labs.com**.
<!-- PLACEHOLDER: confirm the correct security contact address before publishing. -->

Where possible, please include:

- A description of the issue and its potential impact (for example, whether it
  allows sandbox escape, credential disclosure, network egress from a sandbox,
  or denial of service).
- Steps to reproduce, or a proof-of-concept.
- The affected component or file path (e.g. the spawner, cgroup setup, wire
  protocol, LLM proxy, or gate dispatcher).
- The commit, release version, or deployment where you observed it.

You may optionally encrypt sensitive details; ask in your initial message and we
will arrange a key.

## What to expect

- **Acknowledgement** of your report as soon as we are able to triage it.
- An assessment of severity and an indication of next steps.
- Coordination with you on remediation and, where appropriate, public disclosure
  timing. We aim to fix confirmed high-severity issues promptly and will keep you
  informed of progress.
- Credit for the discovery, if you would like it, once a fix is available.

## Scope

In scope:

- The orchestrator and sandbox runtime in `src/`.
- The supporting abstractions in `packages/` (spawner interface, pool, wire
  protocol, LLM proxy, Mnemosyne gate).
- Deployment and infrastructure configuration under `deploy/`.

Out of scope / handle upstream:

- Upstream dependencies such as Pi (`@earendil-works/pi-*` from npm) — report
  issues in those to their maintainers (though we still want to hear if an
  upstream issue affects Choreograph's isolation boundary).

Thank you for helping keep Choreograph and its users safe.
