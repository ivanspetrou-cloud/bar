// Свой переключатель окон по Alt+Tab — в дизайне Bar (страница alttab.html).
// Клавиши перехватывает низкоуровневый хук клавиатуры (WH_KEYBOARD_LL): пока держите Alt, Tab / Shift+Tab / стрелки
// двигают выделение, Esc — отмена, отпустили Alt или Enter — открыть выбранное окно.
// Перехватывает всегда, когда включён (и в играх). Не перехватывает только над окнами администратора —
// Windows не даёт обычной программе видеть его клавиши; тогда открывается обычный Alt+Tab Windows.
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

fn send(e: Ev) { if let Some(t) = TX.get() { let _ = t.lock().unwrap().send(e); } }
fn key_down(vk: VIRTUAL_KEY) -> bool { unsafe { GetAsyncKeyState(vk.0 as i32) as u16 & 0x8000 != 0 } }

unsafe extern "system" fn kb(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
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
    std::thread::spawn(|| loop { ALLOW.store(compute_allow(), Ordering::Relaxed); std::thread::sleep(Duration::from_millis(200)); });
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
            let mut t = cfg();
            if let Some(o) = arg(0).as_object() { for (k, v) in o { t[k] = v.clone(); } }
            ctx::sh().settings.put("alttab", t);
            cfg()
        }
        // выбор сделан: окно — вперёд, переключатель прячется после своей анимации
        "at-ready" => { READY.store(true, Ordering::Relaxed); Value::Null }
        "at-pick" => {
            OPEN.store(false, Ordering::Relaxed);
            PICKED.store(SEQ.load(Ordering::Relaxed).max(PICKED.load(Ordering::Relaxed)), Ordering::Relaxed);
            // как Alt+Tab самой Windows — SwitchToThisWindow, без нажатий клавиш: «нажатый» Alt сбивал состояние Alt,
            // если его уже снова держали, и следующий Tab открывал Alt+Tab Windows
            if let Some(h) = arg(0).as_i64().filter(|&h| h != 0) { unsafe {
                let w = HWND(h as isize as *mut _);
                if IsIconic(w).as_bool() { let _ = ShowWindow(w, SW_RESTORE); }
                SwitchToThisWindow(w, true);
                if GetForegroundWindow() != w { let _ = SetForegroundWindow(w); }
            } }
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
