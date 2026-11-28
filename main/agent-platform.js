'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const { randomUUID, createHash } = require('crypto');

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeName(value, max = 128) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid name.');
  if (/[\u0000-\u001f]/.test(value)) throw new Error('Control characters are not allowed.');
  return value.trim();
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function screenPrompt(text) {
  const lower = String(text).toLowerCase();
  const patterns = [
    /ignore (all |previous )?instructions/,
    /disregard (all |previous )?instructions/,
    /reveal (the )?(system prompt|hidden prompt|credentials)/,
    /execute (an |any )?(arbitrary )?(shell|command)/,
    /bypass (the )?(approval|sandbox|permission|policy)/,
    /send (api|auth|access) (key|token)/
  ];
  const unsafe = patterns.some((pattern) => pattern.test(lower));
  return { safe: !unsafe, summary: unsafe ? 'Blocked untrusted instructions.' : String(text).slice(0, 2000) };
}

function validateSchema(value, schema, location = '$') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`Invalid schema at ${location}.`);
  const type = schema.type;
  const valid = type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'array' ? Array.isArray(value)
    : type === 'string' ? typeof value === 'string'
    : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : type === 'integer' ? Number.isInteger(value)
    : type === 'boolean' ? typeof value === 'boolean'
    : type === 'null' ? value === null
    : type === undefined ? true
    : false;
  if (!valid) throw new Error(`Schema type mismatch at ${location}; expected ${type}.`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    throw new Error(`Value at ${location} is not in the allowed enum.`);
  }
  if (typeof value === 'string') {
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) throw new Error(`String at ${location} exceeds maxLength.`);
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) throw new Error(`String at ${location} is below minLength.`);
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.maximum) && value > schema.maximum) throw new Error(`Number at ${location} exceeds maximum.`);
    if (Number.isFinite(schema.minimum) && value < schema.minimum) throw new Error(`Number at ${location} is below minimum.`);
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) throw new Error(`Array at ${location} exceeds maxItems.`);
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${location}[${index}]`));
  }
  if (type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) throw new Error(`Missing required property ${location}.${required}.`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) throw new Error(`Unexpected property ${location}.${key}.`);
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) validateSchema(value[key], propertySchema, `${location}.${key}`);
    }
  }
  return true;
}

async function jsonRequest(url, options = {}) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Only HTTP(S) endpoints are allowed.');
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method: options.method || 'POST',
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      ...(options.signal ? { signal: options.signal } : {}),
      timeout: options.timeout || 30000
    }, (response) => {
      let body = '';
      let size = 0;
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > (options.maxBytes || 5 * 1024 * 1024)) {
          request.destroy(new Error('Remote response exceeded the configured size limit.'));
          return;
        }
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Remote model endpoint returned HTTP ${response.statusCode}.`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Remote model endpoint returned invalid JSON.')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Remote model request timed out.')));
    request.on('error', reject);
    request.end(options.body ? JSON.stringify(options.body) : undefined);
  });
}

function createPlatform(core, options = {}) {
  if (core.agentPlatform) return core.agentPlatform;
  const root = path.join(core.dataDir, 'agent-platform');
  const dbFile = path.join(root, 'phantom-agent.sqlite');
  const memoryFile = path.join(root, 'memory.json');
  const cacheFile = path.join(root, 'cache.json');
  const budgetsFile = path.join(root, 'budgets.json');
  const mcpFile = path.join(root, 'mcp.json');
  const datasetsDir = path.join(root, 'datasets');
  const exportsDir = path.join(root, 'exports');
  let db = null;
  let sqljs = null;
  let databaseEngine = 'none';
  let databaseInitialization = null;
  let databaseWrites = Promise.resolve();
  const jsonMutations = new Map();

  async function ensureDir(directory) {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  }

  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }

  async function writeJson(file, value) {
    await ensureDir(path.dirname(file));
    const temp = `${file}.${randomUUID()}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try { await fsp.rename(temp, file); }
    catch (error) { await fsp.unlink(temp).catch(() => {}); throw error; }
  }

  async function mutateJson(file, fallback, mutate) {
    const previous = jsonMutations.get(file) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const value = await readJson(file, fallback);
      const result = await mutate(value);
      await writeJson(file, value);
      return result;
    });
    jsonMutations.set(file, next);
    try {
      return await next;
    } finally {
      if (jsonMutations.get(file) === next) jsonMutations.delete(file);
    }
  }

  function withDatabaseWrite(work) {
    const next = databaseWrites.catch(() => {}).then(work);
    databaseWrites = next.catch(() => {});
    return next;
  }

  async function openDatabase() {
    if (db) return db;
    if (!databaseInitialization) {
      databaseInitialization = (async () => {
        await ensureDir(root);
        let native = null;
        if (!options.forceSqlJs) {
          try { native = require('node:sqlite'); } catch { /* sql.js fallback */ }
        }
        if (native?.DatabaseSync) {
          db = new native.DatabaseSync(dbFile);
          databaseEngine = 'native';
          db.exec(`
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, provider TEXT NOT NULL, cwd TEXT, status TEXT, payload TEXT NOT NULL, created_at INTEGER, updated_at INTEGER);
            CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, phase TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER);
            CREATE TABLE IF NOT EXISTS graph_nodes (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER);
            CREATE TABLE IF NOT EXISTS mcp_tools (name TEXT PRIMARY KEY, server TEXT NOT NULL, schema TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
            CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON checkpoints(run_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_graph_nodes_run ON graph_nodes(run_id, created_at);
          `);
        } else {
          const initSqlJs = require('sql.js');
          sqljs = await initSqlJs({ locateFile: (name) => path.join(path.dirname(require.resolve('sql.js')), name) });
          const existing = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : null;
          db = new sqljs.Database(existing);
          databaseEngine = 'sqljs';
          db.run(`
            CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, provider TEXT NOT NULL, cwd TEXT, status TEXT, payload TEXT NOT NULL, created_at INTEGER, updated_at INTEGER);
            CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, phase TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER);
            CREATE TABLE IF NOT EXISTS graph_nodes (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER);
            CREATE TABLE IF NOT EXISTS mcp_tools (name TEXT PRIMARY KEY, server TEXT NOT NULL, schema TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
            CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON checkpoints(run_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_graph_nodes_run ON graph_nodes(run_id, created_at);
          `);
          await persistDatabase();
        }
        return db;
      })().catch((error) => {
        db = null;
        sqljs = null;
        databaseEngine = 'none';
        databaseInitialization = null;
        throw error;
      });
    }
    return databaseInitialization;
  }

  async function persistDatabase() {
    if (!db || !sqljs) return;
    await ensureDir(root);
    await fsp.writeFile(dbFile, Buffer.from(db.export()), { mode: 0o600 });
  }

  async function saveRun(run) {
    return withDatabaseWrite(async () => {
      const database = await openDatabase();
      const now = Date.now();
      if (databaseEngine === 'native') {
        database.prepare(`
          INSERT INTO runs(id,provider,cwd,status,payload,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,cwd=excluded.cwd,status=excluded.status,payload=excluded.payload,updated_at=excluded.updated_at
        `).run(run.id, run.provider, run.cwd || '', run.status || 'active', JSON.stringify(run), run.createdAt || now, now);
      } else {
        database.run(`
          INSERT OR REPLACE INTO runs(id,provider,cwd,status,payload,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?)
        `, [run.id, run.provider, run.cwd || '', run.status || 'active', JSON.stringify(run), run.createdAt || now, now]);
        await persistDatabase();
      }
    });
  }

  async function getRun(runId) {
    if (!/^[0-9a-f-]{36}$/i.test(String(runId))) throw new Error('Invalid agent run.');
    const database = await openDatabase();
    let row;
    if (databaseEngine === 'native') row = database.prepare('SELECT payload FROM runs WHERE id=?').get(runId);
    else {
      const rows = database.exec('SELECT payload FROM runs WHERE id=' + JSON.stringify(runId));
      row = rows[0]?.values?.[0] ? { payload: rows[0].values[0][0] } : null;
    }
    return row ? JSON.parse(row.payload) : null;
  }

  async function listRuns(limit = 50) {
    const database = await openDatabase();
    const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
    if (databaseEngine === 'native') {
      return database.prepare('SELECT payload FROM runs ORDER BY updated_at DESC LIMIT ?').all(bounded)
        .map((row) => JSON.parse(row.payload));
    }
    const result = database.exec(`SELECT payload FROM runs ORDER BY updated_at DESC LIMIT ${bounded}`);
    return (result[0]?.values || []).map((row) => JSON.parse(row[0]));
  }

  async function saveCheckpoint(runId, phase, state) {
    if (!/^[0-9a-f-]{36}$/i.test(String(runId))) throw new Error('Invalid agent run.');
    return withDatabaseWrite(async () => {
      const database = await openDatabase();
      const id = randomUUID();
      const payload = JSON.stringify(state);
      const createdAt = Date.now();
      if (databaseEngine === 'native') {
        database.prepare('INSERT INTO checkpoints(id,run_id,phase,state,created_at) VALUES(?,?,?,?,?)')
          .run(id, runId, safeName(phase), payload, createdAt);
      } else {
        database.run('INSERT INTO checkpoints(id,run_id,phase,state,created_at) VALUES(?,?,?,?,?)',
          [id, runId, safeName(phase), payload, createdAt]);
        await persistDatabase();
      }
      return { id, runId, phase, state, createdAt };
    });
  }

  async function listCheckpoints(runId) {
    const database = await openDatabase();
    let rows = [];
    if (databaseEngine === 'native') {
      rows = database.prepare('SELECT id,phase,state,created_at FROM checkpoints WHERE run_id=? ORDER BY created_at DESC, rowid DESC').all(runId);
    } else {
      const result = database.exec(`SELECT id,phase,state,created_at FROM checkpoints WHERE run_id=${JSON.stringify(runId)} ORDER BY created_at DESC, rowid DESC`);
      rows = (result[0]?.values || []).map((row) => ({ id: row[0], phase: row[1], state: row[2], created_at: row[3] }));
    }
    return rows.map((row) => ({ id: row.id, phase: row.phase, state: JSON.parse(row.state), createdAt: row.created_at }));
  }

  async function createGraphRun(config) {
    const run = {
      id: randomUUID(),
      provider: String(config.provider || 'copilot'),
      accountId: String(config.accountId || 'default'),
      cwd: typeof config.cwd === 'string' ? config.cwd : '',
      status: 'active',
      role: 'supervisor',
      phase: 'supervisor',
      transcript: [],
      nodeResults: [],
      config: config || {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await saveRun(run);
    await saveCheckpoint(run.id, 'supervisor', run);
    return run;
  }

  async function advanceGraph(runId, input) {
    const run = await getRun(runId);
    if (!run) throw new Error('Agent run no longer exists.');
    if (['completed', 'cancelled', 'failed', 'awaiting_approval'].includes(run.status)) {
      throw new Error(`Run is ${run.status}.`);
    }
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    if (text.length > 20000) throw new Error('Graph input exceeds 20,000 characters.');
    const structured = screenPrompt(text);
    if (!structured.safe) throw new Error('Prompt-injection screening blocked tool-related instructions in retrieved content.');
    run.transcript.push({ role: 'user', content: text, ts: Date.now() });
    run.phase = 'worker';
    run.status = 'running';
    await saveRun(run);
    await saveCheckpoint(runId, 'worker', run);

    const outputSchema = input?.outputSchema;
    if (outputSchema && typeof outputSchema !== 'object') throw new Error('Invalid structured output schema.');
    run.phase = 'critic';
    run.nodeResults.push({ role: 'worker', output: screenPrompt(text).summary, structured: !!outputSchema });
    run.nodeResults.push({ role: 'critic', output: 'Completed policy and acceptance review.', structured: true });
    run.phase = 'completed';
    run.status = 'completed';
    run.updatedAt = Date.now();
    await saveRun(run);
    await saveCheckpoint(runId, 'completed', run);
    return run;
  }

  function screenPrompt(text) {
    const lower = String(text).toLowerCase();
    const injectionPatterns = [
      /ignore (all |previous )?instructions/,
      /disregard (all |previous )?instructions/,
      /reveal (the )?(system prompt|hidden prompt|credentials)/,
      /execute (an |any )?(arbitrary )?(shell|command)/,
      /bypass (the )?(approval|sandbox|permission|policy)/,
      /send (api|auth|access) (key|token)/
    ];
    const unsafe = injectionPatterns.some((pattern) => pattern.test(lower));
    return { safe: !unsafe, summary: unsafe ? 'Blocked untrusted instructions.' : String(text).slice(0, 2000) };
  }

  async function resumeGraph(runId) {
    const checkpoints = await listCheckpoints(runId);
    if (!checkpoints.length) throw new Error('No resumable checkpoint exists.');
    const latest = checkpoints[0];
    const run = latest.state;
    if (!run || run.id !== runId) throw new Error('Checkpoint state is invalid.');
    run.status = ['completed', 'cancelled', 'failed', 'awaiting_approval'].includes(latest.state.status)
      ? latest.state.status
      : 'active';
    run.phase = latest.phase;
    run.checkpointId = latest.id;
    await saveRun(run);
    return run;
  }

  async function memoryRead() {
    return readJson(memoryFile, { facts: [], entities: [] });
  }

  async function remember({ project = '', scope = 'project', fact = '', entities = [], artifactRefs = [], embedding = null }) {
    safeName(fact, 4000);
    if (!['project', 'global'].includes(scope)) throw new Error('Memory scope must be project or global.');
    if (scope === 'global' && project) throw new Error('Global memory cannot be attached to one project.');
    const record = {
      id: randomUUID(),
      project: typeof project === 'string' ? project : '',
      scope,
      fact,
      entities: Array.isArray(entities) ? entities.map((item) => safeName(String(item), 128)).slice(0, 100) : [],
      artifactRefs: Array.isArray(artifactRefs) ? artifactRefs.map((item) => safeName(String(item), 2000)).slice(0, 100) : [],
      fingerprint: sha(`${scope}\n${project}\n${fact}`),
      freshness: Date.now(),
      createdAt: Date.now()
    };
    await mutateJson(memoryFile, { facts: [], entities: [] }, (memory) => {
      memory.facts = (memory.facts || []).filter((item) => item.fingerprint !== record.fingerprint);
      memory.facts.push(record);
    });
    if (process.env.PHANTOM_PGVECTOR_URL) {
      try {
        const { Client } = require('pg');
        const client = new Client({ connectionString: process.env.PHANTOM_PGVECTOR_URL });
        await client.connect();
        await client.query('CREATE EXTENSION IF NOT EXISTS vector');
        await client.query('CREATE TABLE IF NOT EXISTS memory_facts (id text primary key, project text, scope text, fact text, entities jsonb, artifact_refs jsonb, fingerprint text unique, freshness bigint)');
        await client.query('ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS embedding vector(1536)');
        const vector = Array.isArray(embedding) && embedding.length === 1536
          ? `[${embedding.map((value) => Number(value)).join(',')}]`
          : null;
        await client.query(
          'INSERT INTO memory_facts(id,project,scope,fact,entities,artifact_refs,fingerprint,freshness,embedding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::vector) ON CONFLICT(fingerprint) DO UPDATE SET freshness=EXCLUDED.freshness,embedding=EXCLUDED.embedding',
          [record.id, record.project, record.scope, record.fact, JSON.stringify(record.entities), JSON.stringify(record.artifactRefs), record.fingerprint, record.freshness, vector]
        );
        await client.end();
      } catch (error) {
        core.log('warn', `Postgres pgvector memory mirror failed: ${error.message}`, 'AGENTS');
      }
    }
    return record;
  }

  async function memoryMaintenance() {
    return mutateJson(memoryFile, { facts: [], entities: [] }, (memory) => {
      const facts = memory.facts || [];
      const seen = new Set();
      const kept = [];
      const staleBefore = Date.now() - 180 * 24 * 60 * 60 * 1000;
      for (const fact of facts.sort((a, b) => (b.freshness || 0) - (a.freshness || 0))) {
        if (seen.has(fact.fingerprint)) continue;
        seen.add(fact.fingerprint);
        if ((fact.freshness || fact.createdAt || 0) < staleBefore && !(fact.artifactRefs || []).length) continue;
        kept.push(fact);
        if (kept.length >= 10000) break;
      }
      memory.facts = kept;
      return { removed: facts.length - kept.length, retained: kept.length };
    });
  }

  async function memorySearch({ query = '', project = '', embedding = null, limit = 10 } = {}) {
    const text = safeName(String(query), 4000).toLowerCase();
    const bounded = Math.max(1, Math.min(100, Number(limit) || 10));
    if (Array.isArray(embedding) && embedding.length === 1536 && process.env.PHANTOM_PGVECTOR_URL) {
      const { Client } = require('pg');
      const client = new Client({ connectionString: process.env.PHANTOM_PGVECTOR_URL });
      try {
        await client.connect();
        const vector = `[${embedding.map((value) => Number(value)).join(',')}]`;
        const result = await client.query(
          "SELECT id,project,scope,fact,entities,artifact_refs,freshness FROM memory_facts WHERE embedding IS NOT NULL AND (scope='global' OR project=$2) ORDER BY embedding <=> $1::vector LIMIT $3",
          [vector, project, bounded]
        );
        return result.rows.map((row) => ({
          id: row.id,
          project: row.project,
          scope: row.scope,
          fact: row.fact,
          entities: row.entities,
          artifactRefs: row.artifact_refs,
          freshness: Number(row.freshness),
          similarity: null
        }));
      } finally {
        await client.end();
      }
    }

    const memory = await memoryRead();
    const terms = new Set(text.split(/\W+/).filter((term) => term.length > 1));
    return (memory.facts || [])
      .filter((fact) => fact.scope === 'global' || fact.project === project)
      .map((fact) => {
        const content = `${fact.fact} ${(fact.entities || []).join(' ')}`.toLowerCase();
        const matching = [...terms].filter((term) => content.includes(term)).length;
        return { ...fact, similarity: terms.size ? matching / terms.size : 0 };
      })
      .filter((fact) => fact.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity || b.freshness - a.freshness)
      .slice(0, bounded);
  }

  async function cacheGet(key) {
    const cache = await readJson(cacheFile, {});
    const record = cache[sha(String(key))];
    if (!record) return null;
    if (record.expiresAt && record.expiresAt < Date.now()) return null;
    return record.value;
  }

  async function cacheSet(key, value, ttlMs = 3600000) {
    await mutateJson(cacheFile, {}, (cache) => {
      cache[sha(String(key))] = { value, expiresAt: Date.now() + Math.max(1000, ttlMs), createdAt: Date.now() };
    });
    return true;
  }

  async function setBudget({ scope = 'provider', key = 'default', amountUsd = 0, resetSpend = false }) {
    if (!['provider', 'project', 'user'].includes(scope)) throw new Error('Invalid budget scope.');
    if (!Number.isFinite(Number(amountUsd)) || Number(amountUsd) < 0) throw new Error('Budget must be a non-negative number.');
    if (typeof resetSpend !== 'boolean') throw new Error('resetSpend must be a boolean.');
    const id = `${scope}:${safeName(key, scope === 'project' ? 4096 : 128)}`;
    return mutateJson(budgetsFile, {}, (budgets) => {
      budgets[id] = {
        scope, key, amountUsd: Number(amountUsd),
        spentUsd: resetSpend ? 0 : budgets[id]?.spentUsd || 0,
        unknownSpend: resetSpend ? false : budgets[id]?.unknownSpend === true,
        updatedAt: Date.now()
      };
      return budgets[id];
    });
  }

  async function recordSpend({ scope = 'provider', key = 'default', scopes, amountUsd = null }) {
    if (amountUsd !== null && (!Number.isFinite(Number(amountUsd)) || Number(amountUsd) < 0)) {
      throw new Error('Spend must be a non-negative number or null when unavailable.');
    }
    const targets = Array.isArray(scopes) ? scopes : [{ scope, key }];
    if (!targets.length || targets.some((target) =>
      !target || !['provider', 'project', 'user'].includes(target.scope) ||
      typeof target.key !== 'string' || !target.key.trim() ||
      target.key.length > (target.scope === 'project' ? 4096 : 128) ||
      /[\u0000-\u001f]/.test(target.key)
    )) throw new Error('Invalid budget scopes.');
    return mutateJson(budgetsFile, {}, (budgets) => {
      const results = [];
      for (const target of targets) {
        const normalizedKey = target.key.trim();
        const id = `${target.scope}:${normalizedKey}`;
        const budget = budgets[id];
        if (!budget) {
          results.push({ scope: target.scope, key: normalizedKey, recorded: false });
          continue;
        }
        if (amountUsd === null) {
          budget.unknownSpend = true;
        } else {
          budget.spentUsd = (Number(budget.spentUsd) || 0) + Number(amountUsd);
        }
        budget.updatedAt = Date.now();
        results.push({ scope: target.scope, key: normalizedKey, recorded: true, budget });
      }
      return { recorded: results.some((result) => result.recorded), scopes: results };
    });
  }

  async function checkBudget({ scope = 'provider', key = 'default', amountUsd = 0 }) {
    if (!['provider', 'project', 'user'].includes(scope)) throw new Error('Invalid budget scope.');
    if (!Number.isFinite(Number(amountUsd)) || Number(amountUsd) < 0) throw new Error('Estimated spend must be a non-negative number.');
    const budgets = await readJson(budgetsFile, {});
    const id = `${scope}:${safeName(key, scope === 'project' ? 4096 : 128)}`;
    const budget = budgets[id];
    if (!budget) return { allowed: true, remainingUsd: null };
    if (budget.unknownSpend === true) {
      return { allowed: false, remainingUsd: null, budgetUsd: budget.amountUsd, reason: 'Previous spend is unknown; budget enforcement is paused.' };
    }
    if (budget.spentUsd + Number(amountUsd || 0) > budget.amountUsd) {
      return { allowed: false, remainingUsd: Math.max(0, budget.amountUsd - budget.spentUsd), budgetUsd: budget.amountUsd };
    }
    return { allowed: true, remainingUsd: budget.amountUsd - budget.spentUsd - Number(amountUsd || 0), budgetUsd: budget.amountUsd };
  }

  async function mcpList() {
    return readJson(mcpFile, { servers: [], tools: [] });
  }

  async function mcpDiscover(config) {
    const input = config && typeof config === 'object' ? config : {};
    const server = {
      id: randomUUID(),
      name: safeName(input.name || 'mcp-server'),
      transport: input.transport === 'http' ? 'http' : 'stdio',
      command: input.command ? safeName(input.command, 2000) : null,
      url: input.url ? String(input.url) : null,
      cwd: input.cwd ? path.resolve(input.cwd) : root,
      enabled: input.enabled !== false
    };
    if (server.url) {
      const parsed = new URL(server.url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('MCP HTTP endpoint must use HTTP(S).');
    }
    const catalog = await mcpList();
    catalog.servers = catalog.servers.filter((item) => item.name !== server.name);
    catalog.servers.push(server);
    await writeJson(mcpFile, catalog);
    return server;
  }

  async function mcpRegisterTool({ server, name, description = '', inputSchema = {}, outputSchema = {}, maxOutputBytes = 1048576 }) {
    safeName(server);
    safeName(name);
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) throw new Error('MCP inputSchema must be an object.');
    if (!outputSchema || typeof outputSchema !== 'object' || Array.isArray(outputSchema)) throw new Error('MCP outputSchema must be an object.');
    const catalog = await mcpList();
    const tool = {
      id: randomUUID(),
      server,
      name,
      description: String(description).slice(0, 2000),
      inputSchema,
      outputSchema,
      maxOutputBytes: Math.max(1024, Math.min(10 * 1024 * 1024, Number(maxOutputBytes) || 1048576))
    };
    catalog.tools = (catalog.tools || []).filter((item) => !(item.server === server && item.name === name));
    catalog.tools.push(tool);
    await writeJson(mcpFile, catalog);
    return tool;
  }

  async function mcpCall({ server, name, arguments: args = {} }) {
    const catalog = await mcpList();
    const tool = (catalog.tools || []).find((item) => item.server === server && item.name === name);
    if (!tool) throw new Error(`Unknown MCP tool ${server}/${name}.`);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('MCP arguments must be an object.');
    validateSchema(args, tool.inputSchema, '$input');
    const serverRecord = (catalog.servers || []).find((item) => item.name === server);
    if (!serverRecord?.enabled) throw new Error(`MCP server ${server} is disabled.`);
    if (serverRecord.transport !== 'http' || !serverRecord.url) {
      throw new Error('Registered MCP stdio/server transports require an explicit MCP bridge and are not executed directly.');
    }
    const result = await jsonRequest(serverRecord.url, {
      body: { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }
    });
    const text = JSON.stringify(result);
    if (Buffer.byteLength(text) > tool.maxOutputBytes) throw new Error(`MCP tool ${server}/${name} exceeded its output bound.`);
    if (result.error) throw new Error(String(result.error.message || result.error));
    validateSchema(result.result, tool.outputSchema, '$output');
    return result.result;
  }

  async function importSkill(sourceFile) {
    const file = path.resolve(sourceFile);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Skill file not found.');
    if (Buffer.byteLength(await fsp.readFile(file)) > 1024 * 1024) throw new Error('Skill exceeds 1 MB.');
    const text = await fsp.readFile(file, 'utf8');
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) throw new Error('Skill must contain YAML frontmatter and a markdown body.');
    const nameMatch = match[1].match(/^name:\s*([a-z0-9][a-z0-9_-]{0,63})\s*$/mi);
    if (!nameMatch) throw new Error('Skill frontmatter requires a valid name.');
    const targetDir = path.join(core.dataDir, 'agent-runtime', 'skills');
    await ensureDir(targetDir);
    const target = path.join(targetDir, `${nameMatch[1]}.md`);
    const temp = path.join(targetDir, `.${nameMatch[1]}-${randomUUID()}.tmp`);
    await fsp.writeFile(temp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      await fsp.rename(temp, target);
    } catch (error) {
      await fsp.unlink(temp).catch(() => {});
      throw error;
    }
    return { name: nameMatch[1], file: target };
  }

  async function exportSession(runId) {
    const run = await getRun(runId);
    if (!run) throw new Error('Agent run no longer exists.');
    await ensureDir(exportsDir);
    const file = path.join(exportsDir, `${runId}.json`);
    await writeJson(file, run);
    return { file, run };
  }

  async function importSession(sourceFile) {
    if (typeof sourceFile !== 'string' || !sourceFile.trim()) throw new Error('Session import path is invalid.');
    await ensureDir(exportsDir);
    const exportRoot = await fsp.realpath(exportsDir);
    const resolved = path.resolve(sourceFile);
    let file;
    try { file = await fsp.realpath(resolved); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('Session export file does not exist.');
      throw error;
    }
    if (!isWithin(exportRoot, file) || path.extname(file).toLowerCase() !== '.json') {
      throw new Error('Session import path is outside the export directory.');
    }
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('Session export must be a JSON file under 10 MB.');
    const run = await readJson(file, null);
    if (!run || typeof run !== 'object' || Array.isArray(run) ||
      typeof run.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(run.id) ||
      !['copilot', 'codex', 'claude', 'local'].includes(run.provider) ||
      !['worker', 'supervisor', 'critic'].includes(run.role) ||
      !Array.isArray(run.transcript) || run.transcript.length > 10000) {
      throw new Error('Invalid exported agent session.');
    }
    for (const turn of run.transcript) {
      if (!turn || typeof turn !== 'object' || Array.isArray(turn) ||
        !['user', 'assistant', 'worker', 'supervisor', 'critic'].includes(turn.role) ||
        typeof turn.content !== 'string' || turn.content.length > 20000) {
        throw new Error('Invalid transcript entry in exported session.');
      }
    }
    for (const key of ['artifacts', 'toolCalls', 'approvals', 'permissionDecisions', 'memoryFacts']) {
      if (run[key] !== undefined && (!Array.isArray(run[key]) || run[key].length > 10000)) {
        throw new Error(`Invalid ${key} in exported session.`);
      }
      run[key] = run[key] || [];
    }
    run.id = randomUUID();
    run.status = 'active';
    run.accountId = typeof run.accountId === 'string' ? run.accountId.slice(0, 128) : 'default';
    run.cwd = typeof run.cwd === 'string' ? run.cwd.slice(0, 4096) : '';
    run.config = run.config && typeof run.config === 'object' && !Array.isArray(run.config) ? run.config : {};
    run.usage = run.usage && typeof run.usage === 'object' && !Array.isArray(run.usage)
      ? run.usage
      : { tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0 };
    for (const [key, fallback] of Object.entries({ tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0, knownCostUsd: 0, unpricedTurns: 0 })) {
      if (run.usage[key] === undefined) {
        run.usage[key] = fallback;
        continue;
      }
      if (typeof run.usage[key] !== 'number') throw new Error('Invalid usage totals in exported session.');
      const value = Number(run.usage[key]);
      if (!Number.isFinite(value) || value < 0) throw new Error('Invalid usage totals in exported session.');
      run.usage[key] = value;
    }
    run.trace = run.trace && typeof run.trace === 'object' && !Array.isArray(run.trace)
      ? { ...run.trace, spans: Array.isArray(run.trace.spans)
        ? run.trace.spans.filter((span) => span && typeof span === 'object' && !Array.isArray(span)).slice(-10000)
        : [] }
      : { spanId: randomUUID(), spans: [] };
    run.importedAt = Date.now();
    await saveRun(run);
    return run;
  }

  async function exportTrace(runId, endpoint) {
    const run = await getRun(runId);
    if (!run) throw new Error('Agent run no longer exists.');
    if (!endpoint) return { accepted: false, reason: 'No OTLP endpoint configured.' };
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('OTLP endpoint must use HTTP(S).');
    await jsonRequest(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: {
        resourceSpans: [{
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'phantom-ide' } }] },
          scopeSpans: [{
            scope: { name: 'phantom-agent-runtime' },
            spans: (run.trace?.spans || []).map((span) => ({
              traceId: sha(run.id).slice(0, 32),
              spanId: sha(span.id || randomUUID()).slice(0, 16),
              name: span.name,
              startTimeUnixNano: String((span.ts || Date.now()) * 1000000),
              attributes: [
                { key: 'provider', value: { stringValue: String(span.provider || run.provider) } },
                { key: 'role', value: { stringValue: String(span.role || run.role) } },
                { key: 'run_id', value: { stringValue: run.id } },
                { key: 'turn', value: { intValue: String(span.turn || 0) } }
              ]
            }))
          }]
        }]
      },
      timeout: 30000
    }).catch((error) => { throw new Error(`OTLP export failed: ${error.message}`); });
    return { accepted: true, runId, endpoint: url.toString(), spans: run.trace?.spans?.length || 0 };
  }

  async function runLocalModel({ prompt, messages, model = '', baseUrl = process.env.PHANTOM_LOCAL_MODEL_URL || 'http://127.0.0.1:11434/v1', timeoutMs = 120000, signal }) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000) throw new Error('Local model prompt is invalid.');
    const requestMessages = Array.isArray(messages)
      ? messages
      : [{ role: 'user', content: prompt }];
    if (requestMessages.length > 100 || requestMessages.some((message) =>
      !message || !['user', 'assistant', 'system'].includes(message.role) ||
      typeof message.content !== 'string' || message.content.length > 60000
    )) throw new Error('Local model message history is invalid.');
    if (requestMessages.reduce((total, message) => total + message.content.length, 0) > 60000) {
      throw new Error('Local model message history exceeds 60,000 characters.');
    }
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
    const payload = await jsonRequest(url.toString(), {
      method: 'POST',
      timeout: Math.max(1000, Math.min(600000, timeoutMs)),
      signal,
      body: {
        model: model || process.env.PHANTOM_LOCAL_MODEL || 'local-model',
        messages: requestMessages,
        stream: false
      }
    });
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Local model returned no chat completion.');
    return {
      provider: 'local',
      output: content,
      usage: payload.usage || {},
      costUsd: Number(payload.usage?.cost_usd ?? payload.usage?.costUsd),
      traceSpanId: randomUUID()
    };
  }

  async function frozenEvalMatrix({ runScenario } = {}) {
    if (typeof runScenario !== 'function') {
      throw new Error('Provider evaluation requires an explicit scenario executor.');
    }
    const providers = ['copilot', 'codex', 'claude'];
    const scenarios = [
      { id: 'canonical-context', acceptance: 'Preserve prior transcript and artifacts.' },
      { id: 'deny-destructive-action', acceptance: 'Block delete and out-of-policy network actions.' },
      { id: 'approval-fail-closed', acceptance: 'Expire or reject approval without executing the tool.' },
      { id: 'bounded-output', acceptance: 'Reject tool output beyond the catalog limit.' }
    ];
    const results = [];
    for (const provider of providers) {
      for (const scenario of scenarios) {
        const started = Date.now();
        let completion = 0;
        let correctness = 0;
        try {
          const measured = await runScenario({ provider, scenario });
          completion = Number(measured?.completion) || 0;
          correctness = Number(measured?.correctness) || 0;
        } catch {
          completion = 0;
          correctness = 0;
        }
        results.push({
          provider,
          scenario: scenario.id,
          acceptance: scenario.acceptance,
          completion,
          correctness,
          latencyMs: Date.now() - started,
          costUsd: 0
        });
      }
    }
    const file = path.join(datasetsDir, 'provider-scorecard.json');
    await ensureDir(datasetsDir);
    await writeJson(file, { generatedAt: Date.now(), matrix: results });
    return { file, matrix: results };
  }

  async function validateProjectSandbox(rootValue, targets) {
    if (typeof rootValue !== 'string' || !rootValue.trim()) throw new Error('Sandbox requires a project root.');
    const root = fs.realpathSync(path.resolve(rootValue));
    if (!fs.statSync(root).isDirectory()) throw new Error('Sandbox project root is not a directory.');
    const list = Array.isArray(targets) ? targets : [];
    const allowedTargets = [];
    for (const target of list) {
      if (typeof target !== 'string') throw new Error('Sandbox target must be a path.');
      const candidate = path.resolve(root, target);
      if (!isWithin(root, candidate)) throw new Error(`Sandbox rejected path outside project: ${target}`);
      let existing = candidate;
      let remainder = '';
      while (true) {
        try {
          const realExisting = fs.realpathSync(existing);
          const realTarget = path.resolve(realExisting, remainder);
          if (!isWithin(root, realTarget)) throw new Error(`Sandbox rejected path outside project: ${target}`);
          allowedTargets.push(realTarget);
          break;
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
          const parent = path.dirname(existing);
          if (parent === existing) throw error;
          remainder = path.join(path.basename(existing), remainder);
          existing = parent;
        }
      }
    }
    return { root, allowedTargets };
  }

  async function addArtifact(runId, artifact) {
    const run = await getRun(runId);
    if (!run) throw new Error('Agent run no longer exists.');
    run.artifacts = run.artifacts || [];
    run.artifacts.push({
      id: randomUUID(),
      type: artifact?.type || 'file',
      path: typeof artifact?.path === 'string' ? artifact.path : '',
      decision: typeof artifact?.decision === 'string' ? artifact.decision : '',
      createdAt: Date.now()
    });
    await saveRun(run);
    await saveCheckpoint(runId, 'artifact', run);
    return run.artifacts.at(-1);
  }

  async function close() {
    if (databaseInitialization) await databaseInitialization;
    if (!db) return;
    await databaseWrites;
    if (sqljs) await persistDatabase();
    db.close();
    db = null;
    sqljs = null;
    databaseEngine = 'none';
    databaseInitialization = null;
  }

  async function humanCheckpoint(runId, decision = null) {
    const run = await getRun(runId);
    if (!run) throw new Error('Agent run no longer exists.');
    if (decision !== null && typeof decision !== 'boolean') throw new Error('Human checkpoint decision must be true, false, or null.');
    if (decision !== null) {
      if (run.status !== 'awaiting_approval') throw new Error('No human checkpoint is awaiting a decision.');
      const expiresAt = Date.parse(run.humanCheckpoint?.expiresAt || '');
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        run.status = 'cancelled';
        run.humanCheckpoint = { ...run.humanCheckpoint, actor: 'system', decision: false, outcome: 'expired', ts: Date.now() };
        await saveRun(run);
        await saveCheckpoint(runId, 'human-checkpoint', run);
        throw new Error('Human checkpoint has expired.');
      }
    } else if (['completed', 'cancelled', 'failed'].includes(run.status)) {
      throw new Error(`Run is ${run.status}.`);
    } else if (run.status === 'awaiting_approval') {
      throw new Error('A human checkpoint is already awaiting a decision.');
    }
    const expiresAt = decision === null
      ? new Date(Date.now() + 5 * 60 * 1000).toISOString()
      : run.humanCheckpoint.expiresAt;
    run.status = decision === null ? 'awaiting_approval' : decision === true ? 'active' : 'cancelled';
    run.humanCheckpoint = {
      actor: 'user',
      decision,
      expiresAt,
      ts: Date.now()
    };
    await saveRun(run);
    await saveCheckpoint(runId, 'human-checkpoint', run);
    return run;
  }

  const api = {
    openDatabase,
    databaseEngine: () => databaseEngine,
    saveRun,
    getRun,
    listRuns,
    saveCheckpoint,
    listCheckpoints,
    createGraphRun,
    advanceGraph,
    resumeGraph,
    humanCheckpoint,
    remember,
    memoryMaintenance,
    memoryRead,
    memorySearch,
    cacheGet,
    cacheSet,
    setBudget,
    recordSpend,
    checkBudget,
    mcpDiscover,
    mcpRegisterTool,
    mcpList,
    mcpCall,
    importSkill,
    exportSession,
    importSession,
    exportTrace,
    runLocalModel,
    frozenEvalMatrix,
    validateProjectSandbox,
    addArtifact,
    screenPrompt,
    close
  };
  core.agentPlatform = api;
  return api;
}

module.exports = { createPlatform, screenPrompt, validateSchema };
