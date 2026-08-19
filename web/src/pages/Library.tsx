import { useEffect, useState } from "react";
import {
  getLibraries,
  getLibraryFiles,
  postJob,
  type FileRecord,
  type Library,
} from "../api/client";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

export function Library() {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string>("");
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [queuing, setQueuing] = useState<string | null>(null);

  useEffect(() => {
    getLibraries().then((libs) => {
      setLibraries(libs);
      if (libs.length > 0) setSelectedLibraryId(libs[0].id);
    });
  }, []);

  useEffect(() => {
    if (!selectedLibraryId) return;
    getLibraryFiles(selectedLibraryId).then(setFiles).catch((err) => setError(String(err)));
  }, [selectedLibraryId]);

  async function handleTranscodeNow(file: FileRecord) {
    const library = libraries.find((l) => l.id === selectedLibraryId);
    if (!library) return;
    setQueuing(file.path);
    setError(null);
    try {
      await postJob(file.path, library.presetId);
    } catch (err) {
      setError(String(err));
    } finally {
      setQueuing(null);
    }
  }

  return (
    <div style={{ padding: "1rem" }}>
      <h2>Library</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <select value={selectedLibraryId} onChange={(e) => setSelectedLibraryId(e.target.value)}>
        {libraries.map((lib) => (
          <option key={lib.id} value={lib.id}>
            {lib.name}
          </option>
        ))}
      </select>
      <table style={{ width: "100%", marginTop: "1rem", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Path</th>
            <th style={{ textAlign: "left" }}>Codec</th>
            <th style={{ textAlign: "left" }}>Size</th>
            <th style={{ textAlign: "left" }}>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={file.path}>
              <td>{file.path}</td>
              <td>{file.codec}</td>
              <td>{formatBytes(file.sizeBytes)}</td>
              <td>{file.needsTranscode ? "eligible" : file.skipReason ?? "ok"}</td>
              <td>
                <button
                  onClick={() => handleTranscodeNow(file)}
                  disabled={!file.needsTranscode || queuing === file.path}
                >
                  {queuing === file.path ? "Queuing..." : "Transcode now"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
