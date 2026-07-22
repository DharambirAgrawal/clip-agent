import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

function resolveSystemBinary(name: string): string | null {
	const result = spawnSync(process.platform === "win32" ? "where" : "which", [name]);
	if (result.status === 0) {
		const resolved = result.stdout.toString().trim().split("\n")[0];
		if (resolved && existsSync(resolved)) {
			return resolved;
		}
	}
	return null;
}

function resolveStaticBinary(packageName: string): string | null {
	try {
		const moduleExports = nodeRequire(packageName) as
			| string
			| { default?: string | { path?: string }; path?: string };
		if (typeof moduleExports === "string") {
			return moduleExports;
		}
		if (typeof moduleExports?.path === "string") {
			return moduleExports.path;
		}
		if (typeof moduleExports?.default === "string") {
			return moduleExports.default;
		}
		if (typeof moduleExports?.default?.path === "string") {
			return moduleExports.default.path;
		}
	} catch {
		// Static binary package not installed — fall through to a system lookup.
	}
	return null;
}

let cachedFfmpegPath: string | null | undefined;
let cachedFfprobePath: string | null | undefined;

/** Same "vendored binary, then system PATH" fallback Recordly's own electron/ipc/ffmpeg/binary.ts uses. */
export function getFfmpegPath(): string {
	if (cachedFfmpegPath === undefined) {
		cachedFfmpegPath = resolveStaticBinary("ffmpeg-static") ?? resolveSystemBinary("ffmpeg");
	}
	if (!cachedFfmpegPath) {
		throw new Error(
			"Could not find an ffmpeg binary. Run `npm install` in mcp-server/, or install ffmpeg on your system PATH.",
		);
	}
	return cachedFfmpegPath;
}

export function getFfprobePath(): string {
	if (cachedFfprobePath === undefined) {
		cachedFfprobePath = resolveStaticBinary("ffprobe-static") ?? resolveSystemBinary("ffprobe");
	}
	if (!cachedFfprobePath) {
		throw new Error(
			"Could not find an ffprobe binary. Run `npm install` in mcp-server/, or install ffmpeg (which bundles ffprobe) on your system PATH.",
		);
	}
	return cachedFfprobePath;
}
