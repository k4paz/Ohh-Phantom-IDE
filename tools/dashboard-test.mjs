import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readState, updateState, workspaceDataDir } from '../.github/extensions/phantom-project-dashboard/storage.mjs';
import { createDashboardServer, serverUrl } from '../.github/extensions/phantom-project-dashboard/server.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-dashboard-test-'));
const previousHome = process.env.COPILOT_HOME;
process.env.COPILOT_HOME = dataDir;

try {
  const suffix = `${'s'.repeat(130)}-workspace`;
  const rootA = path.resolve(`${'a'.repeat(10)}-${suffix}`);
  const rootB = path.resolve(`${'b'.repeat(10)}-${suffix}`);
  const canvasId = 'phantom-project-dashboard-test';
  const legacyCanvasId = 'phantom-project-dashboard-legacy-test';
  const legacyDir = workspaceDataDir(legacyCanvasId);
  const legacyKey = rootA.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'default';
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(path.join(legacyDir, `${legacyKey}.json`), JSON.stringify({
    format: 'phantom-project-dashboard-state',
    version: 1,
    workspaceRoot: rootA,
    notes: [{ id: 'legacy', text: 'preserved note', createdAt: 'now' }]
  }));
  assert.equal((await readState(legacyCanvasId, rootA)).notes[0].text, 'preserved note');
  assert.equal((await readState(legacyCanvasId, rootB)).notes.length, 0,
    'legacy filename collisions must not expose another workspace notes');

  await Promise.all([
    updateState(canvasId, rootA, state => { state.notes.push({ id: 'a', text: 'workspace A', createdAt: 'now' }); }),
    updateState(canvasId, rootB, state => { state.notes.push({ id: 'b', text: 'workspace B', createdAt: 'now' }); })
  ]);
  assert.equal((await readState(canvasId, rootA)).notes[0].text, 'workspace A');
  assert.equal((await readState(canvasId, rootB)).notes[0].text, 'workspace B');

  await Promise.all(Array.from({ length: 30 }, (_, index) =>
    updateState(canvasId, rootA, state => {
      state.notes.push({ id: String(index), text: `note-${index}`, createdAt: 'now' });
    })
  ));
  assert.equal((await readState(canvasId, rootA)).notes.length, 31, 'concurrent note updates should not overwrite each other');

  const token = 'dashboard-test-secret';
  const server = createDashboardServer({
    accessToken: token,
    getSnapshot: async () => ({ workspaceRoot: rootA, changedFiles: 0 }),
    getState: async () => readState(canvasId, rootA),
    onAddNote: async text => updateState(canvasId, rootA, state => {
      state.notes.push({ id: `http-${state.notes.length}`, text, createdAt: 'now' });
    })
  });
  try {
    const pageUrl = await serverUrl(server, token);
    const origin = new URL(pageUrl).origin;
    const unauthorized = await fetch(`${origin}/api/state`);
    assert.equal(unauthorized.status, 403, 'dashboard state should require its instance token');

    const authorized = await fetch(`${origin}/api/state`, {
      headers: { 'X-Phantom-Token': token }
    });
    assert.equal(authorized.status, 200);

    const crossOrigin = await fetch(`${origin}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Phantom-Token': token, Origin: 'https://attacker.invalid' },
      body: JSON.stringify({ text: 'blocked' })
    });
    assert.equal(crossOrigin.status, 403, 'cross-origin note writes should be rejected');

    const noOrigin = await fetch(`${origin}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Phantom-Token': token },
      body: JSON.stringify({ text: 'blocked' })
    });
    assert.equal(noOrigin.status, 403, 'note writes without an Origin should be rejected');

    const wrongType = await fetch(`${origin}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Phantom-Token': token, Origin: origin },
      body: '{"text":"blocked"}'
    });
    assert.equal(wrongType.status, 415, 'note writes should require JSON');

    const tooLarge = await fetch(`${origin}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Phantom-Token': token, Origin: origin },
      body: JSON.stringify({ text: 'x'.repeat(3000) })
    });
    assert.equal(tooLarge.status, 413, 'oversized note requests should be rejected');

    const added = await fetch(`${origin}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Phantom-Token': token, Origin: origin },
      body: JSON.stringify({ text: 'authorized note' })
    });
    assert.equal(added.status, 201);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
} finally {
  if (previousHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = previousHome;
  await fs.rm(dataDir, { recursive: true, force: true });
}

console.log('Dashboard: workspace isolation, concurrent updates, token/Origin authorization, and body limits passed.');
