// bar-agent.exe — отдельный процесс для Electron-версии Bar.
// Протокол: на вход строки «id команда аргумент», на выход по строке JSON {"id","ok","data"}.
// Первая строка — {"id":0,"ok":true,"data":"ready","cmds":[…]}. Режимы meter и winevents — отдельные фоновые процессы.
#![windows_subsystem = "windows"] // без консоли и conhost: stdin/stdout — каналы от Bar
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED};

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("meter") => { unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); } bar_agent::events::meter(); return; }
        Some("winevents") => { unsafe { let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED); } bar_agent::events::winevents(); return; }
        _ => {}
    }
    let bar_pid = std::env::var("BAR_PID").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut core = bar_agent::Core::new(bar_pid);
    let out = std::io::stdout();
    let send = |v: Value| { let mut o = out.lock(); let _ = writeln!(o, "{}", v); let _ = o.flush(); };
    send(json!({ "id": 0, "ok": true, "data": "ready", "cmds": bar_agent::CMDS }));
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let mut parts = line.splitn(3, ' ');
        let id = parts.next().unwrap_or("").to_string();
        let cmd = parts.next().unwrap_or("");
        let arg = parts.next().unwrap_or("");
        match core.exec(cmd, arg) {
            Ok(v) => send(json!({ "id": id, "ok": true, "data": v })),
            Err(e) => send(json!({ "id": id, "ok": false, "data": e })),
        }
    }
}
