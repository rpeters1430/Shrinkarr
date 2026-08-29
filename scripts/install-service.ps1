<#
.SYNOPSIS
    Installs Shrinkarr as a Windows Background Service / Scheduled Task
.DESCRIPTION
    Configures Shrinkarr to run silently in the background 24/7 on Windows, starting
    automatically upon system boot or user logon with full hardware acceleration.
.PARAMETER TaskName
    Name of the Windows Scheduled Task (default: "Shrinkarr").
.PARAMETER Port
    Port for the Web UI and API server (default: 3000).
.PARAMETER Config
    Path to custom config.yaml file (default: config/config.yaml).
.PARAMETER AtLogon
    Trigger task on user logon instead of system startup.
.EXAMPLE
    .\scripts\install-service.ps1
.EXAMPLE
    .\scripts\install-service.ps1 -AtLogon -Port 3000
#>

[CmdletBinding()]
param(
    [string]$TaskName = "Shrinkarr",
    [int]$Port = 3000,
    [string]$Config = "",
    [switch]$AtLogon
)

$ErrorActionPreference = "Stop"

# Resolve root workspace
$RootDir = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path "$RootDir\package.json")) {
    $RootDir = (Get-Location).Path
}

$logsDir = "$RootDir\logs"
if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
}

$nodePath = (Get-Command "node" -ErrorAction Stop).Source
$serverJs = "$RootDir\server\dist\cli\index.js"

if (-not (Test-Path $serverJs)) {
    Write-Host "Shrinkarr build files not found. Building now..." -ForegroundColor Cyan
    Push-Location $RootDir
    try {
        & npm run build
    } finally {
        Pop-Location
    }
}

$configPath = if ($Config) { $Config } else { "$RootDir\config\config.yaml" }
$logOut = "$logsDir\shrinkarr.log"
$logErr = "$logsDir\shrinkarr-error.log"

# Create a VBS / PowerShell silent launcher script
$runnerScript = "$RootDir\scripts\run-service-background.ps1"
$scriptBody = @"
`$env:SHRINKARR_CONFIG = "$configPath"
`$env:PATH = "$RootDir\bin;$RootDir\bin\ffmpeg\bin;`$env:PATH"
Set-Location "$RootDir"
& "$nodePath" "$serverJs" start --port $Port >> "$logOut" 2>> "$logErr"
"@
Set-Content -Path $runnerScript -Value $scriptBody -Encoding UTF8

Write-Host "Creating Windows Scheduled Task: '$TaskName'..." -ForegroundColor Cyan

# Action: launch powershell hidden
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runnerScript`"" `
    -WorkingDirectory "$RootDir"

# Trigger: Startup or Logon
$trigger = if ($AtLogon) {
    New-ScheduledTaskTrigger -AtLogOn
} else {
    New-ScheduledTaskTrigger -AtStartup
}

# Settings: Continuous background execution, restart on failure
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([System.TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Highest

# Register task
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

Write-Host "`n[✓] Scheduled Task '$TaskName' registered successfully!" -ForegroundColor Green
Write-Host "  • Web UI Port:    http://localhost:$Port"
Write-Host "  • Logs:          $logOut"
Write-Host "  • Error Logs:    $logErr"
Write-Host "  • Autostart:     $(if ($AtLogon) { 'User Logon' } else { 'System Startup' })"

$startNow = Read-Host "`nWould you like to start the background service now? (Y/n)"
if ($startNow -ne 'n' -and $startNow -ne 'N') {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Service started. Shrinkarr is now running in the background." -ForegroundColor Green
}
