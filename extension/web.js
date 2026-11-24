// Bar — универсальное управление музыкальными сайтами (Яндекс Музыка, SoundCloud, Spotify Web, VK и др.).
// Работает через стандартные механизмы браузера, а не через устройство конкретного сайта:
//  • Media Session — название, исполнитель, обложка и кнопки, которые сайт сам регистрирует для Windows
//    (те же, что у мультимедийных клавиш): пауза, следующий, предыдущий, перемотка;
//  • аудиоэлемент страницы — точная позиция, длительность и громкость.
// Скрипт запускается до кода сайта, чтобы запомнить эти кнопки, и ничего не отправляет в интернет:
// отвечает только на запросы Bar через расширение (фиксированный список действий).
(() => {
  if (window.__barWeb) return;
  const handlers = {};
  let pos = null; // последнее setPositionState: { duration, position, playbackRate, at }
  const ms = navigator.mediaSession;
  if (ms && ms.setActionHandler) {
    const setAH = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (action, fn) => { handlers[action] = fn || null; return setAH(action, fn); };
    if (ms.setPositionState) {
      const setPS = ms.setPositionState.bind(ms);
      ms.setPositionState = (st) => { pos = st && st.duration ? { ...st, at: performance.now() } : null; return setPS(st); };
    }
  }
  // аудио, которое сайт запускает, даже если его нет в разметке (new Audio())
  const media = new Set();
  const play0 = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { media.add(this); return play0.apply(this, arguments); };
  const el = () => {
    const all = [...media, ...document.querySelectorAll('audio, video')].filter((m) => m.isConnected || media.has(m));
    return all.find((m) => !m.paused && !m.ended) || all.filter((m) => m.duration > 0 && m.currentTime > 0).pop() || null;
  };
  const playing = () => { const m = el(); return (ms && ms.playbackState === 'playing') || !!(m && !m.paused && !m.ended); };
  const call = (action, extra) => { const f = handlers[action]; if (!f) return false; try { f({ action, ...(extra || {}) }); return true; } catch { return false; } };
  const bigArt = (list) => {
    if (!list || !list.length) return '';
    const size = (a) => Math.max(0, ...String(a.sizes || '0x0').split(/\s+/).map((s) => parseInt(s, 10) || 0));
    return [...list].sort((a, b) => size(b) - size(a))[0].src || '';
  };

  const api = {
    v: '1',
    wstate() {
      const md = ms && ms.metadata;
      const m = el();
      const on = playing();
      let time = m ? m.currentTime : null, duration = m && isFinite(m.duration) ? m.duration : null;
      if (pos && pos.duration) { // сайты на Web Audio сообщают позицию сами — так точнее
        duration = pos.duration;
        time = Math.min(pos.duration, pos.position + (on ? (performance.now() - pos.at) / 1000 * (pos.playbackRate || 1) : 0));
      }
      // сайт не передал метаданные (например, Bandcamp) — название из заголовка страницы, обложка — из её превью
      let title = (md && md.title) || '', artist = (md && md.artist) || '', art = bigArt(md && md.artwork);
      if (!title && m) {
        const parts = document.title.split(/\s+[|–—]\s+/);
        title = parts[0] || ''; artist = artist || parts[1] || '';
        const og = document.querySelector('meta[property="og:image"]');
        art = art || (og && og.content) || '';
      }
      return {
        host: location.hostname, title, artist, album: (md && md.album) || '',
        art, playing: on, time, duration,
        volume: m ? Math.round(m.volume * 100) : null,
        canNext: !!handlers.nexttrack, canPrev: !!handlers.previoustrack, canSeek: !!handlers.seekto || !!m,
      };
    },
    wtoggle() {
      if (playing()) return call('pause') || (el() ? (el().pause(), true) : false);
      return call('play') || (el() ? (el().play(), true) : false);
    },
    wnext() { return call('nexttrack'); },
    wprev() { return call('previoustrack'); },
    wseek(sec) {
      sec = Math.max(0, +sec || 0);
      if (call('seekto', { seekTime: sec, fastSeek: false })) return true;
      const m = el(); if (m) { m.currentTime = sec; return true; }
      return false;
    },
    wvolume(v) { const m = el(); if (!m) return false; m.volume = Math.max(0, Math.min(1, (+v || 0) / 100)); return true; },
  };
  Object.defineProperty(window, '__barWeb', { value: api });

  const ALLOWED = ['wstate', 'wtoggle', 'wnext', 'wprev', 'wseek', 'wvolume'];
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.__barReq !== true) return;
    const { id, fn, args } = e.data;
    if (!ALLOWED.includes(fn)) return;
    let result, error;
    try { result = await api[fn](...(Array.isArray(args) ? args : [])); } catch (err) { error = String((err && err.message) || err); }
    window.postMessage({ __barRes: true, id, result, error }, location.origin);
  });
})();
