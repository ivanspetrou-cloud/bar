// Bar на Tauri — главный процесс на Rust вместо Electron. Интерфейс тот же (src/ui → tauri/dist),
// window.bar из bar-tauri.js шлёт сюда всё одной командой ipc(канал, аргументы); события идут обратно через emit.
// Работа с Windows — библиотека bar-agent (тот же код, что у bar-agent.exe), прямо в этом процессе, в фоновых потоках.
#![windows_subsystem = "windows"]

mod alttab;
mod apps;
mod bridge;
mod capture;
mod clip;
mod crypto;
mod ctx;
mod dwmthumb;
mod game;
mod migrate;
mod music;
mod notch;
mod sensors;
mod settings;
mod shell;
mod taskbar;
mod tray;
mod trayhost;
mod updater;
mod webview;
mod worker;

use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewWindow};

pub struct Shared {
    pub notch: notch::Notch,
    pub settings: settings::Settings,
    pub fast: worker::Worker,  // звук, раскладка, трек, окна — быстрые запросы
    pub slow: worker::Worker,  // Bluetooth, заряд приёмников, сеть, сведения о системе, списки
    pub act: worker::Worker,   // действия: медиа-клавиши, тема, камера, OCR, превью окон, панель задач
    pub icon: worker::Worker,  // иконки программ (их бывает много подряд — не задерживают звук и раскладку)
    pub watch: worker::Worker, // всплывашка громкости: ожидание изменения звука
    pub gpu: worker::Worker,   // загрузка видеокарты (счётчики Windows держатся открытыми)
}

fn arg(a: &[Value], i: usize) -> Value { a.get(i).cloned().unwrap_or(Value::Null) }
fn s(v: &Value) -> String { match v { Value::String(x) => x.clone(), Value::Null => String::new(), x => x.to_string() } }
fn list(v: Value) -> Vec<String> { match v { Value::Array(a) => a.iter().map(s).collect(), Value::Null => vec![], x => vec![s(&x)] } }

#[tauri::command]
async fn ipc(app: AppHandle, webview: WebviewWindow, ch: String, args: Vec<Value>) -> Result<Value, String> {
    let label = webview.label().to_string();
    // всё, что может ждать Windows, — не в потоке окна
    tauri::async_runtime::spawn_blocking(move || if ctx::ready() { handle(&app, &label, &ch, &args) } else { Value::Null }).await.map_err(|e| e.to_string())
}

fn handle(app: &AppHandle, label: &str, ch: &str, a: &[Value]) -> Value {
    let sh = ctx::sh();
    let mic = || sh.settings.get("micDev").as_str().unwrap_or("").replace(char::is_whitespace, "");
    if ch.starts_with("music-") { return music::handle(ch, a); }
    if ch.starts_with("game-") || ch == "panel-state" { return game::handle(ch, a); }
    if ch.starts_with("update-") { return updater::handle(ch); }
    if ch.starts_with("hotkeys-") { return tray::handle(app, ch, a); }
    if ch.starts_with("at-") { return alttab::handle(ch, a); }
    // живые миниатюры окон (переключатель Alt+Tab, превью дока)
    if ch == "thumbs-show" || ch == "thumbs-clear" {
        let Some(w) = app.get_webview_window(label) else { return Value::Null };
        let Ok(h) = w.hwnd() else { return Value::Null };
        if ch == "thumbs-show" { dwmthumb::show(label, windows::Win32::Foundation::HWND(h.0 as *mut _), &arg(a, 0), arg(a, 1).as_bool().unwrap_or(true)); }
        else { dwmthumb::clear(label, arg(a, 0).as_bool().unwrap_or(true)); }
        return Value::Null;
    }
    if ch.starts_with("tb-") || ch.starts_with("taskbar-") || ch == "pick-exe" || ch == "pick-folder" { return taskbar::handle(label, ch, a); }
    match ch {
        // ---------- окно нотча ----------
        "win-size" => json!(sh.notch.set_mode(&s(&arg(a, 0)))),
        "interactive" => { sh.notch.set_interactive(arg(a, 0).as_bool().unwrap_or(false)); Value::Null }
        "hit-zone" => { if label == "main" { sh.notch.set_zone(&s(&arg(a, 0))); } Value::Null }
        "focus" => { sh.notch.focus(); Value::Null }
        "idle-wake" => { sh.notch.idle_wake(); Value::Null }
        "anim-boost" => Value::Null,
        "quit" => { quit(app); Value::Null }
        "debug-windows" => Value::Null,
        // ---------- настройки ----------
        "settings-get" => sh.settings.public(),
        "settings-set" => {
            let p = arg(a, 0);
            if let Some(v) = p.get("autostart") { shell::set_autostart(v.as_bool().unwrap_or(false)); }
            sh.settings.patch(&p);
            if p.get("micDev").is_some() { sensors::mic_changed(); }
            if p.get("notchOn").is_some() { sh.notch.reset_follow(); sh.notch.replace(); }
            json!(true)
        }
        // ---------- датчики ----------
        "sensors-need" => { sensors::need(arg(a, 0)); Value::Null }
        "sensors-refresh" => { sensors::refresh(&s(&arg(a, 0))); Value::Null }
        "stats" => sensors::stats(),
        "meter" => { sensors::meter(arg(a, 0).as_bool().unwrap_or(false)); Value::Null }
        "g435-read" | "g435-info" | "cam-list" | "cam-set" | "dev-diag" | "hw-info" | "gpu-load" => sensors::handle(ch, a),
        // ---------- звук, музыка, микрофон ----------
        "audio-set" => {
            let p = arg(a, 0);
            if let Some(v) = p.get("volume").and_then(|v| v.as_f64()) { let _ = sh.fast.call("setvol", &format!("{}", v.round())); }
            if let Some(v) = p.get("mute") { let _ = sh.fast.call("mute", if v.as_bool().unwrap_or(false) { "1" } else { "0" }); }
            if let Some(v) = p.get("mic") { let _ = sh.fast.call("micmute", format!("{} {}", if v.as_bool().unwrap_or(false) { 1 } else { 0 }, mic()).trim()); }
            sensors::refresh("audio");
            Value::Null
        }
        "mic-list" => json!(list(sh.fast.call("mics", "").unwrap_or(Value::Null)).iter().map(|r| {
            let p: Vec<&str> = r.split('|').collect();
            json!({ "id": p.first().unwrap_or(&""), "name": p.get(1).unwrap_or(&""), "def": p.get(2) == Some(&"1"), "comm": p.get(3) == Some(&"1") })
        }).collect::<Vec<_>>()),
        "media-ctl" => { let ok = sh.fast.call_t("mediactl", &s(&arg(a, 0)), 4000).ok().and_then(|v| v.as_bool()).unwrap_or(false); sensors::refresh_later("media", 350); json!(ok) }
        "media" => {
            let code = match s(&arg(a, 0)).as_str() { "play" => 179, "next" => 176, "prev" => 177, "volup" => 175, "voldown" => 174, "mute" => 173, _ => 0 };
            if code > 0 { let _ = sh.act.call("mediakey", &code.to_string()); }
            Value::Null
        }
        "keep-awake" => sh.act.call("__awake", if arg(a, 0).as_bool().unwrap_or(false) { "1" } else { "0" }).unwrap_or(json!(false)),
        "win-theme" => { let v = arg(a, 0); sh.act.call_t("wintheme", if v.is_null() { "" } else if v.as_bool().unwrap_or(false) { "1" } else { "0" }, 4000).unwrap_or(Value::Null) }
        "taskbar" => { let v = arg(a, 0); if v.is_null() { sh.act.call("taskbar", "") } else { sh.act.call("settaskbar", if v.as_bool().unwrap_or(false) { "1" } else { "0" }) }.unwrap_or(Value::Null) }
        // ---------- приложения, окна, раскладки, поиск ----------
        "apps-list" => json!(apps::list(arg(a, 0).as_bool().unwrap_or(false))),
        "app-usage" => apps::usage(),
        "app-icon" => apps::icon(&arg(a, 0)),
        "app-launch" => shell::app_launch(&arg(a, 0)),
        "windows" => apps::windows(),
        "layouts" => json!(list(sh.fast.call("layouts", "").unwrap_or(Value::Null)).iter().map(|r| {
            let p: Vec<&str> = r.split('|').collect();
            json!({ "hkl": p.first().unwrap_or(&""), "lang": p.get(1).unwrap_or(&""), "name": p.get(2).unwrap_or(&""), "current": p.get(3) == Some(&"1") })
        }).collect::<Vec<_>>()),
        "set-layout" => { let h = s(&arg(a, 0)); if h.trim_start_matches('-').parse::<i64>().is_err() { return Value::Null; } let v = sh.fast.call("setlayout", &h).unwrap_or(Value::Null); sensors::refresh_later("layout", 150); v }
        "win-focus" => sh.fast.call("focus", &s(&arg(a, 0))).unwrap_or(Value::Null),
        "win-min" => sh.fast.call("minimize", &s(&arg(a, 0))).unwrap_or(Value::Null),
        "win-close" => sh.fast.call("close", &s(&arg(a, 0))).unwrap_or(Value::Null),
        "find-files" => {
            let q: String = s(&arg(a, 0)).trim().chars().take(120).collect();
            if q.chars().count() < 2 { return json!([]); }
            json!(list(sh.slow.call_t("findfiles", &bar_agent::img::b64(q.as_bytes()), 4000).unwrap_or(Value::Null)).iter().map(|r| {
                let (p, t) = r.rsplit_once('|').unwrap_or((r, ""));
                let path = std::path::Path::new(p);
                json!({ "path": p, "name": path.file_name().map(|x| x.to_string_lossy()).unwrap_or_default(), "dir": path.parent().map(|x| x.to_string_lossy()).unwrap_or_default(), "isDir": t == "Directory" })
            }).collect::<Vec<_>>())
        }
        "popup-menu" => shell::popup_menu(label, &arg(a, 0)),
        "ocr-langs" => json!(list(sh.act.call_t("ocrlangs", "", 10000).unwrap_or(Value::Null)).iter().map(|r| { let (t, n) = r.split_once('|').unwrap_or((r, "")); json!({ "tag": t, "name": n }) }).collect::<Vec<_>>()),
        // ---------- захват экрана ----------
        "capture" => { let m = s(&arg(a, 0)); std::thread::spawn(move || capture::start(&m)); Value::Null }
        "ov-init" => capture::init(),
        "ov-done" => { capture::done(arg(a, 0)); Value::Null }
        // ---------- буфер обмена ----------
        "clips-get" => clip::list(),
        "clips-set" => { clip::set_list(&arg(a, 0)); Value::Null }
        "clip-read" => json!(clip::read_text()),
        "clip-write" => { clip::write_text(&s(&arg(a, 0))); Value::Null }
        "clip-image" => { let u = s(&arg(a, 0)); if let Some((_, b)) = u.split_once(',') { clip::write_png(&bar_agent::img::unb64(b)); } Value::Null }
        // ---------- файлы ----------
        "save-voice" => shell::save_voice(&s(&arg(a, 0))),
        "list-voice" => shell::list_voice(),
        "trash" => json!(shell::trash(&s(&arg(a, 0)))),
        "open-path" => { shell::open_path(&s(&arg(a, 0))); Value::Null }
        "show-in-folder" => { shell::show_in_folder(&s(&arg(a, 0))); Value::Null }
        "open-dir" => { shell::open_path(&ctx::docs_dir(&s(&arg(a, 0))).to_string_lossy()); Value::Null }
        "open-url" => { shell::open_url(&s(&arg(a, 0))); Value::Null }
        "file-info" => shell::file_info(&s(&arg(a, 0))),
        "start-drag" => { shell::start_drag(s(&arg(a, 0))); Value::Null }
        // ---------- телефон ----------
        "bridge-start" => bridge::start(&arg(a, 0)),
        "bridge-stop" => bridge::stop(),
        "bridge-files" => { bridge::set_files(&arg(a, 0)); Value::Null }
        "bridge-text-out" => { bridge::set_text(&s(&arg(a, 0))); Value::Null }
        _ => Value::Null,
    }
}

pub fn quit(app: &AppHandle) {
    // вернуть панель задач Windows и освободить место у края, сохранить наблюдения — и выйти
    taskbar::stop();
    apps::stop();
    game::stop();
    app.exit(0);
}

fn main() {
    // помощник Alt+Tab с правами администратора: без окон Bar, только перехват клавиш (см. alttab.rs)
    if std::env::args().any(|a| a == "--alttab-helper") { alttab::helper_main(); return; }
    // данные Bar и окно нотча: настройки нужны раньше окна (оно спрашивает монитор)
    let settings = settings::Settings::load();
    ctx::set_settings(settings.clone());
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| { std::thread::spawn(tray::toggle); }))
        .plugin(tray::plugin())
        .register_asynchronous_uri_scheme_protocol("barcap", |_ctx, _req, resp| {
            std::thread::spawn(move || resp.respond(tauri::http::Response::builder().header("Content-Type", "application/octet-stream").header("Access-Control-Allow-Origin", "*").body(capture::bytes()).unwrap()));
        })
        .register_asynchronous_uri_scheme_protocol("barimg", |_ctx, req, resp| {
            let path = req.uri().path().to_string();
            std::thread::spawn(move || { let (code, ct, body) = music::image(&path); resp.respond(tauri::http::Response::builder().status(code).header("Content-Type", ct).header("Access-Control-Allow-Origin", "*").header("Cache-Control", "max-age=86400").body(body).unwrap()); });
        })
        .invoke_handler(tauri::generate_handler![ipc])
        .setup(move |app| {
            let h = app.handle().clone();
            let pid = std::process::id();
            // первая установка: Bar сам включается в автозапуск (выключить — Настройки → Основное)
            if settings.first_run && ctx::DATA == "Bar" { shell::set_autostart(true); }
            let init = migrate::init_script(&ctx::data_dir());
            let notch = notch::Notch::create(&h, &init)?;
            let w = |n| worker::Worker::spawn(n, pid);
            let sh = Arc::new(Shared { notch, settings: settings.clone(), fast: w("fast"), slow: w("slow"), act: w("act"), icon: w("icon"), watch: w("watch"), gpu: w("gpu") });
            app.manage(sh.clone());
            ctx::set(h.clone(), sh.clone());
            if sh.settings.get("hidden").as_bool() != Some(true) { sh.notch.show(); }
            tray::create(&h)?;
            tray::register(&h);
            clip::start();
            sensors::start();
            apps::start();
            music::start();
            game::start();
            taskbar::start();
            alttab::start(&h);
            updater::start();
            // события окон Windows: таскбар (список окон) и нотч (развёрнутое окно → полоска)
            std::thread::spawn(|| {
                unsafe { let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_APARTMENTTHREADED); }
                let pend = Arc::new(std::sync::Mutex::new((false, false)));
                let p2 = pend.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    let (e, l) = std::mem::take(&mut *p2.lock().unwrap());
                    if e { taskbar::refresh(); }
                    if e || l { ctx::sh().notch.tuck_check(); }
                });
                bar_agent::events::winevents_with(Box::new(move |line: &str| {
                    let mut p = pend.lock().unwrap();
                    match line.chars().next() { Some('E') => p.0 = true, Some('L') => p.1 = true, _ => {} }
                }));
            });
            std::thread::spawn(|| { std::thread::sleep(std::time::Duration::from_millis(1500)); ctx::sh().notch.tuck_check(); });
            // мониторы подключили / отключили / поменяли разрешение
            let h2 = h.clone();
            if let Some(win) = h.get_webview_window("main") {
                win.on_window_event(move |e| if let tauri::WindowEvent::ScaleFactorChanged { .. } = e { let _ = &h2; ctx::sh().notch.replace(); taskbar::on_displays_changed(); });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Bar не запустился")
        .run(|app, e| { if let tauri::RunEvent::ExitRequested { api, code, .. } = e { if code.is_none() { api.prevent_exit(); } let _ = app; } });
}
