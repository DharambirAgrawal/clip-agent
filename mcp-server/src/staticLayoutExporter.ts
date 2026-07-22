import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getFfmpegPath } from "./binaries.js";
import { buildKeepSegments, exportTrimmedVideo, type ExportOptions, type TrimRegion } from "./exporter.js";
import { computePaddedLayout, scalePreviewBorderRadius, type CropRegion, type Padding } from "./layoutGeometry.js";
import { getMediaInfo } from "./media.js";
import { getShadowFilterPadding, VIDEO_SHADOW_LAYER_PROFILES } from "./shadowProfile.js";
import { createSquircleMaskPgmBuffer } from "./squircle.js";
import { getWebcamOverlayDimensionsPx, getWebcamOverlayPosition, type WebcamPositionPreset } from "./webcamGeometry.js";

const execFileAsync = promisify(execFile);

function repoRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** src/utils/aspectRatioUtils.ts `getAspectRatioValue`, condensed to the presets this
 * composer resolves a pixel canvas for. */
function getAspectRatioValue(aspectRatio: string, nativeAspectRatio: number): number {
	switch (aspectRatio) {
		case "native":
			return nativeAspectRatio > 0 ? nativeAspectRatio : 16 / 9;
		case "16:9":
			return 16 / 9;
		case "9:16":
			return 9 / 16;
		case "1:1":
			return 1;
		case "4:3":
			return 4 / 3;
		case "4:5":
			return 4 / 5;
		case "16:10":
			return 16 / 10;
		case "10:16":
			return 10 / 16;
		default: {
			const match = /^(\d+):(\d+)$/.exec(aspectRatio);
			if (match) {
				const w = Number(match[1]);
				const h = Number(match[2]);
				if (w > 0 && h > 0) return w / h;
			}
			return nativeAspectRatio > 0 ? nativeAspectRatio : 16 / 9;
		}
	}
}

function resolveCanvasSize(aspectRatio: string, videoWidth: number, videoHeight: number) {
	if (aspectRatio === "native" || !aspectRatio) {
		return { width: videoWidth, height: videoHeight };
	}
	const ratio = getAspectRatioValue(aspectRatio, videoWidth / videoHeight);
	const longEdge = 1920;
	if (ratio >= 1) {
		return { width: longEdge, height: Math.round(longEdge / ratio) };
	}
	return { width: Math.round(longEdge * ratio), height: longEdge };
}

/** Resolves a Recordly wallpaper reference (e.g. "/wallpapers/tahoe-light.jpg") against
 * this repo's public/ dir — the same assets the desktop app bundles. Returns null for
 * anything this compositor can't use yet (missing file, or a video wallpaper — those
 * need a looping video input, not implemented here). */
function resolveWallpaperImagePath(wallpaper: unknown): string | null {
	if (typeof wallpaper !== "string" || !wallpaper.trim()) return null;
	const relative = wallpaper.replace(/^\/+/, "");
	const resolved = path.join(repoRoot(), "public", relative);
	if (!existsSync(resolved)) return null;
	if (/\.(mp4|webm|mov|m4v)$/i.test(resolved)) return null;
	return resolved;
}

function normalizePadding(padding: unknown): Padding | number {
	if (typeof padding === "number") return padding;
	if (padding && typeof padding === "object") {
		const p = padding as Partial<Padding>;
		return {
			top: typeof p.top === "number" ? p.top : 0,
			bottom: typeof p.bottom === "number" ? p.bottom : 0,
			left: typeof p.left === "number" ? p.left : 0,
			right: typeof p.right === "number" ? p.right : 0,
			linked: p.linked !== false,
		};
	}
	return 0;
}

function normalizeCropRegion(cropRegion: unknown): CropRegion {
	if (cropRegion && typeof cropRegion === "object") {
		const c = cropRegion as Partial<CropRegion>;
		if (
			typeof c.x === "number" &&
			typeof c.y === "number" &&
			typeof c.width === "number" &&
			typeof c.height === "number"
		) {
			return { x: c.x, y: c.y, width: c.width, height: c.height };
		}
	}
	return { x: 0, y: 0, width: 1, height: 1 };
}

async function writePgm(buffer: Buffer, tempDir: string, label: string): Promise<string> {
	const filePath = path.join(tempDir, `${label}-${randomUUID()}.pgm`);
	await fs.writeFile(filePath, buffer);
	return filePath;
}

/**
 * Renders a background image (wallpaper + drop shadow shaped for where the video will
 * sit) as a single static frame. This is the CPU-portable half of what
 * electron/ipc/nativeVideoExport.ts `buildNativeStaticBackgroundRenderArgs` does — the
 * GPU overlay/composite steps in that file are CUDA-only and not reusable here, so the
 * actual video/webcam overlay is done in a second pass below instead of on native GPU.
 */
async function renderBackgroundImage(options: {
	canvasWidth: number;
	canvasHeight: number;
	wallpaperPath: string | null;
	shadowIntensity: number;
	videoRect: { x: number; y: number; width: number; height: number };
	tempDir: string;
}): Promise<string> {
	const { canvasWidth, canvasHeight, wallpaperPath, shadowIntensity, videoRect, tempDir } = options;
	const outputPath = path.join(tempDir, `background-${randomUUID()}.png`);
	const args = ["-y", "-hide_banner", "-loglevel", "error"];

	if (wallpaperPath) {
		args.push("-i", wallpaperPath);
	} else {
		args.push("-f", "lavfi", "-i", `color=c=0x0b0b0f:s=${canvasWidth}x${canvasHeight}:d=1`);
	}

	const shadowLayers =
		shadowIntensity > 0
			? VIDEO_SHADOW_LAYER_PROFILES.map((layer) => ({
					offsetY: layer.offsetScale * shadowIntensity,
					alpha: Math.min(1, Math.max(0, layer.alphaScale * shadowIntensity)),
					blur: Math.max(0, layer.blurScale * shadowIntensity),
				})).filter((layer) => layer.alpha > 0)
			: [];

	let maskPath: string | null = null;
	if (shadowLayers.length > 0) {
		const mask = createSquircleMaskPgmBuffer(videoRect.width, videoRect.height, 0);
		maskPath = await writePgm(mask, tempDir, "shadow-mask");
		args.push("-i", maskPath);
	}

	const filterParts = [
		wallpaperPath
			? `[0:v]scale=w=${canvasWidth}:h=${canvasHeight}:force_original_aspect_ratio=increase,crop=w=${canvasWidth}:h=${canvasHeight},setsar=1,format=rgba[bg0]`
			: "[0:v]format=rgba[bg0]",
	];
	let currentBg = "bg0";

	if (shadowLayers.length > 0) {
		filterParts.push(`[1:v]format=gray,split=${shadowLayers.length}${shadowLayers.map((_, i) => `[shadow_src_${i}]`).join("")}`);
	}

	shadowLayers.forEach((layer, index) => {
		const padding = getShadowFilterPadding(layer.blur, layer.offsetY);
		const paddedWidth = videoRect.width + padding * 2;
		const paddedHeight = videoRect.height + padding * 2;
		const blurFilter = layer.blur > 0 ? `,gblur=sigma=${layer.blur.toFixed(3)}:steps=2` : "";
		const next = `bg${index + 1}`;
		filterParts.push(
			`[shadow_src_${index}]lut=y=val*${layer.alpha.toFixed(3)},pad=w=${paddedWidth}:h=${paddedHeight}:x=${padding}:y=${Math.round(padding + layer.offsetY)}:color=black${blurFilter}[shadow_pos_${index}]`,
			`[shadow_pos_${index}]format=gray[shadow_mask_${index}]`,
			`color=c=black:s=${paddedWidth}x${paddedHeight}:d=1,format=rgba[shadow_color_${index}]`,
			`[shadow_color_${index}][shadow_mask_${index}]alphamerge[shadow_${index}]`,
			`[${currentBg}][shadow_${index}]overlay=x=${Math.round(videoRect.x - padding)}:y=${Math.round(videoRect.y - padding)}:format=auto[${next}]`,
		);
		currentBg = next;
	});

	filterParts.push(`[${currentBg}]format=rgba[out]`);
	args.push("-filter_complex", filterParts.join(";"), "-map", "[out]", "-frames:v", "1", outputPath);

	await execFileAsync(getFfmpegPath(), args);
	return outputPath;
}

export interface WebcamLayoutInput {
	enabled: boolean;
	sourcePath: string | null;
	positionPreset: WebcamPositionPreset;
	positionX: number;
	positionY: number;
	size: number;
	width: number;
	height: number;
	margin: number;
	cornerRadius: number;
	mirror: boolean;
}

export interface StaticLayoutOptions {
	aspectRatio: string;
	wallpaper: unknown;
	padding: unknown;
	borderRadius: number;
	shadowIntensity: number;
	cropRegion: unknown;
	webcam?: WebcamLayoutInput | null;
}

/**
 * Composites wallpaper background + padded/rounded/shadowed video + an optional webcam
 * bubble onto a single canvas across the whole (already-trimmed) clip. This covers the
 * *static* parts of Recordly's frame styling — it does not animate zoom regions, draw
 * the cursor, or render device-frame chrome, all of which live in the per-frame
 * Canvas/WebGL renderer (src/lib/exporter/modernFrameRenderer.ts) that only runs inside
 * the desktop app.
 */
export async function compositeStaticLayout(
	trimmedVideoPath: string,
	trimmedWebcamPath: string | null,
	outputPath: string,
	options: StaticLayoutOptions,
): Promise<{ outputPath: string; canvasWidth: number; canvasHeight: number }> {
	const info = await getMediaInfo(trimmedVideoPath);
	if (!info.width || !info.height) {
		throw new Error("Could not determine source video dimensions.");
	}

	const canvas = resolveCanvasSize(options.aspectRatio, info.width, info.height);
	const cropRegion = normalizeCropRegion(options.cropRegion);
	const layout = computePaddedLayout({
		width: canvas.width,
		height: canvas.height,
		padding: normalizePadding(options.padding),
		frameInsets: null,
		cropRegion,
		videoWidth: info.width,
		videoHeight: info.height,
	});
	const scaledRadius = scalePreviewBorderRadius(canvas.width, canvas.height, options.borderRadius);
	const videoRect = {
		x: Math.round(layout.centerOffsetX),
		y: Math.round(layout.centerOffsetY),
		width: Math.round(layout.croppedDisplayWidth),
		height: Math.round(layout.croppedDisplayHeight),
	};

	// Looped image inputs (background, masks) are infinite unless explicitly bounded —
	// without `-t` here, ffmpeg's overlay chain never sees an EOF from the (infinite)
	// base input and the encode simply never finishes, regardless of `-shortest`.
	const durationSec = Math.max(0.1, info.durationMs / 1000).toFixed(3);

	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mcp-layout-"));
	try {
		const wallpaperPath = resolveWallpaperImagePath(options.wallpaper);
		const backgroundPath = await renderBackgroundImage({
			canvasWidth: canvas.width,
			canvasHeight: canvas.height,
			wallpaperPath,
			shadowIntensity: Math.min(1, Math.max(0, options.shadowIntensity)),
			videoRect,
			tempDir,
		});

		const args = ["-y", "-hide_banner", "-loglevel", "error"];
		args.push("-t", durationSec, "-loop", "1", "-i", backgroundPath);
		args.push("-i", trimmedVideoPath);

		let inputIndex = 2;
		let videoMaskInputIndex: number | null = null;
		if (scaledRadius > 0.5) {
			const mask = createSquircleMaskPgmBuffer(videoRect.width, videoRect.height, scaledRadius);
			const maskPath = await writePgm(mask, tempDir, "video-mask");
			args.push("-t", durationSec, "-loop", "1", "-i", maskPath);
			videoMaskInputIndex = inputIndex;
			inputIndex += 1;
		}

		const webcam = options.webcam;
		const webcamEnabled = Boolean(webcam?.enabled && webcam.sourcePath && trimmedWebcamPath);
		let webcamInputIndex: number | null = null;
		let webcamMaskInputIndex: number | null = null;
		let webcamRect: { x: number; y: number; width: number; height: number } | null = null;

		if (webcamEnabled && webcam) {
			const dims = getWebcamOverlayDimensionsPx({
				containerWidth: canvas.width,
				containerHeight: canvas.height,
				widthPercent: webcam.width ?? webcam.size,
				heightPercent: webcam.height ?? webcam.size,
				margin: webcam.margin,
				zoomScale: 1,
				reactToZoom: false,
			});
			const position = getWebcamOverlayPosition({
				containerWidth: canvas.width,
				containerHeight: canvas.height,
				width: dims.width,
				height: dims.height,
				margin: webcam.margin,
				positionPreset: webcam.positionPreset,
				positionX: webcam.positionX,
				positionY: webcam.positionY,
				legacyCorner: "bottom-right",
			});
			webcamRect = {
				x: Math.round(position.x),
				y: Math.round(position.y),
				width: Math.round(dims.width),
				height: Math.round(dims.height),
			};

			args.push("-i", trimmedWebcamPath as string);
			webcamInputIndex = inputIndex;
			inputIndex += 1;

			if (webcam.cornerRadius > 0.5) {
				const mask = createSquircleMaskPgmBuffer(webcamRect.width, webcamRect.height, webcam.cornerRadius);
				const maskPath = await writePgm(mask, tempDir, "webcam-mask");
				args.push("-t", durationSec, "-loop", "1", "-i", maskPath);
				webcamMaskInputIndex = inputIndex;
				inputIndex += 1;
			}
		}

		const filterParts: string[] = ["[0:v]format=rgba[bg]"];

		const cropX = Math.round(cropRegion.x * info.width);
		const cropY = Math.round(cropRegion.y * info.height);
		const cropW = Math.max(1, Math.round(cropRegion.width * info.width));
		const cropH = Math.max(1, Math.round(cropRegion.height * info.height));
		filterParts.push(
			`[1:v]crop=w=${cropW}:h=${cropH}:x=${cropX}:y=${cropY},scale=w=${videoRect.width}:h=${videoRect.height},format=rgba[vid_scaled]`,
		);
		let videoLabel = "vid_scaled";
		if (videoMaskInputIndex !== null) {
			filterParts.push(`[${videoMaskInputIndex}:v]format=gray[vid_mask]`);
			filterParts.push(`[vid_scaled][vid_mask]alphamerge[vid_masked]`);
			videoLabel = "vid_masked";
		}
		filterParts.push(`[bg][${videoLabel}]overlay=x=${videoRect.x}:y=${videoRect.y}:format=auto[bg1]`);
		let currentLabel = "bg1";

		if (webcamEnabled && webcamInputIndex !== null && webcamRect) {
			const mirrorFilter = webcam?.mirror ? ",hflip" : "";
			filterParts.push(
				`[${webcamInputIndex}:v]scale=w=${webcamRect.width}:h=${webcamRect.height}${mirrorFilter},format=rgba[cam_scaled]`,
			);
			let camLabel = "cam_scaled";
			if (webcamMaskInputIndex !== null) {
				filterParts.push(`[${webcamMaskInputIndex}:v]format=gray[cam_mask]`);
				filterParts.push(`[cam_scaled][cam_mask]alphamerge[cam_masked]`);
				camLabel = "cam_masked";
			}
			filterParts.push(`[${currentLabel}][${camLabel}]overlay=x=${webcamRect.x}:y=${webcamRect.y}:format=auto[bg2]`);
			currentLabel = "bg2";
		}

		filterParts.push(`[${currentLabel}]format=yuv420p[out]`);

		args.push("-filter_complex", filterParts.join(";"), "-map", "[out]");
		if (info.hasAudio) {
			args.push("-map", "1:a");
		}
		args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-shortest");
		if (info.hasAudio) {
			args.push("-c:a", "aac", "-b:a", "160k");
		}
		args.push(outputPath);

		await execFileAsync(getFfmpegPath(), args);
		return { outputPath, canvasWidth: canvas.width, canvasHeight: canvas.height };
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

function needsCompositing(styling: StaticLayoutOptions): boolean {
	if ((styling.borderRadius ?? 0) > 0.5) return true;
	if ((styling.shadowIntensity ?? 0) > 0) return true;
	if (styling.webcam?.enabled) return true;
	if (resolveWallpaperImagePath(styling.wallpaper)) return true;
	const padding = normalizePadding(styling.padding);
	if (typeof padding === "number") return padding > 0;
	return padding.top > 0 || padding.bottom > 0 || padding.left > 0 || padding.right > 0;
}

export interface ProjectEditorLike {
	videoPath: string;
	editor: Record<string, unknown>;
}

/**
 * Full pipeline for a single project: trim -> (if there's any styling to apply)
 * composite wallpaper/padding/rounding/shadow/webcam on top. Falls straight through to
 * the trim-only output when a project has no styling configured, to avoid a pointless
 * second re-encode.
 */
export async function renderProjectVideo(
	project: ProjectEditorLike,
	outputPath: string,
	exportOptions: ExportOptions = {},
): Promise<string> {
	const trimRegions = (Array.isArray(project.editor.trimRegions) ? project.editor.trimRegions : []) as TrimRegion[];
	const webcamRaw =
		project.editor.webcam && typeof project.editor.webcam === "object"
			? (project.editor.webcam as Record<string, unknown>)
			: {};

	const styling: StaticLayoutOptions = {
		aspectRatio: typeof project.editor.aspectRatio === "string" ? project.editor.aspectRatio : "native",
		wallpaper: project.editor.wallpaper,
		padding: project.editor.padding,
		borderRadius: typeof project.editor.borderRadius === "number" ? project.editor.borderRadius : 0,
		shadowIntensity: typeof project.editor.shadowIntensity === "number" ? project.editor.shadowIntensity : 0,
		cropRegion: project.editor.cropRegion,
		webcam: webcamRaw.enabled
			? {
					enabled: true,
					sourcePath: typeof webcamRaw.sourcePath === "string" ? webcamRaw.sourcePath : null,
					positionPreset: (webcamRaw.positionPreset as WebcamPositionPreset) ?? "bottom-right",
					positionX: typeof webcamRaw.positionX === "number" ? webcamRaw.positionX : 1,
					positionY: typeof webcamRaw.positionY === "number" ? webcamRaw.positionY : 1,
					size: typeof webcamRaw.size === "number" ? webcamRaw.size : 30,
					width: typeof webcamRaw.width === "number" ? webcamRaw.width : (typeof webcamRaw.size === "number" ? webcamRaw.size : 30),
					height: typeof webcamRaw.height === "number" ? webcamRaw.height : (typeof webcamRaw.size === "number" ? webcamRaw.size : 30),
					margin: typeof webcamRaw.margin === "number" ? webcamRaw.margin : 24,
					cornerRadius: typeof webcamRaw.cornerRadius === "number" ? webcamRaw.cornerRadius : 18,
					mirror: Boolean(webcamRaw.mirror),
				}
			: null,
	};

	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mcp-render-"));
	try {
		const trimmedPath = path.join(tempDir, "trimmed.mp4");
		await exportTrimmedVideo(project.videoPath, trimRegions, trimmedPath, exportOptions);

		if (!needsCompositing(styling)) {
			await fs.copyFile(trimmedPath, outputPath);
			return outputPath;
		}

		let trimmedWebcamPath: string | null = null;
		if (styling.webcam?.sourcePath) {
			const timeOffsetMs = typeof webcamRaw.timeOffsetMs === "number" ? webcamRaw.timeOffsetMs : 0;
			const webcamTrimRegions = trimRegions.map((region) => ({
				startMs: Math.max(0, region.startMs - timeOffsetMs),
				endMs: Math.max(0, region.endMs - timeOffsetMs),
			}));
			trimmedWebcamPath = path.join(tempDir, "trimmed-webcam.mp4");
			await exportTrimmedVideo(styling.webcam.sourcePath, webcamTrimRegions, trimmedWebcamPath, exportOptions);
		}

		await compositeStaticLayout(trimmedPath, trimmedWebcamPath, outputPath, styling);
		return outputPath;
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

export { buildKeepSegments };
export type { TrimRegion };
