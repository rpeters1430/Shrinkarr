import { useEffect, useRef, useState } from "react";
import { getJobs, postCancelJob, type Job } from "../api/client";
import { JobRow } from "../components/JobRow";

const POLL_INTERVAL_MS = 2000;

export function Queue() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const intervalRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    function poll() {
      getJobs().then(setJobs).catch((err) => setError(String(err)));
    }
    poll();
    intervalRef.current = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalRef.current);
  }, []);

  async function handleCancel(jobId: string) {
    setCancellingId(jobId);
    setError(null);
    try {
      await postCancelJob(jobId);
      const updated = await getJobs();
      setJobs(updated);
    } catch (err) {
      setError(String(err));
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <div style={{ padding: "1rem" }}>
      <h2>Queue</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>File</th>
            <th style={{ textAlign: "left" }}>Status</th>
            <th style={{ textAlign: "left" }}>Progress</th>
            <th style={{ textAlign: "left" }}>Error</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              onCancel={handleCancel}
              cancelling={cancellingId === job.id}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
