[CmdletBinding()]
param(
    [switch]$ConfigureOnly
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$projectRootPosix = $projectRoot.Replace("\", "/")
. (Join-Path $projectRoot 'deploy/runtime.ps1')
$unoRuntime = Get-NexoRuntimeConfig -ProjectRoot $projectRoot
# Deliberately ignore inherited DSH_HOME; old credentials/config are not copied.
$env:DSH_HOME = $unoRuntime.RuntimeHome
$dshHome = $unoRuntime.RuntimeHome
$knowledgeDirectories = @(
    "00-Inbox", "01-Cards", "02-Profile", "03-Archive",
    "04-OutBox", "05-Buffer", "06-Journal", "07-Conversations"
)

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Install-NpmPackage {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $target = Join-Path $projectRoot $RelativePath
    Write-Host "[NEXOGENESIS] npm ci: $RelativePath"
    & npm.cmd ci --prefix $target
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci failed for $RelativePath"
    }
}

function Write-DshConfig {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $content = [System.IO.File]::ReadAllText($Source)
    if (-not $content.Contains("__NEXO_PROJECT_ROOT__")) {
        throw "Portable path placeholder is missing from $Source"
    }
    Write-Utf8NoBom -Path $Destination -Content $content.Replace("__NEXO_PROJECT_ROOT__", $projectRootPosix)
}

$distIndex = Join-Path $projectRoot "web/dist/index.html"
if ($ConfigureOnly -and -not (Test-Path -LiteralPath $distIndex -PathType Leaf)) {
    throw "web/dist is absent. Run prepare-nexogenesis.ps1 without -ConfigureOnly first."
}

# New installations initialize a peer library; old roots are migrated explicitly.
$registryPath = Join-Path $projectRoot '.nexogenesis/instances.json'
$hasRegisteredLibraries = $false
if (Test-Path -LiteralPath $registryPath -PathType Leaf) {
    # Windows PowerShell 5.1 otherwise reads BOM-less UTF-8 as the ANSI code page.
    $registry = Get-Content -LiteralPath $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $hasRegisteredLibraries = @($registry.instances).Count -gt 0
}
# Existing registries own library initialization; do not recreate a removed legacy library.
if (-not $hasRegisteredLibraries) {
    $initialKnowledgeRoot = Join-Path $projectRoot 'knowledge-bases/legacy'
    if (Test-Path -LiteralPath (Join-Path $projectRoot '01-Cards')) { $initialKnowledgeRoot = $projectRoot }
    foreach ($relative in $knowledgeDirectories) {
        New-Item -ItemType Directory -Path (Join-Path $initialKnowledgeRoot $relative) -Force | Out-Null
    }
}

if (-not $ConfigureOnly) {
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        throw "Node.js is required but node.exe was not found in PATH."
    }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw "npm is required but npm.cmd was not found in PATH."
    }

    Install-NpmPackage "packages/nexogenesis-tools"
    Install-NpmPackage "packages/nexogenesis-web-host"
    Install-NpmPackage "web"

    Write-Host "[NEXOGENESIS] Building the Web frontend"
    & npm.cmd run build --prefix (Join-Path $projectRoot "web")
    if ($LASTEXITCODE -ne 0) {
        throw "Web frontend build failed."
    }
}

$presetSource = Join-Path $projectRoot "presets/nexogenesis/agent.cordis.yml"
$presetDestination = Join-Path $dshHome ".agent-presets/nexogenesis/agent.cordis.yml"
$patchSource = Join-Path $projectRoot "patch/cordis.patch.yml"
$patchDestination = Join-Path $dshHome "profiles/nexogenesis/cordis.patch.yml"

Write-Utf8NoBom -Path (Join-Path $dshHome 'profiles/nexogenesis/package.json') -Content ([IO.File]::ReadAllText((Join-Path $projectRoot 'deploy/runtime-profile.json')))
# Local packages are linked only inside this checkout's isolated runtime.
foreach ($package in @('nexogenesis-tools', 'nexogenesis-web-host')) {
    $packageTarget = Join-Path $projectRoot "packages/$package"
    $packageLink = Join-Path $dshHome "profiles/nexogenesis/node_modules/$package"
    New-Item -ItemType Directory -Path (Split-Path -Parent $packageLink) -Force | Out-Null
    if (Test-Path -LiteralPath $packageLink) {
        $existingLink = Get-Item -LiteralPath $packageLink -Force
        if (-not $existingLink.LinkType -or [IO.Path]::GetFullPath([string]$existingLink.Target) -ne [IO.Path]::GetFullPath($packageTarget)) {
            throw "Runtime package path belongs to another target: $packageLink"
        }
    } else {
        New-Item -ItemType Junction -Path $packageLink -Target $packageTarget | Out-Null
    }
}
Write-DshConfig -Source $presetSource -Destination $presetDestination
Write-DshConfig -Source $patchSource -Destination $patchDestination
Write-Utf8NoBom -Path (Join-Path $dshHome '.agent-presets/nexogenesis/preset.yml') -Content ([IO.File]::ReadAllText((Join-Path $projectRoot 'presets/nexogenesis/preset.yml')))
Write-DshConfig -Source (Join-Path $projectRoot 'presets/uno-compile/agent.cordis.yml') -Destination (Join-Path $dshHome '.agent-presets/uno-compile/agent.cordis.yml')
Write-Utf8NoBom -Path (Join-Path $dshHome '.agent-presets/uno-compile/preset.yml') -Content ([IO.File]::ReadAllText((Join-Path $projectRoot 'presets/uno-compile/preset.yml')))

Write-Host "[NEXOGENESIS-UNO] Isolated runtime configured: $dshHome"
if (-not $ConfigureOnly) {
    Write-Host "[NEXOGENESIS] Preparation complete. Run start-nexogenesis.cmd."
}
