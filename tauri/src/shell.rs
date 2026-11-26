// Оболочка Windows: открыть файл / папку / ссылку, показать в папке, в корзину, сведения о файле, перетащить файл
// из Bar в другую программу, диалоги выбора файла и папки, контекстное меню, автозапуск, места Windows, питание.
use serde_json::{json, Value};
use std::path::Path;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::System::Com::*;
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::ctx;

pub fn hwnd_of(label: &str) -> HWND {
    use tauri::Manager;
    ctx::app().get_webview_window(label).and_then(|w| w.hwnd().ok()).map(|h| HWND(h.0 as *mut _)).unwrap_or_default()
}
fn exec(file: &str, params: &str) {
    unsafe { ShellExecuteW(None, &HSTRING::from("open"), &HSTRING::from(file), &HSTRING::from(params), PCWSTR::null(), SW_SHOWNORMAL); }
}
pub fn open_path(p: &str) { if !p.is_empty() { exec(p, ""); } }
pub fn show_in_folder(p: &str) { let _ = std::process::Command::new("explorer.exe").arg(format!("/select,{}", p)).spawn(); }
pub fn open_url(u: &str) { let l = u.to_lowercase(); if l.starts_with("https://") || l.starts_with("http://") { exec(u, ""); } }
pub fn explorer(arg: &str) { let _ = std::process::Command::new("explorer.exe").arg(arg).spawn(); }

/// в корзину (с возможностью восстановить)
pub fn trash(p: &str) -> bool {
    let w: Vec<u16> = p.encode_utf16().chain([0, 0]).collect();
    let mut op = SHFILEOPSTRUCTW { wFunc: FO_DELETE, pFrom: PCWSTR(w.as_ptr()), fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI).0 as u16, ..Default::default() };
    unsafe { SHFileOperationW(&mut op) == 0 && !op.fAnyOperationsAborted.as_bool() }
}
pub fn file_info(p: &str) -> Value {
    let Ok(m) = std::fs::metadata(p) else { return json!({ "ok": false }) };
    let icon = ctx::sh().act.call_t("fileicon", p, 6000).ok().and_then(|v| v.as_str().map(|s| format!("data:image/png;base64,{}", s))).filter(|s| s.len() > 40).unwrap_or_default();
    json!({ "ok": true, "size": m.len(), "isDir": m.is_dir(), "icon": icon })
}

// ---------- перетащить файл из Bar в другую программу (как обычное перетаскивание из Проводника) ----------
pub fn start_drag(p: String) {
    if !Path::new(&p).exists() { return; }
    let _ = ctx::app().run_on_main_thread(move || unsafe {
        let _ = windows::Win32::System::Ole::OleInitialize(None);
        let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(p.as_str()), None) else { return };
        let Ok(data) = item.BindToHandler::<_, IDataObject>(None, &BHID_DataObject) else { return };
        let _ = SHDoDragDrop(Some(hwnd_of("main")), &data, None, windows::Win32::System::Ole::DROPEFFECT_COPY | windows::Win32::System::Ole::DROPEFFECT_LINK);
    });
}

// ---------- диалоги выбора: свой поток со своим однопоточным COM ----------
fn pick(folder: bool, title: &str, owner: HWND) -> Option<String> {
    let t = title.to_string();
    let owner = owner.0 as isize;
    std::thread::spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let d: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        let mut o = d.GetOptions().ok()?;
        o |= FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST;
        if folder { o |= FOS_PICKFOLDERS; } else { o |= FOS_FILEMUSTEXIST | FOS_NODEREFERENCELINKS; }
        let _ = d.SetOptions(o);
        let _ = d.SetTitle(&HSTRING::from(t.as_str()));
        if !folder {
            let (n1, s1) = (HSTRING::from("Программы"), HSTRING::from("*.exe;*.lnk;*.bat;*.cmd"));
            let spec = [windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC { pszName: PCWSTR(n1.as_ptr()), pszSpec: PCWSTR(s1.as_ptr()) }];
            let _ = d.SetFileTypes(&spec);
        }
        d.Show(Some(HWND(owner as *mut _))).ok()?;
        let r = d.GetResult().ok()?;
        let p = r.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }).join().ok().flatten()
}
pub fn pick_exe(owner: &str) -> Value { pick(false, "Программа для таскбара", hwnd_of(owner)).map(Value::from).unwrap_or(Value::Null) }
pub fn pick_folder(owner: &str) -> Value { pick(true, "Папка для таскбара", hwnd_of(owner)).map(Value::from).unwrap_or(Value::Null) }

// ---------- контекстное меню у курсора: [{ id, label, enabled, checked, sep }] → id выбранного или null ----------
pub fn popup_menu(owner: &str, items: &Value) -> Value {
    let items = items.as_array().cloned().unwrap_or_default();
    let owner = hwnd_of(owner).0 as isize;
    let (tx, rx) = std::sync::mpsc::channel();
    let its = items.clone();
    let _ = ctx::app().run_on_main_thread(move || unsafe {
        let Ok(m) = CreatePopupMenu() else { let _ = tx.send(0); return };
        for (i, it) in its.iter().enumerate() {
            if it["sep"].as_bool() == Some(true) { let _ = AppendMenuW(m, MF_SEPARATOR, 0, PCWSTR::null()); continue; }
            let mut f = MF_STRING;
            if it["enabled"].as_bool() == Some(false) { f |= MF_GRAYED; }
            if it["checked"].as_bool() == Some(true) { f |= MF_CHECKED; }
            let _ = AppendMenuW(m, f, i + 1, &HSTRING::from(it["label"].as_str().unwrap_or("")));
        }
        let mut p = POINT::default();
        let _ = GetCursorPos(&mut p);
        let h = HWND(owner as *mut _);
        let _ = SetForegroundWindow(h);
        let r = TrackPopupMenu(m, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON, p.x, p.y, Some(0), h, None);
        let _ = DestroyMenu(m);
        let _ = tx.send(r.0 as usize);
    });
    match rx.recv() { Ok(n) if n > 0 => items.get(n - 1).map(|it| it["id"].clone()).unwrap_or(Value::Null), _ => Value::Null }
}

// ---------- автозапуск: та же запись, что у Electron-версии (HKCU\…\Run, «app.bar.notch» → путь к Bar.exe) ----------
const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_NAME: &str = "app.bar.notch";
fn exe() -> String { std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default() }
pub fn autostart() -> bool {
    use windows::Win32::System::Registry::*;
    unsafe {
        let mut n = 0u32;
        RegGetValueW(HKEY_CURRENT_USER, &HSTRING::from(RUN), &HSTRING::from(RUN_NAME), RRF_RT_REG_SZ, None, None, Some(&mut n)).is_ok()
    }
}
pub fn set_autostart(on: bool) {
    use windows::Win32::System::Registry::*;
    unsafe {
        let mut k = HKEY::default();
        if RegCreateKeyExW(HKEY_CURRENT_USER, &HSTRING::from(RUN), None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, None, &mut k, None).is_err() { return; }
        if on {
            let v: Vec<u16> = format!("\"{}\"", exe()).encode_utf16().chain(Some(0)).collect();
            let b = std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len() * 2);
            let _ = RegSetValueExW(k, &HSTRING::from(RUN_NAME), None, REG_SZ, Some(b));
        } else { let _ = RegDeleteValueW(k, &HSTRING::from(RUN_NAME)); }
        let _ = RegCloseKey(k);
    }
}

// ---------- диктофон ----------
pub fn save_voice(b64: &str) -> Value {
    let f = ctx::docs_dir("Voice").join(format!("memo-{}.webm", ctx::stamp()));
    if std::fs::write(&f, bar_agent::img::unb64(b64)).is_ok() { json!(f.to_string_lossy()) } else { Value::Null }
}
pub fn list_voice() -> Value {
    let dir = ctx::docs_dir("Voice");
    let mut v: Vec<(u64, Value)> = std::fs::read_dir(&dir).map(|r| r.filter_map(|e| e.ok()).filter_map(|e| {
        let n = e.file_name().to_string_lossy().to_string();
        if !n.ends_with(".webm") { return None; }
        let t = e.metadata().ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
        Some((t, json!({ "name": n, "path": e.path().to_string_lossy(), "mtime": t })))
    }).collect()).unwrap_or_default();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    json!(v.into_iter().take(30).map(|x| x.1).collect::<Vec<_>>())
}

// ---------- запуск программ, места Windows, питание ----------
pub fn app_launch(a: &Value) -> Value {
    let id = a["id"].as_str().unwrap_or("");
    if !id.is_empty() && !id.starts_with("exe:") { explorer(&format!("shell:AppsFolder\\{}", id)); }
    else if let Some(e) = a["exe"].as_str().filter(|e| !e.is_empty()) { open_path(e); }
    json!(true)
}
pub fn place(x: &Value) {
    match x["place"].as_str().unwrap_or("") {
        "recycle" => explorer("shell:RecycleBinFolder"), "downloads" => explorer("shell:Downloads"),
        "documents" => explorer("shell:Personal"), "pc" => explorer("shell:MyComputerFolder"),
        "settings" => exec("ms-settings:", ""), "taskmgr" => { let _ = std::process::Command::new("taskmgr.exe").spawn(); }
        _ => if let Some(p) = x["path"].as_str() { if Path::new(p).is_dir() { open_path(p); } },
    }
}
pub fn power(what: &str) {
    use std::os::windows::process::CommandExt;
    let a: &[&str] = match what { "shutdown" => &["/s", "/t", "0"], "restart" => &["/r", "/t", "0"], _ => return };
    let _ = std::process::Command::new("shutdown.exe").args(a).creation_flags(0x0800_0000).spawn();
}
pub fn lock() { unsafe { let _ = windows::Win32::System::Shutdown::LockWorkStation(); } }
