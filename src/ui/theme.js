// Bar — движок оформления.
// Пользователь выбирает тему, акцент, подсветку и скругление; всё остальное вычисляется,
// причём так, чтобы контраст по WCAG соблюдался при ЛЮБОМ выбранном цвете:
//   текст ≥ 4.5:1, графика (кольца, полоски, переключатели) ≥ 3:1.
(function () {
  'use strict';

  const THEMES = {
    dark: {
      name: 'Тёмная',
      bg: '#08080a', card: '#141419', cardHi: '#1c1c23', ctl: '#22222a', ctlHi: '#2b2b35',
      line: 'rgba(255,255,255,.07)', track: 'rgba(255,255,255,.12)',
      fg: '#f4f4f7', fg2: '#d4d4dc', mut: '#8c8c98', shadow: 'rgba(0,0,0,.5)',
    },
    oled: {
      name: 'OLED',
      bg: '#000000', card: '#0f0f11', cardHi: '#17171a', ctl: '#1c1c20', ctlHi: '#26262b',
      line: 'rgba(255,255,255,.08)', track: 'rgba(255,255,255,.13)',
      fg: '#ffffff', fg2: '#d8d8de', mut: '#8e8e96', shadow: 'rgba(0,0,0,.6)',
    },
    graphite: {
      name: 'Графит',
      bg: '#16181d', card: '#1f2229', cardHi: '#272b33', ctl: '#2c3039', ctlHi: '#363b46',
      line: 'rgba(255,255,255,.08)', track: 'rgba(255,255,255,.13)',
      fg: '#eef0f4', fg2: '#cfd3db', mut: '#979dab', shadow: 'rgba(0,0,0,.45)',
    },
    light: {
      name: 'Светлая',
      bg: '#f7f7f9', card: '#ebebf0', cardHi: '#e2e2e9', ctl: '#dadae2', ctlHi: '#cdcdd7',
      line: 'rgba(0,0,0,.08)', track: 'rgba(0,0,0,.12)',
      fg: '#141419', fg2: '#2b2b33', mut: '#5f5f6b', shadow: 'rgba(0,0,0,.18)',
    },
  };

  const ACCENTS = [
    ['#6c5cff', 'Фиалка'], ['#3b82f6', 'Синий'], ['#0ea5a4', 'Бирюза'], ['#22a55a', 'Зелёный'],
    ['#f97316', 'Оранжевый'], ['#e5468f', 'Розовый'], ['#e5484d', 'Красный'], ['#64748b', 'Сталь'],
  ];
  const HIGHLIGHTS = [
    ['#d7ff3e', 'Лайм'], ['#3ee8b5', 'Мята'], ['#4cc9ff', 'Небо'], ['#ffb020', 'Янтарь'],
    ['#ff6fae', 'Фуксия'], ['#f4f4f7', 'Белый'],
  ];
  const RADII = { strict: ['Строгое', 8], normal: ['Обычное', 14], soft: ['Мягкое', 20] };
  const DEFAULTS = { theme: 'dark', acc: '#6c5cff', hi: '#d7ff3e', radius: 'normal', pillBlack: false };
  // свёрнутый нотч по умолчанию следует теме; чёрный «вырез» при светлой теме — по желанию (старый ключ blackPill больше не читается)
  const RED = '#ff4d61';

  // ---------- цветовая математика ----------
  const parse = (c) => {
    c = String(c).trim();
    if (c[0] === '#') {
      let h = c.slice(1);
      if (h.length === 3) h = h.split('').map((x) => x + x).join('');
      const n = parseInt(h.slice(0, 6), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const m = c.match(/[\d.]+/g) || [0, 0, 0];
    return [+m[0], +m[1], +m[2]];
  };
  const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const [r, g, b] = parse(c);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const mix = (a, b, t) => { const p = parse(a), q = parse(b); return hex(p.map((v, i) => v + (q[i] - v) * t)); };

  // Сдвигает цвет к чёрному/белому, пока он не станет читаем на ВСЕХ указанных фонах.
  function ensure(color, bgs, ratio) {
    bgs = [].concat(bgs);
    const ok = (c) => bgs.every((b) => contrast(c, b) >= ratio);
    if (ok(color)) return hex(parse(color));
    const target = lum(bgs[0]) > 0.35 ? '#000000' : '#ffffff';
    for (let t = 0.04; t <= 1.0001; t += 0.04) { const c = mix(color, target, t); if (ok(c)) return c; }
    return target;
  }
  // Текст поверх заливки: белый, если он проходит 4.5:1, иначе — тот, что контрастнее.
  const onColor = (fill) => (contrast('#ffffff', fill) >= 4.5 ? '#ffffff'
    : contrast('#ffffff', fill) >= contrast('#0b0b0e', fill) ? '#ffffff' : '#0b0b0e');
  const hover = (fill) => mix(fill, lum(fill) > 0.3 ? '#000000' : '#ffffff', 0.12);

  // ---------- хранение ----------
  function load() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('bar.theme') || '{}') }; } catch { return { ...DEFAULTS }; }
  }
  function save(cfg) { try { localStorage.setItem('bar.theme', JSON.stringify(cfg)); } catch {} }

  // ---------- применение ----------
  function tokens(cfg) {
    const t = THEMES[cfg.theme] || THEMES.dark;
    const surfaces = [t.bg, t.card, t.cardHi, t.ctl, t.ctlHi]; // текст встречается на всех поверхностях, включая кнопки
    const card = RADII[cfg.radius] ? RADII[cfg.radius][1] : 14;
    const DARK = ['#000000', '#08080a']; // свёрнутый «чёрный нотч»
    // Заливка кнопок должна отличаться от фона ≥ 3:1 (WCAG 1.4.11), иначе кнопку не видно.
    const acc = ensure(cfg.acc, [t.bg, t.card], 3);
    const hi = ensure(cfg.hi, [t.bg, t.card], 3);
    return {
      '--bg': t.bg, '--card': t.card, '--card-hi': t.cardHi, '--ctl': t.ctl, '--ctl-hi': t.ctlHi,
      '--line': t.line, '--track': t.track, '--fg': t.fg, '--fg-2': t.fg2, '--mut': t.mut,
      '--shadow': t.shadow, '--paper': '#ffffff', '--knob': '#ffffff',

      '--acc': acc, '--acc-hover': hover(acc), '--on-acc': onColor(acc),
      '--acc-text': ensure(cfg.acc, surfaces, 4.5), '--acc-g': ensure(cfg.acc, surfaces, 3),

      '--hi': hi, '--hi-hover': hover(hi), '--on-hi': onColor(hi),
      '--hi-text': ensure(cfg.hi, surfaces, 4.5), '--hi-g': ensure(cfg.hi, surfaces, 3),

      '--red': RED, '--on-red': onColor(RED), '--red-text': ensure(RED, surfaces, 4.5), '--red-g': ensure(RED, surfaces, 3),

      // варианты для свёрнутого чёрного нотча при светлой теме
      '--hi-dk': ensure(cfg.hi, DARK, 4.5), '--acc-dk': ensure(cfg.acc, DARK, 4.5), '--red-dk': ensure(RED, DARK, 4.5),

      // одно скругление на всё: нотч, карточки, плитки, поля, кнопки
      '--r': card + 'px', '--r-card': card + 'px', '--r-ctl': card + 'px', '--r-panel': card + 'px', '--r-pill': card + 'px',
      '--r-sm': Math.max(4, Math.round(card / 2)) + 'px',
    };
  }

  function apply(cfg = load()) {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(tokens(cfg))) root.style.setProperty(k, v);
    root.dataset.theme = cfg.theme;
    root.dataset.pill = cfg.pillBlack && cfg.theme === 'light' ? 'black' : 'theme';
    root.style.colorScheme = cfg.theme === 'light' ? 'light' : 'dark';
    return cfg;
  }

  window.BarTheme = { THEMES, ACCENTS, HIGHLIGHTS, RADII, DEFAULTS, load, save, apply, tokens, contrast, ensure };
  apply();
  // другие окна (оверлей) подхватывают смену оформления сразу
  window.addEventListener('storage', (e) => { if (e.key === 'bar.theme') apply(); });
})();
