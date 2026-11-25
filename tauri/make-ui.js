// Готовит страницы Bar для Tauri-версии в tauri/dist — из тех же файлов, что и Electron-версия (src/ui):
//  • копирует src/ui и иконки lucide;
//  • в index.html разрешает связь страницы с Rust (ipc:) и подключает bar-tauri.js до остальных скриптов;
//  • bar-tauri.js — тот же window.bar, что в src/preload.js, только вызовы уходят в Rust (одна команда «ipc» по имени канала).
// Запуск: node tauri/make-ui.js (делает и tauri/build.sh перед сборкой).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'src', 'ui'), out, { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules', 'lucide', 'dist', 'umd', 'lucide.min.js'), path.join(out, 'lucide.min.js'));

// window.bar: разбираем preload.js — имя метода → канал и вид вызова (send / invoke / on)
const pre = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
const api = [];
for (const m of pre.matchAll(/^\s{2}(\w+):\s*(?:\(([^)]*)\)\s*=>\s*)?(.*?),?\s*$/gm)) {
  const [, name, params = '', body] = m;
  let mm;
  if ((mm = body.match(/^on\('([\w-]+)'\)/))) api.push(`  ${name}: on('${mm[1]}'),`);
  else if ((mm = body.match(/ipcRenderer\.(send|invoke)\('([\w-]+)'(.*)\)$/))) {
    const args = mm[3].replace(/^,\s*/, '').trim();
    api.push(`  ${name}: (${params}) => ${mm[1] === 'invoke' ? 'call' : 'fire'}('${mm[2]}', [${args}]),`);
  } else if (name === 'filePath') api.push(`  filePath: (file) => (file && file.path) || '',`);
}
const shim = `// Собрано tauri/make-ui.js из src/preload.js — не редактируйте вручную.
// window.bar для Tauri-версии: те же методы, что у Electron-версии; вызовы — в Rust (команда ipc), события — от Rust.
(() => {
  const T = () => window.__TAURI__;
  const call = (ch, args) => T().core.invoke('ipc', { ch, args: args.map((a) => (a === undefined ? null : a)) });
  const fire = (ch, args) => { call(ch, args).catch(() => {}); };
  const on = (ch) => (cb) => { T().event.listen(ch, (e) => cb(e.payload)); };
  window.bar = {
${api.join('\n')}
  };
  // нотч прозрачен для мыши, пока курсор не над ним: Rust следит за курсором, а страница сообщает, где сам нотч
  let last = '';
  const zone = () => {
    const el = document.getElementById('island');
    if (el) {
      const r = el.getBoundingClientRect(), k = window.devicePixelRatio || 1;
      const z = [r.left, r.top, r.right, r.bottom].map((v) => Math.round(v * k)).join(',');
      if (z !== last) { last = z; fire('hit-zone', [z]); }
    }
    requestAnimationFrame(zone);
  };
  addEventListener('DOMContentLoaded', () => requestAnimationFrame(zone));
})();
`;
fs.writeFileSync(path.join(out, 'bar-tauri.js'), shim);

let html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
html = html.replace("connect-src 'self' data:", "connect-src 'self' data: ipc: http://ipc.localhost")
  .replace('../../node_modules/lucide/dist/umd/lucide.min.js', 'lucide.min.js')
  .replace('<script src="lucide.min.js"></script>', '<script src="bar-tauri.js"></script>\n  <script src="lucide.min.js"></script>');
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log('tauri/dist готов:', api.length, 'методов window.bar');
