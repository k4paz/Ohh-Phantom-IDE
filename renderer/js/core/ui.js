// Overlays: modals, prompts, confirms, toasts, context menus, palette, tooltips.
import { h, esc, icon, fuzzy, markIdx } from './dom.js';

const root = () => document.getElementById('overlay-root');

// ───────── toasts ─────────
let toastBox = null;
export function toast(message, level = 'info', title, ms = 3800) {
  if (!toastBox) { toastBox = h('div.toasts'); root().appendChild(toastBox); }
  const t = h('div.toast.' + level, h('b', title || (level === 'error' ? 'ERROR' : level === 'warn' ? 'WARNING' : 'PHANTOM')), String(message));
  toastBox.appendChild(t);
  const kill = () => { t.classList.add('out'); setTimeout(() => t.remove(), 200); };
  t.addEventListener('click', kill);
  setTimeout(kill, level === 'error' ? ms * 2 : ms);
  while (toastBox.children.length > 5) toastBox.firstChild.remove();
}
export const fail = (e, title) => toast(e && e.message ? e.message : String(e), 'error', title);

// ───────── modal base ─────────
function modal({ title, body, buttons, danger, onKey, width }) {
  return new Promise((resolve) => {
    const scrim = h('div.scrim');
    const foot = h('div.foot');
    const box = h('div.modal' + (danger ? '.danger' : ''), { style: width ? { width } : null }, h('h3', title), h('div.body', body), foot);
    const close = (v) => { scrim.remove(); box.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    for (const b of buttons) foot.appendChild(h('button.btn' + (b.cls ? '.' + b.cls : ''), { on: { click: () => close(b.value()) } }, b.label));
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (onKey) onKey(e, close);
    };
    document.addEventListener('keydown', key, true);
    scrim.addEventListener('mousedown', () => close(null));
    root().append(scrim, box);
    const f = box.querySelector('input,textarea,select') || foot.lastChild;
    setTimeout(() => f && f.focus(), 10);
  });
}

export function prompt(title, value = '', { placeholder = '', label = '', select = true } = {}) {
  const inp = h('input.inp', { value, placeholder, spellcheck: false });
  if (select) setTimeout(() => { inp.select(); const dot = value.lastIndexOf('.'); if (dot > 0 && !value.includes('/')) inp.setSelectionRange(0, dot); }, 20);
  return modal({
    title, body: [label ? h('div.c-dim', label) : null, inp],
    buttons: [{ label: 'CANCEL', value: () => null }, { label: 'OK', cls: 'primary', value: () => inp.value }],
    onKey: (e, close) => { if (e.key === 'Enter') { e.preventDefault(); close(inp.value); } }
  });
}

export function confirm(title, message, { ok = 'CONFIRM', danger = false } = {}) {
  return modal({
    title, danger, body: message,
    buttons: [{ label: 'CANCEL', value: () => false }, { label: ok, cls: danger ? 'danger' : 'primary', value: () => true }],
    onKey: (e, close) => { if (e.key === 'Enter') { e.preventDefault(); close(true); } }
  }).then((v) => !!v);
}

/** Three-way choice for unsaved changes. Resolves 'save' | 'discard' | null. */
export function choice(title, message, options) {
  return modal({ title, body: message, buttons: options.map((o) => ({ label: o.label, cls: o.cls, value: () => o.value })) });
}

/** Simple form modal. fields: [{key,label,type,value,options,placeholder}] */
export function form(title, fields, { ok = 'SAVE', width } = {}) {
  const inputs = {};
  const rows = fields.map((f) => {
    let el;
    if (f.type === 'select') el = h('select.inp', f.options.map((o) => h('option', { value: o.value ?? o, selected: (o.value ?? o) === f.value }, o.label ?? o)));
    else if (f.type === 'textarea') el = h('textarea.inp', { rows: f.rows || 4, placeholder: f.placeholder || '', spellcheck: false }, f.value || '');
    else if (f.type === 'checkbox') el = h('input', { type: 'checkbox', checked: !!f.value });
    else el = h('input.inp', { type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '', spellcheck: false });
    inputs[f.key] = el;
    return f.type === 'checkbox' ? h('label.chk', el, f.label) : h('label', { style: { display: 'grid', gap: '3px' } }, h('span.c-dim', f.label), el);
  });
  return modal({
    title, width, body: rows,
    buttons: [{ label: 'CANCEL', value: () => null }, {
      label: ok, cls: 'primary',
      value: () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]))
    }],
    onKey: (e, close) => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        close(Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value])));
      }
    }
  });
}

// ───────── context menu ─────────
let ctxEl = null;
export function closeMenu() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
/** items: [{label, action, key, check, danger, disabled} | '-' | {header}] */
export function menu(x, y, items) {
  closeMenu();
  const el = h('div.ctx');
  const list = h('div.ctx-list');
  const searchable = items.filter((it) => it && it !== '-' && !it.header).length >= 8;
  const search = searchable ? h('input.ctx-search', {
    type: 'search', placeholder: 'Search actions...', spellcheck: false, 'aria-label': 'Search menu'
  }) : null;
  let activeIndex = -1;
  let wheelDelta = 0;
  const selectableRows = () => [...list.querySelectorAll('.it:not(.dis)')];
  const select = (index, scroll = true) => {
    const rows = selectableRows();
    if (!rows.length) { activeIndex = -1; return; }
    activeIndex = (index + rows.length) % rows.length;
    rows.forEach((row, i) => row.classList.toggle('on', i === activeIndex));
    if (scroll) rows[activeIndex].scrollIntoView({ block: 'nearest' });
  };
  const appendItem = (it) => {
    if (!it) return;
    if (it === '-') { list.appendChild(h('div.sep')); return; }
    if (it.header) { list.appendChild(h('div.lbl', it.header)); return; }
    list.appendChild(h('div.it' + (it.danger ? '.danger' : '') + (it.disabled ? '.dis' : ''), {
      on: { mousedown: (e) => e.stopPropagation(), click: () => { closeMenu(); it.action && it.action(); } }
    }, h('span.ck', it.check ? '✓' : ''), h('span.ctx-label', it.label), it.key ? h('span.k', it.key) : null));
  };
  const render = () => {
    list.innerHTML = '';
    activeIndex = -1;
    wheelDelta = 0;
    el.classList.remove('wheel-nav');
    const query = search && search.value.trim().toLowerCase();
    const visible = query
      ? items.filter((it) => it && it !== '-' && !it.header && `${it.label || ''} ${it.key || ''}`.toLowerCase().includes(query))
      : items;
    if (query && !visible.length) list.appendChild(h('div.ctx-empty', 'no matches'));
    else visible.forEach(appendItem);
  };
  if (search) {
    search.addEventListener('input', render);
    el.append(search, list);
  } else el.appendChild(list);
  el.tabIndex = -1;
  el.addEventListener('wheel', (e) => {
    if (!selectableRows().length || !e.deltaY) return;
    e.preventDefault();
    wheelDelta += e.deltaY;
    if (Math.abs(wheelDelta) < 30) return;
    const direction = Math.sign(wheelDelta);
    wheelDelta = 0;
    el.classList.add('wheel-nav');
    select(activeIndex < 0 ? (direction > 0 ? 0 : selectableRows().length - 1) : activeIndex + direction);
  }, { passive: false });
  el.addEventListener('mousemove', (e) => {
    const row = e.target.closest('.it:not(.dis)');
    if (!row || !list.contains(row)) return;
    const index = selectableRows().indexOf(row);
    if (index >= 0 && index !== activeIndex) {
      el.classList.remove('wheel-nav');
      select(index, false);
    }
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const direction = e.key === 'ArrowDown' ? 1 : -1;
      select(activeIndex < 0 ? (direction > 0 ? 0 : selectableRows().length - 1) : activeIndex + direction);
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      selectableRows()[activeIndex]?.click();
    }
  });
  render();
  root().appendChild(el);
  ctxEl = el;
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 4) + 'px';
  el.style.top = Math.min(y, innerHeight - r.height - 4) + 'px';
  if (search) search.focus();
  else el.focus({ preventScroll: true });
}
document.addEventListener('mousedown', (e) => { if (ctxEl && !ctxEl.contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('blur', closeMenu);

// ───────── palette ─────────
/**
 * items: [{label, detail, icon, key, group, run}] or async (query) => items
 * Returns a promise resolving to the picked item (after running it).
 */
export function palette({ placeholder = 'Type a command…', items, prefix = '>', footer, initial = '' }) {
  return new Promise((resolve) => {
    const scrim = h('div.scrim', { style: { background: 'rgba(0,0,0,.35)' } });
    const input = h('input', { placeholder, spellcheck: false, value: initial });
    const list = h('div.list');
    const box = h('div.palette', h('div.q', h('span', prefix), input), list, h('div.foot', footer || '↑↓ navigate · ↵ run · esc close'));
    let shown = []; let sel = 0; let seq = 0;
    const close = (v) => { scrim.remove(); box.remove(); resolve(v || null); };
    const render = async () => {
      const q = input.value.trim();
      const my = ++seq;
      const src = typeof items === 'function' ? await items(q) : items;
      if (my !== seq) return;
      let scored;
      if (typeof items === 'function' && src.prescored) scored = src.map((it) => ({ it, m: it.match || { idx: [] } }));
      else scored = src.map((it) => ({ it, m: fuzzy(q, it.label + (it.detail && q.includes(' ') ? ' ' + it.detail : '')) || (it.detail ? fuzzy(q, it.detail) && { score: -5, idx: [] } : null) })).filter((x) => x.m);
      if (q) scored.sort((a, b) => b.m.score - a.m.score);
      shown = scored.slice(0, 200);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.innerHTML = '';
      let lastGroup = null;
      shown.forEach(({ it, m }, i) => {
        if (!q && it.group && it.group !== lastGroup) { list.appendChild(h('div.group', it.group)); lastGroup = it.group; }
        const row = h('div.item' + (i === sel ? '.on' : ''), { html: `${icon(it.icon || 'chev')}<span class="t">${markIdx(it.label, m.idx)}</span>${it.detail ? `<span class="d">${esc(it.detail)}</span>` : ''}${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}` });
        row.addEventListener('mousemove', () => { if (sel !== i) { sel = i; mark(); } });
        row.addEventListener('click', () => pick(i));
        list.appendChild(row);
      });
      if (!shown.length) list.appendChild(h('div.item', { style: { color: 'var(--mute)' } }, 'no matches'));
    };
    const mark = () => { const rows = list.querySelectorAll('.item'); rows.forEach((r, i) => r.classList.toggle('on', i === sel)); rows[sel] && rows[sel].scrollIntoView({ block: 'nearest' }); };
    const pick = (i) => { const x = shown[i]; if (!x) return; close(x.it); setTimeout(() => x.it.run && x.it.run(), 0); };
    input.addEventListener('input', () => { sel = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
    });
    scrim.addEventListener('mousedown', () => close(null));
    root().append(scrim, box);
    input.focus();
    render();
  });
}

// ───────── tooltip ─────────
let tip = null;
export function tooltip(el, text, sub) {
  el.addEventListener('mouseenter', () => {
    tip = h('div.tooltip', text, sub ? h('small', sub) : null);
    root().appendChild(tip);
    const r = el.getBoundingClientRect(); const t = tip.getBoundingClientRect();
    let x = r.right + 8; let y = r.top + r.height / 2 - t.height / 2;
    if (x + t.width > innerWidth) { x = r.left + r.width / 2 - t.width / 2; y = r.bottom + 6; }
    tip.style.left = Math.max(4, x) + 'px'; tip.style.top = Math.max(4, y) + 'px';
  });
  el.addEventListener('mouseleave', () => { if (tip) { tip.remove(); tip = null; } });
  el.addEventListener('mousedown', () => { if (tip) { tip.remove(); tip = null; } });
}

/** Draggable splitter between two flex panes. */
export function splitter(gutter, target, { axis = 'x', min = 80, onResize, invert = false } = {}) {
  gutter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    gutter.setPointerCapture(e.pointerId);
    gutter.classList.add('drag');
    document.body.classList.add('wm-busy');
    const start = axis === 'x' ? e.clientX : e.clientY;
    const size = axis === 'x' ? target.offsetWidth : target.offsetHeight;
    const move = (ev) => {
      const d = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      const v = Math.max(min, size + (invert ? -d : d));
      target.style.flex = `0 0 ${v}px`;
      onResize && onResize(v);
    };
    const up = () => { gutter.classList.remove('drag'); document.body.classList.remove('wm-busy'); gutter.removeEventListener('pointermove', move); gutter.removeEventListener('pointerup', up); };
    gutter.addEventListener('pointermove', move);
    gutter.addEventListener('pointerup', up);
  });
}
