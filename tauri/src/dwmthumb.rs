// Живые миниатюры окон — как у Alt+Tab и превью панели задач Windows (DwmRegisterThumbnail).
// Снимок через PrintWindow пустой у свёрнутых окон и у многих программ, рисующих видеокартой; миниатюру DWM
// Windows рисует сама — она есть всегда. Страница сообщает, где на ней место под превью (прямоугольник в пикселях
// окна), а Windows рисует туда копию окна (поверх страницы, с сохранением пропорций, по центру места).
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::*;

/// o — своя прозрачность миниатюры (боковые в карусели притенены), k — плавное проявление 0…255
/// cb — нижняя граница видимой части (стопка: ниже окно закрыто передним) — показываем только верх окна
struct T { src: i64, thumb: isize, rect: RECT, gen: u64, o: u8, k: u8, cb: Option<i32> }
fn alpha(t: &T) -> u8 { (t.o as u32 * t.k as u32 / 255) as u8 }
static S: Mutex<Option<HashMap<String, Vec<T>>>> = Mutex::new(None);
static GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn props(thumb: isize, place: RECT, opacity: u8, visible: bool) {
    let p = DWM_THUMBNAIL_PROPERTIES {
        dwFlags: DWM_TNP_RECTDESTINATION | DWM_TNP_VISIBLE | DWM_TNP_OPACITY | DWM_TNP_SOURCECLIENTAREAONLY,
        rcDestination: place, opacity, fVisible: visible.into(), fSourceClientAreaOnly: false.into(), ..Default::default()
    };
    unsafe { let _ = DwmUpdateThumbnailProperties(thumb, &p); }
}
// применить место, прозрачность и обрезку снизу
fn apply(t: &T) {
    let d = fit(t.thumb, t.rect);
    let a = alpha(t);
    match t.cb {
        Some(cb) if cb < d.bottom => {
            if cb <= d.top + 1 { props(t.thumb, d, a, false); return; }
            let Ok(sz) = (unsafe { DwmQueryThumbnailSourceSize(t.thumb) }) else { return };
            let frac = (cb - d.top) as f64 / (d.bottom - d.top).max(1) as f64;
            let p = DWM_THUMBNAIL_PROPERTIES {
                dwFlags: DWM_TNP_RECTDESTINATION | DWM_TNP_RECTSOURCE | DWM_TNP_VISIBLE | DWM_TNP_OPACITY | DWM_TNP_SOURCECLIENTAREAONLY,
                rcDestination: RECT { bottom: cb, ..d }, rcSource: RECT { left: 0, top: 0, right: sz.cx, bottom: ((sz.cy as f64) * frac).round() as i32 },
                opacity: a, fVisible: true.into(), fSourceClientAreaOnly: false.into(),
            };
            unsafe { let _ = DwmUpdateThumbnailProperties(t.thumb, &p); }
        }
        _ => {
            // без обрезки — источник целиком (сбросить прежнюю обрезку)
            let Ok(sz) = (unsafe { DwmQueryThumbnailSourceSize(t.thumb) }) else { props(t.thumb, d, a, true); return };
            let p = DWM_THUMBNAIL_PROPERTIES {
                dwFlags: DWM_TNP_RECTDESTINATION | DWM_TNP_RECTSOURCE | DWM_TNP_VISIBLE | DWM_TNP_OPACITY | DWM_TNP_SOURCECLIENTAREAONLY,
                rcDestination: d, rcSource: RECT { left: 0, top: 0, right: sz.cx, bottom: sz.cy }, opacity: a, fVisible: true.into(), fSourceClientAreaOnly: false.into(),
            };
            unsafe { let _ = DwmUpdateThumbnailProperties(t.thumb, &p); }
        }
    }
}
// окно целиком, с сохранением пропорций, по центру отведённого места
fn fit(thumb: isize, r: RECT) -> RECT {
    let Ok(sz) = (unsafe { DwmQueryThumbnailSourceSize(thumb) }) else { return r };
    let (bw, bh) = ((r.right - r.left) as f64, (r.bottom - r.top) as f64);
    if sz.cx <= 0 || sz.cy <= 0 || bw <= 0.0 || bh <= 0.0 { return r; }
    let k = (bw / sz.cx as f64).min(bh / sz.cy as f64);
    let (w, h) = ((sz.cx as f64 * k).round() as i32, (sz.cy as f64 * k).round() as i32);
    let (x, y) = (r.left + ((bw as i32 - w) / 2), r.top + ((bh as i32 - h) / 2));
    RECT { left: x, top: y, right: x + w, bottom: y + h }
}

/// показать миниатюры: [{hwnd, l, t, r, b, o?}] — прямоугольники в физических пикселях окна-страницы, o — прозрачность 0…1.
/// Можно звать каждый кадр (карусель): существующие только переезжают, новые проявляются
pub fn show(label: &str, dest: HWND, items: &Value, fade: bool) {
    let want: Vec<(i64, RECT, u8, Option<i32>)> = items.as_array().map(|a| a.iter().filter_map(|x| {
        let g = |k: &str| x[k].as_f64().map(|v| v.round() as i32);
        let o = (x["o"].as_f64().unwrap_or(1.0).clamp(0.0, 1.0) * 255.0).round() as u8;
        Some((x["hwnd"].as_i64()?, RECT { left: g("l")?, top: g("t")?, right: g("r")?, bottom: g("b")? }, o, g("cb")))
    }).collect()).unwrap_or_default();
    let gen = GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let mut fresh = vec![];
    {
        let mut g = S.lock().unwrap();
        let all = g.get_or_insert_with(HashMap::new);
        let list = all.entry(label.to_string()).or_default();
        // лишние — убрать
        list.retain(|t| { let keep = want.iter().any(|(s, _, _, _)| *s == t.src); if !keep { unsafe { let _ = DwmUnregisterThumbnail(t.thumb); } } keep });
        for (src, r, o, cb) in &want {
            if let Some(t) = list.iter_mut().find(|t| t.src == *src) {
                t.rect = *r; t.gen = gen; t.o = *o; t.cb = *cb;
                apply(t);
            } else if let Ok(th) = unsafe { DwmRegisterThumbnail(dest, HWND(*src as isize as *mut _)) } {
                let t = T { src: *src, thumb: th, rect: *r, gen, o: *o, k: if fade { 0 } else { 255 }, cb: *cb };
                apply(&t);
                list.push(t);
                if fade { fresh.push(th); }
            }
        }
    }
    // новые — плавно проявляются
    if fade && !fresh.is_empty() {
        let label = label.to_string();
        // быстро: 4 шага по 16 мс
        std::thread::spawn(move || for step in 1..=4u32 {
            std::thread::sleep(Duration::from_millis(16));
            let mut g = S.lock().unwrap();
            let Some(list) = g.as_mut().and_then(|a| a.get_mut(&label)) else { return };
            for t in list.iter_mut().filter(|t| fresh.contains(&t.thumb)) { t.k = (step * 255 / 4) as u8; apply(t); }
        });
    }
}

/// убрать миниатюры окна-страницы (fade — плавно, ~110 мс)
pub fn clear(label: &str, fade: bool) {
    let label = label.to_string();
    // только те, что показаны до этой команды: если переключатель уже открыли снова, новые миниатюры не трогаем
    let g0 = GEN.load(std::sync::atomic::Ordering::Relaxed);
    let run = move || {
        if fade {
            for step in (0..5u32).rev() {
                { let mut g = S.lock().unwrap(); if let Some(list) = g.as_mut().and_then(|a| a.get_mut(&label)) { for t in list.iter_mut().filter(|t| t.gen <= g0) { t.k = t.k.min((step * 255 / 5) as u8); apply(t); } } }
                std::thread::sleep(Duration::from_millis(22));
            }
        }
        let mut g = S.lock().unwrap();
        if let Some(list) = g.as_mut().and_then(|a| a.get_mut(&label)) {
            list.retain(|t| { let old = t.gen <= g0; if old { unsafe { let _ = DwmUnregisterThumbnail(t.thumb); } } !old });
        }
    };
    if fade { std::thread::spawn(run); } else { run(); }
}
