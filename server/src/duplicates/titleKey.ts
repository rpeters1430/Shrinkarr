import { basename, dirname, extname } from "node:path";

// Release-name tokens that describe the encode, not the title. Everything from
// the first one onward (quality, source, codec, release group) is dropped.
const RELEASE_TOKENS = new Set([
  "2160p", "1440p", "1080p", "1080i", "720p", "576p", "480p", "360p", "4k", "uhd", "fhd", "hd", "sd",
  "hdr", "hdr10", "hdr10plus", "dv", "dovi", "sdr", "10bit", "8bit", "12bit",
  "x264", "x265", "h264", "h265", "hevc", "avc", "av1", "vp9", "xvid", "divx", "mpeg2",
  "bluray", "blu", "bdrip", "brrip", "bdremux", "remux", "web", "webrip", "webdl", "dl", "hdtv", "dvdrip", "dvd",
  "hdrip", "amzn", "nf", "dsnp", "hmax", "atvp", "proper", "repack", "rerip", "internal", "limited",
  "aac", "ac3", "eac3", "dts", "dtshd", "truehd", "atmos", "flac", "opus", "mp3", "ddp", "dd",
  "multi", "dual", "subbed", "dubbed",
]);

const EPISODE_PATTERNS = [/\bs(\d{1,2})\s*e(\d{1,3})\b/i, /\b(\d{1,2})x(\d{2,3})\b/i];
const YEAR_PATTERN = /^(19\d{2}|20\d{2})$/;
const SEASON_FOLDER = /^(season|series|staffel|saison)\s*\d+$|^s\d{1,2}$|^specials$/i;

export type TitleKind = "movie" | "episode" | "track" | "file";

export interface TitleKey {
  /** Grouping key; equal keys are candidate duplicates. */
  key: string;
  /** Human-readable title shown in the UI. */
  label: string;
  kind: TitleKind;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[[\](){}]/g, " ")
    .replace(/[._\-+,&']/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Title words up to the first year or release token, plus that year if found. */
function parseTitle(text: string): { title: string; year?: string } {
  const out: string[] = [];
  const all = words(text);
  for (let i = 0; i < all.length; i++) {
    const word = all[i];
    // A leading year is part of the title ("1917", "2012").
    if (YEAR_PATTERN.test(word) && out.length > 0) {
      return { title: out.join(" "), year: word };
    }
    if (RELEASE_TOKENS.has(word) && out.length > 0) break;
    out.push(word);
  }
  return { title: out.join(" ") };
}

function capitalize(title: string): string {
  return title.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/**
 * Derives the "same title" key for a media file from its path:
 * - episodes: show + SxxEyy, show taken from the folder when the file name is
 *   just "S01E02.mkv";
 * - movies: title + year, falling back to the folder ("Heat (1995)/movie.mkv");
 * - music: album folder + track title, so "01 Intro" on two albums never match;
 * - anything else: the cleaned-up file name, only within its own folder.
 */
export function titleKeyFor(filePath: string, mediaType: string): TitleKey {
  const stem = basename(filePath, extname(filePath));
  const parent = basename(dirname(filePath));

  if (mediaType === "music") {
    const track = words(stem.replace(/^\s*\d{1,3}\s*[-._ ]\s*/, "")).join(" ");
    const album = words(parent).join(" ");
    return { key: `track|${album}|${track}`, label: `${capitalize(track)} (${parent})`, kind: "track" };
  }

  for (const pattern of EPISODE_PATTERNS) {
    const match = pattern.exec(stem);
    if (!match) continue;
    const season = match[1].padStart(2, "0");
    const episode = match[2].padStart(2, "0");
    let show = parseTitle(stem.slice(0, match.index)).title;
    if (!show) {
      const showFolder = SEASON_FOLDER.test(parent) ? basename(dirname(dirname(filePath))) : parent;
      show = parseTitle(showFolder).title;
    }
    return {
      key: `episode|${show}|s${season}e${episode}`,
      label: `${capitalize(show)} S${season}E${episode}`,
      kind: "episode",
    };
  }

  let { title, year } = parseTitle(stem);
  if (!year) {
    const fromFolder = parseTitle(parent);
    if (fromFolder.year) ({ title, year } = fromFolder);
  }
  if (year && mediaType !== "youtube" && mediaType !== "web") {
    return { key: `movie|${title}|${year}`, label: `${capitalize(title)} (${year})`, kind: "movie" };
  }

  // No year to anchor the title, so "Heat/movie.mkv" and "Alien/movie.mkv"
  // must not match: only versions within one folder count as the same title.
  const cleaned = parseTitle(stem).title || words(stem).join(" ");
  const folder = words(dirname(filePath)).join(" ");
  return { key: `file|${folder}|${cleaned}`, label: stem, kind: "file" };
}
