// Настройки: тот же settings.json, что у Electron-версии (в папке данных Bar) — переходят как есть.
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Settings { v: Arc<Mutex<Map<String, Value>>>, file: PathBuf, pub first_run: bool }
impl Settings {
    pub fn load() -> Settings {
        let file = crate::ctx::data_dir().join("settings.json");
        let first_run = !file.exists();
        let mut m: Map<String, Value> = json!({ "clipHistory": true, "ocrLang": "", "hidden": false, "idleHide": 60 }).as_object().unwrap().clone();
        if let Ok(t) = std::fs::read_to_string(&file) { if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&t) { m.extend(o); } }
        Settings { v: Arc::new(Mutex::new(m)), file, first_run }
    }
    pub fn get(&self, k: &str) -> Value { self.v.lock().unwrap().get(k).cloned().unwrap_or(Value::Null) }
    pub fn save(&self) { let t = serde_json::to_string_pretty(&*self.v.lock().unwrap()).unwrap_or_default(); let _ = std::fs::write(&self.file, t); }
    pub fn put(&self, k: &str, v: Value) { self.v.lock().unwrap().insert(k.into(), v); self.save(); }
    pub fn remove(&self, k: &str) { self.v.lock().unwrap().remove(k); self.save(); }
    /// из окна меняются только эти ключи (как в Electron-версии)
    pub fn patch(&self, p: &Value) {
        if let Some(o) = p.as_object() {
            let mut v = self.v.lock().unwrap();
            for k in ["clipHistory", "ocrLang", "idleHide", "notchOn", "micDev"] { if let Some(x) = o.get(k) { v.insert(k.into(), x.clone()); } }
        }
        self.save();
    }
    pub fn public(&self) -> Value {
        let mut m = self.v.lock().unwrap().clone();
        let n = &crate::ctx::sh().notch.win;
        let prim = n.primary_monitor().ok().flatten().map(|m| crate::notch::mon_id(&m));
        let mons: Vec<Value> = n.available_monitors().unwrap_or_default().iter().enumerate().map(|(i, d)| json!({
            "id": crate::notch::mon_id(d), "n": i + 1, "w": d.size().width, "h": d.size().height, "primary": Some(crate::notch::mon_id(d)) == prim,
        })).collect();
        m.insert("displays".into(), json!(mons));
        m.insert("autostart".into(), json!(crate::shell::autostart()));
        m.insert("version".into(), json!(crate::ctx::app().package_info().version.to_string()));
        Value::Object(m)
    }
}
