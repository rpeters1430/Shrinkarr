import { execFile } from "node:child_process";
import { lstat, realpath, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { runTranscodeWithFallback } from "../transcode/runner.js";
import { probeFile } from "../media/ffprobe.js";
import type { Preset } from "../config/schema.js";
import { decide } from "../scanner/policy.js";
import { detectMidStreamResolutionChanges } from "../media/ffprobe.js";

const execFileAsync = promisify(execFile);
// originalLanguage is missing from servers older than this node.
type Assignment = { id: string; leaseId: string; leaseSeconds: number; libraryId: string; filePath: string; tempPath: string; preset: Preset; originalLanguage?: string | null };

function interruptibleDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function parseWorkerMaps(values: string[]): Map<string, string> {
  const maps = new Map<string, string>();
  for (const value of values) {
    const split = value.indexOf("=");
    if (split < 1) throw new Error(`Invalid library map "${value}"; expected libraryId=/absolute/path`);
    const id = value.slice(0, split).trim();
    const mount = value.slice(split + 1).trim();
    if (!id) throw new Error(`Invalid library ID in map "${value}"`);
    if (!isAbsolute(mount)) throw new Error(`Library map must use an absolute mount path: "${value}"`);
    if (maps.has(id)) throw new Error(`duplicate library map "${value}"`);
    maps.set(id, resolve(mount));
  }
  if (maps.size === 0) throw new Error("At least one --map libraryId=/absolute/path is required");
  return maps;
}

export function resolveWorkerPath(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Coordinator sent an unsafe library-relative path");
  }
  const base = resolve(root);
  const target = resolve(base, ...relativePath.split("/"));
  const rel = relative(base, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Worker path escaped its configured library mount");
  return target;
}

function assertWithin(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Resolved worker path escaped its mapped library mount through a symlink");
}

async function ffmpegCapabilities(): Promise<{ version?: string; encoders: string[] }> {
  try {
    const [{ stdout: versionOut, stderr: versionErr }, { stdout: encoderOut }] = await Promise.all([
      execFileAsync("ffmpeg", ["-version"], { timeout: 5000 }),
      execFileAsync("ffmpeg", ["-hide_banner", "-encoders"], { timeout: 10000 }),
    ]);
    const version = `${versionOut || versionErr}`.split(/\r?\n/, 1)[0]?.slice(0, 200);
    const encoders = [...new Set([...encoderOut.matchAll(/^\s*[VAS.]{6}\s+([\w-]+)/gm)]
      .map((match) => match[1]!)
      .filter((name) => /(?:264|265|hevc|av1|aac|opus|mp3|flac|nvenc|qsv|vaapi|amf|videotoolbox)/i.test(name)))].slice(0, 100);
    return { version, encoders };
  } catch { return { encoders: [] }; }
}

export async function runRemoteWorker(options: { coordinator: string; token: string; maps: Map<string, string> }): Promise<void> {
  const baseUrl = options.coordinator.replace(/\/+$/, "");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const ffmpeg = await ffmpegCapabilities();
  const version = ffmpeg.version;
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${baseUrl}/api/remote/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Coordinator returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    return response.json() as Promise<T>;
  };
  const capabilities = {
    ffmpegAvailable: !!version,
    ffmpegVersion: version,
    mediaKinds: ["video", "audio"] as Array<"video" | "audio">,
    libraryIds: [...options.maps.keys()],
    encoders: ffmpeg.encoders,
  };
  console.log(`[Worker] ${version ? `Connected with ${version}` : "FFmpeg is unavailable"}`);
  while (!controller.signal.aborted) {
    try {
      await request("heartbeat", capabilities);
      const claim = await request<{ job: Assignment | null; retryAfterSeconds?: number }>("claim");
      if (!claim.job) {
        await interruptibleDelay(Math.max(2, claim.retryAfterSeconds ?? 15) * 1000, controller.signal);
        continue;
      }
      const assignment = claim.job;
      const root = options.maps.get(assignment.libraryId);
      if (!root) throw new Error(`No mount configured for library ${assignment.libraryId}`);
      const mappedRoot = resolve(root);
      const realRoot = await realpath(mappedRoot);
      const lexicalInput = resolveWorkerPath(mappedRoot, assignment.filePath);
      const lexicalOutput = resolveWorkerPath(mappedRoot, assignment.tempPath);
      const inputPath = await realpath(lexicalInput);
      const actualParent = await realpath(dirname(lexicalOutput));
      assertWithin(realRoot, inputPath);
      assertWithin(realRoot, actualParent);
      const outputPath = resolve(actualParent, basename(lexicalOutput));
      try {
        await lstat(outputPath);
        throw new Error("Attempt output already exists; refusing to overwrite it");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const inputProbe = await probeFile(inputPath);
      inputProbe.originalLanguage = assignment.originalLanguage;
      const isRemux = decide(inputProbe, assignment.preset).recommendedAction === "Remux";
      let resolutionCheck = { hasMultipleResolutions: false, resolutions: [] as string[] };
      if (inputProbe.mediaKind === "video" && assignment.preset.hwaccel !== "cpu" && !isRemux) {
        try { resolutionCheck = await detectMidStreamResolutionChanges(inputPath); } catch { /* Non-fatal preflight */ }
      }
      const abort = new AbortController();
      const onStop = () => abort.abort();
      controller.signal.addEventListener("abort", onStop, { once: true });
      let percent = 0;
      const poll = setInterval(() => {
        void request<{ owned: boolean }>(`jobs/${encodeURIComponent(assignment.id)}/heartbeat`, {
          leaseId: assignment.leaseId,
          progressPercent: percent,
        }).then((status) => { if (!status.owned) abort.abort(); }).catch(() => abort.abort());
      }, 10_000);
      try {
        const result = await runTranscodeWithFallback(inputPath, outputPath, assignment.preset, inputProbe.durationSeconds,
          (progress) => { percent = progress.percent; }, {
            signal: abort.signal,
            onEncoderSelected: (encoderId) => { console.log(`[Worker] ${basename(inputPath)} using ${encoderId}`); },
          }, {
            isHdr: inputProbe.isHdr,
            colorTransfer: inputProbe.colorTransfer,
            bitDepth: inputProbe.bitDepth,
            sourceBitrateKbps: inputProbe.bitrateKbps,
            audioCodec: inputProbe.audioCodec,
            isLosslessAudio: inputProbe.isLosslessAudio,
            audioChannels: inputProbe.audioChannels,
            hasMultipleResolutions: resolutionCheck.hasMultipleResolutions,
            detectedResolutions: resolutionCheck.resolutions,
            audioTracks: inputProbe.audioTracks,
            subtitleTracks: inputProbe.subtitleTracks,
            originalLanguage: inputProbe.originalLanguage,
            sourceWidth: inputProbe.width,
            sourceHeight: inputProbe.height,
            copyVideo: isRemux,
          });
        const complete = await request<{ completed?: boolean }>(`jobs/${encodeURIComponent(assignment.id)}/complete`, {
          leaseId: assignment.leaseId,
          encoderUsed: result.encoderUsed,
        });
        if (!complete.completed) throw new Error("Coordinator did not accept completed output");
        console.log(`[Worker] Completed ${basename(inputPath)}`);
      } catch (error) {
        if (!controller.signal.aborted) {
          await request(`jobs/${encodeURIComponent(assignment.id)}/fail`, { leaseId: assignment.leaseId, error: (error as Error).message }).catch(() => {});
          console.error(`[Worker] ${basename(inputPath)}: ${(error as Error).message}`);
        }
        await rm(outputPath, { force: true }).catch(() => {});
      } finally {
        clearInterval(poll);
        controller.signal.removeEventListener("abort", onStop);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error(`[Worker] Coordinator request failed: ${(error as Error).message}`);
        await interruptibleDelay(5000, controller.signal);
      }
    }
  }
}
