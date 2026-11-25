// Агент системных данных: call('audio') → Promise. Сначала нативный bar-agent.exe (Rust, native/agent) — он умеет все команды;
// без него — прежний постоянный PowerShell-процесс (src/agent.ps1). Запуск ленивый, перезапуск при падении, у вызова свой таймаут.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Нативный агент на Rust (native/agent): те же команды быстрее и без процесса PowerShell (~80 МБ памяти).
// Он сам сообщает, какие команды умеет; остальные — в PowerShell. Нет файла или упал — всё через PowerShell.
const NATIVE = [
  process.resourcesPath && path.join(process.resourcesPath, 'native', 'bar-agent.exe'),
  path.join(__dirname, '..', 'native', 'target', 'release', 'bar-agent.exe'),
].find((p) => p && !/app\.asar/.test(p) && fs.existsSync(p)) || null;
const NATIVE_OFF = process.env.BAR_NATIVE === '0';

class NativeAgent {
  constructor() { this.p = null; this.buf = ''; this.seq = 0; this.pending = new Map(); this.cmds = null; this.fails = 0; this.ready = null; }
  usable() { return !!NATIVE && !NATIVE_OFF && this.fails < 3; }
  start() {
    if (this.p && this.p.exitCode === null) return this.ready;
    this.cmds = null;
    this.p = spawn(NATIVE, [], { windowsHide: true, env: { ...process.env, BAR_PID: String(process.pid) } });
    this.p.stdout.setEncoding('utf8');
    let onReady;
    this.ready = new Promise((r) => { onReady = r; setTimeout(() => r(false), 3000); });
    this.p.stdout.on('data', (d) => this.onData(d, onReady));
    this.p.stderr.on('data', () => {});
    this.p.on('exit', () => {
      for (const [, x] of this.pending) x.reject(new Error('native exited'));
      this.pending.clear(); this.p = null; this.cmds = null; this.fails++; onReady(false);
    });
    this.p.on('error', () => { this.p = null; this.fails = 99; onReady(false); });
    return this.ready;
  }
  onData(d, onReady) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (Number(o.id) === 0 && Array.isArray(o.cmds)) { this.cmds = new Set(o.cmds); this.fails = 0; onReady(true); continue; }
      const x = this.pending.get(Number(o.id)); if (!x) continue;
      this.pending.delete(Number(o.id)); clearTimeout(x.t);
      if (o.ok) x.resolve(o.data); else x.reject(new Error(String(o.data)));
    }
  }
  has(cmd) { return !!(this.cmds && this.cmds.has(cmd)); }
  call(cmd, arg, timeout) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout: ${cmd}`)); }, timeout);
      this.pending.set(id, { resolve, reject, t });
      this.p.stdin.write(`${id} ${cmd} ${String(arg).replace(/[\r\n]/g, ' ')}\n`);
    });
  }
  stop() { if (this.p) try { this.p.kill(); } catch {} this.p = null; }
}

class Agent {
  constructor(name) {
    this.name = name;
    this.ps = null;
    this.buf = '';
    this.seq = 0;
    this.pending = new Map();
    this.native = new NativeAgent();
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

  async call(cmd, arg = '', timeout = 15000) {
    // сначала — нативный агент, если он эту команду умеет
    if (this.native.usable()) {
      if (!this.native.cmds) await this.native.start();
      if (this.native.has(cmd) && this.native.p) return this.native.call(cmd, arg, timeout);
    }
    return this.callPs(cmd, arg, timeout);
  }

  callPs(cmd, arg = '', timeout = 15000) {
    this.start();
    if (!this.ps) return Promise.reject(new Error('agent unavailable'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout: ${cmd}`)); }, timeout);
      this.pending.set(id, { resolve, reject, t });
      this.ps.stdin.write(`${id} ${cmd} ${String(arg).replace(/[\r\n]/g, ' ')}\n`);
    });
  }

  stop() { if (this.ps) try { this.ps.kill(); } catch {} this.ps = null; this.native.stop(); }
  // PowerShell запущен только если понадобилась команда, которой нет в нативном агенте
}

// PowerShell сворачивает массив из одного элемента в объект — возвращаем всегда массив
Agent.list = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// Отдельный фоновый процесс: нативный (bar-agent.exe <mode>: meter — уровень звука, winevents — события окон)
// или, если нативного нет, прежний PowerShell-скрипт.
Agent.spawnHelper = (mode, psScript) => {
  if (NATIVE && !NATIVE_OFF) return spawn(NATIVE, [mode], { windowsHide: true });
  const script = path.join(__dirname, psScript).replace('app.asar', 'app.asar.unpacked');
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
};

module.exports = Agent;
