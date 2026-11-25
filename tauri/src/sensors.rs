// Опрос датчиков по расписанию — как sensors.js: что опрашивать и как часто, решает страница (sensors-need),
// раскрытый нотч опрашивается чаще. Результат уходит в окно событием «sensors».
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::settings::Settings;
use crate::worker::Worker;

struct St { need: Value, next: HashMap<&'static str, Instant>, net: Option<(Instant, u64, u64)> }

#[derive(Clone)]
pub struct Sensors { st: Arc<Mutex<St>> }

// быстрые — в потоке fast, медленные — в потоке slow (Bluetooth и приёмники не задерживают звук и раскладку)
const FAST: [&str; 4] = ["layout", "audio", "media", "stats"];
const SLOW: [&str; 3] = ["net", "hid", "bt"];

fn period(key: &str, need: &Value) -> u64 {
    let n = |k: &str| need.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    let open = n("open");
    match key {
        "layout" => if n("layout") { if open { 700 } else { 1500 } } else { 0 },
        "audio" => if n("audio") || open { if open { 1500 } else { 6000 } } else { 0 },
        "media" => if n("media") || open { if open { 1500 } else { 5000 } } else { 0 },
        "net" => if n("net") { if open { 2000 } else { 8000 } } else { 0 },
        "hid" => if n("bt") || open { 60000 } else { 0 },
        "bt" => if n("bt") || open { 120000 } else { 0 },
        "stats" => if n("stats") || open { if open { 2000 } else { 6000 } } else { 0 },
        _ => 0,
    }
}

impl Sensors {
    pub fn start(app: AppHandle, fast: Worker, slow: Worker, settings: Settings) -> Sensors {
        let s = Sensors { st: Arc::new(Mutex::new(St { need: json!({}), next: HashMap::new(), net: None })) };
        for (keys, w) in [(&FAST[..], fast), (&SLOW[..], slow)] {
            let (s2, app2, set2) = (s.clone(), app.clone(), settings.clone());
            std::thread::spawn(move || loop {
                // ближайший по времени опрос из своей группы
                let due = {
                    let st = s2.st.lock().unwrap();
                    keys.iter().filter(|k| period(k, &st.need) > 0).map(|k| (*k, st.next.get(*k).copied().unwrap_or_else(Instant::now))).min_by_key(|x| x.1)
                };
                match due {
                    Some((k, at)) if at <= Instant::now() => {
                        let p = period(k, &s2.st.lock().unwrap().need);
                        s2.st.lock().unwrap().next.insert(k, Instant::now() + Duration::from_millis(p.max(200)));
                        if let Some(v) = s2.poll(k, &w, &set2) { let _ = app2.emit("sensors", v); }
                    }
                    Some((_, at)) => std::thread::sleep((at - Instant::now()).min(Duration::from_millis(100))),
                    None => std::thread::sleep(Duration::from_millis(100)),
                }
            });
        }
        s
    }
    fn poll(&self, key: &str, w: &Worker, set: &Settings) -> Option<Value> {
        let mic = set.get("micDev").as_str().unwrap_or("").replace(char::is_whitespace, "");
        let arr = |v: Value| match v { Value::Array(a) => Value::Array(a), Value::Null => json!([]), x => json!([x]) };
        Some(match key {
            "layout" => json!({ "layout": w.call_t("layout", "", 3000).ok()? }),
            "audio" => json!({ "audio": w.call_t("audio", &mic, 4000).ok()? }),
            "media" => json!({ "media": w.call_t("media", "", 6000).ok()? }),
            "stats" => json!({ "stats": stats() }),
            "bt" => json!({ "bt": arr(w.call_t("bt", "", 40000).ok()?) }),
            "hid" => json!({ "hid": arr(w.call_t("hidbat", "", 15000).ok()?) }),
            "net" => {
                let mut n = w.call_t("net", "", 10000).ok()?;
                let (rx, tx) = (n["rx"].as_u64().unwrap_or(0), n["tx"].as_u64().unwrap_or(0));
                let now = Instant::now();
                let mut st = self.st.lock().unwrap();
                let (rxs, txs) = match st.net { Some((t, r, x)) => { let dt = (now - t).as_secs_f64().max(0.001); ((rx.saturating_sub(r)) as f64 / dt, (tx.saturating_sub(x)) as f64 / dt) } None => (0.0, 0.0) };
                st.net = Some((now, rx, tx));
                n["rxs"] = json!(rxs); n["txs"] = json!(txs);
                json!({ "net": n })
            }
            _ => return None,
        })
    }
    pub fn need(&self, n: Value) {
        let mut st = self.st.lock().unwrap();
        // что стало нужно или чаще — опросить сразу
        for k in FAST.iter().chain(SLOW.iter()) { if period(k, &n) != period(k, &st.need) { st.next.insert(k, Instant::now()); } }
        st.need = n;
    }
    pub fn refresh(&self, key: &str) { self.refresh_later(key, 0); }
    pub fn refresh_later(&self, key: &str, ms: u64) {
        if let Some(k) = FAST.iter().chain(SLOW.iter()).find(|k| **k == key) { self.st.lock().unwrap().next.insert(k, Instant::now() + Duration::from_millis(ms)); }
    }
}

// процессор, память, время работы — как getStats() в Electron-версии
pub fn stats() -> Value {
    use windows::Win32::System::SystemInformation::{GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows::Win32::System::Threading::GetSystemTimes;
    use windows::Win32::Foundation::FILETIME;
    static LAST: Mutex<Option<(u64, u64)>> = Mutex::new(None);
    let ft = |f: FILETIME| ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64;
    let (mut i, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    let mut cpu = 0;
    unsafe {
        if GetSystemTimes(Some(&mut i), Some(&mut k), Some(&mut u)).is_ok() {
            let (idle, total) = (ft(i), ft(k) + ft(u));
            let mut l = LAST.lock().unwrap();
            if let Some((li, lt)) = *l { let (di, dt) = (idle - li, total - lt); if dt > 0 { cpu = (100.0 * (1.0 - di as f64 / dt as f64)).round() as i64; } }
            *l = Some((idle, total));
        }
    }
    let mut m = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    unsafe { let _ = GlobalMemoryStatusEx(&mut m); }
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    json!({
        "cpu": cpu.clamp(0, 100), "memUsed": m.ullTotalPhys - m.ullAvailPhys, "memTotal": m.ullTotalPhys,
        "uptime": unsafe { GetTickCount64() } / 1000, "host": std::env::var("COMPUTERNAME").unwrap_or_default(), "ip": "",
        "cpuName": "", "cores": cores,
    })
}
