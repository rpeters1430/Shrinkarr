import { resolve, relative, isAbsolute } from "node:path";
import type { Library } from "../config/schema.js";

export function isPathInsideLibraries(filePath: string, libraries: Library[]): boolean {
  const target = resolve(filePath);
  return libraries.some((library) => {
    const libraryRoot = resolve(library.path);
    const rel = relative(libraryRoot, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}
