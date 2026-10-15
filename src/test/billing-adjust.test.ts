/**
 * The operator's way to move a balance without a card (Sobremesa credits: test funding, the goodwill lift,
 * forgiveness, a refund honoured by hand): `src/billing-adjust-cli.ts`, run on the box over SSM by a person
 * who has read the plan. A REAL child process against a REAL `billing.sqlite` that this test process also holds
 * open (as the service does), NO MOCKS.
 *
 * The shape is the house's (`import_credits.py`, `GB-state`): a DRY RUN by default that prints exactly what
 * would be applied and changes nothing; one APPLY of exactly what was reviewed, named by the plan's sha256;
 * idempotent keys (`ops:<batch>:<label>`) so a repeat is a no-op; refusals that name their reason. The money
 * moves through the store's own `recordCreditAdjustment`, so the credit history and the gate see it at once.
 *
 * RUN:  npx tsx --test src/test/billing-adjust.test.ts
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CreditAdmission } from "../billing-gate.js";
import { FREE_TIER_BALANCE_MICRO_USD } from "../billing-pricing.js";
import { readCreditHistory } from "../billing-read.js";
import type { BillingStore } from "../billing-store.js";
import { drainTo, openBilling, seedBalance } from "./billing-ledger-fixture.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const CLI = join(ROOT, "src/billing-adjust-cli.ts");

interface Row {
	label: string;
	userId: string;
	amountMicroUsd: number;
	kind: string;
	reason: string;
	sourceRef?: string;
}

describe("the adjustment script: a dry run first, then one apply of exactly what was reviewed", () => {
	let dir = "";
	let billing: BillingStore;
	let batchCounter = 0;

	before(async () => {
		dir = mkdtempSync(join(tmpdir(), "credit-adjust-"));
		billing = await openBilling(dir);
	});
	after(() => {
		billing.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const dbPath = () => join(dir, "billing.sqlite");

	function batchFile(rows: Row[], over: { batch?: string; actor?: string } = {}): { path: string; batch: string } {
		const batch = over.batch ?? `b${++batchCounter}`;
		const path = join(dir, `${batch}.json`);
		writeFileSync(
			path,
			JSON.stringify({
				schema: "sophia.credit-adjustment-batch.v1",
				batch,
				actor: over.actor ?? "operator:ada",
				adjustments: rows,
			}),
		);
		return { path, batch };
	}

	function cli(args: string[]) {
		const run = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
			cwd: ROOT,
			encoding: "utf8",
			env: { ...process.env, NODE_NO_WARNINGS: "1" },
		});
		let json: any;
		try {
			json = run.stdout.trim() ? JSON.parse(run.stdout) : undefined;
		} catch {
			json = undefined;
		}
		return { status: run.status, stdout: run.stdout, stderr: run.stderr, json };
	}

	const dry = (file: string, extra: string[] = []) => cli(["--db", dbPath(), "--file", file, ...extra]);
	const apply = (file: string, sha: string, extra: string[] = []) =>
		cli(["--db", dbPath(), "--file", file, "--apply", "--plan-sha256", sha, ...extra]);

	async function account(userId: string, balance: number) {
		await seedBalance(billing, userId, balance);
	}

	it("a dry run prints the plan for every row, with its digest, and changes nothing", async () => {
		await account("acct-probe", 3_800);
		const { path } = batchFile([
			{
				label: "probe",
				userId: "acct-probe",
				amountMicroUsd: 2_000_000,
				kind: "operator_funding",
				reason: "Test funding for acceptance runs",
			},
		]);
		const run = dry(path);
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.json.mode, "dry-run");
		assert.match(run.json.planSha256, /^[0-9a-f]{64}$/);
		assert.equal(run.json.totalMicroUsd, 2_000_000);
		assert.deepEqual(run.json.blocking, []);
		const [row] = run.json.rows;
		assert.equal(row.key, `ops:${run.json.batch}:probe`);
		assert.equal(row.status, "new");
		assert.equal(row.account, "existing");
		assert.equal(row.balanceBeforeMicroUsd, 3_800);
		assert.equal(row.balanceAfterMicroUsd, 2_003_800);
		assert.deepEqual(await billing.listCreditAdjustments({ userId: "acct-probe" }), [], "nothing was written");
		assert.equal((await billing.getCredit("acct-probe"))?.balanceMicroUsd, 3_800);
	});

	it("the digest binds what was reviewed, not the balances people move meanwhile", async () => {
		await account("acct-digest", 500_000);
		const rows: Row[] = [
			{ label: "d", userId: "acct-digest", amountMicroUsd: 100_000, kind: "goodwill", reason: "Credits start" },
		];
		const { path, batch } = batchFile(rows);
		const first = dry(path);
		await drainTo(billing, "acct-digest", 100_000, "digest-drain");
		const second = dry(path);
		assert.equal(first.json.planSha256, second.json.planSha256, "a chat spent money between the two reads");
		assert.notEqual(first.json.rows[0].balanceBeforeMicroUsd, second.json.rows[0].balanceBeforeMicroUsd);
		const edited = batchFile([{ ...rows[0], reason: "Credits start (edited)" }], { batch });
		assert.notEqual(dry(edited.path).json.planSha256, first.json.planSha256, "a reviewed field changed");
		const bigger = batchFile([{ ...rows[0], amountMicroUsd: 100_001 }], { batch });
		assert.notEqual(dry(bigger.path).json.planSha256, first.json.planSha256);
	});

	it("an apply needs the reviewed digest: none is a usage error, a stale one is refused, and nothing moves", async () => {
		await account("acct-gate", 3_800);
		const { path } = batchFile([
			{ label: "g", userId: "acct-gate", amountMicroUsd: 250_000, kind: "operator_funding", reason: "Funding" },
		]);
		const noDigest = cli(["--db", dbPath(), "--file", path, "--apply"]);
		assert.equal(noDigest.status, 2, noDigest.stderr);
		assert.match(noDigest.stderr, /--plan-sha256/);
		const stale = apply(path, "0".repeat(64));
		assert.equal(stale.status, 1, stale.stderr);
		assert.match(stale.stderr, /does not match/);
		assert.deepEqual(await billing.listCreditAdjustments({ userId: "acct-gate" }), []);
		assert.equal((await billing.getCredit("acct-gate"))?.balanceMicroUsd, 3_800);
	});

	it("funds a designated test account by exactly the amount, shows in its credit history, and a repeat is a no-op", async () => {
		await account("acct-funded", 3_800);
		const { path, batch } = batchFile([
			{
				label: "fund",
				userId: "acct-funded",
				amountMicroUsd: 2_000_000,
				kind: "operator_funding",
				reason: "Test funding for acceptance runs",
				sourceRef: "ticket-17",
			},
		]);
		const reviewed = dry(path);
		const applied = apply(path, reviewed.json.planSha256);
		assert.equal(applied.status, 0, applied.stderr);
		assert.equal(applied.json.mode, "apply");
		assert.deepEqual(
			applied.json.receipts.map((r: { key: string; applied: boolean; balanceAfterMicroUsd: number }) => [
				r.key,
				r.applied,
				r.balanceAfterMicroUsd,
			]),
			[[`ops:${batch}:fund`, true, 2_003_800]],
		);
		assert.equal((await billing.getCredit("acct-funded"))?.balanceMicroUsd, 2_003_800);
		const record = await billing.getCreditAdjustment(`ops:${batch}:fund`);
		assert.equal(record?.actor, "operator:ada");
		assert.equal(record?.batchId, batch);
		assert.equal(record?.sourceRef, "ticket-17");
		assert.equal(record?.kind, "operator_funding");
		const history = await readCreditHistory(billing, "acct-funded", { limit: 10 });
		assert.equal(history.items[0].kind, "adjustment");
		assert.equal(history.items[0].amountMicroUsd, 2_000_000);
		assert.equal(history.items[0].reason, "Test funding for acceptance runs");

		// The reviewed digest named a "new" row; that act has been done, so it cannot be applied again.
		const again = apply(path, reviewed.json.planSha256);
		assert.equal(again.status, 1, "the same digest is not a licence to apply twice");
		const refreshed = dry(path);
		assert.equal(refreshed.json.rows[0].status, "already_applied");
		const noop = apply(path, refreshed.json.planSha256);
		assert.equal(noop.status, 0, noop.stderr);
		assert.equal(noop.json.receipts[0].applied, false);
		assert.equal((await billing.getCredit("acct-funded"))?.balanceMicroUsd, 2_003_800, "no second credit");
	});

	it("a key reused for a different movement is a conflict: the whole batch is refused, nothing is applied", async () => {
		await account("acct-conflict", 3_800);
		await account("acct-bystander", 3_800);
		const first = batchFile(
			[{ label: "c", userId: "acct-conflict", amountMicroUsd: 100_000, kind: "goodwill", reason: "Credits start" }],
			{ batch: "conflict-batch" },
		);
		assert.equal(apply(first.path, dry(first.path).json.planSha256).status, 0);
		const clash = batchFile(
			[
				{
					label: "other",
					userId: "acct-bystander",
					amountMicroUsd: 50_000,
					kind: "goodwill",
					reason: "Credits start",
				},
				{ label: "c", userId: "acct-conflict", amountMicroUsd: 200_000, kind: "goodwill", reason: "Credits start" },
			],
			{ batch: "conflict-batch" },
		);
		const plan = dry(clash.path);
		assert.equal(plan.status, 1, "a plan with a blocking row exits non-zero");
		assert.equal(plan.json.rows[1].status, "conflict");
		assert.ok(plan.json.blocking.length > 0);
		const refused = apply(clash.path, plan.json.planSha256);
		assert.equal(refused.status, 1, refused.stderr);
		assert.deepEqual(
			await billing.listCreditAdjustments({ userId: "acct-bystander" }),
			[],
			"the clean row was not applied either",
		);
		assert.equal((await billing.getCredit("acct-conflict"))?.balanceMicroUsd, 103_800);
	});

	it("refuses a malformed batch before reading the ledger: duplicate labels, a sign that contradicts the kind", async () => {
		const duplicates = batchFile([
			{ label: "x", userId: "a", amountMicroUsd: 1_000, kind: "goodwill", reason: "r" },
			{ label: "x", userId: "b", amountMicroUsd: 1_000, kind: "goodwill", reason: "r" },
		]);
		const dup = dry(duplicates.path);
		assert.equal(dup.status, 2);
		assert.match(dup.stderr, /duplicate label/);
		for (const [kind, amountMicroUsd] of [
			["goodwill", -1_000],
			["operator_funding", -1_000],
			["refund", 1_000],
			["dispute", 1_000],
		] as const) {
			const bad = batchFile([{ label: "s", userId: "a", amountMicroUsd, kind, reason: "r" }]);
			const run = dry(bad.path);
			assert.equal(run.status, 2, `${kind} ${amountMicroUsd}`);
			assert.match(run.stderr, /must be (positive|negative)/);
		}
		const zero = batchFile([{ label: "z", userId: "a", amountMicroUsd: 0, kind: "correction", reason: "r" }]);
		assert.equal(dry(zero.path).status, 2);
		const noReason = batchFile([{ label: "n", userId: "a", amountMicroUsd: 1_000, kind: "goodwill", reason: "  " }]);
		assert.equal(dry(noReason.path).status, 2);
		const badActor = batchFile([{ label: "n", userId: "a", amountMicroUsd: 1_000, kind: "goodwill", reason: "r" }], {
			actor: "ada",
		});
		assert.equal(dry(badActor.path).status, 2);
	});

	it("a typo in the zeros or in the account is a blocking row unless the operator says so, and only then moves money", async () => {
		await account("acct-big", 3_800);
		const big = batchFile([
			{ label: "big", userId: "acct-big", amountMicroUsd: 101_000_000, kind: "operator_funding", reason: "Funding" },
		]);
		const refused = dry(big.path);
		assert.equal(refused.status, 1);
		assert.match(refused.json.blocking.join(" "), /exceeds \$100/);
		const allowed = dry(big.path, ["--allow-large"]);
		assert.equal(allowed.status, 0, allowed.stderr);

		const ghost = batchFile([
			{
				label: "ghost",
				userId: "acct-nobody",
				amountMicroUsd: 1_000_000,
				kind: "operator_funding",
				reason: "Funding",
			},
		]);
		const unknown = dry(ghost.path);
		assert.equal(unknown.status, 1);
		assert.equal(unknown.json.rows[0].account, "new");
		assert.match(unknown.json.blocking.join(" "), /no credits row/);
		const plan = dry(ghost.path, ["--allow-new-accounts"]);
		assert.equal(plan.status, 0, plan.stderr);
		assert.equal(
			plan.json.rows[0].balanceAfterMicroUsd,
			FREE_TIER_BALANCE_MICRO_USD + 1_000_000,
			"a new account starts at the $1.00 seed",
		);
		assert.equal(apply(ghost.path, plan.json.planSha256).status, 1, "the apply must name the flag too");
		const done = apply(ghost.path, plan.json.planSha256, ["--allow-new-accounts"]);
		assert.equal(done.status, 0, done.stderr);
		assert.equal((await billing.getCredit("acct-nobody"))?.balanceMicroUsd, FREE_TIER_BALANCE_MICRO_USD + 1_000_000);
	});

	it("honours a refund by hand as a negative adjustment, in the history as a refund", async () => {
		await account("acct-refund", 3_800);
		const fund = batchFile([
			{ label: "f", userId: "acct-refund", amountMicroUsd: 1_000_000, kind: "operator_funding", reason: "Funding" },
		]);
		assert.equal(apply(fund.path, dry(fund.path).json.planSha256).status, 0);
		const refund = batchFile([
			{
				label: "r",
				userId: "acct-refund",
				amountMicroUsd: -1_000_000,
				kind: "refund",
				reason: "Refunded in full at your request",
			},
		]);
		const plan = dry(refund.path);
		assert.equal(plan.json.rows[0].balanceAfterMicroUsd, 3_800 + 1_000_000 - 1_000_000);
		assert.equal(apply(refund.path, plan.json.planSha256).status, 0);
		assert.equal((await billing.getCredit("acct-refund"))?.balanceMicroUsd, 3_800);
		const history = await readCreditHistory(billing, "acct-refund", { limit: 10 });
		assert.equal(history.items[0].label, "Refund");
		assert.equal(history.items[0].amountMicroUsd, -1_000_000);
		assert.equal(history.items[0].reason, "Refunded in full at your request");
	});

	it("never creates a database: a missing file is a refusal", () => {
		const { path } = batchFile([{ label: "m", userId: "a", amountMicroUsd: 1_000, kind: "goodwill", reason: "r" }]);
		const missing = join(dir, "nowhere", "billing.sqlite");
		const run = cli(["--db", missing, "--file", path]);
		assert.equal(run.status, 2);
		assert.match(run.stderr, /does not exist/);
		assert.equal(existsSync(missing), false);
	});

	it("is the funding path the gate sees: an empty test account is refused, funded by the script it is admitted", async () => {
		await account("acct-probe-empty", 3_800);
		const gate = new CreditAdmission({ billing, mode: "enforce", log: () => {} });
		const ask = () =>
			gate.admitIngress({
				door: "ingress.invocation",
				userId: "acct-probe-empty",
				provider: "openrouter",
				model: "google/gemini-2.5-flash",
			});
		assert.equal(
			(await ask()).allow,
			false,
			"$0.0038 is below the House bar (about $0.006, at the 15% fee or the 20% one)",
		);
		const { path } = batchFile([
			{
				label: "p",
				userId: "acct-probe-empty",
				amountMicroUsd: 2_000_000,
				kind: "operator_funding",
				reason: "Test funding",
			},
		]);
		assert.equal(apply(path, dry(path).json.planSha256).status, 0);
		assert.equal((await ask()).allow, true, "the very next ask sees the funded balance");
	});
});
