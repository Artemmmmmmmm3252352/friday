param(
  [string]$Subject = "CN=X-VEXTA Friday Code Signing"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ReleaseDir = Join-Path $ProjectRoot "release"
$CertPath = Join-Path $ReleaseDir "Friday-CodeSigning.cer"

$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Where-Object { $_.Subject -eq $Subject -and $_.NotAfter -gt (Get-Date).AddMonths(1) } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1

if (-not $cert) {
  $cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Subject `
    -CertStoreLocation Cert:\CurrentUser\My `
    -KeyUsage DigitalSignature `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddYears(3)
}

Export-Certificate -Cert $cert -FilePath $CertPath -Force | Out-Null

# Trust locally so verification is Valid on the build machine. Target machines with WDAC/SAC
# need either this cert trusted there too, or a real OV/EV code-signing certificate.
Import-Certificate -FilePath $CertPath -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
Import-Certificate -FilePath $CertPath -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null

$targets = @(
  (Join-Path $ReleaseDir "Friday Setup 0.0.0.exe"),
  (Join-Path $ReleaseDir "win-unpacked\Friday.exe")
)

foreach ($target in $targets) {
  if (!(Test-Path -LiteralPath $target)) {
    throw "Missing release target: $target"
  }

  $signature = Set-AuthenticodeSignature -FilePath $target -Certificate $cert -HashAlgorithm SHA256
  if ($signature.Status -ne "Valid") {
    throw "Signature is not valid for $target`: $($signature.Status) $($signature.StatusMessage)"
  }
}

Write-Output "Signed Friday release artifacts with $($cert.Thumbprint)"
Write-Output "Exported certificate: $CertPath"
