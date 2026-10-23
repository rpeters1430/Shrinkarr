import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Each test encode exits with the code this returns for its ffmpeg args.
let exitCodeFor: (args: string[]) => number = () => 0;
const spawnedArgs: string[][] = [];

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("not available in test");
  }),
  spawn: vi.fn((_cmd: string, args: string[]) => {
    spawnedArgs.push(args);
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    const code = exitCodeFor(args);
    setImmediate(() => {
      proc.stderr.emit("data", Buffer.from(code === 0
        ? "frame=   24 fps=120 speed=4.0x\n"
        : "No usable encoding entrypoint found for profile VAProfileHEVCMain (17).\n"));
      proc.emit("close", code);
    });
    return proc;
  }),
}));

const { probeVaapiEncoder } = await import("../src/transcode/hardware.js");

describe("probeVaapiEncoder", () => {
  beforeEach(() => {
    spawnedArgs.length = 0;
  });

  it("accepts a GPU that only encodes in low-power mode", async () => {
    exitCodeFor = (args) => (args.includes("-low_power") ? 0 : 1);
    const result = await probeVaapiEncoder("hevc_vaapi", "/dev/dri/renderD128", "other");
    expect(result.ok).toBe(true);
    expect(result.lowPower).toBe(true);
    expect(spawnedArgs).toHaveLength(2);
  });

  it("keeps the default mode when it works on a non-Intel GPU", async () => {
    exitCodeFor = () => 0;
    const result = await probeVaapiEncoder("hevc_vaapi", "/dev/dri/renderD128", "amd");
    expect(result).toMatchObject({ ok: true, lowPower: false });
    expect(spawnedArgs).toHaveLength(1);
  });

  it("reports the default mode's error when both modes fail", async () => {
    exitCodeFor = () => 1;
    const result = await probeVaapiEncoder("hevc_vaapi", "/dev/dri/renderD128", "intel");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No usable encoding entrypoint/);
  });
});
