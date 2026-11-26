'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { spawn, execFile } = require('child_process');
const { which, readJson, writeJsonAtomic } = require('../util');
const { getAgentCapacity } = require('./flow-capacity');

const COPILOT_SEND_TIMEOUT_MS = 30 * 60 * 1000;

const API_CREDENTIALS = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'COPILOT_API_KEY', 'COPILOT_API_TOKEN', 'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN', 'GITHUB_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'
]);

function subscriptionEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (API_CREDENTIALS.has(name) || /(?:^|_)(?:API_KEY|API_TOKEN|AUTH_TOKEN)$/.test(name)) delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function workingDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Open a project before starting an agent.');
  const resolved = fs.realpathSync(path.resolve(value));
  if (!fs.statSync(resolved).isDirectory()) throw new Error('The active project path is not a directory.');
  return resolved;
}

function permissionDetails(request) {
  const detail = JSON.stringify(request, null, 2);
  return detail.length > 5000 ? detail.slice(0, 5000) + '\n…' : detail;
}

function assistedReadApproval(request, invocation, cwd) {
  const assessment = invocation?.assistedApprovalAssessment;
  if (request?.kind !== 'read' || request.requestSandboxBypass === true ||
      request.managedApprovalRequired === true ||
      invocation?.promptRequest?.managedApprovalRequired === true ||
      assessment?.status !== 'completed' ||
      assessment.recommendation !== 'approve' ||
      typeof request.path !== 'string' || !request.path.trim()) return false;
  try {
    const root = fs.realpathSync(cwd);
    const target = fs.realpathSync(path.resolve(root, request.resolvedPath || request.path));
    const relative = path.relative(root, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function projectScopedApproval(request, invocation, cwd) {
  if (!['read', 'write'].includes(request?.kind) ||
      request.requestSandboxBypass === true ||
      request.managedApprovalRequired === true ||
      invocation?.promptRequest?.managedApprovalRequired === true) return false;

  const targets = request.kind === 'read'
    ? [request.resolvedPath || request.path]
    : [
      request.resolvedPath || request.fileName,
      ...(Array.isArray(request.fileEdits)
        ? request.fileEdits.flatMap((edit) => [edit?.before?.path, edit?.after?.path].filter(Boolean))
        : [])
    ];
  if (!targets.length || targets.some((target) => typeof target !== 'string' || !target.trim())) return false;

  try {
    const root = fs.realpathSync(cwd);
    return targets.every((target) => {
      try {
        const resolved = fs.realpathSync(path.resolve(root, target));
        const relative = path.relative(root, resolved);
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      } catch (error) {
        if (request.kind !== 'write' || error.code !== 'ENOENT') return false;
        const candidate = path.resolve(root, target);
        try {
          fs.lstatSync(candidate);
          return false;
        } catch (statError) {
          if (statError.code !== 'ENOENT') return false;
        }
        const parent = fs.realpathSync(path.dirname(candidate));
        const relative = path.relative(root, parent);
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      }
    });
  } catch {
    return false;
  }
}

function agentOptions(provider, value) {
  if (value == null) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid agent configuration.');
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (model.length > 128 || /[\u0000-\u001f]/.test(model)) throw new Error('Model names must be under 129 characters and contain no control characters.');
  const efforts = {
    copilot: ['low', 'medium', 'high', 'xhigh', 'max'],
    codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'],
    claude: ['low', 'medium', 'high', 'xhigh', 'max']
  };
  const reasoningEffort = value.reasoningEffort || '';
  if (reasoningEffort && !efforts[provider].includes(reasoningEffort)) throw new Error(`Unsupported reasoning effort for ${provider}.`);
  const webSearchMode = value.webSearchMode || 'disabled';
  if (provider === 'codex' && !['disabled', 'cached', 'live'].includes(webSearchMode)) throw new Error('Unsupported Codex web search mode.');
  if (provider !== 'codex' && webSearchMode !== 'disabled') throw new Error('Web search mode is configurable only for Codex.');
  const agentMode = value.agentMode || 'interactive';
  if (!['interactive', 'plan', 'autopilot'].includes(agentMode)) throw new Error('Unsupported agent mode.');
  const permissionMode = value.permissionMode || 'manual';
  if (!['manual', 'assisted', 'project-scoped'].includes(permissionMode)) throw new Error('Unsupported permission mode.');
  if (provider !== 'copilot' && permissionMode !== 'manual') {
    throw new Error(`Custom permission modes are supported only for Copilot; ${provider} uses its native approval flow.`);
  }
  const enableMcp = value.enableMcp === true;
  if (enableMcp && provider !== 'copilot') {
    throw new Error('Explicit MCP discovery is currently supported only for Copilot; Codex and Claude use their native CLI configuration.');
  }
  return { model, reasoningEffort, webSearchMode, agentMode, permissionMode, enableMcp };
}

function quotaNumber(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCopilotQuota(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('GitHub returned an invalid Copilot quota response.');
  }
  const snapshots = payload.quota_snapshots;
  if (!snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots)) {
    throw new Error('GitHub did not return Copilot quota details for this account.');
  }

  const premiumKey = snapshots.premium_interactions ? 'premium_interactions'
    : snapshots.premium_models ? 'premium_models' : null;
  const categories = [
    ...(premiumKey ? [[premiumKey, payload.token_based_billing === true ? 'AI credits' : 'Premium requests']] : []),
    ['chat', 'Chat'],
    ['completions', 'Completions']
  ];
  const windows = [];
  for (const [key, label] of categories) {
    const snapshot = snapshots[key];
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
    const entitlement = quotaNumber(snapshot.entitlement) ?? quotaNumber(snapshot.limit);
    const creditsUsed = quotaNumber(snapshot.credits_used);
    const reportedRemaining = quotaNumber(snapshot.remaining) ?? quotaNumber(snapshot.quota_remaining);
    let remaining = reportedRemaining;
    if (remaining === null && entitlement !== null && creditsUsed !== null) remaining = entitlement - creditsUsed;
    if (remaining === null && entitlement > 0 && snapshot.has_quota === false) remaining = 0;
    const unlimited = snapshot.unlimited === true;
    let percentRemaining = quotaNumber(snapshot.percent_remaining);
    if (percentRemaining === null && remaining !== null && entitlement > 0) {
      percentRemaining = Math.max(0, Math.min(100, remaining / entitlement * 100));
    }
    if (percentRemaining !== null) percentRemaining = Math.max(0, Math.min(100, percentRemaining));
    if (!unlimited && (entitlement === null || entitlement <= 0) &&
        (remaining === null || remaining <= 0) && percentRemaining === null) continue;

    windows.push({
      key,
      label: key === premiumKey && payload.token_based_billing === true ? 'AI credits' : label,
      entitlement,
      remaining: remaining === null ? null : Math.max(0, remaining),
      overage: remaining !== null && remaining < 0 ? Math.abs(remaining) : 0,
      percentRemaining,
      unlimited
    });
  }
  if (!windows.length) throw new Error('GitHub returned no Copilot quota windows for this account.');

  return {
    available: true,
    login: typeof payload.login === 'string' ? payload.login : '',
    plan: typeof payload.copilot_plan === 'string' ? payload.copilot_plan : '',
    resetAt: typeof payload.quota_reset_date_utc === 'string'
      ? payload.quota_reset_date_utc
      : typeof payload.quota_reset_date === 'string' ? payload.quota_reset_date : '',
    fetchedAt: Date.now(),
    windows
  };
}

function fetchCopilotQuota() {
  const gh = which('gh');
  if (!gh) return Promise.resolve({ available: false, message: 'GitHub CLI (gh) is required to fetch Copilot plan quota.' });
  return new Promise((resolve) => {
    execFile(gh, ['api', 'copilot_internal/user'], {
      env: subscriptionEnvironment(),
      encoding: 'utf8',
      timeout: 12000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        let message = 'GitHub CLI could not fetch Copilot plan quota.';
        if (error.killed) message = 'The Copilot quota request timed out. Try refreshing again.';
        else if (/not logged in|not authenticated|authentication|HTTP 401|HTTP 403/i.test(stderr || '')) {
          message = 'GitHub CLI is not authenticated for quota lookup. Sign in with `gh auth login` and try again.';
        } else if (stderr && stderr.trim()) {
          message = `Copilot quota lookup failed: ${stderr.trim().slice(0, 240)}`;
        }
        resolve({ available: false, message });
        return;
      }
      try {
        resolve(normalizeCopilotQuota(JSON.parse(stdout)));
      } catch (parseError) {
        resolve({
          available: false,
          message: parseError instanceof SyntaxError
            ? 'GitHub returned an invalid Copilot quota response.'
            : parseError.message
        });
      }
    });
  });
}

module.exports = (core) => {
  const conversations = new Map();
  const pendingApprovals = new Map();
  let creatingConversations = 0;
  const accountStateFile = path.join(core.dataDir, 'agent-accounts.json');
  let accountWrites = Promise.resolve();

  const emptyAccountState = () => ({
    profiles: { copilot: [], codex: [], claude: [] },
    active: { copilot: 'default', codex: 'default', claude: 'default' },
    usage: { copilot: {}, codex: {}, claude: {} }
  });

  async function readAccountState() {
    const raw = await readJson(accountStateFile, {});
    const state = emptyAccountState();
    for (const provider of Object.keys(state.profiles)) {
      state.profiles[provider] = Array.isArray(raw?.profiles?.[provider])
        ? raw.profiles[provider].filter((profile) =>
          profile && typeof profile.id === 'string' && /^[0-9a-f-]{36}$/i.test(profile.id) &&
          typeof profile.name === 'string'
        ).map((profile) => ({ id: profile.id, name: profile.name }))
        : [];
      state.usage[provider] = raw?.usage?.[provider] && typeof raw.usage[provider] === 'object'
        ? raw.usage[provider]
        : {};
      const activeId = raw?.active?.[provider];
      state.active[provider] = activeId === 'default' ||
        state.profiles[provider].some((profile) => profile.id === activeId)
        ? activeId
        : 'default';
    }
    return state;
  }

  async function updateAccountState(update) {
    const operation = accountWrites.then(async () => {
      const state = await readAccountState();
      const result = await update(state);
      await writeJsonAtomic(accountStateFile, state);
      const snapshot = accountSnapshot(state);
      core.emit('agent:accounts:changed', snapshot);
      return result === undefined ? snapshot : result;
    });
    accountWrites = operation.catch(() => {});
    return operation;
  }

  function accountSnapshot(state) {
    const providers = {};
    for (const provider of Object.keys(state.profiles)) {
      providers[provider] = [
        { id: 'default', name: 'Default CLI login' },
        ...state.profiles[provider]
      ];
    }
    return { providers, active: { ...state.active }, usage: state.usage };
  }

  function accountDirectory(provider, id) {
    return path.join(core.dataDir, 'agent-profiles', provider, id);
  }

  function accountEnvironment(provider, id) {
    if (id === 'default') return {};
    const directory = accountDirectory(provider, id);
    if (provider === 'copilot') return { COPILOT_HOME: directory };
    if (provider === 'codex') return { CODEX_HOME: directory };
    return { CLAUDE_CONFIG_DIR: directory };
  }

  async function recordUsage(conversation, turn) {
    await updateAccountState((state) => {
      const existing = state.usage[conversation.provider][conversation.accountId] || {};
      state.usage[conversation.provider][conversation.accountId] = {
        requests: (Number(existing.requests) || 0) + 1,
        inputChars: (Number(existing.inputChars) || 0) + turn.inputChars,
        outputChars: (Number(existing.outputChars) || 0) + turn.outputChars,
        reportedInputTokens: (Number(existing.reportedInputTokens) || 0) + turn.reportedInputTokens,
        reportedOutputTokens: (Number(existing.reportedOutputTokens) || 0) + turn.reportedOutputTokens,
        reportedTokenTurns: (Number(existing.reportedTokenTurns) || 0) + turn.reportedTokenTurns,
        updatedAt: Date.now()
      };
    });
  }

  function requireProvider(provider) {
    if (!['copilot', 'codex', 'claude'].includes(provider)) throw new Error('Unsupported agent provider.');
    return provider;
  }

  async function requireAccount(state, provider, accountId) {
    if (accountId === 'default') return;
    if (!state.profiles[provider].some((profile) => profile.id === accountId)) {
      throw new Error('The selected provider account no longer exists.');
    }
  }

  function emit(conversationId, event) {
    if (conversations.has(conversationId)) core.emit('agent:event', { conversationId, ...event });
  }

  function requestPermission(conversationId, request) {
    const approvalId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(approvalId);
        resolve({ kind: 'reject', feedback: 'Permission request timed out.' });
      }, 5 * 60 * 1000);
      pendingApprovals.set(approvalId, { conversationId, resolve, timer });
      emit(conversationId, {
        type: 'permission',
        approvalId,
        kind: request.kind || 'unknown',
        details: permissionDetails(request)
      });
    });
  }

  async function createCopilotConversation(id, cwd, options, accountEnv) {
    const { CopilotClient, RuntimeConnection } = await import('@microsoft/copilot-sdk');
    const client = new CopilotClient({
      mode: 'coding-agent',
      github: { useLoggedInUser: true },
      runtime: RuntimeConnection.forSpawnedStdio({
        env: { ...subscriptionEnvironment(), ...accountEnv },
        workingDirectory: cwd
      })
    });
    try {
      await client.start();
      const session = await client.createSession({
        model: options.model || 'auto',
        ...(options.reasoningEffort ? { inference: { reasoningEffort: options.reasoningEffort } } : {}),
        workingDirectory: cwd,
        enableConfigDiscovery: options.enableMcp,
        events: { streaming: true },
        permissions: {
          mode: options.permissionMode === 'assisted' ? 'assisted' : 'manual',
          onRequest: (request, invocation) => {
            if (options.agentMode === 'plan' && request.kind !== 'read') {
              return { kind: 'reject', feedback: 'Plan mode is read-only.' };
            }
            if (options.permissionMode === 'project-scoped' && projectScopedApproval(request, invocation, cwd)) {
              return { kind: 'approved' };
            }
            if (options.permissionMode === 'assisted' && assistedReadApproval(request, invocation, cwd)) {
              return { kind: 'approved' };
            }
            return requestPermission(id, request);
          }
        }
      });
      const conversation = {
        id, provider: 'copilot', cwd, client, session, busy: false,
        accountId: options.accountId, currentUsage: null
      };
      session.on('assistant.message_delta', (event) => {
        const text = event.data.deltaContent || '';
        if (conversation.currentUsage) conversation.currentUsage.outputChars += text.length;
        emit(id, { type: 'delta', text });
      });
      return conversation;
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  async function listCopilotModels(cwd, accountEnv = {}) {
    const { CopilotClient, RuntimeConnection } = await import('@microsoft/copilot-sdk');
    const client = new CopilotClient({
      mode: 'coding-agent',
      github: { useLoggedInUser: true },
      runtime: RuntimeConnection.forSpawnedStdio({
        env: { ...subscriptionEnvironment(), ...accountEnv },
        workingDirectory: cwd
      })
    });
    try {
      await client.start();
      const models = await client.listModels();
      return models.map((model) => ({
        id: String(model.id || ''),
        label: String(model.label || model.id || ''),
        kind: String(model.provider?.kind || '')
      })).filter((model) => model.id && model.kind === 'copilot');
    } finally {
      await client.stop();
    }
  }

  async function createCodexConversation(id, cwd, options, accountEnv) {
    const { Codex } = await import('@openai/codex-sdk');
    const codex = new Codex({ env: { ...subscriptionEnvironment(), ...accountEnv } });
    const thread = codex.startThread({
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { modelReasoningEffort: options.reasoningEffort } : {}),
      webSearchMode: options.webSearchMode,
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      sandboxMode: options.agentMode === 'autopilot' ? 'workspace-write' : 'read-only',
      approvalPolicy: 'on-request'
    });
    return {
      id, provider: 'codex', cwd, thread, busy: false, controller: null,
      accountId: options.accountId, currentUsage: null
    };
  }

  function stopProcess(child) {
    if (!child || child.killed) return;
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      child.kill('SIGTERM');
    }
  }

  function runClaude(conversation, prompt) {
    return new Promise((resolve, reject) => {
      const cli = which('claude');
      if (!cli) return reject(new Error('Claude Code CLI was not found. Install it with: npm install -g @anthropic-ai/claude-code'));
      const permissionMode = conversation.options.agentMode === 'plan'
        ? 'plan'
        : conversation.options.agentMode === 'autopilot'
          ? 'acceptEdits'
          : 'default';
      let command = cli;
      let args = ['--print', '--output-format', 'text', '--permission-mode', permissionMode];
      if (conversation.options.model) args.push('--model', conversation.options.model);
      if (conversation.options.reasoningEffort) args.push('--effort', conversation.options.reasoningEffort);
      args.push(prompt);
      if (process.platform === 'win32') {
        command = which('pwsh') || which('powershell');
        if (!command) return reject(new Error('PowerShell is required to run Claude Code workflows on Windows.'));
        const encodedPrompt = Buffer.from(prompt, 'utf8').toString('base64');
        const encodedModel = Buffer.from(conversation.options.model, 'utf8').toString('base64');
        const modelSetup = conversation.options.model
          ? `$m=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedModel}')); $claudeArgs+=@('--model',$m); `
          : '';
        const effort = conversation.options.reasoningEffort;
        const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPrompt}')); $claudeArgs=@('--print','--output-format','text','--permission-mode','${permissionMode}'); ${modelSetup}${effort ? `$claudeArgs+=@('--effort','${effort}'); ` : ''}$claudeArgs+=$p; & claude @claudeArgs; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
        args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
      }

      const child = spawn(command, args, {
        cwd: conversation.cwd,
        env: { ...subscriptionEnvironment(), ...conversation.accountEnv },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      conversation.proc = child;
      conversation.cancelled = false;
      let output = '';
      let stderr = '';
      let size = 0;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conversation.proc = null;
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => {
        stopProcess(child);
        finish(new Error('Claude Code workflow timed out after 10 minutes.'));
      }, 10 * 60 * 1000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > 10 * 1024 * 1024) {
          stopProcess(child);
          finish(new Error('Claude Code output exceeded the 10 MB workflow limit.'));
          return;
        }
        output += chunk;
        if (conversation.currentUsage) conversation.currentUsage.outputChars += chunk.length;
        emit(conversation.id, { type: 'delta', text: chunk });
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 65536) stderr += chunk.slice(0, 65536 - stderr.length);
      });
      child.once('error', (error) => finish(new Error(`Could not start Claude Code: ${error.message}`)));
      child.once('close', (code) => {
        if (conversation.cancelled) finish(new Error('Claude Code workflow was cancelled.'));
        else if (code !== 0) finish(new Error(stderr.trim() || `Claude Code exited with status ${code}.`));
        else finish(null, output.trim());
      });
    });
  }

  async function runCodex(conversation, prompt) {
    const controller = new AbortController();
    conversation.controller = controller;
    const { events } = await conversation.thread.runStreamed(prompt, { signal: controller.signal });
    for await (const event of events) {
      if (event.type === 'item.updated' || event.type === 'item.completed') {
        if (event.item.type === 'agent_message') {
          const itemId = event.item.id || 'agent-message';
          const text = String(event.item.text || '');
          const sizes = conversation.currentUsage?.outputItems;
          if (sizes) {
            sizes.set(itemId, Math.max(sizes.get(itemId) || 0, text.length));
            conversation.currentUsage.outputChars = [...sizes.values()].reduce((total, size) => total + size, 0);
          }
          emit(conversation.id, { type: 'replace', text });
        }
        else if (event.item.type === 'command_execution') emit(conversation.id, { type: 'activity', text: event.item.command });
      } else if (event.type === 'turn.failed' || event.type === 'error') {
        throw new Error(event.error?.message || event.message || 'Codex turn failed.');
      } else if (event.type === 'turn.completed' && conversation.currentUsage && event.usage) {
        const inputTokens = Number(event.usage.input_tokens ?? event.usage.inputTokens);
        const outputTokens = Number(event.usage.output_tokens ?? event.usage.outputTokens);
        if (Number.isFinite(inputTokens) && Number.isFinite(outputTokens)) {
          conversation.currentUsage.reportedInputTokens += inputTokens;
          conversation.currentUsage.reportedOutputTokens += outputTokens;
          conversation.currentUsage.reportedTokenTurns += 1;
        }
      }
    }
  }

  async function closeConversation(id) {
    const conversation = conversations.get(id);
    if (!conversation) return false;
    conversations.delete(id);
    for (const [approvalId, approval] of pendingApprovals) {
      if (approval.conversationId !== id) continue;
      clearTimeout(approval.timer);
      pendingApprovals.delete(approvalId);
      approval.resolve({ kind: 'reject', feedback: 'Agent session closed.' });
    }
    if (conversation.provider === 'copilot') {
      await conversation.client.stop();
    } else if (conversation.controller) {
      conversation.controller.abort();
    } else if (conversation.proc) {
      conversation.cancelled = true;
      stopProcess(conversation.proc);
    }
    return true;
  }

  core.onShutdown(async () => {
    for (const id of conversations.keys()) await closeConversation(id);
  });

  return {
    'agent:copilot:quota': fetchCopilotQuota,
    'agent:capacity': async () => ({
      ...getAgentCapacity(),
      activeAgents: conversations.size + creatingConversations
    }),
    'agent:accounts:list': async () => accountSnapshot(await readAccountState()),
    'agent:accounts:add': async (provider, nameValue) => {
      requireProvider(provider);
      const name = typeof nameValue === 'string' ? nameValue.trim() : '';
      if (!name || name.length > 64 || /[\u0000-\u001f]/.test(name)) {
        throw new Error('Enter an account name under 65 characters.');
      }
      const id = randomUUID();
      const directory = accountDirectory(provider, id);
      await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        return await updateAccountState((state) => {
          state.profiles[provider].push({ id, name });
          state.active[provider] = id;
          return accountSnapshot(state);
        });
      } catch (error) {
        await fsp.rm(directory, { recursive: true, force: true });
        throw error;
      }
    },
    'agent:accounts:set-active': async (provider, accountId) => {
      requireProvider(provider);
      if (typeof accountId !== 'string') throw new Error('Invalid provider account.');
      return updateAccountState(async (state) => {
        await requireAccount(state, provider, accountId);
        state.active[provider] = accountId;
        return accountSnapshot(state);
      });
    },
    'agent:accounts:environment': async (provider, accountId) => {
      requireProvider(provider);
      if (typeof accountId !== 'string') throw new Error('Invalid provider account.');
      const state = await readAccountState();
      await requireAccount(state, provider, accountId);
      return {
        env: accountEnvironment(provider, accountId),
        unsetEnv: Object.keys(process.env).filter((key) => {
          const name = key.toUpperCase();
          return API_CREDENTIALS.has(name) || /(?:^|_)(?:API_KEY|API_TOKEN|AUTH_TOKEN)$/.test(name);
        })
      };
    },
    'agent:accounts:remove': async (provider, accountId) => {
      requireProvider(provider);
      if (typeof accountId !== 'string' || accountId === 'default') throw new Error('The default CLI login cannot be removed here.');
      const state = await readAccountState();
      await requireAccount(state, provider, accountId);
      if ([...conversations.values()].some((conversation) =>
        conversation.provider === provider && conversation.accountId === accountId
      )) throw new Error('Close chats using this account before removing it.');
      await fsp.rm(accountDirectory(provider, accountId), { recursive: true, force: true });
      return updateAccountState((next) => {
        next.profiles[provider] = next.profiles[provider].filter((profile) => profile.id !== accountId);
        delete next.usage[provider][accountId];
        if (next.active[provider] === accountId) next.active[provider] = 'default';
        return accountSnapshot(next);
      });
    },
    'agent:models': async (provider, cwdValue, accountIdValue) => {
      if (provider !== 'copilot') throw new Error('Model discovery is available for Copilot; enter a model ID manually for Codex or Claude Code.');
      const state = await readAccountState();
      const accountId = typeof accountIdValue === 'string' && accountIdValue
        ? accountIdValue
        : state.active[provider];
      await requireAccount(state, provider, accountId);
      return listCopilotModels(workingDirectory(cwdValue), accountEnvironment(provider, accountId));
    },
    'agent:create': async (provider, cwdValue, optionsValue) => {
      requireProvider(provider);
      if (conversations.size + creatingConversations >= getAgentCapacity().maxConcurrentAgents) {
        throw new Error('The computer has reached its current agent concurrency capacity. Wait for an agent to finish before starting another.');
      }
      creatingConversations++;
      try {
        const cwd = workingDirectory(cwdValue);
        const options = agentOptions(provider, optionsValue);
        const accountState = await readAccountState();
        const requestedAccountId = typeof optionsValue?.accountId === 'string' && optionsValue.accountId
          ? optionsValue.accountId
          : accountState.active[provider];
        await requireAccount(accountState, provider, requestedAccountId);
        options.accountId = requestedAccountId;
        const accountEnv = accountEnvironment(provider, requestedAccountId);
        const id = randomUUID();
        const conversation = provider === 'copilot'
          ? await createCopilotConversation(id, cwd, options, accountEnv)
          : provider === 'codex'
            ? await createCodexConversation(id, cwd, options, accountEnv)
            : {
              id, provider: 'claude', cwd, options, busy: false, proc: null, cancelled: false,
              accountId: options.accountId, accountEnv, currentUsage: null
            };
        conversations.set(id, conversation);
        return { id, cwd, provider };
      } finally {
        creatingConversations--;
      }
    },
    'agent:send': async (id, prompt) => {
      const conversation = conversations.get(id);
      if (!conversation) throw new Error('Agent chat is no longer available.');
      if (conversation.busy) throw new Error('Wait for the current agent response to finish.');
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000) throw new Error('Enter a prompt under 20,000 characters.');
      conversation.busy = true;
      conversation.currentUsage = {
        inputChars: prompt.trim().length,
        outputChars: 0,
        reportedInputTokens: 0,
        reportedOutputTokens: 0,
        reportedTokenTurns: 0,
        outputItems: new Map()
      };
      emit(id, { type: 'started' });
      try {
        if (conversation.provider === 'copilot') {
          await conversation.session.sendAndWait({ prompt: prompt.trim() }, COPILOT_SEND_TIMEOUT_MS);
        } else if (conversation.provider === 'codex') {
          await runCodex(conversation, prompt.trim());
        } else {
          await runClaude(conversation, prompt.trim());
        }
      } finally {
        const turn = conversation.currentUsage;
        conversation.currentUsage = null;
        if (turn) {
          try { await recordUsage(conversation, turn); }
          catch (error) {
            core.log('error', `agent usage tracking failed: ${error.message}`, 'AGENTS');
            emit(id, { type: 'usage-error', message: 'Usage totals could not be saved.' });
          }
        }
        conversation.busy = false;
        conversation.controller = null;
      }
      emit(id, { type: 'done' });
      return true;
    },
    'agent:cancel': async (id) => {
      const conversation = conversations.get(id);
      if (!conversation || !conversation.busy) return false;
      if (conversation.provider === 'copilot') await conversation.session.abort();
      else if (conversation.controller) conversation.controller.abort();
      else if (conversation.proc) {
        conversation.cancelled = true;
        stopProcess(conversation.proc);
      }
      return true;
    },
    'agent:respond': async (approvalId, approved) => {
      const approval = pendingApprovals.get(approvalId);
      if (!approval) return false;
      pendingApprovals.delete(approvalId);
      clearTimeout(approval.timer);
      approval.resolve(approved === true
        ? { kind: 'approved' }
        : { kind: 'reject', feedback: 'The user denied this permission in PHANTOM.' });
      return true;
    },
    'agent:close': closeConversation
  };
};

module.exports.subscriptionEnvironment = subscriptionEnvironment;
module.exports.agentOptions = agentOptions;
module.exports.assistedReadApproval = assistedReadApproval;
module.exports.projectScopedApproval = projectScopedApproval;
module.exports.normalizeCopilotQuota = normalizeCopilotQuota;
