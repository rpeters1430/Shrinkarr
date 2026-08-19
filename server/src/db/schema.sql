CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  codec TEXT NOT NULL,
  container TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  duration_seconds REAL NOT NULL,
  last_scanned_at TEXT NOT NULL,
  needs_transcode INTEGER NOT NULL,
  skip_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_files_library_id ON files(library_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  progress_percent REAL NOT NULL DEFAULT 0,
  error TEXT,
  original_size_bytes INTEGER,
  new_size_bytes INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_file_path ON jobs(file_path);
