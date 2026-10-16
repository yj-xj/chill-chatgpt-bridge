param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Probe', 'Encrypt', 'Decrypt')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$maximumPlaintextBytes = 1048576
$maximumCiphertextBytes = $maximumPlaintextBytes + 65536
$maximumInputBytes = 2 * $maximumCiphertextBytes
$inputBytes = $null
$plainBytes = $null
$protectedBytes = $null
$inputStream = $null
$memoryStream = $null
$readBuffer = $null

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Unsupported platform' }
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser

    if ($Mode -eq 'Probe') {
        $plainBytes = [Text.Encoding]::UTF8.GetBytes('Chill ChatGPT Bridge protection availability check')
        $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect($plainBytes, $null, $scope)
        $roundtrip = [System.Security.Cryptography.ProtectedData]::Unprotect($protectedBytes, $null, $scope)
        try {
            if ([Convert]::ToBase64String($plainBytes) -cne [Convert]::ToBase64String($roundtrip)) { throw 'Protection unavailable' }
        } finally {
            [Array]::Clear($roundtrip, 0, $roundtrip.Length)
        }
        [Console]::Out.Write('ok')
    } else {
        $inputStream = [Console]::OpenStandardInput()
        $memoryStream = New-Object IO.MemoryStream
        $readBuffer = New-Object byte[] 8192
        while (($readCount = $inputStream.Read($readBuffer, 0, $readBuffer.Length)) -gt 0) {
            if (($memoryStream.Length + $readCount) -gt $maximumInputBytes) { throw 'Input too large' }
            $memoryStream.Write($readBuffer, 0, $readCount)
        }
        $inputBytes = $memoryStream.ToArray()

        if ($Mode -eq 'Encrypt') {
            if ($inputBytes.Length -gt $maximumPlaintextBytes) { throw 'Input too large' }
            $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect($inputBytes, $null, $scope)
            if ($protectedBytes.Length -gt $maximumCiphertextBytes) { throw 'Output too large' }
            [Console]::Out.Write([Convert]::ToBase64String($protectedBytes))
        } else {
            $encoded = [Text.Encoding]::ASCII.GetString($inputBytes)
            if ($encoded.Length -eq 0 -or $encoded.Length % 4 -ne 0 -or $encoded -cnotmatch '^[A-Za-z0-9+/]*={0,2}$') { throw 'Invalid input' }
            $protectedBytes = [Convert]::FromBase64String($encoded)
            if ($protectedBytes.Length -eq 0 -or $protectedBytes.Length -gt $maximumCiphertextBytes) { throw 'Invalid input' }
            $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protectedBytes, $null, $scope)
            if ($plainBytes.Length -gt $maximumPlaintextBytes) { throw 'Output too large' }
            [Console]::Out.Write([Convert]::ToBase64String($plainBytes))
        }
    }
} catch {
    [Console]::Error.Write('Windows credential protection failed.')
    exit 1
} finally {
    if ($null -ne $inputBytes) { [Array]::Clear($inputBytes, 0, $inputBytes.Length) }
    if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
    if ($null -ne $protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
    if ($null -ne $readBuffer) { [Array]::Clear($readBuffer, 0, $readBuffer.Length) }
    if ($null -ne $memoryStream) {
        $internalBuffer = $memoryStream.GetBuffer()
        [Array]::Clear($internalBuffer, 0, $internalBuffer.Length)
        $memoryStream.Dispose()
    }
    if ($null -ne $inputStream) { $inputStream.Dispose() }
}
