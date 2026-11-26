// Окно нотча: прозрачное, поверх всех окон, без рамки и без кнопки на панели задач, сверху по центру монитора.
// Режимы (как в Electron-версии): pill — свёрнут (820×44), full — раскрыт (820×700), в игре — stage (путь перелёта)
// и hud (плашка в углу). Свёрнутый/раскрытый нотч пропускает клики насквозь, пока курсор не над ним:
// у Tauri нет «пропускать клики, но видеть курсор», поэтому этот модуль сам следит за курсором.
// Также здесь: монитор нотча («за мышью»), автоскрытие без движения мыши, полоска над развёрнутым окном (tuck).
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

use crate::ctx;

const WIN_W: f64 = 820.0;
const WIN_H: f64 = 700.0;
const PILL_H: f64 = 44.0;

#[derive(Default)]
struct St {
    hud_track: bool, hud_rect: (i32, i32, i32, i32), band: i32,
    mode: String, interactive: bool, zone: (i32, i32, i32, i32), pos: (i32, i32), size: (i32, i32), clickable: bool,
    follow: Option<(i32, i32)>, cand: Option<((i32, i32), Instant)>, hud_hover: bool,
    idle_last: Option<Instant>, idle_pt: (i32, i32), idle_hidden: bool, tucked: Option<bool>,
}

#[derive(Clone)]
pub struct Notch { pub win: WebviewWindow, st: Arc<Mutex<St>> }

pub fn cursor() -> (i32, i32) { let mut p = POINT::default(); unsafe { let _ = GetCursorPos(&mut p); } (p.x, p.y) }
fn inside(m: &Monitor, p: (i32, i32)) -> bool {
    let (x, y, w, h) = (m.position().x, m.position().y, m.size().width as i32, m.size().height as i32);
    p.0 >= x && p.0 < x + w && p.1 >= y && p.1 < y + h
}
pub fn mon_id(m: &Monitor) -> String { format!("{},{}", m.position().x, m.position().y) }

impl Notch {
    pub fn create(app: &AppHandle, init: &str) -> tauri::Result<Notch> {
        let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
            .title("Bar").inner_size(WIN_W, PILL_H).decorations(false).transparent(true).always_on_top(true)
            .skip_taskbar(true).resizable(false).shadow(false).focused(false).visible(false)
            .disable_drag_drop_handler().initialization_script(init).build()?;
        crate::webview::attach(&win);
        let n = Notch { win, st: Arc::new(Mutex::new(St { mode: "pill".into(), ..Default::default() })) };
        crate::webview::low_memory(&n.win, true);
        n.place();
        let _ = n.win.set_ignore_cursor_events(true);
        let w = n.clone();
        std::thread::Builder::new().name("bar-cursor".into()).spawn(move || loop { w.track(); std::thread::sleep(Duration::from_millis(40)); }).ok();
        let w = n.clone();
        std::thread::Builder::new().name("bar-follow".into()).spawn(move || loop { w.follow_tick(); w.idle_tick(); std::thread::sleep(Duration::from_millis(200)); }).ok();
        Ok(n)
    }
    pub fn show(&self) { let _ = self.win.show(); }
    pub fn hide(&self) { let _ = self.win.hide(); }

    /// монитор нотча: основной, выбранный в настройках или тот, где сейчас курсор («за мышью»)
    pub fn display(&self) -> Option<Monitor> {
        let all = self.win.available_monitors().ok()?;
        let prim = self.win.primary_monitor().ok().flatten();
        let v = crate::ctx::sh_settings().get("notchOn");
        let v = v.as_str().unwrap_or("primary").to_string();
        if v == "follow" { if let Some(f) = self.st.lock().unwrap().follow { if let Some(m) = all.iter().find(|m| (m.position().x, m.position().y) == f) { return Some(m.clone()); } } }
        if v != "primary" && v != "follow" { if let Some(m) = all.iter().find(|m| mon_id(m) == v) { return Some(m.clone()); } }
        prim.or_else(|| all.first().cloned())
    }
    fn place(&self) {
        let Some(m) = self.display() else { return };
        let k = m.scale_factor();
        let mode = self.st.lock().unwrap().mode.clone();
        // окно — во всю ширину монитора, от его левого верхнего угла: переходы (раскрытие, игровой режим)
        // меняют только высоту окна, а не его положение — WebView2 не показывает кадр «картинка со сдвигом»
        let (w, h) = (m.size().width as i32, ((if mode == "full" { WIN_H } else { PILL_H }) * k).round() as i32);
        self.st.lock().unwrap().band = (WIN_W * k).round() as i32;
        self.set_bounds(m.position().x, m.position().y, w, h);
    }
    // положение и размер — одной командой Windows: без промежуточного кадра «новый размер, старое место» (перелёты в игре)
    fn set_bounds(&self, x: i32, y: i32, w: i32, h: i32) {
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
        match self.win.hwnd() {
            Ok(hw) => unsafe { let _ = SetWindowPos(windows::Win32::Foundation::HWND(hw.0 as *mut _), None, x, y, w.max(1), h.max(1), SWP_NOZORDER | SWP_NOACTIVATE); },
            Err(_) => { let _ = self.win.set_size(PhysicalSize::new(w.max(1) as u32, h.max(1) as u32)); let _ = self.win.set_position(PhysicalPosition::new(x, y)); }
        }
        let mut st = self.st.lock().unwrap();
        st.pos = (x, y); st.size = (w, h);
    }
    pub fn mode(&self) -> String { self.st.lock().unwrap().mode.clone() }
    pub fn set_mode(&self, mode: &str) -> String {
        let cur = self.mode();
        if cur == "stage" || cur == "hud" { return cur; } // в игре окном управляет игровой режим
        let m = if mode == "full" { "full" } else { "pill" };
        if cur != m { self.st.lock().unwrap().mode = m.into(); self.place(); crate::webview::low_memory(&self.win, m == "pill"); } // свёрнутый нотч — экономный режим памяти WebView2
        m.into()
    }
    pub fn replace(&self) { let m = self.mode(); if m == "pill" || m == "full" { self.place(); } }
    // ---------- игровой режим: «сцена» (путь перелёта) и «плашка» в углу; окно всегда прозрачно для мыши ----------
    pub fn stage(&self, mon: (i32, i32, i32, i32), b: (f64, f64, f64, f64), k: f64) {
        self.st.lock().unwrap().mode = "stage".into();
        let _ = self.win.set_ignore_cursor_events(true);
        self.st.lock().unwrap().clickable = false;
        // сцена — весь монитор игры; окно нотча и так стоит в его левом верхнем углу, поэтому оно только растёт вниз
        let _ = (b, k);
        let st = self.bounds();
        if st != (mon.0, mon.1, mon.2, mon.3) { self.set_bounds(mon.0, mon.1, mon.2, mon.3); }
    }
    pub fn hud(&self, mon: (i32, i32, i32, i32), r: (f64, f64, f64, f64), k: f64, hover: bool) {
        { let mut st = self.st.lock().unwrap(); st.mode = "hud".into(); st.hud_track = hover; st.clickable = false; }
        let _ = self.win.set_ignore_cursor_events(true);
        // окно не двигается, только укорачивается по высоте до низа плашки (верхние углы — тонкая полоса во всю ширину):
        // левый верхний угол окна на месте — WebView2 не показывает кадр со сдвигом
        let hr = ((r.0 * k).floor() as i32, (r.1 * k).floor() as i32, (r.2 * k).ceil() as i32 + 1, (r.3 * k).ceil() as i32 + 1);
        let bottom = (hr.1 + hr.3 + 2).min(mon.3);
        if self.bounds() != (mon.0, mon.1, mon.2, bottom) { self.set_bounds(mon.0, mon.1, mon.2, bottom); }
        let (cx, cy) = cursor();
        let mut st = self.st.lock().unwrap();
        st.hud_rect = (mon.0 + hr.0, mon.1 + hr.1, hr.2, hr.3);
        let h = st.hud_rect;
        st.hud_hover = cx >= h.0 && cy >= h.1 && cx < h.0 + h.2 && cy < h.1 + h.3;
    }
    pub fn to_full(&self) { self.st.lock().unwrap().mode = "full".into(); self.place(); let _ = self.win.set_ignore_cursor_events(true); self.st.lock().unwrap().clickable = false; crate::webview::low_memory(&self.win, false); }
    pub fn pill(&self) { self.st.lock().unwrap().mode = "pill".into(); self.place(); let _ = self.win.set_ignore_cursor_events(true); self.st.lock().unwrap().clickable = false; }

    pub fn set_interactive(&self, on: bool) { self.st.lock().unwrap().interactive = on; self.track(); }
    /// «l,t,r,b» — где на странице нотч (физические пиксели внутри окна)
    pub fn set_zone(&self, z: &str) {
        let v: Vec<i32> = z.split(',').map(|x| x.trim().parse().unwrap_or(0)).collect();
        if v.len() == 4 { self.st.lock().unwrap().zone = (v[0], v[1], v[2], v[3]); }
    }
    pub fn focus(&self) { if let Ok(h) = self.win.hwnd() { bar_agent::win::focus_opts(h.0 as isize as i64, false); } let _ = self.win.set_focus(); }
    pub fn bounds(&self) -> (i32, i32, i32, i32) { let st = self.st.lock().unwrap(); (st.pos.0, st.pos.1, st.size.0, st.size.1) }

    fn track(&self) {
        let (px, py) = cursor();
        let mut st = self.st.lock().unwrap();
        let (cx, cy) = (px - st.pos.0, py - st.pos.1);
        let inside_win = cx >= 0 && cy >= 0 && cx < st.size.0 && cy < st.size.1;
        if st.mode == "hud" {
            if !st.hud_track { return; }
            let h = st.hud_rect;
            let inside_win = px >= h.0 && py >= h.1 && px < h.0 + h.2 && py < h.1 + h.3;
            // курсор над плашкой в игре: события мыши игры её не достигают — сообщаем сами
            if inside_win != st.hud_hover { st.hud_hover = inside_win; drop(st); ctx::emit("hud-hover", inside_win); }
            return;
        }
        if st.mode != "pill" && st.mode != "full" { return; }
        let (l, t, r, b) = st.zone;
        // + полоска у верхнего края над нотчем (#hot): мышь у края экрана раскрывает его
        let over = inside_win && ((cx >= l && cx < r && cy >= t && cy < b) || (cy < 6 && cx >= l - 60 && cx < r + 60));
        // раскрытая панель ловит клики только в своей полосе по центру (как прежнее окно шириной 820), а не по всей ширине монитора
        let half = st.band / 2;
        let in_band = cx >= st.size.0 / 2 - half && cx < st.size.0 / 2 + half;
        // раскрытая панель ловит клики только над собой (+ поле 8 px): вокруг клики сразу уходят окнам под ней (игре и т.д.)
        let _ = in_band;
        let m = 8;
        let over_panel = inside_win && cx >= l - m && cx < r + m && cy >= t - m && cy < b + m;
        let want = over || (st.interactive && over_panel);
        if want != st.clickable {
            st.clickable = want;
            let _ = self.win.set_ignore_cursor_events(!want);
        }
    }
    // «за мышью»: курсор задержался на другом мониторе — нотч уезжает вверх и выезжает там
    fn follow_tick(&self) {
        if !ctx::ready() || ctx::sh_settings().get("notchOn").as_str() != Some("follow") { return; }
        if self.mode() != "pill" || crate::game::active() { return; }
        let p = cursor();
        let Ok(all) = self.win.available_monitors() else { return };
        let Some(m) = all.iter().find(|m| inside(m, p)) else { return };
        let cur = self.display();
        if cur.as_ref().map(|c| mon_id(c)) == Some(mon_id(m)) { self.st.lock().unwrap().cand = None; return; }
        let id = (m.position().x, m.position().y);
        let mut st = self.st.lock().unwrap();
        match st.cand {
            Some((c, at)) if c == id => {
                if at.elapsed() < Duration::from_millis(250) { return; }
                st.cand = None; drop(st);
                ctx::emit("notch-hop", "out");
                let w = self.clone();
                std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(230)); w.st.lock().unwrap().follow = Some(id); w.place(); ctx::emit("notch-hop", "in"); });
            }
            _ => st.cand = Some((id, Instant::now())),
        }
    }
    // автоскрытие: на мониторе нотча мышь не двигалась N секунд — нотч уезжает за край
    fn idle_tick(&self) {
        if !ctx::ready() { return; }
        let secs = ctx::sh_settings().get("idleHide").as_f64().unwrap_or(60.0);
        let p = cursor();
        let on_mine = self.display().map_or(false, |m| inside(&m, p)); // до блокировки: display() сам её берёт
        let mut st = self.st.lock().unwrap();
        // в игре отсчёт простоя стоит: после выхода нотч не должен сразу уезжать за край
        if crate::game::active() { st.idle_last = Some(Instant::now()); st.idle_pt = p; }
        if secs <= 0.0 || crate::game::active() { if st.idle_hidden { st.idle_hidden = false; drop(st); ctx::emit("idle", false); } return; }
        let moved = p != st.idle_pt;
        st.idle_pt = p;
        let last = *st.idle_last.get_or_insert_with(Instant::now);
        if on_mine && moved {
            st.idle_last = Some(Instant::now());
            if st.idle_hidden { st.idle_hidden = false; drop(st); ctx::emit("idle", false); }
        } else if !st.idle_hidden && last.elapsed().as_secs_f64() > secs {
            st.idle_hidden = true; drop(st); ctx::emit("idle", true);
        }
    }
    pub fn idle_wake(&self) { let mut st = self.st.lock().unwrap(); st.idle_last = Some(Instant::now()); if st.idle_hidden { st.idle_hidden = false; drop(st); ctx::emit("idle", false); } }
    pub fn reset_follow(&self) { self.st.lock().unwrap().follow = None; }
    // развёрнутое окно на мониторе нотча — нотч уезжает тонкой полоской, чтобы не закрывать вкладки
    pub fn tuck_check(&self) {
        let r = ctx::sh().fast.call_t("fgmax", "", 2000).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
        let on = if r.is_empty() { false } else {
            let v: Vec<i32> = r.split(',').map(|x| x.parse().unwrap_or(0)).collect();
            v.len() == 4 && self.display().map_or(false, |m| inside(&m, ((v[0] + v[2]) / 2, (v[1] + v[3]) / 2)))
        };
        let mut st = self.st.lock().unwrap();
        if st.tucked != Some(on) { st.tucked = Some(on); drop(st); ctx::emit("tuck", json!(on)); }
    }
}
