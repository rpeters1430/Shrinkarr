import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanTrackTitle, selectStreams, usesOriginalLanguage } from "../src/transcode/streams.js";
import { buildFfmpegArgs } from "../src/transcode/ffmpegArgs.js";
import { decide, remuxReasonsFor } from "../src/scanner/policy.js";
import { DEFAULT_PRESETS, type Preset } from "../src/config/schema.js";
import type { AudioTrack, MediaProbe, SubtitleTrack } from "../src/media/types.js";
import {
  arrLanguageToCode,
  findOriginalLanguage,
  lookupOriginalLanguage,
  resetOriginalLanguageCache,
  toEntries,
} from "../src/integrations/originalLanguage.js";

const preset: Preset = { ...DEFAULT_PRESETS[0], hwaccel: "cpu", minFileSizeMb: 0 };

const audio = (index: number, language: string, extra: Partial<AudioTrack> = {}): AudioTrack => ({
  index, codec: "eac3", channels: 6, language, isDefault: false, ...extra,
});
const sub = (index: number, language: string, extra: Partial<SubtitleTrack> = {}): SubtitleTrack => ({
  index, codec: "subrip", language, isForced: false, ...extra,
});

const probe = (audioTracks: AudioTrack[], subtitleTracks: SubtitleTrack[] = [], extra: Partial<MediaProbe> = {}): MediaProbe => ({
  mediaKind: "video",
  durationSeconds: 3600,
  sizeBytes: 4_000_000_000,
  videoCodec: "hevc",
  container: "matroska",
  width: 1920,
  height: 1080,
  resolutionLabel: "1080p",
  bitrateKbps: 6000,
  bitDepth: 10,
  isHdr: false,
  fps: 24,
  audioCodec: "eac3",
  audioChannels: 6,
  subtitleCount: subtitleTracks.length,
  audioTracks,
  subtitleTracks,
  ...extra,
});

const indexes = (tracks: Array<{ index: number }>) => tracks.map((t) => t.index);

describe("original language", () => {
  const tracks = probe([audio(1, "eng", { isDefault: true }), audio(2, "jpn"), audio(3, "fre")], [sub(4, "eng"), sub(5, "jpn")]);

  it("keeps the original language when the list names it", () => {
    const selection = selectStreams({ ...tracks, originalLanguage: "jpn" }, { ...preset, keepAudioLanguages: ["original", "eng"] })!;
    expect(indexes(selection.audio)).toEqual([1, 2]);
  });

  it("skips 'original' when the language isn't known", () => {
    const selection = selectStreams({ ...tracks, originalLanguage: null }, { ...preset, keepAudioLanguages: ["original", "eng"] })!;
    expect(indexes(selection.audio)).toEqual([1]);
  });

  it("keeps everything when 'original' is the whole list and unknown", () => {
    const selection = selectStreams(tracks, { ...preset, keepAudioLanguages: ["original"] })!;
    expect(indexes(selection.audio)).toEqual([1, 2, 3]);
  });

  it("tells when a preset needs the lookup", () => {
    expect(usesOriginalLanguage({ keepAudioLanguages: ["eng"], keepSubtitleLanguages: [] })).toBe(false);
    expect(usesOriginalLanguage({ keepAudioLanguages: [], keepSubtitleLanguages: ["Original"] })).toBe(true);
  });
});

describe("track rules", () => {
  it("drops commentary by flag or title", () => {
    const p = probe(
      [audio(1, "eng"), audio(2, "eng", { isCommentary: true }), audio(3, "eng", { title: "Director's Commentary" })],
      [sub(4, "eng"), sub(5, "eng", { title: "Commentary" })],
    );
    const selection = selectStreams(p, { ...preset, removeCommentaryTracks: true })!;
    expect(indexes(selection.audio)).toEqual([1]);
    expect(indexes(selection.subtitles)).toEqual([4]);
  });

  it("never drops every audio track", () => {
    const p = probe([audio(1, "eng", { isCommentary: true })]);
    expect(indexes(selectStreams(p, { ...preset, removeCommentaryTracks: true })!.audio)).toEqual([1]);
  });

  it("drops SDH only where a regular subtitle of that language stays", () => {
    const p = probe([audio(1, "eng")], [
      sub(2, "eng"),
      sub(3, "eng", { title: "English SDH" }),
      sub(4, "spa", { isHearingImpaired: true }),
    ]);
    const selection = selectStreams(p, { ...preset, removeHearingImpairedSubtitles: true })!;
    expect(indexes(selection.subtitles)).toEqual([2, 4]);
  });

  it("keeps the best audio track per language", () => {
    const p = probe([
      audio(1, "eng", { codec: "ac3", channels: 6 }),
      audio(2, "eng", { codec: "truehd", channels: 8 }),
      audio(3, "eng", { codec: "aac", channels: 2 }),
      audio(4, "jpn", { codec: "aac", channels: 2 }),
    ]);
    expect(indexes(selectStreams(p, { ...preset, maxAudioTracksPerLanguage: 1 })!.audio)).toEqual([2, 4]);
    expect(indexes(selectStreams(p, { ...preset, maxAudioTracksPerLanguage: 1, audioTrackPreference: "size" })!.audio)).toEqual([3, 4]);
  });

  it("limits subtitles per language without counting forced ones", () => {
    const p = probe([audio(1, "eng")], [
      sub(2, "eng", { codec: "hdmv_pgs_subtitle" }),
      sub(3, "eng", { isForced: true }),
      sub(4, "eng"),
      sub(5, "eng", { title: "SDH" }),
    ]);
    expect(indexes(selectStreams(p, { ...preset, maxSubtitleTracksPerLanguage: 1 })!.subtitles)).toEqual([3, 4]);
  });

  it("sorts tracks by the language lists and moves the default", () => {
    const p = probe(
      [audio(1, "eng", { isDefault: true }), audio(2, "jpn"), audio(3, "und")],
      [sub(4, "eng"), sub(5, "jpn")],
    );
    const selection = selectStreams({ ...p, originalLanguage: "jpn" }, {
      ...preset,
      keepAudioLanguages: ["original", "eng"],
      keepSubtitleLanguages: ["eng", "jpn"],
      reorderTracks: true,
    })!;
    expect(indexes(selection.audio)).toEqual([2, 1, 3]);
    expect(indexes(selection.subtitles)).toEqual([4, 5]);
    expect(selection.defaultAudio?.index).toBe(2);
    expect(selection.reordered).toBe(true);
    expect(selection.defaultChanged).toBe(true);
  });
});

describe("cleanTrackTitle", () => {
  it("clears titles that only repeat codec, channels or language", () => {
    for (const title of ["English", "DTS-HD MA 5.1", "English - Dolby TrueHD Atmos 7.1", "AC3 5.1 @ 640 kbps", "ENG", "Stereo", "E-AC-3 2.0", "SRT"]) {
      expect(cleanTrackTitle(title), title).toBeUndefined();
    }
  });

  it("keeps titles that say something", () => {
    for (const title of ["Commentary", "English (SDH)", "Signs & Songs", "Forced", "English [HI]", "Japanese - Director's Cut"]) {
      expect(cleanTrackTitle(title), title).toBe(title);
    }
  });

  it("is stable on its own output", () => {
    expect(cleanTrackTitle(cleanTrackTitle("DTS 5.1"))).toBeUndefined();
  });
});

describe("remux verdict", () => {
  it("remuxes for cleanups the scan can see and not again afterwards", () => {
    const before = probe([audio(1, "eng", { title: "English AC3 5.1", isDefault: true }), audio(2, "eng", { isCommentary: true })]);
    const cleanup = { ...preset, removeCommentaryTracks: true, cleanTrackNames: true };
    expect(remuxReasonsFor(before, cleanup)).toEqual(["drop 1 audio track", "clean 1 track name"]);
    expect(decide(before, cleanup).recommendedAction).toBe("Remux");

    const after = probe([audio(1, "eng", { isDefault: true })]);
    expect(remuxReasonsFor(after, cleanup)).toEqual([]);
    expect(decide(after, cleanup).recommendedAction).toBe("Keep");
  });

  it("only ever remuxes with remuxOnly, even when re-encoding would save space", () => {
    const h264 = probe([audio(1, "eng"), audio(2, "fre")], [], { videoCodec: "h264", bitrateKbps: 20000 });
    expect(decide(h264, preset).recommendedAction).toBe("HEVC");
    const remuxOnly = { ...preset, remuxOnly: true, keepAudioLanguages: ["eng"] };
    expect(decide(h264, remuxOnly)).toMatchObject({ shouldTranscode: true, recommendedAction: "Remux" });
    expect(decide(probe([audio(1, "eng")], [], { videoCodec: "h264" }), remuxOnly).shouldTranscode).toBe(false);
  });

  it("remuxes with remuxOnly even when remuxWhenVideoIsFine is off", () => {
    const p = probe([audio(1, "eng"), audio(2, "fre")]);
    const result = decide(p, { ...preset, remuxOnly: true, remuxWhenVideoIsFine: false, keepAudioLanguages: ["eng"] });
    expect(result.recommendedAction).toBe("Remux");
  });
});

describe("buildFfmpegArgs with track rules", () => {
  const tracks = probe(
    [audio(1, "eng", { isDefault: true, title: "English DTS 5.1" }), audio(2, "jpn")],
    [sub(3, "eng", { title: "English" }), sub(4, "jpn", { title: "Signs & Songs" })],
  );
  const rules: Preset = {
    ...preset,
    hwaccel: "vaapi",
    keepAudioLanguages: ["original", "eng"],
    reorderTracks: true,
    cleanTrackNames: true,
  };

  it("keeps the hardware encoder while reordering and renaming tracks", () => {
    const args = buildFfmpegArgs("/in.mkv", "/out.mkv", rules, {
      resolvedEncoder: "hevc_vaapi",
      hwDecode: true,
      audioTracks: tracks.audioTracks,
      subtitleTracks: tracks.subtitleTracks,
      originalLanguage: "jpn",
    });
    const joined = args.join(" ");
    expect(joined).toContain("-hwaccel vaapi");
    expect(args[args.indexOf("-c:v") + 1]).toBe("hevc_vaapi");
    const maps = args.flatMap((arg, i) => (arg === "-map" ? [args[i + 1]] : []));
    expect(maps).toEqual(["0:v:0", "0:2", "0:1", "0:3", "0:4", "0:t?"]);
    expect(joined).toContain("-disposition:a:0 +default");
    expect(joined).toContain("-disposition:a:1 -default");
    expect(joined).toContain("-metadata:s:a:1 title=");
    expect(joined).toContain("-metadata:s:s:0 title=");
    expect(joined).not.toContain("-metadata:s:s:1");
  });

  it("applies the same track rules to a remux", () => {
    const args = buildFfmpegArgs("/in.mkv", "/out.mkv", rules, {
      copyVideo: true,
      audioTracks: tracks.audioTracks,
      subtitleTracks: tracks.subtitleTracks,
      originalLanguage: "jpn",
    });
    expect(args[args.indexOf("-c:v") + 1]).toBe("copy");
    expect(args.join(" ")).toContain("-disposition:a:0 +default");
  });
});

describe("Sonarr/Radarr original language lookup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetOriginalLanguageCache();
  });

  it("maps arr language names to codes", () => {
    expect(arrLanguageToCode("English")).toBe("eng");
    expect(arrLanguageToCode("Portuguese (Brazil)")).toBe("por");
    expect(arrLanguageToCode("Bulgarian")).toBe("bul");
    expect(arrLanguageToCode("Any")).toBeNull();
    expect(arrLanguageToCode("Original")).toBeNull();
    expect(arrLanguageToCode(undefined)).toBeNull();
  });

  it("matches a file to the deepest folder after path mapping", () => {
    const entries = toEntries([
      { path: "/tv/Show", originalLanguage: { name: "Japanese" } },
      { path: "/tv/Show Two", originalLanguage: { name: "English" } },
    ], [{ from: "/tv", to: "/media/tv" }]);
    expect(findOriginalLanguage(entries, "/media/tv/Show/Season 1/e01.mkv")).toBe("jpn");
    expect(findOriginalLanguage(entries, "/media/tv/Show Two/e01.mkv")).toBe("eng");
    expect(findOriginalLanguage(entries, "/media/movies/x.mkv")).toBeNull();
  });

  it("reads Sonarr and Radarr once and caches the result", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith("/series")
        ? [{ path: "/tv/Show", originalLanguage: { name: "Korean" } }]
        : [{ path: "/movies/Film (2020)", originalLanguage: { name: "French" } }],
    )));
    vi.stubGlobal("fetch", fetchMock);
    const config = {
      integrations: { sonarr: { url: "sonarr:8989", apiKey: "a" }, radarr: { url: "http://radarr:7878/", apiKey: "b" } },
      webhooks: { pathMappings: [] },
    };
    expect(await lookupOriginalLanguage("/tv/Show/e1.mkv", config)).toBe("kor");
    expect(await lookupOriginalLanguage("/movies/Film (2020)/film.mkv", config)).toBe("fra");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["http://sonarr:8989/api/v3/series", "http://radarr:7878/api/v3/movie"]);
  });

  it("returns null without integrations and undefined when they fail", async () => {
    expect(await lookupOriginalLanguage("/tv/x.mkv", { integrations: {}, webhooks: { pathMappings: [] } })).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = { integrations: { radarr: { url: "http://radarr", apiKey: "b" } }, webhooks: { pathMappings: [] } };
    expect(await lookupOriginalLanguage("/movies/x.mkv", config)).toBeUndefined();
    warn.mockRestore();
  });
});
