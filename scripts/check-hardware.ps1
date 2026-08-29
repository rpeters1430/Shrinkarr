<#
.SYNOPSIS
    Shrinkarr Hardware Acceleration & Render Info Diagnostic Tool for Windows
.DESCRIPTION
    Inspects Windows GPU adapters, DirectX/WDDM drivers, FFmpeg hardware capabilities,
    and executes live transcode speed benchmarks across 1080p and 4K HDR.
.PARAMETER Benchmark
    Run extended multi-resolution hardware encoding benchmarks (1080p & 4K UHD 10-bit HDR).
.PARAMETER Json
    Output full diagnostic report in JSON format.
.PARAMETER Verbose
    Show verbose FFmpeg command execution and error diagnostics.
.EXAMPLE
    .\scripts\check-hardware.ps1
.EXAMPLE
    .\scripts\check-hardware.ps1 -Benchmark
.EXAMPLE
    .\scripts\check-hardware.ps1 -Json
#>

[CmdletBinding()]
param(
    [switch]$Benchmark,
    [switch]$Json,
    [switch]$Detailed
)

$ErrorActionPreference = "Continue"

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

# --- ANSI Colors ---
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
    if (-not $Json) { Write-Host "`n$C_Bold$C_Cyan=== $title ===$C_Reset" }
}

function Print-Sub($title) {
    if (-not $Json) { Write-Host "$C_Bold$C_Blue--- $title ---$C_Reset" }
}

function Print-Ok($msg) {
    if (-not $Json) { Write-Host "  $C_Green[✓]$C_Reset $msg" }
}

function Print-Warn($msg) {
    if (-not $Json) { Write-Host "  $C_Yellow[!]$C_Reset $msg" }
}

function Print-Fail($msg) {
    if (-not $Json) { Write-Host "  $C_Red[✗]$C_Reset $msg" }
}

function Print-Info($msg) {
    if (-not $Json) { Write-Host "  $C_Dim[i]$C_Reset $msg" }
}

# --- Ensure FFmpeg in PATH ---
$ffmpegCmd = Get-Command "ffmpeg" -ErrorAction SilentlyContinue
if (-not $ffmpegCmd) {
    $searchPaths = @(
        "$PSScriptRoot\..\bin",
        "$PSScriptRoot\..\bin\ffmpeg\bin",
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
            $env:PATH = "$p;$env:PATH"
            $ffmpegCmd = Get-Command "ffmpeg" -ErrorAction SilentlyContinue
            break
        }
    }

    if (-not $ffmpegCmd) {
        $wingetPkgRoot = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages"
        if (Test-Path $wingetPkgRoot) {
            $wgMatches = Get-ChildItem -Path $wingetPkgRoot -Recurse -Filter "ffmpeg.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($wgMatches) {
                $ffDir = Split-Path -Parent $wgMatches.FullName
                $env:PATH = "$ffDir;$env:PATH"
                $ffmpegCmd = Get-Command "ffmpeg" -ErrorAction SilentlyContinue
            }
        }
    }
}

# -----------------------------------------------------------------------------
# 1. Collect System Information
# -----------------------------------------------------------------------------
$osInfo = Get-CimInstance Win32_OperatingSystem
$cpuInfo = Get-CimInstance Win32_Processor | Select-Object -First 1

$totalRamGB = [math]::Round($osInfo.TotalVisibleMemorySize / 1MB, 1)
$freeRamGB  = [math]::Round($osInfo.FreePhysicalMemory / 1MB, 1)

$systemReport = [ordered]@{
    osName       = $osInfo.Caption
    osVersion    = $osInfo.Version
    osBuild      = $osInfo.BuildNumber
    architecture = $osInfo.OSArchitecture
    cpuModel     = $cpuInfo.Name.Trim()
    cores        = $cpuInfo.NumberOfCores
    threads      = $cpuInfo.NumberOfLogicalProcessors
    totalRamGB   = $totalRamGB
    freeRamGB    = $freeRamGB
}

# -----------------------------------------------------------------------------
# 2. Collect Video Controllers (GPUs)
# -----------------------------------------------------------------------------
$gpusRaw = Get-CimInstance Win32_VideoController
$detectedGpus = @()

foreach ($gpu in $gpusRaw) {
    $name = $gpu.Name
    $vendor = "other"
    if ($name -match "AMD|Radeon") { $vendor = "amd" }
    elseif ($name -match "NVIDIA|GeForce|RTX|GTX|Quadro") { $vendor = "nvidia" }
    elseif ($name -match "Intel|Iris|Arc|UHD|HD Graphics") { $vendor = "intel" }

    $vramMB = if ($gpu.AdapterRAM) { [math]::Round($gpu.AdapterRAM / 1MB) } else { 0 }
    
    $detectedGpus += [ordered]@{
        name          = $name
        vendor        = $vendor
        driverVersion = $gpu.DriverVersion
        driverDate    = if ($gpu.DriverDate) { (Get-Date $gpu.DriverDate).ToString("yyyy-MM-dd") } else { $null }
        vramMB        = $vramMB
        status        = $gpu.Status
        pnpDeviceId   = $gpu.PNPDeviceID
    }
}

# -----------------------------------------------------------------------------
# 3. Collect FFmpeg Capabilities
# -----------------------------------------------------------------------------
$ffmpegVersion = ""
$ffmpegBuildConf = ""
$hwaccelsList = @()
$decodersOutput = ""
$encodersOutput = ""

if ($ffmpegCmd) {
    $ffOut = (& ffmpeg -version 2>&1 | Out-String)
    $ffmpegVersion = ($ffOut -split "`n")[0]
    $ffmpegBuildConf = $ffOut

    $hwaccelsRaw = (& ffmpeg -hide_banner -hwaccels 2>&1 | Out-String)
    $hwaccelsList = ($hwaccelsRaw -split "`n" | Where-Object { $_ -match '^[a-zA-Z0-9_-]+$' } | ForEach-Object { $_.Trim() })

    $encodersOutput = (& ffmpeg -hide_banner -encoders 2>&1 | Out-String)
    $decodersOutput = (& ffmpeg -hide_banner -decoders 2>&1 | Out-String)
}

# -----------------------------------------------------------------------------
# 4. Probe & Benchmark Encoders
# -----------------------------------------------------------------------------
$candidateEncoders = @(
    # AMD AMF
    @{ Id = "hevc_amf";   Name = "AMD AMF HEVC (H.265)";    Codec = "hevc"; Hwaccel = "amf";    Vendor = "amd" },
    @{ Id = "av1_amf";    Name = "AMD AMF AV1";             Codec = "av1";  Hwaccel = "amf";    Vendor = "amd" },
    @{ Id = "h264_amf";   Name = "AMD AMF H.264";           Codec = "h264"; Hwaccel = "amf";    Vendor = "amd" },
    # NVIDIA NVENC
    @{ Id = "hevc_nvenc"; Name = "NVIDIA NVENC HEVC (H.265)"; Codec = "hevc"; Hwaccel = "nvenc"; Vendor = "nvidia" },
    @{ Id = "av1_nvenc";  Name = "NVIDIA NVENC AV1";        Codec = "av1";  Hwaccel = "nvenc";  Vendor = "nvidia" },
    @{ Id = "h264_nvenc"; Name = "NVIDIA NVENC H.264";      Codec = "h264"; Hwaccel = "nvenc";  Vendor = "nvidia" },
    # Intel QSV
    @{ Id = "hevc_qsv";   Name = "Intel QuickSync HEVC";    Codec = "hevc"; Hwaccel = "qsv";    Vendor = "intel" },
    @{ Id = "av1_qsv";    Name = "Intel QuickSync AV1";     Codec = "av1";  Hwaccel = "qsv";    Vendor = "intel" },
    @{ Id = "h264_qsv";   Name = "Intel QuickSync H.264";   Codec = "h264"; Hwaccel = "qsv";    Vendor = "intel" },
    # Software CPU
    @{ Id = "libx265";    Name = "Software libx265";        Codec = "hevc"; Hwaccel = "cpu";    Vendor = "cpu" },
    @{ Id = "libsvtav1";  Name = "Software SVT-AV1";        Codec = "av1";  Hwaccel = "cpu";    Vendor = "cpu" },
    @{ Id = "libx264";    Name = "Software libx264";        Codec = "h264"; Hwaccel = "cpu";    Vendor = "cpu" }
)

function Test-Encoder($encoderId, $width = 640, $height = 360, $duration = 1.0, $bitDepth = 8) {
    if (-not $ffmpegCmd) { return @{ Working = $false; Speed = 0; Fps = 0; Error = "FFmpeg not found" } }
    if ($encodersOutput -notmatch "\b$encoderId\b") {
        return @{ Working = $false; Speed = 0; Fps = 0; Error = "Encoder not compiled in FFmpeg" }
    }

    $pixFmt = if ($bitDepth -eq 10) { "yuv420p10le" } else { "yuv420p" }
    $testFilter = "testsrc=size=${width}x${height}:rate=30:duration=${duration},format=${pixFmt}"
    
    $args = @(
        "-hide_banner",
        "-loglevel", "error",
        "-stats",
        "-f", "lavfi",
        "-i", $testFilter,
        "-c:v", $encoderId,
        "-f", "null",
        "-"
    )

    try {
        $pInfo = New-Object System.Diagnostics.ProcessStartInfo
        $pInfo.FileName = "ffmpeg"
        $pInfo.Arguments = ($args -join " ")
        $pInfo.RedirectStandardError = $true
        $pInfo.RedirectStandardOutput = $true
        $pInfo.UseShellExecute = $false
        $pInfo.CreateNoWindow = $true

        $proc = [System.Diagnostics.Process]::Start($pInfo)
        $stderrTask = $proc.StandardError.ReadToEndAsync()
        $completed = $proc.WaitForExit(6000)
        
        if (-not $completed) {
            $proc.Kill()
            return @{ Working = $false; Speed = 0; Fps = 0; Error = "Timed out" }
        }

        $stderrText = $stderrTask.Result
        if ($proc.ExitCode -eq 0) {
            $speed = 1.0
            $fps = 0.0

            if ($stderrText -match "speed=\s*([\d\.]+)x") {
                $speed = [double]$matches[1]
            }
            if ($stderrText -match "fps=\s*([\d\.]+)") {
                $fps = [double]$matches[1]
            }

            return @{ Working = $true; Speed = $speed; Fps = $fps; Stderr = $stderrText }
        } else {
            return @{ Working = $false; Speed = 0; Fps = 0; Error = $stderrText.Trim() }
        }
    } catch {
        return @{ Working = $false; Speed = 0; Fps = 0; Error = $_.Exception.Message }
    }
}

$encoderResults = @()

foreach ($cand in $candidateEncoders) {
    $quickTest = Test-Encoder -encoderId $cand.Id -width 640 -height 360 -duration 0.8
    
    $bench1080p = $null
    $bench4k    = $null

    if ($quickTest.Working -and $Benchmark) {
        # 1080p SDR Benchmark (1920x1080 30fps)
        $t1080 = Test-Encoder -encoderId $cand.Id -width 1920 -height 1080 -duration 2.0 -bitDepth 8
        $bench1080p = @{ Speed = $t1080.Speed; Fps = $t1080.Fps }

        # 4K HDR Benchmark (3840x2160 30fps 10-bit)
        $t4k = Test-Encoder -encoderId $cand.Id -width 3840 -height 2160 -duration 1.5 -bitDepth 10
        $bench4k = @{ Speed = $t4k.Speed; Fps = $t4k.Fps }
    }

    $encoderResults += [ordered]@{
        id          = $cand.Id
        name        = $cand.Name
        codec       = $cand.Codec
        hwaccel     = $cand.Hwaccel
        vendor      = $cand.Vendor
        working     = $quickTest.Working
        speed       = $quickTest.Speed
        fps         = $quickTest.Fps
        bench1080p  = $bench1080p
        bench4k     = $bench4k
        error       = $quickTest.Error
    }
}

# -----------------------------------------------------------------------------
# 5. Optimal Recommendations Selection
# -----------------------------------------------------------------------------
function Pick-BestEncoder($codec, $defaultCpu) {
    $working = $encoderResults | Where-Object { $_.codec -eq $codec -and $_.working }
    $hwList  = $working | Where-Object { $_.hwaccel -ne "cpu" }

    if ($hwList.Count -gt 0) {
        $sorted = $hwList | Sort-Object -Property speed -Descending
        return $sorted[0]
    }
    
    $cpu = $working | Where-Object { $_.hwaccel -eq "cpu" }
    if ($cpu) { return $cpu[0] }
    return @{ id = $defaultCpu; hwaccel = "cpu"; speed = 1.0; fps = 30 }
}

$recHevc = Pick-BestEncoder "hevc" "libx265"
$recAv1  = Pick-BestEncoder "av1"  "libsvtav1"
$recH264 = Pick-BestEncoder "h264" "libx264"

# -----------------------------------------------------------------------------
# 6. Output Formatting
# -----------------------------------------------------------------------------
if ($Json) {
    $fullReport = [ordered]@{
        system          = $systemReport
        gpus            = $detectedGpus
        ffmpeg          = @{
            version       = $ffmpegVersion
            hwaccels      = $hwaccelsList
        }
        encoders        = $encoderResults
        recommendations = @{
            hevc          = $recHevc.id
            av1           = $recAv1.id
            h264          = $recH264.id
        }
        testedAt        = (Get-Date).ToString("o")
    }
    $fullReport | ConvertTo-Json -Depth 6
    exit 0
}

# --- Visual Report Output ---
Write-Host "`n$C_Bold$C_Magenta======================================================================$C_Reset"
Write-Host "  $C_Bold$C_White SHRINKARR WINDOWS HARDWARE ACCELERATION & RENDER DIAGNOSTIC$C_Reset"
Write-Host "$C_Bold$C_Magenta======================================================================$C_Reset"

Print-Header "1. SYSTEM & PROCESSOR"
Write-Host "  • OS:        $($systemReport.osName) Build $($systemReport.osBuild) ($($systemReport.architecture))"
Write-Host "  • CPU:       $($systemReport.cpuModel) ($($systemReport.cores) Cores, $($systemReport.threads) Threads)"
Write-Host "  • RAM:       $($systemReport.freeRamGB) GB Free / $($systemReport.totalRamGB) GB Total"

Print-Header "2. DETECTED GRAPHICS ADAPTERS"
if ($detectedGpus.Count -gt 0) {
    foreach ($gpu in $detectedGpus) {
        $vendorUpper = $gpu.vendor.ToUpper()
        $vram = if ($gpu.vramMB -gt 0) { "$($gpu.vramMB) MB" } else { "Dynamic" }
        Print-Ok "[$vendorUpper] $($gpu.name)"
        Write-Host "       Driver: $($gpu.driverVersion) ($($gpu.driverDate)) | VRAM: $vram | Status: $($gpu.status)" -ForegroundColor DarkGray
    }
} else {
    Print-Warn "No dedicated graphics adapters detected via WMI."
}

Print-Header "3. FFMPEG ENGINE & HARDWARE DECODING"
if ($ffmpegCmd) {
    Print-Ok $ffmpegVersion
    Write-Host "  • Direct3D / Hardware Decoders: $($hwaccelsList -join ', ')" -ForegroundColor DarkGray
} else {
    Print-Fail "FFmpeg executable not found in PATH."
}

Print-Header "4. HARDWARE & SOFTWARE ENCODER VERIFICATION"
foreach ($enc in $encoderResults) {
    if ($enc.working) {
        $spd = if ($enc.speed -gt 0) { "$($enc.speed.ToString('0.0'))x" } else { "OK" }
        $fps = if ($enc.fps -gt 0) { "$([math]::Round($enc.fps)) FPS" } else { "" }
        Print-Ok "$($enc.name.PadRight(30)) -> $C_Green$spd$C_Reset $($fps)"
        
        if ($enc.bench1080p) {
            Write-Host "       1080p SDR Benchmark: $($enc.bench1080p.speed.ToString('0.0'))x ($([math]::Round($enc.bench1080p.fps)) FPS)" -ForegroundColor DarkCyan
        }
        if ($enc.bench4k) {
            Write-Host "       4K HDR Benchmark:    $($enc.bench4k.speed.ToString('0.0'))x ($([math]::Round($enc.bench4k.fps)) FPS)" -ForegroundColor DarkCyan
        }
    } else {
        $reason = if ($enc.error) { "($($enc.error.Split([char]10)[0]))" } else { "(Unavailable)" }
        Print-Fail "$($enc.name.PadRight(30)) -> $C_Dim$reason$C_Reset"
    }
}

Print-Header "5. OPTIMAL ENCODER SELECTIONS"
Write-Host "  • HEVC (H.265):  $C_Bold$C_Green$($recHevc.id)$C_Reset $(if ($recHevc.speed) { "($($recHevc.speed.ToString('0.0'))x)" })"
Write-Host "  • AV1:           $C_Bold$C_Green$($recAv1.id)$C_Reset $(if ($recAv1.speed) { "($($recAv1.speed.ToString('0.0'))x)" })"
Write-Host "  • H.264:         $C_Bold$C_Green$($recH264.id)$C_Reset $(if ($recH264.speed) { "($($recH264.speed.ToString('0.0'))x)" })"

$hwActive = ($encoderResults | Where-Object { $_.working -and $_.hwaccel -ne "cpu" }).Count -gt 0
$summaryStatus = if ($hwActive) { "$C_Green Native GPU Hardware Acceleration Active!$C_Reset" } else { "$C_Yellow High-Efficiency Software CPU Encoding Active.$C_Reset" }
Write-Host "`n  $C_Bold${C_Cyan}Summary:$C_Reset $summaryStatus`n"
