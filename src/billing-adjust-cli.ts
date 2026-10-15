/**
 * `billing-adjust-cli.ts`: the operator's command line for credit adjustments (see `billing-adjust.ts` for the
 * rules). It ships in `src/` so that it is ON the host, in the same release as the service that wrote the
 * ledger, and can be run there over SSM by a person who has read the plan:
 *
 *   cd /opt/choreograph/current
 *   # 1. the dry run (the default): prints the plan and its sha256, changes nothing
 *   sudo -u choreograph env DATA_DIR=/var/lib/choreograph node_modules/.bin/tsx src/billing-adjust-cli.ts --file batch.json
 *   # 2. read it. Then ONE apply of exactly that plan:
 *   sudo -u choreograph env DATA_DIR=/var/lib/choreograph node_modules/.bin/tsx src/billing-adjust-cli.ts \
 *        --file batch.json --apply --plan-sha256 <the digest the dry run printed>
 *
 * THE "CREDITS START" LIFT (accounts below $1.00 raised to $1.00) is the same two steps with the reviewed
 * definition that ships beside this file instead of a batch: the accounts are read from the live ledger.
 *
 *   ... src/billing-adjust-cli.ts --lift src/billing-adjust-inputs/credits-start-lift.json
 *   ... src/billing-adjust-cli.ts --lift src/billing-adjust-inputs/credits-start-lift.json \
 *        --apply --plan-sha256 <the digest the dry run printed>
 *
 * FUNDING A HOUSE PROBE ACCOUNT is a batch with one `operator_funding` row per probe account (the gate has NO
 * exemption by account: a probe is funded, never excused). The account id is the Cognito sub:
 *
 *   { "schema": "sophia.credit-adjustment-batch.v1", "batch": "probe-funding-1", "actor": "operator:ada",
 *     "adjustments": [ { "label": "house-probe", "userId": "<the probe's sub>", "amountMicroUsd": 2000000,
 *                        "kind": "operator_funding", "reason": "Test funding for acceptance runs" } ] }
 *
 * Options: `--db <path>` (default `$DATA_DIR/billing.sqlite`), `--allow-new-accounts` (a batch only), `--allow-large`.
 * stdout is one JSON document (the plan, or the receipts); stderr is for people. Exit 0: done or plan clean;
 * 1: the plan is blocked or the reviewed digest no longer matches; 2: the command or the batch is wrong.
 * It opens the ledger the service holds open (WAL: the store contends for the writer lock and retries), and it
 * never creates a database and never starts a snapshot.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AdjustmentBatch,
	AdjustmentBatchError,
	type AdjustmentPlan,
	AdjustmentRefusal,
	applyAdjustments,
	applyLift,
	type LiftDefinition,
	type LiftPlan,
	parseAdjustmentBatch,
	parseLiftDefinition,
	planAdjustments,
	planLift,
} from "./billing-adjust.js";
import { BillingStore } from "./billing-store.js";

export interface CliIo {
	stdout(text: string): void;
	stderr(text: string): void;
}

interface CliArgs {
	/** What to run: a batch of explicit rows, or the reviewed lift definition. */
	readonly input: { readonly kind: "batch" | "lift"; readonly path: string };
	readonly db: string;
	readonly apply: boolean;
	readonly planSha256: string | undefined;
	readonly allowNewAccounts: boolean;
	readonly allowLarge: boolean;
}

class UsageError extends Error {}

const USAGE = `usage: billing-adjust-cli (--file <batch.json> | --lift <definition.json>) [--db <billing.sqlite>] [--apply --plan-sha256 <digest>] [--allow-new-accounts] [--allow-large]
  --file: a batch of explicit adjustments
  --lift: the reviewed lift definition: every account below its bar is raised to it, read from the live ledger
  dry run (default): print the plan and its digest, change nothing
  --apply: apply exactly the plan whose digest you reviewed (--plan-sha256 is required)`;

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): CliArgs {
	let file: string | undefined;
	let lift: string | undefined;
	let db: string | undefined;
	let apply = false;
	let planSha256: string | undefined;
	let allowNewAccounts = false;
	let allowLarge = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const value = (): string => {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) throw new UsageError(`${arg} needs a value`);
			i += 1;
			return next;
		};
		if (arg === "--file") file = value();
		else if (arg === "--lift") lift = value();
		else if (arg === "--db") db = value();
		else if (arg === "--plan-sha256") planSha256 = value();
		else if (arg === "--apply") apply = true;
		else if (arg === "--allow-new-accounts") allowNewAccounts = true;
		else if (arg === "--allow-large") allowLarge = true;
		else throw new UsageError(`unknown argument ${arg}`);
	}
	if (file !== undefined && lift !== undefined) throw new UsageError("give --file or --lift, not both");
	if (file === undefined && lift === undefined) throw new UsageError("--file or --lift is required");
	if (lift !== undefined && allowNewAccounts) {
		throw new UsageError(
			"--allow-new-accounts means nothing with --lift (a lift only raises accounts the ledger already has)",
		);
	}
	const dataDir = env.DATA_DIR?.trim();
	const dbPath = db ?? (dataDir ? join(dataDir, "billing.sqlite") : undefined);
	if (!dbPath) throw new UsageError("--db is required when DATA_DIR is not set");
	if (apply && !planSha256) {
		throw new UsageError(
			"--apply needs --plan-sha256 <the digest the dry run printed>: an apply names what was reviewed",
		);
	}
	if (!apply && planSha256) throw new UsageError("--plan-sha256 belongs with --apply");
	if (planSha256 !== undefined && !/^[0-9a-f]{64}$/.test(planSha256)) {
		throw new UsageError("--plan-sha256 must be 64 lowercase hex digits");
	}
	const input =
		lift !== undefined
			? ({ kind: "lift", path: resolve(lift) } as const)
			: ({ kind: "batch", path: resolve(file ?? "") } as const);
	return { input, db: resolve(dbPath), apply, planSha256, allowNewAccounts, allowLarge };
}

/** What the script was asked to run, once its input has been read and checked. */
type Job =
	| { readonly kind: "batch"; readonly batch: AdjustmentBatch }
	| { readonly kind: "lift"; readonly definition: LiftDefinition };

const dollars = (microUsd: number): string => `$${(microUsd / 1_000_000).toFixed(2)}`;

function describePlan(plan: AdjustmentPlan | LiftPlan): string {
	const lines = [
		"lift" in plan
			? `lift ${plan.batch} by ${plan.actor}: accounts below ${dollars(plan.lift.toMicroUsd)} raised to it, ${plan.rows.length} row(s), ${plan.totalMicroUsd} micro-USD to apply`
			: `batch ${plan.batch} by ${plan.actor}: ${plan.rows.length} row(s), ${plan.totalMicroUsd} micro-USD to apply`,
	];
	for (const row of plan.rows) {
		lines.push(
			`  ${row.status.padEnd(15)} ${row.key}  ${row.userId}  ${row.amountMicroUsd >= 0 ? "+" : ""}${row.amountMicroUsd}  ${row.kind}  ` +
				`${row.balanceBeforeMicroUsd ?? "(no account)"} -> ${row.balanceAfterMicroUsd}  "${row.reason}"`,
		);
	}
	for (const problem of plan.blocking) lines.push(`  BLOCKING: ${problem}`);
	if ("lift" in plan) {
		lines.push(
			"  the digest binds who is lifted and the rule, not the amounts: each account is raised to the bar from its balance when the apply runs",
		);
	}
	lines.push(`  plan sha256 ${plan.planSha256}`);
	return `${lines.join("\n")}\n`;
}

export async function runAdjustCli(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
	let args: CliArgs;
	let job: Job;
	let noun: "batch" | "definition" = "batch";
	try {
		args = parseArgs(argv, env);
		noun = args.input.kind === "lift" ? "definition" : "batch";
		if (!existsSync(args.db)) {
			throw new UsageError(`the database ${args.db} does not exist (this script never creates one)`);
		}
		if (!existsSync(args.input.path)) throw new UsageError(`the ${noun} file ${args.input.path} does not exist`);
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(args.input.path, "utf8"));
		} catch (error) {
			throw new UsageError(
				`the ${noun} file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		job =
			args.input.kind === "lift"
				? { kind: "lift", definition: parseLiftDefinition(raw) }
				: { kind: "batch", batch: parseAdjustmentBatch(raw) };
	} catch (error) {
		if (error instanceof UsageError) {
			io.stderr(`${error.message}\n${USAGE}\n`);
			return 2;
		}
		if (error instanceof AdjustmentBatchError) {
			io.stderr(`${error.problems.map((problem) => `  ${problem}`).join("\n")}\nthe ${noun} is not valid\n`);
			return 2;
		}
		throw error;
	}

	const store = new BillingStore(args.db);
	try {
		const options = { allowNewAccounts: args.allowNewAccounts, allowLarge: args.allowLarge };
		if (!args.apply) {
			// The dry run reads and never initialises: `init()` is DDL, and a dry run writes nothing at all.
			const plan =
				job.kind === "lift"
					? await planLift(store, job.definition, options)
					: await planAdjustments(store, job.batch, options);
			io.stderr(describePlan(plan));
			io.stdout(`${JSON.stringify({ mode: "dry-run", ...plan }, null, 2)}\n`);
			return plan.blocking.length > 0 ? 1 : 0;
		}
		await store.init();
		const applyOptions = { ...options, expectedPlanSha256: args.planSha256 ?? "" };
		const { plan, receipts } =
			job.kind === "lift"
				? await applyLift(store, job.definition, applyOptions)
				: await applyAdjustments(store, job.batch, applyOptions);
		const applied = receipts.filter((receipt) => receipt.applied).length;
		io.stderr(`applied ${applied} of ${receipts.length} row(s) of ${job.kind} ${plan.batch}\n`);
		io.stdout(
			`${JSON.stringify({ mode: "apply", batch: plan.batch, actor: plan.actor, planSha256: plan.planSha256, receipts }, null, 2)}\n`,
		);
		return 0;
	} catch (error) {
		if (error instanceof AdjustmentRefusal) {
			io.stderr(`refused:\n${error.problems.map((problem) => `  ${problem}`).join("\n")}\n`);
			return 1;
		}
		throw error;
	} finally {
		store.close();
	}
}

const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
	runAdjustCli(process.argv.slice(2), process.env, {
		stdout: (text) => {
			process.stdout.write(text);
		},
		stderr: (text) => {
			process.stderr.write(text);
		},
	}).then(
		(code) => process.exit(code),
		(error) => {
			process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
			process.exit(1);
		},
	);
}
