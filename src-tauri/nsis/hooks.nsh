; Netami Pin installer hooks (NP-037, Р-9, Р-17).
;
; Tauri's NSIS template (tauri-cli 2.12) includes this file after MUI2 and
; LogicLib but before its own defines and pages. So the functions below spell
; out names instead of ${PRODUCTNAME} and ${MAINBINARYNAME}, and the two
; MUI_PAGE_CUSTOMFUNCTION defines attach to the first page the template inserts:
; the Welcome page. After a Tauri upgrade, check both still hold
; (doc/testing.md, «Установщик»).

!define NP_PRODUCT "Netami Pin"
!define NP_EXE "netamipin.exe"
!define NP_HOST_EXE "netamipin-host.exe"
!define NP_DATA_DIR "Netami Pin"
!define NP_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
; Task Manager's «Disabled» flag; no value means enabled.
!define NP_RUN_APPROVED_KEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
!define NP_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NP_PRODUCT}"

Var NpAutostartBox
; 1 when the person unticked «start with Windows»; empty until the Welcome page
; is shown, so a passive or silent install starts with Windows.
Var NpNoAutostart

!define MUI_PAGE_CUSTOMFUNCTION_SHOW NpWelcomeShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE NpWelcomeLeave

Function NpWelcomeShow
  Push $0
  ${If} $NpNoAutostart == ""
    ; Ticked, unless an installed copy had it turned off in the settings.
    StrCpy $NpNoAutostart 0
    ReadRegStr $0 HKCU "${NP_UNINSTALL_KEY}" "UninstallString"
    ${If} $0 != ""
      ReadRegStr $0 HKCU "${NP_RUN_KEY}" "${NP_PRODUCT}"
      ${If} $0 == ""
        StrCpy $NpNoAutostart 1
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ; Below the welcome text, which ends near 130u in both languages.
  ${NSD_CreateCheckbox} 120u 160u 195u 20u "$(npAutostart)"
  Pop $NpAutostartBox
  SetCtlColors $NpAutostartBox "" "FFFFFF"
  ${If} $NpNoAutostart <> 1
    ${NSD_Check} $NpAutostartBox
  ${EndIf}
  Pop $0
FunctionEnd

Function NpWelcomeLeave
  Push $0
  ${NSD_GetState} $NpAutostartBox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $NpNoAutostart 0
  ${Else}
    StrCpy $NpNoAutostart 1
  ${EndIf}
  Pop $0
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  ; A browser may hold the host open; the old file cannot be replaced then.
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${NP_HOST_EXE}" "${NP_PRODUCT}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Manifests next to the app and the browsers' keys in HKCU, written by the
  ; app's own code, so the extension saves links before the app first starts.
  ExecWait '"$INSTDIR\${NP_EXE}" --register-host' $0
  ${If} $0 != 0
    DetailPrint "Netami Pin could not register the browser helper ($0); the app retries at every start."
  ${EndIf}

  ; An update keeps whatever the person chose in the settings.
  ${If} $UpdateMode <> 1
    ${If} $NpNoAutostart == 1
      DeleteRegValue HKCU "${NP_RUN_KEY}" "${NP_PRODUCT}"
    ${Else}
      ; The value tauri-plugin-autostart reads and writes, with the path quoted.
      WriteRegStr HKCU "${NP_RUN_KEY}" "${NP_PRODUCT}" '"$INSTDIR\${NP_EXE}" --autostart'
      DeleteRegValue HKCU "${NP_RUN_APPROVED_KEY}" "${NP_PRODUCT}"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; One check per hook: the macro's labels are unique per line, and the
  ; template checks the app itself right after this hook.
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${NP_HOST_EXE}" "${NP_PRODUCT}"
  ; The keys go before the files they point at. An update installs the same
  ; keys again right after. A running app puts them back only at its next start.
  ${If} $UpdateMode <> 1
    ExecWait '"$INSTDIR\${NP_EXE}" --unregister-host' $0
    ${If} $0 != 0
      DetailPrint "Netami Pin could not remove the browser helper's keys ($0)."
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; The template's checkbox, relabelled «Delete the library and backups»
  ; (Р-10, item 8), also removes the library folder. Unticked by default.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$APPDATA\${NP_DATA_DIR}"
  ${EndIf}
!macroend
