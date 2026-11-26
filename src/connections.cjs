'use strict';

const path = require('node:path');
const { PROVIDERS } = require('./model.cjs');
const { VENDORS } = require('./shared.cjs');

const HOOK_LABELS = Object.freeze({
  connected: '연결됨',
  untrusted: '신뢰 필요 (/hooks)',
  unverified: '훅 신뢰 상태 확인 필요',
  update: '업데이트 필요',
  missing: '연결 안 됨',
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
    const copy = '/hooks 복사';
    const recheck = '다시 확인';
    const picked = await vscode.window.showInformationMessage(
      'Codex CLI에서 /hooks를 실행해 agent-session-monitor 훅의 신뢰 상태를 확인한 뒤 다시 확인을 눌러 주세요.',
      copy,
      recheck,
    );
    if (picked === copy && vscode.env?.clipboard?.writeText) {
      await settle(vscode.env.clipboard.writeText('/hooks'));
      void settle(vscode.window.showInformationMessage('"/hooks" 명령을 클립보드에 복사했습니다. Codex CLI에 붙여 넣어 훅을 신뢰해 주세요.'));
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
    const done = install ? '연결 설정을 저장했습니다.' : '상태 훅 연결을 해제했습니다.';
    const failed = id => PROVIDERS[id] + ' 연결 설정을 바꾸지 못했습니다. ';
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
      return { id, label, description: HOOK_LABELS[state] + (installed(id) ? '' : ' · VS Code 확장 없음'), picked };
    });
    const chosen = await vscode.window.showQuickPick(items, { canPickMany: true,
      title: install ? '상태를 연결할 에이전트' : '연결을 해제할 에이전트',
      placeHolder: install ? '선택한 도구에 상태 훅을 설치하거나 갱신합니다.' : '선택한 도구에서 이 확장의 상태 훅을 제거합니다.' });
    const selected = Array.isArray(chosen) ? chosen.map(item => item?.id).filter(id => Object.hasOwn(PROVIDERS, id)) : [];
    if (!selected.length) return;
    const outcomes = await applyHooks(action, selected);
    await refreshConnections({ force: true });
    const succeeded = outcomes.filter(outcome => !outcome.error);
    const parts = [];
    if (succeeded.length) parts.push(succeeded.map(outcome => PROVIDERS[outcome.provider]).join(', ') + ' ' + done);
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
