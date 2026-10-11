$scriptPath = Join-Path $PSScriptRoot "scripts\start-windows.ps1"

$forwardArgs = @()
foreach ($arg in $args) {
    switch ($arg) {
        "update"          { $forwardArgs += "-Update" }
        "--update"        { $forwardArgs += "-Update" }
        "pull"            { $forwardArgs += "-Update" }
        "--pull"          { $forwardArgs += "-Update" }
        "noupdate"        { $forwardArgs += "-NoUpdate" }
        "--noupdate"      { $forwardArgs += "-NoUpdate" }
        "no-update"       { $forwardArgs += "-NoUpdate" }
        "--no-update"     { $forwardArgs += "-NoUpdate" }
        "skip-update"     { $forwardArgs += "-NoUpdate" }
        "--skip-update"   { $forwardArgs += "-NoUpdate" }
        "build"           { $forwardArgs += "-Build" }
        "--build"         { $forwardArgs += "-Build" }
        "rebuild"         { $forwardArgs += "-Build" }
        "--rebuild"       { $forwardArgs += "-Build" }
        "install"         { $forwardArgs += "-Install" }
        "--install"       { $forwardArgs += "-Install" }
        "doctor"          { $forwardArgs += "-Doctor" }
        "--doctor"        { $forwardArgs += "-Doctor" }
        "bench"           { $forwardArgs += "-Benchmark" }
        "benchmark"       { $forwardArgs += "-Benchmark" }
        "--benchmark"     { $forwardArgs += "-Benchmark" }
        "hardware"        { $forwardArgs += "-CheckHardware" }
        "--hardware"      { $forwardArgs += "-CheckHardware" }
        "checkhardware"   { $forwardArgs += "-CheckHardware" }
        "--checkhardware" { $forwardArgs += "-CheckHardware" }
        "scan"            { $forwardArgs += "-Scan" }
        "--scan"          { $forwardArgs += "-Scan" }
        "daemon"          { $forwardArgs += "-Daemon" }
        "--daemon"        { $forwardArgs += "-Daemon" }
        default           { $forwardArgs += $arg }
    }
}

& $scriptPath @forwardArgs
