; Tauri NSIS installer hooks for AgentX.
; Converted from the old electron-builder `installer.nsh`: electron-builder
; called the macros `customInstall` / `customUnInstall`, but Tauri's NSIS
; template calls `NSIS_HOOK_POSTINSTALL` / `NSIS_HOOK_POSTUNINSTALL`
; instead, so the same registry writes are hooked under the Tauri names.
; Referenced from tauri.conf.json (`bundle > windows > nsis >
; installerHooks`). Behaviour is unchanged: an Explorer context-menu entry
; ("Open with AgentX") for directories, removed again on uninstall.

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentX" "" "Open with AgentX"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentX" "Icon" "$INSTDIR\AgentX.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentX\command" "" '"$INSTDIR\AgentX.exe" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\AgentX" "" "Open with AgentX"
  WriteRegStr HKCU "Software\Classes\Directory\shell\AgentX" "Icon" "$INSTDIR\AgentX.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\AgentX\command" "" '"$INSTDIR\AgentX.exe" "%1"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\AgentX"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\AgentX"
!macroend
