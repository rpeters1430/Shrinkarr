import { parse, stringify } from "yaml";
import { ConfigSchema } from "../src/config/schema.js";
import { createBench, withCodSpeed } from "./harness.js";
import { PRESET_MATRIX, makeLibraries } from "./fixtures.js";

const bench = withCodSpeed(createBench("config/schema"));

const smallConfig = {
  libraries: makeLibraries(2),
  presets: PRESET_MATRIX.slice(0, 2),
  integrations: {},
  dbPath: "data/shrinkarr.db",
};

const largeConfig = {
  libraries: makeLibraries(24),
  presets: PRESET_MATRIX,
  integrations: {
    jellyfin: { url: "http://jellyfin:8096", apiKey: "jellyfin-api-key-value" },
    emby: { url: "http://emby:8096", apiKey: "emby-api-key-value" },
    plex: { url: "http://plex:32400", token: "plex-token-value", sectionId: "1" },
    sonarr: { url: "http://sonarr:8989", apiKey: "sonarr-api-key-value" },
    radarr: { url: "http://radarr:7878", apiKey: "radarr-api-key-value" },
  },
  queue: {
    concurrency: 2,
    tempSuffix: ".shrinkarr.tmp",
    tempDirectory: "/dev/shm/shrinkarr",
    pauseOnStreaming: true,
    lowPriority: true,
    threads: 4,
    schedule: { enabled: true, startHour: 1, endHour: 7 },
    minFreeSpaceGb: 25,
  },
  watcher: { enabled: true, intervalMinutes: 15, autoOptimize: true, settleDelaySeconds: 30 },
  dbPath: "data/shrinkarr.db",
  preferredHwAccel: "vaapi",
  apiKey: "a-sufficiently-long-api-key-value",
};

const smallYaml = stringify(smallConfig);
const largeYaml = stringify(largeConfig);

bench.add("YAML parse, 24-library config", () => {
  parse(largeYaml);
});

bench.add("ConfigSchema.safeParse, 2-library config", () => {
  ConfigSchema.safeParse(smallConfig);
});

bench.add("ConfigSchema.safeParse, 24-library config", () => {
  ConfigSchema.safeParse(largeConfig);
});

bench.add("load pipeline: YAML parse + schema validation (small)", () => {
  ConfigSchema.safeParse(parse(smallYaml));
});

bench.add("load pipeline: YAML parse + schema validation (large)", () => {
  ConfigSchema.safeParse(parse(largeYaml));
});

export default bench;
