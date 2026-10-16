param(
    [switch]$NoBrowser,
    [string]$DataDirectory
)
$ErrorActionPreference = 'Stop'
$appDirectory = $PSScriptRoot
if (-not $DataDirectory) {
    if ($env:CHILL_BRIDGE_DATA_DIR) { $DataDirectory = $env:CHILL_BRIDGE_DATA_DIR }
    else { $DataDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ChillChatGPTBridge' }
}
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
if ($DataDirectory -match '["\x00-\x1f]') { throw 'The bridge data directory is invalid.' }
$nodePath = Join-Path $appDirectory 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$launcherPath = Join-Path $appDirectory 'launcher.mjs'
if (-not (Test-Path -LiteralPath $launcherPath)) { throw 'The bridge launcher is missing. Reinstall this project.' }
New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null

function Test-BridgeReady {
    try {
        if ((Invoke-RestMethod -Uri 'http://127.0.0.1:17941/health' -TimeoutSec 1).app -ne 'Chill ChatGPT Bridge') { return $false }
        $pidFile = Join-Path $DataDirectory 'bridge.pid'
        if (-not (Test-Path -LiteralPath $pidFile)) { return $false }
        $bridgeProcessId = [IO.File]::ReadAllText($pidFile).Trim()
        if ($bridgeProcessId -notmatch '^\d{1,10}$') { return $false }
        $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 17941 -State Listen -ErrorAction Stop
        return @($listener | Where-Object { $_.OwningProcess -eq [int]$bridgeProcessId }).Count -gt 0
    } catch { return $false }
}

$ready = Test-BridgeReady
if (-not $ready) {
    $otherBridgeReady = $false
    try { $otherBridgeReady = (Invoke-RestMethod -Uri 'http://127.0.0.1:17941/health' -TimeoutSec 1).app -eq 'Chill ChatGPT Bridge' } catch {}
    if ($otherBridgeReady) { throw 'An existing bridge is using a different data directory. Close that bridge before starting this copy; no process was stopped.' }
}
$shell = $null
$desktop = $null
try {
    if (-not $ready -or -not $NoBrowser) {
        $shell = New-Object -ComObject Shell.Application
        $shellWindows = $shell.Windows()
        $desktopHwnd = 0
        $desktop = $shellWindows.FindWindowSW(0, $null, 8, [ref]$desktopHwnd, 1)
        if ($null -eq $desktop -or $null -eq $desktop.Document.Application) {
            throw 'The Windows desktop launcher is unavailable. Start the bridge from your Windows desktop session.'
        }
    }
    if (-not $ready) {
        # Have the existing Explorer launch Node, so the service is independent
        # of a terminal or coding-agent command that may later be cancelled.
        $arguments = '"' + $launcherPath + '" --data-dir "' + $DataDirectory + '"'
        $desktop.Document.Application.ShellExecute($nodePath, $arguments, $appDirectory, 'open', 0)
        $startupDeadline = [DateTime]::UtcNow.AddSeconds(40)
        do {
            Start-Sleep -Milliseconds 250
            $ready = Test-BridgeReady
        } while (-not $ready -and [DateTime]::UtcNow -lt $startupDeadline)
    }
    if (-not $ready) { throw ('Bridge did not start with the selected data directory. Check launcher-error.log in ' + $DataDirectory + '. Port 17941 may already be in use; no other process was stopped.') }
    if (-not $NoBrowser) { $desktop.Document.Application.ShellExecute('http://127.0.0.1:17941', '', $appDirectory, 'open', 1) }
    Write-Output 'Chill ChatGPT Bridge is running at http://127.0.0.1:17941'
} finally {
    if ($null -ne $desktop) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($desktop) }
    if ($null -ne $shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}
