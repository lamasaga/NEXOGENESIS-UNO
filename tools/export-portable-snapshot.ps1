[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [string]$ReleaseName,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$contractPath = Join-Path $projectRoot "deploy/portable-snapshot.json"
$contract = Get-Content -LiteralPath $contractPath -Raw -Encoding UTF8 | ConvertFrom-Json

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path (Split-Path -Parent $projectRoot) "NEXOGENESIS-UNO-distributions"
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$outputRoot = (Resolve-Path -LiteralPath $OutputDirectory).Path

$commit = (& git -C $projectRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $commit) {
    throw "The project Git commit could not be resolved."
}
$shortCommit = $commit.Substring(0, 8)
$dirty = [bool]((& git -C $projectRoot status --porcelain).Count)
$dateStamp = Get-Date -Format "yyyyMMdd"
if (-not $ReleaseName) {
    $stateSuffix = if ($dirty) { "-working" } else { "" }
    $ReleaseName = "NEXOGENESIS-UNO-portable-$dateStamp-$shortCommit$stateSuffix"
}
if ($ReleaseName.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0) {
    throw "ReleaseName contains invalid file-name characters."
}

$coreArchivePath = [System.IO.Path]::GetFullPath((Join-Path $outputRoot "$ReleaseName-core.zip"))
$materialsArchivePath = [System.IO.Path]::GetFullPath((Join-Path $outputRoot "$ReleaseName-materials.zip"))
$releaseManifestPath = [System.IO.Path]::GetFullPath((Join-Path $outputRoot "$ReleaseName-release.json"))
$finalPaths = @($coreArchivePath, $materialsArchivePath, $releaseManifestPath)
foreach ($path in $finalPaths) {
    if ((Split-Path -Parent $path) -ne $outputRoot) {
        throw "ReleaseName must be a file name, not a path."
    }
    if ((Test-Path -LiteralPath $path) -and -not $Force) {
        throw "Release output already exists: $path. Use -Force to replace this exact release set."
    }
}

$corePartialPath = "$coreArchivePath.partial"
$materialsPartialPath = "$materialsArchivePath.partial"
$releasePartialPath = "$releaseManifestPath.partial"
foreach ($path in @($corePartialPath, $materialsPartialPath, $releasePartialPath)) {
    if ([System.IO.File]::Exists($path)) { [System.IO.File]::Delete($path) }
}

$stagingBase = [System.IO.Path]::GetPathRoot($projectRoot)
$stagingParent = Join-Path $stagingBase (".nexo-export-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$coreRoot = Join-Path $stagingParent "c"
$materialsRoot = Join-Path $stagingParent "m"
$packageFolderName = "NEXOGENESIS-UNO"

function Assert-SafeStagingPath {
    $full = [System.IO.Path]::GetFullPath($stagingParent)
    $parent = Split-Path -Parent $full
    $leaf = Split-Path -Leaf $full
    if ($parent -ne $stagingBase -or -not $leaf.StartsWith(".nexo-export-")) {
        throw "Unsafe staging path: $full"
    }
}

function Convert-ToExtendedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $full = [System.IO.Path]::GetFullPath($Path)
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { return $full }
    if ($full.StartsWith("\\?\")) { return $full }
    if ($full.StartsWith("\\")) { return "\\?\UNC\" + $full.Substring(2) }
    return "\\?\" + $full
}

function Test-ExcludedFile {
    param([Parameter(Mandatory = $true)][System.IO.FileInfo]$File)

    if ($contract.excluded_file_names -contains $File.Name) { return $true }
    foreach ($suffix in $contract.excluded_file_suffixes) {
        if ($File.Name.EndsWith([string]$suffix, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Copy-FilteredTree {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $queue = [System.Collections.Generic.Queue[object]]::new()
    $queue.Enqueue([pscustomobject]@{ Source = $Source; Destination = $Destination })

    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        foreach ($item in Get-ChildItem -LiteralPath $current.Source -Force) {
            if ($item.PSIsContainer) {
                if ($contract.excluded_directory_names -contains $item.Name) { continue }
                if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                    throw "Reparse points are not allowed in a portable snapshot: $($item.FullName)"
                }
                $childDestination = Join-Path $current.Destination $item.Name
                New-Item -ItemType Directory -Path $childDestination -Force | Out-Null
                $queue.Enqueue([pscustomobject]@{ Source = $item.FullName; Destination = $childDestination })
                continue
            }
            if (Test-ExcludedFile $item) { continue }
            $target = Join-Path $current.Destination $item.Name
            $sourcePath = Convert-ToExtendedPath $item.FullName
            $targetPath = Convert-ToExtendedPath $target
            [System.IO.File]::Copy($sourcePath, $targetPath, $true)
            [System.IO.File]::SetLastWriteTimeUtc($targetPath, $item.LastWriteTimeUtc)
        }
    }
}

function Get-TreeStat {
    param([Parameter(Mandatory = $true)][string]$Path)

    $count = 0
    [long]$total = 0
    foreach ($pathValue in [System.IO.Directory]::EnumerateFiles((Convert-ToExtendedPath $Path), "*", [System.IO.SearchOption]::AllDirectories)) {
        $file = [System.IO.FileInfo]::new($pathValue)
        if (Test-ExcludedFile $file) { continue }
        $count += 1
        $total += $file.Length
    }
    return [pscustomobject]@{ files = $count; bytes = $total }
}

function Get-RelativeSnapshotPath {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$FilePath
    )

    $base = (Convert-ToExtendedPath $BasePath).TrimEnd("\") + "\"
    $file = Convert-ToExtendedPath $FilePath
    if (-not $file.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "File is outside the snapshot root: $file"
    }
    return $file.Substring($base.Length).Replace("\", "/")
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::Open(
        (Convert-ToExtendedPath $Path),
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Assert-PackageBoundary {
    param([Parameter(Mandatory = $true)][string]$PackageRoot)

    foreach ($directoryPath in [System.IO.Directory]::EnumerateDirectories((Convert-ToExtendedPath $PackageRoot), "*", [System.IO.SearchOption]::AllDirectories)) {
        $directory = [System.IO.DirectoryInfo]::new($directoryPath)
        if ($contract.excluded_directory_names -contains $directory.Name) {
            throw "Excluded directory entered the snapshot: $directoryPath"
        }
    }
    foreach ($filePath in [System.IO.Directory]::EnumerateFiles((Convert-ToExtendedPath $PackageRoot), "*", [System.IO.SearchOption]::AllDirectories)) {
        if (Test-ExcludedFile ([System.IO.FileInfo]::new($filePath))) {
            throw "Excluded file entered the snapshot: $filePath"
        }
    }
}

function Write-PackageMetadata {
    param(
        [Parameter(Mandatory = $true)][string]$PackageRoot,
        [Parameter(Mandatory = $true)][string]$PackageKind,
        [Parameter(Mandatory = $true)][string]$ManifestName,
        [Parameter(Mandatory = $true)][string]$ChecksumName,
        [Parameter(Mandatory = $true)][object]$RootStats,
        [Parameter(Mandatory = $true)][object]$ExtraManifest
    )

    $contentFiles = @([System.IO.Directory]::EnumerateFiles((Convert-ToExtendedPath $PackageRoot), "*", [System.IO.SearchOption]::AllDirectories) | Sort-Object)
    $checksumLines = foreach ($filePath in $contentFiles) {
        $relative = Get-RelativeSnapshotPath -BasePath $PackageRoot -FilePath $filePath
        $hash = Get-FileSha256 $filePath
        "$hash  $relative"
    }
    Write-Utf8NoBom -Path (Join-Path $PackageRoot $ChecksumName) -Content (($checksumLines -join "`n") + "`n")

    $manifest = [ordered]@{
        schema_version = 2
        release_name = $ReleaseName
        created_at = (Get-Date).ToUniversalTime().ToString("o")
        source_commit = $commit
        source_worktree_dirty = $dirty
        package_kind = $PackageKind
        archive_root = $packageFolderName
        roots = $RootStats
    }
    foreach ($property in $ExtraManifest.PSObject.Properties) {
        $manifest[$property.Name] = $property.Value
    }
    Write-Utf8NoBom -Path (Join-Path $PackageRoot $ManifestName) -Content ($manifest | ConvertTo-Json -Depth 8)
}

function New-PackageZip {
    param(
        [Parameter(Mandatory = $true)][string]$PackageRoot,
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][object[]]$EmptyRoots
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zipWriter = [System.IO.Compression.ZipFile]::Open($ArchivePath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $zipWriter.CreateEntry("$packageFolderName/") | Out-Null
        foreach ($rootName in $EmptyRoots) {
            $zipWriter.CreateEntry("$packageFolderName/$rootName/") | Out-Null
        }
        foreach ($filePath in [System.IO.Directory]::EnumerateFiles((Convert-ToExtendedPath $PackageRoot), "*", [System.IO.SearchOption]::AllDirectories)) {
            $relative = Get-RelativeSnapshotPath -BasePath $PackageRoot -FilePath $filePath
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zipWriter,
                $filePath,
                "$packageFolderName/$relative",
                [System.IO.Compression.CompressionLevel]::Fastest
            ) | Out-Null
        }
    }
    finally {
        $zipWriter.Dispose()
    }
}

function Publish-File {
    param(
        [Parameter(Mandatory = $true)][string]$PartialPath,
        [Parameter(Mandatory = $true)][string]$FinalPath
    )

    if ([System.IO.File]::Exists($FinalPath)) { [System.IO.File]::Delete($FinalPath) }
    [System.IO.File]::Move($PartialPath, $FinalPath)
}

try {
    Assert-SafeStagingPath
    New-Item -ItemType Directory -Path $coreRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $materialsRoot -Force | Out-Null

    foreach ($file in $contract.root_files) {
        $source = Join-Path $projectRoot ([string]$file)
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Required program file is missing: $file"
        }
        [System.IO.File]::Copy((Convert-ToExtendedPath $source), (Convert-ToExtendedPath (Join-Path $coreRoot ([string]$file))), $true)
    }
    foreach ($rootName in $contract.program_roots) {
        $source = Join-Path $projectRoot ([string]$rootName)
        if (-not (Test-Path -LiteralPath $source -PathType Container)) {
            throw "Required program root is missing: $rootName"
        }
        Copy-FilteredTree -Source $source -Destination (Join-Path $coreRoot ([string]$rootName))
    }

    $coreStats = [ordered]@{}
    foreach ($rootName in $contract.knowledge_roots) {
        New-Item -ItemType Directory -Path (Join-Path $coreRoot ([string]$rootName)) -Force | Out-Null
    }
    foreach ($rootName in $contract.core_knowledge_roots) {
        $source = Join-Path $projectRoot ([string]$rootName)
        $destination = Join-Path $coreRoot ([string]$rootName)
        Write-Host "[NEXOGENESIS] Copying core knowledge root: $rootName"
        Copy-FilteredTree -Source $source -Destination $destination
        $sourceStat = Get-TreeStat $source
        $destinationStat = Get-TreeStat $destination
        if ($sourceStat.files -ne $destinationStat.files -or $sourceStat.bytes -ne $destinationStat.bytes) {
            throw "Core knowledge copy verification failed for $rootName"
        }
        $coreStats[[string]$rootName] = $destinationStat
    }

    $materialStats = [ordered]@{}
    foreach ($rootName in $contract.raw_material_roots) {
        $source = Join-Path $projectRoot ([string]$rootName)
        $destination = Join-Path $materialsRoot ([string]$rootName)
        Write-Host "[NEXOGENESIS] Copying raw material root: $rootName"
        Copy-FilteredTree -Source $source -Destination $destination
        $sourceStat = Get-TreeStat $source
        $destinationStat = Get-TreeStat $destination
        if ($sourceStat.files -ne $destinationStat.files -or $sourceStat.bytes -ne $destinationStat.bytes) {
            throw "Raw material copy verification failed for $rootName"
        }
        $materialStats[[string]$rootName] = $destinationStat
    }

    Assert-PackageBoundary $coreRoot
    Assert-PackageBoundary $materialsRoot

    Write-PackageMetadata -PackageRoot $coreRoot -PackageKind "agent-and-derived-knowledge" -ManifestName "DISTRIBUTION-CORE-MANIFEST.json" -ChecksumName "DISTRIBUTION-CORE-CONTENTS.sha256" -RootStats $coreStats -ExtraManifest ([pscustomobject]@{
        dependency_policy = "lockfiles retained; node_modules and generated web/dist excluded"
        raw_materials = "distributed separately; 00-Inbox and 03-Archive remain empty until overlaid"
        preparation_command = "powershell -ExecutionPolicy Bypass -File .\\prepare-nexogenesis.ps1"
    })
    Write-PackageMetadata -PackageRoot $materialsRoot -PackageKind "raw-materials" -ManifestName "DISTRIBUTION-MATERIALS-MANIFEST.json" -ChecksumName "DISTRIBUTION-MATERIALS-CONTENTS.sha256" -RootStats $materialStats -ExtraManifest ([pscustomobject]@{
        overlay_target = $packageFolderName
        restore_order = "extract the core ZIP and the materials ZIP into the same parent directory"
    })

    New-PackageZip -PackageRoot $coreRoot -ArchivePath $corePartialPath -EmptyRoots @($contract.knowledge_roots)
    New-PackageZip -PackageRoot $materialsRoot -ArchivePath $materialsPartialPath -EmptyRoots @($contract.raw_material_roots)

    $coreInfo = Get-Item -LiteralPath $corePartialPath
    $materialsInfo = Get-Item -LiteralPath $materialsPartialPath
    $coreHash = Get-FileSha256 $corePartialPath
    $materialsHash = Get-FileSha256 $materialsPartialPath
    $releaseManifest = [ordered]@{
        schema_version = 1
        release_name = $ReleaseName
        created_at = (Get-Date).ToUniversalTime().ToString("o")
        source_commit = $commit
        source_worktree_dirty = $dirty
        archive_root = $packageFolderName
        core = [ordered]@{
            file = [System.IO.Path]::GetFileName($coreArchivePath)
            bytes = $coreInfo.Length
            sha256 = $coreHash
        }
        materials = [ordered]@{
            file = [System.IO.Path]::GetFileName($materialsArchivePath)
            bytes = $materialsInfo.Length
            sha256 = $materialsHash
        }
        restore = "Extract both ZIP files into the same parent directory; then run prepare-nexogenesis.ps1 from NEXOGENESIS-UNO."
    }
    Write-Utf8NoBom -Path $releasePartialPath -Content ($releaseManifest | ConvertTo-Json -Depth 6)

    Publish-File -PartialPath $corePartialPath -FinalPath $coreArchivePath
    Publish-File -PartialPath $materialsPartialPath -FinalPath $materialsArchivePath
    Publish-File -PartialPath $releasePartialPath -FinalPath $releaseManifestPath

    Write-Host "[NEXOGENESIS] Split portable release created"
    Write-Host "  Core: $coreArchivePath"
    Write-Host "  Core bytes: $($coreInfo.Length)"
    Write-Host "  Core SHA256: $coreHash"
    Write-Host "  Materials: $materialsArchivePath"
    Write-Host "  Materials bytes: $($materialsInfo.Length)"
    Write-Host "  Materials SHA256: $materialsHash"
    Write-Host "  Release manifest: $releaseManifestPath"
    Write-Host "  Source worktree dirty: $dirty"
}
finally {
    foreach ($path in @($corePartialPath, $materialsPartialPath, $releasePartialPath)) {
        if ([System.IO.File]::Exists($path)) { [System.IO.File]::Delete($path) }
    }
    if (Test-Path -LiteralPath $stagingParent) {
        Assert-SafeStagingPath
        [System.IO.Directory]::Delete((Convert-ToExtendedPath $stagingParent), $true)
    }
}
