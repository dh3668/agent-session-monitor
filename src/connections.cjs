'use strict';

const path = require('node:path');
const { PROVIDERS } = require('./model.cjs');
const { VENDORS } = require('./shared.cjs');
const { t, phrase } = require('../media/i18n.js');

const HOOK_LABELS = Object.freeze({
  connected: phrase('Connected'),
  untrusted: phrase('Needs trust (/hooks)'),
  unverified: phrase('Hook trust needs checking'),
  update: phrase('Update needed'),
  missing: phrase('Not connected'),
});

function createConnections({
  vscode,
  context,
  root,
  directory,
  codexPath,
  hookStatus,
  configureHooks,
  prepareRuntime,
  nodeExecutable,
  isAlive,
  render,
  log,
  reason,
  settle,
}) {
  let hookStates = {}, connectionsAt = 0, connectionRun, connectionAgain = false, forceNext = false;

  function connectionView() {
    const view = {};
    for (const id of Object.keys(PROVIDERS)) {
      const state = hookStates[id];
      if (state !== 'missing') view[id] = state;
      else if (!vscode.extensions.getExtension(VENDORS[id])) view[id] = 'absent';
      else view[id] = context.globalState.get('connectMuted:' + id) ? 'muted' : 'missing';
    }
    return view;
  }

  // Read-only check of each tool's settings for this extension's hooks.
  function refreshConnections({ force = false } = {}) {
    if (!isAlive()) return Promise.resolve();
    if (force) forceNext = true;
    if (connectionRun) { connectionAgain = true; return connectionRun; }
    connectionRun = (async () => {
      do {
        connectionAgain = false;
        const forceTrust = forceNext;
        forceNext = false;
        connectionsAt = Date.now();
        const ids = Object.keys(PROVIDERS);
        const resolvedCodexPath = typeof codexPath === 'function' ? codexPath() : codexPath;
        const options = {
          hookPath: path.join(root, 'runtime', 'hook.cjs'),
          stateDir: directory,
          verifyFiles: true,
          checkTrust: true,
          ...(resolvedCodexPath && { codexPath: resolvedCodexPath }),
          ...(forceTrust && { forceTrust: true }),
        };
        const states = await Promise.all(ids.map(provider => Promise.resolve(hookStatus({ provider, ...options })).catch(() => 'missing')));
        if (!isAlive()) return;
        hookStates = Object.fromEntries(ids.map((id, at) => [id, states[at]]));
        // Once a tool is connected, removing it later shows the prompt again.
        for (const id of ids) {
          if (hookStates[id] !== 'missing' && context.globalState.get('connectMuted:' + id)) {
            void settle(context.globalState.update('connectMuted:' + id, undefined));
          }
        }
        render();
      } while (connectionAgain && isAlive());
    })().catch(() => {}).finally(() => {
      connectionRun = undefined;
      if (connectionAgain && isAlive()) void refreshConnections();
    });
    return connectionRun;
  }

  async function refreshRuntime() {
    try {
      await refreshConnections();
      // An upgraded extension also upgrades the deployed hook. Unchanged files stay as they are.
      if (Object.values(hookStates).some(state => state !== 'missing')) {
        await prepareRuntime(root, context.extensionPath);
        void refreshConnections();
      }
    } catch (error) {
      log('runtime', reason(error));
    }
  }

  async function muteConnect(provider) {
    if (hookStates[provider] !== 'missing') return;
    await settle(context.globalState.update('connectMuted:' + provider, true));
    render();
  }

  async function showTrustGuide(provider) {
    if (provider !== 'codex') return;
    const copy = t('Copy /hooks');
    const recheck = t('Check Again');
    const picked = await vscode.window.showInformationMessage(
      t('Run /hooks in the Codex CLI, make sure the agent-session-monitor hooks are trusted, then press Check Again.'),
      copy,
      recheck,
    );
    if (picked === copy && vscode.env?.clipboard?.writeText) {
      await settle(vscode.env.clipboard.writeText('/hooks'));
      void settle(vscode.window.showInformationMessage(t('Copied "/hooks" to the clipboard. Paste it into the Codex CLI and trust the hooks.')));
    } else if (picked === recheck) {
      await refreshConnections({ force: true });
    }
  }

  async function applyHooks(action, providers) {
    const install = action === 'install';
    let runtime, nodePath, failure;
    try {
      runtime = install ? await prepareRuntime(root, context.extensionPath) :
        { hookPath: path.join(root, 'runtime/hook.cjs'), stateDir: directory };
      if (install) nodePath = await nodeExecutable();
    } catch (error) { failure = error; }
    const outcomes = [];
    for (const provider of providers) {
      if (failure) { outcomes.push({ provider, error: failure }); continue; }
      try { outcomes.push({ provider, result: await configureHooks({ action, provider, nodePath, ...runtime }) }); }
      catch (error) { outcomes.push({ provider, error }); }
    }
    return outcomes;
  }

  async function configure(action, provider) {
    const install = action === 'install';
    const done = install ? t('Saved the connection settings.') : t('Disconnected the status hooks.');
    const doneFor = names => install ? t('{0}: connection settings saved.', names) : t('{0}: status hooks disconnected.', names);
    const failed = id => t('Could not change the {0} connection settings.', PROVIDERS[id]) + ' ';
    if (Object.hasOwn(PROVIDERS, provider)) {
      const [{ result, error }] = await applyHooks(action, [provider]);
      if (error) void settle(vscode.window.showErrorMessage(failed(provider) + reason(error)));
      else void settle(vscode.window.showInformationMessage([PROVIDERS[provider], done, result?.notice].filter(Boolean).join(' · ')));
      return refreshConnections({ force: true });
    }
    await refreshConnections({ force: true });
    const installed = id => Boolean(vscode.extensions.getExtension(VENDORS[id]));
    const items = Object.entries(PROVIDERS).map(([id, label]) => {
      const state = Object.hasOwn(HOOK_LABELS, hookStates[id] ?? '') ? hookStates[id] : 'missing';
      const picked = install ? state === 'update' || (state === 'missing' && installed(id) && !context.globalState.get('connectMuted:' + id)) :
        state !== 'missing';
      return { id, label, description: t(HOOK_LABELS[state]) + (installed(id) ? '' : ' · ' + t('VS Code extension not installed')), picked };
    });
    const chosen = await vscode.window.showQuickPick(items, { canPickMany: true,
      title: install ? t('Agents to connect') : t('Agents to disconnect'),
      placeHolder: install ? t('Installs or updates the status hooks in the selected tools.') : t("Removes this extension's status hooks from the selected tools.") });
    const selected = Array.isArray(chosen) ? chosen.map(item => item?.id).filter(id => Object.hasOwn(PROVIDERS, id)) : [];
    if (!selected.length) return;
    const outcomes = await applyHooks(action, selected);
    await refreshConnections({ force: true });
    const succeeded = outcomes.filter(outcome => !outcome.error);
    const parts = [];
    if (succeeded.length) parts.push(doneFor(succeeded.map(outcome => PROVIDERS[outcome.provider]).join(', ')));
    // Each notice already names its tool.
    for (const outcome of succeeded) if (outcome.result?.notice) parts.push(outcome.result.notice);
    for (const outcome of outcomes) if (outcome.error) parts.push(failed(outcome.provider) + reason(outcome.error));
    const message = parts.join(' · ');
    void settle(succeeded.length === outcomes.length ? vscode.window.showInformationMessage(message) : vscode.window.showErrorMessage(message));
  }

  function hookState(provider) {
    return hookStates[provider];
  }

  function hasUntrusted() {
    return ['untrusted', 'unverified'].includes(hookStates.codex);
  }

  function isDue(now = Date.now(), intervalMs = 60000) {
    const effective = hasUntrusted() ? Math.min(intervalMs, 15000) : intervalMs;
    return now - connectionsAt >= effective;
  }

  return {
    connectionView,
    refreshConnections,
    refreshRuntime,
    muteConnect,
    showTrustGuide,
    configure,
    hookState,
    hasUntrusted,
    isDue,
  };
}

module.exports = { createConnections };
