param([string]$ConfigureScript = (Join-Path $PSScriptRoot '..\Configure-Game.ps1'))
$ErrorActionPreference = 'Stop'
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$fixtureRoot = Join-Path $temporaryRoot ('chill-configure-test-' + [guid]::NewGuid().ToString('N'))
$savedLocalAppData = $env:LOCALAPPDATA
$savedBridgeData = $env:CHILL_BRIDGE_DATA_DIR
$checks = 0

function Assert-Check([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}
function Same-Bytes([byte[]]$Left, [byte[]]$Right) {
    return [Convert]::ToBase64String($Left) -eq [Convert]::ToBase64String($Right)
}
function New-GameFixture([string]$Name, [string]$Text, [Text.Encoding]$Encoding) {
    $directory = Join-Path $fixtureRoot $Name
    $configDirectory = Join-Path $directory 'BepInEx\config'
    [IO.Directory]::CreateDirectory($configDirectory) | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $directory 'Chill With You.exe'), [byte[]]@())
    $config = Join-Path $configDirectory 'com.username.chillaimod.cfg'
    [IO.File]::WriteAllText($config, $Text, $Encoding)
    return @{ Directory = $directory; Config = $config }
}
function Invoke-Configuration($Game, [string]$Credential, [string]$DataDirectory) {
    $arguments = @{ GameDirectory = $Game.Directory }
    if ($DataDirectory) { $arguments.DataDirectory = $DataDirectory }
    $outputText = (& $ConfigureScript @arguments 2>&1 | Out-String)
    Assert-Check (-not $outputText.Contains($Credential)) 'Configuration output disclosed the fixture credential.'
    Assert-Check ($outputText.Contains('AIChat now points')) 'The configuration script did not report success.'
}

try {
    [IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
    $env:LOCALAPPDATA = Join-Path $fixtureRoot 'localappdata'
    $env:CHILL_BRIDGE_DATA_DIR = Join-Path $fixtureRoot 'overridden-bridge-data'
    [IO.Directory]::CreateDirectory($env:CHILL_BRIDGE_DATA_DIR) | Out-Null
    $keyPath = Join-Path $env:CHILL_BRIDGE_DATA_DIR 'local-client.key'
    $credentialA = 'local-' + ('a' * 43)
    $credentialB = 'local-' + ('b' * 43)
    [IO.File]::WriteAllText($keyPath, $credentialA)
    $before = "# Independent settings`r`n[0. Other]`r`nAPI_URL = keep-before`r`nEnabled = true`r`n`r`n"
    $after = "[2. Character]`r`nName = Original character`r`nAPI_Key = keep-after`r`nPrompt = Do not alter this`r`n"
    $llm = @(
        '[1. LLM]', '# Preserve this LLM comment',
        'Use_Ollama_API = true', 'ThinkMode = Enable',
        '  API_URL = https://old.example.invalid/v1', 'API_Key = original-fixture-value',
        'ModelName = old-model', 'LogApiRequestBody = true', 'FixApiPathForThinkMode = true',
        'Temperature = 0.65', 'CustomOption = preserve-me', ''
    ) -join "`r`n"
    $game = New-GameFixture 'crlf-bom' ($before + $llm + $after) ([Text.UTF8Encoding]::new($true))
    $originalBytes = [IO.File]::ReadAllBytes($game.Config)
    Invoke-Configuration $game $credentialA
    $configured = [IO.File]::ReadAllText($game.Config)
    Assert-Check ($configured.StartsWith($before) -and $configured.EndsWith($after)) 'Other sections changed.'
    Assert-Check ($configured.Contains('# Preserve this LLM comment') -and $configured.Contains('Temperature = 0.65') -and $configured.Contains('CustomOption = preserve-me')) 'Unrelated LLM settings changed.'
    Assert-Check (-not [regex]::IsMatch($configured, '(?<!\r)\n')) 'CRLF configuration acquired bare LF line endings.'
    $expected = [ordered]@{
        Use_Ollama_API='false'; ThinkMode='Default'; API_URL='http://127.0.0.1:17941/v1/chat/completions';
        API_Key=$credentialA; ModelName='chatgpt-subscription'; LogApiRequestBody='false'; FixApiPathForThinkMode='false'
    }
    foreach ($key in $expected.Keys) {
        $matches = [regex]::Matches($configured.Substring($before.Length, $configured.Length - $before.Length - $after.Length), '(?m)^[ \t]*' + [regex]::Escape($key) + ' = ([^\r\n]*)')
        Assert-Check ($matches.Count -eq 1 -and $matches[0].Groups[1].Value -ceq $expected[$key]) ('LLM field was not correctly replaced: ' + $key)
    }
    $backupFiles = @(Get-ChildItem -LiteralPath (Split-Path $game.Config) -Filter '*.bak')
    Assert-Check ($backupFiles.Count -eq 1) 'Expected exactly one initial backup.'
    Assert-Check (Same-Bytes ([IO.File]::ReadAllBytes($backupFiles[0].FullName)) $originalBytes) 'Initial backup differs from the original file.'
    $currentBytes = [IO.File]::ReadAllBytes($game.Config)
    Assert-Check ($currentBytes[0] -eq 239 -and $currentBytes[1] -eq 187 -and $currentBytes[2] -eq 191) 'UTF-8 BOM was not preserved.'

    # Run immediately again: no sleep, so backup names must remain collision-free.
    [IO.File]::WriteAllText($keyPath, $credentialB)
    Invoke-Configuration $game $credentialB
    $allBackups = @(Get-ChildItem -LiteralPath (Split-Path $game.Config) -Filter '*.bak')
    Assert-Check ($allBackups.Count -eq 2) 'Repeated configuration overwrote an earlier backup.'
    Assert-Check (Same-Bytes ([IO.File]::ReadAllBytes($backupFiles[0].FullName)) $originalBytes) 'The first backup was overwritten.'
    $secondBackup = @($allBackups | Where-Object FullName -ne $backupFiles[0].FullName)[0]
    Assert-Check (Same-Bytes ([IO.File]::ReadAllBytes($secondBackup.FullName)) $currentBytes) 'Second backup did not preserve the preceding configuration.'
    Assert-Check ([IO.File]::ReadAllText($game.Config).Contains('API_Key = ' + $credentialB)) 'Repeated configuration did not use the current local credential.'

    $lf = New-GameFixture 'lf-missing-fields' "[1. LLM]`n# Keep comment`nCustomOption = intact`n`n[2. Other]`nAPI_URL = keep-other`n" ([Text.UTF8Encoding]::new($false))
    Invoke-Configuration $lf $credentialB
    $lfText = [IO.File]::ReadAllText($lf.Config)
    Assert-Check (-not $lfText.Contains("`r")) 'LF configuration acquired CR characters.'
    Assert-Check ($lfText.EndsWith("[2. Other]`nAPI_URL = keep-other`n")) 'Appending missing fields changed the following section.'
    Assert-Check ($lfText.Contains('# Keep comment') -and $lfText.Contains('CustomOption = intact')) 'Appending fields changed unrelated settings.'
    foreach ($key in $expected.Keys) {
        $firstSection = $lfText.Substring(0, $lfText.IndexOf('[2. Other]'))
        Assert-Check ([regex]::Matches($firstSection, '(?m)^' + [regex]::Escape($key) + ' = ').Count -eq 1) ('Missing or duplicate appended field: ' + $key)
    }
    $lfBytes = [IO.File]::ReadAllBytes($lf.Config)
    Assert-Check (-not ($lfBytes[0] -eq 239 -and $lfBytes[1] -eq 187 -and $lfBytes[2] -eq 191)) 'UTF-8 without BOM acquired a BOM.'

    $headerOnly = New-GameFixture 'header-at-eof' '[1. LLM]' ([Text.UTF8Encoding]::new($false))
    Invoke-Configuration $headerOnly $credentialB
    Assert-Check ([IO.File]::ReadAllText($headerOnly.Config).Contains('ModelName = chatgpt-subscription')) 'A section header at EOF was not configured.'

    $utf16 = New-GameFixture 'utf16' "[1. LLM]`r`nAPI_URL = old`r`nCustomOption = preserved`r`n" ([Text.Encoding]::Unicode)
    Invoke-Configuration $utf16 $credentialB
    $utf16Bytes = [IO.File]::ReadAllBytes($utf16.Config)
    Assert-Check ($utf16Bytes[0] -eq 255 -and $utf16Bytes[1] -eq 254) 'UTF-16 encoding was not preserved.'
    Assert-Check ([IO.File]::ReadAllText($utf16.Config).Contains('CustomOption = preserved')) 'UTF-16 content changed.'

    $missingSection = New-GameFixture 'missing-section' "[2. Other]`nKeep = true`n" ([Text.UTF8Encoding]::new($false))
    $missingBytes = [IO.File]::ReadAllBytes($missingSection.Config)
    $rejected = $false
    try { & $ConfigureScript -GameDirectory $missingSection.Directory | Out-Null } catch { $rejected = $true }
    Assert-Check $rejected 'A missing LLM section was not rejected.'
    Assert-Check (Same-Bytes ([IO.File]::ReadAllBytes($missingSection.Config)) $missingBytes) 'Rejected configuration modified the file.'
    Assert-Check (@(Get-ChildItem -LiteralPath (Split-Path $missingSection.Config) -Filter '*.bak').Count -eq 0) 'Rejected configuration created a backup.'
    Assert-Check (@(Get-ChildItem -LiteralPath $fixtureRoot -Filter '*.tmp' -Recurse).Count -eq 0) 'Temporary configuration files were left behind.'

    # Keep the 45 configuration/backup checks above, then verify data-directory
    # precedence entirely within this fixture's isolated LocalAppData tree.
    $explicitDirectory = Join-Path $fixtureRoot 'explicit [bridge]'
    $defaultDirectory = Join-Path $env:LOCALAPPDATA 'ChillChatGPTBridge'
    [IO.Directory]::CreateDirectory($explicitDirectory) | Out-Null
    [IO.Directory]::CreateDirectory($defaultDirectory) | Out-Null
    $credentialC = 'local-' + ('c' * 43)
    [IO.File]::WriteAllText((Join-Path $explicitDirectory 'local-client.key'), $credentialC)
    [IO.File]::WriteAllText((Join-Path $defaultDirectory 'local-client.key'), $credentialA)
    $minimalConfig = "[1. LLM]`r`nAPI_Key = old-fixture-value`r`n"
    $explicitGame = New-GameFixture 'explicit-data' $minimalConfig ([Text.UTF8Encoding]::new($false))
    Invoke-Configuration $explicitGame $credentialC $explicitDirectory
    Assert-Check ([IO.File]::ReadAllText($explicitGame.Config).Contains('API_Key = ' + $credentialC)) 'Explicit DataDirectory did not override the legacy environment/default.'

    $environmentGame = New-GameFixture 'environment-data' $minimalConfig ([Text.UTF8Encoding]::new($false))
    Invoke-Configuration $environmentGame $credentialB
    Assert-Check ([IO.File]::ReadAllText($environmentGame.Config).Contains('API_Key = ' + $credentialB)) 'The legacy environment data directory did not override the default.'

    $invalidExplicit = New-GameFixture 'invalid-explicit-data' $minimalConfig ([Text.UTF8Encoding]::new($false))
    $invalidOriginal = [IO.File]::ReadAllBytes($invalidExplicit.Config)
    $invalidRejected = $false
    try {
        & $ConfigureScript -GameDirectory $invalidExplicit.Directory -DataDirectory (Join-Path $fixtureRoot 'missing-explicit-data') | Out-Null
    } catch {
        $invalidRejected = $true
        foreach ($credential in @($credentialA, $credentialB, $credentialC)) {
            Assert-Check (-not $_.ToString().Contains($credential)) 'A data-directory error disclosed a fixture credential.'
        }
    }
    Assert-Check $invalidRejected 'An invalid explicit data directory silently fell back to another credential.'
    Assert-Check (Same-Bytes ([IO.File]::ReadAllBytes($invalidExplicit.Config)) $invalidOriginal) 'Rejected data-directory input changed the configuration.'
    Assert-Check (@(Get-ChildItem -LiteralPath (Split-Path $invalidExplicit.Config) -Filter '*.bak').Count -eq 0) 'Rejected data-directory input created a backup.'

    $env:CHILL_BRIDGE_DATA_DIR = $null
    $defaultGame = New-GameFixture 'default-data' $minimalConfig ([Text.UTF8Encoding]::new($false))
    Invoke-Configuration $defaultGame $credentialA
    Assert-Check ([IO.File]::ReadAllText($defaultGame.Config).Contains('API_Key = ' + $credentialA)) 'The default data-directory fallback was not used.'
    $standaloneGame = New-GameFixture 'explicit-without-environment' $minimalConfig ([Text.UTF8Encoding]::new($false))
    Invoke-Configuration $standaloneGame $credentialC $explicitDirectory
    Assert-Check ([IO.File]::ReadAllText($standaloneGame.Config).Contains('API_Key = ' + $credentialC)) 'Explicit DataDirectory failed without the legacy environment variable.'
    Write-Output ('PASS: Configure-Game fixture validation, ' + $checks + ' checks; no real game or installed bridge used.')
} finally {
    $env:LOCALAPPDATA = $savedLocalAppData
    $env:CHILL_BRIDGE_DATA_DIR = $savedBridgeData
    $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
    if (-not $resolvedFixture.StartsWith($temporaryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside temporary directory.' }
    if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
}
