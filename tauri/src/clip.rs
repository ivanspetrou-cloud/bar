// Буфер обмена: история текста (зашифрована средствами Windows — DPAPI: прочитать файл может только ваша учётная запись),
// чтение/запись текста и картинок. Пароли из менеджеров паролей (KeePass, Bitwarden, 1Password) помечены служебными
// форматами Windows — их не сохраняет ни встроенная история Win+V, ни Bar.
// Старая история Electron-версии (clips.bin, ключ Chromium в «Local State») расшифровывается один раз и перешифровывается.
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};
use windows::Win32::System::DataExchange::*;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};

use crate::ctx;

const CF_UNICODETEXT: u32 = 13;
const CF_DIB: u32 = 8;
static CLIPS: Mutex<Vec<Value>> = Mutex::new(Vec::new());
static LAST: Mutex<String> = Mutex::new(String::new());

fn file() -> std::path::PathBuf { ctx::data_dir().join("clips.bin") }
fn owner() -> HWND { ctx::try_sh().and_then(|s| s.notch.win.hwnd().ok()).map(|h| HWND(h.0 as *mut _)).unwrap_or_default() }

// ---------- DPAPI ----------
fn dpapi(data: &[u8], protect: bool) -> Option<Vec<u8>> {
    unsafe {
        let inp = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        let ok = if protect { CryptProtectData(&inp, PCWSTR::null(), None, None, None, 0, &mut out) } else { CryptUnprotectData(&inp, None, None, None, None, 0, &mut out) };
        if ok.is_err() || out.pbData.is_null() { return None; }
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(out.pbData as *mut _)));
        Some(v)
    }
}
// Electron safeStorage: «v10» + 12 байт nonce + AES-256-GCM (ключ — os_crypt.encrypted_key из Local State, защищён DPAPI)
fn electron_decrypt(buf: &[u8]) -> Option<Vec<u8>> {
    if buf.len() < 3 + 12 + 16 || &buf[..3] != b"v10" { return None; }
    let ls: Value = serde_json::from_str(&std::fs::read_to_string(ctx::data_dir().join("Local State")).ok()?).ok()?;
    let k64 = ls["os_crypt"]["encrypted_key"].as_str()?;
    let k = bar_agent::img::unb64(k64);
    let key = dpapi(k.strip_prefix(b"DPAPI")?, false)?;
    crate::crypto::aes_gcm_decrypt(&key, &buf[3..15], &buf[15..buf.len() - 16], &buf[buf.len() - 16..])
}
pub fn load() {
    let Ok(raw) = std::fs::read(file()) else { return };
    let plain = if let Some(b) = raw.strip_prefix(b"BAR1") { dpapi(b, false) } else { electron_decrypt(&raw) };
    if let Some(v) = plain.and_then(|p| serde_json::from_slice::<Vec<Value>>(&p).ok()) {
        *CLIPS.lock().unwrap() = v;
        if !raw.starts_with(b"BAR1") { save(); } // перешифровать в новый формат
    }
}
fn save() {
    let data = serde_json::to_vec(&*CLIPS.lock().unwrap()).unwrap_or_default();
    if let Some(enc) = dpapi(&data, true) { let mut v = b"BAR1".to_vec(); v.extend(enc); let _ = std::fs::write(file(), v); }
}
pub fn list() -> Value { json!(*CLIPS.lock().unwrap()) }
pub fn set_list(v: &Value) { if let Some(a) = v.as_array() { *CLIPS.lock().unwrap() = a.iter().take(200).cloned().collect(); save(); } }

fn push(t: &str, silent: bool) {
    if t.trim().is_empty() { return; }
    let mut c = CLIPS.lock().unwrap();
    let pin = c.iter().find(|x| x["t"].as_str() == Some(t)).map_or(false, |x| x["pin"].as_bool().unwrap_or(false));
    let t: String = t.chars().take(20000).collect();
    c.retain(|x| x["t"].as_str() != Some(t.as_str()));
    c.insert(0, json!({ "t": t, "pin": pin, "at": ctx::now_ms() }));
    let mut rest = 0;
    c.retain(|x| x["pin"].as_bool().unwrap_or(false) || { rest += 1; rest <= 60 });
    let v = json!(*c);
    drop(c);
    save();
    if !silent { ctx::emit("clips", v); }
}

// ---------- системный буфер ----------
struct Open;
impl Open { fn new() -> Option<Open> { for _ in 0..10 { if unsafe { OpenClipboard(Some(owner())) }.is_ok() { return Some(Open); } std::thread::sleep(Duration::from_millis(20)); } None } }
impl Drop for Open { fn drop(&mut self) { unsafe { let _ = CloseClipboard(); } } }

pub fn read_text() -> String {
    unsafe {
        if IsClipboardFormatAvailable(CF_UNICODETEXT).is_err() { return String::new(); }
        let Some(_o) = Open::new() else { return String::new() };
        let Ok(h) = GetClipboardData(CF_UNICODETEXT) else { return String::new() };
        let g = HGLOBAL(h.0);
        let p = GlobalLock(g) as *const u16;
        if p.is_null() { return String::new(); }
        let n = GlobalSize(g) / 2;
        let s = std::slice::from_raw_parts(p, n);
        let len = s.iter().position(|&c| c == 0).unwrap_or(n);
        let t = String::from_utf16_lossy(&s[..len]);
        let _ = GlobalUnlock(g);
        t
    }
}
fn is_secret() -> bool {
    unsafe {
        let f = |n: PCWSTR| RegisterClipboardFormatW(n);
        if IsClipboardFormatAvailable(f(w!("ExcludeClipboardContentFromMonitorProcessing"))).is_ok() || IsClipboardFormatAvailable(f(w!("Clipboard Viewer Ignore"))).is_ok() { return true; }
        let can = f(w!("CanIncludeInClipboardHistory"));
        if IsClipboardFormatAvailable(can).is_ok() {
            let Some(_o) = Open::new() else { return false };
            if let Ok(h) = GetClipboardData(can) {
                let g = HGLOBAL(h.0);
                let p = GlobalLock(g) as *const u32;
                let v = if p.is_null() || GlobalSize(g) < 4 { 1 } else { *p };
                let _ = GlobalUnlock(g);
                return v == 0;
            }
        }
        false
    }
}
fn put(fmt: u32, bytes: &[u8]) -> bool {
    unsafe {
        let Ok(g) = GlobalAlloc(GMEM_MOVEABLE, bytes.len()) else { return false };
        let p = GlobalLock(g) as *mut u8;
        if p.is_null() { return false; }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        let _ = GlobalUnlock(g);
        SetClipboardData(fmt, Some(HANDLE(g.0))).is_ok()
    }
}
pub fn write_text(t: &str) {
    *LAST.lock().unwrap() = t.to_string();
    let w: Vec<u16> = t.encode_utf16().chain(Some(0)).collect();
    let bytes = unsafe { std::slice::from_raw_parts(w.as_ptr() as *const u8, w.len() * 2) };
    if let Some(_o) = Open::new() { unsafe { let _ = EmptyClipboard(); } put(CF_UNICODETEXT, bytes); }
    if ctx::try_sh().map_or(true, |s| s.settings.get("clipHistory").as_bool() != Some(false)) { push(t, false); }
}
/// картинка PNG в буфер: и как PNG (браузеры, мессенджеры), и как обычная картинка Windows (DIB — Paint, Office)
pub fn write_png(png: &[u8]) {
    let dib = (|| {
        let dec = png::Decoder::new(std::io::Cursor::new(png));
        let mut r = dec.read_info().ok()?;
        let mut buf = vec![0; r.output_buffer_size()?];
        let info = r.next_frame(&mut buf).ok()?;
        let (w, h) = (info.width as usize, info.height as usize);
        let ch = match info.color_type { png::ColorType::Rgba => 4, png::ColorType::Rgb => 3, _ => return None };
        if info.bit_depth != png::BitDepth::Eight { return None; }
        let mut out = Vec::with_capacity(40 + w * h * 4);
        out.extend((40u32).to_le_bytes()); out.extend((w as i32).to_le_bytes()); out.extend((h as i32).to_le_bytes());
        out.extend(1u16.to_le_bytes()); out.extend(32u16.to_le_bytes()); out.extend([0u8; 24]);
        for y in (0..h).rev() { for x in 0..w { let i = (y * w + x) * ch; out.extend([buf[i + 2], buf[i + 1], buf[i], if ch == 4 { buf[i + 3] } else { 255 }]); } }
        Some(out)
    })();
    if let Some(_o) = Open::new() {
        unsafe { let _ = EmptyClipboard(); }
        put(unsafe { RegisterClipboardFormatW(w!("PNG")) }, png);
        if let Some(d) = dib { put(CF_DIB, &d); }
    }
}

/// опрос буфера ~1,4 раза в секунду (только если номер содержимого изменился)
pub fn start() {
    load();
    let t = read_text();
    *LAST.lock().unwrap() = t.clone();
    let on = || ctx::try_sh().map_or(true, |s| s.settings.get("clipHistory").as_bool() != Some(false));
    if on() && !t.is_empty() && !is_secret() { push(&t, true); }
    std::thread::spawn(move || {
        let mut seq = unsafe { GetClipboardSequenceNumber() };
        loop {
            std::thread::sleep(Duration::from_millis(700));
            let s = unsafe { GetClipboardSequenceNumber() };
            if s == seq { continue; }
            seq = s;
            if !on() { continue; }
            let t = read_text();
            if t.is_empty() || *LAST.lock().unwrap() == t { continue; }
            *LAST.lock().unwrap() = t.clone();
            if is_secret() { continue; }
            push(&t, false);
        }
    });
}
