// Датчики (как sensors.js): опрос по расписанию — что и как часто, решает страница (sensors-need), раскрытый нотч
// опрашивается чаще. Плюс: всплывашка громкости (ожидание изменений), живой эквалайзер (уровень звука),
// заряд Logitech G435 (чтение на секунду прерывает звук — только в тишине), веб-камера, сведения об устройствах.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::ctx;
use crate::worker::Worker;

struct St { need: Value, next: HashMap<&'static str, Instant>, net: Option<(Instant, u64, u64)>, osd: bool, aw: (i64, i64, i64), meter: Option<Arc<AtomicBool>> }
static S: Mutex<Option<St>> = Mutex::new(None);
fn with<R>(f: impl FnOnce(&mut St) -> R) -> R { f(S.lock().unwrap().get_or_insert_with(|| St { need: json!({}), next: HashMap::new(), net: None, osd: false, aw: (-1, 0, 0), meter: None })) }

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
fn mic() -> String { ctx::sh().settings.get("micDev").as_str().unwrap_or("").replace(char::is_whitespace, "") }
fn arr(v: Value) -> Value { match v { Value::Array(a) => Value::Array(a), Value::Null => json!([]), x => json!([x]) } }

pub fn start() {
    let sh = ctx::sh();
    for (keys, w) in [(&FAST[..], sh.fast.clone()), (&SLOW[..], sh.slow.clone())] {
        std::thread::spawn(move || loop {
            let due = with(|st| keys.iter().filter(|k| period(k, &st.need) > 0).map(|k| (*k, st.next.get(*k).copied().unwrap_or_else(Instant::now))).min_by_key(|x| x.1));
            match due {
                Some((k, at)) if at <= Instant::now() => {
                    let p = with(|st| period(k, &st.need));
                    with(|st| st.next.insert(k, Instant::now() + Duration::from_millis(p.max(200))));
                    if let Some(v) = poll(k, &w) { ctx::emit("sensors", v); }
                }
                Some((_, at)) => std::thread::sleep((at - Instant::now()).min(Duration::from_millis(100))),
                None => std::thread::sleep(Duration::from_millis(100)),
            }
        });
    }
    // всплывашка громкости: свой поток ждёт изменения звука внутри агента (12 чтений в секунду, ответ — только при изменении)
    let watch = sh.watch.clone();
    std::thread::spawn(move || loop {
        if !with(|st| st.osd) { std::thread::sleep(Duration::from_millis(300)); continue; }
        let (v0, m0, mm0) = with(|st| st.aw);
        let r = watch.call_t("waitaudio", format!("{} {} {} 25000 {}", v0, m0, mm0, mic()).trim(), 30000);
        let Some(s) = r.ok().and_then(|v| v.as_str().map(String::from)).filter(|s| !s.is_empty()) else { std::thread::sleep(Duration::from_secs(2)); continue };
        let p: Vec<i64> = s.split('|').map(|x| x.parse().unwrap_or(0)).collect();
        if p.len() < 4 { continue; }
        let (v, m, has, mm) = (p[0], p[1], p[2], p[3]);
        let first = v0 < 0;
        let changed = !first && (v != v0 || m != m0 || mm != mm0);
        let what = if !changed { "" } else if mm != mm0 { "mic" } else if m != m0 { "mute" } else { "volume" };
        with(|st| st.aw = (v, m, mm));
        if first || changed {
            let mut o = json!({ "audio": { "volume": v, "muted": m != 0, "mic": has != 0, "micMuted": mm != 0 } });
            if !what.is_empty() { o["osd"] = json!(what); }
            ctx::emit("sensors", o);
        }
    });
}
fn poll(key: &str, w: &Worker) -> Option<Value> {
    Some(match key {
        "layout" => json!({ "layout": w.call_t("layout", "", 3000).ok()? }),
        "audio" => json!({ "audio": w.call_t("audio", &mic(), 4000).ok()? }),
        "media" => json!({ "media": w.call_t("media", "", 6000).ok()? }),
        "stats" => json!({ "stats": stats() }),
        "bt" => json!({ "bt": arr(w.call_t("bt", "", 40000).ok()?) }),
        "hid" => {
            let mut l = arr(w.call_t("hidbat", "", 15000).ok()?);
            if let Some(g) = g435_line() { l.as_array_mut().unwrap().push(json!(g)); }
            json!({ "hid": l })
        }
        "net" => {
            let mut n = w.call_t("net", "", 10000).ok()?;
            let (rx, tx) = (n["rx"].as_u64().unwrap_or(0), n["tx"].as_u64().unwrap_or(0));
            let now = Instant::now();
            let (rxs, txs) = with(|st| { let r = match st.net { Some((t, r, x)) => { let dt = (now - t).as_secs_f64().max(0.001); (rx.saturating_sub(r) as f64 / dt, tx.saturating_sub(x) as f64 / dt) } None => (0.0, 0.0) }; st.net = Some((now, rx, tx)); r });
            n["rxs"] = json!(rxs); n["txs"] = json!(txs);
            json!({ "net": n })
        }
        _ => return None,
    })
}
pub fn need(n: Value) {
    let osd = n["osd"].as_bool().unwrap_or(false);
    with(|st| {
        for k in FAST.iter().chain(SLOW.iter()) { if period(k, &n) != period(k, &st.need) { st.next.insert(k, Instant::now()); } }
        st.need = n;
        if !osd { st.aw = (-1, 0, 0); }
        st.osd = osd;
    });
}
pub fn refresh(key: &str) { refresh_later(key, 0); }
pub fn refresh_later(key: &str, ms: u64) {
    if let Some(k) = FAST.iter().chain(SLOW.iter()).find(|k| **k == key) { with(|st| st.next.insert(k, Instant::now() + Duration::from_millis(ms))); }
}
pub fn mic_changed() { refresh("audio"); with(|st| st.aw = (-1, 0, 0)); }

// ---------- живой эквалайзер: уровень звука ~20 раз в секунду, в окно — пачками ~11 раз в секунду ----------
pub fn meter(on: bool) {
    let stop = with(|st| { if on { if st.meter.is_some() { return None; } let s = Arc::new(AtomicBool::new(false)); st.meter = Some(s.clone()); Some(s) } else { if let Some(s) = st.meter.take() { s.store(true, Ordering::Relaxed); } None } });
    let Some(stop) = stop else { return };
    let buf: Arc<Mutex<Vec<f64>>> = Arc::new(Mutex::new(Vec::new()));
    let (b1, s1) = (buf.clone(), stop.clone());
    std::thread::spawn(move || {
        unsafe { let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED); }
        bar_agent::events::meter_until(&s1, &|l: &str| { if let Some(v) = l.strip_prefix("M ").and_then(|x| x.parse::<f64>().ok()) { b1.lock().unwrap().push(v); } });
    });
    std::thread::spawn(move || while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(90));
        let v: Vec<f64> = std::mem::take(&mut *buf.lock().unwrap());
        if !v.is_empty() { ctx::emit("meter", v); }
    });
}

// ---------- Logitech G435: заряд по напряжению; чтение на ~1 с прерывает звук гарнитуры ----------
fn g435_file() -> std::path::PathBuf { ctx::data_dir().join("g435.json") }
static G435: Mutex<Option<(Value, Option<(Instant, bool)>)>> = Mutex::new(None);
fn g435() -> Value { let mut g = G435.lock().unwrap(); if g.is_none() { *g = Some((std::fs::read_to_string(g435_file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({})), None)); } g.as_ref().unwrap().0.clone() }
fn g435_put(v: Value) { let _ = std::fs::write(g435_file(), v.to_string()); let mut g = G435.lock().unwrap(); let has = g.as_ref().and_then(|x| x.1); *g = Some((v, has)); }
fn g435_pct(mv: f64) -> i64 {
    const T: [(f64, f64); 11] = [(4200., 100.), (4100., 90.), (4000., 80.), (3900., 65.), (3800., 50.), (3750., 40.), (3700., 30.), (3650., 20.), (3600., 10.), (3500., 5.), (3300., 0.)];
    if mv >= T[0].0 { return 100; }
    for i in 1..T.len() { if mv >= T[i].0 { return (T[i].1 + (mv - T[i].0) / (T[i - 1].0 - T[i].0) * (T[i - 1].1 - T[i].1)).round() as i64; } }
    0
}
fn g435_has() -> bool {
    let cached = G435.lock().unwrap().as_ref().and_then(|x| x.1);
    if let Some((t, h)) = cached { if t.elapsed() < Duration::from_secs(300) { return h; } }
    let h = ctx::sh().fast.call_t("g435has", "", 4000).ok().and_then(|v| v.as_str().map(|s| !s.is_empty())).unwrap_or(false);
    let mut g = G435.lock().unwrap(); if let Some(x) = g.as_mut() { x.1 = Some((Instant::now(), h)); }
    h
}
fn g435_read() -> Value {
    let mut g = g435();
    g["tried"] = json!(ctx::now_ms());
    let r = ctx::sh().slow.call_t("g435", "", 8000).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    if let Some((name, mv)) = r.rsplit_once('|') {
        let mv: f64 = mv.parse().unwrap_or(0.0);
        g["name"] = json!(name);
        if mv > 0.0 { g["mv"] = json!(mv); g["t"] = json!(ctx::now_ms()); g["ok"] = json!(true); } else { g["ok"] = json!(false); }
    }
    g435_put(g.clone());
    g
}
fn g435_line() -> Option<String> {
    if !g435_has() { return None; }
    let mut g = g435();
    let now = ctx::now_ms();
    let ok = g["ok"].as_bool().unwrap_or(false);
    // само по себе — раз в час (после неудачи — раз в 30 минут) и только в тишине: не в игре, ничего не играет, микрофон свободен
    let due = now >= g["retryAt"].as_u64().unwrap_or(0) && g["tried"].as_u64().map_or(true, |t| now - t > if ok { 3_600_000 } else { 1_800_000 });
    if due {
        let full = ctx::sh().fast.call_t("gamestate", "", 2000).ok().and_then(|v| v.as_str().map(|s| s.starts_with("1|"))).unwrap_or(false);
        let busy = full || ctx::sh().fast.call_t("audiobusy", "", 3000).ok() != Some(json!(false));
        if busy { g["retryAt"] = json!(now + 300_000); g435_put(g.clone()); } else { g = g435_read(); }
    }
    let name0 = g["name"].as_str().unwrap_or("G435").to_string();
    let name = format!("Logitech {}", name0.split_whitespace().filter(|w| !w.eq_ignore_ascii_case("wireless") && !w.eq_ignore_ascii_case("gaming")).collect::<Vec<_>>().join(" "));
    let fresh = g["ok"].as_bool() == Some(true) && g["mv"].as_f64().is_some() && now.saturating_sub(g["t"].as_u64().unwrap_or(0)) < 7_200_000;
    Some(if fresh { format!("{}|{}|1|0|headphones", name, g435_pct(g["mv"].as_f64().unwrap_or(0.0))) } else { format!("{}|-1|0|0|headphones", name) })
}

pub fn handle(ch: &str, a: &[Value]) -> Value {
    let arg = |i: usize| a.get(i).cloned().unwrap_or(Value::Null);
    let sh = ctx::sh();
    match ch {
        "g435-read" => { let g = g435_read(); refresh("hid"); json!({ "ok": g["ok"].as_bool().unwrap_or(false), "level": g["mv"].as_f64().map(g435_pct), "has": true }) }
        "g435-info" => { let g = g435(); json!({ "has": g435_has(), "t": g["t"].as_u64().unwrap_or(0), "ok": g["ok"].as_bool().unwrap_or(false), "level": g["mv"].as_f64().map(g435_pct) }) }
        "cam-list" => json!(arr(sh.act.call_t("camlist", "", 8000).unwrap_or(Value::Null)).as_array().unwrap().iter().map(|r| {
            let p: Vec<&str> = r.as_str().unwrap_or("").split('|').collect();
            let mut props = serde_json::Map::new();
            for x in p.get(2).unwrap_or(&"").split(',').filter(|x| !x.is_empty()) {
                let n: Vec<f64> = x.split(':').map(|v| v.parse().unwrap_or(0.0)).collect();
                if n.len() >= 8 { props.insert((n[0] as i64).to_string(), json!({ "min": n[1], "max": n[2], "step": if n[3] == 0.0 { 1.0 } else { n[3] }, "def": n[4], "cur": n[5], "auto": n[6] != 0.0, "canAuto": n[7] != 0.0 })); }
            }
            json!({ "i": p.first().and_then(|x| x.parse::<i64>().ok()).unwrap_or(0), "name": p.get(1).unwrap_or(&""), "props": props, "ctl": p.get(3) == Some(&"1") })
        }).collect::<Vec<_>>()),
        "cam-set" => {
            let n: Vec<f64> = (0..3).map(|i| arg(i).as_f64().unwrap_or(f64::NAN)).collect();
            if n.iter().any(|x| !x.is_finite()) { return Value::Null; }
            sh.act.call_t("camset", &format!("{} {} {} {}", n[0] as i64, n[1] as i64, n[2].round() as i64, if arg(3).as_bool() == Some(true) { 1 } else { 0 }), 4000).unwrap_or(Value::Null)
        }
        "dev-diag" => {
            let hid = arr(sh.slow.call_t("hiddiag", "", 20000).unwrap_or(Value::Null));
            let bat = arr(sh.slow.call_t("hidbat", "", 20000).unwrap_or(Value::Null));
            let s = |v: &Value| v.as_array().unwrap().iter().map(|x| x.as_str().unwrap_or("").to_string()).collect::<Vec<_>>();
            let mut l = vec![format!("Bar {} — сведения об устройствах", ctx::app().package_info().version), String::new(), "== Заряд ==".into()];
            l.extend(s(&bat)); l.push(String::new()); l.push("== Интерфейсы ==".into()); l.extend(s(&hid));
            json!(l.join("\n"))
        }
        "hw-info" => {
            static HW: Mutex<Option<(Instant, Value)>> = Mutex::new(None);
            if let Some((t, v)) = HW.lock().unwrap().clone() { if t.elapsed() < Duration::from_secs(60) { return v; } }
            let v = sh.slow.call_t("hwinfo", "", 30000).unwrap_or(Value::Null);
            if !v.is_null() { *HW.lock().unwrap() = Some((Instant::now(), v.clone())); }
            v
        }
        "gpu-load" => sh.gpu.call_t("gpu", "", 12000).ok().filter(|v| v.is_number()).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

// процессор, память, время работы — как getStats() Electron-версии
pub fn stats() -> Value {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::SystemInformation::{GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows::Win32::System::Threading::GetSystemTimes;
    static LAST: Mutex<Option<(u64, u64)>> = Mutex::new(None);
    let ft = |f: FILETIME| ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64;
    let (mut i, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    let mut cpu = 0;
    unsafe {
        if GetSystemTimes(Some(&mut i), Some(&mut k), Some(&mut u)).is_ok() {
            let (idle, total) = (ft(i), ft(k) + ft(u));
            let mut l = LAST.lock().unwrap();
            if let Some((li, lt)) = *l { let (di, dt) = (idle.saturating_sub(li), total.saturating_sub(lt)); if dt > 0 { cpu = (100.0 * (1.0 - di as f64 / dt as f64)).round() as i64; } }
            *l = Some((idle, total));
        }
    }
    let mut m = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    unsafe { let _ = GlobalMemoryStatusEx(&mut m); }
    static CPU_NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let name = CPU_NAME.get_or_init(|| bar_agent::sys::reg_open(windows::Win32::System::Registry::HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0").and_then(|k| k.str("ProcessorNameString")).unwrap_or_default().trim().to_string());
    json!({
        "cpu": cpu.clamp(0, 100), "memUsed": m.ullTotalPhys - m.ullAvailPhys, "memTotal": m.ullTotalPhys,
        "uptime": unsafe { GetTickCount64() } / 1000, "host": std::env::var("COMPUTERNAME").unwrap_or_default(), "ip": crate::bridge::lan_ip(),
        "cpuName": name, "cores": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
    })
}
