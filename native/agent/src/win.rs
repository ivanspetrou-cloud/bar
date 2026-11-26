// Окна и панель задач: активное окно, раскладка, игровой режим, список окон для таскбара Bar, превью, иконки окон.
use serde_json::{json, Value};
use std::collections::HashMap;

use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Globalization::{GetLocaleInfoEx, LCIDToLocaleName};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, GetKeyboardLayout, GetKeyboardLayoutList, HKL, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP};
use windows::Win32::UI::Shell::{SHAppBarMessage, SHQueryUserNotificationState, APPBARDATA};
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::img;

pub fn pid_of(h: HWND) -> (u32, u32) { let mut pid = 0u32; let tid = unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) }; (tid, pid) }
pub fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() }
fn hwnd(v: i64) -> HWND { HWND(v as isize as *mut _) }
fn hv(h: HWND) -> i64 { h.0 as isize as i64 }

pub fn exe_path(pid: u32) -> String {
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 1024];
        let mut n = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut n).is_ok();
        let _ = CloseHandle(h);
        if ok { String::from_utf16_lossy(&buf[..n as usize]) } else { String::new() }
    }
}
fn monitor(h: HWND) -> Option<RECT> {
    let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if unsafe { GetMonitorInfoW(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), &mut mi) }.as_bool() { Some(mi.rcMonitor) } else { None }
}
fn lang_name(hkl: i64) -> String {
    let mut buf = [0u16; 85];
    let n = unsafe { LCIDToLocaleName((hkl & 0xFFFF) as u32, Some(&mut buf), 0) };
    if n > 1 { String::from_utf16_lossy(&buf[..(n - 1) as usize]) } else { String::new() }
}
fn lang_display(name: &str) -> String {
    if name.is_empty() { return String::new(); }
    let w = wide(name);
    let mut buf = [0u16; 256];
    let n = unsafe { GetLocaleInfoEx(PCWSTR(w.as_ptr()), 0x02 /* LOCALE_SLOCALIZEDDISPLAYNAME */, Some(&mut buf)) };
    if n > 1 { String::from_utf16_lossy(&buf[..(n - 1) as usize]) } else { String::new() }
}
fn text(h: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetWindowTextW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

// все окна верхнего уровня
fn enum_windows() -> Vec<HWND> {
    unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> BOOL { unsafe { (*(l.0 as *mut Vec<HWND>)).push(h); } BOOL(1) }
    let mut v: Vec<HWND> = Vec::new();
    unsafe { let _ = EnumWindows(Some(cb), LPARAM(&mut v as *mut _ as isize)); }
    v
}
// окно «как в панели задач»: видимое, с заголовком, без владельца, не служебное и не скрытое DWM
fn task_like(h: HWND) -> bool {
    unsafe {
        if !IsWindowVisible(h).as_bool() || GetWindowTextLengthW(h) == 0 { return false; }
        if GetWindow(h, GW_OWNER).map_or(false, |o| !o.is_invalid()) { return false; }
        if (GetWindowLongW(h, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0) != 0 { return false; }
        let mut cloaked = 0i32;
        if DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, 4).is_ok() && cloaked != 0 { return false; }
        true
    }
}
fn key(vk: u8, up: bool) { unsafe { keybd_event(vk, 0, if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, 0) } }

pub struct Win { last_fg: HWND, bar_pid: u32, me: u32, hidden: HashMap<u32, Vec<i64>> }
impl Win {
    pub fn new(bar_pid: u32) -> Self { Win { last_fg: HWND::default(), bar_pid, me: std::process::id(), hidden: HashMap::new() } }
    // окно, где работает пользователь (не Bar): Bar сам на переднем плане — берём последнее чужое
    fn target(&mut self) -> HWND {
        let fg = unsafe { GetForegroundWindow() };
        let (_, pid) = pid_of(fg);
        if !fg.is_invalid() && pid != self.bar_pid && pid != self.me { self.last_fg = fg; }
        if !self.last_fg.is_invalid() && !unsafe { IsWindow(Some(self.last_fg)) }.as_bool() { self.last_fg = HWND::default(); }
        if !self.last_fg.is_invalid() { self.last_fg } else { fg }
    }
    pub fn layout(&mut self) -> Value {
        let (tid, _) = pid_of(self.target());
        json!(lang_name(unsafe { GetKeyboardLayout(tid) }.0 as isize as i64))
    }
    // установленные раскладки: "hkl|ru-RU|Русский (Россия)|1 — текущая"
    pub fn layouts(&mut self) -> Value {
        let (tid, _) = pid_of(self.target());
        let cur = unsafe { GetKeyboardLayout(tid) }.0 as isize as i64;
        let n = unsafe { GetKeyboardLayoutList(None) };
        let mut arr = vec![HKL::default(); n.max(0) as usize];
        unsafe { GetKeyboardLayoutList(Some(&mut arr)) };
        json!(arr.iter().map(|h| { let v = h.0 as isize as i64; let ln = lang_name(v); format!("{}|{}|{}|{}", v, ln, lang_display(&ln), (v == cur) as i32) }).collect::<Vec<_>>())
    }
    // переключить раскладку в окне, где печатают, и вернуть ему фокус
    pub fn set_layout(&mut self, arg: &str) -> Value {
        let t = self.target();
        if t.is_invalid() { return json!(""); }
        let hkl: i64 = arg.trim().parse().unwrap_or(0);
        unsafe { let _ = PostMessageW(Some(t), WM_INPUTLANGCHANGEREQUEST, WPARAM(0), LPARAM(hkl as isize)); }
        focus(hv(t));
        json!(lang_name(hkl))
    }
    pub fn fg(&mut self) -> Value { let (_, pid) = pid_of(self.target()); json!(exe_path(pid)) }
    pub fn fg_max(&mut self) -> Value {
        let h = self.target();
        if h.is_invalid() || !unsafe { IsZoomed(h) }.as_bool() { return json!(""); }
        match monitor(h) { Some(m) => json!(format!("{},{},{},{}", m.left, m.top, m.right, m.bottom)), None => json!("") }
    }
    // "полноэкранное(1/0)|состояние уведомлений|exe|pid|монитор x,y,w,h"
    pub fn game_state(&mut self) -> Value {
        let h = self.target();
        if h.is_invalid() { return json!(""); }
        let mut cls = [0u16; 256];
        let n = unsafe { GetClassNameW(h, &mut cls) };
        let c = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
        if matches!(c.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") { return json!(""); }
        let mut r = RECT::default();
        let _ = unsafe { GetWindowRect(h, &mut r) };
        let m = monitor(h).unwrap_or_default();
        // развёрнутое кнопкой окно тоже вылезает за края на рамку — но это не полноэкранная игра
        let full = !unsafe { IsZoomed(h) }.as_bool() && r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom;
        let (_, pid) = pid_of(h);
        let q = unsafe { SHQueryUserNotificationState() }.map(|s| s.0).unwrap_or(0);
        json!(format!("{}|{}|{}|{}|{},{},{},{}", full as i32, q, exe_path(pid), pid, m.left, m.top, m.right - m.left, m.bottom - m.top))
    }
    // скрыть / показать окна процесса (окно браузера с музыкой): звук играет дальше; скрытые запоминаем, чтобы вернуть ровно их
    pub fn hide_pid(&mut self, pid: u32) -> Value {
        let list: Vec<HWND> = enum_windows().into_iter().filter(|&h| unsafe {
            pid_of(h).1 == pid && IsWindowVisible(h).as_bool() && GetWindowTextLengthW(h) > 0 && GetWindow(h, GW_OWNER).map_or(true, |o| o.is_invalid())
        }).collect();
        for &h in &list { unsafe { let _ = ShowWindow(h, SW_HIDE); } }
        self.hidden.entry(pid).or_default().extend(list.iter().map(|&h| hv(h)));
        json!(list.len())
    }
    pub fn show_pid(&mut self, pid: u32) -> Value {
        let Some(list) = self.hidden.remove(&pid) else { return json!(0) };
        for &h in &list { unsafe { let _ = ShowWindow(hwnd(h), SW_RESTORE); let _ = SetForegroundWindow(hwnd(h)); } }
        json!(list.len())
    }
}

// видимые окна верхнего уровня, как в панели задач: "hwnd|pid|exe"
pub fn windows() -> Vec<String> {
    enum_windows().into_iter().filter(|&h| task_like(h)).map(|h| { let (_, pid) = pid_of(h); format!("{}|{}|{}", hv(h), pid, exe_path(pid)) }).collect()
}
// для таскбара Bar: окно|процесс|exe|свёрнуто|активно|монитор l,t,r,b|заголовок (последним: в нём может быть «|»)
pub fn task_windows() -> Value {
    let fg = unsafe { GetForegroundWindow() };
    json!(enum_windows().into_iter().filter(|&h| task_like(h)).map(|h| {
        let (_, pid) = pid_of(h);
        let m = monitor(h).map(|m| format!("{},{},{},{}", m.left, m.top, m.right, m.bottom)).unwrap_or_default();
        format!("{}|{}|{}|{}|{}|{}|{}", hv(h), pid, exe_path(pid), unsafe { IsIconic(h) }.as_bool() as i32, (h == fg) as i32, m, text(h).replace(['\r', '\n'], " "))
    }).collect::<Vec<_>>())
}
// превью окон: "hwnd|jpeg base64" для каждого запрошенного
pub fn win_thumbs(arg: &str) -> Value {
    json!(arg.split(',').filter(|s| !s.is_empty()).map(|s| {
        let t = s.trim().parse::<i64>().ok().and_then(|v| img::thumb(hwnd(v), 720, 450, (1, 1))).map(|b| img::b64(&b)).unwrap_or_default();
        format!("{}|{}", s, t)
    }).collect::<Vec<_>>())
}
// PNG иконки окна запущенной программы с этим exe (для программ без иконки в exe)
pub fn win_icon(exe: &str) -> Value {
    let want = exe.to_lowercase();
    for line in windows() {
        let p: Vec<&str> = line.splitn(3, '|').collect();
        if p.len() < 3 || p[2].to_lowercase() != want { continue; }
        let h = hwnd(p[0].parse().unwrap_or(0));
        let mut r: usize = 0;
        unsafe {
            SendMessageTimeoutW(h, WM_GETICON, WPARAM(ICON_BIG as usize), LPARAM(0), SMTO_ABORTIFHUNG, 300, Some(&mut r));
            if r == 0 { SendMessageTimeoutW(h, WM_GETICON, WPARAM(2 /* ICON_SMALL2 */), LPARAM(0), SMTO_ABORTIFHUNG, 300, Some(&mut r)); }
            if r == 0 { r = GetClassLongPtrW(h, GCLP_HICON); }
        }
        if r == 0 { continue; }
        if let Ok(png) = img::png_hicon(HICON(r as *mut _)) { return json!(img::b64(&png)); }
    }
    Value::Null
}

// Вывести окно вперёд. Windows не даёт фоновой программе забрать фокус, пока пользователь последним кликал
// в другом окне (например, на другом мониторе), — поэтому несколько способов по очереди, с проверкой результата.
pub fn focus(h: i64) -> bool { focus_opts(h, true) }
/// Перед запуском программы из дока: Windows разрешает выйти вперёд только процессу, который получил последний ввод.
/// Клик по доку в Tauri получает процесс WebView2, а не Bar, — поэтому запущенная программа открывалась позади,
/// пока не кликнешь куда-нибудь ещё. Нажатие Alt делает Bar «последним вводом», а затем это право отдаём любой программе.
/// Alt нажимается с «пустой» клавишей внутри (0x88 — не назначена): одиночное отпускание Alt переводит активное окно
/// в режим меню, и следующий клик по нему съедается (кнопки «не работали», пока не кликнешь по пустому месту).
/// Если впереди уже окно Bar — ничего не нажимаем: право выйти вперёд у нас и так есть.
pub fn allow_foreground() { unsafe { if !bar_is_foreground() { alt_tap(); } let _ = AllowSetForegroundWindow(ASFW_ANY); } }
/// «Последний ввод» — от Bar, но без режима меню (см. allow_foreground)
pub fn alt_tap() { key(0x12, false); key(0x88, false); key(0x88, true); key(0x12, true); }
/// впереди окно самого Bar (нотч, док) — тогда никаких нажатий не нужно
pub fn bar_is_foreground() -> bool { unsafe { let (_, pid) = pid_of(GetForegroundWindow()); pid == std::process::id() } }
/// minimize: разрешить последний способ — свернуть и развернуть окно (виден как анимация Windows; для нотча — нельзя)
pub fn focus_opts(h: i64, minimize: bool) -> bool {
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    let h = hwnd(h);
    unsafe {
        if IsIconic(h).as_bool() { let _ = ShowWindow(h, SW_RESTORE); }
        let done = || GetForegroundWindow() == h;
        // 1) Alt снимает блокировку переднего плана (без режима меню — см. allow_foreground)
        if !bar_is_foreground() { alt_tap(); }
        let _ = SetForegroundWindow(h);
        if done() { return true; }
        // 2) присоединиться к очереди ввода окна, которое сейчас впереди, — тогда смена фокуса разрешена
        let me = GetCurrentThreadId();
        let (fg_tid, _) = pid_of(GetForegroundWindow());
        let (to_tid, _) = pid_of(h);
        let a1 = fg_tid != 0 && fg_tid != me && AttachThreadInput(me, fg_tid, true).as_bool();
        let a2 = to_tid != 0 && to_tid != me && to_tid != fg_tid && AttachThreadInput(me, to_tid, true).as_bool();
        let _ = BringWindowToTop(h);
        let _ = SetForegroundWindow(h);
        if a1 { let _ = AttachThreadInput(me, fg_tid, false); }
        if a2 { let _ = AttachThreadInput(me, to_tid, false); }
        if done() { return true; }
        // 3) так переключает Alt+Tab
        SwitchToThisWindow(h, true);
        std::thread::sleep(std::time::Duration::from_millis(60));
        if done() || !minimize { return done(); }
        // 4) свернуть и развернуть: развёрнутое окно Windows активирует всегда
        let _ = ShowWindow(h, SW_MINIMIZE);
        let _ = ShowWindow(h, SW_RESTORE);
        std::thread::sleep(std::time::Duration::from_millis(60));
        done()
    }
}
pub fn minimize(h: i64) { unsafe { let _ = ShowWindow(hwnd(h), SW_MINIMIZE); } }
// закрыть одно окно (как крестик в заголовке)
pub fn close_window(h: i64) -> bool { unsafe { PostMessageW(Some(hwnd(h)), WM_CLOSE, WPARAM(0), LPARAM(0)).is_ok() } }
// закрыть программу так же, как Process.CloseMainWindow: WM_CLOSE её главному окну
pub fn close_pid(pid: u32) -> Result<bool, String> {
    if pid == 0 || exe_path(pid).is_empty() && !process_exists(pid) { return Err(format!("Cannot find a process with the process identifier {}.", pid)); }
    let main = enum_windows().into_iter().find(|&h| unsafe { pid_of(h).1 == pid && IsWindowVisible(h).as_bool() && GetWindow(h, GW_OWNER).map_or(true, |o| o.is_invalid()) });
    Ok(match main { Some(h) => unsafe { PostMessageW(Some(h), WM_CLOSE, WPARAM(0), LPARAM(0)).is_ok() }, None => false })
}
fn process_exists(pid: u32) -> bool {
    unsafe { match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) { Ok(h) => { let _ = CloseHandle(h); true } Err(_) => false } }
}
pub fn start_menu() { key(0x5B, false); key(0x5B, true); }
// медиа-клавиша (173 — звук вкл/выкл, 174/175 — тише/громче, 176 — следующий, 177 — предыдущий, 179 — пауза/играть)
pub fn media_key(vk: u8) {
    if !(173..=179).contains(&vk) { return; }
    unsafe { keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY, 0); keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0); }
}
pub fn show_desktop() { key(0x5B, false); key(0x44, false); key(0x44, true); key(0x5B, true); }

// ---------- панель задач Windows ----------
fn abd(h: i64) -> APPBARDATA { APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, hWnd: hwnd(h), ..Default::default() } }
pub fn tb_autohide() -> bool { let mut d = abd(0); unsafe { SHAppBarMessage(4 /* ABM_GETSTATE */, &mut d) & 1 != 0 } }
/// настоящая панель задач Windows: окно класса Shell_TrayWnd, но не приёмник трея Bar (заголовок «BarTrayHost»)
pub fn explorer_tray() -> isize {
    let cls = wide("Shell_TrayWnd");
    let mut after = HWND::default();
    unsafe {
        while let Ok(x) = FindWindowExW(None, Some(after), PCWSTR(cls.as_ptr()), PCWSTR::null()) {
            if x.is_invalid() { break; }
            let mut t = [0u16; 32];
            let n = GetWindowTextW(x, &mut t) as usize;
            if String::from_utf16_lossy(&t[..n]) != "BarTrayHost" { return x.0 as isize; }
            after = x;
        }
    }
    0
}
pub fn tb_set_autohide(on: bool) {
    let mut d = abd(0);
    d.hWnd = HWND(explorer_tray() as *mut _);
    d.lParam = LPARAM(if on { 1 } else { 2 });
    unsafe { SHAppBarMessage(10 /* ABM_SETSTATE */, &mut d) };
}
// спрятать / показать панель задач целиком (основную и на других мониторах), пока работает таскбар Bar
pub fn tb_hide(hide: bool) -> i32 {
    let cmd = if hide { SW_HIDE } else { SW_SHOW };
    let (main, second) = (wide("Shell_TrayWnd"), wide("Shell_SecondaryTrayWnd"));
    let mut n = 0;
    unsafe {
        let t = HWND(explorer_tray() as *mut _);
        if !t.is_invalid() { let _ = ShowWindow(t, cmd); n += 1; }
        let _ = &main;
        let mut s = HWND::default();
        while let Ok(x) = FindWindowExW(None, Some(s), PCWSTR(second.as_ptr()), PCWSTR::null()) {
            if x.is_invalid() { break; }
            let _ = ShowWindow(x, cmd); n += 1; s = x;
        }
    }
    n
}
// резерв места у нижнего края: развёрнутые окна заканчиваются над таскбаром Bar. Физические пиксели; ответ «l t r b»
pub fn appbar_set(arg: &str) -> Value {
    let w: Vec<i64> = arg.split(' ').map(|x| x.parse().unwrap_or(0)).collect();
    let g = |i: usize| w.get(i).copied().unwrap_or(0);
    let mut d = abd(g(0));
    d.uCallbackMessage = g(5) as u32; d.uEdge = 3;
    unsafe {
        SHAppBarMessage(0 /* ABM_NEW */, &mut d);
        let h = (g(4) - g(2)) as i32;
        d.rc = RECT { left: g(1) as i32, right: g(3) as i32, bottom: g(4) as i32, top: g(4) as i32 - h };
        SHAppBarMessage(2 /* ABM_QUERYPOS */, &mut d);
        d.rc.top = d.rc.bottom - h;
        SHAppBarMessage(3 /* ABM_SETPOS */, &mut d);
    }
    json!(format!("{} {} {} {}", d.rc.left, d.rc.top, d.rc.right, d.rc.bottom))
}
pub fn appbar_new(arg: &str) {
    let w: Vec<i64> = arg.split(' ').map(|x| x.parse().unwrap_or(0)).collect();
    let mut d = abd(w.first().copied().unwrap_or(0));
    d.uCallbackMessage = w.get(1).copied().unwrap_or(0) as u32;
    unsafe { SHAppBarMessage(0, &mut d) };
}
pub fn appbar_off(h: i64) { let mut d = abd(h); unsafe { SHAppBarMessage(1 /* ABM_REMOVE */, &mut d) }; }

// ---------- тема Windows: '' — прочитать (true — светлая, null — неизвестно), '1' / '0' — сменить ----------
// После смены — то же оповещение, что шлют «Параметры» (WM_SETTINGCHANGE «ImmersiveColorSet»): иначе программы,
// в том числе сам Bar, о смене темы не узнают.
pub fn win_theme(arg: &str) -> Value {
    use windows::Win32::System::Registry::{RegCloseKey, RegCreateKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_DWORD, REG_OPTION_NON_VOLATILE};
    let path = wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
    let mut k = HKEY::default();
    unsafe {
        if RegCreateKeyExW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr()), None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_READ | KEY_WRITE, None, &mut k, None).is_err() { return Value::Null; }
        let res = if arg != "1" && arg != "0" {
            let name = wide("AppsUseLightTheme");
            let mut v = 0u32; let mut n = 4u32;
            if RegQueryValueExW(k, PCWSTR(name.as_ptr()), None, None, Some(&mut v as *mut u32 as *mut u8), Some(&mut n)).is_ok() { json!(v != 0) } else { Value::Null }
        } else {
            let v: u32 = if arg == "1" { 1 } else { 0 };
            for name in ["AppsUseLightTheme", "SystemUsesLightTheme"] {
                let w = wide(name);
                let _ = RegSetValueExW(k, PCWSTR(w.as_ptr()), None, REG_DWORD, Some(&v.to_le_bytes()));
            }
            let msg = wide("ImmersiveColorSet");
            SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, WPARAM(0), LPARAM(msg.as_ptr() as isize), SMTO_ABORTIFHUNG, 1000, None);
            json!(arg == "1")
        };
        let _ = RegCloseKey(k);
        res
    }
}
