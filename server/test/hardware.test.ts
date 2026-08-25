import { describe, expect, it } from "vitest";
import { detectGpus, detectHardware, resolveEncoderForPreset, scanRenderNodes } from "../src/transcode/hardware.js";

describe("Hardware Detection", () => {
  it("detects GPUs without throwing", () => {
    const gpus = detectGpus();
    expect(Array.isArray(gpus)).toBe(true);
  });

  it("scans render nodes without throwing", () => {
    const nodes = scanRenderNodes();
    expect(Array.isArray(nodes)).toBe(true);
    for (const node of nodes) {
      expect(typeof node.path).toBe("string");
      expect(typeof node.readable).toBe("boolean");
      expect(typeof node.writable).toBe("boolean");
      expect(typeof node.codecs).toBe("object");
    }
  });

  it("produces a comprehensive hardware report", async () => {
    const report = await detectHardware();
    expect(report).toBeDefined();
    expect(typeof report.os).toBe("string");
    expect(Array.isArray(report.gpus)).toBe(true);
    expect(Array.isArray(report.renderNodes)).toBe(true);
    expect(Array.isArray(report.encoders)).toBe(true);
    expect(typeof report.recommendedHevc).toBe("string");
    expect(typeof report.recommendedAv1).toBe("string");
    expect(typeof report.recommendedH264).toBe("string");
    expect(report.recommendations).toBeDefined();
    expect(report.recommendations?.hevc.encoderId).toBe(report.recommendedHevc);
    expect(report.recommendations?.av1.encoderId).toBe(report.recommendedAv1);
    expect(report.recommendations?.h264.encoderId).toBe(report.recommendedH264);

    // Verified encoders should have valid structure
    for (const enc of report.encoders) {
      expect(typeof enc.id).toBe("string");
      expect(typeof enc.name).toBe("string");
      expect(typeof enc.working).toBe("boolean");
      if (enc.hwaccelType === "vaapi") {
        expect(typeof enc.devicePath).toBe("string");
      }
    }
  });

  it("resolves CPU encoder when preferred", async () => {
    const hevcCpu = await resolveEncoderForPreset("hevc", "cpu");
    expect(hevcCpu.encoderId).toBe("libx265");
    expect(hevcCpu.hwaccelType).toBe("cpu");

    const av1Cpu = await resolveEncoderForPreset("av1", "cpu");
    expect(av1Cpu.encoderId).toBe("libsvtav1");
    expect(av1Cpu.hwaccelType).toBe("cpu");

    const h264Cpu = await resolveEncoderForPreset("h264", "cpu");
    expect(h264Cpu.encoderId).toBe("libx264");
    expect(h264Cpu.hwaccelType).toBe("cpu");
  });

  it("resolves valid encoder and device for auto preference", async () => {
    const report = await detectHardware();
    const hevcAuto = await resolveEncoderForPreset("hevc", "auto");
    expect(typeof hevcAuto.encoderId).toBe("string");
    expect(hevcAuto.encoderId).toBe(report.recommendedHevc);

    const av1Auto = await resolveEncoderForPreset("av1", "auto");
    expect(typeof av1Auto.encoderId).toBe("string");
    expect(av1Auto.encoderId).toBe(report.recommendedAv1);

    const h264Auto = await resolveEncoderForPreset("h264", "auto");
    expect(typeof h264Auto.encoderId).toBe("string");
    expect(h264Auto.encoderId).toBe(report.recommendedH264);

    if (report.encoders.some((e) => e.hwaccelType !== "cpu")) {
      expect(hevcAuto.hwaccelType).not.toBe("cpu");
    }
  });
});
