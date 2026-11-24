// Код, который Bar выполняет внутри страницы music.youtube.com (через executeJavaScript).
// Он работает только с плеером и внутренним API самой страницы — так же, как её собственный код.
// Возвращает компактные данные для интерфейса Bar.
(() => {
  // версия кода на странице: при обновлении расширения новая версия заменяет старую
  const BAR_PAGE_V = '0.2.1';
  if (window.__bar && window.__bar.v === BAR_PAGE_V) return true;

  const P = () => document.querySelector('#movie_player');
  const BAR = () => document.querySelector('ytmusic-player-bar');
  const txt = (r) => (r && (r.runs ? r.runs.map((x) => x.text).join('') : r.simpleText)) || '';
  const big = (u) => (u || '').replace(/=w\d+-h\d+[^&]*$/, '=w544-h544-l90-rj').replace(/=s\d+[^&]*$/, '=s544');
  const thumb = (t) => {
    const a = t && ((t.musicThumbnailRenderer && t.musicThumbnailRenderer.thumbnail.thumbnails)
      || (t.croppedSquareThumbnailRenderer && t.croppedSquareThumbnailRenderer.thumbnail.thumbnails)
      || t.thumbnails);
    return a && a.length ? a[a.length - 1].url : '';
  };
  const nav = (e) => {
    if (!e) return null;
    if (e.browseEndpoint) {
      const cfg = e.browseEndpoint.browseEndpointContextSupportedConfigs;
      return { browseId: e.browseEndpoint.browseId, params: e.browseEndpoint.params || '', page: cfg && cfg.browseEndpointContextMusicConfig ? cfg.browseEndpointContextMusicConfig.pageType : '' };
    }
    if (e.watchEndpoint) return { videoId: e.watchEndpoint.videoId, playlistId: e.watchEndpoint.playlistId || '' };
    if (e.watchPlaylistEndpoint) return { playlistId: e.watchPlaylistEndpoint.playlistId };
    return null;
  };
  const playOf = (o) => {
    const c = o && o.musicItemThumbnailOverlayRenderer && o.musicItemThumbnailOverlayRenderer.content;
    return c && c.musicPlayButtonRenderer ? nav(c.musicPlayButtonRenderer.playNavigationEndpoint) : null;
  };

  // ---------- внутренний API YouTube Music (InnerTube) ----------
  async function authHeader() {
    const m = document.cookie.match(/(?:^|;\s*)(?:__Secure-3PAPISID|SAPISID)=([^;]+)/);
    if (!m) return null;
    const ts = Math.floor(Date.now() / 1000);
    const data = new TextEncoder().encode(ts + ' ' + m[1] + ' ' + location.origin);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-1', data))].map((b) => b.toString(16).padStart(2, '0')).join('');
    return 'SAPISIDHASH ' + ts + '_' + hash;
  }
  async function api(endpoint, body) {
    const cfg = window.ytcfg;
    const headers = {
      'Content-Type': 'application/json',
      'X-Goog-AuthUser': String(cfg.get('SESSION_INDEX') || 0),
      'X-Origin': location.origin,
      'X-Youtube-Client-Name': String(cfg.get('INNERTUBE_CONTEXT_CLIENT_NAME')),
      'X-Youtube-Client-Version': String(cfg.get('INNERTUBE_CLIENT_VERSION')),
    };
    const auth = await authHeader();
    if (auth) headers.Authorization = auth;
    const r = await fetch('/youtubei/v1/' + endpoint + '?prettyPrint=false', {
      method: 'POST', credentials: 'include', headers,
      body: JSON.stringify(Object.assign({ context: cfg.get('INNERTUBE_CONTEXT') }, body)),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // ---------- разбор ответов в простой вид ----------
  function card(r) {
    return {
      kind: 'card', title: txt(r.title), subtitle: txt(r.subtitle), thumb: big(thumb(r.thumbnailRenderer)),
      nav: nav(r.navigationEndpoint), play: playOf(r.thumbnailOverlay),
    };
  }
  function row(r) {
    const cols = (r.flexColumns || []).map((c) => c.musicResponsiveListItemFlexColumnRenderer && txt(c.musicResponsiveListItemFlexColumnRenderer.text));
    const fixed = (r.fixedColumns || []).map((c) => c.musicResponsiveListItemFixedColumnRenderer && txt(c.musicResponsiveListItemFixedColumnRenderer.text));
    let play = playOf(r.overlay);
    const vid = r.playlistItemData && r.playlistItemData.videoId;
    if (!play && vid) play = { videoId: vid, playlistId: '' };
    let n = nav(r.navigationEndpoint);
    if (!n) {
      const first = r.flexColumns && r.flexColumns[0] && r.flexColumns[0].musicResponsiveListItemFlexColumnRenderer;
      const run = first && first.text && first.text.runs && first.text.runs[0];
      n = run ? nav(run.navigationEndpoint) : null;
    }
    return {
      kind: 'row', title: cols[0] || '', subtitle: cols.slice(1).filter(Boolean).join(' · '),
      duration: fixed[0] || '', thumb: thumb(r.thumbnail), nav: n, play,
    };
  }
  function sections(json) {
    const out = [];
    const seen = new Set();
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (k === 'musicCarouselShelfRenderer' || k === 'musicShelfRenderer' || k === 'musicPlaylistShelfRenderer' || k === 'gridRenderer') {
          if (seen.has(v)) continue; seen.add(v);
          const head = v.header && (v.header.musicCarouselShelfBasicHeaderRenderer || v.header.gridHeaderRenderer || v.header);
          const title = txt(v.title) || txt(head && head.title) || '';
          const items = [];
          for (const it of (v.contents || v.items || [])) {
            if (it.musicTwoRowItemRenderer) items.push(card(it.musicTwoRowItemRenderer));
            else if (it.musicResponsiveListItemRenderer) items.push(row(it.musicResponsiveListItemRenderer));
          }
          if (items.length) out.push({ title, items });
          continue;
        }
        if (k === 'musicCardShelfRenderer') {
          const v2 = v;
          out.push({ title: txt(v2.header && v2.header.musicCardShelfHeaderBasicRenderer && v2.header.musicCardShelfHeaderBasicRenderer.title) || 'Лучший результат',
            items: [{ kind: 'card', title: txt(v2.title), subtitle: txt(v2.subtitle), thumb: big(thumb(v2.thumbnail)), nav: nav(v2.title && v2.title.runs && v2.title.runs[0].navigationEndpoint), play: playOf(v2.thumbnailOverlay) }] });
          continue;
        }
        walk(v);
      }
    })(json);
    return out;
  }
  function header(json) {
    let h = null;
    (function walk(o) {
      if (h || !o || typeof o !== 'object') return;
      for (const k of Object.keys(o)) {
        if (/^music(Responsive|Detail|Immersive|Visual)HeaderRenderer$|^musicEditablePlaylistDetailHeaderRenderer$/.test(k)) {
          const v = o[k].header ? Object.values(o[k].header)[0] : o[k];
          const pb = v.buttons && v.buttons.map((b) => b.musicPlayButtonRenderer).find(Boolean);
          h = { title: txt(v.title), subtitle: [txt(v.subtitle), txt(v.secondSubtitle), txt(v.straplineTextOne)].filter(Boolean).join(' · '),
            thumb: big(thumb(v.thumbnail)), play: pb ? nav(pb.playNavigationEndpoint) : null };
          return;
        }
        walk(o[k]);
      }
    })(json);
    return h;
  }

  // ---------- состояние плеера ----------
  function state() {
    const p = P();
    if (!p || !p.getVideoData) return { ready: false, signedIn: /(?:^|;\s*)SAPISID=/.test(document.cookie) };
    const vd = p.getVideoData() || {};
    const b = BAR();
    // обложка: метаданные трека для системного плеера (большая) → картинка в панели плеера → превью видео
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const aw = md && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : '';
    const img = b && b.querySelector('img.image, .thumbnail-image-wrapper img, ytmusic-player-bar .image');
    const imgSrc = img && /^https:/.test(img.src) && !/music\.youtube\.com\/?$/.test(img.src) ? img.src : '';
    const art = aw || imgSrc || (vd.video_id ? 'https://i.ytimg.com/vi/' + vd.video_id + '/hqdefault.jpg' : '');
    const like = b && b.querySelector('ytmusic-like-button-renderer');
    const byline = b && b.querySelector('.byline');
    return {
      ready: true, signedIn: /(?:^|;\s*)SAPISID=/.test(document.cookie),
      id: vd.video_id || '', title: vd.title || '', artist: (byline ? byline.textContent : vd.author || '').trim().replace(/\s+/g, ' '),
      art: big(art), state: p.getPlayerState(), time: p.getCurrentTime() || 0, duration: p.getDuration() || 0,
      volume: p.getVolume(), muted: p.isMuted(), like: like ? like.getAttribute('like-status') || '' : '',
      repeat: b ? (b.getAttribute('repeat-mode') || b.getAttribute('repeat-mode_') || '') : '',
      shuffle: !!(b && b.querySelector('.shuffle.style-default-active, .shuffle[aria-pressed="true"]')),
    };
  }
  // Обложка строки очереди. Картинки в очереди страница грузит лениво — только у видимых строк есть src,
  // поэтому берём ссылку из данных самого элемента, а если их нет — превью по ID видео.
  function qThumb(el) {
    const d = el.data || (el.__data && el.__data.data) || {};
    const r = d.playlistPanelVideoRenderer || (d.primaryRenderer && d.primaryRenderer.playlistPanelVideoRenderer) || d;
    const fromData = thumb(r.thumbnail);
    if (fromData) return fromData;
    const img = el.querySelector('img');
    if (img && img.src && !img.src.startsWith('data:')) return img.src;
    const id = r.videoId || (r.navigationEndpoint && r.navigationEndpoint.watchEndpoint && r.navigationEndpoint.watchEndpoint.videoId);
    return id ? 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg' : '';
  }
  function queue() {
    return [...document.querySelectorAll('ytmusic-player-queue #contents > ytmusic-player-queue-item, ytmusic-player-queue #contents ytmusic-player-queue-item')]
      .slice(0, 80).map((el, i) => ({
        i, title: (el.querySelector('.song-title') || {}).textContent || '', subtitle: ((el.querySelector('.byline') || {}).textContent || '').trim(),
        duration: ((el.querySelector('.duration') || {}).textContent || '').trim(), thumb: qThumb(el),
        current: el.hasAttribute('selected') || el.getAttribute('play-button-state') === 'playing' || el.getAttribute('play-button-state') === 'paused',
      }));
  }
  function go(endpoint) {
    // переход по внутренним правилам самой страницы (как клик по треку), без перезагрузки
    const app = document.querySelector('ytmusic-app');
    if (!app) return false;
    app.dispatchEvent(new CustomEvent('yt-navigate', { bubbles: true, composed: true, detail: { endpoint } }));
    return true;
  }
  function click(sel) { const el = BAR() && BAR().querySelector(sel); if (el) { el.click(); return true; } return false; }

  window.__bar = {
    v: BAR_PAGE_V,
    state, queue,
    toggle() { const p = P(); if (!p) return false; if (p.getPlayerState() === 1) p.pauseVideo(); else p.playVideo(); return true; },
    next() { const p = P(); p && p.nextVideo(); return true; },
    prev() { const p = P(); if (!p) return false; if (p.getCurrentTime() > 4) p.seekTo(0, true); else p.previousVideo(); return true; },
    seek(s) { const p = P(); p && p.seekTo(Number(s), true); return true; },
    volume(v) { const p = P(); if (!p) return false; p.setVolume(Math.max(0, Math.min(100, Number(v)))); if (p.isMuted()) p.unMute(); return true; },
    like() { return click('ytmusic-like-button-renderer #button-shape-like button, ytmusic-like-button-renderer .like'); },
    dislike() { return click('ytmusic-like-button-renderer #button-shape-dislike button, ytmusic-like-button-renderer .dislike'); },
    shuffle() { return click('.shuffle'); },
    repeat() { return click('.repeat'); },
    playQueue(i) {
      const el = document.querySelectorAll('ytmusic-player-queue #contents ytmusic-player-queue-item')[i];
      if (!el) return false;
      const btn = el.querySelector('ytmusic-play-button-renderer') || el;
      btn.click(); return true;
    },
    play(n) {
      if (!n) return false;
      if (n.videoId) return go({ watchEndpoint: n.playlistId ? { videoId: n.videoId, playlistId: n.playlistId } : { videoId: n.videoId } });
      if (n.playlistId) return go({ watchPlaylistEndpoint: { playlistId: n.playlistId } });
      return false;
    },
    async browse(browseId, params) {
      const j = await api('browse', params ? { browseId, params } : { browseId });
      return { header: header(j), sections: sections(j) };
    },
    async search(q) { return { sections: sections(await api('search', { query: q })) }; },
    async lyrics(videoId) {
      const j = await api('next', { videoId, isAudioOnly: true });
      let lid = null;
      (function walk(o) {
        if (lid || !o || typeof o !== 'object') return;
        if (o.tabRenderer && o.tabRenderer.endpoint && o.tabRenderer.endpoint.browseEndpoint
          && /^MPLY/.test(o.tabRenderer.endpoint.browseEndpoint.browseId)) { lid = o.tabRenderer.endpoint.browseEndpoint.browseId; return; }
        Object.values(o).forEach(walk);
      })(j);
      if (!lid) return { text: '', source: '' };
      const l = await api('browse', { browseId: lid });
      let text = '', source = '';
      (function walk(o) {
        if (text || !o || typeof o !== 'object') return;
        if (o.musicDescriptionShelfRenderer) { text = txt(o.musicDescriptionShelfRenderer.description); source = txt(o.musicDescriptionShelfRenderer.footer); return; }
        Object.values(o).forEach(walk);
      })(l);
      return { text, source };
    },
  };
  return true;
})();
