import { useMemo, useState } from "react";
import {
  postLibraryRulePreview,
  postLibraryRuleQueue,
  updateLibrary,
  type Library,
  type LibraryRule,
  type LibraryRuleCondition,
  type Preset,
  type RuleQueueResult,
  type RulePreview,
} from "../api/client";
import { validateLibraryRules } from "../ruleValidation";

type Field = LibraryRuleCondition["field"];
const fields: Array<{ value: Field; label: string }> = [
  { value: "mediaKind", label: "Media kind" }, { value: "path", label: "Path" },
  { value: "videoCodec", label: "Video codec" }, { value: "audioCodec", label: "Audio codec" },
  { value: "container", label: "Container" }, { value: "sizeBytes", label: "File size (bytes)" },
  { value: "durationSeconds", label: "Duration (seconds)" }, { value: "width", label: "Width" },
  { value: "height", label: "Height" }, { value: "bitrateKbps", label: "Bitrate (kbps)" },
  { value: "bitDepth", label: "Bit depth" }, { value: "isHdr", label: "HDR" },
  { value: "audioChannels", label: "Audio channels" }, { value: "subtitleCount", label: "Subtitle count" },
];
const operators: Record<Field, string[]> = {
  mediaKind: ["equals", "oneOf"], path: ["equals", "oneOf", "contains", "glob"],
  videoCodec: ["equals", "oneOf", "contains"], audioCodec: ["equals", "oneOf", "contains"],
  container: ["equals", "oneOf", "contains"], isHdr: ["equals"],
  sizeBytes: ["equals", "oneOf", "greaterThan", "lessThan", "between"],
  durationSeconds: ["equals", "oneOf", "greaterThan", "lessThan", "between"],
  width: ["equals", "oneOf", "greaterThan", "lessThan", "between"],
  height: ["equals", "oneOf", "greaterThan", "lessThan", "between"],
  bitrateKbps: ["equals", "oneOf", "greaterThan", "lessThan", "between"],
  bitDepth: ["equals", "oneOf", "greaterThan", "lessThan", "between"],
  audioChannels: ["equals", "oneOf", "greaterThan", "lessThan", "between"],
  subtitleCount: ["equals", "oneOf", "greaterThan", "lessThan", "between"],
};

function newCondition(field: Field = "path"): LibraryRuleCondition {
  if (field === "isHdr") return { field, operator: "equals", value: true };
  if (field === "mediaKind") return { field, operator: "equals", value: "video" };
  if (["sizeBytes", "durationSeconds", "width", "height", "bitrateKbps", "bitDepth", "audioChannels", "subtitleCount"].includes(field)) {
    return { field: field as "sizeBytes", operator: "greaterThan", value: 0 } as LibraryRuleCondition;
  }
  return { field: field as "path", operator: "contains", value: "" } as LibraryRuleCondition;
}

function conditionValue(condition: LibraryRuleCondition): string {
  if (typeof condition.value === "number" && Number.isNaN(condition.value)) return "";
  return Array.isArray(condition.value) ? condition.value.join(condition.operator === "between" ? ", " : ",") : String(condition.value);
}

function updateCondition(condition: LibraryRuleCondition, field: Field, operator: string, raw: string): LibraryRuleCondition {
  const allowedOperator = operators[field].includes(operator) ? operator : operators[field][0];
  if (field === "isHdr") return { field, operator: "equals", value: raw === "true" };
  const isNumeric = ["sizeBytes", "durationSeconds", "width", "height", "bitrateKbps", "bitDepth", "audioChannels", "subtitleCount"].includes(field);
  const isList = allowedOperator === "oneOf" || allowedOperator === "between";
  const parsedItems = raw.split(",").map((item) => item.trim()).filter(Boolean);
  const items = isList ? parsedItems : [parsedItems[0] ?? ""];
  const value: string | number | boolean | Array<string | number | boolean> = isNumeric
    ? (isList ? items.map(Number) : items[0] ? Number(items[0]) : Number.NaN)
    : field === "mediaKind" && allowedOperator === "oneOf"
      ? items as Array<"video" | "audio">
      : field === "mediaKind" ? items[0] as "video" | "audio" : isList ? items : items[0] ?? "";
  return { field, operator: allowedOperator, value } as LibraryRuleCondition;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(1)} ${units[index]}`;
}

export function LibraryRulesPanel({
  library,
  presets,
  onUpdated,
  onMessage,
}: {
  library: Library;
  presets: Preset[];
  onUpdated: (library: Library) => void;
  onMessage: (message: string, isError?: boolean) => void;
}) {
  const [rules, setRules] = useState<LibraryRule[]>(library.rules ?? []);
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [queueResults, setQueueResults] = useState<RuleQueueResult["results"] | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const [saved, setSaved] = useState(true);
  const scanKind = presets.find((preset) => preset.id === library.presetId)?.mediaKind ?? "video";

  const selectedCount = selectedPaths.size;
  const pagePaths = useMemo(() => new Set((preview?.files ?? []).filter((file) => file.status === "ready" && file.action === "optimize" && file.filePath).map((file) => file.filePath!)), [preview]);

  function changeRule(index: number, patch: Partial<LibraryRule>) {
    setRules((current) => current.map((rule, i) => i === index ? { ...rule, ...patch } : rule));
    setSaved(false);
    setPreview(null);
    setQueueResults(null);
    setSelectedPaths(new Set());
  }

  function moveRule(index: number, delta: -1 | 1) {
    const destination = index + delta;
    if (destination < 0 || destination >= rules.length) return;
    setRules((current) => {
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
    setSaved(false);
    setPreview(null);
    setQueueResults(null);
    setSelectedPaths(new Set());
  }

  async function saveRules() {
    const validationError = validateLibraryRules(rules, presets, scanKind);
    if (validationError) {
      onMessage(validationError, true);
      return;
    }
    setBusy(true);
    try {
      const updated = await updateLibrary(library.id, { rules });
      onUpdated(updated);
      setSaved(true);
      setPreview(null);
      setQueueResults(null);
      setSelectedPaths(new Set());
      onMessage("Library rules saved.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error), true);
    } finally { setBusy(false); }
  }

  async function loadPreview(offset = 0) {
    const validationError = validateLibraryRules(rules, presets, scanKind);
    if (validationError) {
      onMessage(validationError, true);
      return;
    }
    setBusy(true);
    try {
      const result = await postLibraryRulePreview(library.id, rules, offset, 50);
      setPreview(result);
      setQueueResults(null);
      setPage(offset);
      setSelectedPaths(new Set());
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error), true);
    } finally { setBusy(false); }
  }

  async function queueSelected() {
    if (selectedPaths.size === 0) return;
    setBusy(true);
    try {
      const result = await postLibraryRuleQueue(library.id, [...selectedPaths]);
      const skipped = result.results.length - result.queued;
      setQueueResults(result.results);
      onMessage(`Queued ${result.queued} file(s)${skipped ? `; ${skipped} skipped` : ""}. See the per-file results below.`);
      setSelectedPaths(new Set());
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error), true);
    } finally { setBusy(false); }
  }

  function togglePageSelection() {
    setSelectedPaths((current) => {
      const next = new Set(current);
      const allSelected = [...pagePaths].every((path) => next.has(path));
      for (const path of pagePaths) {
        if (allSelected) next.delete(path);
        else next.add(path);
      }
      return next;
    });
  }

  return (
    <section className="card library-rules-panel" aria-labelledby="library-rules-heading">
      <div className="library-rules-header">
        <div>
          <h2 id="library-rules-heading">Optimization rules</h2>
          <p>Rules run from top to bottom. Every condition in a rule must match. The first matching rule wins.</p>
        </div>
        <div className="library-rules-actions">
          <button className="btn btn-secondary" onClick={() => { setRules((current) => [...current, {
            id: `rule-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, name: `Rule ${current.length + 1}`, enabled: true,
            conditions: [newCondition()], action: { type: "keep" },
          }]); setSaved(false); setPreview(null); setQueueResults(null); setSelectedPaths(new Set()); }} disabled={busy || rules.length >= 100}>Add rule</button>
          <button className="btn btn-primary" onClick={saveRules} disabled={busy || saved}>Save rules</button>
          <button className="btn btn-emerald" onClick={() => loadPreview(0)} disabled={busy}>{busy ? "Working…" : "Preview rules"}</button>
        </div>
      </div>
      {rules.length === 0 && <p className="rules-empty">No rules yet. Files use the library’s default preset until you add rules.</p>}
      <div className="library-rule-list">
        {rules.map((rule, ruleIndex) => (
          <article className="library-rule" key={rule.id}>
            <div className="library-rule-title">
              <label className="rule-enable"><input type="checkbox" checked={rule.enabled} onChange={(event) => changeRule(ruleIndex, { enabled: event.target.checked })} /> Enabled</label>
              <input className="form-input rule-name" aria-label="Rule name" value={rule.name} onChange={(event) => changeRule(ruleIndex, { name: event.target.value })} />
              <button className="btn btn-secondary btn-sm" aria-label="Move rule up" onClick={() => moveRule(ruleIndex, -1)} disabled={ruleIndex === 0}>↑</button>
              <button className="btn btn-secondary btn-sm" aria-label="Move rule down" onClick={() => moveRule(ruleIndex, 1)} disabled={ruleIndex === rules.length - 1}>↓</button>
              <button className="btn btn-danger btn-sm" onClick={() => { setRules((all) => all.filter((_, i) => i !== ruleIndex)); setSaved(false); setPreview(null); setQueueResults(null); setSelectedPaths(new Set()); }}>Remove rule</button>
            </div>
            <div className="rule-conditions">
              {rule.conditions.map((condition, conditionIndex) => (
                <div className="rule-condition" key={`${rule.id}-${conditionIndex}`}>
                  <select className="form-select" aria-label="Condition field" value={condition.field} onChange={(event) => {
                    const next = [...rule.conditions]; next[conditionIndex] = newCondition(event.target.value as Field);
                    changeRule(ruleIndex, { conditions: next });
                  }}>{fields.map((field) => <option value={field.value} key={field.value}>{field.label}</option>)}</select>
                  <select className="form-select" aria-label="Condition operator" value={condition.operator} onChange={(event) => {
                    const next = [...rule.conditions]; next[conditionIndex] = updateCondition(condition, condition.field, event.target.value, conditionValue(condition));
                    changeRule(ruleIndex, { conditions: next });
                  }}>{operators[condition.field].map((operator) => <option value={operator} key={operator}>{operator}</option>)}</select>
                  {condition.field === "isHdr" ? <select className="form-select" aria-label="Condition value" value={String(condition.value)} onChange={(event) => {
                    const next = [...rule.conditions]; next[conditionIndex] = { field: "isHdr", operator: "equals", value: event.target.value === "true" };
                    changeRule(ruleIndex, { conditions: next });
                  }}><option value="true">HDR</option><option value="false">SDR</option></select> : condition.field === "mediaKind" && condition.operator === "equals" ? <select className="form-select" aria-label="Condition value" value={String(condition.value)} onChange={(event) => {
                    const next = [...rule.conditions]; next[conditionIndex] = { field: "mediaKind", operator: "equals", value: event.target.value as "video" | "audio" };
                    changeRule(ruleIndex, { conditions: next });
                  }}><option value="video">Video</option><option value="audio">Audio</option></select> :
                    <input className="form-input" aria-label="Condition value" value={conditionValue(condition)} placeholder={condition.operator === "between" ? "lower, upper" : condition.operator === "oneOf" ? "value1, value2" : "Value"} onChange={(event) => {
                      const next = [...rule.conditions]; next[conditionIndex] = updateCondition(condition, condition.field, condition.operator, event.target.value);
                      changeRule(ruleIndex, { conditions: next });
                    }} />}
                  <button className="btn btn-secondary btn-sm" aria-label="Remove condition" disabled={rule.conditions.length <= 1} onClick={() => changeRule(ruleIndex, { conditions: rule.conditions.filter((_, i) => i !== conditionIndex) })}>×</button>
                </div>
              ))}
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => changeRule(ruleIndex, { conditions: [...rule.conditions, newCondition()] })} disabled={rule.conditions.length >= 16}>Add condition (AND)</button>
            <div className="rule-action-row">
              <label htmlFor={`rule-action-${rule.id}`}>Then</label>
              <select id={`rule-action-${rule.id}`} className="form-select" value={rule.action.type === "keep" ? "keep" : `preset:${rule.action.presetId}`} onChange={(event) => changeRule(ruleIndex, { action: event.target.value === "keep" ? { type: "keep" } : { type: "preset", presetId: event.target.value.slice("preset:".length) } })}>
                <option value="keep">Keep file</option>
                {presets.filter((preset) => {
                  const mediaKind = rule.conditions.find((condition) => condition.field === "mediaKind");
                  return (preset.mediaKind ?? "video") === scanKind && mediaKind !== undefined && (Array.isArray(mediaKind.value) ? mediaKind.value : [mediaKind.value]).includes(preset.mediaKind ?? "video");
                }).map((preset) => <option value={`preset:${preset.id}`} key={preset.id}>Optimize with {preset.name}</option>)}
              </select>
            </div>
            {presets.length > 0 && rule.action.type === "keep" && !rule.conditions.some((condition) => condition.field === "mediaKind") && <p className="rules-empty">Add a media kind condition to use a preset action.</p>}
          </article>
        ))}
      </div>
      {preview && <div className="rule-preview" aria-live="polite">
        <div className="rule-preview-heading"><div><h3>Preview</h3><p>Read-only results for indexed files. Changes apply to scans; queueing below is always explicit.</p></div>
          <button className="btn btn-emerald" onClick={queueSelected} disabled={busy || !saved || selectedCount === 0}>Queue selected ({selectedCount})</button>
        </div>
        {!saved && <p className="rule-preview-note">Save these rules and preview again before queueing. Queueing uses the saved library rules.</p>}
        <div className="rule-summary">
          <span><strong>{preview.summary.optimize}</strong> optimize</span><span><strong>{preview.summary.keep}</strong> keep</span>
          <span><strong>{preview.summary.fallback}</strong> fallback to library preset</span><span><strong>{preview.summary.needsScan}</strong> need scan</span>
        </div>
        {preview.summary.ruleMatches.length > 0 && <div className="rule-match-summary">
          <strong>Matches by rule</strong>
          {preview.summary.ruleMatches.map((rule) => <span key={rule.ruleId}>{rule.ruleName}: {rule.matches} matched ({rule.optimize} optimize, {rule.keep} keep)</span>)}
        </div>}
        {preview.summary.needsScan > 0 && <p className="rule-preview-note">Files needing a scan lack the media details required by these rules. Run Scan Library, then preview again.</p>}
        <div className="rule-preview-table-wrap"><table className="rule-preview-table"><thead><tr><th><input type="checkbox" aria-label="Select optimizable files on this page" checked={pagePaths.size > 0 && [...pagePaths].every((path) => selectedPaths.has(path))} onChange={togglePageSelection} /></th><th>File</th><th>Decision</th><th>Matched rule</th><th>Reason</th><th>Est. savings</th></tr></thead>
          <tbody>{preview.files.map((file, index) => <tr key={file.filePath ?? `outside-${index}`}>
            <td>{file.status === "ready" && file.action === "optimize" && file.filePath ? <input type="checkbox" aria-label={`Select ${file.relativePath ?? file.filePath}`} checked={selectedPaths.has(file.filePath)} onChange={() => setSelectedPaths((current) => { const next = new Set(current); if (next.has(file.filePath!)) next.delete(file.filePath!); else next.add(file.filePath!); return next; })} /> : null}</td>
            <td className="rule-file-path" title={file.relativePath}>{file.relativePath ?? "Outside library"}</td>
            <td>{file.status === "needsScan" ? "Needs scan" : file.action === "optimize" ? `Optimize${file.presetId ? ` · ${presets.find((p) => p.id === file.presetId)?.name ?? file.presetId}` : ""}` : "Keep"}</td>
            <td>{file.matchedRuleName ?? (file.fallback ? "Library default" : "—")}</td><td>{file.reason}</td><td>{formatBytes(file.estimatedSavingsBytes)}</td>
          </tr>)}</tbody></table></div>
        <div className="rule-preview-pagination"><span>Showing {preview.files.length ? page + 1 : 0}–{Math.min(page + preview.files.length, preview.pagination.total)} of {preview.pagination.total}</span>
          <div><button className="btn btn-secondary btn-sm" onClick={() => loadPreview(Math.max(0, page - 50))} disabled={busy || page === 0}>Previous</button><button className="btn btn-secondary btn-sm" onClick={() => loadPreview(page + 50)} disabled={busy || !preview.pagination.hasNext}>Next</button></div>
        </div>
        {queueResults && <div className="rule-queue-results" aria-live="polite">
          <h4>Queue results</h4>
          <ul>{queueResults.map((result) => <li key={result.filePath}>
            <span className={result.status === "queued" ? "queue-result-success" : "queue-result-skipped"}>{result.status === "queued" ? "Queued" : "Skipped"}</span>
            <code>{result.relativePath ?? result.filePath}</code>
            {result.status === "queued" ? ` · ${presets.find((preset) => preset.id === result.presetId)?.name ?? result.presetId}` : ` · ${result.reason ?? "Not eligible"}`}
          </li>)}</ul>
        </div>}
      </div>}
    </section>
  );
}
