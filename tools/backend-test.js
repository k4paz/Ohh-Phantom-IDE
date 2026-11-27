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
    const { FLOW_ACTION_TAG, parseFlowAction, validateRoadmapPlan, validateGoalEvidence } = await import('../renderer/js/core/flow-protocol.mjs');
    const tagged = parseFlowAction(`Plan\n<${FLOW_ACTION_TAG}>{"action":"delegate","summary":"Split work"}</${FLOW_ACTION_TAG}>`);
    const fenced = parseFlowAction('```json\n{"action":"complete","finalResponse":"Done"}\n```');
    const plain = parseFlowAction('{"action":"ask_user","question":"Which target?"}');
    assert(tagged.action.action === 'delegate' && tagged.visibleText === 'Plan', 'tagged action and visible summary');
    assert(fenced.action.action === 'complete', 'JSON code fence fallback');
    assert(plain.action.action === 'ask_user', 'plain JSON fallback');
    const plan = validateRoadmapPlan({
      summary: 'Implement the feature',
      goals: [{ id: 'feature', title: 'Deliver the feature', acceptanceCriteria: ['The feature works'] }],
      assignments: [{ workerId: 'worker-1', task: 'Implement the feature', goalIds: ['feature'] }]
    });
    assert(plan.assignments.length === 1, 'accept a scoped worker assignment');
    let reviewerCollisionRejected = false;
    try {
      validateRoadmapPlan({
        goals: [{ id: 'feature', title: 'Deliver the feature', acceptanceCriteria: ['The feature works'] }],
        assignments: [{ workerId: 'reviewer-1', task: 'Implement the feature', goalIds: ['feature'] }]
      });
    } catch { reviewerCollisionRejected = true; }
    assert(reviewerCollisionRejected, 'reserve generated reviewer IDs for review results');
    assert(validateGoalEvidence([{ goalId: 'feature', evidence: 'Tested successfully' }], plan.goals).length === 1, 'require evidence for each goal');
    for (const invalid of [
      { goals: [], assignments: [{ workerId: 'worker-1', task: 'work', goalIds: [] }] },
      { goals: [{ id: 'goal', title: 'Goal', acceptanceCriteria: ['criterion'] }], assignments: [] },
      { goals: [{ id: 'goal', title: 'Goal', acceptanceCriteria: ['criterion'] }], assignments: [{ workerId: 'worker-1', task: 'work', goalIds: [] }] }
    ]) {
      try { validateRoadmapPlan(invalid); }
      catch { continue; }
      throw new Error('incomplete roadmap accepted');
    }
    let evidenceRejected = false;
    try { validateGoalEvidence([], plan.goals); }
    catch { evidenceRejected = true; }
    assert(evidenceRejected, 'block completion without goal evidence');
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
  await t('project writes serialize against integration locks', async () => {
    const file = path.join(proj, 'locked-write.txt');
    let release;
    let entered;
    const enteredLock = new Promise((resolve) => { entered = resolve; });
    const heldWrite = core.withFileLock(file, async () => {
      entered();
      await new Promise((resolve) => { release = resolve; });
      await fs.promises.writeFile(file, 'earlier write\n');
    });
    await enteredLock;
    const queuedWrite = call('fs:write', file, 'latest write\n');
    await sleep(10);
    release();
    await Promise.all([heldWrite, queuedWrite]);
    assert(fs.readFileSync(file, 'utf8') === 'latest write\n', 'the serialized later save is not overwritten');
    fs.unlinkSync(file);
    return 'same-path app writes run in lock order';
  });
  await t('project create, rename, copy, trash, and replace use integration locks', async () => {
    const createPath = path.join(proj, 'locked-create.txt');
    let releaseCreate;
    let enteredCreate;
    const createEntered = new Promise((resolve) => { enteredCreate = resolve; });
    const heldCreate = core.withFileLock(createPath, async () => {
      enteredCreate();
      await new Promise((resolve) => { releaseCreate = resolve; });
    });
    await createEntered;
    const queuedCreate = call('fs:createFile', createPath, 'created\n');
    await sleep(10);
    assert(!fs.existsSync(createPath), 'create waits for the destination lock');
    releaseCreate();
    await Promise.all([heldCreate, queuedCreate]);
    assert(fs.readFileSync(createPath, 'utf8') === 'created\n', 'create writes after acquiring its lock');

    const renameSource = path.join(proj, 'locked-rename-source.txt');
    const renameTarget = path.join(proj, 'locked-rename-target.txt');
    fs.writeFileSync(renameSource, 'rename\n');
    let releaseRename;
    let enteredRename;
    const renameEntered = new Promise((resolve) => { enteredRename = resolve; });
    const heldRename = core.withFileLock(renameTarget, async () => {
      enteredRename();
      await new Promise((resolve) => { releaseRename = resolve; });
    });
    await renameEntered;
    const queuedRename = call('fs:rename', renameSource, renameTarget);
    await sleep(10);
    assert(fs.existsSync(renameSource) && !fs.existsSync(renameTarget), 'rename waits for its destination lock');
    releaseRename();
    await Promise.all([heldRename, queuedRename]);
    assert(fs.readFileSync(renameTarget, 'utf8') === 'rename\n', 'rename completes after acquiring both locks');

    const copySource = path.join(proj, 'locked-copy-source.txt');
    const copyTarget = path.join(proj, 'locked-copy-target.txt');
    fs.writeFileSync(copySource, 'copy\n');
    let releaseCopy;
    let enteredCopy;
    const copyEntered = new Promise((resolve) => { enteredCopy = resolve; });
    const heldCopy = core.withFileLock(copyTarget, async () => {
      enteredCopy();
      await new Promise((resolve) => { releaseCopy = resolve; });
    });
    await copyEntered;
    const queuedCopy = call('fs:copy', copySource, copyTarget);
    await sleep(10);
    assert(!fs.existsSync(copyTarget), 'copy waits for its destination lock');
    releaseCopy();
    await Promise.all([heldCopy, queuedCopy]);
    assert(fs.readFileSync(copyTarget, 'utf8') === 'copy\n', 'copy completes after acquiring both locks');

    const replaceFile = path.join(proj, 'locked-replace.txt');
    fs.writeFileSync(replaceFile, 'before\n');
    let releaseReplace;
    let enteredReplace;
    const replaceEntered = new Promise((resolve) => { enteredReplace = resolve; });
    const heldReplace = core.withFileLock(replaceFile, async () => {
      enteredReplace();
      await new Promise((resolve) => { releaseReplace = resolve; });
    });
    await replaceEntered;
    const queuedReplace = call('search:replace', { files: [replaceFile], query: 'before', replacement: 'after' });
    await sleep(10);
    assert(fs.readFileSync(replaceFile, 'utf8') === 'before\n', 'replace waits for the file lock');
    releaseReplace();
    await Promise.all([heldReplace, queuedReplace]);
    assert(fs.readFileSync(replaceFile, 'utf8') === 'after\n', 'replace runs its read-modify-write under the lock');

    const trashFile = path.join(proj, 'locked-trash.txt');
    fs.writeFileSync(trashFile, 'trash\n');
    core.hooks.trash = async (file) => { await fs.promises.unlink(file); };
    let releaseTrash;
    let enteredTrash;
    const trashEntered = new Promise((resolve) => { enteredTrash = resolve; });
    const heldTrash = core.withFileLock(trashFile, async () => {
      enteredTrash();
      await new Promise((resolve) => { releaseTrash = resolve; });
    });
    await trashEntered;
    const queuedTrash = call('fs:trash', trashFile);
    await sleep(10);
    assert(fs.existsSync(trashFile), 'trash waits for the file lock');
    releaseTrash();
    await Promise.all([heldTrash, queuedTrash]);
    delete core.hooks.trash;
    assert(!fs.existsSync(trashFile), 'trash runs after acquiring its lock');
    for (const file of [createPath, renameTarget, copySource, copyTarget, replaceFile]) fs.rmSync(file, { force: true });
    return 'all mutating file handlers wait for same-path integration locks';
  });
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
  await t('Agent Flow reports host-based worker capacity', async () => {
    const capacity = await call('flow:capacity');
    assert(Number.isInteger(capacity.logicalCpus) && capacity.logicalCpus > 0, 'report logical CPU capacity');
    assert(Number.isInteger(capacity.maxConcurrentAgents) && capacity.maxConcurrentAgents > 0, 'report a positive worker concurrency');
    assert(capacity.maxConcurrentAgents <= capacity.logicalCpus, 'do not exceed logical CPU capacity');
    return `${capacity.maxConcurrentAgents} concurrent agents across ${capacity.logicalCpus} logical CPUs`;
  });
  await t('Agent Flow snapshots existing project changes and integrates worker edits', async () => {
    const projectFile = path.join(proj, 'src', 'a.js');
    const originalContent = fs.readFileSync(projectFile, 'utf8');
    fs.mkdirSync(path.join(proj, '.git'));
    fs.writeFileSync(path.join(proj, '.git', 'private-marker'), 'not copied');
    fs.mkdirSync(path.join(proj, 'node_modules'));
    fs.writeFileSync(path.join(proj, 'node_modules', 'private-marker'), 'not copied');
    const snapshot = await call('flow:workspace:create', proj);
    try {
      const workerFile = path.join(snapshot.root, 'src', 'a.js');
      assert(fs.readFileSync(workerFile, 'utf8') === fs.readFileSync(path.join(proj, 'src', 'a.js'), 'utf8'), 'snapshot includes current project content');
      assert(!fs.existsSync(path.join(snapshot.root, '.git')), 'snapshot excludes Git internals');
      assert(!fs.existsSync(path.join(snapshot.root, 'node_modules')), 'snapshot excludes dependency directories');
      assert(!fs.existsSync(path.join(snapshot.root, '.phantom', 'agent-flow.json')), 'snapshot excludes its own workflow configuration');
      fs.writeFileSync(workerFile, 'worker implementation\n');
      fs.writeFileSync(path.join(snapshot.root, 'src', 'worker-new.js'), 'new worker file\n');
      const integrated = await call('flow:workspace:integrate', proj, snapshot.id);
      assert(integrated.conflicts.length === 0 && integrated.applied.length === 2, 'integrate non-overlapping worker changes');
      assert(fs.readFileSync(path.join(proj, 'src', 'a.js'), 'utf8') === 'worker implementation\n', 'apply worker modification');
      assert(fs.readFileSync(path.join(proj, 'src', 'worker-new.js'), 'utf8') === 'new worker file\n', 'apply worker addition');
      return 'dirty project content copied; worker modification and addition integrated';
    } finally {
      await call('flow:workspace:dispose', snapshot.id);
      fs.writeFileSync(projectFile, originalContent);
      fs.rmSync(path.join(proj, 'src', 'worker-new.js'), { force: true });
      fs.rmSync(path.join(proj, '.git'), { recursive: true, force: true });
      fs.rmSync(path.join(proj, 'node_modules'), { recursive: true, force: true });
    }
  });
  await t('Agent Flow detects same-size worker edits with restored timestamps', async () => {
    const projectFile = path.join(proj, 'src', 'same-stat.txt');
    const originalContent = 'source edit 01\n';
    const workerContent = 'worker edit 01\n';
    fs.writeFileSync(projectFile, originalContent);
    const snapshot = await call('flow:workspace:create', proj);
    try {
      const workerFile = path.join(snapshot.root, 'src', 'same-stat.txt');
      const before = fs.statSync(workerFile);
      fs.writeFileSync(workerFile, workerContent);
      fs.utimesSync(workerFile, before.atime, before.mtime);
      const after = fs.statSync(workerFile);
      assert(after.size === before.size && after.mtimeMs === before.mtimeMs, 'restore metadata to match the baseline');
      const result = await call('flow:workspace:integrate', proj, snapshot.id);
      assert(result.applied.includes(path.join('src', 'same-stat.txt')), 'detect the content edit despite matching metadata');
      assert(fs.readFileSync(projectFile, 'utf8') === workerContent, 'integrate the changed bytes');
      return 'same-size content changes are hashed instead of metadata-cached';
    } finally {
      await call('flow:workspace:dispose', snapshot.id);
      fs.rmSync(projectFile, { force: true });
    }
  });
  await t('Agent Flow detects same-metadata project edits during snapshot creation', async () => {
    const projectFile = path.join(proj, 'src', 'snapshot-race.txt');
    fs.writeFileSync(projectFile, 'source edit 01\n');
    const before = fs.statSync(projectFile);
    const originalCp = fs.promises.cp;
    fs.promises.cp = async function (source, target, options) {
      const result = await originalCp.call(this, source, target, options);
      if (path.resolve(source) === path.resolve(proj)) {
        fs.writeFileSync(projectFile, 'worker edit 01\n');
        fs.utimesSync(projectFile, before.atime, before.mtime);
      }
      return result;
    };
    try {
      try {
        await call('flow:workspace:create', proj);
      } catch (error) {
        assert(error.message.includes('project changed during snapshot creation'), 'reject a content-only concurrent project change');
        return 'same-size project edits with restored timestamps abort snapshot creation';
      }
      throw new Error('snapshot creation missed a content-only project change');
    } finally {
      fs.promises.cp = originalCp;
      fs.rmSync(projectFile, { force: true });
    }
  });
  await t('Agent Flow rechecks a changed destination only once before mutation', async () => {
    const projectFile = path.join(proj, 'src', 'hash-count.txt');
    fs.writeFileSync(projectFile, 'baseline\n');
    const snapshot = await call('flow:workspace:create', proj);
    const workerFile = path.join(snapshot.root, 'src', 'hash-count.txt');
    fs.writeFileSync(workerFile, 'worker edit\n');
    const originalCreateReadStream = fs.createReadStream;
    let destinationHashes = 0;
    fs.createReadStream = function (file, ...args) {
      if (path.resolve(file) === path.resolve(projectFile)) destinationHashes++;
      return originalCreateReadStream.call(this, file, ...args);
    };
    try {
      const result = await call('flow:workspace:integrate', proj, snapshot.id);
      assert(result.applied.includes(path.join('src', 'hash-count.txt')), 'integrate the changed file');
      assert(destinationHashes === 2, `hash once during comparison and once immediately before mutation (got ${destinationHashes})`);
      return 'changed destination hashed twice, not repeatedly under the lock';
    } finally {
      fs.createReadStream = originalCreateReadStream;
      await call('flow:workspace:dispose', snapshot.id);
      fs.rmSync(projectFile, { force: true });
    }
  });
  await t('Agent Flow retains nested build sources but skips project-root outputs', async () => {
    const nestedFile = path.join(proj, 'src', 'build', 'maintained.js');
    const rootOutputFile = path.join(proj, 'build', 'generated.js');
    fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
    fs.mkdirSync(path.dirname(rootOutputFile), { recursive: true });
    fs.writeFileSync(nestedFile, 'maintained source\n');
    fs.writeFileSync(rootOutputFile, 'generated output\n');
    const snapshot = await call('flow:workspace:create', proj);
    try {
      assert(fs.existsSync(path.join(snapshot.root, 'src', 'build', 'maintained.js')), 'copy a maintained nested build directory');
      assert(!fs.existsSync(path.join(snapshot.root, 'build')), 'exclude a generated root build directory');
      fs.writeFileSync(path.join(snapshot.root, 'src', 'build', 'maintained.js'), 'updated source\n');
      const result = await call('flow:workspace:integrate', proj, snapshot.id);
      assert(result.applied.includes(path.join('src', 'build', 'maintained.js')), 'integrate nested source edits');
      assert(fs.readFileSync(nestedFile, 'utf8') === 'updated source\n', 'update nested source');
      return 'root output filtering does not hide nested source directories';
    } finally {
      await call('flow:workspace:dispose', snapshot.id);
      fs.rmSync(path.join(proj, 'src', 'build'), { recursive: true, force: true });
      fs.rmSync(path.join(proj, 'build'), { recursive: true, force: true });
    }
  });
  await t('Agent Flow refuses overlapping worker edits without overwriting the project', async () => {
    const projectFile = path.join(proj, 'src', 'a.js');
    const originalContent = fs.readFileSync(projectFile, 'utf8');
    const snapshot = await call('flow:workspace:create', proj);
    try {
      const file = path.join(snapshot.root, 'src', 'a.js');
      fs.writeFileSync(file, 'worker version\n');
      fs.writeFileSync(path.join(proj, 'src', 'a.js'), 'user version\n');
      fs.writeFileSync(path.join(proj, 'src', 'unrelated.js'), 'unrelated user edit\n');
      const result = await call('flow:workspace:integrate', proj, snapshot.id);
      assert(result.conflicts.includes(path.join('src', 'a.js')), 'report overlapping path');
      assert(fs.readFileSync(path.join(proj, 'src', 'a.js'), 'utf8') === 'user version\n', 'preserve concurrent user change');
      assert(fs.readFileSync(path.join(proj, 'src', 'unrelated.js'), 'utf8') === 'unrelated user edit\n', 'preserve unrelated concurrent edit');
      return 'overlap reported and active project file preserved';
    } finally {
      await call('flow:workspace:dispose', snapshot.id);
      fs.writeFileSync(projectFile, originalContent);
      fs.rmSync(path.join(proj, 'src', 'unrelated.js'), { force: true });
    }
  });
  await t('Agent Flow integrates clean files alongside overlapping edits', async () => {
    const projectFile = path.join(proj, 'src', 'a.js');
    const originalContent = fs.readFileSync(projectFile, 'utf8');
    const snapshot = await call('flow:workspace:create', proj);
    try {
      fs.writeFileSync(path.join(snapshot.root, 'src', 'a.js'), 'worker version\n');
      fs.writeFileSync(path.join(snapshot.root, 'src', 'worker-clean.js'), 'safe worker change\n');
      fs.writeFileSync(projectFile, 'user version\n');
      fs.mkdirSync(path.join(snapshot.root, 'src', 'new-parent'));
      fs.writeFileSync(path.join(snapshot.root, 'src', 'new-parent', 'child.js'), 'blocked by project file\n');
      fs.writeFileSync(path.join(proj, 'src', 'new-parent'), 'project file blocks worker directory\n');
      const result = await call('flow:workspace:integrate', proj, snapshot.id);
      assert(result.conflicts.includes(path.join('src', 'a.js')), 'report the overlapping edit');
      assert(result.conflicts.includes(path.join('src', 'new-parent')), 'treat a non-directory parent as a conflict');
      assert(result.applied.includes(path.join('src', 'worker-clean.js')), 'integrate the clean edit from the same worker');
      assert(fs.readFileSync(projectFile, 'utf8') === 'user version\n', 'preserve the current conflicting project file');
      assert(fs.readFileSync(path.join(proj, 'src', 'new-parent'), 'utf8') === 'project file blocks worker directory\n', 'preserve conflicting non-directory parent');
      assert(fs.readFileSync(path.join(proj, 'src', 'worker-clean.js'), 'utf8') === 'safe worker change\n', 'write the clean worker file');
      fs.writeFileSync(path.join(snapshot.root, 'src', 'a.js'), 'user version\n');
      const resolved = await call('flow:workspace:integrate', proj, snapshot.id, [path.join('src', 'a.js')]);
      assert(!resolved.conflicts.includes(path.join('src', 'a.js')) && resolved.resolved.includes(path.join('src', 'a.js')), 'explicitly resolve the prior conflict by accepting the project version');
      return 'non-overlapping edit integrated; conflict can be explicitly resolved';
    } finally {
      await call('flow:workspace:dispose', snapshot.id);
      fs.writeFileSync(projectFile, originalContent);
      fs.rmSync(path.join(proj, 'src', 'worker-clean.js'), { force: true });
      fs.rmSync(path.join(proj, 'src', 'new-parent'), { force: true });
    }
  });
  await t('Agent Flow rebases retained conflicts with both project and worker versions', async () => {
    const relative = path.join('src', 'rebase.txt');
    const projectFile = path.join(proj, relative);
    const originalContent = 'original baseline\n';
    fs.writeFileSync(projectFile, originalContent);
    const snapshot = await call('flow:workspace:create', proj);
    try {
      fs.writeFileSync(path.join(snapshot.root, relative), 'worker proposal\n');
      fs.writeFileSync(projectFile, 'current project version\n');
      const conflict = await call('flow:workspace:integrate', proj, snapshot.id);
      assert(conflict.conflicts.includes(relative), 'detect the initial overlap');

      const rebased = await call('flow:workspace:rebase', proj, snapshot.id, [relative]);
      const entry = rebased.paths.find((item) => item.path === relative);
      assert(entry, 'return copies for the conflict');
      assert(fs.readFileSync(path.join(snapshot.root, relative), 'utf8') === 'current project version\n', 'reset the original path to the new baseline');
      assert(fs.readFileSync(path.join(snapshot.root, entry.workerVersion), 'utf8') === 'worker proposal\n', 'preserve the prior worker version');
      assert(fs.readFileSync(path.join(snapshot.root, entry.projectVersion), 'utf8') === 'current project version\n', 'preserve the current project version');
      fs.writeFileSync(path.join(snapshot.root, relative), 'merged resolution\n');
      const resolved = await call('flow:workspace:integrate', proj, snapshot.id, [relative]);
      assert(resolved.applied.includes(relative) && !resolved.conflicts.includes(relative), 'integrate a merged edit against the refreshed baseline');
      assert(fs.readFileSync(projectFile, 'utf8') === 'merged resolution\n', 'apply the merged content');
      return 'rebase preserves both versions and accepts a merged retry';
    } finally {
      await call('flow:workspace:dispose', snapshot.id);
      fs.writeFileSync(projectFile, originalContent);
    }
  });
  await t('Agent Flow reports file-to-directory replacement as a conflict', async () => {
    const projectFile = path.join(proj, 'src', 'a.js');
    const originalContent = fs.readFileSync(projectFile, 'utf8');
    const snapshot = await call('flow:workspace:create', proj);
    try {
      fs.unlinkSync(path.join(snapshot.root, 'src', 'a.js'));
      fs.mkdirSync(path.join(snapshot.root, 'src', 'a.js'));
      const result = await call('flow:workspace:integrate', proj, snapshot.id);
      assert(result.conflicts.includes(path.join('src', 'a.js')), 'report the unsupported file/directory replacement');
      assert(fs.readFileSync(projectFile, 'utf8') === originalContent, 'do not delete the original project file');
      return 'replacement reported without deleting source';
    } finally {
      await call('flow:workspace:dispose', snapshot.id);
    }
  });
  await t('Agent Flow clones every concurrent worker from one immutable snapshot', async () => {
    const projectFile = path.join(proj, 'src', 'a.js');
    const originalContent = fs.readFileSync(projectFile, 'utf8');
    const base = await call('flow:workspace:create', proj);
    let clone;
    try {
      fs.writeFileSync(projectFile, 'concurrent user edit after capture\n');
      clone = await call('flow:workspace:clone', base.id);
      assert(fs.readFileSync(path.join(clone.root, 'src', 'a.js'), 'utf8') === originalContent, 'clone inherits the captured baseline, not a later project edit');
      fs.writeFileSync(path.join(base.root, 'src', 'a.js'), 'first worker edit\n');
      assert(fs.readFileSync(path.join(clone.root, 'src', 'a.js'), 'utf8') === originalContent, 'worker snapshots are independent');
      return 'parallel workspaces share a baseline but not writable files';
    } finally {
      if (clone) await call('flow:workspace:dispose', clone.id);
      await call('flow:workspace:dispose', base.id);
      fs.writeFileSync(projectFile, originalContent);
    }
  });
  await t('Agent Flow removes manifests and snapshots left by a crashed process', async () => {
    const staleDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-stale-data-'));
    const staleWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-agent-flow-stale-'));
    const id = '11111111-1111-4111-8111-111111111111';
    const manifestDir = path.join(staleDataDir, 'agent-flow-workspaces');
    fs.mkdirSync(path.join(staleWorkspace, 'project'));
    fs.mkdirSync(manifestDir);
    fs.writeFileSync(path.join(manifestDir, `${id}.json`), JSON.stringify({
      id,
      root: proj,
      workerRoot: path.join(staleWorkspace, 'project'),
      workspaceRoot: staleWorkspace,
      baseline: {},
      createdAt: Date.now()
    }));
    const staleCore = createCore({ dataDir: staleDataDir, emit: () => {} });
    try {
      assert(await staleCore.handlers.get('flow:workspace:get')(id) === null, 'stale workspace is unavailable after startup');
      assert(!fs.existsSync(staleWorkspace), 'stale snapshot directory is removed');
      assert(!fs.existsSync(path.join(manifestDir, `${id}.json`)), 'stale manifest is removed');
      return 'manifest and project copy cleaned on startup';
    } finally {
      await staleCore.shutdown();
      fs.rmSync(staleDataDir, { recursive: true, force: true });
    }
  });
  await t('Agent Flow preserves checkpointed snapshots and cleans orphaned ones', async () => {
    const retainedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-retained-data-'));
    const retainedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-agent-flow-retained-'));
    const orphanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-agent-flow-orphan-'));
    const retainedId = '22222222-2222-4222-8222-222222222222';
    const orphanId = '33333333-3333-4333-8333-333333333333';
    const manifestDir = path.join(retainedDataDir, 'agent-flow-workspaces');
    const storeDir = path.join(retainedDataDir, 'store');
    fs.mkdirSync(path.join(retainedRoot, 'project'));
    fs.mkdirSync(path.join(orphanRoot, 'project'));
    fs.mkdirSync(manifestDir);
    fs.mkdirSync(storeDir);
    for (const [id, workspaceRoot] of [[retainedId, retainedRoot], [orphanId, orphanRoot]]) {
      fs.writeFileSync(path.join(manifestDir, `${id}.json`), JSON.stringify({
        id,
        root: proj,
        workerRoot: path.join(workspaceRoot, 'project'),
        workspaceRoot,
        baseline: {},
        createdAt: Date.now()
      }));
    }
    fs.writeFileSync(path.join(storeDir, 'agentflow-abcdef.json'), JSON.stringify({
      status: 'stopped',
      workspaceIds: [retainedId],
      workspaceByWorker: { worker: { id: retainedId, root: path.join(retainedRoot, 'project') } }
    }));
    const retainedCore = createCore({ dataDir: retainedDataDir, emit: () => {} });
    try {
      const retained = await retainedCore.handlers.get('flow:workspace:get')(retainedId);
      assert(retained?.root === path.join(retainedRoot, 'project'), 'keep the checkpointed workspace available for resume');
      assert(await retainedCore.handlers.get('flow:workspace:get')(orphanId) === null, 'clean an unreferenced workspace');
      await retainedCore.shutdown();
      assert(fs.existsSync(retainedRoot), 'retain the resumable snapshot on shutdown');
      assert(!fs.existsSync(orphanRoot), 'remove the orphan snapshot');
      return 'resumable snapshots survive restart cleanup while orphans are removed';
    } finally {
      await retainedCore.shutdown();
      fs.rmSync(retainedDataDir, { recursive: true, force: true });
      fs.rmSync(retainedRoot, { recursive: true, force: true });
      fs.rmSync(orphanRoot, { recursive: true, force: true });
    }
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
