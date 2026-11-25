// Показатели (раскладка, звук, трек, сеть, Bluetooth, нагрузка) и управление приложениями.
// Опрос идёт ТОЛЬКО того, что включено в настройках, и реже, когда нотч свёрнут.
const { ipcMain, app, shell, Menu, BrowserWindow, powerSaveBlocker, powerMonitor, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const Agent = require('./agent-host');

module.exports = function setupSensors({ send, getWin, getStats, getMicDev = () => '' }) {
  const micDev = () => String(getMicDev() || '').replace(/\s/g, ''); // выбранный микрофон (id устройства) или '' — как в Windows
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
    audio: async () => { const v = await safe(fast.call('audio', micDev(), 4000)); if (v) send('sensors', { audio: v }); },
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
    hid: async () => {
      const v = await safe(slow.call('hidbat', '', 15000)); if (v === undefined) return;
      const list = Agent.list(v);
      const g = await g435Line();
      if (g) list.push(g);
      send('sensors', { hid: list });
    },
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
  }
  // ---------- всплывашка громкости: отдельный агент ждёт изменения звука внутри своего процесса ----------
  const watcher = new Agent('watch');
  const aw = { v: -1, m: 0, mm: 0, on: false };
  async function watchLoop() {
    if (aw.on) return;
    aw.on = true;
    while (aw.on && need.osd) {
      let r;
      try { r = await watcher.call('waitaudio', `${aw.v} ${aw.m} ${aw.mm} 25000 ${micDev()}`.trim(), 30000); }
      catch { await new Promise((res) => setTimeout(res, 2000)); continue; }
      if (!r || !aw.on) continue;
      const [v, m, hasMic, mm] = String(r).split('|').map(Number);
      const first = aw.v < 0;
      const changed = !first && (v !== aw.v || m !== aw.m || mm !== aw.mm);
      const what = !changed ? '' : mm !== aw.mm ? 'mic' : m !== aw.m ? 'mute' : 'volume';
      Object.assign(aw, { v, m, mm });
      if (first || changed) send('sensors', { audio: { volume: v, muted: !!m, mic: !!hasMic, micMuted: !!mm }, ...(what ? { osd: what } : {}) });
    }
    aw.on = false;
  }
  function watchSet(on) {
    if (on) { watchLoop(); return; }
    aw.on = false; aw.v = -1; watcher.stop();
  }

  // ---------- «живой» эквалайзер: отдельный маленький процесс (bar-agent.exe meter) печатает уровень звука ----------
  let meterPs = null, meterBuf = [], meterT = 0;
  function meterStop() { clearInterval(meterT); meterBuf = []; if (meterPs) { try { meterPs.kill(); } catch {} meterPs = null; } }
  ipcMain.on('meter', (_e, on) => {
    if (!on) return meterStop();
    if (meterPs) return;
    meterPs = Agent.spawnHelper('meter');
    if (!meterPs) return;
    let buf = '';
    meterPs.stdout.setEncoding('utf8');
    meterPs.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l.startsWith('M ')) meterBuf.push(parseFloat(l.slice(2)) || 0); }
    });
    meterPs.on('exit', () => { meterPs = null; });
    meterPs.on('error', () => { meterPs = null; });
    // в окно — пачками ~11 раз в секунду
    meterT = setInterval(() => { if (meterBuf.length) { send('meter', meterBuf); meterBuf = []; } }, 90);
  });

  ipcMain.on('sensors-need', (_e, n) => { need = n || {}; schedule(); watchSet(!!need.osd); });
  ipcMain.on('sensors-refresh', (_e, key) => poll[key] && poll[key]());

  // ---------- звук и медиа ----------
  // микрофоны для выбора в настройках: { id, name, def, comm }
  ipcMain.handle('mic-list', async () => Agent.list(await safe(fast.call('mics', '', 4000))).map((r) => { const [id, name, def, comm] = String(r).split('|'); return { id, name, def: def === '1', comm: comm === '1' }; }));
  ipcMain.handle('audio-set', async (_e, p) => {
    try {
      if ('volume' in p) await fast.call('setvol', Math.round(p.volume));
      if ('mute' in p) await fast.call('mute', p.mute ? 1 : 0);
      if ('mic' in p) await fast.call('micmute', `${p.mic ? 1 : 0} ${micDev()}`.trim());
    } catch {}
    poll.audio();
  });
  ipcMain.handle('media-ctl', async (_e, k) => {
    const ok = await safe(fast.call('mediactl', k, 4000));
    setTimeout(poll.media, 350);
    return !!ok;
  });

  // ---------- веб-камера: поворот, наклон, зум, фокус, приватность (UVC) ----------
  ipcMain.handle('cam-list', async () => Agent.list(await safe(fast.call('camlist', '', 8000))).map((r) => {
    const [i, name, props, ctl] = String(r).split('|');
    const p = {};
    for (const x of (props || '').split(',').filter(Boolean)) {
      const [id, min, max, step, def, cur, auto, canAuto] = x.split(':').map(Number);
      p[id] = { min, max, step: step || 1, def, cur, auto: !!auto, canAuto: !!canAuto };
    }
    return { i: +i, name, props: p, ctl: ctl === '1' };
  }));
  ipcMain.handle('cam-set', async (_e, dev, prop, val, auto) => {
    if (![dev, prop, val].every(Number.isFinite)) return null;
    return safe(fast.call('camset', [dev | 0, prop | 0, Math.round(val), auto ? 1 : 0].join(' '), 4000));
  });

  // ---------- диагностика устройств (для поддержки новых мышей и клавиатур) ----------
  // ---------- Logitech G435 (донгл 046D:0ACB): чтение заряда на ~1 с прерывает звук гарнитуры ----------
  // Поэтому: раз в час (после неудачи — через 5 мин), не во время игры или полноэкранного видео, и по кнопке в настройках.
  const G435_FILE = path.join(app.getPath('userData'), 'g435.json');
  let g435 = (() => { try { return JSON.parse(fs.readFileSync(G435_FILE, 'utf8')); } catch { return {}; } })(); // { name, mv, t, ok, tried }
  let g435Busy = null;
  const g435Pct = (mv) => {
    const T = [[4200, 100], [4100, 90], [4000, 80], [3900, 65], [3800, 50], [3750, 40], [3700, 30], [3650, 20], [3600, 10], [3500, 5], [3300, 0]];
    if (mv >= T[0][0]) return 100;
    for (let i = 1; i < T.length; i++) if (mv >= T[i][0]) return Math.round(T[i][1] + (mv - T[i][0]) / (T[i - 1][0] - T[i][0]) * (T[i - 1][1] - T[i][1]));
    return 0;
  };
  async function g435Read() {
    if (g435Busy) return g435Busy;
    g435Busy = (async () => {
      g435.tried = Date.now();
      const r = String((await safe(slow.call('g435', '', 8000))) || '');
      const i = r.lastIndexOf('|');
      if (i > 0) {
        const mv = +r.slice(i + 1);
        g435.name = r.slice(0, i);
        if (mv > 0) { g435.mv = mv; g435.t = Date.now(); g435.ok = true; } else g435.ok = false;
        try { fs.writeFileSync(G435_FILE, JSON.stringify(g435)); } catch {}
      }
      g435Busy = null;
      return g435;
    })();
    return g435Busy;
  }
  let g435Has = null, g435HasT = 0;
  async function g435Line() {
    if (Date.now() - g435HasT > 5 * 60e3) { g435HasT = Date.now(); g435Has = !!(await safe(fast.call('g435has', '', 4000))); }
    if (!g435Has) return null;
    const due = !g435.tried || Date.now() - g435.tried > (g435.ok ? 60 * 60e3 : 5 * 60e3);
    if (due) {
      const full = String((await safe(fast.call('gamestate', '', 2000))) || '').split('|')[0] === '1';
      if (!full) await g435Read();
    }
    const name = 'Logitech ' + String(g435.name || 'G435').replace(/\b(wireless|gaming)\b/gi, '').replace(/\s+/g, ' ').trim();
    // последнее удачное чтение моложе 2 часов — гарнитура на связи с этим зарядом; иначе «нет связи» (с последним зарядом)
    if (g435.ok && g435.mv && Date.now() - g435.t < 2 * 60 * 60e3) return `${name}|${g435Pct(g435.mv)}|1|0|headphones`;
    return `${name}|-1|0|0|headphones`;
  }
  ipcMain.handle('g435-read', async () => { await g435Read(); g435HasT = 0; poll.hid(); return { ok: !!g435.ok, level: g435.mv ? g435Pct(g435.mv) : null, has: true }; });
  ipcMain.handle('g435-info', async () => {
    if (g435Has === null) g435Has = !!(await safe(fast.call('g435has', '', 4000)));
    return { has: !!g435Has, t: g435.t || 0, ok: !!g435.ok, level: g435.mv ? g435Pct(g435.mv) : null };
  });

  ipcMain.handle('dev-diag', async () => {
    const [hid, bat] = await Promise.all([safe(slow.call('hiddiag', '', 20000)), safe(slow.call('hidbat', '', 20000))]);
    return ['Bar ' + app.getVersion() + ' — сведения об устройствах', '', '== Заряд ==', ...Agent.list(bat).map(String), '', '== Интерфейсы ==', ...Agent.list(hid).map(String)].join('\n');
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
  // программы, окна которых видел таскбар (exe → { p: путь, t: когда }): для поиска портативных программ
  const SEEN_FILE = path.join(app.getPath('userData'), 'seen-apps.json');
  const SYS_EXE = /\\windows\\|\\windowsapps\\|\\(explorer|applicationframehost|systemsettings|searchhost|shellexperiencehost|startmenuexperiencehost|textinputhost|lockapp|electron|bar|bar lab|powershell|cmd|conhost|windowsterminal|rundll32|dllhost)\.exe$/i;
  let seenApps = {};
  try { seenApps = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')) || {}; } catch {}
  let seenSaveT = 0;
  function noteExe(exe) {
    if (!exe || SYS_EXE.test(exe)) return;
    const k = exe.toLowerCase();
    const isNew = !seenApps[k];
    seenApps[k] = { p: exe, t: Date.now() };
    if (isNew) {
      const keys = Object.keys(seenApps);
      if (keys.length > 300) keys.sort((a, b) => seenApps[a].t - seenApps[b].t).slice(0, keys.length - 300).forEach((x) => delete seenApps[x]);
      appsAt = 0; // новая программа — список пересоберётся при следующем поиске
      clearTimeout(seenSaveT); seenSaveT = setTimeout(() => { try { fs.writeFileSync(SEEN_FILE, JSON.stringify(seenApps)); } catch {} }, 2000);
    }
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
    // + программы без ярлыка в «Пуске» (портативные, распакованные): те, что были открыты или активны
    const have = new Set(apps.map((x) => (x.exe || '').toLowerCase()).filter(Boolean));
    const extra = new Map();
    for (const [k, e] of Object.entries(fg)) extra.set(((e && e.exe) || k).toLowerCase(), (e && e.exe) || k);
    for (const exe of Object.keys(seenApps)) extra.set(exe, seenApps[exe].p);
    // названия программ из свойств файлов (один запрос на все новые, ответ запоминается в seen-apps.json)
    const ask = [...extra.entries()].filter(([k, exe]) => !have.has(k) && !(seenApps[k] && seenApps[k].n !== undefined) && /^[a-z]:\\.+\.exe$/i.test(exe) && !SYS_EXE.test(exe) && fs.existsSync(exe)).map(([, exe]) => exe).slice(0, 40);
    if (ask.length) {
      const rows = Agent.list(await safe(slow.call('exeinfo', Buffer.from(ask.join('|'), 'utf8').toString('base64'), 20000)));
      for (const r of rows) {
        const [p, n, l] = String(r).split('|'); const k = String(p || '').toLowerCase(); if (!k) continue;
        seenApps[k] = { ...(seenApps[k] || { p, t: Date.now() }), n: n || '', l: l || '' };
      }
      try { fs.writeFileSync(SEEN_FILE, JSON.stringify(seenApps)); } catch {}
    }
    for (const [k, exe0] of extra) {
      if (have.has(k) || !/^[a-z]:\\.+\.exe$/i.test(exe0) || SYS_EXE.test(exe0)) continue;
      if (!fs.existsSync(exe0)) continue;
      const info = seenApps[k] || {};
      const exe = info.l && fs.existsSync(info.l) ? info.l : exe0;       // основной запускающий файл, если нашёлся
      if (have.has(exe.toLowerCase())) continue;
      const name = info.n || path.basename(exe, path.extname(exe)).replace(/[-_]+/g, ' ').trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase()); have.add(k);
      apps.push({ id: 'exe:' + exe, name, lnk: '', exe, uwp: '' });
    }
    apps.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    appsCache = apps; appsAt = Date.now();
    return apps;
  }
  ipcMain.handle('apps-list', (_e, force) => listApps(force).catch(() => []));

  // «Система»: сведения о железе (≈4 с, кеш на минуту) и загрузка видеокарты (свой процесс, пока вкладка открыта)
  let hwCache = null, hwAt = 0, hwBusy = null;
  ipcMain.handle('hw-info', () => {
    if (hwCache && Date.now() - hwAt < 60e3) return hwCache;
    if (!hwBusy) hwBusy = safe(slow.call('hwinfo', '', 30000)).then((v) => { if (v) { hwCache = v; hwAt = Date.now(); } hwBusy = null; return hwCache; });
    return hwBusy;
  });
  const gpuAgent = new Agent('gpu');
  let gpuIdle = 0;
  ipcMain.handle('gpu-load', async () => {
    clearTimeout(gpuIdle); gpuIdle = setTimeout(() => gpuAgent.stop(), 20e3);
    const v = await safe(gpuAgent.call('gpu', '', 12000));
    return typeof v === 'number' ? v : null;
  });

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

  // стандартная иконка exe без своей иконки (в том же размере), чтобы не принять её за настоящую
  let shellGen = null;
  const shellGeneric = () => shellGen || (shellGen = (async () => {
    try { fs.mkdirSync(ICON_DIR, { recursive: true }); const f = path.join(ICON_DIR, 'blank.exe'); if (!fs.existsSync(f)) fs.writeFileSync(f, ''); return (await safe(fast.call('fileicon', f, 6000))) || ''; } catch { return ''; }
  })());
  ipcMain.handle('app-icon', async (_e, a) => {
    const key = a.id || a.exe;
    if (iconCache.has(key)) return iconCache.get(key);
    // 1) так, как иконку показывает «Пуск» (shell:AppsFolder\<AppID>) — подходит и обычным программам, и Store-приложениям
    if (a.id && !a.id.startsWith('exe:')) {
      const b64 = await safe(fast.call('appicon', a.id, 8000));
      if (b64 && typeof b64 === 'string' && b64.length > 200) { const u = 'data:image/png;base64,' + b64; iconCache.set(key, u); return u; }
    }
    // 2) запасной путь: exe → иконка, на которую указывает ярлык → сам ярлык; без стандартной заглушки Windows
    let lnkInfo = {};
    if (a.lnk) { try { lnkInfo = shell.readShortcutLink(a.lnk); } catch {} }
    // 2а) иконка exe через оболочку Windows в 96×96 — у app.getFileIcon она не больше 32×32 и на панели выглядит мутной
    for (const f of [a.exe, lnkInfo.icon]) {
      if (!f || !/\.(exe|ico|dll)$/i.test(f) || !fs.existsSync(f)) continue;
      const [b64, gen96] = await Promise.all([safe(fast.call('fileicon', f, 6000)), shellGeneric()]);
      if (b64 && typeof b64 === 'string' && b64.length > 200 && b64 !== gen96) { const u = 'data:image/png;base64,' + b64; iconCache.set(key, u); return u; }
    }
    const gen = await genericIcon();
    let url = null, sawGeneric = false;
    for (const f of [a.exe, lnkInfo.icon, a.lnk]) {
      if (!f || !fs.existsSync(f)) continue;
      try {
        const img = await app.getFileIcon(f, { size: 'large' });
        if (img.isEmpty()) continue;
        const u = img.toDataURL();
        if (u === gen) { sawGeneric = true; continue; }
        url = u; break;
      } catch {}
    }
    let exe = a.exe;
    if (!exe && lnkInfo.target && /\.exe$/i.test(lnkInfo.target)) exe = lnkInfo.target;
    if (!url && sawGeneric) {
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
      noteExe(exe); // программа с окном — запомнить для поиска и «+» (и без таскбара Bar)
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

  ipcMain.handle('popup-menu', (e, items) => new Promise((resolve) => {
    let picked = null;
    const menu = Menu.buildFromTemplate(items.map((it) => it.sep ? { type: 'separator' } : {
      label: it.label, enabled: it.enabled !== false, click: () => { picked = it.id; },
      ...(it.checked !== undefined ? { type: 'radio', checked: !!it.checked } : {}),
    }));
    menu.popup({ window: BrowserWindow.fromWebContents(e.sender) || getWin(), callback: () => setTimeout(() => resolve(picked), 0) }); // у окна, которое спросило (нотч или таскбар)
  }));

  // ---------- быстрые переключатели ----------
  ipcMain.handle('taskbar', (_e, on) => safe(on === undefined ? fast.call('taskbar') : fast.call('settaskbar', on ? 1 : 0)));
  let awakeId = null;
  ipcMain.handle('keep-awake', (_e, on) => {
    if (on && awakeId === null) awakeId = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
    return awakeId !== null;
  });
  // тема Windows: без аргумента — прочитать (true — светлая), иначе сменить; агент оповещает систему, как «Параметры»
  ipcMain.handle('win-theme', async (_e, light) => {
    const v = await safe(fast.call('wintheme', light === undefined ? '' : light ? '1' : '0', 4000));
    return v === undefined ? null : v;
  });

  return {
    call: (cmd, arg, ms) => fast.call(cmd, arg, ms),
    // сменили микрофон в настройках: перечитать звук и перезапустить ожидание изменений с новым устройством
    micChanged() { poll.audio(); if (aw.on) watcher.stop(); }, // цикл ожидания сам перезапустит агента и спросит уже новый микрофон
    noteExe,
    listApps,
    stop() { clearInterval(fgT); clearInterval(fgSave); try { fs.writeFileSync(FG_FILE, JSON.stringify(fg)); } catch {} Object.values(timers).forEach(clearInterval); fast.stop(); slow.stop(); finder.stop(); gpuAgent.stop(); watchSet(false); meterStop(); if (awakeId !== null) powerSaveBlocker.stop(awakeId); },
  };
};
