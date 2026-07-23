#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { extractSampleFrames } from "./exporter.js";
import { detectSilence, getMediaInfo } from "./media.js";
import {
	createProject,
	listProjects,
	openProject,
	resolveProjectPath,
	saveProject,
	type RecordlyProject,
} from "./projectStore.js";
import { renderProjectVideo } from "./staticLayoutExporter.js";
import { loadCursorTelemetry } from "./telemetry.js";
import { transcribeVideo } from "./whisper.js";
import { buildInteractionZoomSuggestions } from "./zoomSuggestion.js";

const server = new McpServer({ name: "recordly-mcp-server", version: "0.1.0" });

function regionsOf(project: RecordlyProject, key: string): Array<Record<string, unknown>> {
	const value = project.editor[key];
	return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function withRegions(
	project: RecordlyProject,
	key: string,
	regions: Array<Record<string, unknown>>,
): RecordlyProject {
	return { ...project, editor: { ...project.editor, [key]: regions } };
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

server.tool(
	"list_projects",
	"List Recordly project files (.recordly) with their name, source video, and last-updated time.",
	{},
	async () => {
		const projects = await listProjects();
		return textResult(JSON.stringify(projects, null, 2));
	},
);

server.tool(
	"create_project",
	"Create a new Recordly project from a source video/screen-recording file.",
	{
		videoPath: z.string().describe("Absolute path to the source video file"),
		name: z.string().optional().describe("Project name (defaults to a timestamped name)"),
	},
	async ({ videoPath, name }) => {
		const projectPath = await createProject(videoPath, name);
		return textResult(`Created project at ${projectPath}`);
	},
);

server.tool(
	"open_project",
	"Read a Recordly project file and return its current editing state (trims, zooms, webcam, style, etc).",
	{ project: z.string().describe("Project name or absolute path to a .recordly file") },
	async ({ project }) => {
		const projectPath = await resolveProjectPath(project);
		const data = await openProject(projectPath);
		return textResult(JSON.stringify({ path: projectPath, ...data }, null, 2));
	},
);

server.tool(
	"get_media_info",
	"Inspect a media file's duration, resolution, frame rate, and whether it has audio.",
	{ filePath: z.string().describe("Absolute path to a video or audio file") },
	async ({ filePath }) => {
		const info = await getMediaInfo(filePath);
		return textResult(JSON.stringify(info, null, 2));
	},
);

server.tool(
	"detect_silence",
	"Detect silent ranges in a media file's audio track — candidate ranges to cut.",
	{
		filePath: z.string().describe("Absolute path to a video or audio file"),
		minDurationSec: z.number().optional().describe("Minimum silence length to report (default 0.5s)"),
		noiseDb: z.number().optional().describe("Noise floor in dB; quieter counts as silence (default -30)"),
	},
	async ({ filePath, minDurationSec, noiseDb }) => {
		const intervals = await detectSilence(filePath, { minDurationSec, noiseDb });
		return textResult(JSON.stringify(intervals, null, 2));
	},
);

server.tool(
	"cut_silence",
	"Detect silence in a project's source video and add trim regions covering it, non-destructively.",
	{
		project: z.string().describe("Project name or absolute path to a .recordly file"),
		minDurationSec: z.number().optional(),
		noiseDb: z.number().optional(),
	},
	async ({ project, minDurationSec, noiseDb }) => {
		const projectPath = await resolveProjectPath(project);
		const data = await openProject(projectPath);
		const intervals = await detectSilence(data.videoPath, { minDurationSec, noiseDb });
		const existing = regionsOf(data, "trimRegions");
		const added = intervals.map((interval) => ({ id: randomUUID(), ...interval }));
		await saveProject(projectPath, withRegions(data, "trimRegions", [...existing, ...added]));
		return textResult(`Added ${added.length} trim region(s) covering detected silence.`);
	},
);

server.tool(
	"trim_range",
	"Add a trim region to a project, removing that time range from the exported video.",
	{
		project: z.string().describe("Project name or absolute path to a .recordly file"),
		startMs: z.number(),
		endMs: z.number(),
	},
	async ({ project, startMs, endMs }) => {
		const projectPath = await resolveProjectPath(project);
		const data = await openProject(projectPath);
		const existing = regionsOf(data, "trimRegions");
		const region = { id: randomUUID(), startMs, endMs };
		await saveProject(projectPath, withRegions(data, "trimRegions", [...existing, region]));
		return textResult(`Added trim region ${startMs}ms–${endMs}ms.`);
	},
);

server.tool(
	"add_zoom",
	"Add a zoom-in region to a project's timeline, focused on a point in the full source frame (0-1). Renders as a real animated crop in render_preview/export_final (ease in, hold, ease out) — this is an ffmpeg-native zoom, not a port of the app's own Canvas-based zoom rendering, so it won't be pixel-identical to it.",
	{
		project: z.string().describe("Project name or absolute path to a .recordly file"),
		startMs: z.number(),
		endMs: z.number(),
		depth: z.number().min(1).max(6).optional().describe("Zoom depth level 1-6 (default 2; roughly 1.25x-5x scale)"),
		focusX: z.number().min(0).max(1).optional().describe("Horizontal focus point, 0-1 (default 0.5)"),
		focusY: z.number().min(0).max(1).optional().describe("Vertical focus point, 0-1 (default 0.5)"),
	},
	async ({ project, startMs, endMs, depth, focusX, focusY }) => {
		const projectPath = await resolveProjectPath(project);
		const data = await openProject(projectPath);
		const existing = regionsOf(data, "zoomRegions");
		const region = {
			id: randomUUID(),
			startMs,
			endMs,
			depth: depth ?? 2,
			focus: { cx: focusX ?? 0.5, cy: focusY ?? 0.5 },
		};
		await saveProject(projectPath, withRegions(data, "zoomRegions", [...existing, region]));
		return textResult(`Added zoom region ${startMs}ms–${endMs}ms at depth ${region.depth}.`);
	},
);

server.tool(
	"suggest_zooms",
	"Analyze a project's recorded cursor movement (clicks, dwells) to suggest zoom regions — the same click-clustering heuristic the desktop app's auto-zoom feature uses. Requires a <video>.cursor.json telemetry sidecar file (written during desktop recording); returns nothing useful for videos with no mouse cursor (e.g. phone screen recordings). Returns suggestions only — call add_zoom for the ones you want to keep.",
	{ project: z.string().describe("Project name or absolute path to a .recordly file") },
	async ({ project }) => {
		const projectPath = await resolveProjectPath(project);
		const data = await openProject(projectPath);
		const [info, telemetry] = await Promise.all([
			getMediaInfo(data.videoPath),
			loadCursorTelemetry(data.videoPath),
		]);
		const result = buildInteractionZoomSuggestions({ cursorTelemetry: telemetry, totalMs: info.durationMs });
		if (result.status !== "ok") {
			return textResult(
				`No zoom suggestions (${result.status}). ${result.status === "no-telemetry" ? "No cursor telemetry file found next to the source video — this is expected for recordings without a tracked mouse cursor." : ""}`,
			);
		}
		return textResult(JSON.stringify(result.suggestions, null, 2));
	},
);

server.tool(
	"add_webcam_bubble",
	"Enable and position a webcam overlay bubble on a project.",
	{
		project: z.string().describe("Project name or absolute path to a .recordly file"),
		sourcePath: z.string().describe("Absolute path to the webcam recording"),
		positionPreset: z
			.enum([
				"top-left",
				"top-center",
				"top-right",
				"center-left",
				"center",
				"center-right",
				"bottom-left",
				"bottom-center",
				"bottom-right",
			])
			.optional(),
		size: z.number().min(10).max(100).optional().describe("Bubble size as a percentage (default 30)"),
		mirror: z.boolean().optional(),
	},
	async ({ project, sourcePath, positionPreset, size, mirror }) => {
		const projectPath = await resolveProjectPath(project);
		const data = await openProject(projectPath);
		const currentWebcam =
			typeof data.editor.webcam === "object" && data.editor.webcam !== null
				? (data.editor.webcam as Record<string, unknown>)
				: {};
		const webcam = {
			...currentWebcam,
			enabled: true,
			sourcePath,
			positionPreset: positionPreset ?? currentWebcam.positionPreset ?? "bottom-right",
			size: size ?? currentWebcam.size ?? 30,
			mirror: mirror ?? currentWebcam.mirror ?? false,
		};
		await saveProject(projectPath, {
			...data,
			editor: { ...data.editor, webcam },
		});
		return textResult(`Webcam bubble enabled at ${webcam.positionPreset}.`);
	},
);

server.tool(
	"apply_frame_style",
	"Set a project's background frame, wallpaper, padding, corner radius, and canvas aspect ratio.",
	{
		project: z.string().describe("Project name or absolute path to a .recordly file"),
		frame: z.string().nullable().optional().describe("Frame id, e.g. 'recordly.frames/browser-dark', or null for none"),
		wallpaper: z.string().optional(),
		padding: z
			.number()
			.min(0)
			.max(100)
			.optional()
			.describe(
				"Uniform padding, 0-100. The visible inset is scaled down internally (~0.2x) to match the app's own padding slider, so small values look like almost no change — use 50-80 for a clearly visible framed margin.",
			),
		borderRadius: z.number().min(0).optional(),
		shadowIntensity: z.number().min(0).max(1).optional(),
		aspectRatio: z
			.enum(["native", "16:9", "9:16", "1:1", "4:3", "4:5", "16:10", "10:16"])
			.optional()
			.describe("Canvas aspect ratio; 'native' matches the source video's own aspect ratio (e.g. for portrait phone recordings)"),
	},
	async ({ project, frame, wallpaper, padding, borderRadius, shadowIntensity, aspectRatio }) => {
		const projectPath = await resolveProjectPath(project);
		const data = await openProject(projectPath);
		const editor = { ...data.editor };
		if (frame !== undefined) editor.frame = frame;
		if (wallpaper !== undefined) editor.wallpaper = wallpaper;
		if (padding !== undefined) {
			editor.padding = { top: padding, bottom: padding, left: padding, right: padding, linked: true };
		}
		if (borderRadius !== undefined) editor.borderRadius = borderRadius;
		if (shadowIntensity !== undefined) editor.shadowIntensity = shadowIntensity;
		if (aspectRatio !== undefined) editor.aspectRatio = aspectRatio;
		await saveProject(projectPath, { ...data, editor });
		return textResult("Frame style updated.");
	},
);

server.tool(
	"transcribe_audio",
	"Transcribe a media file's speech to text with timestamps, using Recordly's bundled whisper.cpp runtime. Downloads the model on first use (~500MB).",
	{
		filePath: z.string().describe("Absolute path to a video or audio file"),
		language: z.string().optional().describe("ISO language code, or 'auto' to detect (default auto)"),
	},
	async ({ filePath, language }) => {
		const cues = await transcribeVideo(filePath, { language });
		return textResult(JSON.stringify(cues, null, 2));
	},
);

server.tool(
	"add_caption_track",
	"Transcribe a project's source video and write the result as its auto-caption track.",
	{
		project: z.string().describe("Project name or absolute path to a .recordly file"),
		language: z.string().optional().describe("ISO language code, or 'auto' to detect (default auto)"),
	},
	async ({ project, language }) => {
		const projectPath = await resolveProjectPath(project);
		const data = await openProject(projectPath);
		const cues = await transcribeVideo(data.videoPath, { language });
		await saveProject(projectPath, {
			...data,
			editor: { ...data.editor, autoCaptions: cues },
		});
		return textResult(`Added ${cues.length} caption cue(s) from transcription.`);
	},
);

server.tool(
	"render_preview",
	"Render the project's current edits (trims, wallpaper, padding, rounded corners, shadow, webcam bubble) and return sampled frames as images, so you can look at the result before exporting. Zoom regions, cursor rendering, and device-frame chrome are not yet reflected — those still require the desktop app.",
	{
		project: z.string().describe("Project name or absolute path to a .recordly file"),
		sampleCount: z.number().min(1).max(10).optional().describe("How many evenly spaced frames to return (default 4)"),
	},
	async ({ project, sampleCount }) => {
		const projectPath = await resolveProjectPath(project);
		const data = await openProject(projectPath);
		const tempOutput = path.join(os.tmpdir(), `recordly-mcp-preview-${randomUUID()}.mp4`);
		try {
			await renderProjectVideo(data, tempOutput, { scaleWidth: 480, preset: "ultrafast", crf: 28 });
			const frames = await extractSampleFrames(tempOutput, sampleCount ?? 4);
			return {
				content: [
					{ type: "text" as const, text: `${frames.length} preview frame(s) from the current edit:` },
					...frames.map((frame) => ({
						type: "image" as const,
						data: frame.pngBase64,
						mimeType: "image/png",
					})),
				],
			};
		} finally {
			await fs.rm(tempOutput, { force: true }).catch(() => undefined);
		}
	},
);

server.tool(
	"export_final",
	"Export a project's edits to a video file: trims, wallpaper background, padding, rounded corners, shadow, and webcam bubble. Zoom-region animation, cursor rendering, and device-frame chrome are not yet rendered — those require the Recordly desktop app's Canvas/WebGL pipeline.",
	{
		project: z.string().describe("Project name or absolute path to a .recordly file"),
		outputPath: z.string().describe("Absolute path for the exported .mp4"),
	},
	async ({ project, outputPath }) => {
		const projectPath = await resolveProjectPath(project);
		const data = await openProject(projectPath);
		const resolvedOutputPath = path.resolve(outputPath);
		await renderProjectVideo(data, resolvedOutputPath, { mode: "accurate" });
		return textResult(`Exported to ${resolvedOutputPath}.`);
	},
);

const transport = new StdioServerTransport();
await server.connect(transport);
