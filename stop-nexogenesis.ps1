[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'deploy/runtime.ps1')
$runtime = Get-NexoRuntimeConfig -ProjectRoot $PSScriptRoot
$listener = Get-NetTCPConnection -LocalPort $runtime.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) {
    Write-Host "[NEXOGENESIS-UNO] No service is listening on port $($runtime.Port)."
    return
}

try { $health = Invoke-RestMethod -Uri ($runtime.Url + '/api/health') -TimeoutSec 5 }
catch { throw "Port $($runtime.Port) is listening, but its UNO identity cannot be verified. Nothing was stopped." }
if ($health.ok -ne $true -or $health.application.product -ne 'NEXOGENESIS-UNO' -or
    $health.application.generation -ne 'uno-bootstrap-v1' -or $health.application.workspace_id -ne $runtime.WorkspaceId) {
    throw "Port $($runtime.Port) does not belong to this UNO workspace. Nothing was stopped."
}

$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
if (-not $process -or $process.Name -ne 'node.exe' -or $process.CommandLine -notmatch '@deepseek-ai[\\/]dsh' -or
    $process.CommandLine -notmatch '--profile\s+nexogenesis' -or $process.CommandLine -notmatch "--port\s+$($runtime.Port)(?:\s|$)") {
    throw "The verified port owner is not the expected UNO runtime process. Nothing was stopped."
}

function Cancel-UnoStopPreparation {
    param([string]$Token)
    if (-not $Token) { return }
    try {
        Invoke-RestMethod -Uri ($runtime.Url + '/api/runtime/cancel-stop') -Method Post -Headers @{ 'x-nexogenesis-csrf' = $Token } -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null
    } catch { }
}

$stopToken = $null
try {
    $security = Invoke-RestMethod -Uri ($runtime.Url + '/api/security/session') -TimeoutSec 5
    $stopToken = $security.token
    if (-not $stopToken) { throw 'Local request token is unavailable.' }
    $prepared = Invoke-RestMethod -Uri ($runtime.Url + '/api/runtime/prepare-stop') -Method Post -Headers @{ 'x-nexogenesis-csrf' = $stopToken } -ContentType 'application/json' -Body '{}' -TimeoutSec 5
    if ($prepared.ready -ne $true) { throw 'Runtime did not confirm a safe stop boundary.' }
} catch {
    $statusCode = 0
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { $statusCode = [int]$_.Exception.Response.StatusCode }
    if ($statusCode -ne 404) {
        throw "UNO has a compilation or construction task in progress, or the safe-stop boundary could not be established. Pause the task in UNO before stopping the service. Nothing was stopped."
    }
    # Compatibility path for the one deployment that introduces the atomic stop endpoint.
    # It remains fail-closed if the old service cannot prove that no UNO task is running.
    try {
        $preparation = Invoke-RestMethod -Uri ($runtime.Url + '/api/uno/prepare') -TimeoutSec 10
        $running = @($preparation.jobs | Where-Object { $_.status -eq 'running' })
        if ($running.Count -gt 0) { throw 'An active UNO task was found.' }
        $stopToken = $null
    } catch {
        throw "UNO may have a compilation or construction task in progress. Pause it in UNO before stopping the service. Nothing was stopped."
    }
}

$stopMarkerPath = Join-Path $runtime.RuntimeHome 'stop-request.json'
$runtimeShell = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ParentProcessId)" -ErrorAction SilentlyContinue
$launcherProcess = if ($runtimeShell) { Get-CimInstance Win32_Process -Filter "ProcessId=$($runtimeShell.ParentProcessId)" -ErrorAction SilentlyContinue } else { $null }
$launcherMatches = $launcherProcess -and $launcherProcess.Name -eq 'powershell.exe' -and
    $launcherProcess.CommandLine -match '(?i)(?:^|[\s"])(?:[^\s"]*[\\/])?start-nexogenesis\.ps1(?:["\s]|$)'
if ($launcherMatches) {
    [pscustomobject]@{
        workspace_id = $runtime.WorkspaceId
        launcher_pid = $launcherProcess.ProcessId
        runtime_pid = $process.ProcessId
        requested_at = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $stopMarkerPath -Encoding UTF8
}

try { Stop-Process -Id $process.ProcessId -Force }
catch {
    Remove-Item -LiteralPath $stopMarkerPath -Force -ErrorAction SilentlyContinue
    Cancel-UnoStopPreparation -Token $stopToken
    throw
}
$deadline = (Get-Date).AddSeconds(15)
while ((Get-NetTCPConnection -LocalPort $runtime.Port -State Listen -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
}
if (Get-NetTCPConnection -LocalPort $runtime.Port -State Listen -ErrorAction SilentlyContinue) {
    Remove-Item -LiteralPath $stopMarkerPath -Force -ErrorAction SilentlyContinue
    Cancel-UnoStopPreparation -Token $stopToken
    throw "UNO process $($process.ProcessId) did not release port $($runtime.Port)."
}
Write-Host "[NEXOGENESIS-UNO] Stopped this workspace service (PID $($process.ProcessId), port $($runtime.Port))."
