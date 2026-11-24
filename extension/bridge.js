// Изолированная часть расширения на странице music.youtube.com.
// Передаёт запросы от фонового скрипта в код страницы (page.js) и возвращает ответы.
const pending = new Map();
let seq = 0;

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.__barRes !== true) return;
  const cb = pending.get(e.data.id);
  if (!cb) return;
  pending.delete(e.data.id);
  cb({ result: e.data.result, error: e.data.error });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'bar') return false;
  const id = 'r' + (++seq) + '_' + Date.now();
  const t = setTimeout(() => { pending.delete(id); sendResponse({ error: 'timeout' }); }, 15000);
  pending.set(id, (r) => { clearTimeout(t); sendResponse(r); });
  window.postMessage({ __barReq: true, id, fn: msg.fn, args: msg.args || [] }, location.origin);
  return true; // ответ придёт асинхронно
});
