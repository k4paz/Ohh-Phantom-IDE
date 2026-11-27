import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const FORMAT = 'phantom-project-dashboard-state';
const VERSION = 1;

function copilotHome() {
  return process.env.COPILOT_HOME && process.env.COPILOT_HOME.trim()
    ? process.env.COPILOT_HOME
    : path.join(os.homedir(), '.copilot');
}

export function workspaceDataDir(canvasId) {
  return path.join(copilotHome(), 'extension-data', canvasId);
}

function safeWorkspaceKey(workspaceRoot) {
  const base = workspaceRoot ? workspaceRoot : 'default';
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'default';
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
    if (!validState(state)) {
      throw new Error(`Unrecognized or invalid state format in ${file}`);
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') {
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
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temp, file);
}
