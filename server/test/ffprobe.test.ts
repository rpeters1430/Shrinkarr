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

    expect(probe).toMatchObject({
      durationSeconds: 1420.5,
      sizeBytes: 4294967296,
      videoCodec: "h264",
      container: "matroska",
      width: 1920,
      height: 1080,
      resolutionLabel: "1080p",
      bitDepth: 8,
      isHdr: false,
      audioCodec: "aac",
      audioChannels: 2,
    });
  });

  it("throws when there is no video stream", () => {
    const raw: FfprobeOutput = {
      streams: [{ codec_type: "audio", codec_name: "aac" }],
      format: { duration: "10", size: "100", format_name: "mp3" },
    };
    expect(() => parseFfprobeOutput(raw)).toThrow(/no video stream/);
  });

  it("skips attached picture streams (cover art) in favor of the actual video stream", () => {
    const raw: FfprobeOutput = {
      streams: [
        {
          codec_type: "video",
          codec_name: "mjpeg",
          width: 800,
          height: 1200,
          disposition: { attached_pic: 1 },
        },
        {
          codec_type: "video",
          codec_name: "hevc",
          width: 3840,
          height: 2160,
          pix_fmt: "yuv420p10le",
          disposition: { attached_pic: 0 },
        },
        {
          codec_type: "audio",
          codec_name: "eac3",
          channels: 6,
        },
      ],
      format: { duration: "7200", size: "15000000000", format_name: "matroska" },
    };
    const probe = parseFfprobeOutput(raw);
    expect(probe.videoCodec).toBe("hevc");
    expect(probe.resolutionLabel).toBe("4K");
    expect(probe.width).toBe(3840);
    expect(probe.height).toBe(2160);
  });
});
