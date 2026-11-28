'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { createCore } = require('../main/registry');
const { createRuntime } = require('../main/agent-runtime');
const { agentOptions } = require('../main/services/agents');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-agent-runtime-'));
const core = createCore({
  dataDir,
  emit: () => {}
});
const runtime = createRuntime(core);
const sharedRuntime = createRuntime(core);
assert.strictEqual(sharedRuntime, runtime, 'services on one core should share a canonical runtime instance');

async function main() {
  const runs = [];
  for (const provider of ['copilot', 'codex', 'claude']) {
    const run = await runtime.createRun({
      provider,
      cwd: dataDir,
      role: 'worker',
      config: { budgetUsdPerRun: 2 }
    });
    await runtime.appendTurn(run.id, {
      turn: 1,
      role: 'worker',
      provider,
      content: 'Inspect the project and summarize the result.',
      usage: { tokensIn: 100, tokensOut: 50, costUsd: 0.01 }
    });
    await runtime.recordPermissionDecision(run.id, {
      turn: 1,
      role: 'worker',
      tool: 'write_file',
      action: 'write',
      provider
    });
    await runtime.recordApproval(run.id, {
      turn: 1,
      provider,
      tool: 'write_file',
      arguments: { fileName: 'src/example.js' },
      riskSummary: 'Write a project file.',
      outcome: 'approved',
      actor: 'user'
    });
    await runtime.appendTurn(run.id, {
      turn: 2,
      role: 'critic',
      provider,
      content: 'Review complete.',
      usage: { tokensIn: 40, tokensOut: 20, costUsd: 0.005 }
    });

    const saved = await runtime.getRun(run.id);
    assert(saved.transcript.length === 2, `${provider}: canonical transcript not persisted`);
    assert(saved.permissionDecisions[0].decision === 'ask', `${provider}: write must require approval`);
    assert(saved.approvals.length === 1, `${provider}: approval not persisted`);
    assert(saved.usage.tokensIn === 140 && saved.usage.tokensOut === 70, `${provider}: usage totals incorrect`);
    assert(saved.trace.spans.length >= 2, `${provider}: trace spans missing`);

    const rendered = runtime.renderContext(saved);
    assert(rendered.provider === provider, `${provider}: provider context mismatch`);
    assert(rendered.text.includes('Inspect the project'), `${provider}: canonical context missing`);

    const audit = await runtime.verifyAudit(run.id);
    assert(audit.valid, `${provider}: audit chain invalid: ${audit.reason || ''}`);

    await runtime.saveScorecard({
      scenario: 'canonical-context-provider-switch',
      provider,
      completion: 1,
      correctness: 1,
      latencyMs: 120,
      costUsd: 0.015
    });
    runs.push(run.id);
  }

  assert(runtime.evaluatePermission({ role: 'critic', tool: 'write_file', action: 'write' }).decision === 'deny',
    'critic write must be denied');
  assert(runtime.evaluatePermission({ role: 'worker', tool: 'write_file', action: 'delete' }).decision === 'deny',
    'delete must be denied');
  assert(runtime.evaluatePermission({ role: 'supervisor', tool: 'read_file', action: 'read' }).decision === 'allow',
    'supervisor read must be allowed');
  assert(runtime.listSkills().some((skill) => skill.name === 'code-review'), 'built-in skills missing');
  assert(runtime.loadSkill('refactor').roles.includes('worker'), 'skill role metadata missing');
  assert(runtime.tools().length >= 6, 'tool catalog incomplete');
  assert(agentOptions('copilot', { permissionMode: 'auto' }).permissionMode === 'auto',
    'Copilot auto mode should remain available through Phantom policy');
  assert.throws(() => agentOptions('claude', { permissionMode: 'auto' }),
    'Claude should retain native approval instead of enabling a permission bypass');

  const concurrentRun = await runtime.createRun({ provider: 'local', cwd: dataDir, role: 'worker' });
  await Promise.all([
    runtime.appendTurn(concurrentRun.id, { turn: 1, role: 'user', provider: 'local', content: 'first' }),
    sharedRuntime.appendTurn(concurrentRun.id, { turn: 1, role: 'assistant', provider: 'local', content: 'second' }),
    runtime.recordPermissionDecision(concurrentRun.id, { turn: 1, role: 'worker', tool: 'read_file', action: 'read' }),
    sharedRuntime.recordPermissionDecision(concurrentRun.id, { turn: 1, role: 'worker', tool: 'write_file', action: 'write' })
  ]);
  const concurrentSaved = await runtime.getRun(concurrentRun.id);
  assert(concurrentSaved.transcript.length === 2 && concurrentSaved.permissionDecisions.length === 2,
    'overlapping runtime writes should preserve all changes');
  const concurrentAudit = await runtime.verifyAudit(concurrentRun.id);
  assert(concurrentAudit.valid && concurrentAudit.count === 5, 'concurrent audit writes should preserve the hash chain');

  const oversized = await runtime.appendTurn(concurrentRun.id, {
    turn: 2,
    role: 'assistant',
    provider: 'local',
    content: 'x'.repeat(25000)
  });
  assert(oversized.transcript.at(-1).content.length === 20000 && oversized.transcript.at(-1).truncated,
    'oversized provider output should be persisted with an explicit truncation marker');
  await runtime.appendTurn(concurrentRun.id, {
    turn: 3,
    role: 'assistant',
    provider: 'local',
    content: 'No cost reported',
    usage: { tokensIn: 1, tokensOut: 1, costUsd: 0, costKnown: false, turnComplete: true }
  });
  let unknownCostPaused = false;
  try { await runtime.checkBudget(concurrentRun.id); }
  catch { unknownCostPaused = true; }
  assert(unknownCostPaused, 'per-run budget must pause when completed turns have unknown cost');

  const scorecards = await runtime.listScorecards();
  assert(scorecards.length === 3, 'scorecard matrix must contain three providers');
  assert(new Set(scorecards.map((row) => row.provider)).size === 3, 'scorecard matrix providers incomplete');

  console.log('Agent runtime matrix: 3 providers, canonical context, permissions, approvals, audit, and scorecards passed.');
  await core.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error.stack);
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exitCode = 1;
});
