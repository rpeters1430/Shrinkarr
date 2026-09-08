import { parseFfprobeOutput } from "../src/media/ffprobe.js";
import type { FfprobeOutput } from "../src/media/types.js";
import { createBench, withCodSpeed } from "./harness.js";
import { makeFfprobeOutputs } from "./fixtures.js";

const bench = withCodSpeed(createBench("media/ffprobe"));

const outputs = makeFfprobeOutputs(1_000);
const single = outputs[0];
const rawJson = outputs.slice(0, 200).map((output) => JSON.stringify(output));

bench.add("parseFfprobeOutput, single file", () => {
  parseFfprobeOutput(single);
});

bench.add("parseFfprobeOutput over 1000 files", () => {
  let bitrate = 0;
  for (const output of outputs) {
    bitrate += parseFfprobeOutput(output).bitrateKbps;
  }
  return bitrate;
});

bench.add("JSON.parse + parseFfprobeOutput over 200 ffprobe payloads", () => {
  let subtitles = 0;
  for (const raw of rawJson) {
    subtitles += parseFfprobeOutput(JSON.parse(raw) as FfprobeOutput).subtitleCount;
  }
  return subtitles;
});

export default bench;
