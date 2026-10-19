import { runTranscode, type ProgressInfo } from "../transcode/runner.js";

export type HealthCheckMode = "quick" | "thorough";

export interface HealthCheckResult {
  healthy: boolean;
  // Decoder errors ffmpeg reported, most relevant first. Empty when healthy.
  errors: string[];
}

export interface HealthCheckOptions {
  signal?: AbortSignal;
  lowPriority?: boolean;
  onProgress?: (percent: number) => void;
  onLog?: (text: string) => void;
}

const QUICK_SAMPLE_SECONDS = 10;
const MAX_REPORTED_ERRORS = 20;

function decodeArgs(path: string, startSeconds?: number, durationSeconds?: number): string[] {
  const args = ["-v", "error"];
  if (startSeconds !== undefined && startSeconds > 0) args.push("-ss", startSeconds.toFixed(2));
  args.push("-i", path);
  if (durationSeconds !== undefined) args.push("-t", durationSeconds.toFixed(2));
  args.push("-map", "0:v:0?", "-map", "0:a?", "-f", "null", "-");
  return args;
}

// Messages from the null output the decoded frames are thrown into, not
// from reading the file. Live-stream recordings often repeat timestamps,
// which the null muxer complains about on every frame even though each one
// decodes fine. ffmpeg 6 tags these "[null @ ...]", ffmpeg 7 "[out#0/null @ ...]".
const OUTPUT_SIDE_LINE = /^\[(?:null|out#\d+\/null)\b/;

export function errorLines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0
      && !/^ffmpeg exited with code/.test(line)
      && !/^Last message repeated \d+ times$/.test(line)
      && !OUTPUT_SIDE_LINE.test(line));
}

// Start, middle and end: a truncated download or a bad sector usually shows
// up in one of them, and three short decodes take seconds rather than the
// length of the film.
export function quickSamplePoints(durationSeconds: number): number[] {
  if (durationSeconds <= QUICK_SAMPLE_SECONDS * 4) return [0];
  return [
    0,
    Math.max(0, durationSeconds / 2 - QUICK_SAMPLE_SECONDS / 2),
    Math.max(0, durationSeconds - QUICK_SAMPLE_SECONDS - 5),
  ];
}

/**
 * Decodes the file (or samples of it) and discards the output. Any error
 * ffmpeg prints while decoding marks the file as corrupt.
 */
export async function runHealthCheck(
  path: string,
  mode: HealthCheckMode,
  durationSeconds: number,
  options: HealthCheckOptions = {},
): Promise<HealthCheckResult> {
  const runs: Array<{ start?: number; length?: number; expected: number }> =
    mode === "thorough" || durationSeconds <= QUICK_SAMPLE_SECONDS * 4
      ? [{ expected: durationSeconds }]
      : quickSamplePoints(durationSeconds).map((start) => ({ start, length: QUICK_SAMPLE_SECONDS, expected: QUICK_SAMPLE_SECONDS }));

  const errors: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const onProgress = (info: ProgressInfo) => {
      options.onProgress?.(Math.round(((i * 100 + info.percent) / runs.length) * 10) / 10);
    };
    try {
      const stderr = await runTranscode(decodeArgs(path, run.start, run.length), run.expected, onProgress, {
        lowPriority: options.lowPriority,
        signal: options.signal,
        onLog: options.onLog,
      });
      errors.push(...errorLines(stderr));
    } catch (err) {
      // Not being able to run ffmpeg at all says nothing about the file.
      if (options.signal?.aborted || /^Failed to spawn/.test((err as Error).message)) throw err;
      const message = (err as Error).message.replace(/^ffmpeg exited with code -?\d+:\s*/, "");
      const lines = errorLines(message);
      errors.push(...(lines.length > 0 ? lines : [(err as Error).message]));
    }
  }

  return { healthy: errors.length === 0, errors: errors.slice(0, MAX_REPORTED_ERRORS) };
}
