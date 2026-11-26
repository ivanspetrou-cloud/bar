// Таскбар Bar — док внизу экрана: «Пуск», поиск, закреплённые и открытые программы.
// Закреплённые — общий список с доком в нотче (одно хранилище). Окна приходят из главного процесса по событиям Windows.
'use strict';
const store = {
  get(k, d) { try { const v = localStorage.getItem('bar.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bar.' + k, JSON.stringify(v)); } catch {} },
};
const $ = (s) => document.querySelector(s);
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v != null && v !== false) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}
const LUC = { start: 'LayoutGrid', search: 'Search', desktop: 'Minimize2', restore: 'Maximize2', restart: 'RotateCw', shutdown: 'Power' };
function icon(n) {
  const node = window.lucide && window.lucide.icons && window.lucide.icons[LUC[n] || n];
  const inner = node ? node.map(([tag, a]) => `<${tag} ${Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('') : '';
  return `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
}

const SIZES = { s: 44, m: 52, l: 62 };
const tb = $('#tb'), tip = $('#tb-tip');
let cfg = { on: true, mode: 'hide', size: 'm', magnify: true, running: true, extras: [], btn: { start: true, search: true, desktop: true } };
let wins = [];
let pins = store.get('dock', []) || [];
const els = new Map();          // key → элемент (переиспользуем, чтобы анимации не сбрасывались)
const icons = new Map();
const launching = new Map();    // key → таймер «запускается»
const cycle = new Map();        // key → индекс окна при переключении кликами

const lower = (s) => String(s || '').toLowerCase();
const base = (p) => String(p || '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
const prettyName = (exe) => { const b = base(exe); return b.charAt(0).toUpperCase() + b.slice(1); };
function matchUwp(fam, exe) {
  const i = fam.lastIndexOf('_'); if (i < 0) return false;
  const n = fam.slice(0, i).toLowerCase(), hash = fam.slice(i + 1).toLowerCase(), e = exe.toLowerCase();
  return e.includes('\\windowsapps\\' + n + '_') && e.includes('__' + hash);
}
// Закреплённый запускающий файл и exe окна часто разные: Discord, Slack, Teams (Squirrel) закрепляются как …\Update.exe,
// а окно — из …\app-1.0.9\Discord.exe; Veyra — Veyra.exe и versions\2.2.0\veyra_qml_ui.exe. Считаем это одной программой,
// если окно лежит в подпапке папки запускающего файла и это Update.exe или имя exe окна начинается с имени запускающего.
const BS = String.fromCharCode(92);
const dirOf = (p) => lower(p).slice(0, lower(p).lastIndexOf(BS) + 1);
function launcherOwns(exe, wexe) {
  const d = dirOf(exe), we = lower(wexe);
  if (!d || !we.startsWith(d) || we.slice(d.length).indexOf(BS) < 0) return false;          // только из подпапки
  const parts = d.split(BS).filter(Boolean);                                                   // не общие папки: «C:\Program Files\», «C:\Windows\»
  if (parts.length < 2 || (parts.length === 2 && /^(program files( \(x86\))?|programdata|windows|users)$/.test(parts[1]))) return false;
  const b = lower(base(exe)), wb = lower(base(wexe));
  return b === 'update' || wb === b || (b.length >= 4 && wb.startsWith(b));
}
const owns = (app, w) => (app.exe && (lower(app.exe) === lower(w.exe) || launcherOwns(app.exe, w.exe))) || (app.uwp && matchUwp(app.uwp, w.exe));

// доки на всех мониторах одинаковые: все окна — в каждом (так проще и не путает)
const here = () => true;
// модель: закреплённые (на всех мониторах, по порядку) + открытые незакреплённые этого монитора
function model() {
  const used = new Set();
  const items = pins.map((p) => {
    const all = wins.filter((w) => owns(p, w));
    all.forEach((w) => used.add(w.hwnd));
    return { key: 'p:' + p.id, app: p, wins: all.filter(here), away: all.filter((w) => !here(w)), pinned: true };
  });
  const groups = new Map();
  for (const w of wins) {
    if (used.has(w.hwnd) || !here(w)) continue;
    const k = lower(w.exe);
    if (!groups.has(k)) groups.set(k, { key: 'w:' + k, app: { id: 'exe:' + w.exe, name: prettyName(w.exe), exe: w.exe }, wins: [], away: [], pinned: false });
    groups.get(k).wins.push(w);
  }
  return [items, [...groups.values()]];
}

function setIcon(app, slot) {
  const key = app.id || lower(app.exe);
  const put = (u) => { if (u) slot.replaceChildren(h('img', { src: u, alt: '', draggable: 'false' })); else slot.replaceChildren(h('span', { class: 'tb-letter' }, (app.name || '?').charAt(0).toUpperCase())); };
  if (icons.has(key)) return put(icons.get(key));
  bar.appIcon(app).then((u) => { icons.set(key, u || null); put(u); }).catch(() => put(null));
}

function itemEl(it) {
  let el = els.get(it.key);
  if (!el) {
    const slot = h('span', { class: 'tb-ic' });
    el = h('button', { class: 'tbi', 'aria-label': it.app.name }, slot, h('span', { class: 'tb-dots' }));
    el._slot = slot;
    setIcon(it.app, slot);
    el.addEventListener('click', () => onClick(el._it));
    el.addEventListener('auxclick', (e) => { if (e.button === 1) { bar.appLaunch(el._it.app); bounce(el._it.key); } });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); onMenu(el._it); });
    el.addEventListener('mouseenter', () => { if (!prevHover(el)) showTip(el); });
    el.addEventListener('mouseleave', () => prevLeave());
    el._new = true;
    els.set(it.key, el);
  }
  el._it = it;
  const n = it.wins.length, active = it.wins.some((w) => w.active);
  el.classList.toggle('run', n > 0);
  el.classList.toggle('away', n === 0 && it.away.length > 0); // открыта только на другом мониторе — бледная точка
  el.classList.toggle('active', active);
  el.classList.toggle('launching', launching.has(it.key) && n === 0 && !it.away.length);
  if ((n > 0 || it.away.length) && launching.has(it.key)) { clearTimeout(launching.get(it.key)); launching.delete(it.key); }
  syncDots(el.querySelector('.tb-dots'), n ? Math.min(n, 3) : it.away.length ? 1 : 0);
  el.title = '';
  return el;
}

// Точки окон живут между перерисовками: активная плавно вытягивается в полоску и сжимается обратно,
// новая точка появляется, лишняя — исчезает (а не подменяется мгновенно)
function syncDots(box, want) {
  const live = [...box.children].filter((i) => !i._leaving);
  for (let k = live.length; k < want; k++) {
    const i = h('i'); box.append(i);
    i.animate([{ transform: 'scale(0)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 320, easing: 'cubic-bezier(.3,1.32,.5,1)' });
  }
  for (let k = live.length - 1; k >= want; k--) {
    const i = live[k]; i._leaving = true;
    i.animate([{ transform: 'none', opacity: 1 }, { transform: 'scale(0)', opacity: 0 }], { duration: 220, easing: 'ease-in' }).onfinish = () => i.remove();
  }
}
function fixed(id, ic, label, fn, alt) {
  let el = els.get(id);
  if (!el) {
    el = h('button', { class: 'tbi sys', 'aria-label': label }, h('span', { class: 'tb-ic', html: icon(ic) }));
    el.addEventListener('click', fn);
    if (alt) el.addEventListener('contextmenu', (e) => { e.preventDefault(); alt(); });
    el.addEventListener('mouseenter', () => showTip(el));
    el._label = label;
    els.set(id, el);
  }
  return el;
}

function render() {
  const [pinned, running] = model();
  const b = cfg.btn || {};
  const run = cfg.running === false ? [] : running;
  const extras = (cfg.extras || []).map(extraEl);
  const want = [
    b.start !== false && fixed('sys:start', 'start', 'Приложения', () => bar.tbApps(), () => bar.tbStart()), // правый клик — «Пуск» Windows
    b.search !== false && fixed('sys:search', 'search', 'Поиск', () => bar.tbSearch()),
    (b.start !== false || b.search !== false) && sep('sep1'),
    ...pinned.map(itemEl),
    run.length && pinned.length ? sep('sep2') : null,
    ...run.map(itemEl),
    extras.length && (pinned.length || run.length) ? sep('sep4') : null,
    ...extras,
    b.desktop !== false && sep('sep3'),
    b.desktop !== false && fixed('sys:desktop', desk ? 'restore' : 'desktop', desk ? 'Развернуть всё' : 'Свернуть всё', () => toggleDesk()),
    (b.restart !== false || b.shutdown !== false) && sep('sep5'),
    b.restart !== false && powerBtn('restart', 'Перезагрузка'),
    b.shutdown !== false && powerBtn('shutdown', 'Завершение работы'),
  ].filter(Boolean);
  const keep = new Set(want);
  // ушедшие — сжимаются и исчезают
  for (const [k, el] of els) {
    if (!keep.has(el) && el.isConnected && !el._leaving) {
      el._leaving = true;
      const a = el.animate([{ width: el.offsetWidth + 'px', opacity: 1, transform: 'none' }, { width: '0px', opacity: 0, transform: 'scale(.4)' }], { duration: 260, easing: 'cubic-bezier(.3,.7,.2,1)' });
      a.onfinish = () => { el.remove(); el._leaving = false; if (!keep.has(el) && k.startsWith('w:')) els.delete(k); };
    }
  }
  // порядок: вставляем недостающие на свои места
  let prev = null;
  for (const el of want) {
    el._leaving = false;
    const next = prev ? prev.nextElementSibling : tb.firstElementChild;
    if (el !== next) tb.insertBefore(el, next);
    if (el._new) {
      el._new = false;
      el.animate([{ width: '0px', opacity: 0, transform: 'scale(.3) translateY(10px)' }, { width: sizePx() + 'px', opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.3,1.32,.5,1)' });
    }
    prev = el;
  }
  magnify(lastX);
}
// ярлыки: места Windows, свои папки, инструменты Bar
const EX_ICON = {
  recycle: 'Trash2', downloads: 'Download', documents: 'FileText', pc: 'HardDrive', settings: 'Settings', taskmgr: 'Activity',
  timer: 'Hourglass', stopwatch: 'Timer', notes: 'NotebookPen', calc: 'Calculator', voice: 'Mic', clip: 'ClipboardList', shelf: 'Inbox',
  calendar: 'CalendarDays', mirror: 'ScanFace', shot: 'Camera', color: 'Pipette', ocr: 'ScanText', qrscan: 'ScanQrCode', phone: 'Smartphone',
  system: 'Activity', music: 'Music', text: 'Type', apps: 'LayoutGrid',
};
const exKey = (x) => 'x:' + (x.place || (x.tool ? 'tool:' + x.tool : x.path));
function extraEl(x) {
  const key = exKey(x);
  let el = els.get(key);
  if (!el) {
    el = h('button', { class: 'tbi sys ex', 'aria-label': x.name }, h('span', { class: 'tb-ic', html: icon(EX_ICON[x.place || x.tool] || 'Folder') }));
    el.addEventListener('click', () => {
      el.querySelector('.tb-ic').animate([{ transform: 'none' }, { transform: 'translateY(-6px)' }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.3,1.32,.5,1)' });
      if (el._x.tool) bar.tbTool(el._x.tool); else bar.tbOpen(el._x);
    });
    el.addEventListener('contextmenu', async (e) => {
      e.preventDefault(); menuOpen = true;
      const pick = await bar.popupMenu([{ id: 'del', label: 'Убрать из таскбара' }, { sep: true }, { id: 'set', label: 'Настройки таскбара…' }]);
      menuOpen = false;
      if (pick === 'del') bar.taskbarSet({ extras: (cfg.extras || []).filter((y) => exKey(y) !== exKey(el._x)) });
      if (pick === 'set') bar.tbTool('tbset');
    });
    el.addEventListener('mouseenter', () => { prevClose(); showTip(el); });
    el._new = true;
    els.set(key, el);
  }
  el._x = x; el._label = x.name;
  return el;
}
// правый клик по пустому месту дока — настройки
tb.addEventListener('contextmenu', async (e) => {
  if (e.target.closest('.tbi')) return;
  e.preventDefault(); menuOpen = true;
  const pick = await bar.popupMenu([
    { id: 'set', label: 'Настройки таскбара…' },
    { sep: true },
    { id: 'mode', label: cfg.mode === 'hide' ? 'Всегда показывать' : 'Прятать у нижнего края' },
    { id: 'mag', label: cfg.magnify ? 'Без увеличения при наведении' : 'Увеличение при наведении' },
  ]);
  menuOpen = false;
  if (pick === 'set') bar.tbTool('tbset');
  if (pick === 'mode') bar.taskbarSet({ mode: cfg.mode === 'hide' ? 'always' : 'hide' });
  if (pick === 'mag') bar.taskbarSet({ magnify: !cfg.magnify });
});
// питание: первый клик «взводит» кнопку (красная, пульсирует, подсказка «ещё раз»), второй в течение 3 с — выполняет
function powerBtn(what, label) {
  const id = 'sys:' + what;
  let el = els.get(id);
  if (!el) {
    el = fixed(id, what, label, () => {
      if (el.classList.contains('arm')) { clearTimeout(el._armT); el.classList.remove('arm'); bar.tbPower(what); return; }
      el.classList.add('arm');
      el._label = what === 'shutdown' ? 'Нажмите ещё раз — выключить' : 'Нажмите ещё раз — перезагрузить';
      showTip(el);
      clearTimeout(el._armT);
      el._armT = setTimeout(() => { el.classList.remove('arm'); el._label = label; if (tipFor === el) { tip.textContent = label; placeTip(el); } }, 3000);
    });
    el.classList.add('power');
  }
  return el;
}
function sep(id) { let el = els.get(id); if (!el) { el = h('span', { class: 'tb-sep' }); els.set(id, el); } return el; }

// ---------- действия ----------
function bounce(key) {
  clearTimeout(launching.get(key));
  launching.set(key, setTimeout(() => { launching.delete(key); render(); }, 9000));
  render();
}
async function onClick(it) {
  if (!it.wins.length && it.away.length) { bar.winFocus(it.away[0].hwnd); setTimeout(() => bar.tbRefresh(), 250); return; } // окно на другом мониторе — к нему
  if (!it.wins.length) { bar.appLaunch(it.app); bounce(it.key); return; }
  const active = it.wins.find((w) => w.active);
  if (active && it.wins.length === 1) { bar.winMin(active.hwnd); return; }
  if (active) {
    // несколько окон: клики по очереди переключают их
    const i = ((cycle.get(it.key) || 0) + 1) % it.wins.length;
    cycle.set(it.key, i);
    bar.winFocus(it.wins[i].hwnd);
  } else bar.winFocus(it.wins[0].hwnd);
  setTimeout(() => bar.tbRefresh(), 250);
}
async function onMenu(it) {
  menuOpen = true;
  const items = [];
  const all = [...it.wins, ...it.away];
  all.slice(0, 10).forEach((w, i) => items.push({ id: 'w' + i, label: (w.title || it.app.name).slice(0, 60) + (here(w) ? '' : '  ·  другой монитор'), checked: w.active }));
  if (all.length) items.push({ sep: true });
  items.push({ id: 'new', label: it.wins.length ? 'Новое окно' : 'Открыть' });
  items.push({ id: 'pin', label: it.pinned ? 'Открепить' : 'Закрепить' });
  if (all.length) items.push({ sep: true }, { id: 'close', label: all.length > 1 ? `Закрыть все окна (${all.length})` : 'Закрыть окно' });
  const pick = await bar.popupMenu(items);
  menuOpen = false;
  if (!pick) return;
  if (pick[0] === 'w' && pick !== 'new') bar.winFocus(all[+pick.slice(1)].hwnd);
  if (pick === 'new') { bar.appLaunch(it.app); bounce(it.key); }
  if (pick === 'close') [...new Set(all.map((w) => w.pid))].forEach((pid) => bar.winClose(pid));
  if (pick === 'pin') {
    pins = store.get('dock', []) || [];
    if (it.pinned) pins = pins.filter((d) => d.id !== it.app.id);
    else if (!pins.some((d) => d.id === it.app.id)) pins.push({ id: it.app.id, name: it.app.name, exe: it.app.exe || '', lnk: it.app.lnk || '', uwp: it.app.uwp || '' });
    store.set('dock', pins);
    // ключ поменялся (w: → p:) — переносим элемент, чтобы он не «пересоздавался»
    const el = els.get(it.key); els.delete(it.key);
    if (el) els.set(it.pinned ? 'w:' + lower(it.app.exe) : 'p:' + it.app.id, el);
    render();
  }
  setTimeout(() => bar.tbRefresh(), 300);
}

// ---------- превью окон ----------
// Наводишь на программу с открытыми окнами — над ней живые миниатюры всех окон; клик — к этому окну, × — закрыть его.
const prev = h('div', { class: 'tb-prev', hidden: true });
document.body.append(prev);
let prevFor = null, prevT = 0, prevHideT = 0, prevThumbT = 0;
function prevHover(el) {
  const it = el._it;
  clearTimeout(prevHideT); clearTimeout(prevT);
  if (!it || !(it.wins.length + it.away.length)) { if (prevFor) prevClose(); return false; }
  if (prevFor) { if (prevFor !== el) prevOpen(el); return true; }   // превью уже открыто — сразу переключаемся
  prevT = setTimeout(() => prevOpen(el), 420);
  return false;
}
function prevLeave() { clearTimeout(prevT); clearTimeout(prevHideT); prevHideT = setTimeout(prevClose, 320); }
function prevOpen(el) {
  const it = el._it;
  const ws = [...it.wins, ...it.away].slice(0, 6);
  if (!ws.length) return;
  const switching = !!prevFor;
  prevFor = el; hideTip();
  const iconImg = el._slot && el._slot.querySelector('img');
  const iconSrc = iconImg ? iconImg.src : '';
  const cards = ws.map((w, i) => {
    const shot = h('div', { class: 'tp-shot' + (w.min ? ' min' : '') }, w.min ? h('span', { class: 'tp-min' }, 'Свёрнуто') : null); // у свёрнутых — снимок с момента сворачивания и метка
    const x = h('span', { class: 'tp-x', title: 'Закрыть окно', html: '<svg viewBox="0 0 24 24" class="i"><path d="M6 6l12 12M18 6L6 18"/></svg>' });
    const card = h('button', { class: 'tp-card' + (w.active ? ' on' : '') },
      h('div', { class: 'tp-head' }, iconSrc ? h('img', { src: iconSrc, alt: '' }) : null, h('span', { class: 'tp-t' }, w.title || it.app.name), x), shot);
    card.addEventListener('click', () => { bar.winFocus(w.hwnd); prevClose(); setTimeout(() => bar.tbRefresh(), 250); });
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      bar.tbCloseWin(w.hwnd);
      card.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.85) translateY(8px)' }], { duration: 220, easing: 'ease-in' }).onfinish = () => {
        card.remove();
        if (!prev.querySelector('.tp-card')) prevClose(); else prevPlace();
      };
    });
    card._w = w; card._shot = shot;
    if (!switching) card.animate([{ opacity: 0, transform: 'translateY(10px) scale(.95)' }], { duration: 360, delay: 40 + i * 45, easing: 'cubic-bezier(.3,1.32,.5,1)', fill: 'backwards' });
    return card;
  });
  prev.replaceChildren(...cards);
  // «впервые» — и когда превью закрыто, и когда оно ещё закрывается: тогда оно появляется на месте заново,
  // а не доезжает со старого места снизу
  const first = prev.hidden || !prev.classList.contains('on');
  prev.hidden = false;
  if (first) { prev.style.transition = 'none'; prev.classList.remove('on'); }
  prevPlace(first);
  if (first) { void prev.offsetWidth; prev.style.transition = ''; }
  prev.classList.add('on');
  prevThumbs();
  clearInterval(prevThumbT); prevThumbT = setInterval(prevThumbs, 1500); // пока открыто — живые
}
function prevPlace(jump) {
  if (!prevFor || prev.hidden) return;
  const r = prevFor.getBoundingClientRect(), sh = shell.getBoundingClientRect();
  const x = Math.max(8, Math.min(window.innerWidth - prev.offsetWidth - 8, Math.round(r.left + r.width / 2 - prev.offsetWidth / 2)));
  const y = Math.round(sh.top - prev.offsetHeight - 10); // сразу над доком: увеличенная иконка уходит под превью
  if (jump) { prev.style.transition = 'none'; prev.style.translate = `${x}px ${y}px`; void prev.offsetWidth; prev.style.transition = ''; }
  else prev.style.translate = `${x}px ${y}px`;
}
async function prevThumbs() {
  const cards = [...prev.querySelectorAll('.tp-card')];
  if (!cards.length) return;
  const map = await bar.tbThumbs(cards.map((c) => c._w.hwnd)).catch(() => ({}));
  for (const c of cards) {
    const u = map && map[c._w.hwnd];
    if (!u) continue;
    let img = c._shot.querySelector('img');
    if (img && img.src === u) continue;
    // картинку сначала декодируем, потом показываем — без подтормаживания на первом кадре
    const next = new Image(); next.src = u;
    try { await next.decode(); } catch { continue; }
    if (!img) { img = h('img', { alt: '' }); c._shot.append(img); }
    img.src = u; img.classList.add('ok');
  }
}
function prevClose() {
  clearTimeout(prevT); clearTimeout(prevHideT); clearInterval(prevThumbT);
  if (!prevFor) return;
  prevFor = null;
  prev.classList.remove('on');
  setTimeout(() => { if (!prevFor) { prev.hidden = true; prev.replaceChildren(); } }, 200);
}
prev.addEventListener('mouseenter', () => { clearTimeout(prevHideT); over = true; show(); bar.tbInteractive(true); });
prev.addEventListener('mouseleave', () => { over = false; bar.tbInteractive(false); prevLeave(); hideSoon(); });

// ---------- подпись ----------
// Как в macOS: на одной высоте над доком (не прыгает вместе с увеличением иконки), первая — с небольшой задержкой,
// дальше при движении по доку просто переезжает от иконки к иконке.
let tipFor = null, tipT = 0, tipLive = false;
function tipText(el) {
  const it = el._it;
  if (el._label) return el._label;
  const t = it.wins.length === 1 && it.wins[0].title ? it.wins[0].title : it.app.name;
  return (t.length > 48 ? t.slice(0, 47) + '…' : t) + (it.wins.length > 1 ? ` · ${it.wins.length}` : '');
}
function showTip(el) {
  tipFor = el;
  clearTimeout(tipT);
  const go = () => {
    if (tipFor !== el) return;
    tip.textContent = tipText(el);
    const first = tip.hidden;
    tip.hidden = false;
    placeTip(el, first);
    tip.classList.add('on'); tipLive = true;
  };
  if (tipLive) go(); else tipT = setTimeout(go, 280);
}
function placeTip(el, jump) {
  if (tip.hidden) return;
  const r = el.getBoundingClientRect(), sh = shell.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2 - tip.offsetWidth / 2);
  const y = Math.round(sh.top - sizePx() * 0.45 - tip.offsetHeight - 6); // над самой высокой иконкой
  if (jump) { tip.style.transition = 'none'; tip.style.translate = `${x}px ${y}px`; void tip.offsetWidth; tip.style.transition = ''; }
  else tip.style.translate = `${x}px ${y}px`;
}
function hideTip() { clearTimeout(tipT); tipFor = null; tipLive = false; tip.classList.remove('on'); setTimeout(() => { if (!tipLive) tip.hidden = true; }, 180); }

// Раскладка дока при наведении НЕ меняется: иконки только масштабируются и раздвигаются трансформацией,
// а фон дока растягивается отдельным слоем. Расстояния считаются от неподвижных позиций (offsetLeft) —
// поэтому нет обратной связи «иконка выросла → док сдвинулся → иконка уехала из-под курсора».
const sizePx = () => Math.round((SIZES[cfg.size] || 52) * (cfg.zoom || 1)); // zoom — поправка на физический размер пикселя монитора
let lastX = null, magRaf = 0;
const shell = $('#tb-shell'), bgEl = $('#tb-bg');
function magnify(x) {
  cancelAnimationFrame(magRaf);
  magRaf = requestAnimationFrame(() => {
    const s = sizePx();
    const kids = [...tb.children].filter((el) => !el._leaving);
    const left = tb.getBoundingClientRect().left;
    const ks = kids.map((el) => {
      if (x == null || !cfg.magnify || !el.classList.contains('tbi')) return 1;
      const d = Math.abs(x - (left + el.offsetLeft + el.offsetWidth / 2));
      return 1 + 0.45 * Math.max(0, 1 - d / (s * 2.4)) ** 2;
    });
    const ex = kids.map((el, i) => (ks[i] - 1) * el.offsetWidth);
    const E = ex.reduce((a, b) => a + b, 0);
    let acc = 0;
    kids.forEach((el, i) => {
      const off = acc + ex[i] / 2 - E / 2; acc += ex[i];
      el.style.transform = ks[i] === 1 && Math.abs(off) < 0.05 ? '' : `translateX(${off.toFixed(1)}px) scale(${ks[i].toFixed(3)})`;
    });
    bgEl.style.left = bgEl.style.right = (-E / 2).toFixed(1) + 'px';
    if (tipFor) placeTip(tipFor);
    if (prevFor) prevPlace();
  });
}

// ---------- показ / скрытие ----------
let shown = false, hideT = 0, over = false, menuOpen = false;
function show() { clearTimeout(hideT); hideT = 0; if (shown) return; shown = true; document.body.classList.add('shown'); }
function hideSoon(ms = 650) {
  clearTimeout(hideT);
  if (cfg.mode !== 'hide') return;
  hideT = setTimeout(() => { hideT = 0; if (over || menuOpen) return; shown = false; document.body.classList.remove('shown'); hideTip(); }, ms);
}
document.addEventListener('mousemove', (e) => {
  // окно таскбара прозрачно для мыши, но получает движение: у нижнего края — выезжаем
  if (cfg.mode === 'hide' && !shown && e.clientY >= window.innerHeight - 3) { show(); if (!over) hideSoon(900); }
  // курсор у края, но не на доке (сбоку или ушёл выше) — убрать, не дожидаясь события «ушёл с дока»: его не будет
  else if (cfg.mode === 'hide' && shown && !over && !menuOpen && e.clientY < window.innerHeight - 3 && !hideT) hideSoon(450);
});
// курсор ушёл с этого монитора совсем — событий больше не придёт, прячемся по таймеру
document.addEventListener('mouseleave', () => { if (cfg.mode === 'hide' && !over && !menuOpen) hideSoon(450); });
shell.addEventListener('mouseenter', () => { over = true; show(); document.body.classList.add('mag'); bar.tbInteractive(true); });
shell.addEventListener('mouseleave', () => { over = false; lastX = null; document.body.classList.remove('mag'); magnify(null); hideTip(); bar.tbInteractive(false); prevLeave(); hideSoon(); });
shell.addEventListener('mousemove', (e) => { lastX = e.clientX; magnify(e.clientX); });

function applyCfg(c) {
  cfg = { ...cfg, ...c };
  document.documentElement.style.setProperty('--tb-s', sizePx() + 'px');
  document.body.classList.toggle('mode-hide', cfg.mode === 'hide');
  document.body.classList.toggle('mode-always', cfg.mode === 'always');
  if (cfg.mode === 'always') show(); else hideSoon(1200);
  render();
}

// «Свернуть всё» ↔ «Развернуть всё»: Win+D сам по себе переключатель — повторное нажатие возвращает окна.
// Если после сворачивания вы сами открыли какое-то окно — кнопка снова «Свернуть всё».
let desk = false, deskAt = 0;
function deskIcon(on, animate) {
  const el = els.get('sys:desktop');
  if (!el) return;
  el._label = on ? 'Развернуть всё' : 'Свернуть всё';
  el.setAttribute('aria-label', el._label);
  const ic = el.querySelector('.tb-ic');
  const swap = () => { ic.innerHTML = icon(on ? 'restore' : 'desktop'); };
  if (!animate) return swap();
  ic.animate([{ transform: 'scale(1) rotate(0)', opacity: 1 }, { transform: 'scale(.4) rotate(-90deg)', opacity: 0 }], { duration: 150, easing: 'ease-in' }).onfinish = () => {
    swap();
    ic.animate([{ transform: 'scale(.4) rotate(90deg)', opacity: 0 }, { transform: 'scale(1) rotate(0)', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(.3,1.32,.5,1)' });
  };
  if (tipFor === el) { tip.textContent = el._label; placeTip(el); }
}
function toggleDesk() {
  desk = !desk; deskAt = Date.now();
  bar.tbDesktop();
  deskIcon(desk, true);
  // окна программ в доке «приседают» вместе с ними
  for (const el of tb.querySelectorAll('.tbi.run')) el.querySelector('.tb-ic').animate([{ transform: 'none' }, { transform: desk ? 'translateY(5px) scale(.9)' : 'translateY(-5px) scale(1.06)' }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.3,.7,.2,1)' });
}
bar.onTbWins((list) => {
  wins = list || [];
  if (desk && Date.now() - deskAt > 900 && wins.some((w) => w.active && !w.min)) { desk = false; deskIcon(false, true); }
  render();
});
bar.onTbCfg(applyCfg);
// в игре: док выехал по задержке у края — показать (и спрятать, если мышь на него не зашла)
// игра / полноэкранное видео: док плавно уезжает вниз перед тем, как окно спрячется, и выезжает, когда снова нужен
if (bar.onTbAway) bar.onTbAway((on) => requestAnimationFrame(() => document.body.classList.toggle('away', !!on)));
bar.onTbPeek(() => { show(); hideSoon(2500); sendZone(); });
// прямоугольник дока (и превью, если открыто) — главному процессу, чтобы в играх он сам делал док кликабельным
function sendZone() {
  const r = shell.getBoundingClientRect();
  const z = { l: r.left, t: r.top, r: r.right, b: r.bottom };
  const add = (q) => { if (!q.width) return; z.l = Math.min(z.l, q.left); z.t = Math.min(z.t, q.top); z.r = Math.max(z.r, q.right); z.b = Math.max(z.b, q.bottom); };
  if (!prev.hidden) add(prev.getBoundingClientRect());
  for (const el of shell.querySelectorAll('.tbi')) add(el.getBoundingClientRect()); // увеличенные значки выходят за подложку
  add(bgEl.getBoundingClientRect());
  bar.tbZone(z);
}
setInterval(() => { if (shown) sendZone(); }, 250);
// в игре наведение сообщает главный процесс (сама игра события мыши не отдаёт)
bar.onTbHover((on) => {
  if (on) { over = true; show(); document.body.classList.add('mag'); sendZone(); }
  else { over = false; lastX = null; document.body.classList.remove('mag'); magnify(null); hideTip(); prevLeave(); hideSoon(); }
});
window.addEventListener('storage', (e) => { if (e.key === 'bar.dock') { pins = store.get('dock', []) || []; render(); } });
bar.taskbarGet().then((c) => { applyCfg(c); show(); hideSoon(2500); }); // при запуске — показаться и уехать
