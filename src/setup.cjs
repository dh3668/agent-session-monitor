'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');
const { EVENT_NAMES } = require('./hook.cjs');
const { isObject, providerConfigDir, nvmBinDirs } = require('./shared.cjs');

const AGY_GROUP = 'local-vscode-agent-session-monitor';
const VERIFY_TTL_MS = 5 * 60000;
const TRUST_TTL_MS = 60000;
const STATUS_CACHE_LIMIT = 64;
const CODEX_TRUST_TIMEOUT_MS = 5000;
const CONFIG_FILES = Object.freeze({ claude: 'settings.json', codex: 'hooks.json', agy: 'hooks.json' });
const MATCHER = {
  claude: {
    PreToolUse: '^(AskUserQuestion|ExitPlanMode)$',
    Notification: '^(permission_prompt|elicitation_dialog|elicitation_url_dialog|elicitation_complete|elicitation_response|agent_needs_input)$',
  },
  codex: { PreToolUse: '^(request_user_input|request_permissions)$' },
  agy: {
    PreToolUse: '^(ask_permission|ask_question|notify_user|run_command|write_file|write_to_file|edit_file|replace_file_content|multi_replace_file_content|read_file|view_file|read_url_content)$',
    PostToolUse: '*',
  },
};

const statusCache = new Map();
const statStamp = stat => stat ? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}:${stat.mode}` : 'missing';
const incompatible = () => new Error('기존 훅 설정 형식을 확인해 주세요. 파일을 변경하지 않았습니다.');
// The inline request window can be lengthened up to 540 s; the hook needs headroom beyond it.
const timeoutFor = (provider, event) => provider === 'claude' && event === 'PermissionRequest' ? 600 : 3;
const directEvent = (provider, event) => provider === 'agy' && !['PreToolUse', 'PostToolUse'].includes(event);

function invalidateStatusCache(configPath) {
  for (const [key, entry] of statusCache) {
    if (entry.configPath === configPath) statusCache.delete(key);
  }
}

function getConfigPath(provider, {homeDir = os.homedir(), env = process.env} = {}) {
  if (!Object.hasOwn(CONFIG_FILES, provider)) throw new Error('지원하지 않는 도구입니다.');
  const directory = providerConfigDir(provider, { homeDir, env });
  if (!path.isAbsolute(directory)) throw new Error('홈 설정 디렉터리에는 절대 경로가 필요합니다.');
  return path.join(directory, CONFIG_FILES[provider]);
}

function shellQuote(word) {
  if (typeof word !== 'string' || /[\u0000-\u001f\u007f]/u.test(word)) throw new Error('훅 경로가 유효하지 않습니다.');
  return "'" + word.replaceAll("'", "'\\''") + "'";
}

function unquoteBinary(quoted) {
  if (typeof quoted !== 'string' || !/^'(?:[^']|'\\'')*'$/.test(quoted)) return;
  return quoted.slice(1, -1).replaceAll("'\\''", "'");
}

function commandTail({hookPath, provider, stateDir}, event) {
  return ' ' + [hookPath, provider, event, stateDir].map(shellQuote).join(' ');
}

function owns(handler, options, event) {
  if (!isObject(handler) || handler.type !== 'command' || typeof handler.command !== 'string') return false;
  const tail = commandTail(options, event);
  if (!handler.command.endsWith(tail)) return false;
  // Only our quoted executable followed by the exact installed arguments.
  const binary = handler.command.slice(0, -tail.length);
  return /^'(?:[^']|'\\'')*'$/.test(binary);
}

function updateHooks(config, options) {
  const { provider, action, nodePath } = options;
  const blockKey = provider === 'agy' ? AGY_GROUP : 'hooks';
  if (!isObject(config)) throw incompatible();
  if (!Object.hasOwn(config, blockKey) && action === 'remove') return false;
  const block = Object.hasOwn(config, blockKey) ? config[blockKey] : {};
  if (!isObject(block)) throw incompatible();

  for (const event of EVENT_NAMES[provider]) {
    const entries = block[event];
    if (entries !== undefined && !Array.isArray(entries)) throw incompatible();
  }

  let changed = false;
  for (const event of EVENT_NAMES[provider]) {
    const original = block[event] || [];
    const direct = directEvent(provider, event);
    const matcher = MATCHER[provider][event];
    const entries = [];
    const ours = handler => owns(handler, options, event);
    for (const entry of original) {
      if (direct && ours(entry)) continue;
      if (direct || !isObject(entry) || !Array.isArray(entry.hooks) || !entry.hooks.some(ours)) {
        entries.push(entry);
        continue;
      }
      const otherHooks = entry.hooks.filter(handler => !ours(handler));
      if (otherHooks.length) entries.push({ ...entry, hooks: otherHooks });
    }
    if (action === 'install') {
      const timeout = timeoutFor(provider, event);
      const handler = { type: 'command', command: shellQuote(nodePath) + commandTail(options, event), timeout };
      const group = matcher ? {matcher, hooks: [handler]} : {hooks: [handler]};
      entries.push(direct ? handler : group);
    }
    if (isDeepStrictEqual(entries, original)) continue;
    if (entries.length) block[event] = entries;
    else delete block[event];
    changed = true;
  }
  if (changed) {
    if (Object.keys(block).length) config[blockKey] = block;
    else delete config[blockKey];
  }
  return changed;
}

function parseSettings(input) {
  let config;
  try {
    config = JSON.parse(input, (_key, value) => {
      if (typeof value === 'number' && (!Number.isFinite(value) ||
          (Number.isInteger(value) && !Number.isSafeInteger(value)))) throw incompatible();
      return value;
    });
  } catch {
    throw new Error('설정 파일에 표준 JSON으로 보존하기 어려운 값, 주석 또는 구문 오류가 있습니다. 파일을 변경하지 않았습니다.');
  }
  // JSON.parse discards duplicate keys. Refuse the rewrite rather than dropping them.
  let count = 0;
  JSON.stringify(config, function (key, value) {
    if (isObject(value)) count += Object.keys(value).length;
    return value;
  });
  let keyTokens = 0;
  for (const match of input.matchAll(/"(?:\\.|[^"\\])*"\s*(:)?/g)) {
    if (match[1]) keyTokens++;
  }
  if (count !== keyTokens) throw incompatible();
  return config;
}

async function snapshot(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('설정 파일이 일반 파일인지 확인해 주세요. 링크는 변경하지 않았습니다.');
    return { stat, text: await fs.readFile(file, 'utf8') };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameSnapshot(left, right) {
  if (!left || !right) return left === right;
  return left.stat.ino === right.stat.ino && left.stat.mode === right.stat.mode && left.text === right.text;
}

// A setup holds its lock for milliseconds. One older than this was left by a window
// that crashed mid-setup and would otherwise block every later install for good.
const STALE_LOCK_MS = 60000;

async function reclaimStaleLock(file) {
  const stale = await fs.lstat(file).catch(() => undefined);
  if (!stale?.isFile() || Date.now() - stale.mtimeMs < STALE_LOCK_MS) return false;
  // Move whatever is there aside atomically, then make sure it was the stale lock:
  // another window may have reclaimed it and taken a fresh one in between.
  const aside = file + '.' + randomUUID() + '.stale';
  try { await fs.rename(file, aside); } catch { return false; }
  const moved = await fs.lstat(aside).catch(() => undefined);
  if (moved && moved.ino !== stale.ino) await fs.link(aside, file).catch(() => {});
  await fs.rm(aside, { force: true }).catch(() => {});
  return Boolean(moved && moved.ino === stale.ino);
}

async function lockConfig(file) {
  // Another VS Code window may start setup at the same time.
  for (let attempt = 0; attempt < 12; attempt++) {
    try { return await fs.open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await reclaimStaleLock(file)) continue;
      await sleep(35);
    }
  }
  throw new Error('훅 설정이 잠겨 있습니다. 잠시 후 다시 시도하세요. 설치 중이던 VS Code가 비정상 종료됐다면 모든 창을 닫고 잠금 파일을 삭제한 뒤 다시 열어 주세요. ' + file);
}

async function configureHooks(options) {
  const { action, provider, nodePath, hookPath, stateDir } = options;
  if (process.platform === 'win32') throw new Error('이 설정 명령은 macOS와 Linux에서 지원합니다.');
  if (!['install', 'remove'].includes(action)) throw new Error('지원하지 않는 설정 동작입니다.');
  const configPath = getConfigPath(provider, options);
  for (const value of action === 'install' ? [nodePath, hookPath, stateDir] : [hookPath, stateDir]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('훅에는 절대 경로가 필요합니다.');
    shellQuote(value);
  }
  if (action === 'remove' && !await snapshot(configPath)) return {changed: false, configPath};
  const dir = path.dirname(configPath);
  await fs.mkdir(dir, {recursive: true, mode: 0o700});
  const lockPath = configPath + '.agent-session-monitor.lock';
  const lock = await lockConfig(lockPath);
  let temp;
  try {
    const before = await snapshot(configPath);
    const input = before?.text ?? '{}';
    const bom = input.startsWith('\uFEFF') ? '\uFEFF' : '';
    const config = parseSettings(input.slice(bom.length));
    const changed = updateHooks(config, options);
    const result = {changed, configPath};
    if (action === 'install') {
      if (provider === 'codex') result.notice = 'Codex CLI의 /hooks에서 추가된 훅을 검토하고 신뢰한 뒤 사용하세요.';
      if (provider === 'claude' && config.disableAllHooks === true) {
        result.notice = 'Claude 사용자 설정의 disableAllHooks가 켜져 있습니다.';
      }
      if (provider === 'agy' && config[AGY_GROUP]?.enabled === false) {
        result.notice = 'Antigravity 설정에서 이 훅 그룹이 비활성화되어 있습니다.';
      }
    }
    if (!changed) return result;
    if (before && !(before.stat.mode & 0o222)) {
      throw new Error('설정 파일이 읽기 전용입니다. 파일을 변경하지 않았습니다.');
    }
    if (before) await fs.access(configPath, fs.constants.W_OK);
    const indent = input.match(/\r?\n([ \t]+)"/)?.[1] || '  ';
    const eol = input.includes('\r\n') ? '\r\n' : '\n';
    let body = bom + JSON.stringify(config, null, indent).replaceAll('\n', eol);
    if (!before || input.endsWith('\n')) body += eol;
    temp = path.join(dir, '.agent-session-monitor-' + randomUUID() + '.tmp');
    await fs.writeFile(temp, body, {flag: 'wx', mode: 0o600});
    if (before) await fs.chmod(temp, before.stat.mode & 0o777);
    if (!sameSnapshot(before, await snapshot(configPath))) {
      throw new Error('작업 중 설정 파일이 바뀌었습니다. 최신 설정으로 다시 시도해 주세요.');
    }
    if (before) {
      await fs.rename(temp, configPath);
      temp = undefined;
    } else {
      // An external tool might have created settings after the last read.
      await fs.link(temp, configPath);
    }
    invalidateStatusCache(configPath);
    return result;
  } finally {
    try {
      if (temp) await fs.rm(temp, {force: true});
    } finally {
      try { await lock.close(); } finally { await fs.rm(lockPath, {force: true}); }
    }
  }
}

function evaluateConfigStatus(config, { provider, hookPath, stateDir }) {
  const block = isObject(config) ? config[provider === 'agy' ? AGY_GROUP : 'hooks'] : undefined;
  if (!isObject(block)) return { status: 'missing', binaries: [], entries: [] };
  const options = { provider, hookPath, stateDir };
  let owned = 0, current = 0;
  const binaries = new Set();
  const entries = [];
  for (const event of EVENT_NAMES[provider]) {
    const found = [];
    const list = Array.isArray(block[event]) ? block[event] : [];
    for (let groupIndex = 0; groupIndex < list.length; groupIndex++) {
      const entry = list[groupIndex];
      if (directEvent(provider, event)) {
        if (owns(entry, options, event)) found.push({ handler: entry, groupIndex, hookIndex: 0 });
      } else if (isObject(entry) && Array.isArray(entry.hooks)) {
        for (let hookIndex = 0; hookIndex < entry.hooks.length; hookIndex++) {
          const handler = entry.hooks[hookIndex];
          if (owns(handler, options, event)) found.push({ handler, matcher: entry.matcher, groupIndex, hookIndex });
        }
      }
    }
    if (found.length) owned++;
    // Exactly what an install would write now: one handler, its timeout and its matcher.
    if (found.length === 1 && found[0].handler.timeout === timeoutFor(provider, event) &&
        (directEvent(provider, event) || found[0].matcher === MATCHER[provider][event])) {
      current++;
      const tail = commandTail(options, event);
      binaries.add(unquoteBinary(found[0].handler.command.slice(0, -tail.length)));
      entries.push({ event, command: found[0].handler.command, groupIndex: found[0].groupIndex, hookIndex: found[0].hookIndex });
    }
  }
  if (!owned) return { status: 'missing', binaries: [], entries: [] };
  if (current !== EVENT_NAMES[provider].length) return { status: 'update', binaries: [], entries: [] };
  return { status: 'connected', binaries: [...binaries], entries };
}

const toCamelEvent = event => event ? event[0].toLowerCase() + event.slice(1) : '';
const toSnakeEvent = event => event ? event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase() : '';

function canonicalPath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return '';
  let resolved = path.resolve(filePath);
  if (resolved === '/private/var' || resolved.startsWith('/private/var/')) resolved = resolved.slice('/private'.length);
  else if (resolved === '/private/tmp' || resolved.startsWith('/private/tmp/')) resolved = resolved.slice('/private'.length);
  return resolved;
}

function evaluateCodexTrustFromList(hooks, { configPath, hookPath, stateDir }) {
  if (!Array.isArray(hooks)) return;
  const targetConfig = canonicalPath(configPath);
  const matchOptions = { provider: 'codex', hookPath, stateDir };
  let matchedEvents = 0;
  for (const event of EVENT_NAMES.codex) {
    const camel = toCamelEvent(event);
    const matching = hooks.filter(item =>
      isObject(item) &&
      (item.eventName === camel || item.eventName === event) &&
      (!item.handlerType || item.handlerType === 'command') &&
      typeof item.sourcePath === 'string' && canonicalPath(item.sourcePath) === targetConfig &&
      owns({ type: 'command', command: item.command }, matchOptions, event));
    if (!matching.length) return 'untrusted';
    matchedEvents++;
    if (matching.some(item => item.enabled === false || !['trusted', 'managed'].includes(item.trustStatus))) {
      return 'untrusted';
    }
  }
  return matchedEvents === EVENT_NAMES.codex.length ? 'connected' : 'untrusted';
}

function evaluateCodexTrustFromToml(tomlText, { configPath, entries }) {
  if (typeof tomlText !== 'string' || !Array.isArray(entries) || !entries.length) return 'unverified';
  const states = new Map();
  let currentKey = '';
  let sawHooksState = false;
  const sectionRe = /^\s*\[hooks\.state\."((?:[^"\\]|\\.)*)"\]\s*(?:#.*)?$/;
  const otherSectionRe = /^\s*\[/;
  for (const rawLine of tomlText.split(/\r?\n/)) {
    const match = sectionRe.exec(rawLine);
    if (match) {
      sawHooksState = true;
      currentKey = match[1].replace(/\\(.)/g, '$1');
      if (!states.has(currentKey)) states.set(currentKey, {});
      continue;
    }
    if (otherSectionRe.test(rawLine)) {
      currentKey = '';
      continue;
    }
    if (!currentKey) continue;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const hashMatch = /^trusted_hash\s*=\s*"([^"]+)"/.exec(trimmed);
    if (hashMatch) states.get(currentKey).trustedHash = hashMatch[1];
    const enabledMatch = /^enabled\s*=\s*(true|false)\b/.exec(trimmed);
    if (enabledMatch) states.get(currentKey).enabled = enabledMatch[1] === 'true';
  }
  if (!sawHooksState) return 'unverified';
  const normalizedStates = new Map();
  for (const [key, state] of states) {
    const split = /^([\s\S]+):([a-z0-9_]+):(\d+):(\d+)$/.exec(key);
    if (split) {
      normalizedStates.set(`${canonicalPath(split[1])}:${split[2]}:${split[3]}:${split[4]}`, state);
    }
  }
  const targetConfig = canonicalPath(configPath);
  for (const entry of entries) {
    const lookup = `${targetConfig}:${toSnakeEvent(entry.event)}:${entry.groupIndex}:${entry.hookIndex}`;
    const state = normalizedStates.get(lookup);
    if (!state || !state.trustedHash || state.enabled === false) return 'untrusted';
  }
  // A stored hash can describe a previous command at the same position.
  // Only the running Codex version can confirm its effective trust decision.
  return 'unverified';
}

async function codexBinary({ codexPath, homeDir = os.homedir(), env = process.env } = {}) {
  const binName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const codexDir = providerConfigDir('codex', { homeDir, env });
  const candidates = [];
  if (typeof codexPath === 'string' && codexPath) candidates.push(codexPath);
  candidates.push(path.join(codexDir, 'packages', 'app-server-daemon', 'current', 'bin', binName));
  const envDirs = (typeof env?.PATH === 'string' ? env.PATH.split(path.delimiter) : []).filter(dir => path.isAbsolute(dir));
  const nvmDirs = await nvmBinDirs(homeDir);
  const extraDirs = [...envDirs, ...nvmDirs, '/opt/homebrew/bin', '/usr/local/bin', path.join(homeDir, '.local', 'bin')];
  for (const dir of extraDirs) candidates.push(path.join(dir, binName));
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* try next candidate */ }
  }
}

function listCodexHooksRpc(bin, { env = process.env, timeoutMs = CODEX_TRUST_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(bin, ['app-server', '--listen', 'stdio://'], {
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let buffer = '';
    let listed = false;
    let killTimer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* ignore */ }
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 250);
      killTimer.unref?.();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    child.on('error', () => finish(null));
    child.stdin.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) { finish(null); return; }
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method) continue;
        if (msg.id === 1 && !listed) {
          if (msg.error) { finish(null); return; }
          listed = true;
          try {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: {} }) + '\n');
          } catch {
            finish(null);
          }
        } else if (msg.id === 2) {
          if (msg.error || !isObject(msg.result)) { finish(null); return; }
          const hooks = [];
          if (Array.isArray(msg.result.data)) {
            for (const group of msg.result.data) {
              if (Array.isArray(group?.hooks)) hooks.push(...group.hooks);
            }
          } else if (Array.isArray(msg.result.hooks)) {
            hooks.push(...msg.result.hooks);
          } else {
            finish(null);
            return;
          }
          finish(hooks);
          return;
        }
      }
    });
    try {
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'agent-session-monitor', version: require('../package.json').version }, capabilities: { experimentalApi: true } },
      }) + '\n');
    } catch {
      finish(null);
    }
  });
}

async function resolveCodexTrust(entry, { configPath, hookPath, stateDir, homeDir, env, codexPath, listCodexHooks }) {
  const tomlPath = path.join(path.dirname(configPath), 'config.toml');
  let hooksList = null;
  if (typeof listCodexHooks === 'function') {
    try { hooksList = await listCodexHooks({ configPath, homeDir, env }); } catch { hooksList = null; }
  } else {
    const bin = await codexBinary({ codexPath, homeDir, env });
    if (bin) {
      const rpcEnv = { ...env, ...(homeDir ? { HOME: homeDir } : {}) };
      hooksList = await listCodexHooksRpc(bin, { env: rpcEnv });
    }
  }
  if (Array.isArray(hooksList)) {
    return evaluateCodexTrustFromList(hooksList, { configPath, hookPath, stateDir });
  }
  const tomlText = await fs.readFile(tomlPath, 'utf8').catch(() => '');
  return evaluateCodexTrustFromToml(tomlText, { configPath, entries: entry.entries });
}

// Read-only. Only handlers that an install or removal would recognise as this
// extension's count, so a user's own hooks never read as a connection.
async function hookStatus({
  provider,
  hookPath,
  stateDir,
  homeDir = os.homedir(),
  env = process.env,
  verifyFiles = false,
  checkTrust = false,
  forceTrust = false,
  codexPath,
  listCodexHooks,
}) {
  try {
    const configPath = getConfigPath(provider, {homeDir, env});
    const cacheKey = JSON.stringify([provider, configPath, hookPath, stateDir]);
    const configStat = await fs.stat(configPath).catch(() => null);
    if (!configStat) {
      statusCache.delete(cacheKey);
      return 'missing';
    }
    const configStamp = statStamp(configStat);
    let entry = statusCache.get(cacheKey);
    if (!entry || entry.configStamp !== configStamp) {
      const text = await fs.readFile(configPath, 'utf8');
      const config = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text);
      const evaluated = evaluateConfigStatus(config, { provider, hookPath, stateDir });
      entry = {
        configPath,
        configStamp,
        configStatus: evaluated.status,
        binaries: evaluated.binaries,
        entries: evaluated.entries,
        verifyStamp: undefined,
        verifyResult: undefined,
        verifiedAt: 0,
        trustKey: undefined,
        trustResult: undefined,
        trustedAt: 0,
      };
      statusCache.delete(cacheKey);
      statusCache.set(cacheKey, entry);
      if (statusCache.size > STATUS_CACHE_LIMIT) statusCache.delete(statusCache.keys().next().value);
    }
    if (entry.configStatus !== 'connected') return entry.configStatus;
    // Codex runs a registered hook only once the user trusted it; that is checked even
    // when the caller does not also ask for the hook files to be verified.
    const wantsTrust = provider === 'codex' && checkTrust;
    if (!verifyFiles && !wantsTrust) return entry.configStatus;
    const now = Date.now();
    let vStamp = 'unverified';
    if (verifyFiles) {
      if (entry.binaries.some(nodePath => !nodePath || !path.isAbsolute(nodePath))) return 'update';
      const targetPaths = [hookPath, ...entry.binaries];
      const targetStats = await Promise.all(targetPaths.map(file => fs.stat(file).catch(() => null)));
      if (targetStats.some(stat => !stat)) {
        entry.verifyStamp = undefined;
        return 'update';
      }
      vStamp = targetStats.map(statStamp).join('|');
      let verifyResult = entry.verifyResult;
      if (entry.verifyStamp !== vStamp || now - entry.verifiedAt >= VERIFY_TTL_MS) {
        let verified = true;
        try {
          await fs.access(hookPath, fs.constants.R_OK);
          for (const nodePath of entry.binaries) {
            await fs.access(nodePath, fs.constants.X_OK);
          }
        } catch {
          verified = false;
        }
        entry.verifyStamp = vStamp;
        entry.verifyResult = verified ? 'connected' : 'update';
        entry.verifiedAt = now;
        verifyResult = entry.verifyResult;
      }
      if (verifyResult !== 'connected' || !wantsTrust) return verifyResult;
    }
    const tomlPath = path.join(path.dirname(configPath), 'config.toml');
    const tomlStamp = statStamp(await fs.stat(tomlPath).catch(() => null));
    const trustKey = `${vStamp}|${tomlStamp}|${codexPath || ''}|${typeof listCodexHooks === 'function' ? 'custom' : 'rpc'}`;
    const trustTtl = entry.trustResult === 'connected' ? TRUST_TTL_MS : 15000;
    if (!forceTrust && typeof listCodexHooks !== 'function' && entry.trustKey === trustKey && now - entry.trustedAt < trustTtl) {
      return entry.trustResult;
    }
    const trustResult = await resolveCodexTrust(entry, { configPath, hookPath, stateDir, homeDir, env, codexPath, listCodexHooks });
    if (typeof listCodexHooks !== 'function') {
      entry.trustKey = trustKey;
      entry.trustResult = trustResult;
      entry.trustedAt = Date.now();
    }
    return trustResult;
  } catch {
    return 'missing';
  }
}

module.exports = {
  configureHooks,
  getConfigPath,
  hookStatus,
  unquoteBinary,
  evaluateCodexTrustFromList,
  evaluateCodexTrustFromToml,
  codexBinary,
};
