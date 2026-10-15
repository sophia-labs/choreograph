import { createHash } from "node:crypto";
import type { ExecutionCellOutput } from "../agent-runtime/execution-service.js";
import type { BusEvent, SandboxEventBus } from "../event-bus.js";
import { resolveBridge } from "../kernel-bridges.js";
import type { SandboxStore } from "../sandbox-store.js";
import type { SandboxSpawner } from "../spawner.js";
import type { NotebookRunClaims } from "./claims.js";
import type { DevelopmentGarden, NotebookExecutionRecord } from "./garden.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const RUN_FOLDER = "notebook-runs";
// The whole JSON receipt is a Garden code block capped at 256 KiB. Leave room
// for identity, status, and JSON escaping around the retained output preview.
const MAX_OUTPUT_BYTES = 128 * 1024;
type Kernel = "python3" | "julia" | "ocaml" | "cpp";

export interface NotebookWorkspace {
	readonly options: { garden: DevelopmentGarden };
	supportedNotebookKernels(): string[];
	listSharedNotebookRuns(documentId: string): Promise<unknown[]>;
	executeSharedNotebookCell(
		documentId: string,
		cellId: string,
		executionId: string,
	): Promise<{
		id: string;
		documentId: string;
		cellId: string;
		kernel: Kernel;
		sourceVersion: string;
		currentOutput: boolean;
		record: NotebookExecutionRecord;
	}>;
}

interface RunReceipt {
	schema: "sophia.hosted-notebook-run.v1";
	id: string;
	userId: string;
	graphId: string;
	documentId: string;
	cellId: string;
	kernel: Kernel;
	sourceVersion: string;
	documentVersion: string;
	createdAt: number;
	status: "pending" | "done";
	published?: boolean;
	currentOutput?: boolean;
	record?: NotebookExecutionRecord;
}

/** One hosted, graph and user bound coordinator. Garden holds run authority. */
export class HostedNotebookWorkspace implements NotebookWorkspace {
	readonly options: { garden: DevelopmentGarden };
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly executionQueues = new Map<string, Promise<unknown>>();
	private readonly kernels = new Map<string, { sandboxId: string; generation: number }>();
	private generation = 0;

	constructor(
		garden: DevelopmentGarden,
		private readonly userId: string,
		private readonly spawner: SandboxSpawner,
		private readonly store: SandboxStore,
		private readonly eventBus: SandboxEventBus,
		private readonly claims: NotebookRunClaims,
	) {
		this.options = { garden };
	}

	supportedNotebookKernels(): string[] {
		// resolveBridge is the host's installed bundle registry, not a claim that a
		// user's browser or local Python has these runtimes.
		return (["python3", "julia", "ocaml", "cpp"] as const).filter((kind) => {
			try {
				resolveBridge(kind);
				return true;
			} catch {
				return false;
			}
		});
	}

	private runDocumentId(executionId: string): string {
		return `notebook-run-${digest(`${this.options.garden.graphId}\0${this.userId}\0${executionId}`).slice(0, 32)}`;
	}

	private async readReceipt(runDocumentId: string): Promise<RunReceipt | undefined> {
		try {
			await this.options.garden.call("read_document", {
				graphId: this.options.garden.graphId,
				documentId: runDocumentId,
				format: "json",
				maxChars: 1024,
			});
		} catch (error) {
			if (/not found|does not exist|missing document|404/i.test(String(error))) return undefined;
			throw error;
		}
		const snapshot = await this.options.garden.snapshot(runDocumentId);
		if (snapshot.blocks.length !== 1) throw new Error("Run receipt is incomplete; refusing execution replay");
		const receipt = JSON.parse(snapshot.blocks[0].text) as RunReceipt;
		if (receipt.schema !== "sophia.hosted-notebook-run.v1") throw new Error("Run receipt has an unknown schema");
		return receipt;
	}

	async listSharedNotebookRuns(documentId: string): Promise<unknown[]> {
		if (!documentId.startsWith("notebook-") || documentId.startsWith("notebook-run-"))
			throw new Error("Not a notebook document");
		const edges = await this.options.garden.call("get_wires", {
			graphId: this.options.garden.graphId,
			documentId,
			direction: "incoming",
			predicate: "https://sophia-labs.com/ns/notebook#executes",
		});
		if (!Array.isArray(edges.wires)) throw new Error("Garden did not return notebook run wires");
		if (edges.wires.length > 2000) throw new Error("Notebook run index exceeds the hosted read bound");
		const found: RunReceipt[] = [];
		const ids = [
			...new Set(
				edges.wires
					.map((edge: { sourceDocumentId?: unknown }) => edge.sourceDocumentId)
					.filter((id: unknown): id is string => typeof id === "string" && id.startsWith("notebook-run-")),
			),
		];
		for (let offset = 0; offset < ids.length; offset += 8) {
			const receipts = await Promise.all(ids.slice(offset, offset + 8).map((id) => this.readReceipt(id)));
			for (const receipt of receipts)
				if (receipt?.documentId === documentId && receipt.userId === this.userId) found.push(receipt);
		}
		return found.sort((a, b) => b.createdAt - a.createdAt).slice(0, 25);
	}

	async executeSharedNotebookCell(documentId: string, cellId: string, executionId: string) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(executionId)) throw new Error("Invalid execution ID");
		return this.serial(this.executionQueues, executionId, () =>
			this.serial(this.queues, documentId, () => this.executeSerial(documentId, cellId, executionId)),
		);
	}

	private async serial<T>(queues: Map<string, Promise<unknown>>, key: string, action: () => Promise<T>): Promise<T> {
		const previous = queues.get(key) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(action);
		queues.set(key, next);
		try {
			return await next;
		} finally {
			if (queues.get(key) === next) queues.delete(key);
		}
	}

	private async executeSerial(documentId: string, cellId: string, executionId: string) {
		const garden = this.options.garden;
		const runDocumentId = this.runDocumentId(executionId);
		const prior = await this.readReceipt(runDocumentId);
		if (prior) {
			if (
				prior.id !== executionId ||
				prior.documentId !== documentId ||
				prior.cellId !== cellId ||
				prior.userId !== this.userId
			)
				throw new Error("Execution ID belongs to another cell");
			if (prior.status !== "done" || !prior.record)
				throw new Error("Execution intent exists without a settled result; refusing automatic replay");
			return prior.published
				? { ...prior, currentOutput: Boolean(prior.currentOutput), record: prior.record }
				: this.publishReceipt(runDocumentId, prior);
		}
		const source = await garden.notebookCell(documentId, cellId);
		if (!this.supportedNotebookKernels().includes(source.kernel))
			throw new Error(`Hosted kernel ${source.kernel} is unavailable`);
		await garden.flush(documentId);
		const current = await garden.notebookCell(documentId, cellId);
		if (current.documentVersion !== source.documentVersion || current.sourceVersion !== source.sourceVersion)
			throw new Error("Notebook changed before execution; retry the cell");
		const receipt: RunReceipt = {
			schema: "sophia.hosted-notebook-run.v1",
			id: executionId,
			userId: this.userId,
			graphId: garden.graphId,
			documentId,
			cellId,
			kernel: source.kernel,
			sourceVersion: source.sourceVersion,
			documentVersion: source.documentVersion,
			createdAt: Date.now(),
			status: "pending",
		};
		if (!(await this.claims.claim(runDocumentId, executionId, JSON.stringify(receipt))))
			throw new Error("Another hosted worker claimed this execution ID; inspect its run receipt");
		await garden.call("create_folder", { graphId: garden.graphId, folderId: RUN_FOLDER, name: "Notebook runs" });
		await garden.call("move_documents", {
			graphId: garden.graphId,
			documentIds: [runDocumentId],
			parentId: RUN_FOLDER,
			order: receipt.createdAt,
		});
		await this.linkReceipt(runDocumentId, documentId);
		// The intent is now durable. Any later uncertainty must be observed, never
		// solved by replaying arbitrary code under the same execution ID.
		const record = await this.runKernel(source.kernel, documentId, source.source, executionId);
		const settled: RunReceipt = { ...receipt, status: "done", record };
		await this.writeReceipt(runDocumentId, settled);
		return this.publishReceipt(runDocumentId, settled);
	}

	private async writeReceipt(documentId: string, receipt: RunReceipt): Promise<void> {
		const snapshot = await this.options.garden.snapshot(documentId);
		await this.options.garden.edit(documentId, `${documentId}-receipt`, JSON.stringify(receipt), snapshot.version);
	}

	private async publishReceipt(runDocumentId: string, receipt: RunReceipt) {
		const garden = this.options.garden;
		const record = receipt.record!;
		const currentOutput = await garden.recordNotebookExecution(
			receipt.documentId,
			receipt.cellId,
			receipt.sourceVersion,
			record,
		);
		await this.linkReceipt(runDocumentId, receipt.documentId);
		const published: RunReceipt = { ...receipt, published: true, currentOutput };
		await this.writeReceipt(runDocumentId, published);
		return { ...published, currentOutput, record };
	}

	private async linkReceipt(runDocumentId: string, documentId: string): Promise<void> {
		const garden = this.options.garden;
		const wireId = `${runDocumentId}-executes`;
		const existing = await garden.call("get_wires", {
			graphId: garden.graphId,
			documentId: runDocumentId,
			direction: "outgoing",
		});
		if (Array.isArray(existing.wires) && existing.wires.some((wire: { id?: unknown }) => wire.id === wireId)) return;
		await garden.call("create_wires", {
			graphId: garden.graphId,
			sourceDocumentId: runDocumentId,
			targetDocumentId: documentId,
			predicate: "https://sophia-labs.com/ns/notebook#executes",
			wireId,
		});
	}

	private async kernelFor(kind: Kernel, documentId: string): Promise<{ sandboxId: string; generation: number }> {
		const key = `${documentId}\0${kind}`;
		const existing = this.kernels.get(key);
		if (existing && this.store.get(existing.sandboxId)?.state === "running") return existing;
		for (const [id, kernel] of this.kernels)
			if (this.store.get(kernel.sandboxId)?.state !== "running") this.kernels.delete(id);
		if (this.kernels.size >= 8) throw new Error("Hosted notebook kernel limit reached for this workspace");
		const bridge = resolveBridge(kind);
		const spawned = await this.spawner.spawn({
			template: "bare",
			filesystems: bridge.filesystems,
			worker_config: { mode: "kernel", kernel: kind },
			ownerUserId: this.userId,
			authMethod: "internal_service",
			intent: `notebook:${digest(documentId).slice(0, 20)}`,
			timeout_ms: 30 * 60_000,
		});
		if (spawned.state !== "running") throw new Error(`Hosted kernel failed to start (${spawned.state})`);
		const kernel = { sandboxId: spawned.sandbox_id, generation: ++this.generation };
		this.kernels.set(key, kernel);
		try {
			await this.observe(kernel.sandboxId, undefined, 15_000, (events) =>
				events.some((event) => event.type === "kernel_ready"),
			);
		} catch (error) {
			this.kernels.delete(key);
			if (this.store.get(kernel.sandboxId)?.state === "running") await this.spawner.kill(kernel.sandboxId);
			throw error;
		}
		return kernel;
	}

	private async runKernel(
		kind: Kernel,
		documentId: string,
		code: string,
		executionId: string,
	): Promise<NotebookExecutionRecord> {
		const kernel = await this.kernelFor(kind, documentId);
		const startedAt = Date.now();
		let inputId: string | undefined;
		let events: BusEvent[];
		try {
			events = await this.observe(
				kernel.sandboxId,
				() => {
					inputId = this.spawner.sendKernelExecute(kernel.sandboxId, code).inputId;
				},
				120_000,
				(observed) =>
					Boolean(inputId) && observed.some((event) => event.type === "kernel_idle" && event.input_id === inputId),
			);
		} catch (error) {
			// A timed-out kernel can still be running user code. Reap it before any
			// later cell receives this notebook's kernel identity.
			this.kernels.delete(`${documentId}\0${kind}`);
			if (this.store.get(kernel.sandboxId)?.state === "running") await this.spawner.kill(kernel.sandboxId);
			throw error;
		}
		const ours = events.filter((event) => event.input_id === inputId);
		const reply = ours.find((event) => event.type === "kernel_reply");
		const outputs: ExecutionCellOutput[] = [];
		let bytes = 0;
		let outputTruncated = false;
		for (const event of ours) {
			let output: ExecutionCellOutput | undefined;
			if (event.type === "kernel_stream") output = { kind: "stream", name: event.name, text: event.text };
			if (event.type === "kernel_display")
				output = { kind: "display", data: event.data, ...(event.metadata ? { metadata: event.metadata } : {}) };
			if (event.type === "kernel_result")
				output = { kind: "result", data: event.data, ...(event.metadata ? { metadata: event.metadata } : {}) };
			if (event.type === "kernel_error")
				output = { kind: "error", error: { ename: event.ename, evalue: event.evalue, traceback: event.traceback } };
			if (!output) continue;
			const encoded = JSON.stringify(output);
			if (bytes + Buffer.byteLength(encoded) > MAX_OUTPUT_BYTES) {
				outputTruncated = true;
				break;
			}
			bytes += Buffer.byteLength(encoded);
			outputs.push(output);
		}
		return {
			executionId,
			generation: kernel.generation,
			status: reply?.type === "kernel_reply" && reply.status === "ok" ? "ok" : "error",
			outputs,
			...(reply?.type === "kernel_reply" ? { executionCount: reply.execution_count } : {}),
			durationMs: Date.now() - startedAt,
			outputTruncated,
		};
	}

	private observe(
		sandboxId: string,
		start: (() => void) | undefined,
		timeoutMs: number,
		complete: (events: BusEvent[]) => boolean,
	): Promise<BusEvent[]> {
		return new Promise((resolve, reject) => {
			const events: BusEvent[] = [];
			let settled = false;
			let unsubscribe = () => {};
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe();
				if (error) reject(error);
				else resolve(events);
			};
			const capture = (event: BusEvent) => {
				if (event.type === "snapshot" && "recent_events" in event) {
					for (const prior of event.recent_events) capture(prior);
					return;
				}
				events.push(event);
				if (events.length > 4096) {
					finish(new Error("Hosted kernel event limit exceeded; execution will not be replayed"));
					return;
				}
				if (event.category === "lifecycle" && event.type === "terminal")
					finish(new Error("Hosted kernel exited before reply"));
				else if (complete(events)) finish();
			};
			const timer = setTimeout(
				() => finish(new Error("Hosted kernel execution timed out; execution will not be replayed")),
				timeoutMs,
			);
			unsubscribe = this.eventBus.subscribe(capture, { sandbox_id: sandboxId });
			if (settled) unsubscribe();
			else if (start) {
				try {
					start();
					if (complete(events)) finish();
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
			}
		});
	}

	async close(): Promise<void> {
		await this.options.garden.close();
		await Promise.all(
			[...this.kernels.values()].map(async (kernel) => {
				if (this.store.get(kernel.sandboxId)?.state === "running") await this.spawner.kill(kernel.sandboxId);
			}),
		);
		this.kernels.clear();
	}
}
