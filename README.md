# Shrinkarr ⚡

A smart, self-hosted media storage optimizer and automated video transcoder. Designed as a modern, zero-friction alternative to Tdarr — opinionated, automatic hardware acceleration detection, real-time library watching, and built specifically for the Jellyfin, Plex, Sonarr, and Radarr ecosystem.

---

## 🚀 Key Features

- **⚡ Zero-Config Hardware Acceleration**: Automatically detects and benchmarks your GPUs and encoders:
  - **AMD Radeon AMF** (`hevc_amf`, `av1_amf`, `h264_amf`) — *tested at 18x+ real-time speed*
  - **Intel Quick Sync** (`hevc_qsv`, `av1_qsv`, `h264_qsv`) — *Intel Iris Xe & UHD Graphics*
  - **NVIDIA NVENC** (`hevc_nvenc`, `av1_nvenc`, `h264_nvenc`)
  - **Linux VAAPI** (`hevc_vaapi`, `av1_vaapi`, `h264_vaapi`)
  - **Apple Silicon VideoToolbox** (`hevc_videotoolbox`)
  - **CPU Fallback** (`libsvtav1`, `libx265` 10-bit, `libx264`)
- **🛡️ NAS Protection & Low-Impact Background Transcoding**:
  - **Kernel Priority Balancing (`lowPriority: true`)**: Transcodes spawn with `nice -n 19` (lowest CPU priority) and `ionice -c 2 -n 7` (lowest I/O priority) on Linux, ensuring Plex/Jellyfin, SMB transfers, and OS tasks always get priority.
  - **Active Streaming Session Protection (`pauseOnStreaming: true`)**: Automatically queries Jellyfin, Emby, and Plex sessions and pauses background transcode jobs while media is actively streaming.
  - **NVMe / SSD Staging Directory (`tempDirectory`)**: Route intermediate transcode files to fast M.2 NVMe SSDs or RAM (`/dev/shm`) to eliminate mechanical HDD seek thrashing during long encodes.
  - **CPU Thread Capping (`threads`) & Overnight Scheduling (`schedule`)**: Limit FFmpeg CPU threads and restrict transcode processing to quiet hours (e.g. 1 AM to 7 AM).
- **🤖 Automated Background Watcher & Scheduler**:
  - Automatically sweeps library directories on a customizable schedule (every 5m, 15m, 30m, 1h, etc.) to detect new video downloads.
  - **Download Settle Guard**: Ensures in-progress downloads or file transfers are not probed while still copying.
  - **Auto-Optimize Mode**: Automatically queues eligible newly added videos for transcode in the background.
- **✨ Quick "Scan for New Videos"**: Fast incremental scans that discover newly added or modified media in seconds without rebuilding whole library databases.
- **🛡️ Format-Aware Subtitle & Multi-Channel Audio Passthrough**:
  - **Blu-Ray PGS Bitmaps** (`hdmv_pgs_subtitle`) & **DVD VobSub** copied natively bit-for-bit.
  - **DTS-HD MA 5.1/7.1**, **TrueHD**, and **Dolby Atmos** multi-channel tracks preserved untouched.
  - **Apple `mov_text`** automatically converted to standard SubRip text (`srt`) when outputting to Matroska (`.mkv`).
  - **Fail-Safe Recovery**: If a corrupt/malformed subtitle stream is encountered in a file, Shrinkarr automatically catches the error and recovers so the main video and audio encode always succeed.
- **🎨 4K UHD & HDR10 / HLG Preservation**:
  - 4K source files remain full 4K UHD in the output (never downscaled).
  - Preserves wide-color gamut HDR metadata (`-color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc`).
- **📊 NAS & Media Storage Analyzer**:
  - Visual breakdown of library storage, potential space savings, and codec distributions (H.264 vs HEVC vs AV1 vs MPEG-2).
  - Built-in drive detection and quick folder navigation for local drives and mapped NAS shares (`Z:\`, `/mnt/nas`, etc.).
- **🧪 30-Second Savings Simulator**: Runs micro-benchmarks on representative sample clips to measure real-world compression ratios and accurately project space savings before committing to full library jobs.
- **🛡️ 6-Point Multi-Stage Safe Verification**:
  - Transcode to temporary staging file $\rightarrow$ `ffprobe` stream verification $\rightarrow$ duration and size tolerance checks $\rightarrow$ staged rollback backup / recycle bin $\rightarrow$ atomic in-place replacement.
- **🔗 Native Media Server Webhooks**: Automatically notifies Jellyfin, Plex, Emby, Sonarr, and Radarr immediately upon transcode completion.

---

## 🛠️ How to Run

### Option 1: Native Node CLI (Windows, macOS, Linux)

#### 1. Prerequisites
- **Node.js** v20+ or v22+
- **FFmpeg & FFprobe** installed and available in your system `PATH` (e.g. `ffmpeg -version`, `ffprobe -version`)

#### 2. Install & Build
```bash
# Clone the repository
git clone https://github.com/rpeters1428/Shrinkarr.git
cd Shrinkarr

# Install dependencies and build both Server (Fastify) and Web UI (React Vite)
npm install
npm run build
```

#### 3. Start Shrinkarr
```bash
# Launch server and web UI on port 3000
node server/dist/cli/index.js start --port 3000

# Or via npm
npm start
```
Open **`http://localhost:3000`** in your browser. On first startup, Shrinkarr generates an API key and prints it to the console (it's also saved in `config/config.yaml`) — enter it in the web UI once to unlock the app; the browser remembers it after that.

---

### Option 2: Docker / Docker Compose (UGREEN, Synology, Unraid, QNAP, Linux)

Images are published to GHCR for both `linux/amd64` and `linux/arm64` — covering Intel Core (i5-1235U, N100, Celeron) and AMD NAS systems as well as ARM-based setups.

```yaml
services:
  shrinkarr:
    image: ghcr.io/rpeters1430/shrinkarr:latest
    container_name: shrinkarr
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      # Match your other media containers' UID/GID so files Shrinkarr writes
      # back into your library come out with the same ownership.
      - PUID=1000
      - PGID=1000
      - TZ=America/New_York
    volumes:
      - ./config:/app/config
      - ./data:/app/data
      - /volume1/Media/Movies:/volume1/Media/Movies
      - /volume1/Media/TV:/volume1/Media/TV
      # (Optional) Mount an NVMe SSD scratch folder for intermediate transcode files
      # - /volume2/scratch:/tmp/shrinkarr
    devices:
      # Intel QuickSync (Iris Xe / UHD) & VAAPI hardware acceleration passthrough
      - /dev/dri:/dev/dri
    # CPU Weight: 256 shares (lower than default 1024) ensures other containers
    # (Jellyfin, Plex, Sonarr) always get CPU priority when competing for cores.
    cpu_shares: 256
```

Start the container:
```bash
docker compose up -d
```

---

## 🎛️ NAS Optimization & Performance Guide

Running media transcoding on a multi-purpose NAS (like the **UGREEN DXP4800 Pro**, **Synology DS920+/DS218+**, or **TerraMaster**) can consume substantial CPU and disk bandwidth if unconstrained. Shrinkarr includes built-in safeguards to ensure smooth background operation:

### 1. Hardware GPU Passthrough vs CPU Transcoding
* **UGREEN DXP4800 Pro / Plus (Intel Core i5-1235U / Iris Xe)**: Has 80 Execution Units with hardware HEVC 10-bit & AV1 decode/encode.
* **Why it matters**: Transcoding via Intel QuickSync / VAAPI uses **< 10% CPU**, whereas software CPU transcoding (`libx265`) will pin all 10 cores (12 threads) at 100% load.
* **Setup**: Pass `/dev/dri:/dev/dri` and use preset setting `hwaccel: vaapi` or `hwaccel: auto`.

### 2. Active Streaming Protection (`pauseOnStreaming`)
Connect Jellyfin, Emby, or Plex under `integrations` in `config/config.yaml`:
```yaml
integrations:
  jellyfin:
    url: http://jellyfin:8096
    apiKey: "your-jellyfin-api-key"
  # Or Plex:
  # plex:
  #   url: http://plex:32400
  #   token: "your-plex-token"

queue:
  concurrency: 1
  pauseOnStreaming: true # Automatically pauses queue during active playback
  lowPriority: true      # nice 19 & ionice 7 background scheduling
  threads: 4             # Limits CPU threads used by FFmpeg
```

### 3. Eliminating Mechanical HDD Seek Thrashing (`tempDirectory`)
* Transcoding reads and writes large multi-gigabyte video files. Reading from and writing to the same SATA HDD RAID pool causes intense mechanical drive head thrashing.
* **Solution**: Point `tempDirectory` in your `queue` config to an M.2 NVMe SSD volume or RAM disk:
```yaml
queue:
  tempDirectory: "/tmp/shrinkarr"
```
Shrinkarr encodes the temporary file onto fast flash storage first, verifies the output, and performs an instant atomic handoff to your HDD array at the end.

### 4. Quiet Hours & Overnight Scheduling
Limit transcoding jobs to off-peak hours:
```yaml
queue:
  schedule:
    enabled: true
    startHour: 1  # 1:00 AM
    endHour: 7    # 7:00 AM
```

---

## 🔍 Hardware Acceleration & Docker Diagnostic Tools

Shrinkarr includes built-in diagnostics and real-time monitoring tools to verify that GPU hardware passthrough, DRM render nodes, VA-API drivers, and hardware encoders are functioning properly.

### 1. Check Hardware from the Host
Run the host-side helper script (auto-detects your running Shrinkarr container, verifies device mounts, and executes in-container diagnostics):

```bash
# Standard hardware & render capability check
./scripts/docker-check-hardware.sh

# Run live transcode speed benchmarks across 1080p and 4K HDR
./scripts/docker-check-hardware.sh --benchmark

# Launch live GPU load & transcode monitor
./scripts/docker-check-hardware.sh --watch

# Output report in JSON format
./scripts/docker-check-hardware.sh --json
```

### 2. Run Diagnostics Inside the Running Docker Container
You can run the tools directly inside any active container via `docker exec`:

```bash
# Full hardware diagnostic (DRM render nodes, VA-API driver, codec matrix, live tests)
docker exec -it shrinkarr check-hardware

# Run multi-resolution 1080p and 4K HDR transcode benchmarks
docker exec -it shrinkarr check-hardware --benchmark

# Live transcode & GPU utilization dashboard (shows speed, active encoder, CPU% & GPU load)
docker exec -it shrinkarr shrinkarr-top
```

### 3. CLI Commands Reference

Shrinkarr includes a full CLI suite:

```bash
# View detected hardware GPUs, DRM render nodes, and verified encoders
node server/dist/cli/index.js hardware

# Run live transcode speed benchmark tests
node server/dist/cli/index.js hardware --benchmark

# Full system health check (config, DB, storage mounts, ffmpeg, and GPU status)
node server/dist/cli/index.js doctor

# Start the Web UI and API server
node server/dist/cli/index.js start --port 3000

# Scan all configured libraries
node server/dist/cli/index.js scan
```

---

## 🧪 Development & Testing

```bash
# Run unit tests across all suites
npm test

# Run tests in watch mode
npm test -w server -- --watch

# Build production bundles
npm run build
```

---

## 📄 License

MIT License. Designed with ❤️ for the self-hosted home media community.

