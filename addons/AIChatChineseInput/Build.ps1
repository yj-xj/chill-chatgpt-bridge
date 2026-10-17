param(
    [Parameter(Mandatory=$true)][string]$GameDirectory,
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $PSScriptRoot 'bin' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$managed = Join-Path $GameDirectory 'Chill With You_Data\Managed'
$core = Join-Path $GameDirectory 'BepInEx\core'
$references = @(
    (Join-Path $core 'BepInEx.dll'), (Join-Path $core '0Harmony.dll'),
    (Join-Path $managed 'UnityEngine.dll'), (Join-Path $managed 'UnityEngine.CoreModule.dll'),
    (Join-Path $managed 'UnityEngine.IMGUIModule.dll'), (Join-Path $managed 'UnityEngine.InputLegacyModule.dll'),
    (Join-Path $managed 'UnityEngine.UIElementsModule.dll'),
    (Join-Path $managed 'netstandard.dll')
)
foreach ($file in @($compiler) + $references) { if (-not (Test-Path -LiteralPath $file)) { throw ('Required local build dependency missing: ' + $file) } }
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$referenceArgs = @($references | ForEach-Object { '/reference:' + $_ })
& $compiler /nologo /target:library /optimize+ ('/out:' + (Join-Path $OutputDirectory 'AIChatChineseInput.dll')) @referenceArgs (Join-Path $PSScriptRoot 'ChineseInputPlugin.cs')
if ($LASTEXITCODE -ne 0) { throw 'Plugin compilation failed.' }
& $compiler /nologo /target:winexe /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll ('/out:' + (Join-Path $OutputDirectory 'ChillChineseComposer.exe')) (Join-Path $PSScriptRoot 'NativeComposer.cs')
if ($LASTEXITCODE -ne 0) { throw 'Composer compilation failed.' }
Get-FileHash -LiteralPath (Join-Path $OutputDirectory 'AIChatChineseInput.dll'), (Join-Path $OutputDirectory 'ChillChineseComposer.exe') -Algorithm SHA256
