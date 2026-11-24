'use strict';
/* global bar */

// ============ утилиты ============
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const store = {
  get(k, d) { try { const v = localStorage.getItem('bar.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bar.' + k, JSON.stringify(v)); } catch {} },
};
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

// Ползунок в стиле Bar (как перемотка в плеере): тонкая дорожка, заливка, ручка при наведении.
// Ведёт себя как <input type=range>: свойства value/disabled, события input (во время) и change (в конце).
function makeSlider({ min = 0, max = 100, step = 1, value = 0, label = '' } = {}) {
  const fill = h('b'), knob = h('i');
  const el = h('div', { class: 'slider', role: 'slider', tabindex: 0, 'aria-label': label, 'aria-valuemin': String(min), 'aria-valuemax': String(max) }, fill, knob);
  let v = +value, dis = false, drag = false;
  const paint = () => { const p = max > min ? (v - min) / (max - min) * 100 : 0; fill.style.width = knob.style.left = p + '%'; el.setAttribute('aria-valuenow', String(v)); };
  const set = (nv, fire) => {
    nv = Math.round(Math.max(min, Math.min(max, nv)) / step) * step;
    if (nv === v) return;
    v = nv; paint();
    if (fire) el.dispatchEvent(new Event('input'));
  };
  Object.defineProperty(el, 'value', { get: () => String(v), set: (x) => { v = Math.max(min, Math.min(max, +x || 0)); paint(); } });
  Object.defineProperty(el, 'disabled', { get: () => dis, set: (x) => { dis = !!x; el.classList.toggle('disabled', dis); el.tabIndex = dis ? -1 : 0; } });
  const at = (e) => { const r = el.getBoundingClientRect(); return min + (max - min) * Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  el.addEventListener('pointerdown', (e) => {
    if (dis) return;
    e.stopPropagation(); el.setPointerCapture(e.pointerId);
    drag = true; el.classList.add('drag'); set(at(e), true);
  });
  el.addEventListener('pointermove', (e) => { if (drag) set(at(e), true); });
  const end = () => { if (!drag) return; drag = false; el.classList.remove('drag'); el.dispatchEvent(new Event('change')); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => {
    if (dis) return;
    const d = { ArrowRight: 2, ArrowUp: 2, ArrowLeft: -2, ArrowDown: -2, PageUp: 10, PageDown: -10 }[e.key];
    if (d === undefined) return;
    e.preventDefault(); e.stopPropagation();
    set(v + d * step, true); el.dispatchEvent(new Event('change'));
  });
  el.addEventListener('click', (e) => e.stopPropagation());
  paint();
  return el;
}

const fmtDur = (ms, ceil = true) => {
  const s = Math.max(0, ceil ? Math.ceil(ms / 1000) : Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return hh ? `${hh}:${pad(m)}:${pad(x)}` : `${pad(m)}:${pad(x)}`;
};
const fmtSize = (n) => n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(0) + ' КБ' : n < 1073741824 ? (n / 1048576).toFixed(1).replace('.', ',') + ' МБ' : (n / 1073741824).toFixed(1).replace('.', ',') + ' ГБ';
const copy = (t, note = 'Скопировано') => { bar.clipWrite(t); flash(note); };

// ============ иконки ============
const P = {
  ocr: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8.5 9h7M12 9v7',
  color: 'M14.5 5.5l4 4M16.6 3.4a2 2 0 0 1 2.9 0l1.1 1.1a2 2 0 0 1 0 2.9L18 10l-4-4zM14.5 7.5L6 16l-1.5 3.5L8 18l8.5-8.5',
  qrscan: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M8 8h3v3H8zM13 13h3v3h-3zM13 8h3M8 13v3',
  shot: 'M4 8h3l1.6-2.4A1 1 0 0 1 9.4 5h5.2a1 1 0 0 1 .8.6L17 8h3v11H4zM12 11a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  qrmake: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2',
  timer: 'M12 9v4l2.5 1.5M9 2.5h6M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16',
  stopwatch: 'M12 13l3-3M10 2.5h4M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16M18.5 5.5l1.5-1.5',
  voice: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21',
  notes: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5',
  clip: 'M9 3.5h6v3H9zM7.5 5H5.5v16h13V5h-2M8.5 11h7M8.5 15h5',
  shelf: 'M3.5 13.5l2.8-7.6A1.5 1.5 0 0 1 7.7 5h8.6a1.5 1.5 0 0 1 1.4.9l2.8 7.6V19H3.5zM3.5 13.5h5l1.2 2h4.6l1.2-2h5',
  phone: 'M8 2.5h8a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5M11 18.5h2',
  calc: 'M6 2.5h12a1 1 0 0 1 1 1v17a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1M8 6h8v3H8zM8.5 13h.01M12 13h.01M15.5 13h.01M8.5 17h.01M12 17h.01M15.5 17h.01',
  text: 'M5 7V5h14v2M12 5v14M9 19h6M17 13l2 2-2 2M7 13l-2 2 2 2',
  system: 'M3 12h4l2.5-6 5 12 2.5-6h4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 14.1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 20.9 10H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1',
  back: 'M14.5 5.5L8 12l6.5 6.5',
  pin: 'M12 16.5V21M8.5 3h7l-1 6 3 3v2.5h-11V12l3-3z',
  copy: 'M9 9h11v11H9zM15 9V4H4v11h5',
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  playpause: 'M4 5.5v13l8-6.5zM14 5.5h2.5v13H14zM18.5 5.5H21v13h-2.5z',
  next: 'M5 5v14l9-7zM17 5v14',
  prev: 'M19 5v14l-9-7zM7 5v14',
  volup: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11',
  voldown: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4zM16 9a4 4 0 0 1 0 6',
  mute: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4zM16 9.5l5 5M21 9.5l-5 5',
  folder: 'M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z',
  trash: 'M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13',
  x: 'M6 6l12 12M18 6L6 18',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z',
  link: 'M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1',
  plus: 'M12 5v14M5 12h14',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0M20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21',
  micoff: 'M9 9v3a3 3 0 0 0 5.1 2.1M15 9.5V6a3 3 0 0 0-5.9-.8M5.5 11a6.5 6.5 0 0 0 11 4.7M18.5 11a6.5 6.5 0 0 1-.4 2.2M12 17.5V21M4 4l16 16',
  ethernet: 'M4 6h16v10H4zM8 16v3h8v-3M8 10v2M12 10v2M16 10v2',
  offline: 'M2 8.8a15 15 0 0 1 4.2-2.6M10 5.2A15 15 0 0 1 22 8.8M5 12.5a10 10 0 0 1 3-1.9M14 10.6a10 10 0 0 1 5 1.9M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M3 3l18 18',
  headphones: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15a2 2 0 0 1 2-2h1v7H6a2 2 0 0 1-2-2zM20 15a2 2 0 0 0-2-2h-1v7h1a2 2 0 0 0 2-2z',
  gamepad: 'M6 8h12a4 4 0 0 1 4 4v2a2.5 2.5 0 0 1-4.5 1.5L16 14H8l-1.5 1.5A2.5 2.5 0 0 1 2 14v-2a4 4 0 0 1 4-4M7 10.5v3M5.5 12h3M15.5 11h.01M17.5 13h.01',
  mouse: 'M12 3a6 6 0 0 1 6 6v6a6 6 0 0 1-12 0V9a6 6 0 0 1 6-6M12 7v3',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  bluetooth: 'M7 7l10 10-5 4V3l5 4L7 17',
  coffee: 'M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5zM16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3v3M11 3v3M14 3v3',
  apps: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5',
  laptop: 'M5 5h14v10H5zM2.5 19h19',
  minimize: 'M5 19h14',
  fwd: 'M9.5 5.5L16 12l-6.5 6.5',
  bolt: 'M13 2L4.5 13.5H12L11 22l8.5-11.5H12z',
  taskbar: 'M3 4h18v16H3zM3 16h18M7 18.5h.01M10 18.5h.01',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  file: 'M6.5 3h8l4 4v14h-12zM14 3v5h4.5',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  reset: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5',
};
// Иконки — библиотека Lucide (ISC): единая сетка 24×24 и толщина линий.
// Свои пути из P остаются только как запасной вариант, если библиотека не загрузилась.
const LUCIDE = {
  ocr: 'ScanText', color: 'Pipette', qrscan: 'ScanQrCode', shot: 'Camera', qrmake: 'QrCode',
  timer: 'Hourglass', stopwatch: 'Timer', voice: 'Mic', notes: 'NotebookPen', clip: 'ClipboardList',
  shelf: 'Inbox', phone: 'Smartphone', calc: 'Calculator', text: 'Type', system: 'Activity', settings: 'Settings',
  back: 'ChevronLeft', fwd: 'ChevronRight', pin: 'Pin', copy: 'Copy', play: 'Play', pause: 'Pause', playpause: 'Play',
  next: 'SkipForward', prev: 'SkipBack', volup: 'Volume2', voldown: 'Volume1', mute: 'VolumeX', folder: 'Folder',
  trash: 'Trash2', x: 'X', star: 'Star', link: 'ExternalLink', plus: 'Plus', flag: 'Flag', reset: 'RotateCcw',
  file: 'File', music: 'Music', mic: 'Mic', micoff: 'MicOff', ethernet: 'EthernetPort', offline: 'WifiOff',
  headphones: 'Headphones', gamepad: 'Gamepad2', mouse: 'Mouse', keyboard: 'Keyboard', bluetooth: 'Bluetooth',
  coffee: 'Coffee', apps: 'LayoutGrid', sun: 'Sun', moon: 'Moon', laptop: 'Laptop', minimize: 'Minus',
  bolt: 'Zap', taskbar: 'PanelBottom', eye: 'Eye', wifi: 'Wifi', wifihigh: 'WifiHigh', wifilow: 'WifiLow',
  heart: 'Heart', thumbsdown: 'ThumbsDown', shuffle: 'Shuffle', repeat: 'Repeat', repeat1: 'Repeat1', search: 'Search',
  ram: 'MemoryStick', cpu: 'Cpu', download: 'Download', check: 'Check', code: 'Code', layout: 'LayoutDashboard', grip: 'GripVertical', disc: 'Disc3', redo: 'RotateCw', globe: 'Globe', enter: 'CornerDownLeft',
};
const iconCache = new Map();
const attrEsc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
function icon(n) {
  if (iconCache.has(n)) return iconCache.get(n);
  const node = window.lucide && window.lucide.icons && window.lucide.icons[LUCIDE[n]];
  const inner = node
    ? node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${attrEsc(v)}"`).join(' ')}/>`).join('')
    : `<path d="${P[n] || ''}"/>`;
  const svg = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
  iconCache.set(n, svg);
  return svg;
}
const I = (n) => h('span', { html: icon(n), style: { display: 'contents' } });

// ============ состояние острова ============
const island = $('#island');
const hot = $('#hot');
let state = 'collapsed';
let pinned = false;
let interactive = false;
let enterT = 0, leaveT = 0, autoT = 0;
let current = null, cleanup = null;
const openHooks = new Set();

function setInteractive(v) {
  if (v === interactive) return;
  interactive = v;
  bar.setInteractive(v);
}

// размер окна: маленькое, пока нотч свёрнут (см. main.js → win-size)
let winFull = false, shrinkT = 0;
function growWin() { clearTimeout(shrinkT); if (winFull) return Promise.resolve(); winFull = true; return bar.winSize('full'); }
function shrinkWinSoon(ms = 600) {
  clearTimeout(shrinkT);
  shrinkT = setTimeout(() => {
    if (state === 'open' || island.classList.contains('peek') || island.matches(':hover')) return;
    winFull = false; bar.winSize('pill');
  }, ms);
}
function expand(opts = {}) {
  if (!winFull) { growWin().then(() => expand(opts)); return; }
  clearTimeout(leaveT); clearTimeout(enterT); clearTimeout(autoT);
  if (opts.auto) {
    // открыт программно (результат OCR и т.п.) — если мышь так и не пришла, свернуться
    autoT = setTimeout(() => { if (!island.matches(':hover') && !pinned && !srchTyping()) collapse(); }, 9000);
  }
  if (state === 'open') return;
  state = 'open';
  swapBar();
  island.classList.add('open');
  island.classList.remove('peek');
  setInteractive(true);
  if (!current) renderHome();
  renderBar();
  schedTick();
  openHooks.forEach((f) => f(true));
}

function collapse(force) {
  if (state !== 'open') return;
  if (pinned && !force) return;
  state = 'collapsed';
  swapBar();
  island.classList.remove('open', 'peek');
  setInteractive(false);
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  openHooks.forEach((f) => f(false));
  // возвращаемся на главный экран, если инструмент не занят
  setTimeout(() => { if (state !== 'open' && current && !TOOLS_BY_ID[current].sticky?.()) goHome(); }, 450);
  renderBar();
  oledArmDim();
  wakeLive();
  schedTick();
  shrinkWinSoon(650); // после анимации сворачивания
}

// смена содержимого шапки (таблетка ↔ раскрытая) — плавным проявлением, без мгновенной подмены
function swapBar() {
  requestAnimationFrame(() => barEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, easing: 'ease-out' }));
}

// ============ защита OLED ============
// 1) Сдвиг пикселей: раз в 3 минуты нотч плавно смещается на 1–3 px по горизонтали (по кругу),
//    чтобы часы и значки не горели годами в одних и тех же пикселях.
// 2) Приглушение: свёрнутый нотч, который 15 с никто не трогает, тускнеет до 70%.
const Oled = { on: store.get('oled', true), shiftT: 0, dimT: 0, i: 0 };
const OLED_SHIFT = [0, 2, -1, 3, 1, -2, -3, 1];
function oledApply() {
  clearInterval(Oled.shiftT);
  island.style.setProperty('--oled-dx', '0px');
  island.classList.remove('dim');
  clearTimeout(Oled.dimT);
  if (!Oled.on) return;
  Oled.shiftT = setInterval(() => {
    Oled.i = (Oled.i + 1) % OLED_SHIFT.length;
    island.style.setProperty('--oled-dx', OLED_SHIFT[Oled.i] + 'px');
  }, 180000);
  oledArmDim();
}
function oledArmDim() {
  clearTimeout(Oled.dimT);
  island.classList.remove('dim');
  if (!Oled.on || state === 'open') return;
  Oled.dimT = setTimeout(() => { if (state !== 'open' && !island.matches(':hover')) island.classList.add('dim'); }, 15000);
}
// Столбики «играет»: двигаются, пока играет музыка, но всего 5 кадров в секунду и только когда
// столбики есть на экране. Между кадрами страница ничего не рисует (CSS-анимация рисовала бы 60 раз в секунду).
function wakeLive() {}
const EQ_PATTERN = [[.4, .9, .6], [.7, .5, 1], [1, .7, .4], [.6, 1, .8], [.3, .6, .9], [.8, .4, .6], [.5, .8, .3], [.9, .6, .7]];
let eqStep = 0;
setInterval(() => {
  const bars = document.querySelectorAll('span.eq');
  if (!bars.length || document.hidden) return;
  if (S.media && !S.media.playing) return;
  const f = EQ_PATTERN[eqStep = (eqStep + 1) % EQ_PATTERN.length];
  for (const b of bars) { const is = b.children; for (let i = 0; i < is.length; i++) is[i].style.transform = 'scaleY(' + f[i % 3] + ')'; }
}, 200);
function setOled(on) { Oled.on = !!on; store.set('oled', Oled.on); oledApply(); }

function hoverIn() {
  wakeLive();
  growWin();
  clearTimeout(leaveT);
  clearTimeout(Oled.dimT);
  island.classList.remove('dim');
  setInteractive(true);
  if (state !== 'open') {
    island.classList.add('peek');
    clearTimeout(enterT);
    enterT = setTimeout(expand, 120);
  }
}
function hoverOut(e) {
  if (e && e.relatedTarget && (island.contains(e.relatedTarget) || e.relatedTarget === hot)) return;
  clearTimeout(enterT);
  island.classList.remove('peek');
  oledArmDim();
  if (state !== 'open') shrinkWinSoon(500);
  setInteractive(false); // прозрачные поля окна не должны перехватывать клики
  if (state !== 'open' || pinned || srchTyping()) return;
  const ae = document.activeElement;
  const typing = ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
  leaveT = setTimeout(() => collapse(), typing ? 1600 : 380);
}
island.addEventListener('wheel', (e) => {
  if (state === 'open' || !S.audio) return;
  e.preventDefault();
  const v = Math.max(0, Math.min(100, S.audio.volume + (e.deltaY < 0 ? 2 : -2)));
  S.audio.volume = v; bar.audioSet({ volume: v }); renderBar(); flash('Громкость ' + v + '%', 900);
}, { passive: false });
island.addEventListener('mousedown', (e) => {
  if (state === 'open' || !e.target.closest('.art-mini, .eq')) return;
  e.preventDefault(); e.stopPropagation();
  clearTimeout(enterT); island.classList.remove('peek');
  bar.mediaCtl('toggle');
}, true);
hot.addEventListener('mouseenter', hoverIn);
hot.addEventListener('mouseleave', hoverOut);
island.addEventListener('mouseenter', hoverIn);
island.addEventListener('mouseleave', hoverOut);
window.addEventListener('blur', () => { if (state === 'open' && !pinned) collapse(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (Srch.q) srchClear(); else if (current) goHome(); else collapse(true); }
});

bar.onToggle(() => {
  if (state === 'open') return collapse(true);
  expand({ auto: true });
  bar.focus();
});
bar.onCollapse(() => collapse(true));
// нет движения мыши на мониторе с нотчем — нотч уезжает за край экрана
bar.onIdle((idle) => {
  if (idle && (state === 'open' || pinned)) return bar.idleWake();
  island.classList.toggle('idle', !!idle);
  hot.hidden = !!idle;
});

// перетаскивание файлов на нотч → полка
island.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  setInteractive(true);
  expand();
  if (current !== 'shelf') openTool('shelf');
});
island.addEventListener('dragover', (e) => e.preventDefault());
island.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])].map((f) => bar.filePath(f)).filter(Boolean);
  if (files.length) Shelf.add(files);
});

// ============ «живые активности» в свёрнутом нотче ============
const acts = new Map();
const ACT_ORDER = ['flash', 'rec', 'busy', 'timer', 'stopwatch', 'media', 'bridge'];
function setAct(id, a) { const had = acts.has(id); if (a) acts.set(id, a); else acts.delete(id); renderBar(); if (had !== !!a && typeof schedTick === 'function') schedTick(); }
function topAct(skip) { for (const id of ACT_ORDER) if (id !== skip && acts.has(id)) return acts.get(id); return null; }
function flash(text, ms = 1800) {
  oledArmDim(); // событие — нотч снова на полной яркости
  wakeLive();
  setAct('flash', { html: () => `<span class="dot"></span><span>${esc(text)}</span>` });
  clearTimeout(flash.t);
  flash.t = setTimeout(() => setAct('flash', null), ms);
}
const ringSvg = (frac) => {
  const C = 2 * Math.PI * 6;
  return `<svg class="ring" viewBox="0 0 16 16"><circle class="bg" cx="8" cy="8" r="6"/><circle class="fg" cx="8" cy="8" r="6" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - frac)}"/></svg>`;
};

// ============ батарея ============
let batt = null;
if (navigator.getBattery) {
  navigator.getBattery().then((b) => {
    const upd = () => {
      const desktop = b.charging && b.level === 1 && b.chargingTime === 0 && b.dischargingTime === Infinity;
      batt = desktop ? null : { level: Math.round(b.level * 100), charging: b.charging };
      renderBar();
    };
    ['levelchange', 'chargingchange'].forEach((ev) => b.addEventListener(ev, upd));
    upd();
  }).catch(() => {});
}
function battHtml() {
  if (!batt) {
    const d = new Date();
    return `<span class="sub">${d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric' })}</span>`;
  }
  const cls = batt.charging ? 'chg' : batt.level <= 15 ? 'low' : '';
  return `<span class="batt ${cls}"><span class="cell"><b style="width:${batt.level}%"></b></span>${batt.level}%</span>`;
}

// ============ показатели (данные приходят из главного процесса) ============
const S = { layout: '', audio: null, media: null, net: null, bt: [], hid: [], btLoaded: false, stats: null };
// «имя|уровень|подключено|заряжается|тип» от приёмников Razer/Corsair + Bluetooth
// последний известный заряд — чтобы уснувшая мышь показывала «спит · 97%», а не пустоту
// { имя: { level, t } } — последний удачный ответ устройства
const devLast = store.get('devLast2', {});
const FRESH = 10 * 60e3; // один пропущенный опрос не делает устройство «отключённым»
function devList() {
  const hid = S.hid.map((x) => { const [name, level, con, chg, kind] = String(x).split('|'); return { name, level: +level, connected: con === '1', charging: chg === '1', kind }; });
  const list = [...hid, ...S.bt.map((d) => ({ ...d }))];
  let changed = false;
  for (const d of list) {
    const prev = devLast[d.name];
    if (d.connected && d.level >= 0) {
      if (!prev || prev.level !== d.level || Date.now() - prev.t > 60e3) { devLast[d.name] = { level: d.level, t: Date.now() }; changed = true; }
    } else if (prev && d.level < 0 && Date.now() - prev.t < FRESH) {
      // приёмник в этот раз не ответил, но устройство недавно было на связи — показываем последний заряд
      d.connected = true; d.level = prev.level; d.stale = true;
    } else if (prev) d.last = prev.level;
    else if (!d.connected && d.level > 0) d.last = d.level;
  }
  if (changed) store.set('devLast2', devLast);
  return list;
}
const liveHooks = new Set();
let artUrl = '', artSrc = '';
bar.onSensors((p) => {
  Object.assign(S, p);
  if ('bt' in p || 'hid' in p) S.btLoaded = true;
  if (p.stats) lastStats = p.stats;
  if ('media' in p) syncMedia();
  renderBar();
  liveHooks.forEach((f) => f(p));
});
function syncMedia() {
  const m = S.media;
  const src = m && m.art ? m.art : '';
  if (src !== artSrc) {
    artSrc = src;
    if (artUrl) URL.revokeObjectURL(artUrl);
    artUrl = '';
    if (src) fetch(src).then((r) => r.blob()).then((b) => { if (artSrc === src) { artUrl = URL.createObjectURL(b); renderBar(); liveHooks.forEach((f) => f({ media: S.media })); } }).catch(() => {});
  }
  const show = indOn('media') && m && m.playing && m.title;
  if (show && m.title !== syncMedia.last) { syncMedia.last = m.title; wakeLive(); } // новый трек — эквалайзер оживает
  setAct('media', show ? { html: () => `${artUrl ? `<img class="art-mini" src="${artUrl}" alt="">` : icon('music')}<span class="eq"><i></i><i></i><i></i></span><span class="trk">${esc(m.title)}</span>` } : null);
}

const IND_DEFAULT = { media: true, layout: true, volume: true, mic: true, bt: true, net: true, speed: false, cpu: false, ram: false, battery: true, awake: true, date: true };
let indCfg = { ...IND_DEFAULT, ...store.get('ind', {}) };
const indOn = (id) => !!indCfg[id];
function setInd(id, on) { indCfg[id] = on; store.set('ind', indCfg); pushNeed(); if (id === 'media') syncMedia(); renderBar(); }
function pushNeed() {
  bar.sensorsNeed({
    open: state === 'open', layout: indOn('layout'), audio: indOn('volume') || indOn('mic'), media: indOn('media'),
    net: indOn('net') || indOn('speed'), bt: indOn('bt'), stats: indOn('cpu') || indOn('ram'),
  });
}

const fmtRate = (b) => b < 1024 ? '0 КБ/с' : b < 1048576 ? Math.round(b / 1024) + ' КБ/с' : (b / 1048576).toFixed(1).replace('.', ',') + ' МБ/с';
const devIcon = (name, kind) => kind ? kind : /controller|gamepad|xbox|dualsense|dualshock|геймпад/i.test(name) ? 'gamepad'
  : /mouse|мыш|mx /i.test(name) ? 'mouse' : /keyboard|клав|keys/i.test(name) ? 'keyboard'
  : /bud|pods|head|наушн|wh-|wf-|jbl|sony|bose|beats|sennheiser|jabra|honor|galaxy/i.test(name) ? 'headphones' : 'bluetooth';
const wifiSvg = (sig) => icon(sig >= 70 ? 'wifi' : sig >= 40 ? 'wifihigh' : 'wifilow');

const IND = [
  { id: 'media', name: 'Сейчас играет', desc: 'обложка и название трека, пока играет' },
  { id: 'layout', name: 'Раскладка', desc: 'язык ввода активного окна', html: () => !S.layout ? '' : state === 'open'
    ? `<button class="kb-ind kb-btn" data-do="layout" title="Раскладка: нажмите, чтобы выбрать">${esc(S.layout.slice(0, 2).toUpperCase())}</button>`
    : `<span class="kb-ind">${esc(S.layout.slice(0, 2).toUpperCase())}</span>` },
  { id: 'mic', name: 'Микрофон выключен', desc: 'значок, только когда микрофон без звука', html: () => S.audio && S.audio.micMuted ? `<span class="ind red-t" title="Микрофон выключен">${icon('micoff')}</span>` : '' },
  { id: 'volume', name: 'Громкость', desc: 'уровень и «без звука»', html: () => S.audio ? `<span class="ind${S.audio.muted ? ' mut' : ''}" title="Громкость">${icon(S.audio.muted ? 'mute' : S.audio.volume < 40 ? 'voldown' : 'volup')}${S.audio.muted ? '' : S.audio.volume + '%'}</span>` : '' },
  { id: 'bt', name: 'Беспроводные устройства', desc: 'заряд мыши, наушников, геймпадов', html: () => devList().filter((d) => d.connected && d.level >= 0).map((d) => `<span class="ind${d.level <= 20 && !d.charging ? ' red-t' : ''}" title="${esc(d.name)}${d.charging ? ' · заряжается' : ''}">${icon(devIcon(d.name, d.kind))}${d.charging ? `<span class="hi-t">${icon('bolt')}</span>` : ''}${d.level}%</span>`).join('') },
  { id: 'net', name: 'Сеть', desc: 'Ethernet, Wi‑Fi и сигнал', html: () => {
    const n = S.net; if (!n) return '';
    if (!n.online) return `<span class="ind red-t" title="Нет сети">${icon('offline')}</span>`;
    if (n.ethernet) return `<span class="ind" title="Ethernet ${esc(n.ethSpeed)}">${icon('ethernet')}</span>`;
    return n.wifi ? `<span class="ind" title="${esc(n.wifi.ssid)} · ${n.wifi.signal}%">${wifiSvg(n.wifi.signal)}</span>` : '';
  } },
  { id: 'speed', name: 'Скорость сети', desc: 'загрузка в реальном времени', html: () => S.net && S.net.online ? `<span class="ind" title="Отдача ${fmtRate(S.net.txs)}">↓ ${fmtRate(S.net.rxs)}</span>` : '' },
  { id: 'cpu', name: 'Процессор', desc: 'загрузка CPU', html: () => S.stats ? `<span class="ind" title="Загрузка процессора">${icon('cpu')}${S.stats.cpu}%</span>` : '' },
  { id: 'ram', name: 'Память', desc: 'занято ОЗУ', html: () => S.stats ? `<span class="ind" title="Занято памяти">${icon('ram')}${Math.round(S.stats.memUsed / S.stats.memTotal * 100)}%</span>` : '' },
  { id: 'battery', name: 'Батарея ПК', desc: 'только на ноутбуке', html: () => batt ? battHtml() : '' },
  { id: 'awake', name: 'Не засыпать', desc: 'значок, пока экран не гаснет', html: () => Toggles.awake ? `<span class="ind hi-t" title="Экран не гаснет">${icon('coffee')}</span>` : '' },
  { id: 'date', name: 'Дата', desc: 'день недели и число', html: () => `<span class="sub">${new Date().toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric' })}</span>` },
];
const indHtml = (skipDate) => IND.filter((x) => x.html && indOn(x.id) && !(skipDate && x.id === 'date')).map((x) => x.html()).join('');
const Toggles = { awake: false };

// ============ верхняя строка ============
const barEl = $('#bar');
const barL = h('div', { class: 'l' }), barR = h('div', { class: 'r' });
const srchInput = h('input', { class: 'srch-in', placeholder: 'Поиск', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Поиск: приложения, файлы, инструменты, расчёты' });
const srchKbd = h('kbd', { class: 'srch-k' });
const srchBox = h('label', { class: 'srch', title: 'Приложения, файлы, инструменты Bar, расчёты' }, I('search'), srchInput, srchKbd);
barEl.append(barL, srchBox, barR);
const clockStr = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
// Дата в раскрытой шапке: «вторник, 24 ноября», а если справа много показателей и поиску не хватает места — «вт, 24 нояб.»
const textW = (() => { const c = document.createElement('canvas').getContext('2d'); const cache = new Map();
  return (t, font) => { const k = font + t; if (!cache.has(k)) { c.font = font; cache.set(k, c.measureText(t).width); } return cache.get(k); }; })();
function homeDate() {
  const d = new Date();
  const long = d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const cs = getComputedStyle(barEl);
  const font = `400 ${cs.fontSize} ${cs.fontFamily}`;
  // ширина панели − поля − часы − показатели справа − промежутки − минимальная ширина поиска
  const free = barEl.clientWidth - 32 - 60 - barR.scrollWidth - 3 * 8 - 200;
  return textW(long, font) <= free ? long : d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
}

function renderBar() {
  // в раскрытой панели трек и так виден в карточке «Сейчас играет» — в шапке его не дублируем
  const a = topAct(state === 'open' ? 'media' : null);
  let L, R;
  if (state === 'open') {
    const tool = current && TOOLS_BY_ID[current];
    L = tool
      ? `<button class="ib" data-do="back" title="Назад (Esc)">${icon('back')}</button><span class="title">${esc(tool.name)}</span>`
      : `<span class="title">${clockStr()}</span><span class="sub">${homeDate()}</span>`;
    const muBtns = current === 'music' && MU.ext && MU.tab
      ? `<button class="ib" data-do="mu-tab" title="Открыть вкладку YouTube Music">${icon('link')}</button><button class="ib ${MUctl.editing ? 'on' : ''}" data-do="mu-layout" title="${MUctl.editing ? 'Готово' : 'Раскладка: размеры и расположение блоков'}">${icon('layout')}</button>`
      : '';
    R = `${a ? `<span class="act">${a.html()}</span>` : ''}<span class="inds">${indHtml(!tool)}</span>${muBtns}<button class="ib ${pinned ? 'on' : ''}" data-do="pin" title="Закрепить открытым">${icon('pin')}</button>`;
  } else if (a) {
    L = a.html();
    R = `<span class="inds">${indHtml(true)}</span><span>${clockStr()}</span>`;
  } else {
    L = `<span>${clockStr()}</span>`;
    R = `<span class="inds">${indHtml(false)}</span>`;
  }
  // перерисовываем строку только при реальных изменениях — иначе кнопки под мышью мигают
  if (L !== barL._html) { barL._html = L; barL.innerHTML = L; }
  if (R !== barR._html) { barR._html = R; barR.innerHTML = R; }
  barEl.classList.toggle('with-srch', state === 'open' && !current);
  if (state !== 'open') {
    // ширина свёрнутого нотча — ровно под содержимое
    // поля 16+16 и один промежуток между группами — как между остальными элементами строки
    const w = barL.scrollWidth + barR.scrollWidth + 32 + 14;
    island.style.setProperty('--pill-w', Math.max(196, Math.min(620, Math.ceil(w))) + 'px');
  }
}
barEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-do]');
  if (!b) return;
  if (b.dataset.do === 'back') goHome();
  if (b.dataset.do === 'pin') { pinned = !pinned; renderBar(); }
  if (b.dataset.do === 'mu-tab') bar.musicOpen();
  if (b.dataset.do === 'layout') pickLayout();
  if (b.dataset.do === 'mu-layout' && MUctl.toggleEdit) MUctl.toggleEdit();
});

// выбор раскладки вручную: меню из установленных в Windows; переключается окно, в котором вы печатали
async function pickLayout() {
  const list = await bar.layouts();
  if (!list.length) return;
  const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const pick = await bar.popupMenu(list.map((l) => ({ id: l.hkl, label: `${l.lang.slice(0, 2).toUpperCase()}   ${cap(l.name || l.lang)}`, checked: l.current })));
  if (!pick) return;
  const lang = await bar.setLayout(pick);
  if (lang) { S.layout = lang; renderBar(); }
  if (!pinned) collapse(true); // фокус вернулся в окно — можно сразу печатать
}

// единый «тик» раз в секунду, выровненный по границе секунды
const tickers = new Set();
// Раз в секунду — только пока панель открыта или идёт таймер / секундомер / запись.
// Свёрнутый нотч без таких активностей обновляется раз в минуту: часы показывают только минуты.
let tickT = 0;
const needFastTick = () => state === 'open' || ['timer', 'stopwatch', 'rec', 'busy'].some((k) => acts.has(k));
function schedTick() {
  clearTimeout(tickT);
  const now = Date.now();
  tickT = setTimeout(tick, needFastTick() ? 1000 - (now % 1000) + 5 : 60000 - (now % 60000) + 20);
}
function tick() { renderBar(); tickers.forEach((f) => f()); schedTick(); }
tick();

// ============ навигация ============
const homeEl = $('#home');
const toolEl = $('#tool');
function openTool(id, payload) {
  const tool = TOOLS_BY_ID[id];
  if (!tool) return;
  if (cleanup) { try { cleanup(); } catch {} }
  cleanup = null;
  current = id;
  if (Srch.q) { srchInput.value = ''; Srch.q = ''; srchBox.classList.remove('has'); searchEl.hidden = true; Srch.seq++; }
  if (tool.height) island.style.setProperty('--h-open', tool.height() + 'px'); else island.style.removeProperty('--h-open');
  toolEl.innerHTML = '';
  const body = h('div', { class: 'tool' });
  toolEl.append(body);
  homeEl.hidden = true;
  toolEl.hidden = false;
  cleanup = tool.view(body, payload) || null;
  renderBar();
}
function goHome() {
  if (cleanup) { try { cleanup(); } catch {} }
  cleanup = null;
  current = null;
  island.style.removeProperty('--h-open');
  toolEl.hidden = true;
  homeEl.hidden = false;
  renderHome();
  renderBar();
}

// ============ горячие клавиши (настраиваются в Настройках) ============
const HK = { map: {}, status: {} };
const hkText = (a) => (a || '').replace(/Super|Meta/g, 'Win').replace(/CommandOrControl|Control/g, 'Ctrl');
const hk = (id) => (HK.status[id] === 'ok' ? hkText(HK.map[id]) : '');
bar.hotkeysGet().then((x) => { Object.assign(HK, x); if (state === 'open' && !current) renderHome(); });
bar.onHotkeys((x) => { Object.assign(HK, x); });

// ============ инструменты ============
const TOOLS = [];
const TOOLS_BY_ID = {};
const tool = (t) => { TOOLS.push(t); TOOLS_BY_ID[t.id] = t; };

// ---- 1. Текст с экрана (OCR) ----
const ocrHist = store.get('ocrHist', []);
tool({
  id: 'ocr', name: 'Текст с экрана', short: 'Распознать', icon: 'ocr', hk: 'ocr',
  view(el, res) {
    const ta = h('textarea', { class: 'field grow', rows: 9, placeholder: 'Выделите область на экране — распознанный текст появится здесь и сразу попадёт в буфер обмена.\n\nРаботает на встроенном OCR Windows: без интернета, с русским и английским.' });
    if (res && res.text != null) ta.value = res.text;
    else if (ocrHist[0]) ta.value = ocrHist[0];
    el.append(
      h('div', { class: 'row' },
        h('button', { class: 'btn pri', onclick: () => bar.capture('ocr') }, I('ocr'), 'Выделить область'),
        h('button', { class: 'btn', onclick: () => copy(ta.value) }, I('copy'), 'Копировать'),
        h('button', { class: 'btn', onclick: () => { ta.value = fixLayout(ta.value); } }, 'Исправить раскладку'),
        h('button', { class: 'btn', onclick: () => { ta.value = ta.value.replace(/-\n/g, '').replace(/([^\n])\n(?!\n)/g, '$1 '); } }, 'Склеить строки'),
        h('span', { class: 'grow' }),
        hk('ocr') && h('span', { class: 'muted small' }, h('kbd', { class: 'k' }, hk('ocr')), ' из любого места')),
      ta);
    if (res && res.text === '') el.append(h('div', { class: 'muted small' }, 'Текст не найден. Попробуйте выделить крупнее или выберите язык OCR в настройках.'));
  },
});

// ---- 2. Пипетка ----
const colorHist = store.get('colorHist', []);
const rgbToHsl = (r, g, b) => {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let hh = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh *= 60;
  }
  return [Math.round(hh), Math.round(s * 100), Math.round(l * 100)];
};
const hexToRgb = (hx) => { const n = parseInt(hx.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
const lum = (r, g, b) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
tool({
  id: 'color', name: 'Пипетка', icon: 'color', hk: 'color',
  view(el, res) {
    if (res && res.hex) {
      const i = colorHist.indexOf(res.hex); if (i >= 0) colorHist.splice(i, 1);
      colorHist.unshift(res.hex); colorHist.length = Math.min(colorHist.length, 18); store.set('colorHist', colorHist);
    }
    const render = (hex) => {
      el.innerHTML = '';
      const pick = h('button', { class: 'btn pri', onclick: () => bar.capture('color') }, I('color'), 'Взять цвет с экрана');
      if (!hex) {
        el.append(h('div', { class: 'hero' }, h('div', { class: 'big' }, 'Любой пиксель экрана — в HEX, RGB, HSL'), h('div', { class: 'muted' }, 'Лупа ×12, стрелки для точного наведения' + (hk('color') ? ', ' + hk('color') + ' откуда угодно' : '')), pick));
        return;
      }
      const [r, g, b] = hexToRgb(hex);
      const [H, S, L] = rgbToHsl(r, g, b);
      const L0 = lum(r, g, b);
      const cW = (1.05 / (L0 + 0.05)).toFixed(1), cB = ((L0 + 0.05) / 0.05).toFixed(1);
      const textCol = L0 > 0.4 ? '#000' : '#fff';
      const chip = (label, val) => h('button', { class: 'chip', onclick: () => copy(val, `${val} скопирован`) }, h('span', {}, label), val);
      const shades = h('div', { class: 'shades' });
      for (let k = -4; k <= 4; k++) {
        const t = k / 5;
        const c = t < 0 ? rgbToHex(r * (1 + t), g * (1 + t), b * (1 + t)) : rgbToHex(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t);
        shades.append(h('button', { style: { background: c }, title: c, onclick: () => copy(c, `${c} скопирован`) }));
      }
      const hist = h('div', { class: 'hist' }, colorHist.map((c) => h('button', { style: { background: c }, title: c, onclick: () => render(c) })));
      el.append(h('div', { class: 'split' },
        h('div', { class: 'col' },
          h('div', { class: 'swatch', style: { background: hex, color: textCol } }, hex),
          h('div', { class: 'muted small' }, `Контраст: на белом ${cW}:1 · на чёрном ${cB}:1`),
          h('div', { class: 'row' }, pick)),
        h('div', { class: 'col' },
          h('div', { class: 'chips' }, chip('HEX', hex), chip('RGB', `rgb(${r}, ${g}, ${b})`), chip('HSL', `hsl(${H}, ${S}%, ${L}%)`), chip('CSS var', `--color: ${hex};`)),
          h('div', { class: 'muted small' }, 'Оттенки — клик копирует'), shades,
          h('div', { class: 'muted small' }, 'История'), hist)));
    };
    render((res && res.hex) || colorHist[0]);
  },
});

// ---- 3. Сканер QR ----
tool({
  id: 'qrscan', name: 'Сканер QR', short: 'Скан QR', icon: 'qrscan', hk: 'qrscan',
  view(el, res) {
    const scan = (cls) => h('button', { class: 'btn ' + cls, onclick: () => bar.capture('qrscan') }, I('qrscan'), 'Сканировать с экрана');
    if (!res) {
      el.append(h('div', { class: 'hero' }, h('div', { class: 'big' }, 'Считать QR-код прямо с экрана'), h('div', { class: 'muted' }, 'Выделите код или нажмите Enter — найдём сами. Ссылки открываются в браузере.'), scan('pri')));
      return;
    }
    if (!res.text) {
      el.append(h('div', { class: 'hero' }, h('div', { class: 'big' }, 'QR-код не найден'), h('div', { class: 'muted' }, 'Выделите код плотнее или нажмите Enter, чтобы искать по всему экрану'), scan('pri')));
      return;
    }
    const isUrl = /^https?:\/\//i.test(res.text);
    const text = res.text.length > 400 ? res.text.slice(0, 400) + '…' : res.text;
    el.append(h('div', { class: 'hero' },
      h('span', { class: 'cap' }, (isUrl ? 'Ссылка' : 'Текст') + ' из QR-кода · уже в буфере обмена'),
      h('div', { class: 'big-link' }, text),
      h('div', { class: 'row', style: { justifyContent: 'center' } },
        isUrl && h('button', { class: 'btn pri', onclick: () => bar.openUrl(res.text) }, I('link'), 'Открыть'),
        h('button', { class: 'btn' + (isUrl ? '' : ' pri'), onclick: () => copy(res.text) }, I('copy'), 'Копировать'),
        scan(''))));
  },
});

// ---- 4. Скриншот ----
tool({
  id: 'shot', name: 'Скриншот', icon: 'shot', hk: 'shot',
  view(el, res) {
    const btn = h('button', { class: 'btn pri', onclick: () => bar.capture('shot') }, I('shot'), 'Выделить область');
    if (!res) {
      el.append(h('div', { class: 'hero' }, h('div', { class: 'big' }, 'Скриншот области — сразу в буфер и в папку'), h('div', { class: 'muted' }, 'Enter — весь экран. Документы → Bar → Screenshots'), h('div', { class: 'row' }, btn, h('button', { class: 'btn', onclick: () => bar.openDir('Screenshots') }, I('folder'), 'Папка'))));
      return;
    }
    el.append(
      h('div', { class: 'hero' }, h('img', { class: 'shot-img', src: res.thumb, draggable: false }), h('div', { class: 'muted small' }, 'Скопировано в буфер обмена и сохранено')),
      h('div', { class: 'row' }, btn,
        h('button', { class: 'btn', onclick: () => bar.openPath(res.path) }, 'Открыть'),
        h('button', { class: 'btn', onclick: () => bar.showInFolder(res.path) }, I('folder'), 'Показать в папке'),
        h('button', { class: 'btn', onclick: () => Shelf.add([res.path]) }, I('shelf'), 'На полку')));
  },
});

// ---- 5. Создать QR ----
tool({
  id: 'qrmake', name: 'Создать QR', short: 'QR-код', icon: 'qrmake',
  view(el) {
    let mode = 'text', timer = 0;
    const img = h('img', { class: 'qr-img', alt: 'QR-код', hidden: true });
    const ph = h('div', { class: 'qr-ph' }, 'Введите текст или ссылку — код появится здесь');
    const ta = h('textarea', { class: 'field grow', placeholder: 'Текст или ссылка' });
    const ssid = h('input', { class: 'field', placeholder: 'Имя сети (SSID)' });
    const pass = h('input', { class: 'field', placeholder: 'Пароль' });
    const wifiBox = h('div', { class: 'col', hidden: true }, ssid, pass, h('div', { class: 'muted small' }, 'Телефон подключится к Wi‑Fi, просто наведя камеру.'));
    const copyBtn = h('button', { class: 'btn pri', onclick: () => { bar.clipImage(img.src); flash('QR скопирован'); } }, I('copy'), 'Копировать картинку');
    const wEsc = (x) => x.replace(/([\\;,:"])/g, '\\$1');
    const payload = () => mode === 'wifi' ? `WIFI:T:${pass.value ? 'WPA' : 'nopass'};S:${wEsc(ssid.value)};P:${wEsc(pass.value)};;` : ta.value;
    const update = () => {
      clearTimeout(timer);
      const empty = mode === 'wifi' ? !ssid.value.trim() : !ta.value.trim();
      ph.textContent = mode === 'wifi' ? 'Введите имя сети — код появится здесь' : 'Введите текст или ссылку — код появится здесь';
      img.hidden = empty; ph.hidden = !empty; copyBtn.disabled = empty;
      if (!empty) timer = setTimeout(async () => { img.src = await bar.qr(payload()); }, 120);
    };
    [ta, ssid, pass].forEach((x) => x.addEventListener('input', update));
    const seg = h('div', { class: 'seg' },
      h('button', { class: 'on', onclick: (e) => setMode('text', e.currentTarget) }, 'Текст'),
      h('button', { onclick: (e) => setMode('wifi', e.currentTarget) }, 'Wi‑Fi'));
    function setMode(m, b) { mode = m; seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); ta.hidden = m !== 'text'; wifiBox.hidden = m !== 'wifi'; update(); }
    el.append(h('div', { class: 'split', style: { gridTemplateColumns: '1fr auto' } },
      h('div', { class: 'col' }, seg, ta, wifiBox),
      // кнопка копирования — под самой картинкой, к которой относится
      h('div', { class: 'col qr-side' }, img, ph, copyBtn)));
    update();
    bar.clipRead().then((t) => { t = (t || '').trim(); if (t.length <= 300 && !ta.value) { ta.value = t; update(); } });
  },
});

// ---- 6. Таймер / помодоро ----
const Timer = {
  end: 0, total: 0, left: 0, paused: false, label: '',
  running() { return this.end > 0 || this.paused; },
  remaining() { return this.paused ? this.left : Math.max(0, this.end - Date.now()); },
  start(sec, label = '') { this.total = sec * 1000; this.end = Date.now() + this.total; this.paused = false; this.label = label; this.sync(); },
  add(sec) { if (this.paused) this.left += sec * 1000; else this.end += sec * 1000; this.total += sec * 1000; this.sync(); },
  pause() { if (this.paused) { this.end = Date.now() + this.left; this.paused = false; } else { this.left = this.remaining(); this.paused = true; this.end = 0; } this.sync(); },
  stop() { this.end = 0; this.paused = false; this.total = 0; this.label = ''; this.sync(); },
  sync() {
    if (this.running()) {
      setAct('timer', { html: () => `${ringSvg(this.total ? this.remaining() / this.total : 0)}<span class="hi-t">${fmtDur(this.remaining())}</span>${this.label ? `<span class="sub">${esc(this.label)}</span>` : ''}` });
    } else setAct('timer', null);
  },
  tick() {
    if (!this.paused && this.end && Date.now() >= this.end) {
      const label = this.label || 'Таймер';
      this.stop();
      chime();
      island.classList.remove('alert'); void island.offsetWidth; island.classList.add('alert');
      setTimeout(() => island.classList.remove('alert'), 4200);
      flash(`${label}: время вышло`, 6000);
      try { new Notification('Bar · ' + label, { body: 'Время вышло', silent: true }); } catch {}
    }
  },
};
tickers.add(() => Timer.tick());
function chime() {
  try {
    const ac = new AudioContext();
    [0, 0.18, 0.36].forEach((t, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = [880, 1108.7, 1318.5][i];
      g.gain.setValueAtTime(0.0001, ac.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t + 0.6);
      o.connect(g).connect(ac.destination); o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.65);
    });
    setTimeout(() => ac.close(), 1500);
  } catch {}
}
tool({
  id: 'timer', name: 'Таймер', icon: 'timer',
  sticky: () => false,
  view(el) {
    const C = 2 * Math.PI * 95;
    const face = h('div', { class: 'timer-face', html: `<svg viewBox="0 0 210 210"><circle class="bg" cx="105" cy="105" r="95"/><circle class="fg" cx="105" cy="105" r="95" stroke-dasharray="${C}"/></svg><div class="val"></div><div class="lbl"></div>` });
    const fg = $('.fg', face), val = $('.val', face), lbl = $('.lbl', face);
    const custom = h('input', { class: 'field', type: 'number', min: 1, max: 600, placeholder: 'мин', style: { width: '80px' } });
    const ctl = h('div', { class: 'row' });
    const P = [['Фокус', 25, 'Фокус'], ['Перерыв', 5, 'Перерыв'], ['Длинный', 15, 'Отдых'], ['1 мин', 1, ''], ['3 мин', 3, ''], ['10 мин', 10, '']];
    const presets = h('div', { class: 'presets' }, P.map(([t, m, l]) => h('button', { class: 'btn', onclick: () => { Timer.start(m * 60, l); upd(); } }, t, l && h('span', { class: 'muted' }, ` ${m} мин`))));
    const upd = () => {
      const run = Timer.running();
      const rem = run ? Timer.remaining() : 0;
      val.textContent = fmtDur(rem);
      lbl.textContent = Timer.label || (run ? '' : 'выберите время');
      fg.style.strokeDashoffset = run && Timer.total ? C * (1 - rem / Timer.total) : C;
      ctl.innerHTML = '';
      if (run) {
        ctl.append(
          h('button', { class: 'btn hi', onclick: () => { Timer.pause(); upd(); } }, I(Timer.paused ? 'play' : 'pause'), Timer.paused ? 'Продолжить' : 'Пауза'),
          h('button', { class: 'btn', onclick: () => { Timer.add(60); upd(); } }, '+1 мин'),
          h('button', { class: 'btn', onclick: () => { Timer.stop(); upd(); } }, I('x'), 'Сброс'));
      } else {
        ctl.append(custom, h('button', { class: 'btn pri', onclick: () => { const m = +custom.value; if (m > 0) { Timer.start(Math.round(m * 60)); upd(); } } }, I('play'), 'Старт'));
      }
    };
    custom.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const m = +custom.value; if (m > 0) { Timer.start(Math.round(m * 60)); upd(); } } });
    el.append(h('div', { class: 'split', style: { gridTemplateColumns: 'auto 1fr', alignItems: 'center', gap: '28px' } },
      face, h('div', { class: 'col' }, presets, ctl, h('div', { class: 'muted small' }, 'Отсчёт виден прямо в свёрнутом нотче. По окончании — звук, вспышка и уведомление.'))));
    upd();
    tickers.add(upd);
    return () => tickers.delete(upd);
  },
});

// ---- 7. Секундомер ----
const SW = {
  start: 0, acc: 0, laps: [],
  running() { return this.start > 0; },
  elapsed() { return this.acc + (this.start ? Date.now() - this.start : 0); },
  toggle() { if (this.start) { this.acc += Date.now() - this.start; this.start = 0; } else this.start = Date.now(); this.sync(); },
  lap() { this.laps.unshift(this.elapsed()); },
  reset() { this.start = 0; this.acc = 0; this.laps = []; this.sync(); },
  sync() { setAct('stopwatch', this.running() ? { html: () => `<span class="dot"></span><span>${fmtDur(this.elapsed(), false)}</span>` } : null); },
};
const fmtMs = (ms) => `${fmtDur(ms, false)}.${pad(Math.floor((ms % 1000) / 10))}`;
tool({
  id: 'stopwatch', name: 'Секундомер', icon: 'stopwatch',
  view(el) {
    const v = h('div', { class: 'sw-val' });
    const ctl = h('div', { class: 'row', style: { justifyContent: 'center' } });
    const laps = h('div', { class: 'list' });
    const lapsCol = h('div', { class: 'col' }, h('span', { class: 'cap' }, 'Круги'), laps);
    const wrap = h('div', { class: 'split' }, h('div', { class: 'hero' }, v, ctl), lapsCol);
    let raf = 0;
    const frame = () => { v.textContent = fmtMs(SW.elapsed()); raf = SW.running() ? requestAnimationFrame(frame) : 0; };
    const upd = () => {
      cancelAnimationFrame(raf); frame();
      const run = SW.running(), has = SW.laps.length > 0;
      wrap.style.gridTemplateColumns = has ? '1fr 1fr' : '1fr';
      lapsCol.hidden = !has;
      ctl.replaceChildren(...[
        h('button', { class: 'btn ' + (run ? 'hi' : 'pri'), onclick: () => { SW.toggle(); upd(); } }, I(run ? 'pause' : 'play'), run ? 'Стоп' : SW.elapsed() ? 'Продолжить' : 'Старт'),
        run && h('button', { class: 'btn', onclick: () => { SW.lap(); upd(); } }, I('flag'), 'Круг'),
        !run && SW.elapsed() > 0 && h('button', { class: 'btn', onclick: () => { SW.reset(); upd(); } }, I('reset'), 'Сброс'),
      ].filter(Boolean));
      laps.innerHTML = '';
      const diffs = SW.laps.map((t, i) => t - (SW.laps[i + 1] || 0));
      const best = Math.min(...diffs), worst = Math.max(...diffs);
      SW.laps.forEach((t, i) => laps.append(h('div', { class: 'item', style: { cursor: 'default' } },
        h('span', { class: 'muted' }, `Круг ${SW.laps.length - i}`),
        h('span', { class: 'txt', style: { textAlign: 'right' } },
          h('b', { class: diffs.length > 1 && diffs[i] === best ? 'hi-t' : diffs.length > 1 && diffs[i] === worst ? 'red-t' : '' }, fmtMs(diffs[i]))),
        h('span', { class: 'muted', style: { width: '72px', textAlign: 'right' } }, fmtMs(t)))));
    };
    el.append(wrap);
    upd();
    return () => cancelAnimationFrame(raf);
  },
});

// ---- 8. Диктофон ----
const Rec = {
  mr: null, chunks: [], t0: 0, stream: null, analyser: null,
  on() { return !!this.mr; },
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const ac = new AudioContext();
    this.ac = ac;
    this.analyser = ac.createAnalyser(); this.analyser.fftSize = 64;
    ac.createMediaStreamSource(this.stream).connect(this.analyser);
    this.mr = new MediaRecorder(this.stream, { mimeType: 'audio/webm;codecs=opus' });
    this.chunks = [];
    this.mr.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.mr.start(500);
    this.t0 = Date.now();
    setAct('rec', { html: () => `<span class="dot rec"></span><span>${fmtDur(Date.now() - this.t0, false)}</span>` });
  },
  stop() {
    return new Promise((resolve) => {
      if (!this.mr) return resolve(null);
      this.mr.onstop = async () => {
        const blob = new Blob(this.chunks, { type: 'audio/webm' });
        const file = await bar.saveVoice(await blob.arrayBuffer());
        resolve(file);
      };
      this.mr.stop();
      this.stream.getTracks().forEach((t) => t.stop());
      try { this.ac.close(); } catch {}
      this.mr = null; this.analyser = null;
      setAct('rec', null);
      flash('Запись сохранена');
    });
  },
};
tool({
  id: 'voice', name: 'Диктофон', icon: 'voice',
  sticky: () => Rec.on(),
  view(el) {
    const btn = h('button', { class: 'rec-btn' }, h('i'));
    const time = h('div', { class: 'sw-val mid' }, '00:00');
    const wave = h('div', { class: 'wave' }, Array.from({ length: 22 }, () => h('b')));
    const list = h('div', { class: 'list' });
    let raf = 0;
    const loop = () => {
      if (!Rec.on()) return;
      time.textContent = fmtDur(Date.now() - Rec.t0, false);
      const d = new Uint8Array(Rec.analyser.frequencyBinCount);
      Rec.analyser.getByteFrequencyData(d);
      [...wave.children].forEach((b, i) => { b.style.height = 4 + (d[i + 2] || 0) / 255 * 36 + 'px'; });
      raf = requestAnimationFrame(loop);
    };
    const sync = () => { btn.classList.toggle('on', Rec.on()); if (Rec.on()) loop(); else { time.textContent = '00:00'; [...wave.children].forEach((b) => (b.style.height = '4px')); } };
    btn.onclick = async () => {
      try {
        if (Rec.on()) { await Rec.stop(); loadList(); } else await Rec.start();
      } catch (e) { flash('Нет доступа к микрофону', 3000); }
      sync();
    };
    async function loadList() {
      const files = await bar.listVoice();
      list.innerHTML = '';
      if (!files.length) list.append(h('div', { class: 'empty' }, 'Записей пока нет'));
      for (const f of files) {
        const d = new Date(f.mtime);
        list.append(h('div', { class: 'item', style: { flexDirection: 'column', alignItems: 'stretch', cursor: 'default' } },
          h('div', { class: 'row' }, h('span', { class: 'txt' }, d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })),
            h('button', { class: 'ib', title: 'На полку', onclick: () => Shelf.add([f.path]) }, I('shelf')),
            h('button', { class: 'ib', title: 'Показать в папке', onclick: () => bar.showInFolder(f.path) }, I('folder')),
            h('button', { class: 'ib', title: 'В корзину', onclick: async () => { await bar.trash(f.path); loadList(); } }, I('trash'))),
          h('audio', { controls: true, preload: 'none', src: 'file:///' + f.path.replace(/\\/g, '/') })));
      }
    }
    el.append(h('div', { class: 'split' }, h('div', { class: 'hero' }, btn, time, wave, h('div', { class: 'muted small' }, 'Запись продолжается, даже если нотч свёрнут')), h('div', { class: 'col' }, list)));
    sync(); loadList();
    return () => cancelAnimationFrame(raf);
  },
});

// ---- 9. Заметки ----
tool({
  id: 'notes', name: 'Заметки', icon: 'notes',
  view(el) {
    const notes = store.get('notes', ['', '', '']);
    let idx = store.get('noteIdx', 0);
    const ta = h('textarea', { class: 'field grow', placeholder: 'Пишите — всё сохраняется само' });
    const count = h('span', { class: 'muted small' });
    const seg = h('div', { class: 'seg' }, notes.map((_, i) => h('button', { onclick: () => sel(i) }, `Заметка ${i + 1}`)));
    const upd = () => { const v = ta.value; count.textContent = `${v.length} симв. · ${(v.match(/\S+/g) || []).length} сл.`; };
    function sel(i) { idx = i; store.set('noteIdx', i); ta.value = notes[i] || ''; [...seg.children].forEach((b, k) => b.classList.toggle('on', k === i)); upd(); }
    ta.addEventListener('input', () => { notes[idx] = ta.value; store.set('notes', notes); upd(); });
    el.append(h('div', { class: 'row' }, seg, h('span', { class: 'grow' }), count,
      h('button', { class: 'btn sm', onclick: () => copy(ta.value) }, I('copy'), 'Копировать')), ta);
    sel(idx);
    setTimeout(() => ta.focus(), 50);
  },
});

// ---- 10. Буфер обмена ----
// История живёт в главном процессе (файл clips.json), здесь — только отображение.
let clips = [];
const clipHooks = new Set();
bar.clipsGet().then((list) => {
  clips = list || [];
  // перенос старой истории из localStorage, если она была
  const legacy = store.get('clips', null);
  if (legacy && legacy.length && !clips.length) { clips = legacy; bar.clipsSet(clips); }
  if (legacy) { try { localStorage.removeItem('bar.clips'); } catch {} }
  clipHooks.forEach((f) => f());
});
bar.onClips((list) => { clips = list || []; clipHooks.forEach((f) => f()); });
const saveClips = () => bar.clipsSet(clips);
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return 'только что';
  if (s < 3600) return Math.round(s / 60) + ' мин назад';
  if (s < 86400) return Math.round(s / 3600) + ' ч назад';
  return new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
};
tool({
  id: 'clip', name: 'Буфер обмена', short: 'Буфер', icon: 'clip',
  view(el) {
    const q = h('input', { class: 'field', placeholder: 'Поиск… · Enter — скопировать первое', 'aria-label': 'Поиск по истории буфера' });
    const list = h('div', { class: 'list clip-list' });
    let shown = [];
    const copyItem = (c, row) => {
      bar.clipWrite(c.t);  // главный процесс поднимет строку наверх
      flash('Скопировано');
      if (row) { row.classList.add('copied'); setTimeout(() => row.classList.remove('copied'), 900); }
    };
    const draw = () => {
      const s = q.value.trim().toLowerCase();
      shown = clips.filter((c) => !s || c.t.toLowerCase().includes(s)).sort((a, b) => (b.pin - a.pin) || (b.at - a.at));
      list.replaceChildren();
      if (!shown.length) {
        list.append(h('div', { class: 'empty' }, clips.length ? 'Ничего не найдено' : 'Скопируйте любой текст (Ctrl+C) — он появится здесь.\nКлик по строке копирует её обратно.'));
        return;
      }
      shown.forEach((c, i) => {
        const one = c.t.replace(/\s+/g, ' ').trim();
        const row = h('div', { class: 'item clip-item' + (c.pin ? ' pinned' : ''), role: 'button', tabindex: 0, title: 'Клик — скопировать' },
          h('span', { class: 'clip-n' }, i < 9 ? String(i + 1) : ''),
          h('div', { class: 'clip-body' },
            h('span', { class: 'clip-text' }, one.length > 400 ? one.slice(0, 400) + '…' : one),
            h('span', { class: 'clip-meta' }, ago(c.at) + ' · ' + c.t.length + ' симв.' + (c.t.includes('\n') ? ' · ' + c.t.split('\n').length + ' стр.' : ''))),
          h('span', { class: 'clip-ok', html: icon('check') }),
          h('button', { class: 'ib ' + (c.pin ? 'on' : ''), title: c.pin ? 'Открепить' : 'Закрепить', 'aria-label': 'Закрепить',
            onclick: (e) => { e.stopPropagation(); c.pin = !c.pin; saveClips(); draw(); } }, I('star')),
          h('button', { class: 'ib', title: 'Удалить из истории', 'aria-label': 'Удалить',
            onclick: (e) => { e.stopPropagation(); clips = clips.filter((x) => x !== c); saveClips(); draw(); } }, I('x')));
        row.addEventListener('click', () => copyItem(c, row));
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyItem(c, row); } });
        list.append(row);
      });
    };
    q.addEventListener('input', draw);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && shown[0]) copyItem(shown[0], list.firstChild); });
    // цифры 1–9 копируют строку с этим номером (когда фокус не в поиске)
    const onKey = (e) => {
      if (document.activeElement === q || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && shown[n - 1]) { e.preventDefault(); copyItem(shown[n - 1], list.children[n - 1]); }
    };
    window.addEventListener('keydown', onKey);
    clipHooks.add(draw);
    const tick = setInterval(draw, 30000); // «только что» → «1 мин назад»
    el.append(h('div', { class: 'row' }, h('div', { class: 'grow' }, q),
      h('button', { class: 'btn', onclick: () => { clips = clips.filter((c) => c.pin); saveClips(); draw(); } }, 'Очистить, кроме ★')), list,
      h('div', { class: 'muted small' }, 'Клик или цифра 1–9 — скопировать · ★ — закрепить, такие строки не удаляются при очистке'));
    draw();
    return () => { clipHooks.delete(draw); window.removeEventListener('keydown', onKey); clearInterval(tick); };
  },
});

// ---- 11. Полка файлов ----
const Shelf = {
  items: store.get('shelf', []),
  save() { store.set('shelf', this.items); bar.bridgeFiles(this.items.map((i) => i.path)); },
  add(paths) {
    for (const p of paths) if (!this.items.some((i) => i.path === p)) this.items.unshift({ path: p, name: p.split(/[\\/]/).pop() });
    this.save();
    flash(`На полке: ${this.items.length}`);
    if (current === 'shelf') openTool('shelf');
  },
  remove(p) { this.items = this.items.filter((i) => i.path !== p); this.save(); },
};
bar.bridgeFiles(Shelf.items.map((i) => i.path));
tool({
  id: 'shelf', name: 'Полка', icon: 'shelf',
  view(el) {
    const list = h('div', { class: 'list' });
    const draw = async () => {
      list.innerHTML = '';
      if (!Shelf.items.length) {
        list.append(h('div', { class: 'empty shelf-drop' }, 'Перетащите файлы на нотч — они подождут здесь.\nПотом вытащите их в любое окно или отправьте на телефон.'));
        return;
      }
      for (const it of Shelf.items) {
        const img = h('img', { alt: '' });
        const meta = h('span', { class: 'muted small' });
        const row = h('div', { class: 'item', draggable: true, title: 'Перетащите в любое окно',
          ondragstart: (e) => { e.preventDefault(); bar.startDrag(it.path); },
          ondblclick: () => bar.openPath(it.path) },
        img, h('span', { class: 'txt' }, it.name), meta,
        h('button', { class: 'ib', title: 'Показать в папке', onclick: () => bar.showInFolder(it.path) }, I('folder')),
        h('button', { class: 'ib', title: 'Убрать с полки', onclick: () => { Shelf.remove(it.path); draw(); } }, I('x')));
        list.append(row);
        bar.fileInfo(it.path).then((i) => {
          if (!i.ok) { meta.textContent = 'файл не найден'; row.classList.add('missing'); img.replaceWith(h('span', { class: 'file-ico', html: icon('file') })); return; }
          img.src = i.icon; meta.textContent = i.isDir ? 'папка' : fmtSize(i.size);
        });
      }
    };
    el.append(h('div', { class: 'row' },
      h('span', { class: 'muted grow' }, 'Перетаскивайте файлы на нотч и обратно. Двойной клик — открыть.'),
      h('button', { class: 'btn', onclick: () => openTool('phone') }, I('phone'), 'На телефон'),
      h('button', { class: 'btn', onclick: () => { Shelf.items = []; Shelf.save(); draw(); } }, 'Очистить')), list);
    draw();
  },
});

// ---- 12. Телефон (Wi‑Fi мост) ----
const Bridge = { url: '', qr: '', inbox: store.get('inbox', []) };
const pushInbox = (x) => { Bridge.inbox.unshift({ ...x, at: Date.now() }); Bridge.inbox.length = Math.min(Bridge.inbox.length, 30); store.set('inbox', Bridge.inbox); if (current === 'phone') openTool('phone'); };
bar.onBridgeText((t) => { pushInbox({ kind: 'text', text: t }); flash('Текст с телефона — в буфере', 3000); });
bar.onBridgeFile((f) => { pushInbox({ kind: 'file', ...f }); flash(`Файл с телефона: ${f.name}`, 3000); });
tool({
  id: 'phone', name: 'Телефон', icon: 'phone',
  view(el) {
    const left = h('div', { class: 'hero' });
    const drawLeft = () => {
      left.innerHTML = '';
      if (!Bridge.url) {
        left.append(h('div', { class: 'big' }, 'Связь с телефоном по Wi‑Fi'),
          h('div', { class: 'muted' }, 'Без приложений: наведите камеру на QR. Работает с Android и iPhone в той же сети.'),
          h('button', { class: 'btn pri', onclick: async () => {
            try { Object.assign(Bridge, await bar.bridgeStart(Shelf.items.map((i) => i.path))); setAct('bridge', { html: () => `<span class="dot"></span><span>Телефон</span>` }); } catch { flash('Не удалось открыть порт', 3000); }
            drawLeft();
          } }, I('phone'), 'Включить'));
      } else {
        left.append(h('img', { class: 'qr-img sm', src: Bridge.qr }),
          h('div', { class: 'muted small', style: { userSelect: 'text' } }, 'Файлы с полки тоже доступны'),
          h('button', { class: 'btn', onclick: async () => { await bar.bridgeStop(); Bridge.url = ''; setAct('bridge', null); drawLeft(); } }, 'Выключить'));
      }
    };
    const out = h('textarea', { class: 'field', rows: 3, style: { flex: 'none', height: '76px' }, placeholder: 'Появится на странице телефона' });
    out.addEventListener('input', () => bar.bridgeText(out.value));
    const inbox = h('div', { class: 'list' });
    if (!Bridge.inbox.length) inbox.append(h('div', { class: 'empty' }, 'Здесь появится всё, что пришлёт телефон.\nФайлы: Документы → Bar → From phone'));
    for (const x of Bridge.inbox) {
      inbox.append(x.kind === 'text'
        ? h('div', { class: 'item', onclick: () => copy(x.text) }, I('copy'), h('span', { class: 'txt' }, x.text))
        : h('div', { class: 'item', ondblclick: () => bar.openPath(x.path) }, I('folder'), h('span', { class: 'txt' }, x.name),
          h('button', { class: 'ib', title: 'Показать', onclick: () => bar.showInFolder(x.path) }, I('folder'))));
    }
    el.append(h('div', { class: 'split', style: { gridTemplateColumns: '250px 1fr' } }, left,
      h('div', { class: 'col' }, h('span', { class: 'cap' }, 'Отправить текст на телефон'), out, h('span', { class: 'cap' }, 'Пришло с телефона'), inbox)));
    drawLeft();
  },
});

// ---- 13. Калькулятор ----
function calc(src) {
  const s = src.replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/').replace(/\s+/g, '').toLowerCase();
  let i = 0;
  const FN = { sqrt: Math.sqrt, sin: (x) => Math.sin(x * Math.PI / 180), cos: (x) => Math.cos(x * Math.PI / 180), tan: (x) => Math.tan(x * Math.PI / 180), ln: Math.log, log: Math.log10, abs: Math.abs, round: Math.round };
  const expr = () => { let v = term(); while (s[i] === '+' || s[i] === '-') { const op = s[i++]; let r = term(); if (s[i - 1] === '%') r *= v; v = op === '+' ? v + r : v - r; } return v; };
  const term = () => { let v = power(); while (s[i] === '*' || s[i] === '/') { const op = s[i++]; const r = power(); v = op === '*' ? v * r : v / r; } return v; };
  const power = () => { let v = unary(); if (s[i] === '^') { i++; v = v ** power(); } return v; };
  const unary = () => { if (s[i] === '-') { i++; return -unary(); } if (s[i] === '+') { i++; return unary(); } return postfix(); };
  const postfix = () => { let v = atom(); while (s[i] === '%') { i++; v /= 100; } return v; };
  const atom = () => {
    if (s[i] === '(') { i++; const v = expr(); if (s[i] !== ')') throw new Error(); i++; return v; }
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/.exec(s.slice(i));
    if (m) { i += m[0].length; return parseFloat(m[0]); }
    const f = /^[a-zπ]+/.exec(s.slice(i));
    if (f) {
      i += f[0].length;
      if (f[0] === 'pi' || f[0] === 'π') return Math.PI;
      if (f[0] === 'e') return Math.E;
      if (FN[f[0]]) return FN[f[0]](atom());
    }
    throw new Error();
  };
  const v = expr();
  if (i !== s.length || !isFinite(v)) throw new Error();
  return +v.toPrecision(12);
}
tool({
  id: 'calc', name: 'Калькулятор', icon: 'calc',
  view(el) {
    const hist = store.get('calcHist', []);
    let expr = '', result = null, done = false;
    const nf = (v) => v.toLocaleString('ru-RU', { maximumFractionDigits: 10 });
    const pretty = (x) => x.replace(/\*/g, ' × ').replace(/\//g, ' ÷ ').replace(/\+/g, ' + ')
      .replace(/(?<=[\d)%])-/g, ' − ').replace(/\./g, ',');
    const evalOrNull = (x) => { try { return calc(x); } catch { return null; } };
    const isOp = (c) => '+-*/'.includes(c);

    const histEl = h('div', { class: 'calc-hist' });
    const subEl = h('div', { class: 'calc-sub' });
    const outEl = h('div', { class: 'calc-out', title: 'Клик — скопировать' });
    outEl.onclick = () => { const v = done ? result : evalOrNull(expr); if (v != null) copy(String(v), `${nf(v)} скопировано`); };

    const draw = () => {
      let big, sub;
      if (done) { big = nf(result); sub = pretty(expr) + ' ='; }
      else {
        big = expr ? pretty(expr) : '0';
        const v = /[+\-*/%(]/.test(expr.replace(/^-/, '')) ? evalOrNull(expr) : null;
        sub = v != null ? '= ' + nf(v) : '';
      }
      outEl.textContent = big;
      outEl.className = 'calc-out' + (big.length > 22 ? ' s' : big.length > 12 ? ' m' : '') + (done ? ' done' : '');
      subEl.textContent = sub;
      histEl.innerHTML = '';
      if (!hist.length) histEl.append(h('div', { class: 'calc-tip' }, 'Можно печатать с клавиатуры'));
      [...hist].reverse().forEach((x) => histEl.append(h('div', {
        class: 'calc-line', title: 'Вернуть в расчёт', onclick: () => { expr = String(x.v); done = false; draw(); },
      }, h('span', {}, pretty(x.e) + ' = '), h('b', {}, nf(x.v)))));
      histEl.scrollTop = histEl.scrollHeight;
    };

    function press(k) {
      if (k === 'C') { expr = ''; done = false; }
      else if (k === '⌫') { if (done) { expr = String(result); done = false; } else expr = expr.slice(0, -1); }
      else if (k === '=') {
        const v = evalOrNull(expr);
        if (v == null || !expr) { outEl.classList.remove('shake'); void outEl.offsetWidth; outEl.classList.add('shake'); return; }
        if (!done) { hist.unshift({ e: expr, v }); hist.length = Math.min(hist.length, 30); store.set('calcHist', hist); }
        result = v; done = true;
        bar.clipWrite(String(v)); flash(`${nf(v)} скопировано`);
      } else if (isOp(k)) {
        if (done) { expr = String(result); done = false; }
        if (!expr) { if (k === '-') expr = '-'; }
        else if (isOp(expr.slice(-1))) expr = expr.slice(0, -1) + k;
        else if (expr.slice(-1) !== '(') expr += k;
      } else if (k === '%') {
        if (/[\d)]$/.test(expr)) expr += '%';
      } else if (k === '.') {
        if (done) { expr = ''; done = false; }
        const num = /[\d.]*$/.exec(expr)[0];
        if (!num.includes('.')) expr += num ? '.' : '0.';
      } else if (/^[\d()]$/.test(k)) {
        if (done) { expr = ''; done = false; }
        expr += k;
      }
      draw();
    }

    const KEYS = [
      ['C', 'fn'], ['⌫', 'fn'], ['%', 'fn'], ['/', 'op', '÷'],
      ['7'], ['8'], ['9'], ['*', 'op', '×'],
      ['4'], ['5'], ['6'], ['-', 'op', '−'],
      ['1'], ['2'], ['3'], ['+', 'op', '+'],
      ['0', 'wide'], ['.', '', ','], ['=', 'eq'],
    ];
    const keyEls = {};
    const keys = h('div', { class: 'keys' }, KEYS.map(([k, cls = '', label]) =>
      (keyEls[k] = h('button', { class: 'key ' + cls, onclick: () => press(k) }, label || k))));

    const MAP = { Enter: '=', '=': '=', Backspace: '⌫', Delete: 'C', ',': '.', x: '*', 'х': '*', ':': '/' };
    const onKey = (e) => {
      const low = (e.key || '').toLowerCase();
      if (e.ctrlKey && (low === 'v' || low === 'м')) {
        e.preventDefault();
        bar.clipRead().then((t) => {
          const c = (t || '').replace(/\s/g, '').replace(/,/g, '.').replace(/[×x]/g, '*').replace(/÷/g, '/').replace(/[^\d.+\-*/%()]/g, '');
          if (c) { expr = done ? c : expr + c; done = false; draw(); }
        });
        return;
      }
      if (e.ctrlKey && (low === 'c' || low === 'с')) { outEl.click(); return; }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'Escape' && !expr) return; // пустой — Esc уходит назад
      const k = e.key === 'Escape' ? 'C' : (MAP[e.key] || e.key);
      if (!/^[\d()+\-*/%.=C⌫]$/.test(k)) return;
      e.preventDefault(); e.stopPropagation();
      press(k);
      const btn = keyEls[k];
      if (btn) { btn.classList.add('hit'); setTimeout(() => btn.classList.remove('hit'), 120); }
    };
    window.addEventListener('keydown', onKey, true);

    el.append(h('div', { class: 'calc' }, h('div', { class: 'calc-screen' }, histEl, subEl, outEl), keys));
    draw();
    bar.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  },
});

// ---- 14. Текст: раскладка, регистр, транслит ----
const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,./`QWERTYUIOP{}ASDFGHJKL:\"ZXCVBNM<>?~";
const RU = 'йцукенгшщзхъфывапролджэячсмитьбю.ёЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮ,Ё';
function fixLayout(t) {
  const cyr = (t.match(/[а-яё]/gi) || []).length, lat = (t.match(/[a-z]/gi) || []).length;
  const [from, to] = lat >= cyr ? [EN, RU] : [RU, EN];
  return [...t].map((c) => { const k = from.indexOf(c); return k >= 0 ? to[k] : c; }).join('');
}
const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const translit = (t) => [...t].map((c) => { const l = c.toLowerCase(); if (!(l in TR)) return c; const r = TR[l]; return c === l ? r : r.charAt(0).toUpperCase() + r.slice(1); }).join('');
tool({
  id: 'text', name: 'Текст', icon: 'text',
  view(el) {
    const ta = h('textarea', { class: 'field grow', placeholder: 'Вставьте текст. Например «ghbdtn vbh» → «привет мир»' });
    const stat = h('span', { class: 'muted small' });
    const upd = () => { const v = ta.value; stat.textContent = `${v.length} симв. · ${v.replace(/\s/g, '').length} без пробелов · ${(v.match(/\S+/g) || []).length} сл. · ${v ? v.split('\n').length : 0} стр.`; };
    const act = (label, fn) => h('button', { class: 'btn sm', onclick: () => { ta.value = fn(ta.value); upd(); } }, label);
    ta.addEventListener('input', upd);
    el.append(
      h('div', { class: 'row' },
        act('⇄ Раскладка', fixLayout),
        act('ВЕРХНИЙ', (t) => t.toUpperCase()),
        act('нижний', (t) => t.toLowerCase()),
        act('Каждое Слово', (t) => t.toLowerCase().replace(/(^|[\s\-«"(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())),
        act('Как в предложении', (t) => t.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (m, a, b) => a + b.toUpperCase())),
        act('Транслит', translit),
        act('Убрать лишние пробелы', (t) => t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()),
        act('«Ёлочки»', (t) => t.replace(/"([^"]*)"/g, '«$1»'))),
      ta,
      h('div', { class: 'row' }, stat, h('span', { class: 'grow' }), h('button', { class: 'btn pri', onclick: () => copy(ta.value) }, I('copy'), 'Копировать')));
    bar.clipRead().then((t) => { ta.value = t || ''; upd(); });
  },
});

// ---- 15. Система ----
let lastStats = null;
const pollStats = async () => { try { lastStats = await bar.stats(); } catch {} return lastStats; };
tool({
  id: 'system', name: 'Система', icon: 'system',
  view(el) {
    const box = h('div', { class: 'col', style: { flex: '1' } });
    el.append(box);
    const up = (u) => { const d = Math.floor(u / 86400), hh = Math.floor(u % 86400 / 3600), m = Math.floor(u % 3600 / 60); return d ? `${d} д ${hh} ч` : hh ? `${hh} ч ${m} мин` : `${m} мин`; };
    const metric = (label, big, sub, pct, color) => h('div', { class: 'card metric col', style: { gap: '4px' } },
      h('span', { class: 'cap' }, label), h('div', { class: 'big' }, big), h('span', { class: 'muted small' }, sub),
      pct != null && h('div', { class: 'meter' }, h('b', { style: { width: pct + '%', background: color || '' } })));
    const kv = (a, b) => h('div', { class: 'kv' }, a, h('b', { title: b }, b));
    const draw = async () => {
      const s = await pollStats(); if (!s) return;
      const memP = Math.round(s.memUsed / s.memTotal * 100);
      box.replaceChildren(
        h('div', { class: 'grid3' },
          metric('Процессор', s.cpu + '%', `${s.cores} потоков`, s.cpu),
          metric('Память', memP + '%', `${fmtSize(s.memUsed)} из ${fmtSize(s.memTotal)}`, memP, 'var(--hi-g)'),
          batt ? metric('Батарея', batt.level + '%', batt.charging ? 'заряжается' : 'от батареи', batt.level, batt.level <= 15 ? 'var(--red-g)' : 'var(--hi-g)')
            : metric('Без перезагрузки', up(s.uptime), 'с последнего включения')),
        h('div', { class: 'card', style: { flex: '1' } },
          kv('Имя компьютера', s.host), kv('IP в локальной сети', s.ip), kv('Процессор', s.cpuName.trim()),
          batt && kv('Без перезагрузки', up(s.uptime))));
    };
    draw();
    const iv = setInterval(draw, 1500);
    return () => clearInterval(iv);
  },
});

// ---- 16. Настройки ----
tool({
  id: 'settings', name: 'Настройки', icon: 'settings',
  view(el) {
    const toggle = (on, fn) => { const b = h('button', { class: 'toggle' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(!!on) }); b.onclick = () => { b.classList.toggle('on'); const v = b.classList.contains('on'); b.setAttribute('aria-checked', String(v)); fn(v); }; return b; };
    const segOf = (opts, val, fn) => h('div', { class: 'seg' }, opts.map(([v, label]) => h('button', { class: v === val ? 'on' : '', onclick: () => fn(v) }, label)));
    const tabs = h('div', { class: 'seg' });
    const reset = h('button', { class: 'btn sm', onclick: () => { BarTheme.save({ ...BarTheme.DEFAULTS }); BarTheme.apply(); show('look'); } }, I('reset'), 'Сбросить оформление');
    const body = h('div', { class: 'settings col', style: { flex: '1', minHeight: '0' } });
    el.append(h('div', { class: 'row' }, tabs, h('span', { class: 'grow' }), reset), body);
    const TABS = [['main', 'Основное'], ['ind', 'Показатели'], ['look', 'Оформление']];
    function show(t) {
      store.set('settingsTab', t);
      tabs.replaceChildren(...TABS.map(([k, n]) => h('button', { class: k === t ? 'on' : '', onclick: () => show(k) }, n)));
      reset.hidden = t !== 'look';
      if (body._cleanup) { body._cleanup(); body._cleanup = null; }
      body.replaceChildren();
      ({ main, ind, look })[t]();
    }

    function main() {
      bar.settingsGet().then(async (s) => {
        const lang = h('select', { class: 'field' }, h('option', { value: '' }, 'Как в системе'));
        const idleSel = h('select', { class: 'field', 'aria-label': 'Прятать нотч' }, [[30, 'через 30 секунд'], [60, 'через 1 минуту'], [120, 'через 2 минуты'], [300, 'через 5 минут'], [0, 'никогда']].map(([v, n]) => h('option', { value: String(v) }, n)));
        idleSel.value = String(s.idleHide ?? 60);
        idleSel.onchange = () => bar.settingsSet({ idleHide: +idleSel.value });
        lang.onchange = () => bar.settingsSet({ ocrLang: lang.value });
        const upd = updateRow();
        const prevClean = body._cleanup; body._cleanup = () => { upd._cleanup(); if (prevClean) prevClean(); };
        body.append(h('div', { class: 'split' },
          h('div', { class: 'col' },
            h('div', { class: 'sw' }, 'Запускать вместе с Windows', toggle(s.autostart, (v) => bar.settingsSet({ autostart: v }))),
            h('div', { class: 'sw' }, 'История буфера обмена', toggle(s.clipHistory, (v) => bar.settingsSet({ clipHistory: v }))),
            h('div', { class: 'sw' }, 'Язык распознавания', lang),
            h('div', { class: 'sw', title: 'Если мышь не двигается на мониторе с нотчем, он уезжает за край экрана и возвращается при первом движении' }, 'Прятать нотч без мыши', idleSel),
            musicRow(),
            h('span', { class: 'grow' }),
            upd,
            h('div', { class: 'row' },
              h('button', { class: 'btn', onclick: () => bar.openDir('') }, I('folder'), 'Папка Bar'),
              h('span', { class: 'grow' }),
              h('button', { class: 'btn red', onclick: () => bar.quit() }, 'Выйти'))),
          hotkeysCard()));
        const langs = await bar.ocrLangs();
        langs.forEach((l) => lang.append(h('option', { value: l.tag }, l.name)));
        lang.value = s.ocrLang || '';
      });
    }

    function ind() {
      const grid = h('div', { class: 'ind-grid' });
      const prevs = [];
      IND.forEach((x) => {
        const prev = h('span', { class: 'ind-prev' });
        prevs.push([x, prev]);
        grid.append(h('div', { class: 'sw' },
          h('span', { class: 'ind-lbl' }, h('span', {}, x.name), h('span', { class: 'muted small' }, x.desc)),
          prev, toggle(indOn(x.id), (v) => setInd(x.id, v))));
      });
      const upd = () => prevs.forEach(([x, el]) => { el.innerHTML = x.html ? x.html() : (S.media && S.media.title ? `<span class="eq"><i></i><i></i><i></i></span>` : ''); });
      upd();
      liveHooks.add(upd);
      body._cleanup = () => liveHooks.delete(upd);
      body.title = 'Показатели видны в свёрнутом нотче и в шапке панели. Опрашивается только то, что включено.';
      body.append(grid);
    }

    // YouTube Music — в вашем браузере, связь через расширение «Bar — YouTube Music»
    function musicRow() {
      const status = h('span', { class: 'muted small' }, 'проверяю…');
      const btns = h('span', { class: 'row', style: { gap: '6px', flexWrap: 'nowrap' } });
      const row = h('div', { class: 'sw', title: 'Музыка играет в вашем браузере. Расширение работает только на music.youtube.com и может связаться только с Bar на этом компьютере — в интернет ничего не отправляет.' },
        h('span', { class: 'ind-lbl' }, h('span', {}, 'YouTube Music'), status), btns);
      const b = (label, cls, fn) => h('button', { class: 'btn sm' + (cls ? ' ' + cls : ''), onclick: fn }, label);
      let guide = false;
      const draw = (st) => {
        st = st || {};
        if (!st.ext) {
          status.textContent = guide ? 'В Edge откройте edge://extensions → «Режим разработчика» → «Загрузить распакованное» → Ctrl+V (путь скопирован)' : 'расширение не установлено';
          btns.replaceChildren(b(guide ? 'Ещё раз' : 'Установить', 'pri', async () => { guide = true; await bar.musicInstall(); draw(st); }));
          return;
        }
        guide = false;
        status.textContent = !st.tab ? 'расширение подключено · вкладка YouTube Music закрыта' : (st.signedIn ? 'подключено · вход выполнен' : 'подключено');
        btns.replaceChildren(b(st.tab ? 'Вкладка' : 'Открыть', st.tab ? '' : 'pri', () => bar.musicOpen()));
      };
      bar.musicStatus().then((s) => draw(Object.assign({ ext: s.ext, tab: s.tab }, s.state || {})));
      bar.onMusic(draw);
      return row;
    }

    function hotkeysCard() {
      const card = h('div', { class: 'card status col hk-card', style: { gap: '0' } });
      const msg = h('div', { class: 'small hk-msg' });
      const NAMES = [['toggle', 'Открыть нотч'], ['search', 'Поиск'], ['ocr', 'Текст с экрана'], ['color', 'Пипетка'], ['shot', 'Скриншот'], ['qrscan', 'QR с экрана']];
      const KEYNAME = (e) => {
        const c = e.code;
        if (/^Key[A-Z]$/.test(c)) return c.slice(3);
        if (/^Digit\d$/.test(c)) return c.slice(5);
        if (/^F\d{1,2}$/.test(c)) return c;
        const m = { Space: 'Space', Enter: 'Enter', Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
          Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Backquote: '`' };
        return m[c] || '';
      };
      let recording = null;
      const stopRec = () => { if (recording) { recording.btn.classList.remove('rec'); window.removeEventListener('keydown', recording.fn, true); recording = null; bar.hotkeysResume(); } };
      const draw = () => {
        card.replaceChildren(h('h4', {}, 'Горячие клавиши'), ...NAMES.map(([id, name]) => {
          const st = HK.status[id];
          const btn = h('button', { class: 'hk-btn', title: 'Нажмите, затем новое сочетание' }, HK.map[id] ? hkText(HK.map[id]) : 'нет');
          btn.onclick = () => {
            stopRec();
            bar.hotkeysPause();
            btn.classList.add('rec'); btn.textContent = 'Нажмите сочетание…';
            msg.className = 'small hk-msg muted'; msg.textContent = 'Esc — отмена, Backspace — убрать сочетание';
            const fn = async (e) => {
              e.preventDefault(); e.stopPropagation();
              if (e.key === 'Escape') { stopRec(); draw(); msg.textContent = ''; return; }
              if (e.key === 'Backspace' || e.key === 'Delete') { stopRec(); const r = await bar.hotkeysSet(id, ''); Object.assign(HK, await bar.hotkeysGet()); draw(); msg.textContent = r.error || 'Сочетание убрано'; return; }
              const key = KEYNAME(e);
              if (!key) return; // ждём основную клавишу после модификаторов
              const acc = [e.metaKey && 'Super', e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
              stopRec();
              const r = await bar.hotkeysSet(id, acc);
              Object.assign(HK, await bar.hotkeysGet());
              draw();
              msg.className = 'small hk-msg ' + (r.error || r.status === 'busy' ? 'red-t' : 'muted');
              msg.textContent = r.error || (r.status === 'busy' ? hkText(acc) + ' уже занято другой программой или Windows — выберите другое' : 'Сохранено: ' + hkText(acc));
            };
            recording = { btn, fn };
            window.addEventListener('keydown', fn, true);
          };
          return h('div', { class: 'k' }, name, h('span', { class: 'row', style: { gap: '6px' } },
            st === 'busy' && h('span', { class: 'red-t small', title: 'Сочетание занято другой программой или Windows' }, 'занято'), btn));
        }), h('div', { class: 'k' }, 'Назад / свернуть', h('kbd', { class: 'k' }, 'Esc')), msg,
        h('div', { class: 'row', style: { marginTop: 'auto' } }, h('button', { class: 'btn sm', onclick: async () => { stopRec(); await bar.hotkeysReset(); Object.assign(HK, await bar.hotkeysGet()); draw(); msg.className = 'small hk-msg muted'; msg.textContent = 'Сочетания по умолчанию восстановлены'; } }, I('reset'), 'По умолчанию')));
      };
      bar.hotkeysGet().then((x) => { Object.assign(HK, x); draw(); });
      { const pc = body._cleanup; body._cleanup = () => { stopRec(); if (pc) pc(); }; }
      return card;
    }

    function look() {
      const cfg = BarTheme.load();
      const set = (patch) => { Object.assign(cfg, patch); BarTheme.save(cfg); BarTheme.apply(cfg); show('look'); };
      const swatches = (list, key) => {
        const val = cfg[key].toLowerCase();
        const custom = !list.some(([c]) => c.toLowerCase() === val);
        const input = h('input', { type: 'color', value: cfg[key], title: 'Свой цвет', 'aria-label': 'Свой цвет' });
        input.oninput = () => { cfg[key] = input.value; BarTheme.save(cfg); BarTheme.apply(cfg); };
        input.onchange = () => show('look');
        return h('div', { class: 'swatches' },
          list.map(([c, name]) => h('button', { class: 'swatch-btn' + (c.toLowerCase() === val ? ' on' : ''), title: name, 'aria-label': name, style: { background: c }, onclick: () => set({ [key]: c }) })),
          h('label', { class: 'swatch-btn custom' + (custom ? ' on' : ''), title: 'Свой цвет', style: custom ? { background: cfg[key] } : null }, input));
      };
      body.append(
        h('div', { class: 'sw' }, 'Тема', segOf(Object.entries(BarTheme.THEMES).map(([k, t]) => [k, t.name]), cfg.theme, (v) => set({ theme: v }))),
        h('div', { class: 'sw' }, h('span', {}, 'Акцент ', h('span', { class: 'muted' }, '· кнопки, полоски')), swatches(BarTheme.ACCENTS, 'acc')),
        h('div', { class: 'sw' }, h('span', {}, 'Подсветка ', h('span', { class: 'muted' }, '· таймер, активности')), swatches(BarTheme.HIGHLIGHTS, 'hi')),
        h('div', { class: 'sw' }, 'Скругление', segOf(Object.entries(BarTheme.RADII).map(([k, [n]]) => [k, n]), cfg.radius, (v) => set({ radius: v }))),
        h('div', { class: 'sw' }, h('span', {}, 'Чёрный свёрнутый нотч ', h('span', { class: 'muted' }, '· для светлой темы')), toggle(cfg.pillBlack, (v) => set({ pillBlack: v }))),
        h('div', { class: 'sw', title: 'Раз в 3 минуты нотч сдвигается на 1–3 пикселя, а без внимания тускнеет до 70% — так значки и часы меньше выжигают OLED' },
          h('span', {}, 'Защита OLED ', h('span', { class: 'muted' }, '· сдвиг пикселей и приглушение')), toggle(Oled.on, (v) => setOled(v))));
    }

    show(store.get('settingsTab', 'main'));
  },
});

// ============ приложения ============
const Apps = {
  all: null,                         // из меню «Пуск»
  wins: [],                          // открытые окна, сгруппированные по программе
  dock: store.get('dock', null),     // закреплённые
  uses: store.get('appUses', {}),    // сколько раз запускали через Bar
  icons: new Map(),
  save() { store.set('dock', this.dock); },
  async load() { if (!this.all) { this._p = this._p || bar.appsList(); this.all = await this._p; } return this.all; },
  icon(a, img) {
    const key = a.id || a.exe;
    if (this.icons.has(key)) { const u = this.icons.get(key); if (u) img.src = u; else img.replaceWith(letterIcon(a.name)); return; }
    bar.appIcon(a).then((u) => { if (u) { this.icons.set(key, u); img.src = u; } else img.replaceWith(letterIcon(a.name)); });
  },
  matchUwp(fam, exe) {
    const i = fam.lastIndexOf('_'); if (i < 0) return false;
    const n = fam.slice(0, i).toLowerCase(), hash = fam.slice(i + 1).toLowerCase(), e = exe.toLowerCase();
    return e.includes('\\windowsapps\\' + n + '_') && e.includes('__' + hash);
  },
  running(a) {
    const exe = (a.exe || '').toLowerCase();
    return this.wins.find((g) => (exe && g.exe.toLowerCase() === exe) || (a.uwp && this.matchUwp(a.uwp, g.exe)));
  },
  isPinned(a) { return (this.dock || []).some((d) => d.id === a.id); },
  // подсказки: часто запускаемые (по счётчикам Windows) + запуски через Bar, без закреплённых и скрытых
  usage: null, hide: store.get('dockHide', []),
  async loadUsage() { if (!this.usage) { this.usage = []; this.usage = await bar.appUsage().catch(() => []); refreshDock(true); } },
  suggestions(n) {
    if (!this.usage || n <= 0) return [];
    const list = new Map(this.usage.map((u) => [u.app.id, { a: u.app, s: u.score }]));
    // запуски через сам Bar тоже в счёт
    for (const [id, k] of Object.entries(this.uses)) {
      const a = (this.all || []).find((x) => x.id === id);
      if (a) { const e = list.get(id) || { a, s: 0 }; e.s += k * 20; list.set(id, e); }
    }
    const names = new Set((this.dock || []).map((d) => d.name.toLowerCase()));
    return [...list.values()].filter((e) => !this.isPinned(e.a) && !this.hide.includes(e.a.id))
      .sort((x, y) => y.s - x.s).filter((e) => { const k = e.a.name.toLowerCase(); if (names.has(k)) return false; names.add(k); return true; })
      .slice(0, n).map((e) => e.a);
  },
  pin(a) { this.dock = this.dock || []; if (!this.isPinned(a) && this.dock.length < 14) { this.dock.push({ id: a.id, name: a.name, exe: a.exe || '', lnk: a.lnk || '', uwp: a.uwp || '' }); this.save(); } },
  unpin(a) { this.dock = (this.dock || []).filter((d) => d.id !== a.id); this.save(); },
  async open(a) {
    const g = this.running(a);
    if (g) { await bar.winFocus(g.windows[0].hwnd); }
    else { await bar.appLaunch(a); this.uses[a.id] = (this.uses[a.id] || 0) + 1; store.set('appUses', this.uses); flash(`Запускаю ${a.name}`); }
    collapse(true);
  },
  async menu(a) {
    const g = this.running(a);
    const pick = await bar.popupMenu([
      { id: 'open', label: g ? 'Перейти к окну' : 'Открыть' },
      { id: 'new', label: 'Открыть ещё одно окно', enabled: !!g },
      { id: 'min', label: 'Свернуть', enabled: !!g },
      { id: 'close', label: g && g.windows.length > 1 ? `Закрыть все окна (${g.windows.length})` : 'Закрыть', enabled: !!g },
      { sep: true },
      { id: 'pin', label: this.isPinned(a) ? 'Открепить от нотча' : 'Закрепить в нотче' },
    ]);
    if (pick === 'open') this.open(a);
    if (pick === 'new') { bar.appLaunch(a); collapse(true); }
    if (pick === 'min') g.windows.forEach((w) => bar.winMin(w.hwnd));
    if (pick === 'close') [...new Set(g.windows.map((w) => w.pid))].forEach((pid) => bar.winClose(pid));
    if (pick === 'pin') { this.isPinned(a) ? this.unpin(a) : this.pin(a); refreshDock(); }
    setTimeout(pollWins, 600);
  },
};
function letterIcon(name) {
  return h('span', { class: 'app-letter' }, (name || '?').replace(/^[^\p{L}\p{N}]+/u, '').charAt(0).toUpperCase() || '?');
}
async function pollWins() {
  try { Apps.wins = await bar.windows(); } catch { return; }
  if (Apps.dock === null) {
    // первый запуск: закрепляем то, что сейчас открыто и есть в меню «Пуск»
    const all = await Apps.load();
    Apps.dock = [];
    for (const g of Apps.wins) {
      const a = all.find((x) => (x.exe && x.exe.toLowerCase() === g.exe.toLowerCase()) || (x.uwp && Apps.matchUwp(x.uwp, g.exe)));
      if (a) Apps.pin(a);
      if (Apps.dock.length >= 8) break;
    }
    Apps.save();
  }
  refreshDock();
  liveHooks.forEach((f) => f({ wins: true }));
}
let winIv = 0;
openHooks.add((open) => { clearInterval(winIv); if (open) { pollWins(); Apps.load().then(() => Apps.loadUsage()); winIv = setInterval(pollWins, 2500); } });

function dockEl() {
  const row = h('div', { class: 'dock' });
  const list = Apps.dock || [];
  list.forEach((a, i) => {
    const img = h('img', { alt: '' });
    const run = Apps.running(a);
    const b = h('button', {
      class: 'dock-app pinned' + (run ? ' run' : ''), title: a.name + (run ? ' · открыто' : ''), style: { animationDelay: `${30 + i * 15}ms` },
      onclick: () => Apps.open(a),
      oncontextmenu: (e) => { e.preventDefault(); Apps.menu(a); },
      onauxclick: (e) => { if (e.button === 1) { bar.appLaunch(a); collapse(true); } },
    }, img);
    Apps.icon(a, img);
    row.append(b);
  });
  // «+» — добавить любое приложение
  row.append(h('button', { class: 'dock-app add', title: 'Добавить приложение в нотч', 'aria-label': 'Добавить приложение', style: { animationDelay: `${30 + list.length * 15}ms` },
    onclick: () => openTool('apps', { tab: 'all' }) }, I('plus')));
  // подсказки из часто запускаемых: клик — закрепить
  const sug = Apps.suggestions(Math.min(3, 10 - list.length));
  if (sug.length) row.append(h('span', { class: 'dock-sep', title: 'Вы часто их запускаете' }));
  sug.forEach((a, i) => {
    const img = h('img', { alt: '' });
    const pin = () => { Apps.pin(a); refreshDock(true); flash(`${a.name} в нотче`); };
    const b = h('button', {
      class: 'dock-app sug', title: `${a.name} — вы часто запускаете. Нажмите, чтобы закрепить`, 'aria-label': `Закрепить ${a.name}`,
      style: { animationDelay: `${60 + (list.length + i) * 15}ms` }, onclick: pin,
      oncontextmenu: async (e) => {
        e.preventDefault();
        const pick = await bar.popupMenu([{ id: 'pin', label: 'Закрепить в нотче' }, { id: 'open', label: 'Открыть' }, { sep: true }, { id: 'hide', label: 'Не предлагать' }]);
        if (pick === 'pin') pin();
        if (pick === 'open') Apps.open(a);
        if (pick === 'hide') { Apps.hide.push(a.id); store.set('dockHide', Apps.hide); refreshDock(true); }
      },
    }, img, h('span', { class: 'sug-plus', html: icon('plus') }));
    Apps.icon(a, img);
    row.append(b);
  });
  if (!list.length && !sug.length) row.append(h('span', { class: 'muted small dock-empty' }, 'Закрепите частые приложения — они будут здесь в один клик'));
  row.append(h('span', { class: 'grow' }),
    h('button', { class: 'btn sm', onclick: () => openTool('apps') }, I('apps'), 'Все приложения'));
  return row;
}
function refreshDock(full) {
  const old = homeEl.querySelector('.dock');
  if (old && !current) {
    // обновляем только индикаторы «открыто», чтобы не мигали иконки
    const list = Apps.dock || [];
    const btns = old.querySelectorAll('.dock-app.pinned');
    if (!full && btns.length === list.length) { list.forEach((a, i) => btns[i].classList.toggle('run', !!Apps.running(a))); return; }
    old.replaceWith(dockEl());
  }
}

tool({
  id: 'apps', name: 'Приложения', icon: 'apps', hidden: true,
  view(el, p) {
    let tab = (p && p.tab) || store.get('appsTab', 'open');
    const q = h('input', { class: 'field', placeholder: 'Найти приложение…', style: { flex: '1' } });
    const tabs = h('div', { class: 'seg' });
    const body = h('div', { class: 'list' });
    const TABS = [['open', 'Открытые'], ['all', 'Все'], ['dock', 'В нотче']];
    // иконки подгружаем, только когда строка показалась на экране — список «Все» длинный
    const io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) { io.unobserve(en.target); en.target._load(); } }), { root: body, rootMargin: '200px' });
    const appRow = (a, extra, lazy) => {
      const img = h('img', { alt: '' });
      const g = Apps.running(a);
      const row = h('div', { class: 'item app-row', onclick: () => Apps.open(a), oncontextmenu: (e) => { e.preventDefault(); Apps.menu(a); } },
        h('span', { class: 'app-ico' }, img), h('span', { class: 'txt' }, a.name),
        g && h('span', { class: 'muted small' }, g.windows.length > 1 ? `${g.windows.length} окна` : 'открыто'),
        extra,
        h('button', { class: 'ib' + (Apps.isPinned(a) ? ' on' : ''), title: Apps.isPinned(a) ? 'Открепить от нотча' : 'Закрепить в нотче',
          onclick: (e) => { e.stopPropagation(); Apps.isPinned(a) ? Apps.unpin(a) : Apps.pin(a); if (Apps.isPinned(a)) flash(`${a.name} в нотче`); draw(); } }, I('pin')));
      if (lazy) { row._load = () => Apps.icon(a, img); io.observe(row); } else Apps.icon(a, img);
      return row;
    };
    async function draw() {
      tabs.replaceChildren(...TABS.map(([k, n]) => h('button', { class: k === tab ? 'on' : '', onclick: () => { tab = k; store.set('appsTab', k); draw(); } }, n)));
      const s = q.value.trim().toLowerCase();
      const all = await Apps.load();
      let rows = [];
      if (tab === 'open') {
        rows = Apps.wins.map((g) => all.find((x) => (x.exe && x.exe.toLowerCase() === g.exe.toLowerCase()) || (x.uwp && Apps.matchUwp(x.uwp, g.exe)))
          || { id: 'exe:' + g.exe, name: g.name, exe: g.exe });
        rows = rows.filter((a) => !s || a.name.toLowerCase().includes(s)).map((a) => {
          const g = Apps.running(a);
          return appRow(a, g && h('span', { class: 'row', style: { gap: '4px' } },
            h('button', { class: 'ib', title: 'Свернуть', onclick: (e) => { e.stopPropagation(); g.windows.forEach((w) => bar.winMin(w.hwnd)); } }, I('minimize')),
            h('button', { class: 'ib', title: 'Закрыть', onclick: (e) => { e.stopPropagation(); [...new Set(g.windows.map((w) => w.pid))].forEach((pid) => bar.winClose(pid)); setTimeout(() => pollWins().then(draw), 700); } }, I('x'))));
        });
        if (!rows.length) rows = [h('div', { class: 'empty' }, s ? 'Ничего не найдено' : 'Открытых окон нет')];
      } else if (tab === 'dock') {
        rows = (Apps.dock || []).filter((a) => !s || a.name.toLowerCase().includes(s)).map((a, i, arr) => appRow(a, h('span', { class: 'row', style: { gap: '4px' } },
          h('button', { class: 'ib', title: 'Левее', disabled: i === 0, onclick: (e) => { e.stopPropagation(); const d = Apps.dock; const k = d.indexOf(a); [d[k - 1], d[k]] = [d[k], d[k - 1]]; Apps.save(); draw(); } }, I('back')),
          h('button', { class: 'ib', title: 'Правее', disabled: i === arr.length - 1, onclick: (e) => { e.stopPropagation(); const d = Apps.dock; const k = d.indexOf(a); [d[k + 1], d[k]] = [d[k], d[k + 1]]; Apps.save(); draw(); } }, I('fwd')))));
        if (!rows.length) rows = [h('div', { class: 'empty' }, 'В нотче пока пусто.\nЗакрепите приложения на вкладках «Открытые» или «Все».')];
      } else {
        const list = all.filter((a) => !s || a.name.toLowerCase().includes(s))
          .sort((a, b) => (Apps.uses[b.id] || 0) - (Apps.uses[a.id] || 0));
        rows = list.map((a) => appRow(a, null, true));
        if (!rows.length) rows = [h('div', { class: 'empty' }, all.length ? 'Ничего не найдено' : 'Загружаю список приложений…')];
      }
      body.replaceChildren(...rows);
    }
    q.addEventListener('input', draw);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = body.querySelector('.app-row'); if (first) first.click(); } });
    el.append(h('div', { class: 'row' }, tabs, q), body, h('div', { class: 'muted small' }, 'Клик — открыть или перейти к окну · правая кнопка — меню · Enter — первое найденное'));
    const hook = (p) => { if (p.wins && tab === 'open') draw(); };
    liveHooks.add(hook);
    draw();
    setTimeout(() => q.focus(), 50);
    return () => { liveHooks.delete(hook); io.disconnect(); };
  },
});


// ============ обновления (GitHub Releases) ============
const Upd = { st: { state: 'idle' }, hooks: new Set(), told: '' };
bar.updateGet().then((s) => { Upd.st = s || Upd.st; Upd.hooks.forEach((f) => f()); });
bar.onUpdate((s) => {
  Upd.st = s;
  Upd.hooks.forEach((f) => f());
  if (s.state === 'available' && Upd.told !== s.next) { Upd.told = s.next; flash(`Доступна версия ${s.next}`, 4000); }
});
const fmtMB = (b) => (b / 1048576).toFixed(1).replace('.', ',');
function updateRow() {
  const ico = h('span', { class: 'upd-ico' });
  const title = h('b');
  const sub = h('span', { class: 'muted small' });
  const btn = h('button', { class: 'btn sm' });
  const fill = h('b');
  const barEl2 = h('div', { class: 'upd-bar', 'aria-hidden': 'true' }, fill);
  const row = h('div', { class: 'upd' }, h('div', { class: 'upd-top' }, ico, h('div', { class: 'upd-t' }, title, sub), btn), barEl2);
  let last = '';
  const draw = () => {
    const s = Upd.st, v = s.version || '';
    const set = (ic, t, d, label, fn, cls = '') => {
      ico.className = 'upd-ico ' + cls;
      if (last !== s.state) { ico.innerHTML = icon(ic); animOnce(ico, 'pop'); }
      title.textContent = t; sub.textContent = d;
      btn.hidden = !label; btn.textContent = label || ''; btn.onclick = fn || null;
      btn.className = 'btn sm' + (cls === 'go' ? ' pri' : '');
    };
    row.dataset.state = s.state;
    switch (s.state) {
      case 'dev': set('code', `Bar ${v}`, 'Режим разработки — обновления приходят только в установленную версию', ''); break;
      case 'checking': set('redo', 'Проверяю обновления…', `Сейчас у вас ${v}`, '', null, 'spin'); break;
      case 'available': set('download', `Доступна версия ${s.next}`, `Сейчас у вас ${v}`, 'Скачать', () => bar.updateDownload(), 'go'); break;
      case 'downloading': {
        const pct = Math.max(0, Math.min(100, s.percent || 0));
        set('download', `Загружаю ${s.next || ''} — ${Math.floor(pct)}%`, s.total ? `${fmtMB(s.done || 0)} из ${fmtMB(s.total)} МБ · ${fmtMB(s.speed || 0)} МБ/с` : 'Начинаю загрузку…', '', null, 'pulse');
        fill.style.width = pct + '%';
        break;
      }
      case 'ready': set('redo', `Версия ${s.next} готова`, 'Bar перезапустится за пару секунд', 'Перезапустить', () => { btn.disabled = true; bar.updateInstall(); }, 'go'); fill.style.width = '100%'; break;
      case 'latest': set('check', `Bar ${v} — последняя версия`, s.checkedAt ? `Проверено в ${new Date(s.checkedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : '', 'Проверить', () => bar.updateCheck(), 'ok'); break;
      case 'error': set('x', 'Не удалось проверить обновления', s.error || 'Нет связи с GitHub', 'Ещё раз', () => bar.updateCheck(), 'err'); break;
      default: set('redo', `Bar ${v}`, 'Обновления из GitHub', 'Проверить', () => bar.updateCheck());
    }
    barEl2.classList.toggle('on', s.state === 'downloading' || s.state === 'ready');
    last = s.state;
  };
  Upd.hooks.add(draw);
  draw();
  row._cleanup = () => Upd.hooks.delete(draw);
  return row;
}

// ============ режим музыки (YouTube Music в вашем браузере через расширение) ============
const MU = { st: null, ext: false, tab: false };
const MUctl = { editing: false, toggleEdit: null };
const musicHooks = new Set();
function muSet(s) {
  if (!s) return;
  MU.ext = !!s.ext; MU.tab = !!s.tab;
  if (s.ready) MU.st = s; else if (!s.tab) MU.st = null;
  musicHooks.forEach((f) => { try { f(); } catch {} });
}
bar.onMusic(muSet);
bar.musicStatus().then((s) => muSet(Object.assign({ ext: s.ext, tab: s.tab }, s.state || {}))).catch(() => {});

const GOOGLE_IMG = /^https:\/\/([a-z0-9-]+\.)*(googleusercontent\.com|ggpht\.com|ytimg\.com)\//;
const bimg = (u) => (GOOGLE_IMG.test(u || '') ? 'barimg://img/' + encodeURIComponent(u) : '');
const fmtT = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const mcmd = (c, a) => bar.musicCmd(c, a);

const MUSIC_SIZES = { compact: 428, standard: 520, large: 620 };
const MUSIC_SIZE_NAMES = [['compact', 'Компактно'], ['standard', 'Стандарт'], ['large', 'Большой']];
const BLOCK_NAMES = { player: 'Плеер', queue: 'Очередь', library: 'Библиотека', search: 'Поиск', lyrics: 'Текст' };
const ML_DEFAULT = () => ({ size: 'standard', split: 40, cols: [['player'], ['queue', 'library', 'search', 'lyrics']], active: ['player', 'queue'] });
let ML = Object.assign(ML_DEFAULT(), store.get('musicLayout', {}));
const saveML = () => store.set('musicLayout', ML);

// средний цвет обложки → лёгкий оттенок панели
function coverTint(src, cb) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 12;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 12, 12);
      const d = g.getImageData(0, 0, 12, 12).data; let r = 0, gg = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4; cb(`rgb(${Math.round(r / n)}, ${Math.round(gg / n)}, ${Math.round(b / n)})`);
    } catch { cb(null); }
  };
  img.onerror = () => cb(null);
  img.src = src;
}

tool({
  id: 'music', name: 'Музыка', icon: 'music', hidden: true,
  height: () => MUSIC_SIZES[ML.size] || 520,
  view(el) {
    bar.musicWatch(true);
    const root = h('div', { class: 'mu' });
    el.append(root);
    let editing = false;
    let blocks = {};
    let lastId = '';

    const hero = (title, text, button) => h('div', { class: 'hero' }, h('div', { class: 'big' }, title), h('div', { class: 'muted' }, text), button);

    // ---------- блоки ----------
    const anim = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); el.addEventListener('animationend', () => el.classList.remove(cls), { once: true }); };
    function playerBlock() {
      const art = h('img', { class: 'mu-art', alt: '', hidden: true });
      const ph = h('div', { class: 'mu-art ph', html: icon('disc') });
      const title = h('div', { class: 'mu-title' }), artist = h('div', { class: 'mu-artist muted' });
      const seekFill = h('b'); const knob = h('i');
      const seek = h('div', { class: 'mu-seek', title: 'Перемотка — нажмите или тяните', role: 'slider', 'aria-label': 'Перемотка', tabindex: 0 }, seekFill, knob);
      const t1 = h('span'), t2 = h('span');
      let seekDrag = null; // во время перетаскивания: доля трека, на которую перемотаем
      const jump = (d) => { const st = MU.st; if (!st || !st.duration) return; mcmd('seek', Math.max(0, Math.min(st.duration - 1, (st.time || 0) + d))); };
      const back10 = h('button', { class: 'mu-jump', title: 'Назад на 10 секунд', 'aria-label': 'Назад на 10 секунд', onclick: () => jump(-10) }, I('reset'), '10');
      const fwd10 = h('button', { class: 'mu-jump', title: 'Вперёд на 10 секунд', 'aria-label': 'Вперёд на 10 секунд', onclick: () => jump(10) }, '10', I('redo'));
      const ib = (ic, title, fn) => h('button', { class: 'ib', title, 'aria-label': title, onclick: fn }, I(ic));
      const shuffle = ib('shuffle', 'Перемешать', () => { anim(shuffle, 'spin'); mcmd('shuffle'); });
      const repeat = ib('repeat', 'Повтор', () => { anim(repeat, 'spin'); mcmd('repeat'); });
      const play = h('button', { class: 'mu-play', 'aria-label': 'Играть / пауза', onclick: () => mcmd('toggle'), html: PP_SVG });
      let playIcon = '', likeOn = null;
      const like = ib('heart', 'Нравится', () => { anim(like, 'pop'); mcmd('like'); });
      const dislike = ib('thumbsdown', 'Не нравится', () => mcmd('dislike'));
      const vol = makeSlider({ min: 0, max: 100, label: 'Громкость плеера' }); vol.classList.add('vol');
      let volDrag = false, volT = 0, artSrc = null;
      vol.addEventListener('input', () => { volDrag = true; clearTimeout(volT); volT = setTimeout(() => { mcmd('volume', +vol.value); volDrag = false; }, 120); });
      const frac = (e) => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
      const showDrag = () => { const st = MU.st || {}; seekFill.style.width = knob.style.left = (seekDrag * 100) + '%'; t1.textContent = fmtT(seekDrag * (st.duration || 0)); };
      seek.addEventListener('pointerdown', (e) => {
        const st = MU.st; if (!st || !st.duration) return;
        seek.setPointerCapture(e.pointerId); seek.classList.add('drag'); seekDrag = frac(e); showDrag();
      });
      seek.addEventListener('pointermove', (e) => { if (seekDrag !== null) { seekDrag = frac(e); showDrag(); } });
      const endDrag = () => {
        if (seekDrag === null) return;
        const st = MU.st; if (st && st.duration) mcmd('seek', Math.round(seekDrag * st.duration));
        seekDrag = null; seek.classList.remove('drag');
      };
      seek.addEventListener('pointerup', endDrag);
      seek.addEventListener('pointercancel', () => { seekDrag = null; seek.classList.remove('drag'); });
      seek.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); jump(e.key === 'ArrowLeft' ? -5 : 5); } });
      const prevB = ib('prev', 'Назад', () => { anim(prevB, 'nudge-l'); mcmd('prev'); });
      const nextB = ib('next', 'Вперёд', () => { anim(nextB, 'nudge-r'); mcmd('next'); });
      art.addEventListener('load', () => anim(art, 'appear'));
      const node = h('div', { class: 'mu-player' },
        h('div', { class: 'mu-cover' }, art, ph),
        h('div', { class: 'mu-info' },
          h('div', { class: 'mu-meta-row' }, like, h('div', { class: 'mu-meta' }, title, artist), dislike),
          h('div', { class: 'mu-progress' }, seek, h('div', { class: 'mu-times muted' }, t1, h('span', { class: 'mu-jumps' }, back10, fwd10), t2)),
          h('div', { class: 'mu-ctl' }, shuffle, prevB, play, nextB, repeat),
          h('div', { class: 'mu-extra' }, h('span', { class: 'mu-vol-ic', html: icon('voldown') }), vol, h('span', { class: 'mu-vol-ic', html: icon('volup') }))));
      return {
        node,
        update() {
          const st = MU.st || {};
          title.textContent = st.title || 'Ничего не играет';
          artist.textContent = st.artist || (st.title ? '' : 'Включите трек в очереди, библиотеке или поиске');
          const src = bimg(st.art);
          if (src !== artSrc) {
            artSrc = src;
            if (src) { art.src = src; art.hidden = false; ph.hidden = true; coverTint(src, (c) => { if (c) root.style.setProperty('--mt', c); else root.style.removeProperty('--mt'); }); }
            else { art.hidden = true; ph.hidden = false; root.style.removeProperty('--mt'); }
          }
          const pct = st.duration ? Math.min(100, st.time / st.duration * 100) : 0;
          if (seekDrag === null) { seekFill.style.width = knob.style.left = pct + '%'; t1.textContent = fmtT(st.time); }
          t2.textContent = st.duration ? fmtT(st.duration) : '';
          const pi = st.state === 1 ? 'pause' : 'play';
          if (pi !== playIcon) { playIcon = pi; play.classList.toggle('is-playing', pi === 'pause'); }
          node.classList.toggle('paused', st.state !== 1 && !!st.title);
          const lk = st.like === 'LIKE';
          if (likeOn !== null && lk && !likeOn) anim(like, 'pop');
          likeOn = lk;
          like.classList.toggle('on', lk);
          dislike.classList.toggle('on', st.like === 'DISLIKE');
          shuffle.classList.toggle('on', !!st.shuffle);
          repeat.innerHTML = icon(st.repeat === 'ONE' ? 'repeat1' : 'repeat');
          repeat.classList.toggle('on', st.repeat === 'ALL' || st.repeat === 'ONE');
          if (!volDrag && typeof st.volume === 'number') vol.value = st.volume;
        },
      };
    }

    function rowEl(it, onClick, current) {
      const img = h('img', { alt: '' });
      const s = bimg(it.thumb); if (s) img.src = s;
      return h('div', { class: 'item mu-row' + (current ? ' cur' : ''), role: 'button', tabindex: 0, onclick: onClick, title: it.title },
        h('span', { class: 'mu-thumb' }, img),
        h('span', { class: 'mu-row-txt' }, h('span', { class: 'mu-row-t' }, it.title), h('span', { class: 'muted small mu-row-s' }, it.subtitle || '')),
        it.duration && h('span', { class: 'muted small' }, it.duration));
    }
    function cardEl(it, onClick) {
      const img = h('img', { alt: '' });
      const s = bimg(it.thumb); if (s) img.src = s;
      // без обложки (например, «Понравившаяся музыка») — значок вместо пустого квадрата
      const ph = h('span', { class: 'mu-card-ph', html: icon(/понрав|liked/i.test(it.title || '') ? 'heart' : 'music') });
      if (!s) img.hidden = true; else ph.hidden = true;
      img.addEventListener('error', () => { img.hidden = true; ph.hidden = false; });
      return h('button', { class: 'mu-card', onclick: onClick, title: it.title },
        h('span', { class: 'mu-card-img' }, img, ph),
        h('span', { class: 'mu-card-t' }, it.title), h('span', { class: 'mu-card-s muted small' }, it.subtitle || ''));
    }

    function queueBlock() {
      const list = h('div', { class: 'list' });
      let busy = false;
      async function load() {
        if (busy) return; busy = true;
        const q = await bar.musicQueue().catch(() => []);
        busy = false;
        if (!q || !q.length) { list.replaceChildren(h('div', { class: 'empty' }, 'Очередь пуста.\nВключите трек, альбом или плейлист.')); return; }
        const rows = [];
        q.forEach((x, k) => {
          // автоподборка YouTube Music — отдельным заголовком, как в самом плеере
          if (x.auto && !(k && q[k - 1].auto)) rows.push(h('div', { class: 'mu-q-h muted small' }, 'Дальше — автоподборка'));
          rows.push(rowEl(x, () => { mcmd('playQueue', x.i); setTimeout(load, 900); }, x.current));
        });
        list.replaceChildren(...rows);
        // текущий трек — ближе к верху, чтобы были видны следующие
        const cur = list.querySelector('.cur'); if (cur) list.scrollTop = Math.max(0, cur.offsetTop - list.offsetTop - 56);
      }
      load();
      const iv = setInterval(() => { if (!list.closest('[hidden]')) load(); }, 4000);
      return { node: list, onTrack: load, destroy: () => clearInterval(iv) };
    }

    // навигация внутри блока: «главная» → альбом → назад
    function browser(node, back) {
      const stack = [];
      const body = h('div', { class: 'list mu-browse' });
      node.append(body);
      const open = async (loader, title) => {
        stack.push({ loader, title });
        await show();
      };
      const show = async () => {
        const top = stack[stack.length - 1];
        back.hidden = stack.length < 2;
        body.replaceChildren(h('div', { class: 'empty' }, 'Загружаю…'));
        const data = await top.loader().catch(() => null);
        if (stack[stack.length - 1] !== top) return;
        render(data);
      };
      back.onclick = () => { if (stack.length > 1) { stack.pop(); show(); } };
      const go = (it) => {
        if (it.nav && it.nav.browseId && (!it.play || it.kind === 'card')) open(() => bar.musicBrowse(it.nav.browseId, it.nav.params), it.title);
        else if (it.play) mcmd('play', it.play);
        else if (it.nav && it.nav.videoId) mcmd('play', it.nav);
      };
      function render(data) {
        if (!data) { body.replaceChildren(h('div', { class: 'empty' }, 'Не удалось загрузить.\nОткройте вкладку YouTube Music и попробуйте снова.')); return; }
        const parts = [];
        if (data.header) {
          const hd = data.header;
          const firstPlay = (data.sections || []).flatMap((s) => s.items).find((i) => i.play);
          const playN = hd.play || (firstPlay && firstPlay.play);
          const img = h('img', { alt: '' }); const s = bimg(hd.thumb); if (s) img.src = s;
          parts.push(h('div', { class: 'mu-hd' }, h('span', { class: 'mu-hd-img' }, img),
            h('div', { class: 'mu-hd-txt' }, h('b', {}, hd.title), h('span', { class: 'muted small' }, hd.subtitle),
              playN && h('button', { class: 'btn sm pri', onclick: () => mcmd('play', playN) }, I('play'), 'Слушать'))));
        }
        for (const sec of data.sections || []) {
          if (sec.title) parts.push(h('div', { class: 'cap mu-sec' }, sec.title));
          const cards = sec.items.filter((i) => i.kind === 'card');
          if (cards.length >= sec.items.length / 2) parts.push(h('div', { class: 'mu-grid-cards' }, sec.items.map((it) => cardEl(it, () => go(it)))));
          else parts.push(...sec.items.map((it) => rowEl(it, () => go(it))));
        }
        if (!parts.length) parts.push(h('div', { class: 'empty' }, 'Здесь пока пусто'));
        body.replaceChildren(...parts);
        body.scrollTop = 0;
      }
      return { open, reset: (loader, title) => { stack.length = 0; open(loader, title); } };
    }

    function libraryBlock() {
      const back = h('button', { class: 'ib', title: 'Назад', hidden: true }, I('back'));
      const chips = h('div', { class: 'seg mu-chips' });
      const node = h('div', { class: 'mu-col-inner' }, h('div', { class: 'row', style: { flexWrap: 'nowrap', gap: '6px' } }, back, chips));
      const br = browser(node, back);
      const SRC = [['Главная', 'FEmusic_home'], ['Плейлисты', 'FEmusic_liked_playlists'], ['Альбомы', 'FEmusic_liked_albums'], ['Исполнители', 'FEmusic_library_corpus_track_artists'], ['Нравится', 'VLLM']];
      let cur = store.get('muLib', 'FEmusic_home');
      const drawChips = () => chips.replaceChildren(...SRC.map(([n, id]) => h('button', { class: id === cur ? 'on' : '', onclick: () => { cur = id; store.set('muLib', id); drawChips(); br.reset(() => bar.musicBrowse(id), n); } }, n)));
      drawChips();
      br.reset(() => bar.musicBrowse(cur), '');
      return { node };
    }

    function searchBlock() {
      const back = h('button', { class: 'ib', title: 'Назад', hidden: true }, I('back'));
      const q = h('input', { class: 'field', placeholder: 'Песня, альбом, исполнитель', 'aria-label': 'Поиск в YouTube Music' });
      const node = h('div', { class: 'mu-col-inner' }, h('div', { class: 'row', style: { flexWrap: 'nowrap', gap: '6px' } }, back, q));
      const br = browser(node, back);
      let t = 0;
      const run = () => { const v = q.value.trim(); if (v.length < 2) return; br.reset(() => bar.musicSearch(v), v); };
      q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 500); });
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(t); run(); } e.stopPropagation(); });
      return { node, focus: () => q.focus() };
    }

    function lyricsBlock() {
      const body = h('div', { class: 'mu-lyrics' });
      async function load() {
        const st = MU.st;
        if (!st || !st.id) { body.replaceChildren(h('div', { class: 'empty' }, 'Текст появится, когда заиграет трек')); return; }
        body.replaceChildren(h('div', { class: 'muted' }, 'Загружаю текст…'));
        const l = await bar.musicLyrics(st.id).catch(() => null);
        if (!l || !l.text) { body.replaceChildren(h('div', { class: 'empty' }, 'У этого трека нет текста в YouTube Music')); return; }
        body.replaceChildren(h('div', { class: 'mu-lyrics-text' }, l.text), l.source && h('div', { class: 'muted small' }, l.source));
      }
      load();
      return { node: body, onTrack: load };
    }

    const MAKERS = { player: playerBlock, queue: queueBlock, library: libraryBlock, search: searchBlock, lyrics: lyricsBlock };

    // ---------- раскладка ----------
    function columnEl(ids, idx) {
      const col = h('div', { class: 'mu-col card' });
      if (!ids.length) return null;
      const active = ids.includes(ML.active[idx]) ? ML.active[idx] : ids[0];
      if (ids.length > 1) {
        col.append(h('div', { class: 'seg mu-tabs' }, ids.map((id) => h('button', {
          class: id === active ? 'on' : '', onclick: () => { ML.active[idx] = id; saveML(); render(); },
        }, BLOCK_NAMES[id]))));
      }
      for (const id of ids) {
        const b = blocks[id] || (blocks[id] = MAKERS[id]());
        const wrap = h('div', { class: 'mu-block', hidden: id !== active }, b.node);
        col.append(wrap);
        if (id === active && b.focusOnShow) b.focusOnShow();
      }
      return col;
    }

    function editor() {
      const cols = ML.cols.map((ids, idx) => {
        const box = h('div', { class: 'mu-edit-col' }, h('div', { class: 'cap' }, idx === 0 ? 'Левая колонка' : 'Правая колонка'));
        box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('over'); });
        box.addEventListener('dragleave', () => box.classList.remove('over'));
        box.addEventListener('drop', (e) => {
          e.preventDefault(); box.classList.remove('over');
          const id = e.dataTransfer.getData('text/plain'); if (!BLOCK_NAMES[id]) return;
          ML.cols = ML.cols.map((c) => c.filter((x) => x !== id));
          const target = e.target.closest('.mu-chip');
          const list = ML.cols[idx];
          const at = target ? list.indexOf(target.dataset.id) : -1;
          if (at >= 0) list.splice(at, 0, id); else list.push(id);
          if (!ML.cols[0].length && !ML.cols[1].length) ML.cols = ML_DEFAULT().cols;
          saveML(); render();
        });
        for (const id of ids) {
          box.append(h('div', { class: 'mu-chip', draggable: true, 'data-id': id, ondragstart: (e) => e.dataTransfer.setData('text/plain', id) },
            I('grip'), BLOCK_NAMES[id]));
        }
        if (!ids.length) box.append(h('div', { class: 'muted small' }, 'Перетащите сюда блок'));
        return box;
      });
      const sizeSeg = h('div', { class: 'seg' }, MUSIC_SIZE_NAMES.map(([k, n]) => h('button', {
        class: k === ML.size ? 'on' : '', onclick: () => { ML.size = k; saveML(); island.style.setProperty('--h-open', MUSIC_SIZES[k] + 'px'); render(); },
      }, n)));
      const split = makeSlider({ min: 28, max: 62, value: ML.split, label: 'Ширина левой колонки' }); split.classList.add('vol');
      split.addEventListener('input', () => { ML.split = +split.value; saveML(); });
      return h('div', { class: 'mu-editor col' },
        h('div', { class: 'muted small' }, 'Перетаскивайте блоки между колонками. Несколько блоков в колонке становятся вкладками.'),
        h('div', { class: 'mu-edit-cols' }, cols),
        h('div', { class: 'sw' }, 'Размер панели', sizeSeg),
        h('div', { class: 'sw' }, 'Ширина левой колонки', split),
        h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => { ML = ML_DEFAULT(); saveML(); island.style.setProperty('--h-open', MUSIC_SIZES[ML.size] + 'px'); render(); } }, I('reset'), 'Сбросить')));
    }

    function render() {
      root.replaceChildren();
      root.style.setProperty('--mu-h', (MUSIC_SIZES[ML.size] || 520) + 'px');
      if (!MU.ext) {
        root.append(hero('Подключите YouTube Music', 'Установите расширение «Bar — YouTube Music»: Настройки → Основное → YouTube Music.',
          h('button', { class: 'btn pri', onclick: () => { store.set('settingsTab', 'main'); openTool('settings'); } }, 'Открыть настройки')));
        return;
      }
      if (!MU.tab) {
        root.append(hero('Откройте YouTube Music', 'Музыка играет в вашем браузере. Откройте вкладку music.youtube.com — дальше всё управление здесь.',
          h('button', { class: 'btn pri', onclick: () => bar.musicOpen() }, I('link'), 'Открыть YouTube Music')));
        return;
      }
      MUctl.editing = editing;
      renderBar();
      if (editing) { root.append(editor(), h('div', { class: 'row' }, h('button', { class: 'btn pri', onclick: () => MUctl.toggleEdit() }, 'Готово'))); return; }
      const cols = ML.cols.map((ids, i) => columnEl(ids, i)).filter(Boolean);
      const grid = h('div', { class: 'mu-grid', style: { gridTemplateColumns: cols.length > 1 ? `${ML.split}% minmax(0, 1fr)` : '1fr' } }, cols);
      root.append(grid);
      Object.values(blocks).forEach((b) => b.update && b.update());
    }

    const onState = () => {
      const st = MU.st;
      if (!root.querySelector('.mu-grid') && MU.ext && MU.tab && !editing) render();
      if ((!MU.ext || !MU.tab) && root.querySelector('.mu-grid')) render();
      Object.values(blocks).forEach((b) => b.update && b.update());
      const id = st && st.id;
      if (id && id !== lastId) { lastId = id; Object.values(blocks).forEach((b) => b.onTrack && b.onTrack()); }
    };
    musicHooks.add(onState);
    MUctl.toggleEdit = () => { editing = !editing; render(); };
    render();

    // клавиатура: пробел — пауза, ← → — перемотка, ↑ ↓ — громкость, / — поиск
    const onKey = (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.ctrlKey || e.altKey || e.metaKey) return;
      const st = MU.st || {};
      if (e.key === ' ') { e.preventDefault(); mcmd('toggle'); }
      else if (e.key === 'ArrowRight' && st.duration) mcmd('seek', Math.min(st.duration, (st.time || 0) + 10));
      else if (e.key === 'ArrowLeft' && st.duration) mcmd('seek', Math.max(0, (st.time || 0) - 10));
      else if (e.key === 'ArrowUp') mcmd('volume', Math.min(100, (st.volume || 0) + 5));
      else if (e.key === 'ArrowDown') mcmd('volume', Math.max(0, (st.volume || 0) - 5));
      else if (e.key === '/') {
        e.preventDefault();
        const idx = ML.cols.findIndex((c) => c.includes('search'));
        if (idx >= 0) { ML.active[idx] = 'search'; render(); setTimeout(() => blocks.search && blocks.search.focus(), 50); }
      } else return;
    };
    window.addEventListener('keydown', onKey);
    bar.focus();

    return () => {
      MUctl.toggleEdit = null; MUctl.editing = false;
      bar.musicWatch(false);
      musicHooks.delete(onState);
      window.removeEventListener('keydown', onKey);
      Object.values(blocks).forEach((b) => b.destroy && b.destroy());
    };
  },
});

// ============ главный экран ============
// Иконка «играть ↔ пауза» с плавным перетеканием формы: две половины треугольника становятся двумя полосками.
// Состояние задаётся классом .is-playing на кнопке, анимирует CSS (свойство d у path).
const PP_SVG = '<svg class="i pp" viewBox="0 0 24 24" aria-hidden="true"><path class="a" d="M7 4.5 L13 8.25 L13 15.75 L7 19.5 Z"/><path class="b" d="M13 8.25 L19 12 L19 12 L13 15.75 Z"/></svg>';

// одноразовая CSS-анимация на элементе
function animOnce(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); el.addEventListener('animationend', () => el.classList.remove(cls), { once: true }); }

// Карточка «Сейчас играет»: элементы создаются один раз и только обновляются —
// иначе анимации и перетаскивание ползунка сбивались бы при каждом обновлении данных.
function nowPlayingCard() {
  const card = h('div', { class: 'card np' });
  const artImg = h('img', { class: 'np-art', alt: '', hidden: true });
  const artPh = h('span', { class: 'np-art ph', html: icon('music') });
  const title = h('b', { class: 'np-title' });
  const artist = h('span', { class: 'muted np-artist' });
  const fill = h('b'), knob = h('i');
  const seek = h('div', { class: 'mu-seek np-seek', title: 'Перемотка — нажмите или тяните', role: 'slider', 'aria-label': 'Перемотка' }, fill, knob);
  const t1 = h('span'), t2 = h('span');
  const prog = h('div', { class: 'np-progress' }, seek, h('div', { class: 'np-times muted' }, t1, t2));
  const ctl = (k, ic, label, cls = '') => {
    const b = h('button', { class: 'ib ' + cls, title: label, 'aria-label': label }, I(ic));
    b.onclick = async (e) => {
      e.stopPropagation();
      if (k === 'prev') animOnce(b, 'nudge-l');
      if (k === 'next') animOnce(b, 'nudge-r');
      const ok = await bar.mediaCtl(k);
      if (!ok) bar.media(k === 'toggle' ? 'play' : k);
    };
    return b;
  };
  const prev = ctl('prev', 'prev', 'Предыдущий');
  const play = ctl('toggle', 'play', 'Играть / пауза', 'big');
  const next = ctl('next', 'next', 'Следующий');
  play.innerHTML = PP_SVG;
  card.append(artImg, artPh, h('div', { class: 'np-side' }, h('div', { class: 'np-meta' }, title, artist), prog, h('div', { class: 'np-ctl' }, prev, play, next)));
  // режим музыки — только для YouTube Music: для видео и других плееров он ничего не умеет
  card.addEventListener('click', (e) => { if (card.classList.contains('np-link') && !e.target.closest('button, .mu-seek')) openTool('music'); });
  artImg.addEventListener('load', () => animOnce(artImg, 'appear'));

  // перемотка: YouTube Music — через расширение (точнее), остальное — через системный медиаплеер Windows
  let drag = null;
  const dur = () => (S.media && S.media.duration) || 0;
  const frac = (e) => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  const showDrag = () => { fill.style.width = knob.style.left = (drag * 100) + '%'; t1.textContent = fmtT(drag * dur()); };
  const seekTo = (sec) => {
    const m = S.media || {};
    const viaExt = MU.ext && MU.tab && MU.st && MU.st.title && m.title && m.title === MU.st.title;
    if (viaExt) mcmd('seek', Math.round(sec)); else bar.mediaCtl('seek:' + Math.round(sec));
    if (S.media) S.media.position = sec;
  };
  seek.addEventListener('pointerdown', (e) => { if (!dur()) return; e.stopPropagation(); seek.setPointerCapture(e.pointerId); seek.classList.add('drag'); drag = frac(e); showDrag(); });
  seek.addEventListener('pointermove', (e) => { if (drag !== null) { drag = frac(e); showDrag(); } });
  seek.addEventListener('pointerup', () => { if (drag === null) return; seekTo(drag * dur()); drag = null; seek.classList.remove('drag'); draw(); });
  seek.addEventListener('pointercancel', () => { drag = null; seek.classList.remove('drag'); });
  seek.addEventListener('click', (e) => e.stopPropagation());

  let playIcon = '', artSrc = null;
  function draw() {
    const m = S.media;
    const has = !!(m && m.title);
    title.textContent = has ? m.title : 'Ничего не играет';
    title.title = has ? m.title : '';
    artist.textContent = has ? (m.artist || appName(m.app)) : 'Включите музыку или видео';
    const src = has && artUrl ? artUrl : '';
    if (src !== artSrc) { artSrc = src; artImg.hidden = !src; artPh.hidden = !!src; if (src) artImg.src = src; }
    const d = has ? m.duration || 0 : 0;
    prog.hidden = !(d > 0);
    if (d > 0 && drag === null) {
      const pct = Math.min(100, (m.position || 0) / d * 100);
      fill.style.width = knob.style.left = pct + '%';
      t1.textContent = fmtT(m.position); t2.textContent = fmtT(d);
    }
    const pi = has && m.playing ? 'pause' : 'play';
    if (pi !== playIcon) { playIcon = pi; play.classList.toggle('is-playing', pi === 'pause'); play.title = pi === 'pause' ? 'Пауза' : 'Играть'; }
    card.classList.toggle('paused', has && !m.playing);
    const norm = (x) => String(x || '').trim().toLowerCase();
    const isYTM = has && MU.ext && MU.tab && MU.st && MU.st.title && norm(m.title) === norm(MU.st.title);
    card.classList.toggle('np-link', !!isYTM);
    card.title = isYTM ? 'Открыть режим музыки' : '';
  }
  draw();
  card._draw = draw;
  return card;
}
const appName = (aumid) => {
  const s = String(aumid || '');
  if (/spotify/i.test(s)) return 'Spotify'; if (/chrome/i.test(s)) return 'Chrome'; if (/edge/i.test(s)) return 'Edge';
  if (/firefox/i.test(s)) return 'Firefox'; if (/yandex/i.test(s)) return 'Яндекс'; if (/music/i.test(s)) return 'Музыка';
  return s.split(/[!._]/)[0] || '';
};

function soundCard() {
  const card = h('div', { class: 'card sound' });
  const slider = makeSlider({ min: 0, max: 100, label: 'Громкость' }); slider.classList.add('vol');
  const val = h('b', { class: 'vol-val' });
  const muteBtn = h('button', { class: 'ib', title: 'Без звука' });
  let dragging = false, sendT = 0;
  slider.addEventListener('input', () => {
    dragging = true; val.textContent = slider.value + '%';
    clearTimeout(sendT); sendT = setTimeout(() => bar.audioSet({ volume: +slider.value }), 40);
  });
  slider.addEventListener('change', () => { dragging = false; });
  slider.addEventListener('wheel', (e) => { e.preventDefault(); slider.value = Math.max(0, Math.min(100, +slider.value + (e.deltaY < 0 ? 2 : -2))); slider.dispatchEvent(new Event('input')); setTimeout(() => (dragging = false), 300); }, { passive: false });
  muteBtn.onclick = () => S.audio && bar.audioSet({ mute: !S.audio.muted });
  const chip = (label, ic, on, fn, title) => h('button', { class: 'qt' + (on ? ' on' : ''), title: title || label, 'aria-pressed': String(!!on), onclick: fn }, I(ic), label);
  const chips = h('div', { class: 'qts' });
  let winLight = null, tbHide = null;
  bar.winTheme().then((v) => { winLight = v; draw(); });
  bar.taskbar().then((v) => { tbHide = v === undefined ? null : !!v; draw(); });
  const draw = () => {
    const a = S.audio;
    if (a && !dragging) { slider.value = a.volume; val.textContent = a.muted ? 'выкл.' : a.volume + '%'; }
    slider.disabled = !a;
    muteBtn.innerHTML = icon(a && a.muted ? 'mute' : 'volup');
    muteBtn.classList.toggle('on', !!(a && a.muted));
    chips.replaceChildren(
      chip(a && a.micMuted ? 'Микр. выкл.' : 'Микрофон', a && a.micMuted ? 'micoff' : 'mic', a && a.micMuted, () => a && a.mic && bar.audioSet({ mic: !a.micMuted }), 'Выключить / включить микрофон для всех программ'),
      chip('Не спать', 'coffee', Toggles.awake, async () => { Toggles.awake = await bar.keepAwake(!Toggles.awake); draw(); renderBar(); }, 'Экран не гаснет и компьютер не засыпает'),
      chip('Тема', winLight ? 'sun' : 'moon', false, async () => { if (winLight === null) return; winLight = await bar.winTheme(!winLight); draw(); }, 'Тема Windows: светлая / тёмная'),
      chip(tbHide ? 'Панель скрыта' : 'Скрыть панель', 'taskbar', !!tbHide, async () => { if (tbHide === null) return; const v = await bar.taskbar(!tbHide); tbHide = v === undefined ? !tbHide : !!v; draw(); }, tbHide ? 'Панель задач Windows скрывается — нажмите, чтобы закрепить' : 'Автоматически скрывать панель задач Windows'));
  };
  card.append(h('h4', {}, 'Звук и система'), h('div', { class: 'vol-row' }, muteBtn, slider, val), chips);
  draw();
  card._draw = draw;
  return card;
}

function devicesCard() {
  const card = h('div', { class: 'card devs' });
  const draw = () => {
    const list = devList().sort((a, b) => (b.connected - a.connected) || a.name.localeCompare(b.name));
    const rows = [];
    if (batt) rows.push({ name: 'Этот компьютер', level: batt.level, connected: true, ic: 'laptop', charging: batt.charging });
    list.forEach((d) => rows.push({ ...d, ic: devIcon(d.name, d.kind) }));
    card.replaceChildren(h('h4', {}, 'Устройства'),
      ...rows.slice(0, 5).map((d) => h('div', { class: 'dev' + (d.connected ? '' : ' off'), title: d.connected ? d.name + (d.level === -2 ? ' · на связи; эта прошивка приёмника не сообщает заряд' : '') + (d.charging ? ' · заряжается' : '') : `${d.name} · сейчас не на связи${d.last != null ? ', последний заряд ' + d.last + '%' : ''}` },
        I(d.ic), h('span', { class: 'txt' }, d.name),
        h('b', { class: d.connected && d.level >= 0 && d.level <= 20 && !d.charging ? 'red-t' : '' }, d.charging ? h('span', { class: 'hi-t', html: icon('bolt') }) : null,
          d.connected ? (d.level >= 0 ? d.level + '%' : 'на связи') : (d.level === -1 && /mouse|keyboard|headphones/.test(d.kind || '') ? 'не отвечает' : 'нет связи') + (d.last != null ? ` · ${d.last}%` : '')),
        h('div', { class: 'meter' }, h('b', { style: { width: (d.level === -2 ? 0 : d.connected ? d.level : d.last || 0) + '%', opacity: d.connected ? '' : '.45', background: d.connected && d.level <= 20 ? 'var(--red-g)' : 'var(--hi-g)' } })))),
      ...(rows.length ? [] : [h('div', { class: 'muted small' }, S.btLoaded === false ? 'Ищу устройства…' : 'Нет устройств с данными о заряде. Подключите наушники или геймпад по Bluetooth.')]));
  };
  draw();
  card._draw = draw;
  return card;
}


// ============ умный поиск в шапке ============
// Как поиск в «Пуске»: приложения, инструменты и действия Bar, файлы из индекса Windows, буфер обмена, расчёты.
// Всё ищется на этом компьютере. В интернет запрос уходит только если явно выбрать «Найти в интернете».
const searchEl = $('#search');
const Srch = { q: '', items: [], sel: 0, files: [], filesQ: '', fileT: 0, seq: 0, warm: false };
const SRCH_KW = {
  ocr: 'ocr распознать текст скан', color: 'цвет пипетка color picker hex', qrscan: 'qr сканер код scan',
  shot: 'скриншот снимок screenshot', qrmake: 'qr код создать', timer: 'таймер timer отсчёт', stopwatch: 'секундомер stopwatch',
  voice: 'диктофон запись голос voice', notes: 'заметки notes', clip: 'буфер обмена clipboard история', shelf: 'полка файлы shelf',
  phone: 'телефон передать файлы phone', calc: 'калькулятор calc посчитать', text: 'текст раскладка регистр транслит',
  system: 'система cpu память процессор', settings: 'настройки settings параметры тема горячие клавиши', apps: 'приложения программы все apps',
  music: 'музыка youtube music ytm',
};
const sNorm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
function sMatch(name, q) {
  const n = sNorm(name);
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 90 - Math.min(20, (n.length - q.length) / 2);
  const words = n.split(/[\s\-_.,()[\]«»"'\\/]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 72;
  const qw = q.split(/\s+/).filter(Boolean);
  if (qw.length > 1 && qw.every((x) => words.some((w) => w.startsWith(x)))) return 66;
  if (q.length >= 2 && !q.includes(' ') && words.map((w) => w[0]).join('').startsWith(q)) return 60; // «vsc» → Visual Studio Code
  if (n.includes(q)) return 45;
  return 0;
}
// тот же запрос в другой раскладке: «ntktuhfv» находит «Телеграм»
const sScore = (name, q, alt) => Math.max(sMatch(name, q), alt ? sMatch(name, alt) * 0.95 : 0);

function srchBarEntries() {
  const a = S.audio;
  const list = TOOLS.filter((t) => t.id !== 'music' || MU.ext).map((t) => ({
    key: 'tool:' + t.id, title: t.name, sub: 'Инструмент Bar', ic: t.icon, kw: SRCH_KW[t.id] || '', stay: true, run: () => openTool(t.id),
  }));
  list.push(
    { key: 'act:awake', title: Toggles.awake ? 'Разрешить сон' : 'Не спать', sub: 'Экран не гаснет, компьютер не засыпает', ic: 'coffee', kw: 'не спать сон awake', run: async () => { Toggles.awake = await bar.keepAwake(!Toggles.awake); renderBar(); flash(Toggles.awake ? 'Не засыпаю' : 'Сон разрешён'); } },
    { key: 'act:mute', title: a && a.muted ? 'Включить звук' : 'Выключить звук', sub: 'Звук Windows', ic: a && a.muted ? 'volup' : 'mute', kw: 'звук mute громкость тишина', run: () => a && bar.audioSet({ mute: !a.muted }) },
    { key: 'act:mic', title: a && a.micMuted ? 'Включить микрофон' : 'Выключить микрофон', sub: 'Для всех программ', ic: a && a.micMuted ? 'mic' : 'micoff', kw: 'микрофон mic', run: () => a && a.mic && bar.audioSet({ mic: !a.micMuted }) },
    { key: 'act:theme', title: 'Сменить тему Windows', sub: 'Светлая ↔ тёмная', ic: 'moon', kw: 'тема theme темная светлая dark light', run: async () => { const v = await bar.winTheme(); if (v !== null && v !== undefined) bar.winTheme(!v); } },
    { key: 'act:taskbar', title: 'Скрывать панель задач', sub: 'Включить или выключить автоскрытие', ic: 'taskbar', kw: 'панель задач taskbar скрыть', run: async () => { const v = await bar.taskbar(); if (v !== undefined) bar.taskbar(!v); } },
  );
  return list;
}

const fileIcons = new Map();
function srchFileIcon(f, slot) {
  const ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const key = f.isDir ? 'dir' : /^\.(exe|lnk|ico|url|appref-ms)$/.test(ext) || !ext ? f.path : ext;
  if (!fileIcons.has(key)) fileIcons.set(key, bar.fileInfo(f.path).then((r) => (r && r.ok ? r.icon : null)).catch(() => null));
  fileIcons.get(key).then((u) => { if (u) slot.replaceChildren(h('img', { alt: '', src: u })); });
}
const homeShort = (p) => p.replace(/^[a-z]:\\users\\[^\\]+/i, '~');

function srchCalc(q) {
  const s = q.replace(/^=/, '').trim();
  if (!/\d/.test(s) || !/[-+*/×÷^%()]|sqrt|sin|cos|tan|ln|log|pi|π/i.test(s.replace(/^-/, ''))) return null;
  if (/[a-zа-я]{2,}/i.test(s.replace(/sqrt|sin|cos|tan|ln|log|abs|round|pi/gi, ''))) return null;
  try { const v = calc(s); return Number.isFinite(v) ? v : null; } catch { return null; }
}
const looksUrl = (q) => /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(q) && !/\s/.test(q);

async function srchCompute() {
  const raw = Srch.q.trim();
  const q = sNorm(raw);
  const alt0 = sNorm(fixLayout(raw));
  const alt = alt0 !== q ? alt0 : '';
  const groups = [];
  const v = srchCalc(raw);
  if (v !== null) {
    const txt = v.toLocaleString('ru-RU', { maximumFractionDigits: 10 });
    groups.push({ name: 'Расчёт', rows: [{ key: 'calc', title: '= ' + txt, sub: 'Enter — скопировать результат', ic: 'calc', big: true, run: () => copy(String(v), txt + ' скопировано') }] });
  }
  if (looksUrl(raw)) {
    const url = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    groups.push({ name: 'Сайт', rows: [{ key: 'url', title: raw, sub: 'Открыть в браузере', ic: 'globe', run: () => bar.openUrl(url) }] });
  }
  const ranked = [];
  const all = Apps.all || [];
  const apps = all.map((a) => ({ a, s: sScore(a.name, q, alt) })).filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s || (Apps.uses[y.a.id] || 0) - (Apps.uses[x.a.id] || 0)).slice(0, 5)
    .map(({ a, s }) => {
      const g = Apps.running(a);
      return { key: 'app:' + a.id, s, title: a.name, sub: g ? 'Приложение · открыто' : 'Приложение', app: a, run: () => Apps.open(a),
        alt: { label: 'Закрепить в нотче', ic: 'pin', run: () => { Apps.isPinned(a) ? Apps.unpin(a) : Apps.pin(a); flash(Apps.isPinned(a) ? 'Закреплено в нотче' : 'Откреплено'); } } };
    });
  if (apps.length) ranked.push({ name: 'Приложения', rows: apps, best: apps[0].s });
  const own = srchBarEntries().map((e) => ({ ...e, s: Math.max(sScore(e.title, q, alt), sScore(e.kw, q, alt) * 0.8) }))
    .filter((e) => e.s > 0).sort((x, y) => y.s - x.s).slice(0, 4);
  if (own.length) ranked.push({ name: 'Bar', rows: own, best: own[0].s });
  ranked.sort((x, y) => y.best - x.best);
  groups.push(...ranked);
  if (Srch.filesQ === raw && Srch.files.length) {
    // ярлык программы, которая уже есть в «Приложениях», не дублируем
    const appNames = new Set(all.map((a) => sNorm(a.name)));
    const rows = Srch.files.filter((f) => !(/\.lnk$/i.test(f.name) && appNames.has(sNorm(f.name.replace(/\.lnk$/i, ''))))).map((f, i) => ({ f, s: sScore(f.name, q, alt) * 10 - i })).sort((x, y) => y.s - x.s).slice(0, 6).map(({ f }) => ({
      key: 'file:' + f.path, title: f.name, sub: homeShort(f.dir), file: f, run: () => bar.openPath(f.path),
      alt: { label: 'Показать в папке', ic: 'folder', run: () => bar.showInFolder(f.path) },
    }));
    if (rows.length) groups.push({ name: 'Файлы и папки', rows });
  }
  const cl = q.length >= 2 ? clips.filter((c) => c.t && sNorm(c.t).includes(q)).slice(0, 3) : [];
  if (cl.length) groups.push({ name: 'Буфер обмена', rows: cl.map((c, i) => ({
    key: 'clip:' + i + c.t.slice(0, 20), title: c.t.replace(/\s+/g, ' ').trim().slice(0, 140), sub: 'Enter — скопировать', ic: 'clip', run: () => copy(c.t),
  })) });
  groups.push({ name: 'Интернет', rows: [{ key: 'web', title: `Найти в интернете «${raw}»`, sub: 'Откроется в браузере', ic: 'globe', web: true, run: () => bar.openUrl('https://www.google.com/search?q=' + encodeURIComponent(raw)) }] });
  return groups;
}

function srchMark(title, q) {
  const n = sNorm(title), i = q ? n.indexOf(q) : -1;
  if (i < 0) return [document.createTextNode(title)];
  return [document.createTextNode(title.slice(0, i)), h('mark', {}, title.slice(i, i + q.length)), document.createTextNode(title.slice(i + q.length))];
}

async function srchRender() {
  const seq = ++Srch.seq;
  // список «Пуска» грузится несколько секунд — рисуем сразу, приложения добавятся, когда придут
  if (!Apps.all) Apps.load().then(() => { if (Srch.q.trim()) { Srch.keep = true; srchRender(); } });
  const groups = await srchCompute();
  if (seq !== Srch.seq || !Srch.q.trim()) return;
  const prevKey = Srch.items[Srch.sel] && Srch.items[Srch.sel].key;
  const keepSel = Srch.keep && Srch.moved && prevKey; // выбор сохраняем, только если его меняли руками
  Srch.items = groups.flatMap((g) => g.rows);
  const k = keepSel ? Srch.items.findIndex((x) => x.key === prevKey) : -1;
  Srch.sel = k >= 0 ? k : 0;
  Srch.keep = false;
  const q = sNorm(Srch.q.trim());
  const list = h('div', { class: 'list srch-list', role: 'listbox' });
  let n = 0;
  for (const g of groups) {
    list.append(h('div', { class: 'srch-h' }, g.name));
    for (const r of g.rows) {
      const idx = n++;
      const ico = h('span', { class: 'srch-ico' + (r.app || r.file ? '' : ' sym') });
      if (r.app) { const img = h('img', { alt: '' }); ico.append(img); Apps.icon(r.app, img); }
      else if (r.file) { ico.innerHTML = icon(r.file.isDir ? 'folder' : 'file'); srchFileIcon(r.file, ico); }
      else ico.innerHTML = icon(r.ic);
      const el = h('div', { class: 'item srch-row' + (r.big ? ' big' : ''), role: 'option',
        onclick: (e) => srchRun(r, e.shiftKey || e.ctrlKey), onmousemove: (e) => {
          // перерисовка под неподвижным курсором тоже шлёт mousemove — реагируем только на настоящее движение
          const pt = e.screenX + ',' + e.screenY; if (pt === Srch.pt) return; Srch.pt = pt;
          if (Srch.sel !== idx) { Srch.moved = true; srchSelect(idx, false); }
        } },
        ico, h('span', { class: 'srch-t' }, h('b', {}, ...srchMark(r.title, r.web ? '' : q)), h('span', {}, r.sub || '')),
        r.alt && h('button', { class: 'ib srch-alt', title: r.alt.label + ' (Shift+Enter)', onclick: (e) => { e.stopPropagation(); srchRun(r, true); } }, I(r.alt.ic)),
        h('span', { class: 'srch-go', html: icon('enter') }));
      r.el = el;
      list.append(el);
    }
  }
  searchEl.replaceChildren(list, h('div', { class: 'srch-foot muted small' },
    h('span', {}, h('kbd', { class: 'k' }, '↑↓'), ' выбор'), h('span', {}, h('kbd', { class: 'k' }, 'Enter'), ' открыть'),
    h('span', {}, h('kbd', { class: 'k' }, 'Shift+Enter'), ' в папке / закрепить'), h('span', {}, h('kbd', { class: 'k' }, 'Esc'), ' очистить'),
    h('span', { class: 'grow' }), h('span', {}, 'Ищется на этом компьютере')));
  srchSelect(Srch.sel, false);
}
function srchSelect(i, scroll = true) {
  if (!Srch.items.length) return;
  Srch.sel = (i + Srch.items.length) % Srch.items.length;
  Srch.items.forEach((r, k) => r.el && r.el.classList.toggle('sel', k === Srch.sel));
  const el = Srch.items[Srch.sel].el;
  if (scroll && el) el.scrollIntoView({ block: 'nearest' });
}
function srchRun(r, alt) {
  if (!r) return;
  if (alt && r.alt) { r.alt.run(); if (r.app) return srchRender(); }
  else r.run();
  if (r.stay) { srchClear(); return; }   // инструмент Bar открывается здесь же
  if (r.key === 'calc' || r.key.startsWith('clip:') || r.key.startsWith('act:')) return; // результат виден во вспышке, панель не закрываем
  srchClear();
  collapse(true);
}
function srchSet(q) {
  Srch.q = q;
  Srch.moved = false;
  srchBox.classList.toggle('has', !!q);
  const on = !!q.trim();
  searchEl.hidden = !on;
  if (!current) homeEl.hidden = on;
  if (!on) { Srch.items = []; searchEl.replaceChildren(); Srch.seq++; return; }
  srchRender();
  // файлы — с небольшой задержкой, пока человек печатает
  clearTimeout(Srch.fileT);
  const raw = q.trim();
  if (raw.length < 2 || srchCalc(raw) !== null) { Srch.files = []; Srch.filesQ = ''; return; }
  Srch.fileT = setTimeout(async () => {
    const res = await bar.findFiles(raw).catch(() => []);
    if (Srch.q.trim() !== raw) return;
    Srch.files = res || []; Srch.filesQ = raw; Srch.keep = true;
    srchRender();
  }, 140);
}
function srchClear() { srchInput.value = ''; srchSet(''); }
function srchFocus(select) {
  if (current) goHome();
  srchInput.focus();
  if (select) srchInput.select();
}
srchInput.addEventListener('input', () => srchSet(srchInput.value));
srchInput.addEventListener('focus', () => {
  bar.focus();
  if (!Srch.warm) { Srch.warm = true; Apps.load(); bar.findFiles('bar-warmup'); } // поднимаем процесс поиска заранее
});
srchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); Srch.moved = true; srchSelect(Srch.sel + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); Srch.moved = true; srchSelect(Srch.sel - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); srchRun(Srch.items[Srch.sel], e.shiftKey || e.ctrlKey); }
  else if (e.key === 'Escape') { e.stopPropagation(); if (srchInput.value) srchClear(); else { srchInput.blur(); collapse(true); } }
});
srchKbd.textContent = '';
const srchHint = () => { const k = hk('search'); srchKbd.textContent = k; srchKbd.hidden = !k; };
bar.onHotkeys(srchHint);
bar.hotkeysGet().then(srchHint);
// начали печатать на главном экране — текст сразу уходит в поиск
document.addEventListener('keydown', (e) => {
  if (state !== 'open' || current || e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1 || e.key === ' ') return;
  const ae = document.activeElement;
  if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
  srchInput.focus();
});
bar.onSearch(() => { expand(); srchFocus(true); });
openHooks.add((open) => { if (open) Apps.load(); if (!open) setTimeout(() => { if (state !== 'open') srchClear(); }, 450); });
const srchTyping = () => document.activeElement === srchInput;

function renderHome() {
  homeEl.innerHTML = '';
  const np = nowPlayingCard(), snd = soundCard(), dev = devicesCard();
  homeEl.append(h('div', { class: 'widgets' }, np, snd, dev), dockEl());
  homeEl.append(h('div', { class: 'tiles' }, TOOLS.filter((t) => !t.hidden).map((t, i) => h('button', {
    class: 'tile', style: { animationDelay: `${60 + i * 16}ms` }, onclick: () => openTool(t.id),
    title: t.hk && hk(t.hk) ? `${t.name} · ${hk(t.hk)}` : t.name,
  }, I(t.icon), h('span', { class: 'lbl' }, t.short || t.name)))));
  homeEl._live = (p) => {
    if ('media' in p) np._draw();
    if ('audio' in p) snd._draw();
    if ('bt' in p || 'hid' in p) dev._draw();
  };
}
liveHooks.add((p) => { if (state === 'open' && !current && homeEl._live) homeEl._live(p); });
// данные из расширения YouTube Music тоже влияют на карточку (можно ли открыть режим музыки)
musicHooks.add(() => { if (state === 'open' && !current && homeEl._live) homeEl._live({ media: true }); });
openHooks.add(() => pushNeed());

// ============ результаты из главного процесса ============
bar.onBusy((b) => setAct('busy', b ? { html: () => `<span class="dot busy"></span><span>Распознаю…</span>` } : null));
bar.onResult((r) => {
  if (r.type === 'error') { flash('Ошибка: ' + r.text.slice(0, 40), 4000); return; }
  if (r.type === 'ocr') {
    if (r.text) { ocrHist.unshift(r.text); ocrHist.length = Math.min(ocrHist.length, 10); store.set('ocrHist', ocrHist); }
    flash(r.text ? 'Текст скопирован' : 'Текст не найден');
  }
  if (r.type === 'color') flash(`${r.hex} скопирован`);
  if (r.type === 'qrscan') flash(r.text ? 'QR скопирован' : 'QR не найден');
  if (r.type === 'shot') flash('Скриншот в буфере');
  expand({ auto: true });
  openTool(r.type, r);
});

renderHome();
renderBar();
pushNeed();
oledApply();
wakeLive(); // и сразу после запуска свёрнутый нотч через 8 с успокаивается
