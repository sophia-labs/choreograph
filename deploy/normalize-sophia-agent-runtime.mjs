#!/usr/bin/env node
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

const [runtimeInput, packageInput] = process.argv.slice(2);
if (!runtimeInput || !packageInput) {
	throw new Error("usage: normalize-sophia-agent-runtime.mjs <runtime-root> <package-root>");
}

const runtimeRoot = realpathSync(runtimeInput);
const packageRoot = realpathSync(packageInput);
const packageRelative = relative(runtimeRoot, packageRoot);
if (packageRelative === "" || packageRelative.startsWith(`..${sep}`) || isAbsolute(packageRelative)) {
	throw new Error("Sophia agent package root must be inside its runtime root");
}

const layouts = [
	{
		name: "@earendil-works/pi-coding-agent",
		root: packageRoot,
		required: "dist/sophia/host-worker.js",
		workspaceDependencies: [
			"@earendil-works/pi-agent-core",
			"@earendil-works/pi-ai",
			"@earendil-works/pi-tui",
		],
	},
	{
		name: "@earendil-works/pi-agent-core",
		root: join(packageRoot, "node_modules/@earendil-works/pi-agent-core"),
		required: "dist/index.js",
		workspaceDependencies: ["@earendil-works/pi-ai"],
	},
	{
		name: "@earendil-works/pi-ai",
		root: join(packageRoot, "node_modules/@earendil-works/pi-ai"),
		required: "dist/index.js",
		workspaceDependencies: [],
	},
	{
		name: "@earendil-works/pi-tui",
		root: join(packageRoot, "node_modules/@earendil-works/pi-tui"),
		required: "dist/index.js",
		workspaceDependencies: [],
	},
];

const manifests = new Map();
for (const layout of layouts) {
	const manifestPath = join(layout.root, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest.name !== layout.name || typeof manifest.version !== "string" || !manifest.version) {
		throw new Error(`invalid deployed Sophia package identity: ${layout.name}`);
	}
	if (!existsSync(join(layout.root, layout.required))) {
		throw new Error(`deployed Sophia package is missing ${layout.required}: ${layout.name}`);
	}
	manifests.set(layout.name, { manifest, manifestPath });
}

for (const layout of layouts) {
	const entry = manifests.get(layout.name);
	for (const dependency of layout.workspaceDependencies) {
		if (typeof entry.manifest.dependencies?.[dependency] !== "string") {
			throw new Error(`deployed Sophia package is missing workspace dependency: ${dependency}`);
		}
		entry.manifest.dependencies[dependency] = `^${manifests.get(dependency).manifest.version}`;
	}
	writeFileSync(entry.manifestPath, `${JSON.stringify(entry.manifest, null, 2)}\n`);
}

rmSync(join(packageRoot, "pnpm-lock.yaml"), { force: true });
rmSync(join(packageRoot, "node_modules/.modules.yaml"), { force: true });
rmSync(join(packageRoot, "node_modules/.pnpm/lock.yaml"), { force: true });
rmSync(join(packageRoot, "node_modules/.pnpm-workspace-state-v1.json"), { force: true });
rmSync(join(packageRoot, "dist/prime-agent-runtime"), { recursive: true, force: true });
if (existsSync(join(packageRoot, "dist/prime-agent-runtime"))) {
	throw new Error("deployed Sophia agent package retained the Prime-owned Python runtime");
}

function verifyPortableTree(directory) {
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			const target = realpathSync(path);
			if (target !== runtimeRoot && !target.startsWith(`${runtimeRoot}${sep}`)) {
				throw new Error(`Sophia runtime symlink escapes its bundle: ${path}`);
			}
		} else if (stat.isDirectory()) {
			verifyPortableTree(path);
		}
	}
}

verifyPortableTree(runtimeRoot);
console.log(
	`SOPHIA_AGENT_RUNTIME_READY packages=${layouts.map((layout) => layout.name).join(",")}`,
);
