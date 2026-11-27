import fs from 'node:fs/promises';
import path from 'node:path';
import declaration from './extension.json' with { type: 'json' };
import { CanvasError, createCanvas, joinSession } from '@github/copilot-sdk/extension';
import { readState, writeState } from './storage.mjs';
import { createDashboardServer, serverUrl } from './server.mjs';

const canvasId = 'phantom-project-dashboard';
const instances = new Map();

function objectInput(input) {
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
}

function workspaceRoot(input) {
  const value = objectInput(input).workspaceRoot;
  return typeof value === 'string' && value.trim() ? path.resolve(value.trim()) : process.cwd();
}

async function snapshot(root) {
  let branch = '';
  let changedFiles = 0;
  let packageScripts = 0;

  try {
    const gitHead = await fs.readFile(path.join(root, '.git', 'HEAD'), 'utf8');
    branch = gitHead.startsWith('ref:')
      ? gitHead.slice(4).trim().replace(/^refs\/heads\//, '')
      : gitHead.trim().slice(0, 12);
  } catch {}

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    changedFiles = entries.filter(entry => entry.name === '.phantom'
      || entry.name === 'node_modules'
      || entry.name === 'package-lock.json'
      || entry.name === 'package.json').length;
  } catch {}

  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    packageScripts = Object.keys(packageJson.scripts || {}).length;
  } catch {}

  return { workspaceRoot: root, branch: branch || 'unknown', changedFiles, packageScripts };
}

async function getInstance(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance) throw new CanvasError('CANVAS_NOT_OPEN', 'Canvas instance is not open');
  return instance;
}

async function open({ instanceId, input }) {
  try {
    const existing = instances.get(instanceId);
    if (existing) {
      existing.root = workspaceRoot(input);
      existing.state = await readState(canvasId, existing.root);
      return await serverUrl(existing.server);
    }

    const root = workspaceRoot(input);
    const state = await readState(canvasId, root);
    const record = {
      root,
      state,
      server: null
    };
    record.server = createDashboardServer({
      getSnapshot: () => snapshot(record.root),
      getState: () => readState(canvasId, record.root),
      onAddNote: async text => {
        record.state = await readState(canvasId, record.root);
        record.state.notes.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text,
          createdAt: new Date().toISOString()
        });
        await writeState(canvasId, record.state);
      }
    });
    instances.set(instanceId, record);
    return await serverUrl(record.server);
  } catch (error) {
    throw error instanceof CanvasError
      ? error
      : new CanvasError('DASHBOARD_OPEN_FAILED', `Could not open dashboard: ${error.message}`);
  }
}

const actionHandlers = {
  refresh: async ({ instanceId }) => {
    try {
      const instance = await getInstance(instanceId);
      return await snapshot(instance.root);
    } catch (error) {
      throw error instanceof CanvasError
        ? error
        : new CanvasError('DASHBOARD_REFRESH_FAILED', error.message);
    }
  },
  add_note: async ({ instanceId, input }) => {
    try {
      const instance = await getInstance(instanceId);
      const text = input && typeof input.text === 'string' ? input.text.trim() : '';
      if (!text || text.length > 500) {
        throw new CanvasError('INVALID_NOTE', 'Note text must be 1 to 500 characters');
      }
      instance.state = await readState(canvasId, instance.root);
      instance.state.notes.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text,
        createdAt: new Date().toISOString()
      });
      await writeState(canvasId, instance.state);
      return { ok: true, noteCount: instance.state.notes.length };
    } catch (error) {
      throw error instanceof CanvasError
        ? error
        : new CanvasError('DASHBOARD_NOTE_FAILED', error.message);
    }
  }
};

const canvases = declaration.canvases.map(canvas => createCanvas({
  ...canvas,
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', description: 'Workspace directory for this dashboard.' }
    },
    additionalProperties: false
  },
  actions: canvas.actions.map(action => ({
    ...action,
    handler: actionHandlers[action.name]
  })),
  open,
  onClose: async ({ instanceId }) => {
    const instance = instances.get(instanceId);
    if (!instance) return;
    await new Promise(resolve => instance.server.close(resolve));
    instances.delete(instanceId);
  }
}));

await joinSession({ canvases });
