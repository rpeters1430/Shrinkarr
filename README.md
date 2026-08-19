# Shrinkarr ⚡

A smart, self-hosted media storage optimizer and automated video transcoder. Designed as a modern, zero-friction alternative to Tdarr — opinionated, automatic hardware acceleration detection, real-time library watching, and built specifically for the Jellyfin, Plex, Sonarr, and Radarr ecosystem.

---

## 🚀 Key Features

- **⚡ Zero-Config Hardware Acceleration**: Automatically detects and benchmarks your GPUs and encoders:
  - **AMD Radeon AMF** (`hevc_amf`, `av1_amf`, `h264_amf`) — *tested at 18x+ real-time speed*
  - **Intel Quick Sync** (`hevc_qsv`, `av1_qsv`, `h264_qsv`)
  - **NVIDIA NVENC** (`hevc_nvenc`, `av1_nvenc`, `h264_nvenc`)
  - **Linux VAAPI** (`hevc_vaapi`, `av1_vaapi`, `h264_vaapi`)
  - **Apple Silicon VideoToolbox** (`hevc_videotoolbox`)
  - **CPU Fallback** (`libsvtav1`, `libx265` 10-bit, `libx264`)
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
git clone https://github.com/rpeters1430/Shrinkarr.git
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
Open **`http://localhost:3000`** in your browser.

---

### Option 2: Docker / Docker Compose

```yaml
version: "3.8"
services:
  shrinkarr:
    image: ghcr.io/rpeters1430/shrinkarr:latest
    container_name: shrinkarr
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=America/New_York
    volumes:
      - ./config:/config
      - ./data:/data
      - /mnt/movies:/movies
      - /mnt/tv:/tv
    devices:
      - /dev/dri:/dev/dri # Intel QuickSync / AMD VAAPI hardware acceleration
```

Start the container:
```bash
docker compose up -d
```

---

## 💻 CLI Commands Reference

Shrinkarr includes a full CLI suite:

```bash
# Start the Web UI and API server
node server/dist/cli/index.js start --port 3000

# Scan a specific library by ID or path
node server/dist/cli/index.js scan --library-id tv-shows

# Run a 30-second simulation test on a file
node server/dist/cli/index.js simulate --file "/path/to/movie.mkv" --preset balanced

# View detected hardware GPUs and encoders
node server/dist/cli/index.js hardware
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
