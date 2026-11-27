'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { stripControlBidi, nvmBinDirs } = require('./shared.cjs');
const { phrase } = require('../media/i18n.js');

const execute = promisify(execFile);
const maxBytes = 2 * 1024 * 1024;
const timeout = 12000;
const WEEK = 10080;
// Messages are English text; the panel shows them in the display language.
const unavailable = message => ({status: 'unavailable', windows: [], message});

function timestamp(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    const millis = value < 1e11 ? value * 1000 : value;
    if (millis <= 8640000000000000) return millis;
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const millis = Date.parse(value);
    if (Number.isFinite(millis)) return millis;
  }
}

// A window is named by what it limits ('' for the whole account) and its period: minutes,
// a known period, or the provider's own word. Neither is in a display language.
function addWindow(windows, name, period, percent, reset, kind = 'used') {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return;
  const resetsAt = timestamp(reset);
  windows.push({name, ...(period ? {period} : {}), percent, kind, ...(resetsAt ? {resetsAt} : {})});
}

function shortLabel(value) {
  return stripControlBidi(value, { collapseSpaces: true, max: 80 });
}

function snapshot(windows, plan, now) {
  if (!windows.length) return unavailable(phrase('Could not read subscription limits. Check that you are signed in to the tool.'));
  const rawPlan = shortLabel(plan);
  const plans = {max: 'Max', max5x: 'Max 5x', max20x: 'Max 20x', pro: 'Pro', prolite: 'Pro Lite', plus: 'Plus',
    team: 'Team', enterprise: 'Enterprise', business: 'Business', free: 'Free', edu: 'Edu', go: 'Go',
    ultra: 'Ultra', googleaiultra: 'AI Ultra', googleaipro: 'AI Pro'};
  const planKey = rawPlan.toLowerCase().replace(/[-_ ]/g, '');
  const label = Object.hasOwn(plans, planKey) ? plans[planKey] : rawPlan;
  return {status: 'ready', windows, updatedAt: now(), ...(label ? {plan: label} : {})};
}

function claudeQuota(data, now) {
  const windows = [];
  const limits = data?.rate_limits;
  if (limits && data.rate_limits_available !== false) {
    const named = {five_hour: ['', 300], seven_day: ['', WEEK], seven_day_sonnet: ['Sonnet', WEEK],
      seven_day_opus: ['Opus', WEEK], seven_day_oauth_apps: ['OAuth apps', WEEK]};
    for (const [key, [name, period]] of Object.entries(named)) {
      addWindow(windows, name, period, limits[key]?.utilization, limits[key]?.resets_at);
    }
    for (const model of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
      const name = shortLabel(model?.display_name);
      if (name && !windows.some(window => window.name === name && window.period === WEEK)) {
        addWindow(windows, name, WEEK, model.utilization, model.resets_at);
      }
    }
    if (!windows.length && Array.isArray(limits.limits)) {
      for (const row of limits.limits) {
        const scope = shortLabel(row?.scope?.model?.display_name) || shortLabel(row?.scope?.surface?.display_name);
        const period = row?.kind === 'session' ? 'session' : row?.group === 'weekly' ? WEEK : shortLabel(row?.group);
        if (period) addWindow(windows, scope, period, row.percent, row.resets_at);
      }
    }
  }
  return snapshot(windows, data?.subscription_type, now);
}

const windowPeriod = (minutes, fallback) => Number.isSafeInteger(minutes) && minutes > 0 ? minutes : fallback;

function codexQuota(data, now) {
  const windows = [];
  const byId = data?.rateLimitsByLimitId;
  const base = byId?.codex || data?.rateLimits;
  function add(snapshot, name) {
    for (const key of ['primary', 'secondary']) {
      const entry = snapshot?.[key];
      if (entry) addWindow(windows, name, windowPeriod(entry.windowDurationMins, key), entry.usedPercent, entry.resetsAt);
    }
  }
  add(base, '');
  for (const [id, entry] of Object.entries(byId || {})) {
    if (id === 'codex' || entry === base || id === base?.limitId) continue;
    const name = shortLabel(entry?.limitName) || shortLabel(id);
    if (name) add(entry, name);
  }
  return snapshot(windows, base?.planType || data?.rateLimits?.planType, now);
}

function agyPeriod(bucket) {
  const periods = {weekly: 'weekly', daily: 'daily', monthly: 'monthly', hourly: 'hourly',
    fivehour: 300, fivehours: 300, '5hour': 300, '5hours': 300, '5h': 300};
  for (const value of [bucket.window, bucket.name]) {
    const key = shortLabel(value).toLowerCase().replace(/[-_ ]/g, '').replace(/limitremaining$/, '');
    if (Object.hasOwn(periods, key)) return periods[key];
  }
  return shortLabel(bucket.name) || shortLabel(bucket.window) || shortLabel(bucket.id);
}

function agyQuota(data, now) {
  const windows = [];
  const command = data?.command;
  if (command?.name === 'usage' && data.num_turns === 0 && Array.isArray(command.data?.groups)) {
    for (const group of command.data.groups) {
      for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
        if (!Number.isFinite(bucket?.remaining_fraction)) continue;
        const groupName = shortLabel(group.name);
        const period = agyPeriod(bucket);
        if (groupName || period) addWindow(windows, groupName, period, bucket.remaining_fraction * 100, bucket.reset_time, 'remaining');
      }
    }
  }
  return snapshot(windows, command?.data?.plan_tier, now);
}

async function isExecutableFile(candidate) {
  if (!candidate || !path.isAbsolute(candidate)) return false;
  try {
    await fs.access(candidate, fs.constants.X_OK);
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function binary(provider, options) {
  const configured = options[provider + 'Path'];
  const explicit = typeof configured === 'function' ? configured() : configured;
  if (explicit && await isExecutableFile(explicit)) return explicit;

  const name = process.platform === 'win32' ? provider + '.exe' : provider;
  const home = options.homeDir || os.homedir();
  const fromPath = (options.env?.PATH ?? process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute);
  const hasHome = typeof home === 'string' && path.isAbsolute(home);
  const staticHomeDirs = hasHome ? [
    path.join(home, '.local', 'bin'),
    ...(provider === 'claude' ? [path.join(home, '.claude', 'local')] : []),
    ...(provider === 'agy' ? [path.join(home, '.antigravity', 'antigravity', 'bin')] : []),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.fnm', 'current', 'bin'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.local', 'share', 'pnpm'),
  ] : [];

  const checked = new Set(explicit ? [explicit] : []);
  const searchDirs = async dirs => {
    for (const directory of dirs) {
      const candidate = path.join(directory, name);
      if (checked.has(candidate)) continue;
      checked.add(candidate);
      if (await isExecutableFile(candidate)) return candidate;
    }
  };

  const foundFast = await searchDirs([...fromPath, ...staticHomeDirs]);
  if (foundFast) return foundFast;

  const nvmDirs = hasHome ? await nvmBinDirs(home) : [];
  const foundSlow = await searchDirs([
    ...nvmDirs,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(provider === 'agy' ? ['/Applications/Antigravity.app/Contents/Resources/app/bin'] : []),
  ]);
  if (foundSlow) return foundSlow;

  throw Object.assign(new Error('Missing client'), {code: 'ENOENT'});
}

// The account clients speak newline-delimited JSON over stdin/stdout. Close our
// own short-lived process as soon as the requested reply arrives, even on timeout.
function exchange(file, args, options, first, handle) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {...options, stdio: ['pipe', 'pipe', 'ignore']});
    let pending = '';
    let received = 0;
    let ended = false;
    const timer = setTimeout(() => finish(new Error('Timeout')), options.timeout);
    function finish(error, result) {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        if (error) child.kill('SIGKILL');
        else {
          // EOF lets the client release its own resources after a successful read.
          const reaper = setTimeout(() => child.kill('SIGKILL'), 750);
          reaper.unref();
          child.once('close', () => clearTimeout(reaper));
        }
      }
      if (error) reject(error);
      else resolve(result);
    }
    function send(packet) {
      if (!ended) child.stdin.write(JSON.stringify(packet) + '\n');
    }
    child.on('error', finish);
    child.on('close', () => finish(new Error('Incomplete response')));
    child.stdin.on('error', finish);
    child.stdout.on('error', finish);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (ended) return;
      received += Buffer.byteLength(chunk);
      if (received > maxBytes) return finish(new Error('Response too large'));
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      try {
        for (const line of lines) {
          if (ended || !line.trim()) continue;
          // A client may print a warning or diagnostic line between protocol messages.
          let data;
          try { data = JSON.parse(line); } catch { continue; }
          handle(data, send, result => finish(null, result));
        }
      } catch (error) { finish(error); }
    });
    send(first);
  });
}

function readClaude(file, options) {
  const packet = (id, request) => ({type: 'control_request', request_id: id, request});
  return exchange(file, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--safe-mode', '--no-session-persistence', '--tools', ''], options,
    packet('quota-init', {subtype: 'initialize', hooks: {}, sdkMcpServers: []}), (data, send, done) => {
      if (data?.type !== 'control_response') return;
      const reply = data.response;
      if (!['quota-init', 'quota-read'].includes(reply?.request_id)) return;
      if (reply.subtype !== 'success') throw new Error('Unsupported or unauthorized');
      if (reply.request_id === 'quota-init') send(packet('quota-read', {subtype: 'get_usage', skip_behaviors: true}));
      else done(reply.response);
    });
}

function readCodex(file, options) {
  return exchange(file, ['app-server', '--listen', 'stdio://'], options, {id: 1, method: 'initialize',
    params: {clientInfo: {name: 'agent_session_monitor', title: 'Agent Session Monitor', version: '1'},
      capabilities: {experimentalApi: true}}}, (data, send, done) => {
    if (data?.id !== 1 && data?.id !== 2) return;
    if (data.error || !data.result) throw new Error('Unsupported or unauthorized');
    if (data.id === 1) {
      send({method: 'initialized'});
      send({id: 2, method: 'account/rateLimits/read', params: {}});
    } else done(data.result);
  });
}

function supportsAgyUsage(version) {
  const match = version.trim().match(/^(?:(?:Antigravity(?: CLI)?|agy)(?:\s+version)?\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/i);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 1 || major === 1 && (minor > 1 || minor === 1 && patch >= 11);
}

function createQuotaReader(options = {}) {
  const now = options.now || Date.now;
  const binaryCache = new Map();
  return async function readQuota(provider) {
    if (!['claude', 'codex', 'agy'].includes(provider)) return unavailable(phrase('This tool is not supported.'));
    const env = {...(options.env || process.env)};
    // A quota helper is a separate non-interactive client, never a nested chat.
    delete env.CLAUDECODE;
    const processOptions = {cwd: path.parse(os.homedir()).root, env, windowsHide: true,
      timeout: options.timeoutMs || timeout};
    const configured = options[provider + 'Path'];
    const explicit = typeof configured === 'function' ? (configured() || '') : (configured || '');
    const cacheKey = provider + '\0' + explicit + '\0' + (env.PATH ?? '');
    try {
      let file = binaryCache.get(cacheKey);
      if (!file) {
        file = await binary(provider, options);
        binaryCache.set(cacheKey, file);
      }
      const binDir = path.dirname(file);
      const currentPath = processOptions.env.PATH || '';
      const pathParts = currentPath ? currentPath.split(path.delimiter) : [];
      if (binDir && !pathParts.includes(binDir)) {
        processOptions.env.PATH = currentPath ? binDir + path.delimiter + currentPath : binDir;
      }
      if (provider === 'claude') return claudeQuota(await readClaude(file, processOptions), now);
      if (provider === 'codex') return codexQuota(await readCodex(file, processOptions), now);
      const commandOptions = {...processOptions, maxBuffer: maxBytes, killSignal: 'SIGKILL'};
      const version = await execute(file, ['--version'], commandOptions);
      // Older versions may interpret a slash command in print mode as a model prompt.
      if (!supportsAgyUsage(version.stdout)) return unavailable(phrase('Antigravity CLI 1.1.11 or later is required.'));
      const result = await execute(file, ['-p', '/usage', '--output-format', 'json'], commandOptions);
      return agyQuota(JSON.parse(result.stdout), now);
    } catch (error) {
      binaryCache.delete(cacheKey);
      return unavailable(error?.code === 'ENOENT' ? phrase('Could not find the local CLI to check usage.')
        : phrase('Could not get subscription usage. Check your sign-in and connection.'));
    }
  };
}

module.exports = {createQuotaReader};
