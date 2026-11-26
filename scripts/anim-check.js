// Автопроверка анимаций нотча на тестовой сборке (не трогает ваш Bar и мышь):
//   1) bash tauri/build.sh
//   2) запустить native/target/release/bar-tauri.exe с WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
//   3) node scripts/anim-check.js [сценарий...]   (без аргументов — все)
// Каждый кадр страница записывает размер, края и прозрачность нотча; скрипт ищет долгие кадры, скачки
// (шаг резко больше соседних), «РАЗВОРОТ» края (движение туда-обратно) и мигание прозрачности.
// Ожидаемые развороты: один у ширины при открытии (пружина) и верх у «всплывашки» в спрятанном режиме.
const WebSocket = require('ws');
const PORT = process.env.CDP_PORT || 9333;
async function page(match) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const t = list.find((x) => x.type === 'page' && (match === 'main' ? /localhost\/(index\.html)?$/.test(x.url) : x.url.includes(match)));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise((r) => ws.on('open', r));
  const ev = async (expression) => { const r = await new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
  return { ev, close: () => ws.close() };
}
const REC = `(() => { if (window.__rec && window.__rec.v === 2) return 'have';
  window.__rec = { v: 2, on: false, f: [], start() { this.f = []; this.on = true; const loop = (t) => { if (!this.on) return;
      const cs = getComputedStyle(island), c = document.querySelector('.content'), b = document.querySelector('.bar');
      this.f.push({ t, w: parseFloat(cs.width), h: parseFloat(cs.height), r: cs.borderBottomLeftRadius, co: c ? +getComputedStyle(c).opacity : 1, bo: b ? +getComputedStyle(b).opacity : 1, ox: island.getBoundingClientRect().left, top: island.getBoundingClientRect().top, bot: island.getBoundingClientRect().bottom });
      requestAnimationFrame(loop); }; requestAnimationFrame(loop); },
    stop() { this.on = false; return this.f; } };
  const lt = []; window.__lt = lt; try { new PerformanceObserver((l) => l.getEntries().forEach((e) => lt.push({ s: e.startTime, d: e.duration }))).observe({ type: 'longtask', buffered: false }); } catch {}
  return 'ok'; })()`;
function analyse(name, f, lt) {
  const out = [];
  if (f.length < 5) return [name + ': мало кадров ' + f.length];
  const dts = f.slice(1).map((x, i) => x.t - f[i].t);
  const long = dts.map((d, i) => [d, i]).filter(([d]) => d > 24);
  const dur = f[f.length - 1].t - f[0].t;
  for (const key of ['w', 'h', 'top', 'bot']) {
    const v = f.map((x) => x[key]); const d = v.slice(1).map((x, i) => x - v[i]);
    // разворот: движение сменило знак, кроме лёгкого «перелёта» пружины в конце (< 6 px)
    let flips = 0; let last = 0;
    for (let i = 0; i < d.length; i++) { if (Math.abs(d[i]) < 0.3) continue; const s = Math.sign(d[i]); if (last && s !== last) flips++; last = s; }
    // скачок: шаг больше 2.5× среднего соседей и > 12 px
    const jumps = []; for (let i = 1; i < d.length - 1; i++) { const a = Math.abs(d[i]), nb = (Math.abs(d[i - 1]) + Math.abs(d[i + 1])) / 2; if (a > 12 && a > nb * 2.5 + 4) jumps.push(`${key}@${Math.round(f[i + 1].t - f[0].t)}мс ${d[i].toFixed(0)}px`); }
    const range = Math.max(...v) - Math.min(...v);
    if (range > 2 && (flips > (key === 'top' ? 0 : 1) || jumps.length || key === 'w' || key === 'h')) out.push(`${flips > (key === 'w' || key === 'h' ? 1 : 0) ? 'РАЗВОРОТ ' : ''}${key}: ${v[0].toFixed(0)}→${v[v.length - 1].toFixed(0)} (мин ${Math.min(...v).toFixed(0)}, макс ${Math.max(...v).toFixed(0)}), разворотов ${flips}${jumps.length ? ', СКАЧКИ ' + jumps.join(' ') : ''}`);
  }
  for (const key of ['co', 'bo']) { const v = f.map((x) => x[key]); let blinks = 0; for (let i = 1; i < v.length - 1; i++) if ((v[i] < v[i - 1] - 0.05 && v[i + 1] > v[i] + 0.05) || (v[i] > v[i - 1] + 0.05 && v[i + 1] < v[i] - 0.05)) blinks++; if (blinks) out.push(`${key === 'co' ? 'содержимое' : 'шапка'}: мигание ${blinks}`); }
  const ox = f.map((x) => x.ox); const sh = Math.max(...ox.map((x, i) => i ? Math.abs(x - ox[i - 1] - 0) : 0));
  out.unshift(`${name}: ${dur.toFixed(0)} мс, кадров ${f.length}, средний ${(dur / (f.length - 1)).toFixed(1)} мс, долгих ${long.length}${long.length ? ' [' + long.slice(0, 8).map(([d, i]) => Math.round(f[i].t - f[0].t) + 'мс:' + d.toFixed(0)).join(' ') + ']' : ''}${lt.length ? ', длинных задач ' + lt.length + ' (' + lt.map((x) => x.d.toFixed(0)).join(',') + ' мс)' : ''}`);
  return out;
}
const SC = {
  // имя: [подготовка, действие, сколько записывать мс]
  open: ["collapse(true); goHome(); srchClear()", "expand()", 900],
  close: ["expand()", "collapse(true)", 900],
  searchOpen: ["collapse(true)", "growWin().then(() => { expand(); requestAnimationFrame(() => srchFocus(true)); })", 900],
  searchBlurClose: ["growWin().then(() => { expand(); requestAnimationFrame(() => srchFocus(true)); })", "dispatchEvent(new Event('blur'))", 1100],
  searchTypedClose: ["growWin().then(() => { expand(); srchFocus(true); srchInput.value='te'; srchSet('te'); })", "dispatchEvent(new Event('blur'))", 1100],
  searchType: ["growWin().then(() => { expand(); srchFocus(true); srchClear(); })", "srchInput.value='note'; srchSet('note')", 900],
  searchClear: ["growWin().then(() => { expand(); srchFocus(true); srchInput.value='note'; srchSet('note'); })", "srchClear()", 900],
  toolOpen: ["expand(); goHome()", "openTool('settings')", 900],
  toolBack: ["expand(); openTool('settings')", "goHome()", 900],
  toolClose: ["expand(); openTool('settings')", "collapse(true)", 1100],
  musicOpen: ["expand(); goHome()", "openTool('music')", 900],
  musicClose: ["expand(); openTool('music')", "collapse(true)", 1100],
  peek: ["collapse(true)", "hoverIn()", 700],
  unpeek: ["collapse(true); island.classList.add('peek')", "island.classList.remove('peek')", 700],
  tuckOpen: ["collapse(true); island.classList.add('tucked')", "expand()", 900],
  tuckClose: ["island.classList.add('tucked'); expand()", "collapse(true)", 1300],
  tuckSearchClose: ["island.classList.add('tucked'); growWin().then(() => { expand(); srchFocus(true); })", "dispatchEvent(new Event('blur'))", 1300],
  tuckPeek: ["collapse(true); island.classList.add('tucked')", "island.classList.add('peek')", 900],
  tuckUnpeek: ["collapse(true); island.classList.add('tucked'); island.classList.add('peek')", "island.classList.remove('peek')", 900],
  tuckFlash: ["collapse(true); island.classList.add('tucked')", "flash('Громкость 40%', 900)", 1700],
  flash: ["collapse(true); island.classList.remove('tucked')", "flash('Громкость 40%', 900)", 1700],
  idleAfterClose: ["expand()", "collapse(true); setTimeout(() => { island.classList.add('idle'); }, 120)", 1300],
  idleBack: ["collapse(true); island.classList.add('idle')", "island.classList.remove('idle')", 900],
};
(async () => {
  const p = await page('main');
  await p.ev(REC);
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SC);
  for (const n of names) {
    const [prep, act, ms] = SC[n];
    await p.ev(`pinned=false; island.classList.remove('tucked','idle','peek'); ${prep}; new Promise(r=>setTimeout(r,1300))`);
    const res = await p.ev(`(async()=>{ __lt.length=0; __rec.start(); await new Promise(r=>requestAnimationFrame(r)); ${act}; await new Promise(r=>setTimeout(r,${ms})); return { f: __rec.stop(), lt: __lt.slice() }; })()`);
    console.log(analyse(n, res.f, res.lt).join('\n   '));
    if (process.env.DUMP === n) console.log(JSON.stringify(res.f.map((x) => [Math.round(x.t - res.f[0].t), x.w, x.h, x.co.toFixed(2), x.bo.toFixed(2)])));
  }
  await p.ev("island.classList.remove('tucked','idle','peek'); collapse(true); goHome(); srchClear(); typeof tuckApply==='function'&&tuckApply(); 'ok'");
  p.close(); process.exit(0);
})().catch((e) => { console.log('ошибка', e.message); process.exit(1); });
