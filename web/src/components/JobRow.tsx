import { type Job } from "../api/client";

const STATUS_COLORS: Record<Job["status"], string> = {
  pending: "#888",
  running: "#0066cc",
  done: "#2e7d32",
  failed: "#c62828",
  cancelled: "#888",
};

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
      <td title={job.filePath}>{fileName}</td>
      <td>
        <span style={{ color: STATUS_COLORS[job.status], fontWeight: 600 }}>{job.status}</span>
      </td>
      <td style={{ width: "200px" }}>
        <div style={{ background: "#eee", borderRadius: 4, overflow: "hidden", height: 8 }}>
          <div
            style={{
              width: `${job.progressPercent}%`,
              background: STATUS_COLORS[job.status],
              height: "100%",
            }}
          />
        </div>
      </td>
      <td>{job.error ?? ""}</td>
      <td>
        <button onClick={() => onCancel(job.id)} disabled={!canCancel || cancelling}>
          Cancel
        </button>
      </td>
    </tr>
  );
}
