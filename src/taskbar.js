// Таскбар Bar: док внизу основного монитора вместо панели задач Windows.
// • Окна: события Windows (winevents.ps1) → список окон по запросу (agent: taskwins) → в окно таскбара.
// • Режимы: «прятаться» — выезжает от нижнего края; «всегда» — резервирует место (AppBar), развёрнутые окна над ним.
// • Панель Windows прячется, пока таскбар Bar включён, и возвращается при выключении или выходе.
const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

const SIZES = { s: 44, m: 52, l: 62 };   // высота дока (без отступа от края)
const EDGE = 8;                          // отступ дока от нижнего края
const WIN_H = 170;                       // окно выше дока: место для подписи и увеличения при наведении
const CB_MSG = 0x0400 + 77;              // сообщение AppBar от Windows (полноэкранные программы, смена места)

module.exports = function setupTaskbar({ settings, saveSettings, sensors, isGame, openApps }) {
  let win = null, ev = null, evBuf = '', debT = 0, keepT = 0, gameT = 0, reserved = false, fullscreen = false, gameOn = false;
  const cfg = () => ({ on: false, mode: 'hide', size: 'm', magnify: true, ...(settings.taskbar || {}) });
  const call = (cmd, arg = '', ms = 4000) => sensors.call(cmd, arg, ms).catch(() => undefined);
  const disp = () => screen.getPrimaryDisplay();
  const own = process.execPath.toLowerCase();
  const send = (ch, v) => win && !win.isDestroyed() && win.webContents.send(ch, v);
  const hwndOf = () => { const b = win.getNativeWindowHandle(); return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0); };

  // ---------- окна ----------
  async function refresh() {
    const rows = await call('taskwins', '', 4000);
    if (!rows) return;
    const list = (Array.isArray(rows) ? rows : [rows]).map((r) => {
      const s = String(r); const p = s.split('|');
      return { hwnd: Number(p[0]), pid: Number(p[1]), exe: p[2] || '', min: p[3] === '1', active: p[4] === '1', title: p.slice(5).join('|') };
    }).filter((w) => w.exe && w.exe.toLowerCase() !== own
      // окна самого Bar (и Bar Lab, и запущенного из исходников) — не программы пользователя
      && !(/\\(bar|bar lab|electron)\.exe$/i.test(w.exe) && /^Bar( Lab)?( — таскбар)?$/.test(w.title)));
    send('tb-wins', list);
  }
  const refreshSoon = () => { clearTimeout(debT); debT = setTimeout(refresh, 120); };
  function startEvents() {
    if (ev) return;
    const script = path.join(__dirname, 'winevents.ps1').replace('app.asar', 'app.asar.unpacked');
    ev = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
    ev.stdout.setEncoding('utf8');
    ev.stdout.on('data', (d) => { evBuf += d; if (evBuf.includes('E')) { evBuf = ''; refreshSoon(); } });
    ev.on('exit', () => { ev = null; if (cfg().on) setTimeout(startEvents, 3000); }); // упал — перезапуск
    ev.on('error', () => { ev = null; });
  }
  function stopEvents() { if (ev) { const p = ev; ev = null; p.removeAllListeners('exit'); try { p.kill(); } catch {} } }

  // ---------- панель Windows ----------
  async function hideWinTaskbar() {
    if (settings.tbPrevAutoHide === undefined) {
      // запоминаем, как было, — вернём ровно так же (переживает и аварийный выход: значение в настройках)
      const v = await call('taskbar');
      settings.tbPrevAutoHide = !!v; saveSettings();
    }
    await call('settaskbar', '1');     // автоскрытие освобождает место у края экрана
    await call('hidetaskbar', '1');    // и не даёт панели Windows выезжать поверх таскбара Bar
  }
  async function restoreWinTaskbar() {
    if (settings.tbPrevAutoHide === undefined) return;
    await call('hidetaskbar', '0');
    await call('settaskbar', settings.tbPrevAutoHide ? '1' : '0');
    delete settings.tbPrevAutoHide; saveSettings();
  }

  // ---------- место у края (режим «всегда») ----------
  async function reserve() {
    if (!win) return;
    const d = disp(), sf = d.scaleFactor, b = d.bounds;
    const h = SIZES[cfg().size] + EDGE * 2;
    await call('appbar', [hwndOf(), Math.round(b.x * sf), Math.round((b.y + b.height - h) * sf), Math.round((b.x + b.width) * sf), Math.round((b.y + b.height) * sf), CB_MSG].join(' '));
    reserved = true;
  }
  async function unreserve() { if (reserved && win) { reserved = false; await call('appbaroff', String(hwndOf())); } }

  function place() {
    if (!win) return;
    const b = disp().bounds;
    win.setBounds({ x: b.x, y: b.y + b.height - WIN_H, width: b.width, height: WIN_H });
    if (cfg().mode === 'always') reserve(); else unreserve();
  }
  function visibleSync() {
    if (!win) return;
    const hide = gameOn || (fullscreen && cfg().mode === 'always');
    if (process.env.BAR_SNAP) console.log('[tb] visibleSync', { gameOn, fullscreen, hide, vis: win.isVisible() });
    if (hide && win.isVisible()) win.hide();
    else if (!hide && !win.isVisible()) win.showInactive();
  }

  function create() {
    win = new BrowserWindow({
      width: 800, height: WIN_H, frame: false, transparent: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, focusable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
    });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.setIgnoreMouseEvents(true, { forward: true });
    win.loadFile(path.join(__dirname, 'ui', 'taskbar.html'));
    win.once('ready-to-show', () => { place(); visibleSync(); refresh(); });
    // Windows сообщает таскбару о полноэкранных программах (видео, игры) и о смене места
    win.hookWindowMessage(CB_MSG, (wParam, lParam) => {
      const w = wParam.length >= 8 ? Number(wParam.readBigUInt64LE(0)) : wParam.readUInt32LE(0);
      const l = lParam.length >= 8 ? Number(lParam.readBigUInt64LE(0)) : lParam.readUInt32LE(0);
      if (w === 2) { fullscreen = !!l; visibleSync(); }       // ABN_FULLSCREENAPP
      if (w === 1 && cfg().mode === 'always') reserve();      // ABN_POSCHANGED
    });
  }

  async function enable() {
    if (!win) create(); else { place(); visibleSync(); }
    startEvents();
    await hideWinTaskbar();
    clearInterval(keepT); keepT = setInterval(() => call('hidetaskbar', '1'), 10000); // Проводник перезапустился — снова прячем
    clearInterval(gameT); gameT = setInterval(() => {
      // игра на другом мониторе таскбару не мешает
      const m = isGame && isGame(), b = disp().bounds;
      const g = !!(m && m.x < b.x + b.width && m.x + m.width > b.x && m.y < b.y + b.height && m.y + m.height > b.y);
      if (g !== gameOn) { gameOn = g; visibleSync(); }
    }, 2000);
  }
  async function disable() {
    clearInterval(keepT); clearInterval(gameT); stopEvents();
    await unreserve();
    if (win) { win.destroy(); win = null; }
    await restoreWinTaskbar();
  }
  const apply = () => (cfg().on ? enable() : disable());

  ipcMain.handle('taskbar-get', () => cfg());
  ipcMain.handle('taskbar-set', async (_e, patch) => {
    const before = cfg();
    settings.taskbar = { ...before, ...(patch || {}) };
    saveSettings();
    const now = cfg();
    if (now.on !== before.on) await apply();
    else if (win) { place(); visibleSync(); send('tb-cfg', now); }
    return now;
  });
  ipcMain.on('tb-interactive', (_e, on) => { if (win) win.setIgnoreMouseEvents(!on, on ? undefined : { forward: true }); });
  ipcMain.on('tb-refresh', () => refresh());
  ipcMain.on('tb-start', () => call('startmenu'));                 // «Пуск» Windows — по правому клику
  ipcMain.on('tb-apps', () => openApps && openApps());              // все приложения — в нотче, в стиле Bar
  ipcMain.on('tb-desktop', () => call('showdesktop'));
  screen.on('display-metrics-changed', () => win && place());

  // запуск: включён — поднимаем; выключен, но панель Windows осталась спрятанной (аварийный выход) — возвращаем
  if (cfg().on) apply(); else if (settings.tbPrevAutoHide !== undefined) restoreWinTaskbar();

  return {
    async stop() { clearInterval(keepT); clearInterval(gameT); stopEvents(); await unreserve(); if (settings.tbPrevAutoHide !== undefined) { await call('hidetaskbar', '0'); await call('settaskbar', settings.tbPrevAutoHide ? '1' : '0'); delete settings.tbPrevAutoHide; saveSettings(); } },
  };
};
