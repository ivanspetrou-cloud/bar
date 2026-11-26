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
  const put = (u) => { for (const x of [ic, big]) x.replaceChildren(u ? h('img', { src: u, alt: '', draggable: 'false' }) : h('span', { class: 'at-letter' }, (w.title || '?').charAt(0).toUpperCase())); };
  if (icons.has(key)) put(icons.get(key)); else bar.appIcon({ id: key, exe: w.exe, name: w.title }).then((u) => { icons.set(key, u || null); put(u); }).catch(() => put(null));
  const close = h('button', { class: 'at-x', title: 'Закрыть окно', 'aria-label': 'Закрыть окно', html: icon('X') });
  close.addEventListener('click', (e) => { e.stopPropagation(); closeWin(list.indexOf(w)); });
  // место под живую миниатюру (её рисует Windows поверх страницы); значок — пока миниатюра не появилась
  const shot = cfg.view === 'thumbs' || deck() ? h('span', { class: 'at-shot' }, h('span', { class: 'at-shot-ic' }, big)) : null;
  // как у Windows: сверху значок, название и крестик в одну строку, под ними — окно
  const card = h('div', { class: 'at-card', role: 'option', title: w.title },
    h('span', { class: 'at-head' }, ic, cfg.titles !== false ? h('span', { class: 'at-t' }, w.title || w.exe) : h('span', { class: 'grow' }), close),
    shot);
  // в сетке наведение выбирает; на сцене карточки сами ездят под курсором — выбор только кликом;
  // в стопке наведённое заднее окно приподнимается
  card.addEventListener('mouseenter', () => { if (!deck()) setSel(list.indexOf(w), true); });
  card.addEventListener('click', () => { if (noClick) return; const i = list.indexOf(w); if (deck() && i !== sel) { setSel(i); return; } setSel(i); pick(); });
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
    // плоская лента без наложений: у каждой видимой карточки — живая миниатюра Windows (её нельзя повернуть или наложить)
    let d = ((i - sel) % n + n) % n; if (d > n / 2) d -= n; // ближайшее расстояние по кругу
    const a = Math.min(Math.abs(d), 4), s = Math.sign(d);
    const SC = [1, .7, .5, .38, .3], C = [0, .89, 1.53, 2.01, 2.39]; // масштаб и центр (в ширинах карточки)
    // боковых — сколько целиком помещается на этом экране (на XL — меньше): за краем окна ничего не рисуем
    const front = grid.children[sel], dw = (front && front.offsetWidth) || 300;
    const half = (window.innerWidth / 2 - 12) / dw;
    let fit = 0; while (fit < 3 && C[fit + 1] + SC[fit + 1] / 2 <= half) fit++;
    const show = Math.abs(d) <= fit;
    const dimK = [1, .72, .5, .36, 0][a];
    return { t: `translateX(${s * C[a] * 100}%) scale(${SC[a]})`, o: show ? 1 : 0, z: 50 - a, f: `brightness(${.4 + dimK * .6})`, live: show, dimK };
  }
  // стопка-картотека: выбранное окно спереди целиком, следующие стоят за ним и выглядывают сверху полоской;
  // наведённое заднее приподнимается — видно больше
  const d = ((i - sel) % n + n) % n;
  const v = Math.min(d, 6);
  const c = grid.children[i];
  const lift = d > 0 && c && c._lift ? 26 : 0; // % высоты карточки
  return { t: `translateY(${-v * 11 - lift}%) scale(${1 - v * .045})`, o: d > 5 ? 0 : 1, z: 50 - d, f: 'none', live: d <= 5, dimK: 1 - Math.min(v, 5) * .12 };
}
function placeDeck(jump, from) {
  [...grid.children].forEach((c, i) => {
    if (!c._w) return;
    const p = deckPos(i);
    if (jump) c.style.transition = 'none';
    c.style.transform = (dragPx ? `translateX(${dragPx}px) ` : '') + p.t; c.style.opacity = p.o; c.style.zIndex = p.z; c.style.filter = c._hover ? 'none' : p.f;
    c._live = !!p.live; c._dim = p.dimK == null ? 1 : p.dimK;
    if (jump) { void c.offsetWidth; c.style.transition = ''; }
  });
}
function addStill(c, u) {
  if (!c._shot || c._shot.querySelector('img')) return;
  const img = h('img', { src: u, alt: '', draggable: 'false' });
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
// наведение на сцене: карточка под курсором определяется по точке при каждом движении мыши (карточки сами ездят
// под неподвижным курсором, и события «зашла/ушла» тут врут). Наведённая — непрозрачная; в стопке заднее — приподнимается
let hoverCard = null;
function setHover(c) {
  if (c === hoverCard) return;
  if (hoverCard) { hoverCard._lift = false; hoverCard._hover = false; }
  hoverCard = c;
  if (c) { c._hover = true; c._lift = cfg.view === 'stack' && c !== grid.children[sel]; }
  if (open && shown) { placeDeck(false, -1); trackThumbs(480); }
}
grid.addEventListener('pointermove', (e) => {
  if (!deck() || drag && drag.moved) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  setHover(el && el.closest ? el.closest('.at-card') : null);
});
grid.addEventListener('pointerleave', () => { if (deck()) setHover(null); });
// ---------- карусель: листать перетаскиванием мышью ----------
// лента едет за курсором, миниатюры — вместе с ней; отпустили — доезжает до ближайшего окна
let dragPx = 0, drag = null, dragRaf = 0, noClick = false;
grid.addEventListener('pointerdown', (e) => {
  if (cfg.view !== 'carousel' || e.button !== 0 || !shown || list.length < 2) return;
  drag = { x0: e.clientX, moved: false, id: e.pointerId };
});
grid.addEventListener('pointermove', (e) => {
  if (!drag) return;
  let dx = e.clientX - drag.x0;
  if (!drag.moved) { if (Math.abs(dx) < 6) return; drag.moved = true; grid.setPointerCapture(drag.id); grid.classList.add('dragging'); }
  const front = grid.children[sel];
  const step = (front ? front.offsetWidth : 300) * .89; // расстояние между соседними окнами
  // перетянули на соседнее окно — оно становится центральным, лента продолжает ехать с того же места
  while (dx < -step / 2) { sel = (sel + 1) % list.length; drag.x0 -= step; dx += step; }
  while (dx > step / 2) { sel = (sel - 1 + list.length) % list.length; drag.x0 += step; dx -= step; }
  dragPx = dx;
  [...grid.children].forEach((x, i) => x.classList.toggle('on', i === sel));
  placeDeck(false, -1); lastSel = sel;
  if (!dragRaf) dragRaf = requestAnimationFrame(() => { dragRaf = 0; if (open) bar.thumbsShow(thumbItems(), true); });
});
const dragEnd = () => {
  if (!drag) return;
  const moved = drag.moved; drag = null;
  if (!moved) return;
  noClick = true; setTimeout(() => { noClick = false; }, 0);
  grid.classList.remove('dragging');
  dragPx = 0; placeDeck(false, -1); trackThumbs(520); // доезжает до ближайшего окна
};
grid.addEventListener('pointerup', dragEnd);
grid.addEventListener('pointercancel', dragEnd);
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
  // после Tab наведение сбрасывается: под курсором теперь другая карточка (определится при следующем движении мыши)
  if (deck() && was !== sel && hoverCard) { hoverCard._lift = false; hoverCard._hover = false; hoverCard = null; }
  if (deck() && was !== sel && shown) trackThumbs(560); // миниатюры едут вместе с карточками каждый кадр
  placeSel(false);
  if (!hover) { const c = grid.children[sel]; if (c && c.scrollIntoView) c.scrollIntoView({ block: 'nearest' }); }
}

// живые миниатюры окон (как у Windows — есть всегда, и у свёрнутых): места под них — в пикселях окна
let thumbT = 0;
function thumbItems() {
  const k = window.devicePixelRatio || 1, pr = panel.getBoundingClientRect(), car = cfg.view === 'carousel', stk = cfg.view === 'stack';
  const items = [];
  for (const c of grid.children) {
    if (!c._shot) continue;
    if (deck() && !c._live) continue;                           // карусель и стопка — все видимые карточки
    const r = c._shot.getBoundingClientRect();                  // с учётом масштаба и сдвига карточки
    if (!deck() && (r.top < pr.top - 1 || r.bottom > pr.bottom + 1)) continue; // прокручено за край панели
    if (car && (r.left < 0 || r.right > window.innerWidth)) continue; // за краем экрана (при перетаскивании) — Windows нарисовала бы её на соседнем мониторе
    const m = 4 * (r.width / (c._shot.offsetWidth || r.width));
    const it = { hwnd: c._w.hwnd, l: (r.left + m) * k, t: (r.top + m) * k, r: (r.right - m) * k, b: (r.bottom - m) * k, o: deck() && !c._hover ? .35 + c._dim * .65 : 1 };
    // стопка: заднее окно видно только до верхнего края карточки перед ним — ниже миниатюру обрезаем
    if (stk) { const i = [...grid.children].indexOf(c), n = list.length, d = ((i - sel) % n + n) % n; if (d > 0) { const f = grid.children[(i - 1 + n) % n]; if (f) it.cb = f.getBoundingClientRect().top * k; } }
    items.push(it);
  }
  return items;
}
function sendThumbs(delay = 0, fade = true) {
  clearTimeout(thumbT);
  if ((cfg.view !== 'thumbs' && !deck()) || !open) return;
  thumbT = setTimeout(() => { if (open) bar.thumbsShow(thumbItems(), fade); }, delay);
}
// карусель едет — миниатюры Windows едут вместе с карточками: новые места каждый кадр, пока идёт анимация
let trackRaf = 0, trackUntil = 0;
function trackThumbs(ms) {
  trackUntil = performance.now() + ms;
  if (trackRaf) return;
  const step = () => {
    if (!open) { trackRaf = 0; return; }
    bar.thumbsShow(thumbItems(), true);
    trackRaf = performance.now() < trackUntil ? requestAnimationFrame(step) : 0;
  };
  trackRaf = requestAnimationFrame(step);
}

function reveal() {
  if (!open || shown) return;
  shown = true;
  document.body.classList.add('shown');
  placeSel(true);
  // карточки проявляются лёгкой волной — только прозрачностью, без сдвига: живые миниатюры стоят на своих местах сразу
  if (!deck()) [...grid.children].forEach((c, i) => c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: Math.min(i, 12) * 12, easing: 'ease-out', fill: 'backwards' }));
  sendThumbs(0);
  if (deck()) loadStills();
}

const onOpen = (m) => {
  cfg = m.cfg || {};
  list = m.list || [];
  open = true; shown = false; stills = {}; hoverCard = null;
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
bar.onAtCommit((ok) => { if (!open) return; if (ok) pick(); else cancel(); }); // уже выбрали мышью — отпущенный Alt ничего не делает

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
