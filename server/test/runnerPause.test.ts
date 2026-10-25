import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const processes = vi.hoisted(() => [] as Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> }>);
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true),
    });
    processes.push(proc);
    return proc;
  }),
}));
const runner = await import("../src/transcode/runner.js");

describe("pause without discarding FFmpeg progress", () => {
  it("suspends and continues the same process without aborting the job", async () => {
    const controller = new AbortController();
    const result = runner.runTranscode(["-i", "source", "output"], 60, () => {}, { signal: controller.signal, lowPriority: false });
    await vi.waitFor(() => expect(processes.length).toBe(1));
    const proc = processes[0];
    runner.pauseTranscodes(controller.signal);
    expect(proc.kill).toHaveBeenLastCalledWith("SIGSTOP");
    expect(controller.signal.aborted).toBe(false);
    runner.resumeTranscodes(controller.signal);
    expect(proc.kill).toHaveBeenLastCalledWith("SIGCONT");
    expect(processes.length).toBe(1);
    proc.emit("close", 0);
    await expect(result).resolves.toBe("");
  });

  it("holds the next stage until resume instead of starting another FFmpeg", async () => {
    const controller = new AbortController();
    runner.pauseTranscodes(controller.signal);
    const count = processes.length;
    const result = runner.runTranscode(["-i", "encoded", "-f", "null", "-"], 60, () => {}, { signal: controller.signal, lowPriority: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(processes.length).toBe(count);
    runner.resumeTranscodes(controller.signal);
    await vi.waitFor(() => expect(processes.length).toBe(count + 1));
    processes.at(-1)!.emit("close", 0);
    await result;
  });

  it("can cancel a suspended process", async () => {
    const controller = new AbortController();
    const count = processes.length;
    const result = runner.runTranscode([], 60, () => {}, { signal: controller.signal, lowPriority: false });
    await vi.waitFor(() => expect(processes.length).toBe(count + 1));
    runner.pauseTranscodes(controller.signal);
    controller.abort("cancelled");
    await expect(result).rejects.toThrow("Transcode aborted");
    expect(processes.at(-1)!.kill).toHaveBeenLastCalledWith("SIGKILL");
    processes.at(-1)!.emit("close", null);
  });

  it("cancels a job waiting between stages without spawning", async () => {
    const controller = new AbortController();
    runner.pauseTranscodes(controller.signal);
    const count = processes.length;
    const result = runner.runTranscode([], 60, () => {}, { signal: controller.signal });
    controller.abort("cancelled");
    await expect(result).rejects.toThrow("Transcode aborted");
    expect(processes.length).toBe(count);
  });
});
