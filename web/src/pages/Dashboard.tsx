import { useEffect, useState } from "react";
import { getLibraries, getStats, postScan, type Library, type Stats } from "../api/client";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

export function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [scanning, setScanning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getStats().then(setStats).catch((err) => setError(String(err)));
    getLibraries().then(setLibraries).catch((err) => setError(String(err)));
  }, []);

  async function handleScanAll() {
    setScanning("all");
    setError(null);
    try {
      for (const library of libraries) {
        await postScan(library.id);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setScanning(null);
    }
  }

  const activeJobs = stats
    ? (stats.jobsByStatus.pending ?? 0) + (stats.jobsByStatus.running ?? 0)
    : 0;

  return (
    <div style={{ padding: "1rem" }}>
      <h1>Shrinkarr</h1>
      {error && <p style={{ color: "red" }}>{error}</p>}
      {stats && (
        <div style={{ display: "flex", gap: "2rem", marginBottom: "1.5rem" }}>
          <div>
            <strong>Files scanned:</strong> {stats.filesScanned}
          </div>
          <div>
            <strong>Space saved:</strong> {formatBytes(stats.spaceSavedBytes)}
          </div>
          <div>
            <strong>Transcoded:</strong> {stats.transcodedCount}
          </div>
          <div>
            <strong>Active jobs:</strong> {activeJobs}
          </div>
        </div>
      )}
      <button onClick={handleScanAll} disabled={scanning !== null || libraries.length === 0}>
        {scanning ? "Scanning..." : "Scan all libraries"}
      </button>
    </div>
  );
}
