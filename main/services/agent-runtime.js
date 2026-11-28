'use strict';

const { createRuntime } = require('../agent-runtime');

module.exports = (core) => {
  const runtime = createRuntime(core);

  return {
    'agent:runtime:runs:list': async (limit) => runtime.listRuns(limit),
    'agent:runtime:run:get': async (runId) => runtime.getRun(runId),
    'agent:runtime:run:status': async (runId, status, error) => runtime.setStatus(runId, status, error),
    'agent:runtime:permission:check': async (details) => runtime.evaluatePermission(details),
    'agent:runtime:permission:record': async (runId, details) => runtime.recordPermissionDecision(runId, details),
    'agent:runtime:approval:record': async (runId, approval) => runtime.recordApproval(runId, approval),
    'agent:runtime:context': async (runId, maxTokens) => {
      const run = await runtime.getRun(runId);
      if (!run) throw new Error('Agent run no longer exists.');
      return runtime.renderContext(run, maxTokens);
    },
    'agent:runtime:audit:verify': async (runId) => runtime.verifyAudit(runId),
    'agent:runtime:skills:list': async () => runtime.listSkills(),
    'agent:runtime:skills:get': async (name) => runtime.loadSkill(name),
    'agent:runtime:tools:list': async () => runtime.tools(),
    'agent:runtime:budget:check': async (runId) => runtime.checkBudget(runId),
    'agent:runtime:scorecard:list': async (limit) => runtime.listScorecards(limit),
    'agent:runtime:scorecard:add': async (scorecard) => runtime.saveScorecard(scorecard)
  };
};
