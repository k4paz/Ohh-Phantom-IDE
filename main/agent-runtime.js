'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { createPlatform } = require('./agent-platform');

const ROLE_PERMISSIONS = {
  supervisor: { read: 'allow', write: 'deny', delete: 'deny', send: 'deny', network: 'deny' },
  worker: { read: 'allow', write: 'ask', delete: 'deny', send: 'ask', network: 'ask' },
  critic: { read: 'allow', write: 'deny', delete: 'deny', send: 'deny', network: 'deny' }
};

const BUILTIN_SKILLS = [
  { name: 'code-review', description: 'Review a diff for correctness, style, and risk.', roles: ['critic'], tools: ['read_file', 'list_diff'], body: 'Review the diff and touched files. Identify correctness, security, and regression risks.' },
  { name: 'refactor', description: 'Make a focused, behavior-preserving code change.', roles: ['worker'], tools: ['read_file', 'write_file', 'run_tests'], body: 'Read the relevant code, make the smallest coherent change, and run focused tests.' },
  { name: 'test', description: 'Diagnose and run the project test suite.', roles: ['worker'], tools: ['read_file', 'run_tests'], body: 'Detect the project test command, run it, and report concrete failures.' }
];

const TOOL_CATALOG = {
  read_file: { name: 'read_file', action: 'read', roles: ['supervisor', 'worker', 'critic'], maxOutputBytes: 1024 * 1024, failureMode: 'throw' },
  list_diff: { name: 'list_diff', action: 'read', roles: ['supervisor', 'critic'], maxOutputBytes: 1024 * 1024, failureMode: 'throw' },
  write_file: { name: 'write_file', action: 'write', roles: ['worker'], maxOutputBytes: 64 * 1024, failureMode: 'throw' },
  run_tests: { name: 'run_tests', action: 'send', roles: ['worker'], maxOutputBytes: 1024 * 1024, failureMode: 'throw' },
  delegate: { name: 'delegate', action: 'send', roles: ['supervisor'], maxOutputBytes: 64 * 1024, failureMode: 'throw' },
  summarize: { name: 'summarize', action: 'read', roles: ['supervisor', 'worker', 'critic'], maxOutputBytes: 64 * 1024, failureMode: 'throw' }
};

function parseSkillFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`Invalid Phantom skill frontmatter: ${path.basename(file)}`);
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (/^\[.*\]$/.test(value)) {
      value = value.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
    metadata[key] = value;
  }
  return {
    name: String(metadata.name || path.basename(file, '.md')),
    description: String(metadata.description || ''),
    roles: Array.isArray(metadata.roles) ? metadata.roles : [],
    tools: Array.isArray(metadata.tools) ? metadata.tools : [],
    body: match[2].trim()
  };
}

function safeText(value, limit = 20000) {
  if (typeof value !== 'string') throw new Error('Structured output expected text.');
  if (value.length > limit) throw new Error(`Text exceeds the ${limit}-character limit.`);
  if (/[\u0000]/.test(value)) throw new Error('Text contains a NUL byte.');
  return value;
}

function hashChain(previous, record) {
  return createHash('sha256').update(`${previous || ''}\n${JSON.stringify(record)}`).digest('hex');
}

function createRuntime(core) {
  if (core.agentRuntime) return core.agentRuntime;
  const platform = createPlatform(core);
  core.onShutdown(() => platform.close());
  const root = path.join(core.dataDir, 'agent-runtime');
  const runsDir = path.join(root, 'runs');
  const auditDir = path.join(root, 'audit');
  const scorecardFile = path.join(root, 'scorecards.json');
  const writes = new Map();
  const auditWrites = new Map();

  async function ensureDir(directory) {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fsp.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Agent runtime storage must be a real directory.');
  }

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  }

  async function writeJsonAtomic(file, value) {
    await ensureDir(path.dirname(file));
    const temp = path.join(path.dirname(file), `.${path.basename(file)}-${randomUUID()}.tmp`);
    await fsp.writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      await fsp.rename(temp, file);
    } catch (error) {
      await fsp.unlink(temp).catch(() => {});
      throw error;
    }
  }

  async function audit(runId, record) {
    const previousWrite = auditWrites.get(runId) || Promise.resolve();
    const next = previousWrite.catch(() => {}).then(async () => {
      await ensureDir(auditDir);
      const file = path.join(auditDir, `${runId}.jsonl`);
      let previous = '';
      try {
        const lines = (await fsp.readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
        if (lines.length) previous = JSON.parse(lines[lines.length - 1]).hash;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const entry = { ...record, ts: Date.now(), previousHash: previous || null, hash: '' };
      entry.hash = hashChain(previous, entry);
      await fsp.appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
      return entry;
    });
    auditWrites.set(runId, next);
    try {
      return await next;
    } finally {
      if (auditWrites.get(runId) === next) auditWrites.delete(runId);
    }
  }

  async function mutateRun(runId, mutate) {
    const previous = writes.get(runId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await ensureDir(runsDir);
      const file = path.join(runsDir, `${runId}.json`);
      const run = await platform.getRun(runId) || await readJson(file, null);
      if (!run) throw new Error('Agent run no longer exists.');
      await mutate(run);
      run.updatedAt = Date.now();
      await platform.saveRun(run);
      await writeJsonAtomic(file, run);
      return run;
    });
    writes.set(runId, next);
    try {
      return await next;
    } finally {
      if (writes.get(runId) === next) writes.delete(runId);
    }
  }

  async function createRun({ provider, cwd, accountId = 'default', role = 'worker', config = {} }) {
    await ensureDir(runsDir);
    if (!['copilot', 'codex', 'claude', 'local'].includes(provider)) throw new Error('Unsupported agent provider.');
    const runId = randomUUID();
    const run = {
      id: runId,
      provider,
      cwd: typeof cwd === 'string' ? cwd : '',
      accountId,
      role,
      status: 'active',
      config: config && typeof config === 'object' ? config : {},
      transcript: [],
      artifacts: [],
      toolCalls: [],
      approvals: [],
      permissionDecisions: [],
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0 },
      memoryFacts: [],
      trace: { spanId: randomUUID(), spans: [] },
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await platform.saveRun(run);
    await writeJsonAtomic(path.join(runsDir, `${runId}.json`), run);
    await audit(runId, { type: 'run_created', provider, role, cwd });
    return run;
  }

  async function appendTurn(runId, entry) {
    const rawContent = String(entry.content || '');
    const content = rawContent.replace(/\0/g, '').slice(0, 20000);
    const turn = {
      turn: Number(entry.turn) || 1,
      role: String(entry.role || 'worker'),
      provider: String(entry.provider || ''),
      content,
      truncated: content.length < rawContent.length,
      toolCalls: Array.isArray(entry.toolCalls) ? entry.toolCalls : [],
      artifacts: Array.isArray(entry.artifacts) ? entry.artifacts : [],
      approval: entry.approval || null,
      usage: entry.usage && typeof entry.usage === 'object' ? entry.usage : { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      ts: Date.now()
    };
    const run = await mutateRun(runId, (state) => {
      state.transcript.push(turn);
      state.usage.turns += 1;
      state.usage.tokensIn += Number(turn.usage.tokensIn) || 0;
      state.usage.tokensOut += Number(turn.usage.tokensOut) || 0;
      state.usage.costUsd += Number(turn.usage.costUsd) || 0;
      if (turn.usage.turnComplete === true) {
        if (turn.usage.costKnown === true) {
          state.usage.knownCostUsd = (Number(state.usage.knownCostUsd) || 0) + (Number(turn.usage.costUsd) || 0);
        } else {
          state.usage.unpricedTurns = (Number(state.usage.unpricedTurns) || 0) + 1;
        }
      }
      state.trace.spans.push({
        id: randomUUID(),
        name: 'invoke_agent',
        provider: turn.provider,
        role: turn.role,
        runId,
        turn: turn.turn,
        ts: turn.ts
      });
    });
    await audit(runId, { type: 'transcript_entry', turn: turn.turn, role: turn.role, provider: turn.provider });
    return run;
  }

  async function getRun(runId) {
    if (typeof runId !== 'string' || !/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('Invalid agent run.');
    const stored = await platform.getRun(runId);
    if (stored) return stored;
    const legacy = await readJson(path.join(runsDir, `${runId}.json`), null);
    if (legacy) await platform.saveRun(legacy);
    return legacy;
  }

  async function listRuns(limit = 50) {
    return platform.listRuns(limit);
  }

  async function setStatus(runId, status, error = null) {
    const allowed = new Set(['active', 'completed', 'failed', 'cancelled', 'awaiting_approval']);
    if (!allowed.has(status)) throw new Error('Invalid agent run status.');
    const run = await mutateRun(runId, (state) => {
      state.status = status;
      if (error) state.error = String(error).slice(0, 2000);
    });
    await audit(runId, { type: 'run_status', status, error });
    return run;
  }

  function evaluatePermission({ role = 'worker', tool = '', action = 'read', provider = '' }) {
    const rolePolicy = ROLE_PERMISSIONS[role] || { read: 'deny', write: 'deny', delete: 'deny', send: 'deny', network: 'deny' };
    if (tool && TOOL_CATALOG[tool] && !TOOL_CATALOG[tool].roles.includes(role)) {
      return { decision: 'deny', reason: `Role ${role} cannot use tool ${tool}.`, provider };
    }
    if (/delete|remove|trash|unlink|rmdir/i.test(action)) action = 'delete';
    if (/network|http|url|fetch|socket/i.test(action)) action = 'network';
    if (/write|create|rename|replace|stage|commit/i.test(action)) action = 'write';
    if (/send|shell|test|delegate|run/i.test(action)) action = 'send';
    if (/read|list|diff|search/i.test(action)) action = 'read';
    const decision = rolePolicy[action] || 'deny';
    return {
      decision,
      reason: decision === 'allow' ? 'Allowed by Phantom policy.'
        : decision === 'ask' ? 'Requires human approval.'
        : 'Denied by default.',
      provider
    };
  }

  async function recordPermissionDecision(runId, details) {
    const decision = evaluatePermission(details);
    const record = { id: randomUUID(), runId, turn: Number(details.turn) || 0, ...details, ...decision, ts: Date.now() };
    await mutateRun(runId, (state) => state.permissionDecisions.push(record));
    await audit(runId, { type: 'permission_decision', ...record });
    return record;
  }

  async function recordApproval(runId, approval) {
    const record = {
      id: approval.id || randomUUID(),
      runId,
      turn: Number(approval.turn) || 0,
      provider: approval.provider || '',
      tool: approval.tool || 'unknown',
      arguments: approval.arguments || {},
      riskSummary: safeText(String(approval.riskSummary || 'Tool action requires approval.'), 1000),
      decision: 'ask',
      expiresAt: approval.expiresAt || new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      outcome: approval.outcome || null,
      actor: approval.actor || null,
      ts: Date.now()
    };
    await mutateRun(runId, (state) => state.approvals.push(record));
    await audit(runId, { type: 'approval', ...record });
    return record;
  }

  function renderContext(run, maxTokens = 8000) {
    const maxChars = Math.max(1000, maxTokens * 4);
    let remaining = maxChars;
    const parts = [];
    for (const entry of [...(run?.transcript || [])].reverse()) {
      const line = `${entry.role.toUpperCase()} [${entry.provider}] ${entry.content}`;
      if (line.length + 1 > remaining) {
        parts.unshift(`[earlier transcript omitted; canonical run ${run.id}]`);
        break;
      }
      parts.unshift(line);
      remaining -= line.length + 1;
    }
    return { runId: run.id, provider: run.provider, role: run.role, cwd: run.cwd, text: parts.join('\n'), capped: remaining === 0 };
  }

  async function verifyAudit(runId) {
    const file = path.join(auditDir, `${runId}.jsonl`);
    let previous = '';
    let count = 0;
    try {
      for (const line of (await fsp.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean)) {
        const entry = JSON.parse(line);
        count++;
        if ((entry.previousHash || null) !== (previous || null)) return { valid: false, count, reason: 'broken previous hash' };
        const copy = { ...entry, hash: '' };
        if (hashChain(previous, copy) !== entry.hash) return { valid: false, count, reason: 'tampered record' };
        previous = entry.hash;
      }
      return { valid: true, count };
    } catch (error) {
      if (error.code === 'ENOENT') return { valid: true, count: 0 };
      return { valid: false, count, reason: error.message };
    }
  }

  async function saveScorecard(scorecard) {
    const existing = await readJson(scorecardFile, []);
    const record = {
      id: randomUUID(),
      createdAt: Date.now(),
      scenario: safeText(String(scorecard.scenario || 'unknown'), 200),
      provider: safeText(String(scorecard.provider || 'unknown'), 40),
      completion: Number(scorecard.completion) || 0,
      correctness: Number(scorecard.correctness) || 0,
      latencyMs: Number(scorecard.latencyMs) || 0,
      costUsd: Number(scorecard.costUsd) || 0
    };
    existing.push(record);
    await writeJsonAtomic(scorecardFile, existing.slice(-1000));
    return record;
  }

  async function listScorecards(limit = 100) {
    const rows = await readJson(scorecardFile, []);
    return rows.slice(-Math.max(1, Math.min(1000, limit))).reverse();
  }

  function listSkills() {
    const skills = new Map(BUILTIN_SKILLS.map((skill) => [skill.name, skill]));
    const directories = [
      path.join(__dirname, '..', 'skills', 'builtin'),
      path.join(root, 'skills')
    ];
    for (const directory of directories) {
      if (!fs.existsSync(directory)) continue;
      for (const name of fs.readdirSync(directory).filter((item) => item.endsWith('.md'))) {
        try {
          const skill = parseSkillFile(path.join(directory, name));
          skills.set(skill.name, skill);
        } catch (error) {
          core.log('error', `skill catalog rejected ${name}: ${error.message}`, 'AGENTS');
        }
      }
    }
    return [...skills.values()].map(({ name, description, roles, tools }) => ({ name, description, roles, tools }));
  }

  function loadSkill(name) {
    const safeName = typeof name === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name) ? name : '';
    if (!safeName) throw new Error('Invalid Phantom skill name.');
    for (const directory of [
      path.join(__dirname, '..', 'skills', 'builtin'),
      path.join(root, 'skills')
    ]) {
      const file = path.join(directory, `${safeName}.md`);
      if (fs.existsSync(file)) return parseSkillFile(file);
    }
    const skill = BUILTIN_SKILLS.find((item) => item.name === safeName);
    if (!skill) throw new Error(`Unknown Phantom skill: ${safeName}`);
    return skill;
  }

  async function addToolCall(runId, record) {
    const tool = TOOL_CATALOG[record.tool];
    if (!tool) throw new Error(`Unknown Phantom tool: ${record.tool}`);
    if (typeof record.output === 'string' && Buffer.byteLength(record.output) > tool.maxOutputBytes) {
      throw new Error(`Tool ${record.tool} exceeded its bounded output of ${tool.maxOutputBytes} bytes.`);
    }
    const entry = {
      id: randomUUID(),
      runId,
      turn: Number(record.turn) || 0,
      tool: record.tool,
      arguments: record.arguments || {},
      outcome: record.outcome || 'success',
      latencyMs: Number(record.latencyMs) || 0,
      ts: Date.now()
    };
    await mutateRun(runId, (state) => {
      state.toolCalls.push(entry);
      state.trace.spans.push({
        id: randomUUID(),
        name: `tool.${record.tool}`,
        provider: state.provider,
        role: state.role,
        runId,
        turn: entry.turn,
        latencyMs: entry.latencyMs,
        ts: entry.ts
      });
    });
    await audit(runId, { type: 'tool_call', ...entry });
    return entry;
  }

  async function checkBudget(runId) {
    const run = await getRun(runId);
    if (!run) throw new Error('Agent run no longer exists.');
    const providerDefaults = { copilot: 2, codex: 3, claude: 5 };
    const budget = Number(run.config?.budgetUsdPerRun) ||
      providerDefaults[run.provider] || 2;
    if ((Number(run.usage.unpricedTurns) || 0) > 0) {
      throw new Error('The previous turn had no provider-reported cost; this run budget is paused until cost data is available.');
    }
    if (run.usage.costUsd >= budget) {
      throw new Error(`Provider budget of $${budget.toFixed(2)} exhausted for this run.`);
    }
    return { budgetUsd: budget, spentUsd: run.usage.costUsd, remainingUsd: Math.max(0, budget - run.usage.costUsd) };
  }

  const api = {
    createRun,
    appendTurn,
    getRun,
    listRuns,
    setStatus,
    evaluatePermission,
    recordPermissionDecision,
    recordApproval,
    renderContext,
    verifyAudit,
    saveScorecard,
    listScorecards,
    listSkills,
    loadSkill,
    addToolCall,
    checkBudget,
    tools: () => Object.values(TOOL_CATALOG)
  };
  core.agentRuntime = api;
  return api;
}

module.exports = { createRuntime, safeText, ROLE_PERMISSIONS, TOOL_CATALOG };
