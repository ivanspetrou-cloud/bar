// Общий наблюдатель за окнами Windows (winevents.ps1): один процесс на весь Bar.
// "E" — открыли, закрыли, сменили активное, свернули окно; "L" — активное окно поменяло размер или место
// (развернули на весь экран, перетащили). Подписчики получают только нужные им буквы.
const { spawn } = require('child_process');
const path = require('path');

const subs = new Set();
let ps = null, buf = '';

function start() {
  if (ps) return;
  const script = path.join(__dirname, 'winevents.ps1').replace('app.asar', 'app.asar.unpacked');
  ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      const k = line.charAt(0);
      if (k !== 'E' && k !== 'L') continue;
      for (const s of subs) if (s.kinds.includes(k)) { try { s.fn(k); } catch {} }
    }
  });
  ps.on('exit', () => { ps = null; buf = ''; if (subs.size) setTimeout(start, 3000); }); // упал — перезапуск
  ps.on('error', () => { ps = null; });
}
function stop() { if (ps) { const p = ps; ps = null; p.removeAllListeners('exit'); try { p.kill(); } catch {} } }

module.exports = {
  // подписка: kinds — строка букв ('E', 'EL'); возвращает функцию отписки
  on(kinds, fn) {
    const s = { kinds, fn };
    subs.add(s); start();
    return () => { subs.delete(s); if (!subs.size) stop(); };
  },
  stop() { subs.clear(); stop(); },
};
