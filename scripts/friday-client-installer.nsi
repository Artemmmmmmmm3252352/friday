Unicode True
!ifndef PRODUCT_NAME
  !define PRODUCT_NAME "Friday"
!endif
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.0.0.0"
!endif
!ifndef COMPANY_NAME
  !define COMPANY_NAME "X-VEXTA"
!endif
!ifndef FILE_DESCRIPTION
  !define FILE_DESCRIPTION "Friday Installer"
!endif
!ifndef BRANDING_TEXT
  !define BRANDING_TEXT "Friday Client Installer"
!endif

Name "Friday"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Friday"
RequestExecutionLevel user
ShowInstDetails show
BrandingText "${BRANDING_TEXT}"

VIProductVersion "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=1033 "CompanyName" "${COMPANY_NAME}"
VIAddVersionKey /LANG=1033 "FileDescription" "${FILE_DESCRIPTION}"
VIAddVersionKey /LANG=1033 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "OriginalFilename" "Friday-Setup.exe"

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetShellVarContext current
  CreateDirectory "$INSTDIR"
  SetOutPath "$INSTDIR"
  DetailPrint "Installing Friday to $INSTDIR"
  File /r "${SOURCE_DIR}\*"

  !ifdef OPENCLAW_RUNTIME_SOURCE_DIR
    CreateDirectory "$INSTDIR\resources"
    SetOutPath "$INSTDIR\resources\openclaw-runtime"
    DetailPrint "Installing bundled OpenClaw runtime to $INSTDIR\resources\openclaw-runtime"
    File /r "${OPENCLAW_RUNTIME_SOURCE_DIR}\*"
  !endif

  !ifdef OPENCLAW_PROFILE_SOURCE_DIR
    SetOutPath "$PROFILE\.openclaw"
    DetailPrint "Installing OpenClaw profile to $PROFILE\.openclaw"
    File /r "${OPENCLAW_PROFILE_SOURCE_DIR}\*"
  !endif

  WriteUninstaller "$INSTDIR\Uninstall Friday.exe"

  CreateDirectory "$SMPROGRAMS\Friday"
  CreateShortcut "$SMPROGRAMS\Friday\Friday.lnk" "$INSTDIR\Friday.exe"
  CreateShortcut "$SMPROGRAMS\Friday\Uninstall Friday.lnk" "$INSTDIR\Uninstall Friday.exe"
  CreateShortcut "$DESKTOP\Friday.lnk" "$INSTDIR\Friday.exe"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\Friday.lnk"
  Delete "$SMPROGRAMS\Friday\Friday.lnk"
  Delete "$SMPROGRAMS\Friday\Uninstall Friday.lnk"
  RMDir "$SMPROGRAMS\Friday"
  RMDir /r "$INSTDIR"
SectionEnd
