import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  deleteDuplicates,
  findDuplicates,
  getConfig,
  getLibraries,
  type DuplicateGroup,
  type DuplicateReport,
  type DuplicateSearchOptions,
  type DuplicateStrategy,
  type Library,
} from "../api/client";
import { IconCheck, IconSearch, IconShield, IconTrash } from "../components/Icons";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 3 ? 2 : 1)} ${units[i]}`;
}

function formatDuration(seconds: number): string {
  if (!seconds) return "Unknown";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

function formatBitrate(kbps: number): string {
  if (!kbps || kbps <= 0) return "";
  if (kbps >= 1000) {
    return `${(kbps / 1000).toFixed(1)} Mbps`;
  }
  return `${Math.round(kbps)} kbps`;
}

function formatChannels(channels: number): string {
  if (channels === 8) return "7.1";
  if (channels === 6) return "5.1";
  if (channels === 2) return "Stereo";
  if (channels === 1) return "Mono";
  if (channels > 0) return `${channels}ch`;
  return "";
}

function codecBadgeClass(codec: string): string {
  const c = codec.toLowerCase();
  if (c === "av1") return "badge-codec-av1";
  if (c === "hevc" || c === "h265") return "badge-codec-hevc";
  if (c === "h264" || c === "avc") return "badge-codec-h264";
  if (c === "mpeg2" || c === "mpeg2video") return "badge-codec-mpeg2";
  return "badge-res";
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** Folder relative to the library root, which is the part worth reading. */
function folderOf(path: string, libraryRoot?: string): string {
  const parts = path.split(/[/\\]/);
  parts.pop();
  const folder = parts.join("/");
  const root = libraryRoot?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && (folder === root || folder.startsWith(`${root}/`))) {
    return folder.slice(root.length + 1) || "(library root)";
  }
  return folder;
}

const DEFAULT_OPTIONS: DuplicateSearchOptions = {
  findIdentical: true,
  findSameTitle: true,
  durationToleranceSeconds: 90,
  minSizeMb: 50,
  acrossLibraries: true,
  hashMode: "sampled",
  strategy: "highest-quality",
};

interface GroupState {
  keep: string;
  remove: Set<string>;
}

type MatchFilter = "all" | "identical" | "same-title" | "pending";

export function Duplicates() {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [selectedLibraries, setSelectedLibraries] = useState<Set<string>>(new Set());
  const [options, setOptions] = useState<DuplicateSearchOptions>(DEFAULT_OPTIONS);
  const [report, setReport] = useState<DuplicateReport | null>(null);
  const [groupState, setGroupState] = useState<Record<string, GroupState>>({});
  const [searching, setSearching] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [dryRunning, setDryRunning] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchFilter, setMatchFilter] = useState<MatchFilter>("all");
  const [recycleBin, setRecycleBin] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    getLibraries()
      .then((libs) => {
        setLibraries(libs);
        setSelectedLibraries(new Set(libs.map((l) => l.id)));
      })
      .catch((err) => setError(String(err)));
    getConfig().then((c) => setRecycleBin(c.queue.recycleBinPath || undefined)).catch(() => {});
  }, []);

  const libraryById = useMemo(() => new Map(libraries.map((l) => [l.id, l])), [libraries]);

  function resetSelections(groups: DuplicateGroup[]) {
    const next: Record<string, GroupState> = {};
    for (const group of groups) {
      next[group.id] = { keep: group.files.find((f) => f.keep)?.path ?? group.files[0].path, remove: new Set() };
    }
    setGroupState(next);
  }

  async function handleSearch() {
    setError(null);
    setSuccessMsg(null);
    if (selectedLibraries.size === 0) {
      setError("Select at least one library.");
      return;
    }
    setSearching(true);
    try {
      const result = await findDuplicates({ ...options, libraryIds: [...selectedLibraries] });
      setReport(result);
      resetSelections(result.groups);
    } catch (err) {
      setError(String(err));
    } finally {
      setSearching(false);
    }
  }

  function setKeep(groupId: string, path: string) {
    setGroupState((prev) => {
      const current = prev[groupId];
      const remove = new Set(current?.remove ?? []);
      remove.delete(path);
      return { ...prev, [groupId]: { keep: path, remove } };
    });
  }

  function toggleRemove(groupId: string, path: string) {
    setGroupState((prev) => {
      const current = prev[groupId];
      const remove = new Set(current?.remove ?? []);
      if (remove.has(path)) remove.delete(path);
      else remove.add(path);
      return { ...prev, [groupId]: { keep: current?.keep ?? "", remove } };
    });
  }

  function selectAllSuggested() {
    setGroupState((prev) => {
      const next: Record<string, GroupState> = {};
      for (const group of report?.groups ?? []) {
        const keep = prev[group.id]?.keep ?? group.files.find((f) => f.keep)?.path ?? group.files[0].path;
        next[group.id] = { keep, remove: new Set(group.files.map((f) => f.path).filter((p) => p !== keep)) };
      }
      return next;
    });
  }

  function clearSelection() {
    setGroupState((prev) => {
      const next: Record<string, GroupState> = {};
      for (const [id, state] of Object.entries(prev)) next[id] = { keep: state.keep, remove: new Set() };
      return next;
    });
  }

  function selectGroupExtras(groupId: string) {
    const group = report?.groups.find((g) => g.id === groupId);
    if (!group) return;
    setGroupState((prev) => {
      const state = prev[groupId];
      const keep = state?.keep ?? group.files.find((f) => f.keep)?.path ?? group.files[0].path;
      const remove = new Set(group.files.map((f) => f.path).filter((p) => p !== keep));
      return { ...prev, [groupId]: { keep, remove } };
    });
  }

  function clearGroupExtras(groupId: string) {
    setGroupState((prev) => {
      const state = prev[groupId];
      if (!state) return prev;
      return { ...prev, [groupId]: { keep: state.keep, remove: new Set() } };
    });
  }

  // One entry per file, even if it shows up in two groups.
  const pendingItems = useMemo(() => {
    const items = new Map<string, { path: string; keepPath: string; sizeBytes: number }>();
    for (const group of report?.groups ?? []) {
      const state = groupState[group.id];
      if (!state) continue;
      for (const file of group.files) {
        if (state.remove.has(file.path) && !items.has(file.path)) {
          const freed = file.linkCount > 1 ? 0 : file.sizeBytes;
          items.set(file.path, { path: file.path, keepPath: state.keep, sizeBytes: freed });
        }
      }
    }
    return [...items.values()];
  }, [report, groupState]);

  const pendingBytes = pendingItems.reduce((sum, item) => sum + item.sizeBytes, 0);

  async function handleDryRun() {
    if (pendingItems.length === 0) return;
    setDryRunning(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const result = await deleteDuplicates(
        pendingItems.map(({ path, keepPath }) => ({ path, keepPath })),
        true,
      );
      if (result.deleted.length > 0) {
        setSuccessMsg(
          `Dry Run passed: verified ${plural(result.deleted.length, "file")} (${formatBytes(result.freedBytes)}) can be safely removed without errors. No files were modified.`,
        );
      }
      if (result.failed.length > 0) {
        setError(
          `Dry Run warning: ${plural(result.failed.length, "file")} would fail: ` +
            result.failed.slice(0, 3).map((f) => `${fileName(f.path)} (${f.error})`).join("; "),
        );
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setDryRunning(false);
    }
  }

  async function handleDelete() {
    if (pendingItems.length === 0) return;
    const where = recycleBin ? `moved to the recycle bin (${recycleBin})` : "permanently deleted";
    const confirmed = window.confirm(
      `${plural(pendingItems.length, "file")} (${formatBytes(pendingBytes)}) will be ${where}. Continue?`,
    );
    if (!confirmed) return;

    setDeleting(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const result = await deleteDuplicates(pendingItems.map(({ path, keepPath }) => ({ path, keepPath })));
      const gone = new Set(result.deleted);
      if (report) {
        const groups = report.groups
          .map((g) => {
            const files = g.files.filter((f) => !gone.has(f.path));
            const reclaimableBytes = files
              .filter((f) => !f.keep && f.linkCount <= 1)
              .reduce((s, f) => s + f.sizeBytes, 0);
            return { ...g, files, reclaimableBytes };
          })
          .filter((g) => g.files.length > 1);
        setReport({ ...report, groups, reclaimableBytes: Math.max(0, report.reclaimableBytes - result.freedBytes) });
        setGroupState((prev) => {
          const next: Record<string, GroupState> = {};
          for (const g of groups) {
            const state = prev[g.id];
            const remove = new Set([...(state?.remove ?? [])].filter((p) => !gone.has(p)));
            next[g.id] = { keep: state?.keep ?? g.files[0].path, remove };
          }
          return next;
        });
      }
      if (result.deleted.length > 0) {
        const count = plural(result.deleted.length, "file");
        setSuccessMsg(
          result.recycled
            ? `Moved ${count} (${formatBytes(result.freedBytes)}) to the recycle bin.`
            : `Deleted ${count}, freeing ${formatBytes(result.freedBytes)}.`,
        );
      }
      if (result.failed.length > 0) {
        setError(
          `${plural(result.failed.length, "file")} not removed: ` +
            result.failed.slice(0, 3).map((f) => `${fileName(f.path)} (${f.error})`).join("; ") +
            (result.failed.length > 3 ? "; …" : ""),
        );
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setDeleting(false);
    }
  }

  function toggleLibrary(id: string) {
    setSelectedLibraries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filteredGroups = useMemo(() => {
    if (!report) return [];
    return report.groups.filter((g) => {
      if (matchFilter === "identical" && g.match !== "identical") return false;
      if (matchFilter === "same-title" && g.match !== "same-title") return false;
      if (matchFilter === "pending") {
        const state = groupState[g.id];
        if (!state || state.remove.size === 0) return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesLabel = g.label.toLowerCase().includes(q);
        const matchesFile = g.files.some((f) => f.path.toLowerCase().includes(q));
        if (!matchesLabel && !matchesFile) return false;
      }
      return true;
    });
  }, [report, matchFilter, searchQuery, groupState]);

  const counts = useMemo(() => {
    if (!report) return { total: 0, identical: 0, sameTitle: 0, pending: 0 };
    let identical = 0;
    let sameTitle = 0;
    let pending = 0;
    for (const g of report.groups) {
      if (g.match === "identical") identical++;
      else sameTitle++;
      const state = groupState[g.id];
      if (state && state.remove.size > 0) pending++;
    }
    return { total: report.groups.length, identical, sameTitle, pending };
  }, [report, groupState]);

  return (
    <div className="main-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Duplicates</h1>
          <p className="page-subtitle">
            Find copies of the same file and extra encodes of the same title, compare quality, and safely prune unnecessary copies.
          </p>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {successMsg && <div className="alert alert-success">{successMsg}</div>}

      <div className="card dup-options">
        <div className="dup-options-grid">
          <fieldset className="dup-fieldset">
            <legend className="form-label">Libraries</legend>
            {libraries.length === 0 && (
              <p className="dup-hint">
                No libraries yet. <Link to="/library">Add one on the Library page.</Link>
              </p>
            )}
            {libraries.map((lib) => (
              <label key={lib.id} className="dup-check">
                <input type="checkbox" checked={selectedLibraries.has(lib.id)} onChange={() => toggleLibrary(lib.id)} />
                <span>{lib.name}</span>
              </label>
            ))}
          </fieldset>

          <fieldset className="dup-fieldset">
            <legend className="form-label">Match on</legend>
            <label className="dup-check">
              <input
                type="checkbox"
                checked={options.findIdentical}
                onChange={(e) => setOptions({ ...options, findIdentical: e.target.checked })}
              />
              <span>
                Identical files
                <small>Same size and same content, whatever the filename.</small>
              </span>
            </label>
            <label className="dup-check">
              <input
                type="checkbox"
                checked={options.findSameTitle}
                onChange={(e) => setOptions({ ...options, findSameTitle: e.target.checked })}
              />
              <span>
                Same title
                <small>Same movie (title + year), episode (show + SxxEyy) or album track.</small>
              </span>
            </label>
            <label className="dup-check">
              <input
                type="checkbox"
                checked={options.acrossLibraries}
                onChange={(e) => setOptions({ ...options, acrossLibraries: e.target.checked })}
              />
              <span>
                Compare across libraries
                <small>Off: only match files within the same library.</small>
              </span>
            </label>
          </fieldset>

          <div className="dup-fieldset">
            <div className="form-group">
              <label className="form-label" htmlFor="dup-strategy">Keep recommendation</label>
              <select
                id="dup-strategy"
                className="form-select"
                value={options.strategy ?? "highest-quality"}
                onChange={(e) => setOptions({ ...options, strategy: e.target.value as DuplicateStrategy })}
              >
                <option value="highest-quality">Highest quality (Resolution, HDR, codec)</option>
                <option value="smallest-file">Smallest file (Maximize freed space)</option>
                <option value="largest-file">Largest file (Preserve maximum bitrate)</option>
                <option value="oldest">Oldest file (Keep original copy)</option>
              </select>
              <p className="dup-hint">Determines which copy is marked as suggested to keep.</p>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="dup-tolerance">Runtime tolerance (seconds)</label>
              <input
                id="dup-tolerance"
                type="number"
                min={0}
                className="form-input"
                value={options.durationToleranceSeconds}
                disabled={!options.findSameTitle}
                onChange={(e) => setOptions({ ...options, durationToleranceSeconds: Math.max(0, Number(e.target.value) || 0) })}
              />
              <p className="dup-hint">Same-title files further apart are treated as different cuts.</p>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="dup-min-size">Ignore files smaller than (MB)</label>
              <input
                id="dup-min-size"
                type="number"
                min={0}
                className="form-input"
                value={options.minSizeMb}
                onChange={(e) => setOptions({ ...options, minSizeMb: Math.max(0, Number(e.target.value) || 0) })}
              />
            </div>
            <div className="form-group dup-last-field">
              <label className="form-label" htmlFor="dup-hash">Content check</label>
              <select
                id="dup-hash"
                className="form-select"
                value={options.hashMode}
                disabled={!options.findIdentical}
                onChange={(e) => setOptions({ ...options, hashMode: e.target.value as DuplicateSearchOptions["hashMode"] })}
              >
                <option value="sampled">Quick: compare 3 MB from each file</option>
                <option value="full">Full: read every byte (slower on large libraries)</option>
              </select>
            </div>
          </div>
        </div>

        <div className="dup-actions">
          <button type="button" className="btn btn-primary" onClick={handleSearch} disabled={searching}>
            <IconSearch size={15} />
            <span>{searching ? "Searching…" : "Find duplicates"}</span>
          </button>
        </div>
      </div>

      {report && (
        <>
          <div className="dup-summary">
            <p>
              <strong>{plural(report.groups.length, "group")}</strong> found across {plural(report.filesChecked, "file")} checked.{" "}
              Removing every suggested extra frees <strong>{formatBytes(report.reclaimableBytes)}</strong>.
            </p>
            {report.groups.length > 0 && (
              <div className="dup-summary-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={selectAllSuggested}>
                  <IconCheck size={14} />
                  <span>Select suggested extras</span>
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={clearSelection}>
                  Clear selection
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleDryRun}
                  disabled={dryRunning || pendingItems.length === 0}
                  title="Validate duplicate rules without deleting"
                >
                  <IconShield size={14} />
                  <span>{dryRunning ? "Testing…" : `Dry Run (${pendingItems.length})`}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={handleDelete}
                  disabled={deleting || pendingItems.length === 0}
                >
                  <IconTrash size={14} />
                  <span>
                    {deleting
                      ? "Removing…"
                      : `${recycleBin ? "Move to recycle bin" : "Delete"}: ${plural(pendingItems.length, "file")} (${formatBytes(pendingBytes)})`}
                  </span>
                </button>
              </div>
            )}
          </div>

          {report.groups.length > 0 && (
            <div className="dup-filter-bar">
              <div className="dup-search-box">
                <IconSearch size={14} className="dup-search-icon" />
                <input
                  type="text"
                  className="form-input"
                  placeholder="Filter groups by title or path…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>

              <div className="dup-filter-pills">
                <button
                  type="button"
                  className={`dup-filter-pill ${matchFilter === "all" ? "active" : ""}`}
                  onClick={() => setMatchFilter("all")}
                >
                  All ({counts.total})
                </button>
                <button
                  type="button"
                  className={`dup-filter-pill ${matchFilter === "identical" ? "active" : ""}`}
                  onClick={() => setMatchFilter("identical")}
                >
                  Identical ({counts.identical})
                </button>
                <button
                  type="button"
                  className={`dup-filter-pill ${matchFilter === "same-title" ? "active" : ""}`}
                  onClick={() => setMatchFilter("same-title")}
                >
                  Same Title ({counts.sameTitle})
                </button>
                {counts.pending > 0 && (
                  <button
                    type="button"
                    className={`dup-filter-pill ${matchFilter === "pending" ? "active" : ""}`}
                    onClick={() => setMatchFilter("pending")}
                  >
                    Pending Removal ({counts.pending})
                  </button>
                )}
              </div>
            </div>
          )}

          {report.groups.length === 0 && (
            <div className="card empty-state">
              <div className="empty-state-icon">
                <IconSearch size={28} />
              </div>
              <h4 className="empty-state-title">No duplicates found</h4>
              <p className="empty-state-desc">
                Nothing matched these settings. Only scanned files are compared, so scan new libraries first.
              </p>
              <Link to="/library" className="btn btn-secondary dup-empty-cta">Open Library</Link>
            </div>
          )}

          {report.groups.length > 0 && filteredGroups.length === 0 && (
            <div className="card empty-state">
              <h4 className="empty-state-title">No matching duplicates</h4>
              <p className="empty-state-desc">No groups match the current search query or filter.</p>
              <button
                type="button"
                className="btn btn-secondary dup-empty-cta"
                onClick={() => {
                  setSearchQuery("");
                  setMatchFilter("all");
                }}
              >
                Reset filters
              </button>
            </div>
          )}

          {filteredGroups.map((group) => {
            const state = groupState[group.id];
            const groupExtrasCount = group.files.filter((f) => f.path !== state?.keep).length;
            const groupRemovedCount = state?.remove.size ?? 0;
            return (
              <section key={group.id} className="card dup-group" aria-label={group.label}>
                <header className="dup-group-header">
                  <div>
                    <h3 className="dup-group-title">{group.label}</h3>
                    <span className={`badge ${group.match === "identical" ? "badge-status-eligible" : "badge-res"}`}>
                      {group.match === "identical" ? "Identical files" : "Same title"}
                    </span>
                  </div>
                  <div className="dup-group-actions">
                    <span className="dup-group-size">{formatBytes(group.reclaimableBytes)} in extras</span>
                    {groupExtrasCount > 0 && (
                      <button
                        type="button"
                        className="dup-group-btn"
                        onClick={() =>
                          groupRemovedCount === groupExtrasCount
                            ? clearGroupExtras(group.id)
                            : selectGroupExtras(group.id)
                        }
                      >
                        {groupRemovedCount === groupExtrasCount ? "Deselect group" : "Select group extras"}
                      </button>
                    )}
                  </div>
                </header>
                <div className="table-container">
                  <table>
                    <thead>
                      <tr>
                        <th className="nowrap">Keep</th>
                        <th className="nowrap">Remove</th>
                        <th>File</th>
                        <th className="nowrap">Video</th>
                        <th className="nowrap">Audio</th>
                        <th className="nowrap">Runtime</th>
                        <th className="nowrap">Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.files.map((file) => {
                        const isKeep = state?.keep === file.path;
                        const channelLabel = formatChannels(file.audioChannels);
                        const bitrateLabel = formatBitrate(file.bitrateKbps);
                        return (
                          <tr key={file.path} className={state?.remove.has(file.path) ? "dup-row-remove" : undefined}>
                            <td>
                              <label className="dup-hit">
                                <input
                                  type="radio"
                                  name={`keep-${group.id}`}
                                  aria-label={`Keep ${fileName(file.path)}`}
                                  checked={isKeep}
                                  onChange={() => setKeep(group.id, file.path)}
                                />
                              </label>
                            </td>
                            <td>
                              <label className="dup-hit">
                                <input
                                  type="checkbox"
                                  aria-label={`Remove ${fileName(file.path)}`}
                                  disabled={isKeep}
                                  checked={state?.remove.has(file.path) ?? false}
                                  onChange={() => toggleRemove(group.id, file.path)}
                                />
                              </label>
                            </td>
                            <td className="cell-video-info">
                              <div className="video-title">
                                {fileName(file.path)}
                                {file.keep && <span className="dup-suggested">suggested keep</span>}
                                {file.linkCount > 1 && (
                                  <span className="dup-hardlink" title="Other hardlinks point at the same data">
                                    hardlinked, removing frees no space
                                  </span>
                                )}
                              </div>
                              <div className="video-path" title={file.path}>
                                {libraryById.get(file.libraryId)?.name ?? file.libraryId} · {folderOf(file.path, libraryById.get(file.libraryId)?.path)}
                              </div>
                            </td>
                            <td>
                              <div className="dup-badges-row">
                                {file.width > 0 && <span className="badge badge-res">{file.resolution}</span>}
                                <span className={`badge ${codecBadgeClass(file.codec)}`}>
                                  {file.codec.toUpperCase()}
                                </span>
                                {file.bitDepth > 8 && (
                                  <span className="badge badge-res">{file.bitDepth}-bit</span>
                                )}
                                {file.isHdr && <span className="badge badge-hdr">HDR</span>}
                              </div>
                              {bitrateLabel && <div className="dup-meta-text">{bitrateLabel}</div>}
                            </td>
                            <td>
                              <div className="dup-badges-row">
                                <span className="badge badge-res">{file.audioCodec.toUpperCase() || "AUDIO"}</span>
                                {channelLabel && <span className="badge badge-res">{channelLabel}</span>}
                              </div>
                            </td>
                            <td className="nowrap dup-num">{formatDuration(file.durationSeconds)}</td>
                            <td className="nowrap dup-num">{formatBytes(file.sizeBytes)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
