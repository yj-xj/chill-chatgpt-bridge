param(
    [Parameter(Mandatory=$true)][string]$GameDirectory,
    [string]$DataDirectory
)
$ErrorActionPreference = 'Stop'
if (-not $DataDirectory) {
    $DataDirectory = if ($env:CHILL_BRIDGE_DATA_DIR) { $env:CHILL_BRIDGE_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'ChillChatGPTBridge' }
}
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
$keyPath = Join-Path $dataDirectory 'local-client.key'
if (-not (Test-Path -LiteralPath $keyPath)) { throw 'Start the bridge before configuring the game.' }
$localKey = [IO.File]::ReadAllText($keyPath).Trim()
if ($localKey -notmatch '^local-[\w-]{43}$') { throw 'The local bridge credential is invalid.' }
$gameRoot = (Resolve-Path -LiteralPath $GameDirectory).Path
$configPath = Join-Path $gameRoot 'BepInEx\config\com.username.chillaimod.cfg'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'AIChat configuration is missing. Install AIChat and run the game once first.' }
if (-not (Test-Path -LiteralPath (Join-Path $gameRoot 'Chill With You.exe'))) { throw 'This is not the Chill With You game directory.' }
$reader = [IO.StreamReader]::new($configPath, [Text.UTF8Encoding]::new($false), $true)
try {
    $configText = $reader.ReadToEnd()
    $configEncoding = $reader.CurrentEncoding
} finally { $reader.Dispose() }
$lineEnding = [regex]::Match($configText, '\r\n|\n|\r').Value
if (-not $lineEnding) { $lineEnding = [Environment]::NewLine }
$changes = [ordered]@{
    'Use_Ollama_API'='false'; 'ThinkMode'='Default';
    'API_URL'='http://127.0.0.1:17941/v1/chat/completions';
    'API_Key'=$localKey; 'ModelName'='chatgpt-subscription';
    'LogApiRequestBody'='false'; 'FixApiPathForThinkMode'='false'
}
$sectionPattern = '(?ms)^\[1\. LLM\][ \t]*(?:\r?\n|\z).*?(?=^\[|\z)'
$sectionMatch = [regex]::Match($configText, $sectionPattern)
if (-not $sectionMatch.Success) { throw 'Expected AIChat LLM configuration section was not found.' }
$section = $sectionMatch.Value
foreach ($key in $changes.Keys) {
    $pattern = '(?m)^([ \t]*)' + [regex]::Escape($key) + '[ \t]*=[^\r\n]*'
    $replacement = $key + ' = ' + $changes[$key]
    if ([regex]::IsMatch($section,$pattern)) {
        $section = [regex]::Replace($section,$pattern,[Text.RegularExpressions.MatchEvaluator]{param($match) $match.Groups[1].Value + $replacement})
    } else {
        if (-not ($section.EndsWith("`n") -or $section.EndsWith("`r"))) { $section += $lineEnding }
        $section += $replacement + $lineEnding
    }
}
$newConfig = $configText.Substring(0,$sectionMatch.Index) + $section + $configText.Substring($sectionMatch.Index+$sectionMatch.Length)
$backupPath = $configPath + '.before-chatgpt-' + [guid]::NewGuid().ToString('N') + '.bak'
$temporaryPath = $configPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
try {
    [IO.File]::WriteAllText($temporaryPath,$newConfig,$configEncoding)
    # Atomically keep the original file as a unique backup before replacing it.
    [IO.File]::Replace($temporaryPath,$configPath,$backupPath)
} finally {
    if ([IO.File]::Exists($temporaryPath)) { [IO.File]::Delete($temporaryPath) }
}
Write-Output 'AIChat now points to the local ChatGPT subscription bridge. Restart the game to load it.'
