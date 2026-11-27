# Проверка обновления перед релизом: ставит прошлую версию с GitHub, обновляет её новым установщиком так же,
# как это делает кнопка «Скачать» в Bar (/S --updated --force-run, пока старый Bar ещё работает), и проверяет:
# новый Bar запустился и не упал, окно нотча создано, в журнале нет сбоев, в системе записана новая версия,
# на диске новый Bar.exe, помощник Alt+Tab (если был) снова запущен.
# Запуск: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-check.ps1 -Version 0.6.13
# Код выхода 0 — всё в порядке, 1 — обновление сломано (релиз выпускать нельзя), 2 — проверку нельзя запускать сейчас.
param([Parameter(Mandatory)][string]$Version, [string]$Installer, [string]$From, [switch]$Force, [switch]$Detached)  # From — прошлая версия, по умолчанию последний релиз
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
# Консоль Claude (приложение из Microsoft Store) подменяет %APPDATA% и HKCU своей виртуальной копией — и для всех
# программ, запущенных из неё. Bar, запущенный оттуда, пишет настройки и журнал не туда, а установщик — не в тот
# реестр. Поэтому проверка всегда перезапускает себя через WMI: процесс от службы WMI живёт вне этой песочницы.
$outLog = Join-Path $root 'dist\update-check.log'; $outCode = Join-Path $root 'dist\update-check.code'
if (-not $Detached) {
    Remove-Item $outLog, $outCode -ErrorAction SilentlyContinue
    $a = "-Version `"$Version`"" + $(if ($Installer) { " -Installer `"$Installer`"" }) + $(if ($From) { " -From `"$From`"" }) + $(if ($Force) { ' -Force' })
    $cmd = "cmd.exe /c powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Detached $a > `"$outLog`" 2>&1"
    # окно консоли скрыто (ShowWindow = 0), иначе у пользователя вылезает чёрное окно cmd
    $si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $r = Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $root; ProcessStartupInformation = $si }
    if ($r.ReturnValue -ne 0) { Write-Host "не удалось запустить проверку вне песочницы ($($r.ReturnValue))"; exit 2 }
    $p = Get-Process -Id $r.ProcessId -ErrorAction SilentlyContinue
    if ($p) { $p.WaitForExit(300000) | Out-Null }
    if (Test-Path $outLog) { Get-Content $outLog -Encoding UTF8 }
    $code = if (Test-Path $outCode) { [int](Get-Content $outCode) } else { 1 }
    exit $code
}
function Done($c) { Set-Content $outCode $c; exit $c }
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
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
    # отдельным процессом через WMI: без общей консоли с проверкой (иначе Ctrl+C от дочерних процессов установщика обрывал её)
    # (без скрытия окна: установщик тихий и окон не показывает, а скрытие передалось бы запущенному им Bar)
    $r = Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$path`" /S --updated --force-run" }
    $p = Get-Process -Id $r.ProcessId -ErrorAction SilentlyContinue
    if ($r.ReturnValue -ne 0 -or -not $p) { Fail "не удалось запустить $(Split-Path -Leaf $path)"; return $false }
    $null = $p.Handle  # чтобы потом прочитать код выхода
    if (-not $p.WaitForExit(90000)) { Fail "установщик $(Split-Path -Leaf $path) не завершился за 90 с"; return $false }
    if ($p.ExitCode -ne 0) { Fail "установщик $(Split-Path -Leaf $path) вернул код $($p.ExitCode)"; return $false }
    $true
}

# 0. не мешать игре
#    игра — это: (а) любое окно во весь экран на переднем плане (так игру определяет сам Bar);
#    (б) процесс из папки игр Steam/Epic/Riot/GOG/Xbox/Battle.net/Ubisoft/EA; (в) процесс из списка игр, которые Bar уже видел
function GameRunning {
    Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool IsZoomed(System.IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
public struct RECT { public int L, T, R, B; }
'@ -ErrorAction SilentlyContinue
    Add-Type -AssemblyName System.Windows.Forms
    $skip = 'explorer', 'Bar', 'msedgewebview2', 'ShellExperienceHost', 'SearchHost', 'StartMenuExperienceHost', 'LockApp'
    $fg = [W.U]::GetForegroundWindow(); $r = New-Object W.U+RECT; $fpid = 0
    if ($fg -ne [IntPtr]::Zero -and [W.U]::GetWindowRect($fg, [ref]$r)) {
        [void][W.U]::GetWindowThreadProcessId($fg, [ref]$fpid)
        $p = Get-Process -Id $fpid -ErrorAction SilentlyContinue
        $full = [System.Windows.Forms.Screen]::AllScreens | Where-Object { $b = $_.Bounds; $r.L -le $b.Left -and $r.T -le $b.Top -and $r.R -ge $b.Right -and $r.B -ge $b.Bottom }
        # развёрнутое окно (Claude, браузер) тоже закрывает экран, когда панель задач скрыта, — это не игра
        if ($full -and -not [W.U]::IsZoomed($fg) -and $p -and $skip -notcontains $p.Name) { return "$($p.Name) (во весь экран)" }
    }
    $dirs = '\steamapps\common\', '\Epic Games\', '\Riot Games\', '\GOG Games\', '\XboxGames\', '\Battle.net\', '\Blizzard\', '\Ubisoft Game Launcher\games\', '\EA Games\', '\Electronic Arts\'
    $seen = @()
    try { $seen = @((Get-Content (Join-Path $env:APPDATA 'Bar\settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json).game.seen) | Where-Object { $_ -and $_ -notlike "$env:TEMP*" -and $_ -notlike '*\WindowsApps\*' } } catch {}
    foreach ($p in Get-Process) {
        $path = $p.Path; if (-not $path) { continue }
        if ('wallpaper32', 'wallpaper64', 'webwallpaper32', 'ui32' -contains $p.Name) { continue }  # Wallpaper Engine лежит в steamapps, но не игра
        if ($dirs | Where-Object { $path -like "*$_*" }) { return $p.Name }
        if ($seen -contains $path) { return $p.Name }
    }
    $null
}
$game = GameRunning
if ($game -and -not $Force) { Write-Host "Запущена игра: $game — проверка обновления перезапускает Bar, сейчас нельзя (-Force — всё равно запустить)." -ForegroundColor Yellow; Done 2 }
if (-not (Test-Path $Installer)) { Write-Host "Нет установщика $Installer"; Done 2 }

# 1. прошлая версия — последний опубликованный релиз
$tag = if ($From) { 'v' + $From.TrimStart('v') } else { '' }
$ghArgs = @('release', 'view') + @($tag | Where-Object { $_ }) + @('-R', 'ivanspetrou-cloud/bar', '--json', 'tagName,assets')
$rel = (& gh @ghArgs) -join "`n" | ConvertFrom-Json
if (-not $rel) { Write-Host 'Не удалось получить релиз с GitHub'; Done 2 }
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

if ($fails.Count) { Write-Host "ОБНОВЛЕНИЕ СЛОМАНО ($($fails.Count)) — релиз не выпускать" -ForegroundColor Red; Done 1 }
Write-Host 'Обновление работает' -ForegroundColor Green
Done 0
