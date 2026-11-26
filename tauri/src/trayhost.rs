// Значки трея для дока («стрелочка» как у панели задач Windows).
// Bar — второй приёмник значков трея, как в RetroBar/ManagedShell: окно класса Shell_TrayWnd поверх остальных.
// Программы находят его (FindWindow) и присылают значки (Shell_NotifyIcon → WM_COPYDATA); Bar запоминает значок
// и сразу пересылает то же сообщение в настоящую панель задач Windows — там всё работает как раньше.
// Клик по значку в доке Bar передаёт программе так же, как это делает Windows (её сообщение обратного вызова).
// Работает только пока включены док и кнопка «Значки трея»; выключили — окно закрывается, остаётся только Windows.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::DataExchange::COPYDATASTRUCT;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;


/// название нашего окна — по нему Bar отличает себя от настоящей панели задач (win::explorer_tray)
pub const TITLE: &str = "BarTrayHost";

#[derive(Clone, Default)]
struct Icon { seq: u64, hwnd: u32, uid: u32, cbmsg: u32, ver: u32, tip: String, hicon: isize, png: String, hidden: bool, pid: u32 }
#[derive(Default)]
struct St { host: isize, icons: HashMap<String, Icon>, seq: u64, dirty: bool, fwd: u64, fwd_ok: u64, fwd_fail: u64, kinds: HashMap<String, u64> }
static S: Mutex<Option<St>> = Mutex::new(None);
fn with<R>(f: impl FnOnce(&mut St) -> R) -> R { f(S.lock().unwrap().get_or_insert_with(St::default)) }

fn u32_at(b: &[u8], o: usize) -> u32 { b.get(o..o + 4).map_or(0, |x| u32::from_le_bytes([x[0], x[1], x[2], x[3]])) }
fn wstr_at(b: &[u8], o: usize, chars: usize) -> String {
    let end = (o + chars * 2).min(b.len());
    if o >= end { return String::new(); }
    let u: Vec<u16> = b[o..end].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|&c| c != 0).collect();
    String::from_utf16_lossy(&u)
}

// NOTIFYICONDATA в сообщении трея (TRAYNOTIFYDATAW: подпись, команда, затем данные значка с 32-битными описателями)
const SIG: u32 = 0x34753423;
const NIF_MESSAGE: u32 = 1; const NIF_ICON: u32 = 2; const NIF_TIP: u32 = 4; const NIF_STATE: u32 = 8; const NIF_GUID: u32 = 0x20;
fn on_tray(b: &[u8]) {
    if u32_at(b, 0) != SIG { return; }
    let msg = u32_at(b, 4);
    let n = &b[8..];
    let (hwnd, uid, flags) = (u32_at(n, 4), u32_at(n, 8), u32_at(n, 12));
    let guid = if flags & NIF_GUID != 0 && n.len() >= 952 { Some(n[936..952].iter().map(|x| format!("{x:02x}")).collect::<String>()) } else { None };
    let key = guid.unwrap_or_else(|| format!("{hwnd:x}:{uid}"));
    with(|s| {
        match msg {
            0 | 1 => { // NIM_ADD, NIM_MODIFY
                s.seq += 1; let seq = s.seq;
                let ic = s.icons.entry(key).or_insert_with(|| Icon { seq, ..Default::default() });
                ic.hwnd = hwnd; ic.uid = uid;
                if flags & NIF_MESSAGE != 0 { ic.cbmsg = u32_at(n, 16); }
                if flags & NIF_TIP != 0 { ic.tip = wstr_at(n, 24, 128); }
                if flags & NIF_STATE != 0 { let (st, mask) = (u32_at(n, 280), u32_at(n, 284)); if mask & 1 != 0 { ic.hidden = st & 1 != 0; } }
                if flags & NIF_ICON != 0 {
                    let src = u32_at(n, 20) as isize;
                    // копия значка — программа может удалить свой в любой момент
                    let copy = if src != 0 { unsafe { CopyIcon(HICON(src as *mut _)) }.map(|h| h.0 as isize).unwrap_or(0) } else { 0 };
                    if ic.hicon != 0 { unsafe { let _ = DestroyIcon(HICON(ic.hicon as *mut _)); } }
                    ic.hicon = copy;
                    ic.png = if copy != 0 { bar_agent::img::png_hicon(HICON(copy as *mut _)).map(|p| bar_agent::img::b64(&p)).unwrap_or_default() } else { String::new() };
                }
                if ic.pid == 0 { let mut pid = 0u32; unsafe { GetWindowThreadProcessId(HWND(hwnd as isize as *mut _), Some(&mut pid)); } ic.pid = pid; }
            }
            2 => { if let Some(ic) = s.icons.remove(&key) { if ic.hicon != 0 { unsafe { let _ = DestroyIcon(HICON(ic.hicon as *mut _)); } } } } // NIM_DELETE
            4 => { if let Some(ic) = s.icons.get_mut(&key) { ic.ver = u32_at(n, 800); } } // NIM_SETVERSION
            _ => {}
        }
        s.dirty = true;
    });
}

fn explorer() -> HWND { HWND(bar_agent::win::explorer_tray() as *mut _) }

unsafe extern "system" fn wndproc(h: HWND, m: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match m {
        WM_COPYDATA => {
            let cds = &*(lp.0 as *const COPYDATASTRUCT);
            { let k = format!("copydata:{}:{}", cds.dwData, cds.cbData); with(|s| *s.kinds.entry(k).or_insert(0) += 1); }
            if cds.dwData == 1 && !cds.lpData.is_null() && cds.cbData >= 40 {
                let b = std::slice::from_raw_parts(cds.lpData as *const u8, cds.cbData as usize);
                let _ = std::panic::catch_unwind(|| on_tray(b));
                // учёт: дошло ли сообщение значка до панели задач Windows (для проверки)
                let r = forward(m, wp, lp);
                with(|s| { s.fwd += 1; if r.0 != 0 { s.fwd_ok += 1; } else { s.fwd_fail += 1; } });
                return r;
            }
            forward(m, wp, lp)
        }
        WM_TIMER => { keep_on_top(h); prune(); LRESULT(0) }
        WM_CLOSE => { let _ = DestroyWindow(h); LRESULT(0) }
        WM_DESTROY => { PostQuitMessage(0); LRESULT(0) }
        // остальное, что программы шлют панели задач, — ей и передаём
        _ if m >= WM_USER || m == WM_COMMAND => { with(|s| *s.kinds.entry(format!("msg:{m:x}")).or_insert(0) += 1); forward(m, wp, lp) }
        _ => DefWindowProcW(h, m, wp, lp),
    }
}
unsafe fn forward(m: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let ex = explorer();
    if ex.is_invalid() { return LRESULT(0); }
    let mut r = 0usize;
    let _ = SendMessageTimeoutW(ex, m, wp, lp, SMTO_ABORTIFHUNG, 3000, Some(&mut r));
    LRESULT(r as isize)
}
// FindWindow находит верхнее окно этого класса — держимся над панелью задач Windows и там же, где она (для GetWindowRect)
unsafe fn keep_on_top(h: HWND) {
    let ex = explorer();
    let mut rc = windows::Win32::Foundation::RECT::default();
    if !ex.is_invalid() { let _ = GetWindowRect(ex, &mut rc); }
    let _ = SetWindowPos(h, Some(HWND_TOPMOST), rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top, SWP_NOACTIVATE | SWP_HIDEWINDOW);
}
// значки закрытых программ
fn prune() {
    with(|s| {
        let dead: Vec<String> = s.icons.iter().filter(|(_, i)| !unsafe { IsWindow(Some(HWND(i.hwnd as isize as *mut _))) }.as_bool()).map(|(k, _)| k.clone()).collect();
        for k in dead { if let Some(i) = s.icons.remove(&k) { if i.hicon != 0 { unsafe { let _ = DestroyIcon(HICON(i.hicon as *mut _)); } } } s.dirty = true; }
    });
}

pub fn debug() -> Value { with(|s| json!({ "host": s.host, "icons": s.icons.len(), "fwd": s.fwd, "ok": s.fwd_ok, "fail": s.fwd_fail, "explorer": bar_agent::win::explorer_tray(), "kinds": s.kinds, "list": s.icons.values().map(|i| json!({ "tip": i.tip.chars().take(30).collect::<String>(), "hwnd": i.hwnd, "uid": i.uid, "cb": i.cbmsg, "ver": i.ver, "pid": i.pid })).collect::<Vec<_>>() })) }
pub fn running() -> bool { with(|s| s.host != 0) }

/// включить/выключить приёмник (док включён и кнопка «Значки трея» есть)
pub fn set(on: bool) {
    if on == running() { return; }
    if !on {
        let h = with(|s| { let h = s.host; s.host = 0; for (_, i) in s.icons.drain() { if i.hicon != 0 { unsafe { let _ = DestroyIcon(HICON(i.hicon as *mut _)); } } } h });
        unsafe { let _ = PostMessageW(Some(HWND(h as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0)); }
        push();
        return;
    }
    std::thread::spawn(|| unsafe {
        let inst = GetModuleHandleW(None).unwrap_or_default();
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: inst.into(), lpszClassName: w!("Shell_TrayWnd"), ..Default::default() };
        RegisterClassW(&wc);
        let title: Vec<u16> = TITLE.encode_utf16().chain(Some(0)).collect();
        let Ok(h) = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE, w!("Shell_TrayWnd"), PCWSTR(title.as_ptr()), WS_POPUP, 0, 0, 0, 0, None, None, Some(inst.into()), None) else { return };
        with(|s| s.host = h.0 as isize);
        keep_on_top(h);
        let _ = SetTimer(Some(h), 1, 1000, None);
        // все программы заново присылают свои значки (так делает и сама панель задач после перезапуска Проводника)
        let tc = RegisterWindowMessageW(w!("TaskbarCreated"));
        let _ = PostMessageW(Some(HWND_BROADCAST), tc, WPARAM(0), LPARAM(0));
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() { let _ = TranslateMessage(&msg); DispatchMessageW(&msg); }
    });
    // изменения значков — в док, не чаще 4 раз в секунду
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(250));
        if !running() { break; }
        if with(|s| std::mem::take(&mut s.dirty)) { push(); }
    });
}

pub fn list() -> Value {
    with(|s| {
        let mut v: Vec<&Icon> = s.icons.values().filter(|i| !i.hidden && !i.png.is_empty() && i.pid != std::process::id()).collect();
        v.sort_by_key(|i| i.seq);
        json!(v.iter().map(|i| json!({ "key": format!("{:x}:{}", i.hwnd, i.uid), "tip": i.tip, "png": i.png, "pid": i.pid })).collect::<Vec<_>>())
    })
}
fn push() { crate::taskbar::emit_docks("tb-tray", list()); }

/// клик по значку в доке → сообщение обратного вызова программы, как от панели задач Windows
pub fn click(key: &str, kind: &str) {
    let Some(ic) = with(|s| s.icons.values().find(|i| format!("{:x}:{}", i.hwnd, i.uid) == key).cloned()) else { return };
    if ic.cbmsg == 0 { return; }
    bar_agent::win::allow_foreground();
    unsafe { let _ = AllowSetForegroundWindow(ic.pid); }
    let mut p = POINT::default();
    unsafe { let _ = GetCursorPos(&mut p); }
    let h = HWND(ic.hwnd as isize as *mut _);
    let xy = ((p.y as u32 & 0xffff) << 16) | (p.x as u32 & 0xffff);
    // старый формат: wParam — номер значка, lParam — сообщение мыши; новый (версия 4): wParam — точка, lParam — сообщение | номер << 16
    let old = |m: u32| unsafe { let _ = PostMessageW(Some(h), ic.cbmsg, WPARAM(ic.uid as usize), LPARAM(m as isize)); };
    let new = |m: u32| unsafe { let _ = PostMessageW(Some(h), ic.cbmsg, WPARAM(xy as usize), LPARAM(((ic.uid << 16) | (m & 0xffff)) as isize)); };
    // версию программа сообщает один раз; если Bar это пропустил (ver = 0), шлём оба формата:
    // каждая программа понимает свой и не замечает чужой (неизвестное сообщение)
    let (v4, unknown) = (ic.ver >= 4, ic.ver == 0);
    let mouse = |m: u32| if v4 { new(m) } else { old(m) };
    match kind {
        "right" => { mouse(WM_RBUTTONDOWN); mouse(WM_RBUTTONUP); if v4 || unknown { new(WM_CONTEXTMENU); } }
        "double" => { mouse(WM_LBUTTONDBLCLK); mouse(WM_LBUTTONUP); } // два одиночных клика уже пришли перед этим
        _ => { mouse(WM_LBUTTONDOWN); mouse(WM_LBUTTONUP); if v4 || unknown { new(0x400 /* NIN_SELECT */); } }
    }
}

// ---------- «просит внимания»: программа мигает своей кнопкой на панели задач (так Slack и другие сообщают о новом сообщении) ----------
// Перехват оболочки Windows (RegisterShellHookWindow): мигание окна — точка на значке в доке, пока окно не откроют.
static FLASH: Mutex<Vec<i64>> = Mutex::new(Vec::new());
static SHELLHOOK_MSG: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
unsafe extern "system" fn hookproc(h: HWND, m: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if m != 0 && m == SHELLHOOK_MSG.load(std::sync::atomic::Ordering::Relaxed) {
        let code = wp.0 as u32;
        let w = lp.0 as i64;
        let changed = {
            let mut f = FLASH.lock().unwrap();
            match code {
                0x8006 => { if !f.contains(&w) { f.push(w); true } else { false } } // HSHELL_FLASH
                4 | 0x8004 | 2 => { let n = f.len(); f.retain(|&x| x != w); n != f.len() } // окно открыли / закрыли
                _ => false,
            }
        };
        if changed { crate::taskbar::emit_docks("tb-flash", flashing()); }
        return LRESULT(0);
    }
    DefWindowProcW(h, m, wp, lp)
}
pub fn flashing() -> Value { json!(*FLASH.lock().unwrap()) }
/// снять «просит внимания» (клик по значку в доке)
pub fn unflash(hwnds: &[i64]) { let mut f = FLASH.lock().unwrap(); f.retain(|x| !hwnds.contains(x)); }
pub fn start_shellhook() {
    std::thread::spawn(|| unsafe {
        let inst = GetModuleHandleW(None).unwrap_or_default();
        let wc = WNDCLASSW { lpfnWndProc: Some(hookproc), hInstance: inst.into(), lpszClassName: w!("BarShellHook"), ..Default::default() };
        RegisterClassW(&wc);
        let Ok(h) = CreateWindowExW(WS_EX_TOOLWINDOW, w!("BarShellHook"), w!(""), WS_POPUP, 0, 0, 0, 0, None, None, Some(inst.into()), None) else { return };
        SHELLHOOK_MSG.store(RegisterWindowMessageW(w!("SHELLHOOK")), std::sync::atomic::Ordering::Relaxed);
        let _ = RegisterShellHookWindow(h);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() { let _ = TranslateMessage(&msg); DispatchMessageW(&msg); }
    });
}
