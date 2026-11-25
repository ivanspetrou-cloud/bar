// Фоновый поток со своим ядром агента (bar_agent::Core): команды выполняются по очереди, как в отдельном bar-agent.exe.
// Несколько потоков — чтобы медленное (Bluetooth, заряд приёмников) не задерживало быстрое (звук, раскладка).
use serde_json::{json, Value};
use std::sync::mpsc::{channel, Sender};
use std::time::Duration;

type Job = (String, String, Sender<Result<Value, String>>);

#[derive(Clone)]
pub struct Worker { tx: Sender<Job> }
impl Worker {
    pub fn spawn(name: &str, bar_pid: u32) -> Worker {
        let (tx, rx) = channel::<Job>();
        std::thread::Builder::new().name(format!("bar-{}", name)).spawn(move || {
            let mut core = bar_agent::Core::new(bar_pid);
            for (cmd, arg, back) in rx {
                let r = if cmd == "__awake" { Ok(json!(awake(arg == "1"))) } else { core.exec(&cmd, &arg) };
                let _ = back.send(r);
            }
        }).expect("поток агента");
        Worker { tx }
    }
    pub fn call(&self, cmd: &str, arg: &str) -> Result<Value, String> { self.call_t(cmd, arg, 30_000) }
    pub fn call_t(&self, cmd: &str, arg: &str, ms: u64) -> Result<Value, String> {
        let (btx, brx) = channel();
        self.tx.send((cmd.to_string(), arg.to_string(), btx)).map_err(|e| e.to_string())?;
        brx.recv_timeout(Duration::from_millis(ms)).map_err(|_| format!("timeout: {}", cmd))?
    }
}

// «Не спать»: экран не гаснет и компьютер не засыпает, пока флаг стоит на этом (постоянном) потоке
fn awake(on: bool) -> bool {
    use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
    unsafe { SetThreadExecutionState(if on { ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS }); }
    on
}
