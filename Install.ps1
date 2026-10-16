param(
    [string]$NodePath,
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\ChillChatGPTBridge'),
    [string]$DataDirectory = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ChillChatGPTBridge'),
    [switch]$NoShortcut
)
$ErrorActionPreference = 'Stop'
$sourceDirectory = $PSScriptRoot
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
if ($DataDirectory -match '["\x00-\x1f]') { throw 'The bridge data directory is invalid.' }
if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$version = & $NodePath --version
if ([version]$version.TrimStart('v') -lt [version]'22.12') { throw 'Node.js 22.12 or newer is required.' }
New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
if ([IO.Path]::GetFullPath($sourceDirectory) -ne [IO.Path]::GetFullPath($InstallDirectory)) {
    Get-ChildItem -LiteralPath $sourceDirectory -Force | Where-Object { $_.Name -notin @('.git','node_modules','runtime') } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $InstallDirectory -Recurse -Force }
}
$runtimeDirectory = Join-Path $InstallDirectory 'runtime'
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
if ([IO.Path]::GetFullPath($NodePath) -ne [IO.Path]::GetFullPath((Join-Path $runtimeDirectory 'node.exe'))) {
    Copy-Item -LiteralPath $NodePath -Destination (Join-Path $runtimeDirectory 'node.exe') -Force
}
if (-not $NoShortcut) {
    $shortcutPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Chill ChatGPT Bridge.lnk'
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
    $shortcut.TargetPath = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $InstallDirectory 'Start.ps1') + '" -DataDirectory "' + $DataDirectory + '"'
    $shortcut.WorkingDirectory = $InstallDirectory
    $shortcut.Description = 'Connect the game to your ChatGPT subscription using official sign-in'
    $shortcut.Save()
}
Write-Output ('Installed Chill ChatGPT Bridge in ' + $InstallDirectory)
& (Join-Path $InstallDirectory 'Start.ps1') -NoBrowser -DataDirectory $DataDirectory
