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
  if (!ALLOWED.includes(msg.fn)) return { error: 'not allowed' };
  const tab = await musicTab();
  if (!tab) return { error: 'no-tab' };
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: 'bar', fn: msg.fn, args: msg.args || [] });
  } catch {
    return { error: 'tab-not-ready' };
  }
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
chrome.alarms.onAlarm.addListener(() => connect());
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
  connect();
});
connect();
