// Игровой режим (как game.js): окно на переднем плане закрывает весь монитор и это не браузер / плеер / рабочий стол —
// нотч «переплывает» в угол и показывает FPS (PresentMon от Intel), процессор, видеокарту, память, пинг, время.
// Плашка прозрачна для мыши. Пинг — время TCP-рукопожатия с 1.1.1.1:443 (без содержимого). Всё считается на этом ПК.
use serde_json::{json, Value};
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::ctx;

const NOT_GAMES: &[&str] = &["msedge", "chrome", "firefox", "opera", "brave", "vivaldi", "yandex", "browser", "vlc", "mpc-hc64", "mpc-hc", "mpc-be64", "potplayermini64", "potplayer", "mpv", "wmplayer", "explorer", "applicationframehost", "powerpnt", "teams", "ms-teams", "zoom", "obs64", "obs32", "discord", "telegram", "slack", "code", "devenv", "idea64", "photoshop", "lightroom", "resolve", "premiere", "afterfx", "mspaint", "snippingtool", "screenclippinghost", "searchhost", "shellexperiencehost", "startmenuexperiencehost", "lockapp", "textinputhost", "systemsettings", "electron", "bar", "bar lab", "bar-tauri", "claude", "thunderbird", "outlook", "olk", "notion", "obsidian", "spotify", "whatsapp", "winword", "excel", "onenote", "figma", "cursor", "windowsterminal", "wt", "taskmgr", "msedgewebview2"];

#[derive(Clone)]
struct Game { pid: u32, exe: String, name: String, mon: (i32, i32, i32, i32), k: f64, manual: bool }
#[derive(Default)]
struct St { active: Option<Game>, last_mon: Option<(i32, i32, i32, i32, f64)>, panel_open: bool, suspended: String, seen: u32, miss: u32, cand: String,
    exit_done: bool, fps_state: String, frames: Vec<(Instant, f64)>, gpu: Value, ping: Value, pm: Option<u32>, gen: u64 }
static S: Mutex<Option<St>> = Mutex::new(None);
fn with<R>(f: impl FnOnce(&mut St) -> R) -> R { f(S.lock().unwrap().get_or_insert_with(St::default)) }

pub fn active() -> bool { S.lock().unwrap().as_ref().map_or(false, |s| s.active.is_some()) }
/// левый верхний угол монитора игры (физ. пиксели) — док прячется только на нём
pub fn active_mon() -> Option<(i32, i32)> { S.lock().unwrap().as_ref().and_then(|s| s.active.as_ref().map(|g| (g.mon.0, g.mon.1))) }

fn g() -> Value {
    let cur = ctx::sh().settings.get("game");
    let mut g = json!({ "auto": true, "corner": "tr", "fade": 0, "hold": 1000, "panelClose": 5000, "show": { "fps": true, "cpu": true, "gpu": true, "ram": true, "ping": true, "clock": true }, "ignore": [], "seen": [] });
    if let Some(o) = cur.as_object() { for (k, v) in o { if k == "show" { if let Some(so) = v.as_object() { for (a, b) in so { g["show"][a] = b.clone(); } } } else { g[k] = v.clone(); } } }
    g
}
fn save(gv: Value) { ctx::sh().settings.put("game", gv); }
fn base(exe: &str) -> String { std::path::Path::new(exe).file_stem().map(|x| x.to_string_lossy().to_string()).unwrap_or_default() }
fn ignored(exe: &str, gv: &Value) -> bool {
    let b = base(exe).to_lowercase();
    NOT_GAMES.contains(&b.as_str()) || gv["ignore"].as_array().map_or(false, |a| a.iter().any(|x| x.as_str().map_or(false, |x| x.eq_ignore_ascii_case(exe))))
}
fn mon_of(rect: &str) -> Option<((i32, i32, i32, i32), f64)> {
    let v: Vec<i32> = rect.split(',').map(|x| x.parse().unwrap_or(0)).collect();
    if v.len() != 4 || v[2] <= 0 { return None; }
    let k = ctx::sh().notch.win.available_monitors().ok()?.iter().find(|m| m.position().x == v[0] && m.position().y == v[1]).map(|m| m.scale_factor()).unwrap_or(1.0);
    Some(((v[0], v[1], v[2], v[3]), k))
}

fn poll() {
    let gv = g();
    let manual = with(|s| s.active.as_ref().map_or(false, |a| a.manual));
    if gv["auto"] != true && !manual { if with(|s| s.active.is_some()) { exit(false); } return; }
    let raw = ctx::sh().fast.call_t("gamestate", "", 2000).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    let p: Vec<&str> = raw.split('|').collect();
    let (full, exe, pid, mon) = (p.first() == Some(&"1"), p.get(2).copied().unwrap_or(""), p.get(3).and_then(|x| x.parse().ok()).unwrap_or(0u32), p.get(4).copied().unwrap_or(""));
    let is_game = full && !exe.is_empty() && !ignored(exe, &gv);
    let act = with(|s| s.active.clone());
    if let Some(a) = act {
        if a.manual { return; }
        let same = full && exe.eq_ignore_ascii_case(&a.exe);
        let miss = with(|s| { s.miss = if same { 0 } else { s.miss + 1 }; s.miss });
        if miss >= 3 { exit(false); }
        return;
    }
    let go = with(|s| {
        if s.panel_open { s.seen = 0; return false; }
        if !s.suspended.is_empty() && !exe.is_empty() && !exe.eq_ignore_ascii_case(&s.suspended) { s.suspended.clear(); }
        if !is_game || (!s.suspended.is_empty() && exe.eq_ignore_ascii_case(&s.suspended)) { s.seen = 0; s.cand.clear(); return false; }
        if s.cand != exe { s.cand = exe.to_string(); s.seen = 0; }
        s.seen += 1;
        s.seen >= 2 // два опроса подряд — не случайное окно
    });
    if go { if let Some((m, k)) = mon_of(mon) { enter(Game { pid, exe: exe.into(), name: base(exe), mon: m, k, manual: false }); } }
}

fn enter(gm: Game) {
    if with(|s| s.active.is_some()) { return; }
    let mut gv = g();
    if !gm.manual {
        let mut seen: Vec<Value> = vec![json!(gm.exe)];
        seen.extend(gv["seen"].as_array().cloned().unwrap_or_default().into_iter().filter(|x| !x.as_str().unwrap_or("").eq_ignore_ascii_case(&gm.exe)));
        seen.truncate(12); gv["seen"] = json!(seen); save(gv.clone());
    }
    let (w, h) = (gm.mon.2 as f64 / gm.k, gm.mon.3 as f64 / gm.k);
    with(|s| { s.active = Some(gm.clone()); s.miss = 0; s.gen += 1; });
    ctx::emit("game", json!({ "phase": "enter", "corner": gv["corner"], "fade": gv["fade"], "hold": gv["hold"], "show": gv["show"], "name": gm.name, "w": w, "h": h }));
    start_stats(gm);
}
fn exit(after_open: bool) {
    let Some(gm) = with(|s| s.active.take()) else { if after_open { open_after(); } return };
    stop_stats();
    with(|s| { s.last_mon = Some((gm.mon.0, gm.mon.1, gm.mon.2, gm.mon.3, gm.k)); s.exit_done = after_open; });
    let gv = g();
    ctx::emit("game", json!({ "phase": "exit", "open": after_open, "panelClose": gv["panelClose"], "corner": gv["corner"], "w": gm.mon.2 as f64 / gm.k, "h": gm.mon.3 as f64 / gm.k }));
}
// панель после игры: без захвата фокуса — игра держит его, а попытки отнять видны (рывок окна) и шлют игре Alt;
// панель работает мышью, клик по ней сам даёт фокус
fn open_after() { ctx::emit("toggle", Value::Null); }

// ---------- показатели ----------
fn presentmon() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    [dir.join("presentmon").join("PresentMon.exe"), dir.join("..").join("..").join("..").join("vendor").join("presentmon").join("PresentMon.exe")].into_iter().find(|p| p.exists())
}
fn start_stats(gm: Game) {
    let gen = with(|s| s.gen);
    let gv = g();
    // FPS: PresentMon пишет CSV (UTF-16 или UTF-8) по каждому кадру выбранного процесса
    with(|s| { s.frames.clear(); s.fps_state = "off".into(); });
    if gv["show"]["fps"] == true && gm.pid > 0 {
        match presentmon() {
            None => with(|s| s.fps_state = "missing".into()),
            Some(pm) => {
                use std::os::windows::process::CommandExt;
                let child = std::process::Command::new(pm).args(["--process_id", &gm.pid.to_string(), "--output_stdout", "--no_console_stats", "--v2_metrics", "--session_name", "BarFPS", "--stop_existing_session", "--terminate_on_proc_exit", "--no_track_input", "--no_track_gpu"])
                    .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).creation_flags(0x0800_0000).spawn();
                if let Ok(mut c) = child {
                    with(|s| { s.fps_state = "starting".into(); s.pm = Some(c.id()); });
                    let mut out = c.stdout.take().unwrap();
                    let mut err = c.stderr.take().unwrap();
                    std::thread::spawn(move || { let mut e = String::new(); let _ = err.read_to_string(&mut e); if e.to_lowercase().contains("access denied") { with(|s| s.fps_state = "denied".into()); } });
                    std::thread::spawn(move || {
                        let mut buf = Vec::new(); let mut chunk = [0u8; 8192]; let mut utf16: Option<bool> = None; let mut cols: Option<Vec<String>> = None; let mut text = String::new();
                        while let Ok(n) = out.read(&mut chunk) {
                            if n == 0 { break; }
                            buf.extend_from_slice(&chunk[..n]);
                            let u = *utf16.get_or_insert_with(|| (buf.len() > 1 && buf[0] == 0xff && buf[1] == 0xfe) || (buf.len() > 1 && buf[1] == 0));
                            if u { let k = buf.len() / 2 * 2; let v: Vec<u16> = buf[..k].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect(); text.push_str(&String::from_utf16_lossy(&v)); buf.drain(..k); }
                            else { text.push_str(&String::from_utf8_lossy(&buf)); buf.clear(); }
                            while let Some(i) = text.find('\n') {
                                let line = text[..i].trim().trim_start_matches('\u{feff}').to_string(); text.drain(..=i);
                                if line.is_empty() { continue; }
                                let c: Vec<String> = line.split(',').map(String::from).collect();
                                let Some(h) = &cols else { cols = Some(c); continue };
                                let k = h.iter().position(|x| x == "FrameTime").or_else(|| h.iter().position(|x| x == "MsBetweenPresents"));
                                if let Some(v) = k.and_then(|k| c.get(k)).and_then(|x| x.parse::<f64>().ok()).filter(|v| *v > 0.0 && *v < 1000.0) {
                                    with(|s| { s.frames.push((Instant::now(), v)); s.fps_state = "ok".into(); if s.frames.len() > 2000 { s.frames.drain(..1000); } });
                                }
                            }
                        }
                        with(|s| if s.fps_state == "starting" { s.fps_state = "off".into(); });
                    });
                }
            }
        }
    }
    let gpu_on = gv["show"]["gpu"] == true;
    let ping_on = gv["show"]["ping"] == true;
    std::thread::spawn(move || {
        let mut n = 0u64;
        let busy = Arc::new(Mutex::new(false));
        while with(|s| s.gen == gen && s.active.is_some()) {
            if gpu_on && !*busy.lock().unwrap() {
                *busy.lock().unwrap() = true;
                let b = busy.clone();
                std::thread::spawn(move || { let v = ctx::sh().slow.call_t("gpu", "", 8000).ok().filter(|v| v.is_number()).unwrap_or(Value::Null); with(|s| s.gpu = v); *b.lock().unwrap() = false; });
            }
            if ping_on && n % 3 == 0 { std::thread::spawn(|| { let t = Instant::now(); let ok = std::net::TcpStream::connect_timeout(&"1.1.1.1:443".parse().unwrap(), Duration::from_millis(1500)).is_ok(); with(|s| s.ping = if ok { json!(t.elapsed().as_millis().max(1)) } else { Value::Null }); }); }
            let st = crate::sensors::stats();
            let (fps, state, gpu, ping) = with(|s| {
                s.frames.retain(|f| f.0.elapsed() < Duration::from_secs(1));
                let fps = if s.frames.is_empty() { Value::Null } else { json!((1000.0 / (s.frames.iter().map(|f| f.1).sum::<f64>() / s.frames.len() as f64)).round()) };
                (fps, s.fps_state.clone(), s.gpu.clone(), s.ping.clone())
            });
            let ram = st["memTotal"].as_f64().map(|t| (st["memUsed"].as_f64().unwrap_or(0.0) / t * 100.0).round()).unwrap_or(0.0);
            ctx::emit("game-stats", json!({ "fps": fps, "fpsState": state, "gpu": gpu, "ping": ping, "cpu": st["cpu"], "ram": ram }));
            n += 1;
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}
fn stop_stats() {
    if let Some(pid) = with(|s| { s.frames.clear(); s.gpu = Value::Null; s.ping = Value::Null; s.pm.take() }) {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).creation_flags(0x0800_0000).spawn();
    }
}

pub fn start() { std::thread::spawn(|| loop { std::thread::sleep(Duration::from_secs(2)); poll(); }); }
pub fn stop() { stop_stats(); }
/// горячая клавиша: включить вручную / выйти
pub fn hotkey() {
    if let Some(a) = with(|s| s.active.clone()) { with(|s| s.suspended = if a.manual { String::new() } else { a.exe.clone() }); exit(false); return; }
    let raw = ctx::sh().fast.call_t("gamestate", "", 2000).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    let p: Vec<&str> = raw.split('|').collect();
    let (m, k) = mon_of(p.get(4).copied().unwrap_or("")).or_else(|| ctx::sh().notch.display().map(|m| ((m.position().x, m.position().y, m.size().width as i32, m.size().height as i32), m.scale_factor()))).unwrap_or(((0, 0, 1920, 1080), 1.0));
    let exe = p.get(2).copied().unwrap_or("manual");
    enter(Game { pid: p.get(3).and_then(|x| x.parse().ok()).unwrap_or(0), exe: exe.into(), name: if base(exe).is_empty() { "Игра".into() } else { base(exe) }, mon: m, k, manual: true });
}
pub fn open_panel() { if !active() { return; } with(|s| s.panel_open = true); ctx::sh().notch.set_noactivate(true); exit(true); }
pub fn set_auto(on: bool) { let mut gv = g(); gv["auto"] = json!(on); save(gv); if !on && with(|s| s.active.as_ref().map_or(false, |a| !a.manual)) { exit(false); } }

pub fn handle(ch: &str, a: &[Value]) -> Value {
    let arg = |i: usize| a.get(i).cloned().unwrap_or(Value::Null);
    let rect = |v: &Value| (v["x"].as_f64().unwrap_or(0.0), v["y"].as_f64().unwrap_or(0.0), v["w"].as_f64().unwrap_or(0.0), v["h"].as_f64().unwrap_or(0.0));
    match ch {
        "game-dock" => { let gm = with(|s| s.active.clone()); if let Some(gm) = gm { ctx::sh().notch.hud(gm.mon, rect(&arg(0)), gm.k, g()["hold"].as_f64().unwrap_or(1000.0) > 0.0); json!(true) } else { json!(false) } }
        "game-open-panel" => { open_panel(); Value::Null }
        "panel-state" => {
            if arg(0).as_bool() != Some(true) && with(|s| s.panel_open) {
                ctx::sh().notch.set_noactivate(false); // панель закрылась — обычное поведение окна
                std::thread::spawn(|| { std::thread::sleep(Duration::from_millis(900)); with(|s| { s.panel_open = false; s.seen = 1; }); });
            }
            Value::Null
        }
        "game-stage" => {
            let m = with(|s| s.active.as_ref().map(|g| (g.mon.0, g.mon.1, g.mon.2, g.mon.3, g.k)).or(s.last_mon));
            if let Some((x, y, w, h, k)) = m { ctx::sh().notch.stage((x, y, w, h), rect(&arg(0)), k); json!(true) } else { json!(false) }
        }
        "game-exit-done" => {
            // после удержания сразу откроется панель: окно из «сцены» становится окном панели (только высота меньше),
            // а не ужимается до полоски и тут же растёт — иначе панель на кадр обрезана и «дёргается вниз»
            if with(|s| std::mem::take(&mut s.exit_done)) { ctx::sh().notch.to_full(); open_after(); }
            else { ctx::sh().notch.pill(); }
            json!(true)
        }
        "game-get" => {
            let mut gv = g();
            gv["active"] = with(|s| s.active.as_ref().map(|a| json!({ "name": a.name, "manual": a.manual }))).unwrap_or(Value::Null);
            gv["presentmon"] = json!(presentmon().is_some());
            let p = ctx::sh().slow.call_t("fpsperm", "", 10000).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| "no".into());
            gv["perm"] = json!(if ["ok", "relogin", "no"].contains(&p.as_str()) { p } else { "no".into() });
            gv
        }
        "game-set" => {
            let p = arg(0);
            let mut gv = g();
            for k in ["auto", "corner", "fade", "hold", "panelClose"] { if !p[k].is_null() { gv[k] = p[k].clone(); } }
            let hold = gv["hold"].as_i64().unwrap_or(1000); gv["hold"] = json!(if [0, 500, 1000, 2000].contains(&hold) { hold } else { 1000 });
            let pc = gv["panelClose"].as_i64().unwrap_or(5000); gv["panelClose"] = json!(if [3000, 5000, 10000].contains(&pc) { pc } else { 5000 });
            if !["tl", "tr", "bl", "br", "tc"].contains(&gv["corner"].as_str().unwrap_or("")) { gv["corner"] = json!("tr"); }
            let fade = gv["fade"].as_i64().unwrap_or(0); gv["fade"] = json!(if [0, 40, 60].contains(&fade) { fade } else { 0 });
            if let Some(o) = p["show"].as_object() { for (k, v) in o { gv["show"][k] = v.clone(); } }
            if let Some(l) = p["ignore"].as_array() { gv["ignore"] = json!(l.iter().filter(|x| x.is_string()).take(50).cloned().collect::<Vec<_>>()); }
            save(gv.clone());
            if let Some(a) = with(|s| s.active.clone()) { ctx::emit("game", json!({ "phase": "update", "corner": gv["corner"], "fade": gv["fade"], "hold": gv["hold"], "show": gv["show"], "w": a.mon.2 as f64 / a.k, "h": a.mon.3 as f64 / a.k })); }
            json!(true)
        }
        "game-preview" => {
            if active() { exit(false); return json!(false); }
            let Some(m) = ctx::sh().notch.display() else { return json!(false) };
            enter(Game { pid: 0, exe: "preview".into(), name: "Предпросмотр".into(), mon: (m.position().x, m.position().y, m.size().width as i32, m.size().height as i32), k: m.scale_factor(), manual: true });
            std::thread::spawn(|| { std::thread::sleep(Duration::from_secs(6)); if with(|s| s.active.as_ref().map_or(false, |a| a.exe == "preview")) { exit(false); } });
            json!(true)
        }
        "game-perm" => ctx::sh().slow.call_t("fpsgrant", "", 130000).unwrap_or(json!("error")),
        _ => Value::Null,
    }
}
