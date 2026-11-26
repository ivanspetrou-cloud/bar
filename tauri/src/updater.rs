// Обновления Bar из GitHub Releases (публичный репозиторий), как у Electron-версии:
// • проверка при запуске (через 15 с) и раз в 6 часов — запрос только к github.com, без каких-либо данных о вас;
// • скачивание и установка — только по кнопке в настройках;
// • целостность: SHA-512 скачанного установщика сверяется с latest.yml из того же релиза.
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::ctx;

const LATEST: &str = "https://github.com/ivanspetrou-cloud/bar/releases/latest/download/latest.yml";
const DL: &str = "https://github.com/ivanspetrou-cloud/bar/releases/download";
const RELEASES: &str = "https://github.com/ivanspetrou-cloud/bar/releases/latest";

struct Info { version: String, file: String, sha512: String, size: u64 }
static ST: Mutex<Option<Value>> = Mutex::new(None);
static NEXT: Mutex<Option<Info>> = Mutex::new(None);
static FILE: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

fn version() -> String { ctx::app().package_info().version.to_string() }
/// тестовые сборки (Bar Tauri / Lab) не обновляются из релизов основного Bar
fn dev() -> bool { ctx::DATA != "Bar" }
fn get() -> Value { ST.lock().unwrap().clone().unwrap_or_else(|| json!({ "state": if dev() { "dev" } else { "idle" }, "version": version() })) }
fn set(p: Value) {
    let mut s = get();
    if let Some(o) = p.as_object() { for (k, v) in o { s[k] = v.clone(); } }
    *ST.lock().unwrap() = Some(s.clone());
    ctx::emit("update", s);
}
fn log(m: &str) {
    let f = ctx::data_dir().join("update.log");
    if let Ok(mut fh) = std::fs::OpenOptions::new().create(true).append(true).open(f) { let _ = writeln!(fh, "{} {}", ctx::stamp(), m.chars().take(500).collect::<String>()); }
}
fn newer(a: &str, b: &str) -> bool {
    let p = |s: &str| s.split(['.', '-']).take(3).map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    p(a) > p(b)
}
fn parse(yml: &str) -> Option<Info> {
    let val = |k: &str| yml.lines().find_map(|l| l.trim().strip_prefix(&format!("{}:", k)).map(|v| v.trim().trim_matches('\'').trim_matches('"').to_string()));
    Some(Info { version: val("version")?, file: val("path")?, sha512: val("sha512")?, size: yml.lines().find_map(|l| l.trim().strip_prefix("size:").and_then(|v| v.trim().parse().ok())).unwrap_or(0) })
}

pub fn check() {
    if dev() { return; }
    let st = get()["state"].as_str().unwrap_or("").to_string();
    if st == "downloading" || st == "ready" || st == "checking" { return; }
    set(json!({ "state": "checking", "error": "" }));
    match ctx::http().get(LATEST).timeout(Duration::from_secs(20)).call().ok().and_then(|r| r.into_string().ok()).and_then(|t| parse(&t)) {
        Some(i) if newer(&i.version, &version()) => { set(json!({ "state": "available", "next": i.version })); *NEXT.lock().unwrap() = Some(i); }
        Some(_) => set(json!({ "state": "latest", "checkedAt": ctx::now_ms() })),
        None => set(json!({ "state": "error", "error": "Нет связи с GitHub" })),
    }
}
fn download() {
    let Some((ver, file, sha, size)) = NEXT.lock().unwrap().as_ref().map(|i| (i.version.clone(), i.file.clone(), i.sha512.clone(), i.size)) else { return };
    set(json!({ "state": "downloading", "percent": 0, "speed": 0 }));
    let dir = std::path::PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join("bar-updater");
    let _ = std::fs::create_dir_all(&dir);
    let dest = dir.join(&file);
    let r = (|| -> Result<(), String> {
        let resp = ctx::http().get(&format!("{}/v{}/{}", DL, ver, file)).timeout(Duration::from_secs(600)).call().map_err(|e| e.to_string())?;
        let total = resp.header("content-length").and_then(|v| v.parse::<u64>().ok()).unwrap_or(size);
        let mut rd = resp.into_reader();
        let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 256 * 1024];
        let (mut done, t0, mut last) = (0u64, Instant::now(), Instant::now());
        let mut all: Vec<u8> = Vec::with_capacity(total as usize);
        loop {
            let n = rd.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            all.extend_from_slice(&buf[..n]);
            done += n as u64;
            if last.elapsed() > Duration::from_millis(300) { last = Instant::now(); let sp = done as f64 / t0.elapsed().as_secs_f64().max(0.01); set(json!({ "state": "downloading", "percent": done as f64 * 100.0 / total.max(1) as f64, "speed": sp, "done": done, "total": total })); }
        }
        let got = bar_agent::img::b64(&crate::crypto::sha512(&[&all]));
        if got != sha { let _ = std::fs::remove_file(&dest); return Err("Установщик повреждён (контрольная сумма не совпала) — попробуйте ещё раз".into()); }
        Ok(())
    })();
    match r {
        Ok(()) => { log(&format!("downloaded {}", file)); *FILE.lock().unwrap() = Some(dest); set(json!({ "state": "ready", "next": ver, "percent": 100 })); }
        Err(e) => { log(&format!("download error {}", e)); set(json!({ "state": "error", "error": e })); }
    }
}
fn install() {
    let Some(f) = FILE.lock().unwrap().clone() else { return };
    set(json!({ "state": "installing" }));
    log("install requested");
    crate::taskbar::stop();
    // тихая установка; установщик сам закроет Bar, если тот ещё работает, и запустит новую версию
    if std::process::Command::new(&f).args(["/S", "--updated", "--force-run"]).spawn().is_ok() { std::thread::sleep(Duration::from_millis(400)); ctx::app().exit(0); }
    else { set(json!({ "state": "error", "error": "Установка не запустилась — скачайте установщик с GitHub", "manual": true })); }
}

pub fn start() {
    std::thread::spawn(|| { std::thread::sleep(Duration::from_secs(15)); loop { check(); std::thread::sleep(Duration::from_secs(6 * 3600)); } });
}
pub fn handle(ch: &str) -> Value {
    match ch {
        "update-get" => get(),
        "update-check" => { std::thread::spawn(check); get() }
        "update-download" => { let s = get()["state"].as_str().unwrap_or("").to_string(); if dev() || (s != "available" && s != "error") { return json!(false); } std::thread::spawn(download); json!(true) }
        "update-install" => { if get()["state"] != "ready" { return json!(false); } std::thread::spawn(install); json!(true) }
        "update-manual" => { crate::shell::open_url(RELEASES); json!(true) }
        _ => Value::Null,
    }
}
