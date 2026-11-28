'use strict';

const { createPlatform } = require('../agent-platform');

module.exports = (core) => {
  const platform = createPlatform(core);
  core.onShutdown(() => platform.close());
  const flowCall = (channel) => async (...args) => {
    const handler = core.handlers.get(channel);
    if (!handler) throw new Error(`Flow API is unavailable: ${channel}.`);
    return handler(...args);
  };

  return {
    'agent:platform:sqlite:open': async () => {
      await platform.openDatabase();
      const engine = platform.databaseEngine();
      return { opened: true, engine: engine === 'native' ? 'node:sqlite' : engine === 'sqljs' ? 'sql.js' : engine };
    },
    'agent:platform:run:save': async (run) => platform.saveRun(run),
    'agent:platform:run:get': async (runId) => platform.getRun(runId),
    'agent:platform:checkpoint:save': async (runId, phase, state) => platform.saveCheckpoint(runId, phase, state),
    'agent:platform:checkpoint:list': async (runId) => platform.listCheckpoints(runId),
    'agent:platform:graph:create': async (config) => platform.createGraphRun(config),
    'agent:platform:graph:advance': async (runId, input) => platform.advanceGraph(runId, input),
    'agent:platform:graph:resume': async (runId) => platform.resumeGraph(runId),
    'agent:platform:graph:checkpoint': async (runId, decision) => platform.humanCheckpoint(runId, decision),
    'agent:platform:memory:remember': async (record) => platform.remember(record),
    'agent:platform:memory:list': async () => platform.memoryRead(),
    'agent:platform:memory:search': async (query) => platform.memorySearch(query),
    'agent:platform:memory:maintain': async () => platform.memoryMaintenance(),
    'agent:platform:cache:get': async (key) => platform.cacheGet(key),
    'agent:platform:cache:set': async (key, value, ttlMs) => platform.cacheSet(key, value, ttlMs),
    'agent:platform:budget:set': async (budget) => platform.setBudget(budget),
    'agent:platform:budget:check': async (budget) => platform.checkBudget(budget),
    'agent:platform:budget:spend': async (spend) => platform.recordSpend(spend),
    'agent:platform:mcp:list': async () => platform.mcpList(),
    'agent:platform:mcp:discover': async (config) => platform.mcpDiscover(config),
    'agent:platform:mcp:register': async (tool) => platform.mcpRegisterTool(tool),
    'agent:platform:mcp:call': async (request) => platform.mcpCall(request),
    'agent:platform:skill:import': async (file) => platform.importSkill(file),
    'agent:platform:session:export': async (runId) => platform.exportSession(runId),
    'agent:platform:session:import': async (file) => platform.importSession(file),
    'agent:platform:trace:export': async (runId, endpoint) => platform.exportTrace(runId, endpoint),
    'agent:platform:local:run': async (request) => platform.runLocalModel(request),
    'agent:platform:sandbox:validate': async (root, targets) => platform.validateProjectSandbox(root, targets),
    'agent:platform:artifact:add': async (runId, artifact) => platform.addArtifact(runId, artifact),
    'agent:platform:prompt:screen': async (text) => platform.screenPrompt(text),
    'agent:platform:flow:capacity': flowCall('flow:capacity'),
    'agent:platform:flow:workspace:create': flowCall('flow:workspace:create'),
    'agent:platform:flow:workspace:clone': flowCall('flow:workspace:clone'),
    'agent:platform:flow:workspace:rebase': flowCall('flow:workspace:rebase'),
    'agent:platform:flow:workspace:integrate': flowCall('flow:workspace:integrate'),
    'agent:platform:flow:workspace:dispose': flowCall('flow:workspace:dispose')
  };
};
