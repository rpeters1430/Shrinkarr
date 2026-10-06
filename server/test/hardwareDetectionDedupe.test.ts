import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

let spawnCount = 0;

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("not available in test");
  }),
  spawn: vi.fn(() => {
    spawnCount++;
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => proc.emit("close", 1));
    return proc;
  }),
}));

const { detectHardware } = await import("../src/transcode/hardware.js");

describe("detectHardware", () => {
  it("shares one probe between concurrent callers", async () => {
    const [a, b] = await Promise.all([detectHardware(), detectHardware()]);
    const singleRunSpawns = spawnCount;
    expect(a).toBe(b);

    spawnCount = 0;
    await detectHardware(true);
    expect(spawnCount).toBe(singleRunSpawns);
  });
});
