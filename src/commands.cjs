'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PROVIDERS, STATES, cleanLabel, readSessions } = require('./model.cjs');
const { arrangeSessions, dismissalFor, dismissableChildren, compareTriage, triageRank } = require('./workspace-sessions.cjs');
const { VENDORS, isUnderDir } = require('./shared.cjs');
const { errorLabel, modelName } = require('../media/format.js');
const { t } = require('../media/i18n.js');

const ACTIVE = new Set(['working', 'approval', 'input']);
// Control characters and direction overrides (U+202A-U+202E, U+2066-U+2069), built from
// code points so the source itself never carries an invisible character.
const UNSAFE_TEXT = new RegExp('[\\x00-\\x1f\\x7f' + String.fromCharCode(0x202a) + '-' + String.fromCharCode(0x202e) +
  String.fromCharCode(0x2066) + '-' + String.fromCharCode(0x2069) + ']', 'u');
// Only an editor's own app link may be handed to the system to focus a window.
const WINDOW_URI_SCHEMES = new Set(['vscode:', 'vscode-insiders:', 'cursor:', 'antigravity:', 'vscodium:']);
function editorWindowUri(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || UNSAFE_TEXT.test(value)) return;
  try {
    const parsed = new URL(value);
    return WINDOW_URI_SCHEMES.has(parsed.protocol) && parsed.host ? value : undefined;
  } catch { return; }
}
const validFolder = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) &&
  !UNSAFE_TEXT.test(value);
// A folder named by a notification link may contain or be contained by its session's folder,
// but never be so broad that any link could open the home folder or the disk root.
const related = (folder, other) => isUnderDir(other, folder) || isUnderDir(folder, other);
const tooBroad = folder => {
  const home = path.resolve(os.homedir());
  return folder === path.parse(folder).root || isUnderDir(home, folder);
};

function createActions({
  vscode,
  context,
  prefix,
  viewId,
  directory,
  openSession,
  startSession,
  openUsage,
  findWindowForFolder,
  panel,
  receipts,
  alerts,
  connections,
  isAlive,
  getWorkspaceRevision,
  getRows,
  getElsewhere,
  getActiveScope,
  getBridge,
  getPreferences,
  setPreferences,
  getShownProviderOrder,
  pins,
  getAlias,
  getTitle,
  otherFolders,
  workspaceRootFor,
  annotateLifecycle,
  projectRows,
  saveLayout,
  render,
  refresh,
  updateQuotas,
  settle,
}) {
  let recentOpens = [], queueKey;

  async function openRow(row) {
    const revision = getWorkspaceRevision();
    const visited = new Set();
    let target = row;
    const rows = getRows();
    while (target.isSubagent && target.canOpen === false) {
      visited.add(target.key);
      target = rows.find(r => r.key === target.parentKey && r.provider === row.provider);
      if (!target || visited.has(target.key)) return vscode.window.showInformationMessage(t('The parent chat of this subtask is not in the current folder.'));
    }
    const stamp = row.replyAt;
    const errorStamp = row.status === 'error' ? row.updatedAt : undefined;
    getBridge()?.deferSession(target.key);
    const exact = await openSession(vscode, target);
    if (!exact || !isAlive() || revision !== getWorkspaceRevision()) return;
    alerts.clearSessionNotifications([row.key, target.key]);
    recentOpens = [target.key, ...recentOpens.filter(key => key !== target.key)].slice(0, 8);
    const latestRows = getRows();
    if (target.key === row.key) {
      const current = latestRows.find(r => r.key === row.key);
      if (current) {
        await receipts.mark(current, stamp);
        if (errorStamp) await receipts.ackError(current, errorStamp);
      }
    } else if (errorStamp) {
      const current = latestRows.find(r => r.key === row.key);
      if (current) await receipts.ackError(current, errorStamp);
    }
  }

  async function reviewRow(row) {
    if (row.action && await panel.revealRequest(row.key)) {
      alerts.clearSessionNotifications([row.key]);
      return;
    }
    return openRow(row);
  }

  // Focuses an already-open VS Code window containing `cwd`, or opens the folder cleanly.
  async function openFolder(cwd) {
    try {
      if (!(await fs.promises.stat(cwd)).isDirectory()) throw new Error('Not a directory');
      if (typeof findWindowForFolder === 'function' && vscode.env?.openExternal && vscode.Uri?.parse) {
        const existing = await findWindowForFolder(directory, cwd).catch(() => undefined);
        // Only an editor's own app link is handed to the system, never another scheme.
        const windowUri = editorWindowUri(existing?.windowUri);
        if (windowUri) {
          const opened = await vscode.env.openExternal(vscode.Uri.parse(windowUri)).catch(() => false);
          if (opened) return;
        }
      }
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(cwd), { forceNewWindow: true });
    } catch {
      void settle(vscode.window.showWarningMessage(t('Could not open the folder. Check that it still exists at that path.')));
    }
  }

  // Opens a file referenced by a session only when its resolved path stays inside this workspace.
  async function openSessionFile(row, file) {
    try {
      if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('Invalid path');
      const remembered = getBridge()?.resolveFilePath?.(row.key, file);
      const base = typeof row.cwd === 'string' && path.isAbsolute(row.cwd) ? row.cwd : workspaceRootFor('');
      const candidate = remembered || (path.isAbsolute(file) ? path.resolve(file) : (base ? path.resolve(base, file) : ''));
      if (!candidate) throw new Error('No workspace root');
      const real = await fs.promises.realpath(candidate);
      const stat = await fs.promises.stat(real);
      if (!stat.isFile() || !getActiveScope()?.containsExistingFolder(path.dirname(real))) throw new Error('Out of scope');
      const uri = vscode.Uri.file(real);
      const isImage = /\.(?:png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(real);
      if (!isImage && typeof vscode.window.showTextDocument === 'function') await vscode.window.showTextDocument(uri, { preview: true });
      else await vscode.commands.executeCommand('vscode.open', uri);
    } catch {
      void settle(vscode.window.showWarningMessage(t('Could not open the file. It may have moved or be outside the workspace folder.')));
    }
  }

  async function markAllSeen() {
    const unread = getRows().filter(row => receipts.unread(row));
    alerts.clearSessionNotifications(unread.map(row => row.key));
    await Promise.all(unread.map(row => receipts.mark(row, row.replyAt)));
    return unread.length;
  }

  async function nextAttention() {
    await refresh();
    const queue = projectRows().filter(row => triageRank(row) < 4).sort(compareTriage);
    if (!queue.length) return vscode.window.showInformationMessage(t('You have seen every request and new reply in this folder.'));
    const next = queue[(queue.findIndex(row => row.key === queueKey) + 1) % queue.length];
    queueKey = next.key;
    return reviewRow(next);
  }

  async function handleNotificationUri(uri) {
    if (!isAlive() || !uri || uri.path !== '/focus') return;
    const params = new URLSearchParams(uri.query || '');
    const key = params.get('key') || '';
    const cwd = params.get('cwd') || '';
    await settle(vscode.commands.executeCommand(viewId + '.focus'));
    await refresh();
    if (key) {
      const target = projectRows().find(r => r.key === key);
      if (target) {
        alerts.clearSessionNotifications([target.key]);
        if (target.action && await panel.revealRequest(target.key)) return;
        await panel.revealSession?.(target.key, { queue: true });
        return;
      }
    }
    // The session is not listed here: the link was meant for another window, which may have
    // closed since. Open its folder, but only one this monitor knows a session in.
    if (await notifiedFolder(cwd)) await openFolder(path.resolve(cwd));
  }

  function inThisWindow(folder) {
    const roots = (vscode.workspace?.workspaceFolders || [])
      .filter(item => item?.uri?.scheme === 'file' && typeof item.uri.fsPath === 'string')
      .map(item => path.resolve(item.uri.fsPath));
    return roots.some(root => isUnderDir(folder, root));
  }

  async function notifiedFolder(cwd) {
    if (!validFolder(cwd)) return false;
    const folder = path.resolve(cwd);
    if (tooBroad(folder) || inThisWindow(folder)) return false;
    const elsewhere = typeof otherFolders === 'function' && otherFolders() && typeof getElsewhere === 'function' ? getElsewhere() : [];
    if ((elsewhere || []).some(item => validFolder(item?.cwd) && related(folder, path.resolve(item.cwd)))) return true;
    // A finished or failed turn, or a session in a subfolder, is not among other folders'
    // waiting requests; its snapshot still names where it ran.
    if (!directory) return false;
    try {
      const sessions = await readSessions(directory);
      return sessions.some(row => validFolder(row.cwd) && related(folder, path.resolve(row.cwd)));
    } catch { return false; }
  }

  async function act({ action, key, provider, token, answers, value, direction, replyAt, updatedAt, cwd, file }) {
    if (action === 'refresh') { await Promise.all([connections?.refreshConnections?.({ force: true }), refresh(true)]); return; }
    if (action === 'newSession') return vscode.commands.executeCommand(prefix + 'newSession');
    if (action === 'setSort' && ['priority','recent','attention','manual'].includes(value)) {
      setPreferences({ ...getPreferences(), sort: value });
      return saveLayout();
    }
    if ((action === 'setHideCompleted' || action === 'setAttentionOnly') && typeof value === 'boolean') {
      setPreferences({ ...getPreferences(), [action === 'setHideCompleted' ? 'hideCompleted' : 'attentionOnly']: value });
      return saveLayout();
    }
    if (action === 'markAllSeen') { await markAllSeen(); return; }
    if (action === 'openFolder') {
      if (typeof cwd === 'string' && otherFolders() && getElsewhere().some(item => item.cwd === cwd)) return openFolder(cwd);
      return;
    }
    if (!Object.hasOwn(PROVIDERS, provider)) return;
    if (action === 'moveProvider' && ['up','down'].includes(direction)) {
      const order = [...getShownProviderOrder()], current = order.indexOf(provider);
      const next = current + (direction === 'up' ? -1 : 1);
      if (current < 0 || next < 0 || next >= order.length) return;
      [order[current], order[next]] = [order[next], order[current]];
      setPreferences({ ...getPreferences(), sort: 'manual', providerOrder: order });
      return saveLayout();
    }
    if (action === 'connect') return connections.configure('install', provider);
    if (action === 'trustGuide') return connections?.showTrustGuide?.(provider);
    if (action === 'hideConnect') return connections.muteConnect(provider);
    if (action === 'start') return startSession(vscode, provider);
    if (action === 'refreshQuota') return updateQuotas(provider, true);
    if (action === 'usage') return openUsage(vscode, provider);
    const rows = getRows();
    const row = rows.find(r => r.key === key && r.provider === provider);
    if (!row) return;
    if (action === 'setPinned' && !row.isSubagent && typeof value === 'boolean') {
      if (value) pins.add(key); else pins.delete(key);
      return saveLayout();
    }
    if (action === 'markSeen') { alerts.clearSessionNotifications([key]); return receipts.mark(row, replyAt); }
    if (action === 'ackError') { alerts.clearSessionNotifications([key]); return receipts.ackError(row, updatedAt); }
    if (action === 'openFile') return openSessionFile(row, file);
    if (action === 'open' || action === 'review') return openRow(row);
    const bridge = getBridge();
    if (action === 'rename') {
      const alias = await vscode.window.showInputBox({ title: t('Session display name'), value: getAlias(key) || getTitle(row),
        prompt: t("Leave it empty to use the agent's session title.") });
      if (alias !== undefined) { await context.globalState.update('alias:' + key, cleanLabel(alias) || undefined); render(); }
    } else if (action === 'dismiss' && !bridge?.forSession(key)) {
      const current = annotateLifecycle(rows, Date.now());
      const markedRow = current.find(r => r.key === key && r.provider === provider);
      if (!markedRow || (ACTIVE.has(markedRow.status) && !markedRow.quiet)) return;
      const dismissal = dismissalFor(current, key);
      if (!dismissal) return vscode.window.showInformationMessage(t('This session has subtasks that are still running or need attention.'));
      // The hidden family leaves the list now; what it was doing goes with it, and a later turn starts afresh.
      const hidden = new Set([key]);
      for (let grew = true; grew;) {
        grew = false;
        for (const other of rows) if (other.isSubagent && hidden.has(other.parentKey) && !hidden.has(other.key)) { hidden.add(other.key); grew = true; }
      }
      alerts.clearSessionNotifications(hidden);
      await context.globalState.update('dismiss:' + key, dismissal.cutoff);
      bridge?.forgetActivity(hidden);
      await refresh();
    } else if (action === 'dismissChildren') {
      const current = annotateLifecycle(rows, Date.now());
      const targets = dismissableChildren(current, key);
      if (!targets.length) return;
      const hidden = new Set();
      for (const target of targets) {
        await context.globalState.update('dismiss:' + target.key, target.cutoff);
        for (const h of target.hiddenKeys) hidden.add(h);
      }
      alerts.clearSessionNotifications(hidden);
      bridge?.forgetActivity(hidden);
      await refresh();
    } else if (!row.isSubagent && ['approve', 'deny', 'answer', 'defer'].includes(action)) {
      if (!vscode.window.state.focused || !panel.canHandleRequests() || !bridge?.decide(key, token, {action, answers})) {
        void settle(vscode.window.showInformationMessage(t('Check the current state of this request in its original chat.'))); return;
      }
      alerts.clearSessionNotifications([key]);
      if (action === 'defer') await openRow(row);
    }
  }

  function registerCommands() {
    const command = (name, callback) => context.subscriptions.push(vscode.commands.registerCommand(prefix + name, callback));
    command('refresh', () => refresh(true));
    command('nextAttention', nextAttention);
    command('previousSession', async () => {
      const rows = getRows();
      const row = recentOpens.slice(1).map(key => rows.find(r => r.key === key)).find(Boolean);
      if (row) return openRow(row);
      return vscode.window.showInformationMessage(t('Open two chats from this list, then you can go back to the previous one.'));
    });
    command('switchSession', async () => {
      await refresh();
      const candidates = arrangeSessions(projectRows(), { ...getPreferences(), hideCompleted: false, attentionOnly: false, pinnedKeys: [...pins] }).sessions;
      if (!candidates.length) return vscode.window.showInformationMessage(t('No sessions to open in the current folder.'));
      const choice = await vscode.window.showQuickPick(candidates.map(row => ({
        label: row.title, description: PROVIDERS[row.provider] + ' · ' + (row.replyUnread ? t('New reply') : row.quiet ? t('No signal') :
          row.status === 'error' ? errorLabel(row.errorReason) : t(STATES[row.status].label)),
        detail: [row.isSubagent && t('Subagent'), modelName(row.execution?.model, row.execution, row.provider), row.execution?.effort, path.basename(row.cwd)].filter(Boolean).join(' · '),
        key: row.key, provider: row.provider,
      })), { title: t('Switch Session in Current Folder'), placeHolder: t('Search by title, agent, model, effort, or status'), matchOnDescription: true, matchOnDetail: true });
      if (choice) return act({ action: 'open', key: choice.key, provider: choice.provider });
    });
    command('markAllSeen', async () => {
      if (!await markAllSeen()) return vscode.window.showInformationMessage(t('No unread replies in the current folder.'));
    });
    // The view presses the button of the request it shows, or refuses; either way nothing is said here.
    command('allowOpenRequest', () => panel.decideOpen('approve'));
    command('denyOpenRequest', () => panel.decideOpen('deny'));
    // The view's title bar is its only toolbar, so starting a session and arranging the list are commands too.
    command('newSession', async provider => {
      if (Object.hasOwn(PROVIDERS, provider)) return startSession(vscode, provider);
      const installed = id => Boolean(vscode.extensions.getExtension(VENDORS[id]));
      const ids = Object.keys(PROVIDERS);
      const items = [...ids.filter(installed), ...ids.filter(id => !installed(id))]
        .map(id => ({ id, label: PROVIDERS[id], ...(!installed(id) && { description: t('Extension not installed') }) }));
      const choice = await vscode.window.showQuickPick(items, { title: t('Start New Session') });
      if (Object.hasOwn(PROVIDERS, choice?.id ?? '')) return startSession(vscode, choice.id);
    });
    // The panel's own messages change the arrangement, so it is saved and drawn in one place.
    command('arrange', async () => {
      const preferences = getPreferences();
      const mark = (active, label) => (active ? '$(check) ' : '') + label;
      const sorts = [['priority', t('All · By priority')], ['recent', t('By agent · Most recent')], ['attention', t('By agent · Attention first')],
        ['manual', t('By agent · Arrange manually')]];
      const choice = await vscode.window.showQuickPick([
        ...sorts.map(([value, label]) => ({ label: mark(preferences.sort === value, label), action: 'setSort', value })),
        { label: '', kind: vscode.QuickPickItemKind?.Separator ?? -1 },
        { label: mark(preferences.attentionOnly, t('Only sessions that need attention')), action: 'setAttentionOnly', field: 'attentionOnly' },
        { label: mark(preferences.hideCompleted, t('Hide finished')), action: 'setHideCompleted', field: 'hideCompleted' },
      ], { title: t('Sort & Filter') });
      if (!choice?.action) return;
      // A toggle flips what is set when it is chosen, even if the panel changed it meanwhile.
      return act({ action: choice.action, value: choice.field ? !getPreferences()[choice.field] : choice.value });
    });
    command('testNotification', () => alerts.sendTestNotification());
    command('connect', () => connections.configure('install'));
    command('disconnect', () => connections.configure('remove'));
    for (const name of ['open', 'rename', 'dismiss']) command(name, row => row && act({ action: name, key: row.key, provider: row.provider }));
  }

  function resetWorkspace() {
    recentOpens = [];
    queueKey = undefined;
  }

  return {
    reviewRow,
    openFolder,
    handleNotificationUri,
    act,
    registerCommands,
    resetWorkspace,
  };
}

module.exports = { createActions };
