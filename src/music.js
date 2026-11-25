// Режим музыки: YouTube Music в ВАШЕМ браузере + расширение «Bar — YouTube Music» (папка extension/).
//
// • Звук играет в вашей вкладке, вход в Google — ваш обычный, Bar его не касается.
// • Расширение работает только на music.youtube.com и выполняет только фиксированный список действий.
// • Связь — WebSocket только на 127.0.0.1; Bar принимает подключение только от расширения с нашим
//   идентификатором (заголовок Origin), сайты подключиться не могут.
const { ipcMain, protocol, net, shell, clipboard, app } = require('electron');
const { WebSocketServer } = require('ws');
const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const EXT_ID = require('./ext-id.json').id;
const crypto = require('crypto');
const buildExt = require('../scripts/build-ext.js');

const PORTS = [47823, 47824, 47825];
const IMG_HOSTS = /^(lh\d\.googleusercontent\.com|yt\d\.ggpht\.com|i\d?\.ytimg\.com|yt\d\.googleusercontent\.com|avatars\.yandex\.net|avatars\.mds\.yandex\.net|i\d\.sndcdn\.com|i\.scdn\.co|[a-z0-9-]+\.userapi\.com|[a-z0-9-]+\.vkuserphoto\.ru|is\d-ssl\.mzstatic\.com|e-cdns-images\.dzcdn\.net|cdn-images\.dzcdn\.net|resources\.tidal\.com|f\d\.bcbits\.com|cdn-image\.zvuk\.com|m\.media-amazon\.com|thumbnailer\.mixcloud\.com)$/;
// Расширение: в разработке — папка extension/ проекта; в установленном Bar — копия в папке данных пользователя
// (туда можно записать свой ключ пары; сам установщик ключа не содержит).
const EXT_TEMPLATE = app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(__dirname, '..', 'extension');
const EXT_DIR = app.isPackaged ? path.join(app.getPath('userData'), 'extension') : EXT_TEMPLATE;

// Схему картинок нужно зарегистрировать до готовности приложения
protocol.registerSchemesAsPrivileged([{ scheme: 'barimg', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

function findEdge() {
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe', '/ve'], { encoding: 'utf8', windowsHide: true });
    const m = out.match(/REG_SZ\s+(.+msedge\.exe)/i);
    if (m && fs.existsSync(m[1].trim())) return m[1].trim();
  } catch {}
  const p = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  return fs.existsSync(p) ? p : null;
}

// Где браузеры загрузили расширение Bar (распакованное, по его постоянному идентификатору) — Edge, Chrome, Brave и др.
// Читается только путь к папке нашего расширения из настроек браузера на этом компьютере.
function browserExtDirs() {
  const L = process.env.LOCALAPPDATA || '', A = process.env.APPDATA || '';
  const roots = [
    [L, 'Microsoft', 'Edge', 'User Data'], [L, 'Google', 'Chrome', 'User Data'], [L, 'BraveSoftware', 'Brave-Browser', 'User Data'],
    [L, 'Vivaldi', 'User Data'], [L, 'Yandex', 'YandexBrowser', 'User Data'], [A, 'Opera Software', 'Opera Stable'], [A, 'Opera Software', 'Opera GX Stable'],
  ].map((p) => path.join(...p));
  const found = new Set();
  for (const root of roots) {
    let profs = [];
    try { profs = fs.readdirSync(root).filter((n) => n === 'Default' || /^Profile \d+$/.test(n)).map((n) => path.join(root, n)); } catch { continue; }
    profs.push(root); // у Opera настройки лежат прямо в корне
    for (const prof of profs) for (const f of ['Secure Preferences', 'Preferences']) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(prof, f), 'utf8'));
        const e = j && j.extensions && j.extensions.settings && j.extensions.settings[EXT_ID];
        if (e && e.path && path.isAbsolute(e.path)) found.add(path.normalize(e.path));
      } catch {}
    }
  }
  return [...found];
}
// Ключ пары берём у той копии расширения, которую реально загрузил браузер: если её загрузили не из папки Bar
// (перенесли, распаковали заново, переустановили Bar с удалением данных) — иначе подписи не сойдутся и связи не будет.
function adoptBrowserKey(dir) {
  for (const d of browserExtDirs()) {
    if (path.normalize(d).toLowerCase() === path.normalize(dir).toLowerCase()) return null; // браузер смотрит в папку Bar — всё сходится
  }
  for (const d of browserExtDirs()) {
    try {
      const k = JSON.parse(fs.readFileSync(path.join(d, 'pair.json'), 'utf8')).key;
      if (k && k.length >= 40) { fs.writeFileSync(path.join(dir, 'pair.json'), JSON.stringify({ key: k })); return d; }
    } catch {}
  }
  return null;
}

module.exports = function setupMusic({ send }) {
  // секретный ключ пары Bar ↔ расширение (extension/pair.json); по сети не передаётся
  let pairKey = Buffer.from(buildExt(EXT_DIR, EXT_TEMPLATE).key, 'base64');
  try { if (adoptBrowserKey(EXT_DIR)) pairKey = Buffer.from(buildExt(EXT_DIR, EXT_TEMPLATE).key, 'base64'); } catch {}
  const sign = (text) => crypto.createHmac('sha256', pairKey).update(text).digest('base64');
  let sock = null;
  let ext = null;       // { version, tab }
  let last = null;      // состояние плеера
  let web = null;       // играющая вкладка музыкального сайта (Media Session): { tabId, host, title, … }
  let tab = false;
  let watching = false;
  let pollT = null;
  let seq = 0;
  const pending = new Map();
  let port = null;

  function push(extra) {
    send('music-state', Object.assign({ ext: !!sock, extVersion: ext && ext.version, tab, port }, last || {}, { web }, extra || {}));
  }

  // ---------- картинки: barimg://img/<url> → только серверы Google ----------
  protocol.handle('barimg', async (req) => {
    try {
      const real = decodeURIComponent(req.url.replace(/^barimg:\/\/img\/?/, ''));
      const u = new URL(real);
      if (u.protocol !== 'https:' || !IMG_HOSTS.test(u.hostname)) return new Response('', { status: 403 });
      const r = await net.fetch(u.toString());
      const body = await r.arrayBuffer();
      return new Response(body, { status: r.status, headers: { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=86400' } });
    } catch { return new Response('', { status: 502 }); }
  });

  // ---------- локальный сервер для расширения ----------
  const ORIGINS = new Set([`chrome-extension://${EXT_ID}`, `extension://${EXT_ID}`]);
  function listen(i = 0) {
    if (i >= PORTS.length) return;
    const wss = new WebSocketServer({
      host: '127.0.0.1', port: PORTS[i], path: '/bar-ext', maxPayload: 8 << 20,
      verifyClient: ({ origin }) => ORIGINS.has(origin),
    });
    wss.on('listening', () => { port = PORTS[i]; });
    wss.on('error', () => listen(i + 1)); // порт занят — следующий
    wss.on('connection', (ws) => {
      // Взаимная проверка: расширение присылает случайное число — подписываем его своим ключом
      // и ждём такую же подпись нашего числа. До этого соединение ничего не получает и не выполняет.
      let trusted = false;
      let myNonce = null;
      const authT = setTimeout(() => { if (!trusted) try { ws.close(); } catch {} }, 5000);
      ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(String(data)); } catch { return; }
        if (!trusted) {
          if (msg.hello && !myNonce) {
            myNonce = crypto.randomBytes(24).toString('base64');
            ws.send(JSON.stringify({ auth: sign('bar:' + msg.hello), nonce: myNonce }));
          } else if (msg.auth && myNonce) {
            const good = sign('ext:' + myNonce);
            const ok = msg.auth.length === good.length && crypto.timingSafeEqual(Buffer.from(msg.auth), Buffer.from(good));
            if (!ok) { try { ws.close(); } catch {} return; }
            trusted = true; clearTimeout(authT);
            if (sock) try { sock.close(); } catch {}
            sock = ws;
            call('hello').then((h) => {
              ext = h; tab = !!(h && h.tab); push();
              let want = null;
              try { want = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8')).version; } catch {}
              if (want && h && h.version && h.version !== want) { try { buildExt(EXT_DIR, EXT_TEMPLATE); } catch {} call('update').catch(() => {}); }
            }).catch(() => {});
            schedule();
          }
          return;
        }
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.t);
        if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result);
      });
      ws.on('close', () => { clearTimeout(authT); if (sock === ws) { sock = null; ext = null; tab = false; last = null; push(); } });
    });
  }
  listen();

  function call(fn, args = [], ms = 15000) {
    if (!sock || sock.readyState !== 1) return Promise.reject(new Error('extension'));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, ms);
      pending.set(id, { resolve, reject, t });
      sock.send(JSON.stringify({ id, fn, args }));
    });
  }
  const safe = (p, fb = null) => p.catch(() => fb);

  function schedule() {
    clearInterval(pollT);
    pollT = setInterval(async () => {
      if (!sock) return;
      try {
        const st = await call('state', [], 4000);
        tab = true; last = st;
      } catch (e) {
        if (/no-tab/.test(e.message)) { tab = false; last = null; }
      }
      // музыкальные сайты: играющая вкладка, иначе та, что играла последней
      try {
        const list = await call('webTabs', [], 4000);
        const pick = (list || []).find((t) => t.playing) || (web && (list || []).find((t) => t.tabId === web.tabId)) || (list || [])[0] || null;
        web = pick || null;
      } catch { web = null; }
      push();
    }, watching ? 600 : 3000);
  }

  // ---------- установка расширения: всё готово к одному действию в браузере ----------
  function install() {
    try { pairKey = Buffer.from(buildExt(EXT_DIR, EXT_TEMPLATE).key, 'base64'); } catch {}
    clipboard.writeText(EXT_DIR);
    shell.showItemInFolder(path.join(EXT_DIR, 'manifest.json'));
    // Страницу edge://extensions браузер не даёт открыть снаружи — пользователь вводит её сам
    return { path: EXT_DIR };
  }

  // Прежний вариант (отдельный Edge от Bar) больше не используется — закрыть его, если остался запущенным
  try {
    const dir = path.join(app.getPath('userData'), 'edge-music');
    const once = new (require('./agent-host'))('cleanup');
    once.call('killedge', Buffer.from(dir, 'utf8').toString('base64'), 15000).catch(() => {}).finally(() => once.stop());
  } catch {}

  // ---------- IPC ----------
  ipcMain.handle('music-status', () => ({ ext: !!sock, tab, port, state: last }));
  ipcMain.handle('music-install', () => install());
  ipcMain.handle('music-open', () => safe(call('openTab'), false));
  ipcMain.on('music-watch', (_e, on) => { watching = !!on; if (sock) schedule(); });
  ipcMain.handle('music-cmd', async (_e, cmd, arg) => {
    const ok = ['toggle', 'next', 'prev', 'seek', 'volume', 'like', 'dislike', 'shuffle', 'repeat', 'playQueue', 'play'];
    if (!ok.includes(cmd)) return false;
    const r = await safe(call(cmd, arg === undefined ? [] : [arg]), false);
    setTimeout(async () => { const st = await safe(call('state', [], 3000)); if (st) { last = st; tab = true; push(); } }, 300);
    return r;
  });
  // команды вкладке музыкального сайта (плеер через Media Session)
  ipcMain.handle('music-web', async (_e, cmd, arg, tabId) => {
    const fn = { toggle: 'wtoggle', next: 'wnext', prev: 'wprev', seek: 'wseek', volume: 'wvolume', open: 'webOpen' }[cmd];
    if (!fn || !Number.isInteger(+tabId)) return false;
    const r = await safe(call(fn, arg === undefined ? [+tabId] : [+tabId, arg]), false);
    setTimeout(async () => { const list = await safe(call('webTabs', [], 3000)); const t = (list || []).find((x) => x.tabId === +tabId); if (t) { web = t; push(); } }, 300);
    return r;
  });
  ipcMain.handle('music-queue', () => safe(call('queue'), []));
  ipcMain.handle('music-browse', (_e, browseId, params) => safe(call('browse', [browseId, params || ''])));
  ipcMain.handle('music-search', (_e, q) => safe(call('search', [String(q).slice(0, 200)])));
  ipcMain.handle('music-lyrics', (_e, id) => safe(call('lyrics', [id]), { text: '', source: '' }));

  return { stop: () => { clearInterval(pollT); if (sock) try { sock.close(); } catch {} }, install };
};
