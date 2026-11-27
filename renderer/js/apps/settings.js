// Settings & themes.
import { h, esc } from '../core/dom.js';
import { call } from '../core/api.js';
import { settings, setSetting, THEMES, DEFAULTS } from '../core/settings.js';
import { confirm, toast } from '../core/ui.js';

export default {
  id: 'settings', title: 'Settings', icon: 'settings', desc: 'Themes, editor, terminal, window manager', size: [640, 620], singleton: true, hidden: false, key: 'Ctrl+,',
  async create(win) {
    const el = h('div.set-root.fill.scroll');
    win.body.appendChild(el);
    const info = await call('app:info').catch(() => null);
    const pty = await call('pty:info').catch(() => null);
    function render() {
      el.innerHTML = '';
      el.appendChild(h('div.hdr', 'THEME'));
      const grid = h('div.set-themes');
      for (const [k, t] of Object.entries(THEMES)) {
        const tile = h('button.set-theme' + (settings.theme === k ? '.on' : ''), { style: { background: t.bg, borderColor: settings.theme === k ? t.accent : t.line2, color: t.fg },
          html: `<div class="sw">${[t.accent, t.cyan, t.amber, t.red, t.violet].map((c) => `<i style="background:${c};box-shadow:0 0 6px ${c}"></i>`).join('')}</div><b style="color:${t.accent}">${esc(t.name)}</b><span style="color:${t.dim}">${esc(t.desc)}</span><pre style="color:${t.fg}"><span style="color:${t.accent}">const</span> ghost = <span style="color:${t.amber}">'online'</span>;</pre>` });
        tile.addEventListener('click', () => { setSetting('theme', k); render(); });
        grid.appendChild(tile);
      }
      el.appendChild(grid);
      const row = (label, ctl, hint) => h('div.set-row', h('div', h('span', label), hint ? h('small.c-dim', hint) : null), ctl);
      const range = (k, min, max, step, fmt = (v) => v) => { const v = h('span.c-acc', String(fmt(settings[k]))); const r = h('input', { type: 'range', min, max, step, value: settings[k] }); r.addEventListener('input', () => { v.textContent = fmt(Number(r.value)); setSetting(k, Number(r.value)); }); return h('div.set-ctl', r, v); };
      const toggle = (k) => { const c = h('input', { type: 'checkbox', checked: !!settings[k] }); c.addEventListener('change', () => setSetting(k, c.checked)); return h('label.chk', c); };
      const text = (k, ph) => { const i = h('input.inp', { value: settings[k] || '', placeholder: ph, spellcheck: false }); i.addEventListener('change', () => setSetting(k, i.value.trim())); return i; };
      const color = () => { const i = h('input', { type: 'color', value: settings.accent || THEMES[settings.theme].accent }); i.addEventListener('input', () => setSetting('accent', i.value)); return h('div.set-ctl', i, h('button.btn.ghost', { on: { click: () => { setSetting('accent', ''); render(); } } }, 'reset')); };
      el.append(
        row('Accent override', color(), 'custom accent colour on top of the theme'),
        row('Glow intensity', range('glow', 0, 2, 0.1, (v) => v.toFixed(1))),
        row('CRT scanlines', toggle('scanlines')),
        row('Desktop grid', toggle('grid')),
        row('Reduce motion', toggle('reduceMotion')),
        row('Interface font size', range('uiFontSize', 10, 15, 1, (v) => v + 'px')),
        row('Boot sequence', toggle('boot'), 'show the startup diagnostics screen'),
        h('div.hdr', 'WINDOW MANAGER'),
        row('Snap to screen edges', toggle('snap'), 'drag to edges / corners; Ctrl+Alt+arrows'),
        row('Magnetic alignment', range('magnet', 0, 24, 1, (v) => (v ? v + 'px' : 'off')), 'Ctrl+drag to enable; Alt bypasses'),
        h('div.hdr', 'EDITOR'),
        row('Font size', range('editorFontSize', 10, 22, 1, (v) => v + 'px')),
        row('Tab size', range('tabSize', 2, 8, 1)),
        row('Minimap', toggle('minimap')),
        row('Word wrap', toggle('wordWrap')),
        row('Font ligatures', toggle('fontLigatures')),
        row('Auto-save', toggle('autosave'), 'saves 1.2s after you stop typing'),
        h('div.hdr', 'TERMINAL'),
        row('Font size', range('terminalFontSize', 10, 22, 1, (v) => v + 'px')),
        row('Cursor blink', toggle('cursorBlink')),
        row('Shell', text('shell', pty ? pty.defaultShell : 'default'), 'absolute path; empty = system default'),
        h('div.hdr', 'SYSTEM'),
        h('div.kv.set-info', { html: info ? [
          ['platform', `${info.platform} ${info.arch}`], ['user', `${info.user}@${info.hostname}`], ['electron', info.versions.electron || '—'], ['chrome', info.versions.chrome || '—'], ['node', info.versions.node],
          ['pty', pty ? (pty.native ? 'node-pty (native)' : `fallback bridge — ${pty.error || ''}`) : '—'], ['data dir', info.dataDir],
          ['tools', Object.entries(info.tools).map(([k, v]) => `${k}:${v ? '✓' : '✗'}`).join('  ')]
        ].map(([k, v]) => `<span>${esc(k)}</span><span class="sel-text">${esc(v)}</span>`).join('') : '' }),
        h('div.toolbar', { style: { border: 0, background: 'none', padding: '10px 0' } }, h('button.btn.danger', { on: { click: async () => {
          if (!(await confirm('Reset settings', 'Restore every setting to its default?', { danger: true, ok: 'RESET' }))) return;
          for (const [k, v] of Object.entries(DEFAULTS)) setSetting(k, v);
          render(); toast('settings reset');
        } } }, 'RESET TO DEFAULTS'))
      );
    }
    render();
    return {};
  }
};
