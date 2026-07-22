import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getFfmpegPath } from "./binaries.js";
import { getMediaInfo } from "./media.js";

const execFileAsync = promisify(execFile);

export interface TrimRegion {
	startMs: number;
	endMs: number;
}

/**
 * Ported from src/lib/exporter/videoExporter.ts `buildNativeTrimSegments`: trimRegions
 * are ranges to REMOVE, so the segments actually kept in the export are the gaps
 * between them (and before/after all of them).
 */
export function buildKeepSegments(trimRegions: TrimRegion[], durationMs: number) {
	const sorted = [...trimRegions].sort((a, b) => a.startMs - b.startMs);
	const segments: TrimRegion[] = [];
	let cursorMs = 0;

	for (const region of sorted) {
		const startMs = Math.max(0, Math.min(region.startMs, durationMs));
		const endMs = Math.max(startMs, Math.min(region.endMs, durationMs));
		if (startMs > cursorMs) {
			segments.push({ startMs: cursorMs, endMs: startMs });
		}
		cursorMs = Math.max(cursorMs, endMs);
	}

	if (cursorMs < durationMs) {
		segments.push({ startMs: cursorMs, endMs: durationMs });
	}

	return segments.filter((segment) => segment.endMs - segment.startMs > 1);
}

function buildTrimConcatFilter(
	segments: TrimRegion[],
	hasAudio: boolean,
	scaleWidth?: number,
): {
	filter: string;
	mapArgs: string[];
} {
	const videoLabels: string[] = [];
	const audioLabels: string[] = [];
	const parts: string[] = [];

	segments.forEach((segment, index) => {
		const startSec = (segment.startMs / 1000).toFixed(3);
		const endSec = (segment.endMs / 1000).toFixed(3);
		parts.push(
			`[0:v]trim=start=${startSec}:end=${endSec},setpts=PTS-STARTPTS[v${index}]`,
		);
		videoLabels.push(`[v${index}]`);
		if (hasAudio) {
			parts.push(
				`[0:a]atrim=start=${startSec}:end=${endSec},asetpts=PTS-STARTPTS[a${index}]`,
			);
			audioLabels.push(`[a${index}]`);
		}
	});

	// Any post-concat filters (e.g. scaling) must live inside the same filter_complex
	// graph — ffmpeg rejects mixing a top-level -vf with -filter_complex output mapping.
	const videoOutLabel = scaleWidth ? "concatv" : "outv";

	if (hasAudio) {
		const interleaved = segments.map((_, i) => `${videoLabels[i]}${audioLabels[i]}`).join("");
		parts.push(`${interleaved}concat=n=${segments.length}:v=1:a=1[${videoOutLabel}][outa]`);
		if (scaleWidth) {
			parts.push(`[${videoOutLabel}]scale=${scaleWidth}:-2[outv]`);
		}
		return { filter: parts.join(";"), mapArgs: ["-map", "[outv]", "-map", "[outa]"] };
	}

	parts.push(`${videoLabels.join("")}concat=n=${segments.length}:v=1:a=0[${videoOutLabel}]`);
	if (scaleWidth) {
		parts.push(`[${videoOutLabel}]scale=${scaleWidth}:-2[outv]`);
	}
	return { filter: parts.join(";"), mapArgs: ["-map", "[outv]"] };
}

export interface ExportOptions {
	/** "fast" stream-copies (snaps cuts to keyframes); "accurate" re-encodes for frame-accurate cuts. */
	mode?: "fast" | "accurate";
	scaleWidth?: number;
	crf?: number;
	preset?: string;
}

/**
 * Phase-1 exporter: applies trimRegions only. This is intentionally scoped down from
 * Recordly's real GPU-accelerated render pipeline (zoom keyframes, cursor effects,
 * webcam compositing, frame styling all live in native/PIXI code tied to the running
 * Electron app) — see mcp-server/README.md for what's real here vs. what still routes
 * through the desktop app.
 */
export async function exportTrimmedVideo(
	sourcePath: string,
	trimRegions: TrimRegion[],
	outputPath: string,
	options: ExportOptions = {},
): Promise<{ outputPath: string; segments: TrimRegion[] }> {
	const info = await getMediaInfo(sourcePath);
	const segments = buildKeepSegments(trimRegions, info.durationMs);

	if (segments.length === 0) {
		throw new Error("Trim regions remove the entire clip — nothing left to export.");
	}

	const args: string[] = ["-y", "-i", sourcePath];

	if (segments.length === 1 && options.mode === "fast") {
		const { startMs, endMs } = segments[0];
		args.push(
			"-ss",
			(startMs / 1000).toFixed(3),
			"-to",
			(endMs / 1000).toFixed(3),
			"-c",
			"copy",
		);
	} else {
		const { filter, mapArgs } = buildTrimConcatFilter(segments, info.hasAudio, options.scaleWidth);
		args.push("-filter_complex", filter, ...mapArgs);
		args.push(
			"-c:v",
			"libx264",
			"-preset",
			options.preset ?? "veryfast",
			"-crf",
			String(options.crf ?? 20),
		);
		if (info.hasAudio) {
			args.push("-c:a", "aac", "-b:a", "160k");
		}
	}

	args.push(outputPath);
	await execFileAsync(getFfmpegPath(), args);

	return { outputPath, segments };
}

export interface PreviewFrame {
	timestampMs: number;
	pngBase64: string;
}

/** Samples evenly spaced frames from an already-rendered video file as PNGs. */
export async function extractSampleFrames(videoPath: string, sampleCount = 4): Promise<PreviewFrame[]> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mcp-frames-"));
	try {
		const previewInfo = await getMediaInfo(videoPath);
		const durationMs = previewInfo.durationMs;
		const frames: PreviewFrame[] = [];

		for (let i = 0; i < sampleCount; i++) {
			const timestampMs = Math.round(((i + 0.5) / sampleCount) * durationMs);
			const framePath = path.join(tempDir, `frame-${i}-${randomUUID()}.png`);
			await execFileAsync(getFfmpegPath(), [
				"-y",
				"-ss",
				(timestampMs / 1000).toFixed(3),
				"-i",
				videoPath,
				"-frames:v",
				"1",
				framePath,
			]);
			const buffer = await fs.readFile(framePath);
			frames.push({ timestampMs, pngBase64: buffer.toString("base64") });
		}

		return frames;
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/**
 * Renders the trimmed timeline at low resolution and samples evenly spaced frames back
 * as PNGs, so Claude can look at the actual result of its own edits before exporting.
 */
export async function renderPreviewFrames(
	sourcePath: string,
	trimRegions: TrimRegion[],
	sampleCount = 4,
): Promise<PreviewFrame[]> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mcp-preview-"));
	const previewPath = path.join(tempDir, "preview.mp4");

	try {
		await exportTrimmedVideo(sourcePath, trimRegions, previewPath, {
			scaleWidth: 480,
			preset: "ultrafast",
			crf: 28,
		});

		const previewInfo = await getMediaInfo(previewPath);
		const durationMs = previewInfo.durationMs;
		const frames: PreviewFrame[] = [];

		for (let i = 0; i < sampleCount; i++) {
			const timestampMs = Math.round(((i + 0.5) / sampleCount) * durationMs);
			const framePath = path.join(tempDir, `frame-${i}-${randomUUID()}.png`);
			await execFileAsync(getFfmpegPath(), [
				"-y",
				"-ss",
				(timestampMs / 1000).toFixed(3),
				"-i",
				previewPath,
				"-frames:v",
				"1",
				framePath,
			]);
			const buffer = await fs.readFile(framePath);
			frames.push({ timestampMs, pngBase64: buffer.toString("base64") });
		}

		return frames;
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}
}
