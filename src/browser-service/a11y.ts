/**
 * Accessibility helpers for the browser service.
 *
 * ariaSnapshot (Playwright's built-in YAML AX tree) is the primary a11y surface.
 * Refs are short-lived opaque tokens valid within one snapshot epoch. Any DOM change
 * (navigation, act) invalidates the previous epoch's refs. The ref map is stored on
 * the SessionRecord and replaced on every snapshot call.
 *
 * Snapshot refs use a simple scheme: we enumerate all interactable nodes in the
 * snapshot by asking Playwright for role+name locators, assign them a stable token
 * (role:name), and store the Locator so we can act on them by token.
 */

import type { Locator, Page } from "playwright";
import type { SessionRecord } from "./types.js";

const INTERACTABLE_ROLES = [
	"button",
	"link",
	"textbox",
	"combobox",
	"checkbox",
	"radio",
	"menuitem",
	"option",
	"tab",
	"searchbox",
	"spinbutton",
	"switch",
	"slider",
] as const;

/**
 * Capture the a11y snapshot for the session's active page.
 * Updates session.lastSnapshotRefs with fresh Locators.
 * Returns { snapshot: YAML string, refs: Record<token, token> }.
 */
export async function captureSnapshot(session: SessionRecord): Promise<{
	snapshot: string;
	refs: Record<string, string>;
}> {
	const { page } = session;

	// Capture the YAML AX tree
	const snapshot = await page.ariaSnapshot();

	// Rebuild refs
	const refs: Record<string, string> = {};
	session.lastSnapshotRefs.clear();

	for (const role of INTERACTABLE_ROLES) {
		const locators = await page.getByRole(role as Parameters<typeof page.getByRole>[0]).all();
		for (let i = 0; i < locators.length; i++) {
			const loc = locators[i];
			let name: string | null = null;
			try {
				name = await loc.getAttribute("aria-label");
				if (!name) {
					// Try innerText as fallback label
					name = (await loc.innerText({ timeout: 200 }).catch(() => "")) || null;
				}
			} catch {
				// best effort
			}
			const label = name ? `${role}:${name.trim().slice(0, 60)}` : `${role}#${i}`;
			// Deduplicate tokens
			const token = refs[label] ? `${label}__${i}` : label;
			refs[token] = token;
			session.lastSnapshotRefs.set(token, loc);
		}
	}

	return { snapshot, refs };
}

/**
 * Resolve a ref token to a Playwright Locator.
 * Returns null if the ref is stale or unknown.
 */
export function resolveRef(session: SessionRecord, ref: string): Locator | null {
	return session.lastSnapshotRefs.get(ref) ?? null;
}

/**
 * Perform an action on the resolved locator, then re-capture the snapshot.
 * The `changed` flag is true when the snapshot differs from the pre-action snapshot.
 */
export async function performAct(
	session: SessionRecord,
	ref: string,
	action: "click" | "type" | "select" | "press",
	value?: string,
	delayMs?: number,
): Promise<{ changed: boolean; snapshot: string; refs: Record<string, string> }> {
	const locator = resolveRef(session, ref);
	if (!locator) {
		throw new Error(`Unknown or stale ref: ${JSON.stringify(ref)}`);
	}

	// Pre-action snapshot for diffing
	const before = await session.page.ariaSnapshot().catch(() => "");

	switch (action) {
		case "click":
			await locator.click();
			break;
		case "type":
			if (value === undefined) throw new Error("value required for type action");
			if (delayMs !== undefined) {
				const delay = clampTypingDelay(delayMs ?? 35);
				await locator.fill("");
				await locator.pressSequentially(value, { delay });
			} else {
				await locator.fill(value);
			}
			break;
		case "select":
			if (value === undefined) throw new Error("value required for select action");
			await locator.selectOption(value);
			break;
		case "press":
			if (value === undefined) throw new Error("value required for press action");
			await locator.press(value);
			break;
	}

	// Wait for potential navigation / animations to settle
	await session.page.waitForLoadState("domcontentloaded").catch(() => {});

	// Invalidate old refs and capture fresh snapshot
	const after = await captureSnapshot(session);
	const changed = after.snapshot !== before;

	return { changed, snapshot: after.snapshot, refs: after.refs };
}

function clampTypingDelay(value: number): number {
	if (!Number.isFinite(value)) throw new Error("delayMs must be a finite number");
	return Math.max(0, Math.min(250, Math.round(value)));
}

/**
 * Take a PNG screenshot of the current page (or a specific element by ref).
 * Falls back to full-page if ref is not found.
 */
export async function takeScreenshot(page: Page, session: SessionRecord, ref?: string): Promise<Buffer> {
	if (ref) {
		const locator = resolveRef(session, ref);
		if (locator) {
			try {
				return await locator.screenshot({ type: "png" });
			} catch {
				// fall through to full-page
			}
		}
	}
	return page.screenshot({ type: "png", fullPage: false });
}
