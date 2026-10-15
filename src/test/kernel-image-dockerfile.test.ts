import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CPP_RUNTIME_STD } from "../runtime-bundles.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORCHESTRATOR_DOCKERFILE = join(REPO_ROOT, "src", "Dockerfile");
const KERNEL_DOCKERFILE = join(REPO_ROOT, "Dockerfile.kernels");

/**
 * `ARG NAME=value` → Map. Only defaulted ARGs are pins; a bare `ARG NAME` is a
 * build-time input, not a claim about what gets baked.
 */
function pinnedArgs(dockerfile: string): Map<string, string> {
	const pins = new Map<string, string>();
	for (const line of readFileSync(dockerfile, "utf8").split("\n")) {
		const match = /^ARG\s+([A-Z0-9_]+)=(.+)$/.exec(line.trim());
		if (match) {
			pins.set(match[1], match[2]);
		}
	}
	return pins;
}

describe("Dockerfile.kernels", () => {
	/**
	 * Docker has no include directive, so the payload stanzas exist twice: once
	 * in the orchestrator's dev image and once in the kernel image. Duplication
	 * that nothing checks is duplication that drifts, and the way it would drift
	 * is the worst one available — a kernel proven at one Julia and shipped at
	 * another. This is the check. It is not a request to be careful.
	 */
	it("pins every payload identically to src/Dockerfile", () => {
		const orchestrator = pinnedArgs(ORCHESTRATOR_DOCKERFILE);
		const kernelImage = pinnedArgs(KERNEL_DOCKERFILE);

		assert.ok(orchestrator.size > 0, "src/Dockerfile must declare pinned ARGs");
		const drifted: string[] = [];
		for (const [name, value] of orchestrator) {
			if (!kernelImage.has(name)) {
				drifted.push(`${name}: absent from Dockerfile.kernels`);
				continue;
			}
			if (kernelImage.get(name) !== value) {
				drifted.push(`${name}: ${value} !== ${kernelImage.get(name)}`);
			}
		}
		assert.deepEqual(drifted, [], `payload pins drifted between the two Dockerfiles:\n${drifted.join("\n")}`);
	});

	it("keeps the C++ language standard the registry advertises", () => {
		// The registry passes -std= to clang and the payload's build verifies a
		// #include <iostream> against that same standard. If they disagree, the
		// kernel compiles with flags nothing proved.
		const pins = pinnedArgs(KERNEL_DOCKERFILE);
		assert.equal(pins.get("CPP_STD"), CPP_RUNTIME_STD);
	});

	it("refuses to solve the C++ closure by default", () => {
		// CPP_RUNTIME_SOLVE=1 installs whatever conda-forge resolves today. It is
		// how the lock is bootstrapped and it must never be how a release is
		// built, so the checked-in default is the hermetic one.
		const pins = pinnedArgs(KERNEL_DOCKERFILE);
		assert.equal(pins.get("CPP_RUNTIME_SOLVE"), "0");
	});

	it("copies the payloads before anything that changes hourly", () => {
		// The cache contract, asserted rather than commented. The payloads are
		// gigabytes and move a few times a year; the bridge and the harnesses move
		// every day. Docker invalidates every layer after the first changed one,
		// so if a COPY of src/ or crates/ ever lands above a payload COPY, every
		// build rebuilds every payload and nobody notices until the bill arrives.
		// Only the assembly stages matter: a builder stage copying its own recipe
		// out of deploy/ is not a layer of the shipped image.
		const allLines = readFileSync(KERNEL_DOCKERFILE, "utf8").split("\n");
		const assemblyStart = allLines.findIndex((line) => /^FROM .*\bAS payloads$/.test(line.trim()));
		assert.notEqual(assemblyStart, -1, "the kernel image must assemble in a stage named payloads");
		const lines = allLines.slice(assemblyStart);

		const lastPayloadCopy = lines.findLastIndex((line) => /^COPY --from=\S+-payload\s/.test(line.trim()));
		const firstSourceCopy = lines.findIndex((line) => /^COPY (src|deploy)\//.test(line.trim()));
		const bridgeCopy = lines.findIndex((line) => /^COPY --from=bridge\s/.test(line.trim()));

		assert.notEqual(lastPayloadCopy, -1, "the kernel image must copy payloads from their builder stages");
		assert.notEqual(firstSourceCopy, -1, "the kernel image must copy the worker and the harnesses");
		assert.notEqual(bridgeCopy, -1, "the kernel image must copy the Rust bridge");
		assert.ok(lastPayloadCopy < bridgeCopy, "payload layers must precede the bridge layer");
		assert.ok(bridgeCopy < firstSourceCopy, "the bridge layer must precede the repository files");
	});
});
