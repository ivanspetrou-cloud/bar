// Показатели (раскладка, звук, трек, сеть, Bluetooth, нагрузка) и управление приложениями.
// Опрос идёт ТОЛЬКО того, что включено в настройках, и реже, когда нотч свёрнут.
const { ipcMain, app, shell, Menu, powerSaveBlocker, powerMonitor, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const Agent = require('./agent-host');

module.exports = function setupSensors({ send, getWin, getStats }) {
  const fast = new Agent('fast'); // быстрые запросы: раскладка, звук, трек, окна
  const slow = new Agent('slow');
  const finder = new Agent('search'); // поиск файлов: свой процесс, чтобы не ждать опрос Bluetooth // медленные: Bluetooth (~9 с), сеть, список приложений
  const safe = (p) => p.catch(() => undefined);

  // ---------- расписание опроса ----------
  let need = {};
  const timers = {};
  const periods = {};
  function every(key, ms, fn) {
    if (periods[key] === ms) return;
    clearInterval(timers[key]);
    periods[key] = ms;
    if (!ms) return;
    fn();
    timers[key] = setInterval(fn, ms);
  }

  let lastNet = null;
  const poll = {
    layout: async () => { const v = await safe(fast.call('layout', '', 3000)); if (v !== undefined) send('sensors', { layout: v }); },
    audio: async () => { const v = await safe(fast.call('audio', '', 4000)); if (v) send('sensors', { audio: v }); },
    media: async () => { const v = await safe(fast.call('media', '', 6000)); if (v !== undefined) send('sensors', { media: v || null }); },
    net: async () => {
      const n = await safe(slow.call('net', '', 10000)); if (!n) return;
      const now = Date.now();
      let rxs = 0, txs = 0;
      if (lastNet) { const dt = (now - lastNet.t) / 1000; rxs = Math.max(0, (n.rx - lastNet.rx) / dt); txs = Math.max(0, (n.tx - lastNet.tx) / dt); }
      lastNet = { t: now, rx: n.rx, tx: n.tx };
      send('sensors', { net: { ...n, rxs, txs } });
    },
    bt: async () => { const v = await safe(slow.call('bt', '', 40000)); if (v !== undefined) send('sensors', { bt: Agent.list(v) }); },
    hid: async () => { const v = await safe(slow.call('hidbat', '', 15000)); if (v !== undefined) send('sensors', { hid: Agent.list(v) }); },
    stats: async () => { send('sensors', { stats: await getStats() }); },
  };

  function schedule() {
    const open = !!need.open;
    // свёрнутый нотч опрашивает реже: раскладку — раз в 1,5 с, звук и трек — раз в 5–6 с
    every('layout', need.layout ? (open ? 700 : 1500) : 0, poll.layout);
    every('audio', need.audio || open ? (open ? 1500 : 6000) : 0, poll.audio);
    every('media', need.media || open ? (open ? 1500 : 5000) : 0, poll.media);
    every('net', need.net ? (open ? 2000 : 8000) : 0, poll.net);
    every('hid', need.bt || open ? 60000 : 0, poll.hid);
    every('bt', need.bt || open ? 120000 : 0, poll.bt);
    every('stats', need.stats || open ? (open ? 2000 : 6000) : 0, poll.stats);
    // агенты PowerShell раз в 5 минут возвращают Windows неиспользуемую память (рабочий набор ~200 → ~20 МБ)
    every('trim', 5 * 60e3, trimAgents);
  }
  function trimAgents() { for (const ag of [fast, slow, finder]) if (ag.ps) safe(ag.call('trim', '', 5000)); }
  ipcMain.on('sensors-need', (_e, n) => { need = n || {}; schedule(); });
  ipcMain.on('sensors-refresh', (_e, key) => poll[key] && poll[key]());

  // ---------- звук и медиа ----------
  ipcMain.handle('audio-set', async (_e, p) => {
    try {
      if ('volume' in p) await fast.call('setvol', Math.round(p.volume));
      if ('mute' in p) await fast.call('mute', p.mute ? 1 : 0);
      if ('mic' in p) await fast.call('micmute', p.mic ? 1 : 0);
    } catch {}
    poll.audio();
  });
  ipcMain.handle('media-ctl', async (_e, k) => {
    const ok = await safe(fast.call('mediactl', k, 4000));
    setTimeout(poll.media, 350);
    return !!ok;
  });

  // ---------- приложения ----------
  let appsCache = null, appsAt = 0;
  function scanLnk() {
    const roots = [
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    ];
    const map = new Map();
    const walk = (dir, depth) => {
      let list = [];
      try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of list) {
        const p = path.join(dir, d.name);
        if (d.isDirectory() && depth < 4) walk(p, depth + 1);
        else if (d.name.toLowerCase().endsWith('.lnk')) {
          let target = '';
          try { target = shell.readShortcutLink(p).target || ''; } catch {}
          const key = d.name.slice(0, -4).toLowerCase();
          if (!map.has(key)) map.set(key, { lnk: p, target });
        }
      }
    };
    roots.forEach((r) => walk(r, 0));
    return map;
  }
  async function listApps(force) {
    if (appsCache && !force && Date.now() - appsAt < 10 * 60e3) return appsCache;
    const raw = Agent.list(await slow.call('startapps', '', 30000));
    const lnks = scanLnk();
    const seen = new Set();
    const apps = [];
    for (const line of raw) {
      const i = line.indexOf('|');
      const name = line.slice(0, i).replace(/^[«"]|[»"]$/g, '').trim();
      const id = line.slice(i + 1).trim();
      if (!name || !id || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const l = lnks.get(line.slice(0, i).toLowerCase()) || lnks.get(name.toLowerCase());
      const exe = /^[a-z]:\\/i.test(id) ? id : (l && /\.exe$/i.test(l.target) ? l.target : '');
      apps.push({ id, name, lnk: l ? l.lnk : '', exe, uwp: id.includes('!') ? id.split('!')[0] : '' });
    }
    apps.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    appsCache = apps; appsAt = Date.now();
    return apps;
  }
  ipcMain.handle('apps-list', (_e, force) => listApps(force).catch(() => []));

  // Подсказки для дока: что вы реально часто запускаете (счётчики Windows), сопоставленное со списком «Пуска».
  // Данные читаются локально и никуда не отправляются.
  const KNOWN = {
    '{6d809377-6af0-444b-8957-a3773f02200e}': process.env.ProgramW6432 || process.env.ProgramFiles || '',
    '{7c5a40ef-a0fb-4bfc-874a-c0f2e0b9fa8e}': process.env['ProgramFiles(x86)'] || '',
    '{1ac14e77-02e7-4e5d-b744-2eb1ae5198b7}': path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
    '{f38bf404-1d43-42f2-9305-67de0b28fc23}': process.env.SystemRoot || '',
  };
  let usageCache = null, usageAt = 0;
  // Своё наблюдение: раз в 10 секунд — какая программа на экране, пока вы за компьютером.
  // Счётчики Windows видят только запуски из «Пуска», а Telegram, Steam и оверлеи часто стартуют сами.
  // Хранится только «путь к exe → минуты» в папке данных Bar (usage.json), с затуханием за ~неделю, никуда не отправляется.
  const FG_FILE = path.join(app.getPath('userData'), 'usage.json');
  let fg = {};
  try { fg = JSON.parse(fs.readFileSync(FG_FILE, 'utf8')) || {}; } catch {}
  let fgDirty = false;
  const SKIP_EXE = /\\windows\\|\\(explorer|applicationframehost|searchhost|searchapp|shellexperiencehost|startmenuexperiencehost|lockapp|textinputhost|systemsettings|taskmgr|electron)\.exe$/i;
  const own = process.execPath.toLowerCase();
  const decay = (e, now) => { const d = (now - (e.t || now)) / 86400e3; e.m *= Math.pow(0.5, d / 7); e.t = now; };
  async function fgTick() {
    if (powerMonitor.getSystemIdleTime() > 120) return; // отошли от компьютера — не считаем
    const exe = await safe(fast.call('fg', '', 2000));
    if (!exe || typeof exe !== 'string' || exe.toLowerCase() === own || SKIP_EXE.test(exe)) return;
    const k = exe.toLowerCase(), now = Date.now();
    const e = fg[k] || (fg[k] = { m: 0, t: now, exe });
    decay(e, now); e.m += 10 / 60; fgDirty = true;
  }
  const fgT = setInterval(fgTick, 10000);
  const fgSave = setInterval(() => {
    if (!fgDirty) return; fgDirty = false;
    const now = Date.now();
    for (const [k, e] of Object.entries(fg)) { decay(e, now); if (e.m < 0.5) delete fg[k]; } // забытое выкидываем
    try { fs.writeFileSync(FG_FILE, JSON.stringify(fg)); } catch {}
  }, 120000);

  ipcMain.handle('app-usage', async () => {
    if (usageCache && Date.now() - usageAt < 5 * 60e3) return usageCache;
    const [apps, rows] = await Promise.all([listApps().catch(() => []), safe(slow.call('usage', '', 15000))]);
    const use = new Map();
    const now = Date.now();
    for (const e of Object.values(fg)) { const c = { ...e }; decay(c, now); use.set(e.exe.toLowerCase(), (use.get(e.exe.toLowerCase()) || 0) + c.m * 2); }
    for (const r of Agent.list(rows)) {
      const p = String(r).split('|');
      if (p.length < 4) continue;
      let name = p[0].toLowerCase();
      const g = name.match(/^\{[0-9a-f-]+\}/);
      if (g && KNOWN[g[0]]) name = (KNOWN[g[0]] + name.slice(g[0].length)).toLowerCase();
      const runs = +p[1] || 0, focus = +p[2] || 0, last = +p[3] || 0;
      const age = last ? (Date.now() - last) / 86400e3 : 999;
      const fresh = age < 7 ? 1 : age < 30 ? 0.5 : age < 999 ? 0.2 : 0.3;
      // главное — сколько минут программа была на экране; запуски — с затуханием (Ножницы и Game Bar вызывают сочетаниями)
      const score = (focus / 60000 + 4 * Math.log2(1 + runs) * (focus > 0 ? 1 : 0.25)) * fresh;
      if (score > 0) use.set(name, (use.get(name) || 0) + score);
    }
    const out = [];
    const matched = new Set();
    for (const a of apps) {
      if (/bar\.notch|ScreenSketch|XboxGamingOverlay|immersivecontrolpanel|Windows\.Explorer|SecHealthUI/i.test(a.id)) continue;
      const ex = a.exe ? a.exe.toLowerCase() : '';
      const s = (use.get(a.id.toLowerCase()) || 0) + (ex ? use.get(ex) || 0 : 0);
      if (ex) matched.add(ex);
      if (s >= 3) out.push({ app: a, score: Math.round(s) });
    }
    // программы, которых нет в «Пуске» (например, XT Tarkov Overlay): запуск по exe
    for (const [k, s] of use) {
      if (s < 3 || matched.has(k) || !/^[a-z]:\\.+\.exe$/i.test(k) || SKIP_EXE.test(k) || k === own || /\\(steamapps|temp)\\|unins|setup|crashreport|launcher_be|_be\.exe$/i.test(k)) continue;
      const exe = (fg[k] && fg[k].exe) || k;
      if (!fs.existsSync(exe)) continue;
      const base = path.basename(exe, path.extname(exe));
      out.push({ app: { id: 'exe:' + exe, name: base.charAt(0).toUpperCase() + base.slice(1), exe, lnk: '', uwp: '' }, score: Math.round(s) });
    }
    out.sort((x, y) => y.score - x.score);
    usageCache = out.slice(0, 24); usageAt = Date.now();
    setTimeout(trimAgents, 2000);
    return usageCache;
  });

  const iconCache = new Map();
  // Стандартная заглушка Windows «программа без иконки» — её получаем у пустого .exe и не показываем
  let generic = null;
  async function genericIcon() {
    if (generic !== null) return generic;
    const f = path.join(app.getPath('temp'), 'bar-noicon.exe');
    try { fs.writeFileSync(f, ''); generic = (await app.getFileIcon(f, { size: 'large' })).toDataURL(); } catch { generic = ''; }
    try { fs.unlinkSync(f); } catch {}
    return generic;
  }
  // Electron-программы без иконки в exe (как Overplus): логотип внутри их app.asar
  function asarLogo(exe) {
    const asar = path.join(path.dirname(exe), 'resources', 'app.asar');
    if (!fs.existsSync(asar)) return null;
    const found = [];
    const walk = (d, depth) => {
      let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (depth < 4 && !/^(node_modules|locales|\.)/.test(e.name)) walk(p, depth + 1); }
        else if (/\.(png|ico)$/i.test(e.name) && /icon|logo/i.test(e.name) && !/error|success|warn|tab|news|card|categor|type|small|tray|mono|white|black|dark|light|button|badge/i.test(e.name)) found.push(p);
      }
    };
    walk(asar, 0);
    let best = null, bestScore = 0;
    for (const p of found) {
      try {
        const img = nativeImage.createFromBuffer(fs.readFileSync(p)); if (img.isEmpty()) continue; // createFromPath не читает внутри чужого asar
        const { width, height } = img.getSize();
        if (width < 64 || Math.abs(width - height) > width * 0.1) continue; // только квадратные и не мелкие
        const s = Math.min(width, 256) + (/icon/i.test(path.basename(p)) ? 50 : 0);
        if (s > bestScore) { bestScore = s; best = img; }
      } catch {}
    }
    return best ? best.resize({ width: 64, height: 64, quality: 'best' }).toDataURL() : null;
  }
  // иконки, снятые с окон запущенных программ, — на диске, чтобы были и после закрытия программы
  const ICON_DIR = path.join(app.getPath('userData'), 'icons');
  const iconFile = (exe) => path.join(ICON_DIR, require('crypto').createHash('sha1').update(exe.toLowerCase()).digest('hex').slice(0, 16) + '.png');

  ipcMain.handle('app-icon', async (_e, a) => {
    const key = a.id || a.exe;
    if (iconCache.has(key)) return iconCache.get(key);
    let url = null;
    for (const f of [a.exe, a.lnk]) {
      if (!f || !fs.existsSync(f)) continue;
      try { const img = await app.getFileIcon(f, { size: 'large' }); if (!img.isEmpty()) { url = img.toDataURL(); break; } } catch {}
    }
    let exe = a.exe;
    if (!exe && a.lnk) { try { const t = shell.readShortcutLink(a.lnk).target; if (/\.exe$/i.test(t)) exe = t; } catch {} }
    if (url && url === await genericIcon()) {
      url = null;
      if (exe) {
        try { if (fs.existsSync(iconFile(exe))) url = 'data:image/png;base64,' + fs.readFileSync(iconFile(exe)).toString('base64'); } catch {}
        if (!url) url = asarLogo(exe);
        if (!url) {
          const b64 = await safe(fast.call('winicon', exe, 4000));
          if (b64 && typeof b64 === 'string') {
            url = 'data:image/png;base64,' + b64;
            try { fs.mkdirSync(ICON_DIR, { recursive: true }); fs.writeFileSync(iconFile(exe), Buffer.from(b64, 'base64')); } catch {}
          }
        }
      }
    }
    // приложения из Microsoft Store: логотип из манифеста пакета
    const m = (a.exe || '').match(/\\WindowsApps\\([^\\]+?)_[\d.]+_[^_]*__([a-z0-9]+)\\/i);
    const fam = a.uwp || (m ? m[1] + '_' + m[2] : '');
    if (!url && fam) {
      const logo = await safe(fast.call('appxlogo', fam, 8000));
      if (logo && fs.existsSync(logo)) { try { url = 'data:image/png;base64,' + fs.readFileSync(logo).toString('base64'); } catch {} }
    }
    iconCache.set(key, url);
    if (!url) setTimeout(() => iconCache.delete(key), 60e3); // программу могут запустить — тогда возьмём иконку с окна
    return url;
  });

  ipcMain.handle('app-launch', (_e, a) => {
    if (a.id && !a.id.startsWith('exe:')) {
      spawn('explorer.exe', ['shell:AppsFolder\\' + a.id], { detached: true, stdio: 'ignore' }).unref();
    } else if (a.exe) {
      shell.openPath(a.exe);
    }
    return true;
  });

  ipcMain.handle('windows', async () => {
    const own = process.execPath.toLowerCase();
    const rows = Agent.list(await safe(fast.call('windows', '', 3000)));
    const groups = new Map();
    for (const r of rows) {
      const [hwnd, pid, exe] = String(r).split('|');
      if (!exe || exe.toLowerCase() === own) continue;
      const k = exe.toLowerCase();
      if (!groups.has(k)) groups.set(k, { exe, name: path.basename(exe, '.exe'), windows: [] });
      groups.get(k).windows.push({ hwnd: Number(hwnd), pid: Number(pid) });
    }
    return [...groups.values()];
  });
  // поиск файлов в индексе Windows — только имена и пути, всё остаётся на компьютере
  let finderIdle = 0;
  ipcMain.handle('find-files', async (_e, q) => {
    q = String(q || '').trim().slice(0, 120);
    if (q.length < 2) return [];
    const rows = Agent.list(await safe(finder.call('findfiles', Buffer.from(q, 'utf8').toString('base64'), 4000)));
    // процесс поиска живёт, пока им пользуются: минута тишины — и он закрывается
    clearTimeout(finderIdle); finderIdle = setTimeout(() => finder.stop(), 60e3);
    return rows.map((r) => {
      const s = String(r); const i = s.lastIndexOf('|');
      const p = s.slice(0, i), type = s.slice(i + 1);
      return { path: p, name: path.basename(p), dir: path.dirname(p), isDir: type === 'Directory' };
    });
  });
  // раскладки клавиатуры: список установленных и ручное переключение
  ipcMain.handle('layouts', async () => Agent.list(await safe(fast.call('layouts', '', 3000))).map((r) => {
    const [hkl, lang, name, cur] = String(r).split('|');
    return { hkl, lang, name, current: cur === '1' };
  }));
  ipcMain.handle('set-layout', async (_e, hkl) => {
    if (!/^-?\d+$/.test(String(hkl))) return null;
    const v = await safe(fast.call('setlayout', String(hkl), 3000));
    setTimeout(poll.layout, 150);
    return v;
  });
  ipcMain.handle('win-focus', (_e, hwnd) => safe(fast.call('focus', hwnd)));
  ipcMain.handle('win-min', (_e, hwnd) => safe(fast.call('minimize', hwnd)));
  ipcMain.handle('win-close', (_e, pid) => safe(fast.call('close', pid)));

  ipcMain.handle('popup-menu', (_e, items) => new Promise((resolve) => {
    let picked = null;
    const menu = Menu.buildFromTemplate(items.map((it) => it.sep ? { type: 'separator' } : {
      label: it.label, enabled: it.enabled !== false, click: () => { picked = it.id; },
      ...(it.checked !== undefined ? { type: 'radio', checked: !!it.checked } : {}),
    }));
    menu.popup({ window: getWin(), callback: () => setTimeout(() => resolve(picked), 0) });
  }));

  // ---------- быстрые переключатели ----------
  ipcMain.handle('taskbar', (_e, on) => safe(on === undefined ? fast.call('taskbar') : fast.call('settaskbar', on ? 1 : 0)));
  let awakeId = null;
  ipcMain.handle('keep-awake', (_e, on) => {
    if (on && awakeId === null) awakeId = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
    return awakeId !== null;
  });
  const THEME_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';
  ipcMain.handle('win-theme', (_e, light) => new Promise((resolve) => {
    if (light === undefined) {
      execFile('reg', ['query', THEME_KEY, '/v', 'AppsUseLightTheme'], { windowsHide: true }, (err, out) => {
        resolve(err ? null : /0x1\s*$/m.test(out));
      });
      return;
    }
    const v = light ? '1' : '0';
    execFile('reg', ['add', THEME_KEY, '/v', 'AppsUseLightTheme', '/t', 'REG_DWORD', '/d', v, '/f'], { windowsHide: true }, () => {
      execFile('reg', ['add', THEME_KEY, '/v', 'SystemUsesLightTheme', '/t', 'REG_DWORD', '/d', v, '/f'], { windowsHide: true }, () => resolve(light));
    });
  }));

  return {
    call: (cmd, arg, ms) => fast.call(cmd, arg, ms),
    listApps,
    stop() { clearInterval(fgT); clearInterval(fgSave); try { fs.writeFileSync(FG_FILE, JSON.stringify(fg)); } catch {} Object.values(timers).forEach(clearInterval); fast.stop(); slow.stop(); finder.stop(); if (awakeId !== null) powerSaveBlocker.stop(awakeId); },
  };
};
