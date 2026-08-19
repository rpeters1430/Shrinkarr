import fg from "fast-glob";

const VIDEO_EXTENSIONS = ["mkv", "mp4", "avi", "m4v", "ts"];

export async function walkLibrary(path: string): Promise<string[]> {
  const pattern = `**/*.{${VIDEO_EXTENSIONS.join(",")}}`;
  const entries = await fg(pattern, { cwd: path, absolute: true, onlyFiles: true });
  return entries;
}
