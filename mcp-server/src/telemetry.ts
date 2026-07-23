import fs from "node:fs/promises";
import type { CursorTelemetryPoint } from "./zoomSuggestion.js";

/** Mirrors electron/ipc/utils.ts `getTelemetryPathForVideo`. */
export function getTelemetryPathForVideo(videoPath: string): string {
	return `${videoPath}.cursor.json`;
}

/** Mirrors electron/ipc/cursor/telemetry.ts's on-disk shape: { version, samples }. */
export async function loadCursorTelemetry(videoPath: string): Promise<CursorTelemetryPoint[]> {
	const telemetryPath = getTelemetryPathForVideo(videoPath);
	try {
		const raw = await fs.readFile(telemetryPath, "utf-8");
		const parsed = JSON.parse(raw) as { samples?: unknown };
		return Array.isArray(parsed.samples) ? (parsed.samples as CursorTelemetryPoint[]) : [];
	} catch {
		return [];
	}
}
