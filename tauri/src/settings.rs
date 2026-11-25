// Настройки: тот же settings.json, что у Electron-версии (папка данных Bar Tauri).
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

#[derive(Clone)]
pub struct Settings { v: Arc<Mutex<Map<String, Value>>>, file: PathBuf }
impl Settings {
    pub fn dir() -> PathBuf {
        let d = PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("Bar Tauri");
        let _ = std::fs::create_dir_all(&d);
        d
    }
    pub fn load() -> Settings {
        let file = Self::dir().join("settings.json");
        let mut m: Map<String, Value> = json!({ "clipHistory": true, "ocrLang": "", "hidden": false, "idleHide": 60 }).as_object().unwrap().clone();
        if let Ok(t) = std::fs::read_to_string(&file) { if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&t) { m.extend(o); } }
        Settings { v: Arc::new(Mutex::new(m)), file }
    }
    pub fn get(&self, k: &str) -> Value { self.v.lock().unwrap().get(k).cloned().unwrap_or(Value::Null) }
    fn save(&self) { let t = serde_json::to_string_pretty(&*self.v.lock().unwrap()).unwrap_or_default(); let _ = std::fs::write(&self.file, t); }
    // из окна меняются только эти ключи (как в Electron-версии)
    pub fn patch(&self, p: &Value) {
        if let Some(o) = p.as_object() {
            let mut v = self.v.lock().unwrap();
            for k in ["clipHistory", "ocrLang", "idleHide", "notchOn", "micDev"] { if let Some(x) = o.get(k) { v.insert(k.into(), x.clone()); } }
        }
        self.save();
    }
    pub fn public(&self, app: &AppHandle) -> Value {
        let mut m = self.v.lock().unwrap().clone();
        let prim = app.primary_monitor().ok().flatten().map(|m| *m.position());
        let mons: Vec<Value> = app.available_monitors().unwrap_or_default().iter().enumerate().map(|(i, d)| json!({
            "id": format!("{},{}", d.position().x, d.position().y), "n": i + 1, "w": d.size().width, "h": d.size().height, "primary": Some(*d.position()) == prim,
        })).collect();
        m.insert("displays".into(), json!(mons));
        m.insert("autostart".into(), json!(false));
        m.insert("version".into(), json!(app.package_info().version.to_string()));
        Value::Object(m)
    }
}
