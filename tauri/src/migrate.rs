// Перенос данных интерфейса из Electron-версии. Страница Bar хранила оформление, закреплённые программы, вкладки
// и прочее в localStorage — в Electron это база LevelDB в «Local Storage\leveldb». WebView2 хранит своё отдельно,
// поэтому при первом запуске Tauri-версии читаем ту базу здесь и передаём значения странице до её скриптов.
// Только чтение файлов на этом компьютере.
use std::collections::HashMap;
use std::path::Path;

fn varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let mut v = 0u64; let mut s = 0;
    loop { let c = *b.get(*i)?; *i += 1; v |= ((c & 0x7f) as u64) << s; if c & 0x80 == 0 { return Some(v); } s += 7; if s > 63 { return None; } }
}
fn snappy(b: &[u8]) -> Option<Vec<u8>> {
    let mut i = 0;
    let n = varint(b, &mut i)? as usize;
    let mut out: Vec<u8> = Vec::with_capacity(n);
    while i < b.len() {
        let tag = b[i]; i += 1;
        match tag & 3 {
            0 => {
                let mut len = (tag >> 2) as usize;
                if len >= 60 { let k = len - 59; let mut l = 0usize; for j in 0..k { l |= (*b.get(i + j)? as usize) << (8 * j); } i += k; len = l; }
                len += 1;
                out.extend_from_slice(b.get(i..i + len)?); i += len;
            }
            t => {
                let (len, off) = match t {
                    1 => { let l = ((tag >> 2) & 7) as usize + 4; let o = (((tag >> 5) as usize) << 8) | *b.get(i)? as usize; i += 1; (l, o) }
                    2 => { let l = (tag >> 2) as usize + 1; let o = u16::from_le_bytes([*b.get(i)?, *b.get(i + 1)?]) as usize; i += 2; (l, o) }
                    _ => { let l = (tag >> 2) as usize + 1; let o = u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?) as usize; i += 4; (l, o) }
                };
                if off == 0 || off > out.len() { return None; }
                let st = out.len() - off;
                for j in 0..len { let c = out[st + j]; out.push(c); }
            }
        }
    }
    Some(out)
}
// записи блока таблицы: общий префикс ключа, хвост ключа, значение
fn block_entries(b: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut out = Vec::new();
    if b.len() < 4 { return out; }
    let nr = u32::from_le_bytes(b[b.len() - 4..].try_into().unwrap()) as usize;
    let end = b.len().saturating_sub(4 + nr * 4);
    let (mut i, mut key) = (0usize, Vec::new());
    while i < end {
        let (Some(sh), Some(ns), Some(vl)) = (varint(b, &mut i), varint(b, &mut i), varint(b, &mut i)) else { break };
        let (sh, ns, vl) = (sh as usize, ns as usize, vl as usize);
        if i + ns + vl > b.len() || sh > key.len() { break; }
        key.truncate(sh); key.extend_from_slice(&b[i..i + ns]); i += ns;
        out.push((key.clone(), b[i..i + vl].to_vec())); i += vl;
    }
    out
}
fn read_block(f: &[u8], off: u64, size: u64) -> Option<Vec<u8>> {
    let (o, s) = (off as usize, size as usize);
    let raw = f.get(o..o + s)?;
    match f.get(o + s)? { 0 => Some(raw.to_vec()), 1 => snappy(raw), _ => None }
}
// таблица .ldb: внутренние ключи «ключ + 8 байт (номер записи << 8 | тип)»
fn table(f: &[u8], put: &mut dyn FnMut(&[u8], u64, Option<&[u8]>)) {
    if f.len() < 48 { return; }
    let foot = &f[f.len() - 48..];
    let mut i = 0;
    let (_mo, _ms) = (varint(foot, &mut i), varint(foot, &mut i));
    let (Some(io), Some(is)) = (varint(foot, &mut i), varint(foot, &mut i)) else { return };
    let Some(index) = read_block(f, io, is) else { return };
    for (_, h) in block_entries(&index) {
        let mut j = 0;
        let (Some(bo), Some(bs)) = (varint(&h, &mut j), varint(&h, &mut j)) else { continue };
        let Some(data) = read_block(f, bo, bs) else { continue };
        for (k, v) in block_entries(&data) {
            if k.len() < 8 { continue; }
            let tag = u64::from_le_bytes(k[k.len() - 8..].try_into().unwrap());
            put(&k[..k.len() - 8], tag >> 8, if tag & 0xff == 1 { Some(&v) } else { None });
        }
    }
}
// журнал .log: блоки по 32 КБ, записи с типами FULL/FIRST/MIDDLE/LAST, каждая запись — пакет изменений
fn log(f: &[u8], put: &mut dyn FnMut(&[u8], u64, Option<&[u8]>)) {
    let mut recs: Vec<Vec<u8>> = Vec::new();
    let mut cur: Vec<u8> = Vec::new();
    let mut i = 0;
    while i + 7 <= f.len() {
        let left = 32768 - (i % 32768);
        if left < 7 { i += left; continue; }
        let len = u16::from_le_bytes([f[i + 4], f[i + 5]]) as usize;
        let t = f[i + 6];
        let Some(d) = f.get(i + 7..i + 7 + len) else { break };
        match t { 1 => recs.push(d.to_vec()), 2 => { cur = d.to_vec(); } 3 => cur.extend_from_slice(d), 4 => { cur.extend_from_slice(d); recs.push(std::mem::take(&mut cur)); } _ => {} }
        i += 7 + len;
        if t == 0 && len == 0 { break; }
    }
    for r in recs {
        if r.len() < 12 { continue; }
        let seq = u64::from_le_bytes(r[..8].try_into().unwrap());
        let n = u32::from_le_bytes(r[8..12].try_into().unwrap());
        let mut j = 12;
        for k in 0..n as u64 {
            let Some(&t) = r.get(j) else { break }; j += 1;
            let Some(kl) = varint(&r, &mut j) else { break };
            let Some(key) = r.get(j..j + kl as usize).map(|x| x.to_vec()) else { break }; j += kl as usize;
            if t == 1 {
                let Some(vl) = varint(&r, &mut j) else { break };
                let Some(val) = r.get(j..j + vl as usize).map(|x| x.to_vec()) else { break }; j += vl as usize;
                put(&key, seq + k, Some(&val));
            } else { put(&key, seq + k, None); }
        }
    }
}
fn decode(v: &[u8]) -> Option<String> {
    match v.first()? {
        1 => Some(v[1..].iter().map(|&c| c as char).collect()),
        0 => { let u: Vec<u16> = v[1..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect(); Some(String::from_utf16_lossy(&u)) }
        _ => None,
    }
}
/// localStorage Electron-версии (origin file://): ключ → строка
pub fn electron_local_storage(data: &Path) -> HashMap<String, String> {
    let dir = data.join("Local Storage").join("leveldb");
    let mut best: HashMap<Vec<u8>, (u64, Option<Vec<u8>>)> = HashMap::new();
    let mut put = |k: &[u8], seq: u64, v: Option<&[u8]>| { let e = best.entry(k.to_vec()).or_insert((0, None)); if seq >= e.0 { *e = (seq, v.map(|x| x.to_vec())); } };
    let mut files: Vec<_> = std::fs::read_dir(&dir).map(|r| r.filter_map(|e| e.ok()).map(|e| e.path()).collect()).unwrap_or_default();
    files.sort();
    for p in files {
        let ext = p.extension().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
        let Ok(f) = std::fs::read(&p) else { continue };
        if ext == "ldb" { table(&f, &mut put); } else if ext == "log" { log(&f, &mut put); }
    }
    let prefix = b"_file://\x00";
    best.into_iter().filter_map(|(k, (_, v))| {
        let rest = k.strip_prefix(&prefix[..])?;
        let key = decode(rest)?;
        Some((key, decode(&v?)?))
    }).collect()
}

/// скрипт для страниц: один раз положить данные Electron-версии в localStorage WebView2 (до скриптов страницы)
pub fn init_script(data: &Path) -> String {
    let flag = data.join("ui-migrated");
    if flag.exists() { return String::new(); }
    let ls = electron_local_storage(data);
    let _ = std::fs::write(&flag, format!("{}", ls.len()));
    if ls.is_empty() { return String::new(); }
    let obj = serde_json::to_string(&ls).unwrap_or_else(|_| "{}".into());
    format!("try {{ if (!localStorage.getItem('bar.migrated')) {{ const d = {}; for (const k in d) if (localStorage.getItem(k) === null) localStorage.setItem(k, d[k]); localStorage.setItem('bar.migrated', '1'); }} }} catch (e) {{}}", obj)
}
