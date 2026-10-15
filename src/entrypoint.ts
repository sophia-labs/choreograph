import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

function normalizeRealPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export function isExecutedDirectly(moduleUrl: string, argvPath = process.argv[1]): boolean {
	if (!argvPath) {
		return false;
	}

	const modulePath = normalizeRealPath(fileURLToPath(moduleUrl));
	const entryPath = normalizeRealPath(argvPath);
	return modulePath === entryPath;
}
