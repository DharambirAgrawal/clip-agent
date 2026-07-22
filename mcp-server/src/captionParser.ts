/**
 * Ported from electron/ipc/captions/parser.ts, which has no Electron dependency of its
 * own — kept behaviorally identical so caption cues line up with what the desktop app's
 * own auto-caption feature would produce from the same whisper.cpp JSON/SRT output.
 */

export interface CaptionWord {
	text: string;
	startMs: number;
	endMs: number;
	leadingSpace?: boolean;
}

export interface CaptionCue {
	id: string;
	startMs: number;
	endMs: number;
	text: string;
	words?: CaptionWord[];
}

interface WhisperJsonToken {
	text?: unknown;
	offsets?: { from?: unknown; to?: unknown };
}

interface WhisperJsonSegment {
	text?: unknown;
	offsets?: { from?: unknown; to?: unknown };
	tokens?: unknown;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function buildCaptionTextFromWords(words: CaptionWord[]): string {
	return words
		.map((word, index) => `${index > 0 && word.leadingSpace ? " " : ""}${word.text}`)
		.join("")
		.trim();
}

export function parseWhisperJsonWords(tokens: unknown): CaptionWord[] {
	if (!Array.isArray(tokens)) return [];

	const words: CaptionWord[] = [];
	let nextLeadingSpace = false;

	for (const token of tokens) {
		if (!token || typeof token !== "object") continue;
		const tokenData = token as WhisperJsonToken;
		const tokenText = typeof tokenData.text === "string" ? tokenData.text : "";
		if (!tokenText) continue;
		// whisper.cpp emits control tokens like "[_BEG_]" with zero-width offsets
		// (from === to). They aren't real words — skip them rather than letting their
		// invalid timing bail out word-timing for the entire segment.
		if (/^\[.*\]$/.test(tokenText.trim())) continue;

		const tokenStartMs = isFiniteNumber(tokenData.offsets?.from)
			? Math.round(tokenData.offsets.from)
			: null;
		const tokenEndMs = isFiniteNumber(tokenData.offsets?.to)
			? Math.round(tokenData.offsets.to)
			: null;
		const parts = tokenText.match(/\s+|[^\s]+/g) ?? [];

		for (const part of parts) {
			if (/^\s+$/.test(part)) {
				nextLeadingSpace = words.length > 0;
				continue;
			}
			const hasValidTiming =
				tokenStartMs != null && tokenEndMs != null && tokenEndMs > tokenStartMs;
			const previousWord = words.length > 0 ? words[words.length - 1] : null;

			// whisper.cpp gives some real tokens (often trailing punctuation) zero-width
			// offsets. Rather than discarding word-level timing for the whole segment,
			// attach them to the previous word when possible, or drop just this token.
			if (!hasValidTiming) {
				if (previousWord && !nextLeadingSpace) {
					previousWord.text += part;
				}
				continue;
			}

			if (!previousWord || nextLeadingSpace) {
				words.push({
					text: part,
					startMs: tokenStartMs,
					endMs: tokenEndMs,
					...(words.length > 0 && nextLeadingSpace ? { leadingSpace: true } : {}),
				});
			} else {
				previousWord.text += part;
				previousWord.endMs = Math.max(previousWord.endMs, tokenEndMs);
			}
			nextLeadingSpace = false;
		}
	}

	return words.filter((word) => word.text.trim().length > 0);
}

export function parseWhisperJsonCues(content: string): CaptionCue[] {
	try {
		const parsed = JSON.parse(content) as { transcription?: unknown };
		if (!Array.isArray(parsed.transcription)) return [];

		return parsed.transcription
			.map((segment, index) => {
				if (!segment || typeof segment !== "object") return null;
				const segmentData = segment as WhisperJsonSegment;
				const startMs = isFiniteNumber(segmentData.offsets?.from)
					? Math.round(segmentData.offsets.from)
					: null;
				const endMs = isFiniteNumber(segmentData.offsets?.to)
					? Math.round(segmentData.offsets.to)
					: null;
				const segmentText =
					typeof segmentData.text === "string" ? segmentData.text.trim() : "";
				if (startMs == null || endMs == null || endMs <= startMs) return null;

				const words = parseWhisperJsonWords(segmentData.tokens);
				const text = words.length > 0 ? buildCaptionTextFromWords(words) : segmentText;
				if (!text) return null;

				return {
					id: `caption-${index + 1}`,
					startMs,
					endMs,
					text,
					...(words.length > 0 ? { words } : {}),
				};
			})
			.filter((cue): cue is CaptionCue => cue != null);
	} catch {
		return [];
	}
}

function parseSrtTimestamp(value: string): number | null {
	const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
	if (!match) return null;
	const [, hours, minutes, seconds, milliseconds] = match;
	return (
		Number(hours) * 60 * 60 * 1000 +
		Number(minutes) * 60 * 1000 +
		Number(seconds) * 1000 +
		Number(milliseconds)
	);
}

export function parseSrtCues(content: string): CaptionCue[] {
	return content
		.split(/\r?\n\r?\n/)
		.map((block, index) => {
			const lines = block.split(/\r?\n/).map((line) => line.trim());
			const timingLine = lines.find((line) => line.includes("-->"));
			if (!timingLine) return null;

			const [rawStart, rawEnd] = timingLine.split("-->").map((part) => part.trim());
			const startMs = parseSrtTimestamp(rawStart);
			const endMs = parseSrtTimestamp(rawEnd);
			if (startMs == null || endMs == null || endMs <= startMs) return null;

			const text = lines
				.slice(lines.indexOf(timingLine) + 1)
				.filter((line) => line.length > 0)
				.join("\n")
				.trim();
			if (!text) return null;

			return { id: `caption-${index + 1}`, startMs, endMs, text };
		})
		.filter((cue): cue is CaptionCue => cue != null);
}

export function shouldRetryWhisperWithoutJson(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /unknown argument|output-json-full|output-json|ojf|\boj\b/i.test(message);
}
