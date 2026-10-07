import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

let mockOutput = "";
let mockExitCode = 0;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
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
    setImmediate(() => {
      proc.stdout.emit("data", Buffer.from(mockOutput));
      proc.emit("close", mockExitCode);
    });
    return proc;
  }),
}));

const { detectMidStreamResolutionChanges } = await import("../src/media/ffprobe.js");

describe("detectMidStreamResolutionChanges", () => {
  it("detects single resolution stream", async () => {
    mockOutput = "1920,1080,\n1920,1080,\n1920,1080,\n";
    mockExitCode = 0;
    const result = await detectMidStreamResolutionChanges("/test.mkv");
    expect(result.hasMultipleResolutions).toBe(false);
    expect(result.resolutions).toEqual(["1920,1080"]);
  });

  it("detects mid-stream resolution change", async () => {
    mockOutput = "1080,1440,\n1080,1440,\n1920,1080,\n";
    mockExitCode = 0;
    const result = await detectMidStreamResolutionChanges("/test.mkv");
    expect(result.hasMultipleResolutions).toBe(true);
    expect(result.resolutions).toContain("1080,1440");
    expect(result.resolutions).toContain("1920,1080");
  });

  it("safely handles error or empty output", async () => {
    mockOutput = "";
    mockExitCode = 1;
    const result = await detectMidStreamResolutionChanges("/test.mkv");
    expect(result.hasMultipleResolutions).toBe(false);
  });
});
