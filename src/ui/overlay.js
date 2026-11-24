(async () => {
  const $ = (s) => document.querySelector(s);
  const init = await window.ov.init();
  if (!init) return window.ov.cancel();
  const { mode, width, height } = init;

  // BGRA → RGBA
  const px = new Uint8ClampedArray(init.data.buffer, init.data.byteOffset, init.data.byteLength);
  for (let i = 0; i < px.length; i += 4) { const b = px[i]; px[i] = px[i + 2]; px[i + 2] = b; px[i + 3] = 255; }
  const cv = $('#cv');
  cv.width = width; cv.height = height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.putImageData(new ImageData(px, width, height), 0, 0);

  const sx = () => width / innerWidth;
  const sy = () => height / innerHeight;

  const HINTS = {
    ocr: 'Выделите текст — он попадёт в буфер обмена · <kbd>Esc</kbd> отмена',
    shot: 'Выделите область скриншота · <kbd>Enter</kbd> весь экран · <kbd>Esc</kbd> отмена',
    qrscan: 'Выделите QR-код или нажмите <kbd>Enter</kbd> для поиска по всему экрану',
    color: 'Кликните по пикселю · <kbd>←↑→↓</kbd> точнее · <kbd>Esc</kbd> отмена',
  };
  $('#hint').innerHTML = HINTS[mode] || '';

  const cancel = () => window.ov.cancel();
  addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); });

  // ---------- пипетка ----------
  if (mode === 'color') {
    document.body.classList.add('color');
    const mag = $('#mag'), mctx = mag.getContext('2d'), lab = $('#lab');
    mctx.imageSmoothingEnabled = false;
    let mx = innerWidth / 2, my = innerHeight / 2, raf = 0;
    const N = 11, Z = 12;
    const pixelAt = () => {
      const x = Math.min(width - 1, Math.max(0, Math.floor(mx * sx())));
      const y = Math.min(height - 1, Math.max(0, Math.floor(my * sy())));
      const d = ctx.getImageData(x, y, 1, 1).data;
      return { x, y, r: d[0], g: d[1], b: d[2] };
    };
    const hex = ({ r, g, b }) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    const draw = () => {
      raf = 0;
      const p = pixelAt();
      mctx.clearRect(0, 0, 132, 132);
      mctx.drawImage(cv, p.x - (N >> 1), p.y - (N >> 1), N, N, 0, 0, N * Z, N * Z);
      mctx.strokeStyle = 'rgba(255,255,255,.9)'; mctx.lineWidth = 2;
      mctx.strokeRect((N >> 1) * Z, (N >> 1) * Z, Z, Z);
      const right = mx + 160 < innerWidth, below = my + 190 < innerHeight;
      mag.style.display = lab.style.display = 'block';
      mag.style.left = (right ? mx + 22 : mx - 154) + 'px';
      mag.style.top = (below ? my + 22 : my - 190) + 'px';
      lab.style.left = mag.style.left;
      lab.style.top = (parseFloat(mag.style.top) + 140) + 'px';
      const h = hex(p);
      lab.innerHTML = `<i style="background:${h}"></i>${h} · ${p.r}, ${p.g}, ${p.b}`;
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };
    addEventListener('mousemove', (e) => { mx = e.clientX; my = e.clientY; schedule(); });
    addEventListener('keydown', (e) => {
      const step = 1 / sx();
      if (e.key === 'Escape') return cancel();
      if (e.key === 'ArrowLeft') mx -= step; else if (e.key === 'ArrowRight') mx += step;
      else if (e.key === 'ArrowUp') my -= step; else if (e.key === 'ArrowDown') my += step;
      else if (e.key === 'Enter') return pick(); else return;
      e.preventDefault(); schedule();
    });
    const pick = () => { const p = pixelAt(); window.ov.done({ mode, hex: hex(p), r: p.r, g: p.g, b: p.b }); };
    addEventListener('mousedown', (e) => { if (e.button === 0) pick(); });
    schedule();
    return;
  }

  // ---------- выделение области ----------
  const sel = $('#sel'), size = $('#size');
  let start = null, rect = null;
  const show = (r) => {
    sel.style.display = 'block'; $('#dim').style.display = 'none';
    Object.assign(sel.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    size.style.display = 'block';
    size.textContent = `${Math.round(r.w * sx())} × ${Math.round(r.h * sy())}`;
    size.style.left = r.x + 'px';
    size.style.top = (r.y > 26 ? r.y - 24 : r.y + r.h + 6) + 'px';
  };
  addEventListener('mousedown', (e) => { if (e.button === 0) { start = { x: e.clientX, y: e.clientY }; rect = null; } });
  addEventListener('mousemove', (e) => {
    if (!start) return;
    rect = {
      x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY),
      w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y),
    };
    show(rect);
  });
  addEventListener('mouseup', () => {
    if (!start) return;
    start = null;
    if (rect && rect.w > 4 && rect.h > 4) finish(rect);
    else if (mode === 'qrscan') finish(null);
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel();
    if (e.key === 'Enter' && (mode === 'shot' || mode === 'qrscan')) finish(null);
  });

  function crop(r, scale = 1) {
    const src = r ? { x: r.x * sx(), y: r.y * sy(), w: r.w * sx(), h: r.h * sy() } : { x: 0, y: 0, w: width, h: height };
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.w * scale));
    c.height = Math.max(1, Math.round(src.h * scale));
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(cv, src.x, src.y, src.w, src.h, 0, 0, c.width, c.height);
    return c;
  }

  function finish(r) {
    if (mode === 'shot') return window.ov.done({ mode, png: crop(r).toDataURL('image/png') });
    if (mode === 'ocr') {
      // мелкий текст OCR читает лучше, если его увеличить
      const h = r.h * sy();
      const scale = h < 200 ? 3 : h < 600 ? 2 : 1;
      const c = crop(r, Math.min(scale, 4000 / (r.w * sx())));
      return window.ov.done({ mode, png: c.toDataURL('image/png') });
    }
    if (mode === 'qrscan') {
      const tryScan = (c) => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
        const code = window.jsQR && window.jsQR(d.data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
        return code ? code.data : null;
      };
      let text = tryScan(crop(r));
      if (!text && r) text = tryScan(crop(r, 2));
      if (!text && !r) text = tryScan(crop(null, 0.5));
      return window.ov.done({ mode, text });
    }
  }
})();
