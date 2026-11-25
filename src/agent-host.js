// Агент системных данных: нативный bar-agent.exe (Rust, native/agent). call('audio') → Promise.
// Протокол: на вход строки «id команда аргумент», на выход по строке JSON {"id","ok","data"}.
// Запуск ленивый, перезапуск при падении (с паузой, если падает раз за разом), у каждого вызова свой таймаут.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// в установленном Bar — resources/native; в разработке — сборка native/target/release (bash native/build.sh)
const NATIVE = [
  process.resourcesPath && path.join(process.resourcesPath, 'native', 'bar-agent.exe'),
  path.join(__dirname, '..', 'native', 'target', 'release', 'bar-agent.exe'),
].find((p) => p && !/app\.asar/.test(p) && fs.existsSync(p)) || null;

class Agent {
  constructor(name) {
    this.name = name;
    this.p = null;
    this.buf = '';
    this.seq = 0;
    this.pending = new Map();
    this.ready = null;
    this.crashes = [];   // времена падений: часто падает — пауза перед перезапуском
  }

  start() {
    if (this.p && this.p.exitCode === null) return this.ready;
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < 60e3);
    if (!NATIVE || this.crashes.length >= 5) return Promise.resolve(false);
    const p = spawn(NATIVE, [], { windowsHide: true, env: { ...process.env, BAR_PID: String(process.pid) } }); // BAR_PID — чтобы не путать окна Bar с окном, где печатают
    this.p = p; this.buf = '';
    p.stdout.setEncoding('utf8');
    let onReady;
    this.ready = new Promise((r) => { onReady = r; setTimeout(() => r(false), 3000); });
    p.stdout.on('data', (d) => this.onData(d, onReady));
    p.stderr.on('data', () => {});
    p.on('exit', () => {
      if (this.p !== p) return;
      for (const [, x] of this.pending) { clearTimeout(x.t); x.reject(new Error('agent exited')); }
      this.pending.clear(); this.p = null; onReady(false);
      if (!this.stopped) this.crashes.push(Date.now());
    });
    p.on('error', () => { if (this.p === p) this.p = null; onReady(false); });
    return this.ready;
  }

  onData(d, onReady) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (Number(o.id) === 0) { onReady(true); continue; }
      const x = this.pending.get(Number(o.id));
      if (!x) continue;
      this.pending.delete(Number(o.id));
      clearTimeout(x.t);
      if (o.ok) x.resolve(o.data); else x.reject(new Error(String(o.data)));
    }
  }

  async call(cmd, arg = '', timeout = 15000) {
    this.stopped = false;
    if (!(await this.start()) || !this.p) throw new Error('agent unavailable');
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout: ${cmd}`)); }, timeout);
      this.pending.set(id, { resolve, reject, t });
      this.p.stdin.write(`${id} ${cmd} ${String(arg).replace(/[\r\n]/g, ' ')}\n`);
    });
  }

  stop() { this.stopped = true; if (this.p) try { this.p.kill(); } catch {} this.p = null; }
}

// список из ответа агента (null → [])
Agent.list = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// отдельный фоновый процесс того же агента: meter — уровень звука, winevents — события окон
Agent.spawnHelper = (mode) => {
  if (!NATIVE) return null;
  return spawn(NATIVE, [mode], { windowsHide: true });
};

module.exports = Agent;
