<#
.SYNOPSIS
    Uninstalls the Shrinkarr Windows Background Scheduled Task
.DESCRIPTION
    Stops and removes the Shrinkarr Scheduled Task from Windows.
.PARAMETER TaskName
    Name of the Scheduled Task to remove (default: "Shrinkarr").
.EXAMPLE
    .\scripts\uninstall-service.ps1
#>

[CmdletBinding()]
param(
    [string]$TaskName = "Shrinkarr"
)

$ErrorActionPreference = "Continue"

Write-Host "Stopping and removing Windows Scheduled Task '$TaskName'..." -ForegroundColor Cyan

try {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
} catch {}

try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-Host "[✓] Shrinkarr background service '$TaskName' removed successfully." -ForegroundColor Green
} catch {
    Write-Host "[!] Scheduled Task '$TaskName' not found or already removed." -ForegroundColor Yellow
}
