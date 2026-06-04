$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot
$releaseRoot = Join-Path $projectRoot 'release'
$installerPath = Join-Path $releaseRoot 'Friday Setup 0.0.0.exe'
$certificatePath = Join-Path $releaseRoot 'Friday-CodeSigning.cer'

if (-not (Test-Path -LiteralPath $installerPath)) {
  throw "Installer was not found: $installerPath"
}

if (-not (Test-Path -LiteralPath $certificatePath)) {
  throw "Code signing certificate was not found: $certificatePath"
}

Write-Host 'Importing Friday code-signing certificate for the current Windows user...'
Import-Certificate -FilePath $certificatePath -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
Import-Certificate -FilePath $certificatePath -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null

$signature = Get-AuthenticodeSignature -FilePath $installerPath
if ($signature.Status -ne 'Valid') {
  throw "Installer signature is not trusted in this user profile: $($signature.Status) $($signature.StatusMessage)"
}

Write-Host 'Signature is trusted. Starting Friday installer...'
Start-Process -FilePath $installerPath
