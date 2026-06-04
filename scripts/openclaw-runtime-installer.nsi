Unicode True
!ifndef PRODUCT_NAME
  !define PRODUCT_NAME "OpenClaw"
!endif
!ifndef INSTALL_SUBDIR
  !define INSTALL_SUBDIR "OpenClaw"
!endif
!ifndef BRANDING_TEXT
  !define BRANDING_TEXT "Friday OpenClaw Folder Installer"
!endif

Name "${PRODUCT_NAME}"
OutFile "${OUTFILE}"
InstallDir "$PROFILE\${INSTALL_SUBDIR}"
RequestExecutionLevel user
ShowInstDetails show
BrandingText "${BRANDING_TEXT}"

Page instfiles

Section "Install"
  SetShellVarContext current
  CreateDirectory "$INSTDIR"
  SetOutPath "$INSTDIR"
  DetailPrint "Installing OpenClaw folder to $INSTDIR"
  File /r "${SOURCE_DIR}\*"
SectionEnd
