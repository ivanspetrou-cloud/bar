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

function cardOf(w, i) {
  const ic = h('span', { class: 'at-ic' }), big = h('span', { class: 'at-ic' });
  const key = 'exe:' + w.exe;
  const put = (u) => { for (const x of [ic, big]) x.replaceChildren(u ? h('img', { src: u, alt: '' }) : h('span', { class: 'at-letter' }, (w.title || '?').charAt(0).toUpperCase())); };
  if (icons.has(key)) put(icons.get(key)); else bar.appIcon({ id: key, exe: w.exe, name: w.title }).then((u) => { icons.set(key, u || null); put(u); }).catch(() => put(null));
  const close = h('button', { class: 'at-x', title: 'Закрыть окно', 'aria-label': 'Закрыть окно', html: icon('X') });
  close.addEventListener('click', (e) => { e.stopPropagation(); closeWin(i); });
  const shot = cfg.view === 'thumbs' ? h('span', { class: 'at-shot' + (w.min ? ' min' : '') }, h('span', { class: 'at-shot-ic' }, big)) : null;
  const card = h('div', { class: 'at-card', role: 'option', title: w.title },
    shot,
    h('span', { class: 'at-head' }, ic, cfg.titles !== false && h('span', { class: 'at-t' }, w.title || w.exe)),
    close);
  card.addEventListener('mouseenter', () => setSel(list.indexOf(w), true));
  card.addEventListener('click', () => { setSel(list.indexOf(w)); pick(); });
  card.addEventListener('auxclick', (e) => { if (e.button === 1) closeWin(list.indexOf(w)); });
  card._w = w; card._shot = shot;
  return card;
}

function layout() {
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
  grid.replaceChildren(...list.map(cardOf));
  if (!list.length) grid.append(h('div', { class: 'at-empty' }, 'Открытых окон нет'));
  layout();
}

function placeSel(jump) {
  const c = grid.children[sel];
  [...grid.children].forEach((x, i) => x.classList.toggle('on', i === sel));
  if (!c || !c._w) { selEl.style.opacity = '0'; return; }
  const p = panel.getBoundingClientRect(), r = c.getBoundingClientRect();
  if (jump) selEl.style.transition = 'none';
  selEl.style.opacity = '1';
  selEl.style.transform = `translate(${r.left - p.left + panel.scrollLeft}px, ${r.top - p.top + panel.scrollTop}px)`;
  selEl.style.width = r.width + 'px'; selEl.style.height = r.height + 'px';
  if (jump) { void selEl.offsetWidth; selEl.style.transition = ''; }
}
function setSel(i, hover) {
  if (!list.length) return;
  sel = ((i % list.length) + list.length) % list.length;
  placeSel(false);
  if (!hover) { const c = grid.children[sel]; if (c && c.scrollIntoView) c.scrollIntoView({ block: 'nearest' }); }
}

function loadThumbs() {
  if (cfg.view !== 'thumbs') return;
  const ids = list.filter((w) => !w.min).map((w) => w.hwnd);
  if (!ids.length) return;
  const at = list;
  bar.atThumbs(ids).then((m) => {
    if (at !== list || !m) return;
    for (const c of grid.children) {
      const u = c._w && m[c._w.hwnd];
      if (!u || !c._shot) continue;
      const img = h('img', { src: u, alt: '' });
      img.addEventListener('load', () => img.classList.add('ok'));
      c._shot.append(img);
    }
  }).catch(() => {});
}

function reveal() {
  if (!open || shown) return;
  shown = true;
  document.body.classList.add('shown');
  placeSel(true);
  // карточки появляются лёгкой волной
  [...grid.children].forEach((c, i) => c.animate([{ opacity: 0, transform: 'translateY(6px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: Math.min(i, 12) * 14, easing: 'cubic-bezier(.3,1.2,.5,1)', fill: 'backwards' }));
  loadThumbs();
}

const onOpen = (m) => {
  cfg = m.cfg || {};
  list = m.list || [];
  open = true; shown = false;
  document.body.classList.remove('shown', 'leave');
  render();
  // первое окно — то, что впереди; Alt+Tab ведёт к следующему, Alt+Shift+Tab — к последнему
  const fgFirst = list.length && list[0].active;
  sel = m.dir < 0 ? list.length - 1 : (fgFirst && list.length > 1 ? 1 : 0);
  placeSel(true);
  clearTimeout(showT);
  showT = setTimeout(reveal, 120); // быстрый Alt+Tab — без панели
};
bar.onAtOpen(onOpen);
const onMove = (d) => {
  if (!open) return;
  if (!shown) reveal();
  if (d === 'up') setSel(sel - cols); else if (d === 'down') setSel(sel + cols); else setSel(sel + d);
};
bar.onAtMove(onMove);
// для проверки без клавиатуры (отладка тестовой сборки)
window.__at = { open: onOpen, move: onMove, state: () => ({ open, shown, sel, cols, n: list.length }) };
bar.onAtCommit((ok) => { if (ok) pick(); else cancel(); });

function finish(hwnd) {
  open = false; clearTimeout(showT);
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
  const done = () => { list.splice(list.indexOf(w), 1); if (sel >= list.length) sel = Math.max(0, list.length - 1); render(); placeSel(true); if (!list.length) cancel(); };
  if (c) c.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.85)' }], { duration: 180, easing: 'ease-in' }).onfinish = done; else done();
}
// клик мимо панели — отмена
dim.addEventListener('click', cancel);
document.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('resize', () => { if (open) { layout(); placeSel(true); } });

// страница готова — только теперь Bar начинает перехватывать Alt+Tab
bar.atReady();
