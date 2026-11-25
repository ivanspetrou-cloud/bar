// Общее для всех частей Bar: ссылка на приложение и на общее состояние, папки данных, отправка событий в окна.
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter};

use crate::Shared;

/// Папка данных Bar в %APPDATA% (та же, что у Electron-версии, — настройки переходят как есть)
pub const DATA: &str = "Bar Tauri";
/// Папка с файлами пользователя в «Документах» (скриншоты, диктофон, файлы с телефона)
pub const DOCS: &str = "Bar Tauri";

static APP: OnceLock<AppHandle> = OnceLock::new();
static SH: OnceLock<Arc<Shared>> = OnceLock::new();
pub fn set(app: AppHandle, sh: Arc<Shared>) { let _ = APP.set(app); let _ = SH.set(sh); }
pub fn app() -> &'static AppHandle { APP.get().expect("app") }
pub fn sh() -> &'static Arc<Shared> { SH.get().expect("shared") }
pub fn ready() -> bool { SH.get().is_some() }

pub fn data_dir() -> PathBuf {
    let d = PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join(DATA);
    let _ = std::fs::create_dir_all(&d);
    d
}
pub fn docs_dir(sub: &str) -> PathBuf {
    let base = PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join("Documents").join(DOCS);
    let d = if sub.is_empty() { base } else { base.join(sub) };
    let _ = std::fs::create_dir_all(&d);
    d
}
pub fn stamp() -> String {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    let t = unsafe { GetLocalTime() };
    format!("{:04}-{:02}-{:02}-{:02}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}
pub fn now_ms() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }

/// событие окну нотча
pub fn emit<S: Serialize + Clone>(ch: &str, v: S) { if let Some(a) = APP.get() { let _ = a.emit_to("main", ch, v); } }
/// событие конкретному окну (док на мониторе, окно захвата)
pub fn emit_to<S: Serialize + Clone>(label: &str, ch: &str, v: S) { if let Some(a) = APP.get() { let _ = a.emit_to(label, ch, v); } }

// настройки готовы раньше остального состояния (окно нотча спрашивает монитор при создании)
static SETTINGS: OnceLock<crate::settings::Settings> = OnceLock::new();
pub fn set_settings(s: crate::settings::Settings) { let _ = SETTINGS.set(s); }
pub fn sh_settings() -> &'static crate::settings::Settings { SETTINGS.get().expect("settings") }
pub fn try_sh() -> Option<&'static Arc<Shared>> { SH.get() }
