[CmdletBinding()]
param([switch]$CheckOnly, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'deploy/runtime.ps1')
$unoRuntime = Get-NexoRuntimeConfig -ProjectRoot $PSScriptRoot
if ($CheckOnly) {
    $unoRuntime | ConvertTo-Json
    return
}
$runtimeCommand = Get-Command dsh.cmd -ErrorAction Stop
$stopMarkerPath = Join-Path $unoRuntime.RuntimeHome 'stop-request.json'
$listener = Get-NetTCPConnection -LocalPort $unoRuntime.Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    try { $health = Invoke-RestMethod -Uri ($unoRuntime.Url + '/api/health') -TimeoutSec 3 } catch { $health = $null }
    if (-not $health -or $health.ok -ne $true -or $health.application.product -ne 'NEXOGENESIS-UNO' -or
        $health.application.generation -ne 'uno-bootstrap-v1' -or $health.application.workspace_id -ne $unoRuntime.WorkspaceId) {
        throw "Port $($unoRuntime.Port) belongs to another or outdated service. UNO will not stop or reuse it."
    }
    Write-Host "[NEXOGENESIS-UNO] This workspace is already running: $($unoRuntime.Url)"
    if (-not $NoBrowser) { Start-Process $unoRuntime.Url }
    return
}
if (Test-Path -LiteralPath $stopMarkerPath) { Remove-Item -LiteralPath $stopMarkerPath -Force }
& (Join-Path $PSScriptRoot 'prepare-nexogenesis.ps1') -ConfigureOnly
$env:DSH_HOME = $unoRuntime.RuntimeHome
$env:NEXO_WEB_URL = $unoRuntime.Url
Set-Location -LiteralPath $unoRuntime.ProjectRoot
Write-Host "[NEXOGENESIS-UNO] Workspace: $($unoRuntime.ProjectRoot)"
Write-Host "[NEXOGENESIS-UNO] Runtime: $($unoRuntime.RuntimeHome)"
Write-Host "[NEXOGENESIS-UNO] Open after startup: $($unoRuntime.Url)"
& $runtimeCommand.Source --profile $unoRuntime.Profile --port $unoRuntime.Port
$runtimeExitCode = $LASTEXITCODE
if ($runtimeExitCode -ne 0) {
    $requestedStop = $null
    if (Test-Path -LiteralPath $stopMarkerPath) {
        try { $requestedStop = Get-Content -LiteralPath $stopMarkerPath -Raw -Encoding UTF8 | ConvertFrom-Json }
        catch { $requestedStop = $null }
    }
    if ($requestedStop -and $requestedStop.workspace_id -eq $unoRuntime.WorkspaceId -and
        [int]$requestedStop.launcher_pid -eq $PID) {
        Remove-Item -LiteralPath $stopMarkerPath -Force -ErrorAction SilentlyContinue
        Write-Host "[NEXOGENESIS-UNO] Service stopped by this workspace stop command."
        return
    }
    throw "Agent runtime exited with code $runtimeExitCode"
}
Remove-Item -LiteralPath $stopMarkerPath -Force -ErrorAction SilentlyContinue
