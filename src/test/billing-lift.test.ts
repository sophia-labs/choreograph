/**
 * The "credits start" lift (Vera, 2026-10-03): just before the flip, every account below $1.00 is lifted to
 * $1.00, as an operator batch through the adjustment script, dry run first. The definition ships REVIEWED in
 * `src/billing-adjust-inputs/credits-start-lift.json`; WHO it touches is read from the live ledger when it runs
 * (the repository cannot know who has spent), so the plan is the operator's to read. Not run by anything here
 * but these tests, on throwaway ledgers.
 *
 * Against a REAL `billing.sqlite` that this process also holds open (as the service does), through the REAL
 * command line in a child process where the operator's path is the point, NO MOCKS:
 *
 *  - exactly the accounts below the bar are listed, in a stable order, with what each is lifted by (an overdraft
 *    observe let through is lifted too; an account AT the bar, above it or never seen is not touched);
 *  - a dry run writes nothing;
 *  - the digest binds WHO is lifted and the rule (reason, kind, target), not the balances: a lift's amounts ARE
 *    balances, people chat while an operator reads, and a digest that bound them could never be applied on a
 *    live box. The apply lifts to exactly $1.00 from the balance at the moment it runs;
 *  - one gift per account: a second run lifts no one, and a lifted account that spent again is not lifted twice;
 *  - an account that crosses the bar between the review and the apply is a different plan: refused, nothing moves;
 *  - the batch guards ($100 a row, $1,000 a batch) hold for a lift as for any batch.
 *
 * RUN:  npx tsx --test src/test/billing-lift.test.ts
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as adjust from "../billing-adjust.js";
import { FREE_TIER_BALANCE_MICRO_USD } from "../billing-pricing.js";
import { readCreditHistory } from "../billing-read.js";
import type { BillingStore } from "../billing-store.js";
import { drainTo, openBilling, seedBalance } from "./billing-ledger-fixture.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const CLI = join(ROOT, "src/billing-adjust-cli.ts");
const SHIPPED = join(ROOT, "src/billing-adjust-inputs/credits-start-lift.json");

const BATCH = "credits-start-lift";
const REASON = "Credits start: your balance was raised to $1.00";

const rawDefinition = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	schema: "sophia.credit-lift.v1",
	batch: BATCH,
	actor: "script:credits-start-lift",
	kind: "goodwill",
	liftToMicroUsd: 1_000_000,
	reason: REASON,
	sourceRef: "credits-start",
	...over,
});

describe("the shipped definition is the reviewed input", () => {
	it("parses, and says what Vera decided: accounts below $1.00 are lifted to $1.00, goodwill, once", () => {
		const shipped = JSON.parse(readFileSync(SHIPPED, "utf8"));
		const parsed = adjust.parseLiftDefinition(shipped);
		assert.deepEqual(parsed, {
			schema: "sophia.credit-lift.v1",
			batch: "credits-start-lift",
			actor: "script:credits-start-lift",
			kind: "goodwill",
			liftToMicroUsd: 1_000_000,
			reason: REASON,
			sourceRef: "credits-start",
		});
		assert.equal(parsed.liftToMicroUsd, FREE_TIER_BALANCE_MICRO_USD, "the bar is the starter credit");
	});
});

describe("a definition is checked as a batch is: every problem at once, nothing guessed", () => {
	const problemsOf = (value: unknown): readonly string[] => {
		try {
			adjust.parseLiftDefinition(value);
		} catch (error) {
			assert.ok(error instanceof adjust.AdjustmentBatchError, String(error));
			return error.problems;
		}
		return [];
	};

	it("accepts the reviewed shape and the optional source reference being absent", () => {
		assert.deepEqual(problemsOf(rawDefinition()), []);
		const { sourceRef: _unused, ...withoutSource } = rawDefinition();
		assert.deepEqual(problemsOf(withoutSource), []);
		assert.equal(adjust.parseLiftDefinition(withoutSource).sourceRef, undefined);
	});

	it("refuses unknown keys (a typo must not become a silent default), a wrong schema and a malformed batch id or actor", () => {
		const found = problemsOf(
			rawDefinition({ liftTo: 5, schema: "sophia.credit-adjustment-batch.v1", batch: "Bad Batch", actor: "ada" }),
		);
		assert.match(found.join("\n"), /unknown (definition )?field liftTo/);
		assert.match(found.join("\n"), /schema must be sophia\.credit-lift\.v1/);
		assert.match(found.join("\n"), /batch must be/);
		assert.match(found.join("\n"), /actor must be operator:<name> or script:<name>/);
		assert.ok(found.length >= 4, `all problems at once, got ${JSON.stringify(found)}`);
		assert.deepEqual(problemsOf("not an object"), ["the definition must be a JSON object"]);
		assert.deepEqual(problemsOf([]), ["the definition must be a JSON object"]);
	});

	it("refuses a target that is not a positive whole number of micro-dollars", () => {
		for (const liftToMicroUsd of [0, -1, 1.5, "1000000", null, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
			const found = problemsOf(rawDefinition({ liftToMicroUsd }));
			assert.match(found.join("\n"), /liftToMicroUsd must be a positive whole number/, String(liftToMicroUsd));
		}
		const { liftToMicroUsd: _absent, ...withoutTarget } = rawDefinition();
		assert.match(problemsOf(withoutTarget).join("\n"), /liftToMicroUsd must be a positive whole number/);
	});

	it("only lifts: a kind that takes credit back is refused, and a reason is required (the person reads it)", () => {
		for (const kind of ["refund", "dispute", "nonsense", 7]) {
			assert.match(
				problemsOf(rawDefinition({ kind })).join("\n"),
				/kind must be goodwill or operator_funding/,
				String(kind),
			);
		}
		assert.deepEqual(problemsOf(rawDefinition({ kind: "operator_funding" })), []);
		assert.match(problemsOf(rawDefinition({ reason: "   " })).join("\n"), /reason is required/);
		assert.match(problemsOf(rawDefinition({ reason: "x".repeat(501) })).join("\n"), /reason is required/);
		assert.match(problemsOf(rawDefinition({ sourceRef: "x".repeat(201) })).join("\n"), /sourceRef must be text/);
	});
});

describe("the lift: accounts below $1.00 are lifted to $1.00, reviewed first", () => {
	let dir = "";
	let billing: BillingStore;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "credit-lift-"));
		billing = await openBilling(dir);
	});
	afterEach(() => {
		billing.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const dbPath = () => join(dir, "billing.sqlite");
	const definition = (over: Record<string, unknown> = {}) => adjust.parseLiftDefinition(rawDefinition(over));

	function definitionFile(over: Record<string, unknown> = {}): string {
		const path = join(dir, "lift.json");
		writeFileSync(path, JSON.stringify(rawDefinition(over)));
		return path;
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
	const dry = (file: string, extra: string[] = []) => cli(["--db", dbPath(), "--lift", file, ...extra]);
	const apply = (file: string, sha: string, extra: string[] = []) =>
		cli(["--db", dbPath(), "--lift", file, "--apply", "--plan-sha256", sha, ...extra]);

	async function fund(userId: string, amountMicroUsd: number): Promise<void> {
		await billing.recordCreditAdjustment({
			adjustmentId: `fund:${userId}:${amountMicroUsd}`,
			userId,
			amountMicroUsd,
			kind: "operator_funding",
			reason: "Test funding",
			actor: "script:test",
		});
	}

	/** Three accounts below the bar (one overdrawn), one AT it, one above it, one the ledger has never seen. */
	async function seedPeople(): Promise<void> {
		await seedBalance(billing, "acct-a", 400_000);
		await seedBalance(billing, "acct-b", 999_999);
		await drainTo(billing, "acct-c", -200_000, "c");
		await seedBalance(billing, "acct-d", 1_000_000);
		await fund("acct-e", 2_000_000);
	}
	const balanceOf = async (userId: string) => (await billing.getCredit(userId))?.balanceMicroUsd;

	it("a dry run lists exactly the accounts below the bar with what each is lifted by, and writes nothing", async () => {
		await seedPeople();
		assert.equal(await balanceOf("acct-d"), 1_000_000, "the fixture has an account exactly at the bar");
		assert.equal(await balanceOf("acct-e"), 3_000_000);
		assert.equal(await balanceOf("acct-c"), -200_000);

		const run = dry(definitionFile());
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.json.mode, "dry-run");
		assert.equal(run.json.schema, "sophia.credit-lift-plan.v1");
		assert.deepEqual(run.json.lift, { toMicroUsd: 1_000_000, kind: "goodwill" });
		assert.equal(run.json.batch, BATCH);
		assert.equal(run.json.actor, "script:credits-start-lift");
		assert.match(run.json.planSha256, /^[0-9a-f]{64}$/);
		assert.deepEqual(run.json.blocking, []);
		assert.deepEqual(
			run.json.rows.map((r: any) => [
				r.key,
				r.userId,
				r.status,
				r.account,
				r.kind,
				r.balanceBeforeMicroUsd,
				r.amountMicroUsd,
				r.balanceAfterMicroUsd,
			]),
			[
				[`ops:${BATCH}:lift-acct-a`, "acct-a", "new", "existing", "goodwill", 400_000, 600_000, 1_000_000],
				[`ops:${BATCH}:lift-acct-b`, "acct-b", "new", "existing", "goodwill", 999_999, 1, 1_000_000],
				[`ops:${BATCH}:lift-acct-c`, "acct-c", "new", "existing", "goodwill", -200_000, 1_200_000, 1_000_000],
			],
			"in account order; the overdrawn account is lifted to the bar too; at, above and unseen are not listed",
		);
		assert.equal(run.json.totalMicroUsd, 1_800_001);
		assert.equal(run.json.rows[0].reason, REASON);
		assert.equal(run.json.rows[0].sourceRef, "credits-start");

		assert.deepEqual(await billing.listCreditAdjustments({ batchId: BATCH }), [], "a dry run wrote nothing");
		assert.equal(await balanceOf("acct-a"), 400_000);
		assert.equal(await balanceOf("acct-b"), 999_999);
		assert.equal(await balanceOf("acct-c"), -200_000);
		assert.equal(await balanceOf("acct-f"), undefined, "the dry run did not even meet the account nobody has seen");
	});

	it("the digest binds who is lifted and the rule, not the balances people move meanwhile", async () => {
		await seedPeople();
		const first = await adjust.planLift(billing, definition());
		await drainTo(billing, "acct-a", 100_000, "meanwhile");
		const second = await adjust.planLift(billing, definition());
		assert.equal(first.planSha256, second.planSha256, "a chat spent money between the two reads");
		assert.equal(first.rows[0].amountMicroUsd, 600_000);
		assert.equal(second.rows[0].amountMicroUsd, 900_000, "the amount follows the balance");
		assert.equal(second.rows[0].balanceAfterMicroUsd, 1_000_000);

		const reworded = await adjust.planLift(billing, definition({ reason: `${REASON} (edited)` }));
		assert.notEqual(reworded.planSha256, second.planSha256, "the reason is what the person reads: it is reviewed");
		const retargeted = await adjust.planLift(billing, definition({ liftToMicroUsd: 2_000_000 }));
		assert.notEqual(retargeted.planSha256, second.planSha256, "another bar is another plan");
		const refiled = await adjust.planLift(billing, definition({ sourceRef: "somewhere-else" }));
		assert.notEqual(refiled.planSha256, second.planSha256);
		const renamed = await adjust.planLift(billing, definition({ batch: "another-batch" }));
		assert.notEqual(renamed.planSha256, second.planSha256, "a batch id is the idempotency key");
		const otherActor = await adjust.planLift(billing, definition({ actor: "operator:ada" }));
		assert.notEqual(otherActor.planSha256, second.planSha256);

		await drainTo(billing, "acct-d", 900_000, "falls-below");
		const joined = await adjust.planLift(billing, definition());
		assert.deepEqual(
			joined.rows.map((r) => r.userId),
			["acct-a", "acct-b", "acct-c", "acct-d"],
		);
		assert.notEqual(
			joined.planSha256,
			second.planSha256,
			"an account that fell below the bar is lifted: a different plan",
		);

		await fund("acct-b", 1_000_000);
		const left = await adjust.planLift(billing, definition());
		assert.deepEqual(
			left.rows.map((r) => r.userId),
			["acct-a", "acct-c", "acct-d"],
		);
		assert.notEqual(
			left.planSha256,
			joined.planSha256,
			"an account that rose above the bar is not: a different plan",
		);
	});

	it("an apply of the reviewed digest lifts each listed account to exactly $1.00 and no one else, and it shows in their history", async () => {
		await seedPeople();
		const path = definitionFile();
		const reviewed = dry(path);
		assert.equal(reviewed.status, 0, reviewed.stderr);
		const applied = apply(path, reviewed.json.planSha256);
		assert.equal(applied.status, 0, applied.stderr);
		assert.equal(applied.json.mode, "apply");
		assert.equal(applied.json.planSha256, reviewed.json.planSha256);
		assert.deepEqual(
			applied.json.receipts.map((r: any) => [r.key, r.amountMicroUsd, r.applied, r.balanceAfterMicroUsd]),
			[
				[`ops:${BATCH}:lift-acct-a`, 600_000, true, 1_000_000],
				[`ops:${BATCH}:lift-acct-b`, 1, true, 1_000_000],
				[`ops:${BATCH}:lift-acct-c`, 1_200_000, true, 1_000_000],
			],
		);
		for (const id of ["acct-a", "acct-b", "acct-c", "acct-d"]) assert.equal(await balanceOf(id), 1_000_000, id);
		assert.equal(await balanceOf("acct-e"), 3_000_000, "above the bar: untouched");
		assert.equal(await balanceOf("acct-f"), undefined, "never seen: still never seen");
		assert.deepEqual(
			(await billing.listCreditAdjustments({ batchId: BATCH })).map((a) => a.userId),
			["acct-a", "acct-b", "acct-c"],
			"one movement per lifted account and nothing for the others",
		);

		const record = await billing.getCreditAdjustment(`ops:${BATCH}:lift-acct-a`);
		assert.equal(record?.actor, "script:credits-start-lift");
		assert.equal(record?.batchId, BATCH);
		assert.equal(record?.kind, "goodwill");
		assert.equal(record?.reason, REASON);
		assert.equal(record?.sourceRef, "credits-start");
		assert.equal(record?.amountMicroUsd, 600_000);

		const history = await readCreditHistory(billing, "acct-a", { limit: 10 });
		assert.equal(history.items[0].kind, "adjustment");
		assert.equal(history.items[0].label, "Credits added by Sophia");
		assert.equal(history.items[0].amountMicroUsd, 600_000);
		assert.equal(history.items[0].reason, REASON);
	});

	it("an apply names the digest it reviewed: none is a usage error, a stale one is refused, and nothing moves", async () => {
		await seedPeople();
		const path = definitionFile();
		const noDigest = cli(["--db", dbPath(), "--lift", path, "--apply"]);
		assert.equal(noDigest.status, 2, noDigest.stderr);
		assert.match(noDigest.stderr, /--plan-sha256/);
		const stale = apply(path, "0".repeat(64));
		assert.equal(stale.status, 1, stale.stderr);
		assert.match(stale.stderr, /does not match/);
		assert.deepEqual(await billing.listCreditAdjustments({ batchId: BATCH }), []);
		assert.equal(await balanceOf("acct-a"), 400_000);
	});

	it("balances that move between the dry run and the apply do not stale the plan, and the lift still lands on exactly $1.00", async () => {
		await seedPeople();
		const path = definitionFile();
		const reviewed = dry(path);
		assert.equal(reviewed.json.rows[0].amountMicroUsd, 600_000);
		await drainTo(billing, "acct-a", 100_000, "while-the-operator-read");
		await drainTo(billing, "acct-c", -250_000, "while-the-operator-read");
		const applied = apply(path, reviewed.json.planSha256);
		assert.equal(applied.status, 0, applied.stderr);
		assert.equal(await balanceOf("acct-a"), 1_000_000, "lifted from where it was when the apply ran");
		assert.equal(await balanceOf("acct-c"), 1_000_000);
		assert.equal((await billing.getCreditAdjustment(`ops:${BATCH}:lift-acct-a`))?.amountMicroUsd, 900_000);
		assert.equal((await billing.getCreditAdjustment(`ops:${BATCH}:lift-acct-c`))?.amountMicroUsd, 1_250_000);
		assert.equal(applied.json.receipts[0].amountMicroUsd, 900_000);
	});

	it("an account that crosses the bar between the review and the apply is a different plan: refused, nothing moves", async () => {
		await seedPeople();
		const reviewed = await adjust.planLift(billing, definition());
		await drainTo(billing, "acct-d", 900_000, "crossed-the-bar");
		await assert.rejects(
			adjust.applyLift(billing, definition(), { expectedPlanSha256: reviewed.planSha256 }),
			(error: unknown) => error instanceof adjust.AdjustmentRefusal && /does not match/.test(error.message),
		);
		assert.deepEqual(await billing.listCreditAdjustments({ batchId: BATCH }), []);
		assert.equal(await balanceOf("acct-a"), 400_000, "the clean rows were not applied either");
		assert.equal(await balanceOf("acct-d"), 900_000);

		const again = await adjust.planLift(billing, definition());
		const done = await adjust.applyLift(billing, definition(), { expectedPlanSha256: again.planSha256 });
		assert.equal(done.receipts.length, 4);
		assert.equal(await balanceOf("acct-d"), 1_000_000);
	});

	it("one gift per account: a second run lifts no one, and a lifted account that spent again is shown as applied, not lifted twice", async () => {
		await seedPeople();
		const first = await adjust.planLift(billing, definition());
		await adjust.applyLift(billing, definition(), { expectedPlanSha256: first.planSha256 });

		const idle = await adjust.planLift(billing, definition());
		assert.deepEqual(idle.rows, [], "everyone is at the bar: nothing below it");
		assert.equal(idle.totalMicroUsd, 0);

		await drainTo(billing, "acct-a", 500_000, "spent-again");
		const spent = await adjust.planLift(billing, definition());
		assert.deepEqual(
			spent.rows.map((r) => [r.userId, r.status, r.amountMicroUsd, r.balanceBeforeMicroUsd, r.balanceAfterMicroUsd]),
			[["acct-a", "already_applied", 600_000, 500_000, 500_000]],
			"the recorded gift, not a new one: its balance stays where it is",
		);
		assert.equal(spent.totalMicroUsd, 0);
		assert.deepEqual(spent.blocking, []);

		const done = await adjust.applyLift(billing, definition(), { expectedPlanSha256: spent.planSha256 });
		assert.deepEqual(
			done.receipts.map((r) => [r.userId, r.applied, r.balanceAfterMicroUsd]),
			[["acct-a", false, 500_000]],
		);
		assert.equal(await balanceOf("acct-a"), 500_000, "no second gift");
		assert.equal((await billing.listCreditAdjustments({ userId: "acct-a", batchId: BATCH })).length, 1);
	});

	it("an empty plan is a clean plan: nothing is below the bar, and applying it does nothing", async () => {
		await fund("acct-rich", 4_000_000);
		const path = definitionFile();
		const reviewed = dry(path);
		assert.equal(reviewed.status, 0, reviewed.stderr);
		assert.deepEqual(reviewed.json.rows, []);
		assert.equal(reviewed.json.totalMicroUsd, 0);
		const done = apply(path, reviewed.json.planSha256);
		assert.equal(done.status, 0, done.stderr);
		assert.deepEqual(done.json.receipts, []);
		assert.deepEqual(await billing.listCreditAdjustments({ batchId: BATCH }), []);
	});

	it("the batch guards hold for a lift: more than $100 a row or $1,000 a batch is blocking unless the operator says so", async () => {
		await drainTo(billing, "acct-zero", 0, "to-zero");
		const huge = definition({ liftToMicroUsd: 150_000_000 });
		const row = await adjust.planLift(billing, huge);
		assert.match(row.blocking.join(" "), /exceeds \$100/);
		await assert.rejects(
			adjust.applyLift(billing, huge, { expectedPlanSha256: row.planSha256 }),
			(error: unknown) => error instanceof adjust.AdjustmentRefusal,
		);
		assert.equal(await balanceOf("acct-zero"), 0, "refused: nothing moved");
		const allowed = await adjust.planLift(billing, huge, { allowLarge: true });
		assert.deepEqual(allowed.blocking, []);

		for (let i = 0; i < 20; i += 1) await drainTo(billing, `acct-batch-${String(i).padStart(2, "0")}`, 0, "to-zero");
		const wide = definition({ liftToMicroUsd: 50_000_000 });
		const batch = await adjust.planLift(billing, wide);
		assert.equal(batch.rows.length, 21);
		assert.equal(batch.totalMicroUsd, 21 * 50_000_000);
		assert.match(batch.blocking.join(" "), /more than \$1000/);
		assert.deepEqual((await adjust.planLift(billing, wide, { allowLarge: true })).blocking, []);
	});

	it("an account id that cannot be a clean key is keyed by a hash of it: lifted once, never refused", async () => {
		const odd = "Google_1044:Mixed/Case";
		await seedBalance(billing, odd, 250_000);
		const plan = await adjust.planLift(billing, definition());
		assert.equal(plan.rows.length, 1);
		assert.equal(plan.rows[0].userId, odd);
		assert.match(plan.rows[0].key, new RegExp(`^ops:${BATCH}:lift-x[0-9a-f]{32}$`));
		const done = await adjust.applyLift(billing, definition(), { expectedPlanSha256: plan.planSha256 });
		assert.equal(done.receipts[0].applied, true);
		assert.equal(await balanceOf(odd), 1_000_000);
		assert.equal((await adjust.planLift(billing, definition())).rows.length, 0);
	});

	it("is the script's own refusals: a definition and a batch together, neither, a flag that means nothing here, a bad file", async () => {
		const path = definitionFile();
		const batchPath = join(dir, "batch.json");
		writeFileSync(
			batchPath,
			JSON.stringify({
				schema: "sophia.credit-adjustment-batch.v1",
				batch: "b1",
				actor: "operator:ada",
				adjustments: [{ label: "x", userId: "acct-a", amountMicroUsd: 1_000, kind: "goodwill", reason: "r" }],
			}),
		);
		const both = cli(["--db", dbPath(), "--lift", path, "--file", batchPath]);
		assert.equal(both.status, 2, both.stderr);
		assert.match(both.stderr, /--file or --lift/);
		const neither = cli(["--db", dbPath()]);
		assert.equal(neither.status, 2, neither.stderr);
		assert.match(neither.stderr, /--file or --lift/);
		const meaningless = dry(path, ["--allow-new-accounts"]);
		assert.equal(meaningless.status, 2, meaningless.stderr);
		assert.match(meaningless.stderr, /--allow-new-accounts/);
		const missing = cli(["--db", dbPath(), "--lift", join(dir, "nowhere.json")]);
		assert.equal(missing.status, 2, missing.stderr);
		assert.match(missing.stderr, /does not exist/);
		const badPath = definitionFile({ liftToMicroUsd: 0, kind: "refund", reason: "" });
		const bad = dry(badPath);
		assert.equal(bad.status, 2, bad.stderr);
		assert.match(bad.stderr, /liftToMicroUsd must be a positive whole number/);
		assert.match(bad.stderr, /kind must be goodwill or operator_funding/);
		assert.match(bad.stderr, /reason is required/);
		assert.match(bad.stderr, /the definition is not valid/);
		assert.deepEqual(await billing.listCreditAdjustments({}), [], "none of it touched the ledger");
	});
});
