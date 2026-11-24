// Обновления Bar из GitHub Releases (публичный репозиторий).
// • Проверка: при запуске (через 15 с) и раз в 6 часов. Запрос идёт только на github.com — без каких-либо данных о вас.
// • Скачивание и установка — только по кнопке в Настройках.
// • Целостность: electron-updater сверяет SHA-512 скачанного установщика с latest.yml из того же релиза.
const { app, ipcMain } = require('electron');

module.exports = function setupUpdater({ send }) {
  let st = { state: 'idle', version: app.getVersion() };
  const set = (p) => { st = { ...st, ...p }; send('update', st); };

  // в разработке (не установленная сборка) обновляться нечему
  // Bar Lab не обновляется из релизов основного Bar
  if (!app.isPackaged || /-lab/.test(app.getVersion())) {
    st.state = 'dev';
    ipcMain.handle('update-get', () => st);
    ipcMain.handle('update-check', () => st);
    ipcMain.handle('update-download', () => false);
    ipcMain.handle('update-install', () => false);
    return { stop() {} };
  }

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false;          // качаем только по кнопке
  autoUpdater.autoInstallOnAppQuit = true;   // скачанное ставится при выходе, если не нажали «Перезапустить»
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: '' }));
  autoUpdater.on('update-available', (i) => set({ state: 'available', next: i.version }));
  autoUpdater.on('update-not-available', () => set({ state: 'latest', checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: p.percent, speed: p.bytesPerSecond, done: p.transferred, total: p.total }));
  autoUpdater.on('update-downloaded', (i) => set({ state: 'ready', next: i.version, percent: 100 }));
  autoUpdater.on('error', (e) => set({ state: 'error', error: String((e && e.message) || e).split('\n')[0].slice(0, 160) }));

  let busy = false;
  const check = async () => {
    if (busy || st.state === 'downloading' || st.state === 'ready') return;
    busy = true;
    try { await autoUpdater.checkForUpdates(); } catch {} finally { busy = false; }
  };
  ipcMain.handle('update-get', () => st);
  ipcMain.handle('update-check', () => { check(); return st; });
  ipcMain.handle('update-download', () => {
    if (st.state !== 'available' && st.state !== 'error') return false;
    set({ state: 'downloading', percent: 0, speed: 0 });
    autoUpdater.downloadUpdate().catch(() => {});
    return true;
  });
  ipcMain.handle('update-install', () => {
    if (st.state !== 'ready') return false;
    setImmediate(() => autoUpdater.quitAndInstall(true, true)); // тихая установка и запуск новой версии
    return true;
  });
  const t1 = setTimeout(check, 15000);
  const t2 = setInterval(check, 6 * 3600e3);
  return { stop() { clearTimeout(t1); clearInterval(t2); } };
};
