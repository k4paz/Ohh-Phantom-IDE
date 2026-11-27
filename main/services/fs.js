'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { abs, walk, isBinary } = require('../util');

const MAX_READ = 25 * 1024 * 1024;

module.exports = (core) => ({
  'fs:home': async () => ({ home: os.homedir(), cwd: process.cwd(), sep: path.sep, platform: process.platform }),

  'fs:list': async (dir) => {
    dir = abs(dir);
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    const out = await Promise.all(ents.map(async (e) => {
      const p = path.join(dir, e.name);
      let st = null;
      try { st = await fsp.stat(p); } catch { /* broken link */ }
      return {
        name: e.name, path: p,
        dir: st ? st.isDirectory() : e.isDirectory(),
        link: e.isSymbolicLink(),
        size: st ? st.size : 0,
        mtime: st ? st.mtimeMs : 0,
        mode: st ? st.mode : 0
      };
    }));
    out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return out;
  },

  'fs:read': async (p) => {
    p = abs(p);
    const st = await fsp.stat(p);
    if (st.isDirectory()) throw new Error('Is a directory');
    if (st.size > MAX_READ) throw new Error(`File too large to open (${(st.size / 1048576).toFixed(1)} MB)`);
    const buf = await fsp.readFile(p);
    if (isBinary(buf)) return { binary: true, size: st.size, mtime: st.mtimeMs };
    return { content: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs, eol: buf.includes('\r\n') ? 'CRLF' : 'LF' };
  },

  'fs:write': async (p, content) => {
    p = abs(p);
    if (typeof content !== 'string') throw new Error('content must be a string');
    return core.withFileLock(p, async () => {
      let mode = null;
      try { mode = (await fsp.stat(p)).mode; } catch { /* new file */ }
      // Write-then-rename keeps the original intact if the write fails midway.
      const tmp = path.join(path.dirname(p), `.${path.basename(p)}.phantom-${process.pid}-${Date.now()}`);
      await fsp.writeFile(tmp, content, 'utf8');
      if (mode !== null) await fsp.chmod(tmp, mode).catch(() => {});
      try { await fsp.rename(tmp, p); }
      catch (e) { await fsp.writeFile(p, content, 'utf8'); await fsp.unlink(tmp).catch(() => {}); if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e; }
      const st = await fsp.stat(p);
      return { mtime: st.mtimeMs, size: st.size };
    });
  },

  'fs:stat': async (p) => {
    p = abs(p);
    const st = await fsp.stat(p);
    return { path: p, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, mode: st.mode };
  },

  'fs:exists': async (p) => { try { await fsp.access(abs(p)); return true; } catch { return false; } },

  'fs:mkdir': async (p) => {
    p = abs(p);
    return core.withFileLock(p, async () => { await fsp.mkdir(p, { recursive: true }); return p; });
  },

  'fs:createFile': async (p, content = '') => {
    p = abs(p);
    return core.withFileLock(p, async () => {
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, String(content), { flag: 'wx' });
      return p;
    });
  },

  'fs:rename': async (from, to) => {
    from = abs(from); to = abs(to);
    return core.withFileLocks([from, to], async () => {
      try { await fsp.lstat(to); throw new Error('Target already exists'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fsp.rename(from, to);
      return to;
    });
  },

  'fs:copy': async (from, to) => {
    from = abs(from); to = abs(to);
    return core.withFileLocks([from, to], async () => {
      await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false });
      return to;
    });
  },

  'fs:trash': async (p) => {
    p = abs(p);
    if (p === path.parse(p).root || p === os.homedir()) throw new Error('Refusing to trash this location');
    if (core.hooks.trash) {
      return core.withFileLock(p, async () => { await core.hooks.trash(p); return true; });
    }
    throw new Error('System trash unavailable in this runtime');
  },

  'fs:walk': async (root, max = 30000) => {
    root = abs(root);
    const files = await walk(root, { maxFiles: Math.min(Number(max) || 30000, 100000) });
    return files.map((f) => path.relative(root, f));
  },

  'fs:pickFolder': async (title) => {
    if (!core.hooks.pickFolder) throw new Error('NO_DIALOG');
    return core.hooks.pickFolder(title);
  },
  'fs:pickFile': async (title, filters) => {
    if (!core.hooks.pickFile) throw new Error('NO_DIALOG');
    return core.hooks.pickFile(title, filters);
  },
  'fs:pickSave': async (title, defaultPath) => {
    if (!core.hooks.saveFile) throw new Error('NO_DIALOG');
    return core.hooks.saveFile(title, defaultPath);
  },
  'fs:reveal': async (p) => { if (core.hooks.reveal) core.hooks.reveal(abs(p)); return true; },
  'fs:openNative': async (p) => { if (!core.hooks.openPath) throw new Error('Not available'); return core.hooks.openPath(abs(p)); }
});
