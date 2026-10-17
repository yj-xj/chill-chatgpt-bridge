param(
    [Parameter(Mandatory=$true)][string]$GameDirectory,
    [string]$BuildDirectory
)
$ErrorActionPreference = 'Stop'
if (-not $BuildDirectory) { $BuildDirectory = Join-Path $PSScriptRoot 'bin' }
$GameDirectory = [IO.Path]::GetFullPath($GameDirectory)
$BuildDirectory = [IO.Path]::GetFullPath($BuildDirectory)
$managed = Join-Path $GameDirectory 'Chill With You_Data\Managed'
$core = Join-Path $GameDirectory 'BepInEx\core'
$plugin = Join-Path $BuildDirectory 'AIChatChineseInput.dll'
$composer = Join-Path $BuildDirectory 'ChillChineseComposer.exe'
$aiChat = Join-Path $GameDirectory 'BepInEx\plugins\AIChat\AIChat.dll'
$cecil = Join-Path $core 'Mono.Cecil.dll'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
foreach ($required in @($plugin, $composer, $aiChat, $cecil, $compiler)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw ('Required test dependency missing: ' + $required) }
}

# All executables here run offline. No game process or plugin lifecycle method is started.
function Invoke-OfflineExecutable([string]$Executable, [string]$Arguments) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = $Arguments
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $child = New-Object Diagnostics.Process
    $child.StartInfo = $start
    try {
        if (-not $child.Start()) { throw 'Offline test process did not start.' }
        if (-not $child.WaitForExit(20000)) {
            $child.Kill()
            $child.WaitForExit()
            throw 'Offline test timed out.'
        }
        $output = $child.StandardOutput.ReadToEnd()
        $failure = $child.StandardError.ReadToEnd()
        if ($child.ExitCode -ne 0) { throw ('Offline test failed (exit ' + $child.ExitCode + '): ' + $failure.Trim()) }
        if ($output.Trim()) { Write-Output $output.Trim() }
    }
    finally { $child.Dispose() }
}

Invoke-OfflineExecutable $composer '--self-test'

# Cecil reads IL as data. It does not load or execute the installed AIChat assembly.
Add-Type -Path $cecil
$reader = New-Object Mono.Cecil.ReaderParameters
$reader.InMemory = $true
$assembly = [Mono.Cecil.AssemblyDefinition]::ReadAssembly($aiChat, $reader)
try {
    $types = @($assembly.MainModule.Types | Where-Object { $_.FullName -eq 'ChillAIMod.AIMod' })
    if ($types.Count -ne 1) { throw 'Expected AIChat AIMod type was not found uniquely.' }
    $draws = @($types[0].Methods | Where-Object { $_.Name -eq 'DrawWindowContent' -and $_.Parameters.Count -eq 1 -and $_.Parameters[0].ParameterType.FullName -eq 'System.Int32' })
    if ($draws.Count -ne 1 -or -not $draws[0].HasBody) { throw 'Expected AIChat DrawWindowContent layout was not found uniquely.' }
    $styledArea = 'System.String UnityEngine.GUILayout::TextArea(System.String,UnityEngine.GUIStyle,UnityEngine.GUILayoutOption[])'
    $keyGetter = 'UnityEngine.KeyCode UnityEngine.Event::get_keyCode()'
    $areaCalls = @($draws[0].Body.Instructions | Where-Object { $_.Operand -is [Mono.Cecil.MethodReference] -and $_.Operand.FullName -ceq $styledArea })
    $keyCalls = @($draws[0].Body.Instructions | Where-Object { $_.Operand -is [Mono.Cecil.MethodReference] -and $_.Operand.FullName -ceq $keyGetter })
    if ($areaCalls.Count -ne 1 -or $keyCalls.Count -ne 1) { throw 'Installed AIChat does not match the guarded Harmony replacement layout.' }
    if ($areaCalls[0].OpCode.Name -ne 'call' -or $keyCalls[0].OpCode.Name -notin @('call', 'callvirt')) { throw 'Unexpected original input call opcode.' }
    Write-Output 'PASS: installed AIChat has exactly one styled TextArea and one keyCode getter in DrawWindowContent.'
}
finally { $assembly.Dispose() }

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('ChillChineseInputTests-' + [Guid]::NewGuid().ToString('N'))
$sourcePath = Join-Path $testRoot 'InputPolicyTests.cs'
$programPath = Join-Path $testRoot 'InputPolicyTests.exe'
$testSource = @'
using System;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using ChillChineseInput;

internal static class InputPolicyTests
{
    private static string[] searchDirectories;
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 3) throw new ArgumentException("Expected local plugin/core/managed paths.");
            searchDirectories = new[] { Path.GetDirectoryName(args[0]), args[1], args[2] };
            AppDomain.CurrentDomain.AssemblyResolve += ResolveLocalDependency;
            return RunChecks();
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().FullName + ": " + error.Message);
            return 1;
        }
    }

    private static Assembly ResolveLocalDependency(object sender, ResolveEventArgs args)
    {
        string name = new AssemblyName(args.Name).Name + ".dll";
        foreach (string directory in searchDirectories)
        {
            string candidate = Path.Combine(directory, name);
            if (File.Exists(candidate)) return Assembly.LoadFrom(candidate);
        }
        return null;
    }

    // JIT this method only after the dependency resolver is registered. Calling MaySend
    // executes pure policy code; it never starts Unity or invokes its native APIs.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int RunChecks()
    {
        int checkedCases = 0;
        foreach (bool focused in new[] { false, true })
        foreach (bool composing in new[] { false, true })
        foreach (bool editorOpen in new[] { false, true })
        foreach (int distance in new[] { -1, 0, 1, 2, 15 })
        {
            bool expected = focused && !composing && !editorOpen && distance > 1;
            bool actual = ChineseInputPlugin.MaySend(focused, composing, 100 + distance, 100, editorOpen);
            if (actual != expected) throw new InvalidOperationException("IME send guard truth table failed.");
            checkedCases++;
        }
        if (!ChineseInputPlugin.MaySend(true, false, 0, -100, false))
            throw new InvalidOperationException("Initial non-composing draft could not send.");
        Console.WriteLine("PASS: " + (checkedCases + 1) + " pure MaySend policy cases; no Unity native API invoked.");
        return 0;
    }
}
'@

try {
    [IO.Directory]::CreateDirectory($testRoot) | Out-Null
    [IO.File]::WriteAllText($sourcePath, $testSource, (New-Object Text.UTF8Encoding($false)))
    $references = @(
        $plugin,
        (Join-Path $core 'BepInEx.dll'),
        (Join-Path $managed 'UnityEngine.dll'),
        (Join-Path $managed 'UnityEngine.CoreModule.dll'),
        (Join-Path $managed 'netstandard.dll')
    )
    foreach ($reference in $references) { if (-not (Test-Path -LiteralPath $reference -PathType Leaf)) { throw ('Missing policy test reference: ' + $reference) } }
    $referenceArgs = @($references | ForEach-Object { '/reference:' + $_ })
    & $compiler /nologo /target:exe /optimize+ ('/out:' + $programPath) @referenceArgs $sourcePath
    if ($LASTEXITCODE -ne 0) { throw 'Offline policy test compilation failed.' }
    # Windows file names cannot contain a quote, so these quoted path arguments cannot
    # inject a second command; ProcessStartInfo does not invoke a shell.
    $arguments = '"' + $plugin + '" "' + $core + '" "' + $managed + '"'
    Invoke-OfflineExecutable $programPath $arguments
}
finally {
    # Remove only the two exact generated files; never recursively delete a computed path.
    foreach ($generated in @($sourcePath, $programPath)) {
        if (Test-Path -LiteralPath $generated -PathType Leaf) { Remove-Item -LiteralPath $generated -Force }
    }
    if (Test-Path -LiteralPath $testRoot -PathType Container) { Remove-Item -LiteralPath $testRoot }
}
Write-Output 'PASS: offline Chinese input checks completed. No plugin installed, configuration changed, or model request sent.'
