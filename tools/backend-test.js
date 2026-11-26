'use strict';
// Exercises every backend service against the real OS from plain Node (no Electron).
// Usage: node tools/backend-test.js
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { createCore } = require('../main/registry');
const {
  subscriptionEnvironment, agentOptions, assistedReadApproval, projectScopedApproval, normalizeCopilotQuota
} = require('../main/services/agents');

const events = [];
const listeners = new Map();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-data-'));
const core = createCore({
  dataDir,
  emit: (ch, p) => { events.push([ch, p]); (listeners.get(ch) || []).forEach((f) => f(p)); }
});
const on = (ch, f) => { if (!listeners.has(ch)) listeners.set(ch, []); listeners.get(ch).push(f); };
const call = (ch, ...a) => core.handlers.get(ch)(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; let fail = 0;
async function t(name, fn) {
  try { const r = await fn(); console.log('  \x1b[32m✓\x1b[0m', name, r !== undefined ? `\x1b[2m${String(r).slice(0, 110)}\x1b[0m` : ''); pass++; }
  catch (e) { console.log('  \x1b[31m✗\x1b[0m', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error('assert: ' + m); };

(async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-proj-'));
  fs.mkdirSync(path.join(proj, 'src'));
  fs.writeFileSync(path.join(proj, 'src', 'a.js'), "const b = require('./b');\nmodule.exports = () => b() + 1;\n");
  fs.writeFileSync(path.join(proj, 'src', 'b.js'), "const a = require('./a');\nconst _ = require('lodash');\nmodule.exports = () => 41;\n");
  fs.writeFileSync(path.join(proj, 'src', 'debugme.js'), "let total = 0;\nfor (let i = 0; i < 3; i++) {\n  total += i;\n}\nconsole.log('total', total);\n");
  fs.writeFileSync(path.join(proj, 'config.js'), "const token = 'ghp_" + 'A'.repeat(36) + "';\n");
  fs.writeFileSync(path.join(proj, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: "node -e \"console.log('Tests: 3 passed, 3 total')\"", build: 'echo building' }, dependencies: { leftpad: '*' } }));
  fs.writeFileSync(path.join(proj, 'Dockerfile'), 'FROM node:latest\nCOPY . .\n');

  console.log('\napp');
  await t('preload accepts nested event channels', async () => {
    let api;
    const registered = [];
    const electron = {
      contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'phantom') api = value; } },
      ipcRenderer: { on: (channel) => registered.push(channel), invoke: async () => ({ __ok: true }) }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8'), {
      require: (name) => {
        assert(name === 'electron', 'preload only imports Electron');
        return electron;
      },
      process: { platform: process.platform },
      console
    });
    api.on('agent:accounts:changed', () => {});
    assert(registered.includes('agent:accounts:changed'), 'nested channel listener registered');
    return 'agent account events accepted';
  });
  await t('app:info reports coding agent CLIs', async () => {
    const info = await call('app:info');
    for (const id of ['claude', 'copilot', 'codex']) assert(typeof info.tools[id] === 'boolean', `${id} availability`);
    return ['claude', 'copilot', 'codex'].map((id) => `${id}:${info.tools[id] ? 'yes' : 'no'}`).join(' ');
  });
  await t('agent runtimes strip API credentials', async () => {
    const env = subscriptionEnvironment({
      PATH: 'agent-test-path', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret',
      ANTHROPIC_API_KEY: 'secret', COPILOT_GITHUB_TOKEN: 'secret', GITHUB_TOKEN: 'secret',
      GEMINI_API_KEY: 'secret', SENTRY_AUTH_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'secret',
      CLAUDE_CODE_USE_BEDROCK: '1', ELECTRON_RUN_AS_NODE: '1'
    });
    assert(env.PATH === 'agent-test-path', 'preserve runtime PATH');
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'COPILOT_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GEMINI_API_KEY', 'SENTRY_AUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'ELECTRON_RUN_AS_NODE']) {
      assert(!(key in env), `remove ${key}`);
    }
    return 'API credentials removed; PATH preserved';
  });
  await t('Copilot quota normalization supports credits and unlimited windows', async () => {
    const quota = normalizeCopilotQuota({
      login: 'phantom-user',
      copilot_plan: 'individual',
      token_based_billing: true,
      quota_reset_date_utc: '2026-07-01T00:00:00Z',
      quota_snapshots: {
        premium_interactions: { entitlement: 1000, remaining: 250, credits_used: 750, percent_remaining: 25 },
        chat: { unlimited: true },
        completions: { entitlement: 0, has_quota: false }
      }
    });
    assert(quota.available && quota.login === 'phantom-user', 'include the authenticated GitHub identity');
    assert(quota.windows.length === 2, 'omit quota categories with no allowance');
    assert(quota.windows[0].label === 'AI credits' && quota.windows[0].remaining === 250, 'preserve AI credit remaining');
    assert(quota.windows[1].unlimited, 'preserve unlimited quota');
    return 'identity, AI credit balance, reset date, and unlimited quota normalized';
  });
  await t('Copilot legacy quota normalization clamps exhausted balances and rejects missing data', async () => {
    const quota = normalizeCopilotQuota({
      quota_snapshots: {
        premium_interactions: { entitlement: 300, remaining: -25, credits_used: 325, has_quota: false },
        chat: { percent_remaining: 44.6 }
      }
    });
    assert(quota.windows[0].label === 'Premium requests', 'label legacy usage accurately');
    assert(quota.windows[0].remaining === 0 && quota.windows[0].overage === 25, 'show exhaustion and overage');
    assert(quota.windows[1].percentRemaining === 44.6, 'preserve percent-only quotas');
    try { normalizeCopilotQuota({ quota_snapshots: {} }); }
    catch { return 'legacy balances and missing quota data handled'; }
    throw new Error('missing quota data accepted');
  });
  await t('subscription accounts use isolated provider profiles', async () => {
    const initial = await call('agent:accounts:list');
    assert(initial.providers.copilot[0].id === 'default', 'default login is available');
    const added = await call('agent:accounts:add', 'copilot', 'Secondary GitHub');
    const profile = added.providers.copilot.find((item) => item.name === 'Secondary GitHub');
    assert(profile && added.active.copilot === profile.id, 'new profile becomes active');
    const accountEnv = await call('agent:accounts:environment', 'copilot', profile.id);
    assert(accountEnv.env.COPILOT_HOME === path.join(dataDir, 'agent-profiles', 'copilot', profile.id), 'Copilot uses isolated home');
    assert(accountEnv.unsetEnv.includes('GITHUB_TOKEN') || !process.env.GITHUB_TOKEN, 'login environment clears ambient API credentials');
    const removed = await call('agent:accounts:remove', 'copilot', profile.id);
    assert(!removed.providers.copilot.some((item) => item.id === profile.id), 'removed profile is no longer listed');
    assert(removed.active.copilot === 'default', 'active profile falls back to default');
    assert(!fs.existsSync(accountEnv.env.COPILOT_HOME), 'isolated profile data is removed');
    try { await call('agent:accounts:remove', 'copilot', '..\\outside'); }
    catch { return 'profiles isolated and invalid profile IDs rejected'; }
    throw new Error('invalid account identifier accepted');
  });
  await t('agent rejects unsupported provider', async () => {
    try { await call('agent:create', 'api', proj); }
    catch (error) { return error.message; }
    throw new Error('unsupported provider accepted');
  });
  await t('agent model settings validate by provider', async () => {
    const codex = agentOptions('codex', { model: 'gpt-test', reasoningEffort: 'high', webSearchMode: 'cached' });
    assert(codex.model === 'gpt-test' && codex.reasoningEffort === 'high' && codex.webSearchMode === 'cached', 'preserve Codex settings');
    try { agentOptions('copilot', { reasoningEffort: 'persistent' }); }
    catch (error) { return error.message; }
    throw new Error('invalid reasoning effort accepted');
  });
  await t('agent execution and permission modes validate by provider', async () => {
    const copilot = agentOptions('copilot', { agentMode: 'plan', permissionMode: 'project-scoped', enableMcp: true });
    const assisted = agentOptions('copilot', { permissionMode: 'assisted' });
    const codex = agentOptions('codex', { agentMode: 'autopilot' });
    assert(copilot.agentMode === 'plan' && copilot.permissionMode === 'project-scoped', 'preserve Copilot modes');
    assert(copilot.enableMcp, 'preserve Copilot MCP opt-in');
    assert(assisted.permissionMode === 'assisted', 'preserve Copilot assisted permissions');
    assert(codex.agentMode === 'autopilot' && codex.permissionMode === 'manual', 'preserve Codex mode and manual permissions');
    for (const [provider, options] of [
      ['copilot', { agentMode: 'unrestricted' }],
      ['copilot', { permissionMode: 'allow-all' }],
      ['codex', { permissionMode: 'assisted' }],
      ['codex', { permissionMode: 'project-scoped' }],
      ['codex', { enableMcp: true }]
    ]) {
      try { agentOptions(provider, options); }
      catch { continue; }
      throw new Error(`${provider} accepted unsupported agent options`);
    }
    return 'project-scoped Copilot permissions accepted; unsupported and allow-all policies rejected';
  });
  await t('assisted permissions auto-approve only safe, unmanaged reads', async () => {
    const request = { kind: 'read', path: path.join(proj, 'src', 'a.js') };
    const approved = { assistedApprovalAssessment: { status: 'completed', recommendation: 'approve' } };
    assert(assistedReadApproval(request, approved, proj), 'safe project read should use the assisted recommendation');
    assert(!assistedReadApproval({ kind: 'shell' }, approved, proj), 'shell must remain manual');
    assert(!assistedReadApproval({ ...request, path: path.resolve(proj, '..', 'outside.txt') }, approved, proj), 'reads outside the project must remain manual');
    assert(!assistedReadApproval({ ...request, requestSandboxBypass: true }, approved, proj), 'sandbox bypass must remain manual');
    assert(!assistedReadApproval({ ...request, managedApprovalRequired: true }, approved, proj), 'managed approval must remain manual');
    assert(!assistedReadApproval(request, { assistedApprovalAssessment: { status: 'completed', recommendation: 'requireApproval' } }, proj), 'unsafe read must remain manual');
    return 'only safety-approved reads inside the project are auto-approved';
  });
  await t('project-scoped permissions approve only in-project file reads and writes', async () => {
    const read = { kind: 'read', path: path.join(proj, 'src', 'a.js') };
    const write = { kind: 'write', fileName: path.join(proj, 'src', 'new.js') };
    assert(projectScopedApproval(read, {}, proj), 'project file read should be auto-approved');
    assert(projectScopedApproval(write, {}, proj), 'new file in existing project directory should be auto-approved');
    assert(!projectScopedApproval({ kind: 'write', fileName: path.resolve(proj, '..', 'outside.js') }, {}, proj), 'out-of-project write must remain manual');
    assert(!projectScopedApproval({ kind: 'write', fileName: write.fileName, requestSandboxBypass: true }, {}, proj), 'sandbox bypass must remain manual');
    assert(!projectScopedApproval({ kind: 'read', path: read.path, managedApprovalRequired: true }, {}, proj), 'managed permission must remain manual');
    assert(!projectScopedApproval(read, { promptRequest: { managedApprovalRequired: true } }, proj), 'managed prompt context must remain manual');
    assert(!projectScopedApproval({ kind: 'shell', command: 'echo no' }, {}, proj), 'shell commands must remain manual');
    assert(!projectScopedApproval({ kind: 'url', url: 'https://example.com' }, {}, proj), 'network requests must remain manual');
    assert(!projectScopedApproval({
      kind: 'write', fileName: write.fileName,
      fileEdits: [{ before: { path: write.fileName }, after: { path: path.resolve(proj, '..', 'outside.js') } }]
    }, {}, proj), 'moves involving out-of-project paths must remain manual');
    return 'only unmanaged file operations within the project are auto-approved';
  });
  await t('agent model discovery rejects unsupported providers', async () => {
    try { await call('agent:models', 'codex', proj); }
    catch (error) { return error.message; }
    throw new Error('unsupported model catalog accepted');
  });
  await t('agent settings reject unsupported web search', async () => {
    try { agentOptions('claude', { webSearchMode: 'live' }); }
    catch (error) { return error.message; }
    throw new Error('unsupported web search mode accepted');
  });
  await t('orchestrator accepts tagged and JSON-formatted actions', async () => {
    const { FLOW_ACTION_TAG, parseFlowAction } = await import('../renderer/js/core/flow-protocol.mjs');
    const tagged = parseFlowAction(`Plan\n<${FLOW_ACTION_TAG}>{"action":"delegate","summary":"Split work"}</${FLOW_ACTION_TAG}>`);
    const fenced = parseFlowAction('```json\n{"action":"complete","finalResponse":"Done"}\n```');
    const plain = parseFlowAction('{"action":"ask_user","question":"Which target?"}');
    assert(tagged.action.action === 'delegate' && tagged.visibleText === 'Plan', 'tagged action and visible summary');
    assert(fenced.action.action === 'complete', 'JSON code fence fallback');
    assert(plain.action.action === 'ask_user', 'plain JSON fallback');
    try { parseFlowAction('No structured action here.'); }
    catch (error) { return error.message; }
    throw new Error('unstructured response accepted');
  });
  await t('Claude workflow provider is recognized', async () => {
    try { await call('agent:create', 'claude', ''); }
    catch (error) {
      assert(error.message.includes('Open a project'), 'Claude should pass provider validation');
      return error.message;
    }
    throw new Error('empty project path accepted');
  });

  console.log('\nfs / store');
  await t('fs:list', async () => { const l = await call('fs:list', proj); assert(l[0].dir && l[0].name === 'src', 'dirs first'); return l.map((x) => x.name).join(' '); });
  await t('fs:write + read', async () => { const p = path.join(proj, 'x.txt'); await call('fs:write', p, 'hello\n'); const r = await call('fs:read', p); assert(r.content === 'hello\n', 'content'); fs.unlinkSync(p); return r.eol; });
  await t('fs:walk', async () => (await call('fs:walk', proj)).length + ' files');
  await t('fs:rename refuses overwrite', async () => { try { await call('fs:rename', path.join(proj, 'config.js'), path.join(proj, 'package.json')); } catch (e) { return e.message; } throw new Error('no error'); });
  await t('Agent Flow saves and loads from the project directory', async () => {
    const workflow = { name: 'Test flow', nodes: [{ id: 'task', type: 'input' }], edges: [] };
    assert(await call('flow:load', proj) === null, 'new project has no saved flow');
    await call('flow:save', proj, workflow);
    await call('flow:save', proj, { ...workflow, name: 'Updated test flow' });
    const saved = await call('flow:load', proj);
    assert(saved.name === 'Updated test flow' && JSON.stringify(saved.nodes) === JSON.stringify(workflow.nodes), 'saved workflow replaces prior version');
    assert(fs.existsSync(path.join(proj, '.phantom', 'agent-flow.json')), 'workflow file is in project');
    return '.phantom/agent-flow.json';
  });
  await t('Agent Flow rejects invalid project data', async () => {
    try { await call('flow:save', proj, { nodes: 'not-an-array', edges: [] }); }
    catch (error) { return error.message; }
    throw new Error('invalid workflow accepted');
  });
  await t('store set/get', async () => { await call('store:set', 'layouts', { a: 1 }); const v = await call('store:get', 'layouts'); assert(v.a === 1, 'v'); return JSON.stringify(v); });
  await t('store rejects bad key', async () => { try { await call('store:set', '../x', 1); } catch (e) { return e.message; } throw new Error('accepted'); });
  await t('store reports durable write failures', async () => {
    const storeDir = path.join(dataDir, 'store');
    const backupDir = path.join(dataDir, `store-test-backup-${process.pid}`);
    fs.renameSync(storeDir, backupDir);
    fs.writeFileSync(storeDir, 'block writes');
    try {
      await call('store:set', 'checkpoint-test', { saved: true });
      throw new Error('failed write was reported as successful');
    } catch (error) {
      assert(['EEXIST', 'ENOTDIR'].includes(error.code), `unexpected error: ${error.message}`);
      return `write failure surfaced (${error.code})`;
    } finally {
      fs.unlinkSync(storeDir);
      fs.renameSync(backupDir, storeDir);
    }
  });

  console.log('\npty');
  await t('pty:spawn + echo', async () => {
    let out = '';
    on('pty:data', (p) => { out += p.data; });
    const opts = process.platform === 'win32'
      ? { cwd: proj, cols: 100, rows: 30 }
      : { cwd: proj, shell: '/bin/bash', args: ['--norc', '-i'], cols: 100, rows: 30 };
    const s = await call('pty:spawn', opts);
    await sleep(400);
    await call('pty:write', s.id, process.platform === 'win32'
      ? 'Write-Output PHANTOM_42\r'
      : 'echo PHANTOM_$((40+2))\r');
    await sleep(700);
    const cwd = await call('pty:cwd', s.id);
    await call('pty:kill', s.id);
    assert(out.includes('PHANTOM_42'), 'output: ' + JSON.stringify(out.slice(-200)));
    return `${s.kind}, cwd=${cwd}`;
  });

  console.log('\nsys / proc / net');
  await t('sys:static', async () => { const s = await call('sys:static'); return `${s.distro} ${s.cores} cores ${s.backend}`; });
  await t('sys:snapshot', async () => { await call('sys:snapshot'); await sleep(900); const s = await call('sys:snapshot'); assert(s.cpu.cores.length > 0 && s.mem.total > 0, 'data'); return `cpu ${s.cpu.load.toFixed(1)}% mem ${(s.mem.used / 2 ** 30).toFixed(2)}G ifaces ${s.net.ifaces.length} fs ${s.fs.length}`; });
  await t('proc:list', async () => { await call('proc:list'); await sleep(1300); const r = await call('proc:list'); assert(r.procs.some((p) => p.pid === process.pid), 'self'); return `${r.total} procs`; });
  await t('proc:details self', async () => JSON.stringify(await call('proc:details', process.pid)).slice(0, 100));
  await t('proc:kill refuses self', async () => { try { await call('proc:kill', process.pid); } catch (e) { return e.message; } throw new Error('allowed'); });
  await t('net:connections', async () => {
    const srv = http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ ok: true, path: q.url, m: q.method })); }).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    global.__srv = srv;
    const c = await call('net:connections');
    const port = srv.address().port;
    const mine = c.find((x) => x.lport === port && x.state === 'LISTEN');
    assert(mine, 'listening socket visible');
    return `${c.length} sockets; ours pid=${mine.pid} proc=${mine.process}`;
  });
  await t('net:probe loopback only', async () => { const r = await call('net:probe', global.__srv.address().port); assert(r.open, 'open'); try { await call('net:probe', 80, '8.8.8.8'); } catch (e) { return 'open + ' + e.message; } throw new Error('allowed'); });

  console.log('\nhttp');
  await t('http:request JSON', async () => { const r = await call('http:request', { method: 'POST', url: `http://127.0.0.1:${global.__srv.address().port}/api?x=1`, headers: { 'content-type': 'application/json' }, body: '{}' }); assert(r.status === 200 && JSON.parse(r.body).m === 'POST', 'resp'); return `${r.status} ${r.timeMs.toFixed(1)}ms ${r.body}`; });
  await t('http rejects file://', async () => { try { await call('http:request', { url: 'file:///etc/passwd' }); } catch (e) { return e.message; } throw new Error('allowed'); });

  console.log('\ngit');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: proj });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: proj });
  execFileSync('git', ['config', 'user.email', 'a@b'], { cwd: proj }); execFileSync('git', ['config', 'user.name', 'tester'], { cwd: proj });
  await t('git:status', async () => { const s = await call('git:status', proj); assert(s.branch === 'main', 'branch ' + s.branch); return `${s.branch} ${s.files.length} files`; });
  await t('git:stage/commit/log', async () => {
    await call('git:stage', proj, ['src/a.js', 'src/b.js']);
    const d = await call('git:diff', proj, 'src/a.js', true); assert(d.includes('+module.exports'), 'diff');
    await call('git:commit', proj, 'add modules');
    const log = await call('git:log', proj, 10);
    assert(log.some((l) => l.subject === 'add modules'), 'log');
    return log.filter((l) => l.hash).map((l) => `${l.graph.trim()} ${l.hash} ${l.subject}`).join(' | ');
  });
  await t('git:branches + checkout', async () => { await call('git:createBranch', proj, 'feature/x'); const b = await call('git:branches', proj); assert(b.find((x) => x.current).name === 'feature/x', 'current'); await call('git:checkout', proj, 'main'); return b.map((x) => x.name).join(','); });
  await t('git rejects option injection', async () => { try { await call('git:checkout', proj, '--orphan'); } catch (e) { return e.message; } throw new Error('allowed'); });
  await t('git:fileAt', async () => (await call('git:fileAt', proj, 'src/a.js')).split('\n')[0]);

  console.log('\nsearch');
  await t('search ripgrep', async () => { const r = await call('search:run', { root: proj, query: 'module.exports' }); assert(r.results.length === 2, 'n=' + r.results.length); return `${r.engine} ${r.results.length} hits ${r.ms}ms ranges=${JSON.stringify(r.results[0].ranges)}`; });
  await t('search builtin regex', async () => { const r = await call('search:run', { root: proj, query: 'require\\(.(\\./\\w)', regex: true, engine: 'builtin' }); assert(r.results.length === 2, 'n=' + r.results.length); return `${r.engine} ${r.results.length}`; });
  await t('search:replace', async () => { const r = await call('search:replace', { files: [path.join(proj, 'src', 'b.js')], query: '41', replacement: '42' }); assert(fs.readFileSync(path.join(proj, 'src', 'b.js'), 'utf8').includes('42'), 'replaced'); return JSON.stringify(r); });

  console.log('\ndb');
  await t('sqlite create/query', async () => {
    const c = await call('db:connect', { type: 'sqlite', file: path.join(proj, 'test.db') });
    await call('db:query', c.id, "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, note TEXT); INSERT INTO users(name, note) VALUES ('elliot','it''s; tricky'),('darlene',NULL);");
    const r = await call('db:query', c.id, 'SELECT * FROM users ORDER BY id');
    const tables = await call('db:tables', c.id); const cols = await call('db:columns', c.id, 'users');
    await call('db:close', c.id);
    assert(r.rows.length === 2 && r.rows[0][2] === "it's; tricky", JSON.stringify(r.rows));
    return `${c.engine} tables=${tables.map((x) => x.name)} cols=${cols.map((x) => x.name)} rows=${JSON.stringify(r.rows)}`;
  });

  console.log('\nssh');
  await t('ssh profile + command', async () => { const p = await call('ssh:save', { name: 'box', host: 'example.com', user: 'root', port: 2222, forwards: 'L:8080:localhost:80' }); try { const c = await call('ssh:command', p); return c.args.join(' '); } catch (e) { return 'saved; ' + e.message; } });
  await t('ssh rejects -oProxyCommand host', async () => { try { await call('ssh:save', { host: '-oProxyCommand=x' }); } catch (e) { return e.message; } throw new Error('allowed'); });

  console.log('\naudit');
  await t('audit:secrets', async () => { const r = await call('audit:secrets', proj); assert(r.findings.some((f) => f.rule === 'GitHub token'), 'gh'); return r.findings.map((f) => `${f.rule}: ${f.preview}`).join(' | '); });
  await t('audit:config', async () => { const r = await call('audit:config', proj); return r.map((f) => `[${f.severity}] ${f.title}`).join(' | '); });
  await t('audit:deps', async () => { const r = await call('audit:deps', proj); return r.map((x) => `${x.tool}: ${x.error || x.findings.length}`).join(' | '); });

  console.log('\ntasks');
  await t('tasks:detect', async () => (await call('tasks:detect', proj)).map((x) => x.command).join(', '));
  await t('tasks:detectTests', async () => JSON.stringify(await call('tasks:detectTests', proj)));
  await t('tasks:run streams + exits', async () => {
    let out = ''; let exit = null;
    on('tasks:output', (p) => { out += p.data; }); on('tasks:exit', (p) => { exit = p; });
    await call('tasks:run', { root: proj, command: 'echo one && echo two 1>&2 && exit 3' });
    for (let i = 0; i < 40 && !exit; i++) await sleep(50);
    assert(exit && exit.code === 3 && out.includes('two'), JSON.stringify({ exit, out }));
    return `code=${exit.code} ${exit.ms}ms out=${JSON.stringify(out)}`;
  });

  console.log('\ndebug (Node inspector)');
  await t('breakpoint, scopes, step, eval', async () => {
    const file = path.join(proj, 'src', 'debugme.js');
    await call('debug:setBreakpoints', file, [3]);
    const paused = []; let ended = null; let out = '';
    on('debug:paused', (p) => paused.push(p)); on('debug:ended', (p) => { ended = p; }); on('debug:output', (p) => { out += p.data; });
    const s = await call('debug:start', { program: file });
    for (let i = 0; i < 60 && !paused.length; i++) await sleep(50);
    assert(paused.length, 'paused');
    const f = paused[0].frames[0];
    const local = f.scopes.find((x) => x.type === 'local' || x.type === 'block');
    const props = await call('debug:properties', s.id, local.objectId);
    const ev = await call('debug:evaluate', s.id, f.id, 'total + 100');
    await call('debug:setBreakpoints', file, []);
    await call('debug:resume', s.id);
    for (let i = 0; i < 60 && !ended; i++) await sleep(50);
    assert(ended && out.includes('total 3'), 'ended: ' + out);
    return `paused at ${path.basename(f.file)}:${f.line} (${paused[0].reason}) vars=${props.map((p) => p.name + '=' + p.value).join(',')} eval=${ev.value} out=${JSON.stringify(out.trim())}`;
  });

  console.log('\narch / logs / events');
  await t('arch:graph + cycle detection', async () => { const g = await call('arch:graph', proj, { externals: true }); assert(g.cycles.length === 1, 'cycle'); return `${g.nodes.length} nodes ${g.edges.length} edges cycles=${JSON.stringify(g.cycles)}`; });
  await t('arch:graph on PHANTOM itself', async () => { const g = await call('arch:graph', path.join(__dirname, '..')); return `${g.nodes.length} nodes ${g.edges.length} edges ${g.cycles.length} cycles`; });
  await t('logs:tail follows appends', async () => {
    const lf = path.join(proj, 'app.log'); fs.writeFileSync(lf, 'first\n');
    const lines = []; on('logs:lines', (p) => lines.push(...p.lines));
    const tl = await call('logs:tail', lf); await sleep(200);
    fs.appendFileSync(lf, 'ERROR second\nthird\n'); await sleep(900);
    await call('logs:untail', tl.id);
    assert(lines.includes('ERROR second') && lines.includes('first'), JSON.stringify(lines));
    return lines.join(' / ');
  });
  await t('watch:start emits fs:changed', async () => {
    let got = null; on('fs:changed', (p) => { got = p; });
    await call('watch:start', proj); await sleep(150);
    fs.writeFileSync(path.join(proj, 'src', 'new.js'), 'x');
    for (let i = 0; i < 30 && !got; i++) await sleep(50);
    await call('watch:stop', proj);
    assert(got, 'no change event');
    return got.paths.map((p) => path.relative(proj, p)).join(',');
  });
  await t('events:subscribe', async () => {
    const recent = await call('events:subscribe');
    let ev = []; on('events:event', (e) => ev.push(e));
    await sleep(3500);
    await call('events:unsubscribe');
    return `${recent.length} buffered, ${ev.length} live, sources=${[...new Set([...recent, ...ev].map((e) => e.source))].join(',')}`;
  });

  global.__srv.close();
  await core.shutdown();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
