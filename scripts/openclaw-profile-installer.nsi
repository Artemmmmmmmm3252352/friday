Unicode True
!ifndef PRODUCT_NAME
  !define PRODUCT_NAME "OpenClaw Profile"
!endif
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.0.0.0"
!endif
!ifndef COMPANY_NAME
  !define COMPANY_NAME "X-VEXTA"
!endif
!ifndef FILE_DESCRIPTION
  !define FILE_DESCRIPTION "OpenClaw Profile Installer"
!endif
!ifndef BRANDING_TEXT
  !define BRANDING_TEXT "Friday OpenClaw Profile Installer"
!endif

Name "${PRODUCT_NAME}"
OutFile "${OUTFILE}"
InstallDir "$PROFILE\.openclaw"
RequestExecutionLevel user
ShowInstDetails show
BrandingText "${BRANDING_TEXT}"

VIProductVersion "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=1033 "CompanyName" "${COMPANY_NAME}"
VIAddVersionKey /LANG=1033 "FileDescription" "${FILE_DESCRIPTION}"
VIAddVersionKey /LANG=1033 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "OriginalFilename" "OpenClaw-Profile-Setup.exe"

Page instfiles

Section "Install"
  SetShellVarContext current
  CreateDirectory "$INSTDIR"
  SetOutPath "$INSTDIR"
  DetailPrint "Installing OpenClaw profile to $INSTDIR"
  File /r "${SOURCE_DIR}\*"
SectionEnd
