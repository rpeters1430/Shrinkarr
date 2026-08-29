<#
.SYNOPSIS
    Shrinkarr Live Transcode & GPU Utilization Monitor for Windows (shrinkarr-top)
.DESCRIPTION
    Real-time terminal dashboard monitoring active FFmpeg transcoding processes,
    Windows GPU Video Encode/Decode engine utilization, CPU usage, and Shrinkarr queue progress.
.PARAMETER Interval
    Dashboard refresh interval in seconds (default: 2).
.PARAMETER Once
    Print a single snapshot and exit.
.PARAMETER Port
    Shrinkarr API server port (default: 3000).
.PARAMETER ApiKey
    Shrinkarr API key (auto-detected from config.yaml if omitted).
.EXAMPLE
    .\scripts\shrinkarr-top.ps1
.EXAMPLE
    .\scripts\shrinkarr-top.ps1 -Interval 1
.EXAMPLE
    .\scripts\shrinkarr-top.ps1 -Once
#>

[CmdletBinding()]
param(
    [int]$Interval = 2,
    [switch]$Once,
    [int]$Port = 3000,
    [string]$ApiKey = ""
)

$ErrorActionPreference = "Continue"

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

# --- ANSI Formatting ---
$Esc = [char]27
$C_Reset      = "$Esc[0m"
$C_Bold       = "$Esc[1m"
$C_Dim        = "$Esc[2m"
$C_Red        = "$Esc[31m"
$C_Green      = "$Esc[32m"
$C_Yellow     = "$Esc[33m"
$C_Blue       = "$Esc[34m"
$C_Magenta    = "$Esc[35m"
$C_Cyan       = "$Esc[36m"
$C_White      = "$Esc[37m"
$C_ClearScreen = "$Esc[2J$Esc[H"

# Auto-detect API key from config if not provided
$RootDir = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path "$RootDir\package.json")) {
    $RootDir = (Get-Location).Path
}
$configPath = if ($env:SHRINKARR_CONFIG) { $env:SHRINKARR_CONFIG } else { "$RootDir\config\config.yaml" }

if (-not $ApiKey -and (Test-Path $configPath)) {
    try {
        $configText = Get-Content -Path $configPath -Raw
        if ($configText -match 'apiKey:\s*["'']?([^"''\r\n]+)["'']?') {
            $ApiKey = $matches[1].Trim()
        }
    } catch {}
}

function Format-Bytes($bytes) {
    if (-not $bytes -or $bytes -le 0) { return "0 B" }
    if ($bytes -ge 1TB) { return "$([math]::Round($bytes / 1TB, 2)) TB" }
    if ($bytes -ge 1GB) { return "$([math]::Round($bytes / 1GB, 2)) GB" }
    if ($bytes -ge 1MB) { return "$([math]::Round($bytes / 1MB, 1)) MB" }
    if ($bytes -ge 1KB) { return "$([math]::Round($bytes / 1KB, 1)) KB" }
    return "$bytes B"
}

function Get-GpuEngineStats {
    $gpuStats = @()
    try {
        # Query Windows GPU Engine performance counters (available in Windows 10/11)
        $counters = Get-Counter -Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue -SampleInterval 1 -MaxSamples 1
        if ($counters) {
            $engGroups = @{}
            foreach ($sample in $counters.CounterSamples) {
                # Instance format: pid_XXXX_luid_0x00000000_0x0000E1C9_phys_0_eng_0_engtype_3D
                if ($sample.CookedValue -gt 0 -and $sample.Path -match 'engtype_([a-zA-Z0-9]+)') {
                    $engType = $matches[1]
                    if (-not $engGroups.ContainsKey($engType)) {
                        $engGroups[$engType] = 0.0
                    }
                    $engGroups[$engType] += $sample.CookedValue
                }
            }
            foreach ($k in $engGroups.Keys) {
                $gpuStats += [PSCustomObject]@{
                    Engine = $k
                    Percent = [math]::Round($engGroups[$k], 1)
                }
            }
        }
    } catch {}

    # Check nvidia-smi as fallback/supplement
    $nvSmi = Get-Command "nvidia-smi" -ErrorAction SilentlyContinue
    if ($nvSmi) {
        try {
            $nvOut = (& nvidia-smi --query-gpu=name,utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total --format=csv,noheader,nounits 2>$null)
            if ($nvOut) {
                $parts = ($nvOut -split ",") | ForEach-Object { $_.Trim() }
                if ($parts.Length -ge 6) {
                    $gpuStats += [PSCustomObject]@{
                        Engine = "NVIDIA ($($parts[0])) GPU / Enc / Dec"
                        Percent = "$($parts[1])% / $($parts[2])% / $($parts[3])% (VRAM: $($parts[4])/$($parts[5]) MB)"
                    }
                }
            }
        } catch {}
    }

    return $gpuStats
}

function Get-ShrinkarrData {
    $apiUrl = "http://localhost:$Port/api"
    $headers = @{}
    if ($ApiKey) {
        $headers["X-Api-Key"] = $ApiKey
    }

    $jobsData = $null
    $statsData = $null

    try {
        $jobsJson = Invoke-RestMethod -Uri "$apiUrl/jobs" -Headers $headers -TimeoutSec 2 -ErrorAction SilentlyContinue
        $jobsData = $jobsJson
    } catch {}

    try {
        $statsJson = Invoke-RestMethod -Uri "$apiUrl/stats" -Headers $headers -TimeoutSec 2 -ErrorAction SilentlyContinue
        $statsData = $statsJson
    } catch {}

    return @{ Jobs = $jobsData; Stats = $statsData }
}

function Render-Dashboard {
    $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    
    # 1. System Metrics
    $osInfo = Get-CimInstance Win32_OperatingSystem
    $totalRamMB = [math]::Round($osInfo.TotalVisibleMemorySize / 1024)
    $freeRamMB  = [math]::Round($osInfo.FreePhysicalMemory / 1024)
    $usedRamMB  = $totalRamMB - $freeRamMB
    $ramPercent = [math]::Round(($usedRamMB / $totalRamMB) * 100, 1)

    $cpuLoad = 0
    try {
        $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
        $cpuLoad = $cpu.LoadPercentage
    } catch {}

    # Clear terminal buffer
    Write-Host -NoNewline $C_ClearScreen

    # Header Bar
    Write-Host "$C_Bold$C_Magenta======================================================================$C_Reset"
    Write-Host " $C_Bold$C_White⚡ SHRINKARR WINDOWS TRANSCODE & GPU MONITOR$C_Reset     $C_Dim[$timestamp]$C_Reset"
    Write-Host "$C_Bold$C_Magenta======================================================================$C_Reset"

    # System Status
    Write-Host " $C_Bold$C_Cyan[SYSTEM UTILIZATION]$C_Reset"
    $cpuColor = if ($cpuLoad -gt 85) { $C_Red } elseif ($cpuLoad -gt 50) { $C_Yellow } else { $C_Green }
    $ramColor = if ($ramPercent -gt 85) { $C_Red } elseif ($ramPercent -gt 60) { $C_Yellow } else { $C_Green }

    Write-Host "  • CPU Usage: $cpuColor$cpuLoad%$C_Reset"
    Write-Host "  • Memory:    $ramColor$ramPercent%$C_Reset ($usedRamMB MB used / $totalRamMB MB total)"

    # GPU Engine Utilization
    $gpuStats = Get-GpuEngineStats
    if ($gpuStats.Count -gt 0) {
        Write-Host "`n $C_Bold$C_Cyan[GPU ENGINE ACTIVITY]$C_Reset"
        foreach ($g in $gpuStats) {
            $valStr = if ($g.Percent -is [double] -or $g.Percent -is [int]) { "$($g.Percent)%" } else { "$($g.Percent)" }
            Write-Host "  • $($g.Engine): $C_Green$valStr$C_Reset"
        }
    }

    # Shrinkarr Active Workers & FFmpeg Processes
    $ffProcs = Get-Process -Name "ffmpeg" -ErrorAction SilentlyContinue
    $nodeProcs = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "shrinkarr|server" }

    Write-Host "`n $C_Bold$C_Cyan[ACTIVE PROCESSES]$C_Reset"
    if ($ffProcs) {
        Write-Host "  • Active FFmpeg Transcode Workers: $C_Bold$C_Green$($ffProcs.Count)$C_Reset"
        foreach ($p in $ffProcs) {
            $wsMB = [math]::Round($p.WorkingSet64 / 1MB, 1)
            $cpuTime = $p.TotalProcessorTime.ToString("hh\:mm\:ss")
            Write-Host "    [PID $($p.Id)] Mem: $wsMB MB | CPU Time: $cpuTime" -ForegroundColor DarkCyan
        }
    } else {
        Write-Host "  • No active FFmpeg encoder worker running (Queue idle)" -ForegroundColor DarkGray
    }

    # API Jobs & Queue Status
    $api = Get-ShrinkarrData
    if ($api.Jobs) {
        $activeJobs = $api.Jobs | Where-Object { $_.status -eq "processing" -or $_.status -eq "transcoding" }
        $queuedJobs = $api.Jobs | Where-Object { $_.status -eq "pending" -or $_.status -eq "queued" }

        Write-Host "`n $C_Bold$C_Cyan[TRANSCODE QUEUE & ACTIVE JOBS]$C_Reset"
        if ($activeJobs -and $activeJobs.Count -gt 0) {
            foreach ($job in $activeJobs) {
                $fileName = Split-Path -Leaf $job.inputPath
                $percent = if ($job.progress) { $job.progress.percent } else { 0 }
                $speed   = if ($job.progress -and $job.progress.speed) { $job.progress.speed } else { "-" }
                $fps     = if ($job.progress -and $job.progress.fps) { "$($job.progress.fps) fps" } else { "" }
                $encoder = if ($job.encoderUsed) { $job.encoderUsed } else { "Auto" }

                $barLen = 25
                $fillLen = [math]::Max(0, [math]::Min($barLen, [int]($percent * $barLen / 100)))
                $emptyLen = $barLen - $fillLen
                $bar = ("█" * $fillLen) + ("░" * $emptyLen)

                Write-Host "  ▶ $C_Bold$fileName$C_Reset"
                Write-Host "    Preset: $($job.presetId) | Encoder: $C_Cyan$encoder$C_Reset | Speed: $C_Green$speed$C_Reset $fps"
                Write-Host "    Progress: [$C_Green$bar$C_Reset] $C_Bold$percent%$C_Reset"
            }
        } else {
            Write-Host "  • Queue Status: Idle ($($queuedJobs.Count) pending files waiting)" -ForegroundColor DarkGray
        }

        if ($api.Stats) {
            Write-Host "`n $C_Bold$C_Cyan[STORAGE SAVINGS SUMMARY]$C_Reset"
            $saved = Format-Bytes $api.Stats.spaceSavedBytes
            $totalOrig = Format-Bytes $api.Stats.totalOriginalBytes
            $totalOpt = Format-Bytes $api.Stats.totalOptimizedBytes
            Write-Host "  • Total Space Saved: $C_Bold$C_Green$saved$C_Reset"
            Write-Host "  • Processed Media:   $totalOrig -> $totalOpt ($($api.Stats.completedJobsCount) completed files)"
        }
    } else {
        Write-Host "`n $C_Dim[i] Shrinkarr API not responding on http://localhost:$Port (Server may be starting or stopped)$C_Reset"
    }

    Write-Host "`n$C_Bold$C_Magenta======================================================================$C_Reset"
    Write-Host "  $C_Dim Controls: Press 'q' to exit, 'r' to refresh immediately$C_Reset"
}

# -----------------------------------------------------------------------------
# Main Dashboard Loop
# -----------------------------------------------------------------------------
if ($Once) {
    Render-Dashboard
    exit 0
}

try {
    while ($true) {
        Render-Dashboard
        
        # Check for key presses during interval
        $elapsed = 0.0
        while ($elapsed -lt $Interval) {
            if ([Console]::KeyAvailable) {
                $key = [Console]::ReadKey($true)
                if ($key.KeyChar -eq 'q' -or $key.KeyChar -eq 'Q') {
                    Write-Host "`nExiting shrinkarr-top..."
                    exit 0
                } elseif ($key.KeyChar -eq 'r' -or $key.KeyChar -eq 'R') {
                    break
                }
            }
            Start-Sleep -Milliseconds 200
            $elapsed += 0.2
        }
    }
} finally {
    Write-Host "$C_Reset"
}
