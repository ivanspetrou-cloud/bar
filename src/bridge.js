// Мост «ПК ⇄ телефон» по Wi‑Fi: телефон сканирует QR и открывает страницу в браузере.
// Работает только в локальной сети, доступ по случайному токену, сервер живёт пока включён.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function createBridge({ downloadsDir, onText, onFile }) {
  let server = null;
  let token = '';
  let url = '';
  let files = [];
  let pcText = '';

  function uniquePath(dir, name) {
    const safe = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'file';
    const ext = path.extname(safe), base = safe.slice(0, safe.length - ext.length);
    let p = path.join(dir, safe), i = 1;
    while (fs.existsSync(p)) p = path.join(dir, `${base} (${i++})${ext}`);
    return p;
  }

  // сервер сам выключается, если им 20 минут не пользовались
  let idleT = 0;
  const touch = () => { clearTimeout(idleT); idleT = setTimeout(() => api.stop(), 20 * 60e3); };
  const MAX_UPLOAD = 4 * 1024 ** 3; // 4 ГБ на файл
  const sameToken = (t) => {
    const a = Buffer.from(String(t || '')), b = Buffer.from(token);
    return token && a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  function handler(req, res) {
    // токен в адресе — не отдаём его другим сайтам и не даём встраивать страницу
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    let u;
    try { u = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
    if (!sameToken(u.searchParams.get('t'))) { res.writeHead(403); return res.end('forbidden'); }
    touch();

    if (req.method === 'GET' && u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(PAGE);
    }
    if (req.method === 'GET' && u.pathname === '/api/state') {
      const list = files.map((p, i) => {
        try { return { i, name: path.basename(p), size: fs.statSync(p).size }; } catch { return null; }
      }).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ files: list, text: pcText }));
    }
    const m = /^\/f\/(\d+)$/.exec(u.pathname);
    if (req.method === 'GET' && m) {
      const p = files[+m[1]];
      if (!p || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fs.statSync(p).size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`,
      });
      return fs.createReadStream(p).pipe(res);
    }
    if (req.method === 'POST' && u.pathname === '/up') {
      if (+req.headers['content-length'] > MAX_UPLOAD) { res.writeHead(413); return res.end(); }
      let name = 'file';
      try { name = decodeURIComponent(req.headers['x-name'] || 'file'); } catch {}
      const dest = uniquePath(downloadsDir(), name);
      const out = fs.createWriteStream(dest);
      let got = 0;
      req.on('data', (c) => { got += c.length; if (got > MAX_UPLOAD) { req.destroy(); out.destroy(); fs.rm(dest, () => {}); } });
      req.pipe(out);
      out.on('finish', () => { onFile({ name: path.basename(dest), path: dest }); res.writeHead(200); res.end('ok'); });
      out.on('error', () => { res.writeHead(500); res.end(); });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/text') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => { if (body.trim()) onText(body); res.writeHead(200); res.end('ok'); });
      return;
    }
    res.writeHead(404); res.end();
  }

  const api = {
    async start(ip) {
      if (server) return url;
      token = crypto.randomBytes(12).toString('base64url');
      server = http.createServer(handler);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, ip, resolve);
      });
      url = `http://${ip}:${server.address().port}/?t=${token}`;
      touch();
      return url;
    },
    stop() {
      clearTimeout(idleT);
      if (server) { server.close(); server.closeAllConnections?.(); }
      server = null; token = ''; url = '';
      return true;
    },
    setFiles(list) { files = list.slice(); },
    setText(t) { pcText = String(t || ''); },
  };
  return api;
};

const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bar · телефон</title>
<style>
:root{color-scheme:dark;--bg:#0b0b0e;--card:#17171c;--fg:#f3f3f6;--mut:#8d8d98;--acc:#8b7bff;--lime:#d7ff3e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px;max-width:560px;margin:auto}
h1{font-size:20px;margin:6px 0 16px;display:flex;align-items:center;gap:10px}h1 i{width:34px;height:14px;border-radius:8px;background:#000;border:1px solid #333;display:inline-block;position:relative}h1 i:after{content:"";position:absolute;right:4px;top:3px;width:6px;height:6px;border-radius:50%;background:var(--lime)}
section{background:var(--card);border-radius:18px;padding:14px;margin-bottom:12px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:0 0 10px}
textarea{width:100%;min-height:90px;border-radius:12px;border:1px solid #2a2a33;background:#0f0f13;color:var(--fg);padding:10px;font:inherit;resize:vertical}
button,.btn{appearance:none;border:0;border-radius:12px;padding:11px 14px;font:600 15px system-ui;background:#26262e;color:var(--fg);text-decoration:none;display:inline-block}
.pri{background:var(--acc);color:#fff}.row{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.f{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 0;border-top:1px solid #24242b}.f:first-child{border-top:0}
.f span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mut{color:var(--mut);font-size:13px}
pre{white-space:pre-wrap;word-break:break-word;margin:0;background:#0f0f13;border-radius:12px;padding:10px;min-height:20px}
#prog{height:6px;border-radius:3px;background:#26262e;overflow:hidden;margin-top:10px;display:none}#prog b{display:block;height:100%;width:0;background:var(--lime)}
</style></head><body>
<h1><i></i>Bar · связь с ПК</h1>
<section><h2>Отправить на ПК</h2>
<textarea id="t" placeholder="Текст или ссылка — попадёт в буфер обмена ПК"></textarea>
<div class="row"><button class="pri" id="sendT">Отправить текст</button>
<label class="btn">Отправить файлы<input id="file" type="file" multiple hidden></label></div>
<div id="prog"><b></b></div><div class="mut" id="msg"></div></section>
<section><h2>Текст с ПК</h2><pre id="pc"></pre><div class="row"><button id="copy">Скопировать</button></div></section>
<section><h2>Файлы с ПК</h2><div id="files" class="mut">Перетащите файлы на полку нотча на ПК</div></section>
<script>
const T=new URLSearchParams(location.search).get('t');const q=p=>p+(p.includes('?')?'&':'?')+'t='+encodeURIComponent(T);
const $=id=>document.getElementById(id);const msg=t=>{$('msg').textContent=t};
const fmt=n=>n<1024?n+' Б':n<1048576?(n/1024).toFixed(0)+' КБ':(n/1048576).toFixed(1)+' МБ';
$('sendT').onclick=async()=>{const v=$('t').value;if(!v.trim())return;await fetch(q('/text'),{method:'POST',body:v});$('t').value='';msg('Текст отправлен ✓');};
$('copy').onclick=()=>navigator.clipboard&&navigator.clipboard.writeText($('pc').textContent).then(()=>msg('Скопировано ✓'),()=>{});
$('file').onchange=async e=>{const fs=[...e.target.files];for(let k=0;k<fs.length;k++){await up(fs[k],k+1,fs.length);}msg('Готово: '+fs.length+' файл(ов) на ПК ✓');e.target.value='';};
function up(f,k,n){return new Promise(r=>{const x=new XMLHttpRequest();x.open('POST',q('/up'));x.setRequestHeader('x-name',encodeURIComponent(f.name));
$('prog').style.display='block';x.upload.onprogress=ev=>{$('prog').firstChild.style.width=(ev.loaded/ev.total*100)+'%';msg('Отправка '+k+'/'+n+': '+f.name);};
x.onloadend=()=>{$('prog').style.display='none';r();};x.send(f);});}
async function poll(){try{const s=await (await fetch(q('/api/state'))).json();$('pc').textContent=s.text||'—';
$('files').innerHTML=s.files.length?'':'Перетащите файлы на полку нотча на ПК';
for(const f of s.files){const d=document.createElement('div');d.className='f';const n=document.createElement('span');n.textContent=f.name+' · '+fmt(f.size);
const a=document.createElement('a');a.className='btn';a.textContent='Скачать';a.href=q('/f/'+f.i);d.append(n,a);$('files').append(d);}}catch(e){}}
poll();setInterval(poll,3000);
</script></body></html>`;
