// Свой переключатель окон по Alt+Tab — в дизайне Bar (страница alttab.html).
// Клавиши перехватывает низкоуровневый хук клавиатуры (WH_KEYBOARD_LL): пока держите Alt, Tab / Shift+Tab / стрелки
// двигают выделение, Esc — отмена, отпустили Alt или Enter — открыть выбранное окно.
// Перехватывает всегда, когда включён (и в играх). Над окнами администратора (Steam и игры, запущенные им) Windows
// не даёт обычной программе видеть клавиши — для них есть помощник с правами администратора (тот же Bar.exe
// с ключом --alttab-helper, запускается задачей Планировщика): он ловит клавиши везде и передаёт их сюда.
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::ctx;

const LABEL: &str = "alttab";
static OPEN: AtomicBool = AtomicBool::new(false);
/// страница переключателя загрузилась и отвечает — только тогда перехватываем (иначе Alt+Tab Windows)
static READY: AtomicBool = AtomicBool::new(false);
static PICKED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static TX: OnceLock<Mutex<Sender<Ev>>> = OnceLock::new();
#[derive(Debug)]
enum Ev { Open(i32), Move(i32), Up, Down, Commit, Cancel }

/// настройки переключателя (общие для Rust и страницы)
pub fn cfg() -> Value {
    let t = ctx::sh().settings.get("alttab");
    // view: thumbs | icons | list; size: s | m | l; monitor: all | here; game: перехватывать ли в игре
    let mut c = json!({ "on": true, "view": "thumbs", "size": "m", "monitor": "all", "minimized": true, "game": false, "dim": true, "titles": true, "screen": "primary" });
    if let Some(o) = t.as_object() { for (k, v) in o { c[k] = v.clone(); } }
    c
}
/// перехватывать ли сейчас — считается в фоне 5 раз в секунду; сам перехватчик только читает этот флаг
/// (если перехватчик клавиш медлит, Windows молча его отключает — и открывался Alt+Tab Windows)
static ALLOW: AtomicBool = AtomicBool::new(false);
fn compute_allow() -> bool {
    let c = cfg();
    if c["on"] == false || !READY.load(Ordering::Relaxed) { return false; }
    true
}
fn enabled() -> bool { ALLOW.load(Ordering::Relaxed) }

/// работает помощник с правами администратора — тогда клавиши ловит он, а свой перехватчик молчит
static HELPER_ON: AtomicBool = AtomicBool::new(false);
/// этот процесс — сам помощник: события не в очередь, а сообщением основному Bar
static IS_HELPER: AtomicBool = AtomicBool::new(false);
static SINK: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
const WM_AT_EV: u32 = WM_APP + 1;      // помощник → Bar: событие (wParam — код, lParam — значение)
const WM_AT_ALLOW: u32 = WM_APP + 10;  // Bar → помощник: перехватывать ли
const WM_AT_FOCUS: u32 = WM_APP + 11;  // Bar → помощник: вывести окно вперёд (у помощника есть права и над окнами администратора)
const WM_AT_QUIT: u32 = WM_APP + 12;   // Bar → помощник: закрыться
const WM_AT_CLOSED: u32 = WM_APP + 13; // Bar → помощник: переключатель закрыт (выбрали мышью)
fn send(e: Ev) {
    if IS_HELPER.load(Ordering::Relaxed) {
        let (code, v) = match e { Ev::Open(d) => (0, d), Ev::Move(d) => (1, d), Ev::Up => (2, 0), Ev::Down => (3, 0), Ev::Commit => (4, 0), Ev::Cancel => (5, 0) };
        let sink = SINK.load(Ordering::Relaxed);
        if sink != 0 { unsafe { let _ = PostMessageW(Some(HWND(sink as *mut _)), WM_AT_EV, WPARAM(code), LPARAM(v as isize)); } }
        return;
    }
    if let Some(t) = TX.get() { let _ = t.lock().unwrap().send(e); }
}
fn key_down(vk: VIRTUAL_KEY) -> bool { unsafe { GetAsyncKeyState(vk.0 as i32) as u16 & 0x8000 != 0 } }

unsafe extern "system" fn kb(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    // помощник с правами администратора работает — клавиши ловит он
    if code == HC_ACTION as i32 && !(HELPER_ON.load(Ordering::Relaxed) && !IS_HELPER.load(Ordering::Relaxed)) {
        let k = &*(lp.0 as *const KBDLLHOOKSTRUCT);
        let up = matches!(wp.0 as u32, WM_KEYUP | WM_SYSKEYUP);
        let injected = k.flags.0 & LLKHF_INJECTED.0 != 0;
        let vk = VIRTUAL_KEY(k.vkCode as u16);
        if !injected {
            if OPEN.load(Ordering::Relaxed) {
                let shift = key_down(VK_SHIFT);
                let mine = match vk {
                    VK_TAB => { if !up { send(Ev::Move(if shift { -1 } else { 1 })); } true }
                    VK_LEFT => { if !up { send(Ev::Move(-1)); } true }
                    VK_RIGHT => { if !up { send(Ev::Move(1)); } true }
                    VK_UP => { if !up { send(Ev::Up); } true }
                    VK_DOWN => { if !up { send(Ev::Down); } true }
                    VK_ESCAPE => { if !up { OPEN.store(false, Ordering::Relaxed); send(Ev::Cancel); } true }
                    VK_RETURN => { if !up { OPEN.store(false, Ordering::Relaxed); send(Ev::Commit); } true }
                    VK_LMENU | VK_RMENU | VK_MENU => { if up { OPEN.store(false, Ordering::Relaxed); send(Ev::Commit); } false } // отпускание Alt не глотаем
                    _ => false,
                };
                if mine { return LRESULT(1); }
            } else if vk == VK_TAB && !up && k.flags.0 & LLKHF_ALTDOWN.0 != 0 && !key_down(VK_CONTROL) && !key_down(VK_LWIN) && !key_down(VK_RWIN) && enabled() {
                OPEN.store(true, Ordering::Relaxed);
                // «пустая» клавиша, пока Alt зажат: окно впереди не уйдёт в режим меню, когда Alt отпустят
                keybd_event(0x88, 0, KEYBD_EVENT_FLAGS(0), 0); keybd_event(0x88, 0, KEYEVENTF_KEYUP, 0);
                send(Ev::Open(if key_down(VK_SHIFT) { -1 } else { 1 }));
                return LRESULT(1);
            }
        }
    }
    CallNextHookEx(None, code, wp, lp)
}

/// окна для переключателя — по порядку «последние сверху» (порядок окон Windows)
fn windows_list(mon: Option<(i32, i32, i32, i32)>) -> Vec<Value> {
    let c = cfg();
    let Ok(rows) = ctx::sh().fast.call_t("taskwins", "", 3000) else { return vec![] };
    let me = std::env::current_exe().map(|p| p.to_string_lossy().to_lowercase()).unwrap_or_default();
    rows.as_array().cloned().unwrap_or_default().iter().filter_map(|r| {
        let p: Vec<&str> = r.as_str()?.split('|').collect();
        if p.len() < 7 { return None; }
        let (exe, title) = (p[2], p[6..].join("|"));
        if exe.is_empty() || exe.to_lowercase() == me { return None; }
        let min = p[3] == "1";
        if min && c["minimized"] == false { return None; }
        if let Some(m) = mon {
            let r: Vec<i32> = p[5].split(',').filter_map(|x| x.parse().ok()).collect();
            if r.len() == 4 && (r[0], r[1]) != (m.0, m.1) { return None; }
        }
        Some(json!({ "hwnd": p[0].parse::<i64>().unwrap_or(0), "pid": p[1].parse::<i64>().unwrap_or(0), "exe": exe, "min": min, "active": p[4] == "1", "title": title }))
    }).collect()
}

/// монитор, где сейчас работают: под окном впереди, иначе под курсором
fn work_monitor() -> Option<tauri::Monitor> {
    let app = ctx::app();
    let w = app.get_webview_window(LABEL)?;
    let all = w.available_monitors().ok()?;
    let mut p = windows::Win32::Foundation::POINT::default();
    unsafe {
        let fg = GetForegroundWindow();
        let mut rc = windows::Win32::Foundation::RECT::default();
        if !fg.is_invalid() && GetWindowRect(fg, &mut rc).is_ok() && rc.right > rc.left { p.x = (rc.left + rc.right) / 2; p.y = (rc.top + rc.bottom) / 2; } else { let _ = GetCursorPos(&mut p); }
    }
    all.iter().find(|m| { let (x, y, s) = (m.position().x, m.position().y, m.size()); p.x >= x && p.y >= y && p.x < x + s.width as i32 && p.y < y + s.height as i32 }).cloned()
        .or_else(|| w.primary_monitor().ok().flatten())
}

fn show(on: bool) {
    let Some(w) = ctx::app().get_webview_window(LABEL) else { return };
    let Ok(h) = w.hwnd() else { return };
    let h = HWND(h.0 as *mut _);
    unsafe {
        if on {
            let _ = SetWindowPos(h, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
        } else { let _ = ShowWindow(h, SW_HIDE); }
    }
}

fn worker(rx: std::sync::mpsc::Receiver<Ev>) {
    for e in rx {
        match e {
            Ev::Open(dir) => {
                let Some(w) = ctx::app().get_webview_window(LABEL) else { continue };
                let work = work_monitor();
                // как у Windows — на основном мониторе (или там, где активное окно — по настройке)
                let m = if cfg()["screen"] == "active" { work.clone() } else { w.primary_monitor().ok().flatten().or_else(|| work.clone()) };
                let here = if cfg()["monitor"] == "here" { work.as_ref().map(|m| (m.position().x, m.position().y, m.size().width as i32, m.size().height as i32)) } else { None };
                if let Some(m) = &m {
                    if let Ok(hw) = w.hwnd() { unsafe { let _ = SetWindowPos(HWND(hw.0 as *mut _), Some(HWND_TOPMOST), m.position().x, m.position().y, m.size().width as i32, m.size().height as i32, SWP_NOACTIVATE); } }
                }
                let list = windows_list(here);
                ctx::emit_to(LABEL, "at-open", json!({ "list": list, "dir": dir, "cfg": cfg() }));
                show(true);
            }
            Ev::Move(d) => ctx::emit_to(LABEL, "at-move", json!(d)),
            Ev::Up => ctx::emit_to(LABEL, "at-move", json!("up")),
            Ev::Down => ctx::emit_to(LABEL, "at-move", json!("down")),
            Ev::Commit | Ev::Cancel => {
                ctx::emit_to(LABEL, "at-commit", json!(matches!(e, Ev::Commit)));
                // страховка: страница не ответила за 1,5 с — прячем переключатель сами
                let seq = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
                std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(1500)); if PICKED.load(Ordering::Relaxed) < seq && !OPEN.load(Ordering::Relaxed) { show(false); } });
            }
        }
    }
}

pub fn start(app: &tauri::AppHandle) {
    // окно — заранее и скрытым: показ по Alt+Tab мгновенный
    let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("alttab.html".into())).additional_browser_args(crate::webview::ARGS)
        .title("Bar — окна").decorations(false).transparent(true).always_on_top(true).skip_taskbar(true).resizable(false)
        .shadow(false).focused(false).visible(false).disable_drag_drop_handler().build();
    if let Ok(w) = &w {
        crate::webview::attach(w);
        if let Ok(h) = w.hwnd() { unsafe {
            let h = HWND(h.0 as *mut _);
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
            SetWindowLongPtrW(h, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize);
        } }
    }
    let (tx, rx) = channel();
    let _ = TX.set(Mutex::new(tx));
    std::thread::spawn(move || worker(rx));
    std::thread::spawn(|| loop {
        let allow = compute_allow();
        ALLOW.store(allow, Ordering::Relaxed);
        // помощник с правами администратора: есть ли он, и передать ему «перехватывать ли»
        let h = helper_hwnd();
        HELPER_ON.store(h.is_some(), Ordering::Relaxed);
        if let Some(h) = h { unsafe { let _ = PostMessageW(Some(h), WM_AT_ALLOW, WPARAM(allow as usize), LPARAM(0)); } }
        std::thread::sleep(Duration::from_millis(200));
    });
    start_sink();
    if cfg()["admin"] == true { std::thread::spawn(|| run_helper_task()); }
    std::thread::spawn(|| unsafe {
        let inst = GetModuleHandleW(None).unwrap_or_default();
        let mut hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(kb), Some(inst.into()), 0).ok();
        // раз в 30 с — заново: если Windows сняла перехватчик (например, ПК подвис), он вернётся сам
        let _ = SetTimer(None, 0, 30_000, None);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_TIMER && msg.hwnd.is_invalid() {
                if !OPEN.load(Ordering::Relaxed) {
                    if let Some(h) = hook.take() { let _ = UnhookWindowsHookEx(h); }
                    hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(kb), Some(inst.into()), 0).ok();
                }
                continue;
            }
            let _ = TranslateMessage(&msg); DispatchMessageW(&msg);
        }
    });
}

pub fn handle(ch: &str, a: &[Value]) -> Value {
    let arg = |i: usize| a.get(i).cloned().unwrap_or(Value::Null);
    match ch {
        "at-get" => cfg(),
        "at-set" => {
            let before = cfg();
            let mut t = before.clone();
            if let Some(o) = arg(0).as_object() { for (k, v) in o { t[k] = v.clone(); } }
            ctx::sh().settings.put("alttab", t);
            let now = cfg();
            // окна администратора: включили — один раз создать задачу (Windows спросит разрешение) и запустить помощника
            if now["admin"] != before["admin"] {
                if now["admin"] == true {
                    std::thread::spawn(|| { if create_helper_task() { run_helper_task(); } else { let mut c = cfg(); c["admin"] = json!(false); ctx::sh().settings.put("alttab", c); } });
                } else if let Some(h) = helper_hwnd() { unsafe { let _ = PostMessageW(Some(h), WM_AT_QUIT, WPARAM(0), LPARAM(0)); } }
            }
            cfg()
        }
        // выбор сделан: окно — вперёд, переключатель прячется после своей анимации
        "at-ready" => { READY.store(true, Ordering::Relaxed); Value::Null }
        "at-pick" => {
            OPEN.store(false, Ordering::Relaxed);
            PICKED.store(SEQ.load(Ordering::Relaxed).max(PICKED.load(Ordering::Relaxed)), Ordering::Relaxed);
            // как Alt+Tab самой Windows — SwitchToThisWindow, без нажатий клавиш: «нажатый» Alt сбивал состояние Alt,
            // если его уже снова держали, и следующий Tab открывал Alt+Tab Windows
            let helper = helper_hwnd();
            if let Some(hp) = helper { unsafe { let _ = PostMessageW(Some(hp), WM_AT_CLOSED, WPARAM(0), LPARAM(0)); } }
            if let Some(h) = arg(0).as_i64().filter(|&h| h != 0) {
                // окно администратора (Steam, игра) выводит вперёд помощник — у него есть на это права
                match helper { Some(hp) => unsafe { let _ = PostMessageW(Some(hp), WM_AT_FOCUS, WPARAM(h as usize), LPARAM(0)); }, None => focus_window(h) }
            }
            std::thread::spawn(|| { std::thread::sleep(Duration::from_millis(170)); if !OPEN.load(Ordering::Relaxed) { show(false); } });
            Value::Null
        }
        "at-thumbs" => {
            let ids: Vec<String> = arg(0).as_array().map(|a| a.iter().filter_map(|x| x.as_i64()).take(24).map(|x| x.to_string()).collect()).unwrap_or_default();
            if ids.is_empty() { return json!({}); }
            let rows = ctx::sh().act.call_t("winthumbs", &format!("s:{}", ids.join(",")), 8000).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
            let mut o = serde_json::Map::new();
            for r in rows { if let Some((h, b)) = r.as_str().and_then(|x| x.split_once('|')) { if b.len() > 100 { o.insert(h.to_string(), json!(format!("data:image/jpeg;base64,{}", b))); } } }
            Value::Object(o)
        }
        "at-close" => { if let Some(h) = arg(0).as_i64() { let _ = ctx::sh().act.call_t("closewin", &h.to_string(), 3000); } Value::Null }
        _ => Value::Null,
    }
}

// ---------- вывести окно вперёд (как Alt+Tab самой Windows) ----------
fn focus_window(h: i64) {
    unsafe {
        let w = HWND(h as isize as *mut _);
        if IsIconic(w).as_bool() { let _ = ShowWindow(w, SW_RESTORE); }
        SwitchToThisWindow(w, true);
        if GetForegroundWindow() != w { let _ = SetForegroundWindow(w); }
    }
}

// ---------- окно-приёмник в основном Bar: события от помощника ----------
fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() }
fn find_msg_window(class: &str) -> Option<HWND> {
    let c = wide(class);
    unsafe { FindWindowExW(Some(HWND_MESSAGE), None, windows::core::PCWSTR(c.as_ptr()), windows::core::PCWSTR::null()).ok().filter(|h| !h.is_invalid()) }
}
fn helper_hwnd() -> Option<HWND> { find_msg_window("BarAltTabHelper") }
fn sink_hwnd() -> Option<HWND> { find_msg_window("BarAltTabSink") }
unsafe extern "system" fn sinkproc(h: HWND, m: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if m == WM_AT_EV {
        let v = lp.0 as i32;
        let e = match wp.0 { 0 => Ev::Open(v), 1 => Ev::Move(v), 2 => Ev::Up, 3 => Ev::Down, 4 => Ev::Commit, _ => Ev::Cancel };
        if let Some(t) = TX.get() { let _ = t.lock().unwrap().send(e); }
        return LRESULT(0);
    }
    DefWindowProcW(h, m, wp, lp)
}
fn start_sink() {
    std::thread::spawn(|| unsafe {
        let inst = GetModuleHandleW(None).unwrap_or_default();
        let cls = wide("BarAltTabSink");
        let wc = WNDCLASSW { lpfnWndProc: Some(sinkproc), hInstance: inst.into(), lpszClassName: windows::core::PCWSTR(cls.as_ptr()), ..Default::default() };
        RegisterClassW(&wc);
        let Ok(_h) = CreateWindowExW(WINDOW_EX_STYLE(0), windows::core::PCWSTR(cls.as_ptr()), windows::core::PCWSTR::null(), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, Some(inst.into()), None) else { return };
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() { DispatchMessageW(&msg); }
    });
}

// ---------- задача Планировщика: помощник с правами администратора без запроса при каждом запуске ----------
const TASK: &str = "Bar Alt+Tab";
/// создать задачу — Windows один раз спросит разрешение (UAC). true — создана
fn create_helper_task() -> bool {
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let params = format!("/Create /TN \"{TASK}\" /TR \"\\\"{exe}\\\" --alttab-helper\" /SC ONCE /ST 00:00 /RL HIGHEST /F");
    let (verb, file, par) = (wide("runas"), wide("schtasks.exe"), wide(&params));
    unsafe {
        let mut i = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32, fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: windows::core::PCWSTR(verb.as_ptr()), lpFile: windows::core::PCWSTR(file.as_ptr()), lpParameters: windows::core::PCWSTR(par.as_ptr()),
            nShow: SW_HIDE.0, ..Default::default()
        };
        if ShellExecuteExW(&mut i).is_err() || i.hProcess.is_invalid() { return false; } // отказались в окне Windows
        WaitForSingleObject(i.hProcess, 20_000);
        let mut code = 1u32;
        let _ = GetExitCodeProcess(i.hProcess, &mut code);
        let _ = windows::Win32::Foundation::CloseHandle(i.hProcess);
        code == 0
    }
}
/// запустить помощника (без запроса: задача уже с повышенными правами)
fn run_helper_task() {
    use std::os::windows::process::CommandExt;
    if helper_hwnd().is_some() { return; }
    let _ = std::process::Command::new("schtasks").args(["/Run", "/TN", TASK]).creation_flags(0x0800_0000).status();
}

// ---------- сам помощник (Bar.exe --alttab-helper, с правами администратора) ----------
unsafe extern "system" fn helperproc(h: HWND, m: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match m {
        WM_AT_ALLOW => { ALLOW.store(wp.0 != 0, Ordering::Relaxed); LRESULT(0) }
        WM_AT_FOCUS => { OPEN.store(false, Ordering::Relaxed); focus_window(wp.0 as i64); LRESULT(0) }
        WM_AT_CLOSED => { OPEN.store(false, Ordering::Relaxed); LRESULT(0) }
        WM_AT_QUIT => { PostQuitMessage(0); LRESULT(0) }
        _ => DefWindowProcW(h, m, wp, lp),
    }
}
/// ловит Alt+Tab везде (в том числе над окнами администратора) и передаёт основному Bar; закрывается вместе с ним
pub fn helper_main() {
    IS_HELPER.store(true, Ordering::Relaxed);
    unsafe {
        let inst = GetModuleHandleW(None).unwrap_or_default();
        let cls = wide("BarAltTabHelper");
        let wc = WNDCLASSW { lpfnWndProc: Some(helperproc), hInstance: inst.into(), lpszClassName: windows::core::PCWSTR(cls.as_ptr()), ..Default::default() };
        RegisterClassW(&wc);
        let Ok(h) = CreateWindowExW(WINDOW_EX_STYLE(0), windows::core::PCWSTR(cls.as_ptr()), windows::core::PCWSTR::null(), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, Some(inst.into()), None) else { return };
        // основной Bar — с обычными правами: разрешить его сообщения этому окну
        for m in [WM_AT_ALLOW, WM_AT_FOCUS, WM_AT_QUIT, WM_AT_CLOSED] { let _ = ChangeWindowMessageFilterEx(h, m, MSGFLT_ALLOW, None); }
        let mut hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(kb), Some(inst.into()), 0).ok();
        let _ = SetTimer(Some(h), 1, 250, None);
        let mut ticks = 0u32;
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_TIMER {
                ticks += 1;
                // основной Bar закрылся (выход, обновление) — закрыться тоже, иначе Bar.exe остался бы занят
                match sink_hwnd() { Some(s) => SINK.store(s.0 as isize, Ordering::Relaxed), None => if ticks > 8 { break } }
                // раз в 30 с — перехватчик заново (если Windows его сняла)
                if ticks % 120 == 0 && !OPEN.load(Ordering::Relaxed) {
                    if let Some(k) = hook.take() { let _ = UnhookWindowsHookEx(k); }
                    hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(kb), Some(inst.into()), 0).ok();
                }
                continue;
            }
            DispatchMessageW(&msg);
        }
        if let Some(k) = hook { let _ = UnhookWindowsHookEx(k); }
    }
}
