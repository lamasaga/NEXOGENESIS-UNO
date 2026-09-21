[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference='Stop'
$appRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$registryPath=Join-Path $appRoot '.nexogenesis/instances.json'
$registry=Get-Content -LiteralPath $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json
$plan=@()
foreach($library in $registry.instances){
  $source=[IO.Path]::GetFullPath($library.root)
  $target=[IO.Path]::GetFullPath((Join-Path $appRoot "knowledge-bases/$($library.id)"))
  if(!$target.StartsWith($appRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Target outside application'}
  if($source -eq $target){continue}
  if($source -ne $appRoot -and !$source.StartsWith((Join-Path $appRoot 'instances')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'External library requires separate migration'}
  if(Test-Path -LiteralPath $target){throw "Target already exists: $target"}
  $plan+=@{id=$library.id;name=$library.name;source=$source;target=$target}
}
if(!$Apply){$plan|ConvertTo-Json;return}
if(!$plan.Count){Write-Output 'Libraries already migrated';return}
$listeners=Get-NetTCPConnection -LocalPort 3093 -State Listen -ErrorAction SilentlyContinue
if($listeners){throw 'Stop the UNO local service before applying migration'}
$backup=Join-Path $appRoot ('.nexogenesis/migration-backups/'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
Copy-Item -LiteralPath $registryPath -Destination (Join-Path $backup 'instances.json')
$moves=@()
foreach($entry in $plan){
  New-Item -ItemType Directory -Path $entry.target -Force | Out-Null
  if($entry.source -eq $appRoot){
    $parts=@('00-Inbox','01-Cards','02-Profile','03-Archive','04-OutBox','05-Buffer','06-Journal','07-Conversations','.nexogenesis/uno-jobs','.nexogenesis/uno-receipts','.nexogenesis/uno-transactions','.nexogenesis/uno-sparse-index.json','.nexogenesis/knowledge-processing.json','.nexogenesis/codex-compile-20260913')
  }else{$parts=@(Get-ChildItem -LiteralPath $entry.source -Force | ForEach-Object {$_.Name})}
  foreach($part in $parts){
    $from=[IO.Path]::GetFullPath((Join-Path $entry.source $part));if(!(Test-Path -LiteralPath $from)){continue}
    $to=[IO.Path]::GetFullPath((Join-Path $entry.target $part));$copy=Join-Path $backup ($entry.id+'/'+$part)
    if(!$from.StartsWith($entry.source+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or !$to.StartsWith($entry.target+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe migration path'}
    New-Item -ItemType Directory -Path (Split-Path $copy -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $from -Destination $copy -Recurse
    $files=if((Get-Item -LiteralPath $from).PSIsContainer){@(Get-ChildItem -LiteralPath $from -File -Recurse -Force)}else{@(Get-Item -LiteralPath $from)}
    foreach($file in $files){$suffix=$file.FullName.Substring($from.Length);$duplicate=$copy+$suffix;if((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $duplicate).Hash){throw "Backup mismatch: $($file.FullName)"}}
    New-Item -ItemType Directory -Path (Split-Path $to -Parent) -Force | Out-Null
    Move-Item -LiteralPath $from -Destination $to
    $moves+=@{from=$from;to=$to;backup=$copy;files=$files.Count}
    $moves | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $backup 'moves.json') -Encoding utf8
  }
  $record=$registry.instances|Where-Object {$_.id -eq $entry.id};$record.root=$entry.target
  if($entry.id -eq 'legacy'){[IO.File]::WriteAllText((Join-Path $entry.target 'nexogenesis.instance.yml'),"schema_version: 1`nid: legacy`nname: 主知识库`n");$record.PSObject.Properties.Remove('legacy')}
}
$registry|ConvertTo-Json -Depth 8|Set-Content -LiteralPath ($registryPath+'.tmp') -Encoding utf8
Move-Item -LiteralPath ($registryPath+'.tmp') -Destination $registryPath -Force
Write-Output "Migration complete. Verified backup and reversible move manifest: $backup"
