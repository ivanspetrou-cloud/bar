// Bar — нотч для Windows. Главный процесс.
const {
  app, BrowserWindow, screen, ipcMain, desktopCapturer, clipboard,
  globalShortcut, Tray, Menu, nativeImage, shell, session, ClipboardItem, safeStorage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const QRCode = require('qrcode');
const { pathToFileURL } = require('url');

// ---------- безопасность: IPC принимаем только от собственных страниц Bar ----------
// Даже если в окно каким-то образом попадёт чужая страница, она не сможет вызвать ни одну функцию Bar.
const UI_URL = pathToFileURL(path.join(__dirname, 'ui') + path.sep).href;
const trustedSender = (e) => { const u = (e && e.senderFrame && e.senderFrame.url) || ''; return u.startsWith(UI_URL); };
for (const m of ['on', 'handle']) {
  const orig = ipcMain[m].bind(ipcMain);
  ipcMain[m] = (ch, fn) => orig(ch, (e, ...args) => (trustedSender(e) ? fn(e, ...args) : (m === 'handle' ? null : undefined)));
}
// окна Bar никуда не переходят и ничего не открывают; ссылки — только во внешнем браузере через open-url
app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => { if (!url.startsWith(UI_URL)) e.preventDefault(); });
  wc.on('will-attach-webview', (e) => e.preventDefault());
});
const createBridge = require('./bridge');
const setupSensors = require('./sensors');
const setupUpdater = require('./updater');
const setupTaskbar = require('./taskbar');
const winwatch = require('./winwatch');
const setupGame = require('./game');
const setupMusic = require('./music'); // регистрирует схему barimg:// — до готовности приложения

if (process.env.BAR_NOGPU) app.disableHardwareAcceleration(); // только для замеров
const WIN_W = 820;   // окно чуть больше раскрытой панели — место под тень
const WIN_H = 700;

let win = null;
let overlay = null;
let tray = null;
let capture = null; // { mode, width, height, data }
let sensors = null;
let music = null;
let game = null;
let taskbar = null;

if (process.env.BAR_SNAP) app.setPath('userData', path.join(process.env.BAR_SNAP, 'profile'));
// журнал запуска: время, кто запустил, причина выхода — чтобы понять, почему не сработал автозапуск
const startLog = (msg) => {
  try {
    const f = path.join(app.getPath('userData'), 'startup.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 64 * 1024) fs.writeFileSync(f, ''); // не разрастается
    fs.appendFileSync(f, new Date().toISOString() + ' ' + msg + '\n');
  } catch {}
};
startLog(`start pid=${process.pid} cwd=${process.cwd()} argv=${JSON.stringify(process.argv.slice(1))}`);
process.on('uncaughtException', (e) => startLog('uncaught ' + (e && e.stack || e)));
app.on('will-quit', () => startLog('quit'));
if (!app.requestSingleInstanceLock()) { startLog('second instance — exit'); app.quit(); }
app.setAppUserModelId('app.bar.notch');

// ---------- настройки ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { clipHistory: true, ocrLang: '', hidden: false, idleHide: 60 };
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch {}
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {}
}

const dataDir = (...p) => {
  const dir = path.join(app.getPath('documents'), 'Bar', ...p);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const send = (ch, payload) => win && !win.isDestroyed() && win.webContents.send(ch, payload);

// ---------- окно нотча ----------
// Свёрнутый нотч живёт в маленьком окне: каждый кадр (столбики «играет», часы) перекладывает
// и смешивает с рабочим столом всё прозрачное окно, так что 700×44 вместо 820×700 — в разы дешевле.
// Перед раскрытием окно мгновенно возвращает полный размер.
// ширина та же, что у раскрытого окна: меняется только высота, левый край не двигается — без рывка при раскрытии
const PILL_W = WIN_W, PILL_H = 44;
let winMode = 'pill';
// Монитор нотча: settings.notchOn — 'primary' (основной), id монитора или 'follow' — «за мышью»:
// нотч переезжает на тот монитор, где сейчас курсор (одно состояние — таймер, музыка, запись — на всех экранах).
let followId = null;
function notchDisplay() {
  const all = screen.getAllDisplays();
  const v = settings.notchOn || 'primary';
  if (v === 'follow' && followId != null) { const d = all.find((x) => x.id === followId); if (d) return d; }
  if (v !== 'primary' && v !== 'follow') { const d = all.find((x) => String(x.id) === String(v)); if (d) return d; }
  return screen.getPrimaryDisplay();
}
let followT = 0, followCand = null, followSince = 0;
function startFollow() {
  clearInterval(followT); followT = 0;
  if (settings.notchOn !== 'follow') { followId = null; return; }
  followT = setInterval(() => {
    if (!win || winMode !== 'pill' || (game && game.isActive())) return; // открытую панель и игру не трогаем
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const cur = notchDisplay();
    if (d.id === cur.id) { followCand = null; return; }
    if (followCand !== d.id) { followCand = d.id; followSince = Date.now(); return; }
    if (Date.now() - followSince < 250) return; // курсор задержался на другом мониторе — переезжаем
    followCand = null;
    send('notch-hop', 'out');                    // уехать вверх на старом мониторе…
    setTimeout(() => { followId = d.id; placeWindow(); send('notch-hop', 'in'); }, 230); // …и выехать на новом
  }, 200);
}

function placeWindow() {
  const d = notchDisplay();
  const w = winMode === 'full' ? WIN_W : PILL_W, h = winMode === 'full' ? WIN_H : PILL_H;
  win.setBounds({ x: Math.round(d.bounds.x + (d.bounds.width - w) / 2), y: d.bounds.y, width: w, height: h });
}
ipcMain.handle('win-size', (_e, mode) => {
  if (winMode === 'stage' || winMode === 'hud') return winMode; // в игровом режиме окном управляет game.js
  mode = mode === 'full' ? 'full' : 'pill';
  if (win && mode !== winMode) { winMode = mode; placeWindow(); }
  return winMode;
});
// Окно в игровом режиме: «сцена» — весь монитор игры на время анимации перелёта, «плашка» — ровно размер плашки в углу.
// В обоих случаях окно полностью прозрачно для мыши: в игре оно ничего не перехватывает.
const gameWin = {
  // «сцена» — только прямоугольник пути перелёта (box, относительно монитора), а не весь монитор:
  // Windows смешивает с игрой в каждом кадре в десятки раз меньшую площадь
  stage(mon, box) { if (!win) return; winMode = 'stage'; win.setIgnoreMouseEvents(true);
    const b = box && box.w > 0 ? box : { x: 0, y: 0, w: mon.width, h: mon.height };
    win.setBounds({ x: Math.round(mon.x + b.x), y: Math.round(mon.y + b.y), width: Math.ceil(b.w), height: Math.ceil(b.h) }); },
  hud(mon, r, hover) { if (!win) return; winMode = 'hud'; win.setIgnoreMouseEvents(true, hover ? { forward: true } : undefined); win.setBounds({ x: Math.round(mon.x + r.x), y: Math.round(mon.y + r.y), width: Math.ceil(r.w), height: Math.ceil(r.h) }); },
  pill() { if (!win) return; winMode = 'pill'; placeWindow(); win.setIgnoreMouseEvents(true, { forward: true }); },
};

function createWindow() {
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H,
    frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  placeWindow();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => { if (!settings.hidden) win.showInactive(); });
  screen.on('display-metrics-changed', placeWindow);
  screen.on('display-added', placeWindow);
  screen.on('display-removed', placeWindow);
}

ipcMain.on('interactive', (_e, on) => {
  if (!win || winMode === 'stage' || winMode === 'hud') return;
  if (on) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
});
ipcMain.on('focus', () => win && win.focus());
// На время анимаций игрового режима — повышенный приоритет процессов отрисовки Bar (видеокарта и страница),
// чтобы игра не отнимала у них кадры; после — обычный.
ipcMain.on('anim-boost', (e, on) => {
  const pr = on ? os.constants.priority.PRIORITY_ABOVE_NORMAL : os.constants.priority.PRIORITY_NORMAL;
  const pids = app.getAppMetrics().filter((m) => m.type === 'GPU').map((m) => m.pid);
  try { pids.push(e.sender.getOSProcessId()); } catch {}
  for (const pid of pids) { try { os.setPriority(pid, pr); } catch {} }
});
// только для самопроверки: список окон
if (process.env.BAR_SNAP) ipcMain.handle('debug-windows', () => BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), visible: w.isVisible(), focused: w.isFocused(), bounds: w.getBounds(), url: w.webContents.getURL().slice(0, 90) })));

// ---------- захват экрана: OCR / пипетка / QR / скриншот ----------
async function startCapture(mode) {
  if (overlay || !win) return;
  send('collapse');
  await new Promise(r => setTimeout(r, 160));
  win.setOpacity(0); // не попадать на собственный скриншот
  try {
    const pt = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(pt);
    const size = {
      width: Math.round(d.size.width * d.scaleFactor),
      height: Math.round(d.size.height * d.scaleFactor),
    };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const src = sources.find(s => String(s.display_id) === String(d.id)) || sources[0];
    if (!src) throw new Error('Нет доступа к экрану');
    const img = src.thumbnail;
    const sz = img.getSize();
    capture = { mode, width: sz.width, height: sz.height, data: img.toBitmap() };

    overlay = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      frame: false, resizable: false, movable: false, skipTaskbar: true,
      alwaysOnTop: true, fullscreenable: false, show: false, backgroundColor: '#000000',
      webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setBounds(d.bounds);
    overlay.loadFile(path.join(__dirname, 'ui', 'overlay.html'));
    overlay.once('ready-to-show', () => { overlay.show(); overlay.focus(); });
    overlay.on('closed', () => { overlay = null; capture = null; win && win.setOpacity(1); });
  } catch (err) {
    win.setOpacity(1);
    send('tool-result', { type: 'error', text: String(err.message || err) });
  }
}

ipcMain.handle('capture', (_e, mode) => startCapture(mode));
ipcMain.handle('ov-init', () => capture);
ipcMain.on('ov-done', async (_e, res) => {
  if (overlay) overlay.close();
  if (!res) return;
  try {
    if (res.mode === 'color') {
      clipboard.writeText(res.hex);
      send('tool-result', { type: 'color', ...res });
    } else if (res.mode === 'qrscan') {
      if (res.text) clipboard.writeText(res.text);
      send('tool-result', { type: 'qrscan', text: res.text || null });
    } else if (res.mode === 'shot') {
      const img = nativeImage.createFromDataURL(res.png);
      await writeClipImage(img.toPNG());
      const file = path.join(dataDir('Screenshots'), `screenshot-${stamp()}.png`);
      fs.writeFileSync(file, img.toPNG());
      const thumb = img.resize({ width: Math.min(640, img.getSize().width) }).toDataURL();
      send('tool-result', { type: 'shot', path: file, thumb });
    } else if (res.mode === 'ocr') {
      send('busy', 'ocr');
      const text = await runOcr(res.png);
      if (text) clipboard.writeText(text);
      send('busy', null);
      send('tool-result', { type: 'ocr', text });
    }
  } catch (err) {
    send('busy', null);
    send('tool-result', { type: 'error', text: String(err.message || err) });
  }
});

// Встроенный OCR Windows (Windows.Media.Ocr) через PowerShell — без интернета и без моделей.
const OCR_PS = `
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime]
$null=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$m=([System.WindowsRuntimeSystemExtensions].GetMethods()|?{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'})[0]
function Aw($t,$r){$n=$m.MakeGenericMethod($r).Invoke($null,@($t));$n.Wait(-1)|Out-Null;$n.Result}
if($env:BAR_LIST){[Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages|%{$_.LanguageTag+'|'+$_.DisplayName};exit}
$f=Aw ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:BAR_IMG)) ([Windows.Storage.StorageFile])
$s=Aw ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$d=Aw ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])
$b=Aw ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
if($env:BAR_LANG){$e=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $env:BAR_LANG))}
if(-not $e){$e=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()}
$r=Aw ($e.RecognizeAsync($b)) ([Windows.Media.Ocr.OcrResult])
$r.Lines|%{$_.Text}
`;
const OCR_B64 = Buffer.from(OCR_PS, 'utf16le').toString('base64');

function runPs(env) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', OCR_B64],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 30000, encoding: 'utf8', maxBuffer: 8 << 20 },
      (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout));
  });
}

async function runOcr(pngDataUrl) {
  const file = path.join(os.tmpdir(), `bar-ocr-${process.pid}.png`);
  fs.writeFileSync(file, Buffer.from(pngDataUrl.split(',')[1], 'base64'));
  try {
    const out = await runPs({ BAR_IMG: file, BAR_LANG: settings.ocrLang || '' });
    return out.replace(/\r/g, '').trim();
  } finally { fs.rm(file, () => {}); }
}

ipcMain.handle('ocr-langs', async () => {
  try {
    const out = await runPs({ BAR_LIST: '1' });
    return out.replace(/\r/g, '').split('\n').filter(Boolean).map(l => {
      const [tag, name] = l.split('|'); return { tag, name };
    });
  } catch { return []; }
});

// ---------- медиа-клавиши (постоянный PowerShell, чтобы не ждать запуска) ----------
let ps = null;
function mediaKey(code) {
  if (!ps || ps.exitCode !== null) {
    ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true });
    ps.on('error', () => { ps = null; });
    ps.stdin.write('$w=New-Object -ComObject WScript.Shell\n');
  }
  ps.stdin.write(`$w.SendKeys([char]${code})\n`);
}
const MEDIA = { play: 179, next: 176, prev: 177, volup: 175, voldown: 174, mute: 173 };
ipcMain.on('media', (_e, k) => MEDIA[k] && mediaKey(MEDIA[k]));

// ---------- система ----------
let lastCpu = os.cpus();
function cpuPercent() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i] ? lastCpu[i].times : { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    const t = c.times;
    idle += t.idle - p.idle;
    total += (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.idle - p.idle) + (t.irq - p.irq);
  });
  lastCpu = now;
  return total > 0 ? Math.round(100 * (1 - idle / total)) : 0;
}
function lanIp() {
  const all = Object.values(os.networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal);
  const pref = all.find(a => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a.address));
  return (pref || all[0] || {}).address || '127.0.0.1';
}
function getStats() {
  return {
  cpu: cpuPercent(),
  memUsed: os.totalmem() - os.freemem(),
  memTotal: os.totalmem(),
  uptime: os.uptime(),
  host: os.hostname(),
  ip: lanIp(),
  cpuName: (os.cpus()[0] || {}).model || '',
  cores: os.cpus().length,
  };
}
ipcMain.handle('stats', () => getStats());

// ---------- буфер обмена ----------
// История хранится здесь, в файле, и пишется сразу — переживает любой перезапуск.
let lastClip = '';
let clips = []; // [{ t, pin, at }]
// История шифруется средствами Windows (DPAPI): прочитать файл может только ваша учётная запись.
const clipsFile = () => path.join(app.getPath('userData'), 'clips.bin');
const legacyClipsFile = () => path.join(app.getPath('userData'), 'clips.json');
async function loadClips() {
  try {
    if (fs.existsSync(clipsFile())) {
      const { result } = await safeStorage.decryptStringAsync(fs.readFileSync(clipsFile()));
      clips = JSON.parse(result);
    } else if (fs.existsSync(legacyClipsFile())) {
      // перенос старой открытой истории в зашифрованную и удаление открытого файла
      clips = JSON.parse(fs.readFileSync(legacyClipsFile(), 'utf8'));
      await saveClipsNow();
      fs.rmSync(legacyClipsFile(), { force: true });
    }
  } catch { clips = []; }
}
let saveT = null;
async function saveClipsNow() {
  try {
    const buf = await safeStorage.encryptStringAsync(JSON.stringify(clips));
    fs.writeFileSync(clipsFile(), buf);
  } catch {}
}
function saveClips() { clearTimeout(saveT); saveT = setTimeout(saveClipsNow, 150); }
async function writeClipImage(png) {
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
}
// Менеджеры паролей (KeePass, Bitwarden, 1Password) помечают секреты служебными форматами Windows —
// встроенная история Win+V их не сохраняет, и Bar тоже.
const RAW = (f) => `electron application/osclipboard;format="${f}"`;
async function isSecretClip() {
  try {
    if (await clipboard.has(RAW('ExcludeClipboardContentFromMonitorProcessing'))) return true;
    if (await clipboard.has(RAW('Clipboard Viewer Ignore'))) return true;
    for (const f of ['CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard']) {
      if (!(await clipboard.has(RAW(f)))) continue;
      const items = await clipboard.read();
      for (const it of items) {
        if (!it.types.includes(RAW(f))) continue;
        const b = new Uint8Array(await (await it.getType(RAW(f))).arrayBuffer());
        if (f === 'CanIncludeInClipboardHistory' && b.length >= 4 && (b[0] | b[1] | b[2] | b[3]) === 0) return true;
      }
    }
  } catch {}
  return false;
}
function pushClip(t, { silent } = {}) {
  if (typeof t !== 'string' || !t.trim()) return;
  const old = clips.find((c) => c.t === t);
  clips = [{ t: t.slice(0, 20000), pin: old ? old.pin : false, at: Date.now() }, ...clips.filter((c) => c.t !== t)];
  const pins = clips.filter((c) => c.pin);
  const rest = clips.filter((c) => !c.pin).slice(0, 60);
  clips = clips.filter((c) => c.pin ? pins.includes(c) : rest.includes(c));
  saveClips();
  if (!silent) send('clips', clips);
}
// В Electron 45 clipboard.readText() асинхронный — без await приходит Promise, а не текст.
const readClip = async () => { try { const t = await clipboard.readText(); return typeof t === 'string' ? t : ''; } catch { return ''; } };
let clipBusy = false;
async function pollClipboard() {
  if (!settings.clipHistory || clipBusy) return;
  clipBusy = true;
  try {
    const t = await readClip();
    if (t && t !== lastClip) {
      lastClip = t;
      if (await isSecretClip()) return; // пароль из менеджера паролей — не сохраняем
      pushClip(t);
    }
  } finally { clipBusy = false; }
}
ipcMain.handle('clips-get', () => clips);
ipcMain.on('clips-set', (_e, list) => { if (Array.isArray(list)) { clips = list.slice(0, 200); saveClips(); } });
ipcMain.handle('clip-read', () => readClip());
ipcMain.on('clip-write', (_e, t) => { lastClip = String(t); clipboard.writeText(String(t)); pushClip(String(t)); });
ipcMain.on('clip-image', (_e, dataUrl) => writeClipImage(nativeImage.createFromDataURL(dataUrl).toPNG()));

// ---------- QR ----------
ipcMain.handle('qr', (_e, text) =>
  QRCode.toDataURL(String(text || ' '), { margin: 1, width: 360, errorCorrectionLevel: 'M' }));

// ---------- файлы: диктофон, полка, открытие ----------
ipcMain.handle('save-voice', (_e, buf) => {
  const file = path.join(dataDir('Voice'), `memo-${stamp()}.webm`);
  fs.writeFileSync(file, Buffer.from(buf));
  return file;
});
ipcMain.handle('list-voice', () => {
  const dir = dataDir('Voice');
  return fs.readdirSync(dir).filter(f => f.endsWith('.webm'))
    .map(f => { const p = path.join(dir, f); return { name: f, path: p, mtime: fs.statSync(p).mtimeMs }; })
    .sort((a, b) => b.mtime - a.mtime).slice(0, 30);
});
ipcMain.handle('trash', (_e, p) => shell.trashItem(p).then(() => true, () => false));
ipcMain.on('open-path', (_e, p) => shell.openPath(p));
ipcMain.on('show-in-folder', (_e, p) => shell.showItemInFolder(p));
ipcMain.on('open-dir', (_e, name) => shell.openPath(dataDir(name)));
ipcMain.on('open-url', (_e, url) => { try { const u = new URL(String(url)); if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.href); } catch {} });
ipcMain.handle('file-info', async (_e, p) => {
  try {
    const st = fs.statSync(p);
    const icon = await app.getFileIcon(p, { size: 'normal' });
    iconCache.set(p, icon);
    return { ok: true, size: st.size, isDir: st.isDirectory(), icon: icon.toDataURL() };
  } catch { return { ok: false }; }
});
const iconCache = new Map();
ipcMain.on('start-drag', (e, p) => {
  if (!fs.existsSync(p)) return;
  e.sender.startDrag({ file: p, icon: iconCache.get(p) || trayImage() });
});

// ---------- мост с телефоном ----------
const bridge = createBridge({
  downloadsDir: () => dataDir('From phone'),
  onText: t => { lastClip = t; clipboard.writeText(t); send('bridge-text', t); },
  onFile: f => send('bridge-file', f),
});
ipcMain.handle('bridge-start', async (_e, files) => {
  bridge.setFiles(files || []);
  const url = await bridge.start(lanIp());
  return { url, qr: await QRCode.toDataURL(url, { margin: 1, width: 360 }) };
});
ipcMain.handle('bridge-stop', () => bridge.stop());
ipcMain.on('bridge-files', (_e, files) => bridge.setFiles(files || []));
ipcMain.on('bridge-text-out', (_e, t) => bridge.setText(t));

// ---------- настройки ----------
function loginArgs() {
  return app.isPackaged ? {} : { path: process.execPath, args: [path.resolve(__dirname, '..')] };
}
ipcMain.handle('settings-get', () => ({
  ...settings,
  displays: (() => { const pid = screen.getPrimaryDisplay().id; return screen.getAllDisplays().map((x, i) => ({ id: x.id, n: i + 1, w: Math.round(x.size.width * x.scaleFactor), h: Math.round(x.size.height * x.scaleFactor), primary: x.id === pid })); })(),
  autostart: app.getLoginItemSettings(loginArgs()).openAtLogin,
  version: app.getVersion(),
}));
ipcMain.handle('settings-set', (_e, patch) => {
  if ('autostart' in patch) app.setLoginItemSettings({ openAtLogin: !!patch.autostart, ...loginArgs() });
  for (const k of ['clipHistory', 'ocrLang', 'idleHide', 'notchOn']) if (k in patch) settings[k] = patch[k];
  if ('notchOn' in patch) { followId = null; if (winMode === 'pill' || winMode === 'full') placeWindow(); startFollow(); }
  if ('idleHide' in patch) startIdleWatch();
  saveSettings();
  return true;
});
ipcMain.on('quit', () => app.quit());

// ---------- трей ----------
function trayImage() {
  // Рисуем «таблетку» 32×32 вручную — без файлов-ресурсов.
  const S = 32, buf = Buffer.alloc(S * S * 4);
  const x0 = 3, x1 = 28, y0 = 10, y1 = 21, r = 5.5;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const cx = Math.min(Math.max(x + 0.5, x0 + r), x1 - r), cy = Math.min(Math.max(y + 0.5, y0 + r), y1 - r);
    const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    const a = Math.max(0, Math.min(1, r - dist + 0.5));
    const i = (y * S + x) * 4;
    const dot = Math.hypot(x + 0.5 - 22.5, y + 0.5 - 15.5) < 3;
    buf[i] = dot ? 0x3e : 0xff; buf[i + 1] = 0xff; buf[i + 2] = dot ? 0xd7 : 0xff; buf[i + 3] = Math.round(a * 255);
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S, scaleFactor: 2 });
}

// ---------- горячие клавиши ----------
// Ctrl+Alt+буква не используем: на Windows это AltGr, им набирают @ € { } [ ] \ на немецкой и многих других раскладках.
// Win+Shift+T / C / A / S / R / V и цифры часто заняты самой Windows — по умолчанию берём свободные
const HOTKEY_DEFAULTS = { toggle: 'Super+Shift+B', search: 'Super+Shift+F', game: 'Super+Shift+G', ocr: 'Super+Shift+O', color: 'Super+Shift+D', shot: 'Super+Shift+X', qrscan: 'Super+Shift+Q' };
const HOTKEY_ACTIONS = {
  toggle: () => toggle(), search: () => openSearch(), game: () => game && game.hotkey(), ocr: () => startCapture('ocr'), color: () => startCapture('color'),
  shot: () => startCapture('shot'), qrscan: () => startCapture('qrscan'),
};
let hotkeyStatus = {};
const hotkeyMap = () => ({ ...HOTKEY_DEFAULTS, ...(settings.hotkeys || {}) });
const hkText = (a) => (a || '').replace(/Super|Meta/g, 'Win').replace(/CommandOrControl|Control/g, 'Ctrl');
function hkLabel(id) { const a = hotkeyMap()[id]; return a && hotkeyStatus[id] === 'ok' ? '   ' + hkText(a) : ''; }
function hotkeyProblem(acc) {
  const p = acc.split('+');
  const ctrl = p.includes('Control') || p.includes('CommandOrControl');
  const alt = p.includes('Alt'); const win = p.includes('Super') || p.includes('Meta');
  if (ctrl && alt && !win) return 'Ctrl+Alt — это AltGr: так набирают @, €, {, }, [, ] на немецкой и многих других раскладках. Возьмите Win+Shift или Ctrl+Shift.';
  if (!ctrl && !alt && !win) return 'Нужна клавиша-модификатор: Win, Ctrl или Alt.';
  if (/^(Super\+)?Shift\+S$/.test(acc) || acc === 'Super+Shift+S') return 'Win+Shift+S занят «Ножницами» Windows.';
  return null;
}
function registerHotkeys() {
  globalShortcut.unregisterAll();
  if (process.env.BAR_SNAP) { hotkeyStatus = {}; return; } // тестовый экземпляр не занимает горячие клавиши основного
  hotkeyStatus = {};
  for (const [id, acc] of Object.entries(hotkeyMap())) {
    if (!acc) { hotkeyStatus[id] = 'off'; continue; }
    let ok = false;
    try { ok = globalShortcut.register(acc, HOTKEY_ACTIONS[id]); } catch {}
    hotkeyStatus[id] = ok ? 'ok' : 'busy';
  }
  if (tray) buildTrayMenu();
  send('hotkeys', { map: hotkeyMap(), status: hotkeyStatus });
}
ipcMain.handle('hotkeys-get', () => ({ map: hotkeyMap(), status: hotkeyStatus, defaults: HOTKEY_DEFAULTS }));
ipcMain.handle('hotkeys-set', (_e, id, acc) => {
  if (!(id in HOTKEY_DEFAULTS)) return { error: 'Неизвестное действие' };
  acc = String(acc || '');
  if (acc) {
    const why = hotkeyProblem(acc);
    if (why) { registerHotkeys(); return { error: why }; }
    const dup = Object.entries(hotkeyMap()).find(([k, v]) => k !== id && v === acc);
    if (dup) { registerHotkeys(); return { error: 'Это сочетание уже назначено другому действию.' }; }
  }
  settings.hotkeys = { ...(settings.hotkeys || {}), [id]: acc };
  saveSettings();
  registerHotkeys();
  return { ok: true, status: hotkeyStatus[id] };
});
ipcMain.handle('hotkeys-reset', () => { settings.hotkeys = {}; saveSettings(); registerHotkeys(); return true; });
// пока пользователь записывает новое сочетание, глобальные перехваты отключены — иначе нажатие уйдёт в действие
ipcMain.on('hotkeys-pause', () => globalShortcut.unregisterAll());
ipcMain.on('hotkeys-resume', () => registerHotkeys());

function buildTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть панель' + hkLabel('toggle'), click: () => toggle() },
    { label: 'Поиск' + hkLabel('search'), click: () => openSearch() },
    { type: 'separator' },
    { label: 'Текст с экрана' + hkLabel('ocr'), click: () => startCapture('ocr') },
    { label: 'Пипетка' + hkLabel('color'), click: () => startCapture('color') },
    { label: 'Скриншот области' + hkLabel('shot'), click: () => startCapture('shot') },
    { label: 'Сканировать QR' + hkLabel('qrscan'), click: () => startCapture('qrscan') },
    { type: 'separator' },
    {
      label: 'Игровой режим', type: 'checkbox', checked: !!(settings.game && settings.game.auto),
      click: (item) => { if (game) game.setAuto(item.checked); },
    },
    {
      label: 'Скрыть нотч', type: 'checkbox', checked: !!settings.hidden,
      click: (item) => { settings.hidden = item.checked; saveSettings(); item.checked ? win.hide() : win.showInactive(); },
    },
    { label: 'YouTube Music: установить расширение', click: () => music && music.install() },
    { type: 'separator' },
    { label: 'Папка Bar', click: () => shell.openPath(dataDir()) },
    { label: 'Выход', click: () => app.quit() },
  ]));
}

function openSearch() {
  if (!win) return;
  if (settings.hidden) { settings.hidden = false; saveSettings(); win.showInactive(); buildTrayMenu(); }
  send('search');
  win.focus();
}
function toggle() {
  if (!win) return;
  // во время игры: сначала нотч возвращается наверх, потом открывается панель
  if (game && game.isActive()) { game.openPanel(); return; }
  if (settings.hidden) { settings.hidden = false; saveSettings(); win.showInactive(); buildTrayMenu(); }
  send('toggle');
  win.focus();
}

// ---------- автоскрытие: нет движения мыши на мониторе с нотчем → нотч уезжает вверх ----------
let idleTimer = null, idleLast = 0, idleHidden = false, idlePt = null;
function startIdleWatch() {
  clearInterval(idleTimer); idleTimer = null;
  if (idleHidden) { idleHidden = false; send('idle', false); }
  if (!settings.idleHide) return;
  if (process.env.BAR_SNAP && !process.env.BAR_SNAP_IDLE) return; // самопроверка: не прятать
  idleLast = Date.now();
  idleTimer = setInterval(() => {
    const pt = screen.getCursorScreenPoint();
    const b = notchDisplay().bounds; // монитор, на котором сейчас нотч
    if (game && game.isActive()) return; // в игре нотч не прячем — он в углу
    const onMine = pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
    const moved = !idlePt || pt.x !== idlePt.x || pt.y !== idlePt.y;
    idlePt = pt;
    if (onMine && moved) {
      idleLast = Date.now();
      if (idleHidden) { idleHidden = false; send('idle', false); }
    } else if (!idleHidden && Date.now() - idleLast > settings.idleHide * 1000) {
      idleHidden = true; send('idle', true);
    }
  }, 500);
}
ipcMain.on('idle-wake', () => { idleLast = Date.now(); if (idleHidden) { idleHidden = false; send('idle', false); } });

// ---------- старт ----------
app.whenReady().then(() => {
  // первая установка (настроек ещё нет): Bar сам включается в автозапуск — выключить можно в Настройки → Основное
  const firstRun = !fs.existsSync(settingsFile());
  loadSettings();
  if (firstRun && app.isPackaged && !process.env.BAR_SNAP) { app.setLoginItemSettings({ openAtLogin: true, ...loginArgs() }); saveSettings(); }
  // разрешения браузера — только своим страницам: микрофон для диктофона и уведомления
  const ownPage = (wc, origin) => (origin && origin.startsWith('file://')) || (wc && wc.getURL().startsWith(UI_URL));
  const PERMS = ['media', 'notifications'];
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => cb(PERMS.includes(perm) && ownPage(wc, details && details.requestingUrl)));
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => PERMS.includes(perm) && ownPage(wc, origin));
  createWindow();
  sensors = setupSensors({ send, getWin: () => win, getStats });
  music = setupMusic({ send });
  setupUpdater({ send });
  game = setupGame({ getWin: () => win, send, settings, saveSettings, sensors, win: gameWin, getStats, notchDisplay: () => notchDisplay(), onAuto: () => buildTrayMenu() });
  startFollow();
  taskbar = setupTaskbar({ settings, saveSettings, sensors, isGame: () => (game && game.isActive() ? game.activeMon() : null), openApps: (id = 'apps') => { if (!win) return; send('open-tool', id); win.focus(); } });
  ipcMain.on('tb-search', () => openSearch());
  // Развёрнутое окно на мониторе нотча (браузер на весь экран) — нотч уезжает вверх тонкой полоской,
  // чтобы не закрывать вкладки. Проверка — только по событиям окон, без постоянного опроса.
  let tuckT = 0, tucked = null;
  const tuckCheck = async () => {
    let r = '';
    try { r = String((await sensors.call('fgmax', '', 2000)) || ''); } catch {}
    let on = false;
    if (r) {
      const [l, t, rr, b] = r.split(',').map(Number);
      const d = screen.getDisplayMatching(screen.screenToDipRect(null, { x: l, y: t, width: rr - l, height: b - t }));
      on = d.id === notchDisplay().id;
    }
    if (on !== tucked) { tucked = on; send('tuck', on); }
  };
  winwatch.on('EL', () => { clearTimeout(tuckT); tuckT = setTimeout(tuckCheck, 200); });
  setTimeout(tuckCheck, 1500);
  // то, что уже лежит в буфере при запуске, тоже попадает в историю
  loadClips().then(async () => {
    const t = await readClip();
    lastClip = t;
    if (settings.clipHistory && t && !(await isSecretClip())) pushClip(t, { silent: true });
    send('clips', clips);
    setInterval(pollClipboard, 700);
  });
  startIdleWatch();

  tray = new Tray(trayImage());
  tray.setToolTip('Bar — нотч');
  tray.on('click', toggle);
  buildTrayMenu();

  registerHotkeys();

  if (process.env.BAR_SNAP) snapshots(process.env.BAR_SNAP);
});

// Режим самопроверки: BAR_SNAP=<папка> снимает скриншоты состояний и выходит.
async function snapshots(dir) {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  win.webContents.on('console-message', (e) => { if (e.level !== 'info') console.log('[ui]', e.level, e.message); });
  if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
  await wait(1000);
  const shot = async (name) => fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage()).toPNG());
  // Сценарий: JSON [{ "name": "...", "js": "...", "wait": 600 }]; name пустое — без снимка
  const steps = JSON.parse(fs.readFileSync(process.env.BAR_SNAP_STEPS, 'utf8'));
  for (const s of steps) {
    const code = s.jsFile ? fs.readFileSync(s.jsFile, 'utf8') : s.js;
    try { if (code) await win.webContents.executeJavaScript(code + ';0'); } catch (err) { console.log('[step error]', s.name, err.message); }
    await wait(s.wait ?? 700);
    if (s.name) await shot(s.name);
  }
  app.quit();
}

app.on('second-instance', toggle);
// перед выходом — вернуть панель задач Windows и освободить место у края (это асинхронно, поэтому выход ждёт)
let quitReady = false;
app.on('before-quit', (e) => {
  if (quitReady || !taskbar) return;
  e.preventDefault();
  Promise.race([taskbar.stop(), new Promise((r) => setTimeout(r, 4000))]).finally(() => { quitReady = true; app.quit(); });
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  bridge.stop();
  if (sensors) sensors.stop();
  if (music) music.stop();
  if (game) game.stop();
  winwatch.stop();
  if (ps) try { ps.kill(); } catch {}
});
app.on('window-all-closed', () => app.quit());
