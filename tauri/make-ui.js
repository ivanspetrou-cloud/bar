// Готовит страницы Bar для Tauri-версии в tauri/dist — из тех же файлов, что и Electron-версия (src/ui):
//  • копирует src/ui, иконки lucide, jsQR (сканер QR) и собирает библиотеку qrcode в один файл для страницы;
//  • в страницах разрешает связь с Rust (ipc:) и подключает bar-tauri.js до остальных скриптов;
//  • bar-tauri.js — тот же window.bar, что в src/preload.js (и window.ov из overlay-preload.js),
//    только вызовы уходят в Rust одной командой «ipc» по имени канала, а события приходят от Rust.
// Запуск: node tauri/make-ui.js (это делает tauri/build.sh перед сборкой).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const out = path.join(__dirname, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'src', 'ui'), out, { recursive: true });
fs.copyFileSync(nm('lucide', 'dist', 'umd', 'lucide.min.js'), path.join(out, 'lucide.min.js'));
fs.copyFileSync(nm('jsqr', 'dist', 'jsQR.js'), path.join(out, 'jsQR.js'));

// ---------- qrcode (CommonJS) → один файл: крошечный загрузчик модулей ----------
function bundle(entry, globalName) {
  const mods = new Map();
  const resolve = (from, req) => {
    let p;
    if (req.startsWith('.')) p = path.resolve(path.dirname(from), req);
    else {
      const pkg = nm(req.split('/')[0]);
      const pj = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
      p = path.join(pkg, req.includes('/') ? req.split('/').slice(1).join('/') : (typeof pj.browser === 'string' ? pj.browser : pj.main || 'index.js'));
    }
    for (const c of [p, p + '.js', path.join(p, 'index.js')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    throw new Error('не найден модуль ' + req + ' из ' + from);
  };
  const add = (file) => {
    if (mods.has(file)) return;
    let src = fs.readFileSync(file, 'utf8');
    const deps = {};
    mods.set(file, null);
    for (const m of src.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      if (['fs', 'pngjs'].includes(m[1])) continue; // только для Node: в странице не нужны
      const r = resolve(file, m[1]); deps[m[1]] = r; add(r);
    }
    mods.set(file, { src, deps });
  };
  add(entry);
  const ids = [...mods.keys()];
  const body = ids.map((f, i) => {
    const { src, deps } = mods.get(f);
    const map = Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, ids.indexOf(v)]));
    return `[function(module, exports, require){\n${src}\n}, ${JSON.stringify(map)}]`;
  }).join(',\n');
  return `(function(){var M=[${body}];var C={};function r(i){if(C[i])return C[i].exports;var m=C[i]={exports:{}};M[i][0](m,m.exports,function(n){var j=M[i][1][n];if(j===undefined)return {};return r(j);});return m.exports;}window.${globalName}=r(0);})();\n`;
}
fs.writeFileSync(path.join(out, 'qrcode.js'), bundle(nm('qrcode', 'lib', 'browser.js'), 'QRCodeLib'));

// ---------- window.bar из preload.js ----------
const pre = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
const api = [];
for (const m of pre.matchAll(/^\s{2}(\w+):\s*(?:\(([^)]*)\)\s*=>\s*)?(.*?),?\s*$/gm)) {
  const [, name, params = '', body] = m;
  let mm;
  if ((mm = body.match(/^on\('([\w-]+)'\)/))) api.push(`  ${name}: on('${mm[1]}'),`);
  else if ((mm = body.match(/ipcRenderer\.(send|invoke)\('([\w-]+)'(.*)\)$/))) {
    const args = mm[3].replace(/^,\s*/, '').trim();
    api.push(`  ${name}: (${params}) => ${mm[1] === 'invoke' ? 'call' : 'fire'}('${mm[2]}', [${args}]),`);
  }
}
const shim = `// Собрано tauri/make-ui.js из src/preload.js — не редактируйте вручную.
// window.bar для Tauri-версии: те же методы, что у Electron-версии; вызовы — в Rust (команда ipc), события — от Rust.
(() => {
  const T = () => window.__TAURI__;
  const call = (ch, args) => T().core.invoke('ipc', { ch, args: args.map((a) => (a === undefined ? null : a)) });
  const fire = (ch, args) => { call(ch, args).catch(() => {}); };
  const on = (ch) => (cb) => { T().event.listen(ch, (e) => cb(e.payload), { target: { kind: 'WebviewWindow', label: T().webviewWindow.getCurrentWebviewWindow().label } }).catch(() => T().event.listen(ch, (e) => cb(e.payload))); };
  const b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const qr = (text, width = 360) => window.QRCodeLib.toDataURL(String(text || ' '), { margin: 1, width, errorCorrectionLevel: 'M' });
  window.bar = {
${api.join('\n')}
  };
  // то, что в Electron делал главный процесс прямо в странице, — здесь же, в странице
  window.bar.qr = (text) => qr(text);
  window.bar.bridgeStart = async (files) => { const r = await call('bridge-start', [files]); return r && r.url ? { ...r, qr: await qr(r.url) } : r; };
  window.bar.saveVoice = (buf) => call('save-voice', [b64(buf)]);
  window.bar.filePath = (file) => (file && file.path) || '';
  window.bar.clipImage = (dataUrl) => fire('clip-image', [String(dataUrl || '')]);
  // окно захвата экрана (overlay.html)
  window.ov = {
    init: async () => {
      const info = await call('ov-init', []);
      if (!info) return null;
      const buf = await (await fetch('http://barcap.localhost/' + Date.now())).arrayBuffer();
      return { ...info, data: new Uint8Array(buf) };
    },
    done: (res) => fire('ov-done', [res]),
    cancel: () => fire('ov-done', [null]),
  };

  // Файлы, перетащенные из Проводника: у страницы WebView2 нет их путей — спрашиваем у Rust (WebView2 отдаёт пути
  // только приложению) и повторяем то же событие drop уже с путями. Перетаскивание внутри Bar работает как обычно.
  let dropSeq = 0;
  addEventListener('drop', (e) => {
    if (e.__bar || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files') || !e.dataTransfer.files.length) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const target = e.target, x = e.clientX, y = e.clientY, id = ++dropSeq;
    const files = [...e.dataTransfer.files];
    const un = T().event.listen('drop-paths', (ev) => {
      if (!ev.payload || ev.payload.id !== id) return;
      un.then((f) => f());
      const list = (ev.payload.paths || []).map((p, i) => ({ name: (files[i] && files[i].name) || p.split('\\\\').pop(), path: p, size: (files[i] && files[i].size) || 0, type: (files[i] && files[i].type) || '' }));
      const dt = { types: ['Files'], files: list, items: [], dropEffect: 'copy', effectAllowed: 'all', getData: () => '', setData: () => {} };
      const ne = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperties(ne, { dataTransfer: { value: dt }, clientX: { value: x }, clientY: { value: y }, __bar: { value: true } });
      target.dispatchEvent(ne);
    });
    window.chrome.webview.postMessageWithAdditionalObjects('bar-drop:' + id, files);
  }, true);

  // окно прозрачно для мыши, пока курсор не над Bar: Rust следит за курсором, страница сообщает, где сам нотч
  const zoneEl = () => document.getElementById('island');
  let last = '';
  const zone = () => {
    const el = zoneEl();
    if (el) {
      const r = el.getBoundingClientRect(), k = window.devicePixelRatio || 1;
      const z = [r.left, r.top, r.right, r.bottom].map((v) => Math.round(v * k)).join(',');
      if (z !== last) { last = z; fire('hit-zone', [z]); }
    }
    requestAnimationFrame(zone);
  };
  addEventListener('DOMContentLoaded', () => { if (zoneEl()) requestAnimationFrame(zone); });
  // док: где сейчас сам док и превью окон (CSS px) — каждый кадр, при любом числе значков и при увеличении
  let lastTb = '';
  const tbZone = () => {
    const sh = document.getElementById('tb-shell');
    if (!sh) return;
    const r = sh.getBoundingClientRect();
    const z = { l: r.left, t: r.top, r: r.right, b: r.bottom };
    // + сами значки: при наведении они увеличиваются и выходят вверх за подложку — иначе курсор на увеличенном значке
    // считался «вне дока», окно отпускало мышь, значки сжимались и снова росли (дёрганое наведение)
    for (const p of document.querySelectorAll('.tb-prev:not([hidden]), .tb-tip:not([hidden]), #tb-shell .tbi, #tb-bg')) { const q = p.getBoundingClientRect(); if (q.width) { z.l = Math.min(z.l, q.left); z.t = Math.min(z.t, q.top); z.r = Math.max(z.r, q.right); z.b = Math.max(z.b, q.bottom); } }
    const k = [z.l, z.t, z.r, z.b].map(Math.round).join(',');
    if (k !== lastTb) { lastTb = k; fire('tb-zone', [z]); }
    requestAnimationFrame(tbZone);
  };
  addEventListener('DOMContentLoaded', () => requestAnimationFrame(tbZone));
})();
`;
fs.writeFileSync(path.join(out, 'bar-tauri.js'), shim);

// ---------- страницы ----------
const CSP_CONNECT = "connect-src 'self' data: ipc: http://ipc.localhost http://barcap.localhost http://barimg.localhost";
for (const page of ['index.html', 'taskbar.html', 'overlay.html', 'alttab.html']) {
  let html = fs.readFileSync(path.join(out, page), 'utf8');
  html = html.replace(/connect-src [^;"]+/, CSP_CONNECT);
  if (!/connect-src/.test(html)) html = html.replace(/img-src ([^;"]+)/, `img-src $1; ${CSP_CONNECT}`);
  html = html.replace(/img-src ([^;"]+)/, 'img-src $1 http://barimg.localhost');
  html = html.replace('../../node_modules/lucide/dist/umd/lucide.min.js', 'lucide.min.js').replace('../../node_modules/jsqr/dist/jsQR.js', 'jsQR.js');
  html = html.replace(/(\s*)(<script src="[^"]+"><\/script>)/, '$1<script src="qrcode.js"></script>$1<script src="bar-tauri.js"></script>$1$2');
  fs.writeFileSync(path.join(out, page), html);
}
// картинки музыки: в Electron — своя схема barimg://, в WebView2 своя схема выглядит как http://barimg.localhost
for (const f of ['app.js', 'lab.js', 'taskbar.js']) {
  const p = path.join(out, f);
  if (fs.existsSync(p)) fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('barimg://img/', 'http://barimg.localhost/img/'));
}
console.log('tauri/dist готов:', api.length, 'методов window.bar');

// страница «телефон ⇄ ПК» (bridge.js) — та же, отдаёт её Rust (tauri/src/bridge.rs, include_str!)
{
  const src = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  const a = src.indexOf('const PAGE = `') + 'const PAGE = `'.length, b = src.lastIndexOf('`;');
  fs.writeFileSync(path.join(__dirname, 'bridge-page.html'), src.slice(a, b));
}
