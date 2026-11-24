// Игровой режим.
// • Узнаёт игру: окно на переднем плане закрывает весь монитор и это не браузер / плеер / рабочий стол.
// • Нотч «переплывает» в выбранный угол и показывает только игровые показатели:
//   FPS (PresentMon от Intel), процессор, видеокарта, память, пинг, время.
// • Плашка прозрачна для мыши — в игре она ничего не перехватывает.
// Всё считается на этом компьютере. Пинг — время TCP-рукопожатия с 1.1.1.1:443 (без содержимого).
const { app, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const { spawn, execFile } = require('child_process');
const Agent = require('./agent-host');

// Программы на весь экран, которые не игры
const NOT_GAMES = /\\(msedge|chrome|firefox|opera|brave|vivaldi|yandex|browser|vlc|mpc-hc64|mpc-hc|mpc-be64|potplayermini64|potplayer|mpv|wmplayer|explorer|applicationframehost|powerpnt|teams|ms-teams|zoom|obs64|obs32|discord|telegram|slack|code|devenv|idea64|photoshop|lightroom|resolve|premiere|afterfx|mspaint|snippingtool|screenclippinghost|searchhost|shellexperiencehost|startmenuexperiencehost|lockapp|textinputhost|systemsettings|electron|bar)\.exe$/i;

module.exports = function setupGame({ getWin, send, settings, saveSettings, sensors, win: winCtl, getStats }) {
  const G = settings.game = Object.assign({
    auto: true, corner: 'tr', fade: 0, hold: 1000, // hold — сколько держать курсор на плашке, чтобы открыть панель (0 — выкл) // corner: tl / tr / bl / br или tc — «на месте», сверху по центру; fade — прозрачность плашки, %
    show: { fps: true, cpu: true, gpu: true, ram: true, ping: true, clock: true },
    ignore: [], seen: [],
  }, settings.game || {});
  G.show = Object.assign({ fps: true, cpu: true, gpu: true, ram: true, ping: true, clock: true }, G.show || {});

  let active = null;          // { pid, exe, name, mon, manual }
  let panelOpen = false;     // панель открыта поверх игры — плашку не возвращаем, пока её не закроют
  let suspendedExe = '';      // пользователь вышел из режима вручную — не включаем снова для этой игры, пока она на экране
  let seenCount = 0, missCount = 0, candidate = null;
  let timer = 0, statT = 0;
  const gpuAgent = new Agent('game');
  const stats = { fps: null, fpsState: 'off', gpu: null, ping: null };

  const exeName = (p) => path.basename(p || '').replace(/\.exe$/i, '');
  const ignored = (exe) => NOT_GAMES.test(exe) || G.ignore.some((x) => x.toLowerCase() === exe.toLowerCase());
  const toDip = (r) => { try { return screen.screenToDipRect(null, r); } catch { return r; } };

  // ---------- распознавание ----------
  async function poll() {
    if (!G.auto && !(active && active.manual)) { if (active && !active.manual) exit(); return; }
    let raw = '';
    try { raw = String(await sensors.call('gamestate', '', 2000) || ''); } catch {}
    const [full, , exe, pid, mon] = raw.split('|');
    const isGame = full === '1' && exe && !ignored(exe);
    if (active) {
      if (active.manual) return;
      const same = exe && exe.toLowerCase() === active.exe.toLowerCase() && full === '1';
      missCount = same ? 0 : missCount + 1;
      if (missCount >= 3) exit();             // ~6 с без игры на экране — выходим
      return;
    }
    if (panelOpen) { seenCount = 0; return; }
    if (suspendedExe && exe && exe.toLowerCase() !== suspendedExe.toLowerCase()) suspendedExe = '';
    if (!isGame || (suspendedExe && exe.toLowerCase() === suspendedExe.toLowerCase())) { seenCount = 0; candidate = null; return; }
    if (candidate !== exe) { candidate = exe; seenCount = 0; }
    if (++seenCount < 2) return;               // два опроса подряд — не случайное окно
    const [x, y, w, h] = (mon || '').split(',').map(Number);
    enter({ pid: +pid, exe, name: exeName(exe), mon: toDip({ x, y, width: w, height: h }) });
  }
  function schedule() { clearInterval(timer); timer = setInterval(poll, 2000); }

  // ---------- вход / выход ----------
  function enter(g) {
    if (active) return;
    active = g;
    missCount = 0;
    if (!g.manual) {
      const k = g.exe.toLowerCase();
      G.seen = [g.exe, ...G.seen.filter((x) => x.toLowerCase() !== k)].slice(0, 12);
      saveSettings();
    }
    winCtl.stage(g.mon);
    send('game', { phase: 'enter', corner: G.corner, fade: G.fade, hold: G.hold, show: G.show, name: g.name, w: g.mon.width, h: g.mon.height });
    startStats(g);
  }
  function exit(after) {
    if (!active) { if (after) after(); return; }
    const g = active;
    active = null;
    stopStats();
    lastMon = g.mon;
    exitDone = after || null;
    // интерфейс сначала ставит плашку в нужную точку, потом просит «сцену» (game-stage) и плывёт наверх
    send('game', { phase: 'exit', corner: G.corner, w: g.mon.width, h: g.mon.height });
  }
  let exitDone = null, lastMon = null;

  // ---------- показатели ----------
  let pm = null, pmBuf = '', pmCols = null, frames = [];
  function presentMonPath() {
    const p = app.isPackaged ? path.join(process.resourcesPath, 'presentmon', 'PresentMon.exe') : path.join(__dirname, '..', 'vendor', 'presentmon', 'PresentMon.exe');
    return fs.existsSync(p) ? p : '';
  }
  function startFps(pid) {
    stopFps();
    const exe = presentMonPath();
    if (!exe || !G.show.fps || !pid) { stats.fpsState = exe ? 'off' : 'missing'; return; }
    stats.fpsState = 'starting';
    pm = spawn(exe, ['--process_id', String(pid), '--output_stdout', '--no_console_stats', '--v2_metrics',
      '--session_name', 'BarFPS', '--stop_existing_session', '--terminate_on_proc_exit',
      '--no_track_input', '--no_track_gpu'], { windowsHide: true });
    pmBuf = ''; pmCols = null; frames = [];
    // PresentMon пишет CSV в UTF-16 (с BOM) — кодировку определяем по первым байтам
    let enc = null;
    pm.stdout.on('data', (chunk) => {
      if (!enc) enc = (chunk[0] === 0xff && chunk[1] === 0xfe) || chunk[1] === 0 ? 'utf16le' : 'utf8';
      pmBuf += chunk.toString(enc).replace(/^﻿/, '');
      let i;
      while ((i = pmBuf.indexOf('\n')) >= 0) {
        const line = pmBuf.slice(0, i).trim(); pmBuf = pmBuf.slice(i + 1);
        if (!line) continue;
        const c = line.split(',');
        if (!pmCols) { pmCols = c; continue; }
        const k = pmCols.indexOf('FrameTime') >= 0 ? pmCols.indexOf('FrameTime') : pmCols.indexOf('MsBetweenPresents');
        const v = parseFloat(c[k]);
        if (v > 0 && v < 1000) { frames.push([Date.now(), v]); stats.fpsState = 'ok'; }
      }
    });
    let err = '';
    pm.stderr.on('data', (d) => { err += d; if (/access denied/i.test(err)) stats.fpsState = 'denied'; });
    pm.on('exit', () => { pm = null; if (stats.fpsState === 'starting') stats.fpsState = /access denied/i.test(err) ? 'denied' : 'off'; });
  }
  function stopFps() {
    if (pm) { try { execFile('taskkill', ['/PID', String(pm.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch {} pm = null; }
    frames = []; stats.fps = null;
  }
  function fpsNow() {
    const now = Date.now();
    frames = frames.filter((f) => now - f[0] < 1000);
    if (!frames.length) return null;
    const avg = frames.reduce((s, f) => s + f[1], 0) / frames.length;
    return Math.round(1000 / avg);
  }
  function ping() {
    return new Promise((resolve) => {
      const t0 = process.hrtime.bigint();
      const s = net.connect({ host: '1.1.1.1', port: 443, timeout: 1500 });
      const done = (v) => { s.destroy(); resolve(v); };
      s.once('connect', () => done(Math.max(1, Math.round(Number(process.hrtime.bigint() - t0) / 1e6))));
      s.once('timeout', () => done(null)); s.once('error', () => done(null));
    });
  }
  let pingT = 0, gpuBusy = false, cpuPrev = null;
  function startStats(g) {
    startFps(g.pid);
    clearInterval(statT); clearInterval(pingT);
    const push = async () => {
      if (G.show.gpu && !gpuBusy) { gpuBusy = true; gpuAgent.call('gpu', '', 8000).then((v) => { stats.gpu = typeof v === 'number' ? v : null; }).catch(() => {}).finally(() => { gpuBusy = false; }); }
      stats.fps = fpsNow();
      // процессор — тот же подсчёт, что у показателя CPU в шапке
      let cpu = null; try { cpu = getStats().cpu; } catch {}
      send('game-stats', {
        fps: stats.fps, fpsState: stats.fpsState, gpu: stats.gpu, ping: stats.ping, cpu,
        ram: Math.round((1 - os.freemem() / os.totalmem()) * 100),
      });
    };
    push();
    statT = setInterval(push, 1000);
    if (G.show.ping) { const p = async () => { stats.ping = await ping(); }; p(); pingT = setInterval(p, 3000); }
  }
  function stopStats() { clearInterval(statT); clearInterval(pingT); stopFps(); gpuAgent.stop(); stats.gpu = null; stats.ping = null; }

  // ---------- IPC ----------
  ipcMain.handle('game-dock', (_e, r) => { if (active) winCtl.hud(active.mon, r, G.hold > 0); return !!active; });
  // открыть панель поверх игры (удержание курсора на плашке или Win+Shift+B); после закрытия — снова плашка
  function openPanel() {
    if (!active) return;
    panelOpen = true;
    exit(() => { send('toggle'); const w = getWin(); if (w) w.focus(); });
  }
  ipcMain.on('game-open-panel', openPanel);
  // панель свернули — через пару секунд, если игра всё ещё на экране, нотч вернётся в плашку
  ipcMain.on('panel-state', (_e, open) => { if (open) return; if (panelOpen) { panelOpen = false; seenCount = 1; } });
  ipcMain.handle('game-stage', () => { const m = active ? active.mon : lastMon; if (m) winCtl.stage(m); return !!m; });
  ipcMain.on('game-exit-done', () => { winCtl.pill(); const f = exitDone; exitDone = null; if (f) f(); });
  ipcMain.handle('game-get', async () => ({ ...G, active: active ? { name: active.name, manual: !!active.manual } : null, presentmon: !!presentMonPath(), perm: await fpsPermission() }));
  ipcMain.handle('game-set', (_e, patch) => {
    for (const k of ['auto', 'corner', 'fade', 'hold']) if (k in patch) G[k] = patch[k];
    G.hold = [0, 500, 1000, 2000].includes(+G.hold) ? +G.hold : 1000;
    if (!['tl', 'tr', 'bl', 'br', 'tc'].includes(G.corner)) G.corner = 'tr';
    G.fade = [0, 40, 60].includes(+G.fade) ? +G.fade : 0;
    if (patch.show) G.show = Object.assign(G.show, patch.show);
    if (Array.isArray(patch.ignore)) G.ignore = patch.ignore.filter((x) => typeof x === 'string').slice(0, 50);
    saveSettings();
    if (active) { send('game', { phase: 'update', corner: G.corner, fade: G.fade, hold: G.hold, show: G.show, w: active.mon.width, h: active.mon.height }); }
    return true;
  });
  ipcMain.handle('game-preview', () => {
    if (active) { exit(); return false; }
    const d = screen.getPrimaryDisplay();
    enter({ pid: 0, exe: 'preview', name: 'Предпросмотр', mon: d.bounds, manual: true });
    setTimeout(() => { if (active && active.exe === 'preview') exit(); }, 6000);
    return true;
  });
  // FPS: Windows разрешает читать кадры чужих программ администраторам и группе «Пользователи журналов производительности» (S-1-5-32-559)
  function fpsPermission() {
    // группы текущего входа (токен): есть S-1-5-32-559 — доступ работает; только в списке группы — нужна перезагрузка
    const ps = "$me=[Security.Principal.WindowsIdentity]::GetCurrent(); if ($me.Groups | Where-Object { $_.Value -eq 'S-1-5-32-559' }) { 'ok' } " +
      "elseif (Get-LocalGroupMember -SID S-1-5-32-559 -ErrorAction SilentlyContinue | Where-Object { $_.SID -eq $me.User }) { 'relogin' } else { 'no' }";
    return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 10000 },
      (e, out) => { const m = String(out || '').match(/ok|relogin|no/); resolve(m ? m[0] : 'no'); }));
  }
  ipcMain.handle('game-perm', () => new Promise((resolve) => {
    // Один раз: Windows спросит подтверждение (UAC). Добавляем именно текущую учётную запись по её SID.
    const sid = require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { windowsHide: true, encoding: 'utf8' }).trim();
    if (!/^S-1-5-[\d-]+$/.test(sid)) return resolve('error');
    const inner = `Add-LocalGroupMember -SID S-1-5-32-559 -Member '${sid}'`;
    const enc = Buffer.from(inner, 'utf16le').toString('base64');
    const outer = `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${enc}'`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outer], { windowsHide: true }, async () => resolve(await fpsPermission()));
  }));

  schedule();
  return {
    isActive: () => !!active,
    // горячая клавиша игрового режима: включить вручную / выйти
    hotkey() {
      if (active) { suspendedExe = active.manual ? '' : active.exe; exit(); return; }
      sensors.call('gamestate', '', 2000).then((raw) => {
        const [, , exe, pid, mon] = String(raw || '').split('|');
        const [x, y, w, h] = (mon || '').split(',').map(Number);
        const m = w ? toDip({ x, y, width: w, height: h }) : screen.getPrimaryDisplay().bounds;
        enter({ pid: +pid || 0, exe: exe || 'manual', name: exeName(exe) || 'Игра', mon: m, manual: true });
      }).catch(() => {});
    },
    // открыть обычную панель поверх игры: сначала вернуться наверх
    openPanel,
    leave(after) { if (active) { suspendedExe = active.manual ? '' : active.exe; exit(after); } else if (after) after(); },
    stop() { clearInterval(timer); stopStats(); },
  };
};
