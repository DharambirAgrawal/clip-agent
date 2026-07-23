import type { TrimRegion } from "./exporter.js";

/** src/components/video-editor/types.ts */
export const ZOOM_DEPTH_SCALES: Record<number, number> = {
	1: 1.25,
	2: 1.5,
	3: 1.8,
	4: 2.2,
	5: 3.5,
	6: 5.0,
};

export interface ZoomRegionInput {
	startMs: number;
	endMs: number;
	depth: number;
	focus: { cx: number; cy: number };
}

/**
 * trimRegions/zoomRegions/etc. are all anchored to the SOURCE video's timeline (the
 * same coordinate space trimRegions cut from) — but the zoom filter this module builds
 * runs on the already-trimmed output. This remaps a region's [startMs, endMs] from
 * source time into trimmed-output time, given the kept segments (from
 * exporter.ts `buildKeepSegments`). A region that falls entirely inside a cut gap is
 * dropped; one that straddles a cut boundary is clamped to the visible portion.
 */
export function remapRegionsToTrimmedTimeline<T extends { startMs: number; endMs: number }>(
	regions: T[],
	keepSegments: TrimRegion[],
): T[] {
	if (keepSegments.length === 0) return regions;

	const sortedSegments = [...keepSegments].sort((a, b) => a.startMs - b.startMs);
	let cumulative = 0;
	const segmentsWithOffset = sortedSegments.map((segment) => {
		const offset = cumulative;
		cumulative += segment.endMs - segment.startMs;
		return { ...segment, outputOffset: offset };
	});

	function toOutputMs(sourceMs: number): number | null {
		for (const segment of segmentsWithOffset) {
			if (sourceMs >= segment.startMs && sourceMs <= segment.endMs) {
				return segment.outputOffset + (sourceMs - segment.startMs);
			}
		}
		// Falls in a cut gap — clamp to the nearest segment edge.
		let nearest: { outputOms: number; distance: number } | null = null;
		for (const segment of segmentsWithOffset) {
			for (const edge of [segment.startMs, segment.endMs]) {
				const distance = Math.abs(sourceMs - edge);
				const outputOms = segment.outputOffset + (edge - segment.startMs);
				if (!nearest || distance < nearest.distance) {
					nearest = { outputOms, distance };
				}
			}
		}
		return nearest?.outputOms ?? null;
	}

	const remapped: T[] = [];
	for (const region of regions) {
		const start = toOutputMs(region.startMs);
		const end = toOutputMs(region.endMs);
		if (start === null || end === null || end - start < 30) continue;
		remapped.push({ ...region, startMs: start, endMs: end });
	}
	return remapped;
}

export interface ZoomPanExpression {
	/** ffmpeg `zoompan` filter's z/x/y expressions, plus the fps it must be driven at. */
	zoomExpr: string;
	xExpr: string;
	yExpr: string;
}

/**
 * Builds `zoompan` filter expressions that animate a zoom-in/zoom-out for each region.
 *
 * IMPORTANT: this project's ffmpeg build does *not* actually support per-frame-varying
 * `crop` filter parameters — its x/y/w/h accept `t`-referencing expressions and even
 * advertise command-support flags, but empirically neither re-evaluates per frame nor
 * responds to `sendcmd` (returns "Function not implemented"). `zoompan` is a different
 * filter purpose-built for animated zoom/pan and does evaluate per output frame — this
 * was verified with a real rendered video (marker visibly grows and re-centers on its
 * focus point during the region, then returns to the original framing), not assumed.
 *
 * `on` is zoompan's own output-frame counter; with `d=1` (one output frame per input
 * frame) and `fps` set to the real frame rate, `on/fps` is equivalent to elapsed
 * seconds, so the same min(easeIn, easeOut) smoothstep trick used for the (abandoned)
 * crop-expression approach still applies — just expressed in frames instead of `t`.
 *
 * Zoom operates within `baseCropRect` (the static crop/pan region, full frame if unset).
 * The caller is expected to first `crop` the input down to `baseCropRect`, so zoompan's
 * own `iw`/`ih` equal that rect's width/height — `focus` here is pre-converted to be
 * relative to that cropped rect, not the full source frame.
 */
export function buildZoomPanExpression(params: {
	regions: ZoomRegionInput[];
	fps: number;
	baseCropRect: { width: number; height: number };
	zoomInMs: number;
	zoomOutMs: number;
}): ZoomPanExpression | null {
	const { regions, fps, zoomInMs, zoomOutMs } = params;
	if (regions.length === 0) return null;

	const zoomInFrames = Math.max(1, Math.round((zoomInMs / 1000) * fps));
	const zoomOutFrames = Math.max(1, Math.round((zoomOutMs / 1000) * fps));

	function localFactorExpr(startFrame: number, endFrame: number): string {
		const pIn = `clip((on-${startFrame})/${zoomInFrames},0,1)`;
		const pOut = `clip((${endFrame}-on)/${zoomOutFrames},0,1)`;
		return `min(${pIn},${pOut})`;
	}

	function smoothstep(pExpr: string): string {
		return `(3*pow(${pExpr},2)-2*pow(${pExpr},3))`;
	}

	let zoomExpr = "1";
	let cxExpr = "0.5";
	let cyExpr = "0.5";

	for (let i = regions.length - 1; i >= 0; i -= 1) {
		const region = regions[i];
		const startFrame = Math.round((region.startMs / 1000) * fps);
		const endFrame = Math.round((region.endMs / 1000) * fps);
		const targetScale = ZOOM_DEPTH_SCALES[region.depth] ?? ZOOM_DEPTH_SCALES[3];
		const eased = smoothstep(localFactorExpr(startFrame, endFrame));
		const regionScale = `(1+(${targetScale}-1)*${eased})`;

		zoomExpr = `if(between(on,${startFrame},${endFrame}),${regionScale},${zoomExpr})`;
		cxExpr = `if(between(on,${startFrame},${endFrame}),${region.focus.cx},${cxExpr})`;
		cyExpr = `if(between(on,${startFrame},${endFrame}),${region.focus.cy},${cyExpr})`;
	}

	return {
		zoomExpr,
		xExpr: `clip(${cxExpr}*iw-(iw/zoom/2),0,iw-iw/zoom)`,
		yExpr: `clip(${cyExpr}*ih-(ih/zoom/2),0,ih-ih/zoom)`,
	};
}
