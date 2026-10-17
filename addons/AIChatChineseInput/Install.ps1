param(
    [Parameter(Mandatory=$true)][string]$GameDirectory,
    [string]$BuildDirectory
)
$ErrorActionPreference = 'Stop'
if (-not $BuildDirectory) { $BuildDirectory = Join-Path $PSScriptRoot 'bin' }
$game = (Resolve-Path -LiteralPath $GameDirectory).Path
if (-not (Test-Path -LiteralPath (Join-Path $game 'Chill With You.exe'))) { throw 'Select the Chill With You game folder.' }
if (-not (Test-Path -LiteralPath (Join-Path $game 'BepInEx\plugins\AIChat\AIChat.dll'))) { throw 'Install AIChat Mod first.' }
$names = @('AIChatChineseInput.dll', 'ChillChineseComposer.exe')
foreach ($name in $names) { if (-not (Test-Path -LiteralPath (Join-Path $BuildDirectory $name))) { throw ('Build or extract the release first: ' + $name) } }
$target = Join-Path $game 'BepInEx\plugins\AIChatChineseInput'
if (Test-Path -LiteralPath $target) {
    $backup = $target + '.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
    # Backup only this addon's two files, not any game/account/config data.
    [IO.Directory]::CreateDirectory($backup) | Out-Null
    foreach ($name in $names) {
        $old = Join-Path $target $name
        if (Test-Path -LiteralPath $old) { Copy-Item -LiteralPath $old -Destination (Join-Path $backup ($name + '.bak')) }
    }
}
[IO.Directory]::CreateDirectory($target) | Out-Null
foreach ($name in $names) {
    $source = Join-Path $BuildDirectory $name
    $destination = Join-Path $target $name
    Copy-Item -LiteralPath $source -Destination $destination -Force
    if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) { throw 'Installed addon hash mismatch.' }
}
Write-Output 'Installed AIChat Chinese Input. Restart this game/wallpaper instance to load it.'
