'use strict';
// Project-wide search & replace. Uses ripgrep when available (fast, honours .gitignore),
// otherwise a built-in walker.
const { spawn } = require('child_process');
const fsp = require('fs').promises;
const path = require('path');
const { abs, which, walk, isBinary } = require('../util');

const MAX_RESULTS = 5000;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildRegex({ query, regex, caseSensitive, wholeWord }) {
  let src = regex ? query : escapeRe(query);
  if (wholeWord) src = `\\b(?:${src})\\b`;
  return new RegExp(src, caseSensitive ? 'g' : 'gi');
}

function globToRe(glob) {
  const g = glob.trim();
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else if (c === ',') re += '|';
    else re += escapeRe(c);
  }
  return new RegExp(g.includes('/') ? `^(?:${re})$` : `(^|/)(?:${re})$`);
}

module.exports = (core) => {
  const active = new Map();

  function rgSearch(opts, root) {
    return new Promise((resolve, reject) => {
      const args = ['--json', '--max-filesize', '4M', '--max-columns', '400', '--max-columns-preview'];
      if (!opts.caseSensitive) args.push('-i');
      if (!opts.regex) args.push('-F');
      if (opts.wholeWord) args.push('-w');
      if (opts.hidden) args.push('--hidden', '-g', '!.git');
      for (const g of (opts.include || '').split(',').map((s) => s.trim()).filter(Boolean)) args.push('-g', g);
      for (const g of (opts.exclude || '').split(',').map((s) => s.trim()).filter(Boolean)) args.push('-g', '!' + g);
      args.push('--', opts.query, root);
      const child = spawn(which('rg'), args, { cwd: root });
      active.set(opts.searchId, child);
      const results = []; let buf = ''; let truncated = false; let err = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type !== 'match') continue;
          const d2 = msg.data;
          const text = (d2.lines.text || '').replace(/\r?\n$/, '');
          results.push({
            file: d2.path.text, line: d2.line_number,
            text: text.slice(0, 400),
            ranges: d2.submatches.map((s) => [Buffer.from(text).subarray(0, s.start).toString().length, Buffer.from(text).subarray(0, s.end).toString().length])
          });
          if (results.length >= MAX_RESULTS) { truncated = true; child.kill(); break; }
        }
      });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => {
        active.delete(opts.searchId);
        if (code === 2 && !results.length && err) return reject(new Error(err.trim().split('\n')[0]));
        resolve({ results, truncated });
      });
      child.on('error', reject);
    });
  }

  async function jsSearch(opts, root) {
    const re = buildRegex(opts);
    const inc = (opts.include || '').split(',').map((s) => s.trim()).filter(Boolean).map(globToRe);
    const exc = (opts.exclude || '').split(',').map((s) => s.trim()).filter(Boolean).map(globToRe);
    const files = await walk(root, { maxFiles: 50000 });
    const results = []; let truncated = false;
    for (const f of files) {
      const rel = path.relative(root, f).split(path.sep).join('/');
      if (inc.length && !inc.some((r) => r.test(rel))) continue;
      if (exc.some((r) => r.test(rel))) continue;
      let buf;
      try { const st = await fsp.stat(f); if (st.size > 4 * 1024 * 1024) continue; buf = await fsp.readFile(f); } catch { continue; }
      if (isBinary(buf)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        const ranges = []; let m;
        while ((m = re.exec(lines[i])) !== null) { ranges.push([m.index, m.index + m[0].length]); if (m[0].length === 0) re.lastIndex++; if (ranges.length > 50) break; }
        if (ranges.length) {
          results.push({ file: f, line: i + 1, text: lines[i].slice(0, 400), ranges });
          if (results.length >= MAX_RESULTS) { truncated = true; break; }
        }
      }
      if (truncated) break;
    }
    return { results, truncated };
  }

  return {
    'search:run': async (opts = {}) => {
      if (typeof opts.query !== 'string' || !opts.query) return { results: [], truncated: false, engine: null };
      if (opts.regex) { try { new RegExp(opts.query); } catch (e) { throw new Error('Invalid regex: ' + e.message); } }
      const root = abs(opts.root);
      const t0 = Date.now();
      const useRg = !!which('rg') && opts.engine !== 'builtin';
      const r = useRg ? await rgSearch(opts, root) : await jsSearch(opts, root);
      for (const x of r.results) if (!path.isAbsolute(x.file)) x.file = path.join(root, x.file);
      return { ...r, engine: useRg ? 'ripgrep' : 'builtin', ms: Date.now() - t0 };
    },
    'search:cancel': async (id) => { const c = active.get(id); if (c) c.kill(); return !!c; },
    'search:replace': async (opts = {}) => {
      if (!Array.isArray(opts.files) || !opts.files.length) throw new Error('No files');
      if (typeof opts.replacement !== 'string') throw new Error('replacement required');
      const re = buildRegex(opts);
      let total = 0; let changed = 0;
      for (const f of opts.files) {
        const file = abs(f);
        await core.withFileLock(file, async () => {
          const txt = await fsp.readFile(file, 'utf8');
          let count = 0;
          const out = txt.replace(re, (...m) => { count++; return opts.regex ? m[0].replace(new RegExp(re.source, re.flags.replace('g', '')), opts.replacement) : opts.replacement; });
          if (count) {
            await fsp.writeFile(file, out, 'utf8');
            total += count;
            changed++;
          }
        });
      }
      core.event('FS', `replaced ${total} occurrence(s) in ${changed} file(s)`);
      return { files: changed, replacements: total };
    }
  };
};
