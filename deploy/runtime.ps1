# DSH_HOME is an upstream adapter detail, not a shared application directory.
function Get-NexoRuntimeConfig {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    $root = (Resolve-Path -LiteralPath $ProjectRoot).Path.TrimEnd('\', '/')
    $runtimeHome = Join-Path $root '.nexogenesis/runtime'
    foreach ($path in @($root, (Join-Path $root '.nexogenesis'), $runtimeHome)) {
        if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "UNO runtime path must not be a link: $path"
        }
    }
    $port = 3093
    if ($env:NEXO_PORT) {
        $parsed = 0
        if (-not [int]::TryParse($env:NEXO_PORT, [ref]$parsed) -or $parsed -lt 1024 -or $parsed -gt 65535 -or $parsed -in @(3080, 3083)) {
            throw 'NEXO_PORT must be 1024-65535, excluding existing service ports 3080 and 3083.'
        }
        $port = $parsed
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($root.Replace('\', '/').ToLowerInvariant())
        $workspaceId = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
    [pscustomobject]@{
        ProjectRoot = $root
        RuntimeHome = $runtimeHome
        Profile = 'nexogenesis' # Stable upstream preset/session identifier.
        Port = $port
        Url = "http://127.0.0.1:$port"
        WorkspaceId = $workspaceId
    }
}
