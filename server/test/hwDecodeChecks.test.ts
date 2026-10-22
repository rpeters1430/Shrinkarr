import { beforeEach, describe, expect, it, vi } from "vitest";

const { runTranscode } = vi.hoisted(() => ({ runTranscode: vi.fn() }));
vi.mock("../src/transcode/runner.js", () => ({ runTranscode }));

import { decodeArgs, runHealthCheck } from "../src/media/healthCheck.js";
import { hwDecodeFailureLine } from "../src/transcode/hwDecode.js";
import { buildSsimArgs, runVideoQualityGate } from "../src/transcode/qualityGate.js";

const DEVICE = "/dev/dri/renderD128";
const gateOptions = {
  minimumSsim: 0.95,
  sourceWidth: 1920,
  sourceHeight: 1080,
  sourceVideoDurationSeconds: 60,
  outputVideoDurationSeconds: 60,
  frameRate: 24,
};

describe("GPU decode for checks", () => {
  beforeEach(() => {
    runTranscode.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("puts VAAPI decode flags ahead of the input only when a device is given", () => {
    expect(decodeArgs("/m/a.mkv", 30, 10, DEVICE)).toEqual([
      "-v", "error", "-hwaccel", "vaapi", "-hwaccel_device", DEVICE,
      "-ss", "30.00", "-i", "/m/a.mkv", "-t", "10.00",
      "-map", "0:v:0?", "-map", "0:a?", "-f", "null", "-",
    ]);
    expect(decodeArgs("/m/a.mkv")).not.toContain("-hwaccel");
  });

  it("decodes both SSIM inputs on the GPU", () => {
    const args = buildSsimArgs("/m/src.mkv", "/m/out.mkv", 1920, 1080, DEVICE);
    expect(args.slice(0, 12)).toEqual([
      "-hwaccel", "vaapi", "-hwaccel_device", DEVICE, "-i", "/m/src.mkv",
      "-hwaccel", "vaapi", "-hwaccel_device", DEVICE, "-i", "/m/out.mkv",
    ]);
  });

  it("tells GPU setup errors apart from file corruption", () => {
    expect(hwDecodeFailureLine(["[hevc @ 0x1] Failed setup for format vaapi: hwaccel initialisation returned error."])).toBeDefined();
    expect(hwDecodeFailureLine(["Device creation failed: -5."])).toBeDefined();
    expect(hwDecodeFailureLine(["[h264 @ 0x1] error while decoding MB 4 5, bytestream -7"])).toBeUndefined();
    expect(hwDecodeFailureLine(["[matroska @ 0x1] File ended prematurely"])).toBeUndefined();
  });

  it("re-checks on the CPU and logs it when the GPU can't decode", async () => {
    runTranscode
      .mockRejectedValueOnce(new Error("ffmpeg exited with code 1: Device creation failed: -5."))
      .mockResolvedValueOnce("");
    const log: string[] = [];
    const result = await runHealthCheck("/m/a.mkv", "thorough", 60, { hwDecodeDevice: DEVICE, onLog: (t) => log.push(t) });

    expect(result).toEqual({ status: "healthy", errors: [] });
    expect(runTranscode.mock.calls[0][0]).toContain("-hwaccel");
    expect(runTranscode.mock.calls[1][0]).not.toContain("-hwaccel");
    expect(log.some((line) => line.includes("falling back to CPU decode"))).toBe(true);
  });

  it("stays on the CPU for the remaining quick samples after a fallback", async () => {
    runTranscode
      .mockResolvedValueOnce("[hevc @ 0x1] No support for codec hevc profile 4.")
      .mockResolvedValue("");
    await runHealthCheck("/m/a.mkv", "quick", 3600, { hwDecodeDevice: DEVICE });

    const usedGpu = runTranscode.mock.calls.map((call) => (call[0] as string[]).includes("-hwaccel"));
    expect(usedGpu).toEqual([true, false, false, false]);
  });

  it("still reports corruption found during a GPU decode", async () => {
    runTranscode.mockResolvedValueOnce("[h264 @ 0x1] Invalid NAL unit size (1234 > 99).");
    const result = await runHealthCheck("/m/a.mkv", "thorough", 60, { hwDecodeDevice: DEVICE });
    expect(result.status).toBe("corrupt");
    expect(runTranscode).toHaveBeenCalledTimes(1);
  });

  it("retries the SSIM gate on the CPU when the GPU decode fails", async () => {
    runTranscode
      .mockRejectedValueOnce(new Error("ffmpeg exited with code 1: [AVHWDeviceContext @ 0x1] Failed to initialise VAAPI connection: -1"))
      .mockResolvedValueOnce("SSIM Y:0.98 All:0.97 (15.2)");
    const log: string[] = [];
    await expect(runVideoQualityGate("s.mkv", "o.mkv", 60, { ...gateOptions, hwDecodeDevice: DEVICE, onLog: (t) => log.push(t) }))
      .resolves.toMatchObject({ ok: true, score: 0.97 });
    expect(runTranscode.mock.calls[1][0]).not.toContain("-hwaccel");
    expect(log.some((line) => line.includes("falling back to CPU decode"))).toBe(true);
  });

  it("doesn't retry the SSIM gate for failures unrelated to the GPU", async () => {
    runTranscode.mockRejectedValueOnce(new Error("ffmpeg exited with code 1: o.mkv: No such file or directory"));
    await expect(runVideoQualityGate("s.mkv", "o.mkv", 60, { ...gateOptions, hwDecodeDevice: DEVICE }))
      .rejects.toThrow("No such file");
    expect(runTranscode).toHaveBeenCalledTimes(1);
  });
});
