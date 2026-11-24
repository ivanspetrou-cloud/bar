// Собирает расширение «Bar — YouTube Music» в папку outDir:
//  • копирует файлы расширения (manifest.json, sw.js, bridge.js), если outDir — не сама папка-шаблон;
//  • page.js — из src/music-page.js + приёмник запросов (только фиксированный список действий);
//  • pair.json — секретный ключ пары Bar ↔ расширение (создаётся один раз на каждом компьютере,
//    в репозиторий и установщик НЕ попадает).
// В разработке outDir = папка extension/ проекта; в установленном Bar — папка данных пользователя.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const TEMPLATE = ['manifest.json', 'sw.js', 'bridge.js'];

function build(outDir, templateDir) {
  outDir = outDir || path.join(root, 'extension');
  templateDir = templateDir || path.join(root, 'extension');
  fs.mkdirSync(outDir, { recursive: true });
  if (path.resolve(outDir) !== path.resolve(templateDir)) {
    for (const f of TEMPLATE) fs.copyFileSync(path.join(templateDir, f), path.join(outDir, f));
  }

  const core = fs.readFileSync(path.join(root, 'src', 'music-page.js'), 'utf8');
  const listener = `
// ---- приёмник запросов расширения Bar (только фиксированный список действий) ----
(() => {
  // список разрешённых действий обновляется при каждом обновлении скрипта, а приёмник ставится один раз
  window.__barAllowed = ['state', 'queue', 'toggle', 'next', 'prev', 'seek', 'volume', 'like', 'dislike', 'shuffle', 'repeat', 'playQueue', 'play', 'browse', 'search', 'lyrics'];
  if (window.__barListen) return;
  window.__barListen = true;
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.__barReq !== true) return;
    const { id, fn, args } = e.data;
    let result, error;
    try {
      if (!(window.__barAllowed || []).includes(fn) || !window.__bar || typeof window.__bar[fn] !== 'function') throw new Error('not allowed');
      result = await window.__bar[fn](...(Array.isArray(args) ? args : []));
    } catch (err) { error = String(err && err.message || err); }
    window.postMessage({ __barRes: true, id, result, error }, location.origin);
  });
})();
`;
  fs.writeFileSync(path.join(outDir, 'page.js'), '// Собрано из src/music-page.js — не редактируйте вручную (scripts/build-ext.js)\n' + core + '\n' + listener);

  // секретный ключ пары: по нему Bar и расширение проверяют друг друга (HMAC), сам ключ по сети не передаётся
  const pairFile = path.join(outDir, 'pair.json');
  let key = null;
  try { key = JSON.parse(fs.readFileSync(pairFile, 'utf8')).key; } catch {}
  if (!key || key.length < 40) {
    key = crypto.randomBytes(32).toString('base64');
    fs.writeFileSync(pairFile, JSON.stringify({ key }));
  }
  return { key, dir: outDir };
}

module.exports = build;
if (require.main === module) { build(); console.log('extension собран'); }
