import type { Preset } from "../config/schema.js";
import type { PolicyMetadata } from "../media/types.js";
import { selectStreams } from "../transcode/streams.js";

/**
 * What a preset does to one file's audio and subtitle tracks, keyed by
 * source stream index so the UI can lay it over the tracks it already has.
 */
export interface TrackPlan {
  presetId: string;
  removed: number[];
  // Kept audio, then kept subtitles, in output order.
  order: number[];
  defaultAudio: number | null;
  // New title per renamed track; null clears it.
  renamed: Record<number, string | null>;
  addsStereo: boolean;
  // Whether processing the file changes its tracks at all.
  changes: boolean;
}

export function planTracks(metadata: PolicyMetadata | null | undefined, preset: Preset): TrackPlan | null {
  if (!metadata || metadata.mediaKind !== "video" || preset.mediaKind === "audio") return null;
  const selection = selectStreams(metadata, preset);
  if (!selection) return null;
  const kept = new Set([...selection.audio, ...selection.subtitles].map((track) => track.index));
  const removed = [...(metadata.audioTracks ?? []), ...(metadata.subtitleTracks ?? [])]
    .map((track) => track.index)
    .filter((index) => !kept.has(index));
  const renamed: Record<number, string | null> = {};
  for (const [index, title] of selection.titles) renamed[index] = title ?? null;
  const addsStereo = selection.stereoSource !== undefined;
  return {
    presetId: preset.id,
    removed,
    order: [...selection.audio, ...selection.subtitles].map((track) => track.index),
    defaultAudio: selection.defaultAudio?.index ?? null,
    renamed,
    addsStereo,
    changes: removed.length > 0 || selection.reordered || selection.defaultChanged || selection.titles.size > 0 || addsStereo,
  };
}
