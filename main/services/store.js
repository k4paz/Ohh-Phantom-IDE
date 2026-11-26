'use strict';
// Small JSON key/value store in the app data dir (settings, layouts, session, history…).
const path = require('path');
const { readJson, writeJsonAtomic } = require('../util');

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

module.exports = (core) => {
  const dir = path.join(core.dataDir, 'store');
  const cache = new Map();
  const writes = new Map(); // key -> promise chain (serialize writes per key)

  const file = (key) => {
    if (!KEY_RE.test(key)) throw new Error('Invalid store key');
    return path.join(dir, key + '.json');
  };

  return {
    'store:get': async (key, fallback = null) => {
      if (cache.has(key)) return cache.get(key);
      const v = await readJson(file(key), fallback);
      cache.set(key, v);
      return v;
    },
    'store:set': async (key, value) => {
      const f = file(key);
      const json = JSON.stringify(value);
      if (json && json.length > 20 * 1024 * 1024) throw new Error('Value too large');
      const prev = writes.get(key) || Promise.resolve();
      const next = prev.catch(() => {}).then(() => writeJsonAtomic(f, value)).then(() => {
        cache.set(key, value);
        return true;
      }).catch((e) => {
        core.log('error', 'store write failed: ' + e.message);
        throw e;
      });
      writes.set(key, next);
      await next;
      return true;
    }
  };
};
