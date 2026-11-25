// Криптография средствами Windows (CNG / BCrypt) — без сторонних библиотек:
// SHA-1 (рукопожатие WebSocket с расширением), SHA-256 (HMAC пары с расширением), SHA-512 (проверка установщика обновления),
// AES-256-GCM (расшифровка старой истории буфера Electron-версии), случайные байты.
use windows::core::PCWSTR;
use windows::Win32::Security::Cryptography::*;

fn hash_alg(alg: PCWSTR, key: Option<&[u8]>, parts: &[&[u8]]) -> Vec<u8> {
    unsafe {
        let mut h = BCRYPT_ALG_HANDLE::default();
        let flags = if key.is_some() { BCRYPT_ALG_HANDLE_HMAC_FLAG } else { BCRYPT_OPEN_ALGORITHM_PROVIDER_FLAGS(0) };
        if BCryptOpenAlgorithmProvider(&mut h, alg, PCWSTR::null(), flags).is_err() { return vec![]; }
        let mut len = [0u8; 4]; let mut got = 0u32;
        let _ = BCryptGetProperty(h.into(), BCRYPT_HASH_LENGTH, Some(&mut len), &mut got, 0);
        let n = u32::from_le_bytes(len) as usize;
        let mut hh = BCRYPT_HASH_HANDLE::default();
        let _ = BCryptCreateHash(h, &mut hh, None, key, 0);
        for p in parts { let _ = BCryptHashData(hh, p, 0); }
        let mut out = vec![0u8; n];
        let _ = BCryptFinishHash(hh, &mut out, 0);
        let _ = BCryptDestroyHash(hh);
        let _ = BCryptCloseAlgorithmProvider(h, 0);
        out
    }
}
pub fn sha1(d: &[u8]) -> Vec<u8> { hash_alg(BCRYPT_SHA1_ALGORITHM, None, &[d]) }
pub fn sha512(parts: &[&[u8]]) -> Vec<u8> { hash_alg(BCRYPT_SHA512_ALGORITHM, None, parts) }
pub fn hmac_sha256(key: &[u8], d: &[u8]) -> Vec<u8> { hash_alg(BCRYPT_SHA256_ALGORITHM, Some(key), &[d]) }
pub fn random(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n];
    unsafe { let _ = BCryptGenRandom(None, &mut v, BCRYPT_USE_SYSTEM_PREFERRED_RNG); }
    v
}
/// сравнение без утечки по времени
pub fn same(a: &[u8], b: &[u8]) -> bool { a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0 }

pub fn aes_gcm_decrypt(key: &[u8], nonce: &[u8], ct: &[u8], tag: &[u8]) -> Option<Vec<u8>> {
    unsafe {
        let mut h = BCRYPT_ALG_HANDLE::default();
        BCryptOpenAlgorithmProvider(&mut h, BCRYPT_AES_ALGORITHM, PCWSTR::null(), BCRYPT_OPEN_ALGORITHM_PROVIDER_FLAGS(0)).ok().ok()?;
        let mode: Vec<u16> = "ChainingModeGCM\0".encode_utf16().collect();
        let mb = std::slice::from_raw_parts(mode.as_ptr() as *const u8, mode.len() * 2);
        let _ = BCryptSetProperty(h.into(), BCRYPT_CHAINING_MODE, mb, 0);
        let mut kh = BCRYPT_KEY_HANDLE::default();
        if BCryptGenerateSymmetricKey(h, &mut kh, None, key, 0).is_err() { let _ = BCryptCloseAlgorithmProvider(h, 0); return None; }
        let mut info = BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO {
            cbSize: std::mem::size_of::<BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO>() as u32, dwInfoVersion: 1,
            pbNonce: nonce.as_ptr() as *mut u8, cbNonce: nonce.len() as u32, pbTag: tag.as_ptr() as *mut u8, cbTag: tag.len() as u32,
            ..Default::default()
        };
        let mut out = vec![0u8; ct.len()];
        let mut n = 0u32;
        let r = BCryptDecrypt(kh, Some(ct), Some(&mut info as *mut _ as *const _), None, Some(&mut out), &mut n, BCRYPT_FLAGS(0));
        let _ = BCryptDestroyKey(kh);
        let _ = BCryptCloseAlgorithmProvider(h, 0);
        if r.is_err() { return None; }
        out.truncate(n as usize);
        Some(out)
    }
}
