# Проверка обновления перед релизом: ставит прошлую версию с GitHub, обновляет её новым установщиком так же,
# как это делает кнопка «Скачать» в Bar (/S --updated --force-run, пока старый Bar ещё работает), и проверяет:
# новый Bar запустился и не упал, окно нотча создано, в журнале нет сбоев, в системе записана новая версия,
# на диске новый Bar.exe, помощник Alt+Tab (если был) снова запущен.
# Запуск: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-check.ps1 -Version 0.6.13
# Код выхода 0 — всё в порядке, 1 — обновление сломано (релиз выпускать нельзя), 2 — проверку нельзя запускать сейчас.
param([Parameter(Mandatory)][string]$Version, [string]$Installer, [string]$From)  # From — прошлая версия, по умолчанию последний релиз
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Installer) { $Installer = Join-Path $root "dist\Bar-Setup-$Version.exe" }
$log = Join-Path $env:APPDATA 'Bar\crash.log'
$exe = Join-Path $env:LOCALAPPDATA 'Programs\bar-notch\Bar.exe'
$ukey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\05c2e9de-704d-543e-b1a5-a532fe82823e'
$fails = New-Object System.Collections.Generic.List[string]
function Fail($m) { $fails.Add($m); Write-Host "  ✗ $m" -ForegroundColor Red }
function Ok($m) { Write-Host "  ✓ $m" -ForegroundColor Green }
function Now { [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }  # как в журнале Bar (UTC)
# строки журнала начиная с момента t (формат: [unix-секунды] текст)
function LogSince($t) {
    if (-not (Test-Path $log)) { return @() }
    Get-Content $log -Encoding UTF8 | Where-Object { $_ -match '^\[(\d+)\] ' -and [int64]$Matches[1] -ge $t }
}
function BarProcs { @(Get-Process Bar -ErrorAction SilentlyContinue) }
# ждать в журнале строку «Bar <ver> запущен» после момента t
function WaitStarted($ver, $t, $sec) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) {
        if (LogSince $t | Where-Object { $_ -like "*Bar $ver запущен*" }) { return $true }
        Start-Sleep -Milliseconds 300
    }
    $false
}
function RunInstaller($path) {
    # как updater.rs: установщик запускается, пока Bar ещё открыт
    $p = Start-Process $path -ArgumentList '/S', '--updated', '--force-run' -PassThru
    if (-not $p.WaitForExit(90000)) { Fail "установщик $(Split-Path -Leaf $path) не завершился за 90 с"; return $false }
    if ($p.ExitCode -ne 0) { Fail "установщик $(Split-Path -Leaf $path) вернул код $($p.ExitCode)"; return $false }
    $true
}

# 0. не мешать игре
$game = Get-Process dota2, cs2 -ErrorAction SilentlyContinue
if ($game) { Write-Host "Запущена игра ($($game[0].Name)) — проверка обновления перезапускает Bar, сейчас нельзя." -ForegroundColor Yellow; exit 2 }
if (-not (Test-Path $Installer)) { Write-Host "Нет установщика $Installer"; exit 2 }

# 1. прошлая версия — последний опубликованный релиз
$tag = if ($From) { 'v' + $From.TrimStart('v') } else { '' }
$ghArgs = @('release', 'view') + @($tag | Where-Object { $_ }) + @('-R', 'ivanspetrou-cloud/bar', '--json', 'tagName,assets')
$rel = (& gh @ghArgs) -join "`n" | ConvertFrom-Json
if (-not $rel) { Write-Host 'Не удалось получить релиз с GitHub'; exit 2 }
$asset = $rel.assets | Where-Object { $_.name -like 'Bar-Setup-*.exe' } | Select-Object -First 1
$prevVer = $rel.tagName.TrimStart('v')
$prevDir = Join-Path $root "dist\prev-$prevVer"
$prevExe = Join-Path $prevDir $asset.name
if (-not (Test-Path $prevExe)) {
    New-Item -ItemType Directory -Force $prevDir | Out-Null
    gh release download $rel.tagName -R ivanspetrou-cloud/bar -p $asset.name -D $prevDir --clobber
}
$hadHelper = (BarProcs).Count -ge 2
Write-Host "Обновление $prevVer → $Version"

# 2. поставить прошлую версию и дождаться, пока она полностью запустится (окна движка, помощник)
Write-Host "1) ставлю $prevVer"
$t0 = Now
if (RunInstaller $prevExe) {
    # журнал запуска есть только с 0.6.12 — у более старых ждём процесс Bar
    $logs = [version]$prevVer -ge [version]'0.6.12'
    $up = if ($logs) { WaitStarted $prevVer $t0 30 } else { $e = (Get-Date).AddSeconds(15); while (-not (BarProcs) -and (Get-Date) -lt $e) { Start-Sleep -Milliseconds 300 }; [bool](BarProcs) }
    if ($up) { Ok "$prevVer запущен" } else { Fail "прошлая версия $prevVer не запустилась — проверка недостоверна" }
}
Start-Sleep -Seconds 5

# 3. обновить новой версией — как кнопка «Скачать»
Write-Host "2) обновляю до $Version"
$t1 = Now
if (RunInstaller $Installer) {
    if (WaitStarted $Version $t1 30) { Ok "$Version запущен" } else { Fail "после обновления Bar $Version не запустился" }
}
# 4. не упал ли сразу после запуска (так было у друга: Bar молча закрывался)
Start-Sleep -Seconds 8
$procs = BarProcs
if ($procs.Count -ge 1) { Ok "Bar работает через 8 с после запуска ($($procs.Count) проц.)" } else { Fail 'Bar закрылся после запуска' }
if ($hadHelper) { if ($procs.Count -ge 2) { Ok 'помощник Alt+Tab снова запущен' } else { Fail 'помощник Alt+Tab (окна администратора) не перезапустился' } }

$lines = LogSince $t1
if ($lines | Where-Object { $_ -like '*окно нотча создано*' }) { Ok 'окно нотча создано' } else { Fail 'в журнале нет «окно нотча создано»' }
$fallback = $lines | Where-Object { $_ -like '*пробую без них*' }
if ($fallback) { Fail "движок окон не принял параметры, сработал запасной запуск: $($fallback[0])" }
$crash = $lines | Where-Object { $_ -like '*СБОЙ*' }
if ($crash) { Fail "сбой в журнале: $($crash[0])" } else { Ok 'сбоев в журнале нет' }

$dv = (Get-ItemProperty $ukey -ErrorAction SilentlyContinue).DisplayVersion
if ($dv -eq $Version) { Ok "в системе версия $dv" } else { Fail "в системе записана версия «$dv», а не $Version" }
# на диске именно новый Bar.exe (не остался старый, занятый процессом)
$built = Join-Path $root 'native\target\release\bar-tauri.exe'
if (Test-Path $built) {
    if ((Get-FileHash $exe).Hash -eq (Get-FileHash $built).Hash) { Ok 'Bar.exe на диске — новый' } else { Fail 'Bar.exe на диске не совпадает с собранным (файл не заменился?)' }
}

if ($fails.Count) { Write-Host "ОБНОВЛЕНИЕ СЛОМАНО ($($fails.Count)) — релиз не выпускать" -ForegroundColor Red; exit 1 }
Write-Host 'Обновление работает' -ForegroundColor Green
exit 0
