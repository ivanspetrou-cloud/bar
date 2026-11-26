// Настройки WebView2 для окон Bar: без браузерного меню и горячих клавиш браузера (как в Electron-версии),
// разрешения страницы — только микрофон (диктофон) и уведомления; пути перетащенных из Проводника файлов
// (страница их не видит — WebView2 отдаёт их только приложению); экономия памяти, пока окно не нужно.
use serde_json::json;
use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::core::{Interface, PWSTR};

/// Параметры движка для всех окон Bar (должны совпадать у всех окон — иначе WebView2 не создаст окно).
/// Chromium сам решает, что окно «закрыто» другими окнами (например, игрой на весь экран на единственном мониторе),
/// и перестаёт его рисовать — анимации входа в игровой режим не отрисовывались, был виден только конец.
/// Отключаем эту слежку и «фоновую» экономию. Первые три — значения Tauri по умолчанию (один --disable-features).
pub const ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding";

pub fn attach(w: &WebviewWindow) {
    let label = w.label().to_string();
    let _ = w.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        if let Ok(s) = core.Settings() {
            let _ = s.SetAreDefaultContextMenusEnabled(false);
            let _ = s.SetIsStatusBarEnabled(false);
            let _ = s.SetIsZoomControlEnabled(false);
            if let Ok(s3) = s.cast::<ICoreWebView2Settings3>() { let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false); }
            if let Ok(s4) = s.cast::<ICoreWebView2Settings4>() { let _ = s4.SetIsGeneralAutofillEnabled(false); let _ = s4.SetIsPasswordAutosaveEnabled(false); }
            if let Ok(s5) = s.cast::<ICoreWebView2Settings5>() { let _ = s5.SetIsPinchZoomEnabled(false); }
            if let Ok(s6) = s.cast::<ICoreWebView2Settings6>() { let _ = s6.SetIsSwipeNavigationEnabled(false); }
        }
        let mut tok = 0i64;
        let _ = core.add_PermissionRequested(&webview2_com::PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(a) = args {
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                let _ = a.PermissionKind(&mut kind);
                let ok = kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE || kind == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS || kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ;
                let _ = a.SetState(if ok { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY });
            }
            Ok(())
        })), &mut tok);
        let lab = label.clone();
        let _ = core.add_WebMessageReceived(&webview2_com::WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(a) = args else { return Ok(()) };
            let mut s = PWSTR::null();
            if a.TryGetWebMessageAsString(&mut s).is_err() { return Ok(()) }
            let msg = s.to_string().unwrap_or_default();
            windows::Win32::System::Com::CoTaskMemFree(Some(s.0 as *const _));
            let Some(id) = msg.strip_prefix("bar-drop:") else { return Ok(()) };
            let mut paths = Vec::new();
            if let Ok(a2) = a.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() {
                if let Ok(objs) = a2.AdditionalObjects() {
                    let mut n = 0u32;
                    let _ = objs.Count(&mut n);
                    for i in 0..n {
                        let Ok(o) = objs.GetValueAtIndex(i) else { continue };
                        let Ok(f) = o.cast::<ICoreWebView2File>() else { continue };
                        let mut p = PWSTR::null();
                        if f.Path(&mut p).is_ok() { paths.push(p.to_string().unwrap_or_default()); windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _)); }
                    }
                }
            }
            crate::ctx::emit_to(&lab, "drop-paths", json!({ "id": id.parse::<u64>().unwrap_or(0), "paths": paths }));
            Ok(())
        })), &mut tok);
    });
}

/// меньше памяти, пока окно свёрнуто / не нужно (WebView2 сам отдаёт системе кэши страницы)
/// фокус клавиатуры — странице окна (после того как само окно вышло вперёд)
pub fn focus_page(w: &WebviewWindow) {
    let _ = w.with_webview(|pw| unsafe { let _ = pw.controller().MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC); });
}
pub fn low_memory(w: &WebviewWindow, low: bool) {
    let _ = w.with_webview(move |pw| unsafe {
        if let Ok(core) = pw.controller().CoreWebView2() {
            if let Ok(c) = core.cast::<ICoreWebView2_19>() {
                let _ = c.SetMemoryUsageTargetLevel(if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL });
            }
        }
    });
}
