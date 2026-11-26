'use strict';
// Real shell sessions. Prefers node-pty (true PTY with resize). If the native module
// is unavailable it falls back to the system `script` utility, which still allocates a
// real pseudo-terminal on Linux/macOS (no resize), or plain pipes on Windows.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { which, run } = require('../util');

let ptyLib = null;
let ptyError = null;
try { ptyLib = require('node-pty'); } catch (e) { ptyError = e.message; }

function defaultShell() {
  if (process.platform === 'win32') return which('pwsh') || which('powershell') || process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || (fs.existsSync('/bin/zsh') && process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

module.exports = (core) => {
  const sessions = new Map();
  let nextId = 1;
  if (!ptyLib) core.log('warn', `node-pty unavailable (${ptyError}); using fallback PTY bridge`, 'PTY');

  function push(s, data) {
    s.buf += data;
    if (s.buf.length > 65536) return flush(s);
    if (!s.timer) s.timer = setTimeout(() => flush(s), 8);
  }
  function flush(s) {
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    if (!s.buf) return;
    const data = s.buf; s.buf = '';
    core.emit('pty:data', { id: s.id, data });
  }
  function onExit(s, code) {
    if (s.exited) return;
    s.exited = true;
    flush(s);
    sessions.delete(s.id);
    core.emit('pty:exit', { id: s.id, code });
    core.event('PTY', `session #${s.id} (${path.basename(s.file)}) exited with ${code}`);
  }

  core.onShutdown(() => { for (const s of sessions.values()) { try { s.kill(); } catch { /* gone */ } } });

  return {
    'pty:info': async () => ({ native: !!ptyLib, error: ptyError, defaultShell: defaultShell() }),

    'pty:spawn': async (opts = {}) => {
      let cwd = typeof opts.cwd === 'string' && opts.cwd ? opts.cwd : os.homedir();
      try { if (!fs.statSync(cwd).isDirectory()) cwd = os.homedir(); } catch { cwd = os.homedir(); }
      const file = typeof opts.shell === 'string' && opts.shell ? opts.shell : defaultShell();
      const args = Array.isArray(opts.args) ? opts.args.map(String) : [];
      const cols = Math.max(2, Math.min(1000, opts.cols | 0 || 80));
      const rows = Math.max(1, Math.min(500, opts.rows | 0 || 24));
      const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'PHANTOM' };
      if (opts.env && typeof opts.env === 'object') for (const [k, v] of Object.entries(opts.env)) if (ENV_KEY.test(k)) env[k] = String(v);
      if (Array.isArray(opts.unsetEnv)) {
        for (const name of opts.unsetEnv) {
          if (typeof name !== 'string' || !ENV_KEY.test(name)) continue;
          for (const key of Object.keys(env)) {
            if (key.toUpperCase() === name.toUpperCase()) delete env[key];
          }
        }
      }
      delete env.ELECTRON_RUN_AS_NODE;

      const id = nextId++;
      const s = { id, file, cwd, buf: '', timer: null, exited: false, kind: 'pty' };

      if (ptyLib) {
        const p = ptyLib.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
        s.proc = p; s.pid = p.pid;
        p.onData((d) => push(s, d));
        p.onExit(({ exitCode }) => onExit(s, exitCode));
        s.write = (d) => p.write(d);
        s.resize = (c, r) => p.resize(c, r);
        s.kill = () => p.kill();
      } else {
        let child;
        env.COLUMNS = String(cols); env.LINES = String(rows);
        if (process.platform === 'linux' && which('script')) {
          const cmd = `stty cols ${cols} rows ${rows} 2>/dev/null; exec ${[file, ...args].map(shq).join(' ')}`;
          child = spawn('script', ['-qfec', cmd, '/dev/null'], { cwd, env });
          s.kind = 'script';
        } else if (process.platform === 'darwin' && which('script')) {
          child = spawn('script', ['-q', '/dev/null', file, ...args], { cwd, env });
          s.kind = 'script';
        } else {
          child = spawn(file, args, { cwd, env, windowsHide: true });
          s.kind = 'pipe';
        }
        s.proc = child; s.pid = child.pid;
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', (d) => push(s, d));
        child.stderr.on('data', (d) => push(s, d));
        child.on('exit', (code) => onExit(s, code == null ? -1 : code));
        child.on('error', (e) => { push(s, `\r\n[phantom] failed to start ${file}: ${e.message}\r\n`); onExit(s, -1); });
        s.write = (d) => child.stdin.writable && child.stdin.write(s.kind === 'pipe' ? d.replace(/\r/g, '\r\n') : d);
        s.resize = () => {};
        s.kill = () => { try { child.kill('SIGHUP'); } catch { /* gone */ } };
      }
      sessions.set(id, s);
      core.event('PTY', `session #${id} started: ${path.basename(file)} ${args.join(' ')} (pid ${s.pid}, ${s.kind})`);
      return { id, pid: s.pid, shell: file, kind: s.kind, cwd };
    },

    'pty:write': async (id, data) => {
      const s = sessions.get(id);
      if (!s || typeof data !== 'string') return false;
      s.write(data);
      return true;
    },
    'pty:resize': async (id, cols, rows) => {
      const s = sessions.get(id);
      if (!s) return false;
      try { s.resize(Math.max(2, cols | 0), Math.max(1, rows | 0)); } catch { /* exited */ }
      return true;
    },
    'pty:kill': async (id) => { const s = sessions.get(id); if (s) s.kill(); return !!s; },
    'pty:cwd': async (id) => {
      const s = sessions.get(id);
      if (!s) return null;
      if (process.platform === 'linux') {
        // For the script fallback the shell is a child of `script`.
        let pid = s.pid;
        if (s.kind === 'script') {
          try { const kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/); if (kids[0]) pid = kids[0]; } catch { /* ignore */ }
        }
        try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return s.cwd; }
      }
      if (process.platform === 'darwin' && which('lsof')) {
        const r = await run('lsof', ['-a', '-d', 'cwd', '-p', String(s.pid), '-Fn'], { timeout: 2000 });
        const line = r.stdout.split('\n').find((l) => l.startsWith('n'));
        return line ? line.slice(1) : s.cwd;
      }
      return s.cwd;
    },
    'pty:list': async () => [...sessions.values()].map((s) => ({ id: s.id, pid: s.pid, shell: s.file, kind: s.kind }))
  };
};
