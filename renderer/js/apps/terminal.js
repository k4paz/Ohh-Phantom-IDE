// Terminal: xterm.js on a real PTY. Also hosts SSH sessions (shell = ssh).
import { h, icon, esc, basename, copy } from '../core/dom.js';
import { call, on, bus } from '../core/api.js';
import { settings, xtermTheme } from '../core/settings.js';
import { project } from '../core/project.js';
import { menu, fail } from '../core/ui.js';

export default {
  id: 'terminal', title: 'Terminal', icon: 'terminal', desc: 'Real shell sessions (PTY)', size: [760, 420], key: 'Ctrl+`', min: [300, 140],
  async create(win, state) {
    const host = h('div.term-host');
    win.body.appendChild(host);
    win.body.classList.add('term-body');
    const cfg = {
      cwd: state.cwd || project.root || undefined,
      shell: state.shell || settings.shell || undefined,
      args: state.args || undefined,
      env: state.env && typeof state.env === 'object' ? state.env : undefined,
      unsetEnv: Array.isArray(state.unsetEnv) ? state.unsetEnv : undefined,
      title: state.title,
      run: !!state.run
    };
    if (cfg.title) win.setTitle(cfg.title);
    let session = null; let exited = false; let cwd = cfg.cwd; const offs = [];
    const isSsh = !!(cfg.shell && /(^|[\\/])ssh(\.exe)?$/.test(cfg.shell));

    let term; let fit = null; let search = null; let fallback = null;
    if (window.Terminal) {
      term = new window.Terminal({
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font'), fontSize: settings.terminalFontSize, lineHeight: 1.15,
        cursorBlink: settings.cursorBlink, cursorStyle: 'block', allowProposedApi: true, scrollback: 10000, theme: xtermTheme(),
        macOptionIsMeta: true, rightClickSelectsWord: false, drawBoldTextInBrightColors: true, minimumContrastRatio: 1
      });
      if (window.FitAddon) { fit = new window.FitAddon.FitAddon(); term.loadAddon(fit); }
      if (window.SearchAddon) { search = new window.SearchAddon.SearchAddon(); term.loadAddon(search); }
      if (window.WebLinksAddon) term.loadAddon(new window.WebLinksAddon.WebLinksAddon((_e, url) => call('app:openExternal', url).catch(fail)));
      term.open(host);
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        const c = e.ctrlKey || e.metaKey;
        if (c && e.shiftKey && (e.key === 'C' || e.key === 'c')) { const s = term.getSelection(); if (s) copy(s); return false; }
        if (c && e.shiftKey && (e.key === 'V' || e.key === 'v')) { navigator.clipboard.readText().then((t) => session && call('pty:write', session.id, t)); return false; }
        if (c && e.shiftKey && (e.key === 'F' || e.key === 'f')) { findBar(); return false; }
        if (c && (e.key === 'p' || e.key === 'P' || e.key === '`') && !e.altKey) return false; // let the shell handle via global hotkeys
        if (e.altKey && e.key === '`') return false;
        if (exited && e.key === 'Enter') { start(); return false; }
        return true;
      });
      term.onData((d) => { if (session && !exited) call('pty:write', session.id, d); });
      term.onTitleChange((t) => win.setSub(t));
    } else {
      // Minimal fallback renderer when xterm.js is not installed.
      fallback = { out: h('pre.term-fallback.sel-text'), inp: h('input.inp.term-fallback-in', { placeholder: '$ type a command and press Enter' }) };
      host.append(fallback.out, fallback.inp);
      term = {
        write: (d) => { fallback.out.textContent += d.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g, ''); if (fallback.out.textContent.length > 200000) fallback.out.textContent = fallback.out.textContent.slice(-150000); fallback.out.scrollTop = 1e9; },
        cols: 120, rows: 30, focus: () => fallback.inp.focus(), dispose() {}, clear: () => { fallback.out.textContent = ''; }, options: {}, getSelection: () => String(getSelection())
      };
      fallback.inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { if (exited) { start(); return; } call('pty:write', session.id, fallback.inp.value + '\r'); fallback.inp.value = ''; }
        else if (e.key === 'c' && e.ctrlKey) { call('pty:write', session.id, '\x03'); }
      });
    }

    const resize = () => {
      if (!fit || !win.visible || !host.clientWidth) return;
      try { fit.fit(); } catch { return; }
      if (session && !exited) call('pty:resize', session.id, term.cols, term.rows).catch(() => {});
    };
    offs.push(win.onResize(resize));

    offs.push(on('pty:data', (p) => { if (session && p.id === session.id) term.write(p.data); }));
    offs.push(on('pty:exit', (p) => {
      if (!session || p.id !== session.id) return;
      exited = true;
      term.write(`\r\n\x1b[2m[process exited with code ${p.code} — press Enter to restart]\x1b[0m\r\n`);
      win.setBadge('exited');
    }));
    offs.push(bus.on('theme:changed', () => { if (term.options) { term.options.theme = xtermTheme(); } }));
    offs.push(bus.on('settings:changed', () => { if (term.options) { term.options.fontSize = settings.terminalFontSize; term.options.cursorBlink = settings.cursorBlink; resize(); } }));

    async function start() {
      exited = false; win.setBadge('');
      try {
        if (fit) try { fit.fit(); } catch { /* hidden */ }
        session = await call('pty:spawn', {
          cwd, shell: cfg.shell, args: cfg.args, env: cfg.env, unsetEnv: cfg.unsetEnv,
          cols: term.cols || 80, rows: term.rows || 24
        });
        if (!cfg.title) win.setTitle(isSsh ? 'SSH' : 'Terminal');
        win.setSub(isSsh ? (cfg.args || []).slice(-1)[0] : `${basename(session.shell)} · ${session.cwd.replace(project.home || '\0', '~')}`);
        if (session.kind !== 'pty') term.write(`\x1b[33m[phantom] node-pty unavailable — running via ${session.kind} bridge (no live resize)\x1b[0m\r\n`);
      } catch (e) { term.write(`\r\n\x1b[31m[phantom] failed to start shell: ${e.message}\x1b[0m\r\n`); exited = true; }
    }

    // Track cwd so layouts restore terminals in the right directory.
    const cwdTimer = setInterval(async () => {
      if (!session || exited || isSsh) return;
      try { const c = await call('pty:cwd', session.id); if (c && c !== cwd) { cwd = c; win.setSub(`${basename(session.shell)} · ${c.replace(project.home || '\0', '~')}`); } } catch { /* gone */ }
    }, 4000);

    function findBar() {
      if (!search) return;
      const existing = win.body.querySelector('.term-find');
      if (existing) { existing.querySelector('input').focus(); return; }
      const inp = h('input.inp', { placeholder: 'find in scrollback…' });
      const bar = h('div.term-find', inp,
        h('button.btn.ghost.icon', { html: icon('up'), on: { click: () => search.findPrevious(inp.value) } }),
        h('button.btn.ghost.icon', { html: icon('down'), on: { click: () => search.findNext(inp.value) } }),
        h('button.btn.ghost.icon', { html: icon('close'), on: { click: () => { bar.remove(); term.focus(); } } }));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.shiftKey ? search.findPrevious(inp.value) : search.findNext(inp.value); if (e.key === 'Escape') { bar.remove(); term.focus(); } });
      win.body.appendChild(bar); inp.focus();
    }

    host.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const sel = term.getSelection && term.getSelection();
      menu(e.clientX, e.clientY, [
        { label: 'Copy', key: 'Ctrl+Shift+C', action: () => copy(sel), disabled: !sel },
        { label: 'Paste', key: 'Ctrl+Shift+V', action: () => navigator.clipboard.readText().then((t) => session && call('pty:write', session.id, t)) },
        { label: 'Find…', key: 'Ctrl+Shift+F', action: findBar, disabled: !search },
        { label: 'Clear scrollback', action: () => term.clear() },
        '-',
        { label: 'Send Ctrl+C', action: () => session && call('pty:write', session.id, '\x03') },
        { label: 'Restart shell', action: async () => { if (session && !exited) await call('pty:kill', session.id); setTimeout(start, 150); } },
        { label: 'New terminal here', action: () => import('../core/wm.js').then(({ wm }) => wm.open('terminal', { state: { cwd } })) }
      ]);
    });
    host.addEventListener('mousedown', () => setTimeout(() => term.focus(), 0));

    requestAnimationFrame(() => { resize(); start(); });

    return {
      onShow: () => { resize(); },
      onFocus: () => term.focus(),
      serialize: () => ({
        cwd, shell: cfg.shell, args: cfg.args, env: cfg.env, unsetEnv: cfg.unsetEnv,
        title: cfg.title, run: cfg.run
      }),
      isRun: cfg.run,
      // Type a command into this shell. `build` gets the shell kind (pwsh/powershell/cmd/posix).
      async exec(build) {
        if (exited || !session) { if (exited) await start(); for (let i = 0; i < 100 && !session; i++) await new Promise((r) => setTimeout(r, 50)); }
        if (!session) return false;
        const { shellKind } = await import('../core/run.js');
        const line = typeof build === 'function' ? build(shellKind(session.shell)) : build;
        await call('pty:write', session.id, line + '\r');
        term.focus();
        return true;
      },
      destroy() { clearInterval(cwdTimer); offs.forEach((f) => f()); if (session && !exited) call('pty:kill', session.id).catch(() => {}); term.dispose(); },
      write: (d) => session && call('pty:write', session.id, d)
    };
  }
};
export { esc };
