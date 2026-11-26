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

struct T { src: i64, thumb: isize, rect: RECT, gen: u64 }
static S: Mutex<Option<HashMap<String, Vec<T>>>> = Mutex::new(None);
static GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn props(thumb: isize, place: RECT, opacity: u8, visible: bool) {
    let p = DWM_THUMBNAIL_PROPERTIES {
        dwFlags: DWM_TNP_RECTDESTINATION | DWM_TNP_VISIBLE | DWM_TNP_OPACITY | DWM_TNP_SOURCECLIENTAREAONLY,
        rcDestination: place, opacity, fVisible: visible.into(), fSourceClientAreaOnly: false.into(), ..Default::default()
    };
    unsafe { let _ = DwmUpdateThumbnailProperties(thumb, &p); }
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

/// показать миниатюры: [{hwnd, l, t, r, b}] — прямоугольники в физических пикселях окна-страницы
pub fn show(label: &str, dest: HWND, items: &Value, fade: bool) {
    let want: Vec<(i64, RECT)> = items.as_array().map(|a| a.iter().filter_map(|x| {
        let g = |k: &str| x[k].as_f64().map(|v| v.round() as i32);
        Some((x["hwnd"].as_i64()?, RECT { left: g("l")?, top: g("t")?, right: g("r")?, bottom: g("b")? }))
    }).collect()).unwrap_or_default();
    let gen = GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let mut fresh = vec![];
    {
        let mut g = S.lock().unwrap();
        let all = g.get_or_insert_with(HashMap::new);
        let list = all.entry(label.to_string()).or_default();
        // лишние — убрать
        list.retain(|t| { let keep = want.iter().any(|(s, _)| *s == t.src); if !keep { unsafe { let _ = DwmUnregisterThumbnail(t.thumb); } } keep });
        for (src, r) in &want {
            if let Some(t) = list.iter_mut().find(|t| t.src == *src) {
                t.rect = *r; t.gen = gen;
                props(t.thumb, fit(t.thumb, *r), 255, true);
            } else if let Ok(th) = unsafe { DwmRegisterThumbnail(dest, HWND(*src as isize as *mut _)) } {
                props(th, fit(th, *r), if fade { 0 } else { 255 }, true);
                list.push(T { src: *src, thumb: th, rect: *r, gen });
                fresh.push(th);
            }
        }
    }
    // новые — плавно проявляются
    if fade && !fresh.is_empty() {
        let label = label.to_string();
        std::thread::spawn(move || for step in 1..=6u32 {
            std::thread::sleep(Duration::from_millis(22));
            let g = S.lock().unwrap();
            let Some(list) = g.as_ref().and_then(|a| a.get(&label)) else { return };
            for t in list.iter().filter(|t| fresh.contains(&t.thumb)) { props(t.thumb, fit(t.thumb, t.rect), (step * 255 / 6) as u8, true); }
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
                { let g = S.lock().unwrap(); if let Some(list) = g.as_ref().and_then(|a| a.get(&label)) { for t in list.iter().filter(|t| t.gen <= g0) { props(t.thumb, fit(t.thumb, t.rect), (step * 255 / 5) as u8, true); } } }
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
