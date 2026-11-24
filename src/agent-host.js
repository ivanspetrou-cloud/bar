// Обёртка над постоянным PowerShell-процессом (src/agent.ps1): call('audio') → Promise.
// Запускается лениво, перезапускается при падении, у каждого вызова свой таймаут.
const { spawn } = require('child_process');
const path = require('path');

class Agent {
  constructor(name) {
    this.name = name;
    this.ps = null;
    this.buf = '';
    this.seq = 0;
    this.pending = new Map();
  }

  start() {
    if (this.ps && this.ps.exitCode === null) return;
    const script = path.join(__dirname, 'agent.ps1').replace('app.asar', 'app.asar.unpacked');
    this.ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, env: { ...process.env, BAR_PID: String(process.pid) } }); // BAR_PID — чтобы не путать окна Bar с окном, где печатают
    this.ps.stdout.setEncoding('utf8');
    this.ps.stdout.on('data', (d) => this.onData(d));
    this.ps.stderr.on('data', () => {});
    this.ps.on('exit', () => {
      for (const [, p] of this.pending) p.reject(new Error('agent exited'));
      this.pending.clear();
      this.ps = null;
    });
    this.ps.on('error', () => { this.ps = null; });
  }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(Number(o.id));
      if (!p) continue;
      this.pending.delete(Number(o.id));
      clearTimeout(p.t);
      if (o.ok) p.resolve(o.data); else p.reject(new Error(String(o.data)));
    }
  }

  call(cmd, arg = '', timeout = 15000) {
    this.start();
    if (!this.ps) return Promise.reject(new Error('agent unavailable'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout: ${cmd}`)); }, timeout);
      this.pending.set(id, { resolve, reject, t });
      this.ps.stdin.write(`${id} ${cmd} ${String(arg).replace(/[\r\n]/g, ' ')}\n`);
    });
  }

  stop() { if (this.ps) try { this.ps.kill(); } catch {} this.ps = null; }
}

// PowerShell сворачивает массив из одного элемента в объект — возвращаем всегда массив
Agent.list = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

module.exports = Agent;
