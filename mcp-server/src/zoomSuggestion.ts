/**
 * Ported verbatim from src/components/video-editor/timeline/zoomSuggestionUtils.ts
 * (pure math/heuristics over cursor telemetry — only type-level imports in the
 * original). This is the same click-clustering algorithm the app's own "auto zoom on
 * cursor activity" feature uses.
 */

export interface CursorTelemetryPoint {
	timeMs: number;
	cx: number;
	cy: number;
	interactionType?: "click" | "double-click" | "right-click" | "middle-click" | "move" | "mouseup";
	cursorType?: string;
}

export interface ZoomFocus {
	cx: number;
	cy: number;
}

export const MIN_DWELL_DURATION_MS = 450;
export const MAX_DWELL_DURATION_MS = 2600;
export const DWELL_MOVE_THRESHOLD = 0.02;

export interface ZoomDwellCandidate {
	centerTimeMs: number;
	focus: ZoomFocus;
	strength: number;
}

export interface CursorInteractionCandidate extends ZoomDwellCandidate {
	kind:
		| "dwell"
		| "click-like"
		| "double-click-like"
		| "text-focus-like"
		| "dropdown-open"
		| "text-selection"
		| "text-field-click";
	source: "explicit" | "heuristic";
}

export interface SuggestedZoomRegion {
	start: number;
	end: number;
	focus: ZoomFocus;
}

export type InteractionZoomSuggestionStatus = "ok" | "no-telemetry" | "no-interactions" | "no-slots";

export interface InteractionZoomSuggestionResult {
	status: InteractionZoomSuggestionStatus;
	suggestions: SuggestedZoomRegion[];
}

export const CLICK_CLUSTER_MERGE_GAP_MS = 2500;
export const CLICK_CLUSTER_PAD_MS = 500;
const EXPLICIT_CLICK_TYPES = new Set<NonNullable<CursorTelemetryPoint["interactionType"]>>([
	"click",
	"double-click",
	"right-click",
	"middle-click",
]);

function isExplicitClickType(
	interactionType: CursorTelemetryPoint["interactionType"],
): interactionType is NonNullable<CursorTelemetryPoint["interactionType"]> {
	return typeof interactionType === "string" && EXPLICIT_CLICK_TYPES.has(interactionType);
}

function normalizeTelemetrySample(sample: CursorTelemetryPoint, totalMs: number): CursorTelemetryPoint {
	return {
		timeMs: Math.max(0, Math.min(sample.timeMs, totalMs)),
		cx: Math.max(0, Math.min(sample.cx, 1)),
		cy: Math.max(0, Math.min(sample.cy, 1)),
		interactionType: sample.interactionType,
		cursorType: sample.cursorType,
	};
}

function normalizeCursorTelemetry(telemetry: CursorTelemetryPoint[], totalMs: number): CursorTelemetryPoint[] {
	return [...telemetry]
		.filter((sample) => Number.isFinite(sample.timeMs) && Number.isFinite(sample.cx) && Number.isFinite(sample.cy))
		.sort((a, b) => a.timeMs - b.timeMs)
		.map((sample) => normalizeTelemetrySample(sample, totalMs));
}

export function detectZoomDwellCandidates(samples: CursorTelemetryPoint[]): ZoomDwellCandidate[] {
	if (samples.length < 2) return [];

	const dwellCandidates: ZoomDwellCandidate[] = [];
	let runStart = 0;

	const pushRunIfDwell = (startIndex: number, endIndexExclusive: number) => {
		if (endIndexExclusive - startIndex < 2) return;
		const start = samples[startIndex];
		const end = samples[endIndexExclusive - 1];
		const runDuration = end.timeMs - start.timeMs;
		if (runDuration < MIN_DWELL_DURATION_MS || runDuration > MAX_DWELL_DURATION_MS) return;

		const runSamples = samples.slice(startIndex, endIndexExclusive);
		const avgCx = runSamples.reduce((sum, sample) => sum + sample.cx, 0) / runSamples.length;
		const avgCy = runSamples.reduce((sum, sample) => sum + sample.cy, 0) / runSamples.length;

		dwellCandidates.push({
			centerTimeMs: Math.round((start.timeMs + end.timeMs) / 2),
			focus: { cx: avgCx, cy: avgCy },
			strength: runDuration,
		});
	};

	for (let index = 1; index < samples.length; index += 1) {
		const prev = samples[index - 1];
		const curr = samples[index];
		const distance = Math.hypot(curr.cx - prev.cx, curr.cy - prev.cy);
		if (distance > DWELL_MOVE_THRESHOLD) {
			pushRunIfDwell(runStart, index);
			runStart = index;
		}
	}
	pushRunIfDwell(runStart, samples.length);

	return dwellCandidates;
}

function classifyPostClickBehavior(
	samples: CursorTelemetryPoint[],
	clickSample: CursorTelemetryPoint,
): CursorInteractionCandidate["kind"] {
	if (clickSample.interactionType === "double-click") return "double-click-like";

	const clickTime = clickSample.timeMs;
	const mouseUpAfter = samples.find(
		(s) => s.interactionType === "mouseup" && s.timeMs > clickTime && s.timeMs - clickTime < 3000,
	);

	if (mouseUpAfter) {
		const dragDx = Math.abs(mouseUpAfter.cx - clickSample.cx);
		const dragDy = Math.abs(mouseUpAfter.cy - clickSample.cy);
		const dragDuration = mouseUpAfter.timeMs - clickTime;
		if (dragDuration >= 200 && dragDx > 0.03 && dragDx > dragDy * 1.8) return "text-selection";
	}

	const moveSamples = samples.filter(
		(s) => s.timeMs > clickTime + 100 && s.timeMs <= clickTime + 2000 && (s.interactionType === "move" || !s.interactionType),
	);

	if (moveSamples.length < 3) return "text-field-click";

	let maxDist = 0;
	let totalAbsDy = 0;
	let totalAbsDx = 0;
	for (const s of moveSamples) {
		const dist = Math.hypot(s.cx - clickSample.cx, s.cy - clickSample.cy);
		maxDist = Math.max(maxDist, dist);
		totalAbsDx += Math.abs(s.cx - clickSample.cx);
		totalAbsDy += Math.abs(s.cy - clickSample.cy);
	}

	if (maxDist < 0.02) return "text-field-click";

	const lastMoveSample = moveSamples[moveSamples.length - 1];
	const netDy = lastMoveSample.cy - clickSample.cy;
	if (netDy > 0.03 && totalAbsDy > totalAbsDx * 1.5) return "dropdown-open";
	if (totalAbsDx > 0.03 && totalAbsDx > totalAbsDy * 1.8) return "text-selection";

	return "click-like";
}

export function detectInteractionCandidates(samples: CursorTelemetryPoint[]): CursorInteractionCandidate[] {
	const clickEvents = samples.filter((sample) => isExplicitClickType(sample.interactionType));
	const explicitInteractionCandidates: CursorInteractionCandidate[] = [];

	for (const clickSample of clickEvents) {
		const kind = classifyPostClickBehavior(samples, clickSample);
		const baseStrength =
			kind === "double-click-like" ? 1500 : kind === "dropdown-open" ? 1200 : kind === "text-selection" ? 1300 : kind === "text-field-click" ? 1100 : 900;

		explicitInteractionCandidates.push({
			centerTimeMs: Math.round(clickSample.timeMs),
			focus: { cx: clickSample.cx, cy: clickSample.cy },
			strength: baseStrength,
			kind,
			source: "explicit",
		});
	}

	const dwellCandidates = detectZoomDwellCandidates(samples).map<CursorInteractionCandidate>((candidate) => {
		if (candidate.strength >= 1100) return { ...candidate, kind: "text-focus-like", source: "heuristic" };
		if (candidate.strength <= 800) return { ...candidate, kind: "click-like", source: "heuristic" };
		return { ...candidate, kind: "dwell", source: "heuristic" };
	});

	const doubleClickCandidates: CursorInteractionCandidate[] = [];
	const sortedByTime = [...dwellCandidates].sort((a, b) => a.centerTimeMs - b.centerTimeMs);

	for (let index = 1; index < sortedByTime.length; index += 1) {
		const prev = sortedByTime[index - 1];
		const curr = sortedByTime[index];
		const timeGap = curr.centerTimeMs - prev.centerTimeMs;
		const spatialGap = Math.hypot(curr.focus.cx - prev.focus.cx, curr.focus.cy - prev.focus.cy);
		const bothShort = prev.strength <= 900 && curr.strength <= 900;

		if (bothShort && timeGap <= 450 && spatialGap <= 0.035) {
			doubleClickCandidates.push({
				centerTimeMs: Math.round((prev.centerTimeMs + curr.centerTimeMs) / 2),
				focus: { cx: (prev.focus.cx + curr.focus.cx) / 2, cy: (prev.focus.cy + curr.focus.cy) / 2 },
				strength: prev.strength + curr.strength + 500,
				kind: "double-click-like",
				source: "heuristic",
			});
		}
	}

	return [...explicitInteractionCandidates, ...dwellCandidates, ...doubleClickCandidates];
}

function buildClickClusters(
	clicks: CursorInteractionCandidate[],
	mergeGapMs: number,
): Array<{ firstMs: number; lastMs: number; focus: ZoomFocus }> {
	if (clicks.length === 0) return [];

	const sorted = [...clicks].sort((a, b) => a.centerTimeMs - b.centerTimeMs);
	const clusters: Array<{ firstMs: number; lastMs: number; focus: ZoomFocus }> = [];

	let clusterStart = sorted[0].centerTimeMs;
	let clusterEnd = sorted[0].centerTimeMs;
	let bestStrength = sorted[0].strength;
	let bestFocus = sorted[0].focus;
	let sumCx = sorted[0].focus.cx;
	let sumCy = sorted[0].focus.cy;
	let count = 1;

	for (let i = 1; i < sorted.length; i++) {
		const click = sorted[i];
		const gap = click.centerTimeMs - clusterEnd;

		if (gap <= mergeGapMs) {
			clusterEnd = Math.max(clusterEnd, click.centerTimeMs);
			if (click.strength > bestStrength) {
				bestStrength = click.strength;
				bestFocus = click.focus;
			}
			sumCx += click.focus.cx;
			sumCy += click.focus.cy;
			count += 1;
		} else {
			clusters.push({ firstMs: clusterStart, lastMs: clusterEnd, focus: bestFocus ?? { cx: sumCx / count, cy: sumCy / count } });
			clusterStart = click.centerTimeMs;
			clusterEnd = click.centerTimeMs;
			bestStrength = click.strength;
			bestFocus = click.focus;
			sumCx = click.focus.cx;
			sumCy = click.focus.cy;
			count = 1;
		}
	}

	clusters.push({ firstMs: clusterStart, lastMs: clusterEnd, focus: bestFocus ?? { cx: sumCx / count, cy: sumCy / count } });
	return clusters;
}

export function buildInteractionZoomSuggestions(params: {
	cursorTelemetry: CursorTelemetryPoint[];
	totalMs: number;
	reservedSpans?: Array<{ start: number; end: number }>;
	mergeGapMs?: number;
	padMs?: number;
}): InteractionZoomSuggestionResult {
	const { cursorTelemetry, totalMs, reservedSpans = [], mergeGapMs = CLICK_CLUSTER_MERGE_GAP_MS, padMs = CLICK_CLUSTER_PAD_MS } = params;

	if (totalMs <= 0) return { status: "no-slots", suggestions: [] };

	const normalizedSamples = normalizeCursorTelemetry(cursorTelemetry, totalMs);
	if (normalizedSamples.length === 0) return { status: "no-telemetry", suggestions: [] };
	if (normalizedSamples.length === 1 && !isExplicitClickType(normalizedSamples[0].interactionType)) {
		return { status: "no-telemetry", suggestions: [] };
	}

	const clickCandidates = detectInteractionCandidates(normalizedSamples).filter((candidate) => candidate.source === "explicit");
	if (clickCandidates.length === 0) return { status: "no-interactions", suggestions: [] };

	const clusters = buildClickClusters(clickCandidates, mergeGapMs);
	const reserved = [...reservedSpans].sort((a, b) => a.start - b.start);
	const suggestions: SuggestedZoomRegion[] = [];

	for (const cluster of clusters) {
		const regionStart = Math.max(0, cluster.firstMs - padMs);
		const regionEnd = Math.min(totalMs, cluster.lastMs + padMs);
		if (regionEnd <= regionStart) continue;

		const hasOverlap = reserved.some((span) => regionEnd > span.start && regionStart < span.end);
		if (hasOverlap) continue;

		reserved.push({ start: regionStart, end: regionEnd });
		suggestions.push({ start: regionStart, end: regionEnd, focus: cluster.focus });
	}

	if (suggestions.length === 0) return { status: "no-slots", suggestions: [] };

	suggestions.sort((a, b) => a.start - b.start);
	return { status: "ok", suggestions };
}
