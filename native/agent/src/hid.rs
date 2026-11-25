// Заряд устройств с собственными приёмниками (не Bluetooth): Razer, Corsair, SteelSeries Arctis, Compx, Logitech (HID++ и G435),
// Redragon (Areson), Ajazz и стандартный HID «Battery Strength». Только запросы на чтение, как в openrazer, OpenLinkHub,
// HeadsetControl и Solaar. Порт C#-кода из agent.ps1 один в один.
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Devices::DeviceAndDriverInstallation::*;
use windows::Win32::Devices::HumanInterfaceDevice::*;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Storage::FileSystem::{CreateFileW, ReadFile, WriteFile, FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_OVERLAPPED, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows::Win32::System::Threading::{CreateEventW, WaitForMultipleObjects, WaitForSingleObject};

use crate::win::wide;

const RW: u32 = 0xC000_0000;
fn sleep(ms: u64) { std::thread::sleep(Duration::from_millis(ms)) }

// ---------- открытие устройства и ввод-вывод с тайм-аутом ----------
struct Dev(HANDLE);
impl Drop for Dev { fn drop(&mut self) { unsafe { let _ = CloseHandle(self.0); } } }
fn open(p: &str, access: u32, overlapped: bool) -> Option<Dev> {
    let w = wide(p);
    let flags = if overlapped { FILE_FLAG_OVERLAPPED } else { FILE_FLAGS_AND_ATTRIBUTES(0) };
    unsafe { CreateFileW(PCWSTR(w.as_ptr()), access, FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING, flags, None) }.ok().filter(|h| !h.is_invalid()).map(Dev)
}
struct Io { ov: Box<OVERLAPPED>, buf: Vec<u8>, ev: HANDLE }
impl Io {
    fn new(len: usize) -> Option<Io> {
        let ev = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }.ok()?;
        let ov = Box::new(OVERLAPPED { hEvent: ev, ..Default::default() });
        Some(Io { ov, buf: vec![0; len], ev })
    }
}
impl Drop for Io { fn drop(&mut self) { unsafe { let _ = CloseHandle(self.ev); } } }
impl Dev {
    fn write(&self, data: &[u8]) -> bool {
        let Some(mut io) = Io::new(0) else { return false };
        unsafe {
            let r = WriteFile(self.0, Some(data), None, Some(&mut *io.ov));
            if r.is_err() && windows::core::Error::from_thread().code() != windows::Win32::Foundation::ERROR_IO_PENDING.to_hresult() { return false; }
            if WaitForSingleObject(io.ev, 1000) != WAIT_OBJECT_0 { let _ = CancelIoEx(self.0, Some(&*io.ov)); let mut n = 0; let _ = GetOverlappedResult(self.0, &*io.ov, &mut n, true); return false; }
            let mut n = 0u32;
            GetOverlappedResult(self.0, &*io.ov, &mut n, false).is_ok()
        }
    }
    // начать чтение; результат — через wait()
    fn start_read(&self, len: usize) -> Option<Io> {
        let mut io = Io::new(len)?;
        unsafe {
            let r = ReadFile(self.0, Some(&mut io.buf), None, Some(&mut *io.ov));
            if r.is_err() && windows::core::Error::from_thread().code() != windows::Win32::Foundation::ERROR_IO_PENDING.to_hresult() { return None; }
        }
        Some(io)
    }
    fn finish(&self, io: &Io) -> Option<usize> { let mut n = 0u32; unsafe { GetOverlappedResult(self.0, &*io.ov, &mut n, false) }.ok().map(|_| n as usize) }
    fn cancel(&self, io: &Io) { unsafe { let _ = CancelIoEx(self.0, Some(&*io.ov)); let mut n = 0; let _ = GetOverlappedResult(self.0, &*io.ov, &mut n, true); } }
    // прочитать один отчёт не дольше ms
    fn read(&self, len: usize, ms: u64) -> Option<Vec<u8>> {
        let io = self.start_read(len)?;
        if unsafe { WaitForSingleObject(io.ev, ms as u32) } != WAIT_OBJECT_0 { self.cancel(&io); return None; }
        self.finish(&io)?;
        Some(io.buf.clone())
    }
    fn get_feature(&self, b: &mut [u8]) -> bool { unsafe { HidD_GetFeature(self.0, b.as_mut_ptr() as *mut _, b.len() as u32) } }
    fn set_feature(&self, b: &[u8]) -> bool { unsafe { HidD_SetFeature(self.0, b.as_ptr() as *const _, b.len() as u32) } }
}
fn left(until: Instant) -> u64 { until.saturating_duration_since(Instant::now()).as_millis() as u64 }

// ---------- поиск интерфейсов ----------
fn paths(vid: &str) -> Vec<String> {
    let mut res = Vec::new();
    unsafe {
        let g = HidD_GetHidGuid();
        let Ok(set) = SetupDiGetClassDevsW(Some(&g), PCWSTR::null(), None, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE) else { return res };
        let mut d = SP_DEVICE_INTERFACE_DATA { cbSize: std::mem::size_of::<SP_DEVICE_INTERFACE_DATA>() as u32, ..Default::default() };
        let mut i = 0;
        while SetupDiEnumDeviceInterfaces(set, None, &g, i, &mut d).is_ok() {
            i += 1;
            let mut req = 0u32;
            let _ = SetupDiGetDeviceInterfaceDetailW(set, &d, None, 0, Some(&mut req), None);
            if req < 8 { continue; }
            let mut buf = vec![0u64; (req as usize).div_ceil(8)];
            let det = buf.as_mut_ptr() as *mut SP_DEVICE_INTERFACE_DETAIL_DATA_W;
            (*det).cbSize = 8;
            if SetupDiGetDeviceInterfaceDetailW(set, &d, Some(det), req, None, None).is_ok() {
                let p = (det as *const u8).add(4) as *const u16;
                let n = (0..).take_while(|&k| *p.add(k) != 0).count();
                let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, n));
                if s.to_lowercase().contains(&format!("vid_{}", vid)) { res.push(s); }
            }
        }
        let _ = SetupDiDestroyDeviceInfoList(set);
    }
    res
}
#[derive(Default, Clone, Copy)]
struct Caps { usage: u16, page: u16, inp: u16, out: u16, feat: u16 }
fn caps(p: &str) -> Option<(Caps, String)> {
    let h = open(p, 0, false)?;
    unsafe {
        let mut sb = [0u16; 256];
        let name = if HidD_GetProductString(h.0, sb.as_mut_ptr() as *mut _, 512) { let n = sb.iter().position(|&c| c == 0).unwrap_or(256); String::from_utf16_lossy(&sb[..n]) } else { String::new() };
        let mut pp = PHIDP_PREPARSED_DATA::default();
        if !HidD_GetPreparsedData(h.0, &mut pp) { return None; }
        let mut c = HIDP_CAPS::default();
        let _ = HidP_GetCaps(pp, &mut c);
        let _ = HidD_FreePreparsedData(pp);
        Some((Caps { usage: c.Usage, page: c.UsagePage, inp: c.InputReportByteLength, out: c.OutputReportByteLength, feat: c.FeatureReportByteLength }, name))
    }
}
// «vid_xxxx&pid_yyyy» → (vid, pid)
fn vid_pid(lp: &str) -> Option<(String, String)> {
    let i = lp.find("vid_")?;
    let v = lp.get(i + 4..i + 8)?;
    if lp.get(i + 8..i + 13)? != "&pid_" { return None; }
    let p = lp.get(i + 13..i + 17)?;
    if !v.chars().chain(p.chars()).all(|c| c.is_ascii_hexdigit()) { return None; }
    Some((v.to_string(), p.to_string()))
}
fn after(lp: &str, tag: &str) -> Option<String> { let i = lp.find(tag)?; let s = lp.get(i + tag.len()..i + tag.len() + 2)?; if s.chars().all(|c| c.is_ascii_hexdigit()) { Some(s.to_string()) } else { None } }

fn pretty(n: &str) -> String {
    let mut n = n.replace("Gaming Receiver", "").replace("Receiver", "").replace("Wireless", "").replace("Gaming", "").replace("RGB", "");
    n = n.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some(r) = n.strip_prefix("CORSAIR ") { n = format!("Corsair {}", r); }
    n
}
fn words_match(s: &str, any: &[&str]) -> bool { any.iter().any(|w| s.contains(w)) }
// «\bk\d» и подобные проверки: буква с цифрой в начале слова
fn word_digit(s: &str, letter: char) -> bool {
    let c: Vec<char> = s.chars().collect();
    (0..c.len().saturating_sub(1)).any(|i| c[i] == letter && c[i + 1].is_ascii_digit() && (i == 0 || !c[i - 1].is_alphanumeric()))
}
// «g\d{3}»
fn g3(s: &str) -> bool { let b = s.as_bytes(); (0..b.len().saturating_sub(3)).any(|i| b[i] == b'g' && b[i + 1..i + 4].iter().all(|c| c.is_ascii_digit())) }

// ---------- стандартный HID: Battery Strength (страница 0x06, использование 0x20) ----------
fn std_battery(p: &str) -> i32 {
    let Some(h) = open(p, 0, false) else { return -1 };
    unsafe {
        let mut pp = PHIDP_PREPARSED_DATA::default();
        if !HidD_GetPreparsedData(h.0, &mut pp) { return -1; }
        let mut c = HIDP_CAPS::default();
        let _ = HidP_GetCaps(pp, &mut c);
        let mut res = -1;
        'outer: for t in [HidP_Feature, HidP_Input] {
            let mut n = if t == HidP_Feature { c.NumberFeatureValueCaps } else { c.NumberInputValueCaps };
            if n == 0 { continue; }
            let mut vc = vec![HIDP_VALUE_CAPS::default(); n as usize];
            if HidP_GetValueCaps(t, vc.as_mut_ptr(), &mut n, pp) != HIDP_STATUS_SUCCESS { continue; }
            for v in vc.iter().take(n as usize) {
                let (umin, umax) = (v.Anonymous.Range.UsageMin, v.Anonymous.Range.UsageMax);
                if v.UsagePage != 0x06 || (if !v.IsRange { umin != 0x20 } else { umin > 0x20 || umax < 0x20 }) { continue; }
                let len = if t == HidP_Feature { c.FeatureReportByteLength } else { c.InputReportByteLength } as usize;
                if len == 0 { continue; }
                let mut buf = vec![0u8; len]; buf[0] = v.ReportID;
                let ok = if t == HidP_Feature { HidD_GetFeature(h.0, buf.as_mut_ptr() as *mut _, len as u32) } else { HidD_GetInputReport(h.0, buf.as_mut_ptr() as *mut _, len as u32) };
                if !ok { continue; }
                let mut val = 0u32;
                if HidP_GetUsageValue(t, 0x06, None, 0x20, &mut val, pp, &buf) != HIDP_STATUS_SUCCESS { continue; }
                let (mut mn, mut mx) = (v.LogicalMin, v.LogicalMax);
                if mx <= mn { mn = 0; mx = if v.BitSize >= 8 { 255 } else { (1 << v.BitSize) - 1 }; }
                res = if mx == 100 && mn == 0 { (val as i32).min(100) } else { ((((val as f64) - mn as f64) / (mx - mn) as f64).clamp(0.0, 1.0) * 100.0).round() as i32 };
                break 'outer;
            }
        }
        let _ = HidD_FreePreparsedData(pp);
        res
    }
}

// ---------- Razer: feature-отчёт 90 байт (класс 0x07: 0x80 — заряд, 0x84 — зарядка) ----------
fn razer_cmd(p: &str, tid: u8, id: u8) -> Option<Vec<u8>> {
    let h = open(p, 0, false)?; // без прав чтения/записи — мышь система держит монопольно
    let mut b = [0u8; 91];
    b[2] = tid; b[6] = 0x02; b[7] = 0x07; b[8] = id;
    b[89] = b[3..89].iter().fold(0, |a, x| a ^ x);
    if !h.set_feature(&b) { return None; }
    for _ in 0..12 {
        sleep(25);
        let mut r = [0u8; 91];
        if !h.get_feature(&mut r) { continue; }
        if r[1] == 0x02 || r[1] == 0x04 { return Some(r.to_vec()); } // 0x04 — мышь спит / вне связи
        if r[1] != 0x00 && r[1] != 0x01 { return None; }
    }
    None
}
// ---------- Corsair Bragi: отчёт 0x02 → [endpoint, 0x02 = прочитать, свойство]; ответ в отчёте 0x01 ----------
fn bragi(p: &str, ep: u8, prop: u8) -> Option<Vec<u8>> {
    let h = open(p, RW, true)?;
    let mut w = [0u8; 64]; w[0] = 0x02; w[1] = ep; w[2] = 0x02; w[3] = prop;
    if !h.write(&w) { return None; }
    let until = Instant::now() + Duration::from_millis(800);
    while Instant::now() < until {
        let r = h.read(64, left(until))?;
        if r[0] == 0x01 && r[2] == 0x02 { return Some(r); }
    }
    None
}
// ---------- Ajazz / Sonix 2.4G: 0x02 — проверка связи, 0x20 0x01 — заряд ----------
fn radio(p: &str, cmd: u8, len: u8) -> Option<Vec<u8>> {
    let h = open(p, RW, true)?;
    let mut f = [0u8; 33]; f[1] = cmd; f[2] = len;
    f[32] = f[..32].iter().fold(0u32, |a, &x| a + x as u32) as u8;
    if !h.write(&f) { return None; }
    let until = Instant::now() + Duration::from_millis(300);
    while Instant::now() < until {
        let r = h.read(33, left(until))?;
        if r[1] == cmd && r[2] == len && r[3] == 0 { return Some(r); }
    }
    None
}
// ---------- SteelSeries Arctis Nova: статус 0xB0 на интерфейс 3, ответ может прийти и на интерфейс 5 ----------
fn arctis(pw: &str, readers: &[String], out_len: usize) -> Option<Vec<u8>> {
    let hs: Vec<Dev> = readers.iter().filter_map(|p| open(p, RW, true)).collect();
    let w = open(pw, RW, true)?;
    let mut buf = vec![0u8; out_len.max(2)]; buf[1] = 0xB0;
    // читать начинаем до записи, чтобы не пропустить ответ
    let mut pend: Vec<(&Dev, Io)> = hs.iter().chain(std::iter::once(&w)).filter_map(|d| d.start_read(64).map(|io| (d, io))).collect();
    let mut res = None;
    if w.write(&buf) {
        let until = Instant::now() + Duration::from_millis(700);
        while res.is_none() && !pend.is_empty() {
            let ms = left(until); if ms == 0 { break; }
            let evs: Vec<HANDLE> = pend.iter().map(|(_, io)| io.ev).collect();
            let r = unsafe { WaitForMultipleObjects(&evs, false, ms as u32) }.0;
            if r >= evs.len() as u32 { break; }
            let (d, io) = pend.remove(r as usize);
            if d.finish(&io).is_some() && io.buf[1] == 0xB0 { res = Some(io.buf.clone()); } // первый байт — номер отчёта (0)
        }
    }
    for (d, io) in &pend { d.cancel(io); }
    res
}
// ---------- Compx (3554): отчёт 0x08, 16 байт; команда 0x04 — заряд ----------
fn compx(p: &str) -> Option<Vec<u8>> {
    let h = open(p, RW, true)?;
    let mut w = [0u8; 17]; w[0] = 0x08; w[1] = 0x04;
    let sum: u32 = 8 + w[1..16].iter().map(|&x| x as u32).sum::<u32>();
    w[16] = (0x55u32.wrapping_sub(sum & 0xFF) & 0xFF) as u8;
    if !h.write(&w) { return None; }
    let until = Instant::now() + Duration::from_millis(600);
    while Instant::now() < until {
        let r = h.read(17, left(until))?;
        if r[0] == 0x08 && r[1] == 0x04 { return Some(r); }
    }
    None
}

// ---------- Logitech HID++ 2.0 ----------
fn hpp_t(h: &Dev, ms: u64, dev: u8, feat: u8, func: u8, args: &[u8]) -> Option<Vec<u8>> {
    let mut w = [0u8; 20]; w[0] = 0x11; w[1] = dev; w[2] = feat; w[3] = (func << 4) | 0x0A;
    for (i, a) in args.iter().take(16).enumerate() { w[4 + i] = *a; }
    if !h.write(&w) { return None; }
    let until = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < until {
        let r = h.read(20, left(until))?;
        if r[0] != 0x11 || r[1] != dev { continue; }
        if r[2] == 0xFF && r[3] == feat { return None; } // ошибка HID++ 2.0
        if r[2] == feat && r[3] == w[3] { return Some(r); }
    }
    None
}
fn hpp(h: &Dev, dev: u8, feat: u8, func: u8, args: &[u8]) -> Option<Vec<u8>> { hpp_t(h, 300, dev, feat, func, args) }
fn hpp_feature(h: &Dev, dev: u8, id: u16) -> u8 { hpp(h, dev, 0, 0, &[(id >> 8) as u8, id as u8]).map_or(0, |r| r[4]) }
// напряжение Li-ion → проценты (таблица Solaar)
fn volt_pct(mv: i32) -> i32 {
    const T: [(i32, i32); 13] = [(4186, 100), (4067, 90), (3989, 80), (3922, 70), (3859, 60), (3811, 50), (3778, 40), (3751, 30), (3717, 20), (3671, 10), (3646, 5), (3579, 2), (3500, 0)];
    if mv >= T[0].0 { return 100; }
    for i in 1..T.len() {
        if mv >= T[i].0 { return T[i].1 + (((mv - T[i].0) as f64 / (T[i - 1].0 - T[i].0) as f64) * (T[i - 1].1 - T[i].1) as f64).round() as i32; }
    }
    0
}
const LOGI_KINDS: [&str; 16] = ["keyboard", "", "keyboard", "mouse", "mouse", "mouse", "", "", "headphones", "", "gamepad", "gamepad", "gamepad", "", "", ""];
fn logi(p: &str, fallback: &str, mut diag: Option<&mut Vec<String>>) -> Vec<String> {
    let mut res = Vec::new();
    let Some(h) = open(p, RW, true) else { return res };
    for dev in [0xFFu8, 1, 2, 3, 4, 5, 6] {
        let Some(probe) = hpp_t(&h, 200, dev, 0, 0, &[0x00, 0x05]) else { continue };
        let f_uni = hpp_feature(&h, dev, 0x1004);
        let (mut kind_id, mut name) = (-1i32, String::new());
        let f_name = probe[4];
        if f_name != 0 {
            let n = hpp(&h, dev, f_name, 0, &[]).map_or(0, |c| c[4] as usize);
            let mut sb: Vec<u8> = Vec::new();
            let mut off = 0;
            while off < n && off < 64 {
                let Some(part) = hpp(&h, dev, f_name, 1, &[off as u8]) else { break };
                for k in 4..20 { if sb.len() < n { sb.push(part[k]); } }
                off += 16;
            }
            name = sb.iter().map(|&b| b as char).collect::<String>().trim_matches(|c| c == '\0' || c == ' ').to_string();
            if let Some(t) = hpp(&h, dev, f_name, 2, &[]) { kind_id = t[4] as i32; }
        }
        if name.is_empty() { name = fallback.to_string(); }
        let ln = name.to_lowercase();
        let kind = if (0..16).contains(&kind_id) { LOGI_KINDS[kind_id as usize] } else if ln.contains("headset") || g3(&ln) || ln.contains("astro") || ln.contains("pro x") { "headphones" } else { "" };
        let (mut lvl, mut chg, mut how) = (-2i32, false, String::new());
        if f_uni != 0 {
            if let Some(r) = hpp(&h, dev, f_uni, 1, &[]) {
                lvl = if r[4] > 0 { (r[4] as i32).min(100) } else if r[5] & 8 != 0 { 100 } else if r[5] & 4 != 0 { 60 } else if r[5] & 2 != 0 { 20 } else if r[5] & 1 != 0 { 5 } else { -2 };
                chg = r[6] == 1 || r[6] == 2; how = "1004".into();
            }
        }
        if how.is_empty() { let f = hpp_feature(&h, dev, 0x1000); if f != 0 { if let Some(r) = hpp(&h, dev, f, 0, &[]) { lvl = if r[4] > 0 { (r[4] as i32).min(100) } else { -2 }; chg = (1..=2).contains(&r[6]) || r[6] == 4; how = "1000".into(); } } }
        if how.is_empty() { let f = hpp_feature(&h, dev, 0x1F20); if f != 0 { if let Some(r) = hpp(&h, dev, f, 0, &[]) { let mv = ((r[4] as i32) << 8) | r[5] as i32; if mv > 0 { lvl = volt_pct(mv); } chg = r[6] & 0x02 != 0; how = format!("1F20 {}mV f{:02X}", mv, r[6]); } } }
        if how.is_empty() { let f = hpp_feature(&h, dev, 0x1001); if f != 0 { if let Some(r) = hpp(&h, dev, f, 0, &[]) { let mv = ((r[4] as i32) << 8) | r[5] as i32; if mv > 0 { lvl = volt_pct(mv); } chg = r[6] & 0x80 != 0; how = format!("1001 {}mV f{:02X}", mv, r[6]); } } }
        if let Some(d) = diag.as_deref_mut() { d.push(format!("  hid++ dev {:02X} \"{}\" type {} battery {} -> {}{}", dev, name, kind_id, if how.is_empty() { "-" } else { &how }, lvl, if chg { " chg" } else { "" })); }
        if how.is_empty() && kind_id == 7 { continue; } // сам приёмник
        let mut pn = pretty(&name); if !pn.to_lowercase().starts_with("logi") { pn = format!("Logitech {}", pn); }
        res.push(format!("{}|{}|1|{}|{}", pn, lvl, chg as i32, kind));
        if dev == 0xFF { break; } // ответило само устройство — приёмника за ним нет
    }
    res
}
fn logi_paths() -> Vec<String> {
    let (mut out, mut seen) = (Vec::new(), HashSet::new());
    for p in paths("046d") {
        let Some((c, _)) = caps(&p) else { continue };
        if c.page < 0xFF00 || c.out != 20 { continue; }
        let lp = p.to_lowercase();
        let k = match lp.find("pid_") { Some(i) => { let mut k = lp[i..(i + 8).min(lp.len())].to_string(); if let Some(mi) = after(&lp, "&mi_") { if lp[i + 8..].starts_with("&mi_") { k += &format!("&mi_{}", mi); } } k } None => p.clone() };
        if !seen.insert(k) { continue; }
        out.push(p);
    }
    out
}

// ---------- Logitech G435 (донгл Realtek 046D:0ACB): напряжение — только в сервисном режиме донгла ----------
pub fn g435_present() -> String {
    for p in paths("046d") {
        if !p.to_lowercase().contains("pid_0acb") { continue; }
        if let Some((c, name)) = caps(&p) { if c.page == 0xFFC0 && c.feat == 64 { return format!("{}|{}", p, name); } }
    }
    String::new()
}
fn g435_set(h: &Dev, b: &[u8]) -> bool { let mut buf = [0u8; 64]; buf[..b.len()].copy_from_slice(b); h.set_feature(&buf) }
// «имя|мВ» или «имя|0», если гарнитура не ответила
pub fn g435_read() -> String {
    let pn = g435_present(); if pn.is_empty() { return pn; }
    let (p, name) = pn.split_once('|').unwrap();
    let mut samples: Vec<i32> = Vec::new();
    let Some(h) = open(p, RW, false) else { return format!("{}|0", name) };
    if !g435_set(&h, &[0x06, 0x01, 0x03, 0, 0, 0, 0]) { return format!("{}|0", name); } // войти в сервисный режим
    sleep(250);
    let mut rb = [0u8; 64]; rb[0] = 0x06; h.get_feature(&mut rb); // сбросить старый ответ
    g435_set(&h, &[0x06, 0x04, 0x03, 0x00, 0x07, 0x50, 0x41, 0x0E, 0x00, 0x02, 0xE1, 0x01]); // удалённый режим
    sleep(150);
    g435_set(&h, &[0x06, 0x04, 0x03, 0x00, 0x07, 0x50, 0x41, 0x06, 0x00, 0x01, 0x00, 0x31]); // запрос заряда
    let until = Instant::now() + Duration::from_millis(800);
    while Instant::now() < until && samples.len() < 5 {
        let mut r = [0u8; 64]; r[0] = 0x06;
        if h.get_feature(&mut r) {
            for i in 0..59 {
                if r[i] != 0x06 || r[i + 1] != 0x80 || r[i + 2] != 0x00 { continue; }
                let mv = r[i + 3] as i32 | (r[i + 4] as i32) << 8;
                if (3000..=4500).contains(&mv) { samples.push(mv); break; }
            }
        }
        sleep(30);
    }
    g435_set(&h, &[0x06, 0x04, 0x03, 0x00, 0x07, 0x50, 0x41, 0x0E, 0x00, 0x02, 0xE1, 0x00]); // обратно в локальный режим
    sleep(50);
    g435_set(&h, &[0x06, 0x08, 0x03, 0, 0, 0, 0]); // выйти из сервисного режима
    sleep(100);
    if samples.is_empty() { return format!("{}|0", name); }
    samples.sort();
    format!("{}|{}", name, samples[samples.len() / 2])
}

// ---------- Redragon (Areson 25A7): GetPower ----------
fn areson_power(feat: &str, inp: &str, len: usize, mut diag: Option<&mut Vec<String>>) -> Option<Vec<u8>> {
    let rh = open(inp, RW, true)?;
    let fh = open(feat, 0, false)?;
    let mut req = vec![0u8; len]; req[0] = 0x08; req[1] = 0x04;
    let sum: u32 = req[..len - 1].iter().map(|&x| x as u32).sum();
    req[len - 1] = (0x55u32.wrapping_sub(sum) & 0xFF) as u8;
    for attempt in 0..2 {
        if attempt > 0 { sleep(200); }
        if !fh.set_feature(&req) { if let Some(d) = diag.as_deref_mut() { d.push("  areson: запрос не принят".into()); } return None; }
        let until = Instant::now() + Duration::from_millis(1200);
        while Instant::now() < until {
            let Some(r) = rh.read(len, left(until)) else { break };
            if let Some(d) = diag.as_deref_mut() { d.push(format!("  areson ответ: {}", r.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join("-"))); }
            let tot: u32 = r.iter().map(|&b| b as u32).sum();
            if r[0] == 0x09 && r[1] == 0x04 && r[2] == 0x00 && tot & 0xFF == 0x55 { return Some(r); }
        }
    }
    None
}
fn areson(mut diag: Option<&mut Vec<String>>) -> Vec<String> {
    let mut res = Vec::new();
    let (mut feats, mut ins): (Vec<(String, String, usize)>, HashMap<String, String>) = (Vec::new(), HashMap::new());
    for p in paths("25a7") {
        let Some((c, _)) = caps(&p) else { continue };
        let lp = p.to_lowercase();
        let (Some((_, pid)), Some(mi)) = (vid_pid(&lp), after(&lp, "&mi_")) else { continue };
        let k = pid + &mi;
        if c.page == 0xFF02 && c.usage == 0x02 && c.feat >= 8 { feats.retain(|f| f.0 != k); feats.push((k, p, c.feat as usize)); }
        else if c.page == 0xFF01 && c.inp >= 8 { ins.insert(k, p); }
    }
    for (k, fp, len) in feats {
        let Some(ip) = ins.get(&k) else { continue };
        let pid = &k[..4];
        if let Some(d) = diag.as_deref_mut() { d.push(format!("redragon/areson 25A7:{} кадр {}", pid.to_uppercase(), len)); }
        let r = areson_power(&fp, ip, len, diag.as_deref_mut());
        let kind = if matches!(pid, "fa07" | "fa08" | "fa7b" | "fa7c") { "mouse" } else { "keyboard" };
        let Some(r) = r else { res.push(format!("Redragon 2.4G|-1|0|0|{}", kind)); continue };
        let raw = r[6] as i32;
        let lvl = if matches!(pid, "fa7b" | "fa7c") { raw } else if matches!(pid, "fa07" | "fa08") || raw <= 10 { raw * 10 } else { raw };
        let chg = r.len() > 8 && r[7] != 0; // в 8-байтовом кадре байт 7 — контрольная сумма
        res.push(format!("Redragon 2.4G|{}|1|{}|{}", if lvl > 0 { lvl.min(100) } else { -2 }, chg as i32, kind));
    }
    res
}

// диагностика: интерфейсы с vendor-страницей, сырые ответы Areson и что ответило по HID++
pub fn diag() -> Vec<String> {
    let mut out = Vec::new();
    for p in paths("") {
        let Some((c, name)) = caps(&p) else { continue };
        let lp = p.to_lowercase();
        let Some((v, pi)) = vid_pid(&lp) else { continue };
        if c.page < 0xFF00 && c.page != 0x0C && c.page != 0x06 { continue; }
        let mi = after(&lp, "&mi_").unwrap_or_else(|| "--".into());
        let col = after(&lp, "&col").map(|c| format!(" col{}", c)).unwrap_or_default();
        out.push(format!("{}:{} mi{}{} page {:04X}/{:02X} in {} out {} feat {} {}", v.to_uppercase(), pi.to_uppercase(), mi, col, c.page, c.usage, c.inp, c.out, c.feat, name));
    }
    out.sort();
    let _ = areson(Some(&mut out));
    for p in logi_paths() {
        let name = caps(&p).map(|x| x.1).unwrap_or_default();
        out.push(format!("logitech {}:", name));
        logi(&p, &name, Some(&mut out));
    }
    out
}

// "имя|уровень|подключено|заряжается|тип"
pub struct Hid { last_kb: Option<String> }
impl Hid {
    pub fn new() -> Self { Hid { last_kb: None } }
    pub fn read(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for p in paths("1532") {
            let Some((c, name)) = caps(&p) else { continue };
            if c.feat != 91 { continue; }
            let key = format!("{}|razer", name); if seen.contains(&key) { continue; }
            // 0x1F — беспроводные мыши Razer (HyperSpeed); 0x3F/0x08 — остальные. Ответ 0x04 — повторяем
            for tid in [0x1Fu8, 0x3F, 0x08] {
                let mut r = None;
                for _ in 0..4 { r = razer_cmd(&p, tid, 0x80); if r.as_ref().map_or(true, |x| x[1] == 0x02) { break; } sleep(150); }
                let Some(r) = r else { continue };
                let ln = name.to_lowercase();
                let kind = if c.usage == 0x06 { "keyboard" } else if c.usage == 0x02 { "mouse" } else if ln.contains("kraken") || ln.contains("barracuda") { "headphones" } else { "mouse" };
                if r[1] == 0x04 { out.push(format!("{}|-1|0|0|{}", pretty(&name), kind)); seen.insert(key); break; }
                let ch = razer_cmd(&p, tid, 0x84);
                out.push(format!("{}|{}|1|{}|{}", pretty(&name), (r[10] as f64 / 255.0 * 100.0).round(), (ch.map_or(false, |c| c[1] == 0x02 && c[10] != 0)) as i32, kind));
                seen.insert(key); break;
            }
        }
        for p in paths("1b1c") {
            let Some((c, name)) = caps(&p) else { continue };
            if c.page != 0xFF42 || c.usage != 0x01 || c.out != 64 || seen.contains(&name) { continue; }
            let Some(lv) = bragi(&p, 0x09, 0x0F) else { continue };
            seen.insert(name.clone());
            let ln = name.to_lowercase();
            let kind = if ln.contains("headset") || ln.split(|c: char| !c.is_alphanumeric()).any(|w| w == "void" || w == "virtuoso" || (w.starts_with("hs") && w.len() > 2 && w[2..].chars().all(|c| c.is_ascii_digit()))) { "headphones" }
                else if ln.contains("mouse") { "mouse" } else if ln.contains("keyboard") || name.contains(" K") { "keyboard" } else { "headphones" };
            if lv[3] != 0 { out.push(format!("{}|-1|0|0|{}", pretty(&name), kind)); continue; }
            let level = (lv[4] as i32 | (lv[5] as i32) << 8) / 10;
            if level <= 0 { out.push(format!("{}|-1|0|0|{}", pretty(&name), kind)); continue; }
            let st = bragi(&p, 0x09, 0x10);
            let charging = st.map_or(false, |s| s[3] == 0 && s[4] == 0x01);
            out.push(format!("{}|{}|1|{}|{}", pretty(&name), level, charging as i32, kind));
        }
        {
            let (mut w3, mut rd, mut out_len, mut ss_name): (Option<String>, Vec<String>, usize, String) = (None, Vec::new(), 64, String::new());
            for p in paths("1038") {
                let lp = p.to_lowercase();
                let Some((c, name)) = caps(&p) else { continue };
                if lp.contains("&mi_03") && c.out > 0 && w3.is_none() { w3 = Some(p); out_len = c.out as usize; ss_name = name; }
                else if lp.contains("&mi_05") && c.inp > 0 { rd.push(p); }
            }
            if let Some(w3) = w3 {
                if seen.insert(format!("ss{}", ss_name)) {
                    let r = arctis(&w3, &rd, out_len);
                    let nm = pretty(if ss_name.is_empty() { "Arctis Nova" } else { &ss_name });
                    match r {
                        Some(r) if r[2] == 0x03 => { let raw = r[3] as i32; let lvl = if raw <= 4 { raw * 25 } else { raw.min(100) }; out.push(format!("{}|{}|1|{}|headphones", nm, lvl, (r[4] == 1) as i32)); }
                        _ => out.push(format!("{}|-1|0|0|headphones", nm)),
                    }
                }
            }
        }
        for p in paths("3554") {
            let Some((c, name)) = caps(&p) else { continue };
            if c.page < 0xFF00 || c.out != 17 || c.inp != 17 { continue; }
            let nm = pretty(if name.is_empty() { "2.4G" } else { &name });
            if !seen.insert(format!("cx{}", nm)) { continue; }
            let ln = nm.to_lowercase();
            let kind = if word_digit(&ln, 'k') || ln.contains("keyboard") || ln.contains("kb") { "keyboard" } else { "mouse" };
            match compx(&p) {
                Some(r) if r[2] == 0 => { let lvl = (r[6] as i32).min(100); out.push(format!("{}|{}|1|{}|{}", nm, if lvl > 0 { lvl } else { -2 }, (r[7] == 1) as i32, kind)); }
                _ => out.push(format!("{}|-1|0|0|{}", nm, kind)),
            }
        }
        for p in logi_paths() {
            let name = caps(&p).map(|x| x.1).unwrap_or_default();
            let nm0 = if name.is_empty() { "Logitech".to_string() } else { name };
            let got = logi(&p, &nm0, None);
            for line in &got { if seen.insert(format!("lg{}", line.split('|').next().unwrap_or(""))) { out.push(line.clone()); } }
            // гарнитура с донглом выключена — донгл есть, но не отвечает: «нет связи»
            let l0 = nm0.to_lowercase();
            if got.is_empty() && (l0.contains("headset") || g3(&l0)) && seen.insert(format!("lgoff{}", nm0)) {
                let mut pn = pretty(&nm0); if !pn.to_lowercase().starts_with("logi") { pn = format!("Logitech {}", pn); }
                out.push(format!("{}|-1|0|0|headphones", pn));
            }
        }
        for line in areson(None) { if seen.insert(format!("ar{}", line.split('|').next().unwrap_or(""))) { out.push(line); } }
        // любые другие устройства: стандартный заряд HID, если он есть
        const KNOWN: [&str; 7] = ["1532", "1b1c", "0c45", "3554", "1038", "046d", "25a7"];
        for p in paths("") {
            let lp = p.to_lowercase();
            let Some((v, pi)) = vid_pid(&lp) else { continue };
            if KNOWN.contains(&v.as_str()) { continue; }
            let Some((c, name)) = caps(&p) else { continue };
            if c.page == 0x01 && (c.usage == 0x02 || c.usage == 0x06) { continue; } // саму мышь/клавиатуру система держит
            let key = format!("std{}{}", v, pi);
            if seen.contains(&key) { continue; }
            let lv = std_battery(&p);
            if lv < 0 { continue; }
            seen.insert(key);
            let nm = pretty(&if name.is_empty() { format!("{}:{}", v.to_uppercase(), pi.to_uppercase()) } else { name });
            let ln = nm.to_lowercase();
            let kind = if words_match(&ln, &["keyboard", "клав", "kb"]) { "keyboard" } else if words_match(&ln, &["mouse", "мыш"]) { "mouse" } else if words_match(&ln, &["headset", "head", "наушн", "buds"]) { "headphones" } else if words_match(&ln, &["controller", "gamepad", "pad"]) { "gamepad" } else { "" };
            out.push(format!("{}|{}|1|0|{}", nm, lv, kind));
        }
        for p in paths("0c45") {
            let Some((c, name)) = caps(&p) else { continue };
            if c.page != 0xFF60 || c.inp != 33 || c.out != 33 { continue; }
            if !name.to_lowercase().contains("dongle") || !seen.insert(format!("aj{}", name)) { continue; }
            let mut hs = None;
            for _ in 0..3 { hs = radio(&p, 0x02, 0); if hs.is_some() { break; } sleep(120); }
            // в ответе на проверку связи — VID/PID самой клавиатуры: 0C45:8009 = AK820 Pro
            let mut kname = match &hs { Some(h) if h[8] == 0x45 && h[9] == 0x0C && h[10] == 0x09 && h[11] == 0x80 => "Ajazz AK820 Pro".to_string(), _ => "Клавиатура 2.4G".to_string() };
            if hs.is_some() { self.last_kb = Some(kname.clone()); } else if let Some(k) = &self.last_kb { kname = k.clone(); }
            if hs.is_none() { out.push(format!("{}|-1|0|0|keyboard", kname)); continue; }
            let lvl = radio(&p, 0x20, 0x01).map_or(0, |b| (b[4] as i32).min(100));
            out.push(format!("{}|{}|1|0|keyboard", kname, if lvl > 0 { lvl } else { -2 }));
        }
        out
    }
}
