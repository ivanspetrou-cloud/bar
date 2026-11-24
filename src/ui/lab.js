// Bar — дополнительные функции поверх app.js (общая область видимости скриптов): всплывашка громкости,
// события устройств, жесты, живой эквалайзер, календарь, зеркало, команды поиска, зоны перетаскивания.
// Всё локально: сеть не используется. Камера — только на экране «Зеркало».
'use strict';

Object.assign(LUCIDE, {
  calendar: 'CalendarDays', bell: 'Bell', mirror: 'ScanFace', ringlight: 'Lightbulb', flip: 'FlipHorizontal2',
  swipe: 'MoveHorizontal', wave: 'AudioLines', arrows: 'ArrowRightLeft',
});

// ============ 1. Всплывашка громкости и микрофона (OSD) ============
// Источник событий — агент 'watch' в sensors.js: он ждёт изменения звука внутри своего процесса.
const Osd = { on: store.get('osd', true), t: 0, prev: null };
function osdShow(kind) {
  if (!Osd.on || state === 'open' || Game.on || !S.audio) return;
  const a = S.audio;
  if (kind === 'mic') {
    setAct('osd', { solo: true, html: () => `<span class="osd mic${a.micMuted ? ' off' : ''}">${icon(a.micMuted ? 'micoff' : 'mic')}<span>${a.micMuted ? 'Микрофон выключен' : 'Микрофон включён'}</span></span>` });
  } else {
    const off = a.muted || a.volume === 0;
    const ic = off ? 'mute' : a.volume < 40 ? 'voldown' : 'volup';
    setAct('osd', { solo: true, html: () => `<span class="osd${off ? ' off' : ''}">${icon(ic)}<span class="osd-track"><i></i></span><b class="osd-v"></b></span>` });
    osdFill(off ? 0 : a.volume, off);
  }
  clearTimeout(Osd.t);
  Osd.t = setTimeout(() => { setAct('osd', null); Osd.prev = null; }, 1700);
}
// полоска живёт между перерисовками: новый элемент стартует с прошлого значения и плавно доезжает до нового
function osdFill(v, off) {
  for (const i of document.querySelectorAll('.osd-track i')) {
    if (!i._init) { i._init = true; i.style.transition = 'none'; i.style.width = (Osd.prev ?? v) + '%'; void i.offsetWidth; i.style.transition = ''; }
    i.style.width = v + '%';
  }
  for (const b of document.querySelectorAll('.osd-v')) b.textContent = off ? 'Без звука' : v + '%';
  Osd.prev = v;
}
openHooks.add((open) => { if (open) { setAct('osd', null); Osd.prev = null; } }); // в открытой панели громкость и так видна
function setOsd(on) { Osd.on = !!on; store.set('osd', Osd.on); pushNeed(); }

// ============ 2. События устройств: подключение, зарядка, низкий заряд ============
const DevEv = { prev: null, t: 0 };
function devToast(d, label, kind = '') {
  const short = d.name.length > 22 ? d.name.slice(0, 21) + '…' : d.name;
  const lvl = d.level >= 0 ? d.level : null;
  setAct('dev', { html: () => `<span class="devt ${kind}">${icon(devIcon(d.name, d.kind))}<span class="devt-n">${esc(short)}</span><span class="sub">${esc(label)}</span>${lvl !== null && kind !== 'gone' ? `${ringSvg(lvl / 100)}<b>${lvl}%</b>` : ''}</span>` });
  oledArmDim();
  clearTimeout(DevEv.t);
  DevEv.t = setTimeout(() => setAct('dev', null), kind === 'low' ? 6000 : 4000);
}
function devEvents() {
  if (!S.btLoaded) return;
  const list = devList();
  if (DevEv.prev) {
    for (const d of list) {
      const p = DevEv.prev.get(d.name);
      if (!p) continue; // устройство из другого источника, впервые пришедшего сейчас, — не событие
      if (d.connected && !d.stale && !p.connected) devToast(d, 'подключено');
      else if (!d.connected && p.connected) devToast(d, 'отключено', 'gone');
      else if (d.connected && d.charging && !p.charging) devToast(d, 'заряжается', 'chg');
      else if (d.connected && !d.charging && d.level >= 0 && d.level <= 15 && p.level > 15) devToast(d, 'пора зарядить', 'low');
    }
  }
  const next = DevEv.prev || new Map();
  for (const d of list) next.set(d.name, { connected: d.connected, charging: d.charging, level: d.level });
  DevEv.prev = next;
}
liveHooks.add((p) => { if ('bt' in p || 'hid' in p) devEvents(); });

// ============ 3. Свайп по нотчу и карточке трека — следующий / предыдущий ============
const Swipe = { acc: 0, t: 0, lock: 0 };
async function trackStep(dir) {
  const k = dir > 0 ? 'next' : 'prev';
  const ok = await bar.mediaCtl(k);
  if (!ok) bar.media(k);
}
function swipeAnim(el, dir) {
  if (!el) return;
  el.animate([
    { transform: 'translateX(0)', opacity: 1 },
    { transform: `translateX(${-dir * 26}px)`, opacity: 0, offset: 0.45 },
    { transform: `translateX(${dir * 26}px)`, opacity: 0, offset: 0.55 },
    { transform: 'translateX(0)', opacity: 1 },
  ], { duration: 520, easing: 'cubic-bezier(.3,.7,.2,1)' });
}
function onSwipe(e, target) {
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || !(S.media && S.media.title)) return false;
  e.preventDefault();
  const now = performance.now();
  if (now < Swipe.lock) return true;
  if (now - Swipe.t > 300) Swipe.acc = 0;
  Swipe.t = now; Swipe.acc += e.deltaX;
  if (Math.abs(Swipe.acc) >= 70) {
    const dir = Swipe.acc > 0 ? 1 : -1;
    Swipe.acc = 0; Swipe.lock = now + 700;
    swipeAnim(target(), dir);
    trackStep(dir);
  }
  return true;
}
island.addEventListener('wheel', (e) => {
  if (state === 'open') { if (e.target.closest('.card.np')) onSwipe(e, () => e.target.closest('.card.np').querySelector('.np-meta')); return; }
  onSwipe(e, () => barL);
}, { passive: false });

// ============ 4. Живой эквалайзер: столбики под настоящий звук ============
// Windows сама считает пиковый уровень звука на выходе (то, что слышно в колонках) — маленький процесс meter.ps1
// передаёт его ~20 раз в секунду. Три столбика — три «характера» одного уровня: быстрый, средний и плавный.
// Поток идёт, только пока что-то играет и столбики видны; через 30 с паузы — останавливается.
const LiveEq = { on: store.get('liveEq', true), st: 'off', lvl: [0, 0, 0], idleT: 0, q: [], iv: 0, last: 0 };
const liveEqActive = () => LiveEq.st === 'on' && performance.now() - LiveEq.last < 1500;
function liveEqStart() {
  if (LiveEq.st === 'on') return;
  LiveEq.st = 'on'; bar.meter(true); island.classList.add('live-eq');
  LiveEq.iv = setInterval(liveEqTick, 45);
}
function liveEqStop() {
  if (LiveEq.st !== 'on') return;
  LiveEq.st = 'off'; bar.meter(false); clearInterval(LiveEq.iv); LiveEq.q = []; island.classList.remove('live-eq');
}
bar.onMeter((vals) => { LiveEq.q.push(...vals); if (LiveEq.q.length > 6) LiveEq.q.splice(0, LiveEq.q.length - 6); LiveEq.last = performance.now(); });
function liveEqTick() {
  const bars = document.querySelectorAll('span.eq');
  if (!bars.length || document.hidden || !LiveEq.q.length) return;
  // автоусиление: уровень делится на недавний максимум (он медленно спадает), поэтому столбики одинаково
  // живые и на полной громкости, и когда музыку в плеере сделали тише; настоящая тишина остаётся тишиной
  const r = LiveEq.q.shift();
  LiveEq.peak = Math.max(r, (LiveEq.peak || 0) * 0.99, 0.004);
  const p = r < 0.002 ? 0 : Math.min(1, Math.pow(r / LiveEq.peak, 0.75) * 0.95);
  const L = LiveEq.lvl;
  const step = (i, up, down) => { L[i] = p > L[i] ? L[i] + (p - L[i]) * up : L[i] + (p - L[i]) * down; };
  step(0, 0.9, 0.35); step(1, 0.55, 0.22); step(2, 0.3, 0.12);
  const jit = [1, 0.82 + 0.18 * Math.sin(performance.now() / 170), 0.9 + 0.1 * Math.cos(performance.now() / 230)];
  const v = [L[1] * jit[1], L[0], L[2] * jit[2]]; // самый быстрый — в центре
  for (const el of bars) { const is = el.children; for (let i = 0; i < is.length; i++) is[i].style.transform = 'scaleY(' + Math.max(0.18, Math.min(1, v[i % 3])).toFixed(2) + ')'; }
}
function liveEqSync() {
  const want = LiveEq.on && !Game.on && S.media && S.media.playing && document.querySelector('span.eq');
  if (want) { clearTimeout(LiveEq.idleT); LiveEq.idleT = 0; liveEqStart(); }
  else if (LiveEq.st === 'on' && !LiveEq.idleT) LiveEq.idleT = setTimeout(() => { LiveEq.idleT = 0; liveEqStop(); }, 30000); // короткие паузы — без перезапуска процесса
}
setInterval(liveEqSync, 1500);
function setLiveEq(on) { LiveEq.on = !!on; store.set('liveEq', LiveEq.on); if (!on) liveEqStop(); else liveEqSync(); }

// ============ 5. Цвет обложки: свечение под нотчем и фон карточки трека ============
const Tint = { src: '', c: null };
function tintSync() {
  const m = S.media;
  const src = m && m.title && artUrl ? artUrl : '';
  if (src !== Tint.src) {
    Tint.src = src;
    if (!src) { Tint.c = null; tintApply(); return; }
    coverTint(src, (c) => { if (Tint.src === src) { Tint.c = c; tintApply(); } });
  } else tintApply();
}
function tintApply() {
  const on = !!(Tint.c && S.media && S.media.playing && store.get('tint', true));
  island.classList.toggle('tinted', on);
  if (Tint.c) island.style.setProperty('--tint', Tint.c);
}
liveHooks.add((p) => { if ('media' in p) tintSync(); });

// ============ 6. Календарь и напоминания ============
const Rem = {
  list: store.get('reminders', []),
  save() { store.set('reminders', this.list); },
  add(at, text) {
    const r = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at, text: (text || '').trim() || 'Напоминание', fired: at <= Date.now() };
    this.list.push(r); this.list.sort((a, b) => a.at - b.at); this.save(); this.sync();
    return r;
  },
  del(id) { this.list = this.list.filter((r) => r.id !== id); this.save(); this.sync(); },
  next() { return this.list.find((r) => !r.fired); },
  onDay(d) { const k = dayKey(d); return this.list.filter((r) => dayKey(new Date(r.at)) === k); },
  check() {
    const now = Date.now();
    let fired = false;
    for (const r of this.list) {
      if (r.fired || r.at > now) continue;
      r.fired = true; fired = true;
      if (now - r.at > 10 * 60e3) continue; // пропущено, пока компьютер спал, — без шума
      chime();
      island.classList.remove('alert'); void island.offsetWidth; island.classList.add('alert');
      setTimeout(() => island.classList.remove('alert'), 4200);
      flash('🔔 ' + r.text, 9000);
      try { new Notification('Bar · Напоминание', { body: r.text, silent: true }); } catch {}
    }
    if (fired) this.save();
    this.sync();
  },
  // за 15 минут до события — обратный отсчёт в свёрнутом нотче
  sync() {
    const r = this.next();
    const left = r ? r.at - Date.now() : Infinity;
    if (r && left <= 15 * 60e3) {
      setAct('remind', { html: () => { const m = Math.max(1, Math.ceil((r.at - Date.now()) / 60e3)); return `<span class="rem-act">${icon('bell')}<span class="trk">${esc(r.text)}</span><span class="sub">через ${m} мин</span></span>`; } });
    } else setAct('remind', null);
  },
};
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
setInterval(() => Rem.check(), 15000);
setTimeout(() => Rem.check(), 1500);

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const hhmm = (t) => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
tool({
  id: 'calendar', name: 'Календарь', icon: 'calendar',
  view(el, payload) {
    const today = new Date();
    let sel = payload && payload.day ? new Date(payload.day) : new Date(today.getFullYear(), today.getMonth(), today.getDate());
    let view = new Date(sel.getFullYear(), sel.getMonth(), 1);
    const grid = h('div', { class: 'cal-grid' });
    const head = h('div', { class: 'cal-head' });
    const right = h('div', { class: 'col cal-day' });
    const timeIn = h('input', { class: 'field', type: 'time', value: (() => { const d = new Date(Date.now() + 60 * 60e3); return pad(d.getHours()) + ':00'; })(), style: { width: '96px' } });
    const textIn = h('input', { class: 'field grow', placeholder: 'Что напомнить', maxlength: 120 });
    const add = () => {
      const [hh, mm] = timeIn.value.split(':').map(Number);
      if (!Number.isFinite(hh)) return;
      const at = new Date(sel.getFullYear(), sel.getMonth(), sel.getDate(), hh, mm || 0).getTime();
      Rem.add(at, textIn.value);
      textIn.value = '';
      flash(at > Date.now() ? `Напомню ${relDay(at)} в ${hhmm(at)}` : 'Это время уже прошло — сохранено без сигнала', 2400);
      draw(true);
    };
    textIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    const drawGrid = (dir) => {
      head.replaceChildren(
        h('button', { class: 'ib', title: 'Предыдущий месяц', onclick: () => { view = new Date(view.getFullYear(), view.getMonth() - 1, 1); drawGrid(-1); } }, I('back')),
        h('b', { class: 'cal-title' }, `${cap1(MONTHS[view.getMonth()])} ${view.getFullYear()}`),
        h('button', { class: 'ib', title: 'Следующий месяц', onclick: () => { view = new Date(view.getFullYear(), view.getMonth() + 1, 1); drawGrid(1); } }, I('fwd')),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: () => { sel = new Date(today.getFullYear(), today.getMonth(), today.getDate()); view = new Date(sel.getFullYear(), sel.getMonth(), 1); draw(); } }, 'Сегодня'));
      const first = (view.getDay() + 6) % 7; // понедельник — первый
      const start = new Date(view.getFullYear(), view.getMonth(), 1 - first);
      const cells = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((d, i) => h('span', { class: 'cal-wd' + (i > 4 ? ' we' : '') }, d));
      const busy = new Set(Rem.list.map((r) => dayKey(new Date(r.at))));
      for (let i = 0; i < 42; i++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const cls = ['cal-d'];
        if (d.getMonth() !== view.getMonth()) cls.push('out');
        if (dayKey(d) === dayKey(today)) cls.push('today');
        if (dayKey(d) === dayKey(sel)) cls.push('sel');
        if ((i % 7) > 4) cls.push('we');
        cells.push(h('button', { class: cls.join(' '), onclick: () => { sel = d; if (d.getMonth() !== view.getMonth()) { const dir2 = d > view ? 1 : -1; view = new Date(d.getFullYear(), d.getMonth(), 1); drawGrid(dir2); } else drawGrid(0); drawDay(); } },
          h('span', {}, String(d.getDate())), busy.has(dayKey(d)) && h('i', { class: 'cal-dot' })));
      }
      grid.replaceChildren(...cells);
      if (dir) grid.animate([{ opacity: 0, transform: `translateX(${dir * 18}px)` }, { opacity: 1, transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' });
    };
    const drawDay = (fresh) => {
      const items = Rem.onDay(sel);
      const wd = sel.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
      const list = h('div', { class: 'list cal-list' });
      if (!items.length) list.append(h('div', { class: 'muted small cal-empty' }, 'Нет напоминаний. Добавьте ниже или в поиске: «напомни в 18:30 позвонить».'));
      items.forEach((r, i) => {
        const row = h('div', { class: 'item cal-item' + (r.fired ? ' past' : ''), style: { cursor: 'default' } },
          h('b', { class: 'cal-time' }, hhmm(r.at)), h('span', { class: 'txt' }, r.text),
          h('button', { class: 'ib', title: 'Удалить', onclick: () => { row.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateX(12px)' }], { duration: 180 }).onfinish = () => { Rem.del(r.id); draw(); }; } }, I('trash')));
        if (fresh && i === items.length - 1) row.style.animation = 'pop .45s var(--spring) both';
        list.append(row);
      });
      right.replaceChildren(
        h('b', { class: 'cal-wdlong' }, cap1(wd)),
        list,
        h('div', { class: 'row cal-add' }, timeIn, textIn, h('button', { class: 'btn pri', onclick: add }, I('bell'), 'Напомнить')));
    };
    const draw = (fresh) => { drawGrid(0); drawDay(fresh); };
    el.append(h('div', { class: 'split cal', style: { gridTemplateColumns: '300px 1fr' } }, h('div', { class: 'col' }, head, grid), right));
    draw();
    const upd = () => { if (!document.activeElement || document.activeElement.tagName !== 'INPUT') drawDay(); };
    const unhook = () => tickers.delete(upd);
    tickers.add(upd);
    setTimeout(() => textIn.focus(), 300);
    return unhook;
  },
});
const relDay = (t) => {
  const d = new Date(t), n = new Date();
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 864e5);
  return diff === 0 ? 'сегодня' : diff === 1 ? 'завтра' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
};
// клик по дате в раскрытой шапке — календарь
barEl.addEventListener('click', (e) => { if (state === 'open' && !current && e.target.closest('.l .sub')) openTool('calendar'); });

// ============ 7. Зеркало (камера) ============
tool({
  id: 'mirror', name: 'Зеркало', icon: 'mirror',
  view(el) {
    let stream = null, flip = true, light = store.get('mirrorLight', false), alive = true;
    const video = h('video', { class: 'mirror-v', autoplay: true, muted: true, playsinline: true });
    const ph = h('div', { class: 'mirror-ph muted' }, 'Включаю камеру…');
    const frame = h('div', { class: 'mirror' + (light ? ' light' : '') }, video, ph);
    const sel = h('select', { class: 'field mic-sel', title: 'Камера' });
    const start = async (id) => {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: id ? { deviceId: { exact: id }, width: 1280, height: 720 } : { width: 1280, height: 720 }, audio: false });
        if (!alive) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.srcObject = stream; ph.hidden = true;
        frame.animate([{ opacity: 0, transform: 'scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.3,1.3,.5,1)' });
        const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
        const cur = stream.getVideoTracks()[0].getSettings().deviceId;
        sel.replaceChildren(...cams.map((c, i) => h('option', { value: c.deviceId, selected: c.deviceId === cur }, (c.label || `Камера ${i + 1}`).replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, ''))));
        sel.hidden = cams.length < 2;
      } catch (e) { ph.hidden = false; ph.textContent = /NotFound|DevicesNotFound/.test(e && e.name) ? 'Камера не найдена' : 'Камера недоступна: проверьте, не занята ли она другой программой и разрешена ли в параметрах Windows'; }
    };
    sel.addEventListener('change', () => { store.set('camId', sel.value); start(sel.value); });
    const snap = () => {
      if (!stream) return;
      const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
      const g = c.getContext('2d'); if (flip) { g.translate(c.width, 0); g.scale(-1, 1); } g.drawImage(video, 0, 0);
      bar.clipImage(c.toDataURL('image/png'));
      frame.animate([{ filter: 'brightness(2.2)' }, { filter: 'none' }], { duration: 420, easing: 'ease-out' });
      flash('Снимок в буфере обмена');
    };
    const flipBtn = h('button', { class: 'btn on', onclick: () => { flip = !flip; video.classList.toggle('noflip', !flip); flipBtn.classList.toggle('on', flip); } }, I('flip'), 'Отразить');
    const lightBtn = h('button', { class: 'btn' + (light ? ' on' : ''), onclick: () => { light = !light; store.set('mirrorLight', light); frame.classList.toggle('light', light); lightBtn.classList.toggle('on', light); } }, I('ringlight'), 'Подсветка');
    el.append(frame, h('div', { class: 'row' }, h('button', { class: 'btn pri', onclick: snap }, I('shot'), 'Снимок'), flipBtn, lightBtn, h('span', { class: 'grow' }), sel));
    start(store.get('camId', ''));
    return () => { alive = false; if (stream) stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; };
  },
});

// ============ 8. Плитки: пары «таймер/секундомер» и «сканер/создание QR» ============
// Одна плитка на пару, переключатель сверху экрана; освободившиеся места — календарю и зеркалу.
function pairTools(ids, labels) {
  for (const id of ids) {
    const t = TOOLS_BY_ID[id], view = t.view;
    t.view = (el, res) => {
      const seg = h('div', { class: 'seg pair-seg' }, ids.map((x, i) => h('button', { class: x === id ? 'on' : '', onclick: () => { if (x !== id) openTool(x); } }, labels[i])));
      el.append(seg);
      const inner = h('div', { class: 'pair-in' });
      el.append(inner);
      return view(inner, res);
    };
  }
  TOOLS_BY_ID[ids[1]].hidden = true;
}
pairTools(['timer', 'stopwatch'], ['Таймер', 'Секундомер']);
pairTools(['qrscan', 'qrmake'], ['Сканировать', 'Создать']);
TOOLS_BY_ID.qrscan.short = 'QR-код';
TOOLS_BY_ID.timer.short = 'Время';
// порядок: календарь — после таймера, зеркало — после скриншота
(() => {
  const move = (id, after) => { const i = TOOLS.findIndex((t) => t.id === id); const [t] = TOOLS.splice(i, 1); TOOLS.splice(TOOLS.findIndex((x) => x.id === after) + 1, 0, t); };
  move('calendar', 'timer');
  move('mirror', 'shot');
})();
Object.assign(SRCH_KW, { calendar: 'календарь напоминание напомни дата calendar reminder', mirror: 'зеркало камера вебкамера mirror camera' });

// ============ 9. Команды в поиске: таймер, напоминание, перевод единиц ============
const UNITS = (() => {
  const u = {};
  const add = (dim, f, names) => names.forEach((n) => { u[n] = { dim, f }; });
  add('len', 0.001, ['mm', 'мм']); add('len', 0.01, ['cm', 'см']); add('len', 1, ['m', 'м', 'метр', 'метра', 'метров', 'метрах']);
  add('len', 1000, ['km', 'км', 'километр', 'километра', 'километров', 'километрах']);
  add('len', 0.0254, ['in', 'inch', 'дюйм', 'дюйма', 'дюймов', 'дюймах']); add('len', 0.3048, ['ft', 'foot', 'feet', 'фут', 'фута', 'футов', 'футах']);
  add('len', 0.9144, ['yd', 'ярд', 'ярда', 'ярдов']); add('len', 1609.344, ['mi', 'mile', 'miles', 'миля', 'мили', 'миль', 'милях']);
  add('mass', 0.001, ['g', 'г', 'гр', 'грамм', 'грамма', 'граммов', 'граммах']); add('mass', 1, ['kg', 'кг', 'килограмм', 'килограммов', 'килограммах']);
  add('mass', 1000, ['t', 'т', 'тонна', 'тонны', 'тонн', 'тоннах']); add('mass', 0.45359237, ['lb', 'lbs', 'фунт', 'фунта', 'фунтов', 'фунтах']);
  add('mass', 0.028349523, ['oz', 'унция', 'унции', 'унций', 'унциях']);
  add('data', 1, ['b', 'байт', 'байта', 'байтов']); add('data', 1024, ['kb', 'кб']); add('data', 1024 ** 2, ['mb', 'мб']);
  add('data', 1024 ** 3, ['gb', 'гб']); add('data', 1024 ** 4, ['tb', 'тб']);
  add('vol', 1, ['l', 'л', 'литр', 'литра', 'литров', 'литрах']); add('vol', 0.001, ['ml', 'мл']); add('vol', 3.785411784, ['gal', 'галлон', 'галлона', 'галлонов', 'галлонах']);
  add('speed', 1, ['kmh', 'км/ч', 'kph']); add('speed', 1.609344, ['mph', 'миль/ч']); add('speed', 3.6, ['м/с', 'm/s']);
  add('temp', 'c', ['c', '°c', 'с', '°с', 'цельсий', 'цельсия', 'цельсиях']); add('temp', 'f', ['f', '°f', 'фаренгейт', 'фаренгейта', 'фаренгейтах']); add('temp', 'k', ['k', 'кельвин', 'кельвина', 'кельвинах']);
  return u;
})();
const UNIT_NAME = { mm: 'мм', cm: 'см', m: 'м', km: 'км', in: 'дюйм.', ft: 'фут.', yd: 'ярд.', mi: 'миль', g: 'г', kg: 'кг', t: 'т', lb: 'фунт.', oz: 'унц.', b: 'Б', kb: 'КБ', mb: 'МБ', gb: 'ГБ', tb: 'ТБ', l: 'л', ml: 'мл', gal: 'галл.', kmh: 'км/ч', mph: 'миль/ч', 'm/s': 'м/с', c: '°C', f: '°F', k: 'K' };
function unitKey(name) { const n = name.toLowerCase(); if (UNITS[n]) return n; return null; }
function unitCanon(n) { // каноническое латинское имя для подписи результата
  const u = UNITS[n]; if (!u) return n;
  return Object.keys(UNIT_NAME).find((k) => UNITS[k] && UNITS[k].dim === u.dim && UNITS[k].f === u.f) || n;
}
function convert(q) {
  const m = q.match(/^(-?\d+(?:[.,]\d+)?)\s*([a-zа-яё°/]+)\s+(?:в|во|to|in|=)\s+([a-zа-яё°/]+)$/i);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  const a = unitKey(m[2]), b = unitKey(m[3]);
  if (!a || !b || UNITS[a].dim !== UNITS[b].dim) return null;
  let r;
  if (UNITS[a].dim === 'temp') {
    const toC = { c: (x) => x, f: (x) => (x - 32) * 5 / 9, k: (x) => x - 273.15 }[UNITS[a].f](v);
    r = { c: toC, f: toC * 9 / 5 + 32, k: toC + 273.15 }[UNITS[b].f];
  } else r = v * UNITS[a].f / UNITS[b].f;
  return { v: r, unit: UNIT_NAME[unitCanon(b)] || m[3], from: `${m[1]} ${UNIT_NAME[unitCanon(a)] || m[2]}` };
}
const DUR_UNIT = (u) => /^(ч|час|часа|часов|h)$/i.test(u) ? 3600 : /^(с|сек|секунд|секунды|секунду|s)$/i.test(u) ? 1 : 60;
function labCommands(raw) {
  const q = raw.trim();
  const rows = [];
  // единица — отдельным словом: «таймер 10 чай» — это 10 минут с подписью «чай», а не 10 часов
  const U = String.raw`(часов|часа|час|ч|минуты|минут|мин|м|секунд|сек|с|h|m|s)(?=[\s.]|$)`;
  let m = q.match(new RegExp(String.raw`^(?:таймер|timer)\s+(\d+(?:[.,]\d+)?)\s*(?:` + U + String.raw`)?\.?\s*(.*)$`, 'i'))
    || q.match(new RegExp(String.raw`^(\d+(?:[.,]\d+)?)\s*` + U + String.raw`\.?(?:\s+(.*))?$`, 'i'));
  if (m) {
    const sec = Math.round(parseFloat(m[1].replace(',', '.')) * DUR_UNIT(m[2] || 'мин'));
    const label = (m[3] || '').trim();
    if (sec > 0 && sec <= 24 * 3600) rows.push({ key: 'cmd:timer', title: `Таймер на ${fmtDur(sec * 1000)}${label ? ` · ${label}` : ''}`, sub: 'Enter — запустить, отсчёт будет виден в нотче', ic: 'timer', big: true,
      run: () => { Timer.start(sec, label); flash(`Таймер ${fmtDur(sec * 1000)}`); } });
  }
  m = q.match(/^напомни(?:ть)?\s+(?:мне\s+)?(завтра\s+)?(?:в\s+(\d{1,2})(?:[:.](\d{2}))?|через\s+(\d+(?:[.,]\d+)?)\s*(мин|минут|минуты|м|ч|час|часа|часов|сек|секунд)?)\s*(.*)$/i);
  if (m) {
    let at;
    if (m[4]) at = Date.now() + parseFloat(m[4].replace(',', '.')) * DUR_UNIT(m[5] || 'мин') * 1000;
    else {
      const d = new Date(); d.setHours(+m[2], +(m[3] || 0), 0, 0);
      if (m[1]) d.setDate(d.getDate() + 1); else if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
      at = d.getTime();
    }
    const text = (m[6] || '').trim() || 'Напоминание';
    if (+m[2] <= 23 || m[4]) rows.push({ key: 'cmd:remind', title: `Напомнить ${relDay(at)} в ${hhmm(at)} · ${text}`, sub: 'Enter — добавить в календарь', ic: 'bell', big: true,
      run: () => { Rem.add(at, text); flash(`Напомню ${relDay(at)} в ${hhmm(at)}`, 2400); } });
  }
  const c = convert(q);
  if (c) {
    const txt = c.v.toLocaleString('ru-RU', { maximumFractionDigits: Math.abs(c.v) < 1 ? 4 : 2 });
    rows.push({ key: 'cmd:conv', title: `${c.from} = ${txt} ${c.unit}`, sub: 'Enter — скопировать число', ic: 'arrows', big: true, run: () => copy(String(+c.v.toFixed(6)), `${txt} скопировано`) });
  }
  return rows;
}
const srchComputeBase = srchCompute;
// eslint-disable-next-line no-func-assign
srchCompute = async function () {
  const groups = await srchComputeBase();
  const rows = labCommands(Srch.q);
  if (rows.length) groups.unshift({ name: 'Команда', rows });
  return groups;
};
const srchRunBase = srchRun;
// eslint-disable-next-line no-func-assign
srchRun = function (r, alt) {
  if (r && r.key === 'cmd:conv') { r.run(); return; } // число скопировано — панель остаётся открытой
  return srchRunBase(r, alt);
};

// ============ 11. Перетаскивание файлов: «На полку» или «На телефон» ============
// Как лоток и AirDrop у NotchNook: две зоны прямо в нотче; файлы на телефон уходят через полку и страницу Bar по Wi‑Fi.
const dropEl = h('div', { class: 'dropzones', hidden: true },
  h('div', { class: 'dz', 'data-z': 'shelf' }, h('span', { class: 'dz-ic', html: icon('shelf') }), h('b', {}, 'На полку'), h('span', { class: 'muted small' }, 'держать под рукой')),
  h('div', { class: 'dz', 'data-z': 'phone' }, h('span', { class: 'dz-ic', html: icon('phone') }), h('b', {}, 'На телефон'), h('span', { class: 'muted small' }, 'по Wi‑Fi, через QR-код')));
$('.content').append(dropEl);
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
let dropHot = null;
function dropShow() {
  if (!dropEl.hidden) return;
  dropEl.hidden = false;
  dropEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
  dropEl.querySelectorAll('.dz').forEach((z, i) => z.animate([{ opacity: 0, transform: 'translateY(-10px) scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 60 + i * 60, easing: 'cubic-bezier(.3,1.32,.5,1)', fill: 'backwards' }));
}
function dropHide() { dropEl.hidden = true; dropHot = null; dropEl.querySelectorAll('.dz').forEach((z) => z.classList.remove('hot')); }
async function sendToPhone() {
  openTool('phone');
  if (!Bridge.url) {
    try { Object.assign(Bridge, await bar.bridgeStart(Shelf.items.map((i) => i.path))); setAct('bridge', { html: () => `<span class="dot"></span><span>Телефон</span>` }); }
    catch { flash('Не удалось открыть порт', 3000); return; }
    if (current === 'phone') openTool('phone');
  }
  flash('Откройте страницу на телефоне — файлы уже там', 3500);
}
island.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.stopImmediatePropagation();
  setInteractive(true); expand(); dropShow();
}, true);
island.addEventListener('dragover', (e) => {
  if (dropEl.hidden) return;
  e.preventDefault();
  const z = e.target.closest && e.target.closest('.dz');
  if (z !== dropHot) { dropEl.querySelectorAll('.dz').forEach((x) => x.classList.toggle('hot', x === z)); dropHot = z; }
}, true);
island.addEventListener('dragleave', (e) => { if (!dropEl.hidden && !(e.relatedTarget && island.contains(e.relatedTarget))) dropHide(); }, true);
island.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  const zone = dropHot ? dropHot.dataset.z : 'shelf';
  dropHide();
  const files = [...(e.dataTransfer.files || [])].map((f) => bar.filePath(f)).filter(Boolean);
  if (!files.length) return;
  Shelf.add(files);
  if (zone === 'phone') sendToPhone(); else openTool('shelf');
}, true);

// ============ 12. Плавная смена содержимого свёрнутого нотча ============
// Когда в таблетке меняется «главное» (трек → громкость → напоминание…), старое уходит вверх, новое приходит снизу.
const renderBarBase = renderBar;
let barKind = null;
// eslint-disable-next-line no-func-assign
let headKind = null;
renderBar = function () {
  renderBarBase();
  if (state === 'open') {
    // в раскрытой шапке активность (таймер, напоминание…) появляется и меняется тоже плавно
    barKind = null;
    let hk2 = null;
    for (const id of ACT_ORDER) if (id !== 'media' && acts.has(id)) { hk2 = id; break; }
    const el = barR.querySelector('.act');
    if (el) { el.dataset.act = hk2 || ''; el.title = ACT_TOOL[hk2] ? 'Открыть' : ''; el.classList.toggle('link', !!ACT_TOOL[hk2]); }
    if (hk2 !== headKind && el && headKind !== undefined) el.animate([{ opacity: 0, transform: 'translateY(-6px) scale(.9)', filter: 'blur(2px)' }, { opacity: 1, transform: 'none', filter: 'none' }], { duration: 380, easing: 'cubic-bezier(.3,1.32,.5,1)' });
    headKind = hk2;
    return;
  }
  headKind = undefined; // при раскрытии панели активность уже на месте — без повторной анимации
  let kind = 'clock';
  for (const id of ACT_ORDER) if (acts.has(id)) { kind = id; break; }
  if (barKind !== null && kind !== barKind && !Game.on) {
    for (const el of [barL, barR]) el.animate([{ opacity: 0, transform: 'translateY(7px)', filter: 'blur(2px)' }, { opacity: 1, transform: 'none', filter: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  barKind = kind;
};

// клик по активности в шапке — к её инструменту: таймер, секундомер, напоминание, запись, телефон
const ACT_TOOL = { timer: 'timer', stopwatch: 'stopwatch', remind: 'calendar', rec: 'voice', bridge: 'phone' };
barEl.addEventListener('click', (e) => {
  const a = state === 'open' && e.target.closest('.act');
  const t = a && ACT_TOOL[a.dataset.act];
  if (t && current !== t) openTool(t);
});

// ============ 13. Громкость сигнала таймера и напоминаний ============
// Тот же сигнал из трёх нот, но громкость настраивается (Настройки → Дополнительно); 0 — без звука.
const chimeVol = () => store.get('chimeVol', 60);
// eslint-disable-next-line no-func-assign
chime = function () {
  const vol = chimeVol() / 100;
  if (vol <= 0) return;
  try {
    const ac = new AudioContext();
    const peak = 0.42 * vol * vol; // квадрат — ползунок звучит равномерно на слух
    [0, 0.18, 0.36].forEach((t, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = [880, 1108.7, 1318.5][i];
      g.gain.setValueAtTime(0.0001, ac.currentTime + t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), ac.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t + 0.6);
      o.connect(g).connect(ac.destination); o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.65);
    });
    setTimeout(() => ac.close(), 1500);
  } catch {}
};

// ============ 10. Настройки → Дополнительно ============
// Отдельный раздел в Настройках → «Основное»: переключатели новых функций.
const LAB_OPTS = [
  ['osd', 'Всплывашка громкости', 'нотч показывает громкость и микрофон, когда вы их меняете', () => Osd.on, setOsd],
  ['liveEq', 'Живой эквалайзер', 'столбики двигаются под настоящий звук', () => LiveEq.on, setLiveEq],
  ['tint', 'Цвет обложки', 'свечение под нотчем в цвет трека', () => store.get('tint', true), (v) => { store.set('tint', !!v); tintApply(); }],
];
function chimeRow() {
  const sl = makeSlider({ min: 0, max: 100, step: 5, value: chimeVol(), label: 'Громкость сигнала' });
  const val = h('b', { class: 'chime-v' }, chimeVol() ? chimeVol() + '%' : 'без звука');
  sl.addEventListener('input', () => { store.set('chimeVol', +sl.value); val.textContent = +sl.value ? sl.value + '%' : 'без звука'; });
  sl.addEventListener('change', () => chime()); // отпустили ползунок — слышно, как будет звучать
  return h('div', { class: 'sw chime-row' }, h('span', { title: 'Таймер и напоминания' }, 'Громкость сигнала'), sl, val,
    h('button', { class: 'ib', title: 'Прослушать', onclick: () => chime() }, I('volup')));
}
function labSettings(toggle) {
  const row = ([, name, desc, get, set]) => h('div', { class: 'sw' }, h('span', {}, name, h('span', { class: 'muted' }, ' · ' + desc)), toggle(get(), set));
  const tbBox = h('div', { class: 'col' });
  const seg = (opts, val, fn) => h('div', { class: 'seg' }, opts.map(([v, label]) => h('button', { class: v === val ? 'on' : '', onclick: (e) => { e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); fn(v); } }, label)));
  bar.taskbarGet().then((t) => {
    const set = (p) => bar.taskbarSet(p).then(draw);
    const rows = h('div', { class: 'col tb-rows' });
    function draw(c) {
      rows.hidden = !c.on;
      rows.replaceChildren(
        h('div', { class: 'sw' }, h('span', {}, 'Поведение'), seg([['hide', 'Прятаться'], ['always', 'Всегда на месте']], c.mode, (v) => set({ mode: v }))),
        c.mode === 'always' && h('div', { class: 'sw' }, h('span', {}, 'Резервировать место', h('span', { class: 'muted' }, ' · окна заканчиваются над таскбаром')), toggle(c.reserve, (v) => set({ reserve: v }))),
        h('div', { class: 'sw' }, h('span', {}, 'Одинаковый размер на всех мониторах', h('span', { class: 'muted' }, ' · по сантиметрам, как на основном')), toggle(c.same !== false, (v) => set({ same: v }))),
        // размер — отдельно для каждого монитора
        ...(c.displays || []).map((m) => h('div', { class: 'sw' },
          h('span', {}, `Размер на мониторе ${m.n}`, h('span', { class: 'muted' }, ` · ${m.w}×${m.h}${m.primary ? ', основной' : ''}`)),
          seg([['s', 'S'], ['m', 'M'], ['l', 'L']], m.size, (v) => set({ sizes: { ...(c.sizes || {}), [m.id]: v } })))),
        h('div', { class: 'sw' }, h('span', {}, 'Увеличение при наведении'), toggle(c.magnify, (v) => set({ magnify: v }))),
        h('button', { class: 'btn sm', style: { alignSelf: 'flex-start' }, onclick: () => openTool('tbset') }, I('dock'), 'Закреплённые, кнопки и ярлыки…'),
        h('div', { class: 'muted small tb-note' }, c.mode === 'hide'
          ? 'Подведите мышь к нижнему краю экрана — таскбар выедет. Панель Windows спрятана, пока он включён.'
          : c.reserve ? 'Развёрнутые окна заканчиваются над таскбаром. В полноэкранных видео и играх он прячется сам.'
          : 'Таскбар всегда виден поверх окон, окна идут до самого низа экрана. В полноэкранных видео и играх он прячется сам.'));
    }
    tbBox.replaceChildren(
      h('div', { class: 'sw' }, h('span', {}, h('b', {}, 'Таскбар Bar'), h('span', { class: 'muted' }, ' · вместо панели задач Windows')), toggle(t.on, (v) => set({ on: v }))),
      rows);
    draw(t);
  });
  return h('div', { class: 'split' },
    h('div', { class: 'col' }, ...LAB_OPTS.map(row), chimeRow()),
    tbBox);
}
// ============ 14. Настройки таскбара: закреплённые, кнопки, ярлыки ============
// Открывается правым кликом по пустому месту дока или из Настройки → Дополнительно.
Object.assign(LUCIDE, { dock: 'PanelBottom', up: 'ChevronUp', down: 'ChevronDown', grip2: 'GripVertical', recycle: 'Trash2', dl: 'Download', docs: 'FileText', pc: 'HardDrive', wset: 'Settings2', tmgr: 'Activity', fold: 'FolderPlus' });
const TB_PLACES = [['recycle', 'Корзина', 'recycle'], ['downloads', 'Загрузки', 'dl'], ['documents', 'Документы', 'docs'], ['pc', 'Этот компьютер', 'pc'], ['settings', 'Параметры Windows', 'wset'], ['taskmgr', 'Диспетчер задач', 'tmgr']];
const TB_TOOLS = ['timer', 'stopwatch', 'calendar', 'notes', 'calc', 'voice', 'clip', 'shelf', 'shot', 'color', 'ocr', 'qrscan', 'mirror', 'phone', 'system', 'text'];
tool({
  id: 'tbset', name: 'Таскбар', icon: 'dock', hidden: true,
  height: () => 520,
  view(el) {
    let c = null;
    const left = h('div', { class: 'col tbs-col' }), right = h('div', { class: 'col tbs-col tbs-right' });
    el.append(h('div', { class: 'split tbs' }, left, right));
    const set = async (patch) => { c = await bar.taskbarSet(patch); drawRight(); };

    // ---- слева: закреплённые ----
    const pins = () => store.get('dock', []) || [];
    const savePins = (list) => { store.set('dock', list); Apps.dock = list; refreshDock && refreshDock(true); };
    let picking = false, q = '';
    function drawLeft(fresh) {
      const list = pins();
      const rows = h('div', { class: 'list tbs-pins' });
      if (!list.length) rows.append(h('div', { class: 'muted small tbs-empty' }, 'Пока ничего не закреплено. Добавьте программы — они будут в доке всегда, даже закрытые.'));
      list.forEach((a, i) => {
        const img = h('img', { alt: '' });
        const row = h('div', { class: 'item tbs-pin', draggable: 'true' },
          h('span', { class: 'tbs-grip', html: icon('grip2') }), img, h('span', { class: 'txt' }, a.name),
          h('button', { class: 'ib', title: 'Выше', disabled: i === 0 ? '' : null, onclick: () => move(i, -1) }, I('up')),
          h('button', { class: 'ib', title: 'Ниже', disabled: i === list.length - 1 ? '' : null, onclick: () => move(i, 1) }, I('down')),
          h('button', { class: 'ib', title: 'Открепить', onclick: () => { row.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateX(14px)' }], { duration: 180 }).onfinish = () => { savePins(pins().filter((x) => x.id !== a.id)); drawLeft(); }; } }, I('x')));
        Apps.icon(a, img);
        // перетаскивание строк — порядок в доке
        row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-pin', String(i)); row.classList.add('drag'); });
        row.addEventListener('dragend', () => row.classList.remove('drag'));
        row.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('text/x-pin')) { e.preventDefault(); row.classList.add('over'); } });
        row.addEventListener('dragleave', () => row.classList.remove('over'));
        row.addEventListener('drop', (e) => { e.preventDefault(); row.classList.remove('over'); const from = +e.dataTransfer.getData('text/x-pin'); if (from !== i) { const l = pins(); const [x] = l.splice(from, 1); l.splice(i, 0, x); savePins(l); drawLeft(); } });
        if (fresh && i === list.length - 1) row.style.animation = 'pop .45s var(--spring) both';
        rows.append(row);
      });
      const head = h('div', { class: 'row tbs-head' }, h('b', {}, 'Закреплённые'), h('span', { class: 'muted small' }, `${list.length} из 14`), h('span', { class: 'grow' }),
        h('button', { class: 'btn sm' + (picking ? ' on' : ''), onclick: () => { picking = !picking; drawLeft(); } }, I(picking ? 'x' : 'plus'), picking ? 'Готово' : 'Добавить'));
      left.replaceChildren(head, picking ? picker() : rows);
    }
    function move(i, d) { const l = pins(); const [x] = l.splice(i, 1); l.splice(i + d, 0, x); savePins(l); drawLeft(); }
    // выбор программы из «Пуска» с поиском
    function picker() {
      const inp = h('input', { class: 'field', placeholder: 'Найти программу', value: q });
      const list = h('div', { class: 'list tbs-pick' });
      const fill = async () => {
        const all = await Apps.load();
        const have = new Set(pins().map((x) => x.id));
        const nq = sNorm(q.trim());
        const found = all.filter((a) => !have.has(a.id) && (!nq || sMatch(a.name, nq) > 0)).sort((x, y) => (nq ? sMatch(y.name, nq) - sMatch(x.name, nq) : 0) || x.name.localeCompare(y.name, 'ru')).slice(0, 60);
        list.replaceChildren(...found.map((a) => {
          const img = h('img', { alt: '' }); Apps.icon(a, img);
          return h('div', { class: 'item', onclick: () => { const l = pins(); if (l.length >= 14) { flash('В доке до 14 программ'); return; } l.push({ id: a.id, name: a.name, exe: a.exe || '', lnk: a.lnk || '', uwp: a.uwp || '' }); savePins(l); flash(`${a.name} — в таскбаре`); fill(); } },
            img, h('span', { class: 'txt' }, a.name), h('span', { class: 'ib', html: icon('plus') }));
        }));
        if (!found.length) list.append(h('div', { class: 'muted small tbs-empty' }, 'Ничего не нашлось'));
      };
      inp.addEventListener('input', () => { q = inp.value; fill(); });
      setTimeout(() => inp.focus(), 50);
      fill();
      return h('div', { class: 'col', style: { flex: '1', minHeight: '0' } }, inp, list);
    }

    // ---- справа: кнопки, ярлыки, поведение ----
    function drawRight() {
      if (!c) return;
      const sw = (name, on, fn, desc) => h('div', { class: 'sw' }, h('span', {}, name, desc ? h('span', { class: 'muted' }, ' · ' + desc) : null), toggleEl(on, fn));
      const has = (x) => (c.extras || []).some((y) => (x.place && y.place === x.place) || (x.tool && y.tool === x.tool) || (x.path && y.path === x.path));
      const flip = (x) => set({ extras: has(x) ? c.extras.filter((y) => !((x.place && y.place === x.place) || (x.tool && y.tool === x.tool) || (x.path && y.path === x.path))) : [...(c.extras || []), x] });
      const chip = (x, label, ic) => h('button', { class: 'chip tbs-chip' + (has(x) ? ' on' : ''), onclick: () => flip(x) }, I(ic), label);
      const folders = (c.extras || []).filter((x) => x.path);
      right.replaceChildren(
        h('b', { class: 'tbs-cap' }, 'Кнопки'),
        h('div', { class: 'tbs-chips' },
          h('button', { class: 'chip tbs-chip' + (c.btn.start ? ' on' : ''), onclick: () => set({ btn: { ...c.btn, start: !c.btn.start } }) }, I('apps'), 'Приложения'),
          h('button', { class: 'chip tbs-chip' + (c.btn.search ? ' on' : ''), onclick: () => set({ btn: { ...c.btn, search: !c.btn.search } }) }, I('search'), 'Поиск'),
          h('button', { class: 'chip tbs-chip' + (c.btn.desktop ? ' on' : ''), onclick: () => set({ btn: { ...c.btn, desktop: !c.btn.desktop } }) }, I('minimize'), 'Свернуть всё'),
          h('button', { class: 'chip tbs-chip' + (c.running ? ' on' : ''), onclick: () => set({ running: !c.running }) }, I('apps'), 'Открытые программы')),
        h('b', { class: 'tbs-cap' }, 'Места Windows'),
        h('div', { class: 'tbs-chips' }, ...TB_PLACES.map(([id, label, ic]) => chip({ place: id, name: label }, label, ic))),
        h('b', { class: 'tbs-cap' }, 'Инструменты Bar'),
        h('div', { class: 'tbs-chips' }, ...TB_TOOLS.filter((id) => TOOLS_BY_ID[id]).map((id) => chip({ tool: id, name: TOOLS_BY_ID[id].name }, TOOLS_BY_ID[id].short || TOOLS_BY_ID[id].name, TOOLS_BY_ID[id].icon))),
        h('b', { class: 'tbs-cap' }, 'Папки'),
        h('div', { class: 'tbs-chips' },
          ...folders.map((x) => h('button', { class: 'chip tbs-chip on', title: x.path + ' — нажмите, чтобы убрать', onclick: () => flip(x) }, I('folder'), x.name)),
          h('button', { class: 'chip tbs-chip add', onclick: async () => { const pth = await bar.pickFolder(); if (pth && !has({ path: pth })) set({ extras: [...(c.extras || []), { path: pth, name: pth.split(/[\\/]/).filter(Boolean).pop() || pth }] }); } }, I('fold'), 'Добавить папку')),
        h('b', { class: 'tbs-cap' }, 'Поведение'),
        h('div', { class: 'sw' }, h('span', {}, 'Таскбар'), segEl([['hide', 'Прятаться'], ['always', 'Всегда на месте']], c.mode, (v) => set({ mode: v }))),
        sw('Увеличение при наведении', c.magnify, (v) => set({ magnify: v })),
        h('div', { class: 'muted small' }, 'Размер на каждом мониторе — в Настройки → Дополнительно. Порядок программ — перетаскиванием слева.'));
    }
    const toggleEl = (on, fn) => { const b = h('button', { class: 'toggle' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(!!on) }); b.onclick = () => { b.classList.toggle('on'); fn(b.classList.contains('on')); }; return b; };
    const segEl = (opts, val, fn) => h('div', { class: 'seg' }, opts.map(([v, label]) => h('button', { class: v === val ? 'on' : '', onclick: () => fn(v) }, label)));

    drawLeft();
    bar.taskbarGet().then((x) => { c = x; drawRight(); });
    // закрепили в доке нотча или в самом таскбаре — список обновится
    const onStore = (e) => { if (e.key === 'bar.dock' && !picking) drawLeft(); };
    window.addEventListener('storage', onStore);
    return () => window.removeEventListener('storage', onStore);
  },
});
SRCH_KW.tbset = 'таскбар панель задач док закрепить taskbar dock';

// таскбар просит открыть инструмент (кнопка «Пуск» → все приложения)
bar.onOpenTool((id) => { if (!TOOLS_BY_ID[id]) return; expand({ auto: true }); openTool(id); });
openHooks.add(() => pushNeed());
pushNeed();
