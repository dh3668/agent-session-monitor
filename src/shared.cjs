'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DAY = 86400000;
const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const AGY_SURFACES = Object.freeze(['antigravity', 'antigravity-ide', 'antigravity-cli']);
const CODEX_INTERACTIVE_SOURCES = Object.freeze([
  'vscode', 'codex_vscode', 'codex-vscode', 'cli', 'desktop', 'appServer', 'app-server', 'app_server',
  'chatgpt', '{"custom":"chatgpt"}', '{"custom":"atlas"}',
]);
const VENDORS = Object.freeze({
  claude: 'anthropic.claude-code',
  codex: 'openai.chatgpt',
  agy: 'google.google-antigravity',
});

function createLru(max) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      if (map.size > max) map.delete(map.keys().next().value);
    },
    delete(key) { return map.delete(key); },
    clear() { map.clear(); },
    has(key) { return map.has(key); },
    keys() { return map.keys(); },
    get size() { return map.size; },
  };
}

const CONTROL_BIDI_ALL = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu;
const CONTROL_BIDI_KEEP_NL = /[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu;
const CONTROL_BIDI_COLLAPSE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUnderDir(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function stripControlBidi(value, { keepNewlines = false, collapseSpaces = false, max } = {}) {
  if (typeof value !== 'string') return '';
  let text;
  if (collapseSpaces) {
    text = value.replace(CONTROL_BIDI_COLLAPSE, '').replace(/[\t\r\n]+/g, ' ').trim();
  } else if (keepNewlines) {
    text = value.replace(CONTROL_BIDI_KEEP_NL, '');
  } else {
    text = value.replace(CONTROL_BIDI_ALL, '').trim();
  }
  return typeof max === 'number' ? text.slice(0, max) : text;
}

function providerConfigDir(provider, { homeDir = os.homedir(), env = process.env, fallbackRelative = false } = {}) {
  if (provider === 'claude') {
    const override = env.CLAUDE_CONFIG_DIR;
    return override && (!fallbackRelative || path.isAbsolute(override)) ? override : path.join(homeDir, '.claude');
  }
  if (provider === 'codex') {
    const override = env.CODEX_HOME;
    return override && (!fallbackRelative || path.isAbsolute(override)) ? override : path.join(homeDir, '.codex');
  }
  if (provider === 'agy') return path.join(homeDir, '.gemini', 'config');
  return '';
}

async function nvmBinDirs(homeDir) {
  const base = path.join(homeDir, '.nvm', 'versions', 'node');
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(entry.name);
      return m ? { name: entry.name, major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (b.major - a.major) || (b.minor - a.minor) || (b.patch - a.patch) || b.name.localeCompare(a.name))
    .map(entry => path.join(base, entry.name, 'bin'));
}

async function writeAtomic(filePath, content, { mode = 0o600 } = {}) {
  const temp = path.join(path.dirname(filePath), '.' + path.basename(filePath) + '.' + randomUUID() + '.tmp');
  try {
    await fs.writeFile(temp, content, { flag: 'wx', mode });
    await fs.rename(temp, filePath);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

module.exports = {
  DAY,
  UUID_RE,
  AGY_SURFACES,
  CODEX_INTERACTIVE_SOURCES,
  VENDORS,
  createLru,
  isObject,
  isUnderDir,
  stripControlBidi,
  providerConfigDir,
  nvmBinDirs,
  writeAtomic,
};
