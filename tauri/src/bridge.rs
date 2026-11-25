// Мост «ПК ⇄ телефон» по Wi-Fi: телефон сканирует QR и открывает страницу в браузере.
// Только локальная сеть, доступ по случайному токену; сервер сам выключается после 20 минут без запросов.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::ctx;

const PAGE: &str = include_str!("../bridge-page.html");
const MAX_UPLOAD: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Default)]
struct St { url: String, token: String, files: Vec<String>, text: String, gen: u64 }
static ST: Mutex<St> = Mutex::new(St { url: String::new(), token: String::new(), files: Vec::new(), text: String::new(), gen: 0 });
static TOUCH: AtomicU64 = AtomicU64::new(0);

/// адрес этого ПК в локальной сети (по таблице маршрутов: UDP-«соединение» ничего не отправляет)
pub fn lan_ip() -> String {
    for probe in ["192.168.0.1:9", "10.0.0.1:9", "172.16.0.1:9"] {
        if let Ok(s) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if s.connect(probe).is_ok() { if let Ok(a) = s.local_addr() { let ip = a.ip().to_string(); if ip != "0.0.0.0" { return ip; } } }
        }
    }
    "127.0.0.1".into()
}
fn token() -> String { bar_agent::img::b64(&crate::crypto::random(12)).replace(['+', '/', '='], "x") }

pub fn start(files: &Value) -> Value {
    set_files(files);
    let mut st = ST.lock().unwrap();
    if !st.url.is_empty() { return json!({ "url": st.url }); }
    let ip = lan_ip();
    let Ok(l) = TcpListener::bind((ip.as_str(), 0)) else { return Value::Null };
    let port = l.local_addr().map(|a| a.port()).unwrap_or(0);
    st.token = token();
    st.url = format!("http://{}:{}/?t={}", ip, port, st.token);
    st.gen += 1;
    let gen = st.gen;
    TOUCH.store(ctx::now_ms(), Ordering::Relaxed);
    let url = st.url.clone();
    drop(st);
    std::thread::spawn(move || {
        let _ = l.set_nonblocking(true);
        loop {
            if ST.lock().unwrap().gen != gen { break; }
            if ctx::now_ms().saturating_sub(TOUCH.load(Ordering::Relaxed)) > 20 * 60_000 { stop(); break; }
            match l.accept() {
                Ok((s, _)) => { let _ = s.set_nonblocking(false); std::thread::spawn(move || { let _ = handle(s); }); }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        }
    });
    json!({ "url": url })
}
pub fn stop() -> Value { let mut st = ST.lock().unwrap(); st.url.clear(); st.token.clear(); st.gen += 1; json!(true) }
pub fn set_files(v: &Value) { ST.lock().unwrap().files = v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(); }
pub fn set_text(t: &str) { ST.lock().unwrap().text = t.to_string(); }

fn unique(dir: &Path, name: &str) -> PathBuf {
    let base = Path::new(name).file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
    let safe: String = base.chars().map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 32 { '_' } else { c }).take(120).collect();
    let safe = if safe.is_empty() { "file".to_string() } else { safe };
    let p = Path::new(&safe);
    let (stem, ext) = (p.file_stem().map(|x| x.to_string_lossy().to_string()).unwrap_or_default(), p.extension().map(|x| format!(".{}", x.to_string_lossy())).unwrap_or_default());
    let mut out = dir.join(&safe);
    let mut i = 1;
    while out.exists() { out = dir.join(format!("{} ({}){}", stem, i, ext)); i += 1; }
    out
}
fn pct_decode(s: &str) -> String {
    let b = s.as_bytes(); let mut out = Vec::new(); let mut i = 0;
    while i < b.len() { if b[i] == b'%' && i + 2 < b.len() + 0 && i + 2 <= b.len() - 1 { if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) { out.push(v); i += 3; continue; } } out.push(if b[i] == b'+' { b' ' } else { b[i] }); i += 1; }
    String::from_utf8_lossy(&out).to_string()
}
fn pct_encode(s: &str) -> String { s.bytes().map(|c| if c.is_ascii_alphanumeric() || b"-_.~".contains(&c) { (c as char).to_string() } else { format!("%{:02X}", c) }).collect() }

fn send(s: &mut TcpStream, code: u16, ctype: &str, extra: &str, body: &[u8]) -> std::io::Result<()> {
    let reason = match code { 200 => "OK", 400 => "Bad Request", 403 => "Forbidden", 404 => "Not Found", 413 => "Payload Too Large", _ => "Error" };
    write!(s, "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'\r\nConnection: close\r\n{}\r\n", code, reason, ctype, body.len(), extra)?;
    s.write_all(body)
}
fn handle(s: TcpStream) -> std::io::Result<()> {
    let mut r = BufReader::new(s.try_clone()?);
    let mut s = s;
    let mut line = String::new();
    r.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
    let mut headers = std::collections::HashMap::new();
    loop { let mut h = String::new(); if r.read_line(&mut h)? == 0 || h.trim().is_empty() { break; } if let Some((k, v)) = h.split_once(':') { headers.insert(k.trim().to_lowercase(), v.trim().to_string()); } }
    let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
    let t = query.split('&').find_map(|kv| kv.strip_prefix("t=")).map(pct_decode).unwrap_or_default();
    let (tok, files, text) = { let st = ST.lock().unwrap(); (st.token.clone(), st.files.clone(), st.text.clone()) };
    if tok.is_empty() || !crate::crypto::same(t.as_bytes(), tok.as_bytes()) { return send(&mut s, 403, "text/plain", "", b"forbidden"); }
    TOUCH.store(ctx::now_ms(), Ordering::Relaxed);
    let len: u64 = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    match (method.as_str(), path) {
        ("GET", "/") => send(&mut s, 200, "text/html; charset=utf-8", "", PAGE.as_bytes()),
        ("GET", "/api/state") => {
            let list: Vec<Value> = files.iter().enumerate().filter_map(|(i, p)| std::fs::metadata(p).ok().map(|m| json!({ "i": i, "name": Path::new(p).file_name().map(|x| x.to_string_lossy()).unwrap_or_default(), "size": m.len() }))).collect();
            send(&mut s, 200, "application/json; charset=utf-8", "", json!({ "files": list, "text": text }).to_string().as_bytes())
        }
        ("GET", p) if p.starts_with("/f/") => {
            let Some(f) = p[3..].parse::<usize>().ok().and_then(|i| files.get(i)) else { return send(&mut s, 404, "text/plain", "", b"") };
            let Ok(mut file) = std::fs::File::open(f) else { return send(&mut s, 404, "text/plain", "", b"") };
            let size = file.metadata()?.len();
            let name = Path::new(f).file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
            write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nContent-Disposition: attachment; filename*=UTF-8''{}\r\nConnection: close\r\n\r\n", size, pct_encode(&name))?;
            std::io::copy(&mut file, &mut s).map(|_| ())
        }
        ("POST", "/up") => {
            if len > MAX_UPLOAD { return send(&mut s, 413, "text/plain", "", b""); }
            let name = headers.get("x-name").map(|v| pct_decode(v)).unwrap_or_else(|| "file".into());
            let dest = unique(&ctx::docs_dir("From phone"), &name);
            let mut out = std::fs::File::create(&dest)?;
            let copied = std::io::copy(&mut (&mut r).take(len), &mut out)?;
            drop(out);
            if copied != len { let _ = std::fs::remove_file(&dest); return send(&mut s, 400, "text/plain", "", b""); }
            ctx::emit("bridge-file", json!({ "name": dest.file_name().map(|x| x.to_string_lossy()).unwrap_or_default(), "path": dest.to_string_lossy() }));
            send(&mut s, 200, "text/plain", "", b"ok")
        }
        ("POST", "/text") => {
            let mut body = Vec::new();
            (&mut r).take(len.min(1_000_000)).read_to_end(&mut body)?;
            let t = String::from_utf8_lossy(&body).to_string();
            if !t.trim().is_empty() { crate::clip::write_text(&t); ctx::emit("bridge-text", t); }
            send(&mut s, 200, "text/plain", "", b"ok")
        }
        _ => send(&mut s, 404, "text/plain", "", b""),
    }
}
