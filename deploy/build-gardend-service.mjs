#!/usr/bin/env node
/**
 * Build Choreograph as gardend's local service `choreograph` (public name: Sophia Compute), bundled: the orchestrator
 * and the agent body each one ESM file, instead of a ~300 MB node_modules tree.
 *
 *   node deploy/build-gardend-service.mjs <dest> [--natives all|host|<list>]
 *
 * <dest> must not exist. What it holds:
 *
 *   service.json              gardend's manifest: `node app/main.mjs`, Node 22.19+, opt-in (`"autostart": false`)
 *   LICENSE, NOTICE           Choreograph's licence (MIT) and notice
 *   THIRD-PARTY-NOTICES.md    every bundled package: name, version, licence, and its licence text
 *   BUILD.json                the commit, pi, libSQL, esbuild and Node versions, and a sha256 of every file
 *   app/main.mjs              the orchestrator and its dependencies (esbuild)
 *   app/worker.mjs            the runtime worker the orchestrator starts for program steps (plain .mjs, copied)
 *   app/package.json          `"type": "module"`
 *   app/node_modules/@libsql/<target>/   libSQL's native binding, one per target (the only native code)
 *   body/body.mjs             the agent body: upstream pi 1.2.0 + packages/agent-body (esbuild)
 *   body/package.json         names the body (`@sophia-labs/choreograph-agent-body`); the host attests body/
 *   body/LICENSE              pi's MIT licence (pi's npm packages ship none; kept from earendil-works/pi v1.2.0)
 *
 * `--natives` picks libSQL's prebuilt bindings: `all` (default: darwin-x64, darwin-arm64, linux-x64-gnu,
 * linux-arm64-gnu, what gardend releases target; a gardend archive keeps only its own), `host` (this machine's only),
 * or a comma list. Bindings not installed here are fetched with `npm pack` at the exact version libsql pins and
 * checked against the registry's integrity by npm.
 *
 * Why bundling is safe: the orchestrator finds nothing beside its own code at run time except worker.mjs and the
 * libSQL binding (both shipped); hosted-only paths that would read files (kernels, the Python evaluator, the browser
 * service) are unreachable in local-native mode. The body gives pi everything pi would otherwise look up on disk
 * (no extensions, skills, themes, templates or context files; models and tools from the host). pi's image library
 * is left out: it is loaded only for images, which no host tool returns.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, version as esbuildVersion } from "esbuild";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BODY = join(ROOT, "packages", "agent-body");
const NODE_FLOOR = "22.19";
const RELEASE_NATIVES = ["darwin-x64", "darwin-arm64", "linux-x64-gnu", "linux-arm64-gnu"];
const BODY_PACKAGE_NAME = "@sophia-labs/choreograph-agent-body";
const PHOTON = "@silvia-odwyer/photon-node";

/** A package's directory as Node finds it from `fromDir` (its `exports` may hide `package.json`). */
function packageDir(fromDir, name) {
	let dir = realpathSync(fromDir);
	while (true) {
		const candidate = join(dir, "node_modules", ...name.split("/"));
		if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
		if (dir === dirname(dir)) throw new Error(`cannot find ${name} from ${fromDir}`);
		dir = dirname(dir);
	}
}

const libsqlClientDir = packageDir(ROOT, "@libsql/client");
const libsqlDir = packageDir(libsqlClientDir, "libsql");
const libsqlVersion = JSON.parse(readFileSync(join(libsqlDir, "package.json"), "utf8")).version;
const piDir = packageDir(BODY, "@earendil-works/pi-coding-agent");
const piVersion = JSON.parse(readFileSync(join(piDir, "package.json"), "utf8")).version;

const BANNER = {
	js: 'import { createRequire as __choreographCreateRequire } from "node:module"; const require = __choreographCreateRequire(import.meta.url);',
};

function bundleOptions(absWorkingDir, entry, outfile, external) {
	return {
		absWorkingDir,
		entryPoints: [entry],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: `node${NODE_FLOOR}`,
		// Bundled CommonJS calls require(); in an ES module it must exist (and resolve beside the bundle).
		banner: BANNER,
		external,
		minify: true,
		legalComments: "eof",
		metafile: true,
		logLevel: "warning",
	};
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function filesUnder(dir) {
	const out = [];
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...filesUnder(path));
		else out.push(path);
	}
	return out;
}

const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();

function hostNative() {
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	if (process.platform === "darwin") return `darwin-${arch}`;
	if (process.platform === "linux") return `linux-${arch}-gnu`;
	throw new Error(`no libSQL target for ${process.platform}/${process.arch}`);
}

/** The installed binding, or one fetched from the registry at libsql's own version. */
function nativeDir(target, scratch) {
	const name = `@libsql/${target}`;
	try {
		const installed = packageDir(libsqlDir, name);
		if (JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version === libsqlVersion) return installed;
	} catch {
		// not installed for this machine
	}
	const into = join(scratch, target);
	mkdirSync(into, { recursive: true });
	const tarball = execFileSync("npm", ["pack", `${name}@${libsqlVersion}`, "--silent", "--pack-destination", into], {
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.pop();
	execFileSync("tar", ["-xzf", join(into, tarball), "-C", into]);
	const dir = join(into, "package");
	const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	if (manifest.name !== name || manifest.version !== libsqlVersion) throw new Error(`npm pack ${name} gave ${manifest.name}@${manifest.version}`);
	return dir;
}

/** The package directory an input file belongs to, or null for this repository's own files. */
function packageRootOf(input) {
	const marker = `node_modules${sep}`;
	const at = input.lastIndexOf(marker);
	if (at < 0) return null;
	const rest = input.slice(at + marker.length).split(sep);
	const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
	return join(input.slice(0, at + marker.length), name);
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([.-][\w.-]*)?$/i;

/**
 * Packages whose npm tarball ships no licence text: the text from their repository at the published commit
 * (`deploy/third-party-licenses/`), or, for promise-limit, which has none anywhere, its stated ISC licence.
 */
const KEPT_LICENCES = [
	[/^@aws-sdk\//, "aws-sdk-js-v3-LICENSE"],
	[/^@libsql\/(client|core)$/, "libsql-client-ts-LICENSE"],
	[/^@libsql\/isomorphic-ws$/, "libsql-isomorphic-ts-LICENSE"],
	[/^promise-limit$/, "promise-limit-LICENSE"],
	[/^standardwebhooks$/, "standardwebhooks-LICENSE"],
];

function readmeLicence(root) {
	const readme = readdirSync(root).find((file) => /^readme(\.md|\.markdown)?$/i.test(file));
	if (!readme) return null;
	const lines = readFileSync(join(root, readme), "utf8").split("\n");
	const start = lines.findIndex(
		(line, i) => /^#*\s*licen[cs]e\s*$/i.test(line.trim()) && (line.startsWith("#") || /^[-=]{3,}$/.test(lines[i + 1]?.trim() ?? "")),
	);
	if (start < 0) return null;
	const body = [];
	for (const line of lines.slice(start + (lines[start].startsWith("#") ? 1 : 2))) {
		if (/^#/.test(line)) break;
		body.push(line);
	}
	const text = body.join("\n").trim();
	return text ? { file: `${readme} (its License section)`, text } : null;
}

/** A package's licence texts: its own files, else pi's kept text for pi's packages, else its README's section. */
function licenceTexts(root, name) {
	const texts = [];
	for (const file of readdirSync(root).sort()) {
		if (LICENCE_FILE.test(file) && statSync(join(root, file)).isFile()) texts.push({ file, text: readFileSync(join(root, file), "utf8").trim() });
	}
	if (texts.length === 0 && name.startsWith("@earendil-works/pi-")) {
		texts.push({ file: "packages/agent-body/licenses/pi-LICENSE", text: readFileSync(join(BODY, "licenses", "pi-LICENSE"), "utf8").trim() });
	}
	const kept = KEPT_LICENCES.find(([pattern]) => pattern.test(name))?.[1];
	if (texts.length === 0 && kept) {
		texts.push({ file: `deploy/third-party-licenses/${kept}`, text: readFileSync(join(ROOT, "deploy", "third-party-licenses", kept), "utf8").trim() });
	}
	if (texts.length) return texts;
	const fromReadme = readmeLicence(root);
	return fromReadme ? [fromReadme] : [];
}

function notices(roots) {
	const packages = [...new Map([...roots].map((root) => {
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		return [`${manifest.name}@${manifest.version}`, { root, manifest }];
	})).values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name) || a.manifest.version.localeCompare(b.manifest.version));
	const missing = [];
	const lines = [
		"# Third-party notices",
		"",
		"`app/` and `body/` of this service bundle the packages below with Choreograph (licensed under `LICENSE`),",
		"and `app/node_modules/@libsql/` carries libSQL's native bindings. Each keeps its own licence; its text",
		"follows, as the package ships it.",
		"",
		"| Package | Version | Licence |",
		"|---|---|---|",
		...packages.map(({ manifest }) => `| ${manifest.name} | ${manifest.version} | ${manifest.license ?? "(none stated)"} |`),
		"",
	];
	for (const { root, manifest } of packages) {
		const texts = licenceTexts(root, manifest.name);
		lines.push(`## ${manifest.name} ${manifest.version}`, "", `Licence: ${manifest.license ?? "(none stated)"}`);
		const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
		if (repository) lines.push(`Source: ${repository}`);
		lines.push("");
		if (texts.length === 0) {
			missing.push(`${manifest.name}@${manifest.version} (${manifest.license ?? "no licence field"})`);
			lines.push("The package ships no licence file; its licence is the one named above.", "");
		}
		for (const { file, text } of texts) lines.push(`### ${file}`, "", "````text", text, "````", "");
	}
	return { text: `${lines.join("\n")}\n`, count: packages.length, missing };
}

const SERVICE = {
	serviceId: "choreograph",
	displayName: "Sophia Compute",
	command: "node",
	args: ["app/main.mjs"],
	requires: { node: NODE_FLOOR },
	workingDir: ".",
	healthPath: "/health",
	proxyMount: "/services/choreograph",
	// Opt-in: `gardend service enable choreograph` turns it on at boot; a workflow run through gardend starts it.
	autostart: false,
	env: [
		{ name: "NODE_ENV", value: "production" },
		{ name: "OTEL_SDK_DISABLED", value: "true" },
		{ name: "BILLING_FEE_BPS", value: "0" },
		{ name: "WORKFLOW_DYNAMIC_SOURCE", value: "1" },
		{ name: "CHOREOGRAPH_LOCAL_AGENT_DEFAULTS", value: "1" },
		{ name: "SOPHIA_AGENT_RUNTIME_ENTRYPOINT", value: "body/body.mjs" },
		// Every graph on a gardend belongs to its profile's owner (the master key's identity, `user:owner`).
		{ name: "MNEMOSYNE_GRAPH_OWNER", value: "user:owner" },
	],
};

async function buildService(dest, natives) {
	if (existsSync(dest)) throw new Error(`${dest} exists; move it aside first`);
	const app = join(dest, "app");
	const body = join(dest, "body");
	mkdirSync(app, { recursive: true });
	mkdirSync(body, { recursive: true });

	const nativeNames = ["darwin-x64", "darwin-arm64", "linux-x64-gnu", "linux-arm64-gnu", "linux-x64-musl", "linux-arm64-musl", "linux-arm-gnueabihf", "linux-arm-musleabihf", "win32-x64-msvc"].map((target) => `@libsql/${target}`);
	const main = await build(bundleOptions(ROOT, "src/orchestrator.ts", join(app, "main.mjs"), [...nativeNames, "playwright", "playwright-core", "fsevents"]));
	cpSync(join(ROOT, "src", "worker.mjs"), join(app, "worker.mjs"));
	writeFileSync(join(app, "package.json"), `${JSON.stringify({ name: "@sophia-labs/choreograph-service", private: true, type: "module" }, null, "\t")}\n`);

	const scratch = mkdtempSync(join(tmpdir(), "choreograph-natives-"));
	const nativeRoots = [];
	try {
		for (const target of natives) {
			const from = nativeDir(target, scratch);
			const to = join(app, "node_modules", "@libsql", target);
			mkdirSync(to, { recursive: true });
			for (const file of ["package.json", "index.node"]) cpSync(join(from, file), join(to, file));
			nativeRoots.push(to);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}

	const bodyBuild = await build(bundleOptions(BODY, "src/main.ts", join(body, "body.mjs"), [PHOTON]));
	const bodyManifest = JSON.parse(readFileSync(join(BODY, "package.json"), "utf8"));
	if (bodyManifest.name !== BODY_PACKAGE_NAME) throw new Error(`the body package is named ${bodyManifest.name}`);
	writeFileSync(
		join(body, "package.json"),
		`${JSON.stringify({ name: BODY_PACKAGE_NAME, version: bodyManifest.version, private: true, type: "module", license: bodyManifest.license, pi: piVersion }, null, "\t")}\n`,
	);
	cpSync(join(BODY, "licenses", "pi-LICENSE"), join(body, "LICENSE"));

	writeFileSync(join(dest, "service.json"), `${JSON.stringify(SERVICE, null, "\t")}\n`);
	cpSync(join(ROOT, "LICENSE"), join(dest, "LICENSE"));
	cpSync(join(ROOT, "NOTICE"), join(dest, "NOTICE"));
	const roots = new Set();
	for (const metafile of [main.metafile, bodyBuild.metafile]) {
		for (const input of Object.keys(metafile.inputs)) {
			const root = packageRootOf(join(metafile === main.metafile ? ROOT : BODY, input));
			if (root) roots.add(realpathSync(root));
		}
	}
	roots.add(realpathSync(libsqlDir));
	const { text, count, missing } = notices(roots);
	writeFileSync(join(dest, "THIRD-PARTY-NOTICES.md"), text);

	// A source tree that is not a git checkout (an unpacked release) builds too; BUILD.json then says so.
	let commit = process.env.CHOREOGRAPH_BUILD_COMMIT?.trim() || "unknown (not a git checkout)";
	let dirty = null;
	try {
		commit = git("rev-parse", "HEAD");
		dirty = git("status", "--porcelain", "--", "src", "packages", "deploy", "package.json", "pnpm-lock.yaml") !== "";
	} catch {
		// keep the values above
	}
	const files = Object.fromEntries(filesUnder(dest).map((path) => [relative(dest, path).split(sep).join("/"), sha256(path)]));
	writeFileSync(
		join(dest, "BUILD.json"),
		`${JSON.stringify(
			{
				schema: "sophia.choreograph-service-build.v1",
				choreographCommit: commit,
				dirty,
				pi: piVersion,
				libsql: libsqlVersion,
				natives,
				node: `>=${NODE_FLOOR}`,
				esbuild: esbuildVersion,
				builtWith: process.version,
				files,
			},
			null,
			"\t",
		)}\n`,
	);
	const size = execFileSync("du", ["-sh", dest], { encoding: "utf8" }).split("\t")[0];
	const mb = (path) => (statSync(path).size / 1e6).toFixed(1);
	console.log(
		`build-gardend-service: ${dest} ready (${size}; app/main.mjs ${mb(join(app, "main.mjs"))} MB, body/body.mjs ${mb(join(body, "body.mjs"))} MB; libSQL ${libsqlVersion} for ${natives.join(", ")}; ${count} third-party packages; choreograph ${commit.slice(0, 7)}${dirty ? " + uncommitted changes" : ""}; pi ${piVersion}; esbuild ${esbuildVersion})`,
	);
	if (missing.length) console.log(`build-gardend-service: no licence file in ${missing.length} package(s), named by licence only: ${missing.join(", ")}`);
}

const args = process.argv.slice(2);
const dest = args.find((arg) => !arg.startsWith("--"));
const nativesFlag = args.includes("--natives") ? args[args.indexOf("--natives") + 1] : "all";
if (!dest || (args.includes("--natives") && !nativesFlag)) {
	console.error(`usage: ${basename(process.argv[1])} <dest> [--natives all|host|<target,…>]`);
	process.exit(2);
}
const natives = nativesFlag === "all" ? RELEASE_NATIVES : nativesFlag === "host" ? [hostNative()] : nativesFlag.split(",").map((target) => target.trim()).filter(Boolean);
await buildService(dest, natives);
