// Захват экрана для инструментов «Текст с экрана» (OCR), «Пипетка», «QR с экрана» и «Скриншот»:
// снимок монитора под курсором (GDI), окно выделения поверх всего (overlay.html), результат — в буфер обмена и в нотч.
// Снимок не уходит никуда: окно выделения забирает его у этого же процесса по http://barcap.localhost.
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use windows::Win32::Graphics::Gdi::*;

use crate::ctx;

struct Cap { mode: String, w: i32, h: i32, data: Vec<u8> }
static CAP: Mutex<Option<Cap>> = Mutex::new(None);

/// содержимое для окна выделения: пиксели снимка (BGRA, сверху вниз)
pub fn bytes() -> Vec<u8> { CAP.lock().unwrap().as_ref().map(|c| c.data.clone()).unwrap_or_default() }
pub fn init() -> Value { CAP.lock().unwrap().as_ref().map(|c| json!({ "mode": c.mode, "width": c.w, "height": c.h })).unwrap_or(Value::Null) }

fn grab(x: i32, y: i32, w: i32, h: i32) -> Option<Vec<u8>> {
    unsafe {
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        let bi = BITMAPINFO { bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() }, ..Default::default() };
        let mut bits = std::ptr::null_mut();
        let r = (|| {
            let dib = CreateDIBSection(Some(dc), &bi, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
            let old = SelectObject(dc, HGDIOBJ(dib.0));
            let ok = BitBlt(dc, 0, 0, w, h, Some(screen), x, y, SRCCOPY | CAPTUREBLT).is_ok();
            SelectObject(dc, old);
            let v = if ok && !bits.is_null() { Some(std::slice::from_raw_parts(bits as *const u8, (w * h * 4) as usize).to_vec()) } else { None };
            let _ = DeleteObject(HGDIOBJ(dib.0));
            v
        })();
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
        r
    }
}

pub fn start(mode: &str) {
    if ctx::app().get_webview_window("overlay").is_some() { return; }
    let sh = ctx::sh();
    ctx::emit("collapse", Value::Null);
    std::thread::sleep(Duration::from_millis(160));
    let cur = crate::notch::cursor();
    let mons = sh.notch.win.available_monitors().unwrap_or_default();
    let Some(m) = mons.iter().find(|m| { let (x, y, w, h) = (m.position().x, m.position().y, m.size().width as i32, m.size().height as i32); cur.0 >= x && cur.0 < x + w && cur.1 >= y && cur.1 < y + h }).or(mons.first()).cloned() else { return };
    sh.notch.hide(); // не попадать на собственный снимок
    std::thread::sleep(Duration::from_millis(60));
    let (x, y, w, h) = (m.position().x, m.position().y, m.size().width as i32, m.size().height as i32);
    let Some(data) = grab(x, y, w, h) else { sh.notch.show(); ctx::emit("tool-result", json!({ "type": "error", "text": "Нет доступа к экрану" })); return };
    *CAP.lock().unwrap() = Some(Cap { mode: mode.into(), w, h, data });
    let app = ctx::app().clone();
    let _ = app.clone().run_on_main_thread(move || {
        let Ok(ov) = WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("overlay.html".into())).additional_browser_args(crate::webview::ARGS)
            .title("Bar — захват").decorations(false).always_on_top(true).skip_taskbar(true).resizable(false).shadow(false)
            .visible(false).focused(true).disable_drag_drop_handler().build() else { return };
        crate::webview::attach(&ov);
        let _ = ov.set_size(PhysicalSize::new(w as u32, h as u32));
        let _ = ov.set_position(PhysicalPosition::new(x, y));
        let _ = ov.show();
        let _ = ov.set_focus();
        ov.on_window_event(|e| if let tauri::WindowEvent::Destroyed = e { *CAP.lock().unwrap() = None; ctx::sh().notch.show(); });
    });
}

pub fn done(res: Value) {
    if let Some(ov) = ctx::app().get_webview_window("overlay") { let _ = ov.destroy(); }
    let sh = ctx::sh();
    sh.notch.show();
    if res.is_null() { return; }
    let png = || res["png"].as_str().and_then(|u| u.split_once(',')).map(|(_, b)| bar_agent::img::unb64(b)).unwrap_or_default();
    match res["mode"].as_str().unwrap_or("") {
        "color" => { crate::clip::write_text(res["hex"].as_str().unwrap_or("")); let mut r = res.clone(); r["type"] = json!("color"); ctx::emit("tool-result", r); }
        "qrscan" => {
            let t = res["text"].as_str().unwrap_or("");
            if !t.is_empty() { crate::clip::write_text(t); }
            ctx::emit("tool-result", json!({ "type": "qrscan", "text": if t.is_empty() { Value::Null } else { json!(t) } }));
        }
        "shot" => {
            let p = png();
            crate::clip::write_png(&p);
            let f = ctx::docs_dir("Screenshots").join(format!("screenshot-{}.png", ctx::stamp()));
            let _ = std::fs::write(&f, &p);
            ctx::emit("tool-result", json!({ "type": "shot", "path": f.to_string_lossy(), "thumb": res["png"] }));
        }
        "ocr" => {
            ctx::emit("busy", "ocr");
            let f = std::env::temp_dir().join(format!("bar-ocr-{}.png", std::process::id()));
            let _ = std::fs::write(&f, png());
            let lang = sh.settings.get("ocrLang").as_str().unwrap_or("").to_string();
            let arg = bar_agent::img::b64(format!("{}|{}", f.to_string_lossy(), lang).as_bytes());
            let r = sh.act.call_t("ocr", &arg, 30000);
            let _ = std::fs::remove_file(&f);
            ctx::emit("busy", Value::Null);
            match r {
                Ok(v) => {
                    let text = v.as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default().trim().to_string();
                    if !text.is_empty() { crate::clip::write_text(&text); }
                    ctx::emit("tool-result", json!({ "type": "ocr", "text": text }));
                }
                Err(e) => ctx::emit("tool-result", json!({ "type": "error", "text": e })),
            }
        }
        _ => {}
    }
}
