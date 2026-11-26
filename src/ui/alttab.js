// Переключатель окон Bar по Alt+Tab. Клавиши ловит Rust (alttab.rs) и присылает: открыть, сдвинуть выделение, выбрать/отменить.
// Окна — по порядку «последние сверху». Быстрое Alt+Tab (меньше ~120 мс) переключает на предыдущее окно, панель даже не показывается.
'use strict';
const $ = (s) => document.querySelector(s);
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}
function icon(n) {
  const node = window.lucide && window.lucide.icons && window.lucide.icons[n];
  const inner = node ? node.map(([tag, a]) => `<${tag} ${Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('') : '';
  return `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
}

const panel = $('#at-panel'), grid = $('#at-grid'), selEl = $('#at-sel'), dim = $('#at-dim');
let list = [], sel = 0, cfg = {}, open = false, shown = false, showT = 0, cols = 1;
const icons = new Map();
// «Карусель» и «Стопка»: карточки на сцене двигаются трансформациями, живая миниатюра — только у передней
const deck = () => cfg.view === 'carousel' || cfg.view === 'stack';
let stills = {}; // снимки окон для задних карточек (живую миниатюру Windows нельзя наклонять)

function cardOf(w, i) {
  const ic = h('span', { class: 'at-ic' }), big = h('span', { class: 'at-ic' });
  const key = 'exe:' + w.exe;
  const put = (u) => { for (const x of [ic, big]) x.replaceChildren(u ? h('img', { src: u, alt: '' }) : h('span', { class: 'at-letter' }, (w.title || '?').charAt(0).toUpperCase())); };
  if (icons.has(key)) put(icons.get(key)); else bar.appIcon({ id: key, exe: w.exe, name: w.title }).then((u) => { icons.set(key, u || null); put(u); }).catch(() => put(null));
  const close = h('button', { class: 'at-x', title: 'Закрыть окно', 'aria-label': 'Закрыть окно', html: icon('X') });
  close.addEventListener('click', (e) => { e.stopPropagation(); closeWin(list.indexOf(w)); });
  // место под живую миниатюру (её рисует Windows поверх страницы); значок — пока миниатюра не появилась
  const shot = cfg.view === 'thumbs' || deck() ? h('span', { class: 'at-shot' }, h('span', { class: 'at-shot-ic' }, big)) : null;
  // как у Windows: сверху значок, название и крестик в одну строку, под ними — окно
  const card = h('div', { class: 'at-card', role: 'option', title: w.title },
    h('span', { class: 'at-head' }, ic, cfg.titles !== false ? h('span', { class: 'at-t' }, w.title || w.exe) : h('span', { class: 'grow' }), close),
    shot);
  // в сетке наведение выбирает; на сцене карточки сами ездят под курсором — выбор только кликом
  card.addEventListener('mouseenter', () => { if (!deck()) setSel(list.indexOf(w), true); });
  card.addEventListener('click', () => { const i = list.indexOf(w); if (deck() && i !== sel) { setSel(i); return; } setSel(i); pick(); });
  card.addEventListener('auxclick', (e) => { if (e.button === 1) closeWin(list.indexOf(w)); });
  card._w = w; card._shot = shot;
  return card;
}

function layout() {
  if (deck()) { cols = 1; grid.style.gridTemplateColumns = ''; return; }
  // сколько карточек в ряду — чтобы панель не шире 86% экрана
  const first = grid.firstElementChild;
  if (!first) return;
  const cw = first.offsetWidth + parseFloat(getComputedStyle(grid).columnGap || 0);
  const max = Math.max(1, Math.floor((window.innerWidth * 0.86 - 24) / cw));
  cols = cfg.view === 'list' ? 1 : Math.min(max, list.length);
  grid.style.gridTemplateColumns = `repeat(${cols}, auto)`;
}

function render() {
  document.body.dataset.view = cfg.view || 'thumbs';
  document.body.dataset.size = cfg.size || 'm';
  document.body.classList.toggle('dim', cfg.dim !== false);
  grid.classList.toggle('deck', deck());
  grid.replaceChildren(...list.map(cardOf));
  if (deck()) for (const c of grid.children) if (c._w && stills[c._w.hwnd]) addStill(c, stills[c._w.hwnd]);
  if (!list.length) grid.append(h('div', { class: 'at-empty' }, 'Открытых окон нет'));
  layout();
}

// ---------- сцена: карусель и стопка ----------
function deckPos(i) {
  const n = list.length;
  if (cfg.view === 'carousel') {
    let d = ((i - sel) % n + n) % n; if (d > n / 2) d -= n; // ближайшее расстояние по кругу
    const a = Math.abs(d), s = Math.sign(d);
    const x = a === 0 ? 0 : s * (58 + (a - 1) * 30);             // % ширины карточки
    const sc = [1, .78, .64, .54][Math.min(a, 3)];
    return { t: `translateX(${x}%) rotateY(${-s * Math.min(a, 1) * 40}deg) scale(${sc})`, o: a > 3 ? 0 : 1 - a * .14, z: 50 - a, f: `brightness(${1 - Math.min(a, 3) * .16})` };
  }
  const d = ((i - sel) % n + n) % n; // стопка: 0 — передняя, дальше — глубже
  const v = Math.min(d, 5);
  return { t: `translate(${v * 4.5}%, ${-v * 6}%) scale(${1 - v * .055})`, o: d > 4 ? 0 : 1 - d * .16, z: 50 - d, f: `brightness(${1 - v * .13})` };
}
function placeDeck(jump, from) {
  [...grid.children].forEach((c, i) => {
    if (!c._w) return;
    const p = deckPos(i);
    if (jump) c.style.transition = 'none';
    // стопка, Tab вперёд: передняя карточка «уходит» вниз и возвращается в самый конец колоды
    if (!jump && cfg.view === 'stack' && i === from && p.z < 46) {
      c.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(38%) scale(.92)', opacity: 0, offset: .45 }, { transform: p.t, opacity: 0 }], { duration: 420, easing: 'cubic-bezier(.3,.7,.2,1)' });
    }
    c.style.transform = p.t; c.style.opacity = p.o; c.style.zIndex = p.z; c.style.filter = p.f;
    if (jump) { void c.offsetWidth; c.style.transition = ''; }
  });
}
function addStill(c, u) {
  if (!c._shot || c._shot.querySelector('img')) return;
  const img = h('img', { src: u, alt: '' });
  img.addEventListener('load', () => img.classList.add('ok'));
  c._shot.append(img);
}
function loadStills() {
  const ids = list.filter((w) => !w.min && !stills[w.hwnd]).map((w) => w.hwnd);
  if (!ids.length) return;
  const at = list;
  bar.atThumbs(ids).then((m) => { if (!m) return; Object.assign(stills, m); if (at !== list) return; for (const c of grid.children) if (c._w && m[c._w.hwnd]) addStill(c, m[c._w.hwnd]); }).catch(() => {});
}

let lastSel = 0;
function placeSel(jump) {
  const c = grid.children[sel];
  [...grid.children].forEach((x, i) => x.classList.toggle('on', i === sel));
  if (deck()) { selEl.style.opacity = '0'; placeDeck(jump, lastSel); lastSel = sel; return; }
  if (!c || !c._w) { selEl.style.opacity = '0'; return; }
  // от раскладки, а не от экрана: панель при появлении увеличивается (96% → 100%), и экранные координаты в этот
  // момент ещё «уменьшенные» — рамка уезжала мимо карточки
  if (jump) selEl.style.transition = 'none';
  selEl.style.opacity = '1';
  selEl.style.transform = `translate(${grid.offsetLeft + c.offsetLeft}px, ${grid.offsetTop + c.offsetTop}px)`;
  selEl.style.width = c.offsetWidth + 'px'; selEl.style.height = c.offsetHeight + 'px';
  if (jump) { void selEl.offsetWidth; selEl.style.transition = ''; }
}
function setSel(i, hover) {
  if (!list.length) return;
  const was = sel;
  sel = ((i % list.length) + list.length) % list.length;
  // на сцене живая миниатюра уходит вместе со старой передней карточкой и появляется у новой, когда та встанет на место
  if (deck() && was !== sel && shown) { bar.thumbsClear(false); sendThumbs(360); }
  placeSel(false);
  if (!hover) { const c = grid.children[sel]; if (c && c.scrollIntoView) c.scrollIntoView({ block: 'nearest' }); }
}

// живые миниатюры окон (как у Windows — есть всегда, и у свёрнутых): места под них — в пикселях окна
let thumbT = 0;
function sendThumbs(delay = 0, fade = true) {
  clearTimeout(thumbT);
  if ((cfg.view !== 'thumbs' && !deck()) || !open) return;
  thumbT = setTimeout(() => {
    if (!open) return;
    const k = window.devicePixelRatio || 1, pr = panel.getBoundingClientRect();
    const items = [];
    for (const c of grid.children) {
      if (!c._shot) continue;
      if (deck() && c !== grid.children[sel]) continue; // на сцене — только передняя карточка
      const r = c._shot.getBoundingClientRect();
      if (r.top < pr.top - 1 || r.bottom > pr.bottom + 1) continue; // прокручено за край панели
      items.push({ hwnd: c._w.hwnd, l: (r.left + 4) * k, t: (r.top + 4) * k, r: (r.right - 4) * k, b: (r.bottom - 4) * k });
    }
    bar.thumbsShow(items, fade);
  }, delay);
}

function reveal() {
  if (!open || shown) return;
  shown = true;
  document.body.classList.add('shown');
  placeSel(true);
  // карточки появляются лёгкой волной
  [...grid.children].forEach((c, i) => c.animate([{ opacity: 0, transform: 'translateY(6px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: Math.min(i, 12) * 14, easing: 'cubic-bezier(.3,1.2,.5,1)', fill: 'backwards' }));
  sendThumbs(330); // когда панель встала на место (её появление — 0,3 с)
  if (deck()) loadStills();
}

const onOpen = (m) => {
  cfg = m.cfg || {};
  list = m.list || [];
  open = true; shown = false; stills = {};
  document.body.classList.remove('shown', 'leave');
  render();
  // первое окно — то, что впереди; Alt+Tab ведёт к следующему, Alt+Shift+Tab — к последнему
  const fgFirst = list.length && list[0].active;
  sel = m.dir < 0 ? list.length - 1 : (fgFirst && list.length > 1 ? 1 : 0);
  lastSel = sel;
  placeSel(true);
  clearTimeout(showT);
  showT = setTimeout(reveal, 120); // быстрый Alt+Tab — без панели
};
bar.onAtOpen(onOpen);
const onMove = (d) => {
  if (!open) return;
  if (!shown) reveal();
  if (d === 'up') setSel(sel - (deck() ? 1 : cols)); else if (d === 'down') setSel(sel + (deck() ? 1 : cols)); else setSel(sel + d);
};
bar.onAtMove(onMove);
// для проверки без клавиатуры (отладка тестовой сборки)
window.__at = { open: onOpen, move: onMove, state: () => ({ open, shown, sel, cols, n: list.length }) };
bar.onAtCommit((ok) => { if (ok) pick(); else cancel(); });

function finish(hwnd) {
  open = false; clearTimeout(showT); clearTimeout(thumbT);
  bar.thumbsClear(true);
  document.body.classList.add('leave');
  document.body.classList.remove('shown');
  bar.atPick(hwnd || 0);
}
function pick() { const w = list[sel]; finish(w ? w.hwnd : 0); }
function cancel() { finish(0); }
function closeWin(i) {
  const w = list[i]; if (!w) return;
  bar.atClose(w.hwnd);
  const c = grid.children[i];
  const done = () => { list.splice(list.indexOf(w), 1); if (sel >= list.length) sel = Math.max(0, list.length - 1); render(); placeSel(true); if (!list.length) cancel(); else sendThumbs(30, false); };
  if (c) c.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.85)' }], { duration: 180, easing: 'ease-in' }).onfinish = done; else done();
}
// клик мимо панели — отмена
dim.addEventListener('click', cancel);
document.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('resize', () => { if (open) { layout(); placeSel(true); sendThumbs(60, false); } });
panel.addEventListener('scroll', () => { if (open && shown) sendThumbs(40, false); });
// колёсико мыши — листать (на сцене и в сетке)
panel.addEventListener('wheel', (e) => { if (!open || !shown || !deck()) return; e.preventDefault(); setSel(sel + (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1)); }, { passive: false });

// страница готова — только теперь Bar начинает перехватывать Alt+Tab
bar.atReady();
