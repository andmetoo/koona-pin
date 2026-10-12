; Koona Pin installer hooks (NP-037, Р-9, Р-17).
;
; Tauri's NSIS template (tauri-cli 2.12) includes this file after MUI2 and
; LogicLib but before its own defines and pages. So the functions below spell
; out names instead of ${PRODUCTNAME} and ${MAINBINARYNAME}, the two
; MUI_PAGE_CUSTOMFUNCTION defines attach to the first page the template inserts
; (the Welcome page), and MUI_CUSTOMFUNCTION_GUIINIT to MUI's .onGUIInit. After
; a Tauri upgrade, check all three still hold with a test install.

!define NP_PRODUCT "Koona Pin"
!define NP_EXE "koonapin.exe"
!define NP_HOST_EXE "koonapin-host.exe"
; The MCP server an AI assistant runs (NP-091).
!define NP_MCP_EXE "koonapin-mcp.exe"
!define NP_BRAND_DIR "Koona"
!define NP_DATA_DIR "Pin"
; The library folder of the builds before NP-112 (Р-56).
!define NP_LEGACY_DATA_DIR "Koona Pin"
!define NP_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
; Task Manager's «Disabled» flag: 12 bytes, zeros after the first four mean
; enabled (as tauri-plugin-autostart reads it); no value means enabled.
!define NP_RUN_APPROVED_KEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
!define NP_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NP_PRODUCT}"

Var NpAutostartBox
; «start with Windows» of the copy installed before this run: none, on or off.
; Read once, before the template may run the old uninstaller (which deletes
; the Run value), so a passive reinstall keeps it.
Var NpPrior
; The Welcome page's checkbox: empty when the page was not shown (passive,
; silent, update), then 0 for ticked and 1 for unticked.
Var NpNoAutostart

!define MUI_PAGE_CUSTOMFUNCTION_SHOW NpWelcomeShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE NpWelcomeLeave
!define MUI_CUSTOMFUNCTION_GUIINIT NpReadPrior

Function NpReadPrior
  ${If} $NpPrior != ""
    Return
  ${EndIf}
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $NpPrior "none"
  ReadRegStr $0 HKCU "${NP_UNINSTALL_KEY}" "UninstallString"
  ${If} $0 != ""
    StrCpy $NpPrior "off"
    ReadRegStr $0 HKCU "${NP_RUN_KEY}" "${NP_PRODUCT}"
    ${If} $0 != ""
      StrCpy $NpPrior "on"
      ; HKEY_CURRENT_USER as a sign-extended handle; 0x8 = RRF_RT_REG_BINARY.
      System::Call '*(i 0, i 0, i 0) p .r1'
      System::Call 'advapi32::RegGetValueW(p -2147483647, w "${NP_RUN_APPROVED_KEY}", w "${NP_PRODUCT}", i 0x8, p 0, p r1, *i 12) i .r0'
      ${If} $0 = 0
        System::Call '*$1(i, i .r2, i .r3)'
        ${If} $2 <> 0
        ${OrIf} $3 <> 0
          StrCpy $NpPrior "off"
        ${EndIf}
      ${EndIf}
      System::Free $1
    ${EndIf}
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function NpWelcomeShow
  Call NpReadPrior
  ${If} $NpNoAutostart == ""
    ; Ticked, unless the installed copy does not start with Windows.
    ${If} $NpPrior == "off"
      StrCpy $NpNoAutostart 1
    ${Else}
      StrCpy $NpNoAutostart 0
    ${EndIf}
  ${EndIf}
  ; Below MUI's welcome text label (120u, 45u, 195u × 130u), so it never
  ; covers the checkbox; up to two lines.
  ${NSD_CreateCheckbox} 120u 175u 195u 18u "$(npAutostart)"
  Pop $NpAutostartBox
  SetCtlColors $NpAutostartBox "" "FFFFFF"
  ${If} $NpNoAutostart <> 1
    ${NSD_Check} $NpAutostartBox
  ${EndIf}
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
  ; A silent install has no .onGUIInit; nothing was uninstalled before this.
  Call NpReadPrior
  ; A browser may hold the host open, an assistant the MCP server; the old file cannot be replaced then.
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${NP_HOST_EXE}" "${NP_PRODUCT}"
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${NP_MCP_EXE}" "${NP_PRODUCT}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Manifests next to the app and the browsers' keys in HKCU, written by the
  ; app's own code, so the extension saves links before the app first starts.
  ExecWait '"$INSTDIR\${NP_EXE}" --register-host' $0
  ${If} $0 != 0
    DetailPrint "Koona Pin could not register the browser helper ($0); the app retries at every start."
  ${EndIf}

  ; The person's choice on the Welcome page; without the page (passive, silent,
  ; update) the installed copy's state stays, and a first install starts with
  ; Windows. The value is the one tauri-plugin-autostart reads, path quoted.
  ${If} $NpNoAutostart == 1
    DeleteRegValue HKCU "${NP_RUN_KEY}" "${NP_PRODUCT}"
  ${ElseIf} $NpNoAutostart == 0
  ${OrIf} $NpPrior != "off"
    WriteRegStr HKCU "${NP_RUN_KEY}" "${NP_PRODUCT}" '"$INSTDIR\${NP_EXE}" --autostart'
    DeleteRegValue HKCU "${NP_RUN_APPROVED_KEY}" "${NP_PRODUCT}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; The host and the MCP server first (they can start the app), then the app;
  ; the template's own check of the app that follows then finds nothing. If
  ; the person cancels here, nothing is removed yet.
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${NP_HOST_EXE}" "${NP_PRODUCT}"
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${NP_MCP_EXE}" "${NP_PRODUCT}"
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${NP_EXE}" "${NP_PRODUCT}"
  ; The keys go before the files they point at. An update installs the same
  ; keys again right after.
  ${If} $UpdateMode <> 1
    ExecWait '"$INSTDIR\${NP_EXE}" --unregister-host' $0
    ${If} $0 != 0
      DetailPrint "Koona Pin could not remove the browser helper's keys ($0)."
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; The template's checkbox, relabelled «Delete the library and backups»
  ; (Р-10, item 8), also removes the library folder. Unticked by default.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$APPDATA\${NP_BRAND_DIR}\${NP_DATA_DIR}"
    ; Without /r: the brand folder goes only when empty, the data of other
    ; Koona apps stays (Р-56).
    RmDir "$APPDATA\${NP_BRAND_DIR}"
    ; A library an earlier build left there goes with the current one.
    RmDir /r "$APPDATA\${NP_LEGACY_DATA_DIR}"
  ${EndIf}
!macroend
