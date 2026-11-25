// Фоновая часть расширения «Bar — YouTube Music».
//
// Что делает: держит связь с Bar на ЭТОМ компьютере и передаёт его запросы во вкладку YouTube Music.
// Чего не может: политика безопасности расширения (manifest.json → content_security_policy) разрешает
// подключаться только к ws://127.0.0.1 — отправить что-либо в интернет браузер ему не даст.
//
// Взаимная проверка: при подключении Bar и расширение обмениваются случайными числами и подписывают
// их общим секретным ключом (HMAC-SHA256, ключ — в pair.json, по сети не передаётся).
// Пока Bar не докажет, что он настоящий, расширение не выполняет ни одного запроса.
const PORTS = [47823, 47824, 47825];
// музыкальные сайты (плеер через Media Session): список — как в manifest.json
const WEB_SITES = ["https://music.yandex.ru/*", "https://music.yandex.com/*", "https://music.yandex.by/*", "https://music.yandex.kz/*", "https://soundcloud.com/*", "https://open.spotify.com/*", "https://vk.com/*", "https://vk.ru/*", "https://music.apple.com/*", "https://www.deezer.com/*", "https://listen.tidal.com/*", "https://*.bandcamp.com/*", "https://zvuk.com/*", "https://music.amazon.com/*", "https://music.amazon.de/*", "https://www.mixcloud.com/*"];
const WEB_FNS = ['wtoggle', 'wnext', 'wprev', 'wseek', 'wvolume'];
const WEB_HOST = /^https:\/\/(music\.yandex\.(ru|com|by|kz)|soundcloud\.com|open\.spotify\.com|vk\.(com|ru)|music\.apple\.com|www\.deezer\.com|listen\.tidal\.com|[a-z0-9-]+\.bandcamp\.com|zvuk\.com|music\.amazon\.(com|de)|www\.mixcloud\.com)\//;
const ALLOWED = ['state', 'queue', 'toggle', 'next', 'prev', 'seek', 'volume', 'like', 'dislike', 'shuffle', 'repeat', 'playQueue', 'play', 'browse', 'search', 'lyrics'];
let ws = null;
let connecting = false;
let trusted = false;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const rnd = () => b64(crypto.getRandomValues(new Uint8Array(24)));
let hmacKey = null;
async function sign(text) {
  if (!hmacKey) {
    const { key } = await (await fetch(chrome.runtime.getURL('pair.json'))).json();
    const raw = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
    hmacKey = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }
  return b64(await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(text)));
}

async function musicTab() {
  const tabs = await chrome.tabs.query({ url: 'https://music.youtube.com/*' });
  if (!tabs.length) return null;
  return tabs.find((t) => t.audible) || tabs.find((t) => t.active) || tabs[0];
}

async function handle(msg) {
  if (msg.fn === 'openTab') {
    const tab = await musicTab();
    if (tab) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); return { result: 'shown' }; }
    await chrome.tabs.create({ url: 'https://music.youtube.com/' });
    return { result: 'opened' };
  }
  if (msg.fn === 'update') {
    // Bar сообщил, что файлы расширения обновились: перезагрузиться с диска
    setTimeout(() => chrome.runtime.reload(), 100);
    return { result: 'reloading' };
  }
  if (msg.fn === 'hello') {
    const tab = await musicTab();
    return { result: { version: chrome.runtime.getManifest().version, tab: !!tab } };
  }
  // состояние всех вкладок музыкальных сайтов, где что-то есть в плеере
  if (msg.fn === 'webTabs') {
    const tabs = await chrome.tabs.query({ url: WEB_SITES }).catch(() => []);
    const out = [];
    await Promise.all(tabs.map(async (t) => {
      try {
        const r = await Promise.race([chrome.tabs.sendMessage(t.id, { type: 'bar', fn: 'wstate', args: [] }), new Promise((res) => setTimeout(() => res(null), 1500))]);
        if (r && r.result && (r.result.title || r.result.playing)) out.push({ tabId: t.id, audible: !!t.audible, ...r.result });
      } catch {}
    }));
    return { result: out };
  }
  // команда конкретной вкладке сайта: args = [tabId, ...]
  if (WEB_FNS.includes(msg.fn)) {
    const [tabId, ...rest] = msg.args || [];
    const t = await chrome.tabs.get(+tabId).catch(() => null);
    if (!t || !WEB_HOST.test(t.url || '')) return { error: 'no-tab' };
    try { return await chrome.tabs.sendMessage(t.id, { type: 'bar', fn: msg.fn, args: rest }); } catch { return { error: 'tab-not-ready' }; }
  }
  if (msg.fn === 'webOpen') {
    const t = await chrome.tabs.get(+(msg.args || [])[0]).catch(() => null);
    if (!t) return { error: 'no-tab' };
    await chrome.tabs.update(t.id, { active: true }); await chrome.windows.update(t.windowId, { focused: true });
    return { result: true };
  }
  if (!ALLOWED.includes(msg.fn)) return { error: 'not allowed' };
  const tab = await musicTab();
  if (!tab) return { error: 'no-tab' };
  keepAwake(tab);
  const ask = (id, ms) => Promise.race([
    chrome.tabs.sendMessage(id, { type: 'bar', fn: msg.fn, args: msg.args || [] }).catch(() => ({ error: 'tab-not-ready' })),
    new Promise((res) => setTimeout(() => res({ error: 'tab-asleep' }), ms)),
  ]);
  // опрос состояния — быстро и без побочных действий: уснувшую вкладку не трогаем
  if (msg.fn === 'state' || msg.fn === 'queue' || msg.fn === 'lyrics') return tab.discarded ? { error: 'tab-asleep' } : ask(tab.id, 3500);
  if (!tab.discarded) {
    const r = await ask(tab.id, 3500);
    if (!r || r.error !== 'tab-asleep' && r.error !== 'tab-not-ready') return r;
  }
  // Браузер усыпил вкладку (спящие вкладки Edge / экономия памяти Chrome) — код страницы не выполняется.
  // Нажали кнопку в Bar: будим вкладку (перезагрузка без переключения на неё; YouTube Music вспомнит трек и очередь) и повторяем команду.
  return wakeAndRetry(tab.id, ask);
}

// не давать браузеру выгружать вкладку музыки, пока она открыта (её ждёт нотч)
function keepAwake(tab) {
  if (tab && tab.autoDiscardable !== false) chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
}
let waking = null;
async function wakeAndRetry(tabId, ask) {
  if (!waking) {
    waking = (async () => {
      await chrome.tabs.reload(tabId).catch(() => {});
      // ждём, пока страница загрузится и код расширения в ней оживёт
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const t = await chrome.tabs.get(tabId).catch(() => null);
        if (!t) return false;
        if (t.status === 'complete') {
          const ping = await Promise.race([chrome.tabs.sendMessage(tabId, { type: 'bar', fn: 'state', args: [] }).catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]);
          if (ping && !ping.error) return true;
        }
      }
      return false;
    })().finally(() => setTimeout(() => { waking = null; }, 0));
  }
  if (!(await waking)) return { error: 'tab-not-ready' };
  // плеер появляется чуть позже страницы — несколько попыток
  for (let i = 0; i < 6; i++) {
    const r = await ask(tabId, 3000);
    if (r && !r.error) return r;
    await new Promise((res) => setTimeout(res, 700));
  }
  return { error: 'tab-not-ready' };
}

async function connect() {
  if (connecting || (ws && ws.readyState <= 1)) return;
  connecting = true;
  for (const port of PORTS) {
    const ok = await new Promise((resolve) => {
      let s;
      try { s = new WebSocket(`ws://127.0.0.1:${port}/bar-ext`); } catch { resolve(false); return; }
      const t = setTimeout(() => { try { s.close(); } catch {} resolve(false); }, 1500);
      s.onopen = () => { clearTimeout(t); ws = s; resolve(true); };
      s.onerror = () => { clearTimeout(t); resolve(false); };
    });
    if (ok) break;
  }
  connecting = false;
  if (!ws || ws.readyState !== 1) return;
  trusted = false;
  const myNonce = rnd();
  ws.send(JSON.stringify({ hello: myNonce }));
  ws.onmessage = async (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (!trusted) {
      // Bar должен подписать наше случайное число — иначе это не Bar, разрываем связь
      if (!msg.auth || msg.auth !== await sign('bar:' + myNonce) || !msg.nonce) { try { ws.close(); } catch {} return; }
      trusted = true;
      ws.send(JSON.stringify({ auth: await sign('ext:' + msg.nonce) }));
      return;
    }
    const r = await handle(msg);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ id: msg.id, ...r }));
  };
  ws.onclose = () => { ws = null; trusted = false; setTimeout(connect, 3000); };
}

// раз в 30 секунд: если Bar запустили позже браузера — подключиться
chrome.alarms.create('bar-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { connect(); chrome.tabs.query({ url: 'https://music.youtube.com/*' }).then((ts) => ts.forEach(keepAwake)).catch(() => {}); });
// новая вкладка YouTube Music — сразу просим браузер её не усыплять
chrome.tabs.onUpdated.addListener((id, info, t) => { if (info.status === 'complete' && /^https:\/\/music\.youtube\.com\//.test(t.url || '')) keepAwake(t); });
chrome.runtime.onStartup.addListener(connect);
// после установки/обновления — вставить свежий код в уже открытые вкладки YouTube Music (без перезагрузки, музыка не прерывается)
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://music.youtube.com/*' });
  for (const t of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['page.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['bridge.js'] });
    } catch {}
  }
  // уже открытые музыкальные сайты: кнопки сайта перехватятся после перезагрузки вкладки, но пауза,
  // позиция и громкость через аудиоэлемент заработают сразу
  for (const t of await chrome.tabs.query({ url: WEB_SITES }).catch(() => [])) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['web.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['bridge.js'] });
    } catch {}
  }
  connect();
});
connect();
