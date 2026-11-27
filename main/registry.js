'use strict';
// Builds the backend "core" object and loads every service module.
// Each service is `module.exports = (core) => ({ 'ns:method': async (...args) => result })`.
// Optionally a service may export `shutdown` via core.onShutdown.
const { EventEmitter } = require('events');
const path = require('path');

const SERVICES = [
  'app', 'store', 'fs', 'watch', 'pty', 'sys', 'proc', 'net', 'git', 'search',
  'http', 'db', 'ssh', 'audit', 'tasks', 'debug', 'arch', 'logs', 'collab', 'events', 'agents', 'flow',
  'flow-workspaces'
];

const CHANNEL_RE = /^[a-z]+:[a-zA-Z]+(?::[a-zA-Z][a-zA-Z-]*)*$/;

function createCore({ dataDir, emit, platformHooks = {} }) {
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const shutdownHooks = [];
  const logBuffer = [];
  const fileWriteQueues = new Map();
  const withFileLock = (file, action) => {
    const resolved = path.resolve(file);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const previous = fileWriteQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    fileWriteQueues.set(key, current);
    return current.finally(() => {
      if (fileWriteQueues.get(key) === current) fileWriteQueues.delete(key);
    });
  };
  const withFileLocks = (files, action) => {
    const locks = [...new Set(files.map((file) => {
      const resolved = path.resolve(file);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    }))].sort();
    const acquire = (index) => index === locks.length
      ? action()
      : withFileLock(locks[index], () => acquire(index + 1));
    return acquire(0);
  };

  const core = {
    dataDir,
    withFileLock,
    withFileLocks,
    bus,
    hooks: platformHooks, // electron-only capabilities: dialog, trash, reveal, window controls
    emit(channel, payload) {
      try { emit(channel, payload); } catch { /* window gone */ }
    },
    log(level, message, source = 'APP') {
      const entry = { ts: Date.now(), level, source, message: String(message) };
      logBuffer.push(entry);
      if (logBuffer.length > 2000) logBuffer.splice(0, logBuffer.length - 2000);
      core.emit('app:log', entry);
      bus.emit('event', { source, level, message: entry.message });
    },
    logs: () => logBuffer.slice(),
    event(source, message, level = 'info', data) {
      bus.emit('event', { source, level, message, data });
    },
    onShutdown(fn) { shutdownHooks.push(fn); },
    async shutdown() {
      for (const fn of shutdownHooks) { try { await fn(); } catch { /* best effort */ } }
    }
  };

  const handlers = new Map();
  for (const name of SERVICES) {
    const factory = require(path.join(__dirname, 'services', name + '.js'));
    const table = factory(core);
    for (const [channel, fn] of Object.entries(table)) {
      if (!CHANNEL_RE.test(channel)) throw new Error('Bad channel name ' + channel);
      if (handlers.has(channel)) throw new Error('Duplicate channel ' + channel);
      handlers.set(channel, fn);
    }
  }
  core.handlers = handlers;
  core.log('info', `backend online: ${handlers.size} channels across ${SERVICES.length} services`, 'SYS');
  return core;
}

module.exports = { createCore, CHANNEL_RE };
