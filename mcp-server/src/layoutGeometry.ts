/**
 * Ported from src/components/video-editor/videoPlayback/layoutUtils.ts —
 * `computePaddedLayout` and `scalePreviewBorderRadius` only. Those two are pure math in
 * the original file; the rest of that file imports PixiJS at runtime for the live
 * preview canvas, which this server has no use for.
 */

export interface CropRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface Padding {
	top: number;
	bottom: number;
	left: number;
	right: number;
	linked: boolean;
}

/** src/components/video-editor/types.ts */
export const ADVANCED_VERTICAL_PADDING_MAX = 250;

export const PADDING_SCALE_FACTOR = 0.2;
export const BASE_PREVIEW_WIDTH = 1920;
export const BASE_PREVIEW_HEIGHT = 1080;

export function scalePreviewBorderRadius(width: number, height: number, borderRadius = 0): number {
	if (width <= 0 || height <= 0) return 0;
	const canvasScaleFactor = Math.min(width / BASE_PREVIEW_WIDTH, height / BASE_PREVIEW_HEIGHT);
	return Math.max(0, borderRadius * canvasScaleFactor);
}

export interface PaddedLayoutResult {
	scale: number;
	centerOffsetX: number;
	centerOffsetY: number;
	spriteX: number;
	spriteY: number;
	fullFrameDisplayW: number;
	fullFrameDisplayH: number;
	fullVideoDisplayWidth: number;
	fullVideoDisplayHeight: number;
	croppedDisplayWidth: number;
	croppedDisplayHeight: number;
	cropStartX: number;
	cropStartY: number;
}

export function computePaddedLayout(params: {
	width: number;
	height: number;
	padding: Padding | number;
	frameInsets?: { top: number; right: number; bottom: number; left: number } | null;
	cropRegion: CropRegion;
	videoWidth: number;
	videoHeight: number;
}): PaddedLayoutResult {
	const { width, height, padding, frameInsets, cropRegion, videoWidth, videoHeight } = params;

	const p =
		typeof padding === "number"
			? { top: padding, bottom: padding, left: padding, right: padding }
			: padding;

	const isAdvancedPadding = typeof padding !== "number" && padding.linked === false;
	const clampPercent = (v: number, max = 100) => Math.min(max, Math.max(0, v));
	const leftPercent = clampPercent(p.left);
	const rightPercent = clampPercent(p.right);
	const topPercent = clampPercent(p.top, isAdvancedPadding ? ADVANCED_VERTICAL_PADDING_MAX : 100);
	const bottomPercent = clampPercent(p.bottom, isAdvancedPadding ? ADVANCED_VERTICAL_PADDING_MAX : 100);
	const leftPadFrac = (leftPercent / 100) * PADDING_SCALE_FACTOR;
	const rightPadFrac = (rightPercent / 100) * PADDING_SCALE_FACTOR;
	const topPadFrac = (Math.min(topPercent, 100) / 100) * PADDING_SCALE_FACTOR;
	const bottomPadFrac = (Math.min(bottomPercent, 100) / 100) * PADDING_SCALE_FACTOR;

	const availableFracW = Math.max(0, 1.0 - leftPadFrac - rightPadFrac);
	const availableFracH = Math.max(0, 1.0 - topPadFrac - bottomPadFrac);

	const maxDisplayWidth = width * availableFracW;
	const maxDisplayHeight = height * availableFracH;

	const crop = cropRegion;
	const croppedVideoWidth = videoWidth * crop.width;
	const croppedVideoHeight = videoHeight * crop.height;

	const insets = frameInsets;
	const screenFracW = insets ? 1 - insets.left - insets.right : 1;
	const screenFracH = insets ? 1 - insets.top - insets.bottom : 1;

	const fullFrameVideoW = croppedVideoWidth / screenFracW;
	const fullFrameVideoH = croppedVideoHeight / screenFracH;

	const scale = Math.min(
		fullFrameVideoW > 0 ? maxDisplayWidth / fullFrameVideoW : 0,
		fullFrameVideoH > 0 ? maxDisplayHeight / fullFrameVideoH : 0,
	);

	const fullVideoDisplayWidth = videoWidth * scale;
	const fullVideoDisplayHeight = videoHeight * scale;
	const croppedDisplayWidth = croppedVideoWidth * scale;
	const croppedDisplayHeight = croppedVideoHeight * scale;

	const fullFrameDisplayW = fullFrameVideoW * scale;
	const fullFrameDisplayH = fullFrameVideoH * scale;

	const availableCenterX = leftPadFrac * width + maxDisplayWidth / 2;
	const availableCenterY = isAdvancedPadding
		? (() => {
				const verticalTravel = Math.max(0, height - fullFrameDisplayH);
				const centeredOffsetY = verticalTravel / 2;
				const directionalOffsetY =
					centeredOffsetY +
					((topPercent - bottomPercent) / ADVANCED_VERTICAL_PADDING_MAX) * centeredOffsetY;
				const frameOffsetY = Math.min(verticalTravel, Math.max(0, directionalOffsetY));
				return frameOffsetY + fullFrameDisplayH / 2;
			})()
		: topPadFrac * height + maxDisplayHeight / 2;

	const frameCenterX = availableCenterX - fullFrameDisplayW / 2;
	const frameCenterY = availableCenterY - fullFrameDisplayH / 2;

	const centerOffsetX = insets ? frameCenterX + insets.left * fullFrameDisplayW : frameCenterX;
	const centerOffsetY = insets ? frameCenterY + insets.top * fullFrameDisplayH : frameCenterY;

	const spriteX = centerOffsetX - crop.x * fullVideoDisplayWidth;
	const spriteY = centerOffsetY - crop.y * fullVideoDisplayHeight;

	return {
		scale,
		centerOffsetX,
		centerOffsetY,
		spriteX,
		spriteY,
		fullFrameDisplayW,
		fullFrameDisplayH,
		fullVideoDisplayWidth,
		fullVideoDisplayHeight,
		croppedDisplayWidth,
		croppedDisplayHeight,
		cropStartX: crop.x * videoWidth,
		cropStartY: crop.y * videoHeight,
	};
}
