import { execFile, spawnSync } from "node:child_process";
import { createWriteStream, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getFfmpegPath } from "./binaries.js";
import {
	buildCaptionTextFromWords,
	parseSrtCues,
	parseWhisperJsonCues,
	shouldRetryWhisperWithoutJson,
	type CaptionCue,
} from "./captionParser.js";
import { getUserDataDir } from "./paths.js";

const execFileAsync = promisify(execFile);

const WHISPER_MODEL_DOWNLOAD_URL =
	"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";

function repoRoot(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	// dist/whisper.js or src/whisper.ts -> mcp-server/ -> repo root
	return path.resolve(here, "..", "..");
}

function getNativeArchTag(): string {
	const platform = process.platform;
	if (platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	if (platform === "win32") return process.arch === "arm64" ? "win32-arm64" : "win32-x64";
	if (platform === "linux") return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
	return `${platform}-${process.arch}`;
}

async function isExecutableFile(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath, fsConstants.R_OK | fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Mirrors electron/ipc/captions/generate.ts `resolveWhisperExecutablePath`, adapted to
 * look for Recordly's own bundled `electron/native/bin/<arch>/whisper-cli` relative to
 * this repo instead of an Electron app bundle path. */
export async function resolveWhisperExecutablePath(preferredPath?: string | null): Promise<string> {
	const binaryName = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
	const bundledPath = path.join(repoRoot(), "electron", "native", "bin", getNativeArchTag(), binaryName);

	const candidatePaths = [
		preferredPath?.trim() || null,
		process.env["RECORDLY_WHISPER_BINARY"]?.trim() || null,
		bundledPath,
		process.platform === "darwin" ? "/opt/homebrew/bin/whisper-cli" : null,
		process.platform === "darwin" ? "/usr/local/bin/whisper-cli" : null,
	].filter((value): value is string => Boolean(value));

	for (const candidate of candidatePaths) {
		const resolved = path.resolve(candidate);
		if (await isExecutableFile(resolved)) return resolved;
	}

	const pathCommand = process.platform === "win32" ? "where" : "which";
	const binaryNames =
		process.platform === "win32"
			? ["whisper-cli.exe", "whisper.exe", "main.exe"]
			: ["whisper-cli", "whisper-cpp", "whisper", "main"];

	for (const name of binaryNames) {
		const result = spawnSync(pathCommand, [name], { encoding: "utf-8" });
		if (result.status === 0) {
			const resolved = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
			if (resolved && (await isExecutableFile(resolved))) return resolved;
		}
	}

	throw new Error(
		`No Whisper runtime found. Looked for a bundled binary at ${bundledPath}, then common install locations, then $PATH. ` +
			"Run `npm run build:whisper-runtime` in the main Recordly repo, or set RECORDLY_WHISPER_BINARY.",
	);
}

export function getWhisperModelPath(): string {
	return process.env["RECORDLY_WHISPER_MODEL"] ?? path.join(getUserDataDir(), "whisper", "ggml-small.bin");
}

function downloadFileWithProgress(
	url: string,
	destinationPath: string,
	onProgress: (percent: number) => void,
): Promise<void> {
	const request = (currentUrl: string, redirectCount = 0): Promise<void> =>
		new Promise((resolve, reject) => {
			const req = httpsGet(currentUrl, { timeout: 30_000 }, (response) => {
				const statusCode = response.statusCode ?? 0;
				const location = response.headers.location;

				if (statusCode >= 300 && statusCode < 400 && location) {
					response.resume();
					if (redirectCount >= 5) {
						reject(new Error("Too many redirects while downloading the Whisper model."));
						return;
					}
					void request(new URL(location, currentUrl).toString(), redirectCount + 1)
						.then(resolve)
						.catch(reject);
					return;
				}

				if (statusCode < 200 || statusCode >= 300) {
					response.resume();
					reject(new Error(`Whisper model download failed with status ${statusCode}.`));
					return;
				}

				const totalBytes = Number.parseInt(String(response.headers["content-length"] ?? "0"), 10);
				let downloadedBytes = 0;
				const fileStream = createWriteStream(destinationPath);

				response.on("data", (chunk: Buffer) => {
					downloadedBytes += chunk.length;
					if (Number.isFinite(totalBytes) && totalBytes > 0) {
						onProgress(Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)));
					}
				});
				response.on("error", (error) => fileStream.destroy(error));
				fileStream.on("error", (error) => {
					response.destroy(error);
					reject(error);
				});
				fileStream.on("finish", () => resolve());
				response.pipe(fileStream);
			});
			req.on("error", reject);
			req.on("timeout", () => req.destroy(new Error("Whisper model download timed out.")));
		});

	return request(url);
}

export async function ensureWhisperModel(onProgress?: (percent: number) => void): Promise<string> {
	const modelPath = getWhisperModelPath();
	try {
		await fs.access(modelPath, fsConstants.R_OK);
		return modelPath;
	} catch {
		// Not present yet — download it below.
	}

	await fs.mkdir(path.dirname(modelPath), { recursive: true });
	const tempPath = `${modelPath}.download`;
	await downloadFileWithProgress(WHISPER_MODEL_DOWNLOAD_URL, tempPath, (percent) => {
		onProgress?.(percent);
	});
	await fs.rename(tempPath, modelPath);
	return modelPath;
}

export interface TranscribeOptions {
	language?: string;
	whisperBinaryPath?: string;
}

/** Mirrors electron/ipc/captions/generate.ts `generateAutoCaptionsFromVideo`. */
export async function transcribeVideo(
	videoPath: string,
	options: TranscribeOptions = {},
): Promise<CaptionCue[]> {
	const whisperExecutablePath = await resolveWhisperExecutablePath(options.whisperBinaryPath);
	const whisperModelPath = await ensureWhisperModel();

	const tempBase = path.join(os.tmpdir(), `recordly-mcp-captions-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	const wavPath = `${tempBase}.wav`;
	const outputBase = `${tempBase}-whisper`;
	const srtPath = `${outputBase}.srt`;
	const jsonPath = `${outputBase}.json`;

	try {
		await execFileAsync(getFfmpegPath(), [
			"-y",
			"-i",
			videoPath,
			"-map",
			"0:a:0",
			"-vn",
			"-ac",
			"1",
			"-ar",
			"16000",
			"-c:a",
			"pcm_s16le",
			wavPath,
		]);

		const language = options.language?.trim() || "auto";
		const whisperBaseArgs = ["-m", whisperModelPath, "-f", wavPath, "-osrt", "-of", outputBase, "-l", language, "-np"];

		let jsonEnabled = true;
		try {
			await execFileAsync(whisperExecutablePath, [...whisperBaseArgs, "-ojf"], {
				timeout: 30 * 60 * 1000,
				maxBuffer: 20 * 1024 * 1024,
			});
		} catch (error) {
			if (!shouldRetryWhisperWithoutJson(error)) throw error;
			jsonEnabled = false;
			await execFileAsync(whisperExecutablePath, whisperBaseArgs, {
				timeout: 30 * 60 * 1000,
				maxBuffer: 20 * 1024 * 1024,
			});
		}

		const timedCues = jsonEnabled ? parseWhisperJsonCues(await fs.readFile(jsonPath, "utf-8")) : [];
		const cues = timedCues.length > 0 ? timedCues : parseSrtCues(await fs.readFile(srtPath, "utf-8"));
		if (cues.length === 0) {
			throw new Error("Whisper completed, but no caption cues were produced (is there speech in the audio?).");
		}

		return cues;
	} finally {
		await Promise.allSettled([
			fs.rm(wavPath, { force: true }),
			fs.rm(srtPath, { force: true }),
			fs.rm(jsonPath, { force: true }),
		]);
	}
}

export { buildCaptionTextFromWords };
