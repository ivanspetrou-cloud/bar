// Таскбар Bar: док внизу КАЖДОГО монитора вместо панели задач Windows.
// • Окна: события Windows (winevents.ps1) → список окон (agent: taskwins) → во все доки; доки на всех мониторах одинаковые.
// • Режимы: «прятаться» — выезжает от нижнего края; «всегда» — виден всегда (по желанию — с резервом места, AppBar).
// • Панель Windows (и на других мониторах) прячется, пока таскбар Bar включён, и возвращается при выключении или выходе.
const { BrowserWindow, screen, ipcMain, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SIZES = { s: 44, m: 52, l: 62 };   // высота дока (без отступа от края)
const EDGE = 8;                          // отступ дока от нижнего края
const WIN_H = 420;                       // окно выше дока: место для подписи, увеличения и превью окон
const CB_MSG = 0x0400 + 77;              // сообщение AppBar от Windows (полноэкранные программы, смена места)

module.exports = function setupTaskbar({ settings, saveSettings, sensors, isGame, openApps }) {
  const docks = new Map();   // id монитора → { win, display, reserved, fullscreen, gameOn }
  let ev = null, evBuf = '', debT = 0, keepT = 0, gameT = 0, lastList = [];
  const thumbs = new Map(); // окно → последний снимок (для свёрнутых: снят в момент сворачивания)
  // btn — какие кнопки показывать; running — открытые незакреплённые программы; extras — ярлыки (папки, места Windows, инструменты Bar)
  const cfg = () => {
    const c = { on: false, mode: 'hide', size: 'm', magnify: true, reserve: false, sizes: {}, same: true, running: true, extras: [], ...(settings.taskbar || {}) };
    c.btn = { start: true, search: true, desktop: true, ...((settings.taskbar || {}).btn || {}) };
    return c;
  };
  // размер — свой у каждого монитора (по умолчанию общий)
  const sizeOf = (display) => (cfg().sizes || {})[display.id] || cfg().size;
  const cfgFor = (d) => ({ ...cfg(), size: sizeOf(d.display), zoom: d.zoom || 1 });

  // ---------- одинаковый размер в сантиметрах на всех мониторах ----------
  // Эталон — монитор с самым мелким пикселем (у вас 27" 2K): на нём таскбар как есть, на остальных док
  // берёт размер с поправкой, чтобы иконки были того же физического размера. Размеры экранов — из EDID.
  let monMm = null; // имя монитора → ширина изображения, мм
  async function loadMonSizes() {
    const rows = await call('monsizes', '', 15000);
    monMm = new Map();
    for (const r of Array.isArray(rows) ? rows : rows ? [rows] : []) {
      const [n, w] = String(r).split('|');
      if (n && +w > 0) monMm.set(n.trim().toLowerCase(), +w * 10);
    }
    for (const d of docks.values()) applyZoom(d);
  }
  // мм на один пиксель страницы (CSS px) при масштабе 1
  const mmPerCss = (x) => { const w = monMm && monMm.get(String(x.label || '').trim().toLowerCase()); return w ? (w / (x.size.width * x.scaleFactor)) * x.scaleFactor : null; };
  function zoomOf(display) {
    if (!cfg().same || !monMm) return 1;
    const all = screen.getAllDisplays().filter(mmPerCss);
    const mine = mmPerCss(display);
    if (!mine || all.length < 2) return 1;
    const ref = all.reduce((a, b) => (mmPerCss(a) <= mmPerCss(b) ? a : b)); // самый мелкий пиксель
    return Math.max(0.5, Math.min(2, mmPerCss(ref) / mine));
  }
  function applyZoom(d) {
    if (d.win.isDestroyed()) return;
    const k = zoomOf(d.display);
    d.zoom = k;
    place(d);
    d.win.webContents.send('tb-cfg', cfgFor(d)); // док сам берёт размер с поправкой
  }
  const call = (cmd, arg = '', ms = 4000) => sensors.call(cmd, arg, ms).catch(() => undefined);
  const own = process.execPath.toLowerCase();
  const hwndOf = (win) => { const b = win.getNativeWindowHandle(); return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0); };
  const dockOf = (e) => [...docks.values()].find((d) => !d.win.isDestroyed() && d.win.webContents === e.sender);
  const sendAll = (ch, v) => { for (const d of docks.values()) if (!d.win.isDestroyed()) d.win.webContents.send(ch, v); };

  // ---------- окна ----------
  // монитор окна приходит в физических пикселях — переводим в монитор Electron
  function displayIdOf(rect) {
    const [l, t, r, b] = String(rect || '').split(',').map(Number);
    if (!Number.isFinite(l)) return screen.getPrimaryDisplay().id;
    const dip = screen.screenToDipRect(null, { x: l, y: t, width: r - l, height: b - t });
    return screen.getDisplayMatching(dip).id;
  }
  async function refresh() {
    const rows = await call('taskwins', '', 4000);
    if (!rows) return;
    lastList = (Array.isArray(rows) ? rows : [rows]).map((r) => {
      const p = String(r).split('|');
      return { hwnd: Number(p[0]), pid: Number(p[1]), exe: p[2] || '', min: p[3] === '1', active: p[4] === '1', disp: displayIdOf(p[5]), title: p.slice(6).join('|') };
    }).filter((w) => w.exe && w.exe.toLowerCase() !== own
      // окна самого Bar (и Bar Lab, и запущенного из исходников) — не программы пользователя
      && !(/\\(bar|bar lab|electron)\.exe$/i.test(w.exe) && /^Bar( Lab)?( — таскбар)?$/.test(w.title)));
    sendAll('tb-wins', lastList);
    if (sensors.noteExe) for (const w of lastList) sensors.noteExe(w.exe);
    const fg = lastList.find((w) => w.active && !w.min);
    if (fg && fg.hwnd !== lastFg) { lastFg = fg.hwnd; clearTimeout(fgSnapT); fgSnapT = setTimeout(snapFg, 700); } // новое активное — снимок, когда дорисуется
  }
  // Свёрнутое окно Windows не рисует — поэтому заранее держим свежий снимок активного окна
  // (раз в 5 с и при смене окна; одно окно ≈ 30 мс). Свернёте — в превью останется картинка.
  let lastFg = 0, fgSnapT = 0, fgT = 0;
  async function snapFg() {
    const fg = lastList.find((w) => w.active && !w.min);
    if (!fg) return;
    const rows = await call('winthumbs', String(fg.hwnd), 4000);
    const r = String((Array.isArray(rows) ? rows[0] : rows) || '');
    const k = r.indexOf('|');
    if (k > 0 && r.length - k > 100) {
      thumbs.delete(fg.hwnd); thumbs.set(fg.hwnd, 'data:image/jpeg;base64,' + r.slice(k + 1));
      if (thumbs.size > 60) thumbs.delete(thumbs.keys().next().value);
    }
  }
  const refreshSoon = () => { clearTimeout(debT); debT = setTimeout(refresh, 120); };
  function startEvents() {
    if (ev) return;
    const script = path.join(__dirname, 'winevents.ps1').replace('app.asar', 'app.asar.unpacked');
    ev = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
    ev.stdout.setEncoding('utf8');
    ev.stdout.on('data', (d) => {
      evBuf += d;
      let i;
      while ((i = evBuf.indexOf('\n')) >= 0) {
        const line = evBuf.slice(0, i).trim(); evBuf = evBuf.slice(i + 1);
        if (line === 'E') refreshSoon();
        else if (line.startsWith('T ')) { // снимок окна в момент сворачивания — для превью свёрнутых
          const k = line.indexOf(' ', 2);
          thumbs.set(Number(line.slice(2, k)), 'data:image/jpeg;base64,' + line.slice(k + 1));
          if (thumbs.size > 60) thumbs.delete(thumbs.keys().next().value);
        }
      }
    });
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

  // ---------- место у края ----------
  async function reserve(d) {
    const sf = d.display.scaleFactor;
    const p = screen.dipToScreenRect(null, d.display.bounds);
    const h = Math.round((SIZES[sizeOf(d.display)] + EDGE * 2) * (d.zoom || 1) * sf);
    await call('appbar', [hwndOf(d.win), p.x, p.y + p.height - h, p.x + p.width, p.y + p.height, CB_MSG].join(' '));
    d.reserved = true;
  }
  async function unreserve(d) { if (!d.win.isDestroyed()) { d.reserved = false; await call('appbaroff', String(hwndOf(d.win))); } }

  function place(d) {
    const b = d.display.bounds;
    const wh = WIN_H;
    d.win.setBounds({ x: b.x, y: b.y + b.height - wh, width: b.width, height: wh });
    // место у края — только если попросили: иначе док висит поверх окон, а они идут до самого низа экрана
    if (cfg().mode === 'always' && cfg().reserve) reserve(d); else unreserve(d);
  }
  function visibleSync(d) {
    if (d.win.isDestroyed()) return;
    const hide = d.gameOn || d.fullscreen;
    if (hide && d.win.isVisible()) d.win.hide();
    else if (!hide && !d.win.isVisible()) d.win.showInactive();
  }

  function create(display) {
    const win = new BrowserWindow({
      width: 800, height: WIN_H, frame: false, transparent: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, focusable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
    });
    const d = { win, display, reserved: false, fullscreen: false, gameOn: false };
    docks.set(display.id, d);
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.setIgnoreMouseEvents(true, { forward: true });
    if (process.env.BAR_SNAP) win.webContents.on('console-message', (e) => console.log('[tb-ui]', e.level, e.message));
    win.loadFile(path.join(__dirname, 'ui', 'taskbar.html'), { query: { d: String(display.id) } });
    win.once('ready-to-show', () => { applyZoom(d); visibleSync(d); win.webContents.send('tb-wins', lastList); refreshSoon(); });
    // Windows сообщает таскбару о полноэкранных программах на ЕГО мониторе и о смене места
    win.hookWindowMessage(CB_MSG, (wParam, lParam) => {
      const w = wParam.length >= 8 ? Number(wParam.readBigUInt64LE(0)) : wParam.readUInt32LE(0);
      const l = lParam.length >= 8 ? Number(lParam.readBigUInt64LE(0)) : lParam.readUInt32LE(0);
      if (w === 1 && d.reserved) reserve(d);                   // ABN_POSCHANGED (уведомление о «полноэкранных» не используем:
      void l;                                                  // Windows считает такими и развёрнутые окна без рамки — Steam, Claude)
    });
    return d;
  }
  // мониторы подключили, отключили, поменяли разрешение — у каждого свой док
  function syncDisplays() {
    if (!cfg().on) return;
    const now = screen.getAllDisplays();
    const ids = new Set(now.map((x) => x.id));
    for (const [id, d] of docks) if (!ids.has(id)) { unreserve(d); d.win.destroy(); docks.delete(id); }
    for (const display of now) {
      const d = docks.get(display.id);
      if (!d) create(display);
      else { d.display = display; applyZoom(d); }
    }
  }

  // Полноэкранное (игра, видео на весь экран) — активное окно ровно на весь монитор и НЕ развёрнутое кнопкой.
  // Прячем док только на мониторе этого окна; игровой режим Bar тоже прячет док своего монитора.
  async function fullCheck() {
    const raw = String((await call('gamestate', '', 2000)) || '');
    const [full, , , , mon] = raw.split('|');
    let fullId = null;
    if (full === '1' && mon) {
      const [x, y, w, h] = mon.split(',').map(Number);
      fullId = screen.getDisplayMatching(screen.screenToDipRect(null, { x, y, width: w, height: h })).id;
    }
    const gm = isGame && isGame();
    for (const d of docks.values()) {
      const b = d.display.bounds;
      const g = !!(gm && gm.x < b.x + b.width && gm.x + gm.width > b.x && gm.y < b.y + b.height && gm.y + gm.height > b.y);
      const f = fullId === d.display.id;
      if (g !== d.gameOn || f !== d.fullscreen) { d.gameOn = g; d.fullscreen = f; visibleSync(d); }
    }
  }

  async function enable() {
    syncDisplays();
    if (!monMm) loadMonSizes();
    startEvents();
    await hideWinTaskbar();
    clearInterval(keepT); keepT = setInterval(() => call('hidetaskbar', '1'), 10000); // Проводник перезапустился — снова прячем
    clearInterval(fgT); fgT = setInterval(snapFg, 5000);
    clearInterval(gameT); gameT = setInterval(fullCheck, 2000);
  }
  async function disable() {
    clearInterval(keepT); clearInterval(gameT); clearInterval(fgT); stopEvents(); thumbs.clear();
    for (const d of docks.values()) { await unreserve(d); d.win.destroy(); }
    docks.clear();
    await restoreWinTaskbar();
  }
  const apply = () => (cfg().on ? enable() : disable());

  // мониторы для настроек: «Монитор 1 · 2560×1440 · основной»
  const displays = () => { const pid = screen.getPrimaryDisplay().id; return screen.getAllDisplays().map((x, i) => ({ id: x.id, n: i + 1, w: Math.round(x.size.width * x.scaleFactor), h: Math.round(x.size.height * x.scaleFactor), primary: x.id === pid, size: sizeOf(x) })); };
  ipcMain.handle('taskbar-get', (e) => { const d = dockOf(e); return d ? cfgFor(d) : { ...cfg(), displays: displays() }; });
  ipcMain.handle('taskbar-set', async (_e, patch) => {
    const before = cfg();
    settings.taskbar = { ...before, ...(patch || {}) };
    saveSettings();
    const now = cfg();
    if (now.on !== before.on) await apply();
    else for (const d of docks.values()) { applyZoom(d); visibleSync(d); if (!d.win.isDestroyed()) d.win.webContents.send('tb-cfg', cfgFor(d)); }
    return { ...now, displays: displays() };
  });
  ipcMain.on('tb-interactive', (e, on) => { const d = dockOf(e); if (d) d.win.setIgnoreMouseEvents(!on, on ? undefined : { forward: true }); });
  ipcMain.on('tb-refresh', () => refreshSoon());
  ipcMain.on('tb-start', () => call('startmenu'));                 // «Пуск» Windows — по правому клику
  ipcMain.on('tb-apps', () => openApps && openApps());              // все приложения — в нотче, в стиле Bar
  ipcMain.on('tb-tool', (_e, id) => { if (/^[a-z]{2,16}$/.test(String(id)) && openApps) openApps(String(id)); }); // инструмент Bar / настройки таскбара
  // ярлыки дока: только эти места Windows и существующие папки
  const PLACES = {
    recycle: () => spawn('explorer.exe', ['shell:RecycleBinFolder'], { detached: true, stdio: 'ignore' }).unref(),
    downloads: () => spawn('explorer.exe', ['shell:Downloads'], { detached: true, stdio: 'ignore' }).unref(),
    documents: () => spawn('explorer.exe', ['shell:Personal'], { detached: true, stdio: 'ignore' }).unref(),
    pc: () => spawn('explorer.exe', ['shell:MyComputerFolder'], { detached: true, stdio: 'ignore' }).unref(),
    settings: () => shell.openExternal('ms-settings:'),
    taskmgr: () => spawn('taskmgr.exe', [], { detached: true, stdio: 'ignore' }).unref(),
  };
  ipcMain.on('tb-open', (_e, x) => {
    try {
      if (x && x.place && PLACES[x.place]) return PLACES[x.place]();
      if (x && x.path && fs.statSync(String(x.path)).isDirectory()) shell.openPath(String(x.path));
    } catch {}
  });
  ipcMain.handle('pick-exe', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(w, { title: 'Программа для таскбара', properties: ['openFile'], filters: [{ name: 'Программы', extensions: ['exe', 'lnk', 'bat', 'cmd'] }] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.handle('pick-folder', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(w, { title: 'Папка для таскбара', properties: ['openDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.on('tb-desktop', () => call('showdesktop'));
  ipcMain.on('tb-closewin', (_e, hwnd) => { if (Number.isFinite(+hwnd)) call('closewin', String(+hwnd)).then(refreshSoon); });
  // превью окон при наведении: снимок только запрошенных окон (PrintWindow в агенте, ~десятки мс на окно)
  ipcMain.handle('tb-thumbs', async (_e, hwnds) => {
    const ids = (hwnds || []).map(Number).filter(Number.isFinite).slice(0, 8);
    if (!ids.length) return {};
    const rows = await call('winthumbs', ids.join(','), 6000);
    for (const r of Array.isArray(rows) ? rows : rows ? [rows] : []) {
      const k = String(r).indexOf('|');
      const b64 = String(r).slice(k + 1);
      if (b64.length > 100) thumbs.set(Number(String(r).slice(0, k)), 'data:image/jpeg;base64,' + b64);
    }
    // свёрнутые окна сейчас не снять — отдаём последний снимок
    const out = {};
    for (const h of ids) if (thumbs.has(h)) out[h] = thumbs.get(h);
    return out;
  });
  for (const evName of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(evName, () => setTimeout(syncDisplays, 300));

  // запуск: включён — поднимаем; выключен, но панель Windows осталась спрятанной (аварийный выход) — возвращаем
  if (cfg().on) apply(); else if (settings.tbPrevAutoHide !== undefined) restoreWinTaskbar();

  return {
    async stop() {
      clearInterval(keepT); clearInterval(gameT); clearInterval(fgT); stopEvents();
      for (const d of docks.values()) await unreserve(d);
      if (settings.tbPrevAutoHide !== undefined) { await call('hidetaskbar', '0'); await call('settaskbar', settings.tbPrevAutoHide ? '1' : '0'); delete settings.tbPrevAutoHide; saveSettings(); }
    },
  };
};
