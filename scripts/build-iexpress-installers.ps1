param(
  [string]$ProjectRoot = "E:\project\friday",
  [string]$OutputDir = "E:\project\friday\release\новая для пользователей\123"
)

$ErrorActionPreference = "Stop"

function New-CleanDirectory {
  param([string]$Path)

  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }

  New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Get-IExpressPath {
  $iexpress = Join-Path $env:WINDIR "System32\iexpress.exe"
  if (!(Test-Path -LiteralPath $iexpress)) {
    throw "iexpress.exe not found."
  }

  return $iexpress
}

function Wait-ForFile {
  param(
    [string]$Path,
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $Path) {
      return $true
    }

    Start-Sleep -Milliseconds 500
  }

  return (Test-Path -LiteralPath $Path)
}

function New-IExpressSedContent {
  param(
    [string]$TargetExe,
    [string]$FriendlyName,
    [string]$SourceDir,
    [string[]]$Files,
    [string]$AppLaunched,
    [string]$FinishMessage
  )

  $strings = @()
  $sourceLines = @()

  for ($index = 0; $index -lt $Files.Count; $index += 1) {
    $key = "FILE$index"
    $strings += "$key=`"$($Files[$index])`""
    $sourceLines += "%$key%="
  }

  $sourceDirNormalized = $SourceDir.TrimEnd('\')

  @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=$FinishMessage
TargetName=$TargetExe
FriendlyName=$FriendlyName
AppLaunched=$AppLaunched
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
$($strings -join "`r`n")
[SourceFiles]
SourceFiles0=$sourceDirNormalized
[SourceFiles0]
$($sourceLines -join "`r`n")
"@
}

function New-FridayInstallCmd {
  @'
@echo off
setlocal
set "TARGET=%LOCALAPPDATA%\Programs\Friday"
set "STAGING=%TEMP%\FridayInstaller-%RANDOM%%RANDOM%"
if exist "%TARGET%" rmdir /s /q "%TARGET%"
mkdir "%TARGET%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$staging = $env:STAGING; $target = $env:TARGET; Expand-Archive -LiteralPath '%~dp0payload.zip' -DestinationPath $staging -Force; $source = if (Test-Path (Join-Path $staging 'win-unpacked')) { Join-Path $staging 'win-unpacked' } else { $staging }; Get-ChildItem -LiteralPath $source -Force | Move-Item -Destination $target -Force; Remove-Item -LiteralPath $staging -Recurse -Force"
if errorlevel 1 exit /b 1

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$shell = New-Object -ComObject WScript.Shell; " ^
  "$desktop = [Environment]::GetFolderPath('Desktop'); " ^
  "$programs = [Environment]::GetFolderPath('Programs'); " ^
  "$menuDir = Join-Path $programs 'Friday'; " ^
  "if (!(Test-Path $menuDir)) { New-Item -ItemType Directory -Path $menuDir | Out-Null }; " ^
  "$target = Join-Path '%TARGET%' 'Friday.exe'; " ^
  "$desktopShortcut = $shell.CreateShortcut((Join-Path $desktop 'Friday.lnk')); " ^
  "$desktopShortcut.TargetPath = $target; " ^
  "$desktopShortcut.WorkingDirectory = '%TARGET%'; " ^
  "$desktopShortcut.Save(); " ^
  "$menuShortcut = $shell.CreateShortcut((Join-Path $menuDir 'Friday.lnk')); " ^
  "$menuShortcut.TargetPath = $target; " ^
  "$menuShortcut.WorkingDirectory = '%TARGET%'; " ^
  "$menuShortcut.Save()"
if errorlevel 1 exit /b 1

start "" "%TARGET%\Friday.exe"
exit /b 0
'@
}

function New-ProfileInstallCmd {
  @'
@echo off
setlocal
set "TARGET=%USERPROFILE%\.openclaw"
set "STAGING=%TEMP%\OpenClawProfileInstaller-%RANDOM%%RANDOM%"
if not exist "%TARGET%" mkdir "%TARGET%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$staging = $env:STAGING; $target = $env:TARGET; Expand-Archive -LiteralPath '%~dp0payload.zip' -DestinationPath $staging -Force; $source = if (Test-Path (Join-Path $staging '.openclaw')) { Join-Path $staging '.openclaw' } else { $staging }; Get-ChildItem -LiteralPath $source -Force | Move-Item -Destination $target -Force; Remove-Item -LiteralPath $staging -Recurse -Force"
exit /b %ERRORLEVEL%
'@
}

function Invoke-IExpressBuild {
  param(
    [string]$IExpressPath,
    [string]$SedPath,
    [string]$OutputExe
  )

  $knownIds = @(
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ProcessName -in @('iexpress', 'makecab') } |
      Select-Object -ExpandProperty Id
  )

  & $IExpressPath /N /Q /M $SedPath

  $deadline = (Get-Date).AddMinutes(15)
  do {
    $activeBuildProcesses = @(
      Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -in @('iexpress', 'makecab') -and $_.Id -notin $knownIds }
    )

    if ($activeBuildProcesses.Count -gt 0) {
      Start-Sleep -Seconds 5
    }
  } while ($activeBuildProcesses.Count -gt 0 -and (Get-Date) -lt $deadline)

  $outputDir = Split-Path -Parent $OutputExe
  $baseName = [System.IO.Path]::GetFileNameWithoutExtension($OutputExe)
  $ddfPath = Join-Path $outputDir ("~{0}.DDF" -f $baseName)
  $cabPath = Join-Path $outputDir ("~{0}.CAB" -f $baseName)

  if (Wait-ForFile -Path $OutputExe -TimeoutSeconds 5) {
    return
  }

  if (!(Wait-ForFile -Path $ddfPath -TimeoutSeconds 20)) {
    throw "IExpress did not produce a DDF file: $ddfPath"
  }

  if (!(Test-Path -LiteralPath $cabPath)) {
    makecab /F $ddfPath | Out-Null
  }

  if (!(Wait-ForFile -Path $OutputExe -TimeoutSeconds 20)) {
    throw "IExpress did not produce installer: $OutputExe"
  }
}

$releaseDir = Join-Path $ProjectRoot "release"
$sessionStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$tmpRoot = Join-Path $ProjectRoot ("tmp\iexpress\" + $sessionStamp)
$stagingRoot = Join-Path $tmpRoot "staging"
$buildRoot = Join-Path $tmpRoot "build"
$outputRoot = Join-Path $tmpRoot "output"
$targetDir = $OutputDir

New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
New-CleanDirectory -Path $stagingRoot
New-CleanDirectory -Path $buildRoot
New-CleanDirectory -Path $outputRoot

$iexpress = Get-IExpressPath

$fridaySource = Join-Path $releaseDir "win-unpacked"
$profileSource = Join-Path $releaseDir ".openclaw"

if (!(Test-Path -LiteralPath $fridaySource)) {
  throw "Friday payload folder not found: $fridaySource"
}

if (!(Test-Path -LiteralPath $profileSource)) {
  throw "OpenClaw profile folder not found: $profileSource"
}

$fridayStage = Join-Path $stagingRoot "friday"
$profileStage = Join-Path $stagingRoot "profile"
New-CleanDirectory -Path $fridayStage
New-CleanDirectory -Path $profileStage

$fridayZip = Join-Path $fridayStage "payload.zip"
$profileZip = Join-Path $profileStage "payload.zip"
Compress-Archive -LiteralPath $fridaySource -DestinationPath $fridayZip -CompressionLevel Optimal
Compress-Archive -LiteralPath $profileSource -DestinationPath $profileZip -CompressionLevel Optimal

$fridayInstallCmdPath = Join-Path $fridayStage "install.cmd"
$profileInstallCmdPath = Join-Path $profileStage "install.cmd"
Set-Content -LiteralPath $fridayInstallCmdPath -Value (New-FridayInstallCmd) -Encoding ASCII
Set-Content -LiteralPath $profileInstallCmdPath -Value (New-ProfileInstallCmd) -Encoding ASCII

$fridayOutput = Join-Path $outputRoot "Friday Setup IExpress.exe"
$profileOutput = Join-Path $outputRoot "OpenClaw Profile Setup IExpress.exe"
$fridaySed = Join-Path $buildRoot "friday-iexpress.sed"
$profileSed = Join-Path $buildRoot "profile-iexpress.sed"

$fridaySedContent = New-IExpressSedContent `
  -TargetExe $fridayOutput `
  -FriendlyName "Friday Setup" `
  -SourceDir $fridayStage `
  -Files @("install.cmd", "payload.zip") `
  -AppLaunched "cmd.exe /d /s /c `"`"install.cmd`"`"" `
  -FinishMessage "Friday installation completed."

$profileSedContent = New-IExpressSedContent `
  -TargetExe $profileOutput `
  -FriendlyName "OpenClaw Profile Setup" `
  -SourceDir $profileStage `
  -Files @("install.cmd", "payload.zip") `
  -AppLaunched "cmd.exe /d /s /c `"`"install.cmd`"`"" `
  -FinishMessage "OpenClaw profile installation completed."

Set-Content -LiteralPath $fridaySed -Value $fridaySedContent -Encoding ASCII
Set-Content -LiteralPath $profileSed -Value $profileSedContent -Encoding ASCII

Invoke-IExpressBuild -IExpressPath $iexpress -SedPath $fridaySed -OutputExe $fridayOutput
Invoke-IExpressBuild -IExpressPath $iexpress -SedPath $profileSed -OutputExe $profileOutput

Copy-Item -LiteralPath $fridayOutput -Destination (Join-Path $targetDir "Friday Setup IExpress.exe") -Force
Copy-Item -LiteralPath $profileOutput -Destination (Join-Path $targetDir "OpenClaw Profile Setup IExpress.exe") -Force

Get-ChildItem -LiteralPath $targetDir | Select-Object FullName, Length, LastWriteTime
