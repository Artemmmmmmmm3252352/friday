$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot
$releaseRoot = Join-Path $projectRoot 'release'
$unpackedRoot = Join-Path $releaseRoot 'win-unpacked'
$zipPath = Join-Path $releaseRoot 'Friday Portable 0.0.0.zip'
$launcherPath = Join-Path $unpackedRoot 'Start Friday.cmd'

if (-not (Test-Path -LiteralPath $unpackedRoot)) {
  throw "win-unpacked release was not found: $unpackedRoot"
}

if (-not (Test-Path -LiteralPath (Join-Path $unpackedRoot 'Friday.exe'))) {
  throw 'Friday.exe was not found in win-unpacked release.'
}

Set-Content -LiteralPath $launcherPath -Encoding ASCII -Value @'
@echo off
cd /d "%~dp0"
start "" "%~dp0Friday.exe"
'@

if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

$sevenZip = Get-Command 7z -ErrorAction SilentlyContinue
if ($sevenZip) {
  & $sevenZip.Source a -tzip -mx=3 $zipPath (Join-Path $unpackedRoot '*') | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "7-Zip failed with exit code $LASTEXITCODE"
  }
} else {
  Push-Location $unpackedRoot
  try {
    & tar.exe -a -cf $zipPath *
    if ($LASTEXITCODE -ne 0) {
      throw "tar.exe failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

Write-Host "Portable release created: $zipPath"
