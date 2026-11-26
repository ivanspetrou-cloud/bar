// Таскбар Bar: док внизу КАЖДОГО монитора вместо панели задач Windows (как taskbar.js Electron-версии).
// • Окна: события Windows (тот же хук, что у bar-agent winevents, — в этом процессе) → список окон → во все доки.
// • «Прятаться» — выезжает от нижнего края; «всегда» — виден (по желанию — с резервом места, AppBar).
// • Окно дока прозрачно для мыши, пока курсор не над доком: Rust следит за курсором (у Tauri нет «видеть курсор сквозь окно»).
// • Панель Windows прячется, пока таскбар Bar включён, и возвращается при выключении или выходе.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, Monitor, WebviewUrl, WebviewWindowBuilder};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::ctx;

const SIZES: [(&str, f64); 3] = [("s", 44.0), ("m", 52.0), ("l", 62.0)];
const EDGE: f64 = 8.0;
const WIN_H: f64 = 420.0;

struct Dock { label: String, hwnd: isize, mon: Monitor, id: String, zoom: f64, zone: Option<(f64, f64, f64, f64)>, clickable: bool, page: bool, hover: bool,
    game: bool, full: bool, peek: bool, edge_at: Option<Instant>, leave_at: Option<Instant>, visible: bool, reserved: bool, hiding: bool }
#[derive(Default)]
struct St { on: bool, docks: Vec<Dock>, list: Value, thumbs: HashMap<i64, String>, last_fg: i64, mm: HashMap<String, f64>, gen: u64 }
static S: Mutex<Option<St>> = Mutex::new(None);
fn with<R>(f: impl FnOnce(&mut St) -> R) -> R { f(S.lock().unwrap().get_or_insert_with(St::default)) }

/// событие во все доки (на всех мониторах)
pub fn emit_docks(ch: &str, v: Value) { let labels = with(|s| s.docks.iter().map(|d| d.label.clone()).collect::<Vec<_>>()); for l in labels { ctx::emit_to(&l, ch, v.clone()); } }
/// приёмник значков трея — только пока док включён и в нём есть кнопка «Значки трея»
fn tray_sync() { let c = cfg(); crate::trayhost::set(c["on"] == true && c["btn"]["tray"] != false); }
fn cfg() -> Value {
    let t = ctx::sh().settings.get("taskbar");
    let mut c = json!({ "on": false, "mode": "hide", "size": "m", "magnify": true, "reserve": false, "sizes": {}, "same": true, "running": true, "extras": [] });
    if let Some(o) = t.as_object() { for (k, v) in o { c[k] = v.clone(); } }
    let mut btn = json!({ "start": true, "search": true, "desktop": true, "restart": true, "shutdown": true, "tray": true });
    if let Some(o) = t["btn"].as_object() { for (k, v) in o { btn[k] = v.clone(); } }
    c["btn"] = btn;
    c
}
fn size_of(id: &str) -> String { let c = cfg(); c["sizes"][id].as_str().or(c["size"].as_str()).unwrap_or("m").to_string() }
fn size_px(id: &str) -> f64 { let s = size_of(id); SIZES.iter().find(|x| x.0 == s).map_or(52.0, |x| x.1) }
fn mon_id(m: &Monitor) -> String { crate::notch::mon_id(m) }
fn act(cmd: &str, arg: &str) -> Value { ctx::sh().act.call_t(cmd, arg, 4000).unwrap_or(Value::Null) }
fn displays() -> Value {
    let n = &ctx::sh().notch.win;
    let prim = n.primary_monitor().ok().flatten().map(|m| mon_id(&m));
    json!(n.available_monitors().unwrap_or_default().iter().enumerate().map(|(i, m)| json!({ "id": mon_id(m), "n": i + 1, "w": m.size().width, "h": m.size().height, "primary": Some(mon_id(m)) == prim, "size": size_of(&mon_id(m)) })).collect::<Vec<_>>())
}
fn cfg_for(d: &Dock) -> Value { let mut c = cfg(); c["size"] = json!(size_of(&d.id)); c["zoom"] = json!(d.zoom); c }

// ---------- одинаковый размер в сантиметрах на всех мониторах (размеры экранов — из EDID) ----------
fn load_mm() {
    let rows = ctx::sh().act.call_t("monsizes", "", 15000).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
    let mut mm = HashMap::new();
    for r in rows { let p: Vec<&str> = r.as_str().unwrap_or("").split('|').collect(); if p.len() >= 4 { if let Ok(w) = p[1].parse::<f64>() { mm.insert(p[3].to_uppercase(), w * 10.0); } } }
    with(|s| s.mm = mm);
}
// код модели монитора Windows (\\.\DISPLAY1 → …#GSM5B7F#…)
fn hw_id(m: &Monitor) -> String {
    use windows::Win32::Graphics::Gdi::{EnumDisplayDevicesW, DISPLAY_DEVICEW};
    let name = m.name().cloned().unwrap_or_default();
    let w: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let mut dd = DISPLAY_DEVICEW { cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32, ..Default::default() };
    if !unsafe { EnumDisplayDevicesW(windows::core::PCWSTR(w.as_ptr()), 0, &mut dd, 1) }.as_bool() { return String::new(); }
    let id = String::from_utf16_lossy(&dd.DeviceID).to_uppercase();
    id.split('#').nth(1).unwrap_or("").to_string()
}
fn mm_per_px(m: &Monitor) -> Option<f64> { let w = with(|s| s.mm.get(&hw_id(m)).copied())?; Some(w / m.size().width as f64) }
fn zoom_of(m: &Monitor, all: &[Monitor]) -> f64 {
    if cfg()["same"].as_bool() == Some(false) { return 1.0; }
    let Some(mine) = mm_per_px(m) else { return 1.0 };
    let refv = all.iter().filter_map(mm_per_px).fold(f64::MAX, f64::min);
    if refv == f64::MAX || all.len() < 2 { return 1.0; }
    // в CSS-пикселях: физический пиксель × масштаб Windows
    let css = |x: f64, k: f64| x * k;
    let r = all.iter().filter_map(|x| mm_per_px(x).map(|v| (v, x.scale_factor()))).min_by(|a, b| a.0.partial_cmp(&b.0).unwrap()).unwrap();
    (css(r.0, r.1) / css(mine, m.scale_factor())).clamp(0.5, 2.0)
}

// окна дока двигаем и прячем напрямую через Windows (по сохранённому окну): без ожидания главного потока Tauri
fn hw(d: &Dock) -> HWND { HWND(d.hwnd as *mut _) }
fn place(d: &Dock) {
    let k = d.mon.scale_factor();
    let h = (WIN_H * k).round() as i32;
    let (x, y, mw, mh) = (d.mon.position().x, d.mon.position().y, d.mon.size().width as i32, d.mon.size().height as i32);
    unsafe { let _ = SetWindowPos(hw(d), None, x, y + mh - h, mw, h, SWP_NOZORDER | SWP_NOACTIVATE); }
}
// прозрачность для мыши: то же, что делает Tauri (WS_EX_TRANSPARENT + WS_EX_LAYERED), только сразу
fn set_click(d: &Dock, on: bool) {
    unsafe {
        let ex = GetWindowLongPtrW(hw(d), GWL_EXSTYLE);
        let t = (WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0) as isize; // оба флага, как set_ignore_cursor_events у Tauri: «многослойное» окно без прозрачности ловит мышь только местами
        let nx = if on { ex & !t } else { ex | t };
        if nx != ex { SetWindowLongPtrW(hw(d), GWL_EXSTYLE, nx); }
    }
}
fn reserve(d: &mut Dock, on: bool) {
    let h = d.hwnd;
    if on {
        let k = d.mon.scale_factor();
        let hh = ((size_px(&d.id) + EDGE * 2.0) * d.zoom * k).round() as i32;
        let (x, y, w, mh) = (d.mon.position().x, d.mon.position().y, d.mon.size().width as i32, d.mon.size().height as i32);
        act("appbar", &format!("{} {} {} {} {} {}", h, x, y + mh - hh, x + w, y + mh, 0x0400 + 77));
        d.reserved = true;
    } else if d.reserved { d.reserved = false; act("appbaroff", &h.to_string()); }
}
// В игре и полноэкранном видео док прячется. Раньше окно пропадало и появлялось мгновенно — док «телепортировался».
// Теперь страница сначала плавно уводит его вниз (tb-away), окно прячется после анимации; при показе — наоборот.
fn visible_sync(d: &mut Dock) {
    let hide = (d.game || d.full) && !d.peek;
    if hide && d.visible && !d.hiding {
        d.hiding = true;
        ctx::emit_to(&d.label, "tb-away", json!(true));
        let label = d.label.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(450));
            with(|s| if let Some(d) = s.docks.iter_mut().find(|d| d.label == label) {
                if d.hiding { unsafe { let _ = ShowWindow(hw(d), SW_HIDE); } d.visible = false; d.hiding = false; }
            });
        });
    } else if !hide && d.hiding {
        d.hiding = false; // передумали прятать (мышь у края) — окно ещё видно, просто вернуть док
        ctx::emit_to(&d.label, "tb-away", json!(false));
    } else if !hide && !d.visible {
        unsafe { let _ = ShowWindow(hw(d), SW_SHOWNOACTIVATE); }
        d.visible = true;
        ctx::emit_to(&d.label, "tb-away", json!(false)); // страница уже в положении «внизу» — док выезжает
    }
}

fn create(m: &Monitor, all: &[Monitor], n: usize) -> Option<Dock> {
    let id = mon_id(m);
    let label = format!("dock{}", n);
    let app = ctx::app().clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let l2 = label.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let w = WebviewWindowBuilder::new(&app, &l2, WebviewUrl::App("taskbar.html".into())).additional_browser_args(crate::webview::ARGS)
            .title("Bar — таскбар").decorations(false).transparent(true).always_on_top(true).skip_taskbar(true).resizable(false)
            .shadow(false).focused(false).visible(false).disable_drag_drop_handler().build();
        if let Ok(w) = &w {
            crate::webview::attach(w);
            crate::webview::low_memory(w, true); // док простой — экономный режим памяти WebView2
            let _ = w.set_ignore_cursor_events(true);
            // окно дока не забирает фокус у программ (как focusable: false в Electron)
            if let Ok(h) = w.hwnd() { unsafe {
                let h = HWND(h.0 as *mut _);
                let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
                SetWindowLongPtrW(h, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize);
            } }
        }
        let _ = tx.send(w.ok().and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize));
    });
    let hwnd = rx.recv().ok().flatten()?;
    let d = Dock { label, hwnd, mon: m.clone(), id, zoom: zoom_of(m, all), zone: None, clickable: false, page: false, hover: false, game: false, full: false, peek: false, edge_at: None, leave_at: None, visible: false, reserved: false, hiding: false };
    place(&d);
    Some(d)
}

// ---------- список окон ----------
fn mon_of_rect(rect: &str, mons: &[Monitor]) -> String {
    let v: Vec<i32> = rect.split(',').map(|x| x.parse().unwrap_or(0)).collect();
    if v.len() == 4 { let (cx, cy) = ((v[0] + v[2]) / 2, (v[1] + v[3]) / 2);
        if let Some(m) = mons.iter().find(|m| cx >= m.position().x && cx < m.position().x + m.size().width as i32 && cy >= m.position().y && cy < m.position().y + m.size().height as i32) { return mon_id(m); } }
    mons.first().map(mon_id).unwrap_or_default()
}
pub fn refresh() {
    if !with(|s| s.on) { return; }
    let Ok(rows) = ctx::sh().fast.call_t("taskwins", "", 4000) else { return };
    let mons = ctx::sh().notch.win.available_monitors().unwrap_or_default();
    let me = std::env::current_exe().map(|p| p.to_string_lossy().to_lowercase()).unwrap_or_default();
    let list: Vec<Value> = rows.as_array().cloned().unwrap_or_default().iter().filter_map(|r| {
        let p: Vec<&str> = r.as_str()?.split('|').collect();
        if p.len() < 7 { return None; }
        let (exe, title) = (p[2], p[6..].join("|"));
        if exe.is_empty() || exe.to_lowercase() == me { return None; }
        let le = exe.to_lowercase();
        if (le.ends_with(r"\bar.exe") || le.ends_with(r"\bar lab.exe") || le.ends_with(r"\electron.exe") || le.ends_with(r"\bar-tauri.exe")) && (title.starts_with("Bar")) { return None; }
        Some(json!({ "hwnd": p[0].parse::<i64>().unwrap_or(0), "pid": p[1].parse::<i64>().unwrap_or(0), "exe": exe, "min": p[3] == "1", "active": p[4] == "1", "disp": mon_of_rect(p[5], &mons), "title": title }))
    }).collect();
    for w in &list { crate::apps::note_exe(w["exe"].as_str().unwrap_or("")); }
    let fg = list.iter().find(|w| w["active"].as_bool() == Some(true) && w["min"].as_bool() != Some(true)).and_then(|w| w["hwnd"].as_i64()).unwrap_or(0);
    let labels = with(|s| { s.list = json!(list); s.docks.iter().map(|d| d.label.clone()).collect::<Vec<_>>() });
    for l in labels { ctx::emit_to(&l, "tb-wins", json!(list)); }
    if fg != 0 && with(|s| { let c = s.last_fg != fg; s.last_fg = fg; c }) { std::thread::spawn(|| { std::thread::sleep(Duration::from_millis(700)); snap_fg(); }); }
}
// свёрнутое окно Windows не рисует — держим свежий снимок активного окна, чтобы у свёрнутых было превью
fn snap_fg() {
    let fg = with(|s| s.list.as_array().and_then(|l| l.iter().find(|w| w["active"].as_bool() == Some(true) && w["min"].as_bool() != Some(true)).and_then(|w| w["hwnd"].as_i64())));
    let Some(fg) = fg else { return };
    let r = ctx::sh().act.call_t("winthumbs", &fg.to_string(), 4000).ok().and_then(|v| v.as_array().and_then(|a| a.first().and_then(|x| x.as_str().map(String::from)))).unwrap_or_default();
    if let Some((_, b)) = r.split_once('|') { if b.len() > 100 { with(|s| { s.thumbs.insert(fg, format!("data:image/jpeg;base64,{}", b)); if s.thumbs.len() > 60 { let k = *s.thumbs.keys().next().unwrap(); s.thumbs.remove(&k); } }); } }
}
pub fn thumbs(hwnds: &Value) -> Value {
    let ids: Vec<i64> = hwnds.as_array().map(|a| a.iter().filter_map(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64))).take(8).collect()).unwrap_or_default();
    if ids.is_empty() { return json!({}); }
    let rows = ctx::sh().act.call_t("winthumbs", &ids.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","), 6000).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
    with(|s| {
        for r in rows { if let Some((h, b)) = r.as_str().and_then(|x| x.split_once('|')) { if b.len() > 100 { s.thumbs.insert(h.parse().unwrap_or(0), format!("data:image/jpeg;base64,{}", b)); } } }
        let mut o = serde_json::Map::new();
        for h in &ids { if let Some(t) = s.thumbs.get(h) { o.insert(h.to_string(), json!(t)); } }
        Value::Object(o)
    })
}

// ---------- панель Windows ----------
fn hide_win_taskbar() {
    let sh = ctx::sh();
    if sh.settings.get("tbPrevAutoHide").is_null() { let v = act("taskbar", ""); sh.settings.put("tbPrevAutoHide", json!(v.as_bool().unwrap_or(false))); }
    act("settaskbar", "1");
    act("hidetaskbar", "1");
}
pub fn restore_win_taskbar() {
    let sh = ctx::sh();
    let prev = sh.settings.get("tbPrevAutoHide");
    if prev.is_null() { return; }
    act("hidetaskbar", "0");
    act("settaskbar", if prev.as_bool() == Some(true) { "1" } else { "0" });
    sh.settings.remove("tbPrevAutoHide");
}

fn sync_displays() {
    let mons = ctx::sh().notch.win.available_monitors().unwrap_or_default();
    let ids: Vec<String> = mons.iter().map(mon_id).collect();
    let (gone, have): (Vec<String>, Vec<String>) = with(|s| { let g = s.docks.iter().filter(|d| !ids.contains(&d.id)).map(|d| d.label.clone()).collect(); s.docks.retain(|d| ids.contains(&d.id)); (g, s.docks.iter().map(|d| d.id.clone()).collect()) });
    for l in gone { if let Some(w) = ctx::app().get_webview_window(&l) { let _ = w.destroy(); } }
    for (i, m) in mons.iter().enumerate() {
        if have.contains(&mon_id(m)) { continue; }
        let n = with(|s| { s.gen += 1; s.gen as usize }) + i * 0;
        if let Some(d) = create(m, &mons, n) { with(|s| s.docks.push(d)); }
    }
    let reserve_on = cfg()["mode"] == "always" && cfg()["reserve"] == true;
    let zooms: Vec<(String, f64)> = mons.iter().map(|m| (mon_id(m), zoom_of(m, &mons))).collect(); // zoom_of сам берёт блокировку — считаем заранее
    with(|s| for d in s.docks.iter_mut() {
        if let Some(m) = mons.iter().find(|m| mon_id(m) == d.id) { d.mon = m.clone(); d.zoom = zooms.iter().find(|z| z.0 == d.id).map_or(1.0, |z| z.1); }
        place(d); reserve(d, reserve_on); visible_sync(d);
        ctx::emit_to(&d.label, "tb-cfg", cfg_for(d));
    });
}

pub fn enable() {
    with(|s| s.on = true);
    if with(|s| s.mm.is_empty()) { load_mm(); }
    sync_displays();
    hide_win_taskbar();
    refresh();
}
pub fn disable() {
    let labels = with(|s| { s.on = false; s.thumbs.clear(); for d in s.docks.iter_mut() { reserve(d, false); } let l: Vec<String> = s.docks.iter().map(|d| d.label.clone()).collect(); s.docks.clear(); l });
    for l in labels { if let Some(w) = ctx::app().get_webview_window(&l) { let _ = w.destroy(); } }
    restore_win_taskbar();
}
pub fn on_displays_changed() { if with(|s| s.on) { std::thread::spawn(|| { std::thread::sleep(Duration::from_millis(300)); sync_displays(); }); } }
pub fn stop() { crate::trayhost::set(false); with(|s| for d in s.docks.iter_mut() { reserve(d, false); }); restore_win_taskbar(); }

/// фоновые проверки: полноэкранные окна (раз в 2 с), снимок активного окна (раз в 5 с), панель Windows спрятана (раз в 10 с),
/// курсор (каждые 60 мс): у нижнего края — док выезжает, над доком — кликабелен
pub fn start() {
    if cfg()["on"] == true { std::thread::spawn(enable); } else { std::thread::spawn(restore_win_taskbar); }
    tray_sync();
    crate::trayhost::start_shellhook();
    // панель задач Windows вылезла (скриншот, клавиша Win) — убрать сразу, а не через 10 с
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(200));
        if with(|s| s.on) && bar_agent::win::tb_visible() { bar_agent::win::tb_hide(true); }
    });
    std::thread::spawn(|| { let mut n = 0u64; loop {
        std::thread::sleep(Duration::from_secs(1)); n += 1;
        if !with(|s| s.on) { continue; }
        if n % 2 == 0 { full_check(); geometry_check(); }
        if n % 5 == 0 { snap_fg(); }
        if n % 10 == 0 { act("hidetaskbar", "1"); } // на всякий случай (и вторые мониторы)
    } });
    std::thread::spawn(|| loop { std::thread::sleep(Duration::from_millis(60)); if with(|s| s.on) { cursor_tick(); } });
}
// Разрешение или расположение мониторов поменялось (игра в полноэкранном режиме со своим разрешением, подключили монитор):
// Windows сам сдвигает окна, чтобы они остались на экране, — без этой проверки док и нотч оставались там, куда их сдвинуло.
fn geometry_check() {
    static LAST: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
    let mons = ctx::sh().notch.win.available_monitors().unwrap_or_default();
    let sig: String = mons.iter().map(|m| format!("{},{},{},{},{};", m.position().x, m.position().y, m.size().width, m.size().height, m.scale_factor())).collect();
    let mut last = LAST.lock().unwrap();
    if *last == sig { return; }
    let first = last.is_empty();
    *last = sig;
    drop(last);
    if first { return; }
    ctx::sh().notch.replace();
    sync_displays();
}
fn full_check() {
    let raw = ctx::sh().fast.call_t("gamestate", "", 2000).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    let p: Vec<&str> = raw.split('|').collect();
    let full_mon = if p.first() == Some(&"1") && p.len() >= 5 { let v: Vec<i32> = p[4].split(',').map(|x| x.parse().unwrap_or(0)).collect(); if v.len() == 4 { Some((v[0], v[1])) } else { None } } else { None };
    let game = crate::game::active_mon();
    with(|s| for d in s.docks.iter_mut() {
        let pos = (d.mon.position().x, d.mon.position().y);
        let g = game == Some(pos);
        let f = full_mon == Some(pos);
        if g != d.game || f != d.full { d.game = g; d.full = f; if !g && !f { d.peek = false; } visible_sync(d); }
    });
}
fn cursor_tick() {
    let (cx, cy) = crate::notch::cursor();
    let peek_ms = cfg()["gamePeek"].as_f64().unwrap_or(500.0);
    let hide_mode = cfg()["mode"] == "hide";
    let mut ev: Vec<(String, &str, Value)> = Vec::new();
    with(|s| for d in s.docks.iter_mut() {
        let (mx, my, mw, mh) = (d.mon.position().x, d.mon.position().y, d.mon.size().width as i32, d.mon.size().height as i32);
        let k = d.mon.scale_factor();
        let in_x = cx >= mx && cx < mx + mw;
        let at_edge = in_x && cy >= my + mh - 2 && cy < my + mh; // только самый нижний край экрана
        let wy = my + mh - (WIN_H * k).round() as i32;
        let in_zone = d.zone.map_or(false, |(l, t, r, b)| { let m = 6.0; let (x, y) = ((cx - mx) as f64 / k, (cy - wy) as f64 / k); x >= l - m && x < r + m && y >= t - m && y < b + m });
        if d.game || d.full {
            // в игре: задержали мышь у края — выезжает; ушли с дока — прячется
            if peek_ms <= 0.0 { continue; }
            if !d.peek {
                d.edge_at = if at_edge { Some(d.edge_at.unwrap_or_else(Instant::now)) } else { None };
                if d.edge_at.map_or(false, |t| t.elapsed().as_millis() as f64 >= peek_ms) { d.peek = true; d.edge_at = None; d.leave_at = None; visible_sync(d); ev.push((d.label.clone(), "tb-peek", Value::Null)); }
                continue;
            }
            let near = in_x && cy >= my + mh - ((size_px(&d.id) * d.zoom + EDGE + 40.0) * k) as i32;
            d.leave_at = if near || in_zone { None } else { Some(d.leave_at.unwrap_or_else(Instant::now)) };
            if d.leave_at.map_or(false, |t| t.elapsed() > Duration::from_millis(700)) { d.peek = false; d.leave_at = None; visible_sync(d); }
        } else if hide_mode && !d.hover {
            // выезжает, если курсор задержался у самого края (не просто проскочил), — один раз на касание
            if at_edge { let t = *d.edge_at.get_or_insert_with(Instant::now); if !d.peek && t.elapsed() >= Duration::from_millis(120) { d.peek = true; ev.push((d.label.clone(), "tb-peek", Value::Null)); } }
            else { d.edge_at = None; d.peek = false; }
        }
        // над доком (и превью) — окно кликабельно, страница узнаёт о наведении
        // кликабелен только сам док (и его превью); страница сама больше не держит окно кликабельным
        if !in_zone { d.page = false; }
        let want = in_zone;
        if want != d.clickable {
            d.clickable = want;
            set_click(d, want);
        }
        if in_zone != d.hover { d.hover = in_zone; ev.push((d.label.clone(), "tb-hover", json!(in_zone))); }
    });
    for (l, ch, v) in ev { ctx::emit_to(&l, ch, v); }
}

pub fn handle(label: &str, ch: &str, a: &[Value]) -> Value {
    let arg = |i: usize| a.get(i).cloned().unwrap_or(Value::Null);
    match ch {
        "tb-search" => { crate::tray::open_search(); Value::Null } // кнопка «Поиск» в доке — поиск в нотче
        "tb-tray" => crate::trayhost::list(),
        "tb-tray-debug" => crate::trayhost::debug(),
        "tb-flash" => crate::trayhost::flashing(),
        "tb-unflash" => { let v: Vec<i64> = arg(0).as_array().map(|a| a.iter().filter_map(|x| x.as_i64()).collect()).unwrap_or_default(); crate::trayhost::unflash(&v); crate::trayhost::flashing() }
        "tb-tray-click" => { let (k, kind) = (arg(0).as_str().unwrap_or("").to_string(), arg(1).as_str().unwrap_or("left").to_string()); std::thread::spawn(move || crate::trayhost::click(&k, &kind)); Value::Null }
        "taskbar-get" => with(|s| s.docks.iter().find(|d| d.label == label).map(cfg_for)).unwrap_or_else(|| { let mut c = cfg(); c["displays"] = displays(); c }),
        "taskbar-set" => {
            let before = cfg();
            let mut t = before.clone();
            if let Some(o) = arg(0).as_object() { for (k, v) in o { t[k] = v.clone(); } }
            ctx::sh().settings.put("taskbar", t);
            let now = cfg();
            if now["on"] != before["on"] { if now["on"] == true { enable(); } else { disable(); } } else { sync_displays(); }
            tray_sync();
            let mut r = now; r["displays"] = displays(); r
        }
        "tb-interactive" => { with(|s| if let Some(d) = s.docks.iter_mut().find(|d| d.label == label) { d.page = arg(0).as_bool().unwrap_or(false); }); Value::Null }
        "tb-zone" => { let z = arg(0); if let (Some(l), Some(t), Some(r), Some(b)) = (z["l"].as_f64(), z["t"].as_f64(), z["r"].as_f64(), z["b"].as_f64()) { with(|s| if let Some(d) = s.docks.iter_mut().find(|d| d.label == label) { d.zone = Some((l, t, r, b)); }); } Value::Null }
        "tb-debug" => with(|s| json!(s.docks.iter().map(|d| json!({ "label": d.label, "zone": d.zone.map(|z| vec![z.0, z.1, z.2, z.3]), "clickable": d.clickable, "hover": d.hover, "page": d.page, "k": d.mon.scale_factor(), "mon": [d.mon.position().x, d.mon.position().y, d.mon.size().width, d.mon.size().height] })).collect::<Vec<_>>())),
        "tb-refresh" => { std::thread::spawn(|| { std::thread::sleep(Duration::from_millis(120)); refresh(); }); Value::Null }
        "tb-start" => { act("startmenu", ""); Value::Null }
        "tb-desktop" => { act("showdesktop", ""); Value::Null }
        "tb-open" => { bar_agent::win::allow_foreground(); crate::shell::place(&arg(0)); Value::Null }
        "tb-power" => { crate::shell::power(arg(0).as_str().unwrap_or("")); Value::Null }
        "tb-lock" => { crate::shell::lock(); Value::Null }
        "tb-closewin" => { if let Some(h) = arg(0).as_i64().or_else(|| arg(0).as_str().and_then(|x| x.parse().ok())) { act("closewin", &h.to_string()); std::thread::spawn(|| { std::thread::sleep(Duration::from_millis(150)); refresh(); }); } Value::Null }
        "tb-thumbs" => thumbs(&arg(0)),
        "tb-apps" => { ctx::emit("open-tool", "apps"); ctx::sh().notch.focus(); Value::Null }
        "tb-tool" => { if let Some(id) = arg(0).as_str().filter(|x| x.len() >= 2 && x.len() <= 16 && x.chars().all(|c| c.is_ascii_lowercase())) { ctx::emit("open-tool", id); ctx::sh().notch.focus(); } Value::Null }
        "pick-exe" => crate::shell::pick_exe(label),
        "pick-folder" => crate::shell::pick_folder(label),
        _ => Value::Null,
    }
}
