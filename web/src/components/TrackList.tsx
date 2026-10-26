import type { AudioTrack, FileRecord, SubtitleTrack, TrackPlan } from "../api/client";

let displayNames: Intl.DisplayNames | null = null;

export function languageName(code: string | undefined): string {
  const value = (code ?? "").trim().toLowerCase();
  if (!value || value === "und" || value === "unk") return "Untagged";
  try {
    displayNames ??= new Intl.DisplayNames(["en"], { type: "language", fallback: "code" });
    return displayNames.of(value) ?? value;
  } catch {
    return value;
  }
}

function channelLabel(channels: number): string {
  if (channels === 1) return "1.0";
  if (channels === 2) return "2.0";
  if (channels === 6) return "5.1";
  if (channels === 8) return "7.1";
  return `${channels}ch`;
}

const CODEC_NAMES: Record<string, string> = {
  eac3: "E-AC-3", ac3: "AC-3", truehd: "TrueHD", dts: "DTS", aac: "AAC", flac: "FLAC", opus: "Opus", mp3: "MP3",
  subrip: "SRT", ass: "ASS", ssa: "SSA", mov_text: "MP4 text", webvtt: "WebVTT", hdmv_pgs_subtitle: "PGS", dvd_subtitle: "VobSub",
};

function codecName(codec: string): string {
  return CODEC_NAMES[codec] ?? (codec.startsWith("pcm_") ? "PCM" : codec.toUpperCase());
}

type Track = { kind: "audio"; track: AudioTrack } | { kind: "subtitle"; track: SubtitleTrack };

function tracksOf(file: FileRecord): Track[] {
  const meta = file.policyMetadata;
  return [
    ...(meta?.audioTracks ?? []).map((track) => ({ kind: "audio" as const, track })),
    ...(meta?.subtitleTracks ?? []).map((track) => ({ kind: "subtitle" as const, track })),
  ];
}

function flags(item: Track): string[] {
  const out: string[] = [];
  if (item.kind === "audio") {
    if (item.track.isDefault) out.push("Default");
  } else {
    if (item.track.isForced) out.push("Forced");
    if (item.track.isHearingImpaired) out.push("SDH");
  }
  if (item.track.isCommentary) out.push("Commentary");
  return out;
}

function chipLabel(item: Track): string {
  const name = languageName(item.track.language);
  return item.kind === "audio" ? `${name} ${channelLabel(item.track.channels)}` : name;
}

/** The file's tracks as compact chips; ones the preset drops are struck through. */
export function TrackChips({ file, onClick }: { file: FileRecord; onClick?: () => void }) {
  const tracks = tracksOf(file);
  if (tracks.length === 0) {
    return <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>No track info. Scan again to see tracks.</span>;
  }
  const removed = new Set(file.trackPlan?.removed ?? []);
  const content = (
    <span className="track-chips">
      {tracks.map((item) => {
        const gone = removed.has(item.track.index);
        const extra = flags(item).filter((flag) => flag !== "Default");
        return (
          <span
            key={item.track.index}
            className={`track-chip track-chip-${item.kind}${gone ? " track-chip-removed" : ""}`}
            title={[
              `${item.kind === "audio" ? "Audio" : "Subtitle"} #${item.track.index}: ${chipLabel(item)}, ${codecName(item.track.codec)}`,
              ...flags(item),
              item.track.title ? `"${item.track.title}"` : "",
              gone ? "Removed by the preset" : "",
            ].filter(Boolean).join(" · ")}
          >
            {chipLabel(item)}
            {extra.length > 0 && <span className="track-chip-flag">{extra.join(", ")}</span>}
          </span>
        );
      })}
    </span>
  );
  if (!onClick) return content;
  return (
    <button type="button" className="track-chips-button" onClick={onClick} aria-label="Show track details">
      {content}
    </button>
  );
}

// moved: new 1-based position among kept tracks of the same kind, for
// tracks whose place changes.
function resultFor(item: Track, plan: TrackPlan | null | undefined, pending: boolean, moved: Map<number, number>): { text: string; tone: "removed" | "changed" | "kept" } {
  const index = item.track.index;
  if (!plan) return { text: "Kept", tone: "kept" };
  if (plan.removed.includes(index)) return { text: pending ? "Will be removed" : "Removed if optimized", tone: "removed" };
  const changes: string[] = [];
  const position = moved.get(index);
  if (position !== undefined) changes.push(`moves to ${item.kind} ${position}`);
  if (item.kind === "audio" && plan.defaultAudio !== null) {
    const willBeDefault = plan.defaultAudio === index;
    if (willBeDefault && !item.track.isDefault) changes.push("becomes default");
    if (!willBeDefault && item.track.isDefault) changes.push("no longer default");
  }
  if (index in plan.renamed) {
    const title = plan.renamed[index];
    changes.push(title ? `renamed to "${title}"` : "name cleared");
  }
  return changes.length === 0 ? { text: "Kept", tone: "kept" } : { text: `Kept, ${changes.join(", ")}`, tone: "changed" };
}

// Compares where each kept track ends up with where it would be if nothing
// were reordered (its rank among kept tracks of its kind, in file order).
function movedTracks(tracks: Track[], plan: TrackPlan | null | undefined): Map<number, number> {
  const moved = new Map<number, number>();
  if (!plan) return moved;
  for (const kind of ["audio", "subtitle"] as const) {
    const ofKind = new Set(tracks.filter((item) => item.kind === kind).map((item) => item.track.index));
    const output = plan.order.filter((index) => ofKind.has(index));
    const natural = [...output].sort((a, b) => a - b);
    output.forEach((index, i) => {
      if (natural[i] !== index) moved.set(index, i + 1);
    });
  }
  return moved;
}

/** Every track of a file, with what the preset does to each. */
export function TrackTable({ file, pending }: { file: FileRecord; pending: boolean }) {
  const tracks = tracksOf(file);
  const plan = file.trackPlan;
  const moved = movedTracks(tracks, plan);
  return (
    <div className="track-table-wrap">
      <table className="track-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Track</th>
            <th>Format</th>
            <th>Details</th>
            <th>{pending ? "When processed" : "With this preset"}</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((item) => {
            const result = resultFor(item, plan, pending, moved);
            return (
              <tr key={item.track.index} className={result.tone === "removed" ? "track-row-removed" : undefined}>
                <td className="track-index">{item.track.index}</td>
                <td>
                  <span className={`track-chip track-chip-${item.kind}`}>{chipLabel(item)}</span>
                </td>
                <td className="track-format">{codecName(item.track.codec)}</td>
                <td className="track-details">
                  {[...flags(item), item.track.title ? `"${item.track.title}"` : ""].filter(Boolean).join(" · ") || "-"}
                </td>
                <td className={`track-result track-result-${result.tone}`}>{result.text}</td>
              </tr>
            );
          })}
          {plan?.addsStereo && (
            <tr>
              <td className="track-index">new</td>
              <td><span className="track-chip track-chip-audio">Stereo 2.0</span></td>
              <td className="track-format">AAC</td>
              <td className="track-details">Downmix of the main audio track</td>
              <td className="track-result track-result-changed">Added</td>
            </tr>
          )}
        </tbody>
      </table>
      {file.policyMetadata?.originalLanguage && (
        <p className="track-note">Original language (from Sonarr/Radarr): {languageName(file.policyMetadata.originalLanguage)}</p>
      )}
    </div>
  );
}
