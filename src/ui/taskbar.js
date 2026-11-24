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
const LUC = { start: 'LayoutGrid', search: 'Search', desktop: 'PanelBottomClose' };
function icon(n) {
  const node = window.lucide && window.lucide.icons && window.lucide.icons[LUC[n]];
  const inner = node ? node.map(([tag, a]) => `<${tag} ${Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('') : '';
  return `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
}

const SIZES = { s: 44, m: 52, l: 62 };
const tb = $('#tb'), tip = $('#tb-tip');
let cfg = { on: true, mode: 'hide', size: 'm', magnify: true };
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
const owns = (app, w) => (app.exe && lower(app.exe) === lower(w.exe)) || (app.uwp && matchUwp(app.uwp, w.exe));

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
    el.addEventListener('mouseenter', () => showTip(el));
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
  el.querySelector('.tb-dots').replaceChildren(...Array.from({ length: n ? Math.min(n, 3) : it.away.length ? 1 : 0 }, () => h('i')));
  el.title = '';
  return el;
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
  const want = [
    fixed('sys:start', 'start', 'Приложения', () => bar.tbApps(), () => bar.tbStart()), // правый клик — «Пуск» Windows
    fixed('sys:search', 'search', 'Поиск', () => bar.tbSearch()),
    sep('sep1'),
    ...pinned.map(itemEl),
    running.length && pinned.length ? sep('sep2') : null,
    ...running.map(itemEl),
    sep('sep3'),
    fixed('sys:desktop', 'desktop', 'Свернуть всё', () => bar.tbDesktop()),
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
const sizePx = () => SIZES[cfg.size] || 52;
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
  });
}

// ---------- показ / скрытие ----------
let shown = false, hideT = 0, over = false, menuOpen = false;
function show() { clearTimeout(hideT); if (shown) return; shown = true; document.body.classList.add('shown'); }
function hideSoon(ms = 650) {
  clearTimeout(hideT);
  if (cfg.mode !== 'hide') return;
  hideT = setTimeout(() => { if (over || menuOpen) return; shown = false; document.body.classList.remove('shown'); hideTip(); }, ms);
}
document.addEventListener('mousemove', (e) => {
  // окно таскбара прозрачно для мыши, но получает движение: у нижнего края — выезжаем
  if (cfg.mode === 'hide' && !shown && e.clientY >= window.innerHeight - 3) show();
});
shell.addEventListener('mouseenter', () => { over = true; show(); document.body.classList.add('mag'); bar.tbInteractive(true); });
shell.addEventListener('mouseleave', () => { over = false; lastX = null; document.body.classList.remove('mag'); magnify(null); hideTip(); bar.tbInteractive(false); hideSoon(); });
shell.addEventListener('mousemove', (e) => { lastX = e.clientX; magnify(e.clientX); });

function applyCfg(c) {
  cfg = { ...cfg, ...c };
  document.documentElement.style.setProperty('--tb-s', sizePx() + 'px');
  document.body.classList.toggle('mode-hide', cfg.mode === 'hide');
  document.body.classList.toggle('mode-always', cfg.mode === 'always');
  if (cfg.mode === 'always') show(); else hideSoon(1200);
  render();
}

bar.onTbWins((list) => { wins = list || []; render(); });
bar.onTbCfg(applyCfg);
window.addEventListener('storage', (e) => { if (e.key === 'bar.dock') { pins = store.get('dock', []) || []; render(); } });
bar.taskbarGet().then((c) => { applyCfg(c); show(); hideSoon(2500); }); // при запуске — показаться и уехать
