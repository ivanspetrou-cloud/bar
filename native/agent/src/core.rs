// Ядро агента: все команды Bar для Windows. Используется и отдельным bar-agent.exe (Electron-версия),
// и напрямую в процессе Tauri-версии. Только чтение состояния Windows и действия, которые Bar делал и раньше.
#![allow(clippy::all)]
use serde_json::{json, Value};
use crate::{hid, img, sys, tools, win};
use std::time::{Duration, Instant};

use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eCapture, eCommunications, eMultimedia, eRender, EDataFlow, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED};
use windows::Win32::System::SystemInformation::GetSystemTimeAsFileTime;

pub const CMDS: &[&str] = &[
    "audio", "waitaudio", "setvol", "mute", "micmute", "layout", "layouts", "setlayout", "fg", "gamestate", "fgmax",
    "media", "mediactl", "gpu", "appicon", "fileicon", "winicon", "windows", "focus", "minimize", "hidepid", "showpid", "close",
    "bt", "net", "hidbat", "g435has", "g435", "hiddiag", "taskbar", "settaskbar", "hidetaskbar", "taskwins", "winthumbs",
    "monsizes", "exeinfo", "camlist", "camset", "closewin", "startmenu", "showdesktop", "appbar", "appbarnew", "appbaroff",
    "appxlogo", "usage", "hwinfo", "trim", "startapps", "findfiles", "mediakey", "ocr", "ocrlangs", "fpsperm", "fpsgrant", "killedge", "mics", "wintheme", "audiobusy",
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
// микрофоны, которые выключает кнопка: выбранный (id устройства) или «как в Windows» — по умолчанию и для связи
fn mics(id: &str) -> Vec<IAudioEndpointVolume> {
    let mut res = Vec::new();
    unsafe {
        let Ok(en) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return res };
        if !id.is_empty() {
            let w: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
            if let Ok(v) = en.GetDevice(windows::core::PCWSTR(w.as_ptr())).and_then(|d| d.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)) { res.push(v); return res; }
        } // устройство отключили — как в Windows
        let mut seen: Vec<String> = Vec::new();
        for role in [eMultimedia, eCommunications] {
            let Ok(d) = en.GetDefaultAudioEndpoint(eCapture, role) else { continue };
            let did = d.GetId().ok().map(|p| { let s = p.to_string().unwrap_or_default(); windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _)); s }).unwrap_or_default();
            if seen.contains(&did) { continue; }
            seen.push(did);
            if let Ok(v) = d.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None) { res.push(v); }
        }
    }
    res
}
// выключен — если выключены все целевые микрофоны
fn mics_muted(l: &[IAudioEndpointVolume]) -> bool { !l.is_empty() && l.iter().all(|v| unsafe { v.GetMute().map_or(false, |b| b.as_bool()) }) }
fn audio(id: &str) -> R<Value> {
    let (volume, muted) = vol_of(&endpoint(eRender)?)?;
    let m = mics(id.trim());
    Ok(json!({ "volume": volume, "muted": muted, "mic": !m.is_empty(), "micMuted": mics_muted(&m) }))
}
// активные микрофоны: "id|имя|1 — по умолчанию|1 — для связи"
fn mic_list() -> Value {
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::DEVICE_STATE_ACTIVE;
    use windows::Win32::System::Com::STGM_READ;
    let mut out = Vec::new();
    unsafe {
        let Ok(en) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return json!(out) };
        let idof = |d: &windows::Win32::Media::Audio::IMMDevice| d.GetId().ok().map(|p| { let s = p.to_string().unwrap_or_default(); windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _)); s }).unwrap_or_default();
        let def1 = en.GetDefaultAudioEndpoint(eCapture, eMultimedia).map(|d| idof(&d)).unwrap_or_default();
        let def2 = en.GetDefaultAudioEndpoint(eCapture, eCommunications).map(|d| idof(&d)).unwrap_or_default();
        let Ok(col) = en.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) else { return json!(out) };
        for i in 0..col.GetCount().unwrap_or(0) {
            let Ok(d) = col.Item(i) else { continue };
            let id = idof(&d);
            let name = d.OpenPropertyStore(STGM_READ).and_then(|ps| ps.GetValue(&PKEY_Device_FriendlyName)).map(|v| v.to_string()).unwrap_or_default();
            out.push(format!("{}|{}|{}|{}", id, name, (id == def1) as i32, (id == def2) as i32));
        }
    }
    json!(out)
}
// ждать изменения громкости / звука / микрофона: 12 чтений в секунду, ответ — при изменении или по таймауту
fn wait_audio(arg: &str) -> Value {
    let parts: Vec<&str> = arg.split(' ').collect();
    let w: Vec<i64> = parts.iter().take(4).map(|x| x.parse().unwrap_or(0)).collect();
    let mic_id = parts.get(4).copied().unwrap_or("");
    let (vol, mute, mic, timeout) = (w.first().copied().unwrap_or(0), w.get(1).copied().unwrap_or(0), w.get(2).copied().unwrap_or(0), w.get(3).copied().unwrap_or(0));
    let start = Instant::now();
    let (mut o, mut i): (Option<IAudioEndpointVolume>, Vec<IAudioEndpointVolume>) = (None, Vec::new());
    let mut got: Option<Instant> = None;
    loop {
        let elapsed = start.elapsed().as_millis() as i64;
        if got.map_or(true, |g| g.elapsed() > Duration::from_secs(2)) { o = endpoint(eRender).ok(); i = mics(mic_id); got = Some(Instant::now()); } // устройство могли сменить
        match o.as_ref().map(vol_of) {
            Some(Ok((vp, m))) => {
                let (mi, mmi, has) = (m as i64, mics_muted(&i) as i64, !i.is_empty());
                if vp != vol || mi != mute || (has && mmi != mic) || elapsed >= timeout {
                    return json!(format!("{}|{}|{}|{}", vp, mi, has as i64, mmi));
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
// «1 [id]» — выключить микрофон(ы), «0 [id]» — включить
fn set_mic_mute(arg: &str) -> R<Value> {
    let (on, id) = arg.trim().split_once(' ').unwrap_or((arg.trim(), ""));
    let l = mics(id.trim());
    if l.is_empty() { return Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x80070490u32 as i32))); }
    for v in &l { unsafe { v.SetMute(on == "1", std::ptr::null())?; } }
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


/// Состояние агента: у каждой команды свой кэш (окно, где печатают; обложка; приёмники; сеть; WMI; поиск).
/// Объект живёт в одном потоке (COM): создать через Core::new() в том потоке, где он будет работать.
pub struct Core { win: win::Win, media: Media, hid: hid::Hid, net: sys::Net, gpu: sys::Gpu, wmi: sys::Wmi, search: sys::Search }
impl Core {
    /// bar_pid — процесс самого Bar (его окна не считаются «окном, где печатают»)
    pub fn new(bar_pid: u32) -> Self {
        unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
        Core { win: win::Win::new(bar_pid), media: Media { mgr: None, art_key: String::new(), art: None, art_at: None },
            hid: hid::Hid::new(), net: sys::Net::new(), gpu: sys::Gpu::new(), wmi: sys::Wmi::new(), search: sys::Search::new() }
    }
    pub fn exec(&mut self, cmd: &str, arg: &str) -> Result<Value, String> {
        let a = arg;
        let icon = |p: String, size: i32| sta(move || img::shell_icon(&p, size)).flatten().map(|b| json!(img::b64(&b))).unwrap_or(json!(""));
        match cmd {
            "audio" => audio(a).map_err(|e| e.message()),
            "waitaudio" => Ok(wait_audio(a)),
            "setvol" => set_vol(a).map_err(|e| e.message()),
            "mute" => set_mute(eRender, a).map_err(|e| e.message()),
            "micmute" => set_mic_mute(a).map_err(|e| e.message()),
            "mics" => Ok(mic_list()),
            "wintheme" => Ok(win::win_theme(a.trim())),
            "layout" => Ok(self.win.layout()),
            "layouts" => Ok(self.win.layouts()),
            "setlayout" => Ok(self.win.set_layout(a)),
            "fg" => Ok(self.win.fg()),
            "gamestate" => Ok(self.win.game_state()),
            "fgmax" => Ok(self.win.fg_max()),
            "media" => Ok(self.media.now_playing()),
            "mediactl" => Ok(self.media.ctl(a.trim())),
            "gpu" => Ok(self.gpu.usage()),
            "appicon" => Ok(icon(arg.to_string(), 64)),
            "fileicon" => Ok(icon(arg.to_string(), 96)), // иконка файла в высоком разрешении (как в Проводнике)
            "winicon" => Ok(win::win_icon(a)),
            "windows" => Ok(json!(win::windows())),
            "focus" => Ok(json!(win::focus(num(a)))),
            "minimize" => { win::minimize(num(a)); Ok(json!(true)) }
            "hidepid" => Ok(self.win.hide_pid(num(a) as u32)),
            "showpid" => Ok(self.win.show_pid(num(a) as u32)),
            "close" => win::close_pid(num(a) as u32).map(|b| json!(b)),
            "closewin" => Ok(json!(win::close_window(num(a)))),
            "startmenu" => { win::start_menu(); Ok(json!(true)) }
            "mediakey" => { win::media_key(num(a) as u8); Ok(json!(true)) }
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
            "net" => Ok(self.net.state()),
            "hidbat" => Ok(json!(self.hid.read())),
            "g435has" => Ok(json!(hid::g435_present())),
            "g435" => Ok(json!(hid::g435_read())),
            "audiobusy" => Ok(json!(crate::events::audio_busy())),
            "hiddiag" => Ok(json!(hid::diag())),
            "monsizes" => Ok(sys::monsizes()),
            "exeinfo" => Ok(sys::exeinfo(a)),
            "camlist" => Ok(sys::camlist()),
            "camset" => Ok(sys::camset(a)),
            "appxlogo" => Ok(sys::appxlogo(a)),
            "usage" => Ok(sys::usage()),
            "hwinfo" => Ok(sys::hwinfo(&mut self.wmi)),
            "trim" => Ok(sys::trim()),
            "startapps" => Ok(sta(sys::startapps).unwrap_or(json!([]))),
            "findfiles" => self.search.find(a),
            "ocr" => tools::ocr(a),
            "ocrlangs" => Ok(tools::ocr_langs()),
            "fpsperm" => Ok(tools::fps_perm()),
            "fpsgrant" => Ok(tools::fps_grant()),
            "killedge" => Ok(tools::kill_edge(&mut self.wmi, a)),
            _ => Err(format!("unknown command {}", cmd)),
        }
    }
}
