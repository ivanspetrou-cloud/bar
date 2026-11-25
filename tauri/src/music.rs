// Режим музыки: YouTube Music в ВАШЕМ браузере + расширение «Bar — YouTube Music».
// • Связь — WebSocket только на 127.0.0.1; принимаем подключение только от расширения с нашим идентификатором (Origin),
//   а потом расширение и Bar доказывают друг другу знание общего ключа пары (HMAC-SHA256, ключ по сети не передаётся).
// • Расширение выполняет только фиксированный список действий во вкладке music.youtube.com.
// • Картинки (обложки) — через http://barimg.localhost/img/<адрес>, только с серверов музыкальных сервисов.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::ctx;

const EXT_ID: &str = "jimcfkkplnpbacanmidnfbhidibchibp";
const PORTS: [u16; 3] = [47823, 47824, 47825];
const T_MANIFEST: &str = include_str!("../../extension/manifest.json");
const T_SW: &str = include_str!("../../extension/sw.js");
const T_BRIDGE: &str = include_str!("../../extension/bridge.js");
const T_WEB: &str = include_str!("../../extension/web.js");
const T_PAGE: &str = include_str!("../../src/music-page.js");
const LISTENER: &str = r#"
// ---- приёмник запросов расширения Bar (только фиксированный список действий) ----
(() => {
  // список разрешённых действий обновляется при каждом обновлении скрипта, а приёмник ставится один раз
  window.__barAllowed = ['state', 'queue', 'toggle', 'next', 'prev', 'seek', 'volume', 'like', 'dislike', 'shuffle', 'repeat', 'playQueue', 'play', 'browse', 'search', 'lyrics'];
  if (window.__barListen) return;
  window.__barListen = true;
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.__barReq !== true) return;
    const { id, fn, args } = e.data;
    let result, error;
    try {
      if (!(window.__barAllowed || []).includes(fn) || !window.__bar || typeof window.__bar[fn] !== 'function') throw new Error('not allowed');
      result = await window.__bar[fn](...(Array.isArray(args) ? args : []));
    } catch (err) { error = String(err && err.message || err); }
    window.postMessage({ __barRes: true, id, result, error }, location.origin);
  });
})();
"#;

type Sock = Arc<Mutex<TcpStream>>;
#[derive(Default)]
struct M {
    sock: Option<Sock>, ext: Value, tab: bool, last: Value, web: Value, port: u16, watching: bool,
    pending: HashMap<u64, Sender<Value>>, seq: u64, resume: Value, resume_saved: u64, upd: HashSet<String>, key: Vec<u8>,
}
static S: Mutex<Option<M>> = Mutex::new(None);
fn with<R>(f: impl FnOnce(&mut M) -> R) -> R { f(S.lock().unwrap().get_or_insert_with(M::default)) }

fn ext_dir() -> PathBuf { ctx::data_dir().join("extension") }
fn last_file() -> PathBuf { ctx::data_dir().join("music-last.json") }

// ---------- файлы расширения ----------
fn build_ext(dir: &Path) -> Vec<u8> {
    let _ = std::fs::create_dir_all(dir);
    for (n, t) in [("manifest.json", T_MANIFEST), ("sw.js", T_SW), ("bridge.js", T_BRIDGE), ("web.js", T_WEB)] { let _ = std::fs::write(dir.join(n), t); }
    let _ = std::fs::write(dir.join("page.js"), format!("// Собрано из src/music-page.js — не редактируйте вручную\n{}\n{}", T_PAGE, LISTENER));
    let pf = dir.join("pair.json");
    let key = std::fs::read_to_string(&pf).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["key"].as_str().map(String::from)).filter(|k| k.len() >= 40);
    let key = key.unwrap_or_else(|| { let k = bar_agent::img::b64(&crate::crypto::random(32)); let _ = std::fs::write(&pf, json!({ "key": k }).to_string()); k });
    bar_agent::img::unb64(&key)
}
// Где браузеры загрузили расширение Bar (распакованное, по его идентификатору): Edge, Chrome, Brave, Vivaldi, Яндекс, Opera.
fn browser_dirs() -> Vec<PathBuf> {
    let (l, a) = (std::env::var("LOCALAPPDATA").unwrap_or_default(), std::env::var("APPDATA").unwrap_or_default());
    let roots = [format!(r"{l}\Microsoft\Edge\User Data"), format!(r"{l}\Google\Chrome\User Data"), format!(r"{l}\BraveSoftware\Brave-Browser\User Data"),
        format!(r"{l}\Vivaldi\User Data"), format!(r"{l}\Yandex\YandexBrowser\User Data"), format!(r"{a}\Opera Software\Opera Stable"), format!(r"{a}\Opera Software\Opera GX Stable")];
    let mut out: Vec<PathBuf> = Vec::new();
    for root in roots {
        let mut profs: Vec<PathBuf> = std::fs::read_dir(&root).map(|r| r.filter_map(|e| e.ok()).filter(|e| { let n = e.file_name().to_string_lossy().to_string(); n == "Default" || n.starts_with("Profile ") }).map(|e| e.path()).collect()).unwrap_or_default();
        profs.push(PathBuf::from(&root));
        for p in profs {
            for f in ["Secure Preferences", "Preferences"] {
                let Ok(t) = std::fs::read_to_string(p.join(f)) else { continue };
                let Ok(j) = serde_json::from_str::<Value>(&t) else { continue };
                if let Some(path) = j["extensions"]["settings"][EXT_ID]["path"].as_str() { let pb = PathBuf::from(path); if pb.is_absolute() && !out.contains(&pb) { out.push(pb); } }
            }
        }
    }
    out
}
// ключ пары — у той копии расширения, которую реально загрузил браузер
fn adopt_key(dir: &Path) {
    let me = dir.to_string_lossy().to_lowercase();
    let dirs = browser_dirs();
    if dirs.iter().any(|d| d.to_string_lossy().to_lowercase() == me) { return; }
    for d in dirs {
        if let Some(k) = std::fs::read_to_string(d.join("pair.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["key"].as_str().map(String::from)).filter(|k| k.len() >= 40) {
            let _ = std::fs::write(dir.join("pair.json"), json!({ "key": k }).to_string());
            return;
        }
    }
}
fn sign(key: &[u8], t: &str) -> String { bar_agent::img::b64(&crate::crypto::hmac_sha256(key, t.as_bytes())) }

// ---------- WebSocket ----------
fn ws_send(s: &Sock, text: &str) -> bool {
    let b = text.as_bytes();
    let mut f = vec![0x81u8];
    if b.len() < 126 { f.push(b.len() as u8); } else if b.len() < 65536 { f.push(126); f.extend((b.len() as u16).to_be_bytes()); } else { f.push(127); f.extend((b.len() as u64).to_be_bytes()); }
    f.extend_from_slice(b);
    s.lock().unwrap().write_all(&f).is_ok()
}
fn ws_read(r: &mut TcpStream) -> std::io::Result<Option<(u8, Vec<u8>)>> {
    let mut msg = Vec::new();
    let mut op0 = 0u8;
    loop {
        let mut h = [0u8; 2];
        r.read_exact(&mut h)?;
        let (fin, op) = (h[0] & 0x80 != 0, h[0] & 0x0f);
        let mut len = (h[1] & 0x7f) as u64;
        if len == 126 { let mut b = [0u8; 2]; r.read_exact(&mut b)?; len = u16::from_be_bytes(b) as u64; } else if len == 127 { let mut b = [0u8; 8]; r.read_exact(&mut b)?; len = u64::from_be_bytes(b); }
        if len > 8 << 20 { return Ok(None); }
        let mut mask = [0u8; 4];
        if h[1] & 0x80 != 0 { r.read_exact(&mut mask)?; }
        let mut p = vec![0u8; len as usize];
        r.read_exact(&mut p)?;
        if h[1] & 0x80 != 0 { for (i, c) in p.iter_mut().enumerate() { *c ^= mask[i % 4]; } }
        match op {
            0x8 => return Ok(None),
            0x9 => { let mut f = vec![0x8Au8, p.len() as u8]; f.extend(&p); let _ = r.write_all(&f); continue; }
            0xA => continue,
            _ => {}
        }
        if op != 0 { op0 = op; }
        msg.extend(p);
        if fin { return Ok(Some((op0, msg))); }
    }
}
fn handshake(s: &mut TcpStream) -> bool {
    let mut buf = Vec::new();
    let mut b = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") { if s.read_exact(&mut b).is_err() || buf.len() > 16384 { return false; } buf.push(b[0]); }
    let req = String::from_utf8_lossy(&buf).to_string();
    let first = req.lines().next().unwrap_or("");
    let hdr = |k: &str| req.lines().find_map(|l| l.split_once(':').filter(|(a, _)| a.trim().eq_ignore_ascii_case(k)).map(|(_, v)| v.trim().to_string()));
    let origin = hdr("origin").unwrap_or_default();
    let okorigin = origin == format!("chrome-extension://{}", EXT_ID) || origin == format!("extension://{}", EXT_ID);
    if !first.starts_with("GET /bar-ext ") || !okorigin { let _ = s.write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return false; }
    let Some(key) = hdr("sec-websocket-key") else { return false };
    let acc = bar_agent::img::b64(&crate::crypto::sha1(format!("{}258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key).as_bytes()));
    s.write_all(format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n", acc).as_bytes()).is_ok()
}
fn conn(mut s: TcpStream) {
    if !handshake(&mut s) { return; }
    let Ok(w) = s.try_clone() else { return };
    let sock: Sock = Arc::new(Mutex::new(w));
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    let key = with(|m| m.key.clone());
    let mut my = String::new();
    let mut trusted = false;
    loop {
        let msg = match ws_read(&mut s) { Ok(Some((_, m))) => m, _ => break };
        let Ok(v) = serde_json::from_slice::<Value>(&msg) else { continue };
        if !trusted {
            if let Some(h) = v["hello"].as_str().filter(|_| my.is_empty()) {
                my = bar_agent::img::b64(&crate::crypto::random(24));
                ws_send(&sock, &json!({ "auth": sign(&key, &format!("bar:{}", h)), "nonce": my }).to_string());
            } else if let Some(a) = v["auth"].as_str().filter(|_| !my.is_empty()) {
                if !crate::crypto::same(a.as_bytes(), sign(&key, &format!("ext:{}", my)).as_bytes()) { break; }
                trusted = true;
                let _ = s.set_read_timeout(None);
                let old = with(|m| m.sock.replace(sock.clone()));
                if let Some(o) = old { let _ = o.lock().unwrap().shutdown(std::net::Shutdown::Both); }
                std::thread::spawn(on_connected);
            } else { break; }
            continue;
        }
        if let Some(id) = v["id"].as_u64() { if let Some(tx) = with(|m| m.pending.remove(&id)) { let _ = tx.send(v); } }
    }
    let mine = with(|m| if m.sock.as_ref().map_or(false, |x| Arc::ptr_eq(x, &sock)) { m.sock = None; m.ext = Value::Null; m.tab = false; m.last = Value::Null; true } else { false });
    if mine { push(); }
}
fn call(f: &str, args: Value, ms: u64) -> Result<Value, String> {
    let (tx, rx) = channel();
    let (sock, id) = with(|m| { m.seq += 1; let id = m.seq; m.pending.insert(id, tx); (m.sock.clone(), id) });
    let Some(sock) = sock else { with(|m| m.pending.remove(&id)); return Err("extension".into()) };
    if !ws_send(&sock, &json!({ "id": id, "fn": f, "args": args }).to_string()) { with(|m| m.pending.remove(&id)); return Err("extension".into()); }
    match rx.recv_timeout(Duration::from_millis(ms)) {
        Ok(v) => if let Some(e) = v["error"].as_str() { Err(e.to_string()) } else { Ok(v["result"].clone()) },
        Err(_) => { with(|m| m.pending.remove(&id)); Err("timeout".into()) }
    }
}
fn push() {
    let v = with(|m| {
        let mut o = json!({ "ext": m.sock.is_some(), "extVersion": m.ext["version"], "tab": m.tab, "port": m.port });
        if let Some(l) = m.last.as_object() { for (k, x) in l { o[k] = x.clone(); } }
        o["web"] = m.web.clone();
        o
    });
    ctx::emit("music-state", v);
}
fn remember(st: &Value) {
    let Some(id) = st["id"].as_str().filter(|x| !x.is_empty()) else { return };
    let (changed, save) = with(|m| {
        let changed = m.resume["videoId"].as_str() != Some(id);
        m.resume = json!({ "videoId": id, "list": st["list"].as_str().unwrap_or(""), "time": st["time"].as_f64().unwrap_or(0.0).floor(), "title": st["title"].as_str().unwrap_or(""), "at": ctx::now_ms() });
        let save = changed || ctx::now_ms() - m.resume_saved > 15000;
        if save { m.resume_saved = ctx::now_ms(); }
        (changed, save.then(|| m.resume.clone()))
    });
    let _ = changed;
    if let Some(r) = save { let _ = std::fs::write(last_file(), r.to_string()); }
}
fn on_connected() {
    let Ok(h) = call("hello", json!([]), 15000) else { return };
    let want = serde_json::from_str::<Value>(T_MANIFEST).ok().and_then(|v| v["version"].as_str().map(String::from)).unwrap_or_default();
    with(|m| { m.ext = h.clone(); m.tab = h["tab"].as_bool().unwrap_or(false); });
    push();
    // расширение старее нашего — обновить файлы там, откуда его загрузил браузер, и попросить перезагрузиться (один раз на версию)
    if let Some(v) = h["version"].as_str() {
        if v != want && with(|m| m.upd.insert(want.clone())) {
            let mut dirs = vec![ext_dir()]; dirs.extend(browser_dirs());
            for d in dirs { if d.join("pair.json").exists() { build_ext(&d); } }
            let _ = call("update", json!([]), 5000);
        }
    }
}
fn poll_loop() {
    loop {
        let watching = with(|m| m.watching);
        std::thread::sleep(Duration::from_millis(if watching { 600 } else { 3000 }));
        if with(|m| m.sock.is_none()) { continue; }
        match call("state", json!([]), 4000) {
            Ok(st) => { remember(&st); with(|m| { m.tab = true; m.last = st; }); }
            Err(e) => if e.contains("no-tab") { with(|m| { m.tab = false; m.last = Value::Null; }); },
        }
        let web = call("webTabs", json!([]), 4000).ok().and_then(|l| l.as_array().cloned()).and_then(|list| {
            let cur = with(|m| m.web["tabId"].as_i64());
            list.iter().find(|t| t["playing"].as_bool() == Some(true)).or_else(|| cur.and_then(|c| list.iter().find(|t| t["tabId"].as_i64() == Some(c)))).or(list.first()).cloned()
        });
        with(|m| m.web = web.unwrap_or(Value::Null));
        push();
    }
}

pub fn start() {
    let dir = ext_dir();
    build_ext(&dir);
    adopt_key(&dir);
    let key = build_ext(&dir);
    let resume = std::fs::read_to_string(last_file()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null);
    with(|m| { m.key = key; m.resume = resume; });
    std::thread::spawn(|| {
        for p in PORTS {
            let Ok(l) = TcpListener::bind(("127.0.0.1", p)) else { continue };
            with(|m| m.port = p);
            for s in l.incoming().flatten() { std::thread::spawn(move || conn(s)); }
            break;
        }
    });
    std::thread::spawn(poll_loop);
    // прежний вариант (отдельный Edge от Bar) больше не используется — закрыть его, если остался запущенным
    std::thread::spawn(|| { let d = ctx::data_dir().join("edge-music"); let _ = ctx::sh().act.call_t("killedge", &bar_agent::img::b64(d.to_string_lossy().as_bytes()), 15000); });
}

pub fn handle(ch: &str, a: &[Value]) -> Value {
    let arg = |i: usize| a.get(i).cloned().unwrap_or(Value::Null);
    match ch {
        "music-status" => with(|m| json!({ "ext": m.sock.is_some(), "tab": m.tab, "port": m.port, "state": m.last })),
        "music-install" => {
            let d = ext_dir();
            build_ext(&d);
            crate::clip::write_text(&d.to_string_lossy());
            crate::shell::show_in_folder(&d.join("manifest.json").to_string_lossy());
            json!({ "path": d.to_string_lossy() })
        }
        "music-open" => call("openTab", json!([]), 15000).unwrap_or(json!(false)),
        "music-watch" => { with(|m| m.watching = arg(0).as_bool().unwrap_or(false)); Value::Null }
        "music-cmd" => {
            let cmd = arg(0).as_str().unwrap_or("").to_string();
            if !["toggle", "next", "prev", "seek", "volume", "like", "dislike", "shuffle", "repeat", "playQueue", "play"].contains(&cmd.as_str()) { return json!(false); }
            // «Играть» берёт с собой последний трек: если плеер пуст или вкладки нет, расширение включит его
            let args = if cmd == "toggle" { let r = with(|m| m.resume.clone()); if r.is_null() { json!([]) } else { json!([r]) } } else if arg(1).is_null() { json!([]) } else { json!([arg(1)]) };
            let r = call(&cmd, args, if cmd == "toggle" { 40000 } else { 15000 }).unwrap_or(json!(false));
            std::thread::spawn(|| { std::thread::sleep(Duration::from_millis(300)); if let Ok(st) = call("state", json!([]), 3000) { remember(&st); with(|m| { m.last = st; m.tab = true; }); push(); } });
            r
        }
        "music-web" => {
            let f = match arg(0).as_str().unwrap_or("") { "toggle" => "wtoggle", "next" => "wnext", "prev" => "wprev", "seek" => "wseek", "volume" => "wvolume", "open" => "webOpen", _ => return json!(false) };
            let Some(tab) = arg(2).as_i64() else { return json!(false) };
            let args = if arg(1).is_null() { json!([tab]) } else { json!([tab, arg(1)]) };
            let r = call(f, args, 15000).unwrap_or(json!(false));
            std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(300)); if let Ok(l) = call("webTabs", json!([]), 3000) { if let Some(t) = l.as_array().and_then(|a| a.iter().find(|x| x["tabId"].as_i64() == Some(tab)).cloned()) { with(|m| m.web = t); push(); } } });
            r
        }
        "music-queue" => call("queue", json!([]), 15000).unwrap_or(json!([])),
        "music-browse" => call("browse", json!([arg(0), arg(1).as_str().unwrap_or("")]), 15000).unwrap_or(Value::Null),
        "music-search" => call("search", json!([arg(0).as_str().unwrap_or("").chars().take(200).collect::<String>()]), 15000).unwrap_or(Value::Null),
        "music-lyrics" => call("lyrics", json!([arg(0)]), 15000).unwrap_or(json!({ "text": "", "source": "" })),
        _ => Value::Null,
    }
}

// ---------- картинки ----------
fn host_ok(h: &str) -> bool {
    // «#» — цифры, «*» — буквы/цифры/дефис
    const P: [&str; 18] = ["lh#.googleusercontent.com", "yt#.ggpht.com", "i#.ytimg.com", "i.ytimg.com", "yt#.googleusercontent.com", "avatars.yandex.net", "avatars.mds.yandex.net",
        "i#.sndcdn.com", "i.scdn.co", "*.userapi.com", "*.vkuserphoto.ru", "is#-ssl.mzstatic.com", "e-cdns-images.dzcdn.net", "cdn-images.dzcdn.net", "resources.tidal.com", "f#.bcbits.com", "cdn-image.zvuk.com", "m.media-amazon.com"];
    let m = |p: &str, s: &str| -> bool {
        fn go(p: &[u8], s: &[u8]) -> bool {
            match p.first() {
                None => s.is_empty(),
                Some(b'#') => { let n = s.iter().take_while(|c| c.is_ascii_digit()).count(); n > 0 && (1..=n).any(|k| go(&p[1..], &s[k..])) }
                Some(b'*') => { let n = s.iter().take_while(|c| c.is_ascii_alphanumeric() || **c == b'-').count(); n > 0 && (1..=n).any(|k| go(&p[1..], &s[k..])) }
                Some(c) => s.first() == Some(c) && go(&p[1..], &s[1..]),
            }
        }
        go(p.as_bytes(), s.as_bytes())
    };
    P.iter().any(|p| m(p, h)) || h == "thumbnailer.mixcloud.com"
}
pub fn image(path: &str) -> (u16, String, Vec<u8>) {
    let raw = path.trim_start_matches('/').strip_prefix("img/").unwrap_or("");
    let url = percent_decode(raw);
    let host = url.strip_prefix("https://").and_then(|r| r.split(['/', '?', ':']).next()).unwrap_or("").to_lowercase();
    if host.is_empty() || !host_ok(&host) { return (403, "text/plain".into(), vec![]); }
    match ureq::get(&url).timeout(Duration::from_secs(15)).call() {
        Ok(r) => {
            let ct = r.header("content-type").unwrap_or("image/jpeg").to_string();
            let mut b = Vec::new();
            let _ = r.into_reader().take(8 << 20).read_to_end(&mut b);
            (200, ct, b)
        }
        Err(_) => (502, "text/plain".into(), vec![]),
    }
}
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes(); let mut out = Vec::new(); let mut i = 0;
    while i < b.len() { if b[i] == b'%' && i + 3 <= b.len() { if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) { out.push(v); i += 3; continue; } } out.push(b[i]); i += 1; }
    String::from_utf8_lossy(&out).to_string()
}
