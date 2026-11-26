import { h, sep, copy } from '../core/dom.js';
import { renderMarkdown } from '../core/markdown.js';
import { call, on, bus } from '../core/api.js';
import { project } from '../core/project.js';
import { toast, fail, confirm, form as modalForm } from '../core/ui.js';
import { wm } from '../core/wm.js';

const PROVIDERS = {
  copilot: {
    name: 'GitHub Copilot',
    billing: 'GitHub Copilot subscription',
    login: 'copilot',
    install: 'npm install -g @github/copilot',
    url: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli'
  },
  codex: {
    name: 'Codex',
    billing: 'ChatGPT subscription',
    login: 'codex',
    install: 'npm install -g @openai/codex',
    url: 'https://developers.openai.com/codex/cli'
  },
  claude: {
    name: 'Claude Code',
    billing: 'Claude subscription',
    login: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    url: 'https://code.claude.com/docs/en/overview'
  }
};

const CLAUDE_API_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS'
];

export default {
  id: 'agents', title: 'Agents', icon: 'debug', desc: 'Subscription-backed coding agents', size: [760, 560], min: [450, 340],
  async create(win) {
    const root = h('div.ag-root.fill.ag-chat-root');
    let tools = {};
    let provider = 'copilot';
    let conversationId = null;
    let busy = false;
    let messages = [];
    let activeAssistant = null;
    let fileCaptureMessage = null;
    let fileCaptureUntil = 0;
    let activeAccountId = 'default';
    let enableMcp = false;
    let accountState = { providers: {}, active: {}, usage: {} };
    let showDashboard = false;
    let copilotQuotaState = { status: 'idle' };

    const projectName = h('span.ag-project-name');
    const projectLabel = h('div.ag-project', h('span.ag-project-dot'), projectName);
    const providerSelect = h('select.inp.ag-provider',
      ...Object.entries(PROVIDERS).map(([id, item]) => h('option', { value: id }, item.name))
    );
    const accountSelect = h('select.inp.ag-account', { 'aria-label': 'Active provider account' });
    const dashboardButton = h('button.btn.ghost.ag-dashboard-toggle', { type: 'button' }, 'SUBSCRIPTIONS');
    const providerNote = h('div.ag-note');
    const mcpToggle = h('input', { type: 'checkbox', 'aria-label': 'Enable Copilot MCP servers for this project' });
    const mcpOption = h('label.ag-mcp-toggle', {
      title: 'Opt in to project MCP configuration. Individual MCP tool calls still require approval.'
    }, mcpToggle, h('span', 'Enable project MCP servers'));
    const loginButton = h('button.btn.ghost.ag-login');
    const terminalButton = h('button.btn.ghost.ag-claude', { hidden: true }, 'OPEN CLAUDE CODE IN TERMINAL');
    const docsLink = h('a.ag-docs', { href: PROVIDERS.copilot.url, target: '_blank', rel: 'noreferrer' }, 'Provider docs ↗');
    const transcript = h('div.ag-transcript', {
      role: 'log',
      'aria-label': 'Agent conversation',
      'aria-live': 'polite',
      'aria-relevant': 'additions text',
      tabindex: '0'
    });
    const prompt = h('textarea.inp.ag-prompt', {
      placeholder: 'Ask about this project…',
      rows: 2,
      'aria-label': 'Message the coding agent'
    });
    const sendButton = h('button.btn.primary.ag-send', { disabled: true, type: 'button' }, 'SEND');
    const cancelButton = h('button.btn.ghost', { hidden: true }, 'STOP');
    const form = h('div.ag-compose',
      h('div.ag-compose-editor', prompt),
      h('div.ag-compose-foot',
        h('div.ag-compose-meta', mcpOption, h('span.ag-hint', 'Ctrl+Enter to send')),
        h('div.ag-compose-actions', cancelButton, sendButton)
      )
    );
    const chatView = h('div.ag-chat-view');
    const dashboard = h('div.ag-dashboard', { hidden: true });

    function renderProject() {
      projectName.textContent = project.root ? `${project.name} · ${project.root}` : 'No project open';
      projectLabel.title = project.root || 'No project open';
      projectLabel.classList.toggle('is-open', !!project.root);
      updateControls();
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

    function renderAssistantExtras(message) {
      const extras = [];
      const activities = message.activities || [];
      if (activities.length) {
        extras.push(h('details.ag-tool-activity',
          h('summary', `TOOL ACTIVITY · ${activities.length}`),
          h('div.ag-tool-list', ...activities.map((activity) =>
            h('div.ag-tool-row', h('span.ag-tool-dot'), h('code', activity))
          ))
        ));
      }
      const files = [...(message.fileChanges || [])]
        .map((path) => ({ path, relative: relativeProjectPath(path) }))
        .filter((file) => file.relative)
        .sort((a, b) => a.relative.localeCompare(b.relative));
      if (files.length) {
        extras.push(h('div.ag-change-list',
          h('div.ag-change-heading', h('span', 'FILES CHANGED'), h('span', String(files.length))),
          ...files.map(({ path, relative }) => h('div.ag-change-row',
            h('button.ag-change-file', {
              type: 'button',
              title: `Open ${relative}`,
              on: { click: () => bus.emit('open-file', path, {}) }
            }, relative),
            project.gitRoot ? h('button.ag-change-diff', {
              type: 'button',
              title: `Review diff for ${relative}`,
              on: { click: () => wm.open('diff', { state: { root: project.gitRoot, file: path } })
                .catch((error) => fail(error, 'OPEN AGENT DIFF')) }
            }, 'DIFF') : null
          ))
        ));
      }
      return extras.length ? h('div.ag-assistant-extras', ...extras) : null;
    }

    function renderAccountSelect() {
      const profiles = accountState.providers[provider] || [{ id: 'default', name: 'Default CLI login' }];
      activeAccountId = accountState.active[provider] || 'default';
      accountSelect.replaceChildren(...profiles.map((profile) =>
        h('option', { value: profile.id }, profile.name)
      ));
      accountSelect.value = activeAccountId;
    }

    function formatCount(value) {
      return new Intl.NumberFormat().format(Number(value) || 0);
    }

    function renderCopilotQuota() {
      const state = copilotQuotaState;
      const loading = state.status === 'loading';
      const refreshButton = h('button.btn.ghost', { type: 'button', disabled: loading }, loading ? 'CHECKING…' : 'REFRESH');
      refreshButton.addEventListener('click', refreshCopilotQuota);
      let details;
      if (loading) {
        details = h('div.ag-copilot-quota-status', 'Checking GitHub Copilot quota…');
      } else if (state.status === 'error') {
        details = h('div.ag-copilot-quota-status.error', `Quota unavailable: ${state.message}`);
      } else if (state.status === 'ready') {
        const { data } = state;
        const windows = data.windows.map((quota) => {
          let value = 'Quota details unavailable';
          if (quota.unlimited) value = 'Unlimited';
          else if (quota.remaining !== null && quota.entitlement !== null) {
            value = `${formatCount(quota.remaining)} / ${formatCount(quota.entitlement)} remaining`;
            if (quota.percentRemaining !== null) value += ` (${Math.round(quota.percentRemaining)}%)`;
            if (quota.overage > 0) value += ` · ${formatCount(quota.overage)} over quota`;
          } else if (quota.remaining !== null) value = `${formatCount(quota.remaining)} remaining`;
          else if (quota.percentRemaining !== null) value = `${Math.round(quota.percentRemaining)}% remaining`;
          return h('span.ag-copilot-quota-window', `${quota.label}: ${value}`);
        });
        const account = data.login ? `GitHub account: @${data.login}` : 'GitHub CLI authenticated account';
        const plan = data.plan ? ` · Plan: ${data.plan}` : '';
        const resetTime = data.resetAt && Number.isFinite(Date.parse(data.resetAt))
          ? ` · Resets ${new Date(data.resetAt).toLocaleString()}`
          : '';
        details = h('div.ag-copilot-quota-details',
          h('div.ag-copilot-quota-meta', `${account}${plan}${resetTime}`),
          h('div.ag-copilot-quota-windows', ...windows)
        );
      } else {
        details = h('div.ag-copilot-quota-status', 'Quota has not been checked yet.');
      }
      return h('div.ag-copilot-quota',
        h('div.ag-copilot-quota-head', h('b', 'GitHub Copilot plan quota'), refreshButton),
        details
      );
    }

    async function refreshCopilotQuota() {
      if (copilotQuotaState.status === 'loading') return;
      copilotQuotaState = { status: 'loading' };
      renderDashboard();
      try {
        const data = await call('agent:copilot:quota');
        copilotQuotaState = data.available
          ? { status: 'ready', data }
          : { status: 'error', message: data.message };
      } catch (error) {
        fail(error, 'COPILOT QUOTA');
        copilotQuotaState = { status: 'error', message: error.message };
      }
      renderDashboard();
    }

    function renderDashboard() {
      dashboard.replaceChildren(
        h('div.ag-dashboard-note',
          'PHANTOM tracks its own agent requests and characters. Copilot quota is fetched for the account signed in with GitHub CLI (gh); it may differ from the accounts saved for Copilot CLI.'
        )
      );
      for (const [providerId, item] of Object.entries(PROVIDERS)) {
        const profiles = accountState.providers[providerId] || [{ id: 'default', name: 'Default CLI login' }];
        const input = h('input.inp.ag-account-name', { maxLength: 64, placeholder: 'Account name' });
        const addButton = h('button.btn.ghost', { type: 'button' }, 'ADD ACCOUNT');
        const section = h('section.ag-provider-accounts',
          h('div.ag-provider-accounts-head',
            h('div', h('b', item.name), h('span', item.billing)),
            h('div.ag-add-account', input, addButton)
          ),
          ...(providerId === 'copilot' ? [renderCopilotQuota()] : []),
          h('div.ag-account-cards')
        );
        const cards = section.querySelector('.ag-account-cards');
        addButton.addEventListener('click', () => addAccount(providerId, input));
        for (const profile of profiles) {
          const usage = accountState.usage?.[providerId]?.[profile.id] || {};
          const isActive = accountState.active[providerId] === profile.id;
          const tokensReported = Number(usage.reportedTokenTurns) > 0;
          const accountCard = h('article.ag-subscription-card',
            h('div.ag-subscription-head',
              h('b', profile.name),
              h(`span.ag-account-state${isActive ? '.active' : ''}`, isActive ? 'ACTIVE' : 'SAVED')
            ),
            h('div.ag-usage-stats',
              h('span', `${formatCount(usage.requests)} PHANTOM requests`),
              h('span', `Input ${formatCount(usage.inputChars)} chars · output ${formatCount(usage.outputChars)} chars`),
              h('span', tokensReported
                ? `Provider-reported tokens: ${formatCount(usage.reportedInputTokens)} input · ${formatCount(usage.reportedOutputTokens)} output`
                : 'Provider token totals are not reported by this CLI.')
            ),
            h('div.ag-subscription-actions')
          );
          const actions = accountCard.querySelector('.ag-subscription-actions');
          if (!isActive) {
            const useButton = h('button.btn.ghost', { type: 'button' }, 'USE ACCOUNT');
            useButton.addEventListener('click', () => setActiveAccount(providerId, profile.id));
            actions.append(useButton);
          }
          const signIn = h('button.btn.ghost', { type: 'button' }, 'SIGN IN');
          signIn.addEventListener('click', () => signInAccount(providerId, profile.id));
          actions.append(signIn);
          if (profile.id !== 'default') {
            const remove = h('button.btn.ghost.ag-remove-account', { type: 'button' }, 'REMOVE');
            remove.addEventListener('click', () => removeAccount(providerId, profile));
            actions.append(remove);
          }
          cards.append(accountCard);
        }
        dashboard.append(section);
      }
    }

    async function refreshAccountState() {
      accountState = await call('agent:accounts:list');
      renderAccountSelect();
      renderDashboard();
      updateControls();
    }

    function updateControls() {
      const item = PROVIDERS[provider];
      providerNote.textContent = provider === 'claude'
        ? 'Claude Code runs in its own project terminal. Sign in with your Claude subscription; PHANTOM clears API-key and alternate-provider variables but uses Claude Code’s saved login.'
        : `${item.name} uses ${item.billing} through your saved sign-in. Use a subscription login; PHANTOM removes API-key environment variables and does not request or store provider API keys.${tools[item.login] ? '' : ` Install ${item.name} CLI to sign in with: ${item.install}`}`;
      providerNote.title = item.url;
      docsLink.href = item.url;
      form.hidden = provider === 'claude';
      terminalButton.hidden = provider !== 'claude';
      loginButton.hidden = provider === 'claude';
      loginButton.textContent = `SIGN IN WITH ${provider === 'codex' ? 'CHATGPT' : 'GITHUB'}`;
      loginButton.disabled = busy || !tools[item.login];
      terminalButton.disabled = busy || !tools.claude;
      sendButton.disabled = busy || provider === 'claude' || !project.root || !prompt.value.trim();
      mcpOption.hidden = provider !== 'copilot';
      mcpToggle.checked = enableMcp;
      mcpToggle.disabled = busy || !!conversationId || provider !== 'copilot';
      cancelButton.hidden = !busy;
      providerSelect.disabled = busy;
      accountSelect.disabled = busy;
      dashboardButton.textContent = showDashboard ? 'BACK TO CHAT' : 'SUBSCRIPTIONS';
    }

    function renderMessages() {
      transcript.replaceChildren();
      if (!messages.length) {
        transcript.appendChild(h('div.ag-empty',
          h('span.ag-empty-mark', 'AI'),
          h('b', 'Start a conversation'),
          h('span', `Ask ${PROVIDERS[provider].name} about your project.`),
          h('span.ag-empty-hint', project.root
            ? 'Your active project is available as context.'
            : 'Open a project to give your agent codebase context.')
        ));
      } else {
        for (const message of messages) {
          const text = message.text || (message.role === 'assistant' ? 'Working…' : '');
          const content = message.role === 'assistant'
            ? h('div.ag-text.ag-markdown', { html: renderMarkdown(text) })
            : h('pre.ag-text', text);
          transcript.appendChild(h(`div.ag-message.${message.role}`,
            h('span.ag-message-avatar', message.role === 'user' ? 'YOU' : 'AI'),
            h('div.ag-message-content',
              h('div.ag-message-meta',
                h('span.ag-role', message.role === 'user' ? 'YOU' : PROVIDERS[provider].name),
                message.role === 'assistant' && busy && message === activeAssistant
                  ? h('span.ag-message-state', 'RESPONDING')
                  : null,
                message.role === 'assistant' && message.text
                  ? h('button.ag-copy-response', {
                    type: 'button',
                    title: 'Copy response',
                    on: { click: () => copy(message.text).catch((error) => fail(error, 'COPY AGENT RESPONSE')) }
                  }, 'COPY')
                  : null
              ),
              content,
              message.role === 'assistant' ? renderAssistantExtras(message) : null
            )
          ));
        }
      }
      transcript.scrollTop = transcript.scrollHeight;
    }

    function resizePrompt() {
      prompt.style.height = 'auto';
      prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`;
    }

    function appendAssistant() {
      activeAssistant = { role: 'assistant', text: '', activities: [], fileChanges: new Set() };
      fileCaptureMessage = activeAssistant;
      messages.push(activeAssistant);
      renderMessages();
    }

    async function resetConversation() {
      const previous = conversationId;
      conversationId = null;
      messages = [];
      activeAssistant = null;
      fileCaptureMessage = null;
      fileCaptureUntil = 0;
      renderMessages();
      if (previous) {
        try { await call('agent:close', previous); }
        catch (error) { fail(error, 'CLOSE AGENT CHAT'); }
      }
    }

    async function setActiveAccount(accountProvider, accountId) {
      try {
        accountState = await call('agent:accounts:set-active', accountProvider, accountId);
        renderAccountSelect();
        renderDashboard();
        if (accountProvider === provider) await resetConversation();
        updateControls();
      } catch (error) { fail(error, 'SELECT PROVIDER ACCOUNT'); }
    }

    async function signInAccount(accountProvider, accountId) {
      const item = PROVIDERS[accountProvider];
      if (!tools[item.login]) {
        toast(`${item.name} CLI was not found. Install it with: ${item.install}`, 'warn');
        return;
      }
      try {
        let copilotLoginMethod = '';
        if (accountProvider === 'copilot') {
          const selection = await modalForm('GITHUB COPILOT SIGN-IN', [
            {
              key: 'method',
              label: 'Choose how to authenticate',
              type: 'select',
              value: 'device-code',
              options: [
                { value: 'device-code', label: 'Device code (default)' },
                { value: 'web-flow', label: 'Browser sign-in' }
              ]
            }
          ], { ok: 'CONTINUE', width: 420 });
          if (!selection) return;
          copilotLoginMethod = selection.method;
        }
        const { env, unsetEnv } = await call('agent:accounts:environment', accountProvider, accountId);
        const terminal = await wm.open('terminal', {
          state: {
            cwd: project.root || undefined,
            title: `${item.name} · ${accountId === 'default' ? 'Default login' : 'Account sign-in'}`,
            env, unsetEnv
          }
        });
        if (!terminal?.instance?.exec) throw new Error('Could not open a terminal');
        const command = accountProvider === 'claude'
          ? 'claude auth login'
          : accountProvider === 'copilot'
            ? `copilot login --${copilotLoginMethod}`
            : `${item.login} login`;
        if (!(await terminal.instance.exec(command))) throw new Error('Could not start the provider sign-in command.');
      } catch (error) { fail(error, 'PROVIDER SIGN-IN'); }
    }

    async function addAccount(accountProvider, nameInput) {
      const existing = accountState.providers[accountProvider] || [];
      const name = nameInput.value.trim() || `Account ${existing.filter((profile) => profile.id !== 'default').length + 1}`;
      try {
        accountState = await call('agent:accounts:add', accountProvider, name);
        nameInput.value = '';
        renderAccountSelect();
        renderDashboard();
        updateControls();
        toast(`${name} profile created. Sign in to connect it.`, 'info', 'SUBSCRIPTION ACCOUNT');
        await signInAccount(accountProvider, accountState.active[accountProvider]);
      } catch (error) { fail(error, 'ADD SUBSCRIPTION ACCOUNT'); }
    }

    async function removeAccount(accountProvider, profile) {
      if (!(await confirm(
        'REMOVE SUBSCRIPTION ACCOUNT',
        `Remove "${profile.name}" and delete its isolated sign-in data from PHANTOM?`,
        { ok: 'REMOVE', danger: true }
      ))) return;
      try {
        accountState = await call('agent:accounts:remove', accountProvider, profile.id);
        renderAccountSelect();
        renderDashboard();
        updateControls();
      } catch (error) { fail(error, 'REMOVE SUBSCRIPTION ACCOUNT'); }
    }

    async function launchClaude() {
      if (!project.root) {
        toast('Open a project before launching Claude Code.', 'warn');
        return;
      }
      if (!tools.claude) {
        toast(`Claude Code CLI was not found. Install it with: ${PROVIDERS.claude.install}`, 'warn');
        return;
      }
      try {
        const { env, unsetEnv } = await call('agent:accounts:environment', 'claude', activeAccountId);
        const terminal = await wm.open('terminal', {
          state: { cwd: project.root, title: `Claude Code · ${project.name || 'Agent session'}`, env, unsetEnv }
        });
        if (!terminal?.instance?.exec) throw new Error('Could not open a terminal');
        await terminal.instance.exec((kind) => {
          if (kind === 'pwsh' || kind === 'powershell') {
            return `${CLAUDE_API_ENV.map((key) => `$env:${key}=$null`).join('; ')}; claude --permission-mode default`;
          }
          if (kind === 'cmd') {
            return `${CLAUDE_API_ENV.map((key) => `set "${key}="`).join(' && ')} && claude --permission-mode default`;
          }
          return `env ${CLAUDE_API_ENV.map((key) => `-u ${key}`).join(' ')} claude --permission-mode default`;
        });
      } catch (error) { fail(error, 'LAUNCH CLAUDE CODE'); }
    }

    async function send() {
      const text = prompt.value.trim();
      if (!text || busy || provider === 'claude') return;
      fileCaptureMessage = null;
      fileCaptureUntil = 0;
      messages.push({ role: 'user', text });
      prompt.value = '';
      resizePrompt();
      activeAssistant = null;
      busy = true;
      updateControls();
      renderMessages();
      try {
        appendAssistant();
        if (!conversationId) {
          const created = await call('agent:create', provider, project.root, {
            accountId: activeAccountId, enableMcp
          });
          conversationId = created.id;
        }
        await call('agent:send', conversationId, text);
      } catch (error) {
        if (activeAssistant && !activeAssistant.text) {
          activeAssistant.text = `Error: ${error.message}`;
          renderMessages();
        } else {
          messages.push({ role: 'assistant', text: `Error: ${error.message}` });
          renderMessages();
        }
      } finally {
        busy = false;
        updateControls();
        prompt.focus();
      }
    }

    const offEvent = on('agent:event', (event) => {
      if (!conversationId || event.conversationId !== conversationId) return;
      if (event.type === 'started') {
        return;
      } else if (event.type === 'delta') {
        if (!activeAssistant) appendAssistant();
        activeAssistant.text += event.text;
        renderMessages();
      } else if (event.type === 'replace') {
        if (!activeAssistant) appendAssistant();
        activeAssistant.text = event.text || '';
        renderMessages();
      } else if (event.type === 'activity') {
        if (!activeAssistant) appendAssistant();
        const activity = String(event.text || '').trim();
        if (activity && activeAssistant.activities.at(-1) !== activity) activeAssistant.activities.push(activity);
        renderMessages();
      } else if (event.type === 'done') {
        fileCaptureUntil = Date.now() + 400;
        if (activeAssistant && !activeAssistant.text) activeAssistant.text = 'Done.';
        renderMessages();
      } else if (event.type === 'permission') {
        confirm(
          `COPILOT PERMISSION: ${String(event.kind).toUpperCase()}`,
          h('div.ag-permission', { tabindex: '0' }, event.details),
          { ok: 'ALLOW ONCE', danger: true }
        ).then((approved) => call('agent:respond', event.approvalId, approved))
          .catch((error) => fail(error, 'COPILOT PERMISSION'));
      } else if (event.type === 'usage-error') {
        fail(new Error(event.message || 'Usage totals could not be saved.'), 'USAGE TRACKING');
      }
    });

    const offFileChanges = bus.on('fs:changed', (paths) => {
      if (!fileCaptureMessage || (!busy && Date.now() > fileCaptureUntil) || !Array.isArray(paths)) return;
      let changed = false;
      for (const filePath of paths) {
        if (relativeProjectPath(filePath) && !fileCaptureMessage.fileChanges.has(filePath)) {
          fileCaptureMessage.fileChanges.add(filePath);
          changed = true;
        }
      }
      if (changed) renderMessages();
    });

    providerSelect.addEventListener('change', async () => {
      provider = providerSelect.value;
      renderAccountSelect();
      await resetConversation();
      updateControls();
    });
    accountSelect.addEventListener('change', () => setActiveAccount(provider, accountSelect.value));
    dashboardButton.addEventListener('click', () => {
      showDashboard = !showDashboard;
      chatView.hidden = showDashboard;
      dashboard.hidden = !showDashboard;
      updateControls();
      if (showDashboard && copilotQuotaState.status === 'idle') refreshCopilotQuota();
    });
    prompt.addEventListener('input', () => {
      resizePrompt();
      updateControls();
    });
    prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.ctrlKey) {
        event.preventDefault();
        send();
      }
    });
    sendButton.addEventListener('click', send);
    mcpToggle.addEventListener('change', () => { enableMcp = mcpToggle.checked; });
    cancelButton.addEventListener('click', () => {
      if (conversationId) call('agent:cancel', conversationId).catch((error) => fail(error, 'STOP AGENT'));
    });
    loginButton.addEventListener('click', () => signInAccount(provider, activeAccountId));
    terminalButton.addEventListener('click', launchClaude);
    chatView.append(
      providerNote,
      transcript,
      form,
      h('details.ag-security',
        h('summary', 'About permissions and billing'),
        h('span', 'Subscription quota appears in the dashboard when available. Copilot quota reflects the account signed in with GitHub CLI (gh), not necessarily each saved Copilot profile.')
      )
    );

    root.append(
      h('div.ag-head',
        h('div.ag-head-main',
          h('div.ag-eyebrow', 'PHANTOM · AGENT CHAT'),
          h('h2', 'Coding agents'),
          h('span.ag-head-caption', 'A focused workspace for thinking through and changing your project.')
        ),
        projectLabel
      ),
      h('div.ag-toolbar',
        h('div.ag-toolbar-selects', providerSelect, accountSelect),
        h('div.ag-toolbar-actions', loginButton, terminalButton, dashboardButton, docsLink)
      ),
      chatView,
      dashboard
    );
    win.body.appendChild(root);

    async function refresh() {
      try {
        const info = await call('app:info');
        tools = info.tools || {};
      } catch (error) { fail(error, 'AGENT AVAILABILITY'); }
      try { await refreshAccountState(); }
      catch (error) { fail(error, 'SUBSCRIPTION ACCOUNTS'); }
      renderProject();
    }

    const offProject = bus.on('project:changed', () => {
      renderProject();
      resetConversation();
    });
    const offAccounts = on('agent:accounts:changed', (state) => {
      accountState = state;
      renderAccountSelect();
      renderDashboard();
      updateControls();
    });
    await refresh();
    updateControls();
    renderMessages();

    return {
      destroy() {
        offEvent();
        offProject();
        offAccounts();
        offFileChanges();
        if (conversationId) call('agent:close', conversationId).catch((error) => fail(error, 'CLOSE AGENT CHAT'));
      }
    };
  }
};
