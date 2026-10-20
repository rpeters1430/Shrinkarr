import type { ReleaseNotesMetadata } from "./api/client";

export const RELEASE_NOTES_DISMISSAL_KEY = "shrinkarr.dismissed-release-revision";

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function shouldShowReleaseNotes(
  metadata: ReleaseNotesMetadata | null | undefined,
  storage: Pick<Storage, "getItem"> | undefined = browserStorage(),
): boolean {
  if (!metadata || !metadata.revision.trim() || !metadata.notes.trim()) return false;
  try {
    return storage?.getItem(RELEASE_NOTES_DISMISSAL_KEY) !== metadata.revision;
  } catch {
    return true;
  }
}

export function dismissReleaseNotes(revision: string, storage: Pick<Storage, "setItem"> | undefined = browserStorage()): void {
  try {
    storage?.setItem(RELEASE_NOTES_DISMISSAL_KEY, revision);
  } catch {
    // Storage can be disabled; the notes remain dismissible for this session.
  }
}
