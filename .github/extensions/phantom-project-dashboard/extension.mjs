import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import declaration from './extension.json' with { type: 'json' };
import { CanvasError, createCanvas, joinSession } from '@github/copilot-sdk/extension';
import { readState, updateState } from './storage.mjs';
import { createDashboardServer, serverUrl } from './server.mjs';

const canvasId = 'phantom-project-dashboard';
const instances = new Map();
const execFileAsync = promisify(execFile);

function objectInput(input) {
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
}

function workspaceRoot(input) {
  const value = objectInput(input).workspaceRoot;
  return typeof value === 'string' && value.trim() ? path.resolve(value.trim()) : process.cwd();
}

async function snapshot(root) {
  let branch = '';
  let changedFiles = 'unknown';
  let packageScripts = 0;

  try {
    const gitHead = await fs.readFile(path.join(root, '.git', 'HEAD'), 'utf8');
    branch = gitHead.startsWith('ref:')
      ? gitHead.slice(4).trim().replace(/^refs\/heads\//, '')
      : gitHead.trim().slice(0, 12);
  } catch {}

  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: root,
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    changedFiles = stdout.split(/\r?\n/).filter(Boolean).length;
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
      return await serverUrl(existing.server, existing.accessToken);
    }

    const root = workspaceRoot(input);
    const state = await readState(canvasId, root);
    const accessToken = randomBytes(32).toString('base64url');
    const record = {
      root,
      state,
      server: null,
      accessToken
    };
    record.server = createDashboardServer({
      getSnapshot: () => snapshot(record.root),
      getState: () => readState(canvasId, record.root),
      accessToken,
      onAddNote: async text => {
        record.state = await updateState(canvasId, record.root, state => {
          state.notes.push({
            id: randomUUID(),
            text,
            createdAt: new Date().toISOString()
          });
        });
      }
    });
    instances.set(instanceId, record);
    return await serverUrl(record.server, record.accessToken);
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
      instance.state = await updateState(canvasId, instance.root, state => {
        state.notes.push({
          id: randomUUID(),
          text,
          createdAt: new Date().toISOString()
        });
      });
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
