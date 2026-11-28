// File explorer: lazy tree, git decorations, file ops, keyboard navigation.
import { h, icon, esc, basename, dirname, join, rel, copy, debounce, ext } from '../core/dom.js';
import { call, bus } from '../core/api.js';
import { project, pickProject } from '../core/project.js';
import { menu, prompt, confirm, toast, fail } from '../core/ui.js';
import { wm } from '../core/wm.js';
import { fileGlyph } from './editor.js';
import * as live from '../core/collab.js';

const HIDE = new Set(['.git', '.DS_Store', 'node_modules']);

export default {
  id: 'explorer', title: 'Explorer', icon: 'explorer', desc: 'Project files', size: [300, 560], min: [200, 160], key: 'Ctrl+Shift+E',
  async create(win, state) {
    let root = state.root || project.root;
    const open = new Set(state.open || []);
    const cache = new Map(); // dir -> entries
    let sel = null; let filter = ''; let showHidden = !!state.hidden; let gitMap = new Map(); const offs = [];

    const filterInp = h('input.inp', { placeholder: 'filter…', style: { flex: 1 } });
    const list = h('div.tree.scroll.fill', { tabindex: 0 });
    const tb = h('div.toolbar',
      filterInp,
      h('button.btn.ghost.icon', { title: 'New file', html: icon('file'), on: { click: () => newItem(false) } }),
      h('button.btn.ghost.icon', { title: 'New folder', html: icon('folder'), on: { click: () => newItem(true) } }),
      h('button.btn.ghost.icon', { title: 'Collapse all', html: icon('min'), on: { click: () => { open.clear(); render(); win.save(); } } }),
      h('button.btn.ghost.icon', { title: 'Refresh', html: icon('refresh'), on: { click: () => { cache.clear(); render(); refreshGit(); } } }),
      h('button.btn.ghost.icon', { title: 'Options', html: icon('chev'), on: { click: (e) => menu(e.clientX, e.clientY, [
        { label: 'Show hidden files', check: showHidden, action: () => { showHidden = !showHidden; render(); win.save(); } },
        { label: 'Open another folder…', action: pickProject },
        { label: 'Follow project root', check: !state.root, action: () => { state.root = null; setRoot(project.root); } }
      ]) } })
    );
    win.body.append(tb, list);

    async function entries(dir) {
      if (!cache.has(dir)) {
        try { cache.set(dir, await call('fs:list', dir)); } catch (e) { cache.set(dir, []); if (dir === root) toast(e.message, 'error'); }
      }
      return cache.get(dir).filter((e) => showHidden || (!HIDE.has(e.name) && !(e.name.startsWith('.') && e.name !== '.env' && e.name !== '.github' && e.name !== '.gitignore')));
    }

    async function render() {
      if (!root) { list.innerHTML = ''; list.appendChild(h('div.empty', h('div', h('b', 'NO PROJECT'), h('button.btn.primary', { style: { marginTop: '10px' }, on: { click: pickProject } }, 'OPEN FOLDER')))); return; }
      const frag = document.createDocumentFragment();
      const q = filter.toLowerCase();
      const walk = async (dir, depth) => {
        for (const e of await entries(dir)) {
          const isOpen = e.dir && (open.has(e.path) || (q && depth < 6));
          if (q && !e.dir && !e.name.toLowerCase().includes(q)) continue;
          const g = gitMap.get(e.path);
          const row = h('div.trow' + (e.path === sel ? '.sel' : '') + (g ? '.g-' + g : ''), { 'data-path': e.path, 'data-dir': e.dir ? '1' : '', style: { paddingLeft: 6 + depth * 12 + 'px' }, title: e.path, draggable: true,
            html: `<span class="tw">${e.dir ? (isOpen ? '▾' : '▸') : ''}</span><span class="fi fi-${e.dir ? 'dir' : esc(ext(e.name))}">${e.dir ? icon(isOpen ? 'explorer' : 'folder') : fileGlyph(e.name)}</span><span class="nm">${esc(e.name)}</span>${e.link ? '<span class="c-dim">↪</span>' : ''}${g ? `<span class="gs">${g === 'dot' ? '•' : g}</span>` : ''}` });
          frag.appendChild(row);
          if (isOpen) await walk(e.path, depth + 1);
        }
      };
      await walk(root, 0);
      list.innerHTML = '';
      list.appendChild(h('div.troot', { html: `${icon('explorer')} ${esc(basename(root))}${project.branch && root === project.root ? ` <span class="c-violet">${icon('branch')} ${esc(project.branch)}</span>` : ''}` }));
      list.appendChild(frag);
      win.setSub(root.replace(project.home || '\0', '~'));
    }

    async function refreshGit() {
      gitMap = new Map();
      if (!project.gitRoot || !root || !root.startsWith(project.gitRoot)) { render(); return; }
      try {
        const st = await call('git:status', project.gitRoot);
        for (const f of st.files) {
          const p = join(project.gitRoot, f.path.replace(/\/$/, ''));
          const code = f.conflict ? 'C' : f.untracked ? 'U' : (f.index === 'A' ? 'A' : f.work === 'D' || f.index === 'D' ? 'D' : 'M');
          gitMap.set(p, code);
          let d = dirname(p);
          while (d.length >= root.length && d !== dirname(d)) { if (!gitMap.has(d)) gitMap.set(d, 'dot'); d = dirname(d); }
        }
      } catch { /* not a repo */ }
      render();
    }

    function setRoot(r) { root = r; cache.clear(); open.clear(); sel = null; render(); refreshGit(); win.save(); }

    async function activate(row, how = 'open') {
      const p = row.dataset.path;
      sel = p;
      if (row.dataset.dir) { open.has(p) ? open.delete(p) : open.add(p); render(); win.save(); return; }
      if (how === 'open') bus.emit('open-file', p, {});
      else render();
    }

    list.addEventListener('click', (e) => { const row = e.target.closest('.trow'); if (!row) return; list.focus(); if (row.dataset.dir) activate(row); else { sel = row.dataset.path; [...list.querySelectorAll('.trow.sel')].forEach((r) => r.classList.remove('sel')); row.classList.add('sel'); } });
    list.addEventListener('dblclick', (e) => { const row = e.target.closest('.trow'); if (row && !row.dataset.dir) activate(row); });
    list.addEventListener('keydown', (e) => {
      const rows = [...list.querySelectorAll('.trow')]; let i = rows.findIndex((r) => r.dataset.path === sel);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); i = Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))); sel = rows[i].dataset.path; rows.forEach((r) => r.classList.toggle('sel', r === rows[i])); rows[i].scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter' && rows[i]) activate(rows[i]);
      else if (e.key === 'ArrowRight' && rows[i] && rows[i].dataset.dir && !open.has(sel)) { open.add(sel); render(); }
      else if (e.key === 'ArrowLeft' && rows[i]) { if (open.has(sel)) { open.delete(sel); render(); } else { const parent = dirname(sel); if (parent.length >= root.length && parent !== root) { sel = parent; render(); } } }
      else if (e.key === 'F2' && sel) renameItem(sel);
      else if (e.key === 'Delete' && sel) trashItem(sel);
    });
    list.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const row = e.target.closest('.trow'); const p = row ? row.dataset.path : root; const isDir = row ? !!row.dataset.dir : true;
      if (row) { sel = p; rows().forEach((r) => r.classList.toggle('sel', r === row)); }
      const e2 = ext(p);
      menu(e.clientX, e.clientY, [
        { header: basename(p) },
        !isDir ? { label: 'Open', action: () => bus.emit('open-file', p, {}) } : null,
        !isDir ? { label: 'Open in new editor', action: () => bus.emit('open-file', p, { newWindow: true }) } : null,
        !isDir && /^(md|markdown)$/.test(e2) ? { label: 'Markdown preview', action: () => wm.open('markdown', { state: { path: p } }) } : null,
        !isDir && /^json/.test(e2) ? { label: 'JSON viewer', action: () => wm.open('json', { state: { path: p } }) } : null,
        !isDir && /\.(db|sqlite3?|db3)$/i.test(p) ? { label: 'Open in database explorer', action: () => wm.open('db', { state: { conn: { type: 'sqlite', file: p } } }) } : null,
        !isDir && /\.log$/i.test(p) ? { label: 'Tail in log viewer', action: () => wm.open('logs', { state: { file: p } }) } : null,
        !isDir && /\.(m?js|cjs)$/.test(p) ? { label: 'Debug with Node', action: () => wm.open('debug', { state: { program: p, autostart: true } }) } : null,
        !isDir && live.session.role && !live.liveDocFor(p) ? { label: 'Share in live session', action: () => live.share(p).catch((er) => fail(er, 'SHARE')) } : null,
        isDir ? { label: 'Open terminal here', action: () => wm.open('terminal', { state: { cwd: p } }) } : { label: 'Open terminal in folder', action: () => wm.open('terminal', { state: { cwd: dirname(p) } }) },
        isDir ? { label: 'Search in folder', action: () => wm.open('search', { state: { include: rel(project.root, p) ? rel(project.root, p) + '/**' : '' } }) } : null,
        isDir && row ? { label: 'Set as explorer root', action: () => { state.root = p; setRoot(p); } } : null,
        '-',
        { label: 'New file…', action: () => newItem(false, isDir ? p : dirname(p)) },
        { label: 'New folder…', action: () => newItem(true, isDir ? p : dirname(p)) },
        row ? { label: 'Rename…', key: 'F2', action: () => renameItem(p) } : null,
        row ? { label: 'Duplicate', action: async () => { const t = p.replace(/(\.[^./\\]+)?$/, (m) => '-copy' + m); try { await call('fs:copy', p, t); cache.delete(dirname(p)); render(); } catch (er) { fail(er); } } } : null,
        row ? { label: 'Move to trash', key: 'Del', danger: true, action: () => trashItem(p) } : null,
        '-',
        { label: 'Copy path', action: () => copy(p) },
        { label: 'Copy relative path', action: () => copy(rel(project.root, p)) },
        { label: 'Reveal in file manager', action: () => call('fs:reveal', p) },
        !isDir && project.gitRoot && gitMap.get(p) && gitMap.get(p) !== 'U' ? { label: 'Diff against HEAD', action: () => wm.open('diff', { state: { root: project.gitRoot, file: p } }) } : null
      ]);
    });
    // drag a file into an editor window
    list.addEventListener('dragstart', (e) => { const row = e.target.closest('.trow'); if (row && !row.dataset.dir) e.dataTransfer.setData('text/phantom-tab', JSON.stringify({ p: row.dataset.path })); });
    const rows = () => [...list.querySelectorAll('.trow')];

    async function newItem(dir, base) {
      base = base || (sel ? (cache.has(sel) || open.has(sel) ? sel : dirname(sel)) : root);
      const name = await prompt(dir ? 'New folder' : 'New file', '', { label: `in ${base}`, placeholder: dir ? 'folder-name' : 'file.ext (use / for subfolders)' });
      if (!name) return;
      const p = join(base, name.trim());
      try {
        if (dir) await call('fs:mkdir', p); else await call('fs:createFile', p);
        cache.clear(); open.add(base); sel = p; await render();
        if (!dir) bus.emit('open-file', p, {});
      } catch (e) { fail(e); }
    }
    async function renameItem(p) {
      const n = await prompt('Rename', basename(p));
      if (!n || n === basename(p)) return;
      try { await call('fs:rename', p, join(dirname(p), n.trim())); cache.clear(); render(); } catch (e) { fail(e); }
    }
    async function trashItem(p) {
      if (!(await confirm('Move to trash', `Move "${basename(p)}" to the system trash?\n${p}\n\nYou can restore it from the trash.`, { danger: true, ok: 'TRASH' }))) return;
      try { await call('fs:trash', p); cache.clear(); sel = null; render(); toast(`${basename(p)} moved to trash`); } catch (e) { fail(e); }
    }

    filterInp.addEventListener('input', debounce(() => { filter = filterInp.value.trim(); render(); }, 150));
    const onFs = debounce((paths) => { for (const p of paths) { cache.delete(dirname(p)); cache.delete(p); } render(); refreshGitSoon(); }, 200);
    const refreshGitSoon = debounce(refreshGit, 600);
    offs.push(bus.on('fs:changed', onFs));
    offs.push(bus.on('git:changed', refreshGitSoon));
    offs.push(bus.on('project:changed', (r) => { if (!state.root) setRoot(r); }));
    offs.push(bus.on('explorer:reveal', async (p) => {
      if (!root || !p.startsWith(root)) return;
      let d = dirname(p); while (d.length > root.length) { open.add(d); d = dirname(d); }
      sel = p; await render();
      const row = list.querySelector(`.trow[data-path="${CSS.escape(p)}"]`); if (row) row.scrollIntoView({ block: 'center' });
      wm.restore(win); wm.focus(win);
    }));
    await render(); refreshGit();

    return {
      serialize: () => ({ root: state.root || null, open: [...open], hidden: showHidden }),
      destroy: () => offs.forEach((f) => f())
    };
  }
};
