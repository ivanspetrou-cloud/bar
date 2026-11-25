// Bar: нативный агент Windows на Rust — замена PowerShell-агента (src/agent.ps1) для частых запросов.
// Протокол тот же: на вход строки «id команда аргумент», на выход по строке JSON {"id","ok","data"}.
// Первая строка — {"id":0,"ok":true,"data":"ready","cmds":[…]}: Bar узнаёт, какие команды здесь есть,
// остальные по-прежнему выполняет PowerShell. Только чтение состояния и те же действия, что и раньше (громкость, плеер).
#![windows_subsystem = "windows"] // без консоли и conhost: stdin/stdout — каналы от Bar

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::time::{Duration, Instant};

use windows::core::{HSTRING, PWSTR};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::Foundation::{CloseHandle, HWND, RECT};
use windows::Win32::Globalization::LCIDToLocaleName;
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eCapture, eMultimedia, eRender, EDataFlow, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::SystemInformation::GetSystemTimeAsFileTime;
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayout;
use windows::Win32::UI::Shell::SHQueryUserNotificationState;
use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsWindow, IsZoomed};

const CMDS: &[&str] = &["audio", "waitaudio", "setvol", "mute", "micmute", "layout", "fg", "gamestate", "fgmax", "media", "mediactl"];

type R<T> = windows::core::Result<T>;

// ---------- звук ----------
fn endpoint(flow: EDataFlow) -> R<IAudioEndpointVolume> {
    unsafe {
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let dev = en.GetDefaultAudioEndpoint(flow, eMultimedia)?;
        dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
    }
}
fn vol_of(e: &IAudioEndpointVolume) -> R<(i64, bool)> {
    unsafe { Ok(((e.GetMasterVolumeLevelScalar()? * 100.0).round() as i64, e.GetMute()?.as_bool())) }
}
fn audio() -> R<Value> {
    let (volume, muted) = vol_of(&endpoint(eRender)?)?;
    let mic = endpoint(eCapture).ok();
    let mic_muted = match &mic { Some(m) => unsafe { m.GetMute().map(|b| b.as_bool()).unwrap_or(false) }, None => false };
    Ok(json!({ "volume": volume, "muted": muted, "mic": mic.is_some(), "micMuted": mic_muted }))
}
// ждать изменения громкости / звука / микрофона: 12 чтений в секунду, ответ — при изменении или по таймауту
fn wait_audio(arg: &str) -> Value {
    let w: Vec<i64> = arg.split(' ').map(|x| x.parse().unwrap_or(0)).collect();
    let (vol, mute, mic, timeout) = (w.first().copied().unwrap_or(0), w.get(1).copied().unwrap_or(0), w.get(2).copied().unwrap_or(0), w.get(3).copied().unwrap_or(0));
    let start = Instant::now();
    let (mut o, mut i): (Option<IAudioEndpointVolume>, Option<IAudioEndpointVolume>) = (None, None);
    let mut got: Option<Instant> = None;
    loop {
        let elapsed = start.elapsed().as_millis() as i64;
        if got.map_or(true, |g| g.elapsed() > Duration::from_secs(2)) { o = endpoint(eRender).ok(); i = endpoint(eCapture).ok(); got = Some(Instant::now()); } // устройство могли сменить
        match o.as_ref().map(vol_of) {
            Some(Ok((vp, m))) => {
                let mm = i.as_ref().and_then(|x| unsafe { x.GetMute().ok() }).map_or(false, |b| b.as_bool());
                let (mi, mmi) = (m as i64, mm as i64);
                if vp != vol || mi != mute || (i.is_some() && mmi != mic) || elapsed >= timeout {
                    return json!(format!("{}|{}|{}|{}", vp, mi, i.is_some() as i64, mmi));
                }
            }
            _ => { got = None; if elapsed >= timeout { return json!(""); } }
        }
        std::thread::sleep(Duration::from_millis(80));
    }
}
fn set_vol(arg: &str) -> R<Value> {
    let v = (arg.trim().parse::<f32>().unwrap_or(0.0) / 100.0).clamp(0.0, 1.0);
    unsafe { endpoint(eRender)?.SetMasterVolumeLevelScalar(v, std::ptr::null())?; }
    Ok(json!(true))
}
fn set_mute(flow: EDataFlow, arg: &str) -> R<Value> {
    unsafe { endpoint(flow)?.SetMute(arg.trim() == "1", std::ptr::null())?; }
    Ok(json!(true))
}

// ---------- окна ----------
struct Win { last_fg: HWND, bar_pid: u32, me: u32 }
fn pid_of(h: HWND) -> (u32, u32) { let mut pid = 0u32; let tid = unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) }; (tid, pid) }
impl Win {
    // окно, где работает пользователь (не Bar): Bar сам на переднем плане — берём последнее чужое
    fn target(&mut self) -> HWND {
        let fg = unsafe { GetForegroundWindow() };
        let (_, pid) = pid_of(fg);
        if !fg.is_invalid() && pid != self.bar_pid && pid != self.me { self.last_fg = fg; }
        if !self.last_fg.is_invalid() && !unsafe { IsWindow(Some(self.last_fg)) }.as_bool() { self.last_fg = HWND::default(); }
        if !self.last_fg.is_invalid() { self.last_fg } else { fg }
    }
    fn layout(&mut self) -> Value {
        let (tid, _) = pid_of(self.target());
        let hkl = unsafe { GetKeyboardLayout(tid) };
        let lcid = (hkl.0 as usize & 0xFFFF) as u32;
        let mut buf = [0u16; 85];
        let n = unsafe { LCIDToLocaleName(lcid, Some(&mut buf), 0) };
        json!(if n > 1 { String::from_utf16_lossy(&buf[..(n - 1) as usize]) } else { String::new() })
    }
    fn fg(&mut self) -> Value { let (_, pid) = pid_of(self.target()); json!(exe_path(pid)) }
    fn fg_max(&mut self) -> Value {
        let h = self.target();
        if h.is_invalid() || !unsafe { IsZoomed(h) }.as_bool() { return json!(""); }
        match monitor(h) { Some(m) => json!(format!("{},{},{},{}", m.left, m.top, m.right, m.bottom)), None => json!("") }
    }
    // "полноэкранное(1/0)|состояние уведомлений|exe|pid|монитор x,y,w,h"
    fn game_state(&mut self) -> Value {
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
}
fn monitor(h: HWND) -> Option<RECT> {
    let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if unsafe { GetMonitorInfoW(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), &mut mi) }.as_bool() { Some(mi.rcMonitor) } else { None }
}
fn exe_path(pid: u32) -> String {
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 1024];
        let mut n = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut n).is_ok();
        let _ = CloseHandle(h);
        if ok { String::from_utf16_lossy(&buf[..n as usize]) } else { String::new() }
    }
}

// ---------- музыка: системный медиаплеер Windows (SMTC) ----------
struct Media { mgr: Option<SessionManager>, art_key: String, art: Option<String>, art_at: Option<Instant> }
impl Media {
    fn session(&mut self) -> R<windows::Media::Control::GlobalSystemMediaTransportControlsSession> {
        if self.mgr.is_none() { self.mgr = Some(SessionManager::RequestAsync()?.join()?); }
        self.mgr.as_ref().unwrap().GetCurrentSession()
    }
    fn now_playing(&mut self) -> Value {
        let Ok(s) = self.session() else { return Value::Null };
        let Ok(p) = s.TryGetMediaPropertiesAsync().and_then(|a| a.join()) else { return Value::Null };
        let title = p.Title().unwrap_or_default().to_string();
        let artist = p.Artist().unwrap_or_default().to_string();
        let key = format!("{}|{}", title, artist);
        // браузер меняет обложку позже названия (а иногда сначала отдаёт старую): 12 с перечитываем, без обложки — до 40 с
        if key != self.art_key { self.art_key = key; self.art = None; self.art_at = Some(Instant::now()); }
        let age = self.art_at.map_or(1e9, |t| t.elapsed().as_secs_f64());
        if age < 12.0 || (self.art.is_none() && age < 40.0) {
            if let Some(a) = read_art(&p) { self.art = Some(a); }
        }
        let playing = s.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()).map_or(false, |st| st == PlaybackStatus::Playing);
        let (mut pos, mut dur, mut upd) = (0.0f64, 0.0f64, 0i64);
        if let Ok(tl) = s.GetTimelineProperties() {
            pos = tl.Position().map_or(0, |t| t.Duration) as f64 / 1e7;
            dur = tl.EndTime().map_or(0, |t| t.Duration) as f64 / 1e7;
            upd = tl.LastUpdatedTime().map_or(0, |t| t.UniversalTime);
        }
        // браузеры сообщают позицию только при паузе/перемотке — прибавляем время, прошедшее с того сообщения
        if playing && upd > 125_911_584_000_000_000 {
            let ft = unsafe { GetSystemTimeAsFileTime() };
            let now = ((ft.dwHighDateTime as i64) << 32) | ft.dwLowDateTime as i64;
            pos += (now - upd) as f64 / 1e7;
            if dur > 0.0 && pos > dur { pos = dur; }
        }
        json!({
            "title": title, "artist": artist, "album": p.AlbumTitle().unwrap_or_default().to_string(),
            "app": s.SourceAppUserModelId().unwrap_or_default().to_string(),
            "playing": playing, "position": pos as i64, "duration": dur as i64,
            "art": self.art,
        })
    }
    fn ctl(&mut self, what: &str) -> Value {
        let Ok(s) = self.session() else { return json!(false) };
        let r = if let Some(sec) = what.strip_prefix("seek:") {
            s.TryChangePlaybackPositionAsync((sec.parse::<f64>().unwrap_or(0.0) * 1e7) as i64).and_then(|a| a.join())
        } else {
            match what { "toggle" => s.TryTogglePlayPauseAsync(), "next" => s.TrySkipNextAsync(), "prev" => s.TrySkipPreviousAsync(), _ => return json!(false) }
                .and_then(|a| a.join())
        };
        json!(r.unwrap_or(false))
    }
}
fn read_art(p: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) -> Option<String> {
    let thumb = p.Thumbnail().ok()?;
    let st = thumb.OpenReadAsync().ok()?.join().ok()?;
    let size = st.Size().ok()? as u32;
    if size == 0 || size > 3 * 1024 * 1024 { return None; }
    let rd = DataReader::CreateDataReader(&st).ok()?;
    rd.LoadAsync(size).ok()?.join().ok()?;
    let mut buf = vec![0u8; size as usize];
    rd.ReadBytes(&mut buf).ok()?;
    let mime = if buf[0] == 0x89 { "image/png" } else if buf[0] == 0xFF { "image/jpeg" } else { "image/png" };
    Some(format!("data:{};base64,{}", mime, b64(&buf)))
}
fn b64(d: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(d.len().div_ceil(3) * 4);
    for c in d.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}

fn main() {
    unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
    let bar_pid = std::env::var("BAR_PID").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut win = Win { last_fg: HWND::default(), bar_pid, me: std::process::id() };
    let mut media = Media { mgr: None, art_key: String::new(), art: None, art_at: None };
    let out = std::io::stdout();
    let send = |v: Value| { let mut o = out.lock(); let _ = writeln!(o, "{}", v); let _ = o.flush(); };
    send(json!({ "id": 0, "ok": true, "data": "ready", "cmds": CMDS }));
    let _ = HSTRING::new();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let mut parts = line.splitn(3, ' ');
        let id = parts.next().unwrap_or("").to_string();
        let cmd = parts.next().unwrap_or("");
        let arg = parts.next().unwrap_or("");
        let res: R<Value> = match cmd {
            "audio" => audio(),
            "waitaudio" => Ok(wait_audio(arg)),
            "setvol" => set_vol(arg),
            "mute" => set_mute(eRender, arg),
            "micmute" => set_mute(eCapture, arg),
            "layout" => Ok(win.layout()),
            "fg" => Ok(win.fg()),
            "gamestate" => Ok(win.game_state()),
            "fgmax" => Ok(win.fg_max()),
            "media" => Ok(media.now_playing()),
            "mediactl" => Ok(media.ctl(arg.trim())),
            _ => { send(json!({ "id": id, "ok": false, "data": "unsupported" })); continue; }
        };
        match res {
            Ok(v) => send(json!({ "id": id, "ok": true, "data": v })),
            Err(e) => send(json!({ "id": id, "ok": false, "data": e.message() })),
        }
    }
}
