; Установщик Bar (Tauri). Ставит Bar туда же, где жила Electron-версия, и заменяет её:
; та же папка программы, та же запись в «Установке и удалении программ», тот же ярлык «Пуска» и автозапуск.
; Данные пользователя (%APPDATA%\Bar — настройки, история буфера, расширение) не трогаются.
; Ключи: /S — тихая установка (так ставит обновление); --force-run — запустить Bar после тихой установки.
; Сборка: makensis /DEXE=<bar-tauri.exe> /DVER=<версия> /DOUT=<Bar-Setup-x.exe> /DPM=<папка presentmon> /DICON=<icon.ico> installer.nsi
Unicode true
SetCompressor /SOLID lzma
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define UKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\05c2e9de-704d-543e-b1a5-a532fe82823e"
Name "Bar"
Caption "Bar ${VER}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\bar-notch"
RequestExecutionLevel user
Icon "${ICON}"
UninstallIcon "${ICON}"
BrandingText "Bar ${VER}"
ShowInstDetails nevershow
AutoCloseWindow true
VIProductVersion "${VER}.0"
VIAddVersionKey "ProductName" "Bar"
VIAddVersionKey "FileDescription" "Bar — нотч для Windows"
VIAddVersionKey "FileVersion" "${VER}"
VIAddVersionKey "ProductVersion" "${VER}"
VIAddVersionKey "LegalCopyright" "ivanspetrou-cloud"
Page instfiles
UninstPage instfiles

; журнал установки — в тот же update.log, что пишет обновление в Bar: по нему видно, где обновление застряло
!macro LOG msg
  CreateDirectory "$APPDATA\Bar"
  FileOpen $9 "$APPDATA\Bar\update.log" a
  FileSeek $9 0 END
  FileWrite $9 "installer ${VER}: ${msg}$\r$\n"
  FileClose $9
!macroend

Section "Bar"
  !insertmacro LOG "start"
  ; закрыть работающий Bar (и прежнюю Electron-версию)
  nsExec::Exec 'taskkill /F /T /IM Bar.exe'
  ; процессы движка окон (msedgewebview2) именно Bar — по его папке данных; чужие (Teams, Edge) не трогаем.
  ; Пока они живы, новый Bar с другими параметрами движка не может создать окна и тихо закрывается
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$q = { Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $$_.CommandLine -like '*app.bar.notch*' } }; & $$q | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; for ($$i = 0; $$i -lt 25; $$i++) { if (-not (& $$q)) { break }; Start-Sleep -Milliseconds 200 }"`
  ; помощник Alt+Tab (с правами администратора) этот установщик закрыть не может — он закрывается сам следом за Bar.
  ; Ждём, пока закроются все Bar.exe (до 10 с), иначе Bar.exe не заменится и останется старая версия
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "for ($$i = 0; $$i -lt 50; $$i++) { if (-not (Get-Process Bar -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 200 }"`
  Sleep 300
  ; файлы прежней версии — только файлы программы в её папке
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
  RMDir /r "$LOCALAPPDATA\bar-notch-updater"

  SetOutPath "$INSTDIR"
  ; Bar.exe ещё занят — повторять до 15 с, а не молча оставить старый файл
  SetOverwrite try
  StrCpy $8 0
  bar_retry:
  ClearErrors
  File "/oname=Bar.exe" "${EXE}"
  ${If} ${Errors}
    IntOp $8 $8 + 1
    ${If} $8 < 30
      Sleep 500
      Goto bar_retry
    ${EndIf}
    !insertmacro LOG "Bar.exe is busy - NOT replaced"
  ${Else}
    !insertmacro LOG "Bar.exe replaced"
  ${EndIf}
  SetOverwrite on
  SetOutPath "$INSTDIR\presentmon"
  File "${PM}\PresentMon.exe"
  File "${PM}\LICENSE.txt"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall Bar.exe"

  WriteRegStr HKCU "${UKEY}" "DisplayName" "Bar"
  WriteRegStr HKCU "${UKEY}" "DisplayVersion" "${VER}"
  WriteRegStr HKCU "${UKEY}" "Publisher" "ivanspetrou-cloud"
  WriteRegStr HKCU "${UKEY}" "DisplayIcon" "$INSTDIR\Bar.exe,0"
  WriteRegStr HKCU "${UKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UKEY}" "UninstallString" '"$INSTDIR\Uninstall Bar.exe" /currentuser'
  WriteRegStr HKCU "${UKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall Bar.exe" /currentuser /S'
  WriteRegDWORD HKCU "${UKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UKEY}" "EstimatedSize" $0

  CreateShortCut "$SMPROGRAMS\Bar.lnk" "$INSTDIR\Bar.exe"
  ${If} ${FileExists} "$DESKTOP\Bar.lnk"
    CreateShortCut "$DESKTOP\Bar.lnk" "$INSTDIR\Bar.exe"
  ${EndIf}
  ; автозапуск уже включён — путь к Bar.exe тот же; обновить его на всякий случай
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "app.bar.notch"
  ${If} $0 != ""
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "app.bar.notch" '"$INSTDIR\Bar.exe" --autostart'
  ${EndIf}

  !insertmacro LOG "done, starting Bar"
  ; запуск: обычная установка — всегда; тихая (обновление) — с ключом --force-run
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--force-run" $R1
  ${If} ${Errors}
    ${IfNot} ${Silent}
      Exec '"$INSTDIR\Bar.exe"'
    ${EndIf}
  ${Else}
    Exec '"$INSTDIR\Bar.exe"'
  ${EndIf}
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /T /IM Bar.exe'
  ; задача помощника Alt+Tab (с правами администратора); без прав может не удалиться — тогда просто не запускается
  nsExec::Exec 'schtasks /Delete /TN "Bar Alt+Tab" /F'
  nsExec::Exec 'schtasks /Delete /TN "Bar" /F'
  Sleep 600
  Delete "$INSTDIR\Bar.exe"
  RMDir /r "$INSTDIR\presentmon"
  Delete "$INSTDIR\Uninstall Bar.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Bar.lnk"
  Delete "$DESKTOP\Bar.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "app.bar.notch"
  DeleteRegKey HKCU "${UKEY}"
SectionEnd
