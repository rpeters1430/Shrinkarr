import { describe, expect, it } from "vitest";
import {
  detectGpus,
  detectHardware,
  formatGpuName,
  resolveEncoderForPreset,
  scanRenderNodes,
} from "../src/transcode/hardware.js";

describe("Hardware Detection", () => {
  it("formats AMD Device 7550 and Navi 48 as AMD Radeon RX 9070 XT", () => {
    expect(formatGpuName("Device 7550", "amd")).toBe("AMD Radeon RX 9070 XT");
    expect(formatGpuName("AMD Device 7550", "amd")).toBe("AMD Radeon RX 9070 XT");
    expect(formatGpuName("Device 7550 (rev c0)", "amd")).toBe("AMD Radeon RX 9070 XT");
    expect(formatGpuName("Navi 48 [Radeon RX 9070/9070 XT/9070 GRE]", "amd")).toBe("AMD Radeon RX 9070 XT");
    expect(formatGpuName("Advanced Micro Devices, Inc. [AMD/ATI] Device 7550 (rev c0)", "amd")).toBe("AMD Radeon RX 9070 XT");
    expect(formatGpuName("", "amd", undefined, "7550")).toBe("AMD Radeon RX 9070 XT");
    expect(formatGpuName("", "amd", undefined, "0x7550")).toBe("AMD Radeon RX 9070 XT");
    expect(formatGpuName("Device 7551", "amd")).toBe("AMD Radeon RX 9070");
    expect(formatGpuName("Device 7552", "amd")).toBe("AMD Radeon RX 9070 GRE");
    expect(formatGpuName("Device 7570", "amd")).toBe("AMD Radeon RX 9060 XT");
    expect(formatGpuName("AMD Device 7550", "amd", "Mesa Gallium driver 25.0.7 for AMD Device 7550 (radeonsi...)")).toBe("AMD Radeon RX 9070 XT");
    expect(formatGpuName("Device 7550", "amd", "Mesa Gallium driver 25.0.7 for AMD Radeon RX 9070 XT (radeonsi...)")).toBe("AMD Radeon RX 9070 XT");
  });

  it("formats Intel device IDs accurately", () => {
    expect(formatGpuName("Raptor Lake-S GT1 [UHD Graphics 770]", "intel")).toBe("Intel UHD Graphics 770");
    expect(formatGpuName("", "intel", undefined, "0xa780")).toBe("Intel UHD Graphics 770");
    expect(formatGpuName("", "intel", undefined, "0x56a0")).toBe("Intel Arc A770");
  });
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
