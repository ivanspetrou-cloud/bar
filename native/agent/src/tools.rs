// Разовые действия, которые раньше делались отдельным запуском PowerShell:
// распознавание текста (Windows.Media.Ocr, без интернета), доступ к счётчику FPS для игр, уборка старого окна Edge.
use serde_json::{json, Value};

use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Globalization::Language;
use windows::Graphics::Imaging::BitmapDecoder;
use windows::Media::Ocr::OcrEngine;
use windows::Storage::{FileAccessMode, StorageFile};
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
use windows::Win32::NetworkManagement::NetManagement::{NetApiBufferFree, NetLocalGroupGetMembers, LOCALGROUP_MEMBERS_INFO_0};
use windows::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSidToSidW};
use windows::Win32::Security::{GetTokenInformation, LookupAccountSidW, TokenGroups, TokenUser, PSID, SID_NAME_USE, TOKEN_GROUPS, TOKEN_QUERY, TOKEN_USER};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, TerminateProcess, WaitForSingleObject, PROCESS_TERMINATE};
use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

use crate::img;
use crate::sys::Wmi;
use crate::win::wide;

type R<T> = windows::core::Result<T>;

// ---------- OCR: строки текста с картинки (файл PNG); язык — тег вроде «ru» или пусто (языки профиля) ----------
pub fn ocr(arg: &str) -> Result<Value, String> {
    let s = String::from_utf8_lossy(&img::unb64(arg)).to_string();
    let (path, lang) = s.split_once('|').unwrap_or((&s, ""));
    (|| -> R<Value> {
        let f = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))?.join()?;
        let st = f.OpenAsync(FileAccessMode::Read)?.join()?;
        let bmp = BitmapDecoder::CreateAsync(&st)?.join()?.GetSoftwareBitmapAsync()?.join()?;
        let eng = if lang.is_empty() { None } else { Language::CreateLanguage(&HSTRING::from(lang)).and_then(|l| OcrEngine::TryCreateFromLanguage(&l)).ok() };
        let eng = match eng { Some(e) => e, None => OcrEngine::TryCreateFromUserProfileLanguages()? };
        let r = eng.RecognizeAsync(&bmp)?.join()?;
        Ok(json!(r.Lines()?.into_iter().map(|l| l.Text().map(|t| t.to_string()).unwrap_or_default()).collect::<Vec<_>>()))
    })().map_err(|e| e.message())
}
// установленные языки распознавания: "тег|название"
pub fn ocr_langs() -> Value {
    json!(OcrEngine::AvailableRecognizerLanguages().map(|v| v.into_iter().map(|l| format!("{}|{}", l.LanguageTag().unwrap_or_default(), l.DisplayName().unwrap_or_default())).collect::<Vec<_>>()).unwrap_or_default())
}

// ---------- FPS: группа «Пользователи журналов производительности» (S-1-5-32-559) ----------
const PERF_LOG: &str = "S-1-5-32-559";
fn sid_str(p: PSID) -> String {
    unsafe {
        let mut s = PWSTR::null();
        if ConvertSidToStringSidW(p, &mut s).is_err() { return String::new(); }
        let r = s.to_string().unwrap_or_default();
        let _ = LocalFree(Some(HLOCAL(s.0 as *mut _)));
        r
    }
}
fn token_info(class: windows::Win32::Security::TOKEN_INFORMATION_CLASS) -> Option<Vec<u64>> {
    unsafe {
        let mut t = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut t).ok()?;
        let mut n = 0u32;
        let _ = GetTokenInformation(t, class, None, 0, &mut n);
        let mut buf = vec![0u64; (n as usize).div_ceil(8) + 1];
        let ok = GetTokenInformation(t, class, Some(buf.as_mut_ptr() as *mut _), n, &mut n).is_ok();
        let _ = CloseHandle(t);
        if ok { Some(buf) } else { None }
    }
}
fn account(p: PSID) -> Option<(String, String)> {
    unsafe {
        let (mut name, mut dom) = ([0u16; 256], [0u16; 256]);
        let (mut nn, mut dn) = (256u32, 256u32);
        let mut use_ = SID_NAME_USE(0);
        LookupAccountSidW(PCWSTR::null(), p, Some(PWSTR(name.as_mut_ptr())), &mut nn, Some(PWSTR(dom.as_mut_ptr())), &mut dn, &mut use_).ok()?;
        Some((String::from_utf16_lossy(&dom[..dn as usize]), String::from_utf16_lossy(&name[..nn as usize])))
    }
}
fn with_sid<T>(s: &str, f: impl FnOnce(PSID) -> T) -> Option<T> {
    unsafe {
        let w = wide(s);
        let mut p = PSID::default();
        ConvertStringSidToSidW(PCWSTR(w.as_ptr()), &mut p).ok()?;
        let r = f(p);
        let _ = LocalFree(Some(HLOCAL(p.0)));
        Some(r)
    }
}
fn user_sid() -> String {
    token_info(TokenUser).map(|b| unsafe { sid_str((*(b.as_ptr() as *const TOKEN_USER)).User.Sid) }).unwrap_or_default()
}
// "ok" — доступ уже работает; "relogin" — в группе, но нужен повторный вход; "no" — не в группе
pub fn fps_perm() -> Value {
    let in_token = token_info(TokenGroups).map_or(false, |b| unsafe {
        let g = &*(b.as_ptr() as *const TOKEN_GROUPS);
        std::slice::from_raw_parts(g.Groups.as_ptr(), g.GroupCount as usize).iter().any(|x| sid_str(x.Sid) == PERF_LOG)
    });
    if in_token { return json!("ok"); }
    let me = user_sid();
    let Some(Some((_, group))) = with_sid(PERF_LOG, account) else { return json!("no") };
    let listed = unsafe {
        let gw = wide(&group);
        let (mut buf, mut read, mut total) = (std::ptr::null_mut::<u8>(), 0u32, 0u32);
        let ok = NetLocalGroupGetMembers(PCWSTR::null(), PCWSTR(gw.as_ptr()), 0, &mut buf, u32::MAX, &mut read, &mut total, None) == 0;
        let r = ok && !buf.is_null() && std::slice::from_raw_parts(buf as *const LOCALGROUP_MEMBERS_INFO_0, read as usize).iter().any(|m| sid_str(m.lgrmi0_sid) == me);
        if !buf.is_null() { NetApiBufferFree(Some(buf as *const _)); }
        r
    };
    json!(if listed { "relogin" } else { "no" })
}
// Добавить текущую учётную запись в группу: Windows спросит подтверждение (UAC), команда — системная net.exe
pub fn fps_grant() -> Value {
    let me = user_sid();
    let (Some(Some((_, group))), Some(Some((dom, user)))) = (with_sid(PERF_LOG, account), with_sid(&me, account)) else { return json!("error") };
    let params = wide(&format!("localgroup \"{}\" \"{}\\{}\" /add", group, dom, user));
    let (verb, file) = (wide("runas"), wide("net.exe"));
    unsafe {
        let mut si = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32, fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: PCWSTR(verb.as_ptr()), lpFile: PCWSTR(file.as_ptr()), lpParameters: PCWSTR(params.as_ptr()), nShow: SW_HIDE.0, ..Default::default()
        };
        if ShellExecuteExW(&mut si).is_ok() && !si.hProcess.is_invalid() {
            WaitForSingleObject(si.hProcess, 120_000);
            let _ = CloseHandle(si.hProcess);
        }
    }
    fps_perm()
}

// ---------- закрыть Edge прежнего режима музыки (запущенный Bar с папкой профиля dir) ----------
pub fn kill_edge(w: &mut Wmi, arg: &str) -> Value {
    let dir = String::from_utf8_lossy(&img::unb64(arg)).to_lowercase();
    if dir.len() < 10 { return json!(0); }
    let mut n = 0;
    for p in w.query("ROOT\\CIMV2", "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='msedge.exe'", &["ProcessId", "CommandLine"]) {
        let cl = p.get("CommandLine").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        let pid = p.get("ProcessId").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        if pid == 0 || !cl.contains(&dir) { continue; }
        unsafe { if let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, pid) { if TerminateProcess(h, 1).is_ok() { n += 1; } let _ = CloseHandle(h); } }
    }
    json!(n)
}
