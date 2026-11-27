import { h, join, sep } from '../core/dom.js';
import { call, on, bus } from '../core/api.js';
import { project } from '../core/project.js';
import { renderMarkdown } from '../core/markdown.js';
import { confirm, fail, form, toast } from '../core/ui.js';
import { wm } from '../core/wm.js';
import {
  FLOW_ACTION_TAG, parseFlowAction, validateRoadmapPlan, validateGoalEvidence
} from '../core/flow-protocol.mjs';

const STORE_KEY = 'agent-flows';
const PRESET_STORE_KEY = 'agent-flow-presets';
const RUN_CHECKPOINT_PREFIX = 'agentflow-';
const PROVIDERS = [
  ['copilot', 'GitHub Copilot'],
  ['codex', 'Codex'],
  ['claude', 'Claude Code']
];
const REASONING_EFFORTS = {
  copilot: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max']
};
const AGENT_MODES = [
  ['interactive', 'Interactive'],
  ['plan', 'Plan'],
  ['autopilot', 'Autopilot']
];
const AGENT_ROLES = [
  ['worker', 'Worker'],
  ['reviewer', 'Reviewer']
];
const AGENT_ROLE_MODES = [
  ['simple', 'Simple Agent Role'],
  ['advanced', 'Advanced Agent Role']
];
const SIMPLE_AGENT_ROLES = [
  ['planner', 'Planner', 'Analyze the request, identify dependencies and risks, and produce a concise ordered plan with clear completion criteria.'],
  ['frontend', 'FrontEnd', 'Handle frontend work in the assigned scope. Follow the project UI patterns, accessibility requirements, responsive behavior, and existing design system.'],
  ['backend', 'Backend', 'Handle backend work in the assigned scope. Follow existing architecture, validate inputs, handle errors explicitly, and add focused tests where appropriate.'],
  ['debugger', 'Debugger', 'Reproduce the reported behavior, trace it to its root cause, make a focused fix within the assigned scope, and verify it with targeted checks.'],
  ['orchestrator', 'Orchestrator', 'Coordinate the assigned scope: clarify ambiguity, organize the work into steps, track dependencies, and synthesize the result without claiming work outside this assignment.'],
  ['brainstormer', 'BrainStormer', 'Generate distinct, practical approaches for the assigned task, compare trade-offs, and recommend a direction with concise reasoning.'],
  ['security-engineer', 'SecurityEngineer', 'Review the assigned code for secure design, authentication, authorization, input handling, secrets, and data-protection issues. Report evidence, impact, and focused remediation.']
];
const MAX_REVISION_ROUNDS = 20;
const MAX_TASK_LENGTH = 5000;
const MAX_ROLE_LENGTH = 3000;
const MAX_AGENT_OUTPUT = 100000;
const MAX_UNDO_STEPS = 100;
const MIN_ZOOM = 0.35;
const CANVAS_HINT = 'Left-drag nodes to move or empty canvas to select nodes and wires; Ctrl/Cmd-click to toggle; Ctrl+Z undo, Ctrl+Shift+Z redo, Delete removes selected agents/connections. Middle/right-drag pans; wheel zooms.';

function makeDefaultWorkflow() {
  const nodes = [
    { id: 'task', type: 'input', label: 'Task', x: 45, y: 470, prompt: '' },
    {
      id: 'copilot-worker', type: 'agent', role: 'worker', provider: 'copilot', model: 'auto', reasoningEffort: '', agentRoleMode: 'advanced', simpleRole: 'backend', agentMode: 'autopilot', permissionMode: 'manual', label: 'Implementation worker',
      x: 355, y: 470, instructions: 'Implement the assigned subtask in the active project. Keep changes focused, preserve existing behavior, and report files changed and unresolved issues.'
    },
    {
      id: 'codex-reviewer', type: 'agent', role: 'reviewer', provider: 'codex', model: '', reasoningEffort: '', agentRoleMode: 'advanced', simpleRole: 'security-engineer', agentMode: 'plan', permissionMode: 'manual', webSearchMode: 'disabled', label: 'Independent reviewer',
      x: 355, y: 60, instructions: 'Review the implementation and changed files independently. Look for defects, missed requirements, and tests to run. Do not modify files; report actionable findings with paths.'
    },
    {
      id: 'claude-architect', type: 'agent', role: 'reviewer', provider: 'claude', model: '', agentRoleMode: 'advanced', simpleRole: 'planner', agentMode: 'plan', permissionMode: 'manual', reasoningEffort: '', label: 'Architecture reviewer',
      x: 355, y: 800, instructions: 'Review the changes from an architecture and integration perspective. Look for risks, regressions, and validation gaps. Do not modify files; report actionable findings with paths.'
    },
    {
      id: 'compiler', type: 'compiler', label: 'Compiler & Tests', x: 790, y: 800, buildCommand: 'auto', testCommand: 'auto'
    },
    {
      id: 'orchestrator', type: 'orchestrator', provider: 'copilot', model: 'auto', reasoningEffort: '', agentRoleMode: 'advanced', simpleRole: 'orchestrator', agentMode: 'plan', permissionMode: 'manual', label: 'Orchestrator', revisionRounds: 3,
      x: 790, y: 470, instructions: 'Clarify ambiguity with the user, delegate scoped work to workers, evaluate reviewers and build/test results, direct revisions to the right workers, and produce a final response with evidence.'
    },
    { id: 'result', type: 'output', label: 'Final response', x: 1200, y: 470 }
  ];
  const edges = [
    { source: 'task', target: 'copilot-worker' },
    { source: 'copilot-worker', target: 'compiler' },
    { source: 'compiler', target: 'codex-reviewer' },
    { source: 'compiler', target: 'claude-architect' },
    { source: 'compiler', target: 'orchestrator' },
    { source: 'codex-reviewer', target: 'orchestrator' },
    { source: 'claude-architect', target: 'orchestrator' },
    { source: 'orchestrator', target: 'result' }
  ];
  return { name: 'Multi-agent review', nodes, edges };
}

function makeRoleFlowPreset(name, agents) {
  const task = { id: 'task', type: 'input', label: 'Task', x: 45, y: 470, prompt: '' };
  const agentNodes = agents.map((agent, index) => ({
    id: `${agent.simpleRole}-${index + 1}`,
    type: 'agent',
    role: agent.role,
    provider: agent.provider || 'copilot',
    model: agent.provider === 'copilot' || !agent.provider ? 'auto' : '',
    reasoningEffort: '',
    agentRoleMode: 'simple',
    simpleRole: agent.simpleRole,
    agentMode: agent.mode || (agent.role === 'reviewer' ? 'plan' : 'autopilot'),
    permissionMode: 'manual',
    label: agent.label,
    x: agent.x ?? 355,
    y: agent.y ?? (agent.role === 'reviewer' ? 80 + index * 250 : 360 + index * 210),
    instructions: ''
  }));
  const compiler = { id: 'compiler', type: 'compiler', label: 'Compiler & Tests', x: 790, y: 800, buildCommand: 'auto', testCommand: 'auto' };
  const orchestrator = {
    id: 'orchestrator', type: 'orchestrator', provider: 'copilot', model: 'auto', reasoningEffort: '',
    agentRoleMode: 'advanced', simpleRole: 'orchestrator', agentMode: 'plan', permissionMode: 'manual',
    label: 'Orchestrator', revisionRounds: 2, x: 790, y: 470,
    instructions: 'Clarify ambiguity with the user, delegate scoped work to workers, evaluate reviewer and build/test results, direct revisions to the right workers, and produce a final response with evidence.'
  };
  const output = { id: 'result', type: 'output', label: 'Final response', x: 1200, y: 470 };
  const edges = [];
  for (const agent of agentNodes) {
    if (agent.role === 'reviewer') {
      edges.push({ source: compiler.id, target: agent.id });
      edges.push({ source: agent.id, target: orchestrator.id });
    } else {
      edges.push({ source: task.id, target: agent.id });
      edges.push({ source: agent.id, target: compiler.id });
      edges.push({ source: agent.id, target: orchestrator.id });
    }
  }
  edges.push({ source: compiler.id, target: orchestrator.id });
  edges.push({ source: orchestrator.id, target: output.id });
  return { name, nodes: [task, ...agentNodes, compiler, orchestrator, output], edges };
}

const BUILTIN_FLOW_PRESETS = [
  { id: 'multi-agent-review', name: 'Multi-agent Review', create: makeDefaultWorkflow },
  {
    id: 'frontend-build-review',
    name: 'FrontEnd Build & Review',
    create: () => makeRoleFlowPreset('FrontEnd Build & Review', [
      { simpleRole: 'frontend', role: 'worker', label: 'FrontEnd specialist' },
      { simpleRole: 'security-engineer', role: 'reviewer', label: 'Security reviewer' }
    ])
  },
  {
    id: 'debug-and-fix',
    name: 'Debug & Verify',
    create: () => makeRoleFlowPreset('Debug & Verify', [
      { simpleRole: 'debugger', role: 'worker', label: 'Bug investigator' },
      { simpleRole: 'security-engineer', role: 'reviewer', label: 'Fix reviewer' }
    ])
  },
  {
    id: 'plan-and-brainstorm',
    name: 'Plan & Brainstorm',
    create: () => makeRoleFlowPreset('Plan & Brainstorm', [
      { simpleRole: 'planner', role: 'worker', label: 'Planner', mode: 'plan', y: 360 },
      { simpleRole: 'brainstormer', role: 'worker', label: 'Brainstormer', mode: 'plan', y: 620 }
    ])
  }
];

function copyWorkflow(value) {
  return JSON.parse(JSON.stringify(value));
}

function workflowSignature(value) {
  const text = JSON.stringify(value);
  let first = 2166136261;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 2246822519);
  }
  return `${text.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

function checkpointStorageKey(rootPath) {
  let hash = 14695981039346656037n;
  for (let index = 0; index < rootPath.length; index++) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(rootPath.charCodeAt(index))) * 1099511628211n);
  }
  return `${RUN_CHECKPOINT_PREFIX}${hash.toString(16)}`;
}

export default {
  id: 'flow', title: 'Agent Flow', icon: 'branch', desc: 'Manage a goal-driven team of AI agents',
  size: [1160, 780], min: [850, 560], singleton: true,
  async create(win) {
    const root = h('div.af-root.fill');
    let workflow = makeDefaultWorkflow();
    let availableTools = {};
    let detectedTasks = [];
    let accountState = { providers: {}, active: {}, usage: {} };
    let accountStateLoaded = false;
    let workerCapacity = { maxConcurrentAgents: 1, logicalCpus: 1, freeMemoryBytes: 0 };
    let busy = false;
    let cancelled = false;
    let runToken = 0;
    let selectedNodeId = 'task';
    let selectedNodeIds = new Set(['task']);
    let selectedEdges = [];
    let suppressNodeClick = false;
    let connectionDrag = null;
    let panDrag = null;
    let selectionDrag = null;
    let panX = 0;
    let panY = 0;
    let zoom = 1;
    let saveTimer = null;
    let pendingSave = null;
    let undoStack = [];
    let redoStack = [];
    let historySnapshot = null;
    let pendingHistorySnapshot = null;
    let savedPresets = [];
    let runCheckpoint = null;
    let checkpointWrite = Promise.resolve();
    const activeConversations = new Map();
    const activeTaskRuns = new Set();
    const runStates = new Map();
    const nodeElements = new Map();
    const nodeStatusElements = new Map();

    const nameInput = h('input.inp.af-name', { maxLength: 80, placeholder: 'Workflow name' });
    const projectLabel = h('span.af-project');
    const saveStatus = h('span.af-save-status', 'Loading…');
    const signInButton = h('button.btn.ghost', 'SIGN IN');
    const runButton = h('button.btn.primary', 'START AGENT RUN');
    const resumeButton = h('button.btn.ghost', { hidden: true, title: 'Resume from the latest saved checkpoint' }, 'RESUME');
    const stopButton = h('button.btn.ghost', { hidden: true }, 'STOP');
    const presetSelect = h('select.inp.af-preset-select', { 'aria-label': 'Agent Flow preset' },
      h('option', { value: '' }, 'Choose a preset…')
    );
    const loadPresetButton = h('button.btn.ghost', { type: 'button', disabled: true }, 'LOAD PRESET');
    const savePresetButton = h('button.btn.ghost', { type: 'button' }, 'SAVE PRESET');
    const deletePresetButton = h('button.btn.ghost', { type: 'button', disabled: true }, 'DELETE PRESET');
    const presetToolbar = h('div.af-preset-toolbar',
      h('span.af-preset-label', 'FLOW PRESETS'),
      presetSelect,
      loadPresetButton,
      savePresetButton,
      deletePresetButton
    );
    const connectionHint = h('span.af-hint', CANVAS_HINT);
    const billingHint = h('span.af-billing-hint', 'The selected manager provider, subscription account, and model are shared by workers and reviewers. Provider permissions and approval prompts remain enforced.');
    const viewport = h('div.af-viewport', { tabindex: 0, 'aria-label': 'Agent Flow canvas' });
    const stage = h('div.af-stage');
    const world = h('div.af-world');
    const selectionBox = h('div.af-selection-box');
    const wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    wires.classList.add('af-wires');
    wires.setAttribute('width', '1');
    wires.setAttribute('height', '1');
    world.appendChild(wires);
    stage.appendChild(world);
    viewport.appendChild(stage);
    viewport.appendChild(selectionBox);
    const inspector = h('aside.af-inspector');
    const zoomLabel = h('span.af-zoom-label', '100%');
    const zoomOutButton = h('button.af-zoom-button', { type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out' }, '−');
    const zoomInButton = h('button.af-zoom-button', { type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in' }, '+');
    const resetZoomButton = h('button.af-zoom-reset', { type: 'button', title: 'Reset zoom' }, 'RESET');
    const zoomControls = h('div.af-zoom-controls', zoomOutButton, zoomLabel, zoomInButton, resetZoomButton);
    const workspace = h('div.af-workspace', h('div.af-canvas-panel', viewport, zoomControls), inspector);
    const runStatus = h('span.af-run-status', 'IDLE');
    const results = h('div.af-results');
    const taskInput = h('textarea.inp.af-manager-task', {
      rows: 5, maxLength: MAX_TASK_LENGTH, placeholder: 'Describe the outcome you want. The manager will create a roadmap and delegate the work.'
    });
    const providerSelect = h('select.inp.af-manager-provider',
      ...PROVIDERS.map(([id, label]) => h('option', { value: id }, label))
    );
    const accountSelect = h('select.inp.af-manager-account');
    const modelInput = h('input.inp.af-manager-model', { maxLength: 128, placeholder: 'Provider default model' });
    const reasoningSelect = h('select.inp.af-manager-reasoning');
    const permissionSelect = h('select.inp.af-manager-permission',
      h('option', { value: 'manual' }, 'Manual approval'),
      h('option', { value: 'assisted' }, 'Assisted reads'),
      h('option', { value: 'project-scoped' }, 'Project-scoped files'),
      h('option', { value: 'auto' }, 'Auto-allow (still confirm sandbox bypass)')

    );
    const revisionInput = h('input.inp.af-manager-rounds', { type: 'number', min: 0, max: MAX_REVISION_ROUNDS, step: 1 });
    const capacityStatus = h('span.af-capacity-status', 'Checking host capacity…');
    const roadmapList = h('div.af-roadmap-list', h('div.af-empty-state', 'The manager roadmap will appear here after you start a run.'));
    const workerList = h('div.af-worker-list', h('div.af-empty-state', 'No active workers.'));
    const workerCount = h('span.af-section-count', '0');
    const roadmapCount = h('span.af-section-count', '0');
    const managerSummary = h('span.af-manager-summary-text', 'The manager will plan the request, choose how many workers it needs, integrate their changes, and iterate through checks.');

    function currentProjectKey() {
      return project.root || '__global__';
    }

    function updateControls() {
      projectLabel.textContent = project.root ? `${project.name} · ${project.root}` : 'No project open';
      runButton.disabled = busy || !project.root;
      const resumable = !busy && project.root && runCheckpoint &&
        runCheckpoint.projectRoot === project.root &&
        runCheckpoint.workflowSignature === workflowSignature(workflow) &&
        runCheckpoint.status !== 'complete';
      resumeButton.hidden = !resumable;
      resumeButton.disabled = !resumable;
      resumeButton.title = resumable ? `Resume at ${runCheckpoint.progress || runCheckpoint.phase}` : 'Resume from the latest saved checkpoint';
      nameInput.disabled = busy;
      taskInput.disabled = busy;
      providerSelect.disabled = busy;
      accountSelect.disabled = busy;
      modelInput.disabled = busy;
      reasoningSelect.disabled = busy;
      permissionSelect.disabled = busy || providerSelect.value !== 'copilot';
      revisionInput.disabled = busy;
      stopButton.hidden = !busy;
      presetSelect.disabled = busy;
      loadPresetButton.disabled = busy || !presetSelect.value;
      savePresetButton.disabled = busy;
      deletePresetButton.disabled = busy || !presetSelect.value.startsWith('custom:');
      for (const field of root.querySelectorAll('.af-inspector input, .af-inspector textarea, .af-inspector select, .af-port, .af-model-discover')) {
        const copilotOnlyPermission = field.classList.contains('af-permission-mode') &&
          selectedNodeIds.size === 1 && nodeById(selectedNodeId)?.provider !== 'copilot';
        const copilotOnlyMcp = field.classList.contains('af-mcp-toggle') && nodeById(selectedNodeId)?.provider !== 'copilot';
        field.disabled = busy || copilotOnlyPermission || copilotOnlyMcp ||
          (!project.root && field.classList.contains('af-model-discover'));
      }
    }

    function setNodeStatus(id, text, state = '') {
      runStates.set(id, { text, state });
      if (runCheckpoint) runCheckpoint.nodeStates = Object.fromEntries(runStates);
      const el = nodeStatusElements.get(id);
      if (el) {
        el.textContent = text;
        el.className = `af-node-status${state ? ` ${state}` : ''}`;
      }
      renderWorkerRoster();
    }

    function saveRunCheckpoint() {
      if (!runCheckpoint?.projectRoot) return Promise.resolve();
      runCheckpoint.updatedAt = Date.now();
      runCheckpoint.nodeStates = Object.fromEntries(runStates);
      const snapshot = copyWorkflow(runCheckpoint);
      const write = checkpointWrite.catch(() => {}).then(async () => {
        await call('store:set', checkpointStorageKey(snapshot.projectRoot), snapshot);
      });
      checkpointWrite = write;
      return write;
    }

    function clearRunCheckpoint(rootPath = project.root) {
      if (!rootPath) return Promise.resolve();
      const write = checkpointWrite.catch(() => {}).then(async () => {
        await call('store:set', checkpointStorageKey(rootPath), null);
      });
      checkpointWrite = write;
      return write;
    }

    async function disposeRunWorkspaces(checkpoint = runCheckpoint) {
      if (!checkpoint) return;
      const ids = new Set([
        ...(Array.isArray(checkpoint.workspaceIds) ? checkpoint.workspaceIds : []),
        ...Object.values(checkpoint.workspaceByWorker || {}).map((workspace) => workspace?.id)
      ].filter((id) => typeof id === 'string'));
      for (const id of ids) await call('flow:workspace:dispose', id);
      checkpoint.workspaceIds = [];
      checkpoint.workspaceByWorker = {};
    }

    async function setCheckpointPhase(phase, progress, token) {
      assertRunCurrent(token);
      runCheckpoint.phase = phase;
      runCheckpoint.progress = progress;
      runCheckpoint.activeNodeId = '';
      runStatus.textContent = `RUNNING · ${progress}`;
      managerSummary.textContent = progress;
      await saveRunCheckpoint();
      assertRunCurrent(token);
    }

    async function loadRunCheckpoint() {
      if (!project.root) return;
      await checkpointWrite;
      const saved = await call('store:get', checkpointStorageKey(project.root), null);
      if (!saved || ![1, 2].includes(saved.version) || saved.projectRoot !== project.root) return;
      runCheckpoint = saved;
      if (saved.workflowSignature !== workflowSignature(workflow)) {
        runStatus.textContent = 'CHECKPOINT OUTDATED · WORKFLOW CHANGED';
        appendResult('SAVED RUN CHECKPOINT', 'The workflow changed after this checkpoint. Start a new run to replace it.');
        return;
      }
      if (!['plan', 'implement', 'compiler', 'review', 'decision', 'revision', 'finalize', 'complete'].includes(saved.phase) ||
          !['running', 'interrupted', 'stopped', 'failed', 'blocked', 'complete'].includes(saved.status)) {
        runCheckpoint = null;
        return;
      }
      saved.assignments = Array.isArray(saved.assignments) ? saved.assignments : [];
      saved.completedWorkers = Array.isArray(saved.completedWorkers) ? saved.completedWorkers : [];
      saved.clarifications = Array.isArray(saved.clarifications) ? saved.clarifications : [];
      saved.values = Array.isArray(saved.values) ? saved.values : [];
      saved.reviewHistory = Array.isArray(saved.reviewHistory) ? saved.reviewHistory : [];
      saved.currentReviewResults = Array.isArray(saved.currentReviewResults) ? saved.currentReviewResults : [];
      saved.roadmapGoals = Array.isArray(saved.roadmapGoals) ? saved.roadmapGoals : [];
      saved.workerRoster = Array.isArray(saved.workerRoster) ? saved.workerRoster : [];
      saved.goalEvidence = Array.isArray(saved.goalEvidence) ? saved.goalEvidence : [];
      saved.integrationReports = Array.isArray(saved.integrationReports) ? saved.integrationReports : [];
      saved.unresolvedConflicts = Array.isArray(saved.unresolvedConflicts) ? saved.unresolvedConflicts : [];
      saved.workspaceIds = Array.isArray(saved.workspaceIds) ? saved.workspaceIds : [];
      saved.workspaceByWorker = saved.workspaceByWorker && typeof saved.workspaceByWorker === 'object' ? saved.workspaceByWorker : {};
      saved.unresolvedConflictOwners = saved.unresolvedConflictOwners && typeof saved.unresolvedConflictOwners === 'object' ? saved.unresolvedConflictOwners : {};
      if (!Object.keys(saved.unresolvedConflictOwners).length && saved.integrationReports.length) {
        const owners = {};
        for (const report of saved.integrationReports) {
          if (!report || typeof report.workerId !== 'string') continue;
          for (const file of [...(report.applied || []), ...(report.resolved || [])]) {
            const remaining = (owners[file] || []).filter((id) => id !== report.workerId);
            if (remaining.length) owners[file] = remaining;
            else delete owners[file];
          }
          for (const file of report.conflicts || []) {
            owners[file] = [...new Set([...(owners[file] || []), report.workerId])];
          }
        }
        saved.unresolvedConflictOwners = owners;
        saved.unresolvedConflicts = Object.keys(owners);
        const conflictedWorkers = new Set(Object.values(owners).flat());
        saved.completedWorkers = saved.completedWorkers.filter((id) => !conflictedWorkers.has(id));
      }
      if (saved.version === 1 && saved.status !== 'complete') {
        saved.version = 2;
        saved.phase = 'plan';
        saved.status = 'interrupted';
        saved.assignments = [];
        saved.completedWorkers = [];
        saved.workerRoster = [];
        saved.roadmapGoals = [];
        saved.goalEvidence = [];
        saved.progress = 'Legacy run migrated; the manager will create a fresh roadmap on resume';
        await saveRunCheckpoint();
      }
      runStates.clear();
      for (const [id, state] of Object.entries(saved.nodeStates || {})) {
        const knownWorker = saved.workerRoster.some((worker) => worker.id === id);
        if ((nodeById(id) || knownWorker) && state && typeof state.text === 'string') runStates.set(id, state);
      }
      if (saved.status === 'running') {
        const interruptedNode = saved.activeNodeId;
        saved.status = 'interrupted';
        saved.progress = `Interrupted during ${saved.progress || saved.phase}`;
        saved.activeNodeId = '';
        if (interruptedNode && nodeById(interruptedNode)) setNodeStatus(interruptedNode, 'INTERRUPTED', 'error');
        await saveRunCheckpoint();
      }
      if (saved.status === 'complete') {
        runStatus.textContent = 'COMPLETE · SAVED RUN';
        const outputText = saved.outputText || saved.finalText;
        if (outputText) appendResult('FINAL RESPONSE · RESTORED', outputText, true, true);
      } else if (saved.status === 'blocked') {
        runStatus.textContent = 'BLOCKED · INCOMPLETE';
        managerSummary.textContent = saved.progress || 'Completion gates remain unsatisfied.';
        const outputText = saved.outputText || saved.finalText;
        if (outputText) appendResult('BLOCKED · SAVED RUN', outputText, true, true);
      } else {
        runStatus.textContent = `${saved.status.toUpperCase()} · ${saved.progress || saved.phase}`;
        appendResult('SAVED RUN CHECKPOINT', `Progress: ${saved.progress || saved.phase}\nUpdated: ${new Date(saved.updatedAt || Date.now()).toLocaleString()}\nResume will continue from the latest completed step. An interrupted agent step may be retried.`);
      }
      for (const [id, text] of saved.values || []) {
        if (!text || id === 'task' || id === 'orchestrator') continue;
        const node = nodeById(id) || saved.workerRoster.find((worker) => worker.id === id);
        if (node) appendResult(`${node.label} · RESTORED OUTPUT`, text, false, true);
      }
      renderRoadmap();
      renderWorkerRoster();
    }

    async function writeWorkflow(key, value) {
      if (key === '__global__') {
        const all = await call('store:get', STORE_KEY, {});
        all[key] = value;
        await call('store:set', STORE_KEY, all);
      } else {
        await call('flow:save', key, value);
      }
      if (key === currentProjectKey()) saveStatus.textContent = key === '__global__' ? 'SAVED LOCALLY' : 'SAVED IN PROJECT';
    }

    function resetHistory() {
      undoStack = [];
      redoStack = [];
      historySnapshot = copyWorkflow(workflow);
      pendingHistorySnapshot = null;
    }

    function recordHistorySnapshot(snapshot) {
      if (!historySnapshot) {
        historySnapshot = copyWorkflow(snapshot);
        return;
      }
      if (JSON.stringify(snapshot) === JSON.stringify(historySnapshot)) return;
      undoStack.push(copyWorkflow(historySnapshot));
      if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
      historySnapshot = copyWorkflow(snapshot);
      redoStack = [];
    }

    function flushPendingHistory() {
      if (!pendingHistorySnapshot) return;
      const snapshot = pendingHistorySnapshot;
      pendingHistorySnapshot = null;
      recordHistorySnapshot(snapshot);
    }

    function scheduleSave() {
      clearTimeout(saveTimer);
      saveStatus.textContent = 'UNSAVED';
      pendingSave = { key: currentProjectKey(), value: copyWorkflow(workflow) };
      pendingHistorySnapshot = pendingSave.value;
      saveTimer = setTimeout(() => {
        const pending = pendingSave;
        pendingSave = null;
        saveTimer = null;
        flushPendingHistory();
        if (!pending) return;
        writeWorkflow(pending.key, pending.value).catch((error) => {
          saveStatus.textContent = 'SAVE FAILED';
          fail(error, 'SAVE AGENT FLOW');
        });
      }, 350);
      updateControls();
    }

    function renderPresetOptions() {
      const selected = presetSelect.value;
      const options = [
        h('option', { value: '' }, 'Choose a preset…'),
        h('optgroup', { label: 'Built-in templates' },
          ...BUILTIN_FLOW_PRESETS.map((preset) => h('option', { value: `builtin:${preset.id}` }, preset.name))
        )
      ];
      if (savedPresets.length) {
        options.push(h('optgroup', { label: 'My presets' },
          ...savedPresets.map((preset) => h('option', { value: `custom:${preset.id}` }, preset.name))
        ));
      }
      presetSelect.replaceChildren(...options);
      presetSelect.value = selected;
      if (presetSelect.value !== selected) presetSelect.value = '';
      loadPresetButton.disabled = busy || !presetSelect.value;
      savePresetButton.disabled = busy;
      deletePresetButton.disabled = busy || !presetSelect.value.startsWith('custom:');
    }

    async function refreshSavedPresets() {
      const stored = await call('store:get', PRESET_STORE_KEY, []);
      savedPresets = Array.isArray(stored)
        ? stored.filter((preset) =>
          preset && typeof preset.id === 'string' && typeof preset.name === 'string' &&
          preset.workflow && Array.isArray(preset.workflow.nodes) && Array.isArray(preset.workflow.edges)
        ).map((preset) => ({ id: preset.id, name: preset.name, workflow: copyWorkflow(preset.workflow) }))
        : [];
      renderPresetOptions();
    }

    function getSelectedPreset() {
      const [scope, id] = presetSelect.value.split(':', 2);
      if (scope === 'builtin') {
        const preset = BUILTIN_FLOW_PRESETS.find((item) => item.id === id);
        return preset ? { name: preset.name, workflow: preset.create() } : null;
      }
      if (scope === 'custom') {
        const preset = savedPresets.find((item) => item.id === id);
        return preset ? { name: preset.name, workflow: copyWorkflow(preset.workflow) } : null;
      }
      return null;
    }

    async function applySelectedPreset() {
      if (busy) return;
      const preset = getSelectedPreset();
      if (!preset) {
        toast('Choose a valid Agent Flow preset first.', 'warn');
        return;
      }
      if (!(await confirm(
        'LOAD AGENT FLOW PRESET',
        `Replace the current flow with "${preset.name}"? You can undo this with Ctrl+Z.`,
        { ok: 'LOAD PRESET' }
      ))) return;
      await clearRunCheckpoint();
      runCheckpoint = null;
      workflow = copyWorkflow(preset.workflow);
      workflow.name = preset.name;
      selectedNodeId = workflow.nodes.find((node) => node.type === 'input')?.id || workflow.nodes[0]?.id || null;
      selectedNodeIds = new Set(selectedNodeId ? [selectedNodeId] : []);
      selectedEdges = [];
      runStates.clear();
      results.replaceChildren();
      runStatus.textContent = 'IDLE';
      nameInput.value = workflow.name;
      centerGraph(true);
      renderGraph();
      syncManagerControls();
      scheduleSave();
    }

    async function saveCurrentPreset() {
      if (busy) return;
      const values = await form('SAVE AGENT FLOW PRESET', [
        { key: 'name', label: 'Preset name', type: 'text', value: workflow.name, placeholder: 'Reusable workflow name' }
      ], { ok: 'SAVE PRESET', width: 460 });
      if (!values) return;
      const name = values.name.trim();
      if (!name || name.length > 64 || /[\u0000-\u001f]/.test(name)) {
        toast('Enter a preset name under 65 characters.', 'warn');
        return;
      }
      const existing = savedPresets.find((preset) => preset.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      if (existing && !(await confirm(
        'REPLACE FLOW PRESET',
        `A preset named "${existing.name}" already exists. Replace it?`,
        { ok: 'REPLACE', danger: true }
      ))) return;
      const preset = {
        id: existing?.id || `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        workflow: copyWorkflow(workflow)
      };
      const next = existing
        ? savedPresets.map((item) => item.id === existing.id ? preset : item)
        : [...savedPresets, preset];
      await call('store:set', PRESET_STORE_KEY, next);
      savedPresets = next;
      renderPresetOptions();
      presetSelect.value = `custom:${preset.id}`;
      updateControls();
      toast(`"${name}" is available in My presets.`, 'info', 'FLOW PRESET');
    }

    async function deleteSelectedPreset() {
      if (busy || !presetSelect.value.startsWith('custom:')) return;
      const id = presetSelect.value.slice('custom:'.length);
      const preset = savedPresets.find((item) => item.id === id);
      if (!preset || !(await confirm(
        'DELETE FLOW PRESET',
        `Delete "${preset.name}" from My presets? This will not change the current workflow.`,
        { ok: 'DELETE', danger: true }
      ))) return;
      const next = savedPresets.filter((item) => item.id !== id);
      await call('store:set', PRESET_STORE_KEY, next);
      savedPresets = next;
      renderPresetOptions();
      updateControls();
      toast(`"${preset.name}" was deleted.`, 'info', 'FLOW PRESET');
    }

    async function loadWorkflow() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        const pending = pendingSave;
        pendingSave = null;
        if (pending) {
          flushPendingHistory();
          await writeWorkflow(pending.key, pending.value);
        }
      }
      pendingHistorySnapshot = null;
      connectionDrag = null;
      runCheckpoint = null;
      const key = currentProjectKey();
      const projectSaved = key === '__global__' ? null : await call('flow:load', key);
      const all = key === '__global__' || !projectSaved ? await call('store:get', STORE_KEY, {}) : null;
      const saved = projectSaved || (all && all[key]);
      const migrated = !projectSaved && !!saved && key !== '__global__';
      let repairedAccount = false;
      let repairedWorkflow = false;
      workflow = saved && Array.isArray(saved.nodes) && Array.isArray(saved.edges)
        ? saved
        : makeDefaultWorkflow();
      workflow.name = typeof workflow.name === 'string' ? workflow.name : 'Agent workflow';
      workflow.nodes = workflow.nodes.filter((node) =>
        node && ['input', 'agent', 'orchestrator', 'compiler', 'output'].includes(node.type) &&
        typeof node.id === 'string' && Number.isFinite(node.x) && Number.isFinite(node.y)
      );
      workflow.edges = workflow.edges.filter((edge) =>
        edge && typeof edge.source === 'string' && typeof edge.target === 'string'
      );
      for (const node of workflow.nodes) {
        node.label = typeof node.label === 'string' ? node.label : node.type;
        if (node.type === 'input') node.prompt = typeof node.prompt === 'string' ? node.prompt : '';
        if (node.type === 'compiler') {
          node.buildCommand = typeof node.buildCommand === 'string' ? node.buildCommand : 'auto';
          node.testCommand = typeof node.testCommand === 'string' ? node.testCommand : 'auto';
        }
        if (node.type === 'orchestrator') {
          node.revisionRounds = Number.isInteger(node.revisionRounds)
            ? Math.max(0, Math.min(MAX_REVISION_ROUNDS, node.revisionRounds))
            : 3;
        }
        if (node.type === 'agent' || node.type === 'orchestrator') {
          if (!PROVIDERS.some(([id]) => id === node.provider)) node.provider = 'copilot';
          node.instructions = typeof node.instructions === 'string' ? node.instructions : '';
          node.model = typeof node.model === 'string' ? node.model : '';
          node.reasoningEffort = typeof node.reasoningEffort === 'string' &&
            REASONING_EFFORTS[node.provider].includes(node.reasoningEffort)
            ? node.reasoningEffort
            : '';
          node.webSearchMode = ['disabled', 'cached', 'live'].includes(node.webSearchMode) ? node.webSearchMode : 'disabled';
          node.agentMode = AGENT_MODES.some(([mode]) => mode === node.agentMode) ? node.agentMode : 'plan';
          node.permissionMode = node.provider === 'copilot' && ['manual', 'assisted', 'project-scoped'].includes(node.permissionMode)
            ? node.permissionMode
            : 'manual';
          node.enableMcp = node.provider === 'copilot' && node.enableMcp === true;
          node.accountId = typeof node.accountId === 'string' ? node.accountId : '';
          node.agentRoleMode = AGENT_ROLE_MODES.some(([mode]) => mode === node.agentRoleMode)
            ? node.agentRoleMode
            : 'advanced';
          node.simpleRole = SIMPLE_AGENT_ROLES.some(([role]) => role === node.simpleRole)
            ? node.simpleRole
            : 'backend';
          if (node.type === 'agent') {
            const inferredRole = /review|audit|verify|quality/i.test(`${node.label} ${node.instructions}`) ? 'reviewer' : 'worker';
            node.role = AGENT_ROLES.some(([role]) => role === node.role) ? node.role : inferredRole;
            if (node.role === 'reviewer') node.agentMode = 'plan';
          }
          if (accountStateLoaded && node.accountId &&
              !accountsFor(node.provider).some((profile) => profile.id === node.accountId)) {
            node.accountId = '';
            repairedAccount = true;
          }
        }
      }
      if (!workflow.nodes.some((node) => node.type === 'compiler')) {
        const orchestrator = workflow.nodes.find((node) => node.type === 'orchestrator');
        if (orchestrator) {
          const compiler = {
            id: 'compiler', type: 'compiler', label: 'Compiler & Tests',
            x: orchestrator.x, y: orchestrator.y + 320, buildCommand: 'auto', testCommand: 'auto'
          };
          workflow.nodes.push(compiler);
          for (const agent of workflow.nodes.filter((node) => node.type === 'agent')) {
            workflow.edges.push({ source: agent.id, target: compiler.id });
          }
          workflow.edges.push({ source: compiler.id, target: orchestrator.id });
          repairedWorkflow = true;
        }
      }
      if (!workflow.nodes.some((node) => node.id === selectedNodeId)) {
        selectedNodeId = workflow.nodes.find((node) => node.type === 'input')?.id || workflow.nodes[0]?.id;
      }
      selectedNodeIds = new Set(selectedNodeId ? [selectedNodeId] : []);
      selectedEdges = [];
      resetHistory();
      nameInput.value = workflow.name;
      runStates.clear();
      results.replaceChildren();
      runStatus.textContent = 'IDLE';
      saveStatus.textContent = saved
        ? key === '__global__' ? 'SAVED LOCALLY' : 'SAVED IN PROJECT'
        : 'NEW WORKFLOW';
      await loadRunCheckpoint();
      centerGraph(true);
      renderGraph();
      syncManagerControls();
      renderRoadmap();
      renderWorkerRoster();
      updateControls();
      if (!saved || migrated || repairedAccount || repairedWorkflow) scheduleSave();
    }

    function nodeById(id) {
      return workflow.nodes.find((node) => node.id === id);
    }

    function edgeAllowed(source, target) {
      if (!source || !target || source.id === target.id || target.type === 'input' || source.type === 'output') return false;
      if (target.type === 'output') return ['agent', 'compiler', 'orchestrator'].includes(source.type);
      if (source.type === 'input') return target.type === 'agent' || target.type === 'orchestrator';
      if (source.type === 'agent') return ['agent', 'compiler', 'orchestrator'].includes(target.type);
      if (source.type === 'compiler') return ['agent', 'orchestrator'].includes(target.type);
      return false;
    }

    function pathExists(from, to, edges = workflow.edges) {
      const visited = new Set();
      const stack = [from];
      while (stack.length) {
        const id = stack.pop();
        if (id === to) return true;
        if (visited.has(id)) continue;
        visited.add(id);
        for (const edge of edges) if (edge.source === id) stack.push(edge.target);
      }
      return false;
    }

    function connect(sourceId, targetId) {
      const source = nodeById(sourceId);
      const target = nodeById(targetId);
      connectionHint.textContent = CANVAS_HINT;
      if (!edgeAllowed(source, target)) {
        toast('That connection is not valid for these node types.', 'warn');
        return;
      }
      if (workflow.edges.some((edge) => edge.source === sourceId && edge.target === targetId)) {
        toast('Those nodes are already connected.', 'warn');
        return;
      }
      if (pathExists(targetId, sourceId)) {
        toast('That connection would create a cycle.', 'warn');
        return;
      }
      selectedEdges = [];
      workflow.edges.push({ source: sourceId, target: targetId });
      connectionHint.textContent = CANVAS_HINT;
      renderGraph();
      scheduleSave();
    }

    function port(node, direction) {
      const button = h(`button.af-port.${direction}`, {
        type: 'button',
        title: direction === 'out' ? 'Drag to connect' : 'Drop a connection here',
        'aria-label': `${direction === 'out' ? 'Connect from' : 'Connect to'} ${node.label || node.type}`
      }, direction === 'out' ? '●' : '○');
      button.dataset.nodeId = node.id;
      if (direction === 'out') button.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        connectionDrag = {
          sourceId: node.id,
          pointerId: event.pointerId,
          point: screenToWorld(event.clientX, event.clientY)
        };
        connectionHint.textContent = `Connecting from ${node.label || node.type}… drop on an input port.`;
        drawEdges();
      });
      return button;
    }

    function startDrag(event, node) {
      if (event.button !== 0 || event.target.closest('button, input, textarea, select')) return;
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      if (!selectedNodeIds.has(node.id)) selectNode(node.id);
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      const movingNodes = [...selectedNodeIds].map(nodeById).filter(Boolean);
      const origins = new Map(movingNodes.map((item) => [item.id, { x: item.x, y: item.y }]));
      let moved = false;
      const move = (moveEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        const dx = (moveEvent.clientX - startX) / zoom;
        const dy = (moveEvent.clientY - startY) / zoom;
        if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) moved = true;
        for (const item of movingNodes) {
          const origin = origins.get(item.id);
          item.x = origin.x + dx;
          item.y = origin.y + dy;
          const itemElement = nodeElements.get(item.id);
          if (itemElement) {
            itemElement.style.left = `${item.x}px`;
            itemElement.style.top = `${item.y}px`;
          }
        }
        drawEdges();
      };
      const end = (endEvent) => {
        if (endEvent.pointerId !== pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        if (moved) {
          suppressNodeClick = true;
          setTimeout(() => { suppressNodeClick = false; }, 0);
          scheduleSave();
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end, { once: true });
      window.addEventListener('pointercancel', end, { once: true });
    }

    function fieldText(value, placeholder, onChange, className = 'af-role-text', maxLength = MAX_ROLE_LENGTH) {
      const area = h(`textarea.inp.${className}`, { rows: 3, maxLength, placeholder });
      area.value = value || '';
      area.addEventListener('input', () => onChange(area.value));
      return area;
    }

    function roleInstructions(node) {
      if (node.agentRoleMode === 'simple') {
        return SIMPLE_AGENT_ROLES.find(([id]) => id === node.simpleRole)?.[2] || '';
      }
      return node.instructions || '';
    }

    function nodeSummary(node) {
      if (node.type === 'input') return node.prompt?.trim() || 'Add the task for this workflow in the inspector.';
      if (node.type === 'output') return 'Collects results from connected workers, reviewers, compiler, and orchestrator.';
      if (node.type === 'compiler') return 'Runs the selected project build and test commands.';
      const provider = PROVIDERS.find(([id]) => id === node.provider)?.[1] || node.provider;
      const mode = AGENT_MODES.find(([id]) => id === node.agentMode)?.[1] || 'Plan';
      const role = node.agentRoleMode === 'simple'
        ? SIMPLE_AGENT_ROLES.find(([id]) => id === node.simpleRole)?.[1] || 'Simple role'
        : 'Advanced role';
      return node.type === 'agent'
        ? `${node.role === 'reviewer' ? 'Reviewer' : 'Worker'} · ${role} · ${provider} · ${mode} · ${node.model || 'default model'}`
        : `${role} · ${provider} · ${mode} · coordinates workers, reviews, and checks`;
    }

    function accountsFor(provider) {
      return accountState.providers[provider] || [{ id: 'default', name: 'Default CLI login' }];
    }

    function renderManagerAccountOptions() {
      const selectedProvider = providerSelect.value || nodeById('orchestrator')?.provider || 'copilot';
      const profiles = accountsFor(selectedProvider);
      accountSelect.replaceChildren(...profiles.map((profile) =>
        h('option', { value: profile.id }, profile.name)
      ));
      const orchestrator = nodeById('orchestrator');
      accountSelect.value = orchestrator?.accountId || accountState.active[selectedProvider] || profiles[0]?.id || 'default';
    }

    function syncManagerControls() {
      const input = workflow.nodes.find((node) => node.type === 'input');
      const orchestrator = workflow.nodes.find((node) => node.type === 'orchestrator');
      if (input && document.activeElement !== taskInput) taskInput.value = input.prompt || '';
      if (orchestrator) {
        providerSelect.value = orchestrator.provider;
        modelInput.value = orchestrator.model === 'auto' ? '' : orchestrator.model || '';
        reasoningSelect.replaceChildren(
          h('option', { value: '' }, 'Provider default'),
          ...REASONING_EFFORTS[orchestrator.provider].map((effort) => h('option', { value: effort }, effort.toUpperCase()))
        );
        reasoningSelect.value = orchestrator.reasoningEffort || '';
        permissionSelect.value = orchestrator.provider === 'copilot' ? orchestrator.permissionMode || 'manual' : 'manual';
        revisionInput.value = String(orchestrator.revisionRounds ?? 3);
      }
      renderManagerAccountOptions();
      capacityStatus.textContent = `${workerCapacity.recommendedConcurrentAgents || workerCapacity.maxConcurrentAgents} active worker${(workerCapacity.recommendedConcurrentAgents || workerCapacity.maxConcurrentAgents) === 1 ? '' : 's'} at a time · ${workerCapacity.logicalCpus} logical CPU${workerCapacity.logicalCpus === 1 ? '' : 's'}`;
      updateControls();
    }

    function renderRoadmap() {
      const goals = runCheckpoint?.roadmapGoals || [];
      roadmapCount.textContent = String(goals.length);
      if (!goals.length) {
        roadmapList.replaceChildren(h('div.af-empty-state', 'The manager roadmap will appear here after you start a run.'));
        return;
      }
      const evidence = new Map((runCheckpoint.goalEvidence || []).map((item) => [item.goalId, item.evidence]));
      roadmapList.replaceChildren(...goals.map((goal, index) => h('article.af-goal',
        h('div.af-goal-head',
          h('span.af-goal-index', String(index + 1).padStart(2, '0')),
          h('strong', goal.title),
          h('span.af-goal-state' + (evidence.has(goal.id) ? '.done' : ''), evidence.has(goal.id) ? 'VERIFIED' : 'IN PROGRESS')
        ),
        h('ul', ...goal.acceptanceCriteria.map((criterion) => h('li', criterion))),
        evidence.has(goal.id) ? h('p.af-goal-evidence', evidence.get(goal.id)) : null
      )));
    }

    function renderWorkerRoster() {
      const workers = runCheckpoint?.workerRoster || [];
      workerCount.textContent = String(workers.length);
      if (!workers.length) {
        workerList.replaceChildren(h('div.af-empty-state', 'No active workers.'));
        return;
      }
      workerList.replaceChildren(...workers.map((worker, index) => {
        const status = runStates.get(worker.id) || { text: 'QUEUED', state: '' };
        return h('article.af-worker',
          h('span.af-worker-index', String(index + 1).padStart(2, '0')),
          h('div.af-worker-info',
            h('strong', worker.label),
            h('span', `${worker.provider || 'manager provider'} · ${worker.goalIds?.length || 0} roadmap goal${worker.goalIds?.length === 1 ? '' : 's'}`)
          ),
          h(`span.af-worker-state${status.state ? ` ${status.state}` : ''}`, status.text)
        );
      }));
    }

    function effectiveAccountId(node) {
      return node.accountId || accountState.active[node.provider] || 'default';
    }

    function renderNode(node) {
      const status = runStates.get(node.id) || { text: 'READY', state: '' };
      const label = h('strong.af-node-label', node.label || node.type);
      const heading = h('div.af-node-head',
        h('div.af-node-title', label,
          h('div.af-node-meta', h('span.af-node-kind', node.type.toUpperCase()), h('span.af-node-drag-hint', 'DRAG'))
        ),
        h('div.af-ports', ...(node.type === 'output' ? [] : [port(node, 'out')]), ...(node.type === 'input' ? [] : [port(node, 'in')]))
      );
      const card = h(`article.af-node.${node.type}${selectedNodeIds.has(node.id) ? '.selected' : ''}`, {
        tabindex: 0,
        'aria-label': `${node.label || node.type}, ${node.type} node`,
        style: { left: `${node.x}px`, top: `${node.y}px` },
        on: {
          pointerdown: (event) => startDrag(event, node),
          click: (event) => {
            if (suppressNodeClick) {
              suppressNodeClick = false;
              return;
            }
            if (event.ctrlKey || event.metaKey) selectNode(node.id, true);
            else if (!selectedNodeIds.has(node.id)) selectNode(node.id);
          },
          keydown: (event) => {
            if (event.target === card && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              selectNode(node.id);
            }
          }
        }
      });
      const statusEl = h(`span.af-node-status${status.state ? ` ${status.state}` : ''}`, status.text);
      nodeStatusElements.set(node.id, statusEl);
      const footer = h('div.af-node-foot', statusEl,
        h('span.af-node-open-hint', 'SELECT TO EDIT')
      );
      card.append(heading, h('p.af-node-summary', nodeSummary(node)), footer);
      nodeElements.set(node.id, card);
      return card;
    }

    function selectNode(id, additive = false) {
      if (!nodeById(id)) return;
      const next = new Set(selectedNodeIds);
      if (additive) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      } else {
        next.clear();
        next.add(id);
      }
      setNodeSelection(next, next.has(id) ? id : [...next].pop() || null);
    }

    function setNodeSelection(ids, primaryId = null) {
      setFlowSelection(ids, [], primaryId);
    }

    function setFlowSelection(ids, edges = [], primaryId = null) {
      selectedNodeIds = new Set([...ids].filter((id) => nodeById(id)));
      selectedNodeId = selectedNodeIds.has(primaryId)
        ? primaryId
        : [...selectedNodeIds].pop() || null;
      selectedEdges = edges.map(({ source, target }) => ({ source, target }));
      updateNodeSelection();
      renderInspector();
      drawEdges();
      viewport.focus({ preventScroll: true });
    }

    function updateNodeSelection() {
      for (const [nodeId, element] of nodeElements) {
        element.classList.toggle('selected', selectedNodeIds.has(nodeId));
      }
    }

    function selectEdge(edge, additive = false) {
      const key = `${edge.source}\u0000${edge.target}`;
      const selected = new Map(selectedEdges.map((item) => [`${item.source}\u0000${item.target}`, item]));
      if (additive) {
        if (selected.has(key)) selected.delete(key);
        else selected.set(key, { source: edge.source, target: edge.target });
      } else {
        selected.clear();
        selected.set(key, { source: edge.source, target: edge.target });
        selectedNodeIds.clear();
        selectedNodeId = null;
      }
      selectedEdges = [...selected.values()];
      updateNodeSelection();
      renderInspector();
      viewport.focus({ preventScroll: true });
    }

    function removeSelectedEdges() {
      if (!selectedEdges.length) return;
      if (busy) {
        toast('Stop the workflow before deleting connections.', 'warn');
        return;
      }
      const selected = new Set(selectedEdges.map((edge) => `${edge.source}\u0000${edge.target}`));
      const previousLength = workflow.edges.length;
      workflow.edges = workflow.edges.filter((edge) => !selected.has(`${edge.source}\u0000${edge.target}`));
      if (workflow.edges.length === previousLength) {
        selectedEdges = [];
        renderInspector();
        return;
      }
      selectedEdges = [];
      renderGraph();
      scheduleSave();
    }

    async function deleteSelectedItems() {
      if (busy) {
        toast('Stop the workflow before deleting nodes or connections.', 'warn');
        return;
      }
      const agentIds = [...selectedNodeIds]
        .map(nodeById)
        .filter((node) => node?.type === 'agent')
        .map((node) => node.id);
      const removeIds = new Set(agentIds);
      const selectedKeys = new Set(selectedEdges.map((edge) => `${edge.source}\u0000${edge.target}`));
      const edgesToRemove = workflow.edges.filter((edge) =>
        selectedKeys.has(`${edge.source}\u0000${edge.target}`) ||
        removeIds.has(edge.source) || removeIds.has(edge.target)
      ).length;
      if (!agentIds.length && !selectedEdges.length) return;
      if (agentIds.length && !(await confirm(
        'DELETE SELECTED ITEMS',
        `Remove ${agentIds.length} agent node${agentIds.length === 1 ? '' : 's'} and ${edgesToRemove} connection${edgesToRemove === 1 ? '' : 's'}?`,
        { ok: 'DELETE', danger: true }
      ))) return;

      workflow.nodes = workflow.nodes.filter((node) => !removeIds.has(node.id));
      workflow.edges = workflow.edges.filter((edge) =>
        !selectedKeys.has(`${edge.source}\u0000${edge.target}`) &&
        !removeIds.has(edge.source) && !removeIds.has(edge.target)
      );
      const remainingIds = new Set([...selectedNodeIds].filter((id) => !removeIds.has(id)));
      const primaryId = removeIds.has(selectedNodeId) ? null : selectedNodeId;
      setFlowSelection(remainingIds, [], primaryId);
      renderGraph();
      scheduleSave();
    }

    function renderInspector() {
      inspector.replaceChildren();
      if (selectedEdges.length && !selectedNodeIds.size) {
        const connections = selectedEdges.map((edge) => ({
          source: nodeById(edge.source),
          target: nodeById(edge.target)
        })).filter(({ source, target }) => source && target);
        if (connections.length) {
          const title = h('div.af-inspector-head',
            h('span.af-inspector-kicker', 'CONNECTION'),
            h('h3', connections.length === 1
              ? `${connections[0].source.label} → ${connections[0].target.label}`
              : `${connections.length} connections selected`),
            h('span.af-inspector-help', 'Press Delete or remove the selected connection(s) below.')
          );
          const content = h('div.af-inspector-content');
          const remove = h('button.btn.ghost.af-remove-agent', { type: 'button' },
            `REMOVE ${connections.length === 1 ? 'CONNECTION' : 'CONNECTIONS'}`
          );
          remove.addEventListener('click', removeSelectedEdges);
          content.append(remove);
          inspector.append(title, content);
          return;
        }
        selectedEdges = [];
      }
      if (selectedNodeIds.size > 1 || selectedEdges.length) {
        renderMultiInspector();
        return;
      }
      const node = nodeById(selectedNodeId);
      if (!node) {
        inspector.append(h('div.af-inspector-empty', 'Select a node to configure it.'));
        return;
      }
      const title = h('div.af-inspector-head',
        h('span.af-inspector-kicker', `${node.type.toUpperCase()} NODE`),
        h('h3', node.label || node.type),
        h('span.af-inspector-help', 'Settings are saved with this workflow.')
      );
      const content = h('div.af-inspector-content');
      const label = h('input.inp.af-label-editor', { maxLength: 64, value: node.label || node.type, 'aria-label': 'Node name' });
      label.addEventListener('input', () => {
        node.label = label.value.trim() || node.type;
        title.querySelector('h3').textContent = node.label;
        const nodeLabel = nodeElements.get(node.id)?.querySelector('.af-node-label');
        if (nodeLabel) nodeLabel.textContent = node.label;
        scheduleSave();
      });
      content.append(h('label.af-field', h('span', 'NODE NAME'), label));

      if (node.type === 'input') {
        const area = fieldText(node.prompt, 'Describe the task for your agents…', (value) => {
          node.prompt = value;
          const summary = nodeElements.get(node.id)?.querySelector('.af-node-summary');
          if (summary) summary.textContent = value.trim() || 'Add the task for this workflow in the inspector.';
          scheduleSave();
        }, 'af-task', MAX_TASK_LENGTH);
        content.append(h('label.af-field', h('span', 'TASK'), area));
      } else if (node.type === 'compiler') {
        const commandSelect = (labelText, kind, value, onChange) => {
          const tasks = detectedTasks.filter((task) => task.kind === kind);
          const autoLabel = tasks[0]?.command ? `Auto · ${tasks[0].command}` : 'Auto · no detected command';
          const knownCommands = new Set(tasks.map((task) => task.command));
          const select = h('select.inp.af-compiler-task',
            h('option', { value: 'auto' }, autoLabel),
            h('option', { value: 'none' }, 'Do not run'),
            ...tasks.map((task) => h('option', { value: task.command }, `${task.name} · ${task.command}`)),
            ...(value && !['auto', 'none'].includes(value) && !knownCommands.has(value)
              ? [h('option', { value }, `Unavailable · ${value}`)]
              : [])
          );
          select.value = value || 'auto';
          select.addEventListener('change', () => onChange(select.value));
          content.append(h('label.af-field', h('span', labelText), select));
        };
        commandSelect('BUILD COMMAND', 'build', node.buildCommand, (value) => {
          node.buildCommand = value;
          scheduleSave();
        });
        commandSelect('TEST COMMAND', 'test', node.testCommand, (value) => {
          node.testCommand = value;
          scheduleSave();
        });
        content.append(h('p.af-output-note', 'Commands are detected from the active project. Auto selects the first detected build/test command; checks run after implementation and before review.'));
      } else if (node.type === 'agent' || node.type === 'orchestrator') {
        if (node.type === 'agent') {
          const roleSelect = h('select.inp.af-agent-role',
            ...AGENT_ROLES.map(([value, labelText]) => h('option', { value }, labelText))
          );
          roleSelect.value = node.role || 'worker';
          roleSelect.addEventListener('change', () => {
            node.role = roleSelect.value;
            if (node.role === 'reviewer') {
              node.agentMode = 'plan';
              node.permissionMode = 'manual';
            }
            renderGraph();
            scheduleSave();
          });
          content.append(h('label.af-field', h('span', 'FLOW FUNCTION'), roleSelect));
        } else {
          const revisionRounds = h('input.inp.af-revision-rounds', {
            type: 'number', min: 0, max: MAX_REVISION_ROUNDS, step: 1, value: node.revisionRounds ?? 3,
            'aria-label': 'Maximum revision rounds'
          });
          revisionRounds.addEventListener('change', () => {
            node.revisionRounds = Math.max(0, Math.min(MAX_REVISION_ROUNDS, Number.parseInt(revisionRounds.value, 10) || 0));
            revisionRounds.value = String(node.revisionRounds);
            scheduleSave();
          });
          content.append(h('label.af-field', h('span', 'MAX REVIEW / FIX ROUNDS'), revisionRounds));
        }
        const roleModeSelect = h('select.inp.af-role-mode',
          ...AGENT_ROLE_MODES.map(([value, labelText]) => h('option', { value }, labelText))
        );
        roleModeSelect.value = node.agentRoleMode;
        roleModeSelect.addEventListener('change', () => {
          node.agentRoleMode = roleModeSelect.value;
          renderGraph();
          scheduleSave();
        });
        content.append(h('label.af-field', h('span', 'ROLE CONFIGURATION'), roleModeSelect));
        if (node.agentRoleMode === 'simple') {
          const simpleRoleSelect = h('select.inp.af-simple-role',
            ...SIMPLE_AGENT_ROLES.map(([value, labelText]) => h('option', { value }, labelText))
          );
          simpleRoleSelect.value = node.simpleRole;
          simpleRoleSelect.addEventListener('change', () => {
            node.simpleRole = simpleRoleSelect.value;
            renderGraph();
            scheduleSave();
          });
          content.append(
            h('label.af-field', h('span', 'PRESET ROLE'), simpleRoleSelect),
            h('span.af-provider-hint', 'Uses built-in role instructions. Switch to Advanced to edit instructions or set reasoning effort.')
          );
        }
        const providerSelect = h('select.inp.af-provider',
          ...PROVIDERS.map(([id, name]) => h('option', { value: id }, name))
        );
        providerSelect.value = node.provider;
        providerSelect.addEventListener('change', () => {
          node.provider = providerSelect.value;
          if (!REASONING_EFFORTS[node.provider].includes(node.reasoningEffort)) node.reasoningEffort = '';
          if (node.provider !== 'codex') node.webSearchMode = 'disabled';
          if (node.provider !== 'copilot') node.permissionMode = 'manual';
          if (node.provider !== 'copilot') node.enableMcp = false;
          if (node.accountId && !accountsFor(node.provider).some((profile) => profile.id === node.accountId)) node.accountId = '';
          renderGraph();
          scheduleSave();
        });
        content.append(h('label.af-field', h('span', 'PROVIDER'), providerSelect));

        const accountSelect = h('select.inp.af-account',
          ...accountsFor(node.provider).map((profile) => h('option', { value: profile.id }, profile.name))
        );
        accountSelect.value = effectiveAccountId(node);
        accountSelect.addEventListener('change', () => {
          node.accountId = accountSelect.value;
          scheduleSave();
        });
        content.append(h('label.af-field', h('span', 'SUBSCRIPTION ACCOUNT'), accountSelect));

        const modeSelect = h('select.inp.af-agent-mode',
          ...AGENT_MODES.map(([value, labelText]) => h('option', { value }, labelText))
        );
        modeSelect.value = node.agentMode;
        modeSelect.disabled = node.type === 'agent' && node.role === 'reviewer';
        modeSelect.addEventListener('change', () => {
          node.agentMode = modeSelect.value;
          renderGraph();
          scheduleSave();
        });
        content.append(h('label.af-field', h('span', 'AGENT MODE'), modeSelect));
        const permissionSelect = h('select.inp.af-permission-mode',
          h('option', { value: 'manual' }, node.provider === 'copilot' ? 'Manual · ask before actions' : 'Manual · provider default'),
          h('option', { value: 'assisted', disabled: node.provider !== 'copilot' }, 'Assisted · Copilot reads only'),
          h('option', { value: 'project-scoped', disabled: node.provider !== 'copilot' }, 'Project-scoped · Copilot file reads/writes')
        );
        permissionSelect.value = node.permissionMode;
        permissionSelect.disabled = node.provider !== 'copilot';
        permissionSelect.addEventListener('change', () => {
          node.permissionMode = permissionSelect.value;
          renderGraph();
          scheduleSave();
        });
        content.append(h('label.af-field', h('span', 'PERMISSIONS'), permissionSelect));
        content.append(h('span.af-provider-hint', node.provider === 'copilot'
          ? node.permissionMode === 'project-scoped'
            ? 'Auto-approves file reads and writes inside this project. Shell, network, sandbox-bypass, managed, and out-of-project requests still require approval; Plan rejects non-read actions.'
            : 'Assisted auto-approves only safety-approved reads inside this project. Other requests require approval; Plan rejects non-read actions.'
          : node.provider === 'codex'
            ? 'Plan and Interactive are read-only. Autopilot can write inside this project; elevated requests remain approval-gated.'
            : 'Uses Claude Code native permissions. Plan is read-only; Autopilot accepts project edits but does not bypass command permissions.'));
        const mcpToggle = h('input.af-mcp-toggle', {
          type: 'checkbox',
          checked: node.enableMcp,
          disabled: node.provider !== 'copilot',
          'aria-label': 'Enable project MCP configuration'
        });
        mcpToggle.addEventListener('change', () => {
          node.enableMcp = mcpToggle.checked;
          scheduleSave();
        });
        content.append(
          h('label.af-mcp-option', mcpToggle, h('span', 'Load project MCP servers')),
          h('span.af-provider-hint', 'Opt-in starts MCP servers configured for this project. Every MCP tool action still requires approval.')
        );

        const modelListId = `af-models-${node.id.replace(/[^\w-]/g, '-')}`;
        const model = h('input.inp.af-model', {
          maxLength: 128,
          placeholder: node.provider === 'copilot' ? 'auto (default)' : 'Provider default',
          list: modelListId
        });
        model.value = node.model || '';
        model.addEventListener('input', () => {
          node.model = model.value;
          const summary = nodeElements.get(node.id)?.querySelector('.af-node-summary');
          if (summary) summary.textContent = nodeSummary(node);
          scheduleSave();
        });
        const modelList = h('datalist', { id: modelListId });
        const modelControl = h('div.af-model-control', model, modelList);
        if (node.provider === 'copilot') {
          const discover = h('button.af-model-discover', { type: 'button', title: 'Load subscription models' }, 'LIST');
          discover.addEventListener('click', async () => {
            discover.disabled = true;
            discover.textContent = '…';
            try {
              const models = await call('agent:models', 'copilot', project.root, effectiveAccountId(node));
              modelList.replaceChildren(...[
                h('option', { value: 'auto', label: 'Automatic selection' }),
                ...models.map((item) => h('option', { value: item.id, label: item.label }))
              ]);
              if (!models.length) toast('No Copilot subscription models were returned. You can still enter a model ID.', 'info');
              else toast(`Loaded ${models.length} Copilot subscription models.`, 'info', 'MODELS');
            } catch (error) {
              fail(error, 'LOAD COPILOT MODELS');
            } finally {
              discover.disabled = busy || !project.root;
              discover.textContent = 'LIST';
            }
          });
          modelControl.appendChild(discover);
        }
        content.append(h('label.af-field', h('span', 'MODEL'), modelControl));

        if (node.agentRoleMode === 'advanced') {
          const effort = h('select.inp.af-effort',
            h('option', { value: '' }, 'Provider default'),
            ...REASONING_EFFORTS[node.provider].map((level) => h('option', { value: level }, level.toUpperCase()))
          );
          effort.value = node.reasoningEffort || '';
          effort.addEventListener('change', () => {
            node.reasoningEffort = effort.value;
            scheduleSave();
          });
          content.append(h('label.af-field', h('span', 'REASONING EFFORT'), effort));
        }
        if (node.provider === 'codex') {
          const webSearch = h('select.inp.af-web-search',
            ...[['disabled', 'Off'], ['cached', 'Cached'], ['live', 'Live']].map(([value, labelText]) => h('option', { value }, labelText))
          );
          webSearch.value = node.webSearchMode;
          webSearch.addEventListener('change', () => {
            node.webSearchMode = webSearch.value;
            scheduleSave();
          });
          content.append(h('label.af-field', h('span', 'WEB SEARCH'), webSearch));
        }
        if (node.agentRoleMode === 'advanced') {
          const instructions = fieldText(node.instructions, 'Describe this agent’s role, responsibilities, and output…', (value) => {
            node.instructions = value;
            scheduleSave();
          });
          content.append(h('label.af-field', h('span', 'CUSTOM ROLE / INSTRUCTIONS'), instructions));
        }

        const providerHint = node.provider === 'claude'
          ? (availableTools.claude ? 'Claude Code runs non-interactively in plan mode.' : 'Claude Code CLI not found. Install it to run this node.')
          : node.provider === 'codex'
            ? 'Codex is read-only. Web search is optional and disabled by default.'
            : 'Copilot tool actions require explicit approval.';
        content.append(h('span.af-provider-hint', providerHint));
      } else if (node.type === 'output') {
        content.append(h('p.af-output-note', 'Connect an agent or the orchestrator to this input. Responses from every connected node are included in the final output.'));
      }

      if (node.type === 'agent') {
        const remove = h('button.btn.ghost.af-remove-agent', { type: 'button' }, 'REMOVE AGENT');
        remove.addEventListener('click', deleteSelectedItems);
        content.append(remove);
      }
      inspector.append(title, content);
      updateControls();
    }

    function renderMultiInspector() {
      const selectedNodes = [...selectedNodeIds].map(nodeById).filter(Boolean);
      const configurable = selectedNodes.filter((node) => node.type === 'agent' || node.type === 'orchestrator');
      const selectedAgentCount = selectedNodes.filter((node) => node.type === 'agent').length;
      const title = h('div.af-inspector-head',
        h('span.af-inspector-kicker', 'MULTI-SELECTION'),
        h('h3', [
          selectedNodes.length ? `${selectedNodes.length} node${selectedNodes.length === 1 ? '' : 's'}` : '',
          selectedEdges.length ? `${selectedEdges.length} connection${selectedEdges.length === 1 ? '' : 's'}` : ''
        ].filter(Boolean).join(' · ') + ' selected'),
        h('span.af-inspector-help', 'Only shared agent settings are shown; prompts and roles stay unchanged.')
      );
      const content = h('div.af-inspector-content');
      if (configurable.length > 1) {
        const sameValue = (key) => configurable.every((node) => node[key] === configurable[0][key])
          ? configurable[0][key]
          : '';
        const addSharedSelect = (labelText, className, options, value, onChange) => {
          const select = h(`select.inp.${className}`,
            h('option', { value: '', disabled: true }, 'Mixed values'),
            ...options.map(([optionValue, optionLabel]) => h('option', { value: optionValue }, optionLabel))
          );
          select.value = value;
          select.addEventListener('change', () => onChange(select.value));
          content.append(h('label.af-field', h('span', labelText), select));
        };
        const apply = (update) => {
          for (const node of configurable) update(node);
          renderGraph();
          scheduleSave();
        };
        addSharedSelect('PROVIDER', 'af-provider', PROVIDERS,
          sameValue('provider'), (provider) => apply((node) => {
            node.provider = provider;
            if (!REASONING_EFFORTS[provider].includes(node.reasoningEffort)) node.reasoningEffort = '';
            if (provider !== 'codex') node.webSearchMode = 'disabled';
            if (provider !== 'copilot') node.permissionMode = 'manual';
            if (node.accountId && !accountsFor(provider).some((profile) => profile.id === node.accountId)) node.accountId = '';
          }));
        const sameProvider = configurable.every((node) => node.provider === configurable[0].provider);
        if (sameProvider) {
          const providerAccounts = accountsFor(configurable[0].provider);
          const effectiveAccounts = configurable.map(effectiveAccountId);
          const sharedAccount = effectiveAccounts.every((id) => id === effectiveAccounts[0]) ? effectiveAccounts[0] : '';
          addSharedSelect('SUBSCRIPTION ACCOUNT', 'af-account', providerAccounts.map((profile) => [profile.id, profile.name]),
            sharedAccount, (accountId) => apply((node) => { node.accountId = accountId; }));
        }
        addSharedSelect('AGENT MODE', 'af-agent-mode', AGENT_MODES,
          sameValue('agentMode'), (mode) => apply((node) => { node.agentMode = mode; }));
        const allCopilot = configurable.every((node) => node.provider === 'copilot');
        const permissionOptions = [
          ['manual', allCopilot ? 'Manual · ask before actions' : 'Manual · provider default'],
          ...(allCopilot ? [
            ['assisted', 'Assisted · Copilot reads only'],
            ['project-scoped', 'Project-scoped · Copilot file reads/writes']
          ] : [])
        ];
        addSharedSelect('PERMISSIONS', 'af-permission-mode', permissionOptions,
          sameValue('permissionMode'), (permissionMode) => apply((node) => { node.permissionMode = permissionMode; }));
        if (configurable.length !== selectedNodes.length) {
          content.append(h('span.af-provider-hint', `Shared settings apply to the ${configurable.length} selected agent/orchestrator nodes only.`));
        }
      } else {
        content.append(h('div.af-inspector-empty', 'Select at least two agent or orchestrator nodes to edit shared settings.'));
      }
      if (selectedAgentCount || selectedEdges.length) {
        const remove = h('button.btn.ghost.af-remove-agent', { type: 'button' }, 'DELETE SELECTED ITEMS');
        remove.addEventListener('click', deleteSelectedItems);
        content.append(remove);
      }
      inspector.append(title, content);
      updateControls();
    }

    function screenToWorld(clientX, clientY) {
      const rect = world.getBoundingClientRect();
      return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
    }

    function drawEdges() {
      wires.replaceChildren();
      const worldRect = world.getBoundingClientRect();
      const pointFor = (element) => {
        const rect = element.getBoundingClientRect();
        return { x: (rect.left + rect.width / 2 - worldRect.left) / zoom, y: (rect.top + rect.height / 2 - worldRect.top) / zoom };
      };
      const appendPath = (start, end, draft = false, edge = null) => {
        const curve = Math.max(48, Math.abs(end.x - start.x) * 0.45);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M ${start.x} ${start.y} C ${start.x + curve} ${start.y}, ${end.x - curve} ${end.y}, ${end.x} ${end.y}`);
        const selected = edge && selectedEdges.some((item) => item.source === edge.source && item.target === edge.target);
        path.setAttribute('class', `af-wire${draft ? ' af-wire-draft' : ''}${selected ? ' selected' : ''}`);
        path.setAttribute('fill', 'none');
        wires.appendChild(path);
        if (edge) {
          const hitTarget = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          hitTarget.setAttribute('d', path.getAttribute('d'));
          hitTarget.setAttribute('class', 'af-wire-hit');
          hitTarget.setAttribute('fill', 'none');
          hitTarget.setAttribute('role', 'button');
          hitTarget.setAttribute('aria-label', `Connection from ${nodeById(edge.source)?.label || edge.source} to ${nodeById(edge.target)?.label || edge.target}`);
          hitTarget.setAttribute('tabindex', '0');
          hitTarget.setAttribute('data-source', edge.source);
          hitTarget.setAttribute('data-target', edge.target);
          hitTarget.addEventListener('click', (event) => {
            event.stopPropagation();
            selectEdge(edge, event.shiftKey || event.ctrlKey || event.metaKey);
            drawEdges();
          });
          hitTarget.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            selectEdge(edge);
            drawEdges();
          });
          wires.appendChild(hitTarget);
        }
      };
      for (const edge of workflow.edges) {
        const source = nodeElements.get(edge.source);
        const target = nodeElements.get(edge.target);
        const out = source && source.querySelector('.af-port.out');
        const input = target && target.querySelector('.af-port.in');
        if (!out || !input) continue;
        appendPath(pointFor(out), pointFor(input), false, edge);
      }
      if (connectionDrag) {
        const source = nodeElements.get(connectionDrag.sourceId)?.querySelector('.af-port.out');
        if (source) appendPath(pointFor(source), connectionDrag.point, true);
      }
    }

    function centerGraph(fit = false) {
      if (!workflow.nodes.length) return;
      const minX = Math.min(...workflow.nodes.map((node) => node.x));
      const minY = Math.min(...workflow.nodes.map((node) => node.y));
      const maxX = Math.max(...workflow.nodes.map((node) => node.x + 260));
      const maxY = Math.max(...workflow.nodes.map((node) => node.y + 190));
      if (fit && viewport.clientWidth && viewport.clientHeight) {
        const fitX = (viewport.clientWidth - 64) / (maxX - minX);
        const fitY = (viewport.clientHeight - 64) / (maxY - minY);
        zoom = Math.max(MIN_ZOOM, Math.min(1, fitX, fitY));
      }
      panX = viewport.clientWidth / 2 - ((minX + maxX) / 2) * zoom;
      panY = viewport.clientHeight / 2 - ((minY + maxY) / 2) * zoom;
    }

    function applyZoom() {
      stage.style.width = '100%';
      stage.style.height = '100%';
      world.style.width = '0';
      world.style.height = '0';
      world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
      viewport.style.backgroundSize = `${22 * zoom}px ${22 * zoom}px`;
      viewport.style.backgroundPosition = `${panX}px ${panY}px`;
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      requestAnimationFrame(drawEdges);
    }

    function setZoom(value, anchorX, anchorY) {
      const next = Math.max(MIN_ZOOM, Math.min(1.75, value));
      if (next === zoom) return;
      const rect = viewport.getBoundingClientRect();
      const localX = anchorX === undefined ? viewport.clientWidth / 2 : anchorX - rect.left;
      const localY = anchorY === undefined ? viewport.clientHeight / 2 : anchorY - rect.top;
      const worldX = (localX - panX) / zoom;
      const worldY = (localY - panY) / zoom;
      zoom = next;
      panX = localX - worldX * zoom;
      panY = localY - worldY * zoom;
      applyZoom();
    }

    const handleCanvasPointerMove = (event) => {
      if (connectionDrag?.pointerId === event.pointerId) {
        connectionDrag.point = screenToWorld(event.clientX, event.clientY);
        drawEdges();
      }
      if (panDrag?.pointerId === event.pointerId) {
        panX = panDrag.panX + (event.clientX - panDrag.startX);
        panY = panDrag.panY + (event.clientY - panDrag.startY);
        applyZoom();
      }
      if (selectionDrag?.pointerId === event.pointerId) {
        const dx = event.clientX - selectionDrag.startX;
        const dy = event.clientY - selectionDrag.startY;
        selectionDrag.moved ||= Math.abs(dx) > 3 || Math.abs(dy) > 3;
        if (selectionDrag.moved) {
          const viewportRect = viewport.getBoundingClientRect();
          const left = Math.min(selectionDrag.startX, event.clientX) - viewportRect.left - viewport.clientLeft;
          const top = Math.min(selectionDrag.startY, event.clientY) - viewportRect.top - viewport.clientTop;
          selectionBox.style.left = `${left}px`;
          selectionBox.style.top = `${top}px`;
          selectionBox.style.width = `${Math.abs(dx)}px`;
          selectionBox.style.height = `${Math.abs(dy)}px`;
          selectionBox.classList.add('visible');
        }
      }
    };

    function finishSelection(event, canceled = false) {
      const drag = selectionDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      selectionDrag = null;
      selectionBox.classList.remove('visible');
      viewport.classList.remove('selecting');
      if (canceled) return;
      if (!drag.moved) {
        if (!drag.additive) setNodeSelection(new Set());
        return;
      }
      const left = Math.min(drag.startX, event.clientX);
      const right = Math.max(drag.startX, event.clientX);
      const top = Math.min(drag.startY, event.clientY);
      const bottom = Math.max(drag.startY, event.clientY);
      const next = drag.additive ? new Set(drag.initialIds) : new Set();
      const nextEdges = drag.additive ? [...drag.initialEdges] : [];
      const hitIds = [];
      for (const [id, element] of nodeElements) {
        const rect = element.getBoundingClientRect();
        if (rect.left <= right && rect.right >= left && rect.top <= bottom && rect.bottom >= top) {
          next.add(id);
          hitIds.push(id);
        }
      }
      for (const hitTarget of wires.querySelectorAll('.af-wire-hit')) {
        const rect = hitTarget.getBoundingClientRect();
        if (rect.left <= right && rect.right >= left && rect.top <= bottom && rect.bottom >= top) {
          const edge = { source: hitTarget.getAttribute('data-source'), target: hitTarget.getAttribute('data-target') };
          if (!nextEdges.some((item) => item.source === edge.source && item.target === edge.target)) nextEdges.push(edge);
        }
      }
      setFlowSelection(next, nextEdges, hitIds.at(-1) || selectedNodeId);
    }

    const finishCanvasPointer = (event, canceled = false) => {
      if (connectionDrag?.pointerId === event.pointerId) {
        const sourceId = connectionDrag.sourceId;
        const target = !canceled && document.elementFromPoint(event.clientX, event.clientY)?.closest('.af-port.in');
        connectionDrag = null;
        if (target?.dataset.nodeId) {
          connect(sourceId, target.dataset.nodeId);
          drawEdges();
        } else {
          connectionHint.textContent = CANVAS_HINT;
          drawEdges();
        }
      }
      if (panDrag?.pointerId === event.pointerId) {
        panDrag = null;
        viewport.classList.remove('panning');
      }
      finishSelection(event, canceled);
    };

    viewport.addEventListener('pointerdown', (event) => {
      const panDragButton = event.button === 1 || event.button === 2;
      const backgroundSelect = event.button === 0 && !event.target.closest('.af-node, .af-wire, .af-wire-hit, button, input, textarea, select');
      if (!panDragButton && !backgroundSelect) return;
      event.preventDefault();
      if (panDragButton) {
        panDrag = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          panX,
          panY
        };
        viewport.classList.add('panning');
      } else {
        selectionDrag = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          additive: event.shiftKey,
          initialIds: new Set(selectedNodeIds),
          initialEdges: selectedEdges.map((edge) => ({ source: edge.source, target: edge.target })),
          moved: false
        };
        viewport.classList.add('selecting');
        viewport.focus({ preventScroll: true });
      }
    });
    viewport.addEventListener('contextmenu', (event) => event.preventDefault());
    const handleCanvasPointerUp = (event) => finishCanvasPointer(event);
    const handleCanvasPointerCancel = (event) => finishCanvasPointer(event, true);
    window.addEventListener('pointermove', handleCanvasPointerMove);
    window.addEventListener('pointerup', handleCanvasPointerUp);
    window.addEventListener('pointercancel', handleCanvasPointerCancel);

    function renderGraph() {
      nodeElements.clear();
      nodeStatusElements.clear();
      world.replaceChildren(wires, ...workflow.nodes.map(renderNode));
      renderInspector();
      applyZoom();
      requestAnimationFrame(drawEdges);
      updateControls();
    }

    function addAgent() {
      const count = workflow.nodes.filter((node) => node.type === 'agent').length;
      const id = `agent-${Date.now()}-${count}`;
      const node = {
        id, type: 'agent', role: 'worker', provider: 'copilot', model: 'auto', reasoningEffort: '', label: `Specialist ${count + 1}`,
        agentRoleMode: 'simple', simpleRole: 'backend', agentMode: 'autopilot', permissionMode: 'manual',
        x: (viewport.clientWidth / 2 - panX) / zoom - 130,
        y: (viewport.clientHeight / 2 - panY) / zoom - 95,
        instructions: 'Analyze the task from your assigned specialty. Return findings and recommendations.'
      };
      workflow.nodes.push(node);
      selectedNodeId = id;
      const input = workflow.nodes.find((item) => item.type === 'input');
      const orchestrator = workflow.nodes.find((item) => item.type === 'orchestrator');
      const compiler = workflow.nodes.find((item) => item.type === 'compiler');
      if (input) workflow.edges.push({ source: input.id, target: node.id });
      if (orchestrator) workflow.edges.push({ source: node.id, target: orchestrator.id });
      if (compiler) workflow.edges.push({ source: node.id, target: compiler.id });
      renderGraph();
      scheduleSave();
    }

    function validateWorkflow() {
      const inputs = workflow.nodes.filter((node) => node.type === 'input');
      const outputs = workflow.nodes.filter((node) => node.type === 'output');
      const orchestrators = workflow.nodes.filter((node) => node.type === 'orchestrator');
      const compilers = workflow.nodes.filter((node) => node.type === 'compiler');
      const agents = workflow.nodes.filter((node) => node.type === 'agent');
      const workers = agents.filter((node) => node.role === 'worker');
      const reviewers = agents.filter((node) => node.role === 'reviewer');
      if (inputs.length !== 1 || outputs.length !== 1 || orchestrators.length !== 1 || compilers.length !== 1) {
        throw new Error('Agent Flow needs one task, one manager, one compiler, and one result node.');
      }
      const input = inputs[0];
      const output = outputs[0];
      const orchestrator = orchestrators[0];
      const compiler = compilers[0];
      orchestrator.revisionRounds = Number.isInteger(orchestrator.revisionRounds)
        ? Math.max(0, Math.min(MAX_REVISION_ROUNDS, orchestrator.revisionRounds))
        : 3;
      for (const edge of workflow.edges) {
        if (!nodeById(edge.source) || !nodeById(edge.target)) throw new Error('A connection refers to a missing node.');
        if (!edgeAllowed(nodeById(edge.source), nodeById(edge.target))) throw new Error('A connection is not valid for its node types.');
      }
      const indegree = new Map(workflow.nodes.map((node) => [node.id, 0]));
      for (const edge of workflow.edges) indegree.set(edge.target, indegree.get(edge.target) + 1);
      const queue = workflow.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
      const order = [];
      while (queue.length) {
        const id = queue.shift();
        order.push(id);
        for (const edge of workflow.edges) {
          if (edge.source !== id) continue;
          indegree.set(edge.target, indegree.get(edge.target) - 1);
          if (indegree.get(edge.target) === 0) queue.push(edge.target);
        }
      }
      if (order.length !== workflow.nodes.length) throw new Error('The workflow contains a cycle.');
      if (!input.prompt || !input.prompt.trim()) throw new Error('Enter a task in the Task node before running the workflow.');
      if (!pathExists(orchestrator.id, output.id)) throw new Error('Connect the orchestrator to the output node.');
      if (!pathExists(compiler.id, orchestrator.id)) throw new Error('Connect the compiler to the orchestrator.');
      return { input, output, orchestrator, compiler, workers, reviewers, agents, order };
    }

    function reachableInputText(node, outputs) {
      return workflow.edges
        .filter((edge) => edge.target === node.id)
        .map((edge) => ({ node: nodeById(edge.source), text: outputs.get(edge.source) }))
        .filter((item) => item.node && item.text)
        .map((item) => `### ${item.node.label}\n${item.text.slice(0, 1200)}${item.text.length > 1200 ? '\n[upstream response excerpt]' : ''}`)
        .join('\n\n');
    }

    function modeInstruction(node) {
      if (node.agentMode === 'autopilot') {
        return 'Complete the assignment with focused edits inside the active project when needed. This mode overrides default role text that says not to edit. Do not access files outside the project. Shell commands and other protected actions remain subject to the selected permission policy.';
      }
      if (node.agentMode === 'interactive') {
        return 'Analyze the assignment and report your findings. Do not modify files unless the user explicitly approves the requested tool action.';
      }
      return 'Planning only: inspect and reason about the project, but do not modify files, execute commands, or access external services. This mode overrides role text requesting edits.';
    }

    function appendResult(title, text, final = false, markdown = false) {
      const details = h(`details.af-result${final ? '.final' : ''}`, { open: true });
      const summary = h('summary', title);
      const body = markdown
        ? h('div.af-result-rich', { html: renderMarkdown(text || 'Waiting for response…') })
        : h('pre', text || 'Waiting for response…');
      details.append(summary, body);
      results.appendChild(details);
      details.scrollIntoView({ block: 'nearest' });
      return body;
    }

    function relativeProjectPath(filePath) {
      if (!project.root || typeof filePath !== 'string') return null;
      const root = project.root.replace(/[\\/]+$/, '');
      const prefix = `${root}${sep()}`;
      const insensitive = window.phantom.platform === 'win32';
      const candidate = insensitive ? filePath.toLowerCase() : filePath;
      const boundary = insensitive ? prefix.toLowerCase() : prefix;
      if (!candidate.startsWith(boundary)) return null;
      const relative = filePath.slice(prefix.length);
      return !relative || /^\.git(?:[\\/]|$)/i.test(relative) ? null : relative;
    }

    function renderFlowFileChanges(active) {
      const files = [...active.fileChanges]
        .map((path) => ({ path, relative: relativeProjectPath(path) }))
        .filter((file) => file.relative)
        .sort((a, b) => a.relative.localeCompare(b.relative));
      if (!files.length) return;
      active.changeView.replaceChildren(
        h('div.af-result-change-head', h('span', 'FILES CHANGED'), h('span', String(files.length))),
        ...files.map(({ path, relative }) => h('div.af-result-change-row',
          h('button.af-result-file', {
            type: 'button',
            title: `Open ${relative}`,
            on: { click: () => bus.emit('open-file', path, {}) }
          }, relative),
          project.gitRoot ? h('button.af-result-diff', {
            type: 'button',
            title: `Review diff for ${relative}`,
            on: { click: () => wm.open('diff', { state: { root: project.gitRoot, file: path } })
              .catch((error) => fail(error, 'OPEN AGENT DIFF')) }
          }, 'DIFF') : null
        ))
      );
      active.changeView.hidden = false;
    }

    function recordFlowActivity(active, value) {
      const command = String(value || '').trim();
      if (!command || active.toolActivitySet.has(command)) return;
      active.toolActivitySet.add(command);
      active.toolActivitySummary.textContent = `TOOL ACTIVITY · ${active.toolActivitySet.size}`;
      active.toolActivityList.appendChild(h('div.af-tool-row',
        h('span.af-tool-dot'),
        h('code', command)
      ));
      active.toolActivity.hidden = false;
    }

    async function runAgent(node, prompt, token, stage = '', cwd = project.root) {
      assertRunCurrent(token);
      setNodeStatus(node.id, 'STARTING', 'running');
      if (runCheckpoint) {
        runCheckpoint.activeNodeId = node.id;
        runCheckpoint.progress = `${stage || 'RUN'} · ${node.label}`;
        runStatus.textContent = `RUNNING · ${runCheckpoint.progress}`;
        await saveRunCheckpoint();
        assertRunCurrent(token);
      }
      const outputView = appendResult(`${stage ? `${stage} · ` : ''}${node.label} · ${node.provider.toUpperCase()}`, '', false, true);
      const resultDetails = outputView.closest('details.af-result');
      const toolActivitySummary = h('summary', 'TOOL ACTIVITY');
      const toolActivityList = h('div.af-tool-list');
      const toolActivity = h('details.af-tool-activity', { hidden: true }, toolActivitySummary, toolActivityList);
      const changeView = h('div.af-result-changes', { hidden: true });
      resultDetails.append(toolActivity, changeView);
      const created = await call('agent:create', node.provider, cwd, {
        accountId: node.accountId || '',
        model: node.model || '',
        reasoningEffort: node.agentRoleMode === 'advanced' ? node.reasoningEffort || '' : '',
        webSearchMode: node.webSearchMode || 'disabled',
        agentMode: node.agentMode || 'plan',
        permissionMode: node.permissionMode || 'manual',
        enableMcp: node.provider === 'copilot' && node.enableMcp === true
      });
      if (cancelled || token !== runToken) {
        await call('agent:close', created.id).catch((error) => fail(error, 'CLOSE WORKFLOW AGENT'));
        throw new Error('Workflow was cancelled.');
      }
      const active = {
        node, text: '', outputView, truncated: false, token,
        toolActivity, toolActivitySummary, toolActivityList, toolActivitySet: new Set(),
        changeView, fileChanges: new Set()
      };
      activeConversations.set(created.id, active);
      let result;
      try {
        setNodeStatus(node.id, 'RUNNING', 'running');
        await call('agent:send', created.id, prompt);
        assertRunCurrent(token);
        const outputText = active.text.trim() + (active.truncated ? '\n[response truncated in the workflow log]' : '');
        if (!outputText) throw new Error(`${node.label} returned an empty response.`);
        setNodeStatus(node.id, 'DONE', 'done');
        outputView.innerHTML = renderMarkdown(outputText);
        result = { text: outputText, outputView };
      } finally {
        activeConversations.delete(created.id);
        await call('agent:close', created.id).catch((error) => fail(error, 'CLOSE WORKFLOW AGENT'));
      }
      assertRunCurrent(token);
      return result;
    }

    function formatClarifications(clarifications) {
      return clarifications.map(({ question, answer }, index) =>
        `${index + 1}. Question: ${question}\n   User answer: ${answer}`
      ).join('\n');
    }

    async function runCoordinator(plan, prompt, token, allowedActions, stage, clarifications) {
      let nextPrompt = prompt;
      let formatRetries = 0;
      while (true) {
        assertRunCurrent(token);
        const result = await runAgent(plan.orchestrator, nextPrompt, token, stage);
        assertRunCurrent(token);
        let parsed;
        try {
          parsed = parseFlowAction(result.text);
        } catch (error) {
          if (formatRetries >= 1) throw error;
          formatRetries++;
          nextPrompt = [
            'Your previous response could not be parsed as a workflow action. Convert it into exactly one valid action block; do not add prose or markdown outside the block.',
            `Allowed actions for this step: ${['ask_user', ...allowedActions].join(', ')}.`,
            `The required format is <${FLOW_ACTION_TAG}>{"action":"...","summary":"..."}</${FLOW_ACTION_TAG}>.`,
            `Previous response:\n${result.text.slice(0, 8000)}`
          ].join('\n\n');
          stage = `${stage} · FORMAT RETRY`;
          continue;
        }
        const action = parsed.action;
        result.outputView.innerHTML = renderMarkdown(parsed.visibleText || action.summary || action.finalResponse || `Orchestrator action: ${action.action}`);
        if (action.action === 'ask_user') {
          if (typeof action.question !== 'string' || !action.question.trim()) {
            throw new Error('The orchestrator requested clarification without a question.');
          }
          const answer = await form('ORCHESTRATOR NEEDS CLARIFICATION', [
            { key: 'answer', label: action.question.trim(), type: 'textarea', rows: 5, placeholder: 'Type your clarification…' }
          ], { ok: 'SEND ANSWER', width: 560 });
          assertRunCurrent(token);
          if (!answer || !answer.answer.trim()) throw new Error('Workflow cancelled while awaiting a clarification.');
          const userAnswer = answer.answer.trim();
          clarifications.push({ question: action.question.trim(), answer: userAnswer });
          if (runCheckpoint) {
            runCheckpoint.clarifications = clarifications;
            runCheckpoint.progress = 'Clarification received';
            await saveRunCheckpoint();
          }
          nextPrompt = `${nextPrompt}\n\nUser clarification:\n${userAnswer}\n\nContinue the current orchestration step and return one valid action block.`;
          continue;
        }
        if (!allowedActions.includes(action.action)) {
          throw new Error(`The orchestrator returned "${action.action}" when only ${allowedActions.join(' or ')} was allowed.`);
        }
        return action;
      }
    }

    function validateAssignments(action, workers) {
      if (!Array.isArray(action.assignments) || !action.assignments.length) {
        throw new Error('The orchestrator did not assign any work to a worker.');
      }
      const knownWorkers = new Map(workers.map((worker) => [worker.id, worker]));
      const assignments = new Map();
      for (const assignment of action.assignments) {
        if (!assignment || typeof assignment.workerId !== 'string' || typeof assignment.task !== 'string') {
          throw new Error('The orchestrator returned an invalid worker assignment.');
        }
        if (!knownWorkers.has(assignment.workerId)) {
          throw new Error(`The orchestrator assigned work to an unknown worker ("${assignment.workerId}").`);
        }
        const task = assignment.task.trim();
        if (!task || task.length > MAX_TASK_LENGTH) {
          throw new Error(`The assignment for "${knownWorkers.get(assignment.workerId).label}" is empty or too long.`);
        }
        if (assignments.has(assignment.workerId)) {
          throw new Error(`The orchestrator assigned "${knownWorkers.get(assignment.workerId).label}" more than once in the same round.`);
        }
        assignments.set(assignment.workerId, task);
      }
      return assignments;
    }

    async function runAssignments(assignments, plan, values, token, stage, context, clarifications) {
      const byId = new Map(plan.workers.map((worker) => [worker.id, worker]));
      const unknownWorkers = [...assignments.keys()].filter((id) => !byId.has(id));
      if (unknownWorkers.length) throw new Error(`Saved assignments refer to unknown workers: ${unknownWorkers.join(', ')}.`);
      const pending = [...assignments.entries()]
        .map(([id, task]) => ({ worker: byId.get(id), task }))
        .filter((item) => item.worker && !(runCheckpoint.completedWorkers.includes(item.worker.id) && values.has(item.worker.id)));
      for (const worker of plan.workers) {
        if (!assignments.has(worker.id)) setNodeStatus(worker.id, 'NOT ASSIGNED');
        else if (runCheckpoint.completedWorkers.includes(worker.id) && values.has(worker.id)) setNodeStatus(worker.id, 'DONE', 'done');
      }
      if (!pending.length) return;
      const capacity = await call('agent:capacity');
      const recommended = capacity.recommendedConcurrentAgents || capacity.maxConcurrentAgents;
      const availableSlots = recommended - capacity.activeAgents;
      if (availableSlots < 1) {
        throw new Error('No worker capacity is available. Close an active agent chat and resume the run.');
      }
      const batchSize = Math.max(1, Math.min(recommended, availableSlots));
      runCheckpoint.integrationReports = Array.isArray(runCheckpoint.integrationReports) ? runCheckpoint.integrationReports : [];
      runCheckpoint.unresolvedConflicts = Array.isArray(runCheckpoint.unresolvedConflicts) ? runCheckpoint.unresolvedConflicts : [];
      runCheckpoint.workspaceIds = Array.isArray(runCheckpoint.workspaceIds) ? runCheckpoint.workspaceIds : [];
      runCheckpoint.workspaceByWorker = runCheckpoint.workspaceByWorker && typeof runCheckpoint.workspaceByWorker === 'object' ? runCheckpoint.workspaceByWorker : {};
      runCheckpoint.unresolvedConflictOwners = runCheckpoint.unresolvedConflictOwners && typeof runCheckpoint.unresolvedConflictOwners === 'object' ? runCheckpoint.unresolvedConflictOwners : {};

      for (let offset = 0; offset < pending.length; offset += batchSize) {
        assertRunCurrent(token);
        const batch = pending.slice(offset, offset + batchSize);
        const freshBatch = batch.filter(({ worker }) => !runCheckpoint.workspaceByWorker[worker.id]);
        const newWorkspaces = new Map();
        if (freshBatch.length) {
          const baseWorkspace = await call('flow:workspace:create', project.root);
          newWorkspaces.set(freshBatch[0].worker.id, baseWorkspace);
          runCheckpoint.workspaceIds.push(baseWorkspace.id);
          runCheckpoint.workspaceByWorker[freshBatch[0].worker.id] = baseWorkspace;
          await saveRunCheckpoint();
          assertRunCurrent(token);
          for (const { worker } of freshBatch.slice(1)) {
            assertRunCurrent(token);
            const workspace = await call('flow:workspace:clone', baseWorkspace.id);
            newWorkspaces.set(worker.id, workspace);
            runCheckpoint.workspaceIds.push(workspace.id);
            runCheckpoint.workspaceByWorker[worker.id] = workspace;
            await saveRunCheckpoint();
          }
        }
        const workspaces = batch.map(({ worker }) => {
          const previousConflicts = Object.entries(runCheckpoint.unresolvedConflictOwners)
            .filter(([, owners]) => Array.isArray(owners) && owners.includes(worker.id))
            .map(([file]) => file);
          return {
            worker,
            ...(newWorkspaces.get(worker.id) || runCheckpoint.workspaceByWorker[worker.id]),
            previousConflicts
          };
        });
        if (workspaces.some((workspace) => !workspace.id || !workspace.root)) {
          throw new Error('A saved Agent Flow worker workspace is invalid. Resume the assignment to create a fresh snapshot.');
        }
        runCheckpoint.progress = `${stage} · starting ${batch.length} parallel worker${batch.length === 1 ? '' : 's'}`;
        await saveRunCheckpoint();
        const results = await Promise.allSettled(batch.map(async ({ worker, task }, index) => {
            assertRunCurrent(token);
            setNodeStatus(worker.id, 'STARTING', 'running');
            const upstream = reachableInputText(worker, values);
            const workspace = workspaces[index];
            let conflictContext = '';
            if (workspace.previousConflicts.length) {
              const rebased = await call('flow:workspace:rebase', project.root, workspace.id, workspace.previousConflicts);
              const copies = rebased.paths.map((entry) =>
                `${entry.path}: original=${join(workspace.root, entry.path)}, prior worker version=${join(workspace.root, entry.workerVersion)}, current project version=${join(workspace.root, entry.projectVersion)} (${entry.projectType})`
              );
              conflictContext = [
                'Resolve the existing integration conflicts by merging the saved worker proposal with the current project version.',
                `Rebased conflict directory: ${join(workspace.root, rebased.conflictDirectory)}`,
                'The original workspace paths now contain the current project versions. The prior worker and current project copies are preserved under the conflict directory; edit the original paths after reconciling them.',
                ...copies
              ].join('\n');
            }
            const prompt = [
              `You are "${worker.label}", a coworker in the PHANTOM manager-led project "${workflow.name}".`,
              `Your scoped assignment:\n${task}`,
              `Roadmap goals owned by this assignment:\n${(worker.goalIds || []).join(', ') || 'Support the manager roadmap.'}`,
              `Worker instructions:\n${roleInstructions(worker) || 'Complete the assigned task and report what changed.'}`,
              `Agent mode:\n${modeInstruction(worker)}`,
              `Original user task:\n${plan.input.prompt.trim()}`,
              clarifications.length ? `User clarifications:\n${formatClarifications(clarifications)}` : '',
              conflictContext ? `Existing integration conflicts to resolve:\n${conflictContext}` : '',
              context ? `Review, integration, and compiler feedback to address:\n${context}` : '',
              upstream ? `Connected upstream results:\n${upstream}` : '',
              runCheckpoint.resumeMode ? 'This is a resumed assignment. Inspect the current project snapshot first and continue idempotently.' : '',
              'Work only in this isolated workspace and within your assigned scope. Report concrete changes, checks performed, and remaining blockers.'
            ].filter(Boolean).join('\n\n');
            const result = await runAgent(worker, prompt, token, stage, workspaces[index].root);
            assertRunCurrent(token);
            return { worker, result };
        }));
        let firstFailure = null;
        for (let index = 0; index < results.length; index++) {
          assertRunCurrent(token);
          const settled = results[index];
          const workspace = workspaces[index];
          if (settled.status === 'rejected') {
            firstFailure ||= settled.reason;
            setNodeStatus(batch[index].worker.id, 'FAILED', 'error');
            continue;
          }
          const { worker, result } = settled.value;
          const workerWorkspace = workspaces[index];
          values.set(worker.id, result.text);
          runCheckpoint.values = [...values.entries()];
          setNodeStatus(worker.id, 'INTEGRATING', 'running');
          const integrated = await call('flow:workspace:integrate', project.root, workspace.id, workerWorkspace.previousConflicts);
          const conflicts = Array.isArray(integrated.conflicts) ? integrated.conflicts : [];
          const report = {
            workerId: worker.id,
            applied: integrated.applied || [],
            conflicts,
            resolved: Array.isArray(integrated.resolved) ? integrated.resolved : [],
            error: integrated.error || ''
          };
          runCheckpoint.integrationReports.push(report);
          for (const file of [...report.applied, ...report.resolved]) {
            delete runCheckpoint.unresolvedConflictOwners[file];
          }
          for (const file of conflicts) {
            const owners = runCheckpoint.unresolvedConflictOwners[file] || [];
            if (!owners.includes(worker.id)) owners.push(worker.id);
            runCheckpoint.unresolvedConflictOwners[file] = owners;
          }
          runCheckpoint.unresolvedConflicts = Object.keys(runCheckpoint.unresolvedConflictOwners);
          if (!conflicts.length) {
            runCheckpoint.completedWorkers = [...new Set([...runCheckpoint.completedWorkers, worker.id])];
          } else {
            runCheckpoint.completedWorkers = runCheckpoint.completedWorkers.filter((id) => id !== worker.id);
          }
          const summary = conflicts.length
            ? `Integrated ${report.applied.length} non-conflicting file${report.applied.length === 1 ? '' : 's'}; ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} remain: ${conflicts.join(', ')}`
            : `Integrated ${report.applied.length} changed file${report.applied.length === 1 ? '' : 's'}.`;
          const fileDetails = report.applied.length ? `\nApplied:\n${report.applied.join('\n')}` : '';
          appendResult(`${worker.label} · ${conflicts.length ? 'INTEGRATION CONFLICT' : 'INTEGRATED'}`, `${summary}${fileDetails}${report.error ? `\n${report.error}` : ''}`);
          setNodeStatus(worker.id, conflicts.length ? 'INTEGRATION CONFLICT' : 'INTEGRATED', conflicts.length ? 'error' : 'done');
          runCheckpoint.activeNodeId = '';
          runCheckpoint.progress = `${stage} · ${worker.label} ${conflicts.length ? 'has conflicts' : 'integrated'}`;
          await saveRunCheckpoint();
          if (!conflicts.length) {
            await call('flow:workspace:dispose', workspace.id);
            runCheckpoint.workspaceIds = runCheckpoint.workspaceIds.filter((id) => id !== workspace.id);
            delete runCheckpoint.workspaceByWorker[worker.id];
            await saveRunCheckpoint();
          }
        }
        if (firstFailure) throw firstFailure;
      }
    }

    async function runCompiler(node, token) {
      assertRunCurrent(token);
      setNodeStatus(node.id, 'DETECTING', 'running');
      runCheckpoint.activeNodeId = node.id;
      runCheckpoint.progress = 'Detecting build and test commands';
      runStatus.textContent = `RUNNING · ${runCheckpoint.progress}`;
      await saveRunCheckpoint();
      assertRunCurrent(token);
      const tasks = await call('tasks:detect', project.root);
      assertRunCurrent(token);
      if (!Array.isArray(tasks)) throw new Error('The task detector returned an invalid result.');
      detectedTasks = tasks;
      if (nodeById(selectedNodeId)?.type === 'compiler') renderInspector();
      const requested = [
        ['build', node.buildCommand || 'auto'],
        ['test', node.testCommand || 'auto']
      ];
      const selected = [];
      const skipped = [];
      for (const [kind, command] of requested) {
        if (command === 'none') {
          skipped.push(`${kind.toUpperCase()} NOT RUN: disabled in compiler settings.`);
          continue;
        }
        const task = command === 'auto'
          ? tasks.find((candidate) => candidate.kind === kind)
          : tasks.find((candidate) => candidate.kind === kind && candidate.command === command);
        if (task && !selected.some((candidate) => candidate.command === task.command)) selected.push(task);
        else if (command === 'auto') skipped.push(`${kind.toUpperCase()} NOT FOUND: no command was detected.`);
        else if (command !== 'auto' && !task) {
          throw new Error(`Selected ${kind} command is no longer detected: ${command}`);
        }
      }
      if (!selected.length) {
        const message = skipped.join('\n') || 'No build or test commands were selected or detected for this project.';
        setNodeStatus(node.id, 'SKIPPED');
        appendResult(`${node.label} · NO COMMANDS`, message);
        return { ok: true, text: message };
      }

      const reports = [...skipped];
      let allPassed = true;
      for (const task of selected) {
        if (cancelled || token !== runToken) throw new Error('Workflow was cancelled.');
        setNodeStatus(node.id, `${task.kind.toUpperCase()} RUNNING`, 'running');
        runCheckpoint.progress = `${task.kind.toUpperCase()} · ${task.name}`;
        runStatus.textContent = `RUNNING · ${runCheckpoint.progress}`;
        await saveRunCheckpoint();
        assertRunCurrent(token);
        const outputView = appendResult(`${node.label} · ${task.kind.toUpperCase()} · ${task.command}`, '');
        let runId = null;
        let exitResolve;
        const buffered = [];
        let output = '';
        const appendOutput = (event) => {
          output = `${output}${event.data || ''}`.slice(-30000);
          outputView.textContent = output || 'Waiting for process output…';
        };
        const onOutput = (event) => {
          if (runId === null) buffered.push(['output', event]);
          else if (event.runId === runId) appendOutput(event);
        };
        const onExit = (event) => {
          if (runId === null) buffered.push(['exit', event]);
          else if (event.runId === runId) exitResolve(event);
        };
        const offOutput = on('tasks:output', onOutput);
        const offExit = on('tasks:exit', onExit);
        const exitPromise = new Promise((resolve) => { exitResolve = resolve; });
        try {
          const started = await call('tasks:run', {
            root: project.root,
            command: task.command,
            label: `Agent Flow ${task.kind}: ${task.name}`
          });
          runId = started.runId;
          activeTaskRuns.add(runId);
          if (cancelled || token !== runToken) {
            activeTaskRuns.delete(runId);
            call('tasks:kill', runId).catch((error) => fail(error, 'STOP WORKFLOW TASK'));
            throw new Error('Workflow was cancelled.');
          }
          for (const [type, event] of buffered) {
            if (event.runId !== runId) continue;
            if (type === 'output') appendOutput(event);
            else exitResolve(event);
          }
          const exit = await exitPromise;
          if (cancelled || token !== runToken) throw new Error('Workflow was cancelled.');
          activeTaskRuns.delete(runId);
          const passed = exit.code === 0;
          allPassed = allPassed && passed;
          const status = passed ? 'PASSED' : `FAILED (exit ${exit.code ?? exit.signal ?? 'unknown'})`;
          const report = `${task.kind.toUpperCase()} ${status}: ${task.command}\n${output || '(no output)'}`;
          reports.push(report);
          outputView.textContent = `${output || '(no output)'}\n\n[${status}]`;
        } finally {
          offOutput();
          offExit();
          if (runId !== null) activeTaskRuns.delete(runId);
        }
      }
      setNodeStatus(node.id, allPassed ? (skipped.length ? 'PARTIAL CHECKS' : 'CHECKS PASSED') : 'CHECKS FAILED', allPassed ? 'done' : 'error');
      return { ok: allPassed, text: reports.join('\n\n') };
    }

    function assertRunCurrent(token) {
      if (cancelled || token !== runToken) throw new Error('Workflow was cancelled.');
    }

    async function runWorkflow({ resume = false } = {}) {
      if (busy) return;
      let plan;
      try {
        plan = validateWorkflow();
      } catch (error) {
        toast(error.message, 'warn', 'WORKFLOW NOT READY');
        return;
      }
      if (resume && (!runCheckpoint || runCheckpoint.workflowSignature !== workflowSignature(workflow))) {
        toast('There is no matching Agent Flow checkpoint to resume.', 'warn', 'NO CHECKPOINT');
        return;
      }
      const token = ++runToken;
      busy = true;
      cancelled = false;
      updateControls();
      try {
        if (!resume) {
          await disposeRunWorkspaces();
          await clearRunCheckpoint();
          assertRunCurrent(token);
          runCheckpoint = {
            version: 2,
            projectRoot: project.root,
            workflowSignature: workflowSignature(workflow),
            status: 'running',
            phase: 'plan',
            progress: 'Preparing workflow plan',
            activeNodeId: '',
            startedAt: Date.now(),
            updatedAt: Date.now(),
            revisionRoundsUsed: 0,
            assignments: [],
            completedWorkers: [],
            roadmapGoals: [],
            workerRoster: [],
            goalEvidence: [],
            integrationReports: [],
            unresolvedConflicts: [],
            workspaceIds: [],
            workspaceByWorker: {},
            unresolvedConflictOwners: {},
            checksPassed: false,
            clarifications: [],
            values: [[plan.input.id, plan.input.prompt.trim()]],
            reviewHistory: [],
            currentReviewResults: [],
            currentRound: 0,
            currentRoundReview: '',
            pendingDecision: null,
            blockReasons: [],
            nodeStates: {}
          };
          runStates.clear();
          results.replaceChildren();
          for (const node of workflow.nodes) setNodeStatus(node.id, 'WAITING');
          await saveRunCheckpoint();
          assertRunCurrent(token);
        } else {
          const retainedWorkspaceIds = new Set();
          for (const [workerId, savedWorkspace] of Object.entries(runCheckpoint.workspaceByWorker || {})) {
            const available = await call('flow:workspace:get', savedWorkspace.id);
            if (available && available.root === savedWorkspace.root) retainedWorkspaceIds.add(savedWorkspace.id);
            else delete runCheckpoint.workspaceByWorker[workerId];
          }
          for (const workspaceId of runCheckpoint.workspaceIds || []) {
            if (!retainedWorkspaceIds.has(workspaceId)) await call('flow:workspace:dispose', workspaceId);
          }
          runCheckpoint.workspaceIds = [...retainedWorkspaceIds];
          runCheckpoint.status = 'running';
          runCheckpoint.resumeMode = true;
          runCheckpoint.lastError = '';
          runCheckpoint.activeNodeId = '';
          await saveRunCheckpoint();
          assertRunCurrent(token);
        }
        runStatus.textContent = `RUNNING · ${runCheckpoint.progress || runCheckpoint.phase}`;
        updateControls();

        const values = new Map(Array.isArray(runCheckpoint.values) ? runCheckpoint.values : []);
        values.set(plan.input.id, plan.input.prompt.trim());
        const clarifications = Array.isArray(runCheckpoint.clarifications) ? [...runCheckpoint.clarifications] : [];
        const reviewHistory = Array.isArray(runCheckpoint.reviewHistory) ? [...runCheckpoint.reviewHistory] : [];
        let revisionRoundsUsed = Number.isInteger(runCheckpoint.revisionRoundsUsed) ? runCheckpoint.revisionRoundsUsed : 0;
        const manager = plan.orchestrator;
        const useManagerProvider = (node, role, index) => ({
          ...node,
          id: role === 'worker' ? node.id : `${role}-${index + 1}`,
          role,
          provider: manager.provider,
          accountId: manager.accountId || accountState.active[manager.provider] || 'default',
          model: manager.model === 'auto' ? '' : manager.model || '',
          reasoningEffort: manager.reasoningEffort || '',
          webSearchMode: manager.provider === 'codex' ? manager.webSearchMode || 'disabled' : 'disabled',
          agentMode: role === 'reviewer' ? 'plan' : role === 'worker' ? 'autopilot' : manager.agentMode,
          permissionMode: manager.provider === 'copilot' ? manager.permissionMode || 'manual' : 'manual',
          enableMcp: manager.provider === 'copilot' && manager.enableMcp === true
        });
        if (resume && Array.isArray(runCheckpoint.workerRoster) && runCheckpoint.workerRoster.length) {
          plan.workers = runCheckpoint.workerRoster.map((worker) => ({ ...worker }));
        }
        plan.reviewers = (plan.reviewers.length
          ? plan.reviewers
          : [{ id: 'manager-reviewer', type: 'agent', label: 'Independent reviewer', instructions: 'Review correctness, regression risk, and acceptance criteria. Report actionable findings only; do not edit files.' }]
        ).map((reviewer, index) => useManagerProvider(reviewer, 'reviewer', index));
        const actionProtocol = [
          `Return exactly one JSON action inside <${FLOW_ACTION_TAG}>...</${FLOW_ACTION_TAG}>.`,
          `For clarification: {"action":"ask_user","question":"one concise question"}.`,
          `To create the roadmap and delegate: {"action":"delegate","summary":"plan summary","goals":[{"id":"goal-id","title":"measurable outcome","acceptanceCriteria":["observable condition"]}],"assignments":[{"workerId":"unique-id","label":"specialist name","role":"specialty","instructions":"optional role guidance","task":"scoped work","goalIds":["goal-id"]}]}.`,
          `To request changes: {"action":"revise","summary":"revision summary","assignments":[{"workerId":"worker node id","task":"specific fix"}]}.`,
          `To finish: {"action":"complete","summary":"completion summary","goalEvidence":[{"goalId":"goal-id","evidence":"specific implementation or check evidence"}],"finalResponse":"evidence-based response"}.`,
          'Choose as many coworker assignments as the task needs; there is no fixed worker roster. Assign each measurable goal to at least one worker, use distinct scoped tasks, and ask the user when requirements are ambiguous.'
        ].join('\n');
        const workerRosterSummary = () => plan.workers.map((worker) => ({
          id: worker.id, label: worker.label, role: worker.specialty || 'specialist',
          goalIds: worker.goalIds || [], provider: worker.provider
        }));
        const integrationSummary = () => {
          const reports = runCheckpoint.integrationReports || [];
          const unresolved = runCheckpoint.unresolvedConflicts || [];
          const completed = reports.map((report) =>
            `${report.workerId}: applied ${report.applied.length}; conflicts ${report.conflicts.length}`
          );
          return [
            completed.length ? `Worker integration:\n${completed.join('\n')}` : 'No integration reports yet.',
            unresolved.length ? `Unresolved project conflicts:\n${unresolved.join('\n')}` : 'No unresolved file conflicts.'
          ].join('\n\n');
        };
        const completionGate = (decision) => {
          const reasons = [];
          let evidence = [];
          try { evidence = validateGoalEvidence(decision.goalEvidence, runCheckpoint.roadmapGoals || []); }
          catch (error) { reasons.push(error.message); }
          if (runCheckpoint.checksPassed !== true) reasons.push('Required build and test checks have not passed.');
          if (runCheckpoint.unresolvedConflicts?.length) {
            reasons.push(`Unresolved integration conflicts: ${runCheckpoint.unresolvedConflicts.join(', ')}.`);
          }
          return { evidence, reasons };
        };

        if (runCheckpoint.phase === 'plan') {
          await setCheckpointPhase('plan', 'Planning workflow', token);
          const planningPrompt = [
            `You are the orchestrator for workflow "${workflow.name}".`,
            `Your role:\n${roleInstructions(plan.orchestrator) || 'Clarify the request, divide work among workers, and coordinate completion.'}`,
            `Agent mode:\n${modeInstruction(plan.orchestrator)}`,
            `User request:\n${plan.input.prompt.trim()}`,
            actionProtocol,
            'First decide whether you need clarification. Otherwise create a measurable roadmap with acceptance criteria and an assignment for each area of work. Choose the coworker count yourself; do not perform implementation work yourself.'
          ].join('\n\n');
          const planAction = await runCoordinator(plan, planningPrompt, token, ['delegate'], 'PLAN', clarifications);
          assertRunCurrent(token);
          const roadmapPlan = validateRoadmapPlan(planAction);
          const assignments = new Map(roadmapPlan.assignments.map((assignment) => [assignment.workerId, assignment.task]));
          plan.workers = roadmapPlan.assignments.map((assignment, index) => useManagerProvider({
            id: assignment.workerId,
            type: 'agent',
            role: 'worker',
            label: assignment.label || `Worker ${String(index + 1).padStart(2, '0')}`,
            agentRoleMode: 'advanced',
            simpleRole: 'backend',
            agentMode: 'autopilot',
            permissionMode: manager.permissionMode || 'manual',
            webSearchMode: 'disabled',
            enableMcp: manager.enableMcp === true,
            model: manager.model || '',
            reasoningEffort: manager.reasoningEffort || '',
            accountId: manager.accountId || '',
            instructions: assignment.instructions || `${assignment.role || 'Implementation specialist'}. Focus on goals: ${assignment.goalIds.join(', ')}.`,
            goalIds: assignment.goalIds,
            specialty: assignment.role
          }, 'worker', index));
          const planSummary = roadmapPlan.summary;
          if (planSummary) appendResult('ORCHESTRATOR · DELEGATION PLAN', planSummary, false, true);
          runCheckpoint.roadmapGoals = roadmapPlan.goals;
          runCheckpoint.workerRoster = plan.workers;
          runCheckpoint.goalEvidence = [];
          runCheckpoint.integrationReports = [];
          runCheckpoint.unresolvedConflicts = [];
          runCheckpoint.checksPassed = false;
          renderRoadmap();
          renderWorkerRoster();
          runCheckpoint.assignments = [...assignments.entries()];
          runCheckpoint.completedWorkers = [];
          runCheckpoint.planSummary = planSummary;
          runCheckpoint.clarifications = clarifications;
          runCheckpoint.values = [...values.entries()];
          await setCheckpointPhase('implement', 'Implementation assignments', token);
          assertRunCurrent(token);
        }

        if (runCheckpoint.phase === 'implement') {
          const assignments = new Map(runCheckpoint.assignments || []);
          await runAssignments(assignments, plan, values, token, 'IMPLEMENT', '', clarifications);
          assertRunCurrent(token);
          runCheckpoint.values = [...values.entries()];
          runCheckpoint.completedWorkers = [];
          await setCheckpointPhase('compiler', 'Build and test', token);
          assertRunCurrent(token);
        }

        let finalText = '';
        while (true) {
          if (runCheckpoint.phase === 'revision') {
            const assignments = new Map(runCheckpoint.assignments || []);
            await runAssignments(
              assignments, plan, values, token, `REVISION ${revisionRoundsUsed}`,
              runCheckpoint.assignmentContext || '', clarifications
            );
            assertRunCurrent(token);
            runCheckpoint.values = [...values.entries()];
            runCheckpoint.completedWorkers = [];
            runCheckpoint.pendingDecision = null;
            await setCheckpointPhase('compiler', `Build and test · round ${revisionRoundsUsed + 1}`, token);
            assertRunCurrent(token);
          }

          if (runCheckpoint.phase === 'compiler') {
            await setCheckpointPhase('compiler', `Build and test · round ${revisionRoundsUsed + 1}`, token);
            const compilerResult = await runCompiler(plan.compiler, token);
            assertRunCurrent(token);
            values.set(plan.compiler.id, compilerResult.text);
            runCheckpoint.checksPassed = compilerResult.ok === true;
            runCheckpoint.values = [...values.entries()];
            runCheckpoint.currentReviewResults = [];
            runCheckpoint.currentRound = revisionRoundsUsed + 1;
            runCheckpoint.currentRoundReview = '';
            runCheckpoint.pendingDecision = null;
            await setCheckpointPhase('review', `Review round ${runCheckpoint.currentRound}`, token);
            assertRunCurrent(token);
          }

          if (runCheckpoint.phase === 'review') {
            const compilerReport = `${values.get(plan.compiler.id) || ''}\n\n${integrationSummary()}`;
            const implementationReports = plan.workers
              .filter((worker) => values.has(worker.id))
              .map((worker) => `## ${worker.label} (${worker.provider})\n${String(values.get(worker.id)).slice(0, 3500)}`)
              .join('\n\n') || 'No worker reports were returned.';
            const currentReviewResults = new Map(runCheckpoint.currentReviewResults || []);
            const reviewerReports = [];
            for (const reviewer of plan.reviewers) {
              const savedReview = currentReviewResults.get(reviewer.id);
              if (typeof savedReview === 'string') {
                values.set(reviewer.id, savedReview);
                setNodeStatus(reviewer.id, 'DONE', 'done');
                reviewerReports.push(`## ${reviewer.label}\n${savedReview}`);
                continue;
              }
              if (cancelled || token !== runToken) throw new Error('Workflow was cancelled.');
              const reviewPrompt = [
                `You are "${reviewer.label}", an independent reviewer in workflow "${workflow.name}".`,
                `Review instructions:\n${roleInstructions(reviewer) || 'Find correctness, integration, and regression issues.'}`,
                `Agent mode:\n${modeInstruction(reviewer)}`,
                `Original user request:\n${plan.input.prompt.trim()}`,
                clarifications.length ? `User clarifications:\n${formatClarifications(clarifications)}` : '',
                `Current implementation reports:\n${implementationReports}`,
                `Compiler/build/test results:\n${compilerReport}`,
                reviewHistory.length ? `Earlier review feedback:\n${reviewHistory.join('\n\n').slice(-12000)}` : '',
                'Inspect the current project state. Report actionable findings only, with file paths, impact, and evidence. If no issues remain, explicitly say so. Do not edit files.'
              ].filter(Boolean).join('\n\n');
              const review = await runAgent(reviewer, reviewPrompt, token, `REVIEW ROUND ${runCheckpoint.currentRound}`);
              assertRunCurrent(token);
              values.set(reviewer.id, review.text);
              currentReviewResults.set(reviewer.id, review.text);
              runCheckpoint.currentReviewResults = [...currentReviewResults.entries()];
              runCheckpoint.values = [...values.entries()];
              await saveRunCheckpoint();
              reviewerReports.push(`## ${reviewer.label}\n${review.text}`);
            }
            const roundReview = reviewerReports.join('\n\n') || 'No reviewer nodes are configured.';
            runCheckpoint.currentRoundReview = roundReview;
            if (reviewHistory.length < runCheckpoint.currentRound) {
              reviewHistory.push(`Review round ${runCheckpoint.currentRound}:\n${roundReview}\n\nCompiler:\n${compilerReport}`);
            }
            runCheckpoint.reviewHistory = reviewHistory;
            await setCheckpointPhase('decision', `Orchestrator · round ${runCheckpoint.currentRound}`, token);
            assertRunCurrent(token);
          }

          if (runCheckpoint.phase === 'decision') {
            const compilerReport = `${values.get(plan.compiler.id) || ''}\n\n${integrationSummary()}`;
            const implementationReports = plan.workers
              .filter((worker) => values.has(worker.id))
              .map((worker) => `## ${worker.label} (${worker.provider})\n${String(values.get(worker.id)).slice(0, 3500)}`)
              .join('\n\n') || 'No worker reports were returned.';
            const roundReview = runCheckpoint.currentRoundReview || 'No reviewer nodes are configured.';
            const canRevise = revisionRoundsUsed < plan.orchestrator.revisionRounds;
            const gateReasons = Array.isArray(runCheckpoint.blockReasons) ? runCheckpoint.blockReasons : [];
            let decision = runCheckpoint.pendingDecision;
            if (!decision) {
              const decisionPrompt = [
                `You are the orchestrator coordinating workflow "${workflow.name}".`,
                `Your role:\n${roleInstructions(plan.orchestrator) || 'Evaluate review and compiler results, then coordinate fixes or finish.'}`,
                `Agent mode:\n${modeInstruction(plan.orchestrator)}`,
                `Original user request:\n${plan.input.prompt.trim()}`,
                clarifications.length ? `User clarifications:\n${formatClarifications(clarifications)}` : '',
                `Implementation reports:\n${implementationReports}`,
                `Roadmap goals and acceptance criteria:\n${JSON.stringify(runCheckpoint.roadmapGoals, null, 2)}`,
                `Reviewer feedback for this round:\n${roundReview}`,
                `Compiler/build/test results:\n${compilerReport}`,
                `Current workers:\n${JSON.stringify(workerRosterSummary(), null, 2)}`,
                `Revision rounds used: ${revisionRoundsUsed}; maximum allowed: ${plan.orchestrator.revisionRounds}.`,
                `Further revision assignments allowed: ${canRevise ? 'yes' : 'no'}.`,
                gateReasons.length ? `The previous completion attempt failed these gates:\n${gateReasons.map((reason) => `- ${reason}`).join('\n')}` : '',
                actionProtocol,
                gateReasons.length && canRevise
                  ? 'The last completion attempt failed its gates. You must request targeted revisions for those failures; do not complete until a later review and check round passes.'
                  : canRevise
                  ? 'If a specific change or integration conflict remains, request targeted work from one or more current workers. Only finish when every goal meets its acceptance criteria, required checks pass, and conflicts are resolved. Include evidence for every goal.'
                  : 'The revision limit has been reached. Do not request further revisions; report an incomplete result if any goal, check, or integration conflict remains. Include evidence for every goal you can verify.'
              ].join('\n\n');
              decision = await runCoordinator(
                plan, decisionPrompt, token,
                gateReasons.length && canRevise ? ['revise'] : canRevise ? ['revise', 'complete'] : ['complete'],
                `ORCHESTRATE ROUND ${runCheckpoint.currentRound}`,
                clarifications
              );
              assertRunCurrent(token);
            }
            if (decision.action === 'complete') {
              if (typeof decision.finalResponse !== 'string' || !decision.finalResponse.trim()) {
                throw new Error('The orchestrator completed without providing a final response.');
              }
              finalText = decision.finalResponse.trim();
              runCheckpoint.pendingDecision = decision;
              runCheckpoint.finalText = finalText;
              await setCheckpointPhase('finalize', 'Preparing final response', token);
              assertRunCurrent(token);
              continue;
            }
            if (decision.action !== 'revise') {
              throw new Error(`The orchestrator returned an unsupported action while resuming: ${decision.action}`);
            }
            const revisionAssignments = validateAssignments(decision, plan.workers);
            const revisionSummary = typeof decision.summary === 'string' ? decision.summary.trim() : '';
            if (revisionSummary) appendResult(`ORCHESTRATOR · REVISION ${revisionRoundsUsed + 1}`, revisionSummary, false, true);
            const feedback = [
              `Most recent reviewer findings:\n${roundReview}`,
              `Latest build and test output:\n${compilerReport}`,
              `Integration status:\n${integrationSummary()}`,
              `Previous review rounds:\n${reviewHistory.slice(0, -1).join('\n\n').slice(-8000)}`
            ].filter(Boolean).join('\n\n');
            revisionRoundsUsed += 1;
            runCheckpoint.revisionRoundsUsed = revisionRoundsUsed;
            runCheckpoint.assignments = [...revisionAssignments.entries()];
            runCheckpoint.completedWorkers = [];
            runCheckpoint.assignmentContext = feedback;
            runCheckpoint.pendingDecision = decision;
            runCheckpoint.blockReasons = [];
            await setCheckpointPhase('revision', `Revision ${revisionRoundsUsed}`, token);
            continue;
          }

          if (runCheckpoint.phase === 'finalize') {
            const decision = runCheckpoint.pendingDecision || {};
            const gate = completionGate(decision);
            runCheckpoint.goalEvidence = gate.evidence;
            if (gate.reasons.length) {
              const revisionLimit = Number.isInteger(plan.orchestrator.revisionRounds) ? plan.orchestrator.revisionRounds : 0;
              if (revisionRoundsUsed < revisionLimit) {
                runCheckpoint.blockReasons = gate.reasons;
                runCheckpoint.pendingDecision = null;
                runCheckpoint.phase = 'decision';
                runCheckpoint.status = 'running';
                runCheckpoint.progress = 'Completion gates failed · requesting targeted revisions';
                await saveRunCheckpoint();
                continue;
              }
              runCheckpoint.status = 'blocked';
              runCheckpoint.blockReasons = gate.reasons;
              finalText = `BLOCKED · ROADMAP INCOMPLETE\n\n${runCheckpoint.finalText || finalText}\n\nOutstanding completion gates:\n${gate.reasons.map((reason) => `- ${reason}`).join('\n')}`;
            } else {
              runCheckpoint.status = 'running';
              runCheckpoint.blockReasons = [];
              finalText = runCheckpoint.finalText || finalText;
            }
            renderRoadmap();
            break;
          }
          throw new Error(`The saved workflow checkpoint has an unsupported phase: ${runCheckpoint.phase}`);
        }

        assertRunCurrent(token);
        values.set(plan.orchestrator.id, finalText);
        const outputSources = workflow.edges
          .filter((edge) => edge.target === plan.output.id)
          .map((edge) => nodeById(edge.source))
          .filter((node) => node && values.has(node.id));
        const outputText = outputSources.map((node) => {
          const text = values.get(node.id);
          return node.id === plan.orchestrator.id
            ? text
            : `## ${node.label}${node.provider ? ` (${node.provider})` : ''}\n${text}`;
        }).join('\n\n');
        const blocked = runCheckpoint.status === 'blocked';
        setNodeStatus(plan.output.id, blocked ? 'BLOCKED' : 'DONE', blocked ? 'error' : 'done');
        const outputTitle = blocked
          ? `${plan.output.label} · BLOCKED`
          : outputSources.length === 1 && outputSources[0].id === plan.orchestrator.id
          ? `${plan.output.label} · ORCHESTRATED`
          : `${plan.output.label} · ${outputSources.length} CONNECTED SOURCES`;
        appendResult(outputTitle, outputText, true, true);
        runCheckpoint.values = [...values.entries()];
        runCheckpoint.outputText = outputText;
        runCheckpoint.finalText = finalText;
        runCheckpoint.phase = blocked ? 'finalize' : 'complete';
        runCheckpoint.status = blocked ? 'blocked' : 'complete';
        runCheckpoint.progress = blocked ? 'Blocked · completion gates remain' : 'Workflow completed';
        runCheckpoint.activeNodeId = '';
        await disposeRunWorkspaces();
        await saveRunCheckpoint();
        assertRunCurrent(token);
        runStatus.textContent = blocked ? 'BLOCKED · INCOMPLETE' : 'COMPLETE';
        managerSummary.textContent = runCheckpoint.progress;
      } catch (error) {
        if (token === runToken) {
          const stopped = cancelled || /cancel|abort/i.test(String(error.message || error));
          runStatus.textContent = stopped ? 'STOPPED' : 'FAILED';
          managerSummary.textContent = stopped ? 'Run stopped. Completed integrations are preserved; unfinished assignments can resume from their saved workspaces.' : `Run failed: ${error.message || error}`;
          if (runCheckpoint) {
            runCheckpoint.status = stopped ? 'stopped' : 'failed';
            runCheckpoint.progress = `${runCheckpoint.progress || runCheckpoint.phase}${stopped ? ' · stopped' : ' · failed'}`;
            runCheckpoint.lastError = String(error.message || error);
            if (runCheckpoint.activeNodeId && nodeById(runCheckpoint.activeNodeId)) {
              setNodeStatus(runCheckpoint.activeNodeId, stopped ? 'STOPPED' : 'FAILED', stopped ? '' : 'error');
            }
            runCheckpoint.activeNodeId = '';
            try { await saveRunCheckpoint(); }
            catch (saveError) { fail(saveError, 'SAVE FLOW CHECKPOINT'); }
          }
          if (stopped) appendResult('WORKFLOW STOPPED', 'The workflow was stopped. Resume is available from the latest saved checkpoint.');
          else {
            appendResult('WORKFLOW ERROR', error.message);
            fail(error, 'AGENT FLOW');
          }
        }
      } finally {
        if (token === runToken) {
          busy = false;
          cancelled = false;
          updateControls();
        }
      }
    }

    async function stopWorkflow() {
      if (!busy) return;
      cancelled = true;
      runStatus.textContent = 'STOPPING…';
      managerSummary.textContent = 'Stopping active agents and safely discarding their unintegrated snapshots…';
      for (const id of activeConversations.keys()) {
        call('agent:cancel', id).catch((error) => fail(error, 'STOP WORKFLOW AGENT'));
      }
      for (const runId of activeTaskRuns) {
        call('tasks:kill', runId).catch((error) => fail(error, 'STOP WORKFLOW TASK'));
      }
      if (runCheckpoint) {
        runCheckpoint.progress = `Stopping during ${runCheckpoint.progress || runCheckpoint.phase}`;
        await saveRunCheckpoint();
      }
    }

    function restoreWorkflowSnapshot(snapshot) {
      workflow = copyWorkflow(snapshot);
      selectedNodeIds = new Set([...selectedNodeIds].filter((id) => nodeById(id)));
      selectedEdges = selectedEdges.filter((edge) =>
        workflow.edges.some((item) => item.source === edge.source && item.target === edge.target)
      );
      if (!selectedNodeIds.has(selectedNodeId)) {
        selectedNodeId = [...selectedNodeIds].at(-1) ||
          workflow.nodes.find((node) => node.type === 'input')?.id ||
          workflow.nodes[0]?.id || null;
        selectedNodeIds = new Set(selectedNodeId ? [selectedNodeId] : []);
      }
      nameInput.value = workflow.name;
      runStates.clear();
      runStatus.textContent = 'IDLE';
      renderGraph();
      syncManagerControls();
      scheduleSave();
    }

    function undoWorkflow() {
      if (busy) {
        toast('Stop the workflow before undoing changes.', 'warn');
        return;
      }
      flushPendingHistory();
      if (!undoStack.length) return;
      const current = copyWorkflow(workflow);
      const snapshot = undoStack.pop();
      redoStack.push(current);
      if (redoStack.length > MAX_UNDO_STEPS) redoStack.shift();
      historySnapshot = copyWorkflow(snapshot);
      restoreWorkflowSnapshot(snapshot);
    }

    function redoWorkflow() {
      if (busy) {
        toast('Stop the workflow before redoing changes.', 'warn');
        return;
      }
      flushPendingHistory();
      if (!redoStack.length) return;
      const current = copyWorkflow(workflow);
      const snapshot = redoStack.pop();
      undoStack.push(current);
      if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
      historySnapshot = copyWorkflow(snapshot);
      restoreWorkflowSnapshot(snapshot);
    }
    const offFlowFiles = bus.on('fs:changed', (paths) => {
      if (!Array.isArray(paths)) return;
      for (const active of activeConversations.values()) {
        let changed = false;
        for (const filePath of paths) {
          if (relativeProjectPath(filePath) && !active.fileChanges.has(filePath)) {
            active.fileChanges.add(filePath);
            changed = true;
          }
        }
        if (changed) renderFlowFileChanges(active);
      }
    });

    const offAgent = on('agent:event', (event) => {
      const active = activeConversations.get(event.conversationId);
      if (!active || active.token !== runToken) return;
      if (event.type === 'delta') {
        const next = `${active.text}${event.text || ''}`;
        if (next.length > MAX_AGENT_OUTPUT) active.truncated = true;
        active.text = next.slice(0, MAX_AGENT_OUTPUT);
        active.outputView.innerHTML = renderMarkdown(active.text + (active.truncated ? '\n[response truncated in the workflow log]' : ''));
      } else if (event.type === 'replace') {
        const next = String(event.text || '');
        if (next.length > MAX_AGENT_OUTPUT) active.truncated = true;
        active.text = next.slice(0, MAX_AGENT_OUTPUT);
        active.outputView.innerHTML = renderMarkdown(active.text + (active.truncated ? '\n[response truncated in the workflow log]' : ''));
      } else if (event.type === 'activity') {
        setNodeStatus(active.node.id, 'USING TOOLS', 'running');
        recordFlowActivity(active, event.text);
      } else if (event.type === 'permission') {
        recordFlowActivity(active, `Approval requested · ${String(event.kind || 'action').toUpperCase()}`);
        confirm(
          `AGENT PERMISSION: ${String(event.kind).toUpperCase()}`,
          h('div.ag-permission', { tabindex: '0' }, event.details),
          { ok: 'ALLOW ONCE', danger: true }
        ).then((approved) => call('agent:respond', event.approvalId, approved))
          .catch((error) => {
            call('agent:respond', event.approvalId, false).catch(() => {});
            fail(error, 'AGENT PERMISSION');
          });
      }
    });

    nameInput.addEventListener('input', () => {
      workflow.name = nameInput.value.trim() || 'Agent workflow';
      scheduleSave();
    });
    signInButton.addEventListener('click', () => wm.open('agents').catch((error) => fail(error, 'OPEN AGENTS')));
    runButton.addEventListener('click', runWorkflow);
    resumeButton.addEventListener('click', () => runWorkflow({ resume: true }));
    stopButton.addEventListener('click', () => stopWorkflow().catch((error) => fail(error, 'SAVE FLOW CHECKPOINT')));
    presetSelect.addEventListener('change', updateControls);
    loadPresetButton.addEventListener('click', () => applySelectedPreset().catch((error) => fail(error, 'LOAD FLOW PRESET')));
    savePresetButton.addEventListener('click', () => saveCurrentPreset().catch((error) => fail(error, 'SAVE FLOW PRESET')));
    deletePresetButton.addEventListener('click', () => deleteSelectedPreset().catch((error) => fail(error, 'DELETE FLOW PRESET')));
    zoomOutButton.addEventListener('click', () => setZoom(zoom - 0.1));
    zoomInButton.addEventListener('click', () => setZoom(zoom + 0.1));
    resetZoomButton.addEventListener('click', () => setZoom(1));
    root.addEventListener('keydown', (event) => {
      if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        const editableTarget = event.target.closest('input, textarea, [contenteditable="true"]');
        if (!editableTarget && key === 'z') {
          event.preventDefault();
          if (event.shiftKey) redoWorkflow();
          else undoWorkflow();
          return;
        }
        if (!editableTarget && key === 'y') {
          event.preventDefault();
          redoWorkflow();
          return;
        }
      }
      if (!['Delete', 'Backspace'].includes(event.key)) return;
      if (!viewport.contains(event.target) && !inspector.contains(event.target)) return;
      if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const hasDeletableNode = [...selectedNodeIds].some((id) => nodeById(id)?.type === 'agent');
      if (!selectedEdges.length && !hasDeletableNode) return;
      event.preventDefault();
      deleteSelectedItems();
    });
    viewport.addEventListener('wheel', (event) => {
      event.preventDefault();
      setZoom(zoom * Math.exp(-event.deltaY * 0.001), event.clientX, event.clientY);
    }, { passive: false });
    taskInput.addEventListener('input', () => {
      const input = workflow.nodes.find((node) => node.type === 'input');
      if (!input) return;
      input.prompt = taskInput.value;
      scheduleSave();
    });
    providerSelect.addEventListener('change', () => {
      const orchestrator = nodeById('orchestrator');
      if (!orchestrator) return;
      orchestrator.provider = providerSelect.value;
      orchestrator.accountId = accountState.active[orchestrator.provider] || '';
      orchestrator.model = '';
      orchestrator.reasoningEffort = '';
      orchestrator.permissionMode = 'manual';
      orchestrator.webSearchMode = 'disabled';
      orchestrator.enableMcp = false;
      syncManagerControls();
      scheduleSave();
    });
    accountSelect.addEventListener('change', () => {
      const orchestrator = nodeById('orchestrator');
      if (!orchestrator) return;
      orchestrator.accountId = accountSelect.value;
      scheduleSave();
    });
    modelInput.addEventListener('input', () => {
      const orchestrator = nodeById('orchestrator');
      if (!orchestrator) return;
      orchestrator.model = modelInput.value.trim() || 'auto';
      scheduleSave();
    });
    reasoningSelect.addEventListener('change', () => {
      const orchestrator = nodeById('orchestrator');
      if (!orchestrator) return;
      orchestrator.reasoningEffort = reasoningSelect.value;
      scheduleSave();
    });
    permissionSelect.addEventListener('change', () => {
      const orchestrator = nodeById('orchestrator');
      if (!orchestrator) return;
      orchestrator.permissionMode = providerSelect.value === 'copilot' ? permissionSelect.value : 'manual';
      scheduleSave();
    });
    revisionInput.addEventListener('change', () => {
      const orchestrator = nodeById('orchestrator');
      if (!orchestrator) return;
      orchestrator.revisionRounds = Math.max(0, Math.min(MAX_REVISION_ROUNDS, Number.parseInt(revisionInput.value, 10) || 0));
      revisionInput.value = String(orchestrator.revisionRounds);
      scheduleSave();
    });
    root.append(
      h('div.af-header',
        h('div.af-heading', h('div.af-eyebrow', 'MANAGER-LED AGENT SYSTEM'), h('h2', 'Agent Flow'), projectLabel),
        h('div.af-toolbar', nameInput, saveStatus, signInButton, runButton, resumeButton, stopButton)
      ),
      h('div.af-instructions',
        h('span.af-hint', 'Describe the outcome. The manager creates the roadmap, chooses the team size, and coordinates implementation, integration, and verification.'),
        h('span.af-runline', runStatus)
      ),
      billingHint,
      presetToolbar,
      h('section.af-manager-settings',
        h('label.af-field', h('span', 'MANAGER / TEAM PROVIDER'), providerSelect),
        h('label.af-field', h('span', 'SUBSCRIPTION ACCOUNT'), accountSelect),
        h('label.af-field', h('span', 'MODEL OVERRIDE'), modelInput),
        h('label.af-field', h('span', 'REASONING EFFORT'), reasoningSelect),
        h('label.af-field', h('span', 'FILE PERMISSIONS'), permissionSelect),
        h('label.af-field', h('span', 'MAX REVISION ROUNDS'), revisionInput),
        h('div.af-capacity-card', h('span.af-settings-label', 'HOST CAPACITY'), capacityStatus)
      ),
      h('section.af-task-panel',
        h('div.af-section-heading', h('div', h('span.af-section-kicker', 'REQUEST'), h('h3', 'What should the team deliver?'))),
        taskInput
      ),
      h('div.af-manager-summary', managerSummary,
        h('span.af-summary-note', 'Workers operate in isolated snapshots; overlapping edits are reported, Git metadata and symlink targets are excluded.')
      ),
      h('div.af-manager-content',
        h('section.af-manager-panel.af-roadmap-panel',
          h('div.af-section-heading',
            h('div', h('span.af-section-kicker', 'GOALS & ACCEPTANCE'), h('h3', 'Roadmap')),
            roadmapCount
          ),
          roadmapList
        ),
        h('section.af-manager-panel.af-workers-panel',
          h('div.af-section-heading',
            h('div', h('span.af-section-kicker', 'DYNAMIC TEAM'), h('h3', 'Workers')),
            workerCount
          ),
          workerList
        )
      ),
      h('div.af-results-panel', h('div.af-results-head', h('b', 'RUN OUTPUT'), h('span', 'Worker, review, build, and orchestration results'), h('span.af-spacer')), results)
    );
    win.body.appendChild(root);

    async function refreshTools() {
      try {
        const info = await call('app:info');
        availableTools = info.tools || {};
      } catch (error) {
        fail(error, 'AGENT AVAILABILITY');
      }
    }

    async function refreshCompilerTasks() {
      if (!project.root) {
        detectedTasks = [];
        return;
      }
      try {
        const tasks = await call('tasks:detect', project.root);
        if (!Array.isArray(tasks)) throw new Error('The task detector returned an invalid result.');
        detectedTasks = tasks;
      } catch (error) {
        fail(error, 'DETECT BUILD AND TEST TASKS');
      }
    }

    async function refreshAccountState() {
      accountState = await call('agent:accounts:list');
      accountStateLoaded = true;
      renderManagerAccountOptions();
    }

    async function refreshWorkerCapacity() {
      workerCapacity = await call('flow:capacity');
      syncManagerControls();
    }

    await refreshTools();
    await refreshCompilerTasks();
    await refreshAccountState().catch((error) => fail(error, 'SUBSCRIPTION ACCOUNTS'));
    await refreshWorkerCapacity().catch((error) => fail(error, 'WORKER CAPACITY'));
    await loadWorkflow();
    await refreshSavedPresets().catch((error) => fail(error, 'LOAD FLOW PRESETS'));
    const offAccounts = on('agent:accounts:changed', (state) => {
      accountState = state;
      accountStateLoaded = true;
      let repaired = false;
      for (const node of workflow.nodes) {
        if ((node.type === 'agent' || node.type === 'orchestrator') && node.accountId &&
            !accountsFor(node.provider).some((profile) => profile.id === node.accountId)) {
          node.accountId = '';
          repaired = true;
        }
      }
      if (repaired) scheduleSave();
      if (!busy) {
        renderInspector();
        syncManagerControls();
      }
    });
    const offProject = bus.on('project:changed', async () => {
      runToken++;
      cancelled = true;
      await stopWorkflow().catch((error) => fail(error, 'SAVE FLOW CHECKPOINT'));
      busy = false;
      await refreshCompilerTasks();
      await refreshWorkerCapacity().catch((error) => fail(error, 'WORKER CAPACITY'));
      await loadWorkflow().catch((error) => fail(error, 'LOAD AGENT FLOW'));
    });
    const offFlowFolder = bus.on('flow:add-folder', (folderPath) => {
      if (!project.root || typeof folderPath !== 'string') {
        toast('Open a project before adding folder context to Agent Flow.', 'warn');
        return;
      }
      const rootPrefix = project.root.endsWith(sep()) ? project.root : `${project.root}${sep()}`;
      const caseInsensitive = window.phantom.platform === 'win32';
      const candidate = caseInsensitive ? folderPath.toLowerCase() : folderPath;
      const prefix = caseInsensitive ? rootPrefix.toLowerCase() : rootPrefix;
      const rootPath = caseInsensitive ? project.root.toLowerCase() : project.root;
      if (candidate !== rootPath && !candidate.startsWith(prefix)) {
        toast('Only folders inside the active project can be sent to Agent Flow.', 'warn');
        return;
      }
      const relative = candidate === rootPath ? '.' : folderPath.slice(rootPrefix.length);
      const task = nodeById('task');
      if (!task) {
        toast('The workflow has no Task node to receive folder context.', 'error');
        return;
      }
      const item = `- ${relative}`;
      if (task.prompt.split(/\r?\n/).includes(item)) {
        selectNode(task.id);
        toast(`${relative} is already in the Agent Flow task.`, 'info', 'AGENT FLOW');
        return;
      }
      const section = `${task.prompt.trimEnd() ? '\n\n' : ''}Project folder to focus on:\n${item}`;
      if (task.prompt.length + section.length > MAX_TASK_LENGTH) {
        toast('The Agent Flow task is too long to add another folder reference.', 'warn');
        return;
      }
      task.prompt = `${task.prompt.trimEnd()}${section}`;
      renderGraph();
      syncManagerControls();
      selectNode(task.id);
      scheduleSave();
      toast(`Added folder ${relative} to the Agent Flow task.`, 'info', 'AGENT FLOW');
    });

    return {
      destroy() {
        offAgent();
        offFlowFiles();
        offProject();
        offAccounts();
        offFlowFolder();
        window.removeEventListener('pointermove', handleCanvasPointerMove);
        window.removeEventListener('pointerup', handleCanvasPointerUp);
        window.removeEventListener('pointercancel', handleCanvasPointerCancel);
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
          const pending = pendingSave || { key: currentProjectKey(), value: copyWorkflow(workflow) };
          pendingSave = null;
          flushPendingHistory();
          writeWorkflow(pending.key, pending.value).catch((error) => fail(error, 'SAVE AGENT FLOW'));
        }
        if (busy) stopWorkflow().catch((error) => fail(error, 'SAVE FLOW CHECKPOINT'));
      }
    };
  }
};
