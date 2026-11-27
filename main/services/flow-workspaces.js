'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { randomUUID, createHash } = require('crypto');
const { getAgentCapacity } = require('./flow-capacity');

const WORKSPACE_DIR = 'agent-flow-workspaces';
const WORKSPACE_PREFIX = 'phantom-agent-flow-';
const EXCLUDED_ANYWHERE = new Set(['.git', 'node_modules']);
const EXCLUDED_PROJECT_ROOTS = new Set(['dist', 'build', 'coverage', '.next']);

function internalProjectPath(relative) {
  const parts = relative.split(path.sep);
  return parts[0]?.toLowerCase() === '.phantom' && parts[1]?.toLowerCase() === 'agent-flow.json';
}

function excludedProjectPath(relative) {
  const parts = relative.split(path.sep).filter(Boolean);
  return parts.some((part) => EXCLUDED_ANYWHERE.has(part.toLowerCase())) ||
    parts.length === 1 && EXCLUDED_PROJECT_ROOTS.has(parts[0].toLowerCase());
}

function within(root, target) {
  if (process.platform === 'win32') {
    root = path.resolve(root).toLowerCase();
    target = path.resolve(target).toLowerCase();
  }
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

async function fileMap(root, previous = new Map(), { forceHash = false, excludeRoots = [] } = {}) {
  const files = new Map();
  async function visit(directory, relative = '') {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (excludedProjectPath(childRelative) || internalProjectPath(childRelative) ||
          excludeRoots.some((excluded) => childRelative === excluded || childRelative.startsWith(`${excluded}${path.sep}`))) continue;
      const absolute = path.join(directory, entry.name);
      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) {
        files.set(childRelative, { type: 'link', target: await fsp.readlink(absolute) });
      } else if (stat.isDirectory()) {
        files.set(childRelative, { type: 'directory' });
        await visit(absolute, childRelative);
      } else if (stat.isFile()) {
        const mode = stat.mode & 0o777;
        const prior = previous.get(childRelative);
        let hash = !forceHash && prior?.type === 'file' && prior.size === stat.size &&
          prior.mtimeMs === stat.mtimeMs && prior.mode === mode ? prior.hash : null;
        if (!hash) {
          const digest = createHash('sha256');
          await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(absolute);
            stream.on('data', (chunk) => digest.update(chunk));
            stream.on('error', reject);
            stream.on('end', resolve);
          });
          hash = digest.digest('hex');
        }
        files.set(childRelative, { type: 'file', hash, mode, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  await visit(root);
  return files;
}

function mapsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [relative, entry] of left) {
    if (!equalEntry(entry, right.get(relative) || null)) return false;
  }
  return true;
}

async function copyProject(sourceRoot, targetRoot) {
  await fsp.cp(sourceRoot, targetRoot, {
    recursive: true,
    errorOnExist: true,
    preserveTimestamps: true,
    filter: async (source) => {
      const relative = path.relative(sourceRoot, source);
      if (excludedProjectPath(relative) || internalProjectPath(relative)) return false;
      try { return !(await fsp.lstat(source)).isSymbolicLink(); }
      catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }
  });
}

function equalEntry(left, right) {
  if (!left || !right) return !left && !right;
  if (left.type !== right.type) return false;
  if (left.type === 'file') return left.hash === right.hash && left.mode === right.mode;
  if (left.type === 'link') return left.target === right.target;
  return true;
}

async function entryAtPath(root, relative) {
  const absolute = await inspectTarget(root, relative);
  let stat;
  try { stat = await fsp.lstat(absolute); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) return { type: 'link', target: await fsp.readlink(absolute) };
  if (stat.isDirectory()) return { type: 'directory' };
  if (!stat.isFile()) return { type: 'other' };
  const digest = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(absolute);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { type: 'file', hash: digest.digest('hex'), mode: stat.mode & 0o777 };
}

async function copyEntry(source, destination) {
  await fsp.cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    preserveTimestamps: true,
    filter: async (item) => !(await fsp.lstat(item)).isSymbolicLink()
  });
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
        throw pathConflict(`Integration path is not a directory: ${relative}`);
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
      !path.basename(workspaceRoot).startsWith(WORKSPACE_PREFIX) ||
      data.conflictDirectory !== undefined &&
        (typeof data.conflictDirectory !== 'string' ||
         !/^\.phantom-flow-conflicts-[0-9a-f-]{36}$/i.test(data.conflictDirectory))) {
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

async function referencedWorkspaceIds(core) {
  const ids = new Set();
  const directory = path.join(core.dataDir, 'store');
  let entries;
  try { entries = await fsp.readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return ids;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^agentflow-[0-9a-f]+\.json$/i.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    try {
      const stat = await fsp.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 20 * 1024 * 1024) {
        throw new Error('Saved Agent Flow checkpoint is not a valid regular file.');
      }
      const checkpoint = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!checkpoint || typeof checkpoint !== 'object' || checkpoint.status === 'complete') continue;
      const referenced = [
        ...(Array.isArray(checkpoint.workspaceIds) ? checkpoint.workspaceIds : []),
        ...Object.values(checkpoint.workspaceByWorker || {}).map((workspace) => workspace?.id)
      ];
      for (const id of referenced) {
        if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) ids.add(id);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') core.log('error', `Saved Agent Flow checkpoint scan failed for ${entry.name}: ${error.message}`, 'FLOW');
    }
  }
  return ids;
}

async function cleanupStaleWorkspaces(core) {
  const directory = await ensureManifestDirectory(core);
  const tempRoot = await fsp.realpath(os.tmpdir());
  const retainedWorkspaceIds = await referencedWorkspaceIds(core);
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/i.test(entry.name)) continue;
    if (retainedWorkspaceIds.has(entry.name.slice(0, -5))) continue;
    const file = path.join(directory, entry.name);
    let cleaned = false;
    try {
      const { workspaceRoot } = await readManifest(core, entry.name.slice(0, -5));
      let stat;
      try { stat = await fsp.lstat(workspaceRoot); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (!stat) cleaned = true;
      else if (stat.isDirectory() && !stat.isSymbolicLink()) {
        const realRoot = await fsp.realpath(workspaceRoot);
        if (!within(tempRoot, realRoot) || !path.basename(realRoot).startsWith(WORKSPACE_PREFIX)) {
          throw new Error('Stale workspace path failed validation.');
        }
        await fsp.rm(realRoot, { recursive: true, force: true });
        cleaned = true;
      } else {
        throw new Error('Stale workspace root is not a real directory.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') core.log('error', `Stale Agent Flow workspace cleanup failed: ${error.message}`, 'FLOW');
    }
    if (cleaned) {
      await fsp.unlink(file).catch((error) => {
        if (error.code !== 'ENOENT') core.log('error', `Stale Agent Flow manifest cleanup failed: ${error.message}`, 'FLOW');
      });
    }
  }

}

async function removePartialWorkspace(core, workspaceRoot, file) {
  const errors = [];
  let rootRemoved = true;
  try { await fsp.rm(workspaceRoot, { recursive: true, force: true }); }
  catch (error) { rootRemoved = false; errors.push(error); }
  if (rootRemoved) {
    try { await fsp.unlink(file); }
    catch (error) { if (error.code !== 'ENOENT') errors.push(error); }
  }
  if (errors.length) {
    core.log('error', `Failed to clean up partial Agent Flow workspace: ${errors.map((error) => error.message).join('; ')}`, 'FLOW');
  }
}

module.exports = (core) => {
  const liveWorkspaceIds = new Set();
  const startupCleanup = cleanupStaleWorkspaces(core);
  startupCleanup.catch((error) => core.log('error', `Agent Flow startup cleanup failed: ${error.message}`, 'FLOW'));
  core.onShutdown(async () => {
    await startupCleanup;
    const retainedWorkspaceIds = await referencedWorkspaceIds(core);
    for (const id of liveWorkspaceIds) {
      if (retainedWorkspaceIds.has(id)) continue;
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
  'flow:workspace:get': async (id) => {
    await startupCleanup;
    try {
      const workspace = await readManifest(core, id);
      return { id, root: workspace.data.workerRoot };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  },
  'flow:workspace:create': async (rootValue) => {
    await startupCleanup;
    const root = validateProjectRoot(rootValue);
    const id = randomUUID();
    const directory = await ensureManifestDirectory(core);
    const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), WORKSPACE_PREFIX));
    const workerRoot = path.join(workspaceRoot, 'project');
    const file = path.join(directory, `${id}.json`);
    try {
      await persistManifest(file, { id, root, workerRoot, workspaceRoot, baseline: {}, createdAt: Date.now() });
      const sourceBefore = await fileMap(root);
      await copyProject(root, workerRoot);
      const sourceAfter = await fileMap(root, sourceBefore, { forceHash: true });
      if (!mapsEqual(sourceBefore, sourceAfter)) {
        throw new Error('The active project changed during snapshot creation. Retry the worker batch.');
      }
      const baseline = Object.fromEntries([...sourceBefore].filter(([, entry]) => entry.type !== 'link'));
      const data = { id, root, workerRoot, workspaceRoot, baseline, createdAt: Date.now() };
      await persistManifest(file, data);
      liveWorkspaceIds.add(id);
      return { id, root: workerRoot };
    } catch (error) {
      await removePartialWorkspace(core, workspaceRoot, file);
      throw error;
    }
  },
  'flow:workspace:clone': async (sourceId) => {
    await startupCleanup;
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
    const directory = await ensureManifestDirectory(core);
    const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), WORKSPACE_PREFIX));
    const workerRoot = path.join(workspaceRoot, 'project');
    const file = path.join(directory, `${id}.json`);
    try {
      await persistManifest(file, {
        id, root: source.data.root, workerRoot, workspaceRoot,
        baseline: source.data.baseline, conflictDirectory: source.data.conflictDirectory,
        createdAt: Date.now()
      });
      await copyProject(sourceRoot, workerRoot);
      const data = {
        id, root: source.data.root, workerRoot, workspaceRoot,
        baseline: source.data.baseline, conflictDirectory: source.data.conflictDirectory,
        createdAt: Date.now()
      };
      await persistManifest(file, data);
      liveWorkspaceIds.add(id);
      return { id, root: workerRoot };
    } catch (error) {
      await removePartialWorkspace(core, workspaceRoot, file);
      throw error;
    }
  },
  'flow:workspace:rebase': async (rootValue, id, conflictPaths) => {
    await startupCleanup;
    if (!Array.isArray(conflictPaths) || conflictPaths.some((relative) => !safeRelativePath(relative))) {
      throw new Error('Agent Flow conflict paths are invalid.');
    }
    const root = validateProjectRoot(rootValue);
    const { data, file, workspaceRoot } = await readManifest(core, id);
    if (data.root !== root) throw new Error('Agent Flow workspace belongs to a different project.');
    const workerRoot = path.resolve(data.workerRoot);
    if (!within(workspaceRoot, workerRoot) || path.basename(workerRoot) !== 'project') {
      throw new Error('Agent Flow worker path failed validation.');
    }
    const workspaceStat = await fsp.lstat(workspaceRoot);
    const workerStat = await fsp.lstat(workerRoot);
    if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory() ||
        workerStat.isSymbolicLink() || !workerStat.isDirectory() ||
        !within(await fsp.realpath(workspaceRoot), await fsp.realpath(workerRoot))) {
      throw new Error('Agent Flow worker directory failed validation.');
    }

    const projectFiles = await fileMap(root, new Map(), { forceHash: true });
    const requested = [...new Set(conflictPaths)];
    const paths = requested.filter((relative) =>
      !requested.some((parent) => parent !== relative && relative.startsWith(`${parent}${path.sep}`)));
    const conflictDirectory = `.phantom-flow-conflicts-${randomUUID()}`;
    const conflictRoot = path.join(workerRoot, conflictDirectory);
    await fsp.mkdir(conflictRoot);
    const entries = [];
    try {
      for (const relative of paths) {
        const segments = relative.split(/[\\/]+/);
        const parent = segments.slice(0, -1).join(path.sep);
        if (parent) await inspectTarget(workerRoot, parent);
        const workerPath = path.join(workerRoot, ...segments);
        const priorPath = path.join(conflictRoot, 'worker', ...segments);
        const currentPath = path.join(conflictRoot, 'project', ...segments);
        let priorType = 'missing';
        let currentType = 'missing';
        try {
          const stat = await fsp.lstat(workerPath);
          priorType = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
          if (!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory())) {
            await fsp.mkdir(path.dirname(priorPath), { recursive: true });
            await copyEntry(workerPath, priorPath);
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        const current = projectFiles.get(relative) || segments.slice(1).map((_, index) =>
          projectFiles.get(segments.slice(0, index + 1).join(path.sep))
        ).find((entry) => entry?.type === 'link');
        if (current) {
          currentType = current.type;
          if (current.type === 'file' || current.type === 'directory') {
            const projectPath = await inspectTarget(root, relative);
            await fsp.mkdir(path.dirname(currentPath), { recursive: true });
            await copyEntry(projectPath, currentPath);
          }
        }
        entries.push({
          path: relative,
          workerVersion: path.join(conflictDirectory, 'worker', ...segments),
          projectVersion: path.join(conflictDirectory, 'project', ...segments),
          workerType: priorType,
          projectType: currentType
        });
      }

      const baseline = new Map(Object.entries(data.baseline || {}));
      for (const relative of paths) {
        for (const key of baseline.keys()) {
          if (key === relative || key.startsWith(`${relative}${path.sep}`)) baseline.delete(key);
        }
        for (const [key, entry] of projectFiles) {
          if ((key === relative || key.startsWith(`${relative}${path.sep}`)) && entry.type !== 'link') {
            baseline.set(key, entry);
          }
        }
        const workerPath = path.join(workerRoot, ...relative.split(/[\\/]+/));
        const projectEntry = projectFiles.get(relative);
        await fsp.rm(workerPath, { recursive: true, force: true });
        if (projectEntry && projectEntry.type !== 'link') {
          const source = await inspectTarget(root, relative);
          await fsp.mkdir(path.dirname(workerPath), { recursive: true });
          await copyEntry(source, workerPath);
        }
      }
      const manifestPath = path.join(conflictRoot, 'manifest.json');
      await fsp.writeFile(manifestPath, JSON.stringify(entries, null, 2), { flag: 'wx' });
      const priorConflictDirectory = data.conflictDirectory;
      data.baseline = Object.fromEntries(baseline);
      data.conflictDirectory = conflictDirectory;
      data.conflictPaths = paths;
      await persistManifest(file, data);
      if (typeof priorConflictDirectory === 'string' &&
          /^\.phantom-flow-conflicts-[0-9a-f-]{36}$/i.test(priorConflictDirectory)) {
        await fsp.rm(path.join(workerRoot, priorConflictDirectory), { recursive: true, force: true });
      }
      return { conflictDirectory, paths: entries };
    } catch (error) {
      await fsp.rm(conflictRoot, { recursive: true, force: true });
      throw error;
    }
  },
  'flow:workspace:integrate': async (rootValue, id, resolvePaths = []) => {
    await startupCleanup;
    const root = validateProjectRoot(rootValue);
    const { data, workspaceRoot } = await readManifest(core, id);
    if (data.root !== root) throw new Error('Agent Flow workspace belongs to a different project.');
    const workerRoot = path.resolve(data.workerRoot);
    if (!within(workspaceRoot, workerRoot) || path.basename(workerRoot) !== 'project') {
      throw new Error('Agent Flow worker path failed validation.');
    }
    const workspaceStat = await fsp.lstat(workspaceRoot);
    const workerStat = await fsp.lstat(workerRoot);
    if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory() ||
        workerStat.isSymbolicLink() || !workerStat.isDirectory() ||
        !within(await fsp.realpath(workspaceRoot), await fsp.realpath(workerRoot))) {
      throw new Error('Agent Flow worker directory failed validation.');
    }
    const baseline = new Map(Object.entries(data.baseline || {}));
    const workerFiles = await fileMap(workerRoot, baseline, {
      forceHash: true,
      excludeRoots: typeof data.conflictDirectory === 'string' ? [data.conflictDirectory] : []
    });
    const paths = new Set([...baseline.keys(), ...workerFiles.keys()]);
    const changed = new Set([...paths].filter((relative) => !equalEntry(baseline.get(relative), workerFiles.get(relative))));
    const requestedResolutions = Array.isArray(resolvePaths)
      ? resolvePaths.filter((relative) => safeRelativePath(relative))
      : [];
    const projectFiles = new Map();
    const projectPaths = new Set([...changed, ...requestedResolutions]);
    for (const relative of projectPaths) {
      const segments = relative.split(/[\\/]+/);
      for (let index = 1; index < segments.length; index++) projectPaths.add(path.join(...segments.slice(0, index)));
    }
    for (const relative of projectPaths) {
      try { projectFiles.set(relative, await entryAtPath(root, relative)); }
      catch (error) {
        if (error.code === 'FLOW_PATH_CONFLICT') projectFiles.set(relative, { type: 'link' });
        else throw error;
      }
    }
    const conflicts = new Set();
    const resolved = new Set();
    const shapeConflicts = new Set();
    for (const relative of changed) {
      const before = baseline.get(relative);
      const after = workerFiles.get(relative);
      if (after?.type === 'link' || before && after && before.type !== after.type &&
          (before.type === 'file' || after.type === 'file')) {
        conflicts.add(relative);
        shapeConflicts.add(relative);
      }
    }

    for (const relative of requestedResolutions) {
      const workerEntry = workerFiles.get(relative);
      const baselineEntry = baseline.get(relative);
      const projectEntry = projectFiles.get(relative);
      if (equalEntry(workerEntry, projectEntry) || equalEntry(workerEntry, baselineEntry)) {
        resolved.add(relative);
        changed.delete(relative);
      } else if (!changed.has(relative)) {
        changed.add(relative);
      }
    }
    for (const relative of changed) {
      if (workerFiles.get(relative)?.type === 'link') {
        conflicts.add(relative);
        continue;
      }
      const shapeConflict = [...shapeConflicts].some((parent) => relative === parent || relative.startsWith(`${parent}${path.sep}`));
      if (shapeConflict) continue;
      if (!equalEntry(baseline.get(relative), projectFiles.get(relative)) &&
          !equalEntry(workerFiles.get(relative), projectFiles.get(relative))) conflicts.add(relative);
      const segments = relative.split(/[\\/]+/);
      for (let index = 1; index < segments.length; index++) {
        const parent = path.join(...segments.slice(0, index));
        const baselineParent = baseline.get(parent);
        const projectParent = projectFiles.get(parent);
        if (projectParent && projectParent.type !== 'directory' ||
            baselineParent?.type === 'directory' && !projectParent) {
          conflicts.add(relative);
          break;
        }
      }
    }

    const operations = [];
    for (const relative of changed) {
      if (conflicts.has(relative) || [...shapeConflicts].some((parent) => relative.startsWith(`${parent}${path.sep}`))) continue;
      if (equalEntry(workerFiles.get(relative), projectFiles.get(relative))) continue;
      let destination;
      try { destination = await inspectTarget(root, relative); }
      catch (error) {
        if (error.code === 'FLOW_PATH_CONFLICT') {
          conflicts.add(relative);
          continue;
        }
        throw error;
      }
      try {
        const destinationStat = await fsp.lstat(destination);
        const desired = workerFiles.get(relative);
        if (destinationStat.isSymbolicLink() ||
            (desired?.type === 'file' && !destinationStat.isFile()) ||
            (desired?.type === 'directory' && !destinationStat.isDirectory())) {
          conflicts.add(relative);
          continue;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const desired = workerFiles.get(relative);
      if (desired?.type === 'directory') {
        operations.push({ relative, destination, type: 'mkdir' });
      } else if (desired?.type === 'file') {
        const source = path.join(workerRoot, relative);
        const sourceStat = await fsp.lstat(source);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
          conflicts.add(relative);
          continue;
        }
        operations.push({ relative, destination, source, type: 'write' });
      } else if (baseline.get(relative)?.type === 'directory') {
        operations.push({ relative, destination, type: 'rmdir' });
      } else {
        operations.push({ relative, destination, type: 'delete' });
      }
    }
    operations.sort((left, right) => {
      const rank = (operation) => operation.type === 'mkdir' ? 0 : operation.type === 'rmdir' ? 2 : 1;
      const rankDifference = rank(left) - rank(right);
      if (rankDifference) return rankDifference;
      const depthDifference = left.relative.split(path.sep).length - right.relative.split(path.sep).length;
      return left.type === 'rmdir' ? -depthDifference : depthDifference;
    });

    const backups = [];
    const applied = [];
    const integratedEntries = new Map();
    const parentPathsMatch = async (relative) => {
      const segments = relative.split(/[\\/]+/);
      for (let index = 1; index < segments.length; index++) {
        const parent = path.join(...segments.slice(0, index));
        const expectedParent = integratedEntries.has(parent) ? integratedEntries.get(parent) : projectFiles.get(parent);
        const currentParent = await entryAtPath(root, parent).catch((error) => {
          if (error.code === 'FLOW_PATH_CONFLICT') return { type: 'link' };
          throw error;
        });
        if (!equalEntry(currentParent, expectedParent)) return false;
      }
      return true;
    };
    try {
      for (const operation of operations) {
        const destination = await inspectTarget(root, operation.relative);
        await core.withFileLock(destination, async () => {
          let temp = null;
          try {
            if (operation.type === 'write') {
              temp = `${destination}.${randomUUID()}.tmp`;
              await fsp.copyFile(operation.source, temp, fs.constants.COPYFILE_EXCL);
              const sourceStat = await fsp.stat(operation.source);
              await fsp.chmod(temp, sourceStat.mode & 0o777);
            }
            if (!(await parentPathsMatch(operation.relative))) {
              conflicts.add(operation.relative);
              return;
            }
            const current = await entryAtPath(root, operation.relative).catch((error) => {
              if (error.code === 'FLOW_PATH_CONFLICT') return { type: 'link' };
              throw error;
            });
            if (!equalEntry(current, projectFiles.get(operation.relative))) {
              conflicts.add(operation.relative);
              return;
            }

            let previous = null;
            let previousMode = null;
            let previousType = null;
            try {
              const stat = await fsp.lstat(destination);
              if (stat.isSymbolicLink()) {
                conflicts.add(operation.relative);
                return;
              }
              if (stat.isFile()) {
                previous = await fsp.readFile(destination);
                previousMode = stat.mode & 0o777;
                previousType = 'file';
              } else if (stat.isDirectory()) previousType = 'directory';
              else {
                conflicts.add(operation.relative);
                return;
              }
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }

            if (operation.type === 'rmdir') {
              try { await fsp.rmdir(destination); }
              catch (error) {
                if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST' || error.code === 'ENOENT') {
                  conflicts.add(operation.relative);
                  return;
                }
                throw error;
              }
            } else if (operation.type === 'mkdir') {
              try { await fsp.mkdir(destination); }
              catch (error) {
                if (error.code === 'EEXIST') {
                  conflicts.add(operation.relative);
                  return;
                }
                throw error;
              }
            } else if (operation.type === 'delete') {
              if (previous !== null) {
                try { await fsp.unlink(destination); }
                catch (error) {
                  if (error.code === 'ENOENT') {
                    conflicts.add(operation.relative);
                    return;
                  }
                  throw error;
                }
              }
            } else {
              await fsp.rename(temp, destination);
              temp = null;
            }
            const expectedAfter = operation.type === 'delete' || operation.type === 'rmdir'
              ? null
              : operation.type === 'mkdir' ? { type: 'directory' } : workerFiles.get(operation.relative);
            backups.push({ destination, relative: operation.relative, previous, previousMode, previousType, expectedAfter });
            applied.push(operation.relative);
            integratedEntries.set(operation.relative, expectedAfter);
          } finally {
            if (temp) {
              try { await fsp.unlink(temp); }
              catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
          }
        });
      }
    } catch (error) {
      for (const backup of backups.reverse()) {
        try {
          await core.withFileLock(backup.destination, async () => {
            if (!equalEntry(await entryAtPath(root, backup.relative), backup.expectedAfter)) {
              conflicts.add(backup.relative);
              return;
            }
            if (backup.previousType === 'directory') await fsp.mkdir(backup.destination);
            else if (backup.previousType === 'file') {
              const temp = `${backup.destination}.${randomUUID()}.rollback`;
              await fsp.writeFile(temp, backup.previous, { flag: 'wx' });
              if (backup.previousMode !== null) await fsp.chmod(temp, backup.previousMode);
              await fsp.rename(temp, backup.destination);
            } else if (backup.expectedAfter?.type === 'directory') {
              await fsp.rmdir(backup.destination);
            } else if (backup.expectedAfter !== null) {
              await fsp.unlink(backup.destination);
            }
          });
        } catch (rollbackError) {
          core.log('error', `Agent Flow integration rollback failed for ${backup.relative}: ${rollbackError.message}`, 'FLOW');
        }
      }
      throw error;
    }
    const unresolved = [...new Set([...conflicts])];
    return {
      applied,
      conflicts: unresolved,
      resolved: [...resolved],
      error: unresolved.length ? 'Some worker changes conflicted with the current project and were not applied.' : ''
    };
  },
  'flow:workspace:dispose': async (id) => {
    await startupCleanup;
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
