// Картинки: PNG иконок и JPEG превью окон через Windows Imaging Component (встроен в Windows, без сторонних библиотек).
use windows::core::{Interface, GUID, PCWSTR, PWSTR};
use windows::Win32::Foundation::{HGLOBAL, HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, GetObjectW, ReleaseDC, SelectObject, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
};
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::System::Com::StructuredStorage::{CreateStreamOnHGlobal, GetHGlobalFromStream, IPropertyBag2, PROPBAG2};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Variant::{VARIANT, VT_R4};
use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_ICONONLY};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, HICON, IsIconic};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::Foundation::SIZE;

type R<T> = windows::core::Result<T>;

fn factory() -> R<IWICImagingFactory> { unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) } }

// закодировать источник в PNG или JPEG (качество 0..1), при необходимости уменьшив до tw×th
fn encode(f: &IWICImagingFactory, src: &IWICBitmapSource, jpeg: Option<f32>, scale: Option<(u32, u32)>) -> R<Vec<u8>> {
    unsafe {
        let mut src: IWICBitmapSource = src.clone();
        if let Some((tw, th)) = scale {
            let sc = f.CreateBitmapScaler()?;
            sc.Initialize(&src, tw, th, WICBitmapInterpolationModeHighQualityCubic)?;
            src = sc.cast()?;
        }
        let want: GUID = if jpeg.is_some() { GUID_WICPixelFormat24bppBGR } else { GUID_WICPixelFormat32bppBGRA };
        let conv = f.CreateFormatConverter()?;
        conv.Initialize(&src, &want, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)?;
        let src: IWICBitmapSource = conv.cast()?;
        let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true)?;
        let enc = f.CreateEncoder(if jpeg.is_some() { &GUID_ContainerFormatJpeg } else { &GUID_ContainerFormatPng }, std::ptr::null())?;
        enc.Initialize(&stream, WICBitmapEncoderNoCache)?;
        let mut frame: Option<IWICBitmapFrameEncode> = None;
        let mut bag: Option<IPropertyBag2> = None;
        enc.CreateNewFrame(&mut frame, &mut bag)?;
        let frame = frame.ok_or_else(|| windows::core::Error::from_hresult(windows::core::HRESULT(-1)))?;
        if let (Some(q), Some(b)) = (jpeg, bag.as_ref()) {
            let mut name: Vec<u16> = "ImageQuality".encode_utf16().chain(Some(0)).collect();
            let pb = PROPBAG2 { pstrName: PWSTR(name.as_mut_ptr()), ..Default::default() };
            let mut v = VARIANT::default();
            (*v.Anonymous.Anonymous).vt = VT_R4;
            (*v.Anonymous.Anonymous).Anonymous.fltVal = q;
            let _ = b.Write(1, &pb, &v);
        }
        frame.Initialize(bag.as_ref())?;
        let (mut w, mut h) = (0u32, 0u32);
        src.GetSize(&mut w, &mut h)?;
        frame.SetSize(w, h)?;
        let mut fmt = want;
        frame.SetPixelFormat(&mut fmt)?;
        frame.WriteSource(&src, std::ptr::null())?;
        frame.Commit()?;
        enc.Commit()?;
        let hg = GetHGlobalFromStream(&stream)?;
        let n = GlobalSize(hg);
        let p = GlobalLock(hg) as *const u8;
        let out = if p.is_null() { Vec::new() } else { std::slice::from_raw_parts(p, n).to_vec() };
        let _ = GlobalUnlock(hg);
        // поток на HGLOBAL мог выделить больше — реальная длина = позиция записи
        let mut pos = 0u64;
        let _ = stream.Seek(0, windows::Win32::System::Com::STREAM_SEEK_CUR, Some(&mut pos));
        Ok(out[..(pos as usize).min(out.len())].to_vec())
    }
}

// BGRA (не предумноженная альфа), строки сверху вниз → PNG
pub fn png_bgra(w: u32, h: u32, px: &mut [u8]) -> R<Vec<u8>> {
    unsafe {
        let f = factory()?;
        let bmp = f.CreateBitmapFromMemory(w, h, &GUID_WICPixelFormat32bppBGRA, w * 4, px)?;
        encode(&f, &bmp.cast()?, None, None)
    }
}

// иконка окна (HICON) → PNG
pub fn png_hicon(hi: HICON) -> R<Vec<u8>> {
    unsafe {
        let f = factory()?;
        let bmp = f.CreateBitmapFromHICON(hi)?;
        encode(&f, &bmp.cast()?, None, None)
    }
}

// иконка приложения/файла так, как её показывает «Пуск» и Проводник: PNG size×size или None
pub fn shell_icon(path: &str, size: i32) -> Option<Vec<u8>> {
    let p = if path.contains(":\\") { path.to_string() } else { format!("shell:AppsFolder\\{}", path) };
    let w: Vec<u16> = p.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let f: IShellItemImageFactory = SHCreateItemFromParsingName(PCWSTR(w.as_ptr()), None).ok()?;
        let hbm: HBITMAP = f.GetImage(SIZE { cx: size, cy: size }, SIIGBF_ICONONLY).ok()?;
        let r = (|| {
            let mut bm = BITMAP::default();
            GetObjectW(HGDIOBJ(hbm.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _));
            if bm.bmBits.is_null() || bm.bmBitsPixel != 32 { return None; }
            let (w, h, stride) = (bm.bmWidth as usize, bm.bmHeight.unsigned_abs() as usize, bm.bmWidthBytes as usize);
            let src = std::slice::from_raw_parts(bm.bmBits as *const u8, stride * h);
            let mut out = vec![0u8; w * h * 4];
            // DIB снизу вверх (bmHeight > 0) — переворачиваем; альфа предумножена — снимаем предумножение
            for y in 0..h {
                let s = (if bm.bmHeight > 0 { h - 1 - y } else { y }) * stride;
                for x in 0..w {
                    let (mut b, mut g, mut r, a) = (src[s + x * 4] as u32, src[s + x * 4 + 1] as u32, src[s + x * 4 + 2] as u32, src[s + x * 4 + 3] as u32);
                    if a > 0 && a < 255 { b = (b * 255 / a).min(255); g = (g * 255 / a).min(255); r = (r * 255 / a).min(255); }
                    let d = (y * w + x) * 4;
                    out[d] = b as u8; out[d + 1] = g as u8; out[d + 2] = r as u8; out[d + 3] = a as u8;
                }
            }
            png_bgra(w as u32, h as u32, &mut out).ok()
        })();
        let _ = DeleteObject(HGDIOBJ(hbm.0));
        r
    }
}

// Снимок окна (PrintWindow с отрисовкой DWM) → JPEG качества 90, вписанный в maxW×maxH. Свёрнутые не снимаются.
// min — минимальный размер окна (для снимка в момент сворачивания: уже свёрнутое окно слишком маленькое)
pub fn thumb(h: HWND, max_w: i32, max_h: i32, min: (i32, i32)) -> Option<Vec<u8>> {
    unsafe {
        if IsIconic(h).as_bool() { return None; }
        let mut r = RECT::default();
        GetWindowRect(h, &mut r).ok()?;
        let (w, hh) = (r.right - r.left, r.bottom - r.top);
        if r.left <= -30000 || w < min.0.max(1) || hh < min.1.max(1) || w > 10000 || hh > 10000 { return None; }
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        let bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -hh, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() },
            ..Default::default()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let res = (|| {
            let dib = CreateDIBSection(Some(dc), &bi, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
            let old = SelectObject(dc, HGDIOBJ(dib.0));
            let ok = PrintWindow(h, dc, PRINT_WINDOW_FLAGS(2)).as_bool();
            SelectObject(dc, old);
            let out = if ok && !bits.is_null() {
                let px = std::slice::from_raw_parts_mut(bits as *mut u8, (w * hh * 4) as usize);
                let k = 1f64.min((max_w as f64 / w as f64).min(max_h as f64 / hh as f64));
                let (tw, th) = (((w as f64 * k) as u32).max(1), ((hh as f64 * k) as u32).max(1));
                (|| -> R<Vec<u8>> {
                    let f = factory()?;
                    let bmp = f.CreateBitmapFromMemory(w as u32, hh as u32, &GUID_WICPixelFormat32bppBGR, (w * 4) as u32, px)?;
                    encode(&f, &bmp.cast()?, Some(0.9), if tw != w as u32 || th != hh as u32 { Some((tw, th)) } else { None })
                })().ok()
            } else { None };
            let _ = DeleteObject(HGDIOBJ(dib.0));
            out
        })();
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
        res
    }
}

pub fn b64(d: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(d.len().div_ceil(3) * 4);
    for c in d.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}
pub fn unb64(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c { b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52, b'+' | b'-' => 62, b'/' | b'_' => 63, _ => continue } as u32;
        acc = (acc << 6) | v; bits += 6;
        if bits >= 8 { bits -= 8; out.push((acc >> bits) as u8); }
    }
    out
}
