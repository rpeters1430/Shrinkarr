import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Each fake ffmpeg reports progress through the source, writing `bytesPerSecond`
// of output per second of video, unless it is killed first.
let bytesPerSecond = 0;
const spawned: Array<{ encoder: string; killed: boolean }> = [];

vi.mock("node:child_process", () => ({
  spawn: vi.fn((_cmd: string, args: string[]) => {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: () => void };
    const record = { encoder: args[args.indexOf("-c:v") + 1], killed: false };
    spawned.push(record);
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 0;
    proc.kill = () => {
      record.killed = true;
    };
    setImmediate(() => {
      for (let second = 10; second <= 100 && !record.killed; second += 10) {
        proc.stdout.emit("data", Buffer.from(`total_size=${second * bytesPerSecond}\nout_time_ms=${second * 1_000_000}\n`));
      }
      proc.emit("close", record.killed ? null : 0);
    });
    return proc;
  }),
}));

vi.mock("../src/transcode/hardware.js", () => ({
  resolveEncoderForPreset: vi.fn(async () => ({ encoderId: "hevc_vaapi", hwaccelType: "vaapi", devicePath: "/dev/dri/renderD128" })),
  explainMissingHardware: vi.fn(() => undefined),
  listAlternateHardwareEncoders: vi.fn(async () => [{ encoderId: "hevc_qsv", hwaccelType: "qsv" }]),
}));

const { runTranscodeWithFallback, OutputTooLargeError } = await import("../src/transcode/runner.js");
const { DEFAULT_PRESETS } = await import("../src/config/schema.js");

const preset = { ...DEFAULT_PRESETS[0], hwaccel: "auto" as const };

describe("stopping an encode that won't come out smaller", () => {
  beforeEach(() => {
    spawned.length = 0;
  });

  it("kills ffmpeg once the projected output reaches the original size", async () => {
    // 100s of video at 12 bytes/s heads for 1200 bytes against a 1000 byte original.
    bytesPerSecond = 12;
    const error = await runTranscodeWithFallback("/in.mkv", "/out.mkv", preset, 100, () => {}, { maxOutputBytes: 1000, allowCpuFallback: true })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OutputTooLargeError);
    expect((error as InstanceType<typeof OutputTooLargeError>).percent).toBe(10);
    // Not retried on another encoder or the CPU: those would grow it too.
    expect(spawned).toEqual([{ encoder: "hevc_vaapi", killed: true }]);
  });

  it("waits for a settled projection when the output is only slightly too big", async () => {
    // Heading for 1050 bytes: within the early margin, so it runs to 30%.
    bytesPerSecond = 10.5;
    const error = await runTranscodeWithFallback("/in.mkv", "/out.mkv", preset, 100, () => {}, { maxOutputBytes: 1000 })
      .catch((err: unknown) => err);
    expect((error as InstanceType<typeof OutputTooLargeError>).percent).toBe(30);
  });

  it("lets an encode that is shrinking the file finish", async () => {
    bytesPerSecond = 6;
    const result = await runTranscodeWithFallback("/in.mkv", "/out.mkv", preset, 100, () => {}, { maxOutputBytes: 1000 });
    expect(result.encoderUsed).toBe("hevc_vaapi");
    expect(spawned[0].killed).toBe(false);
  });

  it("does nothing without a limit", async () => {
    bytesPerSecond = 50;
    await expect(runTranscodeWithFallback("/in.mkv", "/out.mkv", preset, 100, () => {}, {})).resolves.toMatchObject({ encoderUsed: "hevc_vaapi" });
  });
});
