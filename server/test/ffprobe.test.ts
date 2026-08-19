import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFfprobeOutput } from "../src/media/ffprobe.js";
import type { FfprobeOutput } from "../src/media/types.js";

describe("parseFfprobeOutput", () => {
  it("maps a fixture ffprobe JSON output to a MediaProbe", () => {
    const fixturePath = join(__dirname, "fixtures", "ffprobe-h264.json");
    const raw = JSON.parse(readFileSync(fixturePath, "utf-8")) as FfprobeOutput;

    const probe = parseFfprobeOutput(raw);

    expect(probe).toEqual({
      durationSeconds: 1420.5,
      sizeBytes: 4294967296,
      videoCodec: "h264",
      container: "matroska",
      width: 1920,
      height: 1080,
      audioCodec: "aac",
    });
  });

  it("throws when there is no video stream", () => {
    const raw: FfprobeOutput = {
      streams: [{ codec_type: "audio", codec_name: "aac" }],
      format: { duration: "10", size: "100", format_name: "mp3" },
    };
    expect(() => parseFfprobeOutput(raw)).toThrow(/no video stream/);
  });
});
