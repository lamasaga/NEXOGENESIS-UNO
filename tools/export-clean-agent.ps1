[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [string]$ReleaseName,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$contractPath = Join-Path $projectRoot "deploy/clean-agent-distribution.json"
$contract = [System.IO.File]::ReadAllText($contractPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path (Split-Path -Parent $projectRoot) "NEXOGENESIS-UNO-distributions"
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$outputRoot = (Resolve-Path -LiteralPath $OutputDirectory).Path

$commit = (& git -C $projectRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $commit) { throw "The project Git commit could not be resolved." }
$shortCommit = $commit.Substring(0, 8)
$dirty = [bool]((& git -C $projectRoot status --porcelain).Count)
$dateStamp = Get-Date -Format "yyyyMMdd"
if (-not $ReleaseName) {
    $stateSuffix = if ($dirty) { "-working" } else { "" }
    $ReleaseName = "NEXOGENESIS-UNO-clean-$dateStamp-$shortCommit$stateSuffix"
}
if ($ReleaseName.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0) {
    throw "ReleaseName contains invalid file-name characters."
}

$archivePath = [System.IO.Path]::GetFullPath((Join-Path $outputRoot "$ReleaseName.zip"))
$releaseManifestPath = [System.IO.Path]::GetFullPath((Join-Path $outputRoot "$ReleaseName-release.json"))
foreach ($path in @($archivePath, $releaseManifestPath)) {
    if ((Split-Path -Parent $path) -ne $outputRoot) { throw "ReleaseName must be a file name, not a path." }
    if ((Test-Path -LiteralPath $path) -and -not $Force) {
        throw "Release output already exists: $path. Use -Force to replace this exact release set."
    }
}

$archivePartialPath = "$archivePath.partial"
$releasePartialPath = "$releaseManifestPath.partial"
foreach ($path in @($archivePartialPath, $releasePartialPath)) {
    if ([System.IO.File]::Exists($path)) { [System.IO.File]::Delete($path) }
}

$stagingBase = [System.IO.Path]::GetPathRoot($projectRoot)
$stagingParent = Join-Path $stagingBase (".nexo-clean-export-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$packageRoot = Join-Path $stagingParent ([string]$contract.archive_root)

function Assert-SafeStagingPath {
    $full = [System.IO.Path]::GetFullPath($stagingParent)
    if ((Split-Path -Parent $full) -ne $stagingBase -or -not (Split-Path -Leaf $full).StartsWith(".nexo-clean-export-")) {
        throw "Unsafe staging path: $full"
    }
}

function Convert-ToExtendedPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT -or $full.StartsWith("\\?\")) { return $full }
    if ($full.StartsWith("\\")) { return "\\?\UNC\" + $full.Substring(2) }
    return "\\?\" + $full
}

function Test-ExcludedFile {
    param([Parameter(Mandatory = $true)][System.IO.FileInfo]$File)
    if ($contract.excluded_file_names -contains $File.Name) { return $true }
    foreach ($glob in $contract.excluded_file_globs) {
        if ($File.Name -like [string]$glob) { return $true }
    }
    return $false
}

function Test-ForbiddenPayload {
    param([Parameter(Mandatory = $true)][System.IO.FileInfo]$File)
    foreach ($glob in $contract.forbidden_payload_globs) {
        if ($File.Name -like [string]$glob) { return $true }
    }
    return $false
}

function Get-RelativePathFromBase {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$TargetPath
    )
    $base = [System.IO.Path]::GetFullPath($BasePath).TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
    $target = [System.IO.Path]::GetFullPath($TargetPath)
    if (-not $target.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the expected base: $target"
    }
    return $target.Substring($base.Length)
}

function Copy-OneFile {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$SourcePath
    )
    $destination = Join-Path $packageRoot $RelativePath
    [System.IO.Directory]::CreateDirectory((Convert-ToExtendedPath (Split-Path -Parent $destination))) | Out-Null
    [System.IO.File]::Copy((Convert-ToExtendedPath $SourcePath), (Convert-ToExtendedPath $destination), $true)
}

function Copy-FilteredTree {
    param([Parameter(Mandatory = $true)][string]$RelativeRoot)
    $sourceRoot = Join-Path $projectRoot $RelativeRoot
    if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) { throw "Required runtime tree is missing: $RelativeRoot" }
    foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -File -Recurse -Force) {
        $relativeWithinTree = Get-RelativePathFromBase -BasePath $sourceRoot -TargetPath $file.FullName
        $segments = $relativeWithinTree -split '[\\/]'
        if (@($segments | Where-Object { $contract.excluded_directory_names -contains $_ }).Count -gt 0) { continue }
        if (Test-ExcludedFile $file) { continue }
        if (Test-ForbiddenPayload $file) { throw "Forbidden payload found in runtime tree: $($file.FullName)" }
        Copy-OneFile -RelativePath (Join-Path $RelativeRoot $relativeWithinTree) -SourcePath $file.FullName
    }
}

function Get-RelativePackagePath {
    param([Parameter(Mandatory = $true)][string]$FilePath)
    return (Get-RelativePathFromBase -BasePath $packageRoot -TargetPath $FilePath).Replace("\", "/")
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::Open((Convert-ToExtendedPath $Path), [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try { return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Write-Utf8NoBom {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Assert-CleanBoundary {
    $topLevelAllowed = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $mappedTargets = @($contract.mapped_files | ForEach-Object { [string]$_.target })
    foreach ($relative in @($contract.include_trees) + @($contract.include_files) + $mappedTargets + @($contract.empty_knowledge_directories)) {
        [void]$topLevelAllowed.Add(([string]$relative -split '[\\/]')[0])
    }
    foreach ($item in Get-ChildItem -LiteralPath $packageRoot -Force) {
        if (-not $topLevelAllowed.Contains($item.Name)) { throw "Non-allowlisted top-level entry entered the package: $($item.Name)" }
    }
    foreach ($directory in Get-ChildItem -LiteralPath $packageRoot -Directory -Recurse -Force) {
        if ($contract.excluded_directory_names -contains $directory.Name) { throw "Excluded directory entered the package: $($directory.FullName)" }
    }
    foreach ($file in Get-ChildItem -LiteralPath $packageRoot -File -Recurse -Force) {
        if ((Test-ExcludedFile $file) -or (Test-ForbiddenPayload $file)) { throw "Excluded file entered the package: $($file.FullName)" }
    }
    foreach ($relative in $contract.empty_knowledge_directories) {
        $directory = Join-Path $packageRoot ([string]$relative)
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw "Initialized knowledge directory is missing: $relative" }
        if (@(Get-ChildItem -LiteralPath $directory -Force).Count -ne 0) { throw "Knowledge directory is not empty: $relative" }
    }
}

function Publish-File {
    param([Parameter(Mandatory = $true)][string]$PartialPath, [Parameter(Mandatory = $true)][string]$FinalPath)
    if ([System.IO.File]::Exists($FinalPath)) { [System.IO.File]::Delete($FinalPath) }
    [System.IO.File]::Move($PartialPath, $FinalPath)
}

try {
    Assert-SafeStagingPath
    New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null

    foreach ($relative in $contract.include_trees) { Copy-FilteredTree -RelativeRoot ([string]$relative) }
    foreach ($relative in $contract.include_files) {
        $source = Join-Path $projectRoot ([string]$relative)
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required runtime file is missing: $relative" }
        $file = Get-Item -LiteralPath $source
        if ((Test-ExcludedFile $file) -or (Test-ForbiddenPayload $file)) { throw "Required runtime file conflicts with the clean boundary: $relative" }
        Copy-OneFile -RelativePath ([string]$relative) -SourcePath $source
    }
    foreach ($mapping in $contract.mapped_files) {
        $source = Join-Path $projectRoot ([string]$mapping.source)
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required mapped source is missing: $($mapping.source)" }
        Copy-OneFile -RelativePath ([string]$mapping.target) -SourcePath $source
    }
    foreach ($relative in $contract.empty_knowledge_directories) {
        New-Item -ItemType Directory -Path (Join-Path $packageRoot ([string]$relative)) -Force | Out-Null
    }

    Assert-CleanBoundary
    $contentFiles = @(Get-ChildItem -LiteralPath $packageRoot -File -Recurse -Force | Sort-Object FullName)
    $checksumLines = foreach ($file in $contentFiles) { "$(Get-FileSha256 $file.FullName)  $(Get-RelativePackagePath $file.FullName)" }
    $checksumPath = Join-Path $packageRoot "DISTRIBUTION-CONTENTS.sha256"
    Write-Utf8NoBom -Path $checksumPath -Content (($checksumLines -join "`n") + "`n")

    $manifest = [ordered]@{
        schema_version = 1
        release_name = $ReleaseName
        created_at = (Get-Date).ToUniversalTime().ToString("o")
        source_commit = $commit
        source_worktree_dirty = $dirty
        package_kind = "clean-initialized-agent"
        archive_root = [string]$contract.archive_root
        content_files = $contentFiles.Count
        empty_knowledge_directories = @($contract.empty_knowledge_directories)
        contains_instance_knowledge = $false
        contains_runtime_state = $false
        contains_dependencies = $false
        contains_build_output = $false
        preparation_command = "powershell -ExecutionPolicy Bypass -File .\prepare-nexogenesis.ps1"
    }
    Write-Utf8NoBom -Path (Join-Path $packageRoot "DISTRIBUTION-MANIFEST.json") -Content ($manifest | ConvertTo-Json -Depth 6)

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::Open($archivePartialPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $zip.CreateEntry("$($contract.archive_root)/") | Out-Null
        foreach ($relative in $contract.empty_knowledge_directories) { $zip.CreateEntry("$($contract.archive_root)/$relative/") | Out-Null }
        foreach ($file in Get-ChildItem -LiteralPath $packageRoot -File -Recurse -Force) {
            $relative = Get-RelativePackagePath $file.FullName
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, "$($contract.archive_root)/$relative", [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    }
    finally { $zip.Dispose() }

    $archiveInfo = Get-Item -LiteralPath $archivePartialPath
    $archiveHash = Get-FileSha256 $archivePartialPath
    $releaseManifest = [ordered]@{
        schema_version = 1
        release_name = $ReleaseName
        created_at = (Get-Date).ToUniversalTime().ToString("o")
        source_commit = $commit
        source_worktree_dirty = $dirty
        package_kind = "clean-initialized-agent"
        archive_root = [string]$contract.archive_root
        archive = [ordered]@{ file = [System.IO.Path]::GetFileName($archivePath); bytes = $archiveInfo.Length; sha256 = $archiveHash }
        restore = "Extract the ZIP, run prepare-nexogenesis.ps1, then run start-nexogenesis.cmd."
    }
    Write-Utf8NoBom -Path $releasePartialPath -Content ($releaseManifest | ConvertTo-Json -Depth 5)
    Publish-File -PartialPath $archivePartialPath -FinalPath $archivePath
    Publish-File -PartialPath $releasePartialPath -FinalPath $releaseManifestPath

    Write-Host "[NEXOGENESIS] Clean initialized Agent release created"
    Write-Host "  Archive: $archivePath"
    Write-Host "  Bytes: $($archiveInfo.Length)"
    Write-Host "  SHA256: $archiveHash"
    Write-Host "  Release manifest: $releaseManifestPath"
    Write-Host "  Source worktree dirty: $dirty"
}
finally {
    foreach ($path in @($archivePartialPath, $releasePartialPath)) {
        if ([System.IO.File]::Exists($path)) { [System.IO.File]::Delete($path) }
    }
    if (Test-Path -LiteralPath $stagingParent) {
        Assert-SafeStagingPath
        [System.IO.Directory]::Delete((Convert-ToExtendedPath $stagingParent), $true)
    }
}
