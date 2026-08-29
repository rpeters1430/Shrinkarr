<#
.SYNOPSIS
    Shrinkarr Native Windows Launcher & Hardware Acceleration Manager
.DESCRIPTION
    Runs Shrinkarr natively on Windows with full GPU hardware acceleration (AMD AMF,
    Intel QuickSync, NVIDIA NVENC). Automatically detects and manages Node.js, FFmpeg,
    npm dependencies, project builds, and configuration.
.PARAMETER Port
    Port for the Web UI and API server (default: 3000).
.PARAMETER Config
    Path to custom config.yaml file (default: config/config.yaml).
.PARAMETER NoBrowser
    Do not automatically open the default web browser upon startup.
.PARAMETER Install
    Force run 'npm install' before starting.
.PARAMETER Build
    Force rebuild of Server and Web UI before starting.
.PARAMETER CheckHardware
    Run full GPU hardware diagnostics before starting.
.PARAMETER Benchmark
    Run live 1080p and 4K HDR transcode speed benchmarks before starting.
.PARAMETER Doctor
    Run Shrinkarr system health check before starting.
.PARAMETER Scan
    Run library scan only and exit.
.PARAMETER Daemon
    Run transcode queue processor as a background daemon only (no Web UI).
.EXAMPLE
    .\scripts\start-windows.ps1
.EXAMPLE
    .\scripts\start-windows.ps1 -Port 8080 -Benchmark
#>

[CmdletBinding()]
param(
    [int]$Port = 3000,
    [string]$Config = "",
    [switch]$NoBrowser,
    [switch]$Install,
    [switch]$Build,
    [switch]$CheckHardware,
    [switch]$Benchmark,
    [switch]$Doctor,
    [switch]$Scan,
    [switch]$Daemon,
    [switch]$AutoInstallFfmpeg
)

$ErrorActionPreference = "Stop"

# Ensure UTF-8 console output for clean rendering of status icons
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

# Resolve root workspace directory
$RootDir = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path "$RootDir\package.json")) {
    $RootDir = (Get-Location).Path
}

# --- ANSI Formatting & Colors ---
$Esc = [char]27
$C_Reset   = "$Esc[0m"
$C_Bold    = "$Esc[1m"
$C_Dim     = "$Esc[2m"
$C_Red     = "$Esc[31m"
$C_Green   = "$Esc[32m"
$C_Yellow  = "$Esc[33m"
$C_Blue    = "$Esc[34m"
$C_Magenta = "$Esc[35m"
$C_Cyan    = "$Esc[36m"
$C_White   = "$Esc[37m"

function Print-Header($title) {
    Write-Host "`n$C_Bold$C_Cyan=== $title ===$C_Reset"
}

function Print-Ok($msg) {
    Write-Host "  $C_Green[✓]$C_Reset $msg"
}

function Print-Warn($msg) {
    Write-Host "  $C_Yellow[!]$C_Reset $msg"
}

function Print-Fail($msg) {
    Write-Host "  $C_Red[✗]$C_Reset $msg"
}

function Print-Info($msg) {
    Write-Host "  $C_Dim[i]$C_Reset $msg"
}

# --- Banner ---
Write-Host "$C_Bold$C_Magenta"
Write-Host '  ____  _            _             _                              '
Write-Host ' / ___|| |__  _ __ (_)_ __  _ __ | | _____ _ __ _ __              '
Write-Host ' \___ \| ''_ \| ''__|| | ''_ \| |/ /| |/ / _ \ ''__| ''__|             '
Write-Host '  ___) | | | | |   | | | | |   < |   <  __/ |  | |                '
Write-Host ' |____/|_| |_|_|   |_|_| |_|_|\_\|_|\_\___|_|  |_|  WINDOWS NATIVE'
Write-Host "$C_Reset"

Print-Header "Shrinkarr Native Windows Initialization"
Print-Info "Working Directory: $RootDir"
Print-Info "Operating System:  $((Get-CimInstance Win32_OperatingSystem).Caption) ($([System.Environment]::OSVersion.Version))"

# -----------------------------------------------------------------------------
# 1. Check Node.js and npm
# -----------------------------------------------------------------------------
Print-Header "1. Runtime & Environment Checks"

$nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
$npmCmd  = Get-Command "npm" -ErrorAction SilentlyContinue

if (-not $nodeCmd) {
    Print-Fail "Node.js was not found in PATH."
    Write-Host ""
    Write-Host "  $C_Yellow Shrinkarr requires Node.js v20+ or v22+ to run natively.$C_Reset"
    
    $isInteractive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
    $wingetCmd = Get-Command "winget" -ErrorAction SilentlyContinue
    if ($wingetCmd -and $isInteractive) {
        $installChoice = Read-Host "  Would you like to install Node.js LTS via winget now? (Y/n)"
        if ($installChoice -ne 'n' -and $installChoice -ne 'N') {
            Write-Host "  Running: winget install OpenJS.NodeJS.LTS..." -ForegroundColor Cyan
            & winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
            Write-Host "`n  Node.js installed. Please restart this terminal/PowerShell window to refresh PATH." -ForegroundColor Green
            exit 0
        }
    }
    
    Write-Host "  Please download and install Node.js LTS from: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

$nodeVerRaw = & node -v
$nodeVerNum = [int]($nodeVerRaw -replace '^v([0-9]+)\..*', '$1')
if ($nodeVerNum -lt 20) {
    Print-Warn "Node.js version is $nodeVerRaw (v20+ recommended for optimal performance)."
} else {
    Print-Ok "Node.js $nodeVerRaw ($($nodeCmd.Source))"
}

# -----------------------------------------------------------------------------
# 2. Check & Resolve FFmpeg / FFprobe
# -----------------------------------------------------------------------------
Print-Header "2. Media Encoding Engine (FFmpeg & FFprobe)"

function Find-FFmpegDirectory {
    # Check if already in PATH
    $ffInPath = Get-Command "ffmpeg" -ErrorAction SilentlyContinue
    if ($ffInPath) {
        return (Split-Path -Parent $ffInPath.Source)
    }

    # Search common Windows directories
    $searchPaths = @(
        "$RootDir\bin",
        "$RootDir\bin\ffmpeg\bin",
        "$RootDir\tools\ffmpeg\bin",
        "C:\ffmpeg\bin",
        "C:\Program Files\ffmpeg\bin",
        "C:\Program Files (x86)\ffmpeg\bin",
        "$env:LOCALAPPDATA\Microsoft\WindowsApps",
        "$env:LOCALAPPDATA\Microsoft\WinGet\Links",
        "$env:USERPROFILE\scoop\apps\ffmpeg\current\bin",
        "$env:USERPROFILE\scoop\shims",
        "C:\ProgramData\chocolatey\bin",
        "C:\tools\ffmpeg\bin"
    )

    foreach ($p in $searchPaths) {
        if (Test-Path "$p\ffmpeg.exe") {
            return $p
        }
    }

    # Check WinGet packages directory recursively
    $wingetPkgRoot = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages"
    if (Test-Path $wingetPkgRoot) {
        $wgMatches = Get-ChildItem -Path $wingetPkgRoot -Recurse -Filter "ffmpeg.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($wgMatches) {
            return (Split-Path -Parent $wgMatches.FullName)
        }
    }

    return $null
}

$ffmpegDir = Find-FFmpegDirectory

if ($ffmpegDir) {
    if ($env:PATH -notlike "*$ffmpegDir*") {
        $env:PATH = "$ffmpegDir;$env:PATH"
        Print-Info "Added FFmpeg directory to session PATH: $ffmpegDir"
    }
} else {
    Print-Warn "FFmpeg executable not detected in PATH or standard directories."
    
    $isInteractive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
    $wingetCmd = Get-Command "winget" -ErrorAction SilentlyContinue
    $installedFfmpeg = $false

    if ($wingetCmd -and ($AutoInstallFfmpeg -or $isInteractive)) {
        $shouldInstall = $AutoInstallFfmpeg
        if (-not $shouldInstall -and $isInteractive) {
            Write-Host ""
            $choice = Read-Host "  Would you like to install FFmpeg (Gyan.FFmpeg with full GPU acceleration) via winget now? (Y/n)"
            if ($choice -ne 'n' -and $choice -ne 'N') {
                $shouldInstall = $true
            }
        }

        if ($shouldInstall) {
            Write-Host "  Installing Gyan.FFmpeg via winget..." -ForegroundColor Cyan
            & winget install --id Gyan.FFmpeg --source winget --accept-package-agreements --accept-source-agreements
            
            # Re-check after winget install
            $ffmpegDir = Find-FFmpegDirectory
            if ($ffmpegDir) {
                $env:PATH = "$ffmpegDir;$env:PATH"
                $installedFfmpeg = $true
            }
        }
    }

    if (-not $installedFfmpeg -and -not $ffmpegDir -and ($AutoInstallFfmpeg -or $isInteractive)) {
        $shouldDownload = $AutoInstallFfmpeg
        if (-not $shouldDownload -and $isInteractive) {
            Write-Host ""
            $choice = Read-Host "  Would you like to download a standalone portable FFmpeg build to .\bin\ffmpeg? (Y/n)"
            if ($choice -ne 'n' -and $choice -ne 'N') {
                $shouldDownload = $true
            }
        }

        if ($shouldDownload) {
            $binTargetDir = "$RootDir\bin\ffmpeg"
            New-Item -ItemType Directory -Force -Path $binTargetDir | Out-Null
            $zipPath = "$RootDir\bin\ffmpeg.zip"
            
            Print-Info "Downloading latest FFmpeg release from Gyan.dev..."
            $ffUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
            try {
                Invoke-WebRequest -Uri $ffUrl -OutFile $zipPath -UseBasicParsing
                Print-Info "Extracting FFmpeg..."
                Expand-Archive -Path $zipPath -DestinationPath "$RootDir\bin\temp_ff" -Force
                $extractedBin = Get-ChildItem -Path "$RootDir\bin\temp_ff" -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
                if ($extractedBin) {
                    $srcBinDir = Split-Path -Parent $extractedBin.FullName
                    Copy-Item -Path "$srcBinDir\*" -Destination $binTargetDir -Recurse -Force
                    Remove-Item -Path "$RootDir\bin\temp_ff" -Recurse -Force
                    Remove-Item -Path $zipPath -Force
                    $ffmpegDir = $binTargetDir
                    $env:PATH = "$ffmpegDir;$env:PATH"
                    Print-Ok "Portable FFmpeg installed to $binTargetDir"
                }
            } catch {
                Print-Fail "Failed to download FFmpeg: $($_.Exception.Message)"
            }
        }
    }
}

$ffVerOutput = ""
try {
    $ffVerOutput = (& ffmpeg -version 2>&1 | Select-Object -First 1)
} catch {
    # ignored
}

if ($ffVerOutput -match "ffmpeg version") {
    Print-Ok "FFmpeg: $ffVerOutput"
} else {
    Print-Fail "FFmpeg is required for video transcoding and media analysis."
    Write-Host "  Please install FFmpeg with hardware acceleration (e.g. 'winget install Gyan.FFmpeg') or add it to your PATH." -ForegroundColor Yellow
    exit 1
}

$ffprobeVer = ""
try {
    $ffprobeVer = (& ffprobe -version 2>&1 | Select-Object -First 1)
} catch {}

if ($ffprobeVer -match "ffprobe version") {
    Print-Ok "FFprobe: $ffprobeVer"
} else {
    Print-Warn "FFprobe not found. Probing media streams might be limited."
}

# -----------------------------------------------------------------------------
# 3. Detect Native Hardware Acceleration (GPUs & Drivers)
# -----------------------------------------------------------------------------
Print-Header "3. Native GPU Hardware Acceleration Detection"

$gpus = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
$hasAmd = $false
$hasNvidia = $false
$hasIntel = $false

foreach ($gpu in $gpus) {
    $name = $gpu.Name
    $driver = $gpu.DriverVersion
    $ramMB = if ($gpu.AdapterRAM) { [math]::Round($gpu.AdapterRAM / 1MB) } else { 0 }
    
    $vendorTag = "Other"
    if ($name -match "AMD|Radeon") {
        $vendorTag = "AMD"
        $hasAmd = $true
    } elseif ($name -match "NVIDIA|GeForce|RTX|GTX|Quadro") {
        $vendorTag = "NVIDIA"
        $hasNvidia = $true
    } elseif ($name -match "Intel|Iris|Arc|UHD|HD Graphics") {
        $vendorTag = "Intel"
        $hasIntel = $true
    }

    $vramStr = if ($ramMB -gt 0) { " ($ramMB MB VRAM)" } else { "" }
    Print-Ok "[$vendorTag] $name (Driver: $driver)$vramStr"
}

# Quick probe of verified hardware encoders
$encodersOutput = (& ffmpeg -hide_banner -encoders 2>&1 | Out-String)
$verifiedEncoders = @()

$candidateEncoders = @(
    @{ Id = "hevc_amf";   Name = "AMD AMF HEVC (H.265)";    Type = "AMD AMF" },
    @{ Id = "av1_amf";    Name = "AMD AMF AV1";             Type = "AMD AMF" },
    @{ Id = "h264_amf";   Name = "AMD AMF H.264";           Type = "AMD AMF" },
    @{ Id = "hevc_nvenc"; Name = "NVIDIA NVENC HEVC (H.265)"; Type = "NVIDIA NVENC" },
    @{ Id = "av1_nvenc";  Name = "NVIDIA NVENC AV1";        Type = "NVIDIA NVENC" },
    @{ Id = "h264_nvenc"; Name = "NVIDIA NVENC H.264";      Type = "NVIDIA NVENC" },
    @{ Id = "hevc_qsv";   Name = "Intel QuickSync HEVC";    Type = "Intel QSV" },
    @{ Id = "av1_qsv";    Name = "Intel QuickSync AV1";     Type = "Intel QSV" },
    @{ Id = "h264_qsv";   Name = "Intel QuickSync H.264";   Type = "Intel QSV" },
    @{ Id = "libsvtav1";  Name = "Software SVT-AV1";        Type = "CPU" },
    @{ Id = "libx265";    Name = "Software x265 (10-bit)";  Type = "CPU" },
    @{ Id = "libx264";    Name = "Software x264";           Type = "CPU" }
)

foreach ($c in $candidateEncoders) {
    if ($encodersOutput -match "\b$($c.Id)\b") {
        $verifiedEncoders += $c
    }
}

$hwCount = ($verifiedEncoders | Where-Object { $_.Type -ne "CPU" }).Count
if ($hwCount -gt 0) {
    Print-Ok "$hwCount Hardware GPU Encoders compiled in FFmpeg:"
    foreach ($enc in ($verifiedEncoders | Where-Object { $_.Type -ne "CPU" })) {
        Write-Host "      • $($enc.Name) [$($enc.Id)]" -ForegroundColor Green
    }
} else {
    Print-Warn "No hardware GPU encoders found in active FFmpeg build. Using high-efficiency CPU software encoding."
}

# -----------------------------------------------------------------------------
# 4. Dependency & Build Synchronization
# -----------------------------------------------------------------------------
Print-Header "4. Application Build & Dependencies"

Push-Location $RootDir
try {
    $nodeModulesExist = Test-Path "$RootDir\node_modules"
    if (-not $nodeModulesExist -or $Install) {
        Print-Info "Installing Node.js dependencies (npm install)..."
        & npm install
        if ($LASTEXITCODE -ne 0) {
            Print-Fail "npm install failed."
            exit $LASTEXITCODE
        }
        Print-Ok "Node modules installed."
    } else {
        Print-Ok "Node modules present."
    }

    $serverDistExist = Test-Path "$RootDir\server\dist\cli\index.js"
    $webDistExist    = Test-Path "$RootDir\web\dist\index.html"

    if (-not $serverDistExist -or -not $webDistExist -or $Build) {
        Print-Info "Building Server and Web UI bundles (npm run build)..."
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            Print-Fail "npm run build failed."
            exit $LASTEXITCODE
        }
        Print-Ok "Server and Web UI built successfully."
    } else {
        Print-Ok "Server and Web UI bundles up-to-date."
    }

    # -----------------------------------------------------------------------------
    # 5. Configuration Setup
    # -----------------------------------------------------------------------------
    Print-Header "5. Configuration Setup"

    $configDir = "$RootDir\config"
    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    }

    $configPath = if ($Config) { $Config } else { "$configDir\config.yaml" }
    if (-not (Test-Path $configPath)) {
        Print-Info "Generating initial Windows-friendly configuration: $configPath"
        
        # Look for existing drives and user video folders
        $userVideoDir = [System.IO.Path]::Combine($env:USERPROFILE, "Videos")
        $sampleLibPath = if (Test-Path $userVideoDir) { $userVideoDir.Replace('\', '/') } else { "C:/Media" }

        $defaultYaml = @"
# Shrinkarr Configuration
# Generated for Windows Native Execution

libraries:
  - id: movies
    name: "Movies"
    path: "$sampleLibPath"
    presetId: "balanced"
    mediaType: "movie"
    autoOptimize: false

presets:
  - id: balanced
    name: "Balanced (HEVC 10-bit)"
    targetCodec: hevc
    targetContainer: mkv
    crf: 24
    hwaccel: auto
    audioMode: copy
    subtitleMode: copy
    bitDepth: 10
    preserveHdr: true

  - id: max-savings
    name: "Maximum Savings (AV1 10-bit)"
    targetCodec: av1
    targetContainer: mkv
    crf: 28
    hwaccel: auto
    audioMode: aac
    subtitleMode: copy
    bitDepth: 10
    preserveHdr: true

  - id: web-youtube
    name: "YouTube & Web Videos (HEVC MP4)"
    targetCodec: hevc
    targetContainer: mp4
    crf: 24
    hwaccel: auto
    audioMode: aac
    subtitleMode: copy
    bitDepth: 8
    preserveHdr: true

  - id: jellyfin-compat
    name: "Jellyfin Direct-Play Compatible"
    targetCodec: hevc
    targetContainer: mp4
    crf: 23
    hwaccel: auto
    audioMode: aac
    subtitleMode: copy
    bitDepth: 8
    preserveHdr: true

  - id: plex-compat
    name: "Plex & Universal Compatibility (H.264 MP4)"
    targetCodec: h264
    targetContainer: mp4
    crf: 22
    hwaccel: auto
    audioMode: aac
    subtitleMode: copy
    bitDepth: 8
    preserveHdr: false

  - id: keep-quality
    name: "High Quality (HEVC Main10)"
    targetCodec: hevc
    targetContainer: mkv
    crf: 20
    hwaccel: auto
    audioMode: copy
    subtitleMode: copy
    bitDepth: 10
    preserveHdr: true

  - id: anime-animation
    name: "Anime & 2D Animation (HEVC 10-bit)"
    targetCodec: hevc
    targetContainer: mkv
    crf: 22
    hwaccel: auto
    audioMode: copy
    subtitleMode: copy
    bitDepth: 10
    preserveHdr: true

  - id: 4k-hdr-preservation
    name: "4K UHD HDR Preservation (HEVC 10-bit)"
    targetCodec: hevc
    targetContainer: mkv
    crf: 22
    hwaccel: auto
    audioMode: copy
    subtitleMode: copy
    bitDepth: 10
    preserveHdr: true

queue:
  concurrency: 1
  pauseOnStreaming: true
  lowPriority: true
  threads: 0 # 0 = auto detect available CPU cores

watcher:
  enabled: true
  intervalMinutes: 15
  settleDelaySeconds: 15
  autoOptimize: false

dbPath: "data/shrinkarr.db"
"@
        Set-Content -Path $configPath -Value $defaultYaml -Encoding UTF8
        Print-Ok "Created configuration at $configPath"
    } else {
        Print-Ok "Using configuration: $configPath"
    }

    # Set environment variable for Shrinkarr CLI
    $env:SHRINKARR_CONFIG = $configPath

    # -----------------------------------------------------------------------------
    # 6. Run Mode Execution
    # -----------------------------------------------------------------------------
    if ($CheckHardware) {
        Print-Header "Running Hardware Diagnostics"
        & node server/dist/cli/index.js hardware
        return
    }

    if ($Benchmark) {
        Print-Header "Running Hardware Benchmarks"
        & node server/dist/cli/index.js hardware --benchmark
        return
    }

    if ($Doctor) {
        Print-Header "Running System Health Check (Doctor)"
        & node server/dist/cli/index.js doctor
        return
    }

    if ($Scan) {
        Print-Header "Scanning Libraries"
        & node server/dist/cli/index.js scan
        return
    }

    if ($Daemon) {
        Print-Header "Starting Queue Daemon (Background Processing Mode)"
        & node server/dist/cli/index.js run
        return
    }

    # -----------------------------------------------------------------------------
    # 7. Start Web Server & Queue Processor
    # -----------------------------------------------------------------------------
    Print-Header "Starting Shrinkarr Web UI & Transcode Engine"
    
    $localUrl = "http://localhost:$Port"
    Write-Host "  $C_Bold$C_Green▶ Shrinkarr Web UI:$C_Reset $C_Cyan$localUrl$C_Reset"
    Write-Host "  $C_Bold$C_Green▶ Config File:$C_Reset      $configPath"
    Write-Host "  $C_Bold$C_Green▶ Hardware Engine:$C_Reset  Native Direct Hardware Passthrough (No Docker overhead)"
    Write-Host "`n  $C_Dim(Press Ctrl+C to stop Shrinkarr gracefully)$C_Reset`n"

    if (-not $NoBrowser) {
        # Open browser in a background task after server startup
        Start-Job -ScriptBlock {
            param($url)
            Start-Sleep -Seconds 2
            Start-Process $url
        } -ArgumentList $localUrl | Out-Null
    }

    & node server/dist/cli/index.js start --port $Port

} finally {
    Pop-Location
}
