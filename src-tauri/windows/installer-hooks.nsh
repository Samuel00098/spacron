; Explorer integration for the installed desktop app.  These keys live under
; HKCU so the current-user installer never needs elevation and never changes
; another Windows account's context menu.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\Spacron" "" "Open with Spacron"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Spacron" "Icon" "$INSTDIR\spacron.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Spacron\command" "" '"$INSTDIR\spacron.exe" "%1"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Spacron" "" "Open with Spacron"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Spacron" "Icon" "$INSTDIR\spacron.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Spacron\command" "" '"$INSTDIR\spacron.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\*\shell\Spacron" "" "Open with Spacron"
  WriteRegStr HKCU "Software\Classes\*\shell\Spacron" "Icon" "$INSTDIR\spacron.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\Spacron\command" "" '"$INSTDIR\spacron.exe" "%1"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Spacron"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Spacron"
  DeleteRegKey HKCU "Software\Classes\*\shell\Spacron"
!macroend
