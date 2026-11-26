'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { randomUUID } = require('crypto');

const FLOW_FILE = 'agent-flow.json';
const MAX_FLOW_SIZE = 5 * 1024 * 1024;

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function flowFile(rootValue, create) {
  if (typeof rootValue !== 'string' || !rootValue.trim()) throw new Error('Open a project before saving Agent Flow.');
  const root = fs.realpathSync(path.resolve(rootValue));
  if (!fs.statSync(root).isDirectory()) throw new Error('The active project path is not a directory.');
  const directory = path.join(root, '.phantom');

  let directoryStat;
  try { directoryStat = await fsp.lstat(directory); }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) {
      if (error.code === 'ENOENT' && !create) return null;
      throw error;
    }
    await fsp.mkdir(directory);
    directoryStat = await fsp.lstat(directory);
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error('The project .phantom path must be a real directory, not a link.');
  }
  const resolvedDirectory = await fsp.realpath(directory);
  if (!isWithin(root, resolvedDirectory)) throw new Error('Agent Flow storage must remain inside the project.');
  const file = path.join(resolvedDirectory, FLOW_FILE);

  try {
    const fileStat = await fsp.lstat(file);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error('The project Agent Flow file must be a regular file, not a link.');
    }
    const resolvedFile = await fsp.realpath(file);
    if (!isWithin(root, resolvedFile)) throw new Error('Agent Flow storage must remain inside the project.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) return null;
  }
  return file;
}

module.exports = () => ({
  'flow:load': async (root) => {
    const file = await flowFile(root, false);
    if (!file) return null;
    const stat = await fsp.stat(file);
    if (stat.size > MAX_FLOW_SIZE) throw new Error('Project Agent Flow file exceeds the 5 MB limit.');
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  },
  'flow:save': async (root, workflow) => {
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow) ||
        !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) {
      throw new Error('Invalid Agent Flow workflow.');
    }
    const contents = JSON.stringify(workflow, null, 2);
    if (Buffer.byteLength(contents, 'utf8') > MAX_FLOW_SIZE) throw new Error('Agent Flow workflow exceeds the 5 MB limit.');
    const file = await flowFile(root, true);
    const temp = path.join(path.dirname(file), `.agent-flow-${randomUUID()}.tmp`);
    await fsp.writeFile(temp, contents, { encoding: 'utf8', flag: 'wx' });
    try {
      await fsp.rename(temp, file);
    } catch (error) {
      await fsp.unlink(temp).catch(() => {});
      throw error;
    }
    return true;
  }
});
