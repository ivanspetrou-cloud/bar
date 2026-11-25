// Система: сеть, Bluetooth, загрузка видеокарты, веб-камера, сведения о компьютере, размеры экранов,
// частота запуска программ, свойства exe, логотипы приложений Store, приложения «Пуска», поиск файлов.
// Всё только читает данные Windows на этом компьютере; наружу ничего не уходит.
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::time::Instant;

use windows::core::{Interface, BSTR, GUID, PCWSTR, PWSTR};
use windows::Win32::Devices::DeviceAndDriverInstallation::*;
use windows::Win32::Devices::Properties::{DEVPKEY_Device_DeviceDesc, DEVPKEY_Device_FriendlyName, DEVPROPTYPE};
use windows::Win32::Foundation::{DEVPROPKEY, HANDLE};
use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
use windows::Win32::NetworkManagement::WiFi::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Performance::*;
use windows::Win32::System::Registry::*;
use windows::Win32::System::Variant::*;
use windows::Win32::System::Wmi::*;

use crate::img;
use crate::win::wide;

fn s16(b: &[u16]) -> String { let n = b.iter().position(|&c| c == 0).unwrap_or(b.len()); String::from_utf16_lossy(&b[..n]) }

// ---------- реестр ----------
pub struct Key(HKEY);
impl Drop for Key { fn drop(&mut self) { unsafe { let _ = RegCloseKey(self.0); } } }
pub fn reg_open(root: HKEY, path: &str) -> Option<Key> {
    let w = wide(path);
    let mut k = HKEY::default();
    if unsafe { RegOpenKeyExW(root, PCWSTR(w.as_ptr()), None, KEY_READ, &mut k) }.is_ok() { Some(Key(k)) } else { None }
}
impl Key {
    fn raw(&self, name: &str) -> Option<(u32, Vec<u8>)> {
        let w = wide(name);
        let (mut t, mut n) = (REG_VALUE_TYPE(0), 0u32);
        unsafe {
            if RegQueryValueExW(self.0, PCWSTR(w.as_ptr()), None, Some(&mut t), None, Some(&mut n)).is_err() { return None; }
            let mut b = vec![0u8; n as usize];
            if RegQueryValueExW(self.0, PCWSTR(w.as_ptr()), None, Some(&mut t), Some(b.as_mut_ptr()), Some(&mut n)).is_err() { return None; }
            b.truncate(n as usize);
            Some((t.0, b))
        }
    }
    fn str(&self, name: &str) -> Option<String> {
        let (_, b) = self.raw(name)?;
        let u: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        Some(s16(&u))
    }
    fn num(&self, name: &str) -> Option<i64> {
        let (t, b) = self.raw(name)?;
        match (t, b.len()) { (_, 8) => Some(i64::from_le_bytes(b[..8].try_into().ok()?)), (_, 4) => Some(u32::from_le_bytes(b[..4].try_into().ok()?) as i64), (1, _) => self.str(name)?.trim().parse().ok(), _ => None }
    }
    fn subkeys(&self) -> Vec<String> {
        let mut v = Vec::new();
        for i in 0.. {
            let mut buf = [0u16; 256]; let mut n = 256u32;
            if unsafe { RegEnumKeyExW(self.0, i, Some(PWSTR(buf.as_mut_ptr())), &mut n, None, None, None, None) }.is_err() { break; }
            v.push(String::from_utf16_lossy(&buf[..n as usize]));
        }
        v
    }
}

// ---------- сеть ----------
pub struct Net { wlan: Option<HANDLE> }
impl Net {
    pub fn new() -> Self { Net { wlan: None } }
    fn wifi(&mut self) -> Value {
        unsafe {
            if self.wlan.is_none() {
                let (mut ver, mut h) = (0u32, HANDLE::default());
                if WlanOpenHandle(2, None, &mut ver, &mut h) != 0 { return Value::Null; }
                self.wlan = Some(h);
            }
            let h = self.wlan.unwrap();
            let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
            if WlanEnumInterfaces(h, None, &mut list) != 0 || list.is_null() { return Value::Null; }
            let mut res = Value::Null;
            let n = (*list).dwNumberOfItems as usize;
            let items = std::slice::from_raw_parts((*list).InterfaceInfo.as_ptr(), n);
            for it in items {
                if it.isState != wlan_interface_state_connected { continue; }
                let (mut sz, mut data) = (0u32, std::ptr::null_mut());
                if WlanQueryInterface(h, &it.InterfaceGuid, wlan_intf_opcode_current_connection, None, &mut sz, &mut data, None) != 0 || data.is_null() { continue; }
                let a = &(*(data as *const WLAN_CONNECTION_ATTRIBUTES)).wlanAssociationAttributes;
                let ssid = String::from_utf8_lossy(&a.dot11Ssid.ucSSID[..(a.dot11Ssid.uSSIDLength as usize).min(32)]).trim().to_string();
                let sig = a.wlanSignalQuality;
                WlanFreeMemory(data);
                if !ssid.is_empty() { res = json!({ "ssid": ssid, "signal": sig }); break; }
            }
            WlanFreeMemory(list as *const _);
            res
        }
    }
    pub fn state(&mut self) -> Value {
        let (mut eth, mut speed, mut online, mut rx, mut tx) = (false, String::new(), false, 0u64, 0u64);
        unsafe {
            let mut t: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
            if GetIfTable2(&mut t).is_ok() && !t.is_null() {
                let rows = std::slice::from_raw_parts((*t).Table.as_ptr(), (*t).NumEntries as usize);
                for r in rows {
                    let f = r.InterfaceAndOperStatusFlags._bitfield;
                    // как Get-NetAdapter -Physical: настоящая сетевая карта с разъёмом, не фильтр и не виртуальная
                    let (hw, filter, conn) = (f & 1 != 0, f & 2 != 0, f & 4 != 0);
                    if !hw || filter || !conn || r.OperStatus.0 != 1 { continue; }
                    online = true; rx += r.InOctets; tx += r.OutOctets;
                    // 802.3 (не Wi-Fi): MediaType 0, физическая среда не беспроводная
                    if !eth && r.MediaType.0 == 0 && r.PhysicalMediumType.0 != 1 && r.PhysicalMediumType.0 != 9 {
                        eth = true;
                        let s = r.ReceiveLinkSpeed.max(r.TransmitLinkSpeed) as f64;
                        speed = if s >= 1e9 { format!("{} Gbps", trim_num(s / 1e9)) } else if s >= 1e6 { format!("{} Mbps", trim_num(s / 1e6)) } else { format!("{} Kbps", trim_num(s / 1e3)) };
                    }
                }
                FreeMibTable(t as *const _);
            }
        }
        json!({ "ethernet": eth, "ethSpeed": speed, "wifi": self.wifi(), "online": online, "rx": rx, "tx": tx })
    }
}
fn trim_num(x: f64) -> String { let s = format!("{:.1}", x); s.trim_end_matches('0').trim_end_matches('.').to_string() }

// ---------- Bluetooth: сопряжённые устройства, на связи ли, заряд ----------
const K_BAT: DEVPROPKEY = DEVPROPKEY { fmtid: GUID::from_u128(0x104EA319_6EE2_4701_BD47_8DDBF425BBE5), pid: 2 };
const K_CHG: DEVPROPKEY = DEVPROPKEY { fmtid: GUID::from_u128(0x104EA319_6EE2_4701_BD47_8DDBF425BBE5), pid: 3 };
const K_CON: DEVPROPKEY = DEVPROPKEY { fmtid: GUID::from_u128(0x83DA6326_97A6_4088_9453_A1923F573B29), pid: 15 };
const K_COD: DEVPROPKEY = DEVPROPKEY { fmtid: GUID::from_u128(0x2BD67D8B_8BEB_48D5_87E0_6CDA3428040A), pid: 10 };
fn dev_prop(set: HDEVINFO, d: &SP_DEVINFO_DATA, k: &DEVPROPKEY) -> Option<Vec<u8>> {
    let mut t = DEVPROPTYPE(0);
    let mut buf = vec![0u8; 512];
    let mut n = 0u32;
    unsafe { SetupDiGetDevicePropertyW(set, d, k, &mut t, Some(&mut buf), Some(&mut n), 0) }.ok()?;
    buf.truncate(n as usize);
    Some(buf)
}
fn prop_str(b: Option<Vec<u8>>) -> String { b.map(|b| s16(&b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>())).unwrap_or_default() }
pub fn bt() -> Value {
    let mut order: Vec<String> = Vec::new();
    let mut out: HashMap<String, Map<String, Value>> = HashMap::new();
    unsafe {
        let Ok(set) = SetupDiGetClassDevsW(Some(&GUID_DEVCLASS_BLUETOOTH), PCWSTR::null(), None, DIGCF_PRESENT) else { return json!([]) };
        let mut d = SP_DEVINFO_DATA { cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32, ..Default::default() };
        let mut i = 0;
        while SetupDiEnumDeviceInfo(set, i, &mut d).is_ok() {
            i += 1;
            let mut idb = [0u16; 512];
            if SetupDiGetDeviceInstanceIdW(set, &d, Some(&mut idb), None).is_err() { continue; }
            let id = s16(&idb).to_uppercase();
            if !(id.starts_with("BTHENUM\\DEV_") || id.starts_with("BTHLE\\DEV_")) { continue; }
            let mut name = prop_str(dev_prop(set, &d, &DEVPKEY_Device_FriendlyName));
            if name.is_empty() { name = prop_str(dev_prop(set, &d, &DEVPKEY_Device_DeviceDesc)); }
            if name.is_empty() { continue; }
            let con = dev_prop(set, &d, &K_CON).map_or(false, |b| b.first().map_or(false, |&x| x != 0));
            let lvl = dev_prop(set, &d, &K_BAT).and_then(|b| b.first().copied()).map_or(-1, |x| x as i64);
            if !con && lvl < 0 { continue; } // не на связи и заряд неизвестен — не показываем
            let chg = dev_prop(set, &d, &K_CHG).map_or(false, |b| b.first().map_or(false, |&x| x != 0));
            let kind = dev_prop(set, &d, &K_COD).filter(|b| b.len() >= 4).map(|b| {
                let cod = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                let (major, minor) = ((cod >> 8) & 0x1F, (cod >> 2) & 0x3F);
                match major { 1 => "laptop", 2 => "phone", 4 => "headphones", 5 => if minor & 0x10 != 0 { "keyboard" } else if minor & 0x20 != 0 { "mouse" } else if matches!(minor & 0x0F, 1 | 2) { "gamepad" } else { "" }, _ => "" }
            }).unwrap_or("").to_string();
            let level = if lvl >= 0 { lvl } else if con { -2 } else { -1 };
            let mut o = Map::new();
            o.insert("name".into(), json!(name)); o.insert("level".into(), json!(level)); o.insert("connected".into(), json!(con)); o.insert("charging".into(), json!(chg)); o.insert("kind".into(), json!(kind));
            // у одного устройства бывает и обычный, и BLE-узел — склеиваем по адресу
            let addr = id.find("DEV_").and_then(|p| id.get(p + 4..p + 16)).unwrap_or(&id).to_string();
            match out.get_mut(&addr) {
                None => { order.push(addr.clone()); out.insert(addr, o); }
                Some(prev) => {
                    let pcon = prev["connected"].as_bool().unwrap_or(false);
                    let plvl = prev["level"].as_i64().unwrap_or(-1);
                    if (con && !pcon) || (level >= 0 && plvl < 0) {
                        if kind.is_empty() { o.insert("kind".into(), prev["kind"].clone()); }
                        *prev = o;
                    } else if prev["kind"].as_str().map_or(true, |k| k.is_empty()) && !kind.is_empty() { prev.insert("kind".into(), json!(kind)); }
                }
            }
        }
        let _ = SetupDiDestroyDeviceInfoList(set);
    }
    // одинаковые имена (два геймпада Xbox) — различаем номером
    let mut seen: HashMap<String, i32> = HashMap::new();
    let mut res = Vec::new();
    for a in order {
        let mut o = out.remove(&a).unwrap();
        let n = o["name"].as_str().unwrap_or("").to_string();
        let c = seen.entry(n.clone()).or_insert(0); *c += 1;
        if *c > 1 { o.insert("name".into(), json!(format!("{} {}", n, c))); }
        res.push(Value::Object(o));
    }
    json!(res)
}

// ---------- загрузка видеокарты: сумма 3D-движков всех процессов ----------
pub struct Gpu { q: PDH_HQUERY, c: PDH_HCOUNTER, at: Option<Instant> }
impl Gpu {
    pub fn new() -> Self { Gpu { q: PDH_HQUERY::default(), c: PDH_HCOUNTER::default(), at: None } }
    pub fn usage(&mut self) -> Value {
        unsafe {
            if self.at.map_or(true, |t| t.elapsed().as_secs() > 60) {
                if !self.q.is_invalid() { PdhCloseQuery(self.q); }
                self.q = PDH_HQUERY::default();
                let path = wide("\\GPU Engine(*engtype_3D)\\Utilization Percentage");
                if PdhOpenQueryW(PCWSTR::null(), 0, &mut self.q) != 0 || PdhAddEnglishCounterW(self.q, PCWSTR(path.as_ptr()), 0, &mut self.c) != 0 { return json!(0); }
                PdhCollectQueryData(self.q);
                self.at = Some(Instant::now());
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            if PdhCollectQueryData(self.q) != 0 { return json!(0); }
            let (mut size, mut n) = (0u32, 0u32);
            PdhGetFormattedCounterArrayW(self.c, PDH_FMT(PDH_FMT_DOUBLE.0 | 0x8000), &mut size, &mut n, None);
            if size == 0 { return json!(0); }
            let mut buf = vec![0u8; size as usize + 16];
            let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            if PdhGetFormattedCounterArrayW(self.c, PDH_FMT(PDH_FMT_DOUBLE.0 | 0x8000), &mut size, &mut n, Some(items)) != 0 { return json!(0); }
            let sum: f64 = std::slice::from_raw_parts(items, n as usize).iter().filter(|i| i.FmtValue.CStatus == 0).map(|i| i.FmtValue.Anonymous.doubleValue).sum();
            json!(sum.min(100.0).round() as i64)
        }
    }
}

// ---------- WMI (только чтение) ----------
pub struct Wmi { svc: HashMap<String, IWbemServices> }
impl Wmi {
    pub fn new() -> Self { Wmi { svc: HashMap::new() } }
    fn svc(&mut self, ns: &str) -> Option<IWbemServices> {
        if let Some(s) = self.svc.get(ns) { return Some(s.clone()); }
        unsafe {
            let loc: IWbemLocator = CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER).ok()?;
            let s = loc.ConnectServer(&BSTR::from(ns), &BSTR::new(), &BSTR::new(), &BSTR::new(), 0, &BSTR::new(), None).ok()?;
            let _ = CoSetProxyBlanket(&s, 10 /* RPC_C_AUTHN_WINNT */, 0, PCWSTR::null(), RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, None, EOAC_NONE);
            self.svc.insert(ns.to_string(), s.clone());
            Some(s)
        }
    }
    pub fn query(&mut self, ns: &str, wql: &str, props: &[&str]) -> Vec<Map<String, Value>> {
        let mut res = Vec::new();
        let Some(s) = self.svc(ns) else { return res };
        unsafe {
            let Ok(en) = s.ExecQuery(&BSTR::from("WQL"), &BSTR::from(wql), WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY, None) else { return res };
            loop {
                let mut objs = [None];
                let mut n = 0u32;
                let _ = en.Next(WBEM_INFINITE, &mut objs, &mut n);
                if n == 0 { break; }
                let Some(o) = objs[0].take() else { break };
                let mut m = Map::new();
                for p in props {
                    let w = wide(p);
                    let mut v = VARIANT::default();
                    if o.Get(PCWSTR(w.as_ptr()), 0, &mut v, None, None).is_ok() { m.insert(p.to_string(), var(&v)); let _ = VariantClear(&mut v); }
                }
                res.push(m);
            }
        }
        res
    }
}
unsafe fn var(v: &VARIANT) -> Value {
    unsafe {
        let a = &v.Anonymous.Anonymous;
        let u = &a.Anonymous;
        match a.vt {
            VT_BSTR => json!(u.bstrVal.to_string()),
            VT_I4 | VT_INT => json!(u.lVal), VT_UI4 | VT_UINT => json!(u.lVal as u32),
            VT_I2 => json!(u.iVal), VT_UI2 => json!(u.iVal as u16), VT_UI1 => json!(u.bVal), VT_I1 => json!(u.bVal as i8),
            VT_I8 => json!(u.llVal), VT_UI8 => json!(u.llVal as u64), VT_R4 => json!(u.fltVal), VT_R8 => json!(u.dblVal),
            VT_BOOL => json!(u.boolVal.0 != 0),
            _ => Value::Null,
        }
    }
}
fn st(m: &Map<String, Value>, k: &str) -> String { match m.get(k) { Some(Value::String(s)) => s.trim().to_string(), Some(Value::Null) | None => String::new(), Some(v) => v.to_string() } }
fn num(m: &Map<String, Value>, k: &str) -> i64 { match m.get(k) { Some(Value::String(s)) => s.trim().parse().unwrap_or(0), Some(v) => v.as_i64().unwrap_or(0), None => 0 } }
fn numv(m: &Map<String, Value>, k: &str) -> Value { match m.get(k) { Some(Value::String(s)) => s.trim().parse::<i64>().map(|x| json!(x)).unwrap_or(Value::Null), Some(v) => v.clone(), None => Value::Null } }

// сводка о компьютере для инструмента «Система»
pub fn hwinfo(w: &mut Wmi) -> Value {
    let cv = reg_open(HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion");
    let os = w.query("ROOT\\CIMV2", "SELECT Caption, BuildNumber, OSArchitecture FROM Win32_OperatingSystem", &["Caption", "BuildNumber", "OSArchitecture"]).into_iter().next().unwrap_or_default();
    let cpu = w.query("ROOT\\CIMV2", "SELECT Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed FROM Win32_Processor", &["Name", "NumberOfCores", "NumberOfLogicalProcessors", "MaxClockSpeed"]).into_iter().next().unwrap_or_default();
    let board = w.query("ROOT\\CIMV2", "SELECT Manufacturer, Product FROM Win32_BaseBoard", &["Manufacturer", "Product"]).into_iter().next().unwrap_or_default();
    // видеопамять: WMI AdapterRAM упирается в 4 ГБ — точное значение в ключе драйвера (qwMemorySize)
    let mut vram: HashMap<String, i64> = HashMap::new();
    if let Some(k) = reg_open(HKEY_LOCAL_MACHINE, "SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}") {
        for sk in k.subkeys() {
            let Some(s) = reg_open(k.0, &sk) else { continue };
            if let (Some(d), Some(m)) = (s.str("DriverDesc"), s.num("HardwareInformation.qwMemorySize")) { if !d.is_empty() { vram.insert(d, m); } }
        }
    }
    let gpus: Vec<Value> = w.query("ROOT\\CIMV2", "SELECT Name, AdapterRAM, DriverVersion, CurrentHorizontalResolution, CurrentVerticalResolution, CurrentRefreshRate FROM Win32_VideoController", &["Name", "AdapterRAM", "DriverVersion", "CurrentHorizontalResolution", "CurrentVerticalResolution", "CurrentRefreshRate"])
        .into_iter().filter(|g| { let n = st(g, "Name"); !["Microsoft Basic", "Remote", "Virtual", "Parsec", "Meta"].iter().any(|x| n.contains(x)) })
        .map(|g| { let n = st(&g, "Name"); json!({ "name": n, "vram": vram.get(&n).copied().unwrap_or(num(&g, "AdapterRAM")), "driver": st(&g, "DriverVersion"), "w": numv(&g, "CurrentHorizontalResolution"), "h": numv(&g, "CurrentVerticalResolution"), "hz": numv(&g, "CurrentRefreshRate") }) }).collect();
    let types: HashMap<i64, &str> = [(20, "DDR"), (21, "DDR2"), (24, "DDR3"), (26, "DDR4"), (34, "DDR5"), (35, "LPDDR5")].into_iter().collect();
    let ram: Vec<Value> = w.query("ROOT\\CIMV2", "SELECT Capacity, ConfiguredClockSpeed, Speed, SMBIOSMemoryType, Manufacturer, PartNumber, DeviceLocator FROM Win32_PhysicalMemory", &["Capacity", "ConfiguredClockSpeed", "Speed", "SMBIOSMemoryType", "Manufacturer", "PartNumber", "DeviceLocator"])
        .into_iter().map(|r| json!({ "size": num(&r, "Capacity"), "speed": if num(&r, "ConfiguredClockSpeed") != 0 { numv(&r, "ConfiguredClockSpeed") } else { numv(&r, "Speed") }, "type": types.get(&num(&r, "SMBIOSMemoryType")).copied().unwrap_or(""), "maker": st(&r, "Manufacturer"), "part": st(&r, "PartNumber"), "slot": st(&r, "DeviceLocator") })).collect();
    let slots: i64 = w.query("ROOT\\CIMV2", "SELECT MemoryDevices FROM Win32_PhysicalMemoryArray", &["MemoryDevices"]).iter().map(|m| num(m, "MemoryDevices")).sum();
    let disks: Vec<Value> = w.query("ROOT\\CIMV2", "SELECT Model, Size, InterfaceType FROM Win32_DiskDrive", &["Model", "Size", "InterfaceType"]).into_iter().map(|d| json!({ "model": st(&d, "Model"), "size": num(&d, "Size"), "bus": st(&d, "InterfaceType") })).collect();
    let vols: Vec<Value> = w.query("ROOT\\CIMV2", "SELECT DeviceID, VolumeName, Size, FreeSpace FROM Win32_LogicalDisk WHERE DriveType=3", &["DeviceID", "VolumeName", "Size", "FreeSpace"]).into_iter().map(|v| json!({ "id": st(&v, "DeviceID"), "label": st(&v, "VolumeName"), "size": num(&v, "Size"), "free": num(&v, "FreeSpace") })).collect();
    const MEDIA: [&str; 6] = ["Unspecified", "", "", "HDD", "SSD", "SCM"];
    const BUS: [&str; 18] = ["Unknown", "SCSI", "ATAPI", "ATA", "1394", "SSA", "Fibre Channel", "USB", "RAID", "iSCSI", "SAS", "SATA", "SD", "MMC", "Virtual", "File Backed Virtual", "Storage Spaces", "NVMe"];
    let pdisks: Vec<Value> = w.query("ROOT\\Microsoft\\Windows\\Storage", "SELECT FriendlyName, MediaType, BusType FROM MSFT_PhysicalDisk", &["FriendlyName", "MediaType", "BusType"]).into_iter()
        .map(|d| { let (m, b) = (num(&d, "MediaType") as usize, num(&d, "BusType") as usize); json!({ "model": st(&d, "FriendlyName"), "media": MEDIA.get(m).copied().unwrap_or("Unspecified"), "bus": BUS.get(b).copied().unwrap_or("Unknown") }) }).collect();
    let ver = cv.as_ref().and_then(|k| k.str("DisplayVersion")).unwrap_or_default();
    let ubr = cv.as_ref().and_then(|k| k.num("UBR")).map(|x| x.to_string()).unwrap_or_default();
    json!({
        "os": { "name": st(&os, "Caption"), "ver": ver, "build": format!("{}.{}", st(&os, "BuildNumber"), ubr), "arch": st(&os, "OSArchitecture") },
        "cpu": { "name": st(&cpu, "Name"), "cores": numv(&cpu, "NumberOfCores"), "threads": numv(&cpu, "NumberOfLogicalProcessors"), "mhz": numv(&cpu, "MaxClockSpeed") },
        "board": { "maker": st(&board, "Manufacturer"), "model": st(&board, "Product") },
        "gpus": gpus, "ram": ram, "slots": slots, "disks": disks, "pdisks": pdisks, "vols": vols,
    })
}

// физические размеры экранов из EDID: «имя|ширина см|высота см»
pub fn monsizes() -> Value {
    let mut out = Vec::new();
    unsafe {
        let Ok(set) = SetupDiGetClassDevsW(Some(&GUID_DEVCLASS_MONITOR), PCWSTR::null(), None, DIGCF_PRESENT) else { return json!([]) };
        let mut d = SP_DEVINFO_DATA { cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32, ..Default::default() };
        let mut i = 0;
        while SetupDiEnumDeviceInfo(set, i, &mut d).is_ok() {
            i += 1;
            let Ok(k) = SetupDiOpenDevRegKey(set, &d, DICS_FLAG_GLOBAL.0, 0, DIREG_DEV, KEY_READ.0) else { continue };
            let key = Key(k);
            let Some((_, e)) = key.raw("EDID") else { continue };
            if e.len() < 128 { continue; }
            let mut name = String::new();
            for b in 0..4 {
                let o = 54 + b * 18;
                if e[o] == 0 && e[o + 1] == 0 && e[o + 3] == 0xFC { name = e[o + 5..o + 18].iter().take_while(|&&c| c != 0x0A).map(|&c| c as char).collect::<String>().trim().to_string(); }
            }
            if !name.is_empty() && e[21] > 0 { out.push(format!("{}|{}|{}", name, e[21], e[22])); }
        }
        let _ = SetupDiDestroyDeviceInfoList(set);
    }
    json!(out)
}

// как часто запускают программы — счётчики Windows (UserAssist, имена в ROT13): "имя|запусков|мс в фокусе|последний запуск (unix ms)"
pub fn usage() -> Value {
    let Some(k) = reg_open(HKEY_CURRENT_USER, "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\\{CEBFF5CD-ACE2-4F4F-9178-9926F41749EA}\\Count") else { return json!([]) };
    let mut out = Vec::new();
    for i in 0.. {
        let mut name = vec![0u16; 2048]; let mut nl = name.len() as u32;
        let mut data = vec![0u8; 4096]; let mut dl = data.len() as u32;
        let mut t = 0u32;
        let r = unsafe { RegEnumValueW(k.0, i, Some(PWSTR(name.as_mut_ptr())), &mut nl, None, Some(&mut t), Some(data.as_mut_ptr()), Some(&mut dl)) };
        if r.is_err() { if r.0 == 234 { continue; } break; }
        if t != 3 || dl < 68 { continue; }
        let n: String = String::from_utf16_lossy(&name[..nl as usize]).chars().map(|c| match c { 'A'..='Z' => (((c as u8 - b'A' + 13) % 26) + b'A') as char, 'a'..='z' => (((c as u8 - b'a' + 13) % 26) + b'a') as char, _ => c }).collect();
        let u32at = |o: usize| u32::from_le_bytes(data[o..o + 4].try_into().unwrap());
        let ft = i64::from_le_bytes(data[60..68].try_into().unwrap());
        let last = if ft > 116444736000000000 { (ft - 116444736000000000) / 10000 } else { 0 };
        out.push(format!("{}|{}|{}|{}", n, u32at(4), u32at(12), last));
    }
    json!(out)
}

// ---------- свойства exe: название продукта и «запускающий» exe на 1–3 уровня выше ----------
fn version_info(path: &str) -> Option<(String, String)> {
    use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
    let w = wide(path);
    unsafe {
        let n = GetFileVersionInfoSizeW(PCWSTR(w.as_ptr()), None);
        if n == 0 { return None; }
        let mut buf = vec![0u8; n as usize];
        GetFileVersionInfoW(PCWSTR(w.as_ptr()), None, n, buf.as_mut_ptr() as *mut _).ok()?;
        let q = |sub: &str| -> Option<(*const u8, u32)> {
            let s = wide(sub); let (mut p, mut l) = (std::ptr::null_mut(), 0u32);
            if VerQueryValueW(buf.as_ptr() as *const _, PCWSTR(s.as_ptr()), &mut p, &mut l).as_bool() && !p.is_null() { Some((p as *const u8, l)) } else { None }
        };
        let mut langs: Vec<String> = Vec::new();
        if let Some((p, l)) = q("\\VarFileInfo\\Translation") { if l >= 4 { let w = std::slice::from_raw_parts(p as *const u16, 2); langs.push(format!("{:04x}{:04x}", w[0], w[1])); } }
        langs.extend(["040904b0", "040904e4", "04090000"].iter().map(|s| s.to_string()));
        let get = |field: &str| -> String {
            for lg in &langs {
                if let Some((p, l)) = q(&format!("\\StringFileInfo\\{}\\{}", lg, field)) { if l > 0 { return s16(std::slice::from_raw_parts(p as *const u16, l as usize)); } }
            }
            String::new()
        };
        Some((get("ProductName"), get("FileDescription")))
    }
}
pub fn exeinfo(arg: &str) -> Value {
    let s = String::from_utf8_lossy(&img::unb64(arg)).to_string();
    json!(s.split('|').filter(|x| !x.is_empty()).map(|p| {
        let (mut name, mut launcher) = (String::new(), String::new());
        if let Some((prod, desc)) = version_info(p) {
            name = if !prod.is_empty() && prod.encode_utf16().count() <= 40 { prod.trim().to_string() } else { desc.trim().to_string() };
            if !prod.is_empty() {
                let mut dir = std::path::Path::new(p).parent().map(|d| d.to_path_buf());
                for _ in 0..3 {
                    dir = dir.and_then(|d| d.parent().map(|x| x.to_path_buf()));
                    let Some(d) = &dir else { break };
                    let mut ents: Vec<_> = std::fs::read_dir(d).map(|r| r.filter_map(|e| e.ok()).map(|e| e.path()).collect()).unwrap_or_default();
                    ents.sort();
                    let bad = ["unins", "update", "setup", "crash", "helper"];
                    let cand = ents.into_iter().find(|e| {
                        let f = e.file_name().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
                        f.ends_with(".exe") && e.is_file() && !bad.iter().any(|b| f.contains(b)) && version_info(&e.to_string_lossy()).map_or(false, |(pr, _)| pr.to_lowercase() == prod.to_lowercase())
                    });
                    if let Some(c) = cand { launcher = c.to_string_lossy().to_string(); break; }
                }
            }
        }
        format!("{}|{}|{}", p, name, launcher)
    }).collect::<Vec<_>>())
}

// ---------- логотип приложения из Microsoft Store по имени семейства пакета ----------
pub fn appxlogo(fam: &str) -> Value {
    use windows::Win32::Storage::Packaging::Appx::{GetPackagePathByFullName, GetPackagesByPackageFamily};
    let fw = wide(fam.trim());
    let dir = unsafe {
        let (mut count, mut blen) = (0u32, 0u32);
        let _ = GetPackagesByPackageFamily(PCWSTR(fw.as_ptr()), &mut count, None, &mut blen, None);
        if count == 0 { return Value::Null; }
        let mut names = vec![PWSTR::null(); count as usize];
        let mut buf = vec![0u16; blen as usize];
        if GetPackagesByPackageFamily(PCWSTR(fw.as_ptr()), &mut count, Some(names.as_mut_ptr()), &mut blen, Some(PWSTR(buf.as_mut_ptr()))).0 != 0 { return Value::Null; }
        let full = names[0];
        let mut pl = 0u32;
        let _ = GetPackagePathByFullName(PCWSTR(full.0), &mut pl, None);
        let mut pb = vec![0u16; pl as usize + 1];
        if GetPackagePathByFullName(PCWSTR(full.0), &mut pl, Some(PWSTR(pb.as_mut_ptr()))).0 != 0 { return Value::Null; }
        s16(&pb)
    };
    let Ok(xml) = std::fs::read_to_string(std::path::Path::new(&dir).join("AppxManifest.xml")) else { return Value::Null };
    let attr = |from: &str, a: &str| -> Option<String> { let k = format!("{}=\"", a); let i = from.find(&k)? + k.len(); Some(from[i..].split('"').next()?.to_string()) };
    let apps = xml.find("<Applications").map(|i| &xml[i..]).unwrap_or("");
    let ve = apps.find("VisualElements").map(|i| &apps[i..apps[i..].find('>').map_or(apps.len(), |e| i + e)]).unwrap_or("");
    let rel = attr(ve, "Square44x44Logo").or_else(|| attr(ve, "Square150x150Logo"))
        .or_else(|| { let i = xml.find("<Logo>")? + 6; Some(xml[i..].split('<').next()?.trim().to_string()) });
    let Some(rel) = rel else { return Value::Null };
    let full = std::path::Path::new(&dir).join(rel.replace('/', "\\"));
    let pdir = full.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let base = full.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut cands: Vec<(String, std::path::PathBuf)> = std::fs::read_dir(&pdir).map(|r| r.filter_map(|e| e.ok()).map(|e| (e.file_name().to_string_lossy().to_lowercase(), e.path())).collect()).unwrap_or_default();
    cands.retain(|(n, _)| n.starts_with(&base) && n.ends_with(".png"));
    cands.sort();
    let pick = cands.iter().find(|(n, _)| n.ends_with("targetsize-48.png") || n.ends_with("targetsize-48_altform-unplated.png"))
        .or_else(|| cands.iter().find(|(n, _)| ["targetsize-32", "targetsize-64", "targetsize-40", "targetsize-44"].iter().any(|t| n.contains(t))))
        .or_else(|| cands.iter().find(|(n, _)| ["scale-200", "scale-150", "scale-100"].iter().any(|t| n.contains(t))))
        .or(cands.first());
    match pick { Some((_, p)) => json!(p.to_string_lossy()), None if full.exists() => json!(full.to_string_lossy()), None => Value::Null }
}

// ---------- приложения «Пуска» (shell:AppsFolder): "имя|AppID" ----------
pub fn startapps() -> Value {
    use windows::Win32::UI::Shell::*;
    let mut out: Vec<String> = Vec::new();
    unsafe {
        let p = wide("shell:AppsFolder");
        let Ok(folder) = SHCreateItemFromParsingName::<_, _, IShellItem>(PCWSTR(p.as_ptr()), None) else { return json!([]) };
        let Ok(en) = folder.BindToHandler::<_, IEnumShellItems>(None, &BHID_EnumItems) else { return json!([]) };
        loop {
            let mut items = [None];
            let mut n = 0u32;
            if en.Next(&mut items, Some(&mut n)).is_err() || n == 0 { break; }
            let Some(it) = items[0].take() else { break };
            let name = it.GetDisplayName(SIGDN_NORMALDISPLAY).map(|s| { let r = s.to_string().unwrap_or_default(); CoTaskMemFree(Some(s.0 as *const _)); r }).unwrap_or_default();
            let id = it.GetDisplayName(SIGDN_PARENTRELATIVEPARSING).map(|s| { let r = s.to_string().unwrap_or_default(); CoTaskMemFree(Some(s.0 as *const _)); r }).unwrap_or_default();
            if !name.is_empty() && !id.is_empty() { out.push(format!("{}|{}", name, id)); }
        }
    }
    out.sort_by_key(|s| s.to_lowercase());
    json!(out)
}

// ---------- поиск файлов в индексе Windows Search (OLE DB, только чтение) ----------
pub struct Search { cmd: Option<windows::Win32::System::Search::IDBCreateCommand> }
impl Search {
    pub fn new() -> Self { Search { cmd: None } }
    pub fn find(&mut self, arg: &str) -> Result<Value, String> {
        let q = String::from_utf8_lossy(&img::unb64(arg)).to_lowercase();
        let words: Vec<String> = q.split_whitespace().map(|w| w.chars().filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-').collect::<String>()).filter(|w| !w.is_empty()).collect();
        if words.is_empty() { return Ok(json!([])); }
        let cond = words.iter().map(|w| format!("System.FileName LIKE '%{}%'", w)).collect::<Vec<_>>().join(" AND ");
        let sql = format!("SELECT TOP 30 System.ItemUrl, System.ItemType FROM SystemIndex WHERE SCOPE='file:' AND {} AND NOT System.ItemUrl LIKE '%/AppData/%' AND NOT System.ItemUrl LIKE '%/Start Menu/%' ORDER BY System.DateModified DESC", cond);
        let r = self.run(&sql);
        if r.is_err() { self.cmd = None; }
        r.map(|v| json!(v)).map_err(|e| e.message())
    }
    fn run(&mut self, sql: &str) -> windows::core::Result<Vec<String>> {
        use windows::Win32::System::Search::*;
        unsafe {
            if self.cmd.is_none() {
                const CLSID_COLLATOR: GUID = GUID::from_u128(0x9E175B8B_F52A_11D8_B9A5_505054503030);
                let init: IDBInitialize = CoCreateInstance(&CLSID_COLLATOR, None, CLSCTX_INPROC_SERVER)?;
                init.Initialize()?;
                let cs: IDBCreateSession = init.cast()?;
                let s = cs.CreateSession(None, &IDBCreateCommand::IID)?;
                self.cmd = Some(s.cast()?);
            }
            let c = self.cmd.as_ref().unwrap().CreateCommand(None, &ICommandText::IID)?;
            let ct: ICommandText = c.cast()?;
            let w = wide(sql);
            ct.SetCommandText(&GUID::from_u128(0xC8B521FB_5CF3_11CE_ADE5_00AA0044773D), PCWSTR(w.as_ptr()))?;
            let cmd: ICommand = ct.cast()?;
            let mut rs: Option<windows::core::IUnknown> = None;
            cmd.Execute(None, &IRowset::IID, None, None, Some(&mut rs))?;
            let rows: IRowset = rs.ok_or_else(|| windows::core::Error::from_hresult(windows::core::HRESULT(-1)))?.cast()?;
            let acc: IAccessor = rows.cast()?;
            const L: usize = 2048;
            // каждая колонка: [статус u32][длина usize][строка L байт]
            let bind = |ord: usize, off: usize| DBBINDING { iOrdinal: ord, obValue: off + 16, obLength: off + 8, obStatus: off, dwPart: (DBPART_VALUE.0 | DBPART_LENGTH.0 | DBPART_STATUS.0) as u32, dwMemOwner: DBMEMOWNER_CLIENTOWNED.0 as u32, cbMaxLen: L, wType: DBTYPE_WSTR.0 as u16, ..Default::default() };
            let b = [bind(1, 0), bind(2, L + 16)];
            let mut ha = HACCESSOR::default();
            acc.CreateAccessor(DBACCESSOR_ROWDATA.0 as u32, 2, b.as_ptr(), 0, &mut ha, None)?;
            let mut out = Vec::new();
            let mut got = 0usize;
            let mut ph: *mut usize = std::ptr::null_mut();
            let _ = (Interface::vtable(&rows).GetNextRows)(Interface::as_raw(&rows), 0, 0, 30, &mut got as *mut usize as _, &mut ph as *mut *mut usize as _);
            let hs = if ph.is_null() { &[][..] } else { std::slice::from_raw_parts(ph, got) };
            for &h in hs {
                let mut buf = vec![0u8; 2 * (L + 16)];
                if rows.GetData(h, ha, buf.as_mut_ptr() as *mut _).is_err() { continue; }
                let col = |off: usize| -> String { let st = u32::from_le_bytes(buf[off..off + 4].try_into().unwrap()); if st != 0 { return String::new(); } let ln = usize::from_le_bytes(buf[off + 8..off + 16].try_into().unwrap()).min(L - 2); s16(&buf[off + 16..off + 16 + ln].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>()) };
                let (u, t) = (col(0), col(L + 16));
                if let Some(p) = u.strip_prefix("file:") { out.push(format!("{}|{}", p.replace('/', "\\"), t)); }
            }
            if !hs.is_empty() { let _ = rows.ReleaseRows(got, ph, std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut()); CoTaskMemFree(Some(ph as *const _)); }
            let _ = acc.ReleaseAccessor(ha, None);
            Ok(out)
        }
    }
}

// ---------- веб-камера: UVC через DirectShow (IAMCameraControl, IAMVideoProcAmp) ----------
use windows::Win32::Media::DirectShow::{IAMCameraControl, IAMVideoProcAmp, IBaseFilter, ICreateDevEnum};
use windows::Win32::Media::MediaFoundation::{CLSID_SystemDeviceEnum, CLSID_VideoInputDeviceCategory};
use windows::Win32::System::Com::StructuredStorage::IPropertyBag;
const PROPS: [i32; 7] = [0, 1, 2, 3, 4, 6, 15];
const VPROPS: [i32; 9] = [0, 1, 3, 4, 5, 7, 8, 9, 13];
struct Cam { name: String, cc: Option<IAMCameraControl>, amp: Option<IAMVideoProcAmp> }
fn cams() -> Vec<Cam> {
    let mut res = Vec::new();
    unsafe {
        let Ok(de) = CoCreateInstance::<_, ICreateDevEnum>(&CLSID_SystemDeviceEnum, None, CLSCTX_INPROC_SERVER) else { return res };
        let mut em: Option<IEnumMoniker> = None;
        if de.CreateClassEnumerator(&CLSID_VideoInputDeviceCategory, &mut em, 0).is_err() { return res; }
        let Some(em) = em else { return res };
        loop {
            let mut arr = [None];
            if em.Next(&mut arr, None).0 != 0 { break; }
            let Some(m) = arr[0].take() else { break };
            let mut name = String::new();
            if let Ok(bag) = m.BindToStorage::<_, _, IPropertyBag>(None, None) {
                let mut v = VARIANT::default();
                let k = wide("FriendlyName");
                if bag.Read(PCWSTR(k.as_ptr()), &mut v, None).is_ok() { if let Value::String(s) = var(&v) { name = s; } let _ = VariantClear(&mut v); }
            }
            let f = m.BindToObject::<_, _, IBaseFilter>(None, None).ok();
            res.push(Cam { name, cc: f.as_ref().and_then(|f| f.cast().ok()), amp: f.as_ref().and_then(|f| f.cast().ok()) });
        }
    }
    res
}
fn range<F: Fn(&mut [i32; 5]) -> windows::core::Result<()>>(f: F) -> Option<[i32; 5]> { let mut r = [0i32; 5]; f(&mut r).ok().map(|_| r) }
// "номер|имя|свойство:мин:макс:шаг:по умолч.:сейчас:авто:умеет авто,...|есть ли управление"
pub fn camlist() -> Value {
    json!(cams().into_iter().enumerate().map(|(i, c)| {
        let mut props = Vec::new();
        unsafe {
            if let Some(cc) = &c.cc { for p in PROPS {
                let Some(r) = range(|r| cc.GetRange(p, &mut r[0], &mut r[1], &mut r[2], &mut r[3], &mut r[4])) else { continue };
                if r[1] <= r[0] { continue; }
                let (mut cur, mut fl) = (0, 0);
                if cc.Get(p, &mut cur, &mut fl).is_err() { cur = r[3]; }
                props.push(format!("{}:{}:{}:{}:{}:{}:{}:{}", p, r[0], r[1], r[2], r[3], cur, (fl & 1 != 0) as i32, (r[4] & 1 != 0) as i32));
            } }
            if let Some(va) = &c.amp { for p in VPROPS {
                let Some(r) = range(|r| va.GetRange(p, &mut r[0], &mut r[1], &mut r[2], &mut r[3], &mut r[4])) else { continue };
                if r[1] <= r[0] { continue; }
                let (mut cur, mut fl) = (0, 0);
                if va.Get(p, &mut cur, &mut fl).is_err() { cur = r[3]; }
                props.push(format!("{}:{}:{}:{}:{}:{}:{}:{}", 100 + p, r[0], r[1], r[2], r[3], cur, (fl & 1 != 0) as i32, (r[4] & 1 != 0) as i32));
            } }
        }
        format!("{}|{}|{}|{}", i, c.name, props.join(","), c.cc.is_some() as i32)
    }).collect::<Vec<_>>())
}
// установить свойство; auto=1 — вернуть камере автоматический режим
pub fn camset(arg: &str) -> Value {
    let w: Vec<i32> = arg.split(' ').map(|x| x.parse().unwrap_or(0)).collect();
    let g = |i: usize| w.get(i).copied().unwrap_or(0);
    let (dev, prop, val, auto) = (g(0), g(1), g(2), g(3));
    let cs = cams();
    let c = if dev >= 0 { cs.get(dev as usize) } else { None };
    let fl = if auto == 1 { 1 } else { 2 };
    let hex = |e: windows::core::Error| format!("err:{:X}", e.code().0 as u32);
    unsafe {
        if prop >= 100 {
            let Some(va) = c.and_then(|c| c.amp.as_ref()) else { return json!("nodev") };
            let p = prop - 100;
            let Some(r) = range(|r| va.GetRange(p, &mut r[0], &mut r[1], &mut r[2], &mut r[3], &mut r[4])) else { return json!("noprop") };
            let res = va.Set(p, val.clamp(r[0], r[1].max(r[0])), fl);
            let (mut cur, mut f2) = (0, 0); let _ = va.Get(p, &mut cur, &mut f2);
            return json!(match res { Ok(_) => format!("ok:{}", cur), Err(e) => hex(e) });
        }
        let Some(cc) = c.and_then(|c| c.cc.as_ref()) else { return json!("nodev") };
        let Some(r) = range(|r| cc.GetRange(prop, &mut r[0], &mut r[1], &mut r[2], &mut r[3], &mut r[4])) else { return json!("noprop") };
        let res = cc.Set(prop, val.clamp(r[0], r[1].max(r[0])), fl);
        let (mut cur, mut f2) = (0, 0); let _ = cc.Get(prop, &mut cur, &mut f2);
        json!(match res { Ok(_) => format!("ok:{}", cur), Err(e) => hex(e) })
    }
}

// освободить память: сброс рабочего набора; ответ — личная память процесса, МБ
pub fn trim() -> Value {
    use windows::Win32::System::ProcessStatus::{EmptyWorkingSet, K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
    use windows::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let p = GetCurrentProcess();
        let _ = EmptyWorkingSet(p);
        let mut m = PROCESS_MEMORY_COUNTERS_EX { cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32, ..Default::default() };
        let _ = K32GetProcessMemoryInfo(p, &mut m as *mut _ as *mut PROCESS_MEMORY_COUNTERS, m.cb);
        json!((m.PrivateUsage as f64 / 1048576.0).round() as i64)
    }
}
