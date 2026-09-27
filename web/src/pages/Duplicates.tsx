import { useEffect, useMemo, useState } from "react";
import {
  deleteDuplicates,
  findDuplicates,
  getConfig,
  getLibraries,
  type DuplicateGroup,
  type DuplicateReport,
  type DuplicateSearchOptions,
  type Library,
} from "../api/client";
import { IconSearch, IconTrash } from "../components/Icons";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 3 ? 2 : 1)} ${units[i]}`;
}

function formatDuration(seconds: number): string {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function folderOf(path: string): string {
  const parts = path.split(/[/\\]/);
  parts.pop();
  return parts.join("/");
}

const DEFAULT_OPTIONS: DuplicateSearchOptions = {
  findIdentical: true,
  findSameTitle: true,
  durationToleranceSeconds: 90,
  minSizeMb: 50,
  acrossLibraries: true,
  hashMode: "sampled",
};

interface GroupState {
  keep: string;
  remove: Set<string>;
}

export function Duplicates() {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [selectedLibraries, setSelectedLibraries] = useState<Set<string>>(new Set());
  const [options, setOptions] = useState<DuplicateSearchOptions>(DEFAULT_OPTIONS);
  const [report, setReport] = useState<DuplicateReport | null>(null);
  const [groupState, setGroupState] = useState<Record<string, GroupState>>({});
  const [searching, setSearching] = useState(false);
  const [deleting, setDeleting] = useState(false);
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

  const libraryName = useMemo(() => new Map(libraries.map((l) => [l.id, l.name])), [libraries]);

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
      const remove = new Set(current.remove);
      remove.delete(path);
      return { ...prev, [groupId]: { keep: path, remove } };
    });
  }

  function toggleRemove(groupId: string, path: string) {
    setGroupState((prev) => {
      const current = prev[groupId];
      const remove = new Set(current.remove);
      if (remove.has(path)) remove.delete(path);
      else remove.add(path);
      return { ...prev, [groupId]: { ...current, remove } };
    });
  }

  function selectAllSuggested() {
    setGroupState((prev) => {
      const next: Record<string, GroupState> = {};
      for (const group of report?.groups ?? []) {
        const keep = prev[group.id]?.keep ?? group.files[0].path;
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

  // One entry per file, even if it shows up in two groups.
  const pendingItems = useMemo(() => {
    const items = new Map<string, { path: string; keepPath: string; sizeBytes: number }>();
    for (const group of report?.groups ?? []) {
      const state = groupState[group.id];
      if (!state) continue;
      for (const file of group.files) {
        if (state.remove.has(file.path) && !items.has(file.path)) {
          items.set(file.path, { path: file.path, keepPath: state.keep, sizeBytes: file.sizeBytes });
        }
      }
    }
    return [...items.values()];
  }, [report, groupState]);

  const pendingBytes = pendingItems.reduce((sum, item) => sum + item.sizeBytes, 0);

  async function handleDelete() {
    if (pendingItems.length === 0) return;
    const where = recycleBin ? `moved to the recycle bin (${recycleBin})` : "permanently deleted";
    const confirmed = window.confirm(
      `${pendingItems.length} file(s), ${formatBytes(pendingBytes)} in total, will be ${where}. Continue?`,
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
            return { ...g, files, reclaimableBytes: files.filter((f) => !f.keep).reduce((s, f) => s + f.sizeBytes, 0) };
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
      const verb = result.recycled ? "Moved" : "Deleted";
      const freed = result.recycled ? `${formatBytes(result.freedBytes)} moved to the recycle bin` : `${formatBytes(result.freedBytes)} freed`;
      if (result.deleted.length > 0) setSuccessMsg(`${verb} ${result.deleted.length} file(s), ${freed}.`);
      if (result.failed.length > 0) {
        setError(
          `${result.failed.length} file(s) were not removed: ` +
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

  return (
    <div className="main-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Duplicates</h1>
          <p className="page-subtitle">
            Find copies of the same file and extra encodes of the same title, then remove the ones you don't need.
            Uses scan results, so scan a library before searching it.
          </p>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {successMsg && <div className="alert alert-success">{successMsg}</div>}

      <div className="card dup-options">
        <div className="dup-options-grid">
          <fieldset className="dup-fieldset">
            <legend className="form-label">Libraries</legend>
            {libraries.length === 0 && <p className="dup-hint">No libraries configured yet.</p>}
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
                <small>Same size and same content, whatever the name.</small>
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
                <small>Same movie (title + year), episode (show + SxxEyy) or album track, in any quality.</small>
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
              <p className="dup-hint">Same-title files further apart than this are treated as different cuts.</p>
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
              <p className="dup-hint">Skips samples and trailers. Use 0 for music.</p>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" htmlFor="dup-hash">Content check</label>
              <select
                id="dup-hash"
                className="form-select"
                value={options.hashMode}
                disabled={!options.findIdentical}
                onChange={(e) => setOptions({ ...options, hashMode: e.target.value as DuplicateSearchOptions["hashMode"] })}
              >
                <option value="sampled">Quick: compare 3 MB from each file</option>
                <option value="full">Full: read every byte (slow on large libraries)</option>
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
              <strong>{report.groups.length}</strong> group(s) across {report.filesChecked} file(s).{" "}
              Removing every suggested extra would free <strong>{formatBytes(report.reclaimableBytes)}</strong>.
            </p>
            {report.groups.length > 0 && (
              <div className="dup-summary-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={selectAllSuggested}>
                  Select suggested extras
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={clearSelection}>
                  Clear selection
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
                      : `${recycleBin ? "Recycle" : "Delete"} ${pendingItems.length} (${formatBytes(pendingBytes)})`}
                  </span>
                </button>
              </div>
            )}
          </div>

          {report.groups.length === 0 && (
            <div className="card empty-state">
              <div className="empty-state-icon">
                <IconSearch size={28} />
              </div>
              <h4 className="empty-state-title">No duplicates found</h4>
              <p className="empty-state-desc">
                Nothing matched with these settings. Libraries that haven't been scanned yet have no files to compare.
              </p>
            </div>
          )}

          {report.groups.map((group) => {
            const state = groupState[group.id];
            return (
              <section key={group.id} className="card dup-group" aria-label={group.label}>
                <header className="dup-group-header">
                  <div>
                    <h3 className="dup-group-title">{group.label}</h3>
                    <span className={`badge ${group.match === "identical" ? "badge-status-eligible" : "badge-res"}`}>
                      {group.match === "identical" ? "Identical files" : "Same title"}
                    </span>
                  </div>
                  <span className="dup-group-size">{formatBytes(group.reclaimableBytes)} in extras</span>
                </header>
                <div className="table-container">
                  <table>
                    <thead>
                      <tr>
                        <th className="nowrap">Keep</th>
                        <th className="nowrap">Remove</th>
                        <th>File</th>
                        <th className="nowrap">Video</th>
                        <th className="nowrap">Runtime</th>
                        <th className="nowrap">Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.files.map((file) => {
                        const isKeep = state?.keep === file.path;
                        return (
                          <tr key={file.path} className={state?.remove.has(file.path) ? "dup-row-remove" : undefined}>
                            <td>
                              <input
                                type="radio"
                                name={`keep-${group.id}`}
                                aria-label={`Keep ${fileName(file.path)}`}
                                checked={isKeep}
                                onChange={() => setKeep(group.id, file.path)}
                              />
                            </td>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Remove ${fileName(file.path)}`}
                                disabled={isKeep}
                                checked={state?.remove.has(file.path) ?? false}
                                onChange={() => toggleRemove(group.id, file.path)}
                              />
                            </td>
                            <td className="cell-video-info">
                              <div className="video-title">
                                {fileName(file.path)}
                                {file.keep && <span className="dup-suggested">suggested keep</span>}
                              </div>
                              <div className="video-path" title={file.path}>
                                {libraryName.get(file.libraryId) ?? file.libraryId} · {folderOf(file.path)}
                              </div>
                            </td>
                            <td className="nowrap">
                              {file.width > 0 ? `${file.resolution} ${file.codec.toUpperCase()}` : file.codec.toUpperCase()}
                              {file.isHdr && <span className="badge badge-hdr" style={{ marginLeft: "0.35rem" }}>HDR</span>}
                            </td>
                            <td className="nowrap">{formatDuration(file.durationSeconds)}</td>
                            <td className="nowrap">{formatBytes(file.sizeBytes)}</td>
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
