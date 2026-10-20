import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReleaseNotesMarkdown } from "../src/components/ReleaseNotesMarkdown";
import { dismissReleaseNotes, RELEASE_NOTES_DISMISSAL_KEY, shouldShowReleaseNotes } from "../src/releaseNotes";

function storage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
  };
}

describe("release notes UI helpers", () => {
  it("shows notes once per image revision and prompts again for a newer image", () => {
    const state = storage();
    const release = { version: "1.0.0", revision: "abc123", notes: "## Updates" };
    expect(shouldShowReleaseNotes(release, state)).toBe(true);
    dismissReleaseNotes(release.revision, state);
    expect(state.getItem(RELEASE_NOTES_DISMISSAL_KEY)).toBe("abc123");
    expect(shouldShowReleaseNotes(release, state)).toBe(false);
    expect(shouldShowReleaseNotes({ ...release, revision: "def456" }, state)).toBe(true);
  });

  it("does not show a blank dialog for absent or empty notes", () => {
    expect(shouldShowReleaseNotes(null, storage())).toBe(false);
    expect(shouldShowReleaseNotes({ version: "1", revision: "abc", notes: "  " }, storage())).toBe(false);
  });

  it("formats Markdown but escapes embedded HTML", () => {
    const html = renderToStaticMarkup(React.createElement(ReleaseNotesMarkdown, { notes: '## Fixes\n\n- Faster scan\n\n<script>alert("no")</script>' }));
    expect(html).toContain("<h2>Fixes</h2>");
    expect(html).toContain("<li>Faster scan</li>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
