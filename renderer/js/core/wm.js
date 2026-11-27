// PHANTOM window manager: floating, snapping, magnetic, multi-workspace windows.
import { h, icon, esc } from './dom.js';
import { bus } from './api.js';
import { settings } from './settings.js';
import { menu, prompt, toast } from './ui.js';

const TITLE_H = 24;
const WORKSPACES = 4;
const EDGE = 8; // px from desktop edge that triggers snap zones
const CORNER = 48;

let nextId = 1;

class Win {
  constructor(wm, app, opts) {
    this.wm = wm; this.app = app; this.id = nextId++;
    this.ws = opts.workspace ?? wm.active;
    this.min = false; this.max = false; this.pinned = !!opts.pinned;
    this.snapZone = null; this.restoreRect = null;
    this.title = opts.title || app.title;
    this.rect = { x: 0, y: 0, w: app.size[0], h: app.size[1] };
    this.instance = null; this.resizeFns = new Set(); this.z = 0;
    this.build();
  }
  build() {
    const ctrl = h('div.pw-ctrl',
      this.pinBtn = h('button.pin', { title: 'Always on top', html: icon('pin'), on: { click: () => this.wm.setPinned(this, !this.pinned) } }),
      h('button.minb', { title: 'Minimize', html: icon('min'), on: { click: () => this.wm.minimize(this) } }),
      this.maxBtn = h('button.maxb', { title: 'Maximize', html: icon('max'), on: { click: () => this.wm.toggleMax(this) } }),
      h('button.close', { title: 'Close', html: icon('close'), on: { click: () => this.wm.close(this) } })
    );
    this.titleEl = h('div.pw-title',
      h('span.pw-icon', { html: icon(this.app.icon) }),
      this.nameEl = h('span.pw-name', this.title),
      this.subEl = h('span.pw-sub', h('span')),
      this.badgeEl = h('span.pw-badge'),
      ctrl
    );
    this.body = h('div.pw-body');
    this.sizeEl = h('div.pw-size');
    this.el = h('div.pw', { 'data-app': this.app.id }, this.titleEl, this.body, this.sizeEl,
      ...['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => h('div.pw-rz.' + d, { 'data-dir': d })));
    this.el.addEventListener('pointerdown', () => this.wm.focus(this), true);
    this.titleEl.addEventListener('pointerdown', (e) => { if (e.button === 0 && !e.target.closest('button')) this.wm.beginDrag(this, e); });
    this.titleEl.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) this.wm.toggleMax(this); });
    this.titleEl.addEventListener('contextmenu', (e) => { e.preventDefault(); this.wm.windowMenu(this, e.clientX, e.clientY); });
    this.titleEl.addEventListener('auxclick', (e) => { if (e.button === 1) this.wm.close(this); });
    for (const rz of this.el.querySelectorAll('.pw-rz')) rz.addEventListener('pointerdown', (e) => { if (e.button === 0) this.wm.beginResize(this, e, rz.dataset.dir); });
    let raf = 0;
    this.ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { for (const f of this.resizeFns) { try { f(); } catch (err) { console.error(err); } } }); });
    this.ro.observe(this.body);
  }
  // ── API for apps ──
  setSub(text) { this.subEl.firstChild.textContent = text || ''; this.sub = text || ''; this.wm.changed('meta'); }
  setTitle(text) { this.title = text || this.app.title; this.nameEl.textContent = this.title; this.wm.changed('meta'); }
  setBadge(text) { this.badgeEl.textContent = text || ''; }
  onResize(fn) { this.resizeFns.add(fn); return () => this.resizeFns.delete(fn); }
  get visible() { return !this.min && this.ws === this.wm.active && !this.closed; }
  get focused() { return this.wm.focused === this; }
  close() { return this.wm.close(this); }
  focus() { this.wm.focus(this); }
  save() { this.wm.changed('state'); }
}

export class WindowManager {
  constructor() {
    this.apps = new Map(); this.windows = []; this.active = 0; this.focused = null; this.z = 10;
    this.history = []; // focus order (most recent last)
    this.cycleOrder = null;
    this.cycling = false;
    this.windowSwitcher = null;
    bus.on('wm:changed', () => this.refreshWindowSwitcher());
  }

  init(desktop) {
    this.desk = desktop;
    this.preview = desktop.querySelector('#snap-preview');
    this.guides = desktop.querySelector('#guides');
    this.world = h('div#window-viewport');
    this.desk.insertBefore(this.world, this.preview);
    this.buildWindowSwitcher();
    this.viewport = { zoom: 1, panX: 0, panY: 0 };
    new ResizeObserver(() => this.onDesktopResize()).observe(desktop);
    this.lastDesk = { w: desktop.clientWidth, h: desktop.clientHeight };
  }

  register(app) {
    app.size = app.size || [720, 460];
    app.min = app.min || [260, 140];
    this.apps.set(app.id, app);
  }

  get W() { return this.desk.clientWidth; }
  get H() { return this.desk.clientHeight; }
  viewRect() {
    const { zoom, panX, panY } = this.viewport;
    return { x: -panX / zoom, y: -panY / zoom, w: this.W / zoom, h: this.H / zoom };
  }
  toWorld(clientX, clientY, deskRect = this.desk.getBoundingClientRect()) {
    const { zoom, panX, panY } = this.viewport;
    return {
      x: (clientX - deskRect.left - panX) / zoom,
      y: (clientY - deskRect.top - panY) / zoom
    };
  }
  setViewportTransform(_zoom, panX, panY) {
    this.viewport = { zoom: 1, panX, panY };
    this.world.style.transform = `translate(${panX}px, ${panY}px)`;
    for (const win of this.windows) {
      if (win.max) this.render(win);
      else if (win.snapZone) { win.rect = this.zoneRect(win.snapZone); this.render(win); }
    }
    bus.emit('wm:viewport', this.viewport);
  }

  // ───────── lifecycle ─────────
  async open(appId, opts = {}) {
    const app = this.apps.get(appId);
    if (!app) { toast(`unknown tool: ${appId}`, 'error'); return null; }
    if (app.singleton && !opts.allowDuplicate) {
      const ex = this.windows.find((w) => w.app.id === appId);
      if (ex) { if (ex.ws !== this.active) this.switchWorkspace(ex.ws); this.restore(ex); this.focus(ex); if (opts.state && ex.instance && ex.instance.apply) ex.instance.apply(opts.state); return ex; }
    }
    const win = new Win(this, app, opts);
    if (opts.rect) win.rect = { ...opts.rect };
    else win.rect = this.placeNew(app.size);
    this.windows.push(win);
    this.world.appendChild(win.el);
    win.el.classList.add('opening');
    setTimeout(() => win.el.classList.remove('opening'), 200);
    if (win.pinned) win.pinBtn.classList.add('on'), win.el.classList.add('pinned');
    this.render(win);
    if (opts.maximized) this.maximize(win, true);
    else if (opts.snap) this.snap(win, opts.snap, true);
    if (opts.focus !== false) this.focus(win); else { win.z = ++this.z; this.stack(win); }
    try {
      win.instance = (await app.create(win, opts.state || {})) || {};
    } catch (e) {
      console.error(e);
      win.body.innerHTML = `<div class="empty"><div><b>TOOL CRASHED</b>${esc(e.message)}</div></div>`;
      win.instance = {};
    }
    if (opts.minimized) this.minimize(win, true);
    this.sync(win);
    this.changed('open');
    bus.emit('wm:open', win);
    return win;
  }

  async close(win, force = false) {
    if (win.closed) return true;
    if (!force && win.instance && win.instance.canClose) {
      const ok = await win.instance.canClose();
      if (!ok) return false;
    }
    win.closed = true;
    try { win.instance && win.instance.destroy && win.instance.destroy(); } catch (e) { console.error(e); }
    win.ro.disconnect();
    this.windows = this.windows.filter((w) => w !== win);
    this.history = this.history.filter((w) => w !== win);
    win.el.classList.add('closing');
    setTimeout(() => win.el.remove(), 130);
    if (this.focused === win) { this.focused = null; this.focusTop(); }
    this.changed('close');
    bus.emit('wm:close', win);
    return true;
  }

  async closeAll(ws = null) {
    for (const w of [...this.windows]) if (ws === null || w.ws === ws) if (!(await this.close(w))) return false;
    return true;
  }

  async closeOthers(keep) {
    if (!keep || keep.closed) return false;
    for (const win of [...this.windows]) {
      if (win === keep) continue;
      if (!(await this.close(win))) {
        toast(`Could not close "${win.title}".`, 'warn', 'WINDOWS');
        return false;
      }
    }
    if (keep && !keep.closed) {
      if (keep.ws !== this.active) this.switchWorkspace(keep.ws);
      this.restore(keep);
      this.focus(keep);
    }
    return true;
  }

  placeNew([w, hgt]) {
    const view = this.viewRect(); const W = view.w; const H = view.h;
    w = Math.min(w, W - 20); hgt = Math.min(hgt, H - 20);
    // Cascade from the focused window, otherwise centre-ish with jitter.
    const vis = this.windows.filter((x) => x.visible);
    let x; let y;
    if (this.focused && this.focused.visible && !this.focused.max) { x = this.focused.rect.x + 28; y = this.focused.rect.y + 28; }
    else { x = view.x + (W - w) / 2 + (vis.length % 5) * 24 - 48; y = view.y + (H - hgt) / 2.4 + (vis.length % 5) * 24 - 48; }
    if (x + w > view.x + W - 4 || y + hgt > view.y + H - 4) { x = view.x + 20 + (vis.length % 6) * 24; y = view.y + 16 + (vis.length % 6) * 28; }
    return { x: Math.max(view.x, Math.round(x)), y: Math.max(view.y, Math.round(y)), w: Math.round(w), h: Math.round(hgt) };
  }

  // ───────── rendering ─────────
  render(win) {
    const r = win.max ? this.viewRect() : win.rect;
    const s = win.el.style;
    s.left = r.x + 'px'; s.top = r.y + 'px'; s.width = r.w + 'px'; s.height = r.h + 'px';
  }
  stack(win) { win.el.style.zIndex = String((win.pinned ? 20000 : 0) + win.z); }
  sync(win) {
    const vis = win.visible;
    const was = win.el.style.display !== 'none';
    win.el.style.display = vis ? '' : 'none';
    win.el.classList.toggle('max', win.max);
    win.maxBtn.innerHTML = icon(win.max ? 'restore' : 'max');
    if (vis && !was && win.instance && win.instance.onShow) setTimeout(() => win.instance.onShow(), 0);
    if (!vis && was && win.instance && win.instance.onHide) win.instance.onHide();
  }

  focus(win) {
    if (!win || win.closed) return;
    if (!this.cycling) this.cycleOrder = null;
    if (this.focused !== win) {
      if (this.focused) this.focused.el.classList.remove('focus');
      this.focused = win;
      win.el.classList.add('focus');
      this.history = this.history.filter((w) => w !== win); this.history.push(win);
      if (win.instance && win.instance.onFocus) win.instance.onFocus();
      bus.emit('wm:focus', win);
    }
    if (win.z !== this.z) { win.z = ++this.z; this.stack(win); }
    if (this.z > 15000) this.normalizeZ();
    this.changed('focus', true);
  }
  normalizeZ() {
    const sorted = [...this.windows].sort((a, b) => a.z - b.z);
    sorted.forEach((w, i) => { w.z = 10 + i; this.stack(w); });
    this.z = 10 + sorted.length;
  }
  focusTop() {
    let cands = this.history.filter((w) => w.visible);
    if (!cands.length) cands = this.windows.filter((w) => w.visible).sort((a, b) => (a.pinned - b.pinned) || a.z - b.z);
    const top = cands[cands.length - 1];
    if (top) this.focus(top); else if (this.focused) { this.focused.el.classList.remove('focus'); this.focused = null; this.changed('focus', true); }
  }
  /** Most recently focused window of an app (current workspace preferred). */
  recent(appId) {
    const list = this.history.filter((w) => w.app.id === appId && !w.closed).reverse();
    const rest = this.windows.filter((w) => w.app.id === appId && !list.includes(w)).sort((a, b) => b.z - a.z);
    const all = [...list, ...rest];
    return all.find((w) => w.ws === this.active && !w.min) || all.find((w) => w.ws === this.active) || all[0] || null;
  }
  ofApp(appId) { return this.windows.filter((w) => w.app.id === appId); }

  // ───────── state changes ─────────
  minimize(win, instant = false, keepFocus = false) {
    if (win.min) return;
    const btn = document.querySelector(`#taskbar .task[data-win="${win.id}"]`);
    if (!instant && btn && !settings.reduceMotion) {
      const a = win.el.getBoundingClientRect(); const b = btn.getBoundingClientRect();
      win.el.classList.add('minimizing');
      win.el.style.transformOrigin = '0 0';
      win.el.style.transform = `translate(${(b.left - a.left) / this.viewport.zoom}px, ${(b.top - a.top) / this.viewport.zoom}px) scale(${b.width / a.width}, ${b.height / a.height})`;
      setTimeout(() => { win.el.classList.remove('minimizing'); win.el.style.transform = ''; win.min = true; this.sync(win); }, 180);
    } else { win.min = true; this.sync(win); }
    win.min = true;
    if (this.focused === win && !keepFocus) { win.el.classList.remove('focus'); this.focused = null; this.history = this.history.filter((w) => w !== win); this.history.unshift(win); this.focusTop(); }
    this.changed('min');
  }
  restore(win) {
    if (!win.min) return;
    win.min = false;
    win.el.classList.add('opening');
    setTimeout(() => win.el.classList.remove('opening'), 200);
    this.sync(win); this.changed('restore');
  }
  maximize(win, quiet) {
    if (!win.max) { win.max = true; win.snapZone = null; this.animate(win); this.render(win); this.sync(win); if (!quiet) this.changed('max'); }
  }
  unmaximize(win) {
    if (win.max) { win.max = false; this.animate(win); this.render(win); this.sync(win); this.changed('max'); }
  }
  toggleMax(win) { win.max ? this.unmaximize(win) : this.maximize(win); }
  setPinned(win, v) {
    win.pinned = v;
    win.pinBtn.classList.toggle('on', v); win.el.classList.toggle('pinned', v);
    this.stack(win); this.changed('pin');
    toast(v ? `${win.title}: always on top` : `${win.title}: normal stacking`, 'info', 'WINDOW', 1500);
  }
  animate(win) {
    if (settings.reduceMotion) return;
    win.el.classList.add('animate-rect');
    clearTimeout(win.animT); win.animT = setTimeout(() => win.el.classList.remove('animate-rect'), 200);
  }

  zoneRect(zone) {
    const view = this.viewRect();
    const { x, y, w: W, h: H } = view; const hw = Math.round(W / 2); const hh = Math.round(H / 2);
    const t3 = Math.round(W / 3);
    return {
      left: { x, y, w: hw, h: H }, right: { x: x + hw, y, w: W - hw, h: H },
      top: { x, y, w: W, h: hh }, bottom: { x, y: y + hh, w: W, h: H - hh },
      tl: { x, y, w: hw, h: hh }, tr: { x: x + hw, y, w: W - hw, h: hh },
      bl: { x, y: y + hh, w: hw, h: H - hh }, br: { x: x + hw, y: y + hh, w: W - hw, h: H - hh },
      l3: { x, y, w: t3, h: H }, c3: { x: x + t3, y, w: t3, h: H }, r3: { x: x + 2 * t3, y, w: W - 2 * t3, h: H },
      center: { x: x + Math.round(W * 0.15), y: y + Math.round(H * 0.1), w: Math.round(W * 0.7), h: Math.round(H * 0.8) },
      max: view
    }[zone];
  }
  snap(win, zone, quiet) {
    if (zone === 'max') return this.maximize(win, quiet);
    const r = this.zoneRect(zone); if (!r) return;
    if (!win.snapZone && !win.max) win.restoreRect = { ...win.rect };
    win.max = false; win.snapZone = zone; win.rect = { ...r };
    this.animate(win); this.render(win); this.sync(win);
    if (!quiet) this.changed('snap');
  }

  // ───────── workspaces ─────────
  switchWorkspace(i) {
    if (i === this.active || i < 0 || i >= WORKSPACES) return;
    this.active = i;
    for (const w of this.windows) this.sync(w);
    this.focusTop();
    this.changed('workspace');
    bus.emit('wm:workspace', i);
  }
  moveToWorkspace(win, i) { win.ws = i; this.sync(win); if (this.focused === win && i !== this.active) this.focusTop(); this.changed('workspace'); }
  workspaceCount() { return WORKSPACES; }

  // ───────── arrangement ─────────
  tile() {
    const vis = this.windows.filter((w) => w.visible);
    if (!vis.length) return;
    const view = this.viewRect();
    const n = vis.length; const cols = Math.ceil(Math.sqrt(n * (view.w / view.h) / 1.4)); const rows = Math.ceil(n / cols);
    const gap = 6;
    vis.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x).forEach((w, i) => {
      const c = i % cols; const r = Math.floor(i / cols);
      const colsInRow = r === rows - 1 ? n - cols * (rows - 1) : cols;
      const cw = (view.w - gap * (colsInRow + 1)) / colsInRow; const rh = (view.h - gap * (rows + 1)) / rows;
      w.max = false; w.snapZone = null;
      w.rect = { x: Math.round(view.x + gap + c * (cw + gap)), y: Math.round(view.y + gap + r * (rh + gap)), w: Math.round(cw), h: Math.round(rh) };
      this.animate(w); this.render(w); this.sync(w);
    });
    this.changed('tile');
  }
  cascade() {
    const vis = this.windows.filter((w) => w.visible).sort((a, b) => a.z - b.z);
    const view = this.viewRect();
    vis.forEach((w, i) => {
      w.max = false; w.snapZone = null;
      const ww = Math.min(w.app.size[0], view.w - 200); const hh = Math.min(w.app.size[1], view.h - 160);
      w.rect = { x: view.x + 24 + (i % 10) * 30, y: view.y + 16 + (i % 10) * 28, w: ww, h: hh };
      this.animate(w); this.render(w); this.sync(w);
    });
    this.changed('cascade');
  }
  showDesktop() {
    const vis = this.windows.filter((w) => w.visible);
    if (vis.length) { this._shown = vis; vis.forEach((w) => this.minimize(w, true)); }
    else if (this._shown) { this._shown.forEach((w) => this.restore(w)); this._shown = null; this.focusTop(); }
  }
  buildWindowSwitcher() {
    this.windowSwitcherEl = h('div#alt-tab-switcher.window-switcher', {
      role: 'dialog',
      'aria-label': 'Open windows',
      'aria-hidden': 'true'
    },
    this.windowSwitcherPanel = h('div.window-switcher-panel',
      h('div.window-switcher-heading', h('span', 'OPEN WINDOWS'), h('span.window-switcher-hint', 'ALT + TAB')),
      this.windowSwitcherGrid = h('div.window-switcher-grid'),
      h('div.window-switcher-footer', 'Release ALT to switch · ESC to cancel')
    ));
    document.body.appendChild(this.windowSwitcherEl);
  }
  windowSwitcherOrder() {
    const open = this.windows.filter((win) => !win.closed);
    return [
      ...this.history.filter((win) => open.includes(win)),
      ...open.filter((win) => !this.history.includes(win)).sort((a, b) => a.id - b.id)
    ];
  }
  stepWindowSwitcher(direction = 1) {
    if (!this.windowSwitcher) {
      const windows = this.windowSwitcherOrder();
      if (!windows.length) return;
      const focusedIndex = windows.indexOf(this.focused);
      this.windowSwitcher = {
        windows,
        selectedIndex: ((focusedIndex < 0 ? 0 : focusedIndex) - direction + windows.length) % windows.length
      };
      this.windowSwitcherEl.classList.add('on');
      this.windowSwitcherEl.setAttribute('aria-hidden', 'false');
      this.renderWindowSwitcher();
      return;
    }
    const current = this.windowSwitcher.windows[this.windowSwitcher.selectedIndex];
    const windows = this.windowSwitcherOrder();
    if (!windows.length) return this.cancelWindowSwitcher();
    this.windowSwitcher.windows = windows;
    const index = windows.indexOf(current);
    this.windowSwitcher.selectedIndex = ((index < 0 ? 0 : index) - direction + windows.length) % windows.length;
    this.refreshWindowSwitcher();
  }
  renderWindowSwitcher() {
    const state = this.windowSwitcher;
    if (!state) return;
    this.windowSwitcherGrid.replaceChildren();
    state.windows.forEach((win, index) => {
      const rect = win.max ? this.viewRect() : win.rect;
      const thumbWidth = 300;
      const thumbHeight = 170;
      const scale = Math.min((thumbWidth - 12) / rect.w, (thumbHeight - 12) / rect.h, 0.6);
      const preview = h('div.window-switcher-preview');
      const clone = win.el.cloneNode(true);
      clone.classList.remove('opening', 'closing', 'minimizing', 'dragging', 'resizing');
      clone.classList.add('window-switcher-window');
      clone.style.cssText = `position:absolute;display:flex;left:${(thumbWidth - rect.w * scale) / 2}px;top:${(thumbHeight - rect.h * scale) / 2}px;width:${rect.w}px;height:${rect.h}px;transform:scale(${scale});transform-origin:top left;z-index:auto;`;
      clone.removeAttribute('id');
      clone.querySelectorAll('.pw-ctrl, .pw-rz, .pw-size').forEach((el) => el.remove());
      clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
      const sourceInputs = win.el.querySelectorAll('input, textarea, select');
      clone.querySelectorAll('input, textarea, select').forEach((el, inputIndex) => {
        const source = sourceInputs[inputIndex];
        if (!source) return;
        if ('value' in el) el.value = source.value;
        if ('checked' in el) el.checked = source.checked;
      });
      const sourceCanvases = win.el.querySelectorAll('canvas');
      clone.querySelectorAll('canvas').forEach((canvas, canvasIndex) => {
        const source = sourceCanvases[canvasIndex];
        if (!source) return;
        try { canvas.getContext('2d').drawImage(source, 0, 0); } catch (error) { console.error(error); }
      });
      preview.appendChild(clone);
      const card = h('button.window-switcher-card', {
        type: 'button',
        'aria-label': `${win.title} — ${win.app.title}`,
        'aria-pressed': index === state.selectedIndex ? 'true' : 'false',
        on: {
          click: () => {
            this.selectWindowSwitcherItem(index);
            this.commitWindowSwitcher();
          }
        }
      },
      preview,
      h('span.window-switcher-label', h('span.window-switcher-icon', { html: icon(win.app.icon) }), h('span.window-switcher-title', win.title)),
      h('span.window-switcher-app', win.app.title));
      card.classList.toggle('selected', index === state.selectedIndex);
      this.windowSwitcherGrid.appendChild(card);
    });
  }
  selectWindowSwitcherItem(index) {
    if (!this.windowSwitcher || index < 0 || index >= this.windowSwitcher.windows.length) return;
    this.windowSwitcher.selectedIndex = index;
    this.windowSwitcherGrid.querySelectorAll('.window-switcher-card').forEach((card, cardIndex) => {
      const selected = cardIndex === index;
      card.classList.toggle('selected', selected);
      card.setAttribute('aria-pressed', String(selected));
    });
  }
  refreshWindowSwitcher() {
    if (!this.windowSwitcher) return;
    const state = this.windowSwitcher;
    const selected = state.windows[state.selectedIndex];
    const windows = this.windowSwitcherOrder();
    if (!windows.length) return this.cancelWindowSwitcher();
    const listChanged = windows.length !== state.windows.length ||
      windows.some((win, index) => win !== state.windows[index]);
    const selectedIndex = windows.indexOf(selected);
    state.windows = windows;
    state.selectedIndex = selectedIndex < 0
      ? Math.min(state.selectedIndex, windows.length - 1)
      : selectedIndex;
    if (listChanged) this.renderWindowSwitcher();
    else {
      state.windows.forEach((win, index) => {
        const card = this.windowSwitcherGrid.children[index];
        if (!card) return;
        const title = card.querySelector('.window-switcher-title');
        if (title && title.textContent !== win.title) title.textContent = win.title;
        card.setAttribute('aria-label', `${win.title} — ${win.app.title}`);
      });
      this.selectWindowSwitcherItem(state.selectedIndex);
    }
  }
  closeWindowSwitcher() {
    this.windowSwitcher = null;
    this.windowSwitcherGrid.replaceChildren();
    this.windowSwitcherEl.classList.remove('on');
    this.windowSwitcherEl.setAttribute('aria-hidden', 'true');
  }
  commitWindowSwitcher() {
    if (!this.windowSwitcher) return;
    const selected = this.windowSwitcher.windows[this.windowSwitcher.selectedIndex];
    this.closeWindowSwitcher();
    if (!selected || selected.closed) return;
    if (selected.ws !== this.active) this.switchWorkspace(selected.ws);
    this.restore(selected);
    this.focus(selected);
  }
  cancelWindowSwitcher() {
    if (this.windowSwitcher) this.closeWindowSwitcher();
  }
  cycle(dir = 1) {
    const vis = this.windows.filter((w) => w.ws === this.active && !w.closed).sort((a, b) => a.id - b.id);
    if (!vis.length) return;
    if (!this.cycleOrder || this.cycleOrder.length !== vis.length || vis.some((w) => !this.cycleOrder.includes(w))) {
      this.cycleOrder = [...this.history.filter((w) => vis.includes(w)), ...vis.filter((w) => !this.history.includes(w))];
    }
    const ordered = this.cycleOrder;
    const i = ordered.indexOf(this.focused);
    const next = ordered[((i < 0 ? 0 : i) - dir + ordered.length) % ordered.length];
    this.cycling = true;
    try {
      this.restore(next);
      this.focus(next);
    } finally {
      this.cycling = false;
    }
  }

  // ───────── drag & resize ─────────
  magnetEdges(win) {
    const view = this.viewRect();
    const xs = [view.x, view.x + view.w]; const ys = [view.y, view.y + view.h];
    for (const w of this.windows) {
      if (w === win || !w.visible || w.max) continue;
      xs.push(w.rect.x, w.rect.x + w.rect.w); ys.push(w.rect.y, w.rect.y + w.rect.h);
    }
    return { xs, ys };
  }
  snapAxis(a, b, cands, t) {
    // a, b: the two edges of the moving rect on this axis. Returns {delta, at} or null.
    let best = null;
    for (const c of cands) {
      for (const [edgeIndex, e] of [a, b].entries()) {
        const d = c - e;
        if (Math.abs(d) <= t && (!best || Math.abs(d) < Math.abs(best.delta))) {
          best = { delta: d, at: c, offset: edgeIndex === 0 ? 0 : b - a };
        }
      }
    }
    return best;
  }
  showGuides(gx, gy) {
    this.guides.innerHTML = '';
    const { zoom, panX, panY } = this.viewport;
    if (gx !== null && gx !== undefined) this.guides.appendChild(h('i.v', { style: { left: `${panX + gx * zoom}px` } }));
    if (gy !== null && gy !== undefined) this.guides.appendChild(h('i.h', { style: { top: `${panY + gy * zoom}px` } }));
  }
  detectZone(px, py) {
    if (!settings.snap) return null;
    const W = this.W; const H = this.H;
    const L = px <= EDGE; const R = px >= W - EDGE; const T = py <= EDGE; const B = py >= H - EDGE;
    if ((L && py < CORNER) || (T && px < CORNER)) return 'tl';
    if ((R && py < CORNER) || (T && px > W - CORNER)) return 'tr';
    if ((L && py > H - CORNER) || (B && px < CORNER)) return 'bl';
    if ((R && py > H - CORNER) || (B && px > W - CORNER)) return 'br';
    if (T) return 'max';
    if (L) return 'left';
    if (R) return 'right';
    if (B) return 'bottom';
    return null;
  }
  showPreview(zone) {
    const p = this.preview;
    if (!zone) { p.classList.remove('on'); return; }
    const r = this.zoneRect(zone);
    const { zoom, panX, panY } = this.viewport;
    Object.assign(p.style, { left: `${panX + r.x * zoom + 4}px`, top: `${panY + r.y * zoom + 4}px`, width: `${r.w * zoom - 8}px`, height: `${r.h * zoom - 8}px` });
    p.dataset.label = { max: 'MAXIMIZE', left: 'LEFT HALF', right: 'RIGHT HALF', bottom: 'BOTTOM HALF', tl: 'TOP LEFT', tr: 'TOP RIGHT', bl: 'BOTTOM LEFT', br: 'BOTTOM RIGHT' }[zone] || zone.toUpperCase();
    p.classList.add('on');
  }

  beginDrag(win, e) {
    e.preventDefault();
    const deskR = this.desk.getBoundingClientRect();
    const sx = e.clientX; const sy = e.clientY;
    let r0 = { ...(win.max ? this.viewRect() : win.rect) };
    const startWorld = this.toWorld(sx, sy, deskR);
    let moved = false; let zone = null;
    let lockedGuideX = null; let lockedGuideY = null;
    const target = e.currentTarget; target.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = (ev.clientX - sx) / this.viewport.zoom; const dy = (ev.clientY - sy) / this.viewport.zoom;
      if (!moved) {
        if (Math.hypot(dx, dy) < 4) return;
        moved = true;
        document.body.classList.add('wm-busy'); win.el.classList.add('dragging');
        if (win.max || win.snapZone) {
          // Tear out of maximized/snapped state, keeping the grab point proportional.
          const rr = win.restoreRect || { w: win.app.size[0], h: win.app.size[1] };
          const ratioX = (startWorld.x - r0.x) / r0.w;
          const ratioY = (startWorld.y - r0.y) / r0.h;
          r0 = { x: Math.round(startWorld.x - ratioX * rr.w), y: Math.round(startWorld.y - ratioY * rr.h), w: rr.w, h: rr.h };
          win.max = false; win.snapZone = null; win.restoreRect = null;
          this.sync(win);
        }
      }
      let x = r0.x + dx; let y = r0.y + dy;
      let gx = null; let gy = null;
      const hardLock = ev.ctrlKey && !ev.altKey;
      if (!hardLock) {
        lockedGuideX = null;
        lockedGuideY = null;
      }
      if (settings.magnet > 0 && !ev.altKey) {
        const { xs, ys } = this.magnetEdges(win);
        const threshold = settings.magnet / this.viewport.zoom;
        const mx = this.snapAxis(x, x + r0.w, xs, threshold);
        const my = this.snapAxis(y, y + r0.h, ys, threshold);
        if (hardLock && !lockedGuideX && mx) lockedGuideX = { at: mx.at, offset: mx.offset };
        if (hardLock && !lockedGuideY && my) lockedGuideY = { at: my.at, offset: my.offset };
        if (hardLock && lockedGuideX) { x = lockedGuideX.at - lockedGuideX.offset; gx = lockedGuideX.at; }
        else if (mx) { x += mx.delta; gx = mx.at; }
        if (hardLock && lockedGuideY) { y = lockedGuideY.at - lockedGuideY.offset; gy = lockedGuideY.at; }
        else if (my) { y += my.delta; gy = my.at; }
      }
      const view = this.viewRect();
      y = Math.max(view.y, Math.min(y, view.y + view.h - TITLE_H / this.viewport.zoom));
      x = Math.max(view.x - r0.w + 80 / this.viewport.zoom, Math.min(x, view.x + view.w - 80 / this.viewport.zoom));
      win.rect = { x: Math.round(x), y: Math.round(y), w: r0.w, h: r0.h };
      this.render(win);
      this.showGuides(gx, gy);
      zone = ev.altKey ? null : this.detectZone(ev.clientX - deskR.left, ev.clientY - deskR.top);
      this.showPreview(zone);
    };
    const up = () => {
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up);
      document.body.classList.remove('wm-busy'); win.el.classList.remove('dragging');
      this.showPreview(null); this.showGuides();
      if (moved) {
        if (zone) { win.restoreRect = { ...r0, x: win.rect.x, y: win.rect.y }; this.snap(win, zone); if (zone === 'max') win.restoreRect = { ...r0 }; }
        this.changed('move');
      }
    };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
  }

  beginResize(win, e, dir) {
    e.preventDefault(); e.stopPropagation();
    if (win.max) return;
    this.focus(win);
    const target = e.currentTarget; target.setPointerCapture(e.pointerId);
    const sx = e.clientX; const sy = e.clientY; const r0 = { ...win.rect };
    const [minW, minH] = win.app.min;
    const edges = this.magnetEdges(win);
    document.body.classList.add('wm-busy'); win.el.classList.add('resizing');
    win.snapZone = null;
    const move = (ev) => {
      const dx = (ev.clientX - sx) / this.viewport.zoom; const dy = (ev.clientY - sy) / this.viewport.zoom;
      let { x, y, w, h: hh } = r0; let gx = null; let gy = null;
      const t = ev.altKey ? 0 : settings.magnet / this.viewport.zoom;
      const near = (v, cands) => { for (const c of cands) if (Math.abs(c - v) <= t) return c; return null; };
      if (dir.includes('e')) { let right = r0.x + r0.w + dx; const c = near(right, edges.xs); if (c !== null) { right = c; gx = c; } w = Math.max(minW, right - x); }
      const view = this.viewRect();
      if (dir.includes('s')) { let bottom = r0.y + r0.h + dy; const c = near(bottom, edges.ys); if (c !== null) { bottom = c; gy = c; } hh = Math.max(minH, Math.min(bottom, view.y + view.h) - y); }
      if (dir.includes('w')) { let left = r0.x + dx; const c = near(left, edges.xs); if (c !== null) { left = c; gx = c; } left = Math.min(left, r0.x + r0.w - minW); w = r0.x + r0.w - left; x = left; }
      if (dir.includes('n')) { let top = Math.max(view.y, r0.y + dy); const c = near(top, edges.ys); if (c !== null) { top = c; gy = c; } top = Math.min(top, r0.y + r0.h - minH); hh = r0.y + r0.h - top; y = top; }
      win.rect = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(hh) };
      this.render(win);
      this.showGuides(gx, gy);
      win.sizeEl.textContent = `${win.rect.w}×${win.rect.h}`;
    };
    const up = () => {
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up);
      document.body.classList.remove('wm-busy'); win.el.classList.remove('resizing');
      this.showGuides();
      this.changed('resize');
    };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
  }

  onDesktopResize() {
    const view = this.viewRect();
    if (!view.w || !view.h) return;
    for (const w of this.windows) {
      if (w.max) this.render(w);
      else if (w.snapZone) { w.rect = this.zoneRect(w.snapZone); this.render(w); }
      else {
        w.rect.w = Math.min(w.rect.w, view.w); w.rect.h = Math.min(w.rect.h, view.h);
        w.rect.x = Math.max(view.x - w.rect.w + 80 / this.viewport.zoom, Math.min(w.rect.x, view.x + view.w - 80 / this.viewport.zoom));
        w.rect.y = Math.max(view.y, Math.min(w.rect.y, view.y + view.h - TITLE_H / this.viewport.zoom));
        this.render(w);
      }
    }
    this.lastDesk = { w: this.W, h: this.H };
  }

  // ───────── menus ─────────
  windowMenu(win, x, y) {
    const wsItems = [];
    for (let i = 0; i < WORKSPACES; i++) wsItems.push({ label: `Move to workspace ${i + 1}`, check: win.ws === i, action: () => this.moveToWorkspace(win, i), key: `⇧⌥${i + 1}` });
    menu(x, y, [
      { header: win.title },
      { label: 'Always on top', check: win.pinned, action: () => this.setPinned(win, !win.pinned) },
      { label: win.max ? 'Restore' : 'Maximize', action: () => this.toggleMax(win), key: 'Win+↑' },
      { label: 'Minimize', action: () => this.minimize(win), key: 'Win+↓' },
      '-',
      { label: 'Snap left half', action: () => this.snap(win, 'left'), key: 'Win+←' },
      { label: 'Snap right half', action: () => this.snap(win, 'right'), key: 'Win+→' },
      { label: 'Snap top / bottom', action: () => this.snap(win, win.snapZone === 'top' ? 'bottom' : 'top') },
      { label: 'Snap quarter', action: () => this.snap(win, ['tl', 'tr', 'br', 'bl'][(['tl', 'tr', 'br', 'bl'].indexOf(win.snapZone) + 1) % 4]) },
      { label: 'Snap thirds', action: () => this.snap(win, ['l3', 'c3', 'r3'][(['l3', 'c3', 'r3'].indexOf(win.snapZone) + 1) % 3]) },
      { label: 'Center', action: () => this.snap(win, 'center') },
      '-',
      ...wsItems,
      '-',
      { label: 'Duplicate window', action: () => this.duplicate(win) },
      { label: 'Rename…', action: async () => { const t = await prompt('Rename window', win.title); if (t !== null) win.setTitle(t.trim()); } },
      '-',
      { label: 'Close', danger: true, action: () => this.close(win), key: '⌃W' }
    ]);
  }
  duplicate(win) {
    const state = win.instance && win.instance.serialize ? win.instance.serialize() : {};
    return this.open(win.app.id, {
      state, allowDuplicate: true,
      rect: { ...win.rect, x: win.rect.x + 28, y: win.rect.y + 28 }
    });
  }

  // ───────── persistence ─────────
  serialize() {
    return {
      v: 1, active: this.active, desk: { w: this.W, h: this.H }, viewport: { ...this.viewport },
      windows: [...this.windows].sort((a, b) => a.z - b.z).map((w) => {
        let state = {};
        try { state = w.instance && w.instance.serialize ? w.instance.serialize() : {}; } catch (e) { console.error(e); }
        return { app: w.app.id, ws: w.ws, rect: w.rect, restoreRect: w.restoreRect, min: w.min, max: w.max, pinned: w.pinned, snap: w.snapZone, title: w.title !== w.app.title ? w.title : undefined, state, focused: w === this.focused };
      })
    };
  }
  async restoreLayout(layout, { replace = true } = {}) {
    if (!layout || !Array.isArray(layout.windows)) return;
    if (replace && !(await this.closeAll())) return;
    const sx = layout.desk && layout.desk.w ? this.W / layout.desk.w : 1;
    const sy = layout.desk && layout.desk.h ? this.H / layout.desk.h : 1;
    const viewport = layout.viewport || { zoom: 1, panX: 0, panY: 0 };
    const panX = Number.isFinite(viewport.panX) ? viewport.panX * sx : 0;
    const panY = Number.isFinite(viewport.panY) ? viewport.panY * sy : 0;
    this.setViewportTransform(1, panX, panY);
    const scale = (r) => r && ({ x: Math.round(r.x * sx), y: Math.round(r.y * sy), w: Math.round(r.w * sx), h: Math.round(r.h * sy) });
    this.restoring = true;
    let focusWin = null;
    this.active = Math.min(WORKSPACES - 1, layout.active || 0);
    for (const w of layout.windows) {
      if (!this.apps.has(w.app)) continue;
      const win = await this.open(w.app, { rect: scale(w.rect), workspace: w.ws, pinned: w.pinned, maximized: w.max, snap: w.snap, minimized: w.min, title: w.title, state: w.state, focus: false });
      if (win) { if (w.restoreRect) win.restoreRect = scale(w.restoreRect); if (w.focused) focusWin = win; }
    }
    this.restoring = false;
    for (const w of this.windows) this.sync(w);
    if (focusWin && focusWin.visible) this.focus(focusWin); else this.focusTop();
    this.changed('restore');
  }

  changed(kind, light = false) {
    bus.emit('wm:changed', kind);
    if (!light && !this.restoring) bus.emit('wm:persist');
  }
}

export const wm = new WindowManager();
