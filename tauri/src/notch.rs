// Окно нотча: прозрачное, поверх всех окон, без рамки и без кнопки на панели задач, сверху по центру монитора.
// Свёрнутый нотч — окно 820×44, раскрытый — 820×700 (как в Electron-версии).
// Прозрачность для мыши: у Electron есть «пропускать клики, но видеть курсор»; здесь окно пропускает клики,
// а этот модуль сам следит за курсором и делает окно кликабельным, пока курсор над нотчем (его прямоугольник
// присылает страница) или пока страница сама просит (открытая панель).
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, ShowWindow, SW_SHOWNOACTIVATE};

const WIN_W: f64 = 820.0;
const WIN_H: f64 = 700.0;
const PILL_H: f64 = 44.0;

#[derive(Default)]
struct St { mode: String, interactive: bool, zone: (i32, i32, i32, i32), pos: (i32, i32), size: (i32, i32), clickable: bool }

#[derive(Clone)]
pub struct Notch { win: WebviewWindow, st: Arc<Mutex<St>> }
impl Notch {
    pub fn create(app: &AppHandle) -> tauri::Result<Notch> {
        let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
            .title("Bar").inner_size(WIN_W, PILL_H).decorations(false).transparent(true).always_on_top(true)
            .skip_taskbar(true).resizable(false).shadow(false).focused(false).visible(false).build()?;
        let n = Notch { win, st: Arc::new(Mutex::new(St { mode: "pill".into(), ..Default::default() })) };
        n.place();
        let _ = n.win.set_ignore_cursor_events(true);
        if let Ok(h) = n.win.hwnd() { unsafe { let _ = ShowWindow(HWND(h.0 as *mut _), SW_SHOWNOACTIVATE); } } // показать, не забирая фокус
        let w = n.clone();
        std::thread::Builder::new().name("bar-cursor".into()).spawn(move || loop { w.track(); std::thread::sleep(Duration::from_millis(40)); }).ok();
        Ok(n)
    }
    // сверху по центру основного монитора
    fn place(&self) {
        let Some(m) = self.win.primary_monitor().ok().flatten() else { return };
        let k = m.scale_factor();
        let mode = self.st.lock().unwrap().mode.clone();
        let (w, h) = ((WIN_W * k).round() as i32, ((if mode == "full" { WIN_H } else { PILL_H }) * k).round() as i32);
        let x = m.position().x + (m.size().width as i32 - w) / 2;
        let y = m.position().y;
        let _ = self.win.set_size(PhysicalSize::new(w as u32, h as u32));
        let _ = self.win.set_position(PhysicalPosition::new(x, y));
        let mut st = self.st.lock().unwrap();
        st.pos = (x, y); st.size = (w, h);
    }
    pub fn set_mode(&self, mode: &str) -> String {
        let m = if mode == "full" { "full" } else { "pill" };
        let changed = { let mut st = self.st.lock().unwrap(); let c = st.mode != m; st.mode = m.into(); c };
        if changed { self.place(); }
        m.into()
    }
    pub fn set_interactive(&self, on: bool) { self.st.lock().unwrap().interactive = on; self.track(); }
    // «l,t,r,b» — где на странице нотч (физические пиксели внутри окна)
    pub fn set_zone(&self, z: &str) {
        let v: Vec<i32> = z.split(',').map(|x| x.trim().parse().unwrap_or(0)).collect();
        if v.len() == 4 { self.st.lock().unwrap().zone = (v[0], v[1], v[2], v[3]); }
    }
    pub fn focus(&self) { let _ = self.win.set_focus(); }
    fn track(&self) {
        let mut p = POINT::default();
        unsafe { let _ = GetCursorPos(&mut p); }
        let mut st = self.st.lock().unwrap();
        let (cx, cy) = (p.x - st.pos.0, p.y - st.pos.1);
        let inside_win = cx >= 0 && cy >= 0 && cx < st.size.0 && cy < st.size.1;
        let (l, t, r, b) = st.zone;
        // + полоска у верхнего края (как #hot): мышь у края экрана над нотчем раскрывает его
        let over = inside_win && ((cx >= l && cx < r && cy >= t && cy < b) || cy < 6);
        let want = over || (st.interactive && inside_win);
        if want != st.clickable {
            st.clickable = want;
            let _ = self.win.set_ignore_cursor_events(!want);
        }
    }
}

// значок в трее: показать / спрятать нотч, выйти
pub fn tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;
    use tauri::Manager;
    let toggle = MenuItem::with_id(app, "toggle", "Показать / спрятать нотч", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &quit])?;
    TrayIconBuilder::with_id("bar").tooltip("Bar")
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .menu(&menu)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "quit" => app.exit(0),
            "toggle" => if let Some(w) = app.get_webview_window("main") { if w.is_visible().unwrap_or(true) { let _ = w.hide(); } else { let _ = w.show(); } },
            _ => {}
        })
        .build(app)?;
    Ok(())
}
