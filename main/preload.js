'use strict';
// Sandboxed preload: exposes a narrow, typed bridge. No Node APIs leak to the page.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL_RE = /^[a-z]+:[a-zA-Z]+(?::[a-zA-Z][a-zA-Z-]*)*$/;
const listeners = new Map(); // channel -> Set<fn>

function ensure(channel) {
  if (listeners.has(channel)) return listeners.get(channel);
  const set = new Set();
  listeners.set(channel, set);
  ipcRenderer.on(channel, (_e, payload) => { for (const fn of set) { try { fn(payload); } catch (err) { console.error(err); } } });
  return set;
}

contextBridge.exposeInMainWorld('phantom', {
  platform: process.platform,
  async invoke(channel, ...args) {
    if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) throw new Error('bad channel');
    const r = await ipcRenderer.invoke(channel, ...args);
    if (r && r.__ok) return r.v;
    throw new Error((r && r.__err) || 'unknown backend error');
  },
  on(channel, fn) {
    if (typeof channel !== 'string' || !CHANNEL_RE.test(channel) || typeof fn !== 'function') throw new Error('bad listener');
    const set = ensure(channel);
    set.add(fn);
    return () => set.delete(fn);
  }
});
