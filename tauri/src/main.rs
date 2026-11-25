// Bar на Tauri — главный процесс на Rust вместо Electron. Интерфейс тот же (src/ui → tauri/dist),
// window.bar из bar-tauri.js шлёт сюда всё одной командой ipc(канал, аргументы); события идут обратно через emit.
// Работа с Windows — библиотека bar-agent (тот же код, что у bar-agent.exe), прямо в этом процессе, в фоновых потоках.
// Перенос идёт по частям: канал, которого здесь ещё нет, отвечает null — интерфейс это переживает.
#![windows_subsystem = "windows"]

mod notch;
mod sensors;
mod settings;
mod worker;

use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

pub struct Shared {
    pub notch: notch::Notch,
    pub sensors: sensors::Sensors,
    pub settings: settings::Settings,
    pub fast: worker::Worker,
    pub slow: worker::Worker,
    pub act: worker::Worker,
}

fn arg(args: &[Value], i: usize) -> Value { args.get(i).cloned().unwrap_or(Value::Null) }
fn s(v: &Value) -> String { match v { Value::String(x) => x.clone(), Value::Null => String::new(), x => x.to_string() } }
fn list(v: Value) -> Vec<String> { match v { Value::Array(a) => a.iter().map(s).collect(), Value::Null => vec![], x => vec![s(&x)] } }
fn b64(t: &str) -> String { bar_agent::img::b64(t.as_bytes()) }

#[tauri::command]
async fn ipc(app: AppHandle, st: State<'_, Arc<Shared>>, ch: String, args: Vec<Value>) -> Result<Value, String> {
    let sh = st.inner().clone();
    // всё, что может ждать Windows, — не в потоке окна
    tauri::async_runtime::spawn_blocking(move || Ok(handle(&app, &sh, &ch, &args))).await.map_err(|e| e.to_string())?
}

fn handle(app: &AppHandle, sh: &Shared, ch: &str, a: &[Value]) -> Value {
    let mic = || sh.settings.get("micDev").as_str().unwrap_or("").replace(char::is_whitespace, "");
    match ch {
        // ---------- окно нотча ----------
        "win-size" => json!(sh.notch.set_mode(&s(&arg(a, 0)))),
        "interactive" => { sh.notch.set_interactive(arg(a, 0).as_bool().unwrap_or(false)); Value::Null }
        "hit-zone" => { sh.notch.set_zone(&s(&arg(a, 0))); Value::Null }
        "focus" => { sh.notch.focus(); Value::Null }
        "quit" => { app.exit(0); Value::Null }
        // ---------- настройки ----------
        "settings-get" => sh.settings.public(app),
        "settings-set" => { sh.settings.patch(&arg(a, 0)); if arg(a, 0).get("micDev").is_some() { sh.sensors.refresh("audio"); } json!(true) }
        // ---------- датчики ----------
        "sensors-need" => { sh.sensors.need(arg(a, 0)); Value::Null }
        "sensors-refresh" => { sh.sensors.refresh(&s(&arg(a, 0))); Value::Null }
        "stats" => sensors::stats(),
        // ---------- звук, музыка, микрофон ----------
        "audio-set" => {
            let p = arg(a, 0);
            if let Some(v) = p.get("volume").and_then(|v| v.as_f64()) { let _ = sh.fast.call("setvol", &format!("{}", v.round())); }
            if let Some(v) = p.get("mute") { let _ = sh.fast.call("mute", if v.as_bool().unwrap_or(false) { "1" } else { "0" }); }
            if let Some(v) = p.get("mic") { let _ = sh.fast.call("micmute", format!("{} {}", if v.as_bool().unwrap_or(false) { 1 } else { 0 }, mic()).trim()); }
            sh.sensors.refresh("audio");
            Value::Null
        }
        "mic-list" => json!(list(sh.fast.call("mics", "").unwrap_or(Value::Null)).iter().map(|r| {
            let p: Vec<&str> = r.split('|').collect();
            json!({ "id": p.first().unwrap_or(&""), "name": p.get(1).unwrap_or(&""), "def": p.get(2) == Some(&"1"), "comm": p.get(3) == Some(&"1") })
        }).collect::<Vec<_>>()),
        "media-ctl" => { let ok = sh.fast.call("mediactl", &s(&arg(a, 0))).ok().and_then(|v| v.as_bool()).unwrap_or(false); sh.sensors.refresh_later("media", 350); json!(ok) }
        "media" => {
            let code = match s(&arg(a, 0)).as_str() { "play" => 179, "next" => 176, "prev" => 177, "volup" => 175, "voldown" => 174, "mute" => 173, _ => 0 };
            if code > 0 { let _ = sh.act.call("mediakey", &code.to_string()); }
            Value::Null
        }
        // ---------- окна, раскладки, система ----------
        "layouts" => json!(list(sh.fast.call("layouts", "").unwrap_or(Value::Null)).iter().map(|r| {
            let p: Vec<&str> = r.split('|').collect();
            json!({ "hkl": p.first().unwrap_or(&""), "lang": p.get(1).unwrap_or(&""), "name": p.get(2).unwrap_or(&""), "current": p.get(3) == Some(&"1") })
        }).collect::<Vec<_>>()),
        "set-layout" => { let v = sh.fast.call("setlayout", &s(&arg(a, 0))).unwrap_or(Value::Null); sh.sensors.refresh_later("layout", 150); v }
        "win-focus" => sh.fast.call("focus", &s(&arg(a, 0))).unwrap_or(Value::Null),
        "win-min" => sh.fast.call("minimize", &s(&arg(a, 0))).unwrap_or(Value::Null),
        "win-close" => sh.fast.call("close", &s(&arg(a, 0))).unwrap_or(Value::Null),
        "keep-awake" => sh.act.call("__awake", if arg(a, 0).as_bool().unwrap_or(false) { "1" } else { "0" }).unwrap_or(json!(false)),
        "win-theme" => { let v = arg(a, 0); sh.act.call("wintheme", if v.is_null() { "" } else if v.as_bool().unwrap_or(false) { "1" } else { "0" }).unwrap_or(Value::Null) }
        "taskbar" => { let v = arg(a, 0); if v.is_null() { sh.act.call("taskbar", "") } else { sh.act.call("settaskbar", if v.as_bool().unwrap_or(false) { "1" } else { "0" }) }.unwrap_or(Value::Null) }
        "ocr-langs" => json!(list(sh.act.call("ocrlangs", "").unwrap_or(Value::Null)).iter().map(|r| { let (t, n) = r.split_once('|').unwrap_or((r, "")); json!({ "tag": t, "name": n }) }).collect::<Vec<_>>()),
        "hw-info" => sh.slow.call("hwinfo", "").unwrap_or(Value::Null),
        "gpu-load" => sh.slow.call("gpu", "").unwrap_or(Value::Null),
        "find-files" => {
            let q = s(&arg(a, 0)); let q = q.trim();
            if q.chars().count() < 2 { return json!([]); }
            json!(list(sh.slow.call("findfiles", &b64(q)).unwrap_or(Value::Null)).iter().map(|r| {
                let (p, t) = r.rsplit_once('|').unwrap_or((r, ""));
                let path = std::path::Path::new(p);
                json!({ "path": p, "name": path.file_name().map(|x| x.to_string_lossy()).unwrap_or_default(), "dir": path.parent().map(|x| x.to_string_lossy()).unwrap_or_default(), "isDir": t == "Directory" })
            }).collect::<Vec<_>>())
        }
        // ---------- ещё не перенесено: безопасные пустые ответы ----------
        "update-get" | "update-check" => json!({ "state": "dev" }),
        "hotkeys-get" => json!({}),
        "clips-get" => json!([]),
        "music-status" => json!({ "ext": false, "tab": false }),
        "taskbar-get" => json!({ "on": false }),
        "game-get" => json!({ "auto": false }),
        _ => Value::Null,
    }
}

fn main() {
    let shared: Arc<std::sync::OnceLock<Arc<Shared>>> = Arc::new(std::sync::OnceLock::new());
    let sh2 = shared.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| { if let Some(w) = app.get_webview_window("main") { let _ = w.show(); } }))
        .invoke_handler(tauri::generate_handler![ipc])
        .setup(move |app| {
            let h = app.handle().clone();
            let pid = std::process::id();
            let settings = settings::Settings::load();
            let notch = notch::Notch::create(&h)?;
            let fast = worker::Worker::spawn("fast", pid);
            let slow = worker::Worker::spawn("slow", pid);
            let act = worker::Worker::spawn("act", pid);
            let sensors = sensors::Sensors::start(h.clone(), fast.clone(), slow.clone(), settings.clone());
            let sh = Arc::new(Shared { notch, sensors, settings, fast, slow, act });
            app.manage(sh.clone());
            let _ = sh2.set(sh);
            notch::tray(&h)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Bar не запустился");
    drop(shared);
}
