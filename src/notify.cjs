'use strict';

// Native macOS notification delivery (via AgentSessionNotifier.app UNUserNotificationCenter
// helper, with safe osascript fallback) and cross-window atomic claims so exactly one
// VS Code window announces a given session change.
const fs = require('node:fs/promises');
const fsRealSync = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const childProcess = require('node:child_process');
const { DAY, createLru, isObject, stripControlBidi } = require('./shared.cjs');

const PRUNE_INTERVAL = 3600000;
const DEFAULT_TIMEOUT_MS = 5000;
// First-run macOS UNUserNotificationCenter.requestAuthorization shows an interactive
// permission banner; keep --send alive long enough for the user to click Allow.
const SEND_TIMEOUT_MS = 35000;
const MAX_OUTPUT_BYTES = 65536;
const HELPER_MISS_TTL_MS = 60000;
const DEFAULT_HELPER_RELATIVE = path.join('native', 'AgentSessionNotifier.app', 'Contents', 'MacOS', 'AgentSessionNotifier');
const NOTIFICATIONS_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension';
const ALLOWED_URI_SCHEMES = new Set(['vscode:', 'vscode-insiders:', 'cursor:', 'antigravity:', 'vscodium:']);
const INTERRUPTION_LEVELS = new Set(['active', 'timeSensitive', 'passive']);

// Text only ever reaches AppleScript as run-handler arguments, never as source.
const SCRIPT = ['on run argv',
  'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)', 'end run'];

const clean = (value, max) => stripControlBidi(value, { keepNewlines: true, max });
const cleanSingleLine = (value, max) => stripControlBidi(value, { collapseSpaces: true, max });

const helperExistsCache = createLru(32);

function checkHelperExists(helperPath, fsSync) {
  const useCache = fsSync === fsRealSync;
  if (useCache) {
    const cached = helperExistsCache.get(helperPath);
    if (cached) {
      if (cached.unusable) return false;
      if (cached.exists || Date.now() - cached.at < HELPER_MISS_TTL_MS) {
        return cached.exists;
      }
    }
  }
  let exists = false;
  try {
    exists = Boolean(fsSync.existsSync(helperPath));
  } catch {
    exists = false;
  }
  if (useCache) {
    helperExistsCache.set(helperPath, { exists, at: Date.now() });
  }
  return exists;
}

function sanitizeUri(value) {
  const text = cleanSingleLine(value, 2048);
  if (!text) return '';
  try {
    const parsed = new URL(text);
    if (!ALLOWED_URI_SCHEMES.has(parsed.protocol) || !parsed.host) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function sanitizeAbsolutePath(value) {
  const text = cleanSingleLine(value, 4096);
  if (!text || !path.isAbsolute(text)) return '';
  return text;
}

function defaultHelperPath(extensionPath) {
  return extensionPath
    ? path.join(extensionPath, DEFAULT_HELPER_RELATIVE)
    : path.resolve(__dirname, '..', DEFAULT_HELPER_RELATIVE);
}

function resolveHelperPath(options) {
  if (options.helperPath === false || options.helperPath === null) return '';
  if (typeof options.helperPath === 'string') return options.helperPath;
  // Preserve backward compatibility when callers/tests inject a custom execFile
  // without specifying helperPath or spawn (expecting the osascript path).
  if (options.execFile && options.execFile !== childProcess.execFile && !options.spawn) return '';
  if (typeof options.extensionPath === 'string' && options.extensionPath) {
    return defaultHelperPath(options.extensionPath);
  }
  return defaultHelperPath();
}

function runNativeHelper(helperPath, args, input, {
  spawn = childProcess.spawn,
  fsSync = fsRealSync,
  checkExists = fsSync !== fsRealSync || spawn === childProcess.spawn,
  timeout = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!helperPath) return Promise.resolve({ ok: false, missing: true, permission: 'unavailable' });
  if (checkExists && !checkHelperExists(helperPath, fsSync)) {
    return Promise.resolve({ ok: false, missing: true, permission: 'unavailable' });
  }

  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const isUnusableCode = code => code === 'ENOEXEC' || code === 'EBADARCH';
    const isMissingCode = code => code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || isUnusableCode(code);
    const handleSpawnError = error => {
      const code = error?.code;
      const missing = isMissingCode(code);
      if (fsSync === fsRealSync) {
        if (isUnusableCode(code)) {
          helperExistsCache.set(helperPath, { exists: false, unusable: true, at: Date.now() });
        } else if (missing) {
          helperExistsCache.delete(helperPath);
        }
      }
      finish({
        ok: false,
        missing,
        permission: 'unknown',
        error: error instanceof Error ? error.message : String(error),
      });
    };

    let child;
    try {
      child = spawn(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      return handleSpawnError(error);
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += String(chunk).slice(0, MAX_OUTPUT_BYTES - stdout.length);
    });
    child.stderr?.on('data', chunk => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += String(chunk).slice(0, MAX_OUTPUT_BYTES - stderr.length);
    });
    child.stdin?.on('error', () => { /* Ignore EPIPE if helper exits before reading stdin. */ });

    timer = setTimeout(() => {
      try { child.kill?.('SIGKILL'); } catch { /* Ignore kill race. */ }
      finish({ ok: false, permission: 'unknown', error: 'timed out' });
    }, timeout);

    child.on('error', handleSpawnError);

    child.on('close', code => {
      const text = stdout.trim();
      if (text) {
        try {
          const parsed = JSON.parse(text);
          if (isObject(parsed)) {
            return finish({
              ok: parsed.ok === true,
              permission: typeof parsed.permission === 'string' ? parsed.permission : 'unknown',
              ...(typeof parsed.id === 'string' && { id: parsed.id }),
              ...(typeof parsed.error === 'string' && { error: parsed.error }),
              ...(typeof parsed.alertSetting === 'string' && { alertSetting: parsed.alertSetting }),
              ...(typeof parsed.soundSetting === 'string' && { soundSetting: parsed.soundSetting }),
              parsed: true,
            });
          }
        } catch { /* Fall through to error handling below. */ }
      }
      finish({
        ok: false,
        permission: 'unknown',
        error: stderr.trim() || 'helper exited with code ' + String(code ?? 'unknown'),
      });
    });

    try {
      if (input !== undefined && child.stdin) child.stdin.end(JSON.stringify(input));
      else child.stdin?.end?.();
    } catch { /* Handled via error/close events. */ }
  });
}

function osascriptNotify({ title, subtitle, body } = {}, {
  execFile = childProcess.execFile,
  timeout = DEFAULT_TIMEOUT_MS,
} = {}) {
  const args = [...SCRIPT.flatMap(line => ['-e', line]), '--', clean(body, 600), clean(title, 120), clean(subtitle, 160)];
  return new Promise(resolve => {
    try {
      execFile('/usr/bin/osascript', args, { timeout, windowsHide: true }, error => {
        if (error) {
          resolve({ ok: false, permission: 'unknown', backend: 'osascript', error: error instanceof Error ? error.message : String(error) });
        } else {
          resolve({ ok: true, permission: 'unknown', backend: 'osascript' });
        }
      });
    } catch (error) {
      resolve({ ok: false, permission: 'unknown', backend: 'osascript', error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function buildNativePayload(payload = {}) {
  const id = cleanSingleLine(payload?.id, 128);
  const group = cleanSingleLine(payload?.group, 128);
  const title = clean(payload?.title, 120);
  const subtitle = clean(payload?.subtitle, 160);
  const body = clean(payload?.body, 600);
  const logoPath = sanitizeAbsolutePath(payload?.logoPath);
  const openUri = sanitizeUri(payload?.openUri);
  const workspaceRoot = sanitizeAbsolutePath(payload?.workspaceRoot);
  const appName = cleanSingleLine(payload?.appName, 80);
  const interruptionLevel = INTERRUPTION_LEVELS.has(payload?.interruptionLevel) ? payload.interruptionLevel : undefined;

  return {
    ...(id && { id }),
    ...(group && { group }),
    title,
    subtitle,
    body,
    ...(logoPath && { logoPath }),
    ...(openUri && { openUri }),
    ...(workspaceRoot && { workspaceRoot }),
    ...(appName && { appName }),
    ...(interruptionLevel && { interruptionLevel }),
    sound: payload?.sound !== false,
  };
}

async function deliverNotification(payload = {}, options = {}) {
  const {
    execFile = childProcess.execFile,
    spawn = childProcess.spawn,
    fsSync = fsRealSync,
    platform = process.platform,
    timeout,
  } = options;
  if (platform !== 'darwin') return { ok: false, permission: 'unsupported', backend: 'none' };

  const helperPath = resolveHelperPath(options);
  if (helperPath) {
    const native = await runNativeHelper(helperPath, ['--send'], buildNativePayload(payload), {
      spawn, fsSync, timeout: timeout ?? SEND_TIMEOUT_MS,
    });
    if (native.ok) {
      return {
        ok: true,
        permission: native.permission || 'granted',
        backend: 'native',
        ...(native.id && { id: native.id }),
        ...(native.alertSetting && { alertSetting: native.alertSetting }),
      };
    }
    // Never fall back to osascript when macOS explicitly denied notifications:
    // osascript would also drop silently and hide the permission state from the caller.
    if (native.permission === 'denied') {
      return {
        ok: false,
        permission: 'denied',
        backend: 'native',
        ...(native.error && { error: native.error }),
      };
    }
    if (!native.missing && native.parsed) {
      return {
        ok: false,
        permission: native.permission || 'unknown',
        backend: 'native',
        ...(native.error && { error: native.error }),
      };
    }
    // A present helper that did not answer in time is most likely still showing macOS's
    // first-run permission prompt. osascript would post a logo-less banner that cannot
    // route its click, and hide that the prompt went unanswered.
    if (!native.missing && native.error === 'timed out') {
      return { ok: false, permission: 'unknown', backend: 'native', error: native.error };
    }
  }

  return osascriptNotify(payload, { execFile, timeout: timeout ?? DEFAULT_TIMEOUT_MS });
}

async function systemNotify(payload = {}, options = {}) {
  const result = await deliverNotification(payload, options);
  return result.ok === true;
}

async function clearNotifications(target = {}, options = {}) {
  const {
    spawn = childProcess.spawn,
    fsSync = fsRealSync,
    platform = process.platform,
    timeout = DEFAULT_TIMEOUT_MS,
  } = options;
  if (platform !== 'darwin') return false;

  const helperPath = resolveHelperPath(options);
  if (!helperPath) return false;

  const ids = Array.isArray(target?.ids)
    ? target.ids.map(item => cleanSingleLine(item, 128)).filter(Boolean).slice(0, 64)
    : [];
  // Several thread groups in one call (a multi-root window and each of its folders).
  // `group` stays the first of them for a helper built before `groups` existed.
  const groups = [...new Set([target?.group, ...(Array.isArray(target?.groups) ? target.groups : [])]
    .map(item => cleanSingleLine(item, 128)).filter(Boolean))].slice(0, 32);
  const group = groups[0];
  const all = target?.all === true;
  if (!ids.length && !group && !all) return false;

  const payload = {
    ...(ids.length && { ids }),
    ...(group && { group }),
    ...(groups.length > 1 && { groups }),
    ...(all && { all: true }),
  };
  const result = await runNativeHelper(helperPath, ['--clear'], payload, { spawn, fsSync, timeout });
  return result.ok === true;
}

async function notificationPermission(options = {}) {
  const {
    spawn = childProcess.spawn,
    fsSync = fsRealSync,
    platform = process.platform,
    timeout = DEFAULT_TIMEOUT_MS,
  } = options;
  if (platform !== 'darwin') return { ok: false, permission: 'unsupported', backend: 'none' };

  const helperPath = resolveHelperPath(options);
  if (!helperPath) return { ok: false, permission: 'unavailable', backend: 'none' };

  const result = await runNativeHelper(helperPath, ['--status'], undefined, { spawn, fsSync, timeout });
  if (result.missing) return { ok: false, permission: 'unavailable', backend: 'none' };
  return {
    ok: result.ok === true,
    permission: result.permission || 'unknown',
    backend: 'native',
    ...(result.alertSetting && { alertSetting: result.alertSetting }),
    ...(result.soundSetting && { soundSetting: result.soundSetting }),
    ...(result.error && { error: result.error }),
  };
}

function createClaims(directory, { now = Date.now } = {}) {
  let prunedAt = -Infinity;
  const markerFor = id => path.join(directory, createHash('sha256').update(String(id)).digest('hex'));

  async function prune() {
    const cutoff = now() - DAY;
    const names = await fs.readdir(directory).catch(() => []);
    await Promise.all(names.filter(name => /^[a-f0-9]{64}$/.test(name)).map(async name => {
      const file = path.join(directory, name);
      try {
        if ((await fs.lstat(file)).mtimeMs < cutoff) await fs.unlink(file);
      } catch { /* Another window may have pruned it first. */ }
    }));
  }

  async function claim(id) {
    const file = markerFor(id);
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      // Only an existing marker means another window has announced this change.
      // Any other storage failure announces here rather than losing the alert.
      if (error?.code === 'EEXIST') return false;
    }
    if (now() - prunedAt >= PRUNE_INTERVAL) {
      prunedAt = now();
      void prune().catch(() => {});
    }
    return true;
  }

  // Safely releases a claim marker when notification delivery fails so a retry
  // or another window can announce the change instead of dropping it forever.
  async function release(id) {
    try {
      await fs.unlink(markerFor(id));
      return true;
    } catch {
      return false;
    }
  }

  function stamp() {
    try {
      const st = fsRealSync.statSync(directory, { bigint: true });
      return st.mtimeNs + ':' + st.ctimeNs + ':' + st.ino;
    } catch {
      return '';
    }
  }

  return { claim, release, prune, stamp };
}

// An unfocused window waits before claiming, so a focused window that lists the
// same session shows its in-window toast instead. A window that sees the session
// only as another folder's request waits longer than the session's own window.
function createNotifier({
  directory,
  helperPath,
  extensionPath,
  execFile,
  spawn,
  fsSync,
  platform,
  now,
  delays = { local: 1500, remote: 3000 },
} = {}) {
  const claims = createClaims(directory, { now });
  const options = { helperPath, extensionPath, execFile, spawn, fsSync, platform };
  return {
    ...claims,
    delays,
    show: content => systemNotify(content, options),
    deliver: content => deliverNotification(content, options),
    clear: target => clearNotifications(target, options),
    permission: () => notificationPermission(options),
  };
}

module.exports = {
  clean,
  NOTIFICATIONS_SETTINGS_URL,
  defaultHelperPath,
  systemNotify,
  deliverNotification,
  clearNotifications,
  notificationPermission,
  createClaims,
  createNotifier,
};
