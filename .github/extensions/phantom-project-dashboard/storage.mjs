import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const FORMAT = 'phantom-project-dashboard-state';
const VERSION = 1;
const writes = new Map();

function copilotHome() {
  return process.env.COPILOT_HOME && process.env.COPILOT_HOME.trim()
    ? process.env.COPILOT_HOME
    : path.join(os.homedir(), '.copilot');
}

export function workspaceDataDir(canvasId) {
  return path.join(copilotHome(), 'extension-data', canvasId);
}

function safeWorkspaceKey(workspaceRoot) {
  const normalized = normalizeWorkspaceRoot(workspaceRoot);
  return createHash('sha256').update(normalized).digest('hex');
}

function legacyWorkspaceKey(workspaceRoot) {
  const base = workspaceRoot ? workspaceRoot : 'default';
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'default';
}

function normalizeWorkspaceRoot(workspaceRoot) {
  const root = workspaceRoot ? path.resolve(workspaceRoot) : '';
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

function fileFor(canvasId, workspaceRoot) {
  return path.join(workspaceDataDir(canvasId), `${safeWorkspaceKey(workspaceRoot)}.json`);
}

function validState(value) {
  return value
    && value.format === FORMAT
    && value.version === VERSION
    && typeof value.workspaceRoot === 'string'
    && Array.isArray(value.notes)
    && value.notes.every(note => typeof note.id === 'string'
      && typeof note.text === 'string'
      && typeof note.createdAt === 'string');
}

export async function readState(canvasId, workspaceRoot) {
  const dir = workspaceDataDir(canvasId);
  await fs.mkdir(dir, { recursive: true });
  const file = fileFor(canvasId, workspaceRoot);

  try {
    const raw = await fs.readFile(file, 'utf8');
    const state = JSON.parse(raw);
    if (!validState(state) || normalizeWorkspaceRoot(state.workspaceRoot) !== normalizeWorkspaceRoot(workspaceRoot)) {
      throw new Error(`Unrecognized or invalid state format in ${file}`);
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') {
      const legacyFile = path.join(dir, `${legacyWorkspaceKey(workspaceRoot)}.json`);
      if (legacyFile !== file) {
        try {
          const legacy = JSON.parse(await fs.readFile(legacyFile, 'utf8'));
          if (!validState(legacy)) throw new Error(`Unrecognized or invalid state format in ${legacyFile}`);
          if (normalizeWorkspaceRoot(legacy.workspaceRoot) === normalizeWorkspaceRoot(workspaceRoot)) return legacy;
        } catch (legacyError) {
          if (legacyError.code !== 'ENOENT') throw legacyError;
        }
      }
      return {
        format: FORMAT,
        version: VERSION,
        workspaceRoot: workspaceRoot || '',
        notes: []
      };
    }
    throw error;
  }
}

export async function writeState(canvasId, state) {
  const dir = workspaceDataDir(canvasId);
  await fs.mkdir(dir, { recursive: true });
  const file = fileFor(canvasId, state.workspaceRoot);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.rename(temp, file);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

export async function updateState(canvasId, workspaceRoot, mutate) {
  const file = fileFor(canvasId, workspaceRoot);
  const previous = writes.get(file) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const state = await readState(canvasId, workspaceRoot);
    await mutate(state);
    await writeState(canvasId, state);
    return state;
  });
  writes.set(file, next);
  try {
    return await next;
  } finally {
    if (writes.get(file) === next) writes.delete(file);
  }
}
