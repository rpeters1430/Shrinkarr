import { type Job } from "../api/client";

interface JobRowProps {
  job: Job;
  onCancel: (jobId: string) => void;
  cancelling: boolean;
}

export function JobRow({ job, onCancel, cancelling }: JobRowProps) {
  const fileName = job.filePath.split(/[/\\]/).pop() ?? job.filePath;
  const canCancel = job.status === "pending" || job.status === "running";

  return (
    <tr>
      <td className="cell-video-info">
        <div className="video-title" title={fileName}>{fileName}</div>
        <div className="video-path" title={job.filePath}>{job.filePath}</div>
      </td>
      <td>
        <span className={`status-badge status-${job.status}`}>{job.status}</span>
      </td>
      <td style={{ width: "200px" }}>
        <div className="progress-bar-container" style={{ height: "6px" }}>
          <div
            className={`progress-bar-fill ${job.status === "done" ? "savings" : ""}`}
            style={{
              width: `${job.progressPercent}%`,
            }}
          />
        </div>
      </td>
      <td style={{ color: "var(--accent-rose)", fontSize: "0.85rem" }}>{job.error ?? ""}</td>
      <td>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => onCancel(job.id)}
          disabled={!canCancel || cancelling}
        >
          Cancel
        </button>
      </td>
    </tr>
  );
}

