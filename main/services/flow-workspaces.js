'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { randomUUID, createHash } = require('crypto');
const { getAgentCapacity } = require('./flow-capacity');

const WORKSPACE_DIR = 'agent-flow-workspaces';
const WORKSPACE_PREFIX = 'phantom-agent-flow-';

function internalProjectPath(relative) {
  const parts = relative.split(path.sep);
  return parts[0]?.toLowerCase() === '.phantom' && parts[1]?.toLowerCase() === 'agent-flow.json';
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateProjectRoot(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Open a project before creating an isolated worker.');
  const root = fs.realpathSync(path.resolve(value));
  if (!fs.statSync(root).isDirectory()) throw new Error('The active project path is not a directory.');
  return root;
}

function manifestDirectory(core) {
  return path.join(core.dataDir, WORKSPACE_DIR);
}

async function ensureManifestDirectory(core) {
  const directory = manifestDirectory(core);
  await fsp.mkdir(directory, { recursive: true });
  const stat = await fsp.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Agent Flow workspace metadata must be stored in a real directory.');
  return directory;
}

async function fileMap(root) {
  const files = new Map();
  async function visit(directory, relative = '') {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.toLowerCase() === '.git') continue;
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (internalProjectPath(childRelative)) continue;
      const absolute = path.join(directory, entry.name);
      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) {
        files.set(childRelative, { type: 'link', target: await fsp.readlink(absolute) });
      } else if (stat.isDirectory()) {
        await visit(absolute, childRelative);
      } else if (stat.isFile()) {
        const digest = createHash('sha256');
        await new Promise((resolve, reject) => {
          const stream = fs.createReadStream(absolute);
          stream.on('data', (chunk) => digest.update(chunk));
          stream.on('error', reject);
          stream.on('end', resolve);
        });
        files.set(childRelative, { type: 'file', hash: digest.digest('hex'), mode: stat.mode & 0o777 });
      }
    }
  }
  await visit(root);
  return files;
}

function mapsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [relative, entry] of left) {
    if (JSON.stringify(entry) !== JSON.stringify(right.get(relative) || null)) return false;
  }
  return true;
}

async function copyProject(sourceRoot, targetRoot) {
  await fsp.cp(sourceRoot, targetRoot, {
    recursive: true,
    errorOnExist: true,
    filter: (source) => {
      const relative = path.relative(sourceRoot, source);
      if (relative.split(path.sep).some((part) => part.toLowerCase() === '.git')) return false;
      if (internalProjectPath(relative)) return false;
      try { return !fs.lstatSync(source).isSymbolicLink(); }
      catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }
  });
}

function equalEntry(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\0')) return false;
  const segments = value.split(/[\\/]+/);
  return segments.every((segment) => segment && segment !== '.' && segment !== '..') &&
    !segments.some((segment) => segment.toLowerCase() === '.git');
}

function pathConflict(message) {
  const error = new Error(message);
  error.code = 'FLOW_PATH_CONFLICT';
  return error;
}

async function inspectTarget(root, relative) {
  if (!safeRelativePath(relative)) throw new Error(`Worker returned an unsafe path: ${relative}`);
  const segments = relative.split(/[\\/]+/);
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    if (!within(root, current)) throw new Error(`Worker returned an unsafe path: ${relative}`);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) throw pathConflict(`Integration refused to follow a project symlink: ${relative}`);
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw new Error(`Integration path is not a directory: ${relative}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return current;
}

async function readManifest(core, id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid Agent Flow workspace ID.');
  const directory = await ensureManifestDirectory(core);
  const file = path.join(directory, `${id}.json`);
  const stat = await fsp.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Agent Flow workspace metadata is not a regular file.');
  const data = JSON.parse(await fsp.readFile(file, 'utf8'));
  const tempRoot = path.resolve(os.tmpdir());
  const workspaceRoot = path.resolve(data.workspaceRoot || '');
  if (data.id !== id || !within(tempRoot, workspaceRoot) ||
      !path.basename(workspaceRoot).startsWith(WORKSPACE_PREFIX)) {
    throw new Error('Agent Flow workspace metadata failed validation.');
  }
  return { file, data, workspaceRoot };
}

async function persistManifest(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(data), { flag: 'wx' });
  try {
    await fsp.rename(temp, file);
  } catch (error) {
    await fsp.unlink(temp).catch(() => {});
    throw error;
  }
}

module.exports = (core) => {
  const liveWorkspaceIds = new Set();
  core.onShutdown(async () => {
    for (const id of liveWorkspaceIds) {
      try {
        const { file, workspaceRoot } = await readManifest(core, id);
        await fsp.rm(workspaceRoot, { recursive: true, force: true });
        await fsp.unlink(file);
      } catch (error) {
        core.log('error', `Agent Flow workspace cleanup failed: ${error.message}`, 'FLOW');
      }
    }
    liveWorkspaceIds.clear();
  });

  return {
  'flow:capacity': async () => {
    return getAgentCapacity();
  },
  'flow:workspace:create': async (rootValue) => {
    const root = validateProjectRoot(rootValue);
    const id = randomUUID();
    const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), WORKSPACE_PREFIX));
    const workerRoot = path.join(workspaceRoot, 'project');
    const directory = await ensureManifestDirectory(core);
    const file = path.join(directory, `${id}.json`);
    try {
      const sourceBefore = await fileMap(root);
      await copyProject(root, workerRoot);
      const sourceAfter = await fileMap(root);
      if (!mapsEqual(sourceBefore, sourceAfter)) {
        throw new Error('The active project changed during snapshot creation. Retry the worker batch.');
      }
      const baseline = Object.fromEntries(await fileMap(workerRoot));
      const data = { id, root, workerRoot, workspaceRoot, baseline, createdAt: Date.now() };
      await persistManifest(file, data);
      liveWorkspaceIds.add(id);
      return { id, root: workerRoot };
    } catch (error) {
      await fsp.rm(workspaceRoot, { recursive: true, force: true });
      throw error;
    }
  },
  'flow:workspace:clone': async (sourceId) => {
    const source = await readManifest(core, sourceId);
    const sourceRoot = path.resolve(source.data.workerRoot);
    if (!within(source.workspaceRoot, sourceRoot) || path.basename(sourceRoot) !== 'project') {
      throw new Error('Agent Flow source snapshot failed validation.');
    }
    const sourceStat = await fsp.lstat(sourceRoot);
    const resolvedSourceRoot = await fsp.realpath(sourceRoot);
    const resolvedWorkspaceRoot = await fsp.realpath(source.workspaceRoot);
    if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory() ||
        !within(resolvedWorkspaceRoot, resolvedSourceRoot)) {
      throw new Error('Agent Flow source snapshot is not a real project directory.');
    }
    const id = randomUUID();
    const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), WORKSPACE_PREFIX));
    const workerRoot = path.join(workspaceRoot, 'project');
    const directory = await ensureManifestDirectory(core);
    const file = path.join(directory, `${id}.json`);
    try {
      await copyProject(sourceRoot, workerRoot);
      if (!mapsEqual(new Map(Object.entries(source.data.baseline || {})), await fileMap(workerRoot))) {
        throw new Error('The shared Agent Flow snapshot changed while cloning a worker workspace.');
      }
      const data = {
        id, root: source.data.root, workerRoot, workspaceRoot,
        baseline: source.data.baseline, createdAt: Date.now()
      };
      await persistManifest(file, data);
      liveWorkspaceIds.add(id);
      return { id, root: workerRoot };
    } catch (error) {
      await fsp.rm(workspaceRoot, { recursive: true, force: true });
      throw error;
    }
  },
  'flow:workspace:integrate': async (rootValue, id) => {
    const root = validateProjectRoot(rootValue);
    const { file, data, workspaceRoot } = await readManifest(core, id);
    if (data.root !== root) throw new Error('Agent Flow workspace belongs to a different project.');
    const workerRoot = path.resolve(data.workerRoot);
    if (!within(workspaceRoot, workerRoot) || path.basename(workerRoot) !== 'project') {
      throw new Error('Agent Flow worker path failed validation.');
    }
    const workspaceStat = await fsp.lstat(workspaceRoot);
    const workerStat = await fsp.lstat(workerRoot);
    if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory() ||
        workerStat.isSymbolicLink() || !workerStat.isDirectory() ||
        !(await fsp.realpath(workerRoot)).startsWith(`${await fsp.realpath(workspaceRoot)}${path.sep}`)) {
      throw new Error('Agent Flow worker directory failed validation.');
    }
    const baseline = new Map(Object.entries(data.baseline || {}));
    const workerFiles = await fileMap(workerRoot);
    const projectFiles = await fileMap(root);
    const paths = new Set([...baseline.keys(), ...workerFiles.keys()]);
    const changed = [...paths].filter((relative) => !equalEntry(baseline.get(relative), workerFiles.get(relative)));
    if (changed.some((relative) => workerFiles.get(relative)?.type === 'link')) {
      return { applied: [], conflicts: changed.filter((relative) => workerFiles.get(relative)?.type === 'link'), error: 'Worker-created or changed symbolic links cannot be integrated.' };
    }
    const conflicts = changed.filter((relative) =>
      !equalEntry(baseline.get(relative), projectFiles.get(relative)) &&
      !equalEntry(workerFiles.get(relative), projectFiles.get(relative))
    );
    if (conflicts.length) return { applied: [], conflicts, error: 'Project files changed after the worker snapshot; resolve these overlaps before integration.' };

    const operations = [];
    for (const relative of changed) {
      if (equalEntry(workerFiles.get(relative), projectFiles.get(relative))) continue;
      let destination;
      try { destination = await inspectTarget(root, relative); }
      catch (error) {
        if (error.code === 'FLOW_PATH_CONFLICT') {
          return { applied: [], conflicts: [relative], error: error.message };
        }
        throw error;
      }
      try {
        const destinationStat = await fsp.lstat(destination);
        if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
          return { applied: [], conflicts: [relative], error: 'Worker output conflicts with a non-file project path.' };
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (workerFiles.has(relative)) {
        const source = path.join(workerRoot, relative);
        const sourceStat = await fsp.lstat(source);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
          return { applied: [], conflicts: [relative], error: 'Only regular worker files can be integrated.' };
        }
        operations.push({ relative, destination, source, type: 'write' });
      } else {
        operations.push({ relative, destination, type: 'delete' });
      }
    }

    const backups = [];
    const applied = [];
    try {
      for (const operation of operations) {
        const destination = await inspectTarget(root, operation.relative);
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        await inspectTarget(root, operation.relative);
        let previous = null;
        let previousMode = null;
        try {
          const stat = await fsp.lstat(destination);
          if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Integration refused to replace a non-file path: ${operation.relative}`);
          previous = await fsp.readFile(destination);
          previousMode = stat.mode & 0o777;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        backups.push({ destination, previous, previousMode });
        if (operation.type === 'delete') {
          if (previous !== null) await fsp.unlink(destination);
        } else {
          const temp = `${destination}.${randomUUID()}.tmp`;
          await fsp.copyFile(operation.source, temp, fs.constants.COPYFILE_EXCL);
          const sourceStat = await fsp.stat(operation.source);
          await fsp.chmod(temp, sourceStat.mode & 0o777);
          try { await fsp.rename(temp, destination); }
          catch (error) {
            await fsp.unlink(temp).catch(() => {});
            throw error;
          }
        }
        applied.push(operation.relative);
      }
    } catch (error) {
      for (const backup of backups.reverse()) {
        if (backup.previous === null) await fsp.unlink(backup.destination).catch(() => {});
        else {
          await fsp.writeFile(backup.destination, backup.previous).catch(() => {});
          if (backup.previousMode !== null) await fsp.chmod(backup.destination, backup.previousMode).catch(() => {});
        }
      }
      throw error;
    }
    return { applied, conflicts: [] };
  },
  'flow:workspace:dispose': async (id) => {
    let workspace;
    try { workspace = await readManifest(core, id); }
    catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    const { file, workspaceRoot } = workspace;
    await fsp.rm(workspaceRoot, { recursive: true, force: true });
    await fsp.unlink(file);
    liveWorkspaceIds.delete(id);
    return true;
  }
  };
};
