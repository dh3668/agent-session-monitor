'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { nvmBinDirs, writeAtomic } = require('./shared.cjs');
const { t } = require('../media/i18n.js');
const execute = promisify(execFile);

async function nodeCandidates({ homeDir = os.homedir(), env = process.env, systemPaths = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'] } = {}) {
  // Prefer stable system installations. Never resolve relative to a project.
  const candidates = [...systemPaths];
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    if (path.isAbsolute(directory)) candidates.push(path.join(directory, 'node'));
  }
  if (typeof homeDir === 'string' && path.isAbsolute(homeDir)) {
    candidates.push(
      path.join(homeDir, '.volta', 'bin', 'node'),
      path.join(homeDir, '.asdf', 'shims', 'node'),
      path.join(homeDir, '.local', 'share', 'mise', 'shims', 'node'),
      path.join(homeDir, '.fnm', 'current', 'bin', 'node'),
      ...(await nvmBinDirs(homeDir)).map(dir => path.join(dir, 'node')),
    );
  }
  return [...new Set(candidates)];
}

async function nodeExecutable(options = {}) {
  for (const file of await nodeCandidates(options)) {
    try {
      await fs.access(file, fs.constants.X_OK);
      const { stdout } = await execute(file, ['--version'], { cwd: '/', timeout: 2000 });
      if (/^v(\d+)\./.test(stdout) && Number(stdout.match(/^v(\d+)/)[1]) >= 18) return file;
    } catch { /* Try the next local installation. */ }
  }
  throw new Error(t('Could not find Node.js 18 or later to run the status hooks.'));
}

async function prepareRuntime(storage, extensionRoot) {
  const directory = path.join(storage, 'runtime');
  const stateDir = path.join(storage, 'sessions');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  // The registered hook path must remain valid across VSIX upgrades. What the hook
  // loads is copied first, so a new hook never starts next to an old dependency.
  const hookPath = path.join(directory, 'hook.cjs');
  for (const name of ['activity.cjs', 'manual.cjs', 'hook.cjs']) {
    const target = path.join(directory, name);
    const source = await fs.readFile(path.join(extensionRoot, 'src', name));
    const current = await fs.readFile(target).catch(error => {
      if (error.code === 'ENOENT') return;
      throw error;
    });
    if (!current || !source.equals(current)) {
      await writeAtomic(target, source, { mode: 0o600 });
    }
  }
  return { hookPath, stateDir };
}

module.exports = { nodeExecutable, nodeCandidates, prepareRuntime };
