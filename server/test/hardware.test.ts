import { describe, expect, it } from "vitest";
import { detectGpus, resolveEncoderForPreset } from "../src/transcode/hardware.js";

describe("Hardware Detection", () => {
  it("detects GPUs without throwing", () => {
    const gpus = detectGpus();
    expect(Array.isArray(gpus)).toBe(true);
  });

  it("resolves CPU encoder when preferred", async () => {
    const hevcCpu = await resolveEncoderForPreset("hevc", "cpu");
    expect(hevcCpu.encoderId).toBe("libx265");

    const av1Cpu = await resolveEncoderForPreset("av1", "cpu");
    expect(av1Cpu.encoderId).toBe("libsvtav1");

    const h264Cpu = await resolveEncoderForPreset("h264", "cpu");
    expect(h264Cpu.encoderId).toBe("libx264");
  });

  it("resolves valid encoder for auto preference", async () => {
    const hevcAuto = await resolveEncoderForPreset("hevc", "auto");
    expect(typeof hevcAuto.encoderId).toBe("string");
    expect(hevcAuto.encoderId.length).toBeGreaterThan(0);
  });
});
