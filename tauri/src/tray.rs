// Горячие клавиши и значок в трее (как main.js Electron-версии).
// Ctrl+Alt+буква не используем: на Windows это AltGr (им набирают @ € { } [ ] на многих раскладках);
// Win+Shift+T / C / A / S / R / V часто заняты самой Windows — по умолчанию берём свободные.
use serde_json::{json, Map, Value};
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::ctx;

pub const DEFAULTS: [(&str, &str); 7] = [("toggle", "Super+Shift+B"), ("search", "Super+Shift+F"), ("game", "Super+Shift+G"), ("ocr", "Super+Shift+O"), ("color", "Super+Shift+D"), ("shot", "Super+Shift+X"), ("qrscan", "Super+Shift+Q")];
static STATUS: Mutex<Option<Map<String, Value>>> = Mutex::new(None);
static IDS: Mutex<Vec<(u32, String)>> = Mutex::new(Vec::new());

fn map() -> Map<String, Value> {
    let mut m: Map<String, Value> = DEFAULTS.iter().map(|(k, v)| (k.to_string(), json!(v))).collect();
    if let Some(o) = ctx::sh().settings.get("hotkeys").as_object() { for (k, v) in o { if m.contains_key(k) { m.insert(k.clone(), v.clone()); } } }
    m
}
fn status() -> Map<String, Value> { STATUS.lock().unwrap().clone().unwrap_or_default() }
fn text(a: &str) -> String { a.replace("Super", "Win").replace("Meta", "Win").replace("CommandOrControl", "Ctrl").replace("Control", "Ctrl") }
fn label(id: &str) -> String { let m = map(); match (m[id].as_str(), status().get(id).and_then(|v| v.as_str())) { (Some(a), Some("ok")) if !a.is_empty() => format!("   {}", text(a)), _ => String::new() } }
fn problem(acc: &str) -> Option<&'static str> {
    let p: Vec<&str> = acc.split('+').collect();
    let ctrl = p.contains(&"Control") || p.contains(&"CommandOrControl");
    let alt = p.contains(&"Alt"); let win = p.contains(&"Super") || p.contains(&"Meta");
    if ctrl && alt && !win { return Some("Ctrl+Alt — это AltGr: так набирают @, €, {, }, [, ] на немецкой и многих других раскладках. Возьмите Win+Shift или Ctrl+Shift."); }
    if !ctrl && !alt && !win { return Some("Нужна клавиша-модификатор: Win, Ctrl или Alt."); }
    if acc == "Super+Shift+S" || acc == "Shift+S" { return Some("Win+Shift+S занят «Ножницами» Windows."); }
    None
}
fn parse(acc: &str) -> Option<Shortcut> { acc.replace("CommandOrControl", "Control").replace("Meta", "Super").parse::<Shortcut>().ok() }

pub fn action(id: &str) {
    match id {
        "toggle" => toggle(), "search" => open_search(), "game" => crate::game::hotkey(),
        "ocr" | "color" | "shot" | "qrscan" => { let m = id.to_string(); std::thread::spawn(move || crate::capture::start(&m)); }
        _ => {}
    }
}
pub fn register(app: &AppHandle) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut st = Map::new();
    let mut ids = Vec::new();
    for (id, acc) in map() {
        let acc = acc.as_str().unwrap_or("").to_string();
        if acc.is_empty() { st.insert(id, json!("off")); continue; }
        let ok = parse(&acc).map_or(false, |s| { let r = gs.register(s).is_ok(); if r { ids.push((s.id(), id.clone())); } r });
        st.insert(id, json!(if ok { "ok" } else { "busy" }));
    }
    *STATUS.lock().unwrap() = Some(st.clone());
    *IDS.lock().unwrap() = ids;
    build_menu(app);
    ctx::emit("hotkeys", json!({ "map": map(), "status": st }));
}
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new().with_handler(|_app, s, e| {
        if e.state() != ShortcutState::Pressed { return; }
        let id = IDS.lock().unwrap().iter().find(|x| x.0 == s.id()).map(|x| x.1.clone());
        if let Some(id) = id { std::thread::spawn(move || action(&id)); }
    }).build()
}
pub fn handle(app: &AppHandle, ch: &str, a: &[Value]) -> Value {
    let arg = |i: usize| a.get(i).cloned().unwrap_or(Value::Null);
    match ch {
        "hotkeys-get" => json!({ "map": map(), "status": status(), "defaults": DEFAULTS.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<Map<_, _>>() }),
        "hotkeys-set" => {
            let id = arg(0).as_str().unwrap_or("").to_string();
            if !DEFAULTS.iter().any(|x| x.0 == id) { return json!({ "error": "Неизвестное действие" }); }
            let acc = arg(1).as_str().unwrap_or("").to_string();
            if !acc.is_empty() {
                if let Some(w) = problem(&acc) { register(app); return json!({ "error": w }); }
                if map().iter().any(|(k, v)| *k != id && v.as_str() == Some(acc.as_str())) { register(app); return json!({ "error": "Это сочетание уже назначено другому действию." }); }
                if parse(&acc).is_none() { register(app); return json!({ "error": "Такое сочетание Windows не поддерживает." }); }
            }
            let mut h = ctx::sh().settings.get("hotkeys").as_object().cloned().unwrap_or_default();
            h.insert(id.clone(), json!(acc));
            ctx::sh().settings.put("hotkeys", Value::Object(h));
            register(app);
            json!({ "ok": true, "status": status().get(&id).cloned().unwrap_or(Value::Null) })
        }
        "hotkeys-reset" => { ctx::sh().settings.put("hotkeys", json!({})); register(app); json!(true) }
        // пока пользователь записывает новое сочетание, глобальные перехваты отключены
        "hotkeys-pause" => { let _ = app.global_shortcut().unregister_all(); Value::Null }
        "hotkeys-resume" => { register(app); Value::Null }
        _ => Value::Null,
    }
}

pub fn unhide() {
    let sh = ctx::sh();
    if sh.settings.get("hidden").as_bool() == Some(true) { sh.settings.put("hidden", json!(false)); sh.notch.show(); build_menu(ctx::app()); }
}
pub fn toggle() {
    if crate::game::active() { crate::game::open_panel(); return; }
    unhide();
    ctx::emit("toggle", Value::Null);
    ctx::sh().notch.focus();
}
pub fn open_search() { unhide(); ctx::emit("search", Value::Null); ctx::sh().notch.focus(); }

pub fn build_menu(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("bar") else { return };
    let r = (|| -> tauri::Result<Menu<tauri::Wry>> {
        let sh = ctx::sh();
        let game_on = sh.settings.get("game")["auto"].as_bool().unwrap_or(true);
        let it = |id: &str, l: &str| MenuItem::with_id(app, id, l, true, None::<&str>);
        Menu::with_items(app, &[
            &it("toggle", &format!("Открыть панель{}", label("toggle")))?, &it("search", &format!("Поиск{}", label("search")))?,
            &PredefinedMenuItem::separator(app)?,
            &it("ocr", &format!("Текст с экрана{}", label("ocr")))?, &it("color", &format!("Пипетка{}", label("color")))?,
            &it("shot", &format!("Скриншот области{}", label("shot")))?, &it("qrscan", &format!("Сканировать QR{}", label("qrscan")))?,
            &PredefinedMenuItem::separator(app)?,
            &CheckMenuItem::with_id(app, "gameauto", "Игровой режим", true, game_on, None::<&str>)?,
            &CheckMenuItem::with_id(app, "hidden", "Скрыть нотч", true, sh.settings.get("hidden").as_bool() == Some(true), None::<&str>)?,
            &it("ext", "YouTube Music: установить расширение")?,
            &PredefinedMenuItem::separator(app)?,
            &it("folder", "Папка Bar")?, &it("quit", "Выход")?,
        ])
    })();
    if let Ok(m) = r { let _ = tray.set_menu(Some(m)); }
}
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id("bar").tooltip("Bar — нотч")
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|_t, e| if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e { std::thread::spawn(toggle); })
        .on_menu_event(|app, e| {
            let id = e.id.as_ref().to_string();
            let app = app.clone();
            std::thread::spawn(move || match id.as_str() {
                "quit" => crate::quit(&app),
                "gameauto" => { let on = !ctx::sh().settings.get("game")["auto"].as_bool().unwrap_or(true); crate::game::set_auto(on); build_menu(&app); }
                "hidden" => { let sh = ctx::sh(); let h = sh.settings.get("hidden").as_bool() != Some(true); sh.settings.put("hidden", json!(h)); if h { sh.notch.hide(); } else { sh.notch.show(); } build_menu(&app); }
                "ext" => { crate::music::handle("music-install", &[]); }
                "folder" => crate::shell::open_path(&ctx::docs_dir("").to_string_lossy()),
                other => action(other),
            });
        })
        .build(app)?;
    let _ = app.get_webview_window("main");
    Ok(())
}
