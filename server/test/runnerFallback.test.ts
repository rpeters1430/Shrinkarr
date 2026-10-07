import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Each spawned "ffmpeg" exits with the code chosen by this function, based on
// which encoder its args ask for.
let exitCodeFor: (args: string[]) => number = () => 0;
const spawnedEncoders: string[] = [];

vi.mock("node:child_process", () => ({
  spawn: vi.fn((_cmd: string, args: string[]) => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
      kill: () => void;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 0;
    proc.kill = () => {};
    const encoder = args[args.indexOf("-c:v") + 1];
    spawnedEncoders.push(encoder);
    const code = exitCodeFor(args);
    setImmediate(() => {
      if (code !== 0) proc.stderr.emit("data", Buffer.from(`Stream #0:0 -> #0:0\n[${encoder}] Failed to initialise VAAPI connection\n`));
      proc.emit("close", code);
    });
    return proc;
  }),
}));

vi.mock("../src/transcode/hardware.js", () => ({
  resolveEncoderForPreset: vi.fn(async (_codec: string, pref: string) =>
    pref === "cpu"
      ? { encoderId: "libx265", hwaccelType: "cpu" }
      : { encoderId: "hevc_vaapi", hwaccelType: "vaapi", devicePath: "/dev/dri/renderD128" },
  ),
  explainMissingHardware: vi.fn(() => undefined),
  listAlternateHardwareEncoders: vi.fn(async () => [{ encoderId: "hevc_qsv", hwaccelType: "qsv" }]),
}));

const { runTranscodeWithFallback, summarizeFfmpegError } = await import("../src/transcode/runner.js");

const preset = {
  id: "balanced",
  mediaKind: "video",
  targetCodec: "hevc",
  hwaccel: "auto",
  crf: 24,
  targetContainer: "mkv",
  subtitleMode: "drop",
  audioMode: "copy",
  preserveHdr: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe("runTranscodeWithFallback hardware chain", () => {
  beforeEach(() => {
    spawnedEncoders.length = 0;
  });

  it("tries an alternate hardware encoder before falling back to CPU", async () => {
    exitCodeFor = (args) => (args.includes("hevc_vaapi") ? 1 : 0);
    const selected: string[] = [];
    const result = await runTranscodeWithFallback("/in.mkv", "/out.mkv", preset, 60, () => {}, {
      lowPriority: false,
      onEncoderSelected: (id, mode) => selected.push(`${id}:${mode}`),
    });
    expect(result).toEqual({ usedHwaccel: true, encoderUsed: "hevc_qsv" });
    expect(spawnedEncoders).toEqual(["hevc_vaapi", "hevc_vaapi", "hevc_qsv"]);
    expect(selected).not.toContain("libx265:cpu");
  });

  it("reports why it fell back when every hardware encoder fails", async () => {
    exitCodeFor = (args) => (args.includes("libx265") ? 0 : 1);
    let reason: string | undefined;
    const result = await runTranscodeWithFallback("/in.mkv", "/out.mkv", preset, 60, () => {}, {
      lowPriority: false,
      onEncoderSelected: (_id, mode, fallbackReason) => {
        if (mode === "cpu") reason = fallbackReason;
      },
    });
    expect(result).toEqual({ usedHwaccel: false, encoderUsed: "libx265" });
    expect(reason).toBe("hevc_qsv: Stream #0:0 -> #0:0 | [hevc_qsv] Failed to initialise VAAPI connection");
  });

  it("skips GPU decode directly to software decode when hasMultipleResolutions is true", async () => {
    exitCodeFor = () => 0;
    const selected: string[] = [];
    const result = await runTranscodeWithFallback(
      "/in.mkv",
      "/out.mkv",
      preset,
      60,
      () => {},
      {
        lowPriority: false,
        onEncoderSelected: (id, mode) => selected.push(`${id}:${mode}`),
      },
      {
        hasMultipleResolutions: true,
        detectedResolutions: ["1080x1440", "1920x1080"],
      },
    );
    expect(result).toEqual({ usedHwaccel: true, encoderUsed: "hevc_vaapi" });
    // Exactly one attempt on hevc_vaapi (directly with software decode, no hwDecode attempt first)
    expect(spawnedEncoders).toEqual(["hevc_vaapi"]);
    expect(selected).toEqual(["hevc_vaapi:gpu-encode"]);
  });
});

describe("summarizeFfmpegError", () => {
  it("keeps the last meaningful stderr lines and drops the exit-code prefix", () => {
    const msg = "ffmpeg exited with code 234: banner\nInput #0\n[hevc_vaapi] No usable encoding profile found.\nError while opening encoder\n";
    expect(summarizeFfmpegError(msg)).toBe("[hevc_vaapi] No usable encoding profile found. | Error while opening encoder");
  });

  it("truncates very long output", () => {
    expect(summarizeFfmpegError("x".repeat(1000)).length).toBe(300);
  });
});
