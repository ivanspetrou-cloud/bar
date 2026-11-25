// Отдельные режимы того же exe (вместо meter.ps1 и winevents.ps1):
//   bar-agent.exe meter      — «M <пик 0..1>» ~20 раз в секунду: максимум по всем активным устройствам вывода (живой эквалайзер)
//   bar-agent.exe winevents  — «E» при открытии/закрытии/смене активного/сворачивании/смене заголовка окна,
//                              «L» — активное окно поменяло размер или место, «T <окно> <jpeg base64>» — снимок в момент сворачивания.
// Только чтение: уровень звука и события окон. Bar закрыл канал — процесс завершается.
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::HWND;
use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
use windows::Win32::Media::Audio::{eRender, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetAncestor, GetForegroundWindow, GetMessageW, GA_ROOT, MSG};

use crate::img;

// Куда идут строки событий: по умолчанию — в stdout (отдельный bar-agent.exe, канал закрыт — выходим);
// Tauri-версия Bar подставляет свою функцию и получает события прямо в своём процессе.
type Sink = Box<dyn Fn(&str) + Send + Sync>;
static SINK: std::sync::OnceLock<Sink> = std::sync::OnceLock::new();
fn out(line: &str) {
    if let Some(f) = SINK.get() { f(line); return; }
    let mut o = std::io::stdout().lock();
    if writeln!(o, "{}", line).and_then(|_| o.flush()).is_err() { std::process::exit(0); }
}

fn meters() -> Vec<IAudioMeterInformation> {
    let mut res = Vec::new();
    unsafe {
        let Ok(en) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return res };
        let Ok(col) = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else { return res };
        for i in 0..col.GetCount().unwrap_or(0) {
            if let Ok(m) = col.Item(i).and_then(|d| d.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None)) { res.push(m); }
        }
    }
    res
}
pub fn meter() { meter_until(&std::sync::atomic::AtomicBool::new(false), &|l: &str| out(l)); }
/// уровень звука ~20 раз в секунду, пока stop не станет true (для Tauri-версии: f получает строки «M <пик>»)
pub fn meter_until(stop: &std::sync::atomic::AtomicBool, f: &dyn Fn(&str)) {
    let out = f;
    let mut ms: Vec<IAudioMeterInformation> = Vec::new();
    let mut at: Option<Instant> = None;
    while !stop.load(Ordering::Relaxed) {
        if at.map_or(true, |t| t.elapsed() > Duration::from_secs(3)) { ms = meters(); at = Some(Instant::now()); } // устройства могли сменить
        let best = ms.iter().filter_map(|m| unsafe { m.GetPeakValue().ok() }).fold(0f32, f32::max);
        let s = format!("{:.3}", best);
        out(&format!("M {}", s.trim_end_matches('0').trim_end_matches('.')));
        std::thread::sleep(Duration::from_millis(45));
    }
}

static LAST_L: AtomicU32 = AtomicU32::new(0);
static LAST_E: AtomicU32 = AtomicU32::new(0);
unsafe extern "system" fn on_event(_: HWINEVENTHOOK, ev: u32, h: HWND, id_obj: i32, id_child: i32, _: u32, _: u32) {
    if id_obj != 0 || id_child != 0 || h.is_invalid() { return; }
    unsafe {
        if ev != 3 && GetAncestor(h, GA_ROOT) != h { return; } // только окна верхнего уровня
        let now = GetTickCount();
        if ev == 0x800B { // размер / место — только у активного окна и не чаще ~3 раз в секунду
            if h != GetForegroundWindow() { return; }
            if now.wrapping_sub(LAST_L.load(Ordering::Relaxed)) < 300 { return; }
            LAST_L.store(now, Ordering::Relaxed);
            out("L"); return;
        }
        if ev == 0x16 { if let Some(j) = img::thumb(h, 720, 450, (200, 100)) { out(&format!("T {} {}", h.0 as isize, img::b64(&j))); } }
        if ev == 0x800C && now.wrapping_sub(LAST_E.load(Ordering::Relaxed)) < 400 { return; } // заголовки браузеров меняются часто
        LAST_E.store(now, Ordering::Relaxed);
        out("E");
    }
}
/// события окон в свою функцию (Tauri-версия); вызывать в отдельном потоке — он крутит очередь сообщений Windows
pub fn winevents_with(f: Sink) { let _ = SINK.set(f); winevents(); }
pub fn winevents() {
    unsafe {
        for (a, b) in [(0x0003, 0x0003), (0x0016, 0x0017), (0x8001, 0x8003), (0x800C, 0x800C), (0x800B, 0x800B)] {
            SetWinEventHook(a, b, None, Some(on_event), 0, 0, 2 /* WINEVENT_SKIPOWNPROCESS */);
        }
        let mut m = MSG::default();
        while GetMessageW(&mut m, None, 0, 0).0 > 0 { DispatchMessageW(&m); }
    }
}

// Занят ли звук прямо сейчас: что-то играет (пик на любом устройстве вывода за ~0,3 с) или какая-то программа
// пишет с микрофона (звонок, Discord, запись). Нужно, чтобы чтение заряда G435 (донгл на секунду прерывает звук)
// не происходило посреди музыки или разговора.
pub fn audio_busy() -> bool {
    use windows::Win32::Media::Audio::{eCapture, AudioSessionStateActive, IAudioSessionControl, IAudioSessionManager2};
    let ms = meters();
    for _ in 0..6 {
        if ms.iter().any(|m| unsafe { m.GetPeakValue().map_or(false, |p| p > 0.002) }) { return true; }
        std::thread::sleep(Duration::from_millis(50));
    }
    unsafe {
        let Ok(en) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return false };
        let Ok(col) = en.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) else { return false };
        for i in 0..col.GetCount().unwrap_or(0) {
            let Ok(sm) = col.Item(i).and_then(|d| d.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None)) else { continue };
            let Ok(se) = sm.GetSessionEnumerator() else { continue };
            for k in 0..se.GetCount().unwrap_or(0) {
                let st = se.GetSession(k).and_then(|s: IAudioSessionControl| s.GetState());
                if st.map_or(false, |s| s == AudioSessionStateActive) { return true; }
            }
        }
    }
    false
}
