// Bar: нативный агент Windows на Rust — замена PowerShell-агента (src/agent.ps1) для частых запросов.
// Протокол тот же: на вход строки «id команда аргумент», на выход по строке JSON {"id","ok","data"}.
// Первая строка — {"id":0,"ok":true,"data":"ready","cmds":[…]}: Bar узнаёт, какие команды здесь есть,
// остальные по-прежнему выполняет PowerShell. Только чтение состояния и те же действия, что и раньше (громкость, плеер).
#![windows_subsystem = "windows"] // без консоли и conhost: stdin/stdout — каналы от Bar

mod events;
mod hid;
mod img;
mod sys;
mod win;

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::time::{Duration, Instant};

use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eCapture, eMultimedia, eRender, EDataFlow, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED};
use windows::Win32::System::SystemInformation::GetSystemTimeAsFileTime;

const CMDS: &[&str] = &[
    "audio", "waitaudio", "setvol", "mute", "micmute", "layout", "layouts", "setlayout", "fg", "gamestate", "fgmax",
    "media", "mediactl", "gpu", "appicon", "fileicon", "winicon", "windows", "focus", "minimize", "hidepid", "showpid", "close",
    "bt", "net", "hidbat", "g435has", "g435", "hiddiag", "taskbar", "settaskbar", "hidetaskbar", "taskwins", "winthumbs",
    "monsizes", "exeinfo", "camlist", "camset", "closewin", "startmenu", "showdesktop", "appbar", "appbarnew", "appbaroff",
    "appxlogo", "usage", "hwinfo", "trim", "startapps", "findfiles",
];

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
            "playing": playing, "position": pos.round() as i64, "duration": dur.round() as i64,
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
    Some(format!("data:{};base64,{}", mime, img::b64(&buf)))
}
// иконки оболочки и «Пуск» надёжнее всего в однопоточном апартаменте — отдельный короткий поток
fn sta<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    std::thread::spawn(move || { unsafe { let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED); } f() }).join().ok()
}
fn num(arg: &str) -> i64 { arg.trim().parse().unwrap_or(0) }

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("meter") => { unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); } events::meter(); return; }
        Some("winevents") => { unsafe { let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED); } events::winevents(); return; }
        _ => {}
    }
    unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
    let bar_pid = std::env::var("BAR_PID").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut win = win::Win::new(bar_pid);
    let mut media = Media { mgr: None, art_key: String::new(), art: None, art_at: None };
    let (mut hid, mut net, mut gpu, mut wmi, mut search) = (hid::Hid::new(), sys::Net::new(), sys::Gpu::new(), sys::Wmi::new(), sys::Search::new());
    let out = std::io::stdout();
    let send = |v: Value| { let mut o = out.lock(); let _ = writeln!(o, "{}", v); let _ = o.flush(); };
    send(json!({ "id": 0, "ok": true, "data": "ready", "cmds": CMDS }));
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let mut parts = line.splitn(3, ' ');
        let id = parts.next().unwrap_or("").to_string();
        let cmd = parts.next().unwrap_or("");
        let arg = parts.next().unwrap_or("").to_string();
        let a = arg.as_str();
        let icon = |p: String, size: i32| sta(move || img::shell_icon(&p, size)).flatten().map(|b| json!(img::b64(&b))).unwrap_or(json!(""));
        let res: Result<Value, String> = match cmd {
            "audio" => audio().map_err(|e| e.message()),
            "waitaudio" => Ok(wait_audio(a)),
            "setvol" => set_vol(a).map_err(|e| e.message()),
            "mute" => set_mute(eRender, a).map_err(|e| e.message()),
            "micmute" => set_mute(eCapture, a).map_err(|e| e.message()),
            "layout" => Ok(win.layout()),
            "layouts" => Ok(win.layouts()),
            "setlayout" => Ok(win.set_layout(a)),
            "fg" => Ok(win.fg()),
            "gamestate" => Ok(win.game_state()),
            "fgmax" => Ok(win.fg_max()),
            "media" => Ok(media.now_playing()),
            "mediactl" => Ok(media.ctl(a.trim())),
            "gpu" => Ok(gpu.usage()),
            "appicon" => Ok(icon(arg.clone(), 64)),
            "fileicon" => Ok(icon(arg.clone(), 96)), // иконка файла в высоком разрешении (как в Проводнике)
            "winicon" => Ok(win::win_icon(a)),
            "windows" => Ok(json!(win::windows())),
            "focus" => Ok(json!(win::focus(num(a)))),
            "minimize" => { win::minimize(num(a)); Ok(json!(true)) }
            "hidepid" => Ok(win.hide_pid(num(a) as u32)),
            "showpid" => Ok(win.show_pid(num(a) as u32)),
            "close" => win::close_pid(num(a) as u32).map(|b| json!(b)),
            "closewin" => Ok(json!(win::close_window(num(a)))),
            "startmenu" => { win::start_menu(); Ok(json!(true)) }
            "showdesktop" => { win::show_desktop(); Ok(json!(true)) }
            "taskwins" => Ok(win::task_windows()),
            "winthumbs" => Ok(win::win_thumbs(a)),
            "taskbar" => Ok(json!(win::tb_autohide())),
            "settaskbar" => { win::tb_set_autohide(a.trim() == "1"); Ok(json!(win::tb_autohide())) }
            "hidetaskbar" => Ok(json!(win::tb_hide(a.trim() == "1"))),
            "appbar" => Ok(win::appbar_set(a)),
            "appbarnew" => { win::appbar_new(a); Ok(json!(true)) }
            "appbaroff" => { win::appbar_off(num(a)); Ok(json!(true)) }
            "bt" => Ok(sys::bt()),
            "net" => Ok(net.state()),
            "hidbat" => Ok(json!(hid.read())),
            "g435has" => Ok(json!(hid::g435_present())),
            "g435" => Ok(json!(hid::g435_read())),
            "hiddiag" => Ok(json!(hid::diag())),
            "monsizes" => Ok(sys::monsizes()),
            "exeinfo" => Ok(sys::exeinfo(a)),
            "camlist" => Ok(sys::camlist()),
            "camset" => Ok(sys::camset(a)),
            "appxlogo" => Ok(sys::appxlogo(a)),
            "usage" => Ok(sys::usage()),
            "hwinfo" => Ok(sys::hwinfo(&mut wmi)),
            "trim" => Ok(sys::trim()),
            "startapps" => Ok(sta(sys::startapps).unwrap_or(json!([]))),
            "findfiles" => search.find(a),
            _ => Err(format!("unknown command {}", cmd)),
        };
        match res {
            Ok(v) => send(json!({ "id": id, "ok": true, "data": v })),
            Err(e) => send(json!({ "id": id, "ok": false, "data": e })),
        }
    }
}
