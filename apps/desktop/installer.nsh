!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentX" "" "Open with AgentX"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentX" "Icon" "$INSTDIR\AgentX.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentX\command" "" '"$INSTDIR\AgentX.exe" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\AgentX" "" "Open with AgentX"
  WriteRegStr HKCU "Software\Classes\Directory\shell\AgentX" "Icon" "$INSTDIR\AgentX.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\AgentX\command" "" '"$INSTDIR\AgentX.exe" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\AgentX"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\AgentX"
!macroend
