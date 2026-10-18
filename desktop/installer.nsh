!macro customInstall
  CreateShortCut "$SMPROGRAMS\Silent Stage - Preparar motor local.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--setup-local-engine"
  IfSilent silentStageSetupDone
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --setup-local-engine'
  silentStageSetupDone:
!macroend
!macro customUnInstall
  Delete "$SMPROGRAMS\Silent Stage - Preparar motor local.lnk"
!macroend
