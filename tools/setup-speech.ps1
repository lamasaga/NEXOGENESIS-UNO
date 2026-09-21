[CmdletBinding()]
param(
    [string]$Python = 'python',
    [string]$ModelPath
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$speechRoot = Join-Path $projectRoot '.nexogenesis/speech'
New-Item -ItemType Directory -Path $speechRoot -Force | Out-Null
$venvPath = Join-Path $speechRoot 'venv'
if (-not (Test-Path -LiteralPath (Join-Path $venvPath 'Scripts/python.exe'))) {
    & $Python -m venv $venvPath
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create isolated speech environment. Use -Python with a Python 3.10-3.12 executable.' }
}
$speechPython = Join-Path $venvPath 'Scripts/python.exe'
& $speechPython -m pip install --disable-pip-version-check --only-binary=:all: -r (Join-Path $PSScriptRoot 'speech/requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Speech dependency installation failed; configuration was not changed.' }

$revision = '536b0662742c02347bc0e980a01041f333bce120'
if (-not $ModelPath) {
    $cachePath = Join-Path $env:USERPROFILE ".cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots/$revision"
    if (Test-Path -LiteralPath (Join-Path $cachePath 'model.bin')) { $ModelPath = $cachePath }
}
if (-not $ModelPath) {
    $ModelPath = Join-Path $speechRoot 'model'
    Write-Host 'Downloading the pinned Whisper small model (about 484 MB), once. Recordings are never uploaded.'
    & $speechPython (Join-Path $PSScriptRoot 'speech/download_model.py') $ModelPath
    if ($LASTEXITCODE -ne 0) { throw 'Model download failed; rerun to resume. Configuration was not changed.' }
}
$ModelPath = (Resolve-Path -LiteralPath $ModelPath).Path
foreach ($file in @('model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ModelPath $file) -PathType Leaf)) { throw "Missing model file: $file" }
}
# Test actual offline model load, not merely the presence of files.
& $speechPython -u (Join-Path $PSScriptRoot 'speech/worker.py') --model $ModelPath --check
if ($LASTEXITCODE -ne 0) { throw 'The speech worker could not load. Configuration was not changed.' }
$configPath = Join-Path $speechRoot 'config.json'
$config = @{ pythonPath = $speechPython; modelPath = $ModelPath } | ConvertTo-Json
[IO.File]::WriteAllText("$configPath.tmp", $config, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath "$configPath.tmp" -Destination $configPath -Force
Write-Host 'UNO local dictation is ready. Refresh the page; no API key is needed.'
