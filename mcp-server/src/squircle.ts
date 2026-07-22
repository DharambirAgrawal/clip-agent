/**
 * Ported verbatim from src/lib/geometry/squircle.ts (`getSquirclePathPoints` only — the
 * Canvas/PixiJS drawing helpers in that file aren't needed here). Pure math, no
 * dependency on the original file's `import type { Graphics } from "pixi.js"`.
 */

interface SquircleRect {
	x: number;
	y: number;
	width: number;
	height: number;
	radius: number;
}

interface SquirclePoint {
	x: number;
	y: number;
}

const SQUIRCLE_EXPONENT = 4.5;
const SQUIRCLE_SEGMENTS_PER_CORNER = 10;

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function getClampedRadius(width: number, height: number, radius: number) {
	return clamp(radius, 0, Math.min(width, height) / 2);
}

function getSuperellipsePoint(centerX: number, centerY: number, radius: number, angle: number) {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const exponent = 2 / SQUIRCLE_EXPONENT;

	return {
		x: centerX + Math.sign(cos) * radius * Math.pow(Math.abs(cos), exponent),
		y: centerY + Math.sign(sin) * radius * Math.pow(Math.abs(sin), exponent),
	};
}

export function getSquirclePathPoints({ x, y, width, height, radius }: SquircleRect): SquirclePoint[] {
	if (width <= 0 || height <= 0) return [];

	const clampedRadius = getClampedRadius(width, height, radius);
	if (clampedRadius <= 0.5) {
		return [
			{ x, y },
			{ x: x + width, y },
			{ x: x + width, y: y + height },
			{ x, y: y + height },
		];
	}

	const points: SquirclePoint[] = [{ x: x + clampedRadius, y }];
	const corners = [
		{ centerX: x + width - clampedRadius, centerY: y + clampedRadius, start: -Math.PI / 2, end: 0 },
		{ centerX: x + width - clampedRadius, centerY: y + height - clampedRadius, start: 0, end: Math.PI / 2 },
		{ centerX: x + clampedRadius, centerY: y + height - clampedRadius, start: Math.PI / 2, end: Math.PI },
		{ centerX: x + clampedRadius, centerY: y + clampedRadius, start: Math.PI, end: (Math.PI * 3) / 2 },
	];

	for (const corner of corners) {
		for (let index = 1; index <= SQUIRCLE_SEGMENTS_PER_CORNER; index += 1) {
			const t = index / SQUIRCLE_SEGMENTS_PER_CORNER;
			const angle = corner.start + (corner.end - corner.start) * t;
			points.push(getSuperellipsePoint(corner.centerX, corner.centerY, clampedRadius, angle));
		}
	}

	return points;
}

function isPointInsidePolygon(x: number, y: number, points: SquirclePoint[]) {
	let inside = false;
	for (let index = 0, previousIndex = points.length - 1; index < points.length; previousIndex = index++) {
		const current = points[index];
		const previous = points[previousIndex];
		const intersects =
			current.y > y !== previous.y > y &&
			x < ((previous.x - current.x) * (y - current.y)) / (previous.y - current.y) + current.x;
		if (intersects) inside = !inside;
	}
	return inside;
}

/** Ported verbatim from electron/ipc/nativeVideoExport.ts `createNativeSquircleMaskPgmBuffer`. */
export function createSquircleMaskPgmBuffer(width: number, height: number, radius: number): Buffer {
	const safeWidth = Math.max(1, Math.round(width));
	const safeHeight = Math.max(1, Math.round(height));
	const clampedRadius = Math.min(Math.max(0, radius), Math.min(safeWidth, safeHeight) / 2);
	const header = Buffer.from(`P5\n${safeWidth} ${safeHeight}\n255\n`, "ascii");
	const pixels = Buffer.alloc(safeWidth * safeHeight, 255);

	if (clampedRadius <= 0.5) {
		return Buffer.concat([header, pixels]);
	}

	const points = getSquirclePathPoints({ x: 0, y: 0, width: safeWidth, height: safeHeight, radius: clampedRadius });
	const samples = [
		[0.25, 0.25],
		[0.75, 0.25],
		[0.25, 0.75],
		[0.75, 0.75],
	] as const;

	for (let y = 0; y < safeHeight; y += 1) {
		for (let x = 0; x < safeWidth; x += 1) {
			let coveredSamples = 0;
			for (const [sampleX, sampleY] of samples) {
				if (isPointInsidePolygon(x + sampleX, y + sampleY, points)) coveredSamples += 1;
			}
			pixels[y * safeWidth + x] = Math.round((coveredSamples / samples.length) * 255);
		}
	}

	return Buffer.concat([header, pixels]);
}
