// Приложения: список «Пуска» + ярлыки + программы без ярлыка, которые Bar видел на экране (портативные),
// подсказки дока по тому, что вы реально часто запускаете (счётчики Windows и своё наблюдение за активным окном),
// иконки программ. Всё читается на этом компьютере и никуда не отправляется.
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows::core::{Interface, HSTRING};
use windows::Win32::System::Com::*;
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

use crate::ctx;

#[derive(Default)]
struct St { apps: Option<(Instant, Vec<Value>)>, usage: Option<(Instant, Value)>, seen: Map<String, Value>, fg: Map<String, Value>, fg_dirty: bool, icons: HashMap<String, (Value, Option<Instant>)> }
static S: Mutex<Option<St>> = Mutex::new(None);
fn with<R>(f: impl FnOnce(&mut St) -> R) -> R { f(S.lock().unwrap().get_or_insert_with(St::default)) }

fn sys_exe(e: &str) -> bool {
    let l = e.to_lowercase();
    l.contains(r"\windows\") || l.contains(r"\windowsapps\") || ["explorer", "applicationframehost", "systemsettings", "searchhost", "shellexperiencehost", "startmenuexperiencehost", "textinputhost", "lockapp", "electron", "bar", "bar lab", "bar-tauri", "powershell", "cmd", "conhost", "windowsterminal", "rundll32", "dllhost", "msedgewebview2"]
        .iter().any(|n| l.ends_with(&format!(r"\{}.exe", n)))
}
fn skip_exe(e: &str) -> bool {
    let l = e.to_lowercase();
    l.contains(r"\windows\") || ["explorer", "applicationframehost", "searchhost", "searchapp", "shellexperiencehost", "startmenuexperiencehost", "lockapp", "textinputhost", "systemsettings", "taskmgr", "electron", "msedgewebview2"].iter().any(|n| l.ends_with(&format!(r"\{}.exe", n)))
}
fn own() -> String { std::env::current_exe().map(|p| p.to_string_lossy().to_lowercase()).unwrap_or_default() }
fn is_exe_path(p: &str) -> bool { let b = p.as_bytes(); b.len() > 7 && b[0].is_ascii_alphabetic() && &p[1..3] == ":\\" && p.to_lowercase().ends_with(".exe") }
fn seen_file() -> std::path::PathBuf { ctx::data_dir().join("seen-apps.json") }
fn fg_file() -> std::path::PathBuf { ctx::data_dir().join("usage.json") }
fn read_map(p: &Path) -> Map<String, Value> { std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default() }

pub fn start() {
    with(|s| { s.seen = read_map(&seen_file()); s.fg = read_map(&fg_file()); });
    // раз в 10 секунд — какая программа на экране, пока вы за компьютером (минуты с затуханием за ~неделю)
    std::thread::spawn(|| {
        let mut saved = Instant::now();
        loop {
            std::thread::sleep(Duration::from_secs(10));
            fg_tick();
            if saved.elapsed() > Duration::from_secs(120) { saved = Instant::now(); fg_save(); }
        }
    });
}
fn idle_secs() -> u64 {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut li = LASTINPUTINFO { cbSize: 8, dwTime: 0 };
    unsafe { if !GetLastInputInfo(&mut li).as_bool() { return 0; } (windows::Win32::System::SystemInformation::GetTickCount().wrapping_sub(li.dwTime) / 1000) as u64 }
}
fn decay(e: &mut Value, now: u64) {
    let t = e["t"].as_u64().unwrap_or(now);
    let d = now.saturating_sub(t) as f64 / 86_400_000.0;
    let m = e["m"].as_f64().unwrap_or(0.0) * 0.5f64.powf(d / 7.0);
    e["m"] = json!(m); e["t"] = json!(now);
}
fn fg_tick() {
    if idle_secs() > 120 { return; }
    let Some(exe) = ctx::sh().fast.call_t("fg", "", 2000).ok().and_then(|v| v.as_str().map(String::from)) else { return };
    if exe.is_empty() || exe.to_lowercase() == own() || skip_exe(&exe) { return; }
    let now = ctx::now_ms();
    with(|s| {
        let e = s.fg.entry(exe.to_lowercase()).or_insert_with(|| json!({ "m": 0.0, "t": now, "exe": exe }));
        decay(e, now);
        e["m"] = json!(e["m"].as_f64().unwrap_or(0.0) + 10.0 / 60.0);
        s.fg_dirty = true;
    });
}
fn fg_save() {
    let v = with(|s| {
        if !s.fg_dirty { return None; }
        s.fg_dirty = false;
        let now = ctx::now_ms();
        for e in s.fg.values_mut() { decay(e, now); }
        s.fg.retain(|_, e| e["m"].as_f64().unwrap_or(0.0) >= 0.5);
        Some(Value::Object(s.fg.clone()))
    });
    if let Some(v) = v { let _ = std::fs::write(fg_file(), v.to_string()); }
}
pub fn stop() { with(|s| s.fg_dirty = true); fg_save(); }

/// программа с окном — запомнить для поиска и «+» (портативные программы)
pub fn note_exe(exe: &str) {
    if exe.is_empty() || sys_exe(exe) { return; }
    let k = exe.to_lowercase();
    let save = with(|s| {
        let new = !s.seen.contains_key(&k);
        let mut e = s.seen.get(&k).cloned().unwrap_or_else(|| json!({}));
        e["p"] = json!(exe); e["t"] = json!(ctx::now_ms());
        s.seen.insert(k, e);
        if new {
            if s.seen.len() > 300 { let mut ks: Vec<(String, u64)> = s.seen.iter().map(|(k, v)| (k.clone(), v["t"].as_u64().unwrap_or(0))).collect(); ks.sort_by_key(|x| x.1); for (k, _) in ks.iter().take(s.seen.len() - 300) { s.seen.remove(k); } }
            s.apps = None;
            Some(Value::Object(s.seen.clone()))
        } else { None }
    });
    if let Some(v) = save { let _ = std::fs::write(seen_file(), v.to_string()); }
}

// ярлыки «Пуска»: имя ярлыка → (путь ярлыка, цель)
fn scan_lnk() -> HashMap<String, (String, String)> {
    std::thread::spawn(|| unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let mut map = HashMap::new();
        let (pd, ad) = (std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into()), std::env::var("APPDATA").unwrap_or_default());
        let roots = [format!(r"{}\Microsoft\Windows\Start Menu\Programs", pd), format!(r"{}\Microsoft\Windows\Start Menu\Programs", ad)];
        let link: Option<IShellLinkW> = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok();
        fn walk(dir: &Path, depth: u32, link: &Option<IShellLinkW>, map: &mut HashMap<String, (String, String)>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                let n = e.file_name().to_string_lossy().to_string();
                if p.is_dir() { if depth < 4 { walk(&p, depth + 1, link, map); } continue; }
                if !n.to_lowercase().ends_with(".lnk") { continue; }
                let key = n[..n.len() - 4].to_lowercase();
                if map.contains_key(&key) { continue; }
                let mut target = String::new();
                if let Some(l) = link { unsafe {
                    if let Ok(pf) = l.cast::<IPersistFile>() {
                        if pf.Load(&HSTRING::from(p.to_string_lossy().as_ref()), STGM_READ).is_ok() {
                            let mut buf = [0u16; 1024];
                            if l.GetPath(&mut buf, std::ptr::null_mut(), 0).is_ok() { let k = buf.iter().position(|&c| c == 0).unwrap_or(0); target = String::from_utf16_lossy(&buf[..k]); }
                        }
                    }
                } }
                map.insert(key, (p.to_string_lossy().to_string(), target));
            }
        }
        for r in roots { walk(Path::new(&r), 0, &link, &mut map); }
        map
    }).join().unwrap_or_default()
}
/// цель и иконка ярлыка
fn lnk_info(lnk: &str) -> (String, String) {
    let lnk = lnk.to_string();
    std::thread::spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let Ok(l) = CoCreateInstance::<_, IShellLinkW>(&ShellLink, None, CLSCTX_INPROC_SERVER) else { return (String::new(), String::new()) };
        let Ok(pf) = l.cast::<IPersistFile>() else { return (String::new(), String::new()) };
        if pf.Load(&HSTRING::from(lnk.as_str()), STGM_READ).is_err() { return (String::new(), String::new()); }
        let (mut t, mut ic) = ([0u16; 1024], [0u16; 1024]);
        let _ = l.GetPath(&mut t, std::ptr::null_mut(), 0);
        let mut idx = 0;
        let _ = l.GetIconLocation(&mut ic, &mut idx);
        let s = |b: &[u16]| { let k = b.iter().position(|&c| c == 0).unwrap_or(0); String::from_utf16_lossy(&b[..k]) };
        (s(&t), s(&ic))
    }).join().unwrap_or_default()
}

pub fn list(force: bool) -> Vec<Value> {
    if let Some(v) = with(|s| s.apps.as_ref().filter(|(t, _)| !force && t.elapsed() < Duration::from_secs(600)).map(|x| x.1.clone())) { return v; }
    let sh = ctx::sh();
    let raw: Vec<String> = sh.slow.call_t("startapps", "", 30000).ok().and_then(|v| v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())).unwrap_or_default();
    let lnks = scan_lnk();
    let mut seen = HashSet::new();
    let mut apps: Vec<Value> = Vec::new();
    for line in raw {
        let Some((n0, id)) = line.split_once('|') else { continue };
        let name = n0.trim_matches(|c| c == '«' || c == '»' || c == '"').trim().to_string();
        let id = id.trim().to_string();
        if name.is_empty() || id.is_empty() || !seen.insert(name.to_lowercase()) { continue; }
        let l = lnks.get(&n0.to_lowercase()).or_else(|| lnks.get(&name.to_lowercase()));
        let exe = if is_exe_path(&id) || (id.len() > 3 && &id[1..3] == ":\\") { id.clone() } else { l.map(|x| x.1.clone()).filter(|t| t.to_lowercase().ends_with(".exe")).unwrap_or_default() };
        let uwp = if id.contains('!') { id.split('!').next().unwrap_or("").to_string() } else { String::new() };
        apps.push(json!({ "id": id, "name": name, "lnk": l.map(|x| x.0.clone()).unwrap_or_default(), "exe": exe, "uwp": uwp }));
    }
    // + программы без ярлыка в «Пуске» (портативные): те, что были на экране или открыты
    let mut have: HashSet<String> = apps.iter().filter_map(|a| a["exe"].as_str().filter(|e| !e.is_empty()).map(|e| e.to_lowercase())).collect();
    let mut extra: Vec<(String, String)> = Vec::new();
    with(|s| {
        for (k, e) in &s.fg { extra.push((e["exe"].as_str().unwrap_or(k).to_lowercase(), e["exe"].as_str().unwrap_or(k).to_string())); }
        for (k, e) in &s.seen { extra.push((k.clone(), e["p"].as_str().unwrap_or(k).to_string())); }
    });
    extra.sort(); extra.dedup_by(|a, b| a.0 == b.0);
    // названия из свойств файлов — один запрос на все новые, ответ запоминается в seen-apps.json
    let ask: Vec<String> = with(|s| extra.iter().filter(|(k, e)| !have.contains(k) && s.seen.get(k).map_or(true, |x| x.get("n").is_none()) && is_exe_path(e) && !sys_exe(e) && Path::new(e).exists()).map(|x| x.1.clone()).take(40).collect());
    if !ask.is_empty() {
        let rows = sh.slow.call_t("exeinfo", &bar_agent::img::b64(ask.join("|").as_bytes()), 20000).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
        let v = with(|s| {
            for r in rows { let r = r.as_str().unwrap_or(""); let p: Vec<&str> = r.split('|').collect(); let k = p.first().unwrap_or(&"").to_lowercase(); if k.is_empty() { continue; }
                let mut e = s.seen.get(&k).cloned().unwrap_or_else(|| json!({ "p": p[0], "t": ctx::now_ms() }));
                e["n"] = json!(p.get(1).unwrap_or(&"")); e["l"] = json!(p.get(2).unwrap_or(&"")); s.seen.insert(k, e); }
            Value::Object(s.seen.clone())
        });
        let _ = std::fs::write(seen_file(), v.to_string());
    }
    for (k, exe0) in extra {
        if have.contains(&k) || !is_exe_path(&exe0) || sys_exe(&exe0) || !Path::new(&exe0).exists() { continue; }
        let info = with(|s| s.seen.get(&k).cloned()).unwrap_or(json!({}));
        let l = info["l"].as_str().unwrap_or("");
        let exe = if !l.is_empty() && Path::new(l).exists() { l.to_string() } else { exe0.clone() };
        if have.contains(&exe.to_lowercase()) { continue; }
        let name = info["n"].as_str().filter(|n| !n.is_empty()).map(String::from).unwrap_or_else(|| Path::new(&exe).file_stem().map(|x| x.to_string_lossy().replace(['-', '_'], " ").trim().to_string()).unwrap_or_default());
        if name.is_empty() || !seen.insert(name.to_lowercase()) { continue; }
        have.insert(k);
        apps.push(json!({ "id": format!("exe:{}", exe), "name": name, "lnk": "", "exe": exe, "uwp": "" }));
    }
    apps.sort_by(|a, b| a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase()));
    with(|s| s.apps = Some((Instant::now(), apps.clone())));
    apps
}

pub fn usage() -> Value {
    if let Some(v) = with(|s| s.usage.as_ref().filter(|(t, _)| t.elapsed() < Duration::from_secs(300)).map(|x| x.1.clone())) { return v; }
    let apps = list(false);
    let rows = ctx::sh().slow.call_t("usage", "", 15000).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
    let env = |k: &str| std::env::var(k).unwrap_or_default();
    let known: HashMap<&str, String> = [("{6d809377-6af0-444b-8957-a3773f02200e}", if env("ProgramW6432").is_empty() { env("ProgramFiles") } else { env("ProgramW6432") }), ("{7c5a40ef-a0fb-4bfc-874a-c0f2e0b9fa8e}", env("ProgramFiles(x86)")),
        ("{1ac14e77-02e7-4e5d-b744-2eb1ae5198b7}", format!(r"{}\System32", env("SystemRoot"))), ("{f38bf404-1d43-42f2-9305-67de0b28fc23}", env("SystemRoot"))].into_iter().collect();
    let mut use_: HashMap<String, f64> = HashMap::new();
    let now = ctx::now_ms();
    with(|s| for e in s.fg.values() { let mut c = e.clone(); decay(&mut c, now); let k = c["exe"].as_str().unwrap_or("").to_lowercase(); *use_.entry(k).or_default() += c["m"].as_f64().unwrap_or(0.0) * 2.0; });
    for r in rows {
        let p: Vec<&str> = r.as_str().unwrap_or("").split('|').collect();
        if p.len() < 4 { continue; }
        let mut name = p[0].to_lowercase();
        if name.starts_with('{') { if let Some(end) = name.find('}') { if let Some(base) = known.get(&name[..=end]) { name = format!("{}{}", base, &name[end + 1..]).to_lowercase(); } } }
        let (runs, focus, last) = (p[1].parse::<f64>().unwrap_or(0.0), p[2].parse::<f64>().unwrap_or(0.0), p[3].parse::<f64>().unwrap_or(0.0));
        let age = if last > 0.0 { (now as f64 - last) / 86_400_000.0 } else { 999.0 };
        let fresh = if age < 7.0 { 1.0 } else if age < 30.0 { 0.5 } else if age < 999.0 { 0.2 } else { 0.3 };
        let score = (focus / 60000.0 + 4.0 * (1.0 + runs).log2() * if focus > 0.0 { 1.0 } else { 0.25 }) * fresh;
        if score > 0.0 { *use_.entry(name).or_default() += score; }
    }
    let mut out: Vec<(f64, Value)> = Vec::new();
    let mut matched = HashSet::new();
    let skip_id = ["bar.notch", "screensketch", "xboxgamingoverlay", "immersivecontrolpanel", "windows.explorer", "sechealthui"];
    for a in &apps {
        let id = a["id"].as_str().unwrap_or("").to_lowercase();
        if skip_id.iter().any(|x| id.contains(x)) { continue; }
        let ex = a["exe"].as_str().unwrap_or("").to_lowercase();
        let s = use_.get(&id).copied().unwrap_or(0.0) + if ex.is_empty() { 0.0 } else { use_.get(&ex).copied().unwrap_or(0.0) };
        if !ex.is_empty() { matched.insert(ex); }
        if s >= 3.0 { out.push((s, json!({ "app": a, "score": s.round() }))); }
    }
    let me = own();
    for (k, s) in &use_ {
        if *s < 3.0 || matched.contains(k) || !is_exe_path(k) || skip_exe(k) || *k == me || ["\\steamapps\\", "\\temp\\", "unins", "setup", "crashreport", "launcher_be", "_be.exe"].iter().any(|x| k.contains(x)) { continue; }
        let exe = with(|st| st.fg.get(k).and_then(|e| e["exe"].as_str().map(String::from))).unwrap_or_else(|| k.clone());
        if !Path::new(&exe).exists() { continue; }
        let base = Path::new(&exe).file_stem().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
        let name = base[..1.min(base.len())].to_uppercase() + &base[1.min(base.len())..];
        out.push((*s, json!({ "app": { "id": format!("exe:{}", exe), "name": name, "exe": exe, "lnk": "", "uwp": "" }, "score": s.round() })));
    }
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let v = json!(out.into_iter().take(24).map(|x| x.1).collect::<Vec<_>>());
    with(|s| s.usage = Some((Instant::now(), v.clone())));
    v
}

// ---------- иконки ----------
fn icon_file(exe: &str) -> std::path::PathBuf {
    let h = crate::crypto::sha512(&[exe.to_lowercase().as_bytes()]);
    let d = ctx::data_dir().join("icons");
    let _ = std::fs::create_dir_all(&d);
    d.join(format!("{}.png", h.iter().take(8).map(|b| format!("{:02x}", b)).collect::<String>()))
}
static GENERIC: Mutex<Option<String>> = Mutex::new(None);
fn generic96() -> String {
    if let Some(g) = GENERIC.lock().unwrap().clone() { return g; }
    let d = ctx::data_dir().join("icons"); let _ = std::fs::create_dir_all(&d);
    let f = d.join("blank.exe"); if !f.exists() { let _ = std::fs::write(&f, b""); }
    let g = ctx::sh().icon.call_t("fileicon", &f.to_string_lossy(), 6000).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    *GENERIC.lock().unwrap() = Some(g.clone());
    g
}
pub fn icon(a: &Value) -> Value {
    let key = a["id"].as_str().filter(|x| !x.is_empty()).or(a["exe"].as_str()).unwrap_or("").to_string();
    if let Some(v) = with(|s| s.icons.get(&key).filter(|(_, exp)| exp.map_or(true, |t| t > Instant::now())).map(|x| x.0.clone())) { return v; }
    let sh = ctx::sh();
    let data = |b: &str| Value::from(format!("data:image/png;base64,{}", b));
    let id = a["id"].as_str().unwrap_or("");
    let mut url = Value::Null;
    // 1) как показывает «Пуск» (shell:AppsFolder\<AppID>) — и обычные программы, и приложения Store
    if !id.is_empty() && !id.starts_with("exe:") { if let Some(b) = sh.icon.call_t("appicon", id, 8000).ok().and_then(|v| v.as_str().map(String::from)).filter(|b| b.len() > 200) { url = data(&b); } }
    // 2) exe / иконка ярлыка через оболочку в 96×96 (без стандартной заглушки «программа без иконки»)
    let (target, licon) = a["lnk"].as_str().filter(|l| !l.is_empty()).map(lnk_info).unwrap_or_default();
    if url.is_null() {
        for f in [a["exe"].as_str().unwrap_or(""), licon.as_str()] {
            let lf = f.to_lowercase();
            if f.is_empty() || !(lf.ends_with(".exe") || lf.ends_with(".ico") || lf.ends_with(".dll")) || !Path::new(f).exists() { continue; }
            if let Some(b) = sh.icon.call_t("fileicon", f, 6000).ok().and_then(|v| v.as_str().map(String::from)).filter(|b| b.len() > 200 && *b != generic96()) { url = data(&b); break; }
        }
    }
    let exe = a["exe"].as_str().filter(|e| !e.is_empty()).map(String::from).or_else(|| Some(target.clone()).filter(|t| t.to_lowercase().ends_with(".exe"))).unwrap_or_default();
    // 3) программа без иконки в exe: иконка, снятая с её окна (запоминается на диске)
    if url.is_null() && !exe.is_empty() {
        let f = icon_file(&exe);
        if let Ok(b) = std::fs::read(&f) { url = data(&bar_agent::img::b64(&b)); }
        else if let Some(b) = sh.icon.call_t("winicon", &exe, 4000).ok().and_then(|v| v.as_str().map(String::from)).filter(|b| !b.is_empty()) { let _ = std::fs::write(&f, bar_agent::img::unb64(&b)); url = data(&b); }
    }
    // 4) приложения Microsoft Store: логотип из манифеста пакета
    if url.is_null() {
        let mut fam = a["uwp"].as_str().unwrap_or("").to_string();
        if fam.is_empty() { if let Some(i) = exe.to_lowercase().find(r"\windowsapps\") { let rest = &exe[i + 13..]; if let Some(dir) = rest.split('\\').next() { let p: Vec<&str> = dir.split('_').collect(); if p.len() >= 5 { fam = format!("{}_{}", p[0], p[p.len() - 1]); } } } }
        if !fam.is_empty() { if let Some(logo) = sh.icon.call_t("appxlogo", &fam, 8000).ok().and_then(|v| v.as_str().map(String::from)) { if let Ok(b) = std::fs::read(&logo) { url = data(&bar_agent::img::b64(&b)); } } }
    }
    // не нашли — повторить через минуту (программу могут запустить, и иконка возьмётся с окна)
    with(|s| s.icons.insert(key, (url.clone(), url.is_null().then(|| Instant::now() + Duration::from_secs(60)))));
    url
}

/// окна, сгруппированные по программам (для поиска «Открытые окна»)
pub fn windows() -> Value {
    let me = own();
    let rows = ctx::sh().fast.call_t("windows", "", 3000).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
    let mut groups: Vec<Value> = Vec::new();
    let mut idx: HashMap<String, usize> = HashMap::new();
    for r in rows {
        let p: Vec<&str> = r.as_str().unwrap_or("").splitn(3, '|').collect();
        if p.len() < 3 || p[2].is_empty() || p[2].to_lowercase() == me { continue; }
        let k = p[2].to_lowercase();
        let i = *idx.entry(k).or_insert_with(|| { groups.push(json!({ "exe": p[2], "name": Path::new(p[2]).file_stem().map(|x| x.to_string_lossy()).unwrap_or_default(), "windows": [] })); groups.len() - 1 });
        groups[i]["windows"].as_array_mut().unwrap().push(json!({ "hwnd": p[0].parse::<i64>().unwrap_or(0), "pid": p[1].parse::<i64>().unwrap_or(0) }));
        note_exe(p[2]);
    }
    json!(groups)
}
