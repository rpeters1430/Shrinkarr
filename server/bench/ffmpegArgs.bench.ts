import { buildFfmpegArgs, type FfmpegOptions } from "../src/transcode/ffmpegArgs.js";
import { createBench, withCodSpeed } from "./harness.js";
import { BASE_PRESET, PRESET_MATRIX } from "./fixtures.js";

const bench = withCodSpeed(createBench("transcode/ffmpegArgs"));

const INPUT = "/media/library-0/videos/Show 12/Season 3/episode-42.mkv";
const OUTPUT = "/media/library-0/videos/Show 12/Season 3/episode-42.shrinkarr.tmp.mkv";

const HDR_4K: FfmpegOptions = {
  isHdr: true,
  colorTransfer: "smpte2084",
  bitDepth: 10,
  threads: 8,
  sourceBitrateKbps: 48_000,
};

const LOW_BITRATE: FfmpegOptions = {
  bitDepth: 8,
  sourceBitrateKbps: 3_200,
};

bench.add("single preset, default options", () => {
  buildFfmpegArgs(INPUT, OUTPUT, BASE_PRESET);
});

bench.add("single preset, 4K HDR 10-bit source", () => {
  buildFfmpegArgs(INPUT, OUTPUT, BASE_PRESET, HDR_4K);
});

bench.add("full encoder matrix (11 presets)", () => {
  for (const preset of PRESET_MATRIX) {
    buildFfmpegArgs(INPUT, OUTPUT, preset);
  }
});

bench.add("full encoder matrix, low-bitrate source (VBR path)", () => {
  for (const preset of PRESET_MATRIX) {
    buildFfmpegArgs(INPUT, OUTPUT, preset, LOW_BITRATE);
  }
});

bench.add("queue burst: 500 jobs across the encoder matrix", () => {
  for (let i = 0; i < 500; i += 1) {
    const preset = PRESET_MATRIX[i % PRESET_MATRIX.length];
    buildFfmpegArgs(INPUT, OUTPUT, preset, i % 2 === 0 ? HDR_4K : LOW_BITRATE);
  }
});

export default bench;
