import { useEffect, useRef, useState } from "react";
import { dismissReleaseNotes, shouldShowReleaseNotes } from "../releaseNotes";
import { getReleaseNotes, type ReleaseNotesMetadata } from "../api/client";
import { ReleaseNotesMarkdown } from "./ReleaseNotesMarkdown";

export function ReleaseNotesDialog() {
  const [release, setRelease] = useState<ReleaseNotesMetadata | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    getReleaseNotes()
      .then((metadata) => {
        if (active && shouldShowReleaseNotes(metadata)) setRelease(metadata);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!release || !dialog) return undefined;
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [release]);

  function close() {
    if (release) dismissReleaseNotes(release.revision);
    setRelease(null);
  }

  if (!release) return null;
  return (
    <dialog
      ref={dialogRef}
      className="release-notes-dialog"
      aria-labelledby="release-notes-title"
      onCancel={(event) => { event.preventDefault(); close(); }}
    >
      <header className="release-notes-header">
        <div>
          <p className="release-notes-eyebrow">Updated image</p>
          <h2 id="release-notes-title">What’s new{release.version ? ` in ${release.version}` : ""}</h2>
        </div>
        <button ref={closeRef} className="btn btn-secondary" type="button" onClick={close} aria-label="Close release notes">
          Close
        </button>
      </header>
      <div className="release-notes-content"><ReleaseNotesMarkdown notes={release.notes} /></div>
      <p className="release-notes-revision">Revision {release.revision.slice(0, 12)}</p>
    </dialog>
  );
}
