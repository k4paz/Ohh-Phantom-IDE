// Desktop chrome: top bar, dock, taskbar, menus, command palette, keybindings, layouts, boot.
import { h, icon, esc, bytes, pct, basename, rate } from './dom.js';
import { call, on, bus, telemetry, onTelemetry, platform } from './api.js';
import { wm } from './wm.js';
import { settings, setSetting, THEMES } from './settings.js';
import { project, pickProject, openProject, projectFiles } from './project.js';
import { menu, palette, toast, prompt, confirm, tooltip, fail } from './ui.js';
import { plot } from './graph.js';
import { dirtyDocs, normPath } from './docs.js';
import * as run from './run.js';
import * as live from './collab.js';

export const DOCK = [
  ['projects', 'editor', 'explorer', 'search', 'terminal', 'git'],
  ['debug', 'tests', 'build'],
  ['api', 'db', 'json', 'markdown'],
  ['sysmon', 'net', 'procs', 'logs', 'events'],
  ['collab', 'ssh', 'audit', 'arch', 'agents', 'flow']
];

function toggleFullscreen() {
  call('app:fullscreen').catch((error) => fail(error, 'HARD FULLSCREEN'));
}

function resetDesktopView() {
  wm.exitOverview();
  const previousViewport = { ...wm.viewport };
  wm.setViewportTransform(1, 0, 0);
  wm.recordViewportUndo(previousViewport);
  wm.changed('viewport');
}

function frameWindow(win) {
  wm.exitOverview();
  wm.restore(win);
  wm.focus(win);
  const rect = win.max ? wm.viewRect() : win.rect;
  const previousViewport = { ...wm.viewport };
  const zoom = Math.max(0.05, Math.min(1, (wm.W - 48) / rect.w, (wm.H - 48) / rect.h));
  const panX = (wm.W - rect.w * zoom) / 2 - rect.x * zoom;
  const panY = (wm.H - rect.h * zoom) / 2 - rect.y * zoom;
  wm.setViewportTransform(zoom, panX, panY);
  wm.recordViewportUndo(previousViewport);
  wm.changed('viewport');
}

function snapFocusedWindow(key) {
  const f = wm.focused;
  if (!f) return;
  if (f.min) {
    if (key === 'ArrowUp') { wm.restore(f); wm.focus(f); }
    return;
  }
  const z = f.snapZone; const m = f.max;
  if (key === 'ArrowLeft') wm.snap(f, z === 'right' ? 'center' : z === 'tl' || z === 'bl' ? z : 'left');
  else if (key === 'ArrowRight') wm.snap(f, z === 'left' ? 'center' : z === 'tr' || z === 'br' ? z : 'right');
  else if (key === 'ArrowUp') { if (z === 'left') wm.snap(f, 'tl'); else if (z === 'right') wm.snap(f, 'tr'); else if (z === 'bl') wm.snap(f, 'left'); else if (z === 'br') wm.snap(f, 'right'); else wm.maximize(f); }
  else if (key === 'ArrowDown') { if (m) wm.unmaximize(f); else if (z === 'left') wm.snap(f, 'bl'); else if (z === 'right') wm.snap(f, 'br'); else if (z === 'tl') wm.snap(f, 'left'); else if (z === 'tr') wm.snap(f, 'right'); else wm.minimize(f, true, true); }
}

// Fractional layouts (desk 1×1) — scaled to the real desktop by restoreLayout.
export const PRESETS = {
  'Dev station': [
    ['explorer', 0, 0, 0.17, 1], ['editor', 0.17, 0, 0.55, 0.66], ['terminal', 0.17, 0.66, 0.55, 0.34], ['git', 0.72, 0, 0.28, 0.55], ['sysmon', 0.72, 0.55, 0.28, 0.45]
  ],
  'Recon / ops': [
    ['sysmon', 0, 0, 0.5, 0.5], ['net', 0.5, 0, 0.5, 0.5], ['procs', 0, 0.5, 0.5, 0.5], ['events', 0.5, 0.5, 0.5, 0.5]
  ],
  'Debug bay': [
    ['editor', 0, 0, 0.62, 0.65], ['debug', 0.62, 0, 0.38, 0.65], ['terminal', 0, 0.65, 0.4, 0.35], ['tests', 0.4, 0.65, 0.3, 0.35], ['logs', 0.7, 0.65, 0.3, 0.35]
  ],
  'API lab': [
    ['api', 0, 0, 0.55, 1], ['db', 0.55, 0, 0.45, 0.55], ['json', 0.55, 0.55, 0.45, 0.45]
  ],
  'Security sweep': [
    ['audit', 0, 0, 0.55, 1], ['net', 0.55, 0, 0.45, 0.5], ['events', 0.55, 0.5, 0.45, 0.5]
  ],
  'Architecture': [
    ['arch', 0, 0, 0.7, 1], ['explorer', 0.7, 0, 0.3, 0.5], ['search', 0.7, 0.5, 0.3, 0.5]
  ]
};
function presetLayout(name) {
  const view = wm.viewRect();
  return {
    v: 1, active: wm.active, desk: { w: wm.W, h: wm.H }, viewport: { ...wm.viewport },
    windows: PRESETS[name].map(([app, x, y, w, hh]) => ({
      app, ws: wm.active,
      rect: { x: view.x + x * view.w, y: view.y + y * view.h, w: w * view.w, h: hh * view.h },
      state: {}
    }))
  };
}
export async function applyPreset(name, { replace = true } = {}) {
  if (replace) {
    // Only clear the current workspace.
    for (const w of [...wm.windows]) if (w.ws === wm.active && !(await wm.close(w))) return;
  }
  await wm.restoreLayout(presetLayout(name), { replace: false });
}

// ───────── layouts ─────────
async function layouts() { return (await call('store:get', 'layouts', {})) || {}; }
export async function saveLayoutAs() {
  const name = await prompt('Save workspace layout', `layout-${new Date().toISOString().slice(0, 10)}`, { label: 'Saves every window across all four workspaces: positions, sizes, states, open files and terminal folders.' });
  if (!name) return;
  const all = await layouts();
  all[name.trim()] = { ...wm.serialize(), project: project.root, saved: Date.now() };
  await call('store:set', 'layouts', all);
  toast(`layout "${name}" saved (${wm.windows.length} windows)`, 'info', 'LAYOUT');
}
export async function loadLayout(name) {
  const l = (await layouts())[name];
  if (!l) return;
  if (l.project && l.project !== project.root) await openProject(l.project, { silent: true });
  await wm.restoreLayout(l);
  toast(`layout "${name}" restored`, 'info', 'LAYOUT', 1800);
}

// ───────── open file routing ─────────
export async function openFile(path, opts = {}) {
  path = normPath(path);
  let win = opts.newWindow ? null : wm.recent('editor');
  if (!win) win = await wm.open('editor', { state: {} });
  else { if (win.ws !== wm.active) wm.switchWorkspace(win.ws); wm.restore(win); wm.focus(win); }
  for (let i = 0; i < 50 && !(win.instance && win.instance.openFile); i++) await new Promise((r) => setTimeout(r, 20));
  if (win.instance && win.instance.openFile) await win.instance.openFile(path, opts);
  return win;
}
bus.on('open-file', (p, opts) => openFile(p, opts).catch((e) => fail(e)));

// ───────── commands ─────────
export function commands() {
  const out = [];
  for (const app of wm.apps.values()) if (!app.hidden) out.push({ group: 'tools', label: `Open ${app.title}`, detail: app.desc, icon: app.icon, key: app.key, run: () => wm.open(app.id) });
  out.push(
    { group: 'project', label: 'Open project folder…', icon: 'folder', key: 'Ctrl+O', run: pickProject },
    { group: 'project', label: 'Go to file…', icon: 'file', key: 'Ctrl+P', run: quickOpen },
    ...project.recent.map((r) => ({ group: 'project', label: `Open recent: ${basename(r)}`, detail: r, icon: 'folder', run: () => openProject(r) })),
    { group: 'run', label: 'Run: Start', icon: 'play', key: 'F5', run: () => run.start({ debug: true }) },
    { group: 'run', label: 'Run: Start without debugging', icon: 'play', key: 'Ctrl+F5', run: () => run.start({ debug: false }) },
    { group: 'run', label: 'Run: Stop', icon: 'stop', key: 'Shift+F5', run: run.stop },
    { group: 'run', label: 'Run: Restart', icon: 'refresh', key: 'Ctrl+Shift+F5', run: run.restart },
    { group: 'run', label: 'Run: Set project run command…', icon: 'settings', run: run.configure },
    { group: 'live', label: 'Live: Open session window (host / join)', icon: 'collab', run: () => wm.open('collab') },
    ...(live.session.role ? [{ group: 'live', label: 'Live: Share current file', icon: 'collab', run: () => { const f = run.activeFile(); if (f) live.share(f).catch(fail); else toast('open a file first', 'warn'); } },
      { group: 'live', label: live.session.role === 'host' ? 'Live: End session' : 'Live: Leave session', icon: 'close', run: () => live.leave() }] : []),
    { group: 'window', label: 'Tile windows', icon: 'layout', key: 'Ctrl+Alt+T', run: () => wm.tile() },
    { group: 'window', label: 'Cascade windows', icon: 'layout', run: () => wm.cascade() },
    { group: 'window', label: 'Toggle app overview', icon: 'layout', key: 'Ctrl+Tab', run: () => wm.toggleOverview() },
    { group: 'window', label: 'Show desktop', icon: 'layout', key: 'Ctrl+Alt+D', run: () => wm.showDesktop() },
    { group: 'window', label: 'Duplicate focused window', icon: 'layout', key: 'Ctrl+Shift+D', run: () => wm.focused && wm.duplicate(wm.focused) },
    { group: 'window', label: 'Close all other windows', icon: 'close', key: 'Ctrl+Shift+R', run: () => wm.focused && wm.closeOthers(wm.focused) },
    { group: 'window', label: 'Close all windows in this workspace', icon: 'close', run: async () => { for (const w of [...wm.windows]) if (w.ws === wm.active) await wm.close(w); } },
    { group: 'window', label: 'Toggle always-on-screen for focused window', icon: 'pin', run: () => wm.focused && wm.setPinned(wm.focused, !wm.focused.pinned) },
    ...[0, 1, 2, 3].map((i) => ({ group: 'window', label: `Switch to workspace ${i + 1}`, icon: 'layout', key: `Ctrl+Shift+${i + 1}`, run: () => wm.switchWorkspace(i) })),
    { group: 'layout', label: 'Save layout as…', icon: 'save', key: 'Ctrl+Shift+L', run: saveLayoutAs },
    ...Object.keys(PRESETS).map((n) => ({ group: 'layout', label: `Preset: ${n}`, icon: 'layout', run: () => applyPreset(n) })),
    { group: 'theme', label: 'Toggle scanlines', icon: 'eye', run: () => setSetting('scanlines', !settings.scanlines) },
    { group: 'theme', label: 'Toggle desktop grid', icon: 'eye', run: () => setSetting('grid', !settings.grid) },
    ...Object.entries(THEMES).map(([k, t]) => ({ group: 'theme', label: `Theme: ${t.name}`, detail: t.desc, icon: 'eye', run: () => setSetting('theme', k) })),
    { group: 'system', label: 'Settings', icon: 'settings', key: 'Ctrl+,', run: () => wm.open('settings') },
    { group: 'system', label: 'Toggle developer tools', icon: 'debug', key: 'F12', run: () => call('app:devtools') },
    { group: 'system', label: 'Toggle fullscreen (Windows hard kiosk)', icon: 'max', key: 'F11', run: toggleFullscreen },
    { group: 'system', label: 'Reload interface', icon: 'refresh', run: () => location.reload() }
  );
  return out;
}
export async function commandPalette() {
  const l = await layouts();
  palette({ items: [...commands(), ...Object.keys(l).map((n) => ({ group: 'layout', label: `Load layout: ${n}`, icon: 'layout', run: () => loadLayout(n) }))] });
}
export async function quickOpen() {
  if (!project.root) { toast('open a project first (Ctrl+O)', 'warn'); return; }
  const files = await projectFiles();
  palette({
    prefix: '⌕', placeholder: `Go to file in ${project.name}… (append :line)`, footer: `${files.length} files indexed · ↵ open · esc close`,
    items: (q) => {
      const [qq, line] = q.split(':');
      const items = [];
      for (const f of files) {
        const m = qq ? (fuzzyPath(qq, f)) : { score: 0, idx: [] };
        if (m) items.push({ label: f, icon: 'file', match: m, run: () => openFile(project.root + (platform === 'win32' ? '\\' : '/') + f, { line: Number(line) || undefined }) });
      }
      items.sort((a, b) => b.match.score - a.match.score);
      const out = items.slice(0, 200); out.prescored = true; return out;
    }
  });
}
function fuzzyPath(q, f) {
  // favour matches in the basename
  const ql = q.toLowerCase(); const fl = f.toLowerCase();
  let qi = 0; let score = 0; let prev = -2; const idx = [];
  const base = fl.lastIndexOf('/') + 1;
  for (let i = 0; i < fl.length && qi < ql.length; i++) {
    if (fl[i] === ql[qi]) { let s = 1; if (i === prev + 1) s += 5; if (i >= base) s += 2; if (i === base || /[/._-]/.test(fl[i - 1])) s += 3; score += s; idx.push(i); prev = i; qi++; }
  }
  if (qi < ql.length) return null;
  if (fl.slice(base).startsWith(ql)) score += 20;
  return { score: score - f.length * 0.05, idx };
}

// ───────── top bar ─────────
function buildTopbar() {
  const bar = document.getElementById('topbar');
  const menus = {
    SYSTEM: () => [
      { header: 'PHANTOM' },
      { label: 'Command palette', key: 'Ctrl+Shift+P', action: commandPalette },
      { label: 'Settings', key: 'Ctrl+,', action: () => wm.open('settings') },
      '-',
      { label: 'Toggle fullscreen (Windows hard kiosk)', key: 'F11', action: toggleFullscreen },
      { label: 'Developer tools', key: 'F12', action: () => call('app:devtools') },
      { label: 'Reload interface', action: () => location.reload() },
      '-',
      { label: 'Quit', danger: true, action: quit }
    ],
    PROJECT: () => [
      { label: 'Open folder…', key: 'Ctrl+O', action: pickProject },
      { label: 'Go to file…', key: 'Ctrl+P', action: quickOpen, disabled: !project.root },
      { label: 'Search in project', key: 'Ctrl+Shift+F', action: () => wm.open('search'), disabled: !project.root },
      '-',
      { header: 'RECENT' },
      ...(project.recent.length ? project.recent.map((r) => ({ label: r.replace(project.home, '~'), check: r === project.root, action: () => openProject(r) })) : [{ label: 'none yet', disabled: true }])
    ],
    TOOLS: () => DOCK.flatMap((g, i) => [...(i ? ['-'] : []), ...g.map((id) => { const a = wm.apps.get(id); return a && { label: a.title, key: a.key, action: () => wm.open(id) }; })]),
    RUN: async () => {
      const cmd = await run.projectCommand();
      const f = run.activeFile();
      return [
        { header: cmd ? `PROJECT COMMAND: ${cmd}` : f ? `CURRENT FILE: ${basename(f)}` : 'NOTHING SELECTED' },
        { label: 'Start', key: 'F5', action: () => run.start({ debug: true }) },
        { label: 'Start without debugging', key: 'Ctrl+F5', action: () => run.start({ debug: false }) },
        { label: 'Stop', key: 'Shift+F5', action: run.stop },
        { label: 'Restart', key: 'Ctrl+Shift+F5', action: run.restart },
        '-',
        { label: cmd ? 'Change project run command…' : 'Set project run command…', action: run.configure, disabled: !project.root },
        { label: 'Debugger window', action: () => wm.open('debug') },
        { label: 'Build tasks', action: () => wm.open('build') }
      ];
    },
    WINDOW: () => [
      { label: 'Tile', key: 'Ctrl+Alt+T', action: () => wm.tile() },
      { label: 'Cascade', action: () => wm.cascade() },
      { label: 'Toggle app overview', key: 'Ctrl+Tab', action: () => wm.toggleOverview() },
      { label: 'Show desktop', key: 'Ctrl+Alt+D', action: () => wm.showDesktop() },
      ...[['ArrowLeft', '←'], ['ArrowRight', '→'], ['ArrowUp', '↑'], ['ArrowDown', '↓']].map(([keyName, hint]) => ({
        label: `Snap focused window ${keyName.slice(5).toLowerCase()}`,
        key: platform === 'win32' ? `Win+${hint} (kiosk) / Ctrl+Alt+Shift+${hint}` : `Ctrl+Alt+Shift+${hint}`,
        action: () => snapFocusedWindow(keyName)
      })),
      '-',
      { label: 'Snapping to edges', check: settings.snap, action: () => setSetting('snap', !settings.snap) },
      { label: 'Magnetic alignment', check: settings.magnet > 0, action: () => setSetting('magnet', settings.magnet > 0 ? 0 : 10) },
      '-',
      { header: 'WINDOWS' },
      ...wm.windows.filter((w) => w.ws === wm.active || w.pinned).map((w) => ({ label: w.title + (w.sub ? ' — ' + w.sub.slice(-30) : ''), check: w === wm.focused, action: () => { if (w.ws !== wm.active && !w.pinned) wm.switchWorkspace(w.ws); wm.restore(w); wm.focus(w); } }))
    ],
    LAYOUT: async () => {
      const l = await layouts();
      return [
        { label: 'Save layout as…', key: 'Ctrl+Shift+L', action: saveLayoutAs },
        '-', { header: 'PRESETS (current workspace)' },
        ...Object.keys(PRESETS).map((n) => ({ label: n, action: () => applyPreset(n) })),
        '-', { header: 'SAVED' },
        ...(Object.keys(l).length ? Object.entries(l).map(([n, v]) => ({ label: `${n}  ·  ${v.windows.length} win`, action: () => loadLayout(n) })) : [{ label: 'nothing saved', disabled: true }]),
        ...(Object.keys(l).length ? ['-', { label: 'Delete a saved layout…', action: async () => {
          const n = await prompt('Delete layout', Object.keys(l)[0], { label: 'Name: ' + Object.keys(l).join(', ') });
          if (n && l[n] && await confirm('Delete layout', `Delete "${n}"?`, { danger: true, ok: 'DELETE' })) { delete l[n]; await call('store:set', 'layouts', l); toast('deleted ' + n); }
        } }] : [])
      ];
    },
    THEME: () => [
      ...Object.entries(THEMES).map(([k, t]) => ({ label: `${t.name}`, key: t.desc, check: settings.theme === k, action: () => setSetting('theme', k) })),
      '-',
      { label: 'Scanlines', check: settings.scanlines, action: () => setSetting('scanlines', !settings.scanlines) },
      { label: 'Desktop grid', check: settings.grid, action: () => setSetting('grid', !settings.grid) },
      { label: 'Reduce motion', check: settings.reduceMotion, action: () => setSetting('reduceMotion', !settings.reduceMotion) },
      { label: 'More…', action: () => wm.open('settings') }
    ]
  };
  const menuBar = h('div.menu');
  for (const [name, items] of Object.entries(menus)) {
    const b = h('button', name);
    b.addEventListener('mousedown', async (e) => { e.preventDefault(); e.stopPropagation(); const r = b.getBoundingClientRect(); b.classList.add('open'); menu(r.left, r.bottom, await items()); const off = () => { b.classList.remove('open'); document.removeEventListener('mousedown', off, true); }; setTimeout(() => document.addEventListener('mousedown', off, true), 0); });
    menuBar.appendChild(b);
  }
  const projEl = h('span.proj', { on: { click: pickProject } });
  const branchEl = h('span.branch');
  const ws = h('div.ws');
  for (let i = 0; i < wm.workspaceCount(); i++) ws.appendChild(h('button', { title: `Workspace ${i + 1}  (Ctrl+Shift+${i + 1})`, on: { click: () => wm.switchWorkspace(i) } }, String(i + 1)));
  const meter = (label) => { const c = h('canvas'); const v = h('b', '—'); return { el: h('div.meter', label, c, v), c, v }; };
  const mCpu = meter('CPU'); const mMem = meter('MEM'); const mNet = meter('NET');
  const meters = h('div.meters', { on: { click: () => wm.open('sysmon') }, style: { cursor: 'pointer' } }, mCpu.el, mMem.el, mNet.el);
  const clock = h('div.clock');
  const wctl = h('div.wctl',
    h('button', { html: icon('min'), on: { click: () => call('app:minimize') } }),
    h('button', { html: icon('max'), on: { click: () => call('app:maximize') } }),
    h('button.x', { html: icon('close'), on: { click: quit } }));
  bar.append(h('div.brand', { html: icon('logo') + 'PHANTOM', on: { click: commandPalette }, title: 'Command palette (Ctrl+Shift+P)' }), menuBar,
    h('div.drag', projEl, branchEl), ws, meters, clock, wctl);
  if (platform === 'darwin') wctl.style.display = 'none';

  const meta = () => {
    projEl.textContent = project.root ? project.root.replace(project.home, '~') : '[ no project mounted — click to open ]';
    branchEl.innerHTML = project.branch ? `${icon('branch')} ${esc(project.branch)}` : '';
    branchEl.querySelector('svg') && Object.assign(branchEl.querySelector('svg').style, { width: '10px', height: '10px', verticalAlign: '-1px' });
  };
  bus.on('project:meta', meta); bus.on('project:changed', meta); meta();
  const wsSync = () => [...ws.children].forEach((b, i) => { b.classList.toggle('on', i === wm.active); b.classList.toggle('has', wm.windows.some((w) => w.ws === i)); });
  bus.on('wm:changed', wsSync); wsSync();
  const tick = () => {
    const d = new Date();
    clock.innerHTML = `<span>${d.toISOString().slice(0, 10)}</span>${d.toTimeString().slice(0, 8)}`;
  };
  setInterval(tick, 1000); tick();
  onTelemetry((s, hist) => {
    mCpu.v.textContent = pct(s.cpu.load);
    mMem.v.textContent = pct((s.mem.used / s.mem.total) * 100);
    mNet.v.textContent = bytes(s.net.rx_sec + s.net.tx_sec);
    const last = hist.slice(-40);
    plot(mCpu.c, [{ data: last.map((x) => x.cpu.load) }], { max: 100, grid: false, points: 40 });
    plot(mMem.c, [{ data: last.map((x) => (x.mem.used / x.mem.total) * 100), color: getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim() }], { max: 100, grid: false, points: 40 });
    plot(mNet.c, [{ data: last.map((x) => x.net.rx_sec + x.net.tx_sec), color: getComputedStyle(document.documentElement).getPropertyValue('--amber').trim() }], { grid: false, points: 40 });
    meters.title = `cpu ${pct(s.cpu.load, 1)} · mem ${bytes(s.mem.used)}/${bytes(s.mem.total)} · ↓${rate(s.net.rx_sec)} ↑${rate(s.net.tx_sec)}`;
  });
}

// ───────── dock ─────────
function buildDock() {
  const dock = document.getElementById('dock');
  DOCK.forEach((group, gi) => {
    if (gi) dock.appendChild(h('div.sep'));
    for (const id of group) {
      const app = wm.apps.get(id); if (!app) continue;
      const b = h('button', { 'data-app': id, html: icon(app.icon) + '<span class="n"></span>' });
      b.addEventListener('click', (e) => {
        const existing = wm.ofApp(id).filter((w) => w.ws === wm.active || w.pinned);
        if (e.shiftKey || !existing.length || app.singleton) wm.open(id);
        else { const w = wm.recent(id); if (w.min) wm.restore(w); if (w === wm.focused && !e.altKey) wm.open(id); else wm.focus(w); }
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const wins = wm.ofApp(id);
        menu(e.clientX, e.clientY, [{ header: app.title }, { label: 'New window', action: () => wm.open(id) },
          ...(wins.length ? ['-', ...wins.map((w) => ({ label: `${w.title}${w.sub ? ' · ' + w.sub.slice(-28) : ''}  [ws ${w.ws + 1}]`, action: () => { if (w.ws !== wm.active && !w.pinned) wm.switchWorkspace(w.ws); wm.restore(w); wm.focus(w); } })), '-', { label: `Close all (${wins.length})`, danger: true, action: () => wins.forEach((w) => wm.close(w)) }] : [])]);
      });
      tooltip(b, app.title, app.key || '');
      dock.appendChild(b);
    }
  });
  dock.appendChild(h('div', { style: { flex: '1' } }));
  const sb = h('button', { html: icon('settings'), on: { click: () => wm.open('settings') } });
  tooltip(sb, 'Settings', 'Ctrl+,');
  dock.appendChild(sb);
  const sync = () => {
    for (const b of dock.querySelectorAll('button[data-app]')) {
      const n = wm.windows.filter((w) => w.app.id === b.dataset.app).length;
      b.classList.toggle('running', n > 0);
      b.querySelector('.n').textContent = n > 1 ? n : '';
    }
  };
  bus.on('wm:changed', sync);
}

// ───────── taskbar ─────────
function buildTaskbar() {
  const bar = document.getElementById('taskbar');
  const tasks = h('div.tasks');
  const status = h('div.status');
  bar.append(h('button.start', { html: icon('logo') + ' LAUNCH', on: { click: commandPalette } }), tasks, status);
  const render = () => {
    const list = wm.windows.filter((w) => w.ws === wm.active || w.pinned).sort((a, b) => a.id - b.id);
    tasks.innerHTML = '';
    for (const [index, w] of list.entries()) {
      const shortcut = index < 9 ? ` · Shift+${index + 1} (double-press resets desktop)` : '';
      const b = h('button.task' + (w === wm.focused ? '.focus' : '') + (w.min ? '.min' : ''), { 'data-win': w.id, title: `${w.title}${w.sub ? ' — ' + w.sub : ''}${shortcut} · Double-click to frame window`, html: `${icon(w.app.icon)}<span>${esc(w.title)}${w.sub ? ' <span class="c-dim">' + esc(basename(w.sub)) + '</span>' : ''}</span>${w.pinned ? '<span class="pin">▲</span>' : ''}` });
      b.addEventListener('click', () => { if (w === wm.focused && !w.min) wm.minimize(w); else { wm.restore(w); wm.focus(w); } });
      b.addEventListener('dblclick', (event) => { event.preventDefault(); frameWindow(w); });
      b.addEventListener('auxclick', (e) => { if (e.button === 1) wm.close(w); });
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); wm.windowMenu(w, e.clientX, e.clientY - 300); });
      tasks.appendChild(b);
    }
  };
  bus.on('wm:changed', render);
  const st = { pty: null, events: 0, tasks: 0 };
  const renderStatus = () => {
    const total = wm.windows.length;
    status.innerHTML = `<span>${total} win · ws ${wm.active + 1}</span>` +
      (st.tasks ? `<span class="warn"><span class="spin"></span> ${st.tasks} task${st.tasks > 1 ? 's' : ''}</span>` : '') +
      (st.pty ? `<span class="${st.pty.native ? 'ok' : 'warn'}" title="${st.pty.native ? 'node-pty' : esc(st.pty.error || '')}">pty:${st.pty.native ? 'native' : 'bridge'}</span>` : '') +
      (live.session.role ? `<button class="ok live-status" title="live session">⇄ LIVE ${live.session.peers.length}</button>` : '') +
      `<span class="ok">● online</span>`;
  };
  call('pty:info').then((i) => { st.pty = i; renderStatus(); }).catch(() => {});
  on('tasks:exit', () => call('tasks:running').then((r) => { st.tasks = r.length; renderStatus(); }));
  bus.on('tasks:started', () => call('tasks:running').then((r) => { st.tasks = r.length; renderStatus(); }));
  bus.on('wm:changed', renderStatus);
  bus.on('collab:changed', renderStatus);
  status.addEventListener('click', (e) => { if (e.target.closest('.live-status')) wm.open('collab'); });
  renderStatus();
}

function buildWallpaper() {
  const wp = document.getElementById('wallpaper');
  const sig = h('div.sig');
  wp.append(sig);

  const desktop = document.getElementById('desktop');
  let panDrag = null;
  let suppressContextMenu = false;
  desktop.addEventListener('dblclick', (event) => {
    if (event.target !== desktop && event.target !== wp) return;
    wm.unfocus();
  });
  const drawWallpaper = () => {
    const { zoom, panX, panY } = wm.viewport;
    wp.style.setProperty('--wallpaper-grid-size', `${32 * zoom}px`);
    wp.style.setProperty('--wallpaper-pan-x', `${panX}px`);
    wp.style.setProperty('--wallpaper-pan-y', `${panY}px`);
  };
  bus.on('wm:viewport', drawWallpaper);
  desktop.addEventListener('pointerdown', (event) => {
    if (event.target !== desktop && event.target !== wp) return;
    if (event.button !== 1 && event.button !== 2) return;
    event.preventDefault();
    panDrag = {
      pointerId: event.pointerId,
      button: event.button,
      startX: event.clientX,
      startY: event.clientY,
      panX: wm.viewport.panX,
      panY: wm.viewport.panY,
      moved: false
    };
    desktop.classList.add('wallpaper-panning');
    desktop.setPointerCapture(event.pointerId);
  }, true);
  window.addEventListener('pointermove', (event) => {
    if (!panDrag || panDrag.pointerId !== event.pointerId) return;
    const dx = event.clientX - panDrag.startX;
    const dy = event.clientY - panDrag.startY;
    panDrag.moved ||= Math.abs(dx) > 3 || Math.abs(dy) > 3;
    if (!panDrag.moved) return;
    wm.setViewportTransform(wm.viewport.zoom, panDrag.panX + dx, panDrag.panY + dy);
  });
  const finishPan = (event) => {
    if (!panDrag || panDrag.pointerId !== event.pointerId) return;
    suppressContextMenu = panDrag.button === 2 && panDrag.moved;
    const moved = panDrag.moved;
    const previousViewport = { zoom: wm.viewport.zoom, panX: panDrag.panX, panY: panDrag.panY };
    panDrag = null;
    desktop.classList.remove('wallpaper-panning');
    if (moved) {
      wm.recordViewportUndo(previousViewport);
      wm.changed('viewport');
    }
    if (suppressContextMenu) setTimeout(() => { suppressContextMenu = false; }, 350);
  };
  window.addEventListener('pointerup', finishPan);
  window.addEventListener('pointercancel', finishPan);
  desktop.addEventListener('contextmenu', (event) => {
    if (!suppressContextMenu && !(panDrag?.button === 2 && panDrag.moved)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressContextMenu = false;
  }, true);
  const upd = () => {
    const s = telemetry.static;
    sig.innerHTML = `<b>PHANTOM</b>${s ? `${esc(s.user)}@${esc(s.hostname)} · ${esc(s.distro)} · ${esc(s.cpuModel)} × ${s.cores}` : ''}`;
  };
  bus.on('wm:changed', upd);
  bus.on('settings:changed', (key) => { if (key === 'grid') upd(); });
  setTimeout(upd, 1500);
  drawWallpaper();
  upd();
}

// ───────── keyboard ─────────
function keybindings() {
  let lastTaskShortcut = null;
  on('app:windowSwitcher', (action, direction) => {
    if (action === 'step') wm.stepWindowSwitcher(direction === -1 ? -1 : 1);
    else if (action === 'commit') wm.commitWindowSwitcher();
    else if (action === 'cancel') wm.cancelWindowSwitcher();
  });
  on('app:snapWindow', snapFocusedWindow);
  on('app:kioskError', (message) => fail(message, 'HARD FULLSCREEN'));
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey; const k = e.key;
    const digit = Number(/^(?:Digit|Numpad)([1-9])$/.exec(e.code)?.[1] || (/^[1-9]$/.test(k) ? k : 0));
    const f = wm.focused;
    const target = e.target instanceof Element ? e.target : null;
    const editingText = target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .monaco-editor, .xterm');
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (ctrl && !e.shiftKey && !e.altKey && (k === 'z' || k === 'Z') && !editingText && wm.canUndoClose()) {
      stop();
      wm.undoClose().catch((error) => fail(error, 'UNDO CLOSE'));
    }
    else if (ctrl && e.shiftKey && !e.altKey && (k === 'z' || k === 'Z') && wm.redoViewport()) {
      stop();
    }
    else if (ctrl && !e.shiftKey && !e.altKey && (k === 'z' || k === 'Z') && wm.undoViewport()) {
      stop();
    }
    else if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (k === 'Tab' || e.code === 'Tab')) {
      stop();
      if (!e.repeat) wm.toggleOverview();
    }
    else if (ctrl && e.shiftKey && !e.altKey && digit >= 1 && digit <= 4) {
      stop();
      lastTaskShortcut = null;
      wm.switchWorkspace(digit - 1);
    }
    else if (!ctrl && e.shiftKey && !e.altKey && digit >= 1 && digit <= 9) {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .monaco-editor, .xterm')) return;
      const task = document.querySelector(`#taskbar .tasks .task:nth-child(${digit})`);
      const win = task && wm.windows.find((item) => item.id === Number(task.dataset.win));
      if (win) {
        stop();
        const now = performance.now();
        const repeated = !e.repeat && lastTaskShortcut?.digit === digit && lastTaskShortcut.win === win
          && now - lastTaskShortcut.at <= 800;
        if (repeated) {
          resetDesktopView();
          lastTaskShortcut.at = now;
          return;
        }
        lastTaskShortcut = { digit, win, at: now };
        if (win.min) wm.restore(win);
        wm.focus(win);
      } else lastTaskShortcut = null;
    }
    else if (ctrl && e.shiftKey && !e.altKey && (k === 'D' || k === 'd')) {
      stop();
      if (f) wm.duplicate(f).catch((error) => fail(error, 'DUPLICATE WINDOW'));
    }
    else if (ctrl && e.shiftKey && !e.altKey && (k === 'R' || k === 'r')) {
      stop();
      wm.closeOthers(f).catch((error) => fail(error, 'CLOSE OTHER WINDOWS'));
    }
    else if (ctrl && e.shiftKey && (k === 'P' || k === 'p')) { stop(); commandPalette(); }
    else if (ctrl && !e.shiftKey && !e.altKey && (k === 'k' || k === 'K') && !(f && f.app.id === 'terminal')) { stop(); commandPalette(); }
    else if (ctrl && !e.shiftKey && !e.altKey && (k === 'p' || k === 'P')) { stop(); quickOpen(); }
    else if (ctrl && !e.shiftKey && (k === 'o' || k === 'O')) { stop(); pickProject(); }
    else if (ctrl && k === '`') { stop(); wm.open('terminal', { state: { cwd: project.root } }); }
    else if (ctrl && e.shiftKey && (k === 'F' || k === 'f')) { stop(); wm.open('search'); }
    else if (ctrl && e.shiftKey && (k === 'E' || k === 'e')) { stop(); wm.open('explorer'); }
    else if (ctrl && e.shiftKey && (k === 'G' || k === 'g')) { stop(); wm.open('git'); }
    else if (ctrl && e.shiftKey && (k === 'L' || k === 'l')) { stop(); saveLayoutAs(); }
    else if (ctrl && !e.shiftKey && !e.altKey && (k === 'W' || k === 'w')) { stop(); if (f) wm.close(f); }
    else if (ctrl && e.shiftKey && (k === 'W' || k === 'w')) { stop(); if (f) wm.close(f); }
    else if (ctrl && k === ',') { stop(); wm.open('settings'); }
    else if (e.altKey && (k === '`' || e.code === 'Backquote')) { stop(); wm.cycle(e.shiftKey ? -1 : 1); }
    else if (k === 'F5') {
      if (ctrl && e.shiftKey) { stop(); run.restart(); }
      else if (e.shiftKey) { stop(); run.stop(); }
      else if (ctrl) { stop(); run.start({ debug: false }); }
      else if (!document.body.dataset.debugActive) { stop(); run.start({ debug: true }); }
      // with a live debug session, plain F5 falls through to the debugger (continue / pause)
    }
    else if (k === 'F11' && !document.body.dataset.debugPaused) { stop(); toggleFullscreen(); }
    else if (k === 'F12') { stop(); call('app:devtools'); }
    else if (ctrl && e.altKey && /^Digit[1-4]$/.test(e.code)) { stop(); const i = Number(e.code.slice(5)) - 1; if (e.shiftKey && f) wm.moveToWorkspace(f, i); else wm.switchWorkspace(i); }
    else if (ctrl && e.altKey && (k === 't' || k === 'T')) { stop(); wm.tile(); }
    else if (ctrl && e.altKey && (k === 'd' || k === 'D')) { stop(); wm.showDesktop(); }
    else if (ctrl && e.altKey && e.shiftKey && f && k.startsWith('Arrow')) { stop(); snapFocusedWindow(k); }
    else if (platform === 'win32' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && f && k.startsWith('Arrow')) {
      stop();
      snapFocusedWindow(k);
    }
  }, true);
}

async function quit() {
  const dirty = dirtyDocs();
  if (dirty.length && !(await confirm('Unsaved changes', `${dirty.length} file(s) have unsaved changes:\n${dirty.map((d) => '  ' + d.name).join('\n')}\n\nQuit anyway?`, { danger: true, ok: 'QUIT' }))) return;
  bus.emit('wm:persist-now');
  setTimeout(() => call('app:close'), 120);
}

// ───────── boot ─────────
export async function boot() {
  const el = document.getElementById('boot');
  if (!settings.boot) return;
  el.classList.add('on');
  const pre = h('pre'); const logo = h('pre.logo');
  logo.textContent = [
    '██████╗ ██╗  ██╗ █████╗ ███╗   ██╗████████╗ ██████╗ ███╗   ███╗',
    '██╔══██╗██║  ██║██╔══██╗████╗  ██║╚══██╔══╝██╔═══██╗████╗ ████║',
    '██████╔╝███████║███████║██╔██╗ ██║   ██║   ██║   ██║██╔████╔██║',
    '██╔═══╝ ██╔══██║██╔══██║██║╚██╗██║   ██║   ██║   ██║██║╚██╔╝██║',
    '██║     ██║  ██║██║  ██║██║ ╚████║   ██║   ╚██████╔╝██║ ╚═╝ ██║',
    '╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝    ╚═════╝ ╚═╝     ╚═╝'
  ].join('\n');
  el.append(logo, pre, h('div.skip', 'press any key to skip'));
  let skip = false;
  const sk = () => { skip = true; };
  addEventListener('keydown', sk, { once: true }); el.addEventListener('click', sk, { once: true });
  const line = async (html, ms = 60) => { pre.innerHTML += html + '\n'; if (!skip) await new Promise((r) => setTimeout(r, ms)); };
  const [info, sys] = await Promise.all([call('app:info').catch(() => null), call('sys:static').catch(() => null)]);
  await line('<span class="dim">[ 0.000000]</span> phantom workstation kernel — interface layer v1.0');
  if (sys) {
    await line(`<span class="dim">[ 0.004113]</span> host      <span class="ok">${esc(sys.user)}@${esc(sys.hostname)}</span>  ${esc(sys.distro)}  ${esc(sys.kernel)} ${esc(sys.arch)}`);
    await line(`<span class="dim">[ 0.009260]</span> cpu       ${esc(sys.cpuModel)} × ${sys.cores}`);
    await line(`<span class="dim">[ 0.011507]</span> memory    ${bytes(sys.totalmem)}  telemetry:${esc(sys.backend)}`);
  }
  if (info) {
    const t = info.tools;
    const tag = (k, v) => `${k}:${v ? '<span class="ok">ok</span>' : '<span class="warn">--</span>'}`;
    await line(`<span class="dim">[ 0.020331]</span> toolchain ${tag('git', t.git)} ${tag('rg', t.rg)} ${tag('ssh', t.ssh)} ${tag('node', t.node)} ${tag('python', t.python)} ${tag('docker', t.docker)} ${tag('cargo', t.cargo)} ${tag('go', t.go)}`);
    await line(`<span class="dim">[ 0.024802]</span> runtime   electron ${esc(info.versions.electron || '-')} · chrome ${esc(info.versions.chrome || '-')} · node ${esc(info.versions.node)}`);
  }
  const pty = await call('pty:info').catch(() => null);
  if (pty) await line(`<span class="dim">[ 0.031177]</span> pty       ${pty.native ? '<span class="ok">node-pty native</span>' : '<span class="warn">bridge fallback</span> (' + esc(pty.error || '') + ')'}  shell ${esc(pty.defaultShell)}`);
  await line(`<span class="dim">[ 0.035000]</span> wm        ${wm.apps.size} tools registered · ${wm.workspaceCount()} workspaces · compositor online`);
  await line('<span class="ok">[  OK  ]</span> all systems nominal. welcome back.', 260);
  el.classList.add('out');
  setTimeout(() => el.remove(), 320);
}

export function initShell() {
  buildTopbar();
  buildDock();
  buildTaskbar();
  buildWallpaper();
  keybindings();
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input,textarea,.monaco-editor,.xterm,.sel-text')) return;
    e.preventDefault();
    if (e.target === document.getElementById('desktop') || e.target.id === 'wallpaper' || e.target.closest('#wallpaper')) {
      menu(e.clientX, e.clientY, [
        { header: 'DESKTOP' },
        { label: 'New terminal', key: 'Ctrl+`', action: () => wm.open('terminal', { state: { cwd: project.root } }) },
        { label: 'New editor', action: () => wm.open('editor') },
        { label: 'Command palette', key: 'Ctrl+Shift+P', action: commandPalette },
        '-',
        { label: 'Tile windows', action: () => wm.tile() },
        { label: 'Cascade windows', action: () => wm.cascade() },
        { label: 'Save layout…', action: saveLayoutAs },
        '-', { header: 'PRESETS' },
        ...Object.keys(PRESETS).map((n) => ({ label: n, action: () => applyPreset(n) }))
      ]);
    }
  });
}
